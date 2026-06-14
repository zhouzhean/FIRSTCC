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
      '<div style="font-size:48px;margin-bottom:16px;">[MACRO]</div>' +
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

  // ============ SECTION 1.5: Market Cycle Dashboard (P2) ============
  if (analysis.marketCycle) {
    html += renderMarketCycleDashboard(analysis.marketCycle);
  }

  // ============ SECTION 2: Risk Timeline + Signals ============
  html += '<div style="display:flex;gap:14px;margin-bottom:20px;flex-wrap:wrap;">';

  // Risk Timeline (5-day trend)
  html += '<div class="glass-card" style="flex:1.2;min-width:260px;padding:14px 18px;">';
  html += '<div style="font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#94a3b8;margin-bottom:10px;">Risk Trend (5-Day)</div>';
  if (analysis.riskTrend && analysis.riskTrend.length > 0) {
    html += renderRiskTimeline(analysis.riskTrend, rs.totalScore);
  } else {
    html += '<div style="font-size:11px;color:#94a3b8;text-align:center;padding:20px;">数据积累中 — 需多个交易日</div>';
  }
  html += '</div>';

  // Macro Signals
  if (rs.signals && rs.signals.length > 0) {
    html += '<div class="cm-signals glass-card" style="flex:0.8;min-width:240px;padding:14px 18px;">';
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

  html += '</div>'; // end flex row

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
    html += '<div style="font-size:32px;margin-bottom:12px;">[DATA]</div>';
    html += '<div style="font-size:13px;">相关性数据积累中 — 系统每日16:00自动记录美股→A股板块映射数据</div>';
    html += '<div style="font-size:11px;margin-top:6px;">需要至少5个交易日的数据才能计算Pearson相关系数</div>';
    html += '</div>';
  }
  html += '</div>'; // cm-correlation-section

  // ============ SECTION 4: Sector Outlook (sorted by impact strength) ============
  if (corr && corr.ready && corr.outlook && corr.outlook.length > 0) {
    // Sort outlook by impact: strong first, then by correlation strength
    var impactRank = { 'strong_positive': 5, 'positive': 4, 'neutral': 3, 'negative': 2, 'strong_negative': 1 };
    var sortedOutlook = corr.outlook.slice().sort(function(a, b) {
      var ia = impactRank[a.impact] || 3;
      var ib = impactRank[b.impact] || 3;
      if (ia !== ib) return ib - ia; // higher impact first
      return Math.abs(b.correlation || 0) - Math.abs(a.correlation || 0); // then by |R|
    });

    html += '<div class="cm-outlook-section">';
    html += '<div style="font-size:14px;font-weight:600;color:#1e293b;margin-bottom:12px;">A-Stock Sector Outlook (Next Day)</div>';
    html += '<div class="cm-outlook-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;">';
    for (var o = 0; o < sortedOutlook.length; o++) {
      html += renderOutlookCard(sortedOutlook[o]);
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

  // Unique IDs for toggle
  var infoId = 'cm-info-' + id;

  // Score display above gauge (HTML text, no Canvas font rendering issues)
  html += '<div style="text-align:center;padding:14px 16px 0;">';
  html += '<div style="font-size:10px;text-transform:uppercase;letter-spacing:3px;color:#94a3b8;margin-bottom:4px;">Risk Regime' +
    ' <span id="' + infoId + '-btn" style="cursor:pointer;display:inline-block;width:16px;height:16px;line-height:16px;border-radius:50%;background:#e2e8f0;color:#64748b;font-size:10px;font-weight:700;text-align:center;letter-spacing:0;vertical-align:1px;" ' +
    'onclick="var p=document.getElementById(\'' + infoId + '\');var b=document.getElementById(\'' + infoId + '-btn\');if(p.style.display===\'none\'){p.style.display=\'block\';b.textContent=\'x\';b.style.background=\'#b8942c\';b.style.color=\'#fff\';}else{p.style.display=\'none\';b.textContent=\'?\';b.style.background=\'#e2e8f0\';b.style.color=\'#64748b\';}">?</span>' +
    '</div>';
  html += '<div style="font-size:36px;font-weight:800;color:' + rs.riskColor + ';line-height:1.2;">' + (score >= 0 ? '+' : '') + score + '</div>';
  html += '<div style="font-size:13px;color:#475569;font-weight:500;">' + escHtml(rs.regimeLabel) + '</div>';

  // Expandable explanation panel
  html += '<div id="' + infoId + '" style="display:none;text-align:left;margin:8px 16px 0;padding:12px 14px;background:rgba(184,148,44,0.04);border:1px solid rgba(184,148,44,0.12);border-radius:8px;font-size:11px;color:#475569;line-height:1.7;">';
  html += '<div style="font-weight:700;color:#1e293b;margin-bottom:6px;">Risk Score = VIX x 40% + USD x 30% + TLT x 30%</div>';
  html += '<div style="margin-bottom:8px;">范围 -65 (恐慌) ~ +65 (风险偏好)</div>';
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 8px;font-size:10px;">';
  html += '<span style="color:#ef4444;">-65 ~ -40</span><span>Panic 恐慌</span>';
  html += '<span style="color:#f59e0b;">-40 ~ -15</span><span>Defense 防御</span>';
  html += '<span style="color:#94a3b8;">-15 ~ +15</span><span>Neutral 中性</span>';
  html += '<span style="color:#34d399;">+15 ~ +40</span><span>Bullish 看多</span>';
  html += '<span style="color:#10b981;">+40 ~ +65</span><span>Risk-On 激进</span>';
  html += '</div>';
  html += '<div style="margin-top:8px;font-size:10px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:6px;">';
  html += 'VIX↓=risk-on(+) · USD↓=risk-on(+) · TLT↑=risk-off(-)';
  html += '</div>';
  html += '</div>';

  html += '</div>';

  // Canvas gauge — arc only, no text, no needle
  html += '<canvas id="' + id + '" width="640" height="200" style="width:100%;max-width:320px;display:block;margin:0 auto;"></canvas>';

  // Inject canvas drawing script — glowing arc sweep only
  html += '<script>(function(){';
  html += 'var c=document.getElementById("' + id + '");';
  html += 'if(!c)return;';
  html += 'var dpr=window.devicePixelRatio||1;';
  html += 'var displayW=320,displayH=100;';
  html += 'c.width=displayW*dpr;c.height=displayH*dpr;c.style.width=displayW+"px";c.style.height=displayH+"px";';
  html += 'var ctx=c.getContext("2d");ctx.scale(dpr,dpr);';
  html += 'var w=displayW,h=displayH;';
  html += 'var cx=w/2,cy=h+30,r=120;';
  html += 'var startAngle=Math.PI,endAngle=0;';
  html += 'var targetNorm=' + normalized.toFixed(4) + ';';
  html += 'var riskColor="' + rs.riskColor + '";';

  // Color segments (background track)
  html += 'var segs=[';
  html += '{start:0,end:0.23,color:"#ef4444"},';
  html += '{start:0.23,end:0.42,color:"#f59e0b"},';
  html += '{start:0.42,end:0.58,color:"#94a3b8"},';
  html += '{start:0.58,end:0.77,color:"#34d399"},';
  html += '{start:0.77,end:1,color:"#10b981"}';
  html += '];';

  // Draw static background once
  html += 'function drawStatic(){';
  // Background track (subtle ring)
  html += 'ctx.beginPath();ctx.arc(cx,cy,r,startAngle,endAngle);';
  html += 'ctx.lineWidth=16;ctx.strokeStyle="rgba(0,0,0,0.05)";ctx.lineCap="round";ctx.stroke();';
  // Color segments
  html += 'for(var i=0;i<segs.length;i++){';
  html += 'var seg=segs[i];ctx.beginPath();';
  html += 'ctx.arc(cx,cy,r,startAngle+seg.start*Math.PI,startAngle+seg.end*Math.PI);';
  html += 'ctx.lineWidth=7;ctx.strokeStyle=seg.color;ctx.lineCap="butt";';
  html += 'ctx.globalAlpha=0.3;ctx.stroke();';
  html += '}ctx.globalAlpha=1;';
  // Tiny endpoint ticks
  html += 'ctx.fillStyle="#94a3b8";ctx.font="9px system-ui";ctx.textAlign="center";';
  html += 'ctx.fillText("-65",cx-r-10,cy+14);ctx.fillText("+65",cx+r+10,cy+14);';
  html += '}';
  html += 'drawStatic();';

  // Animate glowing progress arc
  html += 'function easeOutCubic(t){return 1-Math.pow(1-t,3);}';
  html += 'var startTime=null;var duration=800;';
  html += 'function animateProgress(ts){';
  html += 'if(!startTime)startTime=ts;';
  html += 'var progress=Math.min((ts-startTime)/duration,1);';
  html += 'var eased=easeOutCubic(progress);';
  html += 'var currentAngle=startAngle+eased*targetNorm*Math.PI;';
  // Redraw static bg, then glowing arc on top
  html += 'ctx.clearRect(0,0,w,h);';
  html += 'drawStatic();';
  // Outer glow arc
  html += 'ctx.save();';
  html += 'ctx.shadowColor=riskColor;ctx.shadowBlur=12;';
  html += 'ctx.beginPath();ctx.arc(cx,cy,r,startAngle,currentAngle);';
  html += 'ctx.lineWidth=8;ctx.strokeStyle=riskColor;ctx.lineCap="round";';
  html += 'ctx.globalAlpha=0.85;ctx.stroke();';
  html += 'ctx.restore();';
  // Inner bright arc
  html += 'ctx.beginPath();ctx.arc(cx,cy,r,startAngle,currentAngle);';
  html += 'ctx.lineWidth=3;ctx.strokeStyle=riskColor;ctx.lineCap="round";';
  html += 'ctx.globalAlpha=1;ctx.stroke();';
  html += 'if(progress<1){requestAnimationFrame(animateProgress);}';
  html += '}';
  html += 'requestAnimationFrame(animateProgress);';

  html += '})();</script>';

  // Legend
  html += '<div style="display:flex;justify-content:space-between;padding:0 24px 8px;font-size:9px;color:#94a3b8;">';
  html += '<span style="color:#ef4444;">Panic</span>';
  html += '<span style="color:#f59e0b;">Defense</span>';
  html += '<span style="color:#94a3b8;">Neutral</span>';
  html += '<span style="color:#34d399;">Bullish</span>';
  html += '<span style="color:#10b981;">Risk-On</span>';
  html += '</div>';

  return html;
}

// ============ RISK TIMELINE (5-day sparkline) ============

function renderRiskTimeline(riskTrend, currentScore) {
  if (!riskTrend || riskTrend.length === 0) return '';

  var html = '';
  var canvasId = 'risk-timeline-' + Date.now() + '-' + Math.floor(Math.random() * 10000);

  // Build the scores array (chronological) + append current score
  var scores = [];
  var dates = [];
  for (var i = 0; i < riskTrend.length; i++) {
    var pt = riskTrend[i];
    scores.push(pt.score != null ? pt.score : 0);
    dates.push(pt.date ? pt.date.slice(5) : '--');
  }
  // Always append current as last point
  scores.push(currentScore);
  dates.push('now');

  html += '<canvas id="' + canvasId + '" width="520" height="80" style="width:100%;height:80px;display:block;"></canvas>';
  html += '<script>(function(){';
  html += 'var c=document.getElementById("' + canvasId + '");';
  html += 'if(!c)return;';
  html += 'var dpr=window.devicePixelRatio||1;';
  html += 'var W=520,H=80;c.width=W*dpr;c.height=H*dpr;c.style.width=W+"px";c.style.height=H+"px";';
  html += 'var ctx=c.getContext("2d");ctx.scale(dpr,dpr);';
  html += 'var scores=' + JSON.stringify(scores) + ';';
  html += 'var dates=' + JSON.stringify(dates) + ';';
  html += 'var pad=30,topPad=12,botPad=20;';
  html += 'var plotW=W-2*pad,plotH=H-topPad-botPad;';

  // Find min/max
  html += 'var min=Math.min.apply(null,scores),max=Math.max.apply(null,scores);';
  html += 'var range=max-min||10;min-=range*0.2;max+=range*0.2;range=max-min;';

  // Helper functions
  html += 'function easeOutQuad(t){return 1-(1-t)*(1-t);}';

  // Draw grid lines (static, drawn immediately)
  html += 'ctx.strokeStyle="rgba(0,0,0,0.06)";ctx.lineWidth=1;';
  html += 'for(var g=0;g<3;g++){var gy=topPad+plotH*g/2;';
  html += 'ctx.beginPath();ctx.moveTo(pad,gy);ctx.lineTo(W-pad,gy);ctx.stroke();}';

  // Score labels on y-axis (static)
  html += 'ctx.textAlign="right";ctx.font="8px system-ui";';
  html += 'for(var g=0;g<3;g++){var gy=topPad+plotH*g/2;';
  html += 'var val=max-(max-min)*g/2;';
  html += 'ctx.fillStyle=val>=0?"#34d399":"#f87171";';
  html += 'ctx.fillText((val>=0?"+":"")+val.toFixed(0),pad-4,gy+3);}';

  // Date labels (static)
  html += 'ctx.fillStyle="#94a3b8";ctx.font="8px system-ui";ctx.textAlign="center";';
  html += 'for(var i=0;i<dates.length;i++){';
  html += 'var sx=pad+(i/(scores.length-1))*plotW;';
  html += 'ctx.fillText(dates[i],sx,topPad+plotH+13);';
  html += '}';

  // Animate line draw-in from left to right
  html += 'var animStart=null;var animDur=600;';
  html += 'function animateLine(ts){';
  html += 'if(!animStart)animStart=ts;';
  html += 'var p=Math.min((ts-animStart)/animDur,1);';
  html += 'var easedP=easeOutQuad(p);';
  html += 'var drawEnd=Math.max(1,Math.floor(easedP*scores.length));';

  // Clear the plot area (not the grid/labels)
  html += 'ctx.clearRect(pad,topPad-2,W-2*pad,plotH+4+botPad+2);';

  // Redraw grid
  html += 'ctx.strokeStyle="rgba(0,0,0,0.06)";ctx.lineWidth=1;';
  html += 'for(var g=0;g<3;g++){var gy=topPad+plotH*g/2;';
  html += 'ctx.beginPath();ctx.moveTo(pad,gy);ctx.lineTo(W-pad,gy);ctx.stroke();}';

  // Draw line segment
  html += 'ctx.beginPath();ctx.strokeStyle="#b8942c";ctx.lineWidth=2.5;ctx.lineJoin="round";';
  html += 'for(var i=0;i<drawEnd;i++){';
  html += 'var sx=pad+(i/(scores.length-1))*plotW;';
  html += 'var sy=topPad+plotH-(scores[i]-min)/range*plotH;';
  html += 'if(i===0)ctx.moveTo(sx,sy);else ctx.lineTo(sx,sy);';
  html += '}';
  html += 'ctx.stroke();';

  // Fill (clipped to same progressive area)
  html += 'if(drawEnd>=2){';
  html += 'ctx.lineTo(pad+(drawEnd-1)/(scores.length-1)*plotW,topPad+plotH);ctx.lineTo(pad,topPad+plotH);ctx.closePath();';
  html += 'var grad=ctx.createLinearGradient(0,topPad,0,topPad+plotH);';
  html += 'grad.addColorStop(0,"rgba(184,148,44,0.2)");grad.addColorStop(1,"rgba(184,148,44,0.02)");';
  html += 'ctx.fillStyle=grad;ctx.fill();';
  html += '}';

  // Draw dots
  html += 'for(var i=0;i<drawEnd;i++){';
  html += 'var sx=pad+(i/(scores.length-1))*plotW;';
  html += 'var sy=topPad+plotH-(scores[i]-min)/range*plotH;';
  html += 'var isCurrent=i===scores.length-1;';
  html += 'ctx.beginPath();ctx.arc(sx,sy,isCurrent?4:2.5,0,Math.PI*2);';
  html += 'ctx.fillStyle=isCurrent?"#b8942c":(scores[i]>=0?"#34d399":"#f87171");';
  html += 'ctx.fill();ctx.strokeStyle="#fff";ctx.lineWidth=1.5;ctx.stroke();';
  html += '}';

  // Redraw date labels
  html += 'ctx.fillStyle="#94a3b8";ctx.font="8px system-ui";ctx.textAlign="center";';
  html += 'for(var i=0;i<dates.length;i++){';
  html += 'var sx=pad+(i/(scores.length-1))*plotW;';
  html += 'ctx.fillText(dates[i],sx,topPad+plotH+13);';
  html += '}';

  html += 'if(p<1){requestAnimationFrame(animateLine);}';
  html += '}';
  html += 'requestAnimationFrame(animateLine);';

  html += '})();</script>';

  // Date labels below canvas
  html += '<div style="display:flex;justify-content:space-between;padding:0 30px;font-size:8px;color:#94a3b8;">';
  for (var d = 0; d < dates.length; d++) {
    html += '<span' + (d === dates.length - 1 ? ' style="color:#b8942c;font-weight:700;"' : '') + '>' + dates[d] + '</span>';
  }
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

  var signalLabel = row.signal === 'bullish' ? '[UP]' : (row.signal === 'bearish' ? '[DN]' : '--');

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
  html += signalLabel;
  html += strengthBadge;
  html += '</div>';
  html += '</div>';

  // Stats row
  html += '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;">';

  // R value
  html += '<div style="display:flex;align-items:baseline;gap:4px;">';
  html += '<span style="font-size:22px;font-weight:800;color:' + heatColor + ';">' + rSign + rVal.toFixed(2) + '</span>';
  html += '<span style="font-size:10px;color:#94a3b8;">R</span>';
  html += '</div>';

  // Bar
  html += '<div style="flex:1;min-width:50px;height:6px;border-radius:3px;background:rgba(0,0,0,0.05);overflow:hidden;">';
  html += '<div data-bar-width="' + barWidth + '" style="height:100%;width:0%;border-radius:3px;background:' + (rVal > 0 ? '#10b981' : '#ef4444') + ';transition:width 0.6s ease;"></div>';
  html += '</div>';

  // Latest US change (most actionable info)
  if (row.latestUSChange != null) {
    var usChgSign = row.latestUSChange >= 0 ? '+' : '';
    var usChgColor = row.latestUSChange >= 0 ? '#dc2626' : '#16a34a';
    html += '<div style="text-align:center;min-width:50px;">';
    html += '<div style="font-size:15px;font-weight:700;color:' + usChgColor + ';">' + usChgSign + row.latestUSChange.toFixed(1) + '%</div>';
    html += '<div style="font-size:8px;color:#94a3b8;">' + escHtml(row.etf) + '</div>';
    html += '</div>';
  }

  // Hit rate
  if (row.hitRate != null) {
    html += '<div style="text-align:right;">';
    html += '<div style="font-size:16px;font-weight:700;color:#334155;">' + row.hitRate + '%</div>';
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
    var trendLabel = recentR > (rVal || 0) ? 'up' : 'down';
    var trendColor = recentR > (rVal || 0) ? '#34d399' : '#f87171';
    html += '<div style="margin-top:8px;font-size:10px;color:#94a3b8;">';
    html += '5-day R: <span style="color:' + trendColor + ';font-weight:600;">' + (recentR >= 0 ? '+' : '') + recentR.toFixed(2) + '</span> ';
    html += '<span style="color:' + trendColor + ';">[' + trendLabel + ']</span> trending ' + (recentR > (rVal || 0) ? 'stronger' : 'weaker');
    html += '</div>';
  }

  html += '</div>';
  return html;
}

// ============ OUTLOOK CARD ============

function renderOutlookCard(outlook) {
  var impactColors = {
    'strong_positive': { bg: 'rgba(16,185,129,0.1)', border: 'rgba(16,185,129,0.3)', text: '#10b981', label: 'Strong Bullish', tag: '[++]' },
    'positive': { bg: 'rgba(52,211,153,0.08)', border: 'rgba(52,211,153,0.2)', text: '#34d399', label: 'Bullish', tag: '[+]' },
    'neutral': { bg: 'rgba(148,163,184,0.05)', border: 'rgba(148,163,184,0.15)', text: '#94a3b8', label: 'Neutral', tag: '[--]' },
    'negative': { bg: 'rgba(248,113,113,0.08)', border: 'rgba(248,113,113,0.2)', text: '#f87171', label: 'Bearish', tag: '[-]' },
    'strong_negative': { bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.3)', text: '#ef4444', label: 'Strong Bearish', tag: '[--]' },
  };
  var style = impactColors[outlook.impact] || impactColors['neutral'];
  var rVal = outlook.correlation || 0;
  var rSign = rVal >= 0 ? '+' : '';

  var html = '<div class="cm-outlook-card glass-card" style="padding:14px 16px;background:' + style.bg + ';border:1px solid ' + style.border + ';">';
  html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">';
  html += '<span style="font-size:13px;font-weight:600;color:#1e293b;">' + escHtml(outlook.aSector) + '</span>';
  html += '<span style="font-size:11px;font-weight:700;color:' + style.text + ';">' + style.tag + '</span>';
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

// ============ MARKET CYCLE DASHBOARD (P2) ============

function renderMarketCycleDashboard(cycle) {
  if (!cycle) return '';

  var cycleColors = {
    'bull': { bg: 'rgba(16,185,129,0.08)', border: 'rgba(16,185,129,0.3)', text: '#10b981', dot: '#10b981' },
    'slightly_bullish': { bg: 'rgba(52,211,153,0.06)', border: 'rgba(52,211,153,0.2)', text: '#34d399', dot: '#34d399' },
    'sideways': { bg: 'rgba(148,163,184,0.05)', border: 'rgba(148,163,184,0.15)', text: '#64748b', dot: '#94a3b8' },
    'slightly_bearish': { bg: 'rgba(245,158,11,0.06)', border: 'rgba(245,158,11,0.2)', text: '#f59e0b', dot: '#f59e0b' },
    'bear': { bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.25)', text: '#ef4444', dot: '#ef4444' },
  };
  var style = cycleColors[cycle.cycle] || cycleColors['sideways'];

  // Confidence bar
  var confPct = cycle.confidence || 50;

  var html = '<div class="cm-cycle-dashboard glass-card" style="margin-bottom:20px;padding:18px 20px;background:' + style.bg + ';border:1px solid ' + style.border + ';">';

  // Header row
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">';
  html += '<div style="display:flex;align-items:center;gap:10px;">';
  html += '<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:' + style.dot + ';box-shadow:0 0 8px ' + style.dot + '80;"></span>';
  html += '<span style="font-size:15px;font-weight:700;color:#1e293b;">A股市场周期</span>';
  html += '<span style="font-size:18px;font-weight:800;color:' + style.text + ';">' + escHtml(cycle.label || '未知') + '</span>';
  html += '</div>';
  html += '<div style="text-align:right;">';
  html += '<div style="font-size:10px;color:#94a3b8;letter-spacing:1px;">建议最多</div>';
  html += '<div style="font-size:22px;font-weight:800;color:' + style.text + ';">' + (cycle.suggestedMaxPositions || 3) + ' 只</div>';
  html += '</div>';
  html += '</div>';

  // Confidence + multiplier row
  html += '<div style="display:flex;gap:10px;margin-bottom:12px;">';
  html += '<div style="flex:1;background:rgba(255,255,255,0.6);border-radius:8px;padding:10px 14px;">';
  html += '<div style="font-size:10px;color:#94a3b8;margin-bottom:3px;">周期置信度</div>';
  html += '<div style="height:6px;border-radius:3px;background:rgba(0,0,0,0.06);overflow:hidden;margin-bottom:4px;">';
  html += '<div data-bar-width="' + confPct + '" style="height:100%;width:0%;border-radius:3px;background:' + style.text + ';transition:width 0.6s;"></div>';
  html += '</div>';
  html += '<div style="font-size:11px;font-weight:600;color:' + style.text + ';">' + confPct + '/100</div>';
  html += '</div>';
  html += '<div style="flex:1;background:rgba(255,255,255,0.6);border-radius:8px;padding:10px 14px;">';
  html += '<div style="font-size:10px;color:#94a3b8;margin-bottom:3px;">仓位乘数</div>';
  html += '<div style="font-size:20px;font-weight:800;color:' + style.text + ';">×' + (cycle.suggestedMultiplier || 0.6).toFixed(1) + '</div>';
  html += '</div>';
  html += '</div>';

  // 3-dimension breakdown
  var details = cycle.details || {};
  html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">';

  // MA Alignment
  var ma = details.ma || {};
  var maLabel = ma.alignment === 'bullish' ? '多头排列 [UP]' : (ma.alignment === 'bearish' ? '空头排列 [DN]' : (ma.alignment === 'slightly_bullish' ? '短期偏多 [^]' : (ma.alignment === 'slightly_bearish' ? '短期偏空 [v]' : '均线纠缠 [--]')));
  var maColor = ma.alignment === 'bullish' ? '#10b981' : (ma.alignment === 'bearish' ? '#ef4444' : (ma.alignment === 'slightly_bullish' ? '#34d399' : (ma.alignment === 'slightly_bearish' ? '#f59e0b' : '#94a3b8')));
  html += '<div style="background:rgba(255,255,255,0.5);border-radius:6px;padding:10px;text-align:center;">';
  html += '<div style="font-size:9px;color:#94a3b8;letter-spacing:1px;margin-bottom:4px;">均线排列</div>';
  html += '<div style="font-size:12px;font-weight:700;color:' + maColor + ';">' + maLabel + '</div>';
  if (ma.values && ma.values.ma20) {
    html += '<div style="font-size:10px;color:#94a3b8;margin-top:2px;">MA20 ≈ ' + ma.values.ma20.toFixed(0) + '</div>';
  }
  html += '</div>';

  // Volume trend
  var vol = details.volume || {};
  var volLabel = vol.trend === 'expanding' ? '放量' : (vol.trend === 'contracting' ? '缩量' : '平稳');
  var volColor = vol.trend === 'expanding' ? '#8b5cf6' : (vol.trend === 'contracting' ? '#f59e0b' : '#94a3b8');
  html += '<div style="background:rgba(255,255,255,0.5);border-radius:6px;padding:10px;text-align:center;">';
  html += '<div style="font-size:9px;color:#94a3b8;letter-spacing:1px;margin-bottom:4px;">成交量</div>';
  html += '<div style="font-size:12px;font-weight:700;color:' + volColor + ';">' + volLabel + '</div>';
  html += '<div style="font-size:10px;color:#94a3b8;margin-top:2px;">近5日vs20日均量</div>';
  html += '</div>';

  // Market breadth
  var breadth = details.breadth || {};
  var brLabel = breadth.breadth === 'wide_high' ? '强势 [UP]' : (breadth.breadth === 'narrow_low' ? '弱势 [DN]' : '中性 [--]');
  var brColor = breadth.breadth === 'wide_high' ? '#10b981' : (breadth.breadth === 'narrow_low' ? '#ef4444' : '#94a3b8');
  html += '<div style="background:rgba(255,255,255,0.5);border-radius:6px;padding:10px;text-align:center;">';
  html += '<div style="font-size:9px;color:#94a3b8;letter-spacing:1px;margin-bottom:4px;">市场宽度</div>';
  html += '<div style="font-size:12px;font-weight:700;color:' + brColor + ';">' + brLabel + '</div>';
  html += '<div style="font-size:10px;color:#94a3b8;margin-top:2px;">' + (breadth.positionInRange != null ? '位置 ' + (breadth.positionInRange * 100).toFixed(0) + '%' : '--') + '</div>';
  html += '</div>';

  html += '</div>'; // 3-col grid

  // Factor breakdowns (if available)
  if (cycle.factors && cycle.factors.length > 0) {
    html += '<div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:4px;">';
    for (var f = 0; f < cycle.factors.length; f++) {
      var factor = cycle.factors[f];
      var isNeg = factor.indexOf('-') >= 0;
      html += '<span style="font-size:9px;padding:2px 8px;border-radius:10px;background:' + (isNeg ? '#fef2f2' : '#f0fdf4') + ';color:' + (isNeg ? '#dc2626' : '#16a34a') + ';border:1px solid ' + (isNeg ? '#fecaca' : '#bbf7d0') + ';">' + escHtml(factor) + '</span>';
    }
    html += '</div>';
  }

  if (!cycle.dataAvailable) {
    html += '<div style="margin-top:8px;font-size:10px;color:#94a3b8;text-align:center;">历史K线数据不足（需20日以上），使用默认震荡判断</div>';
  }

  html += '</div>';
  return html;
}

// ============ UTILS ============

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
