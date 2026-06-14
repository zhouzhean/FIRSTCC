/**
 * us_as_predict.js — 美股→A股预测验证闭环
 *
 * 每天凌晨 05:30（美股收盘后）生成对当天 A股板块的预测，
 * 下午 15:10（A股收盘后）验证预测准确性。
 *
 * 数据流：
 *   US ETF 收盘涨跌幅 + correlation_history.json 的 Pearson R
 *   → A股板块级别方向预测
 *   → A股收盘后对比实际板块涨跌
 *   → 追踪准确率 → 反馈到 cross_market 信号权重
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'simfolio');
const US_DATA_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'us_market');

const PREDICTION_FILE = path.join(DATA_DIR, 'us_as_predictions.json');
const VERIFICATION_FILE = path.join(DATA_DIR, 'us_as_verification_history.json');

// ETF → A股板块映射
const ETF_SECTOR_MAP = {
  'SMH':  '半导体/AI算力',
  'XBI':  '创新药/AI医疗',
  'TAN':  '固态电池/储能',
  'ARKQ': '机器人/具身智能',
  'XLE':  '有色金属/稀土',
  'XAR':  '军工',
};

var _state = {
  running: false,
  lastPredictRun: null,
  lastVerifyRun: null,
  error: null,
};

// ==================== 预测生成 ====================

/**
 * 凌晨 05:30 调用：根据美股收盘数据生成 A股板块预测。
 */
function generateOvernightPrediction(dateStr) {
  var now = new Date();
  var today = dateStr || now.toISOString().slice(0, 10);

  console.log('[US-AS Predict] 生成预测 (' + today + ')...');

  try {
    // 1. Load US market current data
    var usData = loadUSLatest();
    if (!usData) {
      return { available: false, reason: '无美股实时数据', date: today };
    }

    // 2. Load correlation history
    var corrHistory = loadCorrelationHistory();
    if (!corrHistory || !corrHistory.days || corrHistory.days.length === 0) {
      return { available: false, reason: '无相关性历史数据', date: today };
    }

    // Get the most recent day's correlations
    var latestCorr = corrHistory.days[corrHistory.days.length - 1];

    // 3. Compute Pearson R from recent history (last 20 days)
    var pearsonR = computePairwisePearson(corrHistory.days, 20);

    // 4. Generate predictions for each ETF→sector pair
    var predictions = [];
    var etfKeys = Object.keys(ETF_SECTOR_MAP);

    for (var i = 0; i < etfKeys.length; i++) {
      var etf = etfKeys[i];
      var sector = ETF_SECTOR_MAP[etf];

      // Find ETF in US data
      var etfData = findETFInData(usData, etf);
      if (!etfData || etfData.changePercent == null) continue;

      var usChange = etfData.changePercent;
      var r = pearsonR[etf] || 0;

      // Prediction: direction = sign(usChange * R) if |R| > 0.3
      var direction;
      var confidence;
      var absR = Math.abs(r);

      if (absR >= 0.5) confidence = 'high';
      else if (absR >= 0.3) confidence = 'medium';
      else confidence = 'low';

      if (absR >= 0.3) {
        if (usChange > 0 && r > 0) direction = 'bullish';
        else if (usChange < 0 && r > 0) direction = 'bearish';
        else if (usChange > 0 && r < 0) direction = 'bearish'; // inverse correlation
        else if (usChange < 0 && r < 0) direction = 'bullish'; // inverse correlation
        else direction = 'neutral';
      } else {
        direction = 'neutral';
      }

      // Expected magnitude: usChange * |R| (衰减系数)
      var expectedMagnitude = +(usChange * absR * 0.6).toFixed(1);

      predictions.push({
        etf: etf,
        sector: sector,
        usChange: usChange,
        correlation: +r.toFixed(2),
        direction: direction,
        confidence: confidence,
        expectedMagnitude: expectedMagnitude,
      });
    }

    // Sort by confidence and magnitude
    predictions.sort(function(a, b) {
      var confOrder = { high: 3, medium: 2, low: 1 };
      var ca = confOrder[a.confidence] || 0;
      var cb = confOrder[b.confidence] || 0;
      if (ca !== cb) return cb - ca;
      return Math.abs(b.expectedMagnitude) - Math.abs(a.expectedMagnitude);
    });

    // 5. Build prediction object
    var prediction = {
      date: today,
      generatedAt: new Date().toISOString(),
      predictions: predictions,
      topPrediction: predictions.length > 0 ? predictions[0] : null,
      summary: buildPredictionSummary(predictions),
    };

    // 6. Save
    savePrediction(prediction);

    console.log('[US-AS Predict] 生成完成: ' + predictions.length + ' 条预测, top=' +
      (prediction.topPrediction ? prediction.topPrediction.sector + '[' + prediction.topPrediction.direction + ']' : 'none'));

    return prediction;

  } catch (e) {
    console.error('[US-AS Predict] 错误:', e.message);
    return { available: false, error: e.message, date: today };
  }
}

function buildPredictionSummary(predictions) {
  var bulls = predictions.filter(function(p) { return p.direction === 'bullish'; });
  var bears = predictions.filter(function(p) { return p.direction === 'bearish'; });
  var highConf = predictions.filter(function(p) { return p.confidence === 'high'; });

  return {
    bullishCount: bulls.length,
    bearishCount: bears.length,
    highConfidenceCount: highConf.length,
    overallBias: bulls.length > bears.length ? 'bullish' : bears.length > bulls.length ? 'bearish' : 'neutral',
  };
}

// ==================== 预测验证 ====================

/**
 * 下午 15:10 调用：验证当天预测与实际 A股板块涨跌。
 */
function verifyPrediction(dateStr) {
  var today = dateStr || new Date().toISOString().slice(0, 10);

  console.log('[US-AS Verify] 验证预测 (' + today + ')...');

  try {
    // 1. Load today's prediction
    var prediction = loadPrediction(today);
    if (!prediction || !prediction.predictions || prediction.predictions.length === 0) {
      return { available: false, reason: '无当日预测', date: today };
    }

    // 2. Get actual A-stock sector performance
    var actualSectorChanges = getActualSectorChanges(today);

    // 3. Compare each prediction
    var verified = [];
    for (var i = 0; i < prediction.predictions.length; i++) {
      var p = prediction.predictions[i];
      var actualChange = actualSectorChanges[p.sector];
      var actualDirection = actualChange != null
        ? (actualChange > 0.5 ? 'bullish' : actualChange < -0.5 ? 'bearish' : 'neutral')
        : null;

      var correct = null;
      if (actualDirection && p.direction !== 'neutral') {
        correct = actualDirection === p.direction;
      } else if (actualDirection && p.direction === 'neutral') {
        correct = actualDirection === 'neutral';
      }

      verified.push({
        etf: p.etf,
        sector: p.sector,
        predictedDirection: p.direction,
        predictedMagnitude: p.expectedMagnitude,
        actualChange: actualChange,
        actualDirection: actualDirection,
        correct: correct,
        confidence: p.confidence,
        error: actualChange != null && p.expectedMagnitude != null
          ? +(Math.abs(actualChange - p.expectedMagnitude)).toFixed(1)
          : null,
      });
    }

    // 4. Compute accuracy stats
    var decisive = verified.filter(function(v) { return v.correct !== null; });
    var correctCount = decisive.filter(function(v) { return v.correct === true; }).length;
    var wrongCount = decisive.filter(function(v) { return v.correct === false; }).length;
    var highConfDecisive = decisive.filter(function(v) { return v.confidence === 'high'; });
    var highConfCorrect = highConfDecisive.filter(function(v) { return v.correct === true; }).length;

    var verification = {
      date: today,
      verifiedAt: new Date().toISOString(),
      totalPredictions: verified.length,
      decisivePredictions: decisive.length,
      correctCount: correctCount,
      wrongCount: wrongCount,
      directionHitRate: decisive.length > 0 ? +(correctCount / decisive.length).toFixed(2) : null,
      highConfidenceHitRate: highConfDecisive.length > 0
        ? +(highConfCorrect / highConfDecisive.length).toFixed(2)
        : null,
      averageError: decisive.length > 0
        ? +(decisive.reduce(function(s, v) { return s + (v.error || 0); }, 0) / decisive.length).toFixed(1)
        : null,
      verified: verified,
    };

    // 5. Save to history
    saveVerification(verification);

    console.log('[US-AS Verify] 验证完成: hitRate=' +
      (verification.directionHitRate != null ? Math.round(verification.directionHitRate * 100) + '%' : 'N/A') +
      ', highConf=' + (verification.highConfidenceHitRate != null ? Math.round(verification.highConfidenceHitRate * 100) + '%' : 'N/A'));

    return verification;

  } catch (e) {
    console.error('[US-AS Verify] 错误:', e.message);
    return { available: false, error: e.message, date: today };
  }
}

/**
 * 获取历史预测准确率统计。
 */
function getPredictionAccuracy(rollingDays) {
  var days = rollingDays || 20;
  var history = loadVerificationHistory();

  if (!history || !history.entries || history.entries.length === 0) {
    return { available: false, reason: '无验证历史' };
  }

  var recent = history.entries.slice(-days);

  var totalDecisive = 0;
  var totalCorrect = 0;
  var dailyHitRates = [];

  for (var i = 0; i < recent.length; i++) {
    var entry = recent[i];
    if (entry.decisivePredictions > 0) {
      totalDecisive += entry.decisivePredictions;
      totalCorrect += entry.correctCount;
      dailyHitRates.push({
        date: entry.date,
        hitRate: entry.directionHitRate,
      });
    }
  }

  var overallHitRate = totalDecisive > 0 ? +(totalCorrect / totalDecisive).toFixed(2) : null;

  // Signal quality assessment
  var assessment;
  if (overallHitRate == null) assessment = 'insufficient_data';
  else if (overallHitRate >= 0.65) assessment = 'reliable';
  else if (overallHitRate >= 0.50) assessment = 'marginal';
  else assessment = 'unreliable';

  return {
    available: totalDecisive > 0,
    rollingDays: days,
    totalDecisive: totalDecisive,
    totalCorrect: totalCorrect,
    overallHitRate: overallHitRate,
    assessment: assessment,
    dailyHitRates: dailyHitRates,
    recommendation: assessment === 'reliable'
      ? '跨市场信号可靠，维持当前权重'
      : assessment === 'marginal'
        ? '跨市场信号勉强可用，建议降低权重20%'
        : assessment === 'unreliable'
          ? '跨市场信号不可靠，建议降低权重50%或暂停使用'
          : '数据不足，无法评估',
  };
}

// ==================== 数据获取 ====================

function loadUSLatest() {
  var filePath = path.join(US_DATA_DIR, 'us_latest.json');
  if (!fs.existsSync(filePath)) return null;
  try {
    var data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // us_latest.json has categorized structure: { indices, macro, adrs, sectorETFs, sentiment }
    // Return the full categorized object for findETFInData to search
    return data;
  } catch (_) { return null; }
}

function loadCorrelationHistory() {
  var filePath = path.join(US_DATA_DIR, 'correlation_history.json');
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return null; }
}

function findETFInData(usData, etf) {
  if (!usData) return null;

  // If usData has categorized groups (indices/macro/sectorETFs/adrs/sentiment), search all
  var categories = ['indices', 'macro', 'sectorETFs', 'adrs', 'sentiment'];
  for (var ci = 0; ci < categories.length; ci++) {
    var group = usData[categories[ci]];
    if (Array.isArray(group)) {
      for (var gi = 0; gi < group.length; gi++) {
        if (group[gi].symbol === etf) return group[gi];
      }
    }
  }

  // Fallback: usData is itself an array
  if (Array.isArray(usData)) {
    for (var i = 0; i < usData.length; i++) {
      if (usData[i].symbol === etf || usData[i].code === etf) return usData[i];
    }
  }

  // Fallback: direct key access
  if (usData[etf]) return usData[etf];

  return null;
}

function computePairwisePearson(days, lookback) {
  var n = Math.min(lookback || 20, days.length);
  var recent = days.slice(-n);

  var rValues = {};
  var etfKeys = Object.keys(ETF_SECTOR_MAP);

  for (var i = 0; i < etfKeys.length; i++) {
    var etf = etfKeys[i];
    var sector = ETF_SECTOR_MAP[etf];

    var usChanges = [];
    var aChanges = [];

    for (var j = 0; j < recent.length; j++) {
      var day = recent[j];
      var us = day.us || {};
      var aStock = day.aStock || {};

      if (us[etf] != null && aStock[sector] != null) {
        usChanges.push(us[etf]);
        aChanges.push(aStock[sector]);
      }
    }

    if (usChanges.length >= 5) {
      rValues[etf] = pearsonR(usChanges, aChanges);
    } else {
      rValues[etf] = 0;
    }
  }

  return rValues;
}

function pearsonR(x, y) {
  var n = x.length;
  if (n < 3) return 0;

  var sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (var i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
    sumY2 += y[i] * y[i];
  }

  var num = n * sumXY - sumX * sumY;
  var den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

  return den !== 0 ? num / den : 0;
}

function getActualSectorChanges(dateStr) {
  // Try to get sector performance from correlation_history or from sector live data
  var corrHistory = loadCorrelationHistory();
  if (corrHistory && corrHistory.days) {
    var todayEntry = corrHistory.days.find(function(d) { return d.date === dateStr; });
    if (todayEntry && todayEntry.aStock) {
      return todayEntry.aStock;
    }
  }

  // Fallback: try to fetch from market_data
  try {
    var marketData = require('../collectors/market_data');
    // Not ideal but gives us something
    return {};
  } catch (_) {
    return {};
  }
}

// ==================== 持久化 ====================

function savePrediction(prediction) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    var all = {};
    if (fs.existsSync(PREDICTION_FILE)) {
      try { all = JSON.parse(fs.readFileSync(PREDICTION_FILE, 'utf8')); } catch (_) {}
    }
    all[prediction.date] = prediction;
    // Keep last 30 days
    var dates = Object.keys(all).sort();
    if (dates.length > 30) {
      for (var i = 0; i < dates.length - 30; i++) delete all[dates[i]];
    }
    fs.writeFileSync(PREDICTION_FILE, JSON.stringify(all, null, 2), 'utf8');
  } catch (_) {}
}

function loadPrediction(dateStr) {
  if (!fs.existsSync(PREDICTION_FILE)) return null;
  try {
    var all = JSON.parse(fs.readFileSync(PREDICTION_FILE, 'utf8'));
    return all[dateStr] || null;
  } catch (_) { return null; }
}

function saveVerification(verification) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    var history = { entries: [], updatedAt: null };
    if (fs.existsSync(VERIFICATION_FILE)) {
      try { history = JSON.parse(fs.readFileSync(VERIFICATION_FILE, 'utf8')); } catch (_) {}
    }
    if (!history.entries) history.entries = [];

    // Replace existing entry for same date
    var existingIdx = -1;
    for (var i = 0; i < history.entries.length; i++) {
      if (history.entries[i].date === verification.date) { existingIdx = i; break; }
    }
    if (existingIdx >= 0) {
      history.entries[existingIdx] = verification;
    } else {
      history.entries.push(verification);
    }

    // Keep last 60 days
    if (history.entries.length > 60) {
      history.entries = history.entries.slice(-60);
    }
    history.updatedAt = new Date().toISOString();
    fs.writeFileSync(VERIFICATION_FILE, JSON.stringify(history, null, 2), 'utf8');
  } catch (_) {}
}

function loadVerificationHistory() {
  if (!fs.existsSync(VERIFICATION_FILE)) return { entries: [] };
  try { return JSON.parse(fs.readFileSync(VERIFICATION_FILE, 'utf8')); } catch (_) { return { entries: [] }; }
}

function getStatus() {
  return {
    running: _state.running,
    lastPredictRun: _state.lastPredictRun,
    lastVerifyRun: _state.lastVerifyRun,
    error: _state.error,
  };
}

module.exports = {
  generateOvernightPrediction,
  verifyPrediction,
  getPredictionAccuracy,
  getStatus,
  loadPrediction,
  loadVerificationHistory,
};
