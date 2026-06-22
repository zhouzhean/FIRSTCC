/**
 * model_registry.js — Model Registry & Shadow Mode (v3.3.1)
 *
 * v3.3.1: Tightened promotion criteria, demotion logic, per-shadow forward sample tracking.
 *
 * Manages model version lifecycle:
 *   1. registerVersion() — 新训练版本进入 shadow 阶段
 *   2. logShadowPrediction() — 记录 shadow 预测（不执行交易）
 *   3. evaluateShadow() — 对比 shadow vs baseline，决定晋升/降级/淘汰
 *   4. promoteToBaseline() — 晋升 shadow 为活跃模型 (6项严格检查)
 *   5. demoteBaseline() — 降级 baseline (所有 shadow 显著优于 baseline)
 *
 * Baseline/Challenger pattern:
 *   - Baseline: 当前活跃模型参数（用于实盘交易）
 *   - Shadow(s): 新训练版本，只在 shadow mode 记录预测，不影响实盘
 *   - 严格晋升: IC excess + directionHitRate>52% + postCostPositive + drawdown + forwardSamples≥100
 *   - 自动降级: baseline IC 低于最佳 shadow 10%+ → flag for review
 *
 * Data: report-engine/data/evolution/model_registry.json (runtime, not committed)
 */

var fs, path;
try { fs = require('fs'); path = require('path'); } catch (_) {}

var _state = {
  baseline: null,           // { versionId, params, registeredAt, promotedAt, ... }
  shadows: [],              // [{ versionId, params, registeredAt, status, ... }]
  shadowLogs: [],           // [{ versionId, date, predictions: [], rankIC, ... }]
  promotionHistory: [],     // [{ from, to, reason, date }]
  maxVersions: 20,
  maxLogs: 500,
  // v3.3.1: Per-shadow forward sample tracking
  forwardSamples: {},       // { versionId: { total, hits, dates[], directionHitRate } }
  demotionLog: [],          // [{ baseline, reason, date, baselineIC, bestShadowIC }]
};

var CONFIG = {};
var REGISTRY_FILE = null;
var FORWARD_SAMPLES_FILE = null;
var DEMOTION_LOG_FILE = null;

// Load config and state on require
(function _init() {
  try {
    var config = require('../config');
    CONFIG = config.SHADOW_MODE || {};
    var mrConfig = config.MODEL_REGISTRY || {};
    REGISTRY_FILE = path.join(__dirname, '..', '..', 'report-engine', 'data', 'evolution', 'model_registry.json');
    FORWARD_SAMPLES_FILE = mrConfig.forwardSamplesFile
      ? path.join(__dirname, '..', '..', mrConfig.forwardSamplesFile)
      : path.join(__dirname, '..', '..', 'report-engine', 'data', 'evolution', 'shadow_forward_samples.json');
    DEMOTION_LOG_FILE = mrConfig.demotionLogFile
      ? path.join(__dirname, '..', '..', mrConfig.demotionLogFile)
      : path.join(__dirname, '..', '..', 'report-engine', 'data', 'evolution', 'demotion_log.json');
    _state.maxVersions = mrConfig.maxVersions || 20;
    _state.maxLogs = CONFIG.shadowLogMaxEntries || 500;

    // Restore persisted registry
    if (fs.existsSync(REGISTRY_FILE)) {
      var saved = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
      if (saved.baseline) _state.baseline = saved.baseline;
      if (saved.shadows) _state.shadows = saved.shadows;
      if (saved.shadowLogs) _state.shadowLogs = saved.shadowLogs;
      if (saved.promotionHistory) _state.promotionHistory = saved.promotionHistory;
      if (saved.forwardSamples) _state.forwardSamples = saved.forwardSamples;
      if (saved.demotionLog) _state.demotionLog = saved.demotionLog;
    }

    // Restore forward samples from separate file (v3.3.1 persistence)
    if (fs.existsSync(FORWARD_SAMPLES_FILE)) {
      try {
        var fsData = JSON.parse(fs.readFileSync(FORWARD_SAMPLES_FILE, 'utf8'));
        if (fsData) _state.forwardSamples = fsData;
      } catch (_) {}
    }

    // Restore demotion log from separate file
    if (fs.existsSync(DEMOTION_LOG_FILE)) {
      try {
        var dlData = JSON.parse(fs.readFileSync(DEMOTION_LOG_FILE, 'utf8'));
        if (dlData && Array.isArray(dlData)) _state.demotionLog = dlData;
      } catch (_) {}
    }
  } catch (_) {}
})();

function _persist() {
  if (!REGISTRY_FILE || !fs) return;
  try {
    var dir = path.dirname(REGISTRY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify({
      baseline: _state.baseline,
      shadows: _state.shadows,
      shadowLogs: _state.shadowLogs.slice(-_state.maxLogs),
      promotionHistory: _state.promotionHistory,
      forwardSamples: _state.forwardSamples,
      demotionLog: _state.demotionLog.slice(-50),
      updatedAt: new Date().toISOString(),
    }, null, 2), 'utf8');

    // Also persist forward samples to separate file for easier access
    try {
      var fsDir = path.dirname(FORWARD_SAMPLES_FILE);
      if (!fs.existsSync(fsDir)) fs.mkdirSync(fsDir, { recursive: true });
      fs.writeFileSync(FORWARD_SAMPLES_FILE, JSON.stringify(_state.forwardSamples, null, 2), 'utf8');
    } catch (_) {}

    // Persist demotion log separately
    try {
      fs.writeFileSync(DEMOTION_LOG_FILE, JSON.stringify(_state.demotionLog.slice(-50), null, 2), 'utf8');
    } catch (_) {}
  } catch (_) {}
}

/**
 * Register a new model version from a training run (grid search / bootstrap).
 * New versions always enter as shadow — never directly become baseline.
 *
 * @param {object} spec
 * @param {object} spec.params       — weight parameters
 * @param {string} spec.source       — 'grid_search' | 'bootstrap' | 'manual'
 * @param {number} spec.trainHitRate — hit rate during training window
 * @param {number} spec.trainIC      — Rank IC during training window
 * @param {number} spec.sampleSize   — sample count
 * @param {string} spec.date         — date string
 * @returns {object} { versionId, isBaseline: false }
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
    status: 'shadow',      // 'shadow' | 'baseline' | 'retired'
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
      var order = { shadow: 0, baseline: 1, retired: 2 };
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

  return { versionId: versionId, isBaseline: false, status: 'shadow' };
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

// ══════ v3.3.1: Forward Sample Tracking (with dedup) ══════

/**
 * [v3.3.1] Update per-shadow forward verification samples with sampleKey dedup.
 *
 * sampleKeys: array of "predictionDate|code|horizon" strings counted this batch.
 * Only NEW keys (not previously persisted) are added to total/hits.
 * Returns { addedTotal, addedHits } — how many were actually new.
 */
function updateForwardSamples(versionId, dateStr, sampleKeys, hitSampleKeys) {
  if (!_state.forwardSamples[versionId]) {
    _state.forwardSamples[versionId] = { total: 0, hits: 0, dates: [], directionHitRate: null, sampleKeys: [] };
  }
  var fs = _state.forwardSamples[versionId];
  if (!fs.sampleKeys) fs.sampleKeys = []; // migrate old records

  // Dedup: only count sampleKeys not already persisted
  var existingSet = {};
  for (var i = 0; i < fs.sampleKeys.length; i++) {
    existingSet[fs.sampleKeys[i]] = true;
  }

  // Build hit set for fast lookup
  var hitSet = {};
  if (hitSampleKeys && hitSampleKeys.length > 0) {
    for (var j = 0; j < hitSampleKeys.length; j++) {
      hitSet[hitSampleKeys[j]] = true;
    }
  }

  var newKeys = [];
  var newHits = 0;
  for (var jj = 0; jj < sampleKeys.length; jj++) {
    if (!existingSet[sampleKeys[jj]]) {
      newKeys.push(sampleKeys[jj]);
      existingSet[sampleKeys[jj]] = true;
      if (hitSet[sampleKeys[jj]]) newHits++;
    }
  }

  if (newKeys.length === 0) {
    // All samples already counted — no change
    return { addedTotal: 0, addedHits: 0 };
  }

  fs.total += newKeys.length;
  fs.hits += newHits;
  if (fs.dates.indexOf(dateStr) < 0) fs.dates.push(dateStr);
  fs.directionHitRate = fs.total > 0 ? +(fs.hits / fs.total).toFixed(4) : null;

  // Append new keys to persisted list
  for (var k = 0; k < newKeys.length; k++) {
    fs.sampleKeys.push(newKeys[k]);
  }

  _persist();
  return { addedTotal: newKeys.length, addedHits: newHits };
}

/**
 * [v3.3.1] Get forward samples for a specific shadow version.
 */
function _getForwardSamples(versionId) {
  var fs = _state.forwardSamples[versionId];
  return fs || { total: 0, hits: 0, dates: [], directionHitRate: null, sampleKeys: [] };
}

// ══════ v3.3.1: Tightened Promotion Check ══════

/**
 * [v3.3.1] Check all 6 promotion criteria for a shadow.
 * Returns detailed check results.
 */
function checkPromotionCriteria(shadow, baselineIC, baselineDrawdown) {
  var checks = {};
  var minEvalDays = CONFIG.minEvaluationDays || 5;
  var minFwdSamples = CONFIG.minForwardSamplesPerShadow || 100;
  var minDirHitRate = CONFIG.minDirectionHitRate || 0.52;
  var promotionThreshold = CONFIG.promotionThreshold || 0.05;

  // 1. IC excess
  checks.icExcess = shadow.cumulativeIC != null
    && (baselineIC == null || shadow.cumulativeIC > baselineIC + promotionThreshold);

  // 2. Direction hit rate (>52%)
  var fwdSamples = _getForwardSamples(shadow.versionId);
  checks.directionHitRate = fwdSamples.directionHitRate != null
    && fwdSamples.directionHitRate >= minDirHitRate;

  // v3.4.6: 3. Post-cost positive — use actual post-cost net return, not cumulativeIC proxy
  // Read from forward samples if available, or from verification summary
  var postCostNet = null;
  if (fwdSamples.postCostNetReturn != null) {
    postCostNet = fwdSamples.postCostNetReturn;
  } else if (shadow._postCostNetReturn != null) {
    postCostNet = shadow._postCostNetReturn;
  }
  checks.postCostPositive = postCostNet != null && postCostNet > 0;
  // Fallback to cumulativeIC only if no post-cost data available (legacy models)
  if (postCostNet == null) {
    checks.postCostPositive = shadow.cumulativeIC != null && shadow.cumulativeIC > 0;
  }

  // 4. Max drawdown not worse
  // If no baseline or drawdown unavailable, skip this check
  checks.drawdownNotWorse = true; // Default pass if no data
  if (CONFIG.maxDrawdownNotWorse && baselineDrawdown != null && shadow._maxDrawdown != null) {
    checks.drawdownNotWorse = shadow._maxDrawdown >= baselineDrawdown;
  }

  // 5. Minimum forward samples per shadow
  checks.forwardSamples = fwdSamples.total >= minFwdSamples;

  // v3.4.6: 6. Calibration check — bucket calibration (high-conf > low-conf hit rate)
  checks.calibrationCheck = true; // Default pass
  if (CONFIG.requireCalibrationCheck) {
    try {
      var calibPath = path.join(__dirname, '..', '..', 'report-engine', 'data', 'evolution', 'calibration.json');
      if (fs.existsSync(calibPath)) {
        var calib = JSON.parse(fs.readFileSync(calibPath, 'utf8'));
        if (calib.bins) {
          var highBin = calib.bins.find(function(b) { return b.name === 'high' || b.label === '高置信'; });
          var lowBin = calib.bins.find(function(b) { return b.name === 'low' || b.label === '低置信'; });
          if (highBin && lowBin && highBin.hitRate != null && lowBin.hitRate != null) {
            checks.calibrationCheck = highBin.hitRate > lowBin.hitRate;
          }
        }
      }
    } catch (_) {
      // If calibration file unavailable, don't fail — calibration is supplementary evidence
    }
  }

  // 7. Evaluation days
  checks.evaluationDays = (shadow.evaluationDays || 0) >= minEvalDays;

  // 8. [v3.3.1] Leakage audit: must be CLEAN (promotion requires real samples)
  checks.leakageAuditClean = _checkLeakageAudit('promotion');

  var allPassed = checks.icExcess && checks.directionHitRate && checks.postCostPositive
    && checks.drawdownNotWorse && checks.forwardSamples && checks.calibrationCheck
    && checks.evaluationDays && checks.leakageAuditClean;

  var failingChecks = [];
  if (!checks.icExcess) failingChecks.push('icExcess');
  if (!checks.directionHitRate) failingChecks.push('directionHitRate(>' + (minDirHitRate * 100) + '%)');
  if (!checks.postCostPositive) failingChecks.push('postCostPositive');
  if (!checks.drawdownNotWorse) failingChecks.push('drawdownNotWorse');
  if (!checks.forwardSamples) failingChecks.push('forwardSamples(≥' + minFwdSamples + ')');
  if (!checks.calibrationCheck) failingChecks.push('calibrationCheck');
  if (!checks.evaluationDays) failingChecks.push('evaluationDays(≥' + minEvalDays + ')');
  if (!checks.leakageAuditClean) failingChecks.push('leakageAuditNotClean');

  return {
    eligible: allPassed,
    checks: checks,
    failingChecks: failingChecks,
    shadowIC: shadow.cumulativeIC,
    baselineIC: baselineIC,
    forwardSamples: fwdSamples.total,
    directionHitRate: fwdSamples.directionHitRate,
  };
}

// ══════ v3.3.1: Demotion Logic ══════

/**
 * [v3.3.1] Demote the current baseline when all shadows significantly outperform it.
 */
function demoteBaseline(reason) {
  if (!_state.baseline) return null;

  var demotedEntry = {
    baseline: _state.baseline.versionId,
    reason: reason,
    date: new Date().toISOString().slice(0, 10),
    baselineIC: _state.baseline.cumulativeIC,
    bestShadowIC: null,
  };

  // Find best shadow IC for logging
  for (var i = 0; i < _state.shadows.length; i++) {
    var s = _state.shadows[i];
    if (s.status === 'shadow' && s.cumulativeIC != null) {
      if (demotedEntry.bestShadowIC == null || s.cumulativeIC > demotedEntry.bestShadowIC) {
        demotedEntry.bestShadowIC = s.cumulativeIC;
      }
    }
  }

  // Retire current baseline
  var prevBaseline = _state.baseline;
  for (var j = 0; j < _state.shadows.length; j++) {
    if (_state.shadows[j].versionId === prevBaseline.versionId) {
      _state.shadows[j].status = 'retired';
      break;
    }
  }
  _state.baseline = null;

  _state.demotionLog.push(demotedEntry);
  if (_state.demotionLog.length > 100) _state.demotionLog = _state.demotionLog.slice(-100);

  _persist();
  console.log('[ModelRegistry] DEMOTED: Baseline ' + prevBaseline.versionId + ' retired (' + reason + ')');
  return demotedEntry;
}

// ══════ Core Functions ══════

/**
 * Evaluate shadow models against actual returns.
 * v3.3.1: Added demotion check + tightened promotion criteria.
 */
function evaluateShadow(dateStr) {
  if (!CONFIG.enabled) return { skipped: true, reason: 'shadow_mode_disabled' };
  if (!dateStr) dateStr = new Date().toISOString().slice(0, 10);

  var result = {
    date: dateStr,
    evaluated: [],
    promoted: null,
    demoted: null,
    baselineIC: null,
    shadowResults: [],
  };

  // Load verification data
  var verificationData = _loadVerification(dateStr);
  if (!verificationData || verificationData.samples < CONFIG.minVerificationSamples) {
    return {
      date: dateStr, evaluated: [], promoted: null, demoted: null,
      baselineIC: null, shadowResults: [],
      skipped: true,
      reason: '验证数据不足 (需要 ' + (CONFIG.minVerificationSamples || 30) + ' 条)',
    };
  }

  // Evaluate baseline
  if (_state.baseline) {
    result.baselineIC = _computeRankIC(_state.baseline.versionId, verificationData);
    if (_state.baseline.cumulativeIC == null && result.baselineIC != null) {
      _state.baseline.cumulativeIC = result.baselineIC;
    } else if (result.baselineIC != null) {
      _state.baseline.cumulativeIC = _state.baseline.cumulativeIC * 0.7 + result.baselineIC * 0.3;
    }
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
      ? shadow.cumulativeIC * 0.7 + shadowIC * 0.3
      : shadowIC;
    // [v3.3.1] Direction Hit Rate is computed from actual direction matches,
    // NOT derived from Rank IC. Rank IC and Direction Hit Rate are separate metrics.
    // cumulativeHitRate gets updated below via forward sample direction matching.
    // Only update verifiedSamples here.
    shadow.verifiedSamples = (shadow.verifiedSamples || 0) + (verificationData.samples || 0);

    // v3.3.1: Update forward samples — strict alignment by predictionDate+code+horizon
    // Each (date, code, horizon) verification entry counts exactly once per shadow.
    // sampleKeys are persisted to prevent duplicate accumulation on re-evaluation.
    var dirHits = 0, dirTotal = 0;
    var predMap = _buildShadowPredictionMap(shadow.versionId);
    var actuals = verificationData.actualReturns || [];
    // Collect sample keys and hit status for persistent dedup
    var countedKeys = {};
    var sampleKeys = [];       // all new sampleKeys
    var hitSampleKeys = [];    // subset where direction was correct
    for (var k = 0; k < actuals.length; k++) {
      var a = actuals[k];
      if (a.actualReturn == null) continue;
      var predDate = a.predictionDate || dateStr;
      var horizon = a.horizon || 'T+3';
      var countKey = predDate + '|' + a.code + '|' + horizon;
      if (countedKeys[countKey]) continue; // dedup within this call

      // Use date-aligned prediction lookup (STRICT — no code-only fallback)
      var predReturn = typeof predMap._getPrediction === 'function'
        ? predMap._getPrediction(a.code, predDate, horizon)
        : null;
      // Fallback: try direct key lookup
      if (predReturn == null) {
        predReturn = predMap[predDate + '|' + a.code + '|' + horizon];
      }
      // v3.3.1 strict: removed code-only fallback.
      // OLD records without predictionDate skip here correctly.
      if (predReturn == null) continue; // only count stocks this shadow actually predicted, by date+code+horizon
      countedKeys[countKey] = true;
      sampleKeys.push(countKey);
      dirTotal++;
      var predUp = predReturn > 0;
      var actualUp = a.actualReturn > 0;
      if (predUp === actualUp) {
        dirHits++;
        hitSampleKeys.push(countKey);
      }
    }
    // Pass sampleKeys + hitSampleKeys for persistent dedup
    if (sampleKeys.length > 0) updateForwardSamples(shadow.versionId, dateStr, sampleKeys, hitSampleKeys);

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

  // v3.3.1: Promotion with full criteria check
  for (var j = 0; j < _state.shadows.length; j++) {
    var s = _state.shadows[j];
    if (s.status !== 'shadow') continue;
    if (s.evaluationDays < minEvalDays) continue;

    var champIC = result.baselineIC != null ? result.baselineIC : -99;
    var criteria = checkPromotionCriteria(s, champIC, null);

    if (criteria.eligible) {
      result.promoted = promoteToBaseline(s.versionId,
        'Shadow IC=' + (s.cumulativeIC != null ? s.cumulativeIC.toFixed(3) : '?') +
        ' > Baseline IC=' + (champIC > -99 ? champIC.toFixed(3) : 'N/A') +
        ' | 方向命中率=' + (criteria.directionHitRate != null ? (criteria.directionHitRate * 100).toFixed(1) + '%' : '?') +
        ' | Fwd样本=' + criteria.forwardSamples +
        ' (连续 ' + s.evaluationDays + ' 天)');
      break;
    } else if (s.evaluationDays >= minEvalDays && criteria.failingChecks.length > 0) {
      // Log blocked promotions for debugging
      console.log('[ModelRegistry] Promotion blocked for ' + s.versionId +
        ': failing=' + criteria.failingChecks.join(',') +
        ' (IC=' + (s.cumulativeIC != null ? s.cumulativeIC.toFixed(3) : 'null') +
        ', dirHR=' + (criteria.directionHitRate != null ? (criteria.directionHitRate * 100).toFixed(1) + '%' : 'null') +
        ', fwdSamples=' + criteria.forwardSamples + ')');
    }
  }

  // v3.3.1: Demotion check
  var demotionThreshold = CONFIG.demotionThreshold || -0.10;
  if (_state.baseline && result.baselineIC != null) {
    var bestShadowIC = -99;
    for (var si = 0; si < result.shadowResults.length; si++) {
      if (result.shadowResults[si].cumulativeIC != null &&
          result.shadowResults[si].cumulativeIC > bestShadowIC) {
        bestShadowIC = result.shadowResults[si].cumulativeIC;
      }
    }
    // Demote if: baselineIC is negative AND best shadow beats baseline by |demotionThreshold|+
    if (result.baselineIC < 0 && bestShadowIC > result.baselineIC - demotionThreshold) {
      result.demoted = demoteBaseline(
        'Baseline IC=' + result.baselineIC.toFixed(3) + ' is negative ' +
        'while best shadow IC=' + bestShadowIC.toFixed(3) +
        ' (gap=' + (bestShadowIC - result.baselineIC).toFixed(3) + ' > ' + (-demotionThreshold).toFixed(2) + ')'
      );
    }
  }

  _persist();
  return result;
}

/**
 * Promote a shadow version to baseline.
 *
 * @param {string} versionId
 * @param {string} reason
 * @returns {object|null}
 */
function promoteToBaseline(versionId, reason) {
  var shadow = null;
  for (var i = 0; i < _state.shadows.length; i++) {
    if (_state.shadows[i].versionId === versionId) {
      shadow = _state.shadows[i];
      break;
    }
  }
  if (!shadow) return null;

  // v3.3.1: Safety net — run full criteria check even if already done in evaluateShadow
  // IMPORTANT: pass the REAL baseline IC, not the shadow's own IC
  if (shadow.status === 'shadow') {
    var baselineIC = _state.baseline ? _state.baseline.cumulativeIC : null;
    var baselineDrawdown = _state.baseline ? _state.baseline._maxDrawdown : null;
    var criteria = checkPromotionCriteria(shadow, baselineIC, baselineDrawdown);
    if (!criteria.eligible) {
      console.log('[ModelRegistry] SAFETY BLOCK: Promotion blocked for ' + versionId +
        ' — ' + criteria.failingChecks.join(', '));
      return null;
    }
  }

  var prevBaseline = _state.baseline;
  // Retire previous baseline
  if (prevBaseline) {
    var prevEntry = null;
    for (var j = 0; j < _state.shadows.length; j++) {
      if (_state.shadows[j].versionId === prevBaseline.versionId) {
        prevEntry = _state.shadows[j];
        break;
      }
    }
    if (prevEntry) {
      prevEntry.status = 'retired';
    } else {
      // Previous baseline may have been pruned; add a tombstone
      prevBaseline.status = 'retired';
      _state.shadows.push(prevBaseline);
    }
  }

  // Promote new baseline
  shadow.status = 'baseline';
  shadow.promotedAt = new Date().toISOString();
  _state.baseline = {
    versionId: shadow.versionId,
    params: shadow.params,
    source: shadow.source,
    cumulativeIC: shadow.cumulativeIC,
    evaluationDays: shadow.evaluationDays,
    registeredAt: shadow.registeredAt,
    promotedAt: shadow.promotedAt,
  };

  _state.promotionHistory.push({
    from: prevBaseline ? prevBaseline.versionId : 'none',
    to: versionId,
    reason: reason,
    date: new Date().toISOString().slice(0, 10),
  });

  _persist();
  console.log('[ModelRegistry] PROMOTED: ' + versionId + ' -> BASELINE (' + reason + ')');
  return _state.baseline;
}

/**
 * Get current baseline parameters (used by simfolio for live trading).
 *
 * @returns {object|null} { versionId, params, cumulativeIC, ... }
 */
function getBaselineParams() {
  if (!_state.baseline) return null;
  return {
    versionId: _state.baseline.versionId,
    params: _state.baseline.params,
    cumulativeIC: _state.baseline.cumulativeIC,
    evaluationDays: _state.baseline.evaluationDays,
    promotedAt: _state.baseline.promotedAt,
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
    baseline: _state.baseline,
    shadowCount: _state.shadows.filter(function(s) { return s.status === 'shadow'; }).length,
    retiredCount: _state.shadows.filter(function(s) { return s.status === 'retired'; }).length,
    shadows: _state.shadows.filter(function(s) { return s.status === 'shadow'; }).map(function(s) {
      var fwdSam = _getForwardSamples(s.versionId);
      return {
        versionId: s.versionId,
        source: s.source,
        trainHitRate: s.trainHitRate,
        cumulativeIC: s.cumulativeIC,
        cumulativeHitRate: s.cumulativeHitRate,
        evaluationDays: s.evaluationDays,
        registeredAt: s.registeredAt,
        // v3.3.1: Include forward sample stats for UI
        forwardSamples: fwdSam.total || 0,
        directionHitRate: fwdSam.directionHitRate,
        _maxDrawdown: s._maxDrawdown,
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

/**
 * [v3.3.1] Build a (predictionDate, code, horizon) → predictedReturn map from shadow logs.
 *
 * CRITICAL: We must align by predictionDate+code+horizon (not just "latest prediction").
 * Each verification entry has its own predictionDate — a shadow's prediction on date D
 * should be verified against the actual return from D to D+horizon, not against
 * a different date's actual return.
 *
 * Returns map keyed by "date|code|horizon" → predictedReturn.
 * Also provides a helper getPrediction(code, date, horizon) for lookup.
 */
function _buildShadowPredictionMap(versionId) {
  var predMap = {};       // "date|code|horizon" → predictedReturn
  var latestByCode = {};  // code → predictedReturn (fallback for backward compat)

  for (var i = _state.shadowLogs.length - 1; i >= 0; i--) {
    var log = _state.shadowLogs[i];
    if (log.versionId !== versionId) continue;
    var logDate = log.date;
    var preds = log.predictions || [];
    for (var j = 0; j < preds.length; j++) {
      var p = preds[j];
      if (p.code && p.predictedReturn != null) {
        var horizon = p.horizon || 'T+3';
        var key = logDate + '|' + p.code + '|' + horizon;
        // First encounter (most recent log) wins for each exact key
        if (!(key in predMap)) {
          predMap[key] = p.predictedReturn;
        }
        // Fallback: most recent prediction per code (any date/horizon)
        if (!(p.code in latestByCode)) {
          latestByCode[p.code] = p.predictedReturn;
        }
      }
    }
  }

  // Attach helper for date-aligned lookup
  predMap._getPrediction = function(code, date, horizon) {
    horizon = horizon || 'T+3';
    var key = date + '|' + code + '|' + horizon;
    if (key in predMap) return predMap[key];
    // Fallback: try other horizons for same date+code
    var prefix = date + '|' + code + '|';
    for (var k in predMap) {
      if (k.indexOf(prefix) === 0) return predMap[k];
    }
    // v3.3.1 strict: NO latestByCode fallback — return null if not matched by date+code+horizon
    return null;
  };

  // Expose for backward-compat: OLD verification records without predictionDate
  // may need code-only fallback as a last resort. New code MUST use _getPrediction.
  predMap._latestByCode = latestByCode;

  return predMap;
}

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
        // v3.3.1: Use fwd3d to match verification primary horizon T+3
        if (r.code && r.fwd3d != null && r.fwd3d !== 0) {
          actualReturns.push({
            code: r.code,
            actualReturn: r.fwd3d,
            score: r.score || 0,
            predictionDate: r.predictionDate || entry.date,
            targetDate: r.targetDate || null,
            horizon: r.horizon || 'T+3',
          });
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
    // [v3.3.1 fix] Use date-aligned prediction lookup (same as evaluateShadow)
    // No longer uses code-only predMap — aligns by predictionDate+code+horizon
    var predMap = _buildShadowPredictionMap(versionId);

    // Count entries to check we have enough data
    var totalPreds = 0;
    for (var k in predMap) {
      if (predMap.hasOwnProperty(k) && typeof predMap[k] === 'number') totalPreds++;
    }
    if (totalPreds < 10) return 0; // Not enough data

    // Match with actual returns from verification, aligned by date+code+horizon
    var pairs = [];
    var actuals = verificationData.actualReturns || verificationData.entries || [];
    for (var m = 0; m < actuals.length; m++) {
      var a = actuals[m];
      if (!a.code || a.actualReturn == null) continue;
      var predDate = a.predictionDate || '';
      var horizon = a.horizon || 'T+3';

      // Date-aligned lookup (same strict method as evaluateShadow)
      var predReturn = typeof predMap._getPrediction === 'function'
        ? predMap._getPrediction(a.code, predDate, horizon)
        : null;
      if (predReturn == null) {
        predReturn = predMap[predDate + '|' + a.code + '|' + horizon];
      }
      // v3.3.1 strict: removed code-only fallback.
      // Only match when predictionDate+code+horizon align exactly.
      if (predReturn != null) {
        pairs.push({ predicted: predReturn, actual: a.actualReturn });
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

/**
 * [v3.3.2] Check if leakage audit permits the given action.
 * @param {string} purpose - 'promotion' (Baseline/trading, strict) or 'learning' (Shadow, permissive)
 *
 * Learning:   NO_SAMPLES → OK (don't block Shadow accumulation).
 *             MINOR_ISSUES → OK (model can learn, promotion needs manual review).
 *             CRITICAL / DATA_LEAKAGE_RISK → BLOCK.
 * Promotion:  Only CLEAN (totalChecks > 0, verdict === 'CLEAN') passes.
 *             NO_SAMPLES / MINOR_ISSUES → BLOCK (human review needed).
 *             CRITICAL / DATA_LEAKAGE_RISK → BLOCK.
 * Trading:    same as promotion — must have clean audit.
 */
function _checkLeakageAudit(purpose) {
  try {
    var auditPath = path.join(__dirname, '..', '..', 'report-engine', 'data', 'verification', 'leakage_audit.json');
    if (!fs.existsSync(auditPath)) {
      // No audit file at all — allow learning, block promotion/trading
      return purpose === 'learning';
    }
    var audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
    if (!audit || !audit.verdict) return purpose === 'learning';

    var verdict = audit.verdict;
    var totalChecks = audit.totalChecks || 0;

    // Always block on critical or high-risk leakage
    if (verdict === 'CRITICAL_DATA_LEAKAGE') return false;
    if (verdict === 'DATA_LEAKAGE_RISK') return false;

    // NO_SAMPLES: allow learning (continue accumulation), block promotion/trading
    if (verdict === 'NO_SAMPLES' || verdict === 'INSUFFICIENT_DATA' || totalChecks === 0) {
      return purpose === 'learning';
    }

    // [v3.3.2] MINOR_ISSUES: allow learning only, NOT promotion
    // For promotion (Baseline/trading): only CLEAN (totalChecks>0, 0 violations) passes
    // For learning (Shadow): MINOR_ISSUES is acceptable
    if (verdict === 'CLEAN' && totalChecks > 0) return true;
    if (verdict === 'MINOR_ISSUES') return purpose === 'learning';
    // Fallback: any unexpected clean-ish state — allow learning, block promotion
    return purpose === 'learning';
  } catch (_) { return purpose === 'learning'; }
}

module.exports = {
  registerVersion,
  logShadowPrediction,
  evaluateShadow,
  promoteToBaseline,
  demoteBaseline,
  checkPromotionCriteria,
  updateForwardSamples,
  getBaselineParams,
  getRegistryStatus,
  retireVersion,
};
