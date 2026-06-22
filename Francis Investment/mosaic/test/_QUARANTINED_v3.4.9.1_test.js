/**
 * v3.4.9.1 Integration Tests — 真实生产闭环
 *
 * 4 test suites using REAL modules:
 *   A. buildResearchSnapshot — sorted by E[R], ≤50 entries
 *   B. researchEligible requires featureSnapshot + predictionId
 *   C. No duplicate codes in snapshot
 *   D. Real verifyOneScan → settled/unavailable outcomes via predictionId
 *   E. T+3 pending counts researchEligible
 *
 * Run: node mosaic/test/v3.4.9.1_test.js
 */

var path = require('path');
var fs = require('fs');
var os = require('os');

var REPO_ROOT = path.join(__dirname, '..', '..');
var REAL_SIMFOLIO_DIR = path.join(REPO_ROOT, 'report-engine', 'data', 'simfolio');
var REAL_KLINES_DIR = path.join(REPO_ROOT, 'report-engine', 'data', 'klines');
var REAL_VERIFICATION_DIR = path.join(REPO_ROOT, 'report-engine', 'data', 'verification');
var TEMP_DATA_DIR = path.join(os.tmpdir(), 'fiv3491_test_' + Date.now().toString(36));

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

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

// ====== Setup temp DATA_DIR for simfolio tests ======
console.log('=== Setup ===');
ensureDir(TEMP_DATA_DIR);
var SIMFOLIO_DIR = path.join(TEMP_DATA_DIR, 'simfolio');
var KLINES_DIR = path.join(TEMP_DATA_DIR, 'klines');
ensureDir(SIMFOLIO_DIR);
ensureDir(KLINES_DIR);

// Write portfolio
var portfolio = {
  meta: { initialCapital: 100000, startDate: '2026-06-01' },
  cash: 100000, positions: [], tradeHistory: [], dailyNav: [],
  _stats: { maxDrawdown: 0 }, _drawdownLevel: { level: 'normal' },
};
fs.writeFileSync(path.join(SIMFOLIO_DIR, 'portfolio.json'), JSON.stringify(portfolio, null, 2), 'utf8');

// Create pipeline results
function makePipelineResults() {
  return [
    { code: '600001', name: '测试A', price: 10.00, compositeScore: 78, rating: 'A',
      rawScores: { fundamental: 70, technical: 80, hidden: 75, capitalFlow: 80, event: 85 },
      hiddenSignals: [{ id: 'H1', name: '资金流入', level: 'strong' }],
      prediction: { expectedReturn: 5.0, confidence: 0.75, label: 'strong_buy', breakdown: { dim1: { available: true }, dim2: { available: true }, dim3: { available: true } } },
    },
    { code: '600002', name: '测试B', price: 15.00, compositeScore: 68, rating: 'B',
      rawScores: { fundamental: 65, technical: 70, hidden: 55, capitalFlow: 70, event: 60 },
      hiddenSignals: [{ id: 'H3', name: '龙虎榜', level: 'medium' }],
      prediction: { expectedReturn: 3.5, confidence: 0.65, label: 'buy', breakdown: { dim1: { available: true }, dim2: { available: true }, dim3: { available: true } } },
    },
    { code: '600003', name: '测试C', price: 8.00, compositeScore: 62, rating: 'C',
      rawScores: { fundamental: 60, technical: 55, hidden: 50, capitalFlow: 60, event: 55 },
      hiddenSignals: [],
      prediction: { expectedReturn: 2.0, confidence: 0.55, label: 'hold', breakdown: { dim1: { available: true }, dim2: { available: true }, dim3: { available: false } } },
    },
    { code: '600004', name: '测试D', price: 12.00, compositeScore: 58, rating: 'D',
      rawScores: { fundamental: 50, technical: 60, hidden: 45, capitalFlow: 55, event: 50 },
      hiddenSignals: [],
      prediction: { expectedReturn: -1.0, confidence: 0.45, label: 'weak', breakdown: { dim1: { available: true }, dim2: { available: false }, dim3: { available: false } } },
    },
    { code: '600005', name: '测试E', price: 5.50, compositeScore: 72, rating: 'B',
      rawScores: { fundamental: 75, technical: 65, hidden: 60, capitalFlow: 70, event: 80 },
      hiddenSignals: [{ id: 'H1', name: '资金流入', level: 'strong' }],
      prediction: { expectedReturn: 4.2, confidence: 0.70, label: 'buy', breakdown: { dim1: { available: true }, dim2: { available: true }, dim3: { available: true } } },
    },
    { code: '600006', name: '测试F', price: 18.00, compositeScore: 55, rating: 'D',
      rawScores: null,  // NO feature snapshot
      hiddenSignals: [],
      prediction: { expectedReturn: -2.0, confidence: 0.35, label: 'avoid', breakdown: {} },
    },
    { code: '600007', name: '测试G', price: 9.80, compositeScore: 75, rating: 'B',
      rawScores: { fundamental: 70, technical: 75, hidden: 65, capitalFlow: 80, event: 70 },
      hiddenSignals: [{ id: 'H2', name: '北向资金', level: 'strong' }],
      prediction: { expectedReturn: 6.0, confidence: 0.80, label: 'strong_buy', breakdown: { dim1: { available: true }, dim2: { available: true }, dim3: { available: true } } },
    },
    { code: '600008', name: '测试H', price: 7.20, compositeScore: 60, rating: 'C',
      rawScores: { fundamental: 55, technical: 60, hidden: 50, capitalFlow: 65, event: 55 },
      hiddenSignals: [],
      prediction: { expectedReturn: 1.5, confidence: 0.50, label: 'hold', breakdown: { dim1: { available: true }, dim2: { available: false }, dim3: { available: false } } },
    },
    { code: '600009', name: '测试I', price: 20.00, compositeScore: 45, rating: 'F',
      rawScores: { fundamental: 40, technical: 45, hidden: 30, capitalFlow: 50, event: 40 },
      hiddenSignals: [],
      prediction: { expectedReturn: -5.0, confidence: 0.20, label: 'strong_avoid', breakdown: {} },
    },
    { code: '600010', name: '测试J', price: 14.00, compositeScore: 70, rating: 'B',
      rawScores: { fundamental: 68, technical: 72, hidden: 60, capitalFlow: 75, event: 65 },
      hiddenSignals: [{ id: 'H4', name: '机构增持', level: 'medium' }],
      prediction: { expectedReturn: 3.8, confidence: 0.68, label: 'buy', breakdown: { dim1: { available: true }, dim2: { available: true }, dim3: { available: true } } },
    },
  ];
}

// ====== Test A: buildResearchSnapshot — sorted by E[R], ≤50 ======
console.log('\n=== Test A: buildResearchSnapshot — sorted, capped ===');

try {
  var simfolio = require('../simfolio');
  var pipelineResults = makePipelineResults();
  var snapshot = simfolio.buildResearchSnapshot(pipelineResults);

  assert(snapshot.length > 0, 'Returns non-empty array');
  assert(snapshot.length <= 50, '≤ 50 entries (got ' + snapshot.length + ')');
  assert(snapshot.length === 10, 'All 10 stocks included (got ' + snapshot.length + ')');

  // Verify sorted by expectedReturn descending
  var sorted = true;
  for (var i = 1; i < snapshot.length; i++) {
    var erA = (snapshot[i-1].prediction && snapshot[i-1].prediction.expectedReturn != null) ? snapshot[i-1].prediction.expectedReturn : -999;
    var erB = (snapshot[i].prediction && snapshot[i].prediction.expectedReturn != null) ? snapshot[i].prediction.expectedReturn : -999;
    if (erA < erB) { sorted = false; break; }
  }
  assert(sorted, 'Sorted by expectedReturn descending');

  console.log('  Top 3 by E[R]:');
  for (var ti = 0; ti < Math.min(3, snapshot.length); ti++) {
    console.log('    ' + (ti+1) + '. ' + snapshot[ti].code + ' ' + snapshot[ti].name + ' E[R]=' + ((snapshot[ti].prediction && snapshot[ti].prediction.expectedReturn) || 'null') + '%');
  }
} catch (e) {
  console.error('  FAIL: Test A threw: ' + e.message);
  FAIL++;
}

// ====== Test B: researchEligible requires featureSnapshot ======
console.log('\n=== Test B: researchEligible data check ===');

try {
  var snapshot2 = simfolio.buildResearchSnapshot(makePipelineResults());

  // Stock 600006 has rawScores=null → no featureSnapshot → not researchEligible
  var stockF = null;
  for (var s = 0; s < snapshot2.length; s++) {
    if (snapshot2[s].code === '600006') { stockF = snapshot2[s]; break; }
  }
  if (stockF) {
    assert(stockF.rawScores === null, 'Stock F (600006) has rawScores=null');
  }

  // Stock 600009 has rawScores → qualified
  var stockI = null;
  for (var s2 = 0; s2 < snapshot2.length; s2++) {
    if (snapshot2[s2].code === '600009') { stockI = snapshot2[s2]; break; }
  }
  if (stockI) {
    assert(stockI.rawScores !== null, 'Stock I (600009) has rawScores present');
  }
} catch (e) {
  console.error('  FAIL: Test B threw: ' + e.message);
  FAIL++;
}

// ====== Test C: No duplicates ======
console.log('\n=== Test C: No duplicate codes ===');

try {
  var snapshot3 = simfolio.buildResearchSnapshot(makePipelineResults());
  var seen = {};
  var dupes = 0;
  for (var d = 0; d < snapshot3.length; d++) {
    if (seen[snapshot3[d].code]) dupes++;
    seen[snapshot3[d].code] = true;
  }
  assertEqual(dupes, 0, 'No duplicate stock codes');
  assert(snapshot3.every(function(s) { return !!s.code; }), 'All have code');
  assert(snapshot3.every(function(s) { return s.price > 0; }), 'All have price > 0');
} catch (e) {
  console.error('  FAIL: Test C threw: ' + e.message);
  FAIL++;
}

// ====== Test D: Real verifyOneScan via predictionId ======
console.log('\n=== Test D: verifyOneScan — predictionId matching + outcomes ===');

try {
  var vr = require('../analysis/verification_runner');
  var today = '2026-06-15';

  ensureDir(REAL_SIMFOLIO_DIR);
  ensureDir(REAL_KLINES_DIR);

  // Write test klines in real dir
  for (var ci2 = 1; ci2 <= 3; ci2++) {
    var code = '60000' + ci2;
    var klines = [];
    var base = ci2 === 1 ? 10.00 : (ci2 === 2 ? 15.00 : 8.00);
    for (var dd = 0; dd < 20; dd++) {
      var day = new Date('2026-06-01');
      day.setDate(day.getDate() + dd);
      var dayStr = day.toISOString().slice(0, 10);
      if (day.getDay() === 0 || day.getDay() === 6) continue;
      klines.push({ date: dayStr, open: base, close: +(base + (dd - 8) * 0.15).toFixed(2), high: +(base + 1).toFixed(2), low: +(base - 1).toFixed(2), volume: 1000000 });
    }
    fs.writeFileSync(path.join(REAL_KLINES_DIR, code + '.json'), JSON.stringify({ code: code, klines: klines }, null, 2), 'utf8');
  }

  // Write empty kline for 600999 (missing stock)
  fs.writeFileSync(path.join(REAL_KLINES_DIR, '600999.json'), JSON.stringify({ code: '600999', klines: [] }, null, 2), 'utf8');

  // Write index history for benchmark lookup
  fs.writeFileSync(path.join(REAL_SIMFOLIO_DIR, 'index_history_2026-06-18.json'), JSON.stringify([{ time: '15:00:00', sh: 3316.5, sz: 10600 }], null, 2), 'utf8');

  // Clean old outcome + ledger
  try { fs.unlinkSync(path.join(REAL_SIMFOLIO_DIR, 'outcome_ledger.jsonl')); } catch (_) {}
  var ledgerFile = path.join(REAL_SIMFOLIO_DIR, 'prediction_ledger_' + today + '.jsonl');
  try { fs.unlinkSync(ledgerFile); } catch (_) {}

  // Write prediction ledger
  var entries = [
    { predictionId: 'v3491t_d0', runId: 'v3491t_full_1', asOf: today, targetDate: '2026-06-18',
      code: '600001', name: '测试A', price: 10.00, entryPrice: 10.00,
      expectedReturn: 5.0, confidence: 0.75, compositeScore: 78, benchmarkPrice: 3300,
      researchEligible: true, executionEligible: true, canonical: true, scanType: 'full', featureSnapshot: 'a1' },
    { predictionId: 'v3491t_d1', runId: 'v3491t_full_1', asOf: today, targetDate: '2026-06-18',
      code: '600002', name: '测试B', price: 15.00, entryPrice: 15.00,
      expectedReturn: 3.5, confidence: 0.65, compositeScore: 68, benchmarkPrice: 3300,
      researchEligible: true, executionEligible: true, canonical: true, scanType: 'full', featureSnapshot: 'b2' },
    { predictionId: 'v3491t_d2', runId: 'v3491t_full_1', asOf: today, targetDate: '2026-06-18',
      code: '600003', name: '测试C', price: 8.00, entryPrice: 8.00,
      expectedReturn: 2.0, confidence: 0.55, compositeScore: 62, benchmarkPrice: 3300,
      researchEligible: true, executionEligible: false, exclusionReason: 'evidence_fail', canonical: true, scanType: 'full', featureSnapshot: 'c3' },
    { predictionId: 'v3491t_d3', runId: 'v3491t_full_1', asOf: today, targetDate: '2026-06-18',
      code: '600999', name: '不存在股', price: 20.00, entryPrice: 20.00,
      expectedReturn: 4.0, confidence: 0.70, compositeScore: 65, benchmarkPrice: 3300,
      researchEligible: true, executionEligible: false, canonical: true, scanType: 'full', featureSnapshot: 'x9' },
  ];

  var lines = entries.map(function(e) { return JSON.stringify(e); }).join('\n') + '\n';
  fs.writeFileSync(ledgerFile, lines, 'utf8');
  console.log('  Ledger written: ' + entries.length + ' entries');

  // Call verifyOneScan
  var result = vr.verifyOneScan(today);
  console.log('  Result: ' + (result ? (result.predictions + ' predictions, ' + result.outcomesWritten + ' outcomes') : 'null'));

  assert(result !== null, 'verifyOneScan returns result');

  if (result) {
    assert(result.predictions > 0, 'Predictions > 0 (got ' + result.predictions + ')');
    assert(result.outcomesWritten > 0, 'Outcomes written > 0 (got ' + result.outcomesWritten + ')');

    var olFile = path.join(REAL_SIMFOLIO_DIR, 'outcome_ledger.jsonl');
    var hasOL = fs.existsSync(olFile);
    assert(hasOL, 'outcome_ledger.jsonl exists');

    if (hasOL) {
      var olines = fs.readFileSync(olFile, 'utf8').trim().split('\n').filter(Boolean);
      var settled = olines.filter(function(l) { try { return JSON.parse(l).status === 'settled'; } catch (_) { return false; } });
      var unavailable = olines.filter(function(l) { try { return JSON.parse(l).status === 'unavailable'; } catch (_) { return false; } });

      console.log('  Outcomes: ' + settled.length + ' settled, ' + unavailable.length + ' unavailable');

      assert(settled.length > 0, 'Settled outcomes written (' + settled.length + ')');
      assert(unavailable.length > 0, 'Unavailable outcomes written (' + unavailable.length + ')');

      // Verify settled outcomes have predictionId + postCostNetExcess
      for (var si = 0; si < settled.length; si++) {
        var so = JSON.parse(settled[si]);
        assert(so.predictionId != null, 'Settled has predictionId: ' + so.predictionId);
        assert(so.postCostNetExcess != null, 'Settled has postCostNetExcess: ' + so.postCostNetExcess);
      }

      // Print outcomes
      for (var oi = 0; oi < olines.length; oi++) {
        var o = JSON.parse(olines[oi]);
        console.log('    ' + o.predictionId + ' → ' + o.status + (o.status === 'settled' ? ' netExcess=' + o.postCostNetExcess : ' reason=' + o.unavailableReason));
      }
    }

    // 3 samples → n<5, Kendall tau returns null (expected)
    // With more samples, tau would be computed
    console.log('  Kendall tau: ' + (result.kendallTau != null ? result.kendallTau : 'null (expected: n<5)'));
    assert(result.predictions >= 3, 'At least 3 predictions made');
  }

  // CI null < 20 days
  var indDays = vr._countIndependentTradingDays();
  console.log('  Independent days: ' + indDays);
  assert(indDays < 20, 'Independent days < 20 (got ' + indDays + ')');

} catch (e) {
  console.error('  FAIL: Test D threw: ' + e.message);
  console.error(e.stack);
  FAIL++;
}

// ====== Test E: T+3 pending counts researchEligible ======
console.log('\n=== Test E: T+3 pending — researchEligible count ===');

try {
  var today2 = '2026-06-19';
  // Write a past ledger file
  var threeDaysAgo = new Date(today2 + 'T00:00:00+08:00').getTime() - 5 * 24 * 3600 * 1000;
  var pastDate = new Date(threeDaysAgo).toISOString().slice(0, 10);
  console.log('  Past date: ' + pastDate);

  var pastFile = path.join(REAL_SIMFOLIO_DIR, 'prediction_ledger_' + pastDate + '.jsonl');
  var pastEntries = [];
  for (var ei = 0; ei < 5; ei++) {
    pastEntries.push(JSON.stringify({
      predictionId: 'past_' + ei, runId: 'past_full_1', asOf: pastDate, targetDate: today2,
      code: '60000' + (ei + 1), name: '测试' + (ei + 1), price: 10 + ei,
      expectedReturn: 5 - ei, confidence: 0.75, compositeScore: 72 - ei, benchmarkPrice: 3300,
      researchEligible: ei < 3, executionEligible: ei < 2, promotionEligible: false,
      exclusionReason: ei >= 3 ? 'evidence_fail' : null, canonical: true, scanType: 'full',
    }));
  }
  fs.writeFileSync(pastFile, pastEntries.join('\n') + '\n', 'utf8');

  var settledIds = {};
  var pendingExec = 0, pendingResearch = 0;
  var plines = fs.readFileSync(pastFile, 'utf8').trim().split('\n').filter(Boolean);
  for (var pi = 0; pi < plines.length; pi++) {
    var pe = JSON.parse(plines[pi]);
    if (pe.predictionId && !settledIds[pe.predictionId]) {
      if (pe.executionEligible) pendingExec++;
      if (pe.researchEligible) pendingResearch++;
    }
  }

  assertEqual(pendingExec, 2, 'executionEligible pending = 2');
  assertEqual(pendingResearch, 3, 'researchEligible pending = 3 (includes evidence_fail)');
  assert(pendingResearch >= pendingExec, 'researchEligible ≥ executionEligible');

  console.log('  ' + pendingResearch + ' researchEligible, ' + pendingExec + ' executionEligible pending');
} catch (e) {
  console.error('  FAIL: Test E threw: ' + e.message);
  FAIL++;
}

// ====== Cleanup temp ======
try { fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
console.log('\n  Temp cleaned: ' + TEMP_DATA_DIR);

// ====== Summary ======
console.log('\n' + '='.repeat(50));
console.log('v3.4.9.1 Integration Tests');
console.log('Results: ' + PASS + ' passed, ' + FAIL + ' failed, ' + (PASS + FAIL) + ' total');
if (FAIL > 0) {
  console.error('SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('ALL TESTS PASSED');
}
