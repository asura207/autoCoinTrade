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

PROJECT_ROOT = Path(__file__).resolve().parent
ENV_PATH = PROJECT_ROOT / ".env"
DATA_DIR = PROJECT_ROOT / "data"
DEFAULT_SQLITE_PATH = str(DATA_DIR / "auto_coin_trade.db")
DEFAULT_DB_PATH = DEFAULT_SQLITE_PATH

ALL_BOT_IDS = tuple(f"bot_{i:02d}" for i in range(1, 11))
DEFAULT_BOT_OVERRIDES: Dict[str, str] = {bot_id: "ALLOW" for bot_id in ALL_BOT_IDS}
DEFAULT_BOT_OVERRIDES_JSON = json.dumps(DEFAULT_BOT_OVERRIDES, ensure_ascii=False, separators=(",", ":"))
LEGACY_BOT_OVERRIDE_ALIAS = {
    "bot_vb": "bot_01",
    "bot_momentum": "bot_03",
    "bot_bb": "bot_05",
}
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
KST_TZ = timezone(timedelta(hours=9))


def _now_kst_str() -> str:
    return datetime.now(KST_TZ).strftime("%Y-%m-%d %H:%M:%S")


def _compute_next_rotation_kst(day_of_week: int = 1, hour_kst: int = 9) -> str:
    """0=일, 1=월 ... 6=토 기준 다음 주간 로테이션 예정 KST 시각 문자열 반환"""
    now = datetime.now(KST_TZ).replace(minute=0, second=0, microsecond=0)
    cur_dow = (now.weekday() + 1) % 7
    delta_days = (int(day_of_week) - cur_dow) % 7
    candidate = (now + timedelta(days=delta_days)).replace(hour=int(hour_kst), minute=0, second=0, microsecond=0)
    if candidate <= datetime.now(KST_TZ):
        candidate += timedelta(days=7)
    return candidate.strftime("%Y-%m-%d %H:%M:%S")


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

def is_sqlite_mode() -> bool:
    """
    현재 설정이 SQLite 모드인지 확인합니다.
    - DB_MODE=sqlite
    - PG_SYNC_ENABLED=false
    - 또는 미설정 시 기본적으로 SQLite를 우선 지원
    """
    _load_env()
    mode = os.getenv("DB_MODE", "").strip().lower()
    sync_enabled = os.getenv("PG_SYNC_ENABLED", "").strip().lower()

    if mode == "sqlite" or sync_enabled == "false":
        return True
    if mode in ("postgres_hybrid", "postgres", "postgresql", "server"):
        return False

    # 미설정 상태일 경우 PostgreSQL 연결 정보 유무 확인
    pg_host = os.getenv("PGHOST") or os.getenv("LOCAL_PG_HOST")
    if pg_host and HAS_PSYCOPG2:
        return False
    return True


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


class SqliteConnectionWrapper:
    """
    SQLite3 커넥션 래퍼 (Row 객체 및 호환 인터페이스)
    """
    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn
        self.conn.row_factory = sqlite3.Row

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


class PgConnectionWrapper:
    """
    SQLite 호환 인터페이스를 제공하는 PostgreSQL 커넥션 래퍼
    """
    def __init__(self, pg_conn):
        self.conn = pg_conn

    def _convert_sql(self, sql: str) -> str:
        s = sql.strip()
        if re.match(r"^PRAGMA\s+", s, re.I):
            return "SELECT 1;"
        if "BEGIN IMMEDIATE" in s.upper():
            return "SELECT 1;"

        # AUTOINCREMENT -> BIGSERIAL PRIMARY KEY
        s = re.sub(r"INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT", "BIGSERIAL PRIMARY KEY", s, flags=re.I)

        # INSERT OR IGNORE INTO
        m = re.search(r"INSERT\s+OR\s+IGNORE\s+INTO\s+([a-zA-Z0-9_]+)", s, re.I)
        if m:
            tbl = m.group(1).lower()
            s = re.sub(r"INSERT\s+OR\s+IGNORE\s+INTO", "INSERT INTO", s, flags=re.I)
            if "ON CONFLICT" not in s.upper():
                if tbl == "market_regime_filter":
                    s += " ON CONFLICT (id) DO NOTHING"
                elif tbl == "auto_rotation_config":
                    s += " ON CONFLICT (id) DO NOTHING"
                elif tbl == "bot_accounts":
                    s += " ON CONFLICT (bot_id) DO NOTHING"
                elif tbl == "bot_positions":
                    s += " ON CONFLICT (order_uuid) DO NOTHING"
                elif tbl == "system_settings":
                    s += " ON CONFLICT (key) DO NOTHING"
                else:
                    s += " ON CONFLICT DO NOTHING"

        # INSERT OR REPLACE INTO system_settings
        if re.search(r"INSERT\s+OR\s+REPLACE\s+INTO\s+system_settings", s, re.I):
            s = re.sub(r"INSERT\s+OR\s+REPLACE\s+INTO\s+system_settings", "INSERT INTO system_settings", s, flags=re.I)
            if "ON CONFLICT" not in s.upper():
                s += " ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at"

        # ? -> %s
        s = s.replace("?", "%s")
        return s

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


def get_db_connection(db_path: Optional[str] = None):
    """
    설정에 따라 SQLite 또는 PostgreSQL 커넥션을 생성하여 반환합니다.
    """
    _load_env()
    if is_sqlite_mode():
        target_path = db_path or os.getenv("DB_PATH") or DEFAULT_SQLITE_PATH
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(target_path, timeout=5.0)
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA busy_timeout = 5000;")
        conn.execute("PRAGMA synchronous = NORMAL;")
        return SqliteConnectionWrapper(conn)

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
                pnl_pct {real_type}
            );
            """
        )
        pos_alter_cols = [
            ("sell_order_uuid", "TEXT"),
            ("sell_price", real_type),
            ("sell_amount", real_type),
            ("sell_fee", real_type),
            ("realized_pnl", real_type),
            ("pnl_pct", real_type),
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
                description TEXT NOT NULL,
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
        if sqlite_mode:
            bot_cols = {
                dict(r)["name"]
                for r in conn.execute("PRAGMA table_info(bots);").fetchall()
            }
            if "strategy_group" not in bot_cols:
                conn.execute("ALTER TABLE bots ADD COLUMN strategy_group TEXT DEFAULT 'TREND_SWING';")
        else:
            conn.execute("ALTER TABLE bots ADD COLUMN IF NOT EXISTS strategy_group TEXT DEFAULT 'TREND_SWING';")

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
                status TEXT NOT NULL DEFAULT 'HOLDING'
            );
            """
        )

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
                closed_at TEXT
            );
            """
        )

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
            """
            CREATE TABLE IF NOT EXISTS monthly_asset_snapshots (
                year_month TEXT NOT NULL,
                mode TEXT NOT NULL DEFAULT 'live',
                month_start_balance REAL NOT NULL,
                current_balance REAL NOT NULL,
                krw_balance REAL NOT NULL DEFAULT 0,
                coin_eval_balance REAL NOT NULL DEFAULT 0,
                diff_amount REAL NOT NULL DEFAULT 0,
                diff_rate REAL NOT NULL DEFAULT 0,
                snapshot_date TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (year_month, mode)
            );
            """
        )

        # 9-2. 주간 전략별 1위 봇 자동 선출 설정 및 이력 테이블
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS auto_rotation_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                is_enabled INTEGER DEFAULT 1,
                rotation_day_of_week INTEGER DEFAULT 1,
                rotation_hour_kst INTEGER DEFAULT 9,
                allocation_mode TEXT DEFAULT 'RANK_WEIGHTED_40_35_25',
                min_weekly_trades INTEGER DEFAULT 2,
                last_rotated_at TEXT,
                next_rotation_at TEXT,
                updated_at TEXT
            );
            """
        )
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
        now_kst = _now_kst_str()
        next_rot = _compute_next_rotation_kst(1, 9)
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
            ("bot_02", "추세 추종봇", 0.0, 0),
            ("bot_03", "듀얼 모멘텀봇", 40.0, 1),
            ("bot_04", "RSI 역추세봇", 0.0, 0),
            ("bot_05", "볼린저 밴드 반등봇", 20.0, 1),
            ("bot_06", "MACD 오실레이터봇", 0.0, 0),
            ("bot_07", "돌파-눌림목 매매봇", 0.0, 0),
            ("bot_08", "거래량 급증 추종봇", 0.0, 0),
            ("bot_09", "단기 스캘핑봇", 0.0, 0),
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
