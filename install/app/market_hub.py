"""
market_hub.py - Centralized In-Memory Market Data & Rate-Limit Shield for Upbit
- 실시간 시세(ticker) 및 캔들(OHLCV) 인메모리 캐시 공유
- 업비트 Open API HTTP 429 (Too Many Requests) 방지를 위한 최소 120ms 딜레이 강제 및 스레드 락 보호
- 멀티 봇(10개 가상 봇 / 1~3개 실전 봇) 동시 실행 시 중복 API 호출을 방지하고 캐시 우선 반환
"""

import logging
import os
import threading
import time
from typing import Any, Dict, List, Optional
import pandas as pd
import pyupbit
import requests

logger = logging.getLogger("market_hub")

_LOCK = threading.Lock()
_LAST_API_CALL_TS = 0.0
_MIN_API_INTERVAL = 0.12  # 120ms 최소 인터벌

# 캐시 저장소 (TTL 기반)
_PRICE_CACHE: Dict[str, Dict[str, Any]] = {}
_PRICE_TTL_SEC = 3.0

_OHLCV_CACHE: Dict[str, Dict[str, Any]] = {}
_OHLCV_TTL_SEC = 10.0


def _throttle():
    """연속 API 호출 시 120ms 보호 딜레이 준수"""
    global _LAST_API_CALL_TS
    with _LOCK:
        now = time.time()
        elapsed = now - _LAST_API_CALL_TS
        if elapsed < _MIN_API_INTERVAL:
            time.sleep(_MIN_API_INTERVAL - elapsed)
        _LAST_API_CALL_TS = time.time()


def get_cached_current_price(ticker: str) -> float:
    """
    캐시된 현재가를 반환합니다. 캐시 만료 시에만 업비트 API를 호출하여 갱신합니다.
    """
    now = time.time()
    cached = _PRICE_CACHE.get(ticker)
    if cached and (now - cached["ts"] < _PRICE_TTL_SEC):
        return cached["price"]

    _throttle()
    price = 0.0
    try:
        raw = pyupbit.get_current_price(ticker)
        if raw and float(raw) > 0:
            price = float(raw)
    except Exception:
        pass

    if price <= 0.0:
        try:
            resp = requests.get(
                f"https://api.upbit.com/v1/ticker?markets={ticker}",
                timeout=4.0,
            )
            if resp.status_code == 200:
                data = resp.json()
                if data and "trade_price" in data[0]:
                    price = float(data[0]["trade_price"])
        except Exception as exc:
            logger.debug("MarketHub price fetch error for %s: %s", ticker, exc)

    if price > 0.0:
        _PRICE_CACHE[ticker] = {"price": price, "ts": now}
        return price

    # 실패 시 이전 캐시라도 있으면 반환
    return cached["price"] if cached else 0.0


def get_cached_ohlcv(
    ticker: str, interval: str = "minute240", count: int = 50
) -> Optional[pd.DataFrame]:
    """
    캔들 데이터(OHLCV)를 캐시하여 반환합니다. (TTL: 10초)
    """
    now = time.time()
    key = f"{ticker}:{interval}:{count}"
    cached = _OHLCV_CACHE.get(key)
    if cached and (now - cached["ts"] < _OHLCV_TTL_SEC):
        return cached["df"].copy()

    _throttle()
    try:
        df = pyupbit.get_ohlcv(ticker, interval=interval, count=count)
        if df is not None and not df.empty:
            _OHLCV_CACHE[key] = {"df": df.copy(), "ts": now}
            return df
    except Exception as exc:
        logger.debug("MarketHub OHLCV fetch error for %s (%s): %s", ticker, interval, exc)

    return cached["df"].copy() if cached else None


def get_cached_tickers(fiat: str = "KRW") -> List[str]:
    """
    KRW 마켓 티커 목록 캐시
    """
    key = f"tickers:{fiat}"
    now = time.time()
    cached = _PRICE_CACHE.get(key)
    if cached and (now - cached["ts"] < 300.0):  # 5분 캐시
        return cached["tickers"]

    _throttle()
    try:
        tickers = pyupbit.get_tickers(fiat=fiat)
        if tickers:
            _PRICE_CACHE[key] = {"tickers": tickers, "ts": now}
            return tickers
    except Exception:
        pass
    return cached["tickers"] if cached else ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP"]
