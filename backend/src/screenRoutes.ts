import { Router, Request, Response } from 'express';
import { prisma } from './db.js';
import { getActiveMarketData } from './services/upstox.js';
import { generateSignal, SignalResult } from './services/signal.js';
import { getLatestSignal } from './services/scheduler.js';
import { mapSymbolToYFinance } from './services/finnhub.js';
import {
  getPortfolio,
  savePortfolio,
  getBots,
  saveBots,
  executeOrder,
  updateBotsPnLTick
} from './utils/persistence.js';
import { calculateTradePlan } from './services/indian_market.js';
import { fetchStockCandles } from './services/finnhub.js';
import { analyseCompany } from './services/profitability.js';

export const screenRouter = Router();

// Helper to get or generate latest signal
async function fetchLatestSignal(): Promise<SignalResult> {
  let signal = getLatestSignal();
  if (!signal) {
    try {
      const data = await getActiveMarketData();
      signal = generateSignal(data);
    } catch (err) {
      // Return a basic fallback if Upstox API or data feed fails
    }
  }
  if (!signal) {
    signal = {
      timestamp: new Date().toISOString(),
      bank_nifty: 51282.45,
      trend: 'Bullish',
      signal: 'BUY CE',
      confidence: 85,
      risk_level: 'Medium',
      stop_loss: 51100,
      targets: [51450, 51600],
      market_status: 'Open',
      vix: 15.4,
      pcr: 1.15
    };
  }
  return signal;
}

const MOCK_PRICES: Record<string, { price: number; chg: number }> = {
  HDFCBANK: { price: 1724.48, chg: 2.87 },
  ICICIBANK: { price: 1110.45, chg: 2.12 },
  SBIN: { price: 782.90, chg: -1.19 },
  AXISBANK: { price: 1050.05, chg: 1.10 },
  KOTAKBANK: { price: 1742.30, chg: 0.40 },
  BANKBARODA: { price: 241.60, chg: -1.31 },
  INDUSINDBK: { price: 1450.00, chg: 1.50 }
};

function getFallbackPrice(symbol: string): { price: number; chg: number } {
  const clean = symbol.toUpperCase().split('.')[0];
  return MOCK_PRICES[clean] || { price: 1000.0, chg: 0.0 };
}

// Fetch current stock prices from Yahoo Finance via the working /v8/finance/chart endpoint
async function fetchPrices(symbols: string[]): Promise<Record<string, { price: number; chg: number }>> {
  if (symbols.length === 0) return {};
  const results: Record<string, { price: number; chg: number }> = {};
  
  await Promise.all(
    symbols.map(async (sym) => {
      try {
        const yfSymbol = mapSymbolToYFinance(sym);
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yfSymbol}?interval=1m&range=1d`;
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) {
          results[sym] = getFallbackPrice(sym);
          return;
        }
        const data = (await res.json()) as any;
        const meta = data.chart?.result?.[0]?.meta;
        if (meta && meta.regularMarketPrice) {
          const currentPrice = meta.regularMarketPrice;
          const prevClose = meta.chartPreviousClose || currentPrice;
          const chg = prevClose !== 0 ? ((currentPrice - prevClose) / prevClose) * 100 : 0.0;
          results[sym] = {
            price: parseFloat(currentPrice.toFixed(2)),
            chg: parseFloat(chg.toFixed(2))
          };
        } else {
          results[sym] = getFallbackPrice(sym);
        }
      } catch (err) {
        results[sym] = getFallbackPrice(sym);
      }
    })
  );
  
  return results;
}

// ── 1. HOME SCREEN ───────────────────────────────────────────────────────────
screenRouter.get('/home', async (req: Request, res: Response) => {
  try {
    // 1. Get Nifty Bank Signal
    const signal = await fetchLatestSignal();

    // 2. Get Nifty Bank Mini Chart (15 hourly ticks)
    let mini_chart = [40, 55, 45, 70, 60, 85, 75, 95, 80, 65, 50, 80, 100];
    try {
      const dbCandles = await prisma.candle.findMany({
        orderBy: { timestamp: 'desc' },
        take: 15
      });
      if (dbCandles.length > 0) {
        mini_chart = dbCandles.map(c => c.close).reverse();
      }
    } catch (dbErr) {
      console.warn('Could not load candles from DB, using fallback chart data');
    }

    // 3. Get Portfolio Summary
    const portfolio = getPortfolio();
    const holdingSymbols = portfolio.holdings.map(h => h.symbol);
    const prices = await fetchPrices([...holdingSymbols, 'HDFCBANK', 'ICICIBANK', 'SBIN', 'AXISBANK', 'KOTAKBANK']);

    let totalCost = 0;
    let totalValue = 0;
    let bestPerf = { name: 'None', symbol: '', changePct: 0.0 };
    let worstPerf = { name: 'None', symbol: '', changePct: 0.0 };
    let maxChange = -Infinity;
    let minChange = Infinity;

    // Enrich portfolio holdings with current values
    const enrichedHoldings = portfolio.holdings.map((h) => {
      const live = prices[h.symbol] || { price: h.avgBuyPrice, chg: 0 };
      const curPrice = live.price;
      const curVal = curPrice * h.quantity;
      const cost = h.avgBuyPrice * h.quantity;
      const pnl = curVal - cost;
      const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;

      totalCost += cost;
      totalValue += curVal;

      if (live.chg > maxChange) {
        maxChange = live.chg;
        bestPerf = { name: h.name, symbol: h.symbol, changePct: live.chg };
      }
      if (live.chg < minChange) {
        minChange = live.chg;
        worstPerf = { name: h.name, symbol: h.symbol, changePct: live.chg };
      }

      return {
        ...h,
        price: curPrice,
        changePct: live.chg,
        change: parseFloat((curPrice * (live.chg / 100)).toFixed(2)),
        currentValue: parseFloat(curVal.toFixed(2)),
        pnl: parseFloat(pnl.toFixed(2)),
        pnlPct: parseFloat(pnlPct.toFixed(2))
      };
    });

    const totalPnl = totalValue - totalCost;
    const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
    const netWorth = portfolio.buyingPower + totalValue;

    // 4. Get Top Nifty Banks list (specifically the top 4)
    const bankSymbols = ['HDFCBANK', 'ICICIBANK', 'SBIN', 'AXISBANK'];
    const bankStocksList = bankSymbols.map((sym) => {
      const live = prices[sym] || { price: 0, chg: 0 };
      const namesMap: Record<string, string> = {
        HDFCBANK: 'HDFC Bank Ltd.',
        ICICIBANK: 'ICICI Bank Ltd.',
        SBIN: 'State Bank of India',
        AXISBANK: 'Axis Bank Ltd.'
      };
      const abbrsMap: Record<string, string> = {
        HDFCBANK: 'HB',
        ICICIBANK: 'IB',
        SBIN: 'SB',
        AXISBANK: 'AB'
      };
      const risksMap: Record<string, string> = {
        HDFCBANK: 'LOW',
        ICICIBANK: 'LOW',
        SBIN: 'MEDIUM',
        AXISBANK: 'MEDIUM'
      };
      return {
        id: sym.toLowerCase(),
        symbol: `${sym}.NSE`,
        name: namesMap[sym] || sym,
        abbr: abbrsMap[sym] || sym.substring(0, 2),
        price: live.price,
        change: parseFloat((live.price * (live.chg / 100)).toFixed(2)),
        changePct: live.chg,
        risk: risksMap[sym] || 'MEDIUM'
      };
    });

    // 5. Get Algo Signals / Alerts
    let alerts = [
      {
        id: 'signal-1',
        type: 'ALGO SIGNAL',
        message: 'Bullish momentum detected in Banking sectors. RBI policy outlook remains stable. Recommendation: Accumulate positions in private lenders.'
      },
      {
        id: 'signal-2',
        type: 'MARKET ALERT',
        message: 'Expected volatility during upcoming quarterly results for public sector banks. Set stop-losses at key support levels.'
      }
    ];

    try {
      const dbAlerts = await prisma.alert.findMany({
        orderBy: { timestamp: 'desc' },
        take: 3
      });
      if (dbAlerts.length > 0) {
        alerts = dbAlerts.map((a, idx) => ({
          id: `db-alert-${a.id}`,
          type: (a.alert_type || 'ALGO SIGNAL').toUpperCase(),
          message: a.message
        }));
      }
    } catch (alertErr) {
      console.warn('Could not load alerts from DB, using fallback alerts');
    }

    res.json({
      nifty_bank_index: {
        value: signal.bank_nifty || 51282.45,
        changePct: signal.trend === 'Bullish' ? 1.18 : -0.75, // mock or derived
        trend: signal.trend,
        signal: signal.signal
      },
      mini_chart,
      investment_summary: {
        totalPnl: parseFloat(totalPnl.toFixed(2)),
        totalPnlPct: parseFloat(totalPnlPct.toFixed(2)),
        bestPerformer: bestPerf,
        worstPerformer: worstPerf,
        netWorth: parseFloat(netWorth.toFixed(2)),
        netWorthChangePct: 4.28,
        buyingPower: portfolio.buyingPower,
        marginUsed: portfolio.marginUsed,
        diversification: portfolio.diversification,
        riskScore: portfolio.riskScore
      },
      bank_stocks: bankStocksList,
      algo_signals: alerts
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── 2. MARKETS SCREEN ────────────────────────────────────────────────────────
screenRouter.get('/markets', async (req: Request, res: Response) => {
  try {
    const signal = await fetchLatestSignal();
    
    // Get all active companies from database
    const companies = await prisma.company.findMany({
      where: { is_active: true }
    });

    const activeSymbols = companies.map(c => c.symbol);
    const defaultSymbols = ['HDFCBANK', 'ICICIBANK', 'SBIN', 'AXISBANK', 'KOTAKBANK', 'INDUSINDBK'];
    const finalSymbols = activeSymbols.length > 0 ? activeSymbols : defaultSymbols;
    
    // Fetch prices from Yahoo Finance
    const prices = await fetchPrices(finalSymbols);

    // Map to StockData structure
    const stocksList = finalSymbols.map((sym) => {
      const dbCompany = companies.find(c => c.symbol === sym);
      const live = prices[sym] || { price: 1000.0, chg: 0.0 };
      const risk = sym === 'HDFCBANK' || sym === 'ICICIBANK' ? 'LOW' : sym === 'SBIN' || sym === 'AXISBANK' ? 'MEDIUM' : 'HIGH';

      return {
        id: sym.toLowerCase(),
        symbol: `${sym}.NSE`,
        name: dbCompany?.name || `${sym} Ltd.`,
        abbr: sym.substring(0, 2),
        price: live.price,
        change: parseFloat((live.price * (live.chg / 100)).toFixed(2)),
        changePct: live.chg,
        risk: risk,
        sector: dbCompany?.sector || 'Banking'
      };
    });

    // Sort: top percentage gainers first
    stocksList.sort((a, b) => b.changePct - a.changePct);

    // Fetch mini chart
    let mini_chart = [40, 55, 45, 70, 60, 85, 75, 95, 80, 65, 50, 80, 100];
    try {
      const dbCandles = await prisma.candle.findMany({
        orderBy: { timestamp: 'desc' },
        take: 15
      });
      if (dbCandles.length > 0) {
        mini_chart = dbCandles.map(c => c.close).reverse();
      }
    } catch (err) {}

    // Fallback alerts
    let alerts = [
      {
        id: 'signal-1',
        type: 'ALGO SIGNAL',
        message: 'Bullish momentum detected in Banking sectors. RBI policy outlook remains stable. Recommendation: Accumulate positions in private lenders.'
      }
    ];

    res.json({
      nifty_bank_index: {
        value: signal.bank_nifty || 51282.45,
        changePct: 1.18,
        trend: signal.trend,
        signal: signal.signal
      },
      mini_chart,
      stocks: stocksList,
      algo_signals: alerts
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── 3. PORTFOLIO SCREEN ──────────────────────────────────────────────────────
screenRouter.get('/portfolio', async (req: Request, res: Response) => {
  try {
    const portfolio = getPortfolio();
    const holdingSymbols = portfolio.holdings.map(h => h.symbol);
    const prices = await fetchPrices(holdingSymbols);

    let totalCost = 0;
    let totalValue = 0;
    let bestPerf = { name: 'None', symbol: '', changePct: 0.0 };
    let worstPerf = { name: 'None', symbol: '', changePct: 0.0 };
    let maxChange = -Infinity;
    let minChange = Infinity;

    const enrichedHoldings = portfolio.holdings.map((h) => {
      const live = prices[h.symbol] || { price: h.avgBuyPrice, chg: 0.0 };
      const curPrice = live.price;
      const curVal = curPrice * h.quantity;
      const cost = h.avgBuyPrice * h.quantity;
      const pnl = curVal - cost;
      const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;

      totalCost += cost;
      totalValue += curVal;

      if (live.chg > maxChange) {
        maxChange = live.chg;
        bestPerf = { name: h.name, symbol: h.symbol, changePct: live.chg };
      }
      if (live.chg < minChange) {
        minChange = live.chg;
        worstPerf = { name: h.name, symbol: h.symbol, changePct: live.chg };
      }

      return {
        ...h,
        price: curPrice,
        changePct: live.chg,
        change: parseFloat((curPrice * (live.chg / 100)).toFixed(2)),
        currentValue: parseFloat(curVal.toFixed(2)),
        pnl: parseFloat(pnl.toFixed(2)),
        pnlPct: parseFloat(pnlPct.toFixed(2))
      };
    });

    const totalPnl = totalValue - totalCost;
    const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
    const netWorth = portfolio.buyingPower + totalValue;

    // Calculate sector mix percentages
    const sectorWeights: Record<string, number> = {};
    for (const h of enrichedHoldings) {
      const weight = totalValue > 0 ? (h.currentValue / totalValue) * 100 : 0;
      sectorWeights[h.sector] = (sectorWeights[h.sector] || 0) + weight;
    }
    const mix = Object.keys(sectorWeights).map(sector => ({
      name: sector,
      percentage: parseFloat(sectorWeights[sector].toFixed(1))
    }));



    // Enrich holdings with bar widths for UI chart displays (percent of portfolio)
    const finalHoldings = enrichedHoldings.map(h => ({
      ...h,
      barWidth: totalValue > 0 ? Math.round((h.currentValue / totalValue) * 100) : 0
    }));

    // Mock sentiment news
    const news = [
      {
        id: 'news-1',
        title: 'RBI Policy Preview',
        summary: 'Impact on banking margins expected to be neutral. Net Interest Income growth remains steady.'
      },
      {
        id: 'news-2',
        title: 'HDFC Bank Q3 Results',
        summary: 'Net profit rises 15% YoY, meeting analyst estimates. Strong credit demand supports performance.'
      }
    ];

    res.json({
      investment_summary: {
        totalPnl: parseFloat(totalPnl.toFixed(2)),
        totalPnlPct: parseFloat(totalPnlPct.toFixed(2)),
        bestPerformer: bestPerf,
        worstPerformer: worstPerf,
        netWorth: parseFloat(netWorth.toFixed(2)),
        netWorthChangePct: 4.28,
        buyingPower: portfolio.buyingPower,
        marginUsed: portfolio.marginUsed,
        diversification: portfolio.diversification,
        riskScore: portfolio.riskScore
      },
      holdings: finalHoldings,
      mix,
      risk_analysis: portfolio.holdings.length > 0 ? {
        rating: 'MODERATE',
        description: `Your portfolio has a high concentration (${mix.find(m => m.name === 'Private Bank')?.percentage || 75}%+) in Financials. Consider adding Nifty IT or Pharma to hedge against sector-specific banking volatility.`
      } : {
        rating: 'NONE',
        description: 'You do not have any active holdings. Start investing by selecting a stock from the Markets tab.'
      },
      news
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── 4. ANALYSIS SCREEN ───────────────────────────────────────────────────────
screenRouter.get('/analysis', async (req: Request, res: Response) => {
  try {
    const signal = await fetchLatestSignal();
    
    // Simulate/update bot tick
    updateBotsPnLTick();
    const bots = getBots();

    // Map bot symbols to live prices to show relevant details
    const botSymbols = bots.map(b => b.symbol);
    const prices = await fetchPrices(botSymbols);

    const enrichedBots = bots.map((b) => {
      const live = prices[b.symbol] || { price: 0 };
      return {
        ...b,
        symbol: `${b.symbol}.NSE`,
        price: live.price
      };
    });

    const activeBotsCount = enrichedBots.filter(b => b.status === 'RUNNING').length;

    res.json({
      nifty_bank_index: {
        value: signal.bank_nifty || 51282.45,
        changePct: 1.18
      },
      algo_status: {
        active_bots: activeBotsCount,
        total_bots: enrichedBots.length,
        health: '9 ACTIVE BOTS'
      },
      bots: enrichedBots
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Place buy/sell order from Analysis / Trade panels
screenRouter.post('/analysis/order', async (req: Request, res: Response) => {
  const { symbol, quantity, price, action } = req.body;
  
  if (!symbol || !quantity || !price || !action) {
    return res.status(400).json({ error: 'Missing required fields: symbol, quantity, price, action' });
  }

  const cleanAction = action.toUpperCase();
  if (cleanAction !== 'BUY' && cleanAction !== 'SELL') {
    return res.status(400).json({ error: 'Action must be BUY or SELL' });
  }

  const qty = parseInt(quantity, 10);
  const prc = parseFloat(price);

  if (isNaN(qty) || qty <= 0 || isNaN(prc) || prc <= 0) {
    return res.status(400).json({ error: 'Quantity and price must be positive numbers' });
  }

  try {
    const result = executeOrder(symbol, qty, prc, cleanAction);
    if (!result.success) {
      return res.status(422).json({ error: result.message });
    }
    res.json({ message: result.message, portfolio: result.portfolio });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle bot status (start/pause/stop)
screenRouter.post('/analysis/bot-toggle', async (req: Request, res: Response) => {
  const { name, status } = req.body;
  if (!name || !status) {
    return res.status(400).json({ error: 'Missing name or status' });
  }

  const allowed = ['RUNNING', 'PAUSED', 'IDLE'];
  if (!allowed.includes(status.toUpperCase())) {
    return res.status(400).json({ error: 'Invalid bot status' });
  }

  try {
    const bots = getBots();
    const botIndex = bots.findIndex(b => b.name === name);
    if (botIndex < 0) {
      return res.status(404).json({ error: `Bot ${name} not found` });
    }

    bots[botIndex].status = status.toUpperCase() as any;
    saveBots(bots);

    res.json({ message: `Bot ${name} is now ${status}`, bots });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── 5. STOCK DETAIL SCREEN ───────────────────────────────────────────────────
screenRouter.get('/stock/:id', async (req: Request, res: Response) => {
  const stockId = req.params.id.toUpperCase();
  const rawSymbol = stockId.split('.')[0];

  try {
    // 1. Get Live Price details from Yahoo Finance
    const prices = await fetchPrices([rawSymbol]);
    const live = prices[rawSymbol] || { price: 1000.0, chg: 0.0 };

    // 2. Load stock analysis from database
    let analysis = await prisma.stockAnalysis.findFirst({
      where: { symbol: rawSymbol },
      include: { company: true }
    }) as any;

    // If not in DB, try to run backtest/analysis on the fly or create mock profile
    if (!analysis) {
      try {
        // Find company profile
        const company = await prisma.company.findUnique({
          where: { symbol: rawSymbol }
        });
        if (company) {
          // fetch daily candles
          const end = new Date();
          const start = new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);
          const candles = await fetchStockCandles(rawSymbol, start, end, '1d');
          if (candles.length > 0) {
            const result = analyseCompany(rawSymbol, candles);
            // Save to database
            analysis = await prisma.stockAnalysis.create({
              data: {
                company_id: company.id,
                symbol: rawSymbol,
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
                entry_price: live.price,
                stop_loss: parseFloat((live.price * 0.95).toFixed(2)),
                target_1: parseFloat((live.price * 1.05).toFixed(2)),
                target_2: parseFloat((live.price * 1.08).toFixed(2)),
                rsi: result.rsi,
                macd: result.macd,
                ema9: result.ema9,
                ema21: result.ema21,
                recommendation: result.recommendation || 'ACUMULATE'
              },
              include: { company: true }
            });
          }
        }
      } catch (seedErr) {
        console.warn('Could not run on-the-fly analysis for stock:', rawSymbol, seedErr);
      }
    }

    // Fallback if still empty
    const companyName = analysis?.company?.name || `${rawSymbol} Ltd.`;
    const sectorName = analysis?.company?.sector || 'Private Bank';
    const currentSignal = analysis?.current_signal || (live.chg > 0 ? 'BUY' : 'HOLD');
    const winRate = analysis?.win_rate || 68.0;
    const totalReturn = analysis?.total_return_pct || 18.5;
    
    // Calculate Trade Plan using Indian Market logic
    const plan = calculateTradePlan(
      rawSymbol,
      50000, // sample investment amount
      live.price,
      analysis?.stop_loss || parseFloat((live.price * 0.95).toFixed(2)),
      analysis?.target_1 || parseFloat((live.price * 1.05).toFixed(2)),
      analysis?.target_2 || parseFloat((live.price * 1.08).toFixed(2)),
      winRate,
      analysis?.sharpe_ratio || 1.1,
      winRate,
      analysis?.max_drawdown_pct || 12.0,
      analysis?.rsi || 55.0,
      analysis?.ema9 || live.price * 0.99,
      analysis?.ema21 || live.price * 0.97
    );

    // Get current holding details from portfolio
    const portfolio = getPortfolio();
    const holding = portfolio.holdings.find(h => h.symbol.toUpperCase() === rawSymbol);
    const holdingDetails = holding ? {
      shares: holding.quantity,
      avg_buy_price: holding.avgBuyPrice,
      current_value: parseFloat((holding.quantity * live.price).toFixed(2)),
      pnl: parseFloat(((live.price - holding.avgBuyPrice) * holding.quantity).toFixed(2)),
      pnl_pct: parseFloat((((live.price - holding.avgBuyPrice) / holding.avgBuyPrice) * 100).toFixed(2)),
      cash_available: portfolio.buyingPower
    } : {
      shares: 0,
      cash_available: portfolio.buyingPower
    };

    // Dynamic Live Trade book entries around the current price
    const liveTrades = Array.from({ length: 6 }).map((_, idx) => {
      const isBuy = Math.random() > 0.4;
      const offset = (Math.random() - 0.5) * (live.price * 0.002);
      const seconds = Math.floor(Math.random() * 59).toString().padStart(2, '0');
      const minutes = Math.floor(Math.random() * 59).toString().padStart(2, '0');
      return {
        price: parseFloat((live.price + offset).toFixed(2)),
        volume: Math.floor(Math.random() * 400) + 10,
        time: `14:${minutes}:${seconds}`,
        isBuy
      };
    });

    const timeframe = (req.query.timeframe as string || '1D').toUpperCase();
    let recentCandles = [];
    try {
      let interval = '1d';
      let daysBack = 45;

      if (timeframe === '1H') {
        interval = '1h';
        daysBack = 7;
      } else if (timeframe === '1D') {
        interval = '1d';
        daysBack = 30;
      } else if (timeframe === '1W') {
        interval = '1d';
        daysBack = 90;
      } else if (timeframe === '1M') {
        interval = '1wk';
        daysBack = 180;
      } else if (timeframe === 'ALL') {
        interval = '1mo';
        daysBack = 365;
      }

      const end = new Date();
      const start = new Date(end.getTime() - daysBack * 24 * 60 * 60 * 1000);
      const candles = await fetchStockCandles(rawSymbol, start, end, interval);
      recentCandles = candles.slice(-25);
    } catch (err) {
      console.warn(`[StockDetailRoute] Error fetching candles for ${rawSymbol} (${timeframe}):`, err);
    }

    if (recentCandles.length === 0) {
      let currentVal = live.price * 0.95;
      for (let i = 0; i < 25; i++) {
        const change = (Math.random() - 0.45) * (live.price * 0.015);
        const open = currentVal;
        const close = currentVal + change;
        const high = Math.max(open, close) + (Math.random() * (live.price * 0.005));
        const low = Math.min(open, close) - (Math.random() * (live.price * 0.005));
        recentCandles.push({
          date: new Date(Date.now() - (25 - i) * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          open: parseFloat(open.toFixed(2)),
          high: parseFloat(high.toFixed(2)),
          low: parseFloat(low.toFixed(2)),
          close: parseFloat(close.toFixed(2)),
          volume: Math.floor(Math.random() * 50000) + 10000
        });
        currentVal = close;
      }
    }

    res.json({
      candles: recentCandles,
      profile: {
        id: rawSymbol.toLowerCase(),
        symbol: `${rawSymbol}.NSE`,
        name: companyName,
        price: live.price,
        change: parseFloat((live.price * (live.chg / 100)).toFixed(2)),
        changePct: live.chg,
        risk: winRate > 65 ? 'LOW' : winRate > 55 ? 'MEDIUM' : 'HIGH',
        volume: 8500000,
        high52w: parseFloat((live.price * 1.15).toFixed(2)),
        low52w: parseFloat((live.price * 0.82).toFixed(2)),
        pe: 17.5,
        marketCap: '₹7.5L Cr',
        sector: sectorName
      },
      technical_analysis: {
        rsi: parseFloat((analysis?.rsi || 52.5).toFixed(1)),
        macd: parseFloat((analysis?.macd || 1.25).toFixed(2)),
        ema9: parseFloat((analysis?.ema9 || live.price * 0.99).toFixed(2)),
        ema21: parseFloat((analysis?.ema21 || live.price * 0.98).toFixed(2)),
        signal: currentSignal,
        recommendation: analysis?.recommendation || 'ACUMULATE positions at dips.'
      },
      trade_plan: plan,
      holding: holdingDetails,
      live_trades: liveTrades,
      metrics: {
        win_rate: winRate,
        total_return_pct: totalReturn
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
