/**
 * history_verifier.js — 历史复盘验证模块 (精简版)
 *
 * 替代旧 weekend_verifier.js (1071行)，精简为 ~350 行。
 * 只验证有真实数据的维度，不制造虚假精度。
 *
 * 每日验证: verifyFactors(date) — 因子信号方向 vs 实际收益
 * 每周验证: verifyWeekly(weekendDate) — 相似度 + 危机(仅波动率) + 板块 + 因子 + 洞察
 */

const fs = require('fs');
const path = require('path');

const CONFIG = require('../config');

const DATA_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data');
const ARCHIVE_DIR = path.join(DATA_DIR, 'weekend_archive');
const HISTORY_DIR = path.join(DATA_DIR, 'market_history', 'indices');
const SIMFOLIO_DIR = path.join(DATA_DIR, 'simfolio');

const FACTOR_NAMES = {
  H1: '缩量止跌', H2: '底部放量', H3: '逆势抗跌',
  H4: 'PE低估', H5: '高ROE低PB', H6: '现金流健康',
  H7: '低换手蓄力', H8: '短期反转', H9: '量价背离',
};

// -- Helpers --
function _gradeLabel(score, thresholds) {
  thresholds = thresholds || { a: 85, b: 70, c: 55, d: 40 };
  if (score >= thresholds.a) return 'A';
  if (score >= thresholds.b) return 'B';
  if (score >= thresholds.c) return 'C';
  if (score >= thresholds.d) return 'D';
  return 'F';
}

function _readArchiveIndex() {
  var indexPath = path.join(ARCHIVE_DIR, '_index.json');
  if (!fs.existsSync(indexPath)) return [];
  try {
    var raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    // Support both old format (plain array) and new format ({ entries: [...] })
    if (Array.isArray(raw)) return raw;
    return raw.entries || [];
  } catch (e) { return []; }
}

function _writeArchiveIndex(entries) {
  var indexPath = path.join(ARCHIVE_DIR, '_index.json');
  _ensureDir(ARCHIVE_DIR);
  fs.writeFileSync(indexPath, JSON.stringify({ entries: entries }, null, 2), 'utf8');
}

// VERIFICATION GRADE BOUNDARIES
// Composite: A>=85, B>=70, C>=55, D>=40, F<40
// Similarity: A>=90, B>=70, C>=50, D>=30, F<30
// Crisis: A>=85, B>=70, C>=50, D<50
// Sector: A>=80, B>=60, C>=40, D<40
// Factor: A>=85, B>=70, C>=50, D<50
// Insights: A>=80, B>=60, C>=40, D<40

function gradeLabel(score, thresholds) {
  var t = thresholds || { a: 85, b: 70, c: 55, d: 40 };
  if (score >= t.a) return 'A';
  if (score >= t.b) return 'B';
  if (score >= t.c) return 'C';
  if (score >= t.d) return 'D';
  return 'F';
}

function gradeLabelCn(grade) {
  var map = { A: '优秀', B: '良好', C: '合格', D: '偏差', F: '错误' };
  return map[grade] || grade;
}

// ==================== DAILY: Factor Verification ====================

/**
 * 验证昨日 factor 信号 vs 今日实际走势。
 * 返回: { date, available, factors: [{id, name, predicted, actual, correct, ...}], correctCount, totalCount }
 */
function verifyFactors(dateStr) {
  // Read factor_performance.json for hit rates
  var fpPath = path.join(SIMFOLIO_DIR, 'factor_performance.json');
  var fp = null;
  try { fp = JSON.parse(fs.readFileSync(fpPath, 'utf8')); } catch (e) {}

  // Read stock_factor_performance.json for per-stock signal verification
  var spPath = path.join(SIMFOLIO_DIR, 'stock_factor_performance.json');
  var sp = null;
  try { sp = JSON.parse(fs.readFileSync(spPath, 'utf8')); } catch (e) {}

  if (!fp || !sp) {
    return { available: false, message: '因子绩效数据暂不可用，等待数据积累' };
  }

  // Read today's SSE actual return
  var sseActual = _readSSEActual(dateStr);
  if (!sseActual) {
    return { available: false, message: '暂无今日指数数据' };
  }

  var factors = [];
  var correctCount = 0;
  var totalCount = 0;

  var fpFactors = fp.factors || [];
  for (var i = 0; i < 9; i++) {
    var id = 'H' + (i + 1);
    var name = FACTOR_NAMES[id] || id;

    // Find factor data from factor_performance
    var fData = fpFactors.find(function(f) { return f.id === id; });
    var hitRate = fData ? (fData.hitRate5d || fData.hitRate || 0) : 0;
    var avgReturn = fData ? (fData.avgReturn || 0) : 0;

    // Determine predicted direction (hitRate > 0.5 => bullish signal)
    var predictedBullish = hitRate >= 0.50;
    var actualBullish = sseActual.change > 0;
    var correct = (predictedBullish === actualBullish) || hitRate === 0; // no data = neutral = always "correct"

    if (hitRate > 0) totalCount++;
    if (hitRate > 0 && correct) correctCount++;

    factors.push({
      id: id,
      name: name,
      hitRate: hitRate,
      avgReturn: avgReturn,
      predictedDirection: predictedBullish ? 'bullish' : 'bearish',
      actualDirection: actualBullish ? 'bullish' : 'bearish',
      correct: correct,
    });
  }

  return {
    available: true,
    date: dateStr,
    sseActual: sseActual,
    factors: factors,
    correctCount: correctCount,
    totalCount: totalCount,
    accuracy: totalCount > 0 ? (correctCount / totalCount) : 0,
  };
}

function _readSSEActual(dateStr) {
  var hPath = path.join(HISTORY_DIR, 'sh000001.json');
  if (!fs.existsSync(hPath)) return null;
  try {
    var data = JSON.parse(fs.readFileSync(hPath, 'utf8'));
    if (!Array.isArray(data)) return null;
    // Find the date entry
    for (var i = data.length - 1; i >= 0; i--) {
      if (data[i].date === dateStr) {
        var prev = data[i - 1] || data[i];
        var change = prev.close ? ((data[i].close - prev.close) / prev.close * 100) : 0;
        return { change: change, close: data[i].close, date: dateStr };
      }
    }
  } catch (e) {}
  return null;
}

// ==================== WEEKLY: Full Verification ====================

/**
 * 验证周末分析预测 vs 实际结果。
 * 只需读取存档报告 + 实际结果，不需凭空制造精度。
 */
function verifyWeekly(weekendDate) {
  var archivePath = path.join(ARCHIVE_DIR, weekendDate + '.json');
  if (!fs.existsSync(archivePath)) {
    return { ok: false, message: '该周末无存档报告', weekend: weekendDate };
  }

  var report;
  try { report = JSON.parse(fs.readFileSync(archivePath, 'utf8')); }
  catch (e) { return { ok: false, message: '读取归档报告失败', weekend: weekendDate }; }

  // Compute actual outcomes for the following week
  var actual = _computeWeeklyActuals(weekendDate);

  // Verify each dimension (only where data exists)
  var similarityV = _verifySimilarity(report.similarity || [], actual);
  var crisisV = _verifyCrisisLight(report.crisisWarning, actual);
  var sectorV = _verifySectorRotation(report.sectorRotation, actual);
  var factorV = _verifyFactorEffectiveness(report.factorPerformance, actual);
  var insightsV = _verifyInsights(report.insights || [], actual);

  // Composite score — only weight dimensions that have real data
  var composite = _assembleComposite(similarityV, crisisV, sectorV, factorV, insightsV);

  // Save
  var vReport = {
    weekend: weekendDate,
    generatedAt: new Date().toISOString(),
    actualWeek: { start: actual.weekStart, end: actual.weekEnd },
    similarity: similarityV,
    crisis: crisisV,
    sector: sectorV,
    factor: factorV,
    insights: insightsV,
    overallScore: composite.score,
    overallGrade: composite.grade,
    isWeekComplete: actual.isWeekComplete,
  };

  var verifPath = path.join(ARCHIVE_DIR, weekendDate + '_verification.json');
  _ensureDir(ARCHIVE_DIR);
  fs.writeFileSync(verifPath, JSON.stringify(vReport, null, 2), 'utf8');

  // Update archive index
  _updateIndex(weekendDate, composite);

  return { ok: true, ...vReport };
}

function _computeWeeklyActuals(weekendDate) {
  // weekendDate = Saturday. Monday = +2, Friday = +6
  var sat = new Date(weekendDate + 'T00:00:00+08:00');
  var mon = new Date(sat.getTime() + 2 * 86400000);
  var fri = new Date(sat.getTime() + 6 * 86400000);
  var weekStart = mon.toISOString().slice(0, 10);
  var weekEnd = fri.toISOString().slice(0, 10);

  // SSE actuals
  var sseActual = _computeSSEWeek(weekStart, weekEnd);

  // Sector returns from correlation_history
  var sectorReturns = _computeSectorReturns(weekStart, weekEnd);

  // Factor hit rates from factor_performance
  var factorHits = _readFactorPerformance();

  // Is the week complete?
  var now = new Date();
  var isWeekComplete = now.toISOString().slice(0, 10) >= weekEnd;

  return { weekStart, weekEnd, sseActual, sectorReturns, factorHits, isWeekComplete };
}

function _computeSSEWeek(weekStart, weekEnd) {
  var hPath = path.join(HISTORY_DIR, 'sh000001.json');
  if (!fs.existsSync(hPath)) return null;
  try {
    var data = JSON.parse(fs.readFileSync(hPath, 'utf8'));
    if (!Array.isArray(data)) return null;

    var weekData = data.filter(function(d) { return d.date >= weekStart && d.date <= weekEnd; });
    if (weekData.length < 3) return null;

    var firstClose = weekData[0].close;
    var lastClose = weekData[weekData.length - 1].close;
    var fiveDayReturn = (lastClose - firstClose) / firstClose * 100;

    // Max drawdown during week
    var peak = weekData[0].close;
    var maxDD = 0;
    for (var i = 1; i < weekData.length; i++) {
      if (weekData[i].close > peak) peak = weekData[i].close;
      var dd = (weekData[i].close - peak) / peak * 100;
      if (dd < maxDD) maxDD = dd;
    }

    // Volatility (std dev of daily returns)
    var dailyReturns = [];
    for (var j = 1; j < weekData.length; j++) {
      dailyReturns.push((weekData[j].close - weekData[j-1].close) / weekData[j-1].close * 100);
    }
    var mean = dailyReturns.reduce(function(s, r) { return s + r; }, 0) / dailyReturns.length;
    var variance = dailyReturns.reduce(function(s, r) { return s + (r - mean) * (r - mean); }, 0) / dailyReturns.length;
    var vol = Math.sqrt(variance);

    // 10d and 20d returns (look back from weekEnd)
    var d10Return = null, d20Return = null;
    var endIdx = data.findIndex(function(d) { return d.date === weekData[weekData.length-1].date; });
    if (endIdx >= 10) {
      d10Return = (data[endIdx].close - data[endIdx - 10].close) / data[endIdx - 10].close * 100;
    }
    if (endIdx >= 20) {
      d20Return = (data[endIdx].close - data[endIdx - 20].close) / data[endIdx - 20].close * 100;
    }

    return { fiveDayReturn, tenDayReturn: d10Return, twentyDayReturn: d20Return, maxDrawdown: maxDD, volatility: vol, daysInWeek: weekData.length };
  } catch (e) {}
  return null;
}

function _computeSectorReturns(weekStart, weekEnd) {
  var corrPath = path.join(DATA_DIR, 'us_market', 'correlation_history.json');
  if (!fs.existsSync(corrPath)) return {};
  try {
    var corr = JSON.parse(fs.readFileSync(corrPath, 'utf8'));
    var days = corr.days || [];
    var weekDays = days.filter(function(d) { return d.date >= weekStart && d.date <= weekEnd; });
    if (weekDays.length < 2) return {};

    var sectors = CONFIG.SECTORS || [];
    var result = {};
    for (var s = 0; s < sectors.length; s++) {
      var sec = sectors[s];
      var firstVal = _extractSectorValue(weekDays[0].aStock || {}, sec);
      var lastVal = _extractSectorValue(weekDays[weekDays.length-1].aStock || {}, sec);
      if (firstVal !== null && lastVal !== null && firstVal !== 0) {
        result[sec] = (lastVal - firstVal) / Math.abs(firstVal) * 100;
      }
    }
    return result;
  } catch (e) {}
  return {};
}

function _extractSectorValue(aStock, sector) {
  // Try direct key match
  if (aStock[sector] !== undefined) return aStock[sector];
  // Try common aliases
  var aliases = {
    '机器人/具身智能': ['机器人', '具身智能'],
    '创新药/AI医疗': ['创新药', 'AI医疗', '医药'],
    '半导体/AI算力': ['半导体', 'AI算力'],
    '商业航天': ['商业航天', '航天'],
    '固态电池/储能': ['固态电池', '储能'],
    '有色金属/稀土': ['有色金属', '稀土', '有色'],
    '新型电力基建': ['新型电力', '电力基建'],
    '军工': ['军工'],
  };
  var keys = aliases[sector] || [sector];
  var sum = 0, count = 0;
  for (var i = 0; i < keys.length; i++) {
    if (aStock[keys[i]] !== undefined) { sum += aStock[keys[i]]; count++; }
  }
  return count > 0 ? sum / count : null;
}

function _readFactorPerformance() {
  var fpPath = path.join(SIMFOLIO_DIR, 'factor_performance.json');
  if (!fs.existsSync(fpPath)) return {};
  try {
    var fp = JSON.parse(fs.readFileSync(fpPath, 'utf8'));
    var factors = fp.factors || [];
    var result = {};
    for (var i = 0; i < factors.length; i++) {
      var f = factors[i];
      result[f.id] = {
        hitRate: f.hitRate || 0,
        hitRate5d: f.hitRate5d || null,
        hitRate20d: f.hitRate20d || null,
        avgReturn: f.avgReturn || 0,
        signalCount: f.signalCount || 0,
        trend: f.trend || 'stable',
      };
    }
    return result;
  } catch (e) {}
  return {};
}

// --- Verification sub-functions ---

function _verifySimilarity(similarityResults, actual) {
  if (!similarityResults || similarityResults.length === 0) {
    return { available: false, message: '无相似度预测数据' };
  }
  if (!actual.sseActual) {
    return { available: false, message: '无实际指数数据' };
  }

  var horizons = [5, 10, 20];
  var horizonResults = [];
  var totalGradeScore = 0;
  var horizonCount = 0;

  // Weighted ensemble prediction
  for (var h = 0; h < horizons.length; h++) {
    var horizon = horizons[h];
    var actualReturn = horizon === 5 ? actual.sseActual.fiveDayReturn
      : horizon === 10 ? actual.sseActual.tenDayReturn
      : actual.sseActual.twentyDayReturn;

    if (actualReturn == null) continue;

    // Weighted average of similarity matches
    var weightedSum = 0, weightTotal = 0;
    for (var i = 0; i < similarityResults.length; i++) {
      var m = similarityResults[i];
      var future = null;
      if (horizon === 5) future = m.future5d;
      else if (horizon === 10) future = m.future10d;
      else future = m.future20d;
      if (future && future.total != null) {
        var w = m.similarity || 0.5;
        weightedSum += w * future.total;
        weightTotal += w;
      }
    }
    if (weightTotal === 0) continue;

    var predicted = weightedSum / weightTotal;
    var directionCorrect = (predicted > 0) === (actualReturn > 0);
    var magnitudeError = Math.abs(predicted - actualReturn);

    var grade;
    if (!directionCorrect) grade = 'F';
    else if (magnitudeError < 1) grade = 'A';
    else if (magnitudeError < 3) grade = 'B';
    else if (magnitudeError < 5) grade = 'C';
    else grade = 'D';

    var gradeMap = { A: 100, B: 80, C: 60, D: 40, F: 0 };
    totalGradeScore += gradeMap[grade] || 0;
    horizonCount++;

    horizonResults.push({
      horizon: horizon,
      predicted: predicted,
      actual: actualReturn,
      directionCorrect: directionCorrect,
      magnitudeError: magnitudeError,
      grade: grade,
    });
  }

  var avgScore = horizonCount > 0 ? totalGradeScore / horizonCount : 0;
  var overallGrade = gradeLabel(avgScore, { a: 90, b: 70, c: 50, d: 30 });

  return {
    available: true,
    ensemble: horizonResults,
    overallScore: avgScore,
    overallGrade: overallGrade,
    directionCorrectCount: horizonResults.filter(function(h) { return h.directionCorrect; }).length,
    totalHorizons: horizonCount,
  };
}

function _verifyCrisisLight(crisisWarning, actual) {
  if (!crisisWarning || crisisWarning.score == null) {
    return { available: false, message: '无危机预警数据' };
  }
  if (!actual.sseActual) {
    return { available: false, message: '无实际指数数据' };
  }

  var predictedScore = crisisWarning.score;
  var actualDrawdown = actual.sseActual.maxDrawdown || 0;

  // Map drawdown to risk score
  var actualRiskScore;
  if (actualDrawdown > -1) actualRiskScore = 20;
  else if (actualDrawdown > -3) actualRiskScore = 40;
  else if (actualDrawdown > -5) actualRiskScore = 60;
  else if (actualDrawdown > -8) actualRiskScore = 80;
  else actualRiskScore = 100;

  var diff = predictedScore - actualRiskScore;
  var calibration;
  if (Math.abs(diff) <= 10) calibration = '准确';
  else if (diff > 10 && diff <= 25) calibration = '略有高估';
  else if (diff > 25) calibration = '明显高估';
  else if (diff < -10 && diff >= -25) calibration = '略有低估';
  else calibration = '明显低估';

  // Per-dimension verification: only volatility has real independent data
  var dimensions = (crisisWarning.dimensions || []).map(function(dim) {
    var hasRealData = dim.name === '波动率' || dim.key === 'volatility';
    var actualScore = null, match = null;
    if (hasRealData && actual.sseActual.volatility != null) {
      var vol = actual.sseActual.volatility;
      if (vol > 2.5) actualScore = 80;
      else if (vol > 1.8) actualScore = 65;
      else if (vol > 1.2) actualScore = 50;
      else if (vol > 0.8) actualScore = 35;
      else actualScore = 20;
      match = Math.abs((dim.score || 50) - actualScore) <= 15;
    }
    return {
      key: dim.key || dim.name,
      name: dim.name,
      predictedScore: dim.score || 50,
      actualScore: actualScore,
      match: match,
      verifiable: hasRealData,
      label: hasRealData ? '实际波动率 ' + (actual.sseActual.volatility || 0).toFixed(1) + '%' : '暂无直接验证数据',
    };
  });

  var calibrationScore = calibration === '准确' ? 100
    : calibration.indexOf('略有') >= 0 ? 70
    : calibration.indexOf('明显') >= 0 ? 30
    : 50;

  // Multi-week rank correlation (read other verified weeks)
  var rankCorrelation = _computeCrisisRankCorrelation(crisisWarning, actual);

  return {
    available: true,
    predictedScore: predictedScore,
    actualRiskScore: actualRiskScore,
    actualDrawdown: actualDrawdown,
    calibration: calibration,
    calibrationScore: calibrationScore,
    grade: gradeLabel(calibrationScore, { a: 85, b: 70, c: 50, d: 40 }),
    dimensions: dimensions,
    verifiableCount: dimensions.filter(function(d) { return d.verifiable; }).length,
    rankCorrelation: rankCorrelation,
  };
}

function _computeCrisisRankCorrelation(crisisWarning, actual) {
  // Read all verified weekends and compute Spearman
  var entries = _readArchiveIndex().filter(function(e) { return e.verified && e.overallScore != null; });
  if (entries.length < 4) return null;

    var predictions = [];
    var actuals = [];
    for (var i = 0; i < entries.length; i++) {
      var vp = path.join(ARCHIVE_DIR, entries[i].weekend + '_verification.json');
      if (fs.existsSync(vp)) {
        var v = JSON.parse(fs.readFileSync(vp, 'utf8'));
        if (v.crisis && v.crisis.predictedScore != null && v.crisis.actualRiskScore != null) {
          predictions.push(v.crisis.predictedScore);
          actuals.push(v.crisis.actualRiskScore);
        }
      }
    }
    if (predictions.length < 4) return null;
    return spearman(predictions, actuals);
}

function spearman(x, y) {
  // Compute Spearman rank correlation
  function rank(arr) {
    var sorted = arr.slice().sort(function(a, b) { return a - b; });
    return arr.map(function(v) { return sorted.indexOf(v) + 1; });
  }
  var rx = rank(x);
  var ry = rank(y);
  var n = rx.length;
  var d2 = 0;
  for (var i = 0; i < n; i++) { d2 += (rx[i] - ry[i]) * (rx[i] - ry[i]); }
  return 1 - (6 * d2) / (n * (n * n - 1));
}

function _verifySectorRotation(sectorRotation, actual) {
  if (!sectorRotation || !sectorRotation.matrix) {
    return { available: false, message: '无板块轮动数据' };
  }
  var sectors = sectorRotation.sectors || [];
  if (sectors.length === 0) return { available: false };

  var sectorReturns = actual.sectorReturns || {};
  var matrix = sectorRotation.matrix;
  var tpLead = 0, fpLead = 0, tpLag = 0, fpLag = 0, totalNonSync = 0;

  for (var i = 0; i < sectors.length; i++) {
    for (var j = 0; j < sectors.length; j++) {
      if (i === j) continue;
      var rel = matrix[i] && matrix[i][j] ? matrix[i][j].rel : null;
      if (!rel || rel === '-' || rel === '同步') continue;

      var retI = sectorReturns[sectors[i]];
      var retJ = sectorReturns[sectors[j]];
      if (retI == null || retJ == null) continue;

      var actualDiff = retI - retJ;
      totalNonSync++;

      if (rel === '领先' && actualDiff > 0) tpLead++;
      else if (rel === '领先' && actualDiff <= 0) fpLead++;
      if (rel === '滞后' && actualDiff < 0) tpLag++;
      else if (rel === '滞后' && actualDiff >= 0) fpLag++;
    }
  }

  var leadPrecision = (tpLead + fpLead) > 0 ? tpLead / (tpLead + fpLead) : 0;
  var lagPrecision = (tpLag + fpLag) > 0 ? tpLag / (tpLag + fpLag) : 0;
  var overallPrecision = (tpLead + tpLag + fpLead + fpLag) > 0
    ? (tpLead + tpLag) / (tpLead + tpLag + fpLead + fpLag)
    : 0;

  // Phase verification
  var phaseCorrect = null;
  if (sectorRotation.currentPhase) {
    var growthSectors = ['半导体/AI算力', '机器人/具身智能', '军工'];
    var defensiveSectors = ['有色金属/稀土', '新型电力基建'];
    var growthRet = 0, growthCount = 0, defenseRet = 0, defenseCount = 0;
    for (var k = 0; k < growthSectors.length; k++) {
      if (sectorReturns[growthSectors[k]] != null) { growthRet += sectorReturns[growthSectors[k]]; growthCount++; }
    }
    for (var l = 0; l < defensiveSectors.length; l++) {
      if (sectorReturns[defensiveSectors[l]] != null) { defenseRet += sectorReturns[defensiveSectors[l]]; defenseCount++; }
    }
    if (growthCount > 0 && defenseCount > 0) {
      var growthOutperforms = (growthRet / growthCount) > (defenseRet / defenseCount);
      var phase = sectorRotation.currentPhase.phase;
      var expectsGrowth = (phase === '普涨期' || phase === '周期扩散');
      phaseCorrect = (expectsGrowth === growthOutperforms);
    }
  }

  return {
    available: true,
    leadPrecision: leadPrecision,
    lagPrecision: lagPrecision,
    overallPrecision: overallPrecision,
    totalCells: totalNonSync,
    phaseCorrect: phaseCorrect,
    grade: gradeLabel(overallPrecision * 100, { a: 80, b: 60, c: 40, d: 30 }),
  };
}

function _verifyFactorEffectiveness(factorPerformance, actual) {
  if (!factorPerformance || factorPerformance.length === 0) {
    return { available: false, message: '无因子效能预测数据' };
  }
  var factorHits = actual.factorHits || {};
  var correctCount = 0, totalWithStatus = 0;

  var factors = factorPerformance.map(function(fp) {
    var actualData = factorHits[fp.id] || {};
    var predictedStatus = fp.status || 'STABLE';
    var actualHitRate = actualData.hitRate5d || actualData.hitRate || 0;
    var actualStatus;
    if (actualHitRate >= 0.55) actualStatus = 'HOT';
    else if (actualHitRate < 0.40 && actualHitRate > 0) actualStatus = 'COLD';
    else actualStatus = 'STABLE';

    // STABLE predictions always count as correct (neutral)
    var statusCorrect = predictedStatus === 'STABLE' ? true : (predictedStatus === actualStatus);
    if (predictedStatus !== 'STABLE') {
      totalWithStatus++;
      if (statusCorrect) correctCount++;
    }

    return {
      id: fp.id,
      name: fp.name || FACTOR_NAMES[fp.id] || fp.id,
      predictedStatus: predictedStatus,
      predictedHitRate: fp.hitRate || 0,
      actualStatus: actualStatus,
      actualHitRate: actualHitRate,
      statusCorrect: statusCorrect,
    };
  });

  var overallAccuracy = totalWithStatus > 0 ? correctCount / totalWithStatus : 0.5;

  return {
    available: true,
    factors: factors,
    correctCount: correctCount,
    totalWithStatus: totalWithStatus,
    overallAccuracy: overallAccuracy,
    grade: gradeLabel(overallAccuracy * 100, { a: 85, b: 70, c: 50, d: 40 }),
  };
}

function _verifyInsights(insights, actual) {
  if (!insights || insights.length === 0) {
    return { available: false, message: '无洞察数据' };
  }

  var results = insights.map(function(insight) {
    var verdict = 'neutral';
    var reason = '';

    if (insight.type === 'regime_alert') {
      var warned = (insight.suggestedAction || '').indexOf('减仓') >= 0
        || (insight.suggestedAction || '').indexOf('谨慎') >= 0
        || (insight.suggestedAction || '').indexOf('降低') >= 0;
      var actualDD = (actual.sseActual && actual.sseActual.maxDrawdown) || 0;
      if (warned && actualDD < -3) { verdict = 'good'; reason = '预警准确，实际回撤 ' + actualDD.toFixed(1) + '%'; }
      else if (warned && actualDD >= -3) { verdict = 'bad'; reason = '过度预警，实际回撤仅 ' + actualDD.toFixed(1) + '%'; }
      else if (!warned && actualDD < -3) { verdict = 'bad'; reason = '遗漏预警，实际回撤 ' + actualDD.toFixed(1) + '%'; }
      else if (!warned && actualDD >= -3) { verdict = 'good'; reason = '正确判断无需预警'; }
    } else if (insight.type === 'historical_parallel') {
      var bullish = (insight.suggestedAction || '').indexOf('看好') >= 0
        || (insight.suggestedAction || '').indexOf('乐观') >= 0
        || (insight.suggestedAction || '').indexOf('上涨') >= 0;
      var fiveDayRet = (actual.sseActual && actual.sseActual.fiveDayReturn) || 0;
      if (bullish && fiveDayRet > 0) { verdict = 'good'; reason = '看涨预测正确'; }
      else if (bullish && fiveDayRet <= 0) { verdict = 'bad'; reason = '看涨预测错误'; }
      else if (!bullish && fiveDayRet < 0) { verdict = 'good'; reason = '看跌预测正确'; }
      else if (!bullish && fiveDayRet >= 0) { verdict = 'bad'; reason = '看跌预测错误'; }
      else { reason = '方向判断不明确'; }
    } else if (insight.type === 'factor_preference') {
      reason = '因子偏好建议已纳入因子验证';
    } else if (insight.type === 'cross_market') {
      reason = '跨市场建议依赖外部市场数据，暂不单独验证';
    } else if (insight.type === 'position_sizing') {
      var reducing = (insight.suggestedAction || '').indexOf('减仓') >= 0;
      var dd = (actual.sseActual && actual.sseActual.maxDrawdown) || 0;
      if (reducing && dd < -5) { verdict = 'good'; reason = '减仓建议正确，实际回撤 ' + dd.toFixed(1) + '%'; }
      else if (reducing && dd >= -5) { verdict = 'bad'; reason = '过度减仓，实际回撤仅 ' + dd.toFixed(1) + '%'; }
      else { reason = '仓位建议中性'; }
    } else {
      reason = '未分类洞察，暂不验证';
    }

    return {
      type: insight.type,
      title: insight.title,
      verdict: verdict,
      reason: reason,
    };
  });

  var goodCount = results.filter(function(r) { return r.verdict === 'good'; }).length;
  var badCount = results.filter(function(r) { return r.verdict === 'bad'; }).length;
  var totalVerifiable = goodCount + badCount;
  var accuracy = totalVerifiable > 0 ? goodCount / totalVerifiable : 0.5;

  return {
    available: true,
    results: results,
    goodCount: goodCount,
    badCount: badCount,
    totalVerifiable: totalVerifiable,
    accuracy: accuracy,
    grade: gradeLabel(accuracy * 100, { a: 80, b: 60, c: 40, d: 30 }),
  };
}

function _assembleComposite(similarityV, crisisV, sectorV, factorV, insightsV) {
  var weights = { similarity: 0.30, crisis: 0.25, sector: 0.20, factor: 0.15, insights: 0.10 };
  var totalWeight = 0;
  var weightedSum = 0;
  var subGrades = {};

  if (similarityV.available) {
    weightedSum += (similarityV.overallScore || 0) * weights.similarity;
    totalWeight += weights.similarity;
    subGrades.similarity = similarityV.overallGrade;
  }
  if (crisisV.available) {
    weightedSum += (crisisV.calibrationScore || 50) * weights.crisis;
    totalWeight += weights.crisis;
    subGrades.crisis = crisisV.grade;
  }
  if (sectorV.available) {
    weightedSum += (sectorV.overallPrecision || 0) * 100 * weights.sector;
    totalWeight += weights.sector;
    subGrades.sector = sectorV.grade;
  }
  if (factorV.available) {
    weightedSum += (factorV.overallAccuracy || 0) * 100 * weights.factor;
    totalWeight += weights.factor;
    subGrades.factor = factorV.grade;
  }
  if (insightsV.available) {
    weightedSum += (insightsV.accuracy || 0.5) * 100 * weights.insights;
    totalWeight += weights.insights;
    subGrades.insights = insightsV.grade;
  }

  var score = totalWeight > 0 ? weightedSum / totalWeight : 0;
  var grade = gradeLabel(score);

  return { score, grade, subGrades, totalWeight };
}

// ==================== Persistence ====================

function getVerificationReport(weekendDate) {
  var p = path.join(ARCHIVE_DIR, weekendDate + '_verification.json');
  if (!fs.existsSync(p)) return { ok: false, weekend: weekendDate };
  try {
    return { ok: true, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch (e) {
    return { ok: false, message: '读取验证报告失败' };
  }
}

function getVerificationHistory() {
  var allEntries = _readArchiveIndex();
  if (!allEntries.length) return { ok: true, history: [] };

  var entries = allEntries.filter(function(e) { return e.verified; });
  var history = entries.map(function(e) {
    var vp = path.join(ARCHIVE_DIR, e.weekend + '_verification.json');
    if (fs.existsSync(vp)) {
      var v = JSON.parse(fs.readFileSync(vp, 'utf8'));
      return {
        weekend: e.weekend,
        generatedAt: v.generatedAt,
        overallScore: v.overallScore,
        overallGrade: v.overallGrade,
        subGrades: v.subGrades,
        isWeekComplete: v.isWeekComplete,
      };
    }
    return { weekend: e.weekend, overallScore: null, overallGrade: null };
  });
  return { ok: true, history };
}

function _updateIndex(weekendDate, composite) {
  var entries = _readArchiveIndex();
  var found = false;
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].weekend === weekendDate) {
      entries[i].verified = true;
      entries[i].overallScore = composite.score;
      entries[i].overallGrade = composite.grade;
      found = true;
      break;
    }
  }
  if (!found) {
    entries.push({ weekend: weekendDate, verified: true, overallScore: composite.score, overallGrade: composite.grade });
  }
  _writeArchiveIndex(entries);
}

function _ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
}

// ==================== Exports ====================

module.exports = {
  verifyFactors,
  verifyWeekly,
  getVerificationReport,
  getVerificationHistory,
  gradeLabel,
  gradeLabelCn,
};
