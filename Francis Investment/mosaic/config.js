/**
 * Mosaic 量化引擎配置 (Node.js)
 */
const path = require('path');

const BASE_DIR = path.join(__dirname, '..');
const REPORT_ENGINE_DIR = path.join(BASE_DIR, 'report-engine');
const DATA_DIR = path.join(REPORT_ENGINE_DIR, 'data');

module.exports = {
  BASE_DIR,
  REPORT_ENGINE_DIR,
  DATA_DIR,

  // ---- 筛选条件 ----
  FILTER: {
    maxPrice: 20.00,
    minTurnover: 100_000_000,  // 1亿
    maxPE: 40,                 // PE ≤ 40，亏损股(null)保留
    excludeST: true,
    exclude300: true,
    exclude688: false,
  },

  // ---- 因子权重 ----
  FACTOR_WEIGHTS: {
    fundamental: 0.25,
    technical: 0.15,
    hidden: 0.20,
    capital_flow: 0.25,
    event: 0.15,
  },

  // ---- 买入阈值（百分位制） ----
  BUY_THRESHOLD: {
    percentileTop: 0.15,       // top 15% = 普通买入（收紧）
    percentileStrong: 0.05,    // top 5% = 强买入（收紧）
    minAbsoluteScore: 60,      // 绝对质量底线（从50→60）
    minStrongScore: 70,        // 强买入最低绝对分（防止top 5%质量不足）
    northBoundRiskOffset: 5,   // 北向大幅流出时额外提高阈值
  },

  // ---- 模拟交易 ----
  SIMFOLIO: {
    initialCapital: 100_000,
    maxPositions: 5,
    maxSinglePositionPct: 0.30,
    maxSectorExposurePct: 0.40,  // 同一行业总仓位不超过40%
    stopLossPct: -0.08,
    commissionRate: 0.00025,
    stampTaxRate: 0.001,
    transferFeeRate: 0.00001,
  },

  // ---- 全自动调度器 ----
  SCHEDULER: {
    // 市场时段（北京时间 24h）
    preMarketStart: { hour: 9, minute: 0 },
    morningSessionStart: { hour: 9, minute: 30 },
    morningSessionEnd: { hour: 11, minute: 30 },
    afternoonSessionStart: { hour: 13, minute: 0 },
    afternoonSessionEnd: { hour: 15, minute: 0 },
    postMarketEnd: { hour: 16, minute: 0 },

    // Full Pipeline 触发时间（3次/天）
    fullPipelineTimes: [
      { hour: 9, minute: 30 },
      { hour: 11, minute: 0 },
      { hour: 13, minute: 0 },
    ],

    // Mid-Day Scan 触发时间（7次/天，轻量扫描，云端24/7优化）
    midDayScanTimes: [
      { hour: 10, minute: 0 },
      { hour: 10, minute: 30 },
      { hour: 11, minute: 25 },
      { hour: 13, minute: 30 },
      { hour: 14, minute: 0 },
      { hour: 14, minute: 30 },
      { hour: 14, minute: 50 },
    ],

    // 持仓监控间隔（活跃时段每N分钟查一次持仓价格+风控）
    positionMonitorIntervalMin: 3,

    // 超时设置（毫秒）
    fullPipelineTimeoutMs: 600_000,   // Full Pipeline 10分钟超时
    midDayScanTimeoutMs: 300_000,     // Mid-Day Scan 5分钟超时
    positionMonitorTimeoutMs: 30_000, // 持仓检查 30秒超时

    // Mid-Day Scan 参数
    midScanTopCount: 250,   // 按成交额取前250只（云端优化）
    midScanDeepAnalyze: 20, // 深析前20只（云端优化）

    // 移动止盈
    trailingStop: {
      enabled: true,
      activationPct: 3, // 盈利超3%才激活
      tiers: [
        { profitPct: 5, trailOffset: 3 },   // +5% → 回撤3%止盈
        { profitPct: 10, trailOffset: 6 },  // +10% → 回撤6%止盈（放宽防过早下车）
        { profitPct: 20, trailOffset: 12 }, // +20% → 回撤12%止盈（放宽防过早下车）
      ],
    },

    // Tick 间隔（毫秒）
    activeTickMs: 20_000,   // 活跃时段每20秒tick一次（云端优化）
    idleTickMs: 300_000,    // 空闲时段每5分钟tick一次

    // 事件日志上限
    eventLogMaxSize: 200,
  },

  // ---- 跟踪板块 ----
  SECTORS: [
    '机器人/具身智能',
    '创新药/AI医疗',
    '半导体/AI算力',
    '商业航天',
    '固态电池/储能',
    '有色金属/稀土',
    '新型电力基建',
    '军工',
  ],

  // ---- API 配置 ----
  API: {
    rateLimitMs: 200,
    pageSize: 500,
    maxDetailFetches: 30,
  },

  // ---- 新闻采集 ----
  NEWS: {
    sinaLids: [2509, 2519, 2516], // 国内财经, 证券/股市, 宏观
    maxItemsPerSource: 30,
    fetchTimeoutMs: 15000,
  },

  // ---- 量化分析生成 ----
  ANALYSIS: {
    generationTimeoutMs: 30000,
    knowledgeBaseDays: 30,
    similarityThreshold: 0.6,
  },

  // ---- 海外市场监控 ----
  US_MARKET: {
    enabled: true,
    regularOpenEST: { hour: 9, minute: 30 },
    regularCloseEST: { hour: 16, minute: 0 },
    recordIntervalMs: 60000,
    idleRecordIntervalMs: 300000,
    overnightSummaryTime: { hour: 5, minute: 0 },
    symbols: {
      indices: ['SPY', 'QQQ', 'DIA', 'IWM'],
      macro: ['VXX', 'UUP', 'TLT'],
      adrs: ['BABA', 'JD', 'PDD', 'BIDU', 'NIO', 'XPEV', 'LI', 'BILI', 'TME', 'IQ'],
      sectorETFs: ['SMH', 'XBI', 'TAN', 'ARKQ', 'XLE', 'XLF', 'XAR'],
      sentiment: ['NVDA', 'AAPL', 'TSLA', 'MSFT', 'GOOGL'],
    },
    macroMapping: {
      'VXX': { name: 'VIX恐慌指数(代理)', desc: 'iPath标普500 VIX ETF — 数值越高=市场越恐慌' },
      'UUP': { name: '美元指数(代理)', desc: 'PowerShares美元看多ETF — 数值越高=美元越强' },
      'TLT': { name: '美债20年+(代理)', desc: 'iShares 20+年国债ETF — 价格跌=收益率升=紧缩' },
    },
    sectorMapping: {
      'SMH': '半导体/AI算力', 'XBI': '创新药/AI医疗', 'TAN': '固态电池/储能',
      'ARKQ': '机器人/具身智能', 'XLE': '有色金属/稀土', 'XLF': '金融',
      'XAR': '军工/商业航天',
    },
    adrMapping: {
      'BABA': '阿里系/云计算', 'JD': '消费/零售', 'PDD': '消费降级/跨境电商',
      'BIDU': 'AI/自动驾驶', 'NIO': '新能源车', 'XPEV': '新能源车',
      'LI': '新能源车', 'BILI': '游戏/Z世代', 'TME': '娱乐/内容', 'IQ': '娱乐/内容',
    },
  },
};
