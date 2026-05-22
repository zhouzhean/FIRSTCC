/** Cover page template for the Francis Investment Report Engine. */

function renderCover(data, mode) {
  mode = mode || 'pdf';
  const meta = data.meta;

  const parts = meta.reportDate.split("-");
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  const dateObj = new Date(year, month - 1, day);

  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const weekday = weekdays[dateObj.getDay()];

  const dateShort = `${year}年${month}月${day}日`;
  const dateWithWeekday = `${dateShort}（${weekday}）`;

  const titleParts = meta.reportTitle.split(" ");
  const titleRest = titleParts.length > 1 ? titleParts.slice(1).join(" ") : meta.reportTitle;

  const targets = meta.analysisTargets.filter(Boolean).join(" / ") || "—";
  const sectors = meta.coveredSectors.filter(Boolean).join(" · ");

  if (mode === 'app') {
    return `<div class="cover-software">
  <div class="ci-badge">CONFIDENTIAL · 投资研究</div>
  <h1>${dateShort}<br><span>${titleRest}</span></h1>
  <p class="subtitle">${meta.subtitle}</p>
  <div class="meta-row">
    <div class="meta-item"><strong>报告日期</strong> ${dateWithWeekday}收盘后</div>
    <div class="meta-item"><strong>分析标的</strong> ${targets}</div>
    <div class="meta-item"><strong>覆盖板块</strong> ${sectors}</div>
  </div>
  <div class="meta-row">
    <div class="meta-item"><strong>核心事件</strong> ${meta.coreEvent || "—"}</div>
  </div>
  <div class="alert-line">⚠ 本报告不构成投资建议 · 股市有风险 · 投资需谨慎</div>
</div>`;
  }

  return `<div class="cover">
  <div class="badge">CONFIDENTIAL &middot; 投资研究</div>
  <h1>${dateShort}<br><span>${titleRest}</span></h1>
  <p class="subtitle">${meta.subtitle}</p>
  <div class="meta">
    报告日期：${dateWithWeekday}收盘后<br>
    分析标的：${targets}<br>
    覆盖板块：${sectors}<br>
    核心事件：${meta.coreEvent || "—"}
  </div>
  <div class="alert-badge">&#9888; 本报告不构成投资建议 &middot; 股市有风险 &middot; 投资需谨慎</div>
</div>`;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { renderCover };
}
