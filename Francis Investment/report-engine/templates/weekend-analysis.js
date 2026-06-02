/**
 * weekend-analysis.js — Weekend Deep Analysis Panel Template
 * Pure HTML string generation, zero dependencies, consistent with cross-market.js style
 * No emoji — clean text-based UI.
 */

function renderWeekendAnalysisCSS() {
  return `
/* ===== Weekend Analysis Dashboard ===== */
.wa-dashboard {
  padding: 20px 24px;
  max-width: 1100px;
  margin: 0 auto;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  color: #1e293b;
}

/* -- Status Card -- */
.wa-status-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 20px;
  background: linear-gradient(135deg, #faf5ff, #ede9fe);
  border: 1px solid #ddd6fe;
  border-radius: 14px;
  margin-bottom: 20px;
}
.wa-status-icon {
  width: 48px; height: 48px;
  border-radius: 12px;
  background: linear-gradient(135deg, #8b5cf6, #a78bfa);
  display: flex; align-items: center; justify-content: center;
  font-size: 20px; font-weight: 700; color: #fff;
  flex-shrink: 0;
  box-shadow: 0 4px 12px rgba(139,92,246,0.3);
}
.wa-status-info { flex: 1; }
.wa-status-title { font-size: 15px; font-weight: 700; color: #5b21b6; }
.wa-status-meta { font-size: 12px; color: #7c3aed; margin-top: 2px; }
.wa-status-badge {
  padding: 4px 12px; border-radius: 20px; font-size: 11px; font-weight: 600;
  background: #c4b5fd; color: #5b21b6;
}
.wa-status-badge.running { background: #a7f3d0; color: #065f46; animation: waPulse 2s infinite; }
@keyframes waPulse { 0%,100% { opacity:1; } 50% { opacity:0.6; } }

/* -- Section Title -- */
.wa-section-title {
  font-size: 14px; font-weight: 700; color: #475569;
  margin: 24px 0 12px 0;
  padding-left: 12px; border-left: 3px solid #8b5cf6;
}

/* -- Similarity Cards -- */
.wa-sim-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
  margin-bottom: 8px;
}
.wa-sim-card {
  background: #fff; border: 1px solid #e2e8f0; border-radius: 14px;
  padding: 16px; transition: all 0.2s;
}
.wa-sim-card:hover { border-color: #c4b5fd; box-shadow: 0 2px 12px rgba(139,92,246,0.1); }
.wa-sim-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.wa-sim-date { font-size: 13px; font-weight: 600; color: #334155; }
.wa-sim-score {
  font-size: 18px; font-weight: 800;
  background: linear-gradient(135deg, #8b5cf6, #6d28d9);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  background-clip: text;
}
.wa-sim-label {
  font-size: 10px; color: #8b5cf6; font-weight: 600; margin-left: 4px;
}
.wa-sim-future { margin-top: 10px; }
.wa-sim-future-label { font-size: 11px; color: #94a3b8; margin-bottom: 4px; }
.wa-sim-future-row { display: flex; gap: 12px; font-size: 12px; }
.wa-sim-future-item { text-align: center; flex: 1; padding: 6px 8px; border-radius: 8px; background: #f8fafc; }
.wa-sim-future-val { font-weight: 700; font-size: 14px; }
.wa-sim-future-val.up { color: #059669; }
.wa-sim-future-val.down { color: #dc2626; }
.wa-sim-future-val.neutral { color: #64748b; }
.wa-sim-canvas { width: 100%; height: 70px; margin-top: 8px; }

/* -- Crisis Dashboard -- */
.wa-crisis-wrap {
  background: #fff; border: 1px solid #e2e8f0; border-radius: 14px;
  padding: 20px; margin-bottom: 8px;
}
.wa-crisis-top { display: flex; align-items: center; gap: 20px; margin-bottom: 16px; }
.wa-crisis-big {
  width: 90px; height: 90px; border-radius: 50%;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  font-weight: 800; flex-shrink: 0;
}
.wa-crisis-big.danger { background: #fef2f2; border: 3px solid #ef4444; color: #dc2626; }
.wa-crisis-big.warning { background: #fffbeb; border: 3px solid #f59e0b; color: #d97706; }
.wa-crisis-big.ok { background: #f0fdf4; border: 3px solid #10b981; color: #059669; }
.wa-crisis-big-num { font-size: 32px; line-height: 1; }
.wa-crisis-big-label { font-size: 11px; margin-top: 2px; }
.wa-crisis-desc { font-size: 13px; color: #475569; line-height: 1.5; }
.wa-dim-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.wa-dim-item {}
.wa-dim-name { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px; }
.wa-dim-label { color: #64748b; }
.wa-dim-val { font-weight: 600; }
.wa-dim-bar { height: 6px; background: #f1f5f9; border-radius: 3px; overflow: hidden; }
.wa-dim-fill { height: 100%; border-radius: 3px; transition: width 0.5s; }
.wa-dim-fill.danger { background: #ef4444; }
.wa-dim-fill.warning { background: #f59e0b; }
.wa-dim-fill.ok { background: #10b981; }
.wa-dim-detail { font-size: 10px; color: #94a3b8; margin-top: 2px; }

/* -- Sector Rotation -- */
.wa-rotation-wrap {
  background: #fff; border: 1px solid #e2e8f0; border-radius: 14px;
  padding: 20px; margin-bottom: 8px;
}
.wa-rotation-phase {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 8px 16px; border-radius: 20px;
  background: #ede9fe; color: #5b21b6;
  font-size: 13px; font-weight: 600; margin-bottom: 16px;
}
.wa-matrix-scroll { overflow-x: auto; }
.wa-matrix { border-collapse: collapse; font-size: 11px; width: 100%; min-width: 500px; }
.wa-matrix th, .wa-matrix td { padding: 6px 8px; text-align: center; border: 1px solid #f1f5f9; }
.wa-matrix th { background: #f8fafc; color: #64748b; font-weight: 600; white-space: nowrap; }
.wa-matrix td.lead { background: #dcfce7; color: #059669; font-weight: 600; }
.wa-matrix td.lag { background: #fef2f2; color: #dc2626; font-weight: 600; }
.wa-matrix td.sync { background: #fefce8; color: #a16207; font-weight: 600; }
.wa-matrix td.na { color: #cbd5e1; }
.wa-matrix td.diag { background: #f8fafc; color: #cbd5e1; }

/* -- Factor Performance -- */
.wa-factor-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 10px;
}
.wa-factor-card {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 16px; border-radius: 12px;
  background: #fff; border: 1px solid #e2e8f0;
}
.wa-factor-card:hover { border-color: #c4b5fd; }
.wa-factor-badge {
  width: 44px; height: 44px; border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  font-weight: 800; font-size: 12px; flex-shrink: 0;
}
.wa-factor-badge.HOT { background: #dcfce7; color: #059669; }
.wa-factor-badge.STABLE { background: #f1f5f9; color: #64748b; }
.wa-factor-badge.COLD { background: #fef2f2; color: #dc2626; }
.wa-factor-info { flex: 1; min-width: 0; }
.wa-factor-name { font-size: 13px; font-weight: 600; color: #334155; }
.wa-factor-meta { font-size: 11px; color: #94a3b8; margin-top: 2px; }
.wa-factor-stats { text-align: right; }
.wa-factor-hit { font-size: 18px; font-weight: 700; color: #1e293b; }
.wa-factor-hit-label { font-size: 10px; color: #94a3b8; }

/* -- Insights Section -- */
.wa-insights-list { display: flex; flex-direction: column; gap: 8px; }
.wa-insight-card {
  display: flex; align-items: flex-start; gap: 12px;
  padding: 14px 16px; border-radius: 12px;
  background: #fff; border: 1px solid #e2e8f0;
}
.wa-insight-icon {
  font-size: 11px; font-weight: 700; flex-shrink: 0; margin-top: 2px;
  padding: 4px 8px; border-radius: 6px; color: #fff;
  white-space: nowrap;
}
.wa-insight-icon.alert { background: #ef4444; }
.wa-insight-icon.history { background: #8b5cf6; }
.wa-insight-icon.factor { background: #f59e0b; }
.wa-insight-icon.risk { background: #dc2626; }
.wa-insight-icon.sector { background: #10b981; }
.wa-insight-icon.cross { background: #3b82f6; }
.wa-insight-icon.default { background: #94a3b8; }
.wa-insight-content { flex: 1; }
.wa-insight-title { font-size: 13px; font-weight: 600; color: #1e293b; }
.wa-insight-detail { font-size: 12px; color: #64748b; margin-top: 2px; line-height: 1.4; }
.wa-insight-action {
  font-size: 11px; color: #7c3aed; margin-top: 4px;
  padding: 2px 8px; border-radius: 6px; background: #f5f3ff;
  display: inline-block;
}

/* -- Empty / Error States -- */
.wa-empty {
  text-align: center; padding: 60px 20px; color: #94a3b8;
}
.wa-empty-icon {
  width: 56px; height: 56px; border-radius: 50%;
  background: #f1f5f9; margin: 0 auto 16px;
  display: flex; align-items: center; justify-content: center;
  font-size: 20px; color: #94a3b8;
}
.wa-empty-msg { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
.wa-empty-sub { font-size: 12px; }

/* Mobile */
@media (max-width: 720px) {
  .wa-dashboard { padding: 12px 14px; }
  .wa-sim-grid { grid-template-columns: 1fr; }
  .wa-crisis-top { flex-direction: column; align-items: flex-start; }
  .wa-dim-grid { grid-template-columns: repeat(2, 1fr); }
  .wa-factor-grid { grid-template-columns: 1fr; }
}
`;
}

function renderWeekendAnalysis(data, mode, reportData) {
  if (!data || !data.status) {
    return `<div class="wa-empty">
      <div class="wa-empty-icon">WA</div>
      <div class="wa-empty-msg">周末分析引擎未运行</div>
      <div class="wa-empty-sub">引擎在周六/周日自动启动分析</div>
      </div>`;
  }

  let html = '<div class="wa-dashboard">';

  // ===== 1. Status Card =====
  const isRunning = data.status === 'running' || data.status === 'phase1_aggregation'
    || data.status === 'phase2_history' || data.status === 'phase3_analysis'
    || data.status === 'phase4_context';
  const isComplete = data.status === 'complete';
  const statusLabel = isRunning ? '分析中...' : isComplete ? '已完成' : '空闲';
  const statusCls = isRunning ? 'running' : '';
  const lastRunStr = data.lastRun ? new Date(data.lastRun).toLocaleString('zh-CN') : '尚未完成';

  html += `<div class="wa-status-card">
    <div class="wa-status-icon">WA</div>
    <div class="wa-status-info">
      <div class="wa-status-title">周末深度分析引擎</div>
      <div class="wa-status-meta">第 ${data.cycles || 0} 轮 &middot; 最近更新: ${lastRunStr}</div>
    </div>
    <div class="wa-status-badge ${statusCls}">${statusLabel}</div>
    </div>`;

  // ===== 2. Historical Similarity =====
  if (data.similarity && data.similarity.length > 0) {
    html += '<div class="wa-section-title">历史相似度匹配</div>';
    html += '<div class="wa-sim-grid">';

    for (let i = 0; i < data.similarity.length; i++) {
      const sim = data.similarity[i];
      const simLabelText = sim.simLabel === 'very_high' ? '极高'
        : sim.simLabel === 'high' ? '较高'
        : sim.simLabel === 'moderate' ? '中等' : '较低';
      html += `<div class="wa-sim-card">
        <div class="wa-sim-header">
          <div class="wa-sim-date">${sim.startDate} - ${sim.endDate}</div>
          <div><span class="wa-sim-score">${sim.similarity}%</span><span class="wa-sim-label">${simLabelText}</span></div>
        </div>`;
      if (sim.future5d) {
        const cls5 = sim.future5d.label.includes('bullish') ? 'up' : sim.future5d.label.includes('bearish') ? 'down' : 'neutral';
        html += `<div class="wa-sim-future">
          <div class="wa-sim-future-label">历史后续表现</div>
          <div class="wa-sim-future-row">
            <div class="wa-sim-future-item">
              <div style="font-size:10px;color:#94a3b8;">5日</div>
              <div class="wa-sim-future-val ${cls5}">${sim.future5d.total > 0 ? '+' : ''}${sim.future5d.total}%</div>
            </div>`;
        if (sim.future10d) {
          const cls10 = sim.future10d.label.includes('bullish') ? 'up' : sim.future10d.label.includes('bearish') ? 'down' : 'neutral';
          html += `<div class="wa-sim-future-item">
            <div style="font-size:10px;color:#94a3b8;">10日</div>
            <div class="wa-sim-future-val ${cls10}">${sim.future10d.total > 0 ? '+' : ''}${sim.future10d.total}%</div>
          </div>`;
        }
        if (sim.future20d) {
          const cls20 = sim.future20d.label.includes('bullish') ? 'up' : sim.future20d.label.includes('bearish') ? 'down' : 'neutral';
          html += `<div class="wa-sim-future-item">
            <div style="font-size:10px;color:#94a3b8;">20日</div>
            <div class="wa-sim-future-val ${cls20}">${sim.future20d.total > 0 ? '+' : ''}${sim.future20d.total}%</div>
          </div>`;
        }
        html += '</div>';

        // Mini sparkline canvas
        if (sim.future5d && sim.future5d.cumulative) {
          html += `<canvas class="wa-sim-canvas" id="wa-spark-${i}" data-values="${sim.future5d.cumulative.join(',')}"></canvas>`;
        }
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
  } else {
    html += '<div class="wa-section-title">历史相似度匹配</div>';
    html += '<div class="wa-empty"><div class="wa-empty-msg" style="font-size:13px;">历史数据积累中 -- 需要更多数据才能进行相似度计算</div></div>';
  }

  // ===== 3. Crisis Warning =====
  if (data.crisisWarning) {
    const cw = data.crisisWarning;
    const bigCls = cw.score >= 75 ? 'danger' : cw.score >= 60 ? 'warning' : 'ok';
    html += '<div class="wa-section-title">危机预警指标</div>';
    html += '<div class="wa-crisis-wrap">';
    html += `<div class="wa-crisis-top">
      <div class="wa-crisis-big ${bigCls}">
        <div class="wa-crisis-big-num">${cw.score}</div>
        <div class="wa-crisis-big-label">/ 100</div>
      </div>
      <div class="wa-crisis-desc">${escHtml(cw.label)}</div>
      </div>`;
    html += '<div class="wa-dim-grid">';
    for (const dim of (cw.dimensions || [])) {
      const fillCls = dim.score >= 75 ? 'danger' : dim.score >= 60 ? 'warning' : 'ok';
      html += `<div class="wa-dim-item">
        <div class="wa-dim-name"><span class="wa-dim-label">${escHtml(dim.name)} (${(dim.weight*100).toFixed(0)}%)</span><span class="wa-dim-val">${dim.score}</span></div>
        <div class="wa-dim-bar"><div class="wa-dim-fill ${fillCls}" style="width:${dim.score}%"></div></div>
        <div class="wa-dim-detail">${escHtml(dim.detail || '')}</div>
        </div>`;
    }
    html += '</div></div>';
  }

  // ===== 4. Sector Rotation =====
  if (data.sectorRotation) {
    const rot = data.sectorRotation;
    html += '<div class="wa-section-title">板块轮动分析</div>';
    html += '<div class="wa-rotation-wrap">';
    if (rot.currentPhase) {
      html += `<div class="wa-rotation-phase">阶段: ${escHtml(rot.currentPhase.phase)} -- ${escHtml(rot.currentPhase.description)}</div>`;
    }
    html += '<div class="wa-matrix-scroll"><table class="wa-matrix"><thead><tr><th></th>';
    for (const s of rot.sectors) {
      html += `<th>${escHtml(s.slice(0, 6))}</th>`;
    }
    html += '</tr></thead><tbody>';
    for (let i = 0; i < rot.sectors.length; i++) {
      html += `<tr><th>${escHtml(rot.sectors[i].slice(0, 6))}</th>`;
      for (let j = 0; j < rot.sectors.length; j++) {
        const cell = (rot.matrix[i] && rot.matrix[i][j]) ? rot.matrix[i][j] : { rel: '-', score: 0 };
        let cls = 'na';
        if (i === j) cls = 'diag';
        else if (cell.rel === '领先') cls = 'lead';
        else if (cell.rel === '滞后') cls = 'lag';
        else if (cell.rel === '同步') cls = 'sync';
        let displayText = i === j ? '--' : cell.rel;
        html += `<td class="${cls}">${displayText}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table></div></div>';
  }

  // ===== 5. Factor Performance =====
  if (data.factorPerformance && data.factorPerformance.length > 0) {
    html += '<div class="wa-section-title">因子效能回顾</div>';
    html += '<div class="wa-factor-grid">';
    for (const f of data.factorPerformance) {
      const hitStr = f.hitRate != null ? (f.hitRate * 100).toFixed(0) + '%' : '--';
      const statusText = f.status === 'HOT' ? '热门' : f.status === 'COLD' ? '冷门' : '稳定';
      html += `<div class="wa-factor-card">
        <div class="wa-factor-badge ${f.status}">${statusText}</div>
        <div class="wa-factor-info">
          <div class="wa-factor-name">${escHtml(f.id)} ${escHtml(f.name)}</div>
          <div class="wa-factor-meta">${escHtml(f.category)} &middot; ${f.count} 次信号</div>
        </div>
        <div class="wa-factor-stats">
          <div class="wa-factor-hit">${hitStr}</div>
          <div class="wa-factor-hit-label">命中率</div>
        </div>
        </div>`;
    }
    html += '</div>';
  }

  // ===== 6. Insights & Trading Suggestions =====
  if (data.insights && data.insights.length > 0) {
    html += '<div class="wa-section-title">AI分析洞察 & 周一交易建议</div>';
    html += '<div class="wa-insights-list">';
    for (const ins of data.insights) {
      const iconClsMap = {
        regime_alert: 'alert',
        historical_parallel: 'history',
        factor_preference: 'factor',
        position_sizing: 'risk',
        sector_preference: 'sector',
        cross_market: 'cross',
      };
      const iconCls = iconClsMap[ins.type] || 'default';
      const iconLabelMap = {
        regime_alert: '预警',
        historical_parallel: '历史',
        factor_preference: '因子',
        position_sizing: '风控',
        sector_preference: '板块',
        cross_market: '跨市',
      };
      const iconLabel = iconLabelMap[ins.type] || '信息';
      html += `<div class="wa-insight-card">
        <div class="wa-insight-icon ${iconCls}">${iconLabel}</div>
        <div class="wa-insight-content">
          <div class="wa-insight-title">${escHtml(ins.title)}</div>
          <div class="wa-insight-detail">${escHtml(ins.detail)}</div>
          <div class="wa-insight-action">建议: ${escHtml(ins.suggestedAction)}</div>
        </div>
        </div>`;
    }
    html += '</div>';
  }

  html += '</div>'; // .wa-dashboard
  return html;
}

// Export for use in app.js and server-side rendering
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderWeekendAnalysis, renderWeekendAnalysisCSS };
}
