/**
 * research_cohort.js — Pure Research Cohort Management Functions (v3.4.9.4)
 *
 * ZERO file I/O. ZERO side effects on require.
 * All functions accept explicit parameters — directly require()-able by tests.
 *
 * Functions:
 *   1. normalizeResearchFeatureSnapshot(candidate) → snapshot object
 *   2. computeResearchEligibility(snapshot, entry) → { eligible, reasons[] }  [PURE — no mutation]
 *   3. computeAllEligibility(...) → { schemaValid, predictionValid, researchEligible,
 *        executionCandidateEligible, globalTradePermission, executionEligible, reasons: {...} }
 *   4. buildResearchSnapshot(pipelineResults) → top 50, deduped by code
 *   5. hashCandidateSet(candidates) → deterministic hex string
 *   6. _hashNormalizedSnapshot(snapshot) → deterministic hash string
 */

// ══════ 1. normalizeResearchFeatureSnapshot ══════
// Moved from simfolio.js:723-773. Logic unchanged.
// Priority: rawScores > dimensions > flatScore fields.

function normalizeResearchFeatureSnapshot(candidate) {
  var snapshot = { schemaVersion: '1.0.0' };
  snapshot.dimensions = {
    fundamental: null,
    technical: null,
    hidden: null,
    capitalFlow: null,
    event: null
  };

  if (!candidate) return snapshot;

  // Tier 1: rawScores (most complete, from factor engine)
  if (candidate.rawScores && typeof candidate.rawScores === 'object') {
    var rk = Object.keys(candidate.rawScores);
    for (var ri = 0; ri < rk.length; ri++) {
      var rv = candidate.rawScores[rk[ri]];
      snapshot.dimensions[rk[ri]] = (rv != null && !isNaN(Number(rv))) ? Number(rv) : null;
    }
  }

  // Tier 2: dimensions object (from composite scoring)
  if (candidate.dimensions && typeof candidate.dimensions === 'object') {
    var dk = Object.keys(candidate.dimensions);
    for (var di = 0; di < dk.length; di++) {
      if (snapshot.dimensions[dk[di]] == null) {
        var dv = candidate.dimensions[dk[di]];
        snapshot.dimensions[dk[di]] = (dv != null && !isNaN(Number(dv))) ? Number(dv) : null;
      }
    }
  }

  // Tier 3: Flat score fields (fallback)
  var FLAT_FIELDS = ['fundamentalScore', 'technicalScore', 'hiddenScore', 'capitalFlowScore', 'eventScore'];
  var DIM_NAMES = ['fundamental', 'technical', 'hidden', 'capitalFlow', 'event'];
  for (var fi = 0; fi < FLAT_FIELDS.length; fi++) {
    if (snapshot.dimensions[DIM_NAMES[fi]] == null && candidate[FLAT_FIELDS[fi]] != null && !isNaN(Number(candidate[FLAT_FIELDS[fi]]))) {
      snapshot.dimensions[DIM_NAMES[fi]] = Number(candidate[FLAT_FIELDS[fi]]);
    }
  }

  // Metadata
  snapshot.compositeScore = (candidate.compositeScore != null && !isNaN(Number(candidate.compositeScore))) ? Number(candidate.compositeScore) : null;
  snapshot.price = (candidate.price != null && !isNaN(Number(candidate.price))) ? Number(candidate.price) : null;
  snapshot.expectedReturn = (candidate.prediction && candidate.prediction.expectedReturn != null && !isNaN(Number(candidate.prediction.expectedReturn)))
    ? Number(candidate.prediction.expectedReturn) : null;
  snapshot.confidence = (candidate.prediction && candidate.prediction.confidence != null && !isNaN(Number(candidate.prediction.confidence)))
    ? Number(candidate.prediction.confidence) : null;

  return snapshot;
}

// ══════ 2. computeResearchEligibility (PURE — returns result, does NOT mutate entry) ══════
// Rewritten from simfolio.js:794-841.
// Now returns { eligible, reasons[] } — caller assigns to entry.

function computeResearchEligibility(snapshot, entry) {
  var reasons = [];
  var eligible = true;

  if (entry.price == null || isNaN(Number(entry.price)) || Number(entry.price) <= 0) {
    reasons.push('missing_price');
    eligible = false;
  }
  if (!entry.predictionId) {
    reasons.push('missing_prediction_id');
    eligible = false;
  }
  if (!entry.targetDate) {
    reasons.push('missing_target_date');
    eligible = false;
  }
  // v3.4.9.4: Check modelVersionId (from model_registry), fall back to modelVersion
  var modelId = entry.modelVersionId || entry.modelVersion;
  if (!modelId || modelId === 'unknown') {
    reasons.push('missing_model_version');
    eligible = false;
  }

  // Feature snapshot completeness check
  if (!snapshot || !snapshot.dimensions || typeof snapshot.dimensions !== 'object') {
    reasons.push('missing_feature_snapshot');
    eligible = false;
  } else {
    var hasAnyDimension = false;
    var dimKeys = Object.keys(snapshot.dimensions);
    for (var d = 0; d < dimKeys.length; d++) {
      var dv = snapshot.dimensions[dimKeys[d]];
      if (dv != null) {
        hasAnyDimension = true;
        if (typeof dv !== 'number' || isNaN(dv)) {
          reasons.push('invalid_feature_value:' + dimKeys[d]);
          eligible = false;
        }
      }
    }
    if (!hasAnyDimension) {
      reasons.push('missing_feature_snapshot');
      eligible = false;
    }
  }

  return {
    eligible: eligible,
    reasons: reasons.length > 0 ? reasons : ['all_checks_passed'],
  };
}

// ══════ 3. computeAllEligibility — 6-field eligibility ══════

/**
 * Compute all 6 eligibility flags for a prediction candidate.
 *
 * @param {Object} candidate — pipeline result object
 * @param {Object} snapshot — normalized feature snapshot (from normalizeResearchFeatureSnapshot)
 * @param {string} kernelVerdict — kernel's finalVerdict: 'ALLOW'|'CAUTIOUS'|'REDUCE'|'BLOCK'
 * @param {boolean} meetsThreshold — does candidate meet evidence/strategy thresholds for buying?
 * @param {Object} entry — partially-built ledger entry (needs price + targetDate + modelVersionId)
 * @returns {Object} { schemaValid, predictionValid, researchEligible, executionCandidateEligible,
 *                     globalTradePermission, executionEligible, reasons: {schema:[],prediction:[],execution:[]} }
 */
function computeAllEligibility(candidate, snapshot, kernelVerdict, meetsThreshold, entry) {
  var schemaReasons = [];
  var predictionReasons = [];
  var schemaValid = true;
  var predictionValid = true;

  // ── Schema validity ──
  // 1. Price > 0
  if (entry.price == null || isNaN(Number(entry.price)) || Number(entry.price) <= 0) {
    schemaReasons.push('missing_price');
    schemaValid = false;
  }
  // 2. Target date present
  if (!entry.targetDate) {
    schemaReasons.push('missing_target_date');
    schemaValid = false;
  }
  // 3. Model version identity valid
  var modelId = entry.modelVersionId || entry.modelVersion;
  if (!modelId || modelId === 'unknown') {
    schemaReasons.push('missing_model_version');
    schemaValid = false;
  }
  // 4. Feature snapshot format valid (has ≥1 non-null dimension)
  if (!snapshot || !snapshot.dimensions || typeof snapshot.dimensions !== 'object') {
    schemaReasons.push('missing_feature_snapshot');
    schemaValid = false;
  } else {
    var hasAnyDimension = false;
    var dimKeys = Object.keys(snapshot.dimensions);
    for (var d = 0; d < dimKeys.length; d++) {
      var dv = snapshot.dimensions[dimKeys[d]];
      if (dv != null) {
        hasAnyDimension = true;
        if (typeof dv !== 'number' || isNaN(dv)) {
          schemaReasons.push('invalid_feature_value:' + dimKeys[d]);
          schemaValid = false;
        }
      }
    }
    if (!hasAnyDimension) {
      schemaReasons.push('missing_feature_snapshot');
      schemaValid = false;
    }
  }

  // ── Prediction validity ──
  // 1. Expected return present and numeric
  if (candidate.prediction == null || candidate.prediction.expectedReturn == null || isNaN(Number(candidate.prediction.expectedReturn))) {
    predictionReasons.push('missing_expected_return');
    predictionValid = false;
  }
  // 2. Confidence present and in valid range
  if (candidate.prediction == null || candidate.prediction.confidence == null || isNaN(Number(candidate.prediction.confidence))
      || Number(candidate.prediction.confidence) < 0 || Number(candidate.prediction.confidence) > 1) {
    predictionReasons.push('invalid_confidence');
    predictionValid = false;
  }
  // 3. At least 1 valid model input dimension
  if (snapshot && snapshot.dimensions) {
    var validDimCount = 0;
    for (var k in snapshot.dimensions) {
      if (snapshot.dimensions.hasOwnProperty(k) && snapshot.dimensions[k] != null && typeof snapshot.dimensions[k] === 'number' && !isNaN(snapshot.dimensions[k])) {
        validDimCount++;
      }
    }
    if (validDimCount === 0) {
      predictionReasons.push('no_valid_input_dimensions');
      predictionValid = false;
    }
  }

  // ── Composite flags ──
  var researchEligible = schemaValid && predictionValid;
  var executionCandidateEligible = researchEligible && (meetsThreshold !== false);
  var globalTradePermission = (kernelVerdict === 'ALLOW' || kernelVerdict === 'CAUTIOUS');
  var executionEligible = executionCandidateEligible && globalTradePermission;

  return {
    schemaValid: schemaValid,
    predictionValid: predictionValid,
    researchEligible: researchEligible,
    executionCandidateEligible: executionCandidateEligible,
    globalTradePermission: globalTradePermission,
    executionEligible: executionEligible,
    reasons: {
      schema: schemaReasons.length > 0 ? schemaReasons : ['all_checks_passed'],
      prediction: predictionReasons.length > 0 ? predictionReasons : ['all_checks_passed'],
      execution: !researchEligible ? ['research_ineligible'] : (!meetsThreshold ? ['threshold_not_met'] : (!globalTradePermission ? ['global_trade_blocked'] : ['eligible'])),
    },
  };
}

// ══════ 4. buildResearchSnapshot — dedup by code, sort, top 50 ══════

/**
 * Build a canonical research snapshot from pipeline results.
 * 1. Dedup by code — keep the entry with the highest expectedReturn.
 * 2. Sort: expectedReturn DESC → compositeScore DESC → code ASC (stable ordering).
 * 3. Return top 50.
 *
 * @param {Array} pipelineResults — raw pipeline results array
 * @returns {Array} top 50 candidates, deduped and sorted
 */
function buildResearchSnapshot(pipelineResults) {
  if (!pipelineResults || !Array.isArray(pipelineResults) || pipelineResults.length === 0) return [];

  // Dedup by code — keep highest expectedReturn for each code
  var byCode = {};
  for (var i = 0; i < pipelineResults.length; i++) {
    var c = pipelineResults[i];
    if (!c || !c.code) continue;
    var er = (c.prediction && c.prediction.expectedReturn != null && !isNaN(Number(c.prediction.expectedReturn)))
      ? Number(c.prediction.expectedReturn)
      : -999;
    if (!byCode[c.code] || er > byCode[c.code]._er) {
      byCode[c.code] = c;
      byCode[c.code]._er = er;
    }
  }

  // Convert to array and sort
  var deduped = [];
  var codes = Object.keys(byCode);
  for (var j = 0; j < codes.length; j++) {
    deduped.push(byCode[codes[j]]);
  }

  deduped.sort(function(a, b) {
    var erA = (a._er != null) ? a._er : -999;
    var erB = (b._er != null) ? b._er : -999;
    if (erB !== erA) return erB - erA; // expectedReturn DESC
    var csA = (a.compositeScore != null && !isNaN(Number(a.compositeScore))) ? Number(a.compositeScore) : 0;
    var csB = (b.compositeScore != null && !isNaN(Number(b.compositeScore))) ? Number(b.compositeScore) : 0;
    if (csB !== csA) return csB - csA; // compositeScore DESC
    return (a.code || '').localeCompare(b.code || ''); // code ASC (stable)
  });

  // Clean up _er temporary field and return top 50
  var top50 = deduped.slice(0, 50);
  for (var k = 0; k < top50.length; k++) {
    delete top50[k]._er;
  }
  return top50;
}

// ══════ 5. hashCandidateSet — deterministic hash for input drift detection ══════

/**
 * Compute deterministic hash of a candidate set.
 * Uses DJB2 hash over sorted code+compositeScore pairs.
 * Same set of candidates → same hash. Different set → different hash (high probability).
 *
 * @param {Array} candidates — array of { code, compositeScore }
 * @returns {string} hex hash
 */
function hashCandidateSet(candidates) {
  if (!candidates || !Array.isArray(candidates) || candidates.length === 0) return 'empty';
  var parts = [];
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    var cs = (c.compositeScore != null && !isNaN(Number(c.compositeScore))) ? Number(c.compositeScore).toFixed(2) : '0.00';
    parts.push((c.code || '?') + ':' + cs);
  }
  parts.sort();
  var str = parts.join('|');
  var h = 0;
  for (var j = 0; j < str.length; j++) { h = ((h << 5) - h) + str.charCodeAt(j); h |= 0; }
  return (h >>> 0).toString(16);
}

// ══════ 6. _hashNormalizedSnapshot ══════
// Moved from simfolio.js:779-787. Logic unchanged.

function _hashNormalizedSnapshot(snapshot) {
  try {
    if (!snapshot || !snapshot.dimensions) return null;
    var str = JSON.stringify(snapshot.dimensions) + '|' + (snapshot.compositeScore != null ? snapshot.compositeScore.toFixed(3) : 'null');
    var h = 0;
    for (var i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
    return String(h);
  } catch (_) { return null; }
}

// ══════ Module Exports ══════

module.exports = {
  normalizeResearchFeatureSnapshot: normalizeResearchFeatureSnapshot,
  computeResearchEligibility: computeResearchEligibility,
  computeAllEligibility: computeAllEligibility,
  buildResearchSnapshot: buildResearchSnapshot,
  hashCandidateSet: hashCandidateSet,
  _hashNormalizedSnapshot: _hashNormalizedSnapshot,
};
