/**
 * sector_leadlag.js — 板块轮动领先/滞后预测
 *
 * 计算板块间的时移相关性，构建领先/滞后矩阵，
 * 预测：如果领先板块今天资金流入 → 滞后板块未来 3-5 天大概率也流入。
 *
 * 数据源：sector_flows/*.json 每日板块资金流
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data');
const LEADLAG_FILE = path.join(DATA_DIR, 'simfolio', 'sector_leadlag.json');

const TRACKED_SECTORS = [
  '半导体/AI算力', '机器人/具身智能', '创新药/AI医疗',
  '固态电池/储能', '有色金属/稀土', '新型电力基建',
  '军工', '商业航天',
];

/**
 * 从每日板块资金流数据构建历史序列。
 * 读取 scan_records 和 pipeline 结果的 sector 数据。
 */
function buildSectorFlowSeries() {
  const simfolioDir = path.join(DATA_DIR, 'simfolio');
  if (!fs.existsSync(simfolioDir)) return null;

  // Try to load from factor_performance.json cache
  const fpPath = path.join(simfolioDir, 'factor_performance.json');
  if (!fs.existsSync(fpPath)) return null;

  let fpData;
  try {
    fpData = JSON.parse(fs.readFileSync(fpPath, 'utf8'));
  } catch (_) { return null; }

  // Use daily snapshots' signal counts as sector activity proxy
  const snapshots = fpData.dailySnapshots || [];
  if (snapshots.length < 10) return null;

  // For sector flow data, try kb_dir entries
  const kbDir = path.join(DATA_DIR, 'knowledge_base');
  const sectorSeries = {};

  if (fs.existsSync(kbDir)) {
    const files = fs.readdirSync(kbDir).filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.json$/)).sort();
    const recentFiles = files.slice(-30);

    for (const f of recentFiles) {
      try {
        const kb = JSON.parse(fs.readFileSync(path.join(kbDir, f), 'utf8'));
        const date = f.replace('.json', '');

        // Extract sector data from knowledge base entries
        if (kb.analysis && kb.analysis.sectorFlows) {
          for (const [sector, flow] of Object.entries(kb.analysis.sectorFlows)) {
            if (!sectorSeries[sector]) sectorSeries[sector] = [];
            sectorSeries[sector].push({ date, netFlow: flow.netFlow || 0, majorNetFlow: flow.majorNetFlow || 0 });
          }
        }
      } catch (_) {}
    }
  }

  return sectorSeries;
}

/**
 * 计算两个时间序列的时移相关性。
 * 对时移 lag=1..5 天，计算 seriesA[t] 与 seriesB[t-lag] 的相关系数。
 *
 * @returns {Array} [{ lag, correlation }] 按相关系数绝对值降序
 */
function computeLeadLag(seriesA, seriesB, maxLag) {
  const maxL = maxLag || 5;
  const results = [];

  // Align series by date
  const datesA = seriesA.map(s => s.date);
  const valuesA = seriesA.map(s => s.netFlow || s.majorNetFlow || 0);
  const valuesB = seriesB.map(s => s.netFlow || s.majorNetFlow || 0);
  const dateMapB = {};
  seriesB.forEach((s, i) => { dateMapB[s.date] = valuesB[i]; });

  for (let lag = 0; lag <= maxL; lag++) {
    const pairs = [];
    for (let i = 0; i < seriesA.length; i++) {
      const dateA = datesA[i];
      // Find seriesB value 'lag' days before dateA
      const d = new Date(dateA + 'T12:00:00+08:00');
      d.setDate(d.getDate() - lag);
      const targetDate = d.toISOString().slice(0, 10);
      const valB = dateMapB[targetDate];
      if (valB != null) {
        pairs.push({ a: valuesA[i], b: valB });
      }
    }

    if (pairs.length >= 5) {
      const corr = pearsonCorrelation(pairs.map(p => p.a), pairs.map(p => p.b));
      results.push({ lag, correlation: +corr.toFixed(3), sampleSize: pairs.length });
    }
  }

  // Sort by absolute correlation descending
  results.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
  return results;
}

/**
 * Pearson correlation coefficient.
 */
function pearsonCorrelation(x, y) {
  const n = x.length;
  if (n < 3) return 0;

  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  const den = Math.sqrt(denX * denY);
  return den > 0 ? num / den : 0;
}

/**
 * 构建完整的板块领先/滞后矩阵。
 *
 * @returns {object} { matrix, predictions, updatedAt }
 */
function computeSectorLeadLagMatrix() {
  const sectorSeries = buildSectorFlowSeries();
  if (!sectorSeries || Object.keys(sectorSeries).length < 2) {
    return { available: false, message: '板块数据不足（需要≥2个板块的历史序列）', updatedAt: new Date().toISOString() };
  }

  const sectors = Object.keys(sectorSeries).filter(s => sectorSeries[s].length >= 10);
  if (sectors.length < 2) {
    return { available: false, message: '板块数据不足（每个板块需要≥10天数据）', updatedAt: new Date().toISOString() };
  }

  const matrix = [];
  const predictions = [];

  for (const sectorA of sectors) {
    for (const sectorB of sectors) {
      if (sectorA === sectorB) continue;

      const leadLags = computeLeadLag(sectorSeries[sectorA], sectorSeries[sectorB], 5);
      if (leadLags.length === 0) continue;

      const bestLag = leadLags[0];
      if (Math.abs(bestLag.correlation) < 0.3) continue; // weak correlation, skip

      matrix.push({
        leader: sectorA,
        follower: sectorB,
        bestLag: bestLag.lag,
        correlation: bestLag.correlation,
        sampleSize: bestLag.sampleSize,
        relationship: bestLag.lag === 0 ? '同步' :
          bestLag.correlation > 0 ? sectorA + '领先' + sectorB + bestLag.lag + '天' :
          sectorB + '领先' + sectorA + bestLag.lag + '天',
      });

      // Generate prediction if leader has recent data
      if (bestLag.lag > 0 && bestLag.correlation > 0.4) {
        const leaderSeries = sectorSeries[sectorA];
        const latest = leaderSeries[leaderSeries.length - 1];
        if (latest && latest.netFlow > 0) {
          predictions.push({
            leader: sectorA,
            follower: sectorB,
            lag: bestLag.lag,
            correlation: bestLag.correlation,
            signal: sectorA + '近5日资金净流入 → ' + sectorB + '预计' + bestLag.lag + '天后跟随上涨',
            confidence: bestLag.correlation > 0.6 ? 'high' : bestLag.correlation > 0.4 ? 'medium' : 'low',
          });
        }
      }
    }
  }

  // Sort matrix by absolute correlation
  matrix.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
  predictions.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

  const result = {
    available: matrix.length > 0,
    matrix: matrix.slice(0, 30), // top 30 relationships
    predictions: predictions.slice(0, 10), // top 10 predictions
    sectors: sectors,
    updatedAt: new Date().toISOString(),
  };

  // Persist
  try {
    const dir = path.dirname(LEADLAG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LEADLAG_FILE, JSON.stringify(result, null, 2), 'utf8');
  } catch (_) {}

  return result;
}

/**
 * 加载已缓存的板块轮动矩阵。
 */
function loadCachedLeadLag() {
  if (!fs.existsSync(LEADLAG_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(LEADLAG_FILE, 'utf8'));
  } catch (_) { return null; }
}

module.exports = {
  computeSectorLeadLagMatrix,
  loadCachedLeadLag,
};
