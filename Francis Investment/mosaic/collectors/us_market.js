/**
 * us_market.js — 美股数据采集器 (Sina Finance gb_ API)
 *
 * 监控 26 个核心标的：指数ETF、中概ADR、板块映射ETF、情绪标杆。
 * VIX/DXY/美债/期货暂不可用，后续通过 Finnhub 补充。
 * 纯 Node.js 内置模块，零外部依赖。遵循 market_data.js 采集器模式。
 */
const https = require('https');
const config = require('../config');

const UM = config.US_MARKET;
const SINA_BASE = 'https://hq.sinajs.cn/list=';

// ---- Helpers ----

function fetchRaw(url, referer) {
  return new Promise((resolve, reject) => {
    https.get(url, {
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

/**
 * Convert a US ticker to Sina gb_ symbol.
 */
function sinaUSSymbol(ticker) {
  return 'gb_' + ticker.toLowerCase();
}

// ---- US Market Time Helpers ----

/**
 * Get current US Eastern Time hour/minute/day.
 * EDT (UTC-4) Mar-Nov, EST (UTC-5) Nov-Mar.
 */
function getUSETTime(now) {
  if (!now) now = new Date();
  var yr = now.getUTCFullYear();
  var marStart = new Date(Date.UTC(yr, 2, 8));
  marStart.setUTCDate(8 - marStart.getUTCDay());
  var novStart = new Date(Date.UTC(yr, 10, 1));
  novStart.setUTCDate(1 + (7 - novStart.getUTCDay()) % 7);

  var isDST = now >= marStart && now < novStart;
  var etOffset = isDST ? 4 : 5;

  var utcH = now.getUTCHours();
  var utcM = now.getUTCMinutes();
  var utcDay = now.getUTCDay();

  var etTotal = utcH * 60 + utcM - etOffset * 60;
  if (etTotal < 0) {
    etTotal += 24 * 60;
    utcDay = (utcDay + 6) % 7;
  }

  return {
    hour: Math.floor(etTotal / 60),
    minute: etTotal % 60,
    total: etTotal,
    day: utcDay,
    isDST: isDST,
  };
}

function getUSMarketStatus(now) {
  if (!now) now = new Date();
  var et = getUSETTime(now);

  if (et.day === 0 || et.day === 6) {
    return { status: 'closed', nextSession: null, reason: 'weekend' };
  }

  var t = et.total;
  var preStart = 4 * 60;
  var regularStart = 9 * 60 + 30;
  var regularEnd = 16 * 60;
  var postEnd = 20 * 60;

  if (t < preStart) return { status: 'closed', nextSession: 'pre_market', reason: 'before_pre' };
  if (t < regularStart) return { status: 'pre_market', nextSession: 'regular', reason: 'pre_market' };
  if (t < regularEnd) return { status: 'regular', nextSession: 'post_market', reason: 'regular' };
  if (t < postEnd) return { status: 'post_market', nextSession: 'closed', reason: 'post_market' };
  return { status: 'closed', nextSession: 'pre_market', reason: 'after_post' };
}

function formatUSSessionStatus() {
  var status = getUSMarketStatus();
  var now = new Date();
  var beijingTime = now.toTimeString().slice(0, 5);

  var labels = {
    'closed': '美股休市',
    'pre_market': '美股盘前交易中',
    'regular': '美股正式交易中',
    'post_market': '美股盘后交易中',
  };

  var nextLabels = {
    'pre_market': '盘前',
    'regular': '正式交易',
    'post_market': '盘后',
    'closed': '休市',
  };

  return {
    status: status.status,
    label: labels[status.status] || '未知',
    beijingTime: beijingTime,
    reason: status.reason,
    nextSession: status.nextSession ? nextLabels[status.nextSession] : null,
  };
}

// ---- Core Fetch Functions ----

/**
 * Parse Sina US stock (gb_) response.
 * Fields (~ comma-delimited, within quotes):
 *   [0]=name  [1]=price  [2]=changePercent  [3]=datetime  [4]=change
 *   [30]=prevClose (confirmed for stocks and ETFs)
 */
function parseSinaUSLine(symbol, rawLine) {
  var m = rawLine.match(/"([^"]*)"/);
  if (!m) return null;
  var fields = m[1].split(',');
  if (fields.length < 5) return null;

  var price = parseFloat(fields[1]);
  if (!price || price <= 0) return null;

  var changePercent = parseFloat(fields[2]) || 0;
  var change = parseFloat(fields[4]) || 0;
  var prevClose = fields.length > 30 ? parseFloat(fields[30]) : null;
  if (!prevClose) {
    prevClose = price - change;
  }

  return {
    symbol: symbol.toUpperCase(),
    name: fields[0] || symbol.toUpperCase(),
    price: price,
    change: Math.round(change * 100) / 100,
    changePercent: Math.round(changePercent * 100) / 100,
    prevClose: prevClose,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Fetch quotes for a list of ticker symbols via Sina API.
 * @param {string[]} tickers — e.g. ['SPY', 'QQQ', 'BABA']
 * @returns {Object[]} standardized quote objects
 */
async function fetchUSQuotes(tickers) {
  var results = [];
  // Batch in groups of 20
  for (var i = 0; i < tickers.length; i += 20) {
    var batch = tickers.slice(i, i + 20);
    var symbols = batch.map(sinaUSSymbol).join(',');
    var url = SINA_BASE + symbols;

    try {
      var text = await fetchRaw(url);
      var lines = text.split('\n');
      for (var j = 0; j < lines.length; j++) {
        var line = lines[j].trim();
        if (!line || !line.includes('=')) continue;
        // Extract ticker from "var hq_str_gb_xxx="
        var tickerMatch = line.match(/hq_str_gb_(\w+)=/);
        if (!tickerMatch) continue;
        var ticker = tickerMatch[1];
        var quote = parseSinaUSLine(ticker, line);
        if (quote) results.push(quote);
      }
    } catch (e) {
      // Batch failed, continue
    }

    if (i + 20 < tickers.length) {
      await delay(30);
    }
  }
  return results;
}

/**
 * Fetch all monitored US symbols, categorized.
 */
async function fetchAllUSMonitors() {
  var tickers = []
    .concat(UM.symbols.indices)
    .concat(UM.symbols.macro)
    .concat(UM.symbols.adrs)
    .concat(UM.symbols.sectorETFs)
    .concat(UM.symbols.sentiment);

  var quotes = await fetchUSQuotes(tickers);

  var quoteMap = {};
  for (var i = 0; i < quotes.length; i++) {
    quoteMap[quotes[i].symbol] = quotes[i];
  }

  function pick(syms) {
    var out = [];
    for (var i = 0; i < syms.length; i++) {
      var q = quoteMap[syms[i]];
      if (q) out.push(q);
    }
    return out;
  }

  return {
    time: new Date().toISOString(),
    status: formatUSSessionStatus(),
    indices: pick(UM.symbols.indices),
    macro: pick(UM.symbols.macro),
    adrs: pick(UM.symbols.adrs),
    sectorETFs: pick(UM.symbols.sectorETFs),
    sentiment: pick(UM.symbols.sentiment),
  };
}

/**
 * Fetch a lightweight snapshot for intraday recording.
 */
async function fetchUSSnapshot() {
  var tickers = [].concat(UM.symbols.indices);
  var quotes = await fetchUSQuotes(tickers);

  return {
    time: new Date().toISOString(),
    status: formatUSSessionStatus(),
    quotes: quotes,
  };
}

// ---- Exports ----

module.exports = {
  fetchUSQuotes,
  fetchAllUSMonitors,
  fetchUSSnapshot,
  getUSMarketStatus,
  formatUSSessionStatus,
  getUSETTime,
};
