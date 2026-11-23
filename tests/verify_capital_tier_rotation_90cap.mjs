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
  getTargetBotCountByPrincipal,
  selectTieredEqualChampions,
  computeRotationAllocationsWith90Cap,
  computeDrainSellCapitalRestoration,
  assertGlobal90CapInvariant,
} = await import("../backend/common/algo_lab_service.mjs");

const {
  getDb,
  initializeDatabase,
  getBots,
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

async function resetTestDb(db, principalKrw = 1000000) {
  const now = formatKstDateTime(0, 0);
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
        allocation_mode = 'EQUAL_BY_CAPITAL_TIER',
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
    .prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('total_capital', ?, ?)")
    .run(String(principalKrw), now);
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

async function getLedgerTotals(db, principalKrw) {
  const bots = await getBots("live");
  const totalDrainingLocked = bots
    .filter((b) => Number(b.is_selected_for_live) !== 1)
    .reduce((acc, b) => acc + Math.max(0, Math.floor(Number(b.used_capital || 0))), 0);
  const totalElectedLocked = bots
    .filter((b) => Number(b.is_selected_for_live) === 1)
    .reduce((acc, b) => acc + Math.max(0, Math.floor(Number(b.used_capital || 0))), 0);
  const totalCash = bots.reduce((acc, b) => acc + Math.max(0, Math.floor(Number(b.virtual_krw || 0))), 0);
  const totalUsed = totalDrainingLocked + totalElectedLocked + totalCash;
  const cap90 = Math.floor(principalKrw * 0.9);
  const utilPct = principalKrw > 0 ? Number(((totalUsed / principalKrw) * 100).toFixed(2)) : 0;
  return { bots, totalDrainingLocked, totalElectedLocked, totalCash, totalUsed, cap90, utilPct };
}

const reportRows = [];

function recordPass(id, name, beforeSum, afterSum, cap90, principal) {
  const ratioPct = principal > 0 ? Number(((afterSum / principal) * 100).toFixed(2)) : 0;
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
  // [Test 1] 원금 구간별 봇 개수 및 경계값 정확성
  // =========================================================================
  assert.equal(getTargetBotCountByPrincipal(9999), 0, "1만원 미만 -> 0개");
  assert.equal(getTargetBotCountByPrincipal(300000), 1, "30만원 -> 1개");
  assert.equal(getTargetBotCountByPrincipal(400000), 1, "40만원 -> 1개");
  assert.equal(getTargetBotCountByPrincipal(400001), 2, "40만 1원 -> 2개");
  assert.equal(getTargetBotCountByPrincipal(699999), 2, "699,999원 -> 2개");
  assert.equal(getTargetBotCountByPrincipal(700000), 3, "정확히 70만원 -> 3개");
  assert.equal(getTargetBotCountByPrincipal(1000000), 3, "100만원 -> 3개");
  recordPass("Test 1", "원금 구간별 봇 개수 및 경계값(40만/70만)", 0, 900000, 900000, 1000000);

  // =========================================================================
  // [Test 2] 동일 비율 배분 및 90% 상한 검증 (40만/50만/100만)
  // =========================================================================
  const mockChamps = [
    { bot_id: "bot_02", strategy_group: "TREND_SWING", rotation_score: 12.5 },
    { bot_id: "bot_01", strategy_group: "VOLATILITY_BREAKOUT", rotation_score: 10.2 },
    { bot_id: "bot_05", strategy_group: "REVERSAL_GRID", rotation_score: 8.7 },
  ];
  const s400 = selectTieredEqualChampions(mockChamps, 400000);
  assert.equal(s400.targetCount, 1);
  assert.equal(s400.globalCapKrw, 360000);
  assert.equal(s400.perBotTargetKrw, 360000);
  assert.equal(s400.elected[0].target_capital_krw, 360000);

  const s500 = selectTieredEqualChampions(mockChamps, 500000);
  assert.equal(s500.targetCount, 2);
  assert.equal(s500.globalCapKrw, 450000);
  assert.equal(s500.perBotTargetKrw, 225000);
  assert.equal(s500.elected[0].target_capital_krw + s500.elected[1].target_capital_krw, 450000);
  assert.notEqual(s500.elected[0].strategy_group, s500.elected[1].strategy_group, "동일 전략군 중복 금지");

  const s1000 = selectTieredEqualChampions(mockChamps, 1000000);
  assert.equal(s1000.targetCount, 3);
  assert.equal(s1000.globalCapKrw, 900000);
  assert.equal(s1000.perBotTargetKrw, 300000);
  assert.equal(s1000.elected.reduce((a, b) => a + b.target_capital_krw, 0), 900000);
  recordPass("Test 2", "동일 비율 배분 및 90% 상한(40만/50만/100만)", 0, 900000, 900000, 1000000);

  // =========================================================================
  // [Test 3] 기존 봇 재선출(연임) 무중단 유지
  // =========================================================================
  await resetTestDb(db, 1000000);
  await seedCompletedPaperTrade(db, "bot_02", 15, 1);
  await seedCompletedPaperTrade(db, "bot_02", 12, 2);
  await seedCompletedPaperTrade(db, "bot_01", 10, 1);
  await seedCompletedPaperTrade(db, "bot_01", 9, 2);
  await seedCompletedPaperTrade(db, "bot_05", 8, 1);
  await seedCompletedPaperTrade(db, "bot_05", 7, 2);

  const rot3a = await executeWeeklyBotRotation({
    triggerType: "MANUAL_IMMEDIATE",
    forcedCapital: 1000000,
    skipLiveAccountSync: true,
  });
  assert.equal(rot3a.success, true);
  assert.equal(rot3a.elected_bots.length, 3);

  // 연임 대상 bot_02에 오픈 포지션 100,000원 생성 후 재실행
  await seedOpenLivePosition(db, { botId: "bot_02", market: "KRW-BTC", buyAmount: 100000 });
  await db.prepare("UPDATE bots SET virtual_krw = 200000, allocated_capital = 300000 WHERE bot_id = 'bot_02'").run();
  const before3 = await getLedgerTotals(db, 1000000);

  const rot3b = await executeWeeklyBotRotation({
    triggerType: "MANUAL_IMMEDIATE",
    forcedCapital: 1000000,
    skipLiveAccountSync: true,
  });
  assert.equal(rot3b.success, true);
  const after3 = await getLedgerTotals(db, 1000000);
  const bot02After3 = after3.bots.find((b) => b.bot_id === "bot_02");
  assert.equal(Number(bot02After3.is_selected_for_live), 1, "연임 봇 선택 유지");
  assert.equal(bot02After3.drain_status, "NONE", "연임 봇 Draining 전환 금지");
  assert.equal(bot02After3.open_positions.length, 1, "연임 봇 기존 포지션 유지");
  assert.equal(Number(bot02After3.virtual_krw), 200000, "연임 봇 잔여 가용 200,000원 유지");
  assert.ok(after3.totalUsed <= after3.cap90, "90% 상한 준수");
  recordPass("Test 3", "기존 봇 재선출(연임) 무중단 유지", before3.totalUsed, after3.totalUsed, after3.cap90, 1000000);

  // =========================================================================
  // [Test 4] 1:1 교체 시 탈락 봇 매도 유지, 신규 매수 차단, 후임 봇 자금 차감
  // =========================================================================
  await resetTestDb(db, 1000000);
  // 초기: bot_02(추세), bot_01(돌파), bot_05(역추세) 선출
  await seedCompletedPaperTrade(db, "bot_02", 10, 1);
  await seedCompletedPaperTrade(db, "bot_02", 10, 2);
  await seedCompletedPaperTrade(db, "bot_01", 8, 1);
  await seedCompletedPaperTrade(db, "bot_01", 8, 2);
  await seedCompletedPaperTrade(db, "bot_05", 7, 1);
  await seedCompletedPaperTrade(db, "bot_05", 7, 2);
  await executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", forcedCapital: 1000000, skipLiveAccountSync: true });

  // bot_02가 150,000원 보유 중인 상태에서 bot_08(동일 TREND_SWING)이 1위로 역전
  const posBot02 = await seedOpenLivePosition(db, { botId: "bot_02", market: "KRW-ETH", buyAmount: 150000, avgPrice: 5000000 });
  await db.prepare("UPDATE bots SET virtual_krw = 150000, allocated_capital = 300000 WHERE bot_id = 'bot_02'").run();
  await seedCompletedPaperTrade(db, "bot_08", 25, 1);
  await seedCompletedPaperTrade(db, "bot_08", 25, 2);
  const before4 = await getLedgerTotals(db, 1000000);

  const rot4 = await executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", forcedCapital: 1000000, skipLiveAccountSync: true });
  assert.equal(rot4.success, true);
  const after4 = await getLedgerTotals(db, 1000000);
  const bot02After4 = after4.bots.find((b) => b.bot_id === "bot_02");
  const bot08After4 = after4.bots.find((b) => b.bot_id === "bot_08");

  assert.equal(Number(bot02After4.is_selected_for_live), 0, "탈락 봇 is_selected_for_live=0");
  assert.equal(Number(bot02After4.virtual_krw), 0, "탈락 봇 virtual_krw=0 (신규 매수 차단)");
  assert.equal(bot02After4.drain_status, "DRAINING", "탈락 봇 drain_status=DRAINING");
  assert.equal(bot02After4.replaced_by_bot_id, "bot_08", "동일 전략군 후임 bot_08 1:1 연결");
  assert.equal(Number(bot08After4.virtual_krw), 150000, "후임 bot_08 가용 예산 300,000 - 150,000 = 150,000원");
  assert.equal(after4.totalUsed, 900000, "전체 합계 150k + 150k + 300k + 300k = 900,000원");
  assert.ok(after4.totalUsed <= after4.cap90);

  // 탈락 봇 신규 매수 시도 시 차단 검증
  const blockedBuy = await executeBotBuyOrder(bot02After4, "KRW-BTC", 50000, 100000000, "test-blocked", { skipUpbitApi: true });
  assert.equal(blockedBuy, false, "Draining 봇 신규 매수 100% 차단");
  recordPass("Test 4", "1:1 교체 시 탈락 봇 Drain 유지 & 후임 봇 차감", before4.totalUsed, after4.totalUsed, after4.cap90, 1000000);

  // =========================================================================
  // [Test 5] 탈락 봇 익절 매도(+10%, 165,000원 순회수) 시 자금 복원 & 초과분 예비비 유보
  // =========================================================================
  const before5 = await getLedgerTotals(db, 1000000);
  // +10% 익절 가격: 5,500,000원 (수수료 0.05% 고려해 순회수 ~165,000원되도록 매도가 설정)
  const sellOk5 = await executeBotSellOrder(bot02After4, posBot02, 5502755, "익절 테스트(+10%)", { skipUpbitApi: true });
  assert.equal(sellOk5, true, "Draining 봇 매도 체결 성공");

  const after5 = await getLedgerTotals(db, 1000000);
  const bot02After5 = after5.bots.find((b) => b.bot_id === "bot_02");
  const bot08After5 = after5.bots.find((b) => b.bot_id === "bot_08");
  assert.equal(bot02After5.drain_status, "COMPLETED", "포지션 0건 -> drain_status=COMPLETED");
  assert.equal(Number(bot08After5.virtual_krw), 300000, "후임 bot_08에 부족분 150,000원만 정확히 복원 -> 300,000원");
  assert.equal(after5.totalUsed, 900000, "90% 상한(900,000원) 절대 초과 금지");

  const restLog5 = await db.prepare("SELECT * FROM capital_restoration_logs ORDER BY id DESC LIMIT 1").get();
  assert.ok(restLog5, "capital_restoration_logs 기록 확인");
  assert.equal(restLog5.source_bot_id, "bot_02");
  assert.equal(restLog5.target_bot_id, "bot_08");
  assert.equal(Math.floor(Number(restLog5.restored_krw)), 150000, "복원액 150,000원");
  assert.ok(Number(restLog5.surplus_reserve_krw) >= 14900, `초과 수익 예비비 유보 확인 (actual=${restLog5.surplus_reserve_krw})`);
  recordPass("Test 5", "탈락 봇 익절 매도 시 자금 복원 & 초과분 예비비 유보", before5.totalUsed, after5.totalUsed, after5.cap90, 1000000);

  // =========================================================================
  // [Test 6] 탈락 봇 손절 매도(-10%, 135,000원 순회수) 시 실회수액 한도 복원 (유령 자금 방지)
  // =========================================================================
  await resetTestDb(db, 1000000);
  await seedCompletedPaperTrade(db, "bot_02", 10, 1);
  await seedCompletedPaperTrade(db, "bot_02", 10, 2);
  await seedCompletedPaperTrade(db, "bot_01", 8, 1);
  await seedCompletedPaperTrade(db, "bot_01", 8, 2);
  await seedCompletedPaperTrade(db, "bot_05", 7, 1);
  await seedCompletedPaperTrade(db, "bot_05", 7, 2);
  await executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", forcedCapital: 1000000, skipLiveAccountSync: true });

  const posBot02Loss = await seedOpenLivePosition(db, { botId: "bot_02", market: "KRW-XRP", buyAmount: 150000, avgPrice: 1000 });
  await db.prepare("UPDATE bots SET virtual_krw = 150000, allocated_capital = 300000 WHERE bot_id = 'bot_02'").run();
  await seedCompletedPaperTrade(db, "bot_08", 25, 1);
  await seedCompletedPaperTrade(db, "bot_08", 25, 2);
  await executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", forcedCapital: 1000000, skipLiveAccountSync: true });

  const before6 = await getLedgerTotals(db, 1000000);
  const bot02Before6 = before6.bots.find((b) => b.bot_id === "bot_02");
  // -10% 손절: 순회수 ~135,000원 (sellPrice = 900.46 -> sellAmount=135069, fee=67, net=135002)
  const sellOk6 = await executeBotSellOrder(bot02Before6, posBot02Loss, 900.45, "손절 테스트(-10%)", { skipUpbitApi: true });
  assert.equal(sellOk6, true);

  const after6 = await getLedgerTotals(db, 1000000);
  const bot08After6 = after6.bots.find((b) => b.bot_id === "bot_08");
  // 기존 150,000 + 실회수 135,000 = 285,000 (150,000 전액 복원하여 300,000이 되면 유령 자금 위반!)
  assert.ok(Number(bot08After6.virtual_krw) <= 285010 && Number(bot08After6.virtual_krw) >= 284900, `손절 실회수액 한도 복원 확인 (actual=${bot08After6.virtual_krw})`);
  assert.ok(after6.totalUsed < after6.cap90, "손실분만큼 전체 사용 자금 축소 (유령 자금 0원)");
  recordPass("Test 6", "탈락 봇 손절 매도 시 실회수액 한도 복원 (유령 자금 방지)", before6.totalUsed, after6.totalUsed, after6.cap90, 1000000);

  // =========================================================================
  // [Test 7] 원금 증액으로 봇 수 증가(1->2) + 기존 봇 Over-Locked(350k) 시 90% 글로벌 캡 방어
  // =========================================================================
  await resetTestDb(db, 400000);
  // 1주차: 원금 40만원 -> 1봇(bot_01) 선출, 350,000원 포지션 보유
  await seedCompletedPaperTrade(db, "bot_01", 20, 1);
  await seedCompletedPaperTrade(db, "bot_01", 20, 2);
  await executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", forcedCapital: 400000, skipLiveAccountSync: true });
  const posBot01Over = await seedOpenLivePosition(db, { botId: "bot_01", market: "KRW-BTC", buyAmount: 350000, avgPrice: 100000000 });
  await db.prepare("UPDATE bots SET virtual_krw = 10000, allocated_capital = 360000 WHERE bot_id = 'bot_01'").run();

  // 2주차: 원금 50만원 증액(90% 상한 450,000원, 2봇 각 225,000원) + bot_02(추세) & bot_04(돌파) 역전 선출
  await seedCompletedPaperTrade(db, "bot_02", 35, 1);
  await seedCompletedPaperTrade(db, "bot_02", 35, 2);
  await seedCompletedPaperTrade(db, "bot_04", 30, 1);
  await seedCompletedPaperTrade(db, "bot_04", 30, 2);
  const before7 = await getLedgerTotals(db, 500000);

  const rot7 = await executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", forcedCapital: 500000, skipLiveAccountSync: true });
  assert.equal(rot7.success, true);
  assert.equal(rot7.elected_bots.length, 2, "50만원 구간 -> 2개 봇 선출");

  const mid7 = await getLedgerTotals(db, 500000);
  const bot02Mid7 = mid7.bots.find((b) => b.bot_id === "bot_02");
  const bot04Mid7 = mid7.bots.find((b) => b.bot_id === "bot_04");
  const bot01Mid7 = mid7.bots.find((b) => b.bot_id === "bot_01");
  assert.equal(Number(bot01Mid7.is_selected_for_live), 0);
  assert.equal(Number(bot01Mid7.used_capital), 350000);
  assert.ok(Number(bot02Mid7.virtual_krw) + Number(bot04Mid7.virtual_krw) <= 100000, "신규 2봇 가용 원화 합계 <= 100,000원");
  assert.equal(mid7.totalUsed, 450000, "350,000 + 100,000 = 450,000원 (90% 불변식 엄수)");

  // bot_01 매도 체결(원금 350,000원 회수) 시 두 봇이 각 225,000원 한도까지 복원
  const sellOk7 = await executeBotSellOrder(bot01Mid7, posBot01Over, 100050100, "Over-Locked 청산", { skipUpbitApi: true });
  assert.equal(sellOk7, true);
  const after7 = await getLedgerTotals(db, 500000);
  const bot02After7 = after7.bots.find((b) => b.bot_id === "bot_02");
  const bot04After7 = after7.bots.find((b) => b.bot_id === "bot_04");
  assert.equal(Number(bot02After7.virtual_krw), 225000, "bot_02 목표 한도 225,000원 완전 복원");
  assert.equal(Number(bot04After7.virtual_krw), 225000, "bot_04 목표 한도 225,000원 완전 복원");
  assert.equal(after7.totalUsed, 450000, "복원 후에도 90% 상한 450,000원 엄수");
  recordPass("Test 7", "원금 증액(1→2봇) + Over-Locked 90% 방어 및 청산 복원", before7.totalUsed, after7.totalUsed, after7.cap90, 500000);

  // =========================================================================
  // [Test 8] 최소 주문금액(5,050원) 미달 시 WAITING_CAPITAL_RESTORE 전환 및 복원 후 해제
  // =========================================================================
  const status8Before = await getRotationStatusPayload({ skipMarketFetch: true });
  assert.equal(status8Before.success, true);

  // 40만원 구간에서 bot_01이 358,000원 보유 중 탈락 -> bot_02 교체 시 가용 2,000원 (< 5,050원)
  const calcWait = computeRotationAllocationsWith90Cap({
    principalKrw: 400000,
    allBots: [
      { bot_id: "bot_01", strategy_group: "VOLATILITY_BREAKOUT", is_selected_for_live: 1, open_locked_krw: 358000 },
      { bot_id: "bot_02", strategy_group: "TREND_SWING", is_selected_for_live: 0, open_locked_krw: 0 },
    ],
    electedBots: [{ bot_id: "bot_02", strategy_group: "TREND_SWING", allocation_ratio: 1 }],
  });
  assert.equal(calcWait.electedAllocations[0].virtual_krw, 2000);
  assert.equal(calcWait.electedAllocations[0].funding_status, "WAITING_CAPITAL_RESTORE", "5,050원 미만 -> WAITING_CAPITAL_RESTORE");

  // 복원 후 (>= 5,050원) READY 전환 확인
  const restWait = computeDrainSellCapitalRestoration({
    principalKrw: 400000,
    drainingBot: { bot_id: "bot_01", replaced_by_bot_id: "bot_02" },
    settledNetKrw: 358000,
    remainingDrainingLockedAll: 0,
    electedBotsNow: [{ bot_id: "bot_02", target_capital_krw: 360000, open_locked_krw: 0, virtual_krw: 2000 }],
  });
  assert.equal(restWait.totalRestoredKrw, 358000);
  const newVirtualAfterWait = 2000 + restWait.totalRestoredKrw;
  assert.equal(newVirtualAfterWait, 360000);
  assert.ok(newVirtualAfterWait >= 5050, "복원 후 5,050원 이상 -> READY 해제");
  recordPass("Test 8", "최소주문(5,050원) 미달 WAITING_CAPITAL_RESTORE & 복원 해제", 360000, newVirtualAfterWait, 360000, 400000);

  // =========================================================================
  // [Test 9] 동시 실행 Race Condition 방어 (로테이션 + Draining 매도 복원 동시 호출)
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

  const before9 = await getLedgerTotals(db, 1000000);
  const bot02Race = before9.bots.find((b) => b.bot_id === "bot_02");

  // 로테이션 2회 + Draining 매도 복원 동시 호출
  const [r1, r2, s1] = await Promise.all([
    executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", forcedCapital: 1000000, skipLiveAccountSync: true }),
    executeWeeklyBotRotation({ triggerType: "MANUAL_IMMEDIATE", forcedCapital: 1000000, skipLiveAccountSync: true }),
    executeBotSellOrder(bot02Race, posRace, 200100, "동시성 테스트 청산", { skipUpbitApi: true }),
  ]);

  // 동시 로테이션 중 하나는 Mutex(already_running)로 직렬 차단되어야 함
  assert.ok(r1.already_running || r2.already_running || (r1.success && r2.success), "동시성 안전 실행");
  assert.equal(s1, true, "Draining 매도 정상 완료");

  const after9 = await getLedgerTotals(db, 1000000);
  assertGlobal90CapInvariant({ principalKrw: 1000000, totalUsedCapital: after9.totalUsed, maxDeployRatio: 0.9 });
  assert.ok(after9.totalUsed <= after9.cap90, "동시 실행 후에도 90% 상한 초과 0건");
  const restLogs9 = await db.prepare("SELECT * FROM capital_restoration_logs").all();
  assert.equal(restLogs9.length, 1, "중복 복원 0건 (정확히 1회 정산 기록)");
  recordPass("Test 9", "동시 실행 Race Condition 방어 (중복 복원 0건)", before9.totalUsed, after9.totalUsed, after9.cap90, 1000000);

  console.log("\n================ 9대 시나리오 테스트 통과 요약 ================");
  console.table(reportRows);
  console.log("ALL 9 CAPITAL-TIER ROTATION & 90% CAP TESTS PASSED!");
} finally {
  cleanupTestDbFiles();
}
