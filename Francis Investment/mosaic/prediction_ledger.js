/**
 * prediction_ledger.js — Immutable Prediction Ledger I/O (v3.4.9.4.1)
 *
 * All file I/O accepts explicit dataDir parameter — test isolation by design.
 *
 * v3.4.9.4.1 P0-1: Unified dataDir convention:
 *   - dataDir is ALWAYS the report-engine/data root directory.
 *   - Manifest files live at dataDir root (not inside simfolio/).
 *   - Ledger + decision_event files live under dataDir/simfolio/.
 *
 * Functions:
 *   1. buildLedgerEntry(candidate, context) → ledger entry object
 *   2. writeLedgerFile(dataDir, entries, runId, expectedHash) → { writtenCount, duplicateCount, status }
 *   3. writeRunManifest(dataDir, date, manifest) → writes dataDir/daily_research_manifest_YYYY-MM-DD.json
 *   4. readRunManifest(dataDir, date) → manifest object or null
 *   5. writeDecisionEvent(dataDir, date, event) → appends decision_event JSONL
 */

var cohort = require('./research_cohort');
var fs, path;
try { fs = require('fs'); path = require('path'); } catch (_) {}

// ══════ 1. buildLedgerEntry — full v3.4.9.4 entry ══════

/**
 * Build a single prediction ledger entry with all v3.4.9.4 fields.
 *
 * P0.2-3: Added scheduledSlot and asOfDate to the entry for canonical cohort acceptance.
 *
 * @param {Object} candidate — pipeline result (must have code, price, prediction, etc.)
 * @param {string} runId — scheduler-assigned runId
 * @param {Object} context — { today, scheduledSlot, macroRegime, indexFreshness, indexValues,
 *                            dataQualityPenalty, note, scanType, isCanonical, kernelVerdict, buildCommit,
 *                            modelVersionId, meetsEvidenceThreshold, quoteSource, quoteAsOf }
 * @returns {Object} full ledger entry (not yet written to file)
 */
function buildLedgerEntry(candidate, runId, context) {
  if (!context) context = {};
  var today = context.today || new Date().toISOString().slice(0, 10);
  var isCanonical = context.isCanonical === true;

  // Normalize feature snapshot + hash
  var snap = cohort.normalizeResearchFeatureSnapshot(candidate);
  var featureHash = cohort._hashNormalizedSnapshot(snap);

  // Compute T+3 target date
  var targetDate = null;
  var horizonTradingDays = 3;
  try {
    var btDays = require('./evolution/bootstrap_history').generateTradingDays(
      parseInt(today.slice(0, 4), 10),
      parseInt(today.slice(0, 4), 10) + 1
    );
    if (btDays) {
      var todayIdx = btDays.indexOf(today);
      if (todayIdx >= 0 && todayIdx + horizonTradingDays < btDays.length) {
        targetDate = btDays[todayIdx + horizonTradingDays];
      }
    }
  } catch (_) {}

  // predictionId format: runId + code + horizon
  var predId = runId + '_' + (candidate.code || '?') + '_T+3';

  // Build partial entry first (needed by computeResearchEligibility + computeAllEligibility)
  var modelVersionId = context.modelVersionId || 'unknown';
  var buildCommit = context.buildCommit || null;
  try { if (!buildCommit) buildCommit = require('./config').buildCommit; } catch (_) {}
  var codeVersion = null;
  try { codeVersion = require('./config').version || null; } catch (_) {}

  var partialEntry = {
    predictionId: predId,
    price: candidate.price,
    targetDate: targetDate,
    modelVersionId: modelVersionId,
    modelVersion: codeVersion, // old field (app version) — kept for backward compat
  };

  // v3.4.9.4.1 P0-3: Call REAL meetsEvidenceThreshold per candidate
  var meetsThresholdResult = null;
  var meetsThreshold = false;
  if (candidate.prediction) {
    try {
      var erModule = require('./predict/expected_return');
      meetsThresholdResult = erModule.meetsEvidenceThreshold(candidate.prediction, context.dataQualityPenalty || 0);
      meetsThreshold = meetsThresholdResult.passed === true;
    } catch (_) {
      // fallback: use context flag
      meetsThreshold = context.meetsEvidenceThreshold === true;
    }
  } else {
    meetsThreshold = false;
  }

  // v3.4.9.4.1 P0-3: Pass kernelDecision object (not just verdict string)
  // globalTradePermission = kernelDecision.canBuy && kernelDecision.maxBuysPerDay > 0
  var kernelDecision = context.kernelDecision || null;

  // Compute 6-field eligibility
  var eligibility = cohort.computeAllEligibility(candidate, snap, kernelDecision, meetsThreshold, partialEntry);

  // Compute old researchEligible compat result
  var resEligResult = cohort.computeResearchEligibility(snap, partialEntry);

  // Feature coverage: fraction of non-null dimensions
  var featureCoverage = 0;
  var dimCount = 0;
  if (snap && snap.dimensions) {
    var dims = snap.dimensions;
    var dk = Object.keys(dims);
    var total = dk.length || 5;
    for (var di = 0; di < dk.length; di++) {
      if (dims[dk[di]] != null && typeof dims[dk[di]] === 'number' && !isNaN(dims[dk[di]])) dimCount++;
    }
    featureCoverage = total > 0 ? +(dimCount / total).toFixed(3) : 0;
  }

  // Parameter set hash — hash of model_registry baseline params
  var parameterSetHash = context.parameterSetHash || null;

  // Build full entry
  var entry = {
    // ── Identity ──
    predictionId: predId,
    scanId: runId,
    runId: runId,
    asOf: today,
    asOfDate: today,
    scheduledSlot: context.scheduledSlot || null,
    timestamp: new Date().toISOString(),
    scanType: context.scanType || 'unknown',
    canonical: isCanonical,
    horizonTradingDays: horizonTradingDays,
    targetDate: targetDate,
    horizon: 'T+3',

    // ── Model & Data Lineage (v3.4.9.4) ──
    codeVersion: codeVersion,
    buildCommit: buildCommit,
    modelVersionId: modelVersionId,
    modelVersion: codeVersion,           // backward compat (app version)
    parameterSetHash: parameterSetHash,
    featureSchemaVersion: '1.0.0',
    featureCoverage: featureCoverage,
    dataCutoffAt: new Date().toISOString(),
    quoteSource: context.quoteSource || 'unknown',
    quoteAsOf: context.quoteAsOf || null,

    // ── Stock identity ──
    code: candidate.code,
    name: candidate.name || '',
    price: candidate.price,
    entryPrice: candidate.price || null,

    // ── Feature data ──
    featureSnapshot: snap,
    featureHash: featureHash,
    compositeScore: candidate.compositeScore || 0,
    rating: candidate.rating || '--',
    factorScores: candidate.rawScores || null,
    hiddenSignals: (candidate.hiddenSignals || []).map(function(s) { return s.id || s; }),
    signalCount: (candidate.hiddenSignals || []).length,

    // ── Prediction ──
    expectedReturn: (candidate.prediction && candidate.prediction.expectedReturn != null) ? candidate.prediction.expectedReturn : null,
    confidence: (candidate.prediction && candidate.prediction.confidence != null) ? candidate.prediction.confidence : null,
    // v3.4.9.4.1 P0-3: Evidence threshold result (from real meetsEvidenceThreshold call)
    evidenceThresholdPassed: meetsThreshold,
    evidenceThresholdReason: (meetsThresholdResult && meetsThresholdResult.reason) || null,

    // ── 6-field Eligibility (v3.4.9.4.1 P0-3: globalTradePermission = kernelDecision.canBuy && maxBuysPerDay>0) ──
    schemaValid: eligibility.schemaValid,
    predictionValid: eligibility.predictionValid,
    researchEligible: eligibility.researchEligible,
    executionCandidateEligible: eligibility.executionCandidateEligible,
    globalTradePermission: eligibility.globalTradePermission,
    executionEligible: eligibility.executionEligible,
    eligibilityReasons: eligibility.reasons,

    // ── Backward compat ──
    eligible: eligibility.executionCandidateEligible, // map to executionCandidateEligible
    researchEligibilityReasons: resEligResult.reasons,

    // ── Market context ──
    marketRegime: context.macroRegime || null,
    dataFreshness: context.indexFreshness || 'unknown',
    indexSH: (context.indexValues && context.indexValues.sh) || null,
    benchmarkPrice: (context.indexValues && context.indexValues.sh) || null,

    // ── wasBought: always false at prediction time (v3.4.9.4: immutable decision_event handles this) ──
    wasBought: false,
    dataQualityPenalty: context.dataQualityPenalty || 0,
    contribDims: (candidate.prediction && candidate.prediction.breakdown)
      ? Object.values(candidate.prediction.breakdown).filter(function(b) { return b && b.available; }).length
      : 0,
    contextNote: context.note || null,

    // ── Ingestion tracking ──
    ingestionStatus: 'valid_v3.4.9.4',
  };

  return entry;
}

// ══════ 2. writeLedgerFile — idempotent appender with input drift detection ══════

/**
 * Write prediction ledger entries to file.
 * Idempotent: same runId → skips duplicates, checks input drift.
 *
 * @param {string} dataDir — base data directory (e.g., '/tmp/test-data')
 * @param {Array} entries — array of ledger entry objects
 * @param {string} runId — the runId for this batch
 * @param {string} candidateSetHash — hash of the candidate set (for drift detection)
 * @param {string} today — date string for filename
 * @returns {Object} { writtenCount, duplicateCount, status, error }
 */
function writeLedgerFile(dataDir, entries, runId, candidateSetHash, today) {
  try {
    if (!fs) return { writtenCount: 0, duplicateCount: 0, status: 'error', error: 'fs not available' };
    if (!today) today = new Date().toISOString().slice(0, 10);

    var dir = path.join(dataDir, 'simfolio');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    var file = path.join(dir, 'prediction_ledger_' + today + '.jsonl');

    // Read existing entries
    var existingPredIds = {};
    var existingRunHash = null;
    var hasExistingForRun = false;
    if (fs.existsSync(file)) {
      try {
        var lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
        for (var li = 0; li < lines.length; li++) {
          try {
            var ex = JSON.parse(lines[li]);
            if (ex.runId === runId) {
              hasExistingForRun = true;
              if (ex.predictionId) existingPredIds[ex.predictionId] = true;
              // Capture the first candidateSetHash seen for this runId
              if (existingRunHash == null && ex._candidateSetHash) {
                existingRunHash = ex._candidateSetHash;
              }
            }
          } catch (_) {}
        }
      } catch (_) {}
    }

    // Input drift check: if runId already exists but candidate set hash changed
    if (hasExistingForRun && candidateSetHash && existingRunHash && existingRunHash !== candidateSetHash) {
      return {
        writtenCount: 0,
        duplicateCount: 0,
        status: 'input_drift',
        error: 'Candidate set hash changed on re-run — existing=' + existingRunHash + ', new=' + candidateSetHash,
      };
    }

    // Idempotency: if all entries already exist, return early
    if (hasExistingForRun) {
      var newCount = 0, dupCount = 0;
      for (var ei = 0; ei < entries.length; ei++) {
        if (existingPredIds[entries[ei].predictionId]) {
          dupCount++;
        } else {
          newCount++;
        }
      }
      if (newCount === 0) {
        return { writtenCount: 0, duplicateCount: dupCount, status: 'idempotent' };
      }
    }

    // Write new entries
    var writtenCount = 0;
    var duplicateCount = 0;
    for (var ej = 0; ej < entries.length; ej++) {
      if (existingPredIds[entries[ej].predictionId]) {
        duplicateCount++;
        continue;
      }
      // Tag with candidateSetHash for future drift checks
      entries[ej]._candidateSetHash = candidateSetHash || null;
      fs.appendFileSync(file, JSON.stringify(entries[ej]) + '\n', 'utf8');
      writtenCount++;
    }

    return {
      writtenCount: writtenCount,
      duplicateCount: duplicateCount,
      status: writtenCount > 0 ? 'written' : 'idempotent',
    };
  } catch (e) {
    console.error('[PredictionLedger] writeLedgerFile error: ' + (e && e.message || 'unknown'));
    return { writtenCount: 0, duplicateCount: 0, status: 'error', error: (e && e.message) || 'unknown' };
  }
}

// ══════ 3. writeRunManifest — daily research manifest ══════

/**
 * Write daily research manifest file.
 *
 * @param {string} dataDir — base data directory
 * @param {string} date — date string YYYY-MM-DD
 * @param {Object} manifest — manifest data to write
 * @returns {boolean} success
 */
function writeRunManifest(dataDir, date, manifest) {
  try {
    if (!fs) return false;
    // v3.4.9.4.1 P0-1: Manifest lives at dataDir ROOT, not inside simfolio/
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    var file = path.join(dataDir, 'daily_research_manifest_' + date + '.json');
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf8');
    console.log('[PredictionLedger] Run manifest written: ' + file + ' status=' + manifest.status);
    return true;
  } catch (e) {
    console.error('[PredictionLedger] writeRunManifest error: ' + (e && e.message || 'unknown'));
    return false;
  }
}

// ══════ 4. readRunManifest — read daily research manifest ══════

/**
 * Read the daily research manifest for a given date.
 *
 * @param {string} dataDir — base data directory
 * @param {string} date — date string YYYY-MM-DD
 * @returns {Object|null} manifest object or null if not found/invalid
 */
function readRunManifest(dataDir, date) {
  try {
    if (!fs) return null;
    // v3.4.9.4.1 P0-1: Manifest lives at dataDir ROOT
    var file = path.join(dataDir, 'daily_research_manifest_' + date + '.json');
    if (!fs.existsSync(file)) return null;
    var raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (_) { return null; }
}

// ══════ 5. writeDecisionEvent — immutable post-trade decision event ══════

/**
 * Append an immutable decision event after trading completes.
 * This is separate from the prediction ledger — predictions never get wasBought mutated.
 *
 * @param {string} dataDir — base data directory
 * @param {string} date — date string YYYY-MM-DD
 * @param {Object} event — { predictionId, eventType, wasBought, executionPrice, shares, skipReason }
 * @returns {boolean} success
 */
function writeDecisionEvent(dataDir, date, event) {
  try {
    if (!fs) return false;
    var dir = path.join(dataDir, 'simfolio');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    var file = path.join(dir, 'decision_events_' + date + '.jsonl');
    var record = {
      predictionId: event.predictionId,
      eventType: event.eventType || 'unknown',
      timestamp: new Date().toISOString(),
      wasBought: event.wasBought === true,
      executionPrice: event.executionPrice || null,
      shares: event.shares || null,
      skipReason: event.skipReason || null,
    };
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    return true;
  } catch (e) {
    console.error('[PredictionLedger] writeDecisionEvent error: ' + (e && e.message || 'unknown'));
    return false;
  }
}

// ══════ Module Exports ══════

module.exports = {
  buildLedgerEntry: buildLedgerEntry,
  writeLedgerFile: writeLedgerFile,
  writeRunManifest: writeRunManifest,
  readRunManifest: readRunManifest,
  writeDecisionEvent: writeDecisionEvent,
};
