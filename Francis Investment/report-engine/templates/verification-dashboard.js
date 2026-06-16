// Verification Dashboard Template — v3.2
// Unified post-game verification view: factor signals, US predictions,
// expected returns, stock predictor, Rank IC.

function renderVerificationDashboard(data) {
  if (!data || !data.ok) {
    return '<div style="text-align:center;padding:60px;color:#94a3b8;">' +
      '<div style="font-size:48px;margin-bottom:16px;">--</div>' +
      '<div style="font-size:15px;">验证仪表板数据暂不可用</div>' +
      '<div style="font-size:12px;margin-top:8px;">需要积累足够的交易和预测数据</div>' +
      '</div>';
  }

  var html = '<div class="hr-wrapper">';

  // ===== Hero Bar =====
  html += '<div class="hr-hero">';
  var sum = data.summary || {};
  var hitColor = sum.overallHitRate >= 55 ? '#22c55e' : sum.overallHitRate >= 45 ? '#f59e0b' : '#ef4444';
  html += '<div class="hr-hero-stat"><div class="hr-hero-stat-val" style="color:' + hitColor + '">' +
    (sum.overallHitRate != null ? sum.overallHitRate + '%' : '--') + '</div>' +
    '<div class="hr-hero-stat-lbl">综合胜率</div></div>';
  html += '<div class="hr-hero-stat"><div class="hr-hero-stat-val">' +
    (sum.totalPredictions || 0) + '</div>' +
    '<div class="hr-hero-stat-lbl">总预测数</div></div>';
  html += '<div class="hr-hero-stat"><div class="hr-hero-stat-val" style="color:#6366f1;">' +
    (sum.rankIC != null ? sum.rankIC.toFixed(3) : '--') + '</div>' +
    '<div class="hr-hero-stat-lbl">Rank IC</div></div>';
  html += '<div class="hr-hero-stat"><div class="hr-hero-stat-val">' + (sum.dataQuality || '--') + '</div>' +
    '<div class="hr-hero-stat-lbl">数据质量</div></div>';
  html += '<div style="text-align:right;flex:1;font-size:10px;color:#94a3b8;">' +
    '生成: ' + (data.generatedAt || '').slice(0, 19).replace('T', ' ') + ' · 回看' + (data.lookbackDays || 60) + '天</div>';
  html += '</div>';

  // ===== Row 1: Factor Signal Verification =====
  html += '<div class="hr-section">';
  html += '<div class="hr-section-title">[FACTORS] 因子信号验证</div>';
  var fs = data.factorSignals || {};
  if (fs.available) {
    html += '<div style="margin-bottom:12px;font-size:12px;color:#64748b;">' +
      '总信号: ' + fs.totalSignals + ' · 综合胜率: <b>' + (fs.overallHitRate || '--') + '%</b> · ' +
      '数据天数: ' + (fs.daysAvailable || 0) + '</div>';
    // Factor table
    if (fs.factors && fs.factors.length > 0) {
      html += '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:11px;">';
      html += '<thead><tr style="border-bottom:2px solid #e5e7eb;">' +
        '<th style="text-align:left;padding:4px 8px;">因子</th>' +
        '<th style="text-align:center;padding:4px 8px;">胜率</th>' +
        '<th style="text-align:right;padding:4px 8px;">均收益</th>' +
        '<th style="text-align:center;padding:4px 8px;">信号数</th>' +
        '<th style="text-align:center;padding:4px 8px;">状态</th>' +
        '</tr></thead><tbody>';
      for (var fi = 0; fi < fs.factors.length; fi++) {
        var f = fs.factors[fi];
        var c = f.hitRate >= 55 ? '#16a34a' : f.hitRate >= 40 ? '#94a3b8' : '#dc2626';
        var sc = f.status === 'hot' ? '#16a34a' : f.status === 'cold' ? '#dc2626' : '#94a3b8';
        html += '<tr style="border-bottom:1px solid #f1f5f9;">' +
          '<td style="padding:4px 8px;font-weight:600;">' + (f.id || '') + ' ' + (f.name || '') + '</td>' +
          '<td style="text-align:center;font-weight:700;color:' + c + ';">' + (f.hitRate != null ? f.hitRate + '%' : '--') + '</td>' +
          '<td style="text-align:right;color:' + (f.avgReturn > 0 ? '#16a34a' : '#dc2626') + ';">' +
            (f.avgReturn != null ? (f.avgReturn > 0 ? '+' : '') + f.avgReturn + '%' : '--') + '</td>' +
          '<td style="text-align:center;">' + f.signalCount + '</td>' +
          '<td style="text-align:center;color:' + sc + ';font-weight:600;">[' + (f.status || 'stable').toUpperCase() + ']</td>' +
          '</tr>';
      }
      html += '</tbody></table></div>';
    }
  } else {
    html += '<div style="color:#94a3b8;font-size:12px;">' + (fs.message || '因子验证数据积累中') + '</div>';
  }
  html += '</div>';

  // ===== Row 2: US-to-A Prediction =====
  html += '<div class="hr-section">';
  html += '<div class="hr-section-title">[CROSS] 跨市场预测验证 (美股→A股)</div>';
  var us = data.usPredict || {};
  if (us.available) {
    html += '<div class="hr-mini-card" style="margin-bottom:12px;"><div class="hr-mini-card-title">US预测综合</div>' +
      '<div class="hr-mini-card-val" style="font-size:22px;">胜率 ' + (us.overallHitRate || '--') + '%</div>' +
      '<div class="hr-mini-card-sub">' + (us.totalCorrect || 0) + '/' + (us.totalPredictions || 0) + ' 正确 · ' + (us.totalEntries || 0) + '天</div>' +
      '</div>';
    if (us.recentEntries && us.recentEntries.length > 0) {
      html += '<div style="font-size:10px;color:#64748b;">最近验证:</div>';
      html += '<div class="hr-verif-history" style="height:80px;">';
      for (var ui = 0; ui < us.recentEntries.length; ui++) {
        var ue = us.recentEntries[ui];
        var barH = Math.max(4, (ue.hitRate || 0) * 0.6);
        html += '<div class="hr-verif-bar-wrap"><div class="hr-verif-bar" style="height:' + barH + 'px;background:' +
          (ue.hitRate >= 50 ? '#16a34a' : '#dc2626') + ';"></div>' +
          '<div class="hr-verif-bar-label">' + (ue.date || '').slice(5) + '</div></div>';
      }
      html += '</div>';
    }
  } else {
    html += '<div style="color:#94a3b8;font-size:12px;">' + (us.message || 'US预测验证数据积累中') + '</div>';
  }
  html += '</div>';

  // ===== Row 3: Expected Return Accuracy =====
  html += '<div class="hr-section">';
  html += '<div class="hr-section-title">[PREDICT] 期望收益预测验证</div>';
  var er = data.expectedReturn || {};
  if (er.available) {
    html += '<div class="hr-cards-4" style="margin-bottom:12px;">';
    html += '<div class="hr-mini-card"><div class="hr-mini-card-title">方向命中率</div>' +
      '<div class="hr-mini-card-val">' + (er.overallHitRate || '--') + '%</div>' +
      '<div class="hr-mini-card-sub">' + (er.totalCorrect || 0) + '/' + (er.totalPredictions || 0) + ' 次</div></div>';
    html += '<div class="hr-mini-card"><div class="hr-mini-card-title">平均误差</div>' +
      '<div class="hr-mini-card-val">' + (er.avgError != null ? er.avgError + '%' : '--') + '</div></div>';
    html += '</div>';
    if (er.recentEntries && er.recentEntries.length > 0) {
      html += '<div style="font-size:10px;color:#64748b;">最近:</div>';
      for (var ei = 0; ei < Math.min(5, er.recentEntries.length); ei++) {
        var ere = er.recentEntries[ei];
        html += '<span style="margin-right:12px;font-size:11px;">' + (ere.date || '').slice(5) +
          ': 胜率<b>' + (ere.hitRate || '--') + '%</b> (' + (ere.correct || 0) + '/' + (ere.total || 0) + ')</span>';
      }
    }
  } else {
    html += '<div style="color:#94a3b8;font-size:12px;">' + (er.message || '期望收益验证数据积累中') + '</div>';
  }
  html += '</div>';

  // ===== Row 4: Stock Predictor =====
  html += '<div class="hr-section">';
  html += '<div class="hr-section-title">[STOCK] 个股预测验证</div>';
  var sp = data.stockPredictor || {};
  if (sp.available) {
    html += '<div style="margin-bottom:12px;font-size:12px;color:#64748b;">' +
      '总记录: ' + sp.totalRecords + ' · 覆盖天数: ' + (sp.totalDays || '--') + ' · ' +
      '综合胜率: <b>' + (sp.overallHitRate || '--') + '%</b></div>';
    if (sp.factors && sp.factors.length > 0) {
      for (var si = 0; si < Math.min(5, sp.factors.length); si++) {
        var sf = sp.factors[si];
        html += '<div style="display:inline-block;margin:4px 12px 4px 0;font-size:11px;">' +
          '<b>' + sf.id + '</b>: ' + (sf.hitRate || '--') + '% · ' + sf.samples + '样本</div>';
      }
    }
  } else {
    html += '<div style="color:#94a3b8;font-size:12px;">' + (sp.message || '个股预测验证数据积累中') + '</div>';
  }
  html += '</div>';

  // ===== Row 5: Rank IC =====
  html += '<div class="hr-section">';
  html += '<div class="hr-section-title">[STATS] 预测质量统计</div>';
  var ric = data.rankIC || {};
  if (ric.available) {
    html += '<div class="hr-mini-card"><div class="hr-mini-card-title">Rank IC (Spearman)</div>' +
      '<div class="hr-mini-card-val" style="font-size:28px;">' + ric.rankIC.toFixed(3) + '</div>' +
      '<div class="hr-mini-card-sub">' + (ric.description || '') + ' · ' + (ric.samples || 0) + '样本</div></div>';
  } else {
    html += '<div style="color:#94a3b8;font-size:12px;">' + (ric.message || 'Rank IC数据积累中(需≥10条有效记录)') + '</div>';
  }
  html += '</div>';

  html += '</div>';
  return html;
}
