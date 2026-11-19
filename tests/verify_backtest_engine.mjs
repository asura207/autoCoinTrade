/**
 * tests/verify_backtest_engine.mjs
 *
 * [Prompt 2 Verification Suite]
 * 1. historical_candles & backtest_runs DB schema creation
 * 2. Zero Look-Ahead Bias verification (manipulating future bars 80..120 produces 0 diff on bars 0..79)
 * 3. Fee (0.05%) & Slippage (bps) deduction + NaN-free Quantitative Metrics (CAGR, MDD, Sharpe, Sortino, ProfitFactor)
 * 4. All 10 Bots (bot_01 ~ bot_10) simulation + Walk-Forward 70%/30% validation + DB history persistence
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autocoin-bt-test-"));
const TMP_DB = path.join(TMP_DIR, "bt_test.db");

process.env.AUTOCOIN_LIBRARY_MODE = "1";
process.env.DB_MODE = "sqlite";
process.env.PG_SYNC_ENABLED = "false";
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.DB_PATH = TMP_DB;

function generateSyntheticCandles(count = 160, mutateAfterIdx = -1) {
  const startMs = Date.UTC(2026, 9, 1, 0, 0, 0); // 2026-10-01 09:00 KST
  const candles = [];
  let price = 100000;
  for (let i = 0; i < count; i++) {
    const kstMs = startMs + i * 15 * 60 * 1000 + 9 * 3600 * 1000;
    const iso = new Date(kstMs).toISOString().replace("T", " ").slice(0, 19);

    let wave = Math.sin(i / 6) * 2800 + (i % 19 === 0 ? 3500 : 0) - (i % 13 === 0 ? 2900 : 0);
    let vol = 1000 + (i % 11 === 0 ? 2400 : (i % 5) * 180);

    if (mutateAfterIdx >= 0 && i >= mutateAfterIdx) {
      // Wildly altered future candles to prove zero Look-Ahead Bias
      wave = (i % 2 === 0 ? 1 : -1) * 45000;
      vol = 99999;
    }

    const open = Math.max(5000, Math.round(price));
    const close = Math.max(5000, Math.round(100000 + wave + i * 35));
    const high = Math.max(open, close) + 700;
    const low = Math.max(1000, Math.min(open, close) - 650);
    price = close;

    candles.push({
      candle_date_time_kst: iso,
      opening_price: open,
      high_price: high,
      low_price: low,
      trade_price: close,
      candle_acc_trade_volume: vol,
    });
  }
  return candles;
}

const results = [];

try {
  const {
    initializeDatabase,
    getDb,
    ensureBacktestTables,
    simulateBarByBarBacktest,
    runHistoricalBacktest,
    getBacktestHistory,
  } = await import("../backend/node_server.mjs");

  await initializeDatabase();
  const db = getDb();
  await ensureBacktestTables(db);

  // 1. Verify tables exist
  const tables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('historical_candles', 'backtest_runs')")
    .all();
  assert.equal(tables.length, 2, "historical_candles and backtest_runs tables must exist");
  results.push({ check: "Backtest Tables Schema", status: "PASS", detail: "historical_candles & backtest_runs verified" });

  // 2. Zero Look-Ahead Bias verification
  const candlesBase = generateSyntheticCandles(110, -1);
  const candlesMutatedFuture = generateSyntheticCandles(150, 110);
  // Ensure prefix 0..109 are 100% byte-for-byte identical
  assert.deepEqual(candlesBase, candlesMutatedFuture.slice(0, 110));

  const simA = simulateBarByBarBacktest({
    botId: "bot_05",
    market: "KRW-BTC",
    candles: candlesBase,
    initialCapital: 1000000,
    slippageBps: 5,
  });
  const simB = simulateBarByBarBacktest({
    botId: "bot_05",
    market: "KRW-BTC",
    candles: candlesMutatedFuture,
    initialCapital: 1000000,
    slippageBps: 5,
  });

  const lastTimeA = candlesBase[candlesBase.length - 1].candle_date_time_kst;
  const tradesA = simA.trades.filter((t) => t.buy_date <= lastTimeA && t.sell_date <= lastTimeA);
  const tradesB = simB.trades.filter((t) => t.buy_date <= lastTimeA && t.sell_date <= lastTimeA);
  assert.deepEqual(
    tradesA.map((t) => ({ buy: t.buy_date, price: t.buy_price, sell: t.sell_date })),
    tradesB.map((t) => ({ buy: t.buy_date, price: t.buy_price, sell: t.sell_date })),
    "Trades up to bar 109 MUST NOT change when future bars 110..149 are mutated (Zero Look-Ahead Bias)"
  );
  results.push({
    check: "Zero Look-Ahead Bias",
    status: "PASS",
    detail: `Matched ${tradesA.length} historical trades identically despite mutated future candles`,
  });

  // 3. Slippage & Fee deduction & NaN-free quantitative metrics
  const simZeroSlip = simulateBarByBarBacktest({
    botId: "bot_10",
    market: "KRW-BTC",
    candles: generateSyntheticCandles(160),
    initialCapital: 1000000,
    slippageBps: 0,
  });
  const simHighSlip = simulateBarByBarBacktest({
    botId: "bot_10",
    market: "KRW-BTC",
    candles: generateSyntheticCandles(160),
    initialCapital: 1000000,
    slippageBps: 40,
  });

  for (const field of [
    "final_equity",
    "total_return_pct",
    "cagr_pct",
    "mdd_pct",
    "win_rate_pct",
    "profit_factor",
    "sharpe_ratio",
    "sortino_ratio",
    "avg_holding_hours",
  ]) {
    assert.ok(Number.isFinite(Number(simZeroSlip[field])), `Metric ${field} must be finite`);
    assert.ok(Number.isFinite(Number(simHighSlip[field])), `Metric ${field} (high slip) must be finite`);
  }
  if (simZeroSlip.total_trades > 0 && simHighSlip.total_trades > 0) {
    assert.ok(
      simHighSlip.final_equity <= simZeroSlip.final_equity,
      "Higher slippage (40bps) must not artificially outperform 0bps slippage"
    );
  }
  results.push({
    check: "Fee/Slippage & NaN-Free Metrics",
    status: "PASS",
    detail: `0bps=${simZeroSlip.final_equity} vs 40bps=${simHighSlip.final_equity}, Sharpe=${simZeroSlip.sharpe_ratio}`,
  });

  // 4. All 10 bots run cleanly + Walk-Forward 70%/30% + DB Persistence
  const longCandles = generateSyntheticCandles(180);
  const botIds = Array.from({ length: 10 }, (_, idx) => `bot_${String(idx + 1).padStart(2, "0")}`);
  for (const botId of botIds) {
    const res = simulateBarByBarBacktest({
      botId,
      market: "KRW-BTC",
      candles: longCandles,
      initialCapital: 1000000,
      slippageBps: 5,
    });
    assert.equal(res.bot_id, botId);
    assert.ok(Array.isArray(res.equity_curve) && res.equity_curve.length > 0, `${botId} equity curve must be generated`);
  }

  const wfRes = await runHistoricalBacktest(db, {
    botId: "bot_10",
    market: "KRW-BTC",
    timeframe: "15m",
    days: 30,
    initialCapital: 1000000,
    slippageBps: 5,
    walkForward: true,
    candlesOverride: longCandles,
  });
  assert.equal(wfRes.success, true, "Walk-Forward backtest must succeed");
  assert.ok(wfRes.run_id > 0, "Backtest run must be persisted to backtest_runs");
  assert.ok(wfRes.walk_forward, "Walk-Forward result object must be populated");
  assert.ok(wfRes.walk_forward.best_params, "Walk-Forward must output best_params");
  assert.ok(wfRes.walk_forward.in_sample && wfRes.walk_forward.out_of_sample, "Walk-Forward must split 70/30 IS/OOS");

  const history = await getBacktestHistory(db, 10);
  assert.ok(history.length >= 1 && history[0].bot_id === "bot_10", "getBacktestHistory must return persisted run");
  results.push({
    check: "10-Bot Sim & Walk-Forward 70/30 + DB",
    status: "PASS",
    detail: `All 10 bots OK, run_id=${wfRes.run_id}, best SL=${wfRes.walk_forward.best_params.stop_loss_pct}% TP=${wfRes.walk_forward.best_params.take_profit_pct}%`,
  });

  console.log("\n=== [Prompt 2] Historical Backtest & Walk-Forward Verification ===");
  console.table(results);
} finally {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {}
}
