/**
 * P0-3: Baseline Models v3 — Deterministic Random-Portfolio Monte Carlo
 *
 * Three baselines, all rule-based:
 *   A — Composite (rule-based, uses all dimensions — note: most are fake data)
 *   B — Simple 20-day Momentum (price-only, technical)
 *   C — Technical-Only (technical+hidden, 100% real PIT data)
 *
 * P0-3 / P0.2 upgrades:
 *   — NO daily p-value averaging. NO significantFraction.
 *   — Random baseline: deterministic random-portfolio Monte Carlo (NOT block bootstrap).
 *     For each Monte Carlo iteration, for each trading day, draw a random Top-N from
 *     that day's universe, simulate through trade_simulator, collect returns.
 *   — Fixed seed xorshift (seed=42), deterministic and reproducible.
 *   — Two-sided empirical p-value with Laplace smoothing: (extremeCount + 1) / (samples + 1)
 *   — Model-minus-random paired delta CI from the Monte Carlo distribution.
 *   — Calibration prediction key: asOfDate + code (not code alone).
 *   — "Significant" or "better than random" labels ONLY when full time-series
 *     comparison passes the threshold, and never from per-date aggregates.
 */

var CALENDAR = require('./universal_calendar');
var TECH = require('./technical_baseline');
var SIMULATOR = require('./trade_simulator');

var ROUND_TRIP_COST_PCT = SIMULATOR.ROUND_TRIP_COST_PCT;
var HOLD_DAYS = SIMULATOR.HOLD_DAYS || 3;
var TOP_N = SIMULATOR.TOP_N_PER_COHORT || 50;
var MAX_POSITIONS_PER_SLEEVE = SIMULATOR.MAX_POSITIONS_PER_SLEEVE || 17;
var MAX_CONCURRENT_POSITIONS = SIMULATOR.MAX_CONCURRENT_POSITIONS || 150;
var MONTE_CARLO_SAMPLES = 1000;
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
 * Deterministic random-portfolio Monte Carlo: for each iteration, for each trading day,
 * draw a random Top-N from that day's universe, then simulate.
 * Collects the portfolio-level metrics across iterations.
 * NOT block bootstrap — no time-block resampling. Uses fixed seed for reproducibility.
 */
function runRandomPortfolioMonteCarlo(snapshotsByDate, klineIdx, numSamples) {
  numSamples = numSamples || MONTE_CARLO_SAMPLES;
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
        maxPositionsPerSleeve: MAX_POSITIONS_PER_SLEEVE,
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
      console.log('  Monte Carlo: ' + (s + 1) + '/' + numSamples + ' iterations done');
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
 * Compare a model's portfolio result to the random Monte Carlo distribution.
 * Two-sided empirical p-value with Laplace smoothing.
 */
function compareToRandomPortfolio(modelResult, mcDist) {
  if (!modelResult || !mcDist || mcDist.samples === 0) {
    return { delta: null, pValue: null, significant: false, note: 'insufficient_data' };
  }

  var modelNetReturn = modelResult.netReturn;
  var delta = modelNetReturn != null && mcDist.meanGrossReturn != null
    ? Math.round((modelNetReturn - mcDist.meanGrossReturn) * 100) / 100
    : null;

  // p-value computed in compareFullTimeSeries with full data
  var excessDelta = modelResult.netExcessReturn != null && mcDist.meanNetExcess != null
    ? Math.round((modelResult.netExcessReturn - mcDist.meanNetExcess) * 100) / 100
    : null;

  return {
    delta: delta,
    excessDelta: excessDelta,
    pValue: null,
    significant: false,
    note: 'P0.2: p-value requires full time-series comparison with Laplace smoothing. See compareFullTimeSeries().',
  };
}

/**
 * P1.1 / P1.2: Compare pre-computed model daily rankings against random-portfolio Monte Carlo.
 *
 * P1.2 upgrade:
 *   — Accepts executionConfig {costAssumptions, topN, holdDays, maxPositionsPerSleeve, numSleeves}
 *     and applies IDENTICAL config to BOTH candidate AND every random control portfolio.
 *   — CI from empirical (modelMinusRandom) delta quantiles at 2.5%/97.5% (fixed seed),
 *     NOT from mean ± 1.96*SD.
 *   — Returns and persists executionHash, actual roundTripCostPct, topN, holdDays.
 *
 * @param {object} modelDailySignals — { date: [ {code, predictedExcess}, ... ] }
 * @param {object} snapshotsByDate — { date: { map: {code: snapshot}, list: [snapshots] } }
 * @param {object} klineIdx — stock kline index
 * @param {object} executionConfig — { costAssumptions, topN, holdDays, maxPositionsPerSleeve, numSleeves, mcSamples }
 * @returns {object} { modelPortfolio, randomMeanNetReturn, pairedDelta_*, pValue, executionHash }
 */
function compareRankingsAgainstRandom(modelDailySignals, snapshotsByDate, klineIdx, executionConfig) {
  var ec = executionConfig || {};
  var topN = ec.topN || TOP_N;
  var holdDays = ec.holdDays || HOLD_DAYS;
  var mcSamples = ec.mcSamples || MONTE_CARLO_SAMPLES;
  var costAssumptions = ec.costAssumptions || null;
  var maxPositionsPerSleeve = ec.maxPositionsPerSleeve || MAX_POSITIONS_PER_SLEEVE;
  var numSleeves = ec.numSleeves || NUM_SLEEVES;

  var dates = Object.keys(modelDailySignals).sort();
  if (dates.length === 0) return { error: 'no_model_rankings' };

  console.log('Running random-portfolio comparison for ' + dates.length + ' dates (' + mcSamples + ' MC samples)...');

  // Shared simulator options — identical for model AND random
  var simOpts = {
    klineIdx: klineIdx,
    holdDays: holdDays,
    topN: topN,
    maxPositionsPerSleeve: maxPositionsPerSleeve,
    numSleeves: numSleeves,
  };
  if (costAssumptions) simOpts.costAssumptions = costAssumptions;

  // Compute execution hash from the config that is actually used
  var crypto = require('crypto');
  var execHash = crypto.createHash('sha256');
  execHash.update('execConfig:v2|');
  execHash.update(JSON.stringify(costAssumptions || {}));
  execHash.update('|topN:' + topN);
  execHash.update('|holdDays:' + holdDays);
  execHash.update('|maxPosPerSleeve:' + maxPositionsPerSleeve);
  execHash.update('|numSleeves:' + numSleeves);
  var executionHash = execHash.digest('hex');

  // Run model portfolio through simulator (with executionConfig)
  var sim = require('./trade_simulator');
  var modelResult = sim.simulatePortfolio(modelDailySignals, simOpts);

  // Derive actual roundTripCostPct from result
  var actualRoundTripCostPct = modelResult.roundTripCostPct != null ? modelResult.roundTripCostPct : sim.ROUND_TRIP_COST_PCT;

  // Run random-portfolio Monte Carlo with IDENTICAL executionConfig
  var rng = createRNG(RANDOM_SEED);
  var randomNetReturns = [];
  for (var mc = 0; mc < mcSamples; mc++) {
    // Fixed per-sample seed for reproducibility
    var sampleRng = createRNG(RANDOM_SEED + mc * 100003 + 1);
    var randomSignals = {};
    var dateKeys = Object.keys(snapshotsByDate).sort();
    for (var di = 0; di < dateKeys.length; di++) {
      var dk = dateKeys[di];
      var pool = snapshotsByDate[dk].list || [];
      if (pool.length < topN) continue;
      var randPool = [];
      for (var pi = 0; pi < pool.length; pi++) {
        randPool.push({
          code: pool[pi].code,
          predictedExcess: sampleRng(),
        });
      }
      randPool.sort(function (a, b) { return b.predictedExcess - a.predictedExcess; });
      randomSignals[dk] = randPool.slice(0, topN);
    }
    if (Object.keys(randomSignals).length === 0) continue;
    var randResult = sim.simulatePortfolio(randomSignals, simOpts);
    randomNetReturns.push(randResult.netReturn != null ? randResult.netReturn : 0);
  }

  // P1.2: Compute modelMinusRandom deltas for EMPIRICAL quantile CI (not mean±1.96*SD)
  var deltas = [];
  for (var di = 0; di < randomNetReturns.length; di++) {
    deltas.push((modelResult.netReturn || 0) - randomNetReturns[di]);
  }
  deltas.sort(function (a, b) { return a - b; });
  var dN = deltas.length;
  var pairedDelta_mean = dN > 0 ? deltas.reduce(function (s, v) { return s + v; }, 0) / dN : null;
  var pairedDelta_ci95_lower = dN > 0 ? deltas[Math.max(0, Math.floor(dN * 0.025))] : null;
  var pairedDelta_ci95_upper = dN > 0 ? deltas[Math.min(dN - 1, Math.floor(dN * 0.975))] : null;

  // Random distribution stats (for display)
  randomNetReturns.sort(function (a, b) { return a - b; });
  var randomMean = randomNetReturns.reduce(function (s, v) { return s + v; }, 0) / randomNetReturns.length;
  var randomSD = 0;
  for (var ri = 0; ri < randomNetReturns.length; ri++) {
    randomSD += (randomNetReturns[ri] - randomMean) * (randomNetReturns[ri] - randomMean);
  }
  randomSD = Math.sqrt(randomSD / (randomNetReturns.length - 1));

  // Laplace-smoothed p-value: how extreme is model return vs random distribution?
  var extremeCount = 0;
  for (var ei = 0; ei < randomNetReturns.length; ei++) {
    if (randomNetReturns[ei] >= modelResult.netReturn) extremeCount++;
  }
  var pValue = (extremeCount + 1) / (mcSamples + 1);

  console.log('  Model net: ' + (modelResult.netReturn != null ? modelResult.netReturn.toFixed(2) + '%' : 'N/A'));
  console.log('  Random mean net: ' + randomMean.toFixed(2) + '% (SD=' + randomSD.toFixed(2) + '%)');
  console.log('  Paired delta (empirical): ' + (pairedDelta_mean != null ? pairedDelta_mean.toFixed(2) : 'N/A') + '% [' + (pairedDelta_ci95_lower != null ? pairedDelta_ci95_lower.toFixed(2) : 'N/A') + ', ' + (pairedDelta_ci95_upper != null ? pairedDelta_ci95_upper.toFixed(2) : 'N/A') + ']');
  console.log('  p-value: ' + pValue.toFixed(4) + ' (extreme=' + extremeCount + '/' + mcSamples + ')');

  return {
    randomMeanNetReturn: randomMean,
    randomSDNetReturn: randomSD,
    pairedDelta_mean: pairedDelta_mean,
    pairedDelta_ci95_lower: pairedDelta_ci95_lower,
    pairedDelta_ci95_upper: pairedDelta_ci95_upper,
    pValue: pValue,
    extremeCount: extremeCount,
    monteCarloSamples: mcSamples,
    modelNetReturn: modelResult.netReturn,
    modelGrossReturn: modelResult.grossReturn,
    // P1.2: Execution identity
    executionHash: executionHash,
    actualRoundTripCostPct: actualRoundTripCostPct,
    topN: topN,
    holdDays: holdDays,
    maxPositionsPerSleeve: maxPositionsPerSleeve,
    numSleeves: numSleeves,
  };
}

/**
 * Full time-series portfolio comparison.
 * Runs model through simulator, then deterministic random-portfolio Monte Carlo,
 * computes two-sided empirical p-value with Laplace smoothing.
 * Also produces model-minus-random paired delta CI.
 */
function compareFullTimeSeries(modelName, snapshotsByDate, prev20MapByDate, klineIdx, mcSamples) {
  mcSamples = mcSamples || MONTE_CARLO_SAMPLES;
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
    maxPositionsPerSleeve: MAX_POSITIONS_PER_SLEEVE,
  });

  if (modelResult.error) {
    return { error: modelResult.error, model: modelName };
  }

  console.log('Running random-portfolio Monte Carlo (' + mcSamples + ' samples)...');
  var mcResults = runRandomPortfolioMonteCarlo(snapshotsByDate, klineIdx, mcSamples);

  if (mcResults.error) {
    return { error: mcResults.error, model: modelName, modelResult: modelResult };
  }

  var mcDist = computeBootstrapDistribution(mcResults);

  // Two-sided empirical p-value with Laplace smoothing: p = (extremeCount + 1) / (samples + 1)
  // This avoids p=0 which misleads when sample count is finite.
  var modelNetReturn = modelResult.netReturn;
  var mcMeanNet = mcDist.meanGrossReturn; // mean of random portfolio net returns
  var modelDeviation = Math.abs(modelNetReturn - mcMeanNet);
  var countExtreme = 0;
  for (var i = 0; i < mcResults.grossReturns.length; i++) {
    var mcDeviation = Math.abs(mcResults.grossReturns[i] - mcMeanNet);
    if (mcDeviation >= modelDeviation) countExtreme++;
  }
  var nSamples = mcResults.grossReturns.length;
  var pValue = nSamples > 0
    ? Math.round((countExtreme + 1) / (nSamples + 1) * 10000) / 10000
    : null;

  var significant = pValue != null && pValue < 0.05;

  // Paired delta CI: for each MC iteration, compute modelReturn - that iteration's return
  // This gives the distribution of model-minus-random differences.
  var deltas = [];
  for (var d = 0; d < mcResults.grossReturns.length; d++) {
    deltas.push(modelNetReturn - mcResults.grossReturns[d]);
  }
  deltas.sort(function (a, b) { return a - b; });
  var dl = deltas.length;
  var pairedDeltaCI95_lower = dl > 0 ? deltas[Math.max(0, Math.floor(dl * 0.025))] : null;
  var pairedDeltaCI95_upper = dl > 0 ? deltas[Math.min(dl - 1, Math.floor(dl * 0.975))] : null;
  var pairedDeltaMean = dl > 0 ? Math.round(deltas.reduce(function (s, v) { return s + v; }, 0) / dl * 100) / 100 : null;

  // Excess return p-value
  var excessPValue = null;
  if (modelResult.netExcessReturn != null && mcDist.meanNetExcess != null) {
    var excessModelDev = Math.abs(modelResult.netExcessReturn - mcDist.meanNetExcess);
    var excessCountExtreme = 0;
    for (var j = 0; j < mcResults.netExcessReturns.length; j++) {
      var mcExcessDev = Math.abs(mcResults.netExcessReturns[j] - mcDist.meanNetExcess);
      if (mcExcessDev >= excessModelDev) excessCountExtreme++;
    }
    var nExcess = mcResults.netExcessReturns.length;
    excessPValue = nExcess > 0
      ? Math.round((excessCountExtreme + 1) / (nExcess + 1) * 10000) / 10000
      : null;
  }

  var excessDelta = modelResult.netExcessReturn != null && mcDist.meanNetExcess != null
    ? Math.round((modelResult.netExcessReturn - mcDist.meanNetExcess) * 100) / 100
    : null;

  // P0.2 T1 residual: compute benchmarkStatus first, then normalize all exhaust fields
  var rawBenchmarkStatus = (modelResult.benchmarkTradeCount > 0 && modelResult.benchmarkUnavailableCount != null) ? 'available' : 'unavailable';

  var modelPortfolio = {
    // P0.1: Explicit strategy/benchmark decomposition — UI must NOT conflate net with excess
    strategyNetReturn: modelResult.netReturn,
    strategyGrossReturn: modelResult.grossReturn,
    // Benchmark fields — set conditionally; will be nulled below if unavailable
    benchmarkNetReturn: rawBenchmarkStatus === 'available' ? modelResult.benchmarkReturn : null,
    benchmarkGrossReturn: rawBenchmarkStatus === 'available' ? modelResult.benchmarkReturn : null,
    netExcessReturn: rawBenchmarkStatus === 'available' ? modelResult.netExcessReturn : null,
    // P0.2-1: Benchmark acceptance fields
    benchmarkStatus: rawBenchmarkStatus,
    benchmarkSource: rawBenchmarkStatus === 'available' ? 'sh_index_same_path' : null,
    benchmarkTradeCount: modelResult.benchmarkTradeCount != null ? modelResult.benchmarkTradeCount : null,
    benchmarkUnavailableCount: modelResult.benchmarkUnavailableCount != null ? modelResult.benchmarkUnavailableCount : null,
    // Legacy compat fields (kept for older consumers)
    netReturn: modelResult.netReturn,
    grossReturn: modelResult.grossReturn,
    benchmarkReturn: rawBenchmarkStatus === 'available' ? modelResult.benchmarkReturn : null,
    // Per-window operational details
    maxDrawdownBps: modelResult.maxDrawdown,
    sharpeRatio: modelResult.sharpeRatio,
    coverageRate: modelResult.coverageRate,
    executedTrades: modelResult.executedTrades,
    totalSignals: modelResult.totalSignals,
    totalTurnover: modelResult.totalTurnover,
    roundTripCostPct: modelResult.roundTripCostPct,
    topPoolSize: modelResult.topNPerCohort || 50,
    numSleeves: modelResult.numSleeves || 3,
    maxPositionsPerSleeve: modelResult.maxPositionsPerSleeve || 17,
    maxConcurrentPositions: modelResult.maxConcurrentPositions || 150,
    holdDays: modelResult.holdDays || 3,
    firstDate: modelResult.firstDate,
    lastDate: modelResult.lastDate,
    // P0.2 T1 residual: explicit null for excess when unavailable
    portfolioNetExcess: rawBenchmarkStatus === 'available' ? modelResult.netExcessReturn : null,
  };

  return {
    model: modelName,
    independentTradingDays: dates.length,
    monteCarloSamples: mcDist.samples,
    modelPortfolio: modelPortfolio,
    randomMonteCarlo: {
      method: 'deterministic_random_portfolio_monte_carlo',
      meanNetReturn: mcDist.meanGrossReturn,
      medianNetReturn: mcDist.medianGrossReturn,
      stdDevNetReturn: mcDist.stdDev,
      ci95_netReturn_lower: mcDist.ci95_lower,
      ci95_netReturn_upper: mcDist.ci95_upper,
      meanNetExcessReturn: mcDist.meanNetExcess,
      ci95_excess_lower: mcDist.excessCI95_lower,
      ci95_excess_upper: mcDist.excessCI95_upper,
      meanMaxDrawdownBps: mcDist.meanMaxDrawdown,
      avgCoverage: mcDist.avgCoverage,
      pairedDelta_ci95_lower: pairedDeltaCI95_lower != null ? Math.round(pairedDeltaCI95_lower * 100) / 100 : null,
      pairedDelta_ci95_upper: pairedDeltaCI95_upper != null ? Math.round(pairedDeltaCI95_upper * 100) / 100 : null,
      pairedDelta_mean: pairedDeltaMean,
    },
    comparison: {
      netReturnDelta: Math.round((modelNetReturn - mcMeanNet) * 100) / 100,
      netExcessDelta: excessDelta,
      pValue_net: pValue,
      pValue_excess: excessPValue,
      significant: significant,
      verdict: significant
        ? ('Model net return is significantly different from random (p=' + pValue + ', two-sided, Laplace-smoothed)')
        : ('Model net return is NOT significantly different from random (p=' + pValue + ', two-sided, Laplace-smoothed)'),
    },
    navSeries: modelResult.navSeries,
    grossNavSeries: modelResult.grossNavSeries,
    benchmarkNavSeries: modelResult.benchmarkNavSeries,
    trades: modelResult.trades,
  };
}

// =====================================================================
// Per-date metrics (for backwards compat and Rank IC computation)
// =====================================================================

function computeMetrics(ranked, snapMap, asOfDate) {
  // P0.2: Calibration key is asOfDate + code, not code alone.
  // This prevents same-code on different dates from being treated as the same observation.
  var prefix = asOfDate ? asOfDate + '|' : '';
  var returns = [];
  var excessReturns = [];
  var wins = 0;
  var settled = 0;
  var unavailable = 0;

  for (var i = 0; i < ranked.length; i++) {
    var key = prefix + ranked[i].code;
    var s = snapMap[key] || snapMap[ranked[i].code]; // fallback to code-only for compat
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

  var asOfDate = snapshots.length > 0 ? snapshots[0].asOfDate : null;
  var compMetrics = computeMetrics(compRanked, snapMap, asOfDate);
  var techMetrics = computeMetrics(techRanked, snapMap, asOfDate);
  var momMetrics = computeMetrics(momRanked, snapMap, asOfDate);

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
  buildDailyRankings, runRandomPortfolioMonteCarlo, computeBootstrapDistribution,
  compareToRandomPortfolio, compareFullTimeSeries, compareRankingsAgainstRandom,
  kendallTauB, createRNG,
  ROUND_TRIP_COST_PCT, MONTE_CARLO_SAMPLES, TOP_N, RANDOM_SEED,
};
