const NIFTY50_SYMBOLS = new Set([
  'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'HINDUNILVR',
  'SBIN', 'BAJFINANCE', 'KOTAKBANK', 'BHARTIARTL', 'LT', 'ASIANPAINT',
  'HCLTECH', 'AXISBANK', 'MARUTI', 'TITAN', 'WIPRO', 'ULTRACEMCO',
  'SUNPHARMA', 'NTPC', 'POWERGRID', 'ADANIENT', 'ADANIPORTS', 'TATAMOTORS',
  'TATASTEEL', 'JSWSTEEL', 'GRASIM', 'NESTLEIND', 'TECHM', 'BPCL',
  'ONGC', 'COALINDIA', 'DIVISLAB', 'DRREDDY', 'BAJAJFINSV', 'HEROMOTOCO',
  'CIPLA', 'EICHERMOT', 'APOLLOHOSP', 'TATACONSUM', 'BRITANNIA', 'HINDALCO',
  'UPL', 'INDUSINDBK', 'SBILIFE', 'BAJAJ-AUTO', 'HDFCLIFE', 'M&M',
  'ITC', 'VEDL',
]);

const BANK_NIFTY_SYMBOLS = new Set([
  'HDFCBANK', 'ICICIBANK', 'KOTAKBANK', 'AXISBANK', 'SBIN', 'INDUSINDBK',
  'BANDHANBNK', 'FEDERALBNK', 'IDFCFIRSTB', 'AUBANK',
]);

function getISTDate(date?: Date): Date {
  const d = date || new Date();
  const utcOffset = d.getTime() + (d.getTimezoneOffset() * 60000);
  return new Date(utcOffset + (3600000 * 5.5));
}

function rsiScore(rsi: number | null): number {
  if (rsi === null || rsi === undefined) {
    return 50.0;
  }
  if (rsi >= 45 && rsi <= 60) {
    return 100.0;
  } else if ((rsi >= 40 && rsi < 45) || (rsi > 60 && rsi <= 65)) {
    return 80.0;
  } else if ((rsi >= 35 && rsi < 40) || (rsi > 65 && rsi <= 70)) {
    return 55.0;
  } else if (rsi < 35) {
    return 40.0;
  } else {
    return 20.0;
  }
}

function emaAlignmentScore(ema9: number | null, ema21: number | null, entryPrice: number | null): number {
  if (ema9 === null || ema21 === null || ema9 === undefined || ema21 === undefined) {
    return 50.0;
  }
  if (ema9 > ema21) {
    if (entryPrice && entryPrice > ema9) {
      return 100.0;
    }
    return 80.0;
  } else if (Math.abs(ema9 - ema21) / Math.max(ema21, 1) < 0.002) {
    return 55.0;
  }
  return 20.0;
}

function sharpeScore(sharpe: number | null): number {
  if (sharpe === null || sharpe === undefined) {
    return 40.0;
  }
  if (sharpe >= 1.5) {
    return 100.0;
  } else if (sharpe >= 1.0) {
    return 80.0;
  } else if (sharpe >= 0.7) {
    return 65.0;
  } else if (sharpe >= 0.4) {
    return 45.0;
  } else if (sharpe >= 0.0) {
    return 25.0;
  }
  return 10.0;
}

function winRateScore(winRate: number): number {
  if (winRate >= 75) {
    return 100.0;
  } else if (winRate >= 65) {
    return 85.0;
  } else if (winRate >= 60) {
    return 70.0;
  } else if (winRate >= 55) {
    return 55.0;
  }
  return 0.0;
}

function drawdownSafetyScore(maxDrawdown: number): number {
  if (maxDrawdown <= 5) {
    return 100.0;
  } else if (maxDrawdown <= 10) {
    return 85.0;
  } else if (maxDrawdown <= 15) {
    return 65.0;
  } else if (maxDrawdown <= 20) {
    return 45.0;
  } else if (maxDrawdown <= 30) {
    return 25.0;
  }
  return 10.0;
}

export function computeInvestScore(
  rsi: number | null,
  ema9: number | null,
  ema21: number | null,
  entryPrice: number | null,
  sharpe: number | null,
  winRate: number,
  maxDrawdown: number
): number {
  const score =
    rsiScore(rsi) * 0.20 +
    emaAlignmentScore(ema9, ema21, entryPrice) * 0.20 +
    sharpeScore(sharpe) * 0.20 +
    winRateScore(winRate) * 0.20 +
    drawdownSafetyScore(maxDrawdown) * 0.20;

  return parseFloat(score.toFixed(1));
}

export function getRiskGrade(investScore: number, maxDrawdown: number, sharpe: number | null): string {
  const sharpeVal = sharpe || 0.0;
  if (investScore >= 72 && maxDrawdown <= 15 && sharpeVal >= 0.7) {
    return 'A';
  } else if (investScore >= 52 && maxDrawdown <= 25) {
    return 'B';
  }
  return 'C';
}

function lastThursdayOfMonth(year: number, month: number): Date {
  // JS month is 0-indexed (0=Jan, 11=Dec).
  // Next month day 0 gets the last day of month.
  const lastDay = new Date(year, month + 1, 0);
  const day = lastDay.getDay(); // 0=Sunday, 4=Thursday
  const offset = (day - 4 + 7) % 7;
  lastDay.setDate(lastDay.getDate() - offset);
  return lastDay;
}

function nextThursday(fromDate: Date): Date {
  const result = new Date(fromDate.getTime());
  const day = result.getDay();
  const daysAhead = (4 - day + 7) % 7;
  result.setDate(result.getDate() + daysAhead);
  return result;
}

export interface ExpiryContext {
  is_monthly_expiry_week: boolean;
  is_weekly_expiry_day: boolean;
  days_to_monthly_expiry: number;
  days_to_weekly_expiry: number;
  monthly_expiry_date: string;
  weekly_expiry_date: string;
  expiry_warning: string;
}

export function getFoExpiryContext(nowDate?: Date): ExpiryContext {
  const istDate = getISTDate(nowDate);
  const year = istDate.getFullYear();
  const month = istDate.getMonth(); // 0-indexed

  const monthlyExpiry = lastThursdayOfMonth(year, month);
  
  // Set times to midnight to calculate correct difference in days
  const todayReset = new Date(istDate.getFullYear(), istDate.getMonth(), istDate.getDate());
  const monthlyReset = new Date(monthlyExpiry.getFullYear(), monthlyExpiry.getMonth(), monthlyExpiry.getDate());

  let daysToMonthly = Math.round((monthlyReset.getTime() - todayReset.getTime()) / (24 * 60 * 60 * 1000));
  
  // If monthly expiry has passed this month, compute next month's expiry
  if (daysToMonthly < 0) {
    const nextMonthlyExpiry = lastThursdayOfMonth(year, month + 1);
    const nextMonthlyReset = new Date(nextMonthlyExpiry.getFullYear(), nextMonthlyExpiry.getMonth(), nextMonthlyExpiry.getDate());
    daysToMonthly = Math.round((nextMonthlyReset.getTime() - todayReset.getTime()) / (24 * 60 * 60 * 1000));
  }

  const weeklyNext = nextThursday(todayReset);
  const daysToWeekly = Math.round((weeklyNext.getTime() - todayReset.getTime()) / (24 * 60 * 60 * 1000));

  const isMonthlyWeek = daysToMonthly >= 0 && daysToMonthly <= 3;
  const isWeeklyDay = istDate.getDay() === 3; // Thursday is day 4 in python, but in JS 0=Sunday, 3=Wednesday, 4=Thursday?
  // Wait! In Python, ts.weekday() returns 0=Monday, ..., 3=Thursday.
  // In JS, getDay() returns 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday.
  // So isWeeklyDay in JS should check: getDay() === 4 !
  const isWeeklyDayJS = istDate.getDay() === 4;

  let warning = '';
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  
  const formatDateStr = (d: Date) => {
    return `${d.getDate().toString().padStart(2, '0')} ${monthNames[d.getMonth()]}`;
  };

  const formatDateFull = (d: Date) => {
    return `${d.getDate().toString().padStart(2, '0')} ${monthNames[d.getMonth()]} ${d.getFullYear()}`;
  };

  if (isWeeklyDayJS) {
    warning = '⚠️ TODAY is weekly F&O expiry — expect high volatility. Reduce position size by 30%.';
  } else if (isMonthlyWeek) {
    warning = `⚠️ Monthly F&O expiry in ${daysToMonthly} day(s) (Thu ${formatDateStr(monthlyExpiry)}) — reduce position size, tighten stop-loss.`;
  } else if (daysToWeekly === 1) {
    warning = `ℹ️ Weekly F&O expiry tomorrow (${formatDateStr(weeklyNext)}) — watch for end-of-day volatility.`;
  } else {
    warning = `✅ No F&O expiry pressure this week. Next weekly expiry: ${formatDateStr(weeklyNext)}.`;
  }

  return {
    is_monthly_expiry_week: isMonthlyWeek,
    is_weekly_expiry_day: isWeeklyDayJS,
    days_to_monthly_expiry: daysToMonthly,
    days_to_weekly_expiry: daysToWeekly,
    monthly_expiry_date: formatDateFull(monthlyExpiry),
    weekly_expiry_date: formatDateFull(weeklyNext),
    expiry_warning: warning,
  };
}

export function getHoldingType(sharpe: number | null, winRate: number, investScore: number): 'SWING' | 'INTRADAY' {
  const sharpeVal = sharpe || 0.0;
  if (sharpeVal >= 0.8 && winRate >= 62 && investScore >= 65) {
    return 'SWING';
  }
  return 'INTRADAY';
}

export interface ExitTiming {
  holding_type: 'SWING' | 'INTRADAY';
  holding_duration: string;
  entry_window: string;
  recommended_exit: string;
  avoid_after: string;
  fo_expiry_warning: string;
  notes: string[];
}

export function getExitTiming(holdingType: 'SWING' | 'INTRADAY', foContext: ExpiryContext, investScore: number): ExitTiming {
  const foExpiry = foContext.is_monthly_expiry_week || foContext.is_weekly_expiry_day;
  const notes: string[] = [];
  let entryWindow = '';
  let exitWindow = '';
  let avoidAfter = '';
  let holdingDuration = '';

  if (holdingType === 'INTRADAY') {
    entryWindow = '09:30 AM – 10:30 AM IST';
    exitWindow = '01:00 PM – 02:30 PM IST';
    avoidAfter = '02:45 PM IST';
    holdingDuration = 'Same day';
    notes.push(
      'Enter after 09:30 AM — skip opening volatility auction window',
      'Best momentum window: 09:30–11:30 AM and 01:00–02:30 PM IST',
      'Exit ALL positions before 02:45 PM to avoid pre-close volatility',
      'Never hold intraday positions past 03:00 PM IST'
    );
  } else {
    entryWindow = '09:30 AM – 11:00 AM IST (Day 1)';
    exitWindow = '10:00 AM – 12:00 PM IST (Day 2–5)';
    avoidAfter = 'EMA9 crosses below EMA21 on daily chart';
    holdingDuration = '2–5 trading days';
    notes.push(
      'Enter on Day 1 morning after price confirms above EMA9',
      'Review position each morning at 09:30 AM IST',
      'Exit if daily RSI crosses above 72 (overbought exit)',
      'Exit if EMA9 crosses below EMA21 on daily chart',
      'Trail stop-loss to previous day\'s low after each profitable day'
    );
  }

  if (foExpiry) {
    notes.push('⚠️ F&O expiry week — reduce position size by 30%, keep tight stop-loss');
    if (holdingType === 'SWING') {
      notes.push('Consider converting swing to intraday during expiry week');
    }
  }

  notes.push('Check NSE circuit limits before entry — price bands refresh at 09:00 AM and 01:45 PM IST');
  notes.push('SEBI intraday margin: typically 5× leverage. Delivery = full capital. Plan accordingly.');

  return {
    holding_type: holdingType,
    holding_duration: holdingDuration,
    entry_window: entryWindow,
    recommended_exit: exitWindow,
    avoid_after: avoidAfter,
    fo_expiry_warning: foContext.expiry_warning,
    notes
  };
}

export function getCircuitLimitNote(symbol: string): string {
  const sym = symbol.toUpperCase().trim();
  if (NIFTY50_SYMBOLS.has(sym)) {
    return `${sym} is a Nifty 50 constituent — standard 20% price band applies.`;
  }
  if (BANK_NIFTY_SYMBOLS.has(sym)) {
    return `${sym} is in Bank Nifty — standard 20% price band applies.`;
  }
  return `${sym} — price band is 5%, 10%, or 20% as assigned by NSE. Verify on nseindia.com before trading.`;
}

export function calculateTradePlan(
  symbol: string,
  amountInr: number,
  entryPrice: number,
  stopLoss: number | null,
  target1: number | null,
  target2: number | null,
  investScore: number,
  sharpe: number | null,
  winRate: number,
  maxDrawdown: number,
  rsiVal: number | null,
  ema9Val: number | null,
  ema21Val: number | null,
  nowDate?: Date
): any {
  const quantity = Math.max(1, Math.floor(amountInr / entryPrice));
  const invested = parseFloat((quantity * entryPrice).toFixed(2));
  const leftoverCash = parseFloat((amountInr - invested).toFixed(2));

  const slPrice = stopLoss ?? parseFloat((entryPrice * 0.95).toFixed(2));
  const lossPerShare = parseFloat((entryPrice - slPrice).toFixed(2));
  const lossInr = parseFloat((lossPerShare * quantity).toFixed(2));
  const lossPct = parseFloat(((lossPerShare / entryPrice) * 100).toFixed(2));

  const t1Price = target1 ?? parseFloat((entryPrice * 1.05).toFixed(2));
  const gainT1Per = parseFloat((t1Price - entryPrice).toFixed(2));
  const gainT1Inr = parseFloat((gainT1Per * quantity).toFixed(2));
  const gainT1Pct = parseFloat(((gainT1Per / entryPrice) * 100).toFixed(2));

  const t2Price = target2 ?? parseFloat((entryPrice * 1.08).toFixed(2));
  const gainT2Per = parseFloat((t2Price - entryPrice).toFixed(2));
  const gainT2Inr = parseFloat((gainT2Per * quantity).toFixed(2));
  const gainT2Pct = parseFloat(((gainT2Per / entryPrice) * 100).toFixed(2));

  const rrRatio = lossInr > 0 ? parseFloat((gainT1Inr / lossInr).toFixed(2)) : 0.0;

  const brokerageIntraday = 40.0;
  const brokerageDelivery = parseFloat((invested * 0.001).toFixed(2));

  const foContext = getFoExpiryContext(nowDate);
  const holdingType = getHoldingType(sharpe, winRate, investScore);
  const exitTiming = getExitTiming(holdingType, foContext, investScore);

  const circuitNote = getCircuitLimitNote(symbol);
  const marketNotes = [
    'NSE pre-open session ends 09:15 AM IST — place orders only after 09:15 AM',
    circuitNote,
    `Estimated brokerage (intraday): ₹${brokerageIntraday.toFixed(0)} | Delivery: ₹${brokerageDelivery.toFixed(0)}`,
    'SEBI mandates T+1 settlement for equity delivery (funds credited next trading day)'
  ];

  if (foContext.is_monthly_expiry_week) {
    marketNotes.unshift(`⚠️ Monthly F&O expiry week — ${foContext.expiry_warning}`);
  }
  if (rsiVal && rsiVal > 68) {
    marketNotes.push(`RSI is ${rsiVal.toFixed(1)} — stock may be nearing overbought zone; consider smaller position`);
  }

  return {
    symbol: symbol.toUpperCase(),
    entry_price: entryPrice,
    quantity: quantity,
    invested_amount: invested,
    leftover_cash: leftoverCash,
    profit_at_t1: {
      price: t1Price,
      gain_per_share: gainT1Per,
      gain_inr: gainT1Inr,
      gain_pct: gainT1Pct,
    },
    profit_at_t2: {
      price: t2Price,
      gain_per_share: gainT2Per,
      gain_inr: gainT2Inr,
      gain_pct: gainT2Pct,
    },
    loss_at_sl: {
      price: slPrice,
      loss_per_share: lossPerShare,
      loss_inr: lossInr,
      loss_pct: lossPct,
    },
    risk_reward_ratio: rrRatio,
    profit_probability: investScore,
    exit_timing: exitTiming,
    fo_expiry_context: foContext,
    indian_market_notes: marketNotes,
    brokerage_estimate: {
      intraday_inr: brokerageIntraday,
      delivery_inr: brokerageDelivery
    }
  };
}
