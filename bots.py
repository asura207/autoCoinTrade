"""
bots.py - 3개 트레이딩 봇 매매 전략 및 공통 리스크 게이트웨이 / 주문 유틸리티
- Step 3: 공통 can_enter_position() 게이트웨이 및 슬리피지 방어형 주문 래퍼
- Step 4:
  1) bot_vb (40%): 슈퍼트렌드/동적 변동성 돌파 + ATR 트레일링 스탑 (09:00 강제청산 폐기)
  2) bot_momentum (40%): 볼린저 밴드 스퀴즈 돌파 (VCP) (7일 추격매수 폐기)
  3) bot_bb (20%): SQLite 원장 기반 다단계 분할 매수(DCA/역추세) (-1.5% 칼손절 폐기)
- DRY_RUN 모드 지원: 실제 API 주문 없이 실시간 호가/시세 기반 가상 원장 체결 및 검증
"""

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

from init_db import DEFAULT_DB_PATH, get_db_connection

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
    현재가를 안전하게 조회합니다. pyupbit 실패 시 REST API로 폴백합니다.
    """
    try:
        time.sleep(0.08)
        p = pyupbit.get_current_price(ticker)
        if p and float(p) > 0:
            return float(p)
    except Exception:
        pass

    try:
        resp = requests.get(f"https://api.upbit.com/v1/ticker?markets={ticker}", timeout=4.0)
        if resp.status_code == 200:
            data = resp.json()
            if data and "trade_price" in data[0]:
                return float(data[0]["trade_price"])
    except Exception as exc:
        logger.error("Failed to fetch price for %s: %s", ticker, exc)

    return 0.0


# =====================================================================
# 2. Step 3: 공통 매수 게이트웨이 (can_enter_position)
# =====================================================================

def can_enter_position(
    bot_id: str,
    ticker: str,
    available_krw: float,
    db_path: Optional[str] = None,
) -> Tuple[bool, float, str]:
    """
    3개 봇이 매수 직전에 통과해야 하는 공통 리스크 체크 및 투입 금액 계산 게이트웨이:
    1. market_regime_filter 상태 체크:
       - risk_alert == 1
       - recommended_action in ('HALT_NEW_BUYS', 'EMERGENCY_CLOSE_ALL')
       - bot_overrides[bot_id] == 'BLOCK'
       - ticker in blacklist_tickers
       위 조건 중 하나라도 해당 시 (False, 0.0, "LLM Filter Blocked")
    2. 기술적 대장주 필터 (하락장 방어):
       - KRW-BTC 현재가가 일봉 20MA 아래면 신규 매수를 보수적으로 제한/차단
    3. 투입 금액 산출:
       - invest_krw = available_krw * position_size_multiplier * (1 - 0.0005)
    4. 최소 주문 금액(5,000원) 검증:
       - invest_krw < 5000 이더라도 가용액 원금이 5000원 이상이면 5,050원으로 보정
       - 가용액 자체가 부족하면 Insufficient KRW 거부
    """
    conn = get_db_connection(db_path)
    try:
        # 1. LLM 필터 테이블 조회
        filter_row = conn.execute("SELECT * FROM market_regime_filter WHERE id = 1;").fetchone()
        if not filter_row:
            return False, 0.0, "market_regime_filter table row id=1 not found"

        # 듀얼 AI 최종 교차 검증 값 우선 참조 (하위 호환성 완벽 유지)
        if "final_risk_alert" in filter_row and filter_row["final_risk_alert"] is not None:
            risk_alert = bool(filter_row["final_risk_alert"])
        else:
            risk_alert = bool(filter_row["risk_alert"])

        rec_action = str(filter_row["recommended_action"]).upper()

        if "final_position_multiplier" in filter_row and filter_row["final_position_multiplier"] is not None:
            multiplier = float(filter_row["final_position_multiplier"])
        else:
            multiplier = float(filter_row["position_size_multiplier"] or 1.0)

        overrides_raw = filter_row.get("final_bot_overrides_json") or filter_row.get("bot_overrides_json") or "{}"
        bot_overrides = json.loads(overrides_raw)
        blacklist = json.loads(filter_row.get("blacklist_tickers_json") or "[]")

        # 1-1. 위험 경보 활성화
        if risk_alert:
            return False, 0.0, f"LLM Filter Blocked: Risk alert is active ({filter_row['reason']})"

        # 1-2. 신규 매수 차단 / 전량 청산 권고
        if rec_action in ("HALT_NEW_BUYS", "EMERGENCY_CLOSE_ALL"):
            return False, 0.0, f"LLM Filter Blocked: Recommended action is {rec_action}"

        # 1-3. 봇별 오버라이드 차단
        if bot_overrides.get(bot_id) == "BLOCK":
            return False, 0.0, f"LLM Filter Blocked: Bot override for {bot_id} is BLOCK"

        # 1-4. 블랙리스트 티커
        if ticker in blacklist:
            return False, 0.0, f"LLM Filter Blocked: Ticker {ticker} is in blacklist"

        # 1-5. 포지션 배율이 0.0인 경우
        if multiplier <= 0.0:
            return False, 0.0, "LLM Filter Blocked: Position size multiplier is 0.0"

        # 2. 기술적 대장주 필터 (BTC 일봉 20MA 하락장 방어)
        btc_price = get_safe_current_price("KRW-BTC")
        if btc_price > 0:
            try:
                btc_df = pyupbit.get_ohlcv("KRW-BTC", interval="day", count=25)
                if btc_df is not None and len(btc_df) >= 20:
                    btc_ma20 = float(btc_df["close"].rolling(20).mean().iloc[-1])
                    if btc_price < btc_ma20:
                        # BTC가 일봉 20선 아래이면 알트코인 매수를 추가 감축(0.5)하거나 하락장 경계 적용
                        multiplier = min(multiplier, 0.5)
                        if rec_action == "REDUCE_SIZE" and ticker != "KRW-BTC":
                            logger.info("[%s] BTC below 20MA in BEAR/REDUCE_SIZE. Multiplier reduced to %.2f for %s", bot_id, multiplier, ticker)
            except Exception as btc_err:
                logger.debug("BTC MA check minor error: %s", btc_err)

        # 3. 투입 금액 산출 (수수료 0.05% 완충)
        fee_buffer = 1.0 - UPBIT_FEE_RATE
        raw_available_buffered = available_krw * fee_buffer
        invest_krw = raw_available_buffered * multiplier

        # 4. 최소 주문 금액 검증 (안전 버퍼 6,500원 적용, 가용 잔고 허용 시 보정)
        if invest_krw < SAFE_MIN_ORDER_KRW:
            if raw_available_buffered >= SAFE_MIN_ORDER_KRW and multiplier > 0:
                invest_krw = min(raw_available_buffered, SAFE_MIN_ORDER_KRW)
            elif raw_available_buffered >= MIN_ORDER_KRW and multiplier > 0:
                invest_krw = min(raw_available_buffered, 5050.0)
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
    - LIVE 모드: 업비트 시장가 매수 주문 (지수 백오프 적용)
    - bot_accounts의 virtual_krw 차감 및 bot_positions 행 추가
    """
    conn = get_db_connection(db_path)
    dry = is_dry_run()
    upbit = get_upbit_client()

    current_price = get_safe_current_price(ticker)
    if current_price <= 0:
        logger.error("[%s] Cannot execute buy: Invalid price for %s", bot_id, ticker)
        conn.close()
        return None

    buy_fee = invest_krw * UPBIT_FEE_RATE
    net_invest = invest_krw - buy_fee
    volume = net_invest / current_price
    order_uuid = f"sim-buy-{uuid.uuid4().hex[:12]}"
    executed_price = current_price

    if not dry and upbit:
        res = retry_with_backoff(upbit.buy_market_order, ticker, invest_krw)
        if not res or "uuid" not in res:
            logger.error("[%s] Live market buy order failed for %s", bot_id, ticker)
            conn.close()
            return None
        order_uuid = res["uuid"]
        time.sleep(0.5)
        order_detail = retry_with_backoff(upbit.get_order, order_uuid)
        if order_detail:
            executed_price = float(order_detail.get("price", current_price))
            volume = float(order_detail.get("executed_volume", volume))
            buy_fee = float(order_detail.get("paid_fee", buy_fee))

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
                bot_id,
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
            (invest_krw, bot_id),
        )

        conn.execute("COMMIT;")
        logger.info(
            f"[{bot_id}] BUY Executed ({'DRY_RUN' if dry else 'LIVE'}): {ticker} | "
            f"Amount={invest_krw:,.0f}원 | Price={executed_price:,.0f}원 | Vol={volume:.6f} | UUID={order_uuid}"
        )
        return {
            "bot_id": bot_id,
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

    bot_id = pos["bot_id"]
    ticker = pos["ticker"]
    volume = float(pos["volume"])
    buy_amount = float(pos["buy_amount"])
    avg_buy_price = float(pos["avg_buy_price"])

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
        res = retry_with_backoff(upbit.sell_market_order, ticker, volume)
        if not res or "uuid" not in res:
            logger.error("[%s] Live market sell failed for pos %d (%s, vol=%.6f)", bot_id, position_id, ticker, volume)
            conn.close()
            return None
        sell_order_uuid = res["uuid"]
        time.sleep(0.5)
        order_detail = retry_with_backoff(upbit.get_order, sell_order_uuid)
        if order_detail:
            executed_sell_price = float(order_detail.get("price", current_price))
            volume = float(order_detail.get("executed_volume", volume))
            sell_fee = float(order_detail.get("paid_fee", sell_fee))
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
            (net_sell_amount, realized_pnl, bot_id),
        )

        conn.execute("COMMIT;")
        logger.info(
            f"[{bot_id}] SELL Executed ({'DRY_RUN' if dry else 'LIVE'}, {reason}): {ticker} | "
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

def run_bot_vb(stop_event, bot_id: str = "bot_vb", db_path: Optional[str] = None) -> None:
    """
    [Bot 1] 슈퍼트렌드 / 동적 변동성 돌파 + ATR 트레일링 스탑 (자금 비중 40%)
    - 대상: KRW-BTC, KRW-ETH
    - 기존 09:00 강제 시장가 청산 폐기
    - 진입: 4시간봉 기준 노이즈 비율 목표가 돌파 + 현재가 > 5일선 + 거래량 20봉 평균 1.5배 이상
    - 청산: 보유 중 최고가 대비 3 * ATR(14) 하락 시 트레일링 스탑 청산
    """
    logger.info("Bot process [%s] started.", bot_id)
    target_tickers = ["KRW-BTC", "KRW-ETH"]

    while not stop_event.is_set():
        try:
            conn = get_db_connection(db_path)
            bot_acc = conn.execute("SELECT * FROM bot_accounts WHERE bot_id = ?;", (bot_id,)).fetchone()
            available_krw = float(bot_acc["virtual_krw"]) if bot_acc else 0.0
            conn.close()

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
                    "SELECT * FROM bot_positions WHERE bot_id = ? AND ticker = ? AND status = 'OPEN';",
                    (bot_id, ticker),
                ).fetchone()
                conn.close()

                # 2. 보유 중 포지션 관리: ATR 트레일링 스탑
                if open_pos:
                    pos_id = open_pos["id"]
                    highest_price = max(float(open_pos["highest_price"] or 0.0), current_price)

                    # 최고가 갱신
                    if highest_price > float(open_pos["highest_price"] or 0.0):
                        conn = get_db_connection(db_path)
                        conn.execute("UPDATE bot_positions SET highest_price = ? WHERE id = ?;", (highest_price, pos_id))
                        conn.close()

                    # 트레일링 스탑 청산 조건: 최고가 - (3 * ATR)
                    trail_stop_price = highest_price - (3.0 * atr_val)
                    if current_price <= trail_stop_price:
                        logger.info(
                            f"[{bot_id}] Trailing Stop triggered on {ticker}: Curr={current_price:,.0f} "
                            f"<= Stop={trail_stop_price:,.0f} (High={highest_price:,.0f}, ATR={atr_val:,.0f})"
                        )
                        execute_sell_order(pos_id, reason="ATR_TRAILING_STOP", db_path=db_path)

                # 3. 신규 진입 검토 (포지션이 없을 때)
                elif available_krw >= MIN_ORDER_KRW:
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
                        logger.info(
                            f"[{bot_id}] Breakout signal on {ticker}: Price={current_price:,.0f} "
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

def run_bot_momentum(stop_event, bot_id: str = "bot_momentum", db_path: Optional[str] = None) -> None:
    """
    [Bot 2] 볼린저 밴드 스퀴즈 돌파 (VCP) 스윙 (자금 비중 40%)
    - 기존 7일 단순 수익률 상위 추격매수 폐기
    - 대상: 24시간 거래대금 100억 이상 원화 마켓 코인 (Rate Limit 0.12s 준수)
    - 진입: 4시간봉 볼린저 밴드(20, 2) 밴드폭 수축 후 상단선 돌파 첫 양봉 코인
    - 분할: 최대 2~3종목 분할 진입 (각 5,000원 이상 보장)
    - 청산: 중심선(20선) 하향 이탈 시 청산
    """
    logger.info("Bot process [%s] started.", bot_id)
    MAX_POSITIONS = 2

    while not stop_event.is_set():
        try:
            conn = get_db_connection(db_path)
            bot_acc = conn.execute("SELECT * FROM bot_accounts WHERE bot_id = ?;", (bot_id,)).fetchone()
            available_krw = float(bot_acc["virtual_krw"]) if bot_acc else 0.0
            open_positions = conn.execute(
                "SELECT * FROM bot_positions WHERE bot_id = ? AND status = 'OPEN';",
                (bot_id,),
            ).fetchall()
            conn.close()

            # 1. 기존 보유 포지션 중심선(20일선) 하향 이탈 청산 체크
            for pos in open_positions:
                pos_id = pos["id"]
                ticker = pos["ticker"]
                current_price = get_safe_current_price(ticker)
                if current_price <= 0:
                    continue

                df = pyupbit.get_ohlcv(ticker, interval="minute240", count=25)
                if df is not None and len(df) >= 20:
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

def run_bot_bb(stop_event, bot_id: str = "bot_bb", db_path: Optional[str] = None) -> None:
    """
    [Bot 3] SQLite 원장 기반 다단계 분할 매수 (DCA/역추세) (자금 비중 20%)
    - 기존 -1.5% 기계적 칼손절 폐기
    - 대상: 유동성 풍부 코인 (KRW-BTC, KRW-ETH, KRW-SOL, KRW-XRP)
    - 진입: 15분/30분봉 볼린저 밴드 하단 이탈 + RSI(14) < 30 과매도 1차 진입
    - 분할: -3%, -6% 추가 하락 시 개별 포지션으로 분할 매수(물타기)
    - 익절: 개별 포지션 +1.8% 도달 시 해당 물량만 개별 익절 또는 중심선 도달 시 전량 익절
    - 손절: -5% ~ -7% 극단적 이탈 시 최종 안전 손절
    """
    logger.info("Bot process [%s] started.", bot_id)
    target_tickers = ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP"]

    while not stop_event.is_set():
        try:
            conn = get_db_connection(db_path)
            bot_acc = conn.execute("SELECT * FROM bot_accounts WHERE bot_id = ?;", (bot_id,)).fetchone()
            available_krw = float(bot_acc["virtual_krw"]) if bot_acc else 0.0
            open_positions = conn.execute(
                "SELECT * FROM bot_positions WHERE bot_id = ? AND status = 'OPEN';",
                (bot_id,),
            ).fetchall()
            conn.close()

            # 1. 기존 오픈 포지션별 개별 익절 / 중심선 익절 / 최종 안전 손절 점검
            for pos in open_positions:
                pos_id = pos["id"]
                ticker = pos["ticker"]
                avg_buy_price = float(pos["avg_buy_price"])
                step_level = int(pos["step_level"] or 1)

                current_price = get_safe_current_price(ticker)
                if current_price <= 0:
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
                    if current_price <= lower_val and rsi_val < 30.0:
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
