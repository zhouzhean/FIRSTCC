/**
 * simfolio.js — Simfolio 模拟交易引擎
 *
 * 10万虚拟资金，T+1交易，真实费率，基于量化信号自动决策。
 * 持久化到 report-engine/data/simfolio/portfolio.json
 *
 * 中国A股合规规则：
 *  - T+1：当日买入的股票次日方可卖出（硬止损除外）
 *  - 涨跌停 ±10%（主板），±20%（科创板/创业板）
 *  - 交易单位：100股（1手）整数倍
 *  - 费率：佣金0.025%，印花税0.1%（卖），过户费0.001%
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

const SIMFOLIO_DIR = path.join(config.REPORT_ENGINE_DIR, 'data', 'simfolio');
const PORTFOLIO_FILE = path.join(SIMFOLIO_DIR, 'portfolio.json');
const PORTFOLIO_BAK_FILE = path.join(SIMFOLIO_DIR, 'portfolio.json.bak');

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
      console.error('  [Simfolio] ERROR: 投资组合文件损坏，尝试从备份恢复...');
      // Try to restore from backup
      if (fs.existsSync(PORTFOLIO_BAK_FILE)) {
        try {
          pf = JSON.parse(fs.readFileSync(PORTFOLIO_BAK_FILE, 'utf8'));
          console.error('  [Simfolio] 已从备份恢复投资组合');
        } catch (e2) {
          console.error('  [Simfolio] 备份也损坏，创建新投资组合');
        }
      }
    }
  }
  if (!pf) pf = createPortfolio();
  return migratePortfolio(pf);
}

function savePortfolio(pf) {
  ensureDir();
  pf.meta.lastUpdated = new Date().toISOString();
  // Backup old file first
  const json = JSON.stringify(pf, null, 2);
  if (fs.existsSync(PORTFOLIO_FILE)) {
    try { fs.copyFileSync(PORTFOLIO_FILE, PORTFOLIO_BAK_FILE); } catch (e) { /* ignore */ }
  }
  fs.writeFileSync(PORTFOLIO_FILE, json, 'utf8');
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

  // Previous day's closing NAV for daily P&L
  const today = new Date().toISOString().slice(0, 10);
  let prevDayValue = null;
  for (let i = pf.dailyNav.length - 1; i >= 0; i--) {
    if (pf.dailyNav[i].date < today) {
      prevDayValue = pf.dailyNav[i].nav;
      break;
    }
  }
  if (prevDayValue === null && pf.dailyNav.length === 0) {
    prevDayValue = pf.meta.initialCapital;
  }

  return {
    date: new Date().toISOString().slice(0, 10),
    cash: pf.cash,
    positionValue: positionValue,
    totalValue: totalValue,
    totalReturn: Math.round(totalReturn * 100) / 100,
    benchmarkReturn: Math.round(benchmarkReturn * 100) / 100,
    alpha: Math.round((totalReturn - benchmarkReturn) * 100) / 100,
    prevDayValue: prevDayValue,
    positions: posWithPnL,
    tradeCount: pf.tradeHistory.length,
  };
}

// ---- Sector Classification (mirrored from pipeline.js assignSectors) ----

const SECTOR_KEYWORDS = {
  '有色金属/稀土': ['有色', '稀土', '矿', '铝', '铜', '钢', '金属', '材料', '磁'],
  '半导体/AI算力': ['半导体', '芯片', '电子', '光电', '封测', '晶圆', '硅', '算力', '存储'],
  '机器人/具身智能': ['机器人', '智能', '减速器', '电机', '伺服', '驱动的', '传感', '运动控制', '自动化'],
  '创新药/AI医疗': ['药', '医疗', '医', '生物', '基因', '细胞', '疫苗', '诊断', '试剂'],
  '商业航天': ['航天', '卫星', '航空', '火箭', '军工电子', '雷达', '导航'],
  '固态电池/储能': ['电池', '储能', '锂', '电解', '正极', '负极', '新能源', '光伏', '风电'],
  '新型电力基建': ['电力', '电网', '特高压', '电缆', '电气', '充电桩', '能源', '配电'],
  '军工': ['军工', '弹药', '装备', '船舶', '电磁', '武器', '防务'],
};

function classifySector(stockName) {
  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    if (keywords.some(kw => stockName.includes(kw))) {
      return sector;
    }
  }
  return '其他';
}

function getSectorExposure(pf, targetSector, excludeStockCode) {
  var totalValue = pf.cash;
  for (var i = 0; i < pf.positions.length; i++) {
    totalValue += pf.positions[i].shares * pf.positions[i].currentPrice;
  }
  var sectorValue = 0;
  for (var i = 0; i < pf.positions.length; i++) {
    var pos = pf.positions[i];
    if (pos.code === excludeStockCode) continue;
    if (classifySector(pos.name) === targetSector) {
      sectorValue += pos.shares * pos.currentPrice;
    }
  }
  return totalValue > 0 ? sectorValue / totalValue : 0;
}

// ---- Trading Engine ----

/**
 * Make trading decisions based on pipeline results.
 * Called after pipeline completes each trading day.
 *
 * @param {Array} pipelineResults - Array of stock analysis results from pipeline
 * @param {Array} indices - Market index data (for benchmark tracking)
 * @param {Object} macroContext - Optional macro risk context from cross-market engine
 */
function makeTradingDecisions(pf, pipelineResults, indices, scanType, macroContext) {
  const decisions = [];
  const today = new Date().toISOString().slice(0, 10);
  const isFullScan = scanType === 'full';

  // ---- Step 1: Update benchmark ----
  updateBenchmark(pf, indices, today);

  // ---- Step 2: Check existing positions for sell signals ----
  for (const pos of pf.positions) {
    const stockData = pipelineResults.find(r => r.code === pos.code);
    if (!stockData) continue;

    // T+1 compliance: stocks bought today cannot be sold today (A-share rule)
    // Exception: hard stop-loss can still trigger on same day
    const isBoughtToday = pos.entryDate === today;

    const sellReason = checkSellSignal(pos, stockData, isBoughtToday, isFullScan);
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

  // ---- Step 3: Apply macro risk penalty ----
  // Risk-off regime: reduce all composite scores by 5-8 points
  var macroPenalty = 0;
  if (macroContext && macroContext.riskState) {
    const regime = macroContext.riskState.regime;
    if (regime === 'risk_off' || regime === 'panic') {
      macroPenalty = 8;
    } else if (regime === 'slightly_bullish') {
      macroPenalty = 0;  // no penalty in slightly bullish regime
    } else if (regime === 'neutral') {
      macroPenalty = 2;
    }
    // risk_on: macroPenalty stays 0
  }
  if (macroPenalty > 0) {
    for (const r of pipelineResults) {
      if (r.compositeScore != null) {
        r.compositeScore = Math.max(0, r.compositeScore - macroPenalty);
      }
    }
  }

  // ---- Step 4: Look for buy candidates ----
  // Score all pipeline results, compute percentile thresholds
  const scoredWithScores = pipelineResults
    .filter(r => r.compositeScore != null)
    .map(r => r.compositeScore)
    .sort((a, b) => b - a);

  // Percentile-based thresholds
  const pctBuy = (config.BUY_THRESHOLD && config.BUY_THRESHOLD.percentileTop) || 0.20;
  const pctStrong = (config.BUY_THRESHOLD && config.BUY_THRESHOLD.percentileStrong) || 0.10;
  const minAbsolute = (config.BUY_THRESHOLD && config.BUY_THRESHOLD.minAbsoluteScore) || 50;
  const minStrongScore = (config.BUY_THRESHOLD && config.BUY_THRESHOLD.minStrongScore) || 70;

  let buyThreshold = minAbsolute;
  let strongThreshold = Math.max(minStrongScore, minAbsolute + 5);

  if (scoredWithScores.length > 0) {
    const buyIdx = Math.max(0, Math.floor(scoredWithScores.length * pctBuy) - 1);
    const strongIdx = Math.max(0, Math.floor(scoredWithScores.length * pctStrong) - 1);
    buyThreshold = Math.max(minAbsolute, scoredWithScores[buyIdx] || 0);
    strongThreshold = Math.max(strongThreshold, scoredWithScores[strongIdx] || 0);
  }

  // Sort candidates by composite score (percentile-ranked, with absolute floor)
  const maxSectorExposure = (config.SIMFOLIO && config.SIMFOLIO.maxSectorExposurePct) || 0.40;
  const buyCandidates = pipelineResults
    .filter(r => {
      // Don't buy what we already hold
      if (pf.positions.some(p => p.code === r.code)) return false;
      // Must meet percentile threshold (with absolute floor)
      if (r.compositeScore < buyThreshold) return false;
      // Sector concentration check: skip if same sector already >= 40%
      const candidateSector = classifySector(r.name);
      if (candidateSector !== '其他' && getSectorExposure(pf, candidateSector, null) >= maxSectorExposure) {
        return false;
      }
      return true;
    })
    .sort((a, b) => b.compositeScore - a.compositeScore);

  // How many slots available?
  const availableSlots = config.SIMFOLIO.maxPositions - pf.positions.length + decisions.filter(d => d.action === 'sell').length;

  for (const candidate of buyCandidates) {
    if (decisions.filter(d => d.action === 'buy').length >= availableSlots) break;

    // Strong buy: top percentile AND hasStrongSignal AND meets minStrongScore
    const isStrong = candidate.compositeScore >= strongThreshold && candidate.hasStrongSignal;
    const buyDecision = checkBuySignal(candidate, pf, isStrong);
    if (buyDecision) {
      decisions.push(buyDecision);
    }
  }

  // ---- Step 5: Execute decisions ----
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

  // ---- Step 6: Update position prices ----
  for (const pos of pf.positions) {
    const stockData = pipelineResults.find(r => r.code === pos.code);
    if (stockData) {
      pos.currentPrice = stockData.price;
    }
  }

  // ---- Step 7: Record daily NAV ----
  recordDailyNAV(pf, today);

  savePortfolio(pf);

  return {
    decisions: decisions,
    executed: executedTrades,
    snapshot: getSnapshot(pf),
  };
}

// ---- Sell Signal Detection ----

function checkSellSignal(position, stockData, isBoughtToday, isFullScan) {
  const pnlPct = (stockData.price - position.avgCost) / position.avgCost * 100;

  // Hard stop loss: -8% (always active, even T+1 same-day)
  if (pnlPct <= config.SIMFOLIO.stopLossPct * 100) {
    return '硬止损：亏损' + pnlPct.toFixed(1) + '%触发-' + Math.abs(config.SIMFOLIO.stopLossPct * 100) + '%止损线';
  }

  // T+1: stocks bought today cannot be sold (except hard stop above)
  if (isBoughtToday) return null;

  // Soft stop: composite score dropped significantly
  // Only during FULL pipeline scans — mid-scan scores are less reliable
  // Threshold: < 45 for full scan (was 50, made more conservative)
  if (isFullScan && stockData.compositeScore < 45) {
    return '软止损：综合评分降至' + stockData.compositeScore + '分（<45）';
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

function buildBuyReason(stockData, isStrong) {
  var parts = [];
  parts.push((isStrong ? '强买入' : '买入') + '：' + stockData.compositeScore + '分/' + stockData.rating + '级');

  // Dimension highlight
  if (stockData.rawScores) {
    var dimHighlights = [];
    var dims = [
      { key: 'fundamental',  name: '基本面' },
      { key: 'technical',    name: '技术面' },
      { key: 'hidden',       name: '隐藏信号' },
      { key: 'capitalFlow',  name: '资金流' },
      { key: 'event',        name: '事件驱动' },
    ];
    for (var i = 0; i < dims.length; i++) {
      var score = stockData.rawScores[dims[i].key];
      if (score >= 60) dimHighlights.push(dims[i].name + score + '分');
    }
    if (dimHighlights.length > 0) parts.push('【' + dimHighlights.join('/') + '】');
  }

  // Hidden signals
  if (stockData.hiddenSignals && stockData.hiddenSignals.length > 0) {
    parts.push(stockData.hiddenSignals.map(function(s) {
      return s.id + ':' + s.name + '(' + s.level + ')';
    }).join('+'));
  }

  return parts.join(' ');
}

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
      reason: buildBuyReason(stockData, true),
      strength: 'strong',
      analysisContext: {
        compositeScore: stockData.compositeScore,
        rating: stockData.rating,
        hiddenSignals: stockData.hiddenSignals || [],
        rawScores: stockData.rawScores || {},
        dimensionScores: stockData.dimensionScores || {},
      },
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
    reason: buildBuyReason(stockData, false),
    strength: 'normal',
    analysisContext: {
      compositeScore: stockData.compositeScore,
      rating: stockData.rating,
      hiddenSignals: stockData.hiddenSignals || [],
      rawScores: stockData.rawScores || {},
      dimensionScores: stockData.dimensionScores || {},
    },
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
    analysisContext: decision.analysisContext || null,
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
    analysisContext: decision.analysisContext || null,
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
  const todayStr = new Date().toISOString().slice(0, 10);

  for (const pos of pf.positions) {
    const live = priceMap[pos.code];
    if (!live || live.price == null) continue;

    const currentPrice = live.price;
    const pnlPct = (currentPrice - pos.avgCost) / pos.avgCost * 100;
    const isBoughtToday = pos.entryDate === todayStr;

    // 1. 硬止损：-8%（T+1当天唯一可触发的卖出）
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

    // T+1: 当天买入的股票除了硬止损外不生成任何卖出警报
    if (isBoughtToday) continue;

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

  // T+1 compliance: stocks bought today cannot be sold today
  // Only hard stop-loss (-8%) can override T+1
  const todayStr = new Date().toISOString().slice(0, 10);
  if (position.entryDate === todayStr && alert.action !== 'stop_loss') {
    return null;
  }

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
  const today = todayStr;
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
