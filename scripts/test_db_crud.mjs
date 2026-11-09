import { pgDb } from "../backend/common/pg_db.mjs";

async function runCrudTest() {
  console.log("==================================================");
  console.log("[Node.js pgDb] PostgreSQL 접속 및 CRUD 테스트 시작");
  console.log("==================================================");

  let passedAll = true;

  try {
    // 1. Connection Check
    console.log("\n[1/5] DB 연결 헬스체크");
    const ping = await pgDb.prepare("SELECT 1 AS ok, current_database() AS db, current_user AS usr, version()").get();
    console.log(`  -> 연결 성공! DB: ${ping.db}, User: ${ping.usr}`);
    console.log(`  -> PostgreSQL 버젼: ${ping.version.split(" on ")[0]}`);

    // 2. system_settings 테이블 CRUD
    console.log("\n[2/5] system_settings 테이블 CRUD 테스트");
    const testKey = "test_crud_key_" + Date.now();
    const testVal1 = "initial_value";
    const testVal2 = "updated_value";
    const now = new Date().toISOString();

    // Create
    const insSettings = await pgDb.prepare(
      "INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)"
    ).run(testKey, testVal1, now);
    console.log(`  -> [C] CREATE 성공 (changes: ${insSettings.changes})`);

    // Read
    const readSettings1 = await pgDb.prepare("SELECT * FROM system_settings WHERE key = ?").get(testKey);
    console.log(`  -> [R] READ 검증: key=${readSettings1.key}, value=${readSettings1.value} (일치: ${readSettings1.value === testVal1})`);

    // Update
    const updSettings = await pgDb.prepare(
      "UPDATE system_settings SET value = ? WHERE key = ?"
    ).run(testVal2, testKey);
    console.log(`  -> [U] UPDATE 성공 (changes: ${updSettings.changes})`);
    const readSettings2 = await pgDb.prepare("SELECT * FROM system_settings WHERE key = ?").get(testKey);
    console.log(`  -> [R] UPDATE 후 READ 검증: value=${readSettings2.value} (일치: ${readSettings2.value === testVal2})`);

    // Delete
    const delSettings = await pgDb.prepare("DELETE FROM system_settings WHERE key = ?").run(testKey);
    console.log(`  -> [D] DELETE 성공 (changes: ${delSettings.changes})`);
    const readSettings3 = await pgDb.prepare("SELECT * FROM system_settings WHERE key = ?").get(testKey);
    console.log(`  -> [R] DELETE 후 확인: null 여부=${readSettings3 === null}`);

    // 3. 가상거래 원장(paper_trades) CRUD & 자동 시퀀스(lastInsertRowid) 테스트
    console.log("\n[3/5] 가상거래 원장(paper_trades) CRUD & 자동 시퀀스 테스트");
    const testUuid = `paper-test-${Date.now()}`;
    const insTrade = await pgDb.prepare(`
      INSERT INTO paper_trades (
        bot_id, market, buy_order_uuid, buy_price, buy_volume, buy_amount, buy_date, status, buy_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'HOLDING', ?)
    `).run("bot_01", "KRW-BTC", testUuid, 105000000, "0.001", 105000, now, "CRUD 테스트 진입");

    const newTradeId = insTrade.lastInsertRowid;
    console.log(`  -> [C] CREATE 성공: 생성된 ID=${newTradeId}, changes=${insTrade.changes}`);

    // Read
    const readTrade1 = await pgDb.prepare("SELECT * FROM paper_trades WHERE id = ?").get(newTradeId);
    console.log(`  -> [R] READ 검증: bot_id=${readTrade1.bot_id}, market=${readTrade1.market}, buy_price=${readTrade1.buy_price}, status=${readTrade1.status}`);

    // Update (가상 매도 정산)
    const sellUuid = `paper-ask-test-${Date.now()}`;
    const updTrade = await pgDb.prepare(`
      UPDATE paper_trades
      SET sell_order_uuid = ?, sell_price = ?, sell_volume = ?, sell_amount = ?, sell_date = ?,
          profit_krw = ?, profit_pct = ?, status = 'COMPLETED', sell_reason = ?
      WHERE id = ?
    `).run(sellUuid, 106000000, "0.001", 106000, now, 1000, 0.95, "CRUD 익절 테스트", newTradeId);
    console.log(`  -> [U] UPDATE 성공 (changes: ${updTrade.changes})`);

    const readTrade2 = await pgDb.prepare("SELECT * FROM paper_trades WHERE id = ?").get(newTradeId);
    console.log(`  -> [R] UPDATE 후 READ 검증: status=${readTrade2.status}, profit_krw=${readTrade2.profit_krw}, reason=${readTrade2.sell_reason}`);

    // Delete
    const delTrade = await pgDb.prepare("DELETE FROM paper_trades WHERE id = ?").run(newTradeId);
    console.log(`  -> [D] DELETE 성공: 삭제된 행 수=${delTrade.changes}`);

    // 4. 가상거래 보유 포지션(paper_bot_positions) CRUD 테스트
    console.log("\n[4/5] 가상 보유 포지션(paper_bot_positions) CRUD 테스트");
    const posUuid = `paper-pos-test-${Date.now()}`;
    const insPos = await pgDb.prepare(`
      INSERT INTO paper_bot_positions (
        bot_id, market, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
    `).run("bot_01", "KRW-ETH", posUuid, "0.05", 3100000, 155000, 77.5, 999999, now);

    const newPosId = insPos.lastInsertRowid;
    console.log(`  -> [C] CREATE 성공: 생성된 ID=${newPosId}`);

    // Read
    const readPos1 = await pgDb.prepare("SELECT * FROM paper_bot_positions WHERE id = ?").get(newPosId);
    console.log(`  -> [R] READ 검증: market=${readPos1.market}, volume=${readPos1.volume}, status=${readPos1.status}`);

    // Update
    const updPos = await pgDb.prepare("UPDATE paper_bot_positions SET status = 'CLOSED', closed_at = ? WHERE id = ?").run(now, newPosId);
    console.log(`  -> [U] UPDATE 성공: changes=${updPos.changes}`);

    // Delete
    const delPos = await pgDb.prepare("DELETE FROM paper_bot_positions WHERE id = ?").run(newPosId);
    console.log(`  -> [D] DELETE 성공: changes=${delPos.changes}`);

    // 5. 봇 마스터(bots) 상태 및 실시간 집계 쿼리 테스트
    console.log("\n[5/5] bots 마스터 테이블 조회 및 실시간 가상 평가액 계산 쿼리 테스트");
    const botRows = await pgDb.prepare("SELECT bot_id, name, nickname, paper_virtual_krw, paper_status_msg FROM bots ORDER BY bot_id ASC LIMIT 3").all();
    console.log(`  -> [R] 봇 목록(${botRows.length}개):`);
    for (const b of botRows) {
      console.log(`     • [${b.bot_id}] ${b.nickname} | 가상가용금: ${Number(b.paper_virtual_krw).toLocaleString()}원 | 상태: ${b.paper_status_msg}`);
    }

  } catch (err) {
    console.error("[TEST ERROR]", err);
    passedAll = false;
  } finally {
    await pgDb.close();
  }

  console.log("\n==================================================");
  if (passedAll) {
    console.log("[SUCCESS] Node.js pgDb 모든 CRUD 테스트 통과!");
  } else {
    console.log("[FAILED] 테스트 도중 오류가 발생했습니다.");
  }
  console.log("==================================================");
}

runCrudTest().catch(console.error);
