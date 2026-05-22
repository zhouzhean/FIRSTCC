// Section 5: 潜力股推荐（按热门板块，每板块2只新股）
// Supports both new format (sectors[] with nested stocks) and old format (flat stocks[])
// All recommended stocks participate in TOP5 ranking

function mapClass(ratingClass) {
  if (ratingClass === 'up') return 'price-up';
  if (ratingClass === 'down') return 'price-down';
  return 'price-flat';
}

function renderLowPricePicks(data, mode) {
  mode = mode || 'pdf';
  const section = data.section5_lowPricePicks;
  const filterCallout = section.filterCallout;
  const sectors = section.sectors;  // new format: array of { name, stocks[] }
  const flatStocks = section.stocks; // old format: flat array

  // Build unified stock list
  let allStocks = [];
  let sectorMap = {}; // sectorName -> stock indices
  if (sectors && sectors.length > 0) {
    for (let s = 0; s < sectors.length; s++) {
      const sec = sectors[s];
      sectorMap[sec.name] = [];
      if (sec.stocks) {
        for (let st = 0; st < sec.stocks.length; st++) {
          sec.stocks[st]._sector = sec.name;
          sectorMap[sec.name].push(allStocks.length);
          allStocks.push(sec.stocks[st]);
        }
      }
    }
  } else if (flatStocks && flatStocks.length > 0) {
    allStocks = flatStocks;
    // Fallback: use stock.sector as _sector for filter tabs
    for (let i = 0; i < allStocks.length; i++) {
      if (!allStocks[i]._sector && allStocks[i].sector) {
        allStocks[i]._sector = allStocks[i].sector;
      }
    }
  }

  let html = '';

  const sectionTitle = mode === 'app'
    ? '<div class="section-header"><span class="icon">💎</span><h2>潜力股推荐</h2><span class="badge-count">' + allStocks.length + ' 只精选</span></div>'
    : '<h2>五、潜力股推荐（热门板块深度分析）</h2>';

  html += sectionTitle + '\n';

  // ---- Sector filter tabs (app mode only) ----
  // Use sector tracking (section4) sector names for filter tabs
  var filterSectors = (data.section4_sectorTracking && data.section4_sectorTracking.sectors)
    ? data.section4_sectorTracking.sectors
    : [];
  if (mode === 'app' && filterSectors.length > 0) {
    // Count stocks per sector name
    var sectorCounts = {};
    for (var si = 0; si < allStocks.length; si++) {
      var sname = allStocks[si]._sector || '';
      if (sname) { sectorCounts[sname] = (sectorCounts[sname] || 0) + 1; }
    }
    html += '<div class="sector-filter-bar" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px;">';
    html += '<span class="sector-tag active" data-sector="*" style="display:inline-block;padding:5px 14px;border-radius:16px;font-size:12px;font-weight:600;cursor:pointer;border:1.5px solid var(--accent);background:var(--accent-light);color:var(--accent-dark);transition:all 0.15s;" onclick="var tags=this.parentElement.querySelectorAll(\'.sector-tag\');tags.forEach(function(t){t.classList.remove(\'active\');t.style.background=\'#f5f5f5\';t.style.color=\'#666\';t.style.borderColor=\'#ddd\';});this.classList.add(\'active\');this.style.background=\'var(--accent-light)\';this.style.color=\'var(--accent-dark)\';this.style.borderColor=\'var(--accent)\';var cards=document.querySelectorAll(\'.pick-stock-card\');cards.forEach(function(c){c.style.display=\'\';});">全部 <span style="font-size:10px;opacity:0.7;">' + allStocks.length + '</span></span>';
    for (var fs = 0; fs < filterSectors.length; fs++) {
      var fsn = filterSectors[fs].name;
      var cnt = sectorCounts[fsn] || 0;
      html += '<span class="sector-tag" data-sector="' + escHtml(fsn) + '" style="display:inline-block;padding:5px 14px;border-radius:16px;font-size:12px;font-weight:500;cursor:pointer;border:1.5px solid #ddd;background:#f5f5f5;color:#666;transition:all 0.15s;" onclick="var tags=this.parentElement.querySelectorAll(\'.sector-tag\');tags.forEach(function(t){t.classList.remove(\'active\');t.style.background=\'#f5f5f5\';t.style.color=\'#666\';t.style.borderColor=\'#ddd\';});this.classList.add(\'active\');this.style.background=\'var(--accent-light)\';this.style.color=\'var(--accent-dark)\';this.style.borderColor=\'var(--accent)\';var sec=this.getAttribute(\'data-sector\');var cards=document.querySelectorAll(\'.pick-stock-card\');cards.forEach(function(c){if(sec===\'*\'||c.getAttribute(\'data-sector\')===sec){c.style.display=\'\';}else{c.style.display=\'none\';}});">' + escHtml(fsn) + ' <span style="font-size:10px;opacity:0.7;">' + cnt + '</span></span>';
    }
    html += '</div>\n';
  }

  // Filter callout
  html += '<div class="callout ' + filterCallout.calloutType + '">\n';
  html += '  <strong>' + filterCallout.title + '</strong>\n';
  html += '  ' + filterCallout.body + '\n';
  html += '</div>\n';

  // Stock cards
  for (let i = 0; i < allStocks.length; i++) {
    const stock = allStocks[i];
    const sectorAttr = stock._sector ? ' data-sector="' + escHtml(stock._sector) + '"' : '';

    html += '<div class="stock-card recommend pick-stock-card"' + sectorAttr + '>\n';

    // Stock header
    html += '  <div class="stock-header">\n';
    html += '    <div>\n';
    html += '      <span class="stock-name">' + (stock.medal || '') + ' ' + stock.name + '</span>\n';
    html += '      <span style="color:var(--text-muted);font-size:0.85em;">' + stock.code + ' · ' + (stock.exchange || '') + '</span>\n';
    if (stock._sector) {
      html += '      <span style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:var(--accent-light);color:var(--accent-dark);">' + escHtml(stock._sector) + '</span>\n';
    }
    html += '    </div>\n';

    const changeSign = (stock.changePercent || 0) >= 0 ? '+' : '';
    const priceBg = stock.priceColor
      ? ' style="background:' + stock.priceColor + ';"'
      : '';
    html += '    <span class="stock-price"' + priceBg + '>' + stock.price + '元 (' + changeSign + (stock.changePercent || 0) + '%)</span>\n';
    html += '  </div>\n';

    // Tags
    if (stock.tags && stock.tags.length > 0) {
      html += '  <div class="stock-tags">\n';
      for (let j = 0; j < stock.tags.length; j++) {
        html += '    <span>' + stock.tags[j] + '</span>\n';
      }
      html += '  </div>\n';
    }

    // Analysis table
    if (stock.analysis && stock.analysis.length > 0) {
      html += '  <table>\n';
      html += '    <thead><tr><th>分析维度</th><th>内容</th><th>评级</th></tr></thead>\n';
      html += '    <tbody>\n';
      for (let j = 0; j < stock.analysis.length; j++) {
        const item = stock.analysis[j];
        html += '      <tr>\n';
        html += '        <td><strong>' + item.dimension + '</strong></td>\n';
        html += '        <td>' + item.content + '</td>\n';
        html += '        <td class="' + mapClass(item.ratingClass) + '">' + item.stars + '</td>\n';
        html += '      </tr>\n';
      }
      html += '    </tbody>\n';
      html += '  </table>\n';
    }

    // Conclusion callout
    if (stock.conclusion) {
      html += '  <div class="callout ' + stock.conclusion.calloutType + '">\n';
      html += '    <strong>' + stock.conclusion.title + '</strong>\n';
      html += '    ' + stock.conclusion.body + '\n';
      html += '  </div>\n';
    }

    html += '</div>\n';
  }

  return html;
}
