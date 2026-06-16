import cron from 'node-cron';
import { settings } from '../config.js';
import { getActiveMarketData } from './upstox.js';
import { generateSignal, SignalResult } from './signal.js';
import { checkAndBroadcastSignal, buildCarryForwardAlert, broadcaster } from './alerts.js';
import { generateCarryForward } from './carry_forward.js';
import { seedCandlesForAll } from './seeder.js';
import { analyseAllCompanies } from './profitability.js';
import { prisma } from '../db.js';

let latestSignal: SignalResult | null = null;
let latestCarry: any | null = null;

let signalInterval: NodeJS.Timeout | null = null;
const scheduledTasks: cron.ScheduledTask[] = [];

export function getLatestSignal(): SignalResult | null {
  return latestSignal;
}

export function getLatestCarry(): any | null {
  return latestCarry;
}

export async function signalRefreshJob(): Promise<void> {
  try {
    const data = await getActiveMarketData();
    const signal = generateSignal(data);

    latestSignal = signal;
    await checkAndBroadcastSignal(signal);

    console.log(`[Signal Refresh] Signal: ${signal.signal} | Confidence: ${signal.confidence}% | Spot: ${signal.bank_nifty}`);
  } catch (err) {
    console.error('Signal refresh job failed:', err);
  }
}

export async function carryForwardJob(): Promise<void> {
  try {
    const data = await getActiveMarketData(true);
    const carryResult = generateCarryForward(data);

    latestCarry = carryResult;

    // Persist to DB
    await prisma.carryForward.create({
      data: {
        date: carryResult.date,
        carry_signal: carryResult.carry_signal,
        bank_nifty_price: carryResult.bank_nifty_price,
        trend: carryResult.trend,
        confidence: carryResult.confidence,
        stop_loss: carryResult.stop_loss,
        target_1: carryResult.target_1,
        target_2: carryResult.target_2,
        reasoning: carryResult.reasoning
      }
    });

    // Broadcast
    const alert = buildCarryForwardAlert(carryResult);
    broadcaster.broadcast(alert);

    console.log(`[Carry Forward] EOD Job complete: ${carryResult.carry_signal}`);
  } catch (err) {
    console.error('Carry forward job failed:', err);
  }
}

export async function stockCandleSeedJob(): Promise<void> {
  try {
    console.log('[Scheduler] Starting daily stock candle seed (7 days)...');
    const results = await seedCandlesForAll(7);
    const total = Object.values(results).reduce((sum, val) => sum + val, 0);
    console.log(`[Scheduler] Daily candle seed complete. Total candles: ${total}`);
  } catch (err) {
    console.error('Daily stock candle seed job failed:', err);
  }
}

export async function stockAnalysisJob(): Promise<void> {
  try {
    console.log('[Scheduler] Starting daily stock profitability analysis...');
    const results = await analyseAllCompanies();
    const profitable = results.filter(r => r.is_profitable).length;
    const highPriority = results.filter(r => r.current_signal === 'BUY' || r.current_signal === 'SELL');

    console.log(`[Scheduler] Daily stock analysis complete. Profitable: ${profitable}, High Priority: ${highPriority.length}`);
  } catch (err) {
    console.error('Daily stock analysis job failed:', err);
  }
}

export function startScheduler(): void {
  console.log('Starting scheduler...');

  // 1. Signal refresh interval (runs every N seconds)
  const intervalMs = settings.signalRefreshSeconds * 1000;
  signalInterval = setInterval(signalRefreshJob, intervalMs);
  console.log(`Registered Signal Refresh interval every ${settings.signalRefreshSeconds}s`);

  // 2. Carry Forward cron (3:15 PM IST, Mon-Fri)
  const [cfH, cfM] = settings.carryForwardTime.split(':');
  const cfCron = `${cfM} ${cfH} * * 1-5`;
  const cfTask = cron.schedule(cfCron, carryForwardJob, {
    timezone: 'Asia/Kolkata'
  });
  scheduledTasks.push(cfTask);
  console.log(`Registered Carry Forward cron: '${cfCron}' (Asia/Kolkata)`);

  // 3. Daily stock candle seed cron (6:00 AM IST, Mon-Fri)
  const seedCron = '0 6 * * 1-5';
  const seedTask = cron.schedule(seedCron, stockCandleSeedJob, {
    timezone: 'Asia/Kolkata'
  });
  scheduledTasks.push(seedTask);
  console.log(`Registered Daily Stock Candle Seed cron: '${seedCron}' (Asia/Kolkata)`);

  // 4. Daily stock analysis cron (6:30 AM IST, Mon-Fri)
  const analysisCron = '30 6 * * 1-5';
  const analysisTask = cron.schedule(analysisCron, stockAnalysisJob, {
    timezone: 'Asia/Kolkata'
  });
  scheduledTasks.push(analysisTask);
  console.log(`Registered Daily Stock Analysis cron: '${analysisCron}' (Asia/Kolkata)`);
}

export function stopScheduler(): void {
  console.log('Stopping scheduler...');
  if (signalInterval) {
    clearInterval(signalInterval);
    signalInterval = null;
  }
  for (const task of scheduledTasks) {
    task.stop();
  }
  scheduledTasks.length = 0;
}
