/**
 * [Antigravity-Doc] backend/common/pg_sync.mjs
 *
 * [파일 역할 및 아키텍처]
 * - 로컬 SQLite 원장(Single Source of Truth)의 최신 상태를 PostgreSQL 서버로 단방향 주기 동기화(UPSERT)하는 동기화 매니저.
 * - `LOCATION` 환경변수(`local` vs `outer`)에 따라 로컬 PG 또는 외부 PG 접속 정보를 자동 분기하며,
 *   `PG_SYNC_ENABLED=false` 또는 `DB_MODE=sqlite` 설정 시 SQLite 단독 모드로 안전하게 동작한다.
 * - 동기화 대상 테이블(12개 그룹):
 *   1) `system_settings`, 1-1) `market_regime_filter`
 *   2) `bots`, 3) `trades`, 4) `bot_positions`, 5) `crypto_news`
 *   6) `algo_lab_models` / `algo_lab_positions` / `algo_lab_trades`
 *   7) `paper_trades` / `paper_bot_positions`, 8) `monthly_asset_snapshots`
 *   9~10) `ai_market_briefings` / `ai_news_briefings` (시퀀스 `setval` 재정렬 포함)
 *   11) `auto_rotation_config` / `auto_rotation_history` / `drain_handoff_logs` / `capital_restoration_logs`
 *   12) `live_executor_lease` / `live_order_intents` (5중 실전 가드레일 리스·주문 의도 원장)
 *
 * [주요 의존성]
 * - `pg` (`Pool`): PostgreSQL 커넥션 풀 관리 (최대 5커넥션, 타임아웃 4초).
 * - `.env` 파일: `AUTOCOIN_ENV_PATH` 또는 프로젝트 루트 `.env`에서 접속 정보 보완 로드.
 *
 * [수정 시 주의사항]
 * - 신규 테이블/컬럼을 SQLite에 추가할 경우 `syncAll()` 내 `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
 *   및 `INSERT ... ON CONFLICT DO UPDATE` 쿼리를 함께 갱신해야 스키마 불일치로 인한 동기화 누락을 방지할 수 있다.
 * - 테이블별 `ALTER TABLE`은 독립 `try/catch`로 분리되어 있으므로 한 테이블의 미존재가 전체 동기화 트랜잭션을 롤백하지 않도록 유지할 것.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// [Antigravity-Doc] ESM 환경에서 프로젝트 루트 및 .env 경로 산출 (AUTOCOIN_ENV_PATH 환경변수 우선)
const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");
const ENV_PATH = process.env.AUTOCOIN_ENV_PATH ? path.resolve(process.env.AUTOCOIN_ENV_PATH) : path.join(ROOT_DIR, ".env");

// [Antigravity-Doc] 10대 알고리즘 봇 표준 ID 목록 및 구버전(v1) 봇 키 → 현행 봇 ID 매핑 별칭
const ALL_BOT_IDS = Array.from({ length: 10 }, (_, idx) => `bot_${String(idx + 1).padStart(2, "0")}`);
const LEGACY_BOT_OVERRIDE_ALIAS = {
  bot_vb: "bot_01",
  bot_momentum: "bot_03",
  bot_bb: "bot_05",
};
// [Antigravity-Doc] market_regime_filter 기본 봇 허용 맵 (bot_01~bot_10 전부 "ALLOW")
const DEFAULT_BOT_OVERRIDES = Object.fromEntries(ALL_BOT_IDS.map((id) => [id, "ALLOW"]));
const DEFAULT_BOT_OVERRIDES_JSON = JSON.stringify(DEFAULT_BOT_OVERRIDES);

/**
 * [Antigravity-Doc] 시황 필터(`market_regime_filter`)의 `bot_overrides_json`을 표준 10대 봇 스키마로 정규화
 * - 구버전 별칭(`bot_vb`, `bot_momentum`, `bot_bb`)이 존재하고 신버전 키가 없을 때 자동 승격한다.
 * - 허용값은 `"ALLOW"` 또는 `"BLOCK"`만 반영하며 그 외/누락 봇은 기본값 `"ALLOW"`로 채운다.
 * @param {string|object} rawValue - SQLite에서 읽은 JSON 문자열 또는 객체
 * @returns {string} 정규화된 10대 봇 허용/차단 JSON 문자열
 */
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

/**
 * [Antigravity-Doc] `.env` 파일을 직접 파싱하여 아직 `process.env`에 설정되지 않은 환경변수만 보완 로드
 * - 이미 외부 프로세스/systemd에서 주입된 환경변수는 덮어쓰지 않는다.
 */
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

/**
 * [Antigravity-Doc] SQLite → PostgreSQL 단방향 비동기 동기화 매니저 클래스
 * - `connect()`: 커넥션 풀 초기화 및 연결 상태 검증 (실패 시 SQLite 단독 모드로 우아하게 폴백)
 * - `syncAll(sqliteDb)`: 12개 테이블 그룹을 순차 UPSERT 동기화
 * - `startAutoSync(getSqliteDbFn, intervalMs)`: 주기적 백그라운드 동기화 타이머 시작
 * - `close()`: 타이머 정리 및 PG 커넥션 풀 종료
 */
export class PgSyncManager {
  /**
   * [Antigravity-Doc] `LOCATION` 환경변수(`local` | `outer`)에 따라 대상 PostgreSQL 접속 파라미터를 결정
   * @param {object} [config={}] - host, port, database, user, password, location 수동 오버라이드
   */
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

  /**
   * [Antigravity-Doc] PostgreSQL 커넥션 풀 생성 및 `SELECT NOW()` 헬스체크 수행
   * - `PG_SYNC_ENABLED=false` 또는 `DB_MODE=sqlite`면 접속을 생략하고 `false` 반환.
   * - 접속 실패 시 예외를 삼키고 경고를 출력한 뒤 SQLite 단독 모드로 계속 운영한다.
   * @returns {Promise<boolean>} PG 연결 성공 여부
   */
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

  /**
   * [Antigravity-Doc] 로컬 SQLite의 전체 운영/가상/AI/로테이션/가드레일 테이블을 PostgreSQL에 일괄 UPSERT 동기화
   * - 각 도메인 블록마다 `CREATE TABLE IF NOT EXISTS` 및 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`로
   *   스키마 자동 마이그레이션을 선행한 뒤, PK/UNIQUE 기준 `ON CONFLICT DO UPDATE`(로그 테이블은 `DO NOTHING`)로 멱등 반영한다.
   * - 연결 끊김(`ECONNREFUSED`, `Connection terminated`) 감지 시 `this.isConnected = false`로 전환해 반복 오류를 막는다.
   * @param {object} sqliteDb - better-sqlite3 호환 동기 SQLite DB 인스턴스
   */
  async syncAll(sqliteDb) {
    if (process.env.PG_SYNC_ENABLED === "false" || process.env.DB_MODE === "sqlite") return;
    if (!this.isConnected || !this.pool) return;

    try {
      // [Antigravity-Doc] 그룹 1: 시스템 전역 설정(system_settings) key 기준 UPSERT
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

      // [Antigravity-Doc] 그룹 1-1: AI 시황 필터(market_regime_filter, id=1) 스키마 보강 및 정규화된 bot_overrides 포함 UPSERT
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

      // [Antigravity-Doc] 그룹 2: 10대 봇 마스터(bots) — 실전/가상 자본, Drain 상태, 교체 대상 정보 포함 UPSERT
      // 2. bots (paper_trades ALTER와 분리해 신규 PG에서 테이블 미생성으로 인한 전체 트랜잭션 롤백 방지)
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
          ALTER TABLE bots ADD COLUMN IF NOT EXISTS target_capital_krw DOUBLE PRECISION DEFAULT 0;
          ALTER TABLE bots ADD COLUMN IF NOT EXISTS drain_status VARCHAR(32) DEFAULT 'NONE';
          ALTER TABLE bots ADD COLUMN IF NOT EXISTS replaced_by_bot_id VARCHAR(64) DEFAULT NULL;
          ALTER TABLE bots ADD COLUMN IF NOT EXISTS drain_started_at TEXT DEFAULT NULL;
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
             paper_is_running, paper_peak_equity, paper_mdd_pct, paper_status_msg,
             target_capital_krw, drain_status, replaced_by_bot_id, drain_started_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)
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
             paper_status_msg = EXCLUDED.paper_status_msg,
             target_capital_krw = EXCLUDED.target_capital_krw,
             drain_status = EXCLUDED.drain_status,
             replaced_by_bot_id = EXCLUDED.replaced_by_bot_id,
             drain_started_at = EXCLUDED.drain_started_at`,
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
            Number(b.paper_is_running ?? 1),
            Math.floor(Number(b.paper_peak_equity || 1000000)),
            Number(b.paper_mdd_pct || 0),
            b.paper_status_msg || "시그널 대기 중",
            Math.floor(Number(b.target_capital_krw || 0)),
            b.drain_status || "NONE",
            b.replaced_by_bot_id || null,
            b.drain_started_at || null
          ]
        );
      }

      // [Antigravity-Doc] 그룹 3: 실전 매매 원장(trades) — 매도 체결 및 손익 컬럼 중심으로 id 충돌 시 갱신
      // 3. trades
      try {
        await this.pool.query(`
          ALTER TABLE trades ADD COLUMN IF NOT EXISTS buy_reason TEXT;
          ALTER TABLE trades ADD COLUMN IF NOT EXISTS sell_reason TEXT;
          ALTER TABLE trades ADD COLUMN IF NOT EXISTS expected_price NUMERIC(20,8);
          ALTER TABLE trades ADD COLUMN IF NOT EXISTS slippage_bps NUMERIC(12,4);
          ALTER TABLE trades ADD COLUMN IF NOT EXISTS atr_sizing_mult NUMERIC(10,4);
        `);
      } catch {}
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

      // [Antigravity-Doc] 그룹 4: 실전 포지션 원장(bot_positions) — order_uuid UNIQUE 기준 UPSERT, buy_reason은 COALESCE로 기존 값 보존
      // 4. bot_positions (스키마 마이그레이션 + sell/메타/buy_reason 컬럼 포함 UPSERT)
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
          ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS buy_reason TEXT;
          ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS expected_price NUMERIC(20,8);
          ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS slippage_bps NUMERIC(12,4);
          ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS atr_sizing_mult NUMERIC(10,4);
          ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS closing_lock INTEGER NOT NULL DEFAULT 0;
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
             sell_order_uuid, sell_price, sell_amount, sell_fee, realized_pnl, pnl_pct, buy_reason
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
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
             pnl_pct = EXCLUDED.pnl_pct,
             buy_reason = COALESCE(EXCLUDED.buy_reason, bot_positions.buy_reason)`,
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
            p.pnl_pct !== null && p.pnl_pct !== undefined ? Number(p.pnl_pct) : null,
            p.buy_reason ?? null
          ]
        );
      }

      // [Antigravity-Doc] 그룹 5: 암호화폐 뉴스(crypto_news) — 최근 200건 link UNIQUE 기준 UPSERT
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

      // [Antigravity-Doc] 그룹 6: 레거시/병행 알고리즘 실험실 테이블(algo_lab_models/positions/trades) 동기화
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
              t.buy_date,
              t.sell_price !== null && t.sell_price !== undefined ? Number(t.sell_price) : null,
              t.sell_volume !== null && t.sell_volume !== undefined ? String(t.sell_volume) : null,
              t.sell_amount !== null && t.sell_amount !== undefined ? Math.floor(Number(t.sell_amount)) : null,
              t.sell_date,
              t.profit_krw !== null && t.profit_krw !== undefined ? Math.floor(Number(t.profit_krw)) : null,
              t.profit_pct !== null && t.profit_pct !== undefined ? Number(t.profit_pct) : null,
              t.reason || "", t.status || "HOLDING"
            ]
          );
        }
      } catch {}

      // [Antigravity-Doc] 그룹 7: 10대 봇 가상거래(Arena) 전용 원장(paper_trades, paper_bot_positions) 동기화
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
            closed_at TIMESTAMP,
            buy_reason TEXT
          );
          ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS buy_reason TEXT;
          ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS sell_reason TEXT;
          ALTER TABLE paper_bot_positions ADD COLUMN IF NOT EXISTS buy_reason TEXT;
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
               status, created_at, closed_at, buy_reason
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             ON CONFLICT (order_uuid) DO UPDATE SET
               volume = EXCLUDED.volume,
               avg_buy_price = EXCLUDED.avg_buy_price,
               buy_amount = EXCLUDED.buy_amount,
               buy_fee = EXCLUDED.buy_fee,
               status = EXCLUDED.status,
               closed_at = EXCLUDED.closed_at,
               buy_reason = COALESCE(EXCLUDED.buy_reason, paper_bot_positions.buy_reason)`,
            [
              p.id, p.bot_id, p.market, p.order_uuid, String(p.volume),
              Number(p.avg_buy_price), Math.floor(Number(p.buy_amount)),
              Number(p.buy_fee || 0), Number(p.trade_id),
              p.status || "OPEN", p.created_at, p.closed_at ?? null, p.buy_reason ?? null
            ]
          );
        }
      } catch {}

      // [Antigravity-Doc] 그룹 8: 월별 자산 스냅샷(monthly_asset_snapshots) — (year_month, mode) 복합 PK 기준 UPSERT
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

      // [Antigravity-Doc] 그룹 9~10: AI 시황/뉴스 브리핑(ai_market_briefings, ai_news_briefings) 최근 100건 동기화 + BIGSERIAL 시퀀스 setval 보정
      // 11. auto_rotation_config & auto_rotation_history
      try {
        await this.pool.query(`
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
        `);

        const marketBriefings = sqliteDb
          .prepare("SELECT * FROM ai_market_briefings ORDER BY id DESC LIMIT 100")
          .all();
        for (const b of marketBriefings) {
          await this.pool.query(
            `INSERT INTO ai_market_briefings (
               id, provider, model, btc_price, btc_daily_20ma, btc_4h_60ma, regime_status, briefing_text, created_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO UPDATE SET
               provider = EXCLUDED.provider,
               model = EXCLUDED.model,
               btc_price = EXCLUDED.btc_price,
               btc_daily_20ma = EXCLUDED.btc_daily_20ma,
               btc_4h_60ma = EXCLUDED.btc_4h_60ma,
               regime_status = EXCLUDED.regime_status,
               briefing_text = EXCLUDED.briefing_text,
               created_at = EXCLUDED.created_at`,
            [
              b.id,
              b.provider || "gemini",
              b.model || "gemini-1.5-flash",
              b.btc_price !== null && b.btc_price !== undefined ? Number(b.btc_price) : null,
              b.btc_daily_20ma !== null && b.btc_daily_20ma !== undefined ? Number(b.btc_daily_20ma) : null,
              b.btc_4h_60ma !== null && b.btc_4h_60ma !== undefined ? Number(b.btc_4h_60ma) : null,
              b.regime_status || null,
              b.briefing_text || "",
              b.created_at || "",
            ]
          );
        }
        if (marketBriefings.length > 0) {
          await this.pool.query(
            "SELECT setval(pg_get_serial_sequence('ai_market_briefings', 'id'), COALESCE((SELECT MAX(id) FROM ai_market_briefings), 1))"
          );
        }

        const newsBriefings = sqliteDb
          .prepare("SELECT * FROM ai_news_briefings ORDER BY id DESC LIMIT 100")
          .all();
        for (const n of newsBriefings) {
          await this.pool.query(
            `INSERT INTO ai_news_briefings (
               id, provider, model, news_count, bullish_count, bearish_count, neutral_count, briefing_text, created_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO UPDATE SET
               provider = EXCLUDED.provider,
               model = EXCLUDED.model,
               news_count = EXCLUDED.news_count,
               bullish_count = EXCLUDED.bullish_count,
               bearish_count = EXCLUDED.bearish_count,
               neutral_count = EXCLUDED.neutral_count,
               briefing_text = EXCLUDED.briefing_text,
               created_at = EXCLUDED.created_at`,
            [
              n.id,
              n.provider || "gemini",
              n.model || "gemini-3.5-flash-lite",
              Number(n.news_count || 0),
              Number(n.bullish_count || 0),
              Number(n.bearish_count || 0),
              Number(n.neutral_count || 0),
              n.briefing_text || "",
              n.created_at || "",
            ]
          );
        }
        if (newsBriefings.length > 0) {
          await this.pool.query(
            "SELECT setval(pg_get_serial_sequence('ai_news_briefings', 'id'), COALESCE((SELECT MAX(id) FROM ai_news_briefings), 1))"
          );
        }
      } catch {}

      // [Antigravity-Doc] 그룹 11: 주간 자동 로테이션 설정·이력 및 Graceful Drain 인계·자금 복원 감사 로그 동기화
      // 11. auto_rotation_config & auto_rotation_history
      try {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS auto_rotation_config (
            id INT PRIMARY KEY,
            is_enabled INT DEFAULT 1,
            rotation_day_of_week INT DEFAULT 1,
            rotation_hour_kst INT DEFAULT 9,
            allocation_mode VARCHAR(64) DEFAULT 'EQUAL_BY_CAPITAL_TIER',
            min_weekly_trades INT DEFAULT 2,
            capital_tier_1_max DOUBLE PRECISION DEFAULT 400000,
            capital_tier_2_max DOUBLE PRECISION DEFAULT 700000,
            max_deploy_ratio DOUBLE PRECISION DEFAULT 0.90,
            last_rotated_at TEXT,
            next_rotation_at TEXT,
            updated_at TEXT
          );
          ALTER TABLE auto_rotation_config ADD COLUMN IF NOT EXISTS capital_tier_1_max DOUBLE PRECISION DEFAULT 400000;
          ALTER TABLE auto_rotation_config ADD COLUMN IF NOT EXISTS capital_tier_2_max DOUBLE PRECISION DEFAULT 700000;
          ALTER TABLE auto_rotation_config ADD COLUMN IF NOT EXISTS max_deploy_ratio DOUBLE PRECISION DEFAULT 0.90;
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
          CREATE TABLE IF NOT EXISTS drain_handoff_logs (
            id BIGINT PRIMARY KEY,
            from_bot_id VARCHAR(50),
            market VARCHAR(50),
            position_id BIGINT DEFAULT 0,
            trade_id BIGINT DEFAULT 0,
            reason TEXT,
            sell_amount DOUBLE PRECISION DEFAULT 0,
            sell_fee DOUBLE PRECISION DEFAULT 0,
            net_proceeds_krw DOUBLE PRECISION DEFAULT 0,
            realized_pnl_krw DOUBLE PRECISION DEFAULT 0,
            allocations_json TEXT,
            remaining_positions_count INT DEFAULT 0,
            created_at TEXT
          );
          CREATE TABLE IF NOT EXISTS capital_restoration_logs (
            id BIGINT PRIMARY KEY,
            source_bot_id VARCHAR(50) NOT NULL,
            target_bot_id VARCHAR(50),
            order_uuid VARCHAR(128),
            settled_net_krw DOUBLE PRECISION NOT NULL,
            restored_krw DOUBLE PRECISION NOT NULL,
            surplus_reserve_krw DOUBLE PRECISION DEFAULT 0,
            total_used_after_krw DOUBLE PRECISION NOT NULL,
            global_cap_krw DOUBLE PRECISION NOT NULL,
            total_equity_snapshot_krw DOUBLE PRECISION DEFAULT 0,
            created_at TEXT NOT NULL
          );
          ALTER TABLE capital_restoration_logs ADD COLUMN IF NOT EXISTS total_equity_snapshot_krw DOUBLE PRECISION DEFAULT 0;
        `);
        const rotCfg = sqliteDb.prepare("SELECT * FROM auto_rotation_config WHERE id = 1").get();
        if (rotCfg) {
          await this.pool.query(
            `INSERT INTO auto_rotation_config (
               id, is_enabled, rotation_day_of_week, rotation_hour_kst,
               allocation_mode, min_weekly_trades, capital_tier_1_max, capital_tier_2_max, max_deploy_ratio,
               last_rotated_at, next_rotation_at, updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (id) DO UPDATE SET
               is_enabled = EXCLUDED.is_enabled,
               rotation_day_of_week = EXCLUDED.rotation_day_of_week,
               rotation_hour_kst = EXCLUDED.rotation_hour_kst,
               allocation_mode = EXCLUDED.allocation_mode,
               min_weekly_trades = EXCLUDED.min_weekly_trades,
               capital_tier_1_max = EXCLUDED.capital_tier_1_max,
               capital_tier_2_max = EXCLUDED.capital_tier_2_max,
               max_deploy_ratio = EXCLUDED.max_deploy_ratio,
               last_rotated_at = EXCLUDED.last_rotated_at,
               next_rotation_at = EXCLUDED.next_rotation_at,
               updated_at = EXCLUDED.updated_at`,
            [
              1,
              Number(rotCfg.is_enabled ?? 1),
              Number(rotCfg.rotation_day_of_week ?? 1),
              Number(rotCfg.rotation_hour_kst ?? 9),
              rotCfg.allocation_mode || "EQUAL_BY_CAPITAL_TIER",
              Number(rotCfg.min_weekly_trades ?? 2),
              Number(rotCfg.capital_tier_1_max ?? 400000),
              Number(rotCfg.capital_tier_2_max ?? 700000),
              Number(rotCfg.max_deploy_ratio ?? 0.9),
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
        try {
          const drainLogs = sqliteDb.prepare("SELECT * FROM drain_handoff_logs").all();
          for (const d of drainLogs) {
            await this.pool.query(
              `INSERT INTO drain_handoff_logs (
                 id, from_bot_id, market, position_id, trade_id, reason,
                 sell_amount, sell_fee, net_proceeds_krw, realized_pnl_krw,
                 allocations_json, remaining_positions_count, created_at
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
               ON CONFLICT (id) DO NOTHING`,
              [
                d.id,
                d.from_bot_id || "",
                d.market || "",
                Number(d.position_id || 0),
                Number(d.trade_id || 0),
                d.reason || "",
                Number(d.sell_amount || 0),
                Number(d.sell_fee || 0),
                Number(d.net_proceeds_krw || 0),
                Number(d.realized_pnl_krw || 0),
                d.allocations_json || "[]",
                Number(d.remaining_positions_count || 0),
                d.created_at || null,
              ]
            );
          }
        } catch {}
        try {
          const restLogs = sqliteDb.prepare("SELECT * FROM capital_restoration_logs").all();
          for (const r of restLogs) {
            await this.pool.query(
              `INSERT INTO capital_restoration_logs (
                 id, source_bot_id, target_bot_id, order_uuid,
                 settled_net_krw, restored_krw, surplus_reserve_krw,
                 total_used_after_krw, global_cap_krw, total_equity_snapshot_krw, created_at
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
               ON CONFLICT (id) DO NOTHING`,
              [
                r.id,
                r.source_bot_id || "",
                r.target_bot_id || null,
                r.order_uuid || null,
                Number(r.settled_net_krw || 0),
                Number(r.restored_krw || 0),
                Number(r.surplus_reserve_krw || 0),
                Number(r.total_used_after_krw || 0),
                Number(r.global_cap_krw || 0),
                Number(r.total_equity_snapshot_krw || 0),
                r.created_at || "",
              ]
            );
          }
        } catch {}
      } catch {}

      // [Antigravity-Doc] 그룹 12: 5중 실전 주문 가드레일 리스(live_executor_lease) 및 최근 300건 주문 의도 원장(live_order_intents) 동기화
      // 12. live_executor_lease & live_order_intents (5중 가드레일 리스 및 주문 의도 원장 동기화)
      try {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS live_executor_lease (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            owner_id TEXT NOT NULL,
            pid INTEGER NOT NULL,
            host TEXT NOT NULL,
            acquired_at TEXT NOT NULL,
            heartbeat_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS live_order_intents (
            intent_id TEXT PRIMARY KEY,
            bot_id TEXT NOT NULL,
            market TEXT NOT NULL,
            side TEXT NOT NULL,
            intent_bucket TEXT NOT NULL,
            requested_krw INTEGER DEFAULT 0,
            requested_volume TEXT DEFAULT '0',
            target_position_uuid TEXT,
            upbit_order_uuid TEXT,
            status TEXT NOT NULL,
            refunded INTEGER NOT NULL DEFAULT 0,
            error_message TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(bot_id, market, side, intent_bucket)
          );
          CREATE INDEX IF NOT EXISTS idx_pg_live_order_intents_bot_mkt_status
            ON live_order_intents (bot_id, market, side, status);
          CREATE INDEX IF NOT EXISTS idx_pg_live_order_intents_created
            ON live_order_intents (bot_id, side, created_at);
        `);

        try {
          const leaseRow = sqliteDb.prepare("SELECT * FROM live_executor_lease WHERE id = 1").get();
          if (leaseRow) {
            await this.pool.query(
              `INSERT INTO live_executor_lease (id, owner_id, pid, host, acquired_at, heartbeat_at, expires_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (id) DO UPDATE SET
                 owner_id = EXCLUDED.owner_id,
                 pid = EXCLUDED.pid,
                 host = EXCLUDED.host,
                 acquired_at = EXCLUDED.acquired_at,
                 heartbeat_at = EXCLUDED.heartbeat_at,
                 expires_at = EXCLUDED.expires_at`,
              [
                1,
                leaseRow.owner_id || "node",
                Number(leaseRow.pid || 0),
                leaseRow.host || "",
                leaseRow.acquired_at || "",
                leaseRow.heartbeat_at || "",
                leaseRow.expires_at || "",
              ]
            );
          }
        } catch {}

        try {
          const intents = sqliteDb
            .prepare("SELECT * FROM live_order_intents ORDER BY created_at DESC LIMIT 300")
            .all();
          for (const it of intents) {
            await this.pool.query(
              `INSERT INTO live_order_intents (
                 intent_id, bot_id, market, side, intent_bucket,
                 requested_krw, requested_volume, target_position_uuid, upbit_order_uuid,
                 status, refunded, error_message, created_at, updated_at
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
               ON CONFLICT (intent_id) DO UPDATE SET
                 intent_bucket = EXCLUDED.intent_bucket,
                 upbit_order_uuid = EXCLUDED.upbit_order_uuid,
                 status = EXCLUDED.status,
                 refunded = EXCLUDED.refunded,
                 error_message = EXCLUDED.error_message,
                 updated_at = EXCLUDED.updated_at`,
              [
                it.intent_id,
                it.bot_id,
                it.market,
                it.side,
                it.intent_bucket,
                Math.floor(Number(it.requested_krw || 0)),
                String(it.requested_volume || "0"),
                it.target_position_uuid ?? null,
                it.upbit_order_uuid ?? null,
                it.status,
                Number(it.refunded || 0),
                it.error_message ?? null,
                it.created_at,
                it.updated_at,
              ]
            );
          }
        } catch {}
      } catch {}
    } catch (err) {
      if (err.code === "ECONNREFUSED" || err.message?.includes("Connection terminated") || err.message?.includes("closed")) {
        this.isConnected = false;
      }
      console.warn(`[PgSync] Sync error: ${err.message}`);
    }
  }

  /**
   * [Antigravity-Doc] 지정 주기(기본 10초)마다 `syncAll()`을 백그라운드 실행하는 인터벌 타이머 등록
   * - 연결이 끊기면(`!this.isConnected`) 자동으로 인터벌을 해제하여 불필요한 재시도를 중단한다.
   * @param {Function} getSqliteDbFn - 최신 SQLite DB 인스턴스를 반환하는 콜백
   * @param {number} [intervalMs=10000] - 동기화 주기(ms)
   */
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

  /**
   * [Antigravity-Doc] 자동 동기화 타이머 및 PostgreSQL 커넥션 풀을 안전하게 종료
   */
  async close() {
    if (this.timer) clearInterval(this.timer);
    if (this.pool) await this.pool.end();
  }
}

// [Antigravity-Doc] 백엔드 전역에서 공유하는 PgSyncManager 싱글턴 인스턴스
export const pgSyncManager = new PgSyncManager();
