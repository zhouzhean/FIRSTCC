/**
 * P1-C: Historical Point-in-Time Daily Snapshots
 *
 * Builds immutable (asOfDate, stockCode) records for every trading day.
 * Each record captures everything visible ON that date — no forward data.
 *
 * Output: report-engine/data/research/snapshots/YYYY-MM-DD.jsonl
 *         (one JSONL file per date, one line per stock)
 *
 * Uses real factor engines (hidden_signals.js, composite.js) for point-in-time replay.
 * Financial data is tagged with _announcementDateEstimated since real dates are unavailable.
 *
 * Schema per record:
 *   asOfDate, code, name, price, open, close, high, low, volume, turnover,
 *   changePct, volatility20d, isTrading,
 *   signals: [id], signalCount, compositeScore, rating, dimensions: {fundamental, technical, hidden, capitalFlow, event},
 *   expectedReturn, confidence, evidenceThresholdPassed,
 *   financial: {roe, debtRatio, revenueGrowth, npGrowth, ocfPerShare, reportDate, announcementDate, _estimated},
 *   regime: [tags], indexSH, benchmarkEntry,
 *   targetDateT3, forwardReturnT3, forwardBenchmarkT3, forwardExcessT3, forwardStatus
 */

var fs = require('fs');
var path = require('path');

var BASE_DIR = path.join(__dirname, '..', '..');
var DATA_DIR = path.join(BASE_DIR, 'report-engine', 'data');
var KLINES_DIR = path.join(DATA_DIR, 'klines');
var INDICES_DIR = path.join(DATA_DIR, 'market_history', 'indices');
var CALENDAR = require('./universal_calendar');
var config = require('../config');

var SNAPSHOTS_DIR = path.join(DATA_DIR, 'research', 'snapshots');

// Round-trip cost: 0.025% commission × 2 + 0.1% stamp tax + 0.001% transfer fee × 2 + 0.15% slip × 2
var ROUND_TRIP_COST_PCT = 0.025 * 2 + 0.1 + 0.001 * 2 + 0.15 * 2;

// ---- K-line Index (pre-load all files into memory-indexed structure) ----

function buildKlineIndex(klineDir) {
  var index = {};     // code → sorted kline array
  var nameMap = {};   // code → name (if available)
  var count = 0;

  if (!fs.existsSync(klineDir)) {
    console.error('Kline directory not found: ' + klineDir);
    return { index: index, count: 0 };
  }

  var files = fs.readdirSync(klineDir).filter(function (f) { return f.endsWith('.json'); });
  files.forEach(function (f) {
    try {
      var raw = fs.readFileSync(path.join(klineDir, f), 'utf8');
      var data = JSON.parse(raw);
      var klines = data.klines || (Array.isArray(data) ? data : []);
      if (klines.length === 0) return;

      // Sort by date ascending
      klines.sort(function (a, b) { return (a.date || '').localeCompare(b.date || ''); });

      var code = f.replace('.json', '');
      index[code] = klines;
      if (data.name) nameMap[code] = data.name;
      count++;
    } catch (e) { /* skip corrupt files */ }
  });

  console.log('K-line index built: ' + count + ' stocks loaded from ' + files.length + ' files');
  return { index: index, nameMap: nameMap, count: count };
}

function getKlineOnOrBefore(klineIndex, code, asOfDate) {
  var bars = klineIndex[code];
  if (!bars || bars.length === 0) return null;

  // Binary search for date <= asOfDate
  var lo = 0, hi = bars.length - 1, best = null;
  while (lo <= hi) {
    var mid = (lo + hi) >>> 1;
    var d = bars[mid].date;
    if (d === asOfDate) return bars[mid];
    if (d < asOfDate) { best = bars[mid]; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  return best;
}

function getForwardKline(klineIndex, code, targetDate) {
  var bars = klineIndex[code];
  if (!bars || bars.length === 0) return null;

  for (var i = 0; i < bars.length; i++) {
    if (bars[i].date === targetDate) return bars[i];
  }
  return null;
}

// ---- Volatility (20-day rolling, from trailing klines) ----

function computeVolatility20d(klineIndex, code, asOfDate) {
  var bars = klineIndex[code];
  if (!bars || bars.length < 21) return null;

  // Find asOfDate position
  var idx = -1;
  for (var i = bars.length - 1; i >= 0; i--) {
    if (bars[i].date <= asOfDate) { idx = i; break; }
  }
  if (idx < 19) return null;  // Need at least 20 trailing bars

  var returns = [];
  for (var i = idx - 19; i <= idx; i++) {
    var prev = bars[i - 1];
    var curr = bars[i];
    if (prev && prev.close > 0 && curr.close > 0) {
      returns.push(Math.log(curr.close / prev.close));
    }
  }
  if (returns.length < 10) return null;

  var mean = returns.reduce(function (a, b) { return a + b; }, 0) / returns.length;
  var variance = returns.reduce(function (s, r) { return s + (r - mean) * (r - mean); }, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100; // Annualized %
}

// ---- Index lookups ----

var _indexCache = {};

function loadIndexData(indexCode) {
  if (_indexCache[indexCode]) return _indexCache[indexCode];

  var fp = path.join(INDICES_DIR, indexCode + '.json');
  if (!fs.existsSync(fp)) return null;

  try {
    var data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    var arr = Array.isArray(data) ? data : (data.points || data.data || []);
    _indexCache[indexCode] = arr;
    return arr;
  } catch (e) { return null; }
}

function getIndexClose(indexCode, dateStr) {
  var arr = loadIndexData(indexCode);
  if (!arr) return null;

  for (var i = arr.length - 1; i >= 0; i--) {
    var item = arr[i];
    var d = item.date || item.tradeDate;
    if (d === dateStr) return item.close || item.price;
  }
  // Fallback: nearest before
  for (var i = arr.length - 1; i >= 0; i--) {
    var d = arr[i].date || arr[i].tradeDate;
    if (d < dateStr) return arr[i].close || arr[i].price;
  }
  return null;
}

// ---- Market Regime Classification ----

function classifyRegime(klineIndex, indexCode, asOfDate) {
  var bars = klineIndex[indexCode];  // Using index kline if available; otherwise stock
  if (!bars || bars.length < 21) return ['unknown'];

  var idx = -1;
  for (var i = bars.length - 1; i >= 0; i--) {
    if (bars[i].date <= asOfDate) { idx = i; break; }
  }
  if (idx < 20) return ['unknown'];

  var tags = [];
  // 20-day trend
  var close = bars[idx].close, close20 = bars[idx - 19].close;
  if (close && close20 && close20 > 0) {
    var trend = (close / close20 - 1) * 100;
    if (trend > 5) tags.push('bull');
    else if (trend < -5) tags.push('bear');
    else tags.push('sideways');
  }

  // 20-day volatility
  var vol = computeVolatility20d(klineIndex, indexCode, asOfDate);
  if (vol != null) {
    if (vol > 30) tags.push('high_vol');
    else if (vol < 12) tags.push('low_vol');
  }

  return tags.length > 0 ? tags : ['sideways'];
}

// ---- Financial Data Estimation (fallback — REPORT_DATE + 120 days) ----

function estimateFinancialData(code, asOfDate, klineIndex) {
  // We have no real historical financial data with announcement dates.
  // The only financial data available is live snapshot from push2 V1 API.
  // For historical research, financial fields are marked as estimated and only
  // populated if a real API can provide point-in-time values.
  //
  // Strategy: record financial fields as null with _estimated marker.
  // Future improvement: batch-download quarterly financial data with announcement dates
  // from a reliable source (e.g., AKShare, Tushare, or Eastmoney datacenter with corrected API).
  return {
    roe: null,
    debtRatio: null,
    revenueGrowth: null,
    npGrowth: null,
    ocfPerShare: null,
    reportDate: null,
    announcementDate: null,
    _estimated: true,
    _note: 'Historical financial data not available with announcement dates. Eastmoney datacenter-web API is offline. Fields preserved for future data integration.'
  };
}

// ---- Main Snapshot Builder ----

function buildOneSnapshot(asOfDate, klineIdx, indexKlineIdx, opts) {
  opts = opts || {};
  var records = [];
  var codes = Object.keys(klineIdx).sort();

  var shIdxClose = getIndexClose('sh000001', asOfDate);
  var benchmarkEntry = shIdxClose;

  for (var ci = 0; ci < codes.length; ci++) {
    var code = codes[ci];
    var bar = getKlineOnOrBefore(klineIdx, code, asOfDate);
    if (!bar) continue;
    if (bar.date !== asOfDate) continue;  // Only stocks with data on this exact date

    var prevBar = getKlineOnOrBefore(klineIdx, code,
      CALENDAR.getTradingDay(asOfDate, -1) || asOfDate);
    var changePct = (prevBar && prevBar.close > 0) ? ((bar.close - prevBar.close) / prevBar.close * 100) : null;

    // Compute hidden signals and composite score (point-in-time)
    var hiddenResult = null, compositeResult = null;
    try {
      var hidden = require('../factors/hidden_signals');
      // Build minimal kline window for signal computation
      var klineWindow = [];
      for (var ki = 0; ki < klineIdx[code].length; ki++) {
        if (klineIdx[code][ki].date <= asOfDate) {
          klineWindow.push(klineIdx[code][ki]);
        } else break;
      }
      klineWindow = klineWindow.slice(-60); // Last 60 bars

      // Minimal stock detail placeholder
      var stockDetail = {
        pe: null, roe: null, pb: null, debtRatio: null,
        revenueGrowth: null, npGrowth: null, ocfPerShare: null,
      };

      hiddenResult = hidden.computeHiddenSignals(
        { code: code, price: bar.close, changePct: changePct || 0, volume: bar.volume },
        stockDetail, klineWindow, false
      );
    } catch (e) { hiddenResult = null; }

    try {
      var composite = require('../factors/composite');
      compositeResult = composite.computeCompositeScore(
        { code: code, name: code, price: bar.close, changePct: changePct || 0, volume: bar.volume },
        { pe: null, roe: null, pb: null, debtRatio: null, revenueGrowth: null, npGrowth: null, ocfPerShare: null },
        (klineIdx[code] || []).filter(function (k) { return k.date <= asOfDate; }),
        hiddenResult || { signals: [], score: 35, signalCount: 0 },
        false, {}
      );
    } catch (e) { compositeResult = null; }

    // Compute expected return (point-in-time)
    var expectedReturnVal = null, confidenceVal = null;
    try {
      var er = require('../predict/expected_return');
      var erResult = er.computeExpectedReturn({
        code: code,
        compositeScore: compositeResult ? compositeResult.compositeScore : null,
        hiddenSignals: hiddenResult ? hiddenResult.signals : [],
        prediction: null,
      }, {
        sectorFlowRank: null,
        marketCycle: { cycle: classifyRegime(indexKlineIdx, 'sz399001', asOfDate)[0] || 'sideways' },
        nbPerf: null,
        weekendContext: null,
        stockFactorPerf: null,
      });
      expectedReturnVal = erResult ? erResult.expectedReturn : null;
      confidenceVal = erResult ? erResult.confidence : null;
    } catch (e) { /* expected_return may fail without complete context */ }

    // Compute forward T+3
    var targetDateT3 = CALENDAR.getTradingDay(asOfDate, 3);
    var forwardBar = targetDateT3 ? getForwardKline(klineIdx, code, targetDateT3) : null;
    var forwardReturnT3 = null, forwardBenchmarkT3 = null, forwardExcessT3 = null, forwardStatus = 'pending';

    if (targetDateT3 && forwardBar && forwardBar.close > 0 && bar.close > 0) {
      forwardReturnT3 = Math.round((forwardBar.close / bar.close - 1) * 100 * 100) / 100;
      var benchmarkExit = getIndexClose('sh000001', targetDateT3);
      if (benchmarkExit != null && benchmarkEntry != null && benchmarkEntry > 0) {
        forwardBenchmarkT3 = Math.round((benchmarkExit / benchmarkEntry - 1) * 100 * 100) / 100;
        forwardExcessT3 = Math.round((forwardReturnT3 - forwardBenchmarkT3 - ROUND_TRIP_COST_PCT) * 100) / 100;
      }
      forwardStatus = 'settled';
    } else if (!targetDateT3) {
      forwardStatus = 'no_target_date';
    } else {
      forwardStatus = 'unavailable';
    }

    var volatility = computeVolatility20d(klineIdx, code, asOfDate);
    var financialData = estimateFinancialData(code, asOfDate, klineIdx);
    var regime = classifyRegime(indexKlineIdx, 'sz399001', asOfDate);

    var record = {
      asOfDate: asOfDate,
      code: code,
      price: bar.close,
      open: bar.open,
      close: bar.close,
      high: bar.high,
      low: bar.low,
      volume: bar.volume,
      turnover: bar.turnover || 0,
      changePct: changePct != null ? Math.round(changePct * 100) / 100 : null,
      volatility20d: volatility != null ? Math.round(volatility * 100) / 100 : null,
      isTrading: true,
      signals: hiddenResult ? hiddenResult.signals.map(function (s) { return s.id; }) : [],
      signalCount: hiddenResult ? hiddenResult.signalCount : 0,
      compositeScore: compositeResult ? compositeResult.compositeScore : null,
      rating: compositeResult ? compositeResult.rating : null,
      dimensions: compositeResult ? {
        fundamental: compositeResult.rawScores ? compositeResult.rawScores.fundamental : null,
        technical: compositeResult.rawScores ? compositeResult.rawScores.technical : null,
        hidden: compositeResult.rawScores ? compositeResult.rawScores.hidden : null,
        capitalFlow: compositeResult.rawScores ? compositeResult.rawScores.capitalFlow : null,
        event: compositeResult.rawScores ? compositeResult.rawScores.event : null,
      } : null,
      expectedReturn: expectedReturnVal,
      confidence: confidenceVal,
      evidenceThresholdPassed: confidenceVal != null && confidenceVal >= 0.60,
      financial: financialData,
      regime: regime,
      indexSH: shIdxClose,
      benchmarkEntry: benchmarkEntry,
      targetDateT3: targetDateT3,
      forwardReturnT3: forwardReturnT3,
      forwardBenchmarkT3: forwardBenchmarkT3,
      forwardExcessT3: forwardExcessT3,
      forwardStatus: forwardStatus,
    };

    records.push(record);
  }

  return records;
}

function buildAllSnapshots(startDate, endDate, opts) {
  opts = opts || {};
  var klineDir = opts.klineDir || KLINES_DIR;
  var maxStocks = opts.maxStocks || 0;  // 0 = all

  console.log('Building K-line index from ' + klineDir + '...');
  var klineInfo = buildKlineIndex(klineDir);
  if (klineInfo.count === 0) {
    console.error('No K-line data found! Aborting.');
    return { error: 'No K-line data', snapshots: 0 };
  }

  // Build index K-line proxy from SH index data
  var indexKlineIdx = {};
  var shData = loadIndexData('sh000001');
  if (shData && shData.length > 100) {
    // Convert index format to kline-compatible format
    indexKlineIdx['sz399001'] = shData.map(function (d) {
      var ds = d.date || d.tradeDate;
      return {
        date: ds,
        open: d.open || d.close,
        close: d.close,
        high: d.high || d.close,
        low: d.low || d.close,
        volume: 0,
      };
    });
  }

  var tradingDays = CALENDAR.loadCalendar();
  var startIdx = 0, endIdx = tradingDays.length - 1;

  if (startDate) {
    for (var i = 0; i < tradingDays.length; i++) {
      if (tradingDays[i] >= startDate) { startIdx = i; break; }
    }
  }
  if (endDate) {
    for (var i = tradingDays.length - 1; i >= 0; i--) {
      if (tradingDays[i] <= endDate) { endIdx = i; break; }
    }
  }

  var dateCount = endIdx - startIdx + 1;
  console.log('Date range: ' + tradingDays[startIdx] + ' to ' + tradingDays[endIdx] + ' (' + dateCount + ' days)');
  console.log('Stocks in index: ' + klineInfo.count);

  if (!fs.existsSync(SNAPSHOTS_DIR)) fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });

  var stats = { totalSnapshots: 0, dates: 0, errors: 0 };

  for (var di = startIdx; di <= endIdx; di++) {
    var asOfDate = tradingDays[di];
    try {
      var records = buildOneSnapshot(asOfDate, klineInfo.index, indexKlineIdx, opts);
      if (records.length > 0) {
        // Write JSONL
        var fpath = path.join(SNAPSHOTS_DIR, asOfDate + '.jsonl');
        var lines = records.map(function (r) { return JSON.stringify(r); }).join('\n') + '\n';
        fs.writeFileSync(fpath, lines, 'utf8');
        stats.totalSnapshots += records.length;
        stats.dates++;
      }
      if ((di - startIdx) % 50 === 0) {
        console.log('  [' + asOfDate + '] ' + records.length + ' stocks — ' + (di - startIdx + 1) + '/' + dateCount + ' days done');
      }
    } catch (e) {
      stats.errors++;
      if (stats.errors <= 5) console.error('  Error on ' + asOfDate + ': ' + e.message);
    }
  }

  console.log('Done. ' + stats.dates + ' dates, ' + stats.totalSnapshots + ' total records, ' + stats.errors + ' errors');
  return stats;
}

// ---- CLI ----

if (require.main === module) {
  var startDate = process.argv[2] || '2024-06-01';
  var endDate = process.argv[3] || '2024-06-30';

  console.log('=== P1-C: Historical Point-in-Time Snapshot Builder ===');
  console.log('Range: ' + startDate + ' to ' + endDate);
  console.log();

  var result = buildAllSnapshots(startDate, endDate);

  if (result.error) {
    console.error(result.error);
  } else {
    console.log('\nOutput: ' + SNAPSHOTS_DIR);
    // Show a sample record
    var sampleDate = CALENDAR.loadCalendar().filter(function (d) { return d >= startDate && d <= endDate; })[0];
    if (sampleDate) {
      var sampleFile = path.join(SNAPSHOTS_DIR, sampleDate + '.jsonl');
      if (fs.existsSync(sampleFile)) {
        var firstLine = fs.readFileSync(sampleFile, 'utf8').split('\n')[0];
        console.log('\nSample record (' + sampleDate + '):');
        console.log(JSON.stringify(JSON.parse(firstLine), null, 2));
      }
    }
  }
}

module.exports = { buildAllSnapshots, buildOneSnapshot, buildKlineIndex, SNAPSHOTS_DIR };
