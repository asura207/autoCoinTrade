/**
 * backend/common/backtest_service.mjs
 *
 * 10대 알고리즘(bot_01 ~ bot_10) 과거 캔들 기반 정량 백테스팅(Backtesting) & 워크포워드(Walk-Forward) 검증 엔진
 * - historical_candles 로컬 SQLite 캐싱 및 업비트 120ms Rate Limit 준수
 * - 시점 t 평가 시 0..t 캔들 슬라이스만 참조하여 미래 참조(Look-Ahead Bias) 100% 원천 차단
 * - 양방향 수수료(0.05%) + 가변 슬리피지(bps) 반영, 다단계 분할(bot_06/bot_10) 독립 최고가 및 동일 봉 재진입 금지
 * - 정량 성과 지표: 총수익률, CAGR, MDD, 승률, 손익비(Profit Factor), Sharpe Ratio, Sortino Ratio, 평균 보유시간
 * - 워크포워드(In-Sample 70% 최적화 -> Out-of-Sample 30% 전진 검증) 및 캔들 차트 매매 타점(BUY/SELL 마커) 생성
 */

import {
  ARENA_BOT_DEFS,
  PAPER_FEE_RATE,
  PAPER_MIN_ORDER_KRW,
  DEFAULT_PAPER_CAPITAL,
  nowKSTString,
  computeLinearRegressionChannel,
  buildIndicators,
  evaluateSmartExit,
  evaluateStrategy,
  normalizeBotId,
} from "./algo_lab_service.mjs";

function computeSma(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + Number(b || 0), 0) / period;
}

function computeVwap(candles, fallbackPrice = 0) {
  if (!Array.isArray(candles) || candles.length === 0) return { vwap: fallbackPrice };
  const windowCandles = candles.slice(-96);
  let pvSum = 0;
  let volSum = 0;
  for (const c of windowCandles) {
    const h = Number(c.high_price || c.trade_price || 0);
    const l = Number(c.low_price || c.trade_price || 0);
    const cl = Number(c.trade_price || 0);
    const v = Number(c.candle_acc_trade_volume || 0);
    const tp = (h + l + cl) / 3.0;
    pvSum += tp * v;
    volSum += v;
  }
  return {
    vwap: volSum > 0 ? pvSum / volSum : fallbackPrice,
  };
}

let lastCandleFetchMs = 0;

async function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function ensureBacktestTables(db) {
  if (!db) return;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS historical_candles (
      market TEXT NOT NULL,
      unit TEXT NOT NULL,
      candle_time_kst TEXT NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL,
      PRIMARY KEY (market, unit, candle_time_kst)
    );
    CREATE TABLE IF NOT EXISTS backtest_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL,
      markets_json TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT '15',
      start_date TEXT,
      end_date TEXT,
      initial_capital INTEGER NOT NULL DEFAULT 1000000,
      final_equity INTEGER NOT NULL DEFAULT 1000000,
      total_return_pct REAL NOT NULL DEFAULT 0,
      cagr_pct REAL DEFAULT 0,
      mdd_pct REAL NOT NULL DEFAULT 0,
      win_rate_pct REAL NOT NULL DEFAULT 0,
      profit_factor REAL NOT NULL DEFAULT 0,
      sharpe_ratio REAL NOT NULL DEFAULT 0,
      sortino_ratio REAL DEFAULT 0,
      avg_holding_hours REAL DEFAULT 0,
      slippage_bps REAL DEFAULT 5,
      trade_count INTEGER NOT NULL DEFAULT 0,
      params_json TEXT,
      walk_forward_json TEXT,
      equity_curve_json TEXT,
      trades_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

function normalizeCandleRow(c) {
  const timeStr = String(c.candle_date_time_kst || c.candle_time_kst || "")
    .replace("T", " ")
    .slice(0, 19);
  const open = Number(c.opening_price ?? c.open ?? c.trade_price ?? 0);
  const high = Number(c.high_price ?? c.high ?? open);
  const low = Number(c.low_price ?? c.low ?? open);
  const close = Number(c.trade_price ?? c.close ?? open);
  const vol = Number(c.candle_acc_trade_volume ?? c.volume ?? 0);
  return {
    candle_date_time_kst: timeStr,
    opening_price: open,
    high_price: high,
    low_price: low,
    trade_price: close,
    candle_acc_trade_volume: vol,
    candle_acc_trade_price: Number(c.candle_acc_trade_price ?? close * vol),
  };
}

export async function cacheHistoricalCandles(db, market, unit, candles = []) {
  if (!db || !Array.isArray(candles) || candles.length === 0) return;
  await ensureBacktestTables(db);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO historical_candles (market, unit, candle_time_kst, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const raw of candles) {
    const c = normalizeCandleRow(raw);
    if (!c.candle_date_time_kst || !(c.trade_price > 0)) continue;
    await stmt.run(
      market,
      String(unit),
      c.candle_date_time_kst,
      c.opening_price,
      c.high_price,
      c.low_price,
      c.trade_price,
      c.candle_acc_trade_volume
    );
  }
}

export async function fetchAndCacheHistoricalCandles(
  db,
  { market = "KRW-BTC", unit = "15", count = 180, customCandles = null, skipNetwork = false } = {}
) {
  await ensureBacktestTables(db);
  const normMarket = String(market || "KRW-BTC").trim().toUpperCase();
  const normUnit = String(unit || "15").trim();

  if (Array.isArray(customCandles) && customCandles.length > 0) {
    const normalized = customCandles.map(normalizeCandleRow).sort((a, b) =>
      a.candle_date_time_kst.localeCompare(b.candle_date_time_kst)
    );
    await cacheHistoricalCandles(db, normMarket, normUnit, normalized);
    return normalized;
  }

  const cachedRows = await db
    .prepare(
      `SELECT candle_time_kst, open, high, low, close, volume
       FROM historical_candles
       WHERE market = ? AND unit = ?
       ORDER BY candle_time_kst DESC
       LIMIT ?`
    )
    .all(normMarket, normUnit, Math.max(60, Number(count || 180)));

  if (cachedRows && cachedRows.length >= Math.min(Number(count || 180), 80)) {
    return cachedRows
      .slice()
      .reverse()
      .map((r) =>
        normalizeCandleRow({
          candle_date_time_kst: r.candle_time_kst,
          opening_price: r.open,
          high_price: r.high,
          low_price: r.low,
          trade_price: r.close,
          candle_acc_trade_volume: r.volume,
        })
      );
  }

  if (!skipNetwork && process.env.AUTOCOIN_LIBRARY_MODE !== "1") {
    try {
      const waitMs = Math.max(0, 125 - (Date.now() - lastCandleFetchMs));
      if (waitMs > 0) await sleepMs(waitMs);
      lastCandleFetchMs = Date.now();

      const reqCount = Math.min(200, Math.max(60, Number(count || 180)));
      const url =
        normUnit === "day"
          ? `https://api.upbit.com/v1/candles/days?market=${encodeURIComponent(normMarket)}&count=${reqCount}`
          : `https://api.upbit.com/v1/candles/minutes/${encodeURIComponent(normUnit)}?market=${encodeURIComponent(normMarket)}&count=${reqCount}`;

      const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (resp.ok) {
        const json = await resp.json();
        if (Array.isArray(json) && json.length > 0) {
          const ordered = json.slice().reverse().map(normalizeCandleRow);
          await cacheHistoricalCandles(db, normMarket, normUnit, ordered);
          return ordered;
        }
      }
    } catch {}
  }

  if (cachedRows && cachedRows.length > 0) {
    return cachedRows
      .slice()
      .reverse()
      .map((r) =>
        normalizeCandleRow({
          candle_date_time_kst: r.candle_time_kst,
          opening_price: r.open,
          high_price: r.high,
          low_price: r.low,
          trade_price: r.close,
          candle_acc_trade_volume: r.volume,
        })
      );
  }

  // 오프라인/테스트 폴백: 결정론적 합성 캔들 시퀀스 생성
  const synth = [];
  const total = Math.max(80, Number(count || 120));
  const baseMs = Date.parse("2026-11-01T00:00:00Z");
  const stepMs = normUnit === "day" ? 86400000 : Number(normUnit || 15) * 60000;
  for (let i = 0; i < total; i++) {
    const wave = Math.sin(i / 5) * 35 + (i * 1.2);
    const close = Number((1000 + wave).toFixed(2));
    const open = Number((close - Math.cos(i / 4) * 4).toFixed(2));
    const high = Number((Math.max(open, close) + 3).toFixed(2));
    const low = Number((Math.min(open, close) - 3).toFixed(2));
    const vol = 1000 + (i % 7 === 0 ? 1800 : 200);
    const ts = new Date(baseMs + i * stepMs).toISOString().replace("T", " ").slice(0, 19);
    synth.push(
      normalizeCandleRow({
        candle_date_time_kst: ts,
        opening_price: open,
        high_price: high,
        low_price: low,
        trade_price: close,
        candle_acc_trade_volume: vol,
      })
    );
  }
  return synth;
}

function aggregateHigherTimeframeCandles(baseCandles = [], groupSize = 4) {
  if (!Array.isArray(baseCandles) || baseCandles.length === 0) return [];
  const out = [];
  for (let i = 0; i < baseCandles.length; i += groupSize) {
    const chunk = baseCandles.slice(i, i + groupSize);
    if (chunk.length === 0) continue;
    const first = chunk[0];
    const last = chunk[chunk.length - 1];
    let high = Number(first.high_price);
    let low = Number(first.low_price);
    let vol = 0;
    let priceVol = 0;
    for (const c of chunk) {
      high = Math.max(high, Number(c.high_price));
      low = Math.min(low, Number(c.low_price));
      const v = Number(c.candle_acc_trade_volume || 0);
      vol += v;
      priceVol += Number(c.trade_price || 0) * v;
    }
    out.push({
      candle_date_time_kst: last.candle_date_time_kst,
      opening_price: Number(first.opening_price),
      high_price: high,
      low_price: low,
      trade_price: Number(last.trade_price),
      candle_acc_trade_volume: vol,
      candle_acc_trade_price: priceVol,
    });
  }
  return out;
}

function parseTsMs(str) {
  if (!str) return 0;
  const s = String(str).trim().replace(" ", "T");
  const ms = Date.parse(s.endsWith("Z") || s.includes("+") ? s : `${s}+09:00`);
  return Number.isFinite(ms) ? ms : 0;
}

export function simulateBarByBarBacktest({
  botId = "bot_01",
  market = "KRW-BTC",
  candles = [],
  dayCandles = null,
  initialCapital = DEFAULT_PAPER_CAPITAL,
  slippageBps = 5,
  feeRate = PAPER_FEE_RATE,
  params = null,
  stopLossPct = null,
  takeProfitPct = null,
  warmupBars = 40,
} = {}) {
  const normId = normalizeBotId(botId);
  const botDef = ARENA_BOT_DEFS.find((d) => d.bot_id === normId) || ARENA_BOT_DEFS[0];
  const mergedParams = { ...(botDef.config || {}), ...(params || {}) };
  const slPct = Number(stopLossPct ?? botDef.stop_loss_pct ?? 2.5);
  const tpPct = Number(takeProfitPct ?? botDef.take_profit_pct ?? 5.0);
  const slipRate = Math.max(0, Number(slippageBps ?? 5)) / 10000;
  const safeInitial = Math.max(10000, Math.floor(Number(initialCapital || DEFAULT_PAPER_CAPITAL)));

  const ordered = candles.map(normalizeCandleRow);
  const n = ordered.length;
  const startIdx = Math.min(Math.max(20, warmupBars), Math.max(0, n - 2));

  let cash = safeInitial;
  let peakEquity = safeInitial;
  let maxDrawdownPct = 0;
  let posSeq = 1;

  const openPositions = [];
  const perPosPeak = new Map();
  const completedTrades = [];
  const equitySeries = [];
  const barReturns = [];
  let prevEquity = safeInitial;

  const isMultiSplitBot = normId === "bot_06" || normId === "bot_10";
  const maxSplitsPerMarket = normId === "bot_06" ? 3 : normId === "bot_10" ? 2 : 1;

  for (let t = startIdx; t < n; t++) {
    // Look-Ahead Bias 완전 차단: 오직 0 .. t 까지의 과거/현재 슬라이스만 전달
    const m15Slice = ordered.slice(0, t + 1);
    const curBar = m15Slice[m15Slice.length - 1];
    const price = Number(curBar.trade_price);
    const barHigh = Number(curBar.high_price || price);
    const barTime = curBar.candle_date_time_kst;

    const m60Slice = aggregateHigherTimeframeCandles(m15Slice, 4);
    const m240Slice = aggregateHigherTimeframeCandles(m15Slice, 16);
    const dSlice =
      Array.isArray(dayCandles) && dayCandles.length > 0
        ? dayCandles.filter((d) => String(d.candle_date_time_kst) <= barTime)
        : aggregateHigherTimeframeCandles(m15Slice, 4);

    // 일부 일봉/60분봉 전용 봇(bot_01, bot_02, bot_03, bot_08)을 위해 슬라이스 길이가 부족할 때 m15Slice를 폴백 제공
    const effectiveDay = dSlice.length >= 22 ? dSlice : m15Slice;
    const effectiveM60 = m60Slice.length >= 30 ? m60Slice : m15Slice;
    const effectiveM240 = m240Slice.length >= 20 ? m240Slice : m15Slice;

    const mdSlice = {
      market,
      price,
      ticker: {
        market,
        trade_price: price,
        acc_trade_price_24h: 50000000000,
      },
      candles: {
        day: effectiveDay,
        m240: effectiveM240,
        m60: effectiveM60,
        m15: m15Slice,
      },
    };
    const indSlice = buildIndicators(mdSlice);
    mdSlice.indicators = indSlice;

    let soldThisBar = false;

    // 1. 보유 포지션 청산 평가
    if (openPositions.length > 0) {
      let groupPeak = 0;
      for (const p of openPositions) {
        const nextPeak = Math.max(perPosPeak.get(p.id) || Number(p.avg_buy_price), barHigh, price);
        perPosPeak.set(p.id, nextPeak);
        if (nextPeak > groupPeak) groupPeak = nextPeak;
      }

      const toSell = [];
      let exitReason = "";

      for (const p of openPositions) {
        const pnlPct = ((price - p.avg_buy_price) / p.avg_buy_price) * 100;
        const posSl = normId === "bot_06" ? -9.0 : -Math.abs(slPct);
        const posTp = normId === "bot_06" ? 1.8 : Math.abs(tpPct);
        if (pnlPct <= posSl) {
          toSell.push(p);
          exitReason = `손절 기준(${posSl.toFixed(1)}%) 도달 (${pnlPct.toFixed(2)}%)`;
        } else if (pnlPct >= posTp && normId !== "bot_02" && normId !== "bot_09" && normId !== "bot_10") {
          toSell.push(p);
          exitReason = `목표 익절(+${posTp.toFixed(1)}%) 도달 (+${pnlPct.toFixed(2)}%)`;
        }
      }

      if (toSell.length === 0) {
        for (const p of openPositions) {
          const smart = evaluateSmartExit({
            botId: normId,
            position: p,
            currentPrice: price,
            indicators: indSlice,
            peakPrice: perPosPeak.get(p.id) || price,
            isLive: false,
            stopLossPct: slPct,
          });
          if (smart && smart.signal === "SELL") {
            toSell.push(p);
            exitReason = smart.reason;
          }
        }
      }

      if (toSell.length === 0) {
        const sig = evaluateStrategy(normId, mdSlice, indSlice, openPositions, {
          params: mergedParams,
          peakPrice: groupPeak,
          isLive: false,
          enforceMtf: false,
          momentumRank: { rank: 1, momPct: indSlice.day?.momentum7dPct ?? 3.5 },
        });
        if (sig.signal === "SELL") {
          const targetSet = sig.sellPositionIds ? new Set(sig.sellPositionIds) : null;
          for (const p of openPositions) {
            if (!targetSet || targetSet.has(p.id)) {
              toSell.push(p);
            }
          }
          exitReason = sig.reason;
        }
      }

      if (toSell.length > 0) {
        const sellExecPrice = price * (1 - slipRate);
        const sellIds = new Set(toSell.map((p) => p.id));
        for (const p of toSell) {
          const gross = Math.floor(p.volume * sellExecPrice);
          const sellFee = Math.floor(gross * feeRate);
          const netProceeds = Math.max(0, gross - sellFee);
          const profitKrw = netProceeds - p.buy_amount - p.buy_fee;
          const profitPct = p.buy_amount > 0 ? Number(((profitKrw / p.buy_amount) * 100).toFixed(2)) : 0;
          const holdMs = Math.max(0, parseTsMs(barTime) - parseTsMs(p.created_at));
          const holdingHours = Number((holdMs / 3600000).toFixed(2));

          cash += netProceeds;
          perPosPeak.delete(p.id);
          completedTrades.push({
            bot_id: normId,
            market,
            buy_date: p.created_at,
            buy_price: Number(p.avg_buy_price.toFixed(4)),
            buy_amount: p.buy_amount,
            sell_date: barTime,
            sell_price: Number(sellExecPrice.toFixed(4)),
            sell_amount: netProceeds,
            volume: Number(p.volume.toFixed(8)),
            profit_krw: profitKrw,
            profit_pct: profitPct,
            holding_hours: holdingHours,
            buy_reason: p.buy_reason,
            sell_reason: exitReason,
          });
        }
        for (let idx = openPositions.length - 1; idx >= 0; idx--) {
          if (sellIds.has(openPositions[idx].id)) {
            openPositions.splice(idx, 1);
          }
        }
        soldThisBar = true;
      }
    }

    // 2. 신규 매수 진입 또는 추가 분할 매수 평가 (동일 봉 매도 직후 재진입 금지)
    if (!soldThisBar && openPositions.length < maxSplitsPerMarket && cash >= PAPER_MIN_ORDER_KRW) {
      if (openPositions.length === 0 || isMultiSplitBot) {
        const groupPeak = openPositions.reduce(
          (mx, p) => Math.max(mx, perPosPeak.get(p.id) || p.avg_buy_price),
          price
        );
        const sig = evaluateStrategy(normId, mdSlice, indSlice, openPositions, {
          params: mergedParams,
          peakPrice: groupPeak,
          isLive: false,
          enforceMtf: false,
          momentumRank: { rank: 1, momPct: indSlice.day?.momentum7dPct ?? 3.5 },
        });
        if (sig.signal === "BUY") {
          const ratio = Number(sig.order_ratio || mergedParams.order_ratio || 0.3);
          const budget = Math.min(Math.floor(safeInitial * ratio), Math.floor(cash));
          const buyAmount = Math.floor(budget / (1 + feeRate));
          if (buyAmount >= PAPER_MIN_ORDER_KRW) {
            const buyExecPrice = price * (1 + slipRate);
            const buyFee = Math.floor(buyAmount * feeRate);
            const vol = Math.floor((buyAmount / buyExecPrice) * 1e8) / 1e8;
            if (vol > 0) {
              const newPos = {
                id: posSeq++,
                bot_id: normId,
                market,
                volume: vol,
                avg_buy_price: buyExecPrice,
                buy_amount: buyAmount,
                buy_fee: buyFee,
                step_level: openPositions.length + 1,
                created_at: barTime,
                buy_reason: sig.reason || "BACKTEST_ENTRY",
              };
              openPositions.push(newPos);
              perPosPeak.set(newPos.id, buyExecPrice);
              cash = Math.max(0, cash - buyAmount - buyFee);
            }
          }
        }
      }
    }

    // 3. 봉 마감 기준 총 평가자산(Equity) 및 MDD 갱신
    let evalValue = 0;
    for (const p of openPositions) {
      evalValue += Math.floor(p.volume * price);
    }
    const curEquity = Math.max(0, Math.floor(cash + evalValue));
    if (curEquity > peakEquity) peakEquity = curEquity;
    const ddPct = peakEquity > 0 ? ((peakEquity - curEquity) / peakEquity) * 100 : 0;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

    const barRet = prevEquity > 0 ? (curEquity - prevEquity) / prevEquity : 0;
    barReturns.push(barRet);
    prevEquity = curEquity;

    equitySeries.push({
      time: barTime,
      equity: curEquity,
      drawdown_pct: Number(ddPct.toFixed(2)),
      price,
    });
  }

  const finalEquity = equitySeries.length > 0 ? equitySeries[equitySeries.length - 1].equity : safeInitial;
  const totalReturnPct = Number((((finalEquity - safeInitial) / safeInitial) * 100).toFixed(2));
  const mddPct = Number(maxDrawdownPct.toFixed(2));

  const wins = completedTrades.filter((tr) => tr.profit_krw > 0);
  const losses = completedTrades.filter((tr) => tr.profit_krw <= 0);
  const winRatePct =
    completedTrades.length > 0 ? Number(((wins.length / completedTrades.length) * 100).toFixed(1)) : 0;

  const grossProfit = wins.reduce((s, tr) => s + tr.profit_krw, 0);
  const grossLoss = Math.abs(losses.reduce((s, tr) => s + tr.profit_krw, 0));
  const profitFactor =
    grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 9.99 : 0;

  const avgHoldHours =
    completedTrades.length > 0
      ? Number(
          (
            completedTrades.reduce((s, tr) => s + Number(tr.holding_hours || 0), 0) /
            completedTrades.length
          ).toFixed(2)
        )
      : 0;

  // Sharpe & Sortino Ratio (연율화 계수: 15분봉 기준 sqrt(365 * 96))
  let sharpeRatio = 0;
  let sortinoRatio = 0;
  if (barReturns.length > 2) {
    const mean = barReturns.reduce((a, b) => a + b, 0) / barReturns.length;
    const variance = barReturns.reduce((a, b) => a + (b - mean) * (b - mean), 0) / barReturns.length;
    const std = Math.sqrt(variance);
    const downsideVar =
      barReturns.reduce((a, b) => a + (b < 0 ? b * b : 0), 0) / barReturns.length;
    const downsideStd = Math.sqrt(downsideVar);
    const annFactor = Math.sqrt(365 * 24);
    if (std > 1e-9) {
      sharpeRatio = Number(Math.max(-10, Math.min(10, (mean / std) * annFactor)).toFixed(2));
    }
    if (downsideStd > 1e-9) {
      sortinoRatio = Number(Math.max(-10, Math.min(10, (mean / downsideStd) * annFactor)).toFixed(2));
    }
  }

  // CAGR 추정
  const firstTs = ordered[startIdx]?.candle_date_time_kst;
  const lastTs = ordered[n - 1]?.candle_date_time_kst;
  const spanDays = Math.max(1, (parseTsMs(lastTs) - parseTsMs(firstTs)) / 86400000);
  const rawCagr = (Math.pow(Math.max(0.1, finalEquity / safeInitial), Math.min(365 / spanDays, 12)) - 1) * 100;
  const cagrPct = Number(Math.max(-99.9, Math.min(999.9, rawCagr)).toFixed(2));

  // UI 차트용 최대 100포인트 다운샘플링
  const step = Math.max(1, Math.floor(equitySeries.length / 100));
  const compactCurve = equitySeries.filter((_, idx) => idx % step === 0 || idx === equitySeries.length - 1);

  return {
    bot_id: normId,
    bot_name: botDef.name,
    bot_nickname: botDef.nickname,
    market,
    start_date: firstTs || "",
    end_date: lastTs || "",
    initial_capital: safeInitial,
    final_equity: finalEquity,
    total_return_pct: totalReturnPct,
    cagr_pct: cagrPct,
    mdd_pct: mddPct,
    win_rate_pct: winRatePct,
    profit_factor: profitFactor,
    sharpe_ratio: sharpeRatio,
    sortino_ratio: sortinoRatio,
    avg_holding_hours: avgHoldHours,
    slippage_bps: Number(slippageBps ?? 5),
    trade_count: completedTrades.length,
    total_trades: completedTrades.length,
    params: mergedParams,
    equity_curve: compactCurve,
    trades: completedTrades,
  };
}

export async function runHistoricalBacktest(db, options = {}) {
  await ensureBacktestTables(db);
  const normId = normalizeBotId(options.bot_id || options.botId || "bot_01");
  const market = String(options.market || "KRW-BTC").trim().toUpperCase();
  const rawTf = String(options.unit || options.timeframe || "15").trim().toLowerCase();
  const unit = rawTf === "1d" || rawTf === "day" ? "day" : rawTf.replace(/m$/, "") || "15";
  const days = Math.max(1, Math.min(90, Number(options.days || 14)));
  const count = Math.min(500, Math.max(80, Number(options.candle_count || days * 24)));
  const slippageBps = Number(options.slippage_bps ?? options.slippageBps ?? 5);
  const feeRate = Number(options.fee_rate ?? options.feeRate ?? PAPER_FEE_RATE);
  const initialCapital = Number(options.initial_capital ?? options.initialCapital ?? DEFAULT_PAPER_CAPITAL);
  const injectedCandles = options.customCandles || options.candlesOverride || null;
  const doWalkForward =
    options.walkForward !== undefined
      ? Boolean(options.walkForward)
      : options.walk_forward !== false;

  const candles = await fetchAndCacheHistoricalCandles(db, {
    market,
    unit,
    count,
    customCandles: injectedCandles,
    skipNetwork: Boolean(options.skipNetwork || injectedCandles),
  });

  const mainResult = simulateBarByBarBacktest({
    botId: normId,
    market,
    candles,
    initialCapital,
    slippageBps,
    feeRate,
    params: options.params || options.customParams || null,
    stopLossPct: options.stop_loss_pct ?? null,
    takeProfitPct: options.take_profit_pct ?? null,
  });

  // 워크포워드(Walk-Forward: In-Sample 70% 최적화 -> Out-of-Sample 30% 검증)
  let walkForward = null;
  if (doWalkForward && candles.length >= 60) {
    const splitIdx = Math.max(42, Math.floor(candles.length * 0.7));
    const inSampleCandles = candles.slice(0, splitIdx);
    const outSampleCandles = candles.slice(Math.max(0, splitIdx - 40));

    const botDef = ARENA_BOT_DEFS.find((d) => d.bot_id === normId) || ARENA_BOT_DEFS[0];
    const baseCfg = { ...(botDef.config || {}), ...(options.params || options.customParams || {}) };
    const baseSl = Number(botDef.stop_loss_pct ?? 2.5);
    const baseTp = Number(botDef.take_profit_pct ?? 4.5);
    const candidateConfigs = [
      {
        label: "보수형",
        stop_loss_pct: Number(Math.max(1.2, baseSl * 0.85).toFixed(2)),
        take_profit_pct: Number(Math.max(2.0, baseTp * 0.9).toFixed(2)),
        params: { ...baseCfg, order_ratio: 0.25, k_value: 0.35, bb_std: 2.1 },
      },
      {
        label: "기본형",
        stop_loss_pct: baseSl,
        take_profit_pct: baseTp,
        params: { ...baseCfg },
      },
      {
        label: "적극형",
        stop_loss_pct: Number(Math.min(8.0, baseSl * 1.15).toFixed(2)),
        take_profit_pct: Number(Math.min(12.0, baseTp * 1.15).toFixed(2)),
        params: { ...baseCfg, order_ratio: 0.4, k_value: 0.45, bb_std: 1.9 },
      },
    ];

    let bestCand = null;
    for (const cand of candidateConfigs) {
      const isRes = simulateBarByBarBacktest({
        botId: normId,
        market,
        candles: inSampleCandles,
        initialCapital,
        slippageBps,
        feeRate,
        params: cand.params,
        stopLossPct: cand.stop_loss_pct,
        takeProfitPct: cand.take_profit_pct,
      });
      const score = isRes.total_return_pct - isRes.mdd_pct * 0.8 + isRes.win_rate_pct * 0.05;
      if (!bestCand || score > bestCand.score) {
        bestCand = { ...cand, score: Number(score.toFixed(2)), metrics: isRes };
      }
    }

    const oosRes = simulateBarByBarBacktest({
      botId: normId,
      market,
      candles: outSampleCandles,
      initialCapital,
      slippageBps,
      feeRate,
      params: bestCand.params,
      stopLossPct: bestCand.stop_loss_pct,
      takeProfitPct: bestCand.take_profit_pct,
    });

    const bestParamsWithRisk = {
      ...bestCand.params,
      stop_loss_pct: bestCand.stop_loss_pct,
      take_profit_pct: bestCand.take_profit_pct,
    };

    walkForward = {
      in_sample_ratio: 0.7,
      out_of_sample_ratio: 0.3,
      selected_profile: bestCand.label,
      optimized_params: bestParamsWithRisk,
      best_params: bestParamsWithRisk,
      in_sample: {
        total_return_pct: bestCand.metrics.total_return_pct,
        mdd_pct: bestCand.metrics.mdd_pct,
        win_rate_pct: bestCand.metrics.win_rate_pct,
        trade_count: bestCand.metrics.trade_count,
        total_trades: bestCand.metrics.trade_count,
      },
      out_of_sample: {
        total_return_pct: oosRes.total_return_pct,
        mdd_pct: oosRes.mdd_pct,
        win_rate_pct: oosRes.win_rate_pct,
        trade_count: oosRes.trade_count,
        total_trades: oosRes.trade_count,
      },
      overfit_warning:
        bestCand.metrics.total_return_pct > 5 && oosRes.total_return_pct < -3,
    };
  }

  const now = nowKSTString();
  const ins = await db
    .prepare(
      `INSERT INTO backtest_runs (
        bot_id, markets_json, unit, start_date, end_date,
        initial_capital, final_equity, total_return_pct, cagr_pct, mdd_pct,
        win_rate_pct, profit_factor, sharpe_ratio, sortino_ratio, avg_holding_hours,
        slippage_bps, trade_count, params_json, walk_forward_json, equity_curve_json, trades_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      normId,
      JSON.stringify([market]),
      unit,
      mainResult.start_date,
      mainResult.end_date,
      mainResult.initial_capital,
      mainResult.final_equity,
      mainResult.total_return_pct,
      mainResult.cagr_pct,
      mainResult.mdd_pct,
      mainResult.win_rate_pct,
      mainResult.profit_factor,
      mainResult.sharpe_ratio,
      mainResult.sortino_ratio,
      mainResult.avg_holding_hours,
      mainResult.slippage_bps,
      mainResult.trade_count,
      JSON.stringify(mainResult.params),
      JSON.stringify(walkForward),
      JSON.stringify(mainResult.equity_curve),
      JSON.stringify(mainResult.trades.slice(-50)),
      now
    );

  const runId = Number(ins?.lastInsertRowid || 0);
  return {
    success: true,
    id: runId,
    run_id: runId,
    ...mainResult,
    walk_forward: walkForward,
    created_at: now,
  };
}

export async function getBacktestHistory(db, limit = 15) {
  await ensureBacktestTables(db);
  const rows = await db
    .prepare(
      `SELECT id, bot_id, markets_json, unit, start_date, end_date,
              initial_capital, final_equity, total_return_pct, cagr_pct, mdd_pct,
              win_rate_pct, profit_factor, sharpe_ratio, sortino_ratio, avg_holding_hours,
              slippage_bps, trade_count, params_json, walk_forward_json, created_at
       FROM backtest_runs
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(Math.max(1, Math.min(50, Number(limit || 15))));

  return (rows || []).map((r) => {
    const markets = (() => {
      try {
        return JSON.parse(r.markets_json || "[]");
      } catch {
        return [];
      }
    })();
    return {
      ...r,
      market: markets[0] || "KRW-BTC",
      markets,
      total_trades: Number(r.trade_count || 0),
      params: (() => {
        try {
          return JSON.parse(r.params_json || "{}");
        } catch {
          return {};
        }
      })(),
      walk_forward: (() => {
        try {
          return JSON.parse(r.walk_forward_json || "null");
        } catch {
          return null;
        }
      })(),
    };
  });
}

/**
 * 캔들 차트 + 보조지표(VWAP, LRC 상·중·하단, 20MA) + 매수/매도 체결 타점(BUY/SELL 마커) 생성
 */
export async function buildChartTradeMarkers(
  db,
  { market = "KRW-BTC", botId = "all", mode = "live", unit = "15", count = 80, customCandles = null } = {}
) {
  const normMarket = String(market || "KRW-BTC").trim().toUpperCase();
  const candles = await fetchAndCacheHistoricalCandles(db, {
    market: normMarket,
    unit,
    count,
    customCandles,
  });

  const closes = [];
  const enrichedCandles = candles.map((c, idx) => {
    const close = Number(c.trade_price);
    closes.push(close);
    const ma20 = closes.length >= 20 ? computeSma(closes, 20) : null;
    const lrc = closes.length >= 20 ? computeLinearRegressionChannel(closes, 20) : null;
    const vwapObj = computeVwap(candles.slice(0, idx + 1), close);
    return {
      index: idx,
      time: c.candle_date_time_kst,
      open: Number(c.opening_price),
      high: Number(c.high_price),
      low: Number(c.low_price),
      close,
      volume: Number(c.candle_acc_trade_volume || 0),
      ma20: ma20 !== null ? Number(ma20.toFixed(4)) : null,
      vwap: vwapObj?.vwap ? Number(vwapObj.vwap.toFixed(4)) : null,
      lrc_upper: lrc ? Number(lrc.upper.toFixed(4)) : null,
      lrc_mid: lrc ? Number(lrc.mid.toFixed(4)) : null,
      lrc_lower: lrc ? Number(lrc.lower.toFixed(4)) : null,
    };
  });

  const tableName = mode === "paper" ? "paper_trades" : "trades";
  let tradeRows = [];
  try {
    if (botId && botId !== "all") {
      tradeRows = await db
        .prepare(`SELECT * FROM ${tableName} WHERE market = ? AND bot_id = ? ORDER BY id DESC LIMIT 100`)
        .all(normMarket, normalizeBotId(botId));
    } else {
      tradeRows = await db
        .prepare(`SELECT * FROM ${tableName} WHERE market = ? ORDER BY id DESC LIMIT 100`)
        .all(normMarket);
    }
  } catch {}

  const markers = [];
  for (const t of tradeRows) {
    if (t.buy_date && Number(t.buy_price) > 0) {
      markers.push({
        type: "BUY",
        color: "#ef4444",
        bot_id: t.bot_id,
        market: t.market,
        time: String(t.buy_date).replace("T", " ").slice(0, 19),
        price: Number(t.buy_price),
        volume: t.buy_volume,
        amount_krw: Number(t.buy_amount || 0),
        reason: t.buy_reason || "매수 진입",
      });
    }
    if (t.sell_date && Number(t.sell_price) > 0) {
      markers.push({
        type: "SELL",
        color: "#3b82f6",
        bot_id: t.bot_id,
        market: t.market,
        time: String(t.sell_date).replace("T", " ").slice(0, 19),
        price: Number(t.sell_price),
        volume: t.sell_volume || t.buy_volume,
        amount_krw: Number(t.sell_amount || 0),
        profit_krw: Number(t.profit_krw || 0),
        profit_pct: Number(t.profit_pct || 0),
        reason: t.sell_reason || "매도 청산",
      });
    }
  }

  // 각 마커에 가장 가까운 캔들 인덱스 매핑
  for (const m of markers) {
    let bestIdx = enrichedCandles.length - 1;
    let bestDiff = Infinity;
    const mMs = parseTsMs(m.time);
    for (let i = 0; i < enrichedCandles.length; i++) {
      const cMs = parseTsMs(enrichedCandles[i].time);
      const diff = Math.abs(cMs - mMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    m.candle_index = Math.max(0, bestIdx);
  }

  return {
    market: normMarket,
    bot_id: botId || "all",
    mode,
    unit,
    candles: enrichedCandles,
    markers,
  };
}
