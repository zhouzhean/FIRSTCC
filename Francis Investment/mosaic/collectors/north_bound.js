/**
 * north_bound.js — 北向资金（沪深港通）数据采集器
 *
 * 数据源：东方财富 push2his kamt.kline API
 * secid=1.3003FF 北向资金合计
 *
 * 提供：北向净流入序列、连续流入天数、市场情绪判断
 */
const http = require('http');
const https = require('https');

// ---- Helpers ----

function fetchJSON(url, referer) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': referer || 'https://data.eastmoney.com/hsgt/index.html',
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = data.replace(/^[^(]*\(/, '').replace(/\);?\s*$/, '');
          resolve(JSON.parse(json));
        } catch (e) {
          reject(new Error('Parse error: ' + e.message));
        }
      });
    }).on('error', reject);
  });
}

// ---- North-bound Flow ----

/**
 * Fetch north-bound capital flow history.
 *
 * Fields2 mapping:
 *   f51=date, f52=沪股通当日净流入, f53=沪股通累计净流入,
 *   f54=深股通当日净流入, f55=深股通累计净流入,
 *   f56=北向当日净流入合计, f57=北向累计净流入合计
 *
 * @param {number} days - Number of trading days to fetch
 */
async function fetchNorthBoundFlow(days = 20) {
  const url = 'https://push2his.eastmoney.com/api/qt/kamt.kline/get' +
    '?secid=1.3003FF' +
    '&klt=101&lmt=' + days +
    '&ut=b2884a393a59ad64002292a3e90d46a5' +
    '&fields1=f1,f2,f3,f7' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57';

  try {
    const res = await fetchJSON(url, 'https://data.eastmoney.com/hsgt/index.html');
    if (!res || !res.data || !res.data.klines) return [];

    return res.data.klines.map(line => {
      const parts = line.split(',');
      return {
        date: parts[0],
        shFlow: parseFloat(parts[1]) || 0,       // 沪股通净流入
        shCumulative: parseFloat(parts[2]) || 0,  // 沪股通累计
        szFlow: parseFloat(parts[3]) || 0,        // 深股通净流入
        szCumulative: parseFloat(parts[4]) || 0,  // 深股通累计
        totalFlow: parseFloat(parts[5]) || 0,     // 北向合计净流入
        totalCumulative: parseFloat(parts[6]) || 0, // 北向合计累计
      };
    }).reverse(); // oldest first
  } catch (e) {
    console.error('  [NorthBound] Flow fetch failed:', e.message);
    return [];
  }
}

/**
 * Compute north-bound sentiment from flow history.
 *
 * @param {Array} flowData - Array from fetchNorthBoundFlow
 * @returns {object} sentiment summary
 */
function computeSentiment(flowData) {
  if (!flowData || flowData.length === 0) {
    return {
      available: false,
      sentiment: 'neutral',
      consecutiveInflow: 0,
      last5DaysTotal: 0,
    };
  }

  // Count consecutive net inflow days (most recent first)
  let consecutiveInflow = 0;
  for (let i = flowData.length - 1; i >= 0; i--) {
    if (flowData[i].totalFlow > 0) {
      consecutiveInflow++;
    } else {
      break;
    }
  }

  // Last 5 trading days total flow
  const recent = flowData.slice(-5);
  const last5DaysTotal = recent.reduce((sum, d) => sum + d.totalFlow, 0);

  // Last 1 day
  const lastDay = flowData[flowData.length - 1];

  // Sentiment classification
  let sentiment = 'neutral';
  if (consecutiveInflow >= 5) sentiment = 'bullish';
  else if (consecutiveInflow >= 3) sentiment = 'slightly_bullish';
  else if (lastDay && lastDay.totalFlow < -5e9) sentiment = 'bearish'; // >50亿流出
  else if (last5DaysTotal < -1e10) sentiment = 'bearish'; // 5日累计流出>100亿

  return {
    available: true,
    sentiment,
    consecutiveInflow,
    last5DaysTotal: Math.round(last5DaysTotal / 1e8) / 100, // 亿
    lastDayFlow: lastDay ? Math.round(lastDay.totalFlow / 1e8) / 100 : 0,
    lastDayDate: lastDay ? lastDay.date : null,
  };
}

module.exports = {
  fetchNorthBoundFlow,
  computeSentiment,
};
