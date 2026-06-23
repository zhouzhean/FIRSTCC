/**
 * P1.1-F: Linear Model — First Learnable Model (Ridge Regression)
 *
 * Closed-form ridge regression via normal equations:  β = (XᵀX + λI)⁻¹ Xᵀy
 * No gradient descent, no auto-differentiation, no neural networks.
 * No auto-tuning beyond a fixed hyperparameter grid.
 *
 * Features: ONLY real point-in-time data
 *  — technical dimension score (from composite rawScores)
 *  — hidden dimension score (from composite rawScores)
 *  — signalCount (number of H1-H9 signals triggered)
 *  — volatility20d (annualized %)
 *  — changePct (day's % change)
 *
 * Target: T+3 forward excess return (post-cost net of benchmark)
 *
 * Hyperparameters: λ ∈ [0.001, 0.01, 0.1, 1, 10] — selected on validation set
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

function buildFeatureMatrix(snapshots) {
  var X = [];
  var y = [];
  var codes = [];

  for (var i = 0; i < snapshots.length; i++) {
    var s = snapshots[i];
    if (!s || s.forwardStatus !== 'settled' || s.forwardExcessT3 == null) continue;

    var features = extractFeatures(s);
    if (!features) continue;

    X.push(features);
    y.push([s.forwardExcessT3]);
    codes.push(s.code);
  }

  return { X: X, y: y, codes: codes, nFeatures: FEATURE_NAMES.length, nSamples: X.length };
}

// ---- Ridge Regression (closed-form) ----

function fitRidge(X, y, lambda) {
  // β = (XᵀX + λI)⁻¹ Xᵀy
  var nFeatures = X[0].length;

  // XᵀX
  var XT = transpose(X);
  var XTX = matMul(XT, X);

  // XᵀX + λI
  var lambdaI = identityMatrix(nFeatures);
  for (var i = 0; i < nFeatures; i++) lambdaI[i][i] *= lambda;
  var regularized = matAdd(XTX, lambdaI);

  // (XᵀX + λI)⁻¹
  var inv = invertMatrix(regularized);
  if (!inv) return null; // Singular

  // Xᵀy
  var XTy = matMul(XT, y);

  // β = inv × Xᵀy
  var beta = matMul(inv, XTy);

  // Extract weights and intercept
  // Note: this is a no-intercept model. For research purposes,
  // using raw features without intercept is acceptable.
  // Each feature is already normalized to roughly similar scales.
  var weights = beta.map(function (row) { return row[0]; });

  return {
    weights: weights,
    featureNames: FEATURE_NAMES,
    lambda: lambda,
    nFeatures: nFeatures,
  };
}

function predict(model, features) {
  if (!model || !features) return null;
  var prediction = 0;
  for (var i = 0; i < model.weights.length; i++) {
    prediction += model.weights[i] * (features[i] || 0);
  }
  return prediction;
}

function computeMSE(model, X, y) {
  var total = 0;
  var count = 0;
  var n = Math.min(X.length, y.length);
  for (var i = 0; i < n; i++) {
    var pred = predict(model, X[i]);
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
  FEATURE_NAMES, LAMBDA_GRID, hashData,
};
