export interface CompanyMetadata {
  symbol: string;
  name: string;
  sector: string;
}

export const COMPANY_UNIVERSE: CompanyMetadata[] = [
  // Banking
  { symbol: 'HDFCBANK',   name: 'HDFC Bank Ltd.',                  sector: 'Banking' },
  { symbol: 'ICICIBANK',  name: 'ICICI Bank Ltd.',                  sector: 'Banking' },
  { symbol: 'KOTAKBANK',  name: 'Kotak Mahindra Bank Ltd.',         sector: 'Banking' },
  { symbol: 'AXISBANK',   name: 'Axis Bank Ltd.',                   sector: 'Banking' },
  { symbol: 'SBIN',       name: 'State Bank of India',              sector: 'Banking' },
  { symbol: 'INDUSINDBK', name: 'IndusInd Bank Ltd.',               sector: 'Banking' },
  // IT
  { symbol: 'TCS',        name: 'Tata Consultancy Services Ltd.',   sector: 'IT' },
  { symbol: 'INFY',       name: 'Infosys Ltd.',                     sector: 'IT' },
  { symbol: 'HCLTECH',    name: 'HCL Technologies Ltd.',            sector: 'IT' },
  { symbol: 'WIPRO',      name: 'Wipro Ltd.',                       sector: 'IT' },
  { symbol: 'TECHM',      name: 'Tech Mahindra Ltd.',               sector: 'IT' },
  // Financial Services
  { symbol: 'RELIANCE',   name: 'Reliance Industries Ltd.',         sector: 'Energy' },
  { symbol: 'BAJFINANCE', name: 'Bajaj Finance Ltd.',               sector: 'Financial Services' },
  { symbol: 'BAJAJFINSV', name: 'Bajaj Finserv Ltd.',               sector: 'Financial Services' },
  { symbol: 'HDFCLIFE',   name: 'HDFC Life Insurance Co. Ltd.',     sector: 'Insurance' },
  { symbol: 'SBILIFE',    name: 'SBI Life Insurance Co. Ltd.',      sector: 'Insurance' },
  // FMCG
  { symbol: 'HINDUNILVR', name: 'Hindustan Unilever Ltd.',          sector: 'FMCG' },
  { symbol: 'ITC',        name: 'ITC Ltd.',                         sector: 'FMCG' },
  { symbol: 'NESTLEIND',  name: 'Nestle India Ltd.',                sector: 'FMCG' },
  { symbol: 'BRITANNIA',  name: 'Britannia Industries Ltd.',        sector: 'FMCG' },
  { symbol: 'TATACONSUM', name: 'Tata Consumer Products Ltd.',      sector: 'FMCG' },
  // Auto
  { symbol: 'MARUTI',     name: 'Maruti Suzuki India Ltd.',         sector: 'Automobile' },
  { symbol: 'TATAMOTORS', name: 'Tata Motors Ltd.',                 sector: 'Automobile' },
  { symbol: 'HEROMOTOCO', name: 'Hero MotoCorp Ltd.',               sector: 'Automobile' },
  { symbol: 'BAJAJ-AUTO', name: 'Bajaj Auto Ltd.',                  sector: 'Automobile' },
  { symbol: 'EICHERMOT',  name: 'Eicher Motors Ltd.',               sector: 'Automobile' },
  // Pharma
  { symbol: 'SUNPHARMA',  name: 'Sun Pharmaceutical Industries Ltd.', sector: 'Pharma' },
  { symbol: 'CIPLA',      name: 'Cipla Ltd.',                       sector: 'Pharma' },
  { symbol: 'DRREDDY',    name: 'Dr. Reddy\'s Laboratories Ltd.',    sector: 'Pharma' },
  { symbol: 'DIVISLAB',   name: 'Divi\'s Laboratories Ltd.',         sector: 'Pharma' },
  { symbol: 'APOLLOHOSP', name: 'Apollo Hospitals Enterprise Ltd.', sector: 'Healthcare' },
  // Metals
  { symbol: 'TATASTEEL',  name: 'Tata Steel Ltd.',                  sector: 'Metals' },
  { symbol: 'JSWSTEEL',   name: 'JSW Steel Ltd.',                   sector: 'Metals' },
  { symbol: 'HINDALCO',   name: 'Hindalco Industries Ltd.',         sector: 'Metals' },
  { symbol: 'COALINDIA',  name: 'Coal India Ltd.',                  sector: 'Metals' },
  // Energy
  { symbol: 'ONGC',       name: 'Oil & Natural Gas Corp Ltd.',      sector: 'Energy' },
  { symbol: 'BPCL',       name: 'Bharat Petroleum Corp Ltd.',       sector: 'Energy' },
  { symbol: 'NTPC',       name: 'NTPC Ltd.',                        sector: 'Energy' },
  { symbol: 'POWERGRID',  name: 'Power Grid Corp of India Ltd.',    sector: 'Energy' },
  { symbol: 'ADANIENT',   name: 'Adani Enterprises Ltd.',           sector: 'Conglomerate' },
  { symbol: 'ADANIPORTS', name: 'Adani Ports & SEZ Ltd.',           sector: 'Infrastructure' },
  // Telecom
  { symbol: 'BHARTIARTL', name: 'Bharti Airtel Ltd.',               sector: 'Telecom' },
  // Infra / Cement
  { symbol: 'LT',         name: 'Larsen & Toubro Ltd.',             sector: 'Infrastructure' },
  { symbol: 'GRASIM',     name: 'Grasim Industries Ltd.',           sector: 'Cement' },
  { symbol: 'ULTRACEMCO', name: 'UltraTech Cement Ltd.',            sector: 'Cement' },
  // Paints
  { symbol: 'ASIANPAINT', name: 'Asian Paints Ltd.',                sector: 'Consumer Goods' },
  { symbol: 'TITAN',      name: 'Titan Company Ltd.',               sector: 'Consumer Goods' },
  // Others
  { symbol: 'M&M',        name: 'Mahindra & Mahindra Ltd.',         sector: 'Automobile' },
  { symbol: 'UPL',        name: 'UPL Ltd.',                         sector: 'Chemicals' },
  { symbol: 'VEDL',       name: 'Vedanta Ltd.',                     sector: 'Metals' },
];

export const COMPANY_MAP = new Map<string, CompanyMetadata>(
  COMPANY_UNIVERSE.map(c => [c.symbol, c])
);

export function getAllCompanyMetadata(): CompanyMetadata[] {
  return COMPANY_UNIVERSE;
}

export function mapSymbolToYFinance(symbol: string): string {
  const sym = symbol.toUpperCase().trim();
  if (sym === 'BANKNIFTY') return '^NSEBANK';
  if (sym === 'TATAMOTORS') return 'TMCV.NS';
  if (sym.endsWith('.NS') || sym.startsWith('^')) return sym;
  return `${sym}.NS`;
}

export async function fetchStockCandles(
  symbol: string,
  fromDate?: Date,
  toDate?: Date,
  interval: string = '1d'
): Promise<any[]> {
  const end = toDate || new Date();
  const start = fromDate || new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);

  const fromTs = Math.floor(start.getTime() / 1000);
  const toTs = Math.floor(end.getTime() / 1000);

  const yfSymbol = mapSymbolToYFinance(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yfSymbol}?period1=${fromTs}&period2=${toTs}&interval=${interval}`;

  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as any;
    const result = data.chart?.result?.[0];
    if (!result) return [];

    const timestamps = result.timestamp || [];
    const quotes = result.indicators?.quote?.[0];
    if (!quotes) return [];

    const candles = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (
        quotes.open[i] === null ||
        quotes.high[i] === null ||
        quotes.low[i] === null ||
        quotes.close[i] === null ||
        quotes.volume[i] === null ||
        quotes.open[i] === undefined ||
        quotes.high[i] === undefined ||
        quotes.low[i] === undefined ||
        quotes.close[i] === undefined ||
        quotes.volume[i] === undefined
      ) {
        continue;
      }

      const dt = new Date(timestamps[i] * 1000);
      const dateStr = dt.toISOString().split('T')[0];

      candles.push({
        date: dateStr,
        open: Number(quotes.open[i]),
        high: Number(quotes.high[i]),
        low: Number(quotes.low[i]),
        close: Number(quotes.close[i]),
        volume: Math.round(Number(quotes.volume[i]))
      });
    }
    return candles;
  } catch (err) {
    console.error(`Yahoo Finance fetch failed for ${symbol}:`, err);
    return [];
  }
}
