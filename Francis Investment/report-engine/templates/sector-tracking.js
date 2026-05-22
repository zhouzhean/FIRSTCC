/**
 * Section 4: 热门跟踪板块最新动态 (Sector Tracking)
 * Data path: data.section4_sectorTracking
 */

function renderSectorTracking(data, mode) {
  mode = mode || 'pdf';
  const sectors = data.section4_sectorTracking.sectors;

  let cards = '';
  for (const s of sectors) {
    cards += `
    <div class="sector-card">
      <div class="sector-name">${s.emoji} ${s.name}</div>
      <div class="impact ${s.impactClass}">${s.impact}</div>
      <p><b>催化：</b>${s.catalysts}</p>
    </div>`;
  }

  const sectionTitle = mode === 'app'
    ? '<div class="section-header"><span class="icon">🔥</span><h2>热门跟踪板块最新动态</h2><span class="badge-count">' + sectors.length + ' 个板块</span></div>'
    : '<h2>四、热门跟踪板块最新动态</h2>';

  return `
${sectionTitle}

<div class="sector-grid">${cards}
</div>`;
}
