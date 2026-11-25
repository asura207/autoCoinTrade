# [Antigravity-Doc] ============================================================
# [Antigravity-Doc] 파일 역할: Python 10대 트레이딩 봇 및 듀얼 AI 필터 워커의 생명주기를 총괄하는 멀티프로세싱 슈퍼바이저
# [Antigravity-Doc] 아키텍처 위치: Python 독립 실행 모드의 최상위 진입점 (DB 초기화 -> 시세 허브 웜업 -> 워커 스폰 -> 3초 헬스체크/자동 재기동 -> Graceful Shutdown)
# [Antigravity-Doc] 주요 의존성: bots.py(봇 러너 및 가드레일), llm_filter_worker.py(AI 필터 워커), init_db.py(DB 초기화/조회), market_hub.py(티커 웜업)
# [Antigravity-Doc] 수정 시 주의사항: Node.js 백엔드(LIVE_EXECUTOR_OWNER=node)와 동시 실행 시 중복 주문 방지를 위한 가드레일 검사 및 PID 파일/리스 락 정리 순서를 깨뜨리지 말 것
# [Antigravity-Doc] ============================================================
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
    acquire_live_executor_lease,
    get_live_executor_owner,
    is_backend_running,
    is_dry_run,
    is_python_live_executor_authorized,
    normalize_bot_id,
    release_live_executor_lease,
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

# [Antigravity-Doc] BOT_CONFIGS: 봇 ID(표준 bot_01~bot_10, AI 필터 bot_llm_filter, 레거시 별칭)와 실행 함수 매핑 레지스트리
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


# [Antigravity-Doc] 클래스 역할: multiprocessing.Event와 동일한 인터페이스(is_set, set, wait)를 Pipe 기반으로 구현한 프로세스 간 종료 신호 객체
# [Antigravity-Doc] 설계 의도: Windows 비관리자 권한 등에서 SemLock 생성 실패(WinError 5)를 회피하면서도 자식 워커에 안전하게 종료 신호 전파
class UniversalStopEvent:
    """
    Windows SemLock(WinError 5) 권한 제약 및 표준 환경 모두를 지원하는 범용 프로세스 종료 제어 이벤트
    - 표준 multiprocessing.Event 지원
    - SemLock 접근 거부 환경(예: LibreOffice Python / 비관리자 권한)에서는 Pipe 기반으로 자동 폴백
    """

    # [Antigravity-Doc] 부모 송신 파이프(parent_pipe) 또는 자식 수신 파이프(child_pipe) 중 하나를 바인딩하여 초기화
    def __init__(self, parent_pipe=None, child_pipe=None):
        self._parent = parent_pipe
        self._child = child_pipe
        self._flag = False

    # [Antigravity-Doc] 종료 신호 수신 여부를 논블로킹으로 확인 (내부 플래그 또는 child_pipe.poll() 검사)
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

    # [Antigravity-Doc] 종료 플래그를 True로 설정하고 부모 파이프로 1바이트 신호 전송
    def set(self) -> None:
        self._flag = True
        if self._parent is not None:
            try:
                self._parent.send(1)
            except Exception:
                pass

    # [Antigravity-Doc] 지정 timeout(초) 동안 최대 0.2초 간격으로 종료 신호를 폴링 대기 (신호 수신 시 즉시 True 반환)
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


# [Antigravity-Doc] 클래스 역할: 슈퍼바이저가 모든 자식 워커 프로세스의 UniversalStopEvent를 일괄 생성·보관하고 한 번에 종료 신호를 브로드캐스트하는 컨트롤러
class SupervisorStopController:
    """슈퍼바이저가 각 워커들에게 동시에 종료 시그널을 전달하는 통합 컨트롤러"""

    def __init__(self):
        self._parent_events = []
        self._is_stopped = False

    # [Antigravity-Doc] 워커 1개당 Pipe 쌍을 생성해 송신측은 컨트롤러에 보관하고, 수신측 UniversalStopEvent를 워커용으로 반환
    def create_child_event(self) -> UniversalStopEvent:
        parent_conn, child_conn = multiprocessing.Pipe()
        parent_evt = UniversalStopEvent(parent_pipe=parent_conn)
        child_evt = UniversalStopEvent(child_pipe=child_conn)
        self._parent_events.append(parent_evt)
        return child_evt

    # [Antigravity-Doc] 슈퍼바이저 전체 종료 플래그 반환
    def is_set(self) -> bool:
        return self._is_stopped

    # [Antigravity-Doc] 전체 종료 플래그 설정 후 등록된 모든 자식 워커 파이프에 종료 신호 일괄 발송
    def set(self) -> None:
        self._is_stopped = True
        for evt in self._parent_events:
            evt.set()

    # [Antigravity-Doc] 슈퍼바이저 메인 루프가 헬스체크 주기(예: 3초) 동안 종료 신호를 감시하며 대기
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


# [Antigravity-Doc] 역할: 개별 봇/필터 워커를 비데몬(daemon=False) 독립 OS 프로세스로 생성·기동
# [Antigravity-Doc] 입력: bot_id(str), target_func(Callable), controller(SupervisorStopController) | 반환: 시작된 multiprocessing.Process
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


# [Antigravity-Doc] 역할: 멀티프로세싱 시작 방식을 'spawn'으로 통일하고, Windows 특수 환경에서 파이썬 실행 파일 경로를 보정
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


# [Antigravity-Doc] 역할: 오케스트레이터 중복 기동 방지용 PID 파일(logs/.orchestrator.pid) 경로 반환 및 디렉터리 자동 생성
def _get_orchestrator_pid_path() -> str:
    base_dir = os.path.dirname(os.path.abspath(__file__))
    logs_dir = os.path.join(base_dir, "logs")
    os.makedirs(logs_dir, exist_ok=True)
    return os.path.join(logs_dir, ".orchestrator.pid")


# [Antigravity-Doc] 역할: os.kill(pid, 0) 시그널 체크로 지정 PID 프로세스가 현재 살아있는지 판별 (자기 자신 제외)
def _is_pid_alive(pid: int) -> bool:
    if pid <= 0 or pid == os.getpid():
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


# [Antigravity-Doc] 역할: 슈퍼바이저 메인 진입점 — 중복 기동 검사 -> DB/시세 초기화 -> 실전 권한/리스 확인 -> 워커 스폰 -> 3초 주기 헬스체크/자동 재기동 -> Graceful Shutdown
def main():
    logger.info("=========================================================")
    logger.info("  Upbit Multi-Processing Auto Trading & LLM Filter System")
    logger.info("=========================================================")

    # [Antigravity-Doc] 1단계: 멀티프로세싱 spawn 설정 및 PID 파일 검사로 동일 호스트 내 오케스트레이터 이중 실행 차단
    # 1. 멀티프로세싱 환경 설정 및 중복 오케스트레이터 방지
    configure_multiprocessing_environment()

    pid_file_path = _get_orchestrator_pid_path()
    if os.path.isfile(pid_file_path):
        try:
            with open(pid_file_path, "r", encoding="utf-8") as f:
                existing_pid = int((f.read() or "0").strip())
            if _is_pid_alive(existing_pid):
                logger.warning(
                    "Another orchestrator instance is already running (PID: %d). Exiting to prevent duplicate workers.",
                    existing_pid,
                )
                return
        except Exception:
            pass
    try:
        with open(pid_file_path, "w", encoding="utf-8") as f:
            f.write(str(os.getpid()))
    except Exception as pid_err:
        logger.warning("Could not write orchestrator PID file: %s", pid_err)

    # [Antigravity-Doc] 2단계: DB 스키마·마이그레이션·기본 시드 초기화 (SQLite WAL 또는 PostgreSQL)
    # 2. SQLite 데이터베이스 및 스키마, 기본 시드 초기화
    logger.info("[Step 1/4] Initializing SQLite database schema & ledger...")
    init_database()

    # [Antigravity-Doc] 3단계: 워커 기동 전 KRW 마켓 티커 목록을 사전 캐싱하여 초기 API 버스트 완화
    # 3. 중앙 시세 허브 캐시 웜업
    logger.info("[Step 2/4] Initializing Market Data Hub cache...")
    try:
        initial_tickers = get_cached_tickers()
        logger.info("Market Data Hub initialized with %d KRW tickers.", len(initial_tickers))
    except Exception as hub_err:
        logger.warning("Market Data Hub initial ticker fetch error: %s", hub_err)

    # [Antigravity-Doc] 4단계: 단일 실전 실행 주체(LIVE_EXECUTOR_OWNER) 검증, Python 실전 리스 락 선점, Node.js 백엔드 공존(Coordinated Mode) 감지
    # Node.js 백엔드 구동 감지 및 단일 실전 실행 주체(LIVE_EXECUTOR_OWNER) 검증
    live_owner = get_live_executor_owner()
    logger.info("[Guardrail] LIVE_EXECUTOR_OWNER=%s (DRY_RUN=%s)", live_owner, is_dry_run())
    if not is_dry_run() and not is_python_live_executor_authorized():
        logger.warning(
            "[Guardrail][Single Live Executor] LIVE_EXECUTOR_OWNER='%s' != 'python'. "
            "Python trading workers are HARD-BLOCKED from calling Upbit POST /v1/orders; only non-order workers remain active.",
            live_owner,
        )
    elif not is_dry_run():
        lease_ok, lease_msg = acquire_live_executor_lease()
        if not lease_ok:
            logger.warning("[Guardrail][LeaseLock] Could not acquire Python live lease: %s", lease_msg)

    backend_port = int(os.getenv("BACKEND_PORT", "8001"))
    if is_backend_running(backend_port):
        logger.info(
            "[Coordinated Execution Mode] Active Node.js backend detected on Port %d. "
            "Python workers will defer live/dry-run trading loops to backend to prevent double execution.",
            backend_port,
        )

    # [Antigravity-Doc] 5단계: SIGINT/SIGTERM 수신 시 모든 자식 워커에 종료 신호를 전파하도록 시그널 핸들러 등록
    # 4. 프로세스 간 종료 시그널 제어를 위한 컨트롤러
    stop_controller = SupervisorStopController()

    def handle_shutdown_signal(signum, frame):
        sig_name = "SIGINT" if signum == signal.SIGINT else "SIGTERM"
        logger.info("Received %s signal. Initiating graceful shutdown...", sig_name)
        stop_controller.set()

    signal.signal(signal.SIGINT, handle_shutdown_signal)
    signal.signal(signal.SIGTERM, handle_shutdown_signal)

    # [Antigravity-Doc] 6단계: 실전 선택 봇(is_selected_for_live=1)과 Graceful Drain 중인 OPEN 포지션 보유 봇의 합집합 조회 + AI 필터 워커 항상 포함
    # 5. 실행할 워커 목록 결정 (활성 실전 봇, Graceful Drain 보유 포지션 봇 및 듀얼 AI 필터 워커)
    logger.info("[Step 3/4] Determining active trading and filter workers...")
    active_bot_ids = []
    try:
        conn = get_db_connection()
        rows = conn.execute(
            """
            SELECT DISTINCT bot_id FROM (
                SELECT bot_id FROM bots WHERE is_selected_for_live = 1
                UNION
                SELECT DISTINCT bot_id FROM bot_positions WHERE status = 'OPEN'
            ) ORDER BY bot_id ASC;
            """
        ).fetchall()
        conn.close()
        active_bot_ids = [normalize_bot_id(r["bot_id"]) for r in rows if r["bot_id"]]
    except Exception as db_err:
        logger.warning("Failed to query active bots from DB: %s", db_err)

    if not active_bot_ids:
        active_bot_ids = ["bot_01", "bot_03", "bot_05"]

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

    # [Antigravity-Doc] 7단계: 3초 주기 헬스체크 루프 — 비정상 종료된 워커 감지 시 동일 bot_id로 자동 재기동(Auto-Restart)
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
    finally:
        # [Antigravity-Doc] 8단계: Graceful Shutdown — 모든 워커에 종료 신호 전달 후 최대 4초 join 대기, 미종료 시 강제 terminate, 리스 락 및 PID 파일 안전 정리
        # 6. Graceful Shutdown 처리 및 PID 파일 정리
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

        try:
            release_live_executor_lease()
        except Exception:
            pass

        try:
            if os.path.isfile(pid_file_path):
                with open(pid_file_path, "r", encoding="utf-8") as f:
                    if (f.read() or "").strip() == str(os.getpid()):
                        os.remove(pid_file_path)
        except Exception:
            pass

        logger.info("=========================================================")
        logger.info("  All worker processes terminated safely. Goodbye!")
        logger.info("=========================================================")


if __name__ == "__main__":
    main()
