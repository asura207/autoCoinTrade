/**
 * tests/qa_full_verification.mjs
 *
 * autoCoinTrade 전수 QA 자동화 검증 스위트 (격리 임시 DB · 외부 실거래 API 0회 호출)
 * - 운영 DB(data/auto_coin_trade.db) 및 실계좌 API를 절대 건드리지 않습니다.
 * - 종료 시(finally) 임시 DB 및 임시 설정 디렉토리를 자동 정리합니다.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_DIR = path.resolve(__dirname, "..");

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autocoin-qa-full-"));
const TEST_DB_PATH = path.join(TMP_DIR, "qa_test.db");
const TEST_ENV_PATH = path.join(TMP_DIR, ".env");
const TEST_CFG_PATH = path.join(TMP_DIR, "upbit_config.json");

fs.writeFileSync(
  TEST_ENV_PATH,
  [
    "DB_MODE=sqlite",
    "PG_SYNC_ENABLED=false",
    "USE_LOCAL_OLLAMA_NEWS=false",
    "BACKEND_PORT=0",
  ].join("\n"),
  "utf8"
);
fs.writeFileSync(
  TEST_CFG_PATH,
  JSON.stringify(
    {
      access_key: "TEST_ACCESS_KEY",
      secret_key: "TEST_SECRET_KEY",
      trade_mode: "live",
      gemini_api_key: "TEST_GEMINI_SECRET_KEY",
    },
    null,
    2
  ),
  "utf8"
);

process.env.AUTOCOIN_DB_PATH = TEST_DB_PATH;
process.env.AUTOCOIN_ENV_PATH = TEST_ENV_PATH;
process.env.AUTOCOIN_CONFIG_PATH = TEST_CFG_PATH;
process.env.DB_MODE = "sqlite";
process.env.PG_SYNC_ENABLED = "false";
process.env.AUTOCOIN_LIBRARY_MODE = "1";
process.env.AUTOCOIN_FORCE_LIVE_MODE = "1";

const {
  computeRsi,
  calculateKelloggIndicators,
  evaluateSmartExit,
  evaluateStrategy,
  runArenaCycle,
  evaluateWeeklyStrategyChampions,
} = await import("../backend/common/algo_lab_service.mjs");

const {
  getDb,
  initializeDatabase,
  getBots,
  floorTo8DecimalsStr,
  normalizeExecPrice,
  settleLiveSellOrderInDb,
  withDbWriteLock,
  executeBotSellOrder,
  executeWeeklyBotRotation,
  buildMechanicalFallbackRegime,
  updateMarketRegimeFilterFromAnalysis,
  runLiveTradingBotsCycle,
} = await import("../backend/node_server.mjs");

const results = [];
function record(suite, check, detail) {
  results.push({ suite, check, detail, status: "PASS" });
}

function makeCandles(count, { basePrice = 100000, step = 100, vol = 100 } = {}) {
  const arr = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const o = basePrice + i * step;
    const c = o + step * 0.8;
    const h = Math.max(o, c) + Math.abs(step) * 0.3 + 1;
    const l = Math.min(o, c) - Math.abs(step) * 0.2 - 1;
    arr.push({
      candle_date_time_kst: new Date(now - (count - i) * 15 * 60 * 1000 + 9 * 3600 * 1000)
        .toISOString()
        .slice(0, 19),
      opening_price: o,
      high_price: h,
      low_price: l,
      trade_price: c,
      candle_acc_trade_volume: typeof vol === "function" ? vol(i) : vol,
    });
  }
  return arr;
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => resolve(addr.port));
    });
    srv.on("error", reject);
  });
}

async function runHttpE2eSuite() {
  const port = await getFreePort();
  const e2eDbPath = path.join(TMP_DIR, "qa_http_e2e.db");
  const e2eEnvPath = path.join(TMP_DIR, ".env.e2e");
  const e2eCfgPath = path.join(TMP_DIR, "upbit_config.e2e.json");
  fs.writeFileSync(
    e2eEnvPath,
    `DB_MODE=sqlite\nPG_SYNC_ENABLED=false\nBACKEND_PORT=${port}\nUSE_LOCAL_OLLAMA_NEWS=false\n`,
    "utf8"
  );
  fs.writeFileSync(
    e2eCfgPath,
    JSON.stringify({
      access_key: "",
      secret_key: "",
      trade_mode: "paper",
      gemini_api_key: "KEEP_SECRET_GEMINI_KEY",
    }),
    "utf8"
  );

  const child = spawn(process.execPath, [path.join(BASE_DIR, "backend", "node_server.mjs")], {
    cwd: BASE_DIR,
    env: {
      ...process.env,
      AUTOCOIN_LIBRARY_MODE: "0",
      AUTOCOIN_FORCE_LIVE_MODE: "0",
      AUTOCOIN_DB_PATH: e2eDbPath,
      AUTOCOIN_ENV_PATH: e2eEnvPath,
      AUTOCOIN_CONFIG_PATH: e2eCfgPath,
      DB_MODE: "sqlite",
      PG_SYNC_ENABLED: "false",
      BACKEND_PORT: String(port),
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${baseUrl}/api/version`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }

  try {
    assert.equal(ready, true, "Ephemeral backend server failed to boot");

    // 1. Unauthenticated access blocked (401)
    const unauthResp = await fetch(`${baseUrl}/api/bots`);
    assert.equal(unauthResp.status, 401, "Unauthenticated /api/bots must return 401");

    // 2. Default entry code accepts Korean layout typo "ㄴ새차" -> "stock"
    const loginResp = await fetch(`${baseUrl}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "ㄴ새차" }),
    });
    assert.equal(loginResp.status, 200, "Default entry code must accept ㄴ새차");
    const cookieHeader = (loginResp.headers.get("set-cookie") || "").split(";")[0];
    assert.ok(cookieHeader.includes("autoCoinTrade_session="), "HttpOnly session cookie must be issued");

    // 3. Change entry code -> custom code works, "stock"/"ㄴ새차" must be REJECTED (no backdoor!)
    const changeResp = await fetch(`${baseUrl}/api/settings/entry-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({ entry_code: "mySecret99!" }),
    });
    assert.equal(changeResp.status, 200);
    const newCookie = (changeResp.headers.get("set-cookie") || "").split(";")[0] || cookieHeader;

    const typoAfterCustom = await fetch(`${baseUrl}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "ㄴ새차" }),
    });
    assert.equal(typoAfterCustom.status, 401, "ㄴ새차 backdoor must be blocked once custom code is set");

    const customLogin = await fetch(`${baseUrl}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "mySecret99!" }),
    });
    assert.equal(customLogin.status, 200, "Custom entry code must authenticate cleanly");
    const authedCookie = (customLogin.headers.get("set-cookie") || "").split(";")[0];

    // 4. GET /api/bots?mode=paper returns paper_virtual_krw & paper_initial_capital (not live 0)
    const paperBotsResp = await fetch(`${baseUrl}/api/bots?mode=paper`, {
      headers: { Cookie: authedCookie },
    });
    assert.equal(paperBotsResp.status, 200);
    const paperBotsData = await paperBotsResp.json();
    assert.equal(paperBotsData.bots.length, 10);
    assert.equal(
      Number(paperBotsData.bots[0].allocated_capital),
      1000000,
      "Paper mode bots must expose paper_initial_capital (1,000,000)"
    );
    assert.equal(
      Number(paperBotsData.bots[0].virtual_krw),
      1000000,
      "Paper mode bots must expose paper_virtual_krw (1,000,000)"
    );

    // 5. Statistics ISO Week & Monotonic Cumulative Profit & Period Coin Ranking
    const { DatabaseSync } = await import("node:sqlite");
    const directDb = new DatabaseSync(e2eDbPath);
    directDb.exec(`
      INSERT INTO trades (bot_id, market, buy_order_uuid, sell_order_uuid, buy_price, buy_volume, buy_amount, buy_date, sell_price, sell_volume, sell_amount, sell_date, profit_krw, profit_pct, status)
      VALUES
        ('bot_01', 'KRW-BTC', 'b-1', 's-1', 100000, '1', 100000, '2026-10-02 10:00:00', 105000, '1', 105000, '2026-10-02 12:00:00', 5000, 5.0, 'COMPLETED'),
        ('bot_01', 'KRW-ETH', 'b-2', 's-2', 100000, '1', 100000, '2026-10-03 10:00:00', 98000, '1', 98000, '2026-10-03 12:00:00', -2000, -2.0, 'COMPLETED'),
        ('bot_01', 'KRW-SOL', 'b-3', 's-3', 100000, '1', 100000, '2027-01-04 10:00:00', 110000, '1', 110000, '2027-01-04 12:00:00', 10000, 10.0, 'COMPLETED');
    `);
    directDb.close();

    const statsResp = await fetch(`${baseUrl}/api/statistics?mode=live`, {
      headers: { Cookie: authedCookie },
    });
    assert.equal(statsResp.status, 200);
    const statsData = await statsResp.json();
    assert.equal(statsData.start_date, "2026.10.01");
    const weekLabels = (statsData.weekly || []).map((w) => w.label);
    assert.ok(weekLabels.includes("2027-W01"), `Expected ISO week 2027-W01, got ${JSON.stringify(weekLabels)}`);
    assert.ok(
      !weekLabels.some((w) => /W(54|55|56|57|58|59|6\d)/.test(w)),
      `Invalid week number > 53 found: ${JSON.stringify(weekLabels)}`
    );
    // Cumulative profit on traded days must be monotonic cumulative (5000 -> 3000 -> 13000)
    const tradedDaysCum = (statsData.daily || []).filter((d) => d.has_trade).map((d) => d.cumulative_profit);
    assert.deepEqual(tradedDaysCum, [5000, 3000, 13000], `Daily cumulative profit mismatch: ${JSON.stringify(tradedDaysCum)}`);

    // 6. Export/Import JSON preserves excluded secrets (entry_code, gemini_api_key)
    const exportResp = await fetch(`${baseUrl}/api/settings/export`, {
      headers: { Cookie: authedCookie },
    });
    assert.equal(exportResp.status, 200);
    const exported = await exportResp.json();
    const importResp = await fetch(`${baseUrl}/api/settings/import-json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authedCookie },
      body: JSON.stringify(exported),
    });
    assert.equal(importResp.status, 200);

    // Custom entry code must STILL work after import!
    const postImportLogin = await fetch(`${baseUrl}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "mySecret99!" }),
    });
    assert.equal(postImportLogin.status, 200, "JSON import must preserve custom entry_code secret");

    record(
      "HttpApiE2E",
      "Auth/PaperMode/Statistics/ImportSecrets",
      "401 gate, default ㄴ새차 -> custom lockout, paper_virtual_krw, ISO W01, cumulative_profit, secret preservation"
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    if (!child.killed) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }
}

async function runAllChecks() {
  try {
    await initializeDatabase();
    const db = getDb();

    // =========================================================================
    // 1. Order Volume Precision & Sub-1-KRW Price Normalization
    // =========================================================================
    assert.equal(floorTo8DecimalsStr(0.29), "0.29");
    assert.equal(floorTo8DecimalsStr("0.123456789"), "0.12345678");
    assert.equal(floorTo8DecimalsStr(0.00005), "0.00005");
    assert.equal(floorTo8DecimalsStr("0"), "0");
    assert.equal(normalizeExecPrice(0.0245), 0.0245);
    assert.equal(normalizeExecPrice(123.4567), 123.4567);
    assert.equal(normalizeExecPrice(152345.9), 152345);
    record(
      "OrderPrecision",
      "Decimal8AndSub1KrwPrice",
      "floorTo8DecimalsStr(0.29)='0.29', normalizeExecPrice(0.0245)=0.0245 (no SHIB zeroing)"
    );

    // =========================================================================
    // 2. Algo Lab Indicators, bot_01 20MA Filter, bot_10 Setup B & Churn Prevention
    // =========================================================================
    assert.equal(computeRsi([100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100], 14), 50);

    const zeroVolCandles = makeCandles(25, { basePrice: 10000, step: 0, vol: 0 });
    const kZero = calculateKelloggIndicators(zeroVolCandles, [], 10000);
    assert.equal(kZero.rvol, 0, "Zero-volume candles must produce rvol === 0 (never fake 1.0)");

    // bot_01 20-day MA trend filter must block entry when price < ma20 (even on breakout + volume surge!)
    const bot01IndDown = {
      day: {
        todayOpen: 88000,
        prevHigh: 89000,
        prevLow: 88000,
        ma20: 100000, // price 90,000 < ma20 100,000 -> MUST HOLD!
      },
      m15: { volSurge5: 2.0 },
    };
    const bot01Down = evaluateStrategy(
      "bot_01",
      { market: "KRW-BTC", price: 90000, candles: { day: [], m15: [] } },
      bot01IndDown,
      null,
      { params: { k_value: 0.4 }, isLive: false }
    );
    assert.equal(bot01Down.signal, "HOLD", "bot_01 must enforce 20-day MA trend filter");
    const bot01Up = evaluateStrategy(
      "bot_01",
      { market: "KRW-BTC", price: 105000, candles: { day: [], m15: [] } },
      {
        day: { todayOpen: 103000, prevHigh: 104000, prevLow: 103000, ma20: 100000 },
        m15: { volSurge5: 2.0 },
      },
      null,
      { params: { k_value: 0.4 }, isLive: false }
    );
    assert.equal(bot01Up.signal, "BUY", "bot_01 must trigger BUY when price >= ma20 and breakout + vol surge met");

    // bot_10 Setup B ATR_HARD_STOP exemption (allows -1.5% 2nd-split scaling-in)
    const setupBPos = {
      id: 1,
      avg_buy_price: 100000,
      highest_price: 100000,
      created_at: new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19),
      buy_reason: "[Setup B 반등 1차] LRC 하단 터치",
    };
    const exitSetupB = evaluateSmartExit({
      botId: "bot_10",
      position: setupBPos,
      currentPrice: 98000,
      indicators: { m15: { ready: true, atr14: 500, rvol: 0.5 } },
      peakPrice: 100000,
      isLive: false,
      stopLossPct: -2.5,
    });
    assert.equal(exitSetupB, null, "bot_10 Setup B position must be exempt from ATR_HARD_STOP");

    // Bankrupt bot 7d equity calculation must NOT explode to +100,000%
    await db.exec(`DELETE FROM paper_trades; DELETE FROM paper_bot_positions;`);
    await db
      .prepare(
        `INSERT INTO paper_trades (bot_id, market, buy_order_uuid, sell_order_uuid, buy_price, buy_volume, buy_amount, buy_date, sell_price, sell_volume, sell_amount, sell_date, profit_krw, profit_pct, status)
         VALUES
           ('bot_01', 'KRW-BTC', 'pb-1', 'ps-1', 1000, '1000', 1000000, '2026-09-01 10:00:00', 1, '100', 100, '2026-09-02 10:00:00', -999900, -99.99, 'CLOSED'),
           ('bot_01', 'KRW-BTC', 'pb-2', 'ps-2', 1000, '1', 1000, '2026-11-18 10:00:00', 2000, '1', 2000, '2026-11-18 12:00:00', 1000, 100.0, 'CLOSED')`
      )
      .run();
    const champEval = await evaluateWeeklyStrategyChampions(db, { minWeeklyTrades: 1 });
    const bot01Metric = champEval.by_bot_id.bot_01;
    assert.ok(
      bot01Metric.weekly_return_pct <= 5,
      `Bankrupt bot 7d return should be bounded by 10% floor baseline, got ${bot01Metric.weekly_return_pct}%`
    );
    await db.exec(`DELETE FROM paper_trades;`);

    record(
      "QuantStrategies",
      "RsiFlat/RvolZero/Bot01Ma20/Bot10SetupB/Bankrupt7dCap",
      "Flat RSI=50, Zero-vol RVOL=0, bot_01 MA20 enforced, bot_10 Setup B ATR exempt, bankrupt baseline floored"
    );

    // =========================================================================
    // 3. Always-On Paper Arena 100% Filter Bypass & Paper<->Live Ledger Isolation
    // =========================================================================
    await db
      .prepare(
        `UPDATE market_regime_filter
         SET market_regime = 'HIGH_VOLATILITY_SHOCK',
             risk_alert = 1,
             recommended_action = 'HALT_NEW_BUYS',
             position_size_multiplier = 0.0,
             final_risk_alert = 1,
             final_position_multiplier = 0.0,
             final_bot_overrides_json = '{"bot_01":"BLOCK","bot_02":"BLOCK","bot_03":"BLOCK","bot_04":"BLOCK","bot_05":"BLOCK","bot_06":"BLOCK","bot_07":"BLOCK","bot_08":"BLOCK","bot_09":"BLOCK","bot_10":"BLOCK"}'
         WHERE id = 1`
      )
      .run();
    await db
      .prepare(
        `INSERT INTO ai_market_briefings (provider, model, btc_price, btc_daily_20ma, btc_4h_60ma, regime_status, briefing_text, created_at)
         VALUES ('gemini', 'mock', 100000000, 120000000, 120000000, 'HOLD_CASH', 'Extreme bear halt', '2026-11-19 09:00:00')`
      )
      .run();

    // Feed mocked market data: BTC in deep bear, KRW-XRP breaking out strongly for bot_01/bot_09
    const bearBtcDay = makeCandles(65, { basePrice: 130000000, step: -500000, vol: 500 });
    const bullXrpDay = Array.from({ length: 65 }, (_, i) => ({
      candle_date_time_kst: new Date(Date.now() - (65 - i) * 86400000 + 9 * 3600000).toISOString().slice(0, 19),
      opening_price: i === 63 ? 995 : 1000,
      high_price: i === 63 ? 1020 : 1026,
      low_price: i === 63 ? 980 : 995,
      trade_price: i === 64 ? 1025 : 1000,
      candle_acc_trade_volume: 1000,
    }));
    const bullXrp15m = Array.from({ length: 60 }, (_, i) => ({
      candle_date_time_kst: new Date(Date.now() - (60 - i) * 15 * 60000 + 9 * 3600000).toISOString().slice(0, 19),
      opening_price: i >= 58 ? 1015 : 1000,
      high_price: i >= 58 ? 1026 : 1003,
      low_price: i >= 58 ? 1014 : 998,
      trade_price: i >= 58 ? 1025 : 1001,
      candle_acc_trade_volume: i >= 58 ? 2200 : 1000,
    }));

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const s = String(url);
      if (s.includes("/v1/ticker")) {
        return new Response(
          JSON.stringify([
            { market: "KRW-BTC", trade_price: 95000000, acc_trade_price_24h: 9e11, signed_change_rate: -0.08 },
            { market: "KRW-XRP", trade_price: 1200, acc_trade_price_24h: 5e11, signed_change_rate: 0.12 },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (s.includes("/v1/candles/days")) {
        const rows = (s.includes("KRW-BTC") ? bearBtcDay : bullXrpDay).slice().reverse();
        return new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (s.includes("/v1/candles/minutes/")) {
        const rows = bullXrp15m.slice().reverse();
        return new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    };

    try {
      await db.exec(`DELETE FROM trades; DELETE FROM bot_positions; DELETE FROM paper_trades; DELETE FROM paper_bot_positions;`);
      await db.prepare("UPDATE bots SET virtual_krw = 500000, allocated_capital = 500000, paper_virtual_krw = 1000000, paper_is_running = 1").run();
      await runArenaCycle(db, {
        getUniverse: async () => ["KRW-BTC", "KRW-XRP"],
        fetchTickersMap: async () =>
          new Map([
            ["KRW-BTC", { market: "KRW-BTC", trade_price: 95000000, acc_trade_price_24h: 9e11, signed_change_rate: -0.08 }],
            ["KRW-XRP", { market: "KRW-XRP", trade_price: 1025, acc_trade_price_24h: 5e11, signed_change_rate: 0.025 }],
          ]),
        fetchCandles: async (market, unit) => {
          if (unit === "day") {
            return market === "KRW-BTC" ? bearBtcDay : bullXrpDay;
          }
          return bullXrp15m;
        },
      });
      const paperTradesCnt = Number((await db.prepare("SELECT COUNT(*) AS c FROM paper_trades").get()).c);
      const liveTradesCnt = Number((await db.prepare("SELECT COUNT(*) AS c FROM trades").get()).c);
      const liveBotCash = Number((await db.prepare("SELECT virtual_krw FROM bots WHERE bot_id = 'bot_01'").get()).virtual_krw);
      assert.ok(paperTradesCnt >= 1, "Always-On Paper Arena must bypass HOLD_CASH / BLOCK / BTC 20MA");
      assert.equal(liveTradesCnt, 0, "Paper Arena must NEVER touch live trades table");
      assert.equal(liveBotCash, 500000, "Paper Arena must NEVER mutate live virtual_krw");
    } finally {
      globalThis.fetch = origFetch;
    }
    record(
      "ArenaBypassAndIsolation",
      "BypassHoldCashAndLedgerSeparation",
      "Paper Arena executes under HOLD_CASH+BLOCK+Bear BTC while live trades/virtual_krw stay 100% isolated"
    );

    // =========================================================================
    // 4. Active-Bot Sell Principal Integrity (No Double Counting) & Mutex Lock
    // =========================================================================
    await db.exec(`DELETE FROM bot_positions; DELETE FROM trades;`);
    await db.prepare("UPDATE bots SET is_selected_for_live = 0, is_running = 0, allocation_ratio = 0, allocated_capital = 0, virtual_krw = 0").run();
    await db
      .prepare("UPDATE bots SET is_selected_for_live = 1, is_running = 1, allocation_ratio = 100, allocated_capital = 100000, virtual_krw = 60000 WHERE bot_id = 'bot_01'")
      .run();
    const trIns = await db
      .prepare(
        `INSERT INTO trades (bot_id, market, buy_order_uuid, buy_price, buy_volume, buy_amount, buy_date, status)
         VALUES ('bot_01', 'KRW-BTC', 'qa-uuid-active-1', 100000000, '0.0004', 40000, '2026-11-19 08:00:00', 'HOLDING')`
      )
      .run();
    const posIns = await db
      .prepare(
        `INSERT INTO bot_positions (bot_id, market, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id, status, created_at)
         VALUES ('bot_01', 'KRW-BTC', 'qa-uuid-active-1', '0.0004', 100000000, 40000, 20, ?, 'OPEN', '2026-11-19 08:00:00')`
      )
      .run(trIns.lastInsertRowid);
    const openPos = await db.prepare("SELECT * FROM bot_positions WHERE id = ?").get(posIns.lastInsertRowid);
    const bot01Before = (await getBots("live")).find((b) => b.bot_id === "bot_01");

    await settleLiveSellOrderInDb({
      db,
      bot: bot01Before,
      targetPositions: [openPos],
      sellUuid: "qa-sell-uuid-1",
      sellPrice: 110000000, // +10% => gross 44,000, fee 22, net 43,978
      actualTotalFunds: 44000,
      actualTotalFee: 22,
      reasonLabel: "QA_ACTIVE_SELL",
    });

    const bot01After = await db.prepare("SELECT allocated_capital, virtual_krw FROM bots WHERE bot_id = 'bot_01'").get();
    assert.equal(Number(bot01After.virtual_krw), 103978, "Active bot virtual_krw must be 60,000 + 43,978 = 103,978");
    assert.equal(
      Number(bot01After.allocated_capital),
      103978,
      "Active bot allocated_capital must be 103,978 (NOT double-counted 143,978!)"
    );

    // Verify concurrent withDbWriteLock + rotation does not trigger nested SQLite transaction error
    const concurrentOutcomes = await Promise.all([
      withDbWriteLock(async () => {
        await db.exec("BEGIN IMMEDIATE");
        await new Promise((r) => setTimeout(r, 25));
        await db.exec("COMMIT");
        return "lock-ok";
      }),
      executeWeeklyBotRotation({ triggerType: "MANUAL", totalPoolOverride: 100000 }),
    ]);
    assert.equal(concurrentOutcomes[0], "lock-ok");
    assert.equal(concurrentOutcomes[1].success, true);
    record(
      "LedgerAndMutex",
      "NoDoubleCountAndWriteLock",
      "Active sell virtual=alloc=103,978 (0 drift), concurrent rotation+tx serialized safely"
    );

    // =========================================================================
    // 5. Isolated Sell Safety (Upbit /v1/accounts 500 & Zero-Balance Protection)
    // =========================================================================
    await db.exec(`DELETE FROM bot_positions; DELETE FROM trades;`);
    await db
      .prepare("UPDATE bots SET is_selected_for_live = 1, is_running = 1, allocated_capital = 100000, virtual_krw = 50000 WHERE bot_id = 'bot_02'")
      .run();
    const trIso = await db
      .prepare(
        `INSERT INTO trades (bot_id, market, buy_order_uuid, buy_price, buy_volume, buy_amount, buy_date, status)
         VALUES ('bot_02', 'KRW-ETH', 'qa-uuid-iso-1', 4000000, '0.0125', 50000, '2026-11-19 08:10:00', 'HOLDING')`
      )
      .run();
    const posIso = await db
      .prepare(
        `INSERT INTO bot_positions (bot_id, market, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id, status, created_at)
         VALUES ('bot_02', 'KRW-ETH', 'qa-uuid-iso-1', '0.0125', 4000000, 50000, 25, ?, 'OPEN', '2026-11-19 08:10:00')`
      )
      .run(trIso.lastInsertRowid);
    const bot02Obj = (await getBots("live")).find((b) => b.bot_id === "bot_02");
    const posIsoRow = await db.prepare("SELECT * FROM bot_positions WHERE id = ?").get(posIso.lastInsertRowid);

    // Mock Upbit /v1/accounts returning HTTP 500 -> MUST abort without closing DB position!
    let orderPostCalled = false;
    globalThis.fetch = async (url, init) => {
      const s = String(url);
      if (s.includes("/v1/accounts")) {
        return new Response(JSON.stringify({ error: { message: "Upbit temporary 500" } }), { status: 500 });
      }
      if (s.includes("/v1/orders") && init?.method === "POST") {
        orderPostCalled = true;
      }
      return new Response("{}", { status: 500 });
    };
    try {
      const sellRes500 = await executeBotSellOrder(bot02Obj, posIsoRow, 4100000, "QA_500_TEST");
      assert.equal(sellRes500, false, "Sell must return false when /v1/accounts fails");
      assert.equal(orderPostCalled, false, "No order must be sent when /v1/accounts fails");
      const stillOpen = await db.prepare("SELECT status FROM bot_positions WHERE id = ?").get(posIso.lastInsertRowid);
      assert.equal(stillOpen.status, "OPEN", "DB position must remain OPEN on transient /v1/accounts outage");
    } finally {
      globalThis.fetch = origFetch;
    }

    // Mock Upbit /v1/accounts returning ETH balance=0, locked=0.0125 (locked in open order, NOT sold!) -> must NOT close or sell other bots' coins
    let sellOrderSentOnLocked = false;
    globalThis.fetch = async (url, init) => {
      const s = String(url);
      if (s.includes("/v1/accounts")) {
        return new Response(
          JSON.stringify([{ currency: "ETH", balance: "0", locked: "0.0125", avg_buy_price: "4000000" }]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (s.includes("/v1/orders") && init?.method === "POST") {
        sellOrderSentOnLocked = true;
      }
      return new Response("{}", { status: 200 });
    };
    try {
      const sellResLocked = await executeBotSellOrder(bot02Obj, posIsoRow, 4100000, "QA_LOCKED_TEST");
      assert.equal(sellResLocked, false, "Sell must abort when coin is locked in an open order");
      assert.equal(sellOrderSentOnLocked, false, "Must never fall through to sell order when available balance is 0");
      const stillOpenLocked = await db.prepare("SELECT status FROM bot_positions WHERE id = ?").get(posIso.lastInsertRowid);
      assert.equal(stillOpenLocked.status, "OPEN", "Locked position must remain OPEN (not wiped as manual-sync)");
    } finally {
      globalThis.fetch = origFetch;
    }
    record(
      "IsolatedSellGuard",
      "Accounts500AndLockedBalanceProtection",
      "/v1/accounts 500 & locked=0.0125 abort cleanly without DB wipe or cross-bot sell"
    );

    // =========================================================================
    // 6. Dual AI Sticky-BLOCK Lift (Ollama-Only Mode) & BTC 0-Price Fail-Safe
    // =========================================================================
    await db.prepare("DELETE FROM system_settings WHERE key IN ('dual_ai_flash_state_json', 'dual_ai_pro_state_json')").run();
    await db
      .prepare(
        `UPDATE market_regime_filter
         SET recommended_action = 'HALT_NEW_BUYS',
             risk_alert = 1,
             final_risk_alert = 1,
             final_position_multiplier = 0.0,
             final_bot_overrides_json = '{"bot_01":"BLOCK","bot_02":"BLOCK","bot_03":"BLOCK","bot_04":"BLOCK","bot_05":"BLOCK","bot_06":"BLOCK","bot_07":"BLOCK","bot_08":"BLOCK","bot_09":"BLOCK","bot_10":"BLOCK"}'
         WHERE id = 1`
      )
      .run();

    const updatedRegime = await updateMarketRegimeFilterFromAnalysis({
      isPro: false,
      provider: "ollama",
      model: "qwen3-news",
      decision: {
        sentiment_score: 0.35,
        market_regime: "BULL",
        risk_alert: false,
        recommended_action: "NORMAL",
        position_size_multiplier: 1.0,
        bot_overrides: {
          bot_01: "ALLOW", bot_02: "ALLOW", bot_03: "ALLOW", bot_04: "ALLOW", bot_05: "ALLOW",
          bot_06: "ALLOW", bot_07: "ALLOW", bot_08: "ALLOW", bot_09: "ALLOW", bot_10: "ALLOW",
        },
        blacklist_tickers: [],
        reason: "Recovery verified by Ollama",
      },
    });
    assert.ok(updatedRegime, "updateMarketRegimeFilterFromAnalysis must return updated row");
    assert.equal(updatedRegime.recommended_action, "NORMAL", "Sticky HALT_NEW_BUYS must be lifted when Ollama recovers");
    assert.equal(Number(updatedRegime.final_risk_alert), 0, "Sticky final_risk_alert must be cleared");
    assert.equal(Number(updatedRegime.final_position_multiplier), 1, "Position multiplier must recover to 1.0");

    const btcZeroFallback = buildMechanicalFallbackRegime({ btcPrice: 0, btcDaily20Ma: 0, btc4h60Ma: 0 });
    assert.equal(btcZeroFallback.market_regime, "SIDEWAYS");
    assert.equal(btcZeroFallback.recommended_action, "REDUCE_SIZE");
    assert.equal(btcZeroFallback.position_size_multiplier, 0.5);
    assert.equal(btcZeroFallback.bot_overrides.bot_01, "BLOCK", "Trend bot must be BLOCKED on BTC feed outage");
    assert.equal(btcZeroFallback.bot_overrides.bot_05, "ALLOW", "Reversal bot allowed conservatively at 0.5x");
    record(
      "DualAiSafety",
      "StickyBlockLiftAndBtcOutageFailSafe",
      "Ollama recovery lifts prior HALT_NEW_BUYS; BTC price=0 triggers SIDEWAYS/0.5x Fail-Safe"
    );

    // =========================================================================
    // 7. Paper Mode Guard in runLiveTradingBotsCycle
    // =========================================================================
    process.env.AUTOCOIN_FORCE_LIVE_MODE = "0";
    fs.writeFileSync(
      TEST_CFG_PATH,
      JSON.stringify({ access_key: "K", secret_key: "S", trade_mode: "paper" }),
      "utf8"
    );
    let liveFetchHitInPaper = false;
    globalThis.fetch = async () => {
      liveFetchHitInPaper = true;
      return new Response("[]", { status: 200 });
    };
    try {
      await runLiveTradingBotsCycle();
      assert.equal(liveFetchHitInPaper, false, "runLiveTradingBotsCycle must NO-OP when trade_mode is paper");
    } finally {
      globalThis.fetch = origFetch;
      process.env.AUTOCOIN_FORCE_LIVE_MODE = "1";
    }
    record("LiveModeGuard", "PaperModeNoCrossContamination", "runLiveTradingBotsCycle skips cleanly in paper mode");

    // =========================================================================
    // 8. Live Ephemeral HTTP E2E Suite
    // =========================================================================
    await runHttpE2eSuite();

    await db.close();
    console.log("\n=== Full QA Verification Suite (Node.js Backend & Quant Engine) ===");
    console.table(results);
  } finally {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
}

await runAllChecks();
