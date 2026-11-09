import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");
const ENV_PATH = path.join(ROOT_DIR, ".env");

function loadEnv() {
  if (fs.existsSync(ENV_PATH)) {
    const raw = fs.readFileSync(ENV_PATH, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (key && (process.env[key] === undefined || process.env[key] === "")) {
          process.env[key] = val;
        }
      }
    }
  }
}

export class PgSyncManager {
  constructor(config = {}) {
    loadEnv();

    const location = (config.location || process.env.LOCATION || "local").trim().toLowerCase();
    const isOuter = location === "outer";

    this.location = location;

    if (isOuter) {
      this.host = config.host || process.env.OUTER_PG_HOST || process.env.PGHOST || "127.0.0.1";
      this.port = Number(config.port || process.env.OUTER_PG_PORT || process.env.PGPORT || 5432);
      this.database = config.database || process.env.OUTER_PG_DATABASE || process.env.PGDATABASE || "coin_trader";
      this.user = config.user || process.env.OUTER_PG_USER || process.env.PGUSER || "coin_trader";
      this.password = config.password || process.env.OUTER_PG_PASSWORD || process.env.PGPASSWORD || "";
    } else {
      this.host = config.host || process.env.LOCAL_PG_HOST || process.env.PGHOST || "127.0.0.1";
      this.port = Number(config.port || process.env.LOCAL_PG_PORT || process.env.PGPORT || 5432);
      this.database = config.database || process.env.LOCAL_PG_DATABASE || process.env.PGDATABASE || "coin_trader";
      this.user = config.user || process.env.LOCAL_PG_USER || process.env.PGUSER || "coin_trader";
      this.password = config.password || process.env.LOCAL_PG_PASSWORD || process.env.PGPASSWORD || "";
    }

    this.pool = null;
    this.isConnected = false;
    this.timer = null;
  }

  async connect() {
    try {
      this.pool = new Pool({
        host: this.host,
        port: this.port,
        database: this.database,
        user: this.user,
        password: this.password,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 4000,
      });

      const res = await this.pool.query("SELECT NOW()");
      this.isConnected = true;
      console.log(`[PgSync] [LOCATION=${this.location.toUpperCase()}] Connected to PostgreSQL '${this.database}' at ${this.host}:${this.port} (${res.rows[0].now})`);
      return true;
    } catch (err) {
      console.warn(`[PgSync] [LOCATION=${this.location.toUpperCase()}] PostgreSQL connection failed to ${this.host}:${this.port}: ${err.message}. Running in SQLite-only mode.`);
      this.isConnected = false;
      return false;
    }
  }

  async syncAll(sqliteDb) {
    if (!this.isConnected || !this.pool) return;

    try {
      // 1. system_settings
      const settings = sqliteDb.prepare("SELECT * FROM system_settings").all();
      for (const s of settings) {
        await this.pool.query(
          `INSERT INTO system_settings (key, value, updated_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
          [s.key, String(s.value), s.updated_at]
        );
      }

      // 2. bots
      try {
        await this.pool.query(`
          ALTER TABLE bots ADD COLUMN IF NOT EXISTS is_selected_for_live INT NOT NULL DEFAULT 0;
          ALTER TABLE bots ADD COLUMN IF NOT EXISTS paper_initial_capital BIGINT NOT NULL DEFAULT 10000000;
          ALTER TABLE bots ADD COLUMN IF NOT EXISTS paper_virtual_krw BIGINT NOT NULL DEFAULT 10000000;
          ALTER TABLE bots ADD COLUMN IF NOT EXISTS paper_is_running INT NOT NULL DEFAULT 1;
          ALTER TABLE bots ADD COLUMN IF NOT EXISTS paper_peak_equity BIGINT NOT NULL DEFAULT 10000000;
          ALTER TABLE bots ADD COLUMN IF NOT EXISTS paper_mdd_pct NUMERIC(8,2) NOT NULL DEFAULT 0.0;
          ALTER TABLE bots ADD COLUMN IF NOT EXISTS paper_status_msg TEXT NOT NULL DEFAULT '시그널 대기 중';
          ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS buy_reason TEXT;
          ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS sell_reason TEXT;
        `);
      } catch {}

      const bots = sqliteDb.prepare("SELECT * FROM bots").all();
      for (const b of bots) {
        await this.pool.query(
          `INSERT INTO bots (
             bot_id, name, nickname, strategy_type, description,
             allocation_ratio, allocated_capital, virtual_krw, is_running,
             min_volume_krw, stop_loss_pct, take_profit_pct, config_json,
             last_status_msg, updated_at,
             is_selected_for_live, paper_initial_capital, paper_virtual_krw,
             paper_is_running, paper_peak_equity, paper_mdd_pct, paper_status_msg
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
           ON CONFLICT (bot_id) DO UPDATE SET
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
             paper_status_msg = EXCLUDED.paper_status_msg`,
          [
            b.bot_id, b.name, b.nickname, b.strategy_type, b.description || "",
            Number(b.allocation_ratio || 0), Math.floor(Number(b.allocated_capital || 0)),
            Math.floor(Number(b.virtual_krw || 0)), Number(b.is_running || 0),
            Math.floor(Number(b.min_volume_krw || 0)), Number(b.stop_loss_pct || 0),
            Number(b.take_profit_pct || 0), b.config_json || "{}",
            b.last_status_msg || "", b.updated_at,
            Number(b.is_selected_for_live || 0),
            Math.floor(Number(b.paper_initial_capital || 10000000)),
            Math.floor(Number(b.paper_virtual_krw || 10000000)),
            Number(b.paper_is_running || 1),
            Math.floor(Number(b.paper_peak_equity || 10000000)),
            Number(b.paper_mdd_pct || 0),
            b.paper_status_msg || "시그널 대기 중"
          ]
        );
      }

      // 3. trades
      const trades = sqliteDb.prepare("SELECT * FROM trades").all();
      for (const t of trades) {
        await this.pool.query(
          `INSERT INTO trades (
             id, bot_id, market, buy_order_uuid, sell_order_uuid,
             buy_price, buy_volume, buy_amount, buy_date,
             sell_price, sell_volume, sell_amount, sell_date,
             profit_krw, profit_pct, status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
           ON CONFLICT (id) DO UPDATE SET
             sell_order_uuid = EXCLUDED.sell_order_uuid,
             sell_price = EXCLUDED.sell_price,
             sell_volume = EXCLUDED.sell_volume,
             sell_amount = EXCLUDED.sell_amount,
             sell_date = EXCLUDED.sell_date,
             profit_krw = EXCLUDED.profit_krw,
             profit_pct = EXCLUDED.profit_pct,
             status = EXCLUDED.status`,
          [
            t.id, t.bot_id, t.market, t.buy_order_uuid, t.sell_order_uuid ?? null,
            Number(t.buy_price), String(t.buy_volume), Math.floor(Number(t.buy_amount)), t.buy_date,
            t.sell_price !== null && t.sell_price !== undefined ? Number(t.sell_price) : null,
            t.sell_volume ?? null,
            t.sell_amount !== null && t.sell_amount !== undefined ? Math.floor(Number(t.sell_amount)) : null,
            t.sell_date ?? null,
            t.profit_krw !== null && t.profit_krw !== undefined ? Math.floor(Number(t.profit_krw)) : null,
            t.profit_pct !== null && t.profit_pct !== undefined ? Number(t.profit_pct) : null,
            t.status || "HOLDING"
          ]
        );
      }

      // 4. bot_positions
      const positions = sqliteDb.prepare("SELECT * FROM bot_positions").all();
      for (const p of positions) {
        await this.pool.query(
          `INSERT INTO bot_positions (
             id, bot_id, market, order_uuid, volume,
             avg_buy_price, buy_amount, buy_fee, trade_id,
             status, created_at, closed_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (order_uuid) DO UPDATE SET
             volume = EXCLUDED.volume,
             avg_buy_price = EXCLUDED.avg_buy_price,
             buy_amount = EXCLUDED.buy_amount,
             buy_fee = EXCLUDED.buy_fee,
             status = EXCLUDED.status,
             closed_at = EXCLUDED.closed_at`,
          [
            p.id, p.bot_id, p.market, p.order_uuid, String(p.volume),
            Number(p.avg_buy_price), Math.floor(Number(p.buy_amount)),
            Number(p.buy_fee || 0), Number(p.trade_id),
            p.status || "OPEN", p.created_at, p.closed_at ?? null
          ]
        );
      }

      // 5. crypto_news
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS crypto_news (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          link TEXT NOT NULL UNIQUE,
          source TEXT NOT NULL,
          published_at TEXT NOT NULL,
          summary TEXT,
          sentiment VARCHAR(20) NOT NULL DEFAULT 'NEUTRAL',
          keywords TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pg_crypto_news_pubdate ON crypto_news (published_at DESC);
      `);

      try {
        const newsList = sqliteDb.prepare("SELECT * FROM crypto_news ORDER BY id DESC LIMIT 200").all();
        for (const n of newsList) {
          await this.pool.query(
            `INSERT INTO crypto_news (
               title, link, source, published_at, summary, sentiment, keywords, created_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (link) DO UPDATE SET
               title = EXCLUDED.title,
               summary = EXCLUDED.summary,
               sentiment = EXCLUDED.sentiment,
               keywords = EXCLUDED.keywords`,
            [
              n.title, n.link, n.source, n.published_at,
              n.summary || "", n.sentiment || "NEUTRAL",
              n.keywords || "", n.created_at
            ]
          );
        }
      } catch {}

      // 6. algo_lab_models, algo_lab_positions, algo_lab_trades
      try {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS algo_lab_models (
            model_id VARCHAR(64) PRIMARY KEY,
            name VARCHAR(128) NOT NULL,
            category VARCHAR(64) NOT NULL,
            description TEXT NOT NULL,
            initial_capital BIGINT NOT NULL DEFAULT 1000000,
            cash_krw BIGINT NOT NULL DEFAULT 1000000,
            eval_assets_krw BIGINT NOT NULL DEFAULT 1000000,
            cumulative_profit_krw BIGINT NOT NULL DEFAULT 0,
            profit_rate_pct NUMERIC(8,2) NOT NULL DEFAULT 0.0,
            win_trades INT NOT NULL DEFAULT 0,
            lose_trades INT NOT NULL DEFAULT 0,
            total_trades INT NOT NULL DEFAULT 0,
            win_rate_pct NUMERIC(6,2) NOT NULL DEFAULT 0.0,
            current_rank INT NOT NULL DEFAULT 1,
            is_active INT NOT NULL DEFAULT 1,
            last_signal_text TEXT NOT NULL DEFAULT '',
            config_json TEXT NOT NULL DEFAULT '{}',
            updated_at TIMESTAMP NOT NULL DEFAULT NOW()
          );

          CREATE TABLE IF NOT EXISTS algo_lab_positions (
            id SERIAL PRIMARY KEY,
            model_id VARCHAR(64) NOT NULL,
            market VARCHAR(32) NOT NULL,
            volume VARCHAR(32) NOT NULL,
            avg_buy_price NUMERIC(16,4) NOT NULL,
            buy_amount BIGINT NOT NULL,
            buy_fee NUMERIC(16,4) NOT NULL DEFAULT 0,
            status VARCHAR(16) NOT NULL DEFAULT 'OPEN',
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            closed_at TIMESTAMP
          );

          CREATE TABLE IF NOT EXISTS algo_lab_trades (
            id SERIAL PRIMARY KEY,
            model_id VARCHAR(64) NOT NULL,
            market VARCHAR(32) NOT NULL,
            buy_price NUMERIC(16,4) NOT NULL,
            buy_volume VARCHAR(32) NOT NULL,
            buy_amount BIGINT NOT NULL,
            buy_date TIMESTAMP NOT NULL,
            sell_price NUMERIC(16,4),
            sell_volume VARCHAR(32),
            sell_amount BIGINT,
            sell_date TIMESTAMP,
            profit_krw BIGINT,
            profit_pct NUMERIC(8,2),
            reason TEXT,
            status VARCHAR(16) NOT NULL DEFAULT 'HOLDING'
          );
        `);

        const models = sqliteDb.prepare("SELECT * FROM algo_lab_models").all();
        for (const m of models) {
          await this.pool.query(
            `INSERT INTO algo_lab_models (
               model_id, name, category, description,
               initial_capital, cash_krw, eval_assets_krw,
               cumulative_profit_krw, profit_rate_pct,
               win_trades, lose_trades, total_trades, win_rate_pct,
               current_rank, is_active, last_signal_text, config_json, updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
             ON CONFLICT (model_id) DO UPDATE SET
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
               updated_at = EXCLUDED.updated_at`,
            [
              m.model_id, m.name, m.category, m.description || "",
              Math.floor(Number(m.initial_capital || 1000000)), Math.floor(Number(m.cash_krw || 1000000)),
              Math.floor(Number(m.eval_assets_krw || 1000000)), Math.floor(Number(m.cumulative_profit_krw || 0)),
              Number(m.profit_rate_pct || 0), Number(m.win_trades || 0),
              Number(m.lose_trades || 0), Number(m.total_trades || 0),
              Number(m.win_rate_pct || 0), Number(m.current_rank || 1),
              Number(m.is_active || 1), m.last_signal_text || "",
              m.config_json || "{}", m.updated_at
            ]
          );
        }

        const positions = sqliteDb.prepare("SELECT * FROM algo_lab_positions").all();
        for (const p of positions) {
          await this.pool.query(
            `INSERT INTO algo_lab_positions (
               id, model_id, market, volume, avg_buy_price, buy_amount, buy_fee, status, created_at, closed_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (id) DO UPDATE SET
               volume = EXCLUDED.volume,
               avg_buy_price = EXCLUDED.avg_buy_price,
               buy_amount = EXCLUDED.buy_amount,
               status = EXCLUDED.status,
               closed_at = EXCLUDED.closed_at`,
            [
              p.id, p.model_id, p.market, String(p.volume),
              Number(p.avg_buy_price || 0), Math.floor(Number(p.buy_amount || 0)),
              Number(p.buy_fee || 0), p.status || "OPEN",
              p.created_at, p.closed_at
            ]
          );
        }

        const trades = sqliteDb.prepare("SELECT * FROM algo_lab_trades ORDER BY id DESC LIMIT 200").all();
        for (const t of trades) {
          await this.pool.query(
            `INSERT INTO algo_lab_trades (
               id, model_id, market, buy_price, buy_volume, buy_amount, buy_date,
               sell_price, sell_volume, sell_amount, sell_date, profit_krw, profit_pct, reason, status
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             ON CONFLICT (id) DO UPDATE SET
               sell_price = EXCLUDED.sell_price,
               sell_volume = EXCLUDED.sell_volume,
               sell_amount = EXCLUDED.sell_amount,
               sell_date = EXCLUDED.sell_date,
               profit_krw = EXCLUDED.profit_krw,
               profit_pct = EXCLUDED.profit_pct,
               reason = EXCLUDED.reason,
               status = EXCLUDED.status`,
            [
              t.id, t.model_id, t.market, Number(t.buy_price || 0),
              String(t.buy_volume || "0"), Math.floor(Number(t.buy_amount || 0)),
              t.buy_date, t.sell_price ? Number(t.sell_price) : null,
              t.sell_volume ? String(t.sell_volume) : null,
              t.sell_amount ? Math.floor(Number(t.sell_amount)) : null,
              t.sell_date, t.profit_krw ? Math.floor(Number(t.profit_krw)) : null,
              t.profit_pct ? Number(t.profit_pct) : null,
              t.reason || "", t.status || "HOLDING"
            ]
          );
        }
      } catch {}

      // 7. paper_trades and paper_bot_positions (가상거래 전용 테이블)
      try {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS paper_trades (
            id BIGINT PRIMARY KEY,
            bot_id VARCHAR(64) NOT NULL,
            market VARCHAR(32) NOT NULL,
            buy_order_uuid VARCHAR(128) NOT NULL,
            sell_order_uuid VARCHAR(128),
            buy_price NUMERIC(16,4) NOT NULL,
            buy_volume VARCHAR(32) NOT NULL,
            buy_amount BIGINT NOT NULL,
            buy_date TIMESTAMP NOT NULL,
            sell_price NUMERIC(16,4),
            sell_volume VARCHAR(32),
            sell_amount BIGINT,
            sell_date TIMESTAMP,
            profit_krw BIGINT,
            profit_pct NUMERIC(8,2),
            status VARCHAR(16) NOT NULL DEFAULT 'HOLDING'
          );

          CREATE TABLE IF NOT EXISTS paper_bot_positions (
            id BIGINT PRIMARY KEY,
            bot_id VARCHAR(64) NOT NULL,
            market VARCHAR(32) NOT NULL,
            order_uuid VARCHAR(128) NOT NULL UNIQUE,
            volume VARCHAR(32) NOT NULL,
            avg_buy_price NUMERIC(16,4) NOT NULL,
            buy_amount BIGINT NOT NULL,
            buy_fee NUMERIC(16,4) NOT NULL DEFAULT 0,
            trade_id BIGINT NOT NULL,
            status VARCHAR(16) NOT NULL DEFAULT 'OPEN',
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            closed_at TIMESTAMP
          );
        `);

        const pTrades = sqliteDb.prepare("SELECT * FROM paper_trades").all();
        for (const t of pTrades) {
          await this.pool.query(
            `INSERT INTO paper_trades (
               id, bot_id, market, buy_order_uuid, sell_order_uuid,
               buy_price, buy_volume, buy_amount, buy_date,
               sell_price, sell_volume, sell_amount, sell_date,
               profit_krw, profit_pct, status
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
             ON CONFLICT (id) DO UPDATE SET
               sell_order_uuid = EXCLUDED.sell_order_uuid,
               sell_price = EXCLUDED.sell_price,
               sell_volume = EXCLUDED.sell_volume,
               sell_amount = EXCLUDED.sell_amount,
               sell_date = EXCLUDED.sell_date,
               profit_krw = EXCLUDED.profit_krw,
               profit_pct = EXCLUDED.profit_pct,
               status = EXCLUDED.status`,
            [
              t.id, t.bot_id, t.market, t.buy_order_uuid, t.sell_order_uuid ?? null,
              Number(t.buy_price), String(t.buy_volume), Math.floor(Number(t.buy_amount)), t.buy_date,
              t.sell_price !== null && t.sell_price !== undefined ? Number(t.sell_price) : null,
              t.sell_volume ?? null,
              t.sell_amount !== null && t.sell_amount !== undefined ? Math.floor(Number(t.sell_amount)) : null,
              t.sell_date ?? null,
              t.profit_krw !== null && t.profit_krw !== undefined ? Math.floor(Number(t.profit_krw)) : null,
              t.profit_pct !== null && t.profit_pct !== undefined ? Number(t.profit_pct) : null,
              t.status || "HOLDING"
            ]
          );
        }

        const pPositions = sqliteDb.prepare("SELECT * FROM paper_bot_positions").all();
        for (const p of pPositions) {
          await this.pool.query(
            `INSERT INTO paper_bot_positions (
               id, bot_id, market, order_uuid, volume,
               avg_buy_price, buy_amount, buy_fee, trade_id,
               status, created_at, closed_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (order_uuid) DO UPDATE SET
               volume = EXCLUDED.volume,
               avg_buy_price = EXCLUDED.avg_buy_price,
               buy_amount = EXCLUDED.buy_amount,
               buy_fee = EXCLUDED.buy_fee,
               status = EXCLUDED.status,
               closed_at = EXCLUDED.closed_at`,
            [
              p.id, p.bot_id, p.market, p.order_uuid, String(p.volume),
              Number(p.avg_buy_price), Math.floor(Number(p.buy_amount)),
              Number(p.buy_fee || 0), Number(p.trade_id),
              p.status || "OPEN", p.created_at, p.closed_at ?? null
            ]
          );
        }
      } catch {}
    } catch (err) {
      console.warn(`[PgSync] Sync error: ${err.message}`);
    }
  }

  startAutoSync(getSqliteDbFn, intervalMs = 10000) {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(async () => {
      try {
        const sqliteDb = getSqliteDbFn();
        if (sqliteDb) {
          await this.syncAll(sqliteDb);
        }
      } catch (err) {
        // silent
      }
    }, intervalMs);
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    if (this.pool) await this.pool.end();
  }
}

export const pgSyncManager = new PgSyncManager();
