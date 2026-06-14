/**
 * night_backtest.js — 夜间历史回测引擎
 *
 * 利用 K线数据 精确验证历史 Pipeline 扫描中触发的因子信号，
 * 替代 stock_predictor.js 中粗糙的 "N-th subsequent date in dailyRecords" 方式。
 *
 * 核心改进：
 *   1. 用 fetchKline() 获取真实股价序列，精确定位 N 个交易日后的收盘价
 *   2. 不只是 dailyRecords 中的股票 — K线覆盖每一只历史记录股
 *   3. 回测结果标记 backtestVerified，提升因子绩效统计的可信度
 *
 * 调度：每天 02:00 由 evolution_scheduler.js 触发
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'simfolio');
const KLINES_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'klines');
const STOCK_PERF_FILE = path.join(DATA_DIR, 'stock_factor_performance.json');
const BACKTEST_RESULT_FILE = path.join(DATA_DIR, 'night_backtest_result.json');

const FACTORS = [
  { id: 'H1', name: '缩量止跌' },
  { id: 'H2', name: '底部放量' },
  { id: 'H3', name: '逆势抗跌' },
  { id: 'H4', name: 'PE低估' },
  { id: 'H5', name: '高ROE低PB' },
  { id: 'H6', name: '现金流健康' },
  { id: 'H7', name: '低换手蓄力' },
  { id: 'H8', name: '短期反转' },
  { id: 'H9', name: '量价背离' },
];

// ==================== 状态管理 ====================

var _state = {
  running: false,
  lastRun: null,
  lastResult: null,
  error: null,
};

// ==================== 主函数 ====================

/**
 * 执行夜间回测。
 * 返回 { processed, enriched, newSamples, duration, factors: {...} }。
 */
function runNightlyBacktest(options) {
  var opts = options || {};
  var maxStocks = opts.maxStocks || 200;    // 最多回测股票数（避免跑太久）
  var lookbackDays = opts.lookbackDays || 60;
  var targetHorizons = opts.horizons || [1, 3, 5];  // T+1, T+3, T+5

  if (_state.running) {
    console.log('[NightBacktest] 已有回测在运行中，跳过');
    return { skipped: true, reason: 'already_running' };
  }

  _state.running = true;
  _state.error = null;
  var startTime = Date.now();

  console.log('[NightBacktest] 开始夜间历史回测 (maxStocks=' + maxStocks + ', lookback=' + lookbackDays + 'd)...');

  try {
    // 1. Load existing factor performance data
    var stockPerfData = loadStockPerfData();
    var dailyRecords = stockPerfData.dailyRecords || {};
    var dates = Object.keys(dailyRecords).sort();

    if (dates.length < 2) {
      _state.running = false;
      _state.lastResult = { available: false, reason: '数据不足(需要>=2天)' };
      console.log('[NightBacktest] 数据不足，跳过 (dates=' + dates.length + ')');
      return _state.lastResult;
    }

    // Only backtest the last N days
    var targetDates = dates.slice(-Math.min(lookbackDays, dates.length));

    // 2. Build a deduplicated set of (code, date) pairs to verify
    var verificationQueue = [];
    var seen = {};
    for (var di = 0; di < targetDates.length - 1; di++) {
      var date = targetDates[di];
      var records = dailyRecords[date] || [];
      for (var ri = 0; ri < records.length; ri++) {
        var rec = records[ri];
        var key = rec.code + '_' + date;
        if (!seen[key]) {
          seen[key] = true;
          verificationQueue.push({ code: rec.code, date: date, record: rec });
        }
      }
    }

    // Cap the queue
    if (verificationQueue.length > maxStocks) {
      verificationQueue = verificationQueue.slice(0, maxStocks);
    }

    console.log('[NightBacktest] 待验证: ' + verificationQueue.length + ' 个 (股票,日期) 配对');

    // 3. Fetch K-line data and compute actual future returns
    var marketData;
    try {
      marketData = require('../collectors/market_data');
    } catch (e) {
      marketData = null;
    }

    var enriched = 0;
    var newSamples = 0;
    var factorOutcomes = {};
    for (var fi = 0; fi < FACTORS.length; fi++) {
      factorOutcomes[FACTORS[fi].id] = { triggers1d: [], triggers3d: [], triggers5d: [] };
    }

    for (var qi = 0; qi < verificationQueue.length; qi++) {
      var q = verificationQueue[qi];

      // Try to get K-line data for this stock
      // MinBars: need at least fromDate + max(T+5) = 6 trading days of data
      // K-line cache typically has 6-12 bars; 60 is too strict and will always fail
      var MIN_KLINES = 6;
      var klines = null;
      if (marketData) {
        try {
          klines = marketData.fetchKlineSync
            ? marketData.fetchKlineSync(q.code, MIN_KLINES)
            : getKlinesFromCache(q.code, MIN_KLINES);
        } catch (_) {
          klines = getKlinesFromCache(q.code, MIN_KLINES);
        }
      } else {
        klines = getKlinesFromCache(q.code, MIN_KLINES);
      }

      // If cache doesn't have enough bars, try async fetchKline for more data
      if (!klines || klines.length < MIN_KLINES) {
        if (marketData && marketData.fetchKline) {
          try {
            var asyncKlines = marketData.fetchKline(q.code, 60, 'day');
            if (asyncKlines && typeof asyncKlines.then === 'function') {
              // It's a Promise — we're in sync context, can't await
              // Mark for async retry next run
            } else if (asyncKlines && asyncKlines.length >= MIN_KLINES) {
              klines = asyncKlines;
            }
          } catch (_) {}
        }
      }

      if (!klines || klines.length < MIN_KLINES) continue;

      // For each horizon, find the actual future price
      var fromPrice = q.record.price || 0;
      if (fromPrice <= 0) continue;

      var futureReturns = {};
      var allNull = true;
      for (var hi = 0; hi < targetHorizons.length; hi++) {
        var h = targetHorizons[hi];
        var futurePrice = getFutureCloseByTradingDays(klines, q.date, h);
        if (futurePrice != null && futurePrice > 0) {
          futureReturns['d' + h] = ((futurePrice - fromPrice) / fromPrice * 100);
          allNull = false;
        } else {
          futureReturns['d' + h] = null;
        }
      }

      if (allNull) continue;
      enriched++;

      // Update outcome tracking per factor
      var signals = q.record.factorSignals || [];
      for (var si = 0; si < signals.length; si++) {
        var sig = signals[si];
        var outcomes = factorOutcomes[sig.id];
        if (!outcomes) continue;

        if (futureReturns.d1 != null) {
          outcomes.triggers1d.push({ code: q.code, date: q.date, return_: +futureReturns.d1.toFixed(2) });
          newSamples++;
        }
        if (futureReturns.d3 != null) {
          outcomes.triggers3d.push({ code: q.code, date: q.date, return_: +futureReturns.d3.toFixed(2) });
          newSamples++;
        }
        if (futureReturns.d5 != null) {
          outcomes.triggers5d.push({ code: q.code, date: q.date, return_: +futureReturns.d5.toFixed(2) });
          newSamples++;
        }
      }
    }

    // 4. Compute per-factor stats
    var factorStats = [];
    for (var fj = 0; fj < FACTORS.length; fj++) {
      var f = FACTORS[fj];
      var outcomes = factorOutcomes[f.id];
      var d1Stats = computeStats(outcomes.triggers1d);
      var d3Stats = computeStats(outcomes.triggers3d);
      var d5Stats = computeStats(outcomes.triggers5d);

      var totalSamples = d5Stats.totalSamples;
      var status = 'stable';
      if (totalSamples >= 5) {
        if (d5Stats.hitRate != null && d5Stats.hitRate >= 0.55) status = 'hot';
        else if (d5Stats.hitRate != null && d5Stats.hitRate < 0.40) status = 'cold';
      }

      factorStats.push({
        id: f.id,
        name: f.name,
        perf1d: d1Stats,
        perf3d: d3Stats,
        perf5d: d5Stats,
        totalSamples: totalSamples,
        hitRate: d5Stats.hitRate,
        avgReturn: d5Stats.avgReturn,
        status: status,
      });
    }

    // 5. Save enhanced stock factor performance
    stockPerfData.backtestVerified = true;
    stockPerfData.backtestLastRun = new Date().toISOString();
    stockPerfData.backtestStats = {
      processedPairs: verificationQueue.length,
      enrichedPairs: enriched,
      newSamples: newSamples,
      horizons: targetHorizons,
      factors: factorStats,
    };
    saveStockPerfData(stockPerfData);

    // 6. Save backtest result for API
    var duration = Math.round((Date.now() - startTime) / 1000);
    var result = {
      available: true,
      date: new Date().toISOString().slice(0, 10),
      time: new Date().toISOString(),
      processed: verificationQueue.length,
      enriched: enriched,
      newSamples: newSamples,
      horizons: targetHorizons,
      durationSec: duration,
      factors: factorStats,
    };
    saveBacktestResult(result);

    _state.running = false;
    _state.lastRun = new Date().toISOString();
    _state.lastResult = result;

    console.log('[NightBacktest] 完成: processed=' + verificationQueue.length +
      ', enriched=' + enriched + ', newSamples=' + newSamples + ', duration=' + duration + 's');
    return result;

  } catch (e) {
    console.error('[NightBacktest] 错误:', e.message);
    _state.running = false;
    _state.error = e.message;
    return { available: false, error: e.message };
  }
}

/**
 * 从 K线数组中找到 fromDate 后第 tradingDays 个交易日的收盘价。
 * klines 按日期升序排列。
 */
function getFutureCloseByTradingDays(klines, fromDate, tradingDays) {
  if (!klines || klines.length === 0 || tradingDays <= 0) return null;

  // Find the index of fromDate in klines
  var fromIdx = -1;
  for (var i = 0; i < klines.length; i++) {
    if (klines[i].date === fromDate) { fromIdx = i; break; }
  }

  // If exact date not found, find the first kline on or after fromDate
  if (fromIdx < 0) {
    for (var j = 0; j < klines.length; j++) {
      if (klines[j].date >= fromDate) { fromIdx = j; break; }
    }
  }

  if (fromIdx < 0) return null;

  var targetIdx = fromIdx + tradingDays;
  if (targetIdx >= klines.length) return null;

  var target = klines[targetIdx];
  return target && target.close ? target.close : null;
}

/**
 * 从磁盘 K线缓存读取（不依赖网络）。
 */
function getKlinesFromCache(code, minBars) {
  var cacheFile = path.join(KLINES_DIR, code + '.json');
  if (!fs.existsSync(cacheFile)) return null;

  try {
    var cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    // Accept any reasonable minBars — cache typically has 6-12 daily bars
    // If caller asks for more than we have, still return what we have (best effort)
    var effectiveMin = Math.min(minBars || 5, 120);
    if (cached && cached.klines && cached.klines.length >= effectiveMin) {
      return cached.klines;
    }
    // Fallback: return cached klines even if fewer than minBars, as long as there are enough
    // for basic T+1 verification (at least 2 bars: fromDate and T+1)
    if (cached && cached.klines && cached.klines.length >= 2) {
      return cached.klines;
    }
  } catch (_) {}

  return null;
}

/**
 * 计算命中率和平均收益。
 */
function computeStats(triggers) {
  if (!triggers || triggers.length === 0) {
    return { totalSamples: 0, hitRate: null, avgReturn: null };
  }

  var returns = [];
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].return_ != null) returns.push(triggers[i].return_);
  }

  if (returns.length === 0) {
    return { totalSamples: 0, hitRate: null, avgReturn: null };
  }

  var hits = 0;
  var sum = 0;
  for (var k = 0; k < returns.length; k++) {
    sum += returns[k];
    if (returns[k] > 0) hits++;
  }

  return {
    totalSamples: returns.length,
    hitRate: +(hits / returns.length).toFixed(3),
    avgReturn: +(sum / returns.length).toFixed(2),
    bestReturn: +Math.max.apply(null, returns).toFixed(2),
    worstReturn: +Math.min.apply(null, returns).toFixed(2),
  };
}

// ==================== 持久化 ====================

function loadStockPerfData() {
  if (!fs.existsSync(STOCK_PERF_FILE)) {
    return { dailyRecords: {}, updatedAt: null };
  }
  try {
    return JSON.parse(fs.readFileSync(STOCK_PERF_FILE, 'utf8'));
  } catch (_) {
    return { dailyRecords: {}, updatedAt: null };
  }
}

function saveStockPerfData(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(STOCK_PERF_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) { /* silent */ }
}

function saveBacktestResult(result) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BACKTEST_RESULT_FILE, JSON.stringify(result, null, 2), 'utf8');
  } catch (_) { /* silent */ }
}

function loadBacktestResult() {
  if (!fs.existsSync(BACKTEST_RESULT_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(BACKTEST_RESULT_FILE, 'utf8'));
  } catch (_) { return null; }
}

function getStatus() {
  return {
    running: _state.running,
    lastRun: _state.lastRun,
    lastResult: _state.lastResult || loadBacktestResult(),
    error: _state.error,
  };
}

// ==================== Daily Light ====================

/**
 * Lightweight daily backtest: only process the last 20 days, max 50 stocks.
 * Runs at 02:00 alongside the existing full run (which processes 60 days/200 stocks).
 * This is a fast path that can be called by history_review.js if needed.
 */
function runDailyLight(options) {
  var opts = options || {};
  var maxStocks = opts.maxStocks || 50;
  var lookbackDays = opts.lookbackDays || 20;
  var targetHorizons = opts.horizons || [1, 3, 5];
  return runNightlyBacktest({ maxStocks: maxStocks, lookbackDays: lookbackDays, horizons: targetHorizons });
}

module.exports = {
  runNightlyBacktest,
  runDailyLight,
  getStatus,
  loadBacktestResult,
  getFutureCloseByTradingDays,
};
