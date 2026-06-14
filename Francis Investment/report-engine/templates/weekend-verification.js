/**
 * weekend-verification.js — 周末分析验证 UI 模板
 *
 * 渲染验证结果面板到 weekend analysis 页面底部。
 * 导出: renderWeekendVerificationCSS() + renderWeekendVerification(vData)
 */

// ==================== CSS ====================

function renderWeekendVerificationCSS() {
  return /*css*/`
/* === Verification Container === */
.wv-container {
  margin-top: 32px;
  border-top: 2px solid #8b5cf630;
  padding-top: 24px;
}

.wv-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 24px;
  flex-wrap: wrap;
}

.wv-header-title {
  font-size: 18px;
  font-weight: 700;
  color: #1e293b;
  display: flex;
  align-items: center;
  gap: 8px;
}

.wv-header-title .icon {
  font-size: 24px;
}

/* === Summary Card === */
.wv-summary {
  display: flex;
  align-items: center;
  gap: 24px;
  background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
  border: 1px solid #e2e8f0;
  border-radius: 16px;
  padding: 24px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.wv-grade-circle {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 36px;
  font-weight: 800;
  flex-shrink: 0;
  position: relative;
  animation: wvGradeIn 0.6s ease-out;
}

@keyframes wvGradeIn {
  from { transform: scale(0.3); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}

.wv-grade-circle.grade-A { background: #059669; color: #fff; box-shadow: 0 4px 20px #05966940; }
.wv-grade-circle.grade-B { background: #0284c7; color: #fff; box-shadow: 0 4px 20px #0284c740; }
.wv-grade-circle.grade-C { background: #d97706; color: #fff; box-shadow: 0 4px 20px #d9770640; }
.wv-grade-circle.grade-D { background: #ea580c; color: #fff; box-shadow: 0 4px 20px #ea580c40; }
.wv-grade-circle.grade-F { background: #dc2626; color: #fff; box-shadow: 0 4px 20px #dc262640; }

.wv-summary-info {
  flex: 1;
  min-width: 200px;
}

.wv-summary-score {
  font-size: 28px;
  font-weight: 700;
  color: #1e293b;
}

.wv-summary-label {
  font-size: 14px;
  color: #64748b;
  margin-top: 2px;
}

.wv-summary-subs {
  display: flex;
  gap: 12px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.wv-sub-badge {
  padding: 4px 12px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 600;
}

.wv-sub-badge.grade-A { background: #d1fae5; color: #065f46; }
.wv-sub-badge.grade-B { background: #dbeafe; color: #1e40af; }
.wv-sub-badge.grade-C { background: #fef3c7; color: #92400e; }
.wv-sub-badge.grade-D { background: #fed7aa; color: #9a3412; }
.wv-sub-badge.grade-F { background: #fee2e2; color: #991b1b; }
.wv-sub-badge.grade-na { background: #f1f5f9; color: #94a3b8; }

.wv-summary-trend {
  font-size: 13px;
  color: #64748b;
  margin-top: 8px;
}

.wv-trend-up { color: #059669; }
.wv-trend-down { color: #dc2626; }
.wv-trend-stable { color: #64748b; }

/* === Collapsible Panel === */
.wv-panel {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  margin-bottom: 16px;
  overflow: hidden;
  transition: box-shadow 0.2s;
}

.wv-panel:hover {
  box-shadow: 0 2px 8px #00000008;
}

.wv-panel-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  cursor: pointer;
  user-select: none;
  background: #fafbfc;
  transition: background 0.15s;
}

.wv-panel-header:hover {
  background: #f1f5f9;
}

.wv-panel-arrow {
  font-size: 12px;
  color: #94a3b8;
  transition: transform 0.25s;
  width: 16px;
  text-align: center;
}

.wv-panel.open .wv-panel-arrow {
  transform: rotate(90deg);
}

.wv-panel-title {
  font-size: 14px;
  font-weight: 600;
  color: #334155;
  flex: 1;
}

.wv-panel-badge {
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 700;
}

.wv-panel-badge.grade-A { background: #d1fae5; color: #065f46; }
.wv-panel-badge.grade-B { background: #dbeafe; color: #1e40af; }
.wv-panel-badge.grade-C { background: #fef3c7; color: #92400e; }
.wv-panel-badge.grade-D { background: #fed7aa; color: #9a3412; }
.wv-panel-badge.grade-F { background: #fee2e2; color: #991b1b; }

.wv-panel-body {
  padding: 0 18px 16px;
  display: none;
}

.wv-panel.open .wv-panel-body {
  display: block;
  animation: wvFadeIn 0.3s ease-out;
}

@keyframes wvFadeIn {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}

/* === Similarity Table === */
.wv-sim-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.wv-sim-table th {
  text-align: left;
  padding: 8px 10px;
  font-size: 11px;
  font-weight: 600;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-bottom: 1px solid #e2e8f0;
}

.wv-sim-table td {
  padding: 8px 10px;
  border-bottom: 1px solid #f1f5f9;
  color: #334155;
}

.wv-sim-table tr.ensemble-row {
  background: #f8fafc;
  font-weight: 600;
}

.wv-sim-table tr.ensemble-row td {
  border-top: 2px solid #8b5cf6;
  color: #1e293b;
}

.wv-cell-correct { color: #059669; font-weight: 600; }
.wv-cell-wrong { color: #dc2626; font-weight: 600; }
.wv-cell-grade-A { background: #d1fae5; color: #065f46; padding: 2px 8px; border-radius: 4px; font-weight: 600; }
.wv-cell-grade-B { background: #dbeafe; color: #1e40af; padding: 2px 8px; border-radius: 4px; font-weight: 600; }
.wv-cell-grade-C { background: #fef3c7; color: #92400e; padding: 2px 8px; border-radius: 4px; font-weight: 600; }
.wv-cell-grade-D { background: #fed7aa; color: #9a3412; padding: 2px 8px; border-radius: 4px; font-weight: 600; }
.wv-cell-grade-F { background: #fee2e2; color: #991b1b; padding: 2px 8px; border-radius: 4px; font-weight: 600; }

/* === Crisis Calibration === */
.wv-crisis-gauges {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.wv-gauge {
  flex: 1;
  min-width: 180px;
  background: #f8fafc;
  border-radius: 12px;
  padding: 16px;
  text-align: center;
}

.wv-gauge-value {
  font-size: 32px;
  font-weight: 700;
  color: #1e293b;
}

.wv-gauge-label {
  font-size: 12px;
  color: #94a3b8;
  margin-top: 4px;
}

.wv-gauge.predicted { border: 2px solid #8b5cf640; }
.wv-gauge.actual { border: 2px solid #10b98140; }

.wv-calib-badge {
  display: inline-block;
  padding: 6px 16px;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 600;
  margin-left: 8px;
}

.wv-calib-accurate { background: #d1fae5; color: #065f46; }
.wv-calib-slight { background: #fef3c7; color: #92400e; }
.wv-calib-over { background: #fee2e2; color: #991b1b; }

.wv-dim-bars {
  margin-top: 16px;
}

.wv-dim-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.wv-dim-name {
  width: 70px;
  font-size: 12px;
  color: #64748b;
  text-align: right;
  flex-shrink: 0;
}

.wv-dim-bar-wrap {
  flex: 1;
  height: 20px;
  background: #f1f5f9;
  border-radius: 10px;
  position: relative;
  overflow: visible;
}

.wv-dim-marker {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 12px;
  height: 12px;
  border-radius: 50%;
  z-index: 2;
}

.wv-dim-marker.predicted {
  background: #8b5cf6;
  box-shadow: 0 0 0 3px #8b5cf630;
}

.wv-dim-marker.actual {
  background: #10b981;
  border: 2px solid #fff;
  box-shadow: 0 0 0 3px #10b98130;
}

.wv-dim-match {
  font-size: 11px;
  width: 50px;
  text-align: left;
  flex-shrink: 0;
}

.wv-dim-match.good { color: #059669; }
.wv-dim-match.bad { color: #dc2626; }

.wv-rank-correlation {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #e2e8f0;
  font-size: 13px;
  color: #64748b;
}

.wv-rank-correlation strong {
  color: #1e293b;
}

/* === Sector Matrix === */
.wv-sector-legend {
  display: flex;
  gap: 16px;
  margin-bottom: 12px;
  font-size: 11px;
  color: #94a3b8;
}

.wv-sector-legend span {
  display: flex;
  align-items: center;
  gap: 4px;
}

.wv-sector-legend .dot {
  width: 10px;
  height: 10px;
  border-radius: 3px;
}

.wv-matrix-scroll {
  overflow-x: auto;
}

.wv-matrix {
  border-collapse: collapse;
  font-size: 11px;
}

.wv-matrix th, .wv-matrix td {
  width: 28px;
  height: 28px;
  text-align: center;
  vertical-align: middle;
}

.wv-matrix th {
  font-weight: 600;
  color: #64748b;
  white-space: nowrap;
  padding: 2px 4px;
  font-size: 10px;
}

.wv-matrix td {
  border-radius: 4px;
}

.wv-matrix td.correct { background: #d1fae5; }
.wv-matrix td.wrong { background: #fee2e2; }
.wv-matrix td.no-data { background: #f1f5f9; }
.wv-matrix td.no-pred { background: #fff; border: 1px solid #f1f5f9; }
.wv-matrix td.diagonal { background: transparent; }

.wv-phase-result {
  margin-top: 12px;
  font-size: 13px;
  color: #64748b;
}

.wv-phase-result .correct { color: #059669; font-weight: 600; }
.wv-phase-result .wrong { color: #dc2626; font-weight: 600; }

/* === Factor Cards === */
.wv-factor-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

@media (max-width: 720px) {
  .wv-factor-grid {
    grid-template-columns: 1fr;
  }
}

.wv-factor-card {
  background: #f8fafc;
  border: 2px solid #e2e8f0;
  border-radius: 10px;
  padding: 12px;
  transition: border-color 0.2s;
}

.wv-factor-card.correct { border-color: #05966940; }
.wv-factor-card.wrong { border-color: #dc262640; }

.wv-factor-id {
  font-size: 11px;
  color: #94a3b8;
  font-weight: 600;
}

.wv-factor-name {
  font-size: 14px;
  font-weight: 600;
  color: #1e293b;
  margin: 4px 0 8px;
}

.wv-factor-status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.wv-factor-status-label {
  color: #94a3b8;
  width: 24px;
}

.wv-factor-status-badge {
  padding: 2px 10px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 700;
}

.wv-factor-status-badge.hot { background: #d1fae5; color: #065f46; }
.wv-factor-status-badge.stable { background: #e2e8f0; color: #475569; }
.wv-factor-status-badge.cold { background: #fee2e2; color: #991b1b; }

.wv-factor-arrow {
  font-size: 14px;
  margin: 0 4px;
}

.wv-factor-arrow.correct { color: #059669; }
.wv-factor-arrow.wrong { color: #dc2626; }

.wv-factor-rate {
  font-size: 11px;
  color: #94a3b8;
  margin-top: 4px;
}

/* === Insights Verdicts === */
.wv-verdict-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.wv-verdict {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 13px;
}

.wv-verdict.good { background: #d1fae520; border: 1px solid #d1fae5; }
.wv-verdict.bad { background: #fee2e220; border: 1px solid #fee2e2; }
.wv-verdict.neutral { background: #f8fafc; border: 1px solid #e2e8f0; }

.wv-verdict-icon {
  font-size: 18px;
  flex-shrink: 0;
}

.wv-verdict-text {
  flex: 1;
  color: #334155;
}

.wv-verdict-text .title {
  font-weight: 600;
  color: #1e293b;
}

.wv-verdict-text .detail {
  font-size: 11px;
  color: #94a3b8;
}

/* === Weekly Trend Bars === */
.wv-trend-bars {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  height: 140px;
  padding: 0 8px;
  overflow-x: auto;
}

.wv-trend-bar-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  width: 48px;
}

.wv-trend-bar {
  width: 36px;
  border-radius: 6px 6px 0 0;
  transition: height 0.5s ease-out;
  min-height: 4px;
}

.wv-trend-bar.grade-A { background: linear-gradient(180deg, #059669, #34d399); }
.wv-trend-bar.grade-B { background: linear-gradient(180deg, #0284c7, #38bdf8); }
.wv-trend-bar.grade-C { background: linear-gradient(180deg, #d97706, #fbbf24); }
.wv-trend-bar.grade-D { background: linear-gradient(180deg, #ea580c, #fb923c); }
.wv-trend-bar.grade-F { background: linear-gradient(180deg, #dc2626, #f87171); }

.wv-trend-bar-label {
  font-size: 10px;
  color: #94a3b8;
}

.wv-trend-bar-score {
  font-size: 10px;
  font-weight: 600;
  color: #64748b;
}

/* === No Data === */
.wv-no-data {
  text-align: center;
  padding: 40px 20px;
  color: #94a3b8;
}

.wv-no-data .icon {
  font-size: 36px;
  margin-bottom: 8px;
}

.wv-no-data .text {
  font-size: 14px;
}

.wv-no-data .sub {
  font-size: 12px;
  margin-top: 4px;
  color: #cbd5e1;
}
`;
}

// ==================== HTML Renderer ====================

function renderWeekendVerification(vData) {
  if (!vData || !vData.ok || !vData.overall) {
    return _renderNoVerificationData();
  }

  var html = '<div class="wv-container">';
  html += '<div class="wv-header">';
  html += '<div class="wv-header-title"><span class="icon"></span>预测验证报告</div>';
  html += '</div>';

  // 1. Summary card
  html += _renderSummaryCard(vData);

  // 2. Similarity panel
  if (vData.similarity && vData.similarity.available) {
    html += _renderSimilarityPanel(vData.similarity);
  }

  // 3. Crisis calibration panel
  if (vData.crisis && vData.crisis.available) {
    html += _renderCrisisPanel(vData.crisis);
  }

  // 4. Sector rotation panel
  if (vData.sector && vData.sector.available) {
    html += _renderSectorPanel(vData.sector);
  }

  // 5. Factor performance panel
  if (vData.factor && vData.factor.available) {
    html += _renderFactorPanel(vData.factor);
  }

  // 6. Insights verdicts
  if (vData.insights && vData.insights.available) {
    html += _renderInsightsPanel(vData.insights);
  }

  // 7. Weekly trend (loaded via API separately)
  html += '<div id="wv-weekly-trend"></div>';

  html += '</div>';
  return html;
}

function _renderNoVerificationData() {
  return '<div class="wv-container">' +
    '<div class="wv-header">' +
    '<div class="wv-header-title"><span class="icon"></span>预测验证报告</div>' +
    '</div>' +
    '<div class="wv-no-data">' +
    '<div class="icon"></div>' +
    '<div class="text">暂无验证数据</div>' +
    '<div class="sub">验证报告将在完整交易周结束后自动生成</div>' +
    '</div></div>';
}

function _renderSummaryCard(vData) {
  var overall = vData.overall || {};
  var subScores = vData.subScores || {};
  var grade = overall.grade || '?';
  var score = overall.score || 0;

  var html = '<div class="wv-summary">';
  html += '<div class="wv-grade-circle grade-' + grade + '">' + grade + '</div>';
  html += '<div class="wv-summary-info">';
  html += '<div class="wv-summary-score">' + score + ' <span style="font-size:14px;color:#94a3b8;">/ 100</span></div>';
  html += '<div class="wv-summary-label">' + (overall.label || '') + '</div>';
  html += '<div class="wv-summary-subs">';

  var subKeys = ['similarity', 'crisis', 'sector', 'factor', 'insights'];
  var subLabels = { similarity: '相似度', crisis: '危机', sector: '板块', factor: '因子', insights: '洞察' };
  for (var i = 0; i < subKeys.length; i++) {
    var k = subKeys[i];
    var s = subScores[k];
    var g = s ? s.grade : null;
    html += '<span class="wv-sub-badge grade-' + (g || 'na') + '">' + subLabels[k];
    if (s && s.score != null) html += ' ' + s.score.toFixed(0);
    html += '</span>';
  }
  html += '</div>';

  if (vData.verifiedWeek) {
    html += '<div class="wv-summary-trend">验证周期: ' + vData.verifiedWeek.start + ' ~ ' + vData.verifiedWeek.end + '</div>';
  }

  html += '</div></div>';
  return html;
}

// ==================== Panel Helpers ====================

function _panelHeader(title, badgeGrade, subTitle) {
  var html = '<div class="wv-panel-header" onclick="toggleVerificationPanel(this)">';
  html += '<span class="wv-panel-arrow">></span>';
  html += '<span class="wv-panel-title">' + title + '</span>';
  if (badgeGrade) {
    html += '<span class="wv-panel-badge grade-' + badgeGrade + '">' + badgeGrade + '</span>';
  }
  if (subTitle) {
    html += '<span style="font-size:12px;color:#94a3b8;">' + subTitle + '</span>';
  }
  html += '</div>';
  html += '<div class="wv-panel-body">';
  return html;
}

function _panelFooter() {
  return '</div></div>';
}

// ==================== Similarity Panel ====================

function _renderSimilarityPanel(sim) {
  var grade = sim.overallGrade || '?';
  var sub = '方向 ' + sim.directionCorrectCount + '/' + sim.totalMatches;

  var html = '<div class="wv-panel open">';
  html += _panelHeader('历史相似度验证', grade, sub);

  // Ensemble results
  var ensemble = sim.ensemble || {};
  var horizons = ['5d', '10d', '20d'];
  var hLabels = { '5d': '5日', '10d': '10日', '20d': '20日' };

  html += '<table class="wv-sim-table">';
  html += '<tr><th>时间窗口</th><th>预测涨跌</th><th>实际涨跌</th><th>方向</th><th>误差</th><th>评级</th></tr>';

  for (var i = 0; i < horizons.length; i++) {
    var h = horizons[i];
    var e = ensemble[h];
    if (!e || !e.available) {
      if (e && !e.available) continue;
      html += '<tr><td>' + hLabels[h] + '</td><td colspan="5" style="color:#94a3b8;">数据不足</td></tr>';
      continue;
    }
    var dirIcon = e.directionCorrect ? '<span class="wv-cell-correct">[OK] 正确</span>' : '<span class="wv-cell-wrong">[X] 错误</span>';
    html += '<tr>';
    html += '<td><strong>' + hLabels[h] + '</strong></td>';
    html += '<td>' + (e.predicted >= 0 ? '+' : '') + e.predicted.toFixed(2) + '%</td>';
    html += '<td>' + (e.actual >= 0 ? '+' : '') + e.actual.toFixed(2) + '%</td>';
    html += '<td>' + dirIcon + '</td>';
    html += '<td>' + e.magnitudeError.toFixed(1) + '%</td>';
    html += '<td><span class="wv-cell-grade-' + e.grade + '">' + e.grade + '</span></td>';
    html += '</tr>';
  }

  // Individual matches
  var matches = sim.individualMatches || [];
  if (matches.length > 0) {
    html += '<tr style="background:#f8fafc;"><td colspan="6" style="font-size:12px;color:#94a3b8;padding:8px 10px;">各历史匹配 5 日预测验证</td></tr>';
    for (var j = 0; j < matches.length; j++) {
      var m = matches[j];
      var dirIcon2 = m.directionCorrect ? '<span class="wv-cell-correct">[OK]</span>' : '<span class="wv-cell-wrong">[X]</span>';
      var simPct = m.similarity ? (m.similarity.toFixed(0) + '%') : '';
      html += '<tr>';
      html += '<td style="font-size:11px;color:#94a3b8;">' + m.startDate + '~' + (m.endDate || '') + ' <span style="color:#64748b;">' + simPct + '</span></td>';
      html += '<td>' + (m.predicted5d >= 0 ? '+' : '') + m.predicted5d.toFixed(2) + '%</td>';
      html += '<td>' + (m.actual5d >= 0 ? '+' : '') + m.actual5d.toFixed(2) + '%</td>';
      html += '<td>' + dirIcon2 + '</td>';
      html += '<td>' + m.magnitudeError.toFixed(1) + '%</td>';
      html += '<td><span class="wv-cell-grade-' + m.grade + '">' + m.grade + '</span></td>';
      html += '</tr>';
    }
  }

  html += '</table>';
  html += _panelFooter();
  return html;
}

// ==================== Crisis Panel ====================

function _renderCrisisPanel(crisis) {
  var calibClass = crisis.calibration === '准确' ? 'wv-calib-accurate'
    : (crisis.calibration.indexOf('略') >= 0 ? 'wv-calib-slight' : 'wv-calib-over');

  var html = '<div class="wv-panel">';
  html += _panelHeader('危机预警校准', null, null);

  html += '<div class="wv-crisis-gauges">';
  html += '<div class="wv-gauge predicted">';
  html += '<div class="wv-gauge-value">' + crisis.predictedScore + '</div>';
  html += '<div class="wv-gauge-label">预测危机分</div>';
  html += '</div>';
  html += '<div class="wv-gauge actual">';
  html += '<div class="wv-gauge-value">' + crisis.actualRiskScore + '</div>';
  html += '<div class="wv-gauge-label">实际风险分<br><span style="font-size:10px;">回撤 ' + crisis.actualDrawdown.toFixed(1) + '%</span></div>';
  html += '</div>';
  html += '</div>';

  html += '<div style="font-size:14px;color:#334155;">校准: ';
  html += '<span class="wv-calib-badge ' + calibClass + '">' + crisis.calibration + '</span>';
  html += '<span style="font-size:12px;color:#94a3b8;margin-left:6px;">偏差 ' + (crisis.calibrationDiff > 0 ? '+' : '') + crisis.calibrationDiff + ' 分</span>';
  html += '</div>';

  // Dimension bars
  var dims = crisis.dimensionVerification || [];
  if (dims.length > 0) {
    html += '<div class="wv-dim-bars">';
    for (var i = 0; i < dims.length; i++) {
      var d = dims[i];
      var pLeft = Math.min(95, Math.max(5, d.predictedScore)) + '%';
      var aLeft = Math.min(95, Math.max(5, d.actualScore)) + '%';
      html += '<div class="wv-dim-row">';
      html += '<div class="wv-dim-name">' + d.name + '</div>';
      html += '<div class="wv-dim-bar-wrap">';
      html += '<div class="wv-dim-marker predicted" style="left:' + pLeft + ';" title="预测: ' + d.predictedScore + '"></div>';
      html += '<div class="wv-dim-marker actual" style="left:' + aLeft + ';" title="实际: ' + d.actualScore + '"></div>';
      html += '</div>';
      html += '<div class="wv-dim-match ' + (d.match ? 'good' : 'bad') + '">' + (d.match ? '接近' : '偏离') + '</div>';
      html += '</div>';
    }
    html += '</div>';
  }

  // Rank correlation
  if (crisis.rankCorrelation != null) {
    html += '<div class="wv-rank-correlation">多周排位相关性: <strong>' + crisis.rankCorrelation.toFixed(2) + '</strong> (' + crisis.rankCorrelationLabel + '，基于 ' + crisis.rankCorrelationWeeks + ' 周)</div>';
  } else {
    html += '<div class="wv-rank-correlation" style="color:#cbd5e1;">多周排位相关性: 需要至少 4 周验证数据</div>';
  }

  html += _panelFooter();
  return html;
}

// ==================== Sector Panel ====================

function _renderSectorPanel(sector) {
  var html = '<div class="wv-panel">';
  var sub = sector.overallPrecision != null
    ? '精确率 ' + (sector.overallPrecision * 100).toFixed(0) + '%'
    : null;
  html += _panelHeader('板块轮动验证', null, sub);

  // Legend
  html += '<div class="wv-sector-legend">';
  html += '<span><span class="dot" style="background:#05966920;border:1px solid #059669;"></span>领先/滞后正确</span>';
  html += '<span><span class="dot" style="background:#dc262620;border:1px solid #dc2626;"></span>领先/滞后错误</span>';
  html += '<span><span class="dot" style="background:#f1f5f9;"></span>数据不足</span>';
  html += '</div>';

  // Matrix
  var matrix = sector.matrixVerification || [];
  var names = sector.sectorNames || [];
  if (matrix.length > 0 && names.length > 0) {
    html += '<div class="wv-matrix-scroll"><table class="wv-matrix">';
    html += '<tr><th></th>';
    for (var c = 0; c < names.length; c++) {
      html += '<th>' + names[c].slice(0, 3) + '</th>';
    }
    html += '</tr>';

    for (var i = 0; i < matrix.length; i++) {
      html += '<tr>';
      html += '<th>' + (names[i] || '').slice(0, 3) + '</th>';
      for (var j = 0; j < (matrix[i] ? matrix[i].length : 0); j++) {
        var cell = matrix[i][j];
        var cls = 'no-pred';
        var symbol = '';
        if (cell.result === 'diagonal') { cls = 'diagonal'; symbol = ''; }
        else if (cell.result === 'tp_lead' || cell.result === 'tp_lag') { cls = 'correct'; symbol = '[OK]'; }
        else if (cell.result === 'fp_lead' || cell.result === 'fp_lag') { cls = 'wrong'; symbol = '[X]'; }
        else if (cell.result === 'tp_sync') { cls = 'correct'; symbol = '≈'; }
        else if (cell.result === 'fp_sync') { cls = 'wrong'; symbol = '≠'; }
        else if (cell.result === 'no_data') { cls = 'no-data'; symbol = '·'; }
        html += '<td class="' + cls + '">' + symbol + '</td>';
      }
      html += '</tr>';
    }
    html += '</table></div>';
  }

  // Phase result
  if (sector.phaseName) {
    var phaseCorrect = sector.phaseCorrect;
    html += '<div class="wv-phase-result">阶段判断: <strong>' + sector.phaseName + '</strong>';
    if (phaseCorrect != null) {
      html += ' → ' + (phaseCorrect
        ? '<span class="correct">[OK] 正确</span>'
        : '<span class="wrong">[X] 错误</span>');
    }
    html += '</div>';
  }

  html += _panelFooter();
  return html;
}

// ==================== Factor Panel ====================

function _renderFactorPanel(factor) {
  var grade = factor.overallAccuracy != null
    ? (factor.overallAccuracy >= 0.85 ? 'A' : factor.overallAccuracy >= 0.7 ? 'B' : factor.overallAccuracy >= 0.5 ? 'C' : 'D')
    : null;

  var html = '<div class="wv-panel">';
  html += _panelHeader('因子效能验证', grade, factor.summary);

  html += '<div class="wv-factor-grid">';
  var factors = factor.factors || [];
  for (var i = 0; i < factors.length; i++) {
    var f = factors[i];
    var isCorrect = f.statusCorrect;
    var cardCls = isCorrect == null ? '' : (isCorrect ? 'correct' : 'wrong');
    var arrowCls = isCorrect == null ? '' : (isCorrect ? 'correct' : 'wrong');
    var arrow = isCorrect == null ? '—' : (isCorrect ? '→' : '↛');

    html += '<div class="wv-factor-card ' + cardCls + '">';
    html += '<div class="wv-factor-id">' + f.id + '</div>';
    html += '<div class="wv-factor-name">' + f.name + '</div>';
    html += '<div class="wv-factor-status-row">';
    html += '<span class="wv-factor-status-label">预测</span>';
    html += '<span class="wv-factor-status-badge ' + f.predictedStatus.toLowerCase() + '">' + _statusCn(f.predictedStatus) + '</span>';
    html += '<span class="wv-factor-arrow ' + arrowCls + '">' + arrow + '</span>';
    html += '<span class="wv-factor-status-label">实际</span>';
    html += '<span class="wv-factor-status-badge ' + f.actualStatus.toLowerCase() + '">' + _statusCn(f.actualStatus) + '</span>';
    html += '</div>';
    if (f.predictedHitRate && f.actualHitRate) {
      html += '<div class="wv-factor-rate">命中: ' + f.predictedHitRate + ' → ' + f.actualHitRate + '</div>';
    }
    html += '</div>';
  }
  html += '</div>';

  html += _panelFooter();
  return html;
}

function _statusCn(s) {
  if (!s) return '未知';
  if (s === 'HOT') return '热门';
  if (s === 'COLD') return '冷门';
  return '稳定';
}

// ==================== Insights Panel ====================

function _renderInsightsPanel(insights) {
  var verdicts = insights.verdicts || [];
  var good = insights.goodCount || 0;
  var bad = insights.badCount || 0;
  var total = insights.totalVerifiable || 0;

  var sub = total > 0 ? '准确 ' + good + '/' + total : null;
  var html = '<div class="wv-panel">';
  html += _panelHeader('智能洞察验证', null, sub);

  html += '<div class="wv-verdict-list">';
  for (var i = 0; i < verdicts.length; i++) {
    var v = verdicts[i];
    var icon = v.outcome === 'good' ? '[OK]' : (v.outcome === 'bad' ? '[X]' : '-');
    var typeNames = {
      regime_alert: '风控预警',
      historical_parallel: '历史对比',
      sector_preference: '板块偏好',
      factor_preference: '因子偏好',
      position_sizing: '仓位建议',
      cross_market: '跨市场',
    };
    html += '<div class="wv-verdict ' + v.outcome + '">';
    html += '<div class="wv-verdict-icon">' + icon + '</div>';
    html += '<div class="wv-verdict-text">';
    html += '<div class="title">[' + (typeNames[v.type] || v.type) + '] ' + escHtml(v.title || '') + '</div>';
    html += '<div class="detail">' + escHtml(v.detail || '') + '</div>';
    html += '</div>';
    if (v.weight) {
      html += '<div style="font-size:11px;color:#94a3b8;">权重' + v.weight + '</div>';
    }
    html += '</div>';
  }
  html += '</div>';

  html += _panelFooter();
  return html;
}

// ==================== Helpers ====================

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ==================== Exports ====================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    renderWeekendVerificationCSS,
    renderWeekendVerification,
  };
}

// ==================== Global Toggle ====================

function toggleVerificationPanel(headerEl) {
  var panel = headerEl.parentElement;
  if (!panel) return;
  if (panel.classList.contains('open')) {
    panel.classList.remove('open');
  } else {
    panel.classList.add('open');
  }
}
