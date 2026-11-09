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

export function nowKSTString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
    ind.m15 = {
      closes,
      rsi: rsiSeries[n - 1] ?? 50,
      rsiMin3: recentRsi.length > 0 ? Math.min(...recentRsi) : 50,
      bb: computeBollinger(closes, 20, 2.0),
      bandwidthSeries,
      ema20: ema20[n - 1],
      ema60: ema60[n - 1],
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
  }
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

// ============================================================================
// 3. 10대 알고리즘 봇 마스터 데이터
// ============================================================================
export const ARENA_BOT_DEFS = [
  {
    bot_id: "bot_01",
    legacy_ids: ["bot_volatility"],
    name: "필터 결합형 변동성 돌파 봇",
    nickname: "돌파봇-알파",
    strategy_type: "VOLATILITY_BREAKOUT",
    description: "장중 단타 / 1일 보유 | 변동성 돌파(K=0.4) + 20일 이평선 추세 필터 전략",
    min_volume_krw: 10000000000,
    stop_loss_pct: 2.5,
    take_profit_pct: 4.5,
    config: { k_value: 0.4, ma_period: 20, volume_multiplier: 1.2, order_ratio: 0.3, max_positions: 2 },
  },
  {
    bot_id: "bot_02",
    legacy_ids: [],
    name: "슈퍼트렌드 & ATR 트레일링 (SuperTrend ATR)",
    nickname: "슈퍼트렌드-ATR",
    strategy_type: "SUPERTREND_ATR",
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
    description: "단기 과매도 진입 후 -2.5%/-5.0% 추가 하락 시 최대 3분할 매수(order_uuid 개별 관리) | 개별 포지션 +1.8% 도달 시 개별 익절",
    min_volume_krw: 5000000000,
    stop_loss_pct: 9.0,
    take_profit_pct: 1.8,
    config: { rsi_entry: 35, grid_step_1_pct: 2.5, grid_step_2_pct: 5.0, max_splits: 3, order_ratio: 0.45, max_positions: 2 },
  },
  {
    bot_id: "bot_07",
    legacy_ids: [],
    name: "MACD + RSI 골든크로스 (MACD Trend)",
    nickname: "MACD봇-제타",
    strategy_type: "MACD_TREND",
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
    description: "15분봉 거래량이 직전 20봉 평균 대비 300% 이상 폭발하며 양봉 마감 시 진입 | 고점 대비 -1.5% 트레일링 스탑",
    min_volume_krw: 5000000000,
    stop_loss_pct: 2.0,
    take_profit_pct: 8.0,
    config: { volume_spike_multiplier: 3.0, trailing_stop_pct: 1.5, order_ratio: 0.3, max_positions: 3 },
  },
  {
    bot_id: "bot_10",
    legacy_ids: [],
    name: "RSI 극단 과매도 & VWAP 회귀 (RSI VWAP Scalper)",
    nickname: "VWAP봇-이오타",
    strategy_type: "RSI_VWAP_SCALPER",
    description: "15분봉 RSI ≤ 25 패닉셀 & 당일 VWAP 대비 -3% 이상 이격 후 매수세 유입 시 진입 | VWAP 회귀 또는 RSI 50 도달 시 즉시 청산",
    min_volume_krw: 5000000000,
    stop_loss_pct: 3.0,
    take_profit_pct: 4.0,
    config: { rsi_threshold: 25, vwap_gap_pct: 3.0, exit_rsi: 50, order_ratio: 0.3, max_positions: 3 },
  },
];

export const ARENA_BOT_IDS = ARENA_BOT_DEFS.map((d) => d.bot_id);
export const LEGACY_BOT_ID_MAP = {};
for (const d of ARENA_BOT_DEFS) {
  for (const lid of d.legacy_ids) LEGACY_BOT_ID_MAP[lid] = d.bot_id;
}

/** 구버전 봇 ID(bot_volatility 등)를 신규 ID(bot_01 등)로 변환 */
export function normalizeBotId(botId) {
  return LEGACY_BOT_ID_MAP[botId] || botId;
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
  bot_01({ price, ind, held, params }) {
    const d = ind.day;
    if (!d) return hold("일봉 데이터 부족");
    if (held.length > 0) {
      const today = tradingDateKST(nowKSTString());
      if (held.some((p) => tradingDateKST(p.created_at) < today)) {
        return sell("익일 시가 청산 (1일 보유 만기)");
      }
      return hold("보유 중 (목표 수익/익일 시가 청산 대기)");
    }
    const k = Number(params.k_value ?? 0.45);
    const target = d.todayOpen + (d.prevHigh - d.prevLow) * k;
    const volMult = Number(params.volume_multiplier ?? 1.2);
    const volOk = ind.m15 ? ind.m15.volSurge5 >= volMult : true;
    if (price >= target && price > d.todayOpen && volOk) {
      return buy(`변동성 돌파(K=${k}) 목표가 ${ko(target)} 돌파 · 거래량 증가`);
    }
    return hold(`돌파목표 ${ko(target)} 대기 (현재 ${ko(price)})`);
  },

  // bot_02: SuperTrend + ATR 트레일링
  bot_02({ price, ind, held, params, options }) {
    const mult = Number(params.atr_multiplier ?? 2.5);
    const volMult = Number(params.volume_multiplier ?? 1.5);
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
  bot_03({ held, params, options }) {
    const info = options.momentumRank?.[options.market];
    if (!info) return hold("모멘텀 순위 산출 대기");
    const absTh = Number(params.abs_momentum_threshold_pct ?? 1.5);
    const topN = Number(params.top_n ?? 2);
    if (held.length > 0) {
      if (info.momPct < 0) return sell(`모멘텀 이탈 (7일 ${fmt(info.momPct)}%)`);
      return hold(`보유 중 (7일 모멘텀 ${fmt(info.momPct)}% / ${info.rank}위)`);
    }
    if (info.rank <= topN && info.momPct >= absTh) {
      return buy(`듀얼 모멘텀 ${info.rank}위 (7일 +${fmt(info.momPct)}% ≥ +${absTh}%)`);
    }
    return hold(`7일 모멘텀 ${info.rank}위 (${fmt(info.momPct)}%)`);
  },

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
    const volMult = Number(params.volume_multiplier ?? 2.0);
    const volRatio = Math.max(m.curVolRatio, m.closedVolRatio);
    if (squeezed && volRatio >= volMult && price > m.bb.upper) {
      return buy(`BB 스퀴즈(밴드폭 ${fmt(recent6Min * 100)}%) 후 거래량 ${fmt(volRatio, 1)}배 상단 돌파`);
    }
    return hold(`스퀴즈 ${squeezed ? "형성" : "미형성"} / 상단 ${ko(m.bb.upper)}`);
  },

  // bot_05: 볼린저 역추세 반등
  bot_05({ price, ind, held }) {
    const m = ind.m15;
    if (!m || !m.bb) return hold("15분봉 데이터 부족");
    if (held.length > 0) return hold("보유 중 (+3.5% 익절 / -2.0% 손절 감시)");
    const touched = m.minLow2 <= m.bb.lower;
    if (touched && m.curBullish && price > m.bb.lower && m.rsiMin3 <= 30) {
      return buy(`BB 하단 터치 후 양봉 복귀 · RSI ${fmt(m.rsiMin3, 1)} 과매도 반등`);
    }
    return hold(`BB 하단 ${ko(m.bb.lower)} / RSI ${fmt(m.rsi, 1)}`);
  },

  // bot_06: 다단계 분할 매수 그리드
  bot_06({ price, ind, held, params }) {
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
    const rsiEntry = Number(params.rsi_entry ?? 35);
    if (m.rsi <= rsiEntry && price <= m.bb.lower * 1.005) {
      return buy(`단기 과매도 그리드 1차 진입 (RSI ${fmt(m.rsi, 1)}, BB 하단 부근)`, { splitIndex: 1 });
    }
    return hold(`과매도 대기 (RSI ${fmt(m.rsi, 1)})`);
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
  bot_08({ price, ind, held, params }) {
    const d = ind.day;
    const h4 = ind.m240;
    if (!d || !h4 || d.ma60 === null || h4.ma60 === null) return hold("일봉/4시간봉 데이터 부족");
    if (held.length > 0) {
      if (d.recentHigh20 && price >= d.recentHigh20 * 0.995) return sell("직전 고점 부근 익절");
      return hold("보유 중 (직전 고점 익절 대기)");
    }
    const dayAligned = d.ma5 > d.ma20 && d.ma20 > d.ma60;
    const h4Aligned = h4.ma5 > h4.ma20 && h4.ma20 > h4.ma60;
    const band = Number(params.pullback_band_pct ?? 1.5);
    const gap = pctChange(price, d.ma20);
    const volDecline = h4.lastClosedVolRatio < 1.0;
    if (dayAligned && h4Aligned && Math.abs(gap) <= band && volDecline) {
      return buy(`정배열(5>20>60) 20일선 눌림목 지지 (이격 ${fmt(gap)}%, 거래량 감소)`);
    }
    return hold(`정배열 ${dayAligned && h4Aligned ? "O" : "X"} / 20선 이격 ${fmt(gap)}%`);
  },

  // bot_09: 거래량 폭발 모멘텀 스캘퍼
  bot_09({ price, ind, held, params, options }) {
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
    const spike = Number(params.volume_spike_multiplier ?? 3.0);
    const closedClose = Number(m.closed.trade_price);
    if (m.closedVolRatio >= spike && m.closedBullish && price >= closedClose && pctChange(price, closedClose) <= 1.5) {
      return buy(`15분봉 거래량 ${fmt(m.closedVolRatio, 1)}배 폭발 양봉 마감`);
    }
    return hold(`거래량 ${fmt(m.closedVolRatio, 1)}배 (기준 ${spike}배)`);
  },

  // bot_10: RSI 극단 과매도 & VWAP 회귀
  bot_10({ price, ind, held, params }) {
    const m = ind.m15;
    if (!m) return hold("15분봉 데이터 부족");
    const exitRsi = Number(params.exit_rsi ?? 50);
    if (held.length > 0) {
      if (m.vwap && price >= m.vwap) return sell("VWAP 회귀 청산");
      if (m.rsi >= exitRsi) return sell(`RSI ${fmt(m.rsi, 1)} ≥ ${exitRsi} 도달 청산`);
      return hold("보유 중 (VWAP 회귀/RSI 50 대기)");
    }
    if (!m.vwap) return hold("VWAP 산출 대기");
    const rsiTh = Number(params.rsi_threshold ?? 25);
    const gapNeed = Number(params.vwap_gap_pct ?? 3.0);
    const gap = pctChange(price, m.vwap);
    const buyersIn = m.curBullish || price > Number(m.closed.trade_price);
    if (m.rsiMin3 <= rsiTh && gap <= -gapNeed && buyersIn) {
      return buy(`RSI ${fmt(m.rsiMin3, 1)} 패닉셀 · VWAP 대비 ${fmt(gap)}% 이격 후 매수세 유입`);
    }
    return hold(`RSI ${fmt(m.rsi, 1)} / VWAP 이격 ${fmt(gap)}%`);
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

/** bots 테이블 선택/가상거래 컬럼 및 paper_trades 사유 컬럼 보강 (중복 컬럼 예외 방어) */
export async function ensureArenaSchema(db) {
  const cols = await columnNames(db, "bots");
  const hadSelectionColumn = cols.includes("is_selected_for_live");
  await addColumnSafe(db, "bots", "is_selected_for_live", "INTEGER NOT NULL DEFAULT 0");
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
      bot_id, name, nickname, strategy_type, description,
      allocation_ratio, allocated_capital, virtual_krw, is_running,
      min_volume_krw, stop_loss_pct, take_profit_pct, config_json,
      last_status_msg, updated_at,
      is_selected_for_live, paper_initial_capital, paper_virtual_krw, paper_is_running,
      paper_peak_equity, paper_mdd_pct, paper_status_msg
    ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?, '대기 중', ?, 0, ?, ?, 1, ?, 0, '시그널 대기 중')
  `);
  for (const def of ARENA_BOT_DEFS) {
    await insertBot.run(
      def.bot_id,
      def.name,
      def.nickname,
      def.strategy_type,
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
  const updateIdentity = db.prepare("UPDATE bots SET name = ?, strategy_type = ?, description = ? WHERE bot_id = ?");
  for (const def of ARENA_BOT_DEFS) {
    await fillEmpty.run(def.nickname, def.description, def.min_volume_krw, def.stop_loss_pct, def.take_profit_pct, def.bot_id);
    await updateIdentity.run(def.name, def.strategy_type, def.description, def.bot_id);
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
  const buyAmount = Math.floor(budgetKrw / (1 + PAPER_FEE_RATE));
  if (buyAmount < PAPER_MIN_ORDER_KRW) return null;
  const fee = Math.floor(buyAmount * PAPER_FEE_RATE);
  const volume = (buyAmount / price).toFixed(8);
  const now = nowKSTString();
  const uuid = `paper-bid-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const tr = await db
    .prepare(`
      INSERT INTO paper_trades (bot_id, market, buy_order_uuid, buy_price, buy_volume, buy_amount, buy_date, status, buy_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'HOLDING', ?)
    `)
    .run(bot.bot_id, market, uuid, price, volume, buyAmount, now, reason);
  const tradeId = Number(tr.lastInsertRowid);
  const pr = await db
    .prepare(`
      INSERT INTO paper_bot_positions (bot_id, market, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
    `)
    .run(bot.bot_id, market, uuid, volume, price, buyAmount, fee, tradeId, now);
  return { positionId: Number(pr.lastInsertRowid), tradeId, buyAmount, fee, volume, uuid };
}

/** 가상 매도 체결 (포지션별 개별 정산, 수수료 0.05% 반영) */
async function paperSell(db, bot, positions, price, reason) {
  const now = nowKSTString();
  const sellUuid = `paper-ask-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  let totalProfit = 0;
  for (const p of positions) {
    const gross = Math.floor(Number(p.volume) * price);
    const fee = Math.floor(gross * PAPER_FEE_RATE);
    const net = gross - fee;
    const profit = net - Number(p.buy_amount) - Number(p.buy_fee || 0);
    const profitPct = Number(p.buy_amount) > 0 ? Number(((profit / Number(p.buy_amount)) * 100).toFixed(2)) : 0;
    totalProfit += profit;
    await db.prepare("UPDATE paper_bot_positions SET status = 'CLOSED', closed_at = ? WHERE id = ? AND status = 'OPEN'").run(now, p.id);
    await db.prepare(`
      UPDATE paper_trades
      SET sell_order_uuid = ?, sell_price = ?, sell_volume = ?, sell_amount = ?, sell_date = ?,
          profit_krw = ?, profit_pct = ?, status = 'COMPLETED', sell_reason = ?
      WHERE id = ?
    `).run(sellUuid, price, String(p.volume), gross, now, profit, profitPct, reason, p.trade_id);
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

const COOLDOWN_MS = 10 * 60 * 1000;

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

  const isGrid = bot.bot_id === "bot_06";
  for (const market of candidates) {
    const held = heldByMarket.get(market) || [];
    if (held.length > 0 && !isGrid) continue;
    if (held.length === 0 && heldByMarket.size >= maxMarkets) continue;
    const cdAt = cooldownMap.get(`${bot.bot_id}|${market}`) || 0;
    if (held.length === 0 && Date.now() - cdAt < COOLDOWN_MS) continue;

    const md = mdMap.get(market);
    const sig = evaluateStrategy(bot.bot_id, md, md.indicators, held, {
      params,
      momentumRank: rankMap,
      market,
    });
    if (!firstNote && sig.signal === "HOLD") firstNote = `${market.replace("KRW-", "")}: ${sig.reason}`;
    if (sig.signal !== "BUY") continue;

    let ratio = normalizedOrderRatio(cfg, 0.3);
    if (isGrid) ratio = ratio / Math.max(1, Number(cfg.max_splits || 3));
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
  const initial = Number(bot.paper_initial_capital || DEFAULT_PAPER_CAPITAL);
  const closed = await db
    .prepare("SELECT profit_krw FROM paper_trades WHERE bot_id = ? AND status = 'COMPLETED'")
    .all(bot.bot_id);
  let realized = 0;
  let wins = 0;
  let loses = 0;
  for (const t of closed) {
    const p = Number(t.profit_krw || 0);
    realized += p;
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
    openCost += Number(p.buy_amount || 0) + Number(p.buy_fee || 0);
    const tk = lastPriceMap.get(p.market);
    const cur = Number(tk?.trade_price || p.avg_buy_price);
    const evalKrw = Math.floor(Number(p.volume) * cur);
    openEval += evalKrw;
    openList.push({
      id: p.id,
      market: p.market,
      avg_buy_price: Number(p.avg_buy_price),
      current_price: cur,
      volume: p.volume,
      buy_amount: Number(p.buy_amount),
      eval_krw: evalKrw,
      pnl_pct: Number(pctChange(cur, Number(p.avg_buy_price)).toFixed(2)),
      created_at: p.created_at,
    });
  }
  const cash = Math.max(0, Math.floor(initial + realized - openCost));
  const evalAssets = cash + openEval;
  const profitKrw = evalAssets - initial;
  const decided = wins + loses;
  return {
    bot_id: bot.bot_id,
    initial_capital: initial,
    cash_krw: cash,
    eval_assets_krw: evalAssets,
    cumulative_profit_krw: profitKrw,
    profit_rate_pct: Number(((profitKrw / initial) * 100).toFixed(2)),
    realized_profit_krw: realized,
    unrealized_profit_krw: openEval - openCost,
    win_trades: wins,
    lose_trades: loses,
    total_trades: closed.length,
    win_rate_pct: decided > 0 ? Number(((wins / decided) * 100).toFixed(1)) : 0.0,
    open_positions_count: open.length,
    open_positions: openList,
  };
}

/** 10개 봇 실시간 가상거래 경쟁 순위 (1위~10위) */
export async function getArenaLeaderboard(db) {
  const bots = await db.prepare("SELECT * FROM bots ORDER BY bot_id ASC").all();
  const rows = [];
  for (const bot of bots) {
    const s = await computeBotArenaStats(db, bot);
    rows.push({
      ...s,
      name: bot.name,
      nickname: bot.nickname,
      strategy_type: bot.strategy_type,
      description: bot.description,
      is_selected_for_live: Number(bot.is_selected_for_live || 0),
      paper_is_running: Number(bot.paper_is_running || 1),
      mdd_pct: Number(Number(bot.paper_mdd_pct || 0).toFixed(2)),
      last_signal_text: bot.paper_status_msg || "시그널 대기 중",
    });
  }
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
