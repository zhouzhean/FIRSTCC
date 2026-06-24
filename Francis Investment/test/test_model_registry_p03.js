/**
 * P0.3 Regression Test — Model Registry: rejectedModels[] persistence,
 * idempotent rejection, promotion blocking, rejectedModels count.
 *
 * Tests:
 *   1. rejectModel() writes to rejectedModels[] and persists to disk
 *   2. Restart persistence: rejectedModels[] survives process restart (simulated)
 *   3. rejectModel() is idempotent — duplicate call does NOT duplicate demotionLog
 *   4. promoteToBaseline() blocked for rejected model
 *   5. getRejectedModels() / hasRejectedModel() read from rejectedModels[]
 *   6. getRegistryStatus() includes rejectedCount and rejectedModels
 *
 * Usage: node test_model_registry_p03.js
 */

var fs = require('fs');
var path = require('path');

var DATA_DIR = path.join(__dirname, '..', 'report-engine', 'data', 'evolution');
var REGISTRY_FILE = path.join(DATA_DIR, 'model_registry.json');
var REJECTED_FILE = path.join(DATA_DIR, 'rejected_models.json');
var DEMOTION_FILE = path.join(DATA_DIR, 'demotion_log.json');

var PASSED = 0;
var FAILED = 0;

function pass(name) { PASSED++; console.log('  PASS: ' + name); }
function fail(name, msg) { FAILED++; console.log('  FAIL: ' + name + ' — ' + msg); }

// Clean up test files before running
function cleanTestFiles() {
  try { if (fs.existsSync(REGISTRY_FILE)) fs.unlinkSync(REGISTRY_FILE); } catch (_) {}
  try { if (fs.existsSync(REJECTED_FILE)) fs.unlinkSync(REJECTED_FILE); } catch (_) {}
  try { if (fs.existsSync(DEMOTION_FILE)) fs.unlinkSync(DEMOTION_FILE); } catch (_) {}
}

console.log('=== P0.3 Model Registry Regression Test ===\n');

// Disable SHADOW_MODE.enabled check by pre-setting config
// Model registry reads from config.SHADOW_MODE on require — we need to mock.
// Strategy: Write a temporary config override OR directly test the module functions.

// Actually, the registry init runs at require() time. We need to ensure
// SHADOW_MODE.enabled = true for registerVersion to work.
// Let's temporarily mutate the config after require.

var config = require('../mosaic/config');
var origEnabled = config.SHADOW_MODE ? config.SHADOW_MODE.enabled : false;

// Force-enable shadow mode for tests
if (!config.SHADOW_MODE) config.SHADOW_MODE = {};
config.SHADOW_MODE.enabled = true;
if (!config.MODEL_REGISTRY) config.MODEL_REGISTRY = {};
config.MODEL_REGISTRY.maxVersions = 20;

cleanTestFiles();

// Now require — it will re-init but use the already-loaded config (cached require)
var MODEL_REGISTRY;

try {
  MODEL_REGISTRY = require('../mosaic/evolution/model_registry');
} catch (e) {
  console.error('Cannot load model_registry:', e.message);
  // If it already ran init with old config, the require cache may cause issues.
  // Try clearing cache and re-requiring:
  delete require.cache[require.resolve('../mosaic/evolution/model_registry')];
  delete require.cache[require.resolve('../mosaic/config')];
  config = require('../mosaic/config');
  if (!config.SHADOW_MODE) config.SHADOW_MODE = {};
  config.SHADOW_MODE.enabled = true;
  if (!config.MODEL_REGISTRY) config.MODEL_REGISTRY = {};
  config.MODEL_REGISTRY.maxVersions = 20;
  MODEL_REGISTRY = require('../mosaic/evolution/model_registry');
}

console.log('Module loaded. Running tests...\n');

// ── Test 1: Register a model, then reject it ──
console.log('--- Test Group 1: Basic Rejection Flow ---');

var regResult = MODEL_REGISTRY.registerVersion({
  params: { lambda: 0.1, features: ['H1', 'H2'] },
  source: 'test',
  trainHitRate: 0.45,
  trainIC: -0.03,
  sampleSize: 300,
  date: '2026-06-24',
});

if (regResult && regResult.versionId && !regResult.skipped) {
  pass('registerVersion returns versionId: ' + regResult.versionId.slice(0, 12) + '...');

  var evidence = {
    reason: '6 个窗口中仅 1 个微弱正 Rank IC，平均 Rank IC 为负，paired delta CI 为负，因此无稳定预测能力',
    windowsChecked: 6,
    avgRankIC: -0.021,
    allRankICs: [-0.03, -0.01, 0.002, -0.04, -0.02, -0.025],
    verdict: 'REJECTED_RESEARCH',
  };

  var rejection = MODEL_REGISTRY.rejectModel(regResult.versionId, evidence);

  if (rejection && rejection.status === 'REJECTED_RESEARCH') {
    pass('rejectModel returns REJECTED_RESEARCH');
  } else {
    fail('rejectModel', 'did not return REJECTED_RESEARCH: ' + JSON.stringify(rejection));
  }

  // Check rejectedModels[] is populated
  var rejectedList = MODEL_REGISTRY.getRejectedModels();
  if (rejectedList.length === 1 && rejectedList[0].versionId === regResult.versionId) {
    pass('getRejectedModels() returns 1 rejected model');
  } else {
    fail('getRejectedModels()', 'expected 1, got ' + rejectedList.length);
  }

  // Check hasRejectedModel
  if (MODEL_REGISTRY.hasRejectedModel()) {
    pass('hasRejectedModel() returns true');
  } else {
    fail('hasRejectedModel()', 'expected true, got false');
  }

  // Check rejectedModels persisted to disk (rejected_models.json)
  if (fs.existsSync(REJECTED_FILE)) {
    var persistedRej = JSON.parse(fs.readFileSync(REJECTED_FILE, 'utf8'));
    if (persistedRej.length === 1 && persistedRej[0].versionId === regResult.versionId) {
      pass('rejected_models.json persisted to disk (1 entry)');
    } else {
      fail('rejected_models.json', 'wrong content: ' + JSON.stringify(persistedRej));
    }
  } else {
    fail('rejected_models.json', 'file not found');
  }

} else {
  fail('registerVersion', 'skipped or failed — shadow_mode may be disabled: ' + JSON.stringify(regResult));
}

// ── Test 2: Idempotency — rejectModel twice should NOT duplicate demotionLog ──
console.log('\n--- Test Group 2: Idempotent Rejection ---');

var regResult2 = MODEL_REGISTRY.registerVersion({
  params: { lambda: 0.5 },
  source: 'test',
  trainHitRate: 0.50,
  trainIC: -0.01,
  sampleSize: 200,
  date: '2026-06-24',
});

if (regResult2 && regResult2.versionId && !regResult2.skipped) {
  // First rejection
  var r1 = MODEL_REGISTRY.rejectModel(regResult2.versionId, {
    reason: 'test idempotency',
    windowsChecked: 3,
    avgRankIC: -0.05,
    allRankICs: [-0.05, -0.04, -0.06],
  });

  // Count demotionLog entries
  var status1 = MODEL_REGISTRY.getRegistryStatus();
  // We can't directly read demotionLog length from getRegistryStatus,
  // so read the file
  var demotionBefore = 0;
  if (fs.existsSync(DEMOTION_FILE)) {
    demotionBefore = JSON.parse(fs.readFileSync(DEMOTION_FILE, 'utf8')).length;
  }

  // Second rejection — same versionId, should be idempotent
  var r2 = MODEL_REGISTRY.rejectModel(regResult2.versionId, {
    reason: 'test idempotency — second call',
    windowsChecked: 3,
    avgRankIC: -0.05,
    allRankICs: [-0.05, -0.04, -0.06],
  });

  var demotionAfter = 0;
  if (fs.existsSync(DEMOTION_FILE)) {
    demotionAfter = JSON.parse(fs.readFileSync(DEMOTION_FILE, 'utf8')).length;
  }

  if (r2 && r2.versionId === regResult2.versionId) {
    pass('idempotent: second rejectModel() returns same versionId');
  } else {
    fail('idempotent', 'second call returned: ' + JSON.stringify(r2));
  }

  // Demotion log should NOT have grown (second call was idempotent)
  if (demotionAfter === demotionBefore && demotionBefore > 0) {
    pass('idempotent: demotionLog did NOT grow (demotionBefore=' + demotionBefore + ', demotionAfter=' + demotionAfter + ')');
  } else {
    fail('idempotent', 'demotionLog grew: before=' + demotionBefore + ', after=' + demotionAfter);
  }

  // rejectedModels[] should still have only unique entries for this versionId
  var rejList = MODEL_REGISTRY.getRejectedModels();
  var countForVid = rejList.filter(function(r) { return r.versionId === regResult2.versionId; }).length;
  if (countForVid === 1) {
    pass('idempotent: only one rejectedModels[] entry for this versionId');
  } else {
    fail('idempotent', 'expected 1 entry, got ' + countForVid);
  }
} else {
  fail('registerVersion (test 2)', 'could not register: ' + JSON.stringify(regResult2));
}

// ── Test 3: Promotion blocked for rejected model ──
console.log('\n--- Test Group 3: No-Promotion for Rejected ---');

var regResult3 = MODEL_REGISTRY.registerVersion({
  params: { lambda: 0.01 },
  source: 'test',
  trainHitRate: 0.55,
  trainIC: 0.05,
  sampleSize: 500,
  date: '2026-06-24',
});

if (regResult3 && regResult3.versionId && !regResult3.skipped) {
  // Reject it
  MODEL_REGISTRY.rejectModel(regResult3.versionId, {
    reason: '6 个窗口中仅 1 个微弱正 Rank IC，平均 Rank IC 为负，paired delta CI 为负，因此无稳定预测能力',
    windowsChecked: 6,
    avgRankIC: -0.03,
    allRankICs: [-0.04, 0.001, -0.03, -0.05, -0.02, -0.01],
  });

  // Attempt promotion — must be blocked
  var promoResult = MODEL_REGISTRY.promoteToBaseline(regResult3.versionId, 'test forced promotion');
  if (promoResult === null) {
    pass('no-promotion: promoteToBaseline returns null for REJECTED model');
  } else {
    fail('no-promotion', 'promoteToBaseline should have returned null but got: ' + JSON.stringify(promoResult));
  }
} else {
  fail('registerVersion (test 3)', 'could not register: ' + JSON.stringify(regResult3));
}

// ── Test 4: getRegistryStatus reflects rejectedModels[] ──
console.log('\n--- Test Group 4: Registry Status Integration ---');

var status = MODEL_REGISTRY.getRegistryStatus();
if (status.rejectedCount >= 3) {
  pass('getRegistryStatus.rejectedCount >= 3 (actual: ' + status.rejectedCount + ')');
} else {
  fail('getRegistryStatus.rejectedCount', 'expected >= 3, got ' + status.rejectedCount);
}

if (Array.isArray(status.rejectedModels) && status.rejectedModels.length >= 3) {
  pass('getRegistryStatus.rejectedModels is array with >= 3 entries');
  // Verify each has required fields
  var allValid = true;
  for (var i = 0; i < status.rejectedModels.length; i++) {
    var rm = status.rejectedModels[i];
    if (!rm.versionId || !rm.status || !rm.rejectedAt) {
      allValid = false;
      console.log('    Missing field in rejectedModel: ' + JSON.stringify(rm));
    }
  }
  if (allValid) {
    pass('getRegistryStatus.rejectedModels[] all have versionId+status+rejectedAt');
  } else {
    fail('getRegistryStatus.rejectedModels[]', 'some entries missing required fields');
  }
} else {
  fail('getRegistryStatus.rejectedModels', 'expected array with >=3, got: ' + JSON.stringify(status.rejectedModels));
}

if (status.hasRejectedModel === true) {
  pass('getRegistryStatus.hasRejectedModel === true');
} else {
  fail('getRegistryStatus.hasRejectedModel', 'expected true, got: ' + status.hasRejectedModel);
}

// ── Test 5: Reject text is correct ──
console.log('\n--- Test Group 5: Rejection Evidence Text ---');

var rejList = MODEL_REGISTRY.getRejectedModels();
var foundCorrectText = false;
for (var j = 0; j < rejList.length; j++) {
  var ev = rejList[j].rejectionEvidence;
  if (ev && ev.reason && ev.reason.indexOf('个微弱正 Rank IC') > 0 &&
      ev.reason.indexOf('平均 Rank IC 为负') > 0 &&
      ev.reason.indexOf('paired delta CI 为负') > 0 &&
      ev.reason.indexOf('因此无稳定预测能力') > 0) {
    foundCorrectText = true;
    break;
  }
}
if (foundCorrectText) {
  pass('reject text: contains correct wording ("个微弱正 Rank IC", "平均 Rank IC 为负", "paired delta CI 为负", "因此无稳定预测能力")');
} else {
  fail('reject text', 'did not find the required wording. Checking...');
  for (var k = 0; k < rejList.length; k++) {
    console.log('    [' + k + ']: ' + (rejList[k].rejectionEvidence ? rejList[k].rejectionEvidence.reason : 'NO EVIDENCE'));
  }
}

// ── Test 6: Restart persistence — simulated by manual re-read ──
console.log('\n--- Test Group 6: Restart Persistence (simulated) ---');

// Verify that rejected_models.json contains all three rejections
if (fs.existsSync(REJECTED_FILE)) {
  var diskRej = JSON.parse(fs.readFileSync(REJECTED_FILE, 'utf8'));
  if (diskRej.length >= 3) {
    pass('restart persistence: rejected_models.json has >=3 entries on disk');
  } else {
    fail('restart persistence', 'rejected_models.json only has ' + diskRej.length + ' entries');
  }

  // Verify model_registry.json also has rejectedModels
  if (fs.existsSync(REGISTRY_FILE)) {
    var diskReg = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    if (diskReg.rejectedModels && diskReg.rejectedModels.length >= 3) {
      pass('restart persistence: model_registry.json rejectedModels[] has >=3 entries');
    } else {
      fail('restart persistence', 'model_registry.json missing rejectedModels or too few: ' +
        (diskReg.rejectedModels ? diskReg.rejectedModels.length : 'undefined'));
    }
  } else {
    fail('restart persistence', 'model_registry.json not found on disk');
  }
} else {
  fail('restart persistence', 'rejected_models.json not found on disk');
}

// ── Report ──
console.log('\n' + '='.repeat(50));
console.log('RESULTS: ' + PASSED + ' passed, ' + FAILED + ' failed, ' + (PASSED + FAILED) + ' total');
if (FAILED === 0) {
  console.log('ALL TESTS PASSED');
} else {
  console.log('SOME TESTS FAILED');
  process.exitCode = 1;
}

// Cleanup
cleanTestFiles();
