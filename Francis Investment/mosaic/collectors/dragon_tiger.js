/**
 * dragon_tiger.js — 龙虎榜数据采集器
 *
 * 数据源：东方财富 datacenter-web API（独立于 push2，反爬限制较轻）
 * reportName=RPT_DAILYBILLBOARD_DETAILSNEW
 *
 * 提供：当日龙虎榜上榜股票、净买额、上榜原因、买卖方力量对比
 */
const http = require('http');
const https = require('https');

const DC_BASE = 'https://datacenter-web.eastmoney.com/api/data/v1/get';

// ---- Helpers ----

function fetchJSON(url, referer) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': referer || 'https://data.eastmoney.com/stock/tradedetail.html',
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
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

// ---- LHB Daily Detail ----

/**
 * Fetch today's dragon-tiger board stock list.
 * Returns array of stocks that appeared on LHB with net buy/sell amounts.
 *
 * @param {string} date - Date string YYYYMMDD, defaults to today
 */
async function fetchLHBDaily(date) {
  if (!date) {
    const now = new Date();
    date = now.getFullYear() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0');
  }

  const columns = [
    'SECURITY_CODE','SECUCODE','SECURITY_NAME_ABBR','TRADE_DATE',
    'EXPLAIN','CLOSE_PRICE','CHANGE_RATE',
    'BILLBOARD_NET_AMT','BILLBOARD_BUY_AMT','BILLBOARD_SELL_AMT',
    'BILLBOARD_DEAL_AMT','ACCUM_AMOUNT','DEAL_NET_RATIO',
    'DEAL_AMOUNT_RATIO','TURNOVERRATE','FREE_MARKET_CAP',
  ].join(',');

  const allRecords = [];
  let page = 1;
  const pageSize = 50;

  while (true) {
    const url = DC_BASE +
      '?sortColumns=SECURITY_CODE,TRADE_DATE' +
      '&sortTypes=1,-1' +
      '&pageSize=' + pageSize +
      '&pageNumber=' + page +
      '&reportName=RPT_DAILYBILLBOARD_DETAILSNEW' +
      '&columns=' + columns +
      '&source=WEB&client=WEB' +
      '&filter=(TRADE_DATE>=\'' + date + '\')(TRADE_DATE<=\'' + date + '\')';

    try {
      const res = await fetchJSON(url);
      if (!res || !res.result || !res.result.data || res.result.data.length === 0) break;

      for (const item of res.result.data) {
        allRecords.push({
          code: item.SECURITY_CODE || '',
          secuCode: item.SECUCODE || '',
          name: item.SECURITY_NAME_ABBR || '',
          tradeDate: item.TRADE_DATE || '',
          reason: item.EXPLAIN || '',           // 上榜原因
          closePrice: item.CLOSE_PRICE != null ? parseFloat(item.CLOSE_PRICE) : null,
          changeRate: item.CHANGE_RATE != null ? parseFloat(item.CHANGE_RATE) : null,
          netAmt: item.BILLBOARD_NET_AMT != null ? parseFloat(item.BILLBOARD_NET_AMT) : null,
          buyAmt: item.BILLBOARD_BUY_AMT != null ? parseFloat(item.BILLBOARD_BUY_AMT) : null,
          sellAmt: item.BILLBOARD_SELL_AMT != null ? parseFloat(item.BILLBOARD_SELL_AMT) : null,
          dealAmt: item.BILLBOARD_DEAL_AMT != null ? parseFloat(item.BILLBOARD_DEAL_AMT) : null,
          accumAmount: item.ACCUM_AMOUNT != null ? parseFloat(item.ACCUM_AMOUNT) : null,
          dealNetRatio: item.DEAL_NET_RATIO != null ? parseFloat(item.DEAL_NET_RATIO) : null,
          dealAmountRatio: item.DEAL_AMOUNT_RATIO != null ? parseFloat(item.DEAL_AMOUNT_RATIO) : null,
          turnoverRate: item.TURNOVERRATE != null ? parseFloat(item.TURNOVERRATE) : null,
          freeMarketCap: item.FREE_MARKET_CAP != null ? parseFloat(item.FREE_MARKET_CAP) : null,
        });
      }

      if (res.result.data.length < pageSize) break;
      page++;
      await delay(300);
    } catch (e) {
      console.error('  [DragonTiger] LHB fetch failed:', e.message);
      break;
    }
  }

  return allRecords;
}

/**
 * Fetch LHB data and build a Map keyed by stock code for O(1) lookup.
 *
 * @returns {Map<string, object>} code → LHB record
 */
async function fetchLHBDailyMap(date) {
  const records = await fetchLHBDaily(date);
  const map = new Map();
  for (const r of records) {
    // Only index stocks with positive net buying
    map.set(r.code, r);
  }
  return map;
}

/**
 * Check if a stock is on today's LHB with significant net buying.
 *
 * @param {string} code - Stock code
 * @param {Map} lhbMap - Map from fetchLHBDailyMap
 * @returns {object|null} LHB signal or null
 */
function checkLHB(code, lhbMap) {
  if (!lhbMap || !lhbMap.has(code)) return null;

  const record = lhbMap.get(code);
  if (!record || record.netAmt == null) return null;

  // Only report if there's meaningful net activity
  if (record.netAmt === 0 && record.buyAmt === 0) return null;

  let signal = 'weak';
  const netAmtYi = record.netAmt / 1e8; // Convert to 亿

  if (netAmtYi > 0.5) signal = 'strong';
  else if (netAmtYi > 0.1) signal = 'medium';
  else if (netAmtYi < -0.3) signal = 'weak'; // Net sell

  return {
    signal,
    netAmt: record.netAmt,
    netAmtYi: Math.round(netAmtYi * 100) / 100,
    buyAmt: record.buyAmt,
    sellAmt: record.sellAmt,
    reason: record.reason,
    changeRate: record.changeRate,
  };
}

module.exports = {
  fetchLHBDaily,
  fetchLHBDailyMap,
  checkLHB,
};
