/**
 * model_registry.js — Model Registry & Shadow Mode (v3.3.0)
 *
 * Manages model version lifecycle:
 *   1. registerVersion() — 新训练版本进入 shadow 阶段
 *   2. logShadowPrediction() — 记录 shadow 预测（不执行交易）
 *   3. evaluateShadow() — 对比 shadow vs champion，决定晋升/淘汰
 *   4. promoteToChampion() — 晋升 shadow 为活跃模型
 *
 * Champion/Challenger pattern:
 *   - Champion: 当前活跃模型参数（用于实盘交易）
 *   - Shadow(s): 新训练版本，只在 shadow mode 记录预测，不影响实盘
 *   - 连续 N 天 shadow IC > champion IC → 自动晋升
 *
 * Data: report-engine/data/evolution/model_registry.json (runtime, not committed)
 */

var fs, path;
try { fs = require('fs'); path = require('path'); } catch (_) {}

var _state = {
  champion: null,           // { versionId, params, registeredAt, promotedAt, ... }
  shadows: [],              // [{ versionId, params, registeredAt, status, ... }]
  shadowLogs: [],           // [{ versionId, date, predictions: [], rankIC, ... }]
  promotionHistory: [],     // [{ from, to, reason, date }]
  maxVersions: 20,
  maxLogs: 500,
};

var CONFIG = {};
var REGISTRY_FILE = null;

// Load config and state on require
(function _init() {
  try {
    var config = require('../config');
    CONFIG = config.SHADOW_MODE || {};
    var mrConfig = config.MODEL_REGISTRY || {};
    REGISTRY_FILE = path.join(__dirname, '..', '..', 'report-engine', 'data', 'evolution', 'model_registry.json');
    _state.maxVersions = mrConfig.maxVersions || 20;
    _state.maxLogs = CONFIG.shadowLogMaxEntries || 500;

    // Restore persisted registry
    if (fs.existsSync(REGISTRY_FILE)) {
      var saved = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
      if (saved.champion) _state.champion = saved.champion;
      if (saved.shadows) _state.shadows = saved.shadows;
      if (saved.shadowLogs) _state.shadowLogs = saved.shadowLogs;
      if (saved.promotionHistory) _state.promotionHistory = saved.promotionHistory;
    }
  } catch (_) {}
})();

function _persist() {
  if (!REGISTRY_FILE || !fs) return;
  try {
    var dir = path.dirname(REGISTRY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify({
      champion: _state.champion,
      shadows: _state.shadows,
      shadowLogs: _state.shadowLogs.slice(-_state.maxLogs),
      promotionHistory: _state.promotionHistory,
      updatedAt: new Date().toISOString(),
    }, null, 2), 'utf8');
  } catch (_) {}
}

/**
 * Register a new model version from a training run (grid search / bootstrap).
 * New versions always enter as shadow — never directly become champion.
 *
 * @param {object} spec
 * @param {object} spec.params       — weight parameters
 * @param {string} spec.source       — 'grid_search' | 'bootstrap' | 'manual'
 * @param {number} spec.trainHitRate — hit rate during training window
 * @param {number} spec.trainIC      — Rank IC during training window
 * @param {number} spec.sampleSize   — sample count
 * @param {string} spec.date         — date string
 * @returns {object} { versionId, isChampion: false }
 */
function registerVersion(spec) {
  if (!CONFIG.enabled) return { skipped: true, reason: 'shadow_mode_disabled' };

  var ts = Date.now();
  var versionId = 'v_' + spec.date + '_' + ts;
  var entry = {
    versionId: versionId,
    params: spec.params || {},
    source: spec.source || 'unknown',
    trainHitRate: spec.trainHitRate != null ? spec.trainHitRate : null,
    trainIC: spec.trainIC != null ? spec.trainIC : null,
    sampleSize: spec.sampleSize || 0,
    registeredAt: new Date().toISOString(),
    date: spec.date || new Date().toISOString().slice(0, 10),
    status: 'shadow',      // 'shadow' | 'champion' | 'retired'
    evaluationDays: 0,
    lastEvaluated: null,
    cumulativeIC: null,
    cumulativeHitRate: null,
    verifiedSamples: 0,
  };

  _state.shadows.push(entry);

  // Prune old shadows
  if (_state.shadows.length > _state.maxVersions) {
    // Remove oldest retired first, then oldest shadows
    _state.shadows.sort(function(a, b) {
      var order = { shadow: 0, champion: 1, retired: 2 };
      var diff = (order[a.status] || 0) - (order[b.status] || 0);
      if (diff !== 0) return diff;
      return (a.registeredAt || '').localeCompare(b.registeredAt || '');
    });
    var removed = _state.shadows.splice(0, _state.shadows.length - _state.maxVersions);
    for (var i = 0; i < removed.length; i++) {
      console.log('[ModelRegistry] Pruned old version: ' + removed[i].versionId);
    }
  }

  _persist();
  console.log('[ModelRegistry] Registered shadow version: ' + versionId +
    ' (source=' + spec.source + ', hitRate=' + (spec.trainHitRate != null ? (spec.trainHitRate * 100).toFixed(1) + '%' : '?') + ')');

  return { versionId: versionId, isChampion: false, status: 'shadow' };
}

/**
 * Log predictions from a shadow model (for later evaluation against actual outcomes).
 * These predictions do NOT affect live trading decisions.
 *
 * @param {string} versionId
 * @param {object} log — { date, predictions: [{code, stockName, score, predictedReturn, ...}] }
 */
function logShadowPrediction(versionId, log) {
  if (!CONFIG.enabled) return;

  _state.shadowLogs.push({
    versionId: versionId,
    date: log.date || new Date().toISOString().slice(0, 10),
    predictions: log.predictions || [],
    loggedAt: new Date().toISOString(),
  });

  // Prune
  if (_state.shadowLogs.length > _state.maxLogs) {
    _state.shadowLogs = _state.shadowLogs.slice(-_state.maxLogs);
  }

  _persist();
}

/**
 * Evaluate shadow models against actual returns.
 * Called daily after verification_runner completes (e.g. at 16:10 after us_predict_verify).
 *
 * @param {string} dateStr — YYYY-MM-DD of evaluation
 * @returns {object} { evaluated, promoted, demoted, championIC, shadowResults }
 */
function evaluateShadow(dateStr) {
  if (!CONFIG.enabled) return { skipped: true, reason: 'shadow_mode_disabled' };
  if (!dateStr) dateStr = new Date().toISOString().slice(0, 10);

  var result = {
    date: dateStr,
    evaluated: [],
    promoted: null,
    demoted: null,
    championIC: null,
    shadowResults: [],
  };

  // Load verification data to compute real outcomes
  var verificationData = _loadVerification(dateStr);
  if (!verificationData || verificationData.samples < CONFIG.minVerificationSamples) {
    return {
      date: dateStr,
      evaluated: [],
      promoted: null,
      demoted: null,
      championIC: null,
      shadowResults: [],
      skipped: true,
      reason: '验证数据不足 (需要 ' + (CONFIG.minVerificationSamples || 30) + ' 条)',
    };
  }

  // Evaluate champion
  if (_state.champion) {
    result.championIC = _computeRankIC(_state.champion.versionId, verificationData);
  }

  // Evaluate each shadow
  var minEvalDays = CONFIG.minEvaluationDays || 5;
  for (var i = 0; i < _state.shadows.length; i++) {
    var shadow = _state.shadows[i];
    if (shadow.status !== 'shadow') continue;

    var shadowIC = _computeRankIC(shadow.versionId, verificationData);
    shadow.evaluationDays = (shadow.evaluationDays || 0) + 1;
    shadow.lastEvaluated = dateStr;
    shadow.cumulativeIC = shadow.cumulativeIC != null
      ? shadow.cumulativeIC * 0.7 + shadowIC * 0.3  // EMA smoothed
      : shadowIC;
    shadow.cumulativeHitRate = shadow.cumulativeHitRate != null
      ? shadow.cumulativeHitRate * 0.7 + (shadowIC > 0 ? shadowIC : 0) * 0.3
      : (shadowIC > 0 ? shadowIC : 0);
    shadow.verifiedSamples = (shadow.verifiedSamples || 0) + (verificationData.samples || 0);

    result.evaluated.push({
      versionId: shadow.versionId,
      days: shadow.evaluationDays,
      currentIC: shadowIC,
      cumulativeIC: shadow.cumulativeIC,
    });

    result.shadowResults.push({
      versionId: shadow.versionId,
      ic: shadowIC,
      cumulativeIC: shadow.cumulativeIC,
      evaluationDays: shadow.evaluationDays,
    });
  }

  // Check for promotion
  var promotionThreshold = CONFIG.promotionThreshold || 0.05;
  for (var j = 0; j < _state.shadows.length; j++) {
    var s = _state.shadows[j];
    if (s.status !== 'shadow') continue;
    if (s.evaluationDays < minEvalDays) continue;

    var championIC = result.championIC != null ? result.championIC : -99;
    if (s.cumulativeIC != null && s.cumulativeIC > championIC + promotionThreshold) {
      result.promoted = promoteToChampion(s.versionId,
        'Shadow IC=' + s.cumulativeIC.toFixed(3) + ' > Champion IC=' + (championIC > -99 ? championIC.toFixed(3) : 'N/A') +
        ' (连续 ' + s.evaluationDays + ' 天)');
      break; // One promotion at a time
    }
  }

  _persist();
  return result;
}

/**
 * Promote a shadow version to champion.
 *
 * @param {string} versionId
 * @param {string} reason
 * @returns {object|null}
 */
function promoteToChampion(versionId, reason) {
  var shadow = null;
  for (var i = 0; i < _state.shadows.length; i++) {
    if (_state.shadows[i].versionId === versionId) {
      shadow = _state.shadows[i];
      break;
    }
  }
  if (!shadow) return null;

  var prevChampion = _state.champion;
  // Retire previous champion
  if (prevChampion) {
    var prevEntry = null;
    for (var j = 0; j < _state.shadows.length; j++) {
      if (_state.shadows[j].versionId === prevChampion.versionId) {
        prevEntry = _state.shadows[j];
        break;
      }
    }
    if (prevEntry) {
      prevEntry.status = 'retired';
    } else {
      // Previous champion may have been pruned; add a tombstone
      prevChampion.status = 'retired';
      _state.shadows.push(prevChampion);
    }
  }

  // Promote new champion
  shadow.status = 'champion';
  shadow.promotedAt = new Date().toISOString();
  _state.champion = {
    versionId: shadow.versionId,
    params: shadow.params,
    source: shadow.source,
    cumulativeIC: shadow.cumulativeIC,
    evaluationDays: shadow.evaluationDays,
    registeredAt: shadow.registeredAt,
    promotedAt: shadow.promotedAt,
  };

  _state.promotionHistory.push({
    from: prevChampion ? prevChampion.versionId : 'none',
    to: versionId,
    reason: reason,
    date: new Date().toISOString().slice(0, 10),
  });

  _persist();
  console.log('[ModelRegistry] PROMOTED: ' + versionId + ' -> CHAMPION (' + reason + ')');
  return _state.champion;
}

/**
 * Get current champion parameters (used by simfolio for live trading).
 *
 * @returns {object|null} { versionId, params, cumulativeIC, ... }
 */
function getChampionParams() {
  if (!_state.champion) return null;
  return {
    versionId: _state.champion.versionId,
    params: _state.champion.params,
    cumulativeIC: _state.champion.cumulativeIC,
    evaluationDays: _state.champion.evaluationDays,
    promotedAt: _state.champion.promotedAt,
  };
}

/**
 * Get full registry status for API.
 *
 * @returns {object}
 */
function getRegistryStatus() {
  return {
    enabled: CONFIG.enabled || false,
    champion: _state.champion,
    shadowCount: _state.shadows.filter(function(s) { return s.status === 'shadow'; }).length,
    retiredCount: _state.shadows.filter(function(s) { return s.status === 'retired'; }).length,
    shadows: _state.shadows.filter(function(s) { return s.status === 'shadow'; }).map(function(s) {
      return {
        versionId: s.versionId,
        source: s.source,
        trainHitRate: s.trainHitRate,
        cumulativeIC: s.cumulativeIC,
        evaluationDays: s.evaluationDays,
        registeredAt: s.registeredAt,
      };
    }),
    promotionHistory: _state.promotionHistory.slice(-10),
    totalLogs: _state.shadowLogs.length,
  };
}

/**
 * Manually retire a shadow model.
 */
function retireVersion(versionId) {
  for (var i = 0; i < _state.shadows.length; i++) {
    if (_state.shadows[i].versionId === versionId) {
      _state.shadows[i].status = 'retired';
      _persist();
      console.log('[ModelRegistry] Retired: ' + versionId);
      return true;
    }
  }
  return false;
}

// ── Internal helpers ──

function _loadVerification(dateStr) {
  try {
    var vfDir = path.join(__dirname, '..', '..', 'report-engine', 'data', 'verification');
    // Load daily entries (has per-code fwd3d/fwd5d for IC computation)
    var historyFile = path.join(vfDir, 'verification_history.json');
    if (!fs.existsSync(historyFile)) return null;
    var history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    if (!history || !history.entries || !Array.isArray(history.entries)) return null;

    // Flatten per-code results across all entries into an actualReturns list
    var actualReturns = [];
    var totalSamples = 0;
    for (var i = 0; i < history.entries.length; i++) {
      var entry = history.entries[i];
      if (!entry.results || !Array.isArray(entry.results)) continue;
      for (var j = 0; j < entry.results.length; j++) {
        var r = entry.results[j];
        if (r.code && r.fwd5d != null && r.fwd5d !== 0) {
          actualReturns.push({ code: r.code, actualReturn: r.fwd5d, score: r.score || 0 });
          totalSamples++;
        }
      }
    }

    // Also load summary for aggregate stats
    var summaryFile = path.join(vfDir, 'verification_summary.json');
    var summary = null;
    if (fs.existsSync(summaryFile)) {
      summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
    }

    return {
      actualReturns: actualReturns,
      samples: totalSamples,
      overallHitRate: summary ? summary.overallHitRate : null,
      avgRankIC: summary ? summary.avgRankIC : null,
    };
  } catch (_) { return null; }
}

/**
 * Compute Rank IC for a model version against actual returns.
 * Uses shadow prediction logs + actual outcomes from verification.
 */
function _computeRankIC(versionId, verificationData) {
  try {
    // Find predictions logged for this version
    var preds = [];
    for (var i = _state.shadowLogs.length - 1; i >= 0; i--) {
      var log = _state.shadowLogs[i];
      if (log.versionId === versionId && log.predictions) {
        for (var j = 0; j < log.predictions.length; j++) {
          preds.push(log.predictions[j]);
        }
      }
    }

    if (preds.length < 10) return 0; // Not enough data

    // Extract code -> predictedReturn map
    var predMap = {};
    for (var k = 0; k < preds.length; k++) {
      var p = preds[k];
      if (p.code && p.predictedReturn != null) {
        predMap[p.code] = p.predictedReturn;
      }
    }

    // Match with actual returns from verification
    var pairs = [];
    var actuals = verificationData.actualReturns || verificationData.entries || [];
    for (var m = 0; m < actuals.length; m++) {
      var a = actuals[m];
      if (a.code && predMap[a.code] != null && a.actualReturn != null) {
        pairs.push({ predicted: predMap[a.code], actual: a.actualReturn });
      }
    }

    if (pairs.length < 10) return 0;

    // Spearman rank correlation (simplified)
    return _spearmanIC(pairs);
  } catch (_) {
    return 0;
  }
}

function _spearmanIC(pairs) {
  // Rank predicted
  pairs.sort(function(a, b) { return a.predicted - b.predicted; });
  for (var i = 0; i < pairs.length; i++) pairs[i].predRank = i + 1;

  // Rank actual
  pairs.sort(function(a, b) { return a.actual - b.actual; });
  for (var i = 0; i < pairs.length; i++) pairs[i].actualRank = i + 1;

  // Pearson on ranks
  var n = pairs.length;
  var sumPred = 0, sumActual = 0;
  for (var i = 0; i < n; i++) {
    sumPred += pairs[i].predRank;
    sumActual += pairs[i].actualRank;
  }
  var meanPred = sumPred / n;
  var meanActual = sumActual / n;

  var cov = 0, varPred = 0, varActual = 0;
  for (var i = 0; i < n; i++) {
    var dp = pairs[i].predRank - meanPred;
    var da = pairs[i].actualRank - meanActual;
    cov += dp * da;
    varPred += dp * dp;
    varActual += da * da;
  }

  if (varPred === 0 || varActual === 0) return 0;
  return cov / Math.sqrt(varPred * varActual);
}

module.exports = {
  registerVersion,
  logShadowPrediction,
  evaluateShadow,
  promoteToChampion,
  getChampionParams,
  getRegistryStatus,
  retireVersion,
};
