import { CandleData, TrendResult } from './trend.js';

export interface OptionChainData {
  pcr: number;
  atm_call_oi?: number | null;
  atm_put_oi?: number | null;
  total_call_oi: number;
  total_put_oi: number;
  atm_call_iv?: number | null;
  atm_put_iv?: number | null;
}

export interface ConfidenceBreakdown {
  trend_score: number;
  volume_score: number;
  oi_score: number;
  option_chain_score: number;
  momentum_score: number;
  pcr_score: number;
  total: number;
}

const WEIGHTS = {
  trend: 0.25,
  volume: 0.15,
  oi: 0.20,
  option_chain: 0.20,
  momentum: 0.10,
  pcr: 0.10,
};

function scoreTrend(trendResult: TrendResult): number {
  if (trendResult.trend === 'Sideways') {
    return trendResult.strength * 0.3;
  }
  return trendResult.strength;
}

function scoreVolume(candles: CandleData[], direction: 'bullish' | 'bearish', window = 5): number {
  if (candles.length < window * 2) {
    return 50.0;
  }

  const recent = candles.slice(0, window).map(c => Number(c.volume));
  const prior = candles.slice(window, window * 2).map(c => Number(c.volume));

  const avgRecent = recent.reduce((sum, v) => sum + v, 0) / window;
  const avgPrior = prior.reduce((sum, v) => sum + v, 0) / window || 1.0;

  const ratio = avgRecent / avgPrior;
  const score = Math.min(((ratio - 0.5) / 1.5) * 100, 100);
  return Math.max(score, 0.0);
}

function scoreOpenInterest(optionChain: OptionChainData | null, direction: 'bullish' | 'bearish'): number {
  if (!optionChain) {
    return 50.0;
  }

  const callOi = optionChain.atm_call_oi ?? optionChain.total_call_oi;
  const putOi = optionChain.atm_put_oi ?? optionChain.total_put_oi;

  if (callOi === 0 && putOi === 0) {
    return 50.0;
  }

  const total = callOi + putOi;
  if (total === 0) {
    return 50.0;
  }

  if (direction === 'bullish') {
    const putRatio = putOi / total;
    return Math.min(putRatio * 130, 100);
  } else {
    const callRatio = callOi / total;
    return Math.min(callRatio * 130, 100);
  }
}

function scoreOptionChain(optionChain: OptionChainData | null, direction: 'bullish' | 'bearish'): number {
  if (!optionChain) {
    return 50.0;
  }

  const callIv = optionChain.atm_call_iv ?? 0.0;
  const putIv = optionChain.atm_put_iv ?? 0.0;

  if (callIv === 0 && putIv === 0) {
    return 50.0;
  }

  const totalIv = callIv + putIv;
  if (totalIv === 0) {
    return 50.0;
  }

  if (direction === 'bullish') {
    const callRatio = callIv / totalIv;
    return Math.min(callRatio * 130, 100);
  } else {
    const putRatio = putIv / totalIv;
    return Math.min(putRatio * 130, 100);
  }
}

function scoreMomentum(candles: CandleData[], window = 14): number {
  if (candles.length < window + 1) {
    return 50.0;
  }

  // Reverse candles to chronological (oldest to newest)
  const chronological = [...candles].reverse();
  const closes = chronological.map(c => c.close);

  const windowCloses = closes.slice(-window - 1);
  let gains = 0;
  let losses = 0;

  for (let i = 1; i < windowCloses.length; i++) {
    const diff = windowCloses[i] - windowCloses[i - 1];
    if (diff > 0) {
      gains += diff;
    } else {
      losses -= diff;
    }
  }

  const avgGain = gains / window;
  const avgLoss = losses / window;

  let rsi = 50.0;
  if (avgLoss === 0) {
    rsi = 100.0;
  } else {
    const rs = avgGain / avgLoss;
    rsi = 100.0 - (100.0 / (1.0 + rs));
  }

  const deviation = Math.abs(rsi - 50.0);
  return Math.min(deviation * 2, 100.0);
}

function scorePcr(pcr: number | null, direction: 'bullish' | 'bearish'): number {
  if (pcr === null || pcr === undefined) {
    return 50.0;
  }

  if (direction === 'bullish') {
    if (pcr >= 1.3) return 90.0;
    if (pcr >= 1.0) return 70.0;
    if (pcr >= 0.7) return 40.0;
    return 20.0;
  } else {
    if (pcr <= 0.7) return 90.0;
    if (pcr <= 1.0) return 70.0;
    if (pcr <= 1.3) return 40.0;
    return 20.0;
  }
}

export function calculateConfidence(
  trendResult: TrendResult,
  candles5m: CandleData[],
  optionChain: OptionChainData | null,
  direction: 'bullish' | 'bearish'
): ConfidenceBreakdown {
  const pcr = optionChain ? optionChain.pcr : null;

  const trendScore = scoreTrend(trendResult);
  const volumeScore = scoreVolume(candles5m, direction);
  const oiScore = scoreOpenInterest(optionChain, direction);
  const optionChainScore = scoreOptionChain(optionChain, direction);
  const momentumScore = scoreMomentum(candles5m);
  const pcrScore = scorePcr(pcr, direction);

  const weightedTotal =
    trendScore * WEIGHTS.trend +
    volumeScore * WEIGHTS.volume +
    oiScore * WEIGHTS.oi +
    optionChainScore * WEIGHTS.option_chain +
    momentumScore * WEIGHTS.momentum +
    pcrScore * WEIGHTS.pcr;

  const total = parseFloat(weightedTotal.toFixed(2));

  return {
    trend_score: parseFloat(trendScore.toFixed(2)),
    volume_score: parseFloat(volumeScore.toFixed(2)),
    oi_score: parseFloat(oiScore.toFixed(2)),
    option_chain_score: parseFloat(optionChainScore.toFixed(2)),
    momentum_score: parseFloat(momentumScore.toFixed(2)),
    pcr_score: parseFloat(pcrScore.toFixed(2)),
    total
  };
}
export default calculateConfidence;
