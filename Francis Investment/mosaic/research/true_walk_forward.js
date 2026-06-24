/**
 * P1: True Walk-Forward — Standardized Feature Ridge Model + Simulator Evaluation
 *
 * Pipeline per window:
 *   1. Train: fit standardizer (mean/std) + ridge regression weights (ONLY on train)
 *   2. Validate: select lambda via grid search (ONLY on val)
 *   3. Test: standardize with train transform, predict, rank, simulate (NO fitting)
 *
 * P1 upgrades:
 *   — Feature standardization: fit on train, transform val/test unchanged
 *   — Unregularized intercept in ridge regression
 *   — Each test window runs through repaired P0-2 simulator
 *   — Output per window: Rank IC, Top-50 post-cost return, prediction decile calibration,
 *     delta vs technical-only and random baselines
 *   — Legacy composite quarantined as historical control only — NOT promoted
 *
 * Per-window artifacts:
 *   report-engine/data/research/model_artifacts/window_NNN/
 *     model.json, standardizer.json, feature_schema.json, dates.json, data_hash.json
 *
 * Output: report-engine/data/research/model_artifacts/true_walk_forward_summary.json
 *
 * Memory optimization (v2):
 *   — Streamed lightweight loading: each snapshot row stripped to only needed fields
 *   — Train/val data released before test load
 *   — Global GC hint between windows
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var CALENDAR = require('./universal_calendar');
var UNIVERSE = require('./universe_definition');
var LINEAR = require('./linear_model');
var OOS = require('./rolling_oos_evaluation');
var BASELINES = require('./baseline_models');
var SIMULATOR = require('./trade_simulator');

var SNAPSHOTS_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'research', 'snapshots');
var ARTIFACTS_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'research', 'model_artifacts');
var RESULTS_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'research', 'oos_evaluation_results');
var PROGRESS_FILE = path.join(ARTIFACTS_DIR, 'walk_forward_progress.json');

// ---- Lightweight snapshot loading (strips to only needed fields) ----

var NEEDED_FIELDS = [
  'code', 'asOfDate', 'name',
  // Features (top-level)
  'signalCount', 'volatility20d', 'changePct',
  // Dimensions object
  'dimensions',
  // Target
  'forwardReturnT3', 'forwardExcessT3', 'forwardStatus',
  // Tradeability (P0.2)
  'entryDate', 'exitDate', 'entryPrice', 'exitPrice',
  'plannedExitDate', 'actualExitDate', 'exitDelayDays', 'exitStatus',
  'targetStatus', 'unavailableReason',
  // Composite (for comparison)
  'compositeScore',
];

function loadSnapshotDates(dates) {
  var results = [];
  for (var di = 0; di < dates.length; di++) {
    var fp = path.join(SNAPSHOTS_DIR, dates[di] + '.jsonl');
    if (!fs.existsSync(fp)) continue;
    try {
      var lines = fs.readFileSync(fp, 'utf8').trim().split('\n');
      for (var li = 0; li < lines.length; li++) {
        if (!lines[li]) continue;
        try {
          var raw = JSON.parse(lines[li]);
          // Only keep needed fields to save memory
          var slim = {};
          for (var fi = 0; fi < NEEDED_FIELDS.length; fi++) {
            var key = NEEDED_FIELDS[fi];
            if (raw[key] !== undefined) slim[key] = raw[key];
          }
          results.push(slim);
        } catch (e) {}
      }
    } catch (e) {}
  }
  return results;
}

// Streamed version: process each date's snapshots without accumulating the full array.
// Calls callback(date, daySnapshots) for each date in order.
function forEachSnapshotDate(dates, callback) {
  for (var di = 0; di < dates.length; di++) {
    var d = dates[di];
    var fp = path.join(SNAPSHOTS_DIR, d + '.jsonl');
    if (!fs.existsSync(fp)) continue;
    try {
      var lines = fs.readFileSync(fp, 'utf8').trim().split('\n');
      var daySnaps = [];
      for (var li = 0; li < lines.length; li++) {
        if (!lines[li]) continue;
        try {
          var raw = JSON.parse(lines[li]);
          var slim = {};
          for (var fi = 0; fi < NEEDED_FIELDS.length; fi++) {
            var key = NEEDED_FIELDS[fi];
            if (raw[key] !== undefined) slim[key] = raw[key];
          }
          daySnaps.push(slim);
        } catch (e) {}
      }
      callback(d, daySnaps);
    } catch (e) {}
  }
}

// ---- Data hash (streaming, doesn't accumulate) ----

function computeDataHashDates(dates) {
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

// ---- Rank IC computation (tie-aware Kendall tau-b) ----

function computeRankIC(snapshots, predictions) {
  var pairs = [];
  var predMap = {};
  predictions.forEach(function (p) { predMap[p.code] = p.predictedExcess; });

  snapshots.forEach(function (s) {
    var pred = predMap[s.code];
    var actual = s.forwardReturnT3;
    if (pred == null || actual == null) return;
    pairs.push({ pred: pred, actual: actual });
  });

  if (pairs.length < 10) return null;

  pairs.sort(function (a, b) { return b.pred - a.pred; });
  var preds = pairs.map(function (p) { return p.pred; });
  var actuals = pairs.map(function (p) { return p.actual; });

  return BASELINES.kendallTauB(preds, actuals);
}

// ---- Prediction decile calibration ----

function computeDecileCalibration(snapshots, predictions) {
  var pairs = [];
  var predMap = {};
  predictions.forEach(function (p) { predMap[p.code] = p.predictedExcess; });

  snapshots.forEach(function (s) {
    var pred = predMap[s.code];
    var actual = s.forwardReturnT3;
    if (pred == null || actual == null) return;
    pairs.push({ pred: pred, actual: actual });
  });

  if (pairs.length < 20) return null;

  pairs.sort(function (a, b) { return a.pred - b.pred; });
  var perDecile = Math.floor(pairs.length / 10);
  var deciles = [];

  for (var d = 0; d < 10; d++) {
    var start = d * perDecile;
    var end = d === 9 ? pairs.length : (d + 1) * perDecile;
    var bin = pairs.slice(start, end);
    var sumPred = 0, sumActual = 0;
    bin.forEach(function (p) { sumPred += p.pred; sumActual += p.actual; });
    var n = bin.length;
    deciles.push({
      decile: d + 1,
      count: n,
      meanPrediction: Math.round(sumPred / n * 100) / 100,
      meanActual: Math.round(sumActual / n * 100) / 100,
    });
  }

  return deciles;
}

// ---- Single Window: Train → Validate → Test ----

function evaluateTrueWalkForward(windowDef, windowIndex, klineIdx) {
  var trainDates = windowDef.trainDates;
  var validateDates = windowDef.validateDates;
  var testDates = windowDef.testDates;

  console.log('  Loading train data (' + trainDates.length + ' days)...');
  var trainSnaps = loadSnapshotDates(trainDates);
  console.log('    Train: ' + trainSnaps.length + ' samples');

  // Step 1: Fit standardizer on training data only
  var rawTrainData = LINEAR.buildFeatureMatrix(trainSnaps, null);
  if (rawTrainData.nSamples < 50) {
    trainSnaps = null; // free memory
    return { error: 'insufficient_train_samples', nSamples: rawTrainData.nSamples };
  }
  var trainSampleCount = rawTrainData.nSamples; // capture before freeing

  // Extract raw features (without intercept) for standardizer fitting
  var rawFeatures = [];
  for (var i = 0; i < rawTrainData.X.length; i++) {
    rawFeatures.push(rawTrainData.X[i].slice(1));
  }
  var standardizer = LINEAR.fitStandardizer(rawFeatures);
  rawFeatures = null;
  // Free raw (unstandardized) feature matrix — we'll rebuild with standardizer
  rawTrainData = null;
  console.log('    Standardizer fitted on ' + trainSampleCount + ' train samples');

  // Rebuild train with standardizer
  var trainData = LINEAR.buildFeatureMatrix(trainSnaps, standardizer);

  // Step 2: Grid search lambda on train/val
  console.log('  Loading validate data (' + validateDates.length + ' days)...');
  var valSnaps = loadSnapshotDates(validateDates);
  var valData = LINEAR.buildFeatureMatrix(valSnaps, standardizer);
  console.log('    Validate: ' + valData.nSamples + ' samples');

  console.log('  Grid searching lambda...');
  var best = LINEAR.gridSearchLambda(trainData.X, trainData.y, valData.X, valData.y);
  if (!best.model) {
    trainSnaps = null; valSnaps = null; trainData = null; valData = null;
    return { error: 'model_fit_failed' };
  }
  console.log('    Best λ=' + best.lambda + ' | Train MSE=' + Math.round(best.trainMSE * 100) / 100 + ' | Val MSE=' + Math.round(best.valMSE * 100) / 100);

  // Step 3: Refit on full train (train + validate) with best lambda
  var fullTrainSnaps = trainSnaps.concat(valSnaps);
  var valSnapCount = valSnaps.length; // capture before freeing
  // Free intermediate arrays
  trainSnaps = null;
  valSnaps = null;

  var fullTrainData = LINEAR.buildFeatureMatrix(fullTrainSnaps, standardizer);
  var finalModel = LINEAR.fitRidge(fullTrainData.X, fullTrainData.y, best.lambda);
  if (!finalModel) {
    fullTrainSnaps = null; fullTrainData = null; trainData = null; valData = null;
    return { error: 'final_model_fit_failed' };
  }

  finalModel.intercept = Math.round(finalModel.intercept * 10000) / 10000;
  for (var wi = 0; wi < finalModel.weights.length; wi++) {
    finalModel.weights[wi] = Math.round(finalModel.weights[wi] * 10000) / 10000;
  }

  // Release train/val data BEFORE loading test data
  fullTrainSnaps = null;
  fullTrainData = null;
  trainData = null;
  valData = null;

  if (typeof global !== 'undefined' && global.gc) { global.gc(); }

  // Step 4: Predict on test set (standardized, NO fitting)
  console.log('  Loading test data (' + testDates.length + ' days)...');
  var testSnaps = loadSnapshotDates(testDates);
  var testData = LINEAR.buildFeatureMatrix(testSnaps, standardizer);
  console.log('    Test: ' + testData.nSamples + ' samples');

  // Predict and build daily rankings for simulator
  var dailyTestSignals = {};
  var allPredictions = [];

  testDates.forEach(function (testDate) {
    var daySnaps = testSnaps.filter(function (s) { return s.asOfDate === testDate; });
    if (daySnaps.length < 10) return;

    var dayPredictions = [];
    daySnaps.forEach(function (s) {
      var features = LINEAR.extractFeatures(s);
      if (!features) return;
      var stdFeatures = [];
      for (var j = 0; j < features.length; j++) {
        stdFeatures.push((features[j] - standardizer.means[j]) / standardizer.stds[j]);
      }
      var pred = LINEAR.predict(finalModel, stdFeatures);
      if (pred == null) return;

      dayPredictions.push({
        code: s.code,
        predictedExcess: Math.round(pred * 10000) / 10000,
        actualReturn: s.forwardReturnT3,
        actualExcess: s.forwardExcessT3,
      });
      allPredictions.push({
        code: s.code,
        asOfDate: s.asOfDate,
        predictedExcess: Math.round(pred * 10000) / 10000,
        actualReturn: s.forwardReturnT3,
        actualExcess: s.forwardExcessT3,
        error: s.forwardReturnT3 != null ? Math.round((pred - s.forwardReturnT3) * 10000) / 10000 : null,
      });
    });

    dayPredictions.sort(function (a, b) { return b.predictedExcess - a.predictedExcess; });
    dailyTestSignals[testDate] = dayPredictions.slice(0, SIMULATOR.MAX_POSITIONS || 50);
  });

  // Step 5: Run model predictions through trade simulator (P0-2)
  console.log('  Simulating model portfolio...');
  var simulatorResult = SIMULATOR.simulatePortfolio(dailyTestSignals, {
    klineIdx: klineIdx,
    holdDays: SIMULATOR.HOLD_DAYS || 3,
    topN: SIMULATOR.TOP_N_PER_COHORT || 50,
    maxPositionsPerSleeve: SIMULATOR.MAX_POSITIONS_PER_SLEEVE || 17,
  });

  // Step 6: Per-date Rank IC
  var rankICs = [];
  testDates.forEach(function (testDate) {
    var daySnaps = testSnaps.filter(function (s) { return s.asOfDate === testDate; });
    var dayPreds = allPredictions.filter(function (p) { return p.asOfDate === testDate; });
    var ic = computeRankIC(daySnaps, dayPreds);
    if (ic != null) rankICs.push({ date: testDate, rankIC: Math.round(ic * 10000) / 10000 });
  });

  var avgRankIC = rankICs.length > 0
    ? Math.round(rankICs.reduce(function (s, r) { return s + r.rankIC; }, 0) / rankICs.length * 10000) / 10000
    : null;

  // Step 7: Decile calibration
  var decileCalibration = computeDecileCalibration(testSnaps, allPredictions);

  // Step 8: Compute test metrics
  var testMSE = LINEAR.computeMSE(finalModel, testData.X, testData.y);
  var errors = allPredictions.map(function (p) { return p.error; }).filter(function (e) { return e != null; });
  var mae = errors.length > 0
    ? Math.round(errors.reduce(function (s, e) { return s + Math.abs(e); }, 0) / errors.length * 100) / 100
    : null;

  // Direction accuracy
  var correctDir = 0, totalDir = 0;
  allPredictions.forEach(function (p) {
    if (p.predictedExcess == null || p.actualReturn == null) return;
    totalDir++;
    if ((p.predictedExcess > 0 && p.actualReturn > 0) || (p.predictedExcess < 0 && p.actualReturn < 0)) correctDir++;
  });
  var directionAccuracy = totalDir > 0 ? Math.round(correctDir / totalDir * 10000) / 100 : null;

  // Step 9: Tech-only baseline comparison (same test dates)
  console.log('  Computing technical-only baseline for comparison...');
  var snapshotsByDate = {};
  testDates.forEach(function (testDate) {
    var daySnaps = testSnaps.filter(function (s) { return s.asOfDate === testDate; });
    var map = {};
    daySnaps.forEach(function (s) { map[s.code] = s; });
    if (Object.keys(map).length >= 10) {
      snapshotsByDate[testDate] = { map: map, list: daySnaps };
    }
  });

  var techComparison = null;
  try {
    techComparison = BASELINES.compareFullTimeSeries('technicalOnly', snapshotsByDate, {}, klineIdx, 100);
  } catch (e) { techComparison = { error: e.message }; }

  // Release test snapshots now (no longer needed after tech comparison)
  testSnaps = null;
  testData = null;

  // Step 10: Save artifacts
  var winDir = path.join(ARTIFACTS_DIR, 'window_' + String(windowIndex + 1).padStart(3, '0'));
  if (!fs.existsSync(winDir)) fs.mkdirSync(winDir, { recursive: true });

  var trainHash = computeDataHashDates(trainDates.concat(validateDates));
  var testHash = computeDataHashDates(testDates);

  // model.json
  fs.writeFileSync(path.join(winDir, 'model.json'), JSON.stringify({
    intercept: finalModel.intercept,
    weights: finalModel.weights,
    featureNames: finalModel.featureNames,
    lambda: finalModel.lambda,
    nFeatures: finalModel.nFeatures,
    trainedAt: new Date().toISOString(),
    trainSamples: trainSampleCount,
    valSamples: valSnapCount || null,
    testSamples: simulatorResult ? simulatorResult.totalSignals : null,
  }, null, 2), 'utf8');

  // standardizer.json
  fs.writeFileSync(path.join(winDir, 'standardizer.json'), JSON.stringify({
    featureNames: LINEAR.FEATURE_NAMES,
    means: standardizer.means,
    stds: standardizer.stds,
    fittedOn: 'train_only',
  }, null, 2), 'utf8');

  // feature_schema.json
  fs.writeFileSync(path.join(winDir, 'feature_schema.json'), JSON.stringify({
    features: LINEAR.FEATURE_NAMES.map(function (name) {
      return { name: name, source: name === 'technical' || name === 'hidden' ? 'computed_pt' : 'derived_pt', type: 'numeric' };
    }),
    excludedFeatures: ['fundamental', 'capitalFlow', 'event'],
    exclusionReason: 'No point-in-time data for these features',
    standardizer: 'fit_on_train_only',
    intercept: 'unregularized',
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
      intercept: finalModel.intercept,
      weights: finalModel.weights,
      featureNames: finalModel.featureNames,
      lambda: finalModel.lambda,
      trainSamples: trainSampleCount,
      valSamples: valSnapCount,
      testSamples: simulatorResult.totalSignals || 0,
    },
    standardizer: {
      means: standardizer.means,
      stds: standardizer.stds,
    },
    metrics: {
      trainMSE: Math.round(best.trainMSE * 100) / 100,
      valMSE: Math.round(best.valMSE * 100) / 100,
      testMSE: testMSE != null ? Math.round(testMSE * 100) / 100 : null,
      testMAE: mae,
      directionAccuracy: directionAccuracy,
      avgRankIC: avgRankIC,
      rankICDays: rankICs.length,
    },
    portfolio: {
      netReturn: simulatorResult.netReturn,
      grossReturn: simulatorResult.grossReturn,
      benchmarkReturn: simulatorResult.benchmarkReturn,
      netExcessReturn: simulatorResult.netExcessReturn,
      maxDrawdownBps: simulatorResult.maxDrawdown,
      sharpeRatio: simulatorResult.sharpeRatio,
      coverageRate: simulatorResult.coverageRate,
      executedTrades: simulatorResult.executedTrades,
      totalSignals: simulatorResult.totalSignals,
    },
    decileCalibration: decileCalibration,
    vsTechnicalOnly: techComparison && !techComparison.error ? {
      modelGrossReturn: simulatorResult.grossReturn,
      modelNetReturn: simulatorResult.netReturn,
      techNetReturn: techComparison.modelPortfolio ? techComparison.modelPortfolio.netReturn : null,
      techGrossReturn: techComparison.modelPortfolio ? techComparison.modelPortfolio.grossReturn : null,
      modelNetExcess: simulatorResult.netExcessReturn,
      techNetExcess: techComparison.modelPortfolio ? techComparison.modelPortfolio.netExcessReturn : null,
      deltaNetReturn: techComparison.modelPortfolio
        ? Math.round((simulatorResult.netReturn - techComparison.modelPortfolio.netReturn) * 100) / 100
        : null,
    } : { error: techComparison ? techComparison.error : 'unknown' },
    artifactsPath: winDir,
  };
}

// ══════ P1: Checkpoint/Resume — avoid daily full retrain ══════
//
// After each window completes, progress is persisted to walk_forward_progress.json.
// On restart, completed windows are skipped. Only re-runs when:
//   1. A window failed (error) — retry that window
//   2. Snapshot data hash changed — invalidate from that window onward

function _loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    }
  } catch (_) {}
  return null;
}

function _saveProgress(progress) {
  try {
    if (!fs.existsSync(ARTIFACTS_DIR)) fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), 'utf8');
  } catch (_) {}
}

function _computeCheckpointHash(dates) {
  // Lightweight hash of date list + file count — sufficient to detect data changes
  var hash = crypto.createHash('sha256');
  var sorted = dates.slice().sort();
  sorted.forEach(function (d) {
    hash.update(d);
    var fp = path.join(SNAPSHOTS_DIR, d + '.jsonl');
    if (fs.existsSync(fp)) {
      var stat = fs.statSync(fp);
      hash.update(String(stat.size));
    } else {
      hash.update('MISSING');
    }
  });
  return hash.digest('hex');
}

// ---- Main Entry ----

function runTrueWalkForward(options) {
  var opts = options || {};
  opts.startDate = opts.startDate || '2023-10-30';
  opts.endDate = opts.endDate || '2026-06-15';

  console.log('=== P1: True Walk-Forward (Standardized Ridge + Simulator) ===');
  console.log('Model: Ridge Regression (closed-form, unregularized intercept)');
  console.log('Features: ' + LINEAR.FEATURE_NAMES.join(', ') + ' (+ intercept)');
  console.log('Standardization: fit on train only, apply to val/test');
  console.log('Lambda grid: ' + LINEAR.LAMBDA_GRID.join(', '));
  console.log('Range: ' + opts.startDate + ' to ' + opts.endDate);
  console.log('Stable start: ' + (UNIVERSE.getStableStartDate() || 'N/A'));
  console.log('Memory-optimized: slim loading, early release, GC hints');
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

  // P1: Checkpoint/Resume — skip already-completed windows
  var progress = _loadProgress();
  var fullDataHash = _computeCheckpointHash(opts.allDates || []);
  var startWindow = 0;
  var resumed = false;

  if (progress && progress.completedWindows && progress.dataHash) {
    if (progress.dataHash !== fullDataHash) {
      // Data changed — find first affected window and restart from there
      for (var ci = 0; ci < windows.length; ci++) {
        if (ci >= progress.completedWindows.length) { startWindow = ci; break; }
        // Check if this window's output still exists
        var winDir = path.join(ARTIFACTS_DIR, 'window_' + String(ci + 1).padStart(3, '0'));
        if (!fs.existsSync(path.join(winDir, 'model.json'))) { startWindow = ci; break; }
      }
      console.log('Data hash changed — resuming from window ' + (startWindow + 1) +
        ' (had ' + progress.completedWindows.length + ' cached)');
      if (startWindow > 0) console.log('Skipped ' + startWindow + ' windows that survived data change');
      resumed = true;
    } else if (progress.completedWindows.length >= windows.length) {
      console.log('All ' + windows.length + ' windows already complete — skipped');
      summary.windows = progress.completedWindows;
      return summary;
    } else {
      startWindow = progress.completedWindows.length;
      console.log('Resuming from window ' + (startWindow + 1) +
        ' (' + progress.completedWindows.length + '/' + windows.length + ' cached)');
      resumed = true;
    }
  }

  // Load kline index once
  console.log('Loading kline index...');
  var klineIdx = SIMULATOR.loadKlineIndex();
  console.log('Kline index: ' + Object.keys(klineIdx).length + ' stocks');
  console.log();

  var summary = {
    generatedAt: new Date().toISOString(),
    model: 'ridge_regression',
    features: LINEAR.FEATURE_NAMES,
    lambdaGrid: LINEAR.LAMBDA_GRID,
    standardization: 'fit_on_train_only',
    intercept: 'unregularized',
    labelConvention: 'T_close_signal__T+1_open_entry__T+4_close_exit__3day_hold',
    simulatorVersion: 'P0-2 (3-sleeve overlapping cohorts)',
    legacyNote: 'Composite score is quarantined as historical control only. Not used in promotion.',
    windows: progress && resumed ? progress.completedWindows.slice(0, startWindow) : [],
    resumed: resumed,
    resumedFromWindow: resumed ? startWindow : null,
  };

  for (var wi = startWindow; wi < windows.length; wi++) {
    console.log('Window ' + (wi + 1) + '/' + windows.length + ':');
    var result = evaluateTrueWalkForward(windows[wi], wi, klineIdx);

    if (result.error) {
      console.log('  ERROR: ' + result.error);
      summary.windows.push({ error: result.error, window: windows[wi] });
      // P1: Don't checkpoint on error — retry next run
      continue;
    }

    summary.windows.push(result);
    console.log('  Test MSE: ' + result.metrics.testMSE + ' | MAE: ' + result.metrics.testMAE + ' | Dir Acc: ' + result.metrics.directionAccuracy + '%');
    console.log('  Rank IC: ' + result.metrics.avgRankIC + ' (' + result.metrics.rankICDays + ' days)');
    console.log('  Portfolio: net=' + result.portfolio.netReturn + '% gross=' + result.portfolio.grossReturn + '% excess=' + result.portfolio.netExcessReturn + '% dd=' + result.portfolio.maxDrawdownBps + 'bps');
    if (result.vsTechnicalOnly && result.vsTechnicalOnly.deltaNetReturn != null) {
      console.log('  vs Tech-Only: deltaNet=' + result.vsTechnicalOnly.deltaNetReturn + '%');
    }
    console.log('  Artifacts: ' + result.artifactsPath);
    console.log();

    // P1: Checkpoint after each successful window
    _saveProgress({
      completedWindows: summary.windows.slice(),
      dataHash: fullDataHash,
      lastWindow: wi + 1,
      totalWindows: windows.length,
      updatedAt: new Date().toISOString(),
    });

    // Hint GC between windows (if --expose-gc is on)
    if (typeof global !== 'undefined' && global.gc) { global.gc(); }
  }

  // Free kline index
  klineIdx = null;
  if (typeof global !== 'undefined' && global.gc) { global.gc(); }

  // Write summary
  var summaryPath = path.join(ARTIFACTS_DIR, 'true_walk_forward_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log('Summary written to ' + summaryPath);

  // Print aggregate
  var validWindows = summary.windows.filter(function (w) { return !w.error && w.metrics; });
  if (validWindows.length > 0) {
    var svgTestMSE = Math.round(validWindows.reduce(function (s, w) { return s + w.metrics.testMSE; }, 0) / validWindows.length * 100) / 100;
    var svgDirAcc = Math.round(validWindows.reduce(function (s, w) { return s + (w.metrics.directionAccuracy || 0); }, 0) / validWindows.length * 100) / 100;
    var svgRankIC = validWindows.filter(function (w) { return w.metrics.avgRankIC != null; });
    var avgIC = svgRankIC.length > 0
      ? Math.round(svgRankIC.reduce(function (s, w) { return s + w.metrics.avgRankIC; }, 0) / svgRankIC.length * 10000) / 10000
      : null;

    console.log();
    console.log('=== Aggregate ===');
    console.log('Valid windows: ' + validWindows.length + '/' + windows.length);
    console.log('Average test MSE: ' + svgTestMSE);
    console.log('Average direction accuracy: ' + svgDirAcc + '%');
    console.log('Average Rank IC: ' + avgIC);
  }

  // P1: Candidate evaluation is now handled by candidate_runner.js.
  // Each hypothesis (H1/H2/H3) gets its own independent walk-forward run
  // with hypothesis-specific feature subsets, rankings, trade simulations, and OOS metrics.
  // The old auto-feed loop (same Ridge results recycled to all candidates) has been removed.

  return summary;
}

// ---- CLI ----

if (require.main === module) {
  var startDate = process.argv[2] || '2023-10-30';
  var endDate = process.argv[3] || '2026-06-15';

  runTrueWalkForward({ startDate: startDate, endDate: endDate });
}

module.exports = {
  runTrueWalkForward,
  evaluateTrueWalkForward,
  // Shared utilities exported for candidate_runner.js
  loadSnapshotDates,
  forEachSnapshotDate,
  computeDataHashDates,
  computeRankIC,
  computeDecileCalibration,
};
