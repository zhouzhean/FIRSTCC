/**
 * capital_flow.js — 主力资金流采集器
 *
 * 东方财富资金流 API:
 *   1. 板块资金流排名 — push2 clist/get fs=m:90+t:3
 *   2. 个股资金流历史 — push2his fflow/daykline/get
 *
 * 用于方向性资金流评分，替代原纯活跃度指标。
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
        'Referer': referer || 'https://data.eastmoney.com/',
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

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---- Sector Capital Flow ----

/**
 * Fetch all sector (板块) capital flow rankings.
 * Returns array sorted by 主力净流入 descending.
 */
async function fetchSectorFlow() {
  const FIELDS = [
    'f12','f14','f2','f3','f62','f184','f66','f69',
    'f72','f75','f78','f81','f84','f87','f124',
  ].join(',');

  const url = 'https://push2.eastmoney.com/api/qt/clist/get' +
    '?pn=1&pz=500&po=1&np=1' +
    '&ut=bd1d9ddb04089700cf9c27f6f7426281' +
    '&fltt=2&invt=2&fid=f62' +
    '&fs=m:90+t:3' +
    '&fields=' + FIELDS;

  try {
    const res = await fetchJSON(url, 'https://data.eastmoney.com/');
    if (!res || !res.data || !res.data.diff) return [];

    return res.data.diff.map(item => ({
      code: item.f12 || '',
      name: item.f14 || '',
      price: item.f2 != null ? parseFloat(item.f2) : null,
      changePercent: item.f3 != null ? parseFloat(item.f3) : null,
      majorNetFlow: item.f62 != null ? parseFloat(item.f62) : null,
      majorNetFlowRatio: item.f184 != null ? parseFloat(item.f184) : null,
      superLargeNetFlow: item.f66 != null ? parseFloat(item.f66) : null,
      superLargeRatio: item.f69 != null ? parseFloat(item.f69) : null,
      largeNetFlow: item.f72 != null ? parseFloat(item.f72) : null,
      largeRatio: item.f75 != null ? parseFloat(item.f75) : null,
      mediumNetFlow: item.f78 != null ? parseFloat(item.f78) : null,
      mediumRatio: item.f81 != null ? parseFloat(item.f81) : null,
      smallNetFlow: item.f84 != null ? parseFloat(item.f84) : null,
      smallRatio: item.f87 != null ? parseFloat(item.f87) : null,
    }));
  } catch (e) {
    console.error('  [CapitalFlow] Sector flow fetch failed:', e.message);
    return [];
  }
}

// ---- Stock Capital Flow History ----

/**
 * Fetch daily capital flow history for a single stock.
 * Returns array of daily flow records (most recent first).
 *
 * Fields2 mapping:
 *   f51=date, f52=主力净流入, f53=主力占比%, f54=超大单净流入, f55=超大单占比%,
 *   f56=大单净流入, f57=大单占比%, f58=中单净流入, f59=中单占比%,
 *   f60=小单净流入, f61=小单占比%
 */
async function fetchStockFlowHistory(code, days = 10) {
  const market = code.startsWith('6') ? '1' : '0';
  const secid = market + '.' + code;

  const url = 'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get' +
    '?secid=' + secid +
    '&klt=101&lmt=' + days +
    '&ut=b2884a393a59ad64002292a3e90d46a5' +
    '&fields1=f1,f2,f3,f7' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';

  try {
    const res = await fetchJSON(url, 'https://data.eastmoney.com/');
    if (!res || !res.data || !res.data.klines) return [];

    return res.data.klines.map(line => {
      const parts = line.split(',');
      return {
        date: parts[0],
        majorNetFlow: parseFloat(parts[1]) || 0,
        majorNetFlowRatio: parseFloat(parts[2]) || 0,
        superLargeNetFlow: parseFloat(parts[3]) || 0,
        superLargeRatio: parseFloat(parts[4]) || 0,
        largeNetFlow: parseFloat(parts[5]) || 0,
        largeRatio: parseFloat(parts[6]) || 0,
        mediumNetFlow: parseFloat(parts[7]) || 0,
        mediumRatio: parseFloat(parts[8]) || 0,
        smallNetFlow: parseFloat(parts[9]) || 0,
        smallRatio: parseFloat(parts[10]) || 0,
      };
    });
  } catch (e) {
    // Silently fail — capital flow is optional enhancement
    return [];
  }
}

/**
 * Fetch stock flow history for multiple codes with rate limiting.
 */
async function fetchStockFlowBatch(codes, days = 10) {
  const results = {};
  for (const code of codes) {
    try {
      const flow = await fetchStockFlowHistory(code, days);
      if (flow.length > 0) {
        results[code] = flow;
      }
    } catch (e) {
      // skip individual failures
    }
    await delay(250); // Rate limit
  }
  return results;
}

module.exports = {
  fetchSectorFlow,
  fetchStockFlowHistory,
  fetchStockFlowBatch,
};
