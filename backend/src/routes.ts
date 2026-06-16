import { Router, Request, Response } from 'express';
import { settings } from './config.js';
import { prisma } from './db.js';
import { getCurrentMarketData } from './utils/mock_data.js';
import { getActiveMarketData } from './services/upstox.js';
import { generateSignal, isMarketOpen } from './services/signal.js';
import { generateCarryForward } from './services/carry_forward.js';
import { broadcaster, persistSignal } from './services/alerts.js';
import { fetchStockCandles, mapSymbolToYFinance } from './services/finnhub.js';
import { runFullSeed, seedCandlesForAll, seedCandlesForSymbol } from './services/seeder.js';
import { analyseAllCompanies, analyseCompany } from './services/profitability.js';
import { getLatestSignal, getLatestCarry } from './services/scheduler.js';
import {
  computeInvestScore,
  getRiskGrade,
  getHoldingType,
  calculateTradePlan,
  getFoExpiryContext
} from './services/indian_market.js';

export const router = Router();

// Helper to convert internal SignalResult to DashboardResponse shape
function signalResultToDashboard(result: any): any {
  return {
    bank_nifty: result.bank_nifty,
    trend: result.trend,
    signal: result.signal,
    confidence: result.confidence,
    risk_level: result.risk_level,
    stop_loss: result.stop_loss,
    targets: result.targets,
    market_status: result.market_status,
    last_updated: result.timestamp,
    vix: result.vix,
    pcr: result.pcr,
    confidence_breakdown: result.confidence_breakdown || null,
    ai_prediction: result.ai_prediction || null,
    trend_detail: result.trend_detail || null
  };
}

async function getOrGenerateSignal() {
  let signal = getLatestSignal();
  if (!signal) {
    const data = await getActiveMarketData();
    signal = generateSignal(data);
  }
  return signal;
}

async function fetchCompanyInfo(symbol: string): Promise<{ name: string; sector: string; industry: string }> {
  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${symbol}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.ok) {
      const data = await res.json() as any;
      const quote = data.quotes?.[0];
      if (quote) {
        return {
          name: quote.longname || quote.shortname || symbol,
          sector: quote.sector || 'Technology',
          industry: quote.industry || 'Technology'
        };
      }
    }
  } catch (err) {
    console.warn('Failed to fetch company info via Yahoo search, using defaults');
  }
  return {
    name: symbol,
    sector: 'Technology',
    industry: 'Technology'
  };
}

// ── 1. System Health ─────────────────────────────────────────────────────────

router.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    version: settings.appVersion,
    model_loaded: false,
    websocket_connections: broadcaster.connectionCount,
    scheduler_running: true
  });
});

// ── 2. Signal / Dashboard ───────────────────────────────────────────────────

router.get('/signal', async (req: Request, res: Response) => {
  try {
    const signal = await getOrGenerateSignal();
    res.json(signalResultToDashboard(signal));
  } catch (err: any) {
    res.status(503).json({ detail: `Market data feed unavailable: ${err.message}` });
  }
});

router.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const signal = await getOrGenerateSignal();
    res.json(signalResultToDashboard(signal));
  } catch (err: any) {
    res.status(503).json({ detail: `Market data feed unavailable: ${err.message}` });
  }
});

// ── 3. Signal History ───────────────────────────────────────────────────────

router.get('/history', async (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string || '20', 10);
  const offset = parseInt(req.query.offset as string || '0', 10);

  try {
    const total = await prisma.signal.count();
    const items = await prisma.signal.findMany({
      orderBy: { timestamp: 'desc' },
      take: limit,
      skip: offset
    });

    res.json({
      items,
      total,
      limit,
      offset
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── 4. Carry Forward ────────────────────────────────────────────────────────

router.get('/carry-forward', async (req: Request, res: Response) => {
  try {
    let carry = getLatestCarry();
    if (!carry) {
      const data = await getActiveMarketData(true);
      carry = generateCarryForward(data);
    }
    res.json(carry);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── 5. Watchlist Quotes ─────────────────────────────────────────────────────

router.get('/watchlist-quotes', async (req: Request, res: Response) => {
  const symbolsQuery = req.query.symbols as string;
  let symbolList: string[] = [];

  try {
    if (symbolsQuery) {
      symbolList = symbolsQuery.split(',').map(s => s.toUpperCase().trim());
    } else {
      const companies = await prisma.company.findMany({
        where: { is_active: true }
      });
      symbolList = companies.map(c => c.symbol);
    }

    if (symbolList.length === 0) {
      return res.json({});
    }

    // Call Yahoo Finance to fetch latest prices
    const yfSymbols = symbolList.map(mapSymbolToYFinance);
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${yfSymbols.join(',')}`;
    
    const fetchRes = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!fetchRes.ok) {
      throw new Error(`Yahoo quotes fetch failed: HTTP ${fetchRes.status}`);
    }

    const data = (await fetchRes.json()) as any;
    const quotes = data.quoteResponse?.result || [];
    
    const quotesMap = new Map<string, any>();
    for (const q of quotes) {
      quotesMap.set(q.symbol, q);
    }

    const result: Record<string, any> = {};
    for (const sym of symbolList) {
      const yfSym = mapSymbolToYFinance(sym);
      const q = quotesMap.get(yfSym);
      if (q) {
        const pctChg = q.regularMarketChangePercent || 0.0;
        let signal = 'no-trade';
        if (pctChg > 1.5) {
          signal = 'buy-ce';
        } else if (pctChg < -1.0) {
          signal = 'buy-pe';
        }

        result[sym] = {
          price: parseFloat((q.regularMarketPrice || 0.0).toFixed(2)),
          chg: parseFloat(pctChg.toFixed(2)),
          signal: signal
        };
      } else {
        result[sym] = {
          price: null,
          chg: null,
          signal: 'no-trade'
        };
      }
    }

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── 6. Search Symbols ───────────────────────────────────────────────────────

router.get('/search-symbols', async (req: Request, res: Response) => {
  const query = req.query.q as string || '';
  if (!query) {
    return res.json([]);
  }

  try {
    const results = await prisma.company.findMany({
      where: {
        OR: [
          { symbol: { contains: query } },
          { name: { contains: query } }
        ]
      },
      take: 10
    });
    res.json(results);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── 7. Data Ingestion ───────────────────────────────────────────────────────

router.post('/market-data', async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    
    const candles_5m = (payload.candles_5m || []).map((c: any) => ({
      timestamp: c.timestamp,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume)
    }));

    const candles_15m = (payload.candles_15m || []).map((c: any) => ({
      timestamp: c.timestamp,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume)
    }));

    let optionChain = null;
    if (payload.strikes && payload.strikes.length > 0) {
      let totalCallOi = 0;
      let totalPutOi = 0;
      let atmCallOi = 0;
      let atmPutOi = 0;
      let atmCallIv = 0;
      let atmPutIv = 0;

      let closestStrikeDiff = Infinity;
      let atmStrike = 0;

      for (const s of payload.strikes) {
        const strikeVal = parseFloat(s.strike);
        const diff = Math.abs(strikeVal - payload.spot_price);
        if (diff < closestStrikeDiff) {
          closestStrikeDiff = diff;
          atmStrike = strikeVal;
        }
      }

      for (const s of payload.strikes) {
        const strikeVal = parseFloat(s.strike);
        const callOi = parseFloat(s.call_oi || 0.0);
        const putOi = parseFloat(s.put_oi || 0.0);
        
        totalCallOi += callOi;
        totalPutOi += putOi;

        if (strikeVal === atmStrike) {
          atmCallOi = callOi;
          atmPutOi = putOi;
          atmCallIv = parseFloat(s.call_iv || 0.0);
          atmPutIv = parseFloat(s.put_iv || 0.0);
        }
      }

      optionChain = {
        pcr: totalPutOi / (totalCallOi || 1),
        total_call_oi: totalCallOi,
        total_put_oi: totalPutOi,
        atm_call_oi: atmCallOi,
        atm_put_oi: atmPutOi,
        atm_call_iv: atmCallIv,
        atm_put_iv: atmPutIv
      };
    }

    const now = new Date();
    const is_open = isMarketOpen();

    const bundle = {
      spot_price: payload.spot_price,
      candles_5m: candles_5m,
      candles_15m: candles_15m,
      option_chain: optionChain,
      vix: payload.vix,
      is_market_open: is_open
    };

    const result = generateSignal(bundle);
    await persistSignal(result);

    res.json(signalResultToDashboard(result));
  } catch (err: any) {
    res.status(400).json({ detail: err.message });
  }
});

router.post('/train', (req: Request, res: Response) => {
  res.json({
    status: 'disabled',
    accuracy: 0.0,
    n_train: 0,
    n_test: 0,
    feature_importance: {
      info: 'AI retraining is disabled because the app is running in rules-only algorithm mode.'
    }
  });
});

// ── 8. Stock History ────────────────────────────────────────────────────────

router.get('/stock-history', async (req: Request, res: Response) => {
  const symbol = req.query.symbol as string;
  const period = req.query.period as string || '1y'; // e.g. 1y, 1mo
  const interval = req.query.interval as string || '1d';

  if (!symbol) {
    return res.status(400).json({ detail: 'Missing symbol query parameter' });
  }

  try {
    const end = new Date();
    let durationMs = 365 * 24 * 60 * 60 * 1000;
    if (period === '1mo') {
      durationMs = 30 * 24 * 60 * 60 * 1000;
    } else if (period === '5d') {
      durationMs = 5 * 24 * 60 * 60 * 1000;
    }
    const start = new Date(end.getTime() - durationMs);
    
    const candles = await fetchStockCandles(symbol, start, end, interval);
    res.json(candles);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── 9. Analyze Stock ────────────────────────────────────────────────────────

router.get('/analyze-stock', async (req: Request, res: Response) => {
  const symbol = req.query.symbol as string;
  if (!symbol) {
    return res.status(400).json({ detail: 'Missing symbol query parameter' });
  }

  try {
    const end = new Date();
    const start = new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);
    const candles = await fetchStockCandles(symbol, start, end, '1d');
    
    if (candles.length === 0) {
      return res.status(400).json({ detail: `No price data found for symbol ${symbol}` });
    }

    const analysis = analyseCompany(symbol, candles);
    res.json(analysis);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── 10. Seeding and Refreshes ────────────────────────────────────────────────

router.post('/stocks/seed', async (req: Request, res: Response) => {
  try {
    const result = await runFullSeed();
    res.json({
      companies_seeded: result.companies_seeded,
      message: `Seeded ${result.companies_seeded} Nifty 50 companies and ${result.total_candles} total candles from Yahoo Finance.`
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/stocks/refresh', async (req: Request, res: Response) => {
  try {
    const seedResults = await seedCandlesForAll(7);
    const analyses = await analyseAllCompanies();
    const profitable = analyses.filter(r => r.is_profitable).length;

    res.json({
      companies_analysed: analyses.length,
      profitable_count: profitable,
      message: `Refreshed stock candles and ran analysis. Total processed: ${analyses.length}, Profitable: ${profitable}.`
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── 11. Company Universe & Analysis Lists ────────────────────────────────────

router.get('/stocks/companies', async (req: Request, res: Response) => {
  try {
    const companies = await prisma.company.findMany({
      orderBy: { symbol: 'asc' }
    });
    res.json(companies);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stocks/analysis', async (req: Request, res: Response) => {
  try {
    const analyses = await prisma.stockAnalysis.findMany({
      include: { company: true },
      orderBy: { symbol: 'asc' }
    });
    
    const formatted = analyses.map((a: any) => ({
      ...a,
      name: a.company?.name || null,
      sector: a.company?.sector || null
    }));

    const profitableCount = formatted.filter(a => a.is_profitable).length;

    res.json({
      total: formatted.length,
      profitable_count: profitableCount,
      analyses: formatted
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stocks/analysis/:symbol', async (req: Request, res: Response) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const a = await prisma.stockAnalysis.findFirst({
      where: { symbol },
      include: { company: true }
    }) as any;

    if (!a) {
      return res.status(404).json({ detail: `No analysis found for symbol ${symbol}` });
    }

    res.json({
      ...a,
      name: a.company?.name || null,
      sector: a.company?.sector || null
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stocks/profitable', async (req: Request, res: Response) => {
  try {
    const analyses = await prisma.stockAnalysis.findMany({
      where: { is_profitable: true },
      include: { company: true },
      orderBy: { symbol: 'asc' }
    });

    const formatted = analyses.map((a: any) => ({
      ...a,
      name: a.company?.name || null,
      sector: a.company?.sector || null
    }));

    res.json({
      total: formatted.length,
      profitable_count: formatted.length,
      analyses: formatted
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stocks/best-trades', async (req: Request, res: Response) => {
  try {
    const analyses = await prisma.stockAnalysis.findMany({
      include: { company: true },
      orderBy: { total_return_pct: 'desc' }
    });

    const formatted = analyses.map((a: any) => ({
      ...a,
      name: a.company?.name || null,
      sector: a.company?.sector || null
    }));

    res.json({
      total: formatted.length,
      profitable_count: formatted.filter(a => a.is_profitable).length,
      analyses: formatted
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/stocks/analyse-now', async (req: Request, res: Response) => {
  try {
    const results = await analyseAllCompanies();
    const profitable = results.filter(r => r.is_profitable).length;
    res.json({
      total: results.length,
      profitable_count: profitable,
      analyses: results
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/stocks/test-finnhub', (req: Request, res: Response) => {
  res.json({
    status: 'success',
    message: 'Finnhub API test bypassed: utilizing direct, keyless Yahoo Finance integration.'
  });
});

// ── 12. Add & Remove Custom Symbols ──────────────────────────────────────────

router.post('/stocks/add', async (req: Request, res: Response) => {
  const symbolQuery = req.query.symbol as string;
  if (!symbolQuery) {
    return res.status(400).json({ detail: 'Invalid symbol' });
  }

  const sym = symbolQuery.toUpperCase().trim();

  try {
    let company = await prisma.company.findUnique({ where: { symbol: sym } });
    if (company) {
      if (!company.is_active) {
        company = await prisma.company.update({
          where: { symbol: sym },
          data: { is_active: true }
        });
      }
    } else {
      const profile = await fetchCompanyInfo(sym);
      company = await prisma.company.create({
        data: {
          symbol: sym,
          name: profile.name,
          sector: profile.sector,
          industry: profile.industry,
          is_active: true,
          exchange: 'NSE',
          country: 'IN',
          currency: 'INR'
        }
      });
    }

    // Seed 1 year of daily candles
    await seedCandlesForSymbol(sym, company.id, 365);

    // Run analysis
    const rawCandles = await prisma.stockCandle.findMany({
      where: { symbol: sym },
      orderBy: { date: 'asc' },
      take: 400
    });

    if (!rawCandles || rawCandles.length === 0) {
      return res.status(400).json({
        detail: `Failed to fetch historical candle data for ${sym}. Please check if the symbol is valid.`
      });
    }

    const candles = rawCandles.map(c => ({
      date: c.date,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: Number(c.volume)
    }));

    const result = analyseCompany(sym, candles);

    const existingAnalysis = await prisma.stockAnalysis.findFirst({
      where: { symbol: sym }
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

    if (existingAnalysis) {
      await prisma.stockAnalysis.update({
        where: { id: existingAnalysis.id },
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

    res.json({ message: `Successfully added and analysed ${sym}`, symbol: sym });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/stocks/remove', async (req: Request, res: Response) => {
  const symbolQuery = req.query.symbol as string;
  if (!symbolQuery) {
    return res.status(400).json({ detail: 'Invalid symbol' });
  }

  const sym = symbolQuery.toUpperCase().trim();

  try {
    const company = await prisma.company.findUnique({ where: { symbol: sym } });
    if (!company) {
      return res.status(404).json({ detail: `Company ${sym} not found` });
    }

    await prisma.company.update({
      where: { symbol: sym },
      data: { is_active: false }
    });

    res.json({ message: `Successfully removed ${sym} from universe`, symbol: sym });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── 13. Smart Screener ───────────────────────────────────────────────────────

router.get('/stocks/screener', async (req: Request, res: Response) => {
  try {
    const analyses = await prisma.stockAnalysis.findMany({
      include: { company: true }
    });

    // Filter: BUY signal + is_profitable
    const candidates = analyses.filter(
      (a: any) => a.current_signal === 'BUY' && a.is_profitable
    );

    const stocks = candidates.map((a: any) => {
      const sharpe = a.sharpe_ratio;
      const wr = a.win_rate || 0.0;
      const dd = a.max_drawdown_pct || 0.0;

      const score = computeInvestScore(
        a.rsi,
        a.ema9,
        a.ema21,
        a.entry_price,
        sharpe,
        wr,
        dd
      );

      const grade = getRiskGrade(score, dd, sharpe);
      const holding = getHoldingType(sharpe, wr, score);

      return {
        symbol: a.symbol,
        name: a.company?.name || null,
        sector: a.company?.sector || null,
        current_signal: a.current_signal,
        entry_price: a.entry_price,
        stop_loss: a.stop_loss,
        target_1: a.target_1,
        target_2: a.target_2,
        win_rate: wr,
        total_return_pct: a.total_return_pct || 0.0,
        sharpe_ratio: sharpe,
        max_drawdown_pct: dd,
        rsi: a.rsi,
        ema9: a.ema9,
        ema21: a.ema21,
        invest_score: score,
        risk_grade: grade,
        holding_type: holding,
        recommendation: a.recommendation || ''
      };
    });

    // Sort by invest score descending
    stocks.sort((a, b) => b.invest_score - a.invest_score);

    res.json({
      total_screened: analyses.length,
      buy_signals: stocks.length,
      as_of: new Date().toISOString(),
      stocks: stocks
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── 14. Trade Plan Calculator ────────────────────────────────────────────────

router.post('/stocks/trade-plan', async (req: Request, res: Response) => {
  const symbol = req.query.symbol as string;
  const amountInrStr = req.query.amount_inr as string;

  if (!symbol) {
    return res.status(400).json({ detail: 'Missing symbol query parameter' });
  }

  const amountInr = parseFloat(amountInrStr);
  if (isNaN(amountInr) || amountInr < 100) {
    return res.status(400).json({ detail: 'Investment amount must be a number of at least ₹100' });
  }

  const sym = symbol.toUpperCase().trim();

  try {
    const analysis = await prisma.stockAnalysis.findFirst({
      where: { symbol: sym },
      include: { company: true }
    });

    if (!analysis) {
      return res.status(404).json({
        detail: `No analysis found for ${sym}. Run POST /stocks/seed or POST /stocks/add first.`
      });
    }

    const entry = analysis.entry_price;
    if (!entry || entry <= 0) {
      return res.status(422).json({
        detail: `${sym} has no valid entry price yet. Run POST /stocks/analyse-now to refresh.`
      });
    }

    const sharpe = analysis.sharpe_ratio;
    const wr = analysis.win_rate || 0.0;
    const dd = analysis.max_drawdown_pct || 0.0;

    const investScore = computeInvestScore(
      analysis.rsi,
      analysis.ema9,
      analysis.ema21,
      entry,
      sharpe,
      wr,
      dd
    );

    const plan = calculateTradePlan(
      sym,
      amountInr,
      entry,
      analysis.stop_loss,
      analysis.target_1,
      analysis.target_2,
      investScore,
      sharpe,
      wr,
      dd,
      analysis.rsi,
      analysis.ema9,
      analysis.ema21
    );

    res.json(plan);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Re-map POST route to matching query route for backwards compatibility with some clients
router.get('/stocks/trade-plan', async (req: Request, res: Response) => {
  // Transfer request parameters to the POST controller
  const symbol = req.query.symbol as string;
  const amountInrStr = req.query.amount_inr as string;

  if (!symbol) {
    return res.status(400).json({ detail: 'Missing symbol query parameter' });
  }

  const amountInr = parseFloat(amountInrStr);
  if (isNaN(amountInr) || amountInr < 100) {
    return res.status(400).json({ detail: 'Investment amount must be a number of at least ₹100' });
  }

  const sym = symbol.toUpperCase().trim();

  try {
    const analysis = await prisma.stockAnalysis.findFirst({
      where: { symbol: sym },
      include: { company: true }
    });

    if (!analysis) {
      return res.status(404).json({
        detail: `No analysis found for ${sym}. Run POST /stocks/seed or POST /stocks/add first.`
      });
    }

    const entry = analysis.entry_price;
    if (!entry || entry <= 0) {
      return res.status(422).json({
        detail: `${sym} has no valid entry price yet. Run POST /stocks/analyse-now to refresh.`
      });
    }

    const sharpe = analysis.sharpe_ratio;
    const wr = analysis.win_rate || 0.0;
    const dd = analysis.max_drawdown_pct || 0.0;

    const investScore = computeInvestScore(
      analysis.rsi,
      analysis.ema9,
      analysis.ema21,
      entry,
      sharpe,
      wr,
      dd
    );

    const plan = calculateTradePlan(
      sym,
      amountInr,
      entry,
      analysis.stop_loss,
      analysis.target_1,
      analysis.target_2,
      investScore,
      sharpe,
      wr,
      dd,
      analysis.rsi,
      analysis.ema9,
      analysis.ema21
    );

    res.json(plan);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
