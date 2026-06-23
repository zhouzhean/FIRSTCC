/**
 * P1: True Walk-Forward — First Learnable Model Pipeline
 *
 * Strict train / validate / test separation per window:
 *   1. Train: fit ridge regression weights (ONLY)
 *   2. Validate: select lambda via hyperparameter grid (ONLY)
 *   3. Test: predict and evaluate (ONLY — NO fitting, NO weight updates)
 *
 * Per-window artifacts saved:
 *   report-engine/data/research/model_artifacts/window_NNN/
 *     model.json       — weights, intercept, lambda, feature names
 *     feature_schema.json — feature definitions and sources
 *     dates.json       — trainStart/End, valStart/End, testStart/End
 *     data_hash.json   — sha256 of all input snapshot files used
 *
 * Shadow only: artifacts saved, NEVER fed to simfolio.
 *
 * Output: report-engine/data/research/model_artifacts/true_walk_forward_summary.json
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var CALENDAR = require('./universal_calendar');
var UNIVERSE = require('./universe_definition');
var LINEAR = require('./linear_model');
var OOS = require('./rolling_oos_evaluation');

var SNAPSHOTS_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'research', 'snapshots');
var ARTIFACTS_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'research', 'model_artifacts');

// ---- Load snapshot data for a date range ----

function loadSnapshotsForDates(dates) {
  var results = [];
  dates.forEach(function (d) {
    var fp = path.join(SNAPSHOTS_DIR, d + '.jsonl');
    if (!fs.existsSync(fp)) return;
    try {
      var lines = fs.readFileSync(fp, 'utf8').trim().split('\n');
      lines.forEach(function (l) {
        if (!l) return;
        try { results.push(JSON.parse(l)); } catch (e) {}
      });
    } catch (e) {}
  });
  return results;
}

// ---- Data hash for a set of dates ----

function computeDataHash(dates) {
  var hash = crypto.createHash('sha256');
  dates.sort().forEach(function (d) {
    hash.update(d);
    var fp = path.join(SNAPSHOTS_DIR, d + '.jsonl');
    if (fs.existsSync(fp)) {
      hash.update(fs.readFileSync(fp, 'utf8'));
    }
  });
  return hash.digest('hex');
}

// ---- Single Window: Train → Validate → Test ----

function evaluateTrueWalkForward(windowDef, windowIndex) {
  var trainDates = windowDef.trainDates;
  var validateDates = windowDef.validateDates;
  var testDates = windowDef.testDates;

  console.log('  Loading train data (' + trainDates.length + ' days)...');
  var trainSnaps = loadSnapshotsForDates(trainDates);
  var trainData = LINEAR.buildFeatureMatrix(trainSnaps);
  console.log('    Train: ' + trainData.nSamples + ' samples');

  console.log('  Loading validate data (' + validateDates.length + ' days)...');
  var valSnaps = loadSnapshotsForDates(validateDates);
  var valData = LINEAR.buildFeatureMatrix(valSnaps);
  console.log('    Validate: ' + valData.nSamples + ' samples');

  if (trainData.nSamples < 50) {
    return { error: 'insufficient_train_samples', nSamples: trainData.nSamples };
  }

  // Grid search on train/val (val only for lambda selection)
  console.log('  Grid searching lambda...');
  var best = LINEAR.gridSearchLambda(trainData.X, trainData.y, valData.X, valData.y);
  if (!best.model) {
    return { error: 'model_fit_failed' };
  }
  console.log('    Best λ=' + best.lambda + ' | Train MSE=' + Math.round(best.trainMSE * 100) / 100 + ' | Val MSE=' + Math.round(best.valMSE * 100) / 100);

  // Refit on full train (train + validate combined) with best lambda
  var fullTrainX = trainData.X.concat(valData.X);
  var fullTrainY = trainData.y.concat(valData.y);
  var finalModel = LINEAR.fitRidge(fullTrainX, fullTrainY, best.lambda);
  if (!finalModel) {
    return { error: 'final_model_fit_failed' };
  }

  // Predict on test set (NO fitting)
  console.log('  Loading test data (' + testDates.length + ' days)...');
  var testSnaps = loadSnapshotsForDates(testDates);
  var testData = LINEAR.buildFeatureMatrix(testSnaps);
  console.log('    Test: ' + testData.nSamples + ' samples');

  var testPredictions = [];
  for (var i = 0; i < testSnaps.length; i++) {
    var s = testSnaps[i];
    if (!s || s.forwardStatus !== 'settled' || s.forwardExcessT3 == null) continue;
    var features = LINEAR.extractFeatures(s);
    if (!features) continue;
    var pred = LINEAR.predict(finalModel, features);
    if (pred == null) continue;
    testPredictions.push({
      code: s.code,
      asOfDate: s.asOfDate,
      predictedExcess: Math.round(pred * 100) / 100,
      actualExcess: s.forwardExcessT3,
      error: Math.round((pred - s.forwardExcessT3) * 100) / 100,
    });
  }

  // Compute test metrics
  var testMSE = LINEAR.computeMSE(finalModel, testData.X, testData.y);
  var errors = testPredictions.map(function (p) { return p.error; });
  var mae = errors.length > 0
    ? Math.round(errors.reduce(function (s, e) { return s + Math.abs(e); }, 0) / errors.length * 100) / 100
    : null;

  // Direction accuracy
  var correctDir = 0;
  testPredictions.forEach(function (p) {
    if ((p.predictedExcess > 0 && p.actualExcess > 0) || (p.predictedExcess < 0 && p.actualExcess < 0)) {
      correctDir++;
    }
  });
  var directionAccuracy = testPredictions.length > 0
    ? Math.round(correctDir / testPredictions.length * 10000) / 100
    : null;

  // Data hashes
  var trainHash = computeDataHash(trainDates.concat(validateDates));
  var testHash = computeDataHash(testDates);

  // Save artifacts
  var winDir = path.join(ARTIFACTS_DIR, 'window_' + String(windowIndex + 1).padStart(3, '0'));
  if (!fs.existsSync(winDir)) fs.mkdirSync(winDir, { recursive: true });

  // model.json
  fs.writeFileSync(path.join(winDir, 'model.json'), JSON.stringify({
    weights: finalModel.weights,
    featureNames: finalModel.featureNames,
    lambda: finalModel.lambda,
    nFeatures: finalModel.nFeatures,
    trainedAt: new Date().toISOString(),
    trainSamples: fullTrainX.length,
    valSamples: valData.X.length,
    testSamples: testData.X.length,
  }, null, 2), 'utf8');

  // feature_schema.json
  fs.writeFileSync(path.join(winDir, 'feature_schema.json'), JSON.stringify({
    features: finalModel.featureNames.map(function (name) {
      return { name: name, source: name === 'technical' || name === 'hidden' ? 'computed_pt' : 'derived_pt', type: 'numeric' };
    }),
    excludedFeatures: ['fundamental', 'capitalFlow', 'event'],
    exclusionReason: 'No point-in-time data available for these features.',
  }, null, 2), 'utf8');

  // dates.json
  fs.writeFileSync(path.join(winDir, 'dates.json'), JSON.stringify({
    trainStart: trainDates[0], trainEnd: trainDates[trainDates.length - 1], trainDays: trainDates.length,
    validateStart: validateDates[0], validateEnd: validateDates[validateDates.length - 1], validateDays: validateDates.length,
    testStart: testDates[0], testEnd: testDates[testDates.length - 1], testDays: testDates.length,
  }, null, 2), 'utf8');

  // data_hash.json
  fs.writeFileSync(path.join(winDir, 'data_hash.json'), JSON.stringify({
    trainHash: trainHash,
    testHash: testHash,
    algorithm: 'sha256',
  }, null, 2), 'utf8');

  return {
    window: {
      trainStart: trainDates[0], trainEnd: trainDates[trainDates.length - 1], trainDays: trainDates.length,
      validateStart: validateDates[0], validateEnd: validateDates[validateDates.length - 1], validateDays: validateDates.length,
      testStart: testDates[0], testEnd: testDates[testDates.length - 1], testDays: testDates.length,
    },
    model: {
      weights: finalModel.weights,
      featureNames: finalModel.featureNames,
      lambda: finalModel.lambda,
      trainSamples: fullTrainX.length,
      valSamples: valData.X.length,
      testSamples: testData.X.length,
    },
    metrics: {
      trainMSE: Math.round(best.trainMSE * 100) / 100,
      valMSE: Math.round(best.valMSE * 100) / 100,
      testMSE: testMSE != null ? Math.round(testMSE * 100) / 100 : null,
      testMAE: mae,
      directionAccuracy: directionAccuracy,
      testPredictions: testPredictions.length,
    },
    artifactsPath: winDir,
  };
}

// ---- Main Entry ----

function runTrueWalkForward(options) {
  var opts = options || {};
  opts.startDate = opts.startDate || '2023-10-30';
  opts.endDate = opts.endDate || '2026-06-15';

  console.log('=== P1: True Walk-Forward (Train → Validate → Test) ===');
  console.log('Model: Ridge Regression (closed-form)');
  console.log('Features: ' + LINEAR.FEATURE_NAMES.join(', '));
  console.log('Range: ' + opts.startDate + ' to ' + opts.endDate);
  console.log('Stable start: ' + (UNIVERSE.getStableStartDate() || 'N/A'));
  console.log();

  if (!fs.existsSync(ARTIFACTS_DIR)) fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

  var winResult = OOS.generateWindows(opts);
  if (winResult.error) {
    console.error('Error generating windows: ' + winResult.error);
    return winResult;
  }

  var windows = winResult.windows;
  console.log('Windows: ' + windows.length);
  console.log();

  var summary = {
    generatedAt: new Date().toISOString(),
    model: 'ridge_regression',
    features: LINEAR.FEATURE_NAMES,
    lambdaGrid: LINEAR.LAMBDA_GRID,
    windows: [],
  };

  for (var wi = 0; wi < windows.length; wi++) {
    console.log('Window ' + (wi + 1) + '/' + windows.length + ':');
    var result = evaluateTrueWalkForward(windows[wi], wi);

    if (result.error) {
      console.log('  ERROR: ' + result.error);
      summary.windows.push({ error: result.error, window: windows[wi] });
      continue;
    }

    summary.windows.push(result);
    console.log('  Test MSE: ' + result.metrics.testMSE + ' | MAE: ' + result.metrics.testMAE + ' | Dir Acc: ' + result.metrics.directionAccuracy + '%');
    console.log('  Artifacts: ' + result.artifactsPath);
    console.log();
  }

  // Write summary
  var summaryPath = path.join(ARTIFACTS_DIR, 'true_walk_forward_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log('Summary written to ' + summaryPath);

  // Print aggregate
  var validWindows = summary.windows.filter(function (w) { return !w.error && w.metrics; });
  if (validWindows.length > 0) {
    var svgTestMSE = Math.round(validWindows.reduce(function (s, w) { return s + w.metrics.testMSE; }, 0) / validWindows.length * 100) / 100;
    var svgDirAcc = Math.round(validWindows.reduce(function (s, w) { return s + (w.metrics.directionAccuracy || 0); }, 0) / validWindows.length * 100) / 100;
    console.log();
    console.log('=== Aggregate ===');
    console.log('Valid windows: ' + validWindows.length + '/' + windows.length);
    console.log('Average test MSE: ' + svgTestMSE);
    console.log('Average direction accuracy: ' + svgDirAcc + '%');
  }

  return summary;
}

// ---- CLI ----

if (require.main === module) {
  var startDate = process.argv[2] || '2023-10-30';
  var endDate = process.argv[3] || '2026-06-15';

  runTrueWalkForward({ startDate: startDate, endDate: endDate });
}

module.exports = { runTrueWalkForward, evaluateTrueWalkForward };
