import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_DIR = path.resolve(__dirname, "..");
const TEST_DB_PATH = path.resolve(BASE_DIR, "data", "test_rotation_verify.db");

function cleanupTestDbFiles() {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const p = `${TEST_DB_PATH}${suffix}`;
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  }
}

cleanupTestDbFiles();

process.env.AUTOCOIN_DB_PATH = TEST_DB_PATH;
process.env.DB_MODE = "sqlite";
process.env.PG_SYNC_ENABLED = "false";
process.env.AUTOCOIN_LIBRARY_MODE = "1";
process.env.AUTOCOIN_FORCE_LIVE_MODE = "1";

const {
  getDb,
  initializeDatabase,
  getBots,
  applyLiveBotsSelection,
  getRotationStatusPayload,
  executeWeeklyBotRotation,
  executeBotBuyOrder,
  executeBotSellOrder,
  runLiveTradingBotsCycle,
  evaluateWeeklyStrategyChampions,
} = await import("../backend/node_server.mjs");

function formatKstDateTime(offsetDays = 0, offsetHours = 0) {
  const kst = new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400 * 1000 + offsetHours * 3600 * 1000);
  const yyyy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kst.getUTCDate()).padStart(2, "0");
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mi = String(kst.getUTCMinutes()).padStart(2, "0");
  const ss = String(kst.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

async function resetLiveLedgers(db) {
  await db.exec(`
    DELETE FROM bot_positions;
    DELETE FROM trades;
    DELETE FROM paper_bot_positions;
    DELETE FROM paper_trades;
    DELETE FROM auto_rotation_history;
    DELETE FROM drain_handoff_logs;
    UPDATE bots
    SET is_selected_for_live = 0,
        is_running = 0,
        allocation_ratio = 0,
        allocated_capital = 0,
        virtual_krw = 0,
        last_status_msg = '대기 중',
        paper_initial_capital = 1000000,
        paper_virtual_krw = 1000000,
        paper_mdd_pct = 0;
    UPDATE auto_rotation_config
    SET is_enabled = 1,
        allocation_mode = 'RANK_WEIGHTED_40_35_25',
        min_weekly_trades = 2,
        last_rotated_at = NULL
    WHERE id = 1;
    INSERT OR REPLACE INTO market_regime_filter (
      id, sentiment_score, market_regime, risk_alert, recommended_action,
      position_size_multiplier, final_risk_alert, final_position_multiplier
    ) VALUES (1, 0.2, 'BULL', 0, 'NORMAL', 1.0, 0, 1.0);
  `);
}

async function seedCompletedPaperTrade(db, botId, profitPct, mddPct = 1.0, offsetDays = -1, seq = 1) {
  const buyAmount = 100000;
  const profitKrw = Math.round(buyAmount * (profitPct / 100));
  const sellAmount = buyAmount + profitKrw;
  const buyDate = formatKstDateTime(offsetDays, -2);
  const sellDate = formatKstDateTime(offsetDays, 0);
  await db.prepare(`
    INSERT INTO paper_trades (
      bot_id, market, buy_order_uuid, sell_order_uuid,
      buy_price, buy_volume, buy_amount, buy_date,
      sell_price, sell_volume, sell_amount, sell_date,
      profit_krw, profit_pct, status, buy_reason, sell_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', 'test-buy', 'test-sell')
  `).run(
    botId,
    "KRW-BTC",
    `paper-buy-${botId}-${seq}`,
    `paper-sell-${botId}-${seq}`,
    100000000,
    "0.00100000",
    buyAmount,
    buyDate,
    Math.round(100000000 * (1 + profitPct / 100)),
    "0.00100000",
    sellAmount,
    sellDate,
    profitKrw,
    profitPct
  );
  await db.prepare("UPDATE bots SET paper_mdd_pct = ?, paper_virtual_krw = paper_virtual_krw + ? WHERE bot_id = ?").run(
    mddPct,
    profitKrw,
    botId
  );
}

async function insertLiveOpenPosition(db, { botId, market, orderUuid, volume, avgBuyPrice, buyAmount, createdAt }) {
  const buyDate = createdAt || formatKstDateTime(-1, 0);
  const tr = await db.prepare(`
    INSERT INTO trades (bot_id, market, buy_order_uuid, buy_price, buy_volume, buy_amount, buy_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'HOLDING')
  `).run(botId, market, orderUuid, avgBuyPrice, String(volume), buyAmount, buyDate);
  const tradeId = Number(tr.lastInsertRowid);
  const posRes = await db.prepare(`
    INSERT INTO bot_positions (bot_id, market, ticker, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
  `).run(botId, market, market, orderUuid, String(volume), avgBuyPrice, buyAmount, Math.floor(buyAmount * 0.0005), tradeId, buyDate);
  return { positionId: Number(posRes.lastInsertRowid), tradeId };
}

async function seedDefaultWeeklyChampionsScenario(db) {
  // TREND_SWING (bot_02, bot_03, bot_07, bot_08) -> winner: bot_03 (+18.0%)
  await seedCompletedPaperTrade(db, "bot_03", 9.0, 0.8, -2, 1);
  await seedCompletedPaperTrade(db, "bot_03", 9.0, 0.8, -1, 2);
  await seedCompletedPaperTrade(db, "bot_02", 4.0, 2.0, -2, 1);
  await seedCompletedPaperTrade(db, "bot_02", 3.0, 2.0, -1, 2);
  await seedCompletedPaperTrade(db, "bot_07", 2.0, 2.5, -2, 1);
  await seedCompletedPaperTrade(db, "bot_07", 1.5, 2.5, -1, 2);
  await seedCompletedPaperTrade(db, "bot_08", 1.0, 3.0, -2, 1);
  await seedCompletedPaperTrade(db, "bot_08", 1.0, 3.0, -1, 2);

  // VOLATILITY_BREAKOUT (bot_01, bot_04, bot_09) -> winner: bot_09 (+15.0%)
  await seedCompletedPaperTrade(db, "bot_09", 8.0, 1.1, -2, 1);
  await seedCompletedPaperTrade(db, "bot_09", 7.0, 1.1, -1, 2);
  await seedCompletedPaperTrade(db, "bot_01", 3.0, 2.4, -2, 1);
  await seedCompletedPaperTrade(db, "bot_01", 2.5, 2.4, -1, 2);
  await seedCompletedPaperTrade(db, "bot_04", 1.5, 2.9, -2, 1);
  await seedCompletedPaperTrade(db, "bot_04", 1.0, 2.9, -1, 2);

  // REVERSAL_GRID (bot_05, bot_06, bot_10) -> winner: bot_10 (+12.0%)
  await seedCompletedPaperTrade(db, "bot_10", 6.5, 1.4, -2, 1);
  await seedCompletedPaperTrade(db, "bot_10", 5.5, 1.4, -1, 2);
  await seedCompletedPaperTrade(db, "bot_05", 2.5, 2.8, -2, 1);
  await seedCompletedPaperTrade(db, "bot_05", 2.0, 2.8, -1, 2);
  await seedCompletedPaperTrade(db, "bot_06", 1.0, 3.1, -2, 1);
  await seedCompletedPaperTrade(db, "bot_06", 1.0, 3.1, -1, 2);
}

function summarizeBotCash(bots) {
  return bots
    .filter((b) => Number(b.is_selected_for_live) === 1 || (b.open_positions || []).length > 0 || Number(b.virtual_krw) > 0)
    .map((b) => ({
      bot_id: b.bot_id,
      live: Number(b.is_selected_for_live),
      ratio: Number(b.allocation_ratio),
      allocated_krw: Math.floor(Number(b.allocated_capital)),
      used_krw: Math.floor(Number(b.used_capital)),
      virtual_krw: Math.floor(Number(b.virtual_krw)),
      open_pos: (b.open_positions || []).length,
    }));
}

async function runTests() {
  await initializeDatabase();
  const db = getDb();
  const reportRows = [];

  try {
    // =========================================================================
    // Scenario 1: 주간 전략군 TOP 1 선출 정확도 (3대 전략군 각 1명씩 3명 선출)
    // =========================================================================
    await resetLiveLedgers(db);
    await seedDefaultWeeklyChampionsScenario(db);
    const evalRes = await evaluateWeeklyStrategyChampions(db, {
      minWeeklyTrades: 2,
      allocationMode: "RANK_WEIGHTED_40_35_25",
    });
    assert.equal(evalRes.champions.length, 3, "Scenario 1: Exactly 3 strategy-group champions must be elected");
    const championByGroup = Object.fromEntries(evalRes.champions.map((c) => [c.strategy_group_code, c.bot_id]));
    assert.equal(championByGroup.TREND_SWING, "bot_03", "TREND_SWING champion must be bot_03");
    assert.equal(championByGroup.VOLATILITY_BREAKOUT, "bot_09", "VOLATILITY_BREAKOUT champion must be bot_09");
    assert.equal(championByGroup.REVERSAL_GRID, "bot_10", "REVERSAL_GRID champion must be bot_10");
    assert.deepEqual(
      evalRes.champions.map((c) => [c.bot_id, c.champion_rank, c.recommended_ratio]),
      [
        ["bot_03", 1, 40],
        ["bot_09", 2, 35],
        ["bot_10", 3, 25],
      ],
      "Champions must be ranked 1/2/3 with 40/35/25 ratios"
    );
    reportRows.push({
      scenario: "Scenario 1",
      check: "Weekly Top-1 Election (3 Groups)",
      detail: evalRes.champions.map((c) => `${c.strategy_group_code}:${c.bot_id}(${c.recommended_ratio}%)`).join(", "),
      status: "PASS",
    });

    // =========================================================================
    // Scenario 2: 로테이션 시 미매도 포지션 보호(강제청산 금지) + 가용 원화 1,000,003원 회수·분배 + 1원 자투리 Zero-Sum
    // =========================================================================
    await insertLiveOpenPosition(db, {
      botId: "bot_01",
      market: "KRW-BTC",
      orderUuid: "live-pos-bot01-1",
      volume: 0.001,
      avgBuyPrice: 100000000,
      buyAmount: 100000,
    });
    await insertLiveOpenPosition(db, {
      botId: "bot_06",
      market: "KRW-ETH",
      orderUuid: "live-pos-bot06-1",
      volume: 0.0375,
      avgBuyPrice: 4000000,
      buyAmount: 150000,
    });

    // 초기 3개 실전 봇: 미사용 가용 원화 합계 1,000,003원 (= 350,001 + 400,001 + 250,001) + 보유 원금 250,000원
    await db.prepare(
      "UPDATE bots SET is_selected_for_live = 1, is_running = 1, allocation_ratio = 40, allocated_capital = 450001, virtual_krw = 350001 WHERE bot_id = 'bot_01'"
    ).run();
    await db.prepare(
      "UPDATE bots SET is_selected_for_live = 1, is_running = 1, allocation_ratio = 35, allocated_capital = 400001, virtual_krw = 400001 WHERE bot_id = 'bot_02'"
    ).run();
    await db.prepare(
      "UPDATE bots SET is_selected_for_live = 1, is_running = 1, allocation_ratio = 25, allocated_capital = 400001, virtual_krw = 250001 WHERE bot_id = 'bot_06'"
    ).run();
    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('total_capital', '1250003', ?)").run(
      formatKstDateTime()
    );
    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('capital_configured', '1', ?)").run(
      formatKstDateTime()
    );

    const beforeSc2Bots = await getBots("live");
    const preCashPool = beforeSc2Bots
      .filter((b) => Number(b.is_selected_for_live) === 1)
      .reduce((acc, b) => acc + Number(b.virtual_krw || 0), 0);
    assert.equal(preCashPool, 1000003, "Pre-rotation liquid cash pool must equal 1,000,003 KRW");
    console.log("\n[Scenario 2] BEFORE Rotation Cash/Position Table:");
    console.table(summarizeBotCash(beforeSc2Bots));

    const rotRes2 = await executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", skipLiveAccountSync: true });
    assert.equal(rotRes2.success, true, "Scenario 2 rotation must succeed");

    const afterSc2Bots = await getBots("live");
    console.log("[Scenario 2] AFTER Rotation Cash/Position Table:");
    console.table(summarizeBotCash(afterSc2Bots));

    const openPosRowsAfter2 = await db.prepare("SELECT * FROM bot_positions WHERE status = 'OPEN' ORDER BY id ASC").all();
    assert.equal(openPosRowsAfter2.length, 2, "Dropped bots' 2 open positions MUST remain OPEN (no forced sell)");

    const bot01After2 = afterSc2Bots.find((b) => b.bot_id === "bot_01");
    const bot02After2 = afterSc2Bots.find((b) => b.bot_id === "bot_02");
    const bot06After2 = afterSc2Bots.find((b) => b.bot_id === "bot_06");
    assert.equal(Number(bot01After2.is_selected_for_live), 0);
    assert.equal(Number(bot01After2.virtual_krw), 0);
    assert.equal(Number(bot01After2.allocation_ratio), 0);
    assert.equal(Number(bot02After2.virtual_krw), 0);
    assert.equal(Number(bot02After2.allocation_ratio), 0);
    assert.equal(Number(bot06After2.is_selected_for_live), 0);
    assert.equal(Number(bot06After2.virtual_krw), 0);
    assert.equal(Number(bot06After2.allocation_ratio), 0);

    const bot03After2 = afterSc2Bots.find((b) => b.bot_id === "bot_03");
    const bot09After2 = afterSc2Bots.find((b) => b.bot_id === "bot_09");
    const bot10After2 = afterSc2Bots.find((b) => b.bot_id === "bot_10");
    // 1,000,003 * (40/35/25%) = floor(400001.2)=400001 + floor(350001.05)=350001 + floor(250000.75)=250000 = 1,000,002 -> +1 dust to #1 bot_03!
    assert.equal(Number(bot03After2.virtual_krw), 400002, "#1 bot_03 must receive 400,001 + 1 KRW remainder dust = 400,002");
    assert.equal(Number(bot09After2.virtual_krw), 350001, "#2 bot_09 must receive 350,001");
    assert.equal(Number(bot10After2.virtual_krw), 250000, "#3 bot_10 must receive 250,000");

    const postCashPool = afterSc2Bots.reduce((acc, b) => acc + Number(b.virtual_krw || 0), 0);
    assert.equal(postCashPool, preCashPool, "Zero-Sum Invariant: postCashPool === preCashPool (0 KRW diff)");
    reportRows.push({
      scenario: "Scenario 2",
      check: "Zero-Sum Transfer + No Forced Sell + 1 KRW Dust",
      detail: `Before ${preCashPool.toLocaleString()} -> After ${postCashPool.toLocaleString()} (bot_03:${bot03After2.virtual_krw}, bot_09:${bot09After2.virtual_krw}, bot_10:${bot10After2.virtual_krw})`,
      status: "PASS",
    });

    // =========================================================================
    // Scenario 3: Draining 봇 신규 매수 완전 차단 + AI BLOCK / risk_alert 하에서도 청산 루프 정상 매도 및 정산금 이관
    // =========================================================================
    // AI 전면 BLOCK + risk_alert = 1 설정
    const allBlockedOverrides = JSON.stringify({
      bot_01: "BLOCK", bot_02: "BLOCK", bot_03: "BLOCK", bot_04: "BLOCK", bot_05: "BLOCK",
      bot_06: "BLOCK", bot_07: "BLOCK", bot_08: "BLOCK", bot_09: "BLOCK", bot_10: "BLOCK",
    });
    await db.prepare(`
      UPDATE market_regime_filter
      SET market_regime = 'CRASH',
          risk_alert = 1,
          recommended_action = 'HOLD_ALL',
          final_risk_alert = 1,
          final_position_multiplier = 0.0,
          bot_overrides_json = ?,
          final_bot_overrides_json = ?
      WHERE id = 1
    `).run(allBlockedOverrides, allBlockedOverrides);

    // 3-A: Draining 봇 신규 매수 절대 차단 검증
    const drainBuyAttempt = await executeBotBuyOrder(bot01After2, "KRW-ETH", 50000, 4000000);
    assert.equal(drainBuyAttempt, false, "Scenario 3: Draining bot executeBotBuyOrder MUST return false");

    // 3-B: 익절가 도달 시 (KRW-BTC +5% -> 105,000,000), bot_01의 미매도 포지션은 AI BLOCK에도 불구하고 정상 익절 매도되어야 함
    // bot_06(KRW-ETH)은 평단 유지(4,000,000)로 아직 미청산 상태 유지
    const activeCashBeforeDrain1 = (await getBots("live"))
      .filter((b) => Number(b.is_selected_for_live) === 1)
      .reduce((acc, b) => acc + Number(b.virtual_krw || 0), 0);

    const sellPriceBtc = 105000000;
    const expectedGrossBtc = Math.floor(0.001 * sellPriceBtc); // 105,000
    const expectedFeeBtc = Math.floor(expectedGrossBtc * 0.0005); // 52
    const expectedNetBtc = expectedGrossBtc - expectedFeeBtc; // 104,948

    const tickerMap3 = new Map([
      ["KRW-BTC", { market: "KRW-BTC", trade_price: sellPriceBtc, signed_change_rate: 0.05, acc_trade_price_24h: 10000000000 }],
      ["KRW-ETH", { market: "KRW-ETH", trade_price: 4000000, signed_change_rate: 0.0, acc_trade_price_24h: 5000000000 }],
    ]);
    const mdMap3 = new Map([
      ["KRW-BTC", { indicators: { atr: 1000000, rsi: 68, adx: 30, ma20: 100000000 }, candles: [] }],
      ["KRW-ETH", { indicators: { atr: 50000, rsi: 50, adx: 20, ma20: 4000000 }, candles: [] }],
    ]);
    await runLiveTradingBotsCycle({
      tickerMapOverride: tickerMap3,
      mdMapOverride: mdMap3,
      rankMapOverride: new Map([["KRW-BTC", 1], ["KRW-ETH", 2]]),
      skipUpbitApi: true,
    });

    const botsAfterSc3 = await getBots("live");
    const bot01Sc3 = botsAfterSc3.find((b) => b.bot_id === "bot_01");
    assert.equal((bot01Sc3.open_positions || []).length, 0, "Scenario 3: bot_01 draining position must close under AI BLOCK");
    assert.equal(Number(bot01Sc3.virtual_krw), 0, "Draining bot_01 must keep 0 virtual_krw after settlement");
    assert.ok(
      String(bot01Sc3.last_status_msg || "").includes("Graceful Drain 완료"),
      `bot_01 completion status message must be preserved, got: ${bot01Sc3.last_status_msg}`
    );

    const activeCashAfterDrain1 = botsAfterSc3
      .filter((b) => Number(b.is_selected_for_live) === 1)
      .reduce((acc, b) => acc + Number(b.virtual_krw || 0), 0);
    assert.equal(
      activeCashAfterDrain1 - activeCashBeforeDrain1,
      expectedNetBtc,
      `Active champions must receive exact netProceeds ${expectedNetBtc} KRW from bot_01 sell`
    );

    const rotStatus3 = await getRotationStatusPayload({ skipMarketFetch: true });
    assert.equal(rotStatus3.draining_positions.length, 1, "Only bot_06 ETH position should remain draining");
    assert.equal(rotStatus3.total_drain_transferred_krw, expectedNetBtc, "drain_handoff_logs total must match netProceeds");

    reportRows.push({
      scenario: "Scenario 3",
      check: "Draining Sell Under AI BLOCK + Buy Block",
      detail: `BuyBlocked=true, bot_01 Sell Net=${expectedNetBtc.toLocaleString()} KRW -> Active Pool +${(activeCashAfterDrain1 - activeCashBeforeDrain1).toLocaleString()} KRW`,
      status: "PASS",
    });

    // =========================================================================
    // Scenario 4: Draining 다중(복수 order_uuid) 포지션 순차 매도 체결 및 손절 시 정산금 이관 + Remainder Dust
    // =========================================================================
    // bot_06 동일 종목 KRW-ETH 2번째 분할 order_uuid 포지션 추가 -> 1차 익절(+3%), 2차 손절(-2%) 순차 매도
    await insertLiveOpenPosition(db, {
      botId: "bot_06",
      market: "KRW-ETH",
      orderUuid: "live-pos-bot06-2",
      volume: 0.025,
      avgBuyPrice: 4000000,
      buyAmount: 100000,
    });
    await db.prepare("UPDATE bots SET allocated_capital = allocated_capital + 100000 WHERE bot_id = 'bot_06'").run();

    const sc4BotsBefore = await getBots("live");
    const bot06ForSc4 = sc4BotsBefore.find((b) => b.bot_id === "bot_06");
    assert.equal(bot06ForSc4.open_positions.length, 2, "Scenario 4: bot_06 must hold 2 split positions");

    // Step 4-1: 1번 포지션(+3% 익절: 4,120,000원, 수량 0.0375, order_uuid: live-pos-bot06-1) 단독 매도
    const pos1 = bot06ForSc4.open_positions.find((p) => p.order_uuid === "live-pos-bot06-1");
    assert.ok(pos1, "Scenario 4: pos1 (live-pos-bot06-1) must exist");
    const cashBefore4_1 = sc4BotsBefore
      .filter((b) => Number(b.is_selected_for_live) === 1)
      .reduce((acc, b) => acc + Number(b.virtual_krw || 0), 0);
    const sellPrice4_1 = 4120000;
    const net4_1 = Math.floor(0.0375 * sellPrice4_1) - Math.floor(Math.floor(0.0375 * sellPrice4_1) * 0.0005); // 154,500 - 77 = 154,423

    const sold1 = await executeBotSellOrder(bot06ForSc4, pos1, sellPrice4_1, "익절(+3.00%)", { skipUpbitApi: true });
    assert.equal(sold1, true, "First split position sell must succeed");

    const sc4BotsMid = await getBots("live");
    const bot06Mid = sc4BotsMid.find((b) => b.bot_id === "bot_06");
    assert.equal(bot06Mid.open_positions.length, 1, "Second split position must STILL remain OPEN");
    assert.equal(bot06Mid.open_positions[0].order_uuid, "live-pos-bot06-2", "Remaining position must be live-pos-bot06-2");
    assert.equal(Number(bot06Mid.virtual_krw), 0, "Dropped bot_06 virtual_krw must stay 0");
    const cashAfter4_1 = sc4BotsMid
      .filter((b) => Number(b.is_selected_for_live) === 1)
      .reduce((acc, b) => acc + Number(b.virtual_krw || 0), 0);
    assert.equal(cashAfter4_1 - cashBefore4_1, net4_1, "Exact proceeds of pos1 must be handed off to active bots");

    // Step 4-2: 2번 포지션(-2% 손절: 3,920,000원, 수량 0.025, order_uuid: live-pos-bot06-2) 마저 매도 (원금 100,000보다 적은 97,951원 회수 검증)
    const pos2 = bot06Mid.open_positions.find((p) => p.order_uuid === "live-pos-bot06-2");
    assert.ok(pos2, "Scenario 4: pos2 (live-pos-bot06-2) must exist");
    const sellPrice4_2 = 3920000;
    const gross4_2 = Math.floor(0.025 * sellPrice4_2); // 98,000
    const fee4_2 = Math.floor(gross4_2 * 0.0005); // 49
    const net4_2 = gross4_2 - fee4_2; // 97,951 (< 100,000 buy_amount -> loss recovery)

    const sold2 = await executeBotSellOrder(bot06Mid, pos2, sellPrice4_2, "손절(-2.00%)", { skipUpbitApi: true });
    assert.equal(sold2, true, "Second split stop-loss position sell must succeed");

    const sc4BotsEnd = await getBots("live");
    const bot06End = sc4BotsEnd.find((b) => b.bot_id === "bot_06");
    assert.equal(bot06End.open_positions.length, 0, "All draining positions must now be CLOSED");
    assert.equal(Number(bot06End.virtual_krw), 0, "Draining bot virtual_krw must stay 0 after full drain");

    const cashAfter4_2 = sc4BotsEnd
      .filter((b) => Number(b.is_selected_for_live) === 1)
      .reduce((acc, b) => acc + Number(b.virtual_krw || 0), 0);
    assert.equal(cashAfter4_2 - cashAfter4_1, net4_2, "Stop-loss positive recovery net4_2 must hand off cleanly");
    const rotStatus4 = await getRotationStatusPayload({ skipMarketFetch: true });
    assert.equal(rotStatus4.draining_positions.length, 0, "Zero draining positions remain");

    reportRows.push({
      scenario: "Scenario 4",
      check: "Multi-Pos Sequential Drain + Stop-Loss Handoff",
      detail: `TP +3% Net=${net4_1.toLocaleString()}, SL -2% Net=${net4_2.toLocaleString()}, Remaining Drain=0, Total Diff=0 KRW`,
      status: "PASS",
    });

    // =========================================================================
    // Scenario 5: 재선출 봇(포지션 유지) 및 Draining 봇 재선출(실전 복귀 시 스테이터스/자금 복구)
    // =========================================================================
    await resetLiveLedgers(db);
    // bot_02(선발, 포지션 보유), bot_01(선발, 현금만), bot_09(선발, 현금만), 그리고 bot_06(Draining 상태, 미매도 포지션 75,000원)
    await insertLiveOpenPosition(db, {
      botId: "bot_02",
      market: "KRW-BTC",
      orderUuid: "sc5-pos-bot02",
      volume: 0.0005,
      avgBuyPrice: 100000000,
      buyAmount: 50000,
    });
    await insertLiveOpenPosition(db, {
      botId: "bot_06",
      market: "KRW-XRP",
      orderUuid: "sc5-pos-bot06",
      volume: 100,
      avgBuyPrice: 750,
      buyAmount: 75000,
    });
    await db.prepare(
      "UPDATE bots SET is_selected_for_live = 1, is_running = 1, allocation_ratio = 40, allocated_capital = 350000, virtual_krw = 300000 WHERE bot_id = 'bot_02'"
    ).run();
    await db.prepare(
      "UPDATE bots SET is_selected_for_live = 1, is_running = 1, allocation_ratio = 35, allocated_capital = 350000, virtual_krw = 350000 WHERE bot_id = 'bot_01'"
    ).run();
    await db.prepare(
      "UPDATE bots SET is_selected_for_live = 1, is_running = 1, allocation_ratio = 25, allocated_capital = 225000, virtual_krw = 225000 WHERE bot_id = 'bot_09'"
    ).run();
    await db.prepare(
      "UPDATE bots SET is_selected_for_live = 0, is_running = 0, allocation_ratio = 0, allocated_capital = 75000, virtual_krw = 0, last_status_msg = '[🛡️ Graceful Drain] 실전 교체됨 · 미매도 포지션 1건(75,000원)' WHERE bot_id = 'bot_06'"
    ).run();

    // 주간 성과: bot_02 (TREND_SWING 1위 유지), bot_01 (VOLATILITY_BREAKOUT 1위), bot_06 (REVERSAL_GRID Draining->1위 복귀!)
    await seedCompletedPaperTrade(db, "bot_02", 12.0, 0.9, -2, 1);
    await seedCompletedPaperTrade(db, "bot_02", 8.0, 0.9, -1, 2);
    await seedCompletedPaperTrade(db, "bot_01", 9.0, 1.2, -2, 1);
    await seedCompletedPaperTrade(db, "bot_01", 6.0, 1.2, -1, 2);
    await seedCompletedPaperTrade(db, "bot_06", 7.0, 1.3, -2, 1);
    await seedCompletedPaperTrade(db, "bot_06", 5.0, 1.3, -1, 2);

    const sc5Before = await getBots("live");
    const preCashSc5 = sc5Before.reduce((acc, b) => acc + Number(b.virtual_krw || 0), 0); // 875,000
    assert.equal(preCashSc5, 875000, "Pre-rotation liquid cash in Sc5 must be 875,000");

    const rotRes5 = await executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", skipLiveAccountSync: true });
    assert.equal(rotRes5.success, true);

    const sc5After = await getBots("live");
    const bot02Sc5 = sc5After.find((b) => b.bot_id === "bot_02");
    const bot01Sc5 = sc5After.find((b) => b.bot_id === "bot_01");
    const bot06Sc5 = sc5After.find((b) => b.bot_id === "bot_06");
    const bot09Sc5 = sc5After.find((b) => b.bot_id === "bot_09");

    assert.equal(Number(bot02Sc5.is_selected_for_live), 1);
    assert.equal((bot02Sc5.open_positions || []).length, 1, "Re-elected bot_02 must retain its open position");
    assert.equal(Number(bot06Sc5.is_selected_for_live), 1, "Draining bot_06 must return to is_selected_for_live = 1");
    assert.equal((bot06Sc5.open_positions || []).length, 1, "Re-elected bot_06 must retain its open position");
    assert.ok(
      !String(bot06Sc5.last_status_msg || "").includes("Graceful Drain"),
      `Re-elected bot_06 must clear stale Graceful Drain text, got: ${bot06Sc5.last_status_msg}`
    );
    // Total pool = 875,000 cash + 50,000 (bot_02) + 75,000 (bot_06) = 1,000,000 -> 40/35/25 = 400k / 350k / 250k -> virtual: 350k / 350k / 175k
    assert.equal(Number(bot02Sc5.virtual_krw), 350000);
    assert.equal(Number(bot01Sc5.virtual_krw), 350000);
    assert.equal(Number(bot06Sc5.virtual_krw), 175000);
    assert.equal(Number(bot09Sc5.is_selected_for_live), 0);
    assert.equal(Number(bot09Sc5.virtual_krw), 0);
    const postCashSc5 = sc5After.reduce((acc, b) => acc + Number(b.virtual_krw || 0), 0);
    assert.equal(postCashSc5, preCashSc5, "Zero-Sum preserved across re-elected & draining-return bots");

    reportRows.push({
      scenario: "Scenario 5",
      check: "Re-Elected & Draining-to-Selected Return",
      detail: `bot_02(${bot02Sc5.virtual_krw}/used 50k), bot_01(${bot01Sc5.virtual_krw}), bot_06(${bot06Sc5.virtual_krw}/used 75k)`,
      status: "PASS",
    });

    // =========================================================================
    // Scenario 6: 콜드 스타트(paper_trades 0건) 안전한 누적 Arena 폴백 및 결정적 선출
    // =========================================================================
    await resetLiveLedgers(db);
    await db.prepare(
      "UPDATE bots SET is_selected_for_live = 1, is_running = 1, allocation_ratio = 40, allocated_capital = 400000, virtual_krw = 400000 WHERE bot_id = 'bot_03'"
    ).run();
    await db.prepare(
      "UPDATE bots SET is_selected_for_live = 1, is_running = 1, allocation_ratio = 35, allocated_capital = 350000, virtual_krw = 350000 WHERE bot_id = 'bot_09'"
    ).run();
    await db.prepare(
      "UPDATE bots SET is_selected_for_live = 1, is_running = 1, allocation_ratio = 25, allocated_capital = 250000, virtual_krw = 250000 WHERE bot_id = 'bot_10'"
    ).run();

    const coldEval = await evaluateWeeklyStrategyChampions(db, {
      minWeeklyTrades: 2,
      allocationMode: "RANK_WEIGHTED_40_35_25",
    });
    assert.equal(coldEval.champions.length, 3, "Cold start must still elect 3 group champions");
    assert.ok(
      coldEval.champions.every((c) => c.evaluation_basis === "ARENA_CUMULATIVE_FALLBACK" && Number.isFinite(c.rotation_score)),
      "Cold start must fall back cleanly to ARENA_CUMULATIVE_FALLBACK without NaN scores"
    );
    const coldIds = new Set(coldEval.champions.map((c) => c.bot_id));
    // paper_trades 0건·동률 시 각 전략군 첫 번째 bot_id(bot_02, bot_01, bot_05)로 결정적 폴백 선출
    assert.ok(coldIds.has("bot_02") && coldIds.has("bot_01") && coldIds.has("bot_05"), "Cold start deterministically selects group leads on 0 trades");

    const coldRot = await executeWeeklyBotRotation({ triggerType: "SCHEDULED_WEEKLY", skipLiveAccountSync: true });
    assert.equal(coldRot.success, true, "Cold start scheduled rotation must succeed cleanly");
    const sc6After = await getBots("live");
    assert.equal(
      sc6After.reduce((acc, b) => acc + Number(b.virtual_krw || 0), 0),
      1000000,
      "Cold start Zero-Sum capital equals 1,000,000"
    );

    reportRows.push({
      scenario: "Scenario 6",
      check: "Cold Start (0 Trades) Arena Fallback",
      detail: coldEval.champions.map((c) => `${c.bot_id}(${c.evaluation_basis})`).join(", "),
      status: "PASS",
    });

    // =========================================================================
    // Scenario 7: 동시 중복 로테이션/할당 방지 (already_running & Mutex 직렬화 + 0 KRW 중복 지급 차단)
    // =========================================================================
    await seedDefaultWeeklyChampionsScenario(db);
    const [concR1, concR2] = await Promise.all([
      executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", skipLiveAccountSync: true }),
      executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", skipLiveAccountSync: true }),
    ]);
    const rotResults = [concR1, concR2];
    const okCount = rotResults.filter((r) => r.success === true).length;
    const alreadyRunningCount = rotResults.filter((r) => r.already_running === true && r.success === false).length;
    assert.equal(okCount, 1, "Only ONE concurrent executeWeeklyBotRotation call may succeed");
    assert.equal(alreadyRunningCount, 1, "Second concurrent executeWeeklyBotRotation call must return already_running");

    // applyLiveBotsSelection 뮤텍스 직렬화 동시 호출 테스트 (홀수 1,000,003원 2회 동시 요청 -> 총 원금 인플레 0원)
    const selA = [
      { bot_id: "bot_03", allocation_ratio: 0.4 },
      { bot_id: "bot_09", allocation_ratio: 0.35 },
      { bot_id: "bot_10", allocation_ratio: 0.25 },
    ];
    const selB = [
      { bot_id: "bot_02", allocation_ratio: 0.4 },
      { bot_id: "bot_01", allocation_ratio: 0.35 },
      { bot_id: "bot_06", allocation_ratio: 0.25 },
    ];
    const [mutexA, mutexB] = await Promise.all([
      applyLiveBotsSelection(selA, [], 1000003, { skipLiveAccountSync: true }),
      applyLiveBotsSelection(selB, [], 1000003, { skipLiveAccountSync: true }),
    ]);
    assert.equal(mutexA.success, true);
    assert.equal(mutexB.success, true);

    const sc7Bots = await getBots("live");
    const sc7CashSum = sc7Bots.reduce((acc, b) => acc + Number(b.virtual_krw || 0), 0);
    assert.equal(sc7CashSum, 1000003, "Mutex concurrent applyLiveBotsSelection must preserve exact 1,000,003 KRW Zero-Sum");

    reportRows.push({
      scenario: "Scenario 7",
      check: "Concurrency Guard & Mutex Zero-Sum",
      detail: `Rotation(1 ok, 1 already_running) + Mutex sum=${sc7CashSum.toLocaleString()} KRW`,
      status: "PASS",
    });

    console.log("\n=== All 7 Weekly Auto-Rotation & Graceful Drain Edge-Case Verification Results ===");
    console.table(reportRows);
  } finally {
    try {
      await db.close();
    } catch {}
    cleanupTestDbFiles();
  }
}

await runTests();
