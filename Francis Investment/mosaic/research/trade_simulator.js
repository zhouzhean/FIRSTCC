/**
 * P1.1-C: Honest Trade Simulator
 *
 * Simulates portfolio execution with realistic Chinese A-share constraints:
 *  - T day close: signal formed
 *  - T+1 open: entry price
 *  - T+N close: exit price (N = holdDays, default 3)
 *  - Suspension: volume === 0 → unavailable
 *  - Limit-up: close >= high && changePct >= 9.8% → untradeable
 *  - Limit-down: close <= low && changePct <= -9.8% → untradeable
 *  - Benchmark: same T+1 open entry, T+N close exit (SH index)
 *
 * Tracks: NAV time series, turnover, max drawdown (peak-to-trough on NAV),
 * untradeable rate, gross return, cost-adjusted excess.
 *
 * Output: report-engine/data/research/trade_simulation/portfolio_nav.jsonl
 */

var fs = require('fs');
var path = require('path');

var CALENDAR = require('./universal_calendar');

var BASE_DIR = path.join(__dirname, '..', '..');
var KLINES_DIR = path.join(BASE_DIR, 'report-engine', 'data', 'klines');
var INDICES_DIR = path.join(BASE_DIR, 'report-engine', 'data', 'market_history', 'indices');
var RESEARCH_DIR = path.join(BASE_DIR, 'report-engine', 'data', 'research');
var SIM_DIR = path.join(RESEARCH_DIR, 'trade_simulation');

// Round-trip cost: 0.025% commission × 2 + 0.1% stamp tax + 0.001% transfer × 2 + 0.15% slip × 2
var ROUND_TRIP_COST_PCT = 0.025 * 2 + 0.1 + 0.001 * 2 + 0.15 * 2;
var INITIAL_CAPITAL = 100000;
var MAX_POSITIONS = 50; // Equal-weight top-N
var HOLD_DAYS = 3;

// ---- K-line helpers ----

function getNextBar(klineIdx, code, fromDate) {
  var bars = klineIdx[code];
  if (!bars || bars.length === 0) return null;
  for (var i = 0; i < bars.length - 1; i++) {
    if (bars[i].date === fromDate || bars[i].date > fromDate) {
      if (bars[i].date >= fromDate) return bars[i];
      return bars[i + 1];
    }
  }
  return null;
}

function getBarOnDate(klineIdx, code, date) {
  var bars = klineIdx[code];
  if (!bars) return null;
  for (var i = 0; i < bars.length; i++) {
    if (bars[i].date === date) return bars[i];
  }
  return null;
}

function getNextTradingBar(klineIdx, code, fromDate) {
  // Find the next available kline bar after fromDate
  var bars = klineIdx[code];
  if (!bars) return null;
  for (var i = 0; i < bars.length; i++) {
    if (bars[i].date > fromDate) return bars[i];
  }
  return null;
}

// ---- Tradeability checks ----

function isTradeable(code, date, klineIdx) {
  var bar = getBarOnDate(klineIdx, code, date);
  if (!bar) return { tradeable: false, reason: 'no_data' };

  // Suspended: zero volume
  if (!bar.volume || bar.volume === 0) {
    return { tradeable: false, reason: 'suspended' };
  }

  // Need prev close for limit checks
  var prevBar = getPrevBar(klineIdx, code, date);
  if (!prevBar || prevBar.close <= 0) {
    return { tradeable: true, reason: 'ok', bar: bar }; // Can't check limits without prev close
  }

  var changePct = (bar.close / prevBar.close - 1) * 100;

  // Limit-up: close >= high (meaning it hit limit up) and change near +10%
  if (bar.close >= bar.high && changePct >= 9.5) {
    return { tradeable: false, reason: 'limit_up', changePct: Math.round(changePct * 100) / 100 };
  }

  // Limit-down: close <= low and change near -10%
  if (bar.close <= bar.low && changePct <= -9.5) {
    return { tradeable: false, reason: 'limit_down', changePct: Math.round(changePct * 100) / 100 };
  }

  return { tradeable: true, reason: 'ok', bar: bar };
}

function getPrevBar(klineIdx, code, date) {
  var bars = klineIdx[code];
  if (!bars) return null;
  for (var i = bars.length - 1; i > 0; i--) {
    if (bars[i].date < date) return bars[i];
  }
  return null;
}

// ---- Entry / Exit price ----

function getEntryPrice(code, signalDate, klineIdx) {
  // T+1 open: next trading day's open price
  var nextBar = getNextTradingBar(klineIdx, code, signalDate);
  if (!nextBar) return { price: null, date: null, available: false, reason: 'no_next_day_data' };
  if (!nextBar.open || nextBar.open <= 0) return { price: null, date: nextBar.date, available: false, reason: 'no_open_price' };

  // Check if tradeable on entry day
  var tradeable = isTradeable(code, nextBar.date, klineIdx);
  if (!tradeable.tradeable) {
    return { price: null, date: nextBar.date, available: false, reason: 'entry_day_' + tradeable.reason };
  }

  return { price: nextBar.open, date: nextBar.date, available: true, reason: 'ok' };
}

function getExitPrice(code, entryDate, holdDays, klineIdx) {
  // Exit at T+N close
  var targetDate = CALENDAR.getTradingDay(entryDate, holdDays);
  if (!targetDate) return { price: null, date: null, available: false, reason: 'no_target_date' };

  var bar = getBarOnDate(klineIdx, code, targetDate);
  if (!bar) return { price: null, date: targetDate, available: false, reason: 'no_exit_data' };
  if (!bar.close || bar.close <= 0) return { price: null, date: targetDate, available: false, reason: 'bad_close' };

  return { price: bar.close, date: targetDate, available: true, reason: 'ok' };
}

// ---- Index (benchmark) helpers ----

var _indexCache = {};

function loadIndexKlines(indexCode) {
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

function getIndexBar(indexCode, date) {
  var arr = loadIndexKlines(indexCode);
  if (!arr) return null;
  for (var i = 0; i < arr.length; i++) {
    var item = arr[i];
    var d = item.date || item.tradeDate;
    if (d === date) return item;
  }
  return null;
}

function getIndexNextBar(indexCode, fromDate) {
  var arr = loadIndexKlines(indexCode);
  if (!arr) return null;
  for (var i = 0; i < arr.length; i++) {
    var item = arr[i];
    var d = item.date || item.tradeDate;
    if (d > fromDate) return item;
  }
  return null;
}

// ---- Main simulation ----

function simulatePortfolio(dailySignals, options) {
  // dailySignals: map of signalDate → [{code, ...}] — ranked lists per date
  // options: {holdDays, initialCapital, maxPositions, topN}
  var opts = options || {};
  var holdDays = opts.holdDays || HOLD_DAYS;
  var initialCapital = opts.initialCapital || INITIAL_CAPITAL;
  var maxPositions = opts.maxPositions || MAX_POSITIONS;
  var topN = opts.topN || 50;

  // Pre-load kline index (lazy)
  var klineIdx = {};
  if (opts.klineIdx) {
    klineIdx = opts.klineIdx;
  } else {
    var files = fs.readdirSync(KLINES_DIR).filter(function (f) { return f.endsWith('.json'); });
    files.forEach(function (f) {
      try {
        var raw = fs.readFileSync(path.join(KLINES_DIR, f), 'utf8');
        var data = JSON.parse(raw);
        var code = f.replace('.json', '');
        var bars = data.klines || (Array.isArray(data) ? data : []);
        bars.sort(function (a, b) { return (a.date || '').localeCompare(b.date || ''); });
        klineIdx[code] = bars;
      } catch (e) { /* skip */ }
    });
  }

  var signalDates = Object.keys(dailySignals).sort();
  if (signalDates.length === 0) return { error: 'no_signals', nav: [] };

  // Initialize portfolio state
  var nav = initialCapital;
  var cash = initialCapital;
  var positions = []; // [{code, entryPrice, entryDate, exitDate, exitPrice, shares, cost}]
  var navSeries = []; // [{date, nav, cash, positionsValue, positionsCount}]
  var trades = [];
  var allDates = [];

  // Collect all trading days in simulation range
  var firstSignalDate = signalDates[0];
  var lastSignalDate = signalDates[signalDates.length - 1];
  var tradingDays = CALENDAR.loadCalendar();
  for (var t = 0; t < tradingDays.length; t++) {
    if (tradingDays[t] >= firstSignalDate && tradingDays[t] <= lastSignalDate) {
      allDates.push(tradingDays[t]);
    }
  }

  // Track summary stats
  var totalSignals = 0;
  var executedTrades = 0;
  var unavailableSignals = 0;
  var unavailableReasons = {};

  // Walk through each trading day
  var peakNav = initialCapital;
  var maxDrawdown = 0;
  var totalTurnover = 0;

  allDates.forEach(function (currentDate, di) {
    // 1. Check for position exits
    var exitedValue = 0;
    positions = positions.filter(function (pos) {
      if (pos.exitDate === currentDate) {
        // Close position
        var exitPrice = pos._exitPrice;
        var grossProceeds = pos.shares * exitPrice;
        var cost = grossProceeds * (ROUND_TRIP_COST_PCT / 100 / 2); // Sell half of round-trip
        var netProceeds = grossProceeds - cost;
        cash += netProceeds;
        exitedValue += grossProceeds;

        // Record trade
        pos.exitPrice = exitPrice;
        pos.grossReturn = (exitPrice / pos.entryPrice - 1) * 100;
        pos.netReturn = pos.grossReturn - ROUND_TRIP_COST_PCT;
        trades.push(pos);
        totalTurnover += pos.entryPrice * pos.shares; // Entry turnover
        return false; // Remove from positions
      }
      return true;
    });

    // 2. Value remaining positions at close
    var positionsValue = 0;
    positions.forEach(function (pos) {
      var bar = getBarOnDate(klineIdx, pos.code, currentDate);
      if (bar && bar.close > 0) {
        pos._currentPrice = bar.close;
        positionsValue += pos.shares * bar.close;
      } else {
        // Use last known price if no data today
        positionsValue += pos.shares * (pos._currentPrice || pos.entryPrice);
      }
    });

    // 3. Record NAV
    var currentNav = cash + positionsValue;
    if (currentNav > peakNav) peakNav = currentNav;
    var drawdown = peakNav > 0 ? (peakNav - currentNav) / peakNav : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    navSeries.push({
      date: currentDate,
      nav: Math.round(currentNav * 100) / 100,
      cash: Math.round(cash * 100) / 100,
      positionsValue: Math.round(positionsValue * 100) / 100,
      positionsCount: positions.length,
      drawdown: Math.round(drawdown * 10000) / 100, // basis points
    });

    // 4. Process new signals for this date
    var todaySignals = dailySignals[currentDate];
    if (!todaySignals || todaySignals.length === 0) return;

    // Take top N signals that aren't already in positions
    var existingCodes = {};
    positions.forEach(function (p) { existingCodes[p.code] = true; });

    var buyCandidates = [];
    for (var i = 0; i < todaySignals.length && buyCandidates.length < maxPositions; i++) {
      var sig = todaySignals[i];
      if (!sig || !sig.code) continue;
      if (existingCodes[sig.code]) continue;
      totalSignals++;

      if (positions.length + buyCandidates.length >= maxPositions) break;

      // Get T+1 entry price
      var entry = getEntryPrice(sig.code, currentDate, klineIdx);
      if (!entry.available) {
        unavailableSignals++;
        var reason = entry.reason || 'unknown';
        unavailableReasons[reason] = (unavailableReasons[reason] || 0) + 1;
        continue;
      }

      // Get T+N exit price
      var exit = getExitPrice(sig.code, entry.date, holdDays, klineIdx);
      if (!exit.available) {
        unavailableSignals++;
        var ereason = 'exit_' + (exit.reason || 'unknown');
        unavailableReasons[ereason] = (unavailableReasons[ereason] || 0) + 1;
        continue;
      }

      buyCandidates.push({
        code: sig.code,
        entryDate: entry.date,
        entryPrice: entry.price,
        exitDate: exit.date,
        exitPrice: exit.price,
      });
    }

    // Execute buys (rebalance at end of day after recording NAV)
    if (buyCandidates.length > 0) {
      var positionsAfter = positions.length + buyCandidates.length;
      var capitalPerPosition = Math.min(cash / buyCandidates.length, initialCapital / maxPositions);

      buyCandidates.forEach(function (c) {
        var shares = Math.floor(capitalPerPosition / c.entryPrice);
        if (shares <= 0) { unavailableSignals++; return; }
        var cost = shares * c.entryPrice;
        if (cost > cash) { unavailableSignals++; return; }

        var entryCost = cost * (ROUND_TRIP_COST_PCT / 100 / 2); // Buy half of round-trip
        var totalCost = cost + entryCost;
        if (totalCost > cash) { unavailableSignals++; return; }

        cash -= totalCost;
        executedTrades++;

        positions.push({
          code: c.code,
          entryPrice: c.entryPrice,
          entryDate: c.entryDate,
          exitDate: c.exitDate,
          _exitPrice: c.exitPrice,
          shares: shares,
          signalDate: currentDate,
          _currentPrice: c.entryPrice,
        });
      });
    }
  });

  // Compute final metrics
  var finalNav = navSeries.length > 0 ? navSeries[navSeries.length - 1].nav : initialCapital;
  var grossReturn = (finalNav / initialCapital - 1) * 100;
  var coverageRate = totalSignals > 0 ? Math.round((totalSignals - unavailableSignals) / totalSignals * 10000) / 100 : 0;
  var untradeableRate = totalSignals > 0 ? Math.round(unavailableSignals / totalSignals * 10000) / 100 : 0;
  var avgDailyTurnover = navSeries.length > 0 ? Math.round(totalTurnover / navSeries.length * 100) / 100 : 0;

  // Benchmark: buy-and-hold SH index with same entry/exit timing
  var benchmarkReturn = computeBenchmarkReturn(signalDates, holdDays);

  var costAdjustedExcess = grossReturn - ROUND_TRIP_COST_PCT * (executedTrades / Math.max(totalSignals, 1)) - benchmarkReturn;

  // Sharpe ratio (simplified — daily returns)
  var dailyReturns = [];
  for (var i = 1; i < navSeries.length; i++) {
    var prev = navSeries[i - 1].nav;
    var curr = navSeries[i].nav;
    if (prev > 0) dailyReturns.push((curr - prev) / prev);
  }
  var sharpeRatio = null;
  if (dailyReturns.length > 1) {
    var meanRet = dailyReturns.reduce(function (a, b) { return a + b; }, 0) / dailyReturns.length;
    var varRet = dailyReturns.reduce(function (s, r) { return s + (r - meanRet) * (r - meanRet); }, 0) / (dailyReturns.length - 1);
    if (varRet > 0) sharpeRatio = Math.round(meanRet / Math.sqrt(varRet) * Math.sqrt(252) * 100) / 100;
  }

  return {
    initialCapital: initialCapital,
    finalNav: Math.round(finalNav * 100) / 100,
    grossReturn: Math.round(grossReturn * 100) / 100,
    benchmarkReturn: Math.round(benchmarkReturn * 100) / 100,
    costAdjustedExcess: Math.round(costAdjustedExcess * 100) / 100,
    roundTripCostPct: ROUND_TRIP_COST_PCT,
    coverageRate: coverageRate,
    untradeableRate: untradeableRate,
    maxDrawdown: Math.round(maxDrawdown * 10000) / 100, // basis points
    sharpeRatio: sharpeRatio,
    totalSignals: totalSignals,
    executedTrades: executedTrades,
    unavailableSignals: unavailableSignals,
    unavailableReasons: unavailableReasons,
    avgDailyTurnover: avgDailyTurnover,
    totalTurnover: totalTurnover,
    trades: trades,
    navSeries: navSeries,
    navDates: allDates,
  };
}

function computeBenchmarkReturn(signalDates, holdDays) {
  // Benchmark: buy SH index at T+1 open, sell at T+N close — same timing as stocks
  var totalReturn = 0;
  var count = 0;

  signalDates.forEach(function (signalDate) {
    var entryBar = getIndexNextBar('sh000001', signalDate);
    if (!entryBar) return;

    var entryOpen = entryBar.open || entryBar.close;
    if (!entryOpen || entryOpen <= 0) return;

    var exitDate = CALENDAR.getTradingDay(entryBar.date || signalDate, holdDays);
    if (!exitDate) return;

    var exitBar = getIndexBar('sh000001', exitDate);
    if (!exitBar) return;

    var exitClose = exitBar.close || exitBar.price;
    if (!exitClose || exitClose <= 0) return;

    totalReturn += (exitClose / entryOpen - 1) * 100;
    count++;
  });

  return count > 0 ? totalReturn / count : 0;
}

// ---- Output helpers ----

function writeSimulationResult(result, outputPath) {
  if (!fs.existsSync(SIM_DIR)) fs.mkdirSync(SIM_DIR, { recursive: true });

  // Write NAV series
  var navPath = outputPath || path.join(SIM_DIR, 'portfolio_nav.jsonl');
  var lines = result.navSeries.map(function (n) { return JSON.stringify(n); }).join('\n') + '\n';
  fs.writeFileSync(navPath, lines, 'utf8');

  // Write summary
  var summaryPath = path.join(SIM_DIR, 'trade_simulation_summary.json');
  var summary = {
    initialCapital: result.initialCapital,
    finalNav: result.finalNav,
    grossReturn: result.grossReturn,
    benchmarkReturn: result.benchmarkReturn,
    costAdjustedExcess: result.costAdjustedExcess,
    coverageRate: result.coverageRate,
    untradeableRate: result.untradeableRate,
    maxDrawdownBps: result.maxDrawdown,
    sharpeRatio: result.sharpeRatio,
    totalSignals: result.totalSignals,
    executedTrades: result.executedTrades,
    unavailableSignals: result.unavailableSignals,
    unavailableReasons: result.unavailableReasons,
    tradeCount: result.trades.length,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log('NAV written to ' + navPath);
  console.log('Summary written to ' + summaryPath);
}

// ---- CLI ----

if (require.main === module) {
  console.log('=== P1.1-C: Honest Trade Simulator ===');
  console.log('T+1 open entry | T+' + HOLD_DAYS + ' close exit | Round-trip cost: ' + ROUND_TRIP_COST_PCT + '%');
  console.log();

  // Test on one date's ranked stocks
  var testDate = process.argv[2] || '2024-06-03';
  var SNAPSHOTS_DIR = path.join(RESEARCH_DIR, 'snapshots');
  var testFile = path.join(SNAPSHOTS_DIR, testDate + '.jsonl');

  if (!fs.existsSync(testFile)) {
    console.error('Snapshot not found for ' + testDate);
    process.exit(1);
  }

  // Load snapshots for one date, rank them
  var snapshots = [];
  var lines = fs.readFileSync(testFile, 'utf8').trim().split('\n');
  lines.forEach(function (line) {
    if (!line) return;
    try { snapshots.push(JSON.parse(line)); } catch (e) {}
  });

  // Rank using technical-only baseline
  var TECH = require('./technical_baseline');
  var ranked = TECH.rankByTechnicalOnly(snapshots);
  console.log('Ranked ' + ranked.length + ' stocks for ' + testDate + ' (technical-only)');

  // Simulate
  var dailySignals = {};
  dailySignals[testDate] = ranked.map(function (r) { return { code: r.code }; });

  var result = simulatePortfolio(dailySignals, { holdDays: HOLD_DAYS, topN: 50 });
  console.log();
  console.log('--- Simulation Result ---');
  console.log('Initial: ¥' + result.initialCapital.toLocaleString());
  console.log('Final:   ¥' + result.finalNav.toLocaleString());
  console.log('Gross return: ' + result.grossReturn + '%');
  console.log('Benchmark:    ' + result.benchmarkReturn + '%');
  console.log('Cost-adj excess: ' + result.costAdjustedExcess + '%');
  console.log('Max drawdown: ' + result.maxDrawdown + ' bps');
  console.log('Sharpe: ' + result.sharpeRatio);
  console.log('Coverage: ' + result.coverageRate + '% | Untradeable: ' + result.untradeableRate + '%');
  console.log('Trades: ' + result.executedTrades + ' / ' + result.totalSignals + ' signals');
  console.log('Unavailable reasons:', JSON.stringify(result.unavailableReasons));

  writeSimulationResult(result);
}

module.exports = { simulatePortfolio, getEntryPrice, getExitPrice, isTradeable, HOLD_DAYS, INITIAL_CAPITAL, ROUND_TRIP_COST_PCT };
