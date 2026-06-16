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
  if (!sf || !sf.records || sf.records.length === 0) return { available: false, message: '个股因子性能数据不足' };

  // Per-factor aggregation
  var factorMap = {};
  for (var i = 0; i < sf.records.length; i++) {
    var r = sf.records[i];
    var fid = r.factor || r.factorId;
    if (!fid) continue;
    if (!factorMap[fid]) factorMap[fid] = { total: 0, hits: 0, returns: [] };
    factorMap[fid].total++;
    if (r.hit) factorMap[fid].hits++;
    if (r.fwdReturn != null) factorMap[fid].returns.push(r.fwdReturn);
  }

  var factors = [];
  var totalCount = 0, totalHits = 0;
  Object.keys(factorMap).forEach(function(fid) {
    var f = factorMap[fid];
    var hr = f.total > 0 ? f.hits / f.total : 0;
    var avgRet = f.returns.length > 0 ? f.returns.reduce(function(s, v) { return s + v; }, 0) / f.returns.length : 0;
    factors.push({ id: fid, hitRate: +(hr * 100).toFixed(1), avgReturn: +avgRet.toFixed(2), samples: f.total });
    totalCount += f.total;
    totalHits += f.hits;
  });

  return {
    available: true,
    totalRecords: sf.records.length,
    totalDays: sf.days || (sf.records.length > 0 ? (new Set(sf.records.map(function(r) { return r.date; }))).size : 0),
    overallHitRate: totalCount > 0 ? +(totalHits / totalCount * 100).toFixed(1) : null,
    factors: factors.sort(function(a, b) { return b.hitRate - a.hitRate; }),
  };
}

/**
 * Compute Rank IC: Spearman correlation between predicted score rank and actual return rank.
 * Uses scan_records data if available.
 */
function _computeRankIC() {
  // Scan records provide snapshots of predictions vs outcomes
  var scanPath = path.join(DATA_DIR, 'scan_records_latest.json');
  var scan = _readJSON(scanPath);
  if (!scan || !scan.results || scan.results.length === 0) {
    // Try finding the most recent scan
    var files = [];
    try {
      files = fs.readdirSync(DATA_DIR).filter(function(f) { return f.startsWith('scan_records_'); });
      files.sort();
      if (files.length > 0) {
        scan = _readJSON(path.join(DATA_DIR, files[files.length - 1]));
      }
    } catch (_) {}
  }

  if (!scan || !scan.results || scan.results.length < 10) return { available: false, message: '扫描记录不足(需≥10条)' };

  var results = scan.results.filter(function(r) { return r.compositeScore != null && r.fwdReturn != null; });
  if (results.length < 10) return { available: false, message: '有效记录不足(需≥10条)' };

  // Rank IC: rank the predictions, rank the outcomes, compute Spearman
  // Simple: sort by compositeScore, sort by fwdReturn, correlate ranks
  var n = results.length;
  var sortedByScore = results.slice().sort(function(a, b) { return (b.compositeScore || 0) - (a.compositeScore || 0); });
  var sortedByReturn = results.slice().sort(function(a, b) { return (b.fwdReturn || 0) - (a.fwdReturn || 0); });

  var rankByScore = {};
  for (var i = 0; i < n; i++) {
    rankByScore[sortedByScore[i].code] = i + 1;
  }
  var rankByReturn = {};
  for (var j = 0; j < n; j++) {
    rankByReturn[sortedByReturn[j].code] = j + 1;
  }

  var dSqSum = 0;
  for (var k = 0; k < results.length; k++) {
    var code = results[k].code;
    var d = (rankByScore[code] || 0) - (rankByReturn[code] || 0);
    dSqSum += d * d;
  }

  var rankIC = 1 - (6 * dSqSum) / (n * (n * n - 1));
  return {
    available: true,
    rankIC: +rankIC.toFixed(3),
    samples: n,
    description: rankIC > 0.2 ? '强正相关' : rankIC > 0.1 ? '弱正相关' : rankIC > 0 ? '微正相关' : rankIC > -0.1 ? '微负相关' : '负相关',
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
