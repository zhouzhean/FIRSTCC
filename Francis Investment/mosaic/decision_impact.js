/**
 * decision_impact.js — 模块决策影响力分级 (v3.4.5)
 *
 * SINGLE SOURCE OF TRUTH for all module influence declarations.
 * Used by decision_kernel, cockpit, think-tank, and audit.
 *
 * 四级:
 *   active_effective   — 模块正常运行且真实影响了本次决策
 *   active_monitoring  — 模块正常运行但仅监控，未参与决策（如数据不足、权重为0、功能off）
 *   degraded           — 模块部分运行，能力降级（如数据缺失、样本不足）
 *   off                — 模块完全未启用或不可用
 */

/**
 * Determine the decision impact level for various modules.
 *
 * @param {Object} opts
 * @param {boolean} [opts.moduleEnabled]     — is the module feature flag on?
 * @param {boolean} [opts.hasData]           — does the module have data to work with?
 * @param {boolean} [opts.sufficientSamples] — are there enough samples to draw conclusions?
 * @param {boolean} [opts.directlyAffected]  — did this module's output change the decision?
 * @param {boolean} [opts.dataAvailable]     — is the data source available (e.g., NB connected)?
 * @param {string}  [opts.fallbackReason]    — if degraded, why?
 * @returns {{ impact: string, label: string, description: string }}
 */
function classify(opts) {
  var o = opts || {};

  if (o.moduleEnabled === false || o.dataAvailable === false) {
    return {
      impact: 'off',
      label: '未启用',
      description: o.fallbackReason || '模块未启用或数据不可用',
    };
  }

  if (!o.hasData || o.dataAvailable === false) {
    return {
      impact: 'degraded',
      label: '数据缺失',
      description: o.fallbackReason || '无可用数据，输出无效',
    };
  }

  if (o.sufficientSamples === false) {
    return {
      impact: 'active_monitoring',
      label: '监控中',
      description: o.fallbackReason || '样本不足' + (o.currentSamples != null ? '（当前' + o.currentSamples + '/' + (o.requiredSamples || 30) + '）' : '，仅监控不参与决策'),
    };
  }

  if (o.directlyAffected === true) {
    return {
      impact: 'active_effective',
      label: '有效影响',
      description: o.description || '模块正常运行并真实影响本次决策',
    };
  }

  // Module is running but not currently affecting the decision
  return {
    impact: 'active_monitoring',
    label: '监控中',
    description: o.description || '模块运行中，本次未参与决策',
  };
}

/**
 * Quick check for individual common modules.
 */
function forThinkTankDefense(opts) {
  var o = opts || {};
  if (!o.executed || !o.hasData) {
    return {
      impact: 'off',
      label: '未执行',
      description: 'ThinkTankDefense 未执行，未参与本次决策',
    };
  }
  if (o.defenseActive) {
    return {
      impact: 'active_effective',
      label: '有效影响',
      description: 'ThinkTankDefense 执行并提供了防御建议',
    };
  }
  return {
    impact: 'active_monitoring',
    label: '监控中',
    description: 'ThinkTankDefense 执行但未触发防御',
  };
}

function forDynamicWeights(opts) {
  var o = opts || {};
  if (!o.enabled || o.mode === 'off') {
    return {
      impact: 'active_monitoring',
      label: '等待样本',
      description: '动态权重未启用——等待样本：当前 ' + (o.currentSamples || 0) + ' / 300',
    };
  }
  // Phase 3.1: Updated thresholds — 300/1000 instead of 30/100
  if (o.sampleCount != null && o.sampleCount < 300) {
    return {
      impact: 'active_monitoring',
      label: '样本积累中',
      description: '样本数 ' + o.sampleCount + ' < 300，仅记录不更新权重',
    };
  }
  if (o.sampleCount != null && o.sampleCount < 1000) {
    return {
      impact: 'active_monitoring',
      label: '建议模式',
      description: '样本数 ' + o.sampleCount + '（需≥1000并满足IC/收益门控方可自动调整），当前仅提供建议权重',
    };
  }
  if (o.tier === 'shadow_allowed' || o.lastUpdated) {
    return {
      impact: 'active_effective',
      label: '有效影响',
      description: '动态权重活跃，基于 ' + o.sampleCount + ' 样本，次更新: ' + (o.lastUpdated || 'N/A'),
    };
  }
  return {
    impact: 'active_monitoring',
    label: '等待首次更新',
    description: '动态权重启用但尚未达到门控条件',
  };
}

function forNorthBound(opts) {
  var o = opts || {};
  if (!o.available) {
    return {
      impact: 'degraded',
      label: '不可用',
      description: '北向资金数据不可用，未参与本次决策',
    };
  }
  if (o.usedInDecision) {
    return {
      impact: 'active_effective',
      label: '有效影响',
      description: '北向资金数据正常并参与决策',
    };
  }
  return {
    impact: 'active_monitoring',
    label: '监控中',
    description: '北向资金数据可用但本次未影响决策',
  };
}

function forWeekendContext(opts) {
  var o = opts || {};
  if (!o.available || o.expired) {
    return {
      impact: 'degraded',
      label: '已过期',
      description: '周末上下文数据已过期，未参与本次决策',
    };
  }
  if (o.analyzedToday) {
    return {
      impact: 'active_effective',
      label: '有效影响',
      description: '周末分析上下文正常参与决策',
    };
  }
  return {
    impact: 'active_monitoring',
    label: '监控中',
    description: '周末上下文可用但本次未使用',
  };
}

/**
 * Phase 3.4: Causal audit classification — extends classify() with before/after evidence.
 * Only returns active_effective when the module actually changed scores/thresholds.
 */
function classifyCausal(opts) {
  var base = classify(opts);
  var result = {
    impact: base.impact,
    label: base.label,
    description: base.description,
    // Causal audit fields
    inputAvailable: opts.inputAvailable !== false,
    executed: opts.executed !== false,
    outputValue: opts.outputValue != null ? opts.outputValue : null,
    appliedTo: opts.appliedTo || null,
    beforeValue: opts.beforeValue != null ? opts.beforeValue : null,
    afterValue: opts.afterValue != null ? opts.afterValue : null,
    decisionDelta: opts.beforeValue != null && opts.afterValue != null
      ? +(opts.afterValue - opts.beforeValue).toFixed(4)
      : null,
  };

  // Downgrade to monitoring if module executed but produced zero delta
  if (result.impact === 'active_effective' && result.decisionDelta === 0 && opts.directlyAffected === true) {
    result.impact = 'active_monitoring';
    result.label = '无影响';
    result.description = '模块执行但输出值未改变决策（delta=0）';
  }

  return result;
}

/**
 * Render a badge for the UI.
 */
function renderBadge(impactObj) {
  if (!impactObj) return '<span class="impact-badge off">未知</span>';
  var cls = impactObj.impact;
  return '<span class="impact-badge ' + cls + '" title="' + (impactObj.description || '') + '">' + (impactObj.label || impactObj.impact) + '</span>';
}

/**
 * CSS for decision impact badges.
 */
var IMPACT_CSS = [
  '.impact-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; cursor: help; }',
  '.impact-badge.active_effective { background: #065f46; color: #6ee7b7; }',
  '.impact-badge.active_monitoring { background: #1e3a5f; color: #93c5fd; }',
  '.impact-badge.degraded { background: #78350f; color: #fcd34d; }',
  '.impact-badge.off { background: #1f2937; color: #6b7280; }',
].join('\n');

module.exports = {
  classify: classify,
  classifyCausal: classifyCausal,   // Phase 3.4
  forThinkTankDefense: forThinkTankDefense,
  forDynamicWeights: forDynamicWeights,
  forNorthBound: forNorthBound,
  forWeekendContext: forWeekendContext,
  renderBadge: renderBadge,
  IMPACT_CSS: IMPACT_CSS,
};
