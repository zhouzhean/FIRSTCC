/**
 * weight_grid_search.js — 动态权重参数网格搜索
 *
 * 夜间 03:00 运行，尝试多种超参数组合（lookback天数 × EMA平滑系数），
 * 使用样本外验证（留出最后5天）评估效果，找到最优配置。
 *
 * 最优参数写入 dynamic_weights.json 的 bestParams 字段，
 * 主模块 dynamic_weights.js 读取这些参数（如果存在）。
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'simfolio');
const GRID_RESULT_FILE = path.join(DATA_DIR, 'weight_grid_result.json');
const DYNAMIC_WEIGHTS_FILE = path.join(DATA_DIR, 'dynamic_weights.json');

const DIMENSIONS = ['fundamental', 'technical', 'hidden', 'capitalFlow', 'event'];

var _state = {
  running: false,
  lastRun: null,
  lastResult: null,
  error: null,
};

// ==================== 主函数 ====================

/**
 * 运行参数网格搜索。
 * 返回最佳配置和建议。
 */
function runGridSearch() {
  if (_state.running) {
    console.log('[GridSearch] 已有任务在运行，跳过');
    return { skipped: true };
  }

  _state.running = true;
  _state.error = null;
  var startTime = Date.now();

  console.log('[GridSearch] 开始参数网格搜索...');

  try {
    // 1. Load training data
    var stockPerfPath = path.join(DATA_DIR, 'stock_factor_performance.json');
    if (!fs.existsSync(stockPerfPath)) {
      _state.running = false;
      return { available: false, reason: '无训练数据' };
    }

    var stockPerfData;
    try { stockPerfData = JSON.parse(fs.readFileSync(stockPerfPath, 'utf8')); }
    catch (_) { _state.running = false; return { available: false, reason: '无法解析数据' }; }

    var dailyRecords = stockPerfData.dailyRecords || {};
    var dates = Object.keys(dailyRecords).sort();

    if (dates.length < 15) {
      _state.running = false;
      return { available: false, reason: '数据不足(需要>=15天, 当前' + dates.length + '天)' };
    }

    // 2. Build full training dataset
    var fullDataset = buildFullDataset(dailyRecords, dates);
    if (fullDataset.X.length < 30) {
      _state.running = false;
      return { available: false, reason: '有效样本不足30(' + fullDataset.X.length + '条)' };
    }

    // 3. Parameter grid
    var lookbackOptions = [10, 15, 20, 30, 40];
    var alphaOptions = [0.1, 0.2, 0.3, 0.5, 0.7];

    var results = [];

    for (var li = 0; li < lookbackOptions.length; li++) {
      for (var ai = 0; ai < alphaOptions.length; ai++) {
        var lookback = lookbackOptions[li];
        var alpha = alphaOptions[ai];

        // Use only the last 'lookback' days of data for training
        var trainData = sliceByLookback(fullDataset, lookback);
        if (trainData.X.length < 20) continue;

        // Sample out: last 5 days as test, rest as train
        var split = trainTestSplit(trainData, 5);

        if (split.train.X.length < 15 || split.test.X.length < 3) continue;

        // Train OLS on train set
        var regression = olsRegression(split.train.X, split.train.y);
        if (!regression) continue;

        // Compute test error
        var testError = computeMSE(split.test.X, split.test.y, regression.beta);
        var testHitRate = computeDirectionHitRate(split.test.X, split.test.y, regression.beta);

        // Apply EMA smoothing simulation
        var smoothedBeta = simulateEMASmooth(regression.beta, alpha, DIMENSIONS.length);

        results.push({
          lookback: lookback,
          emaAlpha: alpha,
          trainSamples: split.train.X.length,
          testSamples: split.test.X.length,
          trainR2: +regression.r2.toFixed(3),
          testMSE: +testError.toFixed(3),
          testHitRate: +testHitRate.toFixed(2),
          beta: regression.beta.map(function(b) { return +b.toFixed(4); }),
          smoothedBeta: smoothedBeta.map(function(b) { return +b.toFixed(4); }),
        });
      }
    }

    if (results.length === 0) {
      _state.running = false;
      return { available: false, reason: '无有效参数组合' };
    }

    // 4. Rank by test hit rate (direction prediction accuracy), then by MSE
    results.sort(function(a, b) {
      if (b.testHitRate !== a.testHitRate) return b.testHitRate - a.testHitRate;
      return a.testMSE - b.testMSE;
    });

    var best = results[0];
    var bestParams = {
      lookbackDays: best.lookback,
      emaAlpha: best.emaAlpha,
      testHitRate: best.testHitRate,
      testMSE: best.testMSE,
      reason: '网格搜索最优: lookback=' + best.lookback + 'd, alpha=' + best.emaAlpha +
        ', 方向命中率=' + Math.round(best.testHitRate * 100) + '%',
    };

    // 5. Save to dynamic_weights.json
    saveBestParams(bestParams);

    // 6. Save grid results
    var duration = Math.round((Date.now() - startTime) / 1000);
    var result = {
      date: new Date().toISOString().slice(0, 10),
      time: new Date().toISOString(),
      totalCombinations: lookbackOptions.length * alphaOptions.length,
      validResults: results.length,
      best: best,
      bestParams: bestParams,
      top10: results.slice(0, 10),
      durationSec: duration,
    };
    saveGridResult(result);

    _state.running = false;
    _state.lastRun = new Date().toISOString();
    _state.lastResult = result;

    console.log('[GridSearch] 完成: ' + results.length + ' 有效参数组合, 最优: lookback=' +
      best.lookback + ', alpha=' + best.emaAlpha + ', hitRate=' +
      Math.round(best.testHitRate * 100) + '%');

    return result;

  } catch (e) {
    console.error('[GridSearch] 错误:', e.message);
    _state.running = false;
    _state.error = e.message;
    return { available: false, error: e.message };
  }
}

// ==================== 数据集构建 ====================

/**
 * 从 dailyRecords 构建完整特征矩阵。
 * 现在 rawScores 已可用（Phase 1 后），直接使用原始维度评分。
 */
function buildFullDataset(dailyRecords, dates) {
  var X = [];
  var y = [];

  for (var i = 0; i < dates.length - 1; i++) {
    var date = dates[i];
    var records = dailyRecords[date] || [];

    // Find target date ~5 trading days later
    var targetIdx = Math.min(i + 5, dates.length - 1);
    if (targetIdx <= i) continue;
    var targetRecords = dailyRecords[dates[targetIdx]] || [];

    for (var ri = 0; ri < records.length; ri++) {
      var rec = records[ri];
      var targetRec = targetRecords.find(function(r) { return r.code === rec.code; });
      if (!targetRec || !targetRec.price || !rec.price || rec.price <= 0) continue;

      var futureReturn = (targetRec.price - rec.price) / rec.price * 100;

      // Build feature vector from rawScores (if available) or fallback to proxies
      var features = extractFeatures(rec);
      if (!features) continue;

      X.push(features);
      y.push(futureReturn);
    }
  }

  return { X: X, y: y, dimensions: DIMENSIONS };
}

function extractFeatures(rec) {
  // If rawScores are available (Phase 1+), use them directly
  if (rec.rawScores && rec.rawScores.fundamental != null) {
    return [
      rec.rawScores.fundamental,
      rec.rawScores.technical,
      rec.rawScores.hidden,
      rec.rawScores.capitalFlow,
      rec.rawScores.event,
    ];
  }

  // Fallback: use compositeScore proxy (old behavior)
  var baseScore = rec.compositeScore || 50;
  var signals = rec.factorSignals || [];
  var signalStrength = 0;
  for (var i = 0; i < signals.length; i++) {
    signalStrength += signals[i].level === 'strong' ? 2 : signals[i].level === 'medium' ? 1 : 0;
  }

  return [
    baseScore,                                      // fundamental proxy
    baseScore,                                      // technical proxy
    Math.min(100, 50 + signalStrength * 10),       // hidden proxy
    baseScore,                                      // capitalFlow proxy
    50,                                             // event proxy
  ];
}

function sliceByLookback(dataset, lookbackDays) {
  // Take the last N days worth of samples
  // Since the dataset is ordered by date, just take the tail portion
  var n = Math.min(lookbackDays * 5, dataset.X.length); // ~5 samples per day
  return {
    X: dataset.X.slice(-n),
    y: dataset.y.slice(-n),
  };
}

function trainTestSplit(dataset, testDays) {
  var testSize = Math.max(3, Math.min(testDays * 3, Math.floor(dataset.X.length * 0.2)));
  var trainSize = dataset.X.length - testSize;

  return {
    train: {
      X: dataset.X.slice(0, trainSize),
      y: dataset.y.slice(0, trainSize),
    },
    test: {
      X: dataset.X.slice(trainSize),
      y: dataset.y.slice(trainSize),
    },
  };
}

// ==================== 数学工具 ====================

function olsRegression(X, y) {
  var n = X.length;
  var p = X[0].length;

  // X'X
  var XtX = [];
  for (var j = 0; j < p; j++) { XtX[j] = []; for (var k = 0; k < p; k++) XtX[j][k] = 0; }
  for (var i = 0; i < n; i++) {
    for (var j = 0; j < p; j++) {
      for (var k = 0; k < p; k++) {
        XtX[j][k] += X[i][j] * X[i][k];
      }
    }
  }

  // X'y
  var Xty = [];
  for (var jj = 0; jj < p; jj++) { Xty[jj] = 0; }
  for (var ii = 0; ii < n; ii++) {
    for (var j3 = 0; j3 < p; j3++) {
      Xty[j3] += X[ii][j3] * y[ii];
    }
  }

  // Solve
  var beta = solveLinearSystem(XtX, Xty);
  if (!beta) return null;

  // R²
  var yMean = y.reduce(function(a, b) { return a + b; }, 0) / n;
  var ssRes = 0, ssTot = 0;
  for (var i3 = 0; i3 < n; i3++) {
    var yPred = 0;
    for (var j4 = 0; j4 < p; j4++) yPred += beta[j4] * X[i3][j4];
    ssRes += (y[i3] - yPred) * (y[i3] - yPred);
    ssTot += (y[i3] - yMean) * (y[i3] - yMean);
  }
  var r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return { beta: beta, r2: r2 };
}

function solveLinearSystem(A, b) {
  var n = A.length;
  var M = [];
  for (var i = 0; i < n; i++) {
    M[i] = [];
    for (var j = 0; j < n; j++) M[i][j] = A[i][j];
    M[i].push(b[i]);
  }

  for (var col = 0; col < n; col++) {
    var maxRow = col;
    var maxVal = Math.abs(M[col][col]);
    for (var row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > maxVal) {
        maxVal = Math.abs(M[row][col]);
        maxRow = row;
      }
    }
    if (maxVal < 1e-10) return null;
    var tmp = M[col]; M[col] = M[maxRow]; M[maxRow] = tmp;

    for (var row2 = col + 1; row2 < n; row2++) {
      var factor = M[row2][col] / M[col][col];
      for (var j2 = col; j2 <= n; j2++) {
        M[row2][j2] -= factor * M[col][j2];
      }
    }
  }

  var x = [];
  for (var i2 = n - 1; i2 >= 0; i2--) {
    var sum = M[i2][n];
    for (var j3 = i2 + 1; j3 < n; j3++) sum -= M[i2][j3] * x[j3];
    x[i2] = sum / M[i2][i2];
  }
  return x;
}

function computeMSE(X, y, beta) {
  var sum = 0;
  for (var i = 0; i < X.length; i++) {
    var pred = 0;
    for (var j = 0; j < beta.length; j++) pred += beta[j] * X[i][j];
    var err = y[i] - pred;
    sum += err * err;
  }
  return sum / X.length;
}

function computeDirectionHitRate(X, y, beta) {
  var correct = 0;
  var total = 0;
  for (var i = 0; i < X.length; i++) {
    var pred = 0;
    for (var j = 0; j < beta.length; j++) pred += beta[j] * X[i][j];
    if ((pred > 0 && y[i] > 0) || (pred <= 0 && y[i] <= 0)) correct++;
    total++;
  }
  return total > 0 ? correct / total : 0;
}

function simulateEMASmooth(beta, alpha, dimCount) {
  // Simulate EMA smoothing on the raw beta (converting negative to 0)
  var positive = beta.map(function(b) { return Math.max(0, b); });
  var sum = positive.reduce(function(a, b) { return a + b; }, 0);
  if (sum <= 0) return positive;

  var weights = positive.map(function(b) { return b / sum; });
  // Apply EMA: newWeight = alpha * weight + (1-alpha) * (1/dimCount)
  var baseline = 1 / dimCount;
  return weights.map(function(w) {
    return +(alpha * w + (1 - alpha) * baseline).toFixed(3);
  });
}

// ==================== 持久化 ====================

function saveGridResult(result) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(GRID_RESULT_FILE, JSON.stringify(result, null, 2), 'utf8');
  } catch (_) {}
}

function saveBestParams(params) {
  try {
    var dw = {};
    if (fs.existsSync(DYNAMIC_WEIGHTS_FILE)) {
      try { dw = JSON.parse(fs.readFileSync(DYNAMIC_WEIGHTS_FILE, 'utf8')); } catch (_) {}
    }
    dw.bestParams = params;
    dw.bestParamsUpdatedAt = new Date().toISOString();
    fs.writeFileSync(DYNAMIC_WEIGHTS_FILE, JSON.stringify(dw, null, 2), 'utf8');
  } catch (_) {}
}

function loadGridResult() {
  if (!fs.existsSync(GRID_RESULT_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(GRID_RESULT_FILE, 'utf8')); } catch (_) { return null; }
}

function getStatus() {
  return {
    running: _state.running,
    lastRun: _state.lastRun,
    lastResult: _state.lastResult || loadGridResult(),
    error: _state.error,
  };
}

module.exports = {
  runGridSearch,
  getStatus,
  loadGridResult,
};
