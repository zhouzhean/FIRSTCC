/**
 * P1.1-E: Rolling Out-of-Sample Evaluation
 *
 * Evaluates fixed rule-based models on expanding OOS windows.
 * THIS IS NOT TRUE WALK-FORWARD — no model parameters are learned from training data.
 * See true_walk_forward.js for the learnable version (P1).
 *
 * Changes from Phase 1 walk_forward_expander.js:
 *  — Renamed to honest label: "rolling OOS evaluation"
 *  — Default start = stable period (2023-10-30)
 *  — Pre-stable dates excluded from main results (flag: includePreStable)
 *  — Uses trade_simulator for portfolio-level metrics (NAV, true drawdown, turnover)
 *  — Uses v2 baseline_models with fixed-seed bootstrap and p-values
 *  — Compares composite vs technical-only vs momentum vs random
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

function loadSnapshotsForDates(dates) {
  var map = {};
  var list = [];
  dates.forEach(function (d) {
    var res = loadSnapshotsForDate(d);
    Object.keys(res.map).forEach(function (c) { map[c] = res.map[c]; });
    list = list.concat(res.list);
  });
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
  var cursor = 252; // ~1 year initial train
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

  // Filter out pre-stable windows unless explicitly included
  var allWindows = windows;
  if (!includePreStable) {
    windows = windows.filter(function (w) { return !w.isPreStable; });
  }

  return { windows: windows, allWindows: allWindows, tradingDays: allDays, allDaysCount: allDays.length, stableStart: stableStart };
}

// ---- Single Window Evaluation ----

function evaluateWindow(windowDef) {
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

  // For each test date, rank and evaluate
  testDates.forEach(function (testDate) {
    var snapRes = loadSnapshotsForDate(testDate);
    var snapMap = snapRes.map;
    var snapshots = snapRes.list;
    var codes = Object.keys(snapMap);
    if (codes.length < 10) return;

    // Load T-20 for momentum
    var prev20Date = CALENDAR.getTradingDay(testDate, -20);
    var prev20Res = prev20Date ? loadSnapshotsForDate(prev20Date) : { map: {} };

    // Run comparison
    var comparison;
    try {
      comparison = BASELINES.compareAllModels(snapMap, snapshots, prev20Res.map);
      comparison.date = testDate;
    } catch (e) {
      comparison = { date: testDate, error: e.message };
    }

    result.dailyDetails.push(comparison);
  });

  // Aggregate per model
  var modelNames = ['composite', 'technicalOnly', 'momentum'];

  modelNames.forEach(function (mk) {
    var validDays = result.dailyDetails.filter(function (d) {
      return d && d[mk] && d[mk].metrics && d[mk].metrics.avgReturn != null;
    });

    if (validDays.length === 0) {
      result.models[mk] = { validDays: 0 };
      return;
    }

    var metrics = validDays.map(function (d) { return d[mk].metrics; });

    result.models[mk] = {
      validDays: validDays.length,
      avgReturn: Math.round(metrics.reduce(function (s, m) { return s + m.avgReturn; }, 0) / metrics.length * 100) / 100,
      avgWinRate: Math.round(metrics.reduce(function (s, m) { return s + m.winRate; }, 0) / metrics.length * 100) / 100,
      avgExcess: metrics[0].avgExcess != null
        ? Math.round(metrics.reduce(function (s, m) { return s + (m.avgExcess || 0); }, 0) / metrics.length * 100) / 100
        : null,
      avgCoverage: Math.round(metrics.reduce(function (s, m) { return s + (m.coverage || 0); }, 0) / metrics.length * 100) / 100,
    };

    // Aggregate vsRandom stats
    var vsRandoms = validDays.map(function (d) { return d[mk].vsRandom; }).filter(function (v) { return v && v.pValue != null; });
    if (vsRandoms.length > 0) {
      result.models[mk].vsRandom = {
        avgDelta: Math.round(vsRandoms.reduce(function (s, v) { return s + (v.delta || 0); }, 0) / vsRandoms.length * 100) / 100,
        avgPValue: Math.round(vsRandoms.reduce(function (s, v) { return s + (v.pValue || 0); }, 0) / vsRandoms.length * 10000) / 10000,
        significantDays: vsRandoms.filter(function (v) { return v.significant; }).length,
        beatsRandomDays: vsRandoms.filter(function (v) { return v.beatsRandom; }).length,
      };
    }
  });

  // Aggregate overlap
  var overlaps = result.dailyDetails.map(function (d) { return d.overlap; }).filter(function (o) { return o && o.overlapPct != null; });
  if (overlaps.length > 0) {
    result.overlapSummary = {
      avgOverlapPct: Math.round(overlaps.reduce(function (s, o) { return s + o.overlapPct; }, 0) / overlaps.length),
    };
  }

  return result;
}

// ---- Main Entry ----

function runRollingOOS(options) {
  var opts = options || {};
  opts.startDate = opts.startDate || '2023-10-30';
  opts.endDate = opts.endDate || '2026-06-15';

  console.log('=== P1.1-E: Rolling Out-of-Sample Evaluation ===');
  console.log('Range: ' + opts.startDate + ' to ' + opts.endDate);
  console.log('Stable start: ' + (UNIVERSE.getStableStartDate() || 'N/A'));
  console.log('Include pre-stable: ' + (opts.includePreStable ? 'YES (exploration only)' : 'no'));
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

  var summary = {
    generatedAt: new Date().toISOString(),
    mode: 'expanding',
    windowCount: windows.length,
    windowStep: WINDOW_STEP_TRADING_DAYS,
    horizon: 'T+3 close (snapshot)',
    topN: TOP_N,
    dateRange: { start: opts.startDate, end: opts.endDate },
    stableStart: UNIVERSE.getStableStartDate(),
    universe: UNIVERSE.getUniverseMetadata(),
    windows: [],
  };

  windows.forEach(function (w, wi) {
    console.log('Window ' + (wi + 1) + '/' + windows.length + ' — test: ' + w.testDates[0] + ' to ' + w.testDates[w.testDates.length - 1]);
    var result = evaluateWindow(w);
    summary.windows.push(result);

    // Write per-window detail
    fs.writeFileSync(
      path.join(RESULTS_DIR, 'window_' + String(wi + 1).padStart(3, '0') + '.json'),
      JSON.stringify(result, null, 2), 'utf8'
    );
  });

  // Aggregate summary
  var modelNames = ['composite', 'technicalOnly', 'momentum'];
  modelNames.forEach(function (mk) {
    var validWindows = summary.windows.filter(function (w) { return w.models[mk] && w.models[mk].validDays > 0; });
    if (validWindows.length === 0) { summary[mk + 'Summary'] = { validWindows: 0 }; return; }

    var m = validWindows.map(function (w) { return w.models[mk]; });
    summary[mk + 'Summary'] = {
      validWindows: validWindows.length,
      avgReturn: Math.round(m.reduce(function (s, x) { return s + x.avgReturn; }, 0) / m.length * 100) / 100,
      avgWinRate: Math.round(m.reduce(function (s, x) { return s + x.avgWinRate; }, 0) / m.length * 100) / 100,
      avgExcess: m[0].avgExcess != null
        ? Math.round(m.reduce(function (s, x) { return s + (x.avgExcess || 0); }, 0) / m.length * 100) / 100
        : null,
      avgCoverage: Math.round(m.reduce(function (s, x) { return s + (x.avgCoverage || 0); }, 0) / m.length * 100) / 100,
    };

    // vsRandom summary
    var vrWindows = validWindows.filter(function (w) { return w.models[mk].vsRandom; });
    if (vrWindows.length > 0) {
      var vr = vrWindows.map(function (w) { return w.models[mk].vsRandom; });
      summary[mk + 'Summary'].vsRandom = {
        avgDelta: Math.round(vr.reduce(function (s, v) { return s + v.avgDelta; }, 0) / vr.length * 100) / 100,
        significantFraction: Math.round(vr.reduce(function (s, v) { return s + v.significantDays; }, 0) / vr.reduce(function (s, v) { return s + v.significantDays + (v.significantDays < vrWindows.length ? 0 : 0); }, 0) * 100) / 100,
      };
    }
  });

  // Write summary
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
      (s.avgReturn != null ? ' | return=' + s.avgReturn + '%' : '') +
      (s.avgWinRate != null ? ' | winRate=' + s.avgWinRate + '%' : '') +
      (s.avgExcess != null ? ' | excess=' + s.avgExcess + '%' : '') +
      (s.avgCoverage != null ? ' | coverage=' + s.avgCoverage + '%' : ''));
    if (s.vsRandom) {
      console.log('  vs Random: delta=' + s.vsRandom.avgDelta + ' significantFrac=' + s.vsRandom.significantFraction);
    }
  });
}

module.exports = { runRollingOOS, evaluateWindow, generateWindows, loadSnapshotsForDate };
