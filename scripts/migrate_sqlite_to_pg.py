#!/usr/bin/env python3
"""
Upbit AutoCoinTrade - SQLite to PostgreSQL 16 Migration Tool
Supports LOCATION mode from .env:
- LOCATION=local : Connects to local PostgreSQL (LOCAL_PG_HOST / 127.0.0.1)
- LOCATION=outer : Connects to remote PostgreSQL (OUTER_PG_HOST)
"""
import os
import sqlite3
import sys
from pathlib import Path

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor, execute_batch
except ImportError:
    print("[ERROR] psycopg2-binary가 설치되어 있지 않습니다. pip install psycopg2-binary 를 실행하세요.")
    sys.exit(1)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SQLITE_DB = PROJECT_ROOT / "data" / "auto_coin_trade.db"
ENV_PATH = PROJECT_ROOT / ".env"

def load_env():
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

load_env()

LOCATION = os.getenv("LOCATION", "local").strip().lower()
IS_OUTER = LOCATION == "outer"

if IS_OUTER:
    PG_HOST = os.getenv("OUTER_PG_HOST", os.getenv("PGHOST", "127.0.0.1"))
    PG_PORT = int(os.getenv("OUTER_PG_PORT", os.getenv("PGPORT", "5432")))
    PG_DATABASE = os.getenv("OUTER_PG_DATABASE", os.getenv("PGDATABASE", "coin_trader"))
    PG_USER = os.getenv("OUTER_PG_USER", os.getenv("PGUSER", "coin_trader"))
    PG_PASSWORD = os.getenv("OUTER_PG_PASSWORD", os.getenv("PGPASSWORD", ""))
else:
    PG_HOST = os.getenv("LOCAL_PG_HOST", os.getenv("PGHOST", "127.0.0.1"))
    PG_PORT = int(os.getenv("LOCAL_PG_PORT", os.getenv("PGPORT", "5432")))
    PG_DATABASE = os.getenv("LOCAL_PG_DATABASE", os.getenv("PGDATABASE", "coin_trader"))
    PG_USER = os.getenv("LOCAL_PG_USER", os.getenv("PGUSER", "coin_trader"))
    PG_PASSWORD = os.getenv("LOCAL_PG_PASSWORD", os.getenv("PGPASSWORD", ""))


def create_pg_schema(pg_cursor):
    """PostgreSQL 테이블 스키마 생성"""
    ddl = """
    CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bots (
        bot_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        nickname TEXT NOT NULL,
        strategy_type TEXT NOT NULL,
        description TEXT NOT NULL,
        allocation_ratio DOUBLE PRECISION NOT NULL DEFAULT 0,
        allocated_capital BIGINT NOT NULL DEFAULT 0,
        virtual_krw BIGINT NOT NULL DEFAULT 0,
        is_running INTEGER NOT NULL DEFAULT 0,
        min_volume_krw BIGINT NOT NULL DEFAULT 0,
        stop_loss_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
        take_profit_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
        config_json TEXT NOT NULL DEFAULT '{}',
        last_status_msg TEXT NOT NULL DEFAULT '대기 중',
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trades (
        id BIGSERIAL PRIMARY KEY,
        bot_id TEXT NOT NULL,
        market TEXT NOT NULL,
        buy_order_uuid TEXT NOT NULL,
        sell_order_uuid TEXT,
        buy_price DOUBLE PRECISION NOT NULL,
        buy_volume TEXT NOT NULL,
        buy_amount BIGINT NOT NULL,
        buy_date TEXT NOT NULL,
        sell_price DOUBLE PRECISION,
        sell_volume TEXT,
        sell_amount BIGINT,
        sell_date TEXT,
        profit_krw BIGINT,
        profit_pct DOUBLE PRECISION,
        status TEXT NOT NULL DEFAULT 'HOLDING'
    );

    CREATE TABLE IF NOT EXISTS bot_positions (
        id BIGSERIAL PRIMARY KEY,
        bot_id TEXT NOT NULL,
        market TEXT NOT NULL,
        order_uuid TEXT NOT NULL UNIQUE,
        volume TEXT NOT NULL,
        avg_buy_price DOUBLE PRECISION NOT NULL,
        buy_amount BIGINT NOT NULL,
        buy_fee DOUBLE PRECISION NOT NULL DEFAULT 0,
        trade_id BIGINT NOT NULL,
        status TEXT NOT NULL DEFAULT 'OPEN',
        created_at TEXT NOT NULL,
        closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS ai_market_briefings (
        id BIGSERIAL PRIMARY KEY,
        provider TEXT NOT NULL DEFAULT 'gemini',
        model TEXT NOT NULL DEFAULT 'gemini-1.5-flash',
        btc_price DOUBLE PRECISION,
        btc_daily_20ma DOUBLE PRECISION,
        btc_4h_60ma DOUBLE PRECISION,
        regime_status TEXT,
        briefing_text TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    """
    pg_cursor.execute(ddl)


def migrate():
    print("=" * 60)
    print(f"[SQLite -> PostgreSQL 16 마이그레이션 (LOCATION={LOCATION.upper()})]")
    print("=" * 60)

    if not SQLITE_DB.exists():
        print(f"[WARN] SQLite DB 파일({SQLITE_DB})이 없습니다. 빈 스키마만 PostgreSQL에 생성합니다.")
        sqlite_conn = None
    else:
        print(f"[1/4] SQLite 데이터베이스 연결: {SQLITE_DB}")
        sqlite_conn = sqlite3.connect(str(SQLITE_DB))
        sqlite_conn.row_factory = sqlite3.Row

    print(f"[2/4] PostgreSQL 16 연결 시도: {PG_USER}@{PG_HOST}:{PG_PORT}/{PG_DATABASE}")
    try:
        pg_conn = psycopg2.connect(
            host=PG_HOST,
            port=PG_PORT,
            dbname=PG_DATABASE,
            user=PG_USER,
            password=PG_PASSWORD,
        )
        pg_conn.autocommit = False
    except Exception as e:
        print(f"\n[ERROR] PostgreSQL 연결 실패 ({PG_HOST}:{PG_PORT}): {e}")
        sys.exit(1)

    with pg_conn.cursor() as cur:
        print("[3/4] PostgreSQL 스키마 확인 및 테이블 생성...")
        create_pg_schema(cur)

        if sqlite_conn:
            print("[4/4] SQLite 데이터 추출 및 PostgreSQL 이관...")

            # 1) system_settings
            try:
                rows = sqlite_conn.execute("SELECT * FROM system_settings").fetchall()
                if rows:
                    query = """
                    INSERT INTO system_settings (key, value, updated_at)
                    VALUES (%(key)s, %(value)s, %(updated_at)s)
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
                    """
                    execute_batch(cur, query, [dict(r) for r in rows])
                    print(f"  • system_settings: {len(rows)}건 이관 완료")
            except Exception as e:
                print(f"  • system_settings 스킵 또는 오류: {e}")

            # 2) bots
            try:
                rows = sqlite_conn.execute("SELECT * FROM bots").fetchall()
                if rows:
                    query = """
                    INSERT INTO bots (
                        bot_id, name, nickname, strategy_type, description,
                        allocation_ratio, allocated_capital, virtual_krw, is_running,
                        min_volume_krw, stop_loss_pct, take_profit_pct, config_json,
                        last_status_msg, updated_at
                    ) VALUES (
                        %(bot_id)s, %(name)s, %(nickname)s, %(strategy_type)s, %(description)s,
                        %(allocation_ratio)s, %(allocated_capital)s, %(virtual_krw)s, %(is_running)s,
                        %(min_volume_krw)s, %(stop_loss_pct)s, %(take_profit_pct)s, %(config_json)s,
                        %(last_status_msg)s, %(updated_at)s
                    ) ON CONFLICT (bot_id) DO UPDATE SET
                        nickname = EXCLUDED.nickname,
                        allocation_ratio = EXCLUDED.allocation_ratio,
                        allocated_capital = EXCLUDED.allocated_capital,
                        virtual_krw = EXCLUDED.virtual_krw,
                        is_running = EXCLUDED.is_running,
                        min_volume_krw = EXCLUDED.min_volume_krw,
                        stop_loss_pct = EXCLUDED.stop_loss_pct,
                        take_profit_pct = EXCLUDED.take_profit_pct,
                        config_json = EXCLUDED.config_json,
                        last_status_msg = EXCLUDED.last_status_msg,
                        updated_at = EXCLUDED.updated_at
                    """
                    execute_batch(cur, query, [dict(r) for r in rows])
                    print(f"  • bots: {len(rows)}건 이관 완료")
            except Exception as e:
                print(f"  • bots 스킵 또는 오류: {e}")

            # 3) trades
            try:
                rows = sqlite_conn.execute("SELECT * FROM trades").fetchall()
                if rows:
                    query = """
                    INSERT INTO trades (
                        id, bot_id, market, buy_order_uuid, sell_order_uuid,
                        buy_price, buy_volume, buy_amount, buy_date,
                        sell_price, sell_volume, sell_amount, sell_date,
                        profit_krw, profit_pct, status
                    ) VALUES (
                        %(id)s, %(bot_id)s, %(market)s, %(buy_order_uuid)s, %(sell_order_uuid)s,
                        %(buy_price)s, %(buy_volume)s, %(buy_amount)s, %(buy_date)s,
                        %(sell_price)s, %(sell_volume)s, %(sell_amount)s, %(sell_date)s,
                        %(profit_krw)s, %(profit_pct)s, %(status)s
                    ) ON CONFLICT (id) DO UPDATE SET
                        sell_order_uuid = EXCLUDED.sell_order_uuid,
                        sell_price = EXCLUDED.sell_price,
                        sell_volume = EXCLUDED.sell_volume,
                        sell_amount = EXCLUDED.sell_amount,
                        sell_date = EXCLUDED.sell_date,
                        profit_krw = EXCLUDED.profit_krw,
                        profit_pct = EXCLUDED.profit_pct,
                        status = EXCLUDED.status
                    """
                    execute_batch(cur, query, [dict(r) for r in rows])
                    cur.execute("SELECT setval(pg_get_serial_sequence('trades', 'id'), COALESCE((SELECT MAX(id) FROM trades), 1))")
                    print(f"  • trades: {len(rows)}건 이관 완료")
            except Exception as e:
                print(f"  • trades 스킵 또는 오류: {e}")

            # 4) bot_positions
            try:
                rows = sqlite_conn.execute("SELECT * FROM bot_positions").fetchall()
                if rows:
                    seen_uuids = set()
                    sanitized_rows = []
                    for r in rows:
                        d = dict(r)
                        u = str(d.get("order_uuid") or "").strip()
                        if not u:
                            u = f"migrated-pos-{d.get('id', 0)}"
                        if u in seen_uuids:
                            u = f"{u}-dup-{d.get('id', 0)}"
                        seen_uuids.add(u)
                        d["order_uuid"] = u
                        sanitized_rows.append(d)

                    query = """
                    INSERT INTO bot_positions (
                        id, bot_id, market, order_uuid, volume,
                        avg_buy_price, buy_amount, buy_fee, trade_id,
                        status, created_at, closed_at
                    ) VALUES (
                        %(id)s, %(bot_id)s, %(market)s, %(order_uuid)s, %(volume)s,
                        %(avg_buy_price)s, %(buy_amount)s, %(buy_fee)s, %(trade_id)s,
                        %(status)s, %(created_at)s, %(closed_at)s
                    ) ON CONFLICT (order_uuid) DO UPDATE SET
                        status = EXCLUDED.status,
                        closed_at = EXCLUDED.closed_at,
                        volume = EXCLUDED.volume,
                        avg_buy_price = EXCLUDED.avg_buy_price
                    """
                    execute_batch(cur, query, sanitized_rows)
                    cur.execute("SELECT setval(pg_get_serial_sequence('bot_positions', 'id'), COALESCE((SELECT MAX(id) FROM bot_positions), 1))")
                    print(f"  • bot_positions: {len(rows)}건 이관 완료")
            except Exception as e:
                print(f"  • bot_positions 스킵 또는 오류: {e}")

            # 5) ai_market_briefings
            try:
                rows = sqlite_conn.execute("SELECT * FROM ai_market_briefings").fetchall()
                if rows:
                    query = """
                    INSERT INTO ai_market_briefings (
                        id, provider, model, btc_price, btc_daily_20ma, btc_4h_60ma,
                        regime_status, briefing_text, created_at
                    ) VALUES (
                        %(id)s, %(provider)s, %(model)s, %(btc_price)s, %(btc_daily_20ma)s, %(btc_4h_60ma)s,
                        %(regime_status)s, %(briefing_text)s, %(created_at)s
                    ) ON CONFLICT (id) DO NOTHING
                    """
                    execute_batch(cur, query, [dict(r) for r in rows])
                    cur.execute("SELECT setval(pg_get_serial_sequence('ai_market_briefings', 'id'), COALESCE((SELECT MAX(id) FROM ai_market_briefings), 1))")
                    print(f"  • ai_market_briefings: {len(rows)}건 이관 완료")
            except Exception as e:
                print(f"  • ai_market_briefings 스킵 또는 오류: {e}")

        pg_conn.commit()

    if sqlite_conn:
        sqlite_conn.close()
    pg_conn.close()

    print("=" * 60)
    print(f"[SUCCESS] PostgreSQL 16 ({LOCATION.upper()}) 마이그레이션이 완료되었습니다!")
    print("=" * 60)


if __name__ == "__main__":
    migrate()
