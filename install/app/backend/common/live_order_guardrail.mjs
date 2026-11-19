/**
 * backend/common/live_order_guardrail.mjs
 *
 * 실전 업비트 계좌 연속 결제(중복 매수·중복 매도) 원천 차단을 위한 5중 하드 가드레일(Hard Guardrail) 코어 모듈
 *
 * [5중 방어 계층]
 * 1. 단일 실전 실행 주체(LIVE_EXECUTOR_OWNER) + SQLite 원자적 프로세스 리스 락(live_executor_lease, TTL 30s)
 * 2. 주문 실행 최하단 2단계 커밋 (live_order_intents PENDING 선점 + virtual_krw 원자적 선차감 + Upbit identifier 멱등성 + UNKNOWN_TIMEOUT 정산)
 * 3. 동일 포지션(order_uuid) 중복 매도 차단 (closing_lock + sell:<uuid> 버킷) & Graceful Drain 매도 비차단 보장
 * 4. 최후 하드 상한 (청산 후 15분 재진입 쿨다운 · 최소 매수 간격 60s/분할 30s · 봇별 시간당 3회/일 12회 · 전체 일 30회)
 * 5. 이상 연속 주문 시도 감지 시 자동 비상 정지(Auto Kill-Switch: 5분 내 5회 차단 / virtual_krw < 0 / 미해결 UNKNOWN_TIMEOUT 2건 이상)
 */

import crypto from "node:crypto";
import os from "node:os";

export const DEFAULT_LIVE_EXECUTOR_OWNER = "node";
export const DEFAULT_LIVE_LEASE_TTL_SEC = 30;
export const DEFAULT_LIVE_REENTRY_COOLDOWN_SEC = 900;
export const DEFAULT_LIVE_MIN_BUY_INTERVAL_SEC = 60;
export const DEFAULT_LIVE_SPLIT_BUY_INTERVAL_SEC = 30;
export const DEFAULT_LIVE_MAX_BUYS_PER_BOT_HOUR = 3;
export const DEFAULT_LIVE_MAX_BUYS_PER_BOT_DAY = 12;
export const DEFAULT_LIVE_MAX_TOTAL_BUYS_DAY = 30;
export const DEFAULT_LIVE_ANOMALY_BLOCK_THRESHOLD = 5;
export const DEFAULT_LIVE_ANOMALY_WINDOW_SEC = 300;
export const DEFAULT_LIVE_ANOMALY_TIMEOUT_THRESHOLD = 2;
export const LIVE_CYCLE_STALE_WARN_MS = 180 * 1000;

export const SPLIT_ALLOWED_BOTS = new Set(["bot_06", "bot_10"]);

function formatKstDateTimeLocal(dateObj = new Date()) {
  const kst = new Date(dateObj.getTime() + 9 * 3600 * 1000);
  const yyyy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kst.getUTCDate()).padStart(2, "0");
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mi = String(kst.getUTCMinutes()).padStart(2, "0");
  const ss = String(kst.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

export function getTodayStartKstUtcIso(nowMs = Date.now()) {
  const kst = new Date(nowMs + 9 * 3600 * 1000);
  const midnightKstInUtcMs =
    Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), 0, 0, 0, 0) - 9 * 3600 * 1000;
  return new Date(midnightKstInUtcMs).toISOString();
}

export function buildCandleBucketKey(nowMs = Date.now(), candleMinutes = 15) {
  const unitMs = Math.max(1, Number(candleMinutes || 15)) * 60 * 1000;
  const flooredUtcMs = Math.floor(nowMs / unitMs) * unitMs;
  const kst = new Date(flooredUtcMs + 9 * 3600 * 1000);
  const yyyy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kst.getUTCDate()).padStart(2, "0");
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mi = String(kst.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}${mm}${dd}T${hh}${mi}`;
}

export function buildBuyIntentBucket(botId, market, stepIndex = 1, options = {}) {
  if (options?.intentBucket && String(options.intentBucket).trim()) {
    return String(options.intentBucket).trim();
  }
  const normBot = String(botId || "").trim().toLowerCase();
  const normMkt = String(market || "").trim().toUpperCase();
  const candleTs = options?.candleTs
    ? String(options.candleTs).trim()
    : buildCandleBucketKey(options?.nowMs || Date.now(), options?.candleMinutes || 15);
  const step = Math.max(1, Math.floor(Number(stepIndex || 1)));
  return `${normBot}:${normMkt}:${candleTs}:s${step}`;
}

export function buildSellIntentBucket(targetPositionUuid) {
  return `sell:${String(targetPositionUuid || "").trim()}`;
}

function parsePositiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function getLiveExecutorOwner(runtimeConfig = {}) {
  const envVal = String(process.env.LIVE_EXECUTOR_OWNER || "").trim().toLowerCase();
  if (envVal === "node" || envVal === "python") return envVal;
  const cfgVal = String(runtimeConfig?.live_executor_owner || "").trim().toLowerCase();
  if (cfgVal === "node" || cfgVal === "python") return cfgVal;
  return DEFAULT_LIVE_EXECUTOR_OWNER;
}

export async function getGuardrailConfig(db, runtimeConfig = {}) {
  const readDbSetting = async (key) => {
    if (!db) return "";
    try {
      const row = await db.prepare("SELECT value FROM system_settings WHERE key = ?").get(key);
      return row && row.value !== undefined && row.value !== null ? String(row.value).trim() : "";
    } catch {
      return "";
    }
  };

  const resolveNum = async (settingKey, envKey, cfgKey, fallback) => {
    const dbVal = await readDbSetting(settingKey);
    if (dbVal !== "") return parsePositiveInt(dbVal, fallback);
    if (process.env[envKey] !== undefined && String(process.env[envKey]).trim() !== "") {
      return parsePositiveInt(process.env[envKey], fallback);
    }
    if (runtimeConfig && runtimeConfig[cfgKey] !== undefined && runtimeConfig[cfgKey] !== "") {
      return parsePositiveInt(runtimeConfig[cfgKey], fallback);
    }
    return fallback;
  };

  const dbOwner = (await readDbSetting("live_executor_owner")).toLowerCase();
  const owner =
    String(process.env.LIVE_EXECUTOR_OWNER || "").trim().toLowerCase() ||
    (dbOwner === "node" || dbOwner === "python" ? dbOwner : "") ||
    getLiveExecutorOwner(runtimeConfig);

  const normalizedOwner = owner === "python" ? "python" : "node";

  return {
    live_executor_owner: normalizedOwner,
    lease_ttl_sec: await resolveNum("live_lease_ttl_sec", "LIVE_LEASE_TTL_SEC", "live_lease_ttl_sec", DEFAULT_LIVE_LEASE_TTL_SEC),
    reentry_cooldown_sec: await resolveNum(
      "live_reentry_cooldown_sec",
      "LIVE_REENTRY_COOLDOWN_SEC",
      "live_reentry_cooldown_sec",
      DEFAULT_LIVE_REENTRY_COOLDOWN_SEC
    ),
    min_buy_interval_sec: await resolveNum(
      "live_min_buy_interval_sec",
      "LIVE_MIN_BUY_INTERVAL_SEC",
      "live_min_buy_interval_sec",
      DEFAULT_LIVE_MIN_BUY_INTERVAL_SEC
    ),
    split_min_buy_interval_sec: await resolveNum(
      "live_split_buy_interval_sec",
      "LIVE_SPLIT_BUY_INTERVAL_SEC",
      "live_split_buy_interval_sec",
      DEFAULT_LIVE_SPLIT_BUY_INTERVAL_SEC
    ),
    max_buys_per_bot_hour: await resolveNum(
      "live_max_buys_per_bot_hour",
      "LIVE_MAX_BUYS_PER_BOT_HOUR",
      "live_max_buys_per_bot_hour",
      DEFAULT_LIVE_MAX_BUYS_PER_BOT_HOUR
    ),
    max_buys_per_bot_day: await resolveNum(
      "live_max_buys_per_bot_day",
      "LIVE_MAX_BUYS_PER_BOT_DAY",
      "live_max_buys_per_bot_day",
      DEFAULT_LIVE_MAX_BUYS_PER_BOT_DAY
    ),
    max_total_buys_day: await resolveNum(
      "live_max_total_buys_day",
      "LIVE_MAX_TOTAL_BUYS_DAY",
      "live_max_total_buys_day",
      DEFAULT_LIVE_MAX_TOTAL_BUYS_DAY
    ),
    anomaly_block_threshold: await resolveNum(
      "live_anomaly_block_threshold",
      "LIVE_ANOMALY_BLOCK_THRESHOLD",
      "live_anomaly_block_threshold",
      DEFAULT_LIVE_ANOMALY_BLOCK_THRESHOLD
    ),
    anomaly_window_sec: await resolveNum(
      "live_anomaly_window_sec",
      "LIVE_ANOMALY_WINDOW_SEC",
      "live_anomaly_window_sec",
      DEFAULT_LIVE_ANOMALY_WINDOW_SEC
    ),
    anomaly_timeout_threshold: await resolveNum(
      "live_anomaly_timeout_threshold",
      "LIVE_ANOMALY_TIMEOUT_THRESHOLD",
      "live_anomaly_timeout_threshold",
      DEFAULT_LIVE_ANOMALY_TIMEOUT_THRESHOLD
    ),
  };
}

/**
 * SQLite / PostgreSQL 공통 가드레일 테이블 및 컬럼 자동 마이그레이션
 */
export async function ensureLiveGuardrailTables(db) {
  if (!db) return;
  await db.exec(`
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

    CREATE INDEX IF NOT EXISTS idx_live_order_intents_bot_mkt_status
      ON live_order_intents (bot_id, market, side, status);
    CREATE INDEX IF NOT EXISTS idx_live_order_intents_created
      ON live_order_intents (bot_id, side, created_at);

    CREATE TABLE IF NOT EXISTS live_guardrail_events (
      id BIGSERIAL PRIMARY KEY,
      bot_id TEXT NOT NULL,
      market TEXT DEFAULT '',
      side TEXT DEFAULT 'BUY',
      block_code TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_live_guardrail_events_bot_created
      ON live_guardrail_events (bot_id, created_at);

    ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS closing_lock INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS buy_reason TEXT;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS sell_reason TEXT;
  `);
}

/**
 * [Layer 1] 트랜잭션 내부용 프로세스 리스 획득/검증 (이미 BEGIN IMMEDIATE 안에 있을 때 호출)
 */
async function acquireOrVerifyLeaseInTx(db, cfg, options = {}) {
  const expectedEngine = String(options.engine || "node").toLowerCase();
  const ownerId = String(options.ownerId || expectedEngine);
  const pid = Number.isFinite(Number(options.pid)) ? Number(options.pid) : process.pid;
  const host = String(options.host || os.hostname());
  const ttlSec = Math.max(5, Number(options.ttlSec || cfg.lease_ttl_sec || DEFAULT_LIVE_LEASE_TTL_SEC));
  const nowMs = Number(options.nowMs || Date.now());
  const nowIso = new Date(nowMs).toISOString();
  const expiresIso = new Date(nowMs + ttlSec * 1000).toISOString();

  if (cfg.live_executor_owner !== expectedEngine) {
    return {
      ok: false,
      code: "OWNER_MISMATCH",
      reason: `LIVE_EXECUTOR_OWNER='${cfg.live_executor_owner}' 설정으로 인해 '${expectedEngine}' 프로세스의 실전 주문이 원천 차단되었습니다.`,
      holder: null,
    };
  }

  const row = await db.prepare("SELECT * FROM live_executor_lease WHERE id = 1").get();
  if (row) {
    const rowExpMs = Date.parse(row.expires_at || "");
    const isExpired = !Number.isFinite(rowExpMs) || rowExpMs <= nowMs;
    const isSameHolder =
      String(row.owner_id) === ownerId && Number(row.pid) === pid && String(row.host) === host;

    if (!isSameHolder && !isExpired) {
      return {
        ok: false,
        code: "LEASE_HELD_BY_OTHER",
        reason: `다른 실전 실행 프로세스(owner=${row.owner_id}, pid=${row.pid}, host=${row.host}, 만료=${row.expires_at})가 유효한 리스를 보유 중입니다.`,
        holder: row,
      };
    }

    const acquiredAt = isSameHolder && row.acquired_at ? row.acquired_at : nowIso;
    await db
      .prepare(
        `UPDATE live_executor_lease
         SET owner_id = ?, pid = ?, host = ?, acquired_at = ?, heartbeat_at = ?, expires_at = ?
         WHERE id = 1`
      )
      .run(ownerId, pid, host, acquiredAt, nowIso, expiresIso);

    return {
      ok: true,
      lease: { id: 1, owner_id: ownerId, pid, host, acquired_at: acquiredAt, heartbeat_at: nowIso, expires_at: expiresIso },
    };
  }

  await db
    .prepare(
      `INSERT INTO live_executor_lease (id, owner_id, pid, host, acquired_at, heartbeat_at, expires_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)`
    )
    .run(ownerId, pid, host, nowIso, nowIso, expiresIso);

  return {
    ok: true,
    lease: { id: 1, owner_id: ownerId, pid, host, acquired_at: nowIso, heartbeat_at: nowIso, expires_at: expiresIso },
  };
}

/**
 * [Layer 1] 독립 호출용 원자적 프로세스 리스 획득/갱신 (BEGIN IMMEDIATE)
 */
export async function acquireOrRenewLiveExecutorLease(db, deps = {}, options = {}) {
  const { runtimeConfig = {}, withDbWriteLock, beginWriteTx, commitWriteTx, rollbackWriteTx } = deps;
  const cfg = await getGuardrailConfig(db, runtimeConfig);

  const runTx = async () => {
    try {
      await beginWriteTx(db);
      const res = await acquireOrVerifyLeaseInTx(db, cfg, options);
      await commitWriteTx(db);
      return res;
    } catch (err) {
      await rollbackWriteTx(db);
      return {
        ok: false,
        code: "LEASE_DB_ERROR",
        reason: `리스 락 DB 오류: ${err.message}`,
      };
    }
  };

  return typeof withDbWriteLock === "function" ? await withDbWriteLock(runTx) : await runTx();
}

/**
 * [Layer 1] 종료 시 본 프로세스가 보유한 리스만 안전 해제
 */
export async function releaseLiveExecutorLease(db, deps = {}, options = {}) {
  const { withDbWriteLock, beginWriteTx, commitWriteTx, rollbackWriteTx } = deps;
  const ownerId = String(options.ownerId || options.engine || "node");
  const pid = Number.isFinite(Number(options.pid)) ? Number(options.pid) : process.pid;
  const host = String(options.host || os.hostname());

  const runTx = async () => {
    try {
      await beginWriteTx(db);
      await db
        .prepare("DELETE FROM live_executor_lease WHERE id = 1 AND owner_id = ? AND pid = ? AND host = ?")
        .run(ownerId, pid, host);
      await commitWriteTx(db);
      return true;
    } catch {
      await rollbackWriteTx(db);
      return false;
    }
  };

  return typeof withDbWriteLock === "function" ? await withDbWriteLock(runTx) : await runTx();
}

/**
 * [Layer 5] 이상 징후 감지 시 비상 정지(Auto Kill-Switch) 발동 (트랜잭션 내부 호출)
 * - 실전 봇(is_running = 0)만 정지하며, 10대 가상거래 Arena(paper_is_running / algo_lab_models)는 절대 건드리지 않음!
 */
async function tripGuardrailKillSwitchInTx(db, { botIds = [], haltAllLiveBots = false, code = "ANOMALY_KILL_SWITCH", reason = "" }) {
  const nowKst = formatKstDateTimeLocal();
  const fullReason = `[🚨 가드레일 비상 정지:${code}] ${reason}`;

  let targetIds = [...new Set((botIds || []).filter(Boolean))];
  if (haltAllLiveBots || targetIds.length === 0) {
    const liveRows = await db
      .prepare("SELECT bot_id FROM bots WHERE is_selected_for_live = 1 OR is_running = 1")
      .all();
    targetIds = [...new Set([...targetIds, ...liveRows.map((r) => r.bot_id)])];
  }

  for (const bid of targetIds) {
    await db
      .prepare("UPDATE bots SET is_running = 0, last_status_msg = ?, updated_at = ? WHERE bot_id = ?")
      .run(fullReason, nowKst, bid);
  }

  let existingBots = [];
  try {
    const prevRow = await db
      .prepare("SELECT value FROM system_settings WHERE key = 'guardrail_emergency_bots_json'")
      .get();
    if (prevRow?.value) {
      const parsed = JSON.parse(prevRow.value);
      if (Array.isArray(parsed)) existingBots = parsed;
    }
  } catch {}

  const mergedBots = [...existingBots];
  for (const bid of targetIds) {
    const idx = mergedBots.findIndex((it) => it.bot_id === bid);
    const entry = { bot_id: bid, code, reason, halted_at: nowKst };
    if (idx >= 0) mergedBots[idx] = entry;
    else mergedBots.push(entry);
  }

  const upsertSetting = async (k, v) => {
    await db
      .prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(k, String(v), nowKst);
  };
  await upsertSetting("guardrail_emergency_halted", "1");
  await upsertSetting("guardrail_emergency_code", code);
  await upsertSetting("guardrail_emergency_reason", fullReason);
  await upsertSetting("guardrail_emergency_at", nowKst);
  await upsertSetting("guardrail_emergency_bots_json", JSON.stringify(mergedBots));

  return {
    tripped: true,
    code,
    reason: fullReason,
    halted_at: nowKst,
    halted_bots: targetIds,
  };
}

/**
 * 차단 이벤트 기록 + 5분 내 동일 봇 5회 이상 차단 시 자동 Kill-Switch 발동 (트랜잭션 내부 호출)
 */
async function recordBlockAndMaybeKillSwitchInTx(db, cfg, { botId, market, side = "BUY", code, reason, nowMs = Date.now() }) {
  const nowIso = new Date(nowMs).toISOString();
  const nowKst = formatKstDateTimeLocal(new Date(nowMs));

  await db
    .prepare(
      `INSERT INTO live_guardrail_events (bot_id, market, side, block_code, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(botId, market || "", side, code, reason, nowIso);

  const windowCutoffIso = new Date(nowMs - cfg.anomaly_window_sec * 1000).toISOString();
  const cntRow = await db
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM live_guardrail_events
       WHERE bot_id = ? AND side = 'BUY' AND created_at >= ?`
    )
    .get(botId, windowCutoffIso);
  const blockCount = Number(cntRow?.cnt || 0);

  let killSwitch = null;
  if (blockCount >= cfg.anomaly_block_threshold) {
    killSwitch = await tripGuardrailKillSwitchInTx(db, {
      botIds: [botId],
      haltAllLiveBots: false,
      code: "REPEATED_BLOCK_ANOMALY",
      reason: `최근 ${Math.round(cfg.anomaly_window_sec / 60)}분 이내 실전 매수 가드레일 차단 ${blockCount}회 누적(한도 ${cfg.anomaly_block_threshold}회 · 최근 사유: ${code})으로 ${botId} 자동 비상 정지`,
    });
  } else {
    await db
      .prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?")
      .run(`[🛡️ 가드레일 차단:${code}] ${reason}`, nowKst, botId);
  }

  return { blockCount, killSwitch };
}

/**
 * [Layer 1 + Layer 2 + Layer 4 + Layer 5]
 * 실전 매수(BUY) Step A: 단일 원자적 BEGIN IMMEDIATE 트랜잭션으로
 * 1) 소유자/리스 락 검증
 * 2) 봇 상태/이상 징후(virtual_krw < 0, UNKNOWN_TIMEOUT >= 2) 검증
 * 3) 미확정 인텐트(PENDING/SUBMITTED/UNKNOWN_TIMEOUT) 존재 여부 차단
 * 4) 단일 포지션 / 분할 전략 차수 상한 검증
 * 5) 재진입 쿨다운(900s), 최소 매수 간격(60s/30s), 시간당(3)/일일(12)/전체 일일(30) Hard Cap 검증
 * 6) 최소 주문 금액(5,000원/수수료 완충 1.0005) 검증
 * 7) live_order_intents(PENDING) INSERT (UNIQUE 버킷 잠금) + virtual_krw 원자적 선차감
 */
export async function claimLiveBuyIntentAtomic(db, params, deps = {}) {
  const {
    botId,
    market,
    orderKrw,
    bestBidPrice,
    floorTo8DecimalsStr,
    options = {},
    inMemoryCooldownMap = null,
  } = params;
  const { runtimeConfig = {}, withDbWriteLock, beginWriteTx, commitWriteTx, rollbackWriteTx, onKillSwitch = null } = deps;

  const normBotId = String(botId || "").trim();
  const normMkt = String(market || "").trim().toUpperCase();
  const nowMs = Number(options?.nowMs || Date.now());
  const nowIso = new Date(nowMs).toISOString();
  const nowKst = formatKstDateTimeLocal(new Date(nowMs));
  const cfg = await getGuardrailConfig(db, runtimeConfig);

  let triggeredKillSwitch = null;

  const runTx = async () => {
    try {
      await beginWriteTx(db);

      // 1. Layer 1: LIVE_EXECUTOR_OWNER + 프로세스 리스 락 원자적 확인/갱신
      const leaseRes = await acquireOrVerifyLeaseInTx(db, cfg, {
        engine: "node",
        ownerId: options?.leaseOwnerId || "node",
        pid: options?.leasePid,
        host: options?.leaseHost,
        nowMs,
      });
      if (!leaseRes.ok) {
        await commitWriteTx(db);
        console.warn(`[Guardrail][Layer1][${normBotId}] BUY 차단 (${leaseRes.code}): ${leaseRes.reason}`);
        return { ok: false, code: leaseRes.code, reason: leaseRes.reason };
      }

      // 2. 최신 봇 행 로드 및 기본 실전 가동 검증
      const latestBot = await db.prepare("SELECT * FROM bots WHERE bot_id = ?").get(normBotId);
      if (!latestBot) {
        await commitWriteTx(db);
        return { ok: false, code: "BOT_NOT_FOUND", reason: "봇 정보를 찾을 수 없습니다." };
      }

      // 2-A. Layer 5 이상 감지: virtual_krw < 0 즉시 비상 정지
      const currentVirtualKrw = Number(latestBot.virtual_krw || 0);
      if (currentVirtualKrw < 0) {
        triggeredKillSwitch = await tripGuardrailKillSwitchInTx(db, {
          botIds: [normBotId],
          code: "NEGATIVE_VIRTUAL_KRW",
          reason: `${normBotId} 가용 원화가 음수(${Math.floor(currentVirtualKrw)}원)로 감지되어 즉시 비상 정지되었습니다.`,
        });
        await commitWriteTx(db);
        return { ok: false, code: "NEGATIVE_VIRTUAL_KRW", reason: triggeredKillSwitch.reason, killSwitch: triggeredKillSwitch };
      }

      // 2-B. Layer 5 이상 감지: 미해결 UNKNOWN_TIMEOUT >= threshold(기본 2건) 즉시 비상 정지
      const timeoutRow = await db
        .prepare(
          `SELECT
             SUM(CASE WHEN bot_id = ? THEN 1 ELSE 0 END) AS bot_timeouts,
             COUNT(*) AS total_timeouts
           FROM live_order_intents
           WHERE status = 'UNKNOWN_TIMEOUT'`
        )
        .get(normBotId);
      const botTimeouts = Number(timeoutRow?.bot_timeouts || 0);
      const totalTimeouts = Number(timeoutRow?.total_timeouts || 0);
      if (botTimeouts >= cfg.anomaly_timeout_threshold || totalTimeouts >= cfg.anomaly_timeout_threshold) {
        triggeredKillSwitch = await tripGuardrailKillSwitchInTx(db, {
          botIds: [normBotId],
          haltAllLiveBots: totalTimeouts >= cfg.anomaly_timeout_threshold,
          code: "UNRESOLVED_TIMEOUT_ANOMALY",
          reason: `미해결 UNKNOWN_TIMEOUT 인텐트 ${Math.max(botTimeouts, totalTimeouts)}건(임계치 ${cfg.anomaly_timeout_threshold}건) 감지로 실전 매매를 비상 정지합니다.`,
        });
        await commitWriteTx(db);
        return {
          ok: false,
          code: "UNRESOLVED_TIMEOUT_ANOMALY",
          reason: triggeredKillSwitch.reason,
          killSwitch: triggeredKillSwitch,
        };
      }

      if (Number(latestBot.is_selected_for_live) !== 1 || Number(latestBot.is_running) !== 1) {
        await commitWriteTx(db);
        return {
          ok: false,
          code: "BOT_NOT_ACTIVE_LIVE",
          reason: `${normBotId} 실전 미선택 또는 중지 상태(is_selected=${latestBot.is_selected_for_live}, is_running=${latestBot.is_running})`,
        };
      }

      // 3. Layer 2: 동일 (bot_id, market) 미확정(PENDING/SUBMITTED/UNKNOWN_TIMEOUT) 매수 인텐트 1건이라도 존재 시 즉시 차단
      const inflightRow = await db
        .prepare(
          `SELECT intent_id, status
           FROM live_order_intents
           WHERE bot_id = ? AND market = ? AND side = 'BUY'
             AND status IN ('PENDING', 'SUBMITTED', 'UNKNOWN_TIMEOUT')
           LIMIT 1`
        )
        .get(normBotId, normMkt);
      if (inflightRow) {
        const reason = `${normMkt} 미확정 매수 인텐트(${inflightRow.status}, id=${inflightRow.intent_id.slice(0, 8)}) 존재로 중복 매수 차단`;
        const blk = await recordBlockAndMaybeKillSwitchInTx(db, cfg, {
          botId: normBotId,
          market: normMkt,
          side: "BUY",
          code: "INFLIGHT_OR_TIMEOUT_INTENT",
          reason,
          nowMs,
        });
        triggeredKillSwitch = blk.killSwitch;
        await commitWriteTx(db);
        return { ok: false, code: "INFLIGHT_OR_TIMEOUT_INTENT", reason, blockCount: blk.blockCount, killSwitch: blk.killSwitch };
      }

      // 4. Layer 2: 단일 포지션 / 허용 분할 전략(bot_06, bot_10) 차수 검증
      let botCfg = {};
      try {
        botCfg = JSON.parse(latestBot.config_json || "{}");
      } catch {}
      const openPosRows = await db
        .prepare("SELECT id, step_level, buy_amount FROM bot_positions WHERE bot_id = ? AND market = ? AND status = 'OPEN' ORDER BY id ASC")
        .all(normBotId, normMkt);
      const openCount = openPosRows.length;
      const isSplitBot = SPLIT_ALLOWED_BOTS.has(normBotId);
      const maxSteps =
        normBotId === "bot_06"
          ? Math.min(5, Math.max(1, parsePositiveInt(botCfg.max_steps, 3)))
          : normBotId === "bot_10"
          ? 2
          : 1;

      const requestedStep = options?.stepIndex !== undefined
        ? Math.max(1, Math.floor(Number(options.stepIndex)))
        : openCount + 1;

      if (!isSplitBot && openCount > 0) {
        const reason = `${normBotId}는 단일 진입 전략이며 ${normMkt} OPEN 포지션(${openCount}건) 보유 중으로 추가 매수 차단`;
        const blk = await recordBlockAndMaybeKillSwitchInTx(db, cfg, {
          botId: normBotId,
          market: normMkt,
          side: "BUY",
          code: "DUPLICATE_OPEN_POSITION",
          reason,
          nowMs,
        });
        triggeredKillSwitch = blk.killSwitch;
        await commitWriteTx(db);
        return { ok: false, code: "DUPLICATE_OPEN_POSITION", reason, blockCount: blk.blockCount, killSwitch: blk.killSwitch };
      }

      if (isSplitBot && (openCount >= maxSteps || requestedStep > maxSteps)) {
        const reason = `${normBotId} ${normMkt} 분할 매수 최대 차수 상한(${maxSteps}차) 도달로 추가 매수 차단`;
        const blk = await recordBlockAndMaybeKillSwitchInTx(db, cfg, {
          botId: normBotId,
          market: normMkt,
          side: "BUY",
          code: "SPLIT_STEP_CAP_EXCEEDED",
          reason,
          nowMs,
        });
        triggeredKillSwitch = blk.killSwitch;
        await commitWriteTx(db);
        return { ok: false, code: "SPLIT_STEP_CAP_EXCEEDED", reason, blockCount: blk.blockCount, killSwitch: blk.killSwitch };
      }

      // 5. Layer 4: 최후 하드 상한 검증 (재진입 쿨다운 / 최소 간격 / 시간당 / 일일 / 전체 일일)
      // 5-1. 청산 후 재진입 쿨다운 (기본 900초 = 15분)
      if (openCount === 0 && !options?.ignoreCooldown) {
        const cooldownMs = cfg.reentry_cooldown_sec * 1000;
        const memSellMs = inMemoryCooldownMap ? Number(inMemoryCooldownMap.get(`${normBotId}|${normMkt}`) || 0) : 0;
        let inCooldown = memSellMs > 0 && nowMs - memSellMs < cooldownMs;
        let cooldownRemainingSec = inCooldown ? Math.ceil((cooldownMs - (nowMs - memSellMs)) / 1000) : 0;

        if (!inCooldown) {
          const cutoffKst = formatKstDateTimeLocal(new Date(nowMs - cooldownMs));
          const recentTradeSell = await db
            .prepare(
              `SELECT sell_date FROM trades
               WHERE bot_id = ? AND market = ? AND status = 'COMPLETED' AND sell_date >= ?
               ORDER BY sell_date DESC LIMIT 1`
            )
            .get(normBotId, normMkt, cutoffKst);
          const recentPosSell = !recentTradeSell
            ? await db
                .prepare(
                  `SELECT closed_at FROM bot_positions
                   WHERE bot_id = ? AND market = ? AND status = 'CLOSED' AND closed_at >= ?
                   ORDER BY closed_at DESC LIMIT 1`
                )
                .get(normBotId, normMkt, cutoffKst)
            : null;
          const cutoffIso = new Date(nowMs - cooldownMs).toISOString();
          const recentIntentSell = !recentTradeSell && !recentPosSell
            ? await db
                .prepare(
                  `SELECT updated_at FROM live_order_intents
                   WHERE bot_id = ? AND market = ? AND side = 'SELL' AND status = 'CONFIRMED' AND updated_at >= ?
                   ORDER BY updated_at DESC LIMIT 1`
                )
                .get(normBotId, normMkt, cutoffIso)
            : null;

          if (recentTradeSell || recentPosSell || recentIntentSell) {
            inCooldown = true;
            cooldownRemainingSec = cfg.reentry_cooldown_sec;
          }
        }

        if (inCooldown) {
          const reason = `${normMkt} 매도 청산 후 재진입 쿨다운(${cfg.reentry_cooldown_sec}초, 잔여 약 ${cooldownRemainingSec}초) 미경과로 매수 차단`;
          const blk = await recordBlockAndMaybeKillSwitchInTx(db, cfg, {
            botId: normBotId,
            market: normMkt,
            side: "BUY",
            code: "REENTRY_COOLDOWN",
            reason,
            nowMs,
          });
          triggeredKillSwitch = blk.killSwitch;
          await commitWriteTx(db);
          return { ok: false, code: "REENTRY_COOLDOWN", reason, blockCount: blk.blockCount, killSwitch: blk.killSwitch };
        }
      }

      // 5-2. 동일 봇 최소 매수 간격 (일반 60초, bot_06/bot_10 추가 분할 차수 30초)
      if (!options?.ignoreMinInterval) {
        const minIntervalSec = isSplitBot && openCount > 0 ? cfg.split_min_buy_interval_sec : cfg.min_buy_interval_sec;
        const intervalCutoffIso = new Date(nowMs - minIntervalSec * 1000).toISOString();
        const recentBuyRow = await db
          .prepare(
            `SELECT intent_id, market, created_at
             FROM live_order_intents
             WHERE bot_id = ? AND side = 'BUY'
               AND status IN ('PENDING', 'SUBMITTED', 'UNKNOWN_TIMEOUT', 'CONFIRMED')
               AND created_at >= ?
             ORDER BY created_at DESC LIMIT 1`
          )
          .get(normBotId, intervalCutoffIso);
        if (recentBuyRow) {
          const reason = `${normBotId} 최소 실전 매수 간격(${minIntervalSec}초) 미경과(직전 매수: ${recentBuyRow.market} @ ${recentBuyRow.created_at})`;
          const blk = await recordBlockAndMaybeKillSwitchInTx(db, cfg, {
            botId: normBotId,
            market: normMkt,
            side: "BUY",
            code: "MIN_BUY_INTERVAL",
            reason,
            nowMs,
          });
          triggeredKillSwitch = blk.killSwitch;
          await commitWriteTx(db);
          return { ok: false, code: "MIN_BUY_INTERVAL", reason, blockCount: blk.blockCount, killSwitch: blk.killSwitch };
        }
      }

      // 5-3. 봇별 최근 1시간 실전 매수 상한 (기본 3회)
      const hourCutoffIso = new Date(nowMs - 3600 * 1000).toISOString();
      const hourCountRow = await db
        .prepare(
          `SELECT COUNT(*) AS cnt
           FROM live_order_intents
           WHERE bot_id = ? AND side = 'BUY'
             AND status IN ('PENDING', 'SUBMITTED', 'UNKNOWN_TIMEOUT', 'CONFIRMED')
             AND created_at >= ?`
        )
        .get(normBotId, hourCutoffIso);
      const botHourBuys = Number(hourCountRow?.cnt || 0);
      if (botHourBuys >= cfg.max_buys_per_bot_hour) {
        const reason = `${normBotId} 시간당 실전 매수 상한(${botHourBuys}/${cfg.max_buys_per_bot_hour}회) 초과 차단`;
        const blk = await recordBlockAndMaybeKillSwitchInTx(db, cfg, {
          botId: normBotId,
          market: normMkt,
          side: "BUY",
          code: "BOT_HOURLY_BUY_CAP",
          reason,
          nowMs,
        });
        triggeredKillSwitch = blk.killSwitch;
        await commitWriteTx(db);
        return { ok: false, code: "BOT_HOURLY_BUY_CAP", reason, blockCount: blk.blockCount, killSwitch: blk.killSwitch };
      }

      // 5-4. 봇별 당일(00:00 KST) 실전 매수 상한 (기본 12회)
      const todayStartUtcIso = getTodayStartKstUtcIso(nowMs);
      const botDayRow = await db
        .prepare(
          `SELECT COUNT(*) AS cnt
           FROM live_order_intents
           WHERE bot_id = ? AND side = 'BUY'
             AND status IN ('PENDING', 'SUBMITTED', 'UNKNOWN_TIMEOUT', 'CONFIRMED')
             AND created_at >= ?`
        )
        .get(normBotId, todayStartUtcIso);
      const botDayBuys = Number(botDayRow?.cnt || 0);
      if (botDayBuys >= cfg.max_buys_per_bot_day) {
        const reason = `${normBotId} 일일 실전 매수 상한(${botDayBuys}/${cfg.max_buys_per_bot_day}회, 00:00 KST 기준) 초과 차단`;
        const blk = await recordBlockAndMaybeKillSwitchInTx(db, cfg, {
          botId: normBotId,
          market: normMkt,
          side: "BUY",
          code: "BOT_DAILY_BUY_CAP",
          reason,
          nowMs,
        });
        triggeredKillSwitch = blk.killSwitch;
        await commitWriteTx(db);
        return { ok: false, code: "BOT_DAILY_BUY_CAP", reason, blockCount: blk.blockCount, killSwitch: blk.killSwitch };
      }

      // 5-5. 전체 실전 풀 당일(00:00 KST) 합산 매수 상한 (기본 30회)
      const totalDayRow = await db
        .prepare(
          `SELECT COUNT(*) AS cnt
           FROM live_order_intents
           WHERE side = 'BUY'
             AND status IN ('PENDING', 'SUBMITTED', 'UNKNOWN_TIMEOUT', 'CONFIRMED')
             AND created_at >= ?`
        )
        .get(todayStartUtcIso);
      const totalDayBuys = Number(totalDayRow?.cnt || 0);
      if (totalDayBuys >= cfg.max_total_buys_day) {
        const reason = `전체 실전 풀 일일 매수 상한(${totalDayBuys}/${cfg.max_total_buys_day}회, 00:00 KST 기준) 초과 차단`;
        const blk = await recordBlockAndMaybeKillSwitchInTx(db, cfg, {
          botId: normBotId,
          market: normMkt,
          side: "BUY",
          code: "GLOBAL_DAILY_BUY_CAP",
          reason,
          nowMs,
        });
        triggeredKillSwitch = blk.killSwitch;
        await commitWriteTx(db);
        return { ok: false, code: "GLOBAL_DAILY_BUY_CAP", reason, blockCount: blk.blockCount, killSwitch: blk.killSwitch };
      }

      // 6. Layer 2: 자금·최소 주문 금액(5,000원 / 수수료 완충 1.0005)·배정 원금 검증
      const availableVirtual = Math.floor(currentVirtualKrw);
      const maxAffordableOrder = Math.floor(availableVirtual / 1.0005);
      const reqOrderKrw = Math.floor(Number(orderKrw || 0));
      if (!Number.isFinite(bestBidPrice) || bestBidPrice <= 0 || reqOrderKrw < 5000 || maxAffordableOrder < 5000) {
        await commitWriteTx(db);
        return {
          ok: false,
          code: "INSUFFICIENT_OR_BELOW_MIN_ORDER",
          reason: `주문 가능 금액 부족 또는 최소 주문 금액(5,000원) 미달 (요청=${reqOrderKrw}, 가용=${availableVirtual})`,
        };
      }

      const cappedOrderKrw = Math.min(reqOrderKrw, maxAffordableOrder);
      const rawVol = cappedOrderKrw / bestBidPrice;
      let limitVolNum = Number(floorTo8DecimalsStr(rawVol));
      if (limitVolNum * bestBidPrice < 5000) {
        const stepped = Number(floorTo8DecimalsStr(limitVolNum + 0.00000001));
        if (Math.ceil(stepped * bestBidPrice * 1.0005) <= availableVirtual) {
          limitVolNum = stepped;
        } else {
          await commitWriteTx(db);
          return { ok: false, code: "BELOW_MIN_NOTIONAL", reason: "수량 절삭 후 업비트 최소 주문 금액(5,000원) 미달" };
        }
      }
      const limitVolumeStr = floorTo8DecimalsStr(limitVolNum);
      const plannedBuyAmount = Math.floor(limitVolNum * bestBidPrice);
      const plannedFee = Math.ceil(plannedBuyAmount * 0.0005);
      const reservedKrw = Math.min(availableVirtual, plannedBuyAmount + plannedFee);

      if (plannedBuyAmount < 5000 || reservedKrw <= 0 || availableVirtual < reservedKrw) {
        await commitWriteTx(db);
        return { ok: false, code: "INSUFFICIENT_VIRTUAL_KRW", reason: "선차감 가능 가용 원화 부족" };
      }

      const invRow = await db
        .prepare("SELECT COALESCE(SUM(buy_amount), 0) AS invested FROM bot_positions WHERE bot_id = ? AND status = 'OPEN'")
        .get(normBotId);
      const currentInvested = Math.floor(Number(invRow?.invested || 0));
      const pendingResRow = await db
        .prepare(
          `SELECT COALESCE(SUM(requested_krw), 0) AS pending_krw
           FROM live_order_intents
           WHERE bot_id = ? AND side = 'BUY' AND refunded = 0
             AND status IN ('PENDING', 'SUBMITTED', 'UNKNOWN_TIMEOUT')`
        )
        .get(normBotId);
      const pendingReserved = Math.floor(Number(pendingResRow?.pending_krw || 0));

      if (currentInvested + pendingReserved + plannedBuyAmount > Number(latestBot.allocated_capital || 0)) {
        await commitWriteTx(db);
        return {
          ok: false,
          code: "EXCEEDS_ALLOCATED_CAPITAL",
          reason: `배정 원금(${latestBot.allocated_capital}) 초과 차단 (보유=${currentInvested}, 대기=${pendingReserved}, 신규=${plannedBuyAmount})`,
        };
      }

      // 7. Layer 2: intent_bucket 유니크 선점 INSERT (PENDING) + virtual_krw 원자적 선차감
      const intentId = options?.intentId ? String(options.intentId) : crypto.randomUUID();
      const intentBucket = buildBuyIntentBucket(normBotId, normMkt, requestedStep, options);

      try {
        await db
          .prepare(
            `INSERT INTO live_order_intents (
               intent_id, bot_id, market, side, intent_bucket,
               requested_krw, requested_volume, target_position_uuid, upbit_order_uuid,
               status, refunded, error_message, created_at, updated_at
             ) VALUES (?, ?, ?, 'BUY', ?, ?, ?, NULL, NULL, 'PENDING', 0, NULL, ?, ?)`
          )
          .run(intentId, normBotId, normMkt, intentBucket, reservedKrw, limitVolumeStr, nowIso, nowIso);
      } catch (insErr) {
        const msg = String(insErr?.message || "");
        if (msg.includes("UNIQUE") || msg.includes("duplicate key") || msg.includes("PRIMARY KEY")) {
          const reason = `동일 캔들/차수 중복 매수 버킷(${intentBucket}) 유니크 제약 차단`;
          const blk = await recordBlockAndMaybeKillSwitchInTx(db, cfg, {
            botId: normBotId,
            market: normMkt,
            side: "BUY",
            code: "DUPLICATE_INTENT_BUCKET",
            reason,
            nowMs,
          });
          triggeredKillSwitch = blk.killSwitch;
          await commitWriteTx(db);
          return { ok: false, code: "DUPLICATE_INTENT_BUCKET", reason, blockCount: blk.blockCount, killSwitch: blk.killSwitch };
        }
        throw insErr;
      }

      const deductRes = await db
        .prepare(
          `UPDATE bots
           SET virtual_krw = virtual_krw - ?, updated_at = ?
           WHERE bot_id = ? AND virtual_krw >= ?`
        )
        .run(reservedKrw, nowKst, normBotId, reservedKrw);
      if (Number(deductRes?.changes || 0) !== 1) {
        await rollbackWriteTx(db);
        return { ok: false, code: "PRE_DEDUCT_CONFLICT", reason: "선차감 경합으로 매수 취소" };
      }

      try {
        await db
          .prepare(
            `UPDATE bot_accounts
             SET virtual_krw = MAX(0, virtual_krw - ?), updated_at = ?
             WHERE bot_id = ?`
          )
          .run(reservedKrw, nowKst, normBotId);
      } catch {}

      await commitWriteTx(db);

      return {
        ok: true,
        intentId,
        intentBucket,
        stepLevel: requestedStep,
        limitVolumeStr,
        limitVolNum,
        plannedBuyAmount,
        plannedFee,
        reservedKrw,
        currentInvested,
        latestBot: {
          ...latestBot,
          virtual_krw: availableVirtual - reservedKrw,
        },
      };
    } catch (err) {
      await rollbackWriteTx(db);
      throw err;
    }
  };

  const result = typeof withDbWriteLock === "function" ? await withDbWriteLock(runTx) : await runTx();

  if (triggeredKillSwitch && typeof onKillSwitch === "function") {
    Promise.resolve(onKillSwitch(triggeredKillSwitch)).catch(() => {});
  }

  return result;
}

/**
 * Step B 응답 수신 시 SUBMITTED 상태 및 upbit_order_uuid 기록
 */
export async function markLiveIntentSubmitted(db, { intentId, upbitOrderUuid }, deps = {}) {
  const { withDbWriteLock, beginWriteTx, commitWriteTx, rollbackWriteTx } = deps;
  const nowIso = new Date().toISOString();

  const runTx = async () => {
    try {
      await beginWriteTx(db);
      await db
        .prepare(
          `UPDATE live_order_intents
           SET upbit_order_uuid = ?, status = 'SUBMITTED', updated_at = ?
           WHERE intent_id = ? AND status IN ('PENDING', 'SUBMITTED')`
        )
        .run(upbitOrderUuid || null, nowIso, intentId);
      await commitWriteTx(db);
      return true;
    } catch {
      await rollbackWriteTx(db);
      return false;
    }
  };

  return typeof withDbWriteLock === "function" ? await withDbWriteLock(runTx) : await runTx();
}

/**
 * Step C 네트워크 타임아웃 / 5xx 발생 시 UNKNOWN_TIMEOUT 잠금 전환 (절대 즉시 환불/재시도 금지)
 * - 미해결 UNKNOWN_TIMEOUT >= threshold(기본 2건) 도달 시 자동 비상 정지(Auto Kill-Switch) 발동
 */
export async function markLiveIntentUnknownTimeout(db, { intentId, botId, market, errorMessage }, deps = {}) {
  const { runtimeConfig = {}, withDbWriteLock, beginWriteTx, commitWriteTx, rollbackWriteTx, onKillSwitch = null } = deps;
  const nowIso = new Date().toISOString();
  const nowKst = formatKstDateTimeLocal();
  const cfg = await getGuardrailConfig(db, runtimeConfig);

  let triggeredKillSwitch = null;

  const runTx = async () => {
    try {
      await beginWriteTx(db);
      await db
        .prepare(
          `UPDATE live_order_intents
           SET status = 'UNKNOWN_TIMEOUT', error_message = ?, updated_at = ?
           WHERE intent_id = ? AND status IN ('PENDING', 'SUBMITTED', 'UNKNOWN_TIMEOUT')`
        )
        .run(String(errorMessage || "Network timeout / uncertain status").slice(0, 400), nowIso, intentId);

      if (botId) {
        await db
          .prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?")
          .run(
            `[⏳ 타임아웃 정산 대기] ${market || ""} 주문 응답 지연(id=${String(intentId).slice(0, 8)}) — 거래소 identifier 확인 전 추가 매수 잠금`,
            nowKst,
            botId
          );
      }

      const timeoutRow = await db
        .prepare("SELECT COUNT(*) AS total_timeouts FROM live_order_intents WHERE status = 'UNKNOWN_TIMEOUT'")
        .get();
      const totalTimeouts = Number(timeoutRow?.total_timeouts || 0);
      if (totalTimeouts >= cfg.anomaly_timeout_threshold) {
        triggeredKillSwitch = await tripGuardrailKillSwitchInTx(db, {
          botIds: botId ? [botId] : [],
          haltAllLiveBots: true,
          code: "UNRESOLVED_TIMEOUT_ANOMALY",
          reason: `미해결 UNKNOWN_TIMEOUT 인텐트가 ${totalTimeouts}건(임계치 ${cfg.anomaly_timeout_threshold}건) 누적되어 실전 매매를 자동 비상 정지합니다.`,
        });
      }

      await commitWriteTx(db);
      return { ok: true, totalTimeouts, killSwitch: triggeredKillSwitch };
    } catch (err) {
      await rollbackWriteTx(db);
      throw err;
    }
  };

  const res = typeof withDbWriteLock === "function" ? await withDbWriteLock(runTx) : await runTx();
  if (triggeredKillSwitch && typeof onKillSwitch === "function") {
    Promise.resolve(onKillSwitch(triggeredKillSwitch)).catch(() => {});
  }
  return res;
}

/**
 * Step C 명확한 4xx 거절 또는 확인된 미체결 취소(CANCELED) 시 단 1회 원자적 환불
 * - WHERE intent_id = ? AND refunded = 0 조건으로 이중 환불 원천 차단
 */
export async function refundFailedOrCanceledBuyIntentAtomic(
  db,
  { intentId, botId, nextStatus = "FAILED_NOT_CREATED", errorMessage = null, statusMsg = null },
  deps = {}
) {
  const { withDbWriteLock, beginWriteTx, commitWriteTx, rollbackWriteTx } = deps;
  const nowIso = new Date().toISOString();
  const nowKst = formatKstDateTimeLocal();

  const runTx = async () => {
    try {
      await beginWriteTx(db);
      const intentRow = await db.prepare("SELECT * FROM live_order_intents WHERE intent_id = ?").get(intentId);
      if (!intentRow) {
        await commitWriteTx(db);
        return { refunded: false, amount: 0, reason: "INTENT_NOT_FOUND" };
      }

      const upd = await db
        .prepare(
          `UPDATE live_order_intents
           SET status = ?, refunded = 1, error_message = COALESCE(?, error_message), updated_at = ?
           WHERE intent_id = ? AND refunded = 0`
        )
        .run(nextStatus, errorMessage ? String(errorMessage).slice(0, 400) : null, nowIso, intentId);

      const refundKrw = Math.max(0, Math.floor(Number(intentRow.requested_krw || 0)));
      const targetBotId = botId || intentRow.bot_id;

      if (Number(upd?.changes || 0) === 1 && refundKrw > 0 && intentRow.side === "BUY") {
        await db
          .prepare("UPDATE bots SET virtual_krw = virtual_krw + ?, updated_at = ? WHERE bot_id = ?")
          .run(refundKrw, nowKst, targetBotId);
        try {
          await db
            .prepare("UPDATE bot_accounts SET virtual_krw = virtual_krw + ?, updated_at = ? WHERE bot_id = ?")
            .run(refundKrw, nowKst, targetBotId);
        } catch {}
      }

      if (statusMsg && targetBotId) {
        await db
          .prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?")
          .run(statusMsg, nowKst, targetBotId);
      }

      await commitWriteTx(db);
      return {
        refunded: Number(upd?.changes || 0) === 1,
        amount: Number(upd?.changes || 0) === 1 ? refundKrw : 0,
        status: nextStatus,
      };
    } catch (err) {
      await rollbackWriteTx(db);
      throw err;
    }
  };

  return typeof withDbWriteLock === "function" ? await withDbWriteLock(runTx) : await runTx();
}

/**
 * Step C 실전 매수 체결 확정 + 미사용 선차감 차액 단 1회 정산 + trades/bot_positions 멱등 기록
 */
export async function confirmBuyIntentAndRecordPositionAtomic(
  db,
  {
    intentId,
    botId,
    market,
    orderUuid,
    execPrice,
    execVolume,
    actualBuyAmount,
    fee,
    reservedKrw,
    stepLevel = 1,
    buyReason = null,
    expectedPrice = null,
    slippageBps = 0,
    atrSizingMult = 1.0,
    statusMsg = null,
  },
  deps = {}
) {
  const { withDbWriteLock, beginWriteTx, commitWriteTx, rollbackWriteTx, syncBotAccountsFromBots = null } = deps;
  const nowIso = new Date().toISOString();
  const nowKst = formatKstDateTimeLocal();

  const runTx = async () => {
    try {
      await beginWriteTx(db);

      const intentRow = await db.prepare("SELECT * FROM live_order_intents WHERE intent_id = ?").get(intentId);
      if (!intentRow) {
        await commitWriteTx(db);
        return { confirmed: false, alreadyConfirmed: false, reason: "INTENT_NOT_FOUND" };
      }

      // 멱등성 방어: 이미 CONFIRMED 이거나 동일 order_uuid 포지션이 존재하면 중복 INSERT/이중 환불 절대 금지
      const existingPos = orderUuid
        ? await db.prepare("SELECT id FROM bot_positions WHERE order_uuid = ?").get(orderUuid)
        : null;
      if (intentRow.status === "CONFIRMED" || existingPos) {
        if (intentRow.status !== "CONFIRMED") {
          await db
            .prepare("UPDATE live_order_intents SET upbit_order_uuid = COALESCE(upbit_order_uuid, ?), status = 'CONFIRMED', refunded = 1, updated_at = ? WHERE intent_id = ?")
            .run(orderUuid || null, nowIso, intentId);
        }
        await commitWriteTx(db);
        return { confirmed: true, alreadyConfirmed: true, positionId: existingPos?.id || null };
      }

      const safeBuyAmt = Math.max(0, Math.floor(Number(actualBuyAmount || 0)));
      const safeFee = Math.max(0, Math.floor(Number(fee || 0)));
      const safeReserved = Math.max(0, Math.floor(Number(reservedKrw ?? intentRow.requested_krw ?? 0)));
      const actualSpent = safeBuyAmt + safeFee;

      const updIntent = await db
        .prepare(
          `UPDATE live_order_intents
           SET upbit_order_uuid = ?, status = 'CONFIRMED', refunded = 1, error_message = NULL, updated_at = ?
           WHERE intent_id = ? AND refunded = 0`
        )
        .run(orderUuid || null, nowIso, intentId);

      // 선차감액과 실제 체결 소요액(원금+수수료)의 차액만 정확히 1회 정산
      const freshBot = await db.prepare("SELECT * FROM bots WHERE bot_id = ?").get(botId);
      const curVirtual = Math.max(0, Math.floor(Number(freshBot?.virtual_krw || 0)));
      let finalVirtual = curVirtual;
      if (Number(updIntent?.changes || 0) === 1) {
        const diff = safeReserved - actualSpent; // 양수면 미사용 선차감 잔여분 환불, 음수면 추가 차감
        finalVirtual = Math.max(0, curVirtual + diff);
      }

      const expPrice = Number(expectedPrice || execPrice);
      const trRes = await db
        .prepare(
          `INSERT INTO trades (
             bot_id, market, buy_order_uuid, sell_order_uuid,
             buy_price, buy_volume, buy_amount, buy_date,
             sell_price, sell_volume, sell_amount, sell_date,
             profit_krw, profit_pct, status, buy_reason,
             expected_price, slippage_bps, atr_sizing_mult
           ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 'HOLDING', ?, ?, ?, ?)`
        )
        .run(
          botId,
          market,
          orderUuid,
          Number(execPrice),
          String(execVolume),
          safeBuyAmt,
          nowKst,
          buyReason || null,
          expPrice,
          Number(slippageBps || 0),
          Number(atrSizingMult || 1.0)
        );
      const tradeId = Number(trRes?.lastInsertRowid || 0);

      const posRes = await db
        .prepare(
          `INSERT INTO bot_positions (
             bot_id, market, ticker, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id,
             highest_price, step_level, status, created_at, buy_reason,
             expected_price, slippage_bps, atr_sizing_mult, closing_lock
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, 0)`
        )
        .run(
          botId,
          market,
          market,
          orderUuid,
          String(execVolume),
          Number(execPrice),
          safeBuyAmt,
          safeFee,
          tradeId,
          Number(execPrice),
          Math.max(1, Math.floor(Number(stepLevel || 1))),
          nowKst,
          buyReason || null,
          expPrice,
          Number(slippageBps || 0),
          Number(atrSizingMult || 1.0)
        );

      const invRow = await db
        .prepare("SELECT COALESCE(SUM(buy_amount), 0) AS invested FROM bot_positions WHERE bot_id = ? AND status = 'OPEN'")
        .get(botId);
      const totalOpenInvested = Math.floor(Number(invRow?.invested || 0));
      const newAllocated = finalVirtual + totalOpenInvested;

      const finalStatusMsg =
        statusMsg ||
        `${market} 최유리 지정가(1호가 ${Number(execPrice).toLocaleString("ko-KR")}원) 매수 체결 (${safeBuyAmt.toLocaleString("ko-KR")}원 · 슬리피지 ${Number(slippageBps) >= 0 ? "+" : ""}${slippageBps}bps)`;

      await db
        .prepare("UPDATE bots SET allocated_capital = ?, virtual_krw = ?, last_status_msg = ?, updated_at = ? WHERE bot_id = ?")
        .run(newAllocated, finalVirtual, finalStatusMsg, nowKst, botId);

      if (typeof syncBotAccountsFromBots === "function") {
        await syncBotAccountsFromBots(db);
      }

      await commitWriteTx(db);
      return {
        confirmed: true,
        alreadyConfirmed: false,
        tradeId,
        positionId: Number(posRes?.lastInsertRowid || 0),
        finalVirtual,
        newAllocated,
      };
    } catch (err) {
      await rollbackWriteTx(db);
      throw err;
    }
  };

  return typeof withDbWriteLock === "function" ? await withDbWriteLock(runTx) : await runTx();
}

/**
 * [Layer 1 + Layer 3] 실전 매도(SELL) Step A: 동일 포지션(order_uuid) 중복 매도 원천 차단 선점
 * - 매수 쿨다운 / 매수 횟수 상한 / Graceful Drain(is_selected_for_live = 0) / is_running = 0 에 절대 차단되지 않음!
 */
export async function claimLiveSellIntentAtomic(db, params, deps = {}) {
  const { botId, positionId, sellPrice, floorTo8DecimalsStr, options = {} } = params;
  const { runtimeConfig = {}, withDbWriteLock, beginWriteTx, commitWriteTx, rollbackWriteTx } = deps;

  const normBotId = String(botId || "").trim();
  const nowMs = Number(options?.nowMs || Date.now());
  const nowIso = new Date(nowMs).toISOString();
  const cfg = await getGuardrailConfig(db, runtimeConfig);

  const runTx = async () => {
    try {
      await beginWriteTx(db);

      // Layer 1: 소유자 + 프로세스 리스 검증 (단, 매도 시 매수 쿨다운/캡/선택상태는 절대 검사하지 않음)
      const leaseRes = await acquireOrVerifyLeaseInTx(db, cfg, {
        engine: "node",
        ownerId: options?.leaseOwnerId || "node",
        pid: options?.leasePid,
        host: options?.leaseHost,
        nowMs,
      });
      if (!leaseRes.ok) {
        await commitWriteTx(db);
        console.warn(`[Guardrail][Layer1][${normBotId}] SELL 차단 (${leaseRes.code}): ${leaseRes.reason}`);
        return { ok: false, code: leaseRes.code, reason: leaseRes.reason };
      }

      // 대상 포지션 OPEN + closing_lock=0 원자적 확인
      const currentPos = await db
        .prepare("SELECT * FROM bot_positions WHERE id = ? AND bot_id = ? AND status = 'OPEN'")
        .get(positionId, normBotId);
      if (!currentPos) {
        await commitWriteTx(db);
        return { ok: false, code: "POSITION_NOT_OPEN", reason: "이미 청산되었거나 존재하지 않는 포지션입니다." };
      }
      if (Number(currentPos.closing_lock || 0) === 1) {
        await commitWriteTx(db);
        return { ok: false, code: "DUPLICATE_SELL_LOCKED", reason: `포지션(${currentPos.order_uuid})에 매도 락(closing_lock=1)이 활성화되어 중복 매도를 차단합니다.` };
      }

      const sameMarketOpen = await db
        .prepare(
          "SELECT * FROM bot_positions WHERE bot_id = ? AND market = ? AND status = 'OPEN' AND COALESCE(closing_lock, 0) = 0 ORDER BY id ASC"
        )
        .all(normBotId, currentPos.market);
      const singleEvalKrw = Number(currentPos.volume || 0) * Number(sellPrice || 0);
      const targetPositions =
        sameMarketOpen.length > 1 && singleEvalKrw < 5500 ? sameMarketOpen : [currentPos];

      const dbSumVolume = targetPositions.reduce((acc, p) => acc + Number(p.volume || 0), 0);
      if (dbSumVolume <= 0) {
        await commitWriteTx(db);
        return { ok: false, code: "INVALID_SELL_VOLUME", reason: "매도 수량이 0 이하입니다." };
      }

      const targetPositionUuid = String(currentPos.order_uuid || `pos-${currentPos.id}`);
      const sellBucket = buildSellIntentBucket(targetPositionUuid);
      const intentId = options?.intentId ? String(options.intentId) : crypto.randomUUID();
      const sellVolStr = typeof floorTo8DecimalsStr === "function" ? floorTo8DecimalsStr(dbSumVolume) : String(dbSumVolume);

      // 동일 target_position_uuid에 미확정/확정 매도 인텐트가 있으면 즉시 차단
      const existingSellIntent = await db
        .prepare(
          `SELECT intent_id, status
           FROM live_order_intents
           WHERE bot_id = ? AND market = ? AND side = 'SELL' AND intent_bucket = ?
             AND status IN ('PENDING', 'SUBMITTED', 'UNKNOWN_TIMEOUT', 'CONFIRMED')
           LIMIT 1`
        )
        .get(normBotId, currentPos.market, sellBucket);
      if (existingSellIntent) {
        await commitWriteTx(db);
        return {
          ok: false,
          code: "DUPLICATE_SELL_INTENT",
          reason: `포지션(${targetPositionUuid}) 매도 인텐트(${existingSellIntent.status})가 이미 존재하여 중복 매도를 차단합니다.`,
        };
      }

      // closing_lock = 1 원자적 선점
      for (const p of targetPositions) {
        const lockUpd = await db
          .prepare(
            "UPDATE bot_positions SET closing_lock = 1 WHERE id = ? AND bot_id = ? AND status = 'OPEN' AND COALESCE(closing_lock, 0) = 0"
          )
          .run(p.id, normBotId);
        if (Number(lockUpd?.changes || 0) !== 1) {
          await rollbackWriteTx(db);
          return { ok: false, code: "SELL_LOCK_CONTENTION", reason: "동시 매도 경합으로 선점에 실패했습니다." };
        }
      }

      // live_order_intents SELL 선점 INSERT (UNIQUE 버킷 잠금)
      try {
        await db
          .prepare(
            `INSERT INTO live_order_intents (
               intent_id, bot_id, market, side, intent_bucket,
               requested_krw, requested_volume, target_position_uuid, upbit_order_uuid,
               status, refunded, error_message, created_at, updated_at
             ) VALUES (?, ?, ?, 'SELL', ?, 0, ?, ?, NULL, 'PENDING', 0, NULL, ?, ?)`
          )
          .run(intentId, normBotId, currentPos.market, sellBucket, sellVolStr, targetPositionUuid, nowIso, nowIso);
      } catch (insErr) {
        const msg = String(insErr?.message || "");
        if (msg.includes("UNIQUE") || msg.includes("duplicate key")) {
          await rollbackWriteTx(db);
          return {
            ok: false,
            code: "DUPLICATE_SELL_BUCKET",
            reason: `매도 버킷(${sellBucket}) 유니크 제약으로 중복 매도를 차단했습니다.`,
          };
        }
        throw insErr;
      }

      await commitWriteTx(db);
      return {
        ok: true,
        intentId,
        intentBucket: sellBucket,
        targetPositionUuid,
        currentPos,
        targetPositions,
        dbSumVolume,
        sellVolStr,
      };
    } catch (err) {
      await rollbackWriteTx(db);
      throw err;
    }
  };

  return typeof withDbWriteLock === "function" ? await withDbWriteLock(runTx) : await runTx();
}

/**
 * 매도 주문이 업비트에 생성되지 않음이 확정된 실패(/v1/accounts 실패, locked, 4xx 거절 등) 시
 * 포지션이 영구 데드락되지 않도록 closing_lock 해제 및 버킷 아카이빙(이력 보존)
 */
export async function releaseFailedSellIntentAtomic(
  db,
  { intentId, targetPositionIds = [], targetPositionUuid = "", nextStatus = "FAILED_NOT_CREATED", errorMessage = null },
  deps = {}
) {
  const { withDbWriteLock, beginWriteTx, commitWriteTx, rollbackWriteTx } = deps;
  const nowIso = new Date().toISOString();

  const runTx = async () => {
    try {
      await beginWriteTx(db);
      const archivedBucket = `${buildSellIntentBucket(targetPositionUuid)}:${nextStatus.toLowerCase()}:${String(intentId).slice(0, 8)}`;
      await db
        .prepare(
          `UPDATE live_order_intents
           SET status = ?, intent_bucket = ?, error_message = ?, updated_at = ?
           WHERE intent_id = ? AND status IN ('PENDING', 'SUBMITTED', 'UNKNOWN_TIMEOUT')`
        )
        .run(nextStatus, archivedBucket, errorMessage ? String(errorMessage).slice(0, 400) : null, nowIso, intentId);

      for (const pid of targetPositionIds || []) {
        await db
          .prepare("UPDATE bot_positions SET closing_lock = 0 WHERE id = ? AND status = 'OPEN'")
          .run(pid);
      }
      await commitWriteTx(db);
      return true;
    } catch {
      await rollbackWriteTx(db);
      return false;
    }
  };

  return typeof withDbWriteLock === "function" ? await withDbWriteLock(runTx) : await runTx();
}

/**
 * 매도 체결 확정 시 SELL 인텐트 CONFIRMED 처리 및 closing_lock 정리
 */
export async function confirmSellIntentAtomic(db, { intentId, upbitOrderUuid = null, targetPositionIds = [] }, deps = {}) {
  const { withDbWriteLock, beginWriteTx, commitWriteTx, rollbackWriteTx } = deps;
  const nowIso = new Date().toISOString();

  const runTx = async () => {
    try {
      await beginWriteTx(db);
      await db
        .prepare(
          `UPDATE live_order_intents
           SET upbit_order_uuid = COALESCE(?, upbit_order_uuid), status = 'CONFIRMED', updated_at = ?
           WHERE intent_id = ?`
        )
        .run(upbitOrderUuid, nowIso, intentId);
      for (const pid of targetPositionIds || []) {
        await db.prepare("UPDATE bot_positions SET closing_lock = 0 WHERE id = ?").run(pid);
      }
      await commitWriteTx(db);
      return true;
    } catch {
      await rollbackWriteTx(db);
      return false;
    }
  };

  return typeof withDbWriteLock === "function" ? await withDbWriteLock(runTx) : await runTx();
}

/**
 * [Layer 2] UNKNOWN_TIMEOUT (및 장기 고착 PENDING/SUBMITTED) 인텐트 업비트 identifier 정산 함수
 * - GET /v1/order?identifier={intent_id} 로 거래소 실제 주문 존재 여부 확정
 * - 존재(200): 체결 완료/부분체결은 중복 없이 1회만 원장 확정, 미체결(wait)은 취소 후 재조회, 취소(0체결)는 1회 환불
 * - 미생성 확정(404 order_not_found): FAILED_NOT_CREATED 전환 및 선차감 원화 정확히 1회 환불 (이중 환불 불가)
 */
export async function reconcileUnknownTimeoutIntents(db, deps = {}, options = {}) {
  const {
    runtimeConfig = {},
    createUpbitJwt,
    cancelUpbitOrder,
    normalizeExecPrice,
    settleLiveSellOrderInDb,
    syncBotAccountsFromBots,
    withDbWriteLock,
    beginWriteTx,
    commitWriteTx,
    rollbackWriteTx,
    fetchImpl = globalThis.fetch,
  } = deps;

  const cfg = runtimeConfig || {};
  const accessKey = String(cfg.access_key || "").trim();
  const secretKey = String(cfg.secret_key || "").trim();
  if (!accessKey || !secretKey || accessKey === "YOUR_UPBIT_ACCESS_KEY") {
    return { checked: 0, confirmed: 0, refunded: 0, pending: 0, skipped: true };
  }

  const staleThresholdMs = Number(options?.stalePendingMs || 90 * 1000);
  const staleCutoffIso = new Date(Date.now() - staleThresholdMs).toISOString();

  const targets = await db
    .prepare(
      `SELECT * FROM live_order_intents
       WHERE status = 'UNKNOWN_TIMEOUT'
          OR (status IN ('PENDING', 'SUBMITTED') AND updated_at <= ?)
       ORDER BY created_at ASC`
    )
    .all(staleCutoffIso);

  const summary = { checked: 0, confirmed: 0, refunded: 0, pending: 0, details: [] };
  if (!Array.isArray(targets) || targets.length === 0) return summary;

  for (const intent of targets) {
    summary.checked++;
    const intentId = intent.intent_id;
    try {
      const qParams = { identifier: intentId };
      const qToken = createUpbitJwt(accessKey, secretKey, qParams);
      const resp = await fetchImpl(`https://api.upbit.com/v1/order?identifier=${encodeURIComponent(intentId)}`, {
        headers: {
          Authorization: `Bearer ${qToken}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(8000),
      });

      // 1) 거래소에 주문 자체가 생성되지 않았음이 확실한 404 (order_not_found)
      if (resp.status === 404) {
        if (intent.side === "BUY") {
          const refRes = await refundFailedOrCanceledBuyIntentAtomic(
            db,
            {
              intentId,
              botId: intent.bot_id,
              nextStatus: "FAILED_NOT_CREATED",
              errorMessage: "Upbit 404 order_not_found — 거래소 미생성 확정으로 선차감 원화 1회 안전 환불",
              statusMsg: `[✅ 타임아웃 정산] ${intent.market} 거래소 미생성 확정(404) — 선차감 ${Number(intent.requested_krw || 0).toLocaleString("ko-KR")}원 환불 완료`,
            },
            { withDbWriteLock, beginWriteTx, commitWriteTx, rollbackWriteTx }
          );
          if (refRes.refunded) summary.refunded++;
          summary.details.push({ intent_id: intentId, side: "BUY", action: "REFUNDED_404", refunded: refRes.refunded, amount: refRes.amount });
        } else {
          // SELL 404: 포지션 closing_lock 해제하여 재감시 가능하도록 복구
          const posRows = intent.target_position_uuid
            ? await db
                .prepare("SELECT id FROM bot_positions WHERE bot_id = ? AND order_uuid = ? AND status = 'OPEN'")
                .all(intent.bot_id, intent.target_position_uuid)
            : [];
          await releaseFailedSellIntentAtomic(
            db,
            {
              intentId,
              targetPositionIds: posRows.map((p) => p.id),
              targetPositionUuid: intent.target_position_uuid || intentId,
              nextStatus: "FAILED_NOT_CREATED",
              errorMessage: "Upbit 404 order_not_found — 매도 미생성 확정으로 포지션 락 해제",
            },
            { withDbWriteLock, beginWriteTx, commitWriteTx, rollbackWriteTx }
          );
          summary.refunded++;
          summary.details.push({ intent_id: intentId, side: "SELL", action: "UNLOCKED_404" });
        }
        continue;
      }

      // 2) 거래소에 주문 존재 확인 (HTTP 200)
      if (resp.status === 200) {
        let detail = await resp.json();
        let state = String(detail?.state || "").toLowerCase();
        const orderUuid = detail?.uuid || intent.upbit_order_uuid || `upbit-${intentId}`;

        // 미체결 대기(wait) 상태라면 취소 후 최종 체결량 재조회
        if (state === "wait" && orderUuid && typeof cancelUpbitOrder === "function") {
          await cancelUpbitOrder(orderUuid, cfg);
          try {
            const reToken = createUpbitJwt(accessKey, secretKey, qParams);
            const reResp = await fetchImpl(`https://api.upbit.com/v1/order?identifier=${encodeURIComponent(intentId)}`, {
              headers: { Authorization: `Bearer ${reToken}`, Accept: "application/json" },
              signal: AbortSignal.timeout(8000),
            });
            if (reResp.status === 200) {
              detail = await reResp.json();
              state = String(detail?.state || "").toLowerCase();
            }
          } catch {}
        }

        const filledVol = Number(detail?.executed_volume || 0);
        const tradesArr = Array.isArray(detail?.trades) ? detail.trades : [];
        const totalFunds = tradesArr.reduce((acc, t) => acc + Number(t.funds || 0), 0);

        if (intent.side === "BUY") {
          if (filledVol > 0) {
            const fallbackPrice = Number(detail?.price || 0) || (intent.requested_krw > 0 ? intent.requested_krw / filledVol : 0);
            const execPrice =
              totalFunds > 0
                ? typeof normalizeExecPrice === "function"
                  ? normalizeExecPrice(totalFunds / filledVol, fallbackPrice)
                  : totalFunds / filledVol
                : fallbackPrice;
            const actualBuyAmount = totalFunds > 0 ? Math.floor(totalFunds) : Math.floor(filledVol * execPrice);
            const fee =
              detail?.paid_fee !== undefined && detail?.paid_fee !== null
                ? Math.ceil(Number(detail.paid_fee || 0))
                : Math.floor(actualBuyAmount * 0.0005);

            const stepMatch = String(intent.intent_bucket || "").match(/:s(\d+)$/);
            const stepLevel = stepMatch ? Number(stepMatch[1]) : 1;

            const confRes = await confirmBuyIntentAndRecordPositionAtomic(
              db,
              {
                intentId,
                botId: intent.bot_id,
                market: intent.market,
                orderUuid,
                execPrice,
                execVolume: String(detail.executed_volume),
                actualBuyAmount,
                fee,
                reservedKrw: Number(intent.requested_krw || 0),
                stepLevel,
                buyReason: `[타임아웃 identifier 정산] ${intent.market}`,
                expectedPrice: execPrice,
                slippageBps: 0,
                atrSizingMult: 1.0,
                statusMsg: `[✅ 타임아웃 정산 완료] ${intent.market} 체결 확인(UUID=${orderUuid.slice(0, 8)}, ${actualBuyAmount.toLocaleString("ko-KR")}원)`,
              },
              { withDbWriteLock, beginWriteTx, commitWriteTx, rollbackWriteTx, syncBotAccountsFromBots }
            );
            summary.confirmed++;
            summary.details.push({ intent_id: intentId, side: "BUY", action: "CONFIRMED_200", already: confRes.alreadyConfirmed, uuid: orderUuid });
          } else if (state === "cancel" || state === "done") {
            const refRes = await refundFailedOrCanceledBuyIntentAtomic(
              db,
              {
                intentId,
                botId: intent.bot_id,
                nextStatus: "CANCELED",
                errorMessage: "Upbit 주문 미체결 취소(0체결) 확정 — 선차감 원화 1회 환불",
                statusMsg: `[✅ 타임아웃 정산] ${intent.market} 미체결 취소 확정 — 선차감 원화 환불 완료`,
              },
              { withDbWriteLock, beginWriteTx, commitWriteTx, rollbackWriteTx }
            );
            if (refRes.refunded) summary.refunded++;
            summary.details.push({ intent_id: intentId, side: "BUY", action: "CANCELED_REFUNDED_200", refunded: refRes.refunded });
          } else {
            summary.pending++;
            summary.details.push({ intent_id: intentId, side: "BUY", action: "STILL_WAIT" });
          }
        } else {
          // SELL 정산
          const openPosRows = intent.target_position_uuid
            ? await db
                .prepare("SELECT * FROM bot_positions WHERE bot_id = ? AND order_uuid = ? AND status = 'OPEN'")
                .all(intent.bot_id, intent.target_position_uuid)
            : [];
          if (filledVol > 0 && openPosRows.length > 0 && typeof settleLiveSellOrderInDb === "function") {
            const botRow = await db.prepare("SELECT * FROM bots WHERE bot_id = ?").get(intent.bot_id);
            const fallbackSellPrice = Number(detail?.price || openPosRows[0]?.avg_buy_price || 0);
            const avgSellPrice =
              totalFunds > 0
                ? typeof normalizeExecPrice === "function"
                  ? normalizeExecPrice(totalFunds / filledVol, fallbackSellPrice)
                  : totalFunds / filledVol
                : fallbackSellPrice;
            const actualFunds = totalFunds > 0 ? Math.floor(totalFunds) : Math.floor(filledVol * avgSellPrice);
            const actualFee =
              detail?.paid_fee !== undefined ? Math.ceil(Number(detail.paid_fee || 0)) : Math.floor(actualFunds * 0.0005);

            await settleLiveSellOrderInDb({
              db,
              bot: botRow || { bot_id: intent.bot_id },
              targetPositions: openPosRows,
              sellUuid: orderUuid,
              sellPrice: avgSellPrice,
              actualTotalFunds: actualFunds,
              actualTotalFee: actualFee,
              reasonLabel: "타임아웃매도정산",
            });
            await confirmSellIntentAtomic(
              db,
              { intentId, upbitOrderUuid: orderUuid, targetPositionIds: openPosRows.map((p) => p.id) },
              { withDbWriteLock, beginWriteTx, commitWriteTx, rollbackWriteTx }
            );
            summary.confirmed++;
            summary.details.push({ intent_id: intentId, side: "SELL", action: "CONFIRMED_200", uuid: orderUuid });
          } else if (filledVol > 0) {
            await confirmSellIntentAtomic(
              db,
              { intentId, upbitOrderUuid: orderUuid, targetPositionIds: openPosRows.map((p) => p.id) },
              { withDbWriteLock, beginWriteTx, commitWriteTx, rollbackWriteTx }
            );
            summary.confirmed++;
            summary.details.push({ intent_id: intentId, side: "SELL", action: "ALREADY_CLOSED_CONFIRMED" });
          } else if (state === "cancel") {
            await releaseFailedSellIntentAtomic(
              db,
              {
                intentId,
                targetPositionIds: openPosRows.map((p) => p.id),
                targetPositionUuid: intent.target_position_uuid || intentId,
                nextStatus: "CANCELED",
                errorMessage: "Upbit 매도 주문 미체결 취소 확정 — 포지션 락 해제",
              },
              { withDbWriteLock, beginWriteTx, commitWriteTx, rollbackWriteTx }
            );
            summary.refunded++;
            summary.details.push({ intent_id: intentId, side: "SELL", action: "CANCELED_UNLOCKED" });
          } else {
            summary.pending++;
          }
        }
        continue;
      }

      // 3) 5xx / 429 등 불확실 응답 -> UNKNOWN_TIMEOUT 상태 그대로 보존하여 다음 주기에 재정산
      summary.pending++;
      summary.details.push({ intent_id: intentId, side: intent.side, action: `RETRY_NEXT_HTTP_${resp.status}` });
    } catch (err) {
      summary.pending++;
      summary.details.push({ intent_id: intentId, side: intent.side, action: "RETRY_NEXT_ERR", error: err.message });
    }
  }

  return summary;
}

/**
 * 비상 정지 플래그 수동 해제 (UI/관리자 확인 후 복구용)
 */
export async function resetGuardrailEmergencyState(db, deps = {}) {
  const { withDbWriteLock, beginWriteTx, commitWriteTx, rollbackWriteTx } = deps;
  const nowKst = formatKstDateTimeLocal();

  const runTx = async () => {
    try {
      await beginWriteTx(db);
      const keys = [
        ["guardrail_emergency_halted", "0"],
        ["guardrail_emergency_code", ""],
        ["guardrail_emergency_reason", ""],
        ["guardrail_emergency_at", ""],
        ["guardrail_emergency_bots_json", "[]"],
      ];
      for (const [k, v] of keys) {
        await db
          .prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)")
          .run(k, v, nowKst);
      }
      await commitWriteTx(db);
      return { ok: true, reset_at: nowKst };
    } catch (err) {
      await rollbackWriteTx(db);
      throw err;
    }
  };

  return typeof withDbWriteLock === "function" ? await withDbWriteLock(runTx) : await runTx();
}

/**
 * GET /api/guardrail/status 및 GET /api/system/overview 용 5중 가드레일 실시간 상태 조회
 */
export async function getGuardrailStatus(db, runtimeConfig = {}, mutexState = {}) {
  const cfg = await getGuardrailConfig(db, runtimeConfig);
  const nowMs = Date.now();
  const todayStartUtcIso = getTodayStartKstUtcIso(nowMs);
  const hourCutoffIso = new Date(nowMs - 3600 * 1000).toISOString();
  const windowCutoffIso = new Date(nowMs - cfg.anomaly_window_sec * 1000).toISOString();

  let leaseRow = null;
  let leaseValid = false;
  let leaseOwnedByCurrent = false;
  try {
    leaseRow = await db.prepare("SELECT * FROM live_executor_lease WHERE id = 1").get();
    if (leaseRow) {
      const expMs = Date.parse(leaseRow.expires_at || "");
      leaseValid = Number.isFinite(expMs) && expMs > nowMs;
      leaseOwnedByCurrent =
        leaseValid &&
        String(leaseRow.owner_id) === "node" &&
        Number(leaseRow.pid) === process.pid &&
        String(leaseRow.host) === os.hostname();
    }
  } catch {}

  let todayTotalBuys = 0;
  let unresolvedTimeoutCount = 0;
  let pendingIntentCount = 0;
  let recentBlocks5m = 0;
  const perBot = {};
  let recentIntents = [];
  let recentBlocks = [];

  try {
    const tRow = await db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM live_order_intents
         WHERE side = 'BUY' AND status IN ('PENDING', 'SUBMITTED', 'UNKNOWN_TIMEOUT', 'CONFIRMED') AND created_at >= ?`
      )
      .get(todayStartUtcIso);
    todayTotalBuys = Number(tRow?.cnt || 0);

    const uRow = await db
      .prepare("SELECT COUNT(*) AS cnt FROM live_order_intents WHERE status = 'UNKNOWN_TIMEOUT'")
      .get();
    unresolvedTimeoutCount = Number(uRow?.cnt || 0);

    const pRow = await db
      .prepare("SELECT COUNT(*) AS cnt FROM live_order_intents WHERE status IN ('PENDING', 'SUBMITTED')")
      .get();
    pendingIntentCount = Number(pRow?.cnt || 0);

    const bRow = await db
      .prepare("SELECT COUNT(*) AS cnt FROM live_guardrail_events WHERE created_at >= ?")
      .get(windowCutoffIso);
    recentBlocks5m = Number(bRow?.cnt || 0);

    const hourRows = await db
      .prepare(
        `SELECT bot_id, COUNT(*) AS cnt FROM live_order_intents
         WHERE side = 'BUY' AND status IN ('PENDING', 'SUBMITTED', 'UNKNOWN_TIMEOUT', 'CONFIRMED') AND created_at >= ?
         GROUP BY bot_id`
      )
      .all(hourCutoffIso);
    for (const r of hourRows) {
      if (!perBot[r.bot_id]) perBot[r.bot_id] = { hour_buys: 0, day_buys: 0, blocks_5m: 0, unknown_timeouts: 0 };
      perBot[r.bot_id].hour_buys = Number(r.cnt || 0);
    }

    const dayRows = await db
      .prepare(
        `SELECT bot_id, COUNT(*) AS cnt FROM live_order_intents
         WHERE side = 'BUY' AND status IN ('PENDING', 'SUBMITTED', 'UNKNOWN_TIMEOUT', 'CONFIRMED') AND created_at >= ?
         GROUP BY bot_id`
      )
      .all(todayStartUtcIso);
    for (const r of dayRows) {
      if (!perBot[r.bot_id]) perBot[r.bot_id] = { hour_buys: 0, day_buys: 0, blocks_5m: 0, unknown_timeouts: 0 };
      perBot[r.bot_id].day_buys = Number(r.cnt || 0);
    }

    const blkRows = await db
      .prepare(
        `SELECT bot_id, COUNT(*) AS cnt FROM live_guardrail_events
         WHERE created_at >= ? GROUP BY bot_id`
      )
      .all(windowCutoffIso);
    for (const r of blkRows) {
      if (!perBot[r.bot_id]) perBot[r.bot_id] = { hour_buys: 0, day_buys: 0, blocks_5m: 0, unknown_timeouts: 0 };
      perBot[r.bot_id].blocks_5m = Number(r.cnt || 0);
    }

    const toRows = await db
      .prepare(
        `SELECT bot_id, COUNT(*) AS cnt FROM live_order_intents
         WHERE status = 'UNKNOWN_TIMEOUT' GROUP BY bot_id`
      )
      .all();
    for (const r of toRows) {
      if (!perBot[r.bot_id]) perBot[r.bot_id] = { hour_buys: 0, day_buys: 0, blocks_5m: 0, unknown_timeouts: 0 };
      perBot[r.bot_id].unknown_timeouts = Number(r.cnt || 0);
    }

    recentIntents = await db
      .prepare(
        `SELECT intent_id, bot_id, market, side, intent_bucket, requested_krw, requested_volume,
                upbit_order_uuid, status, refunded, error_message, created_at, updated_at
         FROM live_order_intents
         ORDER BY created_at DESC LIMIT 20`
      )
      .all();

    recentBlocks = await db
      .prepare(
        `SELECT id, bot_id, market, side, block_code, reason, created_at
         FROM live_guardrail_events
         ORDER BY id DESC LIMIT 20`
      )
      .all();
  } catch {}

  const readSetting = async (k, def = "") => {
    try {
      const row = await db.prepare("SELECT value FROM system_settings WHERE key = ?").get(k);
      return row?.value !== undefined && row?.value !== null ? String(row.value) : def;
    } catch {
      return def;
    }
  };

  const emergencyHalted = (await readSetting("guardrail_emergency_halted", "0")) === "1";
  const emergencyCode = await readSetting("guardrail_emergency_code", "");
  const emergencyReason = await readSetting("guardrail_emergency_reason", "");
  const emergencyAt = await readSetting("guardrail_emergency_at", "");
  let emergencyBots = [];
  try {
    const raw = await readSetting("guardrail_emergency_bots_json", "[]");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) emergencyBots = parsed;
  } catch {}

  const startedAtMs = Number(mutexState?.startedAtMs || 0);
  const isRunning = Boolean(mutexState?.isRunning);

  return {
    ok: true,
    live_executor_owner: cfg.live_executor_owner,
    current_engine: "node",
    is_owner_match: cfg.live_executor_owner === "node",
    lease: leaseRow
      ? {
          ...leaseRow,
          is_valid: leaseValid,
          owned_by_current_process: leaseOwnedByCurrent,
        }
      : {
          id: 1,
          owner_id: null,
          pid: null,
          host: null,
          acquired_at: null,
          heartbeat_at: null,
          expires_at: null,
          is_valid: false,
          owned_by_current_process: false,
        },
    mutex: {
      is_live_cycle_running: isRunning,
      started_at: startedAtMs > 0 ? new Date(startedAtMs).toISOString() : null,
      elapsed_ms: isRunning && startedAtMs > 0 ? Math.max(0, nowMs - startedAtMs) : 0,
      stale_warn_ms: LIVE_CYCLE_STALE_WARN_MS,
    },
    limits: {
      lease_ttl_sec: cfg.lease_ttl_sec,
      reentry_cooldown_sec: cfg.reentry_cooldown_sec,
      min_buy_interval_sec: cfg.min_buy_interval_sec,
      split_min_buy_interval_sec: cfg.split_min_buy_interval_sec,
      max_buys_per_bot_hour: cfg.max_buys_per_bot_hour,
      max_buys_per_bot_day: cfg.max_buys_per_bot_day,
      max_total_buys_day: cfg.max_total_buys_day,
      anomaly_block_threshold: cfg.anomaly_block_threshold,
      anomaly_window_sec: cfg.anomaly_window_sec,
      anomaly_timeout_threshold: cfg.anomaly_timeout_threshold,
    },
    counters: {
      today_total_buys: todayTotalBuys,
      unresolved_timeout_count: unresolvedTimeoutCount,
      pending_intent_count: pendingIntentCount,
      recent_blocks_5m: recentBlocks5m,
      per_bot: perBot,
    },
    emergency_halted: emergencyHalted,
    emergency_code: emergencyCode,
    emergency_reason: emergencyReason,
    emergency_at: emergencyAt,
    emergency_bots: emergencyBots,
    recent_intents: recentIntents,
    recent_blocks: recentBlocks,
  };
}
