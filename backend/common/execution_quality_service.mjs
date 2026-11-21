/**
 * backend/common/execution_quality_service.mjs
 *
 * 호가창 불균형(OBI) · 스프레드 가드 · ATR 변동성 역가중 포지션 사이징 · 슬리피지(bps) 분석 모듈
 * - 상위 5호가 기반 스프레드(spread_pct), 호가 불균형 지수(OBI = (bid - ask) / (bid + ask)), 예상 시장 충격(Market Impact bps) 산출
 * - 돌파형 봇(bot_01~04, 07, 09) 실전 매수 시 스프레드 > 0.35% 또는 매도벽 과다(OBI < -0.45) 진입 보류
 * - ATR 변동성 역가중 사이징: target_atr_pct(1.8%) 대비 고변동성 코인 비중을 0.5x~1.0x로 자동 조절 (최소 안전 주문 5,250원 보장)
 * - 슬리피지 원장 계산: slippage_bps = ((executed_price - expected_price) / expected_price) * 10000
 */

export const BREAKOUT_BOT_IDS = new Set(["bot_01", "bot_02", "bot_03", "bot_04", "bot_07", "bot_09"]);

export function analyzeOrderbookQuality(orderbook, orderKrw = 0, options = {}) {
  const botId = String(options.botId || "").trim();
  // 돌파형 봇(bot_01~04, 07, 09) 또는 명시적 enforceObi=true (또는 botId 미지정 일반 검사)일 때만 매도벽 OBI 차단 적용
  // 역추세·그리드·눌림목 봇(bot_05, 06, 08, 10)은 과매도 하락 구간 반등 진입 특성상 매도벽 OBI로 차단하지 않음(스프레드 가드는 유지)
  const enforceObi =
    options.enforceObi === true ||
    (options.enforceObi !== false && (BREAKOUT_BOT_IDS.has(botId) || !botId));
  const maxSpreadPct = Number(options.maxSpreadPct ?? 0.35);
  const minObi = Number(options.minObi ?? -0.45);

  const units = Array.isArray(orderbook?.orderbook_units)
    ? orderbook.orderbook_units.slice(0, 5)
    : [];

  if (units.length === 0) {
    return {
      ok: true,
      blocked: false,
      reason: "NO_ORDERBOOK_DATA_PASS",
      spread_pct: 0,
      obi: 0,
      bid_size_5: 0,
      ask_size_5: 0,
      ask1: 0,
      bid1: 0,
      estimated_impact_bps: 0,
      quality_grade: "NORMAL",
    };
  }

  const ask1 = Number(units[0]?.ask_price || 0);
  const bid1 = Number(units[0]?.bid_price || 0);
  if (!(ask1 > 0) || !(bid1 > 0)) {
    return {
      ok: true,
      blocked: false,
      reason: "INVALID_TOP_QUOTE_PASS",
      spread_pct: 0,
      obi: 0,
      bid_size_5: 0,
      ask_size_5: 0,
      ask1,
      bid1,
      estimated_impact_bps: 0,
      quality_grade: "NORMAL",
    };
  }

  const spreadPct = Number((((ask1 - bid1) / bid1) * 100).toFixed(4));

  let bidSize5 = 0;
  let askSize5 = 0;
  for (const u of units) {
    bidSize5 += Math.max(0, Number(u.bid_size || 0));
    askSize5 += Math.max(0, Number(u.ask_size || 0));
  }

  const totalSize5 = bidSize5 + askSize5;
  const obi = totalSize5 > 0 ? Number(((bidSize5 - askSize5) / totalSize5).toFixed(4)) : 0;

  // 주문 금액(orderKrw) 기준 상위 5호가 매도벽 소화 시 예상 시장 충격(Market Impact bps)
  let estimatedImpactBps = 0;
  const targetKrw = Math.max(0, Number(orderKrw || 0));
  if (targetKrw > 0 && ask1 > 0) {
    let remKrw = targetKrw;
    let totalVol = 0;
    let spentKrw = 0;
    for (const u of units) {
      const p = Number(u.ask_price || 0);
      const s = Number(u.ask_size || 0);
      if (!(p > 0) || !(s > 0)) continue;
      const levelKrw = p * s;
      const takeKrw = Math.min(remKrw, levelKrw);
      spentKrw += takeKrw;
      totalVol += takeKrw / p;
      remKrw -= takeKrw;
      if (remKrw <= 0) break;
    }
    if (remKrw > 0) {
      const lastAsk = Number(units[units.length - 1]?.ask_price || ask1) * 1.002;
      spentKrw += remKrw;
      totalVol += remKrw / lastAsk;
    }
    const vwapExec = totalVol > 0 ? spentKrw / totalVol : ask1;
    estimatedImpactBps = Number((((vwapExec - ask1) / ask1) * 10000).toFixed(2));
  }

  if (spreadPct > maxSpreadPct) {
    return {
      ok: false,
      blocked: true,
      reason: `호가 스프레드 과다 차단 (${spreadPct.toFixed(2)}% > 허용 ${maxSpreadPct.toFixed(2)}%)`,
      spread_pct: spreadPct,
      obi,
      bid_size_5: Number(bidSize5.toFixed(4)),
      ask_size_5: Number(askSize5.toFixed(4)),
      ask1,
      bid1,
      estimated_impact_bps: estimatedImpactBps,
      quality_grade: "POOR_SPREAD",
    };
  }

  if (enforceObi && obi < minObi) {
    return {
      ok: false,
      blocked: true,
      reason: `상단 매도벽 불균형 차단 (OBI ${obi.toFixed(2)} < 허용 ${minObi.toFixed(2)})`,
      spread_pct: spreadPct,
      obi,
      bid_size_5: Number(bidSize5.toFixed(4)),
      ask_size_5: Number(askSize5.toFixed(4)),
      ask1,
      bid1,
      estimated_impact_bps: estimatedImpactBps,
      quality_grade: "HEAVY_ASK_WALL",
    };
  }

  const qualityGrade =
    spreadPct <= 0.12 && obi >= 0.1
      ? "EXCELLENT"
      : spreadPct <= 0.25 && obi >= -0.2
      ? "GOOD"
      : "NORMAL";

  return {
    ok: true,
    blocked: false,
    reason: "OK",
    spread_pct: spreadPct,
    obi,
    bid_size_5: Number(bidSize5.toFixed(4)),
    ask_size_5: Number(askSize5.toFixed(4)),
    ask1,
    bid1,
    estimated_impact_bps: estimatedImpactBps,
    quality_grade: qualityGrade,
  };
}

export function computeAtrVolatilityMultiplier({
  atr14 = 0,
  currentPrice = 0,
  targetAtrPct = 1.8,
  minMult = 0.5,
  maxMult = 1.0,
} = {}) {
  const atr = Number(atr14 || 0);
  const price = Number(currentPrice || 0);
  if (!Number.isFinite(atr) || !Number.isFinite(price) || atr <= 0 || price <= 0) {
    return { atr_pct: 0, multiplier: 1.0, atr_sizing_mult: 1.0 };
  }
  const atrPct = (atr / price) * 100;
  if (!Number.isFinite(atrPct) || atrPct <= 0) {
    return { atr_pct: 0, multiplier: 1.0, atr_sizing_mult: 1.0 };
  }
  const rawMult = Number(targetAtrPct || 1.8) / Math.max(0.5, atrPct);
  const clamped = Math.max(Number(minMult ?? 0.5), Math.min(Number(maxMult ?? 1.0), rawMult));
  const roundedMult = Number(clamped.toFixed(4));
  return {
    atr_pct: Number(atrPct.toFixed(3)),
    multiplier: roundedMult,
    atr_sizing_mult: roundedMult,
  };
}

export function computeSlippageBps(expectedPrice, executedPrice) {
  const exp = Number(expectedPrice || 0);
  const exec = Number(executedPrice || 0);
  if (!Number.isFinite(exp) || !Number.isFinite(exec) || exp <= 0 || exec <= 0) {
    return 0;
  }
  const bps = ((exec - exp) / exp) * 10000;
  return Number.isFinite(bps) ? Number(bps.toFixed(2)) : 0;
}
