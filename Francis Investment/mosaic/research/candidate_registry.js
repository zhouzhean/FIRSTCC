/**
 * P1: Candidate Registry — Alpha Research Factory Model Lifecycle
 *
 * Manages all experimental models through a locked 3-state lifecycle:
 *   RESEARCH_ONLY      — under evaluation, no trading permission
 *   SHADOW_CANDIDATE   — passed research gates, tracking live with shadow predictions
 *   REJECTED_RESEARCH  — formal rejection with evidence, artifacts preserved
 *
 * NO automatic threshold changes, weight adjustments, or buy qualification.
 * Models move between states ONLY through explicit, evidence-backed transitions.
 *
 * Pre-locked hypotheses (3 technical alpha hypotheses):
 *   H1 — Momentum + Volatility: technical score weighted by inverse volatility
 *   H2 — Derived Hidden-Signal Bundle: H1-H9 composite, no price features
 *   H3 — Signal-Volume Interaction: signalCount × compositeScore interaction term
 *
 * Unified pipeline rules:
 *   — All candidates share identical PIT data, trade simulator, costs, random control, benchmark
 *   — First 4 OOS windows = research exploration
 *   — Last 2 OOS windows = lock confirmation (no re-fitting permitted after lock)
 *   — Window N model artifacts frozen at train time; lock windows re-use the SAME model
 *
 * Data: report-engine/data/research/candidate_registry.json
 */

var fs, path;
try { fs = require('fs'); path = require('path'); } catch (_) {}

var REGISTRY_FILE = null;
var DATA_DIR = null;

var _state = {
  candidates: [],           // [{ hypothesisId, versionId, hypothesis, status, ... }]
  hypotheses: [],           // [{ id, name, description, features, lockedAt }]
  evaluationWindows: [],    // [{ index, role:'research'|'lock', start, end }]
  transitions: [],          // [{ from, to, hypothesisId, reason, date, evidence }]
  lastEvaluationDate: null,
};

// ── Pre-locked hypotheses ──

var PRELOCKED_HYPOTHESES = [
  {
    id: 'H1',
    name: 'Momentum + Volatility',
    description: 'Technical composite score weighted by inverse 20-day volatility. ' +
      'Higher weight to low-volatility technical signals — reward steady trends, ' +
      'penalize erratic price action.',
    features: ['technical', 'volatility20d'],
    interaction: 'technical / (1 + volatility20d)',
    lockedAt: '2026-06-24',
    rationale: 'Classic low-vol anomaly adapted to A-share: stable trending stocks ' +
      'outperform high-vol names on a risk-adjusted basis over T+3 horizon.',
  },
  {
    id: 'H2',
    name: 'Derived Hidden-Signal Bundle',
    description: 'Hidden signal composite (H1-H9) as sole input. No price features, ' +
      'no volatility, no volume. Derives statistical features from the hidden-signal ' +
      'bundle — NOT non-price or alternative data.',
    features: ['hidden'],
    interaction: null,
    lockedAt: '2026-06-24',
    rationale: 'If hidden signals carry genuine alpha uncorrelated with price, ' +
      'a pure hidden-signal model should show positive Rank IC independent of ' +
      'technical factors. Failure = hidden signals are just transformed price data.',
  },
  {
    id: 'H3',
    name: 'Signal-Volume Interaction',
    description: 'Interaction term: signalCount × compositeScore. Tests whether ' +
      'the confluence of multiple signals (high signalCount) amplifies or dampens ' +
      'the composite score\'s predictive power.',
    features: ['signalCount', 'compositeScore'],
    interaction: 'signalCount * compositeScore',
    lockedAt: '2026-06-24',
    rationale: 'When many signals agree (high signalCount), the composite score ' +
      'should be more reliable. The interaction term captures this amplification ' +
      'effect. Weak interaction = signal diversity doesn\'t improve reliability.',
  },
];

// ── Initialization ──

/**
 * P1.2: Injectable registry factory — creates a fully independent instance.
 * Does NOT mutate module-global DATA_DIR/_state — returns a clean exports object.
 *
 * @param {object} options
 * @param {string} options.dataDir — override DATA_DIR (default: config.DATA_DIR)
 * @returns {object} REGISTRY — fresh API object with its own state
 */
function createRegistry(options) {
  var opts = options || {};

  // P1.2: Independent state — no mutation of module-global _state/DATA_DIR
  var registryState = {
    candidates: [],
    hypotheses: [],
    evaluationWindows: [],
    transitions: [],
    lastEvaluationDate: null,
  };

  var _registryFile = null;
  var _dataDir = null;

  try {
    if (opts.dataDir) {
      _dataDir = opts.dataDir;
      _registryFile = path.join(_dataDir, 'research', 'candidate_registry.json');
      if (!fs.existsSync(path.join(_dataDir, 'research'))) {
        fs.mkdirSync(path.join(_dataDir, 'research'), { recursive: true });
      }
    } else {
      var config = require('../config');
      _dataDir = config.DATA_DIR || path.join(__dirname, '..', '..', 'report-engine', 'data');
      _registryFile = path.join(_dataDir, 'research', 'candidate_registry.json');
    }

    if (fs.existsSync(_registryFile)) {
      var saved = JSON.parse(fs.readFileSync(_registryFile, 'utf8'));
      if (saved.candidates) registryState.candidates = saved.candidates;
      if (saved.hypotheses) registryState.hypotheses = saved.hypotheses;
      if (saved.evaluationWindows) registryState.evaluationWindows = saved.evaluationWindows;
      if (saved.transitions) registryState.transitions = saved.transitions;
      if (saved.lastEvaluationDate) registryState.lastEvaluationDate = saved.lastEvaluationDate;
    }

    // Ensure pre-locked hypotheses are always present
    var existingIds = {};
    for (var i = 0; i < registryState.hypotheses.length; i++) {
      existingIds[registryState.hypotheses[i].id] = true;
    }
    for (var j = 0; j < PRELOCKED_HYPOTHESES.length; j++) {
      if (!existingIds[PRELOCKED_HYPOTHESES[j].id]) {
        registryState.hypotheses.push(PRELOCKED_HYPOTHESES[j]);
      }
    }
  } catch (_) {}

  function _persistLocal() {
    if (!_registryFile || !fs) return;
    try {
      var dir = path.dirname(_registryFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(_registryFile, JSON.stringify({
        candidates: registryState.candidates,
        hypotheses: registryState.hypotheses,
        evaluationWindows: registryState.evaluationWindows,
        transitions: registryState.transitions.slice(-100),
        lastEvaluationDate: registryState.lastEvaluationDate,
        updatedAt: new Date().toISOString(),
      }, null, 2), 'utf8');
    } catch (_) {}
  }

  // ── Build independent API ──

  var REGISTRY = {
    getHypotheses: function () {
      return registryState.hypotheses.slice();
    },
    getHypothesis: function (id) {
      for (var i = 0; i < registryState.hypotheses.length; i++) {
        if (registryState.hypotheses[i].id === id) return registryState.hypotheses[i];
      }
      return null;
    },
    PRELOCKED_HYPOTHESES: PRELOCKED_HYPOTHESES,

    registerCandidate: function (spec) {
      var hypothesis = REGISTRY.getHypothesis(spec.hypothesisId);
      if (!hypothesis) return { error: 'unknown_hypothesis', hypothesisId: spec.hypothesisId };

      var versionId = spec.versionId || ('candidate_' + spec.hypothesisId + '_' + Date.now());

      var entry = {
        versionId: versionId,
        hypothesisId: spec.hypothesisId,
        hypothesis: hypothesis.name,
        status: 'RESEARCH_ONLY',
        registeredAt: new Date().toISOString(),
        model: spec.model || {},
        metrics: spec.metrics || {},
        window: spec.window || {},
        artifactsPath: spec.artifactsPath || null,
        strategyHash: spec.strategyHash || null,
        featureSchemaHash: spec.featureSchemaHash || null,
        snapshotHash: spec.snapshotHash || null,
        windowPlanHash: spec.windowPlanHash || null,
        executionHash: spec.executionHash || null,
        evaluatedWindows: [],
        lastEvaluated: null,
        evaluationNotes: null,
        shadowSince: null,
        forwardSamples: 0,
        rejectedAt: null,
        rejectionEvidence: null,
      };

      registryState.candidates.push(entry);
      _persistLocal();

      console.log('[CandidateRegistry] Registered ' + versionId +
        ' (hypothesis=' + spec.hypothesisId + ', status=RESEARCH_ONLY' +
        (spec.strategyHash ? ', strategyHash=' + spec.strategyHash.slice(0, 12) + '...' : '') + ')');

      return { versionId: versionId, status: 'RESEARCH_ONLY' };
    },

    promoteToShadowCandidate: function (versionId) {
      var candidate = null;
      for (var i = 0; i < registryState.candidates.length; i++) {
        if (registryState.candidates[i].versionId === versionId) { candidate = registryState.candidates[i]; break; }
      }
      if (!candidate) return { error: 'not_found', versionId: versionId };
      if (candidate.status === 'REJECTED_RESEARCH') {
        return { error: 'rejected_permanent', versionId: versionId, reason: 'REJECTED_RESEARCH models cannot be promoted' };
      }
      if (candidate.status === 'SHADOW_CANDIDATE') {
        return { promoted: true, versionId: versionId, reason: 'already_shadow_candidate' };
      }

      var researchWindows = REGISTRY.getResearchWindowIndices();
      var evaluatedSet = {};
      for (var wi = 0; wi < (candidate.evaluatedWindows || []).length; wi++) {
        evaluatedSet[candidate.evaluatedWindows[wi]] = true;
      }
      var missingWindows = [];
      for (var rw = 0; rw < researchWindows.length; rw++) {
        if (!evaluatedSet[researchWindows[rw]]) missingWindows.push(researchWindows[rw]);
      }
      if (missingWindows.length > 0) {
        return { promoted: false, versionId: versionId,
          reason: 'missing research windows: ' + JSON.stringify(missingWindows) };
      }

      var evals = candidate.evaluationResults || [];
      if (evals.length < researchWindows.length) {
        return { promoted: false, versionId: versionId,
          reason: 'insufficient evaluation results: ' + evals.length + '/' + researchWindows.length };
      }

      var researchEvals = evals.filter(function (e) { return researchWindows.indexOf(e.windowIndex) >= 0; });
      var avgIC = researchEvals.reduce(function (s, e) { return s + (e.rankIC || 0); }, 0) / researchEvals.length;
      if (avgIC <= 0) {
        return { promoted: false, versionId: versionId, reason: 'avg Rank IC <= 0 (' + avgIC.toFixed(4) + ')' };
      }

      var positiveReturnWindows = researchEvals.filter(function (e) { return (e.netReturn || 0) > 0; }).length;
      if (positiveReturnWindows < 2) {
        return { promoted: false, versionId: versionId,
          reason: 'netReturn > 0 in only ' + positiveReturnWindows + '/4 research windows (need ≥2)' };
      }

      var allDeltaCI = researchEvals.map(function (e) { return e.deltaCI || [0, 0]; });
      var allCINegative = allDeltaCI.every(function (ci) { return ci[1] < 0; });
      if (allCINegative) {
        return { promoted: false, versionId: versionId,
          reason: 'paired delta CI fully negative across all research windows' };
      }

      candidate.status = 'SHADOW_CANDIDATE';
      candidate.shadowSince = new Date().toISOString();
      registryState.transitions.push({
        from: 'RESEARCH_ONLY', to: 'SHADOW_CANDIDATE', hypothesisId: candidate.hypothesisId,
        versionId: versionId, reason: 'research gates passed: avgIC=' + avgIC.toFixed(4) +
          ', positiveWindows=' + positiveReturnWindows + '/4', date: new Date().toISOString().slice(0, 10),
        evidence: { avgRankIC: avgIC, positiveReturnWindows: positiveReturnWindows, allDeltaCI: allDeltaCI },
      });
      _persistLocal();
      console.log('[CandidateRegistry] PROMOTED: ' + versionId + ' → SHADOW_CANDIDATE (avgIC=' + avgIC.toFixed(4) + ')');
      return { promoted: true, versionId: versionId, status: 'SHADOW_CANDIDATE', avgRankIC: avgIC, positiveReturnWindows: positiveReturnWindows };
    },

    rejectCandidate: function (versionId, evidence) {
      var candidate = null;
      for (var i = 0; i < registryState.candidates.length; i++) {
        if (registryState.candidates[i].versionId === versionId) { candidate = registryState.candidates[i]; break; }
      }
      if (!candidate) return { error: 'not_found', versionId: versionId };
      if (candidate.status === 'REJECTED_RESEARCH') {
        return { rejected: true, versionId: versionId, status: 'REJECTED_RESEARCH', alreadyRejected: true };
      }
      var previousStatus = candidate.status;
      candidate.status = 'REJECTED_RESEARCH';
      candidate.rejectedAt = new Date().toISOString();
      candidate.rejectionEvidence = evidence || {};
      try {
        var MODEL_REGISTRY = require('../evolution/model_registry');
        MODEL_REGISTRY.rejectModel(versionId, evidence);
      } catch (_) {}
      registryState.transitions.push({
        from: previousStatus, to: 'REJECTED_RESEARCH', hypothesisId: candidate.hypothesisId,
        versionId: versionId, reason: evidence ? evidence.reason : 'no_alpha',
        date: new Date().toISOString().slice(0, 10), evidence: evidence,
      });
      _persistLocal();
      console.log('[CandidateRegistry] REJECTED_RESEARCH: ' + versionId + ' — artifacts preserved.');
      return { rejected: true, versionId: versionId, status: 'REJECTED_RESEARCH' };
    },

    setEvaluationWindows: function (windows) {
      registryState.evaluationWindows = windows.map(function (w, i) {
        return {
          index: i, windowId: 'window_' + String(i + 1).padStart(3, '0'),
          role: i < 4 ? 'research' : 'lock',
          trainStart: w.trainStart, trainEnd: w.trainEnd,
          testStart: w.testStart, testEnd: w.testEnd,
        };
      });
      _persistLocal();
    },

    getResearchWindowIndices: function () {
      return registryState.evaluationWindows
        .filter(function (w) { return w.role === 'research'; })
        .map(function (w) { return w.index; });
    },

    getLockWindowIndices: function () {
      return registryState.evaluationWindows
        .filter(function (w) { return w.role === 'lock'; })
        .map(function (w) { return w.index; });
    },

    recordEvaluation: function (versionId, windowIndex, results) {
      var candidate = null;
      for (var i = 0; i < registryState.candidates.length; i++) {
        if (registryState.candidates[i].versionId === versionId) { candidate = registryState.candidates[i]; break; }
      }
      if (!candidate) return { error: 'not_found', versionId: versionId };
      if (candidate.status === 'REJECTED_RESEARCH') {
        return { error: 'rejected_permanent', versionId: versionId };
      }

      var windowRole = 'research';
      var windowId = null;
      for (var wi = 0; wi < registryState.evaluationWindows.length; wi++) {
        if (registryState.evaluationWindows[wi].index === windowIndex) {
          windowRole = registryState.evaluationWindows[wi].role;
          windowId = registryState.evaluationWindows[wi].windowId || null;
          break;
        }
      }

      if (windowRole === 'lock' && candidate.status === 'RESEARCH_ONLY') {
        return { error: 'lock_windows_require_shadow_candidate', versionId: versionId, currentStatus: candidate.status };
      }

      // P1.2: Idempotency check
      if (candidate.evaluationResults) {
        for (var ei = 0; ei < candidate.evaluationResults.length; ei++) {
          var er = candidate.evaluationResults[ei];
          if (er.windowIndex === windowIndex &&
              er.snapshotHash === (results.snapshotHash || candidate.snapshotHash || null) &&
              er.executionHash === (results.executionHash || candidate.executionHash || null)) {
            console.log('[CandidateRegistry] IDEMPOTENT: window ' + windowIndex + ' already recorded for ' + versionId);
            return { recorded: false, alreadyRecorded: true, versionId: versionId, windowIndex: windowIndex };
          }
        }
      }

      if (!candidate.evaluationResults) candidate.evaluationResults = [];
      candidate.evaluationResults.push({
        windowIndex: windowIndex, windowRole: windowRole,
        rankIC: results.rankIC, netReturn: results.netReturn, grossReturn: results.grossReturn,
        benchmarkReturn: results.benchmarkReturn, netExcessReturn: results.netExcessReturn,
        deltaCI: results.deltaCI || null, directionAccuracy: results.directionAccuracy,
        candidateVersionId: results.candidateVersionId || versionId,
        hypothesisId: results.hypothesisId || candidate.hypothesisId,
        strategyHash: results.strategyHash || candidate.strategyHash || null,
        featureSchemaHash: results.featureSchemaHash || candidate.featureSchemaHash || null,
        snapshotHash: results.snapshotHash || candidate.snapshotHash || null,
        windowPlanHash: results.windowPlanHash || candidate.windowPlanHash || null,
        executionHash: results.executionHash || candidate.executionHash || null,
        windowId: results.windowId || windowId || null,
        costAssumptions: results.costAssumptions || null,
        benchmarkStatus: results.benchmarkStatus || null,
        windowDates: results.windowDates || null,
        evaluatedAt: new Date().toISOString(),
      });

      if (!candidate.evaluatedWindows) candidate.evaluatedWindows = [];
      if (candidate.evaluatedWindows.indexOf(windowIndex) < 0) {
        candidate.evaluatedWindows.push(windowIndex);
      }

      candidate.lastEvaluated = new Date().toISOString();
      registryState.lastEvaluationDate = new Date().toISOString().slice(0, 10);
      _persistLocal();

      // Auto-promotion
      var researchWindows = REGISTRY.getResearchWindowIndices();
      var allResearchDone = researchWindows.every(function (rw) {
        return candidate.evaluatedWindows.indexOf(rw) >= 0;
      });

      if (allResearchDone && candidate.status === 'RESEARCH_ONLY') {
        REGISTRY.promoteToShadowCandidate(versionId);
      }

      return { recorded: true, versionId: versionId, windowIndex: windowIndex, windowRole: windowRole,
        status: candidate.status, allResearchDone: allResearchDone };
    },

    getCandidates: function (opts) {
      var filter = (opts || {}).status || null;
      var hypothesisId = (opts || {}).hypothesisId || null;
      var results = registryState.candidates.slice();
      if (filter) results = results.filter(function (c) { return c.status === filter; });
      if (hypothesisId) results = results.filter(function (c) { return c.hypothesisId === hypothesisId; });
      return results;
    },

    getStatus: function () {
      var activeCandidates = registryState.candidates.filter(function (c) { return c.status !== 'REJECTED_RESEARCH'; });
      var shadowCandidates = registryState.candidates.filter(function (c) { return c.status === 'SHADOW_CANDIDATE'; });
      var rejected = registryState.candidates.filter(function (c) { return c.status === 'REJECTED_RESEARCH'; });
      return {
        totalHypotheses: registryState.hypotheses.length,
        hypotheses: registryState.hypotheses.map(function (h) { return { id: h.id, name: h.name }; }),
        totalCandidates: registryState.candidates.length,
        activeCandidates: activeCandidates.length,
        researchOnly: activeCandidates.filter(function (c) { return c.status === 'RESEARCH_ONLY'; }).length,
        shadowCandidates: shadowCandidates.length,
        rejectedCount: rejected.length,
        evaluationWindows: {
          total: registryState.evaluationWindows.length,
          research: REGISTRY.getResearchWindowIndices().length,
          lock: REGISTRY.getLockWindowIndices().length,
          windows: registryState.evaluationWindows,
        },
        lastEvaluationDate: registryState.lastEvaluationDate,
        transitions: registryState.transitions.slice(-20),
      };
    },

    getFinalVerdict: function (versionId) {
      var candidate = null;
      for (var i = 0; i < registryState.candidates.length; i++) {
        if (registryState.candidates[i].versionId === versionId) { candidate = registryState.candidates[i]; break; }
      }
      if (!candidate) return { error: 'not_found', versionId: versionId };
      var lockWindows = REGISTRY.getLockWindowIndices();
      var evals = candidate.evaluationResults || [];
      var lockEvals = evals.filter(function (e) { return lockWindows.indexOf(e.windowIndex) >= 0; });
      var allWindows = REGISTRY.getResearchWindowIndices().concat(lockWindows);
      var allDone = allWindows.every(function (wi) {
        return (candidate.evaluatedWindows || []).indexOf(wi) >= 0;
      });
      if (!allDone) {
        return { versionId: versionId, status: candidate.status, complete: false,
          windowsCompleted: (candidate.evaluatedWindows || []).length, windowsTotal: allWindows.length };
      }
      var lockAvgIC = lockEvals.length > 0
        ? lockEvals.reduce(function (s, e) { return s + (e.rankIC || 0); }, 0) / lockEvals.length : null;
      var lockAvgNetReturn = lockEvals.length > 0
        ? lockEvals.reduce(function (s, e) { return s + (e.netReturn || 0); }, 0) / lockEvals.length : null;
      var lockPositiveWindows = lockEvals.filter(function (e) { return (e.netReturn || 0) > 0; }).length;
      var lockConfirmed = lockAvgIC != null && lockAvgIC > 0 && lockPositiveWindows >= 1;
      return {
        versionId: versionId, hypothesisId: candidate.hypothesisId, status: candidate.status, complete: true,
        lockConfirmation: { confirmed: lockConfirmed, lockAvgRankIC: lockAvgIC,
          lockAvgNetReturn: lockAvgNetReturn, lockPositiveWindows: lockPositiveWindows, lockTotalWindows: lockWindows.length },
        verdict: lockConfirmed ? 'LOCK_CONFIRMED' : 'LOCK_FAILED',
        recommendation: lockConfirmed ? 'Candidate may be considered for live shadow tracking' : 'Candidate should remain RESEARCH_ONLY',
      };
    },

    createRegistry: createRegistry,
  };

  // If this is a test instance, DON'T pollute module.exports with the test state
  // Only the returned REGISTRY object has the isolated state.
  // For production (no dataDir override), also set up module.exports delegates.
  if (!opts.dataDir) {
    // Production mode: set module-global vars AND wire delegates
    // (module.exports functions delegate to the global state)
    // We'll set up the module.exports below, after REGISTRY is defined
  }

  return REGISTRY;
}

// Default init (production mode — uses config.DATA_DIR)
createRegistry({});

function _ensureHypotheses() {
  var existingIds = {};
  for (var i = 0; i < _state.hypotheses.length; i++) {
    existingIds[_state.hypotheses[i].id] = true;
  }
  for (var j = 0; j < PRELOCKED_HYPOTHESES.length; j++) {
    if (!existingIds[PRELOCKED_HYPOTHESES[j].id]) {
      _state.hypotheses.push(PRELOCKED_HYPOTHESES[j]);
    }
  }
}

function _persist() {
  if (!REGISTRY_FILE || !fs) return;
  try {
    var dir = path.dirname(REGISTRY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify({
      candidates: _state.candidates,
      hypotheses: _state.hypotheses,
      evaluationWindows: _state.evaluationWindows,
      transitions: _state.transitions.slice(-100),
      lastEvaluationDate: _state.lastEvaluationDate,
      updatedAt: new Date().toISOString(),
    }, null, 2), 'utf8');
  } catch (_) {}
}

// ── Hypothesis management ──

/**
 * Get all pre-locked (and any user-added) hypotheses.
 * Pre-locked hypotheses are immutable (features, interaction, rationale).
 */
function getHypotheses() {
  return _state.hypotheses.slice();
}

/**
 * Get a specific hypothesis by ID.
 */
function getHypothesis(id) {
  for (var i = 0; i < _state.hypotheses.length; i++) {
    if (_state.hypotheses[i].id === id) return _state.hypotheses[i];
  }
  return null;
}

// ── Candidate lifecycle ──

/**
 * Register a new candidate model for a hypothesis.
 *
 * A hypothesis can have multiple versions (different train windows, hyperparameters).
 * Each version is tracked independently.
 *
 * @param {object} spec
 * @param {string} spec.hypothesisId — H1, H2, or H3
 * @param {object} spec.model — { intercept, weights, featureNames, lambda, ... }
 * @param {object} spec.metrics — { avgRankIC, directionAccuracy, netReturn, ... }
 * @param {object} spec.window — { trainStart, trainEnd, testStart, testEnd }
 * @param {string} spec.artifactsPath — path to window artifacts
 * @param {string} spec.strategyHash — deterministic hash of hypothesis definition + features + interaction
 * @param {string} spec.featureSchemaHash — deterministic hash of feature → source mapping
 * @param {string} spec.snapshotHash — deterministic hash of input snapshot data
 * @param {string} spec.windowPlanHash — deterministic hash of window definitions
 * @param {string} spec.executionHash — deterministic hash of cost/topN/sleeves execution config
 * @param {string} spec.versionId — optional override (used by findOrCreateCandidate)
 * @returns {object} { versionId, status }
 */
function registerCandidate(spec) {
  var hypothesis = getHypothesis(spec.hypothesisId);
  if (!hypothesis) return { error: 'unknown_hypothesis', hypothesisId: spec.hypothesisId };

  // P1.1: Support stable hash-based versionId (from findOrCreateCandidate)
  var versionId = spec.versionId || ('candidate_' + spec.hypothesisId + '_' + Date.now());

  var entry = {
    versionId: versionId,
    hypothesisId: spec.hypothesisId,
    hypothesis: hypothesis.name,
    status: 'RESEARCH_ONLY',       // RESEARCH_ONLY | SHADOW_CANDIDATE | REJECTED_RESEARCH
    registeredAt: new Date().toISOString(),
    model: spec.model || {},
    metrics: spec.metrics || {},
    window: spec.window || {},
    artifactsPath: spec.artifactsPath || null,
    // P1.1: Immutable hashes for reproducibility and cross-referencing
    strategyHash: spec.strategyHash || null,
    featureSchemaHash: spec.featureSchemaHash || null,
    snapshotHash: spec.snapshotHash || null,
    windowPlanHash: spec.windowPlanHash || null,
    executionHash: spec.executionHash || null,
    // Track which windows have been evaluated
    evaluatedWindows: [],
    // Last evaluation
    lastEvaluated: null,
    evaluationNotes: null,
    // Shadow tracking (only for SHADOW_CANDIDATE)
    shadowSince: null,
    forwardSamples: 0,
    // Rejection (only for REJECTED_RESEARCH)
    rejectedAt: null,
    rejectionEvidence: null,
  };

  _state.candidates.push(entry);
  _persist();

  console.log('[CandidateRegistry] Registered ' + versionId +
    ' (hypothesis=' + spec.hypothesisId + ', status=RESEARCH_ONLY' +
    (spec.strategyHash ? ', strategyHash=' + spec.strategyHash.slice(0, 12) + '...' : '') + ')');

  return { versionId: versionId, status: 'RESEARCH_ONLY' };
}

/**
 * Transition a RESEARCH_ONLY candidate to SHADOW_CANDIDATE (promotion).
 *
 * Gates (all must pass):
 *   1. All first 4 research windows evaluated
 *   2. Average Rank IC > 0 across research windows
 *   3. Net return > 0 in at least 2 of 4 research windows
 *   4. Paired delta CI vs random is NOT fully negative
 *
 * @param {string} versionId
 * @returns {object} { promoted, reason }
 */
function promoteToShadowCandidate(versionId) {
  var candidate = null;
  for (var i = 0; i < _state.candidates.length; i++) {
    if (_state.candidates[i].versionId === versionId) {
      candidate = _state.candidates[i];
      break;
    }
  }
  if (!candidate) return { error: 'not_found', versionId: versionId };
  if (candidate.status === 'REJECTED_RESEARCH') {
    return { error: 'rejected_permanent', versionId: versionId,
      reason: 'REJECTED_RESEARCH models cannot be promoted' };
  }
  if (candidate.status === 'SHADOW_CANDIDATE') {
    return { promoted: true, versionId: versionId, reason: 'already_shadow_candidate' };
  }

  // Gate 1: All research windows evaluated (first 4 of 6)
  var researchWindows = getResearchWindowIndices();
  var evaluatedSet = {};
  for (var wi = 0; wi < (candidate.evaluatedWindows || []).length; wi++) {
    evaluatedSet[candidate.evaluatedWindows[wi]] = true;
  }
  var missingWindows = [];
  for (var rw = 0; rw < researchWindows.length; rw++) {
    if (!evaluatedSet[researchWindows[rw]]) missingWindows.push(researchWindows[rw]);
  }
  if (missingWindows.length > 0) {
    return { promoted: false, versionId: versionId,
      reason: 'missing research windows: ' + JSON.stringify(missingWindows) +
        ' (need all of ' + JSON.stringify(researchWindows) + ')' };
  }

  // Gates 2-4 require evaluation data
  var evals = candidate.evaluationResults || [];
  if (evals.length < researchWindows.length) {
    return { promoted: false, versionId: versionId,
      reason: 'insufficient evaluation results: ' + evals.length + '/' + researchWindows.length };
  }

  // Gate 2: Avg Rank IC > 0
  var researchEvals = evals.filter(function (e) {
    return researchWindows.indexOf(e.windowIndex) >= 0;
  });
  var avgIC = researchEvals.reduce(function (s, e) { return s + (e.rankIC || 0); }, 0) / researchEvals.length;
  if (avgIC <= 0) {
    return { promoted: false, versionId: versionId,
      reason: 'avg Rank IC <= 0 (' + avgIC.toFixed(4) + ') across research windows' };
  }

  // Gate 3: Net return > 0 in at least 2 of 4 research windows
  var positiveReturnWindows = researchEvals.filter(function (e) {
    return (e.netReturn || 0) > 0;
  }).length;
  if (positiveReturnWindows < 2) {
    return { promoted: false, versionId: versionId,
      reason: 'netReturn > 0 in only ' + positiveReturnWindows + '/4 research windows (need ≥2)' };
  }

  // Gate 4: Paired delta CI not fully negative
  var allDeltaCI = researchEvals.map(function (e) { return e.deltaCI || [0, 0]; });
  var allCINegative = allDeltaCI.every(function (ci) { return ci[1] < 0; });
  if (allCINegative) {
    return { promoted: false, versionId: versionId,
      reason: 'paired delta CI fully negative across all research windows' };
  }

  // All gates passed — promote
  candidate.status = 'SHADOW_CANDIDATE';
  candidate.shadowSince = new Date().toISOString();

  _state.transitions.push({
    from: 'RESEARCH_ONLY',
    to: 'SHADOW_CANDIDATE',
    hypothesisId: candidate.hypothesisId,
    versionId: versionId,
    reason: 'research gates passed: avgIC=' + avgIC.toFixed(4) +
      ', positiveWindows=' + positiveReturnWindows + '/4',
    date: new Date().toISOString().slice(0, 10),
    evidence: {
      avgRankIC: avgIC,
      positiveReturnWindows: positiveReturnWindows,
      allDeltaCI: allDeltaCI,
    },
  });

  _persist();
  console.log('[CandidateRegistry] PROMOTED: ' + versionId +
    ' → SHADOW_CANDIDATE (avgIC=' + avgIC.toFixed(4) +
    ', positiveWindows=' + positiveReturnWindows + ')');

  return {
    promoted: true,
    versionId: versionId,
    status: 'SHADOW_CANDIDATE',
    avgRankIC: avgIC,
    positiveReturnWindows: positiveReturnWindows,
  };
}

/**
 * Formally reject a candidate with research evidence.
 * Idempotent — repeating the call on an already-rejected candidate is a no-op.
 *
 * @param {string} versionId
 * @param {object} evidence — { reason, windowsChecked, avgRankIC, allRankICs, pairedDeltaCI }
 * @returns {object} { rejected, versionId, status }
 */
function rejectCandidate(versionId, evidence) {
  var candidate = null;
  for (var i = 0; i < _state.candidates.length; i++) {
    if (_state.candidates[i].versionId === versionId) {
      candidate = _state.candidates[i];
      break;
    }
  }
  if (!candidate) return { error: 'not_found', versionId: versionId };

  // Idempotency
  if (candidate.status === 'REJECTED_RESEARCH') {
    console.log('[CandidateRegistry] IDEMPOTENT: ' + versionId + ' already REJECTED_RESEARCH');
    return { rejected: true, versionId: versionId, status: 'REJECTED_RESEARCH',
      alreadyRejected: true };
  }

  // Save previousStatus BEFORE mutation (line 354 sets to REJECTED_RESEARCH)
  var previousStatus = candidate.status;
  candidate.status = 'REJECTED_RESEARCH';
  candidate.rejectedAt = new Date().toISOString();
  candidate.rejectionEvidence = evidence || {};

  // Also register in model_registry for cross-module blocking
  try {
    var MODEL_REGISTRY = require('../evolution/model_registry');
    MODEL_REGISTRY.rejectModel(versionId, evidence);
  } catch (_) {}

  _state.transitions.push({
    from: previousStatus,
    to: 'REJECTED_RESEARCH',
    hypothesisId: candidate.hypothesisId,
    versionId: versionId,
    reason: evidence ? evidence.reason : 'no_alpha',
    date: new Date().toISOString().slice(0, 10),
    evidence: evidence,
  });

  _persist();
  console.log('[CandidateRegistry] REJECTED_RESEARCH: ' + versionId +
    ' — artifacts preserved. Hypothesis ' + candidate.hypothesisId + ' candidate frozen.');

  return { rejected: true, versionId: versionId, status: 'REJECTED_RESEARCH' };
}

// ── Evaluation window management ──

/**
 * Set evaluation window configuration.
 * First 4 windows (0-3) = research exploration
 * Last 2 windows (4-5) = lock confirmation set
 */
function setEvaluationWindows(windows) {
  _state.evaluationWindows = windows.map(function (w, i) {
    return {
      index: i,
      windowId: 'window_' + String(i + 1).padStart(3, '0'), // e.g., 'window_001'
      role: i < 4 ? 'research' : 'lock',
      trainStart: w.trainStart,
      trainEnd: w.trainEnd,
      testStart: w.testStart,
      testEnd: w.testEnd,
    };
  });
  _persist();
  console.log('[CandidateRegistry] Evaluation windows set: ' +
    _state.evaluationWindows.filter(function (w) { return w.role === 'research'; }).length +
    ' research + ' +
    _state.evaluationWindows.filter(function (w) { return w.role === 'lock'; }).length +
    ' lock confirmation');
}

function getResearchWindowIndices() {
  return _state.evaluationWindows
    .filter(function (w) { return w.role === 'research'; })
    .map(function (w) { return w.index; });
}

function getLockWindowIndices() {
  return _state.evaluationWindows
    .filter(function (w) { return w.role === 'lock'; })
    .map(function (w) { return w.index; });
}

// ── Evaluation recording ──

/**
 * Record evaluation results for a candidate on a specific window.
 *
 * This is called after each window completes evaluation.
 * If all research windows pass → candidate can be promoted to SHADOW_CANDIDATE.
 * If all windows (research + lock) complete → final verdict generated.
 *
 * @param {string} versionId
 * @param {number} windowIndex
 * @param {object} results — {
 *   // Core metrics
 *   rankIC, netReturn, grossReturn, benchmarkReturn, netExcessReturn,
 *   deltaCI, directionAccuracy,
 *   // P1: Immutable identity fields (required)
 *   candidateVersionId, hypothesisId,
 *   strategyHash, featureSchemaHash, snapshotHash,
 *   windowId, costAssumptions, benchmarkStatus, windowDates,
 * }
 */
function recordEvaluation(versionId, windowIndex, results) {
  var candidate = null;
  for (var i = 0; i < _state.candidates.length; i++) {
    if (_state.candidates[i].versionId === versionId) {
      candidate = _state.candidates[i];
      break;
    }
  }
  if (!candidate) return { error: 'not_found', versionId: versionId };

  // Don't evaluate rejected candidates
  if (candidate.status === 'REJECTED_RESEARCH') {
    return { error: 'rejected_permanent', versionId: versionId };
  }

  var windowRole = 'research';
  var windowId = null;
  for (var wi = 0; wi < _state.evaluationWindows.length; wi++) {
    if (_state.evaluationWindows[wi].index === windowIndex) {
      windowRole = _state.evaluationWindows[wi].role;
      windowId = _state.evaluationWindows[wi].windowId || null;
      break;
    }
  }

  // Don't re-evaluate lock windows for models that are only RESEARCH_ONLY
  // (lock confirmation is only for SHADOW_CANDIDATE models)
  if (windowRole === 'lock' && candidate.status === 'RESEARCH_ONLY') {
    return { error: 'lock_windows_require_shadow_candidate', versionId: versionId,
      currentStatus: candidate.status };
  }

  // P1.2: Idempotency check — same (versionId, windowIndex, snapshotHash, executionHash) → no duplicate
  if (candidate.evaluationResults) {
    for (var ei = 0; ei < candidate.evaluationResults.length; ei++) {
      var er = candidate.evaluationResults[ei];
      if (er.windowIndex === windowIndex &&
          er.snapshotHash === (results.snapshotHash || candidate.snapshotHash || null) &&
          er.executionHash === (results.executionHash || candidate.executionHash || null)) {
        console.log('[CandidateRegistry] IDEMPOTENT: window ' + windowIndex + ' already recorded for ' + versionId);
        return { recorded: false, alreadyRecorded: true, versionId: versionId, windowIndex: windowIndex };
      }
    }
  }

  // Record evaluation — P1.2: full record with all required identity fields
  if (!candidate.evaluationResults) candidate.evaluationResults = [];
  candidate.evaluationResults.push({
    windowIndex: windowIndex,
    windowRole: windowRole,
    // Core metrics
    rankIC: results.rankIC,
    netReturn: results.netReturn,
    grossReturn: results.grossReturn,
    benchmarkReturn: results.benchmarkReturn,
    netExcessReturn: results.netExcessReturn,
    deltaCI: results.deltaCI || null,
    directionAccuracy: results.directionAccuracy,
    // P1.2: Immutable identity fields
    candidateVersionId: results.candidateVersionId || versionId,
    hypothesisId: results.hypothesisId || candidate.hypothesisId,
    strategyHash: results.strategyHash || candidate.strategyHash || null,
    featureSchemaHash: results.featureSchemaHash || candidate.featureSchemaHash || null,
    snapshotHash: results.snapshotHash || candidate.snapshotHash || null,
    windowPlanHash: results.windowPlanHash || candidate.windowPlanHash || null,
    executionHash: results.executionHash || candidate.executionHash || null,
    windowId: results.windowId || windowId || null,
    costAssumptions: results.costAssumptions || null,
    benchmarkStatus: results.benchmarkStatus || null,
    windowDates: results.windowDates || null,
    evaluatedAt: new Date().toISOString(),
  });

  // Track which windows have been evaluated
  if (!candidate.evaluatedWindows) candidate.evaluatedWindows = [];
  if (candidate.evaluatedWindows.indexOf(windowIndex) < 0) {
    candidate.evaluatedWindows.push(windowIndex);
  }

  candidate.lastEvaluated = new Date().toISOString();
  _state.lastEvaluationDate = new Date().toISOString().slice(0, 10);

  _persist();
  console.log('[CandidateRegistry] Window ' + windowIndex + ' (' + windowRole +
    ') recorded for ' + versionId + ': rankIC=' + (results.rankIC != null ? results.rankIC.toFixed(4) : 'null') +
    ', netReturn=' + (results.netReturn != null ? results.netReturn + '%' : 'null') +
    (results.strategyHash ? ', strategyHash=' + results.strategyHash.slice(0, 8) + '...' : ''));

  // Auto-transition: if all research windows complete, attempt promotion
  var researchWindows = getResearchWindowIndices();
  var allResearchDone = researchWindows.every(function (rw) {
    return candidate.evaluatedWindows.indexOf(rw) >= 0;
  });

  if (allResearchDone && candidate.status === 'RESEARCH_ONLY') {
    var promoResult = promoteToShadowCandidate(versionId);
    if (promoResult.promoted) {
      console.log('[CandidateRegistry] Auto-promoted to SHADOW_CANDIDATE after research completion');
    }
  }

  return {
    recorded: true,
    versionId: versionId,
    windowIndex: windowIndex,
    windowRole: windowRole,
    status: candidate.status,
    allResearchDone: allResearchDone,
  };
}

// ── Query API ──

/**
 * Get all candidates with their current status.
 */
function getCandidates(options) {
  var opts = options || {};
  var filter = opts.status || null;
  var hypothesisId = opts.hypothesisId || null;

  var results = _state.candidates.slice();
  if (filter) {
    results = results.filter(function (c) { return c.status === filter; });
  }
  if (hypothesisId) {
    results = results.filter(function (c) { return c.hypothesisId === hypothesisId; });
  }
  return results;
}

/**
 * Get registry status summary.
 */
function getStatus() {
  var activeCandidates = _state.candidates.filter(function (c) {
    return c.status !== 'REJECTED_RESEARCH';
  });
  var shadowCandidates = _state.candidates.filter(function (c) {
    return c.status === 'SHADOW_CANDIDATE';
  });
  var rejected = _state.candidates.filter(function (c) {
    return c.status === 'REJECTED_RESEARCH';
  });

  return {
    totalHypotheses: _state.hypotheses.length,
    hypotheses: _state.hypotheses.map(function (h) { return { id: h.id, name: h.name }; }),
    totalCandidates: _state.candidates.length,
    activeCandidates: activeCandidates.length,
    researchOnly: activeCandidates.filter(function (c) { return c.status === 'RESEARCH_ONLY'; }).length,
    shadowCandidates: shadowCandidates.length,
    rejectedCount: rejected.length,
    rejectedModels: rejected.map(function (r) {
      return {
        versionId: r.versionId,
        hypothesisId: r.hypothesisId,
        rejectedAt: r.rejectedAt,
        evidence: r.rejectionEvidence,
      };
    }),
    evaluationWindows: {
      total: _state.evaluationWindows.length,
      research: getResearchWindowIndices().length,
      lock: getLockWindowIndices().length,
      windows: _state.evaluationWindows,
    },
    lastEvaluationDate: _state.lastEvaluationDate,
    transitions: _state.transitions.slice(-20),
  };
}

/**
 * Get final verdict after all 6 windows complete for a candidate.
 * This is the "lock confirmation" — last 2 windows are held out and
 * used only for confirmation, never for fitting or promotion decisions.
 */
function getFinalVerdict(versionId) {
  var candidate = null;
  for (var i = 0; i < _state.candidates.length; i++) {
    if (_state.candidates[i].versionId === versionId) {
      candidate = _state.candidates[i];
      break;
    }
  }
  if (!candidate) return { error: 'not_found', versionId: versionId };

  var lockWindows = getLockWindowIndices();
  var evals = candidate.evaluationResults || [];
  var lockEvals = evals.filter(function (e) {
    return lockWindows.indexOf(e.windowIndex) >= 0;
  });

  var allWindows = getResearchWindowIndices().concat(lockWindows);
  var allDone = allWindows.every(function (wi) {
    return (candidate.evaluatedWindows || []).indexOf(wi) >= 0;
  });

  if (!allDone) {
    return {
      versionId: versionId,
      status: candidate.status,
      complete: false,
      windowsCompleted: (candidate.evaluatedWindows || []).length,
      windowsTotal: allWindows.length,
      pendingLockWindows: lockWindows.filter(function (wi) {
        return (candidate.evaluatedWindows || []).indexOf(wi) < 0;
      }),
    };
  }

  // All 6 windows complete — generate final verdict
  var lockAvgIC = lockEvals.length > 0
    ? lockEvals.reduce(function (s, e) { return s + (e.rankIC || 0); }, 0) / lockEvals.length
    : null;

  var lockAvgNetReturn = lockEvals.length > 0
    ? lockEvals.reduce(function (s, e) { return s + (e.netReturn || 0); }, 0) / lockEvals.length
    : null;

  var lockPositiveWindows = lockEvals.filter(function (e) { return (e.netReturn || 0) > 0; }).length;

  // Lock confirmation: avg Rank IC must remain positive, and at least 1 of 2 lock
  // windows must show positive net return
  var lockConfirmed = lockAvgIC != null && lockAvgIC > 0 && lockPositiveWindows >= 1;

  return {
    versionId: versionId,
    hypothesisId: candidate.hypothesisId,
    status: candidate.status,
    complete: true,
    windowsCompleted: (candidate.evaluatedWindows || []).length,
    windowsTotal: allWindows.length,
    lockConfirmation: {
      confirmed: lockConfirmed,
      lockAvgRankIC: lockAvgIC,
      lockAvgNetReturn: lockAvgNetReturn,
      lockPositiveWindows: lockPositiveWindows,
      lockTotalWindows: lockWindows.length,
    },
    verdict: lockConfirmed
      ? 'LOCK_CONFIRMED — model shows consistent signal through held-out windows'
      : 'LOCK_FAILED — model signal degraded in held-out windows; do not promote',
    recommendation: lockConfirmed
      ? 'Candidate may be considered for live shadow tracking with manual approval'
      : 'Candidate should remain RESEARCH_ONLY or be REJECTED',
  };
}

// P1.2: Production init wires module.exports to global state instance.
// createRegistry({dataDir}) returns a fully independent instance (for tests).
// createRegistry({}) (no dataDir) initializes the global module exports.

var _productionRegistry = null;

function _initProduction() {
  if (_productionRegistry) return;
  _productionRegistry = createRegistry({});
  // Wire module.exports to production instance
  for (var key in _productionRegistry) {
    if (_productionRegistry.hasOwnProperty(key) && key !== 'createRegistry') {
      module.exports[key] = _productionRegistry[key];
    }
  }
}

_initProduction();

module.exports.createRegistry = createRegistry;
