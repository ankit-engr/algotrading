import { WebSocket } from 'ws';
import { SignalResult } from './signal.js';
import { prisma } from '../db.js';

export class AlertBroadcaster {
  private connections: Set<WebSocket> = new Set();
  public lastTrend: string | null = null;

  public addConnection(ws: WebSocket): void {
    this.connections.add(ws);
    console.log(`WebSocket client connected. Total connections: ${this.connections.size}`);
  }

  public removeConnection(ws: WebSocket): void {
    this.connections.delete(ws);
    console.log(`WebSocket client disconnected. Total connections: ${this.connections.size}`);
  }

  public broadcast(message: any): void {
    if (this.connections.size === 0) return;

    const payload = JSON.stringify(message);
    const dead: WebSocket[] = [];

    for (const ws of this.connections) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
        } else {
          dead.push(ws);
        }
      } catch (err) {
        dead.push(ws);
      }
    }

    if (dead.length > 0) {
      for (const ws of dead) {
        this.connections.delete(ws);
      }
      console.log(`Removed ${dead.length} dead WebSocket connections.`);
    }
  }

  public get connectionCount(): number {
    return this.connections.size;
  }
}

export const broadcaster = new AlertBroadcaster();

// ── Alert Builders ────────────────────────────────────────────────────────────

export function buildSignalAlert(signalResult: SignalResult): any {
  return {
    type: 'ALERT',
    alert_type: signalResult.signal,
    timestamp: new Date().toISOString(),
    data: {
      bank_nifty: signalResult.bank_nifty,
      signal: signalResult.signal,
      trend: signalResult.trend,
      confidence: signalResult.confidence,
      risk_level: signalResult.risk_level,
      stop_loss: signalResult.stop_loss,
      targets: signalResult.targets,
    },
    message: formatSignalMessage(signalResult),
  };
}

export function buildTrendChangeAlert(oldTrend: string, newTrend: string, price: number): any {
  return {
    type: 'ALERT',
    alert_type: 'TREND CHANGE',
    timestamp: new Date().toISOString(),
    data: {
      old_trend: oldTrend,
      new_trend: newTrend,
      bank_nifty: price,
    },
    message: `⚠️ Trend changed from ${oldTrend} → ${newTrend} at Bank Nifty ${price.toFixed(2)}`,
  };
}

export function buildCarryForwardAlert(carryResult: any): any {
  const carrySignal = carryResult.carry_signal || 'EXIT ALL';
  const emojiMap: Record<string, string> = {
    'CARRY CE': '📈',
    'CARRY PE': '📉',
    'PARTIAL CARRY': '⚖️',
    'EXIT ALL': '🚪',
  };
  const emoji = emojiMap[carrySignal] || '🔔';

  return {
    type: 'ALERT',
    alert_type: 'CARRY FORWARD',
    timestamp: new Date().toISOString(),
    data: carryResult,
    message: `${emoji} Carry Forward [${carrySignal}] — Confidence: ${(carryResult.confidence || 0).toFixed(1)}% | Reason: ${carryResult.reasoning || ''}`,
  };
}

export function buildLiveUpdate(signalResult: SignalResult): any {
  return {
    type: 'LIVE_UPDATE',
    timestamp: new Date().toISOString(),
    bank_nifty: signalResult.bank_nifty,
    signal: signalResult.signal,
    trend: signalResult.trend,
    confidence: signalResult.confidence,
    risk_level: signalResult.risk_level,
    market_status: signalResult.market_status,
  };
}

function formatSignalMessage(result: SignalResult): string {
  const emojiMap: Record<string, string> = {
    'BUY CE': '🟢',
    'BUY PE': '🔴',
    'NO TRADE': '⛔',
  };
  const emoji = emojiMap[result.signal] || '🔔';
  let msg = `${emoji} ${result.signal} | Bank Nifty: ${result.bank_nifty.toFixed(2)} | Trend: ${result.trend} | Confidence: ${result.confidence.toFixed(1)}%`;
  
  if (result.stop_loss) {
    msg += ` | SL: ${result.stop_loss.toFixed(2)}`;
  }
  if (result.targets && result.targets.length > 0) {
    msg += ` | T1: ${result.targets[0].toFixed(2)}`;
  }
  return msg;
}

// ── Trend change tracking & Broadcast ─────────────────────────────────────────

export async function checkAndBroadcastSignal(signalResult: SignalResult): Promise<void> {
  // Trend change detection
  if (broadcaster.lastTrend !== null && broadcaster.lastTrend !== signalResult.trend) {
    const alert = buildTrendChangeAlert(
      broadcaster.lastTrend,
      signalResult.trend,
      signalResult.bank_nifty
    );
    broadcaster.broadcast(alert);
    console.log(`Trend change alert broadcast from ${broadcaster.lastTrend} to ${signalResult.trend}`);
  }

  broadcaster.lastTrend = signalResult.trend;

  // BUY CE / BUY PE alerts get a full signal alert
  if (signalResult.signal === 'BUY CE' || signalResult.signal === 'BUY PE') {
    const alert = buildSignalAlert(signalResult);
    broadcaster.broadcast(alert);
  }

  // Always send a live update
  const live = buildLiveUpdate(signalResult);
  broadcaster.broadcast(live);
}

// ── DB Persistence ────────────────────────────────────────────────────────────

export async function persistSignal(result: SignalResult): Promise<void> {
  try {
    const targets = result.targets;
    const cb = result.confidence_breakdown;
    const ai = result.ai_prediction;

    await prisma.signal.create({
      data: {
        timestamp: new Date(result.timestamp),
        bank_nifty_price: result.bank_nifty,
        trend: result.trend,
        signal: result.signal,
        confidence: result.confidence,
        risk_level: result.risk_level,
        stop_loss: result.stop_loss,
        target_1: targets[0] ?? null,
        target_2: targets[1] ?? null,
        target_3: targets[2] ?? null,
        up_probability: ai?.up_probability ?? null,
        down_probability: ai?.down_probability ?? null,
        expected_range: ai?.expected_range ?? null,
        trend_score: cb?.trend_score ?? null,
        volume_score: cb?.volume_score ?? null,
        oi_score: cb?.oi_score ?? null,
        option_chain_score: cb?.option_chain_score ?? null,
        momentum_score: cb?.momentum_score ?? null,
        pcr_score: cb?.pcr_score ?? null,
        vix: result.vix,
        pcr: result.pcr
      }
    });
    console.log(`✓ Signal persisted to DB: ${result.signal}`);
  } catch (err) {
    console.error('Failed to persist signal to DB:', err);
  }
}
