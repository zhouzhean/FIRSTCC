/**
 * full_backtest.js — 完整多周期策略回测框架 v3.0
 *
 * 模拟 2020-2026 年完整策略执行，分市场状态独立评估。
 *
 * 核心能力：
 *   1. 多周期分批回测（适配 2 vCPU / 2 GiB）
 *   2. 7 种市场状态独立业绩统计
 *   3. 增量写入磁盘，不占用过多内存
 *   4. 复用现有 K线缓存 + 因子计算 + 评分管线
 *
 * 调度：周日 02:00 自动运行（evolution_scheduler），也可手动触发。
 */

var fs = require('fs');
var path = require('path');

var DATA_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'simfolio');
var BACKTEST_DIR = path.join(DATA_DIR, 'backtest');
var BACKTEST_RESULT_FILE = path.join(BACKTEST_DIR, 'latest_result.json');
var KLINES_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'klines');

var _state = {
  running: false,
  progress: null,
  lastResult: null,
  lastRun: null,
  error: null,
};

// ===== Main Entry =====

/**
 * @param {Object} options
 *   startYear, endYear (default: 2020-2026)
 *   batchSize (default: 30, keep low for 2 vCPU)
 *   regimes: array of regime tags to test
 */
function runFullBacktest(options) {
  options = options || {};
  var startYear = options.startYear || 2020;
  var endYear = options.endYear || 2026;
  var batchSize = options.batchSize || 30;

  if (_state.running) {
    return { skipped: true, reason: 'already_running' };
  }

  _state.running = true;
  _state.progress = { phase: 'init', pct: 0, message: '初始化回测...' };
  _state.error = null;
  var startTime = Date.now();

  console.log('[FullBacktest] 开始全周期回测...');

  try {
    // Phase 1: Discover actual available trading days from K-line cache
    _state.progress = { phase: 'scan', pct: 2, message: '扫描K线缓存...' };
    var availableDates = discoverAvailableDates();
    console.log('[FullBacktest] K线缓存可用日期: ' + availableDates.length + ' 天 (' +
      (availableDates.length > 0 ? availableDates[0] + ' ~ ' + availableDates[availableDates.length - 1] : '无') + ')');

    // If cache has usable data, use it. Otherwise fall back to generated dates.
    var trainingDays;
    var sourceNote = '';
    if (availableDates.length >= 10) {
      trainingDays = availableDates;
      sourceNote = 'based_on_kline_cache';
      console.log('[FullBacktest] 使用K线缓存实际日期');
    } else {
      trainingDays = generateTrainingDays(startYear, endYear);
      sourceNote = 'based_on_calendar_estimate';
      console.log('[FullBacktest] K线缓存不足(' + availableDates.length + '天)，使用日历生成交易日');
    }

    if (trainingDays.length < 5) {
      _state.running = false;
      _state.lastResult = { available: false, reason: '数据不足，需要至少5个交易日（缓存中仅' + trainingDays.length + '天）' };
      console.log('[FullBacktest] 数据不足，跳过');
      return _state.lastResult;
    }

    // Phase 2: Classify each day's market regime
    _state.progress = { phase: 'classify', pct: 5, message: '识别市场状态 (' + trainingDays.length + ' 天)...' };
    var regimeMap = {};
    for (var i = 0; i < trainingDays.length; i++) {
      regimeMap[trainingDays[i]] = classifyDailyRegime(trainingDays[i]);
    }

    // Phase 3: Use all available days for simulation (no artificial sampling for small datasets)
    var allDays;
    if (trainingDays.length <= 30) {
      // Small dataset: use every day
      allDays = trainingDays;
    } else {
      // Sample roughly 1 in 3 days + include last 30 days
      var sampledDays = [];
      for (i = 0; i < trainingDays.length; i += 3) {
        sampledDays.push(trainingDays[i]);
      }
      var recentDays = trainingDays.slice(-30);
      allDays = dedupArray(sampledDays.concat(recentDays)).sort();
    }

    _state.progress = { phase: 'simulate', pct: 10, message: '模拟交易 (' + allDays.length + ' 天)...' };
    console.log('[FullBacktest] 回测日: ' + allDays.length + ' 天');

    // Phase 4: Run regimes batch
    var regimeResults = {};
    var allRegimeTags = ['bull', 'bear', 'sideways', 'high_vol', 'low_liquidity', 'strong_sectors', 'other'];

    for (var r = 0; r < allRegimeTags.length; r++) {
      var regime = allRegimeTags[r];
      var regimeDays = allDays.filter(function(d) { return regimeMap[d] === regime; });
      if (regimeDays.length < 3) {
        regimeResults[regime] = { days: regimeDays.length, sampled: false, note: '样本不足（<3天），未独立统计' };
        continue;
      }
      regimeResults[regime] = simulateRegime(regime, regimeDays.slice(0, Math.min(regimeDays.length, 90)), batchSize);
      _state.progress.pct = Math.min(90, 10 + Math.round((r + 1) / allRegimeTags.length * 80));
      _state.progress.message = '已分析: ' + regimeLabels[regime] || regime;
    }

    // Phase 5: Aggregate
    _state.progress = { phase: 'aggregate', pct: 95, message: '汇总结果...' };
    var result = {
      version: 'v3.0.1-backtest-001',
      runDate: new Date().toISOString(),
      dateRange: trainingDays.length > 0 ? trainingDays[0] + ' ~ ' + trainingDays[trainingDays.length - 1] : 'N/A',
      totalDays: trainingDays.length,
      sampledDays: allDays.length,
      source: sourceNote,
      regimes: regimeResults,
      overall: aggregateRegimes(regimeResults),
      duration: Math.round((Date.now() - startTime) / 1000),
    };

    // Save
    saveResult(result);

    _state.running = false;
    _state.lastResult = result;
    _state.lastRun = new Date().toISOString();

    console.log('[FullBacktest] 完成: ' + result.totalDays + '天, ' + result.duration + 's');
    return result;

  } catch (e) {
    _state.running = false;
    _state.error = e.message;
    console.error('[FullBacktest] 错误:', e.message);
    return { error: e.message };
  }
}

// ===== Regime Simulation =====

function simulateRegime(regime, dates, batchSize) {
  var result = {
    regime: regime,
    label: regimeLabels[regime] || regime,
    days: dates.length,
    sampled: true,
    metrics: {
      totalReturn: 0,
      dailyHitRate: 0,      // % days where signal had positive E[R5d]
      avgSignalCount: 0,    // average signals per day
      signalQuality: 0,     // % of buy candidates that were profitable (forward-5d return > 0)
      volatility: 0,        // return volatility (std of daily returns)
      sharpeApprox: null,   // approximate Sharpe from daily returns
      maxDrawdown: 0,       // max drawdown during simulation
    },
    signalDetail: {},
    tradeLog: [],           // simulated trades for attribution
  };

  // Lazy-load real factor engines
  var computeHiddenSignals, computeCompositeScore;
  try {
    var hs = require('../factors/hidden_signals');
    computeHiddenSignals = hs.computeHiddenSignals;
  } catch (_) {}
  try {
    var cs = require('../factors/composite');
    computeCompositeScore = cs.computeCompositeScore || cs.computeScore;
  } catch (_) {}

  var signalHits = {};
  for (var f = 0; f < FACTORS.length; f++) {
    signalHits[FACTORS[f].id] = { hits: 0, total: 0 };
  }

  // Simulation: walk through each day, compute real signals, simulate trades
  var dailyReturns = [];
  var totalSignalHits = 0;   // count of per-factor signals that were directionally correct
  var totalSignals = 0;      // count of all per-factor signals fired
  var totalCandidates = 0;   // count of buy candidates (stock-score combos >= BUY_MIN_SCORE)
  var totalCandidateHits = 0;// count of buy candidates where fwd-5d return > 0
  var simulatedCash = 100000;
  var simulatedPositions = []; // [{ code, shares, entryPrice, entryDate }]
  var navSeries = [100000];
  var peakNav = 100000;
  var maxDD = 0;

  // Config thresholds
  var BUY_MIN_SCORE = 55;
  var STOP_LOSS_PCT = -0.08;
  var TAKE_PROFIT_PCT = 0.15;
  var MAX_POSITIONS = 5;
  var COMMISSION = 0.00025;
  var STAMP_TAX = 0.001;
  var STOP_LOSS_COOLDOWN_DAYS = 4; // Prevent re-buying same stock for 4 trading days after stop-loss

  // Track stop-loss cooldowns: { code: date_of_stop_loss }
  var stopLossCooldowns = {};

  for (var d = 0; d < dates.length; d++) {
    var date = dates[d];
    var klineSnapshot = getKlineSnapshot(date);

    if (!klineSnapshot || klineSnapshot.length < 3) continue;

    // Step 1: Update position prices, check stop-loss / take-profit
    for (var p = simulatedPositions.length - 1; p >= 0; p--) {
      var pos = simulatedPositions[p];
      var currentKline = null;
      for (var ki = 0; ki < klineSnapshot.length; ki++) {
        if (klineSnapshot[ki].code === pos.code) {
          currentKline = klineSnapshot[ki];
          break;
        }
      }
      if (!currentKline) continue;

      var currentPrice = currentKline.close;
      var pnlPct = (currentPrice - pos.entryPrice) / pos.entryPrice;

      // Check stop-loss
      if (pnlPct <= STOP_LOSS_PCT) {
        var sellAmount = pos.shares * currentPrice;
        var sellCost = sellAmount * (COMMISSION + STAMP_TAX);
        simulatedCash += sellAmount - sellCost;
        // Record stop-loss cooldown — prevent re-buying same stock too soon
        stopLossCooldowns[pos.code] = date;
        result.tradeLog.push({
          date: date, code: pos.code, action: 'sell',
          reason: 'stop_loss', entryPrice: pos.entryPrice,
          exitPrice: currentPrice, pnlPct: Math.round(pnlPct * 10000) / 100,
        });
        simulatedPositions.splice(p, 1);
      }
      // Check take-profit
      else if (pnlPct >= TAKE_PROFIT_PCT) {
        sellAmount = pos.shares * currentPrice;
        sellCost = sellAmount * (COMMISSION + STAMP_TAX);
        simulatedCash += sellAmount - sellCost;
        result.tradeLog.push({
          date: date, code: pos.code, action: 'sell',
          reason: 'take_profit', entryPrice: pos.entryPrice,
          exitPrice: currentPrice, pnlPct: Math.round(pnlPct * 10000) / 100,
        });
        simulatedPositions.splice(p, 1);
      }
    }

    // Step 2: Compute signals and scores using real factor engines
    var buyCandidates = [];
    for (var ki = 0; ki < klineSnapshot.length; ki++) {
      var k = klineSnapshot[ki];
      if (!k.close || k.close <= 0) continue;

      // Build minimal stock object for factor computation
      var stockObj = {
        code: k.code,
        name: k.code,
        price: k.close,
        peTTM: k.pe || null,
        changePercent: k.changePercent || 0,
        turnover: k.volume || 0,
      };

      var signals = [];
      var compositeScore = 0;

      // Compute real hidden signals if available
      if (computeHiddenSignals) {
        try {
          // Build kline array from cached data for this stock
          var stockKlines = getStockKlines(k.code, date);
          var hiddenResult = computeHiddenSignals(stockObj, null, stockKlines, false);
          if (hiddenResult && hiddenResult.signals) {
            signals = hiddenResult.signals;
          }
        } catch (_) {}
      }

      // Compute composite score
      if (computeCompositeScore) {
        try {
          var compositeResult = computeCompositeScore(stockObj, null, signals, {});
          // composite.js returns either a number or { compositeScore: N, ... }
          if (typeof compositeResult === 'number') {
            compositeScore = compositeResult;
          } else if (compositeResult && typeof compositeResult.compositeScore === 'number' && !isNaN(compositeResult.compositeScore)) {
            compositeScore = compositeResult.compositeScore;
          } else {
            compositeScore = 0;
          }
        } catch (_) {
          compositeScore = 0;
        }
      }

      // Fallback: estimate score from signal count if composite unavailable or NaN
      if ((!compositeScore || isNaN(compositeScore) || compositeScore <= 0) && signals.length > 0) {
        compositeScore = 40 + signals.length * 5;
      }

      // Count signals by factor type
      for (var s = 0; s < signals.length; s++) {
        var sig = signals[s];
        if (signalHits[sig.id]) {
          signalHits[sig.id].total++;
        }
      }
      totalSignals += signals.length;

      if (compositeScore >= BUY_MIN_SCORE) {
        buyCandidates.push({
          code: k.code,
          price: k.close,
          compositeScore: compositeScore,
          signals: signals,
        });
        totalCandidates++; // Track total candidates for signalQuality denominator
      }
    }

    // Step 3: Execute buys (top candidates by score, within position limits)
    buyCandidates.sort(function(a, b) { return b.compositeScore - a.compositeScore; });
    var buysToday = 0;
    var maxBuysPerDay = 2;

    for (var bc = 0; bc < buyCandidates.length && buysToday < maxBuysPerDay; bc++) {
      var c = buyCandidates[bc];

      // Skip if already holding
      var alreadyHolding = false;
      for (var ph = 0; ph < simulatedPositions.length; ph++) {
        if (simulatedPositions[ph].code === c.code) { alreadyHolding = true; break; }
      }
      if (alreadyHolding) continue;

      // Skip if in stop-loss cooldown period
      if (stopLossCooldowns[c.code]) {
        var cooldownDate = stopLossCooldowns[c.code];
        if (dateDiffTradingDays(cooldownDate, date) < STOP_LOSS_COOLDOWN_DAYS) {
          continue;
        } else {
          // Cooldown expired, clear it
          delete stopLossCooldowns[c.code];
        }
      }

      // Position limit
      if (simulatedPositions.length >= MAX_POSITIONS) break;

      // Allocation: 15% of cash for strong candidates, 10% for normal
      var allocPct = c.compositeScore >= 65 ? 0.15 : 0.10;
      var allocAmount = simulatedCash * allocPct;
      var shares = Math.floor(allocAmount / c.price / 100) * 100;
      if (shares < 100) continue;

      var buyCost = shares * c.price * (1 + COMMISSION);
      if (buyCost > simulatedCash * 0.3) continue; // max 30% per position

      simulatedCash -= buyCost;
      simulatedPositions.push({
        code: c.code,
        shares: shares,
        entryPrice: c.price,
        entryDate: date,
      });
      buysToday++;

      result.tradeLog.push({
        date: date, code: c.code, action: 'buy',
        price: c.price, shares: shares,
        score: c.compositeScore,
        signalCount: c.signals.length,
      });

      // Check forward returns for signal quality tracking
      var fwdDate = getForwardTradingDay(date, 5);
      var fwdKline = getKlineSnapshot(fwdDate);
      if (fwdKline) {
        for (var fk = 0; fk < fwdKline.length; fk++) {
          if (fwdKline[fk].code === c.code) {
            var fwdPrice = fwdKline[fk].close;
            var fwdRet = (fwdPrice - c.price) / c.price;
            // Mark all signals from this candidate
            for (var ss = 0; ss < c.signals.length; ss++) {
              var sid = c.signals[ss].id;
              if (signalHits[sid]) {
                if (fwdRet > 0) signalHits[sid].hits++;
                // Per-factor hit tracking: each signal's outcome
                totalSignalHits += (fwdRet > 0 ? 1 : 0);
                totalSignals += 1;
              }
            }
            // Candidate-level hit tracking: was this buy recommendation profitable?
            if (fwdRet > 0) totalCandidateHits++;
            break;
          }
        }
      }
    }

    // Step 4: Compute daily NAV
    var positionValue = 0;
    for (var pv = 0; pv < simulatedPositions.length; pv++) {
      var posPv = simulatedPositions[pv];
      var posPrice = posPv.entryPrice; // default to entry if no current price
      for (var kp = 0; kp < klineSnapshot.length; kp++) {
        if (klineSnapshot[kp].code === posPv.code) {
          posPrice = klineSnapshot[kp].close;
          break;
        }
      }
      positionValue += posPv.shares * posPrice;
    }

    var nav = simulatedCash + positionValue;
    navSeries.push(nav);
    if (nav > peakNav) peakNav = nav;
    var dd = (nav - peakNav) / peakNav * 100;
    if (dd < maxDD) maxDD = dd;

    if (navSeries.length >= 2) {
      var prevNav = navSeries[navSeries.length - 2];
      dailyReturns.push(prevNav > 0 ? (nav - prevNav) / prevNav : 0);
    }
  }

  // Compute final metrics
  result.metrics.totalSignals = totalSignals;
  result.metrics.boughtCandidates = totalCandidates;
  result.metrics.signalQuality = totalCandidates > 0 ? Math.round(totalCandidateHits / totalCandidates * 100) : 0;
  // Per-factor aggregate hit rate (all signals across all factors, each signal's outcome)
  result.metrics.factorHitRate = totalSignals > 0 ? Math.round(totalSignalHits / totalSignals * 100) : 0;
  result.metrics.totalReturn = navSeries.length > 1
    ? Math.round((navSeries[navSeries.length - 1] / navSeries[0] - 1) * 10000) / 100
    : 0;
  result.metrics.maxDrawdown = Math.round(maxDD * 100) / 100;
  result.metrics.tradeCount = result.tradeLog.filter(function(t) { return t.action === 'sell'; }).length;

  // Approximate Sharpe
  if (dailyReturns.length >= 10) {
    var avgRet = dailyReturns.reduce(function(a, b) { return a + b; }, 0) / dailyReturns.length;
    var retVar = dailyReturns.reduce(function(s, r) { return s + Math.pow(r - avgRet, 2); }, 0) / dailyReturns.length;
    var retStd = Math.sqrt(retVar);
    if (retStd > 0) {
      result.metrics.sharpeApprox = Math.round((avgRet / retStd) * Math.sqrt(252) * 100) / 100;
    }
    result.metrics.volatility = Math.round(retStd * Math.sqrt(252) * 10000) / 100;
  } else {
    result.metrics.volatility = 0;
  }

  // Signal detail
  for (var key in signalHits) {
    var sh = signalHits[key];
    if (sh.total > 0) {
      result.signalDetail[key] = {
        hitRate: Math.round(sh.hits / sh.total * 100),
        total: sh.total,
      };
    }
  }

  // Trim tradeLog to last 50 entries to keep result size manageable
  if (result.tradeLog.length > 50) {
    result.tradeLog = result.tradeLog.slice(-50);
  }

  return result;
}

// ===== Regime Classification =====

function classifyDailyRegime(date) {
  // Simplified regime classification based on market indicators
  // In production, this would query actual index data for that date.
  // For v3.0: use heuristic based on year and seasonal patterns.

  var parts = date.split('-');
  var year = parseInt(parts[0]);
  var month = parseInt(parts[1]);

  // Heuristic based on known A-share market phases:
  // 2020: COVID dip + recovery (Q1 bear / Q2-Q4 bull)
  // 2021: Choppy with sector rotation
  // 2022: Bear market (COVID lockdowns)
  // 2023: Sideways recovery
  // 2024: Choppy with liquidity issues
  // 2025: Sideways to slight bull
  // 2026: Sideways (current)

  if (year === 2020) {
    if (month <= 3) return 'high_vol';
    return 'bull';
  }
  if (year === 2022) {
    if (month >= 3 && month <= 5) return 'bear';
    return 'sideways';
  }
  if (year === 2024) {
    if (month >= 6 && month <= 9) return 'low_liquidity';
    return 'sideways';
  }
  if (year === 2021) return 'strong_sectors';
  if (year === 2023) return 'sideways';
  if (year >= 2025) return 'sideways';

  return 'other';
}

/**
 * Scan all K-line cache files and extract the union of all available dates.
 * This gives us the actual date range we can backtest against — much more
 * reliable than generating calendar dates that have no data.
 */
function discoverAvailableDates() {
  try {
    if (!fs.existsSync(KLINES_DIR)) return [];
    var files = fs.readdirSync(KLINES_DIR).filter(function(f) { return f.endsWith('.json'); });
    if (files.length === 0) return [];

    var dateSet = {};
    var readCount = 0;
    for (var i = 0; i < files.length; i++) {
      try {
        var data = JSON.parse(fs.readFileSync(path.join(KLINES_DIR, files[i]), 'utf8'));
        if (data && data.klines) {
          for (var k = 0; k < data.klines.length; k++) {
            var d = data.klines[k].date;
            if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
              dateSet[d] = true;
            }
          }
        }
        readCount++;
      } catch (_) {}
    }
    console.log('[FullBacktest] 扫描了 ' + readCount + '/' + files.length + ' 个K线文件, 发现 ' + Object.keys(dateSet).length + ' 个唯一日期');
    return Object.keys(dateSet).sort();
  } catch (_) { return []; }
}

// ===== Helpers =====

var regimeLabels = {
  'bull': '牛市',
  'bear': '熊市',
  'sideways': '震荡市',
  'high_vol': '高波动市场',
  'low_liquidity': '低流动性市场',
  'strong_sectors': '行业轮动行情',
  'other': '其他',
};

var FACTORS = [
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

function generateTrainingDays(startYear, endYear) {
  var days = [];
  for (var y = startYear; y <= endYear; y++) {
    for (var m = 1; m <= 12; m++) {
      var daysInMonth = new Date(y, m, 0).getDate();
      for (var d = 1; d <= daysInMonth; d++) {
        var date = new Date(y, m - 1, d);
        var dayOfWeek = date.getDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) continue; // Skip weekends
        var dateStr = y + '-' + (m < 10 ? '0' + m : m) + '-' + (d < 10 ? '0' + d : d);

        // Skip known holidays (simplified — lunar new year, national day, etc.)
        if (isHoliday(dateStr)) continue;

        days.push(dateStr);
      }
    }
  }
  return days;
}

function isHoliday(dateStr) {
  // Simplified holiday check for major Chinese holidays
  var m = parseInt(dateStr.split('-')[1]);
  var d = parseInt(dateStr.split('-')[2]);

  // Spring Festival (approximate: late Jan / early Feb)
  if ((m === 1 && d >= 24) || (m === 2 && d <= 10)) {
    // Check day of week — if it falls Mon-Fri, it's a trading holiday
    var date = new Date(dateStr + 'T12:00:00+08:00');
    var dow = date.getDay();
    if (dow >= 1 && dow <= 5) return true; // This is too broad but fine for approximate backtest
  }
  // National Day (Oct 1-7)
  if (m === 10 && d >= 1 && d <= 7) return true;
  // Labor Day (May 1-3)
  if (m === 5 && d >= 1 && d <= 3) return true;

  return false;
}

function getKlineSnapshot(date) {
  // Load K-line cache for given date. In full implementation,
  // this would query per-stock K-lines. For v3.0, we load
  // whatever is in the cache for a representative set.
  try {
    if (!fs.existsSync(KLINES_DIR)) return null;
    var files = fs.readdirSync(KLINES_DIR).filter(function(f) { return f.endsWith('.json'); });
    if (files.length === 0) return null;

    var snapshot = [];
    for (var i = 0; i < Math.min(files.length, 50); i++) {
      try {
        var data = JSON.parse(fs.readFileSync(path.join(KLINES_DIR, files[i]), 'utf8'));
        var code = files[i].replace('.json', '');
        if (data && data.klines) {
          for (var k = 0; k < data.klines.length; k++) {
            if (data.klines[k].date === date) {
              snapshot.push({
                code: code,
                close: data.klines[k].close,
                volume: data.klines[k].volume || 0,
              });
              break;
            }
          }
        }
      } catch (_) {}
    }
    return snapshot.length > 0 ? snapshot : null;
  } catch (_) { return null; }
}

function klineIdx(klineSnapshot, code) {
  for (var i = 0; i < klineSnapshot.length; i++) {
    if (klineSnapshot[i].code === code) return i;
  }
  return -1;
}

/**
 * Count trading days between two date strings (inclusive of start, exclusive of end).
 * Used for stop-loss cooldown logic.
 */
function dateDiffTradingDays(fromDate, toDate) {
  var d = new Date(fromDate + 'T12:00:00+08:00');
  d.setDate(d.getDate() + 1); // Start counting from next day
  var count = 0;
  var end = new Date(toDate + 'T12:00:00+08:00');
  while (d <= end) {
    var dow = d.getDay();
    if (dow !== 0 && dow !== 6 && !isHoliday(d.toISOString().slice(0, 10))) {
      count++;
    }
    d.setDate(d.getDate() + 1);
  }
  return count;
}

function getForwardTradingDay(date, n) {
  var d = new Date(date + 'T12:00:00+08:00');
  var count = 0;
  while (count < n) {
    d.setDate(d.getDate() + 1);
    var dow = d.getDay();
    if (dow !== 0 && dow !== 6 && !isHoliday(d.toISOString().slice(0, 10))) {
      count++;
    }
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Load per-stock K-line data from cache for a specific cutoff date.
 * Returns an array of kline objects up to (and including) the given date.
 */
function getStockKlines(code, cutoffDate) {
  try {
    var klineFile = path.join(KLINES_DIR, code + '.json');
    if (!fs.existsSync(klineFile)) return null;
    var data = JSON.parse(fs.readFileSync(klineFile, 'utf8'));
    if (!data || !data.klines || data.klines.length === 0) return null;

    // Return all klines on or before cutoffDate
    return data.klines.filter(function(k) {
      return k.date <= cutoffDate;
    });
  } catch (_) {
    return null;
  }
}

function aggregateRegimes(regimeResults) {
  var agg = {
    totalDays: 0,
    sampledDays: 0,
    regimeCount: 0,
    regimesWithReturn: {},
    avgSignalQuality: 0,
    worstRegime: null,
    bestRegime: null,
  };

  var qualitySum = 0;
  var count = 0;

  for (var key in regimeResults) {
    var rr = regimeResults[key];
    if (rr.sampled) {
      agg.sampledDays += rr.days;
      agg.totalDays += rr.days;
      count++;
      if (rr.metrics && rr.metrics.signalQuality != null) {
        qualitySum += rr.metrics.signalQuality;
      }
      // Track per-regime return for comparison
      var ret = rr.metrics ? (rr.metrics.totalReturn || 0) : 0;
      agg.regimesWithReturn[key] = {
        label: rr.label || key,
        days: rr.days,
        totalReturn: ret,
        tradeCount: rr.metrics ? (rr.metrics.tradeCount || 0) : 0,
        signalQuality: rr.metrics ? (rr.metrics.signalQuality || 0) : 0,
      };
      // Track best/worst regime
      if (!agg.bestRegime || ret > agg.bestRegime.totalReturn) {
        agg.bestRegime = { regime: key, label: rr.label, totalReturn: ret };
      }
      if (!agg.worstRegime || ret < agg.worstRegime.totalReturn) {
        agg.worstRegime = { regime: key, label: rr.label, totalReturn: ret };
      }
    }
  }

  if (count > 0) {
    agg.avgSignalQuality = Math.round(qualitySum / count);
    agg.regimeCount = count;
  }

  return agg;
}

function dedupArray(arr) {
  var seen = {};
  return arr.filter(function(x) {
    if (seen[x]) return false;
    seen[x] = true;
    return true;
  });
}

// ===== Save/Load =====

function saveResult(result) {
  try {
    if (!fs.existsSync(BACKTEST_DIR)) fs.mkdirSync(BACKTEST_DIR, { recursive: true });
    fs.writeFileSync(BACKTEST_RESULT_FILE, JSON.stringify(result, null, 2), 'utf8');
    console.log('[FullBacktest] 结果已保存');
  } catch (e) {
    console.error('[FullBacktest] 保存失败:', e.message);
  }
}

function getStatus() {
  return {
    running: _state.running,
    progress: _state.progress,
    lastRun: _state.lastRun,
    lastResult: _state.lastResult ? {
      dateRange: _state.lastResult.dateRange,
      totalDays: _state.lastResult.totalDays,
      regimes: Object.keys(_state.lastResult.regimes || {}),
      duration: _state.lastResult.duration,
    } : null,
    error: _state.error,
  };
}

function getLatestResult() {
  if (_state.lastResult) return _state.lastResult;
  if (fs.existsSync(BACKTEST_RESULT_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(BACKTEST_RESULT_FILE, 'utf8'));
    } catch (_) {}
  }
  return { available: false, reason: '尚无回测结果，请手动触发 /api/backtest/run 或等待周日自动运行' };
}

// ===== Weekly Automatic Run =====

function runWeeklyBacktest() {
  console.log('[FullBacktest] 周日定时回测启动...');
  return runFullBacktest({ startYear: 2020, endYear: 2026, batchSize: 30 });
}

module.exports = {
  runFullBacktest,
  runWeeklyBacktest,
  getStatus,
  getLatestResult,
};
