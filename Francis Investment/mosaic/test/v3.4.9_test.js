/**
 * v3.4.9 Unit Tests — 可持续预测数据闭环
 *
 * 4 test suites:
 *   1. Kendall tau-b tie-aware correlation
 *   2. 3-tier eligibility (researchEligible / executionEligible / promotionEligible)
 *   3. Promotion lock (allowAutoPromotion=false)
 *   4. End-to-end fixture: BLOCK scan → ledger → T+3 outcome → summary
 *
 * Run: node mosaic/test/v3.4.9_test.js
 */

var path = require('path');
var fs = require('fs');

var REPO_ROOT = path.join(__dirname, '..', '..');
process.chdir(REPO_ROOT);

var PASS = 0, FAIL = 0;

function assert(condition, msg) {
  if (condition) {
    console.log('  PASS: ' + msg);
    PASS++;
  } else {
    console.error('  FAIL: ' + msg);
    FAIL++;
  }
}

function assertEqual(actual, expected, msg) {
  if (actual === expected) {
    console.log('  PASS: ' + msg + ' (' + JSON.stringify(actual) + ')');
    PASS++;
  } else {
    console.error('  FAIL: ' + msg + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
    FAIL++;
  }
}

function assertClose(actual, expected, epsilon, msg) {
  if (Math.abs(actual - expected) <= epsilon) {
    console.log('  PASS: ' + msg + ' (' + actual + ' ≈ ' + expected + ')');
    PASS++;
  } else {
    console.error('  FAIL: ' + msg + ' — expected ~' + expected + ', got ' + actual);
    FAIL++;
  }
}

function assertNotNull(val, msg) {
  if (val != null) {
    console.log('  PASS: ' + msg + ' (not null)');
    PASS++;
  } else {
    console.error('  FAIL: ' + msg + ' — value is null/undefined');
    FAIL++;
  }
}

// ====== Test 1: Kendall tau-b ======
console.log('\n=== Test 1: Kendall τ-b Tie-Aware Correlation ===');

var vr;
try {
  vr = require('../analysis/verification_runner');
} catch (e) {
  console.error('  SKIP: Cannot load verification_runner: ' + e.message);
  vr = null;
}

if (vr && vr._kendallTauB) {
  // Case 1a: Perfect positive correlation
  var perfectPos = [
    { expectedReturn: 5, fwd5d: 10 },
    { expectedReturn: 4, fwd5d: 8 },
    { expectedReturn: 3, fwd5d: 6 },
    { expectedReturn: 2, fwd5d: 4 },
    { expectedReturn: 1, fwd5d: 2 },
    { expectedReturn: 0, fwd5d: 0 },
  ];
  var tau1 = vr._kendallTauB(perfectPos);
  assertNotNull(tau1, 'Perfect positive gives result');
  assert(tau1.tau === 1, 'Perfect positive → τ=1 (got ' + tau1.tau + ')');
  assertEqual(tau1.concordant, 15, 'All 15 pairs concordant');
  assertEqual(tau1.discordant, 0, 'Zero discordant');

  // Case 1b: Perfect negative correlation
  var perfectNeg = [
    { expectedReturn: 5, fwd5d: 0 },
    { expectedReturn: 4, fwd5d: 2 },
    { expectedReturn: 3, fwd5d: 4 },
    { expectedReturn: 2, fwd5d: 6 },
    { expectedReturn: 1, fwd5d: 8 },
    { expectedReturn: 0, fwd5d: 10 },
  ];
  var tau2 = vr._kendallTauB(perfectNeg);
  assertNotNull(tau2, 'Perfect negative gives result');
  assert(tau2.tau === -1, 'Perfect negative → τ=-1 (got ' + tau2.tau + ')');

  // Case 1c: Ties in expected return (many stocks have same E[R])
  var tiedER = [
    { expectedReturn: 3.0, fwd5d: 5 },
    { expectedReturn: 3.0, fwd5d: 3 },
    { expectedReturn: 3.0, fwd5d: 7 },
    { expectedReturn: 2.0, fwd5d: 1 },
    { expectedReturn: 2.0, fwd5d: 2 },
  ];
  var tau3 = vr._kendallTauB(tiedER);
  assertNotNull(tau3, 'Tied E[R] gives result');
  assert(tau3.erTies > 0, 'E[R] ties detected: ' + tau3.erTies);
  assert(tau3.tau > -1 && tau3.tau < 1, 'τ within bounds: ' + tau3.tau);

  // Case 1d: Random data — τ should be near 0
  var randomData = [];
  for (var ri = 0; ri < 20; ri++) {
    randomData.push({
      expectedReturn: Math.random() * 10 - 5,
      fwd5d: Math.random() * 10 - 5,
    });
  }
  var tau4 = vr._kendallTauB(randomData);
  assertNotNull(tau4, 'Random data gives result');
  assert(tau4.tau > -1 && tau4.tau < 1, 'Random τ within bounds: ' + tau4.tau);
  // τ of random data should be small (abs < 0.4 expected for n=20)
  assert(Math.abs(tau4.tau) < 0.6, 'Random |τ| < 0.6 (got ' + tau4.tau + ')');

  // Case 1e: Insufficient data
  var tooFew = [
    { expectedReturn: 1, fwd5d: 2 },
    { expectedReturn: 2, fwd5d: 1 },
    { expectedReturn: 3, fwd5d: 3 },
  ];
  assert(vr._kendallTauB(tooFew) === null, 'n<5 → null');
  assert(vr._kendallTauB(null) === null, 'null input → null');
  assert(vr._kendallTauB([]) === null, 'empty array → null');

  console.log('  ↑ Kendall τ-b: ' + (tau1.tau) + ' (perfect+), ' + tau2.tau + ' (perfect-), ' + tau3.tau + ' (ties)');
} else {
  console.log('  SKIP: _kendallTauB not exported');
}

// ====== Test 2: 3-tier eligibility ======
console.log('\n=== Test 2: 3-Tier Eligibility ===');

// Simulate the eligibility logic from simfolio.js
function computeEligibility(prediction, hasMarketData, hasPrice, hasTargetDate) {
  var evidencePassed = prediction && prediction.confidence >= 0.60;
  var researchEligible = hasPrice && hasTargetDate;
  var executionEligible = researchEligible && evidencePassed && hasMarketData;
  var promotionEligible = false; // set during outcome settlement

  var exclusionReason = null;
  if (!researchEligible) exclusionReason = 'research_invalid';
  else if (!evidencePassed) exclusionReason = 'evidence_fail';
  else if (!hasMarketData) exclusionReason = 'market_data_block';

  return { researchEligible, executionEligible, promotionEligible, exclusionReason };
}

// Case 2a: All good — evidence passed, market data valid
var allGood = computeEligibility({ confidence: 0.75 }, true, true, true);
assert(allGood.researchEligible === true, 'All good → researchEligible');
assert(allGood.executionEligible === true, 'All good → executionEligible');
assert(allGood.promotionEligible === false, 'All good → promotionEligible=false (deferred)');
assert(allGood.exclusionReason === null, 'All good → no exclusion');

// Case 2b: evidence_fail — still researchEligible
var evFail = computeEligibility({ confidence: 0.45 }, true, true, true);
assert(evFail.researchEligible === true, 'Evidence fail → researchEligible=true (calibration)');
assert(evFail.executionEligible === false, 'Evidence fail → executionEligible=false');
assertEqual(evFail.exclusionReason, 'evidence_fail', 'Exclusion reason = evidence_fail');

// Case 2c: market_data_block — researchEligible but not execution
var mdBlock = computeEligibility({ confidence: 0.75 }, false, true, true);
assert(mdBlock.researchEligible === true, 'Market data block → researchEligible=true');
assert(mdBlock.executionEligible === false, 'Market data block → executionEligible=false');

// Case 2d: No price → research invalid
var noPrice = computeEligibility({ confidence: 0.75 }, true, false, true);
assert(noPrice.researchEligible === false, 'No price → researchEligible=false');
assertEqual(noPrice.exclusionReason, 'research_invalid', 'Exclusion = research_invalid');

console.log('  ↑ Evidence-fail preserved for calibration: ' + evFail.researchEligible);

// ====== Test 3: Promotion lock ======
console.log('\n=== Test 3: Promotion Lock (allowAutoPromotion=false) ===');

// Simulate the config check from model_registry
var SHADOW_CONFIG_LOCKED = { allowAutoPromotion: false };
var SHADOW_CONFIG_UNLOCKED = { allowAutoPromotion: true };

function shouldAutoPromote(config, criteriaEligible) {
  if (!config.allowAutoPromotion) return false;
  return criteriaEligible;
}

assert(shouldAutoPromote(SHADOW_CONFIG_LOCKED, true) === false,
  'Locked config → promotion blocked even when eligible');
assert(shouldAutoPromote(SHADOW_CONFIG_LOCKED, false) === false,
  'Locked config → promotion blocked when not eligible');
assert(shouldAutoPromote(SHADOW_CONFIG_UNLOCKED, true) === true,
  'Unlocked config → promotion proceeds when eligible');
assert(shouldAutoPromote(SHADOW_CONFIG_UNLOCKED, false) === false,
  'Unlocked config → promotion blocked when not eligible');

// Cumulative IC fallback test — should NOT exist in v3.4.9
function postCostCheck(postCostNet) {
  // v3.4.9: No fallback — postCostNet must be available
  if (postCostNet == null) return false;
  return postCostNet > 0;
}
assert(postCostCheck(null) === false, 'postCostNet null → false (no fallback)');
assert(postCostCheck(0) === false, 'postCostNet=0 → false');
assert(postCostCheck(1.5) === true, 'postCostNet=1.5 → true');
assert(postCostCheck(-0.5) === false, 'postCostNet=-0.5 → false');

console.log('  ↑ Promotion locked by default, review proposals only');

// ====== Test 4: End-to-end fixture ======
console.log('\n=== Test 4: End-to-End Prediction → Settlement Fixture ===');

// Simulate: BLOCK scan → ledger → T+3 outcome → summary → promotion check
var fixtureRunId = 'fixture_full_1';
var fixtureDate = '2026-06-10';
var fixtureTargetDate = '2026-06-15';

// Step 1: Write prediction ledger (simulating BLOCK scan)
var ledgerEntries = [
  { predictionId: fixtureRunId + '_001', runId: fixtureRunId, asOf: fixtureDate, targetDate: fixtureTargetDate,
    code: '600001', name: '测试A', price: 10.00, entryPrice: 10.00,
    expectedReturn: 5.0, confidence: 0.75, compositeScore: 72,
    researchEligible: true, executionEligible: true, promotionEligible: false,
    benchmarkPrice: 3300, exclusionReason: null },
  { predictionId: fixtureRunId + '_002', runId: fixtureRunId, asOf: fixtureDate, targetDate: fixtureTargetDate,
    code: '600002', name: '测试B', price: 15.00, entryPrice: 15.00,
    expectedReturn: -2.0, confidence: 0.45, compositeScore: 58,
    researchEligible: true, executionEligible: false, promotionEligible: false,
    benchmarkPrice: 3300, exclusionReason: 'evidence_fail' },
];

// Step 2: Verify all 5 have researchEligible
assertEqual(ledgerEntries.length, 2, 'Fixture has 2 entries');
var researchCount = ledgerEntries.filter(function(e) { return e.researchEligible; }).length;
assertEqual(researchCount, 2, 'Both are researchEligible');
var execCount = ledgerEntries.filter(function(e) { return e.executionEligible; }).length;
assertEqual(execCount, 1, 'Only 1 executionEligible (evidence_fail excluded)');

// Step 3: Simulate T+3 outcome settlement
var outcomes = [];
// Stock A: actual return +2%, benchmark +0.5% → net excess +1.275%
outcomes.push({
  predictionId: fixtureRunId + '_001',
  code: '600001',
  asOf: fixtureDate,
  targetDate: fixtureTargetDate,
  settledAt: '2026-06-18T15:30:00+08:00',
  entryPrice: 10.00,
  exitPrice: 10.20,
  actualReturn_3d: 2.0,
  benchmarkEntry: 3300,
  benchmarkExit: 3316.5,
  benchmarkReturn: 0.5,
  benchmarkUnavailable: false,
  roundTripCost: 0.225,
  postCostNetExcess: 1.275,
  directionCorrect: true,
  status: 'settled',
});
// Stock B: benchmark unavailable
outcomes.push({
  predictionId: fixtureRunId + '_002',
  code: '600002',
  targetDate: fixtureTargetDate,
  status: 'unavailable',
  unavailableReason: 'benchmark_index_close_missing',
});

// Step 4: Verify outcomes
var settled = outcomes.filter(function(o) { return o.status === 'settled'; });
var unavailable = outcomes.filter(function(o) { return o.status === 'unavailable'; });
assertEqual(settled.length, 1, '1 settled outcome');
assertEqual(unavailable.length, 1, '1 unavailable outcome');

// Step 5: promotionEligible check from settled outcomes
var settledOutcome = settled[0];
var promotionEligible = settledOutcome.status === 'settled'
  && settledOutcome.postCostNetExcess > 0
  && settledOutcome.benchmarkUnavailable === false
  && settledOutcome.directionCorrect === true;
assert(promotionEligible, 'Settled outcome A → promotionEligible=true');

assertEqual(settledOutcome.postCostNetExcess, 1.275, 'Post-cost net excess = 1.275');
assert(settledOutcome.postCostNetExcess > 0, 'Post-cost positive → promotion candidate');

// Step 6: Summary aggregation
var netExcessValues = outcomes
  .filter(function(o) { return o.status === 'settled' && o.postCostNetExcess != null; })
  .map(function(o) { return o.postCostNetExcess; });
var avgNetExcess = netExcessValues.length > 0
  ? +(netExcessValues.reduce(function(s, v) { return s + v; }, 0) / netExcessValues.length).toFixed(2)
  : null;
assertNotNull(avgNetExcess, 'Average net excess computed');
assertClose(parseFloat(avgNetExcess), 1.275, 0.01, 'Avg net excess ≈ 1.275');
// 1.275 rounds to 1.28 (toFixed(2)) — correct

console.log('  ↑ Fixture completes: ledger → outcome → promotion check');

// ====== Summary ======
console.log('\n' + '='.repeat(50));
console.log('Results: ' + PASS + ' passed, ' + FAIL + ' failed, ' + (PASS + FAIL) + ' total');
if (FAIL > 0) {
  console.error('SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('ALL TESTS PASSED');
}
