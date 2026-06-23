/**
 * P1-D: Walk-Forward Expander
 *
 * Rolling walk-forward validation with fixed T+3 horizon.
 * Reads daily snapshot JSONL files and evaluates model rankings
 * against three baselines on expanding or rolling windows.
 *
 * Window step: 1 quarter (~60 trading days).
 * Output: walk_forward_summary.json + per-window detail files.
 */

var fs = require('fs');
var path = require('path');

var CALENDAR = require('./universal_calendar');
var BASELINES = require('./baseline_models');
var config = require('../config');

var SNAPSHOTS_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'research', 'snapshots');
var RESULTS_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'research', 'walk_forward_results');

var WINDOW_STEP_TRADING_DAYS = 60; // 1 quarter
var MIN_TRAIN_DAYS = 63;          // At least 1 quarter of training
var MIN_VALIDATE_DAYS = 20;       // At least 1 month of validation
var MIN_TEST_DAYS = 20;           // At least 1 month of testing
var TOP_N = 50;

// ---- Snapshot Loading ----

function loadSnapshotsForRange(startDate, endDate) {
  var tradingDays = CALENDAR.loadCalendar();
  var dates = [];
  for (var i = 0; i < tradingDays.length; i++) {
    if (tradingDays[i] >= startDate && tradingDays[i] <= endDate) {
      dates.push(tradingDays[i]);
    }
  }

  var allRecords = [];
  dates.forEach(function (d) {
    var fp = path.join(SNAPSHOTS_DIR, d + '.jsonl');
    if (!fs.existsSync(fp)) return;
    try {
      var lines = fs.readFileSync(fp, 'utf8').trim().split('\n');
      lines.forEach(function (line) {
        if (!line) return;
        try {
          var record = JSON.parse(line);
          record._sourceDate = d;
          allRecords.push(record);
        } catch (e) { /* skip */ }
      });
    } catch (e) { /* file read error */ }
  });

  return allRecords;
}

// ---- Build code → snapshot map for a single date ----

function loadSnapshotsForDate(dateStr) {
  var fp = path.join(SNAPSHOTS_DIR, dateStr + '.jsonl');
  if (!fs.existsSync(fp)) return {};
  var map = {};
  try {
    var lines = fs.readFileSync(fp, 'utf8').trim().split('\n');
    lines.forEach(function (line) {
      if (!line) return;
      try {
        var r = JSON.parse(line);
        map[r.code] = r;
      } catch (e) { /* skip */ }
    });
  } catch (e) { /* file read error */ }
  return map;
}

// ---- Single Window Evaluation ----

function evaluateWindow(trainDates, validateDates, testDates) {
  var result = {
    window: {
      trainStart: trainDates[0],
      trainEnd: trainDates[trainDates.length - 1],
      trainDays: trainDates.length,
      validateStart: validateDates[0],
      validateEnd: validateDates[validateDates.length - 1],
      validateDays: validateDates.length,
      testStart: testDates[0],
      testEnd: testDates[testDates.length - 1],
      testDays: testDates.length,
    },
    models: {},
    coverage: {},
  };

  // For each test date, rank with each model and compute metrics
  var compositeResults = [];
  var momentumResults = [];
  var randomResults = [];

  testDates.forEach(function (testDate) {
    var snapMap = loadSnapshotsForDate(testDate);
    var codes = Object.keys(snapMap);
    if (codes.length < 10) return;

    // Model A: Composite
    var snapshotsList = codes.map(function (c) { return snapMap[c]; });
    var compRanked = BASELINES.rankByComposite(snapshotsList);
    var compMetrics = BASELINES.computeTop50Metrics(compRanked, snapMap);
    compMetrics.date = testDate;
    // Kendall tau
    var compTau = BASELINES.computeKendallTau(compRanked, snapMap, function (p) { return p.compositeScore || 0; });
    compMetrics.kendallTau = compTau;
    compositeResults.push(compMetrics);

    // Model B: Momentum (20-day, using prior snapshot for close-20)
    var prev20Date = CALENDAR.getTradingDay(testDate, -20);
    var prev20SnapMap = prev20Date ? loadSnapshotsForDate(prev20Date) : {};
    var momRanked = [];
    codes.forEach(function (c) {
      var curr = snapMap[c];
      var prev = prev20SnapMap[c];
      if (!curr || curr.price <= 0 || !prev || prev.price <= 0) return;
      var momentum = (curr.price / prev.price - 1) * 100;
      if (momentum > 2) {
        momRanked.push({ code: c, momentumScore: momentum, price: curr.price });
      }
    });
    momRanked.sort(function (a, b) { return b.momentumScore - a.momentumScore; });
    momRanked = momRanked.slice(0, 50);
    var momMetrics = BASELINES.computeTop50Metrics(momRanked, snapMap);
    momMetrics.date = testDate;
    momentumResults.push(momMetrics);

    // Model C: Random (single sample per date)
    var randRanked = BASELINES.rankByRandom(codes);
    var randMetrics = BASELINES.computeTop50Metrics(
      randRanked.map(function (c) { return { code: c, compositeScore: 0 }; }), snapMap
    );
    randMetrics.date = testDate;
    randomResults.push(randMetrics);

    // Coverage: how many snapshots have valid T+3 data
    var total = codes.length, settled = 0;
    codes.forEach(function (c) {
      if (snapMap[c] && snapMap[c].forwardStatus === 'settled') settled++;
    });
    result.coverage[testDate] = { total: total, settled: settled, rate: total > 0 ? Math.round(settled / total * 100) : 0 };
  });

  // Aggregate per-model
  function aggregate(results) {
    var valid = results.filter(function (r) { return r.count > 0; });
    if (valid.length === 0) return { days: 0 };
    return {
      days: valid.length,
      avgReturn: Math.round(valid.reduce(function (s, r) { return s + (r.avgReturn || 0); }, 0) / valid.length * 100) / 100,
      avgWinRate: Math.round(valid.reduce(function (s, r) { return s + (r.winRate || 0); }, 0) / valid.length * 100) / 100,
      avgExcess: valid[0].avgExcess != null
        ? Math.round(valid.reduce(function (s, r) { return s + (r.avgExcess || 0); }, 0) / valid.length * 100) / 100
        : null,
      maxDrawdown: Math.min.apply(null, valid.map(function (r) { return r.maxDrawdown || 0; })),
      kendallTauAvg: valid[0].kendallTau != null
        ? Math.round(valid.reduce(function (s, r) { return s + (r.kendallTau || 0); }, 0) / valid.length * 10000) / 10000
        : null,
    };
  }

  result.models.composite = aggregate(compositeResults);
  result.models.momentum = aggregate(momentumResults);
  result.models.random = aggregate(randomResults);

  // Coverage aggregate
  var coverageRates = Object.values(result.coverage).map(function (c) { return c.rate; });
  result.coverageSummary = {
    avgSettledRate: coverageRates.length > 0
      ? Math.round(coverageRates.reduce(function (a, b) { return a + b; }, 0) / coverageRates.length)
      : 0,
  };

  return result;
}

// ---- Rolling Walk-Forward (Main Entry) ----

function runWalkForward(options) {
  options = options || {};
  var mode = options.mode || 'expanding';  // expanding | rolling
  var startDate = options.startDate || '2023-01-01';
  var endDate = options.endDate || '2026-06-15';

  var tradingDays = CALENDAR.loadCalendar();
  var allDays = [];
  for (var i = 0; i < tradingDays.length; i++) {
    if (tradingDays[i] >= startDate && tradingDays[i] <= endDate) {
      allDays.push(tradingDays[i]);
    }
  }

  if (allDays.length < MIN_TRAIN_DAYS + MIN_VALIDATE_DAYS + MIN_TEST_DAYS) {
    console.error('Not enough trading days: need at least ' + (MIN_TRAIN_DAYS + MIN_VALIDATE_DAYS + MIN_TEST_DAYS) +
      ', got ' + allDays.length);
    return { error: 'insufficient_data', totalDays: allDays.length };
  }

  // Check snapshots exist
  var availableDays = 0;
  for (var i = 0; i < allDays.length; i++) {
    if (fs.existsSync(path.join(SNAPSHOTS_DIR, allDays[i] + '.jsonl'))) availableDays++;
  }
  if (availableDays === 0) {
    console.error('No snapshot files found. Run P1-C historical_snapshot.js first.');
    return { error: 'no_snapshots', availableDays: 0 };
  }
  console.log('Available snapshot days: ' + availableDays + ' / ' + allDays.length);

  // Generate windows
  var windows = [];
  var trainSize = options.initialTrainDays || 252; // ~1 year
  var validateSize = options.validateDays || MIN_VALIDATE_DAYS;
  var testSize = options.testDays || 60;

  var cursor = trainSize;
  while (cursor + validateSize + testSize <= allDays.length) {
    var trainEnd = cursor;
    var trainStart = mode === 'rolling' ? Math.max(0, cursor - trainSize) : 0;

    windows.push({
      trainDates: allDays.slice(trainStart, trainEnd),
      validateDates: allDays.slice(trainEnd, trainEnd + validateSize),
      testDates: allDays.slice(trainEnd + validateSize, trainEnd + validateSize + testSize),
    });
    cursor += WINDOW_STEP_TRADING_DAYS;
  }

  console.log('Mode: ' + mode + ' | Train size: ' + trainSize + ' days | Windows: ' + windows.length);
  console.log('First window: train ' + windows[0].trainDates[0] + '-' + windows[0].trainDates[windows[0].trainDates.length-1] +
    ' | validate ' + windows[0].validateDates[0] + '-' + windows[0].validateDates[windows[0].validateDates.length-1] +
    ' | test ' + windows[0].testDates[0] + '-' + windows[0].testDates[windows[0].testDates.length-1]);

  var summary = {
    generatedAt: new Date().toISOString(),
    mode: mode,
    windowCount: windows.length,
    windowStep: WINDOW_STEP_TRADING_DAYS,
    horizon: 'T+3',
    topN: TOP_N,
    dateRange: { start: startDate, end: endDate },
    windows: [],
  };

  // Evaluate each window
  windows.forEach(function (w, wi) {
    console.log('Window ' + (wi + 1) + '/' + windows.length + ' — test: ' + w.testDates[0] + ' to ' + w.testDates[w.testDates.length - 1]);
    var result = evaluateWindow(w.trainDates, w.validateDates, w.testDates);
    summary.windows.push(result);

    // Write per-window detail
    if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RESULTS_DIR, 'window_' + String(wi + 1).padStart(3, '0') + '.json'),
      JSON.stringify(result, null, 2), 'utf8'
    );
  });

  // Aggregate summary
  var modelKeys = ['composite', 'momentum', 'random'];
  modelKeys.forEach(function (mk) {
    var validWindows = summary.windows.filter(function (w) {
      return w.models[mk] && w.models[mk].days > 0;
    });
    if (validWindows.length === 0) {
      summary[mk + 'Summary'] = { validWindows: 0 };
      return;
    }
    summary[mk + 'Summary'] = {
      validWindows: validWindows.length,
      avgReturn: Math.round(validWindows.reduce(function (s, w) { return s + (w.models[mk].avgReturn || 0); }, 0) / validWindows.length * 100) / 100,
      avgWinRate: Math.round(validWindows.reduce(function (s, w) { return s + (w.models[mk].avgWinRate || 0); }, 0) / validWindows.length * 100) / 100,
      avgExcess: validWindows[0].models[mk].avgExcess != null
        ? Math.round(validWindows.reduce(function (s, w) { return s + (w.models[mk].avgExcess || 0); }, 0) / validWindows.length * 100) / 100
        : null,
      avgKendallTau: validWindows[0].models[mk].kendallTauAvg != null
        ? Math.round(validWindows.reduce(function (s, w) { return s + (w.models[mk].kendallTauAvg || 0); }, 0) / validWindows.length * 10000) / 10000
        : null,
    };
  });

  // Write summary
  var summaryPath = path.join(RESULTS_DIR, 'walk_forward_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log('\nSummary written to ' + summaryPath);

  return summary;
}

// ---- CLI ----

if (require.main === module) {
  var startDate = process.argv[2] || '2023-01-01';
  var endDate = process.argv[3] || '2026-06-15';

  console.log('=== P1-D: Walk-Forward Expander ===');
  console.log('Range: ' + startDate + ' to ' + endDate);
  console.log('Horizon: T+3 | Top: ' + TOP_N + ' | Step: ' + WINDOW_STEP_TRADING_DAYS + ' trading days');
  console.log();

  var result = runWalkForward({
    mode: 'expanding',
    startDate: startDate,
    endDate: endDate,
    initialTrainDays: 252,
    validateDays: 20,
    testDays: 60,
  });

  if (result.error) {
    console.error('Error: ' + result.error);
  } else {
    console.log('\n=== Summary ===');
    console.log('Windows evaluated: ' + result.windowCount);
    ['composite', 'momentum', 'random'].forEach(function (m) {
      var s = result[m + 'Summary'] || {};
      console.log(m + ': ' + (s.validWindows || 0) + ' valid windows' +
        (s.avgReturn != null ? ' | avgReturn=' + s.avgReturn + '%' : '') +
        (s.avgWinRate != null ? ' | winRate=' + s.avgWinRate + '%' : '') +
        (s.avgExcess != null ? ' | avgExcess=' + s.avgExcess + '%' : '') +
        (s.avgKendallTau != null ? ' | tau=' + s.avgKendallTau : ''));
    });
  }
}

module.exports = { runWalkForward, evaluateWindow, loadSnapshotsForRange };
