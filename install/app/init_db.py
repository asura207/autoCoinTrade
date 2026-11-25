# [Antigravity-Doc] ============================================================
# [Antigravity-Doc] 파일 역할: SQLite(WAL) 및 PostgreSQL 듀얼 DB 추상화 레이어, 전체 테이블 스키마 정의, 무중단 컬럼 마이그레이션 및 초기 시드 데이터 생성
# [Antigravity-Doc] 아키텍처 위치: 모든 Python 모듈(main_orchestrator.py, bots.py, llm_filter_worker.py, bot_10_jack_kellogg.py)의 최하단 영속성 레이어
# [Antigravity-Doc] 주요 의존성: sqlite3(기본 내장), psycopg2(PostgreSQL 하이브리드 모드 선택적 의존), pathlib, re
# [Antigravity-Doc] 수정 시 주의사항:
# [Antigravity-Doc]   1) Node.js 백엔드(backend/node_server.mjs)와 동일한 DB 파일(data/auto_coin_trade.db) 및 스키마를 공유하므로 컬럼명/기본값 변경 시 양쪽 동기화 필수
# [Antigravity-Doc]   2) PgConnectionWrapper._convert_sql은 SQLite 문법(?, INSERT OR IGNORE, AUTOINCREMENT 등)을 PostgreSQL 문법으로 동적 변환함
# [Antigravity-Doc] ============================================================
"""
init_db.py - 데이터베이스 스키마 정의 및 커넥션 모듈 (SQLite & PostgreSQL 동적 분기 지원)
- DB_MODE=sqlite 또는 PG_SYNC_ENABLED=false 시: 내장 SQLite (data/auto_coin_trade.db, WAL 모드, busy_timeout=5000)
- DB_MODE=postgres_hybrid 시: PostgreSQL (coin_trader)
- 봇 가상 원장 테이블 (bot_accounts, bot_positions, bots, trades 등)
- LLM 시장 체제 & 감성 필터 상태 테이블 (market_regime_filter, id=1 단일 행)
"""

import json
import logging
import os
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
    HAS_PSYCOPG2 = True
except ImportError:
    HAS_PSYCOPG2 = False

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("init_db")

# [Antigravity-Doc] 프로젝트 루트, .env 경로, 데이터 디렉터리 및 기본 SQLite DB 파일 경로 상수
PROJECT_ROOT = Path(__file__).resolve().parent
ENV_PATH = Path(os.getenv("AUTOCOIN_ENV_PATH") or str(PROJECT_ROOT / ".env"))
DATA_DIR = PROJECT_ROOT / "data"
DEFAULT_SQLITE_PATH = str(DATA_DIR / "auto_coin_trade.db")
DEFAULT_DB_PATH = DEFAULT_SQLITE_PATH

# [Antigravity-Doc] ALL_BOT_IDS: 10대 알고리즘 봇 표준 ID 튜플 (bot_01 ~ bot_10)
ALL_BOT_IDS = tuple(f"bot_{i:02d}" for i in range(1, 11))
# [Antigravity-Doc] DEFAULT_BOT_OVERRIDES / JSON: AI 필터 초기 상태(10대 봇 전체 ALLOW) 기본값
DEFAULT_BOT_OVERRIDES: Dict[str, str] = {bot_id: "ALLOW" for bot_id in ALL_BOT_IDS}
DEFAULT_BOT_OVERRIDES_JSON = json.dumps(DEFAULT_BOT_OVERRIDES, ensure_ascii=False, separators=(",", ":"))
# [Antigravity-Doc] LEGACY_BOT_OVERRIDE_ALIAS: 구버전 3대 봇 ID(bot_vb/bot_momentum/bot_bb) -> 표준 ID 매핑
LEGACY_BOT_OVERRIDE_ALIAS = {
    "bot_vb": "bot_01",
    "bot_momentum": "bot_03",
    "bot_bb": "bot_05",
}
# [Antigravity-Doc] BOT_STRATEGY_GROUP_MAP: 주간 자동 로테이션 시 전략군별 1위 봇 선출을 위한 3대 전략군 분류 매핑
BOT_STRATEGY_GROUP_MAP: Dict[str, str] = {
    "bot_02": "TREND_SWING",
    "bot_03": "TREND_SWING",
    "bot_07": "TREND_SWING",
    "bot_08": "TREND_SWING",
    "bot_01": "VOLATILITY_BREAKOUT",
    "bot_04": "VOLATILITY_BREAKOUT",
    "bot_09": "VOLATILITY_BREAKOUT",
    "bot_05": "REVERSAL_GRID",
    "bot_06": "REVERSAL_GRID",
    "bot_10": "REVERSAL_GRID",
}
# [Antigravity-Doc] KST_TZ: 한국 표준시(UTC+9) 타임존 객체 (업비트 일봉/로테이션/타임스톱 기준 시각 통일)
KST_TZ = timezone(timedelta(hours=9))


# [Antigravity-Doc] 역할: 현재 KST 시각을 'YYYY-MM-DD HH:MM:SS' 문자열로 반환
def _now_kst_str() -> str:
    return datetime.now(KST_TZ).strftime("%Y-%m-%d %H:%M:%S")


# [Antigravity-Doc] 역할: 지정 요일(0=일~6=토) 및 시각(KST) 기준 다음 주간 로테이션 예정 시각 문자열 계산
def _compute_next_rotation_kst(day_of_week: int = 1, hour_kst: int = 9) -> str:
    """0=일, 1=월 ... 6=토 기준 다음 주간 로테이션 예정 KST 시각 문자열 반환"""
    now = datetime.now(KST_TZ).replace(minute=0, second=0, microsecond=0)
    cur_dow = (now.weekday() + 1) % 7
    delta_days = (int(day_of_week) - cur_dow) % 7
    candidate = (now + timedelta(days=delta_days)).replace(hour=int(hour_kst), minute=0, second=0, microsecond=0)
    if candidate <= datetime.now(KST_TZ):
        candidate += timedelta(days=7)
    return candidate.strftime("%Y-%m-%d %H:%M:%S")


# [Antigravity-Doc] 역할: 문자열/딕셔너리 형태의 봇 오버라이드 설정을 레거시 별칭 포함하여 표준 10대 봇('ALLOW'|'BLOCK') 딕셔너리로 정규화
# [Antigravity-Doc] 입력: raw_overrides(JSON 문자열 또는 dict) | 반환: Dict[str, str] (bot_01~bot_10 전 키 보장)
def normalize_bot_overrides(raw_overrides: Any) -> Dict[str, str]:
    """
    기존 3대 레거시 키(bot_vb 등)나 일부 누락된 봇 키가 전달되어도
    표준 10대 봇(bot_01 ~ bot_10) 딕셔너리('ALLOW'|'BLOCK')로 병합/정규화합니다.
    """
    parsed: Dict[str, Any] = {}
    if isinstance(raw_overrides, str) and raw_overrides.strip():
        try:
            loaded = json.loads(raw_overrides)
            if isinstance(loaded, dict):
                parsed = loaded
        except Exception:
            parsed = {}
    elif isinstance(raw_overrides, dict):
        parsed = raw_overrides

    result: Dict[str, str] = {bot_id: "ALLOW" for bot_id in ALL_BOT_IDS}
    for legacy_key, modern_key in LEGACY_BOT_OVERRIDE_ALIAS.items():
        val = str(parsed.get(legacy_key, "")).strip().upper()
        if val in ("ALLOW", "BLOCK") and modern_key not in parsed:
            result[modern_key] = val

    for bot_id in ALL_BOT_IDS:
        val = str(parsed.get(bot_id, "")).strip().upper()
        if val in ("ALLOW", "BLOCK"):
            result[bot_id] = val
    return result

# [Antigravity-Doc] 역할: .env 파일에서 미설정 환경변수만 안전하게 로드 (기존 OS 환경변수 우선 보존)
def _load_env():
    if ENV_PATH.exists():
        with open(ENV_PATH, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    k, v = line.split("=", 1)
                    k, v = k.strip(), v.strip()
                    if k and (k not in os.environ or os.environ[k] == ""):
                        os.environ[k] = v

_load_env()

# [Antigravity-Doc] 역할: 환경변수(DB_MODE, PG_SYNC_ENABLED)를 기준으로 SQLite 모드(True) vs PostgreSQL 모드(False) 판별
def is_sqlite_mode() -> bool:
    """
    현재 설정이 SQLite 모드인지 확인합니다.
    - DB_MODE=sqlite 또는 PG_SYNC_ENABLED=false -> SQLite
    - DB_MODE=postgres / postgresql / postgres_hybrid / server -> PostgreSQL
    - 미설정 시 백엔드(node_server.mjs)와 동일하게 SQLite를 기본값으로 사용
    """
    _load_env()
    mode = os.getenv("DB_MODE", "").strip().lower()
    sync_enabled = os.getenv("PG_SYNC_ENABLED", "").strip().lower()

    if mode == "sqlite" or sync_enabled == "false":
        return True
    if mode in ("postgres_hybrid", "postgres", "postgresql", "server"):
        return False
    return True


# [Antigravity-Doc] 클래스 역할: sqlite3.Cursor와 psycopg2 RealDictCursor 간 동일한 fetchone/fetchall/rowcount 인터페이스를 제공하는 래퍼
class CursorWrapper:
    def __init__(self, cur):
        self.cur = cur

    def fetchone(self):
        return self.cur.fetchone()

    def fetchall(self):
        return self.cur.fetchall()

    @property
    def rowcount(self):
        return self.cur.rowcount


# [Antigravity-Doc] 클래스 역할: SQLite 커넥션에 sqlite3.Row 팩토리와 PostgreSQL 호환 SQL 변환(ILIKE->LIKE, %s->?)을 제공하는 래퍼
class SqliteConnectionWrapper:
    """
    SQLite3 커넥션 래퍼 (Row 객체 및 호환 인터페이스)
    """
    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn
        self.conn.row_factory = sqlite3.Row

    # [Antigravity-Doc] PostgreSQL 스타일 플레이스홀더(%s) 및 ILIKE를 SQLite 문법(?, LIKE)으로 변환
    def _convert_sql(self, sql: str) -> str:
        s = sql.strip()
        # ILIKE -> LIKE
        s = re.sub(r"\bILIKE\b", "LIKE", s, flags=re.I)
        # %s -> ?
        s = s.replace("%s", "?")
        return s

    def execute(self, sql: str, params: Optional[Any] = None) -> CursorWrapper:
        final_sql = self._convert_sql(sql)
        cur = self.conn.cursor()
        if params is not None:
            cur.execute(final_sql, params)
        else:
            cur.execute(final_sql)
        return CursorWrapper(cur)

    def commit(self) -> None:
        self.conn.commit()

    def rollback(self) -> None:
        self.conn.rollback()

    def close(self) -> None:
        self.conn.close()


# [Antigravity-Doc] 클래스 역할: SQLite 문법으로 작성된 쿼리를 PostgreSQL 문법(BIGSERIAL, ON CONFLICT, %s)으로 자동 변환해 실행하는 커넥션 래퍼
class PgConnectionWrapper:
    """
    SQLite 호환 인터페이스를 제공하는 PostgreSQL 커넥션 래퍼
    """
    def __init__(self, pg_conn):
        self.conn = pg_conn

    # [Antigravity-Doc] SQLite 전용 구문(PRAGMA, BEGIN IMMEDIATE, AUTOINCREMENT, INSERT OR IGNORE/REPLACE, ?)을 PostgreSQL 호환 SQL로 치환
    def _convert_sql(self, sql: str) -> str:
        s = sql.strip()
        if re.match(r"^PRAGMA\s+", s, re.I):
            return "SELECT 1;"
        if "BEGIN IMMEDIATE" in s.upper():
            return "SELECT 1;"

        had_semicolon = s.endswith(";")
        s_body = s.rstrip(";").strip()

        # AUTOINCREMENT -> BIGSERIAL PRIMARY KEY
        s_body = re.sub(r"INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT", "BIGSERIAL PRIMARY KEY", s_body, flags=re.I)

        # INSERT OR IGNORE INTO
        m = re.search(r"INSERT\s+OR\s+IGNORE\s+INTO\s+([a-zA-Z0-9_]+)", s_body, re.I)
        if m:
            tbl = m.group(1).lower()
            s_body = re.sub(r"INSERT\s+OR\s+IGNORE\s+INTO", "INSERT INTO", s_body, flags=re.I)
            if "ON CONFLICT" not in s_body.upper():
                if tbl == "market_regime_filter":
                    s_body += " ON CONFLICT (id) DO NOTHING"
                elif tbl == "auto_rotation_config":
                    s_body += " ON CONFLICT (id) DO NOTHING"
                elif tbl == "bot_accounts":
                    s_body += " ON CONFLICT (bot_id) DO NOTHING"
                elif tbl == "bot_positions":
                    s_body += " ON CONFLICT (order_uuid) DO NOTHING"
                elif tbl == "system_settings":
                    s_body += " ON CONFLICT (key) DO NOTHING"
                else:
                    s_body += " ON CONFLICT DO NOTHING"

        # INSERT OR REPLACE INTO system_settings
        if re.search(r"INSERT\s+OR\s+REPLACE\s+INTO\s+system_settings", s_body, re.I):
            s_body = re.sub(r"INSERT\s+OR\s+REPLACE\s+INTO\s+system_settings", "INSERT INTO system_settings", s_body, flags=re.I)
            if "ON CONFLICT" not in s_body.upper():
                s_body += " ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at"

        # ? -> %s
        s_body = s_body.replace("?", "%s")
        return f"{s_body};" if had_semicolon else s_body

    def execute(self, sql: str, params: Optional[Any] = None) -> CursorWrapper:
        final_sql = self._convert_sql(sql)
        cur = self.conn.cursor(cursor_factory=RealDictCursor)
        if params is not None:
            cur.execute(final_sql, params)
        else:
            cur.execute(final_sql)
        return CursorWrapper(cur)

    def commit(self) -> None:
        self.conn.commit()

    def rollback(self) -> None:
        self.conn.rollback()

    def close(self) -> None:
        self.conn.close()


# [Antigravity-Doc] 역할: 현재 DB 모드에 따라 SQLite(WAL, busy_timeout=5000ms) 또는 PostgreSQL(LOCAL/OUTER 분기) 커넥션 래퍼 생성·반환
# [Antigravity-Doc] 입력: db_path(선택 SQLite 파일 경로) | 반환: SqliteConnectionWrapper 또는 PgConnectionWrapper
def get_db_connection(db_path: Optional[str] = None):
    """
    설정에 따라 SQLite 또는 PostgreSQL 커넥션을 생성하여 반환합니다.
    """
    _load_env()
    # [Antigravity-Doc] SQLite 모드: 멀티프로세스 동시 읽기/쓰기 경합 완화를 위해 WAL 저널 모드와 5초 busy_timeout 적용
    if is_sqlite_mode():
        raw_path = db_path or os.getenv("AUTOCOIN_DB_PATH") or os.getenv("DB_PATH") or DEFAULT_SQLITE_PATH
        resolved_path = Path(raw_path)
        if not resolved_path.is_absolute():
            resolved_path = (PROJECT_ROOT / resolved_path).resolve()
        resolved_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(resolved_path), timeout=5.0)
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA busy_timeout = 5000;")
        conn.execute("PRAGMA synchronous = NORMAL;")
        return SqliteConnectionWrapper(conn)

    # [Antigravity-Doc] PostgreSQL 모드: LOCATION(local/outer) 환경변수에 따라 접속 정보를 선택하고 수동 커밋(autocommit=False)으로 연결
    if not HAS_PSYCOPG2:
        raise ImportError("PostgreSQL 모드를 사용하려면 psycopg2-binary가 설치되어 있어야 합니다. (pip install psycopg2-binary)")

    location = os.getenv("LOCATION", "local").strip().lower()
    is_outer = location == "outer"

    if is_outer:
        host = os.getenv("OUTER_PG_HOST", os.getenv("PGHOST", "127.0.0.1"))
        port = int(os.getenv("OUTER_PG_PORT", os.getenv("PGPORT", "5432")))
        database = os.getenv("OUTER_PG_DATABASE", os.getenv("PGDATABASE", "coin_trader"))
        user = os.getenv("OUTER_PG_USER", os.getenv("PGUSER", "coin_trader"))
        password = os.getenv("OUTER_PG_PASSWORD", os.getenv("PGPASSWORD", ""))
    else:
        host = os.getenv("LOCAL_PG_HOST", os.getenv("PGHOST", "127.0.0.1"))
        port = int(os.getenv("LOCAL_PG_PORT", os.getenv("PGPORT", "5432")))
        database = os.getenv("LOCAL_PG_DATABASE", os.getenv("PGDATABASE", "coin_trader"))
        user = os.getenv("LOCAL_PG_USER", os.getenv("PGUSER", "coin_trader"))
        password = os.getenv("LOCAL_PG_PASSWORD", os.getenv("PGPASSWORD", ""))

    conn = psycopg2.connect(
        host=host,
        port=port,
        dbname=database,
        user=user,
        password=password,
    )
    conn.autocommit = False
    return PgConnectionWrapper(conn)


# [Antigravity-Doc] 역할: 전체 20여 개 운영 테이블 생성(CREATE IF NOT EXISTS), 구버전 DB 무중단 컬럼 추가 마이그레이션(ALTER TABLE), 기본 설정/봇 계좌/AI 필터 시드 초기화
# [Antigravity-Doc] 입력: db_path(선택 DB 경로) | 반환: None (오류 시 전체 트랜잭션 롤백 후 예외 재발생)
def init_database(db_path: Optional[str] = None) -> None:
    """
    데이터베이스(SQLite 또는 PostgreSQL) 전체 테이블 스키마를 초기화하고 기본 데이터를 시딩합니다.
    """
    _load_env()
    sqlite_mode = is_sqlite_mode()
    conn = get_db_connection(db_path)
    try:
        id_primary_key = "INTEGER PRIMARY KEY AUTOINCREMENT" if sqlite_mode else "BIGSERIAL PRIMARY KEY"
        real_type = "REAL" if sqlite_mode else "DOUBLE PRECISION"

        # [Antigravity-Doc] 테이블 1: bot_accounts — 봇별 가상 원장 계좌(배정 비중, 배정 원금, 가용 원화, 누적 실현손익, 실전 선택 여부)
        # 1. 봇 가상 원장 계좌 테이블 (bot_accounts)
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS bot_accounts (
                bot_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                allocation_ratio {real_type} NOT NULL,
                allocated_capital {real_type} NOT NULL DEFAULT 0.0,
                virtual_krw {real_type} NOT NULL DEFAULT 0.0,
                total_realized_pnl {real_type} NOT NULL DEFAULT 0.0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_selected_for_live INTEGER NOT NULL DEFAULT 0
            );
            """
        )
        if sqlite_mode:
            acc_cols = {
                dict(r)["name"]
                for r in conn.execute("PRAGMA table_info(bot_accounts);").fetchall()
            }
            if "is_selected_for_live" not in acc_cols:
                conn.execute("ALTER TABLE bot_accounts ADD COLUMN is_selected_for_live INTEGER NOT NULL DEFAULT 0;")
        else:
            conn.execute("ALTER TABLE bot_accounts ADD COLUMN IF NOT EXISTS is_selected_for_live INTEGER NOT NULL DEFAULT 0;")

        # [Antigravity-Doc] 테이블 2: bot_positions — 봇별 개별 오픈/청산 포지션 원장 (order_uuid UNIQUE, closing_lock으로 중복 매도 방어, market/ticker 양방향 동기화)
        # 2. 봇별 독립 포지션 테이블 (bot_positions)
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS bot_positions (
                id {id_primary_key},
                bot_id TEXT NOT NULL,
                market TEXT NOT NULL DEFAULT 'KRW-BTC',
                ticker TEXT,
                order_uuid TEXT NOT NULL UNIQUE,
                volume TEXT NOT NULL,
                avg_buy_price {real_type} NOT NULL,
                buy_amount BIGINT NOT NULL,
                buy_fee {real_type} NOT NULL DEFAULT 0.0,
                trade_id BIGINT NOT NULL DEFAULT 0,
                highest_price {real_type} DEFAULT 0.0,
                step_level INTEGER DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'OPEN',
                created_at TEXT NOT NULL,
                closed_at TEXT,
                sell_order_uuid TEXT,
                sell_price {real_type},
                sell_amount {real_type},
                sell_fee {real_type},
                realized_pnl {real_type},
                pnl_pct {real_type},
                buy_reason TEXT,
                expected_price {real_type},
                slippage_bps {real_type},
                atr_sizing_mult {real_type},
                closing_lock INTEGER NOT NULL DEFAULT 0
            );
            """
        )
        pos_alter_cols = [
            ("market", "TEXT NOT NULL DEFAULT 'KRW-BTC'"),
            ("ticker", "TEXT"),
            ("trade_id", "BIGINT NOT NULL DEFAULT 0"),
            ("highest_price", f"{real_type} DEFAULT 0.0"),
            ("step_level", "INTEGER DEFAULT 1"),
            ("sell_order_uuid", "TEXT"),
            ("sell_price", real_type),
            ("sell_amount", real_type),
            ("sell_fee", real_type),
            ("realized_pnl", real_type),
            ("pnl_pct", real_type),
            ("buy_reason", "TEXT"),
            ("expected_price", real_type),
            ("slippage_bps", real_type),
            ("atr_sizing_mult", real_type),
            ("closing_lock", "INTEGER NOT NULL DEFAULT 0"),
        ]
        if sqlite_mode:
            existing_pos_cols = {
                dict(r)["name"]
                for r in conn.execute("PRAGMA table_info(bot_positions);").fetchall()
            }
            for col_name, col_def in pos_alter_cols:
                if col_name not in existing_pos_cols:
                    conn.execute(f"ALTER TABLE bot_positions ADD COLUMN {col_name} {col_def};")
        else:
            for col_name, col_def in pos_alter_cols:
                conn.execute(f"ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS {col_name} {col_def};")

        conn.execute(
            "UPDATE bot_positions SET market = ticker WHERE (market IS NULL OR market = '') AND ticker IS NOT NULL AND ticker != '';"
        )
        conn.execute(
            "UPDATE bot_positions SET ticker = market WHERE (ticker IS NULL OR ticker = '') AND market IS NOT NULL AND market != '';"
        )

        # [Antigravity-Doc] 테이블 3: market_regime_filter — 듀얼 AI(Flash/Pro) 시장 체제·리스크 경보·비중 배율·10대 봇 오버라이드 단일 행(id=1) 스냅샷
        # 3. LLM 시장 체제 & 뉴스 감성 필터 테이블 (market_regime_filter)
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS market_regime_filter (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                sentiment_score {real_type} DEFAULT 0.0,
                market_regime TEXT DEFAULT 'SIDEWAYS',
                risk_alert INTEGER DEFAULT 0,
                recommended_action TEXT DEFAULT 'NORMAL',
                position_size_multiplier {real_type} DEFAULT 1.0,
                bot_overrides_json TEXT DEFAULT '{DEFAULT_BOT_OVERRIDES_JSON}',
                blacklist_tickers_json TEXT DEFAULT '[]',
                reason TEXT DEFAULT 'Initial default state',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                flash_sentiment_score {real_type} DEFAULT 0.0,
                flash_recommended_action TEXT DEFAULT 'NORMAL',
                flash_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                pro_sentiment_score {real_type} DEFAULT 0.0,
                pro_recommended_action TEXT DEFAULT 'NORMAL',
                pro_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                final_risk_alert INTEGER DEFAULT 0,
                final_position_multiplier {real_type} DEFAULT 1.0,
                final_bot_overrides_json TEXT DEFAULT '{DEFAULT_BOT_OVERRIDES_JSON}'
            );
            """
        )
        # 기존 구버전 DB 마이그레이션 (dual AI 컬럼 누락 시 안전 추가)
        regime_alter_cols = [
            ("flash_sentiment_score", f"{real_type} DEFAULT 0.0"),
            ("flash_recommended_action", "TEXT DEFAULT 'NORMAL'"),
            ("flash_updated_at", "TIMESTAMP" if not sqlite_mode else "TEXT"),
            ("pro_sentiment_score", f"{real_type} DEFAULT 0.0"),
            ("pro_recommended_action", "TEXT DEFAULT 'NORMAL'"),
            ("pro_updated_at", "TIMESTAMP" if not sqlite_mode else "TEXT"),
            ("final_risk_alert", "INTEGER DEFAULT 0"),
            ("final_position_multiplier", f"{real_type} DEFAULT 1.0"),
            ("final_bot_overrides_json", f"TEXT DEFAULT '{DEFAULT_BOT_OVERRIDES_JSON}'"),
        ]
        newly_added_final_col = False
        if sqlite_mode:
            existing_cols = {
                dict(r)["name"]
                for r in conn.execute("PRAGMA table_info(market_regime_filter);").fetchall()
            }
            newly_added_final_col = "final_bot_overrides_json" not in existing_cols
            for col_name, col_def in regime_alter_cols:
                if col_name not in existing_cols:
                    conn.execute(f"ALTER TABLE market_regime_filter ADD COLUMN {col_name} {col_def};")
        else:
            for col_name, col_def in regime_alter_cols:
                conn.execute(f"ALTER TABLE market_regime_filter ADD COLUMN IF NOT EXISTS {col_name} {col_def};")

        # [Antigravity-Doc] 테이블 4~8: system_settings(키-값 런타임 설정), bots(10대 봇 실전/가상/Graceful Drain 메타), trades(실전 체결 원장), paper_*(가상 원장), ai_*/crypto_news(브리핑·뉴스)
        # 4. 시스템 설정 테이블 (system_settings)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS system_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )

        # 5. 10대 알고리즘 봇 테이블 (bots)
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS bots (
                bot_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                nickname TEXT NOT NULL,
                strategy_type TEXT NOT NULL,
                strategy_group TEXT DEFAULT 'TREND_SWING',
                description TEXT NOT NULL DEFAULT '',
                allocation_ratio {real_type} NOT NULL DEFAULT 0,
                allocated_capital BIGINT NOT NULL DEFAULT 0,
                virtual_krw BIGINT NOT NULL DEFAULT 0,
                is_running INTEGER NOT NULL DEFAULT 0,
                min_volume_krw BIGINT NOT NULL DEFAULT 0,
                stop_loss_pct {real_type} NOT NULL DEFAULT 0,
                take_profit_pct {real_type} NOT NULL DEFAULT 0,
                config_json TEXT NOT NULL DEFAULT '{{}}',
                last_status_msg TEXT NOT NULL DEFAULT '대기 중',
                updated_at TEXT NOT NULL,
                is_selected_for_live INTEGER NOT NULL DEFAULT 0,
                paper_initial_capital BIGINT NOT NULL DEFAULT 1000000,
                paper_virtual_krw BIGINT NOT NULL DEFAULT 1000000,
                paper_is_running INTEGER NOT NULL DEFAULT 1,
                paper_peak_equity BIGINT NOT NULL DEFAULT 1000000,
                paper_mdd_pct NUMERIC(8,2) NOT NULL DEFAULT 0,
                paper_status_msg TEXT NOT NULL DEFAULT '시그널 대기 중'
            );
            """
        )
        bots_alter_cols = [
            ("strategy_group", "TEXT DEFAULT 'TREND_SWING'"),
            ("is_selected_for_live", "INTEGER NOT NULL DEFAULT 0"),
            ("paper_initial_capital", "BIGINT NOT NULL DEFAULT 1000000"),
            ("paper_virtual_krw", "BIGINT NOT NULL DEFAULT 1000000"),
            ("paper_is_running", "INTEGER NOT NULL DEFAULT 1"),
            ("paper_peak_equity", "BIGINT NOT NULL DEFAULT 1000000"),
            ("paper_mdd_pct", "NUMERIC(8,2) NOT NULL DEFAULT 0"),
            ("paper_status_msg", "TEXT NOT NULL DEFAULT '시그널 대기 중'"),
            ("target_capital_krw", f"{real_type} DEFAULT 0"),
            ("drain_status", "TEXT DEFAULT 'NONE'"),
            ("replaced_by_bot_id", "TEXT DEFAULT NULL"),
            ("drain_started_at", "TEXT DEFAULT NULL"),
        ]
        if sqlite_mode:
            bot_cols = {
                dict(r)["name"]
                for r in conn.execute("PRAGMA table_info(bots);").fetchall()
            }
            for col_name, col_def in bots_alter_cols:
                if col_name not in bot_cols:
                    conn.execute(f"ALTER TABLE bots ADD COLUMN {col_name} {col_def};")
        else:
            for col_name, col_def in bots_alter_cols:
                conn.execute(f"ALTER TABLE bots ADD COLUMN IF NOT EXISTS {col_name} {col_def};")

        for b_id, s_grp in BOT_STRATEGY_GROUP_MAP.items():
            conn.execute("UPDATE bots SET strategy_group = ? WHERE bot_id = ?;", (s_grp, b_id))

        # 6. 실전 체결 원장 테이블 (trades)
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS trades (
                id {id_primary_key},
                bot_id TEXT NOT NULL,
                market TEXT NOT NULL,
                buy_order_uuid TEXT NOT NULL,
                sell_order_uuid TEXT,
                buy_price {real_type} NOT NULL,
                buy_volume TEXT NOT NULL,
                buy_amount BIGINT NOT NULL,
                buy_date TEXT NOT NULL,
                sell_price {real_type},
                sell_volume TEXT,
                sell_amount BIGINT,
                sell_date TEXT,
                profit_krw BIGINT,
                profit_pct {real_type},
                status TEXT NOT NULL DEFAULT 'HOLDING',
                buy_reason TEXT,
                sell_reason TEXT,
                expected_price {real_type},
                slippage_bps {real_type},
                atr_sizing_mult {real_type}
            );
            """
        )
        trade_alter_cols = [
            ("buy_reason", "TEXT"),
            ("sell_reason", "TEXT"),
            ("expected_price", real_type),
            ("slippage_bps", real_type),
            ("atr_sizing_mult", real_type),
        ]
        if sqlite_mode:
            tr_cols = {
                dict(r)["name"]
                for r in conn.execute("PRAGMA table_info(trades);").fetchall()
            }
            for col_name, col_def in trade_alter_cols:
                if col_name not in tr_cols:
                    conn.execute(f"ALTER TABLE trades ADD COLUMN {col_name} {col_def};")
        else:
            for col_name, col_def in trade_alter_cols:
                conn.execute(f"ALTER TABLE trades ADD COLUMN IF NOT EXISTS {col_name} {col_def};")

        # 7. 가상 체결 원장 테이블 (paper_trades, paper_bot_positions)
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS paper_trades (
                id {id_primary_key},
                bot_id TEXT NOT NULL,
                market TEXT NOT NULL,
                buy_order_uuid TEXT NOT NULL,
                sell_order_uuid TEXT,
                buy_price {real_type} NOT NULL,
                buy_volume TEXT NOT NULL,
                buy_amount BIGINT NOT NULL,
                buy_date TEXT NOT NULL,
                sell_price {real_type},
                sell_volume TEXT,
                sell_amount BIGINT,
                sell_date TEXT,
                profit_krw BIGINT,
                profit_pct {real_type},
                status TEXT NOT NULL DEFAULT 'HOLDING',
                buy_reason TEXT,
                sell_reason TEXT
            );
            """
        )
        paper_trade_alter_cols = [
            ("buy_reason", "TEXT"),
            ("sell_reason", "TEXT"),
        ]
        if sqlite_mode:
            pt_cols = {
                dict(r)["name"]
                for r in conn.execute("PRAGMA table_info(paper_trades);").fetchall()
            }
            for col_name, col_def in paper_trade_alter_cols:
                if col_name not in pt_cols:
                    conn.execute(f"ALTER TABLE paper_trades ADD COLUMN {col_name} {col_def};")
        else:
            for col_name, col_def in paper_trade_alter_cols:
                conn.execute(f"ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS {col_name} {col_def};")
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS paper_bot_positions (
                id {id_primary_key},
                bot_id TEXT NOT NULL,
                market TEXT NOT NULL,
                order_uuid TEXT NOT NULL UNIQUE,
                volume TEXT NOT NULL,
                avg_buy_price {real_type} NOT NULL,
                buy_amount BIGINT NOT NULL,
                buy_fee {real_type} NOT NULL DEFAULT 0,
                trade_id BIGINT NOT NULL,
                status TEXT NOT NULL DEFAULT 'OPEN',
                created_at TEXT NOT NULL,
                closed_at TEXT,
                buy_reason TEXT
            );
            """
        )
        if sqlite_mode:
            existing_paper_pos_cols = {
                dict(r)["name"]
                for r in conn.execute("PRAGMA table_info(paper_bot_positions);").fetchall()
            }
            if "buy_reason" not in existing_paper_pos_cols:
                conn.execute("ALTER TABLE paper_bot_positions ADD COLUMN buy_reason TEXT;")
        else:
            conn.execute("ALTER TABLE paper_bot_positions ADD COLUMN IF NOT EXISTS buy_reason TEXT;")

        # 8. AI 브리핑 및 뉴스 테이블
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS ai_market_briefings (
                id {id_primary_key},
                provider TEXT NOT NULL DEFAULT 'gemini',
                model TEXT NOT NULL DEFAULT 'gemini-1.5-flash',
                btc_price {real_type},
                btc_daily_20ma {real_type},
                btc_4h_60ma {real_type},
                regime_status TEXT,
                briefing_text TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS crypto_news (
                id {id_primary_key},
                title TEXT NOT NULL,
                link TEXT NOT NULL UNIQUE,
                source TEXT NOT NULL,
                published_at TEXT NOT NULL,
                summary TEXT,
                sentiment TEXT NOT NULL DEFAULT 'NEUTRAL',
                keywords TEXT,
                created_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_crypto_news_pubdate ON crypto_news (published_at DESC);"
        )
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS ai_news_briefings (
                id {id_primary_key},
                provider TEXT NOT NULL DEFAULT 'gemini',
                model TEXT NOT NULL DEFAULT 'gemini-3.5-flash-lite',
                news_count INTEGER NOT NULL DEFAULT 0,
                bullish_count INTEGER NOT NULL DEFAULT 0,
                bearish_count INTEGER NOT NULL DEFAULT 0,
                neutral_count INTEGER NOT NULL DEFAULT 0,
                briefing_text TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )

        # 9. 알고리즘 검증소 (algo_lab_models, algo_lab_positions, algo_lab_trades)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS algo_lab_models (
                model_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                category TEXT NOT NULL,
                description TEXT NOT NULL,
                initial_capital BIGINT NOT NULL DEFAULT 1000000,
                cash_krw BIGINT NOT NULL DEFAULT 1000000,
                eval_assets_krw BIGINT NOT NULL DEFAULT 1000000,
                cumulative_profit_krw BIGINT NOT NULL DEFAULT 0,
                profit_rate_pct NUMERIC(8,2) NOT NULL DEFAULT 0.0,
                win_trades INTEGER NOT NULL DEFAULT 0,
                lose_trades INTEGER NOT NULL DEFAULT 0,
                total_trades INTEGER NOT NULL DEFAULT 0,
                win_rate_pct NUMERIC(6,2) NOT NULL DEFAULT 0.0,
                current_rank INTEGER NOT NULL DEFAULT 1,
                is_active INTEGER NOT NULL DEFAULT 1,
                last_signal_text TEXT NOT NULL DEFAULT '',
                config_json TEXT NOT NULL DEFAULT '{}',
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            """
        )
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS algo_lab_positions (
                id {id_primary_key},
                model_id TEXT NOT NULL,
                market TEXT NOT NULL,
                volume TEXT NOT NULL,
                avg_buy_price {real_type} NOT NULL,
                buy_amount BIGINT NOT NULL,
                buy_fee {real_type} NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'OPEN',
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                closed_at TIMESTAMP
            );
            """
        )
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS algo_lab_trades (
                id {id_primary_key},
                model_id TEXT NOT NULL,
                market TEXT NOT NULL,
                buy_price {real_type} NOT NULL,
                buy_volume TEXT NOT NULL,
                buy_amount BIGINT NOT NULL,
                buy_date TIMESTAMP NOT NULL,
                sell_price {real_type},
                sell_volume TEXT,
                sell_amount BIGINT,
                sell_date TIMESTAMP,
                profit_krw BIGINT,
                profit_pct {real_type},
                reason TEXT,
                status TEXT NOT NULL DEFAULT 'HOLDING'
            );
            """
        )
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id {id_primary_key},
                endpoint TEXT NOT NULL UNIQUE,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                user_agent TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS monthly_asset_snapshots (
                year_month TEXT NOT NULL,
                mode TEXT NOT NULL DEFAULT 'live',
                month_start_balance {real_type} NOT NULL,
                current_balance {real_type} NOT NULL,
                krw_balance {real_type} NOT NULL DEFAULT 0,
                coin_eval_balance {real_type} NOT NULL DEFAULT 0,
                diff_amount {real_type} NOT NULL DEFAULT 0,
                diff_rate {real_type} NOT NULL DEFAULT 0,
                snapshot_date TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (year_month, mode)
            );
            """
        )

        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS historical_candles (
                market TEXT NOT NULL,
                unit TEXT NOT NULL,
                candle_time_kst TEXT NOT NULL,
                open {real_type} NOT NULL,
                high {real_type} NOT NULL,
                low {real_type} NOT NULL,
                close {real_type} NOT NULL,
                volume {real_type} NOT NULL,
                PRIMARY KEY (market, unit, candle_time_kst)
            );
            """
        )
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS backtest_runs (
                id {id_primary_key},
                bot_id TEXT NOT NULL,
                markets_json TEXT NOT NULL,
                unit TEXT NOT NULL DEFAULT '15',
                start_date TEXT,
                end_date TEXT,
                initial_capital BIGINT NOT NULL DEFAULT 1000000,
                final_equity BIGINT NOT NULL DEFAULT 1000000,
                total_return_pct {real_type} NOT NULL DEFAULT 0,
                cagr_pct {real_type} DEFAULT 0,
                mdd_pct {real_type} NOT NULL DEFAULT 0,
                win_rate_pct {real_type} NOT NULL DEFAULT 0,
                profit_factor {real_type} NOT NULL DEFAULT 0,
                sharpe_ratio {real_type} NOT NULL DEFAULT 0,
                sortino_ratio {real_type} DEFAULT 0,
                avg_holding_hours {real_type} DEFAULT 0,
                slippage_bps {real_type} DEFAULT 5,
                trade_count INTEGER NOT NULL DEFAULT 0,
                params_json TEXT,
                walk_forward_json TEXT,
                equity_curve_json TEXT,
                trades_json TEXT,
                created_at TEXT NOT NULL
            );
            """
        )

        # [Antigravity-Doc] 테이블 9-2: auto_rotation_config/history(주간 1위 자동 로테이션), drain_handoff_logs(탈락 봇 자금 인계 이력), capital_restoration_logs(90% 상한 내 원금 복원 감사 로그)
        # 9-2. 주간 전략별 1위 봇 자동 선출 설정 및 이력 테이블
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS auto_rotation_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                is_enabled INTEGER DEFAULT 1,
                rotation_day_of_week INTEGER DEFAULT 1,
                rotation_hour_kst INTEGER DEFAULT 9,
                allocation_mode TEXT DEFAULT 'EQUAL_BY_EQUITY_TIER',
                min_weekly_trades INTEGER DEFAULT 2,
                capital_tier_1_max {real_type} DEFAULT 400000,
                capital_tier_2_max {real_type} DEFAULT 700000,
                max_deploy_ratio {real_type} DEFAULT 0.90,
                last_rotated_at TEXT,
                next_rotation_at TEXT,
                updated_at TEXT
            );
            """
        )
        rot_cfg_alter_cols = [
            ("capital_tier_1_max", f"{real_type} DEFAULT 400000"),
            ("capital_tier_2_max", f"{real_type} DEFAULT 700000"),
            ("max_deploy_ratio", f"{real_type} DEFAULT 0.90"),
        ]
        if sqlite_mode:
            rc_cols = {
                dict(r)["name"]
                for r in conn.execute("PRAGMA table_info(auto_rotation_config);").fetchall()
            }
            for col_name, col_def in rot_cfg_alter_cols:
                if col_name not in rc_cols:
                    conn.execute(f"ALTER TABLE auto_rotation_config ADD COLUMN {col_name} {col_def};")
        else:
            for col_name, col_def in rot_cfg_alter_cols:
                conn.execute(f"ALTER TABLE auto_rotation_config ADD COLUMN IF NOT EXISTS {col_name} {col_def};")
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS auto_rotation_history (
                id {id_primary_key},
                trigger_type TEXT,
                previous_bots_json TEXT,
                elected_bots_json TEXT,
                draining_positions_count INTEGER DEFAULT 0,
                transferred_krw {real_type} DEFAULT 0,
                summary_text TEXT,
                created_at TEXT
            );
            """
        )
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS drain_handoff_logs (
                id {id_primary_key},
                from_bot_id TEXT NOT NULL,
                market TEXT NOT NULL,
                position_id INTEGER DEFAULT 0,
                trade_id INTEGER DEFAULT 0,
                reason TEXT,
                sell_amount {real_type} DEFAULT 0,
                sell_fee {real_type} DEFAULT 0,
                net_proceeds_krw {real_type} DEFAULT 0,
                realized_pnl_krw {real_type} DEFAULT 0,
                allocations_json TEXT,
                remaining_positions_count INTEGER DEFAULT 0,
                created_at TEXT
            );
            """
        )
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS capital_restoration_logs (
                id {id_primary_key},
                source_bot_id TEXT NOT NULL,
                target_bot_id TEXT,
                order_uuid TEXT,
                settled_net_krw {real_type} NOT NULL,
                restored_krw {real_type} NOT NULL,
                surplus_reserve_krw {real_type} DEFAULT 0,
                total_used_after_krw {real_type} NOT NULL,
                global_cap_krw {real_type} NOT NULL,
                total_equity_snapshot_krw {real_type} DEFAULT 0,
                created_at TEXT NOT NULL
            );
            """
        )
        if sqlite_mode:
            crl_cols = {
                dict(r)["name"]
                for r in conn.execute("PRAGMA table_info(capital_restoration_logs);").fetchall()
            }
            if "total_equity_snapshot_krw" not in crl_cols:
                conn.execute(f"ALTER TABLE capital_restoration_logs ADD COLUMN total_equity_snapshot_krw {real_type} DEFAULT 0;")
        else:
            conn.execute(f"ALTER TABLE capital_restoration_logs ADD COLUMN IF NOT EXISTS total_equity_snapshot_krw {real_type} DEFAULT 0;")

        # [Antigravity-Doc] 테이블 9-3: 5중 중복 주문 가드레일 테이블 — live_executor_lease(단일 실행 주체 리스 락), live_order_intents(멱등성 주문 의도 원장), live_guardrail_events(차단/이상행위 감사 로그)
        # 9-3. 실전 중복 주문 원천 차단 5중 가드레일 테이블 (리스 락 · 주문 의도 원장 · 차단 이벤트)
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
            "CREATE INDEX IF NOT EXISTS idx_live_order_intents_bot_mkt_status ON live_order_intents (bot_id, market, side, status);"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_live_order_intents_created ON live_order_intents (bot_id, side, created_at);"
        )
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS live_guardrail_events (
                id {id_primary_key},
                bot_id TEXT NOT NULL,
                market TEXT DEFAULT '',
                side TEXT DEFAULT 'BUY',
                block_code TEXT NOT NULL,
                reason TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_live_guardrail_events_bot_created ON live_guardrail_events (bot_id, created_at);"
        )

        # [Antigravity-Doc] 시드 초기화: Ollama·실전 가드레일 기본 시스템 설정, 주간 로테이션 설정, market_regime_filter(id=1) 레거시 3봇->10봇 자동 마이그레이션, 10대 봇 계좌 시드 삽입
        now_kst = _now_kst_str()
        next_rot = _compute_next_rotation_kst(1, 9)
        ollama_defaults = (
            ("use_local_ollama_news", os.getenv("USE_LOCAL_OLLAMA_NEWS", "true")),
            ("ollama_base_url", os.getenv("OLLAMA_BASE_URL", "http://192.168.0.100:11434")),
            ("ollama_news_model", os.getenv("OLLAMA_NEWS_MODEL", "qwen3-news")),
            ("ollama_timeout_ms", os.getenv("OLLAMA_TIMEOUT_MS", "120000")),
            ("live_executor_owner", os.getenv("LIVE_EXECUTOR_OWNER", "node")),
            ("live_reentry_cooldown_sec", os.getenv("LIVE_REENTRY_COOLDOWN_SEC", "900")),
            ("live_min_buy_interval_sec", os.getenv("LIVE_MIN_BUY_INTERVAL_SEC", "60")),
            ("live_max_buys_per_bot_hour", os.getenv("LIVE_MAX_BUYS_PER_BOT_HOUR", "3")),
            ("live_max_buys_per_bot_day", os.getenv("LIVE_MAX_BUYS_PER_BOT_DAY", "12")),
            ("live_max_total_buys_day", os.getenv("LIVE_MAX_TOTAL_BUYS_DAY", "30")),
            ("guardrail_emergency_halted", "0"),
        )
        for s_key, s_val in ollama_defaults:
            conn.execute(
                "INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?);",
                (s_key, str(s_val), now_kst),
            )
        conn.execute(
            """
            INSERT OR IGNORE INTO auto_rotation_config (
                id, is_enabled, rotation_day_of_week, rotation_hour_kst,
                allocation_mode, min_weekly_trades, last_rotated_at, next_rotation_at, updated_at
            ) VALUES (1, 1, 1, 9, 'RANK_WEIGHTED_40_35_25', 2, NULL, ?, ?);
            """,
            (next_rot, now_kst),
        )

        # 10. market_regime_filter id=1 기본 행 초기화 및 레거시(3봇)->표준(10봇) 안전 마이그레이션
        initial_overrides = DEFAULT_BOT_OVERRIDES_JSON
        conn.execute(
            """
            INSERT OR IGNORE INTO market_regime_filter (
                id, sentiment_score, market_regime, risk_alert, recommended_action,
                position_size_multiplier, bot_overrides_json, blacklist_tickers_json,
                reason, updated_at,
                flash_sentiment_score, flash_recommended_action, flash_updated_at,
                pro_sentiment_score, pro_recommended_action, pro_updated_at,
                final_risk_alert, final_position_multiplier, final_bot_overrides_json
            ) VALUES (
                1, 0.0, 'SIDEWAYS', 0, 'NORMAL', 1.0, ?, '[]', 'Initial default state', CURRENT_TIMESTAMP,
                0.0, 'NORMAL', CURRENT_TIMESTAMP,
                0.0, 'NORMAL', CURRENT_TIMESTAMP,
                0, 1.0, ?
            );
            """,
            (initial_overrides, initial_overrides),
        )

        regime_row = conn.execute(
            "SELECT bot_overrides_json, final_bot_overrides_json FROM market_regime_filter WHERE id = 1;"
        ).fetchone()
        if regime_row is not None:
            regime_dict = dict(regime_row)

            def _needs_override_migration(raw_json: Any) -> bool:
                try:
                    parsed = json.loads(raw_json) if isinstance(raw_json, str) else raw_json
                except Exception:
                    return True
                if not isinstance(parsed, dict):
                    return True
                if any(k in parsed for k in LEGACY_BOT_OVERRIDE_ALIAS):
                    return True
                return any(parsed.get(bot_id) not in ("ALLOW", "BLOCK") for bot_id in ALL_BOT_IDS)

            raw_base = regime_dict.get("bot_overrides_json")
            raw_final = None if newly_added_final_col else regime_dict.get("final_bot_overrides_json")
            if _needs_override_migration(raw_base) or _needs_override_migration(raw_final):
                migrated_base = json.dumps(
                    normalize_bot_overrides(raw_base), ensure_ascii=False, separators=(",", ":")
                )
                migrated_final = json.dumps(
                    normalize_bot_overrides(raw_final if raw_final else migrated_base),
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
                conn.execute(
                    """
                    UPDATE market_regime_filter
                    SET bot_overrides_json = ?, final_bot_overrides_json = ?
                    WHERE id = 1;
                    """,
                    (migrated_base, migrated_final),
                )

        # 11. 10대 알고리즘 봇 기본 계좌 초기화
        initial_bots = [
            ("bot_01", "변동성 돌파봇", 40.0, 1),
            ("bot_02", "슈퍼트렌드+ATR 추세봇", 0.0, 0),
            ("bot_03", "듀얼 모멘텀봇", 40.0, 1),
            ("bot_04", "볼린저 스퀴즈 돌파봇", 0.0, 0),
            ("bot_05", "볼린저 밴드 반등봇", 20.0, 1),
            ("bot_06", "다단계 분할 그리드봇", 0.0, 0),
            ("bot_07", "MACD+RSI 추세봇", 0.0, 0),
            ("bot_08", "정배열 20일선 눌림목봇", 0.0, 0),
            ("bot_09", "거래량 폭발 스캘퍼봇", 0.0, 0),
            ("bot_10", "잭 켈로그 프라이스액션", 0.0, 0),
        ]
        for b_id, b_name, b_ratio, b_live in initial_bots:
            conn.execute(
                """
                INSERT OR IGNORE INTO bot_accounts (
                    bot_id, name, allocation_ratio, allocated_capital, virtual_krw, total_realized_pnl, is_selected_for_live
                ) VALUES (?, ?, ?, 0.0, 0.0, 0.0, ?);
                """,
                (b_id, b_name, b_ratio, b_live),
            )
        conn.execute("UPDATE bot_accounts SET name = '잭 켈로그 프라이스액션' WHERE bot_id = 'bot_10';")

        conn.commit()
        db_mode_str = "SQLite (" + (db_path or DEFAULT_SQLITE_PATH) + ")" if sqlite_mode else "PostgreSQL"
        logger.info(f"{db_mode_str} database tables and seed data initialized successfully.")
    except Exception as exc:
        conn.rollback()
        logger.error("Failed to initialize database: %s", exc)
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    init_database()
