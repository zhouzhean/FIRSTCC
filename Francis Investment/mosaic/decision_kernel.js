/**
 * Francis Investment · Decision Kernel v3.4.5
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
    // v3.4.1: Active blockers summary for cockpit display
    primaryBlocker: null,
    allActiveBlockers: [],
    displayReasons: [],
  };

  // v3.4.1: finalize() ensures gateStates+cache are written for ALL return paths
  function finalize(res) {
    res.gateStates = _buildAllGateStates(ctx, res);
    // Build allActiveBlockers + displayReasons from gateStates
    var gs = res.gateStates;
    var activeBlocks = [];
    if (gs.circuitBreaker && gs.circuitBreaker.status === 'block') activeBlocks.push({ gate: 'circuitBreaker', status: gs.circuitBreaker.status, label: '跨市场熔断', detail: gs.circuitBreaker.description });
    if (gs.leakageAudit && gs.leakageAudit.status === 'block') activeBlocks.push({ gate: 'leakageAudit', status: 'block', label: '数据泄漏审计', detail: gs.leakageAudit.description });
    if (gs.leakageAudit && gs.leakageAudit.status === 'cautious') activeBlocks.push({ gate: 'leakageAudit', status: 'cautious', label: '泄漏审计(小问题)', detail: gs.leakageAudit.description });
    if (gs.strategyHealth && gs.strategyHealth.status === 'block') activeBlocks.push({ gate: 'strategyHealth', status: 'block', label: '策略健康异常', detail: gs.strategyHealth.description });
    if (gs.strategyHealth && gs.strategyHealth.status === 'reduce') activeBlocks.push({ gate: 'strategyHealth', status: 'reduce', label: '策略健康(仅卖)', detail: gs.strategyHealth.description });
    if (gs.strategyHealth && gs.strategyHealth.status === 'cautious') activeBlocks.push({ gate: 'strategyHealth', status: 'cautious', label: '策略健康(谨慎)', detail: gs.strategyHealth.description });
    if (gs.dataQuality && gs.dataQuality.status === 'block') activeBlocks.push({ gate: 'dataQuality', status: 'block', label: '数据质量严重不足', detail: gs.dataQuality.description });
    if (gs.dataQuality && gs.dataQuality.status === 'cautious') activeBlocks.push({ gate: 'dataQuality', status: 'cautious', label: '数据质量偏低', detail: gs.dataQuality.description });
    if (gs.drawdown && gs.drawdown.status === 'block') activeBlocks.push({ gate: 'drawdown', status: 'block', label: '回撤熔断', detail: gs.drawdown.description });
    if (gs.drawdown && gs.drawdown.status === 'restrict') activeBlocks.push({ gate: 'drawdown', status: 'restrict', label: '回撤限仓', detail: gs.drawdown.description });
    if (gs.marketDirection && gs.marketDirection.status === 'block') activeBlocks.push({ gate: 'marketDirection', status: 'block', label: '市场方向不利', detail: gs.marketDirection.description });
    if (gs.marketDirection && gs.marketDirection.status === 'warn') activeBlocks.push({ gate: 'marketDirection', status: 'warn', label: '市场方向数据不全', detail: gs.marketDirection.description });
    // Add marketSession/marketData status
    if (gs.marketSession && gs.marketSession.status === 'block') {
      res.marketClosed = true;
      activeBlocks.push({ gate: 'marketSession', status: 'block', label: '非交易时段', detail: gs.marketSession.description });
    }
    if (gs.marketData && gs.marketData.status === 'block') activeBlocks.push({ gate: 'marketData', status: 'block', label: '行情数据缺失', detail: gs.marketData.description });
    if (res.hardBlockers.length > 0) {
      res.primaryBlocker = res.hardBlockers[0].gate;
    }
    res.allActiveBlockers = activeBlocks;
    // displayReasons: merge hard blockers + soft reducers + advisory for UI
    res.displayReasons = [];
    for (var h = 0; h < res.hardBlockers.length; h++) { res.displayReasons.push(res.hardBlockers[h].reason); }
    for (var s = 0; s < res.softReducers.length; s++) { res.displayReasons.push(res.softReducers[s].reason); }
    for (var a = 0; a < res.advisorySignals.length; a++) { res.displayReasons.push(res.advisorySignals[a].interpretation); }
    // Cache
    _lastResult = res;
    _lastResultTime = Date.now();
    return res;
  }

  var pf = ctx.portfolio || { positions: [], tradeHistory: [], _stats: {} };
  var indices = ctx.indices || null;
  var macroContext = ctx.macroContext || null;
  var pipelineResults = ctx.pipelineResults || null;

  // ================================================================
  // HARD BLOCKER 0: Market session gate (v3.4.4)
  // ================================================================
  // MUST be the first gate. Only real trading windows can proceed to
  // buy evaluation. Sell/risk/position checks continue regardless.
  // This prevents stale pipeline+index data from producing ALLOW
  // during closed/post_market/pre_market/lunch_break.
  var marketState = ctx.marketState || null;
  var TRADING_STATES = ['morning_session', 'afternoon_session', 'trading'];
  var isTradingSession = marketState && TRADING_STATES.indexOf(marketState) >= 0;

  if (marketState && !isTradingSession) {
    // Non-trading state explicitly set → BLOCK all new buys
    var stateLabelMap = { closed: '离市', pre_market: '盘前', lunch_break: '午休', post_market: '盘后' };
    var stateLabel = ctx.marketStateLabel || stateLabelMap[marketState] || marketState;
    result.canBuy = false;
    result.finalVerdict = 'BLOCK';
    result.finalVerdictLabel = '非交易时段/禁止开仓';
    result.maxBuysPerDay = 0;
    result.hardBlockers.push({
      gate: 'marketSession',
      reason: '当前非交易时段（' + stateLabel + '），禁止新开仓。卖出、风控、持仓检查不受影响。等待进入上午/下午交易时段。',
      severity: 'block',
    });
    return finalize(result);
  }

  // ================================================================
  // HARD BLOCKER 1: No market data
  // ================================================================
  // v3.4.4: By the time we reach here, marketState is either a trading session
  // or null (caller didn't pass marketState — legacy path). The session gate above
  // already blocked all non-trading states, so isTradingSession is our guard.
  //
  // During trading hours, missing indices always BLOCK — even if pipelineResults
  // exist from a past scan. The kernel must not approve buys on stale data.
  var noMarketData = !indices || !Array.isArray(indices) || indices.length === 0;
  var noPipeline = !pipelineResults || !Array.isArray(pipelineResults) || pipelineResults.length === 0;

  if (noMarketData) {
    if (isTradingSession) {
      // Trading session with no index data = data feed failure, not normal
      result.canBuy = false;
      result.finalVerdict = 'BLOCK';
      result.finalVerdictLabel = '无行情数据/禁止开仓';
      result.hardBlockers.push({
        gate: 'marketData',
        reason: '交易时段指数行情数据缺失 — 可能数据源异常，禁止开仓。有管线结果(' + (noPipeline ? '无' : '有') + ')但指数是实时决策的必要条件。',
        severity: 'block',
      });
      return finalize(result);
    }
    // No marketState set (legacy caller) + no indices + no pipeline:
    // conservative BLOCK — we don't know if market is open
    if (noPipeline) {
      result.canBuy = false;
      result.finalVerdict = 'BLOCK';
      result.finalVerdictLabel = '无数据/等待交易窗口';
      result.hardBlockers.push({
        gate: 'marketData',
        reason: '指数和管线数据均缺失，无法判断市场状态。等待下个交易窗口或手动运行管线。',
        severity: 'block',
      });
      return finalize(result);
    }
    // marketState unknown + has pipeline but no indices:
    // let it fall through to remaining gate checks (legacy tolerance)
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
    return finalize(result);
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
    return finalize(result);
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
    return finalize(result);
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
    return finalize(result);
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
    return finalize(result);
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

  // All paths lead through finalize() which builds gateStates + caches + allActiveBlockers
  return finalize(result);
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
  // v3.4.5: changePercent=null is WARN (data incomplete), not pass/unknown.
  // This happens when IndexRecorder provides price but no changePercent.
  var shIdx = indices ? indices.find(function(i) { return i.code === '000001' || i.code === 'sh000001'; }) : null;
  var marketStatus = 'unknown';
  if (shIdx && shIdx.changePercent != null) {
    marketStatus = shIdx.changePercent < -0.5 ? 'block' : 'pass';
  } else if (shIdx && shIdx.price != null) {
    marketStatus = 'warn'; // price exists but changePercent missing
  }

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
  var shTotalTrades = 0;
  if (shResult && shResult.masterControl) {
    shVerdict = shResult.masterControl.verdict || 'ALLOW';
    shConfidence = shResult.masterControl.confidence;
    shReasons = shResult.masterControl.reasons || [];
    shTotalTrades = shResult.masterControl.totalTrades || 0;
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

  // --- Market session ---
  var msStatus = 'pass';
  var msDescription = '交易时段，正常';
  if (ctx.marketState) {
    var TRADING_STATES_GS = ['morning_session', 'afternoon_session', 'trading'];
    if (TRADING_STATES_GS.indexOf(ctx.marketState) < 0) {
      msStatus = 'block';
      var gsLabelMap = { closed: '离市', pre_market: '盘前', lunch_break: '午休', post_market: '盘后' };
      msDescription = '非交易时段（' + (ctx.marketStateLabel || gsLabelMap[ctx.marketState] || ctx.marketState) + '），禁止新开仓';
    }
  }

  // --- Market data ---
  var mdStatus = (!indices || indices.length === 0) ? 'block' : 'pass';
  var mdDescription = mdStatus === 'block'
    ? '指数行情数据缺失，无法进行实时决策'
    : '指数数据正常（' + indices.length + '只指数）';

  return {
    marketSession: {
      status: msStatus,
      state: ctx.marketState || 'unknown',
      description: msDescription,
    },
    marketData: {
      status: mdStatus,
      indexCount: indices ? indices.length : 0,
      description: mdDescription,
    },
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
      description: marketStatus === 'block'
        ? '上证跌幅' + (shIdx && shIdx.changePercent != null ? shIdx.changePercent.toFixed(2) : '?') + '%超过-0.5%阈值，禁止买入'
        : (marketStatus === 'warn'
          ? '上证指数' + (shIdx && shIdx.price != null ? shIdx.price.toFixed(2) : '?') + '点，涨跌幅数据缺失（IndexRecorder/Sina仅提供价格），市场方向判断降级'
          : (marketStatus === 'pass'
            ? '上证' + (shIdx && shIdx.changePercent >= 0 ? '涨' : '跌') + Math.abs(shIdx.changePercent).toFixed(2) + '%，方向正常'
            : '无上证指数数据')),
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
      totalTrades: shTotalTrades,
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

/**
 * v3.4.5: Shared index loader — unified market snapshot pipeline.
 *
 * Priority order:
 *   1. market_snapshot_latest.json (written by pipeline.fetchIndices — most complete,
 *      includes changePercent, prevClose, high, low, open from Eastmoney)
 *   2. IndexRecorder intraday files (index_history_DATE.json) — for indices
 *      pipeline didn't cover; price only, no changePercent
 *   3. Historical daily K-line files (market_history/indices/*.json) — last resort,
 *      NEVER rewrites date to today
 *
 * Each index now carries independent freshness metadata:
 *   - freshnessStatus: 'live' | 'recorder' | 'cached' | 'stale_daily' | 'missing'
 *   - source: 'pipeline_eastmoney' | 'index_recorder' | 'daily_kline'
 *   - fetchAt: ISO timestamp of when the data was captured
 *   - quoteDate: actual date of the price quote (NOT faked to today)
 *
 * Returns [{code, name, price, changePercent, prevClose, date, source,
 *           fetchAt, quoteDate, freshnessStatus}] or null on failure.
 * Used by cockpit, think-tank, kernel, data_quality, and strategy_health.
 */
// === Catch audit helper (Phase 0.2) — appends failure record to catch_failures.jsonl ===
var _lastSnapshotWriteSuccess = null;
var _lastIndicesLoadSuccess = null;

function _recordCatchFailure(detail) {
  try {
    var _cfFs = require('fs');
    var _cfPath = require('path');
    var _cfDir = _cfPath.join(__dirname, '..', 'report-engine', 'data', 'simfolio');
    if (!_cfFs.existsSync(_cfDir)) _cfFs.mkdirSync(_cfDir, { recursive: true });
    var _cfEntry = {
      timestamp: new Date().toISOString(),
      source: detail.source,
      errorCode: detail.errorCode || 'UNKNOWN',
      errorMessage: detail.errorMessage || '',
      lastSuccessAt: detail.lastSuccessAt || null,
      fallbackUsed: detail.fallbackUsed || null,
    };
    _cfFs.appendFileSync(_cfPath.join(_cfDir, 'catch_failures.jsonl'), JSON.stringify(_cfEntry) + '\n', 'utf8');
  } catch (_) { /* Last resort: cannot log the logger failure */ }
}

function loadLatestIndices() {
  try {
    var fs = require('fs');
    var path = require('path');
    var now = new Date();
    var today = now.toISOString().slice(0, 10);
    var idxDir = path.join(__dirname, '..', 'report-engine', 'data', 'market_history', 'indices');
    var snapDir = path.join(__dirname, '..', 'report-engine', 'data', 'simfolio');
    var snapshotFile = path.join(snapDir, 'market_snapshot_latest.json');
    var defs = [
      { file: 'sh000001.json', code: '000001', name: '上证指数', recorderKey: 'sh' },
      { file: 'sz399001.json', code: '399001', name: '深证成指', recorderKey: 'sz' },
      { file: 'sz399006.json', code: '399006', name: '创业板指', recorderKey: 'cy' },
    ];

    // === Tier 1: market_snapshot_latest.json (pipeline writes this, most complete) ===
    var snapshotData = null;
    if (fs.existsSync(snapshotFile)) {
      try {
        snapshotData = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
      } catch (_) { /* snapshot parse failure logged below in per-index tier decisions */ }
    }

    // === Tier 2: IndexRecorder intraday file ===
    var recorderFile = path.join(snapDir, 'index_history_' + today + '.json');
    var recorderData = null;
    if (fs.existsSync(recorderFile)) {
      try {
        var raw = JSON.parse(fs.readFileSync(recorderFile, 'utf8'));
        if (Array.isArray(raw) && raw.length > 0) {
          recorderData = raw[raw.length - 1];
        }
      } catch (_) { /* recorder parse failure — will fall through to Tier 3 */ }
    }

    // === Build results: each index independently ===
    var results = [];
    var snapshotAge = 999;
    if (snapshotData && snapshotData.time) {
      snapshotAge = (now - new Date(snapshotData.time)) / 60000;
    }

    for (var i = 0; i < defs.length; i++) {
      var idxDef = defs[i];

      // Tier 1: pipeline snapshot (has changePercent, prevClose, etc.)
      if (snapshotData && snapshotData.indices) {
        var snapIdx = snapshotData.indices.find(function(ix) {
          return ix.code === idxDef.code;
        });
        if (snapIdx) {
          var isFresh = snapshotAge < 5 && snapIdx.freshnessStatus === 'live';
          results.push({
            code: idxDef.code,
            name: idxDef.name,
            price: snapIdx.price,
            changePercent: snapIdx.changePercent != null ? snapIdx.changePercent : null,
            prevClose: snapIdx.prevClose != null ? snapIdx.prevClose : null,
            high: snapIdx.high != null ? snapIdx.high : null,
            low: snapIdx.low != null ? snapIdx.low : null,
            open: snapIdx.open != null ? snapIdx.open : null,
            date: snapIdx.quoteDate || snapshotData.date || today,
            source: snapIdx.source || 'snapshot_cache',
            fetchAt: snapIdx.fetchAt || snapshotData.time || null,
            quoteDate: snapIdx.quoteDate || snapshotData.date || null,
            freshnessStatus: isFresh ? 'live' : (snapshotAge < 30 ? 'cached' : 'stale_daily'),
          });
          continue;
        }
      }

      // Tier 2: IndexRecorder (price only, no changePercent)
      if (recorderData && idxDef.recorderKey && recorderData[idxDef.recorderKey] != null) {
        results.push({
          code: idxDef.code,
          name: idxDef.name,
          price: recorderData[idxDef.recorderKey],
          changePercent: null,
          prevClose: null,
          date: today,
          source: 'index_recorder',
          fetchAt: today + 'T' + (recorderData.time || '') + ':00+08:00',
          quoteDate: today,
          freshnessStatus: 'recorder',
        });
        continue;
      }

      // Tier 3: Historical daily K-line (LAST RESORT — NEVER fake the date)
      var fp = path.join(idxDir, idxDef.file);
      if (fs.existsSync(fp)) {
        try {
          var arr = JSON.parse(fs.readFileSync(fp, 'utf8'));
          if (Array.isArray(arr) && arr.length > 0) {
            var last = arr[arr.length - 1];
            var prev = arr.length >= 2 ? arr[arr.length - 2] : null;
            var changePercent = (prev && prev.close && last.close)
              ? parseFloat(((last.close - prev.close) / prev.close * 100).toFixed(2))
              : null;
            var klineDate = last.date || null;
            results.push({
              code: idxDef.code,
              name: idxDef.name,
              price: last.close,
              changePercent: changePercent,
              prevClose: prev ? prev.close : null,
              date: klineDate,           // ← REAL date, NOT faked to today
              source: 'daily_kline',
              fetchAt: null,
              quoteDate: klineDate,
              freshnessStatus: 'stale_daily',
            });
          }
        } catch (e) {
          _recordCatchFailure({
            source: 'decision_kernel.loadLatestIndices.klineParse',
            errorCode: 'PARSE_ERR',
            errorMessage: e.message || 'kline parse failure for ' + idxDef.code,
            lastSuccessAt: _lastIndicesLoadSuccess,
            fallbackUsed: null,
          });
        }
      }
      // If nothing found, this index is simply not in results (missing)
    }

    if (results.length > 0) {
      _lastIndicesLoadSuccess = new Date().toISOString();
      return results;
    }
    return null;
  } catch (e) {
    _recordCatchFailure({
      source: 'decision_kernel.loadLatestIndices',
      errorCode: e.code || 'LOAD_ERR',
      errorMessage: e.message || 'unknown',
      lastSuccessAt: _lastIndicesLoadSuccess,
      fallbackUsed: null,
    });
    return null;
  }
}

/**
 * v3.4.5: Write market snapshot from pipeline fetchIndices results.
 *
 * Called by pipeline.js after each fetchIndices() call. The pipeline gets
 * the most complete index data (price, changePercent, change, high, low,
 * open, prevClose from Eastmoney push2 API).
 *
 * This is now the PRIMARY snapshot source — IndexRecorder is the fallback.
 *
 * @param {Array} indices — [{code, name, price, changePercent, change, high, low, open, prevClose}]
 * @param {string} source — 'pipeline_eastmoney' (default)
 */
function writeMarketSnapshot(indices, source) {
  try {
    if (!indices || !Array.isArray(indices) || indices.length === 0) return;
    var fs = require('fs');
    var path = require('path');
    var now = new Date();
    var today = now.toISOString().slice(0, 10);
    var snapDir = path.join(__dirname, '..', 'report-engine', 'data', 'simfolio');
    if (!fs.existsSync(snapDir)) fs.mkdirSync(snapDir, { recursive: true });

    var enriched = indices.map(function(ix) {
      return {
        code: ix.code,
        name: ix.name || '',
        price: ix.price,
        changePercent: ix.changePercent != null ? ix.changePercent : null,
        prevClose: ix.prevClose != null ? ix.prevClose : null,
        high: ix.high != null ? ix.high : null,
        low: ix.low != null ? ix.low : null,
        open: ix.open != null ? ix.open : null,
        fetchAt: now.toISOString(),
        quoteDate: today,
        source: source || 'pipeline_eastmoney',
        freshnessStatus: 'live',
      };
    });

    var snapshot = {
      date: today,
      time: now.toISOString(),
      source: source || 'pipeline_eastmoney',
      indices: enriched,
    };

    fs.writeFileSync(
      path.join(snapDir, 'market_snapshot_latest.json'),
      JSON.stringify(snapshot, null, 2),
      'utf8'
    );
    _lastSnapshotWriteSuccess = now.toISOString();
  } catch (e) {
    _recordCatchFailure({
      source: 'decision_kernel.writeMarketSnapshot',
      errorCode: e.code || 'WRITE_ERR',
      errorMessage: e.message || 'snapshot write failure',
      lastSuccessAt: _lastSnapshotWriteSuccess,
      fallbackUsed: null,
    });
  }
}

decision_kernel.computeDecision = computeDecision;
decision_kernel.getLastResult = getLastResult;
decision_kernel.setCachedResult = setCachedResult;
decision_kernel._buildAllGateStates = _buildAllGateStates;
decision_kernel.loadLatestIndices = loadLatestIndices;
decision_kernel.writeMarketSnapshot = writeMarketSnapshot;

module.exports = decision_kernel;
