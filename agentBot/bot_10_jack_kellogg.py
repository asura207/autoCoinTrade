"""
agentBot/bot_10_jack_kellogg.py - 잭 켈로그(Jack Kellogg) 프라이스 액션 & VWAP/선형회귀 모멘텀 알고리즘

4대 핵심 지표 (K.I.S.S. 원칙):
1. 거래량 가중 평균가 (VWAP, TP = (High + Low + Close) / 3) 및 이격도
2. 20봉 선형 회귀 채널 (Linear Regression Channel LRC ±2σ, OLS 최소자승법)
3. 상대 거래량 폭발 배수 (RVOL, 직전 20봉 평균 대비)
4. 3대 핵심 가격 기준선 (당일 09시 시가, 전일 종가, 전일 고가/저가)

2대 진입 셋업:
- Setup A (Breakout Long): VWAP 지지 & 전고점 돌파 (RVOL >= 1.5 가상 / 2.0 실전)
- Setup B (Dip Reversion Long & Scaling-In): LRC 하단 터치 & VWAP 과대 이격 반등 2분할 매수
"""

import datetime
import logging
import math
import os
import time
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import pyupbit

logger = logging.getLogger("bot_10_jack_kellogg")


def compute_linear_regression_channel(closes: List[float], period: int = 20) -> Optional[Dict[str, float]]:
    """
    20봉 선형 회귀 채널 (LRC ±2σ)
    최소자승법(OLS)으로 기울기 m, 절편 b, 현재 시점 중심값 ŷ_19, 잔차 표준편차 σ(±2σ) 계산
    """
    if not closes or len(closes) < period:
        return None

    y = np.array(closes[-period:], dtype=np.float64)
    n = period
    x = np.arange(n, dtype=np.float64)
    x_mean = (n - 1) / 2.0  # 9.5 for n=20
    y_mean = np.mean(y)

    x_diff = x - x_mean
    y_diff = y - y_mean
    denominator = np.sum(x_diff ** 2)  # 665.0 for n=20

    if denominator == 0:
        slope = 0.0
    else:
        slope = float(np.sum(x_diff * y) / denominator)

    intercept = float(y_mean - slope * x_mean)
    mid = float(slope * (n - 1) + intercept)  # ŷ_(n-1)

    fitted = slope * x + intercept
    residuals = y - fitted
    variance = float(np.mean(residuals ** 2))
    sigma = math.sqrt(max(0.0, variance))

    upper = mid + 2.0 * sigma
    lower = mid - 2.0 * sigma

    return {
        "slope": slope,
        "intercept": intercept,
        "mid": mid,
        "upper": upper,
        "lower": lower,
        "sigma": sigma,
    }


def compute_vwap(df_15m: pd.DataFrame, current_price: float = 0.0) -> Tuple[float, float]:
    """
    당일 09:00 KST 이후 (또는 최근 24시간 롤링 96개 봉) VWAP 및 이격도 계산
    TP = (High + Low + Close) / 3
    VWAP = Σ(TP * Volume) / Σ(Volume)
    """
    if df_15m is None or df_15m.empty:
        return current_price, 0.0

    df = df_15m.copy()
    high = df["high"].astype(float)
    low = df["low"].astype(float)
    close = df["close"].astype(float)
    vol = df["volume"].astype(float)

    tp = (high + low + close) / 3.0
    tp_vol = tp * vol

    # 당일 09:00 KST 기준 필터링
    now_kst = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9)))
    if now_kst.hour < 9:
        today_start_date = (now_kst - datetime.timedelta(days=1)).date()
    else:
        today_start_date = now_kst.date()

    day_start_ts = pd.Timestamp(
        year=today_start_date.year,
        month=today_start_date.month,
        day=today_start_date.day,
        hour=9,
        minute=0,
        second=0,
    )
    idx_tz = getattr(df.index, "tz", None)
    if idx_tz is not None:
        kst_tz = datetime.timezone(datetime.timedelta(hours=9))
        day_start_ts = day_start_ts.tz_localize(kst_tz).tz_convert(idx_tz)

    day_mask = df.index >= day_start_ts
    day_vol_sum = vol[day_mask].sum()
    day_tp_vol_sum = tp_vol[day_mask].sum()

    if day_vol_sum > 0 and day_tp_vol_sum > 0 and day_mask.sum() >= 4:
        vwap = float(day_tp_vol_sum / day_vol_sum)
    else:
        # 아침 09시 직후 캔들 부족 시 최근 96개(24시간) 롤링 VWAP 적용
        roll_vol = vol.tail(96).sum()
        roll_tp_vol = tp_vol.tail(96).sum()
        if roll_vol > 0:
            vwap = float(roll_tp_vol / roll_vol)
        else:
            vwap = current_price if current_price > 0 else float(close.iloc[-1])

    price = current_price if current_price > 0 else float(close.iloc[-1])
    disparity_pct = ((price - vwap) / vwap) * 100.0 if vwap > 0 else 0.0
    return vwap, disparity_pct


def calculate_kellogg_indicators(
    df_15m: pd.DataFrame,
    df_day: Optional[pd.DataFrame] = None,
    current_price: float = 0.0,
) -> Optional[Dict[str, Any]]:
    """
    잭 켈로그 4대 핵심 지표 종합 계산 패키지
    """
    if df_15m is None or len(df_15m) < 20:
        return None

    price = current_price if current_price > 0 else float(df_15m["close"].iloc[-1])

    # 1. 3대 기준 가격선 (당일 시가, 전일 종가, 전일 고가, 전일 저가 — 일봉 부재 시 0.0으로 안전 비활성화)
    today_open = 0.0
    prev_close = 0.0
    prev_high = 0.0
    prev_low = 0.0

    if df_day is not None and len(df_day) >= 1:
        today_open = float(df_day["open"].iloc[-1])
        if len(df_day) >= 2:
            prev_close = float(df_day["close"].iloc[-2])
            prev_high = float(df_day["high"].iloc[-2])
            prev_low = float(df_day["low"].iloc[-2])
        else:
            prev_close = today_open
            prev_high = float(df_day["high"].iloc[-1])
            prev_low = float(df_day["low"].iloc[-1])

    # 2. VWAP & 이격도
    vwap, disparity_pct = compute_vwap(df_15m, price)

    # 3. 20봉 선형 회귀 채널
    closes = df_15m["close"].astype(float).tolist()
    lrc = compute_linear_regression_channel(closes, 20)
    if not lrc:
        return None

    # 4. 상대 거래량 폭발 배수 (RVOL — 직전 완성봉 자체 희석 방지 및 0거래량 시 0.0 반환)
    vol_series = df_15m["volume"].astype(float)
    avg_vol_for_cur = float(vol_series.iloc[-21:-1].mean()) if len(vol_series) >= 21 else float(vol_series.iloc[:-1].mean())
    avg_vol_for_closed = float(vol_series.iloc[-22:-2].mean()) if len(vol_series) >= 22 else (
        float(vol_series.iloc[:-2].mean()) if len(vol_series) >= 3 else avg_vol_for_cur
    )
    cur_vol = float(vol_series.iloc[-1])
    closed_vol = float(vol_series.iloc[-2]) if len(vol_series) >= 2 else cur_vol
    rvol_cur = (cur_vol / avg_vol_for_cur) if (avg_vol_for_cur > 0 and math.isfinite(avg_vol_for_cur)) else 0.0
    rvol_closed = (closed_vol / avg_vol_for_closed) if (avg_vol_for_closed > 0 and math.isfinite(avg_vol_for_closed)) else 0.0
    rvol = max(rvol_cur, rvol_closed)
    avg_vol_20 = avg_vol_for_cur if math.isfinite(avg_vol_for_cur) else 0.0

    # 최근 20봉 최고/최저가
    recent_high_20 = float(df_15m["high"].tail(20).max())
    recent_low_20 = float(df_15m["low"].tail(20).min())

    cur_open = float(df_15m["open"].iloc[-1])
    cur_close = float(df_15m["close"].iloc[-1])
    cur_high = float(df_15m["high"].iloc[-1])
    cur_low = float(df_15m["low"].iloc[-1])

    closed_close = float(df_15m["close"].iloc[-2]) if len(df_15m) >= 2 else cur_close
    closed_low = float(df_15m["low"].iloc[-2]) if len(df_15m) >= 2 else cur_low

    return {
        "today_open": today_open,
        "prev_close": prev_close,
        "prev_high": prev_high,
        "prev_low": prev_low,
        "vwap": vwap,
        "vwap_disparity_pct": disparity_pct,
        "lrc": lrc,
        "rvol": rvol,
        "avg_volume_20": avg_vol_20,
        "recent_high_20": recent_high_20,
        "recent_low_20": recent_low_20,
        "cur_open": cur_open,
        "cur_close": cur_close,
        "cur_high": cur_high,
        "cur_low": cur_low,
        "cur_bullish": cur_close > cur_open,
        "closed_close": closed_close,
        "closed_low": closed_low,
    }


def evaluate_jack_kellogg_strategy(
    k: Dict[str, Any],
    price: float,
    open_positions: Optional[List[Dict[str, Any]]] = None,
    is_live: bool = False,
    peak_price: float = 0.0,
    params: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    잭 켈로그 순수 수식 매매 시그널 판별 (가상/실전 공용)
    """
    params = params or {}
    raw_rvol_breakout = params.get("rvol_breakout_live" if is_live else "rvol_breakout_arena")
    if raw_rvol_breakout is None:
        raw_rvol_breakout = params.get("rvol_breakout", 1.4)
    rvol_breakout_th = float(raw_rvol_breakout)
    rvol_dip_th = float(params.get("rvol_dip", 1.3))
    raw_dip_gap = params.get("vwap_gap_live" if is_live else "vwap_gap_arena")
    if raw_dip_gap is None:
        raw_dip_gap = params.get("vwap_gap", 2.0)
    dip_gap_th = -abs(float(raw_dip_gap))
    trailing_pct = float(params.get("trailing_stop_pct", 1.5))

    held = open_positions or []

    # ==========================================
    # 1. 보유 포지션 매도 / 익절 / 손절 평가
    # ==========================================
    if len(held) > 0:
        total_cost = sum(float(p.get("buy_amount", 0.0) or (float(p.get("volume", 0.0)) * float(p.get("avg_buy_price", 0.0)))) for p in held)
        total_vol = sum(float(p.get("volume", 0.0)) for p in held)
        avg_buy_price = total_cost / total_vol if total_vol > 0 else float(held[0].get("avg_buy_price", price))
        total_pnl_pct = ((price - avg_buy_price) / avg_buy_price) * 100.0 if avg_buy_price > 0 else 0.0

        is_breakout = any("돌파" in str(p.get("buy_reason", "")) or "Setup A" in str(p.get("buy_reason", "")) for p in held)
        is_dip = any("반등" in str(p.get("buy_reason", "")) or "Setup B" in str(p.get("buy_reason", "")) for p in held)
        if not is_breakout and not is_dip:
            inferred_dip = (
                any(int(p.get("step_level") or 1) >= 2 for p in held)
                or (k["vwap"] > 0 and avg_buy_price > 0 and ((avg_buy_price - k["vwap"]) / k["vwap"]) * 100.0 <= dip_gap_th)
            )
            if inferred_dip:
                is_dip = True

        # (1) 기계적 기준선 손절 (Key Level Hard Stop)
        if is_breakout:
            if (k["today_open"] > 0 and price < k["today_open"] and price < k["vwap"]) or total_pnl_pct <= -2.0:
                return {
                    "signal": "SELL",
                    "reason": f"[Setup A 손절] 시가({k['today_open']:,.0f}) & VWAP({k['vwap']:,.0f}) 동시 이탈 / -2.0% 도달 (수익률 {total_pnl_pct:.2f}%)",
                }

        if is_dip:
            if k["prev_low"] > 0 and price < k["prev_low"]:
                return {
                    "signal": "SELL",
                    "reason": f"[Setup B 손절] 전일 저가({k['prev_low']:,.0f}) 하향 이탈 손절 (수익률 {total_pnl_pct:.2f}%)",
                }
            if len(held) >= 2 and total_pnl_pct <= -2.5:
                return {
                    "signal": "SELL",
                    "reason": f"[Setup B 손절] 2차 분할 후 평단가 대비 -2.5% 손절 (수익률 {total_pnl_pct:.2f}%)",
                }

        if not is_breakout and not is_dip:
            if (k["today_open"] > 0 and price < k["today_open"] and price < k["vwap"]) or total_pnl_pct <= -2.5:
                return {
                    "signal": "SELL",
                    "reason": f"[기계적 기준선 손절] 시가/VWAP 동시 이탈 또는 -2.5% 손절 (수익률 {total_pnl_pct:.2f}%)",
                }

        # (2) 선형 회귀 채널 익절 (Take Profit)
        lrc = k["lrc"]
        if total_pnl_pct >= 1.5 and price >= lrc["upper"]:
            return {
                "signal": "SELL",
                "reason": f"[LRC 상단 익절] +2σ 채널 상단({lrc['upper']:,.0f}) 도달 전량 익절 (+{total_pnl_pct:.2f}%)",
            }
        if is_dip and total_pnl_pct >= 1.5 and price >= lrc["mid"]:
            return {
                "signal": "SELL",
                "reason": f"[LRC 중심선 회귀 익절] LRC 중심선({lrc['mid']:,.0f}) 회귀 익절 (+{total_pnl_pct:.2f}%)",
            }

        # (3) 대량 거래량 폭발 + 윗꼬리 음봉 (Volume Climax Exhaustion) 청산
        cur_open = k["cur_open"]
        cur_high = k["cur_high"]
        cur_close = k["cur_close"]
        is_bearish_upper_wick = (cur_close < cur_open) and ((cur_high - cur_open) > abs(cur_open - cur_close) * 0.5)
        if total_pnl_pct >= 1.0 and k["rvol"] >= 2.5 and is_bearish_upper_wick:
            return {
                "signal": "SELL",
                "reason": f"[거래량 클라이맥스 엑시트] RVOL {k['rvol']:.1f}배 윗꼬리 음봉 출현 익절 (+{total_pnl_pct:.2f}%)",
            }

        # (4) 최고가 대비 -1.5% 트레일링 스탑
        cur_peak = max(peak_price, price)
        peak_pnl = ((cur_peak - avg_buy_price) / avg_buy_price) * 100.0 if avg_buy_price > 0 else 0.0
        if peak_pnl >= 1.5 and price <= cur_peak * (1.0 - trailing_pct / 100.0):
            return {
                "signal": "SELL",
                "reason": f"[트레일링 스탑] 고점 대비 -{trailing_pct}% 반락 익절 (수익률 {total_pnl_pct:+.2f}%)",
            }

        # (5) Setup B 2차 분할 매수 (Scaling-In) 평가
        if is_dip and len(held) == 1:
            first_buy = float(held[0].get("avg_buy_price") or 0.0)
            if first_buy > 0:
                drop_pct = ((price - first_buy) / first_buy) * 100.0
                if drop_pct <= -2.5 and (k["prev_low"] <= 0 or price >= k["prev_low"]):
                    return {
                        "signal": "BUY",
                        "reason": f"[Setup B 2차 분할 매수] 1차 진입가 대비 {drop_pct:.2f}% 추가 하락 분할 매수 (Scaling-In)",
                        "setup": "B",
                        "split_index": 2,
                        "order_ratio": 0.15,
                    }

        return {
            "signal": "HOLD",
            "reason": f"포지션 감시 중 (수익률 {total_pnl_pct:.2f}%, LRC {lrc['lower']:,.0f} ~ {lrc['upper']:,.0f})",
        }

    # ==========================================
    # 2. 신규 매수 진입 평가 (Setup A & Setup B)
    # ==========================================
    lrc = k["lrc"]

    # Setup A [Breakout Long - 추세 돌파 진입]
    setup_a_trend = (price > k["today_open"] if k["today_open"] > 0 else True) and (price > k["vwap"])
    setup_a_slope = lrc["slope"] > 0 and price < lrc["upper"]
    setup_a_break = (k["recent_high_20"] > 0 and price >= k["recent_high_20"] * 0.998) or (k["prev_high"] > 0 and price >= k["prev_high"] * 0.998)
    setup_a_vol = k["rvol"] >= rvol_breakout_th

    if setup_a_trend and setup_a_slope and setup_a_break and setup_a_vol:
        return {
            "signal": "BUY",
            "reason": f"[Setup A 돌파] VWAP({k['vwap']:,.0f}) 지지 & 전고점 돌파 · RVOL {k['rvol']:.1f}배 · LRC 기울기 +{lrc['slope']:.2f}",
            "setup": "A",
            "split_index": 1,
            "order_ratio": 0.3,
        }

    # Setup B [Dip Reversion Long - 과매도 이격 반등 1차 진입]
    min_low = min(k["cur_low"], k["closed_low"])
    setup_b_dip = k["vwap_disparity_pct"] <= dip_gap_th
    setup_b_lrc = min_low <= lrc["lower"] * 1.002
    setup_b_rebound = k["cur_bullish"] or (price > k["closed_close"])
    setup_b_vol = k["rvol"] >= rvol_dip_th

    if setup_b_dip and setup_b_lrc and setup_b_rebound and setup_b_vol:
        return {
            "signal": "BUY",
            "reason": f"[Setup B 반등 1차] LRC 하단(-2σ {lrc['lower']:,.0f}) 터치 반등 · VWAP 이격 {k['vwap_disparity_pct']:.2f}% · RVOL {k['rvol']:.1f}배",
            "setup": "B",
            "split_index": 1,
            "order_ratio": 0.15,
        }

    return {
        "signal": "HOLD",
        "reason": f"시그널 대기 (VWAP 이격 {k['vwap_disparity_pct']:.2f}%, LRC 기울기 {lrc['slope']:.2f}, RVOL {k['rvol']:.1f}배)",
    }


def run_bot_jack_kellogg(stop_event, bot_id: str = "bot_10", db_path: Optional[str] = None) -> None:
    """
    [Bot 10] 잭 켈로그(Jack Kellogg) 프라이스 액션 & VWAP/선형회귀 모멘텀 독립 워커 프로세스
    """
    from init_db import get_db_connection
    from bots import (
        acquire_live_cycle_mutex,
        acquire_live_executor_lease,
        can_enter_position,
        evaluate_smart_exit,
        execute_buy_order,
        execute_sell_order,
        get_safe_current_price,
        is_backend_running,
        is_dry_run,
        is_python_live_executor_authorized,
        normalize_bot_id,
        reconcile_python_unknown_timeout_intents,
        release_live_cycle_mutex,
        MIN_ORDER_KRW,
    )
    from market_hub import get_cached_ohlcv, get_cached_tickers

    bot_id = normalize_bot_id(bot_id)
    logger.info("Bot process [%s] (Jack Kellogg Price Action) started.", bot_id)
    peak_map: Dict[int, float] = {}

    while not stop_event.is_set():
        if not acquire_live_cycle_mutex(bot_id):
            if stop_event.wait(timeout=2):
                break
            continue
        try:
            if is_backend_running() or (not is_dry_run() and not is_python_live_executor_authorized()):
                if stop_event.wait(timeout=10):
                    break
                continue
            if not is_dry_run():
                lease_ok, _ = acquire_live_executor_lease(db_path=db_path)
                if not lease_ok:
                    if stop_event.wait(timeout=10):
                        break
                    continue
                reconcile_python_unknown_timeout_intents(db_path=db_path)

            conn = get_db_connection(db_path)
            allow_new_buys = True
            b_row = conn.execute(
                "SELECT is_selected_for_live, is_running FROM bots WHERE bot_id = ?;",
                (bot_id,),
            ).fetchone()
            if b_row is not None:
                b_dict = dict(b_row)
                allow_new_buys = (
                    int(b_dict.get("is_selected_for_live") or 0) == 1
                    and int(b_dict.get("is_running") or 0) == 1
                )
            bot_acc = conn.execute("SELECT * FROM bot_accounts WHERE bot_id = ?;", (bot_id,)).fetchone()
            available_krw = float(bot_acc["virtual_krw"]) if bot_acc else 0.0
            allocated_cap = float(bot_acc["allocated_capital"] or 0.0) if bot_acc else 0.0
            open_positions = conn.execute(
                "SELECT * FROM bot_positions WHERE bot_id = ? AND status = 'OPEN' ORDER BY id ASC;",
                (bot_id,),
            ).fetchall()
            conn.close()

            if not allow_new_buys and len(open_positions) == 0:
                if stop_event.wait(timeout=15):
                    break
                continue

            # 1. 기존 오픈 포지션 청산/익절/손절 점검
            pos_by_ticker: Dict[str, List[Dict[str, Any]]] = {}
            for pos in open_positions:
                pd_row = dict(pos)
                t = str(pd_row.get("market") or pd_row.get("ticker") or "")
                if t:
                    pos_by_ticker.setdefault(t, []).append(pd_row)

            for ticker, pos_list in list(pos_by_ticker.items()):
                cur_price = get_safe_current_price(ticker)
                if cur_price <= 0:
                    continue

                updated_peaks: List[Tuple[float, int]] = []
                for p in pos_list:
                    p_id = p["id"]
                    prev_high = float(p.get("highest_price") or p.get("avg_buy_price") or cur_price)
                    new_peak = max(peak_map.get(p_id, prev_high), prev_high, cur_price)
                    peak_map[p_id] = new_peak
                    p["highest_price"] = new_peak
                    if new_peak > float(p.get("highest_price_db") or prev_high):
                        updated_peaks.append((new_peak, p_id))
                if updated_peaks:
                    u_conn = get_db_connection(db_path)
                    try:
                        for new_peak, p_id in updated_peaks:
                            u_conn.execute("UPDATE bot_positions SET highest_price = ? WHERE id = ?;", (new_peak, p_id))
                        u_conn.commit()
                    finally:
                        u_conn.close()

                df_15m = get_cached_ohlcv(ticker, interval="minute15", count=100)
                df_day = get_cached_ohlcv(ticker, interval="day", count=30)
                if df_15m is None or len(df_15m) < 20:
                    continue

                k = calculate_kellogg_indicators(df_15m, df_day, cur_price)
                if not k:
                    continue

                # 스마트 청산(본절 스탑, 시간 제한 청산, 동적 ATR 트레일링 스탑) 우선 검토
                tr = pd.concat([
                    df_15m["high"] - df_15m["low"],
                    (df_15m["high"] - df_15m["close"].shift(1)).abs(),
                    (df_15m["low"] - df_15m["close"].shift(1)).abs()
                ], axis=1).max(axis=1)
                atr_raw = tr.rolling(14).mean().iloc[-1] if len(tr) >= 14 else 0.0
                atr_val = float(atr_raw) if (not pd.isna(atr_raw) and math.isfinite(float(atr_raw))) else 0.0

                for p in list(pos_list):
                    smart_exit = evaluate_smart_exit(
                        bot_id,
                        p,
                        cur_price,
                        atr=atr_val,
                        rvol=k.get("rvol", 0.0),
                        is_live=not is_dry_run(),
                    )
                    if smart_exit:
                        logger.info("[%s] Smart Exit on %s: %s", bot_id, ticker, smart_exit["reason"])
                        sell_res = execute_sell_order(p["id"], reason=smart_exit["reason"], db_path=db_path)
                        if sell_res:
                            peak_map.pop(p["id"], None)
                            pos_list.remove(p)

                if not pos_list:
                    continue

                max_peak = max(peak_map.get(p["id"], cur_price) for p in pos_list)
                eval_res = evaluate_jack_kellogg_strategy(
                    k,
                    cur_price,
                    open_positions=pos_list,
                    is_live=not is_dry_run(),
                    peak_price=max_peak,
                )

                if eval_res["signal"] == "SELL":
                    logger.info("[%s] %s SELL triggered: %s", bot_id, ticker, eval_res["reason"])
                    for p in pos_list:
                        sell_res = execute_sell_order(p["id"], reason=eval_res["reason"], db_path=db_path)
                        if sell_res:
                            peak_map.pop(p["id"], None)
                    continue

                if allow_new_buys and eval_res["signal"] == "BUY" and eval_res.get("split_index") == 2:
                    # 2차 분할 매수 실행
                    if available_krw >= MIN_ORDER_KRW:
                        split_ratio = float(eval_res.get("order_ratio", 0.15))
                        split_budget = min(available_krw, allocated_cap * split_ratio) if allocated_cap > 0 else (available_krw * 0.5)
                        if split_budget < MIN_ORDER_KRW:
                            split_budget = min(available_krw, MIN_ORDER_KRW * 1.05)
                        can_enter, invest_krw, reason = can_enter_position(
                            bot_id, ticker, split_budget, db_path=db_path
                        )
                        if can_enter:
                            buy_res = execute_buy_order(
                                bot_id,
                                ticker,
                                invest_krw,
                                step_level=2,
                                db_path=db_path,
                                buy_reason=eval_res["reason"],
                            )
                            if buy_res:
                                available_krw = max(0.0, available_krw - float(buy_res.get("buy_amount") or invest_krw))

            # 2. 신규 진입 종목 스캔 (실전 선택 + 가동 상태일 때만 허용, Graceful Drain 중엔 차단)
            if allow_new_buys:
                tickers_cache = get_cached_tickers()
                krw_tickers = [t for t in tickers_cache if t.startswith("KRW-")]
                if not krw_tickers:
                    krw_tickers = ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP", "KRW-DOGE", "KRW-ADA", "KRW-AVAX", "KRW-SUI"]

                top_candidates = krw_tickers[:20]

                for ticker in top_candidates:
                    if stop_event.is_set():
                        break
                    if ticker in pos_by_ticker and len(pos_by_ticker[ticker]) >= 2:
                        continue
                    if ticker in pos_by_ticker and len(pos_by_ticker[ticker]) == 1:
                        continue  # 2차 분할은 위 루프에서 처리

                    if available_krw < MIN_ORDER_KRW:
                        break

                    cur_price = get_safe_current_price(ticker)
                    if cur_price <= 0:
                        continue

                    df_15m = get_cached_ohlcv(ticker, interval="minute15", count=100)
                    df_day = get_cached_ohlcv(ticker, interval="day", count=30)
                    if df_15m is None or len(df_15m) < 20:
                        continue

                    k = calculate_kellogg_indicators(df_15m, df_day, cur_price)
                    if not k:
                        continue

                    eval_res = evaluate_jack_kellogg_strategy(
                        k,
                        cur_price,
                        open_positions=[],
                        is_live=not is_dry_run(),
                    )

                    if eval_res["signal"] == "BUY":
                        order_ratio = float(eval_res.get("order_ratio", 0.3))
                        base_cap = allocated_cap if allocated_cap > 0 else available_krw
                        budget = min(available_krw, base_cap * order_ratio)
                        if budget >= MIN_ORDER_KRW:
                            can_enter, invest_krw, reason = can_enter_position(
                                bot_id, ticker, budget, db_path=db_path
                            )
                            if can_enter:
                                logger.info("[%s] BUY entered for %s: %s", bot_id, ticker, eval_res["reason"])
                                buy_res = execute_buy_order(
                                    bot_id,
                                    ticker,
                                    invest_krw,
                                    step_level=1,
                                    db_path=db_path,
                                    buy_reason=eval_res["reason"],
                                )
                                if buy_res:
                                    available_krw = max(0.0, available_krw - float(buy_res.get("buy_amount") or invest_krw))

        except Exception as loop_exc:
            logger.error("[%s] Unexpected error in Jack Kellogg loop: %s", bot_id, loop_exc, exc_info=True)
        finally:
            release_live_cycle_mutex(bot_id)

        if stop_event.wait(timeout=15):
            break

    logger.info("Bot process [%s] gracefully stopped.", bot_id)
