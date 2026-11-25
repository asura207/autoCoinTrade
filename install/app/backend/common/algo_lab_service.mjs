/**
 * [Antigravity-Doc] backend/common/algo_lab_service.mjs
 *
 * [파일 역할 및 아키텍처]
 * - 업비트 10대 순수 알고리즘 봇(`bot_01` ~ `bot_10`)의 핵심 엔진이자 상시 가상 경쟁(Arena) 및 주간 로테이션 계산기.
 * - 주요 구성 섹션:
 *   1) 기술적 지표 유틸리티: SMA, Wilder RSI, EMA, MACD, Bollinger Band/Bandwidth, Wilder ATR, SuperTrend, OLS 20봉 선형회귀 채널(LRC ±2σ), Jack Kellogg 4대 지표(VWAP/LRC/RVOL/기준선).
 *   2) 통합 지표 빌더(`buildIndicators`), 윗꼬리/과열 추격매수 차단 필터(`checkUpperWickAndOverextension`), 3단계 스마트 청산(`evaluateSmartExit`).
 *   3) 10대 봇 마스터 메타(`ARENA_BOT_DEFS`), 3대 전략군(추세·스윙 / 변동성·돌파 / 역추세·그리드),
 *      총 평가자산 기준 단일 90% 상한(Single 90% Cap) · 1~3개 차등 균등 배분 · Draining 자금 차감/복원 불변식 엔진.
 *   4) 10대 순수 알고리즘 전략 함수(`STRATEGIES`, `evaluateStrategy`) — LLM/시황 필터를 참조하지 않는 순수 수식·지표 기반.
 *   5) 캔들 TTL 공유 캐시(`buildMarketData`), 가상 체결(`paperBuy`/`paperSell`/`runPaperBot`), 리더보드/주간 챔피언 선출(`evaluateWeeklyStrategyChampions`), 상시 경쟁 사이클(`runArenaCycle`).
 *
 * [주요 의존성]
 * - `./execution_quality_service.mjs`: `analyzeOrderbookQuality` (가상 매수 진입 전 호가 스프레드·깊이 품질 가드).
 * - SQLite/PG 호환 DB 어댑터: `bots`, `paper_trades`, `paper_bot_positions`, `market_regime_filter`, `system_settings`.
 *
 * [수정 시 주의사항]
 * - `evaluateStrategy()`는 실전(`server.mjs`), 가상(`runArenaCycle`), 백테스트(`backtest_service.mjs`) 3곳이 공유하므로
 *   시그니처 변경이나 부작용(전역 상태 변경) 추가를 절대 금지할 것.
 * - 단일 90% 상한(`assertGlobal90CapInvariant`)은 `totalEquityKrw * maxDeployRatio`를 단 1회만 적용해야 하며,
 *   이중 적용(0.9 × 0.9 = 81%)이나 Draining 봇의 `virtual_krw > 0` 유출이 발생하지 않도록 유지할 것.
 */

import { analyzeOrderbookQuality } from "./execution_quality_service.mjs";

// [Antigravity-Doc] 가상거래(Arena) 및 백테스트 공통 기준 상수 (업비트 원화마켓 수수료 0.05%, 최소주문 5,000원, 봇당 초기 시드 100만 원)
export const PAPER_FEE_RATE = 0.0005;
export const PAPER_MIN_ORDER_KRW = 5000;
export const DEFAULT_PAPER_CAPITAL = 1000000;

/**
 * [Antigravity-Doc] Date 또는 타임스탬프를 Asia/Seoul(KST) `YYYY-MM-DD HH:MM:SS` 문자열로 포맷팅
 */
export function formatKstDateTime(dateInput = new Date()) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}

/**
 * [Antigravity-Doc] 현재 시각의 KST 문자열(`YYYY-MM-DD HH:MM:SS`) 반환
 */
export function nowKSTString() {
  return formatKstDateTime(new Date());
}

/**
 * [Antigravity-Doc] 업비트 일봉 리셋 기준(09:00 KST) 거래일 문자열(`YYYY-MM-DD`) 산출
 * - 00:00~08:59 KST는 전일 거래일로 귀속되어 `bot_01` 익일 시가 청산 및 당일 VWAP 집계 기준일로 사용된다.
 */
export function tradingDateKST(dateStr) {
  const base = String(dateStr || nowKSTString()).replace("T", " ").slice(0, 19);
  const ms = Date.parse(`${base.replace(" ", "T")}Z`);
  if (Number.isNaN(ms)) return base.slice(0, 10);
  return new Date(ms - 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// ============================================================================
// 1. 기술적 지표 유틸리티
// ============================================================================
/** [Antigravity-Doc] 단순 이동평균(SMA): 최근 period개 값의 산술 평균 (부족 시 null) */
export function computeSma(values, period) {
  if (!values || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

/** [Antigravity-Doc] Wilder 평활법 기반 RSI 시계열 계산 (초반 period 구간은 null, 하락폭 0이면 100) */
export function computeRsiSeries(closes, period = 14) {
  const out = new Array(closes ? closes.length : 0).fill(null);
  if (!closes || closes.length < period + 1) return out;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += -diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  const calc = () => (avgGain === 0 && avgLoss === 0 ? 50.0 : avgLoss === 0 ? 100.0 : 100.0 - 100.0 / (1.0 + avgGain / avgLoss));
  out[period] = calc();
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = calc();
  }
  return out;
}

/** [Antigravity-Doc] 최신 시점 Wilder RSI 단일값 반환 (데이터 부족 시 중립값 50.0) */
export function computeRsi(closes, period = 14) {
  const series = computeRsiSeries(closes, period);
  const last = series[series.length - 1];
  return last === null || last === undefined ? 50.0 : last;
}

/** [Antigravity-Doc] 지수 이동평균(EMA) 전체 시계열 계산 (평활 계수 k = 2 / (period + 1)) */
export function computeEma(values, period) {
  if (!values || values.length === 0) return [];
  const k = 2 / (period + 1);
  const emaArr = [values[0]];
  for (let i = 1; i < values.length; i++) {
    emaArr.push(values[i] * k + emaArr[i - 1] * (1 - k));
  }
  return emaArr;
}

/** [Antigravity-Doc] MACD(fast EMA - slow EMA) 및 Signal(MACD의 signal EMA) 시계열 계산 (`bot_07` 용) */
export function computeMacdSeries(closes, fast = 12, slow = 26, signal = 9) {
  if (!closes || closes.length < slow + signal) return null;
  const fastEma = computeEma(closes, fast);
  const slowEma = computeEma(closes, slow);
  const macd = closes.map((_, i) => fastEma[i] - slowEma[i]);
  const sig = computeEma(macd, signal);
  return { macd, signal: sig };
}

export function computeMacd(closes, fast = 12, slow = 26, signal = 9) {
  const s = computeMacdSeries(closes, fast, slow, signal);
  if (!s) return { macd: 0, signal: 0, hist: 0, isCrossUp: false, isCrossDown: false };
  const n = s.macd.length;
  const cm = s.macd[n - 1];
  const pm = s.macd[n - 2];
  const cs = s.signal[n - 1];
  const ps = s.signal[n - 2];
  return {
    macd: cm,
    signal: cs,
    hist: cm - cs,
    isCrossUp: pm <= ps && cm > cs,
    isCrossDown: pm >= ps && cm < cs,
  };
}

/** [Antigravity-Doc] 볼린저 밴드(모집단 표준편차 σ, 상/중/하단선 및 밴드폭 Bandwidth) 계산 (`bot_04`/`bot_05`/`bot_06` 용) */
export function computeBollinger(closes, period = 20, numStd = 2.0) {
  if (!closes || closes.length < period) return null;
  const win = closes.slice(-period);
  const mid = win.reduce((a, b) => a + b, 0) / period;
  const variance = win.reduce((a, b) => a + (b - mid) * (b - mid), 0) / period;
  const std = Math.sqrt(variance);
  const upper = mid + numStd * std;
  const lower = mid - numStd * std;
  return { mid, upper, lower, std, bandwidth: mid > 0 ? (upper - lower) / mid : 0 };
}

/** [Antigravity-Doc] 볼린저 밴드폭(Bandwidth = (Upper - Lower) / Mid) 시계열 계산 (`bot_04` 스퀴즈 응축 판별용) */
export function computeBandwidthSeries(closes, period = 20, numStd = 2.0) {
  const out = [];
  for (let i = period; i <= closes.length; i++) {
    const bb = computeBollinger(closes.slice(i - period, i), period, numStd);
    out.push(bb ? bb.bandwidth : null);
  }
  return out;
}

/** [Antigravity-Doc] Wilder ATR(Average True Range) 시계열 계산 — True Range = max(H-L, |H-prevC|, |L-prevC|) */
export function computeAtrSeries(candles, period = 14) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n < period + 1) return out;
  const trs = [null];
  for (let i = 1; i < n; i++) {
    const h = Number(candles[i].high_price);
    const l = Number(candles[i].low_price);
    const pc = Number(candles[i - 1].trade_price);
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += trs[i];
  atr /= period;
  out[period] = atr;
  for (let i = period + 1; i < n; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    out[i] = atr;
  }
  return out;
}

/**
 * [Antigravity-Doc] ATR 기반 SuperTrend 추세 지표 계산 (`bot_02` 및 MTF 필터 공용)
 * - `dir`: +1(상승 추세, 지지선=finalLower) / -1(하락 추세, 저항선=finalUpper)
 * - `flipUpBarsAgo`: 최근 6봉 이내 하락(-1)→상승(+1) 전환이 몇 봉 전에 발생했는지 반환
 */
export function computeSuperTrend(candles, period = 10, multiplier = 3.0) {
  const n = candles.length;
  const atr = computeAtrSeries(candles, period);
  const dir = new Array(n).fill(1);
  const line = new Array(n).fill(null);
  let finalUpper = null;
  let finalLower = null;
  for (let i = 0; i < n; i++) {
    if (atr[i] === null) continue;
    const hl2 = (Number(candles[i].high_price) + Number(candles[i].low_price)) / 2;
    const basicUpper = hl2 + multiplier * atr[i];
    const basicLower = hl2 - multiplier * atr[i];
    const prevClose = i > 0 ? Number(candles[i - 1].trade_price) : Number(candles[i].trade_price);
    const close = Number(candles[i].trade_price);
    const prevUpper = finalUpper;
    const prevLower = finalLower;
    finalUpper = prevUpper === null || basicUpper < prevUpper || prevClose > prevUpper ? basicUpper : prevUpper;
    finalLower = prevLower === null || basicLower > prevLower || prevClose < prevLower ? basicLower : prevLower;
    let d = i > 0 ? dir[i - 1] : 1;
    if (prevUpper !== null && close > prevUpper) d = 1;
    else if (prevLower !== null && close < prevLower) d = -1;
    dir[i] = d;
    line[i] = d === 1 ? finalLower : finalUpper;
  }
  let flipUpBarsAgo = null;
  for (let back = 0; back < Math.min(n - 1, 6); back++) {
    const i = n - 1 - back;
    if (dir[i] === 1 && dir[i - 1] === -1) {
      flipUpBarsAgo = back;
      break;
    }
  }
  return { dir, line, atr, flipUpBarsAgo, isUp: dir[n - 1] === 1, lastLine: line[n - 1] };
}

function candleVolumes(candles) {
  return candles.map((c) => Number(c.candle_acc_trade_volume || 0));
}

/** 마지막 N개를 제외한 직전 window 봉의 평균 거래량 */
function avgVolume(candles, excludeLast, window = 20) {
  const vols = candleVolumes(candles);
  const end = vols.length - excludeLast;
  const start = Math.max(0, end - window);
  const slice = vols.slice(start, end);
  if (slice.length === 0) return 0;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function candleKstKey(c) {
  return String(c?.candle_date_time_kst || "").replace("T", " ").slice(0, 19);
}

/**
 * [Antigravity-Doc] 20봉 선형 회귀 채널 (Linear Regression Channel, OLS 최소자승법)
 * - 최근 `period`(기본 20)개 종가에 대해 기울기 `slope`, 절편 `intercept`, 현재 중심 추정가 `mid(ŷ_{n-1})`,
 *   잔차 표준편차 `sigma` 기반 상단(+2σ)·하단(-2σ) 채널을 산출한다 (`bot_10` 및 차트 오버레이 공용).
 */
export function computeLinearRegressionChannel(closes, period = 20) {
  if (!closes || closes.length < period) return null;
  const win = closes.slice(-period);
  const n = period;
  const xMean = (n - 1) / 2.0; // 9.5 for n=20
  let ySum = 0;
  for (let i = 0; i < n; i++) ySum += win[i];
  const yMean = ySum / n;

  let numerator = 0;
  let denominator = 0; // (n * (n^2 - 1)) / 12 = 665 for n=20
  for (let i = 0; i < n; i++) {
    const xDiff = i - xMean;
    numerator += xDiff * win[i];
    denominator += xDiff * xDiff;
  }
  const slope = denominator !== 0 ? numerator / denominator : 0;
  const intercept = yMean - slope * xMean;
  const mid = slope * (n - 1) + intercept; // ŷ_(n-1)

  let sumSqErr = 0;
  for (let i = 0; i < n; i++) {
    const fitted = slope * i + intercept;
    const err = win[i] - fitted;
    sumSqErr += err * err;
  }
  const sigma = Math.sqrt(Math.max(0, sumSqErr / n));
  const upper = mid + 2.0 * sigma;
  const lower = mid - 2.0 * sigma;

  return {
    slope,
    intercept,
    mid,
    upper,
    lower,
    sigma,
  };
}

/**
 * [Antigravity-Doc] 잭 켈로그(Jack Kellogg) 4대 핵심 프라이스액션 지표 패키지 (`bot_10` 전용)
 * ① 당일(09:00 KST 이후) 및 롤링 24시간(96봉) VWAP(TP=(H+L+C)/3)과 현재가 이격도(%)
 * ② 20봉 선형 회귀 채널(LRC ±2σ)
 * ③ 상대 거래량 배수(RVOL): 진행 봉과 직전 마감 봉의 20봉 평균 분모를 각각 분리해 자기희석을 방지
 * ④ 4대 기준 가격선(당일 시가, 전일 종가/고가/저가) 및 최근 20봉 고저가
 */
export function calculateKelloggIndicators(m15Candles, dayCandles, currentPrice) {
  if (!m15Candles || m15Candles.length < 20) return null;
  const price = Number(currentPrice || m15Candles[m15Candles.length - 1]?.trade_price || 0);

  // 1. 기준 가격선 (당일 시가, 전일 종가, 전일 고가, 전일 저가)
  let today_open = 0;
  let prev_close = 0;
  let prev_high = 0;
  let prev_low = 0;
  if (Array.isArray(dayCandles) && dayCandles.length > 0) {
    const curDay = dayCandles[dayCandles.length - 1];
    today_open = Number(curDay.opening_price || 0);
    if (dayCandles.length >= 2) {
      const prevDay = dayCandles[dayCandles.length - 2];
      prev_close = Number(prevDay.trade_price || curDay.prev_closing_price || today_open);
      prev_high = Number(prevDay.high_price || today_open);
      prev_low = Number(prevDay.low_price || today_open);
    } else {
      prev_close = Number(curDay.prev_closing_price || today_open);
      prev_high = Number(curDay.high_price || today_open);
      prev_low = Number(curDay.low_price || today_open);
    }
  }

  // 2. 당일(09:00 KST) 및 롤링 24시간 VWAP (TP = (H+L+C)/3)
  const tradingDate = tradingDateKST(nowKSTString());
  const dayStartKey = `${tradingDate} 09:00:00`;
  let dayVwapSum = 0;
  let dayVolSum = 0;
  let rollVwapSum = 0;
  let rollVolSum = 0;
  const rollCandles = m15Candles.slice(-96);

  for (const c of rollCandles) {
    const h = Number(c.high_price || 0);
    const l = Number(c.low_price || 0);
    const cl = Number(c.trade_price || 0);
    const v = Number(c.candle_acc_trade_volume || 0);
    const tp = (h + l + cl) / 3.0;
    rollVwapSum += tp * v;
    rollVolSum += v;
    if (candleKstKey(c) >= dayStartKey) {
      dayVwapSum += tp * v;
      dayVolSum += v;
    }
  }

  const vwap = (dayVolSum > 0 && dayVwapSum > 0)
    ? (dayVwapSum / dayVolSum)
    : (rollVolSum > 0 ? rollVwapSum / rollVolSum : price);
  const vwap_disparity_pct = vwap > 0 ? ((price - vwap) / vwap) * 100.0 : 0;

  // 3. 20봉 선형 회귀 채널 (LRC)
  const closes = m15Candles.map((c) => Number(c.trade_price));
  const lrc = computeLinearRegressionChannel(closes, 20);

  // 4. 상대 거래량 (RVOL) — 직전 완료 캔들 기준과 진행 중 캔들 기준 분모 분리 (자기희석 및 0거래량 Time-Stop 차단 방지)
  const n = m15Candles.length;
  const cur = m15Candles[n - 1];
  const closed = m15Candles[n - 2] || cur;
  const avg20ForCur = avgVolume(m15Candles, 1, 20);
  const avg20ForClosed = avgVolume(m15Candles, 2, 20) || avg20ForCur;
  const curVol = Number(cur.candle_acc_trade_volume || 0);
  const closedVol = Number(closed.candle_acc_trade_volume || 0);
  const curRvol = avg20ForCur > 0 ? curVol / avg20ForCur : 0.0;
  const closedRvol = avg20ForClosed > 0 ? closedVol / avg20ForClosed : 0.0;
  const rvol = Math.max(curRvol, closedRvol);
  const avg20 = avg20ForCur;

  // 최근 20봉 최고가/최저가
  const win20 = m15Candles.slice(-20);
  const recent_high_20 = Math.max(...win20.map((c) => Number(c.high_price || 0)));
  const recent_low_20 = Math.min(...win20.map((c) => Number(c.low_price || 0)));

  return {
    today_open,
    prev_close,
    prev_high,
    prev_low,
    vwap,
    vwap_disparity_pct,
    lrc,
    rvol,
    curRvol,
    closedRvol,
    avg_volume_20: avg20,
    recent_high_20,
    recent_low_20,
    cur,
    closed,
    curBullish: Number(cur.trade_price) > Number(cur.opening_price),
    closedBullish: Number(closed.trade_price) > Number(closed.opening_price),
  };
}

// ============================================================================
// 2. 지표 패키지 빌더 (한 번 계산해 10개 봇이 공유)
// ============================================================================
/**
 * [Antigravity-Doc] 종목별 통합 지표 패키지 빌더 — 4개 타임프레임(day/m240/m60/m15)을 1회 계산해 10개 봇이 공유
 * - 일봉(MA5/20/60, 7일 모멘텀, 20일 고가), 4시간봉(MA, SuperTrend, 거래량 배수), 1시간봉(EMA20/60, ATR14, SuperTrend),
 *   15분봉(RSI14, BB, 밴드폭, EMA, ATR14, MACD, 당일 VWAP, Kellogg 4대 지표) 및 MTF 상위 추세 합의(`ind.mtf`)를 산출한다.
 */
export function buildIndicators(marketData) {
  const price = Number(marketData?.price || 0);
  const day = marketData?.candles?.day || [];
  const m240 = marketData?.candles?.m240 || [];
  const m60 = marketData?.candles?.m60 || [];
  const m15 = marketData?.candles?.m15 || [];
  const ind = { price, day: null, m240: null, m60: null, m15: null };

  if (day.length >= 3) {
    const closes = day.map((c) => Number(c.trade_price));
    const cur = day[day.length - 1];
    const prev = day[day.length - 2];
    const base7 = day.length >= 8 ? Number(day[day.length - 8].trade_price) : null;
    ind.day = {
      closes,
      todayOpen: Number(cur.opening_price),
      prevHigh: Number(prev.high_price),
      prevLow: Number(prev.low_price),
      ma5: computeSma(closes, 5),
      ma20: computeSma(closes, 20),
      ma60: computeSma(closes, 60),
      momentum7dPct: base7 && base7 > 0 && price > 0 ? ((price - base7) / base7) * 100 : null,
      recentHigh20: Math.max(...day.slice(-21, -1).map((c) => Number(c.high_price))),
    };
  }

  if (m240.length >= 20) {
    const closes = m240.map((c) => Number(c.trade_price));
    const lastClosedVol = Number(m240[m240.length - 2]?.candle_acc_trade_volume || 0);
    const avg20 = avgVolume(m240, 2, 20);
    ind.m240 = {
      closes,
      ma5: computeSma(closes, 5),
      ma20: computeSma(closes, 20),
      ma60: computeSma(closes, 60),
      supertrend: m240.length >= 30 ? computeSuperTrend(m240, 10, 3.0) : null,
      volRatio: avg20 > 0 ? Math.max(lastClosedVol, Number(m240[m240.length - 1].candle_acc_trade_volume || 0)) / avg20 : 0,
      lastClosedVolRatio: avg20 > 0 ? lastClosedVol / avg20 : 0,
    };
  }

  if (m60.length >= 30) {
    const closes = m60.map((c) => Number(c.trade_price));
    const ema20 = computeEma(closes, 20);
    const ema60 = computeEma(closes, 60);
    const atr14 = computeAtrSeries(m60, 14);
    const lastClosedVol = Number(m60[m60.length - 2]?.candle_acc_trade_volume || 0);
    const avg20 = avgVolume(m60, 2, 20);
    ind.m60 = {
      closes,
      ema20: ema20[ema20.length - 1],
      ema60: ema60[ema60.length - 1],
      atr14: atr14[atr14.length - 1],
      supertrend: computeSuperTrend(m60, 10, 3.0),
      volRatio: avg20 > 0 ? Math.max(lastClosedVol, Number(m60[m60.length - 1].candle_acc_trade_volume || 0)) / avg20 : 0,
      lastClosedVolRatio: avg20 > 0 ? lastClosedVol / avg20 : 0,
    };
  }

  if (m15.length >= 40) {
    const closes = m15.map((c) => Number(c.trade_price));
    const rsiSeries = computeRsiSeries(closes, 14);
    const ema20 = computeEma(closes, 20);
    const ema60 = computeEma(closes, 60);
    const macdSeries = computeMacdSeries(closes, 12, 26, 9);
    const bandwidthSeries = computeBandwidthSeries(closes, 20, 2.0);
    const n = m15.length;
    const cur = m15[n - 1];
    const closed = m15[n - 2];
    const avgForClosed = avgVolume(m15, 2, 20);
    const avgForCur = avgVolume(m15, 1, 20);
    const avgPrev5 = avgVolume(m15, 2, 5);
    // 당일(09:00 KST 기준) VWAP: Σ(체결대금) / Σ(체결수량)
    const tradingDate = tradingDateKST(nowKSTString());
    const dayStartKey = `${tradingDate} 09:00:00`;
    let vwapAmt = 0;
    let vwapVol = 0;
    for (const c of m15) {
      if (candleKstKey(c) >= dayStartKey) {
        vwapAmt += Number(c.candle_acc_trade_price || 0);
        vwapVol += Number(c.candle_acc_trade_volume || 0);
      }
    }
    const recentRsi = rsiSeries.slice(-3).filter((v) => v !== null && v !== undefined);
    const atr14_15m = computeAtrSeries(m15, 14);
    ind.m15 = {
      closes,
      rsi: rsiSeries[n - 1] ?? 50,
      rsiMin3: recentRsi.length > 0 ? Math.min(...recentRsi) : 50,
      bb: computeBollinger(closes, 20, 2.0),
      bandwidthSeries,
      ema20: ema20[n - 1],
      ema60: ema60[n - 1],
      atr14: atr14_15m[atr14_15m.length - 1] ?? null,
      macdSeries,
      cur,
      closed,
      closedBullish: Number(closed.trade_price) > Number(closed.opening_price),
      curBullish: Number(cur.trade_price) > Number(cur.opening_price),
      closedVolRatio: avgForClosed > 0 ? Number(closed.candle_acc_trade_volume || 0) / avgForClosed : 0,
      curVolRatio: avgForCur > 0 ? Number(cur.candle_acc_trade_volume || 0) / avgForCur : 0,
      volSurge5: avgPrev5 > 0 ? Number(closed.candle_acc_trade_volume || 0) / avgPrev5 : 0,
      vwap: vwapVol > 0 ? vwapAmt / vwapVol : null,
      minLow2: Math.min(Number(cur.low_price), Number(closed.low_price)),
    };
    const kellogg = calculateKelloggIndicators(m15, day, price);
    ind.kellogg = kellogg;
    ind.m15.kellogg = kellogg;
  }
  ind.atr = ind.m15?.atr14 || ind.m60?.atr14 || null;
  const m60Bullish = ind.m60
    ? Boolean(
        (Number.isFinite(ind.m60.ema20) && Number.isFinite(ind.m60.ema60) && ind.m60.ema20 >= ind.m60.ema60) ||
          ind.m60.supertrend?.isUp
      )
    : null;
  const m240Bullish = ind.m240
    ? Boolean((Number.isFinite(ind.m240.ma20) && ind.m240.ma20 > 0 && price >= ind.m240.ma20) || ind.m240.supertrend?.isUp)
    : null;
  const dayBullish = Number.isFinite(ind.day?.ma20) && ind.day.ma20 > 0 ? price >= ind.day.ma20 : null;
  const htfChecks = [m60Bullish, m240Bullish, dayBullish].filter((v) => v !== null);
  const htfAlignedUp = htfChecks.length === 0 ? true : htfChecks.some(Boolean);
  const htfStronglyBearish =
    (m60Bullish === false && m240Bullish === false) ||
    (m60Bullish === false && dayBullish === false && ind.m60?.supertrend?.isUp === false);
  ind.mtf = {
    m60Bullish,
    m240Bullish,
    dayBullish,
    htfAlignedUp,
    htfStronglyBearish,
  };
  return ind;
}

/** [Antigravity-Doc] 유니버스 종목 간 7일 상대 모멘텀(`momentum7dPct`) 내림차순 순위표 생성 (`bot_03` 듀얼 모멘텀용) */
export function computeMomentumRanking(marketDataMap, markets) {
  const rows = [];
  for (const m of markets) {
    const md = marketDataMap.get(m);
    if (!md || !md.indicators?.day) continue;
    const mom = md.indicators.day.momentum7dPct;
    if (mom === null || mom === undefined) continue;
    rows.push({ market: m, momPct: mom });
  }
  rows.sort((a, b) => b.momPct - a.momPct);
  const rankMap = {};
  rows.forEach((r, idx) => {
    rankMap[r.market] = { rank: idx + 1, momPct: r.momPct };
  });
  return rankMap;
}

/**
 * [Antigravity-Doc] 돌파형 봇(`bot_01`, `bot_03`, `bot_04`, `bot_09`) 공통 윗꼬리(Bull Trap) & 이격도 과열 방어 필터
 * 1) 윗꼬리 비율 > 45% 또는 종가가 고가 대비 상위 35% 안착 실패 시 가짜 돌파 차단
 * 2) 현재가가 20MA 또는 VWAP 대비 +6.0% 이상 과열 급등 시 추격 매수 차단
 */
export function checkUpperWickAndOverextension(candle, currentPrice, ma20 = null, vwap = null) {
  if (!candle) return { ok: true };
  const high = Number(candle.high_price || candle.trade_price || 0);
  const low = Number(candle.low_price || candle.trade_price || 0);
  const open = Number(candle.opening_price || candle.trade_price || 0);
  const close = Number(candle.trade_price || 0);
  const curPrice = Number(currentPrice || close);
  const totalLen = high - low;

  // 1) 윗꼬리 비율 필터
  if (totalLen > 0) {
    const upperWick = high - Math.max(open, close);
    const upperWickRatio = upperWick / totalLen;
    const topCloseDist = (high - close) / totalLen; // 0이면 최고가 마감, 1이면 최저가 마감

    if (upperWickRatio > 0.45 || topCloseDist > 0.35) {
      return {
        ok: false,
        reason: `가짜 돌파(Bull Trap) 차단: 윗꼬리 ${fmt(upperWickRatio * 100, 1)}% > 45% 또는 상위 35% 안착 실패(${fmt(topCloseDist * 100, 1)}% > 35%)`,
      };
    }
  }

  // 2) 이격도 과열 추격 매수 금지 (+6.0% 초과)
  if (ma20 && Number(ma20) > 0) {
    const maGap = ((curPrice - Number(ma20)) / Number(ma20)) * 100.0;
    if (maGap >= 6.0) {
      return {
        ok: false,
        reason: `이격도 과열 추격매수 금지: 20MA 대비 +${fmt(maGap, 1)}% ≥ +6.0% 급등`,
      };
    }
  }
  if (vwap && Number(vwap) > 0) {
    const vwapGap = ((curPrice - Number(vwap)) / Number(vwap)) * 100.0;
    if (vwapGap >= 6.0) {
      return {
        ok: false,
        reason: `이격도 과열 추격매수 금지: VWAP 대비 +${fmt(vwapGap, 1)}% ≥ +6.0% 급등`,
      };
    }
  }

  return { ok: true };
}

function parseKstTimestampMs(timeStr) {
  if (!timeStr) return NaN;
  const raw = String(timeStr).trim();
  // KST 문자열("YYYY-MM-DD HH:MM:SS")에 타임존 표기가 없으면 명시적으로 +09:00으로 해석하여 서버 TZ 영향 제거
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(raw)) {
    return Date.parse(`${raw.replace(" ", "T")}+09:00`);
  }
  return Date.parse(raw);
}

/**
 * [Antigravity-Doc] 횡보장 자금 잠김(Position Lock) 해소 및 수익 보호용 3단계 스마트 청산(Smart Exit) 엔진
 * 1) 본절 스탑(Breakeven Stop): 최고가 +1.2% 이상 도달 후 +0.25% 이하 반락 시 수익 반납 방지 청산
 * 2) 시간 제한 청산(Time-Stop): 단타 봇(`bot_01`/`04`/`05`/`09`/`10`)이 실전 4h/가상 2h 경과 후 -0.6%~+0.8% 박스권 & RVOL < 1.0이면 자금 회수
 * 3) ATR 동적 스탑: 진입가 -2.2×ATR 하드 손절(`bot_06`·`bot_10 Setup B` 제외), 최고 +1.0% 이상 후 `peak - 1.8×ATR`(>평단가) 트레일링 익절
 *    (ATR 산출 불가 시 고정 `stopLossPct`로 폴백)
 */
export function evaluateSmartExit({
  botId,
  position,
  currentPrice,
  indicators,
  peakPrice = 0,
  isLive = false,
  stopLossPct = -2.5,
}) {
  const normId = normalizeBotId(botId);
  const curPrice = Number(currentPrice || 0);
  const avgBuy = Number(position.avg_buy_price || 0);
  if (curPrice <= 0 || avgBuy <= 0) return null;

  const pnlPct = pctChange(curPrice, avgBuy);
  const curPeak = Math.max(Number(peakPrice || avgBuy), curPrice);
  const peakPnlPct = pctChange(curPeak, avgBuy);

  // 1. 본절 스탑 (Breakeven Stop — 수익 반납 방지, 왕복 수수료 0.1% 감안 +0.30% 이상 보호)
  if (peakPnlPct >= 1.2 && pnlPct <= 0.3) {
    return {
      signal: "SELL",
      exitType: "BREAKEVEN_STOP",
      reason: `본절 스탑(Breakeven-Exit): 최고 +${fmt(peakPnlPct)}% 도달 후 ${pnlPct >= 0 ? "+" : ""}${fmt(pnlPct)}% 하락 반납 방지 청산`,
    };
  }

  // 2. 시간 제한 청산 (Time-Stop)
  const timeStopBots = new Set(["bot_01", "bot_04", "bot_05", "bot_09", "bot_10"]);
  if (timeStopBots.has(normId)) {
    const timeStr = position.opened_at || position.created_at;
    if (timeStr) {
      const entryTs = parseKstTimestampMs(timeStr);
      if (!isNaN(entryTs)) {
        const holdHours = (Date.now() - entryTs) / (3600 * 1000);
        const maxHoldHours = isLive ? 4.0 : 2.0;

        const inBox = pnlPct >= -0.6 && pnlPct <= 0.8;
        const rawRvol =
          indicators?.kellogg?.rvol ??
          indicators?.m15?.curVolRatio ??
          indicators?.m15?.closedVolRatio ??
          null;
        const rvol =
          rawRvol !== null && rawRvol !== undefined && Number.isFinite(Number(rawRvol))
            ? Number(rawRvol)
            : null;

        if (holdHours >= maxHoldHours && inBox && rvol !== null && rvol < 1.0) {
          return {
            signal: "SELL",
            exitType: "TIME_STOP",
            reason: `시간 제한 청산(Time-Exit): ${fmt(holdHours, 1)}h 경과(기준 ${maxHoldHours}h) · 박스권(${fmt(pnlPct)}%) · 거래량 침체(RVOL ${fmt(rvol, 1)}배) 현금 회수`,
          };
        }
      }
    }
  }

  // 3. ATR 기반 동적 트레일링 스탑 (Dynamic ATR Trailing Stop)
  const atr = Number(indicators?.m15?.atr14 || indicators?.m60?.atr14 || indicators?.atr || 0);
  if (atr > 0) {
    // 3-1. 진입가 대비 2.2 * ATR 하락 시 손절
    // (분할 그리드 bot_06 및 Jack Kellogg Setup B 2분할 반등 포지션은 자체 분할/기준선 손절을 사용하므로 15m ATR 선손절 제외)
    const buyReasonStr = String(position?.buy_reason || "");
    const vwapRef = Number(indicators?.kellogg?.vwap || 0);
    const inferredBot10Dip = normId === "bot_10" && !buyReasonStr && vwapRef > 0 && avgBuy < vwapRef;
    const isBot10SetupB =
      normId === "bot_10" && (buyReasonStr.includes("반등") || buyReasonStr.includes("Setup B") || inferredBot10Dip);
    if (normId !== "bot_06" && !isBot10SetupB) {
      // [Antigravity-Doc] 손익비 개선: 하드 손절을 -1.6×ATR로 타이트화하되 노이즈 휩소 방지를 위해 -1.0% 이하일 때만 발동
      const hardStopPrice = avgBuy - 1.6 * atr;
      if (curPrice <= hardStopPrice && pnlPct <= -1.0) {
        return {
          signal: "SELL",
          exitType: "ATR_HARD_STOP",
          reason: `동적 ATR 손절(Hard Stop): 진입가 대비 -1.6×ATR(${ko(1.6 * atr)}원) 이탈 (수익률 ${fmt(pnlPct)}%)`,
        };
      }
    }

    // 3-2. 최고가 +1.4% 이상 수익 도달 후 최소 순수익 확보선(+0.35% 이상) 위에서 -1.2 * ATR 하락 시 트레일링 익절
    if (peakPnlPct >= 1.4) {
      const trailingStopPrice = curPeak - 1.2 * atr;
      if (trailingStopPrice >= avgBuy * 1.0035 && curPrice <= trailingStopPrice) {
        return {
          signal: "SELL",
          exitType: "ATR_TRAILING_STOP",
          reason: `동적 ATR 트레일링 스탑: 최고가(${ko(curPeak)}) 대비 -1.2×ATR(${ko(1.2 * atr)}원) 이탈 (수익률 ${fmt(pnlPct)}%)`,
        };
      }
    }
  } else {
    // Fallback: ATR 산출 불가 시 기존 고정 퍼센트 손절
    const fixedStop = -Math.abs(Number(stopLossPct || 2.5));
    if (pnlPct <= fixedStop) {
      return {
        signal: "SELL",
        exitType: "FIXED_STOP_LOSS",
        reason: `고정 손절(Fallback Stop): ${fmt(pnlPct)}% ≤ ${fmt(fixedStop)}%`,
      };
    }
  }

  return null;
}

// ============================================================================
// 3. 10대 알고리즘 봇 마스터 데이터 & 3대 전략군 표준 메타
// ============================================================================
// [Antigravity-Doc] 3대 전략군 표준 순서 및 로테이션 배분 모드별 가중치 테이블
export const STRATEGY_GROUP_ORDER = ["TREND_SWING", "VOLATILITY_BREAKOUT", "REVERSAL_GRID"];

export const ALLOCATION_MODE_WEIGHTS = {
  EQUAL_BY_EQUITY_TIER: [100],
  EQUAL_BY_CAPITAL_TIER: [100],
  SINGLE_MARKET_FIT_100: [100],
  RANK_WEIGHTED_40_35_25: [40, 35, 25],
  RANK_WEIGHTED_40_40_20: [40, 40, 20],
  EQUAL_34_33_33: [34, 33, 33],
};

// ============================================================================
// 3-1. 실시간 업비트 총 평가자산 기준 주간 봇 차등 선정(1~3개 균등 배분),
//      단일 90% 상한 통합, 자동 원금 동기화 충돌 방지 및 교체 봇 자금 차감·복원 엔진
// ============================================================================
// [Antigravity-Doc] 최소 안전 실전 주문액(5,050원), 총자산 구간 경계(40만/70만 원), 단일 최대 투입비율(90%) 상수
export const MIN_LIVE_ORDER_SAFE_KRW = 5050;
export const DEFAULT_CAPITAL_TIER_1_MAX = 400000;
export const DEFAULT_CAPITAL_TIER_2_MAX = 700000;
export const DEFAULT_MAX_DEPLOY_RATIO = 0.9;

/** [Antigravity-Doc] 총자산 구간별 균등 배분 모드 여부 판별 */
export function isEquityTierAllocationMode(mode) {
  return mode === "EQUAL_BY_EQUITY_TIER" || mode === "EQUAL_BY_CAPITAL_TIER";
}

/**
 * [Antigravity-Doc] 0. 실시간 총 평가자산(E_total) 및 단일 90% 상한(globalCapKrw) 해석기
 * - 우선순위: 업비트 실시간 총자산 > DB 캐시 총자산 > 레거시 90% 원금 역산(이중 0.9 적용 원천 방지)
 */
export function resolveTotalEquityAndSingle90Cap({
  liveTotalEquityKrw = null,
  cachedTotalEquityKrw = null,
  legacyAuto90PrincipalKrw = null,
  maxDeployRatio = DEFAULT_MAX_DEPLOY_RATIO,
} = {}) {
  const ratio =
    Number.isFinite(Number(maxDeployRatio)) && Number(maxDeployRatio) > 0 && Number(maxDeployRatio) <= 1
      ? Number(maxDeployRatio)
      : DEFAULT_MAX_DEPLOY_RATIO;

  let totalEquityKrw = 0;
  let source = "NONE";

  if (liveTotalEquityKrw !== null && liveTotalEquityKrw !== undefined && Number.isFinite(Number(liveTotalEquityKrw)) && Number(liveTotalEquityKrw) > 0) {
    totalEquityKrw = Math.floor(Number(liveTotalEquityKrw));
    source = "UPBIT_LIVE_EQUITY";
  } else if (cachedTotalEquityKrw !== null && cachedTotalEquityKrw !== undefined && Number.isFinite(Number(cachedTotalEquityKrw)) && Number(cachedTotalEquityKrw) > 0) {
    totalEquityKrw = Math.floor(Number(cachedTotalEquityKrw));
    source = "CACHED_EQUITY_FALLBACK";
  } else if (legacyAuto90PrincipalKrw !== null && legacyAuto90PrincipalKrw !== undefined && Number.isFinite(Number(legacyAuto90PrincipalKrw)) && Number(legacyAuto90PrincipalKrw) > 0) {
    // 레거시 값이 이미 90%가 곱해진 값이라면 역산하여 원 총자산 복원
    totalEquityKrw = Math.floor(Number(legacyAuto90PrincipalKrw) / ratio);
    source = "LEGACY_PRINCIPAL_INFERRED";
  }

  // 단일 90% 상한 계산 (단 1회만 곱함)
  const globalCapKrw = Math.floor(totalEquityKrw * ratio);
  const minReserveKrw = Math.max(0, totalEquityKrw - globalCapKrw);

  return {
    totalEquityKrw,
    globalCapKrw,
    minReserveKrw,
    maxDeployRatio: ratio,
    source,
  };
}

/**
 * [Antigravity-Doc] 1. 총 평가자산 구간별 주간 실전 선출 봇 개수 결정 (<1만: 0개, ≤40만: 1개, <70만: 2개, ≥70만: 3개)
 */
export function getTargetBotCountByTotalEquity(
  totalEquityKrw,
  { tier1Max = DEFAULT_CAPITAL_TIER_1_MAX, tier2Max = DEFAULT_CAPITAL_TIER_2_MAX } = {}
) {
  const equity = Math.floor(Number(totalEquityKrw) || 0);
  const t1 = Math.max(10000, Math.floor(Number(tier1Max) || DEFAULT_CAPITAL_TIER_1_MAX));
  const t2 = Math.max(t1 + 1, Math.floor(Number(tier2Max) || DEFAULT_CAPITAL_TIER_2_MAX));
  if (equity < 10000) return 0;
  if (equity <= t1) return 1;
  if (equity < t2) return 2;
  return 3;
}

export function getTargetBotCountByPrincipal(principalKrw, options = {}) {
  return getTargetBotCountByTotalEquity(principalKrw, options);
}

export function getCapitalTierSummary(
  totalEquityKrw,
  { tier1Max = DEFAULT_CAPITAL_TIER_1_MAX, tier2Max = DEFAULT_CAPITAL_TIER_2_MAX, maxDeployRatio = DEFAULT_MAX_DEPLOY_RATIO } = {}
) {
  const { totalEquityKrw: safeEquity, globalCapKrw, minReserveKrw, maxDeployRatio: ratio } =
    resolveTotalEquityAndSingle90Cap({ liveTotalEquityKrw: totalEquityKrw, maxDeployRatio });
  const botCount = getTargetBotCountByTotalEquity(safeEquity, { tier1Max, tier2Max });
  const perBotTargetKrw = botCount > 0 ? Math.floor(globalCapKrw / botCount) : 0;
  let tierLabel = "최소 총자산(10,000원) 미달 — 신규 선출 불가";
  if (botCount === 1) {
    tierLabel = `총 평가자산 40만 원 이하 → 1개 봇 (균등 100% / 총자산 ${Math.round(ratio * 100)}% 단일 상한)`;
  } else if (botCount === 2) {
    tierLabel = `총 평가자산 40만 원 초과 ~ 70만 원 미만 → 2개 봇 (균등 50% : 50% / 총자산 ${Math.round(ratio * 100)}% 단일 상한)`;
  } else if (botCount === 3) {
    tierLabel = `총 평가자산 70만 원 이상 → 3개 봇 (균등 33.33%씩 / 총자산 ${Math.round(ratio * 100)}% 단일 상한)`;
  }
  return {
    totalEquityKrw: safeEquity,
    principalKrw: safeEquity,
    globalCapKrw,
    reserveMinKrw: minReserveKrw,
    botCount,
    perBotTargetKrw,
    maxDeployRatio: ratio,
    tierLabel,
  };
}

/**
 * [Antigravity-Doc] 총 투입/배정 자금(`totalUsedCapital`)이 단일 90% 상한(`globalCapKrw`)을 1원도 초과하지 않음을 강제 검증하는 불변식
 * - 위반 시 즉시 `[INVARIANT_VIOLATION]` 예외를 발생시켜 과투입 배포를 원천 차단한다.
 */
export function assertGlobal90CapInvariant({
  totalEquityKrw = null,
  principalKrw = null,
  totalUsedCapital,
  maxDeployRatio = DEFAULT_MAX_DEPLOY_RATIO,
  context = "",
}) {
  const rawEquity = totalEquityKrw !== null && totalEquityKrw !== undefined ? totalEquityKrw : principalKrw;
  const { globalCapKrw, maxDeployRatio: ratio } = resolveTotalEquityAndSingle90Cap({
    liveTotalEquityKrw: rawEquity,
    maxDeployRatio,
  });
  const used = Math.floor(Number(totalUsedCapital) || 0);
  if (used > globalCapKrw) {
    throw new Error(
      `[INVARIANT_VIOLATION]${context ? ` [${context}]` : ""} Total capital (${used}) exceeded single ${Math.round(
        ratio * 100
      )}% cap (${globalCapKrw})`
    );
  }
  return { ok: true, globalCapKrw, totalUsedCapital: used };
}

/**
 * [Antigravity-Doc] 2. 3대 전략군 1위 후보 중 목표 개수(1~3개)만큼 전략군 중복 없이 선출하고 단일 90% 상한을 균등 분배
 */
export function selectTieredEqualChampions(groupChampions, totalEquityKrw, options = {}) {
  const tier1Max = Number(options?.tier1Max || DEFAULT_CAPITAL_TIER_1_MAX);
  const tier2Max = Number(options?.tier2Max || DEFAULT_CAPITAL_TIER_2_MAX);
  const { totalEquityKrw: safeEquity, globalCapKrw } = resolveTotalEquityAndSingle90Cap({
    liveTotalEquityKrw: totalEquityKrw,
    maxDeployRatio: options?.maxDeployRatio,
  });
  const targetCount = getTargetBotCountByTotalEquity(safeEquity, { tier1Max, tier2Max });
  if (targetCount === 0 || !Array.isArray(groupChampions) || groupChampions.length === 0) {
    return { targetCount: 0, totalEquityKrw: safeEquity, globalCapKrw, perBotTargetKrw: 0, elected: [] };
  }

  // 전략군 중복 방지를 위해 그룹별 1위만 추린 뒤 종합 점수(rotation_score) 내림차순 정렬
  const uniqueByGroup = new Map();
  for (const cand of groupChampions) {
    const grp = cand.strategy_group_code || cand.strategy_group || "UNKNOWN";
    const prev = uniqueByGroup.get(grp);
    if (!prev || (cand.rotation_score ?? -Infinity) > (prev.rotation_score ?? -Infinity)) {
      uniqueByGroup.set(grp, cand);
    }
  }

  const ranked = Array.from(uniqueByGroup.values()).sort(
    (a, b) =>
      (b.rotation_score ?? 0) - (a.rotation_score ?? 0) ||
      (b.eval_return_pct ?? 0) - (a.eval_return_pct ?? 0) ||
      String(a.bot_id || "").localeCompare(String(b.bot_id || ""))
  );
  const electedList = ranked.slice(0, Math.min(targetCount, ranked.length));
  const actualCount = electedList.length;

  // 단일 90% 상한(globalCapKrw)을 동일 비율로 분배
  const perBotTargetKrw = actualCount > 0 ? Math.floor(globalCapKrw / actualCount) : 0;
  const equalRatio = actualCount > 0 ? Number((1 / actualCount).toFixed(4)) : 0;
  const equalRatioPct =
    actualCount === 1 ? 100 : actualCount === 2 ? 50 : actualCount === 3 ? 33.33 : Number((100 / actualCount).toFixed(2));

  return {
    targetCount: actualCount,
    totalEquityKrw: safeEquity,
    globalCapKrw,
    perBotTargetKrw,
    elected: electedList.map((bot, idx) => ({
      ...bot,
      champion_rank: idx + 1,
      allocation_ratio: equalRatio,
      recommended_ratio: equalRatioPct,
      target_capital_krw: perBotTargetKrw,
    })),
  };
}

/**
 * [Antigravity-Doc] 내부 공용 배분 불변식 엔진: 단일 90% 상한 + 실계좌 가용 원화 이중 캡 적용
 * - 각 선출 봇의 희망 가용 원화(`perBotTargetKrw - ownLocked - linkedDrainLocked`)를 합산해 가용 한도를 초과하면
 *   비례 축소 및 잔여 1원 단위 보정 후 `assertGlobal90CapInvariant`로 총합 상한 준수를 검증한다.
 */
function _applySingle90CapToElected({
  totalEquityKrw,
  globalCapKrw,
  perBotTargetKrw,
  allBots,
  electedBots,
  drainingAssignments,
  linkedDrainSumBySuccessor,
  actualAvailableKrw,
  maxDeployRatio = DEFAULT_MAX_DEPLOY_RATIO,
}) {
  let totalDrainingLocked = 0;
  for (const d of drainingAssignments) totalDrainingLocked += d.open_locked_krw;

  let totalElectedLocked = 0;
  const botStates = electedBots.map((eb) => {
    const current = allBots.find((b) => b.bot_id === eb.bot_id) || eb;
    const ownLocked = Math.max(0, Math.floor(Number(current.open_locked_krw ?? current.used_capital) || 0));
    const linkedDrainLocked = linkedDrainSumBySuccessor.get(eb.bot_id) || 0;
    totalElectedLocked += ownLocked;

    const desiredVirtualKrw = Math.max(0, perBotTargetKrw - ownLocked - linkedDrainLocked);
    return {
      bot_id: eb.bot_id,
      strategy_group: eb.strategy_group_code || eb.strategy_group,
      allocation_ratio: eb.allocation_ratio,
      target_capital_krw: perBotTargetKrw,
      own_locked_krw: ownLocked,
      linked_drain_locked_krw: linkedDrainLocked,
      desired_virtual_krw: desiredVirtualKrw,
      virtual_krw: desiredVirtualKrw,
    };
  });

  const globalCashHeadroom = Math.max(0, globalCapKrw - totalDrainingLocked - totalElectedLocked);
  const maxAllocatableCash =
    actualAvailableKrw !== null && actualAvailableKrw !== undefined && Number.isFinite(Number(actualAvailableKrw))
      ? Math.min(globalCashHeadroom, Math.max(0, Math.floor(Number(actualAvailableKrw))))
      : globalCashHeadroom;

  const totalDesired = botStates.reduce((acc, b) => acc + b.desired_virtual_krw, 0);

  if (totalDesired > maxAllocatableCash && totalDesired > 0) {
    let allocated = 0;
    for (const b of botStates) {
      b.virtual_krw = Math.floor((b.desired_virtual_krw * maxAllocatableCash) / totalDesired);
      allocated += b.virtual_krw;
    }
    let remainder = maxAllocatableCash - allocated;
    const sortedByGap = [...botStates].sort(
      (a, b) => (b.desired_virtual_krw - b.virtual_krw) - (a.desired_virtual_krw - a.virtual_krw)
    );
    for (const b of sortedByGap) {
      if (remainder <= 0) break;
      if (b.virtual_krw < b.desired_virtual_krw) {
        b.virtual_krw += 1;
        remainder -= 1;
      }
    }
  }

  const totalAllocatedCash = botStates.reduce((acc, b) => acc + b.virtual_krw, 0);
  const totalUsedCapital = totalDrainingLocked + totalElectedLocked + totalAllocatedCash;

  assertGlobal90CapInvariant({
    totalEquityKrw,
    totalUsedCapital,
    maxDeployRatio,
    context: "_applySingle90CapToElected",
  });

  return {
    totalEquityKrw,
    principalKrw: totalEquityKrw,
    globalCapKrw,
    perBotTargetKrw,
    totalDrainingLocked,
    totalElectedLocked,
    totalAllocatedCash,
    totalUsedCapital,
    reservedCashKrw: Math.max(0, totalEquityKrw - totalUsedCapital),
    electedAllocations: botStates.map((b) => ({
      ...b,
      funding_status:
        b.virtual_krw < MIN_LIVE_ORDER_SAFE_KRW &&
        b.own_locked_krw === 0 &&
        (b.linked_drain_locked_krw > 0 || totalDrainingLocked > 0)
          ? "WAITING_CAPITAL_RESTORE"
          : "READY",
    })),
    drainingAssignments,
  };
}

/**
 * [Antigravity-Doc] 3. 주간 로테이션 시 탈락(Draining) 봇의 보유 포지션 잠금액을 후임 봇(1:1 우선 매핑) 한도에서 차감하고
 * 단일 90% 상한 내에서 선출 봇 가용 원화를 산출하는 배분 계산기 (탈락 봇 `virtual_krw = 0` 강제)
 */
export function computeRotationAllocationsWith90Cap({
  totalEquityKrw = null,
  principalKrw = null,
  allBots,
  electedBots,
  actualAvailableKrw = null,
  maxDeployRatio = DEFAULT_MAX_DEPLOY_RATIO,
}) {
  const rawEquity = totalEquityKrw !== null && totalEquityKrw !== undefined ? totalEquityKrw : principalKrw;
  const { totalEquityKrw: safeEquity, globalCapKrw, maxDeployRatio: ratio } = resolveTotalEquityAndSingle90Cap({
    liveTotalEquityKrw: rawEquity,
    maxDeployRatio,
  });
  const electedMap = new Map(electedBots.map((b) => [b.bot_id, b]));
  const perBotTargetKrw =
    electedBots.length > 0 ? Math.floor(globalCapKrw / electedBots.length) : 0;

  const newlyElected = [];
  const drainingBots = [];

  for (const bot of allBots) {
    const isNowElected = electedMap.has(bot.bot_id);
    const wasLive = Number(bot.is_selected_for_live) === 1;
    const locked = Math.max(0, Math.floor(Number(bot.open_locked_krw ?? bot.used_capital) || 0));

    if (isNowElected) {
      if (!wasLive) newlyElected.push(bot);
    } else if (locked > 0) {
      drainingBots.push({ ...bot, open_locked_krw: locked });
    }
  }

  // 3-1. 탈락(Draining) 봇 -> 신규 진입 봇 1:1 우선 매핑
  const usedNewBotIds = new Set();
  const linkedDrainSumBySuccessor = new Map();
  const drainingAssignments = [];

  for (const dBot of drainingBots) {
    const dGroup = dBot.strategy_group_code || dBot.strategy_group || "";
    let successor =
      dBot.replaced_by_bot_id && electedMap.has(dBot.replaced_by_bot_id)
        ? electedMap.get(dBot.replaced_by_bot_id)
        : null;

    if (!successor) {
      successor = newlyElected.find(
        (nb) => (nb.strategy_group_code || nb.strategy_group || "") === dGroup && !usedNewBotIds.has(nb.bot_id)
      );
    }
    if (!successor) {
      successor = newlyElected.find((nb) => !usedNewBotIds.has(nb.bot_id));
    }

    const successorId = successor ? successor.bot_id : null;
    if (successorId) {
      usedNewBotIds.add(successorId);
      linkedDrainSumBySuccessor.set(
        successorId,
        (linkedDrainSumBySuccessor.get(successorId) || 0) + dBot.open_locked_krw
      );
    }

    drainingAssignments.push({
      bot_id: dBot.bot_id,
      open_locked_krw: dBot.open_locked_krw,
      replaced_by_bot_id: successorId,
      virtual_krw: 0, // 탈락 봇 신규 매수 절대 차단
      drain_status: "DRAINING",
    });
  }

  return _applySingle90CapToElected({
    totalEquityKrw: safeEquity,
    globalCapKrw,
    perBotTargetKrw,
    allBots,
    electedBots,
    drainingAssignments,
    linkedDrainSumBySuccessor,
    actualAvailableKrw,
    maxDeployRatio: ratio,
  });
}

/**
 * [Antigravity-Doc] 4. 주중 '총 평가자산 90% 자동 원금 동기화' 전용 통합 정산기
 * - 기존 선출 봇 구성(1~3개)과 Draining 봇의 `virtual_krw = 0` 및 후임 차감 연결을 보존한 채,
 *   변동된 총 평가자산의 단일 90% 상한 내에서만 각 봇의 목표 한도와 가용 원화를 안전하게 재조정한다.
 */
export function reconcileAutoSyncedBudgetsWith90Cap({
  totalEquityKrw,
  allBots,
  actualAvailableKrw = null,
  maxDeployRatio = DEFAULT_MAX_DEPLOY_RATIO,
}) {
  const { totalEquityKrw: safeEquity, globalCapKrw, maxDeployRatio: ratio } = resolveTotalEquityAndSingle90Cap({
    liveTotalEquityKrw: totalEquityKrw,
    maxDeployRatio,
  });

  const electedBots = allBots.filter((b) => Number(b.is_selected_for_live) === 1);
  const perBotTargetKrw =
    electedBots.length > 0 ? Math.floor(globalCapKrw / electedBots.length) : 0;
  const equalRatio =
    electedBots.length > 0 ? Number((1 / electedBots.length).toFixed(4)) : 0;

  const electedMap = new Map(electedBots.map((b) => [b.bot_id, b]));
  const linkedDrainSumBySuccessor = new Map();
  const drainingAssignments = [];

  for (const bot of allBots) {
    const isElected = electedMap.has(bot.bot_id);
    const locked = Math.max(0, Math.floor(Number(bot.open_locked_krw ?? bot.used_capital) || 0));
    if (!isElected && locked > 0) {
      const validSuccessor =
        bot.replaced_by_bot_id && electedMap.has(bot.replaced_by_bot_id)
          ? bot.replaced_by_bot_id
          : null;
      if (validSuccessor) {
        linkedDrainSumBySuccessor.set(
          validSuccessor,
          (linkedDrainSumBySuccessor.get(validSuccessor) || 0) + locked
        );
      }
      drainingAssignments.push({
        bot_id: bot.bot_id,
        open_locked_krw: locked,
        replaced_by_bot_id: validSuccessor,
        virtual_krw: 0,
        drain_status: "DRAINING",
      });
    }
  }

  return _applySingle90CapToElected({
    totalEquityKrw: safeEquity,
    globalCapKrw,
    perBotTargetKrw,
    allBots,
    electedBots: electedBots.map((b) => ({
      ...b,
      allocation_ratio: equalRatio,
      target_capital_krw: perBotTargetKrw,
    })),
    drainingAssignments,
    linkedDrainSumBySuccessor,
    actualAvailableKrw,
    maxDeployRatio: ratio,
  });
}

/**
 * [Antigravity-Doc] 5. Draining(탈락) 봇 포지션 청산 정산 시 회수 자금을 후임/선출 봇으로 자동 복원하는 계산기
 * - 1순위: 직접 교체 연결된 후임 봇(`replaced_by_bot_id`)의 한도 부족분 우선 복원
 * - 2순위: 잔여 복원 풀을 목표 한도 미달 선출 봇들에 부족분 비례 분배
 * - 단일 90% 상한 초과분(익절 초과액)은 계좌 예비비(`surplusToReserveKrw`)로 유보한다.
 */
export function computeDrainSellCapitalRestoration({
  totalEquityKrw = null,
  principalKrw = null,
  drainingBot,
  settledNetKrw,
  remainingDrainingLockedAll,
  electedBotsNow,
  actualAvailableKrw = null,
  maxDeployRatio = DEFAULT_MAX_DEPLOY_RATIO,
}) {
  const rawEquity = totalEquityKrw !== null && totalEquityKrw !== undefined ? totalEquityKrw : principalKrw;
  const { totalEquityKrw: safeEquity, globalCapKrw, maxDeployRatio: ratio } = resolveTotalEquityAndSingle90Cap({
    liveTotalEquityKrw: rawEquity,
    maxDeployRatio,
  });
  const netRecovered = Math.max(0, Math.floor(Number(settledNetKrw) || 0));

  const totalElectedUsed = electedBotsNow.reduce(
    (acc, b) =>
      acc +
      Math.max(0, Math.floor(Number(b.open_locked_krw ?? b.used_capital) || 0)) +
      Math.max(0, Math.floor(Number(b.virtual_krw) || 0)),
    0
  );

  const globalHeadroom = Math.max(
    0,
    globalCapKrw - (Math.max(0, Math.floor(Number(remainingDrainingLockedAll) || 0)) + totalElectedUsed)
  );

  let restorablePool = Math.min(netRecovered, globalHeadroom);
  if (actualAvailableKrw !== null && actualAvailableKrw !== undefined && Number.isFinite(Number(actualAvailableKrw))) {
    restorablePool = Math.min(restorablePool, Math.max(0, Math.floor(Number(actualAvailableKrw))));
  }

  const transfers = [];
  const targetPerBot =
    electedBotsNow.length > 0 ? Math.floor(globalCapKrw / electedBotsNow.length) : 0;

  const getDeficit = (bot) => {
    const target = Math.max(0, Math.floor(Number(bot.target_capital_krw) || targetPerBot));
    const used =
      Math.max(0, Math.floor(Number(bot.open_locked_krw ?? bot.used_capital) || 0)) +
      Math.max(0, Math.floor(Number(bot.virtual_krw) || 0));
    return Math.max(0, target - used);
  };

  // 1순위: 직접 교체 연결된 후임 봇(replaced_by_bot_id) 우선 복원
  if (restorablePool > 0 && drainingBot?.replaced_by_bot_id) {
    const successor = electedBotsNow.find((b) => b.bot_id === drainingBot.replaced_by_bot_id);
    if (successor) {
      const deficit = getDeficit(successor);
      const amount = Math.min(restorablePool, deficit);
      if (amount > 0) {
        transfers.push({ bot_id: successor.bot_id, restored_krw: amount, priority: "DIRECT_SUCCESSOR" });
        restorablePool -= amount;
      }
    }
  }

  // 2순위: 잔여 복원 풀을 목표 한도 미달인 다른 선출 봇들에게 부족분 비례 분배
  if (restorablePool > 0) {
    const transferredMap = new Map(transfers.map((t) => [t.bot_id, t.restored_krw]));
    const needyBots = electedBotsNow
      .map((b) => ({
        bot_id: b.bot_id,
        deficit: Math.max(0, getDeficit(b) - (transferredMap.get(b.bot_id) || 0)),
      }))
      .filter((b) => b.deficit > 0);

    const totalDeficit = needyBots.reduce((acc, b) => acc + b.deficit, 0);
    if (totalDeficit > 0) {
      let distributed = 0;
      const poolToShare = Math.min(restorablePool, totalDeficit);
      for (const nb of needyBots) {
        const share = Math.min(nb.deficit, Math.floor((nb.deficit * poolToShare) / totalDeficit));
        if (share > 0) {
          transfers.push({ bot_id: nb.bot_id, restored_krw: share, priority: "POOL_REBALANCE" });
          distributed += share;
        }
      }
      let rem = poolToShare - distributed;
      if (rem > 0) {
        const addedMap = new Map(transfers.map((t) => [t.bot_id, t.restored_krw]));
        for (const nb of needyBots) {
          if (rem <= 0) break;
          const already = addedMap.get(nb.bot_id) || 0;
          if (already < nb.deficit) {
            const existing = transfers.find((t) => t.bot_id === nb.bot_id);
            if (existing) existing.restored_krw += 1;
            else transfers.push({ bot_id: nb.bot_id, restored_krw: 1, priority: "POOL_REBALANCE" });
            addedMap.set(nb.bot_id, already + 1);
            distributed += 1;
            rem -= 1;
          }
        }
      }
      restorablePool -= distributed;
    }
  }

  const totalRestoredKrw = transfers.reduce((acc, t) => acc + t.restored_krw, 0);
  const surplusToReserveKrw = Math.max(0, netRecovered - totalRestoredKrw);
  const totalUsedAfterKrw =
    Math.max(0, Math.floor(Number(remainingDrainingLockedAll) || 0)) + totalElectedUsed + totalRestoredKrw;

  assertGlobal90CapInvariant({
    totalEquityKrw: safeEquity,
    totalUsedCapital: totalUsedAfterKrw,
    maxDeployRatio: ratio,
    context: "computeDrainSellCapitalRestoration",
  });

  return {
    totalEquityKrw: safeEquity,
    globalCapKrw,
    settledNetKrw: netRecovered,
    totalRestoredKrw,
    surplusToReserveKrw,
    totalUsedAfterKrw,
    transfers,
  };
}

export const STRATEGY_GROUP_META = {
  TREND_SWING: {
    code: "TREND_SWING",
    group: "추세·스윙",
    label: "그룹 A · 추세·스윙형",
    short_label: "추세·스윙",
    badge: "📈 추세·스윙",
    champion_badge: "그룹 A 추세 1위",
    description: "슈퍼트렌드·듀얼모멘텀·MACD·20일선 눌림목 추세 스윙 전략군 (bot_02, bot_03, bot_07, bot_08)",
  },
  VOLATILITY_BREAKOUT: {
    code: "VOLATILITY_BREAKOUT",
    group: "변동성·돌파",
    label: "그룹 B · 변동성·돌파형",
    short_label: "변동성·돌파",
    badge: "⚡ 변동성·돌파",
    champion_badge: "그룹 B 돌파 1위",
    description: "변동성 돌파·BB 스퀴즈·거래량 폭발 모멘텀 스캘핑 특화 전략군 (bot_01, bot_04, bot_09)",
  },
  REVERSAL_GRID: {
    code: "REVERSAL_GRID",
    group: "역추세·그리드",
    label: "그룹 C · 역추세·그리드·올라운더",
    short_label: "역추세·그리드",
    badge: "🔄 역추세·그리드",
    champion_badge: "그룹 C 역추세 1위",
    description: "볼린저 과매도 반등·분할 그리드·VWAP/선형회귀 올라운더 전략군 (bot_05, bot_06, bot_10)",
  },
};

// [Antigravity-Doc] 10대 알고리즘 봇(bot_01 ~ bot_10) 마스터 정의 테이블 (DB 시드, 백테스트 기본 파라미터, UI 메타의 단일 원천)
export const ARENA_BOT_DEFS = [
  {
    bot_id: "bot_01",
    legacy_ids: ["bot_volatility"],
    name: "필터 결합형 변동성 돌파 봇",
    nickname: "돌파봇-알파",
    strategy_type: "VOLATILITY_BREAKOUT",
    strategy_group_code: "VOLATILITY_BREAKOUT",
    strategy_group: "변동성·돌파",
    strategy_sub_label: "변동성 돌파",
    strategy_rule: "BULL ALLOW, SIDEWAYS/휩소 BLOCK",
    description: "장중 단타 / 1일 보유 | 변동성 돌파(K=0.3) + 20일 이평선 추세 필터 전략",
    min_volume_krw: 10000000000,
    stop_loss_pct: 2.5,
    take_profit_pct: 4.5,
    config: { k_value: 0.3, ma_period: 20, volume_multiplier: 1.2, order_ratio: 0.3, max_positions: 2 },
  },
  {
    bot_id: "bot_02",
    legacy_ids: [],
    name: "슈퍼트렌드 & ATR 트레일링 (SuperTrend ATR)",
    nickname: "슈퍼트렌드-ATR",
    strategy_type: "SUPERTREND_ATR",
    strategy_group_code: "TREND_SWING",
    strategy_group: "추세·스윙",
    strategy_sub_label: "ATR 추세추종",
    strategy_rule: "BULL ALLOW, SIDEWAYS/휩소 BLOCK",
    description: "1시간/4시간봉 SuperTrend 상승 전환 & 거래량(20봉 평균 1.5배) 돌파 진입 | 최고가 대비 2.5×ATR(14) 하락 시 트레일링 스탑",
    min_volume_krw: 8000000000,
    stop_loss_pct: 4.0,
    take_profit_pct: 15.0,
    config: { atr_period: 14, atr_multiplier: 2.5, volume_multiplier: 1.5, order_ratio: 0.3, max_positions: 3 },
  },
  {
    bot_id: "bot_03",
    legacy_ids: ["bot_dual_momentum"],
    name: "듀얼 모멘텀 스윙 봇",
    nickname: "모멘텀봇-베타",
    strategy_type: "DUAL_MOMENTUM",
    strategy_group_code: "TREND_SWING",
    strategy_group: "추세·스윙",
    strategy_sub_label: "듀얼 모멘텀",
    strategy_rule: "BULL ALLOW, SIDEWAYS/휩소 BLOCK",
    description: "상대 모멘텀(상위 2종목) + 절대 모멘텀(+1.5% 이상) 스윙 전략",
    min_volume_krw: 15000000000,
    stop_loss_pct: 3.5,
    take_profit_pct: 7.0,
    config: { lookback_days: 8, abs_momentum_threshold_pct: 1.5, top_n: 2, order_ratio: 0.35, max_positions: 2 },
  },
  {
    bot_id: "bot_04",
    legacy_ids: [],
    name: "볼린저 밴드 스퀴즈 돌파 (BB Squeeze VCP)",
    nickname: "스퀴즈봇-델타",
    strategy_type: "BB_SQUEEZE_VCP",
    strategy_group_code: "VOLATILITY_BREAKOUT",
    strategy_group: "변동성·돌파",
    strategy_sub_label: "스퀴즈 VCP 돌파",
    strategy_rule: "BULL ALLOW, 스퀴즈 응축 시 조건부 허용",
    description: "볼린저(20,2) 밴드폭이 최근 20봉 최저 수준으로 수축 후 거래량 급증과 함께 상단선 돌파 시 매수 | 중심선 이탈 시 청산",
    min_volume_krw: 5000000000,
    stop_loss_pct: 2.5,
    take_profit_pct: 5.0,
    config: { bb_period: 20, bb_std: 2.0, volume_multiplier: 2.0, order_ratio: 0.3, max_positions: 3 },
  },
  {
    bot_id: "bot_05",
    legacy_ids: ["bot_bollinger_reversal"],
    name: "고변동성 볼린저 밴드 역추세 봇",
    nickname: "볼린저봇-감마",
    strategy_type: "BOLLINGER_REVERSAL",
    strategy_group_code: "REVERSAL_GRID",
    strategy_group: "역추세·그리드",
    strategy_sub_label: "볼린저 역추세",
    strategy_rule: "SIDEWAYS/과매도 반등 ALLOW, 패닉 폭락 BLOCK",
    description: "고변동성 코인 볼린저 밴드(20, 2.0σ) 15분봉 단기 반등 전략",
    min_volume_krw: 8000000000,
    stop_loss_pct: 2.0,
    take_profit_pct: 3.5,
    config: { bb_period: 20, bb_std: 2.0, bb_stddev: 2.0, rsi_threshold: 32, candle_unit: "minutes/15", order_krw: 15000, order_ratio: 0.45, max_positions: 2 },
  },
  {
    bot_id: "bot_06",
    legacy_ids: [],
    name: "다단계 분할 매수 그리드 (Dynamic Grid Reversion)",
    nickname: "그리드봇-엡실론",
    strategy_type: "DYNAMIC_GRID",
    strategy_group_code: "REVERSAL_GRID",
    strategy_group: "역추세·그리드",
    strategy_sub_label: "분할 매수 그리드",
    strategy_rule: "SIDEWAYS 박스권 ALLOW, 급락 쇼크 BLOCK",
    description: "단기 과매도(RSI≤32, 1h 급락장 차단) 진입 후 -3.0%/-6.0% 추가 하락 시 최대 3분할 매수(order_uuid 개별 관리) | 개별 포지션 +2.0% 도달 시 개별 익절",
    min_volume_krw: 5000000000,
    stop_loss_pct: 9.0,
    take_profit_pct: 2.0,
    config: { rsi_entry: 32, grid_step_1_pct: 3.0, grid_step_2_pct: 6.0, max_splits: 3, order_ratio: 0.45, max_positions: 2 },
  },
  {
    bot_id: "bot_07",
    legacy_ids: [],
    name: "MACD + RSI 골든크로스 (MACD Trend)",
    nickname: "MACD봇-제타",
    strategy_type: "MACD_TREND",
    strategy_group_code: "TREND_SWING",
    strategy_group: "추세·스윙",
    strategy_sub_label: "MACD+RSI 추세",
    strategy_rule: "BULL ALLOW, SIDEWAYS/휩소 BLOCK",
    description: "15분/60분봉 EMA(20>60) 정배열 상태에서 MACD 시그널선 상향 돌파 & RSI 45~65 추세 확장 구간 매수",
    min_volume_krw: 8000000000,
    stop_loss_pct: 2.5,
    take_profit_pct: 5.0,
    config: { fast_period: 12, slow_period: 26, signal_period: 9, rsi_min: 45, rsi_max: 65, order_ratio: 0.3, max_positions: 3 },
  },
  {
    bot_id: "bot_08",
    legacy_ids: [],
    name: "정배열 20일선 눌림목 스윙 (MA20 Pullback)",
    nickname: "눌림목봇-에타",
    strategy_type: "MA20_PULLBACK",
    strategy_group_code: "TREND_SWING",
    strategy_group: "추세·스윙",
    strategy_sub_label: "20일선 눌림목",
    strategy_rule: "상승 눌림/횡보 반등 ALLOW, 급락 쇼크 BLOCK",
    description: "일봉/4시간봉 정배열(5>20>60) 상승 추세 종목이 거래량 감소와 함께 20선 부근(±1.5%) 지지 확인 시 매수 | 직전 고점 부근 익절",
    min_volume_krw: 10000000000,
    stop_loss_pct: 3.0,
    take_profit_pct: 6.0,
    config: { pullback_band_pct: 1.5, order_ratio: 0.3, max_positions: 3 },
  },
  {
    bot_id: "bot_09",
    legacy_ids: [],
    name: "거래량 폭발 모멘텀 스캘퍼 (Volume Spike Breakout)",
    nickname: "스파이크봇-세타",
    strategy_type: "VOLUME_SPIKE_BREAKOUT",
    strategy_group_code: "VOLATILITY_BREAKOUT",
    strategy_group: "변동성·돌파",
    strategy_sub_label: "거래량 스캘핑",
    strategy_rule: "BULL ALLOW, 거래량 폭발 시 조건부 허용",
    description: "15분봉 거래량이 직전 20봉 평균 대비 150% 이상 폭발하며 양봉 마감 시 진입 | 고점 대비 -1.5% 트레일링 스탑",
    min_volume_krw: 5000000000,
    stop_loss_pct: 2.0,
    take_profit_pct: 8.0,
    config: { volume_spike_multiplier: 1.5, trailing_stop_pct: 1.5, order_ratio: 0.3, max_positions: 3 },
  },
  {
    bot_id: "bot_10",
    legacy_ids: [],
    name: "잭 켈로그 프라이스액션 (Jack Kellogg Price Action)",
    nickname: "잭 켈로그 프라이스액션",
    strategy_type: "JACK_KELLOGG_PRICE_ACTION",
    strategy_group_code: "REVERSAL_GRID",
    strategy_group: "역추세·그리드",
    strategy_sub_label: "VWAP·LRC 올라운더",
    strategy_rule: "VWAP/회귀 채널 멀티 레짐 ALLOW, 패닉 쇼크 BLOCK",
    description: "4대 핵심 지표(VWAP, 20봉 선형회귀 채널 LRC ±2σ, 거래량 폭발 RVOL, 당일시가/전일고저) 기반 돌파 및 과매도 2분할 반등 매매",
    min_volume_krw: 5000000000,
    stop_loss_pct: 1.8,
    take_profit_pct: 5.0,
    config: {
      rvol_breakout_arena: 1.4,
      rvol_breakout_live: 1.4,
      rvol_dip: 1.3,
      vwap_gap_arena: 2.0,
      vwap_gap_live: 2.0,
      min_lrc_tp_pct: 1.1,
      trailing_stop_pct: 1.0,
      order_ratio: 0.3,
      max_positions: 3,
    },
  },
];

export const ARENA_BOT_IDS = ARENA_BOT_DEFS.map((d) => d.bot_id);
export const LEGACY_BOT_ID_MAP = {};
const BOT_DEF_BY_ID = new Map();
for (const d of ARENA_BOT_DEFS) {
  BOT_DEF_BY_ID.set(d.bot_id, d);
  for (const lid of d.legacy_ids) LEGACY_BOT_ID_MAP[lid] = d.bot_id;
}

/** [Antigravity-Doc] 구버전 봇 ID(`bot_volatility` 등)를 현행 표준 ID(`bot_01` 등)로 정규화 */
export function normalizeBotId(botId) {
  return LEGACY_BOT_ID_MAP[botId] || botId;
}

/** [Antigravity-Doc] 봇 ID에 해당하는 전략군 코드/배지/룰 메타 정보 조회 */
export function getBotStrategyMeta(botId) {
  const normId = normalizeBotId(botId);
  const def = BOT_DEF_BY_ID.get(normId);
  const groupCode = def?.strategy_group_code || "TREND_SWING";
  const gMeta = STRATEGY_GROUP_META[groupCode] || STRATEGY_GROUP_META.TREND_SWING;
  return {
    strategy_group_code: gMeta.code,
    strategy_group: gMeta.group,
    strategy_group_label: gMeta.label,
    strategy_group_badge: gMeta.badge,
    strategy_champion_badge: gMeta.champion_badge,
    strategy_sub_label: def?.strategy_sub_label || "알고리즘",
    strategy_rule: def?.strategy_rule || "",
  };
}

// ============================================================================
// 4. 순수 알고리즘 전략 함수 (LLM / Regime 필터 비참조)
// ============================================================================
const hold = (reason) => ({ signal: "HOLD", reason });
const buy = (reason, extra = {}) => ({ signal: "BUY", reason, ...extra });
const sell = (reason, extra = {}) => ({ signal: "SELL", reason, ...extra });
const pctChange = (a, b) => (b > 0 ? ((a - b) / b) * 100 : 0);
const fmt = (n, d = 2) => Number(n).toFixed(d);
const ko = (n) => Math.floor(Number(n || 0)).toLocaleString("ko-KR");

// [Antigravity-Doc] 10대 순수 알고리즘 전략 맵 — LLM/시황 필터 없이 오직 캔들·지표 수식으로만 BUY/SELL/HOLD 판정
const STRATEGIES = {
  // [Antigravity-Doc] bot_01 (변동성 돌파): 목표가 = 당일시가 + 전일레인지 × K, 20일선 상회 & 15분 거래량 급증 & 윗꼬리/이격 필터 통과 시 진입, 익일(09시 KST) 시가 청산
  // bot_01: 변동성 돌파
  bot_01({ price, ind, held, params }) {
    const d = ind.day;
    if (!d) return hold("일봉 데이터 부족");
    if (held.length > 0) {
      const today = tradingDateKST(nowKSTString());
      if (held.some((p) => tradingDateKST(p.created_at || p.opened_at) < today)) {
        return sell("익일 시가 청산 (1일 보유 만기)");
      }
      return hold("보유 중 (목표 수익/익일 시가 청산 대기)");
    }
    const k = Number(params.k_value ?? 0.35);
    const target = d.todayOpen + (d.prevHigh - d.prevLow) * k;
    const volMult = Number(params.volume_multiplier ?? 1.2);
    const volOk = ind.m15 ? ind.m15.volSurge5 >= volMult : true;
    const trendOk = d.ma20 !== null && d.ma20 !== undefined ? price >= d.ma20 : true;
    if (price >= target && price > d.todayOpen && trendOk && volOk) {
      // 윗꼬리 및 이격도 과열 필터 검사
      const filter = checkUpperWickAndOverextension(ind.m15?.cur || ind.m15?.closed, price, ind.m15?.ema20 || d.ma20, ind.m15?.vwap);
      if (!filter.ok) return hold(filter.reason);
      return buy(`변동성 돌파(K=${k}) 목표가 ${ko(target)} 돌파 · 20MA 상회 · 거래량 증가`);
    }
    return hold(`돌파목표 ${ko(target)} 대기 (현재 ${ko(price)})`);
  },

  // [Antigravity-Doc] bot_02 (SuperTrend + ATR 트레일링): 1h/4h SuperTrend 최근 상승 전환 + 거래량 1.4배 이상 돌파 진입, 고점 - 2.5×ATR(14) 이탈 시 청산
  // bot_02: SuperTrend + ATR 트레일링
  bot_02({ price, ind, held, params, options = {} }) {
    const mult = Number(params.atr_multiplier ?? 2.5);
    const volMult = Number(params.volume_multiplier ?? 1.4);
    if (held.length > 0) {
      const atr = ind.m60?.atr14;
      const peak = Math.max(Number(options.peakPrice || 0), price);
      if (atr && peak > 0 && price <= peak - mult * atr) {
        return sell(`ATR 트레일링 스탑 (고점 ${ko(peak)} - ${mult}×ATR)`);
      }
      return hold("보유 중 (ATR 트레일링 감시)");
    }
    const st60 = ind.m60?.supertrend;
    const st240 = ind.m240?.supertrend;
    const up60 = st60 && st60.isUp && st60.flipUpBarsAgo !== null && st60.flipUpBarsAgo <= 3 && price > st60.lastLine;
    const up240 = st240 && st240.isUp && st240.flipUpBarsAgo !== null && st240.flipUpBarsAgo <= 2 && price > st240.lastLine;
    if (up60 && ind.m60.volRatio >= volMult) {
      return buy(`1시간봉 SuperTrend 상승 전환 · 거래량 ${fmt(ind.m60.volRatio, 1)}배`);
    }
    if (up240 && ind.m240.volRatio >= volMult) {
      return buy(`4시간봉 SuperTrend 상승 전환 · 거래량 ${fmt(ind.m240.volRatio, 1)}배`);
    }
    return hold("SuperTrend 상승 전환 + 거래량 돌파 대기");
  },

  // [Antigravity-Doc] bot_03 (듀얼 모멘텀): 7일 상대 모멘텀 상위 top_n & 절대 모멘텀 ≥ +1.2% & 윗꼬리 필터 통과 시 진입, 7일 모멘텀 음전(<0%) 시 청산
  // bot_03: 듀얼 모멘텀
  bot_03({ price, ind, held, params, options = {} }) {
    const info = options.momentumRank?.[options.market];
    if (!info) return hold("모멘텀 순위 산출 대기");
    const absTh = Number(params.abs_momentum_threshold_pct ?? 1.2);
    const topN = Number(params.top_n ?? 2);
    if (held.length > 0) {
      if (info.momPct < 0) return sell(`모멘텀 이탈 (7일 ${fmt(info.momPct)}%)`);
      return hold(`보유 중 (7일 모멘텀 ${fmt(info.momPct)}% / ${info.rank}위)`);
    }
    if (info.rank <= topN && info.momPct >= absTh) {
      const m15 = ind?.m15 || options.indicators?.m15;
      const curPrice = Number(price || options.currentPrice || options.price || 0);
      if (m15 && curPrice > 0) {
        const filter = checkUpperWickAndOverextension(m15.cur || m15.closed, curPrice, m15.ema20, m15.vwap);
        if (!filter.ok) return hold(filter.reason);
      }
      return buy(`듀얼 모멘텀 ${info.rank}위 (7일 +${fmt(info.momPct)}% ≥ +${absTh}%)`);
    }
    return hold(`7일 모멘텀 ${info.rank}위 (${fmt(info.momPct)}%)`);
  },

  // [Antigravity-Doc] bot_04 (BB 스퀴즈 VCP 돌파): 15m 밴드폭 20봉 최저 응축(≤1.1배) 후 거래량 급증 + 상단 돌파 진입, 중심선 하향 이탈 청산
  // bot_04: 볼린저 스퀴즈 돌파
  bot_04({ price, ind, held, params }) {
    const m = ind.m15;
    if (!m || !m.bb) return hold("15분봉 데이터 부족");
    if (held.length > 0) {
      if (price < m.bb.mid) return sell("볼린저 중심선 이탈 청산");
      return hold("보유 중 (중심선 이탈 감시)");
    }
    const bw = m.bandwidthSeries.filter((v) => v !== null);
    if (bw.length < 22) return hold("밴드폭 시계열 부족");
    const recent6Min = Math.min(...bw.slice(-7, -1));
    const min20 = Math.min(...bw.slice(-22, -1));
    const squeezed = recent6Min <= min20 * 1.1;
    const volMult = Number(params.volume_multiplier ?? 1.4);
    const volRatio = Math.max(m.curVolRatio, m.closedVolRatio);
    if (squeezed && volRatio >= volMult && price > m.bb.upper) {
      const filter = checkUpperWickAndOverextension(m.cur || m.closed, price, m.bb.mid, m.vwap);
      if (!filter.ok) return hold(filter.reason);
      return buy(`BB 스퀴즈(밴드폭 ${fmt(recent6Min * 100)}%) 후 거래량 ${fmt(volRatio, 1)}배 상단 돌파`);
    }
    return hold(`스퀴즈 ${squeezed ? "형성" : "미형성"} / 상단 ${ko(m.bb.upper)}`);
  },

  // [Antigravity-Doc] bot_05 (볼린저 역추세 반등): 1h 급락 패닉 차단 + 15m 직전 2봉 저가 BB 하단 터치 + 양봉 복귀 + 최근 3봉 RSI ≤ 32 진입, 보유 중 BB 중심선 도달(+1.2% 이상) 시 회귀 익절
  // bot_05: 볼린저 역추세 반등
  bot_05({ price, ind, held, params }) {
    const m = ind.m15;
    if (!m || !m.bb) return hold("15분봉 데이터 부족");
    if (held.length > 0) {
      const totalCost = held.reduce((acc, p) => acc + Number(p.buy_amount || Number(p.volume || 0) * Number(p.avg_buy_price || 0)), 0);
      const totalVol = held.reduce((acc, p) => acc + Number(p.volume || 0), 0);
      const avgBuyPrice = totalVol > 0 ? totalCost / totalVol : Number(held[0].avg_buy_price || 0);
      const pnlPct = avgBuyPrice > 0 ? pctChange(price, avgBuyPrice) : 0;
      if (price >= m.bb.mid && pnlPct >= 1.2) {
        return sell(`볼린저 중심선 회귀 익절 (+${fmt(pnlPct)}%)`);
      }
      return hold("보유 중 (BB 중심선/+3.5% 익절 · ATR 손절 감시)");
    }
    const h = ind.m60;
    if (h && ((Number.isFinite(h.rsi) && h.rsi < 25) || (h.ema20 > 0 && pctChange(price, h.ema20) < -4.0))) {
      return hold(`1시간봉 급락 패닉 차단 (1h RSI ${fmt(h.rsi ?? 0, 1)}, EMA20 이격 ${fmt(h.ema20 > 0 ? pctChange(price, h.ema20) : 0)}%)`);
    }
    const rsiTh = Number(params.rsi_threshold ?? 32);
    const touched = m.minLow2 <= m.bb.lower;
    if (touched && m.curBullish && price > m.bb.lower && m.rsiMin3 <= rsiTh) {
      return buy(`BB 하단 터치 후 양봉 복귀 · RSI ${fmt(m.rsiMin3, 1)} ≤ ${rsiTh} 과매도 반등`);
    }
    return hold(`BB 하단 ${ko(m.bb.lower)} / RSI ${fmt(m.rsi, 1)} (기준 ≤ ${rsiTh})`);
  },

  // [Antigravity-Doc] bot_06 (다단계 분할 그리드): 1h 급락 패닉 차단 + RSI ≤ 32 & BB 하단 부근 1차 진입 후 -3.0%/-6.0% 하락 시 최대 3차 분할 매수, 개별 포지션 +2.0% 개별 익절
  // bot_06: 다단계 분할 매수 그리드
  bot_06({ price, ind, held, params }) {
    const m = ind.m15;
    const tp = Number(params.take_profit_pct ?? 2.0);
    const maxSplits = Math.max(1, Number(params.max_splits ?? 3));
    const rawRatio = Number(params.order_ratio ?? 0.45);
    const normRatio = Math.min(1, rawRatio > 1 ? rawRatio / 100 : (rawRatio > 0 ? rawRatio : 0.45));
    const splitOrderRatio = normRatio / maxSplits;
    if (held.length > 0) {
      const winners = held.filter((p) => pctChange(price, Number(p.avg_buy_price)) >= tp);
      if (winners.length > 0) {
        return sell(`그리드 개별 익절 (+${tp}% 도달 ${winners.length}건)`, { sellPositionIds: winners.map((p) => p.id) });
      }
      if (held.length < maxSplits) {
        const ref = Number(held.slice().sort((a, b) => a.id - b.id)[0].avg_buy_price);
        const drop = -pctChange(price, ref);
        const step1 = Number(params.grid_step_1_pct ?? 3.0);
        const step2 = Number(params.grid_step_2_pct ?? 6.0);
        if (held.length === 1 && drop >= step1) {
          return buy(`그리드 2차 분할 매수 (최초 대비 -${fmt(drop)}%)`, { splitIndex: 2, order_ratio: splitOrderRatio });
        }
        if (held.length === 2 && drop >= step2) {
          return buy(`그리드 3차 분할 매수 (최초 대비 -${fmt(drop)}%)`, { splitIndex: 3, order_ratio: splitOrderRatio });
        }
      }
      return hold(`그리드 보유 ${held.length}분할`);
    }
    if (!m || !m.bb) return hold("15분봉 데이터 부족");
    const h = ind.m60;
    if (h && ((Number.isFinite(h.rsi) && h.rsi < 25) || (h.ema20 > 0 && pctChange(price, h.ema20) < -4.5))) {
      return hold(`1시간봉 급락 패닉 그리드 진입 차단 (1h RSI ${fmt(h.rsi ?? 0, 1)})`);
    }
    const rsiEntry = Number(params.rsi_entry ?? 32);
    if (m.rsi <= rsiEntry && price <= m.bb.lower * 1.005) {
      return buy(`단기 과매도 그리드 1차 진입 (RSI ${fmt(m.rsi, 1)} ≤ ${rsiEntry}, BB 하단 부근)`, {
        splitIndex: 1,
        order_ratio: splitOrderRatio,
      });
    }
    return hold(`과매도 대기 (RSI ${fmt(m.rsi, 1)} / 기준 ≤ ${rsiEntry})`);
  },

  // [Antigravity-Doc] bot_07 (MACD + RSI 골든크로스): 15m·60m EMA(20>60) 정배열 + 1h EMA20 상회 + MACD 골든크로스·히스토그램 확대 + 거래량 1.05배 + RSI 45~65 진입, 데드크로스 또는 EMA 붕괴 청산
  // bot_07: MACD + RSI 골든크로스
  bot_07({ price, ind, held, params }) {
    const m = ind.m15;
    const h = ind.m60;
    if (!m || !m.macdSeries || !h) return hold("15분/60분봉 데이터 부족");
    const { macd, signal } = m.macdSeries;
    const n = macd.length;
    if (n < 3) return hold("MACD 시계열 부족");
    if (held.length > 0) {
      const crossDown = macd[n - 2] >= signal[n - 2] && macd[n - 1] < signal[n - 1];
      if (crossDown) return sell("MACD 데드크로스 청산");
      if (m.ema20 < m.ema60) return sell("15분봉 EMA 정배열 붕괴 청산");
      return hold("보유 중 (MACD/EMA 감시)");
    }
    const aligned = m.ema20 > m.ema60 && h.ema20 > h.ema60;
    const aboveHtfEma20 = !(h.ema20 > 0) || price >= h.ema20;
    const macdStillAbove = Number.isFinite(macd[n - 1]) && Number.isFinite(signal[n - 1]) && macd[n - 1] > signal[n - 1];
    const histExpanding =
      Number.isFinite(macd[n - 2]) &&
      Number.isFinite(signal[n - 2]) &&
      macd[n - 1] - signal[n - 1] > macd[n - 2] - signal[n - 2];
    const crossUp =
      macdStillAbove &&
      histExpanding &&
      [1, 2].some((back) => macd[n - back - 1] <= signal[n - back - 1] && macd[n - back] > signal[n - back]);
    const volOk = Math.max(Number(m.curVolRatio || 0), Number(m.closedVolRatio || 0)) >= 1.05;
    const rsiMin = Number(params.rsi_min ?? 45);
    const rsiMax = Number(params.rsi_max ?? 65);
    if (aligned && aboveHtfEma20 && crossUp && volOk && m.rsi >= rsiMin && m.rsi <= rsiMax) {
      return buy(`EMA(20>60) 정배열 · 1h지지 · MACD 골든크로스(확대) · RSI ${fmt(m.rsi, 1)}`);
    }
    return hold(`정배열 ${aligned ? "O" : "X"} / 골든크로스 ${crossUp ? "O" : "X"} / 거래량 ${volOk ? "O" : "X"} / RSI ${fmt(m.rsi, 1)}`);
  },

  // [Antigravity-Doc] bot_08 (20일선 눌림목 스윙): 일봉 상승추세(20>60) 또는 4h 정배열(5>20>60) + 일봉/4h 20선 눌림목(-1.5%~+2.5%) 지지 + 거래량 진정/양봉 반등 + 직전고점 상승여력(≥1.2%) 확인 시 진입
  // bot_08: 정배열 20일선 눌림목
  bot_08({ price, ind, held, params }) {
    const d = ind.day;
    const h4 = ind.m240;
    if (!d || !h4 || d.ma60 === null || h4.ma60 === null) return hold("일봉/4시간봉 데이터 부족");
    const minTpPct = Number(params.min_tp_pct ?? 1.2);
    const targetHighPrice = d.recentHigh20 ? d.recentHigh20 * 0.995 : 0;
    if (held.length > 0) {
      const totalCost = held.reduce((acc, p) => acc + Number(p.buy_amount || Number(p.volume || 0) * Number(p.avg_buy_price || 0)), 0);
      const totalVol = held.reduce((acc, p) => acc + Number(p.volume || 0), 0);
      const avgBuyPrice = totalVol > 0 ? totalCost / totalVol : Number(held[0].avg_buy_price || 0);
      const pnlPct = avgBuyPrice > 0 ? pctChange(price, avgBuyPrice) : 0;
      if (targetHighPrice > 0 && price >= targetHighPrice && pnlPct >= minTpPct) {
        return sell(`직전 고점 부근 익절 (+${fmt(pnlPct)}%)`);
      }
      return hold("보유 중 (직전 고점 익절 대기)");
    }
    const dayUpTrend = d.ma20 > d.ma60;
    const h4Aligned = h4.ma5 > h4.ma20 && h4.ma20 > h4.ma60;
    const h4NotBearish = h4.ma20 >= h4.ma60 * 0.985;
    const trendOk = (dayUpTrend || h4Aligned) && h4NotBearish;
    const band = Number(params.pullback_band_pct ?? 2.5);
    const gapDay = pctChange(price, d.ma20);
    const gapH4 = h4.ma20 > 0 ? pctChange(price, h4.ma20) : 999;
    const nearDayMa20 = gapDay >= -1.5 && gapDay <= band;
    const nearH4Ma20 = gapH4 >= -1.5 && gapH4 <= band;
    const nearSupport = nearDayMa20 || nearH4Ma20;
    const volOrBounceOk = h4.lastClosedVolRatio < 1.25 || Boolean(ind.m15?.curBullish);
    const roomToTargetPct = targetHighPrice > 0 && price > 0 ? ((targetHighPrice - price) / price) * 100 : Infinity;
    const hasUpsideRoom = targetHighPrice <= 0 || (price < targetHighPrice && roomToTargetPct >= minTpPct);
    if (trendOk && nearSupport && volOrBounceOk && hasUpsideRoom) {
      const refLabel = nearDayMa20 ? `일봉20선(${fmt(gapDay)}%)` : `4h20선(${fmt(gapH4)}%)`;
      return buy(`상승추세 20선 눌림목 지지 (${refLabel}, 거래량 진정/반등)`);
    }
    return hold(`추세 ${trendOk ? "O" : "X"} / 20선 이격 일봉 ${fmt(gapDay)}% · 4h ${fmt(gapH4)}%`);
  },

  // [Antigravity-Doc] bot_09 (거래량 폭발 스캘퍼): 15m 마감봉 거래량 ≥ 1.4배 양봉 + 추격 상한(+1.5%) & 윗꼬리 필터 통과 시 진입, 최고가 대비 -1.5% 트레일링 청산
  // bot_09: 거래량 폭발 모멘텀 스캘퍼
  bot_09({ price, ind, held, params, options = {} }) {
    const trailPct = Number(params.trailing_stop_pct ?? 1.5);
    if (held.length > 0) {
      const totalCost = held.reduce((acc, p) => acc + Number(p.buy_amount || Number(p.volume || 0) * Number(p.avg_buy_price || 0)), 0);
      const totalVol = held.reduce((acc, p) => acc + Number(p.volume || 0), 0);
      const avgBuyPrice = totalVol > 0 ? totalCost / totalVol : Number(held[0].avg_buy_price || 0);
      const peak = Math.max(Number(options.peakPrice || 0), price);
      const peakPnl = avgBuyPrice > 0 ? pctChange(peak, avgBuyPrice) : 0;
      if (peak > 0 && peakPnl > 0 && price <= peak * (1 - trailPct / 100)) {
        return sell(`고점 대비 -${trailPct}% 트레일링 스탑 (최고 +${fmt(peakPnl)}%)`);
      }
      return hold("보유 중 (트레일링 스탑 감시)");
    }
    const m = ind.m15;
    if (!m) return hold("15분봉 데이터 부족");
    const spike = Number(params.volume_spike_multiplier ?? 1.4);
    const closedClose = Number(m.closed.trade_price);
    if (m.closedVolRatio >= spike && m.closedBullish && price >= closedClose && pctChange(price, closedClose) <= 1.5) {
      const filter = checkUpperWickAndOverextension(m.closed, price, m.ema20, m.vwap);
      if (!filter.ok) return hold(filter.reason);
      return buy(`15분봉 거래량 ${fmt(m.closedVolRatio, 1)}배 폭발 양봉 마감`);
    }
    return hold(`거래량 ${fmt(m.closedVolRatio, 1)}배 (기준 ${spike}배)`);
  },

  // [Antigravity-Doc] bot_10 (Jack Kellogg 프라이스액션): VWAP/LRC(±2σ)/RVOL/기준선 기반 Setup A(추세 돌파 1분할) & Setup B(과매도 반등 2분할) 멀티 레짐 전략
  // bot_10: 잭 켈로그(Jack Kellogg) 프라이스 액션 & VWAP/선형회귀 모멘텀
  bot_10({ price, ind, held, params, options = {} }) {
    const k = ind.kellogg || ind.m15?.kellogg;
    if (!k || !k.lrc || !k.vwap) return hold("잭 켈로그 4대 지표(VWAP/LRC) 데이터 산출 대기");

    const isLive = Boolean(options.isLive);
    const rawRvolBreakout = (isLive ? params.rvol_breakout_live : params.rvol_breakout_arena) ?? params.rvol_breakout;
    const rvolBreakoutTh = Number.isFinite(Number(rawRvolBreakout))
      ? Number(rawRvolBreakout)
      : 1.4;
    const rvolDipTh = Number.isFinite(Number(params.rvol_dip)) ? Number(params.rvol_dip) : 1.3;
    const rawDipGap = (isLive ? params.vwap_gap_live : params.vwap_gap_arena) ?? params.vwap_gap;
    const dipGapTh = Number.isFinite(Number(rawDipGap))
      ? -Math.abs(Number(rawDipGap))
      : -2.0;
    const trailingPct = Number.isFinite(Number(params.trailing_stop_pct)) ? Number(params.trailing_stop_pct) : 1.0;
    const minLrcTpPct = Number.isFinite(Number(params.min_lrc_tp_pct)) ? Number(params.min_lrc_tp_pct) : 1.1;

    // ==========================================
    // 1. 보유 포지션 매도 / 익절 / 손절 평가
    // ==========================================
    if (held.length > 0) {
      const totalCost = held.reduce((acc, p) => acc + Number(p.buy_amount || Number(p.volume) * Number(p.avg_buy_price)), 0);
      const totalVol = held.reduce((acc, p) => acc + Number(p.volume), 0);
      const avgBuyPrice = totalVol > 0 ? totalCost / totalVol : Number(held[0].avg_buy_price);
      const totalPnlPct = pctChange(price, avgBuyPrice);

      const hasExplicitBreakout = held.some((p) => String(p.buy_reason || "").includes("돌파") || String(p.buy_reason || "").includes("Setup A"));
      const hasExplicitDip = held.some((p) => String(p.buy_reason || "").includes("반등") || String(p.buy_reason || "").includes("Setup B"));
      const inferredDip = !hasExplicitBreakout && !hasExplicitDip && (avgBuyPrice < k.vwap || avgBuyPrice <= k.lrc.mid);
      const isBreakout = hasExplicitBreakout || (!hasExplicitDip && !inferredDip);
      const isDip = hasExplicitDip || inferredDip;

      // (1) 기계적 기준선 손절 (Key Level Hard Stop — 손익비 개선: Setup A -1.4%, Setup B -1.8%)
      if (isBreakout) {
        const brokeBelowKeyLevels =
          k.today_open > 0 &&
          avgBuyPrice >= k.today_open &&
          avgBuyPrice >= k.vwap &&
          price < k.today_open * 0.995 &&
          price < k.vwap * 0.995 &&
          totalPnlPct <= -0.8;
        if (brokeBelowKeyLevels || totalPnlPct <= -1.4) {
          return sell(`[Setup A 손절] 당일시가(${ko(k.today_open)}) 및 VWAP(${ko(k.vwap)}) 동시 이탈 / 손절(-1.4%) 청산 (수익률 ${fmt(totalPnlPct)}%)`);
        }
      }

      if (isDip) {
        const brokePrevLow =
          k.prev_low > 0 &&
          avgBuyPrice >= k.prev_low * 1.005 &&
          price < k.prev_low * 0.995 &&
          totalPnlPct <= -1.0;
        if (brokePrevLow) {
          return sell(`[Setup B 손절] 전일 저가(${ko(k.prev_low)}) 하향 이탈 손절 (수익률 ${fmt(totalPnlPct)}%)`);
        }
        if (totalPnlPct <= -1.8) {
          return sell(`[Setup B 손절] 평단가 대비 -1.8% 손절 (수익률 ${fmt(totalPnlPct)}%)`);
        }
      }

      if (!isBreakout && !isDip) {
        if (totalPnlPct <= -1.8) {
          return sell(`[기계적 기준선 손절] 평단가 대비 -1.8% 손절 (수익률 ${fmt(totalPnlPct)}%)`);
        }
      }

      // (2) 선형 회귀 채널 익절 (Take Profit) — 업비트 왕복 수수료(0.1%)·슬리피지를 상회하는 최소 +1.1% 이상 순수익 구간에서만 익절
      if (price >= k.lrc.upper && totalPnlPct >= minLrcTpPct) {
        return sell(`[LRC 상단 익절] +2σ 채널 상단(${ko(k.lrc.upper)}) 도달 전량 익절 (수익률 +${fmt(totalPnlPct)}%)`);
      }
      if (isDip && price >= k.lrc.mid && totalPnlPct >= minLrcTpPct) {
        return sell(`[LRC 중심선 회귀 익절] LRC 중심선(${ko(k.lrc.mid)}) 도달 익절 (수익률 +${fmt(totalPnlPct)}%)`);
      }

      // (3) 대량 거래량 폭발 + 윗꼬리 음봉 (Volume Climax Exhaustion) 청산
      const cur = k.cur;
      const isBearishUpperWick = Number(cur.trade_price) < Number(cur.opening_price) &&
        (Number(cur.high_price) - Number(cur.opening_price)) > Math.abs(Number(cur.opening_price) - Number(cur.trade_price)) * 0.5;
      if (totalPnlPct >= 1.0 && k.rvol >= 2.5 && isBearishUpperWick) {
        return sell(`[거래량 클라이맥스 엑시트] RVOL ${fmt(k.rvol, 1)}배 윗꼬리 음봉 출현 익절 (수익률 +${fmt(totalPnlPct)}%)`);
      }

      // (4) 최고가 대비 -1.0% 트레일링 스탑 (최고 +1.5% 도달 후 수익 반납 방지)
      const peak = Math.max(Number(options.peakPrice || 0), price);
      const peakPnl = pctChange(peak, avgBuyPrice);
      if (peakPnl >= 1.5 && price <= peak * (1 - trailingPct / 100)) {
        return sell(`[트레일링 스탑] 고점 대비 -${trailingPct}% 반락 익절 (수익률 ${totalPnlPct >= 0 ? "+" : ""}${fmt(totalPnlPct)}%)`);
      }

      // (5) Setup B 2차 분할 매수 (Scaling-In): -1.8% 손절 이전(-1.2%~-1.8%) 전일 저가 지지 반등 시 추가 분할 매수
      if (isDip && held.length === 1) {
        const firstBuyPrice = Number(held[0].avg_buy_price);
        const dropPct = pctChange(price, firstBuyPrice);
        const hasRebound = k.curBullish || price > Number(k.closed.trade_price);
        if (dropPct <= -1.2 && totalPnlPct > -1.8 && hasRebound && (k.prev_low === 0 || price >= k.prev_low)) {
          return buy(`[Setup B 2차 분할 매수] 1차 진입가 대비 ${fmt(dropPct)}% 추가 하락 지지 반등 분할 매수 (Scaling-In)`, {
            setup: "B",
            splitIndex: 2,
            order_ratio: 0.15,
          });
        }
      }

      return hold(`잭 켈로그 포지션 감시 중 (수익률 ${fmt(totalPnlPct)}%, LRC ${ko(k.lrc.lower)} ~ ${ko(k.lrc.upper)})`);
    }

    // ==========================================
    // 2. 신규 매수 진입 평가 (Setup A & Setup B)
    // ==========================================

    // Setup A [Breakout Long - 추세 돌파 진입]
    const roomToUpperPct = price > 0 ? ((k.lrc.upper - price) / price) * 100 : 0;
    const setupA_trend = (k.today_open > 0 ? price > k.today_open : true) && price > k.vwap;
    const setupA_slope = k.lrc.slope > 0 && price < k.lrc.upper && roomToUpperPct >= minLrcTpPct;
    const setupA_break = (k.recent_high_20 > 0 && price >= k.recent_high_20 * 0.998) ||
                         (k.prev_high > 0 && price >= k.prev_high * 0.998);
    const setupA_vol = k.rvol >= rvolBreakoutTh;

    if (setupA_trend && setupA_slope && setupA_break && setupA_vol) {
      return buy(
        `[Setup A 돌파] VWAP 지지(${ko(k.vwap)}) & 전고점 돌파 · RVOL ${fmt(k.rvol, 1)}배 · LRC 기울기 +${fmt(k.lrc.slope, 2)}`,
        {
          setup: "A",
          splitIndex: 1,
          order_ratio: 0.3,
        }
      );
    }

    // Setup B [Dip Reversion Long - 과매도 이격 반등 1차 진입]
    // 이미 LRC 중심선(목표 익절선) 이상이거나 기대 회귀 폭이 최소 순익절 기준 미만이면 진입 금지
    const roomToMidPct = price > 0 ? ((k.lrc.mid - price) / price) * 100 : 0;
    const minLow = Math.min(Number(k.cur.low_price || price), Number(k.closed.low_price || price));
    const setupB_dip = k.vwap_disparity_pct <= dipGapTh;
    const setupB_lrc = minLow <= k.lrc.lower * 1.002 && price < k.lrc.mid && roomToMidPct >= minLrcTpPct;
    const setupB_rebound = k.curBullish || price > Number(k.closed.trade_price);
    const setupB_vol = k.rvol >= rvolDipTh;

    if (setupB_dip && setupB_lrc && setupB_rebound && setupB_vol) {
      return buy(
        `[Setup B 반등 1차] LRC 하단(-2σ ${ko(k.lrc.lower)}) 터치 반등 · VWAP 이격 ${fmt(k.vwap_disparity_pct)}% · RVOL ${fmt(k.rvol, 1)}배`,
        {
          setup: "B",
          splitIndex: 1,
          order_ratio: 0.15,
        }
      );
    }

    return hold(
      `잭 켈로그 시그널 대기 (VWAP 이격 ${fmt(k.vwap_disparity_pct)}%, LRC 기울기 ${fmt(k.lrc.slope, 2)}, RVOL ${fmt(k.rvol, 1)}배)`
    );
  },
};

/**
 * [Antigravity-Doc] 10개 봇 공통 전략 평가 엔트리포인트 (순수 수식·기술적 지표 기반, 실전/가상/백테스트 공용)
 * - `mtfTrendBots`(`bot_01`/`02`/`03`/`04`/`07`/`09`)는 `enforceMtf !== false`일 때 상위 타임프레임(1h/4h)이
 *   강한 하락 추세(`htfStronglyBearish`)면 신규 BUY를 자동 차단하여 역추세 물림을 방지한다.
 * @param {string} botId       bot_01 ~ bot_10 (구버전 ID 자동 정규화)
 * @param {object} marketData  { market, price, ticker, candles: { day, m240, m60, m15 } }
 * @param {object} indicators  buildIndicators(marketData) 결과
 * @param {Array|object|null} position 해당 마켓의 보유 OPEN 포지션(들)
 * @param {object} options     { params, peakPrice, momentumRank, market, isLive, enforceMtf }
 * @returns {{signal: "BUY"|"SELL"|"HOLD", reason: string, splitIndex?: number, sellPositionIds?: number[]}}
 */
export function evaluateStrategy(botId, marketData, indicators, position, options = {}) {
  const normId = normalizeBotId(botId);
  const fn = STRATEGIES[normId];
  if (!fn) return hold("알 수 없는 봇");
  const price = Number(marketData?.price || 0);
  if (!(price > 0)) return hold("현재가 없음");
  const heldList = Array.isArray(position) ? position : position ? [position] : [];
  try {
    const resolvedInd = indicators || buildIndicators(marketData);
    const res = fn({
      price,
      marketData,
      ind: resolvedInd,
      held: heldList,
      params: options.params || {},
      options: { ...options, market: options.market || marketData?.market },
    });
    const mtfTrendBots = new Set(["bot_01", "bot_02", "bot_03", "bot_04", "bot_07", "bot_09"]);
    if (
      res?.signal === "BUY" &&
      heldList.length === 0 &&
      mtfTrendBots.has(normId) &&
      options?.enforceMtf !== false &&
      resolvedInd?.mtf?.htfStronglyBearish
    ) {
      return hold("MTF 상위 타임프레임(1시간/4시간) 하락 추세 역행 진입 차단");
    }
    return res;
  } catch (err) {
    console.warn(`[evaluateStrategy][${normId}][${options.market || marketData?.market || ""}] 지표 계산 오류:`, err?.message || err);
    return hold(`지표 계산 오류: ${err.message}`);
  }
}

// ============================================================================
// 5. 캔들 캐시 (업비트 Rate Limit 방어: 마켓·주기별 TTL 공유 캐시)
// ============================================================================
// [Antigravity-Doc] 업비트 Rate Limit 방어용 4개 타임프레임별 캔들 조회 스펙 및 TTL 공유 캐시 맵
const CANDLE_UNITS = [
  { key: "day", unit: "days", count: 65, ttlMs: 5 * 60 * 1000 },
  { key: "m240", unit: "minutes/240", count: 65, ttlMs: 2 * 60 * 1000 },
  { key: "m60", unit: "minutes/60", count: 80, ttlMs: 60 * 1000 },
  { key: "m15", unit: "minutes/15", count: 100, ttlMs: 25 * 1000 },
];
const candleCache = new Map();

/** [Antigravity-Doc] 마켓·단위별 TTL 캐시 적중 시 즉시 반환하고 만료 시 `fetchCandlesFn` 호출 (실패 시 직전 캐시 폴백) */
async function getCandlesCached(market, spec, fetchCandlesFn) {
  const cacheKey = `${market}|${spec.unit}`;
  const hit = candleCache.get(cacheKey);
  const nowMs = Date.now();
  if (hit && nowMs - hit.at < spec.ttlMs) return hit.rows;
  let rows = [];
  try {
    rows = await fetchCandlesFn(market, spec.unit, spec.count);
  } catch (err) {
    console.warn(`[CandlesCache][${market}][${spec.unit}] 캔들 조회 실패:`, err?.message || err);
  }
  if (Array.isArray(rows) && rows.length > 0) {
    candleCache.set(cacheKey, { at: nowMs, rows });
    return rows;
  }
  return hit ? hit.rows : [];
}

/** [Antigravity-Doc] 마켓별 최신 티커 + 4종 캔들(day/m240/m60/m15) + 통합 지표 패키지(`buildIndicators`) 조립 */
export async function buildMarketData(market, ticker, fetchCandlesFn) {
  const candles = {};
  for (const spec of CANDLE_UNITS) {
    candles[spec.key] = await getCandlesCached(market, spec, fetchCandlesFn);
  }
  const price = Number(ticker?.trade_price || 0);
  const md = { market, price, ticker, candles };
  md.indicators = buildIndicators(md);
  return md;
}

// ============================================================================
// 6. 쿨다운 / 트레일링 고점 추적 (인메모리)
// ============================================================================
// [Antigravity-Doc] 가상거래 인메모리 상태: 재진입 쿨다운(cooldownMap), 포지션별 최고가(peakMap), 직전 시세 캐시(lastPriceMap)
const cooldownMap = new Map();
const peakMap = new Map();
let lastPriceMap = new Map();
let lastCycleAt = "";
let lastCycleSummary = "";

/** [Antigravity-Doc] 포지션별 트레일링 스탑 기준 최고가(`peakMap`) 단조 증가 갱신 */
export function updatePeakPrice(key, price, initial = 0) {
  const prev = Number(peakMap.get(key) || initial || 0);
  const next = Math.max(prev, Number(price || 0));
  peakMap.set(key, next);
  return next;
}

// ============================================================================
// 7. DB 스키마 보강 / 10대 봇 시드 / 구버전 봇 ID 마이그레이션
// ============================================================================
async function columnNames(db, table) {
  try {
    const rows = await db.prepare(`SELECT column_name AS name FROM information_schema.columns WHERE table_name = '${table}'`).all();
    return rows.map((r) => r.name);
  } catch {
    return [];
  }
}

async function addColumnSafe(db, table, name, ddl) {
  const cols = await columnNames(db, table);
  if (cols.includes(name)) return;
  try {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} ${ddl}`);
  } catch (err) {
    if (!/duplicate column/i.test(String(err.message))) {
      console.warn(`[Arena] ALTER TABLE ${table} ADD COLUMN ${name} 실패:`, err.message);
    }
  }
}

/** [Antigravity-Doc] `bots`·`paper_trades`·`paper_bot_positions`·`bot_positions` 테이블의 Arena 확장 컬럼 안전 마이그레이션 */
export async function ensureArenaSchema(db) {
  const cols = await columnNames(db, "bots");
  const hadSelectionColumn = cols.includes("is_selected_for_live");
  await addColumnSafe(db, "bots", "is_selected_for_live", "INTEGER NOT NULL DEFAULT 0");
  await addColumnSafe(db, "bots", "strategy_group", "TEXT DEFAULT 'TREND_SWING'");
  await addColumnSafe(db, "bots", "paper_initial_capital", `BIGINT NOT NULL DEFAULT ${DEFAULT_PAPER_CAPITAL}`);
  await addColumnSafe(db, "bots", "paper_virtual_krw", `BIGINT NOT NULL DEFAULT ${DEFAULT_PAPER_CAPITAL}`);
  await addColumnSafe(db, "bots", "paper_is_running", "INTEGER NOT NULL DEFAULT 1");
  await addColumnSafe(db, "bots", "paper_peak_equity", `BIGINT NOT NULL DEFAULT ${DEFAULT_PAPER_CAPITAL}`);
  await addColumnSafe(db, "bots", "paper_mdd_pct", "NUMERIC(8,2) NOT NULL DEFAULT 0");
  await addColumnSafe(db, "bots", "paper_status_msg", "TEXT NOT NULL DEFAULT '시그널 대기 중'");
  await addColumnSafe(db, "paper_trades", "buy_reason", "TEXT");
  await addColumnSafe(db, "paper_trades", "sell_reason", "TEXT");
  await addColumnSafe(db, "paper_bot_positions", "buy_reason", "TEXT");
  await addColumnSafe(db, "bot_positions", "buy_reason", "TEXT");
  return { hadSelectionColumn };
}

/**
 * [Antigravity-Doc] 10대 알고리즘 봇 마스터 시드 및 구버전 봇 ID(`bot_volatility` 등) 원장 일괄 마이그레이션
 * - 기존 사용자 커스텀 파라미터는 보존하고 누락된 신규 키만 기본값으로 보충하며, 모든 봇의 `paper_is_running = 1`을 보장한다.
 */
export async function seedArenaBots(db, { hadSelectionColumn = true } = {}) {
  const now = nowKSTString();
  const existingRows = await db.prepare("SELECT bot_id FROM bots").all();
  const existingBefore = existingRows.map((r) => r.bot_id);
  const isFreshInstall = existingBefore.length === 0;
  const renamed = [];

  const ledgerTables = ["trades", "bot_positions", "paper_trades", "paper_bot_positions"];
  for (const def of ARENA_BOT_DEFS) {
    for (const legacyId of def.legacy_ids) {
      const legacy = await db.prepare("SELECT bot_id FROM bots WHERE bot_id = ?").get(legacyId);
      const already = await db.prepare("SELECT bot_id FROM bots WHERE bot_id = ?").get(def.bot_id);
      if (legacy && !already) {
        await db.prepare("UPDATE bots SET bot_id = ? WHERE bot_id = ?").run(def.bot_id, legacyId);
        renamed.push(def.bot_id);
      } else if (legacy && already) {
        await db.prepare("DELETE FROM bots WHERE bot_id = ?").run(legacyId);
      }
      for (const t of ledgerTables) {
        await db.prepare(`UPDATE ${t} SET bot_id = ? WHERE bot_id = ?`).run(def.bot_id, legacyId);
      }
    }
  }

  const insertBot = db.prepare(`
    INSERT OR IGNORE INTO bots (
      bot_id, name, nickname, strategy_type, strategy_group, description,
      allocation_ratio, allocated_capital, virtual_krw, is_running,
      min_volume_krw, stop_loss_pct, take_profit_pct, config_json,
      last_status_msg, updated_at,
      is_selected_for_live, paper_initial_capital, paper_virtual_krw, paper_is_running,
      paper_peak_equity, paper_mdd_pct, paper_status_msg
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?, '대기 중', ?, 0, ?, ?, 1, ?, 0, '시그널 대기 중')
  `);
  for (const def of ARENA_BOT_DEFS) {
    await insertBot.run(
      def.bot_id,
      def.name,
      def.nickname,
      def.strategy_type,
      def.strategy_group_code,
      def.description,
      def.min_volume_krw,
      def.stop_loss_pct,
      def.take_profit_pct,
      JSON.stringify(def.config),
      now,
      DEFAULT_PAPER_CAPITAL,
      DEFAULT_PAPER_CAPITAL,
      DEFAULT_PAPER_CAPITAL
    );
  }

  // 비어 있는 설정값은 추천값으로 보충 (사용자 수정값은 보존)
  const fillEmpty = db.prepare(`
    UPDATE bots
    SET nickname = CASE WHEN nickname = '' THEN ? ELSE nickname END,
        description = CASE WHEN description = '' THEN ? ELSE description END,
        min_volume_krw = CASE WHEN min_volume_krw = 0 THEN ? ELSE min_volume_krw END,
        stop_loss_pct = CASE WHEN stop_loss_pct = 0 THEN ? ELSE stop_loss_pct END,
        take_profit_pct = CASE WHEN take_profit_pct = 0 THEN ? ELSE take_profit_pct END
    WHERE bot_id = ?
  `);
  const updateIdentity = db.prepare("UPDATE bots SET name = ?, strategy_type = ?, strategy_group = ?, description = ? WHERE bot_id = ?");
  for (const def of ARENA_BOT_DEFS) {
    await fillEmpty.run(def.nickname, def.description, def.min_volume_krw, def.stop_loss_pct, def.take_profit_pct, def.bot_id);
    await updateIdentity.run(def.name, def.strategy_type, def.strategy_group_code, def.description, def.bot_id);
    // 기존 config_json 에 누락된 신규 파라미터만 기본값으로 보충
    const row = await db.prepare("SELECT config_json FROM bots WHERE bot_id = ?").get(def.bot_id);
    let cfg = {};
    try {
      cfg = JSON.parse(row?.config_json || "{}");
    } catch {}
    let changed = false;
    for (const [k, v] of Object.entries(def.config)) {
      if (cfg[k] === undefined || cfg[k] === null || cfg[k] === "") {
        cfg[k] = v;
        changed = true;
      }
    }
    if (changed) {
      await db.prepare("UPDATE bots SET config_json = ? WHERE bot_id = ?").run(JSON.stringify(cfg), def.bot_id);
    }
  }

  // 가상거래 상시 가동(항상 1) 보장
  await db.prepare("UPDATE bots SET paper_is_running = 1").run();

  // bot_10 잭 켈로그 전략명/별명 마이그레이션 적용
  await db.prepare(`
    UPDATE bots
    SET nickname = '잭 켈로그 프라이스액션',
        name = '잭 켈로그 프라이스액션 (Jack Kellogg Price Action)',
        strategy_type = 'JACK_KELLOGG_PRICE_ACTION',
        min_volume_krw = 5000000000
    WHERE bot_id = 'bot_10' AND (nickname = 'VWAP봇-이오타' OR nickname = '' OR nickname LIKE '%이오타%' OR name LIKE '%RSI%')
  `).run();

  // 실전 담당 봇 초기 선택 (기존 실전 3대 봇: 돌파봇-알파 40%, 모멘텀봇-베타 40%, 볼린저봇-감마 20%)
  const selectedCountRow = await db.prepare("SELECT COUNT(*) AS cnt FROM bots WHERE is_selected_for_live = 1").get();
  const selectedCount = Number(selectedCountRow?.cnt || 0);
  if (isFreshInstall || !hadSelectionColumn || selectedCount === 0) {
    await db.prepare("UPDATE bots SET is_selected_for_live = 0").run();
    await db.prepare("UPDATE bots SET is_selected_for_live = 1, is_running = 1, allocation_ratio = 40 WHERE bot_id = 'bot_01'").run();
    await db.prepare("UPDATE bots SET is_selected_for_live = 1, is_running = 1, allocation_ratio = 40 WHERE bot_id = 'bot_03'").run();
    await db.prepare("UPDATE bots SET is_selected_for_live = 1, is_running = 1, allocation_ratio = 20 WHERE bot_id = 'bot_05'").run();
  }
  // 미선택 봇은 실전 가동 금지
  await db.prepare("UPDATE bots SET is_running = 0 WHERE is_selected_for_live != 1").run();
  return { isFreshInstall, renamed };
}

// ============================================================================
// 8. 가상 체결 (paper_trades / paper_bot_positions 원장 전용)
// ============================================================================
/** [Antigravity-Doc] 가상거래 가용 현금 계산: `초기시드 + 누적 실현손익 - 현재 OPEN 포지션 매수원금(수수료 포함)` */
async function computePaperCash(db, botId, initial) {
  const pnl = await db
    .prepare("SELECT COALESCE(SUM(profit_krw), 0) AS p FROM paper_trades WHERE bot_id = ? AND status = 'COMPLETED'")
    .get(botId);
  const open = await db
    .prepare("SELECT COALESCE(SUM(buy_amount + buy_fee), 0) AS inv FROM paper_bot_positions WHERE bot_id = ? AND status = 'OPEN'")
    .get(botId);
  return Math.max(0, Math.floor(Number(initial) + Number(pnl?.p || 0) - Number(open?.inv || 0)));
}

/** [Antigravity-Doc] 가상 매수 체결: `Math.floor(budget / 1.0005)`로 원금·0.05% 수수료 분리 후 `paper_trades`/`paper_bot_positions` 기록 */
async function paperBuy(db, bot, market, price, budgetKrw, reason) {
  const safePrice = Number(price);
  const safeBudget = Number(budgetKrw);
  if (!Number.isFinite(safePrice) || safePrice <= 0 || !Number.isFinite(safeBudget) || safeBudget <= 0) {
    return null;
  }
  const buyAmount = Math.floor(safeBudget / (1 + PAPER_FEE_RATE));
  if (!Number.isFinite(buyAmount) || buyAmount < PAPER_MIN_ORDER_KRW) return null;
  const fee = Math.floor(buyAmount * PAPER_FEE_RATE);
  const flooredVol = Math.floor((buyAmount / safePrice) * 1e8) / 1e8;
  if (!Number.isFinite(flooredVol) || flooredVol <= 0) return null;
  const volume = flooredVol.toFixed(8);
  const now = nowKSTString();
  const uuid = `paper-bid-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const tr = await db
    .prepare(`
      INSERT INTO paper_trades (bot_id, market, buy_order_uuid, buy_price, buy_volume, buy_amount, buy_date, status, buy_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'HOLDING', ?)
    `)
    .run(bot.bot_id, market, uuid, safePrice, volume, buyAmount, now, reason);
  const tradeId = Number(tr.lastInsertRowid);
  const pr = await db
    .prepare(`
      INSERT INTO paper_bot_positions (bot_id, market, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id, status, created_at, buy_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)
    `)
    .run(bot.bot_id, market, uuid, volume, safePrice, buyAmount, fee, tradeId, now, reason || null);
  return { positionId: Number(pr.lastInsertRowid), tradeId, buyAmount, fee, volume, uuid };
}

/** [Antigravity-Doc] 가상 매도 체결: 포지션별 0.05% 매도 수수료 반영 정산 + `cooldownMap` 15분 재진입 쿨다운 등록 */
async function paperSell(db, bot, positions, price, reason) {
  const safePrice = Number(price);
  if (!Number.isFinite(safePrice) || safePrice <= 0 || !Array.isArray(positions) || positions.length === 0) {
    return 0;
  }
  const now = nowKSTString();
  const sellUuid = `paper-ask-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  let totalProfit = 0;
  for (const p of positions) {
    const pVol = Number(p.volume) || 0;
    const buyAmt = Number(p.buy_amount) || 0;
    const buyFee = Number(p.buy_fee) || 0;
    const gross = Math.floor(pVol * safePrice);
    const fee = Math.floor(gross * PAPER_FEE_RATE);
    const net = gross - fee;
    const profit = net - buyAmt - buyFee;
    const rawPct = buyAmt > 0 ? (profit / buyAmt) * 100 : 0;
    const profitPct = Number.isFinite(rawPct) ? Number(rawPct.toFixed(2)) : 0;
    const posRes = await db
      .prepare("UPDATE paper_bot_positions SET status = 'CLOSED', closed_at = ? WHERE id = ? AND status = 'OPEN'")
      .run(now, p.id);
    if (!posRes?.changes) {
      peakMap.delete(`paper-${p.id}`);
      continue;
    }
    if (Number.isFinite(profit)) totalProfit += profit;
    await db.prepare(`
      UPDATE paper_trades
      SET sell_order_uuid = ?, sell_price = ?, sell_volume = ?, sell_amount = ?, sell_date = ?,
          profit_krw = ?, profit_pct = ?, status = 'COMPLETED', sell_reason = ?
      WHERE id = ? AND status = 'HOLDING'
    `).run(sellUuid, safePrice, String(p.volume), gross, now, profit, profitPct, reason, p.trade_id);
    peakMap.delete(`paper-${p.id}`);
  }
  cooldownMap.set(`${bot.bot_id}|${positions[0].market}`, Date.now());
  return totalProfit;
}

function parseCfg(bot) {
  let cfg = {};
  try {
    cfg = JSON.parse(bot.config_json || "{}");
  } catch {}
  return cfg;
}

function normalizedOrderRatio(cfg, fallback = 0.3) {
  const raw = Number(cfg.order_ratio ?? fallback);
  if (!(raw > 0)) return fallback;
  return Math.min(1, raw > 1 ? raw / 100 : raw);
}

const COOLDOWN_MS = 15 * 60 * 1000;

/**
 * [Antigravity-Doc] 단일 가상 봇의 1사이클 평가 및 가상 체결 실행기 (`paper_trades`/`paper_bot_positions` 전용)
 * - (1) 보유 포지션 청산: 포지션별 독립 고점(`perPosPeak`)으로 3단계 스마트 청산 → 고정 SL/TP → 전략 SELL 시그널 순으로 평가.
 * - (2) 신규/분할 진입: 동일 사이클 매도 마켓 및 15분 쿨다운 마켓 제외, 호가 품질 가드(`analyzeOrderbookQuality`) 통과 시 가상 매수.
 */
export async function runPaperBot(db, bot, ctx) {
  const { mdMap, universe, rankMap, tickerMap, getOrderbook } = ctx;
  const cfg = parseCfg(bot);
  const params = {
    ...cfg,
    stop_loss_pct: bot.stop_loss_pct,
    take_profit_pct: bot.take_profit_pct,
  };
  const initial = Number(bot.paper_initial_capital || DEFAULT_PAPER_CAPITAL);
  const stopLoss = -Math.abs(Number(bot.stop_loss_pct || 2.5));
  const takeProfit = Math.abs(Number(bot.take_profit_pct || 4.5));
  const minVol = Number(bot.min_volume_krw || 0);
  const maxMarkets = Math.max(1, Number(cfg.max_positions || 3));
  let lastAction = "";
  let firstNote = "";

  // --- (1) 보유 포지션 청산 평가 (공통 손절/익절 + 알고리즘 청산 시그널) ---
  const openPositions = await db
    .prepare("SELECT * FROM paper_bot_positions WHERE bot_id = ? AND status = 'OPEN' ORDER BY id ASC")
    .all(bot.bot_id);
  const byMarket = new Map();
  for (const p of openPositions) {
    if (!byMarket.has(p.market)) byMarket.set(p.market, []);
    byMarket.get(p.market).push(p);
  }

  const soldMarketsThisCycle = new Set();
  for (const [market, group] of byMarket) {
    const md = mdMap.get(market);
    const price = Number(md?.price || tickerMap.get(market)?.trade_price || 0);
    if (!(price > 0)) continue;
    let groupPeak = 0;
    const perPosPeak = new Map();
    for (const p of group) {
      const pPeak = updatePeakPrice(`paper-${p.id}`, price, Number(p.avg_buy_price));
      perPosPeak.set(p.id, pPeak);
      groupPeak = Math.max(groupPeak, pPeak);
    }
    const remaining = [];
    for (const p of group) {
      // 3단계 스마트 청산 유틸리티 — 반드시 개별 포지션 고유 고점(posPeak)을 전달하여 다중 분할(bot_06/bot_10) 즉시 본절 청산 루프 방지
      const smartExit = evaluateSmartExit({
        botId: bot.bot_id,
        position: p,
        currentPrice: price,
        indicators: md?.indicators,
        peakPrice: perPosPeak.get(p.id) || Number(p.avg_buy_price),
        isLive: false,
        stopLossPct: stopLoss,
      });
      if (smartExit && smartExit.signal === "SELL") {
        const profit = await paperSell(db, bot, [p], price, smartExit.reason);
        soldMarketsThisCycle.add(market);
        lastAction = `[가상매도] ${market} ${smartExit.reason} (${profit >= 0 ? "+" : ""}${ko(profit)}원)`;
        continue;
      }

      const pnl = pctChange(price, Number(p.avg_buy_price));
      if (pnl <= stopLoss) {
        const profit = await paperSell(db, bot, [p], price, `손절(${fmt(pnl)}%)`);
        soldMarketsThisCycle.add(market);
        lastAction = `[가상매도] ${market} 손절 (${profit >= 0 ? "+" : ""}${ko(profit)}원)`;
      } else if (pnl >= takeProfit) {
        const profit = await paperSell(db, bot, [p], price, `익절(+${fmt(pnl)}%)`);
        soldMarketsThisCycle.add(market);
        lastAction = `[가상매도] ${market} 익절 (+${ko(profit)}원)`;
      } else {
        remaining.push(p);
      }
    }
    if (remaining.length > 0 && md) {
      const sig = evaluateStrategy(bot.bot_id, md, md.indicators, remaining, {
        params,
        peakPrice: groupPeak,
        momentumRank: rankMap,
        market,
      });
      if (sig.signal === "SELL") {
        const targets = sig.sellPositionIds ? remaining.filter((p) => sig.sellPositionIds.includes(p.id)) : remaining;
        if (targets.length > 0) {
          const profit = await paperSell(db, bot, targets, price, sig.reason);
          soldMarketsThisCycle.add(market);
          lastAction = `[가상매도] ${market} ${sig.reason} (${profit >= 0 ? "+" : ""}${ko(profit)}원)`;
        }
      }
    }
  }

  // --- (2) 신규 진입 평가 ---
  let cash = await computePaperCash(db, bot.bot_id, initial);
  const nowHolds = await db
    .prepare("SELECT * FROM paper_bot_positions WHERE bot_id = ? AND status = 'OPEN' ORDER BY id ASC")
    .all(bot.bot_id);
  const heldByMarket = new Map();
  for (const p of nowHolds) {
    if (!heldByMarket.has(p.market)) heldByMarket.set(p.market, []);
    heldByMarket.get(p.market).push(p);
  }

  let candidates = universe.filter((m) => {
    const tk = tickerMap.get(m);
    return tk && Number(tk.acc_trade_price_24h || 0) >= minVol && mdMap.get(m);
  });
  if (bot.bot_id === "bot_03") {
    candidates = candidates.sort((a, b) => (rankMap[a]?.rank || 99) - (rankMap[b]?.rank || 99));
  }

  const canScaleIn = bot.bot_id === "bot_06" || bot.bot_id === "bot_10";
  for (const market of candidates) {
    if (soldMarketsThisCycle.has(market)) continue;
    const held = heldByMarket.get(market) || [];
    if (held.length > 0 && !canScaleIn) continue;
    if (bot.bot_id === "bot_10" && held.length >= 2) continue;
    if (held.length === 0 && heldByMarket.size >= maxMarkets) continue;
    const cdAt = cooldownMap.get(`${bot.bot_id}|${market}`) || 0;
    if (held.length === 0 && Date.now() - cdAt < COOLDOWN_MS) continue;

    const md = mdMap.get(market);
    const sig = evaluateStrategy(bot.bot_id, md, md.indicators, held, {
      params,
      momentumRank: rankMap,
      market,
      isLive: false,
    });
    if (!firstNote && sig.signal === "HOLD") firstNote = `${market.replace("KRW-", "")}: ${sig.reason}`;
    if (sig.signal !== "BUY") continue;

    let ratio = normalizedOrderRatio(cfg, 0.3);
    if (sig.order_ratio) {
      ratio = Number(sig.order_ratio);
    } else if (bot.bot_id === "bot_06") {
      ratio = ratio / Math.max(1, Number(cfg.max_splits || 3));
    }
    // paperBuy 내부에서 (1 + PAPER_FEE_RATE) 수수료 완충 나눗셈을 1회만 수행하므로 여기서는 원금 상한만 전달
    const budget = Math.min(Math.floor(initial * ratio), Math.floor(cash));
    if (Math.floor(budget / (1 + PAPER_FEE_RATE)) < PAPER_MIN_ORDER_KRW) break;
    const candidateOb = md?.orderbook || (typeof getOrderbook === "function" ? getOrderbook(market) : null);
    if (candidateOb) {
      const obQuality = analyzeOrderbookQuality(candidateOb, budget, { botId: bot.bot_id });
      if (obQuality.blocked) {
        if (!firstNote) {
          firstNote = `${market.replace("KRW-", "")}: [호가 품질 가드] ${obQuality.reason}`;
        }
        continue;
      }
    }
    const filled = await paperBuy(db, bot, market, md.price, budget, sig.reason);
    if (filled) {
      lastAction = `[가상매수] ${market} ${sig.reason} (${ko(filled.buyAmount)}원)`;
      break;
    }
  }

  return lastAction || (firstNote ? `감시 중 · ${firstNote}` : "시그널 대기 중");
}

// ============================================================================
// 9. 리더보드 / 통계 산출
// ============================================================================
/** [Antigravity-Doc] 단일 봇의 가상거래 누적 평가자산·실현/미실현 손익·수익률·승률·보유 포지션 목록 집계 */
async function computeBotArenaStats(db, bot) {
  const rawInitial = Number(bot.paper_initial_capital || DEFAULT_PAPER_CAPITAL);
  const initial = Number.isFinite(rawInitial) && rawInitial > 0 ? rawInitial : DEFAULT_PAPER_CAPITAL;
  const closed = await db
    .prepare("SELECT profit_krw FROM paper_trades WHERE bot_id = ? AND status = 'COMPLETED'")
    .all(bot.bot_id);
  let realized = 0;
  let wins = 0;
  let loses = 0;
  for (const t of closed) {
    const p = Number(t.profit_krw || 0);
    if (Number.isFinite(p)) realized += p;
    if (p > 0) wins++;
    else if (p < 0) loses++;
  }
  const open = await db
    .prepare("SELECT * FROM paper_bot_positions WHERE bot_id = ? AND status = 'OPEN' ORDER BY id ASC")
    .all(bot.bot_id);
  let openCost = 0;
  let openEval = 0;
  const openList = [];
  for (const p of open) {
    const buyAmt = Number(p.buy_amount || 0);
    const buyFee = Number(p.buy_fee || 0);
    openCost += (Number.isFinite(buyAmt) ? buyAmt : 0) + (Number.isFinite(buyFee) ? buyFee : 0);
    const tk = lastPriceMap.get(p.market);
    const avgBuy = Number(p.avg_buy_price) || 0;
    const cur = Number(tk?.trade_price) > 0 ? Number(tk.trade_price) : avgBuy;
    const pVol = Number(p.volume) || 0;
    const evalKrw = Number.isFinite(pVol * cur) ? Math.floor(pVol * cur) : 0;
    openEval += evalKrw;
    const rawPnlPct = avgBuy > 0 ? pctChange(cur, avgBuy) : 0;
    openList.push({
      id: p.id,
      market: p.market,
      avg_buy_price: avgBuy,
      current_price: cur,
      volume: p.volume,
      buy_amount: buyAmt,
      eval_krw: evalKrw,
      pnl_pct: Number.isFinite(rawPnlPct) ? Number(rawPnlPct.toFixed(2)) : 0,
      created_at: p.created_at,
    });
  }
  const cash = Math.max(0, Math.floor(initial + realized - openCost));
  const evalAssets = cash + openEval;
  const profitKrw = evalAssets - initial;
  const decided = wins + loses;
  const rawProfitRate = initial > 0 ? (profitKrw / initial) * 100 : 0;
  const rawWinRate = decided > 0 ? (wins / decided) * 100 : 0;
  return {
    bot_id: bot.bot_id,
    initial_capital: initial,
    cash_krw: Number.isFinite(cash) ? cash : 0,
    eval_assets_krw: Number.isFinite(evalAssets) ? evalAssets : initial,
    cumulative_profit_krw: Number.isFinite(profitKrw) ? profitKrw : 0,
    profit_rate_pct: Number.isFinite(rawProfitRate) ? Number(rawProfitRate.toFixed(2)) : 0.0,
    realized_profit_krw: Number.isFinite(realized) ? realized : 0,
    unrealized_profit_krw: Number.isFinite(openEval - openCost) ? openEval - openCost : 0,
    win_trades: wins,
    lose_trades: loses,
    total_trades: closed.length,
    win_rate_pct: Number.isFinite(rawWinRate) ? Number(rawWinRate.toFixed(1)) : 0.0,
    open_positions_count: open.length,
    open_positions: openList,
  };
}

function normalizeTimestampForCompare(v) {
  return String(v || "").replace("T", " ").slice(0, 19);
}

/**
 * 3대 전략군(TREND_SWING / VOLATILITY_BREAKOUT / REVERSAL_GRID) 주간 성과 평가 및 그룹별 1위 챔피언 선출
 * - 최근 7일 가상 실현손익 + 보유 포지션 미실현손익 기반 weekly_return_pct 계산
 * - 그룹 내 모든 봇의 7일 거래 횟수가 0회인 경우 Arena 누적 수익률(profit_rate_pct)로 안전 Fallback
 * - rotation_score = eval_return_pct - (|mdd_pct| * 0.5) + (eval_win_rate * 0.05) + (7일거래 >= minWeeklyTrades ? 1.0 : 0.0)
 */
function parseBotOverridesSafe(raw) {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      const val = String(v || "").trim().toUpperCase();
      if (val === "ALLOW" || val === "BLOCK") out[k] = val;
    }
    return out;
  }
  if (typeof raw === "string" && raw.trim()) {
    try {
      return parseBotOverridesSafe(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  return {};
}

/** [Antigravity-Doc] `market_regime_filter(id=1)`에서 현재 시황 레짐(BULL/SIDEWAYS/BEAR) 및 봇별 허용/차단 오버라이드 로드 */
export async function readMarketRegimeContext(db, explicitRegime = null) {
  let row = null;
  if (!explicitRegime || (!explicitRegime.market_regime && !explicitRegime.recommended_action)) {
    try {
      row = await db
        .prepare(
          `SELECT market_regime, recommended_action, final_position_multiplier, position_size_multiplier,
                  final_bot_overrides_json, bot_overrides_json, sentiment_score, reason
           FROM market_regime_filter WHERE id = 1`
        )
        .get();
    } catch {
      row = null;
    }
  }
  const src = { ...(row || {}), ...(explicitRegime || {}) };
  const marketRegime = String(src.market_regime || "SIDEWAYS").trim().toUpperCase();
  const recommendedAction = String(src.recommended_action || "NORMAL").trim().toUpperCase();
  const botOverrides = parseBotOverridesSafe(
    src.bot_overrides ?? src.final_bot_overrides_json ?? src.bot_overrides_json
  );
  const multiplier = Number(src.final_position_multiplier ?? src.position_size_multiplier ?? 1.0);
  const isBearOrDefensive =
    marketRegime === "BEAR" ||
    marketRegime === "CRASH" ||
    marketRegime === "HIGH_VOLATILITY_SHOCK" ||
    recommendedAction === "REDUCE_SIZE" ||
    recommendedAction === "HOLD_ALL" ||
    recommendedAction === "HOLD_CASH" ||
    recommendedAction === "HALT_NEW_BUYS" ||
    recommendedAction === "EMERGENCY_CLOSE_ALL";
  const regimeBucket = isBearOrDefensive ? "BEAR" : marketRegime === "BULL" ? "BULL" : "SIDEWAYS";

  return {
    market_regime: marketRegime,
    recommended_action: recommendedAction,
    regime_bucket: regimeBucket,
    position_multiplier: Number.isFinite(multiplier) ? multiplier : 1.0,
    sentiment_score: Number(src.sentiment_score || 0),
    bot_overrides: botOverrides,
    reason: String(src.reason || ""),
  };
}

/**
 * [Antigravity-Doc] `SINGLE_MARKET_FIT_100` 모드 전용: 현재 시황 레짐(BULL/SIDEWAYS/BEAR)과 봇별 오버라이드에 맞춰
 * 9단계 우선순위 티어로 최적 단일 봇 1개를 선출한다.
 */
export function selectSingleMarketFitChampion(enrichedBots = [], { regimeContext, minWeeklyTrades = 2 } = {}) {
  const ctx = regimeContext || {
    market_regime: "SIDEWAYS",
    recommended_action: "NORMAL",
    regime_bucket: "SIDEWAYS",
    bot_overrides: {},
  };
  const overrides = ctx.bot_overrides || {};
  const hasExplicitOverrides = Object.keys(overrides).length > 0;
  const bucket = ctx.regime_bucket || "SIDEWAYS";

  const isRegimeAllowed = (b) => {
    if (hasExplicitOverrides && overrides[b.bot_id]) {
      return overrides[b.bot_id] !== "BLOCK";
    }
    if (bucket === "BEAR") {
      return b.strategy_group_code === "REVERSAL_GRID" || b.bot_id === "bot_08";
    }
    return true;
  };

  const isPreferredGroup = (b) => {
    if (bucket === "BEAR") return b.strategy_group_code === "REVERSAL_GRID";
    if (bucket === "SIDEWAYS") return b.strategy_group_code === "REVERSAL_GRID" || b.bot_id === "bot_08";
    return true; // BULL: 추세·돌파·역추세 전 전략군 실력순 경쟁
  };

  const meetsMinTrades = (b) => (minWeeklyTrades <= 0 ? true : Number(b.weekly_trade_count || 0) >= minWeeklyTrades);
  const hasAnyActivity = (b) => Number(b.weekly_trade_count || 0) > 0 || Number(b.total_trades || 0) > 0;

  const tiers = [
    (b) => isRegimeAllowed(b) && isPreferredGroup(b) && meetsMinTrades(b),
    (b) => isRegimeAllowed(b) && isPreferredGroup(b) && hasAnyActivity(b),
    (b) => isRegimeAllowed(b) && meetsMinTrades(b),
    (b) => isRegimeAllowed(b) && hasAnyActivity(b),
    (b) => isRegimeAllowed(b) && isPreferredGroup(b),
    (b) => isRegimeAllowed(b),
    (b) => isPreferredGroup(b) && meetsMinTrades(b),
    (b) => isPreferredGroup(b),
    () => true,
  ];

  let pool = [];
  for (const pred of tiers) {
    const matched = enrichedBots.filter(pred);
    if (matched.length > 0) {
      pool = matched;
      break;
    }
  }

  pool.sort(
    (a, b) =>
      Number(b.rotation_score || 0) - Number(a.rotation_score || 0) ||
      Number(b.eval_return_pct || 0) - Number(a.eval_return_pct || 0) ||
      Number(b.profit_rate_pct || 0) - Number(a.profit_rate_pct || 0) ||
      Number(b.weekly_trade_count || 0) - Number(a.weekly_trade_count || 0) ||
      (b.bot_id === "bot_10" ? 1 : 0) - (a.bot_id === "bot_10" ? 1 : 0) ||
      a.bot_id.localeCompare(b.bot_id)
  );

  const winner = pool[0] || null;
  const regimeLabel =
    bucket === "BEAR" ? "약세/방어장" : bucket === "BULL" ? "상승장" : "횡보장";
  const reason = winner
    ? `[${ctx.market_regime}/${ctx.recommended_action}] ${regimeLabel} 적합 전략 1위 '${winner.nickname || winner.bot_id}'(${winner.strategy_group}) 단독 선출 (점수 ${winner.rotation_score >= 0 ? "+" : ""}${winner.rotation_score}, 주간수익 ${winner.weekly_return_pct}%, MDD ${winner.mdd_pct}%, 주간거래 ${winner.weekly_trade_count}건)`
    : "선출 가능한 봇이 없습니다.";

  return { champion: winner, eligible_bot_ids: pool.map((b) => b.bot_id), reason, regime_context: ctx };
}

/**
 * [Antigravity-Doc] 주간 3대 전략군(추세·스윙 / 변동성·돌파 / 역추세·그리드) 1위 챔피언 선출 및 실전 비중 산정기
 * - 최근 7일 롤링(ROLLING_7D) 가상 성과를 기본 평가하되, 그룹 내 7일 거래가 0건이면 누적 Arena 성적으로 자동 폴백.
 * - `rotation_score = eval_return_pct - |mdd_pct| * 0.5 + eval_win_rate * 0.05 + (최소거래 충족 시 +1.0)`
 * - 배분 모드(`EQUAL_BY_EQUITY_TIER`, `SINGLE_MARKET_FIT_100`, `RANK_WEIGHTED_*`)에 따라 최종 실전 선출 봇과 목표 자본을 계산한다.
 */
export async function evaluateWeeklyStrategyChampions(db, options = {}) {
  const rawMinTrades = Number(options.minWeeklyTrades ?? 2);
  const minWeeklyTrades = Number.isFinite(rawMinTrades) ? Math.max(0, Math.floor(rawMinTrades)) : 2;
  const allocationMode = ALLOCATION_MODE_WEIGHTS[options.allocationMode]
    ? options.allocationMode
    : "EQUAL_BY_EQUITY_TIER";
  const isSingleMarketFitMode = allocationMode === "SINGLE_MARKET_FIT_100";
  const isCapitalTierMode = isEquityTierAllocationMode(allocationMode);
  const weights = ALLOCATION_MODE_WEIGHTS[allocationMode];
  const cutoff7d = formatKstDateTime(new Date(Date.now() - 7 * 24 * 3600 * 1000));
  const evaluatedAt = nowKSTString();

  const tier1Max = Number(options.tier1Max || DEFAULT_CAPITAL_TIER_1_MAX);
  const tier2Max = Number(options.tier2Max || DEFAULT_CAPITAL_TIER_2_MAX);
  const maxDeployRatio =
    Number.isFinite(Number(options.maxDeployRatio)) && Number(options.maxDeployRatio) > 0 && Number(options.maxDeployRatio) <= 1
      ? Number(options.maxDeployRatio)
      : DEFAULT_MAX_DEPLOY_RATIO;

  let cachedEquity = null;
  let legacyCap = null;
  try {
    const eqRow = await db.prepare("SELECT value FROM system_settings WHERE key = 'last_synced_total_equity_krw'").get();
    if (eqRow && Number(eqRow.value) > 0) cachedEquity = Number(eqRow.value);
    const capRow = await db.prepare("SELECT value FROM system_settings WHERE key = 'total_capital'").get();
    if (capRow && Number(capRow.value) > 0) legacyCap = Number(capRow.value);
  } catch {}
  const resolvedEquityObj = resolveTotalEquityAndSingle90Cap({
    liveTotalEquityKrw: options.totalEquityKrw ?? options.principalKrw ?? null,
    cachedTotalEquityKrw: cachedEquity,
    legacyAuto90PrincipalKrw: legacyCap,
    maxDeployRatio,
  });
  const resolvedPrincipalKrw = resolvedEquityObj.totalEquityKrw;

  const bots = await db.prepare("SELECT * FROM bots ORDER BY bot_id ASC").all();
  const allPaperTrades = await db
    .prepare("SELECT bot_id, status, buy_date, sell_date, profit_krw FROM paper_trades")
    .all();

  const tradesByBot = new Map();
  for (const tr of allPaperTrades) {
    const bid = normalizeBotId(tr.bot_id);
    if (!tradesByBot.has(bid)) tradesByBot.set(bid, []);
    tradesByBot.get(bid).push(tr);
  }

  const enrichedBots = [];
  for (const bot of bots) {
    const s = await computeBotArenaStats(db, bot);
    const meta = getBotStrategyMeta(bot.bot_id);
    const rawMdd = Number(bot.paper_mdd_pct);
    const mddPct = Number((Number.isFinite(rawMdd) ? rawMdd : 0).toFixed(2));
    const botTrades = tradesByBot.get(bot.bot_id) || [];

    let realizedBefore7d = 0;
    let weeklyRealized = 0;
    let weeklyWins = 0;
    let weeklyLosses = 0;
    let weeklyTradeCount = 0;

    for (const tr of botTrades) {
      const buyTs = normalizeTimestampForCompare(tr.buy_date);
      const sellTs = normalizeTimestampForCompare(tr.sell_date);
      const closeTs = sellTs || buyTs;
      const isCompleted = tr.status === "COMPLETED";
      const touchedLast7d = (buyTs && buyTs >= cutoff7d) || (isCompleted && closeTs && closeTs >= cutoff7d);
      if (touchedLast7d) {
        weeklyTradeCount++;
      }
      if (isCompleted) {
        const rawPnl = Number(tr.profit_krw);
        const pnl = Number.isFinite(rawPnl) ? rawPnl : 0;
        if (closeTs && closeTs >= cutoff7d) {
          weeklyRealized += pnl;
          if (pnl > 0) weeklyWins++;
          else if (pnl < 0) weeklyLosses++;
        } else {
          realizedBefore7d += pnl;
        }
      }
    }

    const safeInitialCap = Math.max(1, Number(s.initial_capital || DEFAULT_PAPER_CAPITAL));
    // 과거 누적 손실로 자본이 0 이하로 내려가도 분모가 1원으로 폭축해 수익률이 +100,000% 폭발하는 이상치 방어
    const baselineEquity = Math.max(Math.floor(safeInitialCap * 0.1), safeInitialCap + realizedBefore7d);
    const weeklyTotalPnl = weeklyRealized + (Number.isFinite(Number(s.unrealized_profit_krw)) ? Number(s.unrealized_profit_krw) : 0);
    const rawWeeklyRet = baselineEquity > 0 ? (weeklyTotalPnl / baselineEquity) * 100 : 0;
    const weeklyReturnPct = Number.isFinite(rawWeeklyRet) ? Number(rawWeeklyRet.toFixed(2)) : 0.0;
    const weeklyDecided = weeklyWins + weeklyLosses;
    const weeklyWinRate = weeklyDecided > 0 ? Number(((weeklyWins / weeklyDecided) * 100).toFixed(1)) : 0.0;

    enrichedBots.push({
      ...s,
      name: bot.name,
      nickname: bot.nickname,
      strategy_type: bot.strategy_type,
      ...meta,
      description: bot.description,
      is_selected_for_live: Number(bot.is_selected_for_live || 0),
      allocation_ratio: Number(bot.allocation_ratio || 0),
      is_running: Number(bot.is_running || 0),
      paper_is_running: Number(bot.paper_is_running ?? 1),
      mdd_pct: mddPct,
      last_signal_text: bot.paper_status_msg || "시그널 대기 중",
      weekly_realized_krw: Math.floor(weeklyRealized),
      weekly_unrealized_krw: Math.floor(s.unrealized_profit_krw || 0),
      weekly_total_pnl_krw: Math.floor(weeklyTotalPnl),
      weekly_return_pct: weeklyReturnPct,
      weekly_trade_count: weeklyTradeCount,
      weekly_win_trades: weeklyWins,
      weekly_lose_trades: weeklyLosses,
      weekly_win_rate: weeklyWinRate,
    });
  }

  const groups = {};
  const champions = [];

  for (const gCode of STRATEGY_GROUP_ORDER) {
    const gMeta = STRATEGY_GROUP_META[gCode];
    const gBots = enrichedBots.filter((b) => b.strategy_group_code === gCode);
    const totalGroupWeeklyTrades = gBots.reduce((sum, b) => sum + b.weekly_trade_count, 0);
    const useFallback = totalGroupWeeklyTrades === 0;
    const basis = useFallback ? "ARENA_CUMULATIVE_FALLBACK" : "ROLLING_7D";

    for (const b of gBots) {
      const evalReturnPct = useFallback ? b.profit_rate_pct : b.weekly_return_pct;
      const evalWinRatePct = useFallback ? b.win_rate_pct : b.weekly_win_rate;
      const minTradeMet = !useFallback && b.weekly_trade_count >= minWeeklyTrades;
      const tradeBonus = minTradeMet ? 1.0 : 0.0;
      const rawScore = evalReturnPct - Math.abs(b.mdd_pct) * 0.5 + evalWinRatePct * 0.05 + tradeBonus;
      b.eval_return_pct = Number.isFinite(evalReturnPct) ? evalReturnPct : 0;
      b.eval_win_rate_pct = Number.isFinite(evalWinRatePct) ? evalWinRatePct : 0;
      b.min_trade_bonus = tradeBonus;
      b.rotation_score = Number.isFinite(rawScore) ? Number(rawScore.toFixed(3)) : 0;
      b.evaluation_basis = basis;
    }

    gBots.sort(
      (a, b) =>
        b.rotation_score - a.rotation_score ||
        b.eval_return_pct - a.eval_return_pct ||
        b.profit_rate_pct - a.profit_rate_pct ||
        b.weekly_trade_count - a.weekly_trade_count ||
        a.bot_id.localeCompare(b.bot_id)
    );

    gBots.forEach((b, idx) => {
      b.group_rank = idx + 1;
      b.is_group_champion = idx === 0;
      b.champion_rank = null;
      b.recommended_ratio = 0;
    });

    if (gBots.length > 0) {
      champions.push(gBots[0]);
    }

    groups[gCode] = {
      ...gMeta,
      evaluation_basis: basis,
      total_weekly_trades: totalGroupWeeklyTrades,
      champion: gBots[0] || null,
      candidates: gBots,
    };
  }

  let singleSelectionReason = null;
  let singleEligibleBotIds = [];
  let marketRegimeContext = null;
  if (isSingleMarketFitMode) {
    marketRegimeContext = await readMarketRegimeContext(db, options.marketRegime);
    const singlePick = selectSingleMarketFitChampion(enrichedBots, {
      regimeContext: marketRegimeContext,
      minWeeklyTrades,
    });
    champions.length = 0;
    if (singlePick.champion) {
      champions.push(singlePick.champion);
    }
    singleSelectionReason = singlePick.reason;
    singleEligibleBotIds = singlePick.eligible_bot_ids || [];
  }

  champions.sort(
    (a, b) =>
      b.rotation_score - a.rotation_score ||
      b.eval_return_pct - a.eval_return_pct ||
      b.profit_rate_pct - a.profit_rate_pct ||
      a.bot_id.localeCompare(b.bot_id)
  );

  const tierInfo = getCapitalTierSummary(resolvedPrincipalKrw, { tier1Max, tier2Max, maxDeployRatio });
  let activeTierBotCount = champions.length;
  let perBotTargetKrw = 0;

  if (isCapitalTierMode) {
    const tiered = selectTieredEqualChampions(champions, resolvedPrincipalKrw > 0 ? resolvedPrincipalKrw : 1000000, {
      tier1Max,
      tier2Max,
      maxDeployRatio,
    });
    const electedIds = new Set(tiered.elected.map((e) => e.bot_id));
    const electedLookup = new Map(tiered.elected.map((e) => [e.bot_id, e]));
    champions.length = 0;
    for (const eb of tiered.elected) {
      champions.push(eb);
    }
    for (const b of enrichedBots) {
      if (electedIds.has(b.bot_id)) {
        const matched = electedLookup.get(b.bot_id);
        b.champion_rank = matched.champion_rank;
        b.recommended_ratio = matched.recommended_ratio;
        b.target_capital_krw = matched.target_capital_krw;
      } else {
        b.champion_rank = null;
        b.recommended_ratio = 0;
        b.target_capital_krw = 0;
      }
    }
    activeTierBotCount = tiered.targetCount;
    perBotTargetKrw = tiered.perBotTargetKrw;
  } else {
    let assignedTotal = 0;
    champions.forEach((champ, idx) => {
      let assignedRatio = 0;
      if (champions.length === 1) {
        assignedRatio = 100;
      } else if (idx === champions.length - 1) {
        assignedRatio = Math.max(0, 100 - assignedTotal);
      } else if (champions.length === 2) {
        assignedRatio = idx === 0 ? 55 : 45;
      } else {
        assignedRatio = weights[idx] ?? Math.floor(100 / Math.max(1, champions.length));
      }
      assignedTotal += assignedRatio;
      champ.champion_rank = idx + 1;
      champ.recommended_ratio = assignedRatio;
    });
    activeTierBotCount = champions.length;
    perBotTargetKrw =
      champions.length > 0 && tierInfo.globalCapKrw > 0 ? Math.floor(tierInfo.globalCapKrw / champions.length) : 0;
  }

  const byBotId = {};
  for (const b of enrichedBots) {
    byBotId[b.bot_id] = b;
  }

  return {
    evaluated_at: evaluatedAt,
    cutoff_7d: cutoff7d,
    allocation_mode: allocationMode,
    is_single_bot_mode: isSingleMarketFitMode || activeTierBotCount === 1,
    is_capital_tier_mode: isCapitalTierMode,
    principal_krw: tierInfo.principalKrw,
    global_cap_krw: tierInfo.globalCapKrw,
    reserve_min_krw: tierInfo.reserveMinKrw,
    active_tier_bot_count: activeTierBotCount,
    per_bot_target_krw: perBotTargetKrw,
    tier_label: tierInfo.tierLabel,
    market_regime_context: marketRegimeContext,
    selection_reason: singleSelectionReason,
    single_eligible_bot_ids: singleEligibleBotIds,
    min_weekly_trades: minWeeklyTrades,
    bots: enrichedBots,
    by_bot_id: byBotId,
    groups,
    champions,
  };
}

/** [Antigravity-Doc] 10대 알고리즘 봇 가상거래 수익률 순위표(1~10위) 조회 */
export async function getArenaLeaderboard(db, options = {}) {
  let evalConfig = options;
  if (!options.allocationMode) {
    try {
      const cfg = await db.prepare("SELECT allocation_mode, min_weekly_trades FROM auto_rotation_config WHERE id = 1").get();
      if (cfg) {
        evalConfig = {
          allocationMode: cfg.allocation_mode || "RANK_WEIGHTED_40_35_25",
          minWeeklyTrades: Number(cfg.min_weekly_trades ?? 2),
        };
      }
    } catch {
      // auto_rotation_config 초기화 전 fallback
    }
  }
  const evaluation = await evaluateWeeklyStrategyChampions(db, evalConfig);
  const rows = [...evaluation.bots];
  rows.sort(
    (a, b) =>
      b.profit_rate_pct - a.profit_rate_pct ||
      b.realized_profit_krw - a.realized_profit_krw ||
      a.bot_id.localeCompare(b.bot_id)
  );
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });
  return rows;
}

/** [Antigravity-Doc] 가상거래 체결 이력(`paper_trades`) 최근 최대 500건 조회 (특정 봇 필터 지원) */
export async function getArenaTrades(db, botId = null, limit = 100) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  const base = `
    SELECT t.*, b.nickname AS nickname, b.name AS bot_name
    FROM paper_trades t
    LEFT JOIN bots b ON b.bot_id = t.bot_id
  `;
  if (botId && botId !== "all") {
    return await db.prepare(`${base} WHERE t.bot_id = ? ORDER BY t.id DESC LIMIT ?`).all(normalizeBotId(botId), lim);
  }
  return await db.prepare(`${base} ORDER BY t.id DESC LIMIT ?`).all(lim);
}

/** [Antigravity-Doc] 10대 봇 가상거래 잔액·최고평가자산·누적 MDD·상태 메시지를 `bots` 테이블에 영속화 */
async function persistArenaStats(db, statusMap) {
  const bots = await db.prepare("SELECT * FROM bots").all();
  const upd = db.prepare(
    "UPDATE bots SET paper_virtual_krw = ?, paper_peak_equity = ?, paper_mdd_pct = ?, paper_status_msg = ?, paper_is_running = 1 WHERE bot_id = ?"
  );
  for (const bot of bots) {
    const s = await computeBotArenaStats(db, bot);
    const peak = Math.max(Number(bot.paper_peak_equity || s.initial_capital), s.eval_assets_krw);
    const dd = peak > 0 ? ((peak - s.eval_assets_krw) / peak) * 100 : 0;
    const mdd = Math.max(Number(bot.paper_mdd_pct || 0), dd);
    await upd.run(s.cash_krw, Math.floor(peak), Number(mdd.toFixed(4)), statusMap?.[bot.bot_id] || bot.paper_status_msg, bot.bot_id);
  }
}

// ============================================================================
// 10. 상시 가상 경쟁 사이클 (LLM / Regime 필터 완전 우회)
// ============================================================================
/**
 * [Antigravity-Doc] 10대 순수 알고리즘 상시 가상 경쟁(Arena) 메인 사이클 (LLM / 시황 필터 완전 우회)
 * - 거래대금 상위 유니버스 + 현재 OPEN 포지션 마켓의 시세·4종 캔들·지표·7일 모멘텀 순위를 1회 일괄 계산해
 *   10개 봇이 공유하며, 각 봇 실행 후 `persistArenaStats`로 DB 통계를 갱신한다.
 * @param {object} db   SQLite/PG DB 어댑터
 * @param {object} deps `{ getUniverse, fetchTickersMap, fetchCandles, getOrderbook }`
 */
export async function runArenaCycle(db, deps) {
  const universe = (await deps.getUniverse()).slice();
  const heldRows = await db
    .prepare("SELECT DISTINCT market FROM paper_bot_positions WHERE status = 'OPEN'")
    .all();
  const heldMarkets = heldRows.map((r) => r.market);
  const markets = [...new Set([...universe, ...heldMarkets])];
  const tickerMap = await deps.fetchTickersMap(markets);
  if (!tickerMap || tickerMap.size === 0) {
    lastCycleSummary = "업비트 시세 조회 실패 - 다음 사이클 재시도";
    return { ok: false, message: lastCycleSummary };
  }
  lastPriceMap = tickerMap;

  const mdMap = new Map();
  for (const m of markets) {
    const tk = tickerMap.get(m);
    if (!tk) continue;
    mdMap.set(m, await buildMarketData(m, tk, deps.fetchCandles));
  }
  const rankMap = computeMomentumRanking(mdMap, markets);

  const bots = await db.prepare("SELECT * FROM bots WHERE paper_is_running = 1 ORDER BY bot_id ASC").all();
  const statusMap = {};
  for (const bot of bots) {
    try {
      statusMap[bot.bot_id] = await runPaperBot(db, bot, {
        mdMap,
        universe,
        rankMap,
        tickerMap,
        getOrderbook: deps?.getOrderbook,
      });
    } catch (err) {
      statusMap[bot.bot_id] = `사이클 오류: ${err.message}`;
    }
  }
  await persistArenaStats(db, statusMap);
  lastCycleAt = nowKSTString();
  lastCycleSummary = `${bots.length}개 봇 평가 완료 (${universe.length}개 종목)`;
  return { ok: true, message: lastCycleSummary };
}

/** [Antigravity-Doc] 가상거래(Arena) 최근 실행 시각 및 요약 문자열 반환 */
export function getArenaStatus() {
  return { last_cycle_at: lastCycleAt, last_cycle_summary: lastCycleSummary };
}

/** [Antigravity-Doc] 가상거래 원장(`paper_trades`, `paper_bot_positions`) 및 봇별 가상 시드(100만 원) 초기화 — 실전 원장은 미접촉 */
export async function resetArena(db) {
  await db.exec("DELETE FROM paper_trades; DELETE FROM paper_bot_positions;");
  await db.prepare(`
    UPDATE bots
    SET paper_initial_capital = ${DEFAULT_PAPER_CAPITAL},
        paper_virtual_krw = ${DEFAULT_PAPER_CAPITAL},
        paper_peak_equity = ${DEFAULT_PAPER_CAPITAL},
        paper_mdd_pct = 0,
        paper_is_running = 1,
        paper_status_msg = '가상거래 초기화 완료 (100만원 시드 순수 알고리즘 경쟁 재시작)'
  `).run();
  cooldownMap.clear();
  peakMap.clear();
}
