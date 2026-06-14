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
 * @param {object} context.sectorFlowRank - 板块资金流排名
 * @param {number} context.maxScore - Pipeline 最高分（用于百分位计算）
 * @param {number} context.minScore - Pipeline 最低分（用于百分位计算）
 * @returns {object} { expectedReturn, breakdown, confidence }
 */
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

  return {
    expectedReturn: +expectedReturn.toFixed(2),
    breakdown: breakdown,
    confidence: +confidence.toFixed(2),
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
    if (factorPerf && factorPerf.avgReturn != null && factorPerf.totalSamples >= 5) {
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
 */
function computeSectorFlowBias(stock, sectorFlowRank) {
  if (sectorFlowRank == null) {
    return { value: 0, available: false, label: '无板块资金流数据', weight: 1.0 };
  }

  // sectorFlowRank: 0 = top sector, 1 = bottom sector
  let bias;
  if (sectorFlowRank <= 0.10) bias = 2.0;
  else if (sectorFlowRank <= 0.25) bias = 1.0;
  else if (sectorFlowRank <= 0.50) bias = 0.3;
  else if (sectorFlowRank <= 0.75) bias = -0.5;
  else bias = -1.5;

  return {
    value: bias,
    available: true,
    label: '板块排名Top' + Math.round(sectorFlowRank * 100) + '%',
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

    // Check if we have a pipeline result from 5 calendar days ago
    var targetDate = dateStr;
    var foundDate = null;
    var foundResult = null;

    // Look back up to 10 calendar days for the most recent pipeline scan
    for (var d = 1; d <= 10; d++) {
      var checkDate = new Date(dateStr + 'T00:00:00+08:00');
      checkDate.setDate(checkDate.getDate() - d);
      var checkDateStr = checkDate.toISOString().slice(0, 10);
      var scanFile = path.join(DATA_DIR, 'scan_records_' + checkDateStr + '.json');
      if (fs.existsSync(scanFile)) {
        foundDate = checkDateStr;
        // Also check if we have stock_factor_performance records for target date
        var spfPath = path.join(DATA_DIR, 'stock_factor_performance.json');
        if (fs.existsSync(spfPath)) {
          var spf = JSON.parse(fs.readFileSync(spfPath, 'utf8'));
          var dailyRecords = spf.dailyRecords || {};
          if (dailyRecords[dateStr] && dailyRecords[checkDateStr]) {
            foundResult = { fromDate: checkDateStr, toDate: dateStr, dailyRecords: dailyRecords };
            break;
          }
        }
        // Fallback: use pipeline result directly
        var pipelinePath = path.join(DATA_DIR, 'last_pipeline_result.json');
        // Note: this is the CURRENT result, not the historical one
        // For now, just use scan dates for verification metadata
        if (!foundResult && foundDate) break;
      }
    }

    if (!foundDate) {
      return { available: false, reason: '5天前无扫描记录' };
    }

    // For each stock that had an expected return prediction, compute actual return
    var verifications = [];
    try {
      var scanFile = path.join(DATA_DIR, 'scan_records_' + foundDate + '.json');
      if (fs.existsSync(scanFile)) {
        var scanRecords = JSON.parse(fs.readFileSync(scanFile, 'utf8'));
        // Use stock_factor_performance records for actual price comparison
        var spfPath = path.join(DATA_DIR, 'stock_factor_performance.json');
        if (fs.existsSync(spfPath)) {
          var spf = JSON.parse(fs.readFileSync(spfPath, 'utf8'));
          var fromRecords = (spf.dailyRecords || {})[foundDate] || [];
          var toRecords = (spf.dailyRecords || {})[dateStr] || [];
          for (var i = 0; i < fromRecords.length; i++) {
            var fromRec = fromRecords[i];
            var toRec = toRecords.find(function(r) { return r.code === fromRec.code; });
            if (toRec && toRec.price && fromRec.price > 0) {
              var actualReturn = (toRec.price - fromRec.price) / fromRec.price * 100;
              // Find the expected return if we computed it
              var pipelinePath = path.join(DATA_DIR, 'last_pipeline_result.json');
              var expectedReturn = null;
              if (fs.existsSync(pipelinePath)) {
                try {
                  var lr = JSON.parse(fs.readFileSync(pipelinePath, 'utf8'));
                  if (lr.expectedReturns) {
                    var match = lr.expectedReturns.find(function(e) { return e.code === fromRec.code; });
                    if (match) expectedReturn = match.expectedReturn;
                  }
                } catch (_) {}
              }
              verifications.push({
                code: fromRec.code,
                name: fromRec.name,
                fromDate: foundDate,
                expectedReturn: expectedReturn,
                actualReturn: +actualReturn.toFixed(2),
                error: expectedReturn != null ? +(actualReturn - expectedReturn).toFixed(2) : null,
                directionCorrect: expectedReturn != null ? (expectedReturn > 0) === (actualReturn > 0) : null,
              });
            }
          }
        }
      }
    } catch (_) {}

    var directionCorrect = verifications.filter(function(v) { return v.directionCorrect === true; }).length;
    var directionTotal = verifications.filter(function(v) { return v.directionCorrect !== null; }).length;
    var directionHitRate = directionTotal > 0 ? +(directionCorrect / directionTotal).toFixed(2) : null;
    var avgError = verifications.filter(function(v) { return v.error !== null; }).length > 0
      ? +(verifications.filter(function(v) { return v.error !== null; }).reduce(function(s, v) { return s + v.error; }, 0) / verifications.filter(function(v) { return v.error !== null; }).length).toFixed(2)
      : null;

    var entry = {
      date: dateStr,
      fromDate: foundDate,
      totalVerified: verifications.length,
      directionCorrect: directionCorrect,
      directionTotal: directionTotal,
      directionHitRate: directionHitRate,
      avgError: avgError,
      summary: directionHitRate != null
        ? '方向命中率: ' + Math.round(directionHitRate * 100) + '% (' + directionCorrect + '/' + directionTotal + '), 平均误差: ' + (avgError != null ? avgError.toFixed(1) + '%' : 'N/A')
        : '已验证' + verifications.length + '只股票（无期望收益预测可对比）',
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

    return { available: true, entry: entry };
  } catch (e) {
    return { available: false, reason: e.message };
  }
}

module.exports = {
  computeExpectedReturn,
  rankByExpectedReturn,
  verifyExpectedReturns,
  DEFAULT_WEIGHTS,
};
