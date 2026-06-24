/**
 * P1: Linear Model — Ridge Regression with Standardization + Intercept
 *
 * Closed-form ridge regression:  β = (XᵀX + λI)⁻¹ Xᵀy
 * No gradient descent, no auto-differentiation, no neural networks.
 *
 * P1 upgrades:
 *  — Feature standardization: fit mean/std on training data, apply to val/test
 *  — Unregularized intercept: prepend column of 1s, exclude intercept from λ penalty
 *  — Fixed λ grid: [0.001, 0.01, 0.1, 1, 10]
 *  — Pure JS matrix ops
 *
 * Features (only real PIT data):
 *  — technical dimension score, hidden dimension score
 *  — signalCount, volatility20d, changePct
 *
 * Target: forwardReturnT3 (T+1 open → T+4 close gross return, post P0-1)
 *
 * Shadow only: model artifacts saved, never fed to live simfolio.
 */

var fs = require('fs');
var path = require('path');

// ---- Matrix operations (pure JS, no external deps) ----

function transpose(M) {
  var rows = M.length, cols = M[0].length;
  var MT = [];
  for (var j = 0; j < cols; j++) {
    MT[j] = [];
    for (var i = 0; i < rows; i++) MT[j][i] = M[i][j];
  }
  return MT;
}

function matMul(A, B) {
  // A: m×n, B: n×p → result: m×p
  var m = A.length, n = A[0].length, p = B[0].length;
  var C = [];
  for (var i = 0; i < m; i++) {
    C[i] = [];
    for (var j = 0; j < p; j++) {
      var sum = 0;
      for (var k = 0; k < n; k++) sum += A[i][k] * B[k][j];
      C[i][j] = sum;
    }
  }
  return C;
}

function matAdd(A, B) {
  for (var i = 0; i < A.length; i++)
    for (var j = 0; j < A[0].length; j++)
      A[i][j] += B[i][j];
  return A;
}

function identityMatrix(n) {
  var I = [];
  for (var i = 0; i < n; i++) {
    I[i] = [];
    for (var j = 0; j < n; j++) I[i][j] = i === j ? 1 : 0;
  }
  return I;
}

function invert2x2(M) {
  // Special case: 2×2 inversion (faster, more stable)
  var a = M[0][0], b = M[0][1], c = M[1][0], d = M[1][1];
  var det = a * d - b * c;
  if (Math.abs(det) < 1e-15) return null;
  var invDet = 1 / det;
  return [[d * invDet, -b * invDet], [-c * invDet, a * invDet]];
}

function invertMatrix(M) {
  // Gaussian elimination with partial pivoting (for n×n matrix)
  var n = M.length;
  if (n === 2) return invert2x2(M);

  // Augmented matrix [M | I]
  var aug = [];
  for (var i = 0; i < n; i++) {
    aug[i] = [];
    for (var j = 0; j < n; j++) aug[i][j] = M[i][j];
    for (var j = 0; j < n; j++) aug[i][n + j] = i === j ? 1 : 0;
  }

  for (var col = 0; col < n; col++) {
    // Find pivot
    var maxRow = col, maxVal = Math.abs(aug[col][col]);
    for (var row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > maxVal) {
        maxVal = Math.abs(aug[row][col]);
        maxRow = row;
      }
    }
    if (maxVal < 1e-15) return null; // Singular

    // Swap rows
    var tmp = aug[col]; aug[col] = aug[maxRow]; aug[maxRow] = tmp;

    // Eliminate
    var pivot = aug[col][col];
    for (var j = col; j < 2 * n; j++) aug[col][j] /= pivot;

    for (var row = 0; row < n; row++) {
      if (row === col) continue;
      var factor = aug[row][col];
      for (var j = col; j < 2 * n; j++) aug[row][j] -= factor * aug[col][j];
    }
  }

  // Extract inverse
  var inv = [];
  for (var i = 0; i < n; i++) {
    inv[i] = [];
    for (var j = 0; j < n; j++) inv[i][j] = aug[i][n + j];
  }
  return inv;
}

// ---- Feature extraction (only real PIT data) ----

var FEATURE_NAMES = ['technical', 'hidden', 'signalCount', 'volatility20d', 'changePct'];

function extractFeatures(snapshot) {
  if (!snapshot) return null;

  var dims = snapshot.dimensions || {};
  var technical = dims.technical;
  var hidden = dims.hidden;

  // Require both real dimensions to be present
  if (technical == null || hidden == null) return null;

  return [
    technical,
    hidden,
    snapshot.signalCount || 0,
    snapshot.volatility20d || 0,
    snapshot.changePct || 0,
  ];
}

// ---- P1: Feature Subset Extraction (per-hypothesis feature selection) ----

/**
 * Extract a subset of features from a snapshot, specified by featureName list.
 * Maps feature names to their snapshot sources:
 *   'technical'       → dimensions.technical
 *   'hidden'          → dimensions.hidden
 *   'signalCount'     → top-level signalCount
 *   'volatility20d'   → top-level volatility20d
 *   'changePct'       → top-level changePct
 *   'compositeScore'  → top-level compositeScore
 *
 * Returns null if ANY requested feature's source is missing (strict — no zero-fill).
 * For top-level numeric fields (signalCount, volatility20d, changePct, compositeScore),
 * missing values default to 0 (matching existing extractFeatures behavior).
 *
 * @param {object} snapshot
 * @param {string[]} featureNames — e.g., ['technical', 'volatility20d'] for H1
 * @returns {number[]|null}
 */
function extractFeatureSubset(snapshot, featureNames) {
  if (!snapshot || !featureNames || featureNames.length === 0) return null;

  var dims = snapshot.dimensions || {};
  var result = [];

  for (var fi = 0; fi < featureNames.length; fi++) {
    var name = featureNames[fi];
    var val = null;

    switch (name) {
      case 'technical':
        val = dims.technical;
        break;
      case 'hidden':
        val = dims.hidden;
        break;
      case 'signalCount':
        val = snapshot.signalCount != null ? snapshot.signalCount : 0;
        break;
      case 'volatility20d':
        val = snapshot.volatility20d != null ? snapshot.volatility20d : 0;
        break;
      case 'changePct':
        val = snapshot.changePct != null ? snapshot.changePct : 0;
        break;
      case 'compositeScore':
        val = snapshot.compositeScore != null ? snapshot.compositeScore : 0;
        break;
      default:
        // Unknown feature name — return null (fail closed)
        return null;
    }

    if (val == null) return null; // Non-nullable source missing (technical, hidden)
    result.push(val);
  }

  return result;
}

// ---- P1.1: Feature Derivation (hypothesis-specific interaction terms) ----

/**
 * Apply a hypothesis's interaction formula to derive a new feature value.
 * Supported interactions:
 *   — 'technical / (1 + volatility20d)' → H1: inverse-vol-weighted technical
 *   — 'signalCount * compositeScore'     → H3: signal confluence amplification
 *   — null (H2)                           → no interaction
 *
 * @param {object} snapshot
 * @param {object} hypothesis — { id, features, interaction }
 * @returns {number|null} derived interaction value, or null if unavailable
 */
function applyInteraction(snapshot, hypothesis) {
  if (!snapshot || !hypothesis || !hypothesis.interaction) return null;

  var interaction = hypothesis.interaction;
  var dims = snapshot.dimensions || {};

  // H1: technical / (1 + volatility20d)
  if (interaction === 'technical / (1 + volatility20d)') {
    var tech = dims.technical;
    var vol20 = snapshot.volatility20d != null ? snapshot.volatility20d : 0;
    if (tech == null) return null;
    return tech / (1 + Math.abs(vol20));
  }

  // H3: signalCount * compositeScore
  if (interaction === 'signalCount * compositeScore') {
    var sigCnt = snapshot.signalCount != null ? snapshot.signalCount : 0;
    var compScore = snapshot.compositeScore != null ? snapshot.compositeScore : 0;
    return sigCnt * compScore;
  }

  // Unknown interaction — fail closed
  return null;
}

/**
 * Derive the full feature vector for a snapshot given a hypothesis.
 * Extracts the base feature subset, then appends the interaction term if defined.
 * The returned vector is RAW (unstandardized) — caller must standardize before predict.
 *
 * @param {object} snapshot
 * @param {object} hypothesis — { id, features, interaction }
 * @returns {number[]|null} raw feature vector, or null if required features missing
 */
function deriveFeatures(snapshot, hypothesis) {
  if (!snapshot || !hypothesis) return null;

  // Extract base features
  var baseFeatures = extractFeatureSubset(snapshot, hypothesis.features);
  if (!baseFeatures) return null;

  // Apply interaction if specified
  if (hypothesis.interaction) {
    var interactionVal = applyInteraction(snapshot, hypothesis);
    if (interactionVal == null) return null;
    baseFeatures.push(interactionVal);
  }

  return baseFeatures;
}

/**
 * Build feature matrix using only the specified feature subset.
 * Same structure as buildFeatureMatrix but uses extractFeatureSubset.
 *
 * @param {object[]} snapshots
 * @param {object|null} standardizer — { means, stds } or null
 * @param {string[]} featureNames — subset of features to use
 * @param {object|null} hypothesis — optional { id, features, interaction } for deriveFeatures
 * @returns {object} { X, y, codes, dates, nFeatures, nSamples }
 */
function buildFeatureMatrixWithFeatures(snapshots, standardizer, featureNames, hypothesis) {
  var X = [];
  var y = [];
  var codes = [];
  var dates = [];

  var useDerive = !!(hypothesis && hypothesis.interaction);

  for (var i = 0; i < snapshots.length; i++) {
    var s = snapshots[i];
    // P0-1: Use forwardReturnT3 as target, fallback to forwardExcessT3
    if (!s || s.forwardStatus !== 'settled') continue;
    var target = s.forwardReturnT3;
    if (target == null) target = s.forwardExcessT3;
    if (target == null) continue;

    // P1.1: Use deriveFeatures when hypothesis has interaction
    var features = useDerive
      ? deriveFeatures(s, hypothesis)
      : extractFeatureSubset(s, featureNames);
    if (!features) continue;

    X.push(features);
    y.push([target]);
    codes.push(s.code);
    dates.push(s.asOfDate);
  }

  // Apply standardization if provided
  if (standardizer) {
    X = transformWith(X, standardizer);
  }

  // Prepend intercept column (unregularized)
  for (var i = 0; i < X.length; i++) {
    X[i].unshift(1);
  }

  // Feature count = base features + (1 if interaction) + 1 for intercept
  var nFeatures = (useDerive ? featureNames.length + 1 : featureNames.length) + 1; // +1 for intercept
  return { X: X, y: y, codes: codes, dates: dates, nFeatures: nFeatures, nSamples: X.length };
}

// ---- P1: Feature Standardizer (fit on train, transform val/test) ----

function fitStandardizer(X) {
  var nFeatures = X[0].length;
  var means = [];
  var stds = [];

  for (var j = 0; j < nFeatures; j++) {
    var sum = 0;
    for (var i = 0; i < X.length; i++) sum += X[i][j];
    var mean = sum / X.length;
    means.push(mean);

    var varSum = 0;
    for (var i = 0; i < X.length; i++) varSum += (X[i][j] - mean) * (X[i][j] - mean);
    var std = Math.sqrt(varSum / (X.length - 1)) || 1; // Avoid div by zero
    stds.push(std);
  }

  return { means: means, stds: stds };
}

function transformWith(X, standardizer) {
  var means = standardizer.means;
  var stds = standardizer.stds;
  var result = [];
  for (var i = 0; i < X.length; i++) {
    var row = [];
    for (var j = 0; j < X[i].length; j++) {
      row.push((X[i][j] - means[j]) / stds[j]);
    }
    result.push(row);
  }
  return result;
}

// ---- Build feature matrix with standardization ----

function buildFeatureMatrix(snapshots, standardizer) {
  var X = [];
  var y = [];
  var codes = [];
  var dates = [];

  for (var i = 0; i < snapshots.length; i++) {
    var s = snapshots[i];
    // P0-1: Use forwardReturnT3 (T+1 open → T+4 close gross return) as target
    // Fall back to forwardExcessT3 for backward compat
    if (!s || s.forwardStatus !== 'settled') continue;
    var target = s.forwardReturnT3; // Gross return (P0-1)
    if (target == null) target = s.forwardExcessT3; // Legacy fallback
    if (target == null) continue;

    var features = extractFeatures(s);
    if (!features) continue;

    X.push(features);
    // Add intercept column (1s)
    y.push([target]);
    codes.push(s.code);
    dates.push(s.asOfDate);
  }

  // Apply standardization if provided
  if (standardizer) {
    X = transformWith(X, standardizer);
  }

  // Prepend intercept column (unregularized)
  for (var i = 0; i < X.length; i++) {
    X[i].unshift(1);
  }

  var nFeatures = FEATURE_NAMES.length + 1; // +1 for intercept
  return { X: X, y: y, codes: codes, dates: dates, nFeatures: nFeatures, nSamples: X.length };
}

// ---- Ridge Regression (closed-form, with unregularized intercept) ----

function fitRidge(X, y, lambda) {
  // β = (XᵀX + λI*)⁻¹ Xᵀy
  // I* = identity matrix with I*[0][0] = 0 (intercept unregularized)
  var nFeatures = X[0].length;

  // XᵀX
  var XT = transpose(X);
  var XTX = matMul(XT, X);

  // XᵀX + λI*  (intercept at column 0 is NOT regularized)
  var lambdaI = identityMatrix(nFeatures);
  lambdaI[0][0] = 0; // Unregularized intercept
  for (var i = 1; i < nFeatures; i++) lambdaI[i][i] *= lambda;
  var regularized = matAdd(XTX, lambdaI);

  // (XᵀX + λI*)⁻¹
  var inv = invertMatrix(regularized);
  if (!inv) return null;

  // Xᵀy
  var XTy = matMul(XT, y);

  // β = inv × Xᵀy
  var beta = matMul(inv, XTy);

  var allWeights = beta.map(function (row) { return row[0]; });
  var intercept = allWeights[0];
  var weights = allWeights.slice(1);

  return {
    intercept: intercept,
    weights: weights,
    featureNames: FEATURE_NAMES,
    lambda: lambda,
    nFeatures: nFeatures - 1, // Excluding intercept
  };
}

function predict(model, features) {
  if (!model || !features) return null;
  var prediction = model.intercept || 0;
  for (var i = 0; i < model.weights.length; i++) {
    prediction += model.weights[i] * (features[i] || 0);
  }
  return prediction;
}

function computeMSE(model, X, y) {
  // X columns include intercept (col 0 = all 1s), but predict() only uses weights
  // We need to strip the intercept column before calling predict
  var total = 0;
  var count = 0;
  var n = Math.min(X.length, y.length);
  for (var i = 0; i < n; i++) {
    // Strip intercept column (col 0) to get feature-only vector
    var features = X[i].slice(1);
    var pred = predict(model, features);
    if (pred == null || y[i] == null || !y[i]) continue;
    var err = pred - y[i][0];
    total += err * err;
    count++;
  }
  return count > 0 ? total / count : Infinity;
}

// ---- Hyperparameter grid search ----

var LAMBDA_GRID = [0.001, 0.01, 0.1, 1, 10];

function gridSearchLambda(trainX, trainY, valX, valY) {
  var best = { lambda: LAMBDA_GRID[0], model: null, valMSE: Infinity, trainMSE: Infinity };

  for (var li = 0; li < LAMBDA_GRID.length; li++) {
    var lambda = LAMBDA_GRID[li];
    var model = fitRidge(trainX, trainY, lambda);
    if (!model) continue;

    var trainMSE = computeMSE(model, trainX, trainY);
    var valMSE = computeMSE(model, valX, valY);

    if (valMSE < best.valMSE) {
      best.lambda = lambda;
      best.model = model;
      best.valMSE = valMSE;
      best.trainMSE = trainMSE;
    }
  }

  return best;
}

// ---- Data hash (for reproducibility) ----

function hashData(snapshots) {
  var crypto = require('crypto');
  var hash = crypto.createHash('sha256');
  snapshots.forEach(function (s) {
    hash.update(s.code + '|' + s.asOfDate + '|' + s.forwardExcessT3);
  });
  return hash.digest('hex');
}

// ---- CLI ----

if (require.main === module) {
  console.log('=== P1.1-F: Linear Model (Ridge Regression) ===');
  console.log('Features: ' + FEATURE_NAMES.join(', '));
  console.log('Lambda grid: ' + LAMBDA_GRID.join(', '));
  console.log();

  var SNAPSHOTS_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'research', 'snapshots');

  // Quick test on a few dates
  var testDates = ['2024-06-03', '2024-06-04', '2024-06-05', '2024-06-06', '2024-06-07'];
  var allSnapshots = [];

  testDates.forEach(function (d) {
    var fp = path.join(SNAPSHOTS_DIR, d + '.jsonl');
    if (!fs.existsSync(fp)) return;
    var lines = fs.readFileSync(fp, 'utf8').trim().split('\n');
    lines.forEach(function (l) {
      if (!l) return;
      try { allSnapshots.push(JSON.parse(l)); } catch (e) {}
    });
  });

  console.log('Loaded ' + allSnapshots.length + ' snapshots from ' + testDates.length + ' dates');

  // Build feature matrix
  var data = buildFeatureMatrix(allSnapshots);
  console.log('Feature matrix: ' + data.nSamples + ' samples × ' + data.nFeatures + ' features');

  // Simple train/test split (80/20)
  var splitIdx = Math.floor(data.nSamples * 0.8);
  var trainX = data.X.slice(0, splitIdx);
  var trainY = data.y.slice(0, splitIdx);
  var testX = data.X.slice(splitIdx);
  var testY = data.y.slice(splitIdx);

  // Grid search on validation (using a small val split from train)
  var valSplit = Math.floor(trainX.length * 0.8);
  var valX = trainX.slice(valSplit);
  var valY = trainY.slice(valSplit);
  var trainX2 = trainX.slice(0, valSplit);
  var trainY2 = trainY.slice(0, valSplit);

  var best = gridSearchLambda(trainX2, trainY2, valX, valY);
  console.log();
  console.log('Best lambda: ' + best.lambda);
  console.log('Train MSE: ' + Math.round(best.trainMSE * 10000) / 10000);
  console.log('Val MSE:   ' + Math.round(best.valMSE * 10000) / 10000);

  var testMSE = computeMSE(best.model, testX, testY);
  console.log('Test MSE:  ' + Math.round(testMSE * 10000) / 10000);

  console.log();
  console.log('Weights:');
  best.model.featureNames.forEach(function (name, i) {
    console.log('  ' + name + ': ' + Math.round(best.model.weights[i] * 10000) / 10000);
  });
}

module.exports = {
  fitRidge, predict, computeMSE, gridSearchLambda,
  extractFeatures, buildFeatureMatrix,
  extractFeatureSubset, buildFeatureMatrixWithFeatures,
  applyInteraction, deriveFeatures,
  fitStandardizer, transformWith,
  FEATURE_NAMES, LAMBDA_GRID, hashData,
};