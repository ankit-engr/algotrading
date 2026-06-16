import { prisma } from '../db.js';
import { getAllCompanyMetadata, fetchStockCandles } from './finnhub.js';

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
        console.error('Worker error:', err);
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, array.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function seedCompanies(): Promise<number> {
  console.log('Seeding all 50 Nifty 50 companies from hardcoded metadata...');
  const companies = getAllCompanyMetadata();
  let count = 0;

  for (const meta of companies) {
    const symbol = meta.symbol;
    try {
      const existing = await prisma.company.findUnique({
        where: { symbol }
      });

      if (existing) {
        await prisma.company.update({
          where: { symbol },
          data: {
            name: meta.name,
            sector: meta.sector,
            industry: meta.sector,
            exchange: 'NSE',
            country: 'IN',
            currency: 'INR',
            is_active: true
          }
        });
      } else {
        await prisma.company.create({
          data: {
            symbol,
            name: meta.name,
            sector: meta.sector,
            industry: meta.sector,
            exchange: 'NSE',
            country: 'IN',
            currency: 'INR',
            is_active: true
          }
        });
      }
      count++;
      console.log(`Seeded company: ${symbol} — ${meta.name}`);
    } catch (exc) {
      console.error(`Failed to seed company ${symbol}:`, exc);
    }
  }

  console.log(`Company seeding complete: ${count} / ${companies.length} companies saved.`);
  return count;
}

export async function seedCandlesForSymbol(symbol: string, companyId: number, days = 365): Promise<number> {
  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - days * 24 * 60 * 60 * 1000);

  try {
    console.log(`Fetching candles for ${symbol} from Yahoo Finance...`);
    const candles = await fetchStockCandles(symbol, fromDate, toDate);

    if (!candles || candles.length === 0) {
      console.warn(`No candles returned from Yahoo Finance for ${symbol}`);
      return 0;
    }

    let count = 0;
    for (const c of candles) {
      try {
        await prisma.stockCandle.upsert({
          where: {
            symbol_date: {
              symbol,
              date: c.date
            }
          },
          update: {
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: BigInt(c.volume)
          },
          create: {
            symbol,
            date: c.date,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: BigInt(c.volume),
            company_id: companyId
          }
        });
        count++;
      } catch (exc) {
        console.error(`Failed to save candle ${symbol} ${c.date}:`, exc);
      }
    }

    console.log(`Saved ${count} candles for ${symbol}`);
    return count;
  } catch (exc) {
    console.error(`Yahoo Finance fetch failed for ${symbol}:`, exc);
    return 0;
  }
}

export async function seedCandlesForAll(days = 365, delayBetween = 200): Promise<Record<string, number>> {
  console.log(`Starting candle seed for all companies (days=${days}, workers=5)...`);
  const companies = await prisma.company.findMany({
    where: { is_active: true }
  });

  if (companies.length === 0) {
    console.warn('No active companies found in DB. Run seedCompanies() first.');
    return {};
  }

  // Define per-company fetch worker
  const fetchAndSeed = async (company: typeof companies[0]): Promise<[string, number]> => {
    const symbol = company.symbol;
    // Introduce a slight staggered delay to be polite to Yahoo Finance rate limits
    await delay(Math.floor(Math.random() * delayBetween));
    const count = await seedCandlesForSymbol(symbol, company.id, days);
    return [symbol, count];
  };

  // Run with a concurrency of 5 parallel workers
  const rawResults = await pLimit(5, companies, fetchAndSeed);

  const results: Record<string, number> = {};
  for (const item of rawResults) {
    if (item) {
      const [symbol, count] = item;
      results[symbol] = count;
    }
  }

  const total = Object.values(results).reduce((sum, val) => sum + val, 0);
  console.log(`Candle seeding done. ${total} candles saved across ${Object.keys(results).length}/${companies.length} companies.`);
  return results;
}

export async function runFullSeed(): Promise<any> {
  console.log('=== Starting full stock universe seed ===');
  const companyCount = await seedCompanies();
  const candleResults = await seedCandlesForAll(365);

  const totalCandles = Object.values(candleResults).reduce((sum, val) => sum + val, 0);
  console.log(`=== Full seed complete: ${companyCount} companies, ${totalCandles} candles ===`);

  return {
    companies_seeded: companyCount,
    candles_by_symbol: candleResults,
    total_candles: totalCandles
  };
}
