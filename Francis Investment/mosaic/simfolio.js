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

// ---- Utility ----

function safeFixed(value, decimals, fallback) {
  if (fallback === undefined) fallback = '?';
  if (value == null || typeof value !== 'number' || isNaN(value)) return fallback;
  return value.toFixed(decimals);
}

const SIMFOLIO_DIR = path.join(config.REPORT_ENGINE_DIR, 'data', 'simfolio');
const PORTFOLIO_FILE = path.join(SIMFOLIO_DIR, 'portfolio.json');
const PORTFOLIO_BAK_FILE = path.join(SIMFOLIO_DIR, 'portfolio.json.bak');
const WEEKEND_CONTEXT_FILE = path.join(SIMFOLIO_DIR, 'weekend_context.json');
const HISTORY_CONTEXT_FILE = path.join(SIMFOLIO_DIR, 'history_context.json'); // v2.9: unified history context

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

/**
 * Load weekend analysis context from disk.
 * Returns null if file not found, expired, or invalid.
 */
function loadWeekendContext() {
  // v2.9: Try unified history_context first, fall back to old weekend_context
  if (fs.existsSync(HISTORY_CONTEXT_FILE)) {
    try {
      const ctx = JSON.parse(fs.readFileSync(HISTORY_CONTEXT_FILE, 'utf8'));
      const now = new Date().toISOString().slice(0, 10);
      if (ctx.validUntil >= now) {
        // Use deepAnalysis.insights if available, fall back to dailyInsights
        var insights = (ctx.deepAnalysis && ctx.deepAnalysis.insights) || ctx.insights || [];
        if (insights.length > 0) return { ...ctx, insights: insights };
      }
    } catch (_) {}
  }
  // Fallback to old weekend_context
  if (!fs.existsSync(WEEKEND_CONTEXT_FILE)) return null;
  try {
    const ctx = JSON.parse(fs.readFileSync(WEEKEND_CONTEXT_FILE, 'utf8'));
    const now = new Date().toISOString().slice(0, 10);
    if (ctx.validUntil >= now && ctx.insights && ctx.insights.length > 0) {
      return ctx;
    }
  } catch (_) {}
  return null;
}

/**
 * Think-Tank defensive gate — the system's own "brain" evaluates whether
 * conditions are too risky for new buys, regardless of individual stock scores.
 *
 * Checks three dimensions:
 *   1. Factor health: ≥2 COLD factors → signals may be unreliable (was ≥3)
 *   2. Portfolio stress: ≥3 positions AND total return < -3% → already hurting
 *   3. Consecutive loss days: ≥3 days of NAV decline → persistent drawdown
 *   4. Cross-market risk: panic/risk_off regime → macro headwinds
 *   5. Signal-score divergence: many signals triggered but none reach buy threshold
 *
 * Returns { defensive: bool, reason: string, score: number }
 * When defensive=true, ALL buy decisions are skipped (sells still allowed).
 */
function checkThinkTankGate(pf, pipelineResults) {
  let score = 0;
  const reasons = [];

  // 1. Factor health check — lowered threshold: 2+ COLD factors is meaningful degradation
  try {
    const factorPerf = require('./analysis/factor_performance');
    const coldFactors = factorPerf.getColdFactors();
    if (coldFactors.size >= 2) {
      score += 3;
      reasons.push('因子信号大面积偏冷(' + coldFactors.size + '/9个COLD)');
    } else if (coldFactors.size >= 1) {
      score += 1;
      reasons.push('存在' + coldFactors.size + '个冷因子');
    }
  } catch (_) { /* factor_performance not available */ }

  // 2. Portfolio stress check
  const snapshot = getSnapshot(pf);
  const posCount = pf.positions.length;
  const totalReturn = snapshot.totalReturn;
  if (posCount >= 3 && totalReturn < -3) {
    score += 3;
    reasons.push('持仓' + posCount + '只浮亏' + safeFixed(totalReturn, 1) + '%');
  } else if (totalReturn < -5) {
    score += 2;
    reasons.push('总收益低于-5%');
  }

  // 3. Consecutive loss days — persistent drawdown indicates systemic issues
  const navs = pf.dailyNav || [];
  let consecutiveLossDays = 0;
  for (let i = navs.length - 1; i >= 0; i--) {
    const ret = navs[i].return_ != null ? navs[i].return_ : 0;
    if (ret < 0) consecutiveLossDays++;
    else break;
  }
  if (consecutiveLossDays >= 3) {
    score += 2;
    reasons.push('连续' + consecutiveLossDays + '日净值回撤');
  }

  // 4. Cross-market risk check
  try {
    const weekendCtx = loadWeekendContext();
    if (weekendCtx) {
      for (const insight of (weekendCtx.insights || [])) {
        if (insight.type === 'cross_market') {
          const txt = (insight.suggestedAction || '') + (insight.detail || '');
          if (txt.includes('防御模式') || txt.includes('恐慌') || txt.includes('避险')) {
            score += 2;
            reasons.push('跨市场风险：防御模式');
            break;
          }
        }
        if (insight.type === 'regime_alert' && insight.weight >= 3) {
          score += 1;
          reasons.push('周末危机预警活跃');
        }
      }
    }
  } catch (_) {}

  // 5. Signal-score divergence: many signals triggered but none reach buy threshold
  // This means the market is generating noise signals but no actionable opportunities
  if (pipelineResults && pipelineResults.length > 0) {
    const analyzed = pipelineResults.length;
    const highSignalCount = pipelineResults.filter(r =>
      r.hiddenSignals && r.hiddenSignals.length >= 2).length;
    const buyEligible = pipelineResults.filter(r =>
      r.compositeScore >= 55).length;
    if (analyzed >= 20 && buyEligible === 0 && highSignalCount >= 5) {
      score += 2;
      reasons.push('信号-评分背离：' + highSignalCount + '只触发信号但0只达买入标准');
    }
  }

  // 6. Knowledge base — historical factor combo check
  try {
    const knowledgeBase = require('./analysis/knowledge_base');
    const summary = knowledgeBase.getKnowledgeSummary();
    if (summary && summary.totalDays >= 2 && summary.factorTracker) {
      const ranked = (summary.factorTracker.factors || []).slice(0, 3).map(f => f.id);
      const coldNow = [];
      try {
        const fp = require('./analysis/factor_performance');
        const cold = fp.getColdFactors();
        for (const fid of ranked) {
          if (cold.has(fid)) coldNow.push(fid);
        }
      } catch (_) {}
      if (coldNow.length >= 2) {
        score += 1;
        reasons.push('知识库：历史高效因子' + coldNow.join('/') + '当前均偏冷');
      }
    }
  } catch (_) { /* knowledge_base not available */ }

  // Decision: score >= 3 → defensive.
  // Threshold 3 means: minor flags alone (1 cold factor, 1 weekend concern) won't block.
  // Requires a meaningful combination e.g., 2+ cold factors (3pts) OR portfolio stress
  // with 3+ positions < -3% (3pts) OR 3+ consecutive loss days + another flag.
  const defensive = score >= 3;

  // Build detailed breakdown for think-tank decision audit
  const breakdown = {
    factorHealth: { score: 0, detail: '因子信号正常', coldCount: 0 },
    portfolioStress: { score: 0, detail: '持仓状态正常' },
    consecutiveLoss: { score: 0, detail: '净值未连续回撤' },
    crossMarketRisk: { score: 0, detail: '无周末防御信号' },
    signalDivergence: { score: 0, detail: '评分-信号匹配正常' },
    knowledgeBase: { score: 0, detail: '历史高效因子正常' },
  };
  // Re-compute breakdown from reasons for front-end display
  try {
    const factorPerf = require('./analysis/factor_performance');
    const coldFactors = factorPerf.getColdFactors();
    if (coldFactors.size >= 2) {
      breakdown.factorHealth = { score: 3, detail: coldFactors.size + '个冷因子', coldCount: coldFactors.size };
    } else if (coldFactors.size >= 1) {
      breakdown.factorHealth = { score: 1, detail: coldFactors.size + '个冷因子', coldCount: coldFactors.size };
    }
  } catch (_) {}
  if (posCount >= 3 && totalReturn < -3) {
    breakdown.portfolioStress = { score: 3, detail: '持仓' + posCount + '只，浮亏' + safeFixed(totalReturn, 1) + '%' };
  } else if (totalReturn < -5) {
    breakdown.portfolioStress = { score: 2, detail: '总收益低于-5%(' + safeFixed(totalReturn, 1) + '%)' };
  }
  if (consecutiveLossDays >= 3) {
    breakdown.consecutiveLoss = { score: 2, detail: '连续' + consecutiveLossDays + '日净值回撤' };
  }
  try {
    const weekendCtx = loadWeekendContext();
    if (weekendCtx) {
      for (const insight of (weekendCtx.insights || [])) {
        if (insight.type === 'cross_market') {
          const txt = (insight.suggestedAction || '') + (insight.detail || '');
          if (txt.includes('防御模式') || txt.includes('恐慌') || txt.includes('避险')) {
            breakdown.crossMarketRisk = { score: 2, detail: '跨市场防御模式' };
            break;
          }
        }
        if (insight.type === 'regime_alert' && insight.weight >= 3) {
          breakdown.crossMarketRisk = { score: 1, detail: '周末危机预警活跃' };
        }
      }
    }
  } catch (_) {}
  if (pipelineResults && pipelineResults.length > 0) {
    const analyzed = pipelineResults.length;
    const highSignalCount = pipelineResults.filter(r => r.hiddenSignals && r.hiddenSignals.length >= 2).length;
    const buyEligible = pipelineResults.filter(r => r.compositeScore >= 55).length;
    if (analyzed >= 20 && buyEligible === 0 && highSignalCount >= 5) {
      breakdown.signalDivergence = { score: 2, detail: highSignalCount + '只触发信号但0只达买入标准' };
    }
  }
  try {
    const knowledgeBase = require('./analysis/knowledge_base');
    const summary = knowledgeBase.getKnowledgeSummary();
    if (summary && summary.totalDays >= 2 && summary.factorTracker) {
      const ranked = (summary.factorTracker.factors || []).slice(0, 3).map(f => f.id);
      const coldNow = [];
      try { const fp = require('./analysis/factor_performance'); const cold = fp.getColdFactors(); for (const fid of ranked) { if (cold.has(fid)) coldNow.push(fid); } } catch (_) {}
      if (coldNow.length >= 2) {
        breakdown.knowledgeBase = { score: 1, detail: '历史高效因子' + coldNow.join('/') + '当前偏冷' };
      }
    }
  } catch (_) {}

  return {
    defensive,
    score,
    breakdown,
    reason: defensive
      ? '思维舱综合评分' + score + '分：' + reasons.join('；') + ' — 跳过所有买入'
      : (reasons.length > 0 ? '思维舱关注：' + reasons.join('；') : '思维舱评估：信号正常'),
  };
}

// ==================== 交易风控门统一构建 ====================
// 所有门状态一次性计算，供 Think-Tank 前端决策审计面板使用

function buildGateResults(pf, indices, macroContext, thinkTankGate, avoidSectors) {
  const ddLevel = (pf._drawdownLevel && pf._drawdownLevel.level) || 'normal';
  // FIX v2.8.1: _drawdownLevel has { level, message, threshold } — no currentDrawdown field.
  // Actual drawdown is stored in pf._stats.maxDrawdown (set by recordDailyNAV/computeStats).
  const ddCurrent = (pf._stats && pf._stats.maxDrawdown != null) ? pf._stats.maxDrawdown : 0;
  const ddMax = ddCurrent;

  const shIdx = indices && indices.find(i => i.code === '000001' || i.code === 'sh000001');
  const marketBlocked = shIdx && shIdx.changePercent != null && shIdx.changePercent < -0.5;

  const regime = (macroContext && macroContext.riskState) ? macroContext.riskState.regime : null;
  const circuitBlocked = regime === 'panic' || regime === 'risk_off';
  const regimeLabel = regime === 'panic' ? '恐慌' : (regime === 'risk_off' ? '避险' : (regime === 'neutral' ? '中性' : (regime === 'slightly_bullish' ? '温和看涨' : (regime || '未知'))));

  // Portfolio-in-loss gate: blocks buys when total return < -5% with 3+ positions
  var pfSnap = getSnapshot(pf);
  var lossBlocked = pfSnap.totalReturn < -5 && pf.positions.length >= 3;

  return {
    drawdown: {
      status: ddLevel === 'halt' ? 'block' : (ddLevel === 'restrict' ? 'restrict' : (ddLevel === 'warn' ? 'warn' : 'pass')),
      level: ddLevel,
      currentDrawdown: Math.round(ddCurrent * 100) / 100,
      maxDrawdown: Math.round(ddMax * 100) / 100,
      description: ddLevel === 'halt'
        ? '回撤熔断(' + safeFixed(ddCurrent, 1) + '%)，禁止所有买入'
        : (ddLevel === 'restrict'
          ? '回撤限仓(' + safeFixed(ddCurrent, 1) + '%)，每日最多1只买入'
          : (ddLevel === 'warn'
            ? '回撤警告(' + safeFixed(ddCurrent, 1) + '%)，距限仓线还有' + safeFixed(Math.abs(-8 - ddCurrent), 1) + '%'
            : '回撤正常(' + safeFixed(ddCurrent, 1) + '%)，距警告线(-5%)还有' + safeFixed(Math.abs(-5 - ddCurrent), 1) + '%空间')),
    },
    marketDirection: {
      status: marketBlocked ? 'block' : 'pass',
      shIndex: shIdx ? shIdx.price : null,
      changePercent: (shIdx && shIdx.changePercent != null) ? Math.round(shIdx.changePercent * 100) / 100 : null,
      description: marketBlocked
        ? '上证跌幅' + (shIdx && shIdx.changePercent != null ? shIdx.changePercent.toFixed(2) : '?') + '%超过-0.5%阈值，禁止买入'
        : (shIdx && shIdx.changePercent != null ? '上证' + (shIdx.changePercent >= 0 ? '涨' : '跌') + Math.abs(shIdx.changePercent).toFixed(2) + '%，方向正常' : '无上证指数数据'),
    },
    circuitBreaker: {
      status: circuitBlocked ? 'block' : 'pass',
      riskRegime: regime || 'unknown',
      riskLabel: regimeLabel,
      description: circuitBlocked
        ? '跨市场' + (regime === 'panic' ? '恐慌' : '避险') + '熔断，禁止所有买入'
        : (regime ? '跨市场风险' + regimeLabel + '，未触发熔断' : '无跨市场数据'),
    },
    portfolioInLoss: {
      status: lossBlocked ? 'block' : 'pass',
      totalReturn: pfSnap.totalReturn,
      positionCount: pf.positions.length,
      threshold: -5,
      description: lossBlocked
        ? '组合浮亏' + safeFixed(pfSnap.totalReturn, 1) + '%（持有' + pf.positions.length + '只），暂停新买入。等待持仓恢复或止损出场后自动解除'
        : '组合浮亏' + safeFixed(pfSnap.totalReturn, 1) + '%（持有' + pf.positions.length + '只），未触发保护（需<-5%且≥3只）',
    },
    thinkTankDefense: {
      status: (thinkTankGate && thinkTankGate.defensive) ? 'block' : 'pass',
      score: thinkTankGate ? thinkTankGate.score : 0,
      threshold: 3,
      breakdown: thinkTankGate ? (thinkTankGate.breakdown || {}) : {},
      timestamp: new Date().toISOString(),
      description: (thinkTankGate && thinkTankGate.defensive)
        ? '思维舱防御得分' + thinkTankGate.score + '/6≥阈值3，跳过买入 — ' + (thinkTankGate.reason || '')
        : (thinkTankGate ? '防御得分' + thinkTankGate.score + '/6，低于阈值3，通过' : '未执行思维舱检测'),
    },
    attributionAvoid: {
      status: (avoidSectors && avoidSectors.length > 0) ? 'active' : 'inactive',
      avoidSectors: avoidSectors || [],
      description: (avoidSectors && avoidSectors.length > 0)
        ? '归因避让板块：' + avoidSectors.join('、') + '（触发硬止损后避让）'
        : '无归因避让板块',
    },
    dataQuality: (function() {
      try {
        const dq = require('./analysis/data_quality');
        const dqr = dq.computeConfidencePenalty();
        return {
          penalty: dqr.penalty || 0,
          reasons: dqr.reasons || [],
          overallScore: dqr.overallScore || 0,
          description: (dqr.penalty > 0)
            ? '数据质量惩罚-' + dqr.penalty + '分：' + (dqr.reasons || []).join('；')
            : '数据质量正常，无惩罚',
        };
      } catch (_) {
        return { penalty: 0, reasons: [], overallScore: 0, description: '数据质量检查不可用' };
      }
    })(),
  };
}

function makeTradingDecisions(pf, pipelineResults, indices, scanType, macroContext) {
  const decisions = [];
  const today = new Date().toISOString().slice(0, 10);
  const isFullScan = scanType === 'full';

  // Guard: if no index data available, skip trade decisions entirely
  // This happens during non-trading hours, weekends, holidays, or when the
  // index API returns empty data. Without market context, decisions are unsafe.
  if (!indices || !Array.isArray(indices) || indices.length === 0) {
    return {
      decisions: [],
      executed: [],
      snapshot: getSnapshot(pf),
      noMarketData: true,
      reason: '无指数行情数据，跳过交易决策（非交易时段或API不可达）',
      gateResults: buildGateResults(pf, indices, macroContext, null, []),
    };
  }

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

  // ---- Step 3: Drawdown gate ----
  // P0-1: Check portfolio drawdown level. At -10% halt, at -8% restrict, at -5% warn.
  // This protects against continued bleeding — when the account is down significantly,
  // stop adding new positions until conditions improve.
  const ddLevel = (pf._drawdownLevel && pf._drawdownLevel.level) || 'normal';
  if (ddLevel === 'halt') {
    const sellDecisions = decisions.filter(d => d.action === 'sell');
    const executedTrades = [];
    for (const dec of sellDecisions) {
      if (dec.action === 'sell') {
        const trade = executeSell(pf, dec, today);
        if (trade) executedTrades.push(trade);
      }
    }
    for (const pos of pf.positions) {
      const stockData = pipelineResults.find(r => r.code === pos.code);
      if (stockData) pos.currentPrice = stockData.price;
    }
    recordDailyNAV(pf, today);
    savePortfolio(pf);
    return {
      decisions: sellDecisions,
      executed: executedTrades,
      snapshot: getSnapshot(pf),
      drawdownGateActive: true,
      drawdownGateReason: pf._drawdownLevel.message,
      gateResults: buildGateResults(pf, indices, macroContext, null, []),
    };
  }

  // ---- Step 3a: Market direction gate ----
  // If Shanghai Composite is down more than 0.5%, skip all buy decisions.
  // Sells are still allowed — if we need to cut losses, we do it regardless.
  // This prevents buying into a falling market.
  const shIdx = indices && indices.find(i => i.code === '000001' || i.code === 'sh000001');
  if (shIdx && shIdx.changePercent != null && shIdx.changePercent < -0.5) {
    // Market is falling — skip buys, only process sells
    const sellDecisions = decisions.filter(d => d.action === 'sell');
    const executedTrades = [];
    for (const dec of sellDecisions) {
      if (dec.action === 'sell') {
        const trade = executeSell(pf, dec, today);
        if (trade) executedTrades.push(trade);
      }
    }

    // Update position prices and NAV even when skipping buys
    for (const pos of pf.positions) {
      const stockData = pipelineResults.find(r => r.code === pos.code);
      if (stockData) pos.currentPrice = stockData.price;
    }
    recordDailyNAV(pf, today);
    savePortfolio(pf);

    // Log the gate event
    const pf2 = loadPortfolio(); // re-read to get updated state
    return {
      decisions: sellDecisions,
      executed: executedTrades,
      snapshot: getSnapshot(pf),
      marketGateActive: true,
      marketGateReason: '上证跌幅' + shIdx.changePercent.toFixed(2) + '%超过-0.5%阈值，跳过所有买入',
      gateResults: buildGateResults(pf, indices, macroContext, null, []),
    };
  }

  // ---- Step 3.5a: Cross-market risk CIRCUIT BREAKER ----
  // Panic or risk_off regime = HARD BLOCK on all buys. Sells only.
  // This is NOT a scoring penalty — it's a complete buy prohibition.
  // When macro risk is "panic" or "risk_off", no individual stock score
  // can justify buying. We simply stop buying until conditions improve.
  if (macroContext && macroContext.riskState) {
    const regime = macroContext.riskState.regime;
    if (regime === 'panic' || regime === 'risk_off') {
      const sellDecisions = decisions.filter(d => d.action === 'sell');
      const executedTrades = [];
      for (const dec of sellDecisions) {
        if (dec.action === 'sell') {
          const trade = executeSell(pf, dec, today);
          if (trade) executedTrades.push(trade);
        }
      }
      for (const pos of pf.positions) {
        const stockData = pipelineResults.find(r => r.code === pos.code);
        if (stockData) pos.currentPrice = stockData.price;
      }
      recordDailyNAV(pf, today);
      savePortfolio(pf);
      return {
        decisions: sellDecisions,
        executed: executedTrades,
        snapshot: getSnapshot(pf),
        circuitBreakerActive: true,
        circuitBreakerReason: '跨市场风险熔断：' +
          (regime === 'panic' ? '恐慌状态，禁止所有买入（仅允许卖出）' : '避险状态，禁止所有买入（仅允许卖出）'),
        gateResults: buildGateResults(pf, indices, macroContext, null, []),
      };
    }
  }

  // ---- Step 3.5b: Think-Tank defensive gate ----
  // Synthesizes factor health, portfolio status, and cross-market risk
  // into a single defensive-or-not decision. When defensive, skip all buys
  // regardless of market direction — the system's own "brain" says don't trade.
  const thinkTankGate = checkThinkTankGate(pf, pipelineResults);
  if (thinkTankGate.defensive) {
    const sellDecisions = decisions.filter(d => d.action === 'sell');
    const executedTrades = [];
    for (const dec of sellDecisions) {
      if (dec.action === 'sell') {
        const trade = executeSell(pf, dec, today);
        if (trade) executedTrades.push(trade);
      }
    }

    for (const pos of pf.positions) {
      const stockData = pipelineResults.find(r => r.code === pos.code);
      if (stockData) pos.currentPrice = stockData.price;
    }
    recordDailyNAV(pf, today);
    savePortfolio(pf);

    return {
      decisions: sellDecisions,
      executed: executedTrades,
      snapshot: getSnapshot(pf),
      thinkTankDefensive: true,
      thinkTankReason: thinkTankGate.reason,
      gateResults: buildGateResults(pf, indices, macroContext, thinkTankGate, []),
    };
  }

  // ---- Step 4: Apply macro risk penalty + risk-regime sizing multiplier ----
  // Risk-off regime: reduce all composite scores by 5-8 points
  // Risk-regime sizing: scale position sizes to match risk appetite
  var macroPenalty = 0;
  var riskSizingMultiplier = 1.0; // from config positionSizing riskRegimeMultipliers
  if (macroContext && macroContext.riskState) {
    const regime = macroContext.riskState.regime;
    if (regime === 'risk_off' || regime === 'panic') {
      macroPenalty = 8;
    } else if (regime === 'slightly_bullish') {
      macroPenalty = 0;
    } else if (regime === 'neutral') {
      macroPenalty = 2;
    }
    // Sizing multiplier from config
    const sizing = config.SIMFOLIO.positionSizing || {};
    const multipliers = sizing.riskRegimeMultipliers || {};
    if (multipliers[regime] != null) {
      riskSizingMultiplier = multipliers[regime];
    }
  }
  if (macroPenalty > 0) {
    for (const r of pipelineResults) {
      if (r.compositeScore != null) {
        r.compositeScore = Math.max(0, r.compositeScore - macroPenalty);
      }
    }
  }

  // ---- Step 4.2: Data quality confidence penalty ----
  // When key data sources are DOWN/STALE/WARN, reduce all scores proportionally.
  // This prevents trading on stale or incomplete data.
  var dataQualityPenalty = 0;
  var dqReasons = [];
  try {
    const dq = require('./analysis/data_quality');
    const dqResult = dq.computeConfidencePenalty();
    dataQualityPenalty = dqResult.penalty || 0;
    dqReasons = dqResult.reasons || [];
  } catch (_) { /* data_quality not available */ }
  if (dataQualityPenalty > 0) {
    for (const r of pipelineResults) {
      if (r.compositeScore != null) {
        r.compositeScore = Math.max(0, r.compositeScore - dataQualityPenalty);
      }
    }
    // Log once per pipeline run
    if (dqReasons.length > 0) {
      console.log('  [Simfolio] 数据质量惩罚: -' + dataQualityPenalty + '分 (' + dqReasons.join('; ') + ')');
    }
  }

  // ---- Step 4.5: Apply weekend analysis context ----
  const weekendContext = loadWeekendContext();
  let weekendSectorBonus = new Map();   // sector -> bonus points
  let weekendSectorPenalty = new Map(); // sector -> penalty points
  let weekendPositionMultiplier = 1.0;   // cash allocation multiplier

  // P1-1: Factor performance feedback — penalize stocks triggering COLD factors
  let coldFactors = new Set();
  try {
    const factorPerf = require('./analysis/factor_performance');
    coldFactors = factorPerf.getColdFactors();
  } catch (_) { /* factor_performance not available */ }

  // Apply cold factor penalty to pipeline results BEFORE sorting/buying
  if (coldFactors.size > 0) {
    for (const r of pipelineResults) {
      if (r.compositeScore == null) continue;
      const signals = r.hiddenSignals || [];
      for (const s of signals) {
        if (coldFactors.has(s.id)) {
          // Each COLD factor that triggered = -3 points
          r.compositeScore = Math.max(0, r.compositeScore - 3);
        }
      }
    }
  }

  // 周末分析输出的中文板块名 -> classifySector 使用的中文板块名（一致，直接匹配）
  const WEEKEND_SECTOR_KEYWORDS = {
    '半导体/AI算力': ['半导体/AI算力', '半导体', 'AI算力'],
    '创新药/AI医疗': ['创新药/AI医疗', '创新药', 'AI医疗'],
    '固态电池/储能': ['固态电池/储能', '固态电池', '储能'],
    '机器人/具身智能': ['机器人/具身智能', '机器人', '具身智能'],
    '有色金属/稀土': ['有色金属/稀土', '有色金属', '稀土'],
    '金融': ['金融'],
    '军工/商业航天': ['军工/商业航天', '军工', '商业航天'],
    '新型电力基建': ['新型电力基建', '电力基建'],
  };

  if (weekendContext) {
    for (const insight of weekendContext.insights) {
      if (insight.type === 'sector_preference') {
        // 在 insight 文本中匹配中文板块名
        const actionText = (insight.suggestedAction || '') + (insight.detail || '') + (insight.title || '');
        for (const [cnSector, keywords] of Object.entries(WEEKEND_SECTOR_KEYWORDS)) {
          if (keywords.some(kw => actionText.includes(kw))) {
            weekendSectorBonus.set(cnSector, 3);
          }
        }
        // 防守板块额外加分
        if (actionText.includes('防守') || actionText.includes('金融') ||
            actionText.includes('有色金属') || actionText.includes('电力基建')) {
          for (const defSector of ['金融', '有色金属/稀土', '新型电力基建']) {
            weekendSectorBonus.set(defSector, (weekendSectorBonus.get(defSector) || 0) + 2);
          }
        }
      }
      if (insight.type === 'position_sizing') {
        // Adjust cash allocation multiplier
        if (insight.suggestedAction.includes('50%') || insight.weight >= 2) {
          weekendPositionMultiplier = 0.5;
        }
      }
      if (insight.type === 'regime_alert') {
        // Additional risk penalty for all stocks
        for (const r of pipelineResults) {
          if (r.compositeScore != null) {
            r.compositeScore = Math.max(0, r.compositeScore - insight.weight);
          }
        }
      }
      if (insight.type === 'cross_market') {
        // 跨市场风险：恐慌/避险时全市场减分
        const actionText = (insight.suggestedAction || '') + (insight.detail || '');
        if (actionText.includes('防御模式') || actionText.includes('恐慌') || actionText.includes('避险')) {
          for (const r of pipelineResults) {
            if (r.compositeScore != null) {
              r.compositeScore = Math.max(0, r.compositeScore - 3);
            }
          }
          weekendPositionMultiplier = Math.min(weekendPositionMultiplier, 0.5);
        }
      }
    }
  }

  // Apply sector bonuses from weekend context
  if (weekendSectorBonus.size > 0 || weekendSectorPenalty.size > 0) {
    for (const r of pipelineResults) {
      const sector = classifySector(r.name);
      const bonus = weekendSectorBonus.get(sector) || 0;
      const penalty = weekendSectorPenalty.get(sector) || 0;
      if (r.compositeScore != null && (bonus > 0 || penalty > 0)) {
        r.compositeScore = Math.max(0, r.compositeScore + bonus - penalty);
      }
    }
  }

  // ---- Step 5: Look for buy candidates ----
  const maxSectorExposure = (config.SIMFOLIO && config.SIMFOLIO.maxSectorExposurePct) || 0.40;
  const MAX_SAME_SECTOR_POSITIONS = 2;

  // P2: Market cycle position limit — adjust max positions based on A-share cycle
  let maxPositionsByCycle = config.SIMFOLIO.maxPositions;
  let marketCycleForPredict = null;
  try {
    const marketCycle = require('./analysis/market_cycle');
    const cycle = marketCycle.getMarketCycle();
    if (cycle && cycle.suggestedMaxPositions != null) {
      maxPositionsByCycle = Math.min(config.SIMFOLIO.maxPositions, cycle.suggestedMaxPositions);
    }
    marketCycleForPredict = cycle;
  } catch (_) { /* market_cycle not available, use default */ }

  // P3: === Prediction-based buy candidate selection ===
  // When useExpectedReturnRanking is enabled, rank stocks by expected 5-day return
  // instead of hard score thresholds. Falls back to legacy percentile logic otherwise.
  const useExpectedReturn = (config.PREDICTION && config.PREDICTION.useExpectedReturnRanking);
  let buyCandidates = [];
  let predictionContext = null;

  if (useExpectedReturn) {
    // Build prediction context
    try {
      const stockPredictor = require('./predict/stock_predictor');
      const expectedReturn = require('./predict/expected_return');
      const factorPerfMod = require('./analysis/factor_performance');

      const stockFactorPerf = stockPredictor.computeStockFactorPerformance(3);
      const nbPerf = factorPerfMod.getNBPerformance();

      // Compute sector flow rank for each stock
      const sectorFlowMap = new Map();
      // (sectorFlowMap is built from enrichment data in pipeline — use what we have)

      predictionContext = {
        stockFactorPerf: stockFactorPerf,
        marketCycle: marketCycleForPredict,
        nbPerf: nbPerf,
        weekendContext: weekendContext,
      };

      // Rank by expected return
      const ranked = expectedReturn.rankByExpectedReturn(pipelineResults, predictionContext);

      // Filter and extract
      const minExpectedReturn = (config.PREDICTION && config.PREDICTION.minExpectedReturn) || 0;
      buyCandidates = ranked
        .filter(r => {
          if (pf.positions.some(p => p.code === r.code)) return false;
          if (!r.prediction || r.prediction.expectedReturn < minExpectedReturn) return false;
          const candidateSector = classifySector(r.name);
          if (candidateSector !== '其他') {
            const sameSectorCount = pf.positions.filter(p => classifySector(p.name) === candidateSector).length;
            if (sameSectorCount >= MAX_SAME_SECTOR_POSITIONS) return false;
            if (getSectorExposure(pf, candidateSector, null) >= maxSectorExposure) return false;
          }
          return true;
        });
      // Already sorted by expectedReturn descending from rankByExpectedReturn
    } catch (_) {
      // Fall through to legacy logic
      useExpectedReturn === false; // (actually disable for this run)
    }
  }

  // Fallback: legacy percentile-based threshold logic
  if (!useExpectedReturn || buyCandidates.length === 0) {
    if (buyCandidates.length === 0 && useExpectedReturn) {
      // Prediction mode ran but produced no candidates — don't revert to legacy
      // (it's intentional: no stocks meet the expected return threshold)
    } else if (!useExpectedReturn) {
      // Legacy path
      const scoredWithScores = pipelineResults
        .filter(r => r.compositeScore != null)
        .map(r => r.compositeScore)
        .sort((a, b) => b - a);

      const pctBuy = (config.BUY_THRESHOLD && config.BUY_THRESHOLD.percentileTop) || 0.20;
      const pctStrong = (config.BUY_THRESHOLD && config.BUY_THRESHOLD.percentileStrong) || 0.10;
      const minAbsolute = (config.BUY_THRESHOLD && config.BUY_THRESHOLD.minAbsoluteScore) || 50;
      const minStrongScore = (config.BUY_THRESHOLD && config.BUY_THRESHOLD.minStrongScore) || 70;

      let effectiveMinAbsolute = minAbsolute;
      let effectiveMinStrong = minStrongScore;
      const dtConfig = (config.SIMFOLIO && config.SIMFOLIO.dynamicThreshold) || {};
      const weakTopScore = dtConfig.weakTopScore || 65;
      const raisedMinScore = dtConfig.raisedMinScore || 60;
      const checkWindow = dtConfig.checkWindow || 2;
      try {
        const simfolioDir = path.join(config.REPORT_ENGINE_DIR, 'data', 'simfolio');
        const lastResultPath = path.join(simfolioDir, 'last_pipeline_result.json');
        if (fs.existsSync(lastResultPath)) {
          const lastResult = JSON.parse(fs.readFileSync(lastResultPath, 'utf8'));
          if (lastResult.maxScore != null && lastResult.maxScore < weakTopScore) {
            effectiveMinAbsolute = Math.max(minAbsolute, raisedMinScore);
            effectiveMinStrong = Math.max(minStrongScore, raisedMinScore + 5);
          }
        }
        const todayDate = new Date().toISOString().slice(0, 10);
        let lowScoreDays = (lastResult && lastResult.maxScore != null && lastResult.maxScore < weakTopScore) ? 1 : 0;
        for (let d = 1; d <= checkWindow; d++) {
          const pastDate = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
          const pastPath = path.join(config.REPORT_ENGINE_DIR, 'data', 'simfolio', 'scan_records_' + pastDate + '.json');
          if (fs.existsSync(pastPath)) {
            try {
              const pastRec = JSON.parse(fs.readFileSync(pastPath, 'utf8'));
              if (pastRec.maxScore != null && pastRec.maxScore < weakTopScore) lowScoreDays++;
            } catch (_) {}
          }
        }
        if (lowScoreDays >= checkWindow) {
          effectiveMinAbsolute = Math.max(minAbsolute, raisedMinScore);
          effectiveMinStrong = Math.max(minStrongScore, raisedMinScore + 5);
        }
      } catch (_) {}

      let buyThreshold = effectiveMinAbsolute;
      let strongThreshold = Math.max(effectiveMinStrong, effectiveMinAbsolute + 5);
      if (scoredWithScores.length > 0) {
        const buyIdx = Math.max(0, Math.floor(scoredWithScores.length * pctBuy) - 1);
        const strongIdx = Math.max(0, Math.floor(scoredWithScores.length * pctStrong) - 1);
        buyThreshold = Math.max(minAbsolute, scoredWithScores[buyIdx] || 0);
        strongThreshold = Math.max(strongThreshold, scoredWithScores[strongIdx] || 0);
      }

      buyCandidates = pipelineResults
        .filter(r => {
          if (pf.positions.some(p => p.code === r.code)) return false;
          if (r.compositeScore < buyThreshold) return false;
          const candidateSector = classifySector(r.name);
          if (candidateSector !== '其他') {
            const sameSectorCount = pf.positions.filter(p => classifySector(p.name) === candidateSector).length;
            if (sameSectorCount >= MAX_SAME_SECTOR_POSITIONS) return false;
            if (getSectorExposure(pf, candidateSector, null) >= maxSectorExposure) return false;
          }
          return true;
        })
        .sort((a, b) => b.compositeScore - a.compositeScore);
    }
  }

  // How many slots available?
  const availableSlots = maxPositionsByCycle - pf.positions.length + decisions.filter(d => d.action === 'sell').length;

  // P0-2: Staggered position building rules
  // Rule 1: Max buys per day from config
  const MAX_BUYS_PER_DAY = (config.SIMFOLIO && config.SIMFOLIO.maxBuysPerDay) || 2;
  const MAX_BUYS_REDUCED = (config.SIMFOLIO && config.SIMFOLIO.maxBuysPerDayReduced) || 1;
  // Rule 2: If portfolio has 3+ positions (post-sell) AND total return < -5%, don't add more.
  // Post-sell count: pending sells reduce the effective position count,
  // so a portfolio with 3 positions and 2 pending sells is treated as 1 position.
  const snapshot = getSnapshot(pf);
  const pendingSells = decisions.filter(function(d) { return d.action === 'sell'; }).length;
  const postSellPositionCount = pf.positions.length - pendingSells;
  const portfolioInLoss = snapshot.totalReturn < -5 && postSellPositionCount >= 3;
  // Rule 3: If already have 3+ positions, max 1 new buy per day (reduced mode)
  // Rule 4: P0-1 Drawdown restrict — force reduced mode (max 1 buy)
  let effectiveMaxBuys = pf.positions.length >= 3 ? MAX_BUYS_REDUCED : MAX_BUYS_PER_DAY;
  if (ddLevel === 'restrict') {
    effectiveMaxBuys = Math.min(effectiveMaxBuys, MAX_BUYS_REDUCED);
  }
  // Rule 5: P0-2 minimum cooldown between buys — from config (default 30 min)
  const BUY_COOLDOWN_MS = ((config.SIMFOLIO && config.SIMFOLIO.buyCooldownMin) || 30) * 60 * 1000;
  // (enforced by counting buys already executed today from tradeHistory)

  if (portfolioInLoss) {
    // Skip all buys — portfolio is losing money with 3+ positions.
    // Focus on managing existing positions before adding new ones.
    // This is logged in the trade_skip event below.
  } else if (availableSlots > 0 && effectiveMaxBuys > 0) {
    // P0-2: cooldown between buys on the same day
    const todayBuys = pf.tradeHistory.filter(t =>
      t.date === today && t.action === 'buy'
    );
    const lastBuyTime = todayBuys.length > 0
      ? new Date(today + 'T' + (todayBuys[todayBuys.length - 1].time || '00:00:00') + '+08:00').getTime()
      : 0;

    // P3 Loop 5: Check sector avoid list from trade attribution
    let avoidSectors = [];
    try {
      const tradeAttr = require('./predict/trade_attribution');
      avoidSectors = tradeAttr.getAvoidSectors();
    } catch (_) {}

    for (const candidate of buyCandidates) {
      const buyDecisionsSoFar = decisions.filter(d => d.action === 'buy').length;
      if (buyDecisionsSoFar >= effectiveMaxBuys) break;
      if (buyDecisionsSoFar >= availableSlots) break;

      // P3 Loop 5: Skip candidates in avoid-sectors (triggered by recent stop-loss attribution)
      if (avoidSectors.length > 0) {
        const candidateSector = classifySector(candidate.name);
        if (avoidSectors.includes(candidateSector)) continue;
      }

      // P0-2: 30-min cooldown — if we already executed a buy today and
      // < 30 min have passed, skip any further buys this scan cycle.
      // The cooldown is checked on each pipeline run, so after 30 min the
      // next scan cycle will pick up the next candidate naturally.
      if (buyDecisionsSoFar >= 1 && lastBuyTime > 0 &&
          (Date.now() - lastBuyTime) < BUY_COOLDOWN_MS) {
        break;
      }

      // Strong buy: top percentile AND hasStrongSignal (legacy)
      // OR prediction-based: expected return > 2% AND confidence >= 0.5
      let isStrong = candidate.hasStrongSignal || false;
      if (useExpectedReturn && candidate.prediction) {
        isStrong = candidate.prediction.expectedReturn > 2 && candidate.prediction.confidence >= 0.5;
      }
      // Combine weekend multiplier and risk regime multiplier
      const combinedMultiplier = weekendPositionMultiplier * riskSizingMultiplier;
      const buyDecision = checkBuySignal(candidate, pf, isStrong, combinedMultiplier);
      if (buyDecision) {
        // Attach prediction data to the decision for traceability
        if (candidate.prediction) {
          buyDecision.analysisContext.expectedReturn = candidate.prediction.expectedReturn;
          buyDecision.analysisContext.predictionBreakdown = candidate.prediction.breakdown;
          buyDecision.analysisContext.predictionConfidence = candidate.prediction.confidence;
        }
        decisions.push(buyDecision);
      }
    }
  }

  // ---- Step 6: Execute decisions ----
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

  // ---- Step 7: Update position prices ----
  for (const pos of pf.positions) {
    const stockData = pipelineResults.find(r => r.code === pos.code);
    if (stockData) {
      pos.currentPrice = stockData.price;
    }
  }

  // ---- Step 8: Record daily NAV ----
  recordDailyNAV(pf, today);

  savePortfolio(pf);

  // Collect near-misses: stocks that were analyzed but not bought, with reason
  const nearMisses = [];
  for (const candidate of buyCandidates) {
    const wasBought = decisions.some(d => d.action === 'buy' && d.code === candidate.code);
    if (wasBought) continue;
    let reason = '';
    if (avoidSectors.length > 0 && avoidSectors.includes(classifySector(candidate.name))) {
      reason = '归因避让板块:' + classifySector(candidate.name);
    } else if (candidate.compositeScore < (config.BUY_THRESHOLD && config.BUY_THRESHOLD.minAbsoluteScore || 50)) {
      reason = '低于买入阈值(' + (config.BUY_THRESHOLD && config.BUY_THRESHOLD.minAbsoluteScore || 50) + '分)';
    } else if (portfolioInLoss) {
      reason = '组合浮亏中，暂停新买入';
    } else {
      reason = '未达买入条件(仓位/间隔限制)';
    }
    nearMisses.push({
      code: candidate.code,
      name: candidate.name,
      score: candidate.compositeScore || 0,
      rating: candidate.rating || '--',
      reason: reason,
      signals: (candidate.hiddenSignals || []).map(s => s.id),
    });
  }

  return {
    decisions: decisions,
    executed: executedTrades,
    snapshot: getSnapshot(pf),
    nearMisses: nearMisses.slice(0, 10),
    gateResults: buildGateResults(pf, indices, macroContext, thinkTankGate, avoidSectors),
  };
}

// ---- Sell Signal Detection ----

function checkSellSignal(position, stockData, isBoughtToday, isFullScan) {
  const pnlPct = (stockData.price - position.avgCost) / position.avgCost * 100;
  const stopLossPct = config.SIMFOLIO.stopLossPct * 100; // e.g. -8

  // P1-6: Hard stop loss — trigger at -8% or worse (always active, even T+1).
  // Uses <= to catch gap-downs where price is already below the stop line
  // (e.g. overnight gap to -10% should still trigger immediately).
  if (pnlPct <= stopLossPct) {
    const stopPrice = position.avgCost * (1 + config.SIMFOLIO.stopLossPct);
    const gapBelowStop = stockData.price <= stopPrice
      ? (stockData.price - stopPrice) / stopPrice * 100
      : 0;
    const gapNote = gapBelowStop < -0.5
      ? '（跳空低开缺口' + Math.abs(gapBelowStop).toFixed(1) + '%，已穿透止损线）'
      : '';
    return '硬止损：亏损' + pnlPct.toFixed(1) + '%触发' + Math.abs(stopLossPct) + '%止损线' + gapNote;
  }

  // T+1: stocks bought today cannot be sold (except hard stop above)
  if (isBoughtToday) return null;

  // Soft stop: composite score dropped significantly
  // Only during FULL pipeline scans — mid-scan scores are less reliable
  // Threshold: < 35 (new score scale — was 45 when scores ran 76-81, now 55+ is good)
  if (isFullScan && stockData.compositeScore < 35) {
    return '软止损：综合评分降至' + stockData.compositeScore + '分（<35）';
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

// ---- Trend Filter ----

/**
 * Check if a stock is in an uptrend based on its K-line data.
 * Returns { passed: true/false, reason: '' }.
 *
 * Filters: price must be above MA20 (20-day moving average).
 * If K-line data has < 20 bars, requires at least MA5 confirmation.
 */
function checkTrendFilter(stockData) {
  const klines = stockData.klines;
  if (!klines || klines.length === 0) {
    // No K-line data at all — reject (can't verify trend)
    return { passed: false, reason: '无K线数据，无法判断趋势' };
  }

  const closes = klines.map(k => k.close);
  const price = stockData.price || closes[closes.length - 1];

  if (closes.length >= 20) {
    const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    if (price < ma20) {
      return { passed: false, reason: '股价¥' + price.toFixed(2) + '低于MA20(¥' + ma20.toFixed(2) + ')，不在上升趋势' };
    }
  } else if (closes.length >= 5) {
    // Fallback: use MA5 as minimum trend check
    const ma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    if (price < ma5) {
      return { passed: false, reason: '股价¥' + price.toFixed(2) + '低于MA5(¥' + ma5.toFixed(2) + ')，短期趋势不佳' };
    }
  } else {
    // < 5 bars — insufficient data, skip
    return { passed: false, reason: 'K线不足5日(仅' + closes.length + '条)，趋势数据不足' };
  }

  return { passed: true, reason: '' };
}

function checkBuySignal(stockData, pf, isStrong, combinedMultiplier) {
  const multiplier = (typeof combinedMultiplier === 'number' && combinedMultiplier > 0) ? combinedMultiplier : 1.0;

  // P0-2: Trend filter — reject stocks not in uptrend
  const trendCheck = checkTrendFilter(stockData);
  if (!trendCheck.passed) {
    return null; // silently skip, don't log per stock
  }

  // v3.0: Risk budget override — use volatility/Kelly/correlation-aware sizing
  const useRiskBudget = config.RISK_BUDGET && config.RISK_BUDGET.useVolatilityAdjustment;
  if (useRiskBudget) {
    try {
      const riskBudget = require('./analysis/risk_budget');
      // macroContext = { riskState: { regime, totalScore, ... } } from cross_market.getCachedRiskState()
      const marketCtx = {
        riskRegime: (macroContext && macroContext.riskState && macroContext.riskState.regime) || 'neutral',
        riskScore: (macroContext && macroContext.riskState && macroContext.riskState.totalScore) || 0,
      };
      const budget = riskBudget.computeRiskBudgetPosition(
        { code: stockData.code, name: stockData.name, price: stockData.price, compositeScore: stockData.compositeScore, expectedReturn: stockData.expectedReturn },
        pf,
        marketCtx
      );
      if (budget.blockers && budget.blockers.length > 0) {
        return null; // Blocked by risk budget (liquidity, circuit breaker)
      }
      if (budget.finalShares >= 100) {
        return {
          shares: budget.finalShares,
          allocation: budget.finalShares * stockData.price,
          reason: (isStrong ? '强买入' : '买入') + ' [风险预算' + Math.round(budget.finalWeight) + '%]',
          sizingMethod: 'risk_budget',
          riskBudgetDetails: budget,
        };
      }
    } catch (_) { /* fall through to legacy sizing */ }
  }

  // Tiered position sizing based on composite score and signal diversity
  const sizing = config.SIMFOLIO.positionSizing || {};
  const score = stockData.compositeScore || 0;
  const signalCount = (stockData.hiddenSignals || []).length;

  let allocationPct;
  if (isStrong) {
    const tiers = sizing.strongTiers || [
      { minScore: 85, allocation: 0.25 },
      { minScore: 75, allocation: 0.20 },
      { minScore: 65, allocation: 0.15 },
    ];
    allocationPct = 0.15; // fallback
    for (const tier of tiers) {
      if (score >= tier.minScore) { allocationPct = tier.allocation; break; }
    }
  } else {
    const tiers = sizing.normalTiers || [
      { minScore: 65, allocation: 0.12 },
      { minScore: 55, allocation: 0.08 },
    ];
    allocationPct = 0.08; // fallback
    for (const tier of tiers) {
      if (score >= tier.minScore) { allocationPct = tier.allocation; break; }
    }
  }

  // Signal diversity bonus: more distinct signals = higher conviction
  if (signalCount > 2) {
    const bonus = (sizing.signalCountBonus || 0.02) * (signalCount - 2);
    allocationPct += bonus;
  }

  const maxAllocation = sizing.maxAllocation || config.SIMFOLIO.maxSinglePositionPct || 0.30;
  allocationPct = Math.min(allocationPct, maxAllocation);

  // Apply combined multiplier (weekend × risk regime)
  allocationPct = allocationPct * multiplier;

  const allocation = Math.min(
    pf.cash * allocationPct,
    pf.meta.initialCapital * maxAllocation
  );
  const shares = Math.floor(allocation / stockData.price / 100) * 100;
  if (shares < 100) return null;

  return {
    action: 'buy',
    code: stockData.code,
    name: stockData.name,
    shares: shares,
    price: stockData.price,
    reason: buildBuyReason(stockData, isStrong),
    strength: isStrong ? 'strong' : 'normal',
    allocationPct: Math.round(allocationPct * 10000) / 100, // for logging
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

  // P3 Loop 5: Attribution analysis after each sell (parameter feedback loop)
  // v3.0: Enhanced with market context, timing quality, and sizing analysis
  try {
    const tradeAttr = require('./predict/trade_attribution');
    const buyTrade = pf.tradeHistory.filter(t => t.code === decision.code && t.action === 'buy').slice(-1)[0];
    const ctx = {
      stockFactorPerf: null,
      marketReturn: pf._benchmarkChange || 0,
      indices: pf._lastIndices || null,
      decisionTime: new Date().toISOString(),
    };
    try {
      const stockPredictor = require('./predict/stock_predictor');
      ctx.stockFactorPerf = stockPredictor.computeStockFactorPerformance(3);
    } catch (_) {}
    tradeAttr.analyzeAttribution(trade, buyTrade, pf, ctx);
  } catch (_) { /* attribution is advisory, never block on it */ }

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
  // Save latest indices for attribution context (v3.0)
  pf._lastIndices = {};
  for (const idx of indices) {
    if (idx.code && idx.price != null) {
      pf._lastIndices[idx.code] = { price: idx.price, changePercent: idx.changePercent };
    }
  }
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
  } else {
    pf.dailyNav.push({
      date: date,
      nav: snapshot.totalValue,
      return_: snapshot.totalReturn,
      benchmarkReturn: Math.round(benchmarkReturn * 100) / 100,
    });
  }

  // P0-1: Auto-compute performance stats on each NAV update
  const stats = computeStats(pf);
  if (!pf._stats) pf._stats = {};
  pf._stats.maxDrawdown = stats.maxDrawdown;
  pf._stats.sharpeRatio = stats.sharpeRatio;
  pf._stats.winRate = stats.winRate;
  pf._stats.updatedAt = new Date().toISOString();

  // P0-1: Store drawdown level for trade decision gate
  pf._drawdownLevel = getDrawdownLevel(stats.maxDrawdown);
}

// P0-1: Get drawdown severity level from config tiers
function getDrawdownLevel(maxDrawdown) {
  const tiers = (config.SIMFOLIO && config.SIMFOLIO.maxDrawdownTiers) || [
    { threshold: -5, action: 'warn' },
    { threshold: -8, action: 'restrict' },
    { threshold: -10, action: 'halt' },
  ];
  // Sort tiers by threshold descending (most severe first: -10 -> -8 -> -5)
  const sorted = [...tiers].sort((a, b) => a.threshold - b.threshold);
  for (const tier of sorted) {
    if (maxDrawdown <= tier.threshold) return { level: tier.action, message: tier.message, threshold: tier.threshold };
  }
  return { level: 'normal', message: '', threshold: 0 };
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
      drawdownLevel: 'normal',
      drawdownMessage: '',
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

  var ddInfo = getDrawdownLevel(Math.round(maxDD * 100) / 100);

  return {
    totalReturn: Math.round(totalReturn * 100) / 100,
    benchmarkReturn: Math.round(benchmarkReturn * 100) / 100,
    alpha: Math.round((totalReturn - benchmarkReturn) * 100) / 100,
    winRate: winRate,
    maxDrawdown: Math.round(maxDD * 100) / 100,
    sharpeRatio: sharpeRatio,
    totalTrades: pf.tradeHistory.length,
    avgHoldDays: null, // requires position-level tracking
    drawdownLevel: ddInfo.level,
    drawdownMessage: ddInfo.message,
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

    // P1-6: Gap-down stop-loss protection.
    // If the stock opened BELOW the -8% stop line (e.g. overnight gap down
    // of -10%), the price already blew past our stop. We must sell immediately
    // at the opening price — waiting only makes it worse.
    const stopPrice = pos.avgCost * (1 + config.SIMFOLIO.stopLossPct); // 0.92 * avgCost
    if (currentPrice <= stopPrice) {
      const gapPct = ((currentPrice - stopPrice) / stopPrice * 100);
      alerts.push({
        code: pos.code,
        name: pos.name,
        action: 'stop_loss',
        priority: 'critical',
        currentPrice,
        pnlPct: Math.round(pnlPct * 100) / 100,
        reason: '硬止损：亏损' + pnlPct.toFixed(1) + '%触发-8%止损线' +
          (gapPct < -0.5 ? '（跳空低开缺口' + Math.abs(gapPct).toFixed(1) + '%）' : ''),
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

  // P3 Loop 5: Attribution analysis after risk-triggered sell
  try {
    const tradeAttr = require('./predict/trade_attribution');
    const buyTrade = pf.tradeHistory.filter(t => t.code === alert.code && t.action === 'buy').slice(-1)[0];
    const ctx = { stockFactorPerf: null };
    try {
      const stockPredictor = require('./predict/stock_predictor');
      ctx.stockFactorPerf = stockPredictor.computeStockFactorPerformance(3);
    } catch (_) {}
    tradeAttr.analyzeAttribution(trade, buyTrade, pf, ctx);
  } catch (_) { /* advisory only */ }

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

// P1-1: Factor signal diagnostics — detect silent factors that never trigger
function factorSignalDiagnostics(factorPerformance, knowledgeBase) {
  const alerts = [];
  const silentAlarmDays = (config.FACTOR_DIAGNOSTICS && config.FACTOR_DIAGNOSTICS.silentAlarmDays) || 3;
  const minExpectedTriggered = (config.FACTOR_DIAGNOSTICS && config.FACTOR_DIAGNOSTICS.minExpectedTriggered) || 2;

  // 1. Check for silent factors (0 triggers over multiple days)
  if (factorPerformance && factorPerformance.factors) {
    const silent = factorPerformance.factors.filter(f => f.signalCount === 0 && f.totalSignalDays === 0);
    if (silent.length >= 5) {
      alerts.push({
        type: 'silent_factors',
        severity: 'warning',
        message: silent.length + '/9个因子从未触发（' +
          silent.map(f => f.id + ':' + f.name).join('、') +
          '），建议检查触发阈值是否过严',
        silentFactorIds: silent.map(f => f.id),
      });
    }
  }

  // 2. Check for low signal diversity (only 1-2 factors trigger all the time)
  if (factorPerformance && factorPerformance.factors) {
    const active = factorPerformance.factors.filter(f => f.signalCount > 0);
    if (active.length < minExpectedTriggered) {
      alerts.push({
        type: 'low_diversity',
        severity: 'info',
        message: '仅' + active.length + '/9个因子有信号（' +
          active.map(f => f.id + ':' + f.name).join('、') +
          '），信号多样性不足，综合评分区分度可能偏低',
      });
    }
  }

  // 3. Check knowledge base factor tracker for persistent zeroes
  if (knowledgeBase && knowledgeBase.factorTracker) {
    const ft = knowledgeBase.factorTracker;
    const factors = ft.factors || {};
    const zeroFactors = Object.entries(factors).filter(([id, f]) => f.triggerCount === 0);
    if (zeroFactors.length >= 6 && ft.totalDays >= 5) {
      alerts.push({
        type: 'persistent_zeroes',
        severity: 'warning',
        message: zeroFactors.length + '/9个因子在' + ft.totalDays + '天复盘期间从未触发（' +
          zeroFactors.map(([id, f]) => id + ':' + f.name).join('、') +
          '），需重新校准阈值',
      });
    }
  }

  return alerts;
}

module.exports = {
  loadPortfolio,
  savePortfolio,
  getSnapshot,
  makeTradingDecisions,
  computeStats,
  getDrawdownLevel,
  factorSignalDiagnostics,
  resetPortfolio,
  migratePortfolio,
  updatePositionPrices,
  updateTrailingStop,
  checkRiskThresholds,
  executeRiskTrade,
  loadWeekendContext,
};
