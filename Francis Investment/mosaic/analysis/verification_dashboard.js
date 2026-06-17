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
