# [Antigravity-Doc] ============================================================
# [Antigravity-Doc] 파일 역할: Python 독립 워커 전용 중앙 시세/캔들 TTL 캐시 및 업비트 API Rate-Limit(429) 방어 허브
# [Antigravity-Doc] 아키텍처 위치: main_orchestrator.py, bots.py, llm_filter_worker.py, bot_10_jack_kellogg.py 하단의 공용 시세 데이터 레이어
# [Antigravity-Doc] 주요 의존성: pyupbit(1차 조회), requests(업비트 공용 REST 폴백), pandas(OHLCV DataFrame), threading(스레드 락)
# [Antigravity-Doc] 수정 시 주의사항: _MIN_API_INTERVAL(0.12초)을 낮추면 업비트 초당 요청 제한(HTTP 429)에 걸릴 수 있으며, OHLCV 반환 시 캐시 오염 방지를 위해 반드시 .copy()를 유지해야 함
# [Antigravity-Doc] ============================================================
"""
market_hub.py - Python 독립 실행 전용 중앙 시세 캐시 및 Rate-Limit 방어 모듈
- 적용 대상: Python 멀티프로세싱 오케스트레이터(`main_orchestrator.py`) 및 `bots.py` 단독 실행 시 전용
- 아키텍처 구분:
  * 메인 Node.js 백엔드(`backend/node_server.mjs`, `LIVE_EXECUTOR_OWNER=node` 기본)는
    `backend/common/upbit_ws_hub.mjs` (업비트 공식 WebSocket 실시간 멀티플렉서 + REST 자동 폴백)를 사용합니다.
  * 본 모듈(`market_hub.py`)은 Node.js WebSocket 허브와 충돌하지 않는 Python 독립 워커 전용 REST 캐시/스레드 락 모듈입니다.
- 주요 기능:
  * 실시간 시세(ticker) 및 캔들(OHLCV) 인메모리 TTL 캐시 공유
  * 업비트 Open API HTTP 429 (Too Many Requests) 방지를 위한 최소 120ms 딜레이 강제 및 스레드 락 보호
"""

import logging
import os
import threading
import time
from typing import Any, Dict, List, Optional
import pandas as pd
import pyupbit
import requests

# [Antigravity-Doc] 모듈 전용 로거 (시세 조회 실패 등 디버그 로그 기록)
logger = logging.getLogger("market_hub")

# [Antigravity-Doc] _LOCK: 멀티스레드 환경에서 API 호출 간격 제어(_LAST_API_CALL_TS)의 원자성을 보장하는 뮤텍스 락
_LOCK = threading.Lock()
# [Antigravity-Doc] _LAST_API_CALL_TS: 직전 업비트 외부 API 호출 시각 (Unix epoch 초 단위)
_LAST_API_CALL_TS = 0.0
# [Antigravity-Doc] _MIN_API_INTERVAL: 업비트 공용 API Rate-Limit(초당 10회) 초과 방지를 위한 최소 호출 간격 (초 단위, 0.12s ≈ 초당 8.3회)
_MIN_API_INTERVAL = 0.12  # 120ms 최소 인터벌

# [Antigravity-Doc] _PRICE_CACHE / _PRICE_TTL_SEC: 티커별 현재가 및 KRW 마켓 목록 인메모리 캐시 (현재가 TTL 3.0초, 마켓 목록 TTL 300초)
# 캐시 저장소 (TTL 기반)
_PRICE_CACHE: Dict[str, Dict[str, Any]] = {}
_PRICE_TTL_SEC = 3.0

# [Antigravity-Doc] _OHLCV_CACHE / _OHLCV_TTL_SEC: 캔들 DataFrame 인메모리 캐시 (키 형식 "ticker:interval:count", TTL 10.0초)
_OHLCV_CACHE: Dict[str, Dict[str, Any]] = {}
_OHLCV_TTL_SEC = 10.0


# [Antigravity-Doc] 역할: 업비트 API 연속 호출 간 최소 120ms 간격을 강제하는 스레드 안전 스로틀러
# [Antigravity-Doc] 입력/반환: 인자 없음 / 반환값 없음 (내부에서 필요 시 time.sleep 수행 후 _LAST_API_CALL_TS 갱신)
def _throttle():
    """연속 API 호출 시 120ms 보호 딜레이 준수"""
    global _LAST_API_CALL_TS
    with _LOCK:
        now = time.time()
        elapsed = now - _LAST_API_CALL_TS
        if elapsed < _MIN_API_INTERVAL:
            time.sleep(_MIN_API_INTERVAL - elapsed)
        _LAST_API_CALL_TS = time.time()


# [Antigravity-Doc] 역할: 티커의 현재가를 3초 TTL 캐시로 조회하며, 만료 시 pyupbit -> 업비트 공용 REST 순으로 폴백 조회
# [Antigravity-Doc] 입력: ticker(str, 예: "KRW-BTC") | 반환: float (유효 현재가, 모든 조회 실패 시 직전 캐시값 또는 0.0)
def get_cached_current_price(ticker: str) -> float:
    """
    캐시된 현재가를 반환합니다. 캐시 만료 시에만 업비트 API를 호출하여 갱신합니다.
    """
    # [Antigravity-Doc] 1단계: 유효 TTL(3초) 이내의 인메모리 캐시가 존재하면 API 호출 없이 즉시 반환
    now = time.time()
    cached = _PRICE_CACHE.get(ticker)
    if cached and (now - cached["ts"] < _PRICE_TTL_SEC):
        return cached["price"]

    # [Antigravity-Doc] 2단계: Rate-Limit 스로틀링 후 1차로 pyupbit.get_current_price 호출
    _throttle()
    price = 0.0
    try:
        raw = pyupbit.get_current_price(ticker)
        if raw and float(raw) > 0:
            price = float(raw)
    except Exception:
        pass

    # [Antigravity-Doc] 3단계: pyupbit 실패 또는 0 이하 반환 시 업비트 공용 REST(/v1/ticker) 직접 호출로 폴백
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

    # [Antigravity-Doc] 4단계: 정상 가격 획득 시 캐시 갱신 후 반환, 실패 시 만료된 직전 캐시라도 반환하여 일시 장애 흡수
    if price > 0.0:
        _PRICE_CACHE[ticker] = {"price": price, "ts": now}
        return price

    # 실패 시 이전 캐시라도 있으면 반환
    return cached["price"] if cached else 0.0


# [Antigravity-Doc] 역할: 지정 마켓·봉 주기·개수의 OHLCV 캔들 DataFrame을 10초 TTL 캐시로 조회
# [Antigravity-Doc] 입력: ticker(str), interval(str, 기본 "minute240"), count(int, 기본 50)
# [Antigravity-Doc] 반환: Optional[pd.DataFrame] (호출자 변형 방지를 위해 복사본 반환, 조회 실패 시 직전 캐시 복사본 또는 None)
def get_cached_ohlcv(
    ticker: str, interval: str = "minute240", count: int = 50
) -> Optional[pd.DataFrame]:
    """
    캔들 데이터(OHLCV)를 캐시하여 반환합니다. (TTL: 10초)
    """
    # [Antigravity-Doc] 복합 키(ticker:interval:count)로 캐시 히트 여부 확인 후 복사본 반환
    now = time.time()
    key = f"{ticker}:{interval}:{count}"
    cached = _OHLCV_CACHE.get(key)
    if cached and (now - cached["ts"] < _OHLCV_TTL_SEC):
        return cached["df"].copy()

    # [Antigravity-Doc] 캐시 미스/만료 시 스로틀링 후 pyupbit.get_ohlcv로 캔들 수집 및 캐시 저장
    _throttle()
    try:
        df = pyupbit.get_ohlcv(ticker, interval=interval, count=count)
        if df is not None and not df.empty:
            _OHLCV_CACHE[key] = {"df": df.copy(), "ts": now}
            return df
    except Exception as exc:
        logger.debug("MarketHub OHLCV fetch error for %s (%s): %s", ticker, interval, exc)

    return cached["df"].copy() if cached else None


# [Antigravity-Doc] 역할: 업비트 마켓 티커 목록을 5분(300초) TTL 캐시로 조회
# [Antigravity-Doc] 입력: fiat(str, 기준 통화, 기본 "KRW") | 반환: List[str] (실패 시 직전 캐시 또는 주요 4대 코인 기본 목록)
def get_cached_tickers(fiat: str = "KRW") -> List[str]:
    """
    KRW 마켓 티커 목록 캐시
    """
    # [Antigravity-Doc] 5분 TTL 내 캐시 적중 시 즉시 반환, 만료 시 pyupbit.get_tickers 갱신 (실패 시 4대 메이저 코인 폴백)
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
