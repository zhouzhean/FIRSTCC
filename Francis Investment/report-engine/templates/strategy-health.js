/**
 * Strategy Health Dashboard — v3.0
 *
 * "策略体检页" — Comprehensive performance analytics:
 * 1. NAV curve (Canvas) — portfolio vs benchmark + drawdown sub-chart
 * 2. Monthly heatmap (Canvas) — calendar-style P&L grid
 * 3. Risk metric cards (DOM) — Sharpe/Sortino/Calmar
 * 4. Trade statistics (DOM) — win rate, profit factor, turnover
 * 5. Attribution summary (DOM) — last N trades + sector performance
 * 6. Master control judgment (DOM) — prominent verdict box
 */

// Called from app.js renderCurrentSection / renderStrategyHealthDirect
function renderStrategyHealth(data, containerId) {
  var html = '';

  // ---- Section Header ----
  html += '<div class="sh-header">';
  html += '<div class="sh-header-left">';
  html += '<span class="sh-title">策略体检</span>';
  html += '<span class="sh-subtitle">组合绩效综合分析 · ' + (data.date || '') + '</span>';
  html += '</div>';
  html += '<div class="sh-header-right">';
  html += '<span class="sh-generated-at">生成时间：' + (data.generatedAt ? data.generatedAt.replace('T', ' ').slice(0, 19) : '--') + '</span>';
  html += '</div>';
  html += '</div>';

  // ---- Row 0: Master Control (full width, prominent) ----
  html += renderMasterControlBox(data.masterControl);

  // ---- Row 1: Risk Metrics Cards (4-up grid) ----
  html += '<div class="sh-cards-row">';
  html += renderRiskMetricCard('Sharpe 比率', data.riskMetrics.sharpeRatio, '', '≥1.0 良好 / ≥0.5 可接受 / <0 不理想');
  html += renderRiskMetricCard('Sortino 比率', data.riskMetrics.sortinoRatio, '', '只计算下行波动 / ≥1.0 良好');
  html += renderRiskMetricCard('Calmar 比率', data.riskMetrics.calmarRatio, '', '年化收益÷最大回撤 / ≥0.5 可接受');
  html += renderRiskMetricCard('年化波动率', data.riskMetrics.annualizedVolatility, '%', '越低越稳定 / >30% 偏高');
  html += '</div>';

  // ---- Row 2: NAV Chart (left) + Drawdown Chart (right) ----
  html += '<div class="sh-chart-row">';
  html += '<div class="sh-chart-box">';
  html += '<div class="sh-chart-title">组合净值曲线 vs 基准（上证指数）</div>';
  html += '<canvas id="sh-nav-chart" class="sh-canvas" width="680" height="300"></canvas>';
  html += '</div>';
  html += '<div class="sh-chart-box">';
  html += '<div class="sh-chart-title">回撤曲线</div>';
  html += '<canvas id="sh-dd-chart" class="sh-canvas" width="680" height="300"></canvas>';
  html += '</div>';
  html += '</div>';

  // ---- Row 3: Monthly Heatmap (Canvas) ----
  html += '<div class="sh-chart-full">';
  html += '<div class="sh-chart-title">月度收益热力图</div>';
  html += '<canvas id="sh-heatmap" class="sh-canvas" width="900" height="280"></canvas>';
  html += '</div>';

  // ---- Row 4: Trade Stats (left) + Attribution (right) ----
  html += '<div class="sh-detail-row">';

  // Trade stats
  html += '<div class="sh-detail-box">';
  html += '<div class="sh-detail-title">交易统计</div>';
  html += '<div class="sh-stat-grid">';
  html += renderStatItem('总交易笔数', (data.tradeStats.totalTrades || 0));
  html += renderStatItem('胜率', data.tradeStats.winRate !== null ? data.tradeStats.winRate + '%' : '--', data.tradeStats.winRate >= 50 ? 'up' : 'down');
  html += renderStatItem('盈亏比', data.tradeStats.profitFactor !== null ? data.tradeStats.profitFactor : '--', data.tradeStats.profitFactor >= 1.2 ? 'up' : 'down');
  html += renderStatItem('平均盈利', '¥' + (data.tradeStats.avgWin || 0).toFixed(0), 'up');
  html += renderStatItem('平均亏损', '¥' + (data.tradeStats.avgLoss || 0).toFixed(0), 'down');
  html += renderStatItem('盈/亏金额比', data.tradeStats.avgWinLossRatio !== null ? data.tradeStats.avgWinLossRatio : '--');
  html += renderStatItem('换手率', data.tradeStats.turnoverRate !== null ? (data.tradeStats.turnoverRate * 100).toFixed(1) + '%' : '--');
  html += renderStatItem('总交易成本', '¥' + (data.tradeStats.totalCosts || 0).toFixed(2));
  html += renderStatItem('最佳单笔', data.tradeStats.bestTrade ? data.tradeStats.bestTrade.name + ' +¥' + data.tradeStats.bestTrade.pnl.toFixed(0) : '--', 'up');
  html += renderStatItem('最差单笔', data.tradeStats.worstTrade ? data.tradeStats.worstTrade.name + ' -¥' + Math.abs(data.tradeStats.worstTrade.pnl).toFixed(0) : '--', 'down');
  html += '</div>';
  html += '</div>';

  // Attribution summary
  html += '<div class="sh-detail-box">';
  html += '<div class="sh-detail-title">退出原因分布 & 板块表现</div>';

  // Exit reason breakdown
  var attr = data.attributionSummary || {};
  var rb = attr.reasonBreakdown || {};
  html += '<div class="sh-attrib-reasons">';
  html += '<span class="sh-reason-pill reason-stop">硬止损：' + (rb.stopLoss || 0) + '</span>';
  html += '<span class="sh-reason-pill reason-trail">移动止盈：' + (rb.trailingStop || 0) + '</span>';
  html += '<span class="sh-reason-pill reason-soft">软止损：' + (rb.softStop || 0) + '</span>';
  html += '<span class="sh-reason-pill reason-tp">止盈：' + (rb.takeProfit || 0) + '</span>';
  html += '<span class="sh-reason-pill reason-other">其他：' + (rb.other || 0) + '</span>';
  html += '</div>';

  // Consecutive losses
  html += '<div class="sh-consec-loss">';
  html += '当前连续亏损：<strong>' + (attr.consecutiveLosses || 0) + '</strong> 笔（历史最长：' + (attr.maxConsecutiveLosses || 0) + ' 笔）';
  html += '</div>';

  // Sector performance mini-table
  if (attr.sectorPerformance && attr.sectorPerformance.length > 0) {
    html += '<table class="sh-sector-table">';
    html += '<thead><tr><th>板块</th><th>笔数</th><th>胜</th><th>负</th><th>净盈亏</th></tr></thead><tbody>';
    for (var s = 0; s < Math.min(attr.sectorPerformance.length, 8); s++) {
      var sp = attr.sectorPerformance[s];
      html += '<tr>';
      html += '<td>' + sp.sector + '</td>';
      html += '<td>' + sp.count + '</td>';
      html += '<td style="color:#dc2626">' + sp.wins + '</td>';
      html += '<td style="color:#16a34a">' + sp.losses + '</td>';
      html += '<td style="color:' + (sp.netPnl >= 0 ? '#dc2626' : '#16a34a') + '">' + (sp.netPnl >= 0 ? '+' : '') + sp.netPnl.toFixed(0) + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
  }

  html += '</div>'; // end attribution box
  html += '</div>'; // end detail row

  // ---- Row 5: Verdict details ----
  html += '<div class="sh-verdict-detail">';
  html += '<div class="sh-detail-box" style="flex:1">';
  html += '<div class="sh-detail-title">当前风险因素</div>';
  if (data.masterControl && data.masterControl.reasons) {
    html += '<ul class="sh-reason-list">';
    for (var ri = 0; ri < data.masterControl.reasons.length; ri++) {
      html += '<li class="sh-reason-item">' + data.masterControl.reasons[ri] + '</li>';
    }
    html += '</ul>';
  }
  html += '</div>';
  html += '<div class="sh-detail-box" style="flex:1">';
  html += '<div class="sh-detail-title">恢复条件</div>';
  if (data.masterControl && data.masterControl.recoveryConditions && data.masterControl.recoveryConditions.length > 0) {
    html += '<ul class="sh-recovery-list">';
    for (var rc = 0; rc < data.masterControl.recoveryConditions.length; rc++) {
      html += '<li class="sh-recovery-item">' + data.masterControl.recoveryConditions[rc] + '</li>';
    }
    html += '</ul>';
  } else {
    html += '<p style="color:#64748b;font-size:13px;">无恢复条件 — 系统运行正常</p>';
  }
  html += '</div>';
  html += '</div>';

  return html;
}

// ---- Master Control Box ----

function renderMasterControlBox(mc) {
  if (!mc) return '<div class="sh-mc-box sh-mc-loading">正在加载策略体检数据...</div>';

  var verdictColors = {
    'ALLOW':    { bg: '#f0fdf4', border: '#16a34a', text: '#166534', dot: '#16a34a', label: '允许开仓' },
    'CAUTIOUS': { bg: '#fefce8', border: '#ca8a04', text: '#854d0e', dot: '#eab308', label: '谨慎开仓' },
    'REDUCE':   { bg: '#fff7ed', border: '#ea580c', text: '#9a3412', dot: '#f97316', label: '仅可减仓' },
    'BLOCK':    { bg: '#fef2f2', border: '#dc2626', text: '#991b1b', dot: '#ef4444', label: '禁止开仓' },
  };

  var vc = verdictColors[mc.verdict] || verdictColors['ALLOW'];

  var html = '';
  html += '<div class="sh-mc-box" style="background:' + vc.bg + ';border:2px solid ' + vc.border + ';border-radius:12px;padding:18px 24px;margin-bottom:20px;">';
  html += '<div class="sh-mc-top">';
  html += '<div class="sh-mc-left">';
  html += '<span class="sh-mc-dot" style="background:' + vc.dot + ';width:14px;height:14px;border-radius:50%;display:inline-block;margin-right:12px;box-shadow:0 0 8px ' + vc.dot + ';"></span>';
  html += '<span class="sh-mc-verdict" style="color:' + vc.text + ';font-size:22px;font-weight:700;">' + (mc.verdictLabel || vc.label) + '</span>';
  html += '<span class="sh-mc-confidence" style="margin-left:16px;color:' + vc.text + ';font-size:14px;opacity:0.8;">置信度：' + (mc.confidence || '--') + '%</span>';
  html += '</div>';
  html += '<div class="sh-mc-right">';
  html += '<span class="sh-mc-state" style="color:' + vc.text + ';font-size:14px;opacity:0.7;">' + (mc.marketStateHint || '') + '</span>';
  html += '</div>';
  html += '</div>';
  html += '<div class="sh-mc-reasons" style="margin-top:12px;color:' + vc.text + ';font-size:13px;">';
  if (mc.reasons && mc.reasons.length > 0) {
    html += '<strong>判定依据：</strong>' + mc.reasons.join('；');
  }
  html += '</div>';
  html += '</div>';

  return html;
}

// ---- Risk Metric Card ----

function renderRiskMetricCard(label, value, suffix, tooltip) {
  var valClass = 'sh-metric-neutral';
  var displayVal = '--';

  if (value !== null && value !== undefined) {
    displayVal = value;
    if (typeof value === 'number') {
      if (value >= 1) valClass = 'sh-metric-good';
      else if (value >= 0.5) valClass = 'sh-metric-ok';
      else if (value >= 0) valClass = 'sh-metric-warn';
      else valClass = 'sh-metric-bad';
    }
  }

  return '<div class="sh-metric-card" title="' + (tooltip || '') + '">' +
    '<div class="sh-metric-label">' + label + '</div>' +
    '<div class="sh-metric-value ' + valClass + '">' + displayVal + (suffix || '') + '</div>' +
    '</div>';
}

function renderStatItem(label, value, colorClass) {
  var cls = colorClass === 'up' ? 'sh-stat-up' : (colorClass === 'down' ? 'sh-stat-down' : '');
  return '<div class="sh-stat-item">' +
    '<span class="sh-stat-label">' + label + '</span>' +
    '<span class="sh-stat-value ' + cls + '">' + value + '</span>' +
    '</div>';
}

// ---- Canvas Drawing — post-render (called after innerHTML) ----

function drawShNavChart(data) {
  var canvas = document.getElementById('sh-nav-chart');
  if (!canvas || !data.navCurve || !data.navCurve.dates || data.navCurve.dates.length < 2) {
    if (canvas) { var ctx = canvas.getContext('2d'); ctx.fillStyle = '#94a3b8'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('暂无足够的NAV数据（至少需要2天）', canvas.width/2, canvas.height/2); }
    return;
  }

  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  var pad = { top: 20, right: 40, bottom: 40, left: 50 };
  var plotW = W - pad.left - pad.right;
  var plotH = H - pad.top - pad.bottom;

  ctx.clearRect(0, 0, W, H);

  var dates = data.navCurve.dates;
  var portfolioValues = data.navCurve.portfolioValues;
  var benchmarkValues = data.navCurve.benchmarkValues;

  // Find y-range
  var allVals = portfolioValues.concat(benchmarkValues);
  var yMin = Math.min.apply(null, allVals) * 0.98;
  var yMax = Math.max.apply(null, allVals) * 1.02;
  if (yMax - yMin < 100) { yMin -= 50; yMax += 50; }

  function x(idx) { return pad.left + (idx / (dates.length - 1)) * plotW; }
  function y(val) { return pad.top + plotH - ((val - yMin) / (yMax - yMin)) * plotH; }

  // Grid
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 0.5;
  for (var i = 0; i <= 4; i++) {
    var gy = pad.top + (plotH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, gy);
    ctx.lineTo(W - pad.right, gy);
    ctx.stroke();
  }

  // Y-axis labels
  ctx.fillStyle = '#64748b';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  for (i = 0; i <= 4; i++) {
    var val = yMin + (yMax - yMin) * (i / 4);
    ctx.fillText('¥' + val.toFixed(0), pad.left - 6, pad.top + plotH - (plotH / 4) * i + 4);
  }

  // X-axis labels (show ~5 date labels)
  ctx.textAlign = 'center';
  var labelStep = Math.max(1, Math.floor(dates.length / 5));
  for (i = 0; i < dates.length; i += labelStep) {
    ctx.fillText(dates[i].slice(5), x(i), H - pad.bottom + 16);
  }

  // Benchmark line (dashed, gray)
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(x(0), y(benchmarkValues[0]));
  for (i = 1; i < dates.length; i++) {
    ctx.lineTo(x(i), y(benchmarkValues[i]));
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Portfolio line (solid, gold)
  ctx.strokeStyle = '#b8942c';
  ctx.lineWidth = 2.5;
  ctx.shadowColor = 'rgba(184,148,44,0.3)';
  ctx.shadowBlur = 4;
  ctx.beginPath();
  ctx.moveTo(x(0), y(portfolioValues[0]));
  for (i = 1; i < dates.length; i++) {
    ctx.lineTo(x(i), y(portfolioValues[i]));
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Legend
  ctx.font = '11px sans-serif';
  ctx.fillStyle = '#b8942c';
  ctx.textAlign = 'left';
  ctx.fillRect(pad.left, 8, 12, 3);
  ctx.fillText('组合净值', pad.left + 18, 14);
  ctx.fillStyle = '#94a3b8';
  ctx.setLineDash([6, 3]);
  ctx.beginPath();
  ctx.moveTo(pad.left + 80, 10);
  ctx.lineTo(pad.left + 110, 10);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillText('基准（上证）', pad.left + 115, 14);
}

function drawShDDChart(data) {
  var canvas = document.getElementById('sh-dd-chart');
  if (!canvas || !data.drawdownCurve || !data.drawdownCurve.dates || data.drawdownCurve.dates.length < 2) {
    if (canvas) { var ctx = canvas.getContext('2d'); ctx.fillStyle = '#94a3b8'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('暂无足够的回撤数据', canvas.width/2, canvas.height/2); }
    return;
  }

  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  var pad = { top: 20, right: 40, bottom: 40, left: 50 };
  var plotW = W - pad.left - pad.right;
  var plotH = H - pad.top - pad.bottom;

  ctx.clearRect(0, 0, W, H);

  var dates = data.drawdownCurve.dates;
  var drawdowns = data.drawdownCurve.drawdowns;

  var yMin = Math.min.apply(null, drawdowns) - 1;
  yMin = Math.min(yMin, -10);
  var yMax = 2;

  function x(idx) { return pad.left + (idx / (dates.length - 1)) * plotW; }
  function y(val) { return pad.top + plotH - ((val - yMin) / (yMax - yMin)) * plotH; }

  // Grid
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 0.5;
  for (var i = 0; i <= 4; i++) {
    var gy = pad.top + (plotH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, gy);
    ctx.lineTo(W - pad.right, gy);
    ctx.stroke();
  }

  // Y-axis labels
  ctx.fillStyle = '#64748b';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  for (i = 0; i <= 4; i++) {
    var val = yMin + (yMax - yMin) * (i / 4);
    ctx.fillText(val.toFixed(1) + '%', pad.left - 6, pad.top + plotH - (plotH / 4) * i + 4);
  }

  // X-axis labels
  ctx.textAlign = 'center';
  var labelStep = Math.max(1, Math.floor(dates.length / 5));
  for (i = 0; i < dates.length; i += labelStep) {
    ctx.fillText(dates[i].slice(5), x(i), H - pad.bottom + 16);
  }

  // Zero line
  var zeroY = y(0);
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, zeroY);
  ctx.lineTo(W - pad.right, zeroY);
  ctx.stroke();

  // Drawdown area
  var grad = ctx.createLinearGradient(0, pad.top, 0, H - pad.bottom);
  grad.addColorStop(0, 'rgba(239,68,68,0.15)');
  grad.addColorStop(0.5, 'rgba(239,68,68,0.05)');
  grad.addColorStop(1, 'rgba(239,68,68,0.0)');

  ctx.beginPath();
  ctx.moveTo(x(0), zeroY);
  for (i = 0; i < dates.length; i++) {
    ctx.lineTo(x(i), y(drawdowns[i]));
  }
  ctx.lineTo(x(dates.length - 1), zeroY);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Drawdown line
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 2;
  ctx.shadowColor = 'rgba(239,68,68,0.2)';
  ctx.shadowBlur = 3;
  ctx.beginPath();
  ctx.moveTo(x(0), y(drawdowns[0]));
  for (i = 1; i < dates.length; i++) {
    ctx.lineTo(x(i), y(drawdowns[i]));
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Max drawdown annotation
  var maxDD = data.drawdownCurve.maxDrawdown;
  ctx.fillStyle = '#ef4444';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('最大回撤：' + maxDD.toFixed(2) + '%', pad.left, 18);
}

function drawShHeatmap(data) {
  var canvas = document.getElementById('sh-heatmap');
  if (!canvas || !data.monthlyHeatmap || !data.monthlyHeatmap.matrix || data.monthlyHeatmap.matrix.length === 0) {
    if (canvas) { var ctx = canvas.getContext('2d'); ctx.fillStyle = '#94a3b8'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('暂无足够的月度数据', canvas.width/2, canvas.height/2); }
    return;
  }

  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;

  ctx.clearRect(0, 0, W, H);

  var matrix = data.monthlyHeatmap.matrix;
  var monthLabels = data.monthlyHeatmap.months;

  // Layout
  var cellW = Math.min(64, Math.floor((W - 50) / 12));
  var cellH = Math.min(32, Math.floor((H - 30) / (matrix.length + 1)));
  var startX = Math.floor((W - cellW * 12) / 2);
  var startY = 10;

  // Month headers
  ctx.font = '10px sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.textAlign = 'center';
  for (var m = 0; m < 12; m++) {
    ctx.fillText(monthLabels[m], startX + m * cellW + cellW / 2, startY + 14);
  }

  // Rows
  for (var r = 0; r < matrix.length; r++) {
    var row = matrix[r];
    var rowY = startY + 20 + r * cellH;

    // Year label
    ctx.fillStyle = '#1e293b';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(row.year, startX - 10, rowY + cellH / 2 + 4);

    // Cells
    for (m = 0; m < 12; m++) {
      var val = row.returns[m];
      var cellX = startX + m * cellW;

      // Color
      if (val === null || val === undefined) {
        ctx.fillStyle = '#f1f5f9';
      } else if (val >= 0) {
        var intensity = Math.min(val / 5, 1); // max saturation at +5%
        var r_ = Math.round(220 - intensity * 180);
        var g_ = Math.round(38 - intensity * 10);
        var b_ = Math.round(38 - intensity * 10);
        ctx.fillStyle = 'rgb(' + r_ + ',' + g_ + ',' + b_ + ')';
      } else {
        intensity = Math.min(Math.abs(val) / 5, 1);
        r_ = Math.round(22 - intensity * 10);
        g_ = Math.round(163 - intensity * 120);
        b_ = Math.round(74 - intensity * 40);
        ctx.fillStyle = 'rgb(' + r_ + ',' + g_ + ',' + b_ + ')';
      }

      ctx.fillRect(cellX + 1, rowY + 1, cellW - 2, cellH - 2);

      // Cell text
      if (val !== null && val !== undefined) {
        ctx.fillStyle = Math.abs(val) > 2 ? '#fff' : '#334155';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText((val >= 0 ? '+' : '') + val.toFixed(1) + '%', cellX + cellW / 2, rowY + cellH / 2 + 4);
      }
    }
  }
}

// ---- Exports for script-as-module usage ----
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderStrategyHealth, drawShNavChart, drawShDDChart, drawShHeatmap };
}
