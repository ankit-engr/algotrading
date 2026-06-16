import { settings } from '../config.js';
import { MarketDataBundle, isMarketOpen } from './signal.js';
import { getCurrentMarketData } from '../utils/mock_data.js';
import { CandleData } from './trend.js';
import { OptionChainData } from './confidence.js';

export async function fetchUpstoxMarketData(): Promise<MarketDataBundle | null> {
  if (!settings.useRealData || !process.env.UPSTOX_ACCESS_TOKEN) {
    return null;
  }

  const headers = {
    'accept': 'application/json',
    'Authorization': `Bearer ${process.env.UPSTOX_ACCESS_TOKEN}`
  };

  try {
    // 1. Fetch Spot Index Price and India VIX LTP
    const ltpUrl = 'https://api.upstox.com/v2/market-quote/ltp?instrument_key=NSE_INDEX%7CNifty%20Bank%2CNSE_INDEX%7CIndia%20VIX';
    const resLtp = await fetch(ltpUrl, { headers });
    if (!resLtp.ok) {
      console.error(`Upstox quotes fetch failed: HTTP ${resLtp.status}`);
      return null;
    }

    const ltpData = (await resLtp.json()) as any;
    if (ltpData.status !== 'success') {
      console.error('Failed to fetch quotes from Upstox', ltpData);
      return null;
    }

    const dataMap = ltpData.data || {};
    const bnData = dataMap['NSE_INDEX:Nifty Bank'] || dataMap['NSE_INDEX|Nifty Bank'] || {};
    const vixData = dataMap['NSE_INDEX:India VIX'] || dataMap['NSE_INDEX|India VIX'] || {};

    const spotPrice = bnData.last_price;
    let vix = vixData.last_price;

    if (!spotPrice) {
      console.error('Could not extract NIFTY Bank spot price from Upstox response.');
      return null;
    }

    if (!vix) {
      console.warn('Could not extract India VIX from Upstox. Defaulting VIX to 15.0.');
      vix = 15.0;
    }

    // 2. Fetch Historical Candles (5m and 15m) for Bank Nifty Index
    const encodedKey = encodeURIComponent('NSE_INDEX|Nifty Bank');
    const now = new Date();
    
    // Helper to format date YYYY-MM-DD
    const formatDate = (d: Date) => d.toISOString().split('T')[0];
    const toDateStr = formatDate(now);
    const fromDateStr = formatDate(new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000)); // last 5 days

    // 5m candles
    const url5m = `https://api.upstox.com/v2/historical-candle/${encodedKey}/5minute/${toDateStr}/${fromDateStr}`;
    const res5m = await fetch(url5m, { headers });
    const res5mData = res5m.ok ? ((await res5m.json()) as any) : null;

    // 15m candles
    const url15m = `https://api.upstox.com/v2/historical-candle/${encodedKey}/15minute/${toDateStr}/${fromDateStr}`;
    const res15m = await fetch(url15m, { headers });
    const res15mData = res15m.ok ? ((await res15m.json()) as any) : null;

    const candles5m: CandleData[] = [];
    if (res5mData && res5mData.status === 'success') {
      const rawCandles = res5mData.data?.candles || [];
      for (const item of rawCandles) {
        candles5m.push({
          timestamp: item[0],
          open: parseFloat(item[1]),
          high: parseFloat(item[2]),
          low: parseFloat(item[3]),
          close: parseFloat(item[4]),
          volume: parseInt(item[5], 10)
        });
      }
    }

    const candles15m: CandleData[] = [];
    if (res15mData && res15mData.status === 'success') {
      const rawCandles = res15mData.data?.candles || [];
      for (const item of rawCandles) {
        candles15m.push({
          timestamp: item[0],
          open: parseFloat(item[1]),
          high: parseFloat(item[2]),
          low: parseFloat(item[3]),
          close: parseFloat(item[4]),
          volume: parseInt(item[5], 10)
        });
      }
    }

    if (candles5m.length < 5) {
      console.error(`Insufficient 5m candles returned by Upstox (count: ${candles5m.length}).`);
      return null;
    }

    // 3. Fetch Option Chain Data
    const chainUrl = `https://api.upstox.com/v2/option/chain?instrument_key=${encodedKey}`;
    const resChain = await fetch(chainUrl, { headers });
    const resChainData = resChain.ok ? ((await resChain.json()) as any) : null;

    let optionChain: OptionChainData | null = null;
    if (resChainData && resChainData.status === 'success') {
      const chainItems = resChainData.data || [];
      if (chainItems.length > 0) {
        // Group options by expiry to find the nearest future/today expiry date
        const expiries = Array.from(new Set(chainItems.map((x: any) => x.expiry).filter(Boolean))).sort() as string[];
        const todayStr = toDateStr;
        const futureExpiries = expiries.filter(exp => exp >= todayStr);
        const nearestExpiry = futureExpiries[0] || expiries[0] || todayStr;

        const strikesList = [];
        let totalCallOi = 0;
        let totalPutOi = 0;
        let atmCallOi = 0;
        let atmPutOi = 0;
        let atmCallIv = 0;
        let atmPutIv = 0;

        // Find ATM index: find strike closest to spotPrice
        let closestStrikeDiff = Infinity;
        let atmStrike = 0;

        for (const item of chainItems) {
          if (item.expiry !== nearestExpiry) continue;
          const strikeVal = parseFloat(item.strike_price);
          const diff = Math.abs(strikeVal - spotPrice);
          if (diff < closestStrikeDiff) {
            closestStrikeDiff = diff;
            atmStrike = strikeVal;
          }
        }

        for (const item of chainItems) {
          if (item.expiry !== nearestExpiry) continue;
          const strikeVal = parseFloat(item.strike_price);

          const callOpt = item.call_options || {};
          const callMd = callOpt.market_data || {};
          const callGreeks = callOpt.option_greeks || {};

          const putOpt = item.put_options || {};
          const putMd = putOpt.market_data || {};
          const putGreeks = putOpt.option_greeks || {};

          const callOi = parseFloat(callMd.oi || 0.0);
          const putOi = parseFloat(putMd.oi || 0.0);
          const callIv = parseFloat(callGreeks.iv || 0.0);
          const putIv = parseFloat(putGreeks.iv || 0.0);

          totalCallOi += callOi;
          totalPutOi += putOi;

          if (strikeVal === atmStrike) {
            atmCallOi = callOi;
            atmPutOi = putOi;
            atmCallIv = callIv;
            atmPutIv = putIv;
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
    }

    const marketIsOpen = isMarketOpen();

    return {
      spot_price: spotPrice,
      candles_5m: candles5m.slice(0, 50),
      candles_15m: candles15m.slice(0, 20),
      option_chain: optionChain,
      vix,
      is_market_open: marketIsOpen
    };
  } catch (err) {
    console.error('Failed to fetch market data from Upstox API:', err);
    return null;
  }
}

export async function getActiveMarketData(isMarketOpenOverride?: boolean): Promise<MarketDataBundle> {
  const is_open = isMarketOpenOverride !== undefined ? isMarketOpenOverride : isMarketOpen();

  if (!settings.useRealData) {
    console.log('Real market data integration is disabled. Using mock market data.');
    return getCurrentMarketData(is_open);
  }

  const bundle = await fetchUpstoxMarketData();
  if (bundle) {
    bundle.is_market_open = is_open;
    return bundle;
  }

  console.warn('Failed to fetch market data from Upstox. Falling back to mock market data.');
  return getCurrentMarketData(is_open);
}
export default getActiveMarketData;
