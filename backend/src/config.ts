import dotenv from 'dotenv';
import path from 'path';

// Load .env file
dotenv.config();

export const settings = {
  appName: process.env.APP_NAME || 'BankNiftyAISignalApp',
  appVersion: process.env.APP_VERSION || '1.0.0',
  debug: process.env.DEBUG === 'true',
  databaseUrl: process.env.DATABASE_URL || 'mysql://root:Ankit@1234Secure@localhost:3306/stock',
  confidenceThreshold: parseFloat(process.env.CONFIDENCE_THRESHOLD || '70'),
  minVolumeSurgeRatio: parseFloat(process.env.MIN_VOLUME_SURGE_RATIO || '1.5'),
  marketOpenTime: process.env.MARKET_OPEN_TIME || '09:15',
  marketCloseTime: process.env.MARKET_CLOSE_TIME || '15:30',
  carryForwardTime: process.env.CARRY_FORWARD_TIME || '15:15',
  signalRefreshSeconds: parseInt(process.env.SIGNAL_REFRESH_SECONDS || '30', 10),
  finnhubApiKey: process.env.FINNHUB_API_KEY || '',
  useRealData: process.env.USE_REAL_DATA === 'true',
  port: parseInt(process.env.PORT || '8000', 10)
};
export default settings;
