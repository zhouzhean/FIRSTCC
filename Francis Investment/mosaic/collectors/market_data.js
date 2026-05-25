/**
 * market_data.js — A股数据采集器 (三数据源)
 *
 *   1. Tencent API (qt.gtimg.cn) — 主力，提供 PE/PB + 实时行情
 *   2. Sina API (hq.sinajs.cn) — 备选，稳定但无 PE
 *   3. Eastmoney API (push2.eastmoney.com) — 个股详情/K线/指数
 *
 * 所有函数返回 Promise，数据为纯 JSON 对象。零外部依赖。
 */
const http = require('http');
const https = require('https');

// ---- Helpers ----

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'Mosaic/2.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = data.replace(/^[^(]*\(/, '').replace(/\);?\s*$/, '');
          resolve(JSON.parse(json));
        } catch (e) {
          reject(new Error('Parse error: ' + e.message + ' — ' + data.slice(0, 200)));
        }
      });
    }).on('error', reject);
  });
}

function fetchRaw(url, referer) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': referer || 'https://finance.sina.com.cn',
      }
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const decoder = new TextDecoder('gbk');
        resolve(decoder.decode(buf));
      });
    }).on('error', reject);
  });
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---- Stock Code Generator ----

/**
 * Generate all A-share stock codes.
 * Covers SH main, SH STAR, SZ main, SZ SME, SZ ChiNext.
 */
function generateAllCodes() {
  const codes = [];

  // Shanghai main board: 600000-605999
  for (let i = 600000; i <= 605999; i++) codes.push(String(i));
  // Shanghai STAR: 688000-689999
  for (let i = 688000; i <= 689999; i++) codes.push(String(i));
  // Shenzhen main board: 000001-004999
  for (let i = 1; i <= 4999; i++) codes.push(String(i).padStart(6, '0'));
  // Shenzhen ChiNext: 300000-301999
  for (let i = 300000; i <= 301999; i++) codes.push(String(i));

  return codes;
}

/**
 * Map a stock code to Tencent API prefix.
 */
function tencentPrefix(code) {
  if (code.startsWith('6') || code.startsWith('68')) return 'sh' + code;
  if (code.startsWith('0') || code.startsWith('3')) return 'sz' + code;
  return 'sz' + code;
}

// ---- Tencent API (primary data source, provides PE) ----

const TENCENT_BASE = 'http://qt.gtimg.cn/q=';

/**
 * Fetch all A-share stocks via Tencent API.
 * Provides PE, PB, turnoverRate in addition to real-time quotes.
 */
async function fetchAllStocksTencent() {
  const allCodes = generateAllCodes();
  const BATCH_SIZE = 60; // Tencent URL length is generous
  const allStocks = [];

  for (let i = 0; i < allCodes.length; i += BATCH_SIZE) {
    const batch = allCodes.slice(i, i + BATCH_SIZE);
    const symbols = batch.map(tencentPrefix).join(',');
    const url = TENCENT_BASE + symbols;

    try {
      const text = await fetchRaw(url, 'https://gu.qq.com/');
      const stocks = parseTencentResponse(text);
      for (const s of stocks) {
        if (s.price > 0) allStocks.push(s);
      }
    } catch (e) {
      // Batch failed, continue with next
    }

    if (i + BATCH_SIZE < allCodes.length) {
      await delay(40);
    }
  }

  return allStocks;
}

/**
 * Parse Tencent API batch response.
 * Format: v_sh600000="1~name~code~price~prevClose~...";
 * Fields (~ delimited, 0-indexed):
 *   1=name 3=price 4=prevClose 5=open 6=volume(手)
 *   31=change 32=change% 33=high 34=low 37=turnover(万元)
 *   38=turnoverRate% 39=PE 43=amplitude% 44=totalCap(亿) 45=circCap(亿) 46=PB
 */
function parseTencentResponse(text) {
  const stocks = [];
  const re = /v_(s[hz]\d+)\s*=\s*"([^"]*)"/g;
  let match;

  while ((match = re.exec(text)) !== null) {
    const symbol = match[1];
    const fields = match[2].split('~');

    if (fields.length < 40) continue;

    const code = symbol.slice(2);
    const name = fields[1] || '';
    const price = parseFloat(fields[3]) || null;
    const prevClose = parseFloat(fields[4]) || null;
    const open = parseFloat(fields[5]) || null;
    const volumeLots = parseFloat(fields[6]) || 0;
    const changePercent = parseFloat(fields[32]) || null;
    const high = parseFloat(fields[33]) || null;
    const low = parseFloat(fields[34]) || null;
    const turnoverWan = parseFloat(fields[37]) || 0;  // 万元
    const turnoverRate = parseFloat(fields[38]) || null;
    const pe = (parseFloat(fields[39]) > 0) ? parseFloat(fields[39]) : null;
    const amplitude = parseFloat(fields[43]) || null;
    const totalCapYi = parseFloat(fields[44]) || 0;   // 亿元
    const circCapYi = parseFloat(fields[45]) || 0;
    const pb = parseFloat(fields[46]) || null;

    if (!price) continue;

    stocks.push({
      code: code,
      name: name,
      price: price,
      changePercent: changePercent,
      change: parseFloat(fields[31]) || null,
      open: open,
      high: high,
      low: low,
      prevClose: prevClose,
      volume: volumeLots * 100,              // 手 → 股
      turnover: turnoverWan * 10000,         // 万元 → 元
      turnoverRate: turnoverRate,
      amplitude: amplitude,
      pe: pe,
      peTTM: pe,                             // 腾讯 field 39 是动态 PE
      pb: pb,
      totalCap: totalCapYi * 1e8,            // 亿 → 元
      circCap: circCapYi * 1e8,
      volumeRatio: null,                     // 腾讯不提供量比
      isST: name.includes('ST') || name.includes('*ST'),
      market: code.startsWith('6') ? 'SH' : 'SZ',
    });
  }

  return stocks;
}

// ---- Sina API (primary data source) ----

const SINA_BASE = 'http://hq.sinajs.cn/list=';

/**
 * Fetch all A-share stocks via Sina API.
 * Generates all codes, batches queries, parses responses.
 */
async function fetchAllStocksSina() {
  const allCodes = generateAllCodes();
  const BATCH_SIZE = 80; // safe URL length
  const allStocks = [];
  let totalBatches = Math.ceil(allCodes.length / BATCH_SIZE);

  for (let i = 0; i < allCodes.length; i += BATCH_SIZE) {
    const batch = allCodes.slice(i, i + BATCH_SIZE);
    const symbols = batch.map(sinaPrefix).join(',');
    const url = SINA_BASE + symbols;

    try {
      const text = await fetchRaw(url);
      const stocks = parseSinaResponse(text);
      for (const s of stocks) {
        if (s.price > 0) allStocks.push(s);
      }
    } catch (e) {
      // Batch failed, continue with next
    }

    // Progress: small delay between batches
    if (i + BATCH_SIZE < allCodes.length) {
      await delay(30);
    }
  }

  return allStocks;
}

/**
 * Parse Sina API batch response.
 * Format: var hq_str_sh600000="name,open,prevClose,price,high,low,...";
 */
function parseSinaResponse(text) {
  const stocks = [];
  const re = /var hq_str_(s[hz]\d+)\s*=\s*"([^"]*)"/g;
  let match;

  while ((match = re.exec(text)) !== null) {
    const symbol = match[1];      // e.g. sh600000
    const data = match[2];        // CSV data
    const fields = data.split(',');

    if (fields.length < 10) continue;

    const code = symbol.slice(2); // strip sh/sz prefix

    stocks.push({
      code: code,
      name: fields[0] || '',
      open: parseFloat(fields[1]) || null,
      prevClose: parseFloat(fields[2]) || null,
      price: parseFloat(fields[3]) || null,
      high: parseFloat(fields[4]) || null,
      low: parseFloat(fields[5]) || null,
      volume: parseFloat(fields[8]) || null,
      turnover: parseFloat(fields[9]) || null,
      // Sina doesn't provide these, set defaults
      changePercent: fields[2] > 0 && fields[3] > 0
        ? parseFloat(((parseFloat(fields[3]) - parseFloat(fields[2])) / parseFloat(fields[2]) * 100).toFixed(2))
        : null,
      pe: null,
      pb: null,
      peTTM: null,
      turnoverRate: null,
      amplitude: null,
      volumeRatio: null,
      totalCap: null,
      circCap: null,
      isST: fields[0].includes('ST') || fields[0].includes('*ST'),
      market: code.startsWith('6') ? 'SH' : 'SZ',
    });
  }

  return stocks;
}

// ---- Eastmoney API (fallback / detail data) ----

const EM_PUSH2 = 'https://push2.eastmoney.com/api/qt';

/**
 * Try fetching all stocks from Eastmoney push2 API.
 * Falls back to Sina if unavailable.
 */
async function fetchAllStocksEastmoney() {
  const FIELDS = [
    'f2','f3','f4','f5','f6','f7','f8','f9','f10',
    'f12','f14','f15','f16','f17','f18','f20','f21','f23',
    'f115','f124','f152',
  ].join(',');

  const FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:13,m:1+t:23';
  const EM_CLIST = EM_PUSH2 + '/clist/get';
  const allStocks = [];
  let page = 1;
  const pageSize = 500;

  while (true) {
    const url = EM_CLIST +
      '?pn=' + page +
      '&pz=' + pageSize +
      '&po=0&np=1' +
      '&ut=bd1d9ddb04089700cf9c27f6f7426281' +
      '&fltt=2&invt=2&fid=f12' +
      '&fs=' + encodeURIComponent(FS) +
      '&fields=' + FIELDS;

    try {
      const res = await fetchJSON(url);
      if (!res || !res.data || !res.data.diff || res.data.diff.length === 0) break;

      for (const item of res.data.diff) {
        allStocks.push(normalizeStockEM(item));
      }

      if (res.data.diff.length < pageSize) break;
      page++;
      await delay(200);
    } catch (e) {
      throw e; // Let caller handle fallback
    }
  }

  return allStocks;
}

function normalizeStockEM(item) {
  const code = String(item.f12 || '').padStart(6, '0');
  return {
    code: code,
    name: item.f14 || '',
    price: item.f2 != null ? parseFloat(item.f2) : null,
    changePercent: item.f3 != null ? parseFloat(item.f3) : null,
    change: item.f4 != null ? parseFloat(item.f4) : null,
    volume: item.f5 != null ? parseFloat(item.f5) : null,
    turnover: item.f6 != null ? parseFloat(item.f6) : null,
    amplitude: item.f7 != null ? parseFloat(item.f7) : null,
    turnoverRate: item.f8 != null ? parseFloat(item.f8) : null,
    pe: (item.f9 != null && parseFloat(item.f9) > 0) ? parseFloat(item.f9) : null,
    volumeRatio: item.f10 != null ? parseFloat(item.f10) : null,
    high: item.f15 != null ? parseFloat(item.f15) : null,
    low: item.f16 != null ? parseFloat(item.f16) : null,
    open: item.f17 != null ? parseFloat(item.f17) : null,
    prevClose: item.f18 != null ? parseFloat(item.f18) : null,
    totalCap: item.f20 != null ? parseFloat(item.f20) : null,
    circCap: item.f21 != null ? parseFloat(item.f21) : null,
    pb: item.f23 != null ? parseFloat(item.f23) : null,
    peTTM: (item.f115 != null && parseFloat(item.f115) > 0) ? parseFloat(item.f115) : null,
    isST: item.f152 === 1,
    market: code.startsWith('6') ? 'SH' : 'SZ',
  };
}

/**
 * Fetch major market indices.
 */
async function fetchIndices() {
  const indices = [];
  const codes = ['1.000001', '0.399001', '0.399006', '1.000688'];
  const names = {
    '1.000001': '上证指数', '0.399001': '深证成指',
    '0.399006': '创业板指', '1.000688': '科创50',
  };
  const FIELDS = 'f2,f3,f4,f5,f6,f15,f16,f17,f18,f124';

  for (const code of codes) {
    const idxUrl = EM_PUSH2 + '/stock/get' +
      '?secid=' + code +
      '&ut=bd1d9ddb04089700cf9c27f6f7426281' +
      '&fields=' + FIELDS;
    try {
      const res = await fetchJSON(idxUrl);
      if (res && res.data) {
        indices.push({
          code: code.split('.')[1],
          name: names[code] || code,
          price: res.data.f2 || null,
          changePercent: res.data.f3 || null,
          change: res.data.f4 || null,
          volume: res.data.f5 || null,
          turnover: res.data.f6 || null,
          high: res.data.f15 || null,
          low: res.data.f16 || null,
          open: res.data.f17 || null,
          prevClose: res.data.f18 || null,
        });
      }
    } catch (e) { /* skip failed index */ }
    await delay(100);
  }

  // If Eastmoney failed, try Tencent for indices
  if (indices.length === 0) {
    return fetchIndicesTencent();
  }

  return indices;
}

/**
 * Fetch indices from Tencent API.
 */
async function fetchIndicesTencent() {
  const tencentMap = {
    'sh000001': '上证指数', 'sz399001': '深证成指',
    'sz399006': '创业板指', 'sh000688': '科创50',
  };
  const symbols = Object.keys(tencentMap).join(',');
  const url = TENCENT_BASE + symbols;

  try {
    const text = await fetchRaw(url, 'https://gu.qq.com/');
    const indices = [];
    const re = /v_(s[hz]\d+)\s*=\s*"([^"]*)"/g;
    let match;

    while ((match = re.exec(text)) !== null) {
      const symbol = match[1];
      const fields = match[2].split('~');
      if (fields.length < 35) continue;
      indices.push({
        code: symbol,
        name: tencentMap[symbol] || symbol,
        price: parseFloat(fields[3]) || null,
        changePercent: parseFloat(fields[32]) || null,
        change: parseFloat(fields[31]) || null,
        volume: parseFloat(fields[6]) || null,
        turnover: (parseFloat(fields[37]) || 0) * 10000,
        high: parseFloat(fields[33]) || null,
        low: parseFloat(fields[34]) || null,
        open: parseFloat(fields[5]) || null,
        prevClose: parseFloat(fields[4]) || null,
      });
    }
    return indices;
  } catch (e) {
    return [];
  }
}

/**
 * Fetch indices from Sina API as fallback.
 */
async function fetchIndicesSina() {
  const sinaMap = {
    's_sh000001': '上证指数', 's_sz399001': '深证成指',
    's_sz399006': '创业板指', 's_sh000688': '科创50',
  };
  const symbols = Object.keys(sinaMap).join(',');
  const url = SINA_BASE + symbols;

  try {
    const text = await fetchRaw(url);
    const indices = [];
    const re = /var hq_str_(s_\w+)\s*=\s*"([^"]*)"/g;
    let match;

    while ((match = re.exec(text)) !== null) {
      const symbol = match[1];
      const fields = match[2].split(',');
      if (fields.length < 4) continue;
      indices.push({
        code: symbol,
        name: sinaMap[symbol] || symbol,
        price: parseFloat(fields[3]) || null,
        changePercent: parseFloat(fields[1]) > 0
          ? parseFloat(((parseFloat(fields[3]) - parseFloat(fields[1])) / parseFloat(fields[1]) * 100).toFixed(2))
          : null,
        change: null,
        volume: parseFloat(fields[8]) || null,
        turnover: parseFloat(fields[9]) || null,
        high: parseFloat(fields[4]) || null,
        low: parseFloat(fields[5]) || null,
        open: parseFloat(fields[1]) || null,
        prevClose: parseFloat(fields[2]) || null,
      });
    }
    return indices;
  } catch (e) {
    return [];
  }
}

/**
 * Fetch K-line data for a single stock.
 */
async function fetchKline(code, days = 30) {
  const market = code.startsWith('6') ? '1' : '0';
  const secid = market + '.' + code;

  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get' +
    '?secid=' + secid +
    '&klt=101&fqt=1&end=20500101&lmt=' + days +
    '&ut=bd1d9ddb04089700cf9c27f6f7426281' +
    '&fields=f2,f3,f4,f5,f6,f15,f16,f17,f18';

  try {
    const res = await fetchJSON(url);
    if (!res || !res.data || !res.data.klines) return [];

    return res.data.klines.map(line => {
      const parts = line.split(',');
      return {
        date: parts[0],
        open: parseFloat(parts[1]),
        close: parseFloat(parts[2]),
        high: parseFloat(parts[3]),
        low: parseFloat(parts[4]),
        volume: parseFloat(parts[5]),
        turnover: parseFloat(parts[6]),
      };
    });
  } catch (e) {
    return [];
  }
}

/**
 * Fetch detailed financial data for a single stock.
 */
async function fetchStockDetail(code) {
  const market = code.startsWith('6') ? '1' : '0';
  const secid = market + '.' + code;

  const FIELDS = [
    'f37','f38','f39','f40','f41','f43','f45','f46',
    'f57','f58','f100','f124',
  ].join(',');

  const url = EM_PUSH2 + '/stock/get' +
    '?secid=' + secid +
    '&ut=bd1d9ddb04089700cf9c27f6f7426281' +
    '&fields=' + FIELDS;

  try {
    const res = await fetchJSON(url);
    if (!res || !res.data) return null;
    const d = res.data;
    return {
      roe: d.f37 != null ? parseFloat(d.f37) : null,
      npGrowth: d.f38 != null ? parseFloat(d.f38) : null,
      netProfit: d.f39 != null ? parseFloat(d.f39) : null,
      revenue: d.f40 != null ? parseFloat(d.f40) : null,
      revenueGrowth: d.f41 != null ? parseFloat(d.f41) : null,
      debtRatio: d.f43 != null ? parseFloat(d.f43) : null,
      npm: d.f45 != null ? parseFloat(d.f45) : null,
      ocfPerShare: d.f46 != null ? parseFloat(d.f46) : null,
      dividendYield: d.f57 != null ? parseFloat(d.f57) : null,
      industry: d.f58 || null,
      sector: d.f100 || null,
    };
  } catch (e) {
    return null;
  }
}

// ---- Primary fetchAllStocks (with fallback) ----

/**
 * Fetch all A-share stocks.
 * Tries Tencent (has PE) first, then Sina, then Eastmoney.
 */
async function fetchAllStocks() {
  // 1. Tencent first (provides PE)
  try {
    const stocks = await fetchAllStocksTencent();
    if (stocks && stocks.length > 500) return stocks;
  } catch (e) {
    // Tencent failed, continue
  }

  // 2. Sina fallback (no PE but stable)
  return fetchAllStocksSina();
}

// ---- Screen ----

/**
 * Screen stocks: price < maxPrice, turnover > minTurnover, PE < maxPE,
 * exclude ST, exclude 300xxx.
 */
function screenStocks(allStocks, options = {}) {
  const {
    maxPrice = 20,
    minTurnover = 1e8,
    maxPE = 40,           // PE ≤ 40 (热门行业可接受), null=不筛选
    excludeST = true,
    exclude300 = true,
    exclude688 = false,
  } = options;

  return allStocks.filter(s => {
    if (!s.price || s.price <= 0) return false;
    if (s.price > maxPrice) return false;
    if (!s.turnover || s.turnover < minTurnover) return false;
    // PE filter: skip stocks with PE > maxPE (亏损股pe=null, 保留)
    if (maxPE != null && s.pe != null && s.pe > maxPE) return false;
    if (excludeST && s.isST) return false;
    if (exclude300 && s.code.startsWith('300')) return false;
    if (exclude688 && s.code.startsWith('688')) return false;
    return true;
  });
}

// ---- Exports ----

module.exports = {
  fetchAllStocks,
  fetchIndices,
  fetchKline,
  fetchStockDetail,
  screenStocks,
};
