/**
 * [Antigravity-Doc]
 * 파일 역할: 실전/모의 매매 체결 품질(Execution Quality) 분석 및 리스크 보정 유틸리티 모듈
 * 아키텍처:
 * - 업비트 호가창(상위 5호가)을 분석해 스프레드 과다 및 매도벽 불균형(OBI)에 따른 진입 차단 여부를 판단합니다.
 * - ATR(14) 변동성 비율에 따라 포지션 크기를 역가중(0.5x~1.0x) 축소하는 승수를 계산합니다.
 * - 예상가 대비 실제 체결가의 슬리피지를 베이시스 포인트(bps, 1% = 100bps) 단위로 산출합니다.
 * 주요 의존성: 외부 라이브러리 없는 순수 계산 모듈 (Pure ESM)
 * 수정 시 주의사항:
 * - `BREAKOUT_BOT_IDS` 목록은 매도벽 OBI 차단이 적용되는 돌파형 봇 집합이므로 봇 ID 체계 변경 시 함께 동기화해야 합니다.
 * - 호가창 데이터가 누락되었을 때는 매매 루프 전체가 멈추지 않도록 통과(`blocked: false`) 처리하도록 설계되어 있습니다.
 */
/**
 * backend/common/execution_quality_service.mjs
 *
 * 호가창 불균형(OBI) · 스프레드 가드 · ATR 변동성 역가중 포지션 사이징 · 슬리피지(bps) 분석 모듈
 * - 상위 5호가 기반 스프레드(spread_pct), 호가 불균형 지수(OBI = (bid - ask) / (bid + ask)), 예상 시장 충격(Market Impact bps) 산출
 * - 돌파형 봇(bot_01~04, 07, 09) 실전 매수 시 스프레드 > 0.35% 또는 매도벽 과다(OBI < -0.45) 진입 보류
 * - ATR 변동성 역가중 사이징: target_atr_pct(1.8%) 대비 고변동성 코인 비중을 0.5x~1.0x로 자동 조절 (최소 안전 주문 5,250원 보장)
 * - 슬리피지 원장 계산: slippage_bps = ((executed_price - expected_price) / expected_price) * 10000
 */

// [Antigravity-Doc] 매도벽 OBI(호가 불균형) 진입 차단이 기본 적용되는 돌파형 전략 봇 ID 집합
export const BREAKOUT_BOT_IDS = new Set(["bot_01", "bot_02", "bot_03", "bot_04", "bot_07", "bot_09"]);

/**
 * [Antigravity-Doc]
 * 역할: 업비트 호가창 스냅샷(상위 5호가)을 분석하여 스프레드, OBI, 예상 시장 충격(bps) 및 매수 진입 허용 여부를 판정합니다.
 * 매개변수:
 * - orderbook {object}: 업비트 호가 객체 (`orderbook_units` 배열 포함)
 * - orderKrw {number} [0]: 예상 매수 주문 금액(원화, KRW). 0 초과 시 상위 5호가 매도 잔량 소화 기준 시장 충격(bps) 계산
 * - options {object} [{}]:
 *   - botId {string}: 봇 식별자 (돌파형 봇 여부 판별용)
 *   - enforceObi {boolean}: OBI 차단 강제 활성화/비활성화 오버라이드
 *   - maxSpreadPct {number} [0.35]: 허용 최대 스프레드(%)
 *   - minObi {number} [-0.45]: 허용 최소 OBI (-1.0 ~ +1.0)
 * 반환값: {object} `{ ok, blocked, reason, spread_pct, obi, bid_size_5, ask_size_5, ask1, bid1, estimated_impact_bps, quality_grade }`
 * 부수효과/예외 처리: 호가 데이터가 비어 있거나 최우선 호가가 유효하지 않으면 예외를 던지지 않고 안전 통과(`ok: true, blocked: false`)를 반환합니다.
 */
export function analyzeOrderbookQuality(orderbook, orderKrw = 0, options = {}) {
  const botId = String(options.botId || "").trim();
  // [Antigravity-Doc] 옵션 우선순위에 따라 OBI 차단 적용 여부 결정 (명시적 true > 명시적 false 제외 후 돌파형 봇 또는 일반 검사)
  // 돌파형 봇(bot_01~04, 07, 09) 또는 명시적 enforceObi=true (또는 botId 미지정 일반 검사)일 때만 매도벽 OBI 차단 적용
  // 역추세·그리드·눌림목 봇(bot_05, 06, 08, 10)은 과매도 하락 구간 반등 진입 특성상 매도벽 OBI로 차단하지 않음(스프레드 가드는 유지)
  const enforceObi =
    options.enforceObi === true ||
    (options.enforceObi !== false && (BREAKOUT_BOT_IDS.has(botId) || !botId));
  // [Antigravity-Doc] 스프레드 상한(기본 0.35%) 및 OBI 하한(기본 -0.45) 임계값 정규화
  const maxSpreadPct = Number(options.maxSpreadPct ?? 0.35);
  const minObi = Number(options.minObi ?? -0.45);

  // [Antigravity-Doc] 상위 5개 호가 단계만 추출 (유동성 평가 범위 고정)
  const units = Array.isArray(orderbook?.orderbook_units)
    ? orderbook.orderbook_units.slice(0, 5)
    : [];

  // [Antigravity-Doc] 호가 배열 부재 시 보수적 페일오픈(통과) 반환
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

  // [Antigravity-Doc] 최우선 매도1호가(ask1)와 매수1호가(bid1) 유효성 검증
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

  // [Antigravity-Doc] 최우선 매수호가 대비 스프레드 백분율(%) 계산 (소수 4자리 반올림)
  const spreadPct = Number((((ask1 - bid1) / bid1) * 100).toFixed(4));

  // [Antigravity-Doc] 상위 5호가 매수/매도 잔량 합산 (음수 방어)
  let bidSize5 = 0;
  let askSize5 = 0;
  for (const u of units) {
    bidSize5 += Math.max(0, Number(u.bid_size || 0));
    askSize5 += Math.max(0, Number(u.ask_size || 0));
  }

  // [Antigravity-Doc] 호가 불균형 지수 OBI = (매수잔량 - 매도잔량) / 전체잔량 (-1: 매도벽 극심 ~ +1: 매수벽 극심)
  const totalSize5 = bidSize5 + askSize5;
  const obi = totalSize5 > 0 ? Number(((bidSize5 - askSize5) / totalSize5).toFixed(4)) : 0;

  // [Antigravity-Doc] 시장가 매수 시 상위 5호가 매도 잔량을 순차 체결했을 때의 VWAP 대비 예상 시장 충격(bps) 시뮬레이션
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
    // [Antigravity-Doc] 상위 5호가 잔량만으로 주문 금액을 모두 채우지 못하면 5호가 대비 +0.2% 페널티 가격으로 잔여 금액 추정
    if (remKrw > 0) {
      const lastAsk = Number(units[units.length - 1]?.ask_price || ask1) * 1.002;
      spentKrw += remKrw;
      totalVol += remKrw / lastAsk;
    }
    // [Antigravity-Doc] 평균 체결 예상가(VWAP)와 최우선 매도1호가(ask1)의 괴리를 bps로 환산
    const vwapExec = totalVol > 0 ? spentKrw / totalVol : ask1;
    estimatedImpactBps = Number((((vwapExec - ask1) / ask1) * 10000).toFixed(2));
  }

  // [Antigravity-Doc] 1차 가드: 스프레드 과다 시 모든 봇 공통으로 진입 차단
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

  // [Antigravity-Doc] 2차 가드: OBI 차단이 활성화된 경우 상단 매도벽 과다 시 진입 차단
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

  // [Antigravity-Doc] 통과한 호가창의 품질 등급 분류 (EXCELLENT / GOOD / NORMAL)
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

/**
 * [Antigravity-Doc]
 * 역할: 14기간 ATR과 현재가를 이용해 변동성 비율(ATR%)을 계산하고, 목표 변동성 대비 역가중 포지션 사이징 승수를 반환합니다.
 * 매개변수:
 * - params {object} [{}]:
 *   - atr14 {number} [0]: 14기간 평균 진폭(ATR)
 *   - currentPrice {number} [0]: 현재 시세(원)
 *   - targetAtrPct {number} [1.8]: 기준 목표 변동성(%)
 *   - minMult {number} [0.5]: 최소 축소 배수
 *   - maxMult {number} [1.0]: 최대 허용 배수
 * 반환값: {{atr_pct: number, multiplier: number, atr_sizing_mult: number}} 변동성(%) 및 클램핑된 포지션 배수(호환용 별칭 포함)
 * 부수효과/예외 처리: 입력값이 NaN/무한대/0 이하이면 보정 없이 기본 배수 `1.0`을 반환합니다.
 */
export function computeAtrVolatilityMultiplier({
  atr14 = 0,
  currentPrice = 0,
  targetAtrPct = 1.8,
  minMult = 0.5,
  maxMult = 1.0,
} = {}) {
  const atr = Number(atr14 || 0);
  const price = Number(currentPrice || 0);
  // [Antigravity-Doc] 비정상 수치 방어: ATR 또는 현재가가 유효하지 않으면 사이징 축소 미적용(1.0배)
  if (!Number.isFinite(atr) || !Number.isFinite(price) || atr <= 0 || price <= 0) {
    return { atr_pct: 0, multiplier: 1.0, atr_sizing_mult: 1.0 };
  }
  const atrPct = (atr / price) * 100;
  if (!Number.isFinite(atrPct) || atrPct <= 0) {
    return { atr_pct: 0, multiplier: 1.0, atr_sizing_mult: 1.0 };
  }
  // [Antigravity-Doc] 분모 하한을 0.5%로 제한해 초저변동성 코인에서의 과도한 배수 폭주를 방지하고 [minMult, maxMult]로 클램핑
  const rawMult = Number(targetAtrPct || 1.8) / Math.max(0.5, atrPct);
  const clamped = Math.max(Number(minMult ?? 0.5), Math.min(Number(maxMult ?? 1.0), rawMult));
  const roundedMult = Number(clamped.toFixed(4));
  return {
    atr_pct: Number(atrPct.toFixed(3)),
    multiplier: roundedMult,
    atr_sizing_mult: roundedMult,
  };
}

/**
 * [Antigravity-Doc]
 * 역할: 예상 주문 단가 대비 실제 체결 단가의 슬리피지를 bps(1/100%) 단위로 계산합니다.
 * 매개변수:
 * - expectedPrice {number}: 주문 시점 예상/기준 가격
 * - executedPrice {number}: 실제 체결 평균 가격
 * 반환값: {number} 슬리피지(bps, 소수 2자리). 양수(+)는 기준가보다 비싸게 체결(매수 시 불리), 음수(-)는 유리 체결.
 * 부수효과/예외 처리: 입력이 유효한 양수가 아니거나 계산 결과가 유한하지 않으면 `0`을 반환합니다.
 */
export function computeSlippageBps(expectedPrice, executedPrice) {
  const exp = Number(expectedPrice || 0);
  const exec = Number(executedPrice || 0);
  // [Antigravity-Doc] 0 나누기 및 비정상 숫자 방어
  if (!Number.isFinite(exp) || !Number.isFinite(exec) || exp <= 0 || exec <= 0) {
    return 0;
  }
  const bps = ((exec - exp) / exp) * 10000;
  return Number.isFinite(bps) ? Number(bps.toFixed(2)) : 0;
}