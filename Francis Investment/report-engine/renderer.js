// Report Engine Coordinator
// Sequences all section templates into a complete HTML document
// mode: 'pdf' (default, dark theme, academic numbering) | 'app' (software theme, no numbering)

function renderFullReport(data, mode) {
  mode = mode || 'pdf';
  const css = mode === 'app' ? renderSoftwareCSS() : renderCSS();
  const cover = renderCover(data, mode);
  const newsPolicy = renderNewsPolicy(data, mode);
  const marketOverview = renderMarketOverview(data, mode);
  const holdingsAnalysis = renderHoldingsAnalysis(data, mode);
  const sectorTracking = renderSectorTracking(data, mode);
  const lowPricePicks = renderLowPricePicks(data, mode);
  const top5Ranking = renderTop5Ranking(data, mode);
  const riskMatrix = renderRiskMatrix(data, mode);
  const disclaimer = renderDisclaimer(data, mode);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(data.meta.reportTitle || '每日行情分析报告')}</title>
<style>
${css}
</style>
</head>
<body>

<!-- ============= COVER ============= -->
${cover}

<div class="content">

<!-- ============= CH1: 近日新闻/时政 ============= -->
${newsPolicy}

<!-- ============= CH2: 大盘综述 ============= -->
${marketOverview}

<!-- ============= CH3: 持仓深度分析 ============= -->
${holdingsAnalysis}

<!-- ============= CH4: 热门板块 ============= -->
${sectorTracking}

<!-- ============= CH5: 10元以下推荐 ============= -->
${lowPricePicks}

<!-- ============= CH6: 排行榜 ============= -->
${top5Ranking}

<!-- ============= CH7: 风险矩阵 ============= -->
${riskMatrix}

<!-- ============= DISCLAIMER ============= -->
${disclaimer}

</div>

</body>
</html>`;
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
