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
import math
import os
import random
import re
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

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

BASE_DIR = Path(__file__).resolve().parent
ENV_PATH = Path(os.getenv("AUTOCOIN_ENV_PATH") or str(BASE_DIR / ".env"))
load_dotenv(dotenv_path=ENV_PATH)

CONFIG_PATH = Path(os.getenv("AUTOCOIN_CONFIG_PATH") or str(BASE_DIR / "config" / "upbit_config.json"))
EXAMPLE_CONFIG_PATH = BASE_DIR / "config" / "upbit_config.example.json"
KST_TZ = timezone(timedelta(hours=9))
DEFAULT_OLLAMA_BASE_URL = "http://192.168.0.100:11434"
DEFAULT_OLLAMA_NEWS_MODEL = "qwen3-news"
DEFAULT_OLLAMA_TIMEOUT_MS = 120000


def _now_kst_str() -> str:
    return datetime.now(KST_TZ).strftime("%Y-%m-%d %H:%M:%S")


def _parse_bool_flag(val: Any, default: bool = True) -> bool:
    if val is None or val == "":
        return default
    if isinstance(val, bool):
        return val
    s = str(val).strip().lower()
    if s in ("true", "1", "yes", "on"):
        return True
    if s in ("false", "0", "no", "off"):
        return False
    return default


def _load_runtime_config() -> Dict[str, Any]:
    target = CONFIG_PATH if CONFIG_PATH.exists() else EXAMPLE_CONFIG_PATH
    try:
        if target.exists():
            with open(target, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data if isinstance(data, dict) else {}
    except Exception:
        pass
    return {}


def _get_system_setting(key: str, default: str = "", db_path: Optional[str] = None) -> str:
    conn = None
    try:
        conn = get_db_connection(db_path)
        row = conn.execute("SELECT value FROM system_settings WHERE key = ?;", (key,)).fetchone()
        if row is not None:
            return str(dict(row).get("value") or "")
    except Exception:
        pass
    finally:
        if conn is not None:
            conn.close()
    return default


def _decrypt_vault_secret(raw_val: Any) -> str:
    """
    AES-256-GCM 암호화 볼트 문자열(enc:v1:<iv>:<tag>:<cipher>)을 복호화합니다.
    평문(enc:v1: 미포함)인 경우 하위 호환성을 위해 그대로 반환합니다.
    """
    s = str(raw_val or "").strip()
    if not s or not s.startswith("enc:v1:"):
        return s
    try:
        import hashlib
        parts = s[len("enc:v1:") :].split(":")
        if len(parts) != 3:
            return ""
        iv = bytes.fromhex(parts[0])
        tag = bytes.fromhex(parts[1])
        ciphertext = bytes.fromhex(parts[2]) if parts[2] else b""

        master_key = (os.getenv("AUTOCOIN_MASTER_KEY") or "").strip()
        if not master_key:
            key_file = Path(os.getenv("AUTOCOIN_VAULT_KEY_PATH") or str(BASE_DIR / "data" / ".vault_master_key"))
            if not key_file.is_absolute():
                key_file = (BASE_DIR / key_file).resolve()
            if key_file.exists():
                master_key = key_file.read_text(encoding="utf-8").strip()
        if not master_key:
            return ""

        try:
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
            derived_key = hashlib.pbkdf2_hmac("sha256", master_key.encode("utf-8"), b"autocoin-vault-salt-v1", 100000, dklen=32)
            aesgcm = AESGCM(derived_key)
            plain_bytes = aesgcm.decrypt(iv, ciphertext + tag, None)
            return plain_bytes.decode("utf-8")
        except ImportError:
            import subprocess
            node_script = (
                "import('./backend/common/crypto_vault.mjs').then(m => "
                "process.stdout.write(m.safeDecryptSecret(process.env._ACT_ENC_VAL || '')))"
            )
            env_copy = dict(os.environ)
            env_copy["_ACT_ENC_VAL"] = s
            out = subprocess.check_output(["node", "-e", node_script], cwd=str(BASE_DIR), env=env_copy, timeout=3.0)
            return out.decode("utf-8").strip()
    except Exception:
        return ""


def get_gemini_api_key(db_path: Optional[str] = None) -> str:
    cfg = _load_runtime_config()
    cfg_key = _decrypt_vault_secret(cfg.get("gemini_api_key"))
    if cfg_key and cfg_key != "YOUR_GEMINI_API_KEY_HERE":
        return cfg_key
    db_key = _decrypt_vault_secret(_get_system_setting("gemini_api_key", "", db_path=db_path))
    if db_key:
        return db_key
    return _decrypt_vault_secret(os.getenv("GEMINI_API_KEY", ""))


def get_ollama_runtime_config(db_path: Optional[str] = None) -> Dict[str, Any]:
    cfg = _load_runtime_config() if CONFIG_PATH.exists() else {}
    ui_configured = _get_system_setting("ollama_ui_configured", "", db_path=db_path)
    db_use_local = _get_system_setting("use_local_ollama_news", "", db_path=db_path)
    db_base_url = _get_system_setting("ollama_base_url", "", db_path=db_path)
    db_model = _get_system_setting("ollama_news_model", "", db_path=db_path)
    db_timeout = _get_system_setting("ollama_timeout_ms", "", db_path=db_path)

    env_override = os.getenv("AUTOCOIN_LIBRARY_MODE", "").strip() == "1"

    if env_override and os.getenv("USE_LOCAL_OLLAMA_NEWS") is not None:
        enabled = _parse_bool_flag(os.getenv("USE_LOCAL_OLLAMA_NEWS"), True)
    elif ui_configured == "1" and db_use_local != "":
        enabled = _parse_bool_flag(db_use_local, True)
    elif "use_local_ollama_news" in cfg:
        enabled = _parse_bool_flag(cfg.get("use_local_ollama_news"), True)
    elif os.getenv("USE_LOCAL_OLLAMA_NEWS") is not None:
        enabled = _parse_bool_flag(os.getenv("USE_LOCAL_OLLAMA_NEWS"), True)
    elif db_use_local != "":
        enabled = _parse_bool_flag(db_use_local, True)
    else:
        enabled = True

    raw_url = (
        (os.getenv("OLLAMA_BASE_URL") if env_override else "")
        or (db_base_url if ui_configured == "1" else "")
        or str(cfg.get("ollama_base_url") or "")
        or os.getenv("OLLAMA_BASE_URL", "")
        or db_base_url
        or DEFAULT_OLLAMA_BASE_URL
    )
    base_url = str(raw_url).strip().rstrip("/") or DEFAULT_OLLAMA_BASE_URL

    model_name = (
        (os.getenv("OLLAMA_NEWS_MODEL") if env_override else "")
        or (db_model if ui_configured == "1" else "")
        or str(cfg.get("ollama_news_model") or "")
        or os.getenv("OLLAMA_NEWS_MODEL", "")
        or db_model
        or DEFAULT_OLLAMA_NEWS_MODEL
    ).strip() or DEFAULT_OLLAMA_NEWS_MODEL

    raw_timeout = (
        (os.getenv("OLLAMA_TIMEOUT_MS") if env_override else "")
        or (db_timeout if ui_configured == "1" else "")
        or cfg.get("ollama_timeout_ms")
        or os.getenv("OLLAMA_TIMEOUT_MS")
        or db_timeout
        or DEFAULT_OLLAMA_TIMEOUT_MS
    )
    try:
        timeout_ms = max(3000, min(180000, int(float(raw_timeout))))
    except Exception:
        timeout_ms = DEFAULT_OLLAMA_TIMEOUT_MS

    return {
        "enabled": enabled,
        "base_url": base_url,
        "model": model_name,
        "timeout_ms": timeout_ms,
    }

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
- 평시(단순 BEAR·SIDEWAYS·단기 휩소)에는 risk_alert=false, recommended_action='REDUCE_SIZE', position_size_multiplier=0.5로 두고 거시 추세(Pro 판단)를 존중하십시오.
- 해킹·디페깅·전쟁 속보·급격한 패닉 투매(HIGH_VOLATILITY_SHOCK) 등 모든 봇의 신규 매수를 즉시 중단해야 하는 돌발 위기 시에만 risk_alert=true, recommended_action='HALT_NEW_BUYS', position_size_multiplier=0.0 및 전체 봇 'BLOCK'을 선언하십시오.
- 특정 코인 유의종목/상장폐지/해킹 악재가 뉴스에 명시된 경우에만 blacklist_tickers에 해당 영문 티커를 추가하고, 해당 사항이 없으면 반드시 빈 배열 []을 반환하십시오.

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

# 모델 후보군 정의 (30분 gemini-3.8-flash / 1시간 gemini-3.1-pro-preview 및 호환 모델 폴백)
FLASH_MODELS = [
    "gemini-3.8-flash",
    "gemini-flash-latest",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-2.5-flash",
]
PRO_MODELS = [
    "gemini-3.1-pro-preview",
    "gemini-pro-latest",
    "gemini-3.8-flash",
    "gemini-flash-latest",
    "gemini-2.5-pro",
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

    return {"ma60_4h": 0.0, "disparity_4h_pct": 0.0, "is_above_ma60_4h": False}


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
            change_rate_24h = ((current_price - prev_close) / prev_close) * 100.0 if prev_close > 0 else 0.0
            ma20 = float(df["close"].rolling(20).mean().iloc[-1])
            disparity_pct = ((current_price - ma20) / ma20) * 100.0 if ma20 > 0 else 0.0
            is_above_ma20 = current_price >= ma20 if ma20 > 0 else False
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
                change_rate_24h = ((current_price - prev_close) / prev_close) * 100.0 if prev_close > 0 else 0.0
                ma20 = sum(closes[-20:]) / 20.0
                disparity_pct = ((current_price - ma20) / ma20) * 100.0 if ma20 > 0 else 0.0
                return {
                    "current_price": current_price,
                    "change_rate_24h": round(change_rate_24h, 2),
                    "change_rate_1h": change_rate_1h,
                    "ma20": round(ma20, 1),
                    "disparity_pct": round(disparity_pct, 2),
                    "is_above_ma20": (current_price >= ma20) if ma20 > 0 else False,
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
        "is_above_ma20": False,
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


def fetch_recent_crypto_news_items(hours: int = 1, limit: int = 12, db_path: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    로컬 Ollama(qwen3-news) 및 뉴스 브리핑 저장을 위해 DB crypto_news에서
    구조화된 뉴스(title, summary, sentiment, source, published_at) 목록을 조회합니다.
    """
    items: List[Dict[str, Any]] = []
    conn = None
    try:
        conn = get_db_connection(db_path)
        rows = conn.execute(
            "SELECT title, source, sentiment, summary, published_at FROM crypto_news ORDER BY published_at DESC, id DESC LIMIT ?;",
            (max(limit, 12),),
        ).fetchall()
        for r in rows:
            rd = dict(r)
            title = str(rd.get("title") or "").strip()
            if not title:
                continue
            items.append({
                "title": title,
                "source": str(rd.get("source") or "NEWS").strip(),
                "sentiment": str(rd.get("sentiment") or "NEUTRAL").strip().upper(),
                "summary": str(rd.get("summary") or "").strip(),
                "published_at": str(rd.get("published_at") or "").strip(),
            })
    except Exception as exc:
        logger.debug("DB structured crypto_news fetch skipped: %s", exc)
    finally:
        if conn is not None:
            conn.close()

    if not items:
        for h in fetch_recent_crypto_news(hours=hours, limit=limit, db_path=db_path):
            items.append({
                "title": str(h),
                "source": "RSS",
                "sentiment": "NEUTRAL",
                "summary": "",
                "published_at": "",
            })
    return items[:limit]


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
    API 키가 없거나 장애 발생 시 발동하는 BTC 일봉 20MA / 4시간봉 60MA 기반 기계적 룰베이스 폴백 로직
    - BTC가 일봉 20MA 및 4시간 60MA 상단: 10대 봇 전체 ALLOW, position_size_multiplier = 1.0 (정상 운용)
    - BTC가 일봉 20MA 또는 4시간 60MA 하단: 추세/돌파 봇(bot_01,02,03,04,07,09) BLOCK, 역추세/그리드(bot_05,06,08,10) ALLOW, 비중 0.5
    """
    current_price = float(btc_summary.get("current_price") or 0.0)
    ma20_val = float(btc_summary.get("ma20") or 0.0)
    if current_price <= 0 or ma20_val <= 0:
        bot_overrides = {
            bot_id: ("BLOCK" if bot_id in TREND_BREAKOUT_BOT_IDS else "ALLOW")
            for bot_id in ALL_BOT_IDS
        }
        return {
            "provider": "fallback",
            "model": "mechanical-btc-20ma",
            "sentiment_score": -0.2,
            "market_regime": "SIDEWAYS",
            "risk_alert": False,
            "recommended_action": "REDUCE_SIZE",
            "position_size_multiplier": 0.5,
            "bot_overrides": bot_overrides,
            "blacklist_tickers": [],
            "reason": f"{label}: BTC 시세/이평선 수신 불가 -> Fail-Safe 보수적 방어(추세·돌파 봇 차단, 역추세 0.5x)",
        }

    is_above_ma20 = bool(btc_summary.get("is_above_ma20", False))
    is_above_ma60_4h = bool(btc_summary.get("is_above_ma60_4h", False))
    is_above = is_above_ma20 and is_above_ma60_4h
    regime = "BULL" if is_above else ("BEAR" if not is_above_ma20 else "SIDEWAYS")
    multiplier = 1.0 if is_above else 0.5
    disparity = btc_summary.get("disparity_pct", 0.0)
    disparity_4h = btc_summary.get("disparity_4h_pct", 0.0)

    if is_above:
        bot_overrides = {bot_id: "ALLOW" for bot_id in ALL_BOT_IDS}
        reason = f"{label}: BTC가 일봉 20MA({disparity}%)·4시간 60MA({disparity_4h}%) 상단 -> 10대 봇 전체 신규 매수 허용(1.0x)"
    else:
        bot_overrides = {
            bot_id: ("BLOCK" if bot_id in TREND_BREAKOUT_BOT_IDS else "ALLOW")
            for bot_id in ALL_BOT_IDS
        }
        reason = (
            f"{label}: BTC 지표 방어(일봉 20MA {disparity}% / 4시간 60MA {disparity_4h}%) 하단 -> "
            "추세·돌파 봇(bot_01,02,03,04,07,09) 신규 진입 차단, 역추세·그리드·눌림목 봇(bot_05,06,08,10) 0.5x 보수적 허용"
        )

    return {
        "provider": "fallback",
        "model": "mechanical-btc-20ma",
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

def _call_gemini_api_with_model(
    system_prompt: str,
    user_prompt: str,
    candidate_models: List[str],
    gemini_key: str,
    max_retries: int = 4,
) -> Tuple[Optional[str], str]:
    """
    Gemini API를 지수 백오프(1초 -> 2초 -> 4초)와 함께 호출하고 (응답텍스트, 선택된모델명)을 반환합니다.
    """
    backoff_delays = (1.0, 2.0, 4.0)
    unavailable_404 = set()
    for attempt in range(max_retries):
        for model in candidate_models:
            if model in unavailable_404:
                continue
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={gemini_key}"
            gen_cfg: Dict[str, Any] = {
                "temperature": 0.2,
                "responseMimeType": "application/json",
            }
            use_no_thinking = ("flash" in model.lower()) and ("lite" not in model.lower())
            if use_no_thinking:
                gen_cfg["thinkingConfig"] = {"thinkingBudget": 0}
            payload = {
                "contents": [
                    {
                        "parts": [
                            {"text": f"{system_prompt}\n\n{user_prompt}"}
                        ]
                    }
                ],
                "generationConfig": gen_cfg,
            }
            try:
                resp = requests.post(url, json=payload, timeout=55.0)
                if resp.status_code == 400 and use_no_thinking and "thinking" in (resp.text or "").lower():
                    gen_cfg.pop("thinkingConfig", None)
                    resp = requests.post(url, json=payload, timeout=55.0)
                if resp.status_code == 200:
                    result = resp.json()
                    candidates = result.get("candidates", [])
                    if candidates:
                        parts = candidates[0].get("content", {}).get("parts", [])
                        if parts:
                            raw_text = parts[0].get("text", "")
                            if raw_text:
                                logger.info("Gemini API call succeeded with model: %s", model)
                                return raw_text, model
                elif resp.status_code in (401, 403):
                    logger.error("Gemini API authentication/permission denied (%s). Stopping retries.", resp.status_code)
                    return None, model
                elif resp.status_code in (400, 404):
                    unavailable_404.add(model)
                    logger.warning("Gemini model %s unavailable (%s): %s", model, resp.status_code, resp.text[:120])
                elif resp.status_code in (429, 503):
                    logger.warning("Gemini model %s busy/throttled (%s). Attempt %d/%d", model, resp.status_code, attempt + 1, max_retries)
                else:
                    logger.warning("Gemini model %s returned status %s: %s", model, resp.status_code, resp.text[:120])
            except Exception as exc:
                logger.warning("Gemini model %s request exception (attempt %d/%d): %s", model, attempt + 1, max_retries, exc)

        if attempt < max_retries - 1 and len(unavailable_404) < len(candidate_models):
            delay = backoff_delays[min(attempt, len(backoff_delays) - 1)]
            logger.info("Waiting %.1f seconds before retrying Gemini API...", delay)
            time.sleep(delay)

    return None, (candidate_models[0] if candidate_models else "gemini-3.8-flash")


def call_gemini_api_with_retry(
    system_prompt: str,
    user_prompt: str,
    candidate_models: List[str],
    gemini_key: str,
    max_retries: int = 4,
) -> Optional[str]:
    raw_text, _ = _call_gemini_api_with_model(
        system_prompt, user_prompt, candidate_models, gemini_key, max_retries=max_retries
    )
    return raw_text


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


BLACKLIST_PLACEHOLDER_TICKERS = {
    "KRW-TICKER",
    "KRW-COIN",
    "KRW-SYMBOL",
    "KRW-TOKEN",
    "KRW-NONE",
    "KRW-NULL",
    "KRW-NA",
    "KRW-EXAMPLE",
    "KRW-TEST",
}


def normalize_blacklist_tickers(raw_blacklist: Any) -> List[str]:
    """업비트 표준 영문 KRW 티커 형식(KRW-[A-Z0-9]{2,10})만 통과시켜 프롬프트 예시 문자열 오염을 차단합니다."""
    items = raw_blacklist
    if isinstance(items, str):
        try:
            items = json.loads(items)
        except Exception:
            items = []
    if not isinstance(items, list):
        return []
    blacklist_set = set()
    for item in items:
        t = str(item or "").strip().upper()
        if not t:
            continue
        if t.startswith("KRW-"):
            cand = t
        elif "-" in t:
            cand = f"KRW-{t.split('-')[-1]}"
        else:
            cand = f"KRW-{t}"
        if cand in BLACKLIST_PLACEHOLDER_TICKERS:
            continue
        if re.fullmatch(r"KRW-[A-Z0-9]{2,10}", cand):
            blacklist_set.add(cand)
    return sorted(blacklist_set)


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
        if not isinstance(parsed, dict) or not any(
            k in parsed for k in ("sentiment_score", "market_regime", "recommended_action", "bot_overrides")
        ):
            logger.error("LLM JSON missing required decision keys: %s", (raw_text or "")[:200])
            return None

        try:
            raw_sent = parsed.get("sentiment_score", 0.0)
            sentiment_score = float(0.0 if raw_sent is None else raw_sent)
            if not math.isfinite(sentiment_score):
                sentiment_score = 0.0
        except (TypeError, ValueError):
            sentiment_score = 0.0
        sentiment_score = max(-1.0, min(1.0, sentiment_score))

        regime = str(parsed.get("market_regime", "SIDEWAYS") or "SIDEWAYS").upper()
        if regime not in ("BULL", "BEAR", "SIDEWAYS", "HIGH_VOLATILITY_SHOCK"):
            regime = "SIDEWAYS"

        raw_risk_alert = _parse_bool_flag(parsed.get("risk_alert"), False)

        action = str(parsed.get("recommended_action", "NORMAL") or "NORMAL").upper()
        if action not in ("NORMAL", "REDUCE_SIZE", "HALT_NEW_BUYS", "EMERGENCY_CLOSE_ALL"):
            action = "NORMAL"

        try:
            raw_mult = parsed.get("position_size_multiplier", 0.5 if action == "REDUCE_SIZE" else 1.0)
            multiplier = float((0.5 if action == "REDUCE_SIZE" else 1.0) if raw_mult is None else raw_mult)
            if not math.isfinite(multiplier):
                multiplier = 0.5 if action == "REDUCE_SIZE" else 1.0
        except (TypeError, ValueError):
            multiplier = 0.5 if action == "REDUCE_SIZE" else 1.0

        raw_overrides_input = parsed.get("bot_overrides")
        has_explicit_overrides = isinstance(raw_overrides_input, dict) and len(raw_overrides_input) > 0
        bot_overrides = normalize_bot_overrides(raw_overrides_input)
        has_any_allow_bot = any(bot_overrides.get(bot_id) == "ALLOW" for bot_id in ALL_BOT_IDS)

        is_hard_halt = (
            action in ("HALT_NEW_BUYS", "EMERGENCY_CLOSE_ALL")
            or (raw_risk_alert and regime == "HIGH_VOLATILITY_SHOCK")
            or (raw_risk_alert and has_explicit_overrides and not has_any_allow_bot and multiplier <= 0.0)
        )

        if is_hard_halt:
            risk_alert = True
            if action != "EMERGENCY_CLOSE_ALL":
                action = "HALT_NEW_BUYS"
            multiplier = 0.0
            bot_overrides = {bot_id: "BLOCK" for bot_id in ALL_BOT_IDS}
        else:
            risk_alert = False
            if raw_risk_alert and action == "NORMAL":
                action = "REDUCE_SIZE"
            if action == "REDUCE_SIZE":
                multiplier = (0.5 if has_any_allow_bot else 0.0) if multiplier <= 0.0 else min(0.5, 0.5 if multiplier < 0.75 else 1.0)
            else:
                multiplier = 0.0 if multiplier <= 0.0 else (0.5 if multiplier < 0.75 else 1.0)

        blacklist = normalize_blacklist_tickers(parsed.get("blacklist_tickers", []))

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
# 4. Flash 30분 빠른 분석(1순위: 맥북 로컬 Ollama qwen3-news) & Pro 1시간 심층 퀀트 분석 개별 실행기
# ==============================================================================

def call_local_ollama_coin_news_analyzer(
    btc_summary: Dict[str, Any],
    news_items: List[Any],
    open_positions: List[str],
    live_bots: Optional[List[Dict[str, Any]]] = None,
    fng: Optional[Dict[str, Any]] = None,
    base_url: Optional[str] = None,
    model_name: Optional[str] = None,
    timeout_ms: Optional[int] = None,
    db_path: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """
    맥북 프로 로컬 Ollama(qwen3-news) API를 호출하여 최근 30분 암호화폐 뉴스 감성 및 업비트 10대 봇 제어 상태를 JSON으로 분석합니다.
    필수 옵션: stream=False, think=False, format='json', timeout=25초
    """
    cfg = get_ollama_runtime_config(db_path=db_path)
    target_url = (base_url or cfg["base_url"]).strip().rstrip("/")
    target_model = (model_name or cfg["model"]).strip() or DEFAULT_OLLAMA_NEWS_MODEL
    target_timeout_sec = max(3.0, min(180.0, float(timeout_ms or cfg["timeout_ms"]) / 1000.0))

    # CPU 추론 최적화: 최신 코인 뉴스 최대 6건, 제목 90자 이내로 압축
    compact_lines: List[str] = []
    for idx, item in enumerate((news_items or [])[:6], start=1):
        if isinstance(item, dict):
            sent = str(item.get("sentiment") or "NEUTRAL").upper()
            sent_tag = "호재" if sent == "BULLISH" else ("악재" if sent == "BEARISH" else "중립")
            title = re.sub(r"\s+", " ", str(item.get("title") or "")).strip()[:90]
            compact_lines.append(f"{idx}.[{sent_tag}]{title}")
        else:
            compact_lines.append(f"{idx}.{re.sub(r'\s+', ' ', str(item or '')).strip()[:90]}")

    compact_news_text = "\n".join(compact_lines) if compact_lines else "특이 속보 없음"
    fng_val = (fng or {}).get("value", "N/A")
    fng_cls = (fng or {}).get("classification", "N/A")

    user_prompt = f"""업비트 30분 시황·뉴스 JSON 분석:
[시황] KRW-BTC={btc_summary.get('current_price', 'N/A')}원(24h {btc_summary.get('change_rate_24h', 'N/A')}%) | 일봉20MA={btc_summary.get('ma20', 'N/A')} | 4h60MA={btc_summary.get('ma60_4h', 'N/A')} | 공포탐욕={fng_val}({fng_cls}) | 전략군=돌파형(bot_01,02,03,04,07,09)/역추세·그리드(bot_05,06,08,10) | 보유={','.join(open_positions) if open_positions else '없음'}
[뉴스]
{compact_news_text}
[판단 규칙]
- risk_alert=true 및 HALT_NEW_BUYS는 해킹·디페깅·상폐·패닉폭락(HIGH_VOLATILITY_SHOCK) 때만 사용(전체 BLOCK, mult=0.0).
- 단순 약세(BEAR)·횡보(SIDEWAYS)는 risk_alert=false, recommended_action="REDUCE_SIZE", position_size_multiplier=0.5, 돌파형(bot_01,02,03,04,07,09)="BLOCK", 역추세·그리드(bot_05,06,08,10)="ALLOW".
- blacklist_tickers는 뉴스에 특정 코인의 해킹·상폐·유의종목 악재가 직접 명시된 경우에만 영문 티커(예: "KRW-XRP")를 넣고, 무관하거나 불확실하면 반드시 빈 배열 []로 출력.
[JSON 스키마]
{{"sentiment_score":-1.0~1.0,"market_regime":"BULL|SIDEWAYS|BEAR|HIGH_VOLATILITY_SHOCK","risk_alert":false,"recommended_action":"NORMAL|REDUCE_SIZE|HALT_NEW_BUYS|EMERGENCY_CLOSE_ALL","position_size_multiplier":1.0,"bot_overrides":{{"bot_01":"ALLOW|BLOCK","bot_02":"ALLOW|BLOCK","bot_03":"ALLOW|BLOCK","bot_04":"ALLOW|BLOCK","bot_05":"ALLOW|BLOCK","bot_06":"ALLOW|BLOCK","bot_07":"ALLOW|BLOCK","bot_08":"ALLOW|BLOCK","bot_09":"ALLOW|BLOCK","bot_10":"ALLOW|BLOCK"}},"blacklist_tickers":[],"reason":"한국어 1~2문장(70자이내) 요약"}}"""

    started_ms = int(time.time() * 1000)
    resp = requests.post(
        f"{target_url}/api/chat",
        json={
            "model": target_model,
            "stream": False,
            "think": False,
            "format": "json",
            "keep_alive": "35m",
            "messages": [
                {"role": "system", "content": "업비트 암호화폐 30분 단기 시황·뉴스 JSON 분석기. 지정 JSON 스키마만 간결히 출력."},
                {"role": "user", "content": user_prompt},
            ],
        },
        timeout=target_timeout_sec,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Ollama HTTP {resp.status_code}: {resp.text[:200]}")

    data = resp.json()
    raw_content = str((data.get("message") or {}).get("content") or data.get("response") or "").strip()
    if not raw_content:
        raise RuntimeError("Ollama returned empty message content")

    parsed = parse_and_validate_llm_json(raw_content, "로컬 Ollama(qwen3-news) 30분 암호화폐 뉴스·시황 분석 완료")
    if not parsed:
        raise ValueError("Ollama response failed JSON schema validation")

    parsed["provider"] = "ollama"
    parsed["model"] = target_model
    parsed["model_tier"] = "OLLAMA_QWEN3_30M"
    parsed["latency_ms"] = max(1, int(time.time() * 1000) - started_ms)
    return parsed


def call_flash_fast_analysis(
    btc_summary: Dict[str, Any],
    news_headlines: List[Any],
    open_positions: List[str],
    previous_state: Optional[Dict[str, Any]] = None,
    live_bots: Optional[List[Dict[str, Any]]] = None,
    open_positions_detail: Optional[List[Dict[str, Any]]] = None,
    db_path: Optional[str] = None,
    fng: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    FLASH_30M 30분 단기 시황·뉴스 분석 (3중 무중단 Fallback):
    - 1순위: 맥북 프로 로컬 Ollama(qwen3-news) API
    - 2순위: Gemini Flash API (지수 백오프 1초, 2초, 4초 포함)
    - 3순위: 직전 유효 캐시 유지 또는 KRW-BTC 일봉 20MA / 4시간봉 60MA 기반 기계적 안전 모드
    """
    ollama_cfg = get_ollama_runtime_config(db_path=db_path)

    # 1순위: 로컬 맥북 Ollama(qwen3-news)
    if ollama_cfg.get("enabled", True):
        try:
            ollama_res = call_local_ollama_coin_news_analyzer(
                btc_summary=btc_summary,
                news_items=news_headlines,
                open_positions=open_positions,
                live_bots=live_bots,
                fng=fng,
                base_url=ollama_cfg["base_url"],
                model_name=ollama_cfg["model"],
                timeout_ms=ollama_cfg["timeout_ms"],
                db_path=db_path,
            )
            if ollama_res:
                ollama_res["_cached_at"] = time.time()
                ollama_res["is_cached_fallback"] = False
                logger.info(
                    "Local Ollama (%s) 30m analysis succeeded in %dms.",
                    ollama_res.get("model"),
                    ollama_res.get("latency_ms", 0),
                )
                return ollama_res
        except Exception as exc:
            logger.warning("[OllamaFallback] 로컬 맥북 Ollama 연결 실패 (%s) -> Gemini Flash 백업 엔진 전환", exc)

    # 2순위: Gemini Flash / OpenAI 백업 엔진
    gemini_key = get_gemini_api_key(db_path=db_path)
    openai_key = os.getenv("OPENAI_API_KEY", "").strip()

    if not gemini_key and not openai_key:
        logger.info("No LLM API keys for Flash fallback. Applying mechanical/cache fallback.")
        cache_ts = float(previous_state.get("_cached_at") or 0.0) if isinstance(previous_state, dict) else 0.0
        if previous_state and cache_ts > 0 and (time.time() - cache_ts) <= 5400:
            cached = dict(previous_state)
            cached["bot_overrides"] = normalize_bot_overrides(cached.get("bot_overrides"))
            cached["is_cached_fallback"] = True
            return cached
        return make_fallback_regime(btc_summary, "Flash Fallback")

    headline_strings = [
        (f"[{h.get('source', 'NEWS')}] {h.get('title', '')}" if isinstance(h, dict) else str(h))
        for h in (news_headlines or [])
    ]
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
{chr(10).join(f"- {h}" for h in headline_strings) if headline_strings else '- 최근 특이 속보 없음'}

[판단 지침]
- 단기 돌발 악재(해킹, 디페깅, 전쟁 속보, 패닉 투매, 업비트 유의종목/상장폐지 공시)가 없으면 거시 기조를 유지하며, 단순 BEAR·SIDEWAYS 방어 시에는 반드시 risk_alert=false, recommended_action='REDUCE_SIZE', position_size_multiplier=0.5로 응답하십시오.
- 전 시장 신규 매수를 즉시 중단해야 하는 돌발 쇼크(HIGH_VOLATILITY_SHOCK) 감지 시에만 risk_alert=true, recommended_action='HALT_NEW_BUYS', position_size_multiplier=0.0 및 전체 봇 BLOCK으로 응답하고, 특정 코인 악재는 blacklist_tickers에 영문 티커만 추가(없으면 [])하십시오.
- 보유 포지션 강제 청산이 아닌 신규 매수 게이트(bot_01~bot_10)만 JSON으로 반환하십시오."""

    raw_response = None
    chosen_model = FLASH_MODELS[0]
    chosen_provider = "gemini"
    if gemini_key:
        raw_response, chosen_model = _call_gemini_api_with_model(
            FLASH_SYSTEM_PROMPT, user_prompt, FLASH_MODELS, gemini_key, max_retries=4
        )

    if not raw_response and openai_key:
        raw_response = call_openai_api_with_retry(
            FLASH_SYSTEM_PROMPT, user_prompt, "gpt-4o-mini", openai_key
        )
        if raw_response:
            chosen_provider = "openai"
            chosen_model = "gpt-4o-mini"

    parsed = parse_and_validate_llm_json(raw_response, "Flash 30m fast analysis completed")
    if parsed:
        parsed["provider"] = chosen_provider
        parsed["model"] = chosen_model
        parsed["_cached_at"] = time.time()
        parsed["is_cached_fallback"] = False
        return parsed

    # 3순위: 90분 이내 직전 유효 캐시 유지, 만료 시 BTC 일봉 20MA / 4시간봉 60MA 기계적 안전 모드
    cache_ts = float(previous_state.get("_cached_at") or 0.0) if isinstance(previous_state, dict) else 0.0
    if previous_state and cache_ts > 0 and (time.time() - cache_ts) <= 5400:
        logger.warning("Flash API call failed; keeping recent cached Flash state (<90m).")
        cached = dict(previous_state)
        cached["bot_overrides"] = normalize_bot_overrides(cached.get("bot_overrides"))
        cached["is_cached_fallback"] = True
        return cached

    return make_fallback_regime(btc_summary, "Flash Fallback Rule")


def call_pro_indepth_analysis(
    btc_summary: Dict[str, Any],
    fng: Dict[str, Any],
    news_headlines: List[str],
    open_positions: List[str],
    previous_state: Optional[Dict[str, Any]] = None,
    live_bots: Optional[List[Dict[str, Any]]] = None,
    open_positions_detail: Optional[List[Dict[str, Any]]] = None,
    db_path: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Gemini Pro(1시간 주기): BTC 일봉 20MA / 4시간 60MA, 공포·탐욕 지수, 최근 4시간 뉴스를 종합 분석해
    장세(market_regime)와 10대 봇(bot_01~bot_10) 각각의 ALLOW/BLOCK 스위치를 결정합니다.
    """
    gemini_key = get_gemini_api_key(db_path=db_path)
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
    chosen_model = PRO_MODELS[0]
    chosen_provider = "gemini"
    if gemini_key:
        raw_response, chosen_model = _call_gemini_api_with_model(
            PRO_SYSTEM_PROMPT, user_prompt, PRO_MODELS, gemini_key, max_retries=4
        )

    if not raw_response and openai_key:
        raw_response = call_openai_api_with_retry(
            PRO_SYSTEM_PROMPT, user_prompt, "gpt-4o", openai_key
        )
        if raw_response:
            chosen_provider = "openai"
            chosen_model = "gpt-4o"

    parsed = parse_and_validate_llm_json(raw_response, "Pro 1h in-depth quantitative analysis completed")
    if parsed:
        parsed["provider"] = chosen_provider
        parsed["model"] = chosen_model
        parsed["_cached_at"] = time.time()
        parsed["is_cached_fallback"] = False
        return parsed

    cache_ts = float(previous_state.get("_cached_at") or 0.0) if isinstance(previous_state, dict) else 0.0
    if previous_state and cache_ts > 0 and (time.time() - cache_ts) <= 5400:
        logger.warning("Pro API call failed; keeping recent cached Pro state (<90m).")
        cached = dict(previous_state)
        cached["bot_overrides"] = normalize_bot_overrides(cached.get("bot_overrides"))
        cached["is_cached_fallback"] = True
        return cached

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
    flash_alert = _parse_bool_flag(flash_res.get("risk_alert", False), False)
    pro_alert = _parse_bool_flag(pro_res.get("risk_alert", False), False)

    flash_mult = float(flash_res.get("position_size_multiplier", 1.0))
    pro_mult = float(pro_res.get("position_size_multiplier", 1.0))

    flash_overrides = normalize_bot_overrides(flash_res.get("bot_overrides"))
    pro_overrides = normalize_bot_overrides(pro_res.get("bot_overrides"))
    has_active_pro = bool(pro_res) and not bool(pro_res.get("_is_neutral_passthrough", False))

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

    # 3. 비중 축소 / 평시 권한 분리:
    #    Flash는 돌발 쇼크/블랙리스트 방패 역할에 집중하고, 평시(BEAR/SIDEWAYS/REDUCE_SIZE)의 10대 봇 전략군 스위치는 거시 전략가(Pro) 판정 우선
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
        source_overrides = pro_overrides if has_active_pro else flash_overrides
        for bot_id in ALL_BOT_IDS:
            final_bot_overrides[bot_id] = source_overrides.get(bot_id, "ALLOW")
        if all(v == "BLOCK" for v in final_bot_overrides.values()):
            final_action = "HALT_NEW_BUYS"
            final_multiplier = 0.0
            synthesis_mode = "CONSERVATIVE_ALL_BOTS_BLOCKED"
        else:
            synthesis_mode = "CONSERVATIVE_REDUCE (보수적 50% 비중 축소 · Pro 전략군 스위치 우선)"

    # 4. 두 모델 모두 NORMAL (평시 Pro 전략군 스위치 우선)
    elif flash_action == "NORMAL" and pro_action == "NORMAL":
        final_risk_alert = False
        final_action = "NORMAL"
        final_multiplier = round(max(0.0, min(flash_mult, pro_mult, 1.0)), 2)
        source_overrides = pro_overrides if has_active_pro else flash_overrides
        for bot_id in ALL_BOT_IDS:
            final_bot_overrides[bot_id] = source_overrides.get(bot_id, "ALLOW")
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
        source_overrides = pro_overrides if has_active_pro else flash_overrides
        for bot_id in ALL_BOT_IDS:
            final_bot_overrides[bot_id] = source_overrides.get(bot_id, "ALLOW")
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

    # 블랙리스트 티커 합집합 (유효 KRW 영문 티커만 허용)
    combined_blacklist = normalize_blacklist_tickers(
        list(flash_res.get("blacklist_tickers", []) or []) + list(pro_res.get("blacklist_tickers", []) or [])
    )

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


def update_market_regime_filter_table(
    synthesized: Dict[str, Any],
    db_path: Optional[str] = None,
    update_flash_ts: bool = True,
    update_pro_ts: bool = True,
) -> None:
    """
    market_regime_filter 테이블(id=1 단일 행)을 원자적으로 갱신합니다.
    기존 컬럼과 신규 확장 컬럼(flash_*, pro_*, final_*)을 모두 저장하여 완벽한 하위 호환성을 제공합니다.
    """
    conn = get_db_connection(db_path)
    now_kst = _now_kst_str()
    try:
        conn.execute("BEGIN IMMEDIATE;")
        existing_row = conn.execute(
            "SELECT flash_updated_at, pro_updated_at FROM market_regime_filter WHERE id = 1;"
        ).fetchone()
        existing_dict = dict(existing_row) if existing_row is not None else {}
        flash_ts = now_kst if update_flash_ts else str(existing_dict.get("flash_updated_at") or now_kst)
        pro_ts = now_kst if update_pro_ts else str(existing_dict.get("pro_updated_at") or now_kst)

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
                updated_at = %s,
                flash_sentiment_score = %s,
                flash_recommended_action = %s,
                flash_updated_at = %s,
                pro_sentiment_score = %s,
                pro_recommended_action = %s,
                pro_updated_at = %s,
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
                now_kst,
                synthesized["flash_sentiment_score"],
                synthesized["flash_recommended_action"],
                flash_ts,
                synthesized["pro_sentiment_score"],
                synthesized["pro_recommended_action"],
                pro_ts,
                1 if synthesized["final_risk_alert"] else 0,
                synthesized["final_position_multiplier"],
                json.dumps(synthesized["final_bot_overrides"], ensure_ascii=False),
            ),
        )
        conn.commit()
        logger.info(
            "[Dual AI] market_regime_filter updated: Mode=%s, Action=%s, Mult=%.1f, Alert=%s, Reason=%s",
            synthesized.get("synthesis_mode", "N/A"),
            synthesized["recommended_action"],
            synthesized["position_size_multiplier"],
            synthesized["risk_alert"],
            synthesized["reason"][:120],
        )
    except Exception as exc:
        try:
            conn.rollback()
        except Exception:
            pass
        logger.error("Failed to update market_regime_filter table: %s", exc)
        raise
    finally:
        conn.close()


def save_ai_briefings_to_db(
    flash_res: Optional[Dict[str, Any]],
    pro_res: Optional[Dict[str, Any]],
    synthesized: Dict[str, Any],
    btc_summary: Dict[str, Any],
    news_items: List[Any],
    db_path: Optional[str] = None,
    save_market: bool = True,
    save_news: bool = True,
    flash_ran: bool = True,
    pro_ran: bool = True,
) -> None:
    """
    ai_market_briefings 및 ai_news_briefings 테이블에 분석 내역을 기록합니다.
    로컬 Ollama 응답 시 provider='ollama', model='qwen3-news'로, Gemini 응답 시 provider='gemini'로 저장합니다.
    """
    now_kst = _now_kst_str()
    conn = get_db_connection(db_path)
    try:
        active_flash = flash_res or {}
        active_pro = pro_res or {}
        flash_provider = str(active_flash.get("provider") or "fallback")
        flash_model = str(active_flash.get("model") or "mechanical-btc-20ma")
        pro_provider = str(active_pro.get("provider") or "fallback")
        pro_model = str(active_pro.get("model") or "mechanical-btc-20ma")
        flash_is_fresh = flash_ran and not bool(active_flash.get("is_cached_fallback")) and flash_provider in ("ollama", "gemini", "openai")
        pro_is_fresh = pro_ran and not bool(active_pro.get("is_cached_fallback")) and pro_provider in ("ollama", "gemini", "openai")

        btc_price = float(btc_summary.get("current_price") or 0.0)
        btc_ma20 = float(btc_summary.get("ma20") or 0.0)
        btc_4h60 = float(btc_summary.get("ma60_4h") or 0.0)
        regime_status = (
            "HOLD_CASH"
            if synthesized.get("recommended_action") in ("HALT_NEW_BUYS", "EMERGENCY_CLOSE_ALL")
            else str(synthesized.get("market_regime") or "SIDEWAYS")
        )

        if save_market and (flash_is_fresh or pro_is_fresh):
            if pro_is_fresh and not flash_is_fresh:
                primary_provider, primary_model = pro_provider, pro_model
            else:
                primary_provider, primary_model = flash_provider, flash_model
            overrides = synthesized.get("final_bot_overrides") or {}
            allow_bots = [bid for bid in ALL_BOT_IDS if overrides.get(bid) == "ALLOW"]
            block_bots = [bid for bid in ALL_BOT_IDS if overrides.get(bid) == "BLOCK"]
            market_md = "\n".join([
                f"## ⚡ 단기·거시 AI 시황 분석 ({primary_provider} · `{primary_model}`)",
                f"- **시장 체제**: `{synthesized.get('market_regime')}` | **권고 액션**: `{synthesized.get('recommended_action')}` | **투입 비중**: **{int(round(float(synthesized.get('final_position_multiplier', 1.0)) * 100))}%**",
                f"- **블랙리스트**: {', '.join(synthesized.get('blacklist_tickers') or []) or '없음'}",
                "",
                "## 🧠 판단 근거",
                str(synthesized.get("reason") or ""),
                "",
                "## 🤖 10대 봇 게이트웨이",
                f"- **ALLOW**: {', '.join(allow_bots) if allow_bots else '없음'}",
                f"- **BLOCK**: {', '.join(block_bots) if block_bots else '없음'}",
            ])
            conn.execute(
                """
                INSERT INTO ai_market_briefings (
                    provider, model, btc_price, btc_daily_20ma, btc_4h_60ma, regime_status, briefing_text, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
                """,
                (primary_provider, primary_model, btc_price, btc_ma20, btc_4h60, regime_status, market_md, now_kst),
            )

        if save_news and flash_is_fresh:
            stats_row = conn.execute(
                """
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN sentiment = 'BULLISH' THEN 1 ELSE 0 END) AS bull,
                    SUM(CASE WHEN sentiment = 'BEARISH' THEN 1 ELSE 0 END) AS bear,
                    SUM(CASE WHEN sentiment = 'NEUTRAL' THEN 1 ELSE 0 END) AS neut
                FROM crypto_news;
                """
            ).fetchone()
            st = dict(stats_row) if stats_row is not None else {}
            total_news = int(st.get("total") or len(news_items or []))
            bull_cnt = int(st.get("bull") or 0)
            bear_cnt = int(st.get("bear") or 0)
            neut_cnt = int(st.get("neut") or 0)
            news_md = "\n".join([
                f"## 1. 📰 실시간 뉴스 핵심 쟁점 및 센티먼트 ({flash_provider} · `{flash_model}`)",
                f"- **단기 감성 점수**: `{float(active_flash.get('sentiment_score', 0.0)):+.2f}` | **체제**: `{active_flash.get('market_regime', 'SIDEWAYS')}`",
                f"- **판단 근거**: {active_flash.get('reason', '')}",
                "",
                "## 2. 🎯 퀀트 봇 제어 요약",
                f"- **권고 액션**: `{active_flash.get('recommended_action', 'NORMAL')}` | **블랙리스트**: {', '.join(active_flash.get('blacklist_tickers') or []) or '없음'}",
            ])
            conn.execute(
                """
                INSERT INTO ai_news_briefings (
                    provider, model, news_count, bullish_count, bearish_count, neutral_count, briefing_text, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
                """,
                (flash_provider, flash_model, total_news, bull_cnt, bear_cnt, neut_cnt, news_md, now_kst),
            )

        if flash_ran and flash_res and not bool(active_flash.get("is_cached_fallback")):
            conn.execute(
                "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?);",
                ("dual_ai_flash_provider", flash_provider, now_kst),
            )
            conn.execute(
                "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?);",
                ("dual_ai_flash_model", flash_model, now_kst),
            )
        if pro_ran and pro_res and not bool(active_pro.get("is_cached_fallback")):
            conn.execute(
                "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?);",
                ("dual_ai_pro_provider", pro_provider, now_kst),
            )
            conn.execute(
                "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?);",
                ("dual_ai_pro_model", pro_model, now_kst),
            )

        conn.commit()
    except Exception as exc:
        conn.rollback()
        logger.warning("Failed to save ai_market_briefings/ai_news_briefings: %s", exc)
    finally:
        conn.close()


# ==============================================================================
# 6. 메인 워커 프로세스 루프 (30분 Flash & 1시간 Pro 독립 타이머 제어)
# ==============================================================================

def run_llm_sentiment_worker(stop_event, bot_id: str = "bot_llm_filter", db_path: Optional[str] = None) -> None:
    """
    듀얼 AI 워커 메인 프로세스:
    - 30분(1800초) 단위 FLASH_30M 분석 실행 (1순위: 맥북 로컬 Ollama qwen3-news -> 2순위: Gemini Flash -> 3순위: BTC 20MA)
    - 1시간(3600초) 단위 Gemini Pro 심층 퀀트 분석 실행
    - 단기/심층 분석 결과 교차 검증 및 market_regime_filter / ai_*_briefings 갱신
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
            flash_act = str(row.get("flash_recommended_action") or "NORMAL").upper()
            pro_act = str(row.get("pro_recommended_action") or "NORMAL").upper()
            saved_f_prov = _get_system_setting("dual_ai_flash_provider", "", db_path=db_path)
            saved_f_mod = _get_system_setting("dual_ai_flash_model", "", db_path=db_path)
            saved_p_prov = _get_system_setting("dual_ai_pro_provider", "", db_path=db_path)
            saved_p_mod = _get_system_setting("dual_ai_pro_model", "", db_path=db_path)
            current_flash_result = {
                "sentiment_score": float(row.get("flash_sentiment_score") or 0.0),
                "market_regime": row.get("market_regime") or "SIDEWAYS",
                "risk_alert": flash_act in ("HALT_NEW_BUYS", "EMERGENCY_CLOSE_ALL"),
                "recommended_action": flash_act,
                "position_size_multiplier": 0.0 if flash_act in ("HALT_NEW_BUYS", "EMERGENCY_CLOSE_ALL") else restored_mult,
                "bot_overrides": restored_overrides,
                "blacklist_tickers": restored_blacklist,
                "provider": saved_f_prov,
                "model": saved_f_mod,
                "reason": row.get("reason") or "Restored Flash baseline from DB",
            }
            current_pro_result = {
                "sentiment_score": float(row.get("pro_sentiment_score") or 0.0),
                "market_regime": row.get("market_regime") or "SIDEWAYS",
                "risk_alert": pro_act in ("HALT_NEW_BUYS", "EMERGENCY_CLOSE_ALL"),
                "recommended_action": pro_act,
                "position_size_multiplier": 0.0 if pro_act in ("HALT_NEW_BUYS", "EMERGENCY_CLOSE_ALL") else restored_mult,
                "bot_overrides": restored_overrides,
                "blacklist_tickers": restored_blacklist,
                "provider": saved_p_prov,
                "model": saved_p_mod,
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
            raw_bport = (os.getenv("BACKEND_PORT") or os.getenv("PORT") or "8001").strip()
            try:
                backend_port = int(raw_bport) if raw_bport else 8001
            except ValueError:
                backend_port = 8001
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
                fng = fetch_fear_and_greed_index()
                flash_news_items: List[Dict[str, Any]] = []

                # 1. Pro 1시간 심층 퀀트 분석 실행
                if should_run_pro:
                    logger.info("[%s] Starting Gemini Pro 1-Hour In-Depth Quantitative Analysis...", bot_id)
                    pro_news = fetch_recent_crypto_news(hours=4, limit=15, db_path=db_path)
                    pro_res = call_pro_indepth_analysis(
                        btc_summary,
                        fng,
                        pro_news,
                        open_pos,
                        current_pro_result,
                        live_bots=live_bots,
                        open_positions_detail=open_pos_detail,
                        db_path=db_path,
                    )
                    if pro_res:
                        current_pro_result = pro_res
                        last_pro_run = now
                        logger.info(
                            "[%s] Gemini Pro Analysis Complete: Regime=%s, Action=%s, Score=%.2f",
                            bot_id, pro_res["market_regime"], pro_res["recommended_action"], pro_res["sentiment_score"]
                        )

                # 2. Flash 30분 단기 시황 분석 실행 (1순위: 로컬 Ollama qwen3-news)
                if should_run_flash:
                    logger.info("[%s] Starting FLASH_30M 30-Minute Fast-Response Analysis...", bot_id)
                    flash_news_items = fetch_recent_crypto_news_items(hours=1, limit=12, db_path=db_path)
                    flash_res = call_flash_fast_analysis(
                        btc_summary,
                        flash_news_items,
                        open_pos,
                        current_flash_result,
                        live_bots=live_bots,
                        open_positions_detail=open_pos_detail,
                        db_path=db_path,
                        fng=fng,
                    )
                    if flash_res:
                        current_flash_result = flash_res
                        last_flash_run = now
                        logger.info(
                            "[%s] FLASH_30M Analysis Complete (%s/%s): Action=%s, Alert=%s, Score=%.2f",
                            bot_id,
                            flash_res.get("provider", "fallback"),
                            flash_res.get("model", "rule"),
                            flash_res["recommended_action"],
                            flash_res["risk_alert"],
                            flash_res["sentiment_score"],
                        )

                # 3. 폴백 보완
                if current_flash_result is None:
                    current_flash_result = make_fallback_regime(btc_summary, "Flash Fallback Baseline")
                if current_pro_result is None:
                    current_pro_result = make_fallback_regime(btc_summary, "Pro Fallback Baseline")

                # 4. 다중 모델 교차 검증 종합 판단 및 DB 원자적 반영
                synthesized = synthesize_dual_decisions(current_flash_result, current_pro_result)
                update_market_regime_filter_table(
                    synthesized,
                    db_path,
                    update_flash_ts=should_run_flash,
                    update_pro_ts=should_run_pro,
                )
                save_ai_briefings_to_db(
                    current_flash_result,
                    current_pro_result,
                    synthesized,
                    btc_summary,
                    flash_news_items,
                    db_path=db_path,
                    save_market=should_run_flash or should_run_pro,
                    save_news=should_run_flash,
                    flash_ran=should_run_flash,
                    pro_ran=should_run_pro,
                )

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
    news_items = fetch_recent_crypto_news_items(hours=4, limit=12)
    news_strs = [f"[{n.get('source', 'NEWS')}] {n.get('title', '')}" for n in news_items]
    live_ctx = fetch_live_context()
    open_p = live_ctx.get("open_tickers", [])

    print("[1/3] Testing Flash 30m Fast Analysis (Local Ollama -> Gemini Flash Fallback)...")
    flash_out = call_flash_fast_analysis(
        btc,
        news_items,
        open_p,
        live_bots=live_ctx.get("live_bots"),
        open_positions_detail=live_ctx.get("open_positions_detail"),
        fng=fng,
    )
    print("Flash Result:", json.dumps(flash_out, indent=2, ensure_ascii=False))

    print("\n[2/3] Testing Pro 1h In-Depth Analysis...")
    pro_out = call_pro_indepth_analysis(
        btc,
        fng,
        news_strs,
        open_p,
        live_bots=live_ctx.get("live_bots"),
        open_positions_detail=live_ctx.get("open_positions_detail"),
    )
    print("Pro Result:", json.dumps(pro_out, indent=2, ensure_ascii=False))

    print("\n[3/3] Testing Cross-Validation Decision Synthesis...")
    synth_out = synthesize_dual_decisions(flash_out, pro_out)
    print("Synthesized Result:", json.dumps(synth_out, indent=2, ensure_ascii=False))

    update_market_regime_filter_table(synth_out)
    save_ai_briefings_to_db(flash_out, pro_out, synth_out, btc, news_items)
    print("\nStandalone test cycle successfully finished!")
