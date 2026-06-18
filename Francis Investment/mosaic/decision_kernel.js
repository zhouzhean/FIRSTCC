/**
 * Francis Investment · Decision Kernel v3.4.0
 *
 * Unified trading permission engine. Single source of truth for ALL three consumers:
 *   1. Cockpit permissions (buildCockpitData)
 *   2. Think-tank verdict (generateTodaysVerdict)
 *   3. Simfolio gate chain (makeTradingDecisions)
 *
 * Evaluates 5 hard blockers in strict priority order. First match wins.
 * After hard blockers pass, applies soft reducers to determine final verdict.
 *
 * DESIGN: Receives pre-loaded context data from the caller.
 *         All require() calls happen at runtime inside computeDecision(),
 *         avoiding circular dependency issues at module load time.
 */

var decision_kernel = {};

// Module-level cache for cross-call consistency within the same scan
var _lastResult = null;
var _lastResultTime = 0;

/**
 * Priority-ordered hard blocker evaluation.
 *
 * Hard blockers (any ONE of these fires → BLOCK, maxBuysPerDay=0):
 *   1. No market data / no indices / no pipeline data
 *   2. Cross-market circuit breaker (regime = panic | risk_off)
 *   3. Leakage audit critical / NO_SAMPLES / DATA_LEAKAGE_RISK
 *   4. Strategy health masterControl = BLOCK
 *   5. Data quality penalty >= 7
 *
 * Soft reducers (downgrade ALLOW → CAUTIOUS → REDUCE, never BLOCK):
 *   - Leakage MINOR_ISSUES → at least CAUTIOUS, maxBuys=1
 *   - Strategy health REDUCE → at least REDUCE (sell only), maxBuys=0
 *   - Strategy health CAUTIOUS → at least CAUTIOUS, maxBuys=1
 *   - Data quality penalty 4-6 → at least CAUTIOUS
 *   - Drawdown restrict (-8%) → at least CAUTIOUS
 *   - Drawdown warn (-5%) → advisory only
 *
 * @param {Object} context
 * @param {Object} [context.portfolio]       - loaded portfolio from simfolio.loadPortfolio() or null
 * @param {Array}  [context.indices]         - index data array [{code, price, changePercent}] or null
 * @param {Object} [context.macroContext]    - { riskState: { regime, regimeLabel, ... } } or null
 * @param {Array}  [context.pipelineResults] - current scan stock results or null
 * @param {Object} [context.dataQualityReport] - from data_quality.computeConfidencePenalty() or null
 * @param {Object} [context.leakageAudit]    - pre-loaded leakage_audit.json or null
 * @param {Object} [context.strategyHealth]  - from strategy_health.computeStrategyHealth() or null
 * @returns {Object} decision
 */
function computeDecision(context) {
  var ctx = context || {};
  var now = new Date().toISOString();

  var result = {
    canBuy: true,
    finalVerdict: 'ALLOW',
    finalVerdictLabel: '允许开仓',
    maxBuysPerDay: null,
    hardBlockers: [],
    softReducers: [],
    advisorySignals: [],
    sourceTimestamp: now,
    gateStates: {},
  };

  var pf = ctx.portfolio || { positions: [], tradeHistory: [], _stats: {} };
  var indices = ctx.indices || null;
  var macroContext = ctx.macroContext || null;
  var pipelineResults = ctx.pipelineResults || null;

  // ================================================================
  // HARD BLOCKER 1: No market data
  // ================================================================
  var noMarketData = !indices || !Array.isArray(indices) || indices.length === 0;
  var noPipeline = !pipelineResults || !Array.isArray(pipelineResults) || pipelineResults.length === 0;

  if (noMarketData && noPipeline) {
    result.canBuy = false;
    result.finalVerdict = 'BLOCK';
    result.finalVerdictLabel = '无行情数据/禁止开仓';
    result.maxBuysPerDay = 0;
    result.hardBlockers.push({
      gate: 'marketData',
      reason: '无指数行情数据且无管线结果，无法做出交易决策（非交易时段或数据采集异常）',
      severity: 'block',
    });
    result.gateStates = _buildAllGateStates(ctx, result);
    return result;
  }

  // ================================================================
  // HARD BLOCKER 2: Cross-market circuit breaker
  // ================================================================
  var riskState = macroContext && macroContext.riskState ? macroContext.riskState : null;
  var regime = riskState ? riskState.regime : null;

  if (regime === 'panic' || regime === 'risk_off') {
    result.canBuy = false;
    result.finalVerdict = 'BLOCK';
    result.finalVerdictLabel = '跨市场熔断/禁止开仓';
    result.maxBuysPerDay = 0;
    var regimeLabel = regime === 'panic' ? '恐慌' : '避险';
    result.hardBlockers.push({
      gate: 'circuitBreaker',
      reason: '跨市场风险熔断：' + regimeLabel + '状态，禁止所有买入（仅允许卖出）。' +
        (riskState.regimeLabel || '') + ' — 等待宏观风险信号改善',
      severity: 'block',
    });
    result.gateStates = _buildAllGateStates(ctx, result);
    return result;
  }

  // ================================================================
  // HARD BLOCKER 3: Leakage audit
  // ================================================================
  var leakageAudit = ctx.leakageAudit || null;
  var laVerdict = leakageAudit ? (leakageAudit.verdict || 'NO_SAMPLES') : 'NO_SAMPLES';
  var laTotalChecks = leakageAudit ? (leakageAudit.totalChecks || 0) : 0;

  if (laVerdict === 'CRITICAL_DATA_LEAKAGE' || laVerdict === 'DATA_LEAKAGE_RISK') {
    result.canBuy = false;
    result.finalVerdict = 'BLOCK';
    result.finalVerdictLabel = '数据泄漏风险/禁止实盘';
    result.maxBuysPerDay = 0;
    result.hardBlockers.push({
      gate: 'leakageAudit',
      reason: 'Leakage audit: ' + laVerdict + ' — 检测到数据泄漏风险，绝对禁止实盘开仓。需排查数据管线后重新审计',
      severity: 'block',
    });
    result.gateStates = _buildAllGateStates(ctx, result);
    return result;
  }

  if (laVerdict === 'NO_SAMPLES' || laVerdict === 'INSUFFICIENT_DATA' || laTotalChecks === 0) {
    result.canBuy = false;
    result.finalVerdict = 'BLOCK';
    result.finalVerdictLabel = '审计样本不足/禁止开仓';
    result.maxBuysPerDay = 0;
    result.hardBlockers.push({
      gate: 'leakageAudit',
      reason: 'Leakage audit: NO_SAMPLES — 审计样本不足，无法确认无数据泄漏 (' + laTotalChecks + ' 条检查)。需积累足够验证记录后再允许实盘',
      severity: 'block',
    });
    result.gateStates = _buildAllGateStates(ctx, result);
    return result;
  }

  // MINOR_ISSUES is a soft reducer (handled below)
  var leakageMinorIssues = (laVerdict === 'MINOR_ISSUES');
  var leakageClean = (laVerdict === 'CLEAN' && laTotalChecks > 0);

  // ================================================================
  // HARD BLOCKER 4: Strategy health masterControl = BLOCK
  // ================================================================
  var shResult = ctx.strategyHealth || null;
  var shVerdict = 'ALLOW';
  var shConfidence = null;
  var shReasons = [];

  if (shResult && shResult.masterControl) {
    shVerdict = shResult.masterControl.verdict || 'ALLOW';
    shConfidence = shResult.masterControl.confidence;
    shReasons = shResult.masterControl.reasons || [];
  } else if (shResult && shResult.verdict) {
    // Fallback: top-level verdict (pre-masterControl for backward compat)
    shVerdict = shResult.verdict;
    shConfidence = shResult.confidence;
    shReasons = shResult.reasons || [];
  }

  if (shVerdict === 'BLOCK') {
    result.canBuy = false;
    result.finalVerdict = 'BLOCK';
    result.finalVerdictLabel = '策略健康异常/禁止开仓';
    result.maxBuysPerDay = 0;
    var shBlockReason = 'Strategy health: BLOCK — 策略健康严重恶化，强制禁止所有买入。';
    if (shReasons.length > 0) {
      shBlockReason += ' 原因：' + shReasons.slice(0, 3).join('；');
    }
    result.hardBlockers.push({
      gate: 'strategyHealth',
      reason: shBlockReason,
      severity: 'block',
    });
    result.gateStates = _buildAllGateStates(ctx, result);
    return result;
  }

  // ================================================================
  // HARD BLOCKER 5: Data quality severe degradation (penalty >= 7)
  // ================================================================
  var dqReport = ctx.dataQualityReport || null;
  var dqPenalty = dqReport ? (dqReport.penalty || 0) : 0;
  var dqQualityScore = dqReport ? (dqReport.qualityScore != null ? dqReport.qualityScore : Math.round((1 - Math.min(10, dqPenalty) / 10) * 100)) : 100;
  var dqReasons = dqReport ? (dqReport.reasons || []) : [];
  var dqOverallScore = dqReport ? (dqReport.overallScore || 0) : 100;

  if (dqPenalty >= 7) {
    // Hard blocker: data quality is too degraded for safe trading
    result.canBuy = false;
    result.finalVerdict = 'BLOCK';
    result.finalVerdictLabel = '数据质量严重不足/禁止开仓';
    result.maxBuysPerDay = 0;
    result.hardBlockers.push({
      gate: 'dataQuality',
      reason: '数据质量严重降级: qualityScore=' + dqQualityScore + ' (penalty=' + dqPenalty + ')。' +
        (dqReasons.length > 0 ? '原因：' + dqReasons.join('；') : '多个数据源异常或过期') +
        ' — 在此状态下交易风险不可控，强制禁止买入',
      severity: 'block',
    });
    result.gateStates = _buildAllGateStates(ctx, result);
    return result;
  }

  // ================================================================
  // ALL HARD BLOCKERS PASSED — apply soft reducers
  // ================================================================
  var currentVerdictNum = 0; // ALLOW=0, CAUTIOUS=1, REDUCE=2
  var maxBuys = null; // null = no restriction

  // Soft reducer: Leakage MINOR_ISSUES → at least CAUTIOUS, max 1 buy
  if (leakageMinorIssues) {
    currentVerdictNum = Math.max(currentVerdictNum, 1);
    maxBuys = maxBuys === null ? 1 : Math.min(maxBuys, 1);
    result.softReducers.push({
      gate: 'leakageAudit',
      reason: 'Leakage audit: MINOR_ISSUES — 审计发现小问题需人工复核，限制买入数量（最多1只/天）',
    });
  }

  // Soft reducer: Strategy health REDUCE → at least REDUCE (sell only)
  if (shVerdict === 'REDUCE') {
    currentVerdictNum = Math.max(currentVerdictNum, 2);
    maxBuys = 0;
    var shReduceReason = 'Strategy health: REDUCE — 策略健康状况不佳，仅允许卖出，禁止所有买入。';
    if (shReasons.length > 0) {
      shReduceReason += ' 原因：' + shReasons.slice(0, 3).join('；');
    }
    result.softReducers.push({
      gate: 'strategyHealth',
      reason: shReduceReason,
    });
  }

  // Soft reducer: Strategy health CAUTIOUS → at least CAUTIOUS, max 1 buy
  if (shVerdict === 'CAUTIOUS' && currentVerdictNum < 2) {
    currentVerdictNum = Math.max(currentVerdictNum, 1);
    maxBuys = maxBuys === null ? 1 : Math.min(maxBuys, 1);
    var shCautiousReason = 'Strategy health: CAUTIOUS — 策略健康有隐忧，建议减仓观察。';
    if (shReasons.length > 0) {
      shCautiousReason += ' 原因：' + shReasons.slice(0, 3).join('；');
    }
    result.softReducers.push({
      gate: 'strategyHealth',
      reason: shCautiousReason,
    });
  }

  // Soft reducer: Data quality moderate degradation (penalty 4-6) → at least CAUTIOUS
  if (dqPenalty >= 4 && dqPenalty < 7) {
    currentVerdictNum = Math.max(currentVerdictNum, 1);
    result.softReducers.push({
      gate: 'dataQuality',
      reason: '数据质量评分偏低: ' + dqQualityScore + ' (penalty: ' + dqPenalty + ')，数据源存在过期/异常，信号置信度下降',
    });
  }

  // Soft reducer: Drawdown restrict level
  var ddLevel = (pf._drawdownLevel && pf._drawdownLevel.level) || 'normal';
  var ddCurrent = (pf._stats && pf._stats.maxDrawdown != null) ? pf._stats.maxDrawdown : 0;

  if (ddLevel === 'restrict' || ddLevel === 'halt') {
    currentVerdictNum = Math.max(currentVerdictNum, 1);
    maxBuys = maxBuys === null ? 1 : Math.min(maxBuys, 1);
    result.softReducers.push({
      gate: 'drawdown',
      reason: '组合回撤' + (ddLevel === 'halt' ? '熔断' : '限仓') + '(' + ddCurrent.toFixed(1) + '%)，每日最多1只买入',
    });
  }

  // Advisory: Drawdown warn level
  if (ddLevel === 'warn') {
    result.advisorySignals.push({
      signal: 'drawdownWarn',
      value: ddCurrent,
      interpretation: '回撤警告(' + ddCurrent.toFixed(1) + '%)，距限仓线(-8%)还有' + Math.abs(-8 - ddCurrent).toFixed(1) + '%空间',
    });
  }

  // ================================================================
  // Build final verdict from accumulated scores
  // ================================================================
  var verdictMap = ['ALLOW', 'CAUTIOUS', 'REDUCE', 'BLOCK'];
  var verdictLabelMap = {
    'ALLOW': '允许开仓',
    'CAUTIOUS': '谨慎交易/需人工复核',
    'REDUCE': '仅允许卖出/禁止买入',
    'BLOCK': '禁止开仓',
  };

  result.finalVerdict = verdictMap[currentVerdictNum];
  result.finalVerdictLabel = verdictLabelMap[result.finalVerdict] || '未知';
  result.maxBuysPerDay = maxBuys;
  result.canBuy = currentVerdictNum < 2; // REDUCE or BLOCK means cannot buy

  if (currentVerdictNum === 2) {
    // REDUCE: override maxBuys to 0
    result.maxBuysPerDay = 0;
  }

  result.gateStates = _buildAllGateStates(ctx, result);

  // Cache for cross-call consistency
  _lastResult = result;
  _lastResultTime = Date.now();

  return result;
}

/**
 * Build all gate states from context for unified display across all consumers.
 * Mirrors the existing buildGateResults() from simfolio.js but adds kernel-level
 * leakage audit, strategy health, and data quality gates.
 */
function _buildAllGateStates(ctx, decision) {
  var pf = ctx.portfolio || { positions: [], tradeHistory: [], _stats: {} };
  var indices = ctx.indices || null;
  var macroContext = ctx.macroContext || null;
  var leakageAudit = ctx.leakageAudit || null;
  var shResult = ctx.strategyHealth || null;
  var dqReport = ctx.dataQualityReport || null;

  // --- Drawdown ---
  var ddLevel = (pf._drawdownLevel && pf._drawdownLevel.level) || 'normal';
  var ddCurrent = (pf._stats && pf._stats.maxDrawdown != null) ? pf._stats.maxDrawdown : 0;
  var ddStatus = ddLevel === 'halt' ? 'block' : (ddLevel === 'restrict' ? 'restrict' : (ddLevel === 'warn' ? 'warn' : 'pass'));

  // --- Market direction ---
  var shIdx = indices ? indices.find(function(i) { return i.code === '000001' || i.code === 'sh000001'; }) : null;
  var marketBlocked = shIdx && shIdx.changePercent != null && shIdx.changePercent < -0.5;
  var marketStatus = marketBlocked ? 'block' : (shIdx ? 'pass' : 'unknown');

  // --- Circuit breaker ---
  var riskState = macroContext && macroContext.riskState ? macroContext.riskState : null;
  var regime = riskState ? riskState.regime : null;
  var circuitBlocked = regime === 'panic' || regime === 'risk_off';
  var circuitStatus = circuitBlocked ? 'block' : 'pass';
  var regimeLabel = regime === 'panic' ? '恐慌' : (regime === 'risk_off' ? '避险' : (regime === 'neutral' ? '中性' : (regime === 'slightly_bullish' ? '温和看涨' : (regime === 'risk_on' ? '风险偏好' : (regime || '未知')))));

  // --- Leakage audit ---
  var laVerdict = leakageAudit ? (leakageAudit.verdict || 'NO_SAMPLES') : 'NO_SAMPLES';
  var laTotalChecks = leakageAudit ? (leakageAudit.totalChecks || 0) : 0;
  var laStatus = 'pass';
  if (laVerdict === 'CRITICAL_DATA_LEAKAGE' || laVerdict === 'DATA_LEAKAGE_RISK' || laVerdict === 'NO_SAMPLES' || laVerdict === 'INSUFFICIENT_DATA' || laTotalChecks === 0) {
    laStatus = 'block';
  } else if (laVerdict === 'MINOR_ISSUES') {
    laStatus = 'cautious';
  }

  // --- Strategy health ---
  var shVerdict = 'ALLOW';
  var shConfidence = null;
  var shReasons = [];
  if (shResult && shResult.masterControl) {
    shVerdict = shResult.masterControl.verdict || 'ALLOW';
    shConfidence = shResult.masterControl.confidence;
    shReasons = shResult.masterControl.reasons || [];
  } else if (shResult && shResult.verdict) {
    shVerdict = shResult.verdict;
    shConfidence = shResult.confidence;
    shReasons = shResult.reasons || [];
  }
  var shStatus = shVerdict === 'BLOCK' ? 'block' : (shVerdict === 'REDUCE' ? 'reduce' : (shVerdict === 'CAUTIOUS' ? 'cautious' : 'pass'));

  // --- Data quality ---
  var dqPenalty = dqReport ? (dqReport.penalty || 0) : 0;
  var dqQualityScore = dqReport ? (dqReport.qualityScore != null ? dqReport.qualityScore : Math.round((1 - Math.min(10, dqPenalty) / 10) * 100)) : 100;
  var dqReasons = dqReport ? (dqReport.reasons || []) : [];
  var dqOverallScore = dqReport ? (dqReport.overallScore || 0) : 100;
  var dqStatus = dqPenalty >= 7 ? 'block' : (dqPenalty >= 4 ? 'cautious' : (dqPenalty > 0 ? 'warn' : 'pass'));

  return {
    drawdown: {
      status: ddStatus,
      level: ddLevel,
      currentDrawdown: Math.round(ddCurrent * 100) / 100,
      description: ddLevel === 'halt'
        ? '回撤熔断(' + ddCurrent.toFixed(1) + '%)，禁止所有买入'
        : (ddLevel === 'restrict'
          ? '回撤限仓(' + ddCurrent.toFixed(1) + '%)，每日最多1只买入'
          : (ddLevel === 'warn'
            ? '回撤警告(' + ddCurrent.toFixed(1) + '%)'
            : '回撤正常(' + ddCurrent.toFixed(1) + '%)')),
    },
    marketDirection: {
      status: marketStatus,
      shIndex: shIdx ? shIdx.price : null,
      changePercent: (shIdx && shIdx.changePercent != null) ? Math.round(shIdx.changePercent * 100) / 100 : null,
      description: marketBlocked
        ? '上证跌幅' + (shIdx && shIdx.changePercent != null ? shIdx.changePercent.toFixed(2) : '?') + '%超过-0.5%阈值，禁止买入'
        : (shIdx && shIdx.changePercent != null ? '上证' + (shIdx.changePercent >= 0 ? '涨' : '跌') + Math.abs(shIdx.changePercent).toFixed(2) + '%，方向正常' : '无上证指数数据'),
    },
    circuitBreaker: {
      status: circuitStatus,
      riskRegime: regime || 'unknown',
      riskLabel: regimeLabel,
      description: circuitBlocked
        ? '跨市场' + (regime === 'panic' ? '恐慌' : '避险') + '熔断，禁止所有买入'
        : (regime ? '跨市场风险' + regimeLabel + '，未触发熔断' : '无跨市场数据'),
    },
    leakageAudit: {
      status: laStatus,
      verdict: laVerdict,
      totalChecks: laTotalChecks,
      description: laStatus === 'block'
        ? '泄漏审计: ' + laVerdict + '，禁止买入 (' + laTotalChecks + '条检查)'
        : (laStatus === 'cautious'
          ? '泄漏审计: MINOR_ISSUES，限买入 (' + laTotalChecks + '条检查)'
          : '泄漏审计: CLEAN (' + laTotalChecks + '条检查)'),
    },
    strategyHealth: {
      status: shStatus,
      verdict: shVerdict,
      confidence: shConfidence,
      reasons: shReasons,
      description: shStatus === 'block'
        ? '策略健康: BLOCK，禁止买入。' + shReasons.slice(0, 2).join('；')
        : (shStatus === 'reduce'
          ? '策略健康: REDUCE，仅允许卖出。' + shReasons.slice(0, 2).join('；')
          : (shStatus === 'cautious'
            ? '策略健康: CAUTIOUS，谨慎买入。' + shReasons.slice(0, 2).join('；')
            : '策略健康: ALLOW，状态正常')),
    },
    dataQuality: {
      status: dqStatus,
      penalty: dqPenalty,
      qualityScore: dqQualityScore,
      overallScore: dqOverallScore,
      reasons: dqReasons,
      description: dqPenalty > 0
        ? '数据质量惩罚-' + dqPenalty + '分(score:' + dqQualityScore + ')：' + dqReasons.join('；')
        : '数据质量正常，无惩罚',
    },
  };
}

/**
 * Get the last computed kernel result (for cross-consumer consistency within same request cycle).
 * Returns null if no result has been computed or cache is stale (>30s).
 */
function getLastResult() {
  if (_lastResult && (Date.now() - _lastResultTime) < 30000) {
    return _lastResult;
  }
  return null;
}

/**
 * Manually set a cached result (used by callers that want to pre-seed the cache).
 */
function setCachedResult(result) {
  _lastResult = result;
  _lastResultTime = Date.now();
}

decision_kernel.computeDecision = computeDecision;
decision_kernel.getLastResult = getLastResult;
decision_kernel.setCachedResult = setCachedResult;
decision_kernel._buildAllGateStates = _buildAllGateStates;

module.exports = decision_kernel;
