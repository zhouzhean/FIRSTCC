/**
 * cycle_factor_matrix.js — 周期×因子有效性矩阵
 *
 * 追踪不同市场周期下每个因子的预测命中率，
 * 在周期切换时自动调整因子偏好。
 *
 * 数据结构：
 *   {
 *     bullish: { H1: { hitRate, avgReturn, sampleSize }, ... preferredFactors, avoidFactors }
 *     slightly_bullish: { ... }
 *     sideways: { ... }
 *     slightly_bearish: { ... }
 *     bearish: { ... }
 *   }
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'simfolio');
const MATRIX_FILE = path.join(DATA_DIR, 'cycle_factor_matrix.json');

const FACTOR_IDS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9'];
const CYCLE_LABELS = ['bullish', 'slightly_bullish', 'sideways', 'slightly_bearish', 'bearish'];
const CYCLE_CN = {
  bullish: '牛市', slightly_bullish: '震荡偏多', sideways: '震荡',
  slightly_bearish: '震荡偏空', bearish: '熊市',
};

/**
 * 更新周期×因子矩阵。
 * 结合 market_cycle 的历史记录和 stock_factor_performance 的个股数据。
 *
 * @param {Array} cycleHistory - [{ date, cycle, score }, ...] 市场周期历史
 * @returns {object} 更新后的矩阵
 */
function updateCycleFactorMatrix(cycleHistory) {
  if (!cycleHistory || cycleHistory.length < 5) {
    return loadMatrix() || createEmptyMatrix();
  }

  // Load stock factor performance data
  const stockPerfPath = path.join(DATA_DIR, 'stock_factor_performance.json');
  if (!fs.existsSync(stockPerfPath)) {
    return loadMatrix() || createEmptyMatrix();
  }

  let stockData;
  try {
    stockData = JSON.parse(fs.readFileSync(stockPerfPath, 'utf8'));
  } catch (_) {
    return loadMatrix() || createEmptyMatrix();
  }

  const dailyRecords = stockData.dailyRecords || {};
  const dates = Object.keys(dailyRecords).sort();

  // Initialize accumulator
  const accum = {};
  for (const cycle of CYCLE_LABELS) {
    accum[cycle] = {};
    for (const fid of FACTOR_IDS) {
      accum[cycle][fid] = { hits: 0, total: 0, returns: [] };
    }
  }

  // For each date with known cycle, track factor signal → next-day stock return
  const cycleByDate = {};
  for (const ch of cycleHistory) {
    cycleByDate[ch.date] = ch.cycle;
  }

  for (let i = 0; i < dates.length - 1; i++) {
    const date = dates[i];
    const cycle = cycleByDate[date];
    if (!cycle || !accum[cycle]) continue;

    const records = dailyRecords[date] || [];
    const nextDate = dates[i + 1];
    const nextRecords = dailyRecords[nextDate] || [];

    for (const rec of records) {
      if (!rec.factorSignals || rec.factorSignals.length === 0) continue;

      // Find next-day price
      const nextRec = nextRecords.find(r => r.code === rec.code);
      if (!nextRec || !nextRec.price || !rec.price || rec.price <= 0) continue;

      const stockReturn = (nextRec.price - rec.price) / rec.price * 100;

      for (const sig of rec.factorSignals) {
        const fid = sig.id;
        if (!accum[cycle][fid]) continue;
        accum[cycle][fid].total++;
        accum[cycle][fid].returns.push(stockReturn);
        if (stockReturn > 0) accum[cycle][fid].hits++;
      }
    }
  }

  // Build matrix
  const matrix = {};
  for (const cycle of CYCLE_LABELS) {
    matrix[cycle] = {};
    const factorStats = [];

    for (const fid of FACTOR_IDS) {
      const stats = accum[cycle][fid];
      const hitRate = stats.total >= 5 ? +(stats.hits / stats.total).toFixed(3) : null;
      const avgReturn = stats.returns.length >= 5
        ? +(stats.returns.reduce((a, b) => a + b, 0) / stats.returns.length).toFixed(2)
        : null;

      matrix[cycle][fid] = {
        hitRate: hitRate,
        avgReturn: avgReturn,
        sampleSize: stats.total,
      };

      if (stats.total >= 5) {
        factorStats.push({ id: fid, hitRate, avgReturn, sampleSize: stats.total });
      }
    }

    // Determine preferred and avoid factors for this cycle
    factorStats.sort((a, b) => (b.hitRate || 0) - (a.hitRate || 0));
    const preferred = factorStats.filter(f => f.hitRate >= 0.55).map(f => f.id);
    const avoid = factorStats.filter(f => f.hitRate != null && f.hitRate < 0.40).map(f => f.id);

    matrix[cycle].preferredFactors = preferred;
    matrix[cycle].avoidFactors = avoid;
    matrix[cycle]._factorStats = factorStats;
  }

  // Save
  const result = {
    matrix: matrix,
    updatedAt: new Date().toISOString(),
    totalCyclesTracked: Object.keys(cycleByDate).length,
  };

  try {
    const dir = path.dirname(MATRIX_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(MATRIX_FILE, JSON.stringify(result, null, 2), 'utf8');
  } catch (_) {}

  return result;
}

/**
 * 获取当前周期推荐和避免的因子。
 *
 * @param {string} currentCycle - 当前周期标签
 * @returns {object} { preferredFactors, avoidFactors }
 */
function getCycleFactorPreferences(currentCycle) {
  const matrix = loadMatrix();
  if (!matrix || !matrix.matrix || !matrix.matrix[currentCycle]) {
    return { preferredFactors: [], avoidFactors: [] };
  }

  const cycleData = matrix.matrix[currentCycle];
  return {
    cycle: currentCycle,
    cycleLabel: CYCLE_CN[currentCycle] || currentCycle,
    preferredFactors: cycleData.preferredFactors || [],
    avoidFactors: cycleData.avoidFactors || [],
    factorStats: cycleData._factorStats || [],
  };
}

/**
 * 获取完整的周期×因子热力图数据（用于前端渲染）。
 */
function getHeatmapData() {
  const matrix = loadMatrix();
  if (!matrix || !matrix.matrix) return null;

  const heatmap = [];
  for (const [cycle, factors] of Object.entries(matrix.matrix)) {
    for (const fid of FACTOR_IDS) {
      const f = factors[fid] || {};
      heatmap.push({
        cycle: cycle,
        cycleLabel: CYCLE_CN[cycle] || cycle,
        factorId: fid,
        hitRate: f.hitRate,
        avgReturn: f.avgReturn,
        sampleSize: f.sampleSize || 0,
      });
    }
  }

  return {
    heatmap: heatmap,
    cycles: CYCLE_LABELS.map(c => ({ id: c, label: CYCLE_CN[c] })),
    factors: FACTOR_IDS,
    updatedAt: matrix.updatedAt,
  };
}

function createEmptyMatrix() {
  const matrix = {};
  for (const cycle of CYCLE_LABELS) {
    matrix[cycle] = {};
    for (const fid of FACTOR_IDS) {
      matrix[cycle][fid] = { hitRate: null, avgReturn: null, sampleSize: 0 };
    }
    matrix[cycle].preferredFactors = [];
    matrix[cycle].avoidFactors = [];
  }
  return { matrix, updatedAt: new Date().toISOString(), totalCyclesTracked: 0 };
}

function loadMatrix() {
  if (!fs.existsSync(MATRIX_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(MATRIX_FILE, 'utf8'));
  } catch (_) { return null; }
}

module.exports = {
  updateCycleFactorMatrix,
  getCycleFactorPreferences,
  getHeatmapData,
  loadMatrix,
};
