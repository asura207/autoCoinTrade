"""
bots.py - 3개 트레이딩 봇 매매 전략 및 공통 리스크 게이트웨이 / 주문 유틸리티
- Step 3: 공통 can_enter_position() 게이트웨이 및 슬리피지 방어형 주문 래퍼
- Step 4:
  1) bot_vb (40%): 슈퍼트렌드/동적 변동성 돌파 + ATR 트레일링 스탑 (09:00 강제청산 폐기)
  2) bot_momentum (40%): 볼린저 밴드 스퀴즈 돌파 (VCP) (7일 추격매수 폐기)
  3) bot_bb (20%): SQLite 원장 기반 다단계 분할 매수(DCA/역추세) (-1.5% 칼손절 폐기)
- DRY_RUN 모드 지원: 실제 API 주문 없이 실시간 호가/시세 기반 가상 원장 체결 및 검증
"""

import datetime
import json
import logging
import math
import os
import sqlite3
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import pyupbit
import requests
from dotenv import load_dotenv

from init_db import DEFAULT_DB_PATH, get_db_connection, normalize_bot_overrides
from market_hub import get_cached_current_price, get_cached_ohlcv, get_cached_tickers

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("bots")

UPBIT_FEE_RATE = 0.0005  # 업비트 원화 마켓 수수료 0.05%
MIN_ORDER_KRW = 5000.0   # 업비트 최소 주문 금액 5,000원
SAFE_MIN_ORDER_KRW = 6500.0  # -20% 손절 시에도 5,200원 유지 (업비트 5,000원 최소 매도 제한 데드락 방지)


def round_down_volume_8(vol: Any) -> float:
    """업비트 주문 수량을 소수점 8자리 내림(ROUND_DOWN) 처리합니다."""
    try:
        v = float(vol)
        if v <= 0 or math.isnan(v) or math.isinf(v):
            return 0.0
        return math.floor(v * 100_000_000) / 100_000_000
    except Exception:
        return 0.0


def is_backend_running(port: int = 8001) -> bool:
    """
    Node.js 백엔드(포트 8001)가 기동 중인지 검사합니다.
    백엔드가 자체적으로 실전/가상 매매 루프를 실행 중인 경우,
    Python 봇 프로세스가 동일한 주문을 중복 실행(Double Execution)하지 않도록 방어합니다.
    """
    import socket
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.25)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return True
    except Exception:
        pass
    try:
        pid_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs", ".backend.pid")
        if os.path.isfile(pid_path):
            with open(pid_path, "r", encoding="utf-8") as f:
                pid = int(f.read().strip())
            os.kill(pid, 0)
            return True
    except Exception:
        pass
    return False


def normalize_bot_id(raw_id: str) -> str:
    """구버전 봇 ID(bot_vb 등)를 최신 표준 ID(bot_01 ~ bot_10)로 정규화합니다."""
    if not raw_id:
        return "bot_01"
    raw = str(raw_id).strip()
    alias_map = {
        "bot_vb": "bot_01",
        "bot_volatility": "bot_01",
        "bot_supertrend": "bot_02",
        "bot_momentum": "bot_03",
        "bot_dual_momentum": "bot_03",
        "bot_bb_squeeze": "bot_04",
        "bot_bb": "bot_05",
        "bot_bollinger_rebound": "bot_05",
        "bot_grid_dca": "bot_06",
        "bot_macd": "bot_07",
        "bot_pullback": "bot_08",
        "bot_volume_scalp": "bot_09",
        "bot_kellogg": "bot_10",
        "bot_jack_kellogg": "bot_10",
    }
    return alias_map.get(raw, raw)


def check_upper_wick_and_overextension(
    df_candle: Optional[pd.DataFrame],
    current_price: float,
    ma20: float = 0.0,
    vwap: float = 0.0,
) -> Tuple[bool, str]:
    """
    돌파형 봇(bot_01, bot_03, bot_04, bot_09) 윗꼬리(Whipsaw) & 고점 물림 방어 필터
    1) 캔들 전체 길이(High - Low) 중 윗꼬리 길이(High - Close)가 45% 초과하거나,
       캔들 종가가 고가 대비 상위 35% 이내에 안착하지 못한 경우 가짜 돌파(Bull Trap) 차단
    2) 현재가가 20MA 또는 VWAP 대비 +6.0% 이상 급등한 상태일 경우 이격도 과열 추격 매수 금지
    """
    if df_candle is None or df_candle.empty:
        return True, "OK"

    try:
        last_row = df_candle.iloc[-1]
        high = float(last_row.get("high", current_price))
        low = float(last_row.get("low", current_price))
        open_p = float(last_row.get("open", current_price))
        close = float(last_row.get("close", current_price))
        total_len = high - low

        if total_len > 0:
            upper_wick = high - max(open_p, close)
            upper_wick_ratio = upper_wick / total_len
            top_close_dist = (high - close) / total_len

            if upper_wick_ratio > 0.45 or top_close_dist > 0.35:
                return (
                    False,
                    f"Wick Filter Blocked: Upper wick {upper_wick_ratio*100:.1f}% > 45% or top 35% close missed ({top_close_dist*100:.1f}% > 35%)",
                )

        if ma20 > 0:
            ma_gap = ((current_price - ma20) / ma20) * 100.0
            if ma_gap >= 6.0:
                return False, f"Overextension Cap Blocked: 20MA gap +{ma_gap:.1f}% >= +6.0%"

        if vwap > 0:
            vwap_gap = ((current_price - vwap) / vwap) * 100.0
            if vwap_gap >= 6.0:
                return False, f"Overextension Cap Blocked: VWAP gap +{vwap_gap:.1f}% >= +6.0%"

    except Exception as exc:
        logger.debug("check_upper_wick_and_overextension check error: %s", exc)

    return True, "OK"


def evaluate_smart_exit(
    bot_id: str,
    open_pos: Dict[str, Any],
    current_price: float,
    atr: float = 0.0,
    rvol: float = 1.0,
    is_live: bool = False,
    stop_loss_pct: float = -2.5,
) -> Optional[Dict[str, Any]]:
    """
    3단계 스마트 청산 유틸리티
    1) 본절 스탑 (Breakeven Stop): 최고 수익률 +1.2% 이상 도달 후 +0.25% 이하로 하락 시 수익 반납 방지 익절
    2) 시간 제한 청산 (Time-Stop): 단타 봇(bot_01, bot_04, bot_05, bot_09, bot_10)이 6시간(실전)/2시간(가상) 경과 후 -0.6%~+0.8% 박스권 & RVOL < 1.0 시 자금 회수
    3) ATR 기반 동적 트레일링 스탑: 진입가 대비 -2.2*ATR 하드 손절, 최고가 대비 -1.8*ATR 트레일링 스탑
    """
    norm_id = normalize_bot_id(bot_id)
    avg_buy = float(open_pos.get("avg_buy_price", 0.0) or 0.0)
    if current_price <= 0 or avg_buy <= 0:
        return None

    pnl_pct = ((current_price - avg_buy) / avg_buy) * 100.0
    highest_price = max(float(open_pos.get("highest_price", 0.0) or avg_buy), current_price)
    peak_pnl_pct = ((highest_price - avg_buy) / avg_buy) * 100.0

    # 1. 본절 스탑 (Breakeven Stop — 수익 반납 방지)
    if peak_pnl_pct >= 1.2 and pnl_pct <= 0.25:
        return {
            "signal": "SELL",
            "reason": f"BREAKEVEN_STOP: Peak +{peak_pnl_pct:.2f}% dropped to +{pnl_pct:.2f}%",
        }

    # 2. 시간 제한 청산 (Time-Stop)
    time_stop_bots = {"bot_01", "bot_04", "bot_05", "bot_09", "bot_10"}
    if norm_id in time_stop_bots:
        created_str = open_pos.get("created_at") or open_pos.get("opened_at")
        if created_str:
            try:
                dt_str = str(created_str).replace("T", " ").split(".")[0]
                entry_dt = datetime.datetime.strptime(dt_str, "%Y-%m-%d %H:%M:%S")
                elapsed_hours = (datetime.datetime.now() - entry_dt).total_seconds() / 3600.0
                max_hours = 6.0 if is_live else 2.0

                in_box = (-0.6 <= pnl_pct <= 0.8)
                if elapsed_hours >= max_hours and in_box and rvol < 1.0:
                    return {
                        "signal": "SELL",
                        "reason": f"TIME_STOP: {elapsed_hours:.1f}h elapsed (box {pnl_pct:.2f}%, RVOL {rvol:.1f}x)",
                    }
            except Exception:
                pass

    # 3. ATR 기반 동적 트레일링 스탑
    if atr > 0:
        hard_stop_price = avg_buy - (2.2 * atr)
        if current_price <= hard_stop_price:
            return {
                "signal": "SELL",
                "reason": f"ATR_HARD_STOP: -2.2xATR ({hard_stop_price:,.0f} KRW) hit (PnL {pnl_pct:.2f}%)",
            }

        if highest_price > avg_buy:
            trailing_stop_price = highest_price - (1.8 * atr)
            if current_price <= trailing_stop_price:
                return {
                    "signal": "SELL",
                    "reason": f"ATR_TRAILING_STOP: -1.8xATR from peak ({trailing_stop_price:,.0f} KRW) hit (PnL {pnl_pct:.2f}%)",
                }
    else:
        fixed_stop = -abs(float(stop_loss_pct or 2.5))
        if pnl_pct <= fixed_stop:
            return {
                "signal": "SELL",
                "reason": f"FIXED_STOP_LOSS: PnL {pnl_pct:.2f}% <= {fixed_stop:.2f}%",
            }

    return None


# =====================================================================
# 1. 업비트 클라이언트 및 공통 지수 백오프 유틸리티
# =====================================================================

def is_dry_run() -> bool:
    """
    모의투자(DRY_RUN) 모드 여부를 반환합니다.
    환경변수 DRY_RUN=True 이거나 API 키가 없으면 True로 동작합니다.
    """
    dry = os.getenv("DRY_RUN", "True").strip().lower()
    if dry in ("true", "1", "yes"):
        return True
    access = os.getenv("UPBIT_ACCESS_KEY", "").strip()
    secret = os.getenv("UPBIT_SECRET_KEY", "").strip()
    return not (access and secret)


def get_upbit_client() -> Optional[pyupbit.Upbit]:
    """
    실거래 모드일 경우 pyupbit.Upbit 인스턴스를 반환하고,
    DRY_RUN 모드이거나 키가 없으면 None을 반환합니다.
    """
    if is_dry_run():
        return None
    access = os.getenv("UPBIT_ACCESS_KEY", "").strip()
    secret = os.getenv("UPBIT_SECRET_KEY", "").strip()
    if access and secret:
        return pyupbit.Upbit(access, secret)
    return None


def retry_with_backoff(func, *args, max_retries: int = 3, **kwargs):
    """
    지수 백오프(Exponential Backoff: 1초, 2초, 4초)를 적용하여 API 호출을 재시도합니다.
    """
    delays = [1.0, 2.0, 4.0]
    for attempt in range(max_retries):
        try:
            time.sleep(0.12)  # Rate Limit 보호 기본 딜레이
            result = func(*args, **kwargs)
            return result
        except Exception as exc:
            delay = delays[attempt] if attempt < len(delays) else 4.0
            logger.warning("API call failed (attempt %d/%d): %s. Retrying in %.1fs...", attempt + 1, max_retries, exc, delay)
            time.sleep(delay)
    return None


def get_safe_current_price(ticker: str) -> float:
    """
    현재가를 안전하게 조회합니다. 중앙 인메모리 캐시(market_hub)를 우선 활용하여 Rate Limit을 방어합니다.
    """
    p = get_cached_current_price(ticker)
    if p > 0:
        return p
    try:
        raw = pyupbit.get_current_price(ticker)
        if raw and float(raw) > 0:
            return float(raw)
    except Exception:
        pass
    return 0.0


# =====================================================================
# 2. Step 3: 공통 매수 게이트웨이 (can_enter_position)
# =====================================================================

def can_enter_position(
    bot_id: str,
    ticker: str,
    available_krw: float,
    db_path: Optional[str] = None,
    is_paper: bool = False,
) -> Tuple[bool, float, str]:
    """
    3개 봇이 매수 직전에 통과해야 하는 공통 리스크 체크 및 투입 금액 계산 게이트웨이:
    - 가상거래(Arena/Paper) 모드: 100% 순수 알고리즘 시그널 작동을 위해 LLM 및 거시 하락장 필터 완전 우회(Bypass)
    - 실전거래(Live) 모드: 듀얼 AI 및 BTC 20MA 거시 리스크 필터 엄격 적용
    """
    # 0. 가상거래/시뮬레이션 모드일 경우 LLM 및 거시 리스크 필터 완전 우회 (Bypass)
    norm_id = normalize_bot_id(bot_id)

    # 실전거래 모드에서 Node.js 백엔드가 실행 중이면 중복 주문(Double Execution) 방지를 위해 Python 주문 디퍼
    if not is_paper and not is_dry_run() and is_backend_running():
        return (
            False,
            0.0,
            f"DEFERRED_TO_NODEJS_BACKEND: Active Node.js backend manages live trading for {norm_id}",
        )

    if is_paper or is_dry_run():
        fee_buffer = 1.0 - UPBIT_FEE_RATE
        raw_available_buffered = available_krw * fee_buffer
        invest_krw = raw_available_buffered
        if invest_krw < SAFE_MIN_ORDER_KRW:
            if raw_available_buffered >= MIN_ORDER_KRW:
                invest_krw = min(raw_available_buffered, 5050.0)
            else:
                return (
                    False,
                    0.0,
                    f"Insufficient KRW (<5000): Available={available_krw:,.0f}원",
                )
        return True, float(math.floor(invest_krw)), "PAPER_BYPASS_OK"

    conn = get_db_connection(db_path)
    try:
        # 0-1. 실전 일일 서킷 브레이커 (Daily Circuit Breaker): 당일 실현 손실이 배정원금의 -4.0% 이하 시 신규 매수 차단
        if not is_paper and not is_dry_run():
            today_start = datetime.datetime.now().strftime("%Y-%m-%d 00:00:00")
            loss_row = conn.execute(
                "SELECT COALESCE(SUM(profit_krw), 0) AS daily_profit FROM trades WHERE (bot_id = ? OR bot_id = ?) AND status = 'COMPLETED' AND sell_date >= ?;",
                (bot_id, norm_id, today_start),
            ).fetchone()
            daily_profit = float(loss_row["daily_profit"]) if loss_row else 0.0
            bot_row = conn.execute("SELECT allocated_capital FROM bots WHERE bot_id = ?;", (norm_id,)).fetchone()
            allocated_cap = float(bot_row["allocated_capital"]) if bot_row else 0.0
            loss_limit = -math.floor(allocated_cap * 0.04) if allocated_cap > 0 else -40000.0
            if allocated_cap > 0 and daily_profit <= loss_limit:
                return (
                    False,
                    0.0,
                    f"CIRCUIT_BREAKER_ACTIVE: Daily loss {daily_profit:,.0f} KRW exceeded -4.0% limit ({loss_limit:,.0f} KRW)",
                )

        # 0-2. 실전 선택 봇 & 가동 상태 확인 (Graceful Drain 중인 해제 봇은 신규 매수 절대 차단)
        if not is_paper and not is_dry_run():
            try:
                live_bot_row = conn.execute(
                    "SELECT is_selected_for_live, is_running FROM bots WHERE bot_id = ?;",
                    (norm_id,),
                ).fetchone()
                if live_bot_row is not None:
                    lb = dict(live_bot_row)
                    if int(lb.get("is_selected_for_live") or 0) != 1 or int(lb.get("is_running") or 0) != 1:
                        return (
                            False,
                            0.0,
                            f"Live Gateway Blocked: {norm_id} is inactive or in Graceful Drain (existing positions still monitored)",
                        )
            except Exception:
                pass

        # 1. LLM 필터 테이블 조회
        raw_filter_row = conn.execute("SELECT * FROM market_regime_filter WHERE id = 1;").fetchone()
        if not raw_filter_row:
            return False, 0.0, "market_regime_filter table row id=1 not found"
        filter_row = dict(raw_filter_row)

        # 듀얼 AI 최종 교차 검증 값 우선 참조 (하위 호환성 완벽 유지)
        if filter_row.get("final_risk_alert") is not None:
            risk_alert = bool(filter_row["final_risk_alert"])
        else:
            risk_alert = bool(filter_row.get("risk_alert", 0))

        rec_action = str(
            filter_row.get("final_recommended_action")
            or filter_row.get("recommended_action")
            or "NORMAL"
        ).upper()

        if filter_row.get("final_position_multiplier") is not None:
            multiplier = float(filter_row["final_position_multiplier"])
        else:
            multiplier = float(filter_row.get("position_size_multiplier") or 1.0)
        multiplier = max(0.0, min(1.0, multiplier))

        bot_overrides = normalize_bot_overrides(
            filter_row.get("final_bot_overrides_json") or filter_row.get("bot_overrides_json")
        )
        raw_blacklist = json.loads(filter_row.get("blacklist_tickers_json") or "[]")
        blacklist = [str(t or "").strip().upper() for t in raw_blacklist if str(t or "").strip()]

        # 1-1. 위험 경보 활성화
        if risk_alert:
            return False, 0.0, f"LLM Filter Blocked: Risk alert is active ({filter_row.get('reason', '')})"

        # 1-2. 신규 매수 차단 / 전량 청산 권고
        if rec_action in ("HALT_NEW_BUYS", "EMERGENCY_CLOSE_ALL"):
            return False, 0.0, f"LLM Filter Blocked: Recommended action is {rec_action}"

        # 1-3. 봇별 오버라이드 차단 (bot_01 ~ bot_10 표준 ID 기준)
        if bot_overrides.get(norm_id) == "BLOCK":
            return (
                False,
                0.0,
                f"AI 장세 필터에 의해 신규 진입 보류(보유 포지션은 정상 감시) [{norm_id}]",
            )

        # 1-4. 블랙리스트 티커
        norm_ticker = str(ticker or "").strip().upper()
        if norm_ticker in blacklist or norm_ticker.replace("KRW-", "") in blacklist:
            return False, 0.0, f"LLM Filter Blocked: Ticker {ticker} is in blacklist"

        # 1-5. 포지션 배율이 0.0인 경우
        if multiplier <= 0.0:
            return False, 0.0, "LLM Filter Blocked: Position size multiplier is 0.0"

        # 2. 기술적 대장주 필터 (BTC 일봉 20MA 참고 감축)
        btc_price = get_safe_current_price("KRW-BTC")
        if btc_price > 0:
            try:
                btc_df = pyupbit.get_ohlcv("KRW-BTC", interval="day", count=25)
                if btc_df is not None and len(btc_df) >= 20:
                    btc_ma20 = float(btc_df["close"].rolling(20).mean().iloc[-1])
                    if btc_price < btc_ma20 and rec_action == "REDUCE_SIZE" and ticker != "KRW-BTC":
                        multiplier = min(multiplier, 0.5)
                        logger.info("[%s] BTC below 20MA in BEAR/REDUCE_SIZE. Multiplier reduced to %.2f for %s", bot_id, multiplier, ticker)
            except Exception as btc_err:
                logger.debug("BTC MA check minor error: %s", btc_err)

        # 3. 투입 금액 산출 (Math.floor((available_krw * final_position_multiplier) / 1.0005))
        invest_krw = float(math.floor((available_krw * multiplier) / (1.0 + UPBIT_FEE_RATE)))
        max_orderable_krw = float(math.floor(available_krw / (1.0 + UPBIT_FEE_RATE)))

        # 4. 업비트 최소 주문 금액(5,000원) 검증 — 가용 원화 충분 시 5,050원으로 보정, 부족 시 보류
        if invest_krw < MIN_ORDER_KRW:
            if max_orderable_krw >= 5050.0 and multiplier > 0:
                invest_krw = 5050.0
            else:
                return (
                    False,
                    0.0,
                    f"Insufficient KRW (<5000): Available={available_krw:,.0f}원, Calculated={invest_krw:,.0f}원",
                )

        final_invest_krw = math.floor(invest_krw)
        return True, float(final_invest_krw), "OK"

    except Exception as exc:
        logger.error("Error in can_enter_position for bot %s: %s", bot_id, exc)
        return False, 0.0, f"Gateway Error: {exc}"
    finally:
        conn.close()


# =====================================================================
# 3. Step 3: 슬리피지 방어형 주문 래퍼 함수 (매수 / 분할 매도)
# =====================================================================

def execute_limit_order_with_polling(
    upbit: pyupbit.Upbit,
    side: str,  # "bid" or "ask"
    ticker: str,
    price: float,
    volume: float,
    timeout_sec: int = 40,
) -> Optional[Dict[str, Any]]:
    """
    시장가 슬리피지 방어를 위한 최유리 지정가 주문 및 최대 40초 폴링 래퍼.
    미체결 시 주문 취소(cancel_order) 및 체결 수량/수수료 확인.
    """
    vol_rounded = round(float(volume), 8)
    price_val = float(price)
    try:
        if side == "bid":
            res = retry_with_backoff(upbit.buy_limit_order, ticker, price_val, vol_rounded)
        else:
            res = retry_with_backoff(upbit.sell_limit_order, ticker, price_val, vol_rounded)
        if not res or "uuid" not in res:
            logger.warning("[%s %s] Limit order placement failed or returned no uuid: %s", side, ticker, res)
            return None
        order_uuid = res["uuid"]
    except Exception as exc:
        logger.warning("[%s %s] Limit order error: %s", side, ticker, exc)
        return None

    poll_start = time.time()
    filled_vol = 0.0
    exec_price = price_val
    paid_fee = 0.0
    is_done = False

    while time.time() - poll_start < timeout_sec:
        time.sleep(3.0)
        detail = retry_with_backoff(upbit.get_order, order_uuid)
        if not detail:
            continue
        state = detail.get("state", "")
        filled_vol = float(detail.get("executed_volume", 0.0) or 0.0)
        if state in ("done", "cancel"):
            is_done = True
            trades = detail.get("trades", [])
            total_funds = sum(float(t.get("funds", 0.0)) for t in trades)
            if total_funds > 0 and filled_vol > 0:
                exec_price = total_funds / filled_vol
            paid_fee = float(detail.get("paid_fee", 0.0) or 0.0)
            break

    # 미체결 잔여분 취소 (cancel_order)
    if not is_done:
        try:
            logger.info("Limit order %s timeout (%ds); canceling remainder...", order_uuid, timeout_sec)
            retry_with_backoff(upbit.cancel_order, order_uuid)
            time.sleep(1.0)
            detail = retry_with_backoff(upbit.get_order, order_uuid)
            if detail:
                filled_vol = float(detail.get("executed_volume", 0.0) or 0.0)
                trades = detail.get("trades", [])
                total_funds = sum(float(t.get("funds", 0.0)) for t in trades)
                if total_funds > 0 and filled_vol > 0:
                    exec_price = total_funds / filled_vol
                paid_fee = float(detail.get("paid_fee", 0.0) or 0.0)
        except Exception as c_exc:
            logger.warning("Order cancel exception: %s", c_exc)

    if filled_vol > 0:
        return {
            "uuid": order_uuid,
            "executed_price": exec_price,
            "executed_volume": filled_vol,
            "paid_fee": paid_fee,
        }
    return None


def execute_buy_order(
    bot_id: str,
    ticker: str,
    invest_krw: float,
    step_level: int = 1,
    db_path: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """
    매수 주문 실행 및 SQLite 가상 원장(bot_positions, bot_accounts) 원자적 업데이트:
    - DRY_RUN 모드: 실시간 시세 기준 가상 주문 생성
    - LIVE 모드: 최유리 지정가 주문 우선(미체결 폴링 취소) 후 필요 시 시장가 폴백
    - bot_accounts의 virtual_krw 차감 및 bot_positions 행 추가
    """
    conn = get_db_connection(db_path)
    dry = is_dry_run()
    upbit = get_upbit_client()

    norm_bot_id = normalize_bot_id(bot_id)

    # Node.js 백엔드가 실거래를 관장 중인 경우 Python 중복 실거래 주문 차단
    if not dry and upbit and is_backend_running():
        logger.info("[%s] Node.js backend is active. Deferring live buy order on Upbit to backend.", norm_bot_id)
        conn.close()
        return None

    current_price = get_safe_current_price(ticker)
    if current_price <= 0:
        logger.error("[%s] Cannot execute buy: Invalid price for %s", norm_bot_id, ticker)
        conn.close()
        return None

    buy_fee = invest_krw * UPBIT_FEE_RATE
    net_invest = invest_krw - buy_fee
    volume = round(net_invest / current_price, 8)
    order_uuid = f"sim-buy-{uuid.uuid4().hex[:12]}"
    executed_price = current_price

    if not dry and upbit:
        # 1. 슬리피지 방어를 위한 최유리 지정가 주문 우선 시도 (35초 폴링)
        limit_res = execute_limit_order_with_polling(upbit, "bid", ticker, current_price, volume, timeout_sec=35)
        if limit_res:
            order_uuid = limit_res["uuid"]
            executed_price = limit_res["executed_price"]
            volume = round(limit_res["executed_volume"], 8)
            buy_fee = limit_res["paid_fee"]
            invest_krw = math.floor(volume * executed_price + buy_fee)
        else:
            # 2. 지정가 미체결/실패 시 안전 시장가 매수 폴백
            logger.info("[%s] Limit buy not filled; falling back to market buy for %s", norm_bot_id, ticker)
            res = retry_with_backoff(upbit.buy_market_order, ticker, invest_krw)
            if not res or "uuid" not in res:
                logger.error("[%s] Live market buy order failed for %s", norm_bot_id, ticker)
                conn.close()
                return None
            order_uuid = res["uuid"]
            time.sleep(0.5)
            order_detail = retry_with_backoff(upbit.get_order, order_uuid)
            if order_detail:
                executed_price = float(order_detail.get("price", current_price))
                volume = round(float(order_detail.get("executed_volume", volume)), 8)
                buy_fee = float(order_detail.get("paid_fee", buy_fee))
                trades = order_detail.get("trades", [])
                total_funds = sum(float(t.get("funds", 0.0)) for t in trades)
                if total_funds > 0 and volume > 0:
                    executed_price = total_funds / volume
                    invest_krw = math.floor(total_funds + buy_fee)

    try:
        conn.execute("BEGIN IMMEDIATE;")

        # bot_positions 테이블에 신규 포지션 기록
        conn.execute(
            """
            INSERT INTO bot_positions (
                bot_id, ticker, order_uuid, volume, avg_buy_price,
                buy_amount, buy_fee, highest_price, step_level, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', CURRENT_TIMESTAMP);
            """,
            (
                norm_bot_id,
                ticker,
                order_uuid,
                volume,
                executed_price,
                invest_krw,
                buy_fee,
                executed_price,
                step_level,
            ),
        )

        # bot_accounts의 virtual_krw 차감
        conn.execute(
            """
            UPDATE bot_accounts
            SET virtual_krw = MAX(0.0, virtual_krw - ?),
                updated_at = CURRENT_TIMESTAMP
            WHERE bot_id = ?;
            """,
            (invest_krw, norm_bot_id),
        )

        conn.execute("COMMIT;")
        logger.info(
            f"[{norm_bot_id}] BUY Executed ({'DRY_RUN' if dry else 'LIVE'}): {ticker} | "
            f"Amount={invest_krw:,.0f}원 | Price={executed_price:,.0f}원 | Vol={volume:.8f} | UUID={order_uuid}"
        )
        return {
            "bot_id": norm_bot_id,
            "ticker": ticker,
            "order_uuid": order_uuid,
            "volume": volume,
            "avg_buy_price": executed_price,
            "buy_amount": invest_krw,
        }
    except Exception as exc:
        conn.execute("ROLLBACK;")
        logger.error("[%s] Buy transaction failed in SQLite: %s", bot_id, exc)
        return None
    finally:
        conn.close()


def execute_sell_order(
    position_id: int,
    reason: str = "SELL",
    db_path: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """
    개별 포지션 분할 매도 실행:
    - 절대 get_balance() 전체 잔고를 매도하지 않음!
    - bot_positions 테이블에 기록된 해당 position_id의 volume 수량만 지정하여 매도
    - 매도 후 status='CLOSED', realized_pnl 갱신 및 bot_accounts의 virtual_krw 복원
    """
    conn = get_db_connection(db_path)
    dry = is_dry_run()
    upbit = get_upbit_client()

    pos = conn.execute("SELECT * FROM bot_positions WHERE id = ? AND status = 'OPEN';", (position_id,)).fetchone()
    if not pos:
        logger.warning("Position id=%d is not in OPEN status.", position_id)
        conn.close()
        return None
    pos = dict(pos)

    bot_id = pos["bot_id"]
    norm_bot_id = normalize_bot_id(bot_id)
    ticker = pos.get("ticker") or pos.get("market") or ""
    volume = round_down_volume_8(pos["volume"])
    if volume <= 0:
        logger.error("[%s] Cannot sell position %d: invalid volume=%s", bot_id, position_id, pos.get("volume"))
        conn.close()
        return None
    buy_amount = float(pos["buy_amount"])
    avg_buy_price = float(pos["avg_buy_price"])

    # Node.js 백엔드가 실거래를 관장 중인 경우 Python 중복 실거래 주문 차단
    if not dry and upbit and is_backend_running():
        logger.info("[%s] Node.js backend is active. Deferring live sell order on Upbit to backend.", norm_bot_id)
        conn.close()
        return None

    current_price = get_safe_current_price(ticker)
    if current_price <= 0:
        logger.error("[%s] Cannot sell position %d: Invalid price for %s", bot_id, position_id, ticker)
        conn.close()
        return None

    gross_amount = volume * current_price
    sell_fee = gross_amount * UPBIT_FEE_RATE
    net_sell_amount = gross_amount - sell_fee
    realized_pnl = net_sell_amount - buy_amount
    pnl_pct = (realized_pnl / buy_amount) * 100.0 if buy_amount > 0 else 0.0
    sell_order_uuid = f"sim-sell-{uuid.uuid4().hex[:12]}"
    executed_sell_price = current_price

    if not dry and upbit:
        # 엄격하게 본인 bot_positions에 기록된 volume 수량만 지정하여 최유리 지정가 매도 우선 시도
        limit_res = execute_limit_order_with_polling(upbit, "ask", ticker, current_price, volume, timeout_sec=35)
        if limit_res:
            sell_order_uuid = limit_res["uuid"]
            executed_sell_price = limit_res["executed_price"]
            volume = round_down_volume_8(limit_res["executed_volume"])
            sell_fee = limit_res["paid_fee"]
            gross_amount = volume * executed_sell_price
            net_sell_amount = gross_amount - sell_fee
            realized_pnl = net_sell_amount - buy_amount
            pnl_pct = (realized_pnl / buy_amount) * 100.0 if buy_amount > 0 else 0.0
        else:
            logger.info("[%s] Limit sell not filled; falling back to market sell for pos %d (%s, vol=%.8f)", bot_id, position_id, ticker, volume)
            res = retry_with_backoff(upbit.sell_market_order, ticker, volume)
            if not res or "uuid" not in res:
                logger.error("[%s] Live market sell failed for pos %d (%s, vol=%.8f)", bot_id, position_id, ticker, volume)
                conn.close()
                return None
            sell_order_uuid = res["uuid"]
            time.sleep(0.5)
            order_detail = retry_with_backoff(upbit.get_order, sell_order_uuid)
            if order_detail:
                executed_sell_price = float(order_detail.get("price", current_price))
                volume = round_down_volume_8(order_detail.get("executed_volume", volume))
                sell_fee = float(order_detail.get("paid_fee", sell_fee))
                trades = order_detail.get("trades", [])
                total_funds = sum(float(t.get("funds", 0.0)) for t in trades)
                if total_funds > 0 and volume > 0:
                    executed_sell_price = total_funds / volume
                    gross_amount = total_funds
                else:
                    gross_amount = volume * executed_sell_price
                net_sell_amount = gross_amount - sell_fee
                realized_pnl = net_sell_amount - buy_amount
                pnl_pct = (realized_pnl / buy_amount) * 100.0 if buy_amount > 0 else 0.0

    try:
        conn.execute("BEGIN IMMEDIATE;")

        # 1. bot_positions 상태 업데이트 (CLOSED)
        conn.execute(
            """
            UPDATE bot_positions
            SET status = 'CLOSED',
                sell_order_uuid = ?,
                sell_price = ?,
                sell_amount = ?,
                sell_fee = ?,
                realized_pnl = ?,
                pnl_pct = ?,
                closed_at = CURRENT_TIMESTAMP
            WHERE id = ?;
            """,
            (
                sell_order_uuid,
                executed_sell_price,
                net_sell_amount,
                sell_fee,
                realized_pnl,
                pnl_pct,
                position_id,
            ),
        )

        # 2. bot_accounts에 회수된 원화 반영 및 실현 손익 누적
        conn.execute(
            """
            UPDATE bot_accounts
            SET virtual_krw = virtual_krw + ?,
                total_realized_pnl = total_realized_pnl + ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE bot_id = ?;
            """,
            (net_sell_amount, realized_pnl, norm_bot_id),
        )

        conn.execute("COMMIT;")
        logger.info(
            f"[{norm_bot_id}] SELL Executed ({'DRY_RUN' if dry else 'LIVE'}, {reason}): {ticker} | "
            f"SellPrice={executed_sell_price:,.0f}원 | PnL={realized_pnl:,.0f}원 ({pnl_pct:.2f}%) | UUID={sell_order_uuid}"
        )
        return {
            "position_id": position_id,
            "realized_pnl": realized_pnl,
            "pnl_pct": pnl_pct,
            "net_sell_amount": net_sell_amount,
        }
    except Exception as exc:
        conn.execute("ROLLBACK;")
        logger.error("[%s] Sell transaction failed in SQLite: %s", bot_id, exc)
        return None
    finally:
        conn.close()


# =====================================================================
# 4. 기술적 보조지표 계산 함수들
# =====================================================================

def compute_atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """ATR (Average True Range) 지표를 계산합니다."""
    high = df["high"]
    low = df["low"]
    close = df["close"]
    prev_close = close.shift(1)

    tr1 = high - low
    tr2 = (high - prev_close).abs()
    tr3 = (low - prev_close).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    return tr.rolling(period).mean()


def compute_bollinger_bands(df: pd.DataFrame, period: int = 20, num_std: float = 2.0) -> Tuple[pd.Series, pd.Series, pd.Series, pd.Series]:
    """볼린저 밴드 (중심선, 상단, 하단, 밴드폭)을 계산합니다."""
    close = df["close"]
    middle = close.rolling(period).mean()
    std = close.rolling(period).std()
    upper = middle + (num_std * std)
    lower = middle - (num_std * std)
    bandwidth = (upper - lower) / (middle + 1e-9)
    return middle, upper, lower, bandwidth


def compute_rsi(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """RSI (Relative Strength Index) 지표를 계산합니다."""
    delta = df["close"].diff()
    gain = delta.clip(lower=0.0).rolling(period).mean()
    loss = (-delta.clip(upper=0.0)).rolling(period).mean()
    rs = gain / (loss + 1e-9)
    return 100.0 - (100.0 / (1.0 + rs))


# =====================================================================
# 5. Step 4: 봇 1 (`bot_vb`) - 슈퍼트렌드 변동성 돌파 + ATR 트레일링 스탑
# =====================================================================

def run_bot_vb(stop_event, bot_id: str = "bot_01", db_path: Optional[str] = None) -> None:
    """
    [Bot 1] 슈퍼트렌드 / 동적 변동성 돌파 + ATR 트레일링 스탑 (자금 비중 40%)
    - 대상: KRW-BTC, KRW-ETH
    - 기존 09:00 강제 시장가 청산 폐기
    - 진입: 4시간봉 기준 노이즈 비율 목표가 돌파 + 현재가 > 5일선 + 거래량 20봉 평균 1.5배 이상
    - 청산: 보유 중 최고가 대비 3 * ATR(14) 하락 시 트레일링 스탑 청산
    """
    norm_id = normalize_bot_id(bot_id)
    logger.info("Bot process [%s (norm: %s)] started.", bot_id, norm_id)
    target_tickers = ["KRW-BTC", "KRW-ETH"]

    while not stop_event.is_set():
        try:
            conn = get_db_connection(db_path)
            allow_new_buys = True
            if not is_dry_run():
                b_row = conn.execute("SELECT is_selected_for_live, is_running FROM bots WHERE bot_id = ?;", (norm_id,)).fetchone()
                if b_row is not None:
                    b_dict = dict(b_row)
                    allow_new_buys = bool(b_dict.get("is_selected_for_live")) and bool(b_dict.get("is_running"))

            bot_acc = conn.execute("SELECT * FROM bot_accounts WHERE bot_id = ?;", (norm_id,)).fetchone()
            available_krw = float(bot_acc["virtual_krw"]) if bot_acc else 0.0
            has_open_rows = conn.execute(
                "SELECT COUNT(*) as cnt FROM bot_positions WHERE (bot_id = ? OR bot_id = ?) AND status = 'OPEN';",
                (bot_id, norm_id),
            ).fetchone()
            has_open_pos = int(dict(has_open_rows).get("cnt", 0)) > 0 if has_open_rows else False
            conn.close()

            if not allow_new_buys and not has_open_pos:
                if stop_event.wait(timeout=10):
                    break
                continue

            for ticker in target_tickers:
                if stop_event.is_set():
                    break

                current_price = get_safe_current_price(ticker)
                if current_price <= 0:
                    continue

                # 1. 4시간봉 캔들 데이터 수집
                df = pyupbit.get_ohlcv(ticker, interval="minute240", count=50)
                if df is None or len(df) < 25:
                    continue

                atr_series = compute_atr(df, period=14)
                atr_val = float(atr_series.iloc[-1]) if not pd.isna(atr_series.iloc[-1]) else current_price * 0.02
                sma5 = float(df["close"].rolling(5).mean().iloc[-1])
                vol_ma20 = float(df["volume"].rolling(20).mean().iloc[-1])
                curr_vol = float(df["volume"].iloc[-1])

                # 현재 해당 코인에 대해 열려 있는 bot_vb 포지션 조회
                conn = get_db_connection(db_path)
                open_pos = conn.execute(
                    "SELECT * FROM bot_positions WHERE (bot_id = ? OR bot_id = ?) AND ticker = ? AND status = 'OPEN';",
                    (bot_id, norm_id, ticker),
                ).fetchone()
                conn.close()

                # 2. 보유 중 포지션 관리: ATR 트레일링 스탑 및 3단계 스마트 청산
                if open_pos:
                    pos_id = open_pos["id"]
                    highest_price = max(float(open_pos["highest_price"] or 0.0), current_price)

                    # 최고가 갱신
                    if highest_price > float(open_pos["highest_price"] or 0.0):
                        conn = get_db_connection(db_path)
                        conn.execute("UPDATE bot_positions SET highest_price = ? WHERE id = ?;", (highest_price, pos_id))
                        conn.close()

                    # 스마트 청산(본절 스탑, 시간 제한 청산, 동적 ATR 트레일링 스탑)
                    rvol_val = curr_vol / vol_ma20 if vol_ma20 > 0 else 1.0
                    smart_exit = evaluate_smart_exit(
                        norm_id,
                        dict(open_pos),
                        current_price,
                        atr=atr_val,
                        rvol=rvol_val,
                        is_live=not is_dry_run(),
                    )
                    if smart_exit:
                        logger.info("[%s] Smart Exit on %s: %s", norm_id, ticker, smart_exit["reason"])
                        execute_sell_order(pos_id, reason=smart_exit["reason"], db_path=db_path)
                        continue

                    # 트레일링 스탑 청산 조건: 최고가 - (3 * ATR)
                    trail_stop_price = highest_price - (3.0 * atr_val)
                    if current_price <= trail_stop_price:
                        logger.info(
                            f"[{norm_id}] Trailing Stop triggered on {ticker}: Curr={current_price:,.0f} "
                            f"<= Stop={trail_stop_price:,.0f} (High={highest_price:,.0f}, ATR={atr_val:,.0f})"
                        )
                        execute_sell_order(pos_id, reason="ATR_TRAILING_STOP", db_path=db_path)

                # 3. 신규 진입 검토 (실전 선택+가동 중이고 포지션이 없을 때만 허용)
                elif allow_new_buys and available_krw >= MIN_ORDER_KRW:
                    # 노이즈 비율 기반 동적 K 산출
                    noise = (1.0 - (df["open"] - df["close"]).abs() / (df["high"] - df["low"] + 1e-9)).rolling(20).mean()
                    k = float(noise.iloc[-2]) if not pd.isna(noise.iloc[-2]) else 0.5
                    k = max(0.3, min(0.6, k))

                    prev_high = float(df["high"].iloc[-2])
                    prev_low = float(df["low"].iloc[-2])
                    curr_open = float(df["open"].iloc[-1])
                    breakout_target = curr_open + ((prev_high - prev_low) * k)

                    # 돌파 + 5일선 위 + 20봉 평균 거래량 1.5배 이상
                    is_breakout = current_price >= breakout_target
                    is_above_sma5 = current_price > sma5
                    is_vol_surge = curr_vol >= (vol_ma20 * 1.5)

                    if is_breakout and is_above_sma5 and is_vol_surge:
                        # 윗꼬리 및 이격도 과열 필터 검사
                        wick_ok, wick_reason = check_upper_wick_and_overextension(df, current_price, ma20=sma5)
                        if not wick_ok:
                            logger.info("[%s] Entry blocked on %s: %s", norm_id, ticker, wick_reason)
                            continue

                        logger.info(
                            f"[{norm_id}] Breakout signal on {ticker}: Price={current_price:,.0f} "
                            f">= Target={breakout_target:,.0f}, Vol={curr_vol:.1f} >= 1.5xMA"
                        )
                        # 공통 매수 게이트웨이 검증
                        can_enter, invest_krw, reason = can_enter_position(
                            bot_id, ticker, available_krw, db_path=db_path
                        )
                        if can_enter:
                            execute_buy_order(bot_id, ticker, invest_krw, step_level=1, db_path=db_path)
                            available_krw -= invest_krw
                        else:
                            logger.info("[%s] Entry blocked by gateway for %s: %s", bot_id, ticker, reason)

        except Exception as loop_exc:
            logger.error("[%s] Unexpected error in loop: %s", bot_id, loop_exc, exc_info=True)

        if stop_event.wait(timeout=10):
            break

    logger.info("Bot process [%s] gracefully stopped.", bot_id)


# =====================================================================
# 6. Step 4: 봇 2 (`bot_momentum`) - 볼린저 밴드 스퀴즈 돌파 (VCP)
# =====================================================================

def run_bot_momentum(stop_event, bot_id: str = "bot_03", db_path: Optional[str] = None) -> None:
    """
    [Bot 2] 볼린저 밴드 스퀴즈 돌파 (VCP) 스윙 (자금 비중 40%)
    - 기존 7일 단순 수익률 상위 추격매수 폐기
    - 대상: 24시간 거래대금 100억 이상 원화 마켓 코인 (Rate Limit 0.12s 준수)
    - 진입: 4시간봉 볼린저 밴드(20, 2) 밴드폭 수축 후 상단선 돌파 첫 양봉 코인
    - 분할: 최대 2~3종목 분할 진입 (각 5,000원 이상 보장)
    - 청산: 중심선(20선) 하향 이탈 시 청산
    """
    norm_id = normalize_bot_id(bot_id)
    logger.info("Bot process [%s (norm: %s)] started.", bot_id, norm_id)
    MAX_POSITIONS = 2

    while not stop_event.is_set():
        try:
            conn = get_db_connection(db_path)
            allow_new_buys = True
            if not is_dry_run():
                b_row = conn.execute("SELECT is_selected_for_live, is_running FROM bots WHERE bot_id = ?;", (norm_id,)).fetchone()
                if b_row is not None:
                    b_dict = dict(b_row)
                    allow_new_buys = bool(b_dict.get("is_selected_for_live")) and bool(b_dict.get("is_running"))

            bot_acc = conn.execute("SELECT * FROM bot_accounts WHERE bot_id = ?;", (norm_id,)).fetchone()
            available_krw = float(bot_acc["virtual_krw"]) if bot_acc else 0.0
            open_positions = conn.execute(
                "SELECT * FROM bot_positions WHERE (bot_id = ? OR bot_id = ?) AND status = 'OPEN';",
                (bot_id, norm_id),
            ).fetchall()
            conn.close()

            if not allow_new_buys and len(open_positions) == 0:
                if stop_event.wait(timeout=15):
                    break
                continue

            # 1. 기존 보유 포지션 스마트 청산 및 중심선(20일선) 하향 이탈 청산 체크
            for pos in open_positions:
                pos_id = pos["id"]
                ticker = pos["ticker"]
                current_price = get_safe_current_price(ticker)
                if current_price <= 0:
                    continue

                df = pyupbit.get_ohlcv(ticker, interval="minute240", count=25)
                if df is not None and len(df) >= 20:
                    highest_price = max(float(pos["highest_price"] or 0.0), current_price)
                    if highest_price > float(pos["highest_price"] or 0.0):
                        conn = get_db_connection(db_path)
                        conn.execute("UPDATE bot_positions SET highest_price = ? WHERE id = ?;", (highest_price, pos_id))
                        conn.close()

                    tr = pd.concat([
                        df["high"] - df["low"],
                        (df["high"] - df["close"].shift(1)).abs(),
                        (df["low"] - df["close"].shift(1)).abs()
                    ], axis=1).max(axis=1)
                    atr_val = float(tr.rolling(14).mean().iloc[-1]) if len(tr) >= 14 else 0.0
                    vol_ma20 = float(df["volume"].rolling(20).mean().iloc[-1])
                    curr_vol = float(df["volume"].iloc[-1])
                    rvol_val = curr_vol / vol_ma20 if vol_ma20 > 0 else 1.0

                    smart_exit = evaluate_smart_exit(
                        norm_id,
                        dict(pos),
                        current_price,
                        atr=atr_val,
                        rvol=rvol_val,
                        is_live=not is_dry_run(),
                    )
                    if smart_exit:
                        logger.info("[%s] Smart Exit on %s: %s", norm_id, ticker, smart_exit["reason"])
                        execute_sell_order(pos_id, reason=smart_exit["reason"], db_path=db_path)
                        continue

                    middle_band = float(df["close"].rolling(20).mean().iloc[-1])
                    if current_price < middle_band:
                        logger.info(
                            f"[{bot_id}] Middle band breakdown on {ticker}: Price={current_price:,.0f} "
                            f"< MA20={middle_band:,.0f}. Closing position."
                        )
                        execute_sell_order(pos_id, reason="BB_MIDDLE_BREAKDOWN", db_path=db_path)

            # 2. 신규 진입 슬롯 확인
            open_count = len(open_positions)
            remaining_slots = MAX_POSITIONS - open_count

            if remaining_slots > 0 and available_krw >= MIN_ORDER_KRW:
                # 24시간 거래대금 상위 종목 필터링 (100억 원 이상)
                tickers = pyupbit.get_tickers(fiat="KRW")
                qualifying_candidates = []

                for t in tickers[:25]:  # 상위 후보 탐색
                    if stop_event.is_set():
                        break
                    time.sleep(0.12)  # Rate Limit 준수

                    # 이미 보유 중인 코인 제외
                    if any(p["ticker"] == t for p in open_positions):
                        continue

                    df = pyupbit.get_ohlcv(t, interval="minute240", count=30)
                    if df is None or len(df) < 22:
                        continue

                    # 거래대금 100억 원 체크
                    trade_volume_krw = float((df["close"] * df["volume"]).iloc[-6:].sum())
                    if trade_volume_krw < 10_000_000_000:
                        continue

                    middle, upper, lower, bandwidth = compute_bollinger_bands(df, period=20, num_std=2.0)
                    prev_bw = float(bandwidth.iloc[-2])
                    min_bw_recent = float(bandwidth.iloc[-15:].min())

                    curr_close = float(df["close"].iloc[-1])
                    curr_open = float(df["open"].iloc[-1])
                    upper_val = float(upper.iloc[-1])
                    curr_vol = float(df["volume"].iloc[-1])
                    vol_ma20 = float(df["volume"].rolling(20).mean().iloc[-1])

                    # 수축(Squeeze) 후 첫 양봉 돌파 & 거래량 증가
                    is_squeezed = prev_bw <= (min_bw_recent * 1.35) or prev_bw < 0.12
                    is_bullish = curr_close > curr_open
                    is_breakout = curr_close > upper_val
                    is_volume_up = curr_vol > (vol_ma20 * 1.3)

                    if is_squeezed and is_bullish and is_breakout and is_volume_up:
                        wick_ok, wick_reason = check_upper_wick_and_overextension(df, curr_close, ma20=float(middle.iloc[-1]))
                        if not wick_ok:
                            logger.info("[%s] Breakout filter rejected %s: %s", norm_id, t, wick_reason)
                            continue
                        qualifying_candidates.append(t)
                        if len(qualifying_candidates) >= remaining_slots:
                            break

                # 선별된 종목 매수 실행
                for candidate in qualifying_candidates:
                    slot_budget = available_krw / remaining_slots
                    if slot_budget < MIN_ORDER_KRW:
                        slot_budget = available_krw  # 소액 시 단일 슬롯 몰아주기

                    can_enter, invest_krw, reason = can_enter_position(
                        bot_id, candidate, slot_budget, db_path=db_path
                    )
                    if can_enter:
                        execute_buy_order(bot_id, candidate, invest_krw, step_level=1, db_path=db_path)
                        available_krw -= invest_krw
                        remaining_slots -= 1
                    else:
                        logger.info("[%s] Entry blocked by gateway for %s: %s", bot_id, candidate, reason)

        except Exception as loop_exc:
            logger.error("[%s] Unexpected error in loop: %s", bot_id, loop_exc, exc_info=True)

        if stop_event.wait(timeout=15):
            break

    logger.info("Bot process [%s] gracefully stopped.", bot_id)


# =====================================================================
# 7. Step 4: 봇 3 (`bot_bb`) - 다단계 분할 매수 볼린저 역추세 (DCA / Grid)
# =====================================================================

def run_bot_bb(stop_event, bot_id: str = "bot_05", db_path: Optional[str] = None) -> None:
    """
    [Bot 3] SQLite 원장 기반 다단계 분할 매수 (DCA/역추세) (자금 비중 20%)
    - 기존 -1.5% 기계적 칼손절 폐기
    - 대상: 유동성 풍부 코인 (KRW-BTC, KRW-ETH, KRW-SOL, KRW-XRP)
    - 진입: 15분/30분봉 볼린저 밴드 하단 이탈 + RSI(14) < 30 과매도 1차 진입
    - 분할: -3%, -6% 추가 하락 시 개별 포지션으로 분할 매수(물타기)
    - 익절: 개별 포지션 +1.8% 도달 시 해당 물량만 개별 익절 또는 중심선 도달 시 전량 익절
    - 손절: -5% ~ -7% 극단적 이탈 시 최종 안전 손절
    """
    norm_id = normalize_bot_id(bot_id)
    logger.info("Bot process [%s (norm: %s)] started.", bot_id, norm_id)
    target_tickers = ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP"]

    while not stop_event.is_set():
        try:
            conn = get_db_connection(db_path)
            allow_new_buys = True
            if not is_dry_run():
                b_row = conn.execute("SELECT is_selected_for_live, is_running FROM bots WHERE bot_id = ?;", (norm_id,)).fetchone()
                if b_row is not None:
                    b_dict = dict(b_row)
                    allow_new_buys = bool(b_dict.get("is_selected_for_live")) and bool(b_dict.get("is_running"))

            bot_acc = conn.execute("SELECT * FROM bot_accounts WHERE bot_id = ?;", (norm_id,)).fetchone()
            available_krw = float(bot_acc["virtual_krw"]) if bot_acc else 0.0
            open_positions = conn.execute(
                "SELECT * FROM bot_positions WHERE (bot_id = ? OR bot_id = ?) AND status = 'OPEN';",
                (bot_id, norm_id),
            ).fetchall()
            conn.close()

            if not allow_new_buys and len(open_positions) == 0:
                if stop_event.wait(timeout=15):
                    break
                continue

            # 1. 기존 오픈 포지션별 스마트 청산 / 개별 익절 / 중심선 익절 / 최종 안전 손절 점검
            for pos in open_positions:
                pos_id = pos["id"]
                ticker = pos["ticker"]
                avg_buy_price = float(pos["avg_buy_price"])
                step_level = int(pos["step_level"] or 1)

                current_price = get_safe_current_price(ticker)
                if current_price <= 0:
                    continue

                highest_price = max(float(pos["highest_price"] or 0.0), current_price)
                if highest_price > float(pos["highest_price"] or 0.0):
                    conn = get_db_connection(db_path)
                    conn.execute("UPDATE bot_positions SET highest_price = ? WHERE id = ?;", (highest_price, pos_id))
                    conn.close()

                df = pyupbit.get_ohlcv(ticker, interval="minute30", count=25)
                atr_val = 0.0
                rvol_val = 1.0
                middle_band = None
                if df is not None and len(df) >= 20:
                    tr = pd.concat([
                        df["high"] - df["low"],
                        (df["high"] - df["close"].shift(1)).abs(),
                        (df["low"] - df["close"].shift(1)).abs()
                    ], axis=1).max(axis=1)
                    atr_val = float(tr.rolling(14).mean().iloc[-1]) if len(tr) >= 14 else 0.0
                    vol_ma20 = float(df["volume"].rolling(20).mean().iloc[-1])
                    curr_vol = float(df["volume"].iloc[-1])
                    rvol_val = curr_vol / vol_ma20 if vol_ma20 > 0 else 1.0
                    middle_band = float(df["close"].rolling(20).mean().iloc[-1])

                # 스마트 청산(본절 스탑, 시간 제한 청산, 동적 ATR 트레일링 스탑)
                smart_exit = evaluate_smart_exit(
                    norm_id,
                    dict(pos),
                    current_price,
                    atr=atr_val,
                    rvol=rvol_val,
                    is_live=not is_dry_run(),
                )
                if smart_exit:
                    logger.info("[%s] Smart Exit on %s: %s", norm_id, ticker, smart_exit["reason"])
                    execute_sell_order(pos_id, reason=smart_exit["reason"], db_path=db_path)
                    continue

                pnl_ratio = (current_price - avg_buy_price) / avg_buy_price

                # A. 개별 포지션 +1.8% 익절
                if pnl_ratio >= 0.018:
                    logger.info(
                        "[%s] Individual Take Profit reached on pos %d (%s): +%.2f%%",
                        bot_id,
                        pos_id,
                        ticker,
                        pnl_ratio * 100.0,
                    )
                    execute_sell_order(pos_id, reason="DCA_INDIVIDUAL_TP", db_path=db_path)
                    continue

                # B. 중심선(20선) 평균회귀 익절
                df = pyupbit.get_ohlcv(ticker, interval="minute30", count=25)
                if df is not None and len(df) >= 20:
                    middle_band = float(df["close"].rolling(20).mean().iloc[-1])
                    if current_price >= middle_band and pnl_ratio > 0.005:
                        logger.info(
                            f"[{bot_id}] Mean reversion to middle band on {ticker} (pos {pos_id}): "
                            f"Curr={current_price:,.0f} >= Mid={middle_band:,.0f}"
                        )
                        execute_sell_order(pos_id, reason="MEAN_REVERSION_TP", db_path=db_path)
                        continue

                # C. 최종 안전 손절 (-5% for step 1, -7% for step 3)
                stop_threshold = -0.07 if step_level >= 3 else -0.05
                if pnl_ratio <= stop_threshold:
                    logger.warning(
                        "[%s] Safety Stop Loss triggered on pos %d (%s, step %d): PnL=%.2f%%",
                        bot_id,
                        pos_id,
                        ticker,
                        step_level,
                        pnl_ratio * 100.0,
                    )
                    execute_sell_order(pos_id, reason="SAFETY_STOP_LOSS", db_path=db_path)

            # 2. 신규 1차 진입 또는 추가 다단계 분할 매수(물타기) 점검
            for ticker in target_tickers:
                if stop_event.is_set():
                    break

                current_price = get_safe_current_price(ticker)
                if current_price <= 0:
                    continue

                df = pyupbit.get_ohlcv(ticker, interval="minute30", count=30)
                if df is None or len(df) < 22:
                    continue

                middle, upper, lower, bw = compute_bollinger_bands(df, period=20, num_std=2.0)
                rsi_series = compute_rsi(df, period=14)

                lower_val = float(lower.iloc[-1])
                rsi_val = float(rsi_series.iloc[-1]) if not pd.isna(rsi_series.iloc[-1]) else 50.0

                # 해당 코인의 현재 열린 포지션 목록 조회
                conn = get_db_connection(db_path)
                ticker_positions = conn.execute(
                    "SELECT * FROM bot_positions WHERE bot_id = ? AND ticker = ? AND status = 'OPEN' ORDER BY id ASC;",
                    (bot_id, ticker),
                ).fetchall()
                conn.close()

                # Case A: 1차 신규 진입 (볼린저 하단 이탈 + RSI < 30)
                if len(ticker_positions) == 0 and available_krw >= MIN_ORDER_KRW:
                    if current_price <= lower_val and rsi_val <= 40.0:
                        logger.info(
                            f"[{bot_id}] Oversold dip on {ticker}: Price={current_price:,.0f} "
                            f"<= Lower={lower_val:,.0f}, RSI={rsi_val:.1f}"
                        )
                        # 분할 매수를 위해 가용 잔고의 40% 투입
                        first_entry_budget = available_krw * 0.40
                        can_enter, invest_krw, reason = can_enter_position(
                            bot_id, ticker, first_entry_budget, db_path=db_path
                        )
                        if can_enter:
                            execute_buy_order(bot_id, ticker, invest_krw, step_level=1, db_path=db_path)
                            available_krw -= invest_krw

                # Case B: 추가 분할 매수 (-3% 추가 하락 시 2차 진입, -6% 추가 하락 시 3차 진입)
                elif len(ticker_positions) > 0 and available_krw >= MIN_ORDER_KRW:
                    max_step = max(int(p["step_level"] or 1) for p in ticker_positions)
                    base_buy_price = float(ticker_positions[0]["avg_buy_price"])
                    drop_ratio = (current_price - base_buy_price) / base_buy_price

                    if max_step == 1 and drop_ratio <= -0.03:
                        logger.info("[%s] DCA Step 2 triggered on %s: Drop=%.2f%%", bot_id, ticker, drop_ratio * 100.0)
                        can_enter, invest_krw, reason = can_enter_position(
                            bot_id, ticker, available_krw * 0.50, db_path=db_path
                        )
                        if can_enter:
                            execute_buy_order(bot_id, ticker, invest_krw, step_level=2, db_path=db_path)
                            available_krw -= invest_krw

                    elif max_step == 2 and drop_ratio <= -0.06:
                        logger.info("[%s] DCA Step 3 triggered on %s: Drop=%.2f%%", bot_id, ticker, drop_ratio * 100.0)
                        can_enter, invest_krw, reason = can_enter_position(
                            bot_id, ticker, available_krw, db_path=db_path
                        )
                        if can_enter:
                            execute_buy_order(bot_id, ticker, invest_krw, step_level=3, db_path=db_path)
                            available_krw -= invest_krw

        except Exception as loop_exc:
            logger.error("[%s] Unexpected error in loop: %s", bot_id, loop_exc, exc_info=True)

        if stop_event.wait(timeout=10):
            break

    logger.info("Bot process [%s] gracefully stopped.", bot_id)


# =====================================================================
# 8. Step 5: 봇 10 (`bot_10`) - 잭 켈로그(Jack Kellogg) 프라이스 액션
#    VWAP & 20봉 선형 회귀 채널(LRC ±2σ) 돌파/반등 2분할 매매
# =====================================================================

from agentBot.bot_10_jack_kellogg import (
    calculate_kellogg_indicators,
    compute_linear_regression_channel,
    compute_vwap,
    evaluate_jack_kellogg_strategy,
    run_bot_jack_kellogg,
)

# 10대 알고리즘 및 레거시 봇 통합 러너 레지스트리
BOT_RUNNERS: Dict[str, Any] = {
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
    # 하위 호환 별칭
    "bot_vb": run_bot_vb,
    "bot_momentum": run_bot_momentum,
    "bot_bb": run_bot_bb,
    "bot_kellogg": run_bot_jack_kellogg,
    "bot_jack_kellogg": run_bot_jack_kellogg,
}

