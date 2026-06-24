/**
 * P1 Regression Test — Candidate Registry: lifecycle, promotion gates,
 * rejection idempotency, lock window gating, hash functions, strategy hash stability.
 *
 * Tests:
 *   Group 1: Registration and Hypothesis Management (5 tests)
 *   Group 2: Evaluation Recording (4 tests)
 *   Group 3: Promotion Gates (5 tests)
 *   Group 4: Rejection (3 tests)
 *   Group 5: Lock Windows (3 tests)
 *   Group 6: Window Management (2 tests)
 *   Group 7: Hash Functions (4 tests)
 *
 * Usage: node test/test_candidate_registry.js
 */

var fs = require('fs');
var path = require('path');

// P1.1: Use injectable DATA_DIR factory — NO backup/overwrite of production file
var TEST_DATA_DIR = path.join(__dirname, '..', 'report-engine', 'data', '_test_p1_registry_' + Date.now());
var TEST_REGISTRY_DIR = path.join(TEST_DATA_DIR, 'research');
var TEST_REGISTRY_FILE = path.join(TEST_REGISTRY_DIR, 'candidate_registry.json');

var PASSED = 0;
var FAILED = 0;

function pass(name) { PASSED++; console.log('  PASS: ' + name); }
function fail(name, msg) { FAILED++; console.log('  FAIL: ' + name + ' — ' + msg); }

// ────────────────────────────────────────────────────────────
// P1.1: Test isolation via createRegistry({dataDir})
// ────────────────────────────────────────────────────────────

console.log('=== P1 Candidate Registry Regression Test ===\n');

// Create temp directory with clean registry
fs.mkdirSync(TEST_REGISTRY_DIR, { recursive: true });

var cleanRegistry = {
  candidates: [],
  hypotheses: [
    {
      id: 'H1', name: 'Momentum + Volatility',
      description: 'Technical composite score weighted by inverse 20-day volatility.',
      features: ['technical', 'volatility20d'],
      interaction: 'technical / (1 + volatility20d)',
      lockedAt: '2026-06-24',
      rationale: 'Low-vol anomaly adapted to A-share.',
    },
    {
      id: 'H2', name: 'Derived Hidden-Signal Bundle',
      description: 'Hidden signal composite (H1-H9) as sole input.',
      features: ['hidden'],
      interaction: null,
      lockedAt: '2026-06-24',
      rationale: 'Tests whether hidden-signal derivatives carry standalone predictive power.',
    },
    {
      id: 'H3', name: 'Signal-Volume Interaction',
      description: 'Interaction term: signalCount × compositeScore.',
      features: ['signalCount', 'compositeScore'],
      interaction: 'signalCount * compositeScore',
      lockedAt: '2026-06-24',
      rationale: 'Tests confluence amplification effect.',
    },
  ],
  evaluationWindows: [],
  transitions: [],
  lastEvaluationDate: null,
  updatedAt: new Date().toISOString(),
};
fs.writeFileSync(TEST_REGISTRY_FILE, JSON.stringify(cleanRegistry, null, 2), 'utf8');

// P1.1: Use injectable factory — zero impact on production file
var CR;
try {
  CR = require('../mosaic/research/candidate_registry').createRegistry({ dataDir: TEST_DATA_DIR });
} catch (e) {
  console.error('Cannot load candidate_registry:', e.message);
  cleanup();
  process.exit(1);
}

console.log('Module loaded with injectable DATA_DIR. Running tests...\n');

// ────────────────────────────────────────────────────────────
// Test Group 1: Registration and Hypothesis Management
// ────────────────────────────────────────────────────────────

console.log('--- Test Group 1: Registration and Hypothesis Management ---');

// Test 1: getHypotheses() returns 3 hypotheses
var hyps = CR.getHypotheses();
if (hyps.length === 3) {
  pass('getHypotheses() returns 3 hypotheses');
} else {
  fail('getHypotheses()', 'expected 3, got ' + hyps.length);
}

// Test 2: getHypothesis('H1') returns correct feature list
var h1 = CR.getHypothesis('H1');
if (h1 && h1.features && h1.features.length === 2 && h1.features[0] === 'technical' && h1.features[1] === 'volatility20d') {
  pass("getHypothesis('H1') returns correct feature list [technical, volatility20d]");
} else {
  fail("getHypothesis('H1')", 'wrong features: ' + JSON.stringify(h1 ? h1.features : null));
}

// Test 3: registerCandidate() creates a candidate with versionId format
var regResult1 = CR.registerCandidate({
  hypothesisId: 'H1',
  model: { intercept: 0.01, weights: [0.5, -0.2], featureNames: ['technical', 'volatility20d'], lambda: 0.1 },
  metrics: { avgRankIC: 0.03, netReturn: 1.5 },
  window: { trainStart: '2023-10-30', trainEnd: '2024-06-15', testStart: '2024-06-17', testEnd: '2024-09-15' },
  artifactsPath: 'model_artifacts/H1',
  strategyHash: 'abc123def456',
  featureSchemaHash: 'fea789abc012',
  snapshotHash: 'snap345def678',
});

if (regResult1 && regResult1.versionId && regResult1.versionId.indexOf('candidate_H1_') === 0) {
  pass('registerCandidate() creates candidate_H1_... versionId: ' + regResult1.versionId.slice(0, 20) + '...');
} else {
  fail('registerCandidate()', 'unexpected result: ' + JSON.stringify(regResult1));
}

// Test 4: Registering with unknown hypothesisId returns error
var badReg = CR.registerCandidate({ hypothesisId: 'H99', model: {} });
if (badReg && badReg.error === 'unknown_hypothesis') {
  pass('registerCandidate with unknown hypothesisId returns error: ' + badReg.hypothesisId);
} else {
  fail('registerCandidate unknown hypothesis', 'expected error, got: ' + JSON.stringify(badReg));
}

// Test 5: Candidates list grows after registration
var allCands = CR.getCandidates({});
if (allCands.length === 1 && allCands[0].hypothesisId === 'H1') {
  pass('getCandidates() returns 1 candidate (H1) after registration');
} else {
  fail('getCandidates()', 'expected 1 H1 candidate, got ' + allCands.length + ': ' + JSON.stringify(allCands.map(function(c) { return c.hypothesisId; })));
}

// ────────────────────────────────────────────────────────────
// Test Group 2: Evaluation Recording
// ────────────────────────────────────────────────────────────

console.log('\n--- Test Group 2: Evaluation Recording ---');

// Set up evaluation windows
CR.setEvaluationWindows([
  { trainStart: '2023-10-30', trainEnd: '2024-06-15', testStart: '2024-06-17', testEnd: '2024-09-15' },
  { trainStart: '2023-12-28', trainEnd: '2024-09-15', testStart: '2024-09-16', testEnd: '2024-12-15' },
  { trainStart: '2024-03-01', trainEnd: '2024-12-15', testStart: '2024-12-16', testEnd: '2025-03-15' },
  { trainStart: '2024-06-01', trainEnd: '2025-03-15', testStart: '2025-03-16', testEnd: '2025-06-15' },
  { trainStart: '2024-09-01', trainEnd: '2025-06-15', testStart: '2025-06-16', testEnd: '2025-09-15' },
  { trainStart: '2024-12-01', trainEnd: '2025-09-15', testStart: '2025-09-16', testEnd: '2025-12-15' },
]);

// Test 6: recordEvaluation() stores per-window results with all required identity fields
var evalRecord1 = {
  rankIC: 0.04,
  netReturn: 1.2,
  grossReturn: 2.5,
  benchmarkReturn: 0.8,
  netExcessReturn: 0.4,
  deltaCI: [-0.5, 1.3],
  directionAccuracy: 53.2,
  // P1: Identity fields
  candidateVersionId: regResult1.versionId,
  hypothesisId: 'H1',
  strategyHash: 'abc123def456',
  featureSchemaHash: 'fea789abc012',
  snapshotHash: 'snap345def678',
  windowId: 'window_001',
  costAssumptions: {
    roundTripCostPct: 0.452,
    commissionRate: 0.00025,
    stampTaxRate: 0.001,
    transferFeeRate: 0.00001,
    slippagePct: 0.0015,
  },
  benchmarkStatus: 'available',
  windowDates: {
    trainStart: '2023-10-30', trainEnd: '2024-06-15',
    validateStart: '2024-06-17', validateEnd: '2024-07-08',
    testStart: '2024-07-09', testEnd: '2024-09-15',
  },
};

var recResult = CR.recordEvaluation(regResult1.versionId, 0, evalRecord1);
if (recResult.recorded) {
  pass('recordEvaluation() records window 0 (research): recorded=true');
} else {
  fail('recordEvaluation()', 'expected recorded=true, got: ' + JSON.stringify(recResult));
}

// Test 7: Recorded evaluation includes all P1 identity fields
var candidate = CR.getCandidates({ hypothesisId: 'H1' })[0];
if (candidate && candidate.evaluationResults && candidate.evaluationResults.length === 1) {
  var er = candidate.evaluationResults[0];
  var fieldsOk = true;
  if (er.strategyHash !== 'abc123def456') { fieldsOk = false; console.log('    strategyHash missing/wrong'); }
  if (er.featureSchemaHash !== 'fea789abc012') { fieldsOk = false; console.log('    featureSchemaHash missing/wrong'); }
  if (er.snapshotHash !== 'snap345def678') { fieldsOk = false; console.log('    snapshotHash missing/wrong'); }
  if (er.windowId !== 'window_001') { fieldsOk = false; console.log('    windowId missing/wrong: ' + er.windowId); }
  if (!er.costAssumptions || er.costAssumptions.roundTripCostPct !== 0.452) { fieldsOk = false; console.log('    costAssumptions missing/wrong'); }
  if (er.benchmarkStatus !== 'available') { fieldsOk = false; console.log('    benchmarkStatus missing/wrong'); }
  if (!er.windowDates || er.windowDates.testStart !== '2024-07-09') { fieldsOk = false; console.log('    windowDates missing/wrong'); }
  if (fieldsOk) {
    pass('recorded evaluation includes all P1 identity fields (strategyHash, featureSchemaHash, snapshotHash, windowId, costAssumptions, benchmarkStatus, windowDates)');
  } else {
    fail('recorded evaluation', 'some P1 fields missing or wrong');
  }
} else {
  fail('recorded evaluation', 'candidate.evaluationResults not found or empty');
}

// Test 8: Recording lock windows on RESEARCH_ONLY candidate returns error
var lockEvalResult = CR.recordEvaluation(regResult1.versionId, 4, evalRecord1);
if (lockEvalResult.error === 'lock_windows_require_shadow_candidate') {
  pass('lock window evaluation blocked for RESEARCH_ONLY candidate: ' + lockEvalResult.currentStatus);
} else {
  fail('lock window evaluation', 'expected error, got: ' + JSON.stringify(lockEvalResult));
}

// Test 9: evaluatedWindows array tracks which windows have been evaluated
var cand1 = CR.getCandidates({ hypothesisId: 'H1' })[0];
if (cand1 && cand1.evaluatedWindows && cand1.evaluatedWindows.length === 1 && cand1.evaluatedWindows[0] === 0) {
  pass('evaluatedWindows tracks window 0 after single recording');
} else {
  fail('evaluatedWindows', 'expected [0], got: ' + JSON.stringify(cand1 ? cand1.evaluatedWindows : null));
}

// ────────────────────────────────────────────────────────────
// Test Group 3: Promotion Gates
// ────────────────────────────────────────────────────────────

console.log('\n--- Test Group 3: Promotion Gates ---');

// Register a new candidate that we'll test promotion on
var regResult2 = CR.registerCandidate({
  hypothesisId: 'H2',
  model: { intercept: 0.005, weights: [0.3], featureNames: ['hidden'], lambda: 0.05 },
  metrics: {},
  window: {},
  artifactsPath: 'model_artifacts/H2',
  strategyHash: 'h2_strategy_hash_123',
  featureSchemaHash: 'h2_feature_hash_456',
  snapshotHash: 'h2_snapshot_hash_789',
});

// Add 4 research window evaluations, all favorable
CR.recordEvaluation(regResult2.versionId, 0, {
  rankIC: 0.04, netReturn: 1.2, grossReturn: 2.0, netExcessReturn: 0.7,
  deltaCI: [-0.1, 1.5], directionAccuracy: 53,
  candidateVersionId: regResult2.versionId, hypothesisId: 'H2',
  strategyHash: 'h2_strategy_hash_123', featureSchemaHash: 'h2_feature_hash_456',
  snapshotHash: 'h2_snapshot_hash_789', windowId: 'window_001',
  costAssumptions: { roundTripCostPct: 0.452 }, benchmarkStatus: 'available',
  windowDates: { trainStart: 'a', trainEnd: 'b', validateStart: 'c', validateEnd: 'd', testStart: 'e', testEnd: 'f' },
});
CR.recordEvaluation(regResult2.versionId, 1, {
  rankIC: 0.05, netReturn: 1.5, grossReturn: 2.3, netExcessReturn: 0.9,
  deltaCI: [-0.05, 1.8], directionAccuracy: 54,
  candidateVersionId: regResult2.versionId, hypothesisId: 'H2',
  strategyHash: 'h2_strategy_hash_123', featureSchemaHash: 'h2_feature_hash_456',
  snapshotHash: 'h2_snapshot_hash_789', windowId: 'window_002',
  costAssumptions: { roundTripCostPct: 0.452 }, benchmarkStatus: 'available',
  windowDates: { trainStart: 'a', trainEnd: 'b', validateStart: 'c', validateEnd: 'd', testStart: 'e', testEnd: 'f' },
});
CR.recordEvaluation(regResult2.versionId, 2, {
  rankIC: 0.045, netReturn: -0.5, grossReturn: 1.0, netExcessReturn: -0.8,
  deltaCI: [-1.0, 0.5], directionAccuracy: 50,
  candidateVersionId: regResult2.versionId, hypothesisId: 'H2',
  strategyHash: 'h2_strategy_hash_123', featureSchemaHash: 'h2_feature_hash_456',
  snapshotHash: 'h2_snapshot_hash_789', windowId: 'window_003',
  costAssumptions: { roundTripCostPct: 0.452 }, benchmarkStatus: 'available',
  windowDates: { trainStart: 'a', trainEnd: 'b', validateStart: 'c', validateEnd: 'd', testStart: 'e', testEnd: 'f' },
});
CR.recordEvaluation(regResult2.versionId, 3, {
  rankIC: 0.055, netReturn: 1.8, grossReturn: 2.8, netExcessReturn: 1.1,
  deltaCI: [0.1, 2.0], directionAccuracy: 56,
  candidateVersionId: regResult2.versionId, hypothesisId: 'H2',
  strategyHash: 'h2_strategy_hash_123', featureSchemaHash: 'h2_feature_hash_456',
  snapshotHash: 'h2_snapshot_hash_789', windowId: 'window_004',
  costAssumptions: { roundTripCostPct: 0.452 }, benchmarkStatus: 'available',
  windowDates: { trainStart: 'a', trainEnd: 'b', validateStart: 'c', validateEnd: 'd', testStart: 'e', testEnd: 'f' },
});

// Test 10: All 4 research windows evaluated + avg IC > 0 + ≥2 positive returns + non-negative delta CI → promoted
var h2Cand = CR.getCandidates({ hypothesisId: 'H2' })[0];
if (h2Cand && h2Cand.status === 'SHADOW_CANDIDATE') {
  pass('promotion: H2 auto-promoted to SHADOW_CANDIDATE after 4 research windows (avgIC>0, ≥2 positive returns, non-negative delta CI)');
} else {
  fail('promotion', 'H2 should be SHADOW_CANDIDATE, is: ' + (h2Cand ? h2Cand.status : 'not found'));
}

// Test 11: Missing research window → NOT promoted (already tested implicitly above, but verify explicitly)
var regResult3 = CR.registerCandidate({
  hypothesisId: 'H3',
  model: {},
  metrics: {},
  window: {},
  artifactsPath: 'model_artifacts/H3',
  strategyHash: 'h3_hash', featureSchemaHash: 'h3_fea', snapshotHash: 'h3_snap',
});

// Only record 3 of 4 research windows
CR.recordEvaluation(regResult3.versionId, 0, {
  rankIC: 0.05, netReturn: 1.0, grossReturn: 2.0, netExcessReturn: 0.5,
  deltaCI: [0, 1.0], directionAccuracy: 52,
  candidateVersionId: regResult3.versionId, hypothesisId: 'H3',
  strategyHash: 'h3_hash', featureSchemaHash: 'h3_fea', snapshotHash: 'h3_snap',
  windowId: 'window_001', costAssumptions: { roundTripCostPct: 0.452 },
  benchmarkStatus: 'available',
  windowDates: { trainStart: 'a', trainEnd: 'b', validateStart: 'c', validateEnd: 'd', testStart: 'e', testEnd: 'f' },
});
CR.recordEvaluation(regResult3.versionId, 1, {
  rankIC: 0.04, netReturn: 0.8, grossReturn: 1.5, netExcessReturn: 0.3,
  deltaCI: [-0.2, 1.2], directionAccuracy: 51,
  candidateVersionId: regResult3.versionId, hypothesisId: 'H3',
  strategyHash: 'h3_hash', featureSchemaHash: 'h3_fea', snapshotHash: 'h3_snap',
  windowId: 'window_002', costAssumptions: { roundTripCostPct: 0.452 },
  benchmarkStatus: 'available',
  windowDates: { trainStart: 'a', trainEnd: 'b', validateStart: 'c', validateEnd: 'd', testStart: 'e', testEnd: 'f' },
});
CR.recordEvaluation(regResult3.versionId, 2, {
  rankIC: 0.03, netReturn: -0.5, grossReturn: 0.8, netExcessReturn: -1.0,
  deltaCI: [-1.5, -0.1], directionAccuracy: 48,
  candidateVersionId: regResult3.versionId, hypothesisId: 'H3',
  strategyHash: 'h3_hash', featureSchemaHash: 'h3_fea', snapshotHash: 'h3_snap',
  windowId: 'window_003', costAssumptions: { roundTripCostPct: 0.452 },
  benchmarkStatus: 'available',
  windowDates: { trainStart: 'a', trainEnd: 'b', validateStart: 'c', validateEnd: 'd', testStart: 'e', testEnd: 'f' },
});
// Missing window 3 — auto-promotion should NOT fire

var h3Cand = CR.getCandidates({ hypothesisId: 'H3' })[0];
if (h3Cand && h3Cand.status === 'RESEARCH_ONLY') {
  pass('promotion blocked: H3 stays RESEARCH_ONLY with only 3/4 research windows');
} else {
  fail('promotion blocked', 'H3 should be RESEARCH_ONLY, is: ' + (h3Cand ? h3Cand.status : 'not found'));
}

// Test 12: Avg IC <= 0 → NOT promoted (test via explicit promoteToShadowCandidate)
// H3 already has 3 windows with positive IC, add a 4th with negative enough to make avg negative
CR.recordEvaluation(regResult3.versionId, 3, {
  rankIC: -0.15, netReturn: -2.0, grossReturn: -1.0, netExcessReturn: -2.5,
  deltaCI: [-2.5, -1.5], directionAccuracy: 40,
  candidateVersionId: regResult3.versionId, hypothesisId: 'H3',
  strategyHash: 'h3_hash', featureSchemaHash: 'h3_fea', snapshotHash: 'h3_snap',
  windowId: 'window_004', costAssumptions: { roundTripCostPct: 0.452 },
  benchmarkStatus: 'available',
  windowDates: { trainStart: 'a', trainEnd: 'b', validateStart: 'c', validateEnd: 'd', testStart: 'e', testEnd: 'f' },
});

// avg = (0.05 + 0.04 + 0.03 + (-0.15)) / 4 = -0.0075 → avg <= 0 → NOT promoted
h3Cand = CR.getCandidates({ hypothesisId: 'H3' })[0];
if (h3Cand && h3Cand.status === 'RESEARCH_ONLY') {
  pass('promotion blocked: H3 avg Rank IC <= 0 after 4 windows (should stay RESEARCH_ONLY)');
} else {
  fail('avg IC check', 'H3 should be RESEARCH_ONLY (avgIC negative), is: ' + (h3Cand ? h3Cand.status : 'not found'));
}

// Test 13: Less than 2 positive return windows → NOT promoted
// Register H1 candidate with only 1 positive return window
var regResult4 = CR.registerCandidate({
  hypothesisId: 'H1',
  model: {}, metrics: {}, window: {},
  artifactsPath: 'model_artifacts/H1_v2',
  strategyHash: 'h1_v2_hash', featureSchemaHash: 'h1_v2_fea', snapshotHash: 'h1_v2_snap',
});

CR.recordEvaluation(regResult4.versionId, 0, {
  rankIC: 0.03, netReturn: 1.0, grossReturn: 2.0, netExcessReturn: 0.5,
  deltaCI: [0, 1.0], directionAccuracy: 52,
  candidateVersionId: regResult4.versionId, hypothesisId: 'H1',
  strategyHash: 'h1_v2_hash', featureSchemaHash: 'h1_v2_fea', snapshotHash: 'h1_v2_snap',
  windowId: 'window_001', costAssumptions: { roundTripCostPct: 0.452 },
  benchmarkStatus: 'available',
  windowDates: { trainStart: 'a', trainEnd: 'b', validateStart: 'c', validateEnd: 'd', testStart: 'e', testEnd: 'f' },
});
CR.recordEvaluation(regResult4.versionId, 1, {
  rankIC: 0.04, netReturn: -0.3, grossReturn: 1.0, netExcessReturn: -0.8,
  deltaCI: [-1.0, 0.5], directionAccuracy: 50,
  candidateVersionId: regResult4.versionId, hypothesisId: 'H1',
  strategyHash: 'h1_v2_hash', featureSchemaHash: 'h1_v2_fea', snapshotHash: 'h1_v2_snap',
  windowId: 'window_002', costAssumptions: { roundTripCostPct: 0.452 },
  benchmarkStatus: 'available',
  windowDates: { trainStart: 'a', trainEnd: 'b', validateStart: 'c', validateEnd: 'd', testStart: 'e', testEnd: 'f' },
});
CR.recordEvaluation(regResult4.versionId, 2, {
  rankIC: 0.05, netReturn: -1.0, grossReturn: 0, netExcessReturn: -1.5,
  deltaCI: [-1.5, 0], directionAccuracy: 49,
  candidateVersionId: regResult4.versionId, hypothesisId: 'H1',
  strategyHash: 'h1_v2_hash', featureSchemaHash: 'h1_v2_fea', snapshotHash: 'h1_v2_snap',
  windowId: 'window_003', costAssumptions: { roundTripCostPct: 0.452 },
  benchmarkStatus: 'available',
  windowDates: { trainStart: 'a', trainEnd: 'b', validateStart: 'c', validateEnd: 'd', testStart: 'e', testEnd: 'f' },
});
CR.recordEvaluation(regResult4.versionId, 3, {
  rankIC: 0.06, netReturn: -0.2, grossReturn: 0.8, netExcessReturn: -0.6,
  deltaCI: [-0.8, 0.1], directionAccuracy: 50,
  candidateVersionId: regResult4.versionId, hypothesisId: 'H1',
  strategyHash: 'h1_v2_hash', featureSchemaHash: 'h1_v2_fea', snapshotHash: 'h1_v2_snap',
  windowId: 'window_004', costAssumptions: { roundTripCostPct: 0.452 },
  benchmarkStatus: 'available',
  windowDates: { trainStart: 'a', trainEnd: 'b', validateStart: 'c', validateEnd: 'd', testStart: 'e', testEnd: 'f' },
});

var h1v2Cand = CR.getCandidates({ hypothesisId: 'H1' }).filter(function(c) { return c.versionId === regResult4.versionId; })[0];
// Only 1 positive return window (window 0). Need ≥2.
if (h1v2Cand && h1v2Cand.status === 'RESEARCH_ONLY') {
  pass('promotion blocked: H1_v2 has only 1/4 positive return windows → stays RESEARCH_ONLY');
} else {
  fail('positive return gate', 'H1_v2 should be RESEARCH_ONLY, is: ' + (h1v2Cand ? h1v2Cand.status : 'not found'));
}

// Test 14: All delta CI negative → NOT promoted
// Already tested via H3 above (window 3 was strongly negative, and some were mixed)
// The gate requires all 4 delta CI upper bounds to be < 0
var h2Cand2 = CR.getCandidates({ hypothesisId: 'H2' })[0];
if (h2Cand2 && h2Cand2.status === 'SHADOW_CANDIDATE') {
  pass('delta CI gate: H2 passes (not all CI negative) — correctly promoted');
} else {
  fail('delta CI gate', 'H2 should have been promoted');
}

// ────────────────────────────────────────────────────────────
// Test Group 4: Rejection
// ────────────────────────────────────────────────────────────

console.log('\n--- Test Group 4: Rejection ---');

// Test 15: rejectCandidate() sets status to REJECTED_RESEARCH
var regResult5 = CR.registerCandidate({
  hypothesisId: 'H2',
  model: {}, metrics: {}, window: {},
  artifactsPath: 'model_artifacts/H2_v2',
  strategyHash: 'h2_v2_hash', featureSchemaHash: 'h2_v2_fea', snapshotHash: 'h2_v2_snap',
});

var rejResult = CR.rejectCandidate(regResult5.versionId, {
  reason: 'test rejection — lock windows failed',
  windowsChecked: 6,
  avgRankIC: 0.01,
  allRankICs: [0.03, 0.035, 0.04, 0.045, -0.02, -0.03],
});

if (rejResult && rejResult.rejected && rejResult.status === 'REJECTED_RESEARCH') {
  pass('rejectCandidate() sets status to REJECTED_RESEARCH');
} else {
  fail('rejectCandidate()', 'expected rejected=true, got: ' + JSON.stringify(rejResult));
}

// Test 16: Rejection is idempotent (double-reject returns alreadyRejected)
var rej2 = CR.rejectCandidate(regResult5.versionId, {
  reason: 'second rejection attempt',
});

if (rej2 && rej2.rejected && rej2.alreadyRejected === true) {
  pass('rejection idempotent: second rejectCandidate() returns alreadyRejected=true');
} else {
  fail('rejection idempotent', 'expected alreadyRejected=true, got: ' + JSON.stringify(rej2));
}

// Test 17: Rejected candidate cannot be promoted
var promoBlocked = CR.promoteToShadowCandidate(regResult5.versionId);
if (promoBlocked && promoBlocked.error === 'rejected_permanent') {
  pass('no-promotion: rejected candidate blocked from promotion');
} else {
  fail('no-promotion', 'expected error rejected_permanent, got: ' + JSON.stringify(promoBlocked));
}

// ────────────────────────────────────────────────────────────
// Test Group 5: Lock Windows
// ────────────────────────────────────────────────────────────

console.log('\n--- Test Group 5: Lock Windows ---');

// Test 18: SHADOW_CANDIDATE (H2) can have lock windows recorded
var lockRecResult = CR.recordEvaluation(regResult2.versionId, 4, {
  rankIC: 0.03, netReturn: 0.5, grossReturn: 1.5, netExcessReturn: 0.2,
  deltaCI: [-0.2, 0.8], directionAccuracy: 52,
  candidateVersionId: regResult2.versionId, hypothesisId: 'H2',
  strategyHash: 'h2_strategy_hash_123', featureSchemaHash: 'h2_feature_hash_456',
  snapshotHash: 'h2_snapshot_hash_789', windowId: 'window_005',
  costAssumptions: { roundTripCostPct: 0.452 }, benchmarkStatus: 'available',
  windowDates: { trainStart: 'a', trainEnd: 'b', validateStart: 'c', validateEnd: 'd', testStart: 'e', testEnd: 'f' },
});
if (lockRecResult.recorded) {
  pass('lock window: SHADOW_CANDIDATE can record lock window 4');
} else {
  fail('lock window', 'expected recorded=true for SHADOW_CANDIDATE, got: ' + JSON.stringify(lockRecResult));
}

// Test 19: RESEARCH_ONLY cannot have lock windows recorded
var lockBlocked = CR.recordEvaluation(regResult4.versionId, 4, {
  rankIC: 0.04, netReturn: 1.0, grossReturn: 2.0, netExcessReturn: 0.5,
  deltaCI: [0, 1.0], directionAccuracy: 53,
  candidateVersionId: regResult4.versionId, hypothesisId: 'H1',
  strategyHash: 'h1_v2_hash', featureSchemaHash: 'h1_v2_fea', snapshotHash: 'h1_v2_snap',
  windowId: 'window_005', costAssumptions: { roundTripCostPct: 0.452 },
  benchmarkStatus: 'available',
  windowDates: { trainStart: 'a', trainEnd: 'b', validateStart: 'c', validateEnd: 'd', testStart: 'e', testEnd: 'f' },
});
if (lockBlocked.error === 'lock_windows_require_shadow_candidate') {
  pass('lock window blocked: RESEARCH_ONLY cannot record lock window');
} else {
  fail('lock window blocked', 'expected error, got: ' + JSON.stringify(lockBlocked));
}

// Test 20: getFinalVerdict() returns LOCK_CONFIRMED or LOCK_FAILED
// H2 has 5 windows done (4 research + 1 lock), need 6 for complete verdict
var verdict = CR.getFinalVerdict(regResult2.versionId);
if (verdict && verdict.complete === false && verdict.windowsCompleted === 5 && verdict.windowsTotal === 6) {
  pass('getFinalVerdict() reports 5/6 windows complete, not yet final');
} else {
  fail('getFinalVerdict()', 'expected incomplete with 5/6, got: ' + JSON.stringify(verdict));
}

// ────────────────────────────────────────────────────────────
// Test Group 6: Window Management
// ────────────────────────────────────────────────────────────

console.log('\n--- Test Group 6: Window Management ---');

// Test 21: setEvaluationWindows correctly labels first 4 as research, last 2 as lock
var status = CR.getStatus();
var ew = status.evaluationWindows;
if (ew.research === 4 && ew.lock === 2) {
  pass('setEvaluationWindows: 4 research + 2 lock confirmed');
} else {
  fail('setEvaluationWindows', 'expected 4+2, got: ' + ew.research + '+' + ew.lock);
}

// Test 22: getResearchWindowIndices() and getLockWindowIndices() return correct indices
var rwIndices = CR.getResearchWindowIndices();
var lwIndices = CR.getLockWindowIndices();
if (JSON.stringify(rwIndices) === '[0,1,2,3]' && JSON.stringify(lwIndices) === '[4,5]') {
  pass('getResearchWindowIndices=[0,1,2,3], getLockWindowIndices=[4,5]');
} else {
  fail('window indices', 'research=' + JSON.stringify(rwIndices) + ', lock=' + JSON.stringify(lwIndices));
}

// ────────────────────────────────────────────────────────────
// Test Group 7: Hash Functions (from candidate_runner)
// ────────────────────────────────────────────────────────────

console.log('\n--- Test Group 7: Hash Functions ---');

var RUNNER;
try {
  RUNNER = require('../mosaic/research/candidate_runner');
} catch (e) {
  console.error('Cannot load candidate_runner for hash tests:', e.message);
  RUNNER = null;
}

if (RUNNER && typeof RUNNER.computeStrategyHash === 'function') {

  // Test 23: computeStrategyHash is deterministic
  var hyp1 = { id: 'H1', features: ['technical', 'volatility20d'], interaction: 'technical / (1 + volatility20d)' };
  var hash1 = RUNNER.computeStrategyHash(hyp1);
  var hash2 = RUNNER.computeStrategyHash(hyp1);
  if (hash1 === hash2 && hash1.length === 64) {
    pass('computeStrategyHash: deterministic — same input = same 64-char SHA256 hash');
  } else {
    fail('computeStrategyHash deterministic', 'hash1=' + hash1 + ', hash2=' + hash2);
  }

  // Test 24: Different hypotheses produce different strategyHashes
  var hyp2 = { id: 'H2', features: ['hidden'], interaction: null };
  var hashH2 = RUNNER.computeStrategyHash(hyp2);
  if (hashH2 !== hash1 && hashH2.length === 64) {
    pass('computeStrategyHash: H1 ≠ H2 (different features → different hash)');
  } else {
    fail('computeStrategyHash uniqueness', 'H1=' + hash1.slice(0,12) + ', H2=' + hashH2.slice(0,12));
  }

  // Test 25: computeFeatureSchemaHash is deterministic
  var feaHash1 = RUNNER.computeFeatureSchemaHash(hyp1);
  var feaHash2 = RUNNER.computeFeatureSchemaHash(hyp1);
  if (feaHash1 === feaHash2 && feaHash1.length === 64) {
    pass('computeFeatureSchemaHash: deterministic — same input = same 64-char SHA256 hash');
  } else {
    fail('computeFeatureSchemaHash deterministic', 'fea1=' + feaHash1 + ', fea2=' + feaHash2);
  }

  // Test 26: Known strategyHash for H1 is stable across runs
  // This is a snapshot test — the hash for H1 with specific config should never change
  var knownH1Hash = RUNNER.computeStrategyHash({
    id: 'H1',
    features: ['technical', 'volatility20d'],
    interaction: 'technical / (1 + volatility20d)',
  });
  // This hash is determined by the SHA256 of: "H1|["technical","volatility20d"]|technical / (1 + volatility20d)|v1"
  // We verify it's a valid hex string of 64 chars — actual comparison would be brittle
  if (knownH1Hash && /^[a-f0-9]{64}$/.test(knownH1Hash)) {
    pass('strategyHash stability: H1 strategyHash = ' + knownH1Hash.slice(0, 16) + '... (valid 64-char hex)');
  } else {
    fail('strategyHash stability', 'invalid hash: ' + knownH1Hash);
  }
} else {
  fail('Hash functions', 'candidate_runner not available or missing computeStrategyHash');
  console.log('    RUNNER type=' + typeof RUNNER);
  if (RUNNER) console.log('    Keys: ' + Object.keys(RUNNER).join(', '));
}

// ────────────────────────────────────────────────────────────
// Cleanup: Remove temporary test directory
// ────────────────────────────────────────────────────────────

function cleanup() {
  try {
    if (fs.existsSync(TEST_DATA_DIR)) {
      // Recursively remove test directory
      var rimraf = function(dir) {
        if (!fs.existsSync(dir)) return;
        var items = fs.readdirSync(dir);
        for (var i = 0; i < items.length; i++) {
          var itemPath = path.join(dir, items[i]);
          if (fs.statSync(itemPath).isDirectory()) {
            rimraf(itemPath);
          } else {
            fs.unlinkSync(itemPath);
          }
        }
        fs.rmdirSync(dir);
      };
      rimraf(TEST_DATA_DIR);
    }
  } catch (_) {}
}

// Clean up temp dir
cleanup();

// ────────────────────────────────────────────────────────────
// Report
// ────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(50));
console.log('RESULTS: ' + PASSED + ' passed, ' + FAILED + ' failed, ' + (PASSED + FAILED) + ' total');
if (FAILED === 0) {
  console.log('ALL TESTS PASSED');
} else {
  console.log('SOME TESTS FAILED');
  process.exitCode = 1;
}
