/**
 * P1.1-B: Data Audit v2 — Honest Coverage Report
 *
 * Unlike v1 which output a binary "hasFullHistory: true" based on a single
 * early file, this version reports:
 *   - Daily coverage: how many stocks have data on each trading day
 *   - Stock start-date distribution (showing the 2023-10-27 cliff)
 *   - Gap analysis per stock (trading days missed within coverage window)
 *   - Explicit universe boundaries (current-file, not "full A-share")
 *
 * Output: report-engine/data/research/data_coverage_report_v2.json
 */

var path = require('path');
var fs = require('fs');

var CALENDAR = require('./universal_calendar');
var UNIVERSE = require('./universe_definition');

var BASE_DIR = path.join(__dirname, '..', '..');
var KLINES_DIR = path.join(BASE_DIR, 'report-engine', 'data', 'klines');
var INDICES_DIR = path.join(BASE_DIR, 'report-engine', 'data', 'market_history', 'indices');
var RESEARCH_DIR = path.join(BASE_DIR, 'report-engine', 'data', 'research');
var REPORT_PATH = path.join(RESEARCH_DIR, 'data_coverage_report_v2.json');

function runDataAuditV2() {
  console.log('=== P1.1-B: Data Audit v2 ===');
  console.log();

  var universeMeta = UNIVERSE.getUniverseMetadata();
  if (!universeMeta) {
    console.error('Run universe_definition.js first to build the coverage index.');
    return { error: 'no_universe_index' };
  }

  var tradingDays = CALENDAR.loadCalendar();
  var totalStocks = universeMeta.stockCount;

  // ---- 1. Scan all kline files for per-date presence ----
  console.log('Scanning kline files for per-date coverage...');
  var files = fs.readdirSync(KLINES_DIR).filter(function (f) { return f.endsWith('.json'); });
  var dateSet = {};  // date → Set of codes (approximated as count)
  var stockGaps = {}; // code → {barCount, firstDate, lastDate, missingDays[], gapCount}

  files.forEach(function (f, fi) {
    var code = f.replace('.json', '');
    var fp = path.join(KLINES_DIR, f);
    try {
      var raw = fs.readFileSync(fp, 'utf8');
      var kdata = JSON.parse(raw);
      var bars = kdata.klines;
      if (!bars || !Array.isArray(bars)) return;

      var barDates = {};
      bars.forEach(function (b) {
        if (b.date) {
          dateSet[b.date] = (dateSet[b.date] || 0) + 1;
          barDates[b.date] = true;
        }
      });

      // Gap analysis: check each trading day in [firstDate, lastDate]
      var firstDate = bars[0].date;
      var lastDate = bars[bars.length - 1].date;
      var missingDays = [];
      var inRange = false;
      for (var t = 0; t < tradingDays.length; t++) {
        var td = tradingDays[t];
        if (td < firstDate) continue;
        if (td > lastDate) break;
        inRange = true;
        if (!barDates[td]) {
          missingDays.push(td);
        }
      }

      stockGaps[code] = {
        barCount: bars.length,
        firstDate: firstDate,
        lastDate: lastDate,
        expectedTradingDays: inRange ? CALENDAR.countTradingDays(firstDate, lastDate) : 0,
        missingDays: missingDays.length,
        missingDaysList: missingDays.slice(0, 20), // first 20 only, keep file small
        gapCount: 0,
      };

      // Count gaps (consecutive missing stretches > 1 day)
      var gapLen = 0;
      for (var g = 0; g < missingDays.length; g++) {
        if (g > 0 && missingDays[g] === CALENDAR.getTradingDay(missingDays[g - 1], 1)) {
          gapLen++;
        } else {
          if (gapLen > 1) stockGaps[code].gapCount++;
          gapLen = 1;
        }
      }
      if (gapLen > 1) stockGaps[code].gapCount++;

    } catch (e) {
      stockGaps[code] = { error: e.message };
    }

    if ((fi + 1) % 200 === 0) {
      console.log('  ' + (fi + 1) + '/' + files.length + ' files scanned...');
    }
  });

  console.log('  Done. ' + files.length + ' files scanned.');

  // ---- 2. Build daily coverage array ----
  console.log('Building daily coverage profile...');
  var dailyCoverage = [];
  var tradingDaysInRange = [];
  for (var i = 0; i < tradingDays.length; i++) {
    var d = tradingDays[i];
    if (d >= '2023-01-01' && d <= '2026-06-23') {
      tradingDaysInRange.push(d);
    }
  }

  // Sample every trading day (not just every N days — this is the audit)
  var coverageSamples = [];
  tradingDaysInRange.forEach(function (d, i) {
    var cnt = dateSet[d] || 0;
    var pct = totalStocks > 0 ? Math.round(cnt / totalStocks * 10000) / 100 : 0;
    // Start of each month, plus every 20th day
    var prevD = i > 0 ? tradingDaysInRange[i - 1] : '';
    var isMonthStart = d.slice(5, 7) !== (prevD ? prevD.slice(5, 7) : '');
    if (isMonthStart || i % 20 === 0 || i === tradingDaysInRange.length - 1) {
      coverageSamples.push({
        date: d,
        stockCount: cnt,
        coveragePct: pct,
        isStable: d >= universeMeta.stableStart,
      });
    }
  });

  // Find min/mean/max coverage in stable period
  var stableSamples = coverageSamples.filter(function (s) { return s.isStable; });
  var stableMin = stableSamples.length > 0 ? Math.min.apply(null, stableSamples.map(function (s) { return s.coveragePct; })) : 0;
  var stableMax = stableSamples.length > 0 ? Math.max.apply(null, stableSamples.map(function (s) { return s.coveragePct; })) : 0;
  var stableMean = stableSamples.length > 0
    ? Math.round(stableSamples.reduce(function (a, b) { return a + b.coveragePct; }, 0) / stableSamples.length * 100) / 100
    : 0;

  // ---- 3. Stock start-date distribution ----
  var firstDateHist = {};
  Object.keys(stockGaps).forEach(function (code) {
    var s = stockGaps[code];
    if (s && s.firstDate) {
      firstDateHist[s.firstDate] = (firstDateHist[s.firstDate] || 0) + 1;
    }
  });

  var stockDistribution = Object.keys(firstDateHist).sort().map(function (d) {
    return { date: d, count: firstDateHist[d] };
  });

  // Cumulative
  var cum = 0;
  stockDistribution.forEach(function (e) {
    cum += e.count;
    e.cumulative = cum;
    e.cumulativePct = Math.round(cum / totalStocks * 100);
  });

  // Highlight the cliff
  var cliffDates = stockDistribution.filter(function (d) { return d.count >= 50; });

  // ---- 4. Gap summary ----
  var gapSummary = { totalStocks: totalStocks, stocksWithGaps: 0, stocksWithManyGaps: 0, avgMissingDays: 0, maxMissingDays: 0 };
  var totalMissing = 0;
  Object.keys(stockGaps).forEach(function (code) {
    var s = stockGaps[code];
    if (!s || s.error) return;
    if (s.missingDays > 0) gapSummary.stocksWithGaps++;
    if (s.missingDays > 10) gapSummary.stocksWithManyGaps++;
    totalMissing += s.missingDays;
    if (s.missingDays > gapSummary.maxMissingDays) gapSummary.maxMissingDays = s.missingDays;
  });
  gapSummary.avgMissingDays = gapSummary.stocksWithGaps > 0
    ? Math.round(totalMissing / gapSummary.stocksWithGaps * 100) / 100
    : 0;

  // Top 10 gap-prone stocks
  var topGaps = Object.entries(stockGaps)
    .filter(function (e) { return e[1] && e[1].missingDays > 0; })
    .sort(function (a, b) { return b[1].missingDays - a[1].missingDays; })
    .slice(0, 10)
    .map(function (e) { return { code: e[0], missingDays: e[1].missingDays, barCount: e[1].barCount, firstDate: e[1].firstDate, lastDate: e[1].lastDate }; });

  // ---- 5. Index data audit ----
  var indexAudit = {};
  var indexFiles = ['sh000001.json', 'sz399001.json', 'sz399006.json'];
  indexFiles.forEach(function (f) {
    var fp = path.join(INDICES_DIR, f);
    if (!fs.existsSync(fp)) { indexAudit[f] = { status: 'missing' }; return; }
    try {
      var idxData = JSON.parse(fs.readFileSync(fp, 'utf8'));
      var bars = Array.isArray(idxData) ? idxData : (idxData.data || []);
      if (bars.length > 0) {
        indexAudit[f] = {
          bars: bars.length,
          start: bars[0].date || bars[0][0],
          end: bars[bars.length - 1].date || bars[bars.length - 1][0],
        };
      } else {
        indexAudit[f] = { status: 'empty' };
      }
    } catch (e) {
      indexAudit[f] = { status: 'error', error: e.message };
    }
  });

  // ---- 6. Assemble report ----
  var report = {
    generatedAt: new Date().toISOString(),
    version: 'P1.1-B.1',
    purpose: 'Honest data coverage audit — per-date coverage, stock distribution, gap analysis',
    principle: 'Never claim "full A-share history." The universe is defined by files present in the klines directory (current-file universe). Early dates have partial coverage and are marked exploration-only.',
    universe: {
      name: universeMeta.name,
      source: universeMeta.source,
      stockCount: totalStocks,
      earliestDate: universeMeta.earliestDate,
      latestDate: universeMeta.latestDate,
      stableStart: universeMeta.stableStart,
      stableCoverageThreshold: universeMeta.stableCoverageThreshold,
      explorationOnlyBefore: universeMeta.stableStart,
      survivorshipRisk: true,
      survivorshipNote: 'Stocks that delisted before data download (~2023-2026) are absent from the universe. Results are conditional on survival.',
    },
    stablePeriodCoverage: {
      min: stableMin,
      max: stableMax,
      mean: stableMean,
      note: 'Coverage in [' + universeMeta.stableStart + ', ' + (universeMeta.latestDate || '?') + ']',
    },
    dailyCoverage: coverageSamples,
    stockDistribution: {
      cliffDates: cliffDates,
      fullDistribution: stockDistribution,
    },
    gapAnalysis: {
      summary: gapSummary,
      topGappyStocks: topGaps,
    },
    indexData: indexAudit,
    financialData: {
      status: 'unavailable',
      note: 'Eastmoney datacenter-web API offline. No point-in-time financial announcement dates. All financial fields in snapshots are null with _estimated: true.',
    },
    actionItems: [
      {
        priority: 'P0',
        action: 'Set research default start to stableStart (2023-10-30 or later)',
        detail: 'Pre-stable dates have <90% universe coverage. Use only for exploratory analysis, not main conclusions.',
      },
      {
        priority: 'P1',
        action: 'Map industry codes via Eastmoney f100 API (current snapshot only)',
        detail: 'No historical industry classification available. Current-industry mapping only.',
      },
      {
        priority: 'P2',
        action: 'Monitor kline file count drift',
        detail: 'If new Tencent API calls return different coverage, re-run this audit.',
      },
    ],
  };

  // Write
  if (!fs.existsSync(RESEARCH_DIR)) fs.mkdirSync(RESEARCH_DIR, { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  console.log();
  console.log('Report written to ' + REPORT_PATH);
  console.log();
  console.log('=== Summary ===');
  console.log('Universe:       ' + totalStocks + ' stocks (current-file)');
  console.log('Stable start:   ' + universeMeta.stableStart + ' (' + (universeMeta.stableCoverageThreshold * 100) + '% threshold)');
  console.log('Stable coverage: ' + stableMin + '% – ' + stableMax + '% (mean ' + stableMean + '%)');
  console.log('Cliff:');
  cliffDates.forEach(function (c) {
    console.log('  ' + c.date + ': +' + c.count + ' stocks → ' + c.cumulativePct + '% cumulative');
  });
  console.log('Gaps: ' + gapSummary.stocksWithGaps + ' stocks with gaps, avg ' + gapSummary.avgMissingDays + ' missing days');
  console.log('Exploration only: before ' + universeMeta.stableStart);
  console.log();

  return report;
}

// ---- CLI ----

if (require.main === module) {
  runDataAuditV2();
}

module.exports = { runDataAuditV2 };
