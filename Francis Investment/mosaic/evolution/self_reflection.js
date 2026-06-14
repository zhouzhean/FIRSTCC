/**
 * self_reflection.js — 自我质疑循环
 *
 * 每天 20:00 运行，执行三个维度：
 *   1. 持仓健康诊断 — 当前持仓的买入理由是否还成立？
 *   2. 错过机会回顾 — 没买但后来涨了的候选股有哪些？
 *   3. 假信号模式挖掘 — 哪些因子触发组合最终导致了亏损？
 *
 * 输出：
 *   - data/simfolio/position_diagnosis.json — 持仓健康报告
 *   - data/simfolio/missed_opportunities.json — 错过机会统计
 *   - data/simfolio/false_signal_patterns.json — 反模式库
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'simfolio');
const EVENTS_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'events');
const SUMMARIES_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'summaries');

var _state = {
  running: false,
  lastRun: null,
  lastResult: null,
  error: null,
};

// ==================== 主函数 ====================

/**
 * 执行完整的自我质疑循环。
 * @param {object} portfolio - Simfolio 当前 portfolio 状态
 * @param {string} dateStr - YYYY-MM-DD
 */
function runSelfReflection(portfolio, dateStr) {
  if (_state.running) {
    console.log('[SelfReflection] 已有任务在运行，跳过');
    return { skipped: true };
  }

  _state.running = true;
  _state.error = null;
  var startTime = Date.now();

  console.log('[SelfReflection] 开始自我质疑循环 (' + dateStr + ')...');

  try {
    var result = {
      date: dateStr,
      time: new Date().toISOString(),
      positionDiagnosis: null,
      missedOpportunities: null,
      falseSignalPatterns: null,
    };

    // 1. 持仓健康诊断
    result.positionDiagnosis = diagnosePositions(portfolio, dateStr);

    // 2. 错过机会回顾
    result.missedOpportunities = reviewMissedOpportunities(portfolio, dateStr, 20);

    // 3. 假信号模式挖掘
    result.falseSignalPatterns = findFalseSignalPatterns(10);

    var duration = Math.round((Date.now() - startTime) / 1000);
    result.durationSec = duration;

    // Save results
    saveReflectionResult(result);

    _state.running = false;
    _state.lastRun = new Date().toISOString();
    _state.lastResult = result;

    console.log('[SelfReflection] 完成: positions=' +
      (result.positionDiagnosis ? result.positionDiagnosis.positions.length : 0) +
      ', missed=' +
      (result.missedOpportunities ? result.missedOpportunities.totalReviewed : 0) +
      ', falsePatterns=' +
      (result.falseSignalPatterns ? result.falseSignalPatterns.patterns.length : 0) +
      ', duration=' + duration + 's');

    return result;

  } catch (e) {
    console.error('[SelfReflection] 错误:', e.message);
    _state.running = false;
    _state.error = e.message;
    return { date: dateStr, error: e.message };
  }
}

// ==================== 1. 持仓健康诊断 ====================

function diagnosePositions(portfolio, dateStr) {
  var positions = (portfolio && portfolio.positions) || [];
  var tradeHistory = (portfolio && portfolio.tradeHistory) || [];

  var diagnoses = [];
  var alerts = [];

  for (var i = 0; i < positions.length; i++) {
    var pos = positions[i];
    var diag = {
      code: pos.code,
      name: pos.name,
      shares: pos.shares,
      avgCost: pos.avgCost,
      currentPrice: pos.currentPrice,
      pnlPct: pos.pnlPct,
      holdingDays: 0,
      buyReasonStatus: 'unknown',
      scoreChanged: null,
      warnings: [],
    };

    // Find the buy trade for this position
    var buyTrade = null;
    for (var j = tradeHistory.length - 1; j >= 0; j--) {
      if (tradeHistory[j].code === pos.code && tradeHistory[j].action === 'buy') {
        buyTrade = tradeHistory[j];
        break;
      }
    }

    if (buyTrade) {
      diag.buyDate = buyTrade.date;
      diag.buyPrice = buyTrade.price;
      diag.buyReason = buyTrade.reason || '';
      diag.buyScore = buyTrade.analysisContext ? buyTrade.analysisContext.compositeScore : null;
      diag.buySignals = buyTrade.analysisContext && buyTrade.analysisContext.hiddenSignals
        ? buyTrade.analysisContext.hiddenSignals.map(function(s) { return s.id; })
        : [];

      // Calculate holding days
      if (buyTrade.date) {
        var buyDate = new Date(buyTrade.date + 'T00:00:00+08:00');
        var nowDate = new Date(dateStr + 'T00:00:00+08:00');
        diag.holdingDays = Math.round((nowDate - buyDate) / 86400000);
      }

      // Check if buy signals are still active or have turned cold
      var stockFactorPerf = loadStockFactorPerf();
      if (stockFactorPerf && stockFactorPerf.factors) {
        var coldFactors = [];
        for (var si = 0; si < diag.buySignals.length; si++) {
          var sigId = diag.buySignals[si];
          var factorPerf = stockFactorPerf.factors.find(function(f) { return f.id === sigId; });
          if (factorPerf && factorPerf.status === 'cold') {
            coldFactors.push(sigId);
          }
        }
        if (coldFactors.length > 0) {
          diag.warnings.push('买入信号变为COLD: ' + coldFactors.join(','));
          diag.buyReasonStatus = 'weakened';
        } else if (diag.buySignals.length > 0) {
          diag.buyReasonStatus = 'intact';
        }
      }

      // Profit/loss status
      if (diag.pnlPct < -5) {
        diag.warnings.push('浮亏超5%: ' + diag.pnlPct.toFixed(1) + '%');
        diag.buyReasonStatus = 'underwater';
      } else if (diag.pnlPct > 10) {
        diag.warnings.push('浮盈超10%: 建议考虑移动止盈');
        diag.buyReasonStatus = 'profitable';
      }
    }

    if (diag.warnings.length > 0) alerts.push(diag);
    diagnoses.push(diag);
  }

  return {
    positions: diagnoses,
    alertCount: alerts.length,
    alerts: alerts,
    summary: alerts.length === 0
      ? '所有持仓买入理由仍然成立，无需关注'
      : alerts.length + ' 只持仓需要关注',
  };
}

// ==================== 2. 错过机会回顾 ====================

function reviewMissedOpportunities(portfolio, dateStr, daysBack) {
  var days = daysBack || 20;
  var holdingCodes = {};
  if (portfolio && portfolio.positions) {
    for (var i = 0; i < portfolio.positions.length; i++) {
      holdingCodes[portfolio.positions[i].code] = true;
    }
  }

  // Collect top5 stocks from recent scan records that weren't bought
  var missedStocks = [];
  var reviewedCount = 0;

  // Find dates to review
  var dates = getRecentTradingDates(days);
  for (var di = 0; di < dates.length; di++) {
    var date = dates[di];
    var scanFile = path.join(DATA_DIR, 'scan_records_' + date + '.json');
    if (!fs.existsSync(scanFile)) continue;

    try {
      var scanRecords = JSON.parse(fs.readFileSync(scanFile, 'utf8'));
      if (!Array.isArray(scanRecords)) continue;

      for (var ri = 0; ri < scanRecords.length; ri++) {
        var scan = scanRecords[ri];
        var top5 = scan.top5 || [];
        for (var ti = 0; ti < top5.length; ti++) {
          var stock = top5[ti];
          if (holdingCodes[stock.code]) continue; // Already bought
          reviewedCount++;

          // Check if this stock appeared on later dates at higher prices
          var futurePerformance = checkFuturePerformance(stock.code, date, dates);
          if (futurePerformance) {
            missedStocks.push({
              code: stock.code,
              name: stock.name,
              date: date,
              score: stock.score || stock.compositeScore || 0,
              rating: stock.rating,
              signals: stock.signals || [],
              future5dReturn: futurePerformance.d5,
              future10dReturn: futurePerformance.d10,
              peakReturn: futurePerformance.peak,
            });
          }
        }
      }
    } catch (_) {}
  }

  // Count winners
  var winners = missedStocks.filter(function(s) { return s.future5dReturn > 0; });
  var losers = missedStocks.filter(function(s) { return s.future5dReturn <= 0; });

  return {
    totalReviewed: reviewedCount,
    missedCount: missedStocks.length,
    winnerCount: winners.length,
    loserCount: losers.length,
    winRate: missedStocks.length > 0
      ? +(winners.length / missedStocks.length).toFixed(2)
      : null,
    avgWinnerReturn: winners.length > 0
      ? +(winners.reduce(function(a, b) { return a + b.future5dReturn; }, 0) / winners.length).toFixed(1)
      : null,
    topMissed: missedStocks
      .sort(function(a, b) { return b.future5dReturn - a.future5dReturn; })
      .slice(0, 10),
    implication: winners.length > losers.length * 1.5
      ? '买入门可能偏严，近' + days + '天错过的候选股中' + Math.round(winners.length / missedStocks.length * 100) + '%后续盈利'
      : missedStocks.length === 0
        ? '无足够数据评判错过情况'
        : '防御门表现合理，多数被拦截的候选股后续未盈利',
  };
}

function checkFuturePerformance(code, fromDate, allDates) {
  // Read stock factor performance for price history
  var stockPerfData = loadStockFactorPerf();
  var dailyRecords = (stockPerfData && stockPerfData.dailyRecords) || {};

  var fromIdx = allDates.indexOf(fromDate);
  if (fromIdx < 0) return null;

  var fromRecords = dailyRecords[fromDate] || [];
  var fromRec = fromRecords.find(function(r) { return r.code === code; });
  if (!fromRec || !fromRec.price) return null;

  var result = { d5: null, d10: null, peak: 0 };
  var peakPrice = fromRec.price;

  // Check at +5 trading days
  var d5Idx = Math.min(fromIdx + 5, allDates.length - 1);
  if (d5Idx > fromIdx) {
    var d5Records = dailyRecords[allDates[d5Idx]] || [];
    var d5Rec = d5Records.find(function(r) { return r.code === code; });
    if (d5Rec && d5Rec.price) {
      result.d5 = +((d5Rec.price - fromRec.price) / fromRec.price * 100).toFixed(1);
      if (d5Rec.price > peakPrice) peakPrice = d5Rec.price;
    }
  }

  // Check at +10 trading days
  var d10Idx = Math.min(fromIdx + 10, allDates.length - 1);
  if (d10Idx > fromIdx) {
    var d10Records = dailyRecords[allDates[d10Idx]] || [];
    var d10Rec = d10Records.find(function(r) { return r.code === code; });
    if (d10Rec && d10Rec.price) {
      result.d10 = +((d10Rec.price - fromRec.price) / fromRec.price * 100).toFixed(1);
      if (d10Rec.price > peakPrice) peakPrice = d10Rec.price;
    }
  }

  result.peak = +((peakPrice - fromRec.price) / fromRec.price * 100).toFixed(1);
  return result;
}

// ==================== 3. 假信号模式挖掘 ====================

function findFalseSignalPatterns(minSamples) {
  var minS = minSamples || 10;
  var stockPerfData = loadStockFactorPerf();
  var dailyRecords = (stockPerfData && stockPerfData.dailyRecords) || {};
  var dates = Object.keys(dailyRecords).sort();

  if (dates.length < 5) return { patterns: [], available: false, reason: '数据不足(需要>=5天)' };

  // For each factor, collect: trigger → did it lose money?
  var factorLosses = {};
  var H_FACTORS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9'];
  for (var fi = 0; fi < H_FACTORS.length; fi++) {
    factorLosses[H_FACTORS[fi]] = { wins: [], losses: [], totalTriggers: 0 };
  }

  for (var di = 0; di < dates.length - 1; di++) {
    var date = dates[di];
    var records = dailyRecords[date] || [];

    // Find target date ~5 trading days later
    var targetIdx = Math.min(di + 5, dates.length - 1);
    if (targetIdx <= di) continue;
    var targetRecords = dailyRecords[dates[targetIdx]] || [];

    for (var ri = 0; ri < records.length; ri++) {
      var rec = records[ri];
      var targetRec = targetRecords.find(function(r) { return r.code === rec.code; });
      if (!targetRec || !targetRec.price || !rec.price || rec.price <= 0) continue;

      var futureReturn = (targetRec.price - rec.price) / rec.price * 100;
      var signals = rec.factorSignals || [];

      var context = {
        code: rec.code,
        date: date,
        score: rec.compositeScore || 0,
        futureReturn: +futureReturn.toFixed(2),
        signals: signals.map(function(s) { return s.id; }),
        numSignals: signals.length,
      };

      for (var si = 0; si < signals.length; si++) {
        var fid = signals[si].id;
        if (!factorLosses[fid]) continue;
        factorLosses[fid].totalTriggers++;
        if (futureReturn > 0) {
          factorLosses[fid].wins.push(context);
        } else {
          factorLosses[fid].losses.push(context);
        }
      }
    }
  }

  // Mine patterns from losses
  var patterns = [];
  for (var fj = 0; fj < H_FACTORS.length; fj++) {
    var fid = H_FACTORS[fj];
    var data = factorLosses[fid];
    if (data.totalTriggers < minS) continue;

    var lossRate = data.totalTriggers > 0 ? data.losses.length / data.totalTriggers : 0;

    if (lossRate >= 0.5 && data.losses.length >= 3) {
      // Analyze what the losses have in common
      var lossScores = data.losses.map(function(l) { return l.score; });
      var avgLossScore = lossScores.length > 0
        ? Math.round(lossScores.reduce(function(a, b) { return a + b; }, 0) / lossScores.length)
        : 0;

      // Common co-occurring signals in losses
      var coSignalCounts = {};
      for (var li = 0; li < data.losses.length; li++) {
        var lossSigs = data.losses[li].signals;
        for (var lsi = 0; lsi < lossSigs.length; lsi++) {
          var sig = lossSigs[lsi];
          if (sig === fid) continue;
          coSignalCounts[sig] = (coSignalCounts[sig] || 0) + 1;
        }
      }

      var commonCoSignals = Object.keys(coSignalCounts)
        .filter(function(k) { return coSignalCounts[k] >= 2; })
        .sort(function(a, b) { return coSignalCounts[b] - coSignalCounts[a]; });

      patterns.push({
        factorId: fid,
        factorName: getFactorName(fid),
        totalTriggers: data.totalTriggers,
        lossCount: data.losses.length,
        lossRate: +lossRate.toFixed(2),
        avgLossScore: avgLossScore,
        avgLossReturn: +(data.losses.reduce(function(a, b) { return a + b.futureReturn; }, 0) / data.losses.length).toFixed(1),
        commonCoSignals: commonCoSignals.slice(0, 3),
        samples: data.losses.slice(0, 5),
      });
    }
  }

  patterns.sort(function(a, b) { return b.lossRate - a.lossRate; });

  return {
    patterns: patterns,
    patternsWithData: patterns.length,
    available: patterns.length > 0,
    summary: patterns.length > 0
      ? '发现 ' + patterns.length + ' 个高失败率信号模式（失败率>=50%）'
      : '所有信号的历史命中率均低于50%失败率，无需标记',
  };
}

// ==================== 工具函数 ====================

function getRecentTradingDates(daysBack) {
  var dates = [];
  var stockPerfData = loadStockFactorPerf();
  var dailyRecords = (stockPerfData && stockPerfData.dailyRecords) || {};
  var allDates = Object.keys(dailyRecords).sort();
  return allDates.slice(-daysBack);
}

function loadStockFactorPerf() {
  var filePath = path.join(DATA_DIR, 'stock_factor_performance.json');
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return null; }
}

function getFactorName(id) {
  var map = {
    H1: '缩量止跌', H2: '底部放量', H3: '逆势抗跌',
    H4: 'PE低估', H5: '高ROE低PB', H6: '现金流健康',
    H7: '低换手蓄力', H8: '短期反转', H9: '量价背离',
  };
  return map[id] || id;
}

function saveReflectionResult(result) {
  try {
    var filePath = path.join(DATA_DIR, 'self_reflection_result.json');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf8');
  } catch (_) {}
}

function loadReflectionResult() {
  var filePath = path.join(DATA_DIR, 'self_reflection_result.json');
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return null; }
}

function getStatus() {
  return {
    running: _state.running,
    lastRun: _state.lastRun,
    lastResult: _state.lastResult || loadReflectionResult(),
    error: _state.error,
  };
}

module.exports = {
  runSelfReflection,
  getStatus,
  loadReflectionResult,
};
