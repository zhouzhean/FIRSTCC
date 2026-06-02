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

// ---- Sentiment Scoring (财经情感分析词典) ----

const SENTIMENT_LEXICON = {
  // 强正面 (+3): 重大政策利好、业绩超预期、市场突破
  strongPositive: [
    '重大利好', '超预期', '历史新高', '突破', '大幅增长', '政策支持', '大力推动',
    '明确支持', '获批', '放行', '加快审批', '重点支持', '重磅利好', '全面放开',
    '强势涨停', '持续走强', '量价齐升',
  ],
  // 中正面 (+2): 利好信息、改善趋势
  moderatePositive: [
    '利好', '增长', '上涨', '向好', '回升', '改善', '扩张', '新订单', '回暖',
    '反弹', '降息', '降准', '刺激', '补贴', '减税', '净流入', '加仓', '看好',
    '增持', '买入评级', '上调评级', '盈利改善', '行业景气',
  ],
  // 弱正面 (+1): 企稳信号、平稳运行
  mildPositive: [
    '稳定', '企稳', '平稳', '修复', '收窄', '增速', '营收增长', '净利增长',
    '分红', '回购', '签约', '中标', '新项目', '新产能', '技术突破',
  ],
  // 弱负面 (-1): 增速放缓、轻微压力
  mildNegative: [
    '放缓', '下降', '下跌', '回落', '承压', '亏损', '减持', '净流出', '缩量',
    '调整', '震荡', '观望', '谨慎',
  ],
  // 中负面 (-2): 监管压力、明确负面
  moderateNegative: [
    '监管', '调查', '处罚', '违规', '风险提示', '减持计划', '业绩预告亏损',
    '退市风险', '立案', '问询', '警示函', '暂停上市', '债务违约', '爆仓',
    '评级下调', '看空', '做空',
  ],
  // 强负面 (-3): 危机、系统性风险
  strongNegative: [
    '崩盘', '暴跌', '危机', '爆雷', '违约', '破产', '退市', '大规模减持',
    '制裁', '贸易战', '脱钩', '黑天鹅', '恐慌', '踩踏', '强制平仓',
    '跌停', '停牌核查',
  ],
};

/**
 * 计算金融新闻情感得分。
 * @param {string} text - 标题+摘要组合文本
 * @returns {{ score: number, hits: Array, sentiment: string }}
 */
function computeSentiment(text) {
  let score = 0;
  const hits = [];
  const lower = text.toLowerCase();

  const tiers = [
    { key: 'strongPositive', weight: 3 },
    { key: 'moderatePositive', weight: 2 },
    { key: 'mildPositive', weight: 1 },
    { key: 'mildNegative', weight: -1 },
    { key: 'moderateNegative', weight: -2 },
    { key: 'strongNegative', weight: -3 },
  ];

  for (const tier of tiers) {
    const keywords = SENTIMENT_LEXICON[tier.key] || [];
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) {
        score += tier.weight;
        hits.push({ keyword: kw, weight: tier.weight });
        if (hits.length >= 5) break; // stop after 5 keyword hits per article
      }
    }
    if (hits.length >= 5) break;
  }

  // Clamp to [-5, +5]
  score = Math.max(-5, Math.min(5, score));

  // 5-tier sentiment classification
  let sentiment;
  if (score >= 3) sentiment = 'strongly_positive';
  else if (score >= 1) sentiment = 'positive';
  else if (score <= -3) sentiment = 'strongly_negative';
  else if (score <= -1) sentiment = 'negative';
  else sentiment = 'neutral';

  return { score, hits, sentiment };
}

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
      return data.result.data.map(item => {
        const title = item.title || '';
        const summary = item.intro || item.wapsummary || '';
        return {
          id: 'sina_' + (item.docid || item.oid || Math.random()),
          title: title,
          url: item.url || item.wapurl || '',
          source: item.media_name || '新浪财经',
          sourceIcon: 'sina',
          time: item.ctime ? new Date(parseInt(item.ctime) * 1000).toISOString() : new Date().toISOString(),
          category: categorizeNews(item),
          sentiment: computeSentiment(title + ' ' + summary),
          tags: item.keywords ? item.keywords.split(',').map(k => k.trim()).filter(Boolean) : [],
          summary: summary,
        };
      });
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

module.exports = { fetchDailyNews, CATEGORY_RULES, computeSentiment, SENTIMENT_LEXICON };
