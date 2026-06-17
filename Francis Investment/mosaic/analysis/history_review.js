/**
 * history_review.js — 统一历史复盘引擎
 *
 * 替代 weekend_analyzer.js，整合全部历史数据分析能力。
 * 24/7 运行：工作日 daily light + 周末 deep run + 持续规律发现。
 *
 * 导出:
 *   runDaily()              — 工作日 16:30，~5-10秒
 *   runWeekendDeep()        — 周六 10:30，~90秒
 *   runWeekendDiscovery()   — 周日 09:00，~60秒
 *   runWeekendTick(angle)   — 周末持续，~10-15秒/tick，8个角度轮转
 *   getStatus()             — 完整状态
 *   getReport(mode)         — daily | deep | full
 *   getPatterns()           — 因子组合+板块模式
 *   getVerification()       — 最新验证
 *   setSSEBroadcast(fn)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const CONFIG = require('../config');

const DATA_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data');
const HISTORY_DIR = path.join(DATA_DIR, 'market_history', 'indices');
const SIMFOLIO_DIR = path.join(DATA_DIR, 'simfolio');
const ARCHIVE_DIR = path.join(DATA_DIR, 'weekend_archive');
const HR = CONFIG.HISTORY_REVIEW || {};

// ==================== State ====================

var _state = {
  running: false,
  phase: 'idle',
  progress: 0,
  lastDaily: null,
  lastDeep: null,
  lastDiscovery: null,

  // Daily results
  dailyInsights: null,
  dailyPatterns: null,

  // Deep results
  similarityResults: [],
  crisisScore: null,
  crisisWarning: null,
  sectorRotation: null,
  factorPerformance: null,
  marketProfile: null,
  insights: [],

  // Weekend discovery
  tickHistory: [],
  discoveries: [],
  tickAngleIndex: 0,
  weekendTimerId: null,
  discoveryTimerId: null,

  error: null,
};

// Restore state from persisted history_context.json (survive server restarts)
(function _restoreState() {
  try {
    var ctxPath = path.join(SIMFOLIO_DIR, 'history_context.json');
    if (fs.existsSync(ctxPath)) {
      var ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf8'));
      if (ctx.deepAnalysis) {
        var da = ctx.deepAnalysis;
        _state.lastDeep = da.lastRun || null;
        _state.similarityResults = da.similarity || [];
        _state.crisisWarning = da.crisisWarning || null;
        _state.sectorRotation = da.sectorRotation || null;
        _state.factorPerformance = da.factorPerformance || null;
        _state.insights = da.insights || [];
      }
      if (ctx.dailyInsights) {
        _state.dailyInsights = ctx.dailyInsights;
      }
      if (ctx.discoveries) {
        _state.discoveries = ctx.discoveries;
      }
      if (ctx.verificationContext) {
        _state.lastVerification = ctx.verificationContext;
      }
      if (ctx.marketProfile) {
        _state.marketProfile = ctx.marketProfile;
      }
      console.log('[HistoryReview] Restored state from history_context.json (lastDeep=' + _state.lastDeep + ')');
    }
  } catch (e) {
    console.error('[HistoryReview] Failed to restore state:', e.message);
  }
})();

// ==================== Public API ====================

function runDaily(options) {
  var opts = options || {};
  if (_state.running && _state.phase === 'daily') {
    console.log('[HistoryReview] Daily already running, skip');
    return;
  }
  _state.running = true;
  _state.phase = 'daily';
  _state.progress = 0;
  _state.error = null;

  console.log('[HistoryReview] Starting daily light run...');
  _runDailyCycle(opts)
    .then(function() {
      _state.phase = 'idle';
      _state.running = false;
      _state.lastDaily = new Date().toISOString();
      _state.progress = 100;
      _logSSE({ type: 'history_daily_complete', dailyInsights: _state.dailyInsights ? true : false });
      console.log('[HistoryReview] Daily light complete');
    })
    .catch(function(e) {
      _state.phase = 'idle';
      _state.running = false;
      _state.error = e.message;
      _logSSE({ type: 'history_error', error: e.message });
      console.error('[HistoryReview] Daily error:', e.message);
    });
}

function runWeekendDeep(options) {
  var opts = options || {};
  if (_state.running && _state.phase === 'deep') {
    console.log('[HistoryReview] Deep already running, skip');
    return;
  }
  _state.running = true;
  _state.phase = 'deep';
  _state.progress = 0;
  _state.error = null;

  console.log('[HistoryReview] Starting weekend deep run...');
  _logSSE({ type: 'history_deep_start' });

  _runDeepCycle(opts)
    .then(function() {
      _state.phase = 'idle';
      _state.running = false;
      _state.lastDeep = new Date().toISOString();
      _state.progress = 100;
      _archiveReport();
      _logSSE({ type: 'history_deep_complete', insights: _state.insights.length, crisisScore: _state.crisisScore });
      console.log('[HistoryReview] Weekend deep complete. Starting tick scheduler.');
      _startWeekendTicks();
    })
    .catch(function(e) {
      _state.phase = 'idle';
      _state.running = false;
      _state.error = e.message;
      _logSSE({ type: 'history_error', error: e.message });
      console.error('[HistoryReview] Deep error:', e.message);
    });
}

function runWeekendDiscovery(options) {
  var opts = options || {};
  _state.phase = 'discovery';
  _state.progress = 0;
  console.log('[HistoryReview] Starting weekend discovery run...');
  _logSSE({ type: 'history_discovery_start' });

  // Use different params: larger windows, more horizons
  var discOpts = {
    similarityWindow: opts.similarityWindow || 30,
    similarityTopN: opts.similarityTopN || 8,
    similarityStride: opts.similarityStride || 3,
    horizons: [5, 10, 20, 30],
    skipHistoryPull: true,
  };

  return _runDeepCycle(discOpts)
    .then(function() {
      _state.phase = 'idle';
      _state.lastDiscovery = new Date().toISOString();
      _state.progress = 100;
      _logSSE({ type: 'history_discovery_complete', discoveries: _state.discoveries.length });
      console.log('[HistoryReview] Weekend discovery complete');
    })
    .catch(function(e) {
      _state.phase = 'idle';
      _state.error = e.message;
      console.error('[HistoryReview] Discovery error:', e.message);
    });
}

function runWeekendTick(angle) {
  if (_state.running && _state.phase === 'tick') return;
  _state.running = true;
  _state.phase = 'tick';
  _state.progress = 0;

  var tickAngle = angle || _getNextTickAngle();
  console.log('[HistoryReview] Running weekend tick: ' + tickAngle);
  _logSSE({ type: 'history_tick_start', angle: tickAngle });

  _runTickCycle(tickAngle)
    .then(function(result) {
      _state.phase = 'idle';
      _state.running = false;
      _state.tickHistory.push({ angle: tickAngle, time: new Date().toISOString(), result: result });
      if (result && result.discovery) {
        _state.discoveries.push(result.discovery);
        _logSSE({ type: 'history_discovery_new', discovery: result.discovery });
      }
      console.log('[HistoryReview] Tick complete: ' + tickAngle);
    })
    .catch(function(e) {
      _state.phase = 'idle';
      _state.running = false;
      _state.tickHistory.push({ angle: tickAngle, time: new Date().toISOString(), error: e.message });
      console.error('[HistoryReview] Tick error:', e.message);
    });
}

function stopWeekendTicks() {
  if (_state.weekendTimerId) { clearInterval(_state.weekendTimerId); _state.weekendTimerId = null; }
  if (_state.discoveryTimerId) { clearTimeout(_state.discoveryTimerId); _state.discoveryTimerId = null; }
}

function getStatus() {
  return {
    phase: _state.phase,
    progress: _state.progress,
    lastDaily: _state.lastDaily,
    lastDeep: _state.lastDeep,
    lastDiscovery: _state.lastDiscovery,
    running: _state.running,
    tickHistory: _state.tickHistory.slice(),
    discoveries: _state.discoveries.slice(),
    discoveryCount: _state.discoveries.length,
    nextTickAngle: _getNextTickAngle(),
  };
}

function getReport(mode) {
  if (mode === 'daily') {
    return {
      ok: true,
      mode: 'daily',
      generatedAt: new Date().toISOString(),
      lastRun: _state.lastDaily,
      dailyInsights: _state.dailyInsights,
      patterns: _state.dailyPatterns,
    };
  }
  if (mode === 'deep') {
    return {
      ok: true,
      mode: 'deep',
      generatedAt: new Date().toISOString(),
      lastRun: _state.lastDeep,
      similarity: _state.similarityResults,
      crisisWarning: _state.crisisWarning,
      sectorRotation: _state.sectorRotation,
      factorPerformance: _state.factorPerformance,
      insights: _state.insights,
      marketProfile: _state.marketProfile,
    };
  }
  // full mode
  return {
    ok: true,
    mode: 'full',
    generatedAt: new Date().toISOString(),
    lastDaily: _state.lastDaily,
    lastDeep: _state.lastDeep,
    lastDiscovery: _state.lastDiscovery,
    dailyInsights: _state.dailyInsights,
    similarity: _state.similarityResults,
    crisisWarning: _state.crisisWarning,
    sectorRotation: _state.sectorRotation,
    factorPerformance: _state.factorPerformance,
    insights: _state.insights,
    marketProfile: _state.marketProfile,
    discoveries: _state.discoveries,
    tickHistory: _state.tickHistory,
    deepAnalysis: _computeDeepAnalysis(),
  };
}

/**
 * v3.2: Compute deep analysis synthesis — cross-sectional stats from similar periods,
 * factor effectiveness trends, crisis interpretation, cross-market signals.
 */
function _computeDeepAnalysis() {
  var analysis = {
    generatedAt: new Date().toISOString(),
    lastDeepRun: _state.lastDeep,
  };

  // 1. Similar period forward return statistics
  if (_state.similarityResults && _state.similarityResults.length > 0) {
    var sims = _state.similarityResults;

    // Gather all forward return data points
    var fwd5dReturns = [];
    var fwd10dReturns = [];
    var fwd20dReturns = [];
    for (var si = 0; si < sims.length; si++) {
      var s = sims[si];
      if (s.future5d && s.future5d.total != null) fwd5dReturns.push({ val: s.future5d.total, sim: s.similarity });
      if (s.future10d && s.future10d.total != null) fwd10dReturns.push({ val: s.future10d.total, sim: s.similarity });
      if (s.future20d && s.future20d.total != null) fwd20dReturns.push({ val: s.future20d.total, sim: s.similarity });
    }

    if (fwd5dReturns.length > 0) {
      fwd5dReturns.sort(function(a, b) { return a.val - b.val; });
      var raw5d = fwd5dReturns.map(function(r) { return r.val; });
      analysis.similarityStats = {
        count: raw5d.length,
        winRate: +(raw5d.filter(function(r) { return r > 0; }).length / raw5d.length * 100).toFixed(1),
        avgReturn: +(raw5d.reduce(function(s, r) { return s + r; }, 0) / raw5d.length).toFixed(2),
        medianReturn: +raw5d[Math.floor(raw5d.length / 2)].toFixed(2),
        maxReturn: +raw5d[raw5d.length - 1].toFixed(2),
        minReturn: +raw5d[0].toFixed(2),
        riskReward: _computeRiskReward(raw5d),
        percentiles: {
          p10: +raw5d[Math.floor(raw5d.length * 0.1)].toFixed(2),
          p25: +raw5d[Math.floor(raw5d.length * 0.25)].toFixed(2),
          p75: +raw5d[Math.floor(raw5d.length * 0.75)].toFixed(2),
          p90: +raw5d[Math.floor(raw5d.length * 0.9)].toFixed(2),
        },
        topMatch: fwd5dReturns.length > 0 ? {
          similarity: +(fwd5dReturns[fwd5dReturns.length - 1].sim * 100).toFixed(1),
          fwdReturn: +fwd5dReturns[fwd5dReturns.length - 1].val.toFixed(2),
        } : null,
      };
    }

    if (fwd10dReturns.length > 0) {
      fwd10dReturns.sort(function(a, b) { return a.val - b.val; });
      var raw10d = fwd10dReturns.map(function(r) { return r.val; });
      analysis.fwd10dStats = {
        count: raw10d.length,
        winRate: +(raw10d.filter(function(r) { return r > 0; }).length / raw10d.length * 100).toFixed(1),
        avgReturn: +(raw10d.reduce(function(s, r) { return s + r; }, 0) / raw10d.length).toFixed(2),
        riskReward: _computeRiskReward(raw10d),
      };
    }

    if (fwd20dReturns.length > 0) {
      fwd20dReturns.sort(function(a, b) { return a.val - b.val; });
      var raw20d = fwd20dReturns.map(function(r) { return r.val; });
      analysis.fwd20dStats = {
        count: raw20d.length,
        winRate: +(raw20d.filter(function(r) { return r > 0; }).length / raw20d.length * 100).toFixed(1),
        avgReturn: +(raw20d.reduce(function(s, r) { return s + r; }, 0) / raw20d.length).toFixed(2),
        riskReward: _computeRiskReward(raw20d),
      };
    }
  }

  // 2. Crisis interpretation
  if (_state.crisisWarning) {
    var cw = _state.crisisWarning;
    analysis.crisisInterpretation = {
      score: cw.score,
      level: cw.level,
      label: cw.label,
      recommendation: (cw.score >= 70) ? '防御优先：建议减仓至30%以下，只保留最强信号' :
                     (cw.score >= 50) ? '谨慎操作：降低单笔仓位，提高买入阈值' :
                     (cw.score >= 30) ? '中性偏谨慎：注意止损纪律' : '正常交易环境',
    };
  }

  // 3. Factor health summary
  if (_state.factorPerformance && _state.factorPerformance.length > 0) {
    var hotFactors = _state.factorPerformance.filter(function(f) { return f.status === 'hot'; });
    var coldFactors = _state.factorPerformance.filter(function(f) { return f.status === 'cold'; });
    analysis.factorHealth = {
      hotCount: hotFactors.length,
      coldCount: coldFactors.length,
      hotNames: hotFactors.map(function(f) { return f.name; }),
      coldNames: coldFactors.map(function(f) { return f.name; }),
    };
  }

  return analysis;
}

function _computeRiskReward(sortedReturns) {
  var gains = sortedReturns.filter(function(r) { return r > 0; });
  var losses = sortedReturns.filter(function(r) { return r < 0; });
  var avgGain = gains.length > 0 ? gains.reduce(function(s, r) { return s + r; }, 0) / gains.length : 0;
  var avgLoss = losses.length > 0 ? Math.abs(losses.reduce(function(s, r) { return s + r; }, 0) / losses.length) : 1;
  return avgLoss > 0 ? +(avgGain / avgLoss).toFixed(2) : (avgGain > 0 ? 99 : 0);
}

function getDeepAnalysis() {
  return { ok: true, ..._computeDeepAnalysis() };
}

function getPatterns() {
  var verifier = require('./history_verifier'); // unused here, use internal
  // Read factor combinations from factor mining output
  var combosPath = path.join(SIMFOLIO_DIR, 'factor_combinations.json');
  var factorCombos = null;
  var sectorFactorEffects = null;
  try {
    if (fs.existsSync(combosPath)) {
      var fc = JSON.parse(fs.readFileSync(combosPath, 'utf8'));
      factorCombos = fc.combinations || fc.combos || null;
      sectorFactorEffects = fc.sectorEffects || null;
    }
  } catch (e) {}

  return {
    ok: true,
    factorCombos: factorCombos || _state.dailyPatterns || [],
    sectorFactorEffects: sectorFactorEffects || [],
    discoveries: _state.discoveries,
  };
}

function getVerification() {
  var verifier = require('./history_verifier');
  return verifier.getVerificationHistory();
}

function setSSEBroadcast(fn) {
  _broadcastFn = fn;
}

var _broadcastFn = null;
function _logSSE(data) {
  if (typeof _broadcastFn === 'function') {
    try { _broadcastFn(data); } catch (e) {}
  }
}

// ==================== Daily Light Cycle ====================

async function _runDailyCycle(opts) {
  _state.progress = 5;

  // D1: Aggregate
  _state.progress = 10;
  var aggregated = _aggregateDailyData();

  // D2: Verify factors
  _state.progress = 30;
  var verifier = require('./history_verifier');
  var today = _todayStr();
  var factorVerification = null;
  try {
    factorVerification = verifier.verifyFactors(today);
  } catch (e) {
    console.error('[HistoryReview] Factor verification failed:', e.message);
  }

  // D3: Incremental pattern update
  _state.progress = 50;
  try {
    var wfm = require('../evolution/weekend_factor_mining');
    wfm.runDailyUpdate();
  } catch (e) {
    console.error('[HistoryReview] Daily pattern update failed:', e.message);
  }

  // D4: Quick similarity (1 year, stride 10, top 3)
  _state.progress = 65;
  var quickSim = [];
  try {
    var histData = _loadHistoricalData();
    if (histData && histData['sh000001'] && histData['sh000001'].length >= 60) {
      quickSim = _computeSimilarity(aggregated, histData, {
        window: 20,
        topN: 3,
        stride: 10,
        lookbackDays: 250,
      });
    }
  } catch (e) {
    console.error('[HistoryReview] Quick similarity failed:', e.message);
  }

  // D5: Write context
  _state.progress = 85;
  _state.dailyInsights = {
    generatedAt: new Date().toISOString(),
    date: today,
    factorVerification: factorVerification,
    quickSimilarity: quickSim,
    marketState: aggregated.marketState,
  };
  _writeHistoryContext();

  // D6: Done
  _state.progress = 100;
}

// ==================== Weekend Deep Cycle ====================

async function _runDeepCycle(opts) {
  var o = opts || {};
  _state.progress = 5;

  // W1: Full aggregation
  _state.progress = 10;
  var aggregated = _aggregateAllData();

  // W2: K-line pull (skip if already fresh)
  if (!o.skipHistoryPull) {
    _state.progress = 30;
    await _pullHistoricalData();
  }

  // Load K-line data
  _state.progress = 45;
  var histData = _loadHistoricalData();

  // W3a: Similarity
  _state.progress = 55;
  _state.similarityResults = _computeSimilarity(aggregated, histData, {
    window: o.similarityWindow || HR.deep?.similarity?.window || 20,
    topN: o.similarityTopN || HR.deep?.similarity?.topN || 10,
    stride: o.similarityStride || HR.deep?.similarity?.stride || 5,
    lookbackDays: (HR.deep?.similarity?.lookbackYears || 5) * 250,
  });

  // W3b: Crisis warning
  _state.progress = 65;
  _state.crisisWarning = _computeCrisisWarning(aggregated, histData);

  // W3c: Sector rotation
  _state.progress = 75;
  _state.sectorRotation = _analyzeSectorRotation(aggregated);

  // W3d: Factor effectiveness
  _state.progress = 85;
  _state.factorPerformance = _analyzeFactorEffectiveness(aggregated);
  _state.marketProfile = _buildMarketProfile(aggregated);

  // W4: Weekly verification
  _state.progress = 90;
  var verifier = require('./history_verifier');
  var verificationContext = null;
  try {
    var lastWeekend = _getLastWeekend();
    if (lastWeekend) {
      var vResult = verifier.verifyWeekly(lastWeekend);
      if (vResult.ok) {
        verificationContext = {
          lastWeekend: lastWeekend,
          overallGrade: vResult.overallGrade,
          overallScore: vResult.overallScore,
          adjustments: _extractHighlights(vResult),
        };
      }
    }
  } catch (e) {
    console.error('[HistoryReview] Weekly verification failed:', e.message);
  }

  // W5: Load fresh factor mining results
  _state.progress = 93;
  _loadFactorMining();

  // W6: Generate insights + write context
  _state.progress = 96;
  _state.lastDeep = _state.lastDeep || new Date().toISOString();
  _state.insights = _generateInsights(verificationContext);
  _writeHistoryContext(verificationContext);

  _state.progress = 100;
}

// ==================== Weekend Tick Cycle ====================

var TICK_ANGLES = [
  'multi_window_similarity',
  'sector_similarity',
  'volume_patterns',
  'extreme_market_scenarios',
  'cross_market_linkage',
  'policy_cycle_match',
  'factor_decay_curves',
  'covariance_structure',
];

function _getNextTickAngle() {
  var idx = _state.tickAngleIndex % TICK_ANGLES.length;
  _state.tickAngleIndex++;
  return TICK_ANGLES[idx];
}

async function _runTickCycle(angle) {
  var histData = _loadHistoricalData();
  if (!histData || !histData['sh000001']) {
    return { angle: angle, result: 'no_data' };
  }

  var discovery = null;

  switch (angle) {
    case 'multi_window_similarity':
      var windows = [10, 30, 40, 60];
      var usedW = windows[_state.tickHistory.length % windows.length];
      var simRes = _computeSimilarity(null, histData, { window: usedW, topN: 5, stride: 10, lookbackDays: 1250 });
      if (simRes.length > 0) {
        discovery = {
          angle: angle,
          title: '多窗口相似度对比 (window=' + usedW + ')',
          detail: '与当前市场最相似的历史时期(窗口=' + usedW + '天)，top5平均后续5日收益: ' +
            (simRes.reduce(function(s, m) { return s + (m.future5d ? m.future5d.total : 0); }, 0) / simRes.length).toFixed(2) + '%',
          data: simRes.slice(0, 3),
          time: new Date().toISOString(),
        };
      }
      break;

    case 'volume_patterns':
      var volWindows = _scanVolumePatterns(histData);
      if (volWindows.length > 0) {
        discovery = {
          angle: angle,
          title: '成交量模式发现',
          detail: '发现 ' + volWindows.length + ' 个与当前量能结构相似的历史时期',
          data: volWindows.slice(0, 5),
          time: new Date().toISOString(),
        };
      }
      break;

    case 'extreme_market_scenarios':
      var extremeScenarios = _scanExtremeScenarios(histData);
      discovery = {
        angle: angle,
        title: '极端行情规律',
        detail: '历史上大跌后的反弹概率: ' + (extremeScenarios.dropReboundRate * 100).toFixed(0) +
          '%, 大涨后的延续概率: ' + (extremeScenarios.rallyContinueRate * 100).toFixed(0) + '%',
        data: extremeScenarios,
        time: new Date().toISOString(),
      };
      break;

    case 'factor_decay_curves':
      var curves = _computeFactorDecayCurves();
      if (curves) {
        discovery = {
          angle: angle,
          title: '因子衰减曲线分析',
          detail: 'H1-H9 触发后 T+1~T+20 全收益率曲线已更新',
          data: curves,
          time: new Date().toISOString(),
        };
      }
      break;

    case 'cross_market_linkage':
      var linkage = _analyzeCrossMarketLinkage(histData);
      if (linkage) {
        discovery = {
          angle: angle,
          title: '跨市场联动分析',
          detail: '美股+上证联合特征→历史类似结构后续A股表现',
          data: linkage,
          time: new Date().toISOString(),
        };
      }
      break;

    case 'policy_cycle_match':
      discovery = {
        angle: angle,
        title: '政策周期匹配',
        detail: '从事件日志中提取政策关键词，匹配历史政策环境',
        data: { note: '需要积累更多事件数据' },
        time: new Date().toISOString(),
      };
      break;

    case 'covariance_structure':
      var covar = _analyzeCovarianceStructure();
      if (covar) {
        discovery = {
          angle: angle,
          title: '协方差结构分析',
          detail: '8板块收益协方差矩阵→预测波动率结构',
          data: covar,
          time: new Date().toISOString(),
        };
      }
      break;

    case 'sector_similarity':
      var secSim = _computeSectorSimilarity(histData);
      if (secSim && secSim.length > 0) {
        discovery = {
          angle: angle,
          title: '分行业相似度',
          detail: '各板块指数分别做历史相似度匹配',
          data: secSim,
          time: new Date().toISOString(),
        };
      }
      break;

    default:
      break;
  }

  return { angle: angle, discovery: discovery };
}

// ==================== Data Aggregation ====================

function _aggregateDailyData() {
  var aggregated = {};
  // Read today's summary
  var today = _todayStr();
  var summaryPath = path.join(DATA_DIR, 'summaries', today + '.json');
  if (fs.existsSync(summaryPath)) {
    try { aggregated.summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')); } catch (e) {}
  }

  // Read last pipeline result
  var lpPath = path.join(SIMFOLIO_DIR, 'last_pipeline_result.json');
  if (fs.existsSync(lpPath)) {
    try { aggregated.lastPipeline = JSON.parse(fs.readFileSync(lpPath, 'utf8')); } catch (e) {}
  }

  // Read factor performance
  var fpPath = path.join(SIMFOLIO_DIR, 'factor_performance.json');
  if (fs.existsSync(fpPath)) {
    try { aggregated.factorPerf = JSON.parse(fs.readFileSync(fpPath, 'utf8')); } catch (e) {}
  }

  // Read correlation for market state
  var corrPath = path.join(DATA_DIR, 'us_market', 'correlation_history.json');
  if (fs.existsSync(corrPath)) {
    try { aggregated.correlations = JSON.parse(fs.readFileSync(corrPath, 'utf8')); } catch (e) {}
  }

  // Simple market state
  aggregated.marketState = { date: today };
  try {
    if (aggregated.correlations && aggregated.correlations.days && aggregated.correlations.days.length > 0) {
      var lastDay = aggregated.correlations.days[aggregated.correlations.days.length - 1];
      aggregated.marketState.nbSentiment = lastDay.nbSentiment || 'neutral';
    }
  } catch (e) {}

  return aggregated;
}

function _aggregateAllData() {
  var aggregated = {};

  // All summaries
  var sumDir = path.join(DATA_DIR, 'summaries');
  aggregated.summaries = [];
  if (fs.existsSync(sumDir)) {
    var files = fs.readdirSync(sumDir).filter(function(f) { return f.endsWith('.json'); }).sort();
    for (var i = 0; i < files.length; i++) {
      try {
        aggregated.summaries.push(JSON.parse(fs.readFileSync(path.join(sumDir, files[i]), 'utf8')));
      } catch (e) {}
    }
  }

  // All events
  var evtDir = path.join(DATA_DIR, 'events');
  aggregated.events = [];
  if (fs.existsSync(evtDir)) {
    var evtFiles = fs.readdirSync(evtDir).filter(function(f) { return f.endsWith('.json'); }).sort();
    for (var j = 0; j < evtFiles.length; j++) {
      try {
        var content = JSON.parse(fs.readFileSync(path.join(evtDir, evtFiles[j]), 'utf8'));
        if (Array.isArray(content)) aggregated.events = aggregated.events.concat(content);
        else if (content.data && Array.isArray(content.data)) aggregated.events = aggregated.events.concat(content.data);
      } catch (e) {}
    }
  }

  // Knowledge base
  var kbDir = path.join(DATA_DIR, 'knowledge_base');
  aggregated.knowledge = [];
  if (fs.existsSync(kbDir)) {
    var kbFiles = fs.readdirSync(kbDir).filter(function(f) { return f.endsWith('.json') && f !== 'index.json' && f !== 'factor_tracker.json'; });
    for (var k = 0; k < kbFiles.length; k++) {
      try {
        aggregated.knowledge.push(JSON.parse(fs.readFileSync(path.join(kbDir, kbFiles[k]), 'utf8')));
      } catch (e) {}
    }
  }

  // Portfolio
  var pfPath = path.join(SIMFOLIO_DIR, 'portfolio.json');
  if (fs.existsSync(pfPath)) {
    try { aggregated.portfolio = JSON.parse(fs.readFileSync(pfPath, 'utf8')); } catch (e) {}
  }

  // Correlations
  var corrPath = path.join(DATA_DIR, 'us_market', 'correlation_history.json');
  if (fs.existsSync(corrPath)) {
    try { aggregated.correlations = JSON.parse(fs.readFileSync(corrPath, 'utf8')); } catch (e) {}
  }

  // Factor performance
  var fpPath = path.join(SIMFOLIO_DIR, 'factor_performance.json');
  if (fs.existsSync(fpPath)) {
    try { aggregated.factorPerf = JSON.parse(fs.readFileSync(fpPath, 'utf8')); } catch (e) {}
  }

  // Last pipeline
  var lpPath = path.join(SIMFOLIO_DIR, 'last_pipeline_result.json');
  if (fs.existsSync(lpPath)) {
    try { aggregated.lastPipeline = JSON.parse(fs.readFileSync(lpPath, 'utf8')); } catch (e) {}
  }

  return aggregated;
}

// ==================== K-line Data ====================

function _loadHistoricalData() {
  var result = {};
  var indices = [
    { key: 'sh000001', file: 'sh000001.json', code: '1.000001' },
    { key: 'sz399001', file: 'sz399001.json', code: '0.399001' },
    { key: 'sz399006', file: 'sz399006.json', code: '0.399006' },
  ];

  for (var i = 0; i < indices.length; i++) {
    var idx = indices[i];
    var fPath = path.join(HISTORY_DIR, idx.file);
    if (fs.existsSync(fPath)) {
      try {
        var data = JSON.parse(fs.readFileSync(fPath, 'utf8'));
        if (Array.isArray(data) && data.length > 0) {
          result[idx.key] = data;
        }
      } catch (e) {}
    }
  }
  return result;
}

async function _pullHistoricalData() {
  _ensureDir(HISTORY_DIR);
  var indices = [
    { key: 'sh000001', file: 'sh000001.json', code: '1.000001' },
    { key: 'sz399001', file: 'sz399001.json', code: '0.399001' },
    { key: 'sz399006', file: 'sz399006.json', code: '0.399006' },
  ];

  for (var i = 0; i < indices.length; i++) {
    await _pullOneIndex(indices[i]);
  }
}

function _pullOneIndex(index) {
  return new Promise(function(resolve) {
    var url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?' +
      'secid=' + index.code + '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61' +
      '&klt=101&fqt=1&end=20500101&lmt=2000';

    https.get(url, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        try {
          var body = Buffer.concat(chunks).toString('utf8');
          var json = JSON.parse(body);
          if (json && json.data && json.data.klines) {
            var records = json.data.klines.map(function(line) {
              var parts = line.split(',');
              return {
                date: parts[0],
                open: parseFloat(parts[1]),
                close: parseFloat(parts[2]),
                high: parseFloat(parts[3]),
                low: parseFloat(parts[4]),
                volume: parseFloat(parts[5]) || parseFloat(parts[6]) || 0,
              };
            }).filter(function(r) { return r.open > 0; });

            // Merge with existing
            var fPath = path.join(HISTORY_DIR, index.file);
            var existing = [];
            if (fs.existsSync(fPath)) {
              try { existing = JSON.parse(fs.readFileSync(fPath, 'utf8')); } catch (e) {}
            }
            var merged = _mergeDedupe(existing, records);
            fs.writeFileSync(fPath, JSON.stringify(merged), 'utf8');
            console.log('[HistoryReview] Pulled ' + index.key + ': ' + records.length + ' new, ' + merged.length + ' total');
          }
        } catch (e) {
          console.error('[HistoryReview] Failed to pull ' + index.key + ':', e.message);
        }
        resolve();
      });
    }).on('error', function(e) {
      console.error('[HistoryReview] HTTP error for ' + index.key + ':', e.message);
      resolve();
    }).setTimeout(15000, function() {
      this.destroy();
      resolve();
    });
  });
}

function _mergeDedupe(existing, incoming) {
  if (!Array.isArray(existing)) existing = [];
  var dateMap = {};
  for (var i = 0; i < existing.length; i++) { dateMap[existing[i].date] = existing[i]; }
  for (var j = 0; j < incoming.length; j++) { dateMap[incoming[j].date] = incoming[j]; }
  var merged = Object.values(dateMap);
  merged.sort(function(a, b) { return a.date.localeCompare(b.date); });
  return merged;
}

// ==================== Similarity Analysis ====================

function _computeSimilarity(aggregated, histData, opts) {
  var o = opts || {};
  var windowSize = o.window || 20;
  var topN = o.topN || 10;
  var stride = o.stride || 5;
  var lookbackDays = o.lookbackDays || 1250;

  var klines = histData['sh000001'];
  if (!klines || klines.length < windowSize + 10) return [];

  // Build current vector
  var current = _buildMarketVector(klines, klines.length - windowSize, klines.length);
  if (!current) return [];

  // Build historical vectors
  var vectors = [];
  var lookbackStart = Math.max(0, klines.length - windowSize - lookbackDays);
  var endLimit = klines.length - windowSize - 5; // skip last 5 to avoid future data

  for (var i = lookbackStart; i < endLimit; i += stride) {
    var vec = _buildMarketVector(klines, i, i + windowSize);
    if (vec) {
      vectors.push({ idx: i, vector: vec, startDate: klines[i].date, endDate: klines[i + windowSize - 1].date });
    }
  }

  if (vectors.length === 0) return [];

  // Normalize all vectors together
  var allVectors = vectors.map(function(v) { return v.vector; }).concat([current]);
  var normalized = _zscoreNormalize(allVectors);
  var normCurrent = normalized[normalized.length - 1];
  var normHistorical = normalized.slice(0, normalized.length - 1);

  // Compute similarities
  var results = [];
  for (var j = 0; j < normHistorical.length; j++) {
    var sim = _cosineSimilarity(normCurrent, normHistorical[j]);
    results.push({
      startDate: vectors[j].startDate,
      endDate: vectors[j].endDate,
      similarity: sim,
      simLabel: sim > 0.85 ? '极高' : sim > 0.65 ? '较高' : sim > 0.45 ? '中等' : '较低',
    });
  }

  // Sort descending
  results.sort(function(a, b) { return b.similarity - a.similarity; });

  // Extract future returns for top N
  var topResults = results.slice(0, topN);
  for (var k = 0; k < topResults.length; k++) {
    var endIdx = -1;
    for (var m = 0; m < klines.length; m++) {
      if (klines[m].date === topResults[k].endDate) { endIdx = m; break; }
    }
    if (endIdx >= 0) {
      topResults[k].future5d = _extractFutureReturns(klines, endIdx + 1, 5);
      topResults[k].future10d = _extractFutureReturns(klines, endIdx + 1, 10);
      topResults[k].future20d = _extractFutureReturns(klines, endIdx + 1, 20);
    }
  }

  return topResults;
}

function _buildMarketVector(data, start, end) {
  if (end - start < 5) return null;
  if (start < 0 || end > data.length) return null;

  var closes = [];
  var volumes = [];
  for (var i = start; i < end; i++) {
    closes.push(data[i].close);
    volumes.push(data[i].volume || 0);
  }

  var totalReturn = (closes[closes.length - 1] - closes[0]) / closes[0];

  // Daily returns for std dev
  var dailyReturns = [];
  for (var j = 1; j < closes.length; j++) {
    dailyReturns.push((closes[j] - closes[j-1]) / closes[j-1]);
  }
  var mean = dailyReturns.reduce(function(s, r) { return s + r; }, 0) / dailyReturns.length;
  var variance = dailyReturns.reduce(function(s, r) { return s + (r - mean) * (r - mean); }, 0) / dailyReturns.length;
  var stdDev = Math.sqrt(variance);

  // 5-day momentum
  var mom5 = closes.length >= 5 ? (closes[closes.length - 1] - closes[closes.length - 5]) / closes[closes.length - 5] : 0;

  // Volume trend
  var halfLen = Math.floor(volumes.length / 2);
  var firstVol = volumes.slice(0, halfLen).reduce(function(s, v) { return s + v; }, 0) / Math.max(1, halfLen);
  var lastVol = volumes.slice(-halfLen).reduce(function(s, v) { return s + v; }, 0) / Math.max(1, halfLen);
  var volTrend = firstVol > 0 ? (lastVol / firstVol - 1) : 0;

  // Up days ratio
  var upDays = dailyReturns.filter(function(r) { return r > 0; }).length / Math.max(1, dailyReturns.length);

  // Max single-day drop
  var maxDrop = Math.min.apply(null, dailyReturns.concat([0]));

  return [totalReturn, stdDev, mom5, volTrend, upDays, maxDrop];
}

function _zscoreNormalize(vectors) {
  var dims = vectors[0].length;
  var means = [], stds = [];

  for (var d = 0; d < dims; d++) {
    var sum = 0;
    for (var i = 0; i < vectors.length; i++) sum += vectors[i][d];
    means[d] = sum / vectors.length;
    var vSum = 0;
    for (var j = 0; j < vectors.length; j++) vSum += (vectors[j][d] - means[d]) * (vectors[j][d] - means[d]);
    stds[d] = Math.sqrt(vSum / vectors.length) || 1;
  }

  return vectors.map(function(vec) {
    return vec.map(function(v, d) {
      var z = (v - means[d]) / stds[d];
      return Math.tanh(z); // squash to [-1, 1]
    });
  });
}

function _cosineSimilarity(a, b) {
  var dot = 0, normA = 0, normB = 0;
  for (var i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function _extractFutureReturns(data, from, days) {
  var actualDays = Math.min(days, data.length - from);
  if (actualDays <= 0) return null;
  var startPrice = data[from].close;
  var cumulative = (data[from + actualDays - 1].close - startPrice) / startPrice * 100;
  var maxUp = 0, maxDown = 0;
  for (var i = from; i < from + actualDays; i++) {
    var r = (data[i].close - startPrice) / startPrice * 100;
    if (r > maxUp) maxUp = r;
    if (r < maxDown) maxDown = r;
  }
  return {
    total: cumulative,
    maxUp: maxUp,
    maxDown: maxDown,
    cumulative: cumulative,
    label: cumulative > 0 ? 'bullish' : 'bearish',
  };
}

// ==================== Crisis Warning ====================

function _computeCrisisWarning(aggregated, histData) {
  var weights = (HR.deep && HR.deep.crisisWeights) || {
    liquidity: 0.25, valuation: 0.20, marketBreadth: 0.20, northBound: 0.15, margin: 0.10, volatility: 0.10,
  };

  var dimensions = [];
  var totalWeight = 0, weightedSum = 0;

  // 1. Liquidity — volume trend
  var liqScore = 50, liqDetail = '';
  var sh = histData['sh000001'];
  if (sh && sh.length >= 10) {
    var recent10 = sh.slice(-10);
    var first5Vol = recent10.slice(0, 5).reduce(function(s, d) { return s + (d.volume || 0); }, 0) / 5;
    var last5Vol = recent10.slice(5).reduce(function(s, d) { return s + (d.volume || 0); }, 0) / 5;
    var volTrend = first5Vol > 0 ? (last5Vol / first5Vol - 1) * 100 : 0;
    if (volTrend < -30) liqScore = 80;
    else if (volTrend < -15) liqScore = 65;
    else if (volTrend < 0) liqScore = 55;
    else if (volTrend > 30) liqScore = 25;
    else if (volTrend > 15) liqScore = 35;
    liqDetail = '量能变化: ' + volTrend.toFixed(1) + '%';
  } else {
    liqDetail = '暂无K线数据';
  }
  dimensions.push({ key: 'liquidity', name: '流动性', score: liqScore, weight: weights.liquidity, detail: liqDetail });
  weightedSum += liqScore * weights.liquidity;
  totalWeight += weights.liquidity;

  // 2. Valuation — from pipeline top scores
  var valScore = 50, valDetail = '';
  if (aggregated.lastPipeline && aggregated.lastPipeline.top5 && aggregated.lastPipeline.top5.length > 0) {
    var top5Scores = aggregated.lastPipeline.top5.map(function(s) { return s.score || s.compositeScore || 0; });
    var avgScore = top5Scores.reduce(function(s, v) { return s + v; }, 0) / top5Scores.length;
    if (avgScore < 55) valScore = 70;
    else if (avgScore < 60) valScore = 60;
    else if (avgScore < 70) valScore = 45;
    else valScore = 30;
    valDetail = 'Top5 平均评分: ' + avgScore.toFixed(1);
  } else {
    valDetail = '暂无 Pipeline 数据';
  }
  dimensions.push({ key: 'valuation', name: '估值', score: valScore, weight: weights.valuation, detail: valDetail });
  weightedSum += valScore * weights.valuation;
  totalWeight += weights.valuation;

  // 3. Market Breadth
  var breadthScore = 50, breadthDetail = '';
  if (aggregated.lastPipeline && aggregated.lastPipeline.scoreDistribution) {
    var dist = aggregated.lastPipeline.scoreDistribution;
    var highRatio = (dist.sCount || 0) / Math.max(1, dist.total || 1);
    if (highRatio > 0.5) breadthScore = 25;
    else if (highRatio > 0.35) breadthScore = 35;
    else if (highRatio > 0.2) breadthScore = 50;
    else if (highRatio > 0.1) breadthScore = 65;
    else breadthScore = 80;
    breadthDetail = '高分率(60+): ' + (highRatio * 100).toFixed(0) + '%';
  } else {
    breadthDetail = '暂无 Pipeline 数据';
  }
  dimensions.push({ key: 'marketBreadth', name: '市场宽度', score: breadthScore, weight: weights.marketBreadth, detail: breadthDetail });
  weightedSum += breadthScore * weights.marketBreadth;
  totalWeight += weights.marketBreadth;

  // 4. North Bound
  var northScore = 50, northDetail = '';
  try {
    if (aggregated.correlations && aggregated.correlations.days && aggregated.correlations.days.length > 0) {
      var lastDay = aggregated.correlations.days[aggregated.correlations.days.length - 1];
      var sentiment = lastDay.nbSentiment || 'neutral';
      if (sentiment === 'bearish') northScore = 75;
      else if (sentiment === 'slightly_bearish') northScore = 60;
      else if (sentiment === 'bullish') northScore = 25;
      else if (sentiment === 'slightly_bullish') northScore = 35;
      northDetail = '北向情绪: ' + sentiment;
    }
  } catch (e) {}
  if (!northDetail) northDetail = '暂无北向数据';
  dimensions.push({ key: 'northBound', name: '北向资金', score: northScore, weight: weights.northBound, detail: northDetail });
  weightedSum += northScore * weights.northBound;
  totalWeight += weights.northBound;

  // 5. Margin
  var marginScore = 50, marginDetail = '暂无两融数据（已部署采集器，等待数据积累）';
  dimensions.push({ key: 'margin', name: '两融余额', score: marginScore, weight: weights.margin, detail: marginDetail });
  weightedSum += marginScore * weights.margin;
  totalWeight += weights.margin;

  // 6. Volatility
  var volScore = 50, volDetail = '';
  if (aggregated.summaries && aggregated.summaries.length >= 3) {
    var changes = [];
    for (var s = 0; s < Math.min(aggregated.summaries.length, 15); s++) {
      var sumData = aggregated.summaries[s].data || aggregated.summaries[s];
      var market = sumData.market || sumData;
      if (market && market.indices && Array.isArray(market.indices)) {
        for (var idx = 0; idx < market.indices.length; idx++) {
          if (market.indices[idx].code === '000001' || market.indices[idx].name === '上证指数') {
            var cp = market.indices[idx].changePercent;
            if (cp != null) changes.push(cp);
          }
        }
      }
    }
    if (changes.length >= 3) {
      var cMean = changes.reduce(function(s, c) { return s + c; }, 0) / changes.length;
      var cVar = changes.reduce(function(s, c) { return s + (c - cMean) * (c - cMean); }, 0) / changes.length;
      var vol = Math.sqrt(cVar);
      if (vol > 2.5) volScore = 80;
      else if (vol > 1.8) volScore = 65;
      else if (vol > 1.2) volScore = 50;
      else if (vol > 0.8) volScore = 35;
      else volScore = 20;
      volDetail = '波动率(std): ' + vol.toFixed(2) + '%';
    }
  }
  if (!volDetail) volDetail = '数据不足（需要>=3个交易日总结）';
  dimensions.push({ key: 'volatility', name: '波动率', score: volScore, weight: weights.volatility, detail: volDetail });
  weightedSum += volScore * weights.volatility;
  totalWeight += weights.volatility;

  var finalScore = totalWeight > 0 ? weightedSum / totalWeight : 50;
  finalScore = Math.max(0, Math.min(100, finalScore));

  var labels = ['安全', '偏低', '正常', '偏高', '危险'];
  var labelIdx = finalScore < 20 ? 0 : finalScore < 40 ? 1 : finalScore < 60 ? 2 : finalScore < 80 ? 3 : 4;

  return { score: finalScore, label: labels[labelIdx], level: labelIdx, dimensions: dimensions };

  _state.crisisScore = finalScore;
}

// ==================== Sector Rotation ====================

function _analyzeSectorRotation(aggregated) {
  var sectors = CONFIG.SECTORS || [
    '半导体/AI算力', '机器人/具身智能', '创新药/AI医疗', '商业航天',
    '固态电池/储能', '有色金属/稀土', '新型电力基建', '军工',
  ];

  var matrix = [];
  for (var i = 0; i < sectors.length; i++) {
    matrix[i] = [];
    for (var j = 0; j < sectors.length; j++) {
      if (i === j) {
        matrix[i][j] = { rel: '-', score: 0 };
      } else {
        matrix[i][j] = _estimateSectorRelation(aggregated, sectors[i], sectors[j]);
      }
    }
  }

  // Detect phase
  var phase = _detectRotationPhase(aggregated, sectors);

  return { sectors: sectors, matrix: matrix, currentPhase: phase };
}

function _estimateSectorRelation(aggregated, sectorA, sectorB) {
  if (!aggregated.correlations || !aggregated.correlations.days || aggregated.correlations.days.length < 3) {
    return { rel: '-', score: 25 };
  }

  var days = aggregated.correlations.days;
  var diffs = [];
  var sameDirCount = 0;
  for (var d = 1; d < days.length; d++) {
    var prevA = _getSectorValueFromDay(days[d-1], sectorA);
    var currA = _getSectorValueFromDay(days[d], sectorA);
    var prevB = _getSectorValueFromDay(days[d-1], sectorB);
    var currB = _getSectorValueFromDay(days[d], sectorB);
    if (prevA == null || currA == null || prevB == null || currB == null) continue;
    var retA = currA - prevA;
    var retB = currB - prevB;
    if (prevA !== 0 && prevB !== 0) {
      diffs.push(retA - retB);
    }
    if ((retA > 0 && retB > 0) || (retA < 0 && retB < 0)) sameDirCount++;
  }

  if (diffs.length === 0) return { rel: '-', score: 25 };

  var avgDiff = diffs.reduce(function(s, v) { return s + v; }, 0) / diffs.length;
  var absDiff = Math.abs(avgDiff);

  if (absDiff > 3.0) return { rel: avgDiff > 0 ? '领先' : '滞后', score: Math.min(100, absDiff * 15) };
  if (absDiff > 1.0) return { rel: avgDiff > 0 ? '领先' : '滞后', score: Math.min(90, absDiff * 10) };
  return { rel: '同步', score: 40 + (sameDirCount / Math.max(1, diffs.length)) * 20 };
}

function _getSectorValueFromDay(dayEntry, sector) {
  if (!dayEntry || !dayEntry.aStock) return null;
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
    if (dayEntry.aStock[keys[i]] !== undefined) { sum += dayEntry.aStock[keys[i]]; count++; }
  }
  return count > 0 ? sum / count : null;
}

function _detectRotationPhase(aggregated, sectors) {
  if (!aggregated.portfolio || !aggregated.portfolio.positions || aggregated.portfolio.positions.length === 0) {
    return { phase: '未知', detail: '暂无持仓数据' };
  }

  var positions = aggregated.portfolio.positions;
  var totalValue = positions.reduce(function(s, p) { return s + (p.marketValue || 0); }, 0);
  if (totalValue === 0) return { phase: '未知', detail: '持仓市值为0' };

  var aggressiveSectors = ['机器人/具身智能', '半导体/AI算力', '军工'];
  var defensiveSectors = ['有色金属/稀土', '新型电力基建'];
  var aggValue = 0;
  for (var i = 0; i < positions.length; i++) {
    var name = positions[i].name || '';
    var sector = _classifySector(name);
    if (aggressiveSectors.indexOf(sector) >= 0) aggValue += positions[i].marketValue || 0;
  }

  var aggRatio = aggValue / totalValue;
  if (aggRatio > 0.7) return { phase: '普涨期', detail: '进攻仓位占比' + (aggRatio * 100).toFixed(0) + '%' };
  if (aggRatio > 0.5) return { phase: '周期扩散', detail: '进攻仓位占比' + (aggRatio * 100).toFixed(0) + '%' };
  if (aggRatio > 0.3) return { phase: '回调洗牌', detail: '进攻仓位占比' + (aggRatio * 100).toFixed(0) + '%' };
  return { phase: '防御期', detail: '进攻仓位占比' + (aggRatio * 100).toFixed(0) + '%' };
}

function _classifySector(name) {
  var map = {
    '半导体/AI算力': ['芯片', '电子', '光电', '封测', '半导体'],
    '机器人/具身智能': ['机器人', '智能', '自动化'],
    '创新药/AI医疗': ['医药', '药', '医疗', '生物'],
    '商业航天': ['航天', '卫星', '火箭'],
    '固态电池/储能': ['电池', '储能', '锂', '新能源'],
    '有色金属/稀土': ['有色', '稀土', '金属', '矿'],
    '新型电力基建': ['电力', '电网', '能源'],
    '军工': ['军工', '国防', '军'],
  };
  for (var sec in map) {
    for (var i = 0; i < map[sec].length; i++) {
      if (name.indexOf(map[sec][i]) >= 0) return sec;
    }
  }
  return '其他';
}

// ==================== Factor Effectiveness ====================

function _analyzeFactorEffectiveness(aggregated) {
  var factorNames = {
    H1: '缩量止跌', H2: '底部放量', H3: '逆势抗跌',
    H4: 'PE低估', H5: '高ROE低PB', H6: '现金流健康',
    H7: '低换手蓄力', H8: '短期反转', H9: '量价背离',
  };

  var fpFactors = (aggregated.factorPerf && aggregated.factorPerf.factors) ? aggregated.factorPerf.factors : [];
  var result = [];

  for (var i = 1; i <= 9; i++) {
    var id = 'H' + i;
    var fData = fpFactors.find(function(f) { return f.id === id; });
    var hitRate = fData ? (fData.hitRate5d || fData.hitRate || 0) : 0;
    var hitRate5d = fData ? fData.hitRate5d : null;
    var hitRate20d = fData ? fData.hitRate20d : null;
    var avgReturn = fData ? (fData.avgReturn || 0) : 0;
    var trend = fData ? (fData.trend || 'stable') : 'stable';
    var signalCount = fData ? (fData.signalCount || 0) : 0;
    var status = hitRate >= 0.55 ? 'HOT' : (hitRate > 0 && hitRate < 0.40) ? 'COLD' : 'STABLE';

    result.push({
      id: id,
      name: factorNames[id],
      hitRate: hitRate,
      hitRate5d: hitRate5d,
      hitRate20d: hitRate20d,
      avgReturn: avgReturn,
      trend: trend,
      signalCount: signalCount,
      status: status,
    });
  }

  return result;
}

// ==================== Insights ====================

function _generateInsights(verificationContext) {
  var insights = [];
  var score = _state.crisisScore || 50;

  // Regime alert
  var crisisWeight = score >= 75 ? 3 : 2;
  if (verificationContext && verificationContext.adjustments) {
    // Adjust based on calibration
    for (var a = 0; a < verificationContext.adjustments.length; a++) {
      if (verificationContext.adjustments[a].indexOf('危机') >= 0) {
        crisisWeight = Math.max(1, crisisWeight - 1);
      }
    }
  }
  insights.push({
    type: 'regime_alert',
    title: score >= 75 ? '危险: 危机分偏高' : score >= 50 ? '注意: 危机分中等' : '正常: 危机分偏低',
    detail: '综合危机评分: ' + score.toFixed(0) + '/100',
    weight: crisisWeight,
    suggestedAction: score >= 75 ? '建议减仓或防御性调仓' : score >= 50 ? '保持仓位，控制新开仓节奏' : '可以正常建仓',
    timestamp: new Date().toISOString(),
  });

  // Historical parallel
  if (_state.similarityResults && _state.similarityResults.length > 0) {
    var topSim = _state.similarityResults[0];
    var simWeight = topSim.similarity > 0.80 ? 2 : 1;
    if (verificationContext && verificationContext.overallGrade === 'D' || verificationContext && verificationContext.overallGrade === 'F') {
      simWeight = 0;
    }
    var top5d = topSim.future5d ? topSim.future5d.total : 0;
    insights.push({
      type: 'historical_parallel',
      title: '历史相似时期: ' + topSim.startDate + ' ~ ' + topSim.endDate,
      detail: '相似度 ' + (topSim.similarity * 100).toFixed(1) + '% (' + topSim.simLabel + '), 该时期后续5日: ' + (top5d > 0 ? '+' : '') + top5d.toFixed(2) + '%',
      weight: simWeight,
      suggestedAction: top5d > 2 ? '历史模式看涨，可适度积极' : top5d < -2 ? '历史模式看跌，保持谨慎' : '历史模式中性',
      timestamp: new Date().toISOString(),
    });
  }

  // Factor preference
  if (_state.factorPerformance) {
    var hotFactors = _state.factorPerformance.filter(function(f) { return f.status === 'HOT'; }).map(function(f) { return f.id + ' ' + f.name; });
    if (hotFactors.length > 0) {
      insights.push({
        type: 'factor_preference',
        title: '当前高效因子: ' + hotFactors.join(', '),
        detail: '命中率均>55%，建议优先关注触发这些因子的候选股',
        weight: 1,
        suggestedAction: '关注' + hotFactors.join(', '),
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Sector preference
  if (_state.sectorRotation && _state.sectorRotation.currentPhase) {
    var phase = _state.sectorRotation.currentPhase.phase;
    var pref = phase === '普涨期' || phase === '周期扩散' ? '进攻型板块(机器人/半导体/军工)' : '防御型板块(有色/电力)';
    insights.push({
      type: 'sector_preference',
      title: '当前周期: ' + phase,
      detail: '建议关注: ' + pref,
      weight: 1,
      suggestedAction: '板块偏好: ' + pref,
      timestamp: new Date().toISOString(),
    });
  }

  // Cross-market
  if (_state.marketProfile && _state.marketProfile.riskRegime) {
    var regime = _state.marketProfile.riskRegime;
    var crossWeight = regime === 'panic' || regime === 'risk_off' ? 5 : regime === 'neutral' ? 2 : 1;
    insights.push({
      type: 'cross_market',
      title: '跨市场风险: ' + regime,
      detail: '美股风险状态机判断',
      weight: crossWeight,
      suggestedAction: crossWeight >= 5 ? '跨市场熔断级别，暂停买入' : crossWeight >= 2 ? '跨市场谨慎，降低买入仓位' : '跨市场正常',
      timestamp: new Date().toISOString(),
    });
  }

  return insights;
}

function _buildMarketProfile(aggregated) {
  var profile = {};
  // Risk regime from cross_market
  try {
    var cm = require('./cross_market');
    var usLatestPath = path.join(DATA_DIR, 'us_market', 'us_latest.json');
    if (fs.existsSync(usLatestPath)) {
      var usData = JSON.parse(fs.readFileSync(usLatestPath, 'utf8'));
      var riskState = cm.computeRiskState ? cm.computeRiskState(usData) : null;
      if (riskState) profile.riskRegime = riskState.level || riskState.regime || 'unknown';
    }
  } catch (e) {}

  // Drawdown from portfolio
  if (aggregated.portfolio && aggregated.portfolio._stats) {
    profile.drawdown = aggregated.portfolio._stats.maxDrawdown || 0;
  }

  return profile;
}

// ==================== Weekend Discovery Sub-functions ====================

function _scanVolumePatterns(histData) {
  var sh = histData['sh000001'];
  if (!sh || sh.length < 60) return [];
  var current = sh.slice(-20);
  var currentVol = current.reduce(function(s, d) { return s + (d.volume || 0); }, 0) / 20;
  var currentVolStd = Math.sqrt(current.reduce(function(s, d) { var diff = (d.volume || 0) - currentVol; return s + diff * diff; }, 0) / 20);

  var matches = [];
  for (var i = 0; i < sh.length - 40; i += 10) {
    var window = sh.slice(i, i + 20);
    var wVol = window.reduce(function(s, d) { return s + (d.volume || 0); }, 0) / 20;
    if (currentVol > 0 && Math.abs(wVol - currentVol) / currentVol < 0.3) {
      matches.push({ startDate: window[0].date, endDate: window[19].date, avgVol: wVol, volDiff: (wVol - currentVol) / currentVol * 100 });
    }
  }
  matches.sort(function(a, b) { return Math.abs(a.volDiff) - Math.abs(b.volDiff); });
  return matches.slice(0, 5);
}

function _scanExtremeScenarios(histData) {
  var sh = histData['sh000001'];
  if (!sh || sh.length < 100) return { dropReboundRate: 0, rallyContinueRate: 0, samples: 0 };

  var drops = 0, dropRebounds = 0, rallies = 0, rallyContinues = 0;

  for (var i = 20; i < sh.length - 10; i++) {
    var ret5d = (sh[i].close - sh[i-5].close) / sh[i-5].close * 100;
    var retNext5d = (sh[Math.min(i+5, sh.length-1)].close - sh[i].close) / sh[i].close * 100;

    if (ret5d < -8) {
      drops++;
      if (retNext5d > 0) dropRebounds++;
    }
    if (ret5d > 8) {
      rallies++;
      if (retNext5d > 0) rallyContinues++;
    }
  }

  return {
    dropReboundRate: drops > 0 ? dropRebounds / drops : 0,
    rallyContinueRate: rallies > 0 ? rallyContinues / rallies : 0,
    dropSamples: drops,
    rallySamples: rallies,
  };
}

function _computeFactorDecayCurves() {
  var spPath = path.join(SIMFOLIO_DIR, 'stock_factor_performance.json');
  if (!fs.existsSync(spPath)) return null;
  try {
    var sp = JSON.parse(fs.readFileSync(spPath, 'utf8'));
    var records = sp.dailyRecords || [];
    if (records.length < 30) return null;

    var curves = {};
    for (var h = 1; h <= 9; h++) {
      var hid = 'H' + h;
      curves[hid] = { horizons: [], returns: [] };
      // Simplified: collect T+1 to T+20 returns
      for (var t = 1; t <= 20; t++) {
        var returns = [];
        for (var i = 0; i < records.length - t; i++) {
          var rec = records[i];
          if (rec.factorSignals && rec.factorSignals.indexOf(hid) >= 0) {
            var futureRec = records[Math.min(i + t, records.length - 1)];
            if (futureRec.price && rec.price) {
              returns.push((futureRec.price - rec.price) / rec.price);
            }
          }
        }
        if (returns.length >= 5) {
          curves[hid].horizons.push(t);
          curves[hid].returns.push(returns.reduce(function(s, r) { return s + r; }, 0) / returns.length * 100);
        }
      }
    }
    return curves;
  } catch (e) {}
  return null;
}

function _analyzeCrossMarketLinkage(histData) {
  // Stub: requires us_market historical data
  return { note: '需要美股历史K线数据，当前仅用上证数据做相似度' };
}

function _computeSectorSimilarity(histData) {
  // Stub for sector similarity — requires sector index K-line data
  return [];
}

function _analyzeCovarianceStructure() {
  var corrPath = path.join(DATA_DIR, 'us_market', 'correlation_history.json');
  if (!fs.existsSync(corrPath)) return null;
  try {
    var corr = JSON.parse(fs.readFileSync(corrPath, 'utf8'));
    var days = corr.days || [];
    if (days.length < 5) return null;

    var sectors = CONFIG.SECTORS || [];
    var sectorData = {};
    for (var s = 0; s < sectors.length; s++) {
      sectorData[sectors[s]] = [];
    }

    for (var d = 1; d < days.length; d++) {
      for (var j = 0; j < sectors.length; j++) {
        var prev = _getSectorValueFromDay(days[d-1], sectors[j]);
        var curr = _getSectorValueFromDay(days[d], sectors[j]);
        if (prev != null && curr != null && prev !== 0) {
          sectorData[sectors[j]].push((curr - prev) / Math.abs(prev));
        }
      }
    }

    // Check if we have enough data
    var minLen = Infinity;
    for (var k = 0; k < sectors.length; k++) {
      minLen = Math.min(minLen, sectorData[sectors[k]].length);
    }

    return { note: '协方差结构分析需要>20个交易日数据，当前共' + minLen + '天', sectors: sectors.length };
  } catch (e) {}
  return null;
}

// ==================== Context Persistence ====================

function _writeHistoryContext(verificationContext) {
  var ctx = {
    generatedAt: new Date().toISOString(),
    validUntil: _daysFromNow(HR.contextValidDays || 3),
    dailyInsights: _state.dailyInsights,
    deepAnalysis: {
      lastRun: _state.lastDeep,
      similarity: _state.similarityResults,
      crisisWarning: _state.crisisWarning,
      sectorRotation: _state.sectorRotation,
      factorPerformance: _state.factorPerformance,
      insights: _state.insights,
    },
    verificationContext: verificationContext || null,
    discoveries: _state.discoveries,
    marketProfile: _state.marketProfile,
  };

  _ensureDir(SIMFOLIO_DIR);
  var ctxPath = path.join(SIMFOLIO_DIR, 'history_context.json');
  fs.writeFileSync(ctxPath, JSON.stringify(ctx, null, 2), 'utf8');
}

function _loadFactorMining() {
  var combosPath = path.join(SIMFOLIO_DIR, 'factor_combinations.json');
  try {
    if (fs.existsSync(combosPath)) {
      _state.factorCombinations = JSON.parse(fs.readFileSync(combosPath, 'utf8'));
    }
  } catch (e) {}
}

function _archiveReport() {
  _ensureDir(ARCHIVE_DIR);
  var weekendId = _getWeekendIdentifier();
  var report = {
    weekend: weekendId,
    generatedAt: new Date().toISOString(),
    similarity: _state.similarityResults,
    crisisWarning: _state.crisisWarning,
    sectorRotation: _state.sectorRotation,
    factorPerformance: _state.factorPerformance,
    insights: _state.insights,
    discoveries: _state.discoveries,
  };

  var archivePath = path.join(ARCHIVE_DIR, weekendId + '.json');
  fs.writeFileSync(archivePath, JSON.stringify(report, null, 2), 'utf8');

  // Update index
  var indexPath = path.join(ARCHIVE_DIR, '_index.json');
  var entries = [];
  try {
    var raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    // Support both old format (plain array) and new format ({ entries: [...] })
    entries = Array.isArray(raw) ? raw : (raw.entries || []);
  } catch (e) {}
  var found = false;
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].weekend === weekendId) { found = true; break; }
  }
  if (!found) entries.unshift({ weekend: weekendId, verified: false });
  // Trim to maxWeeks
  var maxWeeks = (HR.deep && HR.deep.verification && HR.deep.verification.maxArchiveWeeks) || 52;
  if (entries.length > maxWeeks) entries = entries.slice(0, maxWeeks);
  fs.writeFileSync(indexPath, JSON.stringify({ entries: entries }, null, 2), 'utf8');
}

function _extractHighlights(verifReport) {
  var highlights = [];
  if (verifReport.overallGrade) highlights.push('综合评级: ' + verifReport.overallGrade + ' (' + (verifReport.overallScore || 0).toFixed(0) + '分)');
  if (verifReport.crisis && verifReport.crisis.calibration) highlights.push('危机校准: ' + verifReport.crisis.calibration);
  if (verifReport.similarity && verifReport.similarity.directionCorrectCount != null) {
    highlights.push('相似度方向正确: ' + verifReport.similarity.directionCorrectCount + '/' + verifReport.similarity.totalHorizons);
  }
  return highlights;
}

// ==================== Weekend Tick Scheduler ====================

function _startWeekendTicks() {
  // Run ticks every 2 hours during weekend
  _state.weekendTimerId = setInterval(function() {
    var now = new Date();
    var day = now.getDay();
    if (day !== 0 && day !== 6) { stopWeekendTicks(); return; }
    if (!_state.running) {
      runWeekendTick();
    }
  }, 2 * 60 * 60 * 1000); // 2 hours

  // Schedule Sunday discovery
  var now = new Date();
  var day = now.getDay();
  if (day === 6) {
    // Saturday: schedule Sunday 09:00 discovery
    var sun900 = new Date(now);
    sun900.setDate(sun900.getDate() + 1);
    sun900.setHours(9, 0, 0, 0);
    var delay = sun900.getTime() - now.getTime();
    if (delay > 0) {
      _state.discoveryTimerId = setTimeout(function() {
        runWeekendDiscovery({ similarityWindow: 30, similarityTopN: 8, similarityStride: 3 });
      }, delay);
    }
  } else if (day === 0) {
    // Sunday: schedule discovery now if after 09:00 and not yet run
    if (now.getHours() >= 9 && !_state.lastDiscovery) {
      _state.discoveryTimerId = setTimeout(function() {
        runWeekendDiscovery({ similarityWindow: 30, similarityTopN: 8, similarityStride: 3 });
      }, 5000);
    }
  }
}

// ==================== Helpers ====================

function _todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function _daysFromNow(days) {
  var d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function _getWeekendIdentifier() {
  var d = new Date();
  var day = d.getDay();
  if (day === 0) d.setDate(d.getDate() - 1); // Sunday -> Saturday
  else if (day >= 1 && day <= 5) d.setDate(d.getDate() - day - 1); // Weekday -> previous Saturday
  return d.toISOString().slice(0, 10);
}

function _getLastWeekend() {
  var d = new Date();
  var day = d.getDay();
  var lastSat;
  if (day === 6) lastSat = new Date(d.getTime() - 7 * 86400000);
  else if (day === 0) lastSat = new Date(d.getTime() - 8 * 86400000);
  else lastSat = new Date(d.getTime() - (day + 7) * 86400000);
  return lastSat.toISOString().slice(0, 10);
}

function _ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
}

// ==================== Exports ====================

module.exports = {
  runDaily,
  runWeekendDeep,
  runWeekendDiscovery,
  runWeekendTick,
  stopWeekendTicks,
  getStatus,
  getReport,
  getPatterns,
  getVerification,
  getDeepAnalysis,
  setSSEBroadcast,
};
