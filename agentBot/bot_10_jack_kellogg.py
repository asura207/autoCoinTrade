# [Antigravity-Doc] ============================================================
# [Antigravity-Doc] 파일 역할: [Bot 10] 잭 켈로그(Jack Kellogg) 프라이스 액션 & VWAP/선형회귀채널(LRC ±2σ)/RVOL 멀티 레짐 트레이딩 알고리즘
# [Antigravity-Doc] 아키텍처 위치: agentBot 패키지의 핵심 전략 모듈 (bots.py 및 main_orchestrator.py에 의해 bot_10 워커로 등록·실행)
# [Antigravity-Doc] 주요 의존성: numpy, pandas(지표 계산), bots.py(공통 게이트웨이·주문 실행·스마트 청산), market_hub.py(캔들/티커 캐시), init_db.py(DB 조회)
# [Antigravity-Doc] 수정 시 주의사항:
# [Antigravity-Doc]   1) Setup B(반등 2분할)는 물타기 구조이므로 evaluate_smart_exit의 ATR 하드 손절 예외 처리와 정합성을 유지해야 함
# [Antigravity-Doc]   2) Graceful Drain(is_selected_for_live=0) 상태에서는 신규 매수/2차 분할 매수를 차단하고 기존 포지션 청산만 수행해야 함
# [Antigravity-Doc] ============================================================
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


# [Antigravity-Doc] 역할: 최근 period(기본 20)개 종가에 대해 최소자승법(OLS) 선형 회귀 채널(LRC ±2σ)을 계산
# [Antigravity-Doc] 입력: closes(List[float], 종가 시계열), period(int, 회귀 구간 길이, 기본 20)
# [Antigravity-Doc] 반환: Optional[Dict[str, float]] (slope, intercept, mid=ŷ_(n-1), upper=mid+2σ, lower=mid-2σ, sigma; 데이터 부족 시 None)
def compute_linear_regression_channel(closes: List[float], period: int = 20) -> Optional[Dict[str, float]]:
    """
    20봉 선형 회귀 채널 (LRC ±2σ)
    최소자승법(OLS)으로 기울기 m, 절편 b, 현재 시점 중심값 ŷ_19, 잔차 표준편차 σ(±2σ) 계산
    """
    if not closes or len(closes) < period:
        return None

    # [Antigravity-Doc] OLS 수식 계산: x = [0..n-1], 기울기 m = Σ((x - x̄) * y) / Σ((x - x̄)²), 절편 b = ȳ - m*x̄
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

    # [Antigravity-Doc] 잔차(y - ŷ)의 모표준편차 σ를 구해 상단(+2σ) 및 하단(-2σ) 채널 밴드 산출
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


# [Antigravity-Doc] 역할: 업비트 일봉 리셋 기준(당일 09:00 KST) 거래량 가중 평균가(VWAP) 및 현재가 이격도(%) 계산
# [Antigravity-Doc] 입력: df_15m(15분봉 OHLCV DataFrame), current_price(float, 0이면 마지막 종가 사용)
# [Antigravity-Doc] 반환: Tuple[float, float] -> (vwap 가격, vwap_disparity_pct 이격도 %)
def compute_vwap(df_15m: pd.DataFrame, current_price: float = 0.0) -> Tuple[float, float]:
    """
    당일 09:00 KST 이후 (또는 최근 24시간 롤링 96개 봉) VWAP 및 이격도 계산
    TP = (High + Low + Close) / 3
    VWAP = Σ(TP * Volume) / Σ(Volume)
    """
    if df_15m is None or df_15m.empty:
        return current_price, 0.0

    # [Antigravity-Doc] 대표가(Typical Price) = (고가 + 저가 + 종가) / 3 및 거래량 가중합 준비
    df = df_15m.copy()
    high = df["high"].astype(float)
    low = df["low"].astype(float)
    close = df["close"].astype(float)
    vol = df["volume"].astype(float)

    tp = (high + low + close) / 3.0
    tp_vol = tp * vol

    # [Antigravity-Doc] 업비트 거래일 기준(KST 09:00) 시작 시각 계산 (09시 이전이면 전일 09:00을 당일 시작으로 간주)
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

    # [Antigravity-Doc] 당일 09시 이후 15분봉이 4개(1시간) 이상이면 당일 VWAP 사용, 부족하면 최근 96봉(24시간) 롤링 VWAP로 폴백
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

    # [Antigravity-Doc] 현재가의 VWAP 대비 이격도(%) = ((현재가 - VWAP) / VWAP) * 100
    price = current_price if current_price > 0 else float(close.iloc[-1])
    disparity_pct = ((price - vwap) / vwap) * 100.0 if vwap > 0 else 0.0
    return vwap, disparity_pct


# [Antigravity-Doc] 역할: 잭 켈로그 4대 핵심 지표(3대 일봉 기준선, VWAP/이격도, 20봉 LRC, RVOL) 및 최근 캔들 상태를 일괄 계산
# [Antigravity-Doc] 입력: df_15m(15분봉 DataFrame, 최소 20봉), df_day(일봉 DataFrame, 선택), current_price(현재가)
# [Antigravity-Doc] 반환: Optional[Dict[str, Any]] (지표 딕셔너리; 15분봉 부족 또는 LRC 계산 불가 시 None)
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

    # [Antigravity-Doc] 지표 1: 일봉 기반 3대 핵심 가격 기준선(당일 시가, 전일 종가/고가/저가) 추출
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

    # [Antigravity-Doc] 지표 2: 당일/롤링 VWAP 및 이격도(%)
    # 2. VWAP & 이격도
    vwap, disparity_pct = compute_vwap(df_15m, price)

    # [Antigravity-Doc] 지표 3: 15분봉 최근 20개 종가 기반 선형 회귀 채널(LRC ±2σ)
    # 3. 20봉 선형 회귀 채널
    closes = df_15m["close"].astype(float).tolist()
    lrc = compute_linear_regression_channel(closes, 20)
    if not lrc:
        return None

    # [Antigravity-Doc] 지표 4: 상대 거래량 폭발 배수(RVOL) — 현재 진행봉과 직전 완성봉 각각에 대해 직전 20봉 평균(자신 제외) 대비 배수를 구해 최댓값 채택
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


# [Antigravity-Doc] 역할: 계산된 켈로그 지표와 현재 포지션 상태를 바탕으로 BUY/SELL/HOLD 순수 전략 시그널 판별 (가상/실전 공용)
# [Antigravity-Doc] 입력: k(지표 dict), price(현재가), open_positions(보유 포지션 목록), is_live(실전 여부), peak_price(보유 중 최고가), params(임계값 오버라이드)
# [Antigravity-Doc] 반환: Dict[str, Any] -> {"signal": "BUY"|"SELL"|"HOLD", "reason": str, (BUY 시 setup, split_index, order_ratio 포함)}
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
    # [Antigravity-Doc] 실전/가상(Arena) 모드별 RVOL 돌파 임계값, VWAP 과대 이격 임계값, 트레일링 스탑 비율 파라미터 해석
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
    trailing_pct = float(params.get("trailing_stop_pct", 1.0))
    min_lrc_tp_pct = float(params.get("min_lrc_tp_pct", 1.1))

    held = open_positions or []

    # [Antigravity-Doc] 분기 1: 이미 포지션을 보유 중인 경우 — 손절 -> LRC 익절 -> 거래량 클라이맥스 청산 -> 트레일링 스탑 -> Setup B 2차 분할 매수 순으로 평가
    # ==========================================
    # 1. 보유 포지션 매도 / 익절 / 손절 평가
    # ==========================================
    if len(held) > 0:
        # [Antigravity-Doc] 분할 매수 포지션 전체의 가중 평균 매수가(avg_buy_price) 및 합산 수익률(total_pnl_pct) 계산
        total_cost = sum(float(p.get("buy_amount", 0.0) or (float(p.get("volume", 0.0)) * float(p.get("avg_buy_price", 0.0)))) for p in held)
        total_vol = sum(float(p.get("volume", 0.0)) for p in held)
        avg_buy_price = total_cost / total_vol if total_vol > 0 else float(held[0].get("avg_buy_price", price))
        total_pnl_pct = ((price - avg_buy_price) / avg_buy_price) * 100.0 if avg_buy_price > 0 else 0.0

        # [Antigravity-Doc] 진입 사유 문자열(또는 분할 단계·VWAP 이격)로부터 Setup A(돌파) / Setup B(반등) 유형 추론
        is_breakout = any("돌파" in str(p.get("buy_reason", "")) or "Setup A" in str(p.get("buy_reason", "")) for p in held)
        is_dip = any("반등" in str(p.get("buy_reason", "")) or "Setup B" in str(p.get("buy_reason", "")) for p in held)
        if not is_breakout and not is_dip:
            inferred_dip = (
                any(int(p.get("step_level") or 1) >= 2 for p in held)
                or (k["vwap"] > 0 and avg_buy_price > 0 and ((avg_buy_price - k["vwap"]) / k["vwap"]) * 100.0 <= dip_gap_th)
            )
            if inferred_dip:
                is_dip = True

        # [Antigravity-Doc] 청산 규칙 (1) 기계적 기준선 손절: Setup A는 당일시가&VWAP 동시 이탈/-1.4%, Setup B는 전일저가 이탈 또는 평단가 -1.8%
        # (1) 기계적 기준선 손절 (Key Level Hard Stop)
        if is_breakout:
            if (k["today_open"] > 0 and price < k["today_open"] and price < k["vwap"]) or total_pnl_pct <= -1.4:
                return {
                    "signal": "SELL",
                    "reason": f"[Setup A 손절] 시가({k['today_open']:,.0f}) & VWAP({k['vwap']:,.0f}) 동시 이탈 / -1.4% 도달 (수익률 {total_pnl_pct:.2f}%)",
                }

        if is_dip:
            if k["prev_low"] > 0 and price < k["prev_low"]:
                return {
                    "signal": "SELL",
                    "reason": f"[Setup B 손절] 전일 저가({k['prev_low']:,.0f}) 하향 이탈 손절 (수익률 {total_pnl_pct:.2f}%)",
                }
            if total_pnl_pct <= -1.8:
                return {
                    "signal": "SELL",
                    "reason": f"[Setup B 손절] 평단가 대비 -1.8% 손절 (수익률 {total_pnl_pct:.2f}%)",
                }

        if not is_breakout and not is_dip:
            if (k["today_open"] > 0 and price < k["today_open"] and price < k["vwap"]) or total_pnl_pct <= -1.8:
                return {
                    "signal": "SELL",
                    "reason": f"[기계적 기준선 손절] 시가/VWAP 동시 이탈 또는 -1.8% 손절 (수익률 {total_pnl_pct:.2f}%)",
                }

        # [Antigravity-Doc] 청산 규칙 (2) 선형 회귀 채널 익절: 수익률 >= min_lrc_tp_pct(기본 +1.1%)이면서 LRC 상단(+2σ) 도달 시 전량 익절 (Setup B는 중심선 회귀 시에도 익절)
        # (2) 선형 회귀 채널 익절 (Take Profit)
        lrc = k["lrc"]
        if total_pnl_pct >= min_lrc_tp_pct and price >= lrc["upper"]:
            return {
                "signal": "SELL",
                "reason": f"[LRC 상단 익절] +2σ 채널 상단({lrc['upper']:,.0f}) 도달 전량 익절 (+{total_pnl_pct:.2f}%)",
            }
        if is_dip and total_pnl_pct >= min_lrc_tp_pct and price >= lrc["mid"]:
            return {
                "signal": "SELL",
                "reason": f"[LRC 중심선 회귀 익절] LRC 중심선({lrc['mid']:,.0f}) 회귀 익절 (+{total_pnl_pct:.2f}%)",
            }

        # [Antigravity-Doc] 청산 규칙 (3) 거래량 클라이맥스 엑시트: 수익률 >= +1.0% + RVOL >= 2.5배 + 윗꼬리 음봉(매수세 소진 징후) 출현 시 익절
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

        # [Antigravity-Doc] 청산 규칙 (4) 트레일링 스탑: 최고 수익률 >= +1.5% 달성 후 고점 대비 -trailing_pct%(기본 1.5%) 반락 시 익절
        # (4) 최고가 대비 -1.5% 트레일링 스탑
        cur_peak = max(peak_price, price)
        peak_pnl = ((cur_peak - avg_buy_price) / avg_buy_price) * 100.0 if avg_buy_price > 0 else 0.0
        if peak_pnl >= 1.5 and price <= cur_peak * (1.0 - trailing_pct / 100.0):
            return {
                "signal": "SELL",
                "reason": f"[트레일링 스탑] 고점 대비 -{trailing_pct}% 반락 익절 (수익률 {total_pnl_pct:+.2f}%)",
            }

        # [Antigravity-Doc] 추가 매수 규칙 (5) Setup B 2차 분할 매수(Scaling-In): 1차 진입 대비 -1.2%~-1.8% 하락 & 전일 저가 지지 시 15% 비중 추가 진입
        # (5) Setup B 2차 분할 매수 (Scaling-In) 평가
        if is_dip and len(held) == 1:
            first_buy = float(held[0].get("avg_buy_price") or 0.0)
            if first_buy > 0:
                drop_pct = ((price - first_buy) / first_buy) * 100.0
                if drop_pct <= -1.2 and total_pnl_pct > -1.8 and (k["prev_low"] <= 0 or price >= k["prev_low"]):
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

    # [Antigravity-Doc] 분기 2: 미보유 상태 신규 매수 진입 평가 — Setup A(추세 돌파, 30% 비중) 우선 검토 후 Setup B(과매도 반등 1차, 15% 비중) 검토
    # ==========================================
    # 2. 신규 매수 진입 평가 (Setup A & Setup B)
    # ==========================================
    lrc = k["lrc"]

    # [Antigravity-Doc] Setup A 조건: 당일시가·VWAP 상단 + LRC 양의 기울기 & 상단 미도달 + 최근 20봉/전일 고점 돌파(0.2% 허용) + RVOL 돌파 임계치 이상
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

    # [Antigravity-Doc] Setup B 조건: VWAP 과대 하락 이격 + LRC 하단(-2σ) 터치 + 양봉 전환/직전 종가 상회 반등 확인 + RVOL 반등 임계치 이상
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


# [Antigravity-Doc] 역할: bot_10(잭 켈로그 전략) 독립 워커 프로세스 메인 루프 (15초 주기)
# [Antigravity-Doc] 입력: stop_event(종료 제어 이벤트), bot_id(기본 "bot_10"), db_path(선택 DB 경로) | 반환: None
# [Antigravity-Doc] 핵심 흐름: 사이클 뮤텍스/실전 리스·타임아웃 정산 -> 보유 포지션 고점 갱신/스마트 청산/전략 청산·2차 분할 -> 신규 종목 스캔 및 1차 진입
def run_bot_jack_kellogg(stop_event, bot_id: str = "bot_10", db_path: Optional[str] = None) -> None:
    """
    [Bot 10] 잭 켈로그(Jack Kellogg) 프라이스 액션 & VWAP/선형회귀 모멘텀 독립 워커 프로세스
    """
    # [Antigravity-Doc] 순환 임포트(bots.py <-> bot_10_jack_kellogg.py)를 피하기 위해 워커 실행 시점에 지연 임포트 수행
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
    # [Antigravity-Doc] peak_map: 포지션 ID별 보유 중 최고가 인메모리 캐시 (DB highest_price와 동기화)
    peak_map: Dict[int, float] = {}

    while not stop_event.is_set():
        # [Antigravity-Doc] 0단계: 동일 봇 사이클 중첩 방지 뮤텍스 획득 + Node.js 백엔드 공존/실전 권한/리스 락/미해결 타임아웃 인텐트 정산
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

            # [Antigravity-Doc] 1단계: DB에서 봇 가동 상태(Graceful Drain 여부), 가용 원화, 현재 OPEN 포지션 목록 조회
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

            # [Antigravity-Doc] 신규 매수가 차단(비선택/중지)되었고 보유 포지션도 없으면 불필요한 시세 조회 없이 대기
            if not allow_new_buys and len(open_positions) == 0:
                if stop_event.wait(timeout=15):
                    break
                continue

            # [Antigravity-Doc] 2단계: 기존 OPEN 포지션을 마켓별로 그룹화하여 고점 갱신 -> 3단계 스마트 청산 -> 켈로그 전략 청산/2차 분할 매수 수행
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

                # [Antigravity-Doc] 포지션별 최고가(highest_price)를 인메모리 및 DB에 동기화 (트레일링 스탑 기준점 유지)
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

                # [Antigravity-Doc] 15분봉 ATR(14)을 산출하여 공통 스마트 청산(본절 스탑/시간 청산/ATR 트레일링)을 전략 청산보다 우선 평가
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

                # [Antigravity-Doc] 켈로그 전략 자체 청산/2차 분할 시그널 평가 (SELL 시 해당 티커 보유 포지션 전량 순차 매도)
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

                # [Antigravity-Doc] Setup B 2차 분할 매수: 신규 매수 허용 상태(Graceful Drain 아님)일 때만 공통 게이트웨이 통과 후 step_level=2 진입
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

            # [Antigravity-Doc] 3단계: 신규 1차 진입 종목 스캔 (상위 20개 KRW 마켓 대상, Graceful Drain 중에는 완전 차단)
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

                    # [Antigravity-Doc] BUY 시그널 발생 시 Setup A(30%) 또는 Setup B(15%) 비율로 예산 산정 -> can_enter_position 검증 -> execute_buy_order 실행
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
