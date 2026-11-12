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

loadEnv();

const location = (process.env.LOCATION || "local").trim().toLowerCase();
const isOuter = location === "outer";

export const pgConfig = {
  host: isOuter ? (process.env.OUTER_PG_HOST || process.env.PGHOST || "127.0.0.1") : (process.env.LOCAL_PG_HOST || process.env.PGHOST || "127.0.0.1"),
  port: Number(isOuter ? (process.env.OUTER_PG_PORT || process.env.PGPORT || 5432) : (process.env.LOCAL_PG_PORT || process.env.PGPORT || 5432)),
  database: isOuter ? (process.env.OUTER_PG_DATABASE || process.env.PGDATABASE || "coin_trader") : (process.env.LOCAL_PG_DATABASE || process.env.PGDATABASE || "coin_trader"),
  user: isOuter ? (process.env.OUTER_PG_USER || process.env.PGUSER || "coin_trader") : (process.env.LOCAL_PG_USER || process.env.PGUSER || "coin_trader"),
  password: isOuter ? (process.env.OUTER_PG_PASSWORD || process.env.PGPASSWORD || "") : (process.env.LOCAL_PG_PASSWORD || process.env.PGPASSWORD || ""),
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
};

/**
 * SQLite 호환 SQL 문법을 PostgreSQL 문법으로 번역합니다.
 */
export function translateSql(sql) {
  let s = sql.trim();

  // 1. PRAGMA 무시 또는 변환
  if (/^PRAGMA\s+journal_mode/i.test(s) || /^PRAGMA\s+synchronous/i.test(s) || /^PRAGMA\s+busy_timeout/i.test(s) || /^PRAGMA\s+foreign_keys/i.test(s)) {
    return "SELECT 1";
  }

  const pragmaTableInfo = s.match(/^PRAGMA\s+table_info\(([^)]+)\)/i);
  if (pragmaTableInfo) {
    const table = pragmaTableInfo[1].replace(/['"`]/g, "").trim();
    return `SELECT column_name AS name FROM information_schema.columns WHERE table_name = '${table}'`;
  }

  // 2. INSERT OR REPLACE INTO system_settings
  if (/INSERT\s+OR\s+REPLACE\s+INTO\s+system_settings/i.test(s)) {
    s = s.replace(/INSERT\s+OR\s+REPLACE\s+INTO\s+system_settings/i, "INSERT INTO system_settings");
    if (!/ON\s+CONFLICT/i.test(s)) {
      s += " ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at";
    }
  }

  // 3. INSERT OR IGNORE INTO <table_name>
  const insertIgnoreMatch = s.match(/INSERT\s+OR\s+IGNORE\s+INTO\s+([a-zA-Z0-9_]+)/i);
  if (insertIgnoreMatch) {
    const table = insertIgnoreMatch[1].toLowerCase();
    s = s.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, "INSERT INTO");
    if (!/ON\s+CONFLICT/i.test(s)) {
      if (table === "system_settings") {
        s += " ON CONFLICT (key) DO NOTHING";
      } else if (table === "bots") {
        s += " ON CONFLICT (bot_id) DO NOTHING";
      } else if (table === "crypto_news") {
        s += " ON CONFLICT (link) DO NOTHING";
      } else if (table === "algo_lab_models") {
        s += " ON CONFLICT (model_id) DO NOTHING";
      } else if (table === "paper_bot_positions" || table === "bot_positions") {
        s += " ON CONFLICT (order_uuid) DO NOTHING";
      } else if (table === "push_subscriptions") {
        s += " ON CONFLICT (endpoint) DO NOTHING";
      } else {
        s += " ON CONFLICT DO NOTHING";
      }
    }
  }

  // 4. INSERT INTO 시 RETURNING id 자동 부착 (이미 RETURNING이 없는 경우)
  if (/^INSERT\s+INTO\s+(paper_trades|paper_bot_positions|trades|bot_positions|crypto_news|ai_market_briefings|ai_news_briefings|algo_lab_positions|algo_lab_trades|push_subscriptions)\b/i.test(s)) {
    if (!/RETURNING/i.test(s) && !/ON\s+CONFLICT\s+DO\s+NOTHING/i.test(s)) {
      s += " RETURNING id";
    }
  }

  // 5. '?' 파라미터를 '$1', '$2', ... 로 변환
  let paramIdx = 1;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const char = s[i];
    if (char === "'" && (i === 0 || s[i - 1] !== "\\")) {
      inSingleQuote = !inSingleQuote;
      out += char;
    } else if (char === '"' && (i === 0 || s[i - 1] !== "\\")) {
      inDoubleQuote = !inDoubleQuote;
      out += char;
    } else if (char === "?" && !inSingleQuote && !inDoubleQuote) {
      out += `$${paramIdx++}`;
    } else {
      out += char;
    }
  }

  return out;
}

export class PgDatabase {
  constructor(config = pgConfig) {
    this.pool = new Pool(config);
    this.pool.on("error", (err) => {
      console.error("[PostgreSQL] Unexpected pool client error:", err.message);
    });
  }

  async query(sql, params = []) {
    const finalSql = translateSql(sql);
    const flatParams = Array.isArray(params[0]) && params.length === 1 ? params[0] : params;
    return await this.pool.query(finalSql, flatParams);
  }

  async get(sql, ...params) {
    const res = await this.query(sql, params);
    return res.rows[0] || null;
  }

  async all(sql, ...params) {
    const res = await this.query(sql, params);
    return res.rows || [];
  }

  async run(sql, ...params) {
    const res = await this.query(sql, params);
    return {
      changes: res.rowCount || 0,
      lastInsertRowid: res.rows?.[0]?.id ? Number(res.rows[0].id) : 0,
    };
  }

  async exec(sql) {
    // 다중 쿼리 실행
    return await this.pool.query(sql);
  }

  prepare(sql) {
    return {
      get: async (...params) => await this.get(sql, ...params),
      all: async (...params) => await this.all(sql, ...params),
      run: async (...params) => await this.run(sql, ...params),
    };
  }

  async close() {
    await this.pool.end();
  }
}

export const pgDb = new PgDatabase();
