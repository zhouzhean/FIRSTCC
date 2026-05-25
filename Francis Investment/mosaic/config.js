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
