import logging
import math
import time
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

import pandas as pd

from backend.common.database import DatabaseManager, db_manager
from backend.common.upbit_client import UpbitOpenAPIClient, upbit_client

logger = logging.getLogger("autoCoinTrade.agentBot")


class BaseTradingBot(ABC):
    """
    모든 전략 봇의 공통 부모 클래스 (요구사항 17, 21, 22, 23, 24)
    - 공용 모듈의 Open API 통신 모듈(upbit_client)만 사용하여 시세 조회, 매수, 매도 요청
    - API Rate Limit 방어: time.sleep(0.12) 준수
    - 유동성(거래대금) 필터 적용: min_volume_krw 이상인 종목만 매매 대상 선정
    - 기준 시점 인덱싱: count=8, df.iloc[-8] 규칙 준수
    - 상호 간섭 방지 규칙:
      1) get_balance 전량 조회 직접 매도 금지 (bot_positions의 본인 bot_id volume만 지정 분할 매도)
      2) 동일 종목 동시 진입 시 order_uuid와 진입 수량 분리 기록
      3) 주문 전 virtual_krw 가상 잔고 트랜잭션 락 체크 및 소수점 버림(math.floor)
    """

    RATE_LIMIT_DELAY = 0.12
    REQUIRED_CANDLE_COUNT = 8
    BASE_INDEX_OFFSET = -8

    def __init__(
        self,
        bot_id: str,
        api_client: UpbitOpenAPIClient = upbit_client,
        database: DatabaseManager = db_manager,
    ):
        self.bot_id = bot_id
        self.api = api_client
        self.db = database

    def sleep_rate_limit(self) -> None:
        """API Rate Limit 방어를 위한 0.12초 대기 (요구사항 24)"""
        time.sleep(self.RATE_LIMIT_DELAY)

    def get_bot_state(self) -> Optional[Dict[str, Any]]:
        return self.db.get_bot(self.bot_id)

    def get_filtered_liquid_markets(self, candidate_markets: List[str], min_volume_krw: int) -> List[Dict[str, Any]]:
        """
        유동성(거래대금) 필터 적용 (요구사항 24: min_volume_krw)
        """
        self.sleep_rate_limit()
        return self.api.filter_markets_by_volume(candidate_markets, min_volume_krw=min_volume_krw)

    def fetch_indexed_candles(self, market: str, unit: str = "days", count: int = 8) -> pd.DataFrame:
        """
        기준 시점 인덱싱 (요구사항 24: count=8, iloc[-8])을 위한 캔들 조회 헬퍼
        """
        self.sleep_rate_limit()
        effective_count = max(int(count), self.REQUIRED_CANDLE_COUNT)
        df = self.api.get_candles(market=market, unit=unit, count=effective_count)
        return df

    def get_base_reference_candle(self, df: pd.DataFrame) -> pd.Series:
        """
        기준 시점 인덱싱 규칙 (count=8, iloc[-8]) 적용
        """
        if len(df) < 8:
            raise ValueError(f"캔들 데이터 개수({len(df)})가 최소 기준(count=8)보다 적습니다.")
        return df.iloc[self.BASE_INDEX_OFFSET]

    def calculate_safe_order_krw(self, bot_state: Dict[str, Any], ratio: float = 0.45) -> int:
        """
        주문 전 가상 잔고(virtual_krw) 예산 계산 및 수수료(0.05%) 반영, 소수점 버림(math.floor) 처리 (요구사항 22, 23-3)
        """
        virtual_krw = max(int(bot_state.get("virtual_krw", 0)), int(bot_state.get("allocated_capital", 0)))
        if virtual_krw < 5000:
            return 0
        raw_budget = virtual_krw * float(ratio)
        # 수수료(0.05%) 여유분 확보 후 소수점 버림
        safe_order_krw = math.floor(raw_budget / 1.0005)
        if safe_order_krw < 5000:
            max_affordable = math.floor(virtual_krw / 1.0005)
            return 5000 if max_affordable >= 5000 else 5000
        return safe_order_krw

    def check_market_regime_filter(self) -> Dict[str, Any]:
        """
        [손실 방어 패치 1] 전체 봇 공통 시장 체제 필터 (Regime Filter):
        대장주 비트코인(KRW-BTC)의 현재가가 일봉 20일 이동평균선 또는 4시간봉 60 이동평균선 아래에 있다면
        Bot 1, 2, 3 모두 신규 매수를 전면 중단(Hold Cash)합니다.
        """
        self.sleep_rate_limit()
        return self.api.check_btc_regime_filter()

    def buy_limit_with_lock(self, market: str, order_krw: int, wait_timeout_sec: int = 40) -> Dict[str, Any]:
        """
        [손실 방어 패치 1 & 2]
        1) 시장 체제 필터(BTC 20일선 / 4시간 60이평선) 통과 여부 확인 후 하락장이면 신규 매수 전면 중단(Hold Cash)
        2) 매수 신호 발생 시 현재 매수 1호가에 최유리 지정가 주문(limit_order)을 걸고,
           30초~1분(기본 40초) 내에 체결되지 않으면 주문을 자동 취소(cancel_order)합니다.
        """
        regime = self.check_market_regime_filter()
        if not regime.get("allow_buy", True):
            reason_msg = regime.get("reason", "시장 체제 필터 발동으로 신규 매수 중단(Hold Cash)")
            self.db.update_bot_status_message(self.bot_id, reason_msg)
            return {"success": False, "hold_cash": True, "reason": reason_msg}

        floored_krw = math.floor(float(order_krw))
        return self.db.execute_buy_with_virtual_lock(
            bot_id=self.bot_id,
            market=market,
            requested_krw=floored_krw,
            order_callback=lambda mkt, krw: self.api.place_limit_buy_order(
                market=mkt, price_krw=krw, wait_timeout_sec=wait_timeout_sec
            ),
        )

    def buy_market_with_lock(self, market: str, order_krw: int) -> Dict[str, Any]:
        """
        가상 잔고 트랜잭션 락을 통과한 경우에만 최유리 지정가(1호가 + 미체결 취소) 및 체제 필터를 적용해 매수 실행
        """
        return self.buy_limit_with_lock(market=market, order_krw=order_krw, wait_timeout_sec=40)

    def sell_position_isolated(self, position_id: int) -> Dict[str, Any]:
        """
        전량 조회(get_balance) 직접 매도 금지 규칙 준수 (요구사항 23-1):
        반드시 로컬 DB의 bot_positions 테이블에서 본인 bot_id로 기록된 volume 수량만 지정하여 시장가 분할 매도합니다.
        """
        return self.db.execute_sell_by_bot_position(
            bot_id=self.bot_id,
            position_id=position_id,
            sell_callback=self.api.place_market_sell_order_by_position_volume,
        )

    def evaluate_common_exit_rules(self, bot_state: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        보유 중인 포지션(bot_positions)에 대해 손절매(stop_loss_pct) 및 익절매(take_profit_pct) 조건 검사 후
        조건 충족 시 본인 bot_id 지분 수량(volume)만 안전하게 매도합니다.
        """
        executed_sells = []
        open_positions = bot_state.get("open_positions", [])
        if not open_positions:
            return executed_sells

        stop_loss_pct = -abs(float(bot_state.get("stop_loss_pct", 3.0)))
        take_profit_pct = abs(float(bot_state.get("take_profit_pct", 5.0)))

        markets = list({p["market"] for p in open_positions})
        self.sleep_rate_limit()
        tickers = {t["market"]: float(t["trade_price"]) for t in self.api.get_tickers(markets)}

        for pos in open_positions:
            market = pos["market"]
            cur_price = tickers.get(market)
            if not cur_price:
                continue
            avg_buy_price = float(pos["avg_buy_price"])
            if avg_buy_price <= 0:
                continue

            pnl_pct = ((cur_price - avg_buy_price) / avg_buy_price) * 100.0
            if pnl_pct <= stop_loss_pct or pnl_pct >= take_profit_pct:
                res = self.sell_position_isolated(position_id=int(pos["id"]))
                if res.get("success"):
                    executed_sells.append(res)

        return executed_sells

    @abstractmethod
    def execute_strategy_step(self) -> Dict[str, Any]:
        """각 봇의 고유 매매 전략 1사이클을 수행합니다."""
        raise NotImplementedError

