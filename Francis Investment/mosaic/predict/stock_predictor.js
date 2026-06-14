/**
 * stock_predictor.js — 个股级别预测引擎
 *
 * 追踪每只股票触发每个因子后的实际个股收益（非大盘），
 * 计算每个因子在个股级别的预测能力和期望收益。
 *
 * 数据流：
 *   Pipeline 扫描完成 → 记录每只股票触发的因子
 *   → 次日/3日/5日后取该股票实际涨跌幅
 *   → 计算：该因子在该股票上触发后，未来1/3/5天的收益分布
 *   → 存入 stock_factor_performance.json
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'simfolio');
const STOCK_PERF_FILE = path.join(DATA_DIR, 'stock_factor_performance.json');

const FACTORS = [
  { id: 'H1', name: '缩量止跌' },
  { id: 'H2', name: '底部放量' },
  { id: 'H3', name: '逆势抗跌' },
  { id: 'H4', name: 'PE低估' },
  { id: 'H5', name: '高ROE低PB' },
  { id: 'H6', name: '现金流健康' },
  { id: 'H7', name: '低换手蓄力' },
  { id: 'H8', name: '短期反转' },
  { id: 'H9', name: '量价背离' },
];

/**
 * 记录每日 Pipeline 扫描结果中每只股票的因子触发情况。
 * 由 scheduler 在 pipeline 完成后调用。
 *
 * @param {string} date - YYYY-MM-DD
 * @param {Array} allResults - Pipeline 扫描的全部股票结果
 */
function recordDailyStockSignals(date, allResults) {
  if (!allResults || allResults.length === 0) return;

  const records = [];
  for (const r of allResults) {
    if (!r.code || !r.hiddenSignals || r.hiddenSignals.length === 0) continue;

    // Extract raw dimension scores from composite result (if available)
    var rawScores = null;
    if (r.rawScores) {
      rawScores = {
        fundamental: r.rawScores.fundamental != null ? r.rawScores.fundamental : null,
        technical: r.rawScores.technical != null ? r.rawScores.technical : null,
        hidden: r.rawScores.hidden != null ? r.rawScores.hidden : null,
        capitalFlow: r.rawScores.capitalFlow != null ? r.rawScores.capitalFlow : null,
        event: r.rawScores.event != null ? r.rawScores.event : null,
      };
    }

    records.push({
      code: r.code,
      name: r.name || '',
      price: r.price || 0,
      compositeScore: r.compositeScore || 0,
      pe: r.pe != null ? r.pe : null,
      pb: r.pb != null ? r.pb : null,
      turnover: r.turnover != null ? r.turnover : null,
      turnoverRate: r.turnoverRate != null ? r.turnoverRate : null,
      marketCap: r.marketCap != null ? r.marketCap : null,
      changePercent: r.changePercent != null ? r.changePercent : null,
      rawScores: rawScores,
      factorSignals: r.hiddenSignals.map(function(s) { return { id: s.id, level: s.level }; }),
    });
  }

  if (records.length === 0) return;

  // Load existing data
  let data = loadStockPerfData();

  // Add today's records
  if (!data.dailyRecords) data.dailyRecords = {};
  data.dailyRecords[date] = records;

  // Keep last 60 days
  const dates = Object.keys(data.dailyRecords).sort();
  if (dates.length > 60) {
    for (const oldDate of dates.slice(0, dates.length - 60)) {
      delete data.dailyRecords[oldDate];
    }
  }

  saveStockPerfData(data);
}

/**
 * 计算个股级别因子绩效。
 * 对每个有足够数据的日期，检查因子触发的股票在后续 1/3/5 天的实际收益。
 *
 * 如果 stock_factor_performance.json 已由夜间回测引擎标记 backtestVerified=true，
 * 则优先使用回测验证的统计数据（基于真实K线），而非从 dailyRecords 粗糙估算。
 *
 * @param {number} minSamples - 最少需要多少个样本才输出结果（默认 5）
 * @returns {object} 各因子的个股级别绩效
 */
function computeStockFactorPerformance(minSamples) {
  const minS = minSamples || 5;
  const data = loadStockPerfData();
  const dailyRecords = data.dailyRecords || {};
  const dates = Object.keys(dailyRecords).sort();

  if (dates.length < 2) {
    return { available: false, message: '至少需要2天数据', factors: [], updatedAt: new Date().toISOString() };
  }

  // === P0: 优先使用夜间回测验证的因子统计（基于真实K线） ===
  if (data.backtestVerified && data.backtestStats && data.backtestStats.factors) {
    var btFactors = data.backtestStats.factors;
    var factors = [];
    for (var fi = 0; fi < FACTORS.length; fi++) {
      var f = FACTORS[fi];
      var bt = btFactors.find(function(x) { return x.id === f.id; }) || null;
      if (bt && bt.totalSamples >= minS) {
        factors.push({
          id: f.id,
          name: f.name,
          perf1d: bt.perf1d || { totalSamples: 0, hitRate: null, avgReturn: null },
          perf3d: bt.perf3d || { totalSamples: 0, hitRate: null, avgReturn: null },
          perf5d: bt.perf5d || { totalSamples: 0, hitRate: null, avgReturn: null },
          totalSamples: bt.totalSamples,
          hitRate: bt.hitRate,
          avgReturn: bt.avgReturn,
          status: bt.status || 'stable',
          _source: 'backtest',
        });
      } else {
        // Factor not in backtest data — fallback placeholder
        factors.push({ id: f.id, name: f.name, perf1d: { totalSamples: 0 }, perf3d: { totalSamples: 0 }, perf5d: { totalSamples: 0 }, totalSamples: 0, hitRate: null, avgReturn: null, status: 'stable', _source: 'backtest_partial' });
      }
    }
    var totalTriggered = factors.reduce(function(a, b) { return a + b.totalSamples; }, 0);
    return {
      available: totalTriggered >= minS,
      factors: factors,
      summary: {
        updatedAt: data.backtestLastRun || data.updatedAt || new Date().toISOString(),
        totalDays: dates.length,
        totalStockTriggers: totalTriggered,
        minSamples: minS,
        source: '夜间K线回测验证',
      },
    };
  }

  // === 回退：从 dailyRecords 估算（旧逻辑） ===
  const factorOutcomes = {};
  for (const f of FACTORS) {
    factorOutcomes[f.id] = { triggers1d: [], triggers3d: [], triggers5d: [] };
  }

  const stockPriceCache = buildStockPriceCache(dailyRecords);

  for (let i = 0; i < dates.length - 1; i++) {
    const date = dates[i];
    const records = dailyRecords[date] || [];

    for (const rec of records) {
      const future1d = getStockFutureReturn(rec.code, date, 1, dates, dailyRecords, stockPriceCache);
      const future3d = getStockFutureReturn(rec.code, date, 3, dates, dailyRecords, stockPriceCache);
      const future5d = getStockFutureReturn(rec.code, date, 5, dates, dailyRecords, stockPriceCache);

      for (const sig of rec.factorSignals) {
        const fid = sig.id;
        if (!factorOutcomes[fid]) continue;
        if (future1d != null) factorOutcomes[fid].triggers1d.push({ code: rec.code, date, return_: future1d });
        if (future3d != null) factorOutcomes[fid].triggers3d.push({ code: rec.code, date, return_: future3d });
        if (future5d != null) factorOutcomes[fid].triggers5d.push({ code: rec.code, date, return_: future5d });
      }
    }
  }

  const factors2 = [];
  for (const f of FACTORS) {
    const outcomes = factorOutcomes[f.id];
    const perf1d = computeOutcomeStats(outcomes.triggers1d);
    const perf3d = computeOutcomeStats(outcomes.triggers3d);
    const perf5d = computeOutcomeStats(outcomes.triggers5d);

    const totalSamples = perf5d.totalSamples;
    const hitRate = perf5d.hitRate;
    const avgReturn = perf5d.avgReturn;

    let status = 'stable';
    if (totalSamples >= minS) {
      if (hitRate != null && hitRate >= 0.55) status = 'hot';
      else if (hitRate != null && hitRate < 0.40) status = 'cold';
    }

    factors2.push({
      id: f.id,
      name: f.name,
      perf1d: perf1d,
      perf3d: perf3d,
      perf5d: perf5d,
      totalSamples: totalSamples,
      hitRate: hitRate,
      avgReturn: avgReturn,
      status: status,
      _source: 'dailyRecords_approx',
    });
  }

  let totalTriggered2 = 0;
  for (const f of factors2) totalTriggered2 += f.totalSamples;

  return {
    available: totalTriggered2 >= minS,
    factors: factors2,
    summary: {
      updatedAt: new Date().toISOString(),
      totalDays: dates.length,
      totalStockTriggers: totalTriggered2,
      minSamples: minS,
      source: '每日记录估算(待夜间回测)',
    },
  };
}

/**
 * 获取单只股票在指定日期后 N 个交易日的价格变动。
 * 从 dailyRecords 中该股票后续出现的价格来推断。
 */
function getStockFutureReturn(code, fromDate, daysAhead, allDates, dailyRecords, priceCache) {
  // Find the date that is 'daysAhead' trading days after fromDate
  const fromIdx = allDates.indexOf(fromDate);
  if (fromIdx < 0) return null;

  // Simply use the N-th subsequent date (rough approximation for trading days)
  const targetIdx = Math.min(fromIdx + daysAhead, allDates.length - 1);
  if (targetIdx <= fromIdx) return null;

  const targetDate = allDates[targetIdx];

  // Look for the stock in daily records on the target date
  const targetRecords = dailyRecords[targetDate] || [];
  const stockRec = targetRecords.find(r => r.code === code);
  if (stockRec && stockRec.price > 0) {
    // Find the original price
    const fromRecords = dailyRecords[fromDate] || [];
    const fromRec = fromRecords.find(r => r.code === code);
    if (fromRec && fromRec.price > 0) {
      return ((stockRec.price - fromRec.price) / fromRec.price * 100);
    }
  }

  // Fallback: use compositeScore change as rough proxy (not ideal but better than nothing)
  return null;
}

/**
 * Build a cache of stock prices from daily records for faster lookup.
 */
function buildStockPriceCache(dailyRecords) {
  const cache = {}; // { code: { date: price } }
  for (const [date, records] of Object.entries(dailyRecords)) {
    for (const rec of records) {
      if (!cache[rec.code]) cache[rec.code] = {};
      cache[rec.code][date] = rec.price;
    }
  }
  return cache;
}

/**
 * Compute hit rate and average return from a list of outcomes.
 */
function computeOutcomeStats(triggers) {
  if (!triggers || triggers.length === 0) {
    return { totalSamples: 0, hitRate: null, avgReturn: null, winLossRatio: null };
  }

  const returns = triggers.map(t => t.return_).filter(r => r != null);
  if (returns.length === 0) {
    return { totalSamples: 0, hitRate: null, avgReturn: null, winLossRatio: null };
  }

  const hits = returns.filter(r => r > 0).length;
  const losses = returns.filter(r => r <= 0).length;
  const hitRate = +(hits / returns.length).toFixed(3);
  const avgReturn = +(returns.reduce((a, b) => a + b, 0) / returns.length).toFixed(2);
  const winLossRatio = losses > 0 ? +(hits / losses).toFixed(2) : (hits > 0 ? 999 : 0);

  return {
    totalSamples: returns.length,
    hitRate: hitRate,
    avgReturn: avgReturn,
    winLossRatio: winLossRatio,
    bestReturn: +Math.max(...returns).toFixed(2),
    worstReturn: +Math.min(...returns).toFixed(2),
    recentSamples: triggers.slice(-20).map(t => ({ code: t.code, date: t.date, return_: t.return_ })),
  };
}

/**
 * 获取当前 COLD 的因子 ID 集合（个股级别）。
 */
function getColdStockFactors() {
  const perf = computeStockFactorPerformance(3);
  const cold = new Set();
  if (!perf.factors) return cold;
  for (const f of perf.factors) {
    if (f.status === 'cold' && f.totalSamples >= 3 && f.hitRate != null && f.hitRate < 0.40) {
      cold.add(f.id);
    }
  }
  return cold;
}

// ---- Persistence ----

function loadStockPerfData() {
  if (!fs.existsSync(STOCK_PERF_FILE)) {
    return { dailyRecords: {}, updatedAt: null };
  }
  try {
    return JSON.parse(fs.readFileSync(STOCK_PERF_FILE, 'utf8'));
  } catch (_) {
    return { dailyRecords: {}, updatedAt: null };
  }
}

function saveStockPerfData(data) {
  try {
    const dir = path.dirname(STOCK_PERF_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(STOCK_PERF_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) { /* silent */ }
}

module.exports = {
  FACTORS,
  recordDailyStockSignals,
  computeStockFactorPerformance,
  getColdStockFactors,
  loadStockPerfData,
};
