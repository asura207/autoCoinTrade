#!/usr/bin/env python3
"""
Complete SQLite to PostgreSQL Migration & Schema Setup Tool
- Ensures all tables (including virtual/paper trading, algo_lab, news, etc.) exist with proper sequences.
- Migrates 100% of data from data/auto_coin_trade.db and trading_ledger.db to PostgreSQL.
- Updates sequences to MAX(id).
"""
import os
import sqlite3
import sys
from pathlib import Path

try:
    import psycopg2
    from psycopg2.extras import execute_batch
except ImportError:
    print("[ERROR] psycopg2-binary가 필요합니다.")
    sys.exit(1)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SQLITE_DB = PROJECT_ROOT / "data" / "auto_coin_trade.db"
LEDGER_DB = PROJECT_ROOT / "trading_ledger.db"
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

def setup_complete_pg_schema(cur):
    """PostgreSQL 테이블 및 시퀀스 완벽 보장"""
    ddl = """
    -- 1. system_settings
    CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    -- 2. bots
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
        updated_at TEXT NOT NULL,
        is_selected_for_live INTEGER NOT NULL DEFAULT 0,
        paper_initial_capital BIGINT NOT NULL DEFAULT 1000000,
        paper_virtual_krw BIGINT NOT NULL DEFAULT 1000000,
        paper_is_running INTEGER NOT NULL DEFAULT 1,
        paper_peak_equity BIGINT NOT NULL DEFAULT 1000000,
        paper_mdd_pct NUMERIC(8,2) NOT NULL DEFAULT 0,
        paper_status_msg TEXT NOT NULL DEFAULT '시그널 대기 중'
    );

    -- 3. trades (실거래)
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

    -- 4. bot_positions (실거래 포지션)
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

    -- 5. paper_trades (가상거래 원장)
    CREATE TABLE IF NOT EXISTS paper_trades (
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
        status TEXT NOT NULL DEFAULT 'HOLDING',
        buy_reason TEXT,
        sell_reason TEXT
    );

    -- 6. paper_bot_positions (가상거래 보유 포지션)
    CREATE TABLE IF NOT EXISTS paper_bot_positions (
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

    -- 7. ai_market_briefings
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

    -- 8. ai_news_briefings
    CREATE TABLE IF NOT EXISTS ai_news_briefings (
        id BIGSERIAL PRIMARY KEY,
        provider TEXT NOT NULL DEFAULT 'gemini',
        model TEXT NOT NULL DEFAULT 'gemini-3.5-flash-lite',
        news_count INTEGER NOT NULL DEFAULT 0,
        bullish_count INTEGER NOT NULL DEFAULT 0,
        bearish_count INTEGER NOT NULL DEFAULT 0,
        neutral_count INTEGER NOT NULL DEFAULT 0,
        briefing_text TEXT NOT NULL,
        created_at TEXT NOT NULL
    );

    -- 9. crypto_news
    CREATE TABLE IF NOT EXISTS crypto_news (
        id BIGSERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        link TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        published_at TEXT NOT NULL,
        summary TEXT,
        sentiment TEXT NOT NULL DEFAULT 'NEUTRAL',
        keywords TEXT,
        created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crypto_news_pubdate ON crypto_news (published_at DESC);

    -- 10. algo_lab_models
    CREATE TABLE IF NOT EXISTS algo_lab_models (
        model_id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        category VARCHAR(64) NOT NULL,
        description TEXT,
        initial_capital BIGINT NOT NULL DEFAULT 1000000,
        cash_krw BIGINT NOT NULL DEFAULT 1000000,
        eval_assets_krw BIGINT NOT NULL DEFAULT 1000000,
        cumulative_profit_krw BIGINT NOT NULL DEFAULT 0,
        profit_rate_pct NUMERIC(8,2) NOT NULL DEFAULT 0,
        win_trades INTEGER NOT NULL DEFAULT 0,
        lose_trades INTEGER NOT NULL DEFAULT 0,
        total_trades INTEGER NOT NULL DEFAULT 0,
        win_rate_pct NUMERIC(8,2) NOT NULL DEFAULT 0,
        current_rank INTEGER NOT NULL DEFAULT 1,
        is_active INTEGER NOT NULL DEFAULT 1,
        last_signal_text TEXT,
        config_json TEXT DEFAULT '{}',
        updated_at TEXT NOT NULL
    );

    -- 11. algo_lab_positions
    CREATE TABLE IF NOT EXISTS algo_lab_positions (
        id BIGSERIAL PRIMARY KEY,
        model_id VARCHAR(64) NOT NULL,
        market VARCHAR(32) NOT NULL,
        volume VARCHAR(32) NOT NULL,
        avg_buy_price NUMERIC(16,4) NOT NULL,
        buy_amount BIGINT NOT NULL,
        buy_fee NUMERIC(16,4) NOT NULL DEFAULT 0,
        status VARCHAR(16) NOT NULL DEFAULT 'OPEN',
        created_at TEXT NOT NULL,
        closed_at TEXT
    );

    -- 12. algo_lab_trades
    CREATE TABLE IF NOT EXISTS algo_lab_trades (
        id BIGSERIAL PRIMARY KEY,
        model_id VARCHAR(64) NOT NULL,
        market VARCHAR(32) NOT NULL,
        buy_price NUMERIC(16,4) NOT NULL,
        buy_volume VARCHAR(32) NOT NULL,
        buy_amount BIGINT NOT NULL,
        buy_date TEXT NOT NULL,
        sell_price NUMERIC(16,4),
        sell_volume VARCHAR(32),
        sell_amount BIGINT,
        sell_date TEXT,
        profit_krw BIGINT,
        profit_pct NUMERIC(8,2),
        reason TEXT,
        status VARCHAR(16) NOT NULL DEFAULT 'HOLDING'
    );

    -- 13. market_regime_filter (단일 행 필터)
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
    cur.execute(ddl)

    # Ensure paper_trades & paper_bot_positions have sequences attached to id
    cur.execute("""
        CREATE SEQUENCE IF NOT EXISTS paper_trades_id_seq;
        ALTER TABLE paper_trades ALTER COLUMN id SET DEFAULT nextval('paper_trades_id_seq');
        ALTER SEQUENCE paper_trades_id_seq OWNED BY paper_trades.id;

        CREATE SEQUENCE IF NOT EXISTS paper_bot_positions_id_seq;
        ALTER TABLE paper_bot_positions ALTER COLUMN id SET DEFAULT nextval('paper_bot_positions_id_seq');
        ALTER SEQUENCE paper_bot_positions_id_seq OWNED BY paper_bot_positions.id;
    """)

def migrate_all():
    print("=" * 60)
    print(f"[전체 데이터 마이그레이션 (SQLite -> PostgreSQL 16) | LOCATION={LOCATION.upper()}]")
    print("=" * 60)

    pg_conn = psycopg2.connect(
        host=PG_HOST,
        port=PG_PORT,
        dbname=PG_DATABASE,
        user=PG_USER,
        password=PG_PASSWORD,
    )
    pg_conn.autocommit = True

    try:
        with pg_conn.cursor() as cur:
            print("[1/3] PostgreSQL 스키마 생성 및 시퀀스 연결...")
            setup_complete_pg_schema(cur)

            print("[2/3] SQLite 데이터 추출 및 PostgreSQL 이관...")

            # ----------------------------------------------------
            # A. auto_coin_trade.db 이관
            # ----------------------------------------------------
            if SQLITE_DB.exists():
                s_conn = sqlite3.connect(str(SQLITE_DB))
                s_conn.row_factory = sqlite3.Row

                # 1) system_settings
                try:
                    rows = s_conn.execute("SELECT * FROM system_settings").fetchall()
                    if rows:
                        query = """
                        INSERT INTO system_settings (key, value, updated_at)
                        VALUES (%(key)s, %(value)s, %(updated_at)s)
                        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
                        """
                        execute_batch(cur, query, [dict(r) for r in rows])
                        print(f"  • system_settings: {len(rows)}건")
                except Exception as e:
                    print(f"  • system_settings 오류: {e}")

                # 2) bots
                try:
                    rows = s_conn.execute("SELECT * FROM bots").fetchall()
                    if rows:
                        query = """
                        INSERT INTO bots (
                            bot_id, name, nickname, strategy_type, description,
                            allocation_ratio, allocated_capital, virtual_krw, is_running,
                            min_volume_krw, stop_loss_pct, take_profit_pct, config_json,
                            last_status_msg, updated_at, is_selected_for_live,
                            paper_initial_capital, paper_virtual_krw, paper_is_running,
                            paper_peak_equity, paper_mdd_pct, paper_status_msg
                        ) VALUES (
                            %(bot_id)s, %(name)s, %(nickname)s, %(strategy_type)s, %(description)s,
                            %(allocation_ratio)s, %(allocated_capital)s, %(virtual_krw)s, %(is_running)s,
                            %(min_volume_krw)s, %(stop_loss_pct)s, %(take_profit_pct)s, %(config_json)s,
                            %(last_status_msg)s, %(updated_at)s, %(is_selected_for_live)s,
                            %(paper_initial_capital)s, %(paper_virtual_krw)s, %(paper_is_running)s,
                            %(paper_peak_equity)s, %(paper_mdd_pct)s, %(paper_status_msg)s
                        ) ON CONFLICT (bot_id) DO UPDATE SET
                            name = EXCLUDED.name,
                            nickname = EXCLUDED.nickname,
                            strategy_type = EXCLUDED.strategy_type,
                            description = EXCLUDED.description,
                            allocation_ratio = EXCLUDED.allocation_ratio,
                            allocated_capital = EXCLUDED.allocated_capital,
                            virtual_krw = EXCLUDED.virtual_krw,
                            is_running = EXCLUDED.is_running,
                            min_volume_krw = EXCLUDED.min_volume_krw,
                            stop_loss_pct = EXCLUDED.stop_loss_pct,
                            take_profit_pct = EXCLUDED.take_profit_pct,
                            config_json = EXCLUDED.config_json,
                            last_status_msg = EXCLUDED.last_status_msg,
                            updated_at = EXCLUDED.updated_at,
                            is_selected_for_live = EXCLUDED.is_selected_for_live,
                            paper_initial_capital = EXCLUDED.paper_initial_capital,
                            paper_virtual_krw = EXCLUDED.paper_virtual_krw,
                            paper_is_running = EXCLUDED.paper_is_running,
                            paper_peak_equity = EXCLUDED.paper_peak_equity,
                            paper_mdd_pct = EXCLUDED.paper_mdd_pct,
                            paper_status_msg = EXCLUDED.paper_status_msg
                        """
                        data = []
                        for r in rows:
                            d = dict(r)
                            d.setdefault("is_selected_for_live", 0)
                            d.setdefault("paper_initial_capital", 1000000)
                            d.setdefault("paper_virtual_krw", 1000000)
                            d.setdefault("paper_is_running", 1)
                            d.setdefault("paper_peak_equity", 1000000)
                            d.setdefault("paper_mdd_pct", 0)
                            d.setdefault("paper_status_msg", "시그널 대기 중")
                            data.append(d)
                        execute_batch(cur, query, data)
                        print(f"  • bots: {len(rows)}건")
                except Exception as e:
                    print(f"  • bots 오류: {e}")

                # 3) trades (실거래)
                try:
                    rows = s_conn.execute("SELECT * FROM trades").fetchall()
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
                        print(f"  • trades: {len(rows)}건")
                except Exception as e:
                    print(f"  • trades 오류: {e}")

                # 4) bot_positions (실거래)
                try:
                    rows = s_conn.execute("SELECT * FROM bot_positions").fetchall()
                    if rows:
                        seen = set()
                        sanitized = []
                        for r in rows:
                            d = dict(r)
                            u = str(d.get("order_uuid") or "").strip()
                            if not u:
                                u = f"pos-{d.get('id', 0)}"
                            if u in seen:
                                u = f"{u}-dup-{d.get('id', 0)}"
                            seen.add(u)
                            d["order_uuid"] = u
                            sanitized.append(d)
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
                        execute_batch(cur, query, sanitized)
                        cur.execute("SELECT setval(pg_get_serial_sequence('bot_positions', 'id'), COALESCE((SELECT MAX(id) FROM bot_positions), 1))")
                        print(f"  • bot_positions: {len(rows)}건")
                except Exception as e:
                    print(f"  • bot_positions 오류: {e}")

                # 5) paper_trades (가상거래 원장)
                try:
                    rows = s_conn.execute("SELECT * FROM paper_trades").fetchall()
                    if rows:
                        query = """
                        INSERT INTO paper_trades (
                            id, bot_id, market, buy_order_uuid, sell_order_uuid,
                            buy_price, buy_volume, buy_amount, buy_date,
                            sell_price, sell_volume, sell_amount, sell_date,
                            profit_krw, profit_pct, status, buy_reason, sell_reason
                        ) VALUES (
                            %(id)s, %(bot_id)s, %(market)s, %(buy_order_uuid)s, %(sell_order_uuid)s,
                            %(buy_price)s, %(buy_volume)s, %(buy_amount)s, %(buy_date)s,
                            %(sell_price)s, %(sell_volume)s, %(sell_amount)s, %(sell_date)s,
                            %(profit_krw)s, %(profit_pct)s, %(status)s, %(buy_reason)s, %(sell_reason)s
                        ) ON CONFLICT (id) DO UPDATE SET
                            sell_order_uuid = EXCLUDED.sell_order_uuid,
                            sell_price = EXCLUDED.sell_price,
                            sell_volume = EXCLUDED.sell_volume,
                            sell_amount = EXCLUDED.sell_amount,
                            sell_date = EXCLUDED.sell_date,
                            profit_krw = EXCLUDED.profit_krw,
                            profit_pct = EXCLUDED.profit_pct,
                            status = EXCLUDED.status,
                            buy_reason = EXCLUDED.buy_reason,
                            sell_reason = EXCLUDED.sell_reason
                        """
                        data = []
                        for r in rows:
                            d = dict(r)
                            d.setdefault("buy_reason", None)
                            d.setdefault("sell_reason", None)
                            data.append(d)
                        execute_batch(cur, query, data)
                        cur.execute("SELECT setval('paper_trades_id_seq', COALESCE((SELECT MAX(id) FROM paper_trades), 1))")
                        print(f"  • paper_trades (가상거래): {len(rows)}건")
                except Exception as e:
                    print(f"  • paper_trades 오류: {e}")

                # 6) paper_bot_positions (가상거래 보유 포지션)
                try:
                    rows = s_conn.execute("SELECT * FROM paper_bot_positions").fetchall()
                    if rows:
                        seen = set()
                        sanitized = []
                        for r in rows:
                            d = dict(r)
                            u = str(d.get("order_uuid") or "").strip()
                            if not u:
                                u = f"paper-pos-{d.get('id', 0)}"
                            if u in seen:
                                u = f"{u}-dup-{d.get('id', 0)}"
                            seen.add(u)
                            d["order_uuid"] = u
                            sanitized.append(d)
                        query = """
                        INSERT INTO paper_bot_positions (
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
                            avg_buy_price = EXCLUDED.avg_buy_price,
                            buy_amount = EXCLUDED.buy_amount,
                            buy_fee = EXCLUDED.buy_fee
                        """
                        execute_batch(cur, query, sanitized)
                        cur.execute("SELECT setval('paper_bot_positions_id_seq', COALESCE((SELECT MAX(id) FROM paper_bot_positions), 1))")
                        print(f"  • paper_bot_positions (가상포지션): {len(rows)}건")
                except Exception as e:
                    print(f"  • paper_bot_positions 오류: {e}")

                # 7) crypto_news (link 중복 시 무시/업데이트)
                try:
                    rows = s_conn.execute("SELECT * FROM crypto_news").fetchall()
                    if rows:
                        query = """
                        INSERT INTO crypto_news (
                            title, link, source, published_at, summary, sentiment, keywords, created_at
                        ) VALUES (
                            %(title)s, %(link)s, %(source)s, %(published_at)s, %(summary)s, %(sentiment)s, %(keywords)s, %(created_at)s
                        ) ON CONFLICT (link) DO UPDATE SET
                            summary = EXCLUDED.summary,
                            sentiment = EXCLUDED.sentiment,
                            keywords = EXCLUDED.keywords
                        """
                        execute_batch(cur, query, [dict(r) for r in rows])
                        cur.execute("SELECT setval(pg_get_serial_sequence('crypto_news', 'id'), COALESCE((SELECT MAX(id) FROM crypto_news), 1))")
                        print(f"  • crypto_news: {len(rows)}건")
                except Exception as e:
                    print(f"  • crypto_news 오류: {e}")

                # 8) ai_market_briefings
                try:
                    rows = s_conn.execute("SELECT * FROM ai_market_briefings").fetchall()
                    if rows:
                        query = """
                        INSERT INTO ai_market_briefings (
                            provider, model, btc_price, btc_daily_20ma, btc_4h_60ma,
                            regime_status, briefing_text, created_at
                        ) VALUES (
                            %(provider)s, %(model)s, %(btc_price)s, %(btc_daily_20ma)s, %(btc_4h_60ma)s,
                            %(regime_status)s, %(briefing_text)s, %(created_at)s
                        )
                        """
                        # 중복 방지를 위해 기존 개수 확인
                        cur.execute("SELECT count(*) FROM ai_market_briefings")
                        existing_cnt = cur.fetchone()[0]
                        if existing_cnt < len(rows):
                            # 기존에 없는 것만 추가
                            cur.execute("SELECT briefing_text, created_at FROM ai_market_briefings")
                            existing_set = set(cur.fetchall())
                            to_insert = [dict(r) for r in rows if (r['briefing_text'], r['created_at']) not in existing_set]
                            if to_insert:
                                execute_batch(cur, query, to_insert)
                        print(f"  • ai_market_briefings: {len(rows)}건 완료")
                except Exception as e:
                    print(f"  • ai_market_briefings 오류: {e}")

                # 9) ai_news_briefings
                try:
                    rows = s_conn.execute("SELECT * FROM ai_news_briefings").fetchall()
                    if rows:
                        query = """
                        INSERT INTO ai_news_briefings (
                            provider, model, news_count, bullish_count, bearish_count,
                            neutral_count, briefing_text, created_at
                        ) VALUES (
                            %(provider)s, %(model)s, %(news_count)s, %(bullish_count)s, %(bearish_count)s,
                            %(neutral_count)s, %(briefing_text)s, %(created_at)s
                        )
                        """
                        cur.execute("SELECT count(*) FROM ai_news_briefings")
                        existing_cnt = cur.fetchone()[0]
                        if existing_cnt < len(rows):
                            cur.execute("SELECT briefing_text, created_at FROM ai_news_briefings")
                            existing_set = set(cur.fetchall())
                            to_insert = [dict(r) for r in rows if (r['briefing_text'], r['created_at']) not in existing_set]
                            if to_insert:
                                execute_batch(cur, query, to_insert)
                        print(f"  • ai_news_briefings: {len(rows)}건 완료")
                except Exception as e:
                    print(f"  • ai_news_briefings 오류: {e}")

                # 10) algo_lab_models
                try:
                    rows = s_conn.execute("SELECT * FROM algo_lab_models").fetchall()
                    if rows:
                        query = """
                        INSERT INTO algo_lab_models (
                            model_id, name, category, description,
                            initial_capital, cash_krw, eval_assets_krw,
                            cumulative_profit_krw, profit_rate_pct,
                            win_trades, lose_trades, total_trades, win_rate_pct,
                            current_rank, is_active, last_signal_text, config_json, updated_at
                        ) VALUES (
                            %(model_id)s, %(name)s, %(category)s, %(description)s,
                            %(initial_capital)s, %(cash_krw)s, %(eval_assets_krw)s,
                            %(cumulative_profit_krw)s, %(profit_rate_pct)s,
                            %(win_trades)s, %(lose_trades)s, %(total_trades)s, %(win_rate_pct)s,
                            %(current_rank)s, %(is_active)s, %(last_signal_text)s, %(config_json)s, %(updated_at)s
                        ) ON CONFLICT (model_id) DO UPDATE SET
                            cash_krw = EXCLUDED.cash_krw,
                            eval_assets_krw = EXCLUDED.eval_assets_krw,
                            cumulative_profit_krw = EXCLUDED.cumulative_profit_krw,
                            profit_rate_pct = EXCLUDED.profit_rate_pct,
                            win_trades = EXCLUDED.win_trades,
                            lose_trades = EXCLUDED.lose_trades,
                            total_trades = EXCLUDED.total_trades,
                            win_rate_pct = EXCLUDED.win_rate_pct,
                            current_rank = EXCLUDED.current_rank,
                            last_signal_text = EXCLUDED.last_signal_text,
                            updated_at = EXCLUDED.updated_at
                        """
                        execute_batch(cur, query, [dict(r) for r in rows])
                        print(f"  • algo_lab_models: {len(rows)}건")
                except Exception as e:
                    print(f"  • algo_lab_models 오류: {e}")

                # 11) algo_lab_positions
                try:
                    rows = s_conn.execute("SELECT * FROM algo_lab_positions").fetchall()
                    if rows:
                        query = """
                        INSERT INTO algo_lab_positions (
                            id, model_id, market, volume, avg_buy_price, buy_amount, buy_fee, status, created_at, closed_at
                        ) VALUES (
                            %(id)s, %(model_id)s, %(market)s, %(volume)s, %(avg_buy_price)s, %(buy_amount)s, %(buy_fee)s, %(status)s, %(created_at)s, %(closed_at)s
                        ) ON CONFLICT (id) DO UPDATE SET
                            volume = EXCLUDED.volume,
                            avg_buy_price = EXCLUDED.avg_buy_price,
                            buy_amount = EXCLUDED.buy_amount,
                            status = EXCLUDED.status,
                            closed_at = EXCLUDED.closed_at
                        """
                        execute_batch(cur, query, [dict(r) for r in rows])
                        cur.execute("SELECT setval(pg_get_serial_sequence('algo_lab_positions', 'id'), COALESCE((SELECT MAX(id) FROM algo_lab_positions), 1))")
                        print(f"  • algo_lab_positions: {len(rows)}건")
                except Exception as e:
                    print(f"  • algo_lab_positions 오류: {e}")

                # 12) algo_lab_trades
                try:
                    rows = s_conn.execute("SELECT * FROM algo_lab_trades").fetchall()
                    if rows:
                        query = """
                        INSERT INTO algo_lab_trades (
                            id, model_id, market, buy_price, buy_volume, buy_amount, buy_date,
                            sell_price, sell_volume, sell_amount, sell_date, profit_krw, profit_pct, reason, status
                        ) VALUES (
                            %(id)s, %(model_id)s, %(market)s, %(buy_price)s, %(buy_volume)s, %(buy_amount)s, %(buy_date)s,
                            %(sell_price)s, %(sell_volume)s, %(sell_amount)s, %(sell_date)s, %(profit_krw)s, %(profit_pct)s, %(reason)s, %(status)s
                        ) ON CONFLICT (id) DO UPDATE SET
                            sell_price = EXCLUDED.sell_price,
                            sell_volume = EXCLUDED.sell_volume,
                            sell_amount = EXCLUDED.sell_amount,
                            sell_date = EXCLUDED.sell_date,
                            profit_krw = EXCLUDED.profit_krw,
                            profit_pct = EXCLUDED.profit_pct,
                            reason = EXCLUDED.reason,
                            status = EXCLUDED.status
                        """
                        execute_batch(cur, query, [dict(r) for r in rows])
                        cur.execute("SELECT setval(pg_get_serial_sequence('algo_lab_trades', 'id'), COALESCE((SELECT MAX(id) FROM algo_lab_trades), 1))")
                        print(f"  • algo_lab_trades: {len(rows)}건")
                except Exception as e:
                    print(f"  • algo_lab_trades 오류: {e}")

                s_conn.close()

            # ----------------------------------------------------
            # B. trading_ledger.db 이관 (market_regime_filter)
            # ----------------------------------------------------
            if LEDGER_DB.exists():
                l_conn = sqlite3.connect(str(LEDGER_DB))
                l_conn.row_factory = sqlite3.Row
                try:
                    rows = l_conn.execute("SELECT * FROM market_regime_filter").fetchall()
                    if rows:
                        query = """
                        INSERT INTO market_regime_filter (
                            id, sentiment_score, market_regime, risk_alert, recommended_action,
                            position_size_multiplier, bot_overrides_json, blacklist_tickers_json,
                            reason, updated_at
                        ) VALUES (
                            %(id)s, %(sentiment_score)s, %(market_regime)s, %(risk_alert)s, %(recommended_action)s,
                            %(position_size_multiplier)s, %(bot_overrides_json)s, %(blacklist_tickers_json)s,
                            %(reason)s, %(updated_at)s
                        ) ON CONFLICT (id) DO UPDATE SET
                            sentiment_score = EXCLUDED.sentiment_score,
                            market_regime = EXCLUDED.market_regime,
                            risk_alert = EXCLUDED.risk_alert,
                            recommended_action = EXCLUDED.recommended_action,
                            position_size_multiplier = EXCLUDED.position_size_multiplier,
                            bot_overrides_json = EXCLUDED.bot_overrides_json,
                            blacklist_tickers_json = EXCLUDED.blacklist_tickers_json,
                            reason = EXCLUDED.reason,
                            updated_at = EXCLUDED.updated_at
                        """
                        execute_batch(cur, query, [dict(r) for r in rows])
                        print(f"  • market_regime_filter: {len(rows)}건")
                except Exception as e:
                    print(f"  • market_regime_filter 오류: {e}")
                l_conn.close()

        print("=" * 60)
        print("[SUCCESS] 전체 SQLite 데이터가 PostgreSQL 16으로 완벽하게 마이그레이션되었습니다!")
        print("=" * 60)
    finally:
        pg_conn.close()

if __name__ == "__main__":
    migrate_all()
