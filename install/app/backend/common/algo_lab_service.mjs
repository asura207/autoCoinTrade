/**
 * algo_lab_service.mjs
 * 10대 순수 알고리즘 상시 가상 경쟁(Arena) 서비스
 *
 * - bot_01 ~ bot_10 : 수익률 검증형 10개 코인 거래 알고리즘 마스터 데이터 및 DB 스키마 보강/마이그레이션
 * - evaluateStrategy(botId, marketData, indicators, position) : 10개 봇이 공유하는 순수 수식·기술적 지표 전략 함수
 *     (LLM / Gemini 시황 브리핑 / BTC Regime 필터를 일절 참조하지 않는 순수 알고리즘)
 * - runArenaCycle : 가상거래(paper_trades / paper_bot_positions) 원장에 상시 가상 체결 및 리더보드 산출
 *     (실제거래 원장 trades / bot_positions 와는 완전히 분리)
 */

export const PAPER_FEE_RATE = 0.0005;
export const PAPER_MIN_ORDER_KRW = 5000;
export const DEFAULT_PAPER_CAPITAL = 1000000;

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

export function nowKSTString() {
  return formatKstDateTime(new Date());
}

/** 업비트 일봉 기준(09:00 KST) 거래일 문자열(YYYY-MM-DD). 서버 타임존과 무관하게 계산 */
export function tradingDateKST(dateStr) {
  const base = String(dateStr || nowKSTString()).replace("T", " ").slice(0, 19);
  const ms = Date.parse(`${base.replace(" ", "T")}Z`);
  if (Number.isNaN(ms)) return base.slice(0, 10);
  return new Date(ms - 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// ============================================================================
// 1. 기술적 지표 유틸리티
// ============================================================================
export function computeSma(values, period) {
  if (!values || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

/** Wilder RSI 시계열 (값이 산출되지 않는 초반 구간은 null) */
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
  const calc = () => (avgLoss === 0 ? 100.0 : 100.0 - 100.0 / (1.0 + avgGain / avgLoss));
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

export function computeRsi(closes, period = 14) {
  const series = computeRsiSeries(closes, period);
  const last = series[series.length - 1];
  return last === null || last === undefined ? 50.0 : last;
}

export function computeEma(values, period) {
  if (!values || values.length === 0) return [];
  const k = 2 / (period + 1);
  const emaArr = [values[0]];
  for (let i = 1; i < values.length; i++) {
    emaArr.push(values[i] * k + emaArr[i - 1] * (1 - k));
  }
  return emaArr;
}

/** MACD 시계열 (macd / signal 모두 closes 와 동일 인덱스로 정렬) */
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

/** 볼린저 밴드 (모집단 표준편차) */
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

/** 각 시점별 볼린저 밴드폭 시계열 (Bandwidth = (Upper - Lower) / Middle) */
export function computeBandwidthSeries(closes, period = 20, numStd = 2.0) {
  const out = [];
  for (let i = period; i <= closes.length; i++) {
    const bb = computeBollinger(closes.slice(i - period, i), period, numStd);
    out.push(bb ? bb.bandwidth : null);
  }
  return out;
}

/** Wilder ATR 시계열 */
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

/** SuperTrend (ATR 기반). dir: 1 상승 / -1 하락 */
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
 * 20봉 선형 회귀 채널 (Linear Regression Channel, N = 20)
 * 최소자승법(OLS)으로 기울기 m, 절편 b, 현재 시점 중심값 ŷ_19, 잔차 표준편차 σ(±2σ) 계산
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
 * 잭 켈로그(Jack Kellogg) 4대 핵심 지표 패키지 계산
 * ① 당일/롤링 VWAP (TP = (H+L+C)/3) 및 이격도
 * ② 20봉 선형 회귀 채널 (LRC ±2σ)
 * ③ 상대 거래량 폭발 배수 (RVOL)
 * ④ 3대 핵심 기준 가격선 (당일 09시 시가, 전일 종가, 전일 고가, 전일 저가)
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

  // 4. 상대 거래량 (RVOL)
  const n = m15Candles.length;
  const cur = m15Candles[n - 1];
  const closed = m15Candles[n - 2] || cur;
  const avg20 = avgVolume(m15Candles, 1, 20); // 직전 20개 완료 캔들 평균 거래량
  const curVol = Number(cur.candle_acc_trade_volume || 0);
  const closedVol = Number(closed.candle_acc_trade_volume || 0);
  const rvol = avg20 > 0 ? Math.max(curVol, closedVol) / avg20 : 1.0;
  const curRvol = avg20 > 0 ? curVol / avg20 : 1.0;
  const closedRvol = avg20 > 0 ? closedVol / avg20 : 1.0;

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
  return ind;
}

/** 거래대금 상위 종목 간 7일 상대 모멘텀 순위 (bot_03 용) */
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
 * 돌파형 봇(bot_01, bot_03, bot_04, bot_09) 윗꼬리(Whipsaw) & 고점 물림 방어 필터
 * 1) 캔들 전체 길이(High - Low) 중 윗꼬리 길이(High - Close)가 45% 초과하거나,
 *    캔들 종가가 고가 대비 상위 35% 이내에 안착하지 못한 경우((High - Close) / (High - Low) > 0.35) 가짜 돌파(Bull Trap) 차단
 * 2) 15분봉 현재가가 20MA 또는 VWAP 대비 +6.0% 이상 급등한 상태일 경우 이격도 과열 추격 매수 금지
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

/**
 * 횡보장 자금 잠김(Position Lock) 해소를 위한 3단계 스마트 청산(Exit) 엔진
 * 1) 본절 스탑 (Breakeven Stop): 최고 수익률 +1.2% 이상 도달 후 +0.25% 이하로 하락 시 수익 반납 방지 익절
 * 2) 시간 제한 청산 (Time-Stop): 단타 봇(bot_01, bot_04, bot_05, bot_09, bot_10)이 6시간(실전)/2시간(가상) 경과 후 -0.6%~+0.8% 박스권 & RVOL < 1.0 시 자금 회수
 * 3) ATR 기반 동적 트레일링 스탑: 진입가 대비 -2.2*ATR 하드 손절, 최고가 대비 -1.8*ATR 트레일링 스탑 (불가 시 고정 % 손절 Fallback)
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

  // 1. 본절 스탑 (Breakeven Stop — 수익 반납 방지)
  if (peakPnlPct >= 1.2 && pnlPct <= 0.25) {
    return {
      signal: "SELL",
      exitType: "BREAKEVEN_STOP",
      reason: `본절 스탑(Breakeven-Exit): 최고 +${fmt(peakPnlPct)}% 도달 후 +${fmt(pnlPct)}% 하락 반납 방지 청산`,
    };
  }

  // 2. 시간 제한 청산 (Time-Stop)
  const timeStopBots = new Set(["bot_01", "bot_04", "bot_05", "bot_09", "bot_10"]);
  if (timeStopBots.has(normId)) {
    const timeStr = position.opened_at || position.created_at;
    if (timeStr) {
      const entryTs = new Date(timeStr).getTime();
      if (!isNaN(entryTs)) {
        const holdHours = (Date.now() - entryTs) / (3600 * 1000);
        const maxHoldHours = isLive ? 6.0 : 2.0;

        const inBox = pnlPct >= -0.6 && pnlPct <= 0.8;
        const rvol = Number(
          indicators?.kellogg?.rvol ??
          indicators?.m15?.curVolRatio ??
          indicators?.m15?.closedVolRatio ??
          0.8
        );

        if (holdHours >= maxHoldHours && inBox && rvol < 1.0) {
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
    // 3-1. 진입가 대비 2.2 * ATR 하락 시 손절 (Hard Stop)
    const hardStopPrice = avgBuy - 2.2 * atr;
    if (curPrice <= hardStopPrice) {
      return {
        signal: "SELL",
        exitType: "ATR_HARD_STOP",
        reason: `동적 ATR 손절(Hard Stop): 진입가 대비 -2.2×ATR(${ko(2.2 * atr)}원) 이탈 (수익률 ${fmt(pnlPct)}%)`,
      };
    }

    // 3-2. 최고가 대비 1.8 * ATR 하락 시 트레일링 스탑 (Dynamic Trailing Stop)
    if (curPeak > avgBuy) {
      const trailingStopPrice = curPeak - 1.8 * atr;
      if (curPrice <= trailingStopPrice) {
        return {
          signal: "SELL",
          exitType: "ATR_TRAILING_STOP",
          reason: `동적 ATR 트레일링 스탑: 최고가(${ko(curPeak)}) 대비 -1.8×ATR(${ko(1.8 * atr)}원) 이탈 (수익률 ${fmt(pnlPct)}%)`,
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
export const STRATEGY_GROUP_ORDER = ["TREND_SWING", "VOLATILITY_BREAKOUT", "REVERSAL_GRID"];

export const ALLOCATION_MODE_WEIGHTS = {
  RANK_WEIGHTED_40_35_25: [40, 35, 25],
  RANK_WEIGHTED_40_40_20: [40, 40, 20],
  EQUAL_34_33_33: [34, 33, 33],
};

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
    config: { bb_period: 20, bb_std: 2.0, bb_stddev: 2.0, candle_unit: "minutes/15", order_krw: 15000, order_ratio: 0.45, max_positions: 2 },
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
    description: "단기 과매도(RSI≤40) 진입 후 -2.5%/-5.0% 추가 하락 시 최대 3분할 매수(order_uuid 개별 관리) | 개별 포지션 +1.8% 도달 시 개별 익절",
    min_volume_krw: 5000000000,
    stop_loss_pct: 9.0,
    take_profit_pct: 1.8,
    config: { rsi_entry: 40, grid_step_1_pct: 2.5, grid_step_2_pct: 5.0, max_splits: 3, order_ratio: 0.45, max_positions: 2 },
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
    min_volume_krw: 10000000000,
    stop_loss_pct: 2.5,
    take_profit_pct: 5.0,
    config: {
      rvol_breakout_arena: 1.5,
      rvol_breakout_live: 2.0,
      rvol_dip: 1.3,
      vwap_gap_arena: 2.2,
      vwap_gap_live: 3.0,
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

/** 구버전 봇 ID(bot_volatility 등)를 신규 ID(bot_01 등)로 변환 */
export function normalizeBotId(botId) {
  return LEGACY_BOT_ID_MAP[botId] || botId;
}

/** 봇 ID별 전략군 메타 조회 */
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

const STRATEGIES = {
  // bot_01: 변동성 돌파
  bot_01({ price, ind, held, params, options = {} }) {
    const isLive = Boolean(options.isLive);
    const d = ind.day;
    if (!d) return hold("일봉 데이터 부족");
    if (held.length > 0) {
      const today = tradingDateKST(nowKSTString());
      if (held.some((p) => tradingDateKST(p.created_at || p.opened_at) < today)) {
        return sell("익일 시가 청산 (1일 보유 만기)");
      }
      return hold("보유 중 (목표 수익/익일 시가 청산 대기)");
    }
    const k = Number(params.k_value ?? (isLive ? 0.45 : 0.35));
    const target = d.todayOpen + (d.prevHigh - d.prevLow) * k;
    const volMult = Number(params.volume_multiplier ?? (isLive ? 1.5 : 1.2));
    const volOk = ind.m15 ? ind.m15.volSurge5 >= volMult : true;
    if (price >= target && price > d.todayOpen && volOk) {
      // 윗꼬리 및 이격도 과열 필터 검사
      const filter = checkUpperWickAndOverextension(ind.m15?.cur || ind.m15?.closed, price, ind.m15?.ema20 || d.ma20, ind.m15?.vwap);
      if (!filter.ok) return hold(filter.reason);
      return buy(`변동성 돌파(K=${k}) 목표가 ${ko(target)} 돌파 · 거래량 증가`);
    }
    return hold(`돌파목표 ${ko(target)} 대기 (현재 ${ko(price)})`);
  },

  // bot_02: SuperTrend + ATR 트레일링
  bot_02({ price, ind, held, params, options = {} }) {
    const isLive = Boolean(options.isLive);
    const mult = Number(params.atr_multiplier ?? 2.5);
    const volMult = Number(params.volume_multiplier ?? (isLive ? 2.0 : 1.4));
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

  // bot_03: 듀얼 모멘텀
  bot_03({ held, params, options = {} }) {
    const isLive = Boolean(options.isLive);
    const info = options.momentumRank?.[options.market];
    if (!info) return hold("모멘텀 순위 산출 대기");
    const absTh = Number(params.abs_momentum_threshold_pct ?? (isLive ? 2.0 : 1.2));
    const topN = Number(params.top_n ?? 2);
    if (held.length > 0) {
      if (info.momPct < 0) return sell(`모멘텀 이탈 (7일 ${fmt(info.momPct)}%)`);
      return hold(`보유 중 (7일 모멘텀 ${fmt(info.momPct)}% / ${info.rank}위)`);
    }
    if (info.rank <= topN && info.momPct >= absTh) {
      const m15 = options.indicators?.m15;
      const curPrice = Number(options.currentPrice || options.price || 0);
      if (m15 && curPrice > 0) {
        const filter = checkUpperWickAndOverextension(m15.cur || m15.closed, curPrice, m15.ema20, m15.vwap);
        if (!filter.ok) return hold(filter.reason);
      }
      return buy(`듀얼 모멘텀 ${info.rank}위 (7일 +${fmt(info.momPct)}% ≥ +${absTh}%)`);
    }
    return hold(`7일 모멘텀 ${info.rank}위 (${fmt(info.momPct)}%)`);
  },

  // bot_04: 볼린저 스퀴즈 돌파
  bot_04({ price, ind, held, params, options = {} }) {
    const isLive = Boolean(options.isLive);
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
    const volMult = Number(params.volume_multiplier ?? (isLive ? 2.0 : 1.4));
    const volRatio = Math.max(m.curVolRatio, m.closedVolRatio);
    if (squeezed && volRatio >= volMult && price > m.bb.upper) {
      const filter = checkUpperWickAndOverextension(m.cur || m.closed, price, m.bb.mid, m.vwap);
      if (!filter.ok) return hold(filter.reason);
      return buy(`BB 스퀴즈(밴드폭 ${fmt(recent6Min * 100)}%) 후 거래량 ${fmt(volRatio, 1)}배 상단 돌파`);
    }
    return hold(`스퀴즈 ${squeezed ? "형성" : "미형성"} / 상단 ${ko(m.bb.upper)}`);
  },

  // bot_05: 볼린저 역추세 반등
  bot_05({ price, ind, held, params, options = {} }) {
    const isLive = Boolean(options.isLive);
    const m = ind.m15;
    if (!m || !m.bb) return hold("15분봉 데이터 부족");
    if (held.length > 0) return hold("보유 중 (+3.5% 익절 / -2.0% 손절 감시)");
    const rsiTh = Number(params.rsi_threshold ?? (isLive ? 30 : 38));
    const touched = m.minLow2 <= m.bb.lower;
    if (touched && m.curBullish && price > m.bb.lower && m.rsiMin3 <= rsiTh) {
      return buy(`BB 하단 터치 후 양봉 복귀 · RSI ${fmt(m.rsiMin3, 1)} ≤ ${rsiTh} 과매도 반등`);
    }
    return hold(`BB 하단 ${ko(m.bb.lower)} / RSI ${fmt(m.rsi, 1)} (기준 ≤ ${rsiTh})`);
  },

  // bot_06: 다단계 분할 매수 그리드
  bot_06({ price, ind, held, params, options = {} }) {
    const isLive = Boolean(options.isLive);
    const m = ind.m15;
    const tp = Number(params.take_profit_pct ?? 1.8);
    if (held.length > 0) {
      const winners = held.filter((p) => pctChange(price, Number(p.avg_buy_price)) >= tp);
      if (winners.length > 0) {
        return sell(`그리드 개별 익절 (+${tp}% 도달 ${winners.length}건)`, { sellPositionIds: winners.map((p) => p.id) });
      }
      const maxSplits = Number(params.max_splits ?? 3);
      if (held.length < maxSplits) {
        const ref = Number(held.slice().sort((a, b) => a.id - b.id)[0].avg_buy_price);
        const drop = -pctChange(price, ref);
        const step1 = Number(params.grid_step_1_pct ?? 2.5);
        const step2 = Number(params.grid_step_2_pct ?? 5.0);
        if (held.length === 1 && drop >= step1) return buy(`그리드 2차 분할 매수 (최초 대비 -${fmt(drop)}%)`, { splitIndex: 2 });
        if (held.length === 2 && drop >= step2) return buy(`그리드 3차 분할 매수 (최초 대비 -${fmt(drop)}%)`, { splitIndex: 3 });
      }
      return hold(`그리드 보유 ${held.length}분할`);
    }
    if (!m || !m.bb) return hold("15분봉 데이터 부족");
    const rsiEntry = Number(params.rsi_entry ?? (isLive ? 30 : 38));
    if (m.rsi <= rsiEntry && price <= m.bb.lower * 1.005) {
      return buy(`단기 과매도 그리드 1차 진입 (RSI ${fmt(m.rsi, 1)} ≤ ${rsiEntry}, BB 하단 부근)`, { splitIndex: 1 });
    }
    return hold(`과매도 대기 (RSI ${fmt(m.rsi, 1)} / 기준 ≤ ${rsiEntry})`);
  },

  // bot_07: MACD + RSI 골든크로스
  bot_07({ ind, held, params }) {
    const m = ind.m15;
    const h = ind.m60;
    if (!m || !m.macdSeries || !h) return hold("15분/60분봉 데이터 부족");
    const { macd, signal } = m.macdSeries;
    const n = macd.length;
    if (held.length > 0) {
      const crossDown = macd[n - 2] >= signal[n - 2] && macd[n - 1] < signal[n - 1];
      if (crossDown) return sell("MACD 데드크로스 청산");
      if (m.ema20 < m.ema60) return sell("15분봉 EMA 정배열 붕괴 청산");
      return hold("보유 중 (MACD/EMA 감시)");
    }
    const aligned = m.ema20 > m.ema60 && h.ema20 > h.ema60;
    const crossUp = [1, 2].some((back) => macd[n - back - 1] <= signal[n - back - 1] && macd[n - back] > signal[n - back]);
    const rsiMin = Number(params.rsi_min ?? 45);
    const rsiMax = Number(params.rsi_max ?? 65);
    if (aligned && crossUp && m.rsi >= rsiMin && m.rsi <= rsiMax) {
      return buy(`EMA(20>60) 정배열 · MACD 골든크로스 · RSI ${fmt(m.rsi, 1)}`);
    }
    return hold(`정배열 ${aligned ? "O" : "X"} / 골든크로스 ${crossUp ? "O" : "X"} / RSI ${fmt(m.rsi, 1)}`);
  },

  // bot_08: 정배열 20일선 눌림목
  bot_08({ price, ind, held, params, options = {} }) {
    const isLive = Boolean(options.isLive);
    const d = ind.day;
    const h4 = ind.m240;
    if (!d || !h4 || d.ma60 === null || h4.ma60 === null) return hold("일봉/4시간봉 데이터 부족");
    if (held.length > 0) {
      if (d.recentHigh20 && price >= d.recentHigh20 * 0.995) return sell("직전 고점 부근 익절");
      return hold("보유 중 (직전 고점 익절 대기)");
    }
    const dayAligned = d.ma5 > d.ma20 && d.ma20 > d.ma60;
    const h4Aligned = h4.ma5 > h4.ma20 && h4.ma20 > h4.ma60;
    const band = Number(params.pullback_band_pct ?? (isLive ? 1.5 : 2.2));
    const gap = pctChange(price, d.ma20);
    const volDecline = h4.lastClosedVolRatio < 1.0;
    if (dayAligned && h4Aligned && Math.abs(gap) <= band && volDecline) {
      return buy(`정배열(5>20>60) 20일선 눌림목 지지 (이격 ${fmt(gap)}%, 거래량 감소)`);
    }
    return hold(`정배열 ${dayAligned && h4Aligned ? "O" : "X"} / 20선 이격 ${fmt(gap)}%`);
  },

  // bot_09: 거래량 폭발 모멘텀 스캘퍼
  bot_09({ price, ind, held, params, options = {} }) {
    const isLive = Boolean(options.isLive);
    const trailPct = Number(params.trailing_stop_pct ?? 1.5);
    if (held.length > 0) {
      const peak = Math.max(Number(options.peakPrice || 0), price);
      if (peak > 0 && price <= peak * (1 - trailPct / 100)) {
        return sell(`고점 대비 -${trailPct}% 트레일링 스탑`);
      }
      return hold("보유 중 (트레일링 스탑 감시)");
    }
    const m = ind.m15;
    if (!m) return hold("15분봉 데이터 부족");
    const spike = Number(params.volume_spike_multiplier ?? (isLive ? 2.0 : 1.4));
    const closedClose = Number(m.closed.trade_price);
    if (m.closedVolRatio >= spike && m.closedBullish && price >= closedClose && pctChange(price, closedClose) <= 1.5) {
      const filter = checkUpperWickAndOverextension(m.closed, price, m.ema20, m.vwap);
      if (!filter.ok) return hold(filter.reason);
      return buy(`15분봉 거래량 ${fmt(m.closedVolRatio, 1)}배 폭발 양봉 마감`);
    }
    return hold(`거래량 ${fmt(m.closedVolRatio, 1)}배 (기준 ${spike}배)`);
  },

  // bot_10: 잭 켈로그(Jack Kellogg) 프라이스 액션 & VWAP/선형회귀 모멘텀
  bot_10({ price, ind, held, params, options = {} }) {
    const k = ind.kellogg || ind.m15?.kellogg;
    if (!k || !k.lrc || !k.vwap) return hold("잭 켈로그 4대 지표(VWAP/LRC) 데이터 산출 대기");

    const isLive = Boolean(options.isLive);
    const rvolBreakoutTh = Number(params.rvol_breakout ?? (isLive ? 1.8 : 1.4));
    const rvolDipTh = Number(params.rvol_dip ?? 1.3);
    const dipGapTh = Number(params.vwap_gap ?? (isLive ? -2.8 : -2.0));
    const trailingPct = Number(params.trailing_stop_pct ?? 1.5);

    // ==========================================
    // 1. 보유 포지션 매도 / 익절 / 손절 평가
    // ==========================================
    if (held.length > 0) {
      const totalCost = held.reduce((acc, p) => acc + Number(p.buy_amount || Number(p.volume) * Number(p.avg_buy_price)), 0);
      const totalVol = held.reduce((acc, p) => acc + Number(p.volume), 0);
      const avgBuyPrice = totalVol > 0 ? totalCost / totalVol : Number(held[0].avg_buy_price);
      const totalPnlPct = pctChange(price, avgBuyPrice);

      const isBreakout = held.some((p) => String(p.buy_reason || "").includes("돌파") || String(p.buy_reason || "").includes("Setup A"));
      const isDip = held.some((p) => String(p.buy_reason || "").includes("반등") || String(p.buy_reason || "").includes("Setup B"));

      // (1) 기계적 기준선 손절 (Key Level Hard Stop)
      if (isBreakout) {
        if ((k.today_open > 0 && price < k.today_open && price < k.vwap) || totalPnlPct <= -2.0) {
          return sell(`[Setup A 손절] 당일시가(${ko(k.today_open)}) 및 VWAP(${ko(k.vwap)}) 동시 이탈 / 손절(-2.0%) 청산 (수익률 ${fmt(totalPnlPct)}%)`);
        }
      }

      if (isDip) {
        if (k.prev_low > 0 && price < k.prev_low) {
          return sell(`[Setup B 손절] 전일 저가(${ko(k.prev_low)}) 하향 이탈 손절 (수익률 ${fmt(totalPnlPct)}%)`);
        }
        if (totalPnlPct <= -2.5) {
          return sell(`[Setup B 손절] 평단가 대비 -2.5% 손절 (수익률 ${fmt(totalPnlPct)}%)`);
        }
      }

      if (!isBreakout && !isDip) {
        if ((k.today_open > 0 && price < k.today_open && price < k.vwap) || totalPnlPct <= -2.5) {
          return sell(`[기계적 기준선 손절] 당일시가/VWAP 이탈 또는 -2.5% 손절 (수익률 ${fmt(totalPnlPct)}%)`);
        }
      }

      // (2) 선형 회귀 채널 익절 (Take Profit)
      if (price >= k.lrc.upper) {
        return sell(`[LRC 상단 익절] +2σ 채널 상단(${ko(k.lrc.upper)}) 도달 전량 익절 (수익률 +${fmt(totalPnlPct)}%)`);
      }
      if (isDip && price >= k.lrc.mid) {
        return sell(`[LRC 중심선 회귀 익절] LRC 중심선(${ko(k.lrc.mid)}) 도달 익절 (수익률 +${fmt(totalPnlPct)}%)`);
      }

      // (3) 대량 거래량 폭발 + 윗꼬리 음봉 (Volume Climax Exhaustion) 청산
      const cur = k.cur;
      const isBearishUpperWick = Number(cur.trade_price) < Number(cur.opening_price) &&
        (Number(cur.high_price) - Number(cur.opening_price)) > Math.abs(Number(cur.opening_price) - Number(cur.trade_price)) * 0.5;
      if (totalPnlPct >= 1.0 && k.rvol >= 2.5 && isBearishUpperWick) {
        return sell(`[거래량 클라이맥스 엑시트] RVOL ${fmt(k.rvol, 1)}배 윗꼬리 음봉 출현 익절 (수익률 +${fmt(totalPnlPct)}%)`);
      }

      // (4) 최고가 대비 -1.5% 트레일링 스탑
      const peak = Math.max(Number(options.peakPrice || 0), price);
      const peakPnl = pctChange(peak, avgBuyPrice);
      if (peakPnl >= 1.5 && price <= peak * (1 - trailingPct / 100)) {
        return sell(`[트레일링 스탑] 고점 대비 -${trailingPct}% 반락 익절 (수익률 +${fmt(totalPnlPct)}%)`);
      }

      // (5) Setup B 2차 분할 매수 (Scaling-In) 평가
      if (isDip && held.length === 1) {
        const firstBuyPrice = Number(held[0].avg_buy_price);
        const dropPct = pctChange(price, firstBuyPrice);
        if (dropPct <= -2.5 && (k.prev_low === 0 || price >= k.prev_low)) {
          return buy(`[Setup B 2차 분할 매수] 1차 진입가 대비 ${fmt(dropPct)}% 추가 하락 분할 매수 (Scaling-In)`, {
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
    const setupA_trend = (k.today_open > 0 ? price > k.today_open : true) && price > k.vwap;
    const setupA_slope = k.lrc.slope > 0 && price < k.lrc.upper;
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
    const minLow = Math.min(Number(k.cur.low_price || price), Number(k.closed.low_price || price));
    const setupB_dip = k.vwap_disparity_pct <= dipGapTh;
    const setupB_lrc = minLow <= k.lrc.lower * 1.002;
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
 * 10개 봇 공통 전략 평가 함수 (순수 수식·기술적 지표 기반)
 * @param {string} botId       bot_01 ~ bot_10
 * @param {object} marketData  { market, price, ticker, candles: { day, m240, m60, m15 } }
 * @param {object} indicators  buildIndicators(marketData) 결과
 * @param {Array|object|null} position 해당 마켓의 보유 OPEN 포지션(들)
 * @param {object} options     { params, peakPrice, momentumRank, market }
 * @returns {{signal: "BUY"|"SELL"|"HOLD", reason: string, splitIndex?: number, sellPositionIds?: number[]}}
 */
export function evaluateStrategy(botId, marketData, indicators, position, options = {}) {
  const fn = STRATEGIES[normalizeBotId(botId)];
  if (!fn) return hold("알 수 없는 봇");
  const price = Number(marketData?.price || 0);
  if (!(price > 0)) return hold("현재가 없음");
  const heldList = Array.isArray(position) ? position : position ? [position] : [];
  try {
    return fn({
      price,
      marketData,
      ind: indicators || buildIndicators(marketData),
      held: heldList,
      params: options.params || {},
      options: { ...options, market: options.market || marketData?.market },
    });
  } catch (err) {
    return hold(`지표 계산 오류: ${err.message}`);
  }
}

// ============================================================================
// 5. 캔들 캐시 (업비트 Rate Limit 방어: 마켓·주기별 TTL 공유 캐시)
// ============================================================================
const CANDLE_UNITS = [
  { key: "day", unit: "days", count: 65, ttlMs: 5 * 60 * 1000 },
  { key: "m240", unit: "minutes/240", count: 65, ttlMs: 2 * 60 * 1000 },
  { key: "m60", unit: "minutes/60", count: 80, ttlMs: 60 * 1000 },
  { key: "m15", unit: "minutes/15", count: 100, ttlMs: 25 * 1000 },
];
const candleCache = new Map();

async function getCandlesCached(market, spec, fetchCandlesFn) {
  const cacheKey = `${market}|${spec.unit}`;
  const hit = candleCache.get(cacheKey);
  const nowMs = Date.now();
  if (hit && nowMs - hit.at < spec.ttlMs) return hit.rows;
  let rows = [];
  try {
    rows = await fetchCandlesFn(market, spec.unit, spec.count);
  } catch {}
  if (Array.isArray(rows) && rows.length > 0) {
    candleCache.set(cacheKey, { at: nowMs, rows });
    return rows;
  }
  return hit ? hit.rows : [];
}

/** 마켓별 시세 + 4종 캔들 + 지표 패키지 구성 (공유 캐시 사용) */
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
const cooldownMap = new Map();
const peakMap = new Map();
let lastPriceMap = new Map();
let lastCycleAt = "";
let lastCycleSummary = "";

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

/** bots 테이블 선택/전략군/가상거래 컬럼 및 paper_trades 사유 컬럼 보강 (중복 컬럼 예외 방어) */
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
  return { hadSelectionColumn };
}

/**
 * 10대 봇 마스터 데이터 보장
 * - 구버전 3개 실전 봇(bot_volatility / bot_dual_momentum / bot_bollinger_reversal)을
 *   bot_01 / bot_03 / bot_05 로 이관 (원장 trades · bot_positions · paper_* 의 bot_id 포함)
 * - 신규 설치: 상위 3개 봇(bot_01~03)을 실전 담당으로 기본 선택
 * - 기존 설치: 기존 실전 봇이었던 봇들을 실전 담당으로 승계
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
        min_volume_krw = 10000000000
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
async function computePaperCash(db, botId, initial) {
  const pnl = await db
    .prepare("SELECT COALESCE(SUM(profit_krw), 0) AS p FROM paper_trades WHERE bot_id = ? AND status = 'COMPLETED'")
    .get(botId);
  const open = await db
    .prepare("SELECT COALESCE(SUM(buy_amount + buy_fee), 0) AS inv FROM paper_bot_positions WHERE bot_id = ? AND status = 'OPEN'")
    .get(botId);
  return Math.max(0, Math.floor(Number(initial) + Number(pnl?.p || 0) - Number(open?.inv || 0)));
}

/** 가상 매수 체결: 예산을 Math.floor(예산 / 1.0005) 로 환산하고 수수료 0.05% 별도 반영 */
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
      INSERT INTO paper_bot_positions (bot_id, market, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
    `)
    .run(bot.bot_id, market, uuid, volume, safePrice, buyAmount, fee, tradeId, now);
  return { positionId: Number(pr.lastInsertRowid), tradeId, buyAmount, fee, volume, uuid };
}

/** 가상 매도 체결 (포지션별 개별 정산, 수수료 0.05% 반영) */
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
    if (Number.isFinite(profit)) totalProfit += profit;
    await db.prepare("UPDATE paper_bot_positions SET status = 'CLOSED', closed_at = ? WHERE id = ? AND status = 'OPEN'").run(now, p.id);
    await db.prepare(`
      UPDATE paper_trades
      SET sell_order_uuid = ?, sell_price = ?, sell_volume = ?, sell_amount = ?, sell_date = ?,
          profit_krw = ?, profit_pct = ?, status = 'COMPLETED', sell_reason = ?
      WHERE id = ?
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

const COOLDOWN_MS = 3 * 60 * 1000;

async function runPaperBot(db, bot, ctx) {
  const { mdMap, universe, rankMap, tickerMap } = ctx;
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

  for (const [market, group] of byMarket) {
    const md = mdMap.get(market);
    const price = Number(md?.price || tickerMap.get(market)?.trade_price || 0);
    if (!(price > 0)) continue;
    let peak = 0;
    for (const p of group) {
      peak = Math.max(peak, updatePeakPrice(`paper-${p.id}`, price, Number(p.avg_buy_price)));
    }
    const remaining = [];
    for (const p of group) {
      // 3단계 스마트 청산 유틸리티 (본절 스탑, 시간 제한 청산, 동적 ATR 트레일링 스탑)
      const smartExit = evaluateSmartExit({
        botId: bot.bot_id,
        position: p,
        currentPrice: price,
        indicators: md?.indicators,
        peakPrice: peak,
        isLive: false,
        stopLossPct: stopLoss,
      });
      if (smartExit && smartExit.signal === "SELL") {
        const profit = await paperSell(db, bot, [p], price, smartExit.reason);
        lastAction = `[가상매도] ${market} ${smartExit.reason} (${profit >= 0 ? "+" : ""}${ko(profit)}원)`;
        continue;
      }

      const pnl = pctChange(price, Number(p.avg_buy_price));
      if (pnl <= stopLoss) {
        const profit = await paperSell(db, bot, [p], price, `손절(${fmt(pnl)}%)`);
        lastAction = `[가상매도] ${market} 손절 (${profit >= 0 ? "+" : ""}${ko(profit)}원)`;
      } else if (pnl >= takeProfit) {
        const profit = await paperSell(db, bot, [p], price, `익절(+${fmt(pnl)}%)`);
        lastAction = `[가상매도] ${market} 익절 (+${ko(profit)}원)`;
      } else {
        remaining.push(p);
      }
    }
    if (remaining.length > 0 && md) {
      const sig = evaluateStrategy(bot.bot_id, md, md.indicators, remaining, {
        params,
        peakPrice: peak,
        momentumRank: rankMap,
        market,
      });
      if (sig.signal === "SELL") {
        const targets = sig.sellPositionIds ? remaining.filter((p) => sig.sellPositionIds.includes(p.id)) : remaining;
        if (targets.length > 0) {
          const profit = await paperSell(db, bot, targets, price, sig.reason);
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
    if (bot.bot_id === "bot_06") {
      ratio = ratio / Math.max(1, Number(cfg.max_splits || 3));
    } else if (bot.bot_id === "bot_10" && sig.order_ratio) {
      ratio = Number(sig.order_ratio);
    }
    const budget = Math.min(Math.floor(initial * ratio), Math.floor(cash / (1 + PAPER_FEE_RATE)));
    if (budget < PAPER_MIN_ORDER_KRW) break;
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
export async function evaluateWeeklyStrategyChampions(db, options = {}) {
  const minWeeklyTrades = Math.max(0, Number(options.minWeeklyTrades ?? 2));
  const allocationMode = ALLOCATION_MODE_WEIGHTS[options.allocationMode]
    ? options.allocationMode
    : "RANK_WEIGHTED_40_35_25";
  const weights = ALLOCATION_MODE_WEIGHTS[allocationMode];
  const cutoff7d = formatKstDateTime(new Date(Date.now() - 7 * 24 * 3600 * 1000));
  const evaluatedAt = nowKSTString();

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
    const mddPct = Number(Number(bot.paper_mdd_pct || 0).toFixed(2));
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
        const pnl = Number(tr.profit_krw || 0);
        if (closeTs && closeTs >= cutoff7d) {
          weeklyRealized += pnl;
          if (pnl > 0) weeklyWins++;
          else if (pnl < 0) weeklyLosses++;
        } else {
          realizedBefore7d += pnl;
        }
      }
    }

    const baselineEquity = Math.max(1, Number(s.initial_capital || DEFAULT_PAPER_CAPITAL) + realizedBefore7d);
    const weeklyTotalPnl = weeklyRealized + Number(s.unrealized_profit_krw || 0);
    const weeklyReturnPct = Number(((weeklyTotalPnl / baselineEquity) * 100).toFixed(2));
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
      b.eval_return_pct = evalReturnPct;
      b.eval_win_rate_pct = evalWinRatePct;
      b.min_trade_bonus = tradeBonus;
      b.rotation_score = Number(rawScore.toFixed(3));
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

  champions.sort(
    (a, b) =>
      b.rotation_score - a.rotation_score ||
      b.eval_return_pct - a.eval_return_pct ||
      b.profit_rate_pct - a.profit_rate_pct ||
      a.bot_id.localeCompare(b.bot_id)
  );

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

  const byBotId = {};
  for (const b of enrichedBots) {
    byBotId[b.bot_id] = b;
  }

  return {
    evaluated_at: evaluatedAt,
    cutoff_7d: cutoff7d,
    allocation_mode: allocationMode,
    min_weekly_trades: minWeeklyTrades,
    bots: enrichedBots,
    by_bot_id: byBotId,
    groups,
    champions,
  };
}

/** 10개 봇 실시간 가상거래 경쟁 순위 (1위~10위) */
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
 * @param db   PostgreSQL Database Adapter
 * @param deps { getUniverse(): Promise<string[]>, fetchTickersMap(markets): Promise<Map>, fetchCandles(market, unit, count): Promise<Array> }
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
  const rankMap = computeMomentumRanking(mdMap, universe);

  const bots = await db.prepare("SELECT * FROM bots WHERE paper_is_running = 1 ORDER BY bot_id ASC").all();
  const statusMap = {};
  for (const bot of bots) {
    try {
      statusMap[bot.bot_id] = await runPaperBot(db, bot, { mdMap, universe, rankMap, tickerMap });
    } catch (err) {
      statusMap[bot.bot_id] = `사이클 오류: ${err.message}`;
    }
  }
  await persistArenaStats(db, statusMap);
  lastCycleAt = nowKSTString();
  lastCycleSummary = `${bots.length}개 봇 평가 완료 (${universe.length}개 종목)`;
  return { ok: true, message: lastCycleSummary };
}

export function getArenaStatus() {
  return { last_cycle_at: lastCycleAt, last_cycle_summary: lastCycleSummary };
}

/** 가상거래 전용 원장 및 가상 잔액 초기화 (실제 거래 원장은 건드리지 않음) */
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
