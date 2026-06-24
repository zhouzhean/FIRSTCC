/**
 * P0-C.1: Shared Cohort Statistics — Single Source of Truth
 *
 * Pure functions (zero HTTP, zero side effects, only file reads).
 * Used by:
 *   - /api/prediction-settlement  (mosaic_server.js)
 *   - /api/cohort-integrity       (mosaic_server.js)
 *   - _generateCanonicalAcceptance (scheduler.js)
 *
 * All three consumers call the same functions — no more inline duplicate logic,
 * no more tautological "same function twice" API consistency checks.
 *
 * Exports:
 *   buildPredictionSettlementStats(dataDir, date)   — full PS API response object
 *   buildCohortIntegrityStats(dataDir, date)         — full CI API response object
 *   buildCanonicalRunStats(dataDir, date, runId)     — triple-filtered subset for scheduler acceptance
 */

var fs, path;
try { fs = require('fs'); path = require('path'); } catch (_) {}

// ══════ Internal: Shared Ledger Scanner ══════

/**
 * Scan a prediction ledger file and compute all shared stats.
 * This is the single implementation that all three exported functions delegate to.
 *
 * @param {string} ledgerPath — path to prediction_ledger_YYYY-MM-DD.jsonl
 * @param {object} options
 * @param {string|null} options.filterRunId — if set, triple-filter by runId
 * @param {string|null} options.filterSlot — if set, triple-filter by scheduledSlot
 * @param {boolean} options.collectReasons — whether to collect exclusion/eligibility reason distributions
 * @returns {object} shared stats object
 */
function _scanLedger(ledgerPath, options) {
  var opts = options || {};
  var filterRunId = opts.filterRunId || null;
  var filterSlot = opts.filterSlot || null;
  var collectReasons = opts.collectReasons !== false;

  var stats = {
    totalEntries: 0,
    canonicalCohortCount: 0,
    intradayCount: 0,
    quarantinedCount: 0,
    legacyNoTargetDate: 0,
    legacyRecords: [],
    canonicalComplete: 0,
    canonicalTop50: 0,         // Legacy alias for canonicalCohortCount
    intradayObservationCount: 0, // Legacy alias for intradayCount
    eligible: 0,
    evaluationEligible: 0,
    researchEligible: 0,
    executionEligible: 0,
    schemaValid: 0,
    predictionValid: 0,
    executionCandidateEligible: 0,
    globalBlocked: 0,
    canonicalFieldValidation: {
      totalCanonical: 0,
      allFieldsPresent: 0,
      missingFields: {
        runId: 0, scheduledSlot: 0, asOfDate: 0, targetDate: 0,
        predictionId: 0, featureSnapshot: 0, modelVersionId: 0,
      },
    },
    exclusionReasons: {},
    eligibilityReasons: {},
    runId: null,
    canonicalCohortTarget: 50,
  };

  if (!fs.existsSync(ledgerPath)) return stats;

  try {
    var lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean);
    stats.totalEntries = lines.length;

    for (var li = 0; li < lines.length; li++) {
      try {
        var entry = JSON.parse(lines[li]);

        // ── Quarantined ──
        if (entry.ingestionStatus === 'invalid_schema_v3492') {
          stats.quarantinedCount++;
          continue;
        }

        // ── Legacy (no targetDate) ──
        if (!entry.targetDate || entry.targetDate === null) {
          stats.legacyNoTargetDate++;
          if (stats.legacyRecords.length < 5) {
            stats.legacyRecords.push({
              predictionId: entry.predictionId,
              asOf: entry.asOf,
              code: entry.code,
              ingestionStatus: entry.ingestionStatus || 'legacy_no_target_date',
              _note: 'missing targetDate field — cannot determine settlement date',
            });
          }
          continue;
        }

        // ── Canonical complete check (all 7 fields) ──
        var _asOfDate = entry.asOfDate || entry.asOf || null;
        var hasAllRequired = entry.runId && entry.predictionId && _asOfDate && entry.targetDate
          && entry.featureSnapshot && entry.modelVersionId;
        if (hasAllRequired) stats.canonicalComplete++;

        // ── Triple filter: canonical===true && runId match && scheduledSlot match ──
        var isInRun = (!filterRunId || entry.runId === filterRunId);
        var isInSlot = (!filterSlot || entry.scheduledSlot === filterSlot);
        var isCanonical = (entry.canonical === true);
        var useTripleFilter = !!(filterRunId || filterSlot);

        if (useTripleFilter) {
          // Triple-filter mode (scheduler canonical acceptance)
          if (isCanonical && isInRun && isInSlot) {
            stats.canonicalCohortCount++;
            stats.canonicalTop50++;

            // Field validation
            var fv = stats.canonicalFieldValidation;
            fv.totalCanonical++;
            var allOk = true;
            if (!entry.runId)               { fv.missingFields.runId++; allOk = false; }
            if (!entry.scheduledSlot)        { fv.missingFields.scheduledSlot++; allOk = false; }
            if (!_asOfDate)                  { fv.missingFields.asOfDate++; allOk = false; }
            if (!entry.targetDate)           { fv.missingFields.targetDate++; allOk = false; }
            if (!entry.predictionId)         { fv.missingFields.predictionId++; allOk = false; }
            if (!entry.featureSnapshot)      { fv.missingFields.featureSnapshot++; allOk = false; }
            if (!entry.modelVersionId)       { fv.missingFields.modelVersionId++; allOk = false; }
            if (allOk) fv.allFieldsPresent++;

            // Eligibility (triple-filtered)
            if (entry.eligible) stats.eligible++;
            if (entry.evaluationEligible) stats.evaluationEligible++;
            if (entry.schemaValid) stats.schemaValid++;
            if (entry.predictionValid) stats.predictionValid++;
            if (entry.researchEligible) stats.researchEligible++;
            if (entry.executionCandidateEligible) stats.executionCandidateEligible++;
            if (!entry.globalTradePermission) stats.globalBlocked++;
            if (entry.executionEligible) stats.executionEligible++;

            if (collectReasons) {
              var reason = entry.exclusionReason || 'none';
              stats.exclusionReasons[reason] = (stats.exclusionReasons[reason] || 0) + 1;

              var er = entry.researchEligibilityReasons;
              if (Array.isArray(er)) {
                for (var eri = 0; eri < er.length; eri++) {
                  stats.eligibilityReasons[er[eri]] = (stats.eligibilityReasons[er[eri]] || 0) + 1;
                }
              }
            }
          } else if (isCanonical) {
            stats.intradayCount++;
            stats.intradayObservationCount++;
          } else {
            stats.intradayCount++;
            stats.intradayObservationCount++;
          }
        } else {
          // Unfiltered mode (API endpoints — show ALL entries regardless of run)
          if (entry.canonical === true) {
            stats.canonicalCohortCount++;
            stats.canonicalTop50++;

            // Field validation (all canonical entries, no runId/slot filter)
            var fv2 = stats.canonicalFieldValidation;
            fv2.totalCanonical++;
            var allOk2 = true;
            if (!entry.runId)               { fv2.missingFields.runId++; allOk2 = false; }
            if (!entry.scheduledSlot)        { fv2.missingFields.scheduledSlot++; allOk2 = false; }
            if (!_asOfDate)                  { fv2.missingFields.asOfDate++; allOk2 = false; }
            if (!entry.targetDate)           { fv2.missingFields.targetDate++; allOk2 = false; }
            if (!entry.predictionId)         { fv2.missingFields.predictionId++; allOk2 = false; }
            if (!entry.featureSnapshot)      { fv2.missingFields.featureSnapshot++; allOk2 = false; }
            if (!entry.modelVersionId)       { fv2.missingFields.modelVersionId++; allOk2 = false; }
            if (allOk2) fv2.allFieldsPresent++;
          } else {
            stats.intradayCount++;
            stats.intradayObservationCount++;
          }

          // Eligibility (unfiltered — all non-legacy, non-quarantined entries)
          if (entry.eligible) stats.eligible++;
          if (entry.evaluationEligible) stats.evaluationEligible++;
          if (entry.schemaValid) stats.schemaValid++;
          if (entry.predictionValid) stats.predictionValid++;
          if (entry.researchEligible) stats.researchEligible++;
          if (entry.executionCandidateEligible) stats.executionCandidateEligible++;
          if (!entry.globalTradePermission) stats.globalBlocked++;
          if (entry.executionEligible) stats.executionEligible++;

          // Capture runId from first valid entry
          if (!stats.runId && entry.runId) stats.runId = entry.runId;

          if (collectReasons) {
            var reason2 = entry.exclusionReason || 'none';
            stats.exclusionReasons[reason2] = (stats.exclusionReasons[reason2] || 0) + 1;

            var er2 = entry.researchEligibilityReasons;
            if (Array.isArray(er2)) {
              for (var eri2 = 0; eri2 < er2.length; eri2++) {
                stats.eligibilityReasons[er2[eri2]] = (stats.eligibilityReasons[er2[eri2]] || 0) + 1;
              }
            } else if (!entry.researchEligible && entry.ingestionStatus) {
              stats.eligibilityReasons[entry.ingestionStatus] = (stats.eligibilityReasons[entry.ingestionStatus] || 0) + 1;
            }
          }
        }
      } catch (_) {}
    }
  } catch (_) {}

  return stats;
}

// ══════ 1. buildPredictionSettlementStats ══════

/**
 * Build the full response for /api/prediction-settlement.
 * Shared ledger stats + outcome ledger + T+3 pending + independent days.
 *
 * @param {string} dataDir — path to report-engine/data
 * @param {string} date — date string YYYY-MM-DD
 * @returns {object} full PS API response (identical structure to current mosaic_server.js)
 */
function buildPredictionSettlementStats(dataDir, date) {
  var ledgerFile = path.join(dataDir, 'simfolio', 'prediction_ledger_' + date + '.jsonl');
  var stats = _scanLedger(ledgerFile, { collectReasons: true });

  var result = {
    ok: true,
    date: date,
    top50: stats.totalEntries,
    eligible: stats.eligible,
    evaluationEligible: stats.evaluationEligible,
    researchEligible: stats.researchEligible,
    executionEligible: stats.executionEligible,
    schemaValid: stats.schemaValid,
    predictionValid: stats.predictionValid,
    executionCandidateEligible: stats.executionCandidateEligible,
    globalBlocked: stats.globalBlocked,
    canonicalTop50: stats.canonicalTop50,
    intradayObservationCount: stats.intradayObservationCount,
    canonicalCohortCount: stats.canonicalCohortCount,
    intradayCount: stats.intradayCount,
    quarantinedCount: stats.quarantinedCount,
    canonicalCohortTarget: stats.canonicalCohortTarget,
    canonicalFieldValidation: stats.canonicalFieldValidation,
    canonicalComplete: stats.canonicalComplete,
    legacyNoTargetDate: stats.legacyNoTargetDate,
    legacyRecords: stats.legacyRecords,
    exclusionReasons: stats.exclusionReasons,
    eligibilityReasons: stats.eligibilityReasons,
    t3pending: 0,
    settledToday: 0,
    settledOnTargetToday: 0,
    hasLedger: fs.existsSync(ledgerFile),
    hasOutcome: false,
    runId: stats.runId,
    independentDays: null,
  };

  // ── Outcome ledger ──
  var olFile = path.join(dataDir, 'simfolio', 'outcome_ledger.jsonl');
  if (fs.existsSync(olFile)) {
    result.hasOutcome = true;
    try {
      var olines = fs.readFileSync(olFile, 'utf8').trim().split('\n').filter(Boolean);
      var settledCount = 0;
      var unavailableCount = 0;
      for (var oi = 0; oi < olines.length; oi++) {
        try {
          var oentry = JSON.parse(olines[oi]);
          if (oentry.status === 'settled') settledCount++;
          else unavailableCount++;
          if (oentry.targetDate === date) result.settledOnTargetToday++;
        } catch (_) {}
      }
      result.settledToday = settledCount;
      result.unavailableCount = unavailableCount;
    } catch (_) {}
  }

  // ── T+3 pending ──
  try {
    var simfolioDir = path.join(dataDir, 'simfolio');
    if (fs.existsSync(simfolioDir)) {
      var allFiles = fs.readdirSync(simfolioDir);
      var predFiles = allFiles.filter(function (f) {
        return /^prediction_ledger_\d{4}-\d{2}-\d{2}\.jsonl$/.test(f);
      });
      var settledIds = {};
      if (result.hasOutcome) {
        try {
          var olines2 = fs.readFileSync(olFile, 'utf8').trim().split('\n').filter(Boolean);
          for (var si = 0; si < olines2.length; si++) {
            try {
              var oe = JSON.parse(olines2[si]);
              if (oe.predictionId) settledIds[oe.predictionId] = true;
            } catch (_) {}
          }
        } catch (_) {}
      }
      var threeDaysAgo = new Date(date + 'T00:00:00+08:00').getTime() - 3 * 24 * 3600 * 1000;
      var pendingCount = 0;
      for (var fi = 0; fi < predFiles.length; fi++) {
        var fileDate = predFiles[fi].replace('prediction_ledger_', '').replace('.jsonl', '');
        var fileMs = new Date(fileDate + 'T00:00:00+08:00').getTime();
        if (fileMs >= threeDaysAgo) continue;
        try {
          var plines2 = fs.readFileSync(path.join(simfolioDir, predFiles[fi]), 'utf8').trim().split('\n').filter(Boolean);
          for (var pj = 0; pj < plines2.length; pj++) {
            try {
              var pe = JSON.parse(plines2[pj]);
              if (pe.predictionId && !settledIds[pe.predictionId] && pe.researchEligible) {
                pendingCount++;
              }
            } catch (_) {}
          }
        } catch (_) {}
      }
      result.t3pending = pendingCount;
    }
  } catch (_) {}

  // ── Independent days from verification ──
  try {
    var vsFile = path.join(dataDir, 'verification', 'verification_summary.json');
    if (fs.existsSync(vsFile)) {
      var vsData = JSON.parse(fs.readFileSync(vsFile, 'utf8'));
      if (vsData.overall && vsData.overall.rankIC) {
        result.independentDays = vsData.overall.rankIC.independentDays || 0;
      }
    }
  } catch (_) {}

  return result;
}

// ══════ 2. buildCohortIntegrityStats ══════

/**
 * Build the full response for /api/cohort-integrity.
 * Shared ledger stats + manifest + decision_events + featureCoverage.
 *
 * @param {string} dataDir — path to report-engine/data
 * @param {string} date — date string YYYY-MM-DD
 * @returns {object} full CI API response (identical structure to current mosaic_server.js)
 */
function buildCohortIntegrityStats(dataDir, date) {
  var ledgerFile = path.join(dataDir, 'simfolio', 'prediction_ledger_' + date + '.jsonl');
  var stats = _scanLedger(ledgerFile, { collectReasons: false });

  var result = {
    ok: true,
    date: date,
    hasManifest: false,
    manifest: null,
    canonicalCohortCount: stats.canonicalCohortCount,
    intradayCount: stats.intradayCount,
    quarantinedCount: stats.quarantinedCount,
    legacyNoTargetDate: stats.legacyNoTargetDate,
    legacyRecords: stats.legacyRecords,
    counts: {
      schemaValid: stats.schemaValid,
      predictionValid: stats.predictionValid,
      researchEligible: stats.researchEligible,
      executionCandidateEligible: stats.executionCandidateEligible,
      globalBlocked: stats.globalBlocked,
      executionEligible: stats.executionEligible,
      actualBought: 0,
      missingExpectedReturn: 0,
    },
    featureCoverage: {},
    ledgerTotal: stats.totalEntries,
  };

  // ── Manifest ──
  try {
    var pl = require('../prediction_ledger');
    var manifest = pl.readRunManifest(dataDir, date);
    if (manifest) {
      result.hasManifest = true;
      result.manifest = manifest;
    }
  } catch (_) {}

  // ── Decision events → actualBought ──
  var boughtPredIds = {};
  try {
    var deFile = path.join(dataDir, 'simfolio', 'decision_events_' + date + '.jsonl');
    if (fs.existsSync(deFile)) {
      var deLines = fs.readFileSync(deFile, 'utf8').trim().split('\n').filter(Boolean);
      for (var dei = 0; dei < deLines.length; dei++) {
        try {
          var deEntry = JSON.parse(deLines[dei]);
          if (deEntry.wasBought === true && deEntry.predictionId) {
            boughtPredIds[deEntry.predictionId] = true;
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

  // ── Second pass for CI-specific fields (actualBought, missingExpectedReturn, featureCoverage) ──
  if (fs.existsSync(ledgerFile)) {
    try {
      var ciLines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').filter(Boolean);
      for (var ci = 0; ci < ciLines.length; ci++) {
        try {
          var cie = JSON.parse(ciLines[ci]);

          // Quarantined
          if (cie.ingestionStatus === 'invalid_schema_v3492') continue;
          // Legacy
          if (!cie.targetDate || cie.targetDate === null) continue;

          // actualBought (from decision_events, not prediction ledger)
          if (cie.predictionId && boughtPredIds[cie.predictionId]) {
            result.counts.actualBought++;
          }
          // missingExpectedReturn
          if (cie.expectedReturn == null) {
            result.counts.missingExpectedReturn++;
          }
          // Feature coverage distribution
          var fc = cie.featureCoverage != null ? cie.featureCoverage.toFixed(2) : '?';
          result.featureCoverage[fc] = (result.featureCoverage[fc] || 0) + 1;
        } catch (_) {}
      }
    } catch (_) {}
  }

  // ── Note ──
  if (result.counts.researchEligible > 0 && (!result.hasManifest || (result.manifest && result.manifest.status !== 'completed'))) {
    result.note = '样本收集正常，但尚无预测有效性结论';
  } else if (result.counts.researchEligible > 0) {
    result.note = 'Canonical cohort collected, pending T+3 settlement';
  } else {
    result.note = '尚无合格研究样本';
  }

  return result;
}

// ══════ 3. buildCanonicalRunStats ══════

/**
 * Build triple-filtered stats for scheduler canonical acceptance.
 * Always filters by: canonical===true + runId match + scheduledSlot==='09:30'.
 *
 * @param {string} dataDir — path to report-engine/data
 * @param {string} date — date string YYYY-MM-DD
 * @param {string} runId — the scheduler-assigned runId
 * @returns {object} { canonicalCohortCount, researchEligible, executionEligible, ... }
 */
function buildCanonicalRunStats(dataDir, date, runId) {
  var ledgerFile = path.join(dataDir, 'simfolio', 'prediction_ledger_' + date + '.jsonl');
  return _scanLedger(ledgerFile, {
    filterRunId: runId,
    filterSlot: '09:30',
    collectReasons: true,
  });
}

// ══════ Module Exports ══════

module.exports = {
  buildPredictionSettlementStats: buildPredictionSettlementStats,
  buildCohortIntegrityStats: buildCohortIntegrityStats,
  buildCanonicalRunStats: buildCanonicalRunStats,
  // Exported for testing only
  _scanLedger: _scanLedger,
};
