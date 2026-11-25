# [Antigravity-Doc] ============================================================
# [Antigravity-Doc] 파일 역할: Python 트레이딩 봇 공통 리스크 게이트웨이, 5중 중복 주문 하드 가드레일, 매수/분할매도·Graceful Drain 정산 엔진 및 핵심 전략 워커(bot_vb/bot_momentum/bot_bb)
# [Antigravity-Doc] 아키텍처 위치: main_orchestrator.py와 agentBot/bot_10_jack_kellogg.py가 공통 참조하는 Python 주문·리스크·전략 코어 모듈
# [Antigravity-Doc] 주요 의존성: init_db.py(SQLite/PG 원장), market_hub.py(시세/OHLCV 캐시), pyupbit/requests/jwt(업비트 주문 API), pandas/numpy(ATR·BB·RSI)
# [Antigravity-Doc] 수정 시 주의사항:
# [Antigravity-Doc]   1) 실전 주문 생성(POST /v1/orders)에는 절대 맹목 재시도(retry_with_backoff)를 적용하지 말 것 (타임아웃 시 UNKNOWN_TIMEOUT 잠금 후 GET /v1/order?identifier=... 정산 필수)
# [Antigravity-Doc]   2) 매도 시 업비트 전체 잔고(get_balance)가 아닌 bot_positions.volume만 정확히 매도해 타 봇 포지션 침범 방지
# [Antigravity-Doc]   3) Graceful Drain 탈락 봇 청산 시 90% 상한 불변식(total_used_after <= global_cap_krw)을 절대 위반하지 말 것
# [Antigravity-Doc] ============================================================
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
from decimal import Decimal, InvalidOperation, ROUND_DOWN
import hashlib
import json
import logging
import math
import os
import socket
import sqlite3
import threading
import time
import urllib.parse
import uuid
from typing import Any, Dict, List, Optional, Tuple

import jwt
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

# [Antigravity-Doc] 업비트 원화 마켓 거래 핵심 상수 (수수료율 0.05%, 최소 주문 5,000원, -20% 손절 데드락 방지 안전 최소 주문 6,500원, KST 타임존)
UPBIT_FEE_RATE = 0.0005  # 업비트 원화 마켓 수수료 0.05%
MIN_ORDER_KRW = 5000.0   # 업비트 최소 주문 금액 5,000원
SAFE_MIN_ORDER_KRW = 6500.0  # -20% 손절 시에도 5,200원 유지 (업비트 5,000원 최소 매도 제한 데드락 방지)
KST_TZ = datetime.timezone(datetime.timedelta(hours=9))


# [Antigravity-Doc] 역할: 현재 KST 시각을 'YYYY-MM-DD HH:MM:SS' 문자열로 반환
def _now_kst_str() -> str:
    return datetime.datetime.now(KST_TZ).strftime("%Y-%m-%d %H:%M:%S")


# [Antigravity-Doc] 역할: 부동소수점 반올림 오차로 인한 잔고 초과 매도 실패를 방지하기 위해 Decimal 소수점 8자리 내림(ROUND_DOWN) 변환
def _to_decimal_volume_8(vol: Any) -> Decimal:
    """Decimal 기반 소수점 8자리 내림(ROUND_DOWN) 수량을 반환합니다."""
    try:
        if vol is None:
            return Decimal("0")
        raw = str(vol).strip()
        if not raw:
            return Decimal("0")
        d = Decimal(raw)
        if not d.is_finite() or d <= 0:
            return Decimal("0")
        return d.quantize(Decimal("0.00000001"), rounding=ROUND_DOWN)
    except (InvalidOperation, ValueError, TypeError):
        return Decimal("0")


def round_down_volume_8(vol: Any) -> float:
    """업비트 주문 수량을 Decimal 기반 소수점 8자리 내림(ROUND_DOWN) 처리합니다."""
    d = _to_decimal_volume_8(vol)
    return float(d) if d > 0 else 0.0


def format_volume_8(vol: Any) -> str:
    """지수 표기법(5e-05 등) 없이 고정 소수점 8자리 문자열로 직렬화합니다."""
    d = _to_decimal_volume_8(vol)
    if d <= 0:
        return "0"
    return f"{d:.8f}"


# [Antigravity-Doc] 역할: TCP 포트 연결(기본 8001) 및 logs/.backend.pid 생존 여부로 Node.js 백엔드 기동 상태 감지 (이중 주문 방지)
def is_backend_running(port: Optional[int] = None) -> bool:
    """
    Node.js 백엔드(BACKEND_PORT/PORT, 기본 8001)가 기동 중인지 검사합니다.
    백엔드가 자체적으로 실전/가상 매매 루프를 실행 중인 경우,
    Python 봇 프로세스가 동일한 주문을 중복 실행(Double Execution)하지 않도록 방어합니다.
    """
    import socket
    raw_port = str(port if port is not None else (os.getenv("BACKEND_PORT") or os.getenv("PORT") or "8001")).strip()
    try:
        target_port = int(raw_port) if raw_port else 8001
    except ValueError:
        target_port = 8001
    target_host = (os.getenv("BACKEND_HOST") or "127.0.0.1").strip() or "127.0.0.1"
    if target_host in ("0.0.0.0", "::"):
        target_host = "127.0.0.1"
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.25)
            if s.connect_ex((target_host, target_port)) == 0:
                return True
    except Exception:
        pass
    try:
        pid_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs", ".backend.pid")
        if os.path.isfile(pid_path):
            with open(pid_path, "r", encoding="utf-8") as f:
                pid = int(f.read().strip())
            try:
                os.kill(pid, 0)
                return True
            except PermissionError:
                return True
    except Exception:
        pass
    return False


# [Antigravity-Doc] 역할: 구버전 별칭(bot_vb, bot_momentum, bot_bb, bot_kellogg 등)을 표준 ID(bot_01~bot_10)로 일관 정규화
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


# =====================================================================
# 0. 실전 중복 주문 원천 차단 5중 하드 가드레일 (Python 측)
# =====================================================================
# [Antigravity-Doc] 5중 실전 가드레일 전역 상태: 사이클 고착 경보 기준(180초), 분할 매수 허용 봇 집합(bot_06/bot_10), 스레드 안전 사이클 뮤텍스
LIVE_CYCLE_STALE_WARN_SEC = 180.0
SPLIT_ALLOWED_BOTS = {"bot_06", "bot_10"}
_LIVE_CYCLE_MUTEX_LOCK = threading.Lock()
_LIVE_CYCLE_STATE: Dict[str, Dict[str, Any]] = {}


def _now_utc_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def _today_start_kst_utc_iso() -> str:
    now_kst = datetime.datetime.now(KST_TZ)
    midnight_kst = now_kst.replace(hour=0, minute=0, second=0, microsecond=0)
    return midnight_kst.astimezone(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


# [Antigravity-Doc] 역할: 15분 캔들 버킷 기반 매수 멱등성 키 생성 (형식: "{bot_id}:{ticker}:{YYYYMMDDTHHMM}:s{step_level}")
def _build_py_buy_bucket(bot_id: str, ticker: str, step_level: int = 1) -> str:
    now_kst = datetime.datetime.now(KST_TZ)
    floored_min = (now_kst.minute // 15) * 15
    candle_key = now_kst.replace(minute=floored_min, second=0, microsecond=0).strftime("%Y%m%dT%H%M")
    return f"{normalize_bot_id(bot_id)}:{str(ticker).strip().upper()}:{candle_key}:s{max(1, int(step_level or 1))}"


def _load_upbit_config_json() -> Dict[str, Any]:
    cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config", "upbit_config.json")
    if os.path.isfile(cfg_path):
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    return data
        except Exception:
            pass
    return {}


# [Antigravity-Doc] 역할: [Layer 1] 단일 실전 실행 주체(LIVE_EXECUTOR_OWNER)를 env -> config JSON -> 기본값('node') 순으로 조회
def get_live_executor_owner() -> str:
    """
    단일 실전 주문 실행 주체(LIVE_EXECUTOR_OWNER) 반환 (기본값: 'node').
    'python'으로 명시되지 않은 경우 Python 측 모든 실전 주문 API(POST /v1/orders) 진입을 원천 차단합니다.
    """
    env_val = str(os.getenv("LIVE_EXECUTOR_OWNER") or "").strip().lower()
    if env_val in ("node", "python"):
        return env_val
    cfg_val = str(_load_upbit_config_json().get("live_executor_owner") or "").strip().lower()
    if cfg_val in ("node", "python"):
        return cfg_val
    return "node"


def is_python_live_executor_authorized() -> bool:
    return get_live_executor_owner() == "python"


def _get_guardrail_int(conn, setting_key: str, env_key: str, default_val: int) -> int:
    try:
        row = conn.execute("SELECT value FROM system_settings WHERE key = ?;", (setting_key,)).fetchone()
        if row and str(dict(row).get("value") or "").strip():
            v = int(float(str(dict(row)["value"]).strip()))
            if v > 0:
                return v
    except Exception:
        pass
    try:
        raw = str(os.getenv(env_key) or "").strip()
        if raw:
            v = int(float(raw))
            if v > 0:
                return v
    except Exception:
        pass
    return default_val


def _ensure_py_guardrail_tables(conn) -> None:
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS live_executor_lease (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                owner_id TEXT NOT NULL,
                pid INTEGER NOT NULL,
                host TEXT NOT NULL,
                acquired_at TEXT NOT NULL,
                heartbeat_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS live_order_intents (
                intent_id TEXT PRIMARY KEY,
                bot_id TEXT NOT NULL,
                market TEXT NOT NULL,
                side TEXT NOT NULL,
                intent_bucket TEXT NOT NULL,
                requested_krw INTEGER DEFAULT 0,
                requested_volume TEXT DEFAULT '0',
                target_position_uuid TEXT,
                upbit_order_uuid TEXT,
                status TEXT NOT NULL,
                refunded INTEGER NOT NULL DEFAULT 0,
                error_message TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(bot_id, market, side, intent_bucket)
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS live_guardrail_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                bot_id TEXT NOT NULL,
                market TEXT DEFAULT '',
                side TEXT DEFAULT 'BUY',
                block_code TEXT NOT NULL,
                reason TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )
    except Exception:
        pass


def _parse_iso_ts(val: str) -> float:
    try:
        s = str(val or "").strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.datetime.fromisoformat(s).timestamp()
    except Exception:
        return 0.0


# [Antigravity-Doc] 역할: [Layer 1] DB live_executor_lease(id=1) 단일 리스 락을 BEGIN IMMEDIATE 트랜잭션으로 원자적 획득/연장 (타 프로세스 점유 중이면 거부)
def acquire_live_executor_lease(db_path: Optional[str] = None, ttl_sec: int = 30) -> Tuple[bool, str]:
    """
    [Layer 1] SQLite BEGIN IMMEDIATE 트랜잭션으로 live_executor_lease(id=1)를 원자적 획득/갱신합니다.
    LIVE_EXECUTOR_OWNER != 'python' 이거나 다른 유효 프로세스가 리스를 점유 중이면 즉시 거부합니다.
    """
    if not is_python_live_executor_authorized():
        return False, f"LIVE_EXECUTOR_OWNER='{get_live_executor_owner()}' (Python live execution blocked)"
    conn = get_db_connection(db_path)
    try:
        _ensure_py_guardrail_tables(conn)
        owner_id = "python"
        pid = os.getpid()
        host = socket.gethostname()
        now_ts = time.time()
        now_iso = _now_utc_iso()
        exp_iso = datetime.datetime.fromtimestamp(now_ts + max(5, int(ttl_sec)), tz=datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        conn.execute("BEGIN IMMEDIATE;")
        row = conn.execute("SELECT * FROM live_executor_lease WHERE id = 1;").fetchone()
        if row:
            r = dict(row)
            is_same = str(r.get("owner_id")) == owner_id and int(r.get("pid") or 0) == pid and str(r.get("host")) == host
            is_expired = _parse_iso_ts(r.get("expires_at") or "") <= now_ts
            if not is_same and not is_expired:
                conn.rollback()
                return False, f"LEASE_HELD_BY_OTHER(owner={r.get('owner_id')}, pid={r.get('pid')}, host={r.get('host')})"
            acq = r.get("acquired_at") if is_same and r.get("acquired_at") else now_iso
            conn.execute(
                """
                UPDATE live_executor_lease
                SET owner_id = ?, pid = ?, host = ?, acquired_at = ?, heartbeat_at = ?, expires_at = ?
                WHERE id = 1;
                """,
                (owner_id, pid, host, acq, now_iso, exp_iso),
            )
        else:
            conn.execute(
                """
                INSERT INTO live_executor_lease (id, owner_id, pid, host, acquired_at, heartbeat_at, expires_at)
                VALUES (1, ?, ?, ?, ?, ?, ?);
                """,
                (owner_id, pid, host, now_iso, now_iso, exp_iso),
            )
        conn.commit()
        return True, "OK"
    except Exception as exc:
        try:
            conn.rollback()
        except Exception:
            pass
        return False, f"LEASE_ERROR: {exc}"
    finally:
        conn.close()


def release_live_executor_lease(db_path: Optional[str] = None) -> None:
    conn = get_db_connection(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE;")
        conn.execute(
            "DELETE FROM live_executor_lease WHERE id = 1 AND owner_id = 'python' AND pid = ? AND host = ?;",
            (os.getpid(), socket.gethostname()),
        )
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
    finally:
        conn.close()


def acquire_live_cycle_mutex(bot_id: str) -> bool:
    """[Phase 3] 실전 워커 비동기/루프 중첩 방지 뮤텍스 (180초 초과 고착 시 경고 후 안전 복구)"""
    key = normalize_bot_id(bot_id)
    now_ts = time.time()
    with _LIVE_CYCLE_MUTEX_LOCK:
        st = _LIVE_CYCLE_STATE.get(key)
        if st and st.get("running"):
            elapsed = now_ts - float(st.get("started_at") or now_ts)
            if elapsed > LIVE_CYCLE_STALE_WARN_SEC:
                logger.warning(
                    "[%s][LiveCycleMutex] Previous cycle exceeded %.0fs (>180s). Performing safe recovery reset.",
                    key,
                    elapsed,
                )
            else:
                return False
        _LIVE_CYCLE_STATE[key] = {"running": True, "started_at": now_ts}
        return True


def release_live_cycle_mutex(bot_id: str) -> None:
    key = normalize_bot_id(bot_id)
    with _LIVE_CYCLE_MUTEX_LOCK:
        _LIVE_CYCLE_STATE[key] = {"running": False, "started_at": 0.0}


def _create_upbit_jwt_py(access_key: str, secret_key: str, query_params: Optional[Dict[str, Any]] = None) -> str:
    payload: Dict[str, Any] = {
        "access_key": access_key,
        "nonce": str(uuid.uuid4()),
    }
    if query_params:
        qs = urllib.parse.urlencode(query_params).encode("utf-8")
        m = hashlib.sha512()
        m.update(qs)
        payload["query_hash"] = m.hexdigest()
        payload["query_hash_alg"] = "SHA512"
    token = jwt.encode(payload, secret_key, algorithm="HS256")
    return token.decode("utf-8") if isinstance(token, bytes) else str(token)


# [Antigravity-Doc] 역할: [Layer 2] 업비트 POST /v1/orders 직접 호출 (SHA512 query_hash JWT 서명 + identifier 멱등성 키 포함, 맹목 재시도 금지)
def _py_post_upbit_order_with_identifier(params: Dict[str, Any]) -> Tuple[int, Optional[Dict[str, Any]], Optional[str]]:
    """
    업비트 POST /v1/orders 직접 호출 (identifier 포함, 맹목 재시도 절대 금지).
    Returns: (http_status, json_body_or_none, network_error_or_none)
    """
    if not is_python_live_executor_authorized():
        return 403, None, f"LIVE_EXECUTOR_OWNER='{get_live_executor_owner()}' blocks Python POST /v1/orders"
    access = os.getenv("UPBIT_ACCESS_KEY", "").strip()
    secret = os.getenv("UPBIT_SECRET_KEY", "").strip()
    if not access or not secret:
        return 401, None, "Missing Upbit API keys"
    try:
        token = _create_upbit_jwt_py(access, secret, params)
        resp = requests.post(
            "https://api.upbit.com/v1/orders",
            json=params,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            timeout=8.0,
        )
        try:
            body = resp.json()
        except Exception:
            body = None
        return resp.status_code, body, None
    except Exception as exc:
        return 0, None, str(exc)


def _py_get_upbit_order_by_identifier(identifier: str) -> Tuple[int, Optional[Dict[str, Any]], Optional[str]]:
    access = os.getenv("UPBIT_ACCESS_KEY", "").strip()
    secret = os.getenv("UPBIT_SECRET_KEY", "").strip()
    if not access or not secret:
        return 401, None, "Missing Upbit API keys"
    try:
        q = {"identifier": identifier}
        token = _create_upbit_jwt_py(access, secret, q)
        resp = requests.get(
            f"https://api.upbit.com/v1/order?identifier={urllib.parse.quote(identifier)}",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            timeout=8.0,
        )
        try:
            body = resp.json()
        except Exception:
            body = None
        return resp.status_code, body, None
    except Exception as exc:
        return 0, None, str(exc)


# [Antigravity-Doc] 역할: [Layer 5] 이상 행위(음수 잔고, 미해결 타임아웃 누적, 반복 차단) 감지 시 봇 가동 중지(is_running=0) 및 비상 정지 플래그 기록
def _py_trip_kill_switch_in_tx(conn, bot_id: str, code: str, reason: str, halt_all: bool = False) -> None:
    now_kst = _now_kst_str()
    msg = f"[🚨 가드레일 비상 정지:{code}] {reason}"
    targets = [bot_id]
    if halt_all:
        rows = conn.execute("SELECT bot_id FROM bots WHERE is_selected_for_live = 1 OR is_running = 1;").fetchall()
        targets = list(dict.fromkeys(targets + [dict(r)["bot_id"] for r in rows]))
    for bid in targets:
        conn.execute(
            "UPDATE bots SET is_running = 0, last_status_msg = ?, updated_at = ? WHERE bot_id = ?;",
            (msg, now_kst, bid),
        )
    for k, v in (
        ("guardrail_emergency_halted", "1"),
        ("guardrail_emergency_code", code),
        ("guardrail_emergency_reason", msg),
        ("guardrail_emergency_at", now_kst),
    ):
        conn.execute(
            "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?);",
            (k, v, now_kst),
        )


NON_ANOMALY_PACE_BLOCK_CODES = frozenset({"MIN_BUY_INTERVAL", "REENTRY_COOLDOWN"})


def _py_record_block_in_tx(conn, bot_id: str, ticker: str, code: str, reason: str) -> None:
    now_iso = _now_utc_iso()
    conn.execute(
        "INSERT INTO live_guardrail_events (bot_id, market, side, block_code, reason, created_at) VALUES (?, ?, 'BUY', ?, ?, ?);",
        (bot_id, ticker, code, reason, now_iso),
    )
    win_sec = _get_guardrail_int(conn, "live_anomaly_window_sec", "LIVE_ANOMALY_WINDOW_SEC", 300)
    thresh = _get_guardrail_int(conn, "live_anomaly_block_threshold", "LIVE_ANOMALY_BLOCK_THRESHOLD", 5)
    cutoff_iso = datetime.datetime.fromtimestamp(time.time() - win_sec, tz=datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    cnt_row = conn.execute(
        "SELECT COUNT(*) AS cnt FROM live_guardrail_events WHERE bot_id = ? AND side = 'BUY' AND created_at >= ? AND block_code NOT IN ('MIN_BUY_INTERVAL', 'REENTRY_COOLDOWN');",
        (bot_id, cutoff_iso),
    ).fetchone()
    cnt = int(dict(cnt_row).get("cnt") or 0) if cnt_row else 0
    if code not in NON_ANOMALY_PACE_BLOCK_CODES and cnt >= thresh:
        _py_trip_kill_switch_in_tx(
            conn,
            bot_id,
            "REPEATED_BLOCK_ANOMALY",
            f"최근 {win_sec // 60}분 내 차단 {cnt}회 누적(최근: {code})으로 자동 비상 정지",
            halt_all=False,
        )


# [Antigravity-Doc] 역할: [Layer 2] 네트워크 타임아웃으로 체결 여부가 불확실한 UNKNOWN_TIMEOUT 인텐트를 GET /v1/order?identifier=...로 대조 정산 (404면 안전 환불/락 해제, 200 체결이면 포지션 반영 및 차액 환불)
def reconcile_python_unknown_timeout_intents(db_path: Optional[str] = None) -> Dict[str, int]:
    """[Layer 2] Python 측 미해결 UNKNOWN_TIMEOUT 인텐트를 GET /v1/order?identifier=... 로 정산합니다."""
    summary = {"checked": 0, "confirmed": 0, "refunded": 0, "pending": 0}
    if not is_python_live_executor_authorized():
        return summary
    conn = get_db_connection(db_path)
    try:
        _ensure_py_guardrail_tables(conn)
        rows = conn.execute(
            "SELECT * FROM live_order_intents WHERE status = 'UNKNOWN_TIMEOUT' ORDER BY created_at ASC;"
        ).fetchall()
        for row in rows:
            it = dict(row)
            summary["checked"] += 1
            intent_id = it["intent_id"]
            status_code, detail, net_err = _py_get_upbit_order_by_identifier(intent_id)
            if status_code == 404:
                now_iso = _now_utc_iso()
                now_kst = _now_kst_str()
                conn.execute("BEGIN IMMEDIATE;")
                upd = conn.execute(
                    """
                    UPDATE live_order_intents
                    SET status = 'FAILED_NOT_CREATED', refunded = 1, error_message = '404 order_not_found', updated_at = ?
                    WHERE intent_id = ? AND refunded = 0;
                    """,
                    (now_iso, intent_id),
                )
                if upd.rowcount == 1 and it.get("side") == "BUY" and int(it.get("requested_krw") or 0) > 0:
                    req_krw = int(it["requested_krw"])
                    conn.execute("UPDATE bots SET virtual_krw = virtual_krw + ?, updated_at = ? WHERE bot_id = ?;", (req_krw, now_kst, it["bot_id"]))
                    conn.execute("UPDATE bot_accounts SET virtual_krw = virtual_krw + ?, updated_at = ? WHERE bot_id = ?;", (req_krw, now_kst, it["bot_id"]))
                elif it.get("side") == "SELL" and it.get("target_position_uuid"):
                    conn.execute(
                        "UPDATE bot_positions SET closing_lock = 0 WHERE order_uuid = ? AND status = 'OPEN';",
                        (it["target_position_uuid"],),
                    )
                conn.commit()
                summary["refunded"] += 1
            elif status_code == 200 and isinstance(detail, dict):
                filled = round_down_volume_8(detail.get("executed_volume") or 0)
                if filled > 0 and it.get("side") == "BUY":
                    order_uuid = str(detail.get("uuid") or f"upbit-{intent_id}")
                    now_iso = _now_utc_iso()
                    now_kst = _now_kst_str()
                    conn.execute("BEGIN IMMEDIATE;")
                    exists = conn.execute("SELECT id FROM bot_positions WHERE order_uuid = ?;", (order_uuid,)).fetchone()
                    if not exists:
                        trades = detail.get("trades") or []
                        total_funds = sum(float(t.get("funds") or 0.0) for t in trades if isinstance(t, dict))
                        exec_price = (total_funds / filled) if total_funds > 0 else float(detail.get("price") or 0.0)
                        buy_amt = int(math.floor(total_funds if total_funds > 0 else filled * exec_price))
                        buy_fee = float(detail.get("paid_fee") or (buy_amt * UPBIT_FEE_RATE))
                        vol_str = format_volume_8(filled)
                        t_cur = conn.execute(
                            "INSERT INTO trades (bot_id, market, buy_order_uuid, buy_price, buy_volume, buy_amount, buy_date, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'HOLDING');",
                            (it["bot_id"], it["market"], order_uuid, exec_price, vol_str, buy_amt, now_kst),
                        )
                        trade_id = int(getattr(t_cur.cur, "lastrowid", 0) or 0)
                        conn.execute(
                            """
                            INSERT INTO bot_positions (bot_id, market, ticker, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id, highest_price, step_level, status, created_at, buy_reason, closing_lock)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'OPEN', ?, '[타임아웃 정산]', 0);
                            """,
                            (it["bot_id"], it["market"], it["market"], order_uuid, vol_str, exec_price, buy_amt, buy_fee, trade_id, exec_price, now_kst),
                        )
                    upd = conn.execute(
                        "UPDATE live_order_intents SET upbit_order_uuid = ?, status = 'CONFIRMED', refunded = 1, updated_at = ? WHERE intent_id = ? AND refunded = 0;",
                        (order_uuid, now_iso, intent_id),
                    )
                    if upd.rowcount == 1:
                        req_krw = int(it.get("requested_krw") or 0)
                        trades = detail.get("trades") or []
                        total_funds = sum(float(t.get("funds") or 0.0) for t in trades if isinstance(t, dict))
                        spent = int(math.floor(total_funds + float(detail.get("paid_fee") or 0.0))) if total_funds > 0 else req_krw
                        surplus = max(0, req_krw - spent)
                        if surplus > 0:
                            conn.execute("UPDATE bots SET virtual_krw = virtual_krw + ?, updated_at = ? WHERE bot_id = ?;", (surplus, now_kst, it["bot_id"]))
                            conn.execute("UPDATE bot_accounts SET virtual_krw = virtual_krw + ?, updated_at = ? WHERE bot_id = ?;", (surplus, now_kst, it["bot_id"]))
                    conn.commit()
                    summary["confirmed"] += 1
                else:
                    summary["pending"] += 1
            else:
                summary["pending"] += 1
    except Exception as exc:
        logger.warning("[Guardrail] Python timeout reconciliation error: %s", exc)
    finally:
        conn.close()
    return summary


# [Antigravity-Doc] 역할: 돌파형 봇의 가짜 돌파(윗꼬리 > 45% 또는 종가 고점 대비 하위 65% 이하) 및 20MA/VWAP +6% 이상 과열 추격 매수 차단 필터
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


# [Antigravity-Doc] 역할: 전 봇 공용 3단계 스마트 청산 평가기 — (1) 본절 스탑(+1.2% -> +0.25%) (2) KST 기준 시간 제한 청산 (3) ATR(-2.2x 하드손절, -1.8x 트레일링; bot_06/bot_10 Setup B는 하드손절 예외)
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
            "reason": f"BREAKEVEN_STOP: Peak +{peak_pnl_pct:.2f}% dropped to {pnl_pct:+.2f}%",
        }

    # 2. 시간 제한 청산 (Time-Stop, KST 기준 통일 — UTC 호스트 +9시간 왜곡 방지)
    time_stop_bots = {"bot_01", "bot_04", "bot_05", "bot_09", "bot_10"}
    if norm_id in time_stop_bots:
        created_str = open_pos.get("created_at") or open_pos.get("opened_at")
        if created_str:
            try:
                raw_ts = str(created_str).strip()
                if raw_ts.endswith("Z"):
                    entry_dt = datetime.datetime.fromisoformat(raw_ts.replace("Z", "+00:00")).astimezone(KST_TZ)
                elif "+" in raw_ts[10:] or "-" in raw_ts[10:]:
                    entry_dt = datetime.datetime.fromisoformat(raw_ts).astimezone(KST_TZ)
                else:
                    dt_str = raw_ts.replace("T", " ").split(".")[0]
                    entry_dt = datetime.datetime.strptime(dt_str, "%Y-%m-%d %H:%M:%S").replace(tzinfo=KST_TZ)
                elapsed_hours = (datetime.datetime.now(KST_TZ) - entry_dt).total_seconds() / 3600.0
                max_hours = 4.0 if is_live else 2.0

                in_box = (-0.6 <= pnl_pct <= 0.8)
                if elapsed_hours >= max_hours and in_box and rvol < 1.0:
                    return {
                        "signal": "SELL",
                        "reason": f"TIME_STOP: {elapsed_hours:.1f}h elapsed (box {pnl_pct:+.2f}%, RVOL {rvol:.1f}x)",
                    }
            except Exception:
                pass

    # 3. ATR 기반 동적 트레일링 스탑 (다단계 분할 그리드 bot_06 및 bot_10 Setup B 반등 물타기는 ATR 하드 손절 예외)
    buy_reason = str(open_pos.get("buy_reason") or "")
    is_grid_or_dip_scale = (
        norm_id == "bot_06"
        or (norm_id == "bot_10" and ("반등" in buy_reason or "Setup B" in buy_reason or "SETUP_B" in buy_reason))
    )
    if atr > 0 and math.isfinite(atr):
        if not is_grid_or_dip_scale:
            hard_stop_price = avg_buy - (2.2 * atr)
            if current_price <= hard_stop_price:
                return {
                    "signal": "SELL",
                    "reason": f"ATR_HARD_STOP: -2.2xATR ({hard_stop_price:,.0f} KRW) hit (PnL {pnl_pct:+.2f}%)",
                }

        if peak_pnl_pct >= 1.0:
            trailing_stop_price = highest_price - (1.8 * atr)
            if trailing_stop_price > avg_buy and current_price <= trailing_stop_price:
                return {
                    "signal": "SELL",
                    "reason": f"ATR_TRAILING_STOP: -1.8xATR from peak ({trailing_stop_price:,.0f} KRW) hit (PnL {pnl_pct:+.2f}%)",
                }
    elif not is_grid_or_dip_scale:
        fixed_stop = -abs(float(stop_loss_pct or 2.5))
        if pnl_pct <= fixed_stop:
            return {
                "signal": "SELL",
                "reason": f"FIXED_STOP_LOSS: PnL {pnl_pct:+.2f}% <= {fixed_stop:.2f}%",
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

# [Antigravity-Doc] 역할: 전 봇 공용 매수 진입 게이트웨이 — 백엔드 공존/실전 주체 검증 -> 가상모드 바이패스 -> 실전 일일 -4% 서킷브레이커 -> Graceful Drain 차단 -> 듀얼 AI 필터(risk_alert/action/bot_overrides/blacklist/multiplier) -> BTC 20MA 감축 -> 수수료 반영 최종 투입금 산출
# [Antigravity-Doc] 입력: bot_id, ticker, available_krw, db_path, is_paper | 반환: Tuple[bool(진입허용), float(투입원화), str(사유코드)]
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

    # Node.js 백엔드가 실행 중이면 실전/모의 주문 중복 실행(Double Execution) 방지를 위해 Python 주문 디퍼
    if not is_paper and is_backend_running():
        return (
            False,
            0.0,
            f"DEFERRED_TO_NODEJS_BACKEND: Active Node.js backend manages trading for {norm_id}",
        )

    # [Phase 1 하드 가드레일] LIVE_EXECUTOR_OWNER != 'python' 인 경우 Python 실전 매수 진입 원천 차단
    if not is_paper and not is_dry_run() and not is_python_live_executor_authorized():
        owner = get_live_executor_owner()
        logger.warning(
            "[Guardrail][LIVE_EXECUTOR_OWNER=%s] Blocked Python live can_enter_position for %s (%s)",
            owner,
            norm_id,
            ticker,
        )
        return (
            False,
            0.0,
            f"LIVE_EXECUTOR_OWNER_MISMATCH: LIVE_EXECUTOR_OWNER='{owner}' blocks Python live entry",
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
            today_start = datetime.datetime.now(KST_TZ).strftime("%Y-%m-%d 00:00:00")
            loss_row = conn.execute(
                "SELECT COUNT(*) AS cnt, COALESCE(SUM(profit_krw), 0) AS daily_profit FROM trades WHERE (bot_id = ? OR bot_id = ?) AND status IN ('CLOSED', 'COMPLETED') AND sell_date >= ?;",
                (bot_id, norm_id, today_start),
            ).fetchone()
            trades_cnt = int(loss_row["cnt"]) if loss_row else 0
            daily_profit = float(loss_row["daily_profit"]) if loss_row else 0.0
            if trades_cnt == 0:
                pos_loss_row = conn.execute(
                    "SELECT COALESCE(SUM(realized_pnl), 0) AS daily_profit FROM bot_positions WHERE (bot_id = ? OR bot_id = ?) AND status = 'CLOSED' AND closed_at >= ?;",
                    (bot_id, norm_id, today_start),
                ).fetchone()
                if pos_loss_row:
                    daily_profit = float(pos_loss_row["daily_profit"] or 0.0)
            bot_row = conn.execute("SELECT allocated_capital FROM bots WHERE bot_id = ?;", (norm_id,)).fetchone()
            if bot_row is None:
                bot_row = conn.execute("SELECT allocated_capital FROM bot_accounts WHERE bot_id = ?;", (norm_id,)).fetchone()
            allocated_cap = float(bot_row["allocated_capital"]) if bot_row else 0.0
            loss_limit = -math.floor(allocated_cap * 0.04) if allocated_cap > 0 else -40000.0
            if allocated_cap > 0 and daily_profit <= loss_limit:
                return (
                    False,
                    0.0,
                    f"CIRCUIT_BREAKER_ACTIVE: Daily loss {daily_profit:,.0f} KRW exceeded -4.0% limit ({loss_limit:,.0f} KRW)",
                )

        # 0-2. 실전 선택 봇 & 가동 상태 & 최소 주문금액(5,050원) 복원 대기 확인 (Graceful Drain 중인 해제 봇은 신규 매수 절대 차단)
        if not is_paper and not is_dry_run():
            try:
                live_bot_row = conn.execute(
                    "SELECT is_selected_for_live, is_running, COALESCE(virtual_krw, 0) AS virtual_krw FROM bots WHERE bot_id = ?;",
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
                    v_krw = float(lb.get("virtual_krw") or 0.0)
                    if 0 <= v_krw < 5050.0:
                        return (
                            False,
                            0.0,
                            f"WAITING_CAPITAL_RESTORE: {norm_id} virtual_krw ({v_krw:,.0f}) < 5,050 KRW safe minimum",
                        )
                else:
                    acc_live_row = conn.execute(
                        "SELECT is_selected_for_live FROM bot_accounts WHERE bot_id = ?;",
                        (norm_id,),
                    ).fetchone()
                    if acc_live_row is not None and int(dict(acc_live_row).get("is_selected_for_live") or 0) != 1:
                        return (
                            False,
                            0.0,
                            f"Live Gateway Blocked: {norm_id} is in Graceful Drain (bot_accounts)",
                        )
            except Exception as gw_exc:
                logger.warning("[%s] Live selection gateway check failed: %s", norm_id, gw_exc)

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

        # 2. 기술적 대장주 필터 (BTC 일봉 20MA 참고 감축 - market_hub 캐시 공유)
        btc_price = get_safe_current_price("KRW-BTC")
        if btc_price > 0:
            try:
                btc_df = get_cached_ohlcv("KRW-BTC", interval="day", count=25)
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

# [Antigravity-Doc] 역할: 시장가 슬리피지 방어용 최유리 지정가 주문 + 최대 timeout_sec(기본 40초) 3초 간격 폴링 + 미체결 잔여분 취소 래퍼
# [Antigravity-Doc] 주의: 네트워크/5xx 오류 시 맹목 재시도하지 않고 {"uncertain_timeout": True}를 반환하여 상위에서 UNKNOWN_TIMEOUT 정산 유도
def execute_limit_order_with_polling(
    upbit: pyupbit.Upbit,
    side: str,  # "bid" or "ask"
    ticker: str,
    price: float,
    volume: float,
    timeout_sec: int = 40,
    identifier: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """
    시장가 슬리피지 방어를 위한 최유리 지정가 주문 및 최대 40초 폴링 래퍼.
    - Phase 1/2 하드 가드레일: LIVE_EXECUTOR_OWNER='python' 검증, identifier 포함, 주문 생성 맹목 재시도 금지.
    - 미체결 시 주문 취소(cancel_order) 및 체결 수량/수수료 확인.
    """
    if not is_dry_run() and not is_python_live_executor_authorized():
        logger.warning(
            "[Guardrail][LIVE_EXECUTOR_OWNER=%s] Blocked Python limit order (%s %s)",
            get_live_executor_owner(),
            side,
            ticker,
        )
        return None

    vol_rounded = round_down_volume_8(volume)
    if vol_rounded <= 0:
        logger.warning("[%s %s] Rounded volume <= 0 (%s)", side, ticker, volume)
        return None
    price_val = float(price)
    order_uuid = ""
    try:
        # 실제 pyupbit.Upbit 클라이언트이고 identifier가 주어지면 업비트 REST POST /v1/orders 로 identifier 멱등성 직접 전송 (절대 맹목 재시도 금지)
        if identifier and isinstance(upbit, pyupbit.Upbit) and os.getenv("UPBIT_ACCESS_KEY", "").strip() and os.getenv("UPBIT_SECRET_KEY", "").strip():
            params = {
                "market": ticker,
                "side": side,
                "volume": format_volume_8(vol_rounded),
                "price": str(price_val),
                "ord_type": "limit",
                "identifier": str(identifier),
            }
            status_code, body, net_err = _py_post_upbit_order_with_identifier(params)
            if net_err or status_code >= 500 or status_code == 0:
                return {"uncertain_timeout": True, "error": net_err or f"HTTP {status_code}"}
            if status_code not in (200, 201) or not isinstance(body, dict) or "uuid" not in body:
                logger.warning("[%s %s] Limit order rejected (HTTP %s): %s", side, ticker, status_code, body)
                return None
            order_uuid = str(body["uuid"])
        else:
            # 맹목 재시도 금지: 단일 호출만 수행
            if side == "bid":
                res = upbit.buy_limit_order(ticker, price_val, vol_rounded)
            else:
                res = upbit.sell_limit_order(ticker, price_val, vol_rounded)
            if not res or "uuid" not in res:
                logger.warning("[%s %s] Limit order placement failed or returned no uuid: %s", side, ticker, res)
                return None
            order_uuid = res["uuid"]
    except Exception as exc:
        logger.warning("[%s %s] Limit order error (uncertain): %s", side, ticker, exc)
        return {"uncertain_timeout": True, "error": str(exc)}

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


# [Antigravity-Doc] 역할: 매수 주문 실행 및 원장(trades, bot_positions, bot_accounts, bots) 원자적 기록 (실전 모드 2단계 커밋: Step A 5중 가드레일 선점·선차감 -> Step B 지정가 주문 전송 -> 확정 정산 또는 미체결 1회 안전 환불)
# [Antigravity-Doc] 입력: bot_id, ticker, invest_krw, step_level(분할 차수), db_path, buy_reason | 반환: 체결 요약 dict 또는 차단/실패 시 None
def execute_buy_order(
    bot_id: str,
    ticker: str,
    invest_krw: float,
    step_level: int = 1,
    db_path: Optional[str] = None,
    buy_reason: str = "",
) -> Optional[Dict[str, Any]]:
    """
    매수 주문 실행 및 SQLite 가상 원장(bot_positions, trades, bot_accounts, bots) 원자적 업데이트:
    - DRY_RUN 모드: 실시간 시세 기준 가상 주문 생성
    - LIVE 모드: 최유리 지정가 주문 우선(미체결 폴링 취소) 후 필요 시 시장가 폴백
    - bot_accounts/bots의 virtual_krw 차감 및 bot_positions + trades 행 추가
    """
    norm_bot_id = normalize_bot_id(bot_id)

    # Node.js 백엔드가 매매를 관장 중인 경우 Python 중복 주문 차단 (실전/DRY_RUN 공통)
    if is_backend_running():
        logger.info("[%s] Node.js backend is active. Deferring buy order to backend.", norm_bot_id)
        return None

    conn = get_db_connection(db_path)
    try:
        _ensure_py_guardrail_tables(conn)
        dry = is_dry_run()
        upbit = get_upbit_client()

        # [Layer 1 하드 가드레일] 실전 모드에서 LIVE_EXECUTOR_OWNER != 'python' 이면 즉시 차단
        if not dry:
            if not is_python_live_executor_authorized():
                logger.warning(
                    "[Guardrail][LIVE_EXECUTOR_OWNER=%s] HARD BLOCK Python live BUY for %s (%s)",
                    get_live_executor_owner(),
                    norm_bot_id,
                    ticker,
                )
                return None
            lease_ok, lease_reason = acquire_live_executor_lease(db_path=db_path)
            if not lease_ok:
                logger.warning("[%s] Live BUY blocked by lease lock: %s", norm_bot_id, lease_reason)
                return None

        current_price = get_safe_current_price(ticker)
        if current_price <= 0:
            logger.error("[%s] Cannot execute buy: Invalid price for %s", norm_bot_id, ticker)
            return None

        invest_krw = float(math.floor(float(invest_krw)))
        if not math.isfinite(invest_krw) or invest_krw < MIN_ORDER_KRW:
            logger.error("[%s] Cannot execute buy: Invalid invest_krw=%s for %s", norm_bot_id, invest_krw, ticker)
            return None
        buy_fee = invest_krw * UPBIT_FEE_RATE
        # 지정가 주문 시 can_enter_position에서 이미 수수료 버퍼를 적용했으므로 이중 차감하지 않고, DRY_RUN/시장가는 원금 내 수수료 반영
        limit_volume = round_down_volume_8(invest_krw / current_price)
        volume = round_down_volume_8((invest_krw - buy_fee) / current_price)
        if volume <= 0 or limit_volume <= 0:
            logger.error("[%s] Cannot execute buy: Computed volume <= 0 for %s", norm_bot_id, ticker)
            return None
        order_uuid = f"sim-buy-{uuid.uuid4().hex[:12]}"
        executed_price = current_price
        live_intent_id: Optional[str] = None
        reserved_krw = 0

        if not dry and upbit:
            # [Step A: 5중 가드레일 원자적 BEGIN IMMEDIATE 선점 + 선차감]
            now_ts = time.time()
            now_iso = _now_utc_iso()
            now_kst_claim = _now_kst_str()
            intent_id = str(uuid.uuid4())
            intent_bucket = _build_py_buy_bucket(norm_bot_id, ticker, step_level)
            reserved_krw = int(math.floor(invest_krw + math.ceil(invest_krw * UPBIT_FEE_RATE)))
            try:
                conn.execute("BEGIN IMMEDIATE;")
                bot_row = conn.execute("SELECT * FROM bots WHERE bot_id = ?;", (norm_bot_id,)).fetchone()
                cur_vkrw = float(dict(bot_row).get("virtual_krw") or 0) if bot_row else 0.0
                if cur_vkrw < 0:
                    _py_trip_kill_switch_in_tx(conn, norm_bot_id, "NEGATIVE_VIRTUAL_KRW", f"virtual_krw={cur_vkrw} < 0")
                    conn.commit()
                    return None
                to_row = conn.execute("SELECT COUNT(*) AS cnt FROM live_order_intents WHERE status = 'UNKNOWN_TIMEOUT';").fetchone()
                to_thresh = _get_guardrail_int(conn, "live_anomaly_timeout_threshold", "LIVE_ANOMALY_TIMEOUT_THRESHOLD", 2)
                if to_row and int(dict(to_row).get("cnt") or 0) >= to_thresh:
                    _py_trip_kill_switch_in_tx(conn, norm_bot_id, "UNRESOLVED_TIMEOUT_ANOMALY", "미해결 UNKNOWN_TIMEOUT 임계치 도달", halt_all=True)
                    conn.commit()
                    return None
                inflight = conn.execute(
                    "SELECT intent_id FROM live_order_intents WHERE bot_id = ? AND market = ? AND side = 'BUY' AND status IN ('PENDING', 'SUBMITTED', 'UNKNOWN_TIMEOUT') LIMIT 1;",
                    (norm_bot_id, ticker),
                ).fetchone()
                if inflight:
                    _py_record_block_in_tx(conn, norm_bot_id, ticker, "INFLIGHT_OR_TIMEOUT_INTENT", "미확정 매수 인텐트 존재")
                    conn.commit()
                    return None
                open_cnt_row = conn.execute(
                    "SELECT COUNT(*) AS cnt FROM bot_positions WHERE (bot_id = ? OR bot_id = ?) AND COALESCE(NULLIF(ticker, ''), market) = ? AND status = 'OPEN';",
                    (bot_id, norm_bot_id, ticker),
                ).fetchone()
                open_cnt = int(dict(open_cnt_row).get("cnt") or 0) if open_cnt_row else 0
                max_steps = 3 if norm_bot_id == "bot_06" else (2 if norm_bot_id == "bot_10" else 1)
                if (norm_bot_id not in SPLIT_ALLOWED_BOTS and open_cnt > 0) or open_cnt >= max_steps or step_level > max_steps:
                    _py_record_block_in_tx(conn, norm_bot_id, ticker, "DUPLICATE_OPEN_POSITION", f"보유 포지션 상한({max_steps}) 초과")
                    conn.commit()
                    return None
                # Layer 4: 쿨다운(900s), 최소간격(60s/30s), 시간당(3), 일일(12), 전체일일(30)
                cd_sec = _get_guardrail_int(conn, "live_reentry_cooldown_sec", "LIVE_REENTRY_COOLDOWN_SEC", 900)
                if open_cnt == 0:
                    cd_kst = (datetime.datetime.now(KST_TZ) - datetime.timedelta(seconds=cd_sec)).strftime("%Y-%m-%d %H:%M:%S")
                    recent_sell = conn.execute(
                        "SELECT id FROM trades WHERE bot_id = ? AND market = ? AND status = 'COMPLETED' AND sell_date >= ? LIMIT 1;",
                        (norm_bot_id, ticker, cd_kst),
                    ).fetchone()
                    if recent_sell:
                        _py_record_block_in_tx(conn, norm_bot_id, ticker, "REENTRY_COOLDOWN", f"청산 후 {cd_sec}초 쿨다운 미경과")
                        conn.commit()
                        return None
                min_int_sec = 30 if (norm_bot_id in SPLIT_ALLOWED_BOTS and open_cnt > 0) else _get_guardrail_int(conn, "live_min_buy_interval_sec", "LIVE_MIN_BUY_INTERVAL_SEC", 60)
                int_iso = datetime.datetime.fromtimestamp(now_ts - min_int_sec, tz=datetime.timezone.utc).isoformat().replace("+00:00", "Z")
                if conn.execute(
                    "SELECT intent_id FROM live_order_intents WHERE bot_id = ? AND side = 'BUY' AND status IN ('PENDING','SUBMITTED','UNKNOWN_TIMEOUT','CONFIRMED') AND created_at >= ? LIMIT 1;",
                    (norm_bot_id, int_iso),
                ).fetchone():
                    _py_record_block_in_tx(conn, norm_bot_id, ticker, "MIN_BUY_INTERVAL", f"최소 매수 간격({min_int_sec}s) 미경과")
                    conn.commit()
                    return None
                hr_cap = _get_guardrail_int(conn, "live_max_buys_per_bot_hour", "LIVE_MAX_BUYS_PER_BOT_HOUR", 3)
                hr_iso = datetime.datetime.fromtimestamp(now_ts - 3600, tz=datetime.timezone.utc).isoformat().replace("+00:00", "Z")
                hr_cnt = int(dict(conn.execute("SELECT COUNT(*) AS c FROM live_order_intents WHERE bot_id = ? AND side = 'BUY' AND status IN ('PENDING','SUBMITTED','UNKNOWN_TIMEOUT','CONFIRMED') AND created_at >= ?;", (norm_bot_id, hr_iso)).fetchone()).get("c") or 0)
                if hr_cnt >= hr_cap:
                    _py_record_block_in_tx(conn, norm_bot_id, ticker, "BOT_HOURLY_BUY_CAP", f"시간당 매수 상한({hr_cnt}/{hr_cap}) 초과")
                    conn.commit()
                    return None
                day_cap = _get_guardrail_int(conn, "live_max_buys_per_bot_day", "LIVE_MAX_BUYS_PER_BOT_DAY", 12)
                tot_cap = _get_guardrail_int(conn, "live_max_total_buys_day", "LIVE_MAX_TOTAL_BUYS_DAY", 30)
                today_iso = _today_start_kst_utc_iso()
                day_cnt = int(dict(conn.execute("SELECT COUNT(*) AS c FROM live_order_intents WHERE bot_id = ? AND side = 'BUY' AND status IN ('PENDING','SUBMITTED','UNKNOWN_TIMEOUT','CONFIRMED') AND created_at >= ?;", (norm_bot_id, today_iso)).fetchone()).get("c") or 0)
                if day_cnt >= day_cap:
                    _py_record_block_in_tx(conn, norm_bot_id, ticker, "BOT_DAILY_BUY_CAP", f"일일 매수 상한({day_cnt}/{day_cap}) 초과")
                    conn.commit()
                    return None
                tot_cnt = int(dict(conn.execute("SELECT COUNT(*) AS c FROM live_order_intents WHERE side = 'BUY' AND status IN ('PENDING','SUBMITTED','UNKNOWN_TIMEOUT','CONFIRMED') AND created_at >= ?;", (today_iso,)).fetchone()).get("c") or 0)
                if tot_cnt >= tot_cap:
                    _py_record_block_in_tx(conn, norm_bot_id, ticker, "GLOBAL_DAILY_BUY_CAP", f"전체 일일 매수 상한({tot_cnt}/{tot_cap}) 초과")
                    conn.commit()
                    return None
                if cur_vkrw < reserved_krw:
                    conn.rollback()
                    return None
                conn.execute(
                    """
                    INSERT INTO live_order_intents (
                        intent_id, bot_id, market, side, intent_bucket, requested_krw, requested_volume,
                        target_position_uuid, upbit_order_uuid, status, refunded, error_message, created_at, updated_at
                    ) VALUES (?, ?, ?, 'BUY', ?, ?, ?, NULL, NULL, 'PENDING', 0, NULL, ?, ?);
                    """,
                    (intent_id, norm_bot_id, ticker, intent_bucket, reserved_krw, format_volume_8(limit_volume), now_iso, now_iso),
                )
                upd_b = conn.execute(
                    "UPDATE bots SET virtual_krw = virtual_krw - ?, updated_at = ? WHERE bot_id = ? AND virtual_krw >= ?;",
                    (reserved_krw, now_kst_claim, norm_bot_id, reserved_krw),
                )
                if upd_b.rowcount != 1:
                    conn.rollback()
                    return None
                conn.execute(
                    "UPDATE bot_accounts SET virtual_krw = MAX(0.0, virtual_krw - ?), updated_at = ? WHERE bot_id = ?;",
                    (reserved_krw, now_kst_claim, norm_bot_id),
                )
                conn.commit()
                live_intent_id = intent_id
            except Exception as claim_exc:
                try:
                    conn.rollback()
                except Exception:
                    pass
                logger.warning("[%s] Live BUY Step A blocked/conflict (%s): %s", norm_bot_id, ticker, claim_exc)
                return None

            # [Step B] 업비트 주문 전송 (identifier 포함, 절대 맹목 재시도 금지)
            limit_res = execute_limit_order_with_polling(
                upbit, "bid", ticker, current_price, limit_volume, timeout_sec=35, identifier=live_intent_id
            )
            if isinstance(limit_res, dict) and limit_res.get("uncertain_timeout"):
                # 타임아웃/불확실 -> 절대 즉시 환불/재주문 금지, UNKNOWN_TIMEOUT 잠금
                conn.execute("BEGIN IMMEDIATE;")
                conn.execute(
                    "UPDATE live_order_intents SET status = 'UNKNOWN_TIMEOUT', error_message = ?, updated_at = ? WHERE intent_id = ?;",
                    (str(limit_res.get("error") or "timeout")[:400], _now_utc_iso(), live_intent_id),
                )
                conn.commit()
                logger.warning("[%s] Live BUY uncertain timeout; locked UNKNOWN_TIMEOUT (intent=%s)", norm_bot_id, live_intent_id)
                return None

            if limit_res and "uuid" in limit_res:
                order_uuid = limit_res["uuid"]
                executed_price = float(limit_res.get("executed_price") or current_price)
                filled_vol = round_down_volume_8(limit_res.get("executed_volume") or 0)
                if filled_vol > 0:
                    volume = filled_vol
                buy_fee = float(limit_res.get("paid_fee") or (volume * executed_price * UPBIT_FEE_RATE))
                invest_krw = float(math.floor(volume * executed_price + buy_fee))
            else:
                # 지정가 미체결/명확한 거절 시 선차감 원화 1회 안전 환불 (중복 시장가 폴백 주문 금지로 연속 결제 사고 원천 차단)
                conn.execute("BEGIN IMMEDIATE;")
                ref_upd = conn.execute(
                    "UPDATE live_order_intents SET status = 'CANCELED', refunded = 1, error_message = 'limit_unfilled_or_rejected', updated_at = ? WHERE intent_id = ? AND refunded = 0;",
                    (_now_utc_iso(), live_intent_id),
                )
                if ref_upd.rowcount == 1 and reserved_krw > 0:
                    now_kst_ref = _now_kst_str()
                    conn.execute("UPDATE bots SET virtual_krw = virtual_krw + ?, updated_at = ? WHERE bot_id = ?;", (reserved_krw, now_kst_ref, norm_bot_id))
                    conn.execute("UPDATE bot_accounts SET virtual_krw = virtual_krw + ?, updated_at = ? WHERE bot_id = ?;", (reserved_krw, now_kst_ref, norm_bot_id))
                conn.commit()
                logger.info("[%s] Live limit buy unfilled/canceled; refunded %d KRW safely.", norm_bot_id, reserved_krw)
                return None

        now_kst = _now_kst_str()
        vol_str = format_volume_8(volume)
        safe_reason = str(buy_reason or f"PYTHON_STEP_{step_level}")[:240]

        try:
            conn.execute("BEGIN IMMEDIATE;")

            # trades 원장 동기 기록 (Daily Circuit Breaker / 통계 정합성)
            trade_id = 0
            try:
                t_cur = conn.execute(
                    """
                    INSERT INTO trades (
                        bot_id, market, buy_order_uuid, buy_price, buy_volume, buy_amount, buy_date, status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'HOLDING');
                    """,
                    (
                        norm_bot_id,
                        ticker,
                        order_uuid,
                        executed_price,
                        vol_str,
                        math.floor(invest_krw),
                        now_kst,
                    ),
                )
                trade_id = int(getattr(t_cur.cur, "lastrowid", 0) or 0)
            except Exception as tr_exc:
                logger.debug("[%s] Optional trades insert skipped: %s", norm_bot_id, tr_exc)

            # bot_positions 테이블에 신규 포지션 기록 (market + ticker + buy_reason + KST created_at)
            conn.execute(
                """
                INSERT INTO bot_positions (
                    bot_id, market, ticker, order_uuid, volume, avg_buy_price,
                    buy_amount, buy_fee, trade_id, highest_price, step_level, status, created_at, buy_reason
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?);
                """,
                (
                    norm_bot_id,
                    ticker,
                    ticker,
                    order_uuid,
                    vol_str,
                    executed_price,
                    math.floor(invest_krw),
                    buy_fee,
                    trade_id,
                    executed_price,
                    step_level,
                    now_kst,
                    safe_reason,
                ),
            )

            # bot_accounts 및 bots의 virtual_krw 정산 (실전 2PC 선차감 시 차액만 환불/정산, DRY_RUN은 차감)
            if live_intent_id:
                upd_i = conn.execute(
                    "UPDATE live_order_intents SET upbit_order_uuid = ?, status = 'CONFIRMED', refunded = 1, updated_at = ? WHERE intent_id = ? AND refunded = 0;",
                    (order_uuid, _now_utc_iso(), live_intent_id),
                )
                if upd_i.rowcount == 1:
                    diff_krw = int(reserved_krw) - int(math.floor(invest_krw))
                    if diff_krw != 0:
                        conn.execute(
                            "UPDATE bot_accounts SET virtual_krw = MAX(0.0, virtual_krw + ?), updated_at = ? WHERE bot_id = ?;",
                            (diff_krw, now_kst, norm_bot_id),
                        )
                        conn.execute(
                            "UPDATE bots SET virtual_krw = MAX(0, virtual_krw + ?), updated_at = ? WHERE bot_id = ?;",
                            (diff_krw, now_kst, norm_bot_id),
                        )
            else:
                conn.execute(
                    """
                    UPDATE bot_accounts
                    SET virtual_krw = MAX(0.0, virtual_krw - ?),
                        updated_at = ?
                    WHERE bot_id = ?;
                    """,
                    (invest_krw, now_kst, norm_bot_id),
                )
                conn.execute(
                    """
                    UPDATE bots
                    SET virtual_krw = MAX(0, virtual_krw - ?),
                        updated_at = ?
                    WHERE bot_id = ?;
                    """,
                    (math.floor(invest_krw), now_kst, norm_bot_id),
                )

            conn.commit()
            logger.info(
                f"[{norm_bot_id}] BUY Executed ({'DRY_RUN' if dry else 'LIVE'}): {ticker} | "
                f"Amount={invest_krw:,.0f}원 | Price={executed_price:,.0f}원 | Vol={vol_str} | UUID={order_uuid}"
            )
            return {
                "bot_id": norm_bot_id,
                "ticker": ticker,
                "order_uuid": order_uuid,
                "trade_id": trade_id,
                "volume": volume,
                "avg_buy_price": executed_price,
                "buy_amount": invest_krw,
            }
        except Exception as exc:
            try:
                conn.rollback()
            except Exception:
                pass
            logger.error("[%s] Buy transaction failed in SQLite: %s", bot_id, exc)
            return None
    finally:
        conn.close()


# [Antigravity-Doc] 역할: 개별 포지션(position_id) 분할 매도 실행 및 원장 정산 — Layer 3 closing_lock 중복 매도 차단 -> 지정가 우선(부분 체결 보존)/단일 시장가 폴백 -> Graceful Drain 탈락 봇 회수금의 90% 상한 내 후임 봇 우선 자동 복원
# [Antigravity-Doc] 입력: position_id(int), reason(매도 사유), db_path | 반환: 정산 결과 dict(realized_pnl, pnl_pct, net_sell_amount, partial) 또는 None
def execute_sell_order(
    position_id: int,
    reason: str = "SELL",
    db_path: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """
    개별 포지션 분할 매도 실행:
    - 절대 get_balance() 전체 잔고를 매도하지 않음!
    - bot_positions 테이블에 기록된 해당 position_id의 volume 수량만 지정하여 매도
    - 매도 후 status='CLOSED', realized_pnl 갱신 및 bot_accounts/bots의 virtual_krw 복원 (Graceful Drain Zero-Sum 보장)
    """
    # Node.js 백엔드가 매매를 관장 중인 경우 Python 중복 주문 차단 (실전/DRY_RUN 공통)
    if is_backend_running():
        logger.info("[pos=%d] Node.js backend is active. Deferring sell order to backend.", position_id)
        return None

    conn = get_db_connection(db_path)
    try:
        _ensure_py_guardrail_tables(conn)
        dry = is_dry_run()
        upbit = get_upbit_client()

        # [Layer 1 하드 가드레일] 실전 모드에서 LIVE_EXECUTOR_OWNER != 'python' 이면 즉시 차단
        if not dry:
            if not is_python_live_executor_authorized():
                logger.warning(
                    "[Guardrail][LIVE_EXECUTOR_OWNER=%s] HARD BLOCK Python live SELL for pos=%d",
                    get_live_executor_owner(),
                    position_id,
                )
                return None
            lease_ok, lease_reason = acquire_live_executor_lease(db_path=db_path)
            if not lease_ok:
                logger.warning("[pos=%d] Live SELL blocked by lease lock: %s", position_id, lease_reason)
                return None

        pos_row = conn.execute("SELECT * FROM bot_positions WHERE id = ? AND status = 'OPEN';", (position_id,)).fetchone()
        if not pos_row:
            logger.warning("Position id=%d is not in OPEN status.", position_id)
            return None
        pos = dict(pos_row)

        bot_id = pos["bot_id"]
        norm_bot_id = normalize_bot_id(bot_id)
        ticker = pos.get("ticker") or pos.get("market") or ""
        original_volume = round_down_volume_8(pos["volume"])
        if original_volume <= 0:
            logger.error("[%s] Cannot sell position %d: invalid volume=%s", bot_id, position_id, pos.get("volume"))
            return None
        volume = original_volume
        buy_amount = float(pos["buy_amount"] or 0.0)
        avg_buy_price = float(pos["avg_buy_price"] or 0.0)

        current_price = get_safe_current_price(ticker)
        if current_price <= 0:
            logger.error("[%s] Cannot sell position %d: Invalid price for %s", bot_id, position_id, ticker)
            return None

        if not dry and upbit and (volume * current_price) < MIN_ORDER_KRW:
            logger.warning(
                "[%s] Skip live sell for pos %d (%s): notional %.0f KRW < min %.0f KRW",
                norm_bot_id,
                position_id,
                ticker,
                volume * current_price,
                MIN_ORDER_KRW,
            )
            return None

        gross_amount = volume * current_price
        sell_fee = gross_amount * UPBIT_FEE_RATE
        net_sell_amount = gross_amount - sell_fee
        realized_pnl = net_sell_amount - buy_amount
        pnl_pct = (realized_pnl / buy_amount) * 100.0 if buy_amount > 0 else 0.0
        sell_order_uuid = f"sim-sell-{uuid.uuid4().hex[:12]}"
        executed_sell_price = current_price
        is_partial_fill = False
        remaining_vol = 0.0
        sell_intent_id: Optional[str] = None
        target_pos_uuid = str(pos.get("order_uuid") or f"pos-{position_id}")

        if not dry and upbit:
            # [Layer 3] 동일 order_uuid 중복 매도 차단: closing_lock=1 + live_order_intents(sell:<order_uuid>) 원자적 선점
            # (Graceful Drain / 매수 쿨다운 / 매수 상한에는 절대 차단되지 않음)
            sell_intent_id = str(uuid.uuid4())
            sell_bucket = f"sell:{target_pos_uuid}"
            try:
                conn.execute("BEGIN IMMEDIATE;")
                lock_upd = conn.execute(
                    "UPDATE bot_positions SET closing_lock = 1 WHERE id = ? AND status = 'OPEN' AND COALESCE(closing_lock, 0) = 0;",
                    (position_id,),
                )
                if lock_upd.rowcount != 1:
                    conn.rollback()
                    logger.warning("[%s] Duplicate live sell blocked by closing_lock for pos %d (%s)", norm_bot_id, position_id, target_pos_uuid)
                    return None
                now_iso = _now_utc_iso()
                conn.execute(
                    """
                    INSERT INTO live_order_intents (
                        intent_id, bot_id, market, side, intent_bucket, requested_krw, requested_volume,
                        target_position_uuid, upbit_order_uuid, status, refunded, error_message, created_at, updated_at
                    ) VALUES (?, ?, ?, 'SELL', ?, 0, ?, ?, NULL, 'PENDING', 0, NULL, ?, ?);
                    """,
                    (sell_intent_id, norm_bot_id, ticker, sell_bucket, format_volume_8(volume), target_pos_uuid, now_iso, now_iso),
                )
                conn.commit()
            except Exception as sl_exc:
                try:
                    conn.rollback()
                except Exception:
                    pass
                logger.warning("[%s] Duplicate live sell blocked for pos %d (%s): %s", norm_bot_id, position_id, target_pos_uuid, sl_exc)
                return None

            def _release_py_sell_lock(next_status: str, err_msg: str) -> None:
                try:
                    conn.execute("BEGIN IMMEDIATE;")
                    archived_bucket = f"{sell_bucket}:{next_status.lower()}:{sell_intent_id[:8]}"
                    conn.execute(
                        "UPDATE live_order_intents SET status = ?, intent_bucket = ?, error_message = ?, updated_at = ? WHERE intent_id = ?;",
                        (next_status, archived_bucket, err_msg[:400], _now_utc_iso(), sell_intent_id),
                    )
                    conn.execute("UPDATE bot_positions SET closing_lock = 0 WHERE id = ? AND status = 'OPEN';", (position_id,))
                    conn.commit()
                except Exception:
                    try:
                        conn.rollback()
                    except Exception:
                        pass

            # 엄격하게 본인 bot_positions에 기록된 volume 수량만 지정하여 최유리 지정가 매도 우선 시도 (identifier 포함)
            limit_res = execute_limit_order_with_polling(
                upbit, "ask", ticker, current_price, volume, timeout_sec=35, identifier=sell_intent_id
            )
            if isinstance(limit_res, dict) and limit_res.get("uncertain_timeout"):
                conn.execute("BEGIN IMMEDIATE;")
                conn.execute(
                    "UPDATE live_order_intents SET status = 'UNKNOWN_TIMEOUT', error_message = ?, updated_at = ? WHERE intent_id = ?;",
                    (str(limit_res.get("error") or "sell_timeout")[:400], _now_utc_iso(), sell_intent_id),
                )
                conn.commit()
                return None

            if limit_res and "uuid" in limit_res:
                sell_order_uuid = limit_res["uuid"]
                executed_sell_price = float(limit_res.get("executed_price") or current_price)
                filled_vol = round_down_volume_8(limit_res.get("executed_volume") or 0)
                if filled_vol > 0:
                    volume = filled_vol
                sell_fee = float(limit_res.get("paid_fee") or (volume * executed_sell_price * UPBIT_FEE_RATE))
                gross_amount = volume * executed_sell_price
                net_sell_amount = gross_amount - sell_fee
                # 부분 체결 시 잔여 물량이 최소 주문 금액 이상이면 포지션을 고아 코인으로 버리지 않고 부분 차감
                rem_candidate = round_down_volume_8(original_volume - volume)
                if rem_candidate > 0 and (rem_candidate * executed_sell_price) >= MIN_ORDER_KRW:
                    is_partial_fill = True
                    remaining_vol = rem_candidate
                    filled_ratio = min(1.0, max(0.0, volume / original_volume)) if original_volume > 0 else 1.0
                    sold_cost = buy_amount * filled_ratio
                    realized_pnl = net_sell_amount - sold_cost
                    pnl_pct = (realized_pnl / sold_cost) * 100.0 if sold_cost > 0 else 0.0
                else:
                    realized_pnl = net_sell_amount - buy_amount
                    pnl_pct = (realized_pnl / buy_amount) * 100.0 if buy_amount > 0 else 0.0
            else:
                logger.info("[%s] Limit sell not filled; falling back to single market sell for pos %d (%s, vol=%.8f)", bot_id, position_id, ticker, volume)
                # 절대 맹목 재시도(retry_with_backoff) 금지: 단일 호출만 수행 (Mock Upbit 테스트 시 외부 네트워크 미호출 보장)
                try:
                    if isinstance(upbit, pyupbit.Upbit) and os.getenv("UPBIT_ACCESS_KEY", "").strip() and os.getenv("UPBIT_SECRET_KEY", "").strip():
                        mkt_id = str(uuid.uuid4())
                        m_status, m_body, m_err = _py_post_upbit_order_with_identifier(
                            {
                                "market": ticker,
                                "side": "ask",
                                "volume": format_volume_8(volume),
                                "ord_type": "market",
                                "identifier": mkt_id,
                            }
                        )
                        if m_err or m_status >= 500 or m_status == 0:
                            conn.execute("BEGIN IMMEDIATE;")
                            conn.execute(
                                "UPDATE live_order_intents SET status = 'UNKNOWN_TIMEOUT', error_message = ?, updated_at = ? WHERE intent_id = ?;",
                                (str(m_err or f"HTTP {m_status}")[:400], _now_utc_iso(), sell_intent_id),
                            )
                            conn.commit()
                            return None
                        res = m_body if m_status in (200, 201) else None
                    else:
                        res = upbit.sell_market_order(ticker, volume)
                except Exception as ms_exc:
                    conn.execute("BEGIN IMMEDIATE;")
                    conn.execute(
                        "UPDATE live_order_intents SET status = 'UNKNOWN_TIMEOUT', error_message = ?, updated_at = ? WHERE intent_id = ?;",
                        (str(ms_exc)[:400], _now_utc_iso(), sell_intent_id),
                    )
                    conn.commit()
                    return None
                if not res or "uuid" not in res:
                    logger.error("[%s] Live market sell failed for pos %d (%s, vol=%.8f)", bot_id, position_id, ticker, volume)
                    _release_py_sell_lock("FAILED_NOT_CREATED", "Live market sell rejected")
                    return None
                sell_order_uuid = res["uuid"]
                order_detail = None
                for _attempt in range(3):
                    time.sleep(0.5)
                    order_detail = retry_with_backoff(upbit.get_order, sell_order_uuid)
                    if order_detail and str(order_detail.get("state") or "") in ("done", "cancel"):
                        break
                if order_detail:
                    exec_vol = round_down_volume_8(order_detail.get("executed_volume") or 0)
                    if exec_vol > 0:
                        volume = exec_vol
                    raw_fee = order_detail.get("paid_fee")
                    if raw_fee is not None and str(raw_fee) != "":
                        sell_fee = float(raw_fee)
                    trades = order_detail.get("trades") or []
                    total_funds = sum(float(t.get("funds") or 0.0) for t in trades if isinstance(t, dict))
                    if total_funds > 0 and volume > 0:
                        executed_sell_price = total_funds / volume
                        gross_amount = total_funds
                    else:
                        # 시장가 매도 주문 응답의 price 필드는 None일 수 있으므로 절대 직접 float(None) 금지
                        raw_price = order_detail.get("price")
                        executed_sell_price = float(raw_price) if (raw_price is not None and str(raw_price) != "" and float(raw_price) > 0) else current_price
                        gross_amount = volume * executed_sell_price
                    net_sell_amount = gross_amount - sell_fee
                    realized_pnl = net_sell_amount - buy_amount
                    pnl_pct = (realized_pnl / buy_amount) * 100.0 if buy_amount > 0 else 0.0

        now_kst = _now_kst_str()
        safe_net_sell = float(net_sell_amount) if math.isfinite(net_sell_amount) else 0.0
        safe_realized_pnl = float(realized_pnl) if math.isfinite(realized_pnl) else 0.0
        safe_pnl_pct = float(pnl_pct) if math.isfinite(pnl_pct) else 0.0

        try:
            conn.execute("BEGIN IMMEDIATE;")

            if is_partial_fill and remaining_vol > 0:
                rem_ratio = remaining_vol / original_volume if original_volume > 0 else 0.0
                rem_buy_amount = max(0, math.floor(buy_amount * rem_ratio))
                upd = conn.execute(
                    """
                    UPDATE bot_positions
                    SET volume = ?,
                        buy_amount = ?,
                        sell_order_uuid = ?,
                        closing_lock = 0
                    WHERE id = ? AND status = 'OPEN';
                    """,
                    (format_volume_8(remaining_vol), rem_buy_amount, sell_order_uuid, position_id),
                )
                if upd.rowcount == 0:
                    conn.rollback()
                    logger.warning("[%s] Position %d already modified/closed concurrently.", norm_bot_id, position_id)
                    return None
            else:
                # 1. bot_positions 상태 업데이트 (CLOSED, 원자적 OPEN 가드 + closing_lock 해제)
                upd = conn.execute(
                    """
                    UPDATE bot_positions
                    SET status = 'CLOSED',
                        sell_order_uuid = ?,
                        sell_price = ?,
                        sell_amount = ?,
                        sell_fee = ?,
                        realized_pnl = ?,
                        pnl_pct = ?,
                        closed_at = ?,
                        closing_lock = 0
                    WHERE id = ? AND status = 'OPEN';
                    """,
                    (
                        sell_order_uuid,
                        executed_sell_price,
                        safe_net_sell,
                        sell_fee,
                        safe_realized_pnl,
                        safe_pnl_pct,
                        now_kst,
                        position_id,
                    ),
                )
                if upd.rowcount == 0:
                    conn.rollback()
                    logger.warning("[%s] Position %d already closed concurrently; skipping duplicate settlement.", norm_bot_id, position_id)
                    return None
            if sell_intent_id:
                conn.execute(
                    "UPDATE live_order_intents SET upbit_order_uuid = ?, status = 'CONFIRMED', updated_at = ? WHERE intent_id = ?;",
                    (sell_order_uuid, _now_utc_iso(), sell_intent_id),
                )

                trade_id_val = int(pos.get("trade_id") or 0)
                if trade_id_val > 0:
                    try:
                        conn.execute(
                            """
                            UPDATE trades
                            SET sell_order_uuid = ?,
                                sell_date = ?,
                                sell_price = ?,
                                sell_volume = ?,
                                sell_amount = ?,
                                profit_krw = ?,
                                profit_pct = ?,
                                status = 'COMPLETED'
                            WHERE id = ? AND status = 'HOLDING';
                            """,
                            (
                                sell_order_uuid,
                                now_kst,
                                executed_sell_price,
                                format_volume_8(volume),
                                math.floor(safe_net_sell),
                                math.floor(safe_realized_pnl),
                                round(safe_pnl_pct, 2),
                                trade_id_val,
                            ),
                        )
                    except Exception as tr_upd_exc:
                        logger.debug("[%s] Optional trades update skipped: %s", norm_bot_id, tr_upd_exc)

            # 2. 실전 선택 여부 확인 (Graceful Drain 탈락 봇 청산 시 회수 원화 활성 봇 자동 귀속)
            bot_live_row = conn.execute(
                "SELECT is_selected_for_live FROM bots WHERE bot_id = ?;",
                (norm_bot_id,),
            ).fetchone()
            if bot_live_row is None:
                bot_live_row = conn.execute(
                    "SELECT is_selected_for_live FROM bot_accounts WHERE bot_id = ?;",
                    (norm_bot_id,),
                ).fetchone()
            is_selected_live = int(dict(bot_live_row).get("is_selected_for_live") or 0) == 1 if bot_live_row is not None else True

            # [Antigravity-Doc] Graceful Drain 자금 회수/복원 정산 블록:
            # [Antigravity-Doc]   - 탈락 봇(is_selected_for_live=0) 청산 시 회수 원화를 실시간 총 평가자산(E_total)의 max_deploy_ratio(90%) 상한 내에서
            # [Antigravity-Doc]     1순위 후임 봇(replaced_by_bot_id) -> 2순위 목표 한도 미달 선출 봇 비례 분배 -> 잔여분은 예비비 유보(RESERVE)
            # [Antigravity-Doc]   - 상한 초과 감지 시 RuntimeError(INVARIANT_VIOLATION)로 트랜잭션 전체 롤백 보장
            if not is_selected_live:
                # 탈락(Draining) 봇: 실현 손익 누적만 기록하고, 회수 원화는 원금 90% 상한 불변식 하에 후임 봇 우선 복원
                prev_cash_row = conn.execute(
                    "SELECT COALESCE(virtual_krw, 0) AS vkrw FROM bot_accounts WHERE bot_id = ?;",
                    (norm_bot_id,),
                ).fetchone()
                prev_cash = max(0, math.floor(float(dict(prev_cash_row).get("vkrw") or 0))) if prev_cash_row else 0
                drain_meta_row = conn.execute(
                    "SELECT replaced_by_bot_id, drain_started_at FROM bots WHERE bot_id = ?;",
                    (norm_bot_id,),
                ).fetchone()
                drain_meta = dict(drain_meta_row) if drain_meta_row else {}
                replaced_by_id = drain_meta.get("replaced_by_bot_id")
                drain_started_at = drain_meta.get("drain_started_at")

                remaining_open_row = conn.execute(
                    "SELECT COUNT(*) AS open_cnt, COALESCE(SUM(buy_amount), 0) AS open_used FROM bot_positions WHERE (bot_id = ? OR bot_id = ?) AND status = 'OPEN';",
                    (bot_id, norm_bot_id),
                ).fetchone()
                rem_dict = dict(remaining_open_row) if remaining_open_row else {}
                remaining_open_cnt = int(rem_dict.get("open_cnt") or 0)
                remaining_open_used = max(0, math.floor(float(rem_dict.get("open_used") or 0)))

                safe_proceeds = max(0, math.floor(safe_net_sell))
                floored_proceeds = safe_proceeds + prev_cash

                active_rows = conn.execute(
                    """
                    SELECT bot_id, COALESCE(allocation_ratio, 0) AS allocation_ratio,
                           COALESCE(target_capital_krw, 0) AS target_capital_krw,
                           COALESCE(virtual_krw, 0) AS virtual_krw
                    FROM bots
                    WHERE is_selected_for_live = 1
                    ORDER BY allocation_ratio DESC, bot_id ASC;
                    """
                ).fetchall()
                if not active_rows:
                    active_rows = conn.execute(
                        """
                        SELECT bot_id, COALESCE(allocation_ratio, 0) AS allocation_ratio,
                               0 AS target_capital_krw,
                               COALESCE(virtual_krw, 0) AS virtual_krw
                        FROM bot_accounts
                        WHERE is_selected_for_live = 1
                        ORDER BY allocation_ratio DESC, bot_id ASC;
                        """
                    ).fetchall()

                active_list = [dict(r) for r in active_rows if r["bot_id"] != norm_bot_id]
                # 실시간 총 평가자산(E_total) 기반 단일 90% 상한 조회 (이중 차감 금지)
                rot_cfg_row = conn.execute("SELECT max_deploy_ratio FROM auto_rotation_config WHERE id = 1;").fetchone()
                max_deploy_ratio = float(dict(rot_cfg_row).get("max_deploy_ratio") or 0.90) if rot_cfg_row else 0.90
                if not (0 < max_deploy_ratio <= 1.0):
                    max_deploy_ratio = 0.90
                eq_row = conn.execute("SELECT value FROM system_settings WHERE key = 'last_synced_total_equity_krw';").fetchone()
                total_equity_krw = max(0, math.floor(float(dict(eq_row).get("value") or 0))) if eq_row else 0
                if total_equity_krw <= 0:
                    cap_row = conn.execute("SELECT value FROM system_settings WHERE key = 'deployable_capital_cap_krw';").fetchone()
                    if cap_row is None:
                        cap_row = conn.execute("SELECT value FROM system_settings WHERE key = 'total_capital';").fetchone()
                    legacy_cap = max(0, math.floor(float(dict(cap_row).get("value") or 0))) if cap_row else 0
                    total_equity_krw = math.floor(legacy_cap / max_deploy_ratio) if legacy_cap > 0 else 0
                global_cap_krw = math.floor(total_equity_krw * max_deploy_ratio) if total_equity_krw > 0 else 0

                # 잔여 전체 Draining 봇 오픈 원금 및 선출 봇 사용액 산출
                rem_drain_all_row = conn.execute(
                    """
                    SELECT COALESCE(SUM(bp.buy_amount), 0) AS rem_locked
                    FROM bot_positions bp
                    JOIN bots b ON bp.bot_id = b.bot_id
                    WHERE bp.status = 'OPEN' AND b.is_selected_for_live = 0;
                    """
                ).fetchone()
                rem_drain_locked_all = max(0, math.floor(float(dict(rem_drain_all_row).get("rem_locked") or 0))) if rem_drain_all_row else 0

                elected_states = []
                total_elected_used = 0
                for ab in active_list:
                    ab_open_row = conn.execute(
                        "SELECT COALESCE(SUM(buy_amount), 0) AS open_used FROM bot_positions WHERE bot_id = ? AND status = 'OPEN';",
                        (ab["bot_id"],),
                    ).fetchone()
                    ab_locked = max(0, math.floor(float(dict(ab_open_row).get("open_used") or 0))) if ab_open_row else 0
                    ab_vkrw = max(0, math.floor(float(ab.get("virtual_krw") or 0)))
                    ab_target = max(0, math.floor(float(ab.get("target_capital_krw") or 0)))
                    if ab_target <= 0 and global_cap_krw > 0 and active_list:
                        ab_target = math.floor(global_cap_krw / len(active_list))
                    total_elected_used += ab_locked + ab_vkrw
                    elected_states.append({
                        "bot_id": ab["bot_id"],
                        "allocation_ratio": float(ab.get("allocation_ratio") or 0.0),
                        "target_capital_krw": ab_target,
                        "open_locked_krw": ab_locked,
                        "virtual_krw": ab_vkrw,
                    })

                retained_cash = floored_proceeds if not active_list else 0
                retained_alloc = remaining_open_used + retained_cash
                next_drain_status = "DRAINING" if remaining_open_cnt > 0 else "COMPLETED"
                next_replaced_by = replaced_by_id if remaining_open_cnt > 0 else None
                next_drain_started = drain_started_at if remaining_open_cnt > 0 else None

                conn.execute(
                    """
                    UPDATE bot_accounts
                    SET virtual_krw = ?,
                        allocated_capital = ?,
                        is_selected_for_live = 0,
                        total_realized_pnl = total_realized_pnl + ?,
                        updated_at = ?
                    WHERE bot_id = ?;
                    """,
                    (retained_cash, retained_alloc, safe_realized_pnl, now_kst, norm_bot_id),
                )
                conn.execute(
                    """
                    UPDATE bots
                    SET virtual_krw = ?,
                        allocated_capital = ?,
                        target_capital_krw = 0,
                        is_selected_for_live = 0,
                        drain_status = ?,
                        replaced_by_bot_id = ?,
                        drain_started_at = ?,
                        updated_at = ?
                    WHERE bot_id = ?;
                    """,
                    (retained_cash, retained_alloc, next_drain_status, next_replaced_by, next_drain_started, now_kst, norm_bot_id),
                )

                transfer_logs = []
                alloc_summary = []
                total_restored = 0
                surplus_reserve = 0

                if elected_states and floored_proceeds > 0:
                    if global_cap_krw > 0:
                        global_headroom = max(0, global_cap_krw - (rem_drain_locked_all + total_elected_used))
                        restorable_pool = min(floored_proceeds, global_headroom)
                    else:
                        restorable_pool = floored_proceeds

                    transfers_map: Dict[str, int] = {}

                    # 1순위: 직접 연결된 후임 봇(replaced_by_bot_id) 우선 복원
                    if restorable_pool > 0 and replaced_by_id:
                        for es in elected_states:
                            if es["bot_id"] == replaced_by_id:
                                deficit = max(0, es["target_capital_krw"] - (es["open_locked_krw"] + es["virtual_krw"]))
                                amt = min(restorable_pool, deficit) if es["target_capital_krw"] > 0 else restorable_pool
                                if amt > 0:
                                    transfers_map[es["bot_id"]] = transfers_map.get(es["bot_id"], 0) + amt
                                    restorable_pool -= amt
                                break

                    # 2순위: 목표 한도 미달인 다른 선출 봇들에게 부족분 비례 분배 (단, global_cap/target 미설정 레거시 DB는 allocation_ratio Zero-Sum 분배)
                    if restorable_pool > 0:
                        has_any_target = any(es["target_capital_krw"] > 0 for es in elected_states)
                        if global_cap_krw > 0 or has_any_target:
                            needy = []
                            for es in elected_states:
                                already = transfers_map.get(es["bot_id"], 0)
                                deficit = max(0, es["target_capital_krw"] - (es["open_locked_krw"] + es["virtual_krw"] + already))
                                if deficit > 0:
                                    needy.append([es["bot_id"], deficit])
                            total_deficit = sum(d for _, d in needy)
                            if total_deficit > 0:
                                pool_to_share = min(restorable_pool, total_deficit)
                                distributed = 0
                                for idx, (bid, deficit) in enumerate(needy):
                                    share = min(deficit, math.floor((deficit * pool_to_share) / total_deficit))
                                    if share > 0:
                                        transfers_map[bid] = transfers_map.get(bid, 0) + share
                                        distributed += share
                                        needy[idx][1] -= share
                                # floor 절삭 자투리(1~2원)를 잔여 부족분이 남은 선출 봇에게 순차 배분
                                rem = pool_to_share - distributed
                                for bid, rem_def in needy:
                                    if rem <= 0:
                                        break
                                    if rem_def > 0:
                                        add_amt = min(rem, rem_def)
                                        transfers_map[bid] = transfers_map.get(bid, 0) + add_amt
                                        distributed += add_amt
                                        rem -= add_amt
                                restorable_pool -= distributed
                        else:
                            # 레거시 / 미동기화 DB(global_cap_krw == 0 & target_capital_krw == 0): allocation_ratio 비율 기반 Zero-Sum 분배 (1원 오차 없음)
                            ratio_sum = sum(max(0.0, es["allocation_ratio"]) for es in elected_states)
                            distributed = 0
                            for es in elected_states:
                                weight = (max(0.0, es["allocation_ratio"]) / ratio_sum) if ratio_sum > 0 else (1.0 / len(elected_states))
                                share = math.floor(restorable_pool * weight)
                                if share > 0:
                                    transfers_map[es["bot_id"]] = transfers_map.get(es["bot_id"], 0) + share
                                    distributed += share
                            rem = restorable_pool - distributed
                            if rem > 0 and elected_states:
                                top_bid = elected_states[0]["bot_id"]
                                transfers_map[top_bid] = transfers_map.get(top_bid, 0) + rem
                                distributed += rem
                            restorable_pool -= distributed

                    for target_id, share in transfers_map.items():
                        if share <= 0:
                            continue
                        total_restored += share
                        conn.execute(
                            """
                            UPDATE bot_accounts
                            SET virtual_krw = virtual_krw + ?,
                                allocated_capital = allocated_capital + ?,
                                updated_at = ?
                            WHERE bot_id = ?;
                            """,
                            (share, share, now_kst, target_id),
                        )
                        conn.execute(
                            """
                            UPDATE bots
                            SET virtual_krw = virtual_krw + ?,
                                allocated_capital = allocated_capital + ?,
                                updated_at = ?
                            WHERE bot_id = ?;
                            """,
                            (share, share, now_kst, target_id),
                        )
                        transfer_logs.append(f"{target_id}+{share:,}원")
                        alloc_summary.append({"bot_id": target_id, "amount_krw": share})

                    surplus_reserve = max(0, floored_proceeds - total_restored)
                    total_used_after = rem_drain_locked_all + total_elected_used + total_restored
                    if global_cap_krw > 0 and total_used_after > global_cap_krw:
                        raise RuntimeError(
                            f"[INVARIANT_VIOLATION] Python drain restoration exceeded 90% cap ({total_used_after} > {global_cap_krw})"
                        )

                    try:
                        if transfers_map:
                            for target_id, share in transfers_map.items():
                                conn.execute(
                                    """
                                    INSERT INTO capital_restoration_logs (
                                        source_bot_id, target_bot_id, order_uuid, settled_net_krw,
                                        restored_krw, surplus_reserve_krw, total_used_after_krw, global_cap_krw, total_equity_snapshot_krw, created_at
                                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
                                    """,
                                    (
                                        norm_bot_id,
                                        target_id,
                                        sell_order_uuid,
                                        float(floored_proceeds),
                                        float(share),
                                        float(surplus_reserve),
                                        float(total_used_after),
                                        float(global_cap_krw),
                                        float(total_equity_krw),
                                        now_kst,
                                    ),
                                )
                        else:
                            conn.execute(
                                """
                                INSERT INTO capital_restoration_logs (
                                    source_bot_id, target_bot_id, order_uuid, settled_net_krw,
                                    restored_krw, surplus_reserve_krw, total_used_after_krw, global_cap_krw, total_equity_snapshot_krw, created_at
                                ) VALUES (?, 'RESERVE', ?, ?, 0, ?, ?, ?, ?, ?);
                                """,
                                (
                                    norm_bot_id,
                                    sell_order_uuid,
                                    float(floored_proceeds),
                                    float(surplus_reserve),
                                    float(total_used_after),
                                    float(global_cap_krw),
                                    float(total_equity_krw),
                                    now_kst,
                                ),
                            )
                    except Exception as rest_log_exc:
                        logger.warning("[%s] Failed to insert capital_restoration_logs: %s", norm_bot_id, rest_log_exc)

                try:
                    conn.execute(
                        """
                        INSERT INTO drain_handoff_logs (
                            from_bot_id, market, position_id, trade_id, reason,
                            sell_amount, sell_fee, net_proceeds_krw, realized_pnl_krw,
                            allocations_json, remaining_positions_count, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
                        """,
                        (
                            norm_bot_id,
                            ticker,
                            position_id,
                            int(pos.get("trade_id") or 0),
                            reason,
                            float(safe_net_sell + sell_fee),
                            float(sell_fee),
                            float(floored_proceeds),
                            float(safe_realized_pnl),
                            json.dumps(alloc_summary, ensure_ascii=False),
                            remaining_open_cnt,
                            now_kst,
                        ),
                    )
                except Exception as log_exc:
                    logger.warning("[%s] Failed to insert drain_handoff_logs: %s", norm_bot_id, log_exc)

                logger.info(
                    f"[{norm_bot_id}] [Graceful Drain 정산 복원] 탈락 봇 {ticker} 매도 정산금 {floored_proceeds:,}원 "
                    f"(복원 {total_restored:,}원, 예비비 유보 {surplus_reserve:,}원, 실현손익 {safe_realized_pnl:+,.0f}원, 잔여포지션 {remaining_open_cnt}건) -> "
                    f"{', '.join(transfer_logs) if transfer_logs else '예비비 유보'}"
                )
            else:
                # 일반 활성 봇: bot_accounts & bots 가상 원화 복원 및 실현 손익 누적
                floored_proceeds = max(0, math.floor(safe_net_sell))
                remaining_open_row = conn.execute(
                    "SELECT COALESCE(SUM(buy_amount), 0) AS open_used FROM bot_positions WHERE (bot_id = ? OR bot_id = ?) AND status = 'OPEN';",
                    (bot_id, norm_bot_id),
                ).fetchone()
                remaining_open_used = max(0, math.floor(float(dict(remaining_open_row).get("open_used") or 0))) if remaining_open_row else 0
                conn.execute(
                    """
                    UPDATE bot_accounts
                    SET virtual_krw = virtual_krw + ?,
                        allocated_capital = virtual_krw + ? + ?,
                        total_realized_pnl = total_realized_pnl + ?,
                        updated_at = ?
                    WHERE bot_id = ?;
                    """,
                    (floored_proceeds, floored_proceeds, remaining_open_used, safe_realized_pnl, now_kst, norm_bot_id),
                )
                conn.execute(
                    """
                    UPDATE bots
                    SET virtual_krw = virtual_krw + ?,
                        allocated_capital = virtual_krw + ? + ?,
                        updated_at = ?
                    WHERE bot_id = ?;
                    """,
                    (floored_proceeds, floored_proceeds, remaining_open_used, now_kst, norm_bot_id),
                )

            conn.commit()
            logger.info(
                f"[{norm_bot_id}] SELL Executed ({'DRY_RUN' if dry else 'LIVE'}, {reason}): {ticker} | "
                f"SellPrice={executed_sell_price:,.0f}원 | PnL={safe_realized_pnl:,.0f}원 ({safe_pnl_pct:+.2f}%) | UUID={sell_order_uuid}"
            )
            return {
                "position_id": position_id,
                "realized_pnl": safe_realized_pnl,
                "pnl_pct": safe_pnl_pct,
                "net_sell_amount": safe_net_sell,
                "partial": is_partial_fill,
            }
        except Exception as exc:
            try:
                conn.rollback()
            except Exception:
                pass
            logger.error("[%s] Sell transaction failed in SQLite: %s", bot_id, exc)
            return None
    finally:
        conn.close()


# =====================================================================
# 4. 기술적 보조지표 계산 함수들
# =====================================================================

# [Antigravity-Doc] 역할: 기술적 보조지표 ATR(14), 볼린저 밴드(20, 2.0 + 밴드폭), RSI(14) 계산 유틸리티 함수군
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

# [Antigravity-Doc] 역할: [Bot 1] 변동성 돌파(4h 노이즈 동적 K=0.3~0.6, 5MA 상단, 거래량 1.5배) + 윗꼬리 필터 + ATR 트레일링 스탑 워커 루프 (10초 주기)
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
        if not acquire_live_cycle_mutex(norm_id):
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
            b_row = conn.execute("SELECT is_selected_for_live, is_running FROM bots WHERE bot_id = ?;", (norm_id,)).fetchone()
            if b_row is not None:
                b_dict = dict(b_row)
                allow_new_buys = bool(b_dict.get("is_selected_for_live")) and bool(b_dict.get("is_running"))

            bot_acc = conn.execute("SELECT * FROM bot_accounts WHERE bot_id = ?;", (norm_id,)).fetchone()
            available_krw = float(bot_acc["virtual_krw"]) if bot_acc else 0.0
            open_pos_markets_rows = conn.execute(
                "SELECT DISTINCT COALESCE(NULLIF(ticker, ''), market) AS m FROM bot_positions WHERE (bot_id = ? OR bot_id = ?) AND status = 'OPEN';",
                (bot_id, norm_id),
            ).fetchall()
            open_pos_markets = [str(dict(r).get("m") or "") for r in open_pos_markets_rows if str(dict(r).get("m") or "")]
            has_open_pos = len(open_pos_markets) > 0
            conn.close()

            if not allow_new_buys and not has_open_pos:
                if stop_event.wait(timeout=10):
                    break
                continue

            loop_tickers = list(dict.fromkeys(target_tickers + open_pos_markets))
            for ticker in loop_tickers:
                if stop_event.is_set():
                    break

                current_price = get_safe_current_price(ticker)
                if current_price <= 0:
                    continue

                # 1. 4시간봉 캔들 데이터 수집 (market_hub 캐시 공유)
                df = get_cached_ohlcv(ticker, interval="minute240", count=50)
                if df is None or len(df) < 25:
                    continue

                atr_series = compute_atr(df, period=14)
                atr_val = float(atr_series.iloc[-1]) if not pd.isna(atr_series.iloc[-1]) else current_price * 0.02
                sma5 = float(df["close"].rolling(5).mean().iloc[-1])
                vol_ma20 = float(df["volume"].rolling(20).mean().iloc[-1])
                curr_vol = float(df["volume"].iloc[-1])

                # 현재 해당 코인에 대해 열려 있는 bot_vb 포지션 조회 (market/ticker 호환)
                conn = get_db_connection(db_path)
                open_pos = conn.execute(
                    "SELECT * FROM bot_positions WHERE (bot_id = ? OR bot_id = ?) AND COALESCE(NULLIF(ticker, ''), market) = ? AND status = 'OPEN';",
                    (bot_id, norm_id, ticker),
                ).fetchone()
                conn.close()

                # 2. 보유 중 포지션 관리: ATR 트레일링 스탑 및 3단계 스마트 청산
                if open_pos:
                    open_pos_dict = dict(open_pos)
                    pos_id = open_pos_dict["id"]
                    highest_price = max(float(open_pos_dict.get("highest_price") or 0.0), current_price)

                    # 최고가 갱신 (commit 필수 + 인메모리 동기화)
                    if highest_price > float(open_pos_dict.get("highest_price") or 0.0):
                        conn = get_db_connection(db_path)
                        conn.execute("UPDATE bot_positions SET highest_price = ? WHERE id = ?;", (highest_price, pos_id))
                        conn.commit()
                        conn.close()
                        open_pos_dict["highest_price"] = highest_price

                    # 스마트 청산(본절 스탑, 시간 제한 청산, 동적 ATR 트레일링 스탑)
                    rvol_val = curr_vol / vol_ma20 if vol_ma20 > 0 else 1.0
                    smart_exit = evaluate_smart_exit(
                        norm_id,
                        open_pos_dict,
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
                            buy_res = execute_buy_order(bot_id, ticker, invest_krw, step_level=1, db_path=db_path, buy_reason="VB_BREAKOUT")
                            if buy_res:
                                available_krw = max(0.0, available_krw - float(buy_res.get("buy_amount") or invest_krw))
                        else:
                            logger.info("[%s] Entry blocked by gateway for %s: %s", bot_id, ticker, reason)

        except Exception as loop_exc:
            logger.error("[%s] Unexpected error in loop: %s", bot_id, loop_exc, exc_info=True)
        finally:
            release_live_cycle_mutex(norm_id)

        if stop_event.wait(timeout=10):
            break

    logger.info("Bot process [%s] gracefully stopped.", bot_id)


# =====================================================================
# 6. Step 4: 봇 2 (`bot_momentum`) - 볼린저 밴드 스퀴즈 돌파 (VCP)
# =====================================================================

# [Antigravity-Doc] 역할: [Bot 2] 볼린저 밴드 스퀴즈(VCP) 돌파 스윙 워커 루프 — 24h 거래대금 100억+ 종목 스캔, 최대 2슬롯 분할 진입, 20MA 하향 이탈/스마트 청산 (15초 주기)
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
        if not acquire_live_cycle_mutex(norm_id):
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
                pos_dict = dict(pos)
                pos_id = pos_dict["id"]
                ticker = str(pos_dict.get("ticker") or pos_dict.get("market") or "")
                if not ticker:
                    continue
                current_price = get_safe_current_price(ticker)
                if current_price <= 0:
                    continue

                df = get_cached_ohlcv(ticker, interval="minute240", count=25)
                if df is not None and len(df) >= 20:
                    highest_price = max(float(pos_dict.get("highest_price") or 0.0), current_price)
                    if highest_price > float(pos_dict.get("highest_price") or 0.0):
                        conn = get_db_connection(db_path)
                        conn.execute("UPDATE bot_positions SET highest_price = ? WHERE id = ?;", (highest_price, pos_id))
                        conn.commit()
                        conn.close()
                        pos_dict["highest_price"] = highest_price

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
                        pos_dict,
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

            # 2. 신규 진입 슬롯 확인 (Graceful Drain/중지 봇은 신규 진입 차단)
            open_count = len(open_positions)
            remaining_slots = MAX_POSITIONS - open_count

            if allow_new_buys and remaining_slots > 0 and available_krw >= MIN_ORDER_KRW:
                # 24시간 거래대금 상위 종목 필터링 (100억 원 이상 - market_hub 캐시 공유)
                tickers = get_cached_tickers(fiat="KRW")
                qualifying_candidates = []

                for t in tickers[:25]:  # 상위 후보 탐색
                    if stop_event.is_set():
                        break
                    time.sleep(0.12)  # Rate Limit 준수

                    # 이미 보유 중인 코인 제외
                    if any((dict(p).get("ticker") or dict(p).get("market")) == t for p in open_positions):
                        continue

                    df = get_cached_ohlcv(t, interval="minute240", count=30)
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
                        buy_res = execute_buy_order(bot_id, candidate, invest_krw, step_level=1, db_path=db_path, buy_reason="BB_SQUEEZE_BREAKOUT")
                        if buy_res:
                            available_krw = max(0.0, available_krw - float(buy_res.get("buy_amount") or invest_krw))
                            remaining_slots -= 1
                    else:
                        logger.info("[%s] Entry blocked by gateway for %s: %s", bot_id, candidate, reason)

        except Exception as loop_exc:
            logger.error("[%s] Unexpected error in loop: %s", bot_id, loop_exc, exc_info=True)
        finally:
            release_live_cycle_mutex(norm_id)

        if stop_event.wait(timeout=15):
            break

    logger.info("Bot process [%s] gracefully stopped.", bot_id)


# =====================================================================
# 7. Step 4: 봇 3 (`bot_bb`) - 다단계 분할 매수 볼린저 역추세 (DCA / Grid)
# =====================================================================

# [Antigravity-Doc] 역할: [Bot 3] 볼린저 하단 + RSI<=40 과매도 1차 진입 및 -3%/-6% 3단계 분할 매수(DCA) 워커 루프 — 개별 +1.8% / 20MA 회귀 익절 / -5%~-7% 안전 손절 (10초 주기)
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
        if not acquire_live_cycle_mutex(norm_id):
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
                pos_dict = dict(pos)
                pos_id = pos_dict["id"]
                ticker = str(pos_dict.get("ticker") or pos_dict.get("market") or "")
                if not ticker:
                    continue
                avg_buy_price = float(pos_dict["avg_buy_price"])
                step_level = int(pos_dict.get("step_level") or 1)

                current_price = get_safe_current_price(ticker)
                if current_price <= 0:
                    continue

                highest_price = max(float(pos_dict.get("highest_price") or 0.0), current_price)
                if highest_price > float(pos_dict.get("highest_price") or 0.0):
                    conn = get_db_connection(db_path)
                    conn.execute("UPDATE bot_positions SET highest_price = ? WHERE id = ?;", (highest_price, pos_id))
                    conn.commit()
                    conn.close()
                    pos_dict["highest_price"] = highest_price

                df = get_cached_ohlcv(ticker, interval="minute30", count=25)
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
                    pos_dict,
                    current_price,
                    atr=atr_val,
                    rvol=rvol_val,
                    is_live=not is_dry_run(),
                )
                if smart_exit:
                    logger.info("[%s] Smart Exit on %s: %s", norm_id, ticker, smart_exit["reason"])
                    execute_sell_order(pos_id, reason=smart_exit["reason"], db_path=db_path)
                    continue

                pnl_ratio = (current_price - avg_buy_price) / avg_buy_price if avg_buy_price > 0 else 0.0

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

                # B. 중심선(20선) 평균회귀 익절 (캐시 재사용)
                if middle_band is not None and current_price >= middle_band and pnl_ratio > 0.005:
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

            # 2. 신규 1차 진입 또는 추가 다단계 분할 매수(물타기) 점검 (Graceful Drain/중지 봇 차단)
            if allow_new_buys and available_krw >= MIN_ORDER_KRW:
                for ticker in target_tickers:
                    if stop_event.is_set() or available_krw < MIN_ORDER_KRW:
                        break

                    current_price = get_safe_current_price(ticker)
                    if current_price <= 0:
                        continue

                    df = get_cached_ohlcv(ticker, interval="minute30", count=30)
                    if df is None or len(df) < 22:
                        continue

                    middle, upper, lower, bw = compute_bollinger_bands(df, period=20, num_std=2.0)
                    rsi_series = compute_rsi(df, period=14)

                    lower_val = float(lower.iloc[-1])
                    rsi_val = float(rsi_series.iloc[-1]) if not pd.isna(rsi_series.iloc[-1]) else 50.0

                    # 해당 코인의 현재 열린 포지션 목록 조회
                    conn = get_db_connection(db_path)
                    ticker_positions = conn.execute(
                        "SELECT * FROM bot_positions WHERE (bot_id = ? OR bot_id = ?) AND COALESCE(NULLIF(ticker, ''), market) = ? AND status = 'OPEN' ORDER BY id ASC;",
                        (bot_id, norm_id, ticker),
                    ).fetchall()
                    conn.close()

                    # Case A: 1차 신규 진입 (볼린저 하단 이탈 + RSI <= 40)
                    if len(ticker_positions) == 0 and available_krw >= MIN_ORDER_KRW:
                        if current_price <= lower_val and rsi_val <= 40.0:
                            logger.info(
                                f"[{bot_id}] Oversold dip on {ticker}: Price={current_price:,.0f} "
                                f"<= Lower={lower_val:,.0f}, RSI={rsi_val:.1f}"
                            )
                            first_entry_budget = available_krw * 0.40
                            can_enter, invest_krw, reason = can_enter_position(
                                bot_id, ticker, first_entry_budget, db_path=db_path
                            )
                            if can_enter:
                                buy_res = execute_buy_order(bot_id, ticker, invest_krw, step_level=1, db_path=db_path, buy_reason="BB_DCA_STEP_1")
                                if buy_res:
                                    available_krw = max(0.0, available_krw - float(buy_res.get("buy_amount") or invest_krw))

                    # Case B: 추가 분할 매수 (-3% 추가 하락 시 2차 진입, -6% 추가 하락 시 3차 진입)
                    elif len(ticker_positions) > 0 and available_krw >= MIN_ORDER_KRW:
                        max_step = max(int(p["step_level"] or 1) for p in ticker_positions)
                        base_buy_price = float(ticker_positions[0]["avg_buy_price"])
                        drop_ratio = (current_price - base_buy_price) / base_buy_price if base_buy_price > 0 else 0.0

                        if max_step == 1 and drop_ratio <= -0.03:
                            logger.info("[%s] DCA Step 2 triggered on %s: Drop=%.2f%%", bot_id, ticker, drop_ratio * 100.0)
                            can_enter, invest_krw, reason = can_enter_position(
                                bot_id, ticker, available_krw * 0.50, db_path=db_path
                            )
                            if can_enter:
                                buy_res = execute_buy_order(bot_id, ticker, invest_krw, step_level=2, db_path=db_path, buy_reason="BB_DCA_STEP_2")
                                if buy_res:
                                    available_krw = max(0.0, available_krw - float(buy_res.get("buy_amount") or invest_krw))

                        elif max_step == 2 and drop_ratio <= -0.06:
                            logger.info("[%s] DCA Step 3 triggered on %s: Drop=%.2f%%", bot_id, ticker, drop_ratio * 100.0)
                            can_enter, invest_krw, reason = can_enter_position(
                                bot_id, ticker, available_krw, db_path=db_path
                            )
                            if can_enter:
                                buy_res = execute_buy_order(bot_id, ticker, invest_krw, step_level=3, db_path=db_path, buy_reason="BB_DCA_STEP_3")
                                if buy_res:
                                    available_krw = max(0.0, available_krw - float(buy_res.get("buy_amount") or invest_krw))

        except Exception as loop_exc:
            logger.error("[%s] Unexpected error in loop: %s", bot_id, loop_exc, exc_info=True)
        finally:
            release_live_cycle_mutex(norm_id)

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

# [Antigravity-Doc] BOT_RUNNERS: 표준 10대 봇(bot_01~bot_10) 및 레거시 별칭과 워커 실행 함수를 매핑하는 통합 레지스트리 (main_orchestrator.py에서 참조)
# 10대 알고리즘 및 레거시 봇 통합 러너 레지스트리
BOT_RUNNERS: Dict[str, Any] = {
    "bot_01": run_bot_vb,
    "bot_02": run_bot_vb,
    "bot_03": run_bot_momentum,
    "bot_04": run_bot_momentum,
    "bot_05": run_bot_bb,
    "bot_06": run_bot_bb,
    "bot_07": run_bot_momentum,
    "bot_08": run_bot_bb,
    "bot_09": run_bot_momentum,
    "bot_10": run_bot_jack_kellogg,
    # 하위 호환 별칭
    "bot_vb": run_bot_vb,
    "bot_momentum": run_bot_momentum,
    "bot_bb": run_bot_bb,
    "bot_kellogg": run_bot_jack_kellogg,
    "bot_jack_kellogg": run_bot_jack_kellogg,
}

