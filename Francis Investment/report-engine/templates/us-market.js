/**
 * us-market.js — 海外市场监控面板模板
 * renderUSMarket(data, mode, usData) 生成美股实时监控 HTML
 * data = report data (unused here), mode = 'app'|'pdf', usData = API response
 */
function renderUSMarket(data, mode, usData) {
  var isPDF = mode === 'pdf';
  var bg = isPDF ? '#0a1628' : '#f8f9fb';
  var cardBg = isPDF ? '#0f1f3a' : '#ffffff';
  var text = isPDF ? '#c9d1d9' : '#1e293b';
  var muted = isPDF ? '#8b949e' : '#64748b';
  var accent = '#b8942c';
  var up = isPDF ? '#f85149' : '#dc2626';
  var down = isPDF ? '#3fb950' : '#16a34a';
  var border = isPDF ? '#1e3050' : '#e2e5eb';

  if (!usData || !usData.time) {
    return '<div class="us-market-empty" style="text-align:center;padding:40px;color:' + muted + ';">' +
      '<div style="font-size:48px;margin-bottom:16px;">[US]</div>' +
      '<div style="font-size:16px;font-weight:600;margin-bottom:8px;">海外市场数据加载中...</div>' +
      '<div style="font-size:13px;">美股实时数据将在每个交易日晚间自动更新</div>' +
      '</div>';
  }

  var status = usData.status || {};
  var isUSActive = status.status === 'regular' || status.status === 'pre_market' || status.status === 'post_market';
  var isNight = false;

  var html = '';

  // ==== Status Banner ====
  html += '<div class="us-status-banner' + (isUSActive ? ' active' : '') + (isNight ? ' night' : '') + '"' +
    ' style="display:flex;align-items:center;gap:12px;padding:12px 18px;border-radius:8px;margin-bottom:16px;' +
    (isUSActive
      ? 'background:linear-gradient(135deg,#0a1628,#1a2a40);color:#fff;border:1px solid #1e3050;'
      : 'background:' + cardBg + ';border:1px solid ' + border + ';') +
    '">' +
    '<span style="font-size:24px;">' + (isUSActive ? '[ON]' : '[OFF]') + '</span>' +
    '<div>' +
    '<div style="font-size:15px;font-weight:700;">' + escHtml(status.label || '美股市场') + '</div>' +
    '<div style="font-size:11px;color:' + (isUSActive ? '#94a3b8' : muted) + ';">' +
    '北京时间 ' + (status.beijingTime || '--') +
    (isUSActive ? ' · 数据每60秒更新' : ' · 显示最近收盘价') +
    '</div>' +
    '</div>' +
    '</div>';

  // ==== Major Indices (4-column grid) ====
  html += '<h3 style="font-size:14px;color:' + text + ';margin:16px 0 8px;"> 核心指数</h3>';
  html += renderQuoteGrid(usData.indices, cardBg, text, muted, up, down, border, isNight);

  // ==== Macro Indicators ====
  html += '<h3 style="font-size:14px;color:' + text + ';margin:16px 0 8px;"> 宏观指标</h3>';
  html += renderMacroCards(usData.macro, cardBg, text, muted, up, down, border, isNight);

  // ==== Chinese ADRs (horizontal scroll strip) ====
  if (usData.adrs && usData.adrs.length > 0) {
    html += '<h3 style="font-size:14px;color:' + text + ';margin:16px 0 8px;">[CN] 中概股 ADR</h3>';
    html += renderADRStrip(usData.adrs, cardBg, text, muted, up, down, isNight);
  }

  // ==== Sector ETFs → A-stock mapping ====
  if (usData.sectorETFs && usData.sectorETFs.length > 0) {
    html += '<h3 style="font-size:14px;color:' + text + ';margin:16px 0 8px;"> 板块映射 ETF → A股板块</h3>';
    html += renderSectorMappingGrid(usData.sectorETFs, cardBg, text, muted, up, down, border, isNight);
  }

  // ==== Sentiment Barometers ====
  if (usData.sentiment && usData.sentiment.length > 0) {
    html += '<h3 style="font-size:14px;color:' + text + ';margin:16px 0 8px;">* 情绪标杆</h3>';
    html += renderQuoteGrid(usData.sentiment, cardBg, text, muted, up, down, border, isNight);
  }

  // ==== Overnight Summary (only if available) ====
  if (usData.summary) {
    html += renderOvernightSummaryCard(usData.summary, cardBg, text, muted, up, down, accent, border, isNight);
  }

  return html;
}

// ---- Sub-renderers ----

function renderQuoteGrid(items, cardBg, text, muted, up, down, border, isNight) {
  if (!items || items.length === 0) return '<div style="color:' + muted + ';font-size:12px;padding:8px;">暂无数据</div>';

  var html = '<div class="us-quote-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;">';
  for (var i = 0; i < items.length; i++) {
    var q = items[i];
    var pct = q.changePercent || 0;
    var color = pct >= 0 ? up : down;
    var sign = pct >= 0 ? '+' : '';

    html += '<div class="us-quote-card" style="background:' + (isNight ? '#0f1f3a' : cardBg) + ';border:1px solid ' + border + ';' +
      'border-radius:8px;padding:12px;' + (isNight ? 'color:#c9d1d9;' : '') + '">' +
      '<div style="font-size:11px;color:' + muted + ';margin-bottom:4px;">' + escHtml(q.symbol) + '</div>' +
      '<div style="font-size:13px;font-weight:600;color:' + text + ';margin-bottom:4px;' + (isNight ? 'color:#e6edf3;' : '') + '">' + escHtml(q.name) + '</div>' +
      '<div style="display:flex;align-items:baseline;gap:8px;">' +
      '<span style="font-size:18px;font-weight:700;color:' + text + ';' + (isNight ? 'color:#e6edf3;' : '') + '">' + (q.price != null ? q.price.toFixed(2) : '--') + '</span>' +
      '<span style="font-size:13px;font-weight:600;color:' + color + ';">' + sign + pct.toFixed(2) + '%</span>' +
      '</div>' +
      '</div>';
  }
  html += '</div>';
  return html;
}

function renderMacroCards(items, cardBg, text, muted, up, down, border, isNight) {
  if (!items || items.length === 0) return '<div style="color:' + muted + ';font-size:12px;padding:8px;">暂无数据</div>';

  // Special handling: VIX, DXY, TNX each with interpretation
  var html = '<div class="us-quote-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;">';
  for (var i = 0; i < items.length; i++) {
    var q = items[i];
    var pct = q.changePercent || 0;
    var color = pct >= 0 ? up : down;
    var sign = pct >= 0 ? '+' : '';

    var interpretation = '';
    if (q.symbol === 'VXX') {
      if (q.price >= 40) interpretation = '[!] 恐慌级别 — 全球避险模式';
      else if (q.price >= 30) interpretation = '[!] 警戒 — 市场焦虑上升';
      else if (q.price >= 25) interpretation = ' 正常偏高 — 保持关注';
      else interpretation = '[OK] 低波动 — 风险偏好积极';
    } else if (q.symbol === 'UUP') {
      if (q.changePercent >= 0.5) interpretation = ' 美元走强 — 人民币承压';
      else if (q.changePercent <= -0.5) interpretation = ' 美元走弱 — 利好人民币资产';
      else interpretation = ' 美元中性区间';
    } else if (q.symbol === 'TLT') {
      if (q.changePercent <= -1) interpretation = '[!] 收益率急升 — 利空全球成长股';
      else if (q.changePercent <= -0.5) interpretation = ' 收益率上升 — 成长股承压';
      else if (q.changePercent >= 1) interpretation = '[OK] 收益率下降 — 利好成长股';
      else if (q.changePercent >= 0.5) interpretation = ' 收益率下行 — 偏向宽松';
      else interpretation = ' 收益率平稳';
    }

    html += '<div class="us-quote-card" style="background:' + (isNight ? '#0f1f3a' : cardBg) + ';border:1px solid ' + border + ';' +
      'border-radius:8px;padding:12px;' + (isNight ? 'color:#c9d1d9;' : '') + '">' +
      '<div style="font-size:11px;color:' + muted + ';margin-bottom:4px;">' + escHtml(q.symbol.replace('^', '')) + '</div>' +
      '<div style="font-size:13px;font-weight:600;color:' + text + ';margin-bottom:4px;' + (isNight ? 'color:#e6edf3;' : '') + '">' + escHtml(q.name) + '</div>' +
      '<div style="display:flex;align-items:baseline;gap:8px;">' +
      '<span style="font-size:18px;font-weight:700;color:' + text + ';' + (isNight ? 'color:#e6edf3;' : '') + '">' + (q.price != null ? q.price.toFixed(2) : '--') + '</span>' +
      '<span style="font-size:13px;font-weight:600;color:' + color + ';">' + sign + pct.toFixed(2) + '%</span>' +
      '</div>' +
      (interpretation ? '<div style="font-size:11px;color:' + muted + ';margin-top:6px;">' + interpretation + '</div>' : '') +
      '</div>';
  }
  html += '</div>';
  return html;
}

function renderADRStrip(items, cardBg, text, muted, up, down, isNight) {
  if (!items || items.length === 0) return '';

  var html = '<div class="us-adr-strip" style="display:flex;gap:10px;overflow-x:auto;padding:4px 0 12px;-webkit-overflow-scrolling:touch;">';
  for (var i = 0; i < items.length; i++) {
    var q = items[i];
    var pct = q.changePercent || 0;
    var color = pct >= 0 ? up : down;
    var sign = pct >= 0 ? '+' : '';
    var bgColor = pct >= 0 ? '#fef2f2' : '#f0fdf4';

    html += '<div class="us-adr-chip" style="flex-shrink:0;min-width:130px;background:' + (isNight ? '#0f1f3a' : bgColor) + ';' +
      'border:1px solid ' + (pct >= 0 ? '#fecaca' : '#bbf7d0') + ';border-radius:8px;padding:10px 12px;text-align:center;">' +
      '<div style="font-size:12px;font-weight:700;color:' + text + ';' + (isNight ? 'color:#e6edf3;' : '') + '">' + escHtml(q.symbol) + '</div>' +
      '<div style="font-size:10px;color:' + muted + ';margin-bottom:4px;">' + escHtml(q.name) + '</div>' +
      '<div style="font-size:15px;font-weight:700;color:' + color + ';">' + sign + pct.toFixed(2) + '%</div>' +
      '</div>';
  }
  html += '</div>';
  return html;
}

function renderSectorMappingGrid(items, cardBg, text, muted, up, down, border, isNight) {
  if (!items || items.length === 0) return '<div style="color:' + muted + ';font-size:12px;">暂无数据</div>';

  // US_MARKET.sectorMapping from config — embedded in data or hardcoded here
  var sectorMap = {
    'SMH': '半导体/AI算力', 'XBI': '创新药/AI医疗', 'TAN': '固态电池/储能',
    'ARKQ': '机器人/具身智能', 'XLE': '有色金属/稀土', 'XLF': '金融', 'XAR': '军工/商业航天',
  };

  var html = '<div class="us-quote-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px;">';
  for (var i = 0; i < items.length; i++) {
    var q = items[i];
    var pct = q.changePercent || 0;
    var color = pct >= 0 ? up : down;
    var sign = pct >= 0 ? '+' : '';
    var aSector = sectorMap[q.symbol] || q.symbol;

    var impactIcon = '->';
    if (pct >= 1.5) impactIcon = 'HOT';
    else if (pct >= 0.5) impactIcon = '[OK]';
    else if (pct <= -1.5) impactIcon = 'COLD';
    else if (pct <= -0.5) impactIcon = '[!]';

    html += '<div class="us-quote-card" style="background:' + (isNight ? '#0f1f3a' : cardBg) + ';border:1px solid ' + border + ';' +
      'border-radius:8px;padding:12px;' + (isNight ? 'color:#c9d1d9;' : '') + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
      '<span style="font-size:12px;font-weight:700;color:' + text + ';' + (isNight ? 'color:#e6edf3;' : '') + '">' + escHtml(q.symbol) + ' ' + escHtml(q.name) + '</span>' +
      '<span style="font-size:14px;">' + impactIcon + '</span>' +
      '</div>' +
      '<div style="font-size:11px;color:' + muted + ';margin-bottom:4px;">→ A股: <b>' + escHtml(aSector) + '</b></div>' +
      '<span style="font-size:15px;font-weight:700;color:' + color + ';">' + sign + pct.toFixed(2) + '%</span>' +
      '</div>';
  }
  html += '</div>';
  return html;
}

function renderOvernightSummaryCard(summary, cardBg, text, muted, up, down, accent, border, isNight) {
  var html = '<div class="us-overnight-summary" style="background:' + (isNight ? '#0f1f3a' : '#fdf8ee') + ';' +
    'border:2px solid ' + accent + ';border-radius:10px;padding:20px;margin-top:20px;">';

  html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">' +
    '<span style="font-size:14px;font-weight:700;color:' + accent + ';">A股明日盘前参考</span>' +
    '</div>';

  if (summary.aStockSentiment) {
    var s = summary.aStockSentiment;
    var levelLabels = {
      'strong_bullish': '强烈看多 [++]', 'bullish': '看多 [+]', 'slightly_bullish': '偏多 [^]',
      'neutral': '中性 [--]',
      'slightly_bearish': '偏空 [v]', 'bearish': '看空 [-]', 'strong_bearish': '强烈看空 [!]',
    };
    var sentimentColor = s.score >= 20 ? up : (s.score <= -20 ? down : muted);

    html += '<div style="background:' + (isNight ? '#1a2a40' : '#fff') + ';border-radius:8px;padding:14px;margin-bottom:12px;' +
      'border:1px solid ' + border + ';">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;">' +
      '<span style="font-size:14px;font-weight:600;color:' + text + ';' + (isNight ? 'color:#e6edf3;' : '') + '">情绪评分</span>' +
      '<span style="font-size:28px;font-weight:800;color:' + sentimentColor + ';">' + s.score + '</span>' +
      '</div>' +
      '<div style="font-size:13px;color:' + muted + ';margin-top:4px;">' + (levelLabels[s.level] || s.level) + '</div>' +
      '</div>';

    if (s.signals && s.signals.length > 0) {
      html += '<div style="margin-bottom:12px;">';
      for (var i = 0; i < s.signals.length; i++) {
        html += '<div style="font-size:12px;color:' + text + ';' + (isNight ? 'color:#c9d1d9;' : '') + ';padding:4px 0;">• ' + escHtml(s.signals[i]) + '</div>';
      }
      html += '</div>';
    }
  }

  if (summary.aStockSectorOutlook && summary.aStockSectorOutlook.length > 0) {
    html += '<div style="font-size:13px;font-weight:600;color:' + text + ';' + (isNight ? 'color:#e6edf3;' : '') + ';margin-bottom:8px;">板块映射预判:</div>';
    html += '<div style="display:flex;flex-wrap:wrap;gap:6px;">';
    for (var j = 0; j < summary.aStockSectorOutlook.length; j++) {
      var o = summary.aStockSectorOutlook[j];
      var impactColors = {
        'strong_positive': up,
        'positive': up,
        'neutral': muted,
        'negative': down,
        'strong_negative': down,
      };
      html += '<span style="font-size:11px;padding:4px 10px;border-radius:12px;' +
        'background:' + (isNight ? '#1a2a40' : '#fff') + ';' +
        'border:1px solid ' + (impactColors[o.impact] || border) + ';' +
        'color:' + (isNight ? '#c9d1d9' : text) + ';">' +
        escHtml(o.aStockSector) + ' <b style="color:' + (impactColors[o.impact] || muted) + ';">' +
        (o.changePercent >= 0 ? '+' : '') + o.changePercent.toFixed(2) + '%</b>' +
        '</span>';
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}

/**
 * Check if current time is night mode (21:30 - 06:00 CST).
 */
function isNightMode() {
  var h = new Date().getHours();
  return h >= 21 || h < 6;
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
