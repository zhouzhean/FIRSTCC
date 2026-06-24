/**
 * evolution_scheduler.js — 进化任务统一调度器 (v2.7.0)
 *
 * 管理所有夜间/周末学习任务的执行时机和状态。
 * 由主 scheduler.js 的 _tick() 中调用 checkAndRun()。
 *
 * 任务时间表（CST）：
 *   周日 01:00 → 历史训练 bootstrap (bootstrap_history) [v3.1]
 *   02:00 → 夜间历史回测 (night_backtest)
 *   03:00 → 动态权重网格搜索 (weight_grid_search)
 *   04:00 → 参数推送验证 (parameter_push) [v2.7.0]
 *   05:30 → 美股→A股预测生成 (us_as_predict)
 *   15:10 → 16:10 美股→A股预测验证 (us_as_predict) — 修复:等16:00 correlation snapshot 写入后再验证
 *   20:00 → 自我质疑循环 (self_reflection)
 *   周六 10:00 → 因子组合挖掘 (weekend_factor_mining)
 *   周日 14:00 → 进化周报 (weekly_report) [v2.7.0]
 *   周日/周三 03:00 → 候选模型步前向评估 (candidate_evaluation) [P1]
 *
 * 防重复：每个任务每天只执行一次（按 (taskId, dateStr) 去重）
 * 任务历史持久化到 data/simfolio/evo_task_history.json [v2.7.0]
 */

var fs, path;
try { fs = require('fs'); path = require('path'); } catch (_) {}

var DATA_DIR = (function() {
  try { return path.join(__dirname, '..', '..', 'report-engine', 'data', 'simfolio'); }
  catch (_) { return __dirname; }
})();

var HISTORY_FILE = DATA_DIR ? path.join(DATA_DIR, 'evo_task_history.json') : null;

var _state = {
  history: [],          // [{ task, date, time, success, error, summary }]
  maxHistory: 200,
  running: false,
  runningTask: null,
  runningProgress: null, // { processed, total, message } v2.7.0
};

// Load persisted history
(function loadPersistedHistory() {
  if (!HISTORY_FILE || !fs) return;
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      var loaded = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      if (loaded.history && Array.isArray(loaded.history)) {
        _state.history = loaded.history.slice(-_state.maxHistory);
      }
    }
  } catch (_) {}
})();

function persistHistory() {
  if (!HISTORY_FILE || !fs) return;
  try {
    var dir = path.dirname(HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({
      history: _state.history,
      updatedAt: new Date().toISOString(),
    }, null, 2), 'utf8');
  } catch (_) {}
}

/**
 * 主调度入口。每次 tick 调用一次。
 * @param {Date} now - 当前时间
 * @param {string} dateStr - YYYY-MM-DD
 */
function checkAndRun(now, dateStr) {
  if (!now) now = new Date();
  if (!dateStr) dateStr = now.toISOString().slice(0, 10);

  var h = now.getHours();
  var m = now.getMinutes();
  var day = now.getDay(); // 0=Sun, 6=Sat

  // --- [v3.0]: Full Multi-Regime Backtest (Sunday 02:00-02:45) ---
  if (day === 0 && h === 2 && m >= 0 && m < 45) {
    tryRunTask('full_backtest', dateStr, function() {
      var fb = require('./full_backtest');
      return fb.runWeeklyBacktest();
    });
  }

  // --- [v3.1]: Bootstrap History Training (Sunday 01:00-01:45, before night_backtest) ---
  // First run = full, subsequent = incremental (EMA merge into existing matrix)
  if (day === 0 && h === 1 && m >= 0 && m < 45) {
    tryRunTask('bootstrap_history', dateStr, function() {
      var bh = require('./bootstrap_history');
      var fs = require('fs');
      var path = require('path');
      var trainingFile = path.join(__dirname, '..', '..', 'report-engine', 'data', 'evolution', 'training_matrix.json');
      var hasExisting = false;
      try { hasExisting = fs.existsSync(trainingFile); } catch (e) {}
      var result;
      if (hasExisting) {
        console.log('[EvolutionScheduler] bootstrap: 增量模式 (已有训练矩阵)');
        result = bh.incrementalUpdate(20);
      } else {
        console.log('[EvolutionScheduler] bootstrap: 首次全量模式');
        result = bh.runBootstrap({ skipDownload: false, universe: 'hs300' });
      }
      // v3.3.0: Register bootstrap results as shadow model version
      if (result && result.paramSearch) {
        try {
          var mr = require('./model_registry');
          var bestParam = (result.paramSearch.topConfigs && result.paramSearch.topConfigs[0]) || {};
          mr.registerVersion({
            params: {
              stopLoss: bestParam.stopLoss,
              buyMinScore: bestParam.buyMinScore,
              positionSize: bestParam.positionSize,
              maxPositions: bestParam.maxPositions,
              source: 'bootstrap',
            },
            source: 'bootstrap',
            trainHitRate: bestParam.hitRate != null ? bestParam.hitRate / 100 : null,
            trainIC: null,
            sampleSize: bestParam.qualifiedCount || 0,
            date: dateStr,
          });
        } catch (_) { /* model_registry is advisory */ }
      }
      return result;
    });
  }

  // --- Task: Night Backtest (02:00-02:30, widened from 5min for reboot resilience) ---
  if (h === 2 && m >= 0 && m < 30) {
    tryRunTask('night_backtest', dateStr, function() {
      var nb = require('./night_backtest');
      return nb.runNightlyBacktest({ maxStocks: 200, lookbackDays: 60 });
    });
  }

  // --- Task: Weight Grid Search (03:00-03:30) ---
  if (h === 3 && m >= 0 && m < 30) {
    tryRunTask('weight_grid_search', dateStr, function() {
      var gs = require('./weight_grid_search');
      var result = gs.runGridSearch();
      // v3.3.0: Register result as a shadow model version
      if (result && result.bestParams) {
        try {
          var mr = require('./model_registry');
          mr.registerVersion({
            params: result.bestParams,
            source: 'grid_search',
            trainHitRate: result.best ? result.best.testHitRate : null,
            trainIC: null, // OLS regression doesn't compute IC directly
            sampleSize: result.best ? result.best.testSamples : 0,
            date: dateStr,
          });
        } catch (_) { /* model_registry is advisory */ }
      }
      return result;
    });
  }

  // --- [v2.7.0]: Parameter Push Verification (04:00-04:30) ---
  if (h === 4 && m >= 0 && m < 30) {
    tryRunTask('parameter_push', dateStr, function() {
      return runParameterPush(dateStr);
    });
  }

  // --- Task: US→A Prediction Generation (05:30-06:00) ---
  if (h === 5 && m >= 30 && m < 60) {
    tryRunTask('us_predict_generate', dateStr, function() {
      var up = require('./us_as_predict');
      return up.generateOvernightPrediction(dateStr);
    });
  }

  // --- Task: US→A Prediction Verification (16:10-16:40 — after 16:00 correlation snapshot) ---
  if (h === 16 && m >= 10 && m < 40) {
    tryRunTask('us_predict_verify', dateStr, function() {
      var up = require('./us_as_predict');
      return up.verifyPrediction(dateStr);
    });
  }

  // --- Task: Self Reflection (20:00-20:30) ---
  if (h === 20 && m >= 0 && m < 30) {
    tryRunTask('self_reflection', dateStr, function() {
      var sr = require('./self_reflection');
      var pf;
      try {
        var simfolio = require('../simfolio');
        pf = simfolio.loadPortfolio();
      } catch (_) {
        pf = { positions: [], tradeHistory: [] };
      }
      return sr.runSelfReflection(pf, dateStr);
    });
  }

  // --- Task: Weekend Factor Mining (Saturday 10:00-10:30) ---
  if (day === 6 && h === 10 && m >= 0 && m < 30) {
    tryRunTask('weekend_factor_mining', dateStr, function() {
      var wf = require('./weekend_factor_mining');
      return wf.runWeekendMining();
    });
  }

  // --- [v2.7.0]: Weekly Evolution Report (Sunday 14:00-14:30) ---
  if (day === 0 && h === 14 && m >= 0 && m < 30) {
    tryRunTask('weekly_report', dateStr, function() {
      return runWeeklyReport(dateStr);
    });
  }

  // --- [P1]: Candidate Evaluation (Sunday + Wednesday 03:00-03:45) ---
  var CANDIDATE_RUNNER_CONFIG;
  try { CANDIDATE_RUNNER_CONFIG = require('../config').CANDIDATE_RUNNER; } catch (_) { CANDIDATE_RUNNER_CONFIG = { enabled: false }; }
  if (CANDIDATE_RUNNER_CONFIG.enabled) {
    var crDay = CANDIDATE_RUNNER_CONFIG.dayOfWeek || [0, 3];
    var crHour = (CANDIDATE_RUNNER_CONFIG.scheduleTime || { hour: 3 }).hour;
    var crMin = (CANDIDATE_RUNNER_CONFIG.scheduleTime || { minute: 0 }).minute;
    if (crDay.indexOf(day) >= 0 && h === crHour && m >= crMin && m < crMin + 45) {
      tryRunTask('candidate_evaluation', dateStr, function() {
        var runner = require('../research/candidate_runner');
        return runner.runAllHypotheses({
          monteCarloSamples: CANDIDATE_RUNNER_CONFIG.monteCarloSamples || 100,
          costAssumptions: CANDIDATE_RUNNER_CONFIG.costAssumptions,
        });
      });
    }
  }

  // === Catch-up: if past a task's window and it hasn't run today, run now ===
  tryRunCatchup(now, dateStr);
}

/**
 * Catch-up mechanism: if the server restart missed a task's time window,
 * check if the task hasn't run today and the window has passed → run immediately.
 * Only activates once per task per boot (dedup prevents double-runs).
 *
 * v3.3.0: Full 10-task coverage with day-of-week checks for weekend tasks.
 */
function tryRunCatchup(now, dateStr) {
  var h = now.getHours();
  var m = now.getMinutes();
  var day = now.getDay(); // 0=Sun, 6=Sat

  // Every 10 minutes, try catch-up
  var isCatchupTick = (m % 10 === 0);
  if (!isCatchupTick) return;

  var nowMin = h * 60 + m;

  // All 10 tasks with schedule and day-of-week filter
  var taskSchedules = [
    { id: 'bootstrap_history',       hour: 1, minute: 0,  days: [0] },          // Sun only
    { id: 'full_backtest',           hour: 2, minute: 0,  days: [0] },          // Sun only
    { id: 'night_backtest',          hour: 2, minute: 0,  days: [0,1,2,3,4,5,6] }, // Daily
    { id: 'weight_grid_search',      hour: 3, minute: 0,  days: [0,1,2,3,4,5,6] }, // Daily
    { id: 'parameter_push',          hour: 4, minute: 0,  days: [0,1,2,3,4,5,6] }, // Daily
    { id: 'us_predict_generate',     hour: 5, minute: 30, days: [0,1,2,3,4,5,6] }, // Daily
    { id: 'us_predict_verify',       hour: 16, minute: 10,days: [0,1,2,3,4,5,6] }, // Daily
    { id: 'self_reflection',         hour: 20, minute: 0, days: [0,1,2,3,4,5,6] }, // Daily
    { id: 'weekend_factor_mining',   hour: 10, minute: 0, days: [6] },          // Sat only
    { id: 'weekly_report',           hour: 14, minute: 0, days: [0] },          // Sun only
    { id: 'candidate_evaluation',    hour: 3,  minute: 0, days: [0, 3] },       // Sun + Wed [P1]
  ];

  for (var i = 0; i < taskSchedules.length; i++) {
    var ts = taskSchedules[i];
    // Day-of-week filter
    if (ts.days && ts.days.indexOf(day) === -1) continue;
    var windowStart = ts.hour * 60 + ts.minute;
    // If current time is at least 15 min after window start, attempt catch-up
    if (nowMin < windowStart + 15) continue;

    // Dispatch each task with its run function
    var taskId = ts.id;
    switch (taskId) {
      case 'bootstrap_history':
        tryRunTask(taskId, dateStr, function() {
          var bh = require('./bootstrap_history');
          var fs = require('fs');
          var path = require('path');
          var trainingFile = path.join(__dirname, '..', '..', 'report-engine', 'data', 'evolution', 'training_matrix.json');
          var hasExisting = false;
          try { hasExisting = fs.existsSync(trainingFile); } catch (e) {}
          if (hasExisting) {
            return bh.incrementalUpdate(20);
          } else {
            return bh.runBootstrap({ skipDownload: false, universe: 'hs300' });
          }
        });
        break;
      case 'full_backtest':
        tryRunTask(taskId, dateStr, function() {
          return require('./full_backtest').runWeeklyBacktest();
        });
        break;
      case 'night_backtest':
        tryRunTask(taskId, dateStr, function() {
          return require('./night_backtest').runNightlyBacktest({ maxStocks: 200, lookbackDays: 60 });
        });
        break;
      case 'weight_grid_search':
        tryRunTask(taskId, dateStr, function() {
          return require('./weight_grid_search').runGridSearch();
        });
        break;
      case 'parameter_push':
        tryRunTask(taskId, dateStr, function() {
          return runParameterPush(dateStr);
        });
        break;
      case 'us_predict_generate':
        tryRunTask(taskId, dateStr, function() {
          return require('./us_as_predict').generateOvernightPrediction(dateStr);
        });
        break;
      case 'us_predict_verify':
        tryRunTask(taskId, dateStr, function() {
          return require('./us_as_predict').verifyPrediction(dateStr);
        });
        break;
      case 'self_reflection':
        tryRunTask(taskId, dateStr, function() {
          var sr = require('./self_reflection');
          var pf;
          try {
            var simfolio = require('../simfolio');
            pf = simfolio.loadPortfolio();
          } catch (_) { pf = { positions: [], tradeHistory: [] }; }
          return sr.runSelfReflection(pf, dateStr);
        });
        break;
      case 'weekend_factor_mining':
        tryRunTask(taskId, dateStr, function() {
          return require('./weekend_factor_mining').runWeekendMining();
        });
        break;
      case 'weekly_report':
        tryRunTask(taskId, dateStr, function() {
          return runWeeklyReport(dateStr);
        });
        break;
      case 'candidate_evaluation':
        tryRunTask(taskId, dateStr, function() {
          var runner = require('../research/candidate_runner');
          var cfg;
          try { cfg = require('../config').CANDIDATE_RUNNER; } catch (_) { cfg = { enabled: true }; }
          return runner.runAllHypotheses({
            monteCarloSamples: cfg.monteCarloSamples || 100,
            costAssumptions: cfg.costAssumptions,
          });
        });
        break;
    }
  }
}

// ==================== [v2.7.0]: New tasks ====================

/**
 * 参数推送验证 (04:00) — 在网格搜索结果基础上，验证 bestParams
 * 是否在最近的最优组合中仍然表现最好。如果 drifted → 标记需要重新搜索。
 */
function runParameterPush(dateStr) {
  var result = { action: 'parameter_push', date: dateStr, checks: [] };

  // 1. Check if grid search found best params
  var gridResultPath;
  try { gridResultPath = path.join(DATA_DIR, 'weight_grid_result.json'); }
  catch (_) { gridResultPath = null; }

  if (gridResultPath && fs.existsSync(gridResultPath)) {
    try {
      var gridResult = JSON.parse(fs.readFileSync(gridResultPath, 'utf8'));
      if (gridResult.best && gridResult.bestParams) {
        result.checks.push({
          check: 'grid_params_valid',
          status: 'ok',
          detail: 'lookback=' + gridResult.best.lookback + ', alpha=' + gridResult.best.emaAlpha +
            ', hitRate=' + Math.round(gridResult.best.testHitRate * 100) + '%',
        });
      }
    } catch (_) { result.checks.push({ check: 'grid_params_valid', status: 'error', detail: '无法读取网格搜索结果' }); }
  } else {
    result.checks.push({ check: 'grid_params_valid', status: 'pending', detail: '尚无网格搜索结果' });
  }

  // 2. Check if dynamic_weights has been updated
  var dwPath;
  try { dwPath = path.join(DATA_DIR, 'dynamic_weights.json'); }
  catch (_) { dwPath = null; }

  if (dwPath && fs.existsSync(dwPath)) {
    try {
      var dw = JSON.parse(fs.readFileSync(dwPath, 'utf8'));
      if (dw.weights) {
        result.checks.push({
          check: 'weights_active',
          status: 'ok',
          detail: 'R²=' + (dw.r2 != null ? dw.r2.toFixed(3) : '?') + ', samples=' + (dw.sampleCount || '?'),
        });
      }
      if (dw.bestParams) {
        result.checks.push({
          check: 'best_params_applied',
          status: 'ok',
          detail: 'lookback=' + dw.bestParams.lookbackDays + ', alpha=' + dw.bestParams.emaAlpha,
        });
      }
    } catch (_) { result.checks.push({ check: 'weights_active', status: 'error', detail: '无法读取动态权重' }); }
  }

  // 3. Check US prediction accuracy status
  var verifyPath;
  try { verifyPath = path.join(DATA_DIR, 'us_as_verification_history.json'); }
  catch (_) { verifyPath = null; }

  if (verifyPath && fs.existsSync(verifyPath)) {
    try {
      var verifyHistory = JSON.parse(fs.readFileSync(verifyPath, 'utf8'));
      var entries = verifyHistory.entries || [];
      var recentEntries = entries.slice(-10);
      if (recentEntries.length > 0) {
        var totalDecisive = 0, totalCorrect = 0;
        for (var i = 0; i < recentEntries.length; i++) {
          if (recentEntries[i].decisivePredictions > 0) {
            totalDecisive += recentEntries[i].decisivePredictions;
            totalCorrect += recentEntries[i].correctCount;
          }
        }
        var hitRate = totalDecisive > 0 ? Math.round(totalCorrect / totalDecisive * 100) : null;
        result.checks.push({
          check: 'us_predict_accuracy',
          status: hitRate != null ? (hitRate >= 65 ? 'hot' : hitRate >= 50 ? 'ok' : 'warn') : 'pending',
          detail: hitRate != null ? hitRate + '% (' + totalDecisive + '次判定)' : 'insufficient data',
        });
      }
    } catch (_) {}
  }

  result.summary = result.checks.length + ' 项检查完成';
  console.log('[ParameterPush] ' + result.summary);
  return result;
}

/**
 * 进化周报 (周日14:00) — 整合一周所有进化数据生成周报摘要
 */
function runWeeklyReport(dateStr) {
  var result = { date: dateStr, sections: [], recommendations: [] };

  // 1. 回溯一周进化任务执行记录
  var weekHistory = _state.history.filter(function(e) {
    if (!e.date) return false;
    var taskDate = new Date(e.date + 'T00:00:00+08:00');
    var nowDate = new Date(dateStr + 'T00:00:00+08:00');
    var daysDiff = (nowDate - taskDate) / 86400000;
    return daysDiff >= 0 && daysDiff <= 7;
  });

  var successCount = weekHistory.filter(function(e) { return e.success; }).length;
  var failCount = weekHistory.filter(function(e) { return !e.success; }).length;
  result.sections.push({
    title: '任务执行',
    content: '近7天: ' + weekHistory.length + ' 次任务, ' + successCount + ' 成功, ' + failCount + ' 失败',
  });

  // 2. 因子绩效趋势
  try {
    var backtestPath = path.join(DATA_DIR, 'night_backtest_result.json');
    if (fs.existsSync(backtestPath)) {
      var btResult = JSON.parse(fs.readFileSync(backtestPath, 'utf8'));
      if (btResult.factors) {
        var hotFactors = btResult.factors.filter(function(f) { return f.status === 'hot'; });
        var coldFactors = btResult.factors.filter(function(f) { return f.status === 'cold'; });
        result.sections.push({
          title: '因子绩效',
          content: 'HOT: ' + hotFactors.map(function(f) { return f.id; }).join(',') + ' | COLD: ' + coldFactors.map(function(f) { return f.id; }).join(','),
        });
        if (coldFactors.length > 0) {
          result.recommendations.push('考虑降权或暂停触发 COLD 因子: ' + coldFactors.map(function(f) { return f.id; }).join(','));
        }
      }
    }
  } catch (_) {}

  // 3. 美股预测准确率
  try {
    var verifyPath = path.join(DATA_DIR, 'us_as_verification_history.json');
    if (fs.existsSync(verifyPath)) {
      var vh = JSON.parse(fs.readFileSync(verifyPath, 'utf8'));
      var entries = (vh.entries || []).slice(-20);
      if (entries.length >= 5) {
        var td = 0, tc = 0;
        for (var j = 0; j < entries.length; j++) {
          td += entries[j].decisivePredictions || 0;
          tc += entries[j].correctCount || 0;
        }
        var hr = td > 0 ? Math.round(tc / td * 100) : null;
        result.sections.push({
          title: '美股→A股预测',
          content: '近20天命中率: ' + (hr != null ? hr + '%' : 'N/A') + ' (' + tc + '/' + td + ')',
        });
        if (hr != null && hr < 50) {
          result.recommendations.push('美股预测命中率偏低(' + hr + '%)，建议降低跨市场信号权重');
        }
      }
    }
  } catch (_) {}

  // 4. 网格搜索最优参数
  try {
    var dwPath = path.join(DATA_DIR, 'dynamic_weights.json');
    if (fs.existsSync(dwPath)) {
      var dw = JSON.parse(fs.readFileSync(dwPath, 'utf8'));
      if (dw.bestParams) {
        result.sections.push({
          title: '最优参数',
          content: 'lookback=' + dw.bestParams.lookbackDays + 'd, α=' + dw.bestParams.emaAlpha + ', hitRate=' + Math.round(dw.bestParams.testHitRate * 100) + '%',
        });
      }
      if (dw.weights) {
        var weights = Object.keys(dw.weights).map(function(k) { return k + ':' + (dw.weights[k] * 100).toFixed(0) + '%'; }).join(', ');
        result.sections.push({ title: '动态权重', content: weights + ' (R²=' + (dw.r2 || '?') + ')' });
      }
    }
  } catch (_) {}

  // 5. 因子组合
  try {
    var comboPath = path.join(DATA_DIR, 'factor_combinations.json');
    if (fs.existsSync(comboPath)) {
      var combos = JSON.parse(fs.readFileSync(comboPath, 'utf8'));
      if (combos.factorCombinations) {
        var fc = combos.factorCombinations;
        result.sections.push({
          title: '因子组合',
          content: '协同: ' + (fc.synergistic ? fc.synergistic.length : 0) + '对, 冲突: ' + (fc.conflicting ? fc.conflicting.length : 0) + '对',
        });
      }
    }
  } catch (_) {}

  // Save weekly report
  try {
    var reportPath = path.join(DATA_DIR, 'weekly_evo_report_' + dateStr + '.json');
    fs.writeFileSync(reportPath, JSON.stringify(result, null, 2), 'utf8');
  } catch (_) {}

  console.log('[WeeklyReport] 生成完成: ' + result.sections.length + ' 个板块, ' + result.recommendations.length + ' 条建议');
  return result;
}

// ==================== 内部 ====================

function tryRunTask(taskId, dateStr, runFn) {
  var dedupKey = taskId + '_' + dateStr;

  // Check if already run today
  for (var i = _state.history.length - 1; i >= 0; i--) {
    var entry = _state.history[i];
    if (entry.task === taskId && entry.date === dateStr) {
      return; // Already run today
    }
  }

  // Check if currently running
  if (_state.running) {
    console.log('[EvolutionScheduler] 跳过 ' + taskId + ': 已有任务 ' + _state.runningTask + ' 在运行');
    return;
  }

  _state.running = true;
  _state.runningTask = taskId;
  _state.runningProgress = { processed: 0, total: 1, message: '开始...' };

  console.log('[EvolutionScheduler] 开始: ' + taskId + ' (' + dateStr + ')');

  // v3.3.0: Timeout + retry wrapper
  var TASK_TIMEOUT_MS = (function() {
    try {
      var config = require('../config');
      return ((config.EVOLUTION && config.EVOLUTION.taskTimeoutMinutes) || 30) * 60 * 1000;
    } catch (_) { return 30 * 60 * 1000; }
  })();
  var MAX_RETRIES = 1; // 1 retry = 2 total attempts

  _executeWithRetry(taskId, dateStr, runFn, TASK_TIMEOUT_MS, 0, MAX_RETRIES);
}

/**
 * Execute a task with timeout wrapping and retry on failure.
 * v3.3.0: Prevents _state.running from getting stuck permanently.
 */
function _executeWithRetry(taskId, dateStr, runFn, timeoutMs, attempt, maxRetries) {
  var timedOut = false;

  var timeoutPromise = new Promise(function(resolve) {
    setTimeout(function() {
      timedOut = true;
      resolve({ _timeout: true });
    }, timeoutMs);
  });

  var taskResult;
  try {
    taskResult = runFn();
  } catch (e) {
    console.error('[EvolutionScheduler] ' + taskId + ' 异常 (attempt ' + (attempt + 1) + '):', e.message);
    if (attempt < maxRetries) {
      console.log('[EvolutionScheduler] ' + taskId + ' 第 ' + (attempt + 1) + ' 次尝试失败，30秒后重试...');
      setTimeout(function() {
        _executeWithRetry(taskId, dateStr, runFn, timeoutMs, attempt + 1, maxRetries);
      }, 30000);
      return;
    }
    recordTaskResult(taskId, dateStr, null, e.message);
    return;
  }

  // Handle Promise (async tasks)
  if (taskResult && typeof taskResult.then === 'function') {
    Promise.race([taskResult, timeoutPromise]).then(function(res) {
      if (timedOut || (res && res._timeout)) {
        console.error('[EvolutionScheduler] ' + taskId + ' 超时 (' + (timeoutMs / 60000) + '分钟)');
        if (attempt < maxRetries) {
          console.log('[EvolutionScheduler] ' + taskId + ' 第 ' + (attempt + 1) + ' 次尝试超时，30秒后重试...');
          setTimeout(function() {
            _executeWithRetry(taskId, dateStr, runFn, timeoutMs, attempt + 1, maxRetries);
          }, 30000);
        } else {
          recordTaskResult(taskId, dateStr, null, 'TIMEOUT after ' + (attempt + 1) + ' attempts');
        }
      } else {
        recordTaskResult(taskId, dateStr, res, null);
      }
    }).catch(function(err) {
      console.error('[EvolutionScheduler] ' + taskId + ' 错误 (attempt ' + (attempt + 1) + '):', err.message || String(err));
      if (attempt < maxRetries) {
        console.log('[EvolutionScheduler] ' + taskId + ' 第 ' + (attempt + 1) + ' 次尝试失败，30秒后重试...');
        setTimeout(function() {
          _executeWithRetry(taskId, dateStr, runFn, timeoutMs, attempt + 1, maxRetries);
        }, 30000);
      } else {
        recordTaskResult(taskId, dateStr, null, err.message || String(err));
      }
    });
  } else {
    // Synchronous result
    Promise.race([
      Promise.resolve(taskResult),
      timeoutPromise
    ]).then(function(res) {
      if (timedOut || (res && res._timeout)) {
        console.error('[EvolutionScheduler] ' + taskId + ' 超时 (' + (timeoutMs / 60000) + '分钟)');
        if (attempt < maxRetries) {
          console.log('[EvolutionScheduler] ' + taskId + ' 第 ' + (attempt + 1) + ' 次尝试超时，30秒后重试...');
          setTimeout(function() {
            _executeWithRetry(taskId, dateStr, runFn, timeoutMs, attempt + 1, maxRetries);
          }, 30000);
        } else {
          recordTaskResult(taskId, dateStr, null, 'TIMEOUT after ' + (attempt + 1) + ' attempts');
        }
      } else {
        recordTaskResult(taskId, dateStr, res, null);
      }
    });
  }
}

function recordTaskResult(taskId, dateStr, result, error) {
  // Build a meaningful summary from the result
  var summary = 'completed';
  if (error) {
    summary = 'ERROR: ' + error;
  } else if (result) {
    if (result.skipped) {
      summary = 'skipped: ' + (result.reason || 'already_running');
    } else if (result.available === false) {
      summary = result.reason || result.error || '数据不足';
    } else if (result.summary && typeof result.summary === 'string') {
      summary = result.summary;
    } else if (result.processed != null) {
      summary = 'processed=' + result.processed + ', enriched=' + (result.enriched || 0);
    } else if (result.predictions) {
      summary = result.predictions.length + ' predictions';
    } else if (result.checks) {
      summary = result.checks.length + ' checks';
    } else if (result.sections) {
      summary = result.sections.length + ' sections';
    }
  }

  var details = null;
  if (result) {
    if (result.summary && typeof result.summary === 'object') {
      details = result.summary;
    } else if (result.best && result.bestParams) {
      details = 'lookback=' + result.best.lookback + ', alpha=' + result.best.emaAlpha;
    }
  }

  var entry = {
    task: taskId,
    date: dateStr,
    time: new Date().toISOString(),
    success: !error,
    error: error || null,
    summary: summary,
    details: details,
  };

  _state.history.push(entry);
  if (_state.history.length > _state.maxHistory) {
    _state.history = _state.history.slice(-_state.maxHistory);
  }

  // Persist [v2.7.0]
  persistHistory();

  console.log('[EvolutionScheduler] 完成: ' + taskId + ' ' + (error ? 'ERROR: ' + error : 'OK'));

  _state.running = false;
  _state.runningTask = null;
  _state.runningProgress = null;
}

// ==================== [v2.7.0]: Manual trigger ====================

/**
 * 立即执行所有待执行的进化任务（调试/手动触发用）。
 * 仅在当前没有任务运行时才会启动。
 */
function runAllNow() {
  var now = new Date();
  var dateStr = now.toISOString().slice(0, 10);
  // Force a run of each task type by checking all slots
  var tasks = [
    { id: 'night_backtest', h: 2, m: 0 },
    { id: 'weight_grid_search', h: 3, m: 0 },
    { id: 'parameter_push', h: 4, m: 0 },
    { id: 'us_predict_generate', h: 5, m: 30 },
    { id: 'us_predict_verify', h: 16, m: 10 },
    { id: 'self_reflection', h: 20, m: 0 },
  ];

  // Also check if today is Saturday or Sunday
  if (now.getDay() === 6) tasks.push({ id: 'weekend_factor_mining', h: 10, m: 0 });
  if (now.getDay() === 0) tasks.push({ id: 'weekly_report', h: 14, m: 0 });

  console.log('[EvolutionScheduler] 手动触发全部 ' + tasks.length + ' 个任务');

  // Run them sequentially with a small delay to avoid overlap
  var idx = 0;
  function runNext() {
    if (idx >= tasks.length) {
      console.log('[EvolutionScheduler] 全部手动任务已开始');
      return;
    }
    var t = tasks[idx];
    // Directly call checkAndRun with a fake time
    var fakeNow = new Date(now);
    fakeNow.setHours(t.h, t.m, 0, 0);
    checkAndRun(fakeNow, dateStr);
    idx++;
    setTimeout(runNext, 2000); // 2s stagger
  }
  runNext();
}

// ==================== 状态查询 ====================

function getStatus() {
  var today = new Date().toISOString().slice(0, 10);
  var todayTasks = _state.history.filter(function(e) { return e.date === today; });

  return {
    running: _state.running,
    runningTask: _state.runningTask,
    runningProgress: _state.runningProgress,
    todayTasks: todayTasks,
    recentHistory: _state.history.slice(-20),
    schedule: [
      { time: '周日 01:00', task: 'bootstrap_history', desc: '历史数据训练引擎 [v3.1]' },
      { time: '02:00', task: 'night_backtest', desc: '夜间历史回测' },
      { time: '03:00', task: 'weight_grid_search', desc: '权重网格搜索' },
      { time: '04:00', task: 'parameter_push', desc: '参数推送验证 [v2.7]' },
      { time: '05:30', task: 'us_predict_generate', desc: '美股→A股预测生成' },
      { time: '16:10', task: 'us_predict_verify', desc: '美股→A股预测验证' },
      { time: '20:00', task: 'self_reflection', desc: '自我质疑循环' },
      { time: '周六 10:00', task: 'weekend_factor_mining', desc: '因子组合挖掘' },
      { time: '周日 14:00', task: 'weekly_report', desc: '进化周报 [v2.7]' },
      { time: '周日/周三 03:00', task: 'candidate_evaluation', desc: '候选模型步前向评估 (P1)' },
    ],
  };
}

module.exports = {
  checkAndRun,
  getStatus,
  runAllNow,
};
