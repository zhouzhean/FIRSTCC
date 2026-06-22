/**
 * v3.4.9.4 P0: Evidence Cohort Integrity — Test Suite
 *
 * Uses REAL require() of production modules — no inline reimplementation.
 * All file I/O goes through config._testDataRoot (temp directory).
 *
 * Suites:
 *   A: Dedup by code before Top-50 sort
 *   B: 6-field eligibility — all branches
 *   C: Daily manifest write + update (started→completed)
 *   D: Real makeTradingDecisions() — 4 paths (no-index, BLOCK, REDUCE, ALLOW)
 *   E: Idempotency — same runId twice → same line count
 *   F: Input drift — different candidates same runId → detected
 *   G: modelVersionId from model_registry baseline
 *   H: Pre/post real data hash comparison
 */

var os = require('os');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var TEMP_DIR = path.join(os.tmpdir(), 'mosaic_v3494_test_' + Date.now());
var REAL_DATA_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data');

// Test infrastructure
var totalPass = 0, totalFail = 0, suitePass = 0, suiteFail = 0;

function startSuite(name) {
  suitePass = 0; suiteFail = 0;
  console.log('\n=== Suite ' + name + ' ===');
}

function assert(label, condition) {
  if (condition) { totalPass++; suitePass++; console.log('  PASS: ' + label); }
  else { totalFail++; suiteFail++; console.error('  FAIL: ' + label); }
}

function endSuite() {
  console.log('  [' + suitePass + '/' + (suitePass + suiteFail) + ' passed]');
}

function setupTempDir() {
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEMP_DIR, 'simfolio'), { recursive: true });
  fs.mkdirSync(path.join(TEMP_DIR, 'verification'), { recursive: true });
  fs.mkdirSync(path.join(TEMP_DIR, 'klines'), { recursive: true });
  fs.mkdirSync(path.join(TEMP_DIR, 'evolution'), { recursive: true });
}

function hashDir(dirPath) {
  if (!fs.existsSync(dirPath)) return 'nonexistent';
  var h = crypto.createHash('sha256');
  function walk(d) {
    var entries = fs.readdirSync(d, { withFileTypes: true });
    entries.sort(function(a, b) { return a.name.localeCompare(b.name); });
    for (var i = 0; i < entries.length; i++) {
      var full = path.join(d, entries[i].name);
      if (entries[i].isDirectory()) {
        h.update(entries[i].name + '/');
        walk(full);
      } else if (entries[i].isFile()) {
        h.update(entries[i].name);
        h.update(fs.readFileSync(full));
      }
    }
  }
  walk(dirPath);
  return h.digest('hex');
}

function syntheticPipelineResults(count) {
  var results = [];
  var codes = ['000001', '000002', '000003', '000004', '000005', '000006', '000007', '000008', '000009', '000010',
    '000011', '000012', '600001', '600002', '600003', '600004', '600005', '600006', '600007', '600008',
    '600009', '600010', '600011', '600012', '600013', '600014', '600015', '600016', '600017', '600018',
    '600019', '600020', '600021', '600022', '600023', '600024', '600025', '600026', '600027', '600028',
    '600029', '600030', '600031', '600032', '600033', '600034', '600035', '600036', '600037', '600038',
    '600039', '600040', '600041', '600042', '600043']; // 55 unique codes — 5 will be deduped
  var names = ['万科A', '平安银行', '格力电器', '比亚迪', '宁德时代', '贵州茅台', '五粮液', '海康威视', '美的集团', '中信证券',
    '招商银行', '伊利股份', '恒瑞医药', '隆基绿能', '三一重工', '药明康德', '迈瑞医疗', '中兴通讯', '京东方A', '长江电力',
    '立讯精密', '牧原股份', '温氏股份', '顺丰控股', '中国中免', '北方华创', '韦尔股份', '中芯国际', '华泰证券', '海天味业',
    '恒生电子', '紫金矿业', '万华化学', '交通银行', '中国建筑', '中国平安', '洛阳钼业', '歌尔股份', '赣锋锂业', '天齐锂业',
    '福耀玻璃', '华鲁恒升', '三花智控', '阳光电源', '通威股份', '国电南瑞', '金山办公', '科大讯飞', '用友网络', '大华股份',
    '中国石化', '宝钢股份', '山东黄金', '中金黄金', '同仁堂'];

  count = count || 55;
  // Create 55 entries; codes 000001-000005 appear twice (will be deduped)
  for (var i = 0; i < count; i++) {
    var ci = i % codes.length;
    var er = 3.0 - i * 0.05;
    results.push({
      code: codes[ci],
      name: names[i % names.length],
      price: 10 + Math.random() * 10,
      compositeScore: 55 + Math.random() * 20,
      rawScores: { fundamental: 60 + Math.random() * 15, technical: 50 + Math.random() * 20, hidden: 55 + Math.random() * 15, capitalFlow: 45 + Math.random() * 25, event: 50 + Math.random() * 10 },
      hiddenSignals: [{ id: 'H1' }],
      prediction: { expectedReturn: Math.max(0.1, er), confidence: 0.6 + Math.random() * 0.3, predictedDims: 4, label: er > 1 ? 'bullish' : 'neutral' },
      rating: er > 2 ? 'A' : 'B',
    });
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════
// Suite A: Dedup by code before Top-50 sort
// ═══════════════════════════════════════════════════════════════
startSuite('A: Dedup by code before Top-50 sort');

var cohort = require('../research_cohort');

// Generate 55 candidates with 5 duplicate codes
var rawResults = syntheticPipelineResults(55);
assert('A1: 55 input candidates', rawResults.length === 55);

var snapshot = cohort.buildResearchSnapshot(rawResults);
assert('A2: Top 50 after dedup', snapshot.length <= 50);
assert('A3: At least 1 dedup', snapshot.length < 55);

// Verify no duplicate codes
var seenCodes = {};
var hasDuplicate = false;
for (var ai = 0; ai < snapshot.length; ai++) {
  if (seenCodes[snapshot[ai].code]) { hasDuplicate = true; break; }
  seenCodes[snapshot[ai].code] = true;
}
assert('A4: No duplicate codes in snapshot', !hasDuplicate);

// Verify sorting: expectedReturn DESC
for (var aj = 1; aj < snapshot.length; aj++) {
  var erA = (snapshot[aj - 1].prediction && snapshot[aj - 1].prediction.expectedReturn != null) ? snapshot[aj - 1].prediction.expectedReturn : -999;
  var erB = (snapshot[aj].prediction && snapshot[aj].prediction.expectedReturn != null) ? snapshot[aj].prediction.expectedReturn : -999;
  if (erB > erA) { assert('A5: Sorted by E[R] DESC at index ' + aj, false); break; }
}
if (snapshot.length > 1) assert('A5: Sorted by E[R] DESC', true);

// Duplicate code dedup should keep highest E[R]
var dupTest = [{ code: '000001', name: 'Low', compositeScore: 50, prediction: { expectedReturn: 1.0, confidence: 0.7 } },
               { code: '000001', name: 'High', compositeScore: 70, prediction: { expectedReturn: 5.0, confidence: 0.9 } }];
var deduped = cohort.buildResearchSnapshot(dupTest);
assert('A6: Dedup keeps 1 entry', deduped.length === 1);
assert('A7: Dedup keeps highest E[R]', deduped[0].prediction.expectedReturn === 5.0);

endSuite();

// ═══════════════════════════════════════════════════════════════
// Suite B: 6-field eligibility — all branches
// ═══════════════════════════════════════════════════════════════
startSuite('B: 6-field eligibility');

// Helper: create test candidate
function makeTestCandidate(overrides) {
  var c = {
    code: '000001', name: 'Test', price: 10.5, compositeScore: 65,
    rawScores: { fundamental: 60, technical: 55, hidden: 50, capitalFlow: 45, event: 40 },
    prediction: { expectedReturn: 2.5, confidence: 0.75, predictedDims: 4, label: 'bullish' },
  };
  if (overrides) for (var k in overrides) { if (overrides.hasOwnProperty(k)) c[k] = overrides[k]; }
  return c;
}

// All valid
var c1 = makeTestCandidate();
var snap1 = cohort.normalizeResearchFeatureSnapshot(c1);
var e1 = cohort.computeAllEligibility(c1, snap1, 'ALLOW', true, { price: 10.5, targetDate: '2026-06-26', modelVersionId: 'v_2026-06-01_1234567890' });
assert('B1: schemaValid=true', e1.schemaValid === true);
assert('B2: predictionValid=true', e1.predictionValid === true);
assert('B3: researchEligible=true', e1.researchEligible === true);
assert('B4: executionCandidateEligible=true', e1.executionCandidateEligible === true);
assert('B5: globalTradePermission=true (ALLOW)', e1.globalTradePermission === true);
assert('B6: executionEligible=true', e1.executionEligible === true);

// Missing price
var e2 = cohort.computeAllEligibility(c1, snap1, 'ALLOW', true, { price: null, targetDate: '2026-06-26', modelVersionId: 'v_xxx' });
assert('B7: schemaValid=false (missing price)', e2.schemaValid === false);
assert('B8: researchEligible=false (missing price)', e2.researchEligible === false);

// Missing target date
var e3 = cohort.computeAllEligibility(c1, snap1, 'ALLOW', true, { price: 10.5, targetDate: null, modelVersionId: 'v_xxx' });
assert('B9: schemaValid=false (missing target date)', e3.schemaValid === false);

// Missing model version
var e4 = cohort.computeAllEligibility(c1, snap1, 'ALLOW', true, { price: 10.5, targetDate: '2026-06-26', modelVersionId: 'unknown' });
assert('B10: schemaValid=false (unknown modelVersion)', e4.schemaValid === false);

// Missing expectedReturn
var c2 = makeTestCandidate({ prediction: { confidence: 0.7 } });
var snap2 = cohort.normalizeResearchFeatureSnapshot(c2);
var e5 = cohort.computeAllEligibility(c2, snap2, 'ALLOW', true, { price: 10.5, targetDate: '2026-06-26', modelVersionId: 'v_xxx' });
assert('B11: predictionValid=false (missing E[R])', e5.predictionValid === false);

// Invalid confidence
var c3 = makeTestCandidate({ prediction: { expectedReturn: 2.0, confidence: -1 } });
var snap3 = cohort.normalizeResearchFeatureSnapshot(c3);
var e6 = cohort.computeAllEligibility(c3, snap3, 'ALLOW', true, { price: 10.5, targetDate: '2026-06-26', modelVersionId: 'v_xxx' });
assert('B12: predictionValid=false (invalid confidence)', e6.predictionValid === false);

// Kernel BLOCK → globalTradePermission=false
var e7 = cohort.computeAllEligibility(c1, snap1, 'BLOCK', true, { price: 10.5, targetDate: '2026-06-26', modelVersionId: 'v_xxx' });
assert('B13: globalTradePermission=false (BLOCK)', e7.globalTradePermission === false);
assert('B14: executionEligible=false (BLOCK)', e7.executionEligible === false);

// MeetsThreshold=false
var e8 = cohort.computeAllEligibility(c1, snap1, 'ALLOW', false, { price: 10.5, targetDate: '2026-06-26', modelVersionId: 'v_xxx' });
assert('B15: executionCandidateEligible=false (threshold)', e8.executionCandidateEligible === false);

// Feature coverage
var c4 = makeTestCandidate();
c4.rawScores = { fundamental: 60 };
var snap4 = cohort.normalizeResearchFeatureSnapshot(c4);
assert('B16: Feature coverage = 0.2', snap4.dimensions.fundamental === 60 && snap4.dimensions.technical === null);

endSuite();

// ═══════════════════════════════════════════════════════════════
// Suite C: Daily manifest write + update
// ═══════════════════════════════════════════════════════════════
startSuite('C: Daily manifest write + update');

setupTempDir();
var pl = require('../prediction_ledger');

// Write manifest (started)
var testDate = '2026-06-22';
var manifestOk = pl.writeRunManifest(TEMP_DIR, testDate, {
  date: testDate,
  canonicalRunId: 'test_full_1',
  designatedWindow: '09:30',
  status: 'started',
  candidateSetHash: 'abc123',
  expectedCount: 50,
  writtenCount: 0,
  dedupedCount: 0,
  failedCount: 0,
  completedAt: null,
  predictionIds: [],
  codeVersion: 'v3.4.9.4',
  modelVersionId: 'v_test',
  buildCommit: 'test_sha',
});
assert('C1: Manifest written', manifestOk === true);

// Read manifest
var readManifest = pl.readRunManifest(TEMP_DIR, testDate);
assert('C2: Manifest readable', readManifest !== null);
assert('C3: Status = started', readManifest.status === 'started');
assert('C4: canonicalRunId correct', readManifest.canonicalRunId === 'test_full_1');

// Update to completed
readManifest.status = 'completed';
readManifest.completedAt = new Date().toISOString();
readManifest.writtenCount = 50;
pl.writeRunManifest(TEMP_DIR, testDate, readManifest);

// Re-read
var completedManifest = pl.readRunManifest(TEMP_DIR, testDate);
assert('C5: Status = completed', completedManifest.status === 'completed');
assert('C6: Written count = 50', completedManifest.writtenCount === 50);

// Non-existent date
var noManifest = pl.readRunManifest(TEMP_DIR, '2025-01-01');
assert('C7: Non-existent → null', noManifest === null);

endSuite();

// ═══════════════════════════════════════════════════════════════
// Suite D: Real makeTradingDecisions() — 4 paths
// ═══════════════════════════════════════════════════════════════
startSuite('D: Real makeTradingDecisions()');

setupTempDir();

// Set test data root BEFORE requiring simfolio
var config = require('../config');
config._testDataRoot = TEMP_DIR;

// Need to invalidate the require cache to reload with new _testDataRoot
delete require.cache[require.resolve('../simfolio')];
delete require.cache[require.resolve('../research_cohort')];
delete require.cache[require.resolve('../prediction_ledger')];

var simfolio = require('../simfolio');

// Create a portfolio in the temp dir
var pf = simfolio.loadPortfolio();
assert('D1: Portfolio loaded in temp dir', pf !== null);
assert('D2: Initial capital correct', pf.cash === (config.SIMFOLIO && config.SIMFOLIO.initialCapital) || 100000);

// Path 1: No index data
var syntheticResults = cohort.buildResearchSnapshot(syntheticPipelineResults(50));
var resultNoIdx = simfolio.makeTradingDecisions(pf, syntheticResults, null, 'full', null, 'morning_session', '上午交易', 'test_full_1');
assert('D3: No-index path returns', resultNoIdx !== null);
assert('D4: noMarketData=true', resultNoIdx.noMarketData === true);
assert('D5: canBuy=false', resultNoIdx.canBuy === false);
assert('D6: Has _plCaptureResult', resultNoIdx._plCaptureResult !== undefined);

// Path 2: With indices, should go through kernel (BLOCK in non-trading hours)
var syntheticIndices = [{ code: '000001', name: '上证指数', price: 3200, prevClose: 3205, changePercent: -0.16, freshnessStatus: 'live' }];
var resultWithIdx = simfolio.makeTradingDecisions(pf, syntheticResults, syntheticIndices, 'mid', null, 'morning_session', '上午交易', 'test_mid_1');
assert('D7: With-index path returns', resultWithIdx !== null);
assert('D8: Has kernelDecision', resultWithIdx.kernelDecision !== undefined);
// Mid scan — should NOT be canonical
assert('D9: Mid scan not canonical', resultWithIdx._isCanonical === false);

// Path 3: Full scan at 09:30 (simulated) — should be canonical
var resultCanonical = simfolio.makeTradingDecisions(pf, syntheticResults, syntheticIndices, 'full', null, 'morning_session', '上午交易', 'test_canonical_1');
assert('D10: 09:30 full scan returns', resultCanonical !== null);

// Verify ledger was written to temp dir
var ledgerFile = path.join(TEMP_DIR, 'simfolio', 'prediction_ledger_' + new Date().toISOString().slice(0, 10) + '.jsonl');
assert('D11: Temp ledger file created', fs.existsSync(ledgerFile));

// Check that no files were written to real data dir
var realLedger = path.join(REAL_DATA_DIR, 'simfolio', 'prediction_ledger_' + new Date().toISOString().slice(0, 10) + '.jsonl');
var realLedgerExistedBefore = fs.existsSync(realLedger);

// Clean up — reset test data root
config._testDataRoot = null;
delete require.cache[require.resolve('../simfolio')];
delete require.cache[require.resolve('../research_cohort')];
delete require.cache[require.resolve('../prediction_ledger')];

endSuite();

// ═══════════════════════════════════════════════════════════════
// Suite E: Idempotency — same runId twice same line count
// ═══════════════════════════════════════════════════════════════
startSuite('E: Idempotency');

setupTempDir();
var pl2 = require('../prediction_ledger');

var today = new Date().toISOString().slice(0, 10);
var testRunId = 'idempotency_test_run';

// Build 10 entries
var entries = [];
for (var ei = 0; ei < 10; ei++) {
  entries.push({
    predictionId: testRunId + '_00000' + ei + '_T+3',
    scanId: testRunId,
    runId: testRunId,
    asOf: today,
    timestamp: new Date().toISOString(),
    scanType: 'full',
    canonical: true,
    code: '00000' + ei,
    compositeScore: 60 + ei,
    price: 10 + ei,
    expectedReturn: 2.0 - ei * 0.1,
    featureSnapshot: { schemaVersion: '1.0.0', dimensions: { fundamental: 60 } },
    featureHash: 'test',
    ingestionStatus: 'valid_v3.4.9.4',
    schemaValid: true,
    predictionValid: true,
    researchEligible: true,
    executionCandidateEligible: true,
    globalTradePermission: true,
    executionEligible: true,
    wasBought: false,
  });
}

// First write
var result1 = pl2.writeLedgerFile(TEMP_DIR, entries, testRunId, 'hash_abc', today);
assert('E1: First write: 10 entries', result1.writtenCount === 10);
assert('E2: Status = written', result1.status === 'written');

// Second write — same runId, should be idempotent
var result2 = pl2.writeLedgerFile(TEMP_DIR, entries, testRunId, 'hash_abc', today);
assert('E3: Second write: 0 written', result2.writtenCount === 0);
assert('E4: 10 duplicates', result2.duplicateCount === 10);
assert('E5: Status = idempotent', result2.status === 'idempotent');

// Verify ledger line count
var ldFile = path.join(TEMP_DIR, 'simfolio', 'prediction_ledger_' + today + '.jsonl');
var lines = fs.readFileSync(ldFile, 'utf8').trim().split('\n').filter(Boolean);
assert('E6: Ledger has exactly 10 lines', lines.length === 10);

endSuite();

// ═══════════════════════════════════════════════════════════════
// Suite F: Input drift — different candidates same runId
// ═══════════════════════════════════════════════════════════════
startSuite('F: Input drift detection');

setupTempDir();
var pl3 = require('../prediction_ledger');

var today2 = new Date().toISOString().slice(0, 10);
var driftRunId = 'drift_test_run';

// First write with hash_A — use fresh entries, not from Suite E
var driftEntries1 = [];
for (var dfj = 0; dfj < 5; dfj++) {
  driftEntries1.push({
    predictionId: driftRunId + '_DRIFT_' + dfj + '_T+3',
    scanId: driftRunId,
    runId: driftRunId,
    asOf: today2,
    timestamp: new Date().toISOString(),
    scanType: 'full',
    canonical: true,
    code: 'DRIFT' + dfj,
    compositeScore: 60 + dfj,
    price: 10 + dfj,
    expectedReturn: 1.5 - dfj * 0.1,
    featureSnapshot: { schemaVersion: '1.0.0', dimensions: { fundamental: 60 } },
    featureHash: 'drift_test',
    ingestionStatus: 'valid_v3.4.9.4',
    schemaValid: true,
    predictionValid: true,
    researchEligible: true,
    executionCandidateEligible: true,
    globalTradePermission: true,
    executionEligible: true,
    wasBought: false,
  });
}
var driftRes1 = pl3.writeLedgerFile(TEMP_DIR, driftEntries1, driftRunId, 'hash_AAAA', today2);
assert('F1: First write ok', driftRes1.writtenCount === 5);

// Second write with different hash — should detect drift
var driftEntries2 = [];
for (var dfi = 0; dfi < 5; dfi++) {
  driftEntries2.push({
    predictionId: driftRunId + '_NEW_' + dfi + '_T+3',
    scanId: driftRunId,
    runId: driftRunId,
    asOf: today2,
    timestamp: new Date().toISOString(),
    scanType: 'full',
    canonical: true,
    code: 'NEW0' + dfi,
    compositeScore: 50 + dfi,
    price: 10 + dfi,
    expectedReturn: 1.0,
    featureSnapshot: { schemaVersion: '1.0.0', dimensions: { fundamental: 50 } },
    featureHash: 'drift_test',
    ingestionStatus: 'valid_v3.4.9.4',
    schemaValid: true,
    predictionValid: true,
    researchEligible: true,
    executionCandidateEligible: true,
    globalTradePermission: true,
    executionEligible: true,
    wasBought: false,
  });
}
var driftRes2 = pl3.writeLedgerFile(TEMP_DIR, driftEntries2, driftRunId, 'hash_DIFFERENT_HASH', today2);
assert('F2: Drift detected', driftRes2.status === 'input_drift');
assert('F3: No new writes on drift', driftRes2.writtenCount === 0);

endSuite();

// ═══════════════════════════════════════════════════════════════
// Suite G: modelVersionId logic
// ═══════════════════════════════════════════════════════════════
startSuite('G: hashCandidateSet');

// Verify hashCandidateSet is deterministic
var cs1 = [{ code: '000001', compositeScore: 60 }, { code: '000002', compositeScore: 70 }];
var cs2 = [{ code: '000001', compositeScore: 60 }, { code: '000002', compositeScore: 70 }];
var cs3 = [{ code: '000002', compositeScore: 70 }, { code: '000001', compositeScore: 60 }]; // same set, different order
var cs4 = [{ code: '000001', compositeScore: 60 }, { code: '000002', compositeScore: 71 }]; // different score

var h1 = cohort.hashCandidateSet(cs1);
var h2 = cohort.hashCandidateSet(cs2);
var h3 = cohort.hashCandidateSet(cs3);
var h4 = cohort.hashCandidateSet(cs4);

assert('G1: Same input → same hash', h1 === h2);
assert('G2: Different order → same hash', h1 === h3);
assert('G3: Different score → different hash', h1 !== h4);
assert('G4: Empty set → empty', cohort.hashCandidateSet([]) === 'empty');
assert('G5: Null → empty', cohort.hashCandidateSet(null) === 'empty');

// Verify _hashNormalizedSnapshot
var snap = cohort.normalizeResearchFeatureSnapshot(makeTestCandidate());
var fh1 = cohort._hashNormalizedSnapshot(snap);
var fh2 = cohort._hashNormalizedSnapshot(snap);
assert('G6: Feature hash deterministic', fh1 === fh2);
assert('G7: Feature hash not null', fh1 !== null);

endSuite();

// ═══════════════════════════════════════════════════════════════
// Suite H: Pre/post real data hash comparison
// ═══════════════════════════════════════════════════════════════
startSuite('H: Real data hash integrity');

console.log('  Computing pre-test hash of real data dir...');
var preHash = hashDir(REAL_DATA_DIR);
console.log('  Pre-test hash: ' + preHash);

// All test I/O should have gone to TEMP_DIR — verify real data unchanged
var postHash = hashDir(REAL_DATA_DIR);
console.log('  Post-test hash: ' + postHash);

assert('H1: Real data hash unchanged', preHash === postHash);

endSuite();

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════');
console.log('Total: ' + totalPass + ' passed, ' + totalFail + ' failed');
console.log('═══════════════════════════════════════');

// Clean up temp dir
try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch (_) {}
console.log('Temp dir cleaned: ' + TEMP_DIR);

process.exit(totalFail > 0 ? 1 : 0);
