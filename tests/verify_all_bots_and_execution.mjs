import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_DIR = path.resolve(__dirname, "..");
const TEST_DB_PATH = path.resolve(BASE_DIR, "data", "test_all_bots_verify.db");

function cleanupTestDbFiles() {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const p = `${TEST_DB_PATH}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

cleanupTestDbFiles();

process.env.AUTOCOIN_DB_PATH = TEST_DB_PATH;
process.env.DB_MODE = "sqlite";
process.env.PG_SYNC_ENABLED = "false";
process.env.AUTOCOIN_LIBRARY_MODE = "1";
process.env.AUTOCOIN_FORCE_LIVE_MODE = "1";

const {
  ARENA_BOT_IDS,
  buildIndicators,
  evaluateStrategy,
  evaluateSmartExit,
  runPaperBot,
  tradingDateKST,
  nowKSTString,
  formatKstDateTime,
  computeMomentumRanking,
} = await import("../backend/common/algo_lab_service.mjs");

const {
  getDb,
  initializeDatabase,
  getBots,
  getDualAiCandidateModels,
  getSafeOrderKrw,
  runLiveTradingBotsCycle,
  executeBotSellOrder,
} = await import("../backend/node_server.mjs");

// ============================================================================
// 현실적인 업비트 KST 캔들 생성 유틸리티
// ============================================================================
function kstStringFromBaseMs(baseMs) {
  return formatKstDateTime(new Date(baseMs)).replace(" ", "T");
}

function makeCandles(bars, stepMinutes = 15, startKstMs = null) {
  // 오늘 업비트 거래일(09:00 KST) 이후 시점으로 15분봉이 위치하도록 기본값 설정 (VWAP 계산 정확도 확보)
  let baseMs = startKstMs;
  if (!baseMs) {
    const tDate = tradingDateKST(nowKSTString());
    const startIso = `${tDate}T09:15:00+09:00`;
    baseMs = Date.parse(startIso);
  }
  return bars.map((b, idx) => {
    const close = Number(b.close ?? b.c);
    const open = Number(b.open ?? b.o ?? close);
    const high = Number(b.high ?? b.h ?? Math.max(open, close));
    const low = Number(b.low ?? b.l ?? Math.min(open, close));
    const vol = Number(b.vol ?? b.v ?? 1000);
    const kst = kstStringFromBaseMs(baseMs + idx * stepMinutes * 60 * 1000);
    return {
      candle_date_time_kst: kst,
      candle_date_time_utc: kst,
      opening_price: open,
      high_price: high,
      low_price: low,
      trade_price: close,
      candle_acc_trade_volume: vol,
      candle_acc_trade_price: close * vol,
      prev_closing_price: idx > 0 ? Number(bars[idx - 1].close ?? bars[idx - 1].c) : open,
    };
  });
}

function makeSteadyDayCandles(count = 65, baseClose = 1000, overrides = {}) {
  const arr = [];
  const tDate = tradingDateKST(nowKSTString());
  const today09Ms = Date.parse(`${tDate}T09:00:00+09:00`);
  const startMs = today09Ms - (count - 1) * 86400 * 1000;
  for (let i = 0; i < count; i++) {
    const close = typeof overrides.closeAt === "function" ? overrides.closeAt(i) : baseClose;
    const open = typeof overrides.openAt === "function" ? overrides.openAt(i) : close;
    const high = typeof overrides.highAt === "function" ? overrides.highAt(i) : Math.max(open, close) + 5;
    const low = typeof overrides.lowAt === "function" ? overrides.lowAt(i) : Math.min(open, close) - 5;
    arr.push({ open, high, low, close, vol: 100000 });
  }
  return makeCandles(arr, 1440, startMs);
}

function makeSteadySeriesCandles(count = 65, stepMinutes = 15, fn = null) {
  const bars = [];
  for (let i = 0; i < count; i++) {
    const spec = fn ? fn(i, count) : { open: 1000, high: 1005, low: 995, close: 1000, vol: 1000 };
    bars.push(spec);
  }
  return makeCandles(bars, stepMinutes);
}

function buildScenarioPack() {
  // 1) bot_01: 변동성 돌파 (전일 range=40, 당일 시가=1000 -> k=0.45 기준 목표가 1018, 현재가 1025 돌파 + 거래량 2배)
  const mdBot01 = (() => {
    const day = makeSteadyDayCandles(65, 1000, {
      openAt: (i) => (i === 63 ? 995 : 1000),
      highAt: (i) => (i === 63 ? 1020 : 1005),
      lowAt: (i) => (i === 63 ? 980 : 995),
      closeAt: (i) => (i === 64 ? 1025 : 1000),
    });
    const m15 = makeSteadySeriesCandles(60, 15, (i) =>
      i >= 58
        ? { open: 1015, high: 1026, low: 1014, close: 1025, vol: 2200 }
        : { open: 1000, high: 1003, low: 998, close: 1001, vol: 1000 }
    );
    const price = 1025;
    const md = { market: "KRW-BTC", price, ticker: { trade_price: price, acc_trade_price_24h: 50000000000 }, candles: { day, m240: [], m60: [], m15 } };
    md.indicators = buildIndicators(md);
    return md;
  })();

  // 2) bot_02: SuperTrend 상승 전환 + 2.5배 거래량 돌파
  const mdBot02 = (() => {
    const m60 = makeSteadySeriesCandles(60, 60, (i) => {
      if (i <= 57) {
        const c = 1120 - i * 2;
        return { open: c + 1, high: c + 3, low: c - 2, close: c, vol: 1000 };
      }
      if (i === 58) return { open: 1006, high: 1048, low: 1005, close: 1045, vol: 2600 };
      return { open: 1045, high: 1068, low: 1043, close: 1065, vol: 2800 };
    });
    const price = 1065;
    const md = { market: "KRW-ETH", price, ticker: { trade_price: price, acc_trade_price_24h: 30000000000 }, candles: { day: makeSteadyDayCandles(65, 1065), m240: [], m60, m15: makeSteadySeriesCandles(60, 15) } };
    md.indicators = buildIndicators(md);
    return md;
  })();

  // 3) bot_03: 듀얼 모멘텀 (7일 +8% Rank #1 + 정상 15분봉 / Bull-Trap 윗꼬리 변형)
  const mdBot03 = (() => {
    const day = makeSteadyDayCandles(65, 1000, {
      closeAt: (i) => (i >= 60 ? 1080 : 1000),
      openAt: (i) => (i >= 60 ? 1070 : 1000),
      highAt: (i) => (i >= 60 ? 1085 : 1005),
      lowAt: (i) => (i >= 60 ? 1065 : 995),
    });
    const m15 = makeSteadySeriesCandles(60, 15, (i) =>
      i >= 58
        ? { open: 1072, high: 1082, low: 1070, close: 1080, vol: 1500 }
        : { open: 1070, high: 1073, low: 1068, close: 1071, vol: 1000 }
    );
    const price = 1080;
    const md = { market: "KRW-SOL", price, ticker: { trade_price: price, acc_trade_price_24h: 40000000000 }, candles: { day, m240: [], m60: [], m15 } };
    md.indicators = buildIndicators(md);
    return md;
  })();

  // 4) bot_04: 볼린저 스퀴즈 돌파
  const mdBot04 = (() => {
    const m15 = makeSteadySeriesCandles(60, 15, (i) => {
      if (i < 58) {
        const alt = i % 2 === 0 ? 1000 : 1000.6;
        return { open: alt, high: alt + 0.4, low: alt - 0.4, close: alt, vol: 1000 };
      }
      if (i === 58) return { open: 1000.5, high: 1001, low: 1000, close: 1000.8, vol: 1000 };
      return { open: 1001, high: 1019, low: 1000.5, close: 1018, vol: 3000 };
    });
    const price = 1018;
    const md = { market: "KRW-XRP", price, ticker: { trade_price: price, acc_trade_price_24h: 35000000000 }, candles: { day: makeSteadyDayCandles(65, 1018), m240: [], m60: [], m15 } };
    md.indicators = buildIndicators(md);
    return md;
  })();

  // 5) bot_05: 볼린저 역추세 반등 (BB 하단 터치 후 양봉 복귀 & RSI<=30)
  const mdBot05 = (() => {
    const m15 = makeSteadySeriesCandles(60, 15, (i) => {
      if (i < 50) return { open: 1050, high: 1052, low: 1048, close: 1050, vol: 1000 };
      if (i < 58) {
        const c = 1050 - (i - 49) * 12;
        return { open: c + 5, high: c + 6, low: c - 2, close: c, vol: 1200 };
      }
      if (i === 58) return { open: 954, high: 955, low: 938, close: 940, vol: 1800 };
      // 현재봉: 942 -> 956 양봉 반등 (BB 하단 위로 복귀하면서 RSI3은 과매도 유지)
      return { open: 942, high: 957, low: 939, close: 956, vol: 1600 };
    });
    const price = 956;
    const md = { market: "KRW-DOGE", price, ticker: { trade_price: price, acc_trade_price_24h: 25000000000 }, candles: { day: makeSteadyDayCandles(65, 956), m240: [], m60: [], m15 } };
    md.indicators = buildIndicators(md);
    return md;
  })();

  // 6) bot_06: 다단계 분할 매수 그리드 (RSI<=30 & price <= BB.lower * 1.005)
  const mdBot06 = (() => {
    const m15 = makeSteadySeriesCandles(60, 15, (i) => {
      if (i < 50) return { open: 1050, high: 1052, low: 1048, close: 1050, vol: 1000 };
      const c = 1050 - (i - 49) * 11;
      return { open: c + 4, high: c + 5, low: c - 2, close: c, vol: 1300 };
    });
    const price = 940;
    const md = { market: "KRW-AVAX", price, ticker: { trade_price: price, acc_trade_price_24h: 25000000000 }, candles: { day: makeSteadyDayCandles(65, 940), m240: [], m60: [], m15 } };
    md.indicators = buildIndicators(md);
    return md;
  })();

  // 7) bot_07: MACD + RSI 골든크로스 (15/60분봉 EMA20>60 정배열 + MACD 골든크로스 + RSI 45~65)
  const mdBot07 = (() => {
    const m60 = makeSteadySeriesCandles(65, 60, (i) => {
      const c = 900 + i * 3;
      return { open: c - 1, high: c + 2, low: c - 2, close: c, vol: 1000 };
    });
    const m15 = makeSteadySeriesCandles(70, 15, (i) => {
      // 초반 상승으로 EMA20 > EMA60 확립 후 눌림으로 MACD 하향 전환, 최근 7봉 반등으로 최종봉 MACD 골든크로스 + RSI ~57.8
      let c;
      if (i < 45) c = 1000 + i * 2.0 + (i % 2 === 0 ? 0.5 : -0.5);
      else if (i < 63) c = 1088 - (i - 44) * 1.9 + (i % 2 === 0 ? 1.0 : -1.0);
      else c = 1054 + (i - 62) * 2.0 + (i === 65 ? -1.5 : 0);
      return { open: c - 1, high: c + 2, low: c - 2, close: c, vol: 1100 };
    });
    const price = Number(m15[m15.length - 1].trade_price);
    const md = { market: "KRW-SHIB", price, ticker: { trade_price: price, acc_trade_price_24h: 20000000000 }, candles: { day: makeSteadyDayCandles(65, price), m240: [], m60, m15 } };
    md.indicators = buildIndicators(md);
    return md;
  })();

  // 8) bot_08: 정배열 20일선 눌림목 (일봉/4시간봉 정배열 + 20일선 ±1.5% 이내 + 거래량 감소 + 직전고점까지 충분한 여유)
  const mdBot08 = (() => {
    const day = makeSteadyDayCandles(65, 1000, {
      closeAt: (i) => {
        if (i < 55) return 850 + i * 4;
        if (i < 60) return 1070 + (i - 55) * 5;
        return 1090 - (i - 59) * 4; // 마지막 1070: ma5(1078) > ma20(1063.5) > ma60(986.5), 이격 +0.61%
      },
      highAt: (i) => (i === 59 ? 1105 : 1092),
      lowAt: () => 845,
      openAt: (i) => (i === 64 ? 1074 : 1000),
    });
    const m240 = makeSteadySeriesCandles(65, 240, (i) => {
      const c = 900 + i * 2.1;
      const vol = i >= 62 ? 450 : 1000; // 직전 마감봉 거래량 감소 (< 1.0)
      return { open: c - 1, high: c + 2, low: c - 2, close: c, vol };
    });
    const price = Number(day[day.length - 1].trade_price);
    const md = { market: "KRW-BTC", price, ticker: { trade_price: price, acc_trade_price_24h: 45000000000 }, candles: { day, m240, m60: [], m15: makeSteadySeriesCandles(60, 15) } };
    md.indicators = buildIndicators(md);
    return md;
  })();

  // 9) bot_09: 거래량 폭발 모멘텀 스캘퍼 (직전 마감봉 2.5배 거래량 양봉 + 작은 윗꼬리)
  const mdBot09 = (() => {
    const m15 = makeSteadySeriesCandles(60, 15, (i) => {
      if (i === 58) return { open: 1000, high: 1013, low: 999, close: 1012, vol: 2600 };
      if (i === 59) return { open: 1012, high: 1016, low: 1011, close: 1015, vol: 1200 };
      return { open: 1000, high: 1002, low: 998, close: 1000, vol: 1000 };
    });
    const price = 1015;
    const md = { market: "KRW-ETH", price, ticker: { trade_price: price, acc_trade_price_24h: 35000000000 }, candles: { day: makeSteadyDayCandles(65, 1015), m240: [], m60: [], m15 } };
    md.indicators = buildIndicators(md);
    return md;
  })();

  // 10) bot_10: 잭 켈로그 Setup B (LRC 하단 터치 + 중심선까지 >= 0.6% 여유 + VWAP 이격 <= -2.8% + RVOL >= 1.3 + 양봉 반등)
  const mdBot10 = (() => {
    const day = makeSteadyDayCandles(65, 1000, {
      openAt: () => 1000,
      highAt: () => 1020,
      lowAt: () => 920,
      closeAt: () => 943,
    });
    const m15 = makeSteadySeriesCandles(60, 15, (i) => {
      if (i < 42) return { open: 1010, high: 1013, low: 1007, close: 1010, vol: 1000 };
      if (i < 57) {
        const c = 995 - (i - 41) * 1.8;
        return { open: c + 1, high: c + 2, low: c - 2, close: c, vol: 1000 };
      }
      if (i === 57) return { open: 968, high: 969, low: 960, close: 964, vol: 1100 };
      if (i === 58) return { open: 964, high: 965, low: 930, close: 934, vol: 1800 };
      // 현재봉: LRC 하단(937.66) 터치 후 반등 초입 (중심선 951.20 대비 +0.87% 여유)
      return { open: 935, high: 944, low: 933, close: 943, vol: 2000 };
    });
    const price = 943;
    const md = { market: "KRW-SUI", price, ticker: { trade_price: price, acc_trade_price_24h: 30000000000 }, candles: { day, m240: [], m60: [], m15 } };
    md.indicators = buildIndicators(md);
    return md;
  })();

  return { mdBot01, mdBot02, mdBot03, mdBot04, mdBot05, mdBot06, mdBot07, mdBot08, mdBot09, mdBot10 };
}

async function runTests() {
  await initializeDatabase();
  const db = getDb();
  const reportRows = [];

  try {
    const packs = buildScenarioPack();

    // =========================================================================
    // PART 1: bot_01 ~ bot_10 전체 전략 진입 · 무수익 즉시매도 차단 · 청산 대칭 검증
    // =========================================================================
    const yesterdayKst = formatKstDateTime(new Date(Date.now() - 25 * 3600 * 1000));
    const todaySameTradingKst = nowKSTString();

    // --- bot_01 ---
    const b1Buy = evaluateStrategy("bot_01", packs.mdBot01, packs.mdBot01.indicators, [], { isLive: true });
    assert.equal(b1Buy.signal, "BUY", `bot_01 valid breakout should BUY, got: ${b1Buy.reason}`);
    // Bull trap block
    const b1TrapMd = structuredClone(packs.mdBot01);
    b1TrapMd.candles.m15[59].high_price = 1090;
    b1TrapMd.indicators = buildIndicators(b1TrapMd);
    assert.equal(
      evaluateStrategy("bot_01", b1TrapMd, b1TrapMd.indicators, [], { isLive: true }).signal,
      "HOLD",
      "bot_01 bull-trap upper wick must block BUY"
    );
    // Same trading day hold -> next trading day sell
    assert.equal(
      evaluateStrategy("bot_01", packs.mdBot01, packs.mdBot01.indicators, [{ id: 1, avg_buy_price: 1025, created_at: todaySameTradingKst }], { isLive: true }).signal,
      "HOLD",
      "bot_01 must HOLD on same KST trading day (no churn)"
    );
    assert.equal(
      evaluateStrategy("bot_01", packs.mdBot01, packs.mdBot01.indicators, [{ id: 1, avg_buy_price: 1025, created_at: yesterdayKst }], { isLive: true }).signal,
      "SELL",
      "bot_01 must SELL on next KST trading day open"
    );
    reportRows.push({ suite: "Strategy", bot: "bot_01", check: "Breakout + BullTrap + NextDayExit", status: "PASS" });

    // --- bot_02 ---
    const b2Buy = evaluateStrategy("bot_02", packs.mdBot02, packs.mdBot02.indicators, [], { isLive: true });
    assert.equal(b2Buy.signal, "BUY", `bot_02 SuperTrend flip should BUY, got: ${b2Buy.reason}`);
    assert.equal(
      evaluateStrategy("bot_02", packs.mdBot02, packs.mdBot02.indicators, [{ id: 1, avg_buy_price: 1065 }], { isLive: true, peakPrice: 1065 }).signal,
      "HOLD",
      "bot_02 must HOLD immediately after BUY"
    );
    const atr2 = packs.mdBot02.indicators.m60.atr14;
    const b2ExitMd = { ...packs.mdBot02, price: 1120 - 3 * atr2 };
    assert.equal(
      evaluateStrategy("bot_02", b2ExitMd, packs.mdBot02.indicators, [{ id: 1, avg_buy_price: 1065 }], { isLive: true, peakPrice: 1120 }).signal,
      "SELL",
      "bot_02 must SELL when trailing stop -2.5xATR breached"
    );
    reportRows.push({ suite: "Strategy", bot: "bot_02", check: "SuperTrend Flip + Trailing ATR Exit", status: "PASS" });

    // --- bot_03 --- (실제 ind.m15 기반 윗꼬리·과열 필터 복구 검증 포함)
    const rankMap3 = { "KRW-SOL": { rank: 1, momPct: 6.5 } };
    const b3Buy = evaluateStrategy("bot_03", packs.mdBot03, packs.mdBot03.indicators, [], {
      isLive: true,
      momentumRank: rankMap3,
      market: "KRW-SOL",
    });
    assert.equal(b3Buy.signal, "BUY", `bot_03 rank #1 clean m15 should BUY, got: ${b3Buy.reason}`);
    // Bull-trap upper wick MUST block bot_03 (이전 Dead Code 회귀)
    const b3TrapMd = structuredClone(packs.mdBot03);
    b3TrapMd.candles.m15[59].high_price = 1150;
    b3TrapMd.indicators = buildIndicators(b3TrapMd);
    const b3TrapSig = evaluateStrategy("bot_03", b3TrapMd, b3TrapMd.indicators, [], {
      isLive: true,
      momentumRank: rankMap3,
      market: "KRW-SOL",
    });
    assert.equal(b3TrapSig.signal, "HOLD", `bot_03 bull-trap guard must block BUY, got: ${b3TrapSig.signal} (${b3TrapSig.reason})`);
    assert.ok(b3TrapSig.reason.includes("가짜 돌파"), `bot_03 trap block reason expected, got: ${b3TrapSig.reason}`);
    // Overextension >= +6% above EMA20 MUST block bot_03
    const b3HotMd = structuredClone(packs.mdBot03);
    b3HotMd.price = 1200;
    b3HotMd.indicators = {
      ...packs.mdBot03.indicators,
      m15: { ...packs.mdBot03.indicators.m15, cur: { ...packs.mdBot03.indicators.m15.cur, trade_price: 1200, high_price: 1201 } },
    };
    assert.equal(
      evaluateStrategy("bot_03", b3HotMd, b3HotMd.indicators, [], { isLive: true, momentumRank: rankMap3, market: "KRW-SOL" }).signal,
      "HOLD",
      "bot_03 overextension (+6% vs EMA20) must block BUY"
    );
    assert.equal(
      evaluateStrategy("bot_03", packs.mdBot03, packs.mdBot03.indicators, [{ id: 1, avg_buy_price: 1080 }], { isLive: true, momentumRank: rankMap3, market: "KRW-SOL" }).signal,
      "HOLD",
      "bot_03 must HOLD immediately after BUY"
    );
    assert.equal(
      evaluateStrategy("bot_03", packs.mdBot03, packs.mdBot03.indicators, [{ id: 1, avg_buy_price: 1080 }], {
        isLive: true,
        momentumRank: { "KRW-SOL": { rank: 3, momPct: -0.5 } },
        market: "KRW-SOL",
      }).signal,
      "SELL",
      "bot_03 must SELL when 7d momentum < 0%"
    );
    reportRows.push({ suite: "Strategy", bot: "bot_03", check: "DualMom + DeadCode Wick/Overext Guard Restored", status: "PASS" });

    // --- bot_04 ---
    const b4Buy = evaluateStrategy("bot_04", packs.mdBot04, packs.mdBot04.indicators, [], { isLive: true });
    assert.equal(b4Buy.signal, "BUY", `bot_04 BB squeeze breakout should BUY, got: ${b4Buy.reason}`);
    assert.equal(
      evaluateStrategy("bot_04", packs.mdBot04, packs.mdBot04.indicators, [{ id: 1, avg_buy_price: 1018 }], { isLive: true }).signal,
      "HOLD",
      "bot_04 must HOLD immediately after BUY"
    );
    const b4ExitMd = { ...packs.mdBot04, price: packs.mdBot04.indicators.m15.bb.mid - 1 };
    assert.equal(
      evaluateStrategy("bot_04", b4ExitMd, packs.mdBot04.indicators, [{ id: 1, avg_buy_price: 1018 }], { isLive: true }).signal,
      "SELL",
      "bot_04 must SELL when price < BB mid"
    );
    reportRows.push({ suite: "Strategy", bot: "bot_04", check: "BB Squeeze Breakout + Mid Exit", status: "PASS" });

    // --- bot_05 ---
    const b5Buy = evaluateStrategy("bot_05", packs.mdBot05, packs.mdBot05.indicators, [], { isLive: true });
    assert.equal(b5Buy.signal, "BUY", `bot_05 oversold bounce should BUY, got: ${b5Buy.reason}`);
    assert.equal(
      evaluateStrategy("bot_05", packs.mdBot05, packs.mdBot05.indicators, [{ id: 1, avg_buy_price: 956 }], { isLive: true }).signal,
      "HOLD",
      "bot_05 must HOLD on entry tick (delegates TP/SL to engine)"
    );
    reportRows.push({ suite: "Strategy", bot: "bot_05", check: "BB Reversal Bounce + Immediate Hold", status: "PASS" });

    // --- bot_06 ---
    const b6Buy1 = evaluateStrategy("bot_06", packs.mdBot06, packs.mdBot06.indicators, [], {
      isLive: true,
      params: { order_ratio: 0.45, max_splits: 3, take_profit_pct: 1.8 },
    });
    assert.equal(b6Buy1.signal, "BUY", `bot_06 split 1 should BUY, got: ${b6Buy1.reason}`);
    assert.equal(b6Buy1.splitIndex, 1);
    assert.ok(Math.abs(b6Buy1.order_ratio - 0.15) < 1e-6, `bot_06 split 1 order_ratio must be 0.15 (0.45/3), got ${b6Buy1.order_ratio}`);
    // Same tick held -> HOLD
    assert.equal(
      evaluateStrategy("bot_06", packs.mdBot06, packs.mdBot06.indicators, [{ id: 10, avg_buy_price: 940 }], { isLive: true }).signal,
      "HOLD",
      "bot_06 must HOLD right after Split 1"
    );
    // Drop -2.6% -> Split 2
    const b6Split2 = evaluateStrategy("bot_06", { ...packs.mdBot06, price: 915 }, packs.mdBot06.indicators, [{ id: 10, avg_buy_price: 940 }], {
      isLive: true,
      params: { order_ratio: 0.45, max_splits: 3, take_profit_pct: 1.8 },
    });
    assert.equal(b6Split2.signal, "BUY");
    assert.equal(b6Split2.splitIndex, 2);
    assert.ok(Math.abs(b6Split2.order_ratio - 0.15) < 1e-6);
    // Rebound +2% on split 2 (934) while split 1 (940) is flat -> sell ONLY split 2 id!
    const b6PartialSell = evaluateStrategy(
      "bot_06",
      { ...packs.mdBot06, price: 934 },
      packs.mdBot06.indicators,
      [
        { id: 10, avg_buy_price: 940 },
        { id: 11, avg_buy_price: 915 },
      ],
      { isLive: true, params: { take_profit_pct: 1.8 } }
    );
    assert.equal(b6PartialSell.signal, "SELL");
    assert.deepEqual(b6PartialSell.sellPositionIds, [11], "bot_06 must exit only profitable split #11");
    reportRows.push({ suite: "Strategy", bot: "bot_06", check: "Grid Split Ratio (0.15) + Selective Split Exit", status: "PASS" });

    // --- bot_07 --- (MACD back=2 이미 데드크로스 진입 차단 회귀 포함)
    const b7Buy = evaluateStrategy("bot_07", packs.mdBot07, packs.mdBot07.indicators, [], { isLive: true });
    assert.equal(b7Buy.signal, "BUY", `bot_07 MACD cross + EMA align + RSI should BUY, got: ${b7Buy.reason}`);
    assert.equal(
      evaluateStrategy("bot_07", packs.mdBot07, packs.mdBot07.indicators, [{ id: 1, avg_buy_price: packs.mdBot07.price }], { isLive: true }).signal,
      "HOLD",
      "bot_07 must HOLD on same bar right after BUY"
    );
    // Dead-cross churn guard: n-3->n-2 crossUp BUT n-2->n-1 already crossedDown!
    const b7ChurnInd = structuredClone(packs.mdBot07.indicators);
    const mn = b7ChurnInd.m15.macdSeries.macd.length;
    b7ChurnInd.m15.macdSeries.macd[mn - 3] = 0.5;
    b7ChurnInd.m15.macdSeries.signal[mn - 3] = 1.0;
    b7ChurnInd.m15.macdSeries.macd[mn - 2] = 1.5;
    b7ChurnInd.m15.macdSeries.signal[mn - 2] = 1.0;
    b7ChurnInd.m15.macdSeries.macd[mn - 1] = 0.8;
    b7ChurnInd.m15.macdSeries.signal[mn - 1] = 1.0; // ALREADY DEAD CROSSED ON CURRENT BAR!
    assert.equal(
      evaluateStrategy("bot_07", packs.mdBot07, b7ChurnInd, [], { isLive: true }).signal,
      "HOLD",
      "bot_07 MUST NOT BUY on back=2 golden cross when current bar already dead-crossed"
    );
    assert.equal(
      evaluateStrategy("bot_07", packs.mdBot07, b7ChurnInd, [{ id: 1, avg_buy_price: packs.mdBot07.price }], { isLive: true }).signal,
      "SELL",
      "bot_07 must SELL held position on MACD dead cross"
    );
    reportRows.push({ suite: "Strategy", bot: "bot_07", check: "MACD Cross + Dead-Cross Churn Block", status: "PASS" });

    // --- bot_08 --- (직전 고점 부근 여지 부족 즉시매도 차단 회귀 포함)
    const b8Buy = evaluateStrategy("bot_08", packs.mdBot08, packs.mdBot08.indicators, [], { isLive: true });
    assert.equal(b8Buy.signal, "BUY", `bot_08 aligned pullback with upside room should BUY, got: ${b8Buy.reason}`);
    assert.equal(
      evaluateStrategy("bot_08", packs.mdBot08, packs.mdBot08.indicators, [{ id: 1, avg_buy_price: packs.mdBot08.price }], { isLive: true }).signal,
      "HOLD",
      "bot_08 must HOLD right after BUY"
    );
    // High target right on top of entry (< 0.6% room) MUST block entry
    const b8TightInd = structuredClone(packs.mdBot08.indicators);
    b8TightInd.day.recentHigh20 = packs.mdBot08.price / 0.995; // exactly at sell trigger -> 0% room!
    assert.equal(
      evaluateStrategy("bot_08", packs.mdBot08, b8TightInd, [], { isLive: true }).signal,
      "HOLD",
      "bot_08 MUST NOT BUY when recentHigh20*0.995 leaves < 0.6% upside room"
    );
    // Held position with < +0.6% gain at recentHigh20*0.995 MUST HOLD; >= +0.6% MUST SELL
    assert.equal(
      evaluateStrategy("bot_08", packs.mdBot08, b8TightInd, [{ id: 1, avg_buy_price: packs.mdBot08.price }], { isLive: true }).signal,
      "HOLD",
      "bot_08 must NOT sell at 0% profit when price >= recentHigh20*0.995"
    );
    assert.equal(
      evaluateStrategy("bot_08", packs.mdBot08, b8TightInd, [{ id: 1, avg_buy_price: packs.mdBot08.price * 0.985 }], { isLive: true }).signal,
      "SELL",
      "bot_08 should SELL at recentHigh20*0.995 once profit (+1.5%) >= 0.6%"
    );
    reportRows.push({ suite: "Strategy", bot: "bot_08", check: "MA20 Pullback + No Immediate RecentHigh Churn", status: "PASS" });

    // --- bot_09 ---
    const b9Buy = evaluateStrategy("bot_09", packs.mdBot09, packs.mdBot09.indicators, [], { isLive: true });
    assert.equal(b9Buy.signal, "BUY", `bot_09 volume spike should BUY, got: ${b9Buy.reason}`);
    const b9TrapMd = structuredClone(packs.mdBot09);
    b9TrapMd.candles.m15[58].high_price = 1045;
    b9TrapMd.indicators = buildIndicators(b9TrapMd);
    assert.equal(
      evaluateStrategy("bot_09", b9TrapMd, b9TrapMd.indicators, [], { isLive: true }).signal,
      "HOLD",
      "bot_09 upper-wick bull trap must block BUY"
    );
    assert.equal(
      evaluateStrategy("bot_09", packs.mdBot09, packs.mdBot09.indicators, [{ id: 1, avg_buy_price: 1015 }], { isLive: true, peakPrice: 1015 }).signal,
      "HOLD",
      "bot_09 must HOLD right after BUY"
    );
    assert.equal(
      evaluateStrategy("bot_09", { ...packs.mdBot09, price: 999 }, packs.mdBot09.indicators, [{ id: 1, avg_buy_price: 1015 }], { isLive: true, peakPrice: 1020 }).signal,
      "SELL",
      "bot_09 must SELL when -1.5% trailing stop hit"
    );
    reportRows.push({ suite: "Strategy", bot: "bot_09", check: "Volume Spike + BullTrap + Trailing Exit", status: "PASS" });

    // --- bot_10 --- (Setup B 1차 + 2차 + LRC 익절 마진 + Setup A)
    const b10Buy1 = evaluateStrategy("bot_10", packs.mdBot10, packs.mdBot10.indicators, [], { isLive: true });
    assert.equal(b10Buy1.signal, "BUY", `bot_10 real-candle Setup B 1차 should BUY, got: ${b10Buy1.reason}`);
    assert.equal(b10Buy1.setup, "B");
    assert.equal(b10Buy1.splitIndex, 1);
    assert.equal(
      evaluateStrategy("bot_10", packs.mdBot10, packs.mdBot10.indicators, [{ id: 1, avg_buy_price: 943, buy_reason: b10Buy1.reason }], { isLive: true }).signal,
      "HOLD",
      "bot_10 must HOLD immediately after Setup B 1차 BUY"
    );
    // Setup B 2차 scaling-in (-1.7% drop with bounce above prev_low) MUST now be reachable!
    const b10ScaleInd = structuredClone(packs.mdBot10.indicators);
    b10ScaleInd.kellogg.prev_low = 920;
    b10ScaleInd.kellogg.curBullish = true;
    const b10ScaleBuy = evaluateStrategy(
      "bot_10",
      { market: "KRW-SUI", price: 926 },
      b10ScaleInd,
      [{ id: 1, avg_buy_price: 943, buy_amount: 10000, volume: "10.604453", buy_reason: b10Buy1.reason }],
      { isLive: true }
    );
    assert.equal(b10ScaleBuy.signal, "BUY", `bot_10 Setup B 2차 scaling-in at -1.7% should BUY, got: ${b10ScaleBuy.reason}`);
    assert.equal(b10ScaleBuy.splitIndex, 2);

    // Setup A 돌파: LRC 상단 여지 >= 0.6% 시 매수, < 0.6% 차단, 익절 시 +0.6% 마진 확인
    const mkSetupAInd = ({ price, lrcUpper }) => ({
      price,
      kellogg: {
        today_open: 980,
        prev_close: 985,
        prev_high: 1000,
        prev_low: 960,
        vwap: 990,
        vwap_disparity_pct: ((price - 990) / 990) * 100,
        lrc: { lower: 970, mid: 995, upper: lrcUpper, slope: 1.5 },
        rvol: 2.2,
        recent_high_20: 1000,
        recent_low_20: 970,
        cur: { opening_price: 998, high_price: price + 2, low_price: 997, trade_price: price },
        closed: { opening_price: 992, high_price: 1000, low_price: 991, trade_price: 998 },
        curBullish: true,
        closedBullish: true,
      },
    });
    assert.equal(
      evaluateStrategy("bot_10", { market: "KRW-SUI", price: 1005 }, mkSetupAInd({ price: 1005, lrcUpper: 1008 }), [], { isLive: true }).signal,
      "HOLD",
      "bot_10 Setup A must NOT buy when room to LRC upper < 0.6%"
    );
    const b10SetupABuy = evaluateStrategy(
      "bot_10",
      { market: "KRW-SUI", price: 1005 },
      mkSetupAInd({ price: 1005, lrcUpper: 1020 }),
      [],
      { isLive: true }
    );
    assert.equal(b10SetupABuy.signal, "BUY", `bot_10 Setup A with +1.49% upper room should BUY, got: ${b10SetupABuy.reason}`);
    assert.equal(b10SetupABuy.setup, "A");
    assert.equal(
      evaluateStrategy(
        "bot_10",
        { market: "KRW-SUI", price: 1011 },
        mkSetupAInd({ price: 1011, lrcUpper: 1010 }),
        [{ id: 1, avg_buy_price: 1010, buy_amount: 10000, volume: "9.900990", buy_reason: b10SetupABuy.reason }],
        { isLive: true }
      ).signal,
      "HOLD",
      "bot_10 Setup A must NOT exit at LRC upper when profit (+0.1%) < 0.6%"
    );
    assert.equal(
      evaluateStrategy(
        "bot_10",
        { market: "KRW-SUI", price: 1015 },
        mkSetupAInd({ price: 1015, lrcUpper: 1014 }),
        [{ id: 1, avg_buy_price: 1005, buy_amount: 10000, volume: "9.950248", buy_reason: b10SetupABuy.reason }],
        { isLive: true }
      ).signal,
      "SELL",
      "bot_10 Setup A must take LRC upper profit when gain (+1.0%) >= 0.6%"
    );
    reportRows.push({ suite: "Strategy", bot: "bot_10", check: "Kellogg Setup A + Setup B 1차/2차 + Churn Guard", status: "PASS" });

    // =========================================================================
    // PART 2: evaluateSmartExit 경계/타임존/그리드 예외 검증
    // =========================================================================
    // 2-A. KST 문자열 타임스탬프 Time-Stop (가상 2.5h >= 2.0h)
    const kst2_5hAgo = formatKstDateTime(new Date(Date.now() - 2.5 * 3600 * 1000));
    const timeStopHit = evaluateSmartExit({
      botId: "bot_01",
      position: { avg_buy_price: 1000, created_at: kst2_5hAgo },
      currentPrice: 998,
      indicators: { m15: { curVolRatio: 0.7 } },
      isLive: false,
    });
    assert.equal(timeStopHit?.exitType, "TIME_STOP", "Time-Stop must trigger using KST timestamp parsing");

    // 2-B. ATR_TRAILING_STOP은 peakPnlPct < 1.0% 구간(소폭 등락)에서 손실 조기 청산 금지
    const tinyPeakNoCut = evaluateSmartExit({
      botId: "bot_04",
      position: { avg_buy_price: 1000, created_at: todaySameTradingKst },
      currentPrice: 992, // -0.8% (hardStopPrice = 1000 - 2.2*5 = 989, peakPnl = +0.2%)
      indicators: { m15: { atr14: 5 } },
      peakPrice: 1002,
      isLive: true,
    });
    assert.equal(tinyPeakNoCut, null, "ATR_TRAILING_STOP must NOT trigger at a loss after +0.2% noise peak");

    const profitTrailingHit = evaluateSmartExit({
      botId: "bot_04",
      position: { avg_buy_price: 1000, created_at: todaySameTradingKst },
      currentPrice: 1010, // +2.5% peak -> 1025 - 1.8*5 = 1016 -> hits trailing stop at +1.0% profit!
      indicators: { m15: { atr14: 5 } },
      peakPrice: 1025,
      isLive: true,
    });
    assert.equal(profitTrailingHit?.exitType, "ATR_TRAILING_STOP", "ATR_TRAILING_STOP must lock profit once peak >= +1.0%");

    // 2-C. Grid bot_06은 15m ATR_HARD_STOP(-1.5%) 면제되어 -2.6% 물타기까지 버텨야 함
    const gridSurvives = evaluateSmartExit({
      botId: "bot_06",
      position: { avg_buy_price: 1000, created_at: todaySameTradingKst },
      currentPrice: 974, // -2.6% (other bots would hit -2.2*7 = -1.54% ATR hard stop)
      indicators: { m15: { atr14: 7 } },
      peakPrice: 1000,
      isLive: true,
      stopLossPct: -9.0,
    });
    assert.equal(gridSurvives, null, "bot_06 grid scaling MUST NOT be killed early by 15m ATR_HARD_STOP");
    reportRows.push({ suite: "SmartExit", bot: "ALL", check: "KST TimeStop + Trailing>=1% + Grid ATR Exemption", status: "PASS" });

    // =========================================================================
    // PART 3: 5,000원 업비트 최소주문 방어 경계 & 소액 계좌 주문 사이징 검증
    // =========================================================================
    assert.equal(getSafeOrderKrw({ virtual_krw: 4900, allocated_capital: 50000, config: { order_ratio: 0.3 } }, 0.3, 1.0), 0);
    assert.equal(
      getSafeOrderKrw({ virtual_krw: 5100, allocated_capital: 50000, config: { order_ratio: 0.3 } }, 0.3, 1.0),
      0,
      "Must refuse < 5,255 KRW balance that drops under Upbit 5,000 KRW floor on normal stop loss"
    );
    const bufferedMinOrder = getSafeOrderKrw(
      { virtual_krw: 53000, allocated_capital: 53000, config: { order_ratio: 0.15 } },
      0.15,
      0.5
    );
    assert.equal(bufferedMinOrder, 5250, "Scaled-down thin order on small live balance must floor at 5,250 KRW safe buffer");
    assert.equal(
      getSafeOrderKrw({ virtual_krw: 53000, allocated_capital: 53000, config: { order_ratio: 0.3 } }, 0.3, 0.0),
      0,
      "AI multiplier 0.0 must return 0 KRW order"
    );
    reportRows.push({ suite: "OrderSizing", bot: "ALL", check: "5,250 KRW Anti-Cleanse Buffer + 5,000 KRW Floor", status: "PASS" });

    // =========================================================================
    // PART 4: 전 10개 봇 Paper Arena (`runPaperBot`) 실체결 + 무수익 즉시청산 0건 검증
    // =========================================================================
    const scenarioList = [
      { botId: "bot_01", md: packs.mdBot01, expectedRatio: 0.3 },
      { botId: "bot_02", md: packs.mdBot02, expectedRatio: 0.3 },
      { botId: "bot_03", md: packs.mdBot03, expectedRatio: 0.35 },
      { botId: "bot_04", md: packs.mdBot04, expectedRatio: 0.3 },
      { botId: "bot_05", md: packs.mdBot05, expectedRatio: 0.45 },
      { botId: "bot_06", md: packs.mdBot06, expectedRatio: 0.15 }, // 0.45 / 3 splits = 0.15!
      { botId: "bot_07", md: packs.mdBot07, expectedRatio: 0.3 },
      { botId: "bot_08", md: packs.mdBot08, expectedRatio: 0.3 },
      { botId: "bot_09", md: packs.mdBot09, expectedRatio: 0.3 },
      { botId: "bot_10", md: packs.mdBot10, expectedRatio: 0.15 }, // Setup B 1차 = 0.15!
    ];

    for (const sc of scenarioList) {
      await db.exec("DELETE FROM paper_bot_positions; DELETE FROM paper_trades;");
      await db.prepare("UPDATE bots SET paper_initial_capital = 1000000, paper_virtual_krw = 1000000 WHERE bot_id = ?").run(sc.botId);
      const botRow = await db.prepare("SELECT * FROM bots WHERE bot_id = ?").get(sc.botId);
      const mdMap = new Map([[sc.md.market, sc.md]]);
      const tickerMap = new Map([[sc.md.market, sc.md.ticker]]);
      const rankMap = sc.botId === "bot_03" ? { [sc.md.market]: { rank: 1, momPct: 6.5 } } : computeMomentumRanking(mdMap, [sc.md.market]);

      const buyMsg = await runPaperBot(db, botRow, { mdMap, universe: [sc.md.market], rankMap, tickerMap });
      assert.ok(buyMsg.startsWith("[가상매수]"), `${sc.botId} runPaperBot cycle 1 must execute paper buy, got: ${buyMsg}`);

      const openPos = await db.prepare("SELECT * FROM paper_bot_positions WHERE bot_id = ? AND status = 'OPEN'").all(sc.botId);
      assert.equal(openPos.length, 1, `${sc.botId} must have 1 open paper position`);
      assert.ok(openPos[0].buy_reason, `${sc.botId} paper position must persist buy_reason`);

      // Sizing check (note paperBuy floors budget / 1.0005, and bot_05 has order_krw not applied in paperBot)
      const actualBuyKrw = Number(openPos[0].buy_amount);
      const expectedApprox = Math.floor((1000000 * sc.expectedRatio) / 1.0005);
      assert.ok(Math.abs(actualBuyKrw - expectedApprox) <= 2, `${sc.botId} paper sizing expected ~${expectedApprox}, got ${actualBuyKrw}`);

      // Cycle 2 on identical tick: MUST NOT churn sell!
      const holdMsg = await runPaperBot(db, botRow, { mdMap, universe: [sc.md.market], rankMap, tickerMap });
      assert.ok(!holdMsg.startsWith("[가상매도]"), `${sc.botId} MUST NOT immediate-sell on same tick in Paper Arena, got: ${holdMsg}`);
    }
    reportRows.push({ suite: "PaperArena", bot: "bot_01~10", check: "All 10 Bots E2E Paper Entry + Zero Immediate Churn", status: "PASS" });

    // =========================================================================
    // PART 5: 전 10개 봇 Live Trading Cycle (`runLiveTradingBotsCycle`) E2E 검증
    //         + bot_06 실전 분할비중(15%) + 서킷브레이커(-4%) + 15분 쿨다운 검증
    // =========================================================================
    for (const sc of scenarioList) {
      await db.exec("DELETE FROM bot_positions; DELETE FROM trades;");
      await db.prepare("UPDATE bots SET is_selected_for_live = 0, is_running = 0, allocation_ratio = 0, allocated_capital = 0, virtual_krw = 0").run();
      // bot_05 order_krw=15000 테스트도 확인되도록 배정원금 100,000원으로 실전 테스트
      await db.prepare(`
        UPDATE bots
        SET is_selected_for_live = 1, is_running = 1, allocation_ratio = 100, allocated_capital = 100000, virtual_krw = 100000
        WHERE bot_id = ?
      `).run(sc.botId);
      await db.prepare(`
        INSERT OR REPLACE INTO market_regime_filter (
          id, sentiment_score, market_regime, risk_alert, recommended_action,
          position_size_multiplier, final_risk_alert, final_position_multiplier,
          final_bot_overrides_json, bot_overrides_json, blacklist_tickers_json
        ) VALUES (1, 0.2, 'SIDEWAYS', 0, 'NORMAL', 1.0, 0, 1.0, '{}', '{}', '[]')
      `).run();

      const mdMap = new Map([[sc.md.market, sc.md]]);
      const tickerMap = new Map([[sc.md.market, sc.md.ticker]]);
      const rankMap = sc.botId === "bot_03" ? { [sc.md.market]: { rank: 1, momPct: 6.5 } } : computeMomentumRanking(mdMap, [sc.md.market]);

      await runLiveTradingBotsCycle({
        skipUpbitApi: true,
        ignoreCooldown: true,
        mdMapOverride: mdMap,
        tickerMapOverride: tickerMap,
        rankMapOverride: rankMap,
      });

      const livePos = await db.prepare("SELECT * FROM bot_positions WHERE bot_id = ? AND status = 'OPEN'").all(sc.botId);
      assert.equal(livePos.length, 1, `${sc.botId} live cycle 1 must open 1 bot_positions row`);
      assert.ok(livePos[0].buy_reason, `${sc.botId} live position must persist buy_reason`);
      assert.ok(Number(livePos[0].buy_amount) >= 5000, `${sc.botId} live order must be >= 5,000 KRW`);

      // bot_06 live split sizing MUST match 15% (~14,992 KRW), NOT 45% (~44,977 KRW)!
      if (sc.botId === "bot_06") {
        assert.ok(Number(livePos[0].buy_amount) <= 16000, `bot_06 live Split 1 must use ~15% (~15,000원), NOT 45%, got ${livePos[0].buy_amount}`);
      }

      // Live cycle 2 immediately on identical tick: MUST hold (0 instant churn sells!)
      await runLiveTradingBotsCycle({
        skipUpbitApi: true,
        ignoreCooldown: true,
        mdMapOverride: mdMap,
        tickerMapOverride: tickerMap,
        rankMapOverride: rankMap,
      });
      const stillOpen = await db.prepare("SELECT * FROM bot_positions WHERE bot_id = ? AND status = 'OPEN'").all(sc.botId);
      assert.equal(stillOpen.length, 1, `${sc.botId} MUST NOT immediate-sell on cycle 2 in Live Mode`);
    }
    reportRows.push({ suite: "LiveCycle", bot: "bot_01~10", check: "All 10 Bots E2E Live Entry + Zero Churn + bot_06 15% Split", status: "PASS" });

    // 5-B. 일일 서킷 브레이커 (-4.0%) + AI BLOCK 하 오픈 포지션 청산 감시 검증
    await db.exec("DELETE FROM bot_positions; DELETE FROM trades;");
    await db.prepare("UPDATE bots SET is_selected_for_live = 0, is_running = 0, allocation_ratio = 0, allocated_capital = 0, virtual_krw = 0").run();
    await db.prepare("UPDATE bots SET is_selected_for_live = 1, is_running = 1, allocation_ratio = 100, allocated_capital = 100000, virtual_krw = 95500 WHERE bot_id = 'bot_10'").run();
    await db.prepare(`
      INSERT INTO trades (
        bot_id, market, buy_order_uuid, sell_order_uuid, buy_price, buy_volume, buy_amount, buy_date,
        sell_price, sell_volume, sell_amount, sell_date, profit_krw, profit_pct, status
      ) VALUES ('bot_10', 'KRW-SUI', 'cb-buy', 'cb-sell', 1000, '100', 100000, ?, 955, '100', 95500, ?, -4500, -4.5, 'COMPLETED')
    `).run(todaySameTradingKst, todaySameTradingKst);

    const mdMapCb = new Map([["KRW-SUI", packs.mdBot10]]);
    const tickerMapCb = new Map([["KRW-SUI", packs.mdBot10.ticker]]);
    await runLiveTradingBotsCycle({ skipUpbitApi: true, ignoreCooldown: true, mdMapOverride: mdMapCb, tickerMapOverride: tickerMapCb });
    const cbPos = await db.prepare("SELECT * FROM bot_positions WHERE bot_id = 'bot_10' AND status = 'OPEN'").all();
    assert.equal(cbPos.length, 0, "Circuit breaker (-4.5% daily loss <= -4.0%) must block new live buys");
    const cbBot = (await getBots("live")).find((b) => b.bot_id === "bot_10");
    assert.ok(String(cbBot.last_status_msg).includes("서킷 브레이커"), `Expected circuit breaker msg, got: ${cbBot.last_status_msg}`);

    // 5-C. 15분 재진입 쿨다운 검증 (서킷 브레이커 미발동 손익 +100원 매도 1분 전 -> 동일 종목 재매수 차단)
    await db.exec("DELETE FROM bot_positions; DELETE FROM trades;");
    await db.prepare("UPDATE bots SET is_selected_for_live = 0, is_running = 0, allocation_ratio = 0, allocated_capital = 0, virtual_krw = 0").run();
    await db.prepare("UPDATE bots SET is_selected_for_live = 1, is_running = 1, allocation_ratio = 100, allocated_capital = 100000, virtual_krw = 100000 WHERE bot_id = 'bot_05'").run();
    await db.prepare(`
      INSERT INTO trades (
        bot_id, market, buy_order_uuid, sell_order_uuid, buy_price, buy_volume, buy_amount, buy_date,
        sell_price, sell_volume, sell_amount, sell_date, profit_krw, profit_pct, status
      ) VALUES ('bot_05', 'KRW-DOGE', 'cd-buy', 'cd-sell', 950, '100', 95000, ?, 951, '100', 95100, ?, 100, 0.1, 'COMPLETED')
    `).run(todaySameTradingKst, todaySameTradingKst);
    const mdMapCd = new Map([["KRW-DOGE", packs.mdBot05]]);
    const tickerMapCd = new Map([["KRW-DOGE", packs.mdBot05.ticker]]);
    await runLiveTradingBotsCycle({ skipUpbitApi: true, mdMapOverride: mdMapCd, tickerMapOverride: tickerMapCd });
    const cdPos = await db.prepare("SELECT * FROM bot_positions WHERE bot_id = 'bot_05' AND status = 'OPEN'").all();
    assert.equal(cdPos.length, 0, "15-min reentry cooldown must prevent immediate rebuy on just-closed market");
    reportRows.push({ suite: "LiveGuards", bot: "bot_05/bot_10", check: "Daily -4% Circuit Breaker + 15m Cooldown", status: "PASS" });

    // 5-D. 실계좌 소액(53,000원 단일 봇 + AI 50% 비중) 실전 체결 & 5,000원 미만 손절 데드락 방어 버퍼 검증
    await db.exec("DELETE FROM bot_positions; DELETE FROM trades; DELETE FROM live_order_intents; DELETE FROM live_guardrail_events;");
    await db.prepare("UPDATE bots SET is_selected_for_live = 0, is_running = 0, allocation_ratio = 0, allocated_capital = 0, virtual_krw = 0").run();
    await db.prepare("UPDATE bots SET is_selected_for_live = 1, is_running = 1, allocation_ratio = 100, allocated_capital = 53000, virtual_krw = 53000 WHERE bot_id = 'bot_10'").run();
    await db.prepare(`
      INSERT OR REPLACE INTO market_regime_filter (
        id, sentiment_score, market_regime, risk_alert, recommended_action,
        position_size_multiplier, final_risk_alert, final_position_multiplier,
        final_bot_overrides_json, bot_overrides_json, blacklist_tickers_json
      ) VALUES (1, -0.3, 'BEAR', 0, 'REDUCE_SIZE', 0.5, 0, 0.5, '{}', '{}', '[]')
    `).run();
    const mdMapSmall = new Map([["KRW-SUI", packs.mdBot10]]);
    const tickerMapSmall = new Map([["KRW-SUI", packs.mdBot10.ticker]]);
    await runLiveTradingBotsCycle({ skipUpbitApi: true, ignoreCooldown: true, mdMapOverride: mdMapSmall, tickerMapOverride: tickerMapSmall });
    const smallPos = await db.prepare("SELECT * FROM bot_positions WHERE bot_id = 'bot_10' AND status = 'OPEN'").all();
    assert.equal(smallPos.length, 1, "53,000 KRW small live account with AI 50% must safely enter 1 position");
    const evalAfterStop = Number(smallPos[0].volume) * (Number(smallPos[0].avg_buy_price) * 0.975);
    assert.ok(evalAfterStop >= 5000, `Position value even after -2.5% stop loss (${Math.floor(evalAfterStop)}원) must stay >= 5,000 KRW Upbit floor`);
    reportRows.push({ suite: "SmallAccount", bot: "bot_10", check: "53,000 KRW + 50% AI -> Safe >=5,250 KRW Order (>5,000 on -2.5% SL)", status: "PASS" });

    // =========================================================================
    // [Suite 6] Gemini Pro/Flash 후보 모델 목록 Fallback 정합성 검증
    // =========================================================================
    const proModels = getDualAiCandidateModels(true, "gemini-3.1-pro-preview");
    const flashModels = getDualAiCandidateModels(false);
    assert.deepEqual(
      proModels.slice(0, 7),
      [
        "gemini-3.1-pro-preview",
        "gemini-pro-latest",
        "gemini-3.8-flash",
        "gemini-flash-latest",
        "gemini-3.5-flash",
        "gemini-3.5-flash-lite",
        "gemini-flash-lite-latest",
      ],
      "Pro candidate list must include 3.5 Flash/Lite working fallback models after Pro/3.8 tiers"
    );
    assert.equal(new Set(proModels).size, proModels.length, "Pro candidate models must not contain duplicates");
    assert.equal(flashModels[0], "gemini-3.8-flash");
    assert.ok(flashModels.includes("gemini-3.5-flash-lite"));
    const customPro = getDualAiCandidateModels(true, "gemini-custom-pro");
    assert.equal(customPro[0], "gemini-custom-pro");
    assert.equal(customPro.length, proModels.length + 1);
    reportRows.push({ suite: "GeminiFallback", bot: "ALL", check: "Pro Slot includes 3.5-flash/lite Fallback (No duplicates)", status: "PASS" });

    console.log("\n=== All 10 Bots Strategy, SmartExit, Order Sizing & E2E Execution Verification ===");
    console.table(reportRows);
  } finally {
    try {
      await db.close();
    } catch {}
    cleanupTestDbFiles();
  }
}

await runTests();
