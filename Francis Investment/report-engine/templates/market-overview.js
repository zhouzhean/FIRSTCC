/**
 * Section 2: 大盘综述 (Market Overview)
 * Data path: data.section2_marketOverview
 */

function formatClose(value) {
  if (typeof value === 'number') {
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return String(value);
}

function formatChange(change) {
  if (typeof change === 'number') {
    const sign = change >= 0 ? '+' : '';
    return sign + change.toFixed(2) + '%';
  }
  return String(change);
}

function changeDirection(change) {
  if (change === null || change === undefined) return '';
  const str = String(change).trim();
  if (str.startsWith('+') || (typeof change === 'number' && change > 0)) return 'up';
  if (str.startsWith('-') || (typeof change === 'number' && change < 0)) return 'down';
  return '';
}

function renderMarketOverview(data, mode) {
  mode = mode || 'pdf';
  const d = data.section2_marketOverview;
  const indices = d.indices;
  const indexKeys = ['shanghai', 'shenzhen', 'chiNext', 'star50', 'totalVolume'];

  // --- Metric cards row ---
  let cards = '';
  for (const key of indexKeys) {
    const idx = indices[key];
    const change = idx.change;
    const isNullChange = change === null || change === undefined;
    const cardClass = isNullChange ? '' : (change < 0 ? 'bad' : change > 0 ? 'good' : '');
    const valueClass = isNullChange ? '' : (change < 0 ? 'price-down' : change > 0 ? 'price-up' : '');

    cards += `
    <div class="metric-card${cardClass ? ' ' + cardClass : ''}">
      <div class="label">${idx.name}</div>
      <div class="value${valueClass ? ' ' + valueClass : ''}">${formatClose(idx.close)}</div>
      <div class="sub">${idx.note}</div>
    </div>`;
  }

  // --- Index detail table ---
  let rows = '';
  for (const row of d.indexDetailTable) {
    const ch = String(row.change);
    const dir = changeDirection(ch);
    rows += `
      <tr>
        <td><strong>${row.name}</strong></td>
        <td>${row.close}</td>
        <td${dir ? ' class="price-' + dir + '"' : ''}>${ch}</td>
        <td>${row.feature}</td>
      </tr>`;
  }

  const sectionTitle = mode === 'app'
    ? '<div class="section-header"><span class="icon">📊</span><h2>大盘综述</h2></div>'
    : '<h2>二、大盘综述</h2>';

  return `
${sectionTitle}

<div class="metrics-row">${cards}
</div>

<table>
  <thead><tr><th>指数</th><th>收盘点位</th><th>涨跌幅</th><th>关键特征</th></tr></thead>
  <tbody>${rows}
  </tbody>
</table>

<div class="callout ${d.intradayPattern.calloutType}">
  <strong>${d.intradayPattern.title}</strong>
  ${d.intradayPattern.body}
</div>

<div class="callout ${d.shortTermOutlook.calloutType}">
  <strong>${d.shortTermOutlook.title}</strong>
  ${d.shortTermOutlook.body}
</div>`;
}
