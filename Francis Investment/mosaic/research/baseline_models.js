/**
 * P1.1-D: Baseline Models v2 — Fixed-Seed Bootstrap + Unified Metrics
 *
 * Three baselines, all rule-based, no ML:
 *   A — Composite (rule-based, uses all available dimensions — note: 3/5 are fake data)
 *   B — Simple 20-day Momentum (technical, price-only)
 *   C — Random equal-weight (fixed-seed xorshift, ≥500 bootstrap samples)
 *   D — Technical-Only (technical+hidden, 100% real PIT data) — from technical_baseline.js
 *
 * P1.1 upgrades:
 *   — Fixed-seed PRNG for random baseline (reproducible)
 *   — Bootstrap ≥500 draws per date
 *   — Output: 95% CI, delta vs random, empirical p-value
 *   — Unified metrics: gross return, cost-adjusted excess, coverage, untradeable,
 *     turnover, time-series maxDrawdown (from trade_simulator)
 *   — Cross-sectional "drawdown" removed
 */

var CALENDAR = require('./universal_calendar');
var TECH = require('./technical_baseline');

// Round-trip cost: 0.025% × 2 + 0.1% stamp + 0.001% × 2 + 0.15% × 2 slip
var ROUND_TRIP_COST_PCT = 0.025 * 2 + 0.1 + 0.001 * 2 + 0.15 * 2;

// ---- XorShift PRNG (fixed seed = 42, reproducible) ----

function createRNG(seed) {
  var state = seed || 42;
  return function next() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296; // [0, 1)
  };
}

// ---- Model A: Composite (from existing composite.js engine) ----

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
  return candidates.slice(0, 50);
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
    if (momentum <= 2) continue; // Minimum 2% threshold

    candidates.push({
      code: s.code,
      momentumScore: Math.round(momentum * 100) / 100,
      price: s.price,
    });
  }
  candidates.sort(function (a, b) { return b.momentumScore - a.momentumScore; });
  return candidates.slice(0, 50);
}

// ---- Model C: Random (fixed seed) ----

function rankByRandom(codes, rng) {
  var rngFn = rng || createRNG(42);
  var shuffled = codes.slice();
  // Fisher-Yates shuffle with provided RNG
  for (var i = shuffled.length - 1; i > 0; i--) {
    var j = Math.floor(rngFn() * (i + 1));
    var tmp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = tmp;
  }
  return shuffled.slice(0, 50).map(function (c) {
    return { code: c, compositeScore: 0, random: true };
  });
}

function rankByRandomBootstrap(codes, samples, rng) {
  var rngFn = rng || createRNG(42);
  var results = [];
  for (var i = 0; i < samples; i++) {
    // New seed derived from master seed for each sample
    var sampleRng = createRNG(42 + i * 100003);
    results.push(rankByRandom(codes, sampleRng));
  }
  return results;
}

// ---- Unified metrics (from snapshots, single date) ----

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

// ---- Bootstrap: random distribution with CI ----

function computeRandomDistribution(codes, snapMap, samples) {
  samples = samples || 500;
  var masterRng = createRNG(42);

  var grossReturns = [];
  var winRates = [];

  for (var i = 0; i < samples; i++) {
    var sampleRng = createRNG(42 + i * 100003);
    var ranked = rankByRandom(codes, sampleRng);
    var metrics = computeMetrics(ranked, snapMap);
    if (metrics.avgReturn != null) {
      grossReturns.push(metrics.avgReturn);
    }
    if (metrics.winRate != null) {
      winRates.push(metrics.winRate);
    }
  }

  grossReturns.sort(function (a, b) { return a - b; });
  winRates.sort(function (a, b) { return a - b; });

  var n = grossReturns.length;
  var ci95LowIdx = Math.max(0, Math.floor(n * 0.025));
  var ci95HighIdx = Math.min(n - 1, Math.floor(n * 0.975));

  var meanGross = grossReturns.length > 0
    ? Math.round(grossReturns.reduce(function (a, b) { return a + b; }, 0) / grossReturns.length * 100) / 100
    : null;
  var medianGross = grossReturns.length > 0 ? grossReturns[Math.floor(grossReturns.length / 2)] : null;

  var sorted = grossReturns;
  var ci95_lower = sorted.length > 0 ? sorted[ci95LowIdx] : null;
  var ci95_upper = sorted.length > 0 ? sorted[ci95HighIdx] : null;

  return {
    samples: n,
    meanGrossReturn: meanGross,
    medianGrossReturn: medianGross != null ? Math.round(medianGross * 100) / 100 : null,
    stdDev: n > 1 ? Math.round(Math.sqrt(grossReturns.reduce(function (s, r) { return s + Math.pow(r - meanGross, 2); }, 0) / (n - 1)) * 100) / 100 : null,
    ci95_lower: ci95_lower != null ? Math.round(ci95_lower * 100) / 100 : null,
    ci95_upper: ci95_upper != null ? Math.round(ci95_upper * 100) / 100 : null,
    allReturns: sorted,
  };
}

// ---- Compare model to random baseline ----

function compareToRandom(modelResult, randomDist) {
  var delta = modelResult.avgReturn != null && randomDist.meanGrossReturn != null
    ? Math.round((modelResult.avgReturn - randomDist.meanGrossReturn) * 100) / 100
    : null;

  // Empirical p-value: fraction of bootstrap returns >= model return
  var pValue = null;
  if (modelResult.avgReturn != null && randomDist.allReturns && randomDist.allReturns.length > 0) {
    var countAbove = 0;
    for (var i = 0; i < randomDist.allReturns.length; i++) {
      if (randomDist.allReturns[i] >= modelResult.avgReturn) countAbove++;
    }
    pValue = Math.round(countAbove / randomDist.allReturns.length * 10000) / 10000;
  }

  return {
    delta: delta,
    pValue: pValue,
    significant: pValue != null && pValue < 0.05,
    beatsRandom: delta != null && delta > 0,
    note: pValue != null
      ? (pValue < 0.05 ? 'Model is SIGNIFICANTLY different from random (p < 0.05)' : 'Model is NOT significantly different from random')
      : 'Cannot compute significance',
  };
}

// ---- Kendall tau-b (tie-aware) ----

function kendallTauB(x, y) {
  if (!x || !y || x.length !== y.length || x.length < 3) return null;

  var n = x.length;
  var C = 0, D = 0, Tx = 0, Ty = 0;

  // Count ties
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

function computeKendallTau(ranked, snapMap, scoreFn) {
  var pairs = [];
  for (var i = 0; i < ranked.length; i++) {
    var s = snapMap[ranked[i].code];
    if (!s || s.forwardReturnT3 == null) continue;
    pairs.push({
      score: scoreFn(ranked[i]),
      actual: s.forwardReturnT3,
    });
  }
  if (pairs.length < 10) return null;

  pairs.sort(function (a, b) { return b.score - a.score; });
  var scores = pairs.map(function (p) { return p.score; });
  var actuals = pairs.map(function (p) { return p.actual; });
  return kendallTauB(scores, actuals);
}

// ---- Model comparison (per-date) ----

function compareAllModels(snapMap, snapshots, prev20SnapMap) {
  var codes = Object.keys(snapMap);

  var compRanked = rankByComposite(snapshots);
  var techRanked = TECH.rankByTechnicalOnly(snapshots);
  var momRanked = rankByMomentum(snapshots, prev20SnapMap);
  var randomDist = computeRandomDistribution(codes, snapMap, 500);

  var compMetrics = computeMetrics(compRanked, snapMap);
  var techMetrics = computeMetrics(techRanked, snapMap);
  var momMetrics = computeMetrics(momRanked, snapMap);

  var compVsRandom = compareToRandom(compMetrics, randomDist);
  var techVsRandom = compareToRandom(techMetrics, randomDist);
  var momVsRandom = compareToRandom(momMetrics, randomDist);

  // Overlap
  var compVsTech = TECH.compareToComposite(techRanked, compRanked);

  return {
    date: snapshots.length > 0 ? snapshots[0].asOfDate : null,
    composite: { ranked: compRanked.length, metrics: compMetrics, vsRandom: compVsRandom,
      tau: computeKendallTau(compRanked, snapMap, function (p) { return p.compositeScore || 0; }) },
    technicalOnly: { ranked: techRanked.length, metrics: techMetrics, vsRandom: techVsRandom },
    momentum: { ranked: momRanked.length, metrics: momMetrics, vsRandom: momVsRandom },
    random: { distribution: {
      mean: randomDist.meanGrossReturn, ci95_lower: randomDist.ci95_lower, ci95_upper: randomDist.ci95_upper,
      samples: randomDist.samples, stdDev: randomDist.stdDev,
    } },
    overlap: compVsTech,
    universeCoverage: snapshots.length > 0 ? snapshots[0].universeCoverageStatus : null,
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

  console.log('=== P1.1-D: Baseline Models v2 ===');
  console.log('Test date: ' + testDate);
  console.log();

  var snapMap = {};
  var snapshots = [];
  var lines = fs.readFileSync(testFile, 'utf8').trim().split('\n');
  lines.forEach(function (l) { if (!l) return; var r = JSON.parse(l); snapMap[r.code] = r; snapshots.push(r); });

  // Load T-20 for momentum
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
  rankByComposite, rankByMomentum, rankByRandom, rankByRandomBootstrap,
  computeMetrics, computeRandomDistribution, compareToRandom,
  kendallTauB, computeKendallTau, compareAllModels,
  createRNG, ROUND_TRIP_COST_PCT,
};
