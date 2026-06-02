/**
 * weekend_verifier.js — 周末分析验证引擎
 *
 * 周五盘后自动运行，验证上周周末分析的预测准确度：
 *   1. 历史相似度 → 加权综合预测 vs 实际涨跌幅
 *   2. 危机预警   → 危机分 vs 实际最大回撤
 *   3. 板块轮动   → 领先/滞后矩阵 vs 实际板块收益
 *   4. 因子效能   → HOT/COLD 预测 vs 实际命中率
 *   5. 智能洞察   → 每类 insight 建议 vs 实际结果
 *
 * 验证报告写入 data/weekend_archive/{date}_verification.json
 */

const fs = require('fs');
const path = require('path');

const CONFIG = require('../config');

const DATA_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data');
const ARCHIVE_DIR = path.join(DATA_DIR, 'weekend_archive');
const HISTORY_DIR = path.join(DATA_DIR, 'market_history', 'indices');
const WV = CONFIG.WEEKEND_VERIFICATION || {};

// Sector names — unified from config.SECTORS (single source of truth)
// These match pipeline.js / simfolio.js / weekend_analyzer.js sector definitions.
const SECTORS = CONFIG.SECTORS;

// Map config SECTORS (display names) to correlation_history.json keys
// Correlation history stores per-day aStock data with simplified key names.
// Some config sectors need to be matched against multiple correlation keys.
const SECTOR_TO_CORR_KEYS = {
  '机器人/具身智能': ['机器人', '具身智能'],
  '创新药/AI医疗': ['创新药', 'AI医疗', '医药'],
  '半导体/AI算力': ['半导体', 'AI算力'],
  '商业航天': ['商业航天', '航天'],
  '固态电池/储能': ['固态电池', '储能'],
  '有色金属/稀土': ['有色金属', '稀土', '有色'],
  '新型电力基建': ['新型电力', '电力基建'],
  '军工': ['军工'],
};

// Factor definitions matching weekend_analyzer
const FACTOR_NAMES = {
  H1: '缩量止跌', H2: '底部放量', H3: '逆势抗跌',
  H4: 'PE低估', H5: '高ROE低PB', H6: '现金流健康',
  H7: '低换手蓄力', H8: '短期反转', H9: '量价背离',
};

// ==================== 导出接口 ====================

module.exports = {
  verifyWeekend,
  verifyAllPending,
  getVerificationReport,
  getVerificationHistory,
  getLatestVerification,
};

// ==================== 主入口 ====================

async function verifyWeekend(weekendDate) {
  // 1. Load archived report
  const archivePath = path.join(ARCHIVE_DIR, weekendDate + '.json');
  if (!fs.existsSync(archivePath)) {
    console.log('[WeekendVerifier] No archive for ' + weekendDate);
    return { ok: false, message: '该周末无存档报告', weekend: weekendDate };
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
  } catch (e) {
    console.error('[WeekendVerifier] Failed to read archive:', e.message);
    return { ok: false, message: '读取归档报告失败', weekend: weekendDate };
  }

  // 2. Compute actual outcomes for the following trading week
  const actualOutcomes = _computeActualOutcomes(weekendDate);

  // 3. Verify each prediction type
  const similarityV = _verifySimilarity(report.similarity, actualOutcomes);
  const crisisV = _verifyCrisis(report.crisisWarning, actualOutcomes);
  const sectorV = _verifySectorRotation(report.sectorRotation, actualOutcomes);
  const factorV = _verifyFactorPerformance(report.factorPerformance, actualOutcomes);
  const insightsV = _verifyInsights(report.insights, actualOutcomes);

  // 4. Assemble comprehensive verification report
  const vReport = _assembleVerificationReport(weekendDate, report, actualOutcomes,
    similarityV, crisisV, sectorV, factorV, insightsV);

  // 5. Save verification report
  const verifPath = path.join(ARCHIVE_DIR, weekendDate + '_verification.json');
  fs.writeFileSync(verifPath, JSON.stringify(vReport, null, 2), 'utf8');
  console.log('[WeekendVerifier] Verification saved: ' + weekendDate);

  // 6. Update index
  _updateArchiveIndex(weekendDate, vReport);

  return { ok: true, ...vReport };
}

async function verifyAllPending() {
  const indexPath = path.join(ARCHIVE_DIR, '_index.json');
  if (!fs.existsSync(indexPath)) {
    console.log('[WeekendVerifier] No archives to verify');
    return [];
  }
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const pending = index.filter(e => !e.verified);
  console.log('[WeekendVerifier] Found ' + pending.length + ' pending weekend(s) to verify');

  const results = [];
  for (const entry of pending) {
    try {
      const result = await verifyWeekend(entry.weekend);
      results.push(result);
    } catch (e) {
      console.error('[WeekendVerifier] Failed to verify ' + entry.weekend + ':', e.message);
      results.push({ ok: false, weekend: entry.weekend, error: e.message });
    }
  }
  return results;
}

function getVerificationReport(weekendDate) {
  const verifPath = path.join(ARCHIVE_DIR, weekendDate + '_verification.json');
  if (!fs.existsSync(verifPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(verifPath, 'utf8'));
  } catch (_) { return null; }
}

function getLatestVerification() {
  const indexPath = path.join(ARCHIVE_DIR, '_index.json');
  if (!fs.existsSync(indexPath)) return null;
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  if (index.length === 0) return null;

  // Find the most recent verified weekend
  const verified = index.filter(e => e.verified);
  if (verified.length === 0) return null;
  return getVerificationReport(verified[0].weekend) || null;
}

function getVerificationHistory() {
  const indexPath = path.join(ARCHIVE_DIR, '_index.json');
  if (!fs.existsSync(indexPath)) return [];
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const results = [];
  for (const entry of index) {
    if (entry.verified) {
      try {
        const r = JSON.parse(fs.readFileSync(
          path.join(ARCHIVE_DIR, entry.weekend + '_verification.json'), 'utf8'));
        results.push({
          weekend: entry.weekend,
          generatedAt: entry.generatedAt,
          overallScore: r.overall ? r.overall.score : null,
          overallGrade: r.overall ? r.overall.grade : null,
          summary: r.summary || '',
        });
      } catch (_) { /* skip corrupt files */ }
    }
  }
  return results;
}

// ==================== 实际结果计算 ====================

function _computeActualOutcomes(weekendDate) {
  // Determine the following trading week (Monday — Friday)
  const saturday = new Date(weekendDate + 'T12:00:00+08:00');
  // Monday is saturday + 2 days
  const monday = new Date(saturday);
  monday.setDate(saturday.getDate() + 2);
  // Friday is saturday + 6 days
  const friday = new Date(saturday);
  friday.setDate(saturday.getDate() + 6);

  const weekStart = monday.toISOString().slice(0, 10);
  const weekEnd = friday.toISOString().slice(0, 10);

  // Load SSE Composite daily K-line
  const ssePath = path.join(HISTORY_DIR, 'sh000001.json');
  let sseKlines = [];
  if (fs.existsSync(ssePath)) {
    try { sseKlines = JSON.parse(fs.readFileSync(ssePath, 'utf8')); } catch (_) {}
  }

  // Compute actual SSE returns at various horizons
  const sseActual = _computeSSEActuals(sseKlines, weekStart);

  // Compute sector returns (from correlation_history)
  const sectorReturns = _computeSectorReturns(weekStart, weekEnd);

  // Compute factor hit rates (from factor_performance.json)
  const factorHits = _computeFactorHits(weekStart, weekEnd);

  // Load trading events during the week
  const marketEvents = _findWeekEvents(weekStart, weekEnd);

  return {
    weekStart,
    weekEnd,
    sseActual,
    sectorReturns,
    factorHits,
    marketEvents,
    isWeekComplete: _isWeekComplete(weekStart, weekEnd),
  };
}

function _computeSSEActuals(klines, weekStart) {
  // Find the last close before weekStart (Friday close or nearest)
  let startClose = null;
  let startIdx = -1;
  for (let i = klines.length - 1; i >= 0; i--) {
    if (klines[i].date && klines[i].date <= weekStart) {
      if (startClose == null || klines[i].date > (startIdx >= 0 ? klines[startIdx].date : '')) {
        startClose = klines[i].close;
        startIdx = i;
        break;
      }
    }
  }
  // Actually we need the close BEFORE the week starts (the benchmark),
  // then compare against closes DURING/AFTER the week
  for (let i = klines.length - 1; i >= 0; i--) {
    if (klines[i].date && klines[i].date < weekStart) {
      startClose = klines[i].close;
      startIdx = i;
      break;
    }
  }
  if (startClose == null || startIdx < 0) {
    return { fiveDayReturn: null, tenDayReturn: null, twentyDayReturn: null,
      maxDrawdown: null, volatility: null, available: false };
  }

  // Get all bars from startIdx+1 onward
  const futureBars = klines.slice(startIdx + 1);

  function _computeReturn(bars, count) {
    if (bars.length < count) return null;
    const endClose = bars[Math.min(count - 1, bars.length - 1)].close;
    return ((endClose - startClose) / startClose) * 100;
  }

  const fiveDayReturn = _computeReturn(futureBars, 5);
  const tenDayReturn = _computeReturn(futureBars, 10);
  const twentyDayReturn = _computeReturn(futureBars, 20);

  // Max drawdown over next 5 trading days
  let maxDrawdown = 0;
  let peak = startClose;
  const bars5 = futureBars.slice(0, Math.min(5, futureBars.length));
  for (const bar of bars5) {
    if (bar.close > peak) peak = bar.close;
    const dd = (bar.close - peak) / peak * 100;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  // Volatility (std dev of daily returns over the week)
  let volatility = null;
  if (bars5.length >= 3) {
    const dailyReturns = [];
    let prev = startClose;
    for (const bar of bars5) {
      dailyReturns.push((bar.close - prev) / prev * 100);
      prev = bar.close;
    }
    const mean = dailyReturns.reduce((s, v) => s + v, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / dailyReturns.length;
    volatility = Math.sqrt(variance);
  }

  return {
    fiveDayReturn: fiveDayReturn != null ? +fiveDayReturn.toFixed(2) : null,
    tenDayReturn: tenDayReturn != null ? +tenDayReturn.toFixed(2) : null,
    twentyDayReturn: twentyDayReturn != null ? +twentyDayReturn.toFixed(2) : null,
    maxDrawdown: +maxDrawdown.toFixed(2),
    volatility: volatility != null ? +volatility.toFixed(2) : null,
    available: fiveDayReturn != null,
    startClose,
    startDate: weekStart,
  };
}

function _computeSectorReturns(weekStart, weekEnd) {
  // Read correlation_history.json to get sector proxy values
  const corrPath = path.join(DATA_DIR, 'us_market', 'correlation_history.json');
  if (!fs.existsSync(corrPath)) return {};

  let corrData;
  try { corrData = JSON.parse(fs.readFileSync(corrPath, 'utf8')); } catch (_) { return {}; }
  if (!corrData.days || corrData.days.length === 0) return {};

  const sectorReturns = {};
  for (const sector of SECTORS) {
    sectorReturns[sector] = null;
  }

  // Find the first and last trading day in the week range
  const weekDays = corrData.days.filter(d =>
    d.date >= weekStart && d.date <= weekEnd
  );

  if (weekDays.length < 2) return sectorReturns; // Need at least start and end

  const firstDay = weekDays[0];
  const lastDay = weekDays[weekDays.length - 1];

  for (const sector of SECTORS) {
    const keys = SECTOR_TO_CORR_KEYS[sector] || [];
    if (keys.length === 0) continue;

    // Get avg value for this sector on first and last day
    const firstVal = _avgCorrValue(firstDay, keys);
    const lastVal = _avgCorrValue(lastDay, keys);

    if (firstVal != null && lastVal != null && firstVal !== 0) {
      sectorReturns[sector] = +(((lastVal - firstVal) / Math.abs(firstVal)) * 100).toFixed(2);
    }
  }

  return sectorReturns;
}

function _avgCorrValue(dayData, keys) {
  if (!dayData.aStock) return null;
  const vals = [];
  for (const key of keys) {
    if (dayData.aStock[key] != null) vals.push(dayData.aStock[key]);
  }
  if (vals.length === 0) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

function _computeFactorHits(weekStart, weekEnd) {
  // Read factor_performance.json for the week's actual hit rates
  const fpPath = path.join(DATA_DIR, 'simfolio', 'factor_performance.json');
  if (!fs.existsSync(fpPath)) return {};

  let fpData;
  try { fpData = JSON.parse(fs.readFileSync(fpPath, 'utf8')); } catch (_) { return {}; }

  const factorHits = {};
  if (!fpData.factors || !Array.isArray(fpData.factors)) return {};

  for (const f of fpData.factors) {
    factorHits[f.id] = {
      name: f.name || FACTOR_NAMES[f.id] || f.id,
      hitRate: f.hitRate5d || f.hitRate || null,
      hitRate5d: f.hitRate5d || null,
      hitRate20d: f.hitRate20d || null,
      avgReturn: f.avgReturn || null,
      signalCount: f.signalCount || 0,
      trend: f.trend || 'stable',
      status: f.status || 'stable',
    };
  }

  return factorHits;
}

function _findWeekEvents(weekStart, weekEnd) {
  const eventsDir = path.join(DATA_DIR, 'events');
  if (!fs.existsSync(eventsDir)) return [];

  const events = [];
  try {
    const files = fs.readdirSync(eventsDir);
    for (const f of files) {
      const date = f.replace('.json', '');
      if (date >= weekStart && date <= weekEnd) {
        const content = JSON.parse(fs.readFileSync(path.join(eventsDir, f), 'utf8'));
        if (Array.isArray(content)) events.push(...content);
        else if (content.data && Array.isArray(content.data)) events.push(...content.data);
      }
    }
  } catch (_) {}
  return events;
}

function _isWeekComplete(weekStart, weekEnd) {
  const today = new Date().toISOString().slice(0, 10);
  return today >= weekEnd;
}

// ==================== 相似度验证 ====================

function _verifySimilarity(similarityResults, actualOutcomes) {
  const horizons = WV.similarityHorizons || [5, 10, 20];
  const sseActual = actualOutcomes.sseActual;
  const horizonKeys = { 5: 'fiveDayReturn', 10: 'tenDayReturn', 20: 'twentyDayReturn' };

  if (!similarityResults || similarityResults.length === 0 || !sseActual.available) {
    return { available: false, reason: '无相似度数据或市场数据不足' };
  }

  // Compute weighted ensemble prediction per horizon
  const ensemblePred = {};
  const totalWeight = similarityResults.reduce((s, m) => s + (m.similarity || 0), 0);

  for (const h of horizons) {
    let weightedSum = 0;
    for (const match of similarityResults) {
      const futureKey = 'future' + h + 'd';
      const future = match[futureKey];
      if (future && future.total != null) {
        weightedSum += (match.similarity || 0) * future.total;
      }
    }
    ensemblePred[h] = totalWeight > 0 ? +(weightedSum / totalWeight).toFixed(2) : null;
  }

  // Verify each horizon
  const horizonResults = {};
  for (const h of horizons) {
    const actual = sseActual[horizonKeys[h]];
    const predicted = ensemblePred[h];
    if (predicted == null || actual == null) {
      horizonResults[h + 'd'] = { available: false };
      continue;
    }

    const directionCorrect = (predicted >= 0 && actual >= 0) || (predicted < 0 && actual < 0);
    const magnitudeError = +Math.abs(predicted - actual).toFixed(2);

    let grade;
    if (!directionCorrect) grade = 'F';
    else if (magnitudeError < 1) grade = 'A';
    else if (magnitudeError < 3) grade = 'B';
    else if (magnitudeError < 5) grade = 'C';
    else grade = 'D';

    horizonResults[h + 'd'] = {
      predicted,
      actual,
      directionCorrect,
      magnitudeError,
      grade,
      label: _gradeLabel(grade),
    };
  }

  // Individual match verification (5-day horizon)
  const individualMatches = [];
  const actual5d = sseActual.fiveDayReturn;
  if (actual5d != null) {
    for (const match of similarityResults) {
      const future5d = match.future5d;
      if (!future5d || future5d.total == null) continue;
      const pred = future5d.total;
      const dirCorrect = (pred >= 0 && actual5d >= 0) || (pred < 0 && actual5d < 0);
      const magErr = +Math.abs(pred - actual5d).toFixed(2);
      let g;
      if (!dirCorrect) g = 'F';
      else if (magErr < 1) g = 'A';
      else if (magErr < 3) g = 'B';
      else if (magErr < 5) g = 'C';
      else g = 'D';
      individualMatches.push({
        startDate: match.startDate,
        endDate: match.endDate,
        similarity: match.similarity,
        simLabel: match.simLabel,
        predicted5d: pred,
        actual5d,
        directionCorrect: dirCorrect,
        magnitudeError: magErr,
        grade: g,
      });
    }
  }

  // Overall grade (average grade across horizons)
  const grades = Object.values(horizonResults)
    .filter(r => r.grade)
    .map(r => r.grade);
  const gradeScores = { A: 100, B: 80, C: 60, D: 40, F: 0 };
  const avgScore = grades.length > 0
    ? grades.reduce((s, g) => s + (gradeScores[g] || 0), 0) / grades.length
    : 0;
  const overallGrade = avgScore >= 90 ? 'A' : avgScore >= 70 ? 'B' : avgScore >= 50 ? 'C' : avgScore >= 30 ? 'D' : 'F';

  return {
    available: true,
    ensemble: horizonResults,
    individualMatches,
    overallGrade,
    overallScore: +avgScore.toFixed(1),
    directionCorrectCount: individualMatches.filter(m => m.directionCorrect).length,
    totalMatches: individualMatches.length,
  };
}

// ==================== 危机预警验证 ====================

function _verifyCrisis(crisisWarning, actualOutcomes) {
  if (!crisisWarning || !actualOutcomes.sseActual.available) {
    return { available: false, reason: '无危机预警数据或市场数据不足' };
  }

  const predictedScore = crisisWarning.score;
  const actualDrawdown = actualOutcomes.sseActual.maxDrawdown || 0;
  const actualVol = actualOutcomes.sseActual.volatility || 0;

  // Map actual drawdown to 0-100 score scale (matching crisis scores)
  let actualRiskScore;
  if (actualDrawdown > -1) actualRiskScore = 20;
  else if (actualDrawdown > -3) actualRiskScore = 40;
  else if (actualDrawdown > -5) actualRiskScore = 60;
  else if (actualDrawdown > -8) actualRiskScore = 80;
  else actualRiskScore = 100;

  const diff = predictedScore - actualRiskScore;
  let calibrationLabel;
  if (Math.abs(diff) <= 10) calibrationLabel = '准确';
  else if (diff > 10 && diff <= 25) calibrationLabel = '略有高估';
  else if (diff > 25) calibrationLabel = '明显高估';
  else if (diff < -10 && diff >= -25) calibrationLabel = '略有低估';
  else calibrationLabel = '明显低估';

  // Per-dimension verification
  const dimVerif = (crisisWarning.dimensions || []).map(dim => {
    let actualProxy, proxyLabel;
    switch (dim.name) {
      case '波动率':
        actualProxy = actualVol;
        // Map vol to 0-100: vol>2.5→80, >1.8→65, >1.2→50, >0.8→35, else→20
        if (actualVol > 2.5) actualProxy = 80;
        else if (actualVol > 1.8) actualProxy = 65;
        else if (actualVol > 1.2) actualProxy = 50;
        else if (actualVol > 0.8) actualProxy = 35;
        else actualProxy = 20;
        proxyLabel = '实际波动率 ' + actualVol.toFixed(1) + '%';
        break;
      case '流动性':
        proxyLabel = '暂无直接验证数据';
        actualProxy = 50; // neutral, no data
        break;
      case '估值':
        proxyLabel = '暂无直接验证数据';
        actualProxy = 50;
        break;
      case '市场宽度':
        proxyLabel = '暂无直接验证数据';
        actualProxy = 50;
        break;
      case '北向资金':
        proxyLabel = '暂无直接验证数据';
        actualProxy = 50;
        break;
      case '两融余额':
        proxyLabel = '暂无数据源';
        actualProxy = 50;
        break;
      default:
        proxyLabel = '暂无验证数据';
        actualProxy = 50;
    }
    actualProxy = +actualProxy.toFixed(1);
    const match = Math.abs(dim.score - actualProxy) <= 15;
    return {
      name: dim.name,
      predictedScore: dim.score,
      actualScore: actualProxy,
      match,
      proxyLabel,
    };
  });

  // Multi-week rank correlation (if enough data)
  const rankCorrelation = _computeCrisisRankCorrelation();

  return {
    available: true,
    predictedScore,
    actualRiskScore,
    actualDrawdown,
    calibration: calibrationLabel,
    calibrationDiff: diff,
    dimensionVerification: dimVerif,
    rankCorrelation,
    rankCorrelationLabel: rankCorrelation != null
      ? (rankCorrelation >= 0.7 ? '强相关' : rankCorrelation >= 0.4 ? '中等相关' : '弱相关')
      : null,
    rankCorrelationWeeks: rankCorrelation != null ? _countVerifiedWeeks() : 0,
  };
}

function _computeCrisisRankCorrelation() {
  const index = _loadVerifIndex();
  const minWeeks = WV.crisisCorrelationMinWeeks || 4;
  const verified = index.filter(e => e.verified && e.overallScore != null);
  if (verified.length < minWeeks) return null;

  // Collect crisis scores and actual drawdowns
  const pairs = [];
  for (const entry of verified) {
    const vPath = path.join(ARCHIVE_DIR, entry.weekend + '_verification.json');
    try {
      const v = JSON.parse(fs.readFileSync(vPath, 'utf8'));
      if (v.crisis && v.crisis.predictedScore != null && v.crisis.actualRiskScore != null) {
        pairs.push({ score: v.crisis.predictedScore, actual: v.crisis.actualRiskScore });
      }
    } catch (_) {}
  }
  if (pairs.length < minWeeks) return null;

  // Spearman rank correlation
  const n = pairs.length;
  const rankScore = _ranks(pairs.map(p => p.score));
  const rankActual = _ranks(pairs.map(p => p.actual));
  const d2Sum = rankScore.reduce((s, r, i) => s + (r - rankActual[i]) ** 2, 0);
  const rho = +(1 - (6 * d2Sum) / (n * (n ** 2 - 1))).toFixed(2);
  return rho;
}

function _countVerifiedWeeks() {
  const index = _loadVerifIndex();
  return index.filter(e => e.verified).length;
}

function _ranks(values) {
  const sorted = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array(values.length);
  for (let i = 0; i < sorted.length; i++) {
    ranks[sorted[i].i] = i + 1;
  }
  return ranks;
}

// ==================== 板块轮动验证 ====================

function _verifySectorRotation(sectorRotation, actualOutcomes) {
  if (!sectorRotation || !sectorRotation.matrix) {
    return { available: false, reason: '无板块轮动数据' };
  }

  const sectorReturns = actualOutcomes.sectorReturns;
  const sectorNames = sectorRotation.sectors || SECTORS;
  const matrix = sectorRotation.matrix;
  const n = sectorNames.length;

  // Build actual return comparison matrix
  const actualComp = [];
  for (let i = 0; i < n; i++) {
    actualComp[i] = [];
    for (let j = 0; j < n; j++) {
      const ri = sectorReturns[sectorNames[i]];
      const rj = sectorReturns[sectorNames[j]];
      if (i === j || ri == null || rj == null) {
        actualComp[i][j] = null; // can't compare
      } else {
        actualComp[i][j] = ri - rj; // positive = i outperformed j
      }
    }
  }

  // Compare predictions vs actual
  let tpLead = 0, fpLead = 0, tpLag = 0, fpLag = 0, totalLeadPred = 0, totalLagPred = 0;
  let verifiedCells = 0, totalNonDiag = 0;

  const matrixVerif = [];
  for (let i = 0; i < n; i++) {
    matrixVerif[i] = [];
    for (let j = 0; j < n; j++) {
      if (i === j) {
        matrixVerif[i][j] = { cell: matrix[i][j], result: 'diagonal' };
        continue;
      }
      totalNonDiag++;
      const pred = matrix[i][j] ? matrix[i][j].rel : null;
      const actual = actualComp[i][j];

      if (actual == null) {
        matrixVerif[i][j] = { cell: matrix[i][j], result: 'no_data', actualDiff: null };
        continue;
      }
      verifiedCells++;

      let result = 'no_prediction';
      if (pred === '领先') {
        totalLeadPred++;
        if (actual > 0) { tpLead++; result = 'tp_lead'; }
        else { fpLead++; result = 'fp_lead'; }
      } else if (pred === '滞后') {
        totalLagPred++;
        if (actual < 0) { tpLag++; result = 'tp_lag'; }
        else { fpLag++; result = 'fp_lag'; }
      } else if (pred === '同步') {
        result = Math.abs(actual) < 0.5 ? 'tp_sync' : 'fp_sync';
      }

      matrixVerif[i][j] = {
        cell: matrix[i][j],
        result,
        predictedRel: pred,
        actualDiff: +actual.toFixed(2),
      };
    }
  }

  const leadPrecision = totalLeadPred > 0 ? +(tpLead / totalLeadPred).toFixed(2) : null;
  const lagPrecision = totalLagPred > 0 ? +(tpLag / totalLagPred).toFixed(2) : null;
  const totalCorrect = tpLead + tpLag;
  const totalPred = totalLeadPred + totalLagPred;
  const overallPrecision = totalPred > 0 ? +(totalCorrect / totalPred).toFixed(2) : null;

  // Phase verification
  let phaseCorrect = null;
  if (sectorRotation.currentPhase) {
    const phaseName = sectorRotation.currentPhase.phase;
    // Check if growth sectors actually outperformed
    const growthSectors = ['半导体/AI算力', '机器人/具身AI', '军工/航天'];
    const defensiveSectors = ['金融', '有色/稀土', '新电力'];
    const growthRet = _avgReturn(growthSectors, sectorReturns);
    const defRet = _avgReturn(defensiveSectors, sectorReturns);

    if (growthRet != null && defRet != null) {
      const growthOutperformed = growthRet > defRet;
      if (phaseName === '普涨期' || phaseName === '周期扩散') {
        phaseCorrect = growthOutperformed;
      } else if (phaseName === '防御期' || phaseName === '回调洗牌') {
        phaseCorrect = !growthOutperformed;
      }
    }
  }

  return {
    available: true,
    leadPrecision,
    lagPrecision,
    overallPrecision,
    verifiedCells,
    totalCells: totalNonDiag,
    phaseCorrect,
    phaseName: sectorRotation.currentPhase ? sectorRotation.currentPhase.phase : null,
    matrixVerification: matrixVerif,
    sectorNames,
    sectorReturns,
    summary: overallPrecision != null
      ? ('板块领先/滞后预测精确率: ' + (overallPrecision * 100).toFixed(0) + '%')
      : '板块数据不足，无法验证',
  };
}

function _avgReturn(sectors, sectorReturns) {
  let sum = 0, count = 0;
  for (const s of sectors) {
    if (sectorReturns[s] != null) { sum += sectorReturns[s]; count++; }
  }
  return count > 0 ? sum / count : null;
}

// ==================== 因子效能验证 ====================

function _verifyFactorPerformance(factorPerformance, actualOutcomes) {
  if (!factorPerformance || factorPerformance.length === 0) {
    return { available: false, reason: '无因子效能数据' };
  }

  const factorHits = actualOutcomes.factorHits;
  const hotThreshold = WV.factorHotThreshold || 0.55;
  const coldThreshold = WV.factorColdThreshold || 0.40;

  const factors = [];
  let correctCount = 0, totalWithStatus = 0;

  for (const fp of factorPerformance) {
    const actual = factorHits[fp.id] || {};
    const actualHitRate = actual.hitRate || null;

    let actualStatus = 'STABLE';
    if (actualHitRate != null) {
      if (actualHitRate >= hotThreshold) actualStatus = 'HOT';
      else if (actualHitRate < coldThreshold) actualStatus = 'COLD';
    }

    let statusCorrect = null;
    if (fp.status && actualStatus) {
      // STABLE predictions are always "correct" (neutral)
      if (fp.status === 'STABLE') {
        statusCorrect = true;
      } else if (fp.status === 'HOT') {
        statusCorrect = actualStatus === 'HOT';
        totalWithStatus++;
      } else if (fp.status === 'COLD') {
        statusCorrect = actualStatus === 'COLD';
        totalWithStatus++;
      }
      if (statusCorrect && fp.status !== 'STABLE') correctCount++;
    }

    const hitRateError = (fp.hitRate != null && actualHitRate != null)
      ? +(Math.abs(fp.hitRate - actualHitRate) * 100).toFixed(1)
      : null;

    factors.push({
      id: fp.id,
      name: fp.name || FACTOR_NAMES[fp.id] || fp.id,
      predictedStatus: fp.status,
      actualStatus,
      predictedHitRate: fp.hitRate != null ? +(fp.hitRate * 100).toFixed(1) + '%' : null,
      actualHitRate: actualHitRate != null ? +(actualHitRate * 100).toFixed(1) + '%' : null,
      statusCorrect,
      hitRateError,
      predictedAvgReturn: fp.avgReturn,
      actualAvgReturn: actual.avgReturn || null,
    });
  }

  const overallAccuracy = totalWithStatus > 0 ? +(correctCount / totalWithStatus).toFixed(2) : null;

  return {
    available: true,
    factors,
    correctCount,
    totalWithStatus,
    overallAccuracy,
    summary: overallAccuracy != null
      ? ('因子预测准确率: ' + (overallAccuracy * 100).toFixed(0) + '% (' + correctCount + '/' + totalWithStatus + ')')
      : '因子数据不足',
  };
}

// ==================== Insights 验证 ====================

function _verifyInsights(insights, actualOutcomes) {
  if (!insights || insights.length === 0) {
    return { available: false, reason: '无洞察数据' };
  }

  const sseActual = actualOutcomes.sseActual;
  const sectorReturns = actualOutcomes.sectorReturns;

  const verdicts = insights.map(insight => {
    let outcome = 'neutral', detail = '无法量化验证';

    switch (insight.type) {
      case 'regime_alert': {
        // If suggested reducing position and actual drawdown > 3% → good
        const action = insight.suggestedAction || '';
        const isWarn = action.includes('减仓') || action.includes('降低') || action.includes('谨慎');
        const dd = sseActual.maxDrawdown || 0;
        if (isWarn && dd < -3) { outcome = 'good'; detail = '预警准确，实际回撤' + dd.toFixed(1) + '%'; }
        else if (isWarn && dd >= -3) { outcome = 'bad'; detail = '预警过度，实际回撤仅' + dd.toFixed(1) + '%'; }
        else if (!isWarn && dd < -3) { outcome = 'bad'; detail = '未预警，实际回撤' + dd.toFixed(1) + '%'; }
        else if (!isWarn && dd >= -3) { outcome = 'good'; detail = '判断正确，市场风险确实较低'; }
        break;
      }
      case 'historical_parallel': {
        const action = insight.suggestedAction || '';
        const isBull = action.includes('看好') || action.includes('乐观') || action.includes('上涨');
        const isBear = action.includes('谨慎') || action.includes('下跌') || action.includes('减仓');
        const ret5d = sseActual.fiveDayReturn;
        if (ret5d != null) {
          if (isBull && ret5d > 0) { outcome = 'good'; detail = '看涨正确，实际+ ' + ret5d.toFixed(2) + '%'; }
          else if (isBull && ret5d <= 0) { outcome = 'bad'; detail = '看涨错误，实际' + ret5d.toFixed(2) + '%'; }
          else if (isBear && ret5d < 0) { outcome = 'good'; detail = '看跌正确，实际' + ret5d.toFixed(2) + '%'; }
          else if (isBear && ret5d >= 0) { outcome = 'bad'; detail = '看跌错误，实际+' + ret5d.toFixed(2) + '%'; }
          else { detail = '方向判断不明'; }
        }
        break;
      }
      case 'sector_preference': {
        const detailText = insight.detail || '';
        const growthKeys = ['半导体', 'AI', '机器人', '军工', '成长', '科技'];
        const defKeys = ['金融', '有色', '电力', '防守', '防御', '稳健'];
        const growthRet = _avgReturn(['半导体/AI算力', '机器人/具身AI', '军工/航天'], sectorReturns);
        const defRet = _avgReturn(['金融', '有色/稀土', '新电力'], sectorReturns);
        const favorsGrowth = growthKeys.some(k => detailText.includes(k));
        const favorsDef = defKeys.some(k => detailText.includes(k));
        if (growthRet != null && defRet != null) {
          if (favorsGrowth && growthRet > defRet) { outcome = 'good'; detail = '推荐成长板块正确'; }
          else if (favorsGrowth && growthRet <= defRet) { outcome = 'bad'; detail = '推荐成长板块错误'; }
          else if (favorsDef && defRet > growthRet) { outcome = 'good'; detail = '推荐防守板块正确'; }
          else if (favorsDef && defRet <= growthRet) { outcome = 'bad'; detail = '推荐防守板块错误'; }
        }
        break;
      }
      case 'factor_preference': {
        detail = '因子偏好建议已纳入因子验证';
        break; // Factor accuracy is covered by factor verification
      }
      case 'position_sizing': {
        const action = insight.suggestedAction || '';
        const dd = sseActual.maxDrawdown || 0;
        if (action.includes('减仓') || action.includes('降低仓位')) {
          if (dd < -5) { outcome = 'good'; detail = '减仓正确，实际回撤' + dd.toFixed(1) + '%'; }
          else { outcome = 'bad'; detail = '减仓过度，实际回撤仅' + dd.toFixed(1) + '%'; }
        }
        break;
      }
      case 'cross_market': {
        detail = '跨市场建议依赖外部市场数据，暂不单独验证';
        break;
      }
    }

    return {
      type: insight.type,
      title: insight.title,
      outcome,
      detail,
      suggestedAction: insight.suggestedAction,
      weight: insight.weight,
    };
  });

  const goodCount = verdicts.filter(v => v.outcome === 'good').length;
  const badCount = verdicts.filter(v => v.outcome === 'bad').length;
  const totalVerifiable = goodCount + badCount;

  return {
    available: true,
    verdicts,
    goodCount,
    badCount,
    totalVerifiable,
    totalInsights: insights.length,
    accuracy: totalVerifiable > 0 ? +(goodCount / totalVerifiable).toFixed(2) : null,
  };
}

// ==================== 综合报告组装 ====================

function _assembleVerificationReport(weekendDate, report, actualOutcomes,
                                      similarityV, crisisV, sectorV, factorV, insightsV) {
  // Weighted overall score
  const weights = { similarity: 0.30, crisis: 0.25, sector: 0.20, factor: 0.15, insights: 0.10 };

  let totalWeight = 0, weightedScore = 0;
  const subScores = {};

  // Similarity score
  if (similarityV.available && similarityV.overallScore != null) {
    subScores.similarity = { score: similarityV.overallScore, grade: similarityV.overallGrade };
    weightedScore += similarityV.overallScore * weights.similarity;
    totalWeight += weights.similarity;
  }

  // Crisis score
  if (crisisV.available) {
    const calibScore = crisisV.calibration === '准确' ? 100
      : crisisV.calibration.includes('略有') ? 70 : crisisV.calibration.includes('明显') ? 30 : 50;
    subScores.crisis = { score: calibScore, grade: calibScore >= 85 ? 'A' : calibScore >= 70 ? 'B' : calibScore >= 50 ? 'C' : 'D' };
    weightedScore += calibScore * weights.crisis;
    totalWeight += weights.crisis;
  }

  // Sector rotation score
  if (sectorV.available && sectorV.overallPrecision != null) {
    const sScore = sectorV.overallPrecision * 100;
    subScores.sector = { score: +sScore.toFixed(1), grade: sScore >= 80 ? 'A' : sScore >= 60 ? 'B' : sScore >= 40 ? 'C' : 'D' };
    weightedScore += sScore * weights.sector;
    totalWeight += weights.sector;
  }

  // Factor performance score
  if (factorV.available && factorV.overallAccuracy != null) {
    const fScore = factorV.overallAccuracy * 100;
    subScores.factor = { score: +fScore.toFixed(1), grade: fScore >= 85 ? 'A' : fScore >= 70 ? 'B' : fScore >= 50 ? 'C' : 'D' };
    weightedScore += fScore * weights.factor;
    totalWeight += weights.factor;
  }

  // Insights score
  if (insightsV.available && insightsV.accuracy != null) {
    const iScore = insightsV.accuracy * 100;
    subScores.insights = { score: +iScore.toFixed(1), grade: iScore >= 80 ? 'A' : iScore >= 60 ? 'B' : iScore >= 40 ? 'C' : 'D' };
    weightedScore += iScore * weights.insights;
    totalWeight += weights.insights;
  }

  // Normalize if some sections are unavailable
  let overallScore;
  if (totalWeight > 0) {
    overallScore = +(weightedScore / totalWeight).toFixed(1);
  } else {
    overallScore = 0;
  }

  const overallGrade = overallScore >= 85 ? 'A' : overallScore >= 70 ? 'B'
    : overallScore >= 55 ? 'C' : overallScore >= 40 ? 'D' : 'F';

  // Generate auto-summary
  const summaryParts = [];
  if (similarityV.available) {
    summaryParts.push('历史相似度' + _gradeLabelCn(similarityV.overallGrade) +
      '（方向' + similarityV.directionCorrectCount + '/' + similarityV.totalMatches + '正确）');
  }
  if (crisisV.available) {
    summaryParts.push('危机预警' + crisisV.calibration);
  }
  if (sectorV.available && sectorV.overallPrecision != null) {
    summaryParts.push('板块轮动精确率' + (sectorV.overallPrecision * 100).toFixed(0) + '%');
  }
  if (factorV.available && factorV.overallAccuracy != null) {
    summaryParts.push('因子准确率' + (factorV.overallAccuracy * 100).toFixed(0) + '%');
  }
  if (summaryParts.length === 0) {
    summaryParts.push('尚未累积足够的验证数据，等待下个周末分析引擎运行后自动验证');
  }

  return {
    weekend: weekendDate,
    verifiedAt: new Date().toISOString(),
    verifiedWeek: {
      start: actualOutcomes.weekStart,
      end: actualOutcomes.weekEnd,
    },
    overall: {
      score: overallScore,
      grade: overallGrade,
      label: totalWeight > 0 ? _gradeLabelCn(overallGrade) : '数据不足',
    },
    subScores,
    similarity: similarityV,
    crisis: crisisV,
    sector: sectorV,
    factor: factorV,
    insights: insightsV,
    summary: summaryParts.join('；') + (totalWeight > 0 ? ('。综合评级: ' + overallGrade) : ''),
  };
}

// ==================== 工具函数 ====================

function _loadVerifIndex() {
  const indexPath = path.join(ARCHIVE_DIR, '_index.json');
  if (fs.existsSync(indexPath)) {
    try { return JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch (_) {}
  }
  return [];
}

function _updateArchiveIndex(weekendDate, vReport) {
  const indexPath = path.join(ARCHIVE_DIR, '_index.json');
  let index = _loadVerifIndex();
  let entry = index.find(e => e.weekend === weekendDate);
  if (!entry) {
    // Create minimal entry if index doesn't have it (e.g., manual archive)
    entry = {
      weekend: weekendDate,
      generatedAt: null,
      cycles: 0,
      crisisScore: null,
      similarityCount: 0,
      insights: 0,
    };
    index.push(entry);
  }
  entry.verified = true;
  entry.verifiedAt = vReport.verifiedAt;
  entry.overallGrade = vReport.overall ? vReport.overall.grade : null;
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');
  console.log('[WeekendVerifier] Index updated: ' + weekendDate + ' → ' + (entry.overallGrade || '?'));
}

function _gradeLabel(grade) {
  const labels = { A: '优秀', B: '良好', C: '合格', D: '偏差', F: '错误' };
  return labels[grade] || grade;
}

function _gradeLabelCn(grade) {
  const labels = { A: '优秀', B: '良好', C: '合格', D: '偏差大', F: '方向错误' };
  return labels[grade] || grade;
}
