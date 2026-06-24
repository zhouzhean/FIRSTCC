/**
 * P0-C.1 Integration Test — Cohort API Consistency via Shared cohort_stats.js
 *
 * Verifies that buildPredictionSettlementStats, buildCohortIntegrityStats,
 * and buildCanonicalRunStats produce consistent results for the same underlying data.
 *
 * Uses injectable temp directory — zero impact on production data.
 *
 * Tests:
 *   1. buildCanonicalRunStats with runId filtering
 *   2. buildCanonicalRunStats with different runId
 *   3. buildPredictionSettlementStats unfiltered (all entries)
 *   4. buildCohortIntegrityStats (manifest, actualBought, featureCoverage)
 *   5. Shared field parity across all three functions
 *   6. Field validation consistency
 *   7. Empty ledger handling
 *   8. Legacy No Production Impact
 *
 * Usage: node test/test_cohort_api_consistency.js
 */

var fs = require('fs');
var path = require('path');

var TEST_DATA_DIR = path.join(__dirname, '..', 'report-engine', 'data', '_test_cohort_stats_' + Date.now());

var PASSED = 0;
var FAILED = 0;

function pass(name) { PASSED++; console.log('  PASS: ' + name); }
function fail(name, msg) { FAILED++; console.log('  FAIL: ' + name + ' — ' + msg); }

// ── Setup: Create synthetic test data ──

console.log('=== P0-C.1 Cohort API Consistency Test ===\n');

var simfolioDir = path.join(TEST_DATA_DIR, 'simfolio');
var verificationDir = path.join(TEST_DATA_DIR, 'verification');
fs.mkdirSync(simfolioDir, { recursive: true });
fs.mkdirSync(verificationDir, { recursive: true });

var today = new Date().toISOString().slice(0, 10);

// Build 20 synthetic ledger entries
var entries = [];

// 5 canonical entries, runId="runX", slot="09:30", all 7 fields, researchEligible=true
for (var i = 1; i <= 5; i++) {
  entries.push({
    predictionId: 'runX_600' + i + '00_T+3',
    runId: 'runX',
    scheduledSlot: '09:30',
    asOfDate: today,
    asOf: today,
    targetDate: today,
    featureSnapshot: { dimensions: { technical: 65 + i, hidden: 42 } },
    modelVersionId: 'model_v1',
    canonical: true,
    eligible: true,
    evaluationEligible: true,
    schemaValid: true,
    predictionValid: true,
    researchEligible: true,
    executionCandidateEligible: true,
    globalTradePermission: true,
    executionEligible: true,
    expectedReturn: 0.05 + i * 0.01,
    compositeScore: 80 + i,
    code: '600' + i + '00',
    name: 'TEST_' + i,
    exclusionReason: 'none',
    researchEligibilityReasons: ['all_checks_passed'],
    featureCoverage: 0.8,
    ingestionStatus: 'valid_v3.4.9.4',
  });
}

// 3 canonical entries missing some fields (should reduce allFieldsPresent count)
for (i = 6; i <= 8; i++) {
  entries.push({
    predictionId: 'runX_600' + i + '00_T+3',
    runId: 'runX',
    scheduledSlot: '09:30',
    asOfDate: today,
    targetDate: today,
    featureSnapshot: null,  // Missing!
    modelVersionId: null,   // Missing!
    canonical: true,
    eligible: false,
    evaluationEligible: false,
    schemaValid: false,
    predictionValid: false,
    researchEligible: false,
    executionCandidateEligible: false,
    globalTradePermission: false,
    executionEligible: false,
    expectedReturn: null,
    compositeScore: 60,
    code: '600' + i + '00',
    name: 'TEST_INCOMPLETE_' + i,
    exclusionReason: 'missing_snapshot',
    researchEligibilityReasons: ['missing_feature_snapshot', 'missing_model_version'],
    featureCoverage: 0,
    ingestionStatus: 'valid_v3.4.9.4',
  });
}

// 2 intraday entries (canonical=false)
for (i = 9; i <= 10; i++) {
  entries.push({
    predictionId: 'runX_600' + i + '00_T+3',
    runId: 'runX',
    scheduledSlot: '10:30',
    asOfDate: today,
    targetDate: today,
    featureSnapshot: { dimensions: { technical: 70 } },
    modelVersionId: 'model_v1',
    canonical: false,
    eligible: true,
    evaluationEligible: true,
    schemaValid: true,
    predictionValid: true,
    researchEligible: true,
    executionCandidateEligible: true,
    globalTradePermission: true,
    executionEligible: true,
    expectedReturn: 0.03,
    compositeScore: 75,
    code: '600' + i + '00',
    name: 'TEST_INTRADAY_' + i,
    exclusionReason: 'none',
    researchEligibilityReasons: ['all_checks_passed'],
    featureCoverage: 0.4,
    ingestionStatus: 'valid_v3.4.9.4',
  });
}

// 3 quarantined entries
for (i = 11; i <= 13; i++) {
  entries.push({
    predictionId: 'runX_600' + i + '00_T+3',
    runId: 'runX',
    scheduledSlot: '09:30',
    asOfDate: today,
    targetDate: today,
    featureSnapshot: {},
    modelVersionId: 'model_v1',
    canonical: true,
    ingestionStatus: 'invalid_schema_v3492',
    code: '600' + i + '00',
  });
}

// 2 legacy entries (no targetDate)
for (i = 14; i <= 15; i++) {
  entries.push({
    predictionId: 'runX_600' + i + '00_T+3',
    runId: 'runX',
    asOf: today,
    code: '600' + i + '00',
    name: 'TEST_LEGACY_' + i,
    ingestionStatus: 'legacy_no_target_date',
  });
}

// 5 canonical entries with DIFFERENT runId="runY"
for (i = 16; i <= 20; i++) {
  entries.push({
    predictionId: 'runY_600' + i + '00_T+3',
    runId: 'runY',
    scheduledSlot: '09:30',
    asOfDate: today,
    asOf: today,
    targetDate: today,
    featureSnapshot: { dimensions: { technical: 60 + i, hidden: 50 } },
    modelVersionId: 'model_v2',
    canonical: true,
    eligible: true,
    evaluationEligible: true,
    schemaValid: true,
    predictionValid: true,
    researchEligible: true,
    executionCandidateEligible: true,
    globalTradePermission: true,
    executionEligible: true,
    expectedReturn: 0.04 + i * 0.01,
    compositeScore: 78,
    code: '600' + i + '00',
    name: 'TEST_RUNY_' + i,
    exclusionReason: 'none',
    researchEligibilityReasons: ['all_checks_passed'],
    featureCoverage: 0.9,
    ingestionStatus: 'valid_v3.4.9.4',
  });
}

// Write ledger
var ledgerFile = path.join(simfolioDir, 'prediction_ledger_' + today + '.jsonl');
var ledgerContent = entries.map(function (e) { return JSON.stringify(e); }).join('\n') + '\n';
fs.writeFileSync(ledgerFile, ledgerContent, 'utf8');

// Write outcome ledger (3 entries)
var olFile = path.join(simfolioDir, 'outcome_ledger.jsonl');
fs.writeFileSync(olFile, JSON.stringify({ predictionId: 'runX_600100_T+3', status: 'settled', targetDate: today }) + '\n' +
  JSON.stringify({ predictionId: 'runX_600200_T+3', status: 'settled', targetDate: today }) + '\n' +
  JSON.stringify({ predictionId: 'runX_600300_T+3', status: 'unavailable', targetDate: '2025-01-01' }) + '\n', 'utf8');

// Write decision events (1 bought)
var deFile = path.join(simfolioDir, 'decision_events_' + today + '.jsonl');
fs.writeFileSync(deFile, JSON.stringify({ predictionId: 'runX_600100_T+3', eventType: 'buy', wasBought: true }) + '\n' +
  JSON.stringify({ predictionId: 'runX_600200_T+3', eventType: 'skip', wasBought: false, skipReason: 'no_cash' }) + '\n', 'utf8');

// Write manifest
var manifestFile = path.join(TEST_DATA_DIR, 'daily_research_manifest_' + today + '.json');
fs.writeFileSync(manifestFile, JSON.stringify({
  status: 'completed',
  canonicalRunId: 'runX',
  writtenCount: 50,
  expectedCount: 50,
}, null, 2), 'utf8');

// Write verification summary
var vsFile = path.join(verificationDir, 'verification_summary.json');
fs.writeFileSync(vsFile, JSON.stringify({
  overall: { rankIC: { independentDays: 42 } },
}, null, 2), 'utf8');

// Clear require cache for clean module load
delete require.cache[require.resolve('../mosaic/research/cohort_stats')];

var CS;
try {
  CS = require('../mosaic/research/cohort_stats');
} catch (e) {
  console.error('Cannot load cohort_stats:', e.message);
  cleanup();
  process.exit(1);
}

console.log('Test data created: ' + entries.length + ' ledger entries');
console.log();

// ══════ Tests ══════

// Test 1: buildCanonicalRunStats with runId='runX' (triple-filtered)
// runX has 5 complete + 3 incomplete canonical entries = 8 total canonical for this run
var crsX = CS.buildCanonicalRunStats(TEST_DATA_DIR, today, 'runX');
if (crsX.canonicalCohortCount === 8) {
  pass('buildCanonicalRunStats(runX): canonicalCohortCount=8 (5 complete + 3 incomplete, triple-filtered)');
} else {
  fail('buildCanonicalRunStats(runX)', 'expected 8, got ' + crsX.canonicalCohortCount);
}

// Test 2: buildCanonicalRunStats with runId='runY' (different run)
var crsY = CS.buildCanonicalRunStats(TEST_DATA_DIR, today, 'runY');
if (crsY.canonicalCohortCount === 5) {
  pass('buildCanonicalRunStats(runY): canonicalCohortCount=5 (different run)');
} else {
  fail('buildCanonicalRunStats(runY)', 'expected 5, got ' + crsY.canonicalCohortCount);
}

// Test 3: buildPredictionSettlementStats (unfiltered — all canonical entries from both runs)
// 5 runX complete + 3 runX incomplete + 5 runY = 13 canonical total (unfiltered)
var ps = CS.buildPredictionSettlementStats(TEST_DATA_DIR, today);
var expectedCanonical = 13;
if (ps.canonicalCohortCount === expectedCanonical) {
  pass('buildPredictionSettlementStats: canonicalCohortCount=' + expectedCanonical + ' (unfiltered, all runs)');
} else {
  fail('buildPredictionSettlementStats canonical', 'expected ' + expectedCanonical + ', got ' + ps.canonicalCohortCount);
}

// Test 4: PS legacy and quarantined counts
if (ps.legacyNoTargetDate === 2 && ps.quarantinedCount === 3) {
  pass('buildPredictionSettlementStats: legacyNoTargetDate=2, quarantinedCount=3');
} else {
  fail('buildPredictionSettlementStats exclusion counts',
    'legacy=' + ps.legacyNoTargetDate + ', quarantined=' + ps.quarantinedCount);
}

// Test 5: Outcome ledger
if (ps.settledToday === 2 && ps.unavailableCount === 1 && ps.settledOnTargetToday === 2) {
  pass('buildPredictionSettlementStats: outcome ledger (2 settled + 1 unavailable, 2 on-target)');
} else {
  fail('buildPredictionSettlementStats outcome',
    'settled=' + ps.settledToday + ', unavailable=' + ps.unavailableCount + ', onTarget=' + ps.settledOnTargetToday);
}

// Test 6: buildCohortIntegrityStats
var ci = CS.buildCohortIntegrityStats(TEST_DATA_DIR, today);
if (ci.canonicalCohortCount === expectedCanonical) {
  pass('buildCohortIntegrityStats: canonicalCohortCount=' + expectedCanonical + ' (matches PS)');
} else {
  fail('buildCohortIntegrityStats canonical', 'expected ' + expectedCanonical + ', got ' + ci.canonicalCohortCount);
}

// Test 7: CI-specific fields — manifest MUST be read from injected dataDir
// P1.2 fix: no longer accepts "not found" as PASS
if (ci.hasManifest === true && ci.manifest && ci.manifest.status === 'completed') {
  pass('buildCohortIntegrityStats: manifest correctly read from injected dataDir');
} else {
  fail('buildCohortIntegrityStats manifest', 'hasManifest=' + ci.hasManifest + ', manifest=' + JSON.stringify(ci.manifest));
}
if (ci.counts.actualBought === 1) {
  pass('buildCohortIntegrityStats: actualBought=1 (from decision_events)');
} else {
  fail('buildCohortIntegrityStats actualBought', 'expected 1, got ' + ci.counts.actualBought);
}

// Test 8: Field validation consistency
// runX has 8 canonical entries (5 complete + 3 incomplete), triple-filtered
if (crsX.canonicalFieldValidation.totalCanonical === 8) {
  pass('buildCanonicalRunStats: field validation totalCanonical=8 (triple-filtered, 5 complete + 3 incomplete)');
} else {
  fail('buildCanonicalRunStats field validation', 'totalCanonical=' + crsX.canonicalFieldValidation.totalCanonical);
}

// PS field validation: all 8 canonical from both runs (5 complete + 3 incomplete)
if (ps.canonicalFieldValidation.totalCanonical === expectedCanonical) {
  pass('buildPredictionSettlementStats: field validation totalCanonical=' + expectedCanonical);
} else {
  fail('buildPredictionSettlementStats field validation', 'totalCanonical=' + ps.canonicalFieldValidation.totalCanonical);
}

// Test 9: Empty ledger (no crash)
var emptyDir = path.join(TEST_DATA_DIR, 'empty_test');
fs.mkdirSync(path.join(emptyDir, 'simfolio'), { recursive: true });
var emptyStats = CS.buildPredictionSettlementStats(emptyDir, today);
// buildPredictionSettlementStats returns an API-style object with 'ok' field
// totalEntries is in the initial stats but 'top50' is the field name in the API response
if (emptyStats.ok === true && emptyStats.top50 === 0 && emptyStats.canonicalCohortCount === 0 && emptyStats.hasLedger === false) {
  pass('Empty ledger: returns zeroed stats, hasLedger=false, no crash');
} else {
  fail('Empty ledger', 'ok=' + emptyStats.ok + ', top50=' + emptyStats.top50 + ', canonical=' + emptyStats.canonicalCohortCount);
}
// Clean up empty dir
try { fs.rmdirSync(path.join(emptyDir, 'simfolio')); fs.rmdirSync(emptyDir); } catch (_) {}

// ══════ Cleanup ══════

function cleanup() {
  try {
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
  } catch (_) {}
}

cleanup();

// ══════ Report ══════

console.log('\n' + '='.repeat(50));
console.log('RESULTS: ' + PASSED + ' passed, ' + FAILED + ' failed, ' + (PASSED + FAILED) + ' total');
if (FAILED === 0) {
  console.log('ALL TESTS PASSED');
} else {
  console.log('SOME TESTS FAILED');
  process.exitCode = 1;
}
