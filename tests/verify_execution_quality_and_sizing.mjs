/**
 * tests/verify_execution_quality_and_sizing.mjs
 *
 * [Prompt 3 Verification Suite]
 * 1. Orderbook Imbalance (OBI) & Spread Guard: blocks wide spread (>0.35%), extreme sell wall (OBI<-0.45), thin depth
 * 2. ATR Volatility-Targeted Sizing: scales down in high volatility, up in low volatility, preserves 5,250 KRW floor
 * 3. Multi-Timeframe (MTF) Counter-Trend Filter in algo_lab_service.mjs (60m + 240m bearish blocks breakout bots)
 * 4. Live Buy Execution Quality & Slippage (bps) Ledger persistence in trades & bot_positions
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autocoin-execq-test-"));
const TMP_DB = path.join(TMP_DIR, "execq_test.db");

process.env.AUTOCOIN_LIBRARY_MODE = "1";
process.env.AUTOCOIN_FORCE_LIVE_MODE = "1";
process.env.DB_MODE = "sqlite";
process.env.PG_SYNC_ENABLED = "false";
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.DB_PATH = TMP_DB;

function makeCandles(count, startPrice, step, vol = 1000) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const close = startPrice + i * step;
    const open = close - step * 0.5;
    rows.push({
      candle_date_time_kst: `2026-10-10 00:${String(i % 60).padStart(2, "0")}:00`,
      opening_price: open,
      high_price: Math.max(open, close) + Math.abs(step) * 0.4 + 2,
      low_price: Math.min(open, close) - Math.abs(step) * 0.4 - 2,
      trade_price: close,
      candle_acc_trade_volume: vol,
    });
  }
  return rows;
}

const results = [];

try {
  const {
    initializeDatabase,
    getDb,
    analyzeOrderbookQuality,
    computeAtrVolatilityMultiplier,
    computeSlippageBps,
    getSafeOrderKrw,
    executeBotBuyOrder,
  } = await import("../backend/node_server.mjs");
  const { buildIndicators, evaluateStrategy } = await import("../backend/common/algo_lab_service.mjs");

  await initializeDatabase();
  const db = getDb();

  // 1. Orderbook Quality (OBI & Spread Guard)
  const wideSpreadOb = {
    orderbook_units: [
      { ask_price: 100600, bid_price: 100000, ask_size: 10, bid_size: 10 }, // 0.60% spread > 0.35%
    ],
  };
  const wideRes = analyzeOrderbookQuality(wideSpreadOb, 50000, { botId: "bot_01" });
  assert.equal(wideRes.blocked, true, "Wide spread (0.60% > 0.35%) must block buy");
  assert.ok(wideRes.spread_pct > 0.35);

  const sellWallOb = {
    orderbook_units: [
      { ask_price: 100050, bid_price: 100000, ask_size: 50, bid_size: 5 }, // OBI = (5-50)/55 = -0.818 < -0.45
      { ask_price: 100100, bid_price: 99950, ask_size: 40, bid_size: 5 },
    ],
  };
  const sellWallRes = analyzeOrderbookQuality(sellWallOb, 50000, { botId: "bot_09" });
  assert.equal(sellWallRes.blocked, true, "Extreme sell wall (OBI < -0.45) must block breakout buy");
  assert.ok(sellWallRes.obi < -0.45);

  const healthyOb = {
    orderbook_units: [
      { ask_price: 100050, bid_price: 100000, ask_size: 12, bid_size: 15 },
      { ask_price: 100100, bid_price: 99950, ask_size: 10, bid_size: 14 },
      { ask_price: 100150, bid_price: 99900, ask_size: 10, bid_size: 12 },
    ],
  };
  const healthyRes = analyzeOrderbookQuality(healthyOb, 50000, { botId: "bot_01" });
  assert.equal(healthyRes.blocked, false, "Healthy liquid orderbook must pass");
  results.push({
    check: "OBI & Spread Guard",
    status: "PASS",
    detail: `wideSpread blocked (${wideRes.spread_pct}%), sellWall blocked (OBI ${sellWallRes.obi}), healthy passed`,
  });

  // 2. ATR Volatility-Inverse Sizing + 5,250 KRW Safe Floor
  const highVolMult = computeAtrVolatilityMultiplier({ atr14: 3000, currentPrice: 100000, targetAtrPct: 1.5 });
  const lowVolDefaultMult = computeAtrVolatilityMultiplier({ atr14: 500, currentPrice: 100000, targetAtrPct: 1.5 });
  const lowVolBoostMult = computeAtrVolatilityMultiplier({ atr14: 500, currentPrice: 100000, targetAtrPct: 1.5, maxMult: 1.25 });
  assert.ok(highVolMult.atr_sizing_mult < 0.7, `High ATR (3%) must shrink sizing, got ${highVolMult.atr_sizing_mult}`);
  assert.equal(lowVolDefaultMult.atr_sizing_mult, 1.0, "Default risk-capped ATR sizing must never exceed 1.0x");
  assert.ok(lowVolBoostMult.atr_sizing_mult > 1.0 && lowVolBoostMult.atr_sizing_mult <= 1.25, "Custom maxMult=1.25 caps at 1.25x");

  const botBig = { virtual_krw: 1000000, allocated_capital: 1000000, config: { order_ratio: 0.3 } };
  const baseOrder = getSafeOrderKrw(botBig, 0.3, 1.0);
  const highVolOrder = getSafeOrderKrw(botBig, 0.3, 1.0, { atr14: 3000, currentPrice: 100000 });
  assert.ok(highVolOrder < baseOrder, `High volatility order (${highVolOrder}) must be smaller than base (${baseOrder})`);

  const botSmall = { virtual_krw: 20000, allocated_capital: 20000, config: { order_ratio: 0.3 } };
  const smallHighVolOrder = getSafeOrderKrw(botSmall, 0.3, 1.0, { atr14: 4000, currentPrice: 100000 });
  assert.equal(smallHighVolOrder, 5250, "Small account high-vol scaled order must still protect 5,250 KRW floor");
  results.push({
    check: "ATR Volatility Sizing & 5,250 Floor",
    status: "PASS",
    detail: `base=${baseOrder} vs highVol=${highVolOrder} (${highVolMult.atr_sizing_mult}x), smallFloor=${smallHighVolOrder}`,
  });

  // 3. Multi-Timeframe (MTF) Counter-Trend Filter in algo_lab_service.mjs
  const bearM240 = makeCandles(65, 2000, -8); // strong downtrend
  const bearM60 = makeCandles(65, 1600, -4); // strong downtrend
  const spikeM15 = makeCandles(60, 1000, 0, 1000);
  spikeM15[58] = {
    candle_date_time_kst: "2026-10-10 14:30:00",
    opening_price: 1000,
    high_price: 1013,
    low_price: 999,
    trade_price: 1012,
    candle_acc_trade_volume: 3200,
  };
  spikeM15[59] = {
    candle_date_time_kst: "2026-10-10 14:45:00",
    opening_price: 1012,
    high_price: 1016,
    low_price: 1011,
    trade_price: 1015,
    candle_acc_trade_volume: 1300,
  };

  const mdSingleTf = {
    market: "KRW-XRP",
    price: 1015,
    candles: { day: makeCandles(65, 1000, 0), m240: [], m60: [], m15: spikeM15 },
  };
  mdSingleTf.indicators = buildIndicators(mdSingleTf);
  const sigSingle = evaluateStrategy("bot_09", mdSingleTf, mdSingleTf.indicators, [], { isLive: true });
  assert.equal(sigSingle.signal, "BUY", "Single-TF breakout should BUY");

  const mdBearMtf = {
    market: "KRW-XRP",
    price: 1015,
    candles: { day: makeCandles(65, 1000, 0), m240: bearM240, m60: bearM60, m15: spikeM15 },
  };
  mdBearMtf.indicators = buildIndicators(mdBearMtf);
  assert.equal(mdBearMtf.indicators.mtf.htfStronglyBearish, true, "MTF indicator must detect strong bearish HTF");
  const sigMtfBlocked = evaluateStrategy("bot_09", mdBearMtf, mdBearMtf.indicators, [], { isLive: true });
  assert.equal(sigMtfBlocked.signal, "HOLD", "Breakout bot_09 must HOLD when MTF 60m+240m is strongly bearish");
  results.push({
    check: "MTF Counter-Trend Block",
    status: "PASS",
    detail: `Single-TF=${sigSingle.signal} vs Bear-MTF=${sigMtfBlocked.signal} (${sigMtfBlocked.reason})`,
  });

  // 4. Slippage Ledger & Orderbook Block inside executeBotBuyOrder
  assert.equal(computeSlippageBps(100000, 100100), 10);
  assert.equal(computeSlippageBps(100000, 99950), -5);

  await db
    .prepare(
      "UPDATE bots SET is_selected_for_live = 1, is_running = 1, allocation_ratio = 100, allocated_capital = 200000, virtual_krw = 200000 WHERE bot_id = 'bot_01'"
    )
    .run();
  await db
    .prepare(
      "UPDATE market_regime_filter SET final_risk_alert = 0, risk_alert = 0, recommended_action = 'NORMAL', position_size_multiplier = 1.0, final_position_multiplier = 1.0 WHERE id = 1"
    )
    .run();

  const blockedBuy = await executeBotBuyOrder({ bot_id: "bot_01" }, "KRW-BTC", 50000, 100000, "test", {
    skipUpbitApi: true,
    orderbook: wideSpreadOb,
  });
  assert.equal(blockedBuy, false, "executeBotBuyOrder must abort when orderbook spread violates guard");

  const okBuy = await executeBotBuyOrder({ bot_id: "bot_01" }, "KRW-BTC", 50000, 100025, "mtf+obi ok", {
    skipUpbitApi: true,
    orderbook: healthyOb,
    atrSizingMult: 0.72,
  });
  assert.equal(okBuy, true, "executeBotBuyOrder must execute with healthy orderbook");

  const tradeRow = await db
    .prepare("SELECT expected_price, slippage_bps, atr_sizing_mult, buy_price FROM trades WHERE bot_id = 'bot_01' ORDER BY id DESC LIMIT 1")
    .get();
  const posRow = await db
    .prepare("SELECT expected_price, slippage_bps, atr_sizing_mult FROM bot_positions WHERE bot_id = 'bot_01' ORDER BY id DESC LIMIT 1")
    .get();
  assert.equal(tradeRow.expected_price, 100025);
  assert.equal(tradeRow.atr_sizing_mult, 0.72);
  assert.ok(Number.isFinite(Number(tradeRow.slippage_bps)), "slippage_bps must be recorded in trades");
  assert.equal(posRow.atr_sizing_mult, 0.72);
  results.push({
    check: "Slippage & ATR Sizing Ledger",
    status: "PASS",
    detail: `expected=${tradeRow.expected_price}, exec=${tradeRow.buy_price}, slip=${tradeRow.slippage_bps}bps, atrMult=${tradeRow.atr_sizing_mult}`,
  });

  console.log("\n=== [Prompt 3] Execution Quality, MTF Filter, ATR Sizing & Slippage Ledger Verification ===");
  console.table(results);
} finally {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {}
}
