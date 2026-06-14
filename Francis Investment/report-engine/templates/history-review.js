// History Review Unified Template — v2.9
// Replaces: weekend-analysis.js, weekend-verification.js, inline renderHistoryReviewFull() in app.js
// 7-row single-page dashboard with Canvas visualizations

function renderHistoryReviewCSS() {
  return [
    '.hr-wrapper { max-width:1100px; margin:0 auto; padding:16px 20px 40px; font-family: -apple-system, "Microsoft YaHei", sans-serif; }',
    '.hr-hero { background:linear-gradient(135deg,#0f172a,#1e293b); border-radius:12px; padding:20px 28px; margin-bottom:16px; color:#f1f5f9; display:flex; align-items:center; gap:20px; flex-wrap:wrap; }',
    '.hr-hero-stat { text-align:center; min-width:80px; }',
    '.hr-hero-stat-val { font-size:24px; font-weight:700; }',
    '.hr-hero-stat-lbl { font-size:10px; color:#94a3b8; margin-top:2px; }',
    '.hr-badge { display:inline-block; padding:3px 12px; border-radius:12px; font-size:10px; font-weight:700; letter-spacing:0.5px; }',
    '.hr-badge-ok { background:#166534; color:#86efac; }',
    '.hr-badge-run { background:#854d0e; color:#fde68a; animation:hr-pulse 1.5s infinite; }',
    '.hr-badge-idle { background:#334155; color:#94a3b8; }',
    '@keyframes hr-pulse { 0%,100% { opacity:1; } 50% { opacity:0.5; } }',
    '.hr-pulse-dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:#22c55e; margin-right:4px; animation:hr-pulse 1.2s infinite; }',
    '.hr-section { background:#fff; border-radius:10px; padding:18px 22px; margin-bottom:14px; border:1px solid #e5e7eb; }',
    '.hr-section-title { font-size:14px; font-weight:700; color:#1e293b; margin:0 0 14px; display:flex; align-items:center; gap:8px; }',
    '.hr-cards-4 { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:12px; }',
    '.hr-mini-card { background:#f8fafc; border-radius:8px; padding:14px; border:1px solid #e5e7eb; }',
    '.hr-mini-card-title { font-size:11px; color:#64748b; margin-bottom:6px; }',
    '.hr-mini-card-val { font-size:20px; font-weight:700; color:#1e293b; }',
    '.hr-mini-card-sub { font-size:10px; color:#94a3b8; margin-top:2px; }',
    '.hr-sim-cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:10px; }',
    '.hr-sim-card { background:#f8fafc; border-radius:8px; padding:12px; border:1px solid #e5e7eb; }',
    '.hr-sim-card-date { font-size:11px; color:#64748b; }',
    '.hr-sim-card-sim { font-size:18px; font-weight:700; }',
    '.hr-sim-card-label { font-size:10px; color:#94a3b8; }',
    '.hr-sim-card-future { font-size:12px; font-weight:600; margin-top:6px; }',
    '.hr-sim-up { color:#16a34a; }',
    '.hr-sim-down { color:#dc2626; }',
    '.hr-gauge-wrap { display:flex; align-items:center; gap:20px; flex-wrap:wrap; }',
    '.hr-crisis-dims { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:8px; flex:1; }',
    '.hr-crisis-dim { background:#f8fafc; border-radius:6px; padding:10px; }',
    '.hr-crisis-dim-name { font-size:10px; color:#64748b; }',
    '.hr-crisis-dim-bar { height:6px; border-radius:3px; margin:4px 0; background:#e5e7eb; position:relative; }',
    '.hr-crisis-dim-fill { height:100%; border-radius:3px; transition:width 0.3s; }',
    '.hr-crisis-dim-score { font-size:12px; font-weight:600; }',
    '.hr-factor-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:10px; }',
    '.hr-factor-card { background:#f8fafc; border-radius:8px; padding:12px; border:1px solid #e5e7eb; }',
    '.hr-factor-name { font-size:12px; font-weight:600; color:#1e293b; }',
    '.hr-factor-hitrate { font-size:22px; font-weight:700; }',
    '.hr-factor-trend { font-size:10px; }',
    '.hr-badge-hot { color:#16a34a; background:#f0fdf4; padding:2px 8px; border-radius:8px; font-size:10px; font-weight:700; }',
    '.hr-badge-cold { color:#dc2626; background:#fef2f2; padding:2px 8px; border-radius:8px; font-size:10px; font-weight:700; }',
    '.hr-badge-stable { color:#94a3b8; background:#f8fafc; padding:2px 8px; border-radius:8px; font-size:10px; }',
    '.hr-combo-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }',
    '.hr-combo-synergy { }',
    '.hr-combo-conflict { }',
    '.hr-combo-item { background:#f8fafc; border-radius:6px; padding:10px; margin-bottom:6px; border-left:3px solid #e5e7eb; }',
    '.hr-combo-item.green { border-left-color:#22c55e; }',
    '.hr-combo-item.red { border-left-color:#ef4444; }',
    '.hr-combo-item.gold { border-left-color:#f59e0b; background:#fffbeb; }',
    '.hr-discovery-new { animation:hr-slide-in 0.4s ease-out; }',
    '@keyframes hr-slide-in { from { opacity:0; transform:translateX(20px); } to { opacity:1; transform:translateX(0); } }',
    '.hr-verif-history { display:flex; align-items:flex-end; gap:6px; height:120px; }',
    '.hr-verif-bar-wrap { display:flex; flex-direction:column; align-items:center; flex:1; }',
    '.hr-verif-bar { width:100%; max-width:40px; border-radius:3px 3px 0 0; min-height:3px; transition:height 0.3s; }',
    '.hr-verif-bar-label { font-size:9px; color:#94a3b8; margin-top:4px; }',
    '.hr-date-chips { display:flex; flex-wrap:wrap; gap:6px; }',
    '.hr-date-chip { padding:4px 12px; border-radius:14px; font-size:11px; cursor:pointer; border:1px solid #e5e7eb; background:#f8fafc; transition:all 0.15s; }',
    '.hr-date-chip:hover { border-color:#6366f1; color:#4f46e5; }',
    '.hr-date-chip.active { background:#6366f1; color:#fff; border-color:#6366f1; }',
    '.hr-subtle { font-size:10px; color:#94a3b8; }',
    '.hr-verif-tag { display:inline-block; padding:1px 6px; border-radius:4px; font-size:9px; font-weight:600; }',
    '.hr-verif-tag.verified { background:#f0fdf4; color:#166534; }',
    '.hr-verif-tag.metadata { background:#f1f5f9; color:#64748b; }',
    '@media (max-width:720px) {',
    '  .hr-combo-grid { grid-template-columns:1fr; }',
    '  .hr-cards-4 { grid-template-columns:1fr 1fr; }',
    '  .hr-hero { padding:14px 16px; gap:12px; }',
    '  .hr-hero-stat-val { font-size:18px; }',
    '}',
  ].join('\n');
}

// Main entry point — called from app.js
function renderHistoryReviewDashboard(data) {
  if (!data || !data.ok) {
    return '<div style="text-align:center;padding:60px;color:#94a3b8;">' +
      '<div style="font-size:48px;margin-bottom:16px;">--</div>' +
      '<div style="font-size:15px;">历史复盘引擎尚未启动</div>' +
      '<div style="font-size:12px;margin-top:8px;">每日盘后和工作日自动运行，周末深度分析将在周六启动</div>' +
      '</div>';
  }

  var html = '<div class="hr-wrapper">';

  // Row 0: Status Hero
  html += _renderHero(data);

  // Row 1: Daily Insights
  if (data.dailyInsights) {
    html += _renderDailyInsights(data.dailyInsights);
  }

  // Row 2: Historical Similarity
  if (data.similarity && data.similarity.length > 0) {
    html += _renderSimilarity(data.similarity, data.lastDeep);
  }

  // Row 3: Crisis Warning
  if (data.crisisWarning) {
    html += _renderCrisisGauge(data.crisisWarning);
  }

  // Row 4: Sector Rotation
  if (data.sectorRotation && data.sectorRotation.matrix) {
    html += _renderSectorRotation(data.sectorRotation);
  }

  // Row 5: Factor Effectiveness
  if (data.factorPerformance && data.factorPerformance.length > 0) {
    html += _renderFactorGrid(data.factorPerformance);
  }

  // Row 6: Factor Combos + Discoveries
  html += _renderCombosAndDiscoveries(data);

  // Row 7: Verification & Archive
  html += _renderVerificationArchive(data);

  html += '</div>';
  return html;
}

// ============ Row 0: Hero Bar ============

function _renderHero(data) {
  var statusClass = 'hr-badge-idle';
  var statusText = 'IDLE';
  var phase = data.mode || 'full';

  if (phase === 'daily') {
    statusClass = 'hr-badge-ok';
    statusText = 'DAILY OK';
  } else if (phase === 'deep') {
    statusClass = 'hr-badge-ok';
    statusText = 'DEEP OK';
  }

  var html = '<div class="hr-hero">';
  html += '<div class="hr-hero-stat">';
  html += '<div class="hr-hero-stat-val"><span class="hr-badge ' + statusClass + '">[ ' + statusText + ' ]</span></div>';
  html += '<div class="hr-hero-stat-lbl">引擎状态</div>';
  html += '</div>';

  html += '<div class="hr-hero-stat">';
  html += '<div class="hr-hero-stat-val">' + (data.lastDaily ? _fmtDate(data.lastDaily) : '--') + '</div>';
  html += '<div class="hr-hero-stat-lbl">最后日复盘</div>';
  html += '</div>';

  html += '<div class="hr-hero-stat">';
  html += '<div class="hr-hero-stat-val">' + (data.lastDeep ? _fmtDate(data.lastDeep) : '--') + '</div>';
  html += '<div class="hr-hero-stat-lbl">最后深析</div>';
  html += '</div>';

  html += '<div class="hr-hero-stat">';
  var verifCount = data.verificationHistory ? data.verificationHistory.history.length : 0;
  html += '<div class="hr-hero-stat-val">' + verifCount + '</div>';
  html += '<div class="hr-hero-stat-lbl">已验证周</div>';
  html += '</div>';

  html += '<div class="hr-hero-stat" style="flex:1;min-width:200px;">';
  html += '<canvas id="hr-verif-sparkline" style="width:100%;height:40px;"></canvas>';
  html += '</div>';

  html += '</div>';
  return html;
}

function _fmtDate(isoStr) {
  if (!isoStr) return '--';
  var d = new Date(isoStr);
  return (d.getMonth()+1) + '/' + d.getDate() + ' ' +
    d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}

// ============ Row 1: Daily Insights ============

function _renderDailyInsights(daily) {
  var html = '<div class="hr-section">';
  html += '<div class="hr-section-title">[DAILY] 每日洞察</div>';
  html += '<div class="hr-cards-4">';

  // Card 1: Factor Verification
  if (daily.factorVerification && daily.factorVerification.available) {
    var fv = daily.factorVerification;
    html += '<div class="hr-mini-card">';
    html += '<div class="hr-mini-card-title">因子信号验证</div>';
    html += '<div class="hr-mini-card-val">' + fv.correctCount + '/' + fv.totalCount + '</div>';
    html += '<div class="hr-mini-card-sub">方向正确率 ' + (fv.accuracy * 100).toFixed(0) + '%</div>';
    html += '</div>';
  } else {
    html += '<div class="hr-mini-card">';
    html += '<div class="hr-mini-card-title">因子信号验证</div>';
    html += '<div class="hr-mini-card-val" style="font-size:14px;color:#94a3b8;">等待数据</div>';
    html += '</div>';
  }

  // Card 2: Quick Similarity
  var qs = daily.quickSimilarity;
  if (qs && qs.length > 0) {
    var topQs = qs[0];
    html += '<div class="hr-mini-card">';
    html += '<div class="hr-mini-card-title">快速相似度 #1</div>';
    html += '<div class="hr-mini-card-val">' + (topQs.similarity * 100).toFixed(0) + '%</div>';
    html += '<div class="hr-mini-card-sub">' + topQs.startDate + ' ~ ' + topQs.endDate + ' (' + topQs.simLabel + ')</div>';
    if (topQs.future5d) {
      var cls5d = topQs.future5d.total > 0 ? 'hr-sim-up' : 'hr-sim-down';
      html += '<div class="hr-mini-card-sub ' + cls5d + '">后续5日: ' + (topQs.future5d.total > 0 ? '+' : '') + topQs.future5d.total.toFixed(2) + '%</div>';
    }
    html += '</div>';
  } else {
    html += '<div class="hr-mini-card">';
    html += '<div class="hr-mini-card-title">快速相似度</div>';
    html += '<div class="hr-mini-card-val" style="font-size:14px;color:#94a3b8;">等待数据</div>';
    html += '</div>';
  }

  // Card 3: Market state
  html += '<div class="hr-mini-card">';
  html += '<div class="hr-mini-card-title">市场状态</div>';
  var ms = daily.marketState || {};
  html += '<div class="hr-mini-card-val" style="font-size:16px;">' + (ms.nbSentiment || '--') + '</div>';
  html += '<div class="hr-mini-card-sub">北向情绪 · ' + (daily.date || '--') + '</div>';
  html += '</div>';

  // Card 4: Context validity
  html += '<div class="hr-mini-card">';
  html += '<div class="hr-mini-card-title">复盘上下文</div>';
  html += '<div class="hr-mini-card-val" style="font-size:14px;color:#16a34a;">[ACTIVE]</div>';
  html += '<div class="hr-mini-card-sub">有效期至 ' + (daily.validUntil || '--') + '</div>';
  html += '</div>';

  html += '</div></div>';
  return html;
}

// ============ Row 2: Historical Similarity ============

function _renderSimilarity(similarity, lastDeep) {
  var html = '<div class="hr-section">';
  html += '<div class="hr-section-title">[DEEP] 历史相似度分析';
  if (lastDeep) {
    html += ' <span class="hr-subtle">上次深析: ' + _fmtDate(lastDeep) + '</span>';
  }
  html += '</div>';

  // Radar chart placeholder
  html += '<div style="text-align:center;margin-bottom:14px;">';
  html += '<canvas id="hr-radar-canvas" style="width:100%;max-width:500px;height:280px;"></canvas>';
  html += '</div>';

  // Similarity cards
  html += '<div class="hr-sim-cards">';
  for (var i = 0; i < Math.min(similarity.length, 5); i++) {
    var sim = similarity[i];
    var simCls = sim.future5d && sim.future5d.total > 0 ? 'hr-sim-up' : 'hr-sim-down';
    html += '<div class="hr-sim-card">';
    html += '<div class="hr-sim-card-date">' + sim.startDate + ' ~ ' + sim.endDate + '</div>';
    html += '<div class="hr-sim-card-sim" style="color:' + (sim.similarity > 0.7 ? '#16a34a' : sim.similarity > 0.5 ? '#b8942c' : '#64748b') + '">' + (sim.similarity * 100).toFixed(1) + '%</div>';
    html += '<div class="hr-sim-card-label">' + sim.simLabel + '</div>';
    if (sim.future5d) {
      html += '<div class="hr-sim-card-future ' + simCls + '">5d: ' + (sim.future5d.total > 0 ? '+' : '') + sim.future5d.total.toFixed(2) + '%</div>';
    }
    if (sim.future10d) {
      var cls10d = sim.future10d.total > 0 ? 'hr-sim-up' : 'hr-sim-down';
      html += '<div class="hr-sim-card-future ' + cls10d + '" style="font-size:10px;">10d: ' + (sim.future10d.total > 0 ? '+' : '') + sim.future10d.total.toFixed(2) + '%</div>';
    }
    if (sim.future20d) {
      var cls20d = sim.future20d.total > 0 ? 'hr-sim-up' : 'hr-sim-down';
      html += '<div class="hr-sim-card-future ' + cls20d + '" style="font-size:10px;">20d: ' + (sim.future20d.total > 0 ? '+' : '') + sim.future20d.total.toFixed(2) + '%</div>';
    }
    html += '</div>';
  }
  html += '</div>';

  // Overall direction signal
  if (similarity.length > 0) {
    var bullishCount = similarity.filter(function(s) { return s.future5d && s.future5d.total > 0; }).length;
    var totalWith5d = similarity.filter(function(s) { return s.future5d; }).length;
    if (totalWith5d > 0) {
      var bullPct = (bullishCount / totalWith5d * 100);
      var sigCls = bullPct >= 60 ? 'hr-sim-up' : bullPct <= 40 ? 'hr-sim-down' : '';
      html += '<div style="margin-top:12px;padding:8px 14px;background:#f8fafc;border-radius:6px;font-size:12px;">';
      html += '综合历史预判: <span style="font-weight:700;' + (sigCls === 'hr-sim-up' ? 'color:#16a34a;' : sigCls === 'hr-sim-down' ? 'color:#dc2626;' : 'color:#94a3b8;') + '">' +
        (bullPct >= 60 ? '偏多 (' + bullPct.toFixed(0) + '% 历史相似期看涨)' : bullPct <= 40 ? '偏空 (' + bullPct.toFixed(0) + '% 历史相似期看涨)' : '中性 (' + bullPct.toFixed(0) + '%)') +
        '</span></div>';
    }
  }

  html += '</div>';
  return html;
}

// ============ Row 3: Crisis Gauge ============

function _renderCrisisGauge(crisis) {
  var score = crisis.score || 50;
  var label = crisis.label || '正常';
  var level = crisis.level || 2;

  var gaugeColor;
  if (score >= 75) gaugeColor = '#dc2626';
  else if (score >= 60) gaugeColor = '#f59e0b';
  else if (score >= 40) gaugeColor = '#94a3b8';
  else gaugeColor = '#22c55e';

  var html = '<div class="hr-section">';
  html += '<div class="hr-section-title">[DEEP] 危机预警仪表盘</div>';
  html += '<div class="hr-gauge-wrap">';

  // Gauge canvas
  html += '<div style="text-align:center;">';
  html += '<canvas id="hr-gauge-canvas" style="width:200px;height:200px;" data-score="' + score + '" data-label="' + label + '"></canvas>';
  html += '<div style="font-size:13px;font-weight:700;color:' + gaugeColor + ';margin-top:4px;">' + label + ' (' + score.toFixed(0) + '/100)</div>';
  html += '</div>';

  // Dimension bars
  html += '<div class="hr-crisis-dims">';
  var dims = crisis.dimensions || [];
  for (var i = 0; i < dims.length; i++) {
    var d = dims[i];
    var dColor = d.score >= 70 ? '#dc2626' : d.score >= 55 ? '#f59e0b' : d.score >= 35 ? '#94a3b8' : '#22c55e';
    html += '<div class="hr-crisis-dim">';
    html += '<div class="hr-crisis-dim-name">' + d.name + ' (' + ((d.weight || 0) * 100).toFixed(0) + '%)</div>';
    html += '<div class="hr-crisis-dim-bar"><div class="hr-crisis-dim-fill" data-bar-width="' + d.score + '" style="width:0%;background:' + dColor + ';"></div></div>';
    html += '<div class="hr-crisis-dim-score">' + d.score.toFixed(0) + ' <span style="font-size:9px;color:#94a3b8;">' + (d.detail || '') + '</span></div>';
    html += '</div>';
  }
  html += '</div>';
  html += '</div></div>';
  return html;
}

// ============ Row 4: Sector Rotation ============

function _renderSectorRotation(rotation) {
  var sectors = rotation.sectors || [];
  var phase = rotation.currentPhase || {};

  var html = '<div class="hr-section">';
  html += '<div class="hr-section-title">[DEEP] 板块轮动矩阵';
  if (phase.phase) {
    html += ' <span class="hr-badge" style="background:#fef9e7;color:#b8942c;font-size:10px;">' + phase.phase + '</span>';
  }
  html += '</div>';

  if (sectors.length === 0) {
    html += '<div style="color:#94a3b8;font-size:12px;">暂无板块轮动数据</div>';
    html += '</div>';
    return html;
  }

  // Matrix as Canvas heatmap
  html += '<div style="display:flex;gap:16px;flex-wrap:wrap;">';
  html += '<canvas id="hr-sector-canvas" style="width:100%;max-width:500px;height:' + (sectors.length * 35 + 40) + 'px;"></canvas>';

  // Phase info
  html += '<div style="flex:1;min-width:160px;">';
  html += '<div style="font-size:12px;color:#64748b;margin-bottom:8px;">当前阶段</div>';
  html += '<div style="font-size:16px;font-weight:700;margin-bottom:4px;">' + (phase.phase || '未知') + '</div>';
  html += '<div style="font-size:11px;color:#94a3b8;">' + (phase.detail || '') + '</div>';
  html += '</div>';
  html += '</div>';

  html += '</div>';
  return html;
}

// ============ Row 5: Factor Grid ============

function _renderFactorGrid(factors) {
  var html = '<div class="hr-section">';
  html += '<div class="hr-section-title">[FACTORS] 因子效能全景</div>';
  html += '<div class="hr-factor-grid">';

  for (var i = 0; i < factors.length; i++) {
    var f = factors[i];
    var badgeHtml;
    if (f.status === 'HOT') badgeHtml = '<span class="hr-badge-hot">HOT</span>';
    else if (f.status === 'COLD') badgeHtml = '<span class="hr-badge-cold">COLD</span>';
    else badgeHtml = '<span class="hr-badge-stable">STABLE</span>';

    var hitColor = f.hitRate >= 0.55 ? '#16a34a' : f.hitRate >= 0.40 ? '#94a3b8' : '#dc2626';

    html += '<div class="hr-factor-card">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;">';
    html += '<div class="hr-factor-name">' + f.id + ' ' + f.name + '</div>';
    html += badgeHtml;
    html += '</div>';
    html += '<div class="hr-factor-hitrate" style="color:' + hitColor + '">' + (f.hitRate * 100).toFixed(0) + '%</div>';
    html += '<div class="hr-factor-trend">';
    if (f.hitRate5d != null) html += '5d: ' + (f.hitRate5d * 100).toFixed(0) + '% ';
    if (f.hitRate20d != null) html += '20d: ' + (f.hitRate20d * 100).toFixed(0) + '% ';
    html += '</div>';
    html += '<div class="hr-factor-trend">信号数: ' + (f.signalCount || 0) + ' · 均收益: ' + (f.avgReturn || 0).toFixed(2) + '%</div>';
    html += '<div class="hr-factor-trend" style="color:' + (f.trend === 'improving' ? '#16a34a' : f.trend === 'declining' ? '#dc2626' : '#94a3b8') + ';">' +
      (f.trend === 'improving' ? '[UP] improving' : f.trend === 'declining' ? '[DOWN] declining' : 'stable') + '</div>';
    html += '</div>';
  }

  html += '</div></div>';
  return html;
}

// ============ Row 6: Combos & Discoveries ============

function _renderCombosAndDiscoveries(data) {
  var html = '<div class="hr-section">';
  html += '<div class="hr-section-title">[PATTERNS] 因子组合与发现</div>';

  html += '<div class="hr-combo-grid">';

  // Factor combos from API
  var combos = data.factorCombos || null;
  var sectorEffects = data.sectorFactorEffects || null;
  var discoveries = data.discoveries || [];

  // Left: synergies
  html += '<div class="hr-combo-synergy">';
  html += '<div style="font-size:11px;font-weight:600;color:#16a34a;margin-bottom:8px;">[协同因子对] (lift >= +0.10)</div>';
  if (combos && combos.synergistic && combos.synergistic.length > 0) {
    for (var i = 0; i < combos.synergistic.length; i++) {
      var s = combos.synergistic[i];
      html += '<div class="hr-combo-item green">';
      html += '<div style="font-weight:600;">' + (s.factor1 || s.combo || '') + ' + ' + (s.factor2 || '') + '</div>';
      html += '<div style="font-size:10px;color:#64748b;">组合命中率: ' + (s.pairWinRate * 100).toFixed(0) + '% | baseline: ' + (s.baselineWinRate * 100).toFixed(0) + '% | lift: ' + (s.lift > 0 ? '+' : '') + (s.lift * 100).toFixed(0) + '%</div>';
      html += '</div>';
    }
  } else if (combos && combos.length > 0) {
    // flat combos list
    for (var j = 0; j < Math.min(combos.length, 5); j++) {
      var c = combos[j];
      html += '<div class="hr-combo-item green">';
      html += '<div style="font-weight:600;">' + (c.combo || c.key || '') + '</div>';
      html += '<div style="font-size:10px;color:#64748b;">命中率: ' + ((c.hitRate || 0) * 100).toFixed(0) + '% | 样本: ' + (c.sampleSize || 0) + '</div>';
      html += '</div>';
    }
  } else {
    html += '<div style="font-size:10px;color:#94a3b8;">暂无协同因子数据</div>';
  }
  html += '</div>';

  // Right: conflicts + discoveries
  html += '<div>';
  if (combos && combos.conflicting && combos.conflicting.length > 0) {
    html += '<div style="font-size:11px;font-weight:600;color:#dc2626;margin-bottom:8px;">[冲突因子对] (lift <= -0.10)</div>';
    for (var k = 0; k < combos.conflicting.length; k++) {
      var c2 = combos.conflicting[k];
      html += '<div class="hr-combo-item red">';
      html += '<div style="font-weight:600;">' + (c2.factor1 || '') + ' + ' + (c2.factor2 || '') + '</div>';
      html += '<div style="font-size:10px;color:#64748b;">组合命中率: ' + (c2.pairWinRate * 100).toFixed(0) + '% | lift: ' + (c2.lift * 100).toFixed(0) + '%</div>';
      html += '</div>';
    }
  }

  // Discoveries
  if (discoveries && discoveries.length > 0) {
    html += '<div style="font-size:11px;font-weight:600;color:#f59e0b;margin:12px 0 8px;">[NEW] 周末发现 (' + discoveries.length + ')</div>';
    for (var d = 0; d < Math.min(discoveries.length, 5); d++) {
      var disc = discoveries[d];
      html += '<div class="hr-combo-item gold hr-discovery-new">';
      html += '<div style="font-weight:600;">' + (disc.title || disc.angle || '') + '</div>';
      html += '<div style="font-size:10px;color:#64748b;">' + (disc.detail || '') + '</div>';
      html += '<div style="font-size:9px;color:#94a3b8;">' + _fmtDate(disc.time) + '</div>';
      html += '</div>';
    }
  }
  html += '</div>';

  html += '</div></div>';
  return html;
}

// ============ Row 7: Verification & Archive ============

function _renderVerificationArchive(data) {
  var html = '<div class="hr-section">';
  html += '<div class="hr-section-title">[VERIFY] 验证与归档</div>';

  // Verification trend from subGrades
  var verifHistory = data.verificationHistory;
  if (verifHistory && verifHistory.ok && verifHistory.history && verifHistory.history.length > 0) {
    html += '<div style="margin-bottom:12px;">';
    html += '<div style="font-size:11px;color:#64748b;margin-bottom:6px;">多周验证趋势 (' + verifHistory.history.length + ' 周)</div>';
    html += '<div class="hr-verif-history">';
    var maxScore = 0;
    for (var i = 0; i < verifHistory.history.length; i++) {
      if (verifHistory.history[i].overallScore > maxScore) maxScore = verifHistory.history[i].overallScore;
    }
    if (maxScore < 50) maxScore = 50;
    for (var j = 0; j < verifHistory.history.length; j++) {
      var entry = verifHistory.history[j];
      var score = entry.overallScore || 0;
      var grade = entry.overallGrade || 'C';
      var barH = Math.max(3, (score / maxScore) * 100);
      var gradeClr = grade === 'A' ? '#16a34a' : grade === 'B' ? '#6366f1' : grade === 'C' ? '#b8942c' : grade === 'D' ? '#f97316' : '#dc2626';
      html += '<div class="hr-verif-bar-wrap">';
      html += '<div class="hr-verif-bar" style="height:' + barH.toFixed(0) + 'px;background:' + gradeClr + ';" title="' + score.toFixed(0) + ' (' + grade + ')"></div>';
      html += '<div class="hr-verif-bar-label">' + ((entry.weekend || '').slice(5)) + '</div>';
      html += '</div>';
    }
    html += '</div></div>';
  }

  // Archive date picker placeholder
  html += '<div style="font-size:11px;color:#64748b;margin-top:8px;">';
  html += '归档浏览: 完整报告存储在 ' + (data.archiveDir || 'weekend_archive') + '/YYYY-MM-DD.json';
  html += '</div>';

  html += '</div>';
  return html;
}

// ============ Canvas Drawing Functions (called after DOM insertion) ============

function drawHistoryReviewCanvases() {
  // Gauge
  var gaugeCanvas = document.getElementById('hr-gauge-canvas');
  if (gaugeCanvas) _drawGauge(gaugeCanvas);

  // Radar
  var radarCanvas = document.getElementById('hr-radar-canvas');
  if (radarCanvas) _drawRadarPlaceholder(radarCanvas);

  // Sector heatmap
  var sectorCanvas = document.getElementById('hr-sector-canvas');
  if (sectorCanvas) _drawSectorHeatmap(sectorCanvas);

  // Verif sparkline
  var sparkCanvas = document.getElementById('hr-verif-sparkline');
  if (sparkCanvas) _drawSparkline(sparkCanvas);
}

function _drawGauge(canvas) {
  var score = parseFloat(canvas.getAttribute('data-score')) || 50;
  var ctx = canvas.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  var w = canvas.offsetWidth;
  var h = canvas.offsetHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  var cx = w / 2, cy = h / 2;
  var r = Math.min(w, h) / 2 - 10;
  var targetAngle = Math.PI + (score / 100) * Math.PI;

  // Pre-compute gradient
  var grad = ctx.createLinearGradient(0, cy + r, 0, cy - r);
  grad.addColorStop(0, '#22c55e');
  grad.addColorStop(0.4, '#22c55e');
  grad.addColorStop(0.6, '#f59e0b');
  grad.addColorStop(0.8, '#dc2626');
  grad.addColorStop(1, '#dc2626');

  // Animate from angle=PI (0 score) to targetAngle
  var startTime = null;
  var duration = 700;
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function animateFrame(ts) {
    if (!startTime) startTime = ts;
    var progress = Math.min((ts - startTime) / duration, 1);
    var eased = easeOutCubic(progress);
    var currentAngle = Math.PI + (targetAngle - Math.PI) * eased;

    ctx.clearRect(0, 0, w, h);

    // Background arc
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI, 0);
    ctx.lineWidth = 12;
    ctx.strokeStyle = '#e5e7eb';
    ctx.stroke();

    // Color arc
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI, currentAngle);
    ctx.lineWidth = 14;
    ctx.strokeStyle = grad;
    ctx.stroke();

    // Needle
    var nx = cx + Math.cos(currentAngle) * (r - 18);
    var ny = cy + Math.sin(currentAngle) * (r - 18);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(nx, ny);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#1e293b';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#1e293b';
    ctx.fill();

    if (progress < 1) {
      requestAnimationFrame(animateFrame);
    }
  }
  requestAnimationFrame(animateFrame);
}

function _drawRadarPlaceholder(canvas) {
  // Placeholder: draw a simple 6-axis spider chart outline
  var ctx = canvas.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  var w = canvas.offsetWidth;
  var h = canvas.offsetHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  var cx = w / 2, cy = h / 2;
  var r = Math.min(w, h) / 2 - 30;
  var dims = 6;
  ctx.clearRect(0, 0, w, h);

  // Grid rings
  for (var level = 1; level <= 4; level++) {
    ctx.beginPath();
    for (var i = 0; i < dims; i++) {
      var angle = -Math.PI / 2 + (i * 2 * Math.PI) / dims;
      var lr = r * level / 4;
      var x = cx + Math.cos(angle) * lr;
      var y = cy + Math.sin(angle) * lr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = level === 4 ? '#e5e7eb' : '#f1f5f9';
    ctx.lineWidth = level === 4 ? 1.5 : 0.5;
    ctx.stroke();
  }

  // Axes
  var labels = ['收益', '波动', '动量', '量能', '涨比', '回撤'];
  for (var j = 0; j < dims; j++) {
    var angle = -Math.PI / 2 + (j * 2 * Math.PI) / dims;
    var ax = cx + Math.cos(angle) * r;
    var ay = cy + Math.sin(angle) * r;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(ax, ay);
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 0.5;
    ctx.stroke();

    // Label
    var lx = cx + Math.cos(angle) * (r + 16);
    var ly = cy + Math.sin(angle) * (r + 16);
    ctx.fillStyle = '#64748b';
    ctx.font = '10px -apple-system, "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(labels[j], lx, ly);
  }

  // Placeholder text
  ctx.fillStyle = '#94a3b8';
  ctx.font = '11px -apple-system, "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('(需要深度分析数据)', cx, cy);
}

function _drawSectorHeatmap(canvas) {
  var ctx = canvas.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  var w = canvas.offsetWidth;
  var h = canvas.offsetHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#94a3b8';
  ctx.font = '11px -apple-system, "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('(板块轮动热力图 — 需要深度分析数据)', w / 2, h / 2);
}

function _drawSparkline(canvas) {
  var ctx = canvas.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  var w = canvas.offsetWidth;
  var h = canvas.offsetHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px -apple-system, "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('(验证趋势 — 等待数据积累)', w / 2, h / 2);
}

// Export for app.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderHistoryReviewDashboard, renderHistoryReviewCSS, drawHistoryReviewCanvases };
}
