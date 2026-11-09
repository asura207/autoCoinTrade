"""
init_db.py - PostgreSQL 데이터베이스 스키마 정의 및 커넥션 모듈 (SQLite 완전 대체)
- PostgreSQL (coin_trader) 연결
- 봇 가상 원장 테이블 (bot_accounts, bot_positions)
- LLM 시장 체제 & 감성 필터 상태 테이블 (market_regime_filter, id=1 단일 행)
"""

import json
import logging
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
except ImportError:
    raise ImportError("psycopg2-binary가 설치되어 있어야 합니다.")

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("init_db")

PROJECT_ROOT = Path(__file__).resolve().parent
ENV_PATH = PROJECT_ROOT / ".env"

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

DEFAULT_DB_PATH = "postgresql"


class PgCursorWrapper:
    def __init__(self, cur):
        self.cur = cur

    def fetchone(self):
        return self.cur.fetchone()

    def fetchall(self):
        return self.cur.fetchall()

    @property
    def rowcount(self):
        return self.cur.rowcount


class PgConnectionWrapper:
    """
    SQLite 호환 인터페이스를 제공하는 PostgreSQL 커넥션 래퍼
    - conn.execute(sql, params)
    - ? -> %s 자동 변환
    - PRAGMA, BEGIN IMMEDIATE 자동 처리
    - RealDictCursor 기반 딕셔너리 접근 (row['ticker'] 등)
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

    def execute(self, sql: str, params: Optional[Any] = None) -> PgCursorWrapper:
        final_sql = self._convert_sql(sql)
        cur = self.conn.cursor(cursor_factory=RealDictCursor)
        if params is not None:
            cur.execute(final_sql, params)
        else:
            cur.execute(final_sql)
        return PgCursorWrapper(cur)

    def commit(self) -> None:
        self.conn.commit()

    def rollback(self) -> None:
        self.conn.rollback()

    def close(self) -> None:
        self.conn.close()


def get_db_connection(db_path: Optional[str] = None) -> PgConnectionWrapper:
    """
    PostgreSQL 커넥션을 생성하여 반환합니다.
    """
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
    PostgreSQL 전체 테이블 스키마를 초기화하고 기본 데이터를 시딩합니다.
    """
    conn = get_db_connection(db_path)
    try:
        # 1. 봇 가상 원장 계좌 테이블 (bot_accounts)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS bot_accounts (
                bot_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                allocation_ratio DOUBLE PRECISION NOT NULL,
                allocated_capital DOUBLE PRECISION NOT NULL DEFAULT 0.0,
                virtual_krw DOUBLE PRECISION NOT NULL DEFAULT 0.0,
                total_realized_pnl DOUBLE PRECISION NOT NULL DEFAULT 0.0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_selected_for_live INTEGER NOT NULL DEFAULT 0
            );
            """
        )

        # 2. 봇별 독립 포지션 테이블 (bot_positions)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS bot_positions (
                id BIGSERIAL PRIMARY KEY,
                bot_id TEXT NOT NULL,
                market TEXT NOT NULL,
                order_uuid TEXT NOT NULL UNIQUE,
                volume TEXT NOT NULL,
                avg_buy_price DOUBLE PRECISION NOT NULL,
                buy_amount BIGINT NOT NULL,
                buy_fee DOUBLE PRECISION NOT NULL DEFAULT 0.0,
                trade_id BIGINT NOT NULL,
                highest_price DOUBLE PRECISION DEFAULT 0.0,
                status TEXT NOT NULL DEFAULT 'OPEN',
                created_at TEXT NOT NULL,
                closed_at TEXT
            );
            """
        )

        # 3. LLM 시장 체제 & 뉴스 감성 필터 테이블 (market_regime_filter - Single-row id=1)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS market_regime_filter (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                sentiment_score DOUBLE PRECISION DEFAULT 0.0,
                market_regime TEXT DEFAULT 'SIDEWAYS',
                risk_alert INTEGER DEFAULT 0,
                recommended_action TEXT DEFAULT 'NORMAL',
                position_size_multiplier DOUBLE PRECISION DEFAULT 1.0,
                bot_overrides_json TEXT DEFAULT '{"bot_vb":"ALLOW","bot_momentum":"ALLOW","bot_bb":"ALLOW"}',
                blacklist_tickers_json TEXT DEFAULT '[]',
                reason TEXT DEFAULT 'Initial default state',
                updated_at TEXT NOT NULL
            );
            """
        )

        # 4. market_regime_filter id=1 기본 행 초기화
        initial_overrides = json.dumps(
            {"bot_vb": "ALLOW", "bot_momentum": "ALLOW", "bot_bb": "ALLOW"},
            ensure_ascii=False,
        )
        conn.execute(
            """
            INSERT INTO market_regime_filter (
                id, sentiment_score, market_regime, risk_alert, recommended_action,
                position_size_multiplier, bot_overrides_json, blacklist_tickers_json,
                reason, updated_at
            ) VALUES (
                1, 0.0, 'SIDEWAYS', 0, 'NORMAL', 1.0, %s, '[]', 'Initial default state', CURRENT_TIMESTAMP
            ) ON CONFLICT (id) DO NOTHING;
            """,
            (initial_overrides,),
        )

        conn.commit()
        logger.info("PostgreSQL database tables and seed data initialized successfully.")
    except Exception as exc:
        conn.rollback()
        logger.error("Failed to initialize PostgreSQL database: %s", exc)
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    init_database()
