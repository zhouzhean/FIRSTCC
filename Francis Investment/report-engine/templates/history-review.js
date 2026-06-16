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
    '  .hr-training-table-wrap { font-size:10px; }',
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

  // Row 5.5: [v3.2] Deep Analysis Synthesis
  if (data.deepAnalysis) {
    html += _renderDeepAnalysis(data.deepAnalysis);
  }

  // Row 6: Factor Combos + Discoveries
  html += _renderCombosAndDiscoveries(data);

  // Row 7: Verification & Archive
  html += _renderVerificationArchive(data);

  // === [v3.1] Training Analysis Rows ===
  // Row 8: Training Summary (bootstrap history engine)
  if (data.trainingMatrix && (data.trainingMatrix.ok || data.trainingMatrix.summary)) {
    html += _renderTrainingHero(data.trainingMatrix);
  }

  // Row 9: Factor Effectiveness Matrix (from bootstrap, T+5)
  if (data.factorEffectiveness && data.factorEffectiveness.ok && data.factorEffectiveness.matrix) {
    html += _renderTrainingFactorGrid(data.factorEffectiveness);
  }

  // Row 10: Parameter Optimization + Factor Combos
  html += _renderTrainingParamsAndCombos(data);

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

  // [v3.2] Store sector data for Canvas heatmap
  window._hrSectorNames = sectors;
  window._hrSectorMatrix = rotation.matrix || [];

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

// ============ Row 5.5: Deep Analysis Synthesis [v3.2] ============

function _renderDeepAnalysis(da) {
  var html = '<div class="hr-section" style="border-left:3px solid #8b5cf6;">';
  html += '<div class="hr-section-title">' +
    '<span style="color:#8b5cf6;">[DEEP]</span> 深度综合分析';
  if (da.generatedAt) html += ' <span class="hr-subtle">' + da.generatedAt.slice(0, 10) + '</span>';
  html += '</div>';

  // Card grid: similarity stats across horizons
  html += '<div class="hr-cards-4" style="margin-bottom:12px;">';

  // Card 1: T+5 forward stats from similar periods
  if (da.similarityStats) {
    var ss = da.similarityStats;
    var wrColor = ss.winRate >= 55 ? '#16a34a' : ss.winRate >= 45 ? '#f59e0b' : '#dc2626';
    html += '<div class="hr-mini-card">';
    html += '<div class="hr-mini-card-title">相似行情后 T+5 (共' + ss.count + '个)</div>';
    html += '<div class="hr-mini-card-val" style="font-size:22px;color:' + wrColor + ';">胜率 ' + ss.winRate + '%</div>';
    html += '<div class="hr-mini-card-sub">均收益 ' + (ss.avgReturn >= 0 ? '+' : '') + ss.avgReturn +
      '% · 中位数 ' + (ss.medianReturn >= 0 ? '+' : '') + ss.medianReturn + '%</div>';
    html += '<div class="hr-mini-card-sub" style="margin-top:2px;">' +
      '范围 [' + ss.minReturn + '% ~ +' + ss.maxReturn + '%] · 收益风险比 ' + ss.riskReward + '</div>';
    html += '</div>';
  } else {
    html += '<div class="hr-mini-card">';
    html += '<div class="hr-mini-card-title">相似行情 T+5</div>';
    html += '<div class="hr-mini-card-val" style="font-size:14px;color:#94a3b8;">等待深度分析</div>';
    html += '</div>';
  }

  // Card 2: T+10 stats
  if (da.fwd10dStats) {
    var s10 = da.fwd10dStats;
    html += '<div class="hr-mini-card">';
    html += '<div class="hr-mini-card-title">相似行情后 T+10</div>';
    html += '<div class="hr-mini-card-val" style="font-size:18px;">胜率 ' + s10.winRate + '%</div>';
    html += '<div class="hr-mini-card-sub">均收益 ' + (s10.avgReturn >= 0 ? '+' : '') + s10.avgReturn +
      '% · RR ' + s10.riskReward + '</div>';
    html += '</div>';
  }

  // Card 3: T+20 stats
  if (da.fwd20dStats) {
    var s20 = da.fwd20dStats;
    html += '<div class="hr-mini-card">';
    html += '<div class="hr-mini-card-title">相似行情后 T+20</div>';
    html += '<div class="hr-mini-card-val" style="font-size:18px;">胜率 ' + s20.winRate + '%</div>';
    html += '<div class="hr-mini-card-sub">均收益 ' + (s20.avgReturn >= 0 ? '+' : '') + s20.avgReturn +
      '% · RR ' + s20.riskReward + '</div>';
    html += '</div>';
  }

  // Card 4: Crisis interpretation
  if (da.crisisInterpretation) {
    var ci = da.crisisInterpretation;
    html += '<div class="hr-mini-card">';
    html += '<div class="hr-mini-card-title">危机信号解读</div>';
    html += '<div class="hr-mini-card-val" style="font-size:16px;">' + ci.label + ' (' + ci.score + ')</div>';
    html += '<div class="hr-mini-card-sub">' + ci.recommendation + '</div>';
    html += '</div>';
  } else if (da.factorHealth) {
    var fh = da.factorHealth;
    html += '<div class="hr-mini-card">';
    html += '<div class="hr-mini-card-title">因子健康度</div>';
    html += '<div class="hr-mini-card-val" style="font-size:16px;">' +
      '<span style="color:#16a34a;">HOT: ' + fh.hotCount + '</span> · ' +
      '<span style="color:#dc2626;">COLD: ' + fh.coldCount + '</span></div>';
    html += '<div class="hr-mini-card-sub">热: ' + (fh.hotNames.join(', ') || '无') + '</div>';
    html += '<div class="hr-mini-card-sub">冷: ' + (fh.coldNames.join(', ') || '无') + '</div>';
    html += '</div>';
  }

  html += '</div>'; // end cards

  // Percentile distribution bar for T+5
  if (da.similarityStats && da.similarityStats.percentiles) {
    var p = da.similarityStats.percentiles;
    html += '<div style="display:flex;align-items:center;gap:8px;font-size:10px;color:#64748b;">';
    html += '<span>T+5 分布:</span>';
    html += '<div style="flex:1;height:16px;background:#f1f5f9;border-radius:8px;position:relative;overflow:hidden;">';
    // Red zone (negative)
    html += '<div style="position:absolute;left:0;top:0;height:100%;width:25%;background:#fef2f2;"></div>';
    // Green zone (positive)
    html += '<div style="position:absolute;left:50%;top:0;height:100%;width:50%;background:#f0fdf4;"></div>';
    // Percentile markers
    html += '<div style="position:absolute;left:' + (50 + p.p10 / da.similarityStats.maxReturn * 50) +
      '%;top:0;height:100%;width:1px;background:#dc2626;"></div>';
    html += '<div style="position:absolute;left:' + (50 + p.p90 / da.similarityStats.maxReturn * 50) +
      '%;top:0;height:100%;width:1px;background:#16a34a;"></div>';
    html += '</div>';
    html += '<span>P10=' + p.p10 + '%</span>';
    html += '<span>P25=' + p.p25 + '%</span>';
    html += '<span>中位数=' + da.similarityStats.medianReturn + '%</span>';
    html += '<span>P75=' + p.p75 + '%</span>';
    html += '<span>P90=' + p.p90 + '%</span>';
    html += '</div>';
  }

  html += '</div>';
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

// ============ [v3.1] Training Analysis Functions ============

function _renderTrainingHero(tm) {
  if (!tm.summary && !tm.config) {
    // Data from /api/evolution/training-matrix may return summary directly
    if (tm.computedAt) {
      return '<div class="hr-section"><div class="hr-section-title">[TRAINING] 训练矩阵 · ' +
        tm.computedAt.slice(0,10) + '</div>' +
        '<div style="font-size:12px;color:#94a3b8;">训练数据已生成，但摘要缺失。请检查 training_matrix.json 完整性。</div></div>';
    }
    return '';
  }

  var cfg = tm.config || {};
  var sum = tm.summary || {};
  var generatedAt = tm.generatedAt ? tm.generatedAt.slice(0,10) : (tm.computedAt || '').slice(0,10);

  var html = '<div class="hr-section" style="border-left:3px solid #6366f1;">';
  html += '<div class="hr-section-title">' +
    '<span style="color:#6366f1;">[TRAINING]</span> 历史训练分析引擎 v1.0';
  if (generatedAt) html += ' <span class="hr-subtle">生成: ' + generatedAt + '</span>';
  html += '</div>';

  html += '<div class="hr-cards-4">';

  // Card 1: Training scope
  html += '<div class="hr-mini-card">';
  html += '<div class="hr-mini-card-title">训练范围</div>';
  html += '<div class="hr-mini-card-val" style="font-size:16px;">' + (cfg.universe || '--') + '</div>';
  html += '<div class="hr-mini-card-sub">' + (cfg.startYear || '') + '~' + (cfg.endYear || '') +
    ' · ' + (cfg.sampleDays || '--') + ' 天</div>';
  html += '</div>';

  // Card 2: Duration
  html += '<div class="hr-mini-card">';
  html += '<div class="hr-mini-card-title">训练耗时</div>';
  var dur = tm.duration;
  var durText = dur ? (dur >= 3600 ? (dur/3600).toFixed(1)+'小时' : (dur/60).toFixed(0)+'分钟') : '--';
  html += '<div class="hr-mini-card-val" style="font-size:18px;">' + durText + '</div>';
  html += '<div class="hr-mini-card-sub">' + (cfg.sampleStocks || '--') + ' 只股票 · ' +
    FORWARD_HORIZONS_FOR_TRAINING().length + ' 个展望期</div>';
  html += '</div>';

  // Card 3: Best Factor
  if (sum.topFactors && sum.topFactors.length > 0) {
    var top = sum.topFactors[0];
    html += '<div class="hr-mini-card">';
    html += '<div class="hr-mini-card-title">最强因子 (T+5)</div>';
    html += '<div class="hr-mini-card-val" style="color:#16a34a;">' + top.name + '</div>';
    html += '<div class="hr-mini-card-sub">胜率 ' + top.hitRate + '% · +' + top.avgReturn + '%</div>';
    html += '</div>';
  } else {
    html += '<div class="hr-mini-card">';
    html += '<div class="hr-mini-card-title">最强因子</div>';
    html += '<div class="hr-mini-card-val" style="font-size:14px;color:#94a3b8;">等待数据</div>';
    html += '</div>';
  }

  // Card 4: Recommend params
  if (sum.bestParams) {
    html += '<div class="hr-mini-card">';
    html += '<div class="hr-mini-card-title">推荐参数</div>';
    html += '<div class="hr-mini-card-val" style="font-size:15px;">止损 ' + (sum.bestParams.stopLoss*100).toFixed(1) + '%</div>';
    html += '<div class="hr-mini-card-sub">买入阈值 ≥' + sum.bestParams.buyMinScore + '分</div>';
    html += '</div>';
  } else {
    html += '<div class="hr-mini-card">';
    html += '<div class="hr-mini-card-title">推荐参数</div>';
    html += '<div class="hr-mini-card-val" style="font-size:14px;color:#94a3b8;">等待数据</div>';
    html += '</div>';
  }

  html += '</div>';

  // Weakest factors
  if (sum.weakestFactors && sum.weakestFactors.length > 0) {
    html += '<div style="margin-top:12px;font-size:11px;color:#64748b;">';
    html += '最弱因子: ';
    var weakParts = sum.weakestFactors.map(function(f) {
      return '<span style="color:#dc2626;">' + f.name + '</span> (胜率' + f.hitRate + '%)';
    });
    html += weakParts.join(' · ');
    if (sum.topSynergyPair) {
      html += ' &nbsp;|&nbsp; 最优组合: <span style="color:#6366f1;font-weight:600;">' + sum.topSynergyPair + '</span>';
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function FORWARD_HORIZONS_FOR_TRAINING() { return [1, 3, 5, 10, 20]; }

function _renderTrainingFactorGrid(factorEff) {
  var matrix = factorEff.matrix;
  var t5 = matrix['T+5'];
  if (!t5) return '';

  var factors = Object.values(t5).filter(function(f) { return !f._insufficient && f.total >= 10; });
  if (factors.length === 0) return '';

  // Sort by hitRate desc
  factors.sort(function(a, b) { return b.hitRate - a.hitRate; });

  var html = '<div class="hr-section">';
  html += '<div class="hr-section-title">' +
    '<span style="color:#6366f1;">[TRAINING]</span> 因子有效性矩阵 · T+5 展望';
  html += '</div>';

  // Top section: bar chart of hit rates
  html += '<div style="margin-bottom:16px;text-align:center;">';
  html += '<canvas id="hr-training-factor-chart" style="width:100%;max-width:900px;height:200px;"></canvas>';
  html += '</div>';

  // Factor table
  html += '<div style="overflow-x:auto;">';
  html += '<table style="width:100%;border-collapse:collapse;font-size:12px;">';
  html += '<thead><tr style="border-bottom:2px solid #e5e7eb;">';
  html += '<th style="text-align:left;padding:6px 8px;color:#64748b;font-weight:600;">因子</th>';
  html += '<th style="text-align:center;padding:6px 8px;color:#64748b;">类别</th>';
  html += '<th style="text-align:center;padding:6px 8px;color:#64748b;">样本数</th>';
  html += '<th style="text-align:center;padding:6px 8px;color:#64748b;">胜率</th>';
  html += '<th style="text-align:right;padding:6px 8px;color:#64748b;">平均收益</th>';
  html += '<th style="text-align:right;padding:6px 8px;color:#64748b;">盈亏比</th>';
  html += '<th style="text-align:right;padding:6px 8px;color:#64748b;">最大</th>';
  html += '<th style="text-align:right;padding:6px 8px;color:#64748b;">最小</th>';
  html += '</tr></thead><tbody>';

  // [v3.2] Store factor data for Canvas chart (avoid DOM parsing)
  window._hrTrainingFactors = factors;

  for (var i = 0; i < factors.length; i++) {
    var f = factors[i];
    var hitColor = f.hitRate >= 55 ? '#16a34a' : f.hitRate >= 45 ? '#b8942c' : '#dc2626';
    var pfColor = (f.profitFactor || 0) >= 1.5 ? '#16a34a' : (f.profitFactor || 0) >= 1.0 ? '#94a3b8' : '#dc2626';
    var retColor = (f.avgFwdReturn || 0) > 0 ? '#16a34a' : '#dc2626';

    html += '<tr style="border-bottom:1px solid #f1f5f9;">';
    html += '<td style="padding:6px 8px;font-weight:600;">' + f.name + '</td>';
    html += '<td style="padding:6px 8px;text-align:center;color:#94a3b8;font-size:10px;">' +
      (f.category || '') + '</td>';
    html += '<td style="padding:6px 8px;text-align:center;color:#64748b;">' + f.total + '</td>';
    html += '<td style="padding:6px 8px;text-align:center;font-weight:700;color:' + hitColor + ';">' +
      f.hitRate + '%</td>';
    html += '<td style="padding:6px 8px;text-align:right;font-weight:600;color:' + retColor + ';">' +
      (f.avgFwdReturn > 0 ? '+' : '') + f.avgFwdReturn + '%</td>';
    html += '<td style="padding:6px 8px;text-align:right;color:' + pfColor + ';">' +
      (f.profitFactor || '--') + '</td>';
    html += '<td style="padding:6px 8px;text-align:right;color:#16a34a;font-size:11px;">' +
      (f.maxFwdReturn > 0 ? '+' : '') + f.maxFwdReturn + '%</td>';
    html += '<td style="padding:6px 8px;text-align:right;color:#dc2626;font-size:11px;">' +
      f.minFwdReturn + '%</td>';
    html += '</tr>';
  }

  html += '</tbody></table></div>';
  html += '</div>';
  return html;
}

function _renderTrainingParamsAndCombos(data) {
  var html = '<div class="hr-section">';
  html += '<div class="hr-section-title">' +
    '<span style="color:#6366f1;">[TRAINING]</span> 参数优化 & 因子组合';
  html += '</div>';

  html += '<div class="hr-combo-grid">';

  // Left: Params
  html += '<div>';
  html += '<div style="font-size:11px;font-weight:600;color:#6366f1;margin-bottom:8px;">[参数优化]</div>';

  var paramSearch = data.paramSearch;
  if (paramSearch && paramSearch.recommendation) {
    var rec = paramSearch.recommendation;
    html += '<div class="hr-combo-item green">';
    html += '<div style="font-weight:600;font-size:14px;">推荐配置</div>';
    html += '<div style="font-size:11px;color:#64748b;margin-top:4px;">' +
      '止损线: <b>' + (rec.stopLoss * 100).toFixed(1) + '%</b> · ' +
      '买入阈值: <b>' + rec.buyMinScore + '分</b></div>';
    html += '<div style="font-size:11px;color:#64748b;">' +
      '预期胜率: <b style="color:#16a34a;">' + rec.expectedHitRate + '%</b> · ' +
      '预期收益: <b style="color:#16a34a;">+' + rec.expectedAvgRet5d + '%</b></div>';
    html += '<div style="font-size:10px;color:#94a3b8;margin-top:2px;">' + rec.rationale + '</div>';
    html += '</div>';

    // Show top 3 configs for comparison
    if (paramSearch.topConfigs && paramSearch.topConfigs.length > 0) {
      html += '<div style="font-size:10px;color:#94a3b8;margin-top:8px;">Top 3 备选:</div>';
      for (var i = 0; i < Math.min(3, paramSearch.topConfigs.length); i++) {
        var cfg = paramSearch.topConfigs[i];
        html += '<div class="hr-combo-item" style="font-size:10px;">';
        html += '#' + (i+1) + ' 止损' + (cfg.stopLoss*100).toFixed(1) + '% · 阈值' + cfg.buyMinScore +
          '分 · 胜率' + cfg.afterStopHitRate + '% · +' + cfg.avgRet5d + '%' +
          ' (' + cfg.qualifiedCount + '笔)';
        html += '</div>';
      }
    }
  } else {
    html += '<div style="font-size:11px;color:#94a3b8;">参数优化尚未运行</div>';
    html += '<div style="font-size:10px;color:#94a3b8;margin-top:4px;">运行 bootstrap 后自动生成</div>';
  }
  html += '</div>';

  // Right: Factor Combos (from training, not weekend mining)
  html += '<div>';
  html += '<div style="font-size:11px;font-weight:600;color:#6366f1;margin-bottom:8px;">[因子组合挖掘]</div>';

  // Check if training has factor combo results in data.trainingMatrix
  var tm = data.trainingMatrix || {};
  var combosData = null;

  // Try training matrix summary first
  if (tm.summary && tm.summary.topSynergyPair) {
    html += '<div class="hr-combo-item green">';
    html += '<div style="font-weight:600;">最优协同对: ' + tm.summary.topSynergyPair + '</div>';
    html += '<div style="font-size:10px;color:#64748b;">历史训练发现的最强协同效应</div>';
    html += '</div>';
    combosData = 'partial';
  }

  // If we have the full factorCombos from the matrix
  if (tm.factorCombos) {
    var t5Combos = tm.factorCombos['T+5'];
    if (t5Combos) {
      // Synergy pairs
      if (t5Combos.synergyPairs && t5Combos.synergyPairs.length > 0) {
        html += '<div style="font-size:10px;color:#16a34a;font-weight:600;margin:8px 0 4px;">协同效应 (1+1&gt;2)</div>';
        for (var i = 0; i < Math.min(t5Combos.synergyPairs.length, 3); i++) {
          var s = t5Combos.synergyPairs[i];
          html += '<div class="hr-combo-item green" style="font-size:10px;">';
          html += '<div><b>' + s.factors.join(' + ') + '</b></div>';
          html += '<div style="color:#64748b;">联合胜率 ' + s.bothHitRate + '% · 增益 +' + s.effect + '% · ' + s.bothCount + '样本</div>';
          html += '</div>';
        }
      }

      // Conflict pairs
      if (t5Combos.conflictPairs && t5Combos.conflictPairs.length > 0) {
        html += '<div style="font-size:10px;color:#dc2626;font-weight:600;margin:8px 0 4px;">冲突效应 (1+1&lt;1)</div>';
        for (var j = 0; j < Math.min(t5Combos.conflictPairs.length, 3); j++) {
          var c = t5Combos.conflictPairs[j];
          html += '<div class="hr-combo-item red" style="font-size:10px;">';
          html += '<div><b>' + c.factors.join(' + ') + '</b></div>';
          html += '<div style="color:#64748b;">联合胜率 ' + c.bothHitRate + '% · 衰减 ' + c.effect + '%</div>';
          html += '</div>';
        }
      }
      combosData = 'full';
    }
  }

  if (!combosData) {
    html += '<div style="font-size:11px;color:#94a3b8;">因子组合数据待生成</div>';
    html += '<div style="font-size:10px;color:#94a3b8;margin-top:4px;">完整训练后自动计算协同/冲突因子对</div>';
  }

  html += '</div>'; // end right column

  html += '</div>'; // end hr-combo-grid
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

  // [v3.1] Training factor chart
  var trainingChart = document.getElementById('hr-training-factor-chart');
  if (trainingChart) _drawTrainingFactorChart(trainingChart);
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

  // [v3.2] Use real sector rotation matrix data stored by _renderSectorRotation
  var sectors = window._hrSectorNames || [];
  var matrix = window._hrSectorMatrix || [];

  if (sectors.length === 0 || matrix.length === 0) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px -apple-system, "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('(板块轮动热力图 -- 需要深度分析数据)', w / 2, h / 2);
    return;
  }

  var pad = { top: 8, right: 12, bottom: 8, left: 72 };
  var cols = matrix.length > 0 ? matrix[0].length : 1;
  var cellW = (w - pad.left - pad.right) / Math.max(cols, 1);
  var cellH = (h - pad.top - pad.bottom) / Math.max(sectors.length, 1);

  for (var i = 0; i < sectors.length; i++) {
    // Sector label
    ctx.fillStyle = '#64748b';
    ctx.font = '10px -apple-system, "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(sectors[i], pad.left - 6, pad.top + i * cellH + cellH / 2 + 3);

    var row = matrix[i] || [];
    for (var j = 0; j < Math.min(row.length, cols); j++) {
      var val = row[j];
      var x = pad.left + j * cellW + 1;
      var y = pad.top + i * cellH + 1;
      var cw = cellW - 2;
      var ch = cellH - 2;

      // Color: negative=red, positive=green, intensity by abs(value)
      var intensity = Math.min(Math.abs(val || 0) / 5, 1);
      if ((val || 0) >= 0) {
        ctx.fillStyle = 'rgba(22, 163, 74, ' + (0.2 + intensity * 0.7) + ')';
      } else {
        ctx.fillStyle = 'rgba(220, 38, 38, ' + (0.2 + intensity * 0.7) + ')';
      }
      ctx.fillRect(x, y, cw, ch);

      // Show value in cell
      if (cellW > 40) {
        ctx.fillStyle = '#1e293b';
        ctx.font = '9px -apple-system, "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText((val || 0).toFixed(1) + '%', x + cw / 2, y + ch / 2 + 3);
      }
    }
  }
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

  // [v3.2] Use verification history data
  var verifData = window._hrVerificationHistory;
  if (!verifData || !verifData.history || verifData.history.length < 2) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px -apple-system, "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('(验证趋势 -- 等待数据积累)', w / 2, h / 2);
    return;
  }

  var points = [];
  for (var i = verifData.history.length - 1; i >= 0; i--) {
    var entry = verifData.history[i];
    var score = entry.overallScore;
    if (score != null) points.unshift(score);
  }

  if (points.length < 2) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px -apple-system, "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('(验证趋势 -- 等待数据积累)', w / 2, h / 2);
    return;
  }

  var pad = { top: 6, right: 6, bottom: 14, left: 6 };
  var chartW = w - pad.left - pad.right;
  var chartH = h - pad.top - pad.bottom;

  var minScore = Math.min.apply(null, points);
  var maxScore = Math.max.apply(null, points);
  var range = maxScore - minScore || 1;

  // Draw line
  ctx.beginPath();
  ctx.strokeStyle = '#6366f1';
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  for (var p = 0; p < points.length; p++) {
    var px = pad.left + (p / (points.length - 1)) * chartW;
    var py = pad.top + chartH - ((points[p] - minScore) / range) * chartH;
    if (p === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();

  // Fill area
  ctx.lineTo(w - pad.right, pad.top + chartH);
  ctx.lineTo(pad.left, pad.top + chartH);
  ctx.closePath();
  ctx.fillStyle = 'rgba(99, 102, 241, 0.08)';
  ctx.fill();

  // Dot for latest
  ctx.beginPath();
  var lx = pad.left + chartW;
  var ly = pad.top + chartH - ((points[points.length - 1] - minScore) / range) * chartH;
  ctx.arc(lx, ly, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#6366f1';
  ctx.fill();

  // Labels
  ctx.fillStyle = '#94a3b8';
  ctx.font = '9px -apple-system, "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('验证评分 ' + points[0] + ' → ' + points[points.length - 1], pad.left, pad.top + chartH + 12);
}

// [v3.1] Training: Factor hit rate bar chart
function _drawTrainingFactorChart(canvas) {
  var ctx = canvas.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  var w = canvas.offsetWidth;
  var h = canvas.offsetHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, w, h);

  // [v3.2] Read factor data from stored JS variable, not DOM table parsing
  var factors = window._hrTrainingFactors;
  if (!factors || factors.length === 0) {
    // No data — draw placeholder text
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px -apple-system, "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('训练因子数据加载中...', w / 2, h / 2);
    return;
  }
  // Chart layout
  var padding = { top: 20, right: 20, bottom: 50, left: 120 };
  var chartW = w - padding.left - padding.right;
  var chartH = h - padding.top - padding.bottom;
  var barGap = 10;
  var barW = Math.min(30, (chartW - barGap * (factors.length - 1)) / factors.length);

  // Sort by hitRate descending
  factors.sort(function(a, b) { return b.hitRate - a.hitRate; });

  // Y-axis: 0 to max hitRate rounded up to nearest 10
  var maxY = Math.ceil(Math.max.apply(null, factors.map(function(f) { return f.hitRate; })) / 10) * 10;
  if (maxY < 50) maxY = 60;

  // Grid lines
  ctx.strokeStyle = '#f1f5f9';
  ctx.lineWidth = 1;
  for (var gy = 0; gy <= maxY; gy += 10) {
    var y = padding.top + chartH - (gy / maxY) * chartH;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(w - padding.right, y);
    ctx.stroke();

    // Y-axis label
    ctx.fillStyle = '#94a3b8';
    ctx.font = '9px -apple-system, "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(gy + '%', padding.left - 6, y + 3);
  }

  // Bars
  for (var bi = 0; bi < factors.length; bi++) {
    var f = factors[bi];
    var barH = (f.hitRate / maxY) * chartH;
    var x = padding.left + bi * (barW + barGap);
    var y = padding.top + chartH - barH;

    // Bar color based on hit rate
    var color;
    if (f.hitRate >= 55) color = '#16a34a';
    else if (f.hitRate >= 45) color = '#b8942c';
    else color = '#dc2626';

    // Gradient bar
    var grad = ctx.createLinearGradient(x, y, x, padding.top + chartH);
    grad.addColorStop(0, color);
    grad.addColorStop(1, color + '44');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, barW, barH);

    // Bar border
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, barW, barH);

    // Hit rate text on top of bar
    ctx.fillStyle = '#1e293b';
    ctx.font = '9px -apple-system, "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(f.hitRate + '%', x + barW / 2, y - 4);

    // Factor name below bar (rotated or abbreviated)
    ctx.save();
    var label = f.name.length > 4 ? f.name.slice(0, 4) + '..' : f.name;
    ctx.fillStyle = '#64748b';
    ctx.font = '8px -apple-system, "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.translate(x + barW / 2, padding.top + chartH + 10);
    ctx.rotate(-Math.PI / 4);
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }

  // 50% reference line
  ctx.strokeStyle = '#94a3b8';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  var refY = padding.top + chartH - (50 / maxY) * chartH;
  ctx.beginPath();
  ctx.moveTo(padding.left, refY);
  ctx.lineTo(w - padding.right, refY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#94a3b8';
  ctx.font = '9px -apple-system, "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('50% 基准', w - padding.right + 4, refY + 3);
}

// Export for app.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderHistoryReviewDashboard, renderHistoryReviewCSS, drawHistoryReviewCanvases };
}
