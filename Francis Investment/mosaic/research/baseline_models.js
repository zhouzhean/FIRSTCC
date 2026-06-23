/**
 * P1-E: Baseline Models for Historical Research
 *
 * Three rule-based baseline models for Out-of-Sample comparison.
 * All predict Top-50 rankings from point-in-time snapshot data.
 * Shadow-only: predictions never affect live Simfolio trading.
 *
 * Model A: Composite Rule-Based (existing composite.js)
 * Model B: Simple 20-day Momentum
 * Model C: Buy-Index (equal-weight benchmark — null hypothesis)
 */

var path = require('path');
var fs = require('fs');

var CALENDAR = require('./universal_calendar');

// Round-trip cost (same as historical_snapshot.js)
var ROUND_TRIP_COST_PCT = 0.025 * 2 + 0.1 + 0.001 * 2 + 0.15 * 2;

/**
 * Model A: Existing composite.js rule-based model.
 * Reuses real factor engines with point-in-time data only.
 *
 * @param {Array} snapshots — array of snapshot records for one date
 * @returns {Array} ranked top-50 by compositeScore DESC, then expectedReturn DESC
 */
function rankByComposite(snapshots) {
  var candidates = snapshots.filter(function (s) {
    return s.compositeScore != null && s.price > 0;
  });
  candidates.sort(function (a, b) {
    var sa = a.compositeScore || 0, sb = b.compositeScore || 0;
    if (sa !== sb) return sb - sa;
    return (b.expectedReturn || 0) - (a.expectedReturn || 0);
  });
  return candidates.slice(0, 50);
}

/**
 * Model B: Simple 20-day momentum.
 * Buy stocks with positive trailing 20-day return > 2%.
 *
 * @param {Object} klineIndex — code → sorted kline array
 * @param {string} asOfDate — snapshot date
 * @param {Array} codes — list of stock codes to evaluate
 * @returns {Array} ranked top-50 by momentum strength
 */
function rankByMomentum(klineIndex, asOfDate, codes) {
  var prev20 = CALENDAR.getTradingDay(asOfDate, -20);
  if (!prev20) return [];

  var candidates = [];
  codes.forEach(function (code) {
    var bars = klineIndex[code];
    if (!bars || bars.length < 21) return;

    // Find close on asOfDate
    var curr = null, prev = null;
    for (var i = bars.length - 1; i >= 0; i--) {
      if (bars[i].date <= asOfDate && !curr) curr = bars[i];
      if (bars[i].date <= prev20 && !prev) prev = bars[i];
      if (curr && prev) break;
    }
    if (!curr || !prev || prev.close <= 0) return;

    var momentum = (curr.close / prev.close - 1) * 100;
    if (momentum > 2) {
      candidates.push({ code: code, momentumScore: momentum, price: curr.close });
    }
  });

  candidates.sort(function (a, b) { return b.momentumScore - a.momentumScore; });
  return candidates.slice(0, 50);
}

/**
 * Model C: Buy-index (null hypothesis — random equal-weight).
 * Picks 50 random stocks from the universe. Bootstrap 100 samples for CI.
 *
 * @param {Array} codes — all available stock codes
 * @returns {Array} random top-50
 */
function rankByRandom(codes) {
  var shuffled = codes.slice().sort(function () { return 0.5 - Math.random(); });
  return shuffled.slice(0, 50);
}

function rankByRandomBootstrap(codes, samples) {
  samples = samples || 100;
  var results = [];
  for (var i = 0; i < samples; i++) {
    results.push(rankByRandom(codes));
  }
  return results;
}

/**
 * Compute Top-50 portfolio metrics from ranked list vs actual forward returns.
 *
 * @param {Array} top50 — ranked stock codes with forwardReturnT3
 * @param {Array} allSnapshots — all snapshot records for the date (to look up actual returns)
 * @returns {Object} metrics
 */
function computeTop50Metrics(rankedPredictions, snapshotsMap) {
  if (rankedPredictions.length === 0) {
    return { count: 0, avgReturn: null, winRate: null, avgExcess: null, maxDrawdown: null };
  }

  var returns = [], excesses = [];
  rankedPredictions.forEach(function (pred) {
    var snap = snapshotsMap[pred.code];
    if (!snap) return;
    if (snap.forwardReturnT3 != null) returns.push(snap.forwardReturnT3);
    if (snap.forwardExcessT3 != null) excesses.push(snap.forwardExcessT3);
  });

  if (returns.length === 0) return { count: 0, avgReturn: null, winRate: null, avgExcess: null };

  var avgReturn = returns.reduce(function (a, b) { return a + b; }, 0) / returns.length;
  var wins = returns.filter(function (r) { return r > 0; }).length;
  var winRate = Math.round(wins / returns.length * 10000) / 100;
  var avgExcess = excesses.length > 0
    ? Math.round(excesses.reduce(function (a, b) { return a + b; }, 0) / excesses.length * 100) / 100
    : null;

  // Simple max drawdown on equally-weighted portfolio
  var cumulative = 0, peak = 0, maxDD = 0;
  returns.forEach(function (r) {
    cumulative += r;
    if (cumulative > peak) peak = cumulative;
    var dd = peak > 0 ? (cumulative - peak) / peak * 100 : 0;
    if (dd < maxDD) maxDD = dd;
  });

  return {
    count: returns.length,
    avgReturn: Math.round(avgReturn * 100) / 100,
    winRate: winRate,
    avgExcess: avgExcess,
    maxDrawdown: Math.round(maxDD * 100) / 100,
  };
}

// ---- Kendall tau-b (tie-aware) — reused from verification_runner pattern ----

function kendallTauB(x, y) {
  if (x.length !== y.length || x.length < 3) return null;
  var n = x.length;
  var concordant = 0, discordant = 0, tiesX = 0, tiesY = 0;

  for (var i = 0; i < n; i++) {
    for (var j = i + 1; j < n; j++) {
      var dx = x[i] - x[j], dy = y[i] - y[j];
      if (dx === 0) tiesX++;
      if (dy === 0) tiesY++;
      if (dx * dy > 0) concordant++;
      else if (dx * dy < 0) discordant++;
    }
  }

  var denom = Math.sqrt((concordant + discordant + tiesX) * (concordant + discordant + tiesY));
  if (denom === 0) return 0;
  return (concordant - discordant) / denom;
}

function computeKendallTau(predictions, snapshotsMap, scoreFn) {
  var pairs = [];
  predictions.forEach(function (pred) {
    var snap = snapshotsMap[pred.code];
    if (snap && snap.forwardReturnT3 != null) {
      pairs.push({ score: scoreFn(pred), actual: snap.forwardReturnT3 });
    }
  });
  if (pairs.length < 10) return null;

  pairs.sort(function (a, b) { return b.score - a.score; });
  var scores = pairs.map(function (p) { return p.score; });
  var actuals = pairs.map(function (p) { return p.actual; });
  return kendallTauB(scores, actuals);
}

// ---- CLI ----

if (require.main === module) {
  console.log('=== P1-E: Baseline Models ===');
  console.log('Module loaded. Use functions directly from walk_forward_expander.js or test manually.');
  console.log();
  console.log('Available: rankByComposite, rankByMomentum, rankByRandom, rankByRandomBootstrap, computeTop50Metrics, kendallTauB, computeKendallTau');
}

module.exports = {
  rankByComposite,
  rankByMomentum,
  rankByRandom,
  rankByRandomBootstrap,
  computeTop50Metrics,
  kendallTauB,
  computeKendallTau,
  ROUND_TRIP_COST_PCT,
};
