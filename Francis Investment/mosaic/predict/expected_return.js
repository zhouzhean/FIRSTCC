/**
 * expected_return.js — 期望收益计算器
 *
 * 综合多个预测维度，为每只候选股计算期望的 5 日收益率。
 * 替代硬阈值（score >= 65 → 买入）的旧逻辑。
 *
 * 公式：
 *   E[R_5d] = factor_combo_return (30%)
 *           + sector_flow_momentum   (20%)
 *           + market_cycle_bias      (15%)
 *           + nb_sentiment_bias      (15%)
 *           + stock_similarity       (10%)
 *           + score_percentile       (10%)
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

const DATA_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'simfolio');

/**
 * 计算单只股票的期望 5 日收益率。
 *
 * @param {object} stock - Pipeline 分析后的股票对象
 * @param {object} context - 市场上下文
 * @param {object} context.stockFactorPerf - 个股因子绩效数据
 * @param {object} context.marketCycle - 市场周期结果
 * @param {object} context.nbPerf - 北向绩效
 * @param {number|object} context.sectorFlowRank - 板块资金流排名（数字或sectorFlowMap）
 * @param {number} context.maxScore - Pipeline 最高分（用于百分位计算）
 * @param {number} context.minScore - Pipeline 最低分（用于百分位计算）
 * @returns {object} { expectedReturn, breakdown, confidence }
 */
/**
 * Phase 2.4: Evidence threshold — predictions below this bar are advisory only.
 *
 * Requirements:
 *   - confidence >= 0.60
 *   - at least 3 feature dimensions have data
 *   - data quality penalty < 4 (normal)
 *
 * @param {Object} prediction — { confidence, breakdown, contribDims }
 * @param {number} [dataQualityPenalty] — from data_quality.checkAllDataSources
 * @returns {{ passed: boolean, reason: string|null, advisoryOnly: boolean }}
 */
function meetsEvidenceThreshold(prediction, dataQualityPenalty) {
  if (!prediction) {
    return { passed: false, reason: 'no_prediction', advisoryOnly: true };
  }

  var failures = [];

  // 1. Confidence >= 0.60
  if (!prediction.confidence || prediction.confidence < 0.60) {
    failures.push('confidence_below_0.60(' + (prediction.confidence || 0).toFixed(2) + ')');
  }

  // 2. >= 3 dimensions contributed data
  var dims = 0;
  if (prediction.breakdown) {
    for (var key in prediction.breakdown) {
      if (prediction.breakdown[key] && prediction.breakdown[key].available) dims++;
    }
  }
  if (dims < 3) {
    failures.push('insufficient_dims(' + dims + '/6)');
  }

  // 3. Data quality normal
  if (dataQualityPenalty != null && dataQualityPenalty >= 4) {
    failures.push('data_quality_degraded(penalty=' + dataQualityPenalty + ')');
  }

  var advisoryOnly = failures.length > 0;
  return {
    passed: !advisoryOnly,
    reason: failures.length > 0 ? failures.join(', ') : null,
    advisoryOnly: advisoryOnly,
  };
}

/**
 * Phase 2.4: Dynamic minimum expected return based on cost + slippage + historical error.
 * Reads verification_summary.json for historical RMSE, falls back to config value.
 */
function getMinExpectedReturn() {
  try {
    var vsPath = require('path').join(__dirname, '..', '..', 'report-engine', 'data', 'verification', 'verification_summary.json');
    if (require('fs').existsSync(vsPath)) {
      var vs = JSON.parse(require('fs').readFileSync(vsPath, 'utf8'));
      if (vs.overall && vs.overall.rmse != null) {
        var costBps = 0.30;    // commission + stamp tax + transfer
        var slippageBps = 0.30; // default slippage estimate
        var histRmse = vs.overall.rmse;
        return +(costBps + slippageBps + 2 * histRmse).toFixed(2);
      }
    }
  } catch (_) {}
  // Fallback to config
  var cfg = require('../config');
  return (cfg.PREDICTION && cfg.PREDICTION.minExpectedReturn) || 0;
}

function computeExpectedReturn(stock, context) {
  const ctx = context || {};
  const weights = (config.PREDICTION && config.PREDICTION.expectedReturnWeights) || DEFAULT_WEIGHTS;

  const breakdown = {
    factorCombo: computeFactorComboReturn(stock, ctx.stockFactorPerf),
    sectorFlow: computeSectorFlowBias(stock, ctx.sectorFlowRank),
    marketCycle: computeMarketCycleBias(ctx.marketCycle),
    nbSentiment: computeNBSentimentBias(ctx.nbPerf),
    stockSimilarity: computeStockSimilarityBias(ctx.weekendContext, stock),
    scorePercentile: computeScorePercentileBias(stock.compositeScore, ctx.maxScore, ctx.minScore),
  };

  // Weighted sum
  let expectedReturn = 0;
  let totalWeight = 0;
  for (const [key, w] of Object.entries(weights)) {
    if (breakdown[key] != null && breakdown[key].value != null) {
      expectedReturn += breakdown[key].value * w;
      totalWeight += breakdown[key].weight * w;
    }
  }

  // Normalize if some dimensions are missing
  if (totalWeight < 1.0 && totalWeight > 0) {
    expectedReturn = expectedReturn / totalWeight;
  }

  // Confidence: how many dimensions contributed data
  const contributedDims = Object.values(breakdown).filter(b => b.available).length;
  const totalDims = Object.keys(breakdown).length;
  const confidence = Math.min(1.0, contributedDims / totalDims);

  // [v3.2] Calibrate probabilities from factor effectiveness data
  var probability = null;
  var confidenceInterval = null;
  try {
    var calib = calibrateProbabilities(expectedReturn, stock.hiddenSignals || []);
    if (calib) {
      probability = calib.probability;
      confidenceInterval = calib.confidenceInterval;
    }
  } catch (_) { /* calibration not available */ }

  // [v3.2] Compute suggested position size (Kelly-inspired)
  var suggestedPositionSize = null;
  if (probability && probability.up != null) {
    suggestedPositionSize = computeSuggestedPositionSize(probability, expectedReturn);
  }

  // [v3.2] Compute failure conditions
  var failureConditions = [];
  if (stock.peTTM && stock.peTTM > 100) failureConditions.push('PE极端高估(>100)');
  if (stock.changePercent && Math.abs(stock.changePercent) > 9.5) failureConditions.push('接近涨跌停');
  if (stock.turnoverRate != null && stock.turnoverRate < 0.1) failureConditions.push('流动性枯竭');
  if (!stock.peTTM || stock.peTTM < 0) failureConditions.push('PE为负(亏损)');

  return {
    expectedReturn: +expectedReturn.toFixed(2),
    breakdown: breakdown,
    confidence: +confidence.toFixed(2),
    // [v3.2] Probabilistic outputs
    probability: probability,
    confidenceInterval: confidenceInterval,
    suggestedPositionSize: suggestedPositionSize,
    failureConditions: failureConditions,
    label: expectedReturn > 3 ? '强看多' : expectedReturn > 1 ? '看多' : expectedReturn > 0 ? '微看多' : expectedReturn > -1 ? '中性偏空' : expectedReturn > -3 ? '看空' : '强看空',
  };
}

/**
 * 维度 1: 因子组合历史期望收益
 * 该股票触发的因子组合在个股级别历史中的平均 5 日收益
 */
function computeFactorComboReturn(stock, stockFactorPerf) {
  if (!stockFactorPerf || !stockFactorPerf.factors) {
    return { value: 0, available: false, label: '无个股因子数据', weight: 1.0 };
  }

  const signals = stock.hiddenSignals || [];
  if (signals.length === 0) {
    return { value: 0, available: false, label: '无隐藏信号触发', weight: 1.0 };
  }

  let totalReturn = 0;
  let totalWeight = 0;
  const contribs = [];

  for (const sig of signals) {
    const factorPerf = stockFactorPerf.factors.find(f => f.id === sig.id);
    if (factorPerf && factorPerf.avgReturn != null && factorPerf.totalSamples >= 3) {
      const w = sig.level === 'strong' ? 3 : sig.level === 'medium' ? 2 : 1;
      totalReturn += factorPerf.avgReturn * w;
      totalWeight += w;
      contribs.push(sig.id + ':' + factorPerf.avgReturn.toFixed(1) + '%');
    }
  }

  if (totalWeight === 0) {
    return { value: 0, available: false, label: '因子数据不足', weight: 1.0 };
  }

  const avgRet = totalReturn / totalWeight;

  return {
    value: +avgRet.toFixed(2),
    available: true,
    label: contribs.join(' '),
    weight: Math.min(1.0, totalWeight / 6), // scale weight by signal strength
  };
}

/**
 * 维度 2: 板块资金流动量
 * 该股票所在板块近期资金流排名 → 预期收益偏移
 * sectorFlowRank 可以是数字（0=top, 1=bottom）或 sectorFlowMap（从 map 中查找）
 */
function computeSectorFlowBias(stock, sectorFlowRank) {
  if (sectorFlowRank == null) {
    return { value: 0, available: false, label: '无板块资金流数据', weight: 1.0 };
  }

  var rank = null;

  // If sectorFlowRank is a Map/object with sector flow data, look up this stock
  if (typeof sectorFlowRank === 'object' && !Array.isArray(sectorFlowRank)) {
    try {
      var entries = [];
      // Support both Map and plain object
      if (sectorFlowRank instanceof Map || (sectorFlowRank.entries && typeof sectorFlowRank.entries === 'function')) {
        entries = Array.from(sectorFlowRank.entries()).map(function(e) {
          return { code: e[0], name: e[1].name, majorNetFlow: e[1].majorNetFlow };
        });
      } else if (Array.isArray(sectorFlowRank.entries)) {
        entries = sectorFlowRank.entries;
      }
      if (entries.length > 0) {
        // Sort by majorNetFlow descending
        entries.sort(function(a, b) { return (b.majorNetFlow || 0) - (a.majorNetFlow || 0); });
        // Match stock name to sector
        var SECTOR_PATTERNS = [
          { sector: '半导体/AI算力', keys: ['半导体', '芯片', '电子', '光电', '封测', '晶圆', '硅', '算力', '存储'] },
          { sector: '机器人/具身智能', keys: ['机器人', '智能', '减速器', '电机', '伺服', '传感', '运动控制', '自动化'] },
          { sector: '创新药/AI医疗', keys: ['药', '医疗', '医', '生物', '基因', '细胞', '疫苗', '诊断', '试剂'] },
          { sector: '商业航天', keys: ['航天', '卫星', '航空', '火箭', '军工电子', '雷达', '导航'] },
          { sector: '固态电池/储能', keys: ['电池', '储能', '锂', '电解', '正极', '负极', '新能源', '光伏', '风电'] },
          { sector: '新型电力基建', keys: ['电力', '电网', '特高压', '电缆', '电气', '充电桩', '配电'] },
          { sector: '军工', keys: ['军工', '弹药', '装备', '船舶', '电磁', '武器', '防务'] },
          { sector: '有色金属/稀土', keys: ['有色', '稀土', '矿', '铝', '铜', '钢', '金属', '材料', '磁'] },
        ];
        var stockSector = '其他';
        var stockName = stock.name || '';
        for (var pi = 0; pi < SECTOR_PATTERNS.length; pi++) {
          var pat = SECTOR_PATTERNS[pi];
          if (pat.keys.some(function(kw) { return stockName.indexOf(kw) !== -1; })) {
            stockSector = pat.sector;
            break;
          }
        }
        // Find rank
        for (var i = 0; i < entries.length; i++) {
          var sec = entries[i];
          if (!sec.name) continue;
          for (var pj = 0; pj < SECTOR_PATTERNS.length; pj++) {
            var pat2 = SECTOR_PATTERNS[pj];
            if (pat2.sector === stockSector && pat2.keys.some(function(kw) { return (sec.name || '').indexOf(kw) !== -1; })) {
              rank = i / entries.length;
              break;
            }
          }
          if (rank !== null) break;
        }
      }
    } catch (_) {}
  } else if (typeof sectorFlowRank === 'number') {
    rank = sectorFlowRank;
  }

  if (rank === null || rank === undefined) {
    return { value: 0, available: false, label: '板块排名未匹配', weight: 1.0 };
  }

  // sectorFlowRank: 0 = top sector, 1 = bottom sector
  var bias;
  if (rank <= 0.10) bias = 2.0;
  else if (rank <= 0.25) bias = 1.0;
  else if (rank <= 0.50) bias = 0.3;
  else if (rank <= 0.75) bias = -0.5;
  else bias = -1.5;

  return {
    value: bias,
    available: true,
    label: '板块排名Top' + Math.round(rank * 100) + '%',
    weight: 1.0,
  };
}

/**
 * 维度 3: 市场周期偏差
 * 牛市预期收益高，熊市预期收益低
 */
function computeMarketCycleBias(marketCycle) {
  if (!marketCycle || !marketCycle.cycle) {
    return { value: 0, available: false, label: '无市场周期数据', weight: 1.0 };
  }

  const biasMap = {
    'bullish': 2.5,
    'slightly_bullish': 1.0,
    'sideways': 0,
    'slightly_bearish': -1.0,
    'bearish': -2.5,
  };

  const bias = biasMap[marketCycle.cycle] || 0;
  return {
    value: bias,
    available: true,
    label: marketCycle.label || marketCycle.cycle,
    weight: 1.0,
  };
}

/**
 * 维度 4: 北向情绪偏差
 * 北向资金历史命中率 → 对预期收益的信心调整
 */
function computeNBSentimentBias(nbPerf) {
  if (!nbPerf || !nbPerf.available) {
    return { value: 0, available: false, label: '无北向绩效数据', weight: 1.0 };
  }

  let bias;
  if (nbPerf.status === 'hot') bias = 2.0;
  else if (nbPerf.status === 'cold') bias = -1.5;
  else bias = 0;

  return {
    value: bias,
    available: true,
    label: '北向' + (nbPerf.status === 'hot' ? 'HOT' : nbPerf.status === 'cold' ? 'COLD' : 'STABLE') + '(命中率' + (nbPerf.hitRate != null ? Math.round(nbPerf.hitRate * 100) + '%' : 'N/A') + ')',
    weight: 1.0,
  };
}

/**
 * 维度 5: 个股历史相似度投影
 * 从周末分析的 stockSimilarities 中获取该股票的共识方向
 */
function computeStockSimilarityBias(weekendContext, stock) {
  if (!weekendContext || !weekendContext.stockSimilarities) {
    return { value: 0, available: false, label: '无相似度数据', weight: 1.0 };
  }

  const match = weekendContext.stockSimilarities.find(s => s.code === stock.code);
  if (!match || !match.consensus) {
    return { value: 0, available: false, label: '该股无历史相似匹配', weight: 1.0 };
  }

  const consensus = match.consensus;
  let bias;
  if (consensus.direction === 'bullish') bias = 1.5;
  else if (consensus.direction === 'slightly_bullish') bias = 0.5;
  else if (consensus.direction === 'bearish') bias = -1.5;
  else if (consensus.direction === 'slightly_bearish') bias = -0.5;
  else bias = 0;

  return {
    value: bias,
    available: true,
    label: '相似度共识:' + consensus.direction + '(avg5d=' + (consensus.avgReturn5d || 0).toFixed(1) + '%)',
    weight: match.similarity || 0.5,
  };
}

/**
 * 维度 6: 综合评分百分位
 * 该股票在所有候选股中的相对排名 → 基础期望收益
 */
function computeScorePercentileBias(score, maxScore, minScore) {
  if (score == null) {
    return { value: 0, available: false, label: '无评分', weight: 1.0 };
  }

  const mx = maxScore || 100;
  const mn = minScore || 0;
  const range = mx - mn;
  if (range <= 0) {
    return { value: 0, available: true, label: '评分' + score + '分', weight: 1.0 };
  }

  const percentile = (score - mn) / range;
  // Map percentile 0-1 to expected return -2% to +3%
  const bias = -2 + percentile * 5;

  return {
    value: +bias.toFixed(2),
    available: true,
    label: '评分' + score + '分(Top' + Math.round((1 - percentile) * 100) + '%)',
    weight: 1.0,
  };
}

/**
 * 批量计算所有候选股的期望收益并排序。
 *
 * @param {Array} pipelineResults - Pipeline 扫描结果
 * @param {object} context - 市场上下文
 * @returns {Array} 按期望收益降序排列的候选股
 */
function rankByExpectedReturn(pipelineResults, context) {
  if (!pipelineResults || pipelineResults.length === 0) return [];

  // Compute max/min score for percentile
  const scores = pipelineResults.filter(r => r.compositeScore != null).map(r => r.compositeScore);
  const maxScore = scores.length > 0 ? Math.max(...scores) : 100;
  const minScore = scores.length > 0 ? Math.min(...scores) : 0;

  const ctx = { ...(context || {}), maxScore, minScore };

  const ranked = pipelineResults
    .filter(r => r.compositeScore != null)
    .map(r => ({
      ...r,
      prediction: computeExpectedReturn(r, ctx),
    }))
    .sort((a, b) => (b.prediction && b.prediction.expectedReturn || 0) - (a.prediction && a.prediction.expectedReturn || 0));

  return ranked;
}

const DEFAULT_WEIGHTS = {
  factorCombo: 0.30,
  sectorFlow: 0.20,
  marketCycle: 0.15,
  nbSentiment: 0.15,
  stockSimilarity: 0.10,
  scorePercentile: 0.10,
};

/**
 * v3.4.7: Read index close price for a given date.
 * Fallback chain: index_history_DATE.json (last entry) → market_snapshot_latest.json (same-date check) → null
 * NEVER uses stock price — only true index data.
 *
 * @param {string} targetDate - YYYY-MM-DD
 * @param {string} indexType - 'sh' | 'sz' | 'cy' | 'bj'
 * @returns {number|null}
 */
function _getIndexCloseForDate(targetDate, indexType) {
  try {
    // Tier 1: index_history_DATE.json — last entry of the day is the market close
    var idxFile = path.join(DATA_DIR, 'index_history_' + targetDate + '.json');
    if (fs.existsSync(idxFile)) {
      var idxData = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
      if (Array.isArray(idxData) && idxData.length > 0) {
        var lastEntry = idxData[idxData.length - 1];
        var val = lastEntry[indexType || 'sh'];
        if (val != null && val > 0) return val;
      }
    }
    // Tier 2: market_snapshot_latest.json if the date matches
    var snapFile = path.join(DATA_DIR, 'market_snapshot_latest.json');
    if (fs.existsSync(snapFile)) {
      var snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
      if (snap.date === targetDate && snap.indices) {
        var codeMap = { sh: '000001', sz: '399001', cy: '399006', bj: '899050' };
        var targetCode = codeMap[indexType] || '000001';
        var shIdx = snap.indices.find(function(ix) { return ix.code === targetCode; });
        if (shIdx && shIdx.price > 0) return shIdx.price;
      }
    }
  } catch (_) {}
  return null;
}

/**
 * 验证历史期望收益预测的准确性。
 * 对比 N 天前预测的 E[R5d] 与实际 5 日收益。
 * 由 _runDailySummary() 在 16:00 调用。
 *
 * @param {string} dateStr - 当前日期 YYYY-MM-DD
 */
function verifyExpectedReturns(dateStr) {
  try {
    const VERIFY_FILE = path.join(DATA_DIR, 'expected_return_verification.json');
    var history = { entries: [] };
    if (fs.existsSync(VERIFY_FILE)) {
      try { history = JSON.parse(fs.readFileSync(VERIFY_FILE, 'utf8')); } catch (_) {}
    }

    // v3.4.6: Load trading calendar from bootstrap_history.js
    var tradingDays = null;
    try {
      tradingDays = require('../evolution/bootstrap_history').generateTradingDays(2021, 2027);
    } catch (_) {}
    if (!tradingDays) {
      return { available: false, reason: '无法加载交易日历' };
    }

    // v3.4.6: Find the trading day exactly 5 trading days before dateStr
    var dateIdx = tradingDays.indexOf(dateStr);
    if (dateIdx < 1) {
      return { available: false, reason: '当前日期 ' + dateStr + ' 不在交易日历中' };
    }

    // Step back 5 trading days for the lookback window
    var foundDate = null;
    for (var step = 1; step <= 30; step++) {
      var lookIdx = dateIdx - step;
      if (lookIdx < 0) break;
      var lookDate = tradingDays[lookIdx];
      var ledgerFile = path.join(DATA_DIR, 'prediction_ledger_' + lookDate + '.jsonl');
      if (fs.existsSync(ledgerFile)) {
        foundDate = lookDate;
        break;
      }
    }

    if (!foundDate) {
      return { available: false, reason: '最近30个交易日内无prediction_ledger记录' };
    }

    // v3.4.7: Strict target-date gating — only settle when targetDate === dateStr
    // Read from prediction_ledger (NOT legacy last_pipeline_result.json)
    var ledgerVerifications = [];
    try {
      // Fix path: DATA_DIR already includes simfolio/ (see line 19)
      var ledgerFile = path.join(DATA_DIR, 'prediction_ledger_' + foundDate + '.jsonl');
      if (fs.existsSync(ledgerFile)) {
        var ledgerLines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n');
        // Fix path: stock_factor_performance.json is in data/, not data/simfolio/
        var spfPath2 = path.join(DATA_DIR, '..', 'stock_factor_performance.json');
        var spf2 = fs.existsSync(spfPath2) ? JSON.parse(fs.readFileSync(spfPath2, 'utf8')) : null;
        if (spf2) {
          var toRecs2 = (spf2.dailyRecords || {})[dateStr] || [];
          for (var li = 0; li < ledgerLines.length; li++) {
            try {
              var led = JSON.parse(ledgerLines[li]);

              // v3.4.7: Strict equality — only settle on exact targetDate match
              if (!led.targetDate || led.targetDate !== dateStr) continue;

              var toRec2 = toRecs2.find(function(r) { return r.code === led.code; });
              if (!toRec2 || !(led.price > 0)) continue;

              var actualRet = (toRec2.price - led.price) / led.price * 100;

              // v3.4.7: Benchmark return from INDEX data (never stock price)
              var benchmarkRet = null;
              var benchmarkUnavailable = true;
              var netExcessReturn = null;
              if (led.benchmarkPrice != null && led.benchmarkPrice > 0) {
                var targetIndexClose = _getIndexCloseForDate(led.targetDate || dateStr, 'sh');
                if (targetIndexClose != null && targetIndexClose > 0) {
                  benchmarkRet = +((targetIndexClose - led.benchmarkPrice) / led.benchmarkPrice * 100).toFixed(2);
                  if (benchmarkRet != null && !isNaN(benchmarkRet) && isFinite(benchmarkRet)) {
                    benchmarkUnavailable = false;
                    netExcessReturn = +(actualRet - benchmarkRet).toFixed(2);
                  } else {
                    benchmarkRet = null;
                  }
                }
              }

              // Post-cost return: commission 0.025% + stamp 0.1% + slippage 0.1% = 0.225% round-trip
              // 0.00225 * 100 = 0.225 percentage points subtracted from percentage return
              var roundTripCost = 0.00225 * 100;
              var postCostRet = +(actualRet - roundTripCost).toFixed(2);

              ledgerVerifications.push({
                predictionId: led.predictionId,
                code: led.code,
                name: led.name,
                asOf: led.asOf || foundDate,
                targetDate: led.targetDate || null,
                horizonTradingDays: led.horizonTradingDays || 3,
                expectedReturn: led.expectedReturn,
                actualReturn_3d: +actualRet.toFixed(2),
                benchmarkReturn: benchmarkRet,
                benchmarkUnavailable: benchmarkUnavailable,
                netExcessReturn: netExcessReturn,
                postCostReturn: postCostRet,
                directionCorrect: led.expectedReturn != null ? (led.expectedReturn > 0) === (actualRet > 0) : null,
                wasBought: led.wasBought,
              });
            } catch (_) {}
          }
        }
      }
    } catch (_) {}

    // v3.4.7: Write outcome ledger with dedup by predictionId
    if (ledgerVerifications.length > 0) {
      try {
        var outcomeDir = DATA_DIR;  // Already includes simfolio/
        if (!fs.existsSync(outcomeDir)) {
          var fs3 = require('fs');
          fs3.mkdirSync(outcomeDir, { recursive: true });
        }
        var outcomeFile = path.join(outcomeDir, 'outcome_ledger.jsonl');

        // Dedup: read existing predictionIds to prevent duplicates
        var existingPredIds = {};
        try {
          if (fs.existsSync(outcomeFile)) {
            var existingLines = fs.readFileSync(outcomeFile, 'utf8').trim().split('\n');
            for (var ei = 0; ei < existingLines.length; ei++) {
              try {
                var ex = JSON.parse(existingLines[ei]);
                if (ex.predictionId) existingPredIds[ex.predictionId] = true;
              } catch (_) {}
            }
          }
        } catch (_) {}

        var newOutcomes = 0;
        for (var oi = 0; oi < ledgerVerifications.length; oi++) {
          if (existingPredIds[ledgerVerifications[oi].predictionId]) continue;
          fs.appendFileSync(outcomeFile, JSON.stringify(ledgerVerifications[oi]) + '\n', 'utf8');
          newOutcomes++;
        }
      } catch (_) {}
    }

    // Compute statistics from ledger verifications
    var directionCorrect = ledgerVerifications.filter(function(v) { return v.directionCorrect === true; }).length;
    var directionTotal = ledgerVerifications.filter(function(v) { return v.directionCorrect !== null; }).length;
    var directionHitRate = directionTotal > 0 ? +(directionCorrect / directionTotal).toFixed(2) : null;
    var avgError = ledgerVerifications.filter(function(v) { return v.expectedReturn != null && v.actualReturn_3d != null; }).length > 0
      ? +(ledgerVerifications.filter(function(v) { return v.expectedReturn != null && v.actualReturn_3d != null; })
          .reduce(function(s, v) { return s + Math.abs(v.expectedReturn - v.actualReturn_3d); }, 0) /
          ledgerVerifications.filter(function(v) { return v.expectedReturn != null && v.actualReturn_3d != null; }).length)
          .toFixed(2)
      : null;

    var entry = {
      date: dateStr,
      fromDate: foundDate,
      source: 'prediction_ledger',  // v3.4.6: mark source; NO legacy last_pipeline_result
      totalVerified: ledgerVerifications.length,
      directionCorrect: directionCorrect,
      directionTotal: directionTotal,
      directionHitRate: directionHitRate,
      avgError: avgError,
      summary: directionHitRate != null
        ? '方向命中率: ' + Math.round(directionHitRate * 100) + '% (' + directionCorrect + '/' + directionTotal + '), 平均误差: ' + (avgError != null ? avgError + '%' : 'N/A')
        : '已验证' + ledgerVerifications.length + '只股票',
    };

    if (history.entries.length >= 30) history.entries = history.entries.slice(-29);
    history.entries.push(entry);
    history.updatedAt = new Date().toISOString();

    try {
      var dir = path.dirname(VERIFY_FILE);
      if (!fs.existsSync(dir)) {
        var fs2 = require('fs');
        fs2.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(VERIFY_FILE, JSON.stringify(history, null, 2), 'utf8');
    } catch (_) {}

    return { available: true, entry: entry, ledgerCount: ledgerVerifications.length };
  } catch (e) {
    return { available: false, reason: e.message };
  }
}

// ====== [v3.2] Probability Calibration Functions ======

/**
 * Calibrate probability estimates from factor effectiveness data.
 * Uses historical hit rates and return distributions to estimate
 * P(up), P(flat), P(down) for the expected return.
 */
function calibrateProbabilities(expectedReturn, signals) {
  var effPath = path.join(__dirname, '..', '..', 'report-engine', 'data', 'evolution', 'factor_effectiveness.json');
  if (!fs.existsSync(effPath)) return null;

  try {
    var eff = JSON.parse(fs.readFileSync(effPath, 'utf8'));
    var t5 = eff.matrix && eff.matrix['T+5'];
    if (!t5) return null;

    // Gather historical hit rates for triggered signals
    var totalHitRate = 0, totalSamples = 0, count = 0;
    for (var i = 0; i < signals.length; i++) {
      var sig = signals[i];
      var fe = t5[sig.id];
      if (fe && fe.hitRate != null && !fe._insufficient) {
        totalHitRate += fe.hitRate;
        totalSamples += fe.total || 0;
        count++;
      }
    }

    if (count === 0) return null;
    var avgHitRate = totalHitRate / count;

    // Map to calibrated probability
    // P(up) ≈ avgHitRate / 100 (already in %)
    // P(down) ≈ 1 - P(up) - P(flat)
    var pUp = Math.min(0.95, Math.max(0.05, avgHitRate / 100));
    var pFlat = 0.15; // approx flat probability
    var pDown = 1 - pUp - pFlat;

    // Confidence interval: approx ±2 * SE
    // SE ≈ sqrt(p*(1-p)/n), where n = avg samples per factor
    var avgSamples = count > 0 ? totalSamples / count : 100;
    var se = Math.sqrt(pUp * (1 - pUp) / Math.max(avgSamples, 10));
    var ciLow = +Math.max(0, expectedReturn - 2 * se * 100).toFixed(2);
    var ciHigh = +Math.min(100, expectedReturn + 2 * se * 100).toFixed(2);

    return {
      probability: {
        up: +pUp.toFixed(2),
        flat: +pFlat.toFixed(2),
        down: +pDown.toFixed(2),
      },
      confidenceInterval: { lower: ciLow, upper: ciHigh, level: 0.68 },
      calibratedFrom: count + '个因子 · 均样本' + Math.round(avgSamples),
    };
  } catch (_) { return null; }
}

/**
 * Kelly-inspired position sizing: f = edge / odds
 * edge = P(up) * avgUpPct - P(down) * abs(avgDownPct)
 */
function computeSuggestedPositionSize(probability, expectedReturn) {
  if (!probability) return null;
  var edge = (probability.up || 0) * 0.05 - (probability.down || 0) * 0.03;
  if (edge <= 0) return 0;
  var kelly = edge / 0.05;
  // Half-Kelly for safety, capped at 30% max single position
  return +Math.min(kelly * 0.5, 0.30).toFixed(2);
}

module.exports = {
  computeExpectedReturn,
  rankByExpectedReturn,
  verifyExpectedReturns,
  calibrateProbabilities,
  computeSuggestedPositionSize,
  meetsEvidenceThreshold,   // Phase 2.4
  getMinExpectedReturn,     // Phase 2.4
  DEFAULT_WEIGHTS,
};
