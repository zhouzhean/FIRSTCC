/**
 * P1: Candidate Runner — Independent Hypothesis-Specific Walk-Forward Evaluation
 *
 * Each hypothesis (H1, H2, H3) gets its OWN walk-forward run:
 *   — Feature subset specific to the hypothesis (not all 5 features)
 *   — Independent model training (Ridge regression on hypothesis features)
 *   — Independent daily rankings (per-hypothesis score-based ranking)
 *   — Independent trade simulation (per-hypothesis portfolio NAV)
 *   — Independent OOS metrics (Rank IC, decile calibration, benchmark comparison)
 *
 * Research/Lock window gating:
 *   — Windows 0-3: research exploration (all candidates run these)
 *   — Windows 4-5: lock confirmation (ONLY SHADOW_CANDIDATE can run these)
 *   — After 4th research window, auto-attempts promotion via candidate_registry
 *
 * Each evaluation record includes:
 *   candidateVersionId, hypothesisId, strategyHash, featureSchemaHash,
 *   snapshotHash, windowId, costAssumptions, benchmarkStatus
 *
 * No auto threshold changes, weight adjustments, buy qualification, or promotion.
 * Models move between states ONLY through explicit, evidence-backed transitions.
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var CALENDAR = require('./universal_calendar');
var LINEAR = require('./linear_model');
var OOS = require('./rolling_oos_evaluation');
var BASELINES = require('./baseline_models');
var SIMULATOR = require('./trade_simulator');
var TWF = require('./true_walk_forward');
var CANDIDATE_REGISTRY = require('./candidate_registry');

var SNAPSHOTS_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'research', 'snapshots');
var ARTIFACTS_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'research', 'model_artifacts');
var PROGRESS_FILE = path.join(ARTIFACTS_DIR, 'candidate_runner_progress.json');

// ---- Default cost assumptions (from config, overridable) ----

var DEFAULT_COST_ASSUMPTIONS = {
  roundTripCostPct: 0.452,
  commissionRate: 0.00025,
  stampTaxRate: 0.001,
  transferFeeRate: 0.00001,
  slippagePct: 0.0015,
};

// ---- Hash Functions ----

/**
 * P1.1: Complete deterministic strategy hash.
 * Includes: hypothesis id + features + interaction + feature transforms +
 *   label definition + topN + sleeves + holdDays + cost model + lambda grid + runner version.
 * Stable across runs for the same configuration.
 */
function computeStrategyHash(hypothesis, options) {
  var opts = options || {};
  var hash = crypto.createHash('sha256');
  hash.update(hypothesis.id);
  hash.update('|');
  hash.update(JSON.stringify((hypothesis.features || []).slice().sort()));
  hash.update('|');
  hash.update(hypothesis.interaction || 'none');
  hash.update('|');
  hash.update('target:forwardReturnT3');
  hash.update('|');
  hash.update('topN:' + (opts.topN || 50));
  hash.update('|');
  hash.update('sleeves:' + (opts.sleeves || 3));
  hash.update('|');
  hash.update('holdDays:' + (opts.holdDays || 3));
  hash.update('|');
  hash.update('maxPosPerSleeve:' + (opts.maxPositionsPerSleeve || 17));
  hash.update('|');
  hash.update('costModel:' + JSON.stringify(opts.costAssumptions || DEFAULT_COST_ASSUMPTIONS));
  hash.update('|');
  hash.update('lambdaGrid:' + JSON.stringify(LINEAR.LAMBDA_GRID));
  hash.update('|v1');
  return hash.digest('hex');
}

/**
 * Deterministic feature schema hash: feature names + source mapping.
 * Changes if the same feature name gets mapped to a different snapshot source.
 */
function computeFeatureSchemaHash(hypothesis) {
  var hash = crypto.createHash('sha256');
  var features = (hypothesis.features || []).slice().sort();
  var sourceMap = {};
  features.forEach(function (f) {
    switch (f) {
      case 'technical': case 'hidden':
        sourceMap[f] = 'dimensions'; break;
      case 'signalCount': case 'volatility20d':
      case 'changePct': case 'compositeScore':
        sourceMap[f] = 'topLevel'; break;
      default:
        sourceMap[f] = 'unknown';
    }
  });
  hash.update(JSON.stringify(features));
  hash.update('|');
  hash.update(JSON.stringify(sourceMap));
  hash.update('|v1');
  return hash.digest('hex');
}

/**
 * Deterministic snapshot hash: SHA256 of snapshot file contents for given dates.
 */
function computeSnapshotHash(dates) {
  return TWF.computeDataHashDates(dates);
}

/**
 * P1.1: Execution hash — cost assumptions digest.
 * Any change in commission, stamp tax, transfer fee, or slippage changes this hash.
 */
function computeExecutionHash(costAssumptions) {
  var ca = costAssumptions || DEFAULT_COST_ASSUMPTIONS;
  var hash = crypto.createHash('sha256');
  hash.update('costModel:v1|');
  hash.update(JSON.stringify(ca));
  return hash.digest('hex');
}

/**
 * P1.1: Window plan hash — deterministic hash of window definitions.
 */
function computeWindowPlanHash(windows) {
  var hash = crypto.createHash('sha256');
  hash.update('windows:v1|');
  hash.update(String(windows ? windows.length : 0));
  if (windows && windows.length > 0) {
    windows.forEach(function (w, i) {
      hash.update('|w' + i + ':');
      hash.update((w.trainDates && w.trainDates[0]) || '');
      hash.update('-');
      hash.update((w.trainDates && w.trainDates[w.trainDates.length - 1]) || '');
      hash.update('-');
      hash.update((w.testDates && w.testDates[0]) || '');
      hash.update('-');
      hash.update((w.testDates && w.testDates[w.testDates.length - 1]) || '');
    });
  }
  return hash.digest('hex');
}

/**
 * P1.1: findOrCreateCandidate — stable versionId from composite hash.
 * Same inputs (strategy + data + windows + execution) = same versionId.
 * Re-running with identical config resumes; re-running with changed config creates new version.
 */
function findOrCreateCandidate(hypothesis, strategyHash, featureSchemaHash, snapshotHash, windowPlanHash, executionHash, opts) {
  var REG = (opts && opts.registry) || CANDIDATE_REGISTRY;
  var composite = crypto.createHash('sha256');
  composite.update([strategyHash, featureSchemaHash, snapshotHash, windowPlanHash, executionHash].join('|'));
  var versionId = 'candidate_' + hypothesis.id + '_' + composite.digest('hex').slice(0, 16);

  // Check if already exists
  var existing = REG.getCandidates({ hypothesisId: hypothesis.id }).filter(function (c) {
    return c.versionId === versionId;
  });
  if (existing.length > 0) {
    console.log('[CandidateRunner] Candidate already exists: ' + versionId + ' — resuming');
    return { versionId: versionId, alreadyExists: true, candidate: existing[0] };
  }

  // Register new
  return REG.registerCandidate({
    hypothesisId: hypothesis.id,
    model: {},
    metrics: {},
    window: (opts && opts.windows && opts.windows.length > 0) ? {
      trainStart: opts.windows[0].trainDates[0],
      trainEnd: opts.windows[0].trainDates[opts.windows[0].trainDates.length - 1],
      testStart: opts.windows[0].testDates[0],
      testEnd: opts.windows[0].testDates[opts.windows[0].testDates.length - 1],
    } : {},
    artifactsPath: path.join(ARTIFACTS_DIR, hypothesis.id),
    strategyHash: strategyHash,
    featureSchemaHash: featureSchemaHash,
    snapshotHash: snapshotHash,
    windowPlanHash: windowPlanHash,
    executionHash: executionHash,
    versionId: versionId,
  });
}

// ---- Checkpoint / Resume ----

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

// ---- Single Window: Train → Validate → Test (hypothesis-specific) ----

function evaluateHypothesisWindow(windowDef, windowIndex, klineIdx, hypothesis, options) {
  var trainDates = windowDef.trainDates;
  var validateDates = windowDef.validateDates;
  var testDates = windowDef.testDates;
  var features = hypothesis.features;
  var opts = options || {};

  console.log('    Loading train data (' + trainDates.length + ' days)...');
  var trainSnaps = TWF.loadSnapshotDates(trainDates);
  console.log('      Train: ' + trainSnaps.length + ' samples');

  // P1.1: Use deriveFeatures when hypothesis has interaction
  var hasInteraction = !!(hypothesis.interaction);
  var nFeatures = features.length + (hasInteraction ? 1 : 0);

  // Step 1: Fit standardizer on training data only (using hypothesis-specific feature derivation)
  var rawTrainData = LINEAR.buildFeatureMatrixWithFeatures(trainSnaps, null, features, hypothesis);
  if (rawTrainData.nSamples < 50) {
    trainSnaps = null;
    return { error: 'insufficient_train_samples', nSamples: rawTrainData.nSamples };
  }
  var trainSampleCount = rawTrainData.nSamples;

  // Extract raw features (without intercept) for standardizer fitting
  var rawFeatures = [];
  for (var i = 0; i < rawTrainData.X.length; i++) {
    rawFeatures.push(rawTrainData.X[i].slice(1));
  }
  var standardizer = LINEAR.fitStandardizer(rawFeatures);
  rawFeatures = null;
  rawTrainData = null;
  console.log('      Standardizer fitted on ' + trainSampleCount + ' train samples (' + nFeatures + ' features' +
    (hasInteraction ? ', with interaction' : '') + ')');

  // Rebuild train with standardizer
  var trainData = LINEAR.buildFeatureMatrixWithFeatures(trainSnaps, standardizer, features, hypothesis);

  // Step 2: Grid search lambda on train/val
  console.log('    Loading validate data (' + validateDates.length + ' days)...');
  var valSnaps = TWF.loadSnapshotDates(validateDates);
  var valData = LINEAR.buildFeatureMatrixWithFeatures(valSnaps, standardizer, features, hypothesis);
  console.log('      Validate: ' + valData.nSamples + ' samples');

  console.log('    Grid searching lambda...');
  var best = LINEAR.gridSearchLambda(trainData.X, trainData.y, valData.X, valData.y);
  if (!best.model) {
    trainSnaps = null; valSnaps = null; trainData = null; valData = null;
    return { error: 'model_fit_failed' };
  }
  // P1.1: Feature names include interaction if applicable
  var displayFeatureNames = features.slice();
  if (hasInteraction) displayFeatureNames.push(hypothesis.interaction.replace(/\s+/g, '_'));
  best.model.featureNames = displayFeatureNames;
  console.log('      Best lambda=' + best.lambda + ' | Train MSE=' + Math.round(best.trainMSE * 100) / 100 + ' | Val MSE=' + Math.round(best.valMSE * 100) / 100);

  // Step 3: Refit on full train (train + validate) with best lambda
  var fullTrainSnaps = trainSnaps.concat(valSnaps);
  var valSnapCount = valSnaps.length;
  trainSnaps = null;
  valSnaps = null;

  var fullTrainData = LINEAR.buildFeatureMatrixWithFeatures(fullTrainSnaps, standardizer, features, hypothesis);
  var finalModel = LINEAR.fitRidge(fullTrainData.X, fullTrainData.y, best.lambda);
  if (!finalModel) {
    fullTrainSnaps = null; fullTrainData = null; trainData = null; valData = null;
    return { error: 'final_model_fit_failed' };
  }

  finalModel.intercept = Math.round(finalModel.intercept * 10000) / 10000;
  for (var wi = 0; wi < finalModel.weights.length; wi++) {
    finalModel.weights[wi] = Math.round(finalModel.weights[wi] * 10000) / 10000;
  }
  finalModel.featureNames = displayFeatureNames; // P1.1: includes interaction name

  // Release train/val data BEFORE loading test data
  fullTrainSnaps = null;
  fullTrainData = null;
  trainData = null;
  valData = null;

  if (typeof global !== 'undefined' && global.gc) { global.gc(); }

  // Step 4: Predict on test set (standardized, NO fitting)
  console.log('    Loading test data (' + testDates.length + ' days)...');
  var testSnaps = TWF.loadSnapshotDates(testDates);
  var testData = LINEAR.buildFeatureMatrixWithFeatures(testSnaps, standardizer, features, hypothesis);
  console.log('      Test: ' + testData.nSamples + ' samples');

  // P1.1: Predict and build daily rankings for simulator
  // CRITICAL FIX: Apply standardizer to each feature vector before predict().
  // The model was fit on standardized data; raw features would produce garbage.
  var dailyTestSignals = {};
  var allPredictions = [];

  testDates.forEach(function (testDate) {
    var daySnaps = testSnaps.filter(function (s) { return s.asOfDate === testDate; });
    if (daySnaps.length < 10) return;

    var dayPredictions = [];
    daySnaps.forEach(function (s) {
      // P1.1: Use deriveFeatures (respects interaction), get raw vector
      var featVec = hasInteraction
        ? LINEAR.deriveFeatures(s, hypothesis)
        : LINEAR.extractFeatureSubset(s, features);
      if (!featVec) return;

      // P1.1: STANDARDIZE before predict (same standardizer the model was fit with)
      var stdFeatVec = [];
      for (var fi = 0; fi < featVec.length; fi++) {
        stdFeatVec.push((featVec[fi] - standardizer.means[fi]) / standardizer.stds[fi]);
      }

      var pred = LINEAR.predict(finalModel, stdFeatVec);
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
    dailyTestSignals[testDate] = dayPredictions.slice(0, SIMULATOR.TOP_N_PER_COHORT || 50);
  });

  // Step 5: Run model predictions through trade simulator (P1.1: pass costAssumptions)
  console.log('    Simulating model portfolio...');
  var simulatorResult = SIMULATOR.simulatePortfolio(dailyTestSignals, {
    klineIdx: klineIdx,
    holdDays: SIMULATOR.HOLD_DAYS || 3,
    topN: SIMULATOR.TOP_N_PER_COHORT || 50,
    maxPositionsPerSleeve: SIMULATOR.MAX_POSITIONS_PER_SLEEVE || 17,
    costAssumptions: opts.costAssumptions || DEFAULT_COST_ASSUMPTIONS,
  });

  // Step 6: Per-date Rank IC
  var rankICs = [];
  testDates.forEach(function (testDate) {
    var daySnaps = testSnaps.filter(function (s) { return s.asOfDate === testDate; });
    var dayPreds = allPredictions.filter(function (p) { return p.asOfDate === testDate; });
    var ic = TWF.computeRankIC(daySnaps, dayPreds);
    if (ic != null) rankICs.push({ date: testDate, rankIC: Math.round(ic * 10000) / 10000 });
  });

  var avgRankIC = rankICs.length > 0
    ? Math.round(rankICs.reduce(function (s, r) { return s + r.rankIC; }, 0) / rankICs.length * 10000) / 10000
    : null;

  // Step 7: Decile calibration
  var decileCalibration = TWF.computeDecileCalibration(testSnaps, allPredictions);

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

  // Step 9: Random comparison (P1.2: executionConfig unified for candidate + random)
  console.log('    Computing random comparison...');
  var snapshotsByDate = {};
  testDates.forEach(function (testDate) {
    var daySnaps = testSnaps.filter(function (s) { return s.asOfDate === testDate; });
    var map = {};
    daySnaps.forEach(function (s) { map[s.code] = s; });
    if (Object.keys(map).length >= 10) {
      snapshotsByDate[testDate] = { map: map, list: daySnaps };
    }
  });

  var randomComparison = null;
  try {
    // P1.2: Pass executionConfig so candidate AND random use identical params
    var executionConfig = {
      costAssumptions: opts.costAssumptions || DEFAULT_COST_ASSUMPTIONS,
      topN: SIMULATOR.TOP_N_PER_COHORT || 50,
      holdDays: SIMULATOR.HOLD_DAYS || 3,
      maxPositionsPerSleeve: SIMULATOR.MAX_POSITIONS_PER_SLEEVE || 17,
      numSleeves: SIMULATOR.NUM_SLEEVES || 3,
      mcSamples: opts.monteCarloSamples || 100,
    };
    randomComparison = BASELINES.compareRankingsAgainstRandom(
      dailyTestSignals, snapshotsByDate, klineIdx, executionConfig
    );
  } catch (e) { randomComparison = { error: e.message }; }

  // Release test snapshots
  testSnaps = null;
  testData = null;

  // Step 10: Save artifacts to hypothesis-specific directory
  var winDir = path.join(ARTIFACTS_DIR, hypothesis.id, 'window_' + String(windowIndex + 1).padStart(3, '0'));
  if (!fs.existsSync(winDir)) fs.mkdirSync(winDir, { recursive: true });

  var trainHash = TWF.computeDataHashDates(trainDates.concat(validateDates));
  var testHash = TWF.computeDataHashDates(testDates);

  var hasInt = hasInteraction;

  // model.json
  fs.writeFileSync(path.join(winDir, 'model.json'), JSON.stringify({
    intercept: finalModel.intercept,
    weights: finalModel.weights,
    featureNames: displayFeatureNames,
    lambda: finalModel.lambda,
    nFeatures: finalModel.nFeatures,
    trainedAt: new Date().toISOString(),
    trainSamples: trainSampleCount,
    valSamples: valSnapCount || null,
    testSamples: simulatorResult ? simulatorResult.totalSignals : null,
    hypothesisId: hypothesis.id,
    interaction: hypothesis.interaction || null,
  }, null, 2), 'utf8');

  // standardizer.json
  fs.writeFileSync(path.join(winDir, 'standardizer.json'), JSON.stringify({
    featureNames: displayFeatureNames,
    means: standardizer.means,
    stds: standardizer.stds,
    fittedOn: 'train_only',
  }, null, 2), 'utf8');

  // feature_schema.json
  fs.writeFileSync(path.join(winDir, 'feature_schema.json'), JSON.stringify({
    features: features.map(function (name) {
      var source = 'topLevel';
      if (name === 'technical' || name === 'hidden') source = 'dimensions';
      return { name: name, source: source, type: 'numeric' };
    }),
    hypothesisId: hypothesis.id,
    interaction: hypothesis.interaction,
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
      featureNames: displayFeatureNames,
      lambda: finalModel.lambda,
      trainSamples: trainSampleCount,
      valSamples: valSnapCount,
      testSamples: simulatorResult.totalSignals || 0,
      interaction: hypothesis.interaction || null,
    },
    standardizer: {
      means: standardizer.means,
      stds: standardizer.stds,
      featureNames: displayFeatureNames,
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
      benchmarkTradeCount: simulatorResult.benchmarkTradeCount,
      benchmarkUnavailableCount: simulatorResult.benchmarkUnavailableCount,
      // P1.1: Cost model used for this simulation
      roundTripCostPct: (opts.costAssumptions || DEFAULT_COST_ASSUMPTIONS).roundTripCostPct,
    },
    decileCalibration: decileCalibration,
    // P1.1: vsRandom (random MC comparison), NOT vsBenchmark
    vsRandom: randomComparison && !randomComparison.error ? {
      modelNetReturn: simulatorResult.netReturn,
      modelGrossReturn: simulatorResult.grossReturn,
      randomMeanNetReturn: randomComparison.randomMeanNetReturn != null ? randomComparison.randomMeanNetReturn : null,
      pairedDelta_mean: randomComparison.pairedDelta_mean != null ? randomComparison.pairedDelta_mean : null,
      pairedDelta_ci95_lower: randomComparison.pairedDelta_ci95_lower != null ? randomComparison.pairedDelta_ci95_lower : null,
      pairedDelta_ci95_upper: randomComparison.pairedDelta_ci95_upper != null ? randomComparison.pairedDelta_ci95_upper : null,
      pValue: randomComparison.pValue != null ? randomComparison.pValue : null,
      monteCarloSamples: opts.monteCarloSamples || 100,
    } : { error: randomComparison ? randomComparison.error : 'unknown' },
    // P1.1: vsBenchmark (market index same-path from simulator)
    vsBenchmark: simulatorResult.benchmarkTradeCount > 0 ? {
      modelNetReturn: simulatorResult.netReturn,
      benchmarkReturn: simulatorResult.benchmarkReturn,
      netExcessReturn: simulatorResult.netExcessReturn,
      benchmarkTradeCount: simulatorResult.benchmarkTradeCount,
      benchmarkSource: 'sh_index_same_path',
    } : { status: 'unavailable', benchmarkTradeCount: 0 },
    artifactsPath: winDir,
  };
}

// ---- Main Entry: Evaluate ONE Hypothesis Across All Windows ----

/**
 * Run candidate evaluation for a single hypothesis.
 *
 * Research/Lock gating:
 *   Phase 1: Run windows 0-3 (research). After window 3 completes,
 *            candidate_registry auto-attempts promoteToShadowCandidate().
 *   Phase 2: Only if promotion succeeded (status=SHADOW_CANDIDATE),
 *            run windows 4-5 (lock confirmation).
 *
 * @param {object} options
 * @param {string} options.hypothesisId — 'H1', 'H2', or 'H3'
 * @param {object[]} options.windows — full OOS window definitions from OOS.generateWindows()
 * @param {object} options.klineIdx — pre-loaded kline index (shared across hypotheses)
 * @param {object} options.costAssumptions — cost model for trade simulation
 * @param {number} options.startWindow — override: first window to evaluate (default: 0)
 * @param {number} options.endWindow — override: last window to evaluate (default: from gate decision)
 * @param {number} options.monteCarloSamples — MC samples for baseline comparison (default: 100)
 * @returns {object} { hypothesisId, versionId, strategyHash, windows, status, verdict }
 */
function runCandidateEvaluation(options) {
  var opts = options || {};
  // P1.2: Accept injectable registry for test isolation
  var REG = opts.registry || CANDIDATE_REGISTRY;
  var hypothesisId = opts.hypothesisId;
  var hypothesis = REG.getHypothesis(hypothesisId);
  if (!hypothesis) return { error: 'unknown_hypothesis', hypothesisId: hypothesisId };

  // P1.3: smokeOnly flag — skip all state changes
  var isSmoke = !!opts.smokeOnly;
  // P1.3: windowsStart offset for correct windowIndex calculation
  var windowsStart = opts.windowsStart != null ? opts.windowsStart : 0;

  console.log('=== P1 Candidate Runner: ' + hypothesisId + ' (' + hypothesis.name + ')' +
    (isSmoke ? ' [SMOKE ONLY]' : '') + ' ===');
  console.log('Features: ' + hypothesis.features.join(', '));
  console.log('Interaction: ' + (hypothesis.interaction || 'none'));
  console.log();

  var costAssumptions = opts.costAssumptions || DEFAULT_COST_ASSUMPTIONS;
  var windows = opts.windows;
  if (!windows || windows.length === 0) {
    // Try to generate windows
    var winResult = OOS.generateWindows({});
    if (winResult.error) return { error: 'no_windows', detail: winResult.error };
    windows = winResult.windows;
  }

  // P1.1: Compute immutable hashes (complete — includes topN, sleeves, costs, etc.)
  var strategyHash = computeStrategyHash(hypothesis, {
    topN: SIMULATOR.TOP_N_PER_COHORT || 50,
    sleeves: SIMULATOR.NUM_SLEEVES || 3,
    holdDays: SIMULATOR.HOLD_DAYS || 3,
    maxPositionsPerSleeve: SIMULATOR.MAX_POSITIONS_PER_SLEEVE || 17,
    costAssumptions: costAssumptions,
  });
  var featureSchemaHash = computeFeatureSchemaHash(hypothesis);
  var allDates = [];
  windows.forEach(function (w) {
    allDates = allDates.concat(w.trainDates).concat(w.validateDates).concat(w.testDates);
  });
  var uniqueDates = {};
  allDates.forEach(function (d) { uniqueDates[d] = true; });
  allDates = Object.keys(uniqueDates);
  var snapshotHash = computeSnapshotHash(allDates);
  var windowPlanHash = computeWindowPlanHash(windows);
  var executionHash = computeExecutionHash(costAssumptions);

  console.log('Strategy Hash: ' + strategyHash.slice(0, 16) + '...');
  console.log('Feature Schema Hash: ' + featureSchemaHash.slice(0, 16) + '...');
  console.log('Snapshot Hash: ' + snapshotHash.slice(0, 16) + '...');
  console.log('Window Plan Hash: ' + windowPlanHash.slice(0, 16) + '...');
  console.log('Execution Hash: ' + executionHash.slice(0, 16) + '...');
  console.log('Windows: ' + windows.length + ' total');
  console.log();

  // P1.3: In smokeOnly mode, skip registry entirely — generate versionId locally
  var regResult, versionId, candidate, promotedToShadow;
  var completedInProgress = {};

  if (isSmoke) {
    // Smoke mode: versionId = smoke_<hypothesisId>_<timestamp_8char> — not persisted
    versionId = 'smoke_' + hypothesisId + '_' + Date.now().toString(36).slice(-8);
    console.log('Smoke versionId: ' + versionId + ' (ephemeral, not persisted)');
    console.log();
  } else {
    // P1.2: findOrCreateCandidate — stable versionId from composite hash, injectable registry
    regResult = findOrCreateCandidate(hypothesis, strategyHash, featureSchemaHash,
      snapshotHash, windowPlanHash, executionHash, { windows: windows, registry: REG });

    if (regResult.error) {
      console.error('Failed to register candidate: ' + regResult.error);
      return regResult;
    }
    versionId = regResult.versionId;
    if (regResult.alreadyExists) {
      console.log('Resuming: ' + versionId + ' (same strategy+data+execution = same candidate)');
    } else {
      console.log('Registered new: ' + versionId);
    }
    console.log();

    // P1.4-B: Always write full 6-window plan (allWindows) to registry, not the sliced subset.
    // windowsStart/windowsEnd only control which absolute windowIndex values execute this run.
    // Check if windows already set (resume scenario) — don't overwrite existing plan.
    var existingWinCount = REG.getStatus().evaluationWindows.total;
    if (existingWinCount === 0) {
      var fullWins = opts.allWindows || windows;
      REG.setEvaluationWindows(fullWins.map(function (w) {
        return {
          trainStart: w.trainDates[0],
          trainEnd: w.trainDates[w.trainDates.length - 1],
          testStart: w.testDates[0],
          testEnd: w.testDates[w.testDates.length - 1],
        };
      }));
    } else {
      console.log('[CandidateRegistry] Windows already set (' + existingWinCount + ' total), preserving existing plan');
    }

    // P1.2: Checkpoint/resume — union of registry evaluatedWindows + progress file
    var progress = _loadProgress();
    var progKey = hypothesisId + '_' + versionId;

    // Source 1: Registry (candidate.evaluatedWindows)
    candidate = REG.getCandidates({ hypothesisId: hypothesisId }).filter(function (c) {
      return c.versionId === versionId;
    })[0];
    if (candidate && candidate.evaluatedWindows) {
      candidate.evaluatedWindows.forEach(function (wi) {
        completedInProgress[wi] = true;
      });
    }

    // Source 2: Progress file (union — catches progress-only evaluations)
    if (progress && progress[progKey] && progress[progKey].completedWindows) {
      progress[progKey].completedWindows.forEach(function (wi) {
        completedInProgress[wi] = true;
      });
    }

    var completedCount = Object.keys(completedInProgress).length;
    if (completedCount > 0) {
      console.log('Resuming: ' + completedCount + ' windows already complete (registry + progress union)');
      console.log();
    }
  }

  var klineIdx = opts.klineIdx;
  var ownKlineIdx = false;
  if (!klineIdx) {
    console.log('Loading kline index...');
    klineIdx = SIMULATOR.loadKlineIndex();
    console.log('Kline index: ' + Object.keys(klineIdx).length + ' stocks');
    console.log();
    ownKlineIdx = true;
  }

  // ---- Phase 1: Research windows (0-3) ----
  // P1.3: When smokeOnly, iterate all selected windows directly (no registry dependency).
  // In normal mode, use registry's research window indices.
  // When window subset is used (windowsStart > 0 or limited windowsEnd),
  // only evaluate research windows that fall within the selected subset.
  var researchIndices;
  if (isSmoke) {
    // P1.3: Smoke mode — evaluate all selected windows directly (registry bypassed)
    researchIndices = [];
    for (var sri = 0; sri < windows.length; sri++) {
      researchIndices.push(sri);
    }
  } else {
    researchIndices = REG.getResearchWindowIndices();
  }
  var results = [];
  var allResearchComplete = true;

  for (var ri = 0; ri < researchIndices.length; ri++) {
    var wi = researchIndices[ri];
    if (wi >= windows.length) break;
    // P1.3: Check if this window index falls within selected range
    // wi is the index within the SELECTED windows array;
    // the actual research window index = windowsStart + wi
    // But for completedInProgress, we use the absolute index
    var absWi = windowsStart + wi;

    if (completedInProgress[absWi]) {
      console.log('Window ' + (wi + 1) + '/' + windows.length + ' (research): SKIPPED (already complete)');
      continue;
    }

    console.log('Window ' + (wi + 1) + '/' + windows.length + ' (research):');
    var result = evaluateHypothesisWindow(windows[wi], absWi, klineIdx, hypothesis, {
      monteCarloSamples: opts.monteCarloSamples || 100,
      costAssumptions: costAssumptions,
    });

    if (result.error) {
      console.log('  ERROR: ' + result.error);
      allResearchComplete = false;
      continue;
    }

    results.push(result);

    // Determine benchmark status (P0.2 convention)
    var benchmarkStatus = 'unavailable';
    if (result.portfolio && result.portfolio.benchmarkTradeCount > 0) {
      benchmarkStatus = 'available';
    }

    // Record evaluation in candidate_registry with full identity fields
    var evalRecord = {
      rankIC: result.metrics.avgRankIC,
      netReturn: result.portfolio ? result.portfolio.netReturn : null,
      grossReturn: result.portfolio ? result.portfolio.grossReturn : null,
      benchmarkReturn: result.portfolio ? result.portfolio.benchmarkReturn : null,
      netExcessReturn: result.portfolio ? result.portfolio.netExcessReturn : null,
      // P1.2: deltaCI from vsRandom empirical quantile CI (NOT from old vsBenchmark)
      deltaCI: result.vsRandom && result.vsRandom.pairedDelta_ci95_lower != null
        ? [result.vsRandom.pairedDelta_ci95_lower, result.vsRandom.pairedDelta_ci95_upper] : null,
      directionAccuracy: result.metrics.directionAccuracy,
      // P1.2: Full identity fields
      candidateVersionId: versionId,
      hypothesisId: hypothesisId,
      strategyHash: strategyHash,
      featureSchemaHash: featureSchemaHash,
      snapshotHash: snapshotHash,
      windowPlanHash: windowPlanHash,
      executionHash: executionHash,
      windowId: 'window_' + String(absWi + 1).padStart(3, '0'),
      costAssumptions: costAssumptions,
      benchmarkStatus: benchmarkStatus,
      windowDates: {
        trainStart: result.window.trainStart,
        trainEnd: result.window.trainEnd,
        validateStart: result.window.validateStart,
        validateEnd: result.window.validateEnd,
        testStart: result.window.testStart,
        testEnd: result.window.testEnd,
      },
    };

    // P1.3: Skip registry + progress writes in smokeOnly mode
    if (isSmoke) {
      console.log('  [Smoke] Data recorded to result only (no registry/progress write)');
    } else {
      var recResult = REG.recordEvaluation(versionId, absWi, evalRecord);
      console.log('  Recorded: ' + (recResult.recorded ? 'yes' : recResult.error || 'no'));
    }
    console.log('  Test MSE: ' + result.metrics.testMSE + ' | Dir Acc: ' + result.metrics.directionAccuracy + '%');
    console.log('  Rank IC: ' + result.metrics.avgRankIC + ' | Net: ' + (result.portfolio ? result.portfolio.netReturn + '%' : 'N/A'));
    console.log('  Benchmark: ' + benchmarkStatus);

    // Checkpoint after each window (skip in smoke mode)
    if (!isSmoke) {
      if (!progress) progress = {};
      if (!progress[progKey]) progress[progKey] = { hypothesisId: hypothesisId, versionId: versionId, completedWindows: [] };
      if (progress[progKey].completedWindows.indexOf(absWi) < 0) {
        progress[progKey].completedWindows.push(absWi);
      }
      _saveProgress(progress);
    }

    // Hint GC between windows
    if (typeof global !== 'undefined' && global.gc) { global.gc(); }
    console.log();
  }

  // P1.3: In smokeOnly mode, skip promotion check and lock windows entirely
  if (isSmoke) {
    console.log('[Smoke] Skipping promotion check + lock windows (smokeOnly mode)');
    console.log();
  } else {
    // After all research windows: check promotion status
    candidate = REG.getCandidates({}).filter(function (c) {
      return c.versionId === versionId;
    })[0];

    promotedToShadow = candidate && candidate.status === 'SHADOW_CANDIDATE';

    if (!promotedToShadow) {
      console.log('[CandidateRunner] Research phase complete — candidate is RESEARCH_ONLY');
      console.log('[CandidateRunner] Lock windows (4-5) require SHADOW_CANDIDATE — skipping');
      console.log('[CandidateRunner] Reason: promotion gates not passed or auto-promotion pending');
    }

    // ---- Phase 2: Lock windows (4-5) — ONLY if SHADOW_CANDIDATE ----
    if (promotedToShadow) {
      console.log();
      console.log('=== Phase 2: Lock Confirmation Windows ===');
      console.log('Status: SHADOW_CANDIDATE — lock windows permitted');
      console.log();

      var lockIndices = REG.getLockWindowIndices();

      for (var li = 0; li < lockIndices.length; li++) {
        var lwi = lockIndices[li];
        if (lwi >= windows.length) break;
        if (completedInProgress[lwi]) {
          console.log('Window ' + (lwi + 1) + '/' + windows.length + ' (lock): SKIPPED (already complete)');
          continue;
        }

        console.log('Window ' + (lwi + 1) + '/' + windows.length + ' (lock):');
        var lresult = evaluateHypothesisWindow(windows[lwi], lwi, klineIdx, hypothesis, {
          monteCarloSamples: opts.monteCarloSamples || 100,
          costAssumptions: costAssumptions,
        });

        if (lresult.error) {
          console.log('  ERROR: ' + lresult.error);
          continue;
        }

        results.push(lresult);

        var lBenchmarkStatus = 'unavailable';
        if (lresult.portfolio && lresult.portfolio.benchmarkTradeCount > 0) {
          lBenchmarkStatus = 'available';
        }

        var lEvalRecord = {
          rankIC: lresult.metrics.avgRankIC,
          netReturn: lresult.portfolio ? lresult.portfolio.netReturn : null,
          grossReturn: lresult.portfolio ? lresult.portfolio.grossReturn : null,
          benchmarkReturn: lresult.portfolio ? lresult.portfolio.benchmarkReturn : null,
          netExcessReturn: lresult.portfolio ? lresult.portfolio.netExcessReturn : null,
          // P1.2: Lock windows use vsRandom empirical delta CI (same as research windows)
          deltaCI: lresult.vsRandom && lresult.vsRandom.pairedDelta_ci95_lower != null
            ? [lresult.vsRandom.pairedDelta_ci95_lower, lresult.vsRandom.pairedDelta_ci95_upper] : null,
          directionAccuracy: lresult.metrics.directionAccuracy,
          candidateVersionId: versionId,
          hypothesisId: hypothesisId,
          strategyHash: strategyHash,
          featureSchemaHash: featureSchemaHash,
          snapshotHash: snapshotHash,
          windowPlanHash: windowPlanHash,
          executionHash: executionHash,
          windowId: 'window_' + String(lwi + 1).padStart(3, '0'),
          costAssumptions: costAssumptions,
          benchmarkStatus: lBenchmarkStatus,
          windowDates: {
            trainStart: lresult.window.trainStart,
            trainEnd: lresult.window.trainEnd,
            validateStart: lresult.window.validateStart,
            validateEnd: lresult.window.validateEnd,
            testStart: lresult.window.testStart,
            testEnd: lresult.window.testEnd,
          },
        };

        REG.recordEvaluation(versionId, lwi, lEvalRecord);
        console.log('  Test MSE: ' + lresult.metrics.testMSE + ' | Dir Acc: ' + lresult.metrics.directionAccuracy + '%');
        console.log('  Rank IC: ' + lresult.metrics.avgRankIC + ' | Net: ' + (lresult.portfolio ? lresult.portfolio.netReturn + '%' : 'N/A'));
        console.log('  Benchmark: ' + lBenchmarkStatus);

        if (!progress[progKey]) progress[progKey] = { hypothesisId: hypothesisId, versionId: versionId, completedWindows: [] };
        if (progress[progKey].completedWindows.indexOf(lwi) < 0) {
          progress[progKey].completedWindows.push(lwi);
        }
        _saveProgress(progress);

        if (typeof global !== 'undefined' && global.gc) { global.gc(); }
        console.log();
      }

      // Generate final verdict
      var verdict = REG.getFinalVerdict(versionId);
      console.log('=== Final Verdict ===');
      console.log('Verdict: ' + (verdict.verdict || 'pending'));
      console.log('Recommendation: ' + (verdict.recommendation || 'N/A'));
      if (verdict.lockConfirmation) {
        console.log('Lock Confirmed: ' + verdict.lockConfirmation.confirmed);
        console.log('Lock Avg Rank IC: ' + verdict.lockConfirmation.lockAvgRankIC);
        console.log('Lock Avg Net Return: ' + verdict.lockConfirmation.lockAvgNetReturn);
        console.log('Lock Positive Windows: ' + verdict.lockConfirmation.lockPositiveWindows + '/' + verdict.lockConfirmation.lockTotalWindows);
      }
    }
  }

  // Cleanup
  if (ownKlineIdx) klineIdx = null;
  if (typeof global !== 'undefined' && global.gc) { global.gc(); }

  // Clean up progress for this completed run (skip in smoke mode)
  if (!isSmoke && progress && progress[progKey]) {
    delete progress[progKey];
    _saveProgress(progress);
  }

  var status = (isSmoke ? 'SMOKE_ONLY' : (candidate ? candidate.status : 'RESEARCH_ONLY'));
  return {
    hypothesisId: hypothesisId,
    versionId: versionId,
    strategyHash: strategyHash,
    featureSchemaHash: featureSchemaHash,
    snapshotHash: snapshotHash,
    executionHash: executionHash,
    windowsEvaluated: results.length,
    windowsTotal: windows.length,
    status: status,
    verdict: promotedToShadow
      ? (REG.getFinalVerdict(versionId).verdict || 'pending')
      : (isSmoke ? 'SMOKE_ONLY — window 0 evaluated, no lock/promotion' : 'RESEARCH_ONLY — lock windows not evaluated'),
    windows: results,
  };
}

// ---- Convenience: Run All Hypotheses ----

/**
 * Run candidate evaluation for all configured hypotheses sequentially.
 * Loads the kline index once and shares it across all hypothesis runs.
 *
 * @param {object} options — passed through to runCandidateEvaluation
 * @returns {object[]} array of per-hypothesis results
 */
function runAllHypotheses(options) {
  var opts = options || {};
  var isSmoke = !!opts.smokeOnly;

  // P1.3: smokeOnly mode — single window, hypothesis from opts or default H1
  if (isSmoke) {
    opts.hypotheses = opts.hypotheses || ['H1'];
    opts.windowsStart = 0;
    opts.windowsEnd = 0;
    console.log('=== P1.3 SMOKE TEST: ' + opts.hypotheses.join(', ') + ' Window 0 Only ===');
    console.log('Mode: smokeOnly — NO registry writes, NO progress writes, NO state changes');
    console.log();
  }

  var hypothesisIds = opts.hypotheses || ['H1', 'H2', 'H3'];
  var windowsStart = opts.windowsStart != null ? opts.windowsStart : 0;
  var windowsEnd = opts.windowsEnd != null ? opts.windowsEnd : undefined;

  if (!isSmoke) {
    console.log('=== P1 Candidate Runner: All Hypotheses ===');
    console.log('Hypotheses: ' + hypothesisIds.join(', '));
    console.log('Windows: ' + windowsStart + ' → ' + (windowsEnd != null ? windowsEnd : 'end'));
    console.log();
  }

  // Load kline index once
  console.log('Loading kline index (shared across hypotheses)...');
  var klineIdx = SIMULATOR.loadKlineIndex();
  console.log('Kline index: ' + Object.keys(klineIdx).length + ' stocks');
  console.log();

  // Generate windows once
  var winResult = OOS.generateWindows(opts);
  if (winResult.error) {
    console.error('Error generating windows: ' + winResult.error);
    return [{ error: 'window_generation_failed', detail: winResult.error }];
  }
  var allWindows = winResult.windows;
  console.log('Total available windows: ' + allWindows.length);

  // P1.3: Apply window range — single-window for smoke, configurable subset otherwise
  var windows = allWindows.slice(windowsStart, (windowsEnd != null ? windowsEnd + 1 : undefined));
  if (windows.length !== allWindows.length) {
    console.log('Selected windows: ' + windowsStart + ' → ' + (windowsEnd != null ? windowsEnd : allWindows.length - 1) + ' (' + windows.length + ' windows)');
  }
  console.log();

  var allResults = [];
  for (var hi = 0; hi < hypothesisIds.length; hi++) {
    var hid = hypothesisIds[hi];
    console.log('━━━ ' + hid + ' ━━━');
    var result = runCandidateEvaluation({
      hypothesisId: hid,
      windows: windows,
      allWindows: allWindows,     // P1.3: pass full list for index resolution
      windowsStart: windowsStart, // P1.3: pass offset for windowIndex calculation
      klineIdx: klineIdx,
      costAssumptions: opts.costAssumptions,
      monteCarloSamples: opts.monteCarloSamples,
      smokeOnly: isSmoke,         // P1.3: flag for no-side-effects mode
    });
    allResults.push(result);
    console.log();
  }

  // Cleanup
  klineIdx = null;
  if (typeof global !== 'undefined' && global.gc) { global.gc(); }

  // P1.3: Write smoke summary if smokeOnly
  if (isSmoke) {
    _writeSmokeSummary(allResults[0], windows, opts);
  }

  if (!isSmoke) {
    // Summary
    console.log('=== All Hypotheses Summary ===');
    for (var ai = 0; ai < allResults.length; ai++) {
      var ar = allResults[ai];
      console.log(ar.hypothesisId + ': ' + ar.versionId + ' | status=' + ar.status +
        ' | windows=' + ar.windowsEvaluated + '/' + ar.windowsTotal +
        ' | strategyHash=' + (ar.strategyHash ? ar.strategyHash.slice(0, 12) + '...' : 'N/A'));
    }
  }

  return allResults;
}

/**
 * P1.3: Write smoke_summary.json for smokeOnly mode.
 * Contains snapshotHash, window dates, sample counts, executionHash,
 * actual costs, actual trade count, benchmark status, random CI, Rank IC,
 * coverage info, and any failure reasons.
 */
function _writeSmokeSummary(result, windows, opts) {
  var hypothesisId = (result && result.hypothesisId) || 'H1';
  var summaryPath = path.join(ARTIFACTS_DIR, 'smoke_summary_' + hypothesisId.toLowerCase() + '.json');
  try {
    if (!fs.existsSync(ARTIFACTS_DIR)) fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  } catch (_) {}

  var windowResult = (result && result.windows && result.windows.length > 0) ? result.windows[0] : null;
  var smoke = {
    mode: 'smokeOnly',
    hypothesisId: result ? result.hypothesisId : 'H1',
    runAt: new Date().toISOString(),
    windowIndex: 0,
    dataHash: null,
    snapshotHash: result ? result.snapshotHash : null,
    windowHash: null,
    executionHash: null,
    windowDates: {
      trainStart: windows && windows[0] ? windows[0].trainDates[0] : null,
      trainEnd: windows && windows[0] ? windows[0].trainDates[windows[0].trainDates.length - 1] : null,
      validateStart: windows && windows[0] ? windows[0].validateDates[0] : null,
      validateEnd: windows && windows[0] ? windows[0].validateDates[windows[0].validateDates.length - 1] : null,
      testStart: windows && windows[0] ? windows[0].testDates[0] : null,
      testEnd: windows && windows[0] ? windows[0].testDates[windows[0].testDates.length - 1] : null,
    },
    samples: {
      train: null,
      validate: null,
      test: null,
    },
    costs: {
      roundTripCostPct: null,
      commissionRate: null,
      stampTaxRate: null,
      transferFeeRate: null,
      slippagePct: null,
    },
    execution: {
      executionHash: null,
      executedTrades: null,
      totalSignals: null,
      actualRoundTripCostPct: null,
    },
    benchmark: {
      status: 'unavailable',
      tradeCount: null,
      unavailableCount: null,
      return: null,
    },
    randomControl: {
      monteCarloSamples: null,
      pairedDelta_ci95_lower: null,
      pairedDelta_ci95_upper: null,
      pairedDelta_mean: null,
      pValue: null,
    },
    metrics: {
      avgRankIC: null,
      rankICDays: null,
      directionAccuracy: null,
      testMSE: null,
    },
    portfolio: {
      netReturn: null,
      grossReturn: null,
      netExcessReturn: null,
      sharpeRatio: null,
      maxDrawdownBps: null,
    },
    coverage: {
      totalSnapshotsAvailable: null,
      windowsAvailable: null,
    },
    errors: [],
    verdict: 'pending',
  };

  // Fill from result
  if (windowResult) {
    smoke.executionHash = result.executionHash || null;

    if (windowResult.window) {
      smoke.samples.train = windowResult.model ? windowResult.model.trainSamples : null;
      smoke.samples.validate = windowResult.model ? windowResult.model.valSamples : null;
      smoke.samples.test = windowResult.model ? windowResult.model.testSamples : null;
    }

    if (windowResult.portfolio) {
      var p = windowResult.portfolio;
      smoke.execution.executedTrades = p.executedTrades;
      smoke.execution.totalSignals = p.totalSignals;
      smoke.execution.actualRoundTripCostPct = p.roundTripCostPct;
      smoke.portfolio.netReturn = p.netReturn;
      smoke.portfolio.grossReturn = p.grossReturn;
      smoke.portfolio.netExcessReturn = p.netExcessReturn;
      smoke.portfolio.sharpeRatio = p.sharpeRatio;
      smoke.portfolio.maxDrawdownBps = p.maxDrawdownBps;
    }

    if (windowResult.vsBenchmark) {
      smoke.benchmark.status = windowResult.vsBenchmark.status || (windowResult.vsBenchmark.benchmarkTradeCount > 0 ? 'available' : 'unavailable');
      smoke.benchmark.tradeCount = windowResult.vsBenchmark.benchmarkTradeCount;
      smoke.benchmark.return = windowResult.vsBenchmark.benchmarkReturn;
    }

    if (windowResult.vsRandom && !windowResult.vsRandom.error) {
      smoke.randomControl.monteCarloSamples = windowResult.vsRandom.monteCarloSamples;
      smoke.randomControl.pairedDelta_ci95_lower = windowResult.vsRandom.pairedDelta_ci95_lower;
      smoke.randomControl.pairedDelta_ci95_upper = windowResult.vsRandom.pairedDelta_ci95_upper;
      smoke.randomControl.pairedDelta_mean = windowResult.vsRandom.pairedDelta_mean;
      smoke.randomControl.pValue = windowResult.vsRandom.pValue;
    }

    if (windowResult.metrics) {
      smoke.metrics.avgRankIC = windowResult.metrics.avgRankIC;
      smoke.metrics.rankICDays = windowResult.metrics.rankICDays;
      smoke.metrics.directionAccuracy = windowResult.metrics.directionAccuracy;
      smoke.metrics.testMSE = windowResult.metrics.testMSE;
    }

    if (opts && opts.costAssumptions) {
      smoke.costs.roundTripCostPct = opts.costAssumptions.roundTripCostPct;
      smoke.costs.commissionRate = opts.costAssumptions.commissionRate;
      smoke.costs.stampTaxRate = opts.costAssumptions.stampTaxRate;
      smoke.costs.transferFeeRate = opts.costAssumptions.transferFeeRate;
      smoke.costs.slippagePct = opts.costAssumptions.slippagePct;
    }
  }

  // Errors
  if (result && result.error) {
    smoke.errors.push('runner_error: ' + result.error);
  }
  if (windowResult && windowResult.error) {
    smoke.errors.push('window_error: ' + windowResult.error);
  }
  if (windowResult && windowResult.vsRandom && windowResult.vsRandom.error) {
    smoke.errors.push('random_control_error: ' + windowResult.vsRandom.error);
  }

  // Verdict
  var hasSamples = smoke.samples.test > 0 || smoke.samples.train > 0;
  var hasTrades = smoke.execution.executedTrades > 0;
  var hasRandom = smoke.randomControl.pairedDelta_ci95_lower != null;
  if (!hasSamples) {
    smoke.verdict = 'failed: no samples loaded';
  } else if (!hasTrades) {
    smoke.verdict = 'inconclusive: zero trades executed';
  } else if (!hasRandom) {
    smoke.verdict = 'inconclusive: random control unavailable';
  } else if (smoke.errors.length > 0) {
    smoke.verdict = 'completed with warnings';
  } else {
    smoke.verdict = 'completed: samples ok, trades ok, random control available';
  }

  try {
    fs.writeFileSync(summaryPath, JSON.stringify(smoke, null, 2), 'utf8');
    console.log('Smoke summary written: ' + summaryPath);
  } catch (e) {
    console.error('Failed to write smoke summary: ' + e.message);
  }

  return smoke;
}

// ---- CLI ----

if (require.main === module) {
  var hypothesisId = process.argv[2] || 'H1';
  var startDate = process.argv[3] || '2023-10-30';
  var endDate = process.argv[4] || '2026-06-15';

  if (hypothesisId === 'all') {
    runAllHypotheses({ startDate: startDate, endDate: endDate });
  } else {
    var winResult = OOS.generateWindows({ startDate: startDate, endDate: endDate });
    if (winResult.error) {
      console.error('Error generating windows: ' + winResult.error);
      process.exit(1);
    }
    var klineIdx = SIMULATOR.loadKlineIndex();
    runCandidateEvaluation({
      hypothesisId: hypothesisId,
      windows: winResult.windows,
      klineIdx: klineIdx,
    });
  }
}

module.exports = {
  runCandidateEvaluation,
  runAllHypotheses,
  evaluateHypothesisWindow,
  computeStrategyHash,
  computeFeatureSchemaHash,
  computeSnapshotHash,
  computeExecutionHash,
  computeWindowPlanHash,
  findOrCreateCandidate,
};
