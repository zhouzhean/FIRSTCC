/**
 * Strategy Health Engine v3.0
 *
 * Computes comprehensive strategy performance metrics from simfolio data.
 * Answers: "Does the strategy actually work? What are the weak points?"
 *
 * Pure computation module — reads simfolio data, returns health report.
 * No side effects, no file writes.
 */

const simfolio = require('../simfolio');
const path = require('path');
const fs = require('fs');

// ---- Helpers ----

function safeNum(v, fallback) {
  if (v == null || typeof v !== 'number' || isNaN(v)) return fallback != null ? fallback : 0;
  return v;
}

function safeFixed(value, decimals, fallback) {
  if (fallback === undefined) fallback = '?';
  if (value == null || typeof value !== 'number' || isNaN(value)) return fallback;
  return value.toFixed(decimals);
}

function mathRound(v, decimals) {
  decimals = decimals || 2;
  return Math.round(v * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

// ---- Master Entry Point ----

/**
 * Compute full strategy health report
 * @param {Object} options - { lookbackDays: 60 }
 * @returns {Object} StrategyHealthReport
 */
function computeStrategyHealth(options) {
  options = options || {};
  const lookbackDays = options.lookbackDays || 60;

  const pf = simfolio.loadPortfolio();
  const snapshot = simfolio.getSnapshot(pf);
  const stats = simfolio.computeStats(pf);

  // 1. NAV curve + benchmark
  const navCurve = computeNavCurve(pf.dailyNav);

  // 2. Drawdown curve
  const drawdownCurve = computeDrawdownCurve(pf.dailyNav);

  // 3. Risk metrics (Sharpe, Sortino, Calmar)
  const riskMetrics = computeRiskMetrics(pf.dailyNav);

  // 4. Trade statistics
  const tradeStats = computeTradeStats(pf.tradeHistory, pf.dailyNav);

  // 5. Monthly heatmap
  const monthlyHeatmap = computeMonthlyHeatmap(pf.dailyNav);

  // 6. Rolling alpha
  const rollingAlpha = computeRollingAlpha(pf.dailyNav, 20);

  // 7. Last N trades attribution summary
  const lastNTrades = pf.tradeHistory.slice(-lookbackDays > 0 ? -Math.min(lookbackDays, pf.tradeHistory.length) : -20);
  const attributionSummary = computeAttributionSummary(pf.tradeHistory);

  // 8. Master control judgment
  const masterControl = computeMasterControlJudgment({
    stats: stats,
    riskMetrics: riskMetrics,
    tradeStats: tradeStats,
    pf: pf,
    snapshot: snapshot,
    attributionSummary: attributionSummary,
  });

  return {
    date: new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    navCurve: navCurve,
    drawdownCurve: drawdownCurve,
    riskMetrics: riskMetrics,
    tradeStats: tradeStats,
    monthlyHeatmap: monthlyHeatmap,
    rollingAlpha: rollingAlpha,
    attributionSummary: attributionSummary,
    masterControl: masterControl,
  };
}

/**
 * Lightweight summary for homepage top bar / polling
 */
function computeHealthSummary() {
  const full = computeStrategyHealth({ lookbackDays: 20 });
  return {
    date: full.date,
    masterControl: full.masterControl,
    topStats: {
      totalReturn: full.riskMetrics.totalReturn,
      maxDrawdown: full.riskMetrics.maxDrawdown,
      sharpeRatio: full.riskMetrics.sharpeRatio,
      winRate: full.tradeStats.winRate,
      profitFactor: full.tradeStats.profitFactor,
    },
  };
}

// ---- NAV Curve ----

function computeNavCurve(dailyNav) {
  if (!dailyNav || dailyNav.length === 0) {
    return { dates: [], portfolioValues: [], benchmarkValues: [] };
  }
  const dates = [];
  const portfolioValues = [];
  const benchmarkValues = [];

  for (const n of dailyNav) {
    dates.push(n.date);
    portfolioValues.push(mathRound(n.nav, 2));
    // Benchmark is stored as cumulative return % — convert to normalized value (100 = start)
    const benchReturn = safeNum(n.benchmarkReturn, 0);
    const benchValue = mathRound(100000 * (1 + benchReturn / 100), 2);
    benchmarkValues.push(benchValue);
  }

  return { dates, portfolioValues, benchmarkValues };
}

// ---- Drawdown Curve ----

function computeDrawdownCurve(dailyNav) {
  if (!dailyNav || dailyNav.length < 2) {
    return { dates: [], drawdowns: [], maxDrawdown: 0, currentDrawdown: 0 };
  }

  const dates = [];
  const drawdowns = [];
  let peak = dailyNav[0].nav;
  let maxDD = 0;

  for (const n of dailyNav) {
    if (n.nav > peak) peak = n.nav;
    const dd = mathRound((n.nav - peak) / peak * 100, 2);
    if (dd < maxDD) maxDD = dd;
    dates.push(n.date);
    drawdowns.push(dd);
  }

  const currentDD = drawdowns.length > 0 ? drawdowns[drawdowns.length - 1] : 0;

  return {
    dates: dates,
    drawdowns: drawdowns,
    maxDrawdown: mathRound(maxDD, 2),
    currentDrawdown: mathRound(currentDD, 2),
  };
}

// ---- Risk Metrics (Sharpe, Sortino, Calmar) ----

function computeRiskMetrics(dailyNav) {
  if (!dailyNav || dailyNav.length < 3) {
    return {
      totalReturn: 0, annualizedReturn: 0,
      sharpeRatio: null, sortinoRatio: null, calmarRatio: null,
      annualizedVolatility: 0, downsideVolatility: 0,
      maxDrawdown: 0, maxDrawdownDuration: 0,
      positiveDays: 0, negativeDays: 0, positiveDayRatio: 0,
    };
  }

  // Daily returns
  const dailyReturns = [];
  let positiveDays = 0, negativeDays = 0;
  for (let i = 1; i < dailyNav.length; i++) {
    const r = (dailyNav[i].nav - dailyNav[i - 1].nav) / dailyNav[i - 1].nav;
    dailyReturns.push(r);
    if (r > 0) positiveDays++;
    else if (r < 0) negativeDays++;
  }

  const totalReturn = dailyNav[dailyNav.length - 1].return_;
  const tradingDays = dailyNav.length;

  // Annualized return — only compute with >= 20 data points (avoid extreme extrapolation)
  let annualizedReturn = null;
  if (tradingDays >= 20) {
    const calendarDays = tradingDays * 365 / 252;
    const totalReturnDecimal = totalReturn / 100;
    annualizedReturn = mathRound(Math.pow(1 + totalReturnDecimal, 365 / calendarDays) - 1, 4);
  }

  // Annualized volatility (daily std * sqrt(252))
  const avgReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / dailyReturns.length;
  const stdDev = Math.sqrt(variance);
  const annualizedVol = mathRound(stdDev * Math.sqrt(252), 4);

  // Sharpe ratio — only meaningful with >= 20 data points and positive vol
  const riskFreeRate = 0.02;
  let sharpeRatio = null;
  if (annualizedReturn !== null && annualizedVol > 0 && tradingDays >= 20) {
    sharpeRatio = mathRound((annualizedReturn - riskFreeRate) / annualizedVol, 2);
  }

  // Sortino ratio — only meaningful with enough downside data
  const downReturns = dailyReturns.filter(r => r < 0);
  const downVariance = downReturns.length > 1
    ? downReturns.reduce((s, r) => s + r ** 2, 0) / (downReturns.length - 1)
    : 0;
  const downsideDev = Math.sqrt(downVariance);
  const downsideVol = mathRound(downsideDev * Math.sqrt(252), 4);
  let sortinoRatio = null;
  if (annualizedReturn !== null && downsideVol > 0 && tradingDays >= 20) {
    sortinoRatio = mathRound((annualizedReturn - riskFreeRate) / downsideVol, 2);
  }

  // Calmar ratio — only with enough data
  const drawdownCurve = computeDrawdownCurve(dailyNav);
  const maxDrawdown = drawdownCurve.maxDrawdown;
  const maxDrawdownDuration = computeMaxDrawdownDuration(dailyNav);
  let calmarRatio = null;
  if (annualizedReturn !== null && maxDrawdown < 0 && tradingDays >= 20) {
    calmarRatio = mathRound(annualizedReturn / Math.abs(maxDrawdown / 100), 2);
  }

  return {
    totalReturn: mathRound(totalReturn, 2),
    annualizedReturn: mathRound(annualizedReturn * 100, 2),
    sharpeRatio: sharpeRatio,
    sortinoRatio: sortinoRatio,
    calmarRatio: calmarRatio,
    annualizedVolatility: mathRound(annualizedVol * 100, 2),
    downsideVolatility: mathRound(downsideVol * 100, 2),
    maxDrawdown: maxDrawdown,
    maxDrawdownDuration: maxDrawdownDuration,
    positiveDays: positiveDays,
    negativeDays: negativeDays,
    positiveDayRatio: dailyReturns.length > 0 ? mathRound(positiveDays / dailyReturns.length * 100, 1) : 0,
  };
}

function computeMaxDrawdownDuration(dailyNav) {
  if (!dailyNav || dailyNav.length < 2) return 0;

  let maxDuration = 0;
  let currentDuration = 0;
  let peak = dailyNav[0].nav;

  for (let i = 1; i < dailyNav.length; i++) {
    if (dailyNav[i].nav >= peak) {
      peak = dailyNav[i].nav;
      currentDuration = 0;
    } else {
      currentDuration++;
      if (currentDuration > maxDuration) maxDuration = currentDuration;
    }
  }

  return maxDuration;
}

// ---- Trade Statistics ----

function computeTradeStats(tradeHistory, dailyNav) {
  const sells = tradeHistory.filter(t => t.action === 'sell');
  const buys = tradeHistory.filter(t => t.action === 'buy');

  if (sells.length === 0) {
    return {
      totalTrades: 0, totalBuys: buys.length, totalSells: 0,
      winRate: null, profitFactor: null,
      avgWin: 0, avgLoss: 0, avgWinLossRatio: null,
      winningTrades: 0, losingTrades: 0,
      bestTrade: null, worstTrade: null,
      totalCommission: 0, totalStampTax: 0, totalTransferFee: 0,
      turnoverRate: 0,
    };
  }

  const wins = sells.filter(t => (t.pnl || 0) > 0);
  const losses = sells.filter(t => (t.pnl || 0) <= 0);
  const winRate = sells.length > 0 ? mathRound(wins.length / sells.length * 100, 1) : null;

  // Profit factor
  const totalWinAmount = wins.reduce((s, t) => s + safeNum(t.pnl, 0), 0);
  const totalLossAmount = Math.abs(losses.reduce((s, t) => s + safeNum(t.pnl, 0), 0));
  const profitFactor = totalLossAmount > 0 ? mathRound(totalWinAmount / totalLossAmount, 2) : (totalWinAmount > 0 ? null : 0);

  // Avg win/loss
  const avgWin = wins.length > 0 ? mathRound(totalWinAmount / wins.length, 2) : 0;
  const avgLoss = losses.length > 0 ? mathRound(Math.abs(losses.reduce((s, t) => s + safeNum(t.pnl, 0), 0)) / losses.length, 2) : 0;
  const avgWinLossRatio = avgLoss > 0 ? mathRound(avgWin / avgLoss, 2) : null;

  // Best/worst trade
  const sortedByPnL = [...sells].sort((a, b) => safeNum(a.pnl, 0) - safeNum(b.pnl, 0));
  const bestTrade = sells.length > 0 ? sortedByPnL[sortedByPnL.length - 1] : null;
  const worstTrade = sells.length > 0 ? sortedByPnL[0] : null;

  // Fee breakdown — use actual costs from trade records when available, fallback to estimate
  let totalCommission = 0, totalStampTax = 0, totalTransferFee = 0;
  let hasActualCosts = false;

  for (const t of sells) {
    if (t.costs && typeof t.costs.commission === 'number') {
      totalCommission += safeNum(t.costs.commission, 0);
      totalStampTax += safeNum(t.costs.stampTax, 0);
      totalTransferFee += safeNum(t.costs.transferFee, 0);
      hasActualCosts = true;
    }
  }
  for (const t of buys) {
    if (t.costs && typeof t.costs.commission === 'number') {
      totalCommission += safeNum(t.costs.commission, 0);
      totalTransferFee += safeNum(t.costs.transferFee, 0);
    }
  }

  // Fallback: estimate fees if no actual costs recorded
  if (!hasActualCosts) {
    totalCommission = 0; totalStampTax = 0; totalTransferFee = 0;
    for (const t of sells) {
      const amount = safeNum(t.amount, 0);
      totalStampTax += mathRound(amount * 0.001, 2);
      totalCommission += mathRound(amount * 0.00025 * 2, 2);
      totalTransferFee += mathRound(amount * 0.00001 * 2, 2);
    }
    for (const t of buys) {
      const amount = safeNum(t.amount, 0);
      totalCommission += mathRound(amount * 0.00025, 2);
      totalTransferFee += mathRound(amount * 0.00001, 2);
    }
  }

  // Turnover rate: total buy amount / average NAV
  let turnoverRate = 0;
  if (dailyNav && dailyNav.length > 0) {
    const avgNav = dailyNav.reduce((s, n) => s + n.nav, 0) / dailyNav.length;
    const totalBuyAmount = buys.reduce((s, t) => s + safeNum(t.amount, 0), 0);
    if (avgNav > 0) turnoverRate = mathRound(totalBuyAmount / avgNav, 2);
  }

  return {
    totalTrades: sells.length,
    totalBuys: buys.length,
    totalSells: sells.length,
    winRate: winRate,
    profitFactor: profitFactor,
    avgWin: avgWin,
    avgLoss: avgLoss,
    avgWinLossRatio: avgWinLossRatio,
    winningTrades: wins.length,
    losingTrades: losses.length,
    bestTrade: bestTrade ? { code: bestTrade.code, name: bestTrade.name, pnl: bestTrade.pnl, pnlPct: bestTrade.pnlPct } : null,
    worstTrade: worstTrade ? { code: worstTrade.code, name: worstTrade.name, pnl: worstTrade.pnl, pnlPct: worstTrade.pnlPct } : null,
    totalCommission: totalCommission,
    totalStampTax: totalStampTax,
    totalTransferFee: totalTransferFee,
    totalCosts: mathRound(totalCommission + totalStampTax + totalTransferFee, 2),
    turnoverRate: turnoverRate,
  };
}

// ---- Attribution Summary ----

function computeAttributionSummary(tradeHistory) {
  const sells = tradeHistory.filter(t => t.action === 'sell');
  const last20 = sells.slice(-20);

  // Count stop-loss reasons
  const stopLossCount = last20.filter(t => (t.triggeredBy || '').includes('stop_loss')).length;
  const trailingStopCount = last20.filter(t => (t.triggeredBy || '').includes('trailing_stop')).length;
  const softStopCount = last20.filter(t => (t.triggeredBy || '').includes('soft')).length;
  const takeProfitCount = last20.filter(t => (t.triggeredBy || '').includes('take_profit')).length;

  // Sector performance
  const sectorMap = {};
  for (const t of last20) {
    const sector = guessSector(t.name || '');
    if (!sectorMap[sector]) sectorMap[sector] = { sector, wins: 0, losses: 0, netPnl: 0, trades: [], count: 0 };
    sectorMap[sector].count++;
    if ((t.pnl || 0) > 0) sectorMap[sector].wins++;
    else sectorMap[sector].losses++;
    sectorMap[sector].netPnl = mathRound(sectorMap[sector].netPnl + safeNum(t.pnl, 0), 2);
    sectorMap[sector].trades.push({ code: t.code, name: t.name, pnl: t.pnl, pnlPct: t.pnlPct, reason: t.triggeredBy });
  }
  const sectorPerf = Object.values(sectorMap).sort((a, b) => b.netPnl - a.netPnl);

  // Exit reason breakdown
  const reasonBreakdown = {
    stopLoss: stopLossCount,
    trailingStop: trailingStopCount,
    softStop: softStopCount,
    takeProfit: takeProfitCount,
    other: last20.length - stopLossCount - trailingStopCount - softStopCount - takeProfitCount,
  };

  // Consecutive losses
  let consecutiveLosses = 0;
  let maxConsecutiveLosses = 0;
  for (let i = last20.length - 1; i >= 0; i--) {
    if ((last20[i].pnl || 0) <= 0) {
      consecutiveLosses++;
      if (consecutiveLosses > maxConsecutiveLosses) maxConsecutiveLosses = consecutiveLosses;
    } else {
      consecutiveLosses = 0;
    }
  }

  return {
    totalAttributed: last20.length,
    reasonBreakdown: reasonBreakdown,
    sectorPerformance: sectorPerf,
    consecutiveLosses: consecutiveLosses,
    maxConsecutiveLosses: maxConsecutiveLosses,
    recentTrades: last20.map(t => ({
      date: t.date, code: t.code, name: t.name,
      action: t.action, pnl: t.pnl, pnlPct: t.pnlPct,
      reason: t.triggeredBy, detail: (t.reason || '').slice(0, 80),
    })),
  };
}

// Simple name-based sector guess (same pattern as config/simfolio)
function guessSector(stockName) {
  if (!stockName) return '其他';
  if (stockName.includes('电') || stockName.includes('能')) return '电力/能源';
  if (stockName.includes('铝') || stockName.includes('铜') || stockName.includes('稀土') || stockName.includes('有色')) return '有色金属/稀土';
  if (stockName.includes('药') || stockName.includes('医') || stockName.includes('生物')) return '医药/医疗';
  if (stockName.includes('证券') || stockName.includes('银行') || stockName.includes('保险')) return '金融';
  if (stockName.includes('半导') || stockName.includes('芯片') || stockName.includes('电子') || stockName.includes('光电')) return '半导体/电子';
  if (stockName.includes('机器人') || stockName.includes('智能') || stockName.includes('自动')) return '机器人/AI';
  if (stockName.includes('军工') || stockName.includes('航天') || stockName.includes('航空')) return '军工/航天';
  if (stockName.includes('汽车') || stockName.includes('车')) return '汽车';
  if (stockName.includes('化工') || stockName.includes('化')) return '化工';
  if (stockName.includes('铁') || stockName.includes('钢') || stockName.includes('建') || stockName.includes('工')) return '基建/钢铁';
  return '其他';
}

// ---- Rolling Alpha ----

function computeRollingAlpha(dailyNav, windowDays) {
  windowDays = windowDays || 20;
  if (!dailyNav || dailyNav.length < 3) {
    return { windows: [], alphas: [], labels: [] };
  }

  const windows = [];
  const alphas = [];
  const labels = [];

  for (let i = windowDays; i < dailyNav.length; i++) {
    const startIdx = i - windowDays;
    const portfolioReturn = dailyNav[i].return_ - dailyNav[startIdx].return_;
    const benchmarkReturn = safeNum(dailyNav[i].benchmarkReturn, 0) - safeNum(dailyNav[startIdx].benchmarkReturn, 0);
    const alpha = mathRound(portfolioReturn - benchmarkReturn, 2);

    windows.push(windowDays);
    alphas.push(alpha);
    labels.push(dailyNav[i].date);
  }

  return { windows, alphas, labels };
}

// ---- Monthly Heatmap ----

function computeMonthlyHeatmap(dailyNav) {
  if (!dailyNav || dailyNav.length < 2) {
    return { months: [], years: [], matrix: [] };
  }

  // Group NAV data by month
  const monthData = {};
  let allYears = new Set();

  for (let i = 1; i < dailyNav.length; i++) {
    const date = dailyNav[i].date;
    const parts = date.split('-');
    const year = parseInt(parts[0]);
    const month = parseInt(parts[1]);
    const key = year + '-' + (month < 10 ? '0' + month : month);

    allYears.add(year);

    if (!monthData[key]) {
      monthData[key] = { year, month: month - 1, startNav: dailyNav[i - 1].nav, endNav: dailyNav[i].nav, startReturn: dailyNav[i - 1].return_, endReturn: dailyNav[i].return_ };
    }
    monthData[key].endNav = dailyNav[i].nav;
    monthData[key].endReturn = dailyNav[i].return_;
  }

  // Compute monthly return
  const entries = Object.values(monthData).map(m => ({
    year: m.year,
    month: m.month,
    monthlyReturn: mathRound(m.endReturn - m.startReturn, 2),
    absReturn: mathRound(m.endNav - m.startNav, 2),
  }));

  const yearsArr = Array.from(allYears).sort();
  const monthsArr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const monthLabels = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

  // Build matrix: years x months
  const matrix = [];
  for (const year of yearsArr) {
    const row = [];
    for (const month of monthsArr) {
      const found = entries.find(e => e.year === year && e.month === month);
      row.push(found ? found.monthlyReturn : null);
    }
    matrix.push({ year: year, returns: row });
  }

  return { months: monthLabels, years: yearsArr, matrix: matrix };
}

// ===== MASTER CONTROL JUDGMENT =====

/**
 * Synthesizes all available data into a single trading control verdict.
 *
 * Verdicts (aligned with simfolio gate chain):
 *   ALLOW    — Conditions normal, trading permitted
 *   CAUTIOUS — Some concerns, but trading allowed with reduced size + raised threshold
 *   REDUCE   — Material concerns, only selling / reduce-only allowed (matches simfolio drawdown restrict)
 *   BLOCK    — Serious issues, all new buys blocked (matches simfolio halt + circuit breaker)
 *
 * KEY DESIGN PRINCIPLE: The verdict should align with what the simfolio gates
 * would actually do. If thinkTankGate is defensive (score >= 3) or drawdown
 * is at restrict level, this should show REDUCE or BLOCK — not CAUTIOUS.
 *
 * This is stricter than v3.0 original because it uses CASCADING compound checks:
 * individual flags like -6% drawdown alone → CAUTIOUS, but -6% drawdown
 * + 0% win rate + 4 consecutive losses + 0 profit factor together → BLOCK.
 */
function computeMasterControlJudgment(context) {
  const reasons = [];
  const recoveryConditions = [];
  let worstVerdict = 0; // 0=ALLOW, 1=CAUTIOUS, 2=REDUCE, 3=BLOCK

  const stats = context.stats || {};
  const riskMetrics = context.riskMetrics || {};
  const tradeStats = context.tradeStats || {};
  const snapshot = context.snapshot || {};
  const pf = context.pf || {};

  // ── Individual dimension checks ──

  // 1. Drawdown
  const maxDD = safeNum(riskMetrics.maxDrawdown, 0);
  let ddSeverity = 0; // 0=none, 1=warn, 2=restrict, 3=halt
  if (maxDD <= -10) {
    reasons.push('最大回撤超10%：' + maxDD + '%');
    recoveryConditions.push('回撤修复到-5%以内持续5个交易日');
    ddSeverity = 3;
  } else if (maxDD <= -8) {
    reasons.push('最大回撤超8%：' + maxDD + '%');
    recoveryConditions.push('回撤修复到-5%以内');
    ddSeverity = 2;
  } else if (maxDD <= -5) {
    reasons.push('最大回撤超5%：' + maxDD + '%');
    recoveryConditions.push('回撤收窄至-3%以内');
    ddSeverity = 1;
  }

  // 2. Sharpe ratio
  let sharpeSeverity = 0;
  if (riskMetrics.sharpeRatio !== null && riskMetrics.sharpeRatio < -1.0) {
    reasons.push('Sharpe比率严重为负：' + riskMetrics.sharpeRatio);
    recoveryConditions.push('Sharpe比率回升至0以上');
    sharpeSeverity = 2;
  } else if (riskMetrics.sharpeRatio !== null && riskMetrics.sharpeRatio < 0) {
    reasons.push('Sharpe比率为负：' + riskMetrics.sharpeRatio);
    sharpeSeverity = 1;
  }

  // 3. Win rate — lower bar: check at 3+ trades, not 5+
  let winRateSeverity = 0;
  const hasMinTrades = tradeStats.totalTrades >= 3;
  const hasAdequateSample = tradeStats.totalTrades >= 5;
  if (tradeStats.winRate !== null && hasMinTrades) {
    if (tradeStats.winRate === 0) {
      reasons.push('胜率0%：' + tradeStats.totalTrades + '笔交易全部亏损');
      recoveryConditions.push('出现连续2笔盈利交易');
      winRateSeverity = 3; // Zero win rate with any trades → BLOCK
    } else if (tradeStats.winRate < 25 && hasAdequateSample) {
      reasons.push('胜率极低：' + tradeStats.winRate + '% (' + tradeStats.totalTrades + '笔)');
      recoveryConditions.push('最近10笔交易胜率回升至40%以上');
      winRateSeverity = 2;
    } else if (tradeStats.winRate < 40 && hasAdequateSample) {
      reasons.push('胜率偏低：' + tradeStats.winRate + '%');
      recoveryConditions.push('胜率回升至45%以上');
      winRateSeverity = 1;
    }
  }

  // 4. Consecutive losses
  const consecLosses = context.attributionSummary ? context.attributionSummary.consecutiveLosses : 0;
  let consecSeverity = 0;
  if (consecLosses >= 5) {
    reasons.push('连续亏损' + consecLosses + '笔');
    recoveryConditions.push('出现连续2笔盈利交易');
    consecSeverity = 3;
  } else if (consecLosses >= 4) {
    reasons.push('连续亏损' + consecLosses + '笔');
    recoveryConditions.push('出现盈利交易');
    consecSeverity = 2;
  } else if (consecLosses >= 2) {
    reasons.push('连续亏损' + consecLosses + '笔');
    consecSeverity = 1;
  }

  // 5. Portfolio in loss
  const totalReturn = safeNum(riskMetrics.totalReturn, 0);
  const positionCount = pf.positions ? pf.positions.length : 0;
  let lossSeverity = 0;
  if (totalReturn <= -8) {
    reasons.push('组合严重浮亏：总收益' + totalReturn + '%');
    recoveryConditions.push('总收益回升至-3%以上');
    lossSeverity = 3;
  } else if (totalReturn < -5 && positionCount >= 3) {
    reasons.push('持仓浮亏较重：总收益' + totalReturn + '%，持仓' + positionCount + '只');
    recoveryConditions.push('总收益回升至-3%以上或减仓至2只以下');
    lossSeverity = 2;
  } else if (totalReturn < -3) {
    reasons.push('总收益为负：' + totalReturn + '%');
    recoveryConditions.push('总收益回正');
    lossSeverity = 1;
  }

  // 6. Profit factor — zero profit factor means ALL trades lost money
  let pfSeverity = 0;
  if (tradeStats.profitFactor !== null && hasMinTrades) {
    if (tradeStats.profitFactor === 0) {
      reasons.push('盈亏比为0：全部交易亏损，无盈利记录');
      recoveryConditions.push('出现盈利交易，盈亏比回升至0.5以上');
      pfSeverity = 3; // Zero profit factor → BLOCK
    } else if (tradeStats.profitFactor < 0.5) {
      reasons.push('盈亏比严重偏低：' + tradeStats.profitFactor);
      recoveryConditions.push('盈亏比回升至0.8以上');
      pfSeverity = 2;
    } else if (tradeStats.profitFactor < 0.8 && hasAdequateSample) {
      reasons.push('盈亏比偏低：' + tradeStats.profitFactor);
      recoveryConditions.push('盈亏比回升至1.0以上');
      pfSeverity = 1;
    }
  }

  // [v3.3.2] 7. Leakage audit — data leakage risk is a HARD block for real trading
  // Only CLEAN with real samples allows ALLOW. Everything else escalates.
  var leakageSeverity = 0;
  try {
    var leakagePath = require('path').join(__dirname, '..', '..', 'report-engine', 'data', 'verification', 'leakage_audit.json');
    var leakageAudit = null;
    if (require('fs').existsSync(leakagePath)) {
      leakageAudit = JSON.parse(require('fs').readFileSync(leakagePath, 'utf8'));
    }
    var laTotalChecks = leakageAudit ? (leakageAudit.totalChecks || 0) : 0;
    var laVerdict = leakageAudit ? (leakageAudit.verdict || 'NO_SAMPLES') : 'NO_SAMPLES';

    if (laVerdict === 'CRITICAL_DATA_LEAKAGE') {
      reasons.push('泄漏审计: CRITICAL_DATA_LEAKAGE — 发现未来数据泄漏，模型不可信');
      recoveryConditions.push('修复数据泄漏来源，重新训练并通过审计');
      leakageSeverity = 3; // BLOCK
    } else if (laVerdict === 'DATA_LEAKAGE_RISK') {
      reasons.push('泄漏审计: DATA_LEAKAGE_RISK — 存在数据泄漏风险');
      recoveryConditions.push('排查泄漏来源，重新训练并通过审计');
      leakageSeverity = 3; // BLOCK
    } else if (laVerdict === 'NO_SAMPLES' || laVerdict === 'INSUFFICIENT_DATA' || laTotalChecks === 0) {
      reasons.push('泄漏审计: NO_SAMPLES — 样本不足，无法认证无数据泄漏 (' + laTotalChecks + ' 条检查)');
      recoveryConditions.push('积累至少1条验证记录并通过泄漏审计');
      leakageSeverity = 2; // REDUCE — no real buys without audit
    } else if (laVerdict === 'MINOR_ISSUES') {
      reasons.push('泄漏审计: MINOR_ISSUES — 有小问题，需人工复核');
      recoveryConditions.push('完成人工复核或修复小问题至CLEAN');
      leakageSeverity = 1; // CAUTIOUS
    }
    // CLEAN → severity 0, no action needed
  } catch (_) {
    // Can't read audit file → conservative
    reasons.push('泄漏审计: 无法读取审计文件，保守降级');
    recoveryConditions.push('确认verification_runner已运行并生成leakage_audit.json');
    leakageSeverity = 2; // REDUCE
  }

  // ── Compound cascading: multi-dimension escalation ──

  // Take the max single-dimension severity as the baseline (including leakage)
  worstVerdict = Math.max(ddSeverity, sharpeSeverity, winRateSeverity,
                           consecSeverity, lossSeverity, pfSeverity, leakageSeverity);

  // CASCADE RULE 1: If drawdown is at warn level AND we have consecutive losses
  // with zero win rate, escalate from CAUTIOUS (1) to REDUCE (2) or BLOCK (3)
  if (ddSeverity >= 1 && consecSeverity >= 2 && winRateSeverity >= 2) {
    // -5% drawdown + 2+ consecutive losses + terrible win rate → at least REDUCE
    worstVerdict = Math.max(worstVerdict, 2);
    reasons.push('[级联] 回撤叠加连续亏损叠加低胜率 → 升级至REDUCE/BLOCK');
  }

  // CASCADE RULE 2: Negative total return + zero win rate + zero profit factor
  // This is the "strategy is broken" signal — BLOCK immediately
  if (lossSeverity >= 1 && winRateSeverity >= 3 && pfSeverity >= 3) {
    worstVerdict = 3;
    reasons.push('[级联] 负收益+零胜率+零盈亏比 → 策略疑似失效，禁止开仓');
    recoveryConditions.push('连续3笔盈利交易 + 盈亏比>0.8 + 总收益回升至-3%以上');
  }

  // CASCADE RULE 3: 4+ consecutive losses + any other severity-2 dimension
  if (consecSeverity >= 2) {
    const otherSevere = (ddSeverity >= 2 ? 1 : 0) + (winRateSeverity >= 2 ? 1 : 0) +
                        (pfSeverity >= 2 ? 1 : 0) + (lossSeverity >= 2 ? 1 : 0);
    if (otherSevere >= 1) {
      worstVerdict = Math.max(worstVerdict, 2);
      reasons.push('[级联] 连续亏损叠加其他严重信号 → 限制买入');
    }
  }

  // CASCADE RULE 4: 3+ positions + negative return + any severity ≥ 2
  if (positionCount >= 3 && totalReturn < 0 && worstVerdict >= 1) {
    // Having 3+ positions while losing money is risk compounding
    worstVerdict = Math.max(worstVerdict, 2);
    reasons.push('[级联] 持有' + positionCount + '只仓位且总收益为负 → 暂停新增买入');
    recoveryConditions.push('减仓至≤2只或总收益回正');
  }

  // ── Final verdict ──

  // If no reasons at all, system is healthy
  if (reasons.length === 0) {
    reasons.push('各项指标正常，系统运行良好');
  }

  // Deduplicate recovery conditions
  const uniqueRecovery = [];
  const seenRecovery = new Set();
  for (const rc of recoveryConditions) {
    if (!seenRecovery.has(rc)) {
      seenRecovery.add(rc);
      uniqueRecovery.push(rc);
    }
  }

  const verdictMap = ['ALLOW', 'CAUTIOUS', 'REDUCE', 'BLOCK'];
  const verdict = verdictMap[Math.min(3, worstVerdict)];

  const verdictLabels = {
    'ALLOW': '允许开仓',
    'CAUTIOUS': '谨慎开仓',
    'REDUCE': '仅可减仓',
    'BLOCK': '禁止开仓',
  };

  // Confidence: base 100%, severity-weighted reduction
  const severitySum = ddSeverity + sharpeSeverity + winRateSeverity +
                      consecSeverity + lossSeverity + pfSeverity + leakageSeverity;
  const confidence = Math.max(20, 100 - severitySum * 12);

  // Determine market state
  let marketStateHint = '正常';
  if (worstVerdict >= 3) marketStateHint = '策略疑似失效 — 暂停所有买入';
  else if (worstVerdict >= 2) marketStateHint = '策略承压 — 仅允许减仓观察';
  else if (worstVerdict >= 1) marketStateHint = '策略偏弱 — 提高买入门槛';
  if (consecSeverity >= 2 && winRateSeverity >= 2) marketStateHint = '策略失效预警 — 连续亏损+低胜率';
  // v3.3.2: Leakage audit block takes precedence in market hint
  if (leakageSeverity >= 3) marketStateHint = '数据泄漏风险 — 禁止所有买入，等待修复';
  else if (leakageSeverity >= 2) marketStateHint = '审计样本不足 — 暂停买入，等待验证积累';

  return {
    verdict: verdict,
    verdictLabel: verdictLabels[verdict] || verdict,
    confidence: confidence,
    marketStateHint: marketStateHint,
    reasons: reasons,
    recoveryConditions: uniqueRecovery,
    severityBreakdown: {
      drawdown: ddSeverity,
      sharpe: sharpeSeverity,
      winRate: winRateSeverity,
      consecutiveLosses: consecSeverity,
      portfolioLoss: lossSeverity,
      profitFactor: pfSeverity,
      leakageAudit: leakageSeverity,
      composite: Math.min(3, worstVerdict),
    },
    lastUpdated: new Date().toISOString(),
  };
}

// ---- Exports ----

module.exports = {
  computeStrategyHealth,
  computeHealthSummary,
  computeNavCurve,
  computeDrawdownCurve,
  computeRiskMetrics,
  computeTradeStats,
  computeAttributionSummary,
  computeMasterControlJudgment,
  computeMonthlyHeatmap,
  computeRollingAlpha,
};
