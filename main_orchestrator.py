"""
main_orchestrator.py - 멀티프로세싱 기반 슈퍼바이저 오케스트레이터
- BOT_CONFIGS 레지스트리에 10대 퀀트 봇(bot_01 ~ bot_10, bot_10 잭 켈로그 포함) 및 듀얼 AI 필터 워커(bot_llm_filter) 등록
- 중앙 시세 허브(market_hub.py) 및 SQLite WAL 표준 경로(data/auto_coin_trade.db) 연동
- Node.js 백엔드와 상호 조율(Coordinated Mode)로 실전 주문 중복 실행(Double Execution) 완전 방어
- 워커 프로세스 상시 헬스체크 및 크래시 시 자동 재기동(Auto-Restart)
- SIGINT(Ctrl+C) / SIGTERM 시그널 수신 시 stop_event 전파 및 Graceful Shutdown
"""

import logging
import multiprocessing
import os
import signal
import sys
import time
from typing import Dict, List

from dotenv import load_dotenv

from bots import (
    BOT_RUNNERS,
    is_backend_running,
    normalize_bot_id,
    run_bot_bb,
    run_bot_jack_kellogg,
    run_bot_momentum,
    run_bot_vb,
)
from init_db import DEFAULT_DB_PATH, get_db_connection, init_database
from llm_filter_worker import run_llm_sentiment_worker
from market_hub import get_cached_tickers

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [Supervisor] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("supervisor")

# 10대 알고리즘 및 AI 필터 워커 프로세스 레지스트리
BOT_CONFIGS = {
    "bot_01": run_bot_vb,
    "bot_02": run_bot_vb,
    "bot_03": run_bot_momentum,
    "bot_04": run_bot_momentum,
    "bot_05": run_bot_bb,
    "bot_06": run_bot_bb,
    "bot_07": run_bot_momentum,
    "bot_08": run_bot_vb,
    "bot_09": run_bot_momentum,
    "bot_10": run_bot_jack_kellogg,
    "bot_llm_filter": run_llm_sentiment_worker,
    # 하위 호환 별칭
    "bot_vb": run_bot_vb,
    "bot_momentum": run_bot_momentum,
    "bot_bb": run_bot_bb,
    "bot_kellogg": run_bot_jack_kellogg,
    "bot_jack_kellogg": run_bot_jack_kellogg,
}


class UniversalStopEvent:
    """
    Windows SemLock(WinError 5) 권한 제약 및 표준 환경 모두를 지원하는 범용 프로세스 종료 제어 이벤트
    - 표준 multiprocessing.Event 지원
    - SemLock 접근 거부 환경(예: LibreOffice Python / 비관리자 권한)에서는 Pipe 기반으로 자동 폴백
    """

    def __init__(self, parent_pipe=None, child_pipe=None):
        self._parent = parent_pipe
        self._child = child_pipe
        self._flag = False

    def is_set(self) -> bool:
        if self._flag:
            return True
        if self._child is not None:
            try:
                if self._child.poll():
                    self._flag = True
                    return True
            except Exception:
                pass
        return False

    def set(self) -> None:
        self._flag = True
        if self._parent is not None:
            try:
                self._parent.send(1)
            except Exception:
                pass

    def wait(self, timeout=None) -> bool:
        if self.is_set():
            return True
        if timeout is None or timeout <= 0:
            return self.is_set()
        start = time.time()
        while (time.time() - start) < timeout:
            if self.is_set():
                return True
            time.sleep(min(0.2, timeout))
        return self.is_set()


class SupervisorStopController:
    """슈퍼바이저가 각 워커들에게 동시에 종료 시그널을 전달하는 통합 컨트롤러"""

    def __init__(self):
        self._parent_events = []
        self._is_stopped = False

    def create_child_event(self) -> UniversalStopEvent:
        parent_conn, child_conn = multiprocessing.Pipe()
        parent_evt = UniversalStopEvent(parent_pipe=parent_conn)
        child_evt = UniversalStopEvent(child_pipe=child_conn)
        self._parent_events.append(parent_evt)
        return child_evt

    def is_set(self) -> bool:
        return self._is_stopped

    def set(self) -> None:
        self._is_stopped = True
        for evt in self._parent_events:
            evt.set()

    def wait(self, timeout=None) -> bool:
        if self._is_stopped:
            return True
        if timeout is None or timeout <= 0:
            return self._is_stopped
        start = time.time()
        while (time.time() - start) < timeout:
            if self._is_stopped:
                return True
            time.sleep(min(0.2, timeout))
        return self._is_stopped


def spawn_worker_process(
    bot_id: str,
    target_func,
    controller: SupervisorStopController,
) -> multiprocessing.Process:
    """
    개별 봇 또는 LLM 필터 워커를 독립된 multiprocessing.Process로 생성 및 시작합니다.
    """
    child_stop_event = controller.create_child_event()
    proc = multiprocessing.Process(
        target=target_func,
        args=(child_stop_event, bot_id),
        name=f"Process-{bot_id}",
        daemon=False,
    )
    proc.start()
    logger.info("Spawned worker [%s] (PID: %d)", bot_id, proc.pid)
    return proc


def configure_multiprocessing_environment():
    """Windows 환경 멀티프로세싱 호환성 및 실행 파일 경로 자동 보정"""
    multiprocessing.freeze_support()
    try:
        multiprocessing.set_start_method("spawn", force=True)
    except RuntimeError:
        pass

    if not sys.executable.lower().endswith(".exe"):
        candidates = [
            os.path.join(os.path.dirname(sys.executable), "python.exe"),
            os.path.join(sys.prefix, "python.exe"),
            os.path.join(sys.prefix, "Scripts", "python.exe"),
            "C:\\Program Files\\LibreOffice\\program\\python.exe",
        ]
        for cand in candidates:
            if os.path.isfile(cand):
                try:
                    multiprocessing.set_executable(cand)
                    logger.info("Configured multiprocessing executable: %s", cand)
                    break
                except Exception:
                    pass


def main():
    logger.info("=========================================================")
    logger.info("  Upbit Multi-Processing Auto Trading & LLM Filter System")
    logger.info("=========================================================")

    # 1. 멀티프로세싱 환경 설정
    configure_multiprocessing_environment()

    # 2. SQLite 데이터베이스 및 스키마, 기본 시드 초기화
    logger.info("[Step 1/4] Initializing SQLite database schema & ledger...")
    init_database()

    # 3. 중앙 시세 허브 캐시 웜업
    logger.info("[Step 2/4] Initializing Market Data Hub cache...")
    try:
        initial_tickers = get_cached_tickers()
        logger.info("Market Data Hub initialized with %d KRW tickers.", len(initial_tickers))
    except Exception as hub_err:
        logger.warning("Market Data Hub initial ticker fetch error: %s", hub_err)

    # Node.js 백엔드 구동 감지 및 조율 모드 확인
    if is_backend_running():
        logger.info(
            "[Coordinated Execution Mode] Active Node.js backend detected on Port 8001. "
            "Python workers will coordinate with backend to prevent double execution."
        )

    # 4. 프로세스 간 종료 시그널 제어를 위한 컨트롤러
    stop_controller = SupervisorStopController()

    def handle_shutdown_signal(signum, frame):
        sig_name = "SIGINT" if signum == signal.SIGINT else "SIGTERM"
        logger.info("Received %s signal. Initiating graceful shutdown...", sig_name)
        stop_controller.set()

    signal.signal(signal.SIGINT, handle_shutdown_signal)
    signal.signal(signal.SIGTERM, handle_shutdown_signal)

    # 5. 실행할 워커 목록 결정 (활성 실전 봇 및 듀얼 AI 필터 워커)
    logger.info("[Step 3/4] Determining active trading and filter workers...")
    active_bot_ids = []
    try:
        conn = get_db_connection()
        rows = conn.execute(
            "SELECT bot_id FROM bots WHERE is_selected_for_live = 1 ORDER BY bot_id ASC;"
        ).fetchall()
        conn.close()
        active_bot_ids = [r["bot_id"] for r in rows]
    except Exception as db_err:
        logger.warning("Failed to query active bots from DB: %s", db_err)

    if not active_bot_ids:
        active_bot_ids = ["bot_01", "bot_03", "bot_05", "bot_10"]
    elif "bot_10" not in active_bot_ids:
        active_bot_ids.append("bot_10")

    # AI 필터 워커 항상 포함
    workers_to_spawn = list(dict.fromkeys(active_bot_ids + ["bot_llm_filter"]))

    logger.info("[Step 4/4] Spawning %d worker processes: %s", len(workers_to_spawn), workers_to_spawn)
    workers: Dict[str, multiprocessing.Process] = {}

    for bot_id in workers_to_spawn:
        worker_func = BOT_CONFIGS.get(bot_id)
        if worker_func:
            workers[bot_id] = spawn_worker_process(bot_id, worker_func, stop_controller)
        else:
            logger.warning("No worker function mapped for bot [%s]. Skipping.", bot_id)

    logger.info("All workers active. Entering supervisor monitoring loop.")
    logger.info("Active Workers: %s", list(workers.keys()))
    logger.info("Press Ctrl+C to terminate all processes gracefully.\n")

    # 5. 슈퍼바이저 헬스체크 및 자동 재기동 루프
    try:
        while not stop_controller.is_set():
            # 3초마다 워커 상태 점검
            if stop_controller.wait(timeout=3.0):
                break

            for bot_id, proc in list(workers.items()):
                if not proc.is_alive():
                    if stop_controller.is_set():
                        break

                    exit_code = proc.exitcode
                    logger.warning(
                        "ALERT: Worker [%s] (PID %s) died unexpectedly with exitcode %s! Triggering Auto-Restart...",
                        bot_id,
                        proc.pid,
                        exit_code,
                    )
                    # 프로세스 재시작
                    worker_func = BOT_CONFIGS.get(bot_id)
                    if worker_func:
                        new_proc = spawn_worker_process(bot_id, worker_func, stop_controller)
                        workers[bot_id] = new_proc

    except (KeyboardInterrupt, SystemExit):
        logger.info("Main supervisor loop interrupted.")
        stop_controller.set()

    # 6. Graceful Shutdown 처리
    logger.info("Graceful shutdown in progress. Stopping all worker processes...")
    stop_controller.set()

    for bot_id, proc in workers.items():
        if proc.is_alive():
            logger.info("Waiting for [%s] (PID %d) to stop...", bot_id, proc.pid)
            proc.join(timeout=4.0)
            if proc.is_alive():
                logger.warning("Worker [%s] (PID %d) did not terminate in time. Forcing termination...", bot_id, proc.pid)
                proc.terminate()
                proc.join(timeout=1.0)

    logger.info("=========================================================")
    logger.info("  All worker processes terminated safely. Goodbye!")
    logger.info("=========================================================")


if __name__ == "__main__":
    main()
