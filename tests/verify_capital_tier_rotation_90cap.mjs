import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_DIR = path.resolve(__dirname, "..");
const TEST_DB_PATH = path.resolve(BASE_DIR, "data", "test_tier_90cap.db");

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
  resolveTotalEquityAndSingle90Cap,
  getTargetBotCountByTotalEquity,
  selectTieredEqualChampions,
  computeRotationAllocationsWith90Cap,
  reconcileAutoSyncedBudgetsWith90Cap,
  computeDrainSellCapitalRestoration,
  assertGlobal90CapInvariant,
} = await import("../backend/common/algo_lab_service.mjs");

const {
  getDb,
  initializeDatabase,
  getBots,
  syncDynamicLiveCapitalFromUpbit,
  getRotationStatusPayload,
  executeWeeklyBotRotation,
  executeBotBuyOrder,
  executeBotSellOrder,
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

async function resetTestDb(db, totalEquityKrw = 1000000) {
  const now = formatKstDateTime(0, 0);
  const cap90 = Math.floor(totalEquityKrw * 0.9);
  await db.exec(`
    DELETE FROM bot_positions;
    DELETE FROM trades;
    DELETE FROM paper_bot_positions;
    DELETE FROM paper_trades;
    DELETE FROM auto_rotation_history;
    DELETE FROM drain_handoff_logs;
    DELETE FROM capital_restoration_logs;
    UPDATE bots
    SET is_selected_for_live = 0,
        is_running = 0,
        allocation_ratio = 0,
        target_capital_krw = 0,
        allocated_capital = 0,
        virtual_krw = 0,
        drain_status = 'NONE',
        replaced_by_bot_id = NULL,
        drain_started_at = NULL,
        last_status_msg = '대기 중',
        paper_initial_capital = 1000000,
        paper_virtual_krw = 1000000,
        paper_mdd_pct = 0;
    UPDATE auto_rotation_config
    SET is_enabled = 1,
        allocation_mode = 'EQUAL_BY_EQUITY_TIER',
        min_weekly_trades = 2,
        capital_tier_1_max = 400000,
        capital_tier_2_max = 700000,
        max_deploy_ratio = 0.90,
        last_rotated_at = NULL
    WHERE id = 1;
    INSERT OR REPLACE INTO market_regime_filter (
      id, sentiment_score, market_regime, risk_alert, recommended_action,
      position_size_multiplier, final_risk_alert, final_position_multiplier
    ) VALUES (1, 0.2, 'BULL', 0, 'NORMAL', 1.0, 0, 1.0);
  `);
  await db
    .prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('last_synced_total_equity_krw', ?, ?)")
    .run(String(totalEquityKrw), now);
  await db
    .prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('deployable_capital_cap_krw', ?, ?)")
    .run(String(cap90), now);
  await db
    .prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('total_capital', ?, ?)")
    .run(String(cap90), now);
  await db
    .prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('capital_basis_mode', 'LIVE_TOTAL_EQUITY_90CAP', ?)")
    .run(now);
}

async function seedCompletedPaperTrade(db, botId, profitPct, seq = 1) {
  const buyAmount = 100000;
  const profitKrw = Math.round(buyAmount * (profitPct / 100));
  const sellAmount = buyAmount + profitKrw;
  const buyDate = formatKstDateTime(-1, -2);
  const sellDate = formatKstDateTime(-1, 0);
  await db
    .prepare(
      `INSERT INTO paper_trades (
         bot_id, market, buy_order_uuid, sell_order_uuid,
         buy_price, buy_volume, buy_amount, buy_date,
         sell_price, sell_volume, sell_amount, sell_date,
         profit_krw, profit_pct, status, buy_reason, sell_reason
       ) VALUES (?, 'KRW-BTC', ?, ?, 100000000, '0.00100000', ?, ?, ?, '0.00100000', ?, ?, ?, ?, 'COMPLETED', 'test', 'test')`
    )
    .run(
      botId,
      `paper-buy-${botId}-${seq}-${Date.now()}`,
      `paper-sell-${botId}-${seq}-${Date.now()}`,
      buyAmount,
      buyDate,
      100000000 * (1 + profitPct / 100),
      sellAmount,
      sellDate,
      profitKrw,
      profitPct
    );
}

async function seedOpenLivePosition(db, { botId, market = "KRW-BTC", buyAmount = 150000, avgPrice = 100000000, orderUuid = null }) {
  const now = formatKstDateTime(0, -1);
  const uuid = orderUuid || `live-pos-${botId}-${market}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const vol = (buyAmount / avgPrice).toFixed(8);
  const tradeRes = await db
    .prepare(
      `INSERT INTO trades (
         bot_id, market, buy_order_uuid, buy_price, buy_volume, buy_amount, buy_date, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'HOLDING')`
    )
    .run(botId, market, uuid, avgPrice, vol, buyAmount, now);
  const tradeId = Number(tradeRes.lastInsertRowid || 0);
  const posRes = await db
    .prepare(
      `INSERT INTO bot_positions (
         bot_id, market, ticker, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'OPEN', ?)`
    )
    .run(botId, market, market, uuid, vol, avgPrice, buyAmount, tradeId, now);
  return {
    id: Number(posRes.lastInsertRowid || 0),
    bot_id: botId,
    market,
    order_uuid: uuid,
    volume: vol,
    avg_buy_price: avgPrice,
    buy_amount: buyAmount,
    buy_fee: 0,
    trade_id: tradeId,
  };
}

async function getLedgerTotals(db, totalEquityKrw) {
  const bots = await getBots("live");
  const totalDrainingLocked = bots
    .filter((b) => Number(b.is_selected_for_live) !== 1)
    .reduce((acc, b) => acc + Math.max(0, Math.floor(Number(b.used_capital || 0))), 0);
  const totalElectedLocked = bots
    .filter((b) => Number(b.is_selected_for_live) === 1)
    .reduce((acc, b) => acc + Math.max(0, Math.floor(Number(b.used_capital || 0))), 0);
  const totalCash = bots.reduce((acc, b) => acc + Math.max(0, Math.floor(Number(b.virtual_krw || 0))), 0);
  const totalUsed = totalDrainingLocked + totalElectedLocked + totalCash;
  const cap90 = Math.floor(totalEquityKrw * 0.9);
  const utilPct = totalEquityKrw > 0 ? Number(((totalUsed / totalEquityKrw) * 100).toFixed(2)) : 0;
  return { bots, totalDrainingLocked, totalElectedLocked, totalCash, totalUsed, cap90, utilPct };
}

const reportRows = [];

function recordPass(id, name, beforeSum, afterSum, cap90, totalEquity) {
  const ratioPct = totalEquity > 0 ? Number(((afterSum / totalEquity) * 100).toFixed(2)) : 0;
  reportRows.push({
    id,
    name,
    before: `${beforeSum.toLocaleString("ko-KR")}원`,
    after: `${afterSum.toLocaleString("ko-KR")}원`,
    cap90: `${cap90.toLocaleString("ko-KR")}원`,
    util: `${ratioPct}%`,
    status: "PASS",
  });
  console.log(`[PASS] ${id}: ${name} (after=${afterSum.toLocaleString("ko-KR")}원 / cap90=${cap90.toLocaleString("ko-KR")}원, ${ratioPct}%)`);
}

try {
  await initializeDatabase();
  const db = getDb();

  // =========================================================================
  // [Test 1] 실시간 총 평가자산 구간별 봇 개수 및 경계값 정확성
  // =========================================================================
  assert.equal(getTargetBotCountByTotalEquity(9999), 0, "1만원 미만 -> 0개");
  assert.equal(getTargetBotCountByTotalEquity(300000), 1, "30만원 -> 1개");
  assert.equal(getTargetBotCountByTotalEquity(400000), 1, "40만원 -> 1개");
  assert.equal(getTargetBotCountByTotalEquity(400001), 2, "40만 1원 -> 2개");
  assert.equal(getTargetBotCountByTotalEquity(699999), 2, "699,999원 -> 2개");
  assert.equal(getTargetBotCountByTotalEquity(700000), 3, "정확히 70만원 -> 3개");
  assert.equal(getTargetBotCountByTotalEquity(1000000), 3, "100만원 -> 3개");
  recordPass("Test 1", "실시간 총 평가자산 구간별 봇 개수 및 경계값(40만/70만)", 0, 900000, 900000, 1000000);

  // =========================================================================
  // [Test 2] 단일 90% 상한(이중 차감 81% 없음) 및 경계 구간(42만/75만/100만) 검증
  // =========================================================================
  const mockChamps = [
    { bot_id: "bot_02", strategy_group: "TREND_SWING", rotation_score: 12.5 },
    { bot_id: "bot_01", strategy_group: "VOLATILITY_BREAKOUT", rotation_score: 10.2 },
    { bot_id: "bot_05", strategy_group: "REVERSAL_GRID", rotation_score: 8.7 },
  ];
  const s1000 = selectTieredEqualChampions(mockChamps, 1000000);
  assert.equal(s1000.targetCount, 3);
  assert.equal(s1000.globalCapKrw, 900000, "100만원 -> 81만원이 아니라 정확히 90만원(90%)");
  assert.equal(s1000.perBotTargetKrw, 300000);

  const s420 = selectTieredEqualChampions(mockChamps, 420000);
  assert.equal(s420.targetCount, 2, "E_total=42만원(90%=37.8만원) -> 총 평가자산 기준 2봇 선출");
  assert.equal(s420.globalCapKrw, 378000);
  assert.equal(s420.perBotTargetKrw, 189000);
  assert.equal(s420.elected[0].target_capital_krw + s420.elected[1].target_capital_krw, 378000);
  assert.notEqual(s420.elected[0].strategy_group, s420.elected[1].strategy_group, "동일 전략군 중복 금지");

  const s750 = selectTieredEqualChampions(mockChamps, 750000);
  assert.equal(s750.targetCount, 3, "E_total=75만원(90%=67.5만원) -> 총 평가자산 기준 3봇 선출");
  assert.equal(s750.globalCapKrw, 675000);
  assert.equal(s750.perBotTargetKrw, 225000);
  assert.equal(s750.elected.reduce((a, b) => a + b.target_capital_krw, 0), 675000);
  recordPass("Test 2", "단일 90% 상한(81% 이중차감 없음) & 42만/75만/100만 검증", 0, 900000, 900000, 1000000);

  // =========================================================================
  // [Test 3] 기존 90% 자동 원금 동기화 호출 시 탈락 봇 차감액 덮어쓰기 방지 (방식 A 핵심)
  // =========================================================================
  await resetTestDb(db, 1000000);
  await seedCompletedPaperTrade(db, "bot_02", 10, 1);
  await seedCompletedPaperTrade(db, "bot_02", 10, 2);
  await seedCompletedPaperTrade(db, "bot_01", 8, 1);
  await seedCompletedPaperTrade(db, "bot_01", 8, 2);
  await seedCompletedPaperTrade(db, "bot_05", 7, 1);
  await seedCompletedPaperTrade(db, "bot_05", 7, 2);
  await executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", forcedCapital: 1000000, skipLiveAccountSync: true });

  await seedOpenLivePosition(db, { botId: "bot_02", market: "KRW-ETH", buyAmount: 150000, avgPrice: 5000000 });
  await db.prepare("UPDATE bots SET virtual_krw = 150000, allocated_capital = 300000 WHERE bot_id = 'bot_02'").run();
  await seedCompletedPaperTrade(db, "bot_08", 25, 1);
  await seedCompletedPaperTrade(db, "bot_08", 25, 2);
  await executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", forcedCapital: 1000000, skipLiveAccountSync: true });

  const before3 = await getLedgerTotals(db, 1000000);
  // 1) 단위 함수 reconcileAutoSyncedBudgetsWith90Cap 직접 검증
  const recUnit = reconcileAutoSyncedBudgetsWith90Cap({
    totalEquityKrw: 1000000,
    allBots: before3.bots.map((b) => ({
      bot_id: b.bot_id,
      strategy_group: b.strategy_group_code || b.strategy_group,
      is_selected_for_live: b.is_selected_for_live,
      open_locked_krw: b.used_capital,
      replaced_by_bot_id: b.replaced_by_bot_id,
    })),
  });
  assert.equal(recUnit.drainingAssignments.find((d) => d.bot_id === "bot_02").virtual_krw, 0);
  assert.equal(recUnit.electedAllocations.find((e) => e.bot_id === "bot_08").virtual_krw, 150000);
  assert.equal(recUnit.totalUsedCapital, 900000);

  // 2) 실제 syncDynamicLiveCapitalFromUpbit(true, mockUpbitAccount) 호출 시에도 덮어쓰기 0건 검증
  const syncRes = await syncDynamicLiveCapitalFromUpbit(true, {
    success: true,
    total_asset_krw: 1000000,
    orderable_krw: 850000,
    krw_balance: 850000,
    krw_total: 850000,
  });
  assert.equal(syncRes.success, true);
  assert.equal(syncRes.global_cap_krw, 900000, "90% 단일 적용 (810,000원 아님)");
  const after3 = await getLedgerTotals(db, 1000000);
  assert.equal(Number(after3.bots.find((b) => b.bot_id === "bot_02").virtual_krw), 0, "Draining bot_02 virtual_krw=0 유지");
  assert.equal(Number(after3.bots.find((b) => b.bot_id === "bot_08").virtual_krw), 150000, "후임 bot_08 150,000원 차감 보존 (300k 덮어쓰기 금지)");
  assert.equal(after3.totalUsed, 900000, "동기화 후에도 총자금 900,000원(90%) 엄수");
  recordPass("Test 3", "90% 자동 원금 동기화 시 Draining 차감 보존 & 덮어쓰기 방지", before3.totalUsed, after3.totalUsed, after3.cap90, 1000000);

  // =========================================================================
  // [Test 4] 기존 봇 재선출(연임) 무중단 유지
  // =========================================================================
  await resetTestDb(db, 1000000);
  await seedCompletedPaperTrade(db, "bot_02", 15, 1);
  await seedCompletedPaperTrade(db, "bot_02", 12, 2);
  await seedCompletedPaperTrade(db, "bot_01", 10, 1);
  await seedCompletedPaperTrade(db, "bot_01", 9, 2);
  await seedCompletedPaperTrade(db, "bot_05", 8, 1);
  await seedCompletedPaperTrade(db, "bot_05", 7, 2);
  await executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", forcedCapital: 1000000, skipLiveAccountSync: true });
  await seedOpenLivePosition(db, { botId: "bot_02", market: "KRW-BTC", buyAmount: 100000 });
  await db.prepare("UPDATE bots SET virtual_krw = 200000, allocated_capital = 300000 WHERE bot_id = 'bot_02'").run();
  const before4 = await getLedgerTotals(db, 1000000);

  await executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", forcedCapital: 1000000, skipLiveAccountSync: true });
  const after4 = await getLedgerTotals(db, 1000000);
  const bot02After4 = after4.bots.find((b) => b.bot_id === "bot_02");
  assert.equal(Number(bot02After4.is_selected_for_live), 1);
  assert.equal(bot02After4.drain_status, "NONE");
  assert.equal(bot02After4.open_positions.length, 1);
  assert.equal(Number(bot02After4.virtual_krw), 200000);
  recordPass("Test 4", "기존 봇 재선출(연임) 무중단 유지", before4.totalUsed, after4.totalUsed, after4.cap90, 1000000);

  // =========================================================================
  // [Test 5] 1:1 교체 시 탈락 봇 매도 유지, 신규 매수 차단, 후임 봇 자금 차감
  // =========================================================================
  await resetTestDb(db, 1000000);
  await seedCompletedPaperTrade(db, "bot_02", 10, 1);
  await seedCompletedPaperTrade(db, "bot_02", 10, 2);
  await seedCompletedPaperTrade(db, "bot_01", 8, 1);
  await seedCompletedPaperTrade(db, "bot_01", 8, 2);
  await seedCompletedPaperTrade(db, "bot_05", 7, 1);
  await seedCompletedPaperTrade(db, "bot_05", 7, 2);
  await executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", forcedCapital: 1000000, skipLiveAccountSync: true });

  const posBot02 = await seedOpenLivePosition(db, { botId: "bot_02", market: "KRW-ETH", buyAmount: 150000, avgPrice: 5000000 });
  await db.prepare("UPDATE bots SET virtual_krw = 150000, allocated_capital = 300000 WHERE bot_id = 'bot_02'").run();
  await seedCompletedPaperTrade(db, "bot_08", 25, 1);
  await seedCompletedPaperTrade(db, "bot_08", 25, 2);
  const before5 = await getLedgerTotals(db, 1000000);

  await executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", forcedCapital: 1000000, skipLiveAccountSync: true });
  const after5 = await getLedgerTotals(db, 1000000);
  const bot02After5 = after5.bots.find((b) => b.bot_id === "bot_02");
  const bot08After5 = after5.bots.find((b) => b.bot_id === "bot_08");

  assert.equal(Number(bot02After5.is_selected_for_live), 0);
  assert.equal(Number(bot02After5.virtual_krw), 0);
  assert.equal(bot02After5.drain_status, "DRAINING");
  assert.equal(bot02After5.replaced_by_bot_id, "bot_08");
  assert.equal(Number(bot08After5.virtual_krw), 150000);
  assert.equal(after5.totalUsed, 900000);
  const blockedBuy = await executeBotBuyOrder(bot02After5, "KRW-BTC", 50000, 100000000, "test-blocked", { skipUpbitApi: true });
  assert.equal(blockedBuy, false, "Draining 봇 신규 매수 차단");
  recordPass("Test 5", "1:1 교체 시 탈락 봇 Drain 유지 & 후임 봇 차감", before5.totalUsed, after5.totalUsed, after5.cap90, 1000000);

  // =========================================================================
  // [Test 6] 탈락 봇 익절 매도(+10%, 165,000원 순회수) 시 자금 복원 & 초과분 예비비 유보
  // =========================================================================
  const before6 = await getLedgerTotals(db, 1000000);
  const sellOk6 = await executeBotSellOrder(bot02After5, posBot02, 5502755, "익절 테스트(+10%)", { skipUpbitApi: true });
  assert.equal(sellOk6, true);
  const after6 = await getLedgerTotals(db, 1000000);
  assert.equal(after6.bots.find((b) => b.bot_id === "bot_02").drain_status, "COMPLETED");
  assert.equal(Number(after6.bots.find((b) => b.bot_id === "bot_08").virtual_krw), 300000);
  assert.equal(after6.totalUsed, 900000);
  const restLog6 = await db.prepare("SELECT * FROM capital_restoration_logs ORDER BY id DESC LIMIT 1").get();
  assert.equal(Math.floor(Number(restLog6.restored_krw)), 150000);
  assert.ok(Number(restLog6.surplus_reserve_krw) >= 14900);
  assert.equal(Math.floor(Number(restLog6.total_equity_snapshot_krw)), 1000000);
  recordPass("Test 6", "탈락 봇 익절 매도 시 자금 복원 & 초과분 예비비 유보", before6.totalUsed, after6.totalUsed, after6.cap90, 1000000);

  // =========================================================================
  // [Test 7] 탈락 봇 손절 매도(-10%, 135,000원 순회수) 시 실회수액 한도 복원 (유령 자금 방지)
  // =========================================================================
  await resetTestDb(db, 1000000);
  await seedCompletedPaperTrade(db, "bot_02", 10, 1);
  await seedCompletedPaperTrade(db, "bot_02", 10, 2);
  await seedCompletedPaperTrade(db, "bot_01", 8, 1);
  await seedCompletedPaperTrade(db, "bot_01", 8, 2);
  await seedCompletedPaperTrade(db, "bot_05", 7, 1);
  await seedCompletedPaperTrade(db, "bot_05", 7, 2);
  await executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", forcedCapital: 1000000, skipLiveAccountSync: true });

  const posLoss = await seedOpenLivePosition(db, { botId: "bot_02", market: "KRW-XRP", buyAmount: 150000, avgPrice: 1000 });
  await db.prepare("UPDATE bots SET virtual_krw = 150000, allocated_capital = 300000 WHERE bot_id = 'bot_02'").run();
  await seedCompletedPaperTrade(db, "bot_08", 25, 1);
  await seedCompletedPaperTrade(db, "bot_08", 25, 2);
  await executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", forcedCapital: 1000000, skipLiveAccountSync: true });

  const before7 = await getLedgerTotals(db, 1000000);
  const sellOk7 = await executeBotSellOrder(before7.bots.find((b) => b.bot_id === "bot_02"), posLoss, 900.45, "손절 테스트(-10%)", { skipUpbitApi: true });
  assert.equal(sellOk7, true);
  const after7 = await getLedgerTotals(db, 1000000);
  const bot08After7 = after7.bots.find((b) => b.bot_id === "bot_08");
  assert.ok(Number(bot08After7.virtual_krw) <= 285010 && Number(bot08After7.virtual_krw) >= 284900);
  assert.ok(after7.totalUsed < after7.cap90);
  recordPass("Test 7", "탈락 봇 손절 매도 시 실회수액 한도 복원 (유령 자금 방지)", before7.totalUsed, after7.totalUsed, after7.cap90, 1000000);

  // =========================================================================
  // [Test 8] 자산 증액(1→2봇) + 기존 봇 Over-Locked(350k) 시 90% 글로벌 캡 방어 및 청산 복원
  // =========================================================================
  await resetTestDb(db, 400000);
  await seedCompletedPaperTrade(db, "bot_01", 20, 1);
  await seedCompletedPaperTrade(db, "bot_01", 20, 2);
  await executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", forcedCapital: 400000, skipLiveAccountSync: true });
  const posOver = await seedOpenLivePosition(db, { botId: "bot_01", market: "KRW-BTC", buyAmount: 350000, avgPrice: 100000000 });
  await db.prepare("UPDATE bots SET virtual_krw = 10000, allocated_capital = 360000 WHERE bot_id = 'bot_01'").run();

  await seedCompletedPaperTrade(db, "bot_02", 35, 1);
  await seedCompletedPaperTrade(db, "bot_02", 35, 2);
  await seedCompletedPaperTrade(db, "bot_04", 30, 1);
  await seedCompletedPaperTrade(db, "bot_04", 30, 2);
  const before8 = await getLedgerTotals(db, 500000);

  const rot8 = await executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", forcedCapital: 500000, skipLiveAccountSync: true });
  assert.equal(rot8.elected_bots.length, 2);
  const mid8 = await getLedgerTotals(db, 500000);
  assert.ok(
    Number(mid8.bots.find((b) => b.bot_id === "bot_02").virtual_krw) +
      Number(mid8.bots.find((b) => b.bot_id === "bot_04").virtual_krw) <=
      100000
  );
  assert.equal(mid8.totalUsed, 450000);

  const sellOk8 = await executeBotSellOrder(mid8.bots.find((b) => b.bot_id === "bot_01"), posOver, 100050100, "Over-Locked 청산", { skipUpbitApi: true });
  assert.equal(sellOk8, true);
  const after8 = await getLedgerTotals(db, 500000);
  assert.equal(Number(after8.bots.find((b) => b.bot_id === "bot_02").virtual_krw), 225000);
  assert.equal(Number(after8.bots.find((b) => b.bot_id === "bot_04").virtual_krw), 225000);
  assert.equal(after8.totalUsed, 450000);
  recordPass("Test 8", "자산 증액(1→2봇) + Over-Locked 90% 방어 및 청산 복원", before8.totalUsed, after8.totalUsed, after8.cap90, 500000);

  // =========================================================================
  // [Test 9] 업비트 실시간 총 평가자산 조회 실패 시 안전 Fallback 검증
  // =========================================================================
  const fb1 = resolveTotalEquityAndSingle90Cap({
    liveTotalEquityKrw: null,
    cachedTotalEquityKrw: 800000,
    legacyAuto90PrincipalKrw: null,
  });
  assert.equal(fb1.source, "CACHED_EQUITY_FALLBACK");
  assert.equal(fb1.totalEquityKrw, 800000);
  assert.equal(fb1.globalCapKrw, 720000);
  assert.equal(getTargetBotCountByTotalEquity(fb1.totalEquityKrw), 3, "API 장애 시 0봇 오판 금지 -> 캐시 80만원 기준 3봇 유지");

  const fb2 = resolveTotalEquityAndSingle90Cap({
    liveTotalEquityKrw: null,
    cachedTotalEquityKrw: null,
    legacyAuto90PrincipalKrw: 900000,
  });
  assert.equal(fb2.source, "LEGACY_PRINCIPAL_INFERRED");
  assert.equal(fb2.totalEquityKrw, 1000000, "레거시 90% 원금 900,000원 -> 총자산 1,000,000원 역산");
  assert.equal(fb2.globalCapKrw, 900000, "이중 90% 차감(810,000원) 없음");
  recordPass("Test 9", "실시간 총 평가자산 조회 실패 시 안전 Fallback 검증", 0, fb1.globalCapKrw, fb1.globalCapKrw, fb1.totalEquityKrw);

  // =========================================================================
  // [Test 10] 최소 주문금액(5,050원) 미달 시 WAITING_CAPITAL_RESTORE 전환 및 복원 후 해제
  // =========================================================================
  const calcWait = computeRotationAllocationsWith90Cap({
    totalEquityKrw: 400000,
    allBots: [
      { bot_id: "bot_01", strategy_group: "VOLATILITY_BREAKOUT", is_selected_for_live: 1, open_locked_krw: 358000 },
      { bot_id: "bot_02", strategy_group: "TREND_SWING", is_selected_for_live: 0, open_locked_krw: 0 },
    ],
    electedBots: [{ bot_id: "bot_02", strategy_group: "TREND_SWING", allocation_ratio: 1 }],
  });
  assert.equal(calcWait.electedAllocations[0].virtual_krw, 2000);
  assert.equal(calcWait.electedAllocations[0].funding_status, "WAITING_CAPITAL_RESTORE");

  const restWait = computeDrainSellCapitalRestoration({
    totalEquityKrw: 400000,
    drainingBot: { bot_id: "bot_01", replaced_by_bot_id: "bot_02" },
    settledNetKrw: 358000,
    remainingDrainingLockedAll: 0,
    electedBotsNow: [{ bot_id: "bot_02", target_capital_krw: 360000, open_locked_krw: 0, virtual_krw: 2000 }],
  });
  const afterWaitVirtual = 2000 + restWait.totalRestoredKrw;
  assert.equal(afterWaitVirtual, 360000);
  assert.ok(afterWaitVirtual >= 5050);
  recordPass("Test 10", "최소주문(5,050원) 미달 WAITING_CAPITAL_RESTORE & 복원 해제", 360000, afterWaitVirtual, 360000, 400000);

  // =========================================================================
  // [Test 11] 동시 실행 Race Condition 방어 (로테이션 + 90% 자동 동기화 + Draining 매도 복원)
  // =========================================================================
  await resetTestDb(db, 1000000);
  await seedCompletedPaperTrade(db, "bot_02", 10, 1);
  await seedCompletedPaperTrade(db, "bot_02", 10, 2);
  await seedCompletedPaperTrade(db, "bot_01", 8, 1);
  await seedCompletedPaperTrade(db, "bot_01", 8, 2);
  await seedCompletedPaperTrade(db, "bot_05", 7, 1);
  await seedCompletedPaperTrade(db, "bot_05", 7, 2);
  await executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", forcedCapital: 1000000, skipLiveAccountSync: true });

  const posRace = await seedOpenLivePosition(db, { botId: "bot_02", market: "KRW-SOL", buyAmount: 150000, avgPrice: 200000 });
  await db.prepare("UPDATE bots SET virtual_krw = 150000, allocated_capital = 300000 WHERE bot_id = 'bot_02'").run();
  await seedCompletedPaperTrade(db, "bot_08", 25, 1);
  await seedCompletedPaperTrade(db, "bot_08", 25, 2);
  await executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", forcedCapital: 1000000, skipLiveAccountSync: true });

  const before11 = await getLedgerTotals(db, 1000000);
  const bot02Race = before11.bots.find((b) => b.bot_id === "bot_02");

  const [r1, r2, syncConcurrent, s1] = await Promise.all([
    executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", forcedCapital: 1000000, skipLiveAccountSync: true }),
    executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", forcedCapital: 1000000, skipLiveAccountSync: true }),
    syncDynamicLiveCapitalFromUpbit(true, {
      success: true,
      total_asset_krw: 1000000,
      orderable_krw: 850000,
      krw_balance: 850000,
      krw_total: 850000,
    }),
    executeBotSellOrder(bot02Race, posRace, 200100, "동시성 테스트 청산", { skipUpbitApi: true }),
  ]);

  assert.ok(r1.already_running || r2.already_running || (r1.success && r2.success), "동시 로테이션 Mutex 직렬화");
  assert.equal(syncConcurrent.success, true, "동시 90% 자동 동기화 안전 완료/스킵");
  assert.equal(s1, true, "Draining 매도 정상 완료");

  const after11 = await getLedgerTotals(db, 1000000);
  assertGlobal90CapInvariant({ totalEquityKrw: 1000000, totalUsedCapital: after11.totalUsed, maxDeployRatio: 0.9 });
  assert.ok(after11.totalUsed <= after11.cap90, "동시 실행 후 90% 상한 초과 0건");
  const restLogs11 = await db.prepare("SELECT * FROM capital_restoration_logs").all();
  assert.equal(restLogs11.length, 1, "중복 복원 0건 (정확히 1회 정산 기록)");

  const rotStatusFinal = await getRotationStatusPayload({ skipMarketFetch: true });
  assert.equal(rotStatusFinal.total_equity_krw, 1000000);
  assert.equal(rotStatusFinal.global_cap_krw, 900000);
  assert.ok(rotStatusFinal.utilization_pct_of_equity <= 90.0);

  recordPass("Test 11", "동시 실행 Race Condition 방어(로테이션+90%동기화+매도복원)", before11.totalUsed, after11.totalUsed, after11.cap90, 1000000);

  console.log("\n================ 11대 시나리오 테스트 통과 요약 ================");
  console.table(reportRows);
  console.log("ALL 11 EQUITY-TIERED ROTATION & SINGLE 90% CAP TESTS PASSED!");
} finally {
  cleanupTestDbFiles();
}
