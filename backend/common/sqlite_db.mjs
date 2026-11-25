/**
 * [Antigravity-Doc]
 * 파일 역할: 로컬 SQLite 데이터베이스 래퍼 및 PostgreSQL -> SQLite 문법 자동 번역 어댑터 모듈
 * 아키텍처:
 * - `better-sqlite3` 네이티브 드라이버를 최우선으로 사용하고, 설치되지 않았거나 로드 실패 시 Node.js 내장 `node:sqlite`(`DatabaseSync`)로 자동 폴백합니다.
 * - `PgDatabase`와 동일한 비동기 인터페이스(`get`, `all`, `run`, `exec`, `prepare`, `close`)를 제공하여 상위 서비스가 DB 엔진 종류와 무관하게 동작하도록 추상화합니다.
 * - PostgreSQL 스타일 DDL/DML(`ILIKE`, `BIGSERIAL`, `NOW()`, `::type`, `$1`, `ADD COLUMN IF NOT EXISTS`, `information_schema.columns`)을 SQLite 호환 형태로 변환·인터셉트합니다.
 * 주요 의존성: `node:fs`, `node:path`, `node:url`, `node:module`, `better-sqlite3`(선택) 또는 `node:sqlite`(폴백)
 * 수정 시 주의사항:
 * - `AUTOCOIN_DB_PATH` 또는 `DB_PATH` 환경 변수가 런타임 중 변경되면 `getSqliteDb()`가 기존 연결을 닫고 새 DB 경로로 자동 재바인딩합니다(테스트 격리 핵심 동작).
 * - WAL 모드와 `busy_timeout = 5000`은 다중 프로세스 동시 접근 시 `SQLITE_BUSY` 오류를 줄이기 위한 필수 설정입니다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// [Antigravity-Doc] ESM 환경에서 CJS 네이티브 모듈(better-sqlite3) 및 내장 node:sqlite 동적 로드를 위한 require 생성 및 기본 경로 상수
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const DB_PATH = path.join(DATA_DIR, "auto_coin_trade.db");

// [Antigravity-Doc] 기본 데이터 디렉터리(`data/`)가 없으면 모듈 로드 시 자동 생성
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * [Antigravity-Doc]
 * 역할: PostgreSQL 문법이 혼재된 SQL 문자열을 SQLite 실행 가능 문법으로 치환합니다.
 * 매개변수:
 * - sql {string}: 원본 SQL 쿼리
 * 반환값: {string} SQLite 호환 SQL 문자열
 * 부수효과/예외 처리: `ILIKE`, `SERIAL/BIGSERIAL`, `DOUBLE PRECISION`, `NOW()`, `::type`, `to_char()`, `$1..$N` 파라미터를 순차 변환합니다.
 */
/**
 * SQLite 호환을 위한 SQL 번역 함수
 */
export function translateSqlite(sql) {
  let s = sql.trim();

  // [Antigravity-Doc] PostgreSQL 대소문자 무시 검색 ILIKE를 SQLite LIKE로 치환
  // 1. ILIKE -> LIKE
  s = s.replace(/\bILIKE\b/gi, "LIKE");

  // [Antigravity-Doc] PostgreSQL 자동 증가 기본키 타입을 SQLite AUTOINCREMENT 구문으로 치환
  // 2. BIGSERIAL / SERIAL -> INTEGER PRIMARY KEY AUTOINCREMENT
  s = s.replace(/\bBIGSERIAL\s+PRIMARY\s+KEY\b/gi, "INTEGER PRIMARY KEY AUTOINCREMENT");
  s = s.replace(/\bSERIAL\s+PRIMARY\s+KEY\b/gi, "INTEGER PRIMARY KEY AUTOINCREMENT");

  // [Antigravity-Doc] 부동소수점 타입명 매핑
  // 3. DOUBLE PRECISION -> REAL
  s = s.replace(/\bDOUBLE\s+PRECISION\b/gi, "REAL");

  // [Antigravity-Doc] 현재 시각 함수 매핑
  // 4. NOW() -> CURRENT_TIMESTAMP
  s = s.replace(/\bNOW\(\)/gi, "CURRENT_TIMESTAMP");

  // [Antigravity-Doc] PostgreSQL 전용 타입 캐스팅 연산자(::numeric 등) 제거
  // 5. Postgres ::type 캐스팅 제거 (e.g. ::numeric, ::text, ::bigint)
  s = s.replace(/::[a-zA-Z0-9_]+/g, "");

  // [Antigravity-Doc] PostgreSQL 날짜 포맷 함수 to_char(col, 'fmt')를 컬럼 자체로 단순화
  // 6. to_char(col, 'fmt') -> col
  s = s.replace(/to_char\(([^,]+),\s*'[^']*'\)/gi, "$1");

  // [Antigravity-Doc] 위치 파라미터($1, $2...)를 SQLite '?' 플레이스홀더로 변환
  // 7. Postgres $1, $2 파라미터를 ? 로 변환
  s = s.replace(/\$(\d+)/g, "?");

  return s;
}

/**
 * [Antigravity-Doc]
 * 역할: 환경 변수(`AUTOCOIN_DB_PATH` > `DB_PATH`) 또는 기본 경로(`data/auto_coin_trade.db`)를 해석해 절대 경로를 반환합니다.
 * 매개변수: 없음
 * 반환값: {string} SQLite DB 파일 절대 경로
 */
function resolveDefaultDbPath() {
  const custom = process.env.AUTOCOIN_DB_PATH || process.env.DB_PATH;
  if (!custom || !String(custom).trim()) return DB_PATH;
  const trimmed = String(custom).trim();
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(ROOT_DIR, trimmed);
}

/**
 * [Antigravity-Doc]
 * 역할: SQLite 연결 생명주기 및 `PgDatabase` 호환 비동기 쿼리 인터페이스를 제공하는 클래스
 * 부수효과/예외 처리: 생성 시 상위 디렉터리를 자동 생성하고 WAL 저널 모드로 DB를 오픈합니다.
 */
export class SqliteDatabase {
  /**
   * [Antigravity-Doc]
   * 역할: 지정된 파일 경로로 SQLite 데이터베이스를 초기화합니다.
   * 매개변수:
   * - dbFilePath {string} [resolveDefaultDbPath()]: SQLite DB 파일 경로
   */
  constructor(dbFilePath = resolveDefaultDbPath()) {
    this.dbPath = dbFilePath;
    this.rawDb = null;
    this.engine = null; // 'better-sqlite3' | 'node:sqlite'
    // [Antigravity-Doc] DB 파일이 위치할 상위 폴더가 없으면 재귀 생성
    const dir = path.dirname(this.dbPath);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.init();
  }

  /**
   * [Antigravity-Doc]
   * 역할: `better-sqlite3` -> `node:sqlite` 순으로 사용 가능한 SQLite 엔진을 초기화하고 WAL·타임아웃 PRAGMA를 적용합니다.
   * 매개변수: 없음
   * 반환값: 없음 (void)
   * 부수효과/예외 처리: 두 엔진 모두 로드에 실패하면 에러 로그를 출력하고 예외를 상위로 전파합니다.
   */
  init() {
    // [Antigravity-Doc] 1순위: 성능이 우수한 better-sqlite3 네이티브 바인딩 시도
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

    // [Antigravity-Doc] 2순위: Node.js 22+ 내장 node:sqlite(DatabaseSync) 폴백
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

  /**
   * [Antigravity-Doc]
   * 역할: `sqlite_master`를 조회해 지정 테이블이 존재하는지 확인합니다.
   * 매개변수:
   * - tableName {string}: 확인할 테이블명
   * 반환값: {boolean} 테이블 존재 여부 (오류 시 `false`)
   */
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

  /**
   * [Antigravity-Doc]
   * 역할: `PRAGMA table_info`를 통해 특정 테이블의 컬럼명 목록을 조회합니다.
   * 매개변수:
   * - tableName {string}: 조회할 테이블명
   * 반환값: {string[]} 컬럼명 배열 (오류 시 빈 배열)
   */
  getTableColumns(tableName) {
    try {
      const rows = this.rawDb.prepare(`PRAGMA table_info(${tableName})`).all();
      return rows.map((r) => r.name);
    } catch {
      return [];
    }
  }

  /**
   * [Antigravity-Doc]
   * 역할: 다중 SQL 스크립트(DDL/마이그레이션)를 SQLite 문법으로 번역해 순차 실행합니다.
   * 매개변수:
   * - sql {string}: 실행할 SQL 스크립트
   * 반환값: {Promise<any>} 마지막 `rawDb.exec` 반환값
   * 부수효과/예외 처리: SQLite가 기본 지원하지 않는 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 구문을 파싱해 테이블·컬럼 존재 여부를 사전 검사한 뒤 안전하게 실행합니다.
   */
  async exec(sql) {
    if (!this.rawDb) this.init();

    // [Antigravity-Doc] ADD COLUMN IF NOT EXISTS 구문을 기준으로 앞선 청크를 먼저 실행한 뒤 컬럼 부재 시에만 ALTER TABLE 수행
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

    // [Antigravity-Doc] 마지막 ALTER 구문 이후 남은 꼬리 SQL 청크 실행
    const tailChunk = sql.slice(lastIndex);
    if (tailChunk.trim()) {
      result = this.rawDb.exec(translateSqlite(tailChunk));
    }
    return result;
  }

  /**
   * [Antigravity-Doc]
   * 역할: SQL을 SQLite 문법으로 번역해 준비된 스테이트먼트를 생성하고, `PgDatabase` 호환 비동기 실행 메서드를 반환합니다.
   * 매개변수:
   * - sql {string}: 실행할 SQL 쿼리
   * 반환값: {{get: Function, all: Function, run: Function}} 비동기 실행 메서드 객체
   * 부수효과/예외 처리: PostgreSQL의 `information_schema.columns` 스키마 조회 쿼리가 들어오면 `PRAGMA table_info` 결과로 가로채 반환합니다.
   */
  prepare(sql) {
    if (!this.rawDb) this.init();

    // [Antigravity-Doc] PostgreSQL 스키마 점검용 information_schema.columns 조회를 SQLite PRAGMA로 에뮬레이션
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

    // [Antigravity-Doc] 일반 SQL 번역 및 네이티브 prepared statement 생성
    const cleanSql = translateSqlite(sql);
    const stmt = this.rawDb.prepare(cleanSql);

    // [Antigravity-Doc] 배열로 한 번 감싼 파라미터(`[[a, b]]`) 전달 호환을 위한 평탄화 헬퍼
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

  /**
   * [Antigravity-Doc]
   * 역할: 단건 조회 SQL을 실행하고 첫 행 또는 `null`을 반환합니다.
   * 매개변수:
   * - sql {string}: 조회 SQL
   * - ...params {any[]}: 바인딩 인자
   * 반환값: {Promise<object|null>}
   */
  async get(sql, ...params) {
    return await this.prepare(sql).get(...params);
  }

  /**
   * [Antigravity-Doc]
   * 역할: 다건 조회 SQL을 실행하고 결과 행 배열을 반환합니다.
   * 매개변수:
   * - sql {string}: 조회 SQL
   * - ...params {any[]}: 바인딩 인자
   * 반환값: {Promise<object[]>}
   */
  async all(sql, ...params) {
    return await this.prepare(sql).all(...params);
  }

  /**
   * [Antigravity-Doc]
   * 역할: 쓰기 SQL을 실행하고 `{ changes, lastInsertRowid }`를 반환합니다.
   * 매개변수:
   * - sql {string}: 쓰기 SQL
   * - ...params {any[]}: 바인딩 인자
   * 반환값: {Promise<{changes: number, lastInsertRowid: number}>}
   */
  async run(sql, ...params) {
    return await this.prepare(sql).run(...params);
  }

  /**
   * [Antigravity-Doc]
   * 역할: 열려 있는 SQLite 핸들을 안전하게 닫고 참조를 해제합니다.
   * 매개변수: 없음
   * 반환값: {Promise<void>}
   */
  async close() {
    if (this.rawDb) {
      if (typeof this.rawDb.close === "function") {
        this.rawDb.close();
      }
      this.rawDb = null;
    }
  }
}

// [Antigravity-Doc] 지연 초기화(Lazy Singleton) 보관 변수
// 싱글톤 인스턴스 (lazy initialized; AUTOCOIN_DB_PATH 변경 시 자동 재바인딩)
let _sqliteInstance = null;

/**
 * [Antigravity-Doc]
 * 역할: 현재 환경 변수 기준의 SQLite 싱글톤 인스턴스를 반환합니다. DB 경로가 변경되었으면 기존 연결을 닫고 새 인스턴스로 교체합니다.
 * 매개변수: 없음
 * 반환값: {SqliteDatabase} 활성 SQLite 래퍼 인스턴스
 */
export function getSqliteDb() {
  const desiredPath = resolveDefaultDbPath();
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

// [Antigravity-Doc] 지연 바인딩 프록시 객체: 호출 시점마다 getSqliteDb()를 통해 최신 DB 인스턴스로 위임
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