/**
 * cross-market.js — 跨市场分析面板 (Apple Glassmorphism UI)
 * renderCrossMarket(data, mode, analysis) 生成完整的跨市场分析 HTML
 *
 * Sections:
 *   1. Risk Gauge — 半圆仪表盘，显示宏观风险状态
 *   2. Component Cards — VIX / 美元 / 美债 贡献分解
 *   3. Correlation Matrix — US ETF → A股板块 相关性矩阵
 *   4. Sector Outlook — A股板块次日预判
 */
function renderCrossMarket(data, mode, analysis) {
  var isPDF = mode === 'pdf';
  if (!analysis || !analysis.riskState) {
    return '<div style="text-align:center;padding:60px 20px;color:#94a3b8;">' +
      '<div style="font-size:48px;margin-bottom:16px;">&#x1F52C;</div>' +
      '<div style="font-size:15px;font-weight:500;">跨市场分析数据加载中...</div>' +
      '<div style="font-size:12px;margin-top:8px;">需要美股宏观数据 (VXX/UUP/TLT)</div>' +
      '</div>';
  }

  var rs = analysis.riskState;
  var corr = analysis.correlation;
  var html = '';

  // ============ SECTION 1: Risk Gauge + Recommendation ============
  html += '<div class="cm-risk-section" style="display:flex;gap:20px;margin-bottom:24px;flex-wrap:wrap;">';

  // Left: Gauge card
  html += '<div class="cm-gauge-card glass-card" style="flex:1;min-width:300px;">';
  html += renderRiskGauge(rs);
  html += '</div>';

  // Right: Recommendation + Components
  html += '<div class="cm-reco-column" style="flex:1;min-width:280px;display:flex;flex-direction:column;gap:14px;">';

  // Recommendation
  html += '<div class="cm-reco-card glass-card" style="padding:18px 20px;">';
  html += '<div style="font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#94a3b8;margin-bottom:8px;">Position Recommendation</div>';
  html += '<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:8px;">';
  html += '<span class="cm-position-badge" style="font-size:36px;font-weight:700;color:' + rs.riskColor + ';">' + rs.positionSize + '%</span>';
  html += '<span style="font-size:14px;color:#334155;">建议仓位</span>';
  html += '</div>';
  html += '<div style="font-size:18px;font-weight:600;color:#1e293b;margin-bottom:4px;">' + escHtml(rs.recommendation.action) + '策略</div>';
  html += '<div style="font-size:12px;color:#64748b;line-height:1.6;">' + escHtml(rs.recommendation.desc) + '</div>';

  // Tiered allocation table
  html += '<div style="margin-top:10px;padding:8px 10px;background:rgba(184,148,44,0.04);border-radius:6px;">';
  html += '<div style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Tiered Allocation 分层仓位</div>';
  html += '<div style="font-size:10px;color:#64748b;line-height:1.8;">';
  html += '<div><span style="color:#b8942c;font-weight:600;">强买</span> 85+:25% | 75+:20% | 65+:15%</div>';
  html += '<div><span style="color:#64748b;font-weight:600;">普通买</span> 65+:12% | 55+:8%</div>';
  html += '<div style="margin-top:2px;"><span style="color:#94a3b8;">信号加成:</span> 每多1个信号 +2% · <span style="color:#94a3b8;">风险乘数:</span> ' + (rs.positionSize || '--') + '%</div>';
  html += '</div></div>';

  html += '</div>';

  // Component breakdown cards
  html += '<div class="cm-components" style="display:flex;gap:10px;flex-wrap:wrap;">';
  if (rs.components) {
    for (var c = 0; c < rs.components.length; c++) {
      var comp = rs.components[c];
      var compColor = comp.score > 0 ? '#34d399' : (comp.score < 0 ? '#f87171' : '#94a3b8');
      var compBg = comp.score > 0 ? 'rgba(52,211,153,0.08)' : (comp.score < 0 ? 'rgba(248,113,113,0.08)' : 'rgba(148,163,184,0.05)');
      html += '<div class="cm-comp-chip glass-card" style="flex:1;min-width:90px;padding:12px 14px;text-align:center;background:' + compBg + ';">';
      html += '<div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#64748b;margin-bottom:4px;">' + escHtml(comp.label) + '</div>';
      html += '<div style="font-size:16px;font-weight:700;color:#1e293b;">' + escHtml(comp.value) + '</div>';
      html += '<div style="font-size:11px;font-weight:600;color:' + compColor + ';margin-top:2px;">' + (comp.score >= 0 ? '+' : '') + comp.score + '分</div>';
      html += '<div style="font-size:9px;color:#94a3b8;margin-top:2px;">权重' + comp.weight + '</div>';
      html += '</div>';
    }
  }
  html += '</div>'; // cm-components

  html += '</div>'; // cm-reco-column
  html += '</div>'; // cm-risk-section

  // ============ SECTION 2: Risk Signals ============
  if (rs.signals && rs.signals.length > 0) {
    html += '<div class="cm-signals glass-card" style="padding:14px 18px;margin-bottom:20px;">';
    html += '<div style="font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#94a3b8;margin-bottom:10px;">Macro Signals</div>';
    for (var s = 0; s < rs.signals.length; s++) {
      var sig = rs.signals[s];
      var sigColors = { positive: '#34d399', neutral: '#94a3b8', warning: '#f59e0b', danger: '#f87171' };
      var sigColor = sigColors[sig.level] || '#94a3b8';
      html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:12px;color:#334155;">' +
        '<span style="color:' + sigColor + ';font-size:14px;">●</span>' +
        escHtml(sig.text) +
        '</div>';
    }
    html += '</div>';
  }

  // ============ SECTION 3: Correlation Matrix ============
  html += '<div class="cm-correlation-section" style="margin-bottom:20px;">';
  html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">';
  html += '<div style="font-size:14px;font-weight:600;color:#1e293b;">Cross-Market Correlation Matrix</div>';
  if (corr && corr.ready) {
    html += '<div style="font-size:10px;color:#94a3b8;letter-spacing:1px;">' + corr.dataPoints + ' DAYS · PEARSON R</div>';
  } else if (corr) {
    html += '<div style="font-size:10px;color:#f59e0b;letter-spacing:1px;">BUILDING DATA — NEED ' + corr.daysNeeded + ' MORE DAYS</div>';
  }
  html += '</div>';

  if (corr && corr.ready && corr.matrix && corr.matrix.length > 0) {
    html += '<div class="cm-matrix-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;">';
    for (var m = 0; m < corr.matrix.length; m++) {
      var row = corr.matrix[m];
      html += renderCorrelationRow(row);
    }
    html += '</div>';
  } else {
    html += '<div class="glass-card" style="padding:40px;text-align:center;color:#94a3b8;">';
    html += '<div style="font-size:32px;margin-bottom:12px;">&#x1F4CA;</div>';
    html += '<div style="font-size:13px;">相关性数据积累中 — 系统每日16:00自动记录美股→A股板块映射数据</div>';
    html += '<div style="font-size:11px;margin-top:6px;">需要至少5个交易日的数据才能计算Pearson相关系数</div>';
    html += '</div>';
  }
  html += '</div>'; // cm-correlation-section

  // ============ SECTION 4: Sector Outlook ============
  if (corr && corr.ready && corr.outlook && corr.outlook.length > 0) {
    html += '<div class="cm-outlook-section">';
    html += '<div style="font-size:14px;font-weight:600;color:#1e293b;margin-bottom:12px;">A-Stock Sector Outlook (Next Day)</div>';
    html += '<div class="cm-outlook-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;">';
    for (var o = 0; o < corr.outlook.length; o++) {
      var outlook = corr.outlook[o];
      html += renderOutlookCard(outlook);
    }
    html += '</div></div>';
  }

  return html;
}

// ============ RISK GAUGE (Canvas) ============

function renderRiskGauge(rs) {
  var id = 'cm-gauge-' + Date.now() + '-' + Math.floor(Math.random() * 10000);
  var score = rs.totalScore || 0;
  var minScore = rs.scoreRange ? rs.scoreRange.min : -65;
  var maxScore = rs.scoreRange ? rs.scoreRange.max : 65;

  // Normalize score to [0, 1] for gauge angle
  var normalized = (score - minScore) / (maxScore - minScore);
  normalized = Math.max(0, Math.min(1, normalized));
  var angle = normalized * Math.PI; // 0 to 180 degrees

  var html = '';

  // Regime label
  html += '<div style="text-align:center;padding:16px 16px 0;">';
  html += '<div style="font-size:10px;text-transform:uppercase;letter-spacing:3px;color:#94a3b8;margin-bottom:6px;">Risk Regime</div>';
  html += '<div style="font-size:22px;font-weight:700;color:#1e293b;">' + escHtml(rs.regimeLabel) + '</div>';
  html += '<div style="font-size:13px;color:' + rs.riskColor + ';font-weight:600;">Score: ' + (score >= 0 ? '+' : '') + score + '</div>';
  html += '</div>';

  // Canvas gauge
  html += '<canvas id="' + id + '" width="320" height="170" style="width:100%;max-width:320px;display:block;margin:0 auto;"></canvas>';

  // Inject canvas drawing script
  html += '<script>(function(){';
  html += 'var c=document.getElementById("' + id + '");';
  html += 'if(!c)return;';
  html += 'var ctx=c.getContext("2d");';
  html += 'var w=c.width,h=c.height;';
  html += 'var cx=w/2,cy=h-10,r=130;';
  html += 'var startAngle=Math.PI,endAngle=0;';

  // Background arc (glass track)
  html += 'ctx.beginPath();ctx.arc(cx,cy,r,startAngle,endAngle);';
  html += 'ctx.lineWidth=18;ctx.strokeStyle="rgba(0,0,0,0.05)";ctx.lineCap="round";ctx.stroke();';

  // Gradient arc segments
  html += 'var segs=[';
  // Red zone (panic: -65 to -35)
  html += '{start:0,end:0.23,color:"#ef4444"},';
  // Orange zone (risk_off: -35 to -10)
  html += '{start:0.23,end:0.42,color:"#f59e0b"},';
  // Yellow zone (neutral: -10 to +10)
  html += '{start:0.42,end:0.58,color:"#94a3b8"},';
  // Green zone (bullish: +10 to +35)
  html += '{start:0.58,end:0.77,color:"#34d399"},';
  // Bright green zone (risk_on: +35 to +65)
  html += '{start:0.77,end:1,color:"#10b981"}';
  html += '];';

  // Draw each segment
  html += 'for(var i=0;i<segs.length;i++){';
  html += 'var seg=segs[i];';
  html += 'ctx.beginPath();';
  html += 'ctx.arc(cx,cy,r,startAngle+seg.start*Math.PI,startAngle+seg.end*Math.PI);';
  html += 'ctx.lineWidth=6;ctx.strokeStyle=seg.color;ctx.lineCap="butt";';
  html += 'ctx.globalAlpha=0.5;ctx.stroke();';
  html += '}';
  html += 'ctx.globalAlpha=1;';

  // Active needle
  html += 'var needleAngle=startAngle+' + normalized.toFixed(4) + '*Math.PI;';
  html += 'var nx=cx+Math.cos(needleAngle)*r,ny=cy+Math.sin(needleAngle)*r;';

  // Needle shadow
  html += 'ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(nx,ny);';
  html += 'ctx.lineWidth=3;ctx.strokeStyle="rgba(0,0,0,0.5)";ctx.stroke();';

  // Needle
  html += 'ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(nx,ny);';
  html += 'ctx.lineWidth=2.5;ctx.strokeStyle="' + rs.riskColor + '";ctx.lineCap="round";ctx.stroke();';

  // Center dot
  html += 'ctx.beginPath();ctx.arc(cx,cy,5,0,2*Math.PI);';
  html += 'ctx.fillStyle="#1e293b";ctx.fill();';
  html += 'ctx.beginPath();ctx.arc(cx,cy,3,0,2*Math.PI);';
  html += 'ctx.fillStyle="' + rs.riskColor + '";ctx.fill();';

  // Labels
  html += 'ctx.fillStyle="#6b7280";ctx.font="9px system-ui";ctx.textAlign="center";';
  html += 'ctx.fillText("-65",cx-r-8,cy+14);ctx.fillText("+65",cx+r+8,cy+14);';

  html += '})();</script>';

  // Legend
  html += '<div style="display:flex;justify-content:space-between;padding:0 24px 16px;font-size:9px;color:#94a3b8;">';
  html += '<span style="color:#ef4444;">Panic</span>';
  html += '<span style="color:#f59e0b;">Defense</span>';
  html += '<span style="color:#94a3b8;">Neutral</span>';
  html += '<span style="color:#34d399;">Bullish</span>';
  html += '<span style="color:#10b981;">Risk-On</span>';
  html += '</div>';

  return html;
}

// ============ CORRELATION ROW ============

function renderCorrelationRow(row) {
  var rVal = row.correlation || 0;
  var rAbs = Math.abs(rVal);
  var rSign = rVal >= 0 ? '+' : '';

  // Color based on correlation strength and direction
  var heatColor;
  if (rAbs >= 0.7) heatColor = rVal > 0 ? '#10b981' : '#ef4444';
  else if (rAbs >= 0.4) heatColor = rVal > 0 ? '#34d399' : '#f87171';
  else if (rAbs >= 0.2) heatColor = rVal > 0 ? '#fbbf24' : '#f59e0b';
  else heatColor = '#6b7280';

  var strengthBadge = '';
  if (row.strength === 'strong') strengthBadge = '<span style="font-size:9px;padding:2px 8px;border-radius:10px;background:rgba(16,185,129,0.15);color:#10b981;">STRONG</span>';
  else if (row.strength === 'moderate') strengthBadge = '<span style="font-size:9px;padding:2px 8px;border-radius:10px;background:rgba(245,158,11,0.15);color:#f59e0b;">MODERATE</span>';
  else strengthBadge = '<span style="font-size:9px;padding:2px 8px;border-radius:10px;background:rgba(107,114,128,0.15);color:#94a3b8;">WEAK</span>';

  var signalEmoji = row.signal === 'bullish' ? '&#x1F7E2;' : (row.signal === 'bearish' ? '&#x1F534;' : '&#x26AA;');

  // Correlation bar width
  var barWidth = Math.min(100, Math.round(rAbs * 100));
  var barColor = rAbs >= 0.7 ? 'linear-gradient(90deg,' + heatColor + ',' + heatColor + '80)' :
    (rAbs >= 0.4 ? 'linear-gradient(90deg,' + heatColor + ',' + heatColor + '40)' : 'linear-gradient(90deg,' + heatColor + ',' + heatColor + '20)');

  var html = '<div class="cm-corr-row glass-card" style="padding:14px 16px;">';

  // Header: ETF → A Sector
  html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">';
  html += '<div style="display:flex;align-items:center;gap:8px;">';
  html += '<span style="font-size:13px;font-weight:700;color:#1e293b;">' + escHtml(row.etf) + '</span>';
  html += '<span style="color:#94a3b8;font-size:11px;">→</span>';
  html += '<span style="font-size:13px;font-weight:600;color:#334155;">' + escHtml(row.aSector) + '</span>';
  html += '</div>';
  html += '<div style="display:flex;align-items:center;gap:6px;">';
  html += signalEmoji;
  html += strengthBadge;
  html += '</div>';
  html += '</div>';

  // Stats row
  html += '<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">';

  // R value
  html += '<div style="display:flex;align-items:baseline;gap:4px;">';
  html += '<span style="font-size:24px;font-weight:800;color:' + heatColor + ';">' + rSign + rVal.toFixed(2) + '</span>';
  html += '<span style="font-size:10px;color:#94a3b8;">R</span>';
  html += '</div>';

  // Bar
  html += '<div style="flex:1;min-width:60px;height:6px;border-radius:3px;background:rgba(0,0,0,0.05);overflow:hidden;">';
  html += '<div style="height:100%;width:' + barWidth + '%;border-radius:3px;background:' + (rVal > 0 ? '#10b981' : '#ef4444') + ';transition:width 0.6s ease;"></div>';
  html += '</div>';

  // Hit rate
  if (row.hitRate != null) {
    html += '<div style="text-align:right;">';
    html += '<div style="font-size:17px;font-weight:700;color:#334155;">' + row.hitRate + '%</div>';
    html += '<div style="font-size:9px;color:#94a3b8;">HIT RATE</div>';
    html += '</div>';
  }

  // Data points
  html += '<div style="text-align:right;">';
  html += '<div style="font-size:12px;font-weight:600;color:#64748b;">N=' + row.dataPoints + '</div>';
  html += '<div style="font-size:9px;color:#94a3b8;">SAMPLES</div>';
  html += '</div>';

  html += '</div>'; // stats row

  // Recent trend
  if (row.recentCorrelation != null) {
    var recentR = row.recentCorrelation;
    var trendIcon = recentR > (rVal || 0) ? '&#x2197;' : '&#x2198;';
    var trendColor = recentR > (rVal || 0) ? '#34d399' : '#f87171';
    html += '<div style="margin-top:8px;font-size:10px;color:#94a3b8;">';
    html += '5-day R: <span style="color:' + trendColor + ';font-weight:600;">' + (recentR >= 0 ? '+' : '') + recentR.toFixed(2) + '</span> ';
    html += '<span style="color:' + trendColor + ';">' + trendIcon + '</span> trending ' + (recentR > (rVal || 0) ? 'stronger' : 'weaker');
    html += '</div>';
  }

  html += '</div>';
  return html;
}

// ============ OUTLOOK CARD ============

function renderOutlookCard(outlook) {
  var impactColors = {
    'strong_positive': { bg: 'rgba(16,185,129,0.1)', border: 'rgba(16,185,129,0.3)', text: '#10b981', label: 'Strong Bullish', icon: '&#x1F7E2;' },
    'positive': { bg: 'rgba(52,211,153,0.08)', border: 'rgba(52,211,153,0.2)', text: '#34d399', label: 'Bullish', icon: '&#x1F7E1;' },
    'neutral': { bg: 'rgba(148,163,184,0.05)', border: 'rgba(148,163,184,0.15)', text: '#94a3b8', label: 'Neutral', icon: '&#x26AA;' },
    'negative': { bg: 'rgba(248,113,113,0.08)', border: 'rgba(248,113,113,0.2)', text: '#f87171', label: 'Bearish', icon: '&#x1F7E0;' },
    'strong_negative': { bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.3)', text: '#ef4444', label: 'Strong Bearish', icon: '&#x1F534;' },
  };
  var style = impactColors[outlook.impact] || impactColors['neutral'];
  var rVal = outlook.correlation || 0;
  var rSign = rVal >= 0 ? '+' : '';

  var html = '<div class="cm-outlook-card glass-card" style="padding:14px 16px;background:' + style.bg + ';border:1px solid ' + style.border + ';">';
  html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">';
  html += '<span style="font-size:13px;font-weight:600;color:#1e293b;">' + escHtml(outlook.aSector) + '</span>';
  html += '<span style="font-size:16px;">' + style.icon + '</span>';
  html += '</div>';
  html += '<div style="display:flex;justify-content:space-between;align-items:center;">';
  html += '<span style="font-size:10px;color:#64748b;">via ' + escHtml(outlook.etf) + '</span>';
  html += '<span style="font-size:12px;font-weight:700;color:' + style.text + ';">' + style.label + '</span>';
  html += '</div>';
  html += '<div style="margin-top:6px;font-size:10px;color:#94a3b8;">Correlation: <span style="color:' + style.text + ';">' + rSign + rVal.toFixed(2) + '</span></div>';
  html += '</div>';
  return html;
}

// ============ CSS ============

function renderCrossMarketCSS() {
  return [
    '.cm-dashboard {',
    '  background: #f8f9fb;',
    '  min-height: 100%;',
    '  padding: 24px;',
    '  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", system-ui, sans-serif;',
    '  color: #334155;',
    '}',
    '.cm-dashboard * { box-sizing: border-box; }',
    '',
    '/* Glass Card — light glassmorphism */',
    '.glass-card {',
    '  background: rgba(255,255,255,0.75);',
    '  backdrop-filter: blur(16px) saturate(180%);',
    '  -webkit-backdrop-filter: blur(16px) saturate(180%);',
    '  border: 1px solid rgba(0,0,0,0.06);',
    '  border-radius: 16px;',
    '  box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.04);',
    '  transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1.2);',
    '}',
    '.glass-card:hover {',
    '  background: rgba(255,255,255,0.92);',
    '  border-color: rgba(99,102,241,0.18);',
    '  transform: translateY(-2px);',
    '  box-shadow: 0 8px 30px rgba(0,0,0,0.08), 0 2px 8px rgba(99,102,241,0.06);',
    '}',
    '',
    '/* Correlation Row Special */',
    '.cm-corr-row.glass-card:hover {',
    '  border-color: rgba(99,102,241,0.3);',
    '  box-shadow: 0 6px 24px rgba(0,0,0,0.08), 0 2px 8px rgba(99,102,241,0.1);',
    '}',
    '',
    '/* Mobile */',
    '@media (max-width: 720px) {',
    '  .cm-dashboard { padding: 14px; }',
    '  .cm-risk-section { flex-direction: column !important; }',
    '  .cm-gauge-card { min-width: unset !important; }',
    '  .cm-matrix-grid { grid-template-columns: 1fr !important; }',
    '  .cm-outlook-grid { grid-template-columns: 1fr 1fr !important; }',
    '  .cm-correlation-section .cm-corr-row { padding: 12px !important; }',
    '}',
    '@media (max-width: 400px) {',
    '  .cm-outlook-grid { grid-template-columns: 1fr !important; }',
    '  .cm-components { flex-direction: column !important; }',
    '}',
  ].join('\n');
}

// ============ UTILS ============

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
