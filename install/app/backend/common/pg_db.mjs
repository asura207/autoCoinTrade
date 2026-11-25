/**
 * [Antigravity-Doc]
 * 파일 역할: PostgreSQL 데이터베이스 연결 풀(Pool) 관리 및 SQLite 호환 SQL 자동 번역 어댑터 모듈
 * 아키텍처:
 * - 프로젝트 루트의 `.env` 파일을 직접 로드하여 `LOCATION` (`local` | `outer`) 환경에 따라 PostgreSQL 접속 정보를 분기 결정합니다.
 * - 기존 SQLite 문법(`PRAGMA`, `INSERT OR REPLACE`, `INSERT OR IGNORE`, `?` 바인딩 등)으로 작성된 쿼리를 `translateSql`로 실시간 변환하여 PostgreSQL에서 무중단 실행할 수 있도록 호환 계층을 제공합니다.
 * - `PgDatabase` 클래스는 `better-sqlite3` 스타일(`prepare`, `get`, `all`, `run`, `exec`)과 `pg` 스타일(`query`)을 모두 지원하며, 모듈 하단에서 싱글톤 `pgDb`를 export합니다.
 * 주요 의존성: `node:fs`, `node:path`, `node:url`, `pg`
 * 수정 시 주의사항:
 * - `translateSql`의 `INSERT OR IGNORE` 충돌 키 매핑이나 `RETURNING id` 대상 테이블 목록에 새 테이블을 추가할 때는 스키마의 UNIQUE/PK 컬럼과 정확히 일치시켜야 합니다.
 * - 문자열 리터럴 내부의 `?`를 치환하지 않도록 따옴표 상태 머신을 유지해야 합니다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// [Antigravity-Doc] pg 드라이버의 커넥션 풀 생성자 및 ESM 환경에서의 현재 파일/루트/.env 절대 경로 상수
const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");
const ENV_PATH = path.join(ROOT_DIR, ".env");

/**
 * [Antigravity-Doc]
 * 역할: 프로젝트 루트의 `.env` 파일을 동기적으로 읽어 `process.env`에 주입합니다.
 * 매개변수: 없음
 * 반환값: 없음 (void)
 * 부수효과/예외 처리: 이미 `process.env`에 비어 있지 않은 값이 설정된 키는 덮어쓰지 않아 실행 시점 환경 변수 우선순위를 보장합니다. `.env` 파일이 없으면 조용히 건너뜁니다.
 */
function loadEnv() {
  // [Antigravity-Doc] .env 파일 존재 시 줄 단위로 파싱하며 빈 줄 및 '#' 주석 줄은 무시
  if (fs.existsSync(ENV_PATH)) {
    const raw = fs.readFileSync(ENV_PATH, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      // [Antigravity-Doc] 첫 번째 '=' 기준으로 키/값을 분리하여 값 내부에 '='가 포함되어도 보존
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

// [Antigravity-Doc] 모듈 로드 시 즉시 .env를 반영해 아래 pgConfig 구성에 환경 변수가 사용되도록 초기화
loadEnv();

// [Antigravity-Doc] 배포 위치 구분값 (기본값 'local'; 'outer'일 경우 외부 DB 접속 환경 변수 우선 사용)
const location = (process.env.LOCATION || "local").trim().toLowerCase();
const isOuter = location === "outer";

// [Antigravity-Doc] PostgreSQL Pool 접속 설정 (최대 연결 20개, 유휴 타임아웃 30초, 연결 타임아웃 5초)
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
 * [Antigravity-Doc]
 * 역할: SQLite 문법으로 작성된 SQL 문자열을 PostgreSQL 호환 문법으로 변환합니다.
 * 매개변수:
 * - sql {string}: 원본 SQL 쿼리 문자열
 * 반환값: {string} PostgreSQL에서 실행 가능하도록 변환된 SQL 문자열
 * 부수효과/예외 처리: 순수 문자열 변환 함수이며, PRAGMA 무시/치환 -> UPSERT(ON CONFLICT) 변환 -> RETURNING id 부착 -> 위치 파라미터($1..) 변환 순으로 처리합니다.
 */
/**
 * SQLite 호환 SQL 문법을 PostgreSQL 문법으로 번역합니다.
 */
export function translateSql(sql) {
  let s = sql.trim();

  // [Antigravity-Doc] SQLite 전용 PRAGMA 설정 구문은 PostgreSQL에서 불필요하므로 무해한 'SELECT 1'로 치환
  // 1. PRAGMA 무시 또는 변환
  if (/^PRAGMA\s+journal_mode/i.test(s) || /^PRAGMA\s+synchronous/i.test(s) || /^PRAGMA\s+busy_timeout/i.test(s) || /^PRAGMA\s+foreign_keys/i.test(s)) {
    return "SELECT 1";
  }

  // [Antigravity-Doc] PRAGMA table_info(table) 호출을 PostgreSQL information_schema.columns 조회로 변환
  const pragmaTableInfo = s.match(/^PRAGMA\s+table_info\(([^)]+)\)/i);
  if (pragmaTableInfo) {
    const table = pragmaTableInfo[1].replace(/['"`]/g, "").trim();
    return `SELECT column_name AS name FROM information_schema.columns WHERE table_name = '${table}'`;
  }

  // [Antigravity-Doc] system_settings 테이블의 INSERT OR REPLACE를 key 충돌 시 UPDATE하는 UPSERT 구문으로 변환
  // 2. INSERT OR REPLACE INTO system_settings
  if (/INSERT\s+OR\s+REPLACE\s+INTO\s+system_settings/i.test(s)) {
    s = s.replace(/INSERT\s+OR\s+REPLACE\s+INTO\s+system_settings/i, "INSERT INTO system_settings");
    if (!/ON\s+CONFLICT/i.test(s)) {
      s += " ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at";
    }
  }

  // [Antigravity-Doc] INSERT OR IGNORE 구문을 테이블별 고유 제약 컬럼에 맞는 ON CONFLICT (...) DO NOTHING으로 변환
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

  // [Antigravity-Doc] run() 반환값의 lastInsertRowid 호환을 위해 시퀀스 id가 있는 주요 테이블 INSERT에 RETURNING id 자동 부착
  // 4. INSERT INTO 시 RETURNING id 자동 부착 (이미 RETURNING이 없는 경우)
  if (/^INSERT\s+INTO\s+(paper_trades|paper_bot_positions|trades|bot_positions|crypto_news|ai_market_briefings|ai_news_briefings|algo_lab_positions|algo_lab_trades|push_subscriptions)\b/i.test(s)) {
    if (!/RETURNING/i.test(s) && !/ON\s+CONFLICT\s+DO\s+NOTHING/i.test(s)) {
      s += " RETURNING id";
    }
  }

  // [Antigravity-Doc] 문자열 리터럴('', "") 외곽의 SQLite 플레이스홀더 '?'만 순차적으로 PostgreSQL '$1, $2...'로 치환
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

/**
 * [Antigravity-Doc]
 * 역할: PostgreSQL 커넥션 풀을 감싸 SQLite 호환 비동기 인터페이스(`get`, `all`, `run`, `prepare`, `exec`)를 제공하는 데이터베이스 래퍼 클래스
 * 부수효과/예외 처리: 유휴 클라이언트 에러 이벤트에 리스너를 등록해 프로세스 비정상 종료(Unhandled Error)를 방지합니다.
 */
export class PgDatabase {
  /**
   * [Antigravity-Doc]
   * 역할: 지정된 설정으로 `pg.Pool` 인스턴스를 초기화하고 풀 에러 핸들러를 바인딩합니다.
   * 매개변수:
   * - config {object} [pgConfig]: PostgreSQL 연결 풀 옵션 객체
   */
  constructor(config = pgConfig) {
    // [Antigravity-Doc] 커넥션 풀 생성 및 예기치 못한 백그라운드 연결 끊김 에러 로깅 등록
    this.pool = new Pool(config);
    this.pool.on("error", (err) => {
      console.error("[PostgreSQL] Unexpected pool client error:", err.message);
    });
  }

  /**
   * [Antigravity-Doc]
   * 역할: SQL을 PostgreSQL 문법으로 번역한 뒤 커넥션 풀에서 쿼리를 실행합니다.
   * 매개변수:
   * - sql {string}: 실행할 SQL 쿼리
   * - params {Array} [[]]: 바인딩 파라미터 배열 (단일 중첩 배열 `[[a, b]]` 전달 시 자동 평탄화)
   * 반환값: {Promise<import('pg').QueryResult>} pg 드라이버 원본 결과 객체
   */
  async query(sql, params = []) {
    const finalSql = translateSql(sql);
    // [Antigravity-Doc] 호출부가 배열 인자를 한 번 감싸 전달한 경우(예: query(sql, [[...]]))를 대비해 1단계 평탄화
    const flatParams = Array.isArray(params[0]) && params.length === 1 ? params[0] : params;
    return await this.pool.query(finalSql, flatParams);
  }

  /**
   * [Antigravity-Doc]
   * 역할: 쿼리를 실행하고 첫 번째 결과 행만 반환합니다.
   * 매개변수:
   * - sql {string}: 조회 SQL
   * - ...params {any[]}: 바인딩 파라미터 가변 인자
   * 반환값: {Promise<object|null>} 첫 번째 행 객체 또는 결과 없을 시 `null`
   */
  async get(sql, ...params) {
    const res = await this.query(sql, params);
    return res.rows[0] || null;
  }

  /**
   * [Antigravity-Doc]
   * 역할: 쿼리를 실행하고 모든 결과 행 배열을 반환합니다.
   * 매개변수:
   * - sql {string}: 조회 SQL
   * - ...params {any[]}: 바인딩 파라미터 가변 인자
   * 반환값: {Promise<object[]>} 결과 행 배열 (없으면 빈 배열)
   */
  async all(sql, ...params) {
    const res = await this.query(sql, params);
    return res.rows || [];
  }

  /**
   * [Antigravity-Doc]
   * 역할: INSERT/UPDATE/DELETE 등 쓰기 쿼리를 실행하고 SQLite `run()` 호환 메타데이터를 반환합니다.
   * 매개변수:
   * - sql {string}: 쓰기 SQL
   * - ...params {any[]}: 바인딩 파라미터 가변 인자
   * 반환값: {Promise<{changes: number, lastInsertRowid: number}>} 영향받은 행 수와 삽입된 id(없으면 0)
   */
  async run(sql, ...params) {
    const res = await this.query(sql, params);
    return {
      changes: res.rowCount || 0,
      lastInsertRowid: res.rows?.[0]?.id ? Number(res.rows[0].id) : 0,
    };
  }

  /**
   * [Antigravity-Doc]
   * 역할: 번역 없이 원본 다중 SQL 스크립트(DDL/마이그레이션 등)를 직접 실행합니다.
   * 매개변수:
   * - sql {string}: 세미콜론으로 구분된 원본 PostgreSQL 스크립트
   * 반환값: {Promise<import('pg').QueryResult>} 실행 결과
   */
  async exec(sql) {
    // 다중 쿼리 실행
    return await this.pool.query(sql);
  }

  /**
   * [Antigravity-Doc]
   * 역할: `better-sqlite3`의 `db.prepare(sql)` 패턴을 흉내 내는 경량 스테이트먼트 어댑터를 반환합니다.
   * 매개변수:
   * - sql {string}: 준비할 SQL 문자열
   * 반환값: {{get: Function, all: Function, run: Function}} 비동기 실행 메서드 묶음 객체
   */
  prepare(sql) {
    return {
      get: async (...params) => await this.get(sql, ...params),
      all: async (...params) => await this.all(sql, ...params),
      run: async (...params) => await this.run(sql, ...params),
    };
  }

  /**
   * [Antigravity-Doc]
   * 역할: 커넥션 풀의 모든 유휴/활성 연결을 정상 종료합니다.
   * 매개변수: 없음
   * 반환값: {Promise<void>}
   */
  async close() {
    await this.pool.end();
  }
}

// [Antigravity-Doc] 애플리케이션 전역에서 공유하는 기본 PostgreSQL 데이터베이스 싱글톤 인스턴스
export const pgDb = new PgDatabase();