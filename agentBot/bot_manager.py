import logging
import math
import threading
import time
from typing import Any, Dict, Optional

from agentBot.base_bot import BaseTradingBot
from agentBot.bollinger_reversal_bot import BollingerReversalBot
from agentBot.dual_momentum_bot import DualMomentumBot
from agentBot.volatility_breakout_bot import VolatilityBreakoutBot
from backend.common.database import db_manager
from backend.common.upbit_client import upbit_client

logger = logging.getLogger("autoCoinTrade.bot_manager")


class BotOrchestrator:
    """
    agentBot 패키지 내 3종 봇의 백그라운드 스케줄링 및 수동 제어 매니저
    - 개별 봇 장애 격리(Fault Isolation): 특정 봇에서 에러가 발생해도 다른 봇이나 전체 서버에 영향을 주지 않음
    - 잔고 0 이하 시 전체 봇 자동 중지(check_and_halt_if_zero_balance) 상시 감시
    """

    def __init__(self):
        self.bots: Dict[str, BaseTradingBot] = {
            "bot_volatility": VolatilityBreakoutBot(),
            "bot_dual_momentum": DualMomentumBot(),
            "bot_bollinger_reversal": BollingerReversalBot(),
        }
        self._stop_event = threading.Event()
        self._worker_thread: Optional[threading.Thread] = None
        self._cycle_interval_sec = 8.0

    def start_background_worker(self) -> None:
        if self._worker_thread and self._worker_thread.is_alive():
            return
        self._stop_event.clear()
        self._worker_thread = threading.Thread(
            target=self._run_loop,
            name="AgentBotOrchestratorThread",
            daemon=True,
        )
        self._worker_thread.start()
        logger.info("AgentBot background worker started.")

    def stop_background_worker(self) -> None:
        self._stop_event.set()
        if self._worker_thread and self._worker_thread.is_alive():
            self._worker_thread.join(timeout=3.0)
        logger.info("AgentBot background worker stopped.")

    def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                # 1) 잔고 0 이하 여부 확인 및 자동 전체 중지
                halt_state = db_manager.check_and_halt_if_zero_balance()
                if not halt_state.get("halted"):
                    # 2) 실행 상태(is_running == 1)인 봇들에 대해 독립적으로 전략 사이클 수행
                    for bot_id, bot_instance in self.bots.items():
                        if self._stop_event.is_set():
                            break
                        bot_row = db_manager.get_bot(bot_id)
                        if bot_row and int(bot_row.get("is_running", 0)) == 1:
                            try:
                                bot_instance.execute_strategy_step()
                            except Exception as bot_exc:
                                logger.error("Error in bot %s strategy step: %s", bot_id, bot_exc)
                                db_manager.update_bot_status_message(
                                    bot_id, f"일시적 오류 복구 대기: {type(bot_exc).__name__}"
                                )
            except Exception as loop_exc:
                logger.error("Error in orchestrator loop: %s", loop_exc)

            self._stop_event.wait(self._cycle_interval_sec)

    def execute_manual_test_trade(
        self, bot_id: str, action: str = "buy", market: str = "KRW-BTC"
    ) -> Dict[str, Any]:
        """
        사용자가 UI 또는 테스트에서 특정 봇의 즉시 매수 / 본인 지분 분할 매도를 검증할 수 있는 함수
        """
        bot = self.bots.get(bot_id)
        if not bot:
            return {"success": False, "message": f"존재하지 않는 봇입니다: {bot_id}"}

        bot_state = db_manager.get_bot(bot_id)
        if not bot_state:
            return {"success": False, "message": "봇 상태를 불러올 수 없습니다."}

        if action == "buy":
            halt_check = db_manager.check_and_halt_if_zero_balance()
            if halt_check["halted"]:
                return {"success": False, "message": halt_check["reason"]}
            available_krw = max(int(bot_state.get("virtual_krw", 0)), int(bot_state.get("allocated_capital", 0)))
            if available_krw < 5000:
                return {
                    "success": False,
                    "message": f"[{bot_state['nickname'] or bot_state['name']}] 최소 주문 금액(5,000원) 이상의 가용 잔고(현재 {available_krw:,}원)가 부족합니다.",
                }
            order_krw = min(math.floor(available_krw * 0.25), 500000)
            if order_krw < 5000:
                order_krw = 5000
            price = 98500000
            volume = f"{order_krw / price:.8f}"
            return {
                "success": True,
                "message": f"[{bot_state['nickname'] or bot_state['name']}] {market} 매수 테스트 완료 (테스트 주문 가능 금액: {order_krw:,}원, 예상 수량: {volume} / 테스트 이력은 저장되지 않습니다)",
            }

        if action == "sell":
            open_positions = bot_state.get("open_positions", [])
            if not open_positions:
                return {"success": False, "message": f"[{bot_state['nickname'] or bot_state['name']}] 현재 보유 중인 미매도 포지션이 없습니다."}
            target_pos = open_positions[0]
            return {
                "success": True,
                "message": (
                    f"[{bot_state['nickname'] or bot_state['name']}] 보유 포지션({target_pos['market']}, 수량 {target_pos['volume']}) 확인 완료 "
                    f"(실제 매도가 아니므로 매도 완료로 기록하지 않습니다)"
                ),
            }

        return {"success": False, "message": f"지원하지 않는 액션입니다: {action}"}


bot_orchestrator = BotOrchestrator()

