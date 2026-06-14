// Recommendation History Panel — renderRecommendationHistory()
// Displays all stocks in the recommendation database with 6-dimension scores

function renderRecommendationHistory() {
  var hist = window.__RECOMMENDATION_HISTORY__;
  if (!hist || !hist.history || hist.history.length === 0) {
    return '<div class="content-placeholder"><p>暂无推荐历史记录</p></div>';
  }

  var stocks = hist.history.slice();
  // Sort by compositeScore descending, ties broken by newer recommendation first
  stocks.sort(function(a, b) {
    if (b.compositeScore !== a.compositeScore) return b.compositeScore - a.compositeScore;
    return (b.firstRecommended || '').localeCompare(a.firstRecommended || '');
  });

  var html = '';

  // Header
  html += '<div style="padding:20px 24px 12px;display:flex;justify-content:space-between;align-items:center;">';
  html += '<div>';
  html += '<span style="font-size:18px;font-weight:700;">推荐历史数据库</span>';
  html += '<span style="margin-left:10px;font-size:12px;color:var(--text-muted);">共 ' + stocks.length + ' 只（上限 ' + (hist.maxStocks || 50) + ' 只）</span>';
  html += '</div>';
  html += '<button onclick="parent.closeRecommendationHistory()" style="background:none;border:1px solid var(--border);border-radius:6px;padding:5px 14px;cursor:pointer;font-size:13px;color:var(--text-muted);">x 关闭</button>';
  html += '</div>';

  // Legend
  html += '<div style="padding:0 24px 8px;display:flex;gap:14px;font-size:11px;color:var(--text-muted);">';
  html += '<span>评级：<span style="color:#1a7a2e;font-weight:700;">S 85+</span></span>';
  html += '<span><span style="color:#2e7d32;font-weight:700;">A 75-84</span></span>';
  html += '<span><span style="color:#f57f17;font-weight:700;">B 60-74</span></span>';
  html += '<span><span style="color:#e65100;font-weight:700;">C 45-59</span></span>';
  html += '<span><span style="color:#c62828;font-weight:700;">D &lt;45</span></span>';
  html += '</div>';

  // Table
  html += '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
  html += '<thead style="position:sticky;top:0;z-index:1;">';
  html += '<tr style="background:#f5f6fa;text-align:left;">';
  html += '<th style="padding:10px 8px 10px 24px;font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;">#</th>';
  html += '<th style="padding:10px 8px;font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;">代码</th>';
  html += '<th style="padding:10px 8px;font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;">名称</th>';
  html += '<th style="padding:10px 8px;font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;">板块</th>';
  html += '<th style="padding:10px 8px;font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;">推荐日</th>';
  html += '<th style="padding:10px 8px;font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;">推荐价</th>';
  html += '<th style="padding:10px 8px;font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;">PE</th>';
  html += '<th style="padding:10px 8px;font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;text-align:center;">综合分</th>';
  html += '<th style="padding:10px 8px;font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;text-align:center;">评级</th>';
  html += '<th style="padding:10px 24px 10px 8px;font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;">核心理由</th>';
  html += '</tr></thead><tbody>';

  for (var i = 0; i < stocks.length; i++) {
    var s = stocks[i];
    var score = s.compositeScore || 0;
    var rating, ratingColor;
    if (score >= 85) { rating = 'S'; ratingColor = '#1a7a2e'; }
    else if (score >= 75) { rating = 'A'; ratingColor = '#2e7d32'; }
    else if (score >= 60) { rating = 'B'; ratingColor = '#f57f17'; }
    else if (score >= 45) { rating = 'C'; ratingColor = '#e65100'; }
    else { rating = 'D'; ratingColor = '#c62828'; }

    // Score color intensity
    var scoreBg;
    if (score >= 80) scoreBg = '#e8f5e9';
    else if (score >= 70) scoreBg = '#fffde7';
    else if (score >= 60) scoreBg = '#fff8e1';
    else scoreBg = '#fff3e0';

    var dims = s.dimensionScores || {};
    var dimNames = ['财务报表', 'K线技术面', '公司治理', '产业逻辑', '机构态度', '资金面'];
    var dimTooltip = '';
    for (var d = 0; d < dimNames.length; d++) {
      var dn = dimNames[d];
      var dv = dims[dn] || 0;
      if (d > 0) dimTooltip += ', ';
      dimTooltip += dn.substring(0,2) + ':' + dv.toFixed(1);
    }

    var peStr = s.peAtRec != null ? (s.peAtRec + '') : '亏损';
    var rowBg = i % 2 === 0 ? '#fff' : '#fafbfc';

    html += '<tr style="background:' + rowBg + ';border-bottom:1px solid #eef0f4;" title="' + escHtml(dimTooltip) + '">';
    html += '<td style="padding:10px 8px 10px 24px;font-weight:700;color:var(--text-muted);">' + (i + 1) + '</td>';
    html += '<td style="padding:10px 8px;font-family:monospace;font-size:12px;">' + s.code + '</td>';
    html += '<td style="padding:10px 8px;font-weight:600;">' + escHtml(s.name) + '</td>';
    html += '<td style="padding:10px 8px;font-size:12px;color:var(--text-muted);">' + escHtml(s.sector || '') + '</td>';
    html += '<td style="padding:10px 8px;font-size:12px;color:var(--text-muted);">' + (s.firstRecommended || '') + '</td>';
    html += '<td style="padding:10px 8px;font-size:12px;">' + (s.priceAtRec || '-') + '</td>';
    html += '<td style="padding:10px 8px;font-size:12px;">' + peStr + '</td>';
    html += '<td style="padding:10px 8px;text-align:center;">';
    html += '<span style="display:inline-block;padding:3px 10px;border-radius:12px;background:' + scoreBg + ';font-weight:700;font-size:13px;color:' + ratingColor + ';">' + score + '</span>';
    html += '</td>';
    html += '<td style="padding:10px 8px;text-align:center;">';
    html += '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-weight:700;font-size:12px;color:#fff;background:' + ratingColor + ';">' + rating + '</span>';
    html += '</td>';
    html += '<td style="padding:10px 24px 10px 8px;font-size:11px;color:var(--text-muted);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escHtml(s.reason || '') + '">' + escHtml(s.reason || '') + '</td>';
    html += '</tr>';
  }

  html += '</tbody></table>';

  return html;
}
