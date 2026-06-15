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
    percentileTop: 0.15,       // top 15% = 普通买入
    percentileStrong: 0.05,    // top 5% = 强买入
    minAbsoluteScore: 50,      // 绝对质量底线（新评分标准下55+已是好分）
    minStrongScore: 60,        // 强买入最低绝对分（新评分标准下65+罕见）
    northBoundRiskOffset: 5,   // 北向大幅流出时额外提高阈值
  },

  // ---- 模拟交易 ----
  SIMFOLIO: {
    initialCapital: 100_000,
    maxPositions: 5,
    maxSinglePositionPct: 0.30,
    maxSectorExposurePct: 0.40,  // 同一行业总仓位不超过40%
    stopLossPct: -0.08,
    // Drawdown management — automatic risk reduction
    maxDrawdownTiers: [
      { threshold: -5, action: 'warn', message: '回撤超5%：提示风险，建议减仓' },
      { threshold: -8, action: 'restrict', message: '回撤超8%：限制买入（仅允许卖出+轻仓买入，每日最多1只）' },
      { threshold: -10, action: 'halt', message: '回撤超10%：暂停所有买入，仅允许止损卖出' },
    ],
    // Position pacing — prevent first-day concentration
    maxBuysPerDay: 2,            // 每日最大建仓数
    maxBuysPerDayReduced: 1,     // 已持3只+时每日最大建仓数
    buyCooldownMin: 30,          // 同日内两次买入之间最短间隔（分钟）
    // Dynamic buy threshold — auto-tighten when market weak
    dynamicThreshold: {
      weakTopScore: 65,          // TOP1 < 此分2天以上 → 提高买入门槛
      raisedMinScore: 60,        // 自动提高后的最低绝对分
      checkWindow: 2,             // 连续几天低分后触发
    },
    commissionRate: 0.00025,
    stampTaxRate: 0.001,
    transferFeeRate: 0.00001,
    // 分层仓位管理（Kelly式，按信号强度缩放）
    positionSizing: {
      strongTiers: [               // 强买入：top 5%百分位 + hasStrongSignal
        { minScore: 85, allocation: 0.25 },  // 85+: 25%现金
        { minScore: 75, allocation: 0.20 },  // 75+: 20%现金
        { minScore: 65, allocation: 0.15 },  // 65+: 15%现金
      ],
      normalTiers: [               // 普通买入：top 15%百分位
        { minScore: 65, allocation: 0.12 },  // 65+: 12%现金
        { minScore: 55, allocation: 0.08 },  // 55+: 8%现金
      ],
      signalCountBonus: 0.02,      // 每多1个信号+2% (信号数>2生效)
      riskRegimeMultipliers: {     // 跨市场风险仓位乘数
        panic: 0.3,                // 恐慌：3折仓位
        risk_off: 0.5,             // 避险：5折
        neutral: 0.8,              // 中性：8折
        slightly_bullish: 1.0,     // 温和看涨：全仓
        risk_on: 1.2,              // 风险偏好：1.2倍
      },
    },
  },

  // ---- A股休市日（2026年） ----
  // 仅包含法定节假日，周六日自动排除。如需补充临时休市日可直接追加。
  HOLIDAYS_2026: [
    '2026-01-01',                                              // 元旦
    '2026-05-01', '2026-05-04', '2026-05-05',                  // 劳动节 (5.1-5.5, 含调休)
    '2026-06-19',                                              // 端午节
    '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', // 国庆+中秋 (10.1-10.8)
  ],

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
    batchConcurrency: 5,       // 并发深析股票数（避免单文件阻塞）
    maxDetailFetches: 80,      // 从30提升至80，覆盖~20%候选股
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

  // ---- 周末深度分析 (DEPRECATED in v2.9, use HISTORY_REVIEW instead) ----
  WEEKEND_ANALYSIS: {
    analysisInterval: 15 * 60 * 1000,       // 每15分钟重新分析一轮
    historyPullInterval: 2 * 60 * 60 * 1000, // 每2小时增量拉取历史K线
    initialHistoryYears: 5,                   // 首次拉取5年历史
    similarityTopN: 5,                        // 相似度匹配 top 5
    similarityWindow: 20,                     // 相似度对比窗口（交易日）
    contextValidDays: 3,                      // 周末上下文有效期3天（覆盖到周一）
    sinaBatchDelay: 200,                      // API 请求间隔 ms
    crisisWeights: {                          // 危机预警维度权重
      liquidity: 0.25,
      valuation: 0.20,
      marketBreadth: 0.20,
      northBound: 0.15,
      margin: 0.10,
      volatility: 0.10,
    },
  },

  // ---- 因子信号诊断 ----
  FACTOR_DIAGNOSTICS: {
    silentAlarmDays: 3,          // 连续N天某因子触发为0 → 发出诊断告警
    minExpectedTriggered: 2,     // 期望每天至少N个不同因子有信号
    targetDailyRatio: 0.15,      // 期望至少15%的候选股触发至少1个信号
  },

  // ---- 周末分析验证 (DEPRECATED in v2.9, use HISTORY_REVIEW.deep.verification instead) ----
  WEEKEND_VERIFICATION: {
    maxArchiveWeeks: 52,                     // 保留最多52周归档
    similarityHorizons: [5, 10, 20],         // 验证相似度预测的时间窗口
    crisisCorrelationMinWeeks: 4,            // 危机分排位相关性所需最少周数
    factorHotThreshold: 0.55,                // 因子热门阈值
    factorColdThreshold: 0.40,               // 因子冷门阈值
    verificationSchedule: { hour: 15, minute: 30 }, // 周五收盘后触发验证
  },

  // ---- 统一历史复盘引擎 (v2.9) ----
  HISTORY_REVIEW: {
    daily: {
      enabled: true,
      time: { hour: 16, minute: 30 },         // 每日盘后，等 daily summary + correlation snapshot 生成后
      similarity: {
        lookbackYears: 1,                      // Light: 1 year
        stride: 10,                            // Light: every 10th window
        topN: 3,                               // Light: top 3
        window: 20,
      },
      factorVerification: {
        horizons: [1, 3, 5],                  // T+1, T+3, T+5
        minSamples: 3,
      },
    },
    deep: {
      enabled: true,
      time: { hour: 10, minute: 30 },         // Saturday, 30 min after factor mining
      dayOfWeek: 6,                            // Saturday
      similarity: {
        lookbackYears: 5,                      // Deep: 5 years
        stride: 5,                             // Deep: every 5th window
        topN: 10,                              // Deep: top 10
        window: 20,
      },
      crisisWeights: {
        liquidity: 0.25,
        valuation: 0.20,
        marketBreadth: 0.20,
        northBound: 0.15,
        margin: 0.10,
        volatility: 0.10,
      },
      verification: {
        maxArchiveWeeks: 52,
        similarityHorizons: [5, 10, 20],
        crisisCorrelationMinWeeks: 4,
        factorHotThreshold: 0.55,
        factorColdThreshold: 0.40,
      },
    },
    contextValidDays: 3,
    weekendTicks: {
      enabled: true,                           // 周六下午+周日持续规律发现
      intervalMinutes: 120,                    // 每2小时一个 tick
      angles: [
        'multi_window_similarity',
        'sector_similarity',
        'volume_patterns',
        'extreme_market_scenarios',
        'cross_market_linkage',
        'policy_cycle_match',
        'factor_decay_curves',
        'covariance_structure',
      ],
    },
    sundayDiscovery: {
      enabled: true,
      time: { hour: 9, minute: 0 },           // Sunday 09:00
      similarityWindow: 30,                    // Larger window for discovery
      similarityTopN: 8,
      similarityStride: 3,
    },
    dataDir: 'report-engine/data/simfolio',
    archiveDir: 'report-engine/data/weekend_archive',
    contextFile: 'history_context.json',
  },

  // ---- 预测引擎 ----
  PREDICTION: {
    useExpectedReturnRanking: true,          // true=期望收益排名, false=硬阈值（旧逻辑）
    minExpectedReturn: 0,                    // 最低期望 5 日收益（%），低于此值不买入
    expectedReturnWeights: {                 // 期望收益 6 维权重
      factorCombo: 0.30,                     //   因子组合历史期望收益
      sectorFlow: 0.20,                      //   板块资金流动量
      marketCycle: 0.15,                     //   市场周期偏差
      nbSentiment: 0.15,                     //   北向情绪偏差
      stockSimilarity: 0.10,                 //   个股历史相似度投影
      scorePercentile: 0.10,                 //   综合评分百分位
    },
    dynamicWeights: {                        // 动态权重学习
      enabled: true,                         //   是否启用自动权重学习
      lookbackDays: 20,                      //   训练窗口（交易日）
      minSamples: 30,                        //   最少样本数才更新
      minR2: 0.05,                           //   最低 R² 才采纳
      emaAlpha: 0.3,                         //   EMA 平滑系数
      minWeight: 0.05,                       //   单维度最低权重
      maxWeight: 0.50,                       //   单维度最高权重
    },
  },

  // ---- 24/7 自主学习进化引擎 ----
  // v3.0: Risk budget model — overrides fixed-percentage position sizing
  RISK_BUDGET: {
    useVolatilityAdjustment: true,
    useCorrelationPenalty: true,
    useLiquidityLimit: true,
    useKellySizing: true,
    kellyFraction: 0.5,              // Half-Kelly (conservative)
    dailyMaxLossPctNav: 0.02,       // 2% of NAV daily loss cap
    consecutiveLossCap: 5,          // Block new buys after 5 consecutive losses
    maxPositionVolatility: 0.35,    // Max acceptable annualized vol per position
    correlationThreshold: 0.6,      // Above this correlation, reduce size
    liquidityLimitPct: 0.05,        // Max 5% of daily volume
    minRiskBudgetPerTrade: 0.002,   // Minimum 0.2% of NAV risk per trade
  },

  EVOLUTION: {
    enabled: true,                                   // 总开关
    nightBacktest: {                                 // 夜间历史回测
      enabled: true,
      time: { hour: 2, minute: 0 },                 // 凌晨 2:00
      maxStocks: 200,                                // 单次最多回测股票数
      lookbackDays: 60,                              // 回测窗口（天）
      horizons: [1, 3, 5],                           // 验证周期（T+1/T+3/T+5）
    },
    weightGridSearch: {                              // 权重网格搜索
      enabled: true,
      time: { hour: 3, minute: 0 },                 // 凌晨 3:00
    },
    usAsPredict: {                                   // 美股→A股预测
      enabled: true,
      predictTime: { hour: 5, minute: 30 },          // 凌晨 5:30 生成预测
      verifyTime: { hour: 16, minute: 10 },          // 下午 16:10 验证（16:00 correlation snapshot 写入后）
    },
    selfReflection: {                                // 自我质疑循环
      enabled: true,
      time: { hour: 20, minute: 0 },                // 晚上 20:00
    },
    weekendFactorMining: {                           // 周末因子组合挖掘
      enabled: true,
      dayOfWeek: 6,                                  // 周六
      time: { hour: 10, minute: 0 },
    },
    taskTimeoutMinutes: 30,                          // 单任务超时（分钟）
  },
};
