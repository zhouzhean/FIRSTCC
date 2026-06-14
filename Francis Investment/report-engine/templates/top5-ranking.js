// Section 6: 新股推荐排行榜 TOP 5
// Exports renderTop5Ranking(data) — data is data.section6_top5Ranking

function mapRiskClass(riskClass) {
  if (riskClass === 'up') return 'price-up';
  if (riskClass === 'down') return 'price-down';
  return null; // "neutral" — use inline style
}

function renderTop5Ranking(data, mode) {
  mode = mode || 'pdf';
  const { infoCallout, rankedStocks, warningCallout } = data.section6_top5Ranking;

  let html = '';

  const sectionTitle = mode === 'app'
    ? '<div class="section-header" style="display:flex;justify-content:space-between;align-items:center;"><div style="display:flex;align-items:center;gap:10px;"><span class="icon"></span><h2>新股推荐排行榜 TOP 5</h2></div><button onclick="parent.showRecommendationHistory()" style="padding:5px 14px;border:1px solid var(--accent);border-radius:16px;background:var(--accent-light);color:var(--accent-dark);font-size:12px;font-weight:600;cursor:pointer;transition:all 0.15s;" onmouseover="this.style.background=\'var(--accent)\';this.style.color=\'#fff\';" onmouseout="this.style.background=\'var(--accent-light)\';this.style.color=\'var(--accent-dark)\';"> 推荐历史记录</button></div>'
    : '<h2>六、新股推荐排行榜（TOP 5）</h2>';

  html += sectionTitle + '\n';

  // Info callout
  html += '<div class="callout ' + infoCallout.calloutType + '">\n';
  html += '  <strong>' + infoCallout.title + '</strong>\n';
  html += '  ' + infoCallout.body + '\n';
  html += '</div>\n';

  // Ranked stock cards
  for (let i = 0; i < rankedStocks.length; i++) {
    const stock = rankedStocks[i];

    html += '<div class="stock-card recommend" style="border-left:5px solid ' + stock.borderColor + ';">\n';
    html += '  <div class="stock-header">\n';
    html += '    <div>\n';
    html += '      <span class="rank-badge rank-' + stock.rank + '" style="display:inline-flex;vertical-align:middle;margin-right:10px;">' + stock.rank + '</span>\n';
    html += '      <span class="stock-name" style="color:' + stock.borderColor + ';">' + stock.name + '</span>\n';
    html += '      <span style="color:var(--text-muted);font-size:0.85em;">' + stock.code + ' · 深交所</span>\n';
    html += '    </div>\n';

    // Risk color
    let riskColorStyle;
    if (stock.riskClass === 'up') {
      riskColorStyle = 'var(--green)';
    } else if (stock.riskClass === 'down') {
      riskColorStyle = 'var(--red)';
    } else {
      riskColorStyle = 'var(--warning)';
    }

    html += '    <div style="text-align:right;">\n';
    html += '      <span style="font-size:1.3em;font-weight:700;">' + stock.price + '元</span>\n';
    html += '      <span style="display:block;font-size:0.8em;color:var(--text-muted);">\n';
    html += '        PE ' + stock.pe + ' | 风险：<span style="color:' + riskColorStyle + ';">' + stock.risk + '</span> | 建议仓位：' + stock.suggestedPosition + '\n';
    html += '      </span>\n';
    html += '    </div>\n';
    html += '  </div>\n';

    html += '  <p style="font-size:0.92em;color:' + (mode === 'app' ? '#1e293b' : '#c8d0dc') + ';margin:0;line-height:1.7;">' + stock.fullLogic + '</p>\n';

    html += '</div>\n';
  }

  // Warning callout (convert \n to <br>\n in body)
  html += '<div class="callout ' + warningCallout.calloutType + '">\n';
  html += '  <strong>' + warningCallout.title + '</strong>\n';
  html += '  ' + warningCallout.body.replace(/\n/g, '<br>\n  ') + '\n';
  html += '</div>\n';

  return html;
}
