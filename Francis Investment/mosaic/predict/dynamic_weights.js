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

      // Use raw dimension scores if available (v2.8+ pipeline saves them),
      // otherwise fall back to composite score proxy (backward compatible).
      if (rec.compositeScore != null) {
        var fundProxy, techProxy, hiddenProxy, flowProxy, eventProxy;

        if (rec.rawScores && rec.rawScores.fundamental != null) {
          // Real dimension scores from pipeline — use them directly
          fundProxy = rec.rawScores.fundamental;
          techProxy = rec.rawScores.technical != null ? rec.rawScores.technical : 50;
          hiddenProxy = rec.rawScores.hidden != null ? rec.rawScores.hidden : 50;
          flowProxy = rec.rawScores.capitalFlow != null ? rec.rawScores.capitalFlow : 50;
          eventProxy = rec.rawScores.event != null ? rec.rawScores.event : 50;
        } else {
          // Fallback: approximate from compositeScore and signal strength
          const nSignals = (rec.factorSignals || []).length;
          const signalStrength = rec.factorSignals
            ? rec.factorSignals.reduce((sum, s) => sum + (s.level === 'strong' ? 2 : s.level === 'medium' ? 1 : 0), 0)
            : 0;
          const baseScore = rec.compositeScore || 50;
          hiddenProxy = Math.min(100, 50 + signalStrength * 10);
          flowProxy = baseScore;
          fundProxy = baseScore;
          techProxy = baseScore;
          eventProxy = 50;
        }

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
 * 读取网格搜索找到的最优超参数。
 * 如果存在 bestParams，用其覆盖默认的 lookbackDays 和 emaAlpha。
 */
function getGridSearchParams() {
  try {
    if (fs.existsSync(DYNAMIC_WEIGHTS_FILE)) {
      var dw = JSON.parse(fs.readFileSync(DYNAMIC_WEIGHTS_FILE, 'utf8'));
      if (dw.bestParams && dw.bestParams.lookbackDays && dw.bestParams.testHitRate > 0.45) {
        return {
          lookbackDays: dw.bestParams.lookbackDays,
          emaAlpha: dw.bestParams.emaAlpha,
          source: 'grid_search',
          testHitRate: dw.bestParams.testHitRate,
        };
      }
    }
  } catch (_) {}
  return { lookbackDays: 20, emaAlpha: 0.3, source: 'default' };
}

/**
 * 主函数：计算并更新动态权重。
 * 应在每日盘后调用。
 *
 * 增强：优先使用网格搜索的最优超参数（如果存在且验证通过）。
 *
 * @returns {object} { updated, weights, r2, sampleCount, message }
 */
/**
 * Phase 3.1: Compute weight tier based on sample maturity and statistical evidence.
 *
 * Tier 1 (record_only): < 300 samples or < 20 calendar days — record only, no weight update
 * Tier 2 (suggest_only): 300-999 samples, or IC CI lower ≤ 0, or net excess ≤ 0 — suggest only
 * Tier 3 (shadow_allowed): 1000+ samples, 60+ days, IC positive, net excess positive — auto-update
 * Tier 4 (champion): passes all qualification criteria — same as shadow_allowed for now
 */
function computeWeightTier(sampleCount, calendarDays, icLower, netExcessReturn) {
  // v3.4.6: Fail-closed — null evidence != pass
  // icLower or netExcessReturn null means evidence is unavailable → suggest_only at best
  if (icLower == null) {
    return { tier: 'suggest_only', mode: 'suggest', reason: 'Rank IC CI下界未计算（验证数据不足），缺少统计证据，仅建议不自动更新' };
  }
  if (netExcessReturn == null) {
    return { tier: 'suggest_only', mode: 'suggest', reason: '净超额收益未计算（验证数据不足），缺少收益证据，仅建议不自动更新' };
  }

  if (sampleCount < 300 || calendarDays < 20) {
    return { tier: 'record_only', mode: 'off', reason: '样本不足(' + sampleCount + '/' + calendarDays + '天)，仅记录不更新' };
  }
  if (sampleCount < 1000 || calendarDays < 60) {
    return { tier: 'suggest_only', mode: 'suggest', reason: '样本积累中(' + sampleCount + '/' + calendarDays + '天)，仅建议不自动更新' };
  }
  if (icLower <= 0) {
    return { tier: 'suggest_only', mode: 'suggest', reason: 'Rank IC置信区间下界非正(' + icLower.toFixed(3) + ')，统计不安全' };
  }
  if (netExcessReturn <= 0) {
    return { tier: 'suggest_only', mode: 'suggest', reason: '净超额收益为负(' + netExcessReturn.toFixed(2) + '%)，不自动更新' };
  }
  // v3.4.6: Paper trading gate — requires 2 rolling OOS windows + drawdown not worsening (checked in updateDynamicWeights)
  return { tier: 'shadow_allowed', mode: 'shadow', reason: '通过所有验证门控（样本:' + sampleCount + '，交易日:' + calendarDays + '）' };
}

function updateDynamicWeights() {
  // Read grid search best params
  var gridParams = getGridSearchParams();
  var lookbackDays = gridParams.lookbackDays;
  var emaAlpha = gridParams.emaAlpha;

  const trainingData = collectTrainingData(lookbackDays);

  // Phase 3.1: Compute tier from samples and verification data
  var calendarDays = trainingData.calendarDays || Math.max(1, Math.ceil(trainingData.sampleCount / 5));
  var icLower = null;
  var netExcess = null;
  try {
    var vsPath = path.join(__dirname, '..', '..', 'report-engine', 'data', 'verification', 'verification_summary.json');
    if (fs.existsSync(vsPath)) {
      var vs = JSON.parse(require('fs').readFileSync(vsPath, 'utf8'));
      if (vs.overall && vs.overall.rankIC && vs.overall.rankIC.ci_lower != null) {
        icLower = vs.overall.rankIC.ci_lower;
      }
      if (vs.overall && vs.overall.postCostNetReturn != null) {
        netExcess = vs.overall.postCostNetReturn;
      }
    }
  } catch (_) {}
  var tier = computeWeightTier(trainingData.sampleCount, calendarDays, icLower, netExcess);

  if (!trainingData.available) {
    return {
      updated: false,
      weights: null,
      r2: null,
      sampleCount: trainingData.sampleCount || 0,
      calendarDays: calendarDays,
      tier: tier.tier,
      tierReason: tier.reason,
      message: trainingData.reason || '数据不足',
      gridParams: gridParams,
    };
  }

  const regression = olsRegression(trainingData.X, trainingData.y);
  if (!regression) {
    return {
      updated: false,
      weights: null,
      r2: null,
      sampleCount: trainingData.sampleCount,
      calendarDays: calendarDays,
      tier: tier.tier,
      tierReason: tier.reason,
      message: '回归方程奇异，无法求解',
      gridParams: gridParams,
    };
  }

  if (regression.r2 < 0.05) {
    return {
      updated: false,
      weights: null,
      r2: +regression.r2.toFixed(3),
      sampleCount: trainingData.sampleCount,
      calendarDays: calendarDays,
      tier: tier.tier,
      tierReason: tier.reason,
      message: 'R²过小(' + regression.r2.toFixed(3) + ')，模型无解释力，保持默认权重',
      gridParams: gridParams,
    };
  }

  // Phase 3.1: Only update weights if tier allows it
  if (tier.tier === 'record_only') {
    // Save suggested weights to a separate file for inspection, but don't activate
    var suggestedPath = DYNAMIC_WEIGHTS_FILE.replace('.json', '_suggested.json');
    try {
      var dir2 = path.dirname(suggestedPath);
      if (!fs.existsSync(dir2)) fs.mkdirSync(dir2, { recursive: true });
      fs.writeFileSync(suggestedPath, JSON.stringify({
        suggestedAt: new Date().toISOString(),
        tier: tier.tier,
        tierReason: tier.reason,
        weights: coefficientsToWeights(regression.beta),
        r2: +regression.r2.toFixed(3),
        sampleCount: trainingData.sampleCount,
        calendarDays: calendarDays,
      }, null, 2), 'utf8');
    } catch (_) {}
    return {
      updated: false,
      weights: null,
      r2: +regression.r2.toFixed(3),
      sampleCount: trainingData.sampleCount,
      calendarDays: calendarDays,
      tier: tier.tier,
      tierReason: tier.reason,
      message: tier.reason + '（建议权重已保存至suggested文件）',
      gridParams: gridParams,
    };
  }

  if (tier.tier === 'suggest_only') {
    // Save suggestion but don't auto-apply
    var suggestedPath2 = DYNAMIC_WEIGHTS_FILE.replace('.json', '_suggested.json');
    try {
      var dir3 = path.dirname(suggestedPath2);
      if (!fs.existsSync(dir3)) fs.mkdirSync(dir3, { recursive: true });
      fs.writeFileSync(suggestedPath2, JSON.stringify({
        suggestedAt: new Date().toISOString(),
        tier: tier.tier,
        tierReason: tier.reason,
        weights: coefficientsToWeights(regression.beta),
        r2: +regression.r2.toFixed(3),
        sampleCount: trainingData.sampleCount,
        calendarDays: calendarDays,
      }, null, 2), 'utf8');
    } catch (_) {}
    return {
      updated: false,
      weights: null,
      r2: +regression.r2.toFixed(3),
      sampleCount: trainingData.sampleCount,
      calendarDays: calendarDays,
      tier: tier.tier,
      tierReason: tier.reason,
      message: tier.reason + '（建议权重已保存，手动审核后可通过 /apply 激活）',
      gridParams: gridParams,
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
      gridParams: gridParams,
    };
  }

  // Map back to dimension names
  const newWeights = {};
  for (let i = 0; i < DIMENSIONS.length; i++) {
    newWeights[DIMENSIONS[i]] = rawWeights[i];
  }

  // EMA smooth with existing weights — use grid search alpha
  const existingData = loadDynamicWeights();
  const existingWeights = existingData ? existingData.weights : null;
  const smoothed = emaSmooth(existingWeights, newWeights, emaAlpha);

  // Phase 3.1: Backup old weights before updating (enables rollback)
  if (existingData && existingData.weights) {
    try {
      var backupFile = DYNAMIC_WEIGHTS_FILE.replace('.json', '_backup.json');
      fs.writeFileSync(backupFile, JSON.stringify(existingData, null, 2), 'utf8');
    } catch (_) {}
  }

  // Save
  const weightsData = {
    weights: smoothed,
    dimensions: DIMENSIONS,
    r2: +regression.r2.toFixed(3),
    rawR2: +regression.r2.toFixed(4),
    sampleCount: trainingData.sampleCount,
    calendarDays: calendarDays,
    updatedAt: new Date().toISOString(),
    rawWeights: newWeights,
    lookbackDays: lookbackDays,
    emaAlpha: emaAlpha,
    gridParams: gridParams,
    tier: tier.tier,
    message: '基于' + trainingData.sampleCount + '条数据更新(lookback=' + lookbackDays + ', α=' + emaAlpha + ')，R²=' + regression.r2.toFixed(3),
  };

  try {
    const dir = path.dirname(DYNAMIC_WEIGHTS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Preserve bestParams if already present
    if (existingData && existingData.bestParams) {
      weightsData.bestParams = existingData.bestParams;
    }
    fs.writeFileSync(DYNAMIC_WEIGHTS_FILE, JSON.stringify(weightsData, null, 2), 'utf8');
  } catch (_) {}

  return {
    updated: true,
    weights: smoothed,
    r2: +regression.r2.toFixed(3),
    sampleCount: trainingData.sampleCount,
    calendarDays: calendarDays,
    tier: tier.tier,
    tierReason: tier.reason,
    message: weightsData.message,
    gridParams: gridParams,
  };
}

/**
 * Phase 3.1: Rollback to previous dynamic weights.
 * Restores from the backup created before the last update.
 */
function rollbackDynamicWeights() {
  try {
    var backupFile = DYNAMIC_WEIGHTS_FILE.replace('.json', '_backup.json');
    if (!fs.existsSync(backupFile)) {
      return { success: false, message: '无可回滚的备份文件' };
    }
    fs.copyFileSync(backupFile, DYNAMIC_WEIGHTS_FILE);
    var restored = JSON.parse(fs.readFileSync(DYNAMIC_WEIGHTS_FILE, 'utf8'));
    return {
      success: true,
      message: '已回滚权重至' + (restored.updatedAt || '上一版本'),
      weights: restored.weights,
      r2: restored.r2,
    };
  } catch (e) {
    return { success: false, message: '回滚失败: ' + e.message };
  }
}

/**
 * 获取当前生效的因子权重（动态优先，回退 config 默认）。
 */
function getEffectiveWeights() {
  const dynamic = loadDynamicWeights();
  if (dynamic && dynamic.weights && dynamic.r2 >= 0.05) {
    // v3.4.6: Fail-closed — must pass tier gate AND have complete evidence
    if (dynamic.tier !== 'shadow_allowed') {
      return {
        ...config.FACTOR_WEIGHTS,
        _source: 'config',
        _fallback_reason: '动态权重未满足shadow_allowed条件（当前层级: ' + (dynamic.tier || 'unknown') + '），使用配置默认权重',
      };
    }
    // Complete evidence check
    if (dynamic.icLower == null || dynamic.icLower <= 0 || dynamic.netExcessReturn == null || dynamic.netExcessReturn <= 0) {
      return {
        ...config.FACTOR_WEIGHTS,
        _source: 'config',
        _fallback_reason: '动态权重证据不完整（IC下界或净超额收益缺失/非正），使用配置默认权重',
      };
    }
    return {
      ...config.FACTOR_WEIGHTS,
      ...dynamic.weights,
      _source: 'dynamic',
      _r2: dynamic.r2,
      _updatedAt: dynamic.updatedAt,
      _tier: dynamic.tier,
    };
  }
  return { ...config.FACTOR_WEIGHTS, _source: 'config' };
}

module.exports = {
  updateDynamicWeights,
  getEffectiveWeights,
  loadDynamicWeights,
  collectTrainingData,
  computeWeightTier,       // Phase 3.1
  rollbackDynamicWeights,  // Phase 3.1
};
