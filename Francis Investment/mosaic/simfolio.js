/**
 * simfolio.js — Simfolio 模拟交易引擎
 *
 * 10万虚拟资金，T+1交易，真实费率，基于量化信号自动决策。
 * 持久化到 report-engine/data/simfolio/portfolio.json
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

const SIMFOLIO_DIR = path.join(config.REPORT_ENGINE_DIR, 'data', 'simfolio');
const PORTFOLIO_FILE = path.join(SIMFOLIO_DIR, 'portfolio.json');

// ---- Portfolio Management ----

function ensureDir() {
  if (!fs.existsSync(SIMFOLIO_DIR)) {
    fs.mkdirSync(SIMFOLIO_DIR, { recursive: true });
  }
}

function createPortfolio() {
  return {
    meta: {
      initialCapital: config.SIMFOLIO.initialCapital,
      startDate: new Date().toISOString().slice(0, 10),
      lastUpdated: null,
    },
    cash: config.SIMFOLIO.initialCapital,
    positions: [],
    tradeHistory: [],
    dailyNav: [],
  };
}

function loadPortfolio() {
  ensureDir();
  let pf;
  if (fs.existsSync(PORTFOLIO_FILE)) {
    try {
      pf = JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf8'));
    } catch (e) {
      console.error('  Simfolio: failed to load portfolio, creating new one');
    }
  }
  if (!pf) pf = createPortfolio();
  return migratePortfolio(pf);
}

function savePortfolio(pf) {
  ensureDir();
  pf.meta.lastUpdated = new Date().toISOString();
  fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(pf, null, 2), 'utf8');
}

// ---- Portfolio Snapshot ----

function getSnapshot(pf) {
  let positionValue = 0;
  let totalPnL = 0;

  const posWithPnL = pf.positions.map(pos => {
    const marketValue = pos.shares * pos.currentPrice;
    const pnl = marketValue - pos.shares * pos.avgCost;
    const pnlPct = ((pos.currentPrice - pos.avgCost) / pos.avgCost * 100);
    positionValue += marketValue;
    totalPnL += pnl;
    return { ...pos, marketValue, pnl, pnlPct };
  });

  const totalValue = pf.cash + positionValue;
  const totalReturn = (totalValue - pf.meta.initialCapital) / pf.meta.initialCapital * 100;

  // Compute benchmark return from daily NAV
  let benchmarkReturn = 0;
  if (pf.dailyNav.length > 0) {
    const last = pf.dailyNav[pf.dailyNav.length - 1];
    benchmarkReturn = last.benchmarkReturn || 0;
  }

  return {
    date: new Date().toISOString().slice(0, 10),
    cash: pf.cash,
    positionValue: positionValue,
    totalValue: totalValue,
    totalReturn: Math.round(totalReturn * 100) / 100,
    benchmarkReturn: Math.round(benchmarkReturn * 100) / 100,
    alpha: Math.round((totalReturn - benchmarkReturn) * 100) / 100,
    positions: posWithPnL,
    tradeCount: pf.tradeHistory.length,
  };
}

// ---- Trading Engine ----

/**
 * Make trading decisions based on pipeline results.
 * Called after pipeline completes each trading day.
 *
 * @param {Array} pipelineResults - Array of stock analysis results from pipeline
 * @param {Array} indices - Market index data (for benchmark tracking)
 */
function makeTradingDecisions(pf, pipelineResults, indices) {
  const decisions = [];
  const today = new Date().toISOString().slice(0, 10);

  // ---- Step 1: Update benchmark ----
  updateBenchmark(pf, indices, today);

  // ---- Step 2: Check existing positions for sell signals ----
  for (const pos of pf.positions) {
    const stockData = pipelineResults.find(r => r.code === pos.code);
    if (!stockData) continue;

    const sellReason = checkSellSignal(pos, stockData);
    if (sellReason) {
      decisions.push({
        action: 'sell',
        code: pos.code,
        name: pos.name,
        shares: pos.shares,
        price: stockData.price,
        reason: sellReason,
      });
    }
  }

  // ---- Step 3: Look for buy candidates ----
  // Score all pipeline results, compute percentile thresholds
  const scoredWithScores = pipelineResults
    .filter(r => r.compositeScore != null)
    .map(r => r.compositeScore)
    .sort((a, b) => b - a);

  // Percentile-based thresholds
  const pctBuy = (config.BUY_THRESHOLD && config.BUY_THRESHOLD.percentileTop) || 0.20;
  const pctStrong = (config.BUY_THRESHOLD && config.BUY_THRESHOLD.percentileStrong) || 0.10;
  const minAbsolute = (config.BUY_THRESHOLD && config.BUY_THRESHOLD.minAbsoluteScore) || 50;

  let buyThreshold = minAbsolute;
  let strongThreshold = minAbsolute + 5;

  if (scoredWithScores.length > 0) {
    const buyIdx = Math.max(0, Math.floor(scoredWithScores.length * pctBuy) - 1);
    const strongIdx = Math.max(0, Math.floor(scoredWithScores.length * pctStrong) - 1);
    buyThreshold = Math.max(minAbsolute, scoredWithScores[buyIdx] || 0);
    strongThreshold = Math.max(minAbsolute + 5, scoredWithScores[strongIdx] || 0);
  }

  // Sort candidates by composite score (percentile-ranked, with absolute floor)
  const buyCandidates = pipelineResults
    .filter(r => {
      // Don't buy what we already hold
      if (pf.positions.some(p => p.code === r.code)) return false;
      // Must meet percentile threshold (with absolute floor)
      return r.compositeScore >= buyThreshold;
    })
    .sort((a, b) => b.compositeScore - a.compositeScore);

  // How many slots available?
  const availableSlots = config.SIMFOLIO.maxPositions - pf.positions.length + decisions.filter(d => d.action === 'sell').length;

  for (const candidate of buyCandidates) {
    if (decisions.filter(d => d.action === 'buy').length >= availableSlots) break;

    // Strong buy: top percentile AND hasStrongSignal
    const isStrong = candidate.compositeScore >= strongThreshold && candidate.hasStrongSignal;
    const buyDecision = checkBuySignal(candidate, pf, isStrong);
    if (buyDecision) {
      decisions.push(buyDecision);
    }
  }

  // ---- Step 4: Execute decisions ----
  const executedTrades = [];
  for (const dec of decisions) {
    if (dec.action === 'sell') {
      const trade = executeSell(pf, dec, today);
      if (trade) executedTrades.push(trade);
    } else if (dec.action === 'buy') {
      const trade = executeBuy(pf, dec, today);
      if (trade) executedTrades.push(trade);
    }
  }

  // ---- Step 5: Update position prices ----
  for (const pos of pf.positions) {
    const stockData = pipelineResults.find(r => r.code === pos.code);
    if (stockData) {
      pos.currentPrice = stockData.price;
    }
  }

  // ---- Step 6: Record daily NAV ----
  recordDailyNAV(pf, today);

  savePortfolio(pf);

  return {
    decisions: decisions,
    executed: executedTrades,
    snapshot: getSnapshot(pf),
  };
}

// ---- Sell Signal Detection ----

function checkSellSignal(position, stockData) {
  const pnlPct = (stockData.price - position.avgCost) / position.avgCost * 100;

  // Hard stop loss: -8%
  if (pnlPct <= config.SIMFOLIO.stopLossPct * 100) {
    return '硬止损：亏损' + pnlPct.toFixed(1) + '%触发-' + Math.abs(config.SIMFOLIO.stopLossPct * 100) + '%止损线';
  }

  // Soft stop: composite score dropped significantly
  if (stockData.compositeScore < 50) {
    return '软止损：综合评分降至' + stockData.compositeScore + '分（<50）';
  }

  // Take profit: up > 20% with weakening signals
  if (pnlPct > 20 && stockData.hiddenSignals && stockData.hiddenSignals.length === 0) {
    return '止盈：盈利' + pnlPct.toFixed(1) + '%且隐藏信号全部消失';
  }

  // Strong hidden signals → hold
  if (stockData.hasStrongSignal) return null;

  // No sell reason
  return null;
}

// ---- Buy Signal Detection ----

function checkBuySignal(stockData, pf, isStrong) {
  if (isStrong) {
    // Strong conviction: top percentile + strong signal
    const allocation = Math.min(
      pf.cash * 0.20,
      pf.meta.initialCapital * config.SIMFOLIO.maxSinglePositionPct
    );
    const shares = Math.floor(allocation / stockData.price / 100) * 100;
    if (shares < 100) return null;

    return {
      action: 'buy',
      code: stockData.code,
      name: stockData.name,
      shares: shares,
      price: stockData.price,
      reason: '强买入：' + stockData.compositeScore + '分/' + stockData.rating + '级（Top ' +
              ((config.BUY_THRESHOLD && config.BUY_THRESHOLD.percentileStrong) || 0.10) * 100 + '%） + ' +
              (stockData.hiddenSignals ? stockData.hiddenSignals.map(s => s.name).join('+') : '无隐藏信号'),
      strength: 'strong',
    };
  }

  // Normal buy: meets percentile threshold
  const allocation = Math.min(pf.cash * 0.10, pf.meta.initialCapital * 0.15);
  const shares = Math.floor(allocation / stockData.price / 100) * 100;
  if (shares < 100) return null;

  return {
    action: 'buy',
    code: stockData.code,
    name: stockData.name,
    shares: shares,
    price: stockData.price,
    reason: '买入：' + stockData.compositeScore + '分/' + stockData.rating + '级（Top ' +
            ((config.BUY_THRESHOLD && config.BUY_THRESHOLD.percentileTop) || 0.20) * 100 + '%）',
    strength: 'normal',
  };
}

// ---- Trade Execution ----

function executeBuy(pf, decision, date) {
  const amount = decision.shares * decision.price;
  const fee = amount * config.SIMFOLIO.commissionRate + amount * config.SIMFOLIO.transferFeeRate;
  const total = amount + fee;

  if (total > pf.cash) return null;

  pf.cash -= total;

  // Add to positions
  pf.positions.push({
    code: decision.code,
    name: decision.name,
    shares: decision.shares,
    avgCost: decision.price,
    currentPrice: decision.price,
    peakPrice: decision.price,        // 移动止盈：历史最高价
    trailingStopPrice: null,          // 移动止盈触发价（激活后设置）
    entryDate: date,
    entryReason: decision.reason,
  });

  const trade = {
    date: date,
    time: new Date().toTimeString().slice(0, 8),
    action: 'buy',
    code: decision.code,
    name: decision.name,
    price: decision.price,
    shares: decision.shares,
    amount: amount,
    fee: Math.round(fee * 100) / 100,
    reason: decision.reason,
  };
  pf.tradeHistory.push(trade);
  return trade;
}

function executeSell(pf, decision, date) {
  const position = pf.positions.find(p => p.code === decision.code);
  if (!position) return null;

  const amount = decision.shares * decision.price;
  const commission = amount * config.SIMFOLIO.commissionRate;
  const stampTax = amount * config.SIMFOLIO.stampTaxRate;  // only on sell
  const transferFee = amount * config.SIMFOLIO.transferFeeRate;
  const fee = commission + stampTax + transferFee;

  pf.cash += amount - fee;

  // Remove position
  pf.positions = pf.positions.filter(p => p.code !== decision.code);

  const pnl = amount - position.shares * position.avgCost - fee;
  const pnlPct = (pnl / (position.shares * position.avgCost)) * 100;

  const trade = {
    date: date,
    time: new Date().toTimeString().slice(0, 8),
    action: 'sell',
    code: decision.code,
    name: decision.name,
    price: decision.price,
    shares: decision.shares,
    amount: amount,
    fee: Math.round(fee * 100) / 100,
    pnl: Math.round(pnl * 100) / 100,
    pnlPct: Math.round(pnlPct * 100) / 100,
    reason: decision.reason,
  };
  pf.tradeHistory.push(trade);
  return trade;
}

// ---- Benchmark & NAV ----

function updateBenchmark(pf, indices, date) {
  // Track Shanghai Composite as benchmark
  if (!indices || indices.length === 0) return;

  const shIdx = indices.find(i => i.code === '000001');
  if (!shIdx || shIdx.price == null) return;

  // Store latest benchmark price
  if (!pf._benchmarkPrice) {
    pf._benchmarkPrice = shIdx.price;
    pf._benchmarkStart = shIdx.price;
  }
  pf._benchmarkPrice = shIdx.price;
  pf._benchmarkChange = shIdx.changePercent || 0;
}

function recordDailyNAV(pf, date) {
  const snapshot = getSnapshot(pf);

  // Compute benchmark return
  let benchmarkReturn = 0;
  if (pf._benchmarkStart && pf._benchmarkPrice) {
    benchmarkReturn = (pf._benchmarkPrice - pf._benchmarkStart) / pf._benchmarkStart * 100;
  }

  // Check if we already have a record for today
  const existing = pf.dailyNav.find(n => n.date === date);
  if (existing) {
    existing.nav = snapshot.totalValue;
    existing.return_ = snapshot.totalReturn;
    existing.benchmarkReturn = Math.round(benchmarkReturn * 100) / 100;
    return;
  }

  pf.dailyNav.push({
    date: date,
    nav: snapshot.totalValue,
    return_: snapshot.totalReturn,
    benchmarkReturn: Math.round(benchmarkReturn * 100) / 100,
  });
}

// ---- Performance Stats ----

function computeStats(pf) {
  const navs = pf.dailyNav;
  if (navs.length < 2) {
    return {
      totalReturn: 0,
      benchmarkReturn: 0,
      alpha: 0,
      winRate: null,
      maxDrawdown: 0,
      sharpeRatio: null,
      totalTrades: pf.tradeHistory.length,
      avgHoldDays: null,
    };
  }

  const totalReturn = navs[navs.length - 1].return_;
  const benchmarkReturn = navs[navs.length - 1].benchmarkReturn;

  // Max drawdown
  let maxDD = 0;
  let peak = navs[0].nav;
  for (const n of navs) {
    if (n.nav > peak) peak = n.nav;
    const dd = (n.nav - peak) / peak * 100;
    if (dd < maxDD) maxDD = dd;
  }

  // Win rate from closed trades
  const closedTrades = pf.tradeHistory.filter(t => t.action === 'sell');
  const wins = closedTrades.filter(t => t.pnl > 0).length;
  const winRate = closedTrades.length > 0 ? Math.round(wins / closedTrades.length * 100) : null;

  // Sharpe ratio (simplified: daily returns)
  let sharpeRatio = null;
  if (navs.length > 5) {
    const dailyReturns = [];
    for (let i = 1; i < navs.length; i++) {
      dailyReturns.push((navs[i].nav - navs[i - 1].nav) / navs[i - 1].nav);
    }
    const avgReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) / dailyReturns.length;
    const stdDev = Math.sqrt(variance);
    sharpeRatio = stdDev > 0 ? Math.round(avgReturn / stdDev * Math.sqrt(252) * 100) / 100 : null; // annualized
  }

  return {
    totalReturn: Math.round(totalReturn * 100) / 100,
    benchmarkReturn: Math.round(benchmarkReturn * 100) / 100,
    alpha: Math.round((totalReturn - benchmarkReturn) * 100) / 100,
    winRate: winRate,
    maxDrawdown: Math.round(maxDD * 100) / 100,
    sharpeRatio: sharpeRatio,
    totalTrades: pf.tradeHistory.length,
    avgHoldDays: null, // requires position-level tracking
  };
}

// ---- Reset ----

function resetPortfolio() {
  const pf = createPortfolio();
  savePortfolio(pf);
  return pf;
}

// ---- Migration (向后兼容) ----

function migratePortfolio(pf) {
  let migrated = false;
  for (const pos of pf.positions) {
    if (pos.peakPrice === undefined) {
      pos.peakPrice = pos.currentPrice || pos.avgCost;
      migrated = true;
    }
    if (pos.trailingStopPrice === undefined) {
      pos.trailingStopPrice = null;
      migrated = true;
    }
  }
  if (migrated) {
    savePortfolio(pf);
  }
  return pf;
}

// ---- Position Price Update (持仓价格刷新) ----

function updatePositionPrices(pf, priceMap) {
  for (const pos of pf.positions) {
    const live = priceMap[pos.code];
    if (live && live.price != null) {
      pos.currentPrice = live.price;
    }
  }
  savePortfolio(pf);
}

// ---- Trailing Stop (移动止盈) ----

function updateTrailingStop(pf, priceMap) {
  const ts = config.SCHEDULER.trailingStop;
  if (!ts || !ts.enabled) return;

  for (const pos of pf.positions) {
    const live = priceMap[pos.code];
    if (!live || live.price == null) continue;

    const currentPrice = live.price;
    const profitPct = (currentPrice - pos.avgCost) / pos.avgCost * 100;

    // 更新最高价
    if (currentPrice > pos.peakPrice) {
      pos.peakPrice = currentPrice;
    }

    // 未激活：盈利不足 activationPct
    if (profitPct < ts.activationPct) {
      pos.trailingStopPrice = null;
      continue;
    }

    // 根据盈利层级设置移动止盈价
    const tiers = ts.tiers.sort((a, b) => b.profitPct - a.profitPct);
    let trailOffset = null;
    for (const tier of tiers) {
      if (profitPct >= tier.profitPct) {
        trailOffset = tier.trailOffset;
        break;
      }
    }

    if (trailOffset != null) {
      const newStop = pos.peakPrice * (1 - trailOffset / 100);
      // 移动止盈只升不降
      if (pos.trailingStopPrice == null || newStop > pos.trailingStopPrice) {
        pos.trailingStopPrice = Math.round(newStop * 100) / 100;
      }
    }
  }
  savePortfolio(pf);
}

// ---- Risk Threshold Check (风控检查) ----

function checkRiskThresholds(pf, priceMap) {
  const alerts = [];

  for (const pos of pf.positions) {
    const live = priceMap[pos.code];
    if (!live || live.price == null) continue;

    const currentPrice = live.price;
    const pnlPct = (currentPrice - pos.avgCost) / pos.avgCost * 100;

    // 1. 硬止损：-8%
    if (pnlPct <= -8) {
      alerts.push({
        code: pos.code,
        name: pos.name,
        action: 'stop_loss',
        priority: 'critical',
        currentPrice,
        pnlPct: Math.round(pnlPct * 100) / 100,
        reason: '硬止损：亏损' + pnlPct.toFixed(1) + '%触发-8%止损线',
      });
      continue;
    }

    // 2. 移动止盈触发
    if (pos.trailingStopPrice != null && currentPrice <= pos.trailingStopPrice) {
      const peakProfit = ((pos.peakPrice - pos.avgCost) / pos.avgCost * 100);
      alerts.push({
        code: pos.code,
        name: pos.name,
        action: 'trailing_stop',
        priority: 'high',
        currentPrice,
        pnlPct: Math.round(pnlPct * 100) / 100,
        reason: '移动止盈：从最高+' + peakProfit.toFixed(1) + '%回撤，触发价¥' + pos.trailingStopPrice.toFixed(2),
      });
      continue;
    }

    // 3. 止盈：+25%触发
    if (pnlPct > 25) {
      alerts.push({
        code: pos.code,
        name: pos.name,
        action: 'take_profit',
        priority: 'medium',
        currentPrice,
        pnlPct: Math.round(pnlPct * 100) / 100,
        reason: '止盈：盈利' + pnlPct.toFixed(1) + '%触发25%止盈线',
      });
      continue;
    }

    // 4. 接近止损预警（仅前端显示，不交易）
    if (pnlPct <= -5 && pnlPct > -8) {
      alerts.push({
        code: pos.code,
        name: pos.name,
        action: 'warning',
        priority: 'low',
        currentPrice,
        pnlPct: Math.round(pnlPct * 100) / 100,
        reason: '预警：亏损' + pnlPct.toFixed(1) + '%，接近-8%止损线',
      });
    }
  }

  return alerts;
}

// ---- Execute Risk Trade (执行风控交易) ----

function executeRiskTrade(pf, alert, priceMap) {
  if (alert.action === 'warning') return null; // 预警不交易

  const position = pf.positions.find(p => p.code === alert.code);
  if (!position) return null;

  const price = alert.currentPrice;
  const amount = position.shares * price;
  const commission = amount * config.SIMFOLIO.commissionRate;
  const stampTax = amount * config.SIMFOLIO.stampTaxRate;
  const transferFee = amount * config.SIMFOLIO.transferFeeRate;
  const fee = commission + stampTax + transferFee;

  pf.cash += amount - fee;
  pf.positions = pf.positions.filter(p => p.code !== alert.code);

  const pnl = amount - position.shares * position.avgCost - fee;
  const pnlPct = (pnl / (position.shares * position.avgCost)) * 100;

  const trade = {
    date: new Date().toISOString().slice(0, 10),
    time: new Date().toTimeString().slice(0, 8),
    action: 'sell',
    code: alert.code,
    name: alert.name,
    price: price,
    shares: position.shares,
    amount: amount,
    fee: Math.round(fee * 100) / 100,
    pnl: Math.round(pnl * 100) / 100,
    pnlPct: Math.round(pnlPct * 100) / 100,
    reason: alert.reason,
    triggeredBy: alert.action,
  };
  pf.tradeHistory.push(trade);

  // 记录每日净值
  const today = new Date().toISOString().slice(0, 10);
  const existing = pf.dailyNav.find(n => n.date === today);
  const snap = getSnapshot(pf);
  if (existing) {
    existing.nav = snap.totalValue;
    existing.return_ = snap.totalReturn;
  } else {
    pf.dailyNav.push({
      date: today,
      nav: snap.totalValue,
      return_: snap.totalReturn,
      benchmarkReturn: pf.dailyNav.length > 0 ? pf.dailyNav[pf.dailyNav.length - 1].benchmarkReturn : 0,
    });
  }

  savePortfolio(pf);
  return trade;
}

module.exports = {
  loadPortfolio,
  savePortfolio,
  getSnapshot,
  makeTradingDecisions,
  computeStats,
  resetPortfolio,
  migratePortfolio,
  updatePositionPrices,
  updateTrailingStop,
  checkRiskThresholds,
  executeRiskTrade,
};
