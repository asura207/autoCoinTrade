"""
llm_filter_worker.py - Dual AI Engine (30m Gemini Flash & 1h Gemini Pro) Market Regime & Sentiment Worker
- 30분 단위 Gemini Flash 빠른 분석: 단기 뉴스(최근 1시간), 호가/차트 변동성, 단기 지표 기반 돌발 악재 신속 감지
- 1시간 단위 Gemini Pro 심층 분석: 거시 경제 흐름, BTC 일봉 20MA/4시간 60MA 체제, 공포·탐욕 지수, 알고리즘 적합성 심층 분석
- 다중 모델 교차 검증 (Decision Synthesis):
  * 보수적 리스크 우선 원칙: Gemini Pro가 HALT_NEW_BUYS 또는 risk_alert 선언 시 무조건 거래 중단 및 신규 매수 차단
  * 단기 쇼크 방어: Pro가 긍정적이더라도 Flash에서 돌발 악재 감지 시 즉시 보수적 세팅(0.5 또는 HALT)으로 덮어씀
  * 두 모델 모두 NORMAL & ALLOW일 때만 100% 비중 정상 거래 허용
- PostgreSQL market_regime_filter (id=1 단일 행) 원자적 갱신
- 지수 백오프(Exponential Backoff) 기반 API 호출 장애 복원력 및 안전한 Fallback 보장
"""

import json
import logging
import os
import random
import re
import time
import urllib.request
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional

import pyupbit
import requests
from dotenv import load_dotenv

from init_db import (
    ALL_BOT_IDS,
    DEFAULT_BOT_OVERRIDES,
    DEFAULT_DB_PATH,
    get_db_connection,
    normalize_bot_overrides,
)
from market_hub import get_cached_ohlcv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("llm_filter_worker")

TREND_BREAKOUT_BOT_IDS = ("bot_01", "bot_02", "bot_03", "bot_04", "bot_07", "bot_09")
MEAN_REVERSION_GRID_BOT_IDS = ("bot_05", "bot_06", "bot_08", "bot_10")

BOT_STRATEGY_PROFILES: Dict[str, Dict[str, str]] = {
    "bot_01": {"name": "변동성 돌파봇", "group": "추세·돌파", "desc": "래리 윌리엄스 변동성 돌파 (추세장 ALLOW, 횡보/휩소 BLOCK)"},
    "bot_02": {"name": "슈퍼트렌드+ATR봇", "group": "추세·돌파", "desc": "슈퍼트렌드+ATR 추세 추종 (추세장 ALLOW, 횡보/휩소 BLOCK)"},
    "bot_03": {"name": "듀얼 모멘텀봇", "group": "추세·돌파", "desc": "강세 모멘텀 돌파 (추세장 ALLOW, 횡보/휩소 BLOCK)"},
    "bot_04": {"name": "볼린저 스퀴즈 돌파봇", "group": "추세·돌파", "desc": "볼린저 스퀴즈 압축 후 돌파 (추세장 ALLOW, 응축 돌파 시 횡보 조건부 허용 가능)"},
    "bot_05": {"name": "볼린저 역추세봇", "group": "역추세·그리드·눌림목", "desc": "볼린저 하단 과매도 반등 (횡보/단기 반등 ALLOW, 패닉 폭락 시 BLOCK)"},
    "bot_06": {"name": "다단계 분할 그리드봇", "group": "역추세·그리드·눌림목", "desc": "박스권 다단계 분할 그리드 (횡보장 ALLOW, 패닉 급락/쇼크 시 BLOCK)"},
    "bot_07": {"name": "MACD+RSI 추세봇", "group": "추세·돌파", "desc": "MACD+RSI 모멘텀 추세 (추세장 ALLOW, 횡보/휩소 BLOCK)"},
    "bot_08": {"name": "정배열 20일선 눌림목봇", "group": "역추세·그리드·눌림목", "desc": "정배열 20일선 눌림목 매수 (상승/완만한 횡보 반등 ALLOW, 하락 쇼크 시 BLOCK)"},
    "bot_09": {"name": "거래량 폭발 스캘퍼봇", "group": "추세·돌파", "desc": "거래량 폭발 단기 돌파 스캘핑 (추세장 ALLOW, 거래량 급증 시 조건부 허용 가능)"},
    "bot_10": {"name": "잭 켈로그 올라운더봇", "group": "역추세·그리드·눌림목", "desc": "VWAP·회귀 채널 멀티 레짐 올라운더 (추세/횡보 반등 ALLOW, 패닉 쇼크 시 BLOCK)"},
}

# ==============================================================================
# 1. 시스템 프롬프트 정의 (Flash 30분 단기 방패 vs Pro 1시간 거시 장세 스위치)
# ==============================================================================

FLASH_SYSTEM_PROMPT = """당신은 암호화폐 단기 시황 분석 및 리스크 방패 에이전트(Gemini Flash 30m Shield Agent)입니다.
직접 매수/매도 타점을 잡지 마십시오. 지난 30분~1시간 내 뉴스 속보(crypto_news/RSS), 업비트 공지(유의종목/상장폐지/입출금 중단), 단기 급등락 지표를 분석하여 돌발 악재 유무와 단기 변동성을 신속히 판별하십시오.

[핵심 원칙 - 포지션 보호]
- 봇 교체를 지시하거나 보유 포지션을 임의로 시장가 강제 청산하지 마십시오.
- 'BLOCK'은 해당 봇의 [신규 매수 진입]만 일시 보류하며, 이미 보유 중인 물량은 봇 고유의 익절/손절/트레일링 스탑 로직에 의해 정상 감시·청산됩니다.
- 평시에는 거시 추세(Pro 판단)를 존중하되, 해킹·디페깅·전쟁 속보·급격한 패닉 투매·특정 코인 유의종목/상장폐지 감지 시 즉각 risk_alert=true, position_size_multiplier=0.0(또는 0.5), blacklist_tickers 추가 및 돌파형 봇(bot_01,bot_02,bot_03,bot_04,bot_07,bot_09) 즉시 'BLOCK'으로 오버라이드하십시오.

반드시 다른 설명 없이 아래 JSON 스키마 형식으로만 유효한 JSON을 반환하십시오:
{
  "sentiment_score": 0.0,
  "market_regime": "SIDEWAYS",
  "risk_alert": false,
  "recommended_action": "NORMAL",
  "position_size_multiplier": 1.0,
  "bot_overrides": {
    "bot_01": "BLOCK",
    "bot_02": "ALLOW",
    "bot_03": "BLOCK",
    "bot_04": "ALLOW",
    "bot_05": "ALLOW",
    "bot_06": "ALLOW",
    "bot_07": "BLOCK",
    "bot_08": "ALLOW",
    "bot_09": "BLOCK",
    "bot_10": "ALLOW"
  },
  "blacklist_tickers": [],
  "reason": "단기 30분 뉴스·공지·변동성 기반 판단 근거"
}

[필드 및 10대 봇 그룹 규칙]
1. sentiment_score: -1.0(단기 극단적 악재) ~ 1.0(단기 극단적 호재) 실수
2. market_regime: 'BULL', 'BEAR', 'SIDEWAYS', 'HIGH_VOLATILITY_SHOCK' 중 하나
3. risk_alert: 단기 돌발 악재·해킹·디페깅·급락 충격 시 true, 평상시 false
4. recommended_action: 'NORMAL', 'REDUCE_SIZE', 'HALT_NEW_BUYS', 'EMERGENCY_CLOSE_ALL' 중 하나
5. position_size_multiplier: 1.0 (정상), 0.5 (축소), 0.0 (신규 매수 전면 차단) 중 하나
6. bot_overrides: bot_01 ~ bot_10 모두 'ALLOW' 또는 'BLOCK' 명시
   - 추세·돌파·모멘텀 (bot_01, bot_02, bot_03, bot_04, bot_07, bot_09): 단기 휩소/윗꼬리 급락 또는 돌발 악재 시 즉시 'BLOCK' (bot_04, bot_09는 명확한 응축/거래량 돌파 때만 조건부 ALLOW)
   - 역추세·그리드·눌림목 (bot_05, bot_06, bot_08, bot_10): 평온한 횡보/단기 과매도 반등 구간에서는 'ALLOW', 패닉 투매·시스템 쇼크 시 'BLOCK' 및 HALT_NEW_BUYS
7. blacklist_tickers: 유의종목·상장폐지·해킹·개별 악재가 발생한 업비트 마켓 티커 목록 (예: ["KRW-WEMIX"], 없으면 [])
8. reason: 30분간 지표 및 뉴스에 기반한 단기 판단 근거를 한국어로 간결하게 작성
"""

PRO_SYSTEM_PROMPT = """당신은 암호화폐 거시경제 및 심층 퀀트 전략 게이트웨이 에이전트(Gemini Pro 1h Quant Strategist)입니다.
BTC 현재가 대비 일봉 20MA / 4시간봉 60MA 이격도, 공포·탐욕 지수, 최근 4시간 주요 뉴스 맥락, 현재 사용자가 선택한 실전 담당 봇(is_selected_for_live=1)과 보유 오픈 포지션 컨텍스트를 종합 분석하여 장세(market_regime)와 10대 봇(bot_01~bot_10) 각각의 신규 매수 허용 스위치(ALLOW/BLOCK) 및 투입 비중(position_size_multiplier)을 결정하십시오.

[핵심 원칙 - 포지션 보호 및 봇 성격별 스위칭]
- 현재 선택된 실전 봇이나 보유 중인 포지션을 강제 교체/시장가 강제 청산하지 마십시오.
- 'BLOCK' 판정은 오직 해당 봇의 [신규 매수 진입]만 일시 보류하며, 보유 코인의 익절/손절/트레일링 스탑 감시는 계속 동작합니다.
- 상승 추세장(BULL): 추세·돌파·모멘텀 그룹(bot_01, bot_02, bot_03, bot_04, bot_07, bot_09) 'ALLOW' 우선. 역추세/눌림목/올라운더(bot_05, bot_06, bot_08, bot_10)도 추세 내 눌림 여부에 따라 'ALLOW' 가능.
- 박스권 횡보장(SIDEWAYS) 또는 가짜 돌파(Whipsaw) 장세: 추세·돌파 그룹(bot_01, bot_02, bot_03, bot_07 등) 고점 물림 방지를 위해 'BLOCK' (단, 스퀴즈 돌파 bot_04나 거래량 폭발 bot_09는 조건부 'ALLOW' 가능). 역추세·그리드·눌림목 그룹(bot_05, bot_06, bot_08, bot_10)은 'ALLOW'로 유지.
- 급락장(BEAR 급락) / 충격장(HIGH_VOLATILITY_SHOCK) / 거래소 해킹·상폐·매크로 패닉셀: 칼날 잡기 방지를 위해 10대 봇 전체 'BLOCK', risk_alert=true, recommended_action='HALT_NEW_BUYS', position_size_multiplier=0.0 선언.

반드시 다른 설명 없이 아래 JSON 스키마 형식으로만 유효한 JSON을 반환하십시오:
{
  "sentiment_score": 0.0,
  "market_regime": "SIDEWAYS",
  "risk_alert": false,
  "recommended_action": "NORMAL",
  "position_size_multiplier": 1.0,
  "bot_overrides": {
    "bot_01": "BLOCK",
    "bot_02": "ALLOW",
    "bot_03": "BLOCK",
    "bot_04": "ALLOW",
    "bot_05": "ALLOW",
    "bot_06": "ALLOW",
    "bot_07": "BLOCK",
    "bot_08": "ALLOW",
    "bot_09": "BLOCK",
    "bot_10": "ALLOW"
  },
  "blacklist_tickers": [],
  "reason": "단기 횡보 국면으로 추세/돌파형 봇의 가짜 돌파(휩소) 진입을 일시 보류하고 역추세/그리드/눌림목 봇 위주로 신규 진입 허용"
}

[필드 규칙]
1. sentiment_score: -1.0(거시적 비관/침체) ~ 1.0(거시적 낙관/강세) 실수
2. market_regime: 'BULL', 'BEAR', 'SIDEWAYS', 'HIGH_VOLATILITY_SHOCK' 중 하나
3. risk_alert: 거시 금융 위기, 거래소 장애/해킹, 패닉 급락 시 true, 평상시 false
4. recommended_action: 'NORMAL', 'REDUCE_SIZE', 'HALT_NEW_BUYS', 'EMERGENCY_CLOSE_ALL' 중 하나
5. position_size_multiplier: 1.0 (정상), 0.5 (보수적 축소), 0.0 (신규 매수 차단) 중 하나
6. bot_overrides: bot_01 ~ bot_10 모든 키에 'ALLOW' 또는 'BLOCK' 지정
   - 추세·돌파·모멘텀: bot_01(변동성돌파), bot_02(슈퍼트렌드+ATR), bot_03(듀얼모멘텀), bot_04(볼린저스퀴즈), bot_07(MACD+RSI추세), bot_09(거래량폭발스캘퍼)
   - 역추세·그리드·눌림목: bot_05(볼린저역추세), bot_06(다단계분할그리드), bot_08(정배열20일선눌림목), bot_10(잭켈로그VWAP/회귀올라운더)
7. blacklist_tickers: 펀더멘털 훼손/유의/상폐 위험 티커 목록 (없으면 [])
8. reason: 거시 장세 체제와 실전 선택 봇별 적합성 판단 근거를 한국어로 논리적으로 작성
"""

# 모델 후보군 정의 (30분 gemini-1.5-flash / 1시간 gemini-1.5-pro 및 최신 호환 모델 폴백)
FLASH_MODELS = [
    "gemini-1.5-flash",
    "gemini-2.5-flash",
    "gemini-flash-latest",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
]
PRO_MODELS = [
    "gemini-1.5-pro",
    "gemini-2.5-pro",
    "gemini-pro-latest",
    "gemini-3.1-pro-preview",
    "gemini-2.5-flash",
]


# ==============================================================================
# 2. 데이터 수집 헬퍼 함수
# ==============================================================================

def _fetch_btc_4h_60ma() -> Dict[str, Any]:
    """
    BTC 4시간봉 60 이동평균선(60MA)과 이격도를 조회합니다 (market_hub 캐시 우선 + REST API 폴백).
    """
    try:
        df4 = get_cached_ohlcv("KRW-BTC", interval="minute240", count=65)
        if df4 is not None and len(df4) >= 60:
            price_4h = float(df4["close"].iloc[-1])
            ma60_4h = float(df4["close"].rolling(60).mean().iloc[-1])
            disparity_4h_pct = ((price_4h - ma60_4h) / ma60_4h) * 100.0 if ma60_4h > 0 else 0.0
            return {
                "ma60_4h": round(ma60_4h, 1),
                "disparity_4h_pct": round(disparity_4h_pct, 2),
                "is_above_ma60_4h": price_4h >= ma60_4h,
            }
    except Exception as exc:
        logger.debug("pyupbit BTC 4h ohlcv fetch failed: %s", exc)

    try:
        resp = requests.get(
            "https://api.upbit.com/v1/candles/minutes/240?market=KRW-BTC&count=65",
            timeout=5.0,
        )
        if resp.status_code == 200:
            candles = resp.json()
            candles.reverse()
            closes = [float(c["trade_price"]) for c in candles]
            if len(closes) >= 60:
                price_4h = closes[-1]
                ma60_4h = sum(closes[-60:]) / 60.0
                disparity_4h_pct = ((price_4h - ma60_4h) / ma60_4h) * 100.0 if ma60_4h > 0 else 0.0
                return {
                    "ma60_4h": round(ma60_4h, 1),
                    "disparity_4h_pct": round(disparity_4h_pct, 2),
                    "is_above_ma60_4h": price_4h >= ma60_4h,
                }
    except Exception as exc:
        logger.debug("REST BTC 4h ohlcv fetch failed: %s", exc)

    return {"ma60_4h": 0.0, "disparity_4h_pct": 0.0, "is_above_ma60_4h": True}


def _fetch_btc_1h_change_pct() -> float:
    """최근 1시간 BTC 가격 변동률(%)을 계산합니다."""
    try:
        resp = requests.get(
            "https://api.upbit.com/v1/candles/minutes/60?market=KRW-BTC&count=2",
            timeout=4.0,
        )
        if resp.status_code == 200:
            candles = resp.json()
            if len(candles) >= 2:
                curr = float(candles[0]["trade_price"])
                prev = float(candles[1]["trade_price"])
                if prev > 0:
                    return round(((curr - prev) / prev) * 100.0, 2)
    except Exception:
        pass
    return 0.0


def fetch_btc_technical_summary() -> Dict[str, Any]:
    """
    pyupbit를 이용해 KRW-BTC 현재가, 24시간/1시간 변동률, 일봉 20MA 및 4시간 60MA 대비 이격도를 계산합니다.
    네트워크 장애 시 업비트 공용 REST API를 통해 폴백합니다.
    """
    ma4h = _fetch_btc_4h_60ma()
    change_rate_1h = _fetch_btc_1h_change_pct()

    try:
        df = get_cached_ohlcv("KRW-BTC", interval="day", count=30)
        if df is not None and len(df) >= 20:
            current_price = float(df["close"].iloc[-1])
            prev_close = float(df["close"].iloc[-2])
            change_rate_24h = ((current_price - prev_close) / prev_close) * 100.0
            ma20 = float(df["close"].rolling(20).mean().iloc[-1])
            disparity_pct = ((current_price - ma20) / ma20) * 100.0
            is_above_ma20 = current_price >= ma20
            return {
                "current_price": current_price,
                "change_rate_24h": round(change_rate_24h, 2),
                "change_rate_1h": change_rate_1h,
                "ma20": round(ma20, 1),
                "disparity_pct": round(disparity_pct, 2),
                "is_above_ma20": is_above_ma20,
                **ma4h,
            }
    except Exception as exc:
        logger.warning("pyupbit BTC ohlcv fetch failed: %s. Trying public API fallback...", exc)

    # REST API 폴백
    try:
        resp = requests.get(
            "https://api.upbit.com/v1/candles/days?market=KRW-BTC&count=25",
            timeout=5.0,
        )
        if resp.status_code == 200:
            candles = resp.json()
            candles.reverse()  # 과거 -> 최신
            closes = [c["trade_price"] for c in candles]
            if len(closes) >= 20:
                current_price = float(closes[-1])
                prev_close = float(closes[-2])
                change_rate_24h = ((current_price - prev_close) / prev_close) * 100.0
                ma20 = sum(closes[-20:]) / 20.0
                disparity_pct = ((current_price - ma20) / ma20) * 100.0
                return {
                    "current_price": current_price,
                    "change_rate_24h": round(change_rate_24h, 2),
                    "change_rate_1h": change_rate_1h,
                    "ma20": round(ma20, 1),
                    "disparity_pct": round(disparity_pct, 2),
                    "is_above_ma20": current_price >= ma20,
                    **ma4h,
                }
    except Exception as exc:
        logger.error("All Upbit BTC technical summary fetches failed: %s", exc)

    return {
        "current_price": 0.0,
        "change_rate_24h": 0.0,
        "change_rate_1h": change_rate_1h,
        "ma20": 0.0,
        "disparity_pct": 0.0,
        "is_above_ma20": True,
        **ma4h,
    }


def fetch_fear_and_greed_index() -> Dict[str, Any]:
    """
    Alternative.me 공포·탐욕 지수를 조회합니다.
    """
    url = "https://api.alternative.me/fng/?limit=1"
    try:
        resp = requests.get(url, timeout=5.0)
        if resp.status_code == 200:
            data = resp.json().get("data", [])
            if data:
                return {
                    "value": data[0].get("value", "N/A"),
                    "classification": data[0].get("value_classification", "N/A"),
                }
    except Exception as exc:
        logger.warning("Failed to fetch Fear & Greed index: %s", exc)

    return {"value": "N/A", "classification": "N/A"}


def fetch_crypto_news_rss(limit: int = 15) -> List[str]:
    """
    공개 암호화폐 뉴스 RSS로부터 최신 헤드라인을 최대 limit개 추출합니다.
    Flash(단기)는 5~6건, Pro(심층)는 15건 등 limit으로 조절합니다.
    """
    rss_urls = [
        "https://news.google.com/rss/search?q=crypto+bitcoin+regulation+binance+upbit&hl=en-US&gl=US&ceid=US:en",
        "https://news.google.com/rss/search?q=%EC%97%85%EB%B9%84%ED%8A%B8+%EC%9C%A0%EC%9D%98%EC%A2%85%EB%AA%A9+%EC%83%81%EC%9E%A5%ED%8F%90%EC%A7%80+%ED%95%B4%ED%82%B9&hl=ko&gl=KR&ceid=KR:ko",
        "https://www.tokenpost.kr/rss",
    ]

    headlines = []
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

    for url in rss_urls:
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=6.0) as resp:
                xml_data = resp.read()
            root = ET.fromstring(xml_data)
            for item in root.findall(".//item"):
                title_elem = item.find("title")
                if title_elem is not None and title_elem.text:
                    clean_title = re.sub(r"<[^>]+>", "", title_elem.text).strip()
                    if clean_title and clean_title not in headlines:
                        headlines.append(clean_title)
                if len(headlines) >= limit:
                    break
        except Exception as exc:
            logger.debug("RSS fetch failed for %s: %s", url, exc)

        if len(headlines) >= limit:
            break

    return headlines[:limit]


def fetch_recent_crypto_news(hours: int = 4, limit: int = 15, db_path: Optional[str] = None) -> List[str]:
    """
    DB의 crypto_news(업비트 공시/뉴스 수집분 포함)에서 최근 N시간 헤드라인을 우선 조회한 뒤
    RSS 헤드라인과 병합·중복 제거하여 반환합니다.
    """
    collected: List[str] = []
    conn = None
    try:
        conn = get_db_connection(db_path)
        rows = conn.execute(
            "SELECT title, source, sentiment, published_at, created_at FROM crypto_news ORDER BY id DESC LIMIT ?;",
            (max(limit * 2, 20),),
        ).fetchall()
        now_ts = time.time()
        cutoff_sec = max(1800, int(hours) * 3600)
        from datetime import datetime
        for r in rows:
            rd = dict(r)
            title = str(rd.get("title") or "").strip()
            if not title:
                continue
            ts_str = str(rd.get("created_at") or rd.get("published_at") or "").strip()
            within_window = True
            if ts_str:
                try:
                    normalized_ts = ts_str.replace("Z", "+00:00").replace(" ", "T")
                    dt = datetime.fromisoformat(normalized_ts)
                    if (now_ts - dt.timestamp()) > cutoff_sec:
                        within_window = False
                except Exception:
                    within_window = True
            if not within_window:
                continue
            src = str(rd.get("source") or "").strip()
            tag = f"[{src}] " if src else ""
            item = f"{tag}{title}"
            if item not in collected:
                collected.append(item)
            if len(collected) >= limit:
                break
    except Exception as exc:
        logger.debug("DB crypto_news fetch skipped: %s", exc)
    finally:
        if conn is not None:
            conn.close()

    if len(collected) < limit:
        for h in fetch_crypto_news_rss(limit=limit):
            if h not in collected:
                collected.append(h)
            if len(collected) >= limit:
                break
    return collected[:limit]


def fetch_open_positions_tickers(db_path: Optional[str] = None) -> List[str]:
    """
    bot_positions(OPEN) 및 trades(HOLDING) 테이블에서 현재 보유 중인 포지션 티커 목록을 조회합니다.
    """
    conn = get_db_connection(db_path)
    tickers: List[str] = []
    try:
        pos_rows = conn.execute(
            "SELECT DISTINCT market as ticker FROM bot_positions WHERE status = 'OPEN';"
        ).fetchall()
        for r in pos_rows:
            rd = dict(r)
            t = rd.get("ticker")
            if t and t not in tickers:
                tickers.append(str(t))

        trade_rows = conn.execute(
            "SELECT DISTINCT market as ticker FROM trades WHERE status = 'HOLDING';"
        ).fetchall()
        for r in trade_rows:
            rd = dict(r)
            t = rd.get("ticker")
            if t and t not in tickers:
                tickers.append(str(t))
        return tickers
    except Exception as exc:
        logger.warning("Failed to fetch open position tickers: %s", exc)
        return tickers
    finally:
        conn.close()


def fetch_live_context(db_path: Optional[str] = None) -> Dict[str, Any]:
    """
    현재 DB에서 사용자가 선택한 실전 담당 봇(is_selected_for_live = 1) 목록과
    미청산 오픈 포지션(bot_id + market) 상세 컨텍스트를 조회합니다.
    """
    conn = get_db_connection(db_path)
    live_bots: List[Dict[str, Any]] = []
    open_positions_detail: List[Dict[str, Any]] = []
    open_tickers: List[str] = []
    try:
        bot_rows = conn.execute(
            """
            SELECT bot_id, name, nickname, strategy_type, is_running, is_selected_for_live,
                   allocated_capital, virtual_krw
            FROM bots
            WHERE is_selected_for_live = 1
               OR bot_id IN (SELECT DISTINCT bot_id FROM bot_positions WHERE status = 'OPEN')
            ORDER BY is_selected_for_live DESC, bot_id ASC;
            """
        ).fetchall()
        for r in bot_rows:
            rd = dict(r)
            b_id = str(rd.get("bot_id") or "")
            profile = BOT_STRATEGY_PROFILES.get(b_id, {})
            alloc_cap = float(rd.get("allocated_capital") or 0.0)
            avail_krw = float(rd.get("virtual_krw") or 0.0)
            used_cap = max(0.0, alloc_cap - avail_krw)
            is_selected = int(rd.get("is_selected_for_live") or 0) == 1
            live_bots.append({
                "bot_id": b_id,
                "name": rd.get("nickname") or rd.get("name") or profile.get("name") or b_id,
                "group": profile.get("group", ""),
                "desc": profile.get("desc") or rd.get("strategy_type") or "",
                "is_running": int(rd.get("is_running") or 0) == 1,
                "is_selected_for_live": is_selected,
                "is_draining": not is_selected,
                "used_capital": used_cap,
            })

        pos_rows = conn.execute(
            """
            SELECT bot_id, COALESCE(NULLIF(market, ''), ticker) AS market, buy_amount, avg_buy_price
            FROM bot_positions
            WHERE status = 'OPEN'
            ORDER BY id DESC;
            """
        ).fetchall()
        seen_pairs = set()
        for r in pos_rows:
            rd = dict(r)
            b_id = str(rd.get("bot_id") or "")
            mkt = str(rd.get("market") or "")
            if mkt and mkt not in open_tickers:
                open_tickers.append(mkt)
            if b_id and mkt:
                seen_pairs.add((b_id, mkt))
                open_positions_detail.append({
                    "bot_id": b_id,
                    "market": mkt,
                    "buy_amount": float(rd.get("buy_amount") or 0.0),
                    "avg_buy_price": float(rd.get("avg_buy_price") or 0.0),
                })

        trade_rows = conn.execute(
            """
            SELECT bot_id, market, buy_amount, buy_price
            FROM trades
            WHERE status = 'HOLDING'
            ORDER BY id DESC;
            """
        ).fetchall()
        for r in trade_rows:
            rd = dict(r)
            b_id = str(rd.get("bot_id") or "")
            mkt = str(rd.get("market") or "")
            if mkt and mkt not in open_tickers:
                open_tickers.append(mkt)
            if b_id and mkt and (b_id, mkt) not in seen_pairs:
                seen_pairs.add((b_id, mkt))
                open_positions_detail.append({
                    "bot_id": b_id,
                    "market": mkt,
                    "buy_amount": float(rd.get("buy_amount") or 0.0),
                    "avg_buy_price": float(rd.get("buy_price") or 0.0),
                })
    except Exception as exc:
        logger.warning("Failed to fetch live bot context: %s", exc)
    finally:
        conn.close()

    return {
        "live_bots": live_bots,
        "open_positions_detail": open_positions_detail,
        "open_tickers": open_tickers,
    }


def make_fallback_regime(btc_summary: Dict[str, Any], label: str = "Fallback") -> Dict[str, Any]:
    """
    API 키가 없거나 장애 발생 시 발동하는 BTC 일봉 20MA 기반 기계적 룰베이스 폴백 로직
    - BTC가 일봉 20MA 상단: 10대 봇 전체 ALLOW, position_size_multiplier = 1.0 (정상 운용)
    - BTC가 일봉 20MA 하단: 추세/돌파 봇(bot_01,02,03,04,07,09) BLOCK, 역추세/그리드(bot_05,06,08,10) ALLOW, 비중 0.5
    """
    is_above = bool(btc_summary.get("is_above_ma20", True))
    multiplier = 1.0 if is_above else 0.5
    regime = "BULL" if is_above else "BEAR"
    disparity = btc_summary.get("disparity_pct", 0.0)

    if is_above:
        bot_overrides = {bot_id: "ALLOW" for bot_id in ALL_BOT_IDS}
        reason = f"{label}: BTC가 일봉 20MA 상단(이격도: {disparity}%) -> 10대 봇 전체 신규 매수 허용(1.0x)"
    else:
        bot_overrides = {
            bot_id: ("BLOCK" if bot_id in TREND_BREAKOUT_BOT_IDS else "ALLOW")
            for bot_id in ALL_BOT_IDS
        }
        reason = (
            f"{label}: BTC가 일봉 20MA 하단(이격도: {disparity}%) -> 추세·돌파 봇(bot_01,02,03,04,07,09) 신규 진입 차단, "
            "역추세·그리드·눌림목 봇(bot_05,06,08,10) 0.5x 보수적 허용"
        )

    return {
        "sentiment_score": 0.2 if is_above else -0.3,
        "market_regime": regime,
        "risk_alert": False,
        "recommended_action": "NORMAL" if is_above else "REDUCE_SIZE",
        "position_size_multiplier": multiplier,
        "bot_overrides": bot_overrides,
        "blacklist_tickers": [],
        "reason": reason,
    }


# ==============================================================================
# 3. LLM API 호출 및 지수 백오프(Exponential Backoff: 1초, 2초, 4초) 로직
# ==============================================================================

def call_gemini_api_with_retry(
    system_prompt: str,
    user_prompt: str,
    candidate_models: List[str],
    gemini_key: str,
    max_retries: int = 4,
) -> Optional[str]:
    """
    Gemini API를 지수 백오프(1초 -> 2초 -> 4초)와 함께 호출합니다.
    429, 503, 타임아웃 등 일시적 장애 시 대기 시간을 늘려가며 재시도합니다.
    """
    backoff_delays = (1.0, 2.0, 4.0)
    for attempt in range(max_retries):
        for model in candidate_models:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={gemini_key}"
            payload = {
                "contents": [
                    {
                        "parts": [
                            {"text": f"{system_prompt}\n\n{user_prompt}"}
                        ]
                    }
                ],
                "generationConfig": {
                    "temperature": 0.2,
                    "responseMimeType": "application/json",
                },
            }
            try:
                resp = requests.post(url, json=payload, timeout=25.0)
                if resp.status_code == 200:
                    result = resp.json()
                    candidates = result.get("candidates", [])
                    if candidates:
                        parts = candidates[0].get("content", {}).get("parts", [])
                        if parts:
                            raw_text = parts[0].get("text", "")
                            if raw_text:
                                logger.info("Gemini API call succeeded with model: %s", model)
                                return raw_text
                elif resp.status_code in (429, 503):
                    logger.warning("Gemini model %s busy/throttled (%s). Attempt %d/%d", model, resp.status_code, attempt + 1, max_retries)
                else:
                    logger.warning("Gemini model %s returned status %s: %s", model, resp.status_code, resp.text[:120])
            except Exception as exc:
                logger.warning("Gemini model %s request exception (attempt %d/%d): %s", model, attempt + 1, max_retries, exc)

        if attempt < max_retries - 1:
            delay = backoff_delays[min(attempt, len(backoff_delays) - 1)]
            logger.info("Waiting %.1f seconds before retrying Gemini API...", delay)
            time.sleep(delay)

    return None


def call_openai_api_with_retry(
    system_prompt: str,
    user_prompt: str,
    model: str,
    openai_key: str,
    max_retries: int = 2,
) -> Optional[str]:
    """
    OpenAI API 폴백 호출 (지수 백오프 적용)
    """
    url = "https://api.openai.com/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {openai_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.2,
    }

    for attempt in range(max_retries):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=25.0)
            if resp.status_code == 200:
                return resp.json()["choices"][0]["message"]["content"]
            logger.warning("OpenAI %s returned status %s: %s", model, resp.status_code, resp.text[:120])
        except Exception as exc:
            logger.warning("OpenAI %s request exception: %s", model, exc)
        if attempt < max_retries - 1:
            time.sleep((2 ** attempt) * 2)

    return None


def _format_live_context_for_prompt(
    open_positions: List[str],
    live_bots: Optional[List[Dict[str, Any]]] = None,
    open_positions_detail: Optional[List[Dict[str, Any]]] = None,
) -> str:
    """실전 선택 봇(is_selected_for_live=1)과 보유 오픈 포지션 정보를 프롬프트 문자열로 포맷합니다."""
    if live_bots:
        bot_lines = []
        for b in live_bots:
            state = "가동중" if b.get("is_running") else "일시정지"
            used = int(b.get("used_capital") or 0)
            bot_lines.append(
                f"   - {b.get('bot_id')} ({b.get('name')}, {b.get('group')}, {state}, 보유평가={used:,}원): {b.get('desc')}"
            )
        bots_block = "\n".join(bot_lines)
    else:
        bots_block = "   - 선택된 실전 봇 정보 없음 (전체 10대 봇 bot_01~bot_10 기준으로 판단)"

    if open_positions_detail:
        pos_lines = [
            f"{p.get('market')}({p.get('bot_id')}, {int(p.get('buy_amount') or 0):,}원)"
            for p in open_positions_detail
        ]
        pos_str = ", ".join(pos_lines)
    elif open_positions:
        pos_str = ", ".join(open_positions)
    else:
        pos_str = "보유 포지션 없음"

    return f"- 현재 사용자 선택 실전 담당 봇(is_selected_for_live=1):\n{bots_block}\n- 현재 보유 오픈 포지션: {pos_str}"


def parse_and_validate_llm_json(raw_text: Optional[str], default_reason: str = "Analysis completed") -> Optional[Dict[str, Any]]:
    """
    LLM 응답 텍스트에서 JSON 블록을 추출하고 표준 10대 봇(bot_01~bot_10) 스키마로 정규화/검증합니다.
    """
    if not raw_text:
        return None

    try:
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw_text.strip(), flags=re.MULTILINE)
        first_brace = cleaned.find("{")
        last_brace = cleaned.rfind("}")
        if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
            cleaned = cleaned[first_brace : last_brace + 1]
        parsed = json.loads(cleaned)

        sentiment_score = float(parsed.get("sentiment_score", 0.0))
        sentiment_score = max(-1.0, min(1.0, sentiment_score))

        regime = str(parsed.get("market_regime", "SIDEWAYS")).upper()
        if regime not in ("BULL", "BEAR", "SIDEWAYS", "HIGH_VOLATILITY_SHOCK"):
            regime = "SIDEWAYS"

        risk_alert = bool(parsed.get("risk_alert", False))

        action = str(parsed.get("recommended_action", "NORMAL")).upper()
        if action not in ("NORMAL", "REDUCE_SIZE", "HALT_NEW_BUYS", "EMERGENCY_CLOSE_ALL"):
            action = "NORMAL"

        multiplier = float(parsed.get("position_size_multiplier", 1.0))
        if multiplier <= 0.0:
            multiplier = 0.0
        elif multiplier < 0.75:
            multiplier = 0.5
        else:
            multiplier = 1.0

        bot_overrides = normalize_bot_overrides(parsed.get("bot_overrides"))
        if risk_alert or action in ("HALT_NEW_BUYS", "EMERGENCY_CLOSE_ALL"):
            bot_overrides = {bot_id: "BLOCK" for bot_id in ALL_BOT_IDS}

        raw_blacklist = parsed.get("blacklist_tickers", [])
        blacklist: List[str] = []
        if isinstance(raw_blacklist, list):
            for item in raw_blacklist:
                t = str(item or "").strip().upper()
                if t:
                    blacklist.append(t if "-" in t else f"KRW-{t}")

        reason = str(parsed.get("reason", default_reason))

        return {
            "sentiment_score": sentiment_score,
            "market_regime": regime,
            "risk_alert": risk_alert,
            "recommended_action": action,
            "position_size_multiplier": multiplier,
            "bot_overrides": bot_overrides,
            "blacklist_tickers": blacklist,
            "reason": reason,
        }
    except Exception as exc:
        logger.error("Failed to parse LLM JSON: %s (Raw: %s)", exc, (raw_text or "")[:200])
        return None


# ==============================================================================
# 4. Flash 30분 빠른 분석 & Pro 1시간 심층 퀀트 분석 개별 실행기
# ==============================================================================

def call_flash_fast_analysis(
    btc_summary: Dict[str, Any],
    news_headlines: List[str],
    open_positions: List[str],
    previous_state: Optional[Dict[str, Any]] = None,
    live_bots: Optional[List[Dict[str, Any]]] = None,
    open_positions_detail: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """
    Gemini Flash(30분 주기): 최근 30분~1시간 뉴스, 업비트 공지, 단기 급등락 지표를 분석해
    돌발 악재 시 즉각 BLOCK / 블랙리스트 오버라이드를 수행합니다.
    """
    gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
    openai_key = os.getenv("OPENAI_API_KEY", "").strip()

    if not gemini_key and not openai_key:
        logger.info("No LLM API keys for Flash analysis. Using fallback rule.")
        return make_fallback_regime(btc_summary, "Flash Fallback")

    live_ctx_text = _format_live_context_for_prompt(open_positions, live_bots, open_positions_detail)
    user_prompt = f"""[Flash 단기 30분 시황·공지·변동성 리포트]
1. 비트코인(BTC) 단기 기술적 지표:
   - 현재가: {btc_summary.get('current_price', 0):,} 원
   - 최근 1시간 변동률: {btc_summary.get('change_rate_1h', 0)}% / 24시간 변동률: {btc_summary.get('change_rate_24h', 0)}%
   - 일봉 20MA 대비 이격도: {btc_summary.get('disparity_pct', 0)}% (20MA {'상회' if btc_summary.get('is_above_ma20') else '하회'})
   - 4시간봉 60MA 대비 이격도: {btc_summary.get('disparity_4h_pct', 0)}% (60MA {'상회' if btc_summary.get('is_above_ma60_4h', True) else '하회'})
2. 실전 봇 & 오픈 포지션 컨텍스트:
{live_ctx_text}
3. 최근 30분~1시간 이내 뉴스·공지 헤드라인:
{chr(10).join(f"- {h}" for h in news_headlines) if news_headlines else '- 최근 특이 속보 없음'}

[판단 지침]
- 단기 돌발 악재(해킹, 디페깅, 전쟁 속보, 패닉 투매, 업비트 유의종목/상장폐지 공시)가 없으면 거시 기조를 유지하되 단기 휩소 위험 봇만 조정하십시오.
- 돌발 악재 감지 시 즉각 risk_alert=true, position_size_multiplier=0.0(또는 0.5), blacklist_tickers 추가 및 돌파형 봇(bot_01,bot_02,bot_03,bot_04,bot_07,bot_09) BLOCK으로 응답하십시오.
- 보유 포지션 강제 청산이 아닌 신규 매수 게이트(bot_01~bot_10)만 JSON으로 반환하십시오."""

    raw_response = None
    if gemini_key:
        raw_response = call_gemini_api_with_retry(
            FLASH_SYSTEM_PROMPT, user_prompt, FLASH_MODELS, gemini_key, max_retries=4
        )

    if not raw_response and openai_key:
        raw_response = call_openai_api_with_retry(
            FLASH_SYSTEM_PROMPT, user_prompt, "gpt-4o-mini", openai_key
        )

    parsed = parse_and_validate_llm_json(raw_response, "Flash 30m fast analysis completed")
    if parsed:
        return parsed

    if previous_state:
        logger.warning("Flash API call failed; keeping previous Flash state.")
        previous_state["bot_overrides"] = normalize_bot_overrides(previous_state.get("bot_overrides"))
        return previous_state

    return make_fallback_regime(btc_summary, "Flash Fallback Rule")


def call_pro_indepth_analysis(
    btc_summary: Dict[str, Any],
    fng: Dict[str, Any],
    news_headlines: List[str],
    open_positions: List[str],
    previous_state: Optional[Dict[str, Any]] = None,
    live_bots: Optional[List[Dict[str, Any]]] = None,
    open_positions_detail: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """
    Gemini Pro(1시간 주기): BTC 일봉 20MA / 4시간 60MA, 공포·탐욕 지수, 최근 4시간 뉴스를 종합 분석해
    장세(market_regime)와 10대 봇(bot_01~bot_10) 각각의 ALLOW/BLOCK 스위치를 결정합니다.
    """
    gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
    openai_key = os.getenv("OPENAI_API_KEY", "").strip()

    if not gemini_key and not openai_key:
        logger.info("No LLM API keys for Pro analysis. Using fallback rule.")
        return make_fallback_regime(btc_summary, "Pro Fallback")

    live_ctx_text = _format_live_context_for_prompt(open_positions, live_bots, open_positions_detail)
    user_prompt = f"""[Pro 심층 1시간 거시 퀀트 데이터 리포트]
1. 비트코인(BTC) 거시 기술 지표:
   - 현재가: {btc_summary.get('current_price', 0):,} 원
   - 24시간 변동률: {btc_summary.get('change_rate_24h', 0)}% (1시간: {btc_summary.get('change_rate_1h', 0)}%)
   - 일봉 20일선(MA20): {btc_summary.get('ma20', 0):,} 원 (이격도: {btc_summary.get('disparity_pct', 0)}%, {'상회' if btc_summary.get('is_above_ma20') else '하회'})
   - 4시간 60이평선(4H 60MA): {btc_summary.get('ma60_4h', 0):,} 원 (이격도: {btc_summary.get('disparity_4h_pct', 0)}%, {'상회' if btc_summary.get('is_above_ma60_4h', True) else '하회'})
2. 암호화폐 공포·탐욕 지수: {fng.get('value')} ({fng.get('classification')})
3. 실전 봇 & 오픈 포지션 컨텍스트:
{live_ctx_text}
4. 최근 4시간 종합 암호화폐 뉴스·공시 헤드라인 (최대 15건):
{chr(10).join(f"- {h}" for h in news_headlines) if news_headlines else '- 최신 뉴스 없음'}

거시 장세(BULL/BEAR/SIDEWAYS/HIGH_VOLATILITY_SHOCK)와 bot_01~bot_10 전략군(추세·돌파 vs 역추세·그리드·눌림목) 각각의 신규 진입 ALLOW/BLOCK 스위치를 JSON으로 출력하십시오."""

    raw_response = None
    if gemini_key:
        raw_response = call_gemini_api_with_retry(
            PRO_SYSTEM_PROMPT, user_prompt, PRO_MODELS, gemini_key, max_retries=4
        )

    if not raw_response and openai_key:
        raw_response = call_openai_api_with_retry(
            PRO_SYSTEM_PROMPT, user_prompt, "gpt-4o", openai_key
        )

    parsed = parse_and_validate_llm_json(raw_response, "Pro 1h in-depth quantitative analysis completed")
    if parsed:
        return parsed

    if previous_state:
        logger.warning("Pro API call failed; keeping previous Pro state.")
        previous_state["bot_overrides"] = normalize_bot_overrides(previous_state.get("bot_overrides"))
        return previous_state

    return make_fallback_regime(btc_summary, "Pro Fallback Rule")


# ==============================================================================
# 5. 다중 모델 교차 검증 기반 거래 여부 최종 판단 합성 (Decision Synthesis)
# ==============================================================================

def synthesize_dual_decisions(
    flash_res: Dict[str, Any],
    pro_res: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Flash(30분 단기 방패)와 Pro(1시간 심층 전략가) 결과를 교차 검증하여
    10대 봇(bot_01~bot_10)의 최종 신규 진입 스위치(final_bot_overrides)를 보수적으로 합성합니다.
    - 두 모델 중 하나라도 특정 봇을 'BLOCK'하거나 risk_alert / HALT_NEW_BUYS 선언 시 보수적 차단 우선 적용.
    - 단, 'BLOCK'은 신규 매수만 보류하며 기존 보유 포지션은 강제 청산하지 않습니다.
    """
    flash_action = str(flash_res.get("recommended_action", "NORMAL")).upper()
    pro_action = str(pro_res.get("recommended_action", "NORMAL")).upper()
    flash_alert = bool(flash_res.get("risk_alert", False))
    pro_alert = bool(pro_res.get("risk_alert", False))

    flash_mult = float(flash_res.get("position_size_multiplier", 1.0))
    pro_mult = float(pro_res.get("position_size_multiplier", 1.0))

    flash_overrides = normalize_bot_overrides(flash_res.get("bot_overrides"))
    pro_overrides = normalize_bot_overrides(pro_res.get("bot_overrides"))

    flash_score = float(flash_res.get("sentiment_score", 0.0))
    pro_score = float(pro_res.get("sentiment_score", 0.0))

    final_bot_overrides: Dict[str, str] = {}

    # 1. 보수적 리스크 최우선 원칙 (Pro 또는 Flash 어느 한쪽이라도 긴급 경보/전면 중단 선언 시 전체 BLOCK)
    if pro_alert or pro_action in ("HALT_NEW_BUYS", "EMERGENCY_CLOSE_ALL"):
        final_risk_alert = True
        final_action = (
            "EMERGENCY_CLOSE_ALL"
            if "EMERGENCY_CLOSE_ALL" in (pro_action, flash_action)
            else "HALT_NEW_BUYS"
        )
        final_multiplier = 0.0
        final_bot_overrides = {bot_id: "BLOCK" for bot_id in ALL_BOT_IDS}
        synthesis_mode = "PRO_RISK_PRIORITY (심층 리스크 최우선 신규 매수 전면 차단)"

    # 2. 단기 쇼크 방어 (Flash가 돌발 악재 / HALT 감지 시 전체 BLOCK 오버라이드)
    elif flash_alert or flash_action in ("HALT_NEW_BUYS", "EMERGENCY_CLOSE_ALL"):
        final_risk_alert = True
        final_action = (
            "EMERGENCY_CLOSE_ALL"
            if flash_action == "EMERGENCY_CLOSE_ALL"
            else "HALT_NEW_BUYS"
        )
        final_multiplier = 0.0
        final_bot_overrides = {bot_id: "BLOCK" for bot_id in ALL_BOT_IDS}
        synthesis_mode = "FLASH_SHOCK_DEFENSE (단기 돌발 충격 감지로 신규 매수 차단)"

    # 3. 비중 축소 / 보수적 교차 검증 운용
    elif (
        flash_action == "REDUCE_SIZE"
        or pro_action == "REDUCE_SIZE"
        or flash_mult <= 0.5
        or pro_mult <= 0.5
        or flash_score <= -0.3
        or pro_score <= -0.3
    ):
        final_risk_alert = False
        final_action = "REDUCE_SIZE"
        final_multiplier = round(max(0.0, min(flash_mult, pro_mult, 0.5)), 2)
        for bot_id in ALL_BOT_IDS:
            if flash_overrides.get(bot_id) == "BLOCK" or pro_overrides.get(bot_id) == "BLOCK":
                final_bot_overrides[bot_id] = "BLOCK"
            else:
                final_bot_overrides[bot_id] = "ALLOW"
        if all(v == "BLOCK" for v in final_bot_overrides.values()):
            final_action = "HALT_NEW_BUYS"
            final_multiplier = 0.0
            synthesis_mode = "CONSERVATIVE_ALL_BOTS_BLOCKED"
        else:
            synthesis_mode = "CONSERVATIVE_REDUCE (보수적 50% 비중 축소 및 선별적 봇 허용)"

    # 4. 두 모델 모두 NORMAL & 개별 봇도 양쪽 모두 ALLOW일 때만 100% 허용
    elif flash_action == "NORMAL" and pro_action == "NORMAL":
        final_risk_alert = False
        final_action = "NORMAL"
        final_multiplier = round(max(0.0, min(flash_mult, pro_mult, 1.0)), 2)
        for bot_id in ALL_BOT_IDS:
            if flash_overrides.get(bot_id) == "ALLOW" and pro_overrides.get(bot_id) == "ALLOW":
                final_bot_overrides[bot_id] = "ALLOW"
            else:
                final_bot_overrides[bot_id] = "BLOCK"
        if all(v == "BLOCK" for v in final_bot_overrides.values()):
            final_action = "HALT_NEW_BUYS"
            final_multiplier = 0.0
            synthesis_mode = "DUAL_ALL_BOTS_BLOCKED"
        else:
            synthesis_mode = "DUAL_NORMAL_ALLOW (양 모델 교차 검증 통과)"

    else:
        final_risk_alert = False
        final_action = "REDUCE_SIZE"
        final_multiplier = 0.5
        for bot_id in ALL_BOT_IDS:
            if flash_overrides.get(bot_id) == "BLOCK" or pro_overrides.get(bot_id) == "BLOCK":
                final_bot_overrides[bot_id] = "BLOCK"
            else:
                final_bot_overrides[bot_id] = "ALLOW"
        synthesis_mode = "CONSERVATIVE_DEFAULT"

    # 합성 감성 점수 (Pro 심층 60% + Flash 단기 40%, 극단치 반영)
    if min(flash_score, pro_score) <= -0.5:
        final_sentiment_score = min(flash_score, pro_score)
    else:
        final_sentiment_score = round(0.4 * flash_score + 0.6 * pro_score, 2)

    # 합성 시장 체제 (HIGH_VOLATILITY_SHOCK 또는 BEAR 우선)
    flash_regime = str(flash_res.get("market_regime", "SIDEWAYS")).upper()
    pro_regime = str(pro_res.get("market_regime", "SIDEWAYS")).upper()
    if "HIGH_VOLATILITY_SHOCK" in (flash_regime, pro_regime):
        final_regime = "HIGH_VOLATILITY_SHOCK"
    elif flash_regime == "BEAR" or pro_regime == "BEAR":
        final_regime = "BEAR"
    elif pro_regime == "BULL" and flash_regime in ("BULL", "SIDEWAYS"):
        final_regime = "BULL"
    else:
        final_regime = "SIDEWAYS"

    # 블랙리스트 티커 합집합
    combined_blacklist = sorted(list(set(
        flash_res.get("blacklist_tickers", []) + pro_res.get("blacklist_tickers", [])
    )))

    # 한국어 상세 종합 사유
    reason_str = (
        f"[듀얼 AI 교차검증: {synthesis_mode}] "
        f"Flash(30분): {flash_action}(점수 {flash_score:+.2f}, '{flash_res.get('reason', '')}') | "
        f"Pro(1시간): {pro_action}(점수 {pro_score:+.2f}, '{pro_res.get('reason', '')}') => "
        f"최종 {final_action} (투자 비중 {final_multiplier:.1f}x)"
    )

    return {
        "sentiment_score": final_sentiment_score,
        "market_regime": final_regime,
        "risk_alert": final_risk_alert,
        "recommended_action": final_action,
        "position_size_multiplier": final_multiplier,
        "bot_overrides": final_bot_overrides,
        "blacklist_tickers": combined_blacklist,
        "reason": reason_str,
        # 모델별 개별 상태 보존
        "flash_sentiment_score": flash_score,
        "flash_recommended_action": flash_action,
        "pro_sentiment_score": pro_score,
        "pro_recommended_action": pro_action,
        "final_risk_alert": 1 if final_risk_alert else 0,
        "final_position_multiplier": final_multiplier,
        "final_bot_overrides": final_bot_overrides,
        "synthesis_mode": synthesis_mode,
    }


def update_market_regime_filter_table(synthesized: Dict[str, Any], db_path: Optional[str] = None) -> None:
    """
    market_regime_filter 테이블(id=1 단일 행)을 원자적으로 갱신합니다.
    기존 컬럼과 신규 확장 컬럼(flash_*, pro_*, final_*)을 모두 저장하여 완벽한 하위 호환성을 제공합니다.
    """
    conn = get_db_connection(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE;")
        conn.execute(
            """
            UPDATE market_regime_filter
            SET sentiment_score = %s,
                market_regime = %s,
                risk_alert = %s,
                recommended_action = %s,
                position_size_multiplier = %s,
                bot_overrides_json = %s,
                blacklist_tickers_json = %s,
                reason = %s,
                updated_at = CURRENT_TIMESTAMP,
                flash_sentiment_score = %s,
                flash_recommended_action = %s,
                flash_updated_at = CURRENT_TIMESTAMP,
                pro_sentiment_score = %s,
                pro_recommended_action = %s,
                pro_updated_at = CURRENT_TIMESTAMP,
                final_risk_alert = %s,
                final_position_multiplier = %s,
                final_bot_overrides_json = %s
            WHERE id = 1;
            """,
            (
                synthesized["sentiment_score"],
                synthesized["market_regime"],
                1 if synthesized["risk_alert"] else 0,
                synthesized["recommended_action"],
                synthesized["position_size_multiplier"],
                json.dumps(synthesized["bot_overrides"], ensure_ascii=False),
                json.dumps(synthesized["blacklist_tickers"], ensure_ascii=False),
                synthesized["reason"],
                synthesized["flash_sentiment_score"],
                synthesized["flash_recommended_action"],
                synthesized["pro_sentiment_score"],
                synthesized["pro_recommended_action"],
                1 if synthesized["final_risk_alert"] else 0,
                synthesized["final_position_multiplier"],
                json.dumps(synthesized["final_bot_overrides"], ensure_ascii=False),
            ),
        )
        conn.execute("COMMIT;")
        logger.info(
            "[Dual AI] market_regime_filter updated: Mode=%s, Action=%s, Mult=%.1f, Alert=%s, Reason=%s",
            synthesized.get("synthesis_mode", "N/A"),
            synthesized["recommended_action"],
            synthesized["position_size_multiplier"],
            synthesized["risk_alert"],
            synthesized["reason"][:120],
        )
    except Exception as exc:
        conn.execute("ROLLBACK;")
        logger.error("Failed to update market_regime_filter table: %s", exc)
        raise
    finally:
        conn.close()


# ==============================================================================
# 6. 메인 워커 프로세스 루프 (30분 Flash & 1시간 Pro 독립 타이머 제어)
# ==============================================================================

def run_llm_sentiment_worker(stop_event, bot_id: str = "bot_llm_filter", db_path: Optional[str] = None) -> None:
    """
    듀얼 AI 워커 메인 프로세스:
    - 30분(1800초) 단위 Gemini Flash 빠른 분석 실행
    - 1시간(3600초) 단위 Gemini Pro 심층 퀀트 분석 실행
    - 단기/심층 분석 결과 교차 검증 및 market_regime_filter 단일 행 상태 갱신
    """
    logger.info("Dual AI Engine Worker [%s] started. Flash=30m(1800s), Pro=1h(3600s).", bot_id)
    flash_interval_sec = int(os.getenv("FLASH_FILTER_INTERVAL_SEC", "1800"))
    pro_interval_sec = int(os.getenv("PRO_FILTER_INTERVAL_SEC", "3600"))

    last_flash_run = 0.0
    last_pro_run = 0.0

    current_flash_result: Optional[Dict[str, Any]] = None
    current_pro_result: Optional[Dict[str, Any]] = None

    # 기존 DB 상태 복원 시도 (sqlite3.Row -> dict 변환으로 .get() 안전 보장)
    try:
        conn = get_db_connection(db_path)
        raw_row = conn.execute("SELECT * FROM market_regime_filter WHERE id = 1;").fetchone()
        conn.close()
        row = dict(raw_row) if raw_row is not None else None
        if row and row.get("flash_recommended_action") and row.get("pro_recommended_action"):
            restored_overrides = normalize_bot_overrides(
                row.get("final_bot_overrides_json") or row.get("bot_overrides_json")
            )
            restored_blacklist = json.loads(row.get("blacklist_tickers_json") or "[]")
            restored_mult = float(
                row.get("final_position_multiplier")
                if row.get("final_position_multiplier") is not None
                else 1.0
            )
            current_flash_result = {
                "sentiment_score": float(row.get("flash_sentiment_score") or 0.0),
                "market_regime": row.get("market_regime") or "SIDEWAYS",
                "risk_alert": bool(row.get("final_risk_alert", 0)),
                "recommended_action": row.get("flash_recommended_action") or "NORMAL",
                "position_size_multiplier": restored_mult,
                "bot_overrides": restored_overrides,
                "blacklist_tickers": restored_blacklist,
                "reason": row.get("reason") or "Restored Flash baseline from DB",
            }
            current_pro_result = {
                "sentiment_score": float(row.get("pro_sentiment_score") or 0.0),
                "market_regime": row.get("market_regime") or "SIDEWAYS",
                "risk_alert": bool(row.get("final_risk_alert", 0)),
                "recommended_action": row.get("pro_recommended_action") or "NORMAL",
                "position_size_multiplier": restored_mult,
                "bot_overrides": restored_overrides,
                "blacklist_tickers": restored_blacklist,
                "reason": row.get("reason") or "Restored Pro baseline from DB",
            }
            logger.info("[%s] Successfully loaded previous Dual AI baseline from DB.", bot_id)
    except Exception as init_err:
        logger.warning("[%s] Could not restore baseline from DB: %s", bot_id, init_err)

    # 기동 직후 초기 분석 즉시 실행 트리거
    need_initial_run = True

    while not stop_event.is_set():
        # Node.js 백엔드 기동 중일 때 듀얼 AI 스케줄러 중복 호출 방지 (백엔드 장애 시 자동 폴백)
        if os.getenv("PYTHON_LLM_COEXIST", "false").strip().lower() != "true":
            import socket
            backend_port = int(os.getenv("BACKEND_PORT", "8001"))
            backend_up = False
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                    sock.settimeout(0.25)
                    backend_up = sock.connect_ex(("127.0.0.1", backend_port)) == 0
            except Exception:
                backend_up = False
            if backend_up:
                if stop_event.wait(timeout=30.0):
                    break
                continue

        now = time.time()
        should_run_flash = need_initial_run or (now - last_flash_run >= flash_interval_sec)
        should_run_pro = need_initial_run or (now - last_pro_run >= pro_interval_sec)

        if should_run_flash or should_run_pro:
            need_initial_run = False
            try:
                btc_summary = fetch_btc_technical_summary()
                live_ctx = fetch_live_context(db_path)
                open_pos = live_ctx.get("open_tickers", [])
                live_bots = live_ctx.get("live_bots", [])
                open_pos_detail = live_ctx.get("open_positions_detail", [])

                # 1. Pro 1시간 심층 퀀트 분석 실행
                if should_run_pro:
                    logger.info("[%s] Starting Gemini Pro 1-Hour In-Depth Quantitative Analysis...", bot_id)
                    fng = fetch_fear_and_greed_index()
                    pro_news = fetch_recent_crypto_news(hours=4, limit=15, db_path=db_path)
                    pro_res = call_pro_indepth_analysis(
                        btc_summary,
                        fng,
                        pro_news,
                        open_pos,
                        current_pro_result,
                        live_bots=live_bots,
                        open_positions_detail=open_pos_detail,
                    )
                    if pro_res:
                        current_pro_result = pro_res
                        last_pro_run = now
                        logger.info(
                            "[%s] Gemini Pro Analysis Complete: Regime=%s, Action=%s, Score=%.2f",
                            bot_id, pro_res["market_regime"], pro_res["recommended_action"], pro_res["sentiment_score"]
                        )

                # 2. Flash 30분 단기 시황 분석 실행
                if should_run_flash:
                    logger.info("[%s] Starting Gemini Flash 30-Minute Fast-Response Analysis...", bot_id)
                    flash_news = fetch_recent_crypto_news(hours=1, limit=8, db_path=db_path)
                    flash_res = call_flash_fast_analysis(
                        btc_summary,
                        flash_news,
                        open_pos,
                        current_flash_result,
                        live_bots=live_bots,
                        open_positions_detail=open_pos_detail,
                    )
                    if flash_res:
                        current_flash_result = flash_res
                        last_flash_run = now
                        logger.info(
                            "[%s] Gemini Flash Analysis Complete: Action=%s, Alert=%s, Score=%.2f",
                            bot_id, flash_res["recommended_action"], flash_res["risk_alert"], flash_res["sentiment_score"]
                        )

                # 3. 폴백 보완
                if current_flash_result is None:
                    current_flash_result = make_fallback_regime(btc_summary, "Flash Fallback Baseline")
                if current_pro_result is None:
                    current_pro_result = make_fallback_regime(btc_summary, "Pro Fallback Baseline")

                # 4. 다중 모델 교차 검증 종합 판단 및 DB 원자적 반영
                synthesized = synthesize_dual_decisions(current_flash_result, current_pro_result)
                update_market_regime_filter_table(synthesized, db_path)

            except Exception as loop_exc:
                logger.error("[%s] Error during dual AI cycle: %s", bot_id, loop_exc, exc_info=True)

        # 10초 주기로 stop_event 확인 및 대기
        if stop_event.wait(timeout=10.0):
            break

    logger.info("Dual AI Engine Worker [%s] gracefully stopped.", bot_id)


if __name__ == "__main__":
    import threading

    logger.info("Running standalone Dual AI Filter Worker test cycle...")
    test_stop = threading.Event()
    btc = fetch_btc_technical_summary()
    fng = fetch_fear_and_greed_index()
    news = fetch_recent_crypto_news(hours=4, limit=8)
    live_ctx = fetch_live_context()
    open_p = live_ctx.get("open_tickers", [])

    print("[1/3] Testing Flash 30m Fast Analysis...")
    flash_out = call_flash_fast_analysis(
        btc,
        news,
        open_p,
        live_bots=live_ctx.get("live_bots"),
        open_positions_detail=live_ctx.get("open_positions_detail"),
    )
    print("Flash Result:", json.dumps(flash_out, indent=2, ensure_ascii=False))

    print("\n[2/3] Testing Pro 1h In-Depth Analysis...")
    pro_out = call_pro_indepth_analysis(
        btc,
        fng,
        news,
        open_p,
        live_bots=live_ctx.get("live_bots"),
        open_positions_detail=live_ctx.get("open_positions_detail"),
    )
    print("Pro Result:", json.dumps(pro_out, indent=2, ensure_ascii=False))

    print("\n[3/3] Testing Cross-Validation Decision Synthesis...")
    synth_out = synthesize_dual_decisions(flash_out, pro_out)
    print("Synthesized Result:", json.dumps(synth_out, indent=2, ensure_ascii=False))

    update_market_regime_filter_table(synth_out)
    print("\nStandalone test cycle successfully finished!")
