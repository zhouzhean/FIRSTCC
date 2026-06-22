/**
 * no_buy_reasons.js — 标准化"无买入"原因枚举 (v3.4.5)
 *
 * SINGLE SOURCE OF TRUTH: 所有"为什么没买"的判断都使用本模块，
 * decision_audit、cockpit UI、think-tank 共用同一套 reason codes。
 *
 * 优先级从高到低排列：第一个匹配到的作为 primaryNoBuyReason，
 * 后续匹配的作为 secondaryReasons。
 */

var REASONS = {
  market_session_block: {
    label: '非交易时段',
    desc: '当前不在交易时段（closed/pre_market/post_market/lunch_break）',
    severity: 'hard_blocker',
  },
  market_data_missing: {
    label: '行情数据缺失',
    desc: '交易时段内无指数行情数据或关键指数缺失',
    severity: 'hard_blocker',
  },
  data_quality_cautious: {
    label: '数据质量降级',
    desc: 'data_quality penalty ≥ 4，数据源不可靠',
    severity: 'soft_reducer',
  },
  data_quality_block: {
    label: '数据质量阻断',
    desc: 'data_quality penalty ≥ 7，数据源严重不可靠',
    severity: 'hard_blocker',
  },
  strategy_health_cautious: {
    label: '策略健康降级',
    desc: 'strategyHealth masterControl = CAUTIOUS',
    severity: 'soft_reducer',
  },
  strategy_health_reduce: {
    label: '策略健康(仅卖)',
    desc: 'strategyHealth masterControl = REDUCE，仅允许卖出',
    severity: 'soft_reducer',
  },
  strategy_health_block: {
    label: '策略健康阻断',
    desc: 'strategyHealth masterControl = BLOCK',
    severity: 'hard_blocker',
  },
  no_candidates_above_threshold: {
    label: '无候选达标',
    desc: '所有股票的 compositeScore 低于买入阈值',
    severity: 'signal_quality',
  },
  top_score_below_threshold: {
    label: '最高分未达标',
    desc: '最高分股票的 compositeScore 未达到 minAbsoluteScore',
    severity: 'signal_quality',
  },
  expected_return_below_zero: {
    label: '预期收益为负',
    desc: '所有候选股的 expectedReturn ≤ 0',
    severity: 'signal_quality',
  },
  position_limit: {
    label: '仓位上限',
    desc: '当日已买入数量达到 maxBuysPerDay 上限',
    severity: 'risk_control',
  },
  cooldown_active: {
    label: '冷却期',
    desc: '距离上次买入/卖出在冷却期内',
    severity: 'risk_control',
  },
  sector_exposure_limit: {
    label: '板块持仓上限',
    desc: '该板块已持仓比例达到上限',
    severity: 'risk_control',
  },
  leakage_audit_block: {
    label: '数据泄漏阻断',
    desc: 'leakageAudit 检测到 CRITICAL / DATA_LEAKAGE_RISK / NO_SAMPLES',
    severity: 'hard_blocker',
  },
  circuit_breaker: {
    label: '熔断',
    desc: 'cross_market circuitBreaker regime = panic / risk_off',
    severity: 'hard_blocker',
  },
  drawdown_restrict: {
    label: '回撤限制',
    desc: '当日回撤超过 -8%，限制买入',
    severity: 'soft_reducer',
  },
};

/**
 * Derive no-buy reasons from a kernelDecision + execution context.
 *
 * @param {Object} opts
 * @param {Object} opts.kernelDecision  — computeDecision() 的返回值
 * @param {Object} [opts.executionResult] — simfolio 执行结果（可选）
 * @param {number} [opts.candidateCount]
 * @param {number} [opts.buyCount]
 * @param {number} [opts.maxExpectedReturn] — 候选股最大预期收益 (Phase 1.4)
 * @returns {{ primaryNoBuyReason: string|null, secondaryReasons: string[], reasonLabels: string[] }}
 */
function deriveNoBuyReasons(opts) {
  var kd = (opts && opts.kernelDecision) || null;
  var exec = (opts && opts.executionResult) || null;
  var candidateCount = (opts && opts.candidateCount) || 0;
  var buyCount = (opts && opts.buyCount) || 0;

  var primary = null;
  var secondary = [];
  var all = [];

  // Only derive reasons if no buy was executed
  if (buyCount > 0) return { primaryNoBuyReason: null, secondaryReasons: [], reasonLabels: [] };

  function add(code) {
    all.push(code);
    if (!primary) primary = code;
    else if (secondary.indexOf(code) < 0) secondary.push(code);
  }

  // Check hard blockers first
  if (kd) {
    var blockers = kd.hardBlockers || [];
    for (var i = 0; i < blockers.length; i++) {
      var gate = blockers[i].gate;
      if (gate === 'marketSession') add('market_session_block');
      if (gate === 'marketData') add('market_data_missing');
      if (gate === 'circuitBreaker') add('circuit_breaker');
      if (gate === 'leakageAudit') add('leakage_audit_block');
      if (gate === 'strategyHealth') add('strategy_health_block');
      if (gate === 'dataQuality') add('data_quality_block');
    }

    var reducers = kd.softReducers || [];
    for (var j = 0; j < reducers.length; j++) {
      var rgate = reducers[j].gate;
      if (rgate === 'dataQuality') add('data_quality_cautious');
      if (rgate === 'strategyHealth') {
        // Phase 1.5: Differentiate CAUTIOUS vs REDUCE
        var _shGate = kd.gateStates && kd.gateStates.strategyHealth;
        if (_shGate && _shGate.verdict === 'REDUCE') {
          add('strategy_health_reduce');
        } else {
          add('strategy_health_cautious');
        }
      }
      if (rgate === 'drawdown') add('drawdown_restrict');
    }

    // Gate states for finer detail
    if (kd.gateStates) {
      if (kd.gateStates.strategyHealth) {
        var sh = kd.gateStates.strategyHealth;
        if (sh.verdict === 'CAUTIOUS' && all.indexOf('strategy_health_cautious') < 0) {
          add('strategy_health_cautious');
        }
        if (sh.verdict === 'REDUCE' && all.indexOf('strategy_health_reduce') < 0) {
          add('strategy_health_reduce');
        }
      }
    }
  }

  // Signal quality reasons (only if no hard blocker fired)
  if (!primary || all.every(function(r) { return REASONS[r] && REASONS[r].severity !== 'hard_blocker'; })) {
    if (candidateCount === 0) {
      add('no_candidates_above_threshold');
    } else {
      // Check top score vs threshold
      if (kd && kd.topScore != null && kd.buyThreshold != null && kd.topScore < kd.buyThreshold) {
        add('top_score_below_threshold');
      }
    }
    // Phase 1.4: Check expected return — if provided, add reason when all candidates have E[R] <= 0
    if (opts && opts.maxExpectedReturn != null && opts.maxExpectedReturn <= 0) {
      add('expected_return_below_zero');
    }
  }

  // Cooldown / position limit from execution
  if (exec) {
    if (exec.cooldownActive) add('cooldown_active');
    if (exec.positionLimitReached) add('position_limit');
    if (exec.sectorExposureLimit) add('sector_exposure_limit');
  }

  // Deduplicate
  var seen = {};
  var uniqueSecondary = [];
  for (var k = 0; k < secondary.length; k++) {
    if (!seen[secondary[k]] && secondary[k] !== primary) {
      seen[secondary[k]] = true;
      uniqueSecondary.push(secondary[k]);
    }
  }

  var reasonLabels = [];
  for (var m = 0; m < all.length; m++) {
    if (REASONS[all[m]]) reasonLabels.push(REASONS[all[m]].label);
  }

  return {
    primaryNoBuyReason: primary,
    secondaryReasons: uniqueSecondary,
    reasonLabels: reasonLabels,
  };
}

/**
 * Get full reason metadata for display.
 */
function getReasonMeta(code) {
  return REASONS[code] || null;
}

/**
 * Get all reason codes for UI dropdowns / filters.
 */
function getAllReasons() {
  return Object.keys(REASONS).map(function(code) {
    var r = REASONS[code];
    return { code: code, label: r.label, desc: r.desc, severity: r.severity };
  });
}

module.exports = {
  REASONS: REASONS,
  deriveNoBuyReasons: deriveNoBuyReasons,
  getReasonMeta: getReasonMeta,
  getAllReasons: getAllReasons,
};
