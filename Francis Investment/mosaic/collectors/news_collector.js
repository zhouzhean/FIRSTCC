/**
 * news_collector.js — 财经新闻采集器
 *
 * 数据源：Sina 财经 roll API（免费免认证）
 * 零外部依赖，纯 Node.js http/https。
 */
const http = require('http');
const https = require('https');
const config = require('../config');

// ---- Helpers ----

function fetchJSON(url, referer) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': referer || 'https://finance.sina.com.cn/',
        'Accept': 'application/json',
      },
      timeout: config.NEWS.fetchTimeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          // Handle both JSONP and pure JSON
          let json = data;
          if (json.startsWith('(') || json.includes('callback')) {
            json = json.replace(/^[^(]*\(/, '').replace(/\);?\s*$/, '');
          }
          resolve(JSON.parse(json));
        } catch (e) {
          reject(new Error('News parse error: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('News fetch timeout')); });
  });
}

// ---- Category Keywords ----

const CATEGORY_RULES = [
  { category: 'policy', keywords: ['国务院', '央行', '证监会', '银保监', '发改委', '财政部', '工信部', '政策', '法规', '条例', '通知', '监管', '改革', '政治局', '深改委'] },
  { category: 'sector', keywords: ['板块', '行业', '产业', '供应链', '新能源', '半导体', '芯片', '机器人', '医药', '军工', '航天', '固态电池', '光伏', '锂电', '储能', 'AI', '人工智能', '大模型', '算力', '电网', '稀土', '有色'] },
  { category: 'company', keywords: ['业绩', '年报', '季报', '公告', '减持', '增持', '回购', '上市', 'IPO', '退市', 'ST', '重组', '并购', '分红', '净利', '营收'] },
  { category: 'macro', keywords: ['GDP', 'CPI', 'PMI', '利率', '汇率', '央行', 'MLF', 'LPR', '社融', '人民币', '美元', '美联', '贸易', '关税', '进出口', '通胀', '就业'] },
];

function categorizeNews(item) {
  const title = (item.title || '').toLowerCase();
  const intro = (item.intro || '').toLowerCase();
  const keywords = (item.keywords || '').toLowerCase();
  const combined = title + ' ' + intro + ' ' + keywords;

  for (const rule of CATEGORY_RULES) {
    for (const kw of rule.keywords) {
      if (combined.includes(kw.toLowerCase())) {
        return rule.category;
      }
    }
  }
  return 'sector'; // default
}

// ---- Public Functions ----

/**
 * Fetch news from a single Sina lid (list ID).
 */
async function fetchSinaLid(lid, num) {
  const url = 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=' +
    lid + '&k=&num=' + num + '&page=1&r=' + Math.random();
  try {
    const data = await fetchJSON(url, 'https://finance.sina.com.cn/');
    if (data && data.result && data.result.data) {
      return data.result.data.map(item => ({
        id: 'sina_' + (item.docid || item.oid || Math.random()),
        title: item.title || '',
        url: item.url || item.wapurl || '',
        source: item.media_name || '新浪财经',
        sourceIcon: 'sina',
        time: item.ctime ? new Date(parseInt(item.ctime) * 1000).toISOString() : new Date().toISOString(),
        category: categorizeNews(item),
        tags: item.keywords ? item.keywords.split(',').map(k => k.trim()).filter(Boolean) : [],
        summary: item.intro || item.wapsummary || '',
      }));
    }
    return [];
  } catch (e) {
    return [];
  }
}

/**
 * Fetch daily financial news from multiple Sina lids.
 * @param {number} [days=1] - Days of news (not used, API returns latest)
 * @returns {Object} { items, count, sourceCounts, generatedAt }
 */
async function fetchDailyNews(days) {
  const lids = config.NEWS.sinaLids || [2509, 2519, 2516];
  const numPerSource = config.NEWS.maxItemsPerSource || 30;
  const seen = new Set();
  const allItems = [];

  for (const lid of lids) {
    try {
      const items = await fetchSinaLid(lid, numPerSource);
      for (const item of items) {
        // Deduplicate by title similarity (first 20 chars)
        const dedupKey = item.title.slice(0, 20).toLowerCase();
        if (!seen.has(dedupKey)) {
          seen.add(dedupKey);
          allItems.push(item);
        }
      }
    } catch (e) {
      // Individual lid failure is non-fatal
    }
  }

  // Sort by time, newest first
  allItems.sort((a, b) => new Date(b.time) - new Date(a.time));

  return {
    items: allItems,
    count: allItems.length,
    sourceCounts: { sina: allItems.length },
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { fetchDailyNews, CATEGORY_RULES };
