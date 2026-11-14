import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");
const ENV_PATH = path.join(ROOT_DIR, ".env");

const ALL_BOT_IDS = Array.from({ length: 10 }, (_, idx) => `bot_${String(idx + 1).padStart(2, "0")}`);
const LEGACY_BOT_OVERRIDE_ALIAS = {
  bot_vb: "bot_01",
  bot_momentum: "bot_03",
  bot_bb: "bot_05",
};
const DEFAULT_BOT_OVERRIDES = Object.fromEntries(ALL_BOT_IDS.map((id) => [id, "ALLOW"]));
const DEFAULT_BOT_OVERRIDES_JSON = JSON.stringify(DEFAULT_BOT_OVERRIDES);

function normalizeBotOverridesJson(rawValue) {
  let parsed = {};
  if (typeof rawValue === "string" && rawValue.trim()) {
    try {
      const candidate = JSON.parse(rawValue);
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        parsed = candidate;
      }
    } catch {
      parsed = {};
    }
  } else if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
    parsed = rawValue;
  }

  const normalized = { ...DEFAULT_BOT_OVERRIDES };
  for (const [legacyKey, modernKey] of Object.entries(LEGACY_BOT_OVERRIDE_ALIAS)) {
    const val = String(parsed[legacyKey] || "").trim().toUpperCase();
    if ((val === "ALLOW" || val === "BLOCK") && parsed[modernKey] === undefined) {
      normalized[modernKey] = val;
    }
  }
  for (const botId of ALL_BOT_IDS) {
    const val = String(parsed[botId] || "").trim().toUpperCase();
    if (val === "ALLOW" || val === "BLOCK") {
      normalized[botId] = val;
    }
  }
  return JSON.stringify(normalized);
}

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
    loadEnv();
    if (process.env.PG_SYNC_ENABLED === "false" || process.env.DB_MODE === "sqlite") {
      console.log(`[PgSync] SQLite 단독 모드 활성화됨 (PG_SYNC_ENABLED=${process.env.PG_SYNC_ENABLED}, DB_MODE=${process.env.DB_MODE}). PostgreSQL 동기화를 건너뜁니다.`);
      this.isConnected = false;
      return false;
    }

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
    if (process.env.PG_SYNC_ENABLED === "false" || process.env.DB_MODE === "sqlite") return;
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

      // 1-1. market_regime_filter
      try {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS market_regime_filter (
            id INTEGER PRIMARY KEY,
            sentiment_score NUMERIC(8,4) DEFAULT 0.0,
            market_regime TEXT DEFAULT 'SIDEWAYS',
            risk_alert INTEGER DEFAULT 0,
            recommended_action TEXT DEFAULT 'NORMAL',
            position_size_multiplier NUMERIC(8,4) DEFAULT 1.0,
            bot_overrides_json TEXT DEFAULT '${DEFAULT_BOT_OVERRIDES_JSON}',
            blacklist_tickers_json TEXT DEFAULT '[]',
            reason TEXT DEFAULT 'Initial default state',
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            flash_sentiment_score NUMERIC(8,4) DEFAULT 0.0,
            flash_recommended_action TEXT DEFAULT 'NORMAL',
            flash_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            pro_sentiment_score NUMERIC(8,4) DEFAULT 0.0,
            pro_recommended_action TEXT DEFAULT 'NORMAL',
            pro_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            final_risk_alert INTEGER DEFAULT 0,
            final_position_multiplier NUMERIC(8,4) DEFAULT 1.0,
            final_bot_overrides_json TEXT DEFAULT '${DEFAULT_BOT_OVERRIDES_JSON}'
          );
          ALTER TABLE market_regime_filter ADD COLUMN IF NOT EXISTS flash_sentiment_score NUMERIC(8,4) DEFAULT 0.0;
          ALTER TABLE market_regime_filter ADD COLUMN IF NOT EXISTS flash_recommended_action TEXT DEFAULT 'NORMAL';
          ALTER TABLE market_regime_filter ADD COLUMN IF NOT EXISTS flash_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
          ALTER TABLE market_regime_filter ADD COLUMN IF NOT EXISTS pro_sentiment_score NUMERIC(8,4) DEFAULT 0.0;
          ALTER TABLE market_regime_filter ADD COLUMN IF NOT EXISTS pro_recommended_action TEXT DEFAULT 'NORMAL';
          ALTER TABLE market_regime_filter ADD COLUMN IF NOT EXISTS pro_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
          ALTER TABLE market_regime_filter ADD COLUMN IF NOT EXISTS final_risk_alert INTEGER DEFAULT 0;
          ALTER TABLE market_regime_filter ADD COLUMN IF NOT EXISTS final_position_multiplier NUMERIC(8,4) DEFAULT 1.0;
          ALTER TABLE market_regime_filter ADD COLUMN IF NOT EXISTS final_bot_overrides_json TEXT DEFAULT '${DEFAULT_BOT_OVERRIDES_JSON}';
        `);
        const regime = sqliteDb.prepare("SELECT * FROM market_regime_filter WHERE id = 1").get();
        if (regime) {
          const normalizedOverridesJson = normalizeBotOverridesJson(regime.bot_overrides_json);
          const normalizedFinalOverridesJson = normalizeBotOverridesJson(regime.final_bot_overrides_json || normalizedOverridesJson);
          await this.pool.query(
            `INSERT INTO market_regime_filter (
               id, sentiment_score, market_regime, risk_alert, recommended_action,
               position_size_multiplier, bot_overrides_json, blacklist_tickers_json,
               reason, updated_at, flash_sentiment_score, flash_recommended_action,
               flash_updated_at, pro_sentiment_score, pro_recommended_action,
               pro_updated_at, final_risk_alert, final_position_multiplier, final_bot_overrides_json
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
             ON CONFLICT (id) DO UPDATE SET
               sentiment_score = EXCLUDED.sentiment_score,
               market_regime = EXCLUDED.market_regime,
               risk_alert = EXCLUDED.risk_alert,
               recommended_action = EXCLUDED.recommended_action,
               position_size_multiplier = EXCLUDED.position_size_multiplier,
               bot_overrides_json = EXCLUDED.bot_overrides_json,
               blacklist_tickers_json = EXCLUDED.blacklist_tickers_json,
               reason = EXCLUDED.reason,
               updated_at = EXCLUDED.updated_at,
               flash_sentiment_score = EXCLUDED.flash_sentiment_score,
               flash_recommended_action = EXCLUDED.flash_recommended_action,
               flash_updated_at = EXCLUDED.flash_updated_at,
               pro_sentiment_score = EXCLUDED.pro_sentiment_score,
               pro_recommended_action = EXCLUDED.pro_recommended_action,
               pro_updated_at = EXCLUDED.pro_updated_at,
               final_risk_alert = EXCLUDED.final_risk_alert,
               final_position_multiplier = EXCLUDED.final_position_multiplier,
               final_bot_overrides_json = EXCLUDED.final_bot_overrides_json`,
            [
              1, Number(regime.sentiment_score || 0), regime.market_regime || "SIDEWAYS",
              Number(regime.risk_alert || 0), regime.recommended_action || "NORMAL",
              Number(regime.position_size_multiplier ?? 1.0), normalizedOverridesJson,
              regime.blacklist_tickers_json || "[]", regime.reason || "", regime.updated_at || new Date().toISOString(),
              Number(regime.flash_sentiment_score || 0), regime.flash_recommended_action || "NORMAL",
              regime.flash_updated_at || null, Number(regime.pro_sentiment_score || 0),
              regime.pro_recommended_action || "NORMAL", regime.pro_updated_at || null,
              Number(regime.final_risk_alert || 0), Number(regime.final_position_multiplier ?? 1.0),
              normalizedFinalOverridesJson
            ]
          );
        }
      } catch (rErr) {
        console.warn(`[PgSync] market_regime_filter sync skip: ${rErr.message}`);
      }

      // 2. bots
      try {
        await this.pool.query(`
          ALTER TABLE bots ADD COLUMN IF NOT EXISTS strategy_group VARCHAR(32) NOT NULL DEFAULT 'TREND_SWING';
          ALTER TABLE bots ADD COLUMN IF NOT EXISTS is_selected_for_live INT NOT NULL DEFAULT 0;
          ALTER TABLE bots ADD COLUMN IF NOT EXISTS paper_initial_capital BIGINT NOT NULL DEFAULT 1000000;
          ALTER TABLE bots ADD COLUMN IF NOT EXISTS paper_virtual_krw BIGINT NOT NULL DEFAULT 1000000;
          ALTER TABLE bots ADD COLUMN IF NOT EXISTS paper_is_running INT NOT NULL DEFAULT 1;
          ALTER TABLE bots ADD COLUMN IF NOT EXISTS paper_peak_equity BIGINT NOT NULL DEFAULT 1000000;
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
             bot_id, name, nickname, strategy_type, strategy_group, description,
             allocation_ratio, allocated_capital, virtual_krw, is_running,
             min_volume_krw, stop_loss_pct, take_profit_pct, config_json,
             last_status_msg, updated_at,
             is_selected_for_live, paper_initial_capital, paper_virtual_krw,
             paper_is_running, paper_peak_equity, paper_mdd_pct, paper_status_msg
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
           ON CONFLICT (bot_id) DO UPDATE SET
             name = EXCLUDED.name,
             nickname = EXCLUDED.nickname,
             strategy_type = EXCLUDED.strategy_type,
             strategy_group = EXCLUDED.strategy_group,
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
            b.bot_id, b.name, b.nickname, b.strategy_type, b.strategy_group || "TREND_SWING", b.description || "",
            Number(b.allocation_ratio || 0), Math.floor(Number(b.allocated_capital || 0)),
            Math.floor(Number(b.virtual_krw || 0)), Number(b.is_running || 0),
            Math.floor(Number(b.min_volume_krw || 0)), Number(b.stop_loss_pct || 0),
            Number(b.take_profit_pct || 0), b.config_json || "{}",
            b.last_status_msg || "", b.updated_at,
            Number(b.is_selected_for_live || 0),
            Math.floor(Number(b.paper_initial_capital || 1000000)),
            Math.floor(Number(b.paper_virtual_krw || 1000000)),
            Number(b.paper_is_running || 1),
            Math.floor(Number(b.paper_peak_equity || 1000000)),
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

      // 4. bot_positions (스키마 마이그레이션 + sell/메타 컬럼 포함 UPSERT)
      try {
        await this.pool.query(`
          ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS ticker TEXT;
          ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS highest_price NUMERIC(20,8) DEFAULT 0.0;
          ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS step_level INT DEFAULT 1;
          ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS sell_order_uuid TEXT;
          ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS sell_price NUMERIC(20,8);
          ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS sell_amount NUMERIC(20,2);
          ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS sell_fee NUMERIC(20,4);
          ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS realized_pnl NUMERIC(20,2);
          ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS pnl_pct NUMERIC(8,2);
        `);
      } catch {}

      const positions = sqliteDb.prepare("SELECT * FROM bot_positions").all();
      for (const p of positions) {
        const mkt = p.market || p.ticker || "KRW-BTC";
        await this.pool.query(
          `INSERT INTO bot_positions (
             id, bot_id, market, ticker, order_uuid, volume,
             avg_buy_price, buy_amount, buy_fee, trade_id,
             highest_price, step_level, status, created_at, closed_at,
             sell_order_uuid, sell_price, sell_amount, sell_fee, realized_pnl, pnl_pct
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
           ON CONFLICT (order_uuid) DO UPDATE SET
             bot_id = EXCLUDED.bot_id,
             market = EXCLUDED.market,
             ticker = EXCLUDED.ticker,
             volume = EXCLUDED.volume,
             avg_buy_price = EXCLUDED.avg_buy_price,
             buy_amount = EXCLUDED.buy_amount,
             buy_fee = EXCLUDED.buy_fee,
             highest_price = EXCLUDED.highest_price,
             step_level = EXCLUDED.step_level,
             status = EXCLUDED.status,
             closed_at = EXCLUDED.closed_at,
             sell_order_uuid = EXCLUDED.sell_order_uuid,
             sell_price = EXCLUDED.sell_price,
             sell_amount = EXCLUDED.sell_amount,
             sell_fee = EXCLUDED.sell_fee,
             realized_pnl = EXCLUDED.realized_pnl,
             pnl_pct = EXCLUDED.pnl_pct`,
          [
            p.id, p.bot_id, mkt, p.ticker || mkt, p.order_uuid, String(p.volume),
            Number(p.avg_buy_price || 0), Math.floor(Number(p.buy_amount || 0)),
            Number(p.buy_fee || 0), Number(p.trade_id || 0),
            Number(p.highest_price || 0), Number(p.step_level || 1),
            p.status || "OPEN", p.created_at || new Date().toISOString(), p.closed_at ?? null,
            p.sell_order_uuid ?? null,
            p.sell_price !== null && p.sell_price !== undefined ? Number(p.sell_price) : null,
            p.sell_amount !== null && p.sell_amount !== undefined ? Number(p.sell_amount) : null,
            p.sell_fee !== null && p.sell_fee !== undefined ? Number(p.sell_fee) : null,
            p.realized_pnl !== null && p.realized_pnl !== undefined ? Number(p.realized_pnl) : null,
            p.pnl_pct !== null && p.pnl_pct !== undefined ? Number(p.pnl_pct) : null
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
            status VARCHAR(16) NOT NULL DEFAULT 'HOLDING',
            buy_reason TEXT,
            sell_reason TEXT
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
               profit_krw, profit_pct, status, buy_reason, sell_reason
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
             ON CONFLICT (id) DO UPDATE SET
               sell_order_uuid = EXCLUDED.sell_order_uuid,
               sell_price = EXCLUDED.sell_price,
               sell_volume = EXCLUDED.sell_volume,
               sell_amount = EXCLUDED.sell_amount,
               sell_date = EXCLUDED.sell_date,
               profit_krw = EXCLUDED.profit_krw,
               profit_pct = EXCLUDED.profit_pct,
               status = EXCLUDED.status,
               buy_reason = EXCLUDED.buy_reason,
               sell_reason = EXCLUDED.sell_reason`,
            [
              t.id, t.bot_id, t.market, t.buy_order_uuid, t.sell_order_uuid ?? null,
              Number(t.buy_price), String(t.buy_volume), Math.floor(Number(t.buy_amount)), t.buy_date,
              t.sell_price !== null && t.sell_price !== undefined ? Number(t.sell_price) : null,
              t.sell_volume ?? null,
              t.sell_amount !== null && t.sell_amount !== undefined ? Math.floor(Number(t.sell_amount)) : null,
              t.sell_date ?? null,
              t.profit_krw !== null && t.profit_krw !== undefined ? Math.floor(Number(t.profit_krw)) : null,
              t.profit_pct !== null && t.profit_pct !== undefined ? Number(t.profit_pct) : null,
              t.status || "HOLDING",
              t.buy_reason ?? null,
              t.sell_reason ?? null
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

      // 8. monthly_asset_snapshots (월별 자산 스냅샷 테이블)
      try {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS monthly_asset_snapshots (
            year_month VARCHAR(16) NOT NULL,
            mode VARCHAR(16) NOT NULL DEFAULT 'live',
            month_start_balance NUMERIC(16,4) NOT NULL,
            current_balance NUMERIC(16,4) NOT NULL,
            krw_balance NUMERIC(16,4) NOT NULL DEFAULT 0,
            coin_eval_balance NUMERIC(16,4) NOT NULL DEFAULT 0,
            diff_amount NUMERIC(16,4) NOT NULL DEFAULT 0,
            diff_rate NUMERIC(8,2) NOT NULL DEFAULT 0,
            snapshot_date VARCHAR(32) NOT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
            PRIMARY KEY (year_month, mode)
          );
        `);

        const snapshots = sqliteDb.prepare("SELECT * FROM monthly_asset_snapshots").all();
        for (const s of snapshots) {
          await this.pool.query(
            `INSERT INTO monthly_asset_snapshots (
               year_month, mode, month_start_balance, current_balance,
               krw_balance, coin_eval_balance, diff_amount, diff_rate,
               snapshot_date, updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (year_month, mode) DO UPDATE SET
               month_start_balance = EXCLUDED.month_start_balance,
               current_balance = EXCLUDED.current_balance,
               krw_balance = EXCLUDED.krw_balance,
               coin_eval_balance = EXCLUDED.coin_eval_balance,
               diff_amount = EXCLUDED.diff_amount,
               diff_rate = EXCLUDED.diff_rate,
               snapshot_date = EXCLUDED.snapshot_date,
               updated_at = EXCLUDED.updated_at`,
            [
              s.year_month, s.mode || "live", Number(s.month_start_balance || 0),
              Number(s.current_balance || 0), Number(s.krw_balance || 0),
              Number(s.coin_eval_balance || 0), Number(s.diff_amount || 0),
              Number(s.diff_rate || 0), s.snapshot_date, s.updated_at
            ]
          );
        }
      } catch {}

      // 11. auto_rotation_config & auto_rotation_history
      try {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS auto_rotation_config (
            id INT PRIMARY KEY,
            is_enabled INT DEFAULT 1,
            rotation_day_of_week INT DEFAULT 1,
            rotation_hour_kst INT DEFAULT 9,
            allocation_mode VARCHAR(64) DEFAULT 'RANK_WEIGHTED_40_35_25',
            min_weekly_trades INT DEFAULT 2,
            last_rotated_at TEXT,
            next_rotation_at TEXT,
            updated_at TEXT
          );
          CREATE TABLE IF NOT EXISTS auto_rotation_history (
            id BIGINT PRIMARY KEY,
            trigger_type TEXT,
            previous_bots_json TEXT,
            elected_bots_json TEXT,
            draining_positions_count INT DEFAULT 0,
            transferred_krw DOUBLE PRECISION DEFAULT 0,
            summary_text TEXT,
            created_at TEXT
          );
        `);
        const rotCfg = sqliteDb.prepare("SELECT * FROM auto_rotation_config WHERE id = 1").get();
        if (rotCfg) {
          await this.pool.query(
            `INSERT INTO auto_rotation_config (
               id, is_enabled, rotation_day_of_week, rotation_hour_kst,
               allocation_mode, min_weekly_trades, last_rotated_at, next_rotation_at, updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO UPDATE SET
               is_enabled = EXCLUDED.is_enabled,
               rotation_day_of_week = EXCLUDED.rotation_day_of_week,
               rotation_hour_kst = EXCLUDED.rotation_hour_kst,
               allocation_mode = EXCLUDED.allocation_mode,
               min_weekly_trades = EXCLUDED.min_weekly_trades,
               last_rotated_at = EXCLUDED.last_rotated_at,
               next_rotation_at = EXCLUDED.next_rotation_at,
               updated_at = EXCLUDED.updated_at`,
            [
              1,
              Number(rotCfg.is_enabled ?? 1),
              Number(rotCfg.rotation_day_of_week ?? 1),
              Number(rotCfg.rotation_hour_kst ?? 9),
              rotCfg.allocation_mode || "RANK_WEIGHTED_40_35_25",
              Number(rotCfg.min_weekly_trades ?? 2),
              rotCfg.last_rotated_at || null,
              rotCfg.next_rotation_at || null,
              rotCfg.updated_at || null,
            ]
          );
        }
        const rotHistory = sqliteDb.prepare("SELECT * FROM auto_rotation_history").all();
        for (const h of rotHistory) {
          await this.pool.query(
            `INSERT INTO auto_rotation_history (
               id, trigger_type, previous_bots_json, elected_bots_json,
               draining_positions_count, transferred_krw, summary_text, created_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (id) DO UPDATE SET
               trigger_type = EXCLUDED.trigger_type,
               previous_bots_json = EXCLUDED.previous_bots_json,
               elected_bots_json = EXCLUDED.elected_bots_json,
               draining_positions_count = EXCLUDED.draining_positions_count,
               transferred_krw = EXCLUDED.transferred_krw,
               summary_text = EXCLUDED.summary_text,
               created_at = EXCLUDED.created_at`,
            [
              h.id,
              h.trigger_type || null,
              h.previous_bots_json || "[]",
              h.elected_bots_json || "[]",
              Number(h.draining_positions_count || 0),
              Number(h.transferred_krw || 0),
              h.summary_text || "",
              h.created_at || null,
            ]
          );
        }
      } catch {}
    } catch (err) {
      if (err.code === "ECONNREFUSED" || err.message?.includes("Connection terminated") || err.message?.includes("closed")) {
        this.isConnected = false;
      }
      console.warn(`[PgSync] Sync error: ${err.message}`);
    }
  }

  startAutoSync(getSqliteDbFn, intervalMs = 10000) {
    if (process.env.PG_SYNC_ENABLED === "false" || process.env.DB_MODE === "sqlite" || !this.isConnected || !this.pool) {
      return;
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(async () => {
      if (!this.isConnected || !this.pool) {
        if (this.timer) {
          clearInterval(this.timer);
          this.timer = null;
        }
        return;
      }
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
