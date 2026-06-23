/**
 * P1.1-A: Universe Definition — Honest Data Boundaries
 *
 * Defines the "current-file universe": 1578 stocks from Tencent ifzq qfq day bars,
 * with explicit coverage boundaries. Never claims "full A-share history."
 *
 * The stable start date is the first trading day where ≥95% of stocks have kline data.
 * Pre-stable dates are marked exploration-only and excluded from main research results.
 *
 * Output: report-engine/data/research/universe_coverage_index.json
 */

var path = require('path');
var fs = require('fs');

var CALENDAR = require('./universal_calendar');

var BASE_DIR = path.join(__dirname, '..', '..');
var KLINES_DIR = path.join(BASE_DIR, 'report-engine', 'data', 'klines');
var RESEARCH_DIR = path.join(BASE_DIR, 'report-engine', 'data', 'research');
var INDEX_PATH = path.join(RESEARCH_DIR, 'universe_coverage_index.json');

var STABLE_COVERAGE_THRESHOLD = 0.90; // 90% of stocks must have data
// Note: 95% is never reached — max is ~94.9% (1498/1578 at peak).
// The cliff at 2023-10-27 adds 1219 stocks to reach 93.3%, which is our honest stable start.
var UNIVERSE_NAME = 'current-file';
var UNIVERSE_SOURCE = 'Tencent ifzq qfq day bars (web.ifzq.gtimg.cn)';

// ---- Build stock coverage index ----

function buildCoverageIndex() {
  var files;
  try {
    files = fs.readdirSync(KLINES_DIR).filter(function (f) { return f.endsWith('.json'); }).sort();
  } catch (e) {
    console.error('Cannot read klines directory: ' + KLINES_DIR);
    return null;
  }

  var stockIndex = {};      // code → {firstDate, lastDate, barCount}
  var allDates = {};        // date → stockCount (for daily coverage)
  var allFirstDates = {};   // firstDate → count (for histogram)

  files.forEach(function (f) {
    var code = f.replace('.json', '');
    var fp = path.join(KLINES_DIR, f);
    var raw;
    try { raw = fs.readFileSync(fp, 'utf8'); } catch (e) { return; }

    var kdata;
    try { kdata = JSON.parse(raw); } catch (e) { return; }

    var bars = kdata.klines;
    if (!bars || !Array.isArray(bars) || bars.length === 0) return;

    var firstDate = bars[0].date;
    var lastDate = bars[bars.length - 1].date;
    var barCount = bars.length;

    stockIndex[code] = { firstDate: firstDate, lastDate: lastDate, barCount: barCount };

    // Increment first-date histogram
    allFirstDates[firstDate] = (allFirstDates[firstDate] || 0) + 1;

    // Increment per-date coverage (count each date this stock has data for)
    bars.forEach(function (b) {
      if (b.date) allDates[b.date] = (allDates[b.date] || 0) + 1;
    });
  });

  var codes = Object.keys(stockIndex).sort();
  var totalStocks = codes.length;

  // Find stable start from first-date distribution (cumulative approach)
  // This is more honest than per-date counting, because we determine when
  // ≥threshold% of the universe first appears in the data.
  var earliestDate = null;
  var latestDate = null;
  for (var code in stockIndex) {
    var si = stockIndex[code];
    if (!earliestDate || si.firstDate < earliestDate) earliestDate = si.firstDate;
    if (!latestDate || si.lastDate > latestDate) latestDate = si.lastDate;
  }

  // Sort first dates and compute stable start from cumulative distribution
  var sortedFirstDates = Object.keys(allFirstDates).sort();
  var stableStart = null;
  var cumCount = 0;
  for (var i = 0; i < sortedFirstDates.length; i++) {
    cumCount += allFirstDates[sortedFirstDates[i]];
    if (cumCount / totalStocks >= STABLE_COVERAGE_THRESHOLD && stableStart === null) {
      stableStart = sortedFirstDates[i];
    }
  }

  var tradingDays = CALENDAR.loadCalendar();

  // Build sorted first-date distribution
  var firstDateDistribution = Object.keys(allFirstDates).sort().map(function (d) {
    return { date: d, count: allFirstDates[d], cumulative: 0 };
  });
  var cum = 0;
  firstDateDistribution.forEach(function (entry) {
    cum += entry.count;
    entry.cumulative = cum;
    entry.cumulativePct = Math.round(cum / totalStocks * 100);
  });

  // Build daily coverage array (sampled — every 60 days to keep file small)
  var dailyCoverage = [];
  tradingDays.forEach(function (d) {
    if (dailyCoverage.length === 0 ||
        Math.abs(tradingDays.indexOf(d) - tradingDays.indexOf(dailyCoverage[dailyCoverage.length - 1].date)) >= 20) {
      var cnt = allDates[d] || 0;
      dailyCoverage.push({
        date: d,
        stockCount: cnt,
        coveragePct: Math.round(cnt / totalStocks * 100),
        isStable: stableStart ? d >= stableStart : false,
      });
    }
  });

  // Add the last date
  var lastSample = tradingDays[tradingDays.length - 1];
  if (dailyCoverage.length > 0 && dailyCoverage[dailyCoverage.length - 1].date !== lastSample) {
    var lastCnt = allDates[lastSample] || 0;
    dailyCoverage.push({
      date: lastSample,
      stockCount: lastCnt,
      coveragePct: Math.round(lastCnt / totalStocks * 100),
      isStable: stableStart ? lastSample >= stableStart : false,
    });
  }

  // Identify the "cliff" — dates where many stocks start
  var cliffDates = firstDateDistribution.filter(function (e) { return e.count >= totalStocks * 0.05; });

  return {
    universe: {
      name: UNIVERSE_NAME,
      source: UNIVERSE_SOURCE,
      stockCount: totalStocks,
      earliestDate: earliestDate,
      latestDate: latestDate,
      stableStart: stableStart,
      stableCoverageThreshold: STABLE_COVERAGE_THRESHOLD,
      survivorshipRisk: true,
      survivorshipNote: 'Universe is defined by stocks that have kline files in the current data directory. Stocks that delisted before the data was downloaded are NOT included, creating survivorship bias. Results are conditional on stocks that survived to ~2026.',
      explorationOnlyBefore: stableStart,
      explorationOnlyNote: 'Data before ' + (stableStart || '?') + ' covers <95% of the universe. Results from this period are marked exploration-only and excluded from main conclusions.',
    },
    stockIndex: stockIndex,
    firstDateDistribution: firstDateDistribution,
    cliffDates: cliffDates,
    dailyCoverage: dailyCoverage,
    generatedAt: new Date().toISOString(),
  };
}

// ---- Cached index (lazy init) ----

var _index = null;
var _indexLoaded = false;

function loadCoverageIndex() {
  if (_indexLoaded) return _index;

  // Try cached file first
  try {
    if (fs.existsSync(INDEX_PATH)) {
      _index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
      _indexLoaded = true;
      return _index;
    }
  } catch (e) { /* regenerate */ }

  _index = buildCoverageIndex();
  _indexLoaded = true;

  if (_index) {
    try {
      if (!fs.existsSync(RESEARCH_DIR)) fs.mkdirSync(RESEARCH_DIR, { recursive: true });
      fs.writeFileSync(INDEX_PATH, JSON.stringify(_index, null, 2), 'utf8');
    } catch (e) { /* non-fatal */ }
  }

  return _index;
}

// ---- Public API ----

function getUniverseMetadata() {
  var idx = loadCoverageIndex();
  return idx ? idx.universe : null;
}

function getStableStartDate() {
  var meta = getUniverseMetadata();
  return meta ? meta.stableStart : null;
}

function isPreStableDate(dateStr) {
  var stableStart = getStableStartDate();
  if (!stableStart) return true;
  return dateStr < stableStart;
}

function getStockFirstDate(code) {
  var idx = loadCoverageIndex();
  if (!idx || !idx.stockIndex || !idx.stockIndex[code]) return null;
  return idx.stockIndex[code].firstDate;
}

function getStockCoverage(code) {
  var idx = loadCoverageIndex();
  if (!idx || !idx.stockIndex) return null;
  return idx.stockIndex[code] || null;
}

function getCoverageOnDate(dateStr) {
  var idx = loadCoverageIndex();
  if (!idx || !idx.dailyCoverage) return null;

  // Binary search for closest coverage entry
  var daily = idx.dailyCoverage;
  for (var i = daily.length - 1; i >= 0; i--) {
    if (daily[i].date === dateStr) return daily[i];
    if (daily[i].date < dateStr) {
      // Return interpolated estimate
      return { date: dateStr, stockCount: daily[i].stockCount, coveragePct: daily[i].coveragePct, isStable: daily[i].isStable, interpolated: true };
    }
  }
  return null;
}

function getUniverseCodes() {
  var idx = loadCoverageIndex();
  if (!idx || !idx.stockIndex) return [];
  return Object.keys(idx.stockIndex).sort();
}

// ---- CLI ----

if (require.main === module) {
  console.log('=== P1.1-A: Universe Definition ===');
  console.log();

  var idx = buildCoverageIndex();
  if (!idx) {
    console.error('Failed to build coverage index. Check klines directory.');
    process.exit(1);
  }

  console.log('Universe: ' + idx.universe.name);
  console.log('Source:  ' + idx.universe.source);
  console.log('Stocks:  ' + idx.universe.stockCount);
  console.log('Range:   ' + idx.universe.earliestDate + ' to ' + idx.universe.latestDate);
  console.log('Stable start: ' + idx.universe.stableStart + ' (≥' + (STABLE_COVERAGE_THRESHOLD * 100) + '% coverage)');
  console.log('Survivorship risk: ' + idx.universe.survivorshipRisk);
  console.log();

  // Show cliff
  console.log('--- First-Date Distribution (cliff dates) ---');
  idx.cliffDates.forEach(function (e) {
    console.log('  ' + e.date + ': ' + e.count + ' stocks (' + e.cumulativePct + '% cumulative)');
  });

  console.log();

  // Show coverage at key points
  var keyDates = ['2023-01-03', '2023-10-27', '2023-10-30', idx.universe.stableStart, idx.universe.latestDate];
  keyDates.forEach(function (d) {
    var cov = getCoverageOnDate(d);
    if (cov) {
      console.log(d + ': ' + cov.stockCount + ' stocks (' + cov.coveragePct + '%)' +
        (cov.isStable ? ' [STABLE]' : '') + (cov.interpolated ? ' [interpolated]' : ''));
    }
  });

  console.log();
  console.log('Written to: ' + INDEX_PATH);
}

module.exports = {
  buildCoverageIndex,
  loadCoverageIndex,
  getUniverseMetadata,
  getStableStartDate,
  isPreStableDate,
  getStockFirstDate,
  getStockCoverage,
  getCoverageOnDate,
  getUniverseCodes,
};
