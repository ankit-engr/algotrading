import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths to data files (storing under backend/data)
const DATA_DIR = path.resolve(__dirname, '../../data');
const PORTFOLIO_PATH = path.join(DATA_DIR, 'portfolio.json');
const BOTS_PATH = path.join(DATA_DIR, 'bots.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initial Mock Data
const INITIAL_PORTFOLIO = {
  buyingPower: 1245000.0,
  marginUsed: 420000.0,
  diversification: 82,
  riskScore: 'Moderate',
  holdings: [
    {
      id: 'hdfcbank',
      symbol: 'HDFCBANK',
      name: 'HDFC Bank Ltd.',
      abbr: 'HB',
      quantity: 120,
      avgBuyPrice: 1580.00,
      risk: 'LOW',
      sector: 'Private Bank'
    },
    {
      id: 'icicibank',
      symbol: 'ICICIBANK',
      name: 'ICICI Bank Ltd.',
      abbr: 'IB',
      quantity: 200,
      avgBuyPrice: 998.00,
      risk: 'LOW',
      sector: 'Private Bank'
    },
    {
      id: 'sbin',
      symbol: 'SBIN',
      name: 'State Bank of India',
      abbr: 'SB',
      quantity: 300,
      avgBuyPrice: 795.00,
      risk: 'MEDIUM',
      sector: 'PSU Bank'
    },
    {
      id: 'axisbank',
      symbol: 'AXISBANK',
      name: 'Axis Bank Ltd.',
      abbr: 'AB',
      quantity: 150,
      avgBuyPrice: 1035.00,
      risk: 'MEDIUM',
      sector: 'Private Bank'
    },
    {
      id: 'kotakbank',
      symbol: 'KOTAKBANK',
      name: 'Kotak Mahindra Bank',
      abbr: 'KM',
      quantity: 80,
      avgBuyPrice: 1810.00,
      risk: 'MEDIUM',
      sector: 'Private Bank'
    }
  ]
};

const INITIAL_BOTS: Bot[] = [
  { name: 'Grid Scalper v2.1', symbol: 'HDFCBANK', type: 'GRID', status: 'RUNNING', pnl: 4520.80 },
  { name: 'EMA Crossover', symbol: 'SBIN', type: 'MOMENTUM', status: 'RUNNING', pnl: -1240.20 },
  { name: 'Volume Breakout', symbol: 'ICICIBANK', type: 'BREAKOUT', status: 'PAUSED', pnl: 8900.00 },
  { name: 'Mean Reversion', symbol: 'AXISBANK', type: 'REVERSION', status: 'IDLE', pnl: 0 }
];

export interface Holding {
  id: string;
  symbol: string;
  name: string;
  abbr: string;
  quantity: number;
  avgBuyPrice: number;
  risk: string;
  sector: string;
}

export interface Portfolio {
  buyingPower: number;
  marginUsed: number;
  diversification: number;
  riskScore: string;
  holdings: Holding[];
}

export interface Bot {
  name: string;
  symbol: string;
  type: string;
  status: 'RUNNING' | 'PAUSED' | 'IDLE';
  pnl: number;
}

// Check and initialize files if they don't exist
function initDB() {
  if (!fs.existsSync(PORTFOLIO_PATH)) {
    fs.writeFileSync(PORTFOLIO_PATH, JSON.stringify(INITIAL_PORTFOLIO, null, 2), 'utf-8');
  }
  if (!fs.existsSync(BOTS_PATH)) {
    fs.writeFileSync(BOTS_PATH, JSON.stringify(INITIAL_BOTS, null, 2), 'utf-8');
  }
}

// Initialize
initDB();

export function getPortfolio(): Portfolio {
  initDB();
  try {
    const data = fs.readFileSync(PORTFOLIO_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Failed to read portfolio file, using fallback:', err);
    return INITIAL_PORTFOLIO;
  }
}

export function savePortfolio(portfolio: Portfolio): boolean {
  try {
    fs.writeFileSync(PORTFOLIO_PATH, JSON.stringify(portfolio, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Failed to write portfolio file:', err);
    return false;
  }
}

export function getBots(): Bot[] {
  initDB();
  try {
    const data = fs.readFileSync(BOTS_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Failed to read bots file, using fallback:', err);
    return INITIAL_BOTS;
  }
}

export function saveBots(bots: Bot[]): boolean {
  try {
    fs.writeFileSync(BOTS_PATH, JSON.stringify(bots, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Failed to write bots file:', err);
    return false;
  }
}

// Simulates real-time tick changes for running bots
export function updateBotsPnLTick() {
  const bots = getBots();
  let changed = false;
  const updated = bots.map((bot) => {
    if (bot.status !== 'RUNNING') return bot;
    changed = true;
    const drift = (Math.random() - 0.5) * 15;
    return {
      ...bot,
      pnl: parseFloat((bot.pnl + drift).toFixed(2))
    };
  });
  if (changed) {
    saveBots(updated);
  }
}

// Execute BUY / SELL order
export function executeOrder(
  symbol: string,
  quantity: number,
  price: number,
  action: 'BUY' | 'SELL'
): { success: boolean; message: string; portfolio: Portfolio } {
  const portfolio = getPortfolio();
  const rawSymbol = symbol.split('.')[0].toUpperCase();
  const totalCost = quantity * price;

  if (action === 'BUY') {
    if (portfolio.buyingPower < totalCost) {
      return {
        success: false,
        message: `Insufficient buying power. Required: ₹${totalCost.toLocaleString('en-IN')}, Available: ₹${portfolio.buyingPower.toLocaleString('en-IN')}`,
        portfolio
      };
    }

    portfolio.buyingPower -= totalCost;
    
    // Find if holding already exists
    const holdingIndex = portfolio.holdings.findIndex(h => h.symbol.toUpperCase() === rawSymbol);
    if (holdingIndex >= 0) {
      const holding = portfolio.holdings[holdingIndex];
      const newQty = holding.quantity + quantity;
      const newAvgPrice = ((holding.quantity * holding.avgBuyPrice) + totalCost) / newQty;
      holding.quantity = newQty;
      holding.avgBuyPrice = parseFloat(newAvgPrice.toFixed(2));
    } else {
      // Create new holding
      // Map names/sectors for new stocks
      let name = `${rawSymbol} Ltd.`;
      let abbr = rawSymbol.substring(0, 2);
      let sector = 'Banking';
      let risk = 'MEDIUM';

      portfolio.holdings.push({
        id: rawSymbol.toLowerCase(),
        symbol: rawSymbol,
        name,
        abbr,
        quantity,
        avgBuyPrice: price,
        risk,
        sector
      });
    }
  } else {
    // SELL
    const holdingIndex = portfolio.holdings.findIndex(h => h.symbol.toUpperCase() === rawSymbol);
    if (holdingIndex < 0 || portfolio.holdings[holdingIndex].quantity < quantity) {
      return {
        success: false,
        message: `Insufficient shares of ${rawSymbol} to sell. Owned: ${holdingIndex >= 0 ? portfolio.holdings[holdingIndex].quantity : 0}, Required: ${quantity}`,
        portfolio
      };
    }

    const holding = portfolio.holdings[holdingIndex];
    holding.quantity -= quantity;
    portfolio.buyingPower += totalCost;

    if (holding.quantity === 0) {
      // Remove holding
      portfolio.holdings.splice(holdingIndex, 1);
    }
  }

  savePortfolio(portfolio);
  return {
    success: true,
    message: `Successfully executed ${action} order for ${quantity} shares of ${rawSymbol} at ₹${price.toFixed(2)}`,
    portfolio
  };
}
