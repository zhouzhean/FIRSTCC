/**
 * predict.js — 预测仪表板 UI 模板
 *
 * 渲染预测引擎的 5 个面板：
 *   1. 期望收益排名卡片
 *   2. 因子预测力矩阵
 *   3. 动态权重面板
 *   4. 板块领先/滞后预测
 *   5. 周期×因子有效性热力图
 */
var renderPredictionDashboard = (function() {

function renderPredictionDashboard(data, mode) {
  if (!data) return '<div class="predict-loading">加载预测数据中...</div>';

  var html = '<div class="predict-dashboard">';

  // Panel 1: Expected return ranking
  if (data.ranking) {
    html += renderExpectedReturnRanking(data.ranking);
  }

  // Panel 2: Factor prediction matrix
  if (data.factorPerf) {
    html += renderFactorPredictionMatrix(data.factorPerf);
  }

  // Panel 3: Dynamic weights
  if (data.dynamicWeights) {
    html += renderDynamicWeightsPanel(data.dynamicWeights);
  }

  // Panel 4: Sector lead/lag
  if (data.sectorLeadLag) {
    html += renderSectorLeadLagPanel(data.sectorLeadLag);
  }

  // Panel 5: Cycle × factor heatmap
  if (data.cycleFactorMatrix) {
    html += renderCycleFactorHeatmap(data.cycleFactorMatrix);
  }

  html += '</div>';
  return html;
}

function renderExpectedReturnRanking(ranking) {
  var html = '<div class="predict-card">';
  html += '<div class="predict-card-header">🎯 今日买入候选（按期望5日收益排名）</div>';
  html += '<div class="predict-card-body">';

  if (!ranking || ranking.length === 0) {
    html += '<div class="predict-empty">暂无符合条件的候选股（最低期望收益阈值: ' + (ranking.minExpectedReturn || 0) + '%）</div>';
  } else {
    html += '<div class="predict-rank-list">';
    for (var i = 0; i < Math.min(ranking.length, 10); i++) {
      var r = ranking[i];
      var er = r.prediction ? r.prediction.expectedReturn : 0;
      var erClass = er > 2 ? 'er-strong' : er > 0 ? 'er-positive' : 'er-negative';
      html += '<div class="predict-rank-item">';
      html += '<span class="predict-rank-num">#' + (i + 1) + '</span>';
      html += '<span class="predict-rank-name">' + (r.name || r.code) + '</span>';
      html += '<span class="predict-rank-er ' + erClass + '">E[R5d]=' + (er > 0 ? '+' : '') + er.toFixed(1) + '%</span>';
      if (r.prediction && r.prediction.breakdown) {
        html += '<span class="predict-rank-breakdown">';
        var bd = r.prediction.breakdown;
        if (bd.factorCombo && bd.factorCombo.available) html += '因子' + (bd.factorCombo.value > 0 ? '+' : '') + bd.factorCombo.value.toFixed(1) + '% ';
        if (bd.sectorFlow && bd.sectorFlow.available) html += '板块' + (bd.sectorFlow.value > 0 ? '+' : '') + bd.sectorFlow.value.toFixed(1) + '% ';
        if (bd.marketCycle && bd.marketCycle.available) html += '周期' + (bd.marketCycle.value > 0 ? '+' : '') + bd.marketCycle.value.toFixed(1) + '%';
        html += '</span>';
      }
      html += '<span class="predict-rank-confidence">置信度' + Math.round((r.prediction ? r.prediction.confidence : 0) * 100) + '%</span>';
      html += '</div>';
    }
    html += '</div>';
  }

  html += '</div></div>';
  return html;
}

function renderFactorPredictionMatrix(factorPerf) {
  var html = '<div class="predict-card">';
  html += '<div class="predict-card-header">📊 个股因子预测力（基于历史触发→个股收益）</div>';
  html += '<div class="predict-card-body">';

  if (!factorPerf || !factorPerf.factors || factorPerf.factors.length === 0) {
    html += '<div class="predict-empty">数据不足，需要至少3天扫描记录</div>';
  } else {
    html += '<table class="predict-table factor-table"><thead><tr>';
    html += '<th>因子</th><th>名称</th><th>5日命中率</th><th>5日平均收益</th><th>1日命中率</th><th>样本数</th><th>状态</th>';
    html += '</tr></thead><tbody>';

    for (var i = 0; i < factorPerf.factors.length; i++) {
      var f = factorPerf.factors[i];
      var statusClass = f.status === 'hot' ? 'status-hot' : f.status === 'cold' ? 'status-cold' : 'status-stable';
      var statusLabel = f.status === 'hot' ? '🔥HOT' : f.status === 'cold' ? '❄COLD' : '→STABLE';
      html += '<tr>';
      html += '<td class="factor-id">' + f.id + '</td>';
      html += '<td>' + f.name + '</td>';
      html += '<td>' + (f.hitRate != null ? Math.round(f.hitRate * 100) + '%' : 'N/A') + '</td>';
      html += '<td class="' + (f.avgReturn > 0 ? 'positive' : f.avgReturn < 0 ? 'negative' : '') + '">' + (f.avgReturn != null ? (f.avgReturn > 0 ? '+' : '') + f.avgReturn.toFixed(1) + '%' : 'N/A') + '</td>';
      html += '<td>' + (f.perf1d && f.perf1d.hitRate != null ? Math.round(f.perf1d.hitRate * 100) + '%' : 'N/A') + '</td>';
      html += '<td>' + f.totalSamples + '</td>';
      html += '<td><span class="predict-status ' + statusClass + '">' + statusLabel + '</span></td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
  }

  html += '</div></div>';
  return html;
}

function renderDynamicWeightsPanel(dw) {
  var html = '<div class="predict-card">';
  html += '<div class="predict-card-header">⚖ 动态权重（学习自近20日）</div>';
  html += '<div class="predict-card-body">';

  if (!dw || !dw.weights || dw._source === 'config') {
    html += '<div class="predict-empty">使用默认配置权重（数据不足，尚未学习）</div>';
  } else {
    html += '<div class="weights-grid">';
    var dims = [
      { key: 'fundamental', name: '基本面' },
      { key: 'technical', name: '技术面' },
      { key: 'hidden', name: '隐藏因子' },
      { key: 'capital_flow', name: '资金流' },
      { key: 'event', name: '事件驱动' },
    ];
    for (var i = 0; i < dims.length; i++) {
      var d = dims[i];
      var w = dw.weights[d.key] != null ? Math.round(dw.weights[d.key] * 100) : 0;
      var barWidth = Math.max(5, w);
      html += '<div class="weight-item">';
      html += '<span class="weight-label">' + d.name + '</span>';
      html += '<div class="weight-bar-bg"><div class="weight-bar-fill" style="width:' + barWidth + '%"></div></div>';
      html += '<span class="weight-value">' + w + '%</span>';
      html += '</div>';
    }
    html += '</div>';
    html += '<div class="weights-footer">';
    html += 'R²=' + (dw._r2 != null ? dw._r2.toFixed(3) : 'N/A');
    html += ' · 更新于 ' + (dw._updatedAt ? dw._updatedAt.slice(0, 16) : 'N/A');
    html += ' · 源: ' + (dw._source === 'dynamic' ? '自动学习' : '配置默认');
    html += '</div>';
  }

  html += '</div></div>';
  return html;
}

function renderSectorLeadLagPanel(data) {
  var html = '<div class="predict-card">';
  html += '<div class="predict-card-header">🔄 板块轮动预测</div>';
  html += '<div class="predict-card-body">';

  if (!data || !data.available) {
    html += '<div class="predict-empty">' + (data && data.message ? data.message : '板块数据不足') + '</div>';
  } else {
    if (data.predictions && data.predictions.length > 0) {
      html += '<div class="leadlag-section"><div class="leadlag-section-title">📈 预测信号</div>';
      for (var i = 0; i < Math.min(data.predictions.length, 5); i++) {
        var p = data.predictions[i];
        var confClass = p.confidence === 'high' ? 'conf-high' : p.confidence === 'medium' ? 'conf-medium' : 'conf-low';
        html += '<div class="leadlag-item ' + confClass + '">' + p.signal + '</div>';
      }
      html += '</div>';
    }

    if (data.matrix && data.matrix.length > 0) {
      html += '<div class="leadlag-section"><div class="leadlag-section-title">🔗 领先/滞后关系</div>';
      html += '<table class="predict-table"><thead><tr><th>领先板块</th><th>滞后板块</th><th>时差</th><th>相关性</th></tr></thead><tbody>';
      for (var j = 0; j < Math.min(data.matrix.length, 10); j++) {
        var m = data.matrix[j];
        html += '<tr>';
        html += '<td>' + m.leader + '</td><td>' + m.follower + '</td>';
        html += '<td>' + m.bestLag + '天</td>';
        html += '<td class="' + (m.correlation > 0.5 ? 'positive' : '') + '">' + m.correlation.toFixed(2) + '</td>';
        html += '</tr>';
      }
      html += '</tbody></table></div>';
    }
  }

  html += '</div></div>';
  return html;
}

function renderCycleFactorHeatmap(data) {
  var html = '<div class="predict-card">';
  html += '<div class="predict-card-header">🔥 周期×因子 有效性矩阵</div>';
  html += '<div class="predict-card-body">';

  if (!data || !data.heatmap || !data.heatmap.heatmap) {
    html += '<div class="predict-empty">数据不足，需要多周期交易记录</div>';
  } else {
    var h = data.heatmap;
    var cycles = h.cycles || [];
    var factors = h.factors || [];

    html += '<div class="heatmap-container">';
    html += '<table class="predict-table heatmap-table"><thead><tr><th>周期\\因子</th>';
    for (var fi = 0; fi < factors.length; fi++) {
      html += '<th>' + factors[fi] + '</th>';
    }
    html += '</tr></thead><tbody>';

    for (var ci = 0; ci < cycles.length; ci++) {
      var cycle = cycles[ci];
      html += '<tr><td class="cycle-label' + (cycle.isCurrent ? ' current-cycle' : '') + '">' + cycle.label;
      if (cycle.isCurrent) html += ' ←当前';
      html += '</td>';
      for (var fj = 0; fj < factors.length; fj++) {
        var cell = h.heatmap.find(function(x) { return x.cycle === cycle.id && x.factorId === factors[fj]; });
        var hitRate = cell ? cell.hitRate : null;
        var bgAlpha = hitRate != null ? Math.min(0.8, Math.abs(hitRate - 0.5) * 2) : 0;
        var bgColor = hitRate != null
          ? (hitRate >= 0.55 ? 'rgba(34,197,94,' + bgAlpha + ')' : hitRate < 0.40 ? 'rgba(239,68,68,' + bgAlpha + ')' : 'transparent')
          : 'transparent';
        html += '<td style="background:' + bgColor + ';text-align:center;">';
        html += hitRate != null ? Math.round(hitRate * 100) + '%' : '-';
        html += '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';

    // Current cycle preferences
    if (data.preferences && data.preferences.preferredFactors && data.preferences.preferredFactors.length > 0) {
      html += '<div class="cycle-prefs">';
      html += '<span class="pref-label">当前周期推荐因子：</span>';
      for (var pf = 0; pf < data.preferences.preferredFactors.length; pf++) {
        html += '<span class="pref-tag pref-recommend">' + data.preferences.preferredFactors[pf] + '</span>';
      }
      if (data.preferences.avoidFactors && data.preferences.avoidFactors.length > 0) {
        html += '<span class="pref-label" style="margin-left:16px;">避免因子：</span>';
        for (var af = 0; af < data.preferences.avoidFactors.length; af++) {
          html += '<span class="pref-tag pref-avoid">' + data.preferences.avoidFactors[af] + '</span>';
        }
      }
      html += '</div>';
    }
  }

  html += '</div></div>';
  return html;
}

// Public API
return {
  render: renderPredictionDashboard,
  renderExpectedReturnRanking: renderExpectedReturnRanking,
  renderFactorPredictionMatrix: renderFactorPredictionMatrix,
  renderDynamicWeightsPanel: renderDynamicWeightsPanel,
  renderSectorLeadLagPanel: renderSectorLeadLagPanel,
  renderCycleFactorHeatmap: renderCycleFactorHeatmap,
};

})();
