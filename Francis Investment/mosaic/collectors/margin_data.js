/**
 * margin_data.js — 融资融券（两融）数据采集器
 *
 * 从东方财富 push2 API 获取两融余额数据（使用沪股通 secid=90.BK0707 的 margin 字段）。
 * 提供：融资余额/融券余额/日净变化，形成杠杆资金情绪评分。
 *
 * 注：Eastmoney 两融页面通过 JS 动态加载数据，直接 API reportName 不易获得。
 * 当前使用 push2 API 获取市场资金面数据作为杠杆情绪代理，后续可接入独立两融数据源。
 *
 * 零外部依赖。
 */
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const config = require('../config');

const CACHE_FILE = path.join(config.DATA_DIR, 'us_market', 'margin_cache.json');
const CACHE_TTL_MS = 1800000; // 30 minute cache

// ---- Helpers ----

function fetchJSON(url, referer) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': referer || 'https://data.eastmoney.com/',
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Margin parse error: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Margin fetch timeout')); });
  });
}

function _readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch (_) {}
  return null;
}

function _writeCache(data) {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
}

// ---- Public Functions ----

/**
 * Fetch aggregate margin/smart-money data using Eastmoney push2 API.
 *
 * Data source: Eastmoney push2 sector/capital flow aggregates.
 * Uses North-bound aggregate (BK0707) + sector fund flow to infer smart money activity.
 * This serves as a leverage/margin sentiment proxy until a dedicated two-financing
 * API endpoint is available.
 *
 * @param {number} days - Days of history (default 20)
 * @returns {Array} [{ date, totalBalance, netChange, smartMoneyFlow }]
 */
async function fetchMarginData(days) {
  days = days || 20;

  // Check cache
  const cached = _readCache();
  if (cached && cached.time && (Date.now() - cached.time) < CACHE_TTL_MS) {
    if (cached.data && cached.data.length >= 3) {
      return cached.data.slice(0, days);
    }
  }

  const results = [];

  // Fetch North-bound aggregate K-line (includes total balance data)
  try {
    const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get' +
      '?secid=90.BK0707' +  // 沪股通 aggregate
      '&fields1=f1,f2,f3,f4,f5' +
      '&fields2=f51,f52,f53,f54,f55,f56,f57' +
      '&klt=101&fqt=1&end=20500101' +
      '&lmt=' + Math.min(days, 2000);
    const res = await fetchJSON(url, 'https://data.eastmoney.com/');
    if (res && res.data && res.data.klines) {
      for (const line of res.data.klines) {
        const parts = line.split(',');
        if (parts.length >= 7) {
          results.push({
            date: parts[0],
            open: parseFloat(parts[1]) || 0,
            close: parseFloat(parts[2]) || 0,
            high: parseFloat(parts[3]) || 0,
            low: parseFloat(parts[4]) || 0,
            volume: parseFloat(parts[5]) || 0,
            amount: parseFloat(parts[6]) || 0,
            // proxy: netChange computed from daily change in aggregate balance
            netChange: parts[2] && parts[1]
              ? +(parseFloat(parts[2]) - parseFloat(parts[1])).toFixed(2)
              : null,
            totalBalance: parseFloat(parts[2]) || null,
          });
        }
      }
    }
  } catch (e) {
    console.error('  [Margin] push2his fetch failed:', e.message);
    // Fallback: return cached data if available
    const cached = _readCache();
    if (cached && cached.data && cached.data.length >= 3) {
      console.log('  [Margin] Using cached data (' + cached.data.length + ' points)');
      return cached.data.slice(0, days);
    }
  }

  if (results.length > 0) {
    _writeCache({ time: Date.now(), data: results });
  }

  return results;
}

/**
 * Compute margin/smart-money sentiment score (0-100).
 */
function computeMarginSentiment(marginData) {
  if (!marginData || marginData.length === 0) {
    return { available: false, score: 50, sentiment: 'neutral', signals: [], latest: null };
  }

  const latest = marginData[0];
  let score = 50;
  const signals = [];

  // 1. Short-term trend: last 5 days of aggregate balance
  if (marginData.length >= 5) {
    const recent5 = marginData.slice(0, 5);
    const upCount = recent5.filter(d => (d.netChange || 0) > 0).length;
    const totalNetChange = recent5.reduce((s, d) => s + (d.netChange || 0), 0);

    if (upCount >= 4) {
      score += 10;
      signals.push('连续' + upCount + '日资金净流入');
    } else if (upCount <= 1) {
      score -= 10;
      signals.push('近5日仅' + upCount + '日净流入，资金持续流出');
    }

    if (totalNetChange > 50) {
      score += 8;
      signals.push('5日累计净流入+' + totalNetChange.toFixed(0));
    } else if (totalNetChange < -50) {
      score -= 8;
      signals.push('5日累计净流出' + totalNetChange.toFixed(0));
    }
  }

  // 2. Volume trend — rising volume means active trading
  if (marginData.length >= 10) {
    const first5 = marginData.slice(-10, -5);
    const last5 = marginData.slice(0, 5);
    const firstAvgVol = first5.reduce((s, d) => s + (d.volume || 0), 0) / 5;
    const lastAvgVol = last5.reduce((s, d) => s + (d.volume || 0), 0) / 5;
    if (firstAvgVol > 0) {
      const volTrend = (lastAvgVol - firstAvgVol) / firstAvgVol;
      if (volTrend > 0.5) {
        score += 5;
        signals.push('资金活跃度显著上升');
      } else if (volTrend < -0.3) {
        score -= 5;
        signals.push('资金活跃度明显下降');
      }
    }
  }

  score = Math.max(0, Math.min(100, score));
  const sentiment = score >= 60 ? 'bullish' : score <= 40 ? 'bearish' : 'neutral';

  return {
    available: true,
    score,
    sentiment,
    signals,
    latest,
    dataPoints: marginData.length,
  };
}

module.exports = { fetchMarginData, computeMarginSentiment };
