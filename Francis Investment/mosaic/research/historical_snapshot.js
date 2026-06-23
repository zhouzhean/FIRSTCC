/**
 * P1.1: Historical Point-in-Time Daily Snapshots (v2)
 *
 * Builds immutable (asOfDate, stockCode) records for every trading day.
 * Each record captures everything visible ON that date — no forward data.
 *
 * P1.1 upgrades:
 * — Adds universeVersion, universeCoverageStatus, survivorshipRisk
 * — Adds featureAvailability and featureSource (honest about what data exists)
 * — Nulls-out unavailable dimensions (financial, capitalFlow, event)
 * — Pre-stable dates marked "exploration only"
 *
 * P0-1 upgrades (unified label convention):
 * — Signal T close → T+1 open entry → hold 3 trading days → T+4 close exit
 * — Stock, benchmark, cost all use same entryDate/exitDate
 * — Immutable unavailable when no T+1 bar, suspended, limit, or no T+4 bar
 * — Adds labelConvention, entryDate, exitDate, entryPrice, exitPrice,
 *   targetStatus, unavailableReason
 *
 * Output: report-engine/data/research/snapshots/YYYY-MM-DD.jsonl
 *         (one JSONL file per date, one line per stock)
 *
 * Schema per record:
 *   asOfDate, code, name, price, open, close, high, low, volume, turnover,
 *   changePct, volatility20d, isTrading,
 *   universeVersion, universeCoverageStatus, survivorshipRisk,
 *   featureAvailability: {financial, capitalFlow, event, hidden, technical},
 *   featureSource: {financial, capitalFlow, event, hidden, technical},
 *   signals: [id], signalCount, compositeScore, rating,
 *   dimensions: {fundamental, technical, hidden, capitalFlow, event} (null when unavailable),
 *   expectedReturn, confidence, evidenceThresholdPassed,
 *   financial: {roe, debtRatio, revenueGrowth, npGrowth, ocfPerShare, reportDate, announcementDate, _estimated},
 *   regime: [tags], indexSH,
 *   labelConvention, entryDate, exitDate, entryPrice, exitPrice,
 *   targetDateT3 (legacy, =exitDate), forwardReturnT3, forwardBenchmarkT3,
 *   forwardExcessT3 (post-cost), forwardStatus, targetStatus, unavailableReason
 */

var fs = require('fs');
var path = require('path');

var BASE_DIR = path.join(__dirname, '..', '..');
var DATA_DIR = path.join(BASE_DIR, 'report-engine', 'data');
var KLINES_DIR = path.join(DATA_DIR, 'klines');
var INDICES_DIR = path.join(DATA_DIR, 'market_history', 'indices');
var CALENDAR = require('./universal_calendar');
var UNIVERSE = require('./universe_definition');

var SNAPSHOTS_DIR = path.join(DATA_DIR, 'research', 'snapshots');

// Round-trip cost: 0.025% commission × 2 + 0.1% stamp tax + 0.001% transfer fee × 2 + 0.15% slip × 2
var ROUND_TRIP_COST_PCT = 0.025 * 2 + 0.1 + 0.001 * 2 + 0.15 * 2;

// P0-1: Unified label convention
// Signal at T close → entry T+1 open → hold 3 trading days → exit T+4 close
// Stock, benchmark, cost, untradeable status all use same entryDate/exitDate.
// No fallback to T-close return. Immutable unavailable when entry/exit impossible.
var LABEL_CONVENTION = 'T_close_signal__T+1_open_entry__T+4_close_exit__3day_hold';
var HOLD_DAYS = 3; // Trading days from entry to exit

// ---- Feature availability (P1.1: honest about what data exists) ----
// Only technical (from price/volume) and hidden (from derived signals) have real
// point-in-time data. Financial, capital flow, and event dimensions have NO
// point-in-time data — all related APIs are unavailable for historical dates.

var FEATURE_AVAILABILITY = {
  financial: false,
  capitalFlow: false,
  event: false,
  hidden: true,
  technical: true,
};

var FEATURE_SOURCE = {
  financial: 'unavailable',
  capitalFlow: 'unavailable',
  event: 'unavailable',
  hidden: 'computed_pt',
  technical: 'computed_pt',
};

var UNIVERSE_VERSION = 'current-file';
var SURVIVORSHIP_RISK = true;

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

// P0-1: Get next trading day's kline bar (for T+1 open entry)
function getNextDayBar(klineIndex, code, fromDate) {
  var bars = klineIndex[code];
  if (!bars || bars.length === 0) return null;
  for (var i = 0; i < bars.length; i++) {
    if (bars[i].date > fromDate) return bars[i];
  }
  return null;
}

// P0-1: Check if a stock is tradeable on a given date
function checkTradeable(klineIndex, code, date) {
  var bar = getForwardKline(klineIndex, code, date);
  if (!bar) return { tradeable: false, reason: 'no_data', bar: null };

  // Suspended: zero volume
  if (!bar.volume || bar.volume === 0) {
    return { tradeable: false, reason: 'suspended', bar: bar };
  }

  // Need prev close for limit checks
  var prevBar = getKlineOnOrBefore(klineIndex, code,
    CALENDAR.getTradingDay(date, -1) || date);
  if (!prevBar || prevBar.close <= 0) {
    return { tradeable: true, reason: 'ok', bar: bar };
  }

  var changePct = (bar.close / prevBar.close - 1) * 100;

  // Limit-up: close at high and change near +10%
  if (bar.close >= bar.high && changePct >= 9.5) {
    return { tradeable: false, reason: 'limit_up', bar: bar, changePct: Math.round(changePct * 100) / 100 };
  }

  // Limit-down: close at low and change near -10%
  if (bar.close <= bar.low && changePct <= -9.5) {
    return { tradeable: false, reason: 'limit_down', bar: bar, changePct: Math.round(changePct * 100) / 100 };
  }

  return { tradeable: true, reason: 'ok', bar: bar };
}

// P0-1: Get index bar on exact date (for benchmark entry/exit)
function getIndexBarOnDate(indexCode, dateStr) {
  var arr = loadIndexData(indexCode);
  if (!arr) return null;
  for (var i = 0; i < arr.length; i++) {
    var item = arr[i];
    var d = item.date || item.tradeDate;
    if (d === dateStr) return item;
  }
  return null;
}

// P0-1: Get next trading day's index bar (for T+1 benchmark entry)
function getIndexNextBar(indexCode, fromDate) {
  var arr = loadIndexData(indexCode);
  if (!arr) return null;
  for (var i = 0; i < arr.length; i++) {
    var item = arr[i];
    var d = item.date || item.tradeDate;
    if (d > fromDate) return item;
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
  // P1.1: All financial fields are null. These MUST NOT participate in scoring,
  // ranking, or any model training. The only real point-in-time data is price/volume.
  return {
    roe: null,
    debtRatio: null,
    revenueGrowth: null,
    npGrowth: null,
    ocfPerShare: null,
    reportDate: null,
    announcementDate: null,
    _estimated: true,
    _note: 'Historical financial data not available with announcement dates. Eastmoney datacenter-web API is offline. These fields MUST NOT participate in scoring or ranking. Preserved for future data integration only.'
  };
}

// ---- Main Snapshot Builder ----

function buildOneSnapshot(asOfDate, klineIdx, indexKlineIdx, opts) {
  opts = opts || {};
  var records = [];
  var codes = Object.keys(klineIdx).sort();

  var shIdxClose = getIndexClose('sh000001', asOfDate);
  var benchmarkEntry = shIdxClose;

  // P1.1: Determine if this date is in the stable period
  var isPreStable = UNIVERSE.isPreStableDate(asOfDate);

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

    // === P0-1: Unified Label Convention ===
    // Signal at T close → T+1 open entry → hold 3 trading days → T+4 close exit
    // Stock, benchmark, cost, all use same entryDate/exitDate.
    // Immutable unavailable when entry impossible (no T+1 bar, suspended, limit)
    // or exit impossible (no T+4 bar). No fallback to T-close return.
    var entryDate = null, exitDate = null;
    var entryPrice = null, exitPrice = null;
    var forwardReturn = null, forwardBenchmark = null, forwardExcess = null;
    var forwardStatus = 'pending';
    var targetStatus = 'pending';
    var unavailableReason = null;
    // P0.2 exit tradability fields
    var plannedExitDate = null, actualExitDate = null;
    var exitDelayDays = null, exitStatus = null, failedExitReason = null;

    // Step 1: Find T+1 entry bar
    var entryBar = getNextDayBar(klineIdx, code, asOfDate);
    if (!entryBar) {
      forwardStatus = 'unavailable';
      targetStatus = 'unavailable';
      unavailableReason = 'no_T+1_bar';
    } else {
      entryDate = entryBar.date;

      // Step 2: Check tradeability on entry day
      var tradeCheck = checkTradeable(klineIdx, code, entryDate);
      if (!tradeCheck.tradeable) {
        forwardStatus = 'unavailable';
        targetStatus = 'unavailable';
        unavailableReason = 'entry_' + tradeCheck.reason;
      } else if (!entryBar.open || entryBar.open <= 0) {
        forwardStatus = 'unavailable';
        targetStatus = 'unavailable';
        unavailableReason = 'no_T+1_open';
      } else {
        entryPrice = entryBar.open;

        // === P0.2: Exit tradability — roll forward if planned exit is untradeable ===
        var plannedExitDate = CALENDAR.getTradingDay(entryDate, HOLD_DAYS);
        var exitDelayDays = 0;
        var failedExitReason = null;
        var exitStatus = 'normal';
        var actualExitDate = plannedExitDate;
        var exitBar = null;

        if (!plannedExitDate) {
          forwardStatus = 'unavailable';
          targetStatus = 'no_exit_date';
          unavailableReason = 'no_T+4_date';
        } else {
          // Check exit tradeability with roll-forward (max 5 days)
          var MAX_EXIT_ROLL = 5;
          var foundExit = false;
          for (var roll = 0; roll <= MAX_EXIT_ROLL && !foundExit; roll++) {
            exitDate = roll === 0 ? plannedExitDate : CALENDAR.getTradingDay(plannedExitDate, roll);
            if (!exitDate) break;

            exitBar = getForwardKline(klineIdx, code, exitDate);
            if (!exitBar || !exitBar.close || exitBar.close <= 0) continue;

            var exitTradeCheck = checkTradeable(klineIdx, code, exitDate);
            if (!exitTradeCheck.tradeable && exitTradeCheck.reason === 'suspended') continue;
            if (!exitTradeCheck.tradeable && exitTradeCheck.reason === 'limit_down') continue;
            // limit_up is OK: can sell at limit-up
            // no_data: continue rolling

            foundExit = true;
            exitDelayDays = roll;
            actualExitDate = exitDate;
            exitPrice = exitBar.close;
            if (roll > 0) {
              exitStatus = 'delayed';
              failedExitReason = 'rolled_' + roll + 'd_planned_' + plannedExitDate;
            }
            if (roll === 0 && !exitTradeCheck.tradeable) {
              // Shouldn't happen with above logic, but safety
              exitStatus = 'delayed';
            }
          }

          if (!foundExit) {
            forwardStatus = 'unavailable';
            targetStatus = 'unavailable';
            unavailableReason = 'exit_blocked_' + MAX_EXIT_ROLL + 'd';
            exitDelayDays = null;
            failedExitReason = 'exit_blocked_after_' + MAX_EXIT_ROLL + 'd_roll_from_' + plannedExitDate;
            actualExitDate = null;
            exitDate = null;
          }
        }

        if (exitDate && exitPrice) {
          // Step 4: Compute returns
          forwardReturn = Math.round((exitPrice / entryPrice - 1) * 100 * 100) / 100;

          // Step 5: Benchmark — same T+1 open → T+4 close (use actual exit date)
          var bmEntryBar = getIndexNextBar('sh000001', asOfDate);
          var bmEntryPrice = null;
          if (bmEntryBar) {
            bmEntryPrice = bmEntryBar.open || bmEntryBar.close;
          }
          var bmExitBar = exitDate ? getIndexBarOnDate('sh000001', exitDate) : null;
          var bmExitPrice = null;
          if (bmExitBar) {
            bmExitPrice = bmExitBar.close || bmExitBar.price;
          }

          if (bmEntryPrice && bmEntryPrice > 0 && bmExitPrice && bmExitPrice > 0) {
            forwardBenchmark = Math.round((bmExitPrice / bmEntryPrice - 1) * 100 * 100) / 100;
            forwardExcess = Math.round((forwardReturn - forwardBenchmark - ROUND_TRIP_COST_PCT) * 100) / 100;
          } else {
            forwardBenchmark = null;
            forwardExcess = null;
            targetStatus = 'benchmark_unavailable';
          }

          forwardStatus = 'settled';
          targetStatus = targetStatus === 'benchmark_unavailable' ? 'benchmark_unavailable' : 'settled';
        }
      }
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
      // P1.1: Universe metadata
      universeVersion: UNIVERSE_VERSION,
      universeCoverageStatus: isPreStable ? 'partial' : 'stable',
      survivorshipRisk: SURVIVORSHIP_RISK,
      // P1.1: Feature availability — honest about what data is real
      featureAvailability: FEATURE_AVAILABILITY,
      featureSource: FEATURE_SOURCE,
      signals: hiddenResult ? hiddenResult.signals.map(function (s) { return s.id; }) : [],
      signalCount: hiddenResult ? hiddenResult.signalCount : 0,
      compositeScore: compositeResult ? compositeResult.compositeScore : null,
      rating: compositeResult ? compositeResult.rating : null,
      // P1.1: Null-out unavailable dimensions (only technical and hidden are real)
      // fundamental, capitalFlow, event are null because zero point-in-time data exists
      dimensions: {
        fundamental: null,
        technical: compositeResult && compositeResult.rawScores ? compositeResult.rawScores.technical : null,
        hidden: compositeResult && compositeResult.rawScores ? compositeResult.rawScores.hidden : null,
        capitalFlow: null,
        event: null,
      },
      expectedReturn: expectedReturnVal,
      confidence: confidenceVal,
      evidenceThresholdPassed: confidenceVal != null && confidenceVal >= 0.60,
      financial: financialData,
      regime: regime,
      indexSH: shIdxClose,
      // P0-1: Unified label convention fields
      labelConvention: LABEL_CONVENTION,
      entryDate: entryDate,
      exitDate: exitDate,           // actual exit date (may differ from planned)
      plannedExitDate: plannedExitDate || null,
      actualExitDate: actualExitDate || null,
      exitDelayDays: exitDelayDays,
      exitStatus: exitStatus,       // normal | delayed | failed
      failedExitReason: failedExitReason,
      entryPrice: entryPrice,
      exitPrice: exitPrice,
      targetDateT3: exitDate,  // legacy name kept for compat, now equals exitDate (T+4)
      forwardReturnT3: forwardReturn,   // T+1 open → T+4 close (cost not yet deducted)
      forwardBenchmarkT3: forwardBenchmark, // Benchmark T+1 open → T+4 close
      forwardExcessT3: forwardExcess,   // forwardReturn - benchmark - roundTripCost
      forwardStatus: forwardStatus,     // settled | unavailable
      targetStatus: targetStatus,       // settled | unavailable | benchmark_unavailable | no_exit_date
      unavailableReason: unavailableReason,  // null when settled; reason string when unavailable
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

  // P1.1: Warn if starting before stable period
  var stableStart = UNIVERSE.getStableStartDate();
  if (startDate && startDate < stableStart) {
    console.log('NOTE: Start date ' + startDate + ' is before stable period (' + stableStart + ').');
    console.log('Pre-stable snapshots are marked universeCoverageStatus="partial" — exploration only.');
  }

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
  var endDate = process.argv[3] || '2024-06-05';

  // P1.1: Show universe info
  var stableStart = UNIVERSE.getStableStartDate();
  console.log('=== P1.1: Historical Point-in-Time Snapshot Builder ===');
  console.log('Universe: ' + UNIVERSE_VERSION + ' | Stable start: ' + stableStart);
  console.log('Features available: technical=' + FEATURE_AVAILABILITY.technical +
    ' hidden=' + FEATURE_AVAILABILITY.hidden +
    ' financial=' + FEATURE_AVAILABILITY.financial +
    ' capitalFlow=' + FEATURE_AVAILABILITY.capitalFlow +
    ' event=' + FEATURE_AVAILABILITY.event);
  console.log('Range: ' + startDate + ' to ' + endDate);
  if (startDate < stableStart) {
    console.log('WARNING: Start date is before stable period. Snapshots will be marked "partial".');
  }
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
        try {
          console.log('\nSample record (' + sampleDate + '):');
          console.log(JSON.stringify(JSON.parse(firstLine), null, 2));
        } catch (e) { console.log('(could not parse sample)'); }
      }
    }
  }
}

module.exports = { buildAllSnapshots, buildOneSnapshot, buildKlineIndex, SNAPSHOTS_DIR };
