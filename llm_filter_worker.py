"""
llm_filter_worker.py - LLM 시장 체제 & 뉴스 감성 분석 워커 모듈
- 1~4시간 주기(환경변수 LLM_FILTER_INTERVAL_SEC, 기본 3600초)로 실행
- 기술적 지표(BTC 일봉 20MA 이격도, 24h 변동률) 수집
- 공포·탐욕 지수 (Alternative.me API) 수집
- 암호화폐 뉴스 헤드라인 (RSS) 수집
- SQLite bot_positions 현재 OPEN 포지션 티커 조회
- Gemini / OpenAI API 호출 및 JSON 검증 후 market_regime_filter 테이블(id=1) 업데이트
- API 키 부재 또는 장애 시 자동 폴백(Fallback: BTC가 MA20 아래면 0.5, 위면 1.0)
"""

import json
import logging
import os
import re
import sqlite3
import time
import urllib.request
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional, Tuple

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

SYSTEM_PROMPT = """당신은 암호화폐 현물 자동매매 시스템의 수석 리스크 관리 및 거시 시장 체제 판단 에이전트(Chief Risk Officer)입니다.
직접 매수/매도 타점을 잡지 마십시오. 당신의 유일한 임무는 거시적 시장 충격(해킹, 스테이블코인 디페깅, 거래소 규제/파산, 전쟁, 주요 알트코인 상장폐지 등)과 전체적인 장세(BULL, BEAR, SIDEWAYS, HIGH_VOLATILITY_SHOCK)를 분석하여 트레이딩 봇들의 진입 강도를 제어하는 것입니다.

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
  "reason": "한 줄 요약 근거"
}

[필드 규칙]
1. sentiment_score: -1.0(극단적 공포/악재) ~ 1.0(극단적 탐욕/호재) 사이 실수
2. market_regime: 'BULL', 'BEAR', 'SIDEWAYS', 'HIGH_VOLATILITY_SHOCK' 중 하나
3. risk_alert: 치명적 거시 악재나 급락 충격 발생 시 true, 평상시 false
4. recommended_action: 'NORMAL'(정상), 'REDUCE_SIZE'(비중 축소), 'HALT_NEW_BUYS'(신규 매수 차단), 'EMERGENCY_CLOSE_ALL'(전량 긴급 청산) 중 하나
5. position_size_multiplier: 1.0 (정상), 0.5 (주의/축소), 0.0 (매수 차단) 중 하나
6. bot_overrides: 봇별 허용 여부 ('ALLOW' 또는 'BLOCK')
   - bot_vb: 슈퍼트렌드 변동성 돌파 봇
   - bot_momentum: 볼린저 밴드 스퀴즈 돌파 봇
   - bot_bb: 볼린저 밴드 다단계 역추세 봇
7. blacklist_tickers: 뉴스나 이슈로 급락/악재 위험이 포착된 티커 목록 (예: ["KRW-WEMIX"], 없으면 [])
8. reason: 판단 근거를 한국어로 명확하고 간결하게 작성
"""


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
    공개 암호화폐 뉴스 RSS(Google News crypto 등)로부터 최신 헤드라인을 최대 limit개 추출합니다.
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
            "SELECT DISTINCT ticker FROM bot_positions WHERE status = 'OPEN';"
        ).fetchall()
        return [r["ticker"] for r in rows]
    except Exception as exc:
        logger.warning("Failed to fetch open position tickers: %s", exc)
        return []
    finally:
        conn.close()


def make_fallback_regime(btc_summary: Dict[str, Any]) -> Dict[str, Any]:
    """
    API 키가 없거나 LLM 장애 발생 시 발동하는 룰베이스 폴백 로직
    - BTC가 일봉 20MA 아래면 position_size_multiplier = 0.5 (보수적 운용)
    - BTC가 일봉 20MA 위면 position_size_multiplier = 1.0 (정상 운용)
    """
    is_above = btc_summary.get("is_above_ma20", True)
    multiplier = 1.0 if is_above else 0.5
    regime = "BULL" if is_above else "BEAR"
    disparity = btc_summary.get("disparity_pct", 0.0)

    reason = (
        f"Fallback Rule: BTC가 일봉 20MA {'상단' if is_above else '하단'}에 위치 (이격도: {disparity}%). "
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


def call_llm_filter_api(
    btc_summary: Dict[str, Any],
    fng: Dict[str, Any],
    news_headlines: List[str],
    open_positions: List[str],
) -> Dict[str, Any]:
    """
    Gemini 또는 OpenAI API를 호출하여 시장 체제 및 감성 분석 결과를 반환합니다.
    키가 없거나 호출 실패 시 fallback_regime을 반환합니다.
    """
    gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
    openai_key = os.getenv("OPENAI_API_KEY", "").strip()

    if not gemini_key and not openai_key:
        logger.info("No LLM API keys configured (GEMINI_API_KEY / OPENAI_API_KEY). Using fallback rule.")
        return make_fallback_regime(btc_summary)

    user_prompt = f"""[현재 시장 데이터 취합 리포트]
1. 비트코인(BTC) 기술적 요약:
   - 현재가: {btc_summary.get('current_price', 0):,} 원
   - 24시간 변동률: {btc_summary.get('change_rate_24h', 0)}%
   - 일봉 20일 이동평균선(MA20): {btc_summary.get('ma20', 0):,} 원
   - MA20 대비 이격도: {btc_summary.get('disparity_pct', 0)}% (20MA {'상회' if btc_summary.get('is_above_ma20') else '하회'})
2. 암호화폐 공포·탐욕 지수:
   - 지수값: {fng.get('value')} ({fng.get('classification')})
3. 현재 시스템 보유 포지션 티커:
   - {open_positions if open_positions else '현재 보유 중인 포지션 없음'}
4. 최신 뉴스 헤드라인 (최대 15건):
   {chr(10).join(f"- {h}" for h in news_headlines) if news_headlines else '- 최신 수집 헤드라인 없음'}

위 데이터를 종합하여 시스템의 리스크 가이드라인(JSON)을 출력하십시오."""

    raw_response = ""

    # 1. Gemini API 우선 시도
    if gemini_key:
        models = ["gemini-2.5-flash", "gemini-1.5-flash", "gemini-2.0-flash"]
        for model in models:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={gemini_key}"
            payload = {
                "contents": [
                    {
                        "parts": [
                            {"text": f"{SYSTEM_PROMPT}\n\n{user_prompt}"}
                        ]
                    }
                ],
                "generationConfig": {
                    "temperature": 0.2,
                    "responseMimeType": "application/json",
                },
            }
            try:
                resp = requests.post(url, json=payload, timeout=20.0)
                if resp.status_code == 200:
                    result = resp.json()
                    candidates = result.get("candidates", [])
                    if candidates:
                        parts = candidates[0].get("content", {}).get("parts", [])
                        if parts:
                            raw_response = parts[0].get("text", "")
                            if raw_response:
                                break
                else:
                    logger.warning("Gemini model %s returned status %s: %s", model, resp.status_code, resp.text[:150])
            except Exception as exc:
                logger.warning("Gemini call error on %s: %s", model, exc)

    # 2. OpenAI API 폴백 시도
    if not raw_response and openai_key:
        url = "https://api.openai.com/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {openai_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": "gpt-4o-mini",
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.2,
        }
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=20.0)
            if resp.status_code == 200:
                raw_response = resp.json()["choices"][0]["message"]["content"]
        except Exception as exc:
            logger.warning("OpenAI call error: %s", exc)

    # 3. 응답 파싱 및 스키마 검증
    if raw_response:
        try:
            # Markdown codeblock 제거
            cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw_response.strip(), flags=re.MULTILINE)
            parsed = json.loads(cleaned)

            # 필드 정규화
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

            reason = str(parsed.get("reason", "LLM Market Analysis Update"))

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
        except Exception as parse_exc:
            logger.error("Failed to parse LLM JSON response: %s (Raw: %s)", parse_exc, raw_response[:200])

    logger.warning("LLM API failed or returned invalid response. Reverting to fallback regime.")
    return make_fallback_regime(btc_summary)


def update_market_regime_filter_table(filter_data: Dict[str, Any], db_path: Optional[str] = None) -> None:
    """
    market_regime_filter 테이블(id=1 단일 행)을 원자적으로 갱신합니다.
    """
    conn = get_db_connection(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE;")
        conn.execute(
            """
            UPDATE market_regime_filter
            SET sentiment_score = ?,
                market_regime = ?,
                risk_alert = ?,
                recommended_action = ?,
                position_size_multiplier = ?,
                bot_overrides_json = ?,
                blacklist_tickers_json = ?,
                reason = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = 1;
            """,
            (
                filter_data["sentiment_score"],
                filter_data["market_regime"],
                1 if filter_data["risk_alert"] else 0,
                filter_data["recommended_action"],
                filter_data["position_size_multiplier"],
                json.dumps(filter_data["bot_overrides"], ensure_ascii=False),
                json.dumps(filter_data["blacklist_tickers"], ensure_ascii=False),
                filter_data["reason"],
            ),
        )
        conn.execute("COMMIT;")
        logger.info(
            "market_regime_filter updated: Regime=%s, Action=%s, Mult=%.1f, Alert=%s, Reason=%s",
            filter_data["market_regime"],
            filter_data["recommended_action"],
            filter_data["position_size_multiplier"],
            filter_data["risk_alert"],
            filter_data["reason"],
        )
    except Exception as exc:
        conn.execute("ROLLBACK;")
        logger.error("Failed to update market_regime_filter table: %s", exc)
        raise
    finally:
        conn.close()


def run_llm_sentiment_worker(stop_event, bot_id: str = "bot_llm_filter", db_path: Optional[str] = None) -> None:
    """
    4번째 워커 프로세스 메인 함수:
    주기적으로 시장 지표와 뉴스를 분석해 market_regime_filter 단일 행 상태를 갱신합니다.
    """
    logger.info("Worker process [%s] started.", bot_id)
    interval_sec = int(os.getenv("LLM_FILTER_INTERVAL_SEC", "3600"))

    while not stop_event.is_set():
        try:
            logger.info("[%s] Collecting market metrics and crypto news...", bot_id)
            btc_summary = fetch_btc_technical_summary()
            fng = fetch_fear_and_greed_index()
            news = fetch_crypto_news_rss(limit=15)
            open_pos = fetch_open_positions_tickers(db_path)

            logger.info(
                f"[{bot_id}] Data collected: BTC={btc_summary.get('current_price', 0):,.0f} "
                f"(MA20={'Above' if btc_summary.get('is_above_ma20') else 'Below'}), "
                f"FNG={fng.get('value')} ({fng.get('classification')}), NewsCount={len(news)}, OpenPos={open_pos}"
            )

            filter_result = call_llm_filter_api(btc_summary, fng, news, open_pos)
            update_market_regime_filter_table(filter_result, db_path)

        except Exception as loop_exc:
            logger.error("[%s] Error during execution cycle: %s", bot_id, loop_exc, exc_info=True)

        logger.info("[%s] Waiting for next cycle (%d seconds)...", bot_id, interval_sec)
        # stop_event가 활성화되면 즉시 루프를 탈출
        if stop_event.wait(timeout=interval_sec):
            break

    logger.info("Worker process [%s] gracefully stopped.", bot_id)


if __name__ == "__main__":
    import threading

    test_stop = threading.Event()
    # 단일 사이클 테스트 실행
    logger.info("Running standalone LLM filter worker test...")
    btc = fetch_btc_technical_summary()
    fng = fetch_fear_and_greed_index()
    news = fetch_crypto_news_rss(5)
    open_p = fetch_open_positions_tickers()
    res = call_llm_filter_api(btc, fng, news, open_p)
    print("Result:", json.dumps(res, indent=2, ensure_ascii=False))
    update_market_regime_filter_table(res)
