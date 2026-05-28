/**
 * factor_performance.js — 因子绩效追踪引擎
 *
 * 读取历史 scan_records 和 daily summaries，计算每个隐藏因子的：
 *   - 命中率 (hit rate): 高信号日 → 次日市场涨 = 命中
 *   - 平均收益 (avg return): 高信号日后次日市场平均涨跌幅
 *   - 趋势 (trend): 近5日 vs 前5日对比
 *   - 信号历史 (signal history): 最近N次扫描的信号触发次数
 *
 * 输出到 report-engine/data/simfolio/factor_performance.json
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'simfolio');
const SUMMARIES_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'summaries');

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
 * Read all available scan record dates (from scan_records files + last_pipeline_result), sorted chronologically.
 */
function getAvailableDates() {
  const dates = new Set();
  if (!fs.existsSync(DATA_DIR)) return [];

  // Scan records files
  const files = fs.readdirSync(DATA_DIR);
  for (const f of files) {
    const m = f.match(/^scan_records_(\d{4}-\d{2}-\d{2})\.json$/);
    if (m) dates.add(m[1]);
  }

  // Fallback: last_pipeline_result.json date
  const lastPath = path.join(DATA_DIR, 'last_pipeline_result.json');
  if (fs.existsSync(lastPath)) {
    try {
      const lp = JSON.parse(fs.readFileSync(lastPath, 'utf8'));
      const lpDate = lp.date || (lp.time ? lp.time.slice(0, 10) : null);
      if (lpDate) dates.add(lpDate);
    } catch (_) {}
  }

  const sorted = Array.from(dates).sort();
  return sorted;
}

/**
 * Load scan records for a specific date.
 * Prefers scan_records file, falls back to last_pipeline_result.
 */
function loadScanRecords(date) {
  const filePath = path.join(DATA_DIR, 'scan_records_' + date + '.json');
  const records = [];

  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      for (const r of data) {
        records.push(r);
      }
    } catch (_) {}
  }

  // If no records with signalCounts found, try last_pipeline_result as fallback
  const hasSignalCounts = records.some(r => r.signalCounts && Object.keys(r.signalCounts).length > 0);
  if (!hasSignalCounts) {
    const lastPath = path.join(DATA_DIR, 'last_pipeline_result.json');
    if (fs.existsSync(lastPath)) {
      try {
        const lp = JSON.parse(fs.readFileSync(lastPath, 'utf8'));
        const lpDate = lp.date || (lp.time ? lp.time.slice(0, 10) : null);
        if (lpDate === date && lp.signalCounts && Object.keys(lp.signalCounts).length > 0) {
          records.push({
            time: lp.time,
            scanType: lp.type || 'full',
            totalStocks: lp.totalStocks,
            candidates: lp.candidates,
            analyzed: lp.analyzed,
            signalCounts: lp.signalCounts,
            avgScore: lp.avgScore,
            maxScore: lp.maxScore,
          });
        }
      } catch (_) {}
    }
  }

  return records;
}

/**
 * Load daily summary for a specific date to get market returns.
 */
function loadDailySummary(date) {
  const filePath = path.join(SUMMARIES_DIR, date + '.json');
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * Get next-day market return proxy.
 * Uses the daily summary's index changes; falls back to scan record context.
 */
function getNextDayReturn(date) {
  // Parse date and get next trading day (skip weekends)
  const d = new Date(date + 'T12:00:00+08:00');
  d.setDate(d.getDate() + 1);
  // Skip to Monday if weekend
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  const nextDate = d.toISOString().slice(0, 10);

  const summary = loadDailySummary(nextDate);
  if (!summary || !summary.market || !summary.market.indices) return null;

  // Use average of available index changes as market return proxy
  const indices = summary.market.indices;
  let totalChg = 0, count = 0;
  for (const idx of indices) {
    if (idx.changePercent != null) {
      totalChg += idx.changePercent;
      count++;
    }
  }
  return count > 0 ? totalChg / count : null;
}

/**
 * Compute factor performance for all 9 factors.
 *
 * Algorithm:
 *   For each scan date with records:
 *     1. Get total signalCounts across all scans for that day
 *     2. Check if total signal count was "high" (above that factor's 10-day median)
 *     3. Get next-day market return
 *     4. If high signals + positive next-day return = hit; high signals + negative = miss
 *     5. Compute rolling hit rates over 5d and 20d windows
 *
 * @param {object} options - { days: number (lookback, default 20) }
 * @returns {object} { factors: [], summary: {} }
 */
function computeFactorPerformance(options) {
  const opts = options || {};
  const lookbackDays = opts.days || 20;

  const dates = getAvailableDates();

  // Need at least 2 days for hit rate, but still show signal counts with 1 day
  const hasEnoughData = dates.length >= 2;

  const recentDates = dates.slice(-Math.min(lookbackDays, dates.length));

  // Aggregate signal counts per factor per date (use max across scans for that day)
  const dailySignalCounts = {};   // { date: { H1: n, H2: n, ... } }
  const dailyAnalyzed = {};       // { date: totalAnalyzed }

  for (const date of recentDates) {
    const records = loadScanRecords(date);
    if (records.length === 0) continue;

    dailySignalCounts[date] = {};
    let maxAnalyzed = 0;

    // Take max signal count per factor across all scans that day
    for (const rec of records) {
      if (!rec.signalCounts) continue;
      if (rec.analyzed > maxAnalyzed) maxAnalyzed = rec.analyzed;
      for (const fid of Object.keys(rec.signalCounts)) {
        const prev = dailySignalCounts[date][fid] || 0;
        if (rec.signalCounts[fid] > prev) {
          dailySignalCounts[date][fid] = rec.signalCounts[fid];
        }
      }
    }
    dailyAnalyzed[date] = maxAnalyzed;
  }

  const sortedDates = Object.keys(dailySignalCounts).sort();

  // For each factor, compute hit/miss series
  const factorResults = [];

  for (const factor of FACTORS) {
    const signalHistory = [];   // signal counts per day
    const hitHistory = [];      // 1=hit, 0=miss (binary)
    const returnHistory = [];   // next-day return per day

    for (let i = 0; i < sortedDates.length - 1; i++) {
      const date = sortedDates[i];
      const count = dailySignalCounts[date][factor.id] || 0;
      signalHistory.push(count);

      const nextReturn = getNextDayReturn(date);
      if (nextReturn != null) {
        returnHistory.push(nextReturn);
        // "High signals" = above zero for this factor on this day
        // Hit = factor triggered AND next day market was positive
        if (count > 0 && nextReturn > 0) {
          hitHistory.push(1);
        } else if (count > 0 && nextReturn <= 0) {
          hitHistory.push(0);
        } else {
          // Factor didn't trigger — neutral, don't count
          hitHistory.push(-1);  // -1 = no signal, excluded from hit rate
        }
      }
    }

    // Compute hit rate (exclude -1 "no signal" days)
    const validHits = hitHistory.filter(h => h >= 0);
    const hitRate = validHits.length > 0
      ? validHits.reduce((a, b) => a + b, 0) / validHits.length
      : null;

    // 5-day and 20-day rolling hit rates
    const hitRate5d = computeRollingHitRate(hitHistory, 5);
    const hitRate20d = computeRollingHitRate(hitHistory, 20);

    // Trend: compare last 5 valid hit days vs prior 5
    const trend = computeTrend(hitHistory);

    // Avg return on signal days
    const signalReturns = [];
    for (let i = 0; i < hitHistory.length; i++) {
      if (hitHistory[i] >= 0 && returnHistory[i] != null) {
        signalReturns.push(returnHistory[i]);
      }
    }
    const avgReturn = signalReturns.length > 0
      ? signalReturns.reduce((a, b) => a + b, 0) / signalReturns.length
      : null;

    // Most recent signal count (always take from last date, even with 1 day)
    const lastDate = sortedDates[sortedDates.length - 1];
    const latestSignalCount = dailySignalCounts[lastDate]
      ? (dailySignalCounts[lastDate][factor.id] || 0)
      : 0;

    // If we have only 1 day, still include the last day's count in history
    if (signalHistory.length === 0 && sortedDates.length === 1 && latestSignalCount > 0) {
      signalHistory.push(latestSignalCount);
    }

    // Status: hot / stable / cold
    let status = 'stable';
    if (hitRate != null) {
      if (hitRate >= 0.55) status = 'hot';
      else if (hitRate < 0.40) status = 'cold';
    }

    factorResults.push({
      id: factor.id,
      name: factor.name,
      hitRate: hitRate,
      hitRate5d: hitRate5d,
      hitRate20d: hitRate20d,
      trend: trend,
      avgReturn: avgReturn,
      signalCount: latestSignalCount,
      signalHistory: signalHistory.slice(-10),  // last 10 for sparkline
      hitHistory: hitHistory.slice(-10),
      status: status,
      totalSignalDays: validHits.length,
    });
  }

  return {
    factors: factorResults,
    summary: {
      updatedAt: new Date().toISOString(),
      daysAvailable: sortedDates.length,
      dataSource: 'scan_records',
      totalScans: sortedDates.length,
      hitRatesAvailable: hasEnoughData,
    },
  };
}

function buildEmptyFactors() {
  return FACTORS.map(f => ({
    id: f.id,
    name: f.name,
    hitRate: null,
    hitRate5d: null,
    hitRate20d: null,
    trend: 'stable',
    avgReturn: null,
    signalCount: 0,
    signalHistory: [],
    hitHistory: [],
    status: 'stable',
    totalSignalDays: 0,
  }));
}

function computeRollingHitRate(hitHistory, window) {
  const valid = hitHistory.filter(h => h >= 0);
  if (valid.length < window) return null;
  const recent = valid.slice(-window);
  const hits = recent.reduce((a, b) => a + b, 0);
  return hits / recent.length;
}

function computeTrend(hitHistory) {
  const valid = hitHistory.filter(h => h >= 0);
  if (valid.length < 6) return 'stable';

  const mid = Math.floor(valid.length / 2);
  const recent = valid.slice(-mid);
  const older = valid.slice(0, -mid);

  const recentRate = recent.reduce((a, b) => a + b, 0) / recent.length;
  const olderRate = older.reduce((a, b) => a + b, 0) / older.length;

  if (recentRate - olderRate > 0.15) return 'improving';
  if (recentRate - olderRate < -0.15) return 'declining';
  return 'stable';
}

/**
 * Update the persistent performance cache after each scan.
 */
function updatePerformanceCache(date, signalCounts, totalAnalyzed) {
  // Read existing cache
  const cachePath = path.join(DATA_DIR, 'factor_performance.json');
  let cache = { dailySnapshots: [] };
  if (fs.existsSync(cachePath)) {
    try {
      cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch (_) {}
  }

  // Add or update today's snapshot
  const existing = cache.dailySnapshots.find(s => s.date === date);
  if (existing) {
    // Merge signal counts (take max)
    for (const [k, v] of Object.entries(signalCounts || {})) {
      existing.signalCounts[k] = Math.max(existing.signalCounts[k] || 0, v);
    }
    existing.totalAnalyzed = Math.max(existing.totalAnalyzed || 0, totalAnalyzed || 0);
  } else {
    cache.dailySnapshots.push({
      date: date,
      signalCounts: signalCounts || {},
      totalAnalyzed: totalAnalyzed || 0,
    });
  }

  // Keep last 60 snapshots
  if (cache.dailySnapshots.length > 60) {
    cache.dailySnapshots = cache.dailySnapshots.slice(-60);
  }

  // Compute and cache full performance
  const perf = computeFactorPerformance({ days: 20 });
  cache.factors = perf.factors;
  cache.summary = perf.summary;
  cache.updatedAt = new Date().toISOString();

  try {
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
  } catch (_) {}
}

/**
 * Load cached performance (fast path, no file scanning).
 */
function loadCachedPerformance() {
  const cachePath = path.join(DATA_DIR, 'factor_performance.json');
  if (!fs.existsSync(cachePath)) return null;
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return { factors: cache.factors || buildEmptyFactors(), summary: cache.summary || {} };
  } catch (_) {
    return null;
  }
}

module.exports = { computeFactorPerformance, updatePerformanceCache, loadCachedPerformance, FACTORS };
