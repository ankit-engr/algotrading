import { settings } from '../config.js';
import { CandleData, TrendResult, analyzeTrend } from './trend.js';
import { OptionChainData, ConfidenceBreakdown, calculateConfidence } from './confidence.js';

export interface MarketDataBundle {
  spot_price: number;
  is_market_open: boolean;
  candles_5m: CandleData[];
  candles_15m: CandleData[] | null;
  option_chain: OptionChainData | null;
  vix: number | null;
}

export interface SignalResult {
  timestamp: string;
  bank_nifty: number;
  trend: 'Bullish' | 'Bearish' | 'Sideways';
  signal: 'BUY CE' | 'BUY PE' | 'NO TRADE';
  confidence: number;
  risk_level: 'Low' | 'Medium' | 'High';
  stop_loss: number | null;
  targets: number[];
  market_status: 'Open' | 'Closed';
  confidence_breakdown?: ConfidenceBreakdown | null;
  ai_prediction?: {
    up_probability: number;
    down_probability: number;
    confidence: number;
    expected_range: number;
    model_available: boolean;
  } | null;
  vix: number | null;
  pcr: number | null;
}

export function isMarketOpen(nowTime?: Date): boolean {
  const ts = nowTime || new Date();
  
  // Convert UTC to Asia/Kolkata (IST: UTC + 5:30)
  const utcOffset = ts.getTime() + (ts.getTimezoneOffset() * 60000);
  const istTime = new Date(utcOffset + (3600000 * 5.5));
  
  const day = istTime.getDay(); // 0=Sunday, 6=Saturday
  if (day === 0 || day === 6) {
    return false;
  }

  const hour = istTime.getHours();
  const minute = istTime.getMinutes();
  const currentMinutes = hour * 60 + minute;

  const [openH, openM] = settings.marketOpenTime.split(':').map(Number);
  const [closeH, closeM] = settings.marketCloseTime.split(':').map(Number);

  const openMinutes = openH * 60 + openM;
  const closeMinutes = closeH * 60 + closeM;

  return currentMinutes >= openMinutes && currentMinutes < closeMinutes;
}

function computeRiskLevel(confidence: number, vix: number | null): 'Low' | 'Medium' | 'High' {
  if (vix !== null && vix > 20) {
    return 'High';
  }
  if (confidence >= 85) {
    return 'Low';
  } else if (confidence >= 70) {
    return 'Medium';
  }
  return 'High';
}

function computeStopLossAndTargets(
  price: number,
  direction: 'bullish' | 'bearish',
  vix: number | null
): [number, number[]] {
  const vixFactor = (vix || 15.0) / 15.0;
  const atrPct = 0.005 * vixFactor;

  let stopLoss: number;
  let targets: number[];

  if (direction === 'bullish') {
    stopLoss = parseFloat((price * (1 - atrPct)).toFixed(2));
    const risk = price - stopLoss;
    targets = [
      parseFloat((price + risk * 1.0).toFixed(2)),
      parseFloat((price + risk * 1.5).toFixed(2)),
      parseFloat((price + risk * 2.0).toFixed(2))
    ];
  } else {
    stopLoss = parseFloat((price * (1 + atrPct)).toFixed(2));
    const risk = stopLoss - price;
    targets = [
      parseFloat((price - risk * 1.0).toFixed(2)),
      parseFloat((price - risk * 1.5).toFixed(2)),
      parseFloat((price - risk * 2.0).toFixed(2))
    ];
  }

  return [stopLoss, targets];
}

function noTradeResult(
  price: number,
  trendResult: TrendResult | null,
  marketStatus: 'Open' | 'Closed',
  confidence = 0.0,
  confidenceBreakdown: ConfidenceBreakdown | null = null,
  vix: number | null = null,
  pcr: number | null = null
): SignalResult {
  return {
    timestamp: new Date().toISOString(),
    bank_nifty: price,
    trend: trendResult ? trendResult.trend : 'Sideways',
    signal: 'NO TRADE',
    confidence,
    risk_level: 'High',
    stop_loss: null,
    targets: [],
    market_status: marketStatus,
    confidence_breakdown: confidenceBreakdown,
    ai_prediction: {
      up_probability: 0.5,
      down_probability: 0.5,
      confidence: 50.0,
      expected_range: 0.0,
      model_available: false
    },
    vix,
    pcr
  };
}

export function generateSignal(data: MarketDataBundle): SignalResult {
  const price = data.spot_price;
  const marketStatus: 'Open' | 'Closed' = data.is_market_open ? 'Open' : 'Closed';
  const vix = data.vix;
  const pcr = data.option_chain ? data.option_chain.pcr : null;

  try {
    if (!data.candles_5m || data.candles_5m.length < 5) {
      return noTradeResult(price, null, marketStatus, 0, null, vix, pcr);
    }

    const trendResult = analyzeTrend(data.candles_5m, data.candles_15m);
    const direction = trendResult.trend === 'Bullish' ? 'bullish' : 'bearish';

    const confidenceBreakdown = calculateConfidence(
      trendResult,
      data.candles_5m,
      data.option_chain,
      direction
    );
    const rulesConfidence = confidenceBreakdown.total;

    // AI model disabled; returns fallback prediction
    const aiPrediction = {
      up_probability: 0.5,
      down_probability: 0.5,
      confidence: 50.0,
      expected_range: 0.0,
      model_available: false
    };

    // 1. Closed Market override
    if (!data.is_market_open) {
      return noTradeResult(price, trendResult, 'Closed', rulesConfidence, confidenceBreakdown, vix, pcr);
    }

    // 2. Sideways Market override
    if (trendResult.trend === 'Sideways') {
      return noTradeResult(price, trendResult, marketStatus, rulesConfidence, confidenceBreakdown, vix, pcr);
    }

    // 3. Confidence threshold override
    if (rulesConfidence < settings.confidenceThreshold) {
      return noTradeResult(price, trendResult, marketStatus, rulesConfidence, confidenceBreakdown, vix, pcr);
    }

    const signal = direction === 'bullish' ? 'BUY CE' : 'BUY PE';
    const riskLevel = computeRiskLevel(rulesConfidence, vix);
    const [stopLoss, targets] = computeStopLossAndTargets(price, direction, vix);

    return {
      timestamp: new Date().toISOString(),
      bank_nifty: price,
      trend: trendResult.trend,
      signal,
      confidence: rulesConfidence,
      risk_level: riskLevel,
      stop_loss: stopLoss,
      targets,
      market_status: marketStatus,
      confidence_breakdown: confidenceBreakdown,
      ai_prediction: aiPrediction,
      vix,
      pcr
    };
  } catch (err) {
    return noTradeResult(price, null, marketStatus, 0, null, vix, pcr);
  }
}
export default generateSignal;
