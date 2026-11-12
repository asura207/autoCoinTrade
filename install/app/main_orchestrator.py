"""
main_orchestrator.py - 멀티프로세싱 기반 슈퍼바이저 오케스트레이터
- BOT_CONFIGS 레지스트리에 3개 퀀트 봇(bot_vb, bot_momentum, bot_bb)과 4번째 워커(bot_llm_filter) 등록
- 실행 시 init_database() 호출로 SQLite WAL 모드 및 스키마/단일행 상태 테이블 안전 초기화
- 4개 워커 프로세스 상시 헬스체크 및 크래시 시 자동 재기동(Auto-Restart)
- SIGINT(Ctrl+C) / SIGTERM 시그널 수신 시 stop_event 전파 및 Graceful Shutdown
"""

import logging
import multiprocessing
import os
import signal
import sys
import time
from typing import Dict

from dotenv import load_dotenv

from bots import run_bot_bb, run_bot_momentum, run_bot_vb
from init_db import init_database
from llm_filter_worker import run_llm_sentiment_worker

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [Supervisor] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("supervisor")

# 4개 워커 프로세스 레지스트리
BOT_CONFIGS = {
    "bot_vb": run_bot_vb,
    "bot_momentum": run_bot_momentum,
    "bot_bb": run_bot_bb,
    "bot_llm_filter": run_llm_sentiment_worker,
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
            "C:\\Program Files\\LibreOffice\\program\\python.exe",
            os.path.join(os.path.dirname(sys.executable), "python.exe"),
            os.path.join(sys.prefix, "python.exe"),
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
    logger.info("[Step 1/3] Initializing SQLite database schema & ledger...")
    init_database()

    # 3. 프로세스 간 종료 시그널 제어를 위한 컨트롤러
    stop_controller = SupervisorStopController()

    def handle_shutdown_signal(signum, frame):
        sig_name = "SIGINT" if signum == signal.SIGINT else "SIGTERM"
        logger.info("Received %s signal. Initiating graceful shutdown...", sig_name)
        stop_controller.set()

    signal.signal(signal.SIGINT, handle_shutdown_signal)
    signal.signal(signal.SIGTERM, handle_shutdown_signal)

    # 4. 4개 워커 프로세스 구동
    logger.info("[Step 2/3] Spawning 4 worker processes...")
    workers: Dict[str, multiprocessing.Process] = {}

    for bot_id, worker_func in BOT_CONFIGS.items():
        workers[bot_id] = spawn_worker_process(bot_id, worker_func, stop_controller)

    logger.info("[Step 3/3] All workers active. Entering supervisor monitoring loop.")
    logger.info("Active Bots: %s", list(BOT_CONFIGS.keys()))
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
