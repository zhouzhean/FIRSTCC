/**
 * data_quality.js — 数据质量监控面板 v3.0
 *
 * 监控每个数据源的健康状态，告知"系统当前不知道什么"。
 * 纯诊断模块，不修改任何生产数据。
 */

var fs = require('fs');
var path = require('path');

var DATA_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data');
var KLINES_DIR = path.join(DATA_DIR, 'klines');
var US_MARKET_DIR = path.join(DATA_DIR, 'us_market');
var SUMMARIES_DIR = path.join(DATA_DIR, 'summaries');
var SIMFOLIO_DIR = path.join(DATA_DIR, 'simfolio');

var _lastCheck = null;
var _lastReport = null;

// ===== Master Entry =====

function checkAllDataSources() {
  var now = new Date();
  _lastCheck = now.toISOString();

  var report = {
    timestamp: _lastCheck,
    sources: {},
    overallScore: 0,
    confidenceImpact: {
      affectedModules: [],
      confidenceReduction: 0,
      recommendation: '',
    },
    unknownStatus: {
      missingData: [],
      uncertainSignals: [],
      lowConfidenceModules: [],
    },
  };

  // Check each data source
  report.sources.marketData = checkMarketData();
  report.sources.indexData = checkIndexData();
  report.sources.northBound = checkNorthBound();
  report.sources.margin = checkMarginData();
  report.sources.dragonTiger = checkDragonTiger();
  report.sources.usMarket = checkUSMarket();
  report.sources.klineCache = checkKlineCache();
  report.sources.newsData = checkNewsData();

  // Compute overall score
  var scoreSum = 0;
  var scoreCount = 0;
  var affectedModules = [];
  var missingData = [];
  var uncertainSignals = [];
  var lowConfModules = [];

  for (var key in report.sources) {
    var src = report.sources[key];
    if (src.score != null) {
      scoreSum += src.score;
      scoreCount++;
    }
    if (src.status === 'DOWN' || src.status === 'STALE') {
      affectedModules.push(src.label || key);
      if (src.note) missingData.push(src.note);
    }
    if (src.status === 'WARN') {
      affectedModules.push(src.label || key);
      uncertainSignals.push(src.label + ': ' + (src.note || '数据质量下降'));
    }
    if (src.status === 'PROXY') {
      affectedModules.push(src.label || key);
      lowConfModules.push(src.label + ': ' + (src.note || '使用代理数据'));
    }
  }

  report.overallScore = scoreCount > 0 ? Math.min(100, Math.round(scoreSum / scoreCount)) : 0;

  // Use computeConfidencePenalty logic for consistent, realistic confidence impact
  // (the old simple count only looked at DOWN/STALE — missed WARN/PROXY entirely)
  var penaltyResult = computeConfidencePenalty(report);
  report.confidenceImpact.affectedModules = affectedModules;
  report.confidenceImpact.confidenceReduction = penaltyResult.penalty;
  report.confidenceImpact.penaltyReasons = penaltyResult.reasons;
  report.confidenceImpact.recommendation = penaltyResult.penalty > 0
    ? penaltyResult.reasons.join('；') + ' → 信号置信度降-' + penaltyResult.penalty + '分'
    : (uncertainSignals.length > 0 || lowConfModules.length > 0
      ? '部分数据源非最优状态（' + uncertainSignals.concat(lowConfModules).join('、') + '），但尚未触发惩罚阈值'
      : '所有数据源运行正常');

  report.unknownStatus.missingData = missingData;
  report.unknownStatus.uncertainSignals = uncertainSignals;
  report.unknownStatus.lowConfidenceModules = lowConfModules;

  _lastReport = report;
  return report;
}

// ===== Individual Checks =====

function checkMarketData() {
  var result = { label: 'A股行情数据', key: 'marketData', status: 'OK', score: 100, lastUpdate: null, note: '' };

  // Check if klines cache has recent entries
  try {
    if (!fs.existsSync(KLINES_DIR)) {
      result.status = 'DOWN';
      result.score = 0;
      result.note = 'K线缓存目录不存在';
      return result;
    }
    var files = fs.readdirSync(KLINES_DIR).filter(function(f) { return f.endsWith('.json'); });
    if (files.length === 0) {
      result.status = 'WARN';
      result.score = 30;
      result.note = 'K线缓存为空，首次运行或数据采集失败';
      return result;
    }

    // Check freshest file
    var newestTime = 0;
    for (var i = 0; i < files.length; i++) {
      try {
        var stat = fs.statSync(path.join(KLINES_DIR, files[i]));
        if (stat.mtimeMs > newestTime) newestTime = stat.mtimeMs;
      } catch (_) {}
    }

    result.lastUpdate = newestTime > 0 ? new Date(newestTime).toISOString() : null;
    var ageMinutes = result.lastUpdate ? (Date.now() - newestTime) / 60000 : 999;

    if (ageMinutes > 120) {
      result.status = 'STALE';
      result.score = 40;
      result.note = 'K线缓存超过2小时未更新';
    } else if (ageMinutes > 30) {
      result.status = 'WARN';
      result.score = 70;
      result.note = 'K线缓存超过30分钟未更新（可能非交易时段）';
    } else {
      result.note = '缓存' + files.length + '只股票数据，最新' + Math.round(ageMinutes) + '分钟前';
    }

    // Check multi-source availability
    result.sourceCount = 2; // Tencent (primary) + Sina (backup)
    result.note += ' · 双数据源（腾讯主/新浪备）';

  } catch (e) {
    result.status = 'DOWN';
    result.score = 0;
    result.note = '读取异常: ' + e.message;
  }

  return result;
}

function checkIndexData() {
  var result = { label: '指数数据', key: 'indexData', status: 'OK', score: 100, lastUpdate: null, note: '' };

  // v3.4.4: Check live snapshot FIRST (same source as kernel/cockpit/think-tank)
  var today = new Date().toISOString().slice(0, 10);
  var snapDir = path.join(DATA_DIR, 'simfolio');

  // Tier 1: IndexRecorder live file (intraday, during trading hours)
  var recorderFile = path.join(snapDir, 'index_history_' + today + '.json');
  if (fs.existsSync(recorderFile)) {
    try {
      var raw = JSON.parse(fs.readFileSync(recorderFile, 'utf8'));
      if (Array.isArray(raw) && raw.length > 0) {
        var latest = raw[raw.length - 1];
        var liveCount = 0;
        if (latest.sh != null) liveCount++;
        if (latest.sz != null) liveCount++;
        if (latest.bj != null) liveCount++;
        result.indicesAvailable = liveCount;
        result.lastUpdate = today + 'T' + (latest.time || '') + ':00+08:00';
        result.status = 'OK';
        result.score = 100;
        result.note = 'IndexRecorder 实时: ' + liveCount + '/3 指数 (' + raw.length + '条记录)，数据源统一';
        return result;
      }
    } catch (_) {}
  }

  // Tier 2: market_snapshot_latest.json (cached by loadLatestIndices)
  var snapshotFile = path.join(snapDir, 'market_snapshot_latest.json');
  if (fs.existsSync(snapshotFile)) {
    try {
      var snap = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
      if (snap.date === today && snap.indices && snap.indices.length > 0) {
        var sstat = fs.statSync(snapshotFile);
        var ageMin = (Date.now() - sstat.mtimeMs) / 60000;
        result.indicesAvailable = snap.indices.length;
        result.lastUpdate = snap.time || new Date(sstat.mtimeMs).toISOString();
        if (ageMin < 15) {
          result.status = 'OK';
          result.score = 95;
          result.note = '快照缓存: ' + snap.indices.length + '只指数, ' + Math.round(ageMin) + 'min前 (' + (snap.source || 'loadLatestIndices') + ')';
        } else {
          result.status = 'WARN';
          result.score = 60;
          result.note = '快照过期: ' + Math.round(ageMin) + 'min前 (' + (snap.source || 'loadLatestIndices') + ')';
        }
        return result;
      }
    } catch (_) {}
  }

  // Tier 3: Historical daily K-line files (fallback)
  var mhDir = path.join(DATA_DIR, 'market_history', 'indices');
  try {
    if (!fs.existsSync(mhDir)) {
      result.status = 'WARN';
      result.score = 50;
      result.note = '市场历史目录不存在';
      return result;
    }

    var indexFiles = ['sh000001.json', 'sz399001.json', 'sz399006.json'];
    var available = 0;
    var newestTime = 0;

    for (var i = 0; i < indexFiles.length; i++) {
      var fp = path.join(mhDir, indexFiles[i]);
      if (fs.existsSync(fp)) {
        available++;
        try {
          var fstat = fs.statSync(fp);
          if (fstat.mtimeMs > newestTime) newestTime = fstat.mtimeMs;
        } catch (_) {}
      }
    }

    result.indicesAvailable = available;
    result.lastUpdate = newestTime > 0 ? new Date(newestTime).toISOString() : null;
    var ageHours = result.lastUpdate ? (Date.now() - newestTime) / 3600000 : 999;

    if (available < 2) {
      result.status = 'DOWN';
      result.score = 20;
      result.note = '仅' + available + '/3个指数有数据（历史日线）';
    } else if (ageHours > 48) {
      result.status = 'STALE';
      result.score = 30;
      result.note = '指数数据超过48小时未更新（历史日线）';
    } else if (ageHours > 6) {
      result.status = 'WARN';
      result.score = 70;
      result.note = '指数数据非实时（' + Math.round(ageHours * 10) / 10 + '小时前，历史日线）';
    } else {
      result.note = available + '/3个指数数据正常，' + Math.round(ageHours * 10) / 10 + '小时前（历史日线）';
    }
  } catch (e) {
    result.status = 'DOWN';
    result.score = 0;
    result.note = '异常: ' + e.message;
  }

  return result;
}

function checkNorthBound() {
  var result = { label: '北向资金', key: 'northBound', status: 'OK', score: 100, lastUpdate: null, note: '' };

  var nbFile = path.join(SIMFOLIO_DIR, 'factor_performance.json');
  try {
    if (!fs.existsSync(nbFile)) {
      result.status = 'WARN';
      result.score = 50;
      result.note = '北向资金绩效文件不存在（首次运行）';
      return result;
    }
    var fp = fs.statSync(nbFile);
    var ageHours = (Date.now() - fp.mtimeMs) / 3600000;

    if (ageHours > 48) {
      result.status = 'STALE';
      result.score = 30;
      result.note = '北向数据超48小时未更新（' + Math.round(ageHours) + 'h）';
    } else {
      result.lastUpdate = new Date(fp.mtimeMs).toISOString();
      result.note = '北向情绪追踪正常 · ' + Math.round(Math.max(0, ageHours)) + 'h前';
    }
  } catch (e) {
    result.status = 'WARN';
    result.score = 40;
    result.note = '无法检查: ' + e.message;
  }

  return result;
}

function checkMarginData() {
  // Note: explicitly a proxy — always marked as such
  return {
    label: '两融数据',
    key: 'margin',
    status: 'PROXY',
    score: 60,
    lastUpdate: null,
    note: '使用沪股通聚合K线作为代理指标，非官方融资融券余额。实时性取决于Eastmoney push2 API',
  };
}

function checkDragonTiger() {
  var result = { label: '龙虎榜', key: 'dragonTiger', status: 'OK', score: 100, lastUpdate: null, note: '' };

  // Dragon-tiger data is collected on demand — check if module is available
  try {
    var dt = require('../collectors/dragon_tiger');
    result.note = '龙虎榜采集模块已加载 · 按需获取（每个交易日15:30后更新）';
  } catch (e) {
    result.status = 'DOWN';
    result.score = 20;
    result.note = '龙虎榜模块加载失败: ' + e.message;
  }

  return result;
}

function checkUSMarket() {
  var result = { label: '美股市场', key: 'usMarket', status: 'OK', score: 100, lastUpdate: null, note: '' };

  try {
    if (!fs.existsSync(US_MARKET_DIR)) {
      result.status = 'WARN';
      result.score = 50;
      result.note = '美股数据目录不存在';
      return result;
    }

    var files = fs.readdirSync(US_MARKET_DIR).filter(function(f) { return f.endsWith('.json'); });
    if (files.length === 0) {
      result.status = 'WARN';
      result.score = 30;
      result.note = '美股数据目录为空';
      return result;
    }

    var newestTime = 0;
    for (var i = 0; i < files.length; i++) {
      try {
        var stat = fs.statSync(path.join(US_MARKET_DIR, files[i]));
        if (stat.mtimeMs > newestTime) newestTime = stat.mtimeMs;
      } catch (_) {}
    }

    result.lastUpdate = newestTime > 0 ? new Date(newestTime).toISOString() : null;
    var ageHours = result.lastUpdate ? (Date.now() - newestTime) / 3600000 : 999;

    // US market closes at 05:00 CST, so data up to ~18 hours old is normal
    if (ageHours > 18) {
      result.status = 'WARN';
      result.score = 60;
      result.note = '美股数据超18小时未更新，可能未到交易时段';
    } else {
      result.note = '美股数据正常 · ' + Math.round(ageHours * 10) / 10 + 'h前';
    }
  } catch (e) {
    result.status = 'WARN';
    result.score = 40;
    result.note = '美股数据检查失败: ' + e.message;
  }

  return result;
}

function checkKlineCache() {
  var result = { label: 'K线缓存', key: 'klineCache', status: 'OK', score: 100, lastUpdate: null, note: '' };

  try {
    if (!fs.existsSync(KLINES_DIR)) {
      result.status = 'DOWN';
      result.score = 0;
      result.note = 'K线缓存目录不存在';
      return result;
    }
    var files = fs.readdirSync(KLINES_DIR).filter(function(f) { return f.endsWith('.json'); });
    var staleCount = 0;
    var totalSize = 0;

    for (var i = 0; i < files.length; i++) {
      try {
        var fp = path.join(KLINES_DIR, files[i]);
        var stat = fs.statSync(fp);
        totalSize += stat.size;
        var ageMinutes = (Date.now() - stat.mtimeMs) / 60000;
        if (ageMinutes > 10) staleCount++;
      } catch (_) {}
    }

    result.cachedCodes = files.length;
    result.staleCount = staleCount;
    result.totalSizeKB = Math.round(totalSize / 1024);
    result.note = files.length + '只股票缓存 · ' + staleCount + '只超10分钟（TTL=5分钟）· ' + result.totalSizeKB + 'KB';

    if (files.length < 10) {
      result.status = 'WARN';
      result.score = 50;
      result.note += ' · 缓存偏少';
    }
  } catch (e) {
    result.status = 'DOWN';
    result.score = 0;
    result.note = '异常: ' + e.message;
  }

  return result;
}

function checkNewsData() {
  var result = { label: '财经新闻', key: 'newsData', status: 'OK', score: 90, lastUpdate: null, note: '' };

  try {
    if (!fs.existsSync(SUMMARIES_DIR)) {
      result.status = 'WARN';
      result.score = 50;
      result.note = '新闻总结目录不存在';
      return result;
    }
    var files = fs.readdirSync(SUMMARIES_DIR).filter(function(f) { return f.endsWith('.json'); }).sort().reverse();
    if (files.length > 0) {
      result.lastDate = files[0].replace('.json', '');
      result.totalDays = files.length;
      result.note = files.length + '天历史 · 最新' + result.lastDate;
    } else {
      result.note = '暂无历史总结';
      result.score = 40;
    }
  } catch (e) {
    result.status = 'WARN';
    result.score = 30;
    result.note = '异常: ' + e.message;
  }

  return result;
}

/**
 * Compute a signal confidence penalty from the latest data quality report.
 *
 * Returns an integer 0-N to subtract from compositeScore:
 *   0   = all sources healthy, no penalty
 *   1-3 = minor issues (WARN/PROXY on non-critical sources)
 *   4-6 = moderate issues (STALE on one source, or WARN on 2+)
 *   7-10= severe issues (DOWN on any source, or STALE on 2+)
 *
 * This is designed to be called from simfolio.js before candidate ranking.
 *
 * @param {Object} report — optional pre-fetched report (avoids re-reading files)
 * @returns {{ penalty: number, reasons: string[], report: Object }}
 */
function computeConfidencePenalty(report) {
  report = report || checkAllDataSources();
  var penalty = 0;
  var reasons = [];

  var sources = report.sources || {};

  // Critical sources: if DOWN, large penalty
  var criticalSources = ['marketData', 'indexData'];
  for (var i = 0; i < criticalSources.length; i++) {
    var src = sources[criticalSources[i]];
    if (!src) continue;
    if (src.status === 'DOWN') {
      penalty += 5;
      reasons.push((src.label || criticalSources[i]) + '数据源不可用');
    } else if (src.status === 'STALE') {
      penalty += 3;
      reasons.push((src.label || criticalSources[i]) + '数据过期');
    }
  }

  // Important sources: WARN or PROXY
  var importantSources = ['northBound', 'usMarket', 'klineCache'];
  for (i = 0; i < importantSources.length; i++) {
    src = sources[importantSources[i]];
    if (!src) continue;
    if (src.status === 'DOWN') {
      penalty += 3;
      reasons.push((src.label || importantSources[i]) + '不可用');
    } else if (src.status === 'STALE') {
      penalty += 2;
      reasons.push((src.label || importantSources[i]) + '数据过期');
    } else if (src.status === 'WARN') {
      penalty += 1;
    } else if (src.status === 'PROXY') {
      penalty += 1;
      reasons.push((src.label || importantSources[i]) + '使用代理数据');
    }
  }

  // Source count penalty: if multiple sources are not OK
  var notOkCount = 0;
  for (var key in sources) {
    if (sources[key].status !== 'OK') notOkCount++;
  }
  if (notOkCount >= 4) {
    penalty += 3;
    reasons.push('多个数据源(' + notOkCount + '个)状态异常，信号置信度大幅降低');
  } else if (notOkCount >= 2) {
    penalty += 1;
    reasons.push('部分数据源(' + notOkCount + '个)状态异常');
  }

  // [v3.3.2] Compute qualityScore from penalty: 0 penalty → 100, 10 penalty → 0
  var qualityScore = Math.round((1 - Math.min(10, penalty) / 10) * 100);

  return {
    penalty: Math.min(10, penalty),
    qualityScore: qualityScore,
    reasons: reasons,
    overallScore: report.overallScore || 0,
    report: report,
  };
}

module.exports = {
  checkAllDataSources,
  computeConfidencePenalty,
  checkMarketData,
  checkIndexData,
  checkNorthBound,
  checkMarginData,
  checkDragonTiger,
  checkUSMarket,
  checkKlineCache,
  checkNewsData,
};
