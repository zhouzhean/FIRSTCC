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
    technical: 0.20,
    hidden: 0.35,
    capital_flow: 0.20,
  },

  // ---- 模拟交易 ----
  SIMFOLIO: {
    initialCapital: 100_000,
    maxPositions: 5,
    maxSinglePositionPct: 0.30,
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

    // Mid-Day Scan 触发时间（2次/天，轻量扫描）
    midDayScanTimes: [
      { hour: 10, minute: 30 },
      { hour: 14, minute: 0 },
    ],

    // 持仓监控间隔（活跃时段每N分钟查一次持仓价格+风控）
    positionMonitorIntervalMin: 5,

    // 超时设置（毫秒）
    fullPipelineTimeoutMs: 600_000,   // Full Pipeline 10分钟超时
    midDayScanTimeoutMs: 300_000,     // Mid-Day Scan 5分钟超时
    positionMonitorTimeoutMs: 30_000, // 持仓检查 30秒超时

    // Mid-Day Scan 参数
    midScanTopCount: 200,   // 按成交额取前200只
    midScanDeepAnalyze: 15, // 深析前15只

    // 移动止盈
    trailingStop: {
      enabled: true,
      activationPct: 3, // 盈利超3%才激活
      tiers: [
        { profitPct: 5, trailOffset: 3 },   // +5% → 回撤3%止盈
        { profitPct: 10, trailOffset: 5 },  // +10% → 回撤5%止盈
        { profitPct: 20, trailOffset: 10 }, // +20% → 回撤10%止盈
      ],
    },

    // Tick 间隔（毫秒）
    activeTickMs: 30_000,   // 活跃时段每30秒tick一次
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
};
