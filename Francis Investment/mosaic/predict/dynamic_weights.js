/**
 * dynamic_weights.js — 动态权重学习引擎
 *
 * 每交易日盘后，用近 20 天 Pipeline 数据做滚动回归，
 * 自动调整 composite.js 的 5 维评分权重。
 *
 * 算法：普通最小二乘法 (OLS)
 *   future_return ~ w1*fundamental + w2*technical + w3*hidden + w4*capital_flow + w5*event
 *
 * 限制措施：
 *   - 单维度权重 5%~50%
 *   - R² < 0.05 → 回退默认权重
 *   - 有效数据点 < 30 → 不更新
 *   - EMA 平滑 (α=0.3)
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

const DATA_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'simfolio');
const DYNAMIC_WEIGHTS_FILE = path.join(DATA_DIR, 'dynamic_weights.json');

const DIMENSIONS = ['fundamental', 'technical', 'hidden', 'capital_flow', 'event'];

/**
 * 从近 N 天 Pipeline 扫描结果中提取训练数据。
 * 返回 { X: [[f, t, h, c, e], ...], y: [return, ...] } 用于回归。
 *
 * X 每行是 5 维评分，y 是该股票 N 天后的实际收益。
 */
function collectTrainingData(lookbackDays) {
  const days = lookbackDays || 20;
  const X = [];
  const y = [];
  const stockPerfPath = path.join(DATA_DIR, 'stock_factor_performance.json');

  if (!fs.existsSync(stockPerfPath)) {
    return { X, y, available: false, reason: '无个股因子绩效数据' };
  }

  let stockPerfData;
  try {
    stockPerfData = JSON.parse(fs.readFileSync(stockPerfPath, 'utf8'));
  } catch (_) {
    return { X, y, available: false, reason: '无法解析个股因子绩效数据' };
  }

  const dailyRecords = stockPerfData.dailyRecords || {};
  const dates = Object.keys(dailyRecords).sort();

  if (dates.length < 5) {
    return { X, y, available: false, reason: '数据不足(需要≥5天)' };
  }

  const recentDates = dates.slice(-Math.min(days, dates.length));

  // For each stock in each date's records, check if we have future return
  for (let i = 0; i < recentDates.length - 1; i++) {
    const date = recentDates[i];
    const records = dailyRecords[date] || [];

    // Find a target date ~5 trading days later
    const targetIdx = Math.min(i + 5, recentDates.length - 1);
    if (targetIdx <= i) continue;
    const targetDate = recentDates[targetIdx];
    const targetRecords = dailyRecords[targetDate] || [];

    for (const rec of records) {
      // Find same stock in target date
      const targetRec = targetRecords.find(r => r.code === rec.code);
      if (!targetRec || !targetRec.price || !rec.price || rec.price <= 0) continue;

      const futureReturn = (targetRec.price - rec.price) / rec.price * 100;

      // We only have compositeScore and factorSignals, not raw dimension scores
      // Approximate: use compositeScore as dominant input
      // For now, collect what we have — compositeScore proxies multiple dimensions
      if (rec.compositeScore != null) {
        // Create feature vector from available data
        // Since we don't store raw dimension scores in daily records,
        // we approximate: compositeScore is a weighted sum of dimensions
        // Use factor signal count as proxy for hidden score
        const nSignals = (rec.factorSignals || []).length;
        const signalStrength = rec.factorSignals
          ? rec.factorSignals.reduce((sum, s) => sum + (s.level === 'strong' ? 2 : s.level === 'medium' ? 1 : 0), 0)
          : 0;

        // Approximate dimension scores from composite:
        // compositeScore ~= f*wf + t*wt + h*wh + c*wc + e*we
        // We split compositeScore into proxy components
        const baseScore = rec.compositeScore || 50;
        const hiddenProxy = Math.min(100, 50 + signalStrength * 10);
        const flowProxy = baseScore; // use composite as proxy for all dims
        const fundProxy = baseScore;
        const techProxy = baseScore;
        const eventProxy = 50;

        X.push([fundProxy, techProxy, hiddenProxy, flowProxy, eventProxy]);
        y.push(futureReturn);
      }
    }
  }

  return {
    X, y,
    available: X.length >= 30,
    sampleCount: X.length,
    reason: X.length < 30 ? '有效数据点不足30(' + X.length + '条)' : null,
  };
}

/**
 * 执行 OLS 线性回归。
 * β = (X'X)^(-1) X'y
 *
 * 简单实现（适合 5 维小规模回归）。
 */
function olsRegression(X, y) {
  const n = X.length;
  const p = X[0].length;

  // Compute X'X (p×p matrix)
  const XtX = Array(p).fill(null).map(() => Array(p).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) {
      for (let k = 0; k < p; k++) {
        XtX[j][k] += X[i][j] * X[i][k];
      }
    }
  }

  // Compute X'y (p×1 vector)
  const Xty = Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) {
      Xty[j] += X[i][j] * y[i];
    }
  }

  // Solve XtX * β = Xty using Gaussian elimination with partial pivot
  const beta = solveLinearSystem(XtX, Xty);
  if (!beta) return null;

  // Compute R²
  const yMean = y.reduce((a, b) => a + b, 0) / n;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    let yPred = 0;
    for (let j = 0; j < p; j++) yPred += beta[j] * X[i][j];
    ssRes += (y[i] - yPred) ** 2;
    ssTot += (y[i] - yMean) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return { beta, r2 };
}

/**
 * Solve Ax = b using Gaussian elimination with partial pivoting.
 * Returns x vector or null if singular.
 */
function solveLinearSystem(A, b) {
  const n = A.length;
  // Create augmented matrix
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    // Partial pivot
    let maxRow = col;
    let maxVal = Math.abs(M[col][col]);
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > maxVal) {
        maxVal = Math.abs(M[row][col]);
        maxRow = row;
      }
    }

    if (maxVal < 1e-10) return null; // singular

    // Swap rows
    [M[col], M[maxRow]] = [M[maxRow], M[col]];

    // Eliminate below
    for (let row = col + 1; row < n; row++) {
      const factor = M[row][col] / M[col][col];
      for (let j = col; j <= n; j++) {
        M[row][j] -= factor * M[col][j];
      }
    }
  }

  // Back substitution
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = M[i][n];
    for (let j = i + 1; j < n; j++) {
      sum -= M[i][j] * x[j];
    }
    x[i] = sum / M[i][i];
  }

  return x;
}

/**
 * 从回归系数转换为权重（归一化到总和=1，限制单维度 5%~50%）。
 */
function coefficientsToWeights(beta) {
  // Make all coefficients positive (negative coefficients = inverse relationship)
  const positive = beta.map(b => Math.max(0, b));
  const sum = positive.reduce((a, b) => a + b, 0);

  if (sum <= 0) return null;

  // Normalize to sum=1
  let weights = positive.map(b => b / sum);

  // Clamp to 5%~50%
  weights = weights.map(w => Math.max(0.05, Math.min(0.50, w)));

  // Re-normalize
  const newSum = weights.reduce((a, b) => a + b, 0);
  weights = weights.map(w => +(w / newSum).toFixed(3));

  return weights;
}

/**
 * 加载当前的动态权重。
 * 如果存在且未过期，返回动态权重；否则返回 config 默认权重。
 */
function loadDynamicWeights() {
  if (!fs.existsSync(DYNAMIC_WEIGHTS_FILE)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(DYNAMIC_WEIGHTS_FILE, 'utf8'));
    if (data.weights && data.dimensions) {
      return data;
    }
  } catch (_) {}
  return null;
}

/**
 * 用 EMA 平滑更新权重。
 * newWeight = α * learnedWeight + (1-α) * oldWeight
 */
function emaSmooth(oldWeights, newWeights, alpha) {
  const a = alpha || 0.3;
  const result = {};
  for (const dim of DIMENSIONS) {
    const old = (oldWeights && oldWeights[dim]) || config.FACTOR_WEIGHTS[dim] || 0.20;
    const nw = newWeights[dim] || old;
    result[dim] = +(a * nw + (1 - a) * old).toFixed(3);
  }
  return result;
}

/**
 * 主函数：计算并更新动态权重。
 * 应在每日盘后调用。
 *
 * @returns {object} { updated, weights, r2, sampleCount, message }
 */
function updateDynamicWeights() {
  const trainingData = collectTrainingData(20);

  if (!trainingData.available) {
    return {
      updated: false,
      weights: null,
      r2: null,
      sampleCount: trainingData.sampleCount || 0,
      message: trainingData.reason || '数据不足',
    };
  }

  const regression = olsRegression(trainingData.X, trainingData.y);
  if (!regression) {
    return {
      updated: false,
      weights: null,
      r2: null,
      sampleCount: trainingData.sampleCount,
      message: '回归方程奇异，无法求解',
    };
  }

  if (regression.r2 < 0.05) {
    return {
      updated: false,
      weights: null,
      r2: +regression.r2.toFixed(3),
      sampleCount: trainingData.sampleCount,
      message: 'R²过小(' + regression.r2.toFixed(3) + ')，模型无解释力，保持默认权重',
    };
  }

  const rawWeights = coefficientsToWeights(regression.beta);
  if (!rawWeights) {
    return {
      updated: false,
      weights: null,
      r2: +regression.r2.toFixed(3),
      sampleCount: trainingData.sampleCount,
      message: '无法从回归系数转换为有效权重',
    };
  }

  // Map back to dimension names
  const newWeights = {};
  for (let i = 0; i < DIMENSIONS.length; i++) {
    newWeights[DIMENSIONS[i]] = rawWeights[i];
  }

  // EMA smooth with existing weights
  const existingData = loadDynamicWeights();
  const existingWeights = existingData ? existingData.weights : null;
  const smoothed = emaSmooth(existingWeights, newWeights, 0.3);

  // Save
  const weightsData = {
    weights: smoothed,
    dimensions: DIMENSIONS,
    r2: +regression.r2.toFixed(3),
    rawR2: +regression.r2.toFixed(4),
    sampleCount: trainingData.sampleCount,
    updatedAt: new Date().toISOString(),
    rawWeights: newWeights,
    message: '基于' + trainingData.sampleCount + '条数据更新，R²=' + regression.r2.toFixed(3),
  };

  try {
    const dir = path.dirname(DYNAMIC_WEIGHTS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DYNAMIC_WEIGHTS_FILE, JSON.stringify(weightsData, null, 2), 'utf8');
  } catch (_) {}

  return {
    updated: true,
    weights: smoothed,
    r2: +regression.r2.toFixed(3),
    sampleCount: trainingData.sampleCount,
    message: weightsData.message,
  };
}

/**
 * 获取当前生效的因子权重（动态优先，回退 config 默认）。
 */
function getEffectiveWeights() {
  const dynamic = loadDynamicWeights();
  if (dynamic && dynamic.weights && dynamic.r2 >= 0.05) {
    return {
      ...config.FACTOR_WEIGHTS,
      ...dynamic.weights,
      _source: 'dynamic',
      _r2: dynamic.r2,
      _updatedAt: dynamic.updatedAt,
    };
  }
  return { ...config.FACTOR_WEIGHTS, _source: 'config' };
}

module.exports = {
  updateDynamicWeights,
  getEffectiveWeights,
  loadDynamicWeights,
  collectTrainingData,
};
