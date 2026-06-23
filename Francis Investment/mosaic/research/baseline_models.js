/**
 * P0-3: Baseline Models v3 — Block Bootstrap Portfolio Statistics
 *
 * Three baselines, all rule-based:
 *   A — Composite (rule-based, uses all dimensions — note: most are fake data)
 *   B — Simple 20-day Momentum (price-only, technical)
 *   C — Technical-Only (technical+hidden, 100% real PIT data)
 *
 * P0-3 upgrades:
 *   — NO daily p-value averaging. NO significantFraction.
 *   — Full time-series portfolio returns compared against daily-matched random
 *     using fixed-seed block bootstrap (≥1000 samples).
 *   — Portfolio-level outputs: avg daily excess, cumulative NAV, 95% CI,
 *     two-sided p-value, independent trading days, coverage, turnover, max drawdown.
 *   — "Significant" or "better than random" labels ONLY when repaired portfolio
 *     statistics pass the threshold, and never from per-date aggregates.
 *
 * Random baseline:
 *   — Fixed seed xorshift (seed=42)
 *   — Block bootstrap: for each bootstrap iteration, for each trading day,
 *     draw a random Top-N from that day's universe, simulate through
 *     trade_simulator, collect time-series portfolio returns.
 *   — The distribution of cumulative returns across bootstrap iterations
 *     gives the confidence interval and p-value.
 */

var CALENDAR = require('./universal_calendar');
var TECH = require('./technical_baseline');
var SIMULATOR = require('./trade_simulator');

var ROUND_TRIP_COST_PCT = SIMULATOR.ROUND_TRIP_COST_PCT;
var HOLD_DAYS = SIMULATOR.HOLD_DAYS || 3;
var TOP_N = 50;
var BOOTSTRAP_SAMPLES = 1000;
var RANDOM_SEED = 42;

// ---- XorShift PRNG (fixed seed, reproducible) ----

function createRNG(seed) {
  var state = seed >>> 0;
  return function next() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

// ---- Model A: Composite ----

function rankByComposite(snapshots) {
  var candidates = [];
  for (var i = 0; i < snapshots.length; i++) {
    var s = snapshots[i];
    if (!s || s.price == null || s.price <= 0) continue;
    if (s.compositeScore == null) continue;
    candidates.push({
      code: s.code,
      compositeScore: s.compositeScore,
      expectedReturn: s.expectedReturn,
      price: s.price,
    });
  }
  candidates.sort(function (a, b) {
    if (b.compositeScore !== a.compositeScore) return b.compositeScore - a.compositeScore;
    return (b.expectedReturn || 0) - (a.expectedReturn || 0);
  });
  return candidates.slice(0, TOP_N);
}

// ---- Model B: 20-day Momentum ----

function rankByMomentum(snapshots, prev20SnapMap) {
  var candidates = [];
  for (var i = 0; i < snapshots.length; i++) {
    var s = snapshots[i];
    if (!s || s.price == null || s.price <= 0) continue;

    var prev = prev20SnapMap ? prev20SnapMap[s.code] : null;
    if (!prev || prev.price == null || prev.price <= 0) continue;

    var momentum = (s.price / prev.price - 1) * 100;
    if (momentum <= 2) continue;

    candidates.push({
      code: s.code,
      momentumScore: Math.round(momentum * 100) / 100,
      price: s.price,
    });
  }
  candidates.sort(function (a, b) { return b.momentumScore - a.momentumScore; });
  return candidates.slice(0, TOP_N);
}

// ---- Model C: Random (fixed seed) ----

function rankByRandom(codes, rng) {
  var rngFn = rng || createRNG(RANDOM_SEED);
  var shuffled = codes.slice();
  for (var i = shuffled.length - 1; i > 0; i--) {
    var j = Math.floor(rngFn() * (i + 1));
    var tmp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = tmp;
  }
  return shuffled.slice(0, TOP_N).map(function (c) {
    return { code: c, compositeScore: 0, random: true };
  });
}

// ---- Kendall tau-b (tie-aware) ----

function kendallTauB(x, y) {
  if (!x || !y || x.length !== y.length || x.length < 3) return null;

  var n = x.length;
  var C = 0, D = 0, Tx = 0, Ty = 0;

  var tieX = {}, tieY = {};
  for (var i = 0; i < n; i++) {
    var kx = String(x[i]), ky = String(y[i]);
    tieX[kx] = (tieX[kx] || 0) + 1;
    tieY[ky] = (tieY[ky] || 0) + 1;
  }
  Object.keys(tieX).forEach(function (k) { var t = tieX[k]; if (t > 1) Tx += t * (t - 1) / 2; });
  Object.keys(tieY).forEach(function (k) { var t = tieY[k]; if (t > 1) Ty += t * (t - 1) / 2; });

  for (var i = 0; i < n; i++) {
    for (var j = i + 1; j < n; j++) {
      var dx = x[i] - x[j];
      var dy = y[i] - y[j];
      if (dx === 0 || dy === 0) continue;
      if ((dx > 0 && dy > 0) || (dx < 0 && dy < 0)) C++;
      else D++;
    }
  }

  var denom = Math.sqrt((C + D + Tx) * (C + D + Ty));
  if (denom === 0) return 0;
  return (C - D) / denom;
}

// =====================================================================
// P0-3: Block Bootstrap Portfolio Statistics
// =====================================================================

/**
 * Build daily model rankings across a date range.
 * Returns {date: [{code, ...} sorted by model rank]} for use with trade_simulator.
 */
function buildDailyRankings(modelName, snapshotsByDate, prev20MapByDate) {
  var dailyRankings = {};

  var dates = Object.keys(snapshotsByDate).sort();
  dates.forEach(function (date) {
    var snapData = snapshotsByDate[date];
    var snapshots = snapData.list;
    var snapMap = snapData.map;
    var codes = Object.keys(snapMap);

    if (codes.length < TOP_N) return;

    var ranked;
    if (modelName === 'composite') {
      ranked = rankByComposite(snapshots);
    } else if (modelName === 'technicalOnly') {
      ranked = TECH.rankByTechnicalOnly(snapshots);
    } else if (modelName === 'momentum') {
      var prev20Map = (prev20MapByDate && prev20MapByDate[date]) ? prev20MapByDate[date].map : {};
      ranked = rankByMomentum(snapshots, prev20Map);
    } else if (modelName === 'random') {
      ranked = rankByRandom(codes, createRNG(RANDOM_SEED));
    }

    if (ranked && ranked.length > 0) {
      dailyRankings[date] = ranked;
    }
  });

  return dailyRankings;
}

/**
 * Block bootstrap: for each bootstrap iteration, for each trading day,
 * draw a random Top-N from that day's universe, then simulate.
 * Collects the portfolio-level metrics across iterations.
 */
function runBlockBootstrap(snapshotsByDate, klineIdx, numSamples) {
  numSamples = numSamples || BOOTSTRAP_SAMPLES;
  var dates = Object.keys(snapshotsByDate).sort();
  if (dates.length === 0) return { error: 'no_dates' };

  var results = {
    grossReturns: [],
    netExcessReturns: [],
    maxDrawdowns: [],
    coverages: [],
    turnovers: [],
    sharpeRatios: [],
    navSeries: [],
  };

  var masterRng = createRNG(RANDOM_SEED);

  // Pre-compute random rankings for each iteration
  for (var s = 0; s < numSamples; s++) {
    // Each sample gets a deterministic but different seed
    var sampleSeed = RANDOM_SEED + s * 100003 + 1;

    // Build daily random rankings
    var dailySignals = {};
    dates.forEach(function (date, di) {
      var snapData = snapshotsByDate[date];
      var codes = Object.keys(snapData.map);
      if (codes.length < TOP_N) return;

      var sampleRng = createRNG(sampleSeed + di * 17);
      var ranked = rankByRandom(codes, sampleRng);
      if (ranked && ranked.length > 0) {
        dailySignals[date] = ranked;
      }
    });

    if (Object.keys(dailySignals).length === 0) continue;

    try {
      var simResult = SIMULATOR.simulatePortfolio(dailySignals, {
        klineIdx: klineIdx,
        holdDays: HOLD_DAYS,
        topN: TOP_N,
      });

      if (simResult.error) continue;

      results.grossReturns.push(simResult.grossReturn);
      results.netExcessReturns.push(simResult.costAdjustedExcess);
      results.maxDrawdowns.push(simResult.maxDrawdown);
      results.coverages.push(simResult.coverageRate);
      results.turnovers.push(simResult.totalTurnover);

      if (simResult.sharpeRatio != null) {
        results.sharpeRatios.push(simResult.sharpeRatio);
      }
      // Store NAV series for CI computation
      results.navSeries.push(simResult.navSeries);
    } catch (e) {
      // skip failed iteration
    }

    if ((s + 1) % 200 === 0) {
      console.log('  Bootstrap: ' + (s + 1) + '/' + numSamples + ' iterations done');
    }
  }

  return results;
}

/**
 * Compute distribution summary from bootstrap results.
 */
function computeBootstrapDistribution(bootstrapResults) {
  var returns = bootstrapResults.grossReturns.slice().sort(function (a, b) { return a - b; });
  var n = returns.length;
  if (n === 0) return { error: 'no_valid_iterations' };

  var ci95LowIdx = Math.max(0, Math.floor(n * 0.025));
  var ci95HighIdx = Math.min(n - 1, Math.floor(n * 0.975));

  var mean = returns.reduce(function (a, b) { return a + b; }, 0) / n;
  var median = n % 2 === 0 ? (returns[n / 2 - 1] + returns[n / 2]) / 2 : returns[Math.floor(n / 2)];

  var variance = 0;
  for (var i = 0; i < n; i++) {
    variance += (returns[i] - mean) * (returns[i] - mean);
  }
  variance /= (n - 1);

  // Excess returns
  var excesses = bootstrapResults.netExcessReturns.slice().sort(function (a, b) { return a - b; });
  var excessMean = excesses.length > 0 ? excesses.reduce(function (a, b) { return a + b; }, 0) / excesses.length : null;
  var excessCI95Low = excesses.length > 0 ? excesses[Math.max(0, Math.floor(excesses.length * 0.025))] : null;
  var excessCI95High = excesses.length > 0 ? excesses[Math.min(excesses.length - 1, Math.floor(excesses.length * 0.975))] : null;

  // Drawdowns
  var drawdowns = bootstrapResults.maxDrawdowns.slice().sort(function (a, b) { return a - b; });
  var ddMean = drawdowns.length > 0 ? drawdowns.reduce(function (a, b) { return a + b; }, 0) / drawdowns.length : null;

  return {
    samples: n,
    meanGrossReturn: Math.round(mean * 100) / 100,
    medianGrossReturn: Math.round(median * 100) / 100,
    stdDev: Math.round(Math.sqrt(variance) * 100) / 100,
    ci95_lower: Math.round(returns[ci95LowIdx] * 100) / 100,
    ci95_upper: Math.round(returns[ci95HighIdx] * 100) / 100,
    meanNetExcess: excessMean != null ? Math.round(excessMean * 100) / 100 : null,
    excessCI95_lower: excessCI95Low != null ? Math.round(excessCI95Low * 100) / 100 : null,
    excessCI95_upper: excessCI95High != null ? Math.round(excessCI95High * 100) / 100 : null,
    meanMaxDrawdown: ddMean != null ? Math.round(ddMean * 100) / 100 : null,
    avgCoverage: bootstrapResults.coverages.length > 0
      ? Math.round(bootstrapResults.coverages.reduce(function (a, b) { return a + b; }, 0) / bootstrapResults.coverages.length * 100) / 100
      : null,
  };
}

/**
 * Compare a model's portfolio result to the random bootstrap distribution.
 * Two-sided empirical p-value.
 */
function compareToRandomPortfolio(modelResult, bootstrapDist) {
  if (!modelResult || !bootstrapDist || bootstrapDist.samples === 0) {
    return { delta: null, pValue: null, significant: false, note: 'insufficient_data' };
  }

  var modelReturn = modelResult.grossReturn;
  var delta = modelReturn != null && bootstrapDist.meanGrossReturn != null
    ? Math.round((modelReturn - bootstrapDist.meanGrossReturn) * 100) / 100
    : null;

  // Two-sided empirical p-value:
  // fraction of bootstrap returns whose absolute deviation from mean
  // is >= the absolute deviation of the model return from the mean
  var pValue = null;
  if (modelReturn != null && bootstrapDist.samples > 0) {
    var modelDeviation = Math.abs(modelReturn - bootstrapDist.meanGrossReturn);
    var countExtreme = 0;
    var allReturns = bootstrapDist.allReturns ||
      []; // Need to pass allReturns in bootstrapDist for p-value
    // Instead, we use the bootstrap raw results
    // pValue will be computed in compareFullTimeSeries instead
    pValue = null;
  }

  // For excess returns
  var excessDelta = modelResult.costAdjustedExcess != null && bootstrapDist.meanNetExcess != null
    ? Math.round((modelResult.costAdjustedExcess - bootstrapDist.meanNetExcess) * 100) / 100
    : null;

  return {
    delta: delta,
    excessDelta: excessDelta,
    pValue: pValue,
    significant: false, // Must be computed via full time-series comparison
    note: 'P0-3: p-value requires full time-series comparison. See compareFullTimeSeries().',
  };
}

/**
 * Full time-series portfolio comparison.
 * Runs model through simulator, then block bootstraps random,
 * computes two-sided empirical p-value.
 */
function compareFullTimeSeries(modelName, snapshotsByDate, prev20MapByDate, klineIdx, bootstrapSamples) {
  bootstrapSamples = bootstrapSamples || BOOTSTRAP_SAMPLES;
  var dates = Object.keys(snapshotsByDate).sort();

  console.log('Building ' + modelName + ' daily rankings for ' + dates.length + ' dates...');
  var modelRankings = buildDailyRankings(modelName, snapshotsByDate, prev20MapByDate);

  if (Object.keys(modelRankings).length === 0) {
    return { error: 'no_model_rankings', model: modelName };
  }

  console.log('Running portfolio simulation for ' + modelName + '...');
  var modelResult = SIMULATOR.simulatePortfolio(modelRankings, {
    klineIdx: klineIdx,
    holdDays: HOLD_DAYS,
    topN: TOP_N,
  });

  if (modelResult.error) {
    return { error: modelResult.error, model: modelName };
  }

  console.log('Running block bootstrap (' + bootstrapSamples + ' samples) for random baseline...');
  var bootstrapResults = runBlockBootstrap(snapshotsByDate, klineIdx, bootstrapSamples);

  if (bootstrapResults.error) {
    return { error: bootstrapResults.error, model: modelName, modelResult: modelResult };
  }

  var bootstrapDist = computeBootstrapDistribution(bootstrapResults);

  // Two-sided empirical p-value:
  // Fraction of bootstrap gross returns whose absolute deviation from the bootstrap mean
  // is >= the absolute deviation of the model return from the bootstrap mean.
  var modelReturn = modelResult.grossReturn;
  var bsMean = bootstrapDist.meanGrossReturn;
  var modelDeviation = Math.abs(modelReturn - bsMean);
  var countExtreme = 0;
  for (var i = 0; i < bootstrapResults.grossReturns.length; i++) {
    var bsDeviation = Math.abs(bootstrapResults.grossReturns[i] - bsMean);
    if (bsDeviation >= modelDeviation) countExtreme++;
  }
  var pValue = bootstrapResults.grossReturns.length > 0
    ? Math.round(countExtreme / bootstrapResults.grossReturns.length * 10000) / 10000
    : null;

  var significant = pValue != null && pValue < 0.05;

  // Excess return p-value
  var excessPValue = null;
  if (modelResult.costAdjustedExcess != null && bootstrapDist.meanNetExcess != null) {
    var excessModelDev = Math.abs(modelResult.costAdjustedExcess - bootstrapDist.meanNetExcess);
    var excessCountExtreme = 0;
    for (var j = 0; j < bootstrapResults.netExcessReturns.length; j++) {
      var bsExcessDev = Math.abs(bootstrapResults.netExcessReturns[j] - bootstrapDist.meanNetExcess);
      if (bsExcessDev >= excessModelDev) excessCountExtreme++;
    }
    excessPValue = bootstrapResults.netExcessReturns.length > 0
      ? Math.round(excessCountExtreme / bootstrapResults.netExcessReturns.length * 10000) / 10000
      : null;
  }

  var excessDelta = modelResult.costAdjustedExcess != null && bootstrapDist.meanNetExcess != null
    ? Math.round((modelResult.costAdjustedExcess - bootstrapDist.meanNetExcess) * 100) / 100
    : null;

  return {
    model: modelName,
    independentTradingDays: dates.length,
    bootstrapSamples: bootstrapDist.samples,
    modelPortfolio: {
      grossReturn: modelResult.grossReturn,
      netExcessReturn: modelResult.costAdjustedExcess,
      maxDrawdownBps: modelResult.maxDrawdown,
      sharpeRatio: modelResult.sharpeRatio,
      coverageRate: modelResult.coverageRate,
      executedTrades: modelResult.executedTrades,
      totalSignals: modelResult.totalSignals,
      firstDate: modelResult.firstDate,
      lastDate: modelResult.lastDate,
    },
    randomBootstrap: {
      meanGrossReturn: bootstrapDist.meanGrossReturn,
      medianGrossReturn: bootstrapDist.medianGrossReturn,
      stdDevGrossReturn: bootstrapDist.stdDev,
      ci95_grossReturn_lower: bootstrapDist.ci95_lower,
      ci95_grossReturn_upper: bootstrapDist.ci95_upper,
      meanNetExcessReturn: bootstrapDist.meanNetExcess,
      ci95_excess_lower: bootstrapDist.excessCI95_lower,
      ci95_excess_upper: bootstrapDist.excessCI95_upper,
      meanMaxDrawdownBps: bootstrapDist.meanMaxDrawdown,
      avgCoverage: bootstrapDist.avgCoverage,
    },
    comparison: {
      grossReturnDelta: Math.round((modelResult.grossReturn - bootstrapDist.meanGrossReturn) * 100) / 100,
      netExcessDelta: excessDelta,
      pValue_gross: pValue,
      pValue_excess: excessPValue,
      significant: significant,
      verdict: significant
        ? ('Model gross return is significantly different from random (p=' + pValue + ', two-sided)')
        : ('Model gross return is NOT significantly different from random (p=' + pValue + ', two-sided)'),
    },
    navSeries: modelResult.navSeries,
    trades: modelResult.trades,
  };
}

// =====================================================================
// Per-date metrics (for backwards compat and Rank IC computation)
// =====================================================================

function computeMetrics(ranked, snapMap) {
  var returns = [];
  var excessReturns = [];
  var wins = 0;
  var settled = 0;
  var unavailable = 0;

  for (var i = 0; i < ranked.length; i++) {
    var s = snapMap[ranked[i].code];
    if (!s) { unavailable++; continue; }
    if (s.forwardStatus === 'settled' && s.forwardReturnT3 != null) {
      returns.push(s.forwardReturnT3);
      settled++;
      if (s.forwardReturnT3 > 0) wins++;
    } else {
      unavailable++;
    }
    if (s.forwardExcessT3 != null) {
      excessReturns.push(s.forwardExcessT3);
    }
  }

  if (returns.length === 0) {
    return {
      count: 0, settled: 0, unavailable: unavailable,
      avgReturn: null, winRate: null, avgExcess: null,
      coverage: ranked.length > 0 ? Math.round((ranked.length - unavailable) / ranked.length * 100) : 0,
    };
  }

  return {
    count: returns.length,
    settled: settled,
    unavailable: unavailable,
    avgReturn: Math.round(returns.reduce(function (a, b) { return a + b; }, 0) / returns.length * 100) / 100,
    winRate: Math.round(wins / settled * 100 * 100) / 100,
    avgExcess: excessReturns.length > 0
      ? Math.round(excessReturns.reduce(function (a, b) { return a + b; }, 0) / excessReturns.length * 100) / 100
      : null,
    coverage: ranked.length > 0 ? Math.round((ranked.length - unavailable) / ranked.length * 100) : 0,
  };
}

// ---- Per-date comparison (backwards compat, no p-value aggregation) ----

function compareAllModels(snapMap, snapshots, prev20SnapMap) {
  // Returns per-date metrics only.
  // Does NOT compute p-values — those come from full time-series comparison.
  var codes = Object.keys(snapMap);

  var compRanked = rankByComposite(snapshots);
  var techRanked = TECH.rankByTechnicalOnly(snapshots);
  var momRanked = rankByMomentum(snapshots, prev20SnapMap);

  var compMetrics = computeMetrics(compRanked, snapMap);
  var techMetrics = computeMetrics(techRanked, snapMap);
  var momMetrics = computeMetrics(momRanked, snapMap);

  var compVsTech = TECH.compareToComposite(techRanked, compRanked);

  return {
    date: snapshots.length > 0 ? snapshots[0].asOfDate : null,
    composite: { ranked: compRanked.length, metrics: compMetrics },
    technicalOnly: { ranked: techRanked.length, metrics: techMetrics },
    momentum: { ranked: momRanked.length, metrics: momMetrics },
    overlap: compVsTech,
    universeCoverage: snapshots.length > 0 ? snapshots[0].universeCoverageStatus : null,
    _note: 'P0-3: Per-date metrics only. For statistical significance, use compareFullTimeSeries().',
  };
}

// ---- CLI ----

if (require.main === module) {
  var path = require('path');
  var fs = require('fs');

  var testDate = process.argv[2] || '2024-06-03';
  var SNAPSHOTS_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'research', 'snapshots');
  var testFile = path.join(SNAPSHOTS_DIR, testDate + '.jsonl');

  if (!fs.existsSync(testFile)) {
    console.error('Snapshot not found: ' + testDate);
    process.exit(1);
  }

  console.log('=== P0-3: Baseline Models v3 ===');
  console.log('Test date: ' + testDate);
  console.log();

  var snapMap = {};
  var snapshots = [];
  var lines = fs.readFileSync(testFile, 'utf8').trim().split('\n');
  lines.forEach(function (l) { if (!l) return; var r = JSON.parse(l); snapMap[r.code] = r; snapshots.push(r); });

  var prev20Date = CALENDAR.getTradingDay(testDate, -20);
  var prev20SnapMap = {};
  if (prev20Date) {
    var prevFile = path.join(SNAPSHOTS_DIR, prev20Date + '.jsonl');
    if (fs.existsSync(prevFile)) {
      var prevLines = fs.readFileSync(prevFile, 'utf8').trim().split('\n');
      prevLines.forEach(function (l) { if (!l) return; var r = JSON.parse(l); prev20SnapMap[r.code] = r; });
    }
  }

  var result = compareAllModels(snapMap, snapshots, prev20SnapMap);
  console.log(JSON.stringify(result, null, 2));
}

module.exports = {
  rankByComposite, rankByMomentum, rankByRandom,
  computeMetrics, compareAllModels,
  buildDailyRankings, runBlockBootstrap, computeBootstrapDistribution,
  compareToRandomPortfolio, compareFullTimeSeries,
  kendallTauB, createRNG,
  ROUND_TRIP_COST_PCT, BOOTSTRAP_SAMPLES, TOP_N, RANDOM_SEED,
};
