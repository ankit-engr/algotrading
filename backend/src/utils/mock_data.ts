import { CandleData } from '../services/trend.js';
import { OptionChainData } from '../services/confidence.js';
import { MarketDataBundle } from '../services/signal.js';

const BASE_PRICE = 46500.0;
let currentPrice = BASE_PRICE;

function randomGauss(mean: number, stddev: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const randStdNormal = Math.sqrt(-2.0 * Math.log(u1)) * Math.sin(2.0 * Math.PI * u2);
  return mean + stddev * randStdNormal;
}

function randomUniform(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function randomCandle(timestamp: Date, price: number, timeframe: string): CandleData {
  const ret = randomGauss(0, 0.003); // ±0.3% per bar
  const open = price;
  const close = price * (1 + ret);
  const high = Math.max(open, close) * (1 + Math.abs(randomGauss(0, 0.0008)));
  const low = Math.min(open, close) * (1 - Math.abs(randomGauss(0, 0.0008)));
  const volume = Math.round(randomUniform(300000, 4000000));
  const vwap = (high + low + close) / 3;

  return {
    timestamp: timestamp.toISOString(),
    open: parseFloat(open.toFixed(2)),
    high: parseFloat(high.toFixed(2)),
    low: parseFloat(low.toFixed(2)),
    close: parseFloat(close.toFixed(2)),
    volume,
  };
}

function generateCandleSeries(
  n: number,
  timeframe: string,
  intervalMinutes: number,
  endTime: Date
): CandleData[] {
  const candles: CandleData[] = [];
  let price = currentPrice;
  let ts = new Date(endTime.getTime());

  for (let i = 0; i < n; i++) {
    const candle = randomCandle(ts, price, timeframe);
    candles.push(candle);
    price = candle.open; // walk backwards
    ts = new Date(ts.getTime() - intervalMinutes * 60000);
  }

  return candles; // newest first
}

function generateOptionChain(spot: number): OptionChainData {
  const strikes = [];
  const roundedSpot = Math.round(spot / 100) * 100;
  
  let totalCallOi = 0;
  let totalPutOi = 0;

  for (let i = -10; i <= 10; i++) {
    const strike = roundedSpot + i * 100;
    const callOi = Math.max(0, Math.round(randomGauss(500000 - Math.abs(i) * 80000, 100000)));
    const putOi = Math.max(0, Math.round(randomGauss(500000 - Math.abs(i) * 80000, 100000)));
    
    totalCallOi += callOi;
    totalPutOi += putOi;

    strikes.push({
      strike: parseFloat(strike.toFixed(2)),
      call_oi: callOi,
      put_oi: putOi,
      call_iv: parseFloat(randomUniform(12, 25).toFixed(2)),
      put_iv: parseFloat(randomUniform(13, 28).toFixed(2)),
      call_volume: Math.round(randomUniform(10000, 500000)),
      put_volume: Math.round(randomUniform(10000, 500000)),
      call_ltp: Math.max(1.0, parseFloat(randomUniform(5, 500).toFixed(2))),
      put_ltp: Math.max(1.0, parseFloat(randomUniform(5, 500).toFixed(2)))
    });
  }

  return {
    pcr: totalPutOi / (totalCallOi || 1),
    total_call_oi: totalCallOi,
    total_put_oi: totalPutOi,
    atm_call_oi: strikes[10].call_oi,
    atm_put_oi: strikes[10].put_oi,
    atm_call_iv: strikes[10].call_iv,
    atm_put_iv: strikes[10].put_iv
  };
}

export function getCurrentMarketData(isMarketOpen = true): MarketDataBundle {
  const now = new Date();

  // Drift the simulated price for realism
  const drift = randomGauss(0, 0.002);
  currentPrice = parseFloat((currentPrice * (1 + drift)).toFixed(2));

  const candles5m = generateCandleSeries(50, '5m', 5, now);
  const candles15m = generateCandleSeries(20, '15m', 15, now);
  const optionChain = generateOptionChain(currentPrice);
  const vix = parseFloat(randomUniform(11.0, 22.0).toFixed(2));

  return {
    spot_price: currentPrice,
    candles_5m: candles5m,
    candles_15m: candles15m,
    option_chain: optionChain,
    vix: vix,
    is_market_open: isMarketOpen
  };
}
