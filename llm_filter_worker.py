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

from init_db import DEFAULT_DB_PATH, get_db_connection

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("llm_filter_worker")

# ==============================================================================
# 1. 시스템 프롬프트 정의 (Flash 30분 단기 분석 vs Pro 1시간 심층 퀀트 분석)
# ==============================================================================

FLASH_SYSTEM_PROMPT = """당신은 암호화폐 단기 시황 분석 에이전트(Gemini Flash Fast-Response Agent)입니다.
직접 매수/매도 타점을 잡지 마십시오. 당신의 유일한 임무는 지난 30분간의 지표와 단기 뉴스를 바탕으로 돌발 악재(해킹, 거래소 장애, 긴급 규제, 급락 쇼크, 주요 코인 상장폐지 등) 유무와 단기 투심만 빠르고 경제적으로 분석하여 단기 리스크를 즉각 감지하고 방어하는 것입니다.

반드시 다른 설명 없이 아래의 JSON 스키마 형식으로만 유효한 JSON을 반환해야 합니다:
{
  "sentiment_score": 0.0,
  "market_regime": "SIDEWAYS",
  "risk_alert": false,
  "recommended_action": "NORMAL",
  "position_size_multiplier": 1.0,
  "bot_overrides": {
    "bot_vb": "ALLOW",
    "bot_momentum": "ALLOW",
    "bot_bb": "ALLOW"
  },
  "blacklist_tickers": [],
  "reason": "30분 단기 분석 요약 근거"
}

[필드 규칙]
1. sentiment_score: -1.0(단기 극단적 공포/악재) ~ 1.0(단기 극단적 탐욕/호재) 사이 실수
2. market_regime: 'BULL', 'BEAR', 'SIDEWAYS', 'HIGH_VOLATILITY_SHOCK' 중 하나
3. risk_alert: 단기 돌발 악재나 급락 충격 발생 시 true, 평상시 false
4. recommended_action: 'NORMAL'(정상), 'REDUCE_SIZE'(비중 축소), 'HALT_NEW_BUYS'(신규 매수 차단), 'EMERGENCY_CLOSE_ALL'(전량 긴급 청산) 중 하나
5. position_size_multiplier: 1.0 (정상), 0.5 (주의/축소), 0.0 (매수 차단) 중 하나
6. bot_overrides: 봇별 허용 여부 ('ALLOW' 또는 'BLOCK')
7. blacklist_tickers: 뉴스나 이슈로 단기 급락/악재 위험이 포착된 티커 목록 (예: ["KRW-WEMIX"], 없으면 [])
8. reason: 30분간 지표 및 뉴스에 기반한 단기 판단 근거를 한국어로 명확하고 간결하게 작성
"""

PRO_SYSTEM_PROMPT = """당신은 암호화폐 거시경제 및 심층 퀀트 분석 에이전트(Gemini Pro In-Depth Quantitative Agent)입니다.
거시 지표, 비트코인 일봉 20MA 및 4시간 60MA, 공포·탐욕 지수, 전체 뉴스 맥락, 주요 정책/공시, 암호화폐 전반의 펀더멘털을 종합하여 현재 시장이 거시적 추세장(BULL/BEAR)인지 횡보장(SIDEWAYS)인지 심층 분석하고, 각 퀀트 매매 알고리즘의 진입 허용 여부 및 거시적 리스크를 깊이 있게 평가하십시오.

반드시 다른 설명 없이 아래의 JSON 스키마 형식으로만 유효한 JSON을 반환해야 합니다:
{
  "sentiment_score": 0.0,
  "market_regime": "SIDEWAYS",
  "risk_alert": false,
  "recommended_action": "NORMAL",
  "position_size_multiplier": 1.0,
  "bot_overrides": {
    "bot_vb": "ALLOW",
    "bot_momentum": "ALLOW",
    "bot_bb": "ALLOW"
  },
  "blacklist_tickers": [],
  "reason": "1시간 거시경제 및 심층 퀀트 분석 요약 근거"
}

[필드 규칙]
1. sentiment_score: -1.0(거시적 비관/침체) ~ 1.0(거시적 낙관/강세) 사이 실수
2. market_regime: 'BULL', 'BEAR', 'SIDEWAYS', 'HIGH_VOLATILITY_SHOCK' 중 하나
3. risk_alert: 거시적 금융 위기, 규제 충격, 시스템적 붕괴 조짐 시 true, 평상시 false
4. recommended_action: 'NORMAL'(정상), 'REDUCE_SIZE'(비중 축소), 'HALT_NEW_BUYS'(신규 매수 차단), 'EMERGENCY_CLOSE_ALL'(전량 긴급 청산) 중 하나
5. position_size_multiplier: 1.0 (정상), 0.5 (보수적 운용), 0.0 (매수 차단) 중 하나
6. bot_overrides: 봇별 허용 여부 ('ALLOW' 또는 'BLOCK')
   - bot_vb: 변동성 돌파 (추세장 적합)
   - bot_momentum: 듀얼 모멘텀 (모멘텀장 적합)
   - bot_bb: 볼린저 역추세 (횡보 박스권 적합)
7. blacklist_tickers: 펀더멘털 훼손 코인 티커 목록 (없으면 [])
8. reason: 거시 시장 체제와 알고리즘 적합성을 한국어로 명확하고 논리적으로 작성
"""

# 모델 후보군 정의 (요구 명세 1.5-flash / 1.5-pro 우선 시도 후 최신/경량 모델 자동 폴백)
FLASH_MODELS = [
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.8-flash",
    "gemini-flash-latest",
    "gemini-1.5-flash",
]
PRO_MODELS = [
    "gemini-3.1-pro-preview",
    "gemini-pro-latest",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.8-flash",
    "gemini-1.5-pro",
]


# ==============================================================================
# 2. 데이터 수집 헬퍼 함수
# ==============================================================================

def fetch_btc_technical_summary() -> Dict[str, Any]:
    """
    pyupbit를 이용해 KRW-BTC 현재가, 24시간 변동률, 일봉 20MA 대비 이격도를 계산합니다.
    네트워크 장애 시 업비트 공용 REST API를 통해 폴백합니다.
    """
    try:
        df = pyupbit.get_ohlcv("KRW-BTC", interval="day", count=30)
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
                "ma20": round(ma20, 1),
                "disparity_pct": round(disparity_pct, 2),
                "is_above_ma20": is_above_ma20,
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
                    "ma20": round(ma20, 1),
                    "disparity_pct": round(disparity_pct, 2),
                    "is_above_ma20": current_price >= ma20,
                }
    except Exception as exc:
        logger.error("All Upbit BTC technical summary fetches failed: %s", exc)

    return {
        "current_price": 0.0,
        "change_rate_24h": 0.0,
        "ma20": 0.0,
        "disparity_pct": 0.0,
        "is_above_ma20": True,
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


def fetch_open_positions_tickers(db_path: Optional[str] = None) -> List[str]:
    """
    bot_positions 테이블에서 현재 status='OPEN'인 포지션의 티커 목록을 조회합니다.
    """
    conn = get_db_connection(db_path)
    try:
        rows = conn.execute(
            "SELECT DISTINCT market as ticker FROM bot_positions WHERE status = 'OPEN';"
        ).fetchall()
        return [r["ticker"] for r in rows if "ticker" in r]
    except Exception as exc:
        logger.warning("Failed to fetch open position tickers: %s", exc)
        return []
    finally:
        conn.close()


def make_fallback_regime(btc_summary: Dict[str, Any], label: str = "Fallback") -> Dict[str, Any]:
    """
    API 키가 없거나 장애 발생 시 발동하는 기계적 룰베이스 폴백 로직
    - BTC가 일봉 20MA 아래면 position_size_multiplier = 0.5 (보수적 운용)
    - BTC가 일봉 20MA 위면 position_size_multiplier = 1.0 (정상 운용)
    """
    is_above = btc_summary.get("is_above_ma20", True)
    multiplier = 1.0 if is_above else 0.5
    regime = "BULL" if is_above else "BEAR"
    disparity = btc_summary.get("disparity_pct", 0.0)

    reason = (
        f"{label}: BTC가 일봉 20MA {'상단' if is_above else '하단'}에 위치 (이격도: {disparity}%). "
        f"포지션 배율을 {multiplier}로 설정합니다."
    )

    return {
        "sentiment_score": 0.2 if is_above else -0.3,
        "market_regime": regime,
        "risk_alert": False,
        "recommended_action": "NORMAL" if is_above else "REDUCE_SIZE",
        "position_size_multiplier": multiplier,
        "bot_overrides": {
            "bot_vb": "ALLOW",
            "bot_momentum": "ALLOW" if is_above else "ALLOW",
            "bot_bb": "ALLOW",
        },
        "blacklist_tickers": [],
        "reason": reason,
    }


# ==============================================================================
# 3. LLM API 호출 및 지수 백오프(Exponential Backoff) 로직
# ==============================================================================

def call_gemini_api_with_retry(
    system_prompt: str,
    user_prompt: str,
    candidate_models: List[str],
    gemini_key: str,
    max_retries: int = 3,
) -> Optional[str]:
    """
    Gemini API를 지수 백오프(Exponential Backoff)와 함께 호출합니다.
    503, 429 등 일시적 장애 시 대기 시간을 늘려가며 재시도합니다.
    """
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
            delay = (2 ** attempt) * 2 + random.uniform(0.5, 1.5)
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


def parse_and_validate_llm_json(raw_text: str, default_reason: str = "Analysis completed") -> Optional[Dict[str, Any]]:
    """
    LLM 응답 텍스트에서 JSON 블록을 추출하고 스키마를 정규화하여 검증합니다.
    """
    if not raw_text:
        return None

    try:
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw_text.strip(), flags=re.MULTILINE)
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
        if multiplier not in (0.0, 0.5, 1.0):
            multiplier = 0.5 if multiplier < 0.75 else 1.0

        bot_overrides = parsed.get("bot_overrides", {})
        if not isinstance(bot_overrides, dict):
            bot_overrides = {"bot_vb": "ALLOW", "bot_momentum": "ALLOW", "bot_bb": "ALLOW"}
        for k in ("bot_vb", "bot_momentum", "bot_bb"):
            if bot_overrides.get(k) not in ("ALLOW", "BLOCK"):
                bot_overrides[k] = "ALLOW"

        blacklist = parsed.get("blacklist_tickers", [])
        if not isinstance(blacklist, list):
            blacklist = []

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
        logger.error("Failed to parse LLM JSON: %s (Raw: %s)", exc, raw_text[:200])
        return None


# ==============================================================================
# 4. Flash 30분 빠른 분석 & Pro 1시간 심층 퀀트 분석 개별 실행기
# ==============================================================================

def call_flash_fast_analysis(
    btc_summary: Dict[str, Any],
    news_headlines: List[str],
    open_positions: List[str],
    previous_state: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Gemini Flash(30분 주기): 단기 뉴스, 호가/차트 변동성, 단기 지표를 빠르고 경제적으로 분석
    """
    gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
    openai_key = os.getenv("OPENAI_API_KEY", "").strip()

    if not gemini_key and not openai_key:
        logger.info("No LLM API keys for Flash analysis. Using fallback rule.")
        return make_fallback_regime(btc_summary, "Flash Fallback")

    user_prompt = f"""[Flash 단기 30분 시황 데이터 리포트]
1. 비트코인(BTC) 단기 기술적 지표:
   - 현재가: {btc_summary.get('current_price', 0):,} 원
   - 24시간 변동률: {btc_summary.get('change_rate_24h', 0)}%
   - 일봉 20MA 대비 이격도: {btc_summary.get('disparity_pct', 0)}% (20MA {'상회' if btc_summary.get('is_above_ma20') else '하회'})
2. 현재 시스템 보유 포지션: {open_positions if open_positions else '보유 포지션 없음'}
3. 최근 30분~1시간 이내 단기 뉴스 헤드라인 (최대 6건):
{chr(10).join(f"- {h}" for h in news_headlines) if news_headlines else '- 최근 뉴스 없음'}

단기 돌발 악재(해킹, 급락, 거래소 장애 등) 여부와 단기 투심을 신속히 평가하여 JSON으로 반환하십시오."""

    raw_response = None
    if gemini_key:
        raw_response = call_gemini_api_with_retry(
            FLASH_SYSTEM_PROMPT, user_prompt, FLASH_MODELS, gemini_key, max_retries=3
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
        return previous_state

    return make_fallback_regime(btc_summary, "Flash Fallback Rule")


def call_pro_indepth_analysis(
    btc_summary: Dict[str, Any],
    fng: Dict[str, Any],
    news_headlines: List[str],
    open_positions: List[str],
    previous_state: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Gemini Pro(1시간 주기): 거시 경제 흐름, 주요 공시, 펀더멘털 및 시장 체제(Regime) 심층 분석
    """
    gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
    openai_key = os.getenv("OPENAI_API_KEY", "").strip()

    if not gemini_key and not openai_key:
        logger.info("No LLM API keys for Pro analysis. Using fallback rule.")
        return make_fallback_regime(btc_summary, "Pro Fallback")

    user_prompt = f"""[Pro 심층 1시간 거시 퀀트 데이터 리포트]
1. 비트코인(BTC) 거시 기술 지표:
   - 현재가: {btc_summary.get('current_price', 0):,} 원
   - 24시간 변동률: {btc_summary.get('change_rate_24h', 0)}%
   - 일봉 20일 이동평균선(MA20): {btc_summary.get('ma20', 0):,} 원
   - MA20 대비 이격도: {btc_summary.get('disparity_pct', 0)}% (20MA {'상회' if btc_summary.get('is_above_ma20') else '하회'})
2. 암호화폐 공포·탐욕 지수: {fng.get('value')} ({fng.get('classification')})
3. 현재 시스템 보유 포지션: {open_positions if open_positions else '보유 포지션 없음'}
4. 종합 암호화폐 뉴스 헤드라인 (최대 15건):
{chr(10).join(f"- {h}" for h in news_headlines) if news_headlines else '- 최신 뉴스 없음'}

거시 경제 흐름, 주요 공시, 알고리즘 봇별 적합성을 종합 분석하여 퀀트 가이드라인(JSON)을 출력하십시오."""

    raw_response = None
    if gemini_key:
        raw_response = call_gemini_api_with_retry(
            PRO_SYSTEM_PROMPT, user_prompt, PRO_MODELS, gemini_key, max_retries=3
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
    Flash(30분 빠른 분석)와 Pro(1시간 심층 분석) 결과를 교차 검증하여 최종 거래 여부를 결정합니다.

    [판단 합성 규칙 (절대 준수)]
    1. 보수적 리스크 우선 원칙:
       - Gemini Pro(심층)가 HALT_NEW_BUYS, EMERGENCY_CLOSE_ALL 또는 risk_alert: true를 선언하면,
         Gemini Flash가 아무리 긍정적이어도 무조건 거래 중단 및 신규 매수 차단(multiplier=0.0, BLOCK).
    2. 단기 쇼크 방어:
       - Gemini Pro가 긍정적이더라도, 가장 최근 30분 Gemini Flash에서 치명적 단기 악재를 감지하면
         즉시 보수적 세팅(multiplier=0.5 또는 HALT_NEW_BUYS)으로 덮어씁니다.
    3. 정상 거래 허용:
       - 두 모델 모두 NORMAL 및 ALLOW를 선언했을 때만 100% 비중의 정상 거래(multiplier=1.0)를 허용합니다.
    """
    flash_action = str(flash_res.get("recommended_action", "NORMAL")).upper()
    pro_action = str(pro_res.get("recommended_action", "NORMAL")).upper()
    flash_alert = bool(flash_res.get("risk_alert", False))
    pro_alert = bool(pro_res.get("risk_alert", False))

    flash_mult = float(flash_res.get("position_size_multiplier", 1.0))
    pro_mult = float(pro_res.get("position_size_multiplier", 1.0))

    flash_overrides = flash_res.get("bot_overrides", {}) or {}
    pro_overrides = pro_res.get("bot_overrides", {}) or {}

    flash_score = float(flash_res.get("sentiment_score", 0.0))
    pro_score = float(pro_res.get("sentiment_score", 0.0))

    final_bot_overrides: Dict[str, str] = {}

    # 1. 보수적 리스크 우선 원칙
    if pro_alert or pro_action in ("HALT_NEW_BUYS", "EMERGENCY_CLOSE_ALL"):
        final_risk_alert = True
        final_action = pro_action if pro_action in ("HALT_NEW_BUYS", "EMERGENCY_CLOSE_ALL") else "HALT_NEW_BUYS"
        final_multiplier = 0.0
        final_bot_overrides = {"bot_vb": "BLOCK", "bot_momentum": "BLOCK", "bot_bb": "BLOCK"}
        synthesis_mode = "PRO_RISK_PRIORITY (심층 리스크 최우선 신규 매수 전면 차단)"

    # 2. 단기 쇼크 방어
    elif flash_alert or flash_action in ("HALT_NEW_BUYS", "EMERGENCY_CLOSE_ALL"):
        final_risk_alert = True
        final_action = flash_action if flash_action in ("HALT_NEW_BUYS", "EMERGENCY_CLOSE_ALL") else "HALT_NEW_BUYS"
        final_multiplier = 0.0
        final_bot_overrides = {"bot_vb": "BLOCK", "bot_momentum": "BLOCK", "bot_bb": "BLOCK"}
        synthesis_mode = "FLASH_SHOCK_DEFENSE (단기 돌발 충격 감지로 신규 매수 차단)"

    # 3. 비중 축소 / 주의 운용
    elif flash_action == "REDUCE_SIZE" or pro_action == "REDUCE_SIZE" or flash_mult <= 0.5 or pro_mult <= 0.5 or flash_score <= -0.3 or pro_score <= -0.3:
        final_risk_alert = False
        final_action = "REDUCE_SIZE"
        final_multiplier = min(flash_mult, pro_mult, 0.5)
        for bot_id in ("bot_vb", "bot_momentum", "bot_bb"):
            if flash_overrides.get(bot_id) == "BLOCK" or pro_overrides.get(bot_id) == "BLOCK":
                final_bot_overrides[bot_id] = "BLOCK"
            else:
                final_bot_overrides[bot_id] = "ALLOW"
        synthesis_mode = "CONSERVATIVE_REDUCE (보수적 50% 비중 축소 운용)"

    # 4. 두 모델 모두 NORMAL & ALLOW일 때만 100% 정상 거래
    elif flash_action == "NORMAL" and pro_action == "NORMAL":
        final_risk_alert = False
        final_action = "NORMAL"
        final_multiplier = 1.0
        for bot_id in ("bot_vb", "bot_momentum", "bot_bb"):
            if flash_overrides.get(bot_id) == "ALLOW" and pro_overrides.get(bot_id) == "ALLOW":
                final_bot_overrides[bot_id] = "ALLOW"
            else:
                final_bot_overrides[bot_id] = "BLOCK"
        if all(v == "BLOCK" for v in final_bot_overrides.values()):
            final_action = "HALT_NEW_BUYS"
            final_multiplier = 0.0
            synthesis_mode = "DUAL_ALL_BOTS_BLOCKED"
        else:
            synthesis_mode = "DUAL_NORMAL_ALLOW (양 모델 정상 승인 - 100% 정상 거래)"

    else:
        # 안전한 보수적 기본값
        final_risk_alert = False
        final_action = "REDUCE_SIZE"
        final_multiplier = 0.5
        final_bot_overrides = {"bot_vb": "ALLOW", "bot_momentum": "ALLOW", "bot_bb": "ALLOW"}
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

    # 기존 DB 상태 복원 시도
    try:
        conn = get_db_connection(db_path)
        row = conn.execute("SELECT * FROM market_regime_filter WHERE id = 1;").fetchone()
        conn.close()
        if row and row.get("flash_recommended_action") and row.get("pro_recommended_action"):
            current_flash_result = {
                "sentiment_score": float(row.get("flash_sentiment_score") or 0.0),
                "market_regime": row.get("market_regime") or "SIDEWAYS",
                "risk_alert": bool(row.get("final_risk_alert", 0)),
                "recommended_action": row.get("flash_recommended_action") or "NORMAL",
                "position_size_multiplier": float(row.get("final_position_multiplier") or 1.0),
                "bot_overrides": json.loads(row.get("final_bot_overrides_json") or "{}"),
                "blacklist_tickers": json.loads(row.get("blacklist_tickers_json") or "[]"),
                "reason": row.get("reason") or "Restored Flash baseline from DB",
            }
            current_pro_result = {
                "sentiment_score": float(row.get("pro_sentiment_score") or 0.0),
                "market_regime": row.get("market_regime") or "SIDEWAYS",
                "risk_alert": bool(row.get("final_risk_alert", 0)),
                "recommended_action": row.get("pro_recommended_action") or "NORMAL",
                "position_size_multiplier": float(row.get("final_position_multiplier") or 1.0),
                "bot_overrides": json.loads(row.get("final_bot_overrides_json") or "{}"),
                "blacklist_tickers": json.loads(row.get("blacklist_tickers_json") or "[]"),
                "reason": row.get("reason") or "Restored Pro baseline from DB",
            }
            logger.info("[%s] Successfully loaded previous Dual AI baseline from DB.", bot_id)
    except Exception as init_err:
        logger.warning("[%s] Could not restore baseline from DB: %s", bot_id, init_err)

    # 기동 직후 초기 분석 즉시 실행 트리거
    need_initial_run = True

    while not stop_event.is_set():
        now = time.time()
        should_run_flash = need_initial_run or (now - last_flash_run >= flash_interval_sec)
        should_run_pro = need_initial_run or (now - last_pro_run >= pro_interval_sec)

        if should_run_flash or should_run_pro:
            need_initial_run = False
            try:
                btc_summary = fetch_btc_technical_summary()
                open_pos = fetch_open_positions_tickers(db_path)

                # 1. Pro 1시간 심층 퀀트 분석 실행
                if should_run_pro:
                    logger.info("[%s] Starting Gemini Pro 1-Hour In-Depth Quantitative Analysis...", bot_id)
                    fng = fetch_fear_and_greed_index()
                    pro_news = fetch_crypto_news_rss(limit=15)
                    pro_res = call_pro_indepth_analysis(btc_summary, fng, pro_news, open_pos, current_pro_result)
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
                    flash_news = fetch_crypto_news_rss(limit=6)
                    flash_res = call_flash_fast_analysis(btc_summary, flash_news, open_pos, current_flash_result)
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
    news = fetch_crypto_news_rss(6)
    open_p = fetch_open_positions_tickers()

    print("[1/3] Testing Flash 30m Fast Analysis...")
    flash_out = call_flash_fast_analysis(btc, news, open_p)
    print("Flash Result:", json.dumps(flash_out, indent=2, ensure_ascii=False))

    print("\n[2/3] Testing Pro 1h In-Depth Analysis...")
    pro_out = call_pro_indepth_analysis(btc, fng, news, open_p)
    print("Pro Result:", json.dumps(pro_out, indent=2, ensure_ascii=False))

    print("\n[3/3] Testing Cross-Validation Decision Synthesis...")
    synth_out = synthesize_dual_decisions(flash_out, pro_out)
    print("Synthesized Result:", json.dumps(synth_out, indent=2, ensure_ascii=False))

    update_market_regime_filter_table(synth_out)
    print("\nStandalone test cycle successfully finished!")
