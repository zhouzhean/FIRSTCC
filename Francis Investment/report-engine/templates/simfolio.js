/**
 * simfolio.js — Simfolio 模拟交易看板模板
 * renderSimfolio(data, mode) 生成完整的模拟交易仪表板HTML
 */
function renderSimfolio(data, mode) {
  // Fetch data from API - but for template rendering, data is passed in
  // The data structure comes from the simfolio API
  var isPDF = mode === 'pdf';
  var bg = isPDF ? '#0a1628' : '#f8f9fb';
  var cardBg = isPDF ? '#0f1f3a' : '#ffffff';
  var text = isPDF ? '#c9d1d9' : '#1e293b';
  var muted = isPDF ? '#8b949e' : '#64748b';
  var accent = isPDF ? '#c9a84c' : '#b8942c';
  var up = isPDF ? '#f85149' : '#dc2626';
  var down = isPDF ? '#3fb950' : '#16a34a';

  // Build HTML
  var html = '';

  // Section header
  if (!isPDF) {
    html += '<div class="section-header" style="display:flex;align-items:center;gap:10px;margin-bottom:20px;">';
    html += '<span style="font-size:24px;">💰</span>';
    html += '<h2 style="margin:0;font-size:18px;font-weight:700;color:' + text + ';">Simfolio 模拟交易看板</h2>';
    html += '<span style="font-size:11px;color:' + muted + ';">初始资金 ¥100,000 · T+1 · 真实费率</span>';
    html += '</div>';
  } else {
    html += '<h2 style="color:' + accent + ';">八、Simfolio 模拟交易看板</h2>';
  }

  // Check if simfolio data is embedded
  var sf = data._simfolio;
  if (!sf || !sf.snapshot) {
    html += '<div class="callout" style="background:' + cardBg + ';border:1px solid ' + (isPDF ? '#1e3050' : '#e2e5eb') + ';border-radius:8px;padding:24px;text-align:center;">';
    html += '<p style="font-size:32px;margin:0 0 8px;">📊</p>';
    html += '<p style="color:' + muted + ';margin:0;">模拟交易数据将在量化分析运行后自动生成</p>';
    html += '<p style="color:' + muted + ';font-size:12px;margin:8px 0 0;">点击工具栏 "⚡ 运行分析" 启动全流程</p>';
    html += '</div>';
    return html;
  }

  var snap = sf.snapshot;
  var stats = sf.stats || {};
  var tradeHistory = sf.tradeHistory || [];
  var dailyNav = sf.dailyNav || [];

  // ==== Asset Overview Cards ====
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px;">';

  // Total value
  html += '<div style="background:' + cardBg + ';border-radius:8px;padding:16px;border:1px solid ' + (isPDF ? '#1e3050' : '#e2e5eb') + ';">';
  html += '<div style="font-size:11px;color:' + muted + ';margin-bottom:4px;">总资产</div>';
  html += '<div style="font-size:22px;font-weight:700;color:' + text + ';">¥' + formatMoney(snap.totalValue) + '</div>';
  html += '<div style="font-size:12px;color:' + (snap.totalReturn >= 0 ? up : down) + ';">' + (snap.totalReturn >= 0 ? '+' : '') + snap.totalReturn.toFixed(2) + '%</div>';
  html += '</div>';

  // Cash
  html += '<div style="background:' + cardBg + ';border-radius:8px;padding:16px;border:1px solid ' + (isPDF ? '#1e3050' : '#e2e5eb') + ';">';
  html += '<div style="font-size:11px;color:' + muted + ';margin-bottom:4px;">现金</div>';
  html += '<div style="font-size:22px;font-weight:700;color:' + text + ';">¥' + formatMoney(snap.cash) + '</div>';
  html += '<div style="font-size:12px;color:' + muted + ';">' + (snap.totalValue > 0 ? (snap.cash / snap.totalValue * 100).toFixed(0) + '% 仓位现金' : '') + '</div>';
  html += '</div>';

  // Alpha
  html += '<div style="background:' + cardBg + ';border-radius:8px;padding:16px;border:1px solid ' + (isPDF ? '#1e3050' : '#e2e5eb') + ';">';
  html += '<div style="font-size:11px;color:' + muted + ';margin-bottom:4px;">超额收益 α</div>';
  html += '<div style="font-size:22px;font-weight:700;color:' + (snap.alpha >= 0 ? up : down) + ';">' + (snap.alpha >= 0 ? '+' : '') + snap.alpha.toFixed(2) + '%</div>';
  html += '<div style="font-size:12px;color:' + muted + ';">基准: ' + (snap.benchmarkReturn >= 0 ? '+' : '') + snap.benchmarkReturn.toFixed(2) + '%</div>';
  html += '</div>';

  // Stats
  html += '<div style="background:' + cardBg + ';border-radius:8px;padding:16px;border:1px solid ' + (isPDF ? '#1e3050' : '#e2e5eb') + ';">';
  html += '<div style="font-size:11px;color:' + muted + ';margin-bottom:4px;">统计</div>';
  html += '<div style="font-size:13px;color:' + text + ';line-height:1.8;">';
  html += '交易: <b>' + (stats.totalTrades || 0) + '</b> 笔';
  if (stats.winRate != null) html += ' | 胜率: <b style="color:' + (stats.winRate >= 50 ? up : down) + ';">' + stats.winRate + '%</b>';
  if (stats.maxDrawdown != null) html += '<br>最大回撤: <b style="color:' + (isPDF ? '#f85149' : '#dc2626') + ';">' + stats.maxDrawdown.toFixed(2) + '%</b>';
  if (stats.sharpeRatio != null) html += ' | 夏普: <b>' + stats.sharpeRatio.toFixed(2) + '</b>';
  html += '</div>';
  html += '</div>';

  html += '</div>'; // end overview cards

  // ==== NAV Chart ====
  if (dailyNav.length >= 2) {
    html += renderNavChart(dailyNav, isPDF);
  }

  // ==== Positions Table ====
  if (snap.positions && snap.positions.length > 0) {
    html += '<h3 style="font-size:14px;color:' + text + ';margin:20px 0 10px;">📌 当前持仓</h3>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:12px;color:' + text + ';">';
    html += '<thead><tr style="border-bottom:2px solid ' + accent + ';">';
    html += '<th style="padding:8px;text-align:left;">股票</th><th style="padding:8px;text-align:right;">成本价</th><th style="padding:8px;text-align:right;">现价</th><th style="padding:8px;text-align:right;">股数</th><th style="padding:8px;text-align:right;">市值</th><th style="padding:8px;text-align:right;">盈亏</th><th style="padding:8px;text-align:left;">入场理由</th>';
    html += '</tr></thead><tbody>';

    for (var i = 0; i < snap.positions.length; i++) {
      var p = snap.positions[i];
      var pnlColor = p.pnl >= 0 ? up : down;
      html += '<tr style="border-bottom:1px solid ' + (isPDF ? '#1e3050' : '#eef0f4') + ';">';
      html += '<td style="padding:8px;"><b>' + escHtml(p.name) + '</b><br><span style="color:' + muted + ';font-size:11px;">' + p.code + '</span></td>';
      html += '<td style="padding:8px;text-align:right;">¥' + p.avgCost.toFixed(2) + '</td>';
      html += '<td style="padding:8px;text-align:right;">¥' + p.currentPrice.toFixed(2) + '</td>';
      html += '<td style="padding:8px;text-align:right;">' + p.shares + '</td>';
      html += '<td style="padding:8px;text-align:right;">¥' + formatMoney(p.marketValue) + '</td>';
      html += '<td style="padding:8px;text-align:right;color:' + pnlColor + ';">' + (p.pnl >= 0 ? '+' : '') + formatMoney(p.pnl) + '<br><span style="font-size:11px;">' + (p.pnlPct >= 0 ? '+' : '') + p.pnlPct.toFixed(2) + '%</span></td>';
      html += '<td style="padding:8px;font-size:11px;color:' + muted + ';max-width:200px;">' + escHtml(p.entryReason) + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
  }

  // ==== Trade History ====
  if (tradeHistory.length > 0) {
    html += '<h3 style="font-size:14px;color:' + text + ';margin:20px 0 10px;">📋 交易记录（最近20条）</h3>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:11px;color:' + text + ';">';
    html += '<thead><tr style="border-bottom:2px solid ' + accent + ';">';
    html += '<th style="padding:6px;text-align:left;">日期</th><th style="padding:6px;text-align:left;">时间</th><th style="padding:6px;">方向</th><th style="padding:6px;text-align:left;">股票</th><th style="padding:6px;text-align:right;">价格</th><th style="padding:6px;text-align:right;">股数</th><th style="padding:6px;text-align:right;">金额</th><th style="padding:6px;text-align:right;">盈亏</th><th style="padding:6px;text-align:left;">原因</th>';
    html += '</tr></thead><tbody>';

    var recent = tradeHistory.slice(-20).reverse();
    for (var j = 0; j < recent.length; j++) {
      var t = recent[j];
      var isBuy = t.action === 'buy';
      html += '<tr style="border-bottom:1px solid ' + (isPDF ? '#1e3050' : '#eef0f4') + ';">';
      html += '<td style="padding:6px;">' + t.date + '</td>';
      html += '<td style="padding:6px;color:' + muted + ';">' + (t.time || '--:--:--') + '</td>';
      html += '<td style="padding:6px;color:' + (isBuy ? up : down) + ';font-weight:600;">' + (isBuy ? '买入' : '卖出') + '</td>';
      html += '<td style="padding:6px;">' + escHtml(t.name) + ' <span style="color:' + muted + ';">' + t.code + '</span></td>';
      html += '<td style="padding:6px;text-align:right;">¥' + t.price.toFixed(2) + '</td>';
      html += '<td style="padding:6px;text-align:right;">' + t.shares + '</td>';
      html += '<td style="padding:6px;text-align:right;">¥' + formatMoney(t.amount) + '</td>';
      html += '<td style="padding:6px;text-align:right;color:' + (t.action === 'sell' && t.pnl >= 0 ? up : (t.action === 'sell' ? down : muted)) + ';">' + (t.action === 'sell' ? (t.pnl >= 0 ? '+' : '') + formatMoney(t.pnl) + '<br><span style="font-size:10px;">' + (t.pnlPct >= 0 ? '+' : '') + t.pnlPct.toFixed(2) + '%</span>' : '-') + '</td>';
      html += '<td style="padding:6px;font-size:10px;color:' + muted + ';max-width:180px;">' + escHtml(t.reason || '') + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
  }

  return html;
}

// ---- Helpers ----

function formatMoney(val) {
  if (val == null) return '0';
  return val.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function renderNavChart(dailyNav, isPDF) {
  var maxNav = 0;
  var minNav = Infinity;
  for (var i = 0; i < dailyNav.length; i++) {
    if (dailyNav[i].nav > maxNav) maxNav = dailyNav[i].nav;
    if (dailyNav[i].nav < minNav) minNav = dailyNav[i].nav;
  }
  var range = maxNav - minNav || 1;
  var height = 200;
  var width = dailyNav.length > 1 ? (dailyNav.length - 1) * 60 + 40 : 100;
  var padding = 10;

  // Render simple SVG chart
  var html = '<h3 style="font-size:14px;color:' + (isPDF ? '#c9d1d9' : '#1e293b') + ';margin:20px 0 10px;">📈 净值曲线</h3>';
  html += '<svg width="100%" viewBox="0 0 ' + (width + padding * 2) + ' ' + (height + padding * 2) + '" style="background:' + (isPDF ? '#080e18' : '#fafbfc') + ';border-radius:8px;">';

  // Gridlines
  for (var g = 0; g <= 4; g++) {
    var gy = padding + (height * g / 4);
    html += '<line x1="' + padding + '" y1="' + gy + '" x2="' + (width + padding) + '" y2="' + gy + '" stroke="' + (isPDF ? '#1e3050' : '#e5e7eb') + '" stroke-width="1"/>';
  }

  // NAV line
  var points = '';
  var benchPoints = '';
  var labels = '';
  for (var i = 0; i < dailyNav.length; i++) {
    var x = padding + (i * (width / Math.max(dailyNav.length - 1, 1)));
    var y = padding + height - ((dailyNav[i].nav - minNav) / range * height);
    points += (i === 0 ? '' : ' ') + x + ',' + y;

    // Benchmark
    if (dailyNav[i].benchmarkReturn != null) {
      var benchNav = 100000 * (1 + dailyNav[i].benchmarkReturn / 100);
      var benchMax = 100000 * (1 + Math.max(dailyNav[dailyNav.length - 1].return_ || 0, dailyNav[dailyNav.length - 1].benchmarkReturn || 0) / 100);
      var benchMin = 100000 * (1 + Math.min(dailyNav[0].return_ || 0, dailyNav[0].benchmarkReturn || 0) / 100);
      var benchRange = benchMax - benchMin || 1;
      var by = padding + height - ((benchNav - benchMin) / benchRange * height);
      benchPoints += (i === 0 ? '' : ' ') + x + ',' + by;
    }

    // Date label every 5 days
    if (i % 5 === 0 || i === dailyNav.length - 1) {
      labels += '<text x="' + x + '" y="' + (height + padding * 2 + 12) + '" text-anchor="middle" font-size="10" fill="' + (isPDF ? '#8b949e' : '#94a3b8') + '">' + dailyNav[i].date.slice(5) + '</text>';
    }
  }

  html += '<polyline points="' + points + '" fill="none" stroke="#b8942c" stroke-width="2.5" stroke-linejoin="round"/>';
  if (benchPoints) {
    html += '<polyline points="' + benchPoints + '" fill="none" stroke="#8b949e" stroke-width="1.5" stroke-dasharray="4,3" stroke-linejoin="round"/>';
  }

  // Legend
  html += '<text x="' + (padding + 10) + '" y="' + (padding + 16) + '" font-size="11" fill="#b8942c">——  Simfolio</text>';
  if (benchPoints) {
    html += '<text x="' + (padding + 10) + '" y="' + (padding + 32) + '" font-size="11" fill="#8b949e">- -  上证指数</text>';
  }

  html += labels;
  html += '</svg>';

  return html;
}

// P1-5: Holdings health mini-cards — per-holding quality analysis
function renderHoldingsHealthCards(healthCards, isPDF) {
  if (!healthCards || healthCards.length === 0) return '';
  var cardBg = isPDF ? '#0f1f3a' : '#ffffff';
  var text = isPDF ? '#c9d1d9' : '#1e293b';
  var muted = isPDF ? '#8b949e' : '#64748b';
  var accent = isPDF ? '#c9a84c' : '#b8942c';

  var html = '<h3 style="font-size:14px;color:' + text + ';margin:20px 0 10px;">💊 持仓健康度</h3>';
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;margin-bottom:16px;">';

  for (var i = 0; i < healthCards.length; i++) {
    var h = healthCards[i];
    // Distance to stop color
    var stopColor = h.distanceToStopPct > 10 ? '#22c55e' : (h.distanceToStopPct > 4 ? '#f59e0b' : '#ef4444');
    var stopBg = h.distanceToStopPct > 10 ? '#f0fdf4' : (h.distanceToStopPct > 4 ? '#fffbeb' : '#fef2f2');
    // P&L color
    var pnlColor = h.pnlPct >= 0 ? '#dc2626' : '#16a34a';

    html += '<div style="background:' + cardBg + ';border-radius:8px;padding:14px;border:1px solid ' + (isPDF ? '#1e3050' : '#e2e5eb') + ';">';

    // Header row: stock name + recommendation tag
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">';
    html += '<div>';
    html += '<span style="font-size:13px;font-weight:700;color:' + text + ';">' + escHtml(h.name) + '</span>';
    html += '<span style="font-size:10px;color:' + muted + ';margin-left:6px;">' + h.code + '</span>';
    html += '</div>';
    html += '<span style="font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600;background:' + h.recommendationColor + '15;color:' + h.recommendationColor + ';border:1px solid ' + h.recommendationColor + '40;">' + h.recommendationLabel + '</span>';
    html += '</div>';

    // P&L + holding days
    html += '<div style="display:flex;gap:12px;margin-bottom:8px;">';
    html += '<div style="flex:1;">';
    html += '<div style="font-size:10px;color:' + muted + ';">盈亏</div>';
    html += '<div style="font-size:16px;font-weight:700;color:' + pnlColor + ';">' + (h.pnlPct >= 0 ? '+' : '') + h.pnlPct.toFixed(2) + '%</div>';
    html += '</div>';
    html += '<div style="flex:1;">';
    html += '<div style="font-size:10px;color:' + muted + ';">持仓天数</div>';
    html += '<div style="font-size:14px;font-weight:600;color:' + text + ';">' + h.holdingDays + ' 天</div>';
    html += '</div>';
    html += '<div style="flex:1;">';
    html += '<div style="font-size:10px;color:' + muted + ';">成本→现价</div>';
    html += '<div style="font-size:12px;font-weight:600;color:' + text + ';">¥' + h.avgCost.toFixed(2) + ' → ¥' + h.currentPrice.toFixed(2) + '</div>';
    html += '</div>';
    html += '</div>';

    // Stop-loss progress bar
    html += '<div style="margin-bottom:6px;">';
    html += '<div style="display:flex;justify-content:space-between;font-size:10px;color:' + muted + ';margin-bottom:2px;">';
    html += '<span>距止损线</span><span style="font-weight:600;color:' + stopColor + ';">' + h.distanceToStopPct.toFixed(1) + '%</span>';
    html += '</div>';
    html += '<div style="height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden;">';
    var barPct = Math.min(100, Math.max(0, (h.distanceToStopPct + 8) / 20 * 100)); // map -8% to 0, 12% to 100
    html += '<div style="height:100%;width:' + barPct.toFixed(0) + '%;background:' + stopColor + ';border-radius:3px;transition:width 0.5s;"></div>';
    html += '</div>';
    html += '<div style="text-align:right;font-size:9px;color:' + muted + ';margin-top:2px;">止损价 ¥' + h.stopPrice.toFixed(2) + '</div>';
    html += '</div>';

    html += '</div>';
  }

  html += '</div>';
  return html;
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
