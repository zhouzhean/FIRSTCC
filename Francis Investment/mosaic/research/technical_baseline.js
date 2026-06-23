/**
 * P1.1-B: Technical-Only Baseline — Honest Reference Model
 *
 * Ranks stocks using ONLY features that have real point-in-time data:
 *  - Technical: derived from price/volume (real)
 *  - Hidden: derived from H1-H9 signal computation (real)
 *
 * Features EXCLUDED (no point-in-time data available):
 *  - Financial: ROE, debt ratio, revenue growth, etc. (Eastmoney API offline)
 *  - Capital flow: sector flow, major net flow (only live snapshot)
 *  - Event: LHB signals (no historical data)
 *
 * This baseline represents "what we can honestly know" at each point in time.
 * If composite (which uses fake defaults) can't beat technical-only, the
 * unavailable features are adding noise, not signal.
 */

var fs = require('fs');
var path = require('path');

var CALENDAR = require('./universal_calendar');

// ---- Scoring: Technical + Hidden Only ----

function computeTechnicalOnlyScore(snapshot) {
  if (!snapshot) return null;

  var dims = snapshot.dimensions || {};
  var technical = dims.technical;
  var hidden = dims.hidden;

  // If either real dimension is missing, can't compute
  if (technical == null && hidden == null) return null;

  // Simple average of available real dimensions (scale 0-100)
  var available = [];
  if (technical != null) available.push(technical);
  if (hidden != null) available.push(hidden);

  var sum = 0;
  for (var i = 0; i < available.length; i++) sum += available[i];
  return Math.round(sum / available.length);
}

function rankByTechnicalOnly(snapshots) {
  // snapshots: array of snapshot records for a single date
  var candidates = [];

  for (var i = 0; i < snapshots.length; i++) {
    var s = snapshots[i];
    if (!s || s.price == null || s.price <= 0) continue;
    var score = computeTechnicalOnlyScore(s);
    if (score == null) continue;
    candidates.push({
      code: s.code,
      technicalOnlyScore: score,
      technical: s.dimensions ? s.dimensions.technical : null,
      hidden: s.dimensions ? s.dimensions.hidden : null,
      signalCount: s.signalCount || 0,
      price: s.price,
      compositeScore: s.compositeScore, // for comparison
    });
  }

  // Sort by technical-only score desc, tie-break by signalCount
  candidates.sort(function (a, b) {
    if (b.technicalOnlyScore !== a.technicalOnlyScore) return b.technicalOnlyScore - a.technicalOnlyScore;
    return b.signalCount - a.signalCount;
  });

  return candidates.slice(0, 50);
}

// ---- Comparison: Composite vs Technical-Only ----

function compareToComposite(techRanked, compRanked) {
  // How much overlap between top-50 lists?
  var compSet = {};
  for (var i = 0; i < compRanked.length; i++) {
    compSet[compRanked[i].code] = compRanked[i];
  }

  var overlap = 0;
  for (var i = 0; i < techRanked.length; i++) {
    if (compSet[techRanked[i].code]) overlap++;
  }

  return {
    overlap: overlap,
    overlapPct: Math.round(overlap / Math.max(techRanked.length, 1) * 100),
    techOnlyCount: techRanked.length,
    compositeCount: compRanked.length,
  };
}

// ---- Metrics (reuse existing pattern from baseline_models) ----

function computeMetrics(ranked, snapMap) {
  // ranked: array of {code, ...}
  // snapMap: {code → snapshot record}
  var returns = [];
  var excessReturns = [];
  var wins = 0;
  var settled = 0;

  for (var i = 0; i < ranked.length; i++) {
    var s = snapMap[ranked[i].code];
    if (!s) continue;
    if (s.forwardReturnT3 != null) {
      returns.push(s.forwardReturnT3);
      settled++;
      if (s.forwardReturnT3 > 0) wins++;
    }
    if (s.forwardExcessT3 != null) {
      excessReturns.push(s.forwardExcessT3);
    }
  }

  if (returns.length === 0) {
    return { count: 0, avgReturn: null, winRate: null, avgExcess: null };
  }

  var avgReturn = Math.round(returns.reduce(function (a, b) { return a + b; }, 0) / returns.length * 100) / 100;
  var winRate = Math.round(wins / settled * 100 * 100) / 100;
  var avgExcess = excessReturns.length > 0
    ? Math.round(excessReturns.reduce(function (a, b) { return a + b; }, 0) / excessReturns.length * 100) / 100
    : null;

  return {
    count: returns.length,
    avgReturn: avgReturn,
    winRate: winRate,
    avgExcess: avgExcess,
  };
}

// ---- CLI ----

if (require.main === module) {
  var SNAPSHOTS_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'research', 'snapshots');

  var testDate = process.argv[2] || '2024-06-03';
  var testFile = path.join(SNAPSHOTS_DIR, testDate + '.jsonl');

  if (!fs.existsSync(testFile)) {
    console.error('Snapshot not found: ' + testDate);
    console.error('Run historical_snapshot.js first.');
    process.exit(1);
  }

  console.log('=== P1.1-B: Technical-Only Baseline ===');
  console.log('Test date: ' + testDate);
  console.log();

  // Load snapshots
  var snapMap = {};
  var snapshots = [];
  var lines = fs.readFileSync(testFile, 'utf8').trim().split('\n');
  lines.forEach(function (line) {
    if (!line) return;
    var r = JSON.parse(line);
    snapMap[r.code] = r;
    snapshots.push(r);
  });
  console.log('Loaded ' + snapshots.length + ' stocks');

  // Compare composite vs technical-only
  var BASELINES = require('./baseline_models');
  var compRanked = BASELINES.rankByComposite(snapshots);
  var techRanked = rankByTechnicalOnly(snapshots);

  console.log();
  console.log('--- Composite (rule-based) ---');
  console.log('Top 5:');
  compRanked.slice(0, 5).forEach(function (r, i) {
    console.log('  ' + (i + 1) + '. ' + r.code + ' score=' + r.compositeScore + ' dims=' +
      JSON.stringify({ f: snapMap[r.code] ? snapMap[r.code].dimensions : null }));
  });
  var compMetrics = computeMetrics(compRanked, snapMap);
  console.log('Metrics: avgReturn=' + compMetrics.avgReturn + '% winRate=' + compMetrics.winRate + '%');

  console.log();
  console.log('--- Technical-Only (honest) ---');
  console.log('Top 5:');
  techRanked.slice(0, 5).forEach(function (r, i) {
    console.log('  ' + (i + 1) + '. ' + r.code + ' techScore=' + r.technicalOnlyScore +
      ' (T=' + r.technical + ' H=' + r.hidden + ' signals=' + r.signalCount + ')');
  });
  var techMetrics = computeMetrics(techRanked, snapMap);
  console.log('Metrics: avgReturn=' + techMetrics.avgReturn + '% winRate=' + techMetrics.winRate + '%');

  // Overlap
  var comp = compareToComposite(techRanked, compRanked);
  console.log();
  console.log('--- Overlap ---');
  console.log('Technical-only ∩ Composite: ' + comp.overlap + '/' + comp.techOnlyCount + ' (' + comp.overlapPct + '%)');
  console.log('If overlap is low (<50%), unavailable features (financial/capitalFlow/event) are driving composite rankings — not real data.');

  console.log();
  console.log('Feature availability on this date:');
  var firstSnap = snapshots[0];
  if (firstSnap && firstSnap.featureAvailability) {
    console.log(JSON.stringify(firstSnap.featureAvailability, null, 2));
  } else {
    console.log('  (featureAvailability not present — snapshots from before P1.1)');
  }
}

module.exports = { rankByTechnicalOnly, computeTechnicalOnlyScore, compareToComposite, computeMetrics };
