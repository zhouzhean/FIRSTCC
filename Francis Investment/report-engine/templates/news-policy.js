/**
 * Section 1: 近日重大新闻与时政分析
 * Data path: data.section1_newsPolicy
 */

function mapImpactClass(cls) {
  if (cls === "up") return "price-up";
  if (cls === "down") return "price-down";
  if (cls === "flat" || cls === "neutral") return "price-flat";
  return "";
}

function renderNewsPolicy(data, mode) {
  mode = mode || 'pdf';
  const d = data.section1_newsPolicy;
  if (!d) return "";

  let html = "";

  if (mode === 'app') {
    // Software mode: event cards, no academic numbering
    html += '<div class="section-header"><span class="icon">📰</span><h2>近日重大新闻与时政分析</h2></div>\n';

    // Core events as cards
    if (d.coreEvents && d.coreEvents.length > 0) {
      html += '<h3>核心事件</h3>\n';
      html += '<div class="event-cards">\n';
      for (const ev of d.coreEvents) {
        const impactClass = mapImpactClass(ev.impactClass);
        html += '<div class="event-card">\n';
        html += `  <div class="event-dim">${ev.dimension || ""}</div>\n`;
        html += `  <div class="event-content">${ev.content || ""}</div>\n`;
        html += `  <div class="event-impact ${impactClass}">${ev.impactAssessment || ""}</div>\n`;
        html += '</div>\n';
      }
      html += '</div>\n';
    }

    if (d.impactForecast) {
      const fc = d.impactForecast;
      html += `<div class="callout ${fc.calloutType || "info"}"><strong>${fc.title || ""}</strong>${fc.body || ""}</div>\n`;
    }

    // Other policies as cards
    if (d.otherPolicies && d.otherPolicies.length > 0) {
      html += '<h3>其他重要政策与数据</h3>\n';
      html += '<div class="event-cards">\n';
      for (const item of d.otherPolicies) {
        const impactClass = item.impactClass ? mapImpactClass(item.impactClass) : "";
        html += '<div class="event-card">\n';
        html += `  <div class="event-dim">${item.field || ""}</div>\n`;
        html += `  <div class="event-content">${item.content || ""}</div>\n`;
        html += `  <div class="event-impact ${impactClass}">${item.impact || ""}</div>\n`;
        html += '</div>\n';
      }
      html += '</div>\n';
    }

    if (d.watchNote) {
      const wn = d.watchNote;
      html += `<div class="callout ${wn.calloutType || "warning"}"><strong>${wn.title || ""}</strong>${wn.body || ""}</div>\n`;
    }
    return html;
  }

  // PDF mode: original academic format
  html += '<h2>一、近日重大新闻与时政分析</h2>\n\n';
  html += '<h3>1.1 核心事件详表</h3>\n\n';
  html += '<table>\n';
  html += '  <thead><tr><th>维度</th><th>核心内容</th><th>影响评估</th></tr></thead>\n';
  html += '  <tbody>\n';

  if (d.coreEvents && d.coreEvents.length > 0) {
    for (const ev of d.coreEvents) {
      const impactClass = mapImpactClass(ev.impactClass);
      const tdClass = impactClass ? ` class="${impactClass}"` : "";
      html += '    <tr>\n';
      html += `      <td><strong>${ev.dimension || ""}</strong></td>\n`;
      html += `      <td>${ev.content || ""}</td>\n`;
      html += `      <td${tdClass}>${ev.impactAssessment || ""}</td>\n`;
      html += '    </tr>\n';
    }
  }

  html += '  </tbody>\n';
  html += '</table>\n\n';

  if (d.impactForecast) {
    const fc = d.impactForecast;
    html += `<div class="callout ${fc.calloutType || "info"}">\n`;
    html += `  <strong>${fc.title || ""}</strong>\n`;
    html += `  ${fc.body || ""}\n`;
    html += '</div>\n\n';
  }

  html += '<h3>1.2 其他重要政策与数据</h3>\n\n';
  html += '<table>\n';
  html += '  <thead><tr><th>领域</th><th>内容</th><th>影响</th></tr></thead>\n';
  html += '  <tbody>\n';

  if (d.otherPolicies && d.otherPolicies.length > 0) {
    for (const item of d.otherPolicies) {
      const impactClass = item.impactClass ? mapImpactClass(item.impactClass) : "";
      const tdClass = impactClass ? ` class="${impactClass}"` : "";
      html += '    <tr>\n';
      html += `      <td><strong>${item.field || ""}</strong></td>\n`;
      html += `      <td>${item.content || ""}</td>\n`;
      html += `      <td${tdClass}>${item.impact || ""}</td>\n`;
      html += '    </tr>\n';
    }
  }

  html += '  </tbody>\n';
  html += '</table>\n\n';

  if (d.watchNote) {
    const wn = d.watchNote;
    html += `<div class="callout ${wn.calloutType || "warning"}">\n`;
    html += `  <strong>${wn.title || ""}</strong>\n`;
    html += `  ${wn.body || ""}\n`;
    html += '</div>\n';
  }

  return html;
}

// CommonJS export (also works as global via <script> tag)
if (typeof module !== "undefined" && module.exports) {
  module.exports = { renderNewsPolicy, mapImpactClass };
}
