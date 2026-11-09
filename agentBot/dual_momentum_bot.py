from typing import Any, Dict, List

from agentBot.base_bot import BaseTradingBot


class DualMomentumBot(BaseTradingBot):
    """
    [Bot 2] 상대 모멘텀 + 절대 모멘텀 (듀얼 모멘텀 스윙) 봇
    - 매매 전략:
      1) 유동성(거래대금) 필터(min_volume_krw)를 충족하는 코인만 후보군으로 필터링 (요구사항 24)
      2) 각 후보 코인에 대해 count=8 캔들을 조회하고 기준 시점 인덱싱(df.iloc[-8]) 대비 현재가의 모멘텀 수익률 계산 (요구사항 24)
      3) 절대 모멘텀 필터: 모멘텀 수익률이 설정 임계값(abs_momentum_threshold_pct) 이상인 종목만 통과
      4) 상대 모멘텀 랭킹: 절대 모멘텀을 통과한 종목 중 수익률이 가장 높은 최상위 종목에 진입
      5) 보유 종목의 절대 모멘텀이 꺾이거나 손절/익절 도달 시 bot_positions에서 본인 bot_id의 volume만 분할 매도 (요구사항 23)
    """

    def __init__(self, *args, **kwargs):
        super().__init__(bot_id="bot_dual_momentum", *args, **kwargs)

    def execute_strategy_step(self) -> Dict[str, Any]:
        bot_state = self.get_bot_state()
        if not bot_state or int(bot_state.get("is_running", 0)) != 1:
            return {"bot_id": self.bot_id, "status": "SKIPPED", "reason": "봇이 실행 중이 아닙니다."}

        cfg = bot_state.get("config", {})
        abs_threshold_pct = float(cfg.get("abs_momentum_threshold_pct", 1.2))
        candle_unit = str(cfg.get("candle_unit", "minutes/240"))
        candle_count = max(int(cfg.get("candle_count", 8)), 8)
        max_positions = int(cfg.get("max_positions", 2))
        order_ratio = float(cfg.get("order_ratio_per_trade", 0.45))
        candidate_markets: List[str] = cfg.get(
            "candidate_markets", ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-SUI", "KRW-AVAX"]
        )
        min_volume_krw = int(bot_state.get("min_volume_krw", 8_000_000_000))

        actions: List[Dict[str, Any]] = []

        # 1) 공통 손절/익절 평가
        exit_sells = self.evaluate_common_exit_rules(bot_state)
        for s in exit_sells:
            actions.append({"type": "SELL_EXIT_RULE", **s})

        # 2) 유동성 필터 통과 종목들의 듀얼 모멘텀 스코어 계산 (count=8, iloc[-8])
        liquid_tickers = self.get_filtered_liquid_markets(candidate_markets, min_volume_krw=min_volume_krw)
        momentum_scores: List[Dict[str, Any]] = []

        for ticker in liquid_tickers:
            market = ticker["market"]
            df = self.fetch_indexed_candles(market=market, unit=candle_unit, count=candle_count)
            if len(df) < 8:
                continue

            base_candle = self.get_base_reference_candle(df)  # df.iloc[-8]
            base_price = float(base_candle["trade_price"])
            current_price = float(df.iloc[-1]["trade_price"])
            if base_price <= 0:
                continue

            momentum_pct = ((current_price - base_price) / base_price) * 100.0
            momentum_scores.append(
                {
                    "market": market,
                    "momentum_pct": round(momentum_pct, 3),
                    "current_price": current_price,
                    "base_price": base_price,
                }
            )

        # 상대 모멘텀 순위 정렬 (내림차순)
        momentum_scores.sort(key=lambda x: x["momentum_pct"], reverse=True)
        score_map = {m["market"]: m["momentum_pct"] for m in momentum_scores}

        # 3) 보유 중인 포지션의 절대 모멘텀 이탈 시 청산 (본인 bot_id의 volume만 매도)
        bot_state = self.get_bot_state() or bot_state
        for pos in bot_state.get("open_positions", []):
            m_score = score_map.get(pos["market"])
            if m_score is not None and m_score < 0.0:
                sell_res = self.sell_position_isolated(position_id=int(pos["id"]))
                if sell_res.get("success"):
                    actions.append({"type": "SELL_MOMENTUM_DECAY", **sell_res})

        # 4) 공통 시장 체제 필터(Regime Filter): BTC 현재가가 일봉 20MA 또는 4시간 60MA 하회 시 신규 매수 전면 중단(Hold Cash)
        regime = self.check_market_regime_filter()
        if not regime.get("allow_buy", True):
            self.db.update_bot_status_message(self.bot_id, regime.get("reason", "시장 체제 필터(Hold Cash)"))
            return {
                "bot_id": self.bot_id,
                "status": "HOLD_CASH",
                "reason": regime.get("reason"),
                "rankings": momentum_scores,
                "actions": actions,
            }

        # 5) 절대 모멘텀 + 상대 모멘텀 1위 종목 신규 진입
        bot_state = self.get_bot_state() or bot_state
        open_positions = bot_state.get("open_positions", [])
        held_markets = {p["market"] for p in open_positions}

        if len(open_positions) < max_positions and momentum_scores:
            for candidate in momentum_scores:
                if candidate["market"] in held_markets:
                    continue
                # 절대 모멘텀 조건 충족 여부 확인
                if candidate["momentum_pct"] >= abs_threshold_pct:
                    order_krw = self.calculate_safe_order_krw(bot_state, ratio=order_ratio)
                    if order_krw >= 5000:
                        buy_res = self.buy_market_with_lock(
                            market=candidate["market"],
                            order_krw=order_krw,
                        )
                        if buy_res.get("success"):
                            actions.append(
                                {
                                    "type": "BUY_DUAL_MOMENTUM",
                                    "momentum_pct": candidate["momentum_pct"],
                                    **buy_res,
                                }
                            )
                            break

        top_info = (
            f"1위 {momentum_scores[0]['market']}({momentum_scores[0]['momentum_pct']:+.2f}%)"
            if momentum_scores
            else "대상 탐색 중"
        )
        self.db.update_bot_status_message(self.bot_id, f"듀얼 모멘텀 스캔 완료 ({top_info})")
        return {
            "bot_id": self.bot_id,
            "status": "OK",
            "rankings": momentum_scores,
            "actions": actions,
        }

