/**
 * tests/verify_duplicate_order_guard.mjs
 *
 * 실전 연속 결제(중복 매수·중복 매도) 원천 차단 5중 하드 가드레일(Hard Guardrail) 자동화 스트레스 테스트
 * - 실제 운영 DB(data/auto_coin_trade.db) 및 실제 업비트 계좌 API를 단 1회도 호출하지 않습니다.
 * - 격리된 임시 SQLite DB + 인프로세스 Mock Upbit API(globalThis.fetch 인터셉트)로 7대 장애 시나리오를 100% 재현·검증합니다.
 * - 종료 시 임시 DB(-wal/-shm 포함)를 자동 삭제합니다.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_DIR = path.resolve(__dirname, "..");

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autocoin-guardrail-test-"));
const TEST_DB_PATH = path.join(TMP_DIR, "test_duplicate_guard.db");
const TEST_CONFIG_PATH = path.join(TMP_DIR, "upbit_config.test.json");

fs.writeFileSync(
  TEST_CONFIG_PATH,
  JSON.stringify(
    {
      access_key: "mock-access-key-for-stress-test",
      secret_key: "mock-secret-key-for-stress-test",
      trade_mode: "live",
      live_executor_owner: "node",
    },
    null,
    2
  ),
  "utf-8"
);

process.env.AUTOCOIN_DB_PATH = TEST_DB_PATH;
process.env.AUTOCOIN_CONFIG_PATH = TEST_CONFIG_PATH;
process.env.DB_MODE = "sqlite";
process.env.PG_SYNC_ENABLED = "false";
process.env.AUTOCOIN_LIBRARY_MODE = "1";
process.env.AUTOCOIN_FORCE_LIVE_MODE = "1";
process.env.LIVE_EXECUTOR_OWNER = "node";

const {
  getDb,
  initializeDatabase,
  getBots,
  executeBotBuyOrder,
  executeBotSellOrder,
  runLiveTradingBotsCycle,
  runAlwaysOnPaperArenaCycle,
  reconcileLiveOrderIntents,
  getLiveGuardrailStatusPayload,
  acquireLiveExecutorLease,
  releaseLiveExecutorLeaseNow,
  resetGuardrailEmergencyState,
  clearLiveCooldownCache,
} = await import("../backend/node_server.mjs");

const {
  refundFailedOrCanceledBuyIntentAtomic,
} = await import("../backend/common/live_order_guardrail.mjs");

const { sqliteDb } = await import("../backend/common/sqlite_db.mjs");

function cleanupTmpFiles() {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {}
}

function nowKstStr(offsetSec = 0) {
  const kst = new Date(Date.now() + 9 * 3600 * 1000 + offsetSec * 1000);
  const yyyy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kst.getUTCDate()).padStart(2, "0");
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mi = String(kst.getUTCMinutes()).padStart(2, "0");
  const ss = String(kst.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

/**
 * 인프로세스 Mock 업비트 거래소 서버 (실제 네트워크 호출 0회)
 */
class MockUpbitExchange {
  constructor() {
    this.reset();
  }

  reset() {
    this.ordersByUuid = new Map();
    this.ordersByIdentifier = new Map();
    this.postOrderCalls = [];
    this.getOrderCalls = [];
    this.nextBehavior = null; // { mode: 'TIMEOUT_AFTER_CREATE' | 'TIMEOUT_NO_CREATE' | 'HTTP_400' | 'SLOW_OK', delayMs?: number }
    this.tickerDelayMs = 0;
    this.balances = {
      KRW: 5000000,
      BTC: 1.0,
      ETH: 10.0,
      SOL: 100.0,
      XRP: 10000.0,
      DOGE: 50000.0,
      SUI: 5000.0,
      AVAX: 100.0,
      SHIB: 10000000.0,
    };
    this.prices = {
      "KRW-BTC": 100000000,
      "KRW-ETH": 4000000,
      "KRW-SOL": 200000,
      "KRW-XRP": 1000,
      "KRW-DOGE": 300,
      "KRW-SUI": 5000,
      "KRW-AVAX": 40000,
      "KRW-SHIB": 100,
    };
  }

  async handleFetch(url, init = {}) {
    const u = new URL(String(url));
    const pathname = u.pathname;
    const method = String(init?.method || "GET").toUpperCase();

    // 1. POST /v1/orders
    if (pathname === "/v1/orders" && method === "POST") {
      const body = JSON.parse(String(init?.body || "{}"));
      this.postOrderCalls.push({ ts: Date.now(), body });

      // 업비트 거래소 레벨 identifier 멱등성 재현
      if (body.identifier && this.ordersByIdentifier.has(body.identifier)) {
        return new Response(
          JSON.stringify({ error: { name: "duplicated_identifier", message: "이미 사용된 identifier 입니다." } }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const behavior = this.nextBehavior;
      if (behavior?.delayMs > 0) {
        await new Promise((r) => setTimeout(r, behavior.delayMs));
      }

      if (behavior?.mode === "TIMEOUT_NO_CREATE") {
        this.nextBehavior = null;
        const err = new Error("ETIMEDOUT: connect ETIMEDOUT api.upbit.com:443");
        err.code = "ETIMEDOUT";
        throw err;
      }

      if (behavior?.mode === "HTTP_400") {
        this.nextBehavior = null;
        return new Response(
          JSON.stringify({ error: { name: "insufficient_funds_bid", message: "주문 가능 금액이 부족합니다." } }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const market = body.market;
      const side = body.side;
      const unitPrice = Number(body.price || this.prices[market] || 100000);
      const volume = Number(body.volume || 0);
      const funds = Math.floor(unitPrice * volume);
      const fee = Math.ceil(funds * 0.0005);
      const orderUuid = `mock-upbit-${side}-${this.postOrderCalls.length}-${Date.now()}`;

      const orderRecord = {
        uuid: orderUuid,
        identifier: body.identifier || null,
        side,
        ord_type: body.ord_type,
        price: String(unitPrice),
        state: "done",
        market,
        volume: String(volume),
        executed_volume: String(volume),
        paid_fee: String(fee),
        trades: [
          {
            market,
            price: String(unitPrice),
            volume: String(volume),
            funds: String(funds),
            side,
          },
        ],
      };

      this.ordersByUuid.set(orderUuid, orderRecord);
      if (body.identifier) {
        this.ordersByIdentifier.set(body.identifier, orderRecord);
      }

      if (behavior?.mode === "TIMEOUT_AFTER_CREATE") {
        this.nextBehavior = null;
        const err = new Error("ETIMEDOUT: socket hang up after exchange accepted order");
        err.code = "ETIMEDOUT";
        throw err;
      }

      return new Response(JSON.stringify(orderRecord), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 2. GET /v1/order (?uuid=... or ?identifier=...)
    if (pathname === "/v1/order" && method === "GET") {
      const qUuid = u.searchParams.get("uuid");
      const qIdentifier = u.searchParams.get("identifier");
      this.getOrderCalls.push({ ts: Date.now(), uuid: qUuid, identifier: qIdentifier });

      const found = qIdentifier
        ? this.ordersByIdentifier.get(qIdentifier)
        : qUuid
        ? this.ordersByUuid.get(qUuid)
        : null;

      if (!found) {
        return new Response(
          JSON.stringify({ error: { name: "order_not_found", message: "주문을 찾지 못했습니다." } }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify(found), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 3. DELETE /v1/order
    if (pathname === "/v1/order" && method === "DELETE") {
      const qUuid = u.searchParams.get("uuid");
      const found = qUuid ? this.ordersByUuid.get(qUuid) : null;
      if (found) {
        found.state = "cancel";
        return new Response(JSON.stringify(found), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: { name: "order_not_found" } }), { status: 404 });
    }

    // 4. GET /v1/accounts
    if (pathname === "/v1/accounts" && method === "GET") {
      const list = Object.entries(this.balances).map(([currency, bal]) => ({
        currency,
        balance: String(bal),
        locked: "0",
        avg_buy_price: String(this.prices[`KRW-${currency}`] || 1),
        unit_currency: "KRW",
      }));
      return new Response(JSON.stringify(list), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // 5. GET /v1/orderbook
    if (pathname === "/v1/orderbook" && method === "GET") {
      const markets = (u.searchParams.get("markets") || "KRW-BTC").split(",");
      const list = markets.map((m) => {
        const p = this.prices[m] || 100000;
        return {
          market: m,
          orderbook_units: [
            { ask_price: p, bid_price: p, ask_size: 100, bid_size: 100 },
            { ask_price: p * 1.001, bid_price: p * 0.999, ask_size: 100, bid_size: 100 },
          ],
        };
      });
      return new Response(JSON.stringify(list), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // 6. GET /v1/ticker
    if (pathname === "/v1/ticker" && method === "GET") {
      if (this.tickerDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.tickerDelayMs));
      }
      const markets = (u.searchParams.get("markets") || "KRW-BTC").split(",");
      const list = markets.map((m) => {
        const p = this.prices[m] || 100000;
        return {
          market: m,
          trade_price: p,
          opening_price: p * 0.99,
          high_price: p * 1.01,
          low_price: p * 0.985,
          acc_trade_price_24h: 500_000_000_000,
          signed_change_rate: 0.015,
        };
      });
      return new Response(JSON.stringify(list), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // 7. GET /v1/market/all
    if (pathname === "/v1/market/all" && method === "GET") {
      const list = Object.keys(this.prices).map((m) => ({ market: m, korean_name: m, english_name: m }));
      return new Response(JSON.stringify(list), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // 8. GET /v1/candles/*
    if (pathname.startsWith("/v1/candles/") && method === "GET") {
      const m = u.searchParams.get("market") || "KRW-BTC";
      const count = Math.min(200, Math.max(20, Number(u.searchParams.get("count") || 60)));
      const basePrice = this.prices[m] || 100000;
      const candles = [];
      for (let i = 0; i < count; i++) {
        // newest first (Upbit convention), mild uptrend
        const p = Math.max(10, Math.round(basePrice * (1 - i * 0.001)));
        candles.push({
          market: m,
          candle_date_time_kst: nowKstStr(-i * 900).replace(" ", "T"),
          opening_price: p * 0.998,
          high_price: p * 1.005,
          low_price: p * 0.995,
          trade_price: p,
          candle_acc_trade_volume: 1000 + (i === 0 ? 2500 : 0),
          candle_acc_trade_price: p * (1000 + (i === 0 ? 2500 : 0)),
        });
      }
      return new Response(JSON.stringify(candles), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    throw new Error(`Unexpected external fetch intercepted in stress test: ${method} ${url}`);
  }
}

async function resetDbForScenario(db) {
  clearLiveCooldownCache();
  await db.exec(`
    DELETE FROM live_executor_lease;
    DELETE FROM live_order_intents;
    DELETE FROM live_guardrail_events;
    DELETE FROM bot_positions;
    DELETE FROM trades;
    DELETE FROM drain_handoff_logs;
    UPDATE bots
    SET is_selected_for_live = 0,
        is_running = 0,
        allocation_ratio = 0,
        allocated_capital = 0,
        virtual_krw = 0,
        last_status_msg = '초기화됨',
        paper_is_running = 1;
    UPDATE bot_accounts
    SET is_selected_for_live = 0,
        allocation_ratio = 0,
        allocated_capital = 0,
        virtual_krw = 0;
    INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES
      ('guardrail_emergency_halted', '0', '2026-11-19 00:00:00'),
      ('guardrail_emergency_code', '', '2026-11-19 00:00:00'),
      ('guardrail_emergency_reason', '', '2026-11-19 00:00:00'),
      ('guardrail_emergency_at', '', '2026-11-19 00:00:00'),
      ('guardrail_emergency_bots_json', '[]', '2026-11-19 00:00:00'),
      ('zero_balance_halted', '0', '2026-11-19 00:00:00'),
      ('live_reentry_cooldown_sec', '900', '2026-11-19 00:00:00'),
      ('live_min_buy_interval_sec', '60', '2026-11-19 00:00:00'),
      ('live_max_buys_per_bot_hour', '3', '2026-11-19 00:00:00'),
      ('live_max_buys_per_bot_day', '12', '2026-11-19 00:00:00'),
      ('live_max_total_buys_day', '30', '2026-11-19 00:00:00'),
      ('live_anomaly_block_threshold', '5', '2026-11-19 00:00:00'),
      ('live_anomaly_timeout_threshold', '2', '2026-11-19 00:00:00');
    INSERT OR REPLACE INTO market_regime_filter (
      id, sentiment_score, market_regime, risk_alert, recommended_action,
      position_size_multiplier, final_risk_alert, final_position_multiplier,
      final_bot_overrides_json, bot_overrides_json, blacklist_tickers_json
    ) VALUES (1, 0.25, 'BULL', 0, 'NORMAL', 1.0, 0, 1.0, '{}', '{}', '[]');
  `);
}

async function activateBot(db, botId, capitalKrw = 500000, ratio = 100) {
  await db
    .prepare(
      `UPDATE bots
       SET is_selected_for_live = 1, is_running = 1, allocation_ratio = ?,
           allocated_capital = ?, virtual_krw = ?, last_status_msg = '가동 중'
       WHERE bot_id = ?`
    )
    .run(ratio, capitalKrw, capitalKrw, botId);
  await db
    .prepare(
      `UPDATE bot_accounts
       SET is_selected_for_live = 1, allocation_ratio = ?,
           allocated_capital = ?, virtual_krw = ?
       WHERE bot_id = ?`
    )
    .run(ratio, capitalKrw, capitalKrw, botId);
}

const origFetch = globalThis.fetch;
const mockUpbit = new MockUpbitExchange();
const results = [];

function recordPass(id, name, metrics) {
  results.push({ id, name, status: "PASS", metrics });
  console.log(`✅ [${id}] ${name} -> PASS (${metrics})`);
}

async function main() {
  globalThis.fetch = (url, init) => mockUpbit.handleFetch(url, init);
  try {
    await initializeDatabase();
    const db = getDb();

    // =========================================================================
    // [Test 1] 동시 다발 중복 매수 (Concurrency Storm) + Layer 1 소유자·리스 락 검증
    // =========================================================================
    await resetDbForScenario(db);
    mockUpbit.reset();
    await activateBot(db, "bot_01", 500000, 100);

    // 1-A. Layer 1 LIVE_EXECUTOR_OWNER 불일치 시 하드 차단 검증
    process.env.LIVE_EXECUTOR_OWNER = "python";
    const ownerBlocked = await executeBotBuyOrder(
      { bot_id: "bot_01" },
      "KRW-BTC",
      50000,
      100000000,
      "owner-mismatch-test",
      { skipDelay: true, pollIntervalMs: 0 }
    );
    assert.equal(ownerBlocked, false, "LIVE_EXECUTOR_OWNER='python' must hard-block Node live buy");
    assert.equal(mockUpbit.postOrderCalls.length, 0, "0 Upbit POST calls allowed on owner mismatch");
    process.env.LIVE_EXECUTOR_OWNER = "node";

    // 1-B. Layer 1 타 프로세스(좀비 프로세스) 리스 락 점유 시 하드 차단 검증
    const futureExp = new Date(Date.now() + 30000).toISOString();
    const nowIso = new Date().toISOString();
    await db
      .prepare(
        "INSERT OR REPLACE INTO live_executor_lease (id, owner_id, pid, host, acquired_at, heartbeat_at, expires_at) VALUES (1, 'node', 999999, 'zombie-host', ?, ?, ?)"
      )
      .run(nowIso, nowIso, futureExp);
    const leaseBlocked = await executeBotBuyOrder(
      { bot_id: "bot_01" },
      "KRW-BTC",
      50000,
      100000000,
      "lease-conflict-test",
      { skipDelay: true, pollIntervalMs: 0 }
    );
    assert.equal(leaseBlocked, false, "Active rival process lease must hard-block live buy");
    assert.equal(mockUpbit.postOrderCalls.length, 0, "0 Upbit POST calls allowed when rival holds lease");
    await db.exec("DELETE FROM live_executor_lease;");

    // 1-C. Concurrency Storm: 동일 (bot_01, KRW-BTC) 5회 동시 Promise.all 호출
    mockUpbit.nextBehavior = { mode: "SLOW_OK", delayMs: 60 };
    const stormOutcomes = await Promise.all(
      Array.from({ length: 5 }, (_, idx) =>
        executeBotBuyOrder(
          { bot_id: "bot_01" },
          "KRW-BTC",
          50000,
          100000000,
          `storm-signal-${idx + 1}`,
          { skipDelay: true, pollIntervalMs: 0, pollAttempts: 1 }
        )
      )
    );
    const stormSuccessCnt = stormOutcomes.filter(Boolean).length;
    assert.equal(stormSuccessCnt, 1, `Expected exactly 1 buy success in 5x Promise.all storm, got ${stormSuccessCnt}`);
    assert.equal(mockUpbit.postOrderCalls.length, 1, "Mock Upbit POST /v1/orders must be called EXACTLY ONCE");
    assert.ok(mockUpbit.postOrderCalls[0].body.identifier, "Upbit POST /v1/orders MUST include non-empty identifier UUID");

    const posT1 = await db.prepare("SELECT * FROM bot_positions WHERE bot_id = 'bot_01' AND status = 'OPEN'").all();
    assert.equal(posT1.length, 1, "Exactly 1 OPEN bot_positions row must exist");
    const bot1After = await db.prepare("SELECT virtual_krw FROM bots WHERE bot_id = 'bot_01'").get();
    const expectedVirtualT1 = 500000 - Number(posT1[0].buy_amount) - Number(posT1[0].buy_fee);
    assert.equal(Number(bot1After.virtual_krw), expectedVirtualT1, "virtual_krw must be deducted EXACTLY ONCE");

    recordPass(
      "Test 1",
      "동시 다발 중복 매수 (5x Promise.all Storm) + Owner/Lease 락",
      `Upbit전송=1/5건, 차단=4건, 원화차감=1회(${(500000 - expectedVirtualT1).toLocaleString("ko-KR")}원), identifier포함=OK`
    );

    // =========================================================================
    // [Test 2] 주문 직후 네트워크 타임아웃 + identifier 체결 정산
    // =========================================================================
    await resetDbForScenario(db);
    mockUpbit.reset();
    await activateBot(db, "bot_02", 400000, 100);

    // Mock: 거래소에 주문 생성·체결 완료 후 응답 직전 ETIMEDOUT 발생
    mockUpbit.nextBehavior = { mode: "TIMEOUT_AFTER_CREATE" };
    const t2First = await executeBotBuyOrder(
      { bot_id: "bot_02" },
      "KRW-ETH",
      50000,
      4000000,
      "timeout-after-create",
      { skipDelay: true, pollIntervalMs: 0, pollAttempts: 1 }
    );
    assert.equal(t2First, false, "Timed-out buy must return false (pending reconciliation)");
    assert.equal(mockUpbit.postOrderCalls.length, 1, "Exactly 1 POST attempt made before timeout (NO blind retry)");

    const t2Intent = await db.prepare("SELECT * FROM live_order_intents WHERE bot_id = 'bot_02' AND market = 'KRW-ETH'").get();
    assert.equal(t2Intent.status, "UNKNOWN_TIMEOUT", "Intent status must be UNKNOWN_TIMEOUT");
    assert.equal(Number(t2Intent.refunded), 0, "Timed-out intent must NOT be refunded prematurely");
    const bot2LockedRow = await db.prepare("SELECT virtual_krw FROM bots WHERE bot_id = 'bot_02'").get();
    assert.ok(Number(bot2LockedRow.virtual_krw) < 400000, "Pre-deducted KRW must stay locked while UNKNOWN_TIMEOUT");

    // 다음 사이클 재매수 시도 -> 100% 차단 확인
    const t2SecondBlocked = await executeBotBuyOrder(
      { bot_id: "bot_02" },
      "KRW-ETH",
      50000,
      4000000,
      "next-cycle-rebuy-attempt",
      { skipDelay: true, pollIntervalMs: 0, intentBucket: "bot_02:KRW-ETH:next-candle:s1", ignoreMinInterval: true }
    );
    assert.equal(t2SecondBlocked, false, "Re-buy MUST be 100% blocked while UNKNOWN_TIMEOUT intent is unresolved");
    assert.equal(mockUpbit.postOrderCalls.length, 1, "NO second POST /v1/orders allowed while UNKNOWN_TIMEOUT");

    // 정산 함수(reconcileLiveOrderIntents) 실행 -> identifier 조회(200) -> 1건 확정 반영
    const recT2 = await reconcileLiveOrderIntents();
    assert.equal(recT2.confirmed, 1, "Reconciliation must confirm the 1 filled order via identifier");
    assert.ok(
      mockUpbit.getOrderCalls.some((c) => c.identifier === t2Intent.intent_id),
      "Reconciliation MUST query GET /v1/order?identifier={intent_id}"
    );
    const t2IntentAfter = await db.prepare("SELECT * FROM live_order_intents WHERE intent_id = ?").get(t2Intent.intent_id);
    assert.equal(t2IntentAfter.status, "CONFIRMED", "Intent status must transition to CONFIRMED");
    assert.equal(Number(t2IntentAfter.refunded), 1, "Settled intent refunded flag must be 1");

    const posT2 = await db.prepare("SELECT * FROM bot_positions WHERE bot_id = 'bot_02' AND status = 'OPEN'").all();
    assert.equal(posT2.length, 1, "Exactly 1 bot_positions row must be recorded after reconciliation");
    const virtualAfterRec1 = Number((await db.prepare("SELECT virtual_krw FROM bots WHERE bot_id = 'bot_02'").get()).virtual_krw);

    // 멱등성 재검증: 정산 함수 2회차 호출해도 중복 포지션/이중 정산 없음
    await reconcileLiveOrderIntents();
    const posT2Again = await db.prepare("SELECT * FROM bot_positions WHERE bot_id = 'bot_02' AND status = 'OPEN'").all();
    assert.equal(posT2Again.length, 1, "Re-running reconciliation must not duplicate positions");
    const virtualAfterRec2 = Number((await db.prepare("SELECT virtual_krw FROM bots WHERE bot_id = 'bot_02'").get()).virtual_krw);
    assert.equal(virtualAfterRec2, virtualAfterRec1, "Re-running reconciliation must not alter virtual_krw");

    recordPass(
      "Test 2",
      "주문 직후 네트워크 타임아웃 + identifier 체결 정산",
      `UNKNOWN_TIMEOUT잠금=OK, 재매수차단=100%, identifier조회정산=1건확정, 중복포지션=0건`
    );

    // =========================================================================
    // [Test 3] 타임아웃 후 거래소 order_not_found(404) 안전 환불 (이중 환불 원천 차단)
    // =========================================================================
    await resetDbForScenario(db);
    mockUpbit.reset();
    await activateBot(db, "bot_03", 200000, 100);

    // Mock: 거래소에 주문 자체가 생성되지 않은 상태로 ETIMEDOUT
    mockUpbit.nextBehavior = { mode: "TIMEOUT_NO_CREATE" };
    const t3First = await executeBotBuyOrder(
      { bot_id: "bot_03" },
      "KRW-SOL",
      50000,
      200000,
      "timeout-no-create",
      { skipDelay: true, pollIntervalMs: 0, pollAttempts: 1 }
    );
    assert.equal(t3First, false, "Timeout without creation must return false");

    const t3Intent = await db.prepare("SELECT * FROM live_order_intents WHERE bot_id = 'bot_03'").get();
    assert.equal(t3Intent.status, "UNKNOWN_TIMEOUT", "Intent must be UNKNOWN_TIMEOUT before reconciliation");
    assert.equal(Number(t3Intent.refunded), 0, "Must not refund before 404 confirmation");
    const bot3PreRefund = Number((await db.prepare("SELECT virtual_krw FROM bots WHERE bot_id = 'bot_03'").get()).virtual_krw);
    assert.equal(bot3PreRefund, 200000 - Number(t3Intent.requested_krw), "virtual_krw must reflect exact pre-deduction");

    // 1차 정산 -> 404 확인 -> FAILED_NOT_CREATED + 정확히 1회 환불
    const recT3_1 = await reconcileLiveOrderIntents();
    assert.equal(recT3_1.refunded, 1, "404 order_not_found must refund exactly 1 intent");
    const t3After1 = await db.prepare("SELECT * FROM live_order_intents WHERE intent_id = ?").get(t3Intent.intent_id);
    assert.equal(t3After1.status, "FAILED_NOT_CREATED", "Status must transition to FAILED_NOT_CREATED");
    assert.equal(Number(t3After1.refunded), 1, "refunded flag must be 1");
    const bot3AfterRefund1 = Number((await db.prepare("SELECT virtual_krw FROM bots WHERE bot_id = 'bot_03'").get()).virtual_krw);
    assert.equal(bot3AfterRefund1, 200000, "Full pre-deducted KRW must be restored to 200,000 KRW");

    // 2차 정산 & 직접 중복 환불 시도 -> 이중 환불 절대 불가!
    const recT3_2 = await reconcileLiveOrderIntents();
    assert.equal(recT3_2.refunded, 0, "Second reconciliation must NOT refund again");
    const directDupRefund = await refundFailedOrCanceledBuyIntentAtomic(
      db,
      { intentId: t3Intent.intent_id, botId: "bot_03", nextStatus: "FAILED_NOT_CREATED" },
      {
        beginWriteTx: async (d) => d.exec("BEGIN IMMEDIATE"),
        commitWriteTx: async (d) => d.exec("COMMIT"),
        rollbackWriteTx: async (d) => { try { await d.exec("ROLLBACK"); } catch {} },
      }
    );
    assert.equal(directDupRefund.refunded, false, "Direct duplicate refund attempt must be rejected by refunded=0 guard");
    const bot3AfterRefund2 = Number((await db.prepare("SELECT virtual_krw FROM bots WHERE bot_id = 'bot_03'").get()).virtual_krw);
    assert.equal(bot3AfterRefund2, 200000, "virtual_krw must remain strictly 200,000 KRW (ZERO double refund)");

    recordPass(
      "Test 3",
      "타임아웃 후 404 order_not_found 1회 안전 환불 & 이중 환불 차단",
      `선차감복구=200,000원, 2차정산환불=0건, 직접중복환불차단=OK`
    );

    // =========================================================================
    // [Test 4] 동일 캔들 무한 손절·재매수(Churn) 15분 재진입 쿨다운 차단
    // =========================================================================
    await resetDbForScenario(db);
    mockUpbit.reset();
    await activateBot(db, "bot_04", 300000, 100);

    const t4Buy1 = await executeBotBuyOrder(
      { bot_id: "bot_04" },
      "KRW-XRP",
      50000,
      1000,
      "churn-initial-buy",
      { skipDelay: true, pollIntervalMs: 0, pollAttempts: 1 }
    );
    assert.equal(t4Buy1, true, "Initial buy must succeed");
    const posT4 = await db.prepare("SELECT * FROM bot_positions WHERE bot_id = 'bot_04' AND status = 'OPEN'").get();
    assert.ok(posT4, "Position must be open");

    // 30초 뒤 손절 매도 실행
    const t4Sell = await executeBotSellOrder(
      { bot_id: "bot_04", nickname: "스퀴즈" },
      posT4,
      970,
      "손절(-3.00%)",
      { skipDelay: true, sellPollIntervalMs: 0 }
    );
    assert.equal(t4Sell, true, "Stop-loss sell must succeed");
    const postCountBeforeRebuy = mockUpbit.postOrderCalls.length;

    // 즉시 동일 티커 재매수 시그널 주입 (별도 버킷+최소간격 무시 옵션으로 순수 15분 재진입 쿨다운 검증)
    const t4Rebuy = await executeBotBuyOrder(
      { bot_id: "bot_04" },
      "KRW-XRP",
      50000,
      975,
      "immediate-churn-rebuy",
      {
        skipDelay: true,
        pollIntervalMs: 0,
        intentBucket: "bot_04:KRW-XRP:next-bucket:s1",
        ignoreMinInterval: true,
        nowMs: Date.now() + 30 * 1000, // 30초 경과 (< 900초)
      }
    );
    assert.equal(t4Rebuy, false, "Immediate re-buy within 15-min cooldown MUST be blocked");
    assert.equal(mockUpbit.postOrderCalls.length, postCountBeforeRebuy, "0 Upbit buy calls allowed during 15m cooldown");
    const cdEvent = await db
      .prepare("SELECT block_code FROM live_guardrail_events WHERE bot_id = 'bot_04' ORDER BY id DESC LIMIT 1")
      .get();
    assert.equal(cdEvent?.block_code, "REENTRY_COOLDOWN", "Block event must record REENTRY_COOLDOWN");

    recordPass(
      "Test 4",
      "동일 캔들 무한 손절·재매수(Churn) 15분 쿨다운 차단",
      `매수->30초후손절->즉시재매수차단=100%, 코드=REENTRY_COOLDOWN`
    );

    // =========================================================================
    // [Test 5] 시간당/일일 Hard Cap · 이상 감지 비상 정지(Auto Kill-Switch) · Phase 3 Mutex
    // =========================================================================
    await resetDbForScenario(db);
    mockUpbit.reset();
    await activateBot(db, "bot_05", 500000, 40);
    await activateBot(db, "bot_07", 500000, 30);
    await activateBot(db, "bot_08", 500000, 30);

    // 5-A. 시간당 상한 (봇별 3회/시간)
    const ago10m = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    for (let i = 1; i <= 3; i++) {
      await db
        .prepare(
          `INSERT INTO live_order_intents (
             intent_id, bot_id, market, side, intent_bucket, requested_krw, requested_volume,
             status, refunded, created_at, updated_at
           ) VALUES (?, 'bot_05', ?, 'BUY', ?, 20000, '1', 'CONFIRMED', 1, ?, ?)`
        )
        .run(`hr-seed-${i}`, `KRW-T${i}`, `bot_05:KRW-T${i}:h${i}:s1`, ago10m, ago10m);
    }
    const hrBlocked = await executeBotBuyOrder(
      { bot_id: "bot_05" },
      "KRW-BTC",
      20000,
      100000000,
      "hourly-cap-test",
      { skipDelay: true, pollIntervalMs: 0, intentBucket: "bot_05:KRW-BTC:hr-check:s1" }
    );
    assert.equal(hrBlocked, false, "4th buy within 1 hour must be blocked by BOT_HOURLY_BUY_CAP");
    const lastEvt5A = await db.prepare("SELECT block_code FROM live_guardrail_events WHERE bot_id = 'bot_05' ORDER BY id DESC LIMIT 1").get();
    assert.equal(lastEvt5A?.block_code, "BOT_HOURLY_BUY_CAP", "Must log BOT_HOURLY_BUY_CAP");

    // 5-B. 일일 봇별 상한 (12회/일, 00:00 KST 기준) — 시간당 상한을 피해 오늘 00:00 KST 이후(단, 2시간 전 또는 KST 자정+1초)로 시드
    const nowMs = Date.now();
    const kstNow = new Date(nowMs + 9 * 3600 * 1000);
    const midnightKstUtcMs =
      Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate(), 0, 0, 0, 0) - 9 * 3600 * 1000;
    const todayOlderIso = new Date(Math.min(midnightKstUtcMs + 60 * 1000, nowMs - 70 * 60 * 1000)).toISOString();
    // 만약 현재 KST가 00:00~01:10 사이라면 시드 시각을 자정+1초로 맞추고 bot_07 시간당 상한을 임시 상향해 순수 일일 상한 검증
    const seedDayIso = new Date(Math.max(midnightKstUtcMs + 1000, Math.min(nowMs - 70 * 60 * 1000, nowMs - 120 * 1000))).toISOString();
    if (Date.parse(seedDayIso) >= nowMs - 3600 * 1000) {
      await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('live_max_buys_per_bot_hour', '50', ?)").run(nowKstStr());
    }
    for (let i = 1; i <= 12; i++) {
      await db
        .prepare(
          `INSERT INTO live_order_intents (
             intent_id, bot_id, market, side, intent_bucket, requested_krw, requested_volume,
             status, refunded, created_at, updated_at
           ) VALUES (?, 'bot_07', ?, 'BUY', ?, 20000, '1', 'CONFIRMED', 1, ?, ?)`
        )
        .run(`day-seed-b7-${i}`, `KRW-D${i}`, `bot_07:KRW-D${i}:d${i}:s1`, seedDayIso, seedDayIso);
    }
    const dayBlocked = await executeBotBuyOrder(
      { bot_id: "bot_07" },
      "KRW-BTC",
      20000,
      100000000,
      "daily-cap-test",
      { skipDelay: true, pollIntervalMs: 0, intentBucket: "bot_07:KRW-BTC:day-check:s1", ignoreMinInterval: true }
    );
    assert.equal(dayBlocked, false, "13th buy on same day must be blocked by BOT_DAILY_BUY_CAP");
    const lastEvt5B = await db.prepare("SELECT block_code FROM live_guardrail_events WHERE bot_id = 'bot_07' ORDER BY id DESC LIMIT 1").get();
    assert.equal(lastEvt5B?.block_code, "BOT_DAILY_BUY_CAP", "Must log BOT_DAILY_BUY_CAP");

    // 5-C. 전체 실전 풀 일일 상한 (30회/일) — 기존 3 + 12 = 15건에 15건 추가해 30건 채운 뒤 신규 봇(bot_08) 차단 검증
    for (let i = 1; i <= 15; i++) {
      await db
        .prepare(
          `INSERT INTO live_order_intents (
             intent_id, bot_id, market, side, intent_bucket, requested_krw, requested_volume,
             status, refunded, created_at, updated_at
           ) VALUES (?, 'bot_09', ?, 'BUY', ?, 20000, '1', 'CONFIRMED', 1, ?, ?)`
        )
        .run(`gday-seed-${i}`, `KRW-G${i}`, `bot_09:KRW-G${i}:g${i}:s1`, seedDayIso, seedDayIso);
    }
    const globalDayBlocked = await executeBotBuyOrder(
      { bot_id: "bot_08" },
      "KRW-ETH",
      20000,
      4000000,
      "global-daily-cap-test",
      { skipDelay: true, pollIntervalMs: 0, intentBucket: "bot_08:KRW-ETH:gday-check:s1" }
    );
    assert.equal(globalDayBlocked, false, "31st global live buy today must be blocked by GLOBAL_DAILY_BUY_CAP");
    const lastEvt5C = await db.prepare("SELECT block_code FROM live_guardrail_events WHERE bot_id = 'bot_08' ORDER BY id DESC LIMIT 1").get();
    assert.equal(lastEvt5C?.block_code, "GLOBAL_DAILY_BUY_CAP", "Must log GLOBAL_DAILY_BUY_CAP");

    // 5-D. 5분 내 동일 봇 5회 차단 누적 시 자동 비상 정지(Auto Kill-Switch: is_running = 0)
    // bot_05는 5-A에서 이미 1회 차단됨 -> 4회 추가 차단 발생시켜 총 5회 달성
    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('live_max_buys_per_bot_hour', '3', ?)").run(nowKstStr());
    for (let k = 2; k <= 5; k++) {
      await executeBotBuyOrder(
        { bot_id: "bot_05" },
        "KRW-BTC",
        20000,
        100000000,
        `anomaly-burst-${k}`,
        { skipDelay: true, pollIntervalMs: 0, intentBucket: `bot_05:KRW-BTC:burst-${k}:s1` }
      );
    }
    const bot5AfterKill = await db.prepare("SELECT is_running, last_status_msg FROM bots WHERE bot_id = 'bot_05'").get();
    assert.equal(Number(bot5AfterKill.is_running), 0, "Auto Kill-Switch MUST set bots.is_running = 0 after 5 blocks in 5m");
    assert.ok(String(bot5AfterKill.last_status_msg).includes("비상 정지"), "last_status_msg must record emergency stop reason");

    const grStatus = await getLiveGuardrailStatusPayload();
    assert.equal(grStatus.emergency_halted, true, "GET /api/guardrail/status payload must expose emergency_halted = true");
    assert.equal(grStatus.emergency_code, "REPEATED_BLOCK_ANOMALY", "emergency_code must be REPEATED_BLOCK_ANOMALY");
    assert.equal(mockUpbit.postOrderCalls.length, 0, "0 Upbit orders allowed across all cap/kill-switch tests");

    // 5-E. virtual_krw < 0 이상치 즉시 비상 정지 검증
    await db.prepare("UPDATE bots SET is_running = 1, virtual_krw = -500 WHERE bot_id = 'bot_08'").run();
    const negRes = await executeBotBuyOrder({ bot_id: "bot_08" }, "KRW-BTC", 10000, 100000000, "neg-balance-test", { skipDelay: true });
    assert.equal(negRes, false, "Negative virtual_krw must block order");
    const bot8Neg = await db.prepare("SELECT is_running FROM bots WHERE bot_id = 'bot_08'").get();
    assert.equal(Number(bot8Neg.is_running), 0, "Negative virtual_krw must auto-halt bot (is_running = 0)");

    // 5-E2. 미해결 UNKNOWN_TIMEOUT 2건 이상 발생 시 자동 비상 정지 검증
    await resetDbForScenario(db);
    mockUpbit.reset();
    await activateBot(db, "bot_01", 300000, 50);
    await activateBot(db, "bot_02", 300000, 50);
    mockUpbit.nextBehavior = { mode: "TIMEOUT_NO_CREATE" };
    await executeBotBuyOrder({ bot_id: "bot_01" }, "KRW-BTC", 50000, 100000000, "to-1", { skipDelay: true, pollIntervalMs: 0 });
    mockUpbit.nextBehavior = { mode: "TIMEOUT_NO_CREATE" };
    await executeBotBuyOrder({ bot_id: "bot_02" }, "KRW-ETH", 50000, 4000000, "to-2", { skipDelay: true, pollIntervalMs: 0 });
    const toStatus = await getLiveGuardrailStatusPayload();
    assert.equal(toStatus.emergency_halted, true, "2 unresolved UNKNOWN_TIMEOUT intents MUST trip Auto Kill-Switch");
    assert.equal(toStatus.emergency_code, "UNRESOLVED_TIMEOUT_ANOMALY", "emergency_code must be UNRESOLVED_TIMEOUT_ANOMALY");
    const b1To = await db.prepare("SELECT is_running FROM bots WHERE bot_id = 'bot_01'").get();
    const b2To = await db.prepare("SELECT is_running FROM bots WHERE bot_id = 'bot_02'").get();
    assert.equal(Number(b1To.is_running), 0, "bot_01 must be halted on 2x UNKNOWN_TIMEOUT");
    assert.equal(Number(b2To.is_running), 0, "bot_02 must be halted on 2x UNKNOWN_TIMEOUT");

    // 5-F. Phase 3 Re-entrancy Mutex (runLiveTradingBotsCycle 중첩 호출 차단) 검증
    await resetDbForScenario(db);
    await activateBot(db, "bot_01", 200000, 100);
    mockUpbit.tickerDelayMs = 200;
    const pCycle1 = runLiveTradingBotsCycle({ skipUpbitApi: false });
    await new Promise((r) => setTimeout(r, 40));
    const resCycle2 = await runLiveTradingBotsCycle({ skipUpbitApi: false });
    await pCycle1;
    mockUpbit.tickerDelayMs = 0;
    assert.equal(resCycle2?.skipped, true, "Overlapping runLiveTradingBotsCycle must be skipped by mutex");
    assert.equal(resCycle2?.reason, "LIVE_CYCLE_MUTEX_ACTIVE", "Skip reason must be LIVE_CYCLE_MUTEX_ACTIVE");

    recordPass(
      "Test 5",
      "시간당(3)/일일(12)/전체(30) Hard Cap · Auto Kill-Switch · Re-entrancy Mutex",
      `시간당/일일/전체캡차단=OK, 5회누적비상정지(is_running=0)=OK, 음수잔고정지=OK, 루프중첩차단=OK`
    );

    // =========================================================================
    // [Test 6] 동일 order_uuid 중복 매도 차단 & Graceful Drain 매도 비차단 검증
    // =========================================================================
    await resetDbForScenario(db);
    mockUpbit.reset();
    await activateBot(db, "bot_01", 500000, 100);

    // 6-A. 동일 포지션 동시 3회 매도 호출 -> 정확히 1건만 업비트 Mock에 전송
    const tr6 = await db
      .prepare(
        `INSERT INTO trades (bot_id, market, buy_order_uuid, buy_price, buy_volume, buy_amount, buy_date, status)
         VALUES ('bot_01', 'KRW-BTC', 'pos-sell-storm-uuid-1', 100000000, '0.00100000', 100000, ?, 'HOLDING')`
      )
      .run(nowKstStr(-3600));
    const pos6Ins = await db
      .prepare(
        `INSERT INTO bot_positions (bot_id, market, ticker, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id, highest_price, step_level, status, created_at, closing_lock)
         VALUES ('bot_01', 'KRW-BTC', 'KRW-BTC', 'pos-sell-storm-uuid-1', '0.00100000', 100000000, 100000, 50, ?, 100000000, 1, 'OPEN', ?, 0)`
      )
      .run(tr6.lastInsertRowid, nowKstStr(-3600));
    const pos6Row = await db.prepare("SELECT * FROM bot_positions WHERE id = ?").get(pos6Ins.lastInsertRowid);

    mockUpbit.nextBehavior = { mode: "SLOW_OK", delayMs: 60 };
    const sellStormRes = await Promise.all([
      executeBotSellOrder({ bot_id: "bot_01", nickname: "알파" }, pos6Row, 102000000, "동시매도테스트1", { skipDelay: true, sellPollIntervalMs: 0 }),
      executeBotSellOrder({ bot_id: "bot_01", nickname: "알파" }, pos6Row, 102000000, "동시매도테스트2", { skipDelay: true, sellPollIntervalMs: 0 }),
      executeBotSellOrder({ bot_id: "bot_01", nickname: "알파" }, pos6Row, 102000000, "동시매도테스트3", { skipDelay: true, sellPollIntervalMs: 0 }),
    ]);
    const sellSuccessCnt = sellStormRes.filter(Boolean).length;
    assert.equal(sellSuccessCnt, 1, `Expected exactly 1 sell success in 3x concurrent storm, got ${sellSuccessCnt}`);
    const askCalls6A = mockUpbit.postOrderCalls.filter((c) => c.body.side === "ask");
    assert.equal(askCalls6A.length, 1, "Mock Upbit POST /v1/orders (ask) must be called EXACTLY ONCE");
    assert.equal(Number(askCalls6A[0].body.volume), 0.001, "Sell volume must strictly match position volume 0.001 (no 1.0 BTC get_balance dump)");
    assert.ok(!/e/i.test(String(askCalls6A[0].body.volume)), "Sell volume must not use scientific notation");
    assert.ok(askCalls6A[0].body.identifier, "Sell order must include identifier UUID");
    const pos6Closed = await db.prepare("SELECT status, closing_lock FROM bot_positions WHERE id = ?").get(pos6Row.id);
    assert.equal(pos6Closed.status, "CLOSED", "Position must be CLOSED");
    assert.equal(Number(pos6Closed.closing_lock), 0, "closing_lock must be reset to 0 after settlement");

    // 6-B. Graceful Drain(is_selected_for_live = 0, is_running = 0) + 매수 상한 포화 + 쿨다운 + 비상정지 상태에서도 매도 청산 비차단 검증
    await db
      .prepare(
        "UPDATE bots SET is_selected_for_live = 0, is_running = 0, allocation_ratio = 0, allocated_capital = 100000, virtual_krw = 0 WHERE bot_id = 'bot_09'"
      )
      .run();
    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('guardrail_emergency_halted', '1', ?)").run(nowKstStr());
    // 일일 매수 상한 30건 포화 상태 주입
    const todayIso6B = new Date().toISOString();
    for (let i = 1; i <= 30; i++) {
      await db
        .prepare(
          `INSERT INTO live_order_intents (
             intent_id, bot_id, market, side, intent_bucket, requested_krw, requested_volume,
             status, refunded, created_at, updated_at
           ) VALUES (?, 'bot_09', ?, 'BUY', ?, 10000, '1', 'CONFIRMED', 1, ?, ?)`
        )
        .run(`drain-cap-${i}`, `KRW-C${i}`, `bot_09:KRW-C${i}:cap${i}:s1`, todayIso6B, todayIso6B);
    }
    const trDrain = await db
      .prepare(
        `INSERT INTO trades (bot_id, market, buy_order_uuid, buy_price, buy_volume, buy_amount, buy_date, status)
         VALUES ('bot_09', 'KRW-ETH', 'drain-pos-uuid-9', 4000000, '0.02500000', 100000, ?, 'HOLDING')`
      )
      .run(nowKstStr(-1800));
    const posDrainIns = await db
      .prepare(
        `INSERT INTO bot_positions (bot_id, market, ticker, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id, highest_price, step_level, status, created_at, closing_lock)
         VALUES ('bot_09', 'KRW-ETH', 'KRW-ETH', 'drain-pos-uuid-9', '0.02500000', 4000000, 100000, 50, ?, 4000000, 1, 'OPEN', ?, 0)`
      )
      .run(trDrain.lastInsertRowid, nowKstStr(-1800));
    const posDrainRow = await db.prepare("SELECT * FROM bot_positions WHERE id = ?").get(posDrainIns.lastInsertRowid);

    const drainSold = await executeBotSellOrder(
      { bot_id: "bot_09", nickname: "스캘핑" },
      posDrainRow,
      4120000,
      "Graceful Drain 익절(+3.00%)",
      { skipDelay: true, sellPollIntervalMs: 0 }
    );
    assert.equal(drainSold, true, "Graceful Drain sell MUST NEVER be blocked by buy cooldown/cap/emergency halt");
    const posDrainAfter = await db.prepare("SELECT status FROM bot_positions WHERE id = ?").get(posDrainRow.id);
    assert.equal(posDrainAfter.status, "CLOSED", "Draining position must be CLOSED cleanly");
    const handoffRows = await db.prepare("SELECT * FROM drain_handoff_logs WHERE from_bot_id = 'bot_09'").all();
    assert.equal(handoffRows.length, 1, "Graceful Drain proceeds handoff must be recorded in drain_handoff_logs");

    recordPass(
      "Test 6",
      "동일 order_uuid 중복 매도 차단(3x->1) & Graceful Drain 매도 비차단",
      `동시매도전송=1/3건, 수량=0.00100000(정밀격리), Drain매도=정상체결+이관완료`
    );

    // =========================================================================
    // [Test 7] 가상거래(Always-On Arena) 비간섭 검증
    // =========================================================================
    // 실전 봇 전체 비상 정지 + 일일 매수 상한 포화 + AI 전면 HALT_NEW_BUYS/BLOCK 상태에서도
    // 10대 가상 봇 상시 경쟁(Arena) 루프는 100% 비간섭 정상 가동 유지
    await db.exec(`
      UPDATE bots SET is_running = 0;
      INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES
        ('guardrail_emergency_halted', '1', '2026-11-19 15:00:00'),
        ('guardrail_emergency_code', 'REPEATED_BLOCK_ANOMALY', '2026-11-19 15:00:00');
      INSERT OR REPLACE INTO market_regime_filter (
        id, sentiment_score, market_regime, risk_alert, recommended_action,
        position_size_multiplier, final_risk_alert, final_position_multiplier,
        final_bot_overrides_json, bot_overrides_json, blacklist_tickers_json
      ) VALUES (
        1, -0.9, 'CRASH', 1, 'HALT_NEW_BUYS', 0.0, 1, 0.0,
        '{"bot_01":"BLOCK","bot_02":"BLOCK","bot_03":"BLOCK","bot_04":"BLOCK","bot_05":"BLOCK","bot_06":"BLOCK","bot_07":"BLOCK","bot_08":"BLOCK","bot_09":"BLOCK","bot_10":"BLOCK"}',
        '{"bot_01":"BLOCK","bot_02":"BLOCK","bot_03":"BLOCK","bot_04":"BLOCK","bot_05":"BLOCK","bot_06":"BLOCK","bot_07":"BLOCK","bot_08":"BLOCK","bot_09":"BLOCK","bot_10":"BLOCK"}',
        '["KRW-BTC","KRW-ETH"]'
      );
    `);

    const postCountBeforeArena = mockUpbit.postOrderCalls.length;
    await runAlwaysOnPaperArenaCycle();
    const postCountAfterArena = mockUpbit.postOrderCalls.length;

    assert.equal(postCountAfterArena, postCountBeforeArena, "Paper Arena MUST NEVER call live Upbit POST /v1/orders");

    const paperBots = await db.prepare("SELECT bot_id, paper_is_running, is_running, paper_status_msg FROM bots ORDER BY bot_id ASC").all();
    assert.equal(paperBots.length, 10, "All 10 bots must exist");
    const runningPaperCount = paperBots.filter((b) => Number(b.paper_is_running) === 1).length;
    const haltedLiveCount = paperBots.filter((b) => Number(b.is_running) === 0).length;
    const activeArenaMsgCount = paperBots.filter((b) => String(b.paper_status_msg || "").length > 0).length;
    assert.equal(runningPaperCount, 10, "All 10 Always-On Paper Arena bots must remain paper_is_running = 1");
    assert.equal(haltedLiveCount, 10, "All 10 live bots remain safely halted (is_running = 0)");
    assert.equal(activeArenaMsgCount, 10, "All 10 Always-On Paper Arena bots must continue updating paper_status_msg despite live kill-switch & HALT_NEW_BUYS");

    recordPass(
      "Test 7",
      "가상거래(Always-On Arena) 비간섭 검증",
      `실전비상정지=10/10봇, 가상Arena가동=10/10봇(paper_is_running=1, LLM/거시필터우회), 실전API호출=0건`
    );

    await releaseLiveExecutorLeaseNow();

    console.log("\n======================================================================");
    console.log("  🛡️ 5중 실전 중복 주문 가드레일 7대 장애 스트레스 테스트 요약: ALL PASS");
    console.log("======================================================================");
    for (const r of results) {
      console.log(`  ${r.id} | ${r.status} | ${r.name} | ${r.metrics}`);
    }
    console.log("======================================================================\n");
  } finally {
    globalThis.fetch = origFetch;
    try {
      await sqliteDb.close();
    } catch {}
    cleanupTmpFiles();
  }
}

main().catch((err) => {
  console.error("❌ Duplicate Order Guardrail Stress Test FAILED:", err);
  cleanupTmpFiles();
  process.exit(1);
});
