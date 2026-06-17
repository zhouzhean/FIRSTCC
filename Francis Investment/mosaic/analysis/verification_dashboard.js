/**
 * verification_dashboard.js — [v3.2] Post-Game Verification System
 *
 * Aggregates verification data from all prediction sources into a unified dashboard.
 * Tracks: direction hit rate, average error, Rank IC, max drawdown, win/loss ratio.
 *
 * Data sources:
 *   - simfolio/factor_performance.json (factor signal hit/miss)
 *   - simfolio/us_as_verification_history.json (US-to-A predictions)
 *   - simfolio/expected_return_verification.json (expected return accuracy)
 *   - simfolio/stock_factor_performance.json (per-stock factor tracking)
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data');
const SIMFOLIO_DIR = path.join(DATA_DIR, 'simfolio');
const VERIFICATION_DIR = path.join(DATA_DIR, 'verification');
const EVOLUTION_DIR = path.join(DATA_DIR, 'evolution');

function _readJSON(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) { return null; }
}

/**
 * Compute factor signal verification from factor_performance.json
 */
function _computeFactorVerification() {
  var fp = _readJSON(path.join(SIMFOLIO_DIR, 'factor_performance.json'));
  if (!fp || !fp.factors || fp.factors.length === 0) return { available: false, message: '因子性能数据不足' };

  var factors = [];
  var totalSignals = 0, totalHits = 0;
  for (var i = 0; i < fp.factors.length; i++) {
    var f = fp.factors[i];
    totalSignals += (f.signalCount || 0);
    totalHits += Math.round((f.hitRate || 0) * (f.signalCount || 0));
    factors.push({
      id: f.id || ('H' + (i + 1)),
      name: f.name || '未知',
      hitRate: f.hitRate != null ? +(f.hitRate * 100).toFixed(1) : null,
      avgReturn: f.avgReturn != null ? +f.avgReturn.toFixed(2) : null,
      signalCount: f.signalCount || 0,
      status: f.status || 'stable',
      trend: f.trend || null,
    });
  }

  return {
    available: true,
    totalSignals: totalSignals,
    overallHitRate: totalSignals > 0 ? +(totalHits / totalSignals * 100).toFixed(1) : null,
    factors: factors,
    daysAvailable: fp.daysAvailable || 0,
    dataSource: fp.dataSource || 'scan_records',
  };
}

/**
 * Compute US-to-A prediction verification
 */
function _computeUSVerification() {
  var vh = _readJSON(path.join(SIMFOLIO_DIR, 'us_as_verification_history.json'));
  if (!vh || !vh.entries || vh.entries.length === 0) return { available: false, message: 'US预测验证数据不足' };

  var entries = vh.entries.filter(function(e) { return e.directionHitRate != null; });
  if (entries.length === 0) return { available: false, message: 'US预测尚无有效验证' };

  var totalCorrect = 0, totalPredictions = 0;
  for (var i = 0; i < entries.length; i++) {
    totalCorrect += (entries[i].correctCount || 0);
    totalPredictions += (entries[i].decisivePredictions || 0);
  }

  var hitRate = totalPredictions > 0 ? +(totalCorrect / totalPredictions * 100).toFixed(1) : null;

  return {
    available: true,
    totalEntries: entries.length,
    totalPredictions: totalPredictions,
    totalCorrect: totalCorrect,
    overallHitRate: hitRate,
    recentEntries: entries.slice(-7).map(function(e) {
      return {
        date: e.date,
        hitRate: e.directionHitRate != null ? +(e.directionHitRate * 100).toFixed(1) : null,
        correct: e.correctCount || 0,
        total: e.decisivePredictions || 0,
      };
    }),
  };
}

/**
 * Compute expected return verification
 */
function _computeExpectedReturnVerification() {
  var ev = _readJSON(path.join(SIMFOLIO_DIR, 'expected_return_verification.json'));
  if (!ev || !ev.entries || ev.entries.length === 0) return { available: false, message: '期望收益验证数据不足' };

  var entries = ev.entries.filter(function(e) { return e.directionHitRate != null; });
  if (entries.length === 0) return { available: false, message: '期望收益验证尚无有效数据' };

  var totalCorrect = 0, totalPredictions = 0, avgErrSum = 0, avgErrCount = 0;
  for (var i = 0; i < entries.length; i++) {
    totalCorrect += (entries[i].directionCorrect || 0);
    totalPredictions += (entries[i].directionTotal || 0);
    if (entries[i].avgError != null) {
      avgErrSum += entries[i].avgError * (entries[i].totalVerified || 0);
      avgErrCount += (entries[i].totalVerified || 0);
    }
  }

  return {
    available: true,
    totalEntries: entries.length,
    totalPredictions: totalPredictions,
    totalCorrect: totalCorrect,
    overallHitRate: totalPredictions > 0 ? +(totalCorrect / totalPredictions * 100).toFixed(1) : null,
    avgError: avgErrCount > 0 ? +(avgErrSum / avgErrCount).toFixed(2) : null,
    recentEntries: entries.slice(-7).map(function(e) {
      return {
        date: e.date,
        hitRate: e.directionHitRate != null ? +(e.directionHitRate * 100).toFixed(1) : null,
        correct: e.directionCorrect || 0,
        total: e.directionTotal || 0,
        avgError: e.avgError != null ? +e.avgError.toFixed(2) : null,
      };
    }),
  };
}

/**
 * Compute stock predictor verification from stock_factor_performance.json
 */
function _computeStockPredictorVerification() {
  var sf = _readJSON(path.join(SIMFOLIO_DIR, 'stock_factor_performance.json'));
  if (!sf) return { available: false, message: '个股因子性能数据不足' };

  // [v3.2.4] File uses dailyRecords (object keyed by date), not flat records array
  var records = [];
  if (sf.records && Array.isArray(sf.records)) {
    records = sf.records;
  } else if (sf.dailyRecords && typeof sf.dailyRecords === 'object') {
    Object.keys(sf.dailyRecords).forEach(function(date) {
      var dayRecords = sf.dailyRecords[date];
      if (Array.isArray(dayRecords)) {
        for (var i = 0; i < dayRecords.length; i++) {
          dayRecords[i]._date = date;
          records.push(dayRecords[i]);
        }
      }
    });
  }
  if (records.length === 0) return { available: false, message: '个股因子性能数据不足' };

  // Aggregate by factor from factorSignals array in each record
  var factorMap = {};
  var totalRecords = 0;
  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    var signals = r.factorSignals;
    if (!signals || !Array.isArray(signals)) continue;
    totalRecords++;
    for (var j = 0; j < signals.length; j++) {
      var fs = signals[j];
      var fid = fs.id || fs.factor || fs.factorId;
      if (!fid) continue;
      if (!factorMap[fid]) factorMap[fid] = { total: 0, hits: 0 };
      factorMap[fid].total++;
      if (fs.hit) factorMap[fid].hits++;
    }
  }

  var factors = [];
  var totalCount = 0, totalHits = 0;
  Object.keys(factorMap).forEach(function(fid) {
    var f = factorMap[fid];
    var hr = f.total > 0 ? f.hits / f.total : 0;
    factors.push({
      id: fid,
      hitRate: f.hits > 0 ? +(hr * 100).toFixed(1) : null,
      samples: f.total,
      verified: f.hits > 0,
    });
    totalCount += f.total;
    totalHits += f.hits;
  });

  var dates = Object.keys(sf.dailyRecords || {}).sort();
  return {
    available: true,
    totalRecords: totalRecords,
    totalDays: dates.length,
    overallHitRate: totalHits > 0 ? +(totalHits / totalCount * 100).toFixed(1) : null,
    verified: totalHits > 0,
    message: totalHits > 0 ? null : '信号已记录，等待赛后验证回填命中率',
    factors: factors.sort(function(a, b) { return (b.hitRate || -1) - (a.hitRate || -1); }),
  };
}

/**
 * Compute Rank IC: Spearman correlation between predicted score rank and actual return rank.
 * Uses scan_records data if available.
 */
function _computeRankIC() {
  // [v3.2.2] First try the new verification_history.json from verification_runner.js
  var vh = _readJSON(path.join(DATA_DIR, 'verification', 'verification_summary.json'));
  if (vh && vh.avgRankIC != null && vh.totalPredictions >= 10) {
    return {
      available: true,
      rankIC: vh.avgRankIC,
      samples: vh.totalPredictions,
      description: vh.avgRankIC > 0.2 ? '强正相关' : vh.avgRankIC > 0.1 ? '弱正相关'
        : vh.avgRankIC > 0 ? '微正相关' : vh.avgRankIC > -0.1 ? '微负相关' : '负相关',
      source: 'verification_runner',
    };
  }

  // [v3.2.4] scan_records are in SIMFOLIO_DIR, stored as flat array (not {results:...})
  // Rank IC requires fwdReturn data which only verification_runner can compute
  // from kline data. scan_records alone only has scores, not returns.
  return { available: false, message: '等待验证执行器积累数据(当前样本不足)' };
}

// ══════ v3.3.1: IC Decomposition ══════

/**
 * [v3.3.1] Compute IC decomposition: training IC vs validation IC vs forward IC.
 * Reads walk_forward_report.json and verification_summary.json.
 */
function _computeICDecomposition() {
  var wfReport = _readJSON(path.join(DATA_DIR, 'evolution', 'walk_forward_report.json'));
  var icDecomp = _readJSON(path.join(DATA_DIR, 'evolution', 'ic_decomposition.json'));
  var vSummary = _readJSON(path.join(DATA_DIR, 'verification', 'verification_summary.json'));

  if (!wfReport && !icDecomp) return { available: false, message: 'Walk-forward 报告尚未生成，请运行 bootstrap --split' };

  var result = {
    available: true,
    // Rank IC fields (Spearman correlation, from verification data)
    trainingIC: null,
    validationIC: null,
    forwardIC: null,
    // Hit rate fields (direction hit rate, from walk-forward report)
    trainingHitRate: null,
    validationHitRate: null,
    forwardHitRate: null,
    icStability: null,
    icDecayCurve: [],
    overfitRatio: null,
    verdict: 'insufficient_data',
  };

  // From IC decomposition file (generated by bootstrap_history.js --split)
  if (icDecomp) {
    result.trainingIC = icDecomp.trainingIC;
    result.validationIC = icDecomp.validationIC;
    result.forwardIC = icDecomp.forwardIC;
    result.icDecayCurve = icDecomp.icDecayCurve || [];
    result.overfitRatio = icDecomp.overfitRatio;
    result.verdict = icDecomp.verdict || 'insufficient_data';
    result.recommendation = icDecomp.recommendation;
  }

  // Supplement with walk-forward hit rate decomposition
  // NOTE: trainHitRate/validateHitRate/forwardHitRate are DIRECTION HIT RATES, not Rank IC
  // They measure "% of predictions that were directionally correct" — a different metric
  if (wfReport && wfReport.icDecomposition) {
    var t5 = wfReport.icDecomposition['T+5'] || {};
    if (result.trainingHitRate == null) result.trainingHitRate = t5.trainHitRate;
    if (result.validationHitRate == null) result.validationHitRate = t5.validateHitRate;
    if (result.forwardHitRate == null) result.forwardHitRate = t5.forwardHitRate;
    if (result.overfitRatio == null) result.overfitRatio = t5.overfitRatio;
    if (!result.verdict || result.verdict === 'insufficient_data') {
      result.verdict = wfReport.verdict || result.verdict;
    }
    result.hitRateDecomposition = wfReport.icDecomposition;
  }

  // Compute forward Rank IC from verification_summary (Spearman correlation, most current data)
  if (vSummary && vSummary.avgRankIC != null) {
    result.forwardIC = vSummary.avgRankIC;
    result.forwardSamples = vSummary.rankICSamples || 0;
  }

  // IC stability: compute from verification_history rankIC entries
  var vh = _readJSON(path.join(DATA_DIR, 'verification', 'verification_history.json'));
  if (vh && vh.rankICHistory && vh.rankICHistory.length >= 5) {
    var recent = vh.rankICHistory.slice(-30);
    var icValues = recent.map(function(r) { return r.rankIC; }).filter(function(v) { return v != null; });
    if (icValues.length >= 5) {
      var mean = icValues.reduce(function(s, v) { return s + v; }, 0) / icValues.length;
      var variance = icValues.reduce(function(s, v) { return s + (v - mean) * (v - mean); }, 0) / icValues.length;
      result.icStability = +Math.sqrt(variance).toFixed(4);
    }
  }

  // Overfit detection
  if (result.overfitRatio == null && result.trainingIC != null && result.forwardIC != null && result.trainingIC > 0) {
    result.overfitRatio = +((result.trainingIC - result.forwardIC) / result.trainingIC).toFixed(4);
    if (result.overfitRatio > 0.3) {
      result.verdict = 'significant_overfit';
      result.recommendation = '训练IC远高于前向IC，模型过拟合。建议减少因子数量或增加正则化。';
    } else if (result.overfitRatio > 0.15) {
      result.verdict = 'moderate_decay';
      result.recommendation = 'IC衰减适中，建议使用EMA平滑因子权重。';
    } else if (result.overfitRatio < 0) {
      result.verdict = 'generalizing';
      result.recommendation = '前向IC高于训练IC，模型泛化能力良好。';
    } else {
      result.verdict = 'stable';
    }
  }

  return result;
}

// ══════ v3.3.1: Confidence Calibration ══════

/**
 * [v3.3.1] Compute confidence calibration: how well do prediction scores
 * correlate with actual hit rates? Bins by score range.
 */
function _computeConfidenceCalibration() {
  var vh = _readJSON(path.join(DATA_DIR, 'verification', 'verification_history.json'));
  if (!vh || !vh.entries || vh.entries.length === 0) {
    return { available: false, message: '验证数据不足' };
  }

  // Gather all per-stock results with scores
  var allResults = [];
  for (var i = 0; i < vh.entries.length; i++) {
    var entry = vh.entries[i];
    if (!entry.results) continue;
    for (var j = 0; j < entry.results.length; j++) {
      var r = entry.results[j];
      if (r.score != null && r.directionCorrect != null) {
        allResults.push(r);
      }
    }
  }

  // Use config bins or defaults
  var bins;
  try {
    bins = require('../config').CONFIDENCE_CALIBRATION.bins || [
      { name: 'low', minScore: 0, maxScore: 55 },
      { name: 'medium', minScore: 55, maxScore: 70 },
      { name: 'high', minScore: 70, maxScore: 100 },
    ];
  } catch (_) {
    bins = [
      { name: 'low', minScore: 0, maxScore: 55 },
      { name: 'medium', minScore: 55, maxScore: 70 },
      { name: 'high', minScore: 70, maxScore: 100 },
    ];
  }

  var binResults = [];
  var totalError = 0, totalBinsWithData = 0;
  var minSamplesPerBin = 30;

  for (var b = 0; b < bins.length; b++) {
    var bin = bins[b];
    var filtered = allResults.filter(function(r) {
      return r.score >= bin.minScore && r.score < bin.maxScore;
    });

    if (filtered.length < minSamplesPerBin) {
      binResults.push({
        name: bin.name,
        minScore: bin.minScore,
        maxScore: bin.maxScore,
        count: filtered.length,
        predictedHitRate: null,
        actualHitRate: null,
        error: null,
        insufficient: true,
      });
      continue;
    }

    var hits = filtered.filter(function(r) { return r.directionCorrect; }).length;
    var actualHitRate = hits / filtered.length;
    // Predicted hit rate: use the midpoint of the score range as a proxy
    var predictedHitRate = (bin.minScore + bin.maxScore) / 2 / 100;
    var error = Math.abs(predictedHitRate - actualHitRate);

    binResults.push({
      name: bin.name,
      minScore: bin.minScore,
      maxScore: bin.maxScore,
      count: filtered.length,
      predictedHitRate: +predictedHitRate.toFixed(4),
      actualHitRate: +actualHitRate.toFixed(4),
      error: +error.toFixed(4),
    });

    totalError += error;
    totalBinsWithData++;
  }

  var calibrationScore = totalBinsWithData > 0 ? +((1 - totalError / totalBinsWithData)).toFixed(4) : null;

  // Determine verdict
  var verdict = 'insufficient_data';
  if (calibrationScore != null) {
    if (calibrationScore > 0.90) verdict = 'well_calibrated';
    else if (calibrationScore > 0.75) verdict = 'moderately_calibrated';
    else verdict = 'poorly_calibrated';
  }

  // Check if high-confidence predictions are more accurate than low
  var highBin = binResults.filter(function(b) { return b.name === 'high' && !b.insufficient; })[0];
  var lowBin = binResults.filter(function(b) { return b.name === 'low' && !b.insufficient; })[0];
  var highConfidenceAccuracyGap = (highBin && lowBin) ? +(highBin.actualHitRate - lowBin.actualHitRate).toFixed(4) : null;

  var result = {
    available: true,
    generatedAt: new Date().toISOString(),
    bins: binResults,
    calibrationScore: calibrationScore,
    verdict: verdict,
    highConfidenceAccuracyGap: highConfidenceAccuracyGap,
    interpretation: verdict === 'well_calibrated'
      ? '模型置信度校准良好，高分预测确实更准确。'
      : verdict === 'moderately_calibrated'
        ? '置信度校准中等，部分分数段准确度与预期有偏差。'
        : verdict === 'poorly_calibrated'
          ? '模型过度自信或信心不足，高分预测不够准确。'
          : '数据不足，尚无法评估校准质量。',
    recommendation: highConfidenceAccuracyGap != null && highConfidenceAccuracyGap < 0.05
      ? '高置信度预测的准确度提升不明显，建议降低高分段权重或收紧买入阈值。'
      : null,
  };

  // Persist calibration to disk for data file health tracking
  try {
    var calPath = path.join(EVOLUTION_DIR, 'calibration.json');
    var calDir = path.dirname(calPath);
    if (!fs.existsSync(calDir)) fs.mkdirSync(calDir, { recursive: true });
    fs.writeFileSync(calPath, JSON.stringify(result, null, 2), 'utf8');
  } catch (_) {}

  return result;
}

// ══════ v3.3.1: Regime-Verification ══════

/**
 * [v3.3.1] Read regime-stratified factor verification from factor_effectiveness.json.
 */
function _computeRegimeVerification() {
  var feFile = _readJSON(path.join(DATA_DIR, 'evolution', 'factor_effectiveness.json'));
  if (!feFile || !feFile.matrix) return { available: false, message: '因子有效性矩阵数据不足' };

  // Extract byRegime data from T+5 horizon
  var t5 = feFile.matrix['T+5'] || {};
  var regimes = ['bull', 'bear', 'high_vol', 'low_liquidity', 'sideways'];
  var regimeSummary = {};

  regimes.forEach(function(regime) {
    var totalSignals = 0, totalHits = 0;
    var factorStats = [];

    Object.keys(t5).forEach(function(fid) {
      var f = t5[fid];
      if (f._insufficient || !f.byRegime || !f.byRegime[regime]) return;
      var br = f.byRegime[regime];
      if (br.total === 0) return;

      totalSignals += br.total;
      totalHits += br.hits;
      factorStats.push({
        id: f.id,
        name: f.name,
        hitRate: +(br.hits / br.total * 100).toFixed(1),
        avgReturn: br.avgReturn != null ? +br.avgReturn.toFixed(2) : null,
        samples: br.total,
      });
    });

    if (factorStats.length > 0) {
      factorStats.sort(function(a, b) { return b.hitRate - a.hitRate; });
      regimeSummary[regime] = {
        overallHitRate: totalSignals > 0 ? +(totalHits / totalSignals * 100).toFixed(1) : null,
        totalSamples: totalSignals,
        topFactors: factorStats.slice(0, 3),
        weakestFactors: factorStats.slice(-3).reverse(),
      };
    }
  });

  return {
    available: Object.keys(regimeSummary).length > 0,
    generatedAt: new Date().toISOString(),
    regimes: regimeSummary,
    source: feFile.computedAt || null,
    sampleDays: feFile.sampleDays || 0,
  };
}

/**
 * Main: get full verification dashboard
 */
function getDashboard(options) {
  options = options || {};
  var lookbackDays = options.lookbackDays || 60;

  var dashboard = {
    generatedAt: new Date().toISOString(),
    lookbackDays: lookbackDays,

    // 1. Factor signal verification
    factorSignals: _computeFactorVerification(),

    // 2. US-to-A prediction verification
    usPredict: _computeUSVerification(),

    // 3. Expected return verification
    expectedReturn: _computeExpectedReturnVerification(),

    // 4. Stock predictor verification
    stockPredictor: _computeStockPredictorVerification(),

    // 5. Rank IC
    rankIC: _computeRankIC(),

    // v3.3.1: New sections
    // 6. IC Decomposition (train/validate/forward)
    icDecomposition: _computeICDecomposition(),

    // 7. Confidence Calibration
    confidenceCalibration: _computeConfidenceCalibration(),

    // 8. Regime-stratified verification
    regimeVerification: _computeRegimeVerification(),
  };

  // Compute unified summary
  var totalPredictions = 0, totalCorrect = 0;
  if (dashboard.usPredict.available && dashboard.usPredict.overallHitRate != null) {
    totalPredictions += dashboard.usPredict.totalPredictions;
    totalCorrect += dashboard.usPredict.totalCorrect;
  }
  if (dashboard.expectedReturn.available && dashboard.expectedReturn.overallHitRate != null) {
    totalPredictions += dashboard.expectedReturn.totalPredictions;
    totalCorrect += dashboard.expectedReturn.totalCorrect;
  }
  if (dashboard.stockPredictor.available && dashboard.stockPredictor.totalRecords > 0) {
    totalPredictions += dashboard.stockPredictor.totalRecords;
    totalCorrect += dashboard.factorSignals.overallHitRate != null
      ? Math.round(dashboard.factorSignals.overallHitRate / 100 * dashboard.stockPredictor.totalRecords)
      : 0;
  }

  dashboard.summary = {
    totalPredictions: totalPredictions,
    totalCorrect: totalCorrect,
    overallHitRate: totalPredictions > 0 ? +(totalCorrect / totalPredictions * 100).toFixed(1) : null,
    rankIC: dashboard.rankIC.available ? dashboard.rankIC.rankIC : null,
    dataQuality: totalPredictions < 20 ? '积累中' : totalPredictions < 50 ? '初步可用' : '稳定',
  };

  return dashboard;
}

module.exports = { getDashboard };
