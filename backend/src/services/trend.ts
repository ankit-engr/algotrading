export interface CandleData {
  timestamp?: Date | string;
  date?: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TrendResult {
  trend: 'Bullish' | 'Bearish' | 'Sideways';
  priceVsOpen: 'above' | 'below' | 'at';
  priceVsVwap: 'above' | 'below' | 'at';
  hasHigherHighs: boolean;
  hasLowerLows: boolean;
  volumeTrend: 'increasing' | 'decreasing' | 'neutral';
  strength: number;
  reasoning: string;
}

const MIN_CANDLES = 5;
const SWING_LOOKBACK = 10;
const VOLUME_WINDOW = 5;

function computeVwap(candles: CandleData[]): number {
  if (!candles || candles.length === 0) return 0;
  let sumTypicalVolume = 0;
  let sumVolume = 0;
  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    sumTypicalVolume += typicalPrice * Number(c.volume);
    sumVolume += Number(c.volume);
  }
  if (sumVolume === 0) {
    const sumClose = candles.reduce((acc, c) => acc + c.close, 0);
    return sumClose / candles.length;
  }
  return sumTypicalVolume / sumVolume;
}

function detectHigherHighsLowerLows(
  candles: CandleData[],
  lookback: number = SWING_LOOKBACK
): [boolean, boolean] {
  const recent = candles.slice(0, lookback);
  if (recent.length < 3) {
    return [false, false];
  }

  // candles are ordered newest-first in the input, so reverse recent to get chronological order
  const chronological = [...recent].reverse();
  const highs = chronological.map(c => c.high);
  const lows = chronological.map(c => c.low);

  let hasHigherHighs = true;
  for (let i = 1; i < highs.length; i++) {
    if (highs[i] < highs[i - 1]) {
      hasHigherHighs = false;
      break;
    }
  }

  let hasLowerLows = true;
  for (let i = 1; i < lows.length; i++) {
    if (lows[i] > lows[i - 1]) {
      hasLowerLows = false;
      break;
    }
  }

  return [hasHigherHighs, hasLowerLows];
}

function assessVolumeTrend(
  candles: CandleData[],
  window: number = VOLUME_WINDOW
): 'increasing' | 'decreasing' | 'neutral' {
  if (candles.length < window * 2) {
    return 'neutral';
  }

  const recent = candles.slice(0, window).map(c => Number(c.volume));
  const prior = candles.slice(window, window * 2).map(c => Number(c.volume));

  const avgRecent = recent.reduce((sum, v) => sum + v, 0) / window;
  const avgPrior = prior.reduce((sum, v) => sum + v, 0) / window;

  if (avgPrior === 0) {
    return 'neutral';
  }

  const ratio = avgRecent / avgPrior;
  if (ratio >= 1.15) {
    return 'increasing';
  } else if (ratio <= 0.85) {
    return 'decreasing';
  }
  return 'neutral';
}

function scoreTrendStrength(
  priceVsOpen: string,
  priceVsVwap: string,
  hasHigherHighs: boolean,
  hasLowerLows: boolean,
  volumeTrend: string,
  trend: string
): number {
  let score = 0;

  if (trend === 'Bullish') {
    if (priceVsOpen === 'above') score += 25;
    if (priceVsVwap === 'above') score += 30;
    if (hasHigherHighs) score += 25;
    if (volumeTrend === 'increasing') score += 20;
  } else if (trend === 'Bearish') {
    if (priceVsOpen === 'below') score += 25;
    if (priceVsVwap === 'below') score += 30;
    if (hasLowerLows) score += 25;
    if (volumeTrend === 'increasing') score += 20;
  } else {
    score = 30.0;
  }

  return Math.min(score, 100.0);
}

export function analyzeTrend(
  candles5m: CandleData[],
  candles15m: CandleData[] | null = null
): TrendResult {
  if (!candles5m || candles5m.length < MIN_CANDLES) {
    return {
      trend: 'Sideways',
      priceVsOpen: 'at',
      priceVsVwap: 'at',
      hasHigherHighs: false,
      hasLowerLows: false,
      volumeTrend: 'neutral',
      strength: 0,
      reasoning: 'Insufficient data — defaulting to Sideways (NO TRADE)'
    };
  }

  // candles5m input is expected newest-first (index 0 is latest)
  const candlesSorted = [...candles5m].reverse(); // oldest first
  const latest = candles5m[0];

  const dayOpen = candlesSorted[0].open;
  const vwap = computeVwap(candlesSorted);

  // Price vs Open
  const openThreshold = dayOpen * 0.001;
  let priceVsOpen: 'above' | 'below' | 'at' = 'at';
  if (latest.close > dayOpen + openThreshold) {
    priceVsOpen = 'above';
  } else if (latest.close < dayOpen - openThreshold) {
    priceVsOpen = 'below';
  }

  // Price vs VWAP
  const vwapThreshold = vwap * 0.001;
  let priceVsVwap: 'above' | 'below' | 'at' = 'at';
  if (latest.close > vwap + vwapThreshold) {
    priceVsVwap = 'above';
  } else if (latest.close < vwap - vwapThreshold) {
    priceVsVwap = 'below';
  }

  const [hasHigherHighs, hasLowerLows] = detectHigherHighsLowerLows(candles5m);
  const volumeTrend = assessVolumeTrend(candles5m);

  let bullishSignals = 0;
  if (priceVsOpen === 'above') bullishSignals++;
  if (priceVsVwap === 'above') bullishSignals++;
  if (hasHigherHighs) bullishSignals++;
  if (volumeTrend === 'increasing') bullishSignals++;

  let bearishSignals = 0;
  if (priceVsOpen === 'below') bearishSignals++;
  if (priceVsVwap === 'below') bearishSignals++;
  if (hasLowerLows) bearishSignals++;
  if (volumeTrend === 'decreasing') bearishSignals++;

  let trend: 'Bullish' | 'Bearish' | 'Sideways' = 'Sideways';
  if (bullishSignals >= 3) {
    trend = 'Bullish';
  } else if (bearishSignals >= 3) {
    trend = 'Bearish';
  }

  const strength = scoreTrendStrength(
    priceVsOpen,
    priceVsVwap,
    hasHigherHighs,
    hasLowerLows,
    volumeTrend,
    trend
  );

  const reasoning = `Trend: ${trend} | Price vs Open: ${priceVsOpen} | Price vs VWAP(${vwap.toFixed(2)}): ${priceVsVwap} | HH: ${hasHigherHighs} | LL: ${hasLowerLows} | Volume: ${volumeTrend} | Bullish signals: ${bullishSignals}/4, Bearish: ${bearishSignals}/4`;

  return {
    trend,
    priceVsOpen,
    priceVsVwap,
    hasHigherHighs,
    hasLowerLows,
    volumeTrend,
    strength,
    reasoning
  };
}
