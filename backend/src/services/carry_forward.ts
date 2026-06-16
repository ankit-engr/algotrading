import { settings } from '../config.js';
import { MarketDataBundle, generateSignal } from './signal.js';

const CARRY_CONFIDENCE_THRESHOLD = settings.confidenceThreshold + 10.0;
const PARTIAL_CARRY_THRESHOLD = settings.confidenceThreshold - 15.0;
const MAX_VIX_FOR_CARRY = 18.0;

export interface CarryForwardResult {
  carry_signal: 'CARRY CE' | 'CARRY PE' | 'PARTIAL CARRY' | 'EXIT ALL';
  date: string;
  generated_at: string;
  bank_nifty_price: number;
  trend: 'Bullish' | 'Bearish' | 'Sideways';
  confidence: number;
  stop_loss: number | null;
  target_1: number | null;
  target_2: number | null;
  vix: number | null;
  pcr: number | null;
  reasoning: string;
}

function buildResult(
  carrySignal: 'CARRY CE' | 'CARRY PE' | 'PARTIAL CARRY' | 'EXIT ALL',
  data: MarketDataBundle,
  intradaySignal: any,
  reasoning: string,
  confidence: number
): CarryForwardResult {
  const trend = intradaySignal ? intradaySignal.trend : 'Sideways';
  const stopLoss = intradaySignal ? intradaySignal.stop_loss : null;
  const targets = intradaySignal ? intradaySignal.targets : [];

  return {
    carry_signal: carrySignal,
    date: new Date().toISOString().split('T')[0],
    generated_at: new Date().toISOString(),
    bank_nifty_price: data.spot_price,
    trend,
    confidence: parseFloat(confidence.toFixed(2)),
    stop_loss: stopLoss,
    target_1: targets[0] ?? null,
    target_2: targets[1] ?? null,
    vix: data.vix,
    pcr: data.option_chain ? data.option_chain.pcr : null,
    reasoning
  };
}

export function generateCarryForward(data: MarketDataBundle): CarryForwardResult {
  // 1. High VIX Check
  if (data.vix !== null && data.vix > MAX_VIX_FOR_CARRY) {
    const reason = `India VIX (${data.vix.toFixed(1)}) above carry threshold (${MAX_VIX_FOR_CARRY}). Overnight risk is too high. Exit all positions.`;
    return buildResult('EXIT ALL', data, null, reason, 0.0);
  }

  // 2. Intraday evaluation (forcing is_market_open to true for carry computation)
  const bundle = { ...data, is_market_open: true };
  const intraday = generateSignal(bundle);

  const confidence = intraday.confidence;
  const trend = intraday.trend;

  // 3. Sideways or NO TRADE checks
  if (intraday.signal === 'NO TRADE' || trend === 'Sideways') {
    const reason = `Current signal is ${intraday.signal} with trend ${trend} and confidence ${confidence.toFixed(1)}. No clear directional conviction — exit all positions.`;
    return buildResult('EXIT ALL', data, intraday, reason, confidence);
  }

  let carrySignal: 'CARRY CE' | 'CARRY PE' | 'PARTIAL CARRY' | 'EXIT ALL' = 'EXIT ALL';
  let reasoning = '';

  if (confidence >= CARRY_CONFIDENCE_THRESHOLD) {
    carrySignal = intraday.signal === 'BUY CE' ? 'CARRY CE' : 'CARRY PE';
    reasoning = `Strong ${trend} trend with confidence ${confidence.toFixed(1)} (threshold: ${CARRY_CONFIDENCE_THRESHOLD}). Full carry recommended. Stop: ${intraday.stop_loss}, Targets: ${intraday.targets.join(', ')}`;
  } else if (confidence >= PARTIAL_CARRY_THRESHOLD) {
    carrySignal = 'PARTIAL CARRY';
    reasoning = `Moderate ${trend} trend with confidence ${confidence.toFixed(1)}. Carry only 50% position size overnight. Overnight risk remains — use tight stop-loss.`;
  } else {
    carrySignal = 'EXIT ALL';
    reasoning = `Confidence ${confidence.toFixed(1)} insufficient for overnight carry (partial threshold: ${PARTIAL_CARRY_THRESHOLD}). Exit all positions before close.`;
  }

  return buildResult(carrySignal, data, intraday, reasoning, confidence);
}
export default generateCarryForward;
