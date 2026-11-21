/**
 * tests/verify_dual_ai_and_live_universe.mjs
 *
 * 실전 매매 차단 버그 회귀 검증 스위트:
 * 1. Dual AI `risk_alert` 모순 정규화: BEAR + REDUCE_SIZE + 역추세 봇 ALLOW + 습관적 risk_alert=true/mult=0 -> HALT 강제 승격 방지 (0.5x + bot_10 ALLOW 보존)
 * 2. 문자열 `"false"` risk_alert 안전 파싱 + 진짜 위기(HIGH_VOLATILITY_SHOCK + risk_alert / HALT_NEW_BUYS / EMERGENCY_CLOSE_ALL)는 기존대로 전면 BLOCK + 0.0x 유지
 * 3. 로컬 Ollama(qwen3-news) 응답 모순 정규화 + 프롬프트 판단 규칙 포함 확인
 * 4. 실전 감시 유니버스(DEFAULT_MONITORED_KRW_MARKETS)에 KRW-ADA, KRW-NEAR 포함 및 bot_10 실전 KRW-NEAR 매수 체결 검증
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autocoin-dualai-univ-"));
const TMP_DB = path.join(TMP_DIR, "dualai_univ_test.db");

process.env.AUTOCOIN_LIBRARY_MODE = "1";
process.env.AUTOCOIN_FORCE_LIVE_MODE = "1";
process.env.DB_MODE = "sqlite";
process.env.PG_SYNC_ENABLED = "false";
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.DB_PATH = TMP_DB;

function startMockOllamaServer(responseObj) {
  let capturedPayload = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.url === "/api/chat") {
        capturedPayload = JSON.parse(body || "{}");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: { content: JSON.stringify(responseObj) } }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "qwen3-news" }] }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        getCapturedPayload: () => capturedPayload,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const report = [];

try {
  const {
    initializeDatabase,
    getDb,
    getBots,
    getSafeOrderKrw,
    extractStructuredRegimeFromLlmText,
    normalizeLlmRegimeDecision,
    normalizeBlacklistTickers,
    buildDualAiMarketPromptContext,
    parseBoolFlag,
    synthesizeDualAiDecision,
    callLocalOllamaCoinNewsAnalyzer,
    generateAiNewsAnalysis,
    updateMarketRegimeFilterFromAnalysis,
    runLiveTradingBotsCycle,
    precheckLiveBuyPaceLimits,
    UpbitWsHub,
    upbitWsHub,
    fetchUpbitTickersMap,
    DEFAULT_MONITORED_KRW_MARKETS,
  } = await import("../backend/node_server.mjs");
  const {
    claimLiveBuyIntentAtomic,
    refundFailedOrCanceledBuyIntentAtomic,
  } = await import("../backend/common/live_order_guardrail.mjs");
  const { evaluateSmartExit } = await import("../backend/common/algo_lab_service.mjs");

  await initializeDatabase();
  const db = getDb();

  // 1. parseBoolFlag checks
  assert.equal(parseBoolFlag("false", true), false, 'String "false" must parse as false');
  assert.equal(parseBoolFlag("0", true), false, 'String "0" must parse as false');
  assert.equal(parseBoolFlag("true", false), true, 'String "true" must parse as true');
  assert.equal(parseBoolFlag(false, true), false);
  report.push({ check: "parseBoolFlag", status: "PASS", detail: 'String "false"/"0" safely parsed as false' });

  // 2. Contradictory Gemini Pro response: BEAR + REDUCE_SIZE + risk_alert=true + mult=0 + bot_05/06/08/10 ALLOW
  const contradictoryLlmReply = `
## 🧠 Pro 심층 진단
BTC 일봉 20MA 하회 BEAR 장세. 역추세·눌림목 봇(05, 06, 08, 10)만 ALLOW하여 방어적 운용 수행.

\`\`\`json
{
  "sentiment_score": -0.45,
  "market_regime": "BEAR",
  "risk_alert": true,
  "recommended_action": "REDUCE_SIZE",
  "position_size_multiplier": 0,
  "bot_overrides": {
    "bot_01": "BLOCK", "bot_02": "BLOCK", "bot_03": "BLOCK", "bot_04": "BLOCK",
    "bot_05": "ALLOW", "bot_06": "ALLOW", "bot_07": "BLOCK", "bot_08": "ALLOW",
    "bot_09": "BLOCK", "bot_10": "ALLOW"
  },
  "blacklist_tickers": [],
  "reason": "약세장 방어 운용: 역추세 봇(05,06,08,10) ALLOW"
}
\`\`\`
`;
  const { structured: parsedPro } = extractStructuredRegimeFromLlmText(contradictoryLlmReply);
  assert.ok(parsedPro, "Structured JSON must be extracted");
  assert.equal(parsedPro.risk_alert, false, "Stray risk_alert=true under BEAR/REDUCE_SIZE + ALLOW bots must normalize to false");
  assert.equal(parsedPro.recommended_action, "REDUCE_SIZE");
  assert.equal(parsedPro.position_size_multiplier, 0.5, "Echoed mult=0 under REDUCE_SIZE + ALLOW bots must recover to 0.5");
  assert.equal(parsedPro.bot_overrides.bot_01, "BLOCK");
  assert.equal(parsedPro.bot_overrides.bot_10, "ALLOW", "bot_10 ALLOW must be preserved");
  report.push({
    check: "ReconcileContradictoryReduceSize",
    status: "PASS",
    detail: `action=${parsedPro.recommended_action}, alert=${parsedPro.risk_alert}, mult=${parsedPro.position_size_multiplier}, bot_10=${parsedPro.bot_overrides.bot_10}`,
  });

  // 3. Genuine Shock & HALT must STILL enforce full BLOCK & 0.0x
  const genuineShock = normalizeLlmRegimeDecision({
    sentiment_score: -0.9,
    market_regime: "HIGH_VOLATILITY_SHOCK",
    risk_alert: true,
    recommended_action: "REDUCE_SIZE",
    position_size_multiplier: 0.5,
    bot_overrides: { bot_10: "ALLOW" },
    reason: "대형 거래소 해킹 쇼크",
  });
  assert.equal(genuineShock.risk_alert, true);
  assert.equal(genuineShock.recommended_action, "HALT_NEW_BUYS");
  assert.equal(genuineShock.position_size_multiplier, 0.0);
  assert.equal(genuineShock.bot_overrides.bot_10, "BLOCK");

  const genuineHalt = normalizeLlmRegimeDecision({
    sentiment_score: -0.8,
    market_regime: "BEAR",
    risk_alert: false,
    recommended_action: "HALT_NEW_BUYS",
    position_size_multiplier: 0.5,
    bot_overrides: { bot_10: "ALLOW" },
    reason: "전면 매수 중단 권고",
  });
  assert.equal(genuineHalt.risk_alert, true);
  assert.equal(genuineHalt.position_size_multiplier, 0.0);
  assert.equal(genuineHalt.bot_overrides.bot_10, "BLOCK");
  report.push({
    check: "PreserveGenuineShockAndHalt",
    status: "PASS",
    detail: "HIGH_VOLATILITY_SHOCK+alert and HALT_NEW_BUYS strictly enforce BLOCK + 0.0x",
  });

  // 4. Local Ollama prompt rules & contradictory response normalization
  const mockOllama = await startMockOllamaServer({
    sentiment_score: -0.55,
    market_regime: "BEAR",
    risk_alert: true,
    recommended_action: "REDUCE_SIZE",
    position_size_multiplier: 0.5,
    bot_overrides: {
      bot_01: "BLOCK", bot_02: "BLOCK", bot_03: "BLOCK", bot_04: "BLOCK",
      bot_05: "ALLOW", bot_06: "ALLOW", bot_07: "BLOCK", bot_08: "ALLOW",
      bot_09: "BLOCK", bot_10: "ALLOW",
    },
    blacklist_tickers: ["DOGE"],
    reason: "약세장 지속, 역추세 봇만 비중 축소 허용",
  });
  try {
    const ollamaRes = await callLocalOllamaCoinNewsAnalyzer(
      [{ title: "ETF 순유출 지속", sentiment: "BEARISH" }],
      { btcPrice: 86500000, btcChangePct: -1.2, btcDaily20Ma: 97900000, btc4h60Ma: 93000000, fngValue: 18, fngClass: "Extreme Fear", openTickers: [] },
      [{ bot_id: "bot_10" }],
      { baseUrl: mockOllama.url, model: "qwen3-news", timeoutMs: 5000 }
    );
    const reqPayload = mockOllama.getCapturedPayload();
    const reqPrompt = reqPayload?.messages?.[1]?.content || "";
    assert.ok(reqPrompt.includes("HIGH_VOLATILITY_SHOCK"), "Ollama prompt must specify HIGH_VOLATILITY_SHOCK condition for risk_alert");
    assert.ok(reqPrompt.includes("risk_alert=false"), "Ollama prompt must explicitly instruct risk_alert=false for normal BEAR/SIDEWAYS");
    assert.ok(!reqPrompt.includes("KRW-티커"), "Ollama schema example must NOT include placeholder KRW-티커");
    assert.ok(!reqPrompt.includes("가동봇=bot_10"), "Ollama prompt must NOT single out live bot_10");
    assert.equal(reqPayload?.keep_alive, "35m", "Ollama payload must include keep_alive: '35m'");
    assert.equal(ollamaRes.risk_alert, false, "Ollama BEAR+REDUCE_SIZE+ALLOW must normalize risk_alert=false");
    assert.equal(ollamaRes.position_size_multiplier, 0.5);
    assert.equal(ollamaRes.bot_overrides.bot_10, "ALLOW");
    assert.deepEqual(ollamaRes.blacklist_tickers, ["KRW-DOGE"]);

    const dualSynth = synthesizeDualAiDecision(ollamaRes, parsedPro);
    assert.equal(dualSynth.recommended_action, "REDUCE_SIZE");
    assert.equal(dualSynth.final_risk_alert, 0);
    assert.equal(dualSynth.final_position_multiplier, 0.5);
    assert.equal(dualSynth.final_bot_overrides.bot_10, "ALLOW");
    assert.equal(dualSynth.final_bot_overrides.bot_01, "BLOCK");

    // 4-B. Flash(qwen3-news) target-blocks bot_10 while Pro allows bot_10 under BEAR/REDUCE_SIZE -> Pro wins!
    const rogueFlashBlock = {
      ...ollamaRes,
      bot_overrides: { ...ollamaRes.bot_overrides, bot_10: "BLOCK" },
    };
    const synthProPriority = synthesizeDualAiDecision(rogueFlashBlock, parsedPro);
    assert.equal(synthProPriority.final_bot_overrides.bot_10, "ALLOW", "Pro strategy-group ALLOW must override Flash target-BLOCK in non-shock REDUCE_SIZE");
    assert.equal(synthProPriority.final_bot_overrides.bot_01, "BLOCK", "Pro BLOCK on breakout bot_01 must still be enforced");

    // 4-C. Flash genuine shock STILL enforces full BLOCK + 0.0x
    const synthFlashShock = synthesizeDualAiDecision(genuineShock, parsedPro);
    assert.equal(synthFlashShock.final_risk_alert, 1);
    assert.equal(synthFlashShock.final_position_multiplier, 0.0);
    assert.equal(synthFlashShock.final_bot_overrides.bot_10, "BLOCK");

    // 4-C2. Pro slot running on gemini-3.5-flash fallback returning HALT_NEW_BUYS while Flash says REDUCE_SIZE -> softened to REDUCE_SIZE(0.5x)
    const flashFallbackProHalt = {
      ...genuineHalt,
      model: "gemini-3.5-flash",
      provider: "gemini",
      market_regime: "HIGH_VOLATILITY_SHOCK",
    };
    const synthProFlashHalt = synthesizeDualAiDecision(ollamaRes, flashFallbackProHalt);
    assert.equal(synthProFlashHalt.final_risk_alert, 0, "Pro running on gemini-3.5-flash fallback must NOT unilaterally HALT when Flash is REDUCE_SIZE");
    assert.equal(synthProFlashHalt.recommended_action, "REDUCE_SIZE");
    assert.equal(synthProFlashHalt.final_position_multiplier, 0.5);
    assert.equal(synthProFlashHalt.final_bot_overrides.bot_10, "ALLOW");

    // 4-C3. Local Ollama(qwen3-news) unilateral HALT on ordinary bearish news while Pro says REDUCE_SIZE -> softened
    const ollamaNoBlackSwanHalt = {
      ...genuineHalt,
      provider: "ollama",
      model: "qwen3-news",
      reason: "비트코인 2년 만에 저점, 패닉폭락 신호",
    };
    const synthOllamaSoftened = synthesizeDualAiDecision(ollamaNoBlackSwanHalt, parsedPro);
    assert.equal(synthOllamaSoftened.final_risk_alert, 0, "Local Ollama unilateral HALT without black-swan keyword must soften to REDUCE_SIZE when Pro is REDUCE_SIZE");
    assert.equal(synthOllamaSoftened.recommended_action, "REDUCE_SIZE");
    assert.equal(synthOllamaSoftened.final_position_multiplier, 0.5);
    assert.equal(synthOllamaSoftened.final_bot_overrides.bot_10, "ALLOW");

    // 4-C4. Local Ollama(qwen3-news) HALT WITH hard black-swan keyword (해킹) -> MUST still HALT!
    const ollamaRealBlackSwanHalt = {
      ...ollamaNoBlackSwanHalt,
      reason: "대형 거래소 해킹 및 출금정지 발생",
    };
    const synthOllamaRealShock = synthesizeDualAiDecision(ollamaRealBlackSwanHalt, parsedPro);
    assert.equal(synthOllamaRealShock.final_risk_alert, 1, "Local Ollama HALT with black-swan keyword must enforce full HALT");
    assert.equal(synthOllamaRealShock.recommended_action, "HALT_NEW_BUYS");
    assert.equal(synthOllamaRealShock.final_position_multiplier, 0.0);
    assert.equal(synthOllamaRealShock.final_bot_overrides.bot_10, "BLOCK");

    // 4-D. Blacklist sanitization drops "KRW-티커" and placeholders
    assert.deepEqual(
      normalizeBlacklistTickers(["KRW-티커", "KRW-TICKER", "KRW-NONE", "doge", "KRW-SOL"]),
      ["KRW-DOGE", "KRW-SOL"],
      "normalizeBlacklistTickers must strip Korean/placeholder tickers and keep valid KRW-* markets"
    );

    // 4-E. Precomputed Ollama result reused in generateAiNewsAnalysis without calling Ollama again
    let reuseOllamaHits = 0;
    const silentOllama = http.createServer((_req, res) => {
      reuseOllamaHits += 1;
      res.writeHead(500);
      res.end("Should not be called");
    });
    await new Promise((r) => silentOllama.listen(0, "127.0.0.1", r));
    try {
      const reusedNews = await generateAiNewsAnalysis({
        triggerType: "AUTO",
        slotKey: "2026-11-19_21:30",
        ollamaBaseUrl: `http://127.0.0.1:${silentOllama.address().port}`,
        skipUpbitApi: true,
        skipExternalApi: true,
        precomputedOllamaResult: ollamaRes,
        precomputedMarketContext: { btcPrice: 86500000, btcDaily20Ma: 97900000, btc4h60Ma: 93000000 },
      });
      assert.equal(reusedNews.success, true);
      assert.equal(reuseOllamaHits, 0, "generateAiNewsAnalysis with precomputedOllamaResult must NOT make a 2nd Ollama call");
    } finally {
      await new Promise((r) => silentOllama.close(r));
    }

    report.push({
      check: "OllamaAndDualSynthesis",
      status: "PASS",
      detail: `Dual synthesis => ${dualSynth.recommended_action}, ProPriority bot_10=${synthProPriority.final_bot_overrides.bot_10}, blacklist sanitized, single-slot Ollama reuse=OK`,
    });
  } finally {
    await mockOllama.close();
  }

  // 4-F. Prompt echo-loop removal & loadSideState legacy pollution re-normalization & KST updated_at
  await db
    .prepare("UPDATE bots SET is_selected_for_live = 1, is_running = 1, last_status_msg = '🟡 AI 장세 필터(HALT_NEW_BUYS)로 신규 진입 보류' WHERE bot_id = 'bot_10'")
    .run();
  const promptCtx = await buildDualAiMarketPromptContext({ isProTarget: true });
  assert.ok(!promptCtx.prompt.includes("현재 게이트웨이:"), "Gemini prompt must NOT echo previous current_override");
  assert.ok(!promptCtx.prompt.includes("최근 메시지:"), "Gemini prompt must NOT echo previous last_status_msg");

  const pollutedFlash = {
    sentiment_score: -0.5,
    market_regime: "BEAR",
    risk_alert: true,
    recommended_action: "REDUCE_SIZE",
    position_size_multiplier: 0.0,
    bot_overrides: {
      bot_01: "BLOCK", bot_02: "BLOCK", bot_03: "BLOCK", bot_04: "BLOCK",
      bot_05: "ALLOW", bot_06: "ALLOW", bot_07: "BLOCK", bot_08: "ALLOW",
      bot_09: "BLOCK", bot_10: "ALLOW",
    },
    blacklist_tickers: ["KRW-티커"],
    reason: "Legacy polluted state",
  };
  await db
    .prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('dual_ai_flash_state_json', ?, '2026-11-19 21:00:00')")
    .run(JSON.stringify(pollutedFlash));
  const cleanedRegime = await updateMarketRegimeFilterFromAnalysis({
    isPro: true,
    provider: "gemini",
    model: "gemini-3.5-flash",
    decision: parsedPro,
  });
  assert.equal(Number(cleanedRegime.final_risk_alert), 0, "loadSideState must re-normalize legacy polluted Flash risk_alert");
  assert.equal(cleanedRegime.recommended_action, "REDUCE_SIZE");
  assert.deepEqual(JSON.parse(cleanedRegime.blacklist_tickers_json), [], "loadSideState must strip legacy KRW-티커");
  assert.equal(cleanedRegime.updated_at, cleanedRegime.pro_updated_at, "market_regime_filter.updated_at must use KST matching pro_updated_at");
  report.push({
    check: "EchoLoopAndLegacyStateCleanup",
    status: "PASS",
    detail: "Prompt echo removed, legacy Flash state re-normalized, updated_at unified to KST",
  });

  // 4-G. Guardrail bucket archiving on CANCELED + MIN_BUY_INTERVAL non-kill-switch + precheck + bot_06 max_splits
  const txDeps = {
    beginWriteTx: async (d) => d.exec("BEGIN IMMEDIATE"),
    commitWriteTx: async (d) => d.exec("COMMIT"),
    rollbackWriteTx: async (d) => { try { await d.exec("ROLLBACK"); } catch {} },
  };
  await db.exec("DELETE FROM live_order_intents; DELETE FROM live_guardrail_events; DELETE FROM bot_positions; DELETE FROM trades;");
  await db.prepare("UPDATE bots SET is_selected_for_live = 1, is_running = 1, allocated_capital = 100000, virtual_krw = 100000 WHERE bot_id = 'bot_10'").run();
  const c1 = await claimLiveBuyIntentAtomic(
    db,
    {
      botId: "bot_10",
      market: "KRW-NEAR",
      orderKrw: 10000,
      bestBidPrice: 4600,
      floorTo8DecimalsStr: (v) => Number(v).toFixed(8),
      options: { intentBucket: "bot_10:KRW-NEAR:candle1:s1", ignoreCooldown: true, ignoreMinInterval: true },
    },
    txDeps
  );
  assert.equal(c1.ok, true, "Initial claim must succeed");

  // getBots("live") must deduct in-flight PENDING reservation
  const liveBotsDuringPending = await getBots("live");
  const b10Pending = liveBotsDuringPending.find((b) => b.bot_id === "bot_10");
  assert.equal(b10Pending.virtual_krw, 100000 - c1.reservedKrw, "getBots('live') must deduct PENDING intent reservation");

  // Refund canceled buy intent -> must archive intent_bucket so re-claim succeeds without DUPLICATE_INTENT_BUCKET!
  const refRes = await refundFailedOrCanceledBuyIntentAtomic(
    db,
    { intentId: c1.intentId, botId: "bot_10", nextStatus: "CANCELED", errorMessage: "40s timeout cancel" },
    txDeps
  );
  assert.equal(refRes.refunded, true);
  const archivedRow = await db.prepare("SELECT intent_bucket, status FROM live_order_intents WHERE intent_id = ?").get(c1.intentId);
  assert.ok(archivedRow.intent_bucket.includes(":canceled:"), `Expected archived intent_bucket, got ${archivedRow.intent_bucket}`);

  const c2 = await claimLiveBuyIntentAtomic(
    db,
    {
      botId: "bot_10",
      market: "KRW-NEAR",
      orderKrw: 10000,
      bestBidPrice: 4600,
      floorTo8DecimalsStr: (v) => Number(v).toFixed(8),
      options: { intentBucket: "bot_10:KRW-NEAR:candle1:s1", ignoreCooldown: true, ignoreMinInterval: true },
    },
    txDeps
  );
  assert.equal(c2.ok, true, "Re-claim of same candle bucket after CANCELED refund must succeed (zero DUPLICATE_INTENT_BUCKET)");

  // MIN_BUY_INTERVAL blocks 6 times in a row must NOT trip Auto Kill-Switch
  for (let i = 0; i < 6; i++) {
    const blocked = await claimLiveBuyIntentAtomic(
      db,
      {
        botId: "bot_10",
        market: "KRW-ETH",
        orderKrw: 10000,
        bestBidPrice: 2400000,
        floorTo8DecimalsStr: (v) => Number(v).toFixed(8),
        options: { intentBucket: `bot_10:KRW-ETH:c${i}:s1`, ignoreCooldown: true },
      },
      txDeps
    );
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "MIN_BUY_INTERVAL");
    assert.equal(blocked.killSwitch, null, "MIN_BUY_INTERVAL must NEVER trip Auto Kill-Switch");
  }
  const b10AfterInterval = await db.prepare("SELECT is_running FROM bots WHERE bot_id = 'bot_10'").get();
  assert.equal(Number(b10AfterInterval.is_running), 1, "bot_10 must stay running after MIN_BUY_INTERVAL blocks");

  const paceRes = await precheckLiveBuyPaceLimits(db, { botId: "bot_10", market: "KRW-ETH", openCount: 0, ignoreCooldown: true });
  assert.equal(paceRes.ok, false);
  assert.equal(paceRes.code, "MIN_BUY_INTERVAL");

  // Clean up test intent & verify getBots("live") preserves negative virtual_krw
  await db.exec("DELETE FROM live_order_intents; DELETE FROM live_guardrail_events;");
  await db.prepare("UPDATE bots SET virtual_krw = -250 WHERE bot_id = 'bot_10'").run();
  const negBot10 = (await getBots("live")).find((b) => b.bot_id === "bot_10");
  assert.equal(negBot10.virtual_krw, -250, "getBots('live') must NOT clamp negative virtual_krw to 0");
  await db.prepare("UPDATE bots SET virtual_krw = 100000 WHERE bot_id = 'bot_10'").run();

  report.push({
    check: "GuardrailCancelArchiveAndPaceSafety",
    status: "PASS",
    detail: "CANCELED bucket archived, retry OK, 6x MIN_BUY_INTERVAL no kill-switch, negative/pending virtual_krw exact",
  });

  // 4-H. Tick-reactive Time-Stop null indicators + getSafeOrderKrw 5,000~5,249 buffer + ATR target 1.8% + WS Hub 10 coins & stale OB
  const kst8hAgo = new Date(Date.now() + 9 * 3600 * 1000 - 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
  const tickNullIndExit = evaluateSmartExit({
    botId: "bot_10",
    position: { avg_buy_price: 1000, created_at: kst8hAgo },
    currentPrice: 1002,
    indicators: null,
    isLive: true,
  });
  assert.equal(tickNullIndExit, null, "evaluateSmartExit with indicators=null must NOT falsely trigger TIME_STOP");

  // Raw order ~5,112 KRW (between 5,000 and 5,249) must bump up to 5,250 KRW buffer!
  const midGapOrder = getSafeOrderKrw({ virtual_krw: 17050, allocated_capital: 17050, config: { order_ratio: 0.3 } }, 0.3, 1.0);
  assert.equal(midGapOrder, 5250, `Expected 5,250 KRW safe floor for 5,000~5,249 range, got ${midGapOrder}`);

  // ATR target 1.8% alignment: ATR=1.8% -> multiplier=1.0x (not shrunk by legacy 1.5%)
  const bot100k = { virtual_krw: 100000, allocated_capital: 100000, config: { order_ratio: 0.3 } };
  const noAtrOrder = getSafeOrderKrw(bot100k, 0.3, 1.0);
  const atr18Order = getSafeOrderKrw(bot100k, 0.3, 1.0, { atr14: 1800, currentPrice: 100000 });
  assert.equal(atr18Order, noAtrOrder, "ATR 1.8% must yield 1.0x multiplier matching execution_quality_service targetAtrPct=1.8");

  // WS Hub default 10 markets + stale getLatestOrderbook returns null + trade-first acc_trade_price_24h=0 ignored
  const defaultHub = new UpbitWsHub();
  assert.equal(defaultHub.subscribedMarkets.size, 10, "UpbitWsHub default constructor must subscribe 10 standard markets");
  assert.ok(defaultHub.subscribedMarkets.has("KRW-NEAR") && defaultHub.subscribedMarkets.has("KRW-SHIB"));
  defaultHub.orderbookMap.set("KRW-BTC", { orderbook_units: [{ ask_price: 100, bid_price: 99, ask_size: 1, bid_size: 1 }] });
  assert.equal(defaultHub.getLatestOrderbook("KRW-BTC"), null, "Stale UpbitWsHub.getLatestOrderbook() must return null");

  // bot_05 config_json has explicit rsi_threshold
  const b5Row = await db.prepare("SELECT config_json FROM bots WHERE bot_id = 'bot_05'").get();
  const b5Cfg = JSON.parse(b5Row.config_json || "{}");
  assert.ok(Number.isFinite(Number(b5Cfg.rsi_threshold)), "bot_05 config_json must include explicit rsi_threshold");

  report.push({
    check: "SmartExitSizingWsAndBot05Parity",
    status: "PASS",
    detail: "null-indicator TIME_STOP fixed, 5,000~5,249->5,250 floor, ATR 1.8% parity, WS 10-coin/stale-OB, bot_05 rsi_threshold",
  });

  // 5. Standard 10-coin live universe includes KRW-ADA & KRW-NEAR and bot_10 executes live buy on KRW-NEAR
  assert.equal(DEFAULT_MONITORED_KRW_MARKETS.length, 10, "Monitored universe must contain 10 coins");
  assert.ok(DEFAULT_MONITORED_KRW_MARKETS.includes("KRW-NEAR"), "KRW-NEAR must be in live universe");
  assert.ok(DEFAULT_MONITORED_KRW_MARKETS.includes("KRW-ADA"), "KRW-ADA must be in live universe");

  await db.prepare("UPDATE bots SET is_selected_for_live = 0, is_running = 0, allocation_ratio = 0, allocated_capital = 0, virtual_krw = 0").run();
  await db
    .prepare(
      "UPDATE bots SET is_selected_for_live = 1, is_running = 1, allocation_ratio = 100, allocated_capital = 60000, virtual_krw = 60000, min_volume_krw = 5000000000 WHERE bot_id = 'bot_10'"
    )
    .run();

  await updateMarketRegimeFilterFromAnalysis({
    isPro: false,
    provider: "ollama",
    model: "qwen3-news",
    decision: parsedPro,
  });
  await updateMarketRegimeFilterFromAnalysis({
    isPro: true,
    provider: "gemini",
    model: "gemini-3.5-flash",
    decision: parsedPro,
  });

  const tickerMap = new Map([
    ["KRW-NEAR", { market: "KRW-NEAR", trade_price: 4610, signed_change_rate: 0.026, acc_trade_price_24h: 22700000000 }],
  ]);
  const mdMap = new Map([
    [
      "KRW-NEAR",
      {
        market: "KRW-NEAR",
        price: 4610,
        ticker: tickerMap.get("KRW-NEAR"),
        indicators: {
          m15: { atr14: 45 },
          kellogg: {
            today_open: 4480,
            prev_close: 4490,
            prev_high: 4600,
            prev_low: 4320,
            vwap: 4520,
            vwap_disparity_pct: 1.99,
            lrc: { lower: 4400, mid: 4550, upper: 4700, slope: 12.5 },
            rvol: 1.7, // >= live threshold 1.6 (previously missed under 2.0)
            recent_high_20: 4605,
            recent_low_20: 4350,
            cur: { opening_price: 4580, high_price: 4615, low_price: 4575, trade_price: 4610 },
            closed: { opening_price: 4550, high_price: 4585, low_price: 4545, trade_price: 4580 },
            curBullish: true,
            closedBullish: true,
          },
        },
      },
    ],
  ]);

  await runLiveTradingBotsCycle({
    skipUpbitApi: true,
    skipDelay: true,
    ignoreCooldown: true,
    tickerMapOverride: tickerMap,
    mdMapOverride: mdMap,
    rankMapOverride: { "KRW-NEAR": { rank: 1, momentumPct: 2.6 } },
  });

  const nearTrade = await db
    .prepare("SELECT bot_id, market, buy_amount, status FROM trades WHERE bot_id = 'bot_10' AND market = 'KRW-NEAR' ORDER BY id DESC LIMIT 1")
    .get();
  assert.ok(nearTrade, "bot_10 MUST execute live buy on KRW-NEAR under REDUCE_SIZE (50%) + RVOL 1.7x");
  assert.ok(Number(nearTrade.buy_amount) >= 5000, `Expected >= 5,000 KRW order, got ${nearTrade.buy_amount}`);
  report.push({
    check: "LiveUniverseKrwNearAndBot10Buy",
    status: "PASS",
    detail: `bot_10 live bought ${nearTrade.market} (${nearTrade.buy_amount} KRW) under BEAR/REDUCE_SIZE 50%`,
  });

  console.log("\n=== Dual AI Risk-Alert Fix & 10-Coin Live Universe Verification ===");
  console.table(report);
} finally {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {}
}
