/**
 * P0-3: Rolling Out-of-Sample Evaluation (Portfolio-Level Statistics)
 *
 * Evaluates fixed rule-based models on expanding OOS windows.
 * THIS IS NOT TRUE WALK-FORWARD — no model parameters are learned from training data.
 * See true_walk_forward.js for the learnable version (P1).
 *
 * P0-3 upgrades:
 *  — Full time-series portfolio comparison via compareFullTimeSeries()
 *  — Block bootstrap (≥200 per window) for random baseline
 *  — NO daily p-value averaging. NO significantFraction.
 *  — Uses trade_simulator (P0-2) for portfolio NAV, true drawdown, turnover
 *  — Output: dailyDetails (diagnostic only), per-model portfolio comparison
 *
 * Output: report-engine/data/research/oos_evaluation_results/
 */

var fs = require('fs');
var path = require('path');

var CALENDAR = require('./universal_calendar');
var UNIVERSE = require('./universe_definition');
var BASELINES = require('./baseline_models');
var SIMULATOR = require('./trade_simulator');

var SNAPSHOTS_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'research', 'snapshots');
var RESULTS_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'research', 'oos_evaluation_results');

var WINDOW_STEP_TRADING_DAYS = 60;
var TOP_N = 50;

// ---- Snapshot Loading ----

function loadSnapshotsForDate(dateStr) {
  var fp = path.join(SNAPSHOTS_DIR, dateStr + '.jsonl');
  if (!fs.existsSync(fp)) return { map: {}, list: [] };

  var map = {};
  var list = [];
  try {
    var lines = fs.readFileSync(fp, 'utf8').trim().split('\n');
    lines.forEach(function (line) {
      if (!line) return;
      try {
        var r = JSON.parse(line);
        map[r.code] = r;
        list.push(r);
      } catch (e) { /* skip */ }
    });
  } catch (e) { /* file read error */ }
  return { map: map, list: list };
}

// ---- Window Generation ----

function generateWindows(options) {
  var opts = options || {};
  var startDate = opts.startDate || '2023-10-30';
  var endDate = opts.endDate || '2026-06-15';
  var includePreStable = opts.includePreStable || false;

  var tradingDays = CALENDAR.loadCalendar();
  var stableStart = UNIVERSE.getStableStartDate();

  var allDays = [];
  for (var i = 0; i < tradingDays.length; i++) {
    if (tradingDays[i] >= startDate && tradingDays[i] <= endDate) {
      allDays.push(tradingDays[i]);
    }
  }

  if (allDays.length < 252) {
    return { error: 'insufficient_data', totalDays: allDays.length };
  }

  var windows = [];
  var cursor = 252;
  var validateSize = 20;
  var testSize = 60;

  while (cursor + validateSize + testSize <= allDays.length) {
    var testDates = allDays.slice(cursor + validateSize, cursor + validateSize + testSize);
    var isPreStableWindow = false;
    if (!includePreStable && stableStart) {
      isPreStableWindow = testDates[0] < stableStart;
    }

    windows.push({
      trainDates: allDays.slice(0, cursor),
      validateDates: allDays.slice(cursor, cursor + validateSize),
      testDates: testDates,
      isPreStable: isPreStableWindow,
      explorationOnly: isPreStableWindow,
    });
    cursor += WINDOW_STEP_TRADING_DAYS;
  }

  var allWindows = windows;
  if (!includePreStable) {
    windows = windows.filter(function (w) { return !w.isPreStable; });
  }

  return { windows: windows, allWindows: allWindows, tradingDays: allDays, allDaysCount: allDays.length, stableStart: stableStart };
}

// ---- Single Window Evaluation (P0-3: Portfolio-level comparison) ----

function evaluateWindow(windowDef, klineIdx, bootstrapSamples) {
  bootstrapSamples = bootstrapSamples || 200;
  var testDates = windowDef.testDates;
  var result = {
    window: {
      trainStart: windowDef.trainDates[0],
      trainEnd: windowDef.trainDates[windowDef.trainDates.length - 1],
      trainDays: windowDef.trainDates.length,
      validateStart: windowDef.validateDates[0],
      validateEnd: windowDef.validateDates[windowDef.validateDates.length - 1],
      validateDays: windowDef.validateDates.length,
      testStart: testDates[0],
      testEnd: testDates[testDates.length - 1],
      testDays: testDates.length,
      isPreStable: windowDef.isPreStable || false,
      explorationOnly: windowDef.explorationOnly || false,
    },
    models: {},
    dailyDetails: [],
  };

  var snapshotsByDate = {};
  var prev20MapByDate = {};
  // P0.2: Track per-date tradable/exclusion stats
  var totalStocksAcrossWindow = 0;
  var totalTradableAcrossWindow = 0;
  var totalExcludedAcrossWindow = 0;
  var exclusionReasonsAcrossWindow = {};
  testDates.forEach(function (testDate) {
    var snapRes = loadSnapshotsForDate(testDate);
    if (Object.keys(snapRes.map).length >= 10) {
      snapshotsByDate[testDate] = snapRes;
      totalStocksAcrossWindow += snapRes.list.length;
      // P0.2: Count tradable vs excluded
      for (var si = 0; si < snapRes.list.length; si++) {
        var s = snapRes.list[si];
        if (s.forwardStatus === 'settled') {
          totalTradableAcrossWindow++;
        } else {
          totalExcludedAcrossWindow++;
          var reason = s.unavailableReason || 'unknown';
          exclusionReasonsAcrossWindow[reason] = (exclusionReasonsAcrossWindow[reason] || 0) + 1;
        }
      }
    }
    var prev20Date = CALENDAR.getTradingDay(testDate, -20);
    if (prev20Date) {
      var prevRes = loadSnapshotsForDate(prev20Date);
      if (Object.keys(prevRes.map).length > 0) {
        prev20MapByDate[testDate] = prevRes;
      }
    }
  });

  if (Object.keys(snapshotsByDate).length === 0) {
    result.error = 'no_valid_dates_in_window';
    return result;
  }

  // P0.2: Attach coverage stats to window result
  result.coverageStats = {
    totalStocksAcrossWindow: totalStocksAcrossWindow,
    tradableCount: totalTradableAcrossWindow,
    excludedCount: totalExcludedAcrossWindow,
    tradableRate: totalStocksAcrossWindow > 0
      ? Math.round(totalTradableAcrossWindow / totalStocksAcrossWindow * 10000) / 100
      : 0,
    exclusionReasons: exclusionReasonsAcrossWindow,
    testDatesWithSnapshots: Object.keys(snapshotsByDate).length,
    testDatesTotal: testDates.length,
  };

  // Collect per-date details (diagnostic only, no p-values)
  var dates = Object.keys(snapshotsByDate).sort();
  dates.forEach(function (testDate) {
    var snapRes = snapshotsByDate[testDate];
    var prevRes = prev20MapByDate[testDate] || { map: {} };
    try {
      var comparison = BASELINES.compareAllModels(snapRes.map, snapRes.list, prevRes.map);
      comparison.date = testDate;
      result.dailyDetails.push(comparison);
    } catch (e) {
      result.dailyDetails.push({ date: testDate, error: e.message });
    }
  });

  // Overlap summary
  var overlaps = result.dailyDetails
    .map(function (d) { return d.overlap; })
    .filter(function (o) { return o && o.overlapPct != null; });
  if (overlaps.length > 0) {
    result.overlapSummary = {
      avgOverlapPct: Math.round(overlaps.reduce(function (s, o) { return s + o.overlapPct; }, 0) / overlaps.length),
    };
  }

  // P0-3: Full time-series portfolio comparison per model
  var modelNames = ['composite', 'technicalOnly', 'momentum'];

  modelNames.forEach(function (mk) {
    try {
      var comparison = BASELINES.compareFullTimeSeries(
        mk, snapshotsByDate, prev20MapByDate, klineIdx, bootstrapSamples
      );
      // P0.1: Enrich modelPortfolio with explicit per-field naming and simulator metadata
      if (comparison && comparison.modelPortfolio) {
        var mp = comparison.modelPortfolio;
        // P0.1: Map to explicit strategy/benchmark names so UI never conflates net with excess
        mp.strategyNetReturn    = mp.netReturn;
        mp.strategyGrossReturn  = mp.grossReturn;
        mp.benchmarkNetReturn   = mp.benchmarkReturn;  // benchmark has no cost, so net=gross
        mp.benchmarkGrossReturn = mp.benchmarkReturn;
        mp.netExcessReturn      = mp.netExcessReturn;  // strategyNet - benchmarkNet; null when benchmark unavailable
        // P0.2 CONDITIONAL T1: benchmarkStatus=available ONLY when benchmarkTradeCount>0 AND benchmarkUnavailableCount is defined
        mp.benchmarkStatus      = (mp.benchmarkTradeCount > 0 && mp.benchmarkUnavailableCount != null) ? 'available' : 'unavailable';
        mp.benchmarkSource      = 'sh_index_same_path';
        mp.benchmarkTradeCount  = mp.benchmarkTradeCount != null ? mp.benchmarkTradeCount : null;
        mp.benchmarkUnavailableCount = mp.benchmarkUnavailableCount != null ? mp.benchmarkUnavailableCount : null;
        mp.topPoolSize          = 50;                   // TOP_N per cohort
        mp.numSleeves           = 3;
        mp.maxPositionsPerSleeve= 17;
        mp.maxConcurrentPositions = 150;
        // P0.1: Pull turnover and cost from simulator output
        // These come from the modelResult inside comparison (raw simulator output)
      }
      // Also capture simulator-level metrics if available via internal result
      result.models[mk] = comparison;
    } catch (e) {
      result.models[mk] = { error: e.message };
    }
  });

  return result;
}

// ---- Main Entry ----

function runRollingOOS(options) {
  var opts = options || {};
  opts.startDate = opts.startDate || '2023-10-30';
  opts.endDate = opts.endDate || '2026-06-15';

  console.log('=== P0-3: Rolling Out-of-Sample Evaluation (Portfolio-Level) ===');
  console.log('Range: ' + opts.startDate + ' to ' + opts.endDate);
  console.log('Stable start: ' + (UNIVERSE.getStableStartDate() || 'N/A'));
  console.log('Include pre-stable: ' + (opts.includePreStable ? 'YES (exploration only)' : 'no'));
  console.log('Bootstrap samples: ' + (opts.bootstrapSamples || 200) + ' (per window)');
  console.log('NOTE: Statistical significance via full time-series comparison. No daily p-value averaging.');
  console.log();

  var winResult = generateWindows(opts);
  if (winResult.error) {
    console.error('Error: ' + winResult.error);
    return winResult;
  }

  var windows = winResult.windows;
  console.log('All days in range: ' + winResult.allDaysCount);
  console.log('Windows: ' + windows.length + ' (filtered from ' + winResult.allWindows.length + ')');
  console.log('First window test: ' + windows[0].testDates[0] + ' to ' + windows[0].testDates[windows[0].testDates.length - 1]);
  if (windows.length > 1) {
    console.log('Last window test:  ' + windows[windows.length - 1].testDates[0] + ' to ' + windows[windows.length - 1].testDates[windows[windows.length - 1].testDates.length - 1]);
  }

  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

  // Load kline index once for all windows
  console.log('Loading kline index...');
  var klineIdx = SIMULATOR.loadKlineIndex();
  console.log('Kline index: ' + Object.keys(klineIdx).length + ' stocks');

  var summary = {
    generatedAt: new Date().toISOString(),
    mode: 'expanding',
    windowCount: windows.length,
    windowStep: WINDOW_STEP_TRADING_DAYS,
    labelConvention: 'T_close_signal__T+1_open_entry__T+4_close_exit__3day_hold',
    horizon: 'T+1 open to T+4 close (P0-1)',
    simulatorVersion: 'P0-2 (3-sleeve equal-weight overlapping cohorts)',
    statisticsVersion: 'P0.2 (random-portfolio Monte Carlo, Laplace-smoothed p-value, paired delta CI)',
    topN: TOP_N,
    dateRange: { start: opts.startDate, end: opts.endDate },
    stableStart: UNIVERSE.getStableStartDate(),
    universe: UNIVERSE.getUniverseMetadata(),
    windows: [],
  };

  windows.forEach(function (w, wi) {
    console.log('Window ' + (wi + 1) + '/' + windows.length + ' — test: ' + w.testDates[0] + ' to ' + w.testDates[w.testDates.length - 1]);
    var result = evaluateWindow(w, klineIdx, opts.bootstrapSamples || 200);
    summary.windows.push(result);

    fs.writeFileSync(
      path.join(RESULTS_DIR, 'window_' + String(wi + 1).padStart(3, '0') + '.json'),
      JSON.stringify(result, null, 2), 'utf8'
    );
  });

  // P0-3: Aggregate — portfolio-level metrics per model (no daily averaging)
  var modelNames = ['composite', 'technicalOnly', 'momentum'];
  modelNames.forEach(function (mk) {
    var validWindows = summary.windows.filter(function (w) {
      return w.models[mk] && !w.models[mk].error && w.models[mk].modelPortfolio;
    });
    if (validWindows.length === 0) { summary[mk + 'Summary'] = { validWindows: 0 }; return; }

    var portfolios = validWindows.map(function (w) { return w.models[mk].modelPortfolio; });
    var comparisons = validWindows.map(function (w) { return w.models[mk].comparison; }).filter(function (c) { return c; });

    summary[mk + 'Summary'] = {
      validWindows: validWindows.length,
      // P0.1: Strategy returns
      avgStrategyNetReturn: Math.round(portfolios.reduce(function (s, p) { return s + (p.strategyNetReturn || p.netReturn || 0); }, 0) / portfolios.length * 100) / 100,
      avgStrategyGrossReturn: Math.round(portfolios.reduce(function (s, p) { return s + (p.strategyGrossReturn || p.grossReturn || 0); }, 0) / portfolios.length * 100) / 100,
      // P0.1: Benchmark returns (same-path)
      avgBenchmarkNetReturn: Math.round(portfolios.reduce(function (s, p) { return s + (p.benchmarkNetReturn || p.benchmarkReturn || 0); }, 0) / portfolios.length * 100) / 100,
      avgBenchmarkGrossReturn: Math.round(portfolios.reduce(function (s, p) { return s + (p.benchmarkGrossReturn || p.benchmarkReturn || 0); }, 0) / portfolios.length * 100) / 100,
      // P0.1: Net excess (strategyNet - benchmarkNet)
      avgNetExcess: Math.round(portfolios.reduce(function (s, p) { return s + (p.netExcessReturn || 0); }, 0) / portfolios.length * 100) / 100,
      // Legacy compat (kept for older consumers)
      avgNetReturn: Math.round(portfolios.reduce(function (s, p) { return s + (p.netReturn || 0); }, 0) / portfolios.length * 100) / 100,
      avgGrossReturn: Math.round(portfolios.reduce(function (s, p) { return s + (p.grossReturn || 0); }, 0) / portfolios.length * 100) / 100,
      avgMaxDrawdownBps: Math.round(portfolios.reduce(function (s, p) { return s + (p.maxDrawdownBps || 0); }, 0) / portfolios.length * 100) / 100,
      avgSharpe: portfolios.filter(function (p) { return p.sharpeRatio != null; }).length > 0
        ? Math.round(portfolios.reduce(function (s, p) { return s + (p.sharpeRatio || 0); }, 0) / portfolios.length * 100) / 100
        : null,
      avgCoverage: Math.round(portfolios.reduce(function (s, p) { return s + (p.coverageRate || 0); }, 0) / portfolios.length * 100) / 100,
      totalExecutedTrades: portfolios.reduce(function (s, p) { return s + (p.executedTrades || 0); }, 0),
      avgTotalTurnover: Math.round(portfolios.reduce(function (s, p) { return s + (p.totalTurnover || 0); }, 0) / portfolios.length * 100) / 100,
    };

    if (comparisons.length > 0) {
      summary[mk + 'Summary'].vsRandom = {
        avgNetReturnDelta: Math.round(comparisons.reduce(function (s, c) { return s + (c.netReturnDelta || 0); }, 0) / comparisons.length * 100) / 100,
        avgNetExcessDelta: Math.round(comparisons.reduce(function (s, c) { return s + (c.netExcessDelta || 0); }, 0) / comparisons.length * 100) / 100,
        significantWindows: comparisons.filter(function (c) { return c.significant; }).length,
        _note: 'P0.2: significance via full time-series comparison with Laplace smoothing, NOT daily p-value averaging',
      };
    }
  });

  var summaryPath = path.join(RESULTS_DIR, 'rolling_oos_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log('\nSummary written to ' + summaryPath);

  return summary;
}

// ---- CLI ----

if (require.main === module) {
  var startDate = process.argv[2] || '2023-10-30';
  var endDate = process.argv[3] || '2026-06-15';
  var includePreStable = process.argv[4] === '--include-pre-stable';

  var result = runRollingOOS({
    startDate: startDate,
    endDate: endDate,
    includePreStable: includePreStable,
  });

  if (!result || result.error) {
    console.error('Evaluation failed: ' + (result ? result.error : 'unknown'));
    process.exit(1);
  }

  console.log('\n=== Summary ===');
  console.log('Windows: ' + result.windowCount);
  ['composite', 'technicalOnly', 'momentum'].forEach(function (m) {
    var s = result[m + 'Summary'] || {};
    console.log(m + ': ' + (s.validWindows || 0) + ' windows' +
      (s.avgNetReturn != null ? ' | netReturn=' + s.avgNetReturn + '%' : '') +
      (s.avgNetExcess != null ? ' | netExcess=' + s.avgNetExcess + '%' : '') +
      (s.avgCoverage != null ? ' | coverage=' + s.avgCoverage + '%' : ''));
    if (s.vsRandom) {
      console.log('  vs Random: delta=' + s.vsRandom.avgNetReturnDelta +
        ' significantWindows=' + s.vsRandom.significantWindows + '/' + s.validWindows);
    }
  });
}

module.exports = { runRollingOOS, evaluateWindow, generateWindows, loadSnapshotsForDate };
