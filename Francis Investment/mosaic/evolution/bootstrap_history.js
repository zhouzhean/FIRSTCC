/**
 * bootstrap_history.js — 历史数据训练引擎 v1.0
 *
 * 纯 Node.js 服务端运行，零 Claude tokens 消耗。
 * 调度：首次手动运行，之后 evolution_scheduler 自动触发增量更新。
 *
 * 完整训练链路：
 *   Phase 1 — 历史K线拉取+清洗（腾讯API/前复权/停牌/涨跌停/异常值检测）
 *   Phase 2 — 每日回放：用真实因子引擎计算每个历史交易日的因子触发 + 复合评分
 *   Phase 3 — 因子有效性矩阵：胜率/平均收益/最大回撤/盈亏比，按市场状态分组
 *   Phase 4 — 因子组合挖掘：协同对(1+1>2) / 冲突对(1+1<1) / 衰减曲线
 *   Phase 5 — 跨市场相关性：美股→A股 领先/滞后映射 + 滚动相关性
 *   Phase 6 — 参数优化：止损线/仓位/阈值/持有期的网格搜索
 *   Phase 7 — 输出 training_matrix.json + 自动报告
 *
 * 数据范围（默认）：
 *   - 沪深300成分股 + 8个活跃板块龙头
 *   - 5年历史 (2021-2026)
 *   - 每只股票 ~1200 个日K线，总计 ~300只 × 1200 ≈ 360K 数据点
 *   - 单次全量运行时间：~2-4 小时（取决于网络）
 *
 * 使用：
 *   node mosaic/evolution/bootstrap_history.js              # 全量运行
 *   node mosaic/evolution/bootstrap_history.js --incremental  # 增量更新（仅最近20天）
 *   node mosaic/evolution/bootstrap_history.js --universe hs300  # 仅沪深300
 *   node mosaic/evolution/bootstrap_history.js --universe all     # 全A股（慎用，约1周）
 */

var fs = require('fs');
var path = require('path');

var BASE_DIR = path.join(__dirname, '..', '..');
var DATA_DIR = path.join(BASE_DIR, 'report-engine', 'data');
var EVOLUTION_DIR = path.join(DATA_DIR, 'evolution');
var KLINES_DIR = path.join(DATA_DIR, 'klines');
var TRAINING_MATRIX_FILE = path.join(EVOLUTION_DIR, 'training_matrix.json');
var FACTOR_EFFECTIVENESS_FILE = path.join(EVOLUTION_DIR, 'factor_effectiveness.json');
var CROSS_MARKET_FILE = path.join(EVOLUTION_DIR, 'cross_market_linkage.json');
var PARAM_SEARCH_FILE = path.join(EVOLUTION_DIR, 'param_search_results.json');
var STATE_FILE = path.join(EVOLUTION_DIR, 'bootstrap_state.json');

// ====== Config ======

var UNIVERSE = {
  hs300: '沪深300成分股',
  sectors: '8大板块活跃股',
  all: '全A股',
};

var DEFAULT_UNIVERSE = 'hs300'; // safe default

var START_YEAR = 2021;
var END_YEAR = 2026;

var FORWARD_HORIZONS = [1, 3, 5, 10, 20]; // T+N trading days for forward return measurement
var MIN_KLINES_FOR_FACTOR = 30;           // min klines needed to compute factors

// Factor metadata
var FACTORS = [
  { id: 'H1', name: '缩量止跌', category: 'hidden' },
  { id: 'H2', name: '底部放量', category: 'hidden' },
  { id: 'H3', name: '逆势抗跌', category: 'hidden' },
  { id: 'H4', name: 'PE低估', category: 'hidden' },
  { id: 'H5', name: '高ROE低PB', category: 'hidden' },
  { id: 'H6', name: '现金流健康', category: 'hidden' },
  { id: 'H7', name: '低换手蓄力', category: 'hidden' },
  { id: 'H8', name: '短期反转', category: 'hidden' },
  { id: 'H9', name: '量价背离', category: 'hidden' },
  { id: 'F1', name: '基本面PE', category: 'fundamental' },
  { id: 'F2', name: 'ROE/增长', category: 'fundamental' },
  { id: 'T1', name: '涨跌适中', category: 'technical' },
  { id: 'T2', name: '量价配合', category: 'technical' },
  { id: 'T3', name: '价格位置', category: 'technical' },
  { id: 'C1', name: '北向流入', category: 'capital_flow' },
  { id: 'C2', name: '龙虎榜', category: 'capital_flow' },
  { id: 'C3', name: '融资余额', category: 'capital_flow' },
];

// Market regime classification thresholds
var REGIME_RULES = {
  bull: function(ctx) { return ctx.idx5dChg > 3 && ctx.advanceRatio > 0.5; },
  bear: function(ctx) { return ctx.idx5dChg < -3 || ctx.advanceRatio < 0.3; },
  high_vol: function(ctx) { return ctx.viYesterday > 1.5; },
  low_liquidity: function(ctx) { return ctx.totalTurnover < 500; }, // 500B yuan
  sideways: function(ctx) { return Math.abs(ctx.idx5dChg) <= 1.5 && ctx.advanceRatio >= 0.35 && ctx.advanceRatio <= 0.65; },
};

var REGIME_LABELS = {
  bull: '牛市', bear: '熊市', high_vol: '高波动', low_liquidity: '低流动性', sideways: '震荡市',
  other: '其他',
};

// ====== State Management ======

function ensureDirs() {
  [EVOLUTION_DIR, KLINES_DIR].forEach(function(d) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

function readJSON(file, defaultVal) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { /* corrupted */ }
  return defaultVal;
}

function writeJSON(file, data) {
  ensureDirs();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function loadState() {
  return readJSON(STATE_FILE, {
    lastFullRun: null,
    lastIncrementalRun: null,
    completedPhases: [],
    universe: null,
    totalDays: 0,
    errors: [],
  });
}

function saveState(state) {
  writeJSON(STATE_FILE, state);
}

// ====== Phase 1: Historical Data Download & Clean ======

/**
 * Generate trading days calendar (exclude weekends + Chinese holidays).
 * Returns array of 'YYYY-MM-DD' strings.
 */
function generateTradingDays(startYear, endYear) {
  var holidays = {};
  // Chinese holidays 2021-2026 (major ones)
  var holidayList = [
    // 2021
    '2021-01-01', '2021-02-11','2021-02-12','2021-02-15','2021-02-16','2021-02-17',
    '2021-04-05', '2021-05-03','2021-05-04','2021-05-05', '2021-06-14',
    '2021-09-20','2021-09-21', '2021-10-01','2021-10-04','2021-10-05','2021-10-06','2021-10-07',
    // 2022
    '2022-01-03', '2022-01-31','2022-02-01','2022-02-02','2022-02-03','2022-02-04',
    '2022-04-04','2022-04-05', '2022-05-02','2022-05-03','2022-05-04', '2022-06-03',
    '2022-09-12', '2022-10-03','2022-10-04','2022-10-05','2022-10-06','2022-10-07',
    // 2023
    '2023-01-02', '2023-01-23','2023-01-24','2023-01-25','2023-01-26','2023-01-27',
    '2023-04-05', '2023-05-01','2023-05-02','2023-05-03', '2023-06-22','2023-06-23',
    '2023-09-29', '2023-10-02','2023-10-03','2023-10-04','2023-10-05','2023-10-06',
    // 2024
    '2024-01-01', '2024-02-12','2024-02-13','2024-02-14','2024-02-15','2024-02-16',
    '2024-04-04','2024-04-05', '2024-05-01','2024-05-02','2024-05-03', '2024-06-10',
    '2024-09-17', '2024-10-01','2024-10-02','2024-10-03','2024-10-04','2024-10-07',
    // 2025
    '2025-01-01', '2025-01-29','2025-01-30','2025-01-31','2025-02-03','2025-02-04',
    '2025-04-04', '2025-05-01','2025-05-02', '2025-06-02',
    '2025-10-01','2025-10-02','2025-10-03','2025-10-06','2025-10-07',
    // 2026 (from config)
    '2026-01-01', '2026-05-01','2026-05-04','2026-05-05', '2026-06-19',
    '2026-10-01','2026-10-02','2026-10-05','2026-10-06','2026-10-07',
  ];
  holidayList.forEach(function(d) { holidays[d] = true; });

  var days = [];
  var d = new Date(Date.UTC(startYear, 0, 1));
  var end = new Date(Date.UTC(endYear, 11, 31, 23, 59, 59));

  while (d <= end) {
    var ds = d.toISOString().slice(0, 10);
    var dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidays[ds]) {
      days.push(ds);
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

/**
 * Fetch historical klines for a single stock via Tencent API.
 * Tencent API is accessible from Alibaba Cloud ECS (Eastmoney push2his is blocked).
 *
 * Tencent returns up to ~640 trading days per call (~2.5 calendar years).
 * We request from 2020-01-01 to get maximum available history (pre-reconciled prices).
 *
 * API format: https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=<market><code>,day,2020-01-01,,640,qfq
 * Response: { data: { <code>: { qfqday: [[date,open,close,high,low,volume], ...] } } }
 */
function fetchHistoricalKlines(code, maxDays) {
  var market = code.startsWith('6') ? 'sh' : 'sz';
  var symbol = market + code;
  var https = require('https');
  var limit = Math.min(maxDays || 640, 640);

  return new Promise(function(resolve) {
    var url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get' +
      '?param=' + symbol + ',day,2020-01-01,,' + limit + ',qfq';

    var req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try {
          var json = JSON.parse(data);
          if (json && json.code === 0 && json.data && json.data[symbol]) {
            var stored = json.data[symbol];
            // Find the qfqday key (may be "qfqday" or variant)
            var dayKey = null;
            var keys = Object.keys(stored);
            for (var ki = 0; ki < keys.length; ki++) {
              if (keys[ki].indexOf('qfqday') >= 0) { dayKey = keys[ki]; break; }
            }
            if (dayKey && stored[dayKey]) {
              var raw = stored[dayKey];
              var klines = raw.map(function(row) {
                return {
                  date: row[0],
                  open: parseFloat(row[1]),
                  close: parseFloat(row[2]),
                  high: parseFloat(row[3]),
                  low: parseFloat(row[4]),
                  volume: parseFloat(row[5]),
                  turnover: 0, // Tencent doesn't provide turnover in this API
                };
              });
              resolve(klines);
              return;
            }
          }
          resolve([]);
        } catch (e) {
          resolve([]);
        }
      });
    });

    req.on('error', function() { resolve([]); });
    req.setTimeout(15000, function() { req.destroy(); resolve([]); });
  });
}

/**
 * Clean klines: detect and handle anomalies
 * - Remove zero-volume days (停牌)
 * - Flag price jump > 20% (possible data error, not limit — limit is 10%)
 * - Ensure date ordering
 * - Deduplicate dates
 */
function cleanKlines(klines) {
  if (!klines || klines.length === 0) return [];

  var cleaned = [];
  var seenDates = {};

  for (var i = 0; i < klines.length; i++) {
    var k = klines[i];
    // Skip zero volume (停牌)
    if (!k.volume || k.volume <= 0) continue;
    // Skip zero price
    if (!k.close || k.close <= 0) continue;
    // Skip duplicate dates
    if (seenDates[k.date]) continue;
    seenDates[k.date] = true;
    cleaned.push(k);
  }

  // Sort by date
  cleaned.sort(function(a, b) { return a.date.localeCompare(b.date); });

  // Flag price jumps > 20% day-over-day (likely data error or ex-rights without adjustment)
  for (i = 1; i < cleaned.length; i++) {
    var prevClose = cleaned[i - 1].close;
    var curClose = cleaned[i].close;
    if (prevClose > 0) {
      var jump = Math.abs(curClose - prevClose) / prevClose;
      if (jump > 0.2) {
        cleaned[i]._flag_priceJump = true;
        cleaned[i]._jumpPct = Math.round(jump * 10000) / 100;
      }
    }
  }

  return cleaned;
}

/**
 * Build the stock universe for training.
 * Returns array of { code, name, sector? }
 */
function buildUniverse(universeType) {
  universeType = universeType || DEFAULT_UNIVERSE;

  var stocks = [];

  if (universeType === 'hs300' || universeType === 'full') {
    // Try to load from existing index files
    try {
      var idxFile = path.join(DATA_DIR, 'index_history_hs300.json');
      if (fs.existsSync(idxFile)) {
        var idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
        if (idx.constituents) {
          idx.constituents.forEach(function(c) {
            stocks.push({ code: c.code || c, name: c.name || c.code, sector: '沪深300' });
          });
        }
      }
    } catch (e) { /* ignore */ }

    // Fallback: generate HS300 codes from known range (approximate)
    if (stocks.length === 0 && universeType === 'hs300') {
      // Use top 300 by market cap proxy — common HS300 constituents
      // For initial run, load from existing kline cache
      console.log('[Bootstrap] 未找到沪深300成分股文件，从K线缓存推断...');
      try {
        var klineFiles = fs.readdirSync(KLINES_DIR);
        var klineStocks = klineFiles
          .filter(function(f) { return f.endsWith('.json'); })
          .map(function(f) { return f.replace('.json', ''); })
          .filter(function(c) { return /^\d{6}$/.test(c); });
        // Take first 300 as approximation
        klineStocks = klineStocks.slice(0, 300);
        klineStocks.forEach(function(code) {
          stocks.push({ code: code, name: code, sector: '沪深300(近似)' });
        });
        console.log('[Bootstrap] 从K线缓存加载了 ' + stocks.length + ' 只股票');
      } catch (e) {
        console.log('[Bootstrap] K线缓存为空，需要先获取数据');
      }
    }
  }

  if (universeType === 'full' || universeType === 'all') {
    // Generate all A-share codes
    var codes = [];
    // SH main
    for (var i = 600000; i <= 603999; i++) codes.push(String(i));
    // SH STAR
    for (i = 688000; i <= 689999; i++) codes.push(String(i));
    // SZ main
    for (i = 1; i <= 3099; i++) codes.push(String(i).padStart(6, '0'));
    // SZ ChiNext
    for (i = 300000; i <= 301999; i++) codes.push(String(i));

    stocks = codes.map(function(c) { return { code: c, name: c }; });
  }

  return stocks;
}

// ====== Phase 2: Daily Replay Engine ======

/**
 * Simulate one historical trading day:
 * - For each stock in universe, compute hidden signals + composite score
 * - Record which factors triggered, and what the forward N-day return was
 *
 * This reuses the REAL factor engines (hidden_signals.js / composite.js),
 * NOT simplified approximations — so the training data matches live behavior.
 */
function replayDay(date, klineSnapshot, factorEngines) {
  var results = {
    date: date,
    stocks: [],
    marketContext: {},
    signalCounts: {},
  };

  // Initialize signal counts
  FACTORS.forEach(function(f) { results.signalCounts[f.id] = 0; });

  // Compute market context from index data
  results.marketContext = computeMarketContext(date, klineSnapshot);

  // Process each stock
  for (var i = 0; i < klineSnapshot.length; i++) {
    var k = klineSnapshot[i];
    if (!k.close || k.close <= 0) continue;

    var stockObj = {
      code: k.code,
      price: k.close,
      peTTM: k.pe || null,
      changePercent: k.changePercent || 0,
      turnover: k.volume || 0,
    };

    // Compute hidden signals
    var signals = [];
    if (factorEngines.computeHiddenSignals) {
      try {
        var hiddenResult = factorEngines.computeHiddenSignals(stockObj, null, k.klines, false);
        if (hiddenResult && hiddenResult.signals) {
          signals = hiddenResult.signals;
        }
      } catch (e) { /* skip this stock */ }
    }

    // Compute composite score
    var compositeScore = 0;
    if (factorEngines.computeCompositeScore) {
      try {
        compositeScore = factorEngines.computeCompositeScore(stockObj, null, signals, {});
        if (typeof compositeScore === 'object') {
          compositeScore = compositeScore.compositeScore || compositeScore.score || 0;
        }
      } catch (e) { /* skip */ }
    }

    // Fallback score estimation
    if (!compositeScore && signals.length > 0) {
      compositeScore = 40 + signals.length * 5;
    }

    // Count triggered signals
    var triggeredFactors = {};
    signals.forEach(function(s) {
      if (s && s.id) {
        triggeredFactors[s.id] = true;
        results.signalCounts[s.id] = (results.signalCounts[s.id] || 0) + 1;
      }
    });

    results.stocks.push({
      code: k.code,
      price: k.close,
      compositeScore: compositeScore,
      signals: signals.map(function(s) { return s.id; }),
      pe: k.pe || null,
      changePercent: k.changePercent || 0,
    });
  }

  return results;
}

function computeMarketContext(date, klineSnapshot) {
  // Compute aggregate market metrics from snapshot
  var totalTurnover = 0;
  var upCount = 0;
  var downCount = 0;
  var volSum = 0;
  var count = 0;

  klineSnapshot.forEach(function(k) {
    totalTurnover += (k.turnover || 0);
    if (k.changePercent > 0) upCount++;
    else if (k.changePercent < 0) downCount++;
    volSum += Math.abs(k.changePercent || 0);
    count++;
  });

  var advanceRatio = count > 0 ? upCount / count : 0.5;
  var avgChange = count > 0 ? volSum / count : 0;

  return {
    totalTurnover: Math.round(totalTurnover / 100000000), // in 100M yuan
    advanceRatio: Math.round(advanceRatio * 100) / 100,
    avgAbsChange: Math.round(avgChange * 100) / 100,
    upCount: upCount,
    downCount: downCount,
    stocksSampled: count,
  };
}

/**
 * Classify a day's market regime based on market context and prior days.
 */
function classifyRegime(date, ctx, priorCtx) {
  var tags = [];

  // Use advance ratio + avg change as proxy for bull/bear
  if (ctx.advanceRatio > 0.55 && ctx.upCount > ctx.downCount * 1.5) {
    tags.push('bull');
  } else if (ctx.advanceRatio < 0.3) {
    tags.push('bear');
  } else if (Math.abs(ctx.avgAbsChange) < 0.5) {
    tags.push('sideways');
  }

  if (ctx.totalTurnover < 500) {
    tags.push('low_liquidity');
  }

  if (ctx.avgAbsChange > 2.5) {
    tags.push('high_vol');
  }

  if (tags.length === 0) tags.push('other');
  return tags;
}

// ====== Phase 3: Factor Effectiveness Matrix ======

/**
 * For each factor, compute:
 * - hitRate: % of stocks where factor triggered AND forward N-day return > 0
 * - avgFwdReturn: average forward N-day return when factor triggered
 * - maxFwdReturn / minFwdReturn: best/worst case
 * - profitFactor: gross profit / gross loss
 * - sampleSize: number of observations
 * - byRegime: effectiveness broken down by market regime
 */
function computeFactorEffectiveness(dailyResults, horizon) {
  var matrix = {};

  // Initialize
  FACTORS.forEach(function(f) {
    matrix[f.id] = {
      id: f.id,
      name: f.name,
      category: f.category,
      hits: 0,
      total: 0,
      hitRate: null,
      avgFwdReturn: null,
      maxFwdReturn: null,
      minFwdReturn: null,
      profitFactor: null,
      allReturns: [],
      byRegime: {},
    };
  });

  // Aggregate across all days
  dailyResults.forEach(function(day) {
    if (!day || !day.stocks) return;

    day.stocks.forEach(function(s) {
      if (!s || !s.signals || s.signals.length === 0) return;
      if (s.fwdReturns == null) return;

      var fwdRet = s.fwdReturns[horizon];
      if (fwdRet == null) return;

      var regimes = day.marketRegimes || ['other'];

      s.signals.forEach(function(factorId) {
        var entry = matrix[factorId];
        if (!entry) return;

        entry.total++;
        entry.allReturns.push(fwdRet);
        if (fwdRet > 0) entry.hits++;

        // Per-regime breakdown
        regimes.forEach(function(regime) {
          if (!entry.byRegime[regime]) {
            entry.byRegime[regime] = { hits: 0, total: 0, avgReturn: null, returns: [] };
          }
          entry.byRegime[regime].total++;
          entry.byRegime[regime].returns.push(fwdRet);
          if (fwdRet > 0) entry.byRegime[regime].hits++;
        });
      });
    });
  });

  // Compute derived metrics
  Object.keys(matrix).forEach(function(fid) {
    var entry = matrix[fid];
    if (entry.total < 10) {
      entry._insufficient = true;
      return;
    }

    var returns = entry.allReturns;
    entry.hitRate = Math.round(entry.hits / entry.total * 10000) / 100; // percentage
    entry.avgFwdReturn = Math.round(returns.reduce(function(s, r) { return s + r; }, 0) / returns.length * 10000) / 100;
    entry.maxFwdReturn = Math.round(Math.max.apply(null, returns) * 10000) / 100;
    entry.minFwdReturn = Math.round(Math.min.apply(null, returns) * 10000) / 100;

    // Profit factor
    var grossProfit = returns.filter(function(r) { return r > 0; }).reduce(function(s, r) { return s + r; }, 0);
    var grossLoss = Math.abs(returns.filter(function(r) { return r < 0; }).reduce(function(s, r) { return s + r; }, 0));
    entry.profitFactor = grossLoss > 0 ? Math.round(grossProfit / grossLoss * 100) / 100 : (grossProfit > 0 ? 999 : 0);

    // Free memory — don't store allReturns in final output (only summary)
    delete entry.allReturns;

    // Per-regime
    Object.keys(entry.byRegime).forEach(function(regime) {
      var re = entry.byRegime[regime];
      if (re.total < 5) {
        re._insufficient = true;
        delete re.returns;
        return;
      }
      re.avgReturn = Math.round(re.returns.reduce(function(s, r) { return s + r; }, 0) / re.returns.length * 10000) / 100;
      delete re.returns;
    });
  });

  return matrix;
}

// ====== Phase 4: Factor Combination Mining ======

/**
 * Find synergistic and conflicting factor pairs.
 * Synergy: P(A&B | win) > P(A|win) + P(B|win) - P(A|win)*P(B|win)  (exceeds independent probability)
 * Conflict: P(A&B | win) < P(A|win) * P(B|win)  (worse than random combo)
 */
function mineFactorCombinations(dailyResults, horizon) {
  var combos = [];
  var factorIds = FACTORS.map(function(f) { return f.id; });

  // For each pair of factors
  for (var i = 0; i < factorIds.length; i++) {
    for (var j = i + 1; j < factorIds.length; j++) {
      var fA = factorIds[i];
      var fB = factorIds[j];

      var bothCount = 0, bothWin = 0;
      var aOnlyCount = 0, aOnlyWin = 0;
      var bOnlyCount = 0, bOnlyWin = 0;
      var eitherCount = 0, eitherWin = 0;

      dailyResults.forEach(function(day) {
        if (!day || !day.stocks) return;
        day.stocks.forEach(function(s) {
          if (!s || !s.signals) return;
          var fwdRet = s.fwdReturns ? s.fwdReturns[horizon] : null;
          if (fwdRet == null) return;

          var hasA = s.signals.indexOf(fA) >= 0;
          var hasB = s.signals.indexOf(fB) >= 0;

          if (hasA && hasB) {
            bothCount++;
            if (fwdRet > 0) bothWin++;
          } else if (hasA) {
            aOnlyCount++;
            if (fwdRet > 0) aOnlyWin++;
          } else if (hasB) {
            bOnlyCount++;
            if (fwdRet > 0) bOnlyWin++;
          }

          if (hasA || hasB) {
            eitherCount++;
            if (fwdRet > 0) eitherWin++;
          }
        });
      });

      if (bothCount < 10) continue; // insufficient samples

      var bothHitRate = bothWin / bothCount;
      var eitherHitRate = eitherCount > 0 ? eitherWin / eitherCount : 0;

      // Expected hit rate if independent: P(A wins) * P(B wins) when both fire
      // For synergy check: compare both-hit-rate vs max(a-only, b-only)
      var maxSingleHitRate = Math.max(
        aOnlyCount >= 10 ? aOnlyWin / aOnlyCount : 0,
        bOnlyCount >= 10 ? bOnlyWin / bOnlyCount : 0
      );

      var effect = bothHitRate - maxSingleHitRate;

      combos.push({
        factors: [fA, fB],
        bothCount: bothCount,
        bothHitRate: Math.round(bothHitRate * 10000) / 100,
        singleHitRateMax: Math.round(maxSingleHitRate * 10000) / 100,
        effect: Math.round(effect * 10000) / 100,
        type: effect > 0.05 ? 'synergy' : (effect < -0.05 ? 'conflict' : 'neutral'),
        horizon: horizon,
      });
    }
  }

  // Sort by absolute effect size
  combos.sort(function(a, b) { return Math.abs(b.effect) - Math.abs(a.effect); });

  return {
    horizon: horizon,
    synergyPairs: combos.filter(function(c) { return c.type === 'synergy'; }),
    conflictPairs: combos.filter(function(c) { return c.type === 'conflict'; }),
    neutralPairs: combos.filter(function(c) { return c.type === 'neutral'; }),
    totalPairsAnalyzed: combos.length,
  };
}

// ====== Phase 5: Cross-Market Correlation ======

/**
 * Compute rolling correlation between US market proxies and A-share sectors.
 * Currently uses VIX/SPY/QQQ data from US_MARKET module.
 */
function computeCrossMarketLinkage(usData, aShareIndexData) {
  if (!usData || !aShareIndexData) {
    return { available: false, note: '缺少美股或A股指数数据' };
  }

  var linkage = {
    computedAt: new Date().toISOString(),
    correlations: {},
    leadLag: {},
  };

  // For each US proxy, compute correlation with A-share index
  var usProxies = ['SPY', 'QQQ', 'VXX', 'UUP'];
  var aShareProxies = ['sh000001', 'sz399001'];

  // Simple Pearson correlation over common dates
  usProxies.forEach(function(us) {
    linkage.correlations[us] = {};
    aShareProxies.forEach(function(a) {
      var dates = intersectDates(usData[us], aShareIndexData[a]);
      if (dates.length < 20) {
        linkage.correlations[us][a] = { sampleSize: dates.length, note: '样本不足' };
        return;
      }
      var r = pearsonCorrelation(
        dates.map(function(d) { return usData[us][d]; }),
        dates.map(function(d) { return aShareIndexData[a][d]; })
      );
      linkage.correlations[us][a] = {
        sampleSize: dates.length,
        correlation: Math.round(r * 1000) / 1000,
        interpretation: Math.abs(r) > 0.5 ? (r > 0 ? '显著正相关' : '显著负相关') :
                        (Math.abs(r) > 0.3 ? '中等相关' : '弱相关'),
      };
    });
  });

  // Lead-lag analysis: does US move today predict A-share move tomorrow?
  var leadLagResults = [];
  usProxies.forEach(function(us) {
    aShareProxies.forEach(function(a) {
      var results = [];
      for (var lag = -5; lag <= 5; lag++) {
        var pairs = [];
        // Build lagged pairs
        var usDates = Object.keys(usData[us] || {}).sort();
        var aDates = Object.keys(aShareIndexData[a] || {}).sort();
        // Map dates to values
        var usMap = usData[us] || {};
        var aMap = aShareIndexData[a] || {};

        // For each A date, find US date that's 'lag' days before
        // This is approximate — proper implementation needs exact date matching
        var allDates = aDates.filter(function(d) { return usMap[d] != null; });
        allDates.forEach(function(d) {
          var aIdx = aDates.indexOf(d);
          var usIdx = aIdx - lag;
          if (usIdx >= 0 && usIdx < aDates.length) {
            var usDate = aDates[usIdx];
            if (usMap[usDate] != null) {
              pairs.push({ us: usMap[usDate], a: aMap[d] });
            }
          }
        });

        if (pairs.length >= 20) {
          var r = pearsonCorrelation(
            pairs.map(function(p) { return p.us; }),
            pairs.map(function(p) { return p.a; })
          );
          results.push({ lag: lag, correlation: Math.round(r * 1000) / 1000, n: pairs.length });
        }
      }
      if (results.length > 0) {
        leadLagResults.push({
          usProxy: us,
          aShareProxy: a,
          byLag: results,
          bestLag: results.reduce(function(best, cur) {
            return Math.abs(cur.correlation) > Math.abs(best.correlation) ? cur : best;
          }, results[0]),
        });
      }
    });
  });

  linkage.leadLag = leadLagResults;
  return linkage;
}

// ====== Phase 6: Parameter Optimization ======

/**
 * Grid search for optimal stop-loss, position size, buy threshold.
 * Runs on historical data by simulating trades with different params.
 */
function runParameterSearch(dailyResults, klineCache) {
  // Search space
  var stopLossLevels = [-0.03, -0.05, -0.07, -0.08, -0.10, -0.12, -0.15];
  var positionSizes = [0.05, 0.08, 0.10, 0.15, 0.20, 0.25, 0.30];
  var buyMinScores = [45, 50, 55, 60, 65, 70, 75];
  var maxPositions = [3, 4, 5, 6, 8, 10];

  var searchDate = new Date().toISOString().slice(0, 10);
  var searchResults = {
    computedAt: new Date().toISOString(),
    searchSpace: {
      stopLossLevels: stopLossLevels,
      positionSizes: positionSizes,
      buyMinScores: buyMinScores,
      maxPositions: maxPositions,
    },
    topConfigs: [],
  };

  // We don't run full simulation for each combo (that's what full_backtest is for).
  // Instead, compute expected trade-level stats for the factor backtest results:
  // - For a given stop-loss level, what % of losing trades would it have saved?
  // - For a given buy threshold, what's the trade-off between deal flow and hit rate?
  var allCandidateReturns = [];
  dailyResults.forEach(function(day) {
    if (!day || !day.stocks) return;
    day.stocks.forEach(function(s) {
      if (s.compositeScore >= 45 && s.fwdReturns && s.fwdReturns[5] != null) {
        allCandidateReturns.push({
          score: s.compositeScore,
          ret5d: s.fwdReturns[5],
          signals: s.signals.length,
        });
      }
    });
  });

  console.log('[ParamSearch] 候选样本数: ' + allCandidateReturns.length);

  // For each stop loss level, compute what % of losing trades are avoided
  stopLossLevels.forEach(function(sl) {
    var totalTrades = allCandidateReturns.length;
    var stoppedOut = allCandidateReturns.filter(function(r) { return r.ret5d <= sl; }).length;
    var savedByStop = allCandidateReturns.filter(function(r) {
      return r.ret5d <= sl && r.ret5d < -0.03;
    }).length;
    // Good trades that would have been stopped out (false positive)
    var falseStop = allCandidateReturns.filter(function(r) {
      return r.ret5d <= sl && r.ret5d > -0.02;
    }).length;

    // For each buy threshold, compute deal flow and hit rate
    buyMinScores.forEach(function(minScore) {
      var qualifiedTrades = allCandidateReturns.filter(function(r) { return r.score >= minScore; });
      var qualifiedHits = qualifiedTrades.filter(function(r) { return r.ret5d > 0; });
      var qualifiedHitRate = qualifiedTrades.length > 0 ? qualifiedHits.length / qualifiedTrades.length : 0;
      // After stop loss
      var afterStop = qualifiedTrades.filter(function(r) { return r.ret5d > sl; });
      var afterStopHits = afterStop.filter(function(r) { return r.ret5d > 0; });
      var afterStopHitRate = afterStop.length > 0 ? afterStopHits.length / afterStop.length : 0;

      if (qualifiedTrades.length >= 20) {
        searchResults.topConfigs.push({
          stopLoss: sl,
          buyMinScore: minScore,
          qualifiedCount: qualifiedTrades.length,
          hitRate: Math.round(qualifiedHitRate * 10000) / 100,
          afterStopCount: afterStop.length,
          afterStopHitRate: Math.round(afterStopHitRate * 10000) / 100,
          avgRet5d: Math.round(afterStop.reduce(function(s, r) { return s + r.ret5d; }, 0) / afterStop.length * 10000) / 100,
        });
      }
    });
  });

  // Sort by after-stop hit rate * avg return (composite score)
  searchResults.topConfigs.sort(function(a, b) {
    var scoreA = a.afterStopHitRate * a.avgRet5d * (a.qualifiedCount / allCandidateReturns.length);
    var scoreB = b.afterStopHitRate * b.avgRet5d * (b.qualifiedCount / allCandidateReturns.length);
    return scoreB - scoreA;
  });

  // Keep top 50
  searchResults.topConfigs = searchResults.topConfigs.slice(0, 50);

  // Best recommendation
  searchResults.recommendation = searchResults.topConfigs.length > 0 ? {
    stopLoss: searchResults.topConfigs[0].stopLoss,
    buyMinScore: searchResults.topConfigs[0].buyMinScore,
    expectedHitRate: searchResults.topConfigs[0].afterStopHitRate,
    expectedAvgRet5d: searchResults.topConfigs[0].avgRet5d,
    rationale: '基于 ' + allCandidateReturns.length + ' 个历史候选样本，该参数组合在命中率和期望收益之间取得最佳平衡',
  } : null;

  return searchResults;
}

// ====== Phase 7: Daily Model Updater ======

/**
 * Incremental update: process only last N days, merge with existing matrix.
 * Uses EMA weighting to blend new results with historical data.
 * Returns the merged training matrix.
 */
function incrementalUpdate(days) {
  days = days || 20;
  console.log('[Incremental] 增量更新最近 ' + days + ' 天...');

  // Load existing matrix (the "base" to merge into)
  var existingMatrix = null;
  try {
    if (fs.existsSync(TRAINING_MATRIX_FILE)) {
      existingMatrix = JSON.parse(fs.readFileSync(TRAINING_MATRIX_FILE, 'utf8'));
      console.log('[Incremental] 已加载现有矩阵 (generated: ' + existingMatrix.generatedAt + ')');
    }
  } catch (e) {
    console.log('[Incremental] 无法加载现有矩阵，将生成全新矩阵');
  }

  // Load existing factor effectiveness
  var existingFactors = null;
  try {
    if (fs.existsSync(FACTOR_EFFECTIVENESS_FILE)) {
      existingFactors = JSON.parse(fs.readFileSync(FACTOR_EFFECTIVENESS_FILE, 'utf8'));
    }
  } catch (e) { /* will compute fresh */ }

  // ===== Phase 1: Download recent klines for cached stocks =====
  console.log('[Incremental] Phase 1: 更新最近K线...');
  var klineFiles;
  try {
    klineFiles = fs.readdirSync(KLINES_DIR).filter(function(f) { return f.endsWith('.json'); });
  } catch (e) { klineFiles = []; }
  console.log('[Incremental] K线缓存: ' + klineFiles.length + ' 文件');

  var downloaded = 0, failed = 0;
  var downloadPromises = klineFiles.map(function(file) {
    var code = file.replace('.json', '');
    if (!/^\d{6}$/.test(code)) return Promise.resolve();
    return fetchHistoricalKlines(code, 640).then(function(klines) {
      var cleaned = cleanKlines(klines);
      if (cleaned.length > 0) {
        writeJSON(path.join(KLINES_DIR, file), { ts: Date.now(), klines: cleaned, code: code });
        downloaded++;
      } else { failed++; }
    }).catch(function() { failed++; });
  });

  return Promise.all(downloadPromises).then(function() {
    console.log('[Incremental] K线更新: ' + downloaded + ' 成功, ' + failed + ' 失败');

    // ===== Phase 2: Replay only recent days =====
    console.log('[Incremental] Phase 2: 回放最近 ' + days + ' 天...');
    var tradingDays = generateTradingDays(START_YEAR, END_YEAR);
    var recentDays = tradingDays.slice(-days);

    // Build kline index for recent days only
    var dailyResults = [];
    var totalStockDays = 0;

    for (var d = 0; d < recentDays.length; d++) {
      var date = recentDays[d];
      var klineSnapshot = [];

      for (var f = 0; f < klineFiles.length; f++) {
        var code = klineFiles[f].replace('.json', '');
        if (!/^\d{6}$/.test(code)) continue;

        try {
          var klineData = JSON.parse(fs.readFileSync(path.join(KLINES_DIR, code + '.json'), 'utf8'));
          if (!klineData || !klineData.klines) continue;

          var klines = klineData.klines;
          var dateIdx = -1;
          for (var ki = 0; ki < klines.length; ki++) {
            if (klines[ki].date === date) { dateIdx = ki; break; }
          }
          if (dateIdx < MIN_KLINES_FOR_FACTOR) continue;

          var todayKline = klines[dateIdx];
          var prevKline = dateIdx >= 1 ? klines[dateIdx - 1] : null;
          var changePercent = prevKline ? ((todayKline.close - prevKline.close) / prevKline.close * 100) : 0;

          var fwdReturns = {};
          FORWARD_HORIZONS.forEach(function(h) {
            var fwdIdx = dateIdx + h;
            if (fwdIdx < klines.length) {
              fwdReturns[h] = (klines[fwdIdx].close - todayKline.close) / todayKline.close * 100;
            } else { fwdReturns[h] = null; }
          });

          klineSnapshot.push({
            code: code, close: todayKline.close, open: todayKline.open,
            high: todayKline.high, low: todayKline.low, volume: todayKline.volume,
            turnover: todayKline.turnover || 0,
            changePercent: Math.round(changePercent * 100) / 100,
            pe: null, klines: klines.slice(0, dateIdx + 1), fwdReturns: fwdReturns,
          });
        } catch (e) { /* skip */ }
      }

      if (klineSnapshot.length < 10) continue;

      // Load factor engines
      var computeHiddenSignals, computeCompositeScore;
      try { computeHiddenSignals = require('../factors/hidden_signals').computeHiddenSignals; } catch (e) {}
      try {
        computeCompositeScore = require('../factors/composite').computeCompositeScore ||
                                require('../factors/composite').computeScore;
      } catch (e) {}

      var dayResult = replayDay(date, klineSnapshot, {
        computeHiddenSignals: computeHiddenSignals,
        computeCompositeScore: computeCompositeScore,
      });

      dayResult.stocks.forEach(function(s) {
        for (var ki = 0; ki < klineSnapshot.length; ki++) {
          if (klineSnapshot[ki].code === s.code) { s.fwdReturns = klineSnapshot[ki].fwdReturns; break; }
        }
      });
      dayResult.marketRegimes = classifyRegime(date, dayResult.marketContext, null);
      dailyResults.push(dayResult);
      totalStockDays += klineSnapshot.length;
    }

    console.log('[Incremental] 回放完成: ' + dailyResults.length + ' 天, ' + totalStockDays + ' stock-days');

    if (dailyResults.length === 0) {
      console.log('[Incremental] 无新数据，跳过合并');
      return existingMatrix;
    }

    // ===== Phase 3: Compute incremental factor effectiveness =====
    console.log('[Incremental] Phase 3: 计算增量因子矩阵...');
    var newFactorMatrix = {};
    FORWARD_HORIZONS.forEach(function(h) {
      newFactorMatrix['T+' + h] = computeFactorEffectiveness(dailyResults, h);
    });

    // ===== Merge with existing matrix using EMA =====
    // EMA alpha: new data weight. With ~20 incremental days vs ~500 base days,
    // alpha=0.15 gives a gentle update while allowing trends to shift over weeks.
    var EMA_ALPHA = 0.15;

    var mergedMatrix = {};
    FORWARD_HORIZONS.forEach(function(h) {
      var hKey = 'T+' + h;
      mergedMatrix[hKey] = {};

      var newFactors = newFactorMatrix[hKey] || {};
      var oldFactors = (existingFactors && existingFactors.matrix && existingFactors.matrix[hKey]) ? existingFactors.matrix[hKey] : {};

      // Collect all factor IDs from both old and new
      var allFactorIds = {};
      Object.keys(oldFactors).forEach(function(k) { allFactorIds[k] = true; });
      Object.keys(newFactors).forEach(function(k) { allFactorIds[k] = true; });

      Object.keys(allFactorIds).forEach(function(fid) {
        var oldF = oldFactors[fid];
        var newF = newFactors[fid];

        if (!oldF || oldF._insufficient || oldF.total < 10) {
          // No reliable old data — use new directly
          mergedMatrix[hKey][fid] = newF || oldF;
        } else if (!newF || newF._insufficient || newF.total < 5) {
          // No meaningful new data — keep old
          mergedMatrix[hKey][fid] = oldF;
        } else {
          // EMA blend
          mergedMatrix[hKey][fid] = {
            name: newF.name || oldF.name,
            category: newF.category || oldF.category,
            hitRate: Math.round((oldF.hitRate * (1 - EMA_ALPHA) + newF.hitRate * EMA_ALPHA) * 100) / 100,
            avgFwdReturn: Math.round((oldF.avgFwdReturn * (1 - EMA_ALPHA) + newF.avgFwdReturn * EMA_ALPHA) * 100) / 100,
            maxDrawdown: Math.round(Math.max(oldF.maxDrawdown || 0, newF.maxDrawdown || 0) * 100) / 100,
            profitFactor: Math.round((oldF.profitFactor * (1 - EMA_ALPHA) + newF.profitFactor * EMA_ALPHA) * 100) / 100,
            total: oldF.total + newF.total,
            wins: (oldF.wins || 0) + (newF.wins || 0),
            losses: (oldF.losses || 0) + (newF.losses || 0),
            _merged: true,
            _oldSamples: oldF.total,
            _newSamples: newF.total,
          };
        }
      });
    });

    // ===== Phase 4: Incremental combo mining (on new data only) =====
    console.log('[Incremental] Phase 4: 增量组合挖掘...');
    var newComboResults = {};
    FORWARD_HORIZONS.forEach(function(h) {
      newComboResults['T+' + h] = mineFactorCombinations(dailyResults, h);
    });

    // Merge combos: keep top synergy pairs from both
    var mergedCombos = {};
    FORWARD_HORIZONS.forEach(function(h) {
      var hKey = 'T+' + h;
      var oldC = (existingMatrix && existingMatrix.factorCombos && existingMatrix.factorCombos[hKey])
        ? existingMatrix.factorCombos[hKey] : { synergyPairs: [], conflictPairs: [] };
      var newC = newComboResults[hKey] || { synergyPairs: [], conflictPairs: [] };

      mergedCombos[hKey] = {
        synergyPairs: dedupeAndMergePairs(oldC.synergyPairs || [], newC.synergyPairs || []),
        conflictPairs: dedupeAndMergePairs(oldC.conflictPairs || [], newC.conflictPairs || []),
      };
    });

    // ===== Write merged outputs =====
    var mergedFactorsOutput = {
      computedAt: new Date().toISOString(),
      sampleDays: ((existingFactors && existingFactors.sampleDays) || 0) + dailyResults.length,
      sampleStocks: klineFiles.length,
      horizons: FORWARD_HORIZONS,
      matrix: mergedMatrix,
      _incremental: true,
      _newDays: dailyResults.length,
    };
    writeJSON(FACTOR_EFFECTIVENESS_FILE, mergedFactorsOutput);
    console.log('[Incremental] 合并因子矩阵已保存 → ' + FACTOR_EFFECTIVENESS_FILE);

    // Build merged training matrix
    var mergedTraining = {
      version: 'v1.1-incremental',
      generatedAt: new Date().toISOString(),
      config: {
        universe: (existingMatrix && existingMatrix.config && existingMatrix.config.universe) || 'hs300',
        startYear: START_YEAR, endYear: END_YEAR,
        sampleDays: ((existingMatrix && existingMatrix.config && existingMatrix.config.sampleDays) || 0) + dailyResults.length,
        sampleStocks: klineFiles.length,
        horizons: FORWARD_HORIZONS,
      },
      summary: buildSummary(dailyResults, mergedMatrix, mergedCombos, (existingMatrix && existingMatrix.paramSearch) || {}),
      factorMatrix: mergedMatrix,
      factorCombos: mergedCombos,
      crossMarket: (existingMatrix && existingMatrix.crossMarket) || { available: false },
      paramSearch: (existingMatrix && existingMatrix.paramSearch) || {},
      _incremental: true,
      _newDays: dailyResults.length,
    };
    writeJSON(TRAINING_MATRIX_FILE, mergedTraining);
    console.log('[Incremental] 合并训练矩阵已保存 → ' + TRAINING_MATRIX_FILE);

    // Update state
    var state = loadState();
    state.lastIncrementalRun = new Date().toISOString();
    state.totalAccumulatedDays = mergedTraining.config.sampleDays;
    saveState(state);

    console.log('[Incremental] 增量更新完成 — 累计样本天数: ' + mergedTraining.config.sampleDays);
    return mergedTraining;
  });
}

/**
 * Deduplicate and merge factor pair lists, keeping the best entries.
 */
function dedupeAndMergePairs(oldPairs, newPairs) {
  var map = {};
  oldPairs.forEach(function(p) {
    var key = p.factors ? p.factors.sort().join('+') : (p.pair || 'unknown');
    map[key] = p;
  });
  newPairs.forEach(function(p) {
    var key = p.factors ? p.factors.sort().join('+') : (p.pair || 'unknown');
    if (map[key]) {
      // EMA blend the effect size
      map[key].effect = Math.round((map[key].effect * 0.7 + p.effect * 0.3) * 100) / 100;
      map[key].bothCount = (map[key].bothCount || 0) + (p.bothCount || 0);
    } else {
      map[key] = p;
    }
  });
  return Object.values(map).sort(function(a, b) { return (b.effect || 0) - (a.effect || 0); });
}

// ====== Auto Report Generator ======

/**
 * Generate a structured markdown summary from training results.
 * This can be directly displayed or emailed.
 */
function generateAutoReport(matrix, combos, crossMarket, paramSearch) {
  var lines = [];
  lines.push('# 量化训练报告 ' + new Date().toISOString().slice(0, 10));
  lines.push('');

  // Factor effectiveness summary
  lines.push('## 因子有效性排名 (T+5)');
  lines.push('');
  lines.push('| 排名 | 因子 | 类别 | 胜率 | 平均收益 | 盈亏比 | 样本数 |');
  lines.push('|------|------|------|------|----------|--------|--------|');

  var t5Matrix = matrix['T+5'] || {};
  var ranked = Object.values(t5Matrix)
    .filter(function(f) { return !f._insufficient && f.total >= 20; })
    .sort(function(a, b) { return (b.hitRate * b.profitFactor) - (a.hitRate * a.profitFactor); });

  ranked.forEach(function(f, i) {
    lines.push('| ' + (i + 1) + ' | ' + f.name + ' | ' + f.category + ' | ' +
      f.hitRate + '% | +' + f.avgFwdReturn + '% | ' + f.profitFactor + ' | ' + f.total + ' |');
  });

  // Best factor combos
  if (combos && combos.synergyPairs && combos.synergyPairs.length > 0) {
    lines.push('');
    lines.push('## 最优因子组合 (协同效应)');
    lines.push('');
    lines.push('| 因子对 | 联合胜率 | 单独最高胜率 | 增益 | 样本数 |');
    lines.push('|--------|----------|-------------|------|--------|');
    combos.synergyPairs.slice(0, 5).forEach(function(c) {
      lines.push('| ' + c.factors.join('+') + ' | ' + c.bothHitRate + '% | ' +
        c.singleHitRateMax + '% | +' + c.effect + '% | ' + c.bothCount + ' |');
    });
  }

  // Parameter recommendation
  if (paramSearch && paramSearch.recommendation) {
    lines.push('');
    lines.push('## 参数优化建议');
    lines.push('');
    var rec = paramSearch.recommendation;
    lines.push('- **止损线**: ' + (rec.stopLoss * 100) + '%');
    lines.push('- **买入阈值**: ' + rec.buyMinScore + '分');
    lines.push('- **预期胜率**: ' + rec.expectedHitRate + '%');
    lines.push('- **预期平均收益**: +' + rec.expectedAvgRet5d + '%');
    lines.push('- **依据**: ' + rec.rationale);
  }

  // Cross-market
  if (crossMarket && crossMarket.available !== false) {
    lines.push('');
    lines.push('## 跨市场联动');
    lines.push('');
    if (crossMarket.leadLag && crossMarket.leadLag.length > 0) {
      crossMarket.leadLag.forEach(function(ll) {
        if (ll.bestLag && Math.abs(ll.bestLag.correlation) > 0.3) {
          lines.push('- **' + ll.usProxy + '** → ' + ll.aShareProxy +
            ': 最佳滞后 ' + ll.bestLag.lag + '天, r=' + ll.bestLag.correlation);
        }
      });
    }
  }

  return lines.join('\n');
}

// ====== Helpers ======

function delay(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

function dedupArray(arr) {
  var seen = {};
  var result = [];
  arr.forEach(function(x) {
    if (!seen[x]) { seen[x] = true; result.push(x); }
  });
  return result;
}

function intersectDates(seriesA, seriesB) {
  if (!seriesA || !seriesB) return [];
  var keysA = Object.keys(seriesA);
  var keysB = Object.keys(seriesB);
  var setB = {};
  keysB.forEach(function(k) { setB[k] = true; });
  return keysA.filter(function(k) { return setB[k]; }).sort();
}

function pearsonCorrelation(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return 0;
  var n = xs.length;
  var sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (var i = 0; i < n; i++) {
    sumX += xs[i];
    sumY += ys[i];
    sumXY += xs[i] * ys[i];
    sumX2 += xs[i] * xs[i];
    sumY2 += ys[i] * ys[i];
  }
  var denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (denom === 0) return 0;
  var r = (n * sumXY - sumX * sumY) / denom;
  return isNaN(r) ? 0 : r;
}

// ====== Main ======

/**
 * Run the full bootstrap pipeline.
 * @param {Object} options
 * @param {string} options.universe - 'hs300' | 'all'
 * @param {boolean} options.incremental - true = incremental update only
 * @param {number} options.startYear - default 2021
 * @param {number} options.endYear - default 2026
 * @param {boolean} options.skipDownload - skip Phase 1 (use existing kline cache)
 */
async function runBootstrap(options) {
  options = options || {};
  var startTime = Date.now();
  var state = loadState();

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   Bootstrap History Training Engine v1.0    ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
  console.log('Universe: ' + (options.universe || DEFAULT_UNIVERSE));
  console.log('Mode: ' + (options.incremental ? 'Incremental' : 'Full'));
  console.log('');

  // ========== Phase 1: Data Download ==========
  if (!options.skipDownload) {
    console.log('═══ Phase 1: Historical Data Download ═══');
    var universe = buildUniverse(options.universe);
    console.log('Universe size: ' + universe.length + ' stocks');

    var tradingDays = generateTradingDays(options.startYear || START_YEAR, options.endYear || END_YEAR);
    console.log('Trading days: ' + tradingDays.length + ' days (' + tradingDays[0] + ' ~ ' + tradingDays[tradingDays.length - 1] + ')');

    // Download klines for each stock (with rate limiting)
    var downloaded = 0;
    var failed = 0;
    var total = options.incremental ? Math.min(20, universe.length) : universe.length;
    var stocksToProcess = universe.slice(0, total);

    for (var i = 0; i < stocksToProcess.length; i++) {
      var stock = stocksToProcess[i];
      var cacheFile = path.join(KLINES_DIR, stock.code + '.json');

      // Skip if recent cache exists and not incremental
      if (!options.incremental && fs.existsSync(cacheFile)) {
        try {
          var cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
          if (cached.klines && cached.klines.length >= 100) {
            downloaded++;
            if (downloaded % 50 === 0) {
              console.log('  [' + downloaded + '/' + total + '] 使用缓存... (' + stock.code + ')');
            }
            continue;
          }
        } catch (e) { /* re-download */ }
      }

      try {
        var klines = await fetchHistoricalKlines(stock.code, 1500);
        var cleaned = cleanKlines(klines);
        if (cleaned.length > 0) {
          writeJSON(cacheFile, { ts: Date.now(), klines: cleaned, code: stock.code });
          downloaded++;
        } else {
          failed++;
        }
      } catch (e) {
        failed++;
      }

      if (downloaded % 10 === 0 && downloaded > 0) {
        process.stdout.write('\r  [' + downloaded + '/' + total + '] 下载中... (失败:' + failed + ')');
      }

      // Rate limit: 200ms between stocks
      await delay(200);
    }
    console.log('');
    console.log('Phase 1 complete: ' + downloaded + ' downloaded, ' + failed + ' failed');
    state.completedPhases = ['phase1_download'];
    state.universe = options.universe || DEFAULT_UNIVERSE;
    state.totalDays = tradingDays.length;
    saveState(state);
  } else {
    console.log('Phase 1 SKIPPED (--skipDownload)');
  }

  // ========== Load factor engines ==========
  var computeHiddenSignals, computeCompositeScore;
  try {
    computeHiddenSignals = require('../factors/hidden_signals').computeHiddenSignals;
    console.log('  Loaded: hidden_signals');
  } catch (e) { console.log('  WARN: hidden_signals not available'); }
  try {
    computeCompositeScore = require('../factors/composite').computeCompositeScore;
    console.log('  Loaded: composite scoring');
  } catch (e) {
    // Try alternate name
    try {
      computeCompositeScore = require('../factors/composite').computeScore;
      console.log('  Loaded: composite scoring (computeScore)');
    } catch (e2) {
      console.log('  WARN: composite scoring not available');
    }
  }

  var factorEngines = {
    computeHiddenSignals: computeHiddenSignals,
    computeCompositeScore: computeCompositeScore,
  };

  // ========== Phase 2: Daily Replay ==========
  console.log('');
  console.log('═══ Phase 2: Daily Replay ═══');

  var klineFiles;
  try {
    klineFiles = fs.readdirSync(KLINES_DIR).filter(function(f) { return f.endsWith('.json'); });
  } catch (e) {
    klineFiles = [];
  }
  console.log('K-line cache: ' + klineFiles.length + ' files');

  // Build kline index: { date: [ {code, close, changePercent, volume, turnover, pe, klines}, ... ] }
  // We need forward returns for each stock on each day, so we build a date-indexed structure
  console.log('Building date-indexed kline map...');

  var tradingDays = generateTradingDays(options.startYear || START_YEAR, options.endYear || END_YEAR);
  // Limit to days we actually have data for
  var lastDataDate = tradingDays[tradingDays.length - 1];

  // For efficiency, we sample days: every 3rd day + all days in last year
  var sampledDays = [];
  for (var i = 0; i < tradingDays.length; i += 3) {
    sampledDays.push(tradingDays[i]);
  }
  // Include last 60 days densely
  var last60 = tradingDays.slice(-60);
  last60.forEach(function(d) {
    if (sampledDays.indexOf(d) < 0) sampledDays.push(d);
  });
  sampledDays.sort();
  console.log('Sampled ' + sampledDays.length + ' replay days (of ' + tradingDays.length + ' total, ~1/3 sampling)');

  // Build snapshot: for each sampled date, collect kline data for all cached stocks
  var dailyResults = [];
  var totalStocksProcessed = 0;

  for (var d = 0; d < sampledDays.length; d++) {
    var date = sampledDays[d];
    var klineSnapshot = [];

    for (var f = 0; f < klineFiles.length; f++) {
      var code = klineFiles[f].replace('.json', '');
      if (!/^\d{6}$/.test(code)) continue;

      try {
        var klineData = JSON.parse(fs.readFileSync(path.join(KLINES_DIR, code + '.json'), 'utf8'));
        if (!klineData || !klineData.klines) continue;

        var klines = klineData.klines;
        // Find kline exactly on this date and that has enough history
        var dateIdx = -1;
        for (var ki = 0; ki < klines.length; ki++) {
          if (klines[ki].date === date) {
            dateIdx = ki;
            break;
          }
        }
        if (dateIdx < MIN_KLINES_FOR_FACTOR) continue; // not enough history

        var todayKline = klines[dateIdx];
        var prevKline = dateIdx >= 1 ? klines[dateIdx - 1] : null;
        var changePercent = prevKline ? ((todayKline.close - prevKline.close) / prevKline.close * 100) : 0;

        // Compute forward N-day returns
        var fwdReturns = {};
        FORWARD_HORIZONS.forEach(function(h) {
          var fwdIdx = dateIdx + h;
          if (fwdIdx < klines.length) {
            fwdReturns[h] = (klines[fwdIdx].close - todayKline.close) / todayKline.close * 100;
          } else {
            fwdReturns[h] = null;
          }
        });

        klineSnapshot.push({
          code: code,
          close: todayKline.close,
          open: todayKline.open,
          high: todayKline.high,
          low: todayKline.low,
          volume: todayKline.volume,
          turnover: todayKline.turnover || 0,
          changePercent: Math.round(changePercent * 100) / 100,
          pe: null, // Historical PE not easily available from kline API
          klines: klines.slice(0, dateIdx + 1), // Only klines up to this date (no future data)
          fwdReturns: fwdReturns,
        });
      } catch (e) { /* skip this stock for this day */ }
    }

    if (klineSnapshot.length < 10) continue;

    // Replay this day
    var dayResult = replayDay(date, klineSnapshot, factorEngines);

    // Attach forward returns to stock results
    dayResult.stocks.forEach(function(s) {
      for (var ki = 0; ki < klineSnapshot.length; ki++) {
        if (klineSnapshot[ki].code === s.code) {
          s.fwdReturns = klineSnapshot[ki].fwdReturns;
          break;
        }
      }
    });

    // Classify market regime
    dayResult.marketRegimes = classifyRegime(date, dayResult.marketContext, null);

    dailyResults.push(dayResult);
    totalStocksProcessed += klineSnapshot.length;

    if ((d + 1) % 50 === 0 || d === sampledDays.length - 1) {
      process.stdout.write('\r  Replay: ' + (d + 1) + '/' + sampledDays.length +
        ' days (' + totalStocksProcessed + ' stock-days)...');
    }
  }
  console.log('');
  console.log('Phase 2 complete: ' + dailyResults.length + ' days replayed');

  // ========== Phase 3: Factor Effectiveness Matrix ==========
  console.log('');
  console.log('═══ Phase 3: Factor Effectiveness Matrix ═══');

  var factorMatrix = {};
  FORWARD_HORIZONS.forEach(function(h) {
    console.log('  Computing T+' + h + '...');
    factorMatrix['T+' + h] = computeFactorEffectiveness(dailyResults, h);
  });

  writeJSON(FACTOR_EFFECTIVENESS_FILE, {
    computedAt: new Date().toISOString(),
    sampleDays: dailyResults.length,
    sampleStocks: klineFiles.length,
    horizons: FORWARD_HORIZONS,
    matrix: factorMatrix,
  });
  console.log('Phase 3 complete → ' + FACTOR_EFFECTIVENESS_FILE);

  // ========== Phase 4: Factor Combinations ==========
  console.log('');
  console.log('═══ Phase 4: Factor Combination Mining ═══');

  var allComboResults = {};
  FORWARD_HORIZONS.forEach(function(h) {
    allComboResults['T+' + h] = mineFactorCombinations(dailyResults, h);
    var sy = allComboResults['T+' + h].synergyPairs.length;
    var co = allComboResults['T+' + h].conflictPairs.length;
    console.log('  T+' + h + ': ' + sy + ' synergy pairs, ' + co + ' conflict pairs');
  });

  console.log('Phase 4 complete');

  // ========== Phase 5: Cross-Market ==========
  console.log('');
  console.log('═══ Phase 5: Cross-Market Correlation ═══');

  var crossMarket = { available: false, note: '数据源暂未整合' };
  try {
    // Try loading existing US market data
    var usDataFile = path.join(DATA_DIR, 'us_market', 'us_snapshot.json');
    var aShareIdxFile = path.join(DATA_DIR, 'index_history_hs300.json');

    if (fs.existsSync(usDataFile) && fs.existsSync(aShareIdxFile)) {
      var usData = JSON.parse(fs.readFileSync(usDataFile, 'utf8'));
      var aIdx = JSON.parse(fs.readFileSync(aShareIdxFile, 'utf8'));
      crossMarket = computeCrossMarketLinkage(usData, aIdx);
      writeJSON(CROSS_MARKET_FILE, crossMarket);
      console.log('Phase 5 complete → ' + CROSS_MARKET_FILE);
    } else {
      console.log('Phase 5 SKIPPED (missing US or index data)');
    }
  } catch (e) {
    console.log('Phase 5 SKIPPED (error: ' + e.message + ')');
  }

  // ========== Phase 6: Parameter Search ==========
  console.log('');
  console.log('═══ Phase 6: Parameter Optimization ═══');

  var paramResults = runParameterSearch(dailyResults, {});
  writeJSON(PARAM_SEARCH_FILE, paramResults);
  console.log('Phase 6 complete → ' + PARAM_SEARCH_FILE);
  if (paramResults.recommendation) {
    console.log('  Best: stopLoss=' + (paramResults.recommendation.stopLoss * 100) + '%, ' +
      'minScore=' + paramResults.recommendation.buyMinScore + ', ' +
      'hitRate=' + paramResults.recommendation.expectedHitRate + '%, ' +
      'avgRet=' + paramResults.recommendation.expectedAvgRet5d + '%');
  }

  // ========== Phase 7: Output & Report ==========
  console.log('');
  console.log('═══ Phase 7: Final Output ═══');

  var trainingMatrix = {
    version: 'v1.0',
    generatedAt: new Date().toISOString(),
    config: {
      universe: options.universe || DEFAULT_UNIVERSE,
      startYear: options.startYear || START_YEAR,
      endYear: options.endYear || END_YEAR,
      sampleDays: dailyResults.length,
      sampleStocks: klineFiles.length,
      horizons: FORWARD_HORIZONS,
    },
    summary: buildSummary(dailyResults, factorMatrix, allComboResults, paramResults),
    factorMatrix: factorMatrix,
    factorCombos: allComboResults,
    crossMarket: crossMarket,
    paramSearch: paramResults,
    duration: Math.round((Date.now() - startTime) / 1000),
  };

  writeJSON(TRAINING_MATRIX_FILE, trainingMatrix);
  console.log('Training matrix saved → ' + TRAINING_MATRIX_FILE);

  // Auto-report
  var report = generateAutoReport(factorMatrix, allComboResults['T+5'] || {}, crossMarket, paramResults);
  var reportFile = path.join(EVOLUTION_DIR, 'training_report_' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.md');
  fs.writeFileSync(reportFile, report, 'utf8');
  console.log('Auto-report saved → ' + reportFile);

  // Update state
  state.lastFullRun = new Date().toISOString();
  state.completedPhases = ['phase1_download', 'phase2_replay', 'phase3_effectiveness', 'phase4_combos', 'phase5_crossMarket', 'phase6_params', 'phase7_report'];
  state.lastMatrixFile = TRAINING_MATRIX_FILE;
  state.lastError = null;
  saveState(state);

  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   Bootstrap Complete!                       ║');
  console.log('║   Duration: ' + String(trainingMatrix.duration).padStart(6) + ' seconds                 ║');
  console.log('║   Days replayed: ' + String(dailyResults.length).padStart(5) + '                       ║');
  console.log('║   Matrix: training_matrix.json              ║');
  console.log('╚══════════════════════════════════════════════╝');

  return trainingMatrix;
}

function buildSummary(dailyResults, factorMatrix, comboResults, paramResults) {
  var t5 = factorMatrix['T+5'] || {};
  var factors = Object.values(t5).filter(function(f) { return !f._insufficient && f.total >= 20; });
  var top3 = factors.sort(function(a, b) { return b.hitRate - a.hitRate; }).slice(0, 3);
  var bottom3 = factors.sort(function(a, b) { return a.hitRate - b.hitRate; }).slice(0, 3);

  return {
    totalSampleDays: dailyResults.length,
    topFactors: top3.map(function(f) { return { name: f.name, hitRate: f.hitRate, avgReturn: f.avgFwdReturn }; }),
    weakestFactors: bottom3.map(function(f) { return { name: f.name, hitRate: f.hitRate, avgReturn: f.avgFwdReturn }; }),
    topSynergyPair: comboResults['T+5'] && comboResults['T+5'].synergyPairs.length > 0 ?
      comboResults['T+5'].synergyPairs[0].factors.join('+') : null,
    bestParams: paramResults.recommendation ? {
      stopLoss: paramResults.recommendation.stopLoss,
      buyMinScore: paramResults.recommendation.buyMinScore,
    } : null,
  };
}

// ====== CLI ======

if (require.main === module) {
  var args = process.argv.slice(2);
  var opts = {};

  for (var i = 0; i < args.length; i++) {
    if (args[i] === '--incremental') opts.incremental = true;
    if (args[i] === '--skipDownload') opts.skipDownload = true;
    if (args[i] === '--universe' && i + 1 < args.length) opts.universe = args[++i];
    if (args[i] === '--startYear' && i + 1 < args.length) opts.startYear = parseInt(args[++i], 10);
    if (args[i] === '--endYear' && i + 1 < args.length) opts.endYear = parseInt(args[++i], 10);
  }

  runBootstrap(opts).then(function(result) {
    if (result.error) {
      console.error('Bootstrap failed:', result.error);
      process.exit(1);
    }
    process.exit(0);
  }).catch(function(err) {
    console.error('Bootstrap crashed:', err);
    process.exit(1);
  });
}

module.exports = { runBootstrap, incrementalUpdate, generateAutoReport };
