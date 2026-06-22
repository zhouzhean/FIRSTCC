/**
 * market_quote_service.js — v3.4.9 独立行情刷新服务
 *
 * Lightweight, independent of heavy pipeline. Runs during trading hours,
 * refreshes 4 core indices every ~30s with cascade fallback.
 *
 * Writes: report-engine/data/market_quote_latest.json
 * Fields: quoteAge, sourceChain, fallbackSource, failureReason, lastValidQuoteAt, quotes[]
 *
 * Cascade order: Eastmoney → Tencent → Sina
 */

var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');

var DATA_DIR = path.join(__dirname, '..', 'report-engine', 'data');
var QUOTE_FILE = path.join(DATA_DIR, 'market_quote_latest.json');

var CORE_INDICES = [
  { code: '000001', name: '上证指数', emSecId: '1.000001', tcCode: 'sh000001', sinaCode: 's_sh000001' },
  { code: '399001', name: '深证成指', emSecId: '0.399001', tcCode: 'sz399001', sinaCode: 's_sz399001' },
  { code: '399006', name: '创业板指', emSecId: '0.399006', tcCode: 'sz399006', sinaCode: 's_sz399006' },
  { code: '000688', name: '科创50',   emSecId: '1.000688', tcCode: 'sh000688', sinaCode: 's_sh000688' },
];

var _lastRefreshTime = 0;
var _lastValidQuoteAt = null;
var _isRunning = false;

// ====== HTTP helpers ======

function _fetchJSON(url, timeoutMs) {
  return new Promise(function(resolve, reject) {
    var lib = url.startsWith('https') ? https : http;
    var req = lib.get(url, { headers: { 'User-Agent': 'Mosaic/3.4.9' } }, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          var json = data.replace(/^[^(]*\(/, '').replace(/\);?\s*$/, '');
          resolve(JSON.parse(json));
        } catch (e) {
          reject(new Error('Parse error: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    if (timeoutMs) {
      req.setTimeout(timeoutMs, function() { req.destroy(); reject(new Error('Timeout')); });
    }
  });
}

function _fetchRaw(url) {
  return new Promise(function(resolve, reject) {
    var lib = url.startsWith('https') ? https : http;
    var req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://finance.sina.com.cn' }
    }, function(res) {
      var chunks = [];
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() {
        var buf = Buffer.concat(chunks);
        var decoder = new TextDecoder('gbk');
        resolve(decoder.decode(buf));
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, function() { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ====== Per-source fetchers ======

function _fetchEastmoney(idx) {
  return new Promise(function(resolve) {
    var url = 'https://push2.eastmoney.com/api/qt/stock/get' +
      '?secid=' + idx.emSecId +
      '&ut=bd1d9ddb04089700cf9c27f6f7426281' +
      '&fields=f2,f3,f4,f5,f6,f15,f16,f17,f18,f124';
    _fetchJSON(url, 8000).then(function(res) {
      if (!res || !res.data) return resolve(null);
      var d = res.data;
      var price = (d.f2 != null && d.f2 > 0) ? d.f2 : null;
      var prevClose = (d.f18 != null && d.f18 > 0) ? d.f18 : null;
      if (!price || !prevClose) return resolve(null);
      resolve({
        code: idx.code, name: idx.name,
        price: price, prevClose: prevClose,
        changePercent: (d.f3 != null) ? d.f3 : null,
        change: d.f4 != null ? d.f4 : null,
        volume: d.f5 != null ? d.f5 : null,
        turnover: d.f6 != null ? d.f6 : null,
        high: (d.f15 != null) ? d.f15 : null,
        low: (d.f16 != null) ? d.f16 : null,
        open: d.f17 != null ? d.f17 : null,
      });
    }).catch(function() { resolve(null); });
  });
}

function _fetchTencent(idx) {
  return new Promise(function(resolve) {
    var url = 'http://qt.gtimg.cn/q=' + idx.tcCode;
    _fetchRaw(url).then(function(text) {
      var re = new RegExp('v_' + idx.tcCode + '\\s*=\\s*"([^"]*)"');
      var match = re.exec(text);
      if (!match) return resolve(null);
      var f = match[1].split('~');
      if (f.length < 35) return resolve(null);
      var price = parseFloat(f[3]);
      var prevClose = parseFloat(f[4]);
      if (!price || price <= 0 || !prevClose || prevClose <= 0) return resolve(null);
      resolve({
        code: idx.code, name: idx.name,
        price: price, prevClose: prevClose,
        changePercent: parseFloat(f[32]) || null,
        change: parseFloat(f[31]) || null,
        volume: parseFloat(f[6]) || null,
        turnover: (parseFloat(f[37]) || 0) * 10000,
        high: parseFloat(f[33]) || null,
        low: parseFloat(f[34]) || null,
        open: parseFloat(f[5]) || null,
      });
    }).catch(function() { resolve(null); });
  });
}

function _fetchSina(idx) {
  return new Promise(function(resolve) {
    var url = 'https://hq.sinajs.cn/list=' + idx.sinaCode;
    _fetchRaw(url).then(function(text) {
      var re = new RegExp('var hq_str_' + idx.sinaCode + '\\s*=\\s*"([^"]*)"');
      var match = re.exec(text);
      if (!match) return resolve(null);
      var f = match[1].split(',');
      if (f.length < 4) return resolve(null);
      var price = parseFloat(f[3]);
      var prevClose = parseFloat(f[2]);
      if (!price || price <= 0 || !prevClose || prevClose <= 0) return resolve(null);
      resolve({
        code: idx.code, name: idx.name,
        price: price, prevClose: prevClose,
        changePercent: price > 0 && prevClose > 0
          ? +(((price - prevClose) / prevClose) * 100).toFixed(2)
          : null,
        change: null,
        volume: parseFloat(f[8]) || null,
        turnover: parseFloat(f[9]) || null,
        high: parseFloat(f[4]) || null,
        low: parseFloat(f[5]) || null,
        open: parseFloat(f[1]) || null,
      });
    }).catch(function() { resolve(null); });
  });
}

// ====== Main refresh ======

function _delay(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

/**
 * Fetch all 4 core indices with per-index cascade fallback.
 * Returns { quotes: Array, sourceChain: string, fallbackSource: string|null, failureReason: string|null }
 */
async function refresh() {
  if (_isRunning) return null;
  _isRunning = true;

  try {
    var quotes = [];
    var sourceChain = 'eastmoney';
    var fallbackSource = null;
    var failureReason = null;
    var now = new Date().toISOString();

    for (var i = 0; i < CORE_INDICES.length; i++) {
      var idx = CORE_INDICES[i];
      var q = null;

      // Tier 1: Eastmoney
      q = await _fetchEastmoney(idx);
      if (q) {
        q.source = 'eastmoney';
        q.fetchAt = now;
        quotes.push(q);
        continue;
      }

      // Tier 2: Tencent
      q = await _fetchTencent(idx);
      if (q) {
        q.source = 'tencent';
        q.fetchAt = now;
        quotes.push(q);
        if (!fallbackSource) fallbackSource = 'tencent';
        continue;
      }

      // Tier 3: Sina
      q = await _fetchSina(idx);
      if (q) {
        q.source = 'sina';
        q.fetchAt = now;
        quotes.push(q);
        if (!fallbackSource) fallbackSource = 'sina';
        continue;
      }

      // All failed for this index
      quotes.push({
        code: idx.code, name: idx.name,
        price: null, prevClose: null,
        source: 'none', fetchAt: now,
        unavailable: true,
      });
      failureReason = 'index_' + idx.code + '_all_sources_failed';
    }

    // Determine overall sourceChain
    var anyTenc = quotes.some(function(q) { return q.source === 'tencent'; });
    var anySina = quotes.some(function(q) { return q.source === 'sina'; });
    if (anySina) {
      sourceChain = anyTenc ? 'eastmoney→tencent→sina' : 'eastmoney→sina';
    } else if (anyTenc) {
      sourceChain = 'eastmoney→tencent';
    }

    var validQuotes = quotes.filter(function(q) { return !q.unavailable; });
    if (validQuotes.length > 0) {
      _lastValidQuoteAt = now;
    }

    // Write output
    var output = {
      quoteAge: validQuotes.length > 0 ? Math.round((Date.now() - new Date(_lastValidQuoteAt).getTime()) / 1000) : null,
      sourceChain: sourceChain,
      fallbackSource: fallbackSource,
      failureReason: failureReason,
      lastValidQuoteAt: _lastValidQuoteAt,
      validCount: validQuotes.length,
      totalCount: CORE_INDICES.length,
      quotes: quotes,
    };

    try {
      var dir = path.dirname(QUOTE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(QUOTE_FILE, JSON.stringify(output, null, 2), 'utf8');
    } catch (_) {}

    _lastRefreshTime = Date.now();
    return output;

  } catch (e) {
    try {
      var failOutput = {
        quoteAge: null,
        sourceChain: 'none',
        fallbackSource: null,
        failureReason: 'service_error: ' + (e.message || ''),
        lastValidQuoteAt: _lastValidQuoteAt,
        validCount: 0,
        totalCount: CORE_INDICES.length,
        quotes: [],
      };
      fs.writeFileSync(QUOTE_FILE, JSON.stringify(failOutput, null, 2), 'utf8');
    } catch (_) {}
    return null;
  } finally {
    _isRunning = false;
  }
}

/**
 * Read the latest quote snapshot.
 * @returns {object|null}
 */
function getLatestQuotes() {
  try {
    if (fs.existsSync(QUOTE_FILE)) {
      return JSON.parse(fs.readFileSync(QUOTE_FILE, 'utf8'));
    }
  } catch (_) {}
  return null;
}

/**
 * Get age of last valid quote in seconds. Returns Infinity if no data.
 */
function getQuoteAge() {
  var latest = getLatestQuotes();
  if (latest && latest.lastValidQuoteAt) {
    return Math.round((Date.now() - new Date(latest.lastValidQuoteAt).getTime()) / 1000);
  }
  return Infinity;
}

module.exports = {
  refresh: refresh,
  getLatestQuotes: getLatestQuotes,
  getQuoteAge: getQuoteAge,
  CORE_INDICES: CORE_INDICES,
};
