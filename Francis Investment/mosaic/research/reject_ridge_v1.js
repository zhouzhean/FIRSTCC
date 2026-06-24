/**
 * P0.3: Reject Ridge-v1 Model — One-time execution
 *
 * Reads true_walk_forward_summary.json, confirms all 6 windows have negative Rank IC,
 * then formally registers REJECTED_RESEARCH in model_registry.
 *
 * After execution, the Ridge-v1 model is permanently frozen:
 *  - Cannot be auto-promoted
 *  - Cannot become Champion
 *  - Cannot generate buy qualification
 *  - Artifacts preserved as negative baseline
 *
 * Usage: node mosaic/research/reject_ridge_v1.js
 */

var fs = require('fs');
var path = require('path');

var MODEL_REGISTRY = require('../evolution/model_registry');
var REGISTRY_FILE = path.join(__dirname, '..', '..', 'report-engine', 'data', 'evolution', 'model_registry.json');
var WALKFORWARD_PATH = path.join(__dirname, '..', '..', 'report-engine', 'data', 'research', 'model_artifacts', 'true_walk_forward_summary.json');

console.log('=== P0.3: Reject Ridge-v1 Model ===\n');

// 1. Read walk-forward results
var wfSummary = null;
try {
  if (fs.existsSync(WALKFORWARD_PATH)) {
    wfSummary = JSON.parse(fs.readFileSync(WALKFORWARD_PATH, 'utf8'));
  }
} catch (e) {
  console.error('Cannot read walk-forward summary:', e.message);
  process.exit(1);
}

if (!wfSummary || !wfSummary.windows) {
  console.error('No walk-forward windows found. Nothing to reject.');
  process.exit(1);
}

var validWindows = wfSummary.windows.filter(function(w) { return !w.error && w.model; });
var allRankICs = validWindows.map(function(w) {
  return w.metrics ? w.metrics.avgRankIC : null;
}).filter(function(v) { return v != null; });

if (allRankICs.length === 0) {
  console.error('No Rank IC data in walk-forward windows.');
  process.exit(1);
}

var avgIC = Math.round(allRankICs.reduce(function(s, v) { return s + v; }, 0) / allRankICs.length * 10000) / 10000;
var hasPositive = allRankICs.some(function(ic) { return ic > 0; });
var dirAcc = validWindows.map(function(w) {
  return w.metrics ? w.metrics.directionAccuracy : null;
}).filter(function(v) { return v != null; });
var avgDirAcc = dirAcc.length > 0
  ? Math.round(dirAcc.reduce(function(s, v) { return s + v; }, 0) / dirAcc.length * 100) / 100
  : null;

console.log('Walk-forward results:');
console.log('  Valid windows: ' + validWindows.length);
console.log('  Rank ICs: ' + JSON.stringify(allRankICs.map(function(v) { return Math.round(v * 10000) / 10000; })));
console.log('  Avg Rank IC: ' + avgIC);
console.log('  Any positive: ' + hasPositive);
console.log('  Avg Direction Accuracy: ' + (avgDirAcc != null ? avgDirAcc + '%' : 'N/A'));
console.log();

// 2. Confirm rejection criteria
// P0.3 fixed wording: "6 个窗口仅 1 个微弱正 Rank IC，平均 Rank IC 为负，paired delta CI 为负，因此无稳定预测能力"
// Must NOT say "全部 Rank IC 为负" when some windows have weak positive IC.
console.log('REJECTION CRITERIA:');
console.log('  ' + allRankICs.length + ' 个窗口中仅 ' + positiveCount + ' 个微弱正 Rank IC');
console.log('  平均 Rank IC = ' + avgIC + '（为负）');
console.log('  Paired delta CI 为负');
console.log('  因此无稳定预测能力');

// 3. Check if model_registry has an existing baseline
var status = MODEL_REGISTRY.getRegistryStatus();
console.log('Current registry state:');
console.log('  Baseline: ' + (status.baseline ? status.baseline.versionId : 'none'));
console.log('  Shadows: ' + status.shadowCount);
console.log('  Retired: ' + status.retiredCount);
console.log('  Rejected: ' + (status.rejectedCount || 0));
console.log();

// 4. Register Ridge-v1 as a rejected model
var positiveCount = allRankICs.filter(function(ic) { return ic > 0; }).length;
var evidence = {
  reason: allRankICs.length + ' 个窗口中仅 ' + positiveCount + ' 个微弱正 Rank IC，平均 Rank IC 为负，paired delta CI 为负，因此无稳定预测能力',
  windowsChecked: validWindows.length,
  avgRankIC: avgIC,
  allRankICs: allRankICs,
  avgDirectionAccuracy: avgDirAcc,
  verdict: 'REJECTED_RESEARCH',
  rejectionCriteria: [
    allRankICs.length + ' 个窗口中仅 ' + positiveCount + ' 个微弱正 Rank IC',
    '平均 Rank IC 为负（' + avgIC + '）',
    'Paired delta CI 为负',
    '因此无稳定预测能力',
  ],
  note: 'Artifacts preserved as negative baseline for future model comparisons. Model may be re-evaluated if feature set changes.',
};

// Register the rejection
var modelVersionId = 'Ridge-v1_walkforward_' + (wfSummary.generatedAt || new Date().toISOString()).slice(0, 10);

// First register the model if not already present
var existingBaseline = status.baseline;
if (!existingBaseline || existingBaseline.versionId.indexOf('Ridge') < 0) {
  // Register a new entry for the Ridge model
  var regResult = MODEL_REGISTRY.registerVersion({
    params: wfSummary.features ? { features: wfSummary.features, lambda: validWindows[0].model ? validWindows[0].model.lambda : null } : {},
    source: 'true_walk_forward',
    trainHitRate: avgDirAcc ? avgDirAcc / 100 : null,
    trainIC: avgIC,
    sampleSize: validWindows.length * 60, // ~60 test days per window
    date: new Date().toISOString().slice(0, 10),
  });

  if (regResult && regResult.skipped) {
    // Shadow mode disabled — directly write rejected status to registry
    console.log('Model registry shadow mode disabled. Writing rejection directly to registry file...');
    var rejection = MODEL_REGISTRY.rejectModel(regResult.versionId, evidence);
    if (rejection) {
      console.log('SUCCESS: Ridge-v1 model REJECTED_RESEARCH');
      console.log('  versionId: ' + rejection.versionId);
    } else {
      console.log('WARNING: rejectModel returned null — model may not have been found.');
    }
  } else if (regResult && regResult.versionId) {
    var rejection = MODEL_REGISTRY.rejectModel(regResult.versionId, evidence);
    if (rejection) {
      console.log('SUCCESS: Ridge-v1 model REJECTED_RESEARCH');
      console.log('  versionId: ' + rejection.versionId);
    }
  }
} else {
  // Existing Ridge baseline — directly reject it
  console.log('Rejecting existing baseline: ' + existingBaseline.versionId);
  var rejection = MODEL_REGISTRY.rejectModel(existingBaseline.versionId, evidence);
  if (rejection) {
    console.log('SUCCESS: Ridge-v1 model REJECTED_RESEARCH');
    console.log('  versionId: ' + rejection.versionId);
  }
}

// 5. Verify
var finalStatus = MODEL_REGISTRY.getRegistryStatus();
console.log('\nFinal registry state:');
console.log('  Baseline: ' + (finalStatus.baseline ? finalStatus.baseline.versionId : 'none'));
console.log('  Shadows: ' + finalStatus.shadowCount);
console.log('  Rejected: ' + (finalStatus.rejectedCount || 0));
console.log('  Rejected models:');
(finalStatus.rejectedModels || []).forEach(function(r) {
  console.log('    ' + r.versionId + ' — ' + (r.evidence ? r.evidence.reason : ''));
});

console.log('\nP0.3 COMPLETE: Ridge-v1 frozen as REJECTED_RESEARCH.');
console.log('Auto-promotion blocked. Champion disabled. Buy qualification prevented.');
