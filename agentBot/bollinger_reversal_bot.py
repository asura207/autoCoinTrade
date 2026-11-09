from typing import Any, Dict, List

import pandas as pd

from agentBot.base_bot import BaseTradingBot


class BollingerReversalBot(BaseTradingBot):
    """
    [Bot 3] 고변동성 코인 볼린저 밴드 역추세 (분봉 단기 반등 매매) 봇
    - 매매 전략:
      1) 유동성(거래대금) 필터(min_volume_krw)를 통과한 고변동성 코인 선별 (요구사항 24)
      2) 분봉 캔들 조회 시 기준 시점 인덱싱(count=8, df.iloc[-8])을 적용하여 단기 변동성 및 볼린저 밴드 하단 이탈 후 반등 여부 계산 (요구사항 24)
      3) 가격이 볼린저 밴드 하단선 부근에서 양봉 반등하고 과매도 조건을 만족할 때 가상 잔고(virtual_krw) 락 검증 후 분할 진입 (요구사항 23-3)
      4) 가격이 볼린저 밴드 중심선(MA) 이상으로 회복하거나 익절/손절 도달 시
         bot_positions 테이블에서 본인 bot_id의 volume만 지정하여 시장가 매도 (요구사항 23-1)
    """

    def __init__(self, *args, **kwargs):
        super().__init__(bot_id="bot_bollinger_reversal", *args, **kwargs)

    @staticmethod
    def _compute_rsi(series: pd.Series, period: int = 7) -> float:
        delta = series.diff().dropna()
        if len(delta) == 0:
            return 50.0
        up = delta.clip(lower=0.0)
        down = -delta.clip(upper=0.0)
        avg_gain = float(up.tail(period).mean())
        avg_loss = float(down.tail(period).mean())
        if avg_loss == 0:
            return 100.0
        rs = avg_gain / avg_loss
        return 100.0 - (100.0 / (1.0 + rs))

    def execute_strategy_step(self) -> Dict[str, Any]:
        bot_state = self.get_bot_state()
        if not bot_state or int(bot_state.get("is_running", 0)) != 1:
            return {"bot_id": self.bot_id, "status": "SKIPPED", "reason": "봇이 실행 중이 아닙니다."}

        cfg = bot_state.get("config", {})
        bb_std_mult = float(cfg.get("bb_std", 2.0))
        rsi_oversold = float(cfg.get("rsi_oversold", 35.0))
        candle_unit = str(cfg.get("candle_unit", "minutes/15"))
        candle_count = max(int(cfg.get("candle_count", 8)), 8)
        max_positions = int(cfg.get("max_positions", 2))
        order_ratio = float(cfg.get("order_ratio_per_trade", 0.45))
        candidate_markets: List[str] = cfg.get(
            "candidate_markets", ["KRW-SOL", "KRW-DOGE", "KRW-XRP", "KRW-SUI", "KRW-SHIB"]
        )
        min_volume_krw = int(bot_state.get("min_volume_krw", 5_000_000_000))

        actions: List[Dict[str, Any]] = []

        # 1) 공통 손절/익절 평가
        exit_sells = self.evaluate_common_exit_rules(bot_state)
        for s in exit_sells:
            actions.append({"type": "SELL_EXIT_RULE", **s})

        # 2) 보유 포지션이 볼린저 중심선 이상 반등 성공 시 익절 청산 (본인 bot_id의 volume만 매도)
        bot_state = self.get_bot_state() or bot_state
        for pos in bot_state.get("open_positions", []):
            market = pos["market"]
            df = self.fetch_indexed_candles(market=market, unit=candle_unit, count=candle_count)
            if len(df) < 8:
                continue
            window_df = df.iloc[-8:]  # count=8, iloc[-8] 기준 구간
            mid_band = float(window_df["trade_price"].mean())
            curr_price = float(df.iloc[-1]["trade_price"])
            if curr_price >= mid_band and curr_price > float(pos["avg_buy_price"]) * 1.004:
                sell_res = self.sell_position_isolated(position_id=int(pos["id"]))
                if sell_res.get("success"):
                    actions.append({"type": "SELL_BB_REBOUND_TARGET", **sell_res})

        # 3) 공통 시장 체제 필터(Regime Filter): BTC 현재가가 일봉 20MA 또는 4시간 60MA 하회 시 신규 매수 전면 중단(Hold Cash)
        regime = self.check_market_regime_filter()
        if not regime.get("allow_buy", True):
            self.db.update_bot_status_message(self.bot_id, regime.get("reason", "시장 체제 필터(Hold Cash)"))
            return {"bot_id": self.bot_id, "status": "HOLD_CASH", "reason": regime.get("reason"), "actions": actions}

        # 4) 유동성 필터 통과 고변동성 코인 대상 볼린저 밴드 하단 역추세 진입 탐색
        bot_state = self.get_bot_state() or bot_state
        open_positions = bot_state.get("open_positions", [])
        held_markets = {p["market"] for p in open_positions}

        if len(open_positions) < max_positions:
            liquid_tickers = self.get_filtered_liquid_markets(
                candidate_markets, min_volume_krw=min_volume_krw
            )
            for ticker in liquid_tickers:
                market = ticker["market"]
                if market in held_markets:
                    continue

                # 기준 시점 인덱싱 (count=8, iloc[-8])
                df = self.fetch_indexed_candles(market=market, unit=candle_unit, count=candle_count)
                if len(df) < 8:
                    continue

                base_candle = self.get_base_reference_candle(df)  # df.iloc[-8]
                window_closes = df.iloc[-8:]["trade_price"].astype(float)
                mid_band = float(window_closes.mean())
                std_val = float(window_closes.std(ddof=0))
                lower_band = mid_band - (bb_std_mult * std_val)

                curr_candle = df.iloc[-1]
                curr_low = float(curr_candle["low_price"])
                curr_close = float(curr_candle["trade_price"])
                curr_open = float(curr_candle["opening_price"])
                base_close = float(base_candle["trade_price"])
                rsi_val = self._compute_rsi(window_closes)

                # 볼린저 하단 터치 후 반등 양봉 또는 과매도 반등 시그널
                touched_lower_band = curr_low <= lower_band and curr_close >= curr_open
                oversold_rebound = rsi_val <= rsi_oversold and curr_close < base_close

                if touched_lower_band or oversold_rebound:
                    order_krw = self.calculate_safe_order_krw(bot_state, ratio=order_ratio)
                    if order_krw >= 5000:
                        buy_res = self.buy_market_with_lock(market=market, order_krw=order_krw)
                        if buy_res.get("success"):
                            actions.append(
                                {
                                    "type": "BUY_BB_REVERSAL",
                                    "rsi": round(rsi_val, 2),
                                    **buy_res,
                                }
                            )
                            break

        self.db.update_bot_status_message(
            self.bot_id,
            f"볼린저 역추세 분봉 감시 중 (count=8, iloc[-8], 실행 {len(actions)}건)",
        )
        return {"bot_id": self.bot_id, "status": "OK", "actions": actions}

