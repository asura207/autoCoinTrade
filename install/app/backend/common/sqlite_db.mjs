import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const DB_PATH = path.join(DATA_DIR, "auto_coin_trade.db");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * SQLite 호환을 위한 SQL 번역 함수
 */
export function translateSqlite(sql) {
  let s = sql.trim();

  // 1. ILIKE -> LIKE
  s = s.replace(/\bILIKE\b/gi, "LIKE");

  // 2. BIGSERIAL / SERIAL -> INTEGER PRIMARY KEY AUTOINCREMENT
  s = s.replace(/\bBIGSERIAL\s+PRIMARY\s+KEY\b/gi, "INTEGER PRIMARY KEY AUTOINCREMENT");
  s = s.replace(/\bSERIAL\s+PRIMARY\s+KEY\b/gi, "INTEGER PRIMARY KEY AUTOINCREMENT");

  // 3. DOUBLE PRECISION -> REAL
  s = s.replace(/\bDOUBLE\s+PRECISION\b/gi, "REAL");

  // 4. NOW() -> CURRENT_TIMESTAMP
  s = s.replace(/\bNOW\(\)/gi, "CURRENT_TIMESTAMP");

  // 5. Postgres ::type 캐스팅 제거 (e.g. ::numeric, ::text, ::bigint)
  s = s.replace(/::[a-zA-Z0-9_]+/g, "");

  // 6. to_char(col, 'fmt') -> col
  s = s.replace(/to_char\(([^,]+),\s*'[^']*'\)/gi, "$1");

  // 7. Postgres $1, $2 파라미터를 ? 로 변환
  s = s.replace(/\$(\d+)/g, "?");

  return s;
}

export class SqliteDatabase {
  constructor(dbFilePath = process.env.AUTOCOIN_DB_PATH || DB_PATH) {
    this.dbPath = dbFilePath;
    this.rawDb = null;
    this.engine = null; // 'better-sqlite3' | 'node:sqlite'
    const dir = path.dirname(this.dbPath);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.init();
  }

  init() {
    // 1. Try better-sqlite3 first
    try {
      const Database = require("better-sqlite3");
      this.rawDb = new Database(this.dbPath, { timeout: 5000 });
      this.rawDb.pragma("journal_mode = WAL");
      this.rawDb.pragma("busy_timeout = 5000");
      this.rawDb.pragma("synchronous = NORMAL");
      this.engine = "better-sqlite3";
      return;
    } catch (e1) {
      // ignore
    }

    // 2. Node.js built-in node:sqlite fallback
    try {
      const { DatabaseSync } = require("node:sqlite");
      this.rawDb = new DatabaseSync(this.dbPath);
      this.rawDb.exec("PRAGMA journal_mode = WAL;");
      this.rawDb.exec("PRAGMA busy_timeout = 5000;");
      this.rawDb.exec("PRAGMA synchronous = NORMAL;");
      this.engine = "node:sqlite";
    } catch (err) {
      console.error("[SqliteDatabase] Failed to initialize SQLite engine:", err.message);
      throw err;
    }
  }

  tableExists(tableName) {
    try {
      const row = this.rawDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(tableName);
      return Boolean(row);
    } catch {
      return false;
    }
  }

  getTableColumns(tableName) {
    try {
      const rows = this.rawDb.prepare(`PRAGMA table_info(${tableName})`).all();
      return rows.map((r) => r.name);
    } catch {
      return [];
    }
  }

  async exec(sql) {
    if (!this.rawDb) this.init();

    // ALTER TABLE <table> ADD COLUMN IF NOT EXISTS <col> <def> 지원:
    // 동일 exec 블록 내 선행 CREATE TABLE 실행 이후 테이블/컬럼 존재 여부를 순차 평가하여 신규/구형 DB 모두 안전 보장
    const alterRegex = /ALTER\s+TABLE\s+([a-zA-Z0-9_]+)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+([a-zA-Z0-9_]+)\s+([^;]+);?/gi;
    let match;
    let lastIndex = 0;
    let result;
    while ((match = alterRegex.exec(sql)) !== null) {
      const prefixChunk = sql.slice(lastIndex, match.index);
      if (prefixChunk.trim()) {
        result = this.rawDb.exec(translateSqlite(prefixChunk));
      }
      const table = match[1];
      const column = match[2];
      const colDef = match[3];
      if (this.tableExists(table)) {
        const existingCols = this.getTableColumns(table);
        if (!existingCols.includes(column)) {
          result = this.rawDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${translateSqlite(colDef)};`);
        }
      }
      lastIndex = alterRegex.lastIndex;
    }

    const tailChunk = sql.slice(lastIndex);
    if (tailChunk.trim()) {
      result = this.rawDb.exec(translateSqlite(tailChunk));
    }
    return result;
  }

  prepare(sql) {
    if (!this.rawDb) this.init();

    // information_schema.columns 쿼리 인터셉트
    const infoMatch = sql.match(/SELECT\s+column_name\s+AS\s+name\s+FROM\s+information_schema\.columns\s+WHERE\s+table_name\s*=\s*'([^']+)'/i);
    if (infoMatch) {
      const tbl = infoMatch[1];
      return {
        all: async () => {
          const cols = this.getTableColumns(tbl);
          return cols.map((c) => ({ name: c }));
        },
        get: async () => null,
        run: async () => ({ changes: 0, lastInsertRowid: 0 }),
      };
    }

    const cleanSql = translateSqlite(sql);
    const stmt = this.rawDb.prepare(cleanSql);

    const flatten = (args) => (Array.isArray(args[0]) && args.length === 1 ? args[0] : args);

    return {
      get: async (...args) => {
        const params = flatten(args);
        return stmt.get(...params) || null;
      },
      all: async (...args) => {
        const params = flatten(args);
        return stmt.all(...params) || [];
      },
      run: async (...args) => {
        const params = flatten(args);
        const res = stmt.run(...params);
        return {
          changes: res?.changes || 0,
          lastInsertRowid: res?.lastInsertRowid !== undefined ? Number(res.lastInsertRowid) : 0,
        };
      },
    };
  }

  async get(sql, ...params) {
    return await this.prepare(sql).get(...params);
  }

  async all(sql, ...params) {
    return await this.prepare(sql).all(...params);
  }

  async run(sql, ...params) {
    return await this.prepare(sql).run(...params);
  }

  async close() {
    if (this.rawDb) {
      if (typeof this.rawDb.close === "function") {
        this.rawDb.close();
      }
      this.rawDb = null;
    }
  }
}

// 싱글톤 인스턴스 (lazy initialized; AUTOCOIN_DB_PATH 변경 시 자동 재바인딩)
let _sqliteInstance = null;
export function getSqliteDb() {
  const desiredPath = process.env.AUTOCOIN_DB_PATH || DB_PATH;
  if (!_sqliteInstance || _sqliteInstance.dbPath !== desiredPath) {
    if (_sqliteInstance) {
      try {
        _sqliteInstance.rawDb?.close?.();
      } catch {}
    }
    _sqliteInstance = new SqliteDatabase(desiredPath);
  }
  return _sqliteInstance;
}

export const sqliteDb = {
  get: async (sql, ...params) => getSqliteDb().get(sql, ...params),
  all: async (sql, ...params) => getSqliteDb().all(sql, ...params),
  run: async (sql, ...params) => getSqliteDb().run(sql, ...params),
  exec: async (sql) => getSqliteDb().exec(sql),
  prepare: (sql) => getSqliteDb().prepare(sql),
  close: async () => {
    if (_sqliteInstance) {
      await _sqliteInstance.close();
      _sqliteInstance = null;
    }
  },
};
