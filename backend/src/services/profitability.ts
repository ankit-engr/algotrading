import { prisma } from '../db.js';

export interface BacktestTrade {
  entry_date: string;
  entry_price: number;
  exit_date: string;
  exit_price: number;
  pnl_pct: number;
  is_win: boolean;
}

export interface StatsResult {
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  win_rate: number;
  avg_profit_pct: number;
  avg_loss_pct: number;
  total_return_pct: number;
  max_drawdown_pct: number;
  sharpe_ratio: number;
  is_profitable: boolean;
  trades: BacktestTrade[];
}

export interface CurrentSignalResult {
  signal: 'BUY' | 'SELL' | 'HOLD';
  entry_price: number | null;
  stop_loss: number | null;
  target_1: number | null;
  target_2: number | null;
  rsi: number | null;
  macd: number | null;
  ema9: number | null;
  ema21: number | null;
}

export interface AnalysisOutput {
  symbol: string;
  is_profitable: boolean;
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  win_rate: number;
  avg_profit_pct: number;
  avg_loss_pct: number;
  total_return_pct: number;
  max_drawdown_pct: number;
  sharpe_ratio: number;
  current_signal: 'BUY' | 'SELL' | 'HOLD';
  entry_price: number | null;
  stop_loss: number | null;
  target_1: number | null;
  target_2: number | null;
  rsi: number | null;
  macd: number | null;
  ema9: number | null;
  ema21: number | null;
  recommendation: string;
}

// Concurrency pool helper
async function pLimit<T, R>(limit: number, array: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  async function worker() {
    while (index < array.length) {
      const curIndex = index++;
      const item = array[curIndex];
      try {
        results[curIndex] = await fn(item);
      } catch (err) {
        console.error('Analysis worker error:', err);
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, array.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Technical Indicator Helpers ───────────────────────────────────────────────

function ema(prices: number[], period: number): number[] {
  if (prices.length < period) return [];
  const k = 2.0 / (period + 1);
  const emaVals = [prices.slice(0, period).reduce((sum, p) => sum + p, 0) / period];
  for (let i = period; i < prices.length; i++) {
    emaVals.push(prices[i] * k + emaVals[emaVals.length - 1] * (1 - k));
  }
  return emaVals;
}

function rsi(prices: number[], period = 14): number[] {
  if (prices.length < period + 1) return [];
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    gains.push(Math.max(diff, 0));
    losses.push(Math.max(-diff, 0));
  }

  let avgGain = gains.slice(0, period).reduce((sum, g) => sum + g, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((sum, l) => sum + l, 0) / period;
  const rsiVals = [100.0 - (100.0 / (1.0 + (avgLoss === 0 ? 100 : avgGain / avgLoss)))];

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    if (avgLoss === 0) {
      rsiVals.push(100.0);
    } else {
      const rs = avgGain / avgLoss;
      rsiVals.push(100 - (100 / (1 + rs)));
    }
  }
  return rsiVals;
}

function macd(prices: number[], fast = 12, slow = 26, signal = 9): [number[], number[], number[]] {
  const emaFast = ema(prices, fast);
  const emaSlow = ema(prices, slow);

  const offset = slow - fast;
  const macdLine: number[] = [];
  for (let i = 0; i < emaSlow.length; i++) {
    macdLine.push(emaFast[i + offset] - emaSlow[i]);
  }

  const signalLine = ema(macdLine, signal);
  const histogram: number[] = [];
  for (let i = 0; i < signalLine.length; i++) {
    histogram.push(macdLine[i + signal - 1] - signalLine[i]);
  }

  return [macdLine, signalLine, histogram];
}

function sma(prices: number[], period: number): number[] {
  if (prices.length < period) return [];
  const smaVals = [];
  for (let i = 0; i <= prices.length - period; i++) {
    const sum = prices.slice(i, i + period).reduce((acc, p) => acc + p, 0);
    smaVals.push(sum / period);
  }
  return smaVals;
}

// ── Backtest Engine ────────────────────────────────────────────────────────────

function emptyResult(): StatsResult {
  return {
    total_trades: 0,
    winning_trades: 0,
    losing_trades: 0,
    win_rate: 0.0,
    avg_profit_pct: 0.0,
    avg_loss_pct: 0.0,
    total_return_pct: 0.0,
    max_drawdown_pct: 0.0,
    sharpe_ratio: 0.0,
    is_profitable: false,
    trades: []
  };
}

function computeStats(trades: BacktestTrade[], closes: number[]): StatsResult {
  const total = trades.length;
  if (total === 0) {
    return emptyResult();
  }

  const wins = trades.filter(t => t.is_win);
  const losses = trades.filter(t => !t.is_win);

  const winRate = (wins.length / total) * 100;
  const avgProfit = wins.reduce((sum, t) => sum + t.pnl_pct, 0) / Math.max(wins.length, 1);
  const avgLoss = losses.reduce((sum, t) => sum + t.pnl_pct, 0) / Math.max(losses.length, 1);

  // Compound total return
  let totalReturn = 1.0;
  for (const t of trades) {
    totalReturn *= (1 + t.pnl_pct / 100);
  }
  const totalReturnPct = (totalReturn - 1) * 100;

  // Max drawdown (on close prices)
  let peak = closes[0];
  let maxDd = 0.0;
  for (const c of closes) {
    if (c > peak) {
      peak = c;
    }
    const dd = ((peak - c) / peak) * 100;
    if (dd > maxDd) {
      maxDd = dd;
    }
  }

  // Sharpe ratio (simple: mean_pnl / std_pnl * sqrt(52))
  const pnls = trades.map(t => t.pnl_pct);
  const meanPnl = pnls.reduce((sum, p) => sum + p, 0) / pnls.length;
  const variance = pnls.reduce((sum, p) => sum + Math.pow(p - meanPnl, 2), 0) / Math.max(pnls.length - 1, 1);
  const stdPnl = Math.sqrt(variance);
  const sharpe = stdPnl > 0 ? (meanPnl / stdPnl) * Math.sqrt(52) : 0.0;

  return {
    total_trades: total,
    winning_trades: wins.length,
    losing_trades: losses.length,
    win_rate: parseFloat(winRate.toFixed(2)),
    avg_profit_pct: parseFloat(avgProfit.toFixed(2)),
    avg_loss_pct: parseFloat(avgLoss.toFixed(2)),
    total_return_pct: parseFloat(totalReturnPct.toFixed(2)),
    max_drawdown_pct: parseFloat(maxDd.toFixed(2)),
    sharpe_ratio: parseFloat(sharpe.toFixed(3)),
    is_profitable: winRate >= 55.0 && totalReturnPct > 0,
    trades
  };
}

export function backtest(candles: any[]): StatsResult {
  if (candles.length < 35) {
    return emptyResult();
  }

  const closes = candles.map(c => Number(c.close));
  const volumes = candles.map(c => Number(c.volume));
  const dates = candles.map(c => c.date);

  const ema9Full = ema(closes, 9);
  const ema21Full = ema(closes, 21);
  const rsiFull = rsi(closes, 14);
  const [, , macdHist] = macd(closes);
  const volSma20 = sma(volumes, 20);

  const macdStart = (26 - 1) + (9 - 1); // = 33
  const ema21Start = 20;
  const rsiStart = 14;
  const volSmaStart = 19;

  // Effective start index in original candle array
  const start = Math.max(macdStart, ema21Start, rsiStart, volSmaStart) + 1;

  const trades: BacktestTrade[] = [];
  let inTrade = false;
  let entryPrice = 0.0;
  let entryDate = '';
  let stopLoss = 0.0;
  let target = 0.0;

  for (let i = start; i < closes.length; i++) {
    const ema9I = ema9Full[i - 8];
    const ema9Prev = ema9Full[i - 9];
    const ema21I = ema21Full[i - 20];
    const ema21Prev = ema21Full[i - 21];
    const rsiI = (i - rsiStart - 1) < rsiFull.length ? rsiFull[i - rsiStart - 1] : 50.0;
    const macdI = (i - macdStart - 1) < macdHist.length ? macdHist[i - macdStart - 1] : 0.0;
    const volAvg = (i - volSmaStart - 1) < volSma20.length ? volSma20[i - volSmaStart - 1] : volumes[i];

    const price = closes[i];
    const date = dates[i];

    const bullishCrossover = (ema9Prev <= ema21Prev) && (ema9I > ema21I);
    const bearishCrossover = (ema9Prev >= ema21Prev) && (ema9I < ema21I);
    const volSurge = volumes[i] > (volAvg * 1.5);

    if (!inTrade) {
      // ENTRY
      if (bullishCrossover && rsiI < 60 && macdI > 0 && volSurge) {
        inTrade = true;
        entryPrice = price;
        entryDate = date;
        stopLoss = entryPrice * 0.95; // -5%
        target = entryPrice * 1.08; // +8%
      }
    } else {
      // EXIT
      const hitSl = price <= stopLoss;
      const hitTarget = price >= target;
      const exitSignal = bearishCrossover || rsiI > 70;

      if (hitSl || hitTarget || exitSignal) {
        const exitPrice = hitSl ? stopLoss : (hitTarget ? target : price);
        const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
        trades.push({
          entry_date: entryDate,
          entry_price: entryPrice,
          exit_date: date,
          exit_price: exitPrice,
          pnl_pct: pnlPct,
          is_win: pnlPct > 0
        });
        inTrade = false;
      }
    }
  }

  // Close any open trade at last price
  if (inTrade && closes.length > 0) {
    const exitPrice = closes[closes.length - 1];
    const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
    trades.push({
      entry_date: entryDate,
      entry_price: entryPrice,
      exit_date: dates[dates.length - 1],
      exit_price: exitPrice,
      pnl_pct: pnlPct,
      is_win: pnlPct > 0
    });
  }

  return computeStats(trades, closes);
}

function currentSignal(candles: any[]): CurrentSignalResult {
  if (candles.length < 35) {
    return {
      signal: 'HOLD',
      entry_price: null,
      stop_loss: null,
      target_1: null,
      target_2: null,
      rsi: null,
      macd: null,
      ema9: null,
      ema21: null
    };
  }

  const closes = candles.map(c => Number(c.close));

  const ema9Vals = ema(closes, 9);
  const ema21Vals = ema(closes, 21);
  const rsiVals = rsi(closes, 14);
  const [, , macdHist] = macd(closes);

  const ema9Now = ema9Vals[ema9Vals.length - 1];
  const ema9Prev = ema9Vals[ema9Vals.length - 2] ?? null;
  const ema21Now = ema21Vals[ema21Vals.length - 1];
  const ema21Prev = ema21Vals[ema21Vals.length - 2] ?? null;
  const rsiNow = rsiVals[rsiVals.length - 1] ?? 50.0;
  const macdNow = macdHist[macdHist.length - 1] ?? 0.0;

  const currentPrice = closes[closes.length - 1];
  let signal: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  let entry: number | null = null;
  let sl: number | null = null;
  let t1: number | null = null;
  let t2: number | null = null;

  if (
    ema9Prev !== null && ema21Prev !== null &&
    ema9Prev <= ema21Prev && ema9Now > ema21Now &&
    rsiNow < 65 && macdNow > 0
  ) {
    signal = 'BUY';
    entry = currentPrice;
    sl = parseFloat((entry * 0.95).toFixed(2));
    t1 = parseFloat((entry * 1.05).toFixed(2));
    t2 = parseFloat((entry * 1.08).toFixed(2));
  } else if (
    ema9Prev !== null && ema21Prev !== null &&
    ema9Prev >= ema21Prev && ema9Now < ema21Now &&
    rsiNow > 55
  ) {
    signal = 'SELL';
    entry = currentPrice;
    sl = parseFloat((entry * 1.05).toFixed(2));
    t1 = parseFloat((entry * 0.95).toFixed(2));
    t2 = parseFloat((entry * 0.92).toFixed(2));
  }

  return {
    signal,
    entry_price: entry ?? parseFloat(currentPrice.toFixed(2)),
    stop_loss: sl,
    target_1: t1,
    target_2: t2,
    rsi: rsiNow ? parseFloat(rsiNow.toFixed(2)) : null,
    macd: macdNow ? parseFloat(macdNow.toFixed(4)) : null,
    ema9: ema9Now ? parseFloat(ema9Now.toFixed(2)) : null,
    ema21: ema21Now ? parseFloat(ema21Now.toFixed(2)) : null
  };
}

function buildRecommendation(symbol: string, stats: StatsResult, sig: CurrentSignalResult): string {
  const lines: string[] = [];
  if (stats.is_profitable) {
    lines.push(`✅ ${symbol} is PROFITABLE to trade.`);
  } else {
    lines.push(`❌ ${symbol} is NOT profitable to trade.`);
  }

  lines.push(`Backtest: ${stats.total_trades} trades | Win rate: ${stats.win_rate.toFixed(1)}% | Total return: ${stats.total_return_pct.toFixed(2)}%`);
  lines.push(`Avg profit: +${stats.avg_profit_pct.toFixed(2)}% | Avg loss: ${stats.avg_loss_pct.toFixed(2)}% | Sharpe: ${stats.sharpe_ratio.toFixed(2)}`);
  lines.push(`Max drawdown: -${stats.max_drawdown_pct.toFixed(2)}%`);

  const signal = sig.signal;
  if (signal === 'BUY') {
    lines.push(`📈 CURRENT SIGNAL: BUY at ₹${sig.entry_price?.toFixed(2)} | SL: ₹${sig.stop_loss?.toFixed(2)} | T1: ₹${sig.target_1?.toFixed(2)} | T2: ₹${sig.target_2?.toFixed(2)}`);
  } else if (signal === 'SELL') {
    lines.push(`📉 CURRENT SIGNAL: SELL/EXIT at ₹${sig.entry_price?.toFixed(2)}`);
  } else {
    lines.push('⏸ CURRENT SIGNAL: HOLD — wait for a clear setup.');
  }

  if (sig.rsi) {
    lines.push(`RSI: ${sig.rsi.toFixed(1)} | EMA9: ${sig.ema9 ?? '-'} | EMA21: ${sig.ema21 ?? '-'}`);
  }

  return lines.join(' | ');
}

export function analyseCompany(symbol: string, candles: any[]): AnalysisOutput {
  const stats = backtest(candles);
  const sig = currentSignal(candles);
  const recommendation = buildRecommendation(symbol, stats, sig);

  return {
    symbol,
    is_profitable: stats.is_profitable,
    total_trades: stats.total_trades,
    winning_trades: stats.winning_trades,
    losing_trades: stats.losing_trades,
    win_rate: stats.win_rate,
    avg_profit_pct: stats.avg_profit_pct,
    avg_loss_pct: stats.avg_loss_pct,
    total_return_pct: stats.total_return_pct,
    max_drawdown_pct: stats.max_drawdown_pct,
    sharpe_ratio: stats.sharpe_ratio,
    current_signal: sig.signal,
    entry_price: sig.entry_price,
    stop_loss: sig.stop_loss,
    target_1: sig.target_1,
    target_2: sig.target_2,
    rsi: sig.rsi,
    macd: sig.macd,
    ema9: sig.ema9,
    ema21: sig.ema21,
    recommendation
  };
}

async function analyseAndSaveCompany(company: any): Promise<any> {
  const symbol = company.symbol;

  // 1. Fetch candles from DB
  const rawCandles = await prisma.stockCandle.findMany({
    where: { symbol },
    orderBy: { date: 'asc' },
    take: 400
  });

  if (!rawCandles || rawCandles.length === 0) {
    console.warn(`No candles in DB for ${symbol}, skipping`);
    return null;
  }

  const candles = rawCandles.map(c => ({
    date: c.date,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: Number(c.volume)
  }));

  // 2. Perform backtest and indicators analysis
  const result = analyseCompany(symbol, candles);

  // 3. Persist to DB
  const existing = await prisma.stockAnalysis.findFirst({
    where: { symbol }
  });

  const dataFields = {
    is_profitable: result.is_profitable,
    total_trades: result.total_trades,
    winning_trades: result.winning_trades,
    losing_trades: result.losing_trades,
    win_rate: result.win_rate,
    avg_profit_pct: result.avg_profit_pct,
    avg_loss_pct: result.avg_loss_pct,
    total_return_pct: result.total_return_pct,
    max_drawdown_pct: result.max_drawdown_pct,
    sharpe_ratio: result.sharpe_ratio,
    current_signal: result.current_signal,
    entry_price: result.entry_price,
    stop_loss: result.stop_loss,
    target_1: result.target_1,
    target_2: result.target_2,
    rsi: result.rsi,
    macd: result.macd,
    ema9: result.ema9,
    ema21: result.ema21,
    recommendation: result.recommendation,
    analysed_at: new Date()
  };

  if (existing) {
    await prisma.stockAnalysis.update({
      where: { id: existing.id },
      data: dataFields
    });
  } else {
    await prisma.stockAnalysis.create({
      data: {
        symbol: result.symbol,
        ...dataFields,
        company: { connect: { id: company.id } }
      }
    });
  }

  console.log(`✓ Analysis saved: ${symbol} — profitable=${result.is_profitable}, signal=${result.current_signal}`);
  return { ...result, name: company.name, sector: company.sector };
}

export async function analyseAllCompanies(): Promise<any[]> {
  console.log('Running profitability analysis for all companies (parallel pool)...');
  const companies = await prisma.company.findMany({
    where: { is_active: true }
  });

  if (companies.length === 0) {
    console.warn('No active companies found — skipping analysis.');
    return [];
  }

  // Run all analyses concurrently with a limit of 10 workers
  const rawResults = await pLimit(10, companies, analyseAndSaveCompany);
  const results = rawResults.filter(r => r !== null);

  // Sorting:
  // 1. BUY/SELL signals (rank 0) first, HOLD signals (rank 1) next
  // 2. Ranked by Sharpe ratio descending
  results.sort((a, b) => {
    const aRank = (a.current_signal === 'BUY' || a.current_signal === 'SELL') ? 0 : 1;
    const bRank = (b.current_signal === 'BUY' || b.current_signal === 'SELL') ? 0 : 1;

    if (aRank !== bRank) {
      return aRank - bRank;
    }

    const aSharpe = a.sharpe_ratio || 0;
    const bSharpe = b.sharpe_ratio || 0;
    return bSharpe - aSharpe;
  });

  const highPriority = results.filter(r => r.current_signal === 'BUY' || r.current_signal === 'SELL');
  console.log(`Analysis complete: ${results.length}/${companies.length} companies processed | HIGH priority (BUY/SELL): ${highPriority.length}`);

  if (highPriority.length > 0) {
    console.log(`⚡ High-priority signals: ${highPriority.map(r => `${r.symbol}(${r.current_signal})`).join(', ')}`);
  }

  return results;
}
