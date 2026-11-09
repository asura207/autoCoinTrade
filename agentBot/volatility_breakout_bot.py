from datetime import datetime
from typing import Any, Dict, List

from agentBot.base_bot import BaseTradingBot


class VolatilityBreakoutBot(BaseTradingBot):
    """
    [Bot 1] 필터 결합형 변동성 돌파 봇 (장중 단타 / 1일 보유)
    - 매매 전략:
      1) 유동성(거래대금) 필터(min_volume_krw)를 통과한 코인만 선별 (요구사항 24)
      2) 기준 시점 인덱싱(count=8, df.iloc[-8])을 적용하여 8캔들 전 기준가 대비 상승 추세 필터 확인 (요구사항 24)
      3) 래리 윌리엄스 변동성 돌파 목표가(당일 시가 + 전일 변동폭 * k) 돌파 시 진입
      4) 1일 보유 원칙에 따라 매수일과 현재 날짜가 달라졌거나 익절/손절 도달 시
         bot_positions 테이블에 기록된 본인 bot_id의 volume만 지정하여 분할 매도 (요구사항 23)
    """

    def __init__(self, *args, **kwargs):
        super().__init__(bot_id="bot_volatility", *args, **kwargs)

    def execute_strategy_step(self) -> Dict[str, Any]:
        bot_state = self.get_bot_state()
        if not bot_state or int(bot_state.get("is_running", 0)) != 1:
            return {"bot_id": self.bot_id, "status": "SKIPPED", "reason": "봇이 실행 중이 아닙니다."}

        cfg = bot_state.get("config", {})
        k_value = float(cfg.get("k_value", 0.5))
        candle_unit = str(cfg.get("candle_unit", "days"))
        candle_count = max(int(cfg.get("candle_count", 8)), 8)
        max_positions = int(cfg.get("max_positions", 2))
        order_ratio = float(cfg.get("order_ratio_per_trade", 0.45))
        candidate_markets: List[str] = cfg.get(
            "candidate_markets", ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP", "KRW-DOGE"]
        )
        min_volume_krw = int(bot_state.get("min_volume_krw", 10_000_000_000))

        actions: List[Dict[str, Any]] = []

        # 1) 1일 보유 만기 포지션 및 손절/익절 포지션 청산 (본인 bot_id의 volume만 매도)
        today_str = datetime.now().strftime("%Y-%m-%d")
        for pos in bot_state.get("open_positions", []):
            pos_date = str(pos.get("created_at", ""))[:10]
            if pos_date and pos_date < today_str:
                sell_res = self.sell_position_isolated(position_id=int(pos["id"]))
                if sell_res.get("success"):
                    actions.append({"type": "SELL_1DAY_EXPIRY", **sell_res})

        bot_state = self.get_bot_state() or bot_state
        exit_sells = self.evaluate_common_exit_rules(bot_state)
        for s in exit_sells:
            actions.append({"type": "SELL_EXIT_RULE", **s})

        # 2) 공통 시장 체제 필터(Regime Filter): BTC 현재가가 일봉 20MA 또는 4시간 60MA 하회 시 신규 매수 전면 중단(Hold Cash)
        regime = self.check_market_regime_filter()
        if not regime.get("allow_buy", True):
            self.db.update_bot_status_message(self.bot_id, regime.get("reason", "시장 체제 필터(Hold Cash)"))
            return {"bot_id": self.bot_id, "status": "HOLD_CASH", "reason": regime.get("reason"), "actions": actions}

        # 3) 신규 진입 평가
        bot_state = self.get_bot_state() or bot_state
        open_positions = bot_state.get("open_positions", [])
        held_markets = {p["market"] for p in open_positions}
        if len(open_positions) >= max_positions:
            self.db.update_bot_status_message(
                self.bot_id, f"보유 포지션 한도({len(open_positions)}/{max_positions}) 감시 중"
            )
            return {"bot_id": self.bot_id, "status": "MONITORING", "actions": actions}

        # 유동성(거래대금) 필터 적용 (min_volume_krw)
        liquid_tickers = self.get_filtered_liquid_markets(candidate_markets, min_volume_krw=min_volume_krw)

        for ticker in liquid_tickers:
            market = ticker["market"]
            if market in held_markets:
                continue

            # 기준 시점 인덱싱 (count=8, iloc[-8])
            df = self.fetch_indexed_candles(market=market, unit=candle_unit, count=candle_count)
            if len(df) < 8:
                continue

            base_candle = self.get_base_reference_candle(df)  # df.iloc[-8]
            prev_candle = df.iloc[-2]
            curr_candle = df.iloc[-1]

            base_close = float(base_candle["trade_price"])
            prev_range = float(prev_candle["high_price"]) - float(prev_candle["low_price"])
            today_open = float(curr_candle["opening_price"])
            current_price = float(curr_candle["trade_price"])

            target_price = today_open + (prev_range * k_value)
            trend_filter_passed = current_price > base_close
            breakout_passed = current_price >= target_price

            if trend_filter_passed and breakout_passed:
                order_krw = self.calculate_safe_order_krw(bot_state, ratio=order_ratio)
                if order_krw >= 5000:
                    buy_res = self.buy_market_with_lock(market=market, order_krw=order_krw)
                    if buy_res.get("success"):
                        actions.append({"type": "BUY_BREAKOUT", **buy_res})
                        break

        status_text = (
            f"변동성 돌파 감시 완료 (실행 액션 {len(actions)}건)"
            if actions
            else f"변동성 돌파(k={k_value}) 및 추세 필터(iloc[-8]) 탐색 중"
        )
        self.db.update_bot_status_message(self.bot_id, status_text)
        return {"bot_id": self.bot_id, "status": "OK", "actions": actions}

