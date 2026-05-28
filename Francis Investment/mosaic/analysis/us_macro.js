/**
 * us_macro.js — 美股收盘总结生成器
 *
 * 分析美股收盘数据，生成结构化隔夜总结，包括：
 * - ADR 综合指数
 * - VIX 风险等级
 * - 板块强弱排名
 * - A 股次日情绪评分 (-100 ~ +100)
 * - A 股板块映射预判
 */
const config = require('../config');
const UM = config.US_MARKET;

/**
 * Generate overnight summary from collected US market data.
 * @param {Object} usData — result from fetchAllUSMonitors()
 * @param {String} dateStr — YYYY-MM-DD
 */
function generateOvernightSummary(usData, dateStr) {
  if (!usData) return null;

  var summary = {
    date: dateStr || new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    indices: summarizeCategory(usData.indices, 'indices'),
    macro: summarizeMacro(usData.macro),
    adr: summarizeADR(usData.adrs),
    sectorPerformance: summarizeSectors(usData.sectorETFs),
    sentimentLeaders: summarizeSentiment(usData.sentiment),
    aStockSentiment: computeAStockSentiment(usData),
    aStockSectorOutlook: computeSectorOutlook(usData),
  };

  return summary;
}

function summarizeCategory(items, type) {
  if (!items || items.length === 0) return [];
  return items.map(function(q) {
    return {
      symbol: q.symbol,
      name: q.name,
      price: q.price,
      changePercent: q.changePercent,
      change: q.change,
    };
  });
}

function summarizeMacro(macroItems) {
  if (!macroItems || macroItems.length === 0) return {};
  var map = {};
  for (var i = 0; i < macroItems.length; i++) {
    map[macroItems[i].symbol] = macroItems[i];
  }

  var vxx = map['VXX'];
  var uup = map['UUP'];
  var tlt = map['TLT'];

  // VXX interpretation (VIX ETF proxy: higher = more fear)
  var vixLevel = 'normal';
  var vixInterpretation = '';
  if (vxx) {
    if (vxx.price >= 40) { vixLevel = 'crisis'; vixInterpretation = '⚠️ 恐慌级别 — 全球避险模式'; }
    else if (vxx.price >= 30) { vixLevel = 'elevated'; vixInterpretation = '⚡ 警戒 — 市场焦虑上升'; }
    else if (vxx.price >= 25) { vixLevel = 'caution'; vixInterpretation = '📊 正常偏高 — 保持关注'; }
    else { vixLevel = 'normal'; vixInterpretation = '✅ 低波动 — 风险偏好积极'; }
  }

  // UUP interpretation (USD ETF proxy: higher = stronger dollar)
  var uupInterpretation = '';
  if (uup) {
    if (uup.changePercent >= 0.5) uupInterpretation = '📈 美元走强 — 人民币承压，北向资金倾向流出';
    else if (uup.changePercent <= -0.5) uupInterpretation = '📉 美元走弱 — 利好人民币资产，外资倾向流入';
    else uupInterpretation = '📊 美元稳定';
  }

  // TLT interpretation (20yr Treasury ETF: price drops = yields rise)
  var tltInterpretation = '';
  if (tlt) {
    if (tlt.changePercent <= -1) tltInterpretation = '⚠️ 美债收益率急升 — 利空全球成长股/A股科技';
    else if (tlt.changePercent <= -0.5) tltInterpretation = '📈 收益率上升 — 成长股承压';
    else if (tlt.changePercent >= 1) tltInterpretation = '✅ 收益率下降 — 利好成长股估值';
    else if (tlt.changePercent >= 0.5) tltInterpretation = '📉 收益率下行 — 偏向宽松';
    else tltInterpretation = '📊 收益率平稳';
  }

  return {
    vxx: vxx ? { price: vxx.price, changePercent: vxx.changePercent, level: vixLevel, interpretation: vixInterpretation } : null,
    uup: uup ? { price: uup.price, changePercent: uup.changePercent, interpretation: uupInterpretation } : null,
    tlt: tlt ? { price: tlt.price, changePercent: tlt.changePercent, interpretation: tltInterpretation } : null,
    vixLevel: vixLevel,
  };
}

/**
 * Compute ADR composite — weighted average of Chinese ADR performance.
 * Heavier weight on BABA (25%), equal weight for others.
 */
function summarizeADR(adrItems) {
  if (!adrItems || adrItems.length === 0) return { items: [], composite: 0, sentiment: 'neutral' };

  var items = adrItems.map(function(q) {
    return {
      symbol: q.symbol,
      name: q.name,
      price: q.price,
      changePercent: q.changePercent,
      mapping: UM.adrMapping[q.symbol] || q.symbol,
    };
  });

  // Composite: BABA 25%, rest equal split of 75%
  var composite = 0;
  var babaWeight = 0.25;
  var otherWeight = items.length > 1 ? 0.75 / (items.length - 1) : 0.75;
  var hasBABA = false;

  for (var i = 0; i < items.length; i++) {
    if (items[i].symbol === 'BABA') {
      composite += items[i].changePercent * babaWeight;
      hasBABA = true;
    } else {
      composite += items[i].changePercent * (hasBABA ? otherWeight : (1.0 / items.length));
    }
  }

  composite = Math.round(composite * 100) / 100;

  var sentiment = 'neutral';
  if (composite >= 1.5) sentiment = 'bullish';
  else if (composite >= 0.5) sentiment = 'slightly_bullish';
  else if (composite <= -1.5) sentiment = 'bearish';
  else if (composite <= -0.5) sentiment = 'slightly_bearish';

  return { items: items, composite: composite, sentiment: sentiment };
}

function summarizeSectors(etfItems) {
  if (!etfItems || etfItems.length === 0) return [];

  var sectors = etfItems.map(function(q) {
    return {
      symbol: q.symbol,
      name: q.name,
      price: q.price,
      changePercent: q.changePercent,
      aStockSector: UM.sectorMapping[q.symbol] || q.symbol,
    };
  });

  // Sort by change% descending
  sectors.sort(function(a, b) { return (b.changePercent || 0) - (a.changePercent || 0); });

  return sectors;
}

function summarizeSentiment(sentimentItems) {
  if (!sentimentItems || sentimentItems.length === 0) return [];

  return sentimentItems.map(function(q) {
    return {
      symbol: q.symbol,
      name: q.name,
      price: q.price,
      changePercent: q.changePercent,
    };
  }).sort(function(a, b) { return (b.changePercent || 0) - (a.changePercent || 0); });
}

/**
 * Compute A-stock next-day sentiment score (-100 to +100).
 *
 * Formula:
 *   sentiment = 0.30 * ADR_composite_score
 *             + 0.25 * SPY_change_scaled
 *             + 0.20 * QQQ_change_scaled
 *             + 0.15 * VXX_inverse_score
 *             + 0.10 * UUP_inverse_score
 */
function computeAStockSentiment(usData) {
  var score = 0;

  // ADR composite (max ~ ±10% → scale to ±100)
  if (usData.adrs && usData.adrs.length > 0) {
    var adrSummary = summarizeADR(usData.adrs);
    var adrScore = Math.max(-100, Math.min(100, adrSummary.composite * 10));
    score += adrScore * 0.30;
  }

  // SPY change (max ~ ±5% → scale to ±100)
  var spy = findQuote(usData.indices, 'SPY');
  if (spy) {
    var spyScore = Math.max(-100, Math.min(100, spy.changePercent * 20));
    score += spyScore * 0.25;
  }

  // QQQ change (max ~ ±5% → scale to ±100)
  var qqq = findQuote(usData.indices, 'QQQ');
  if (qqq) {
    var qqqScore = Math.max(-100, Math.min(100, qqq.changePercent * 20));
    score += qqqScore * 0.20;
  }

  // VXX inverse (VXX 20=+50, VXX 25=0, VXX 35=-50, VXX 50=-100)
  var vxx = findQuote(usData.macro, 'VXX');
  if (vxx) {
    var vxxScore = Math.max(-100, Math.min(100, (25 - vxx.price) * 5));
    score += vxxScore * 0.15;
  }

  // UUP inverse (UUP 27=+20, UUP 27.5=0, UUP 28.5=-30)
  var uup = findQuote(usData.macro, 'UUP');
  if (uup) {
    var uupScore = Math.max(-100, Math.min(100, (27.5 - uup.price) * 40));
    score += uupScore * 0.10;
  }

  score = Math.round(score);

  var level = 'neutral';
  if (score >= 50) level = 'strong_bullish';
  else if (score >= 20) level = 'bullish';
  else if (score >= 5) level = 'slightly_bullish';
  else if (score <= -50) level = 'strong_bearish';
  else if (score <= -20) level = 'bearish';
  else if (score <= -5) level = 'slightly_bearish';

  var signals = [];
  if (spy && spy.changePercent < -1) signals.push('美股大盘下跌超1%，A股次日低开概率高');
  if (spy && spy.changePercent > 1) signals.push('美股大盘上涨超1%，利好A股次日情绪');
  if (vxx && vxx.price >= 35) signals.push('市场恐慌指数偏高(VXX=' + vxx.price.toFixed(1) + ')，避险情绪浓厚，北向资金可能流出');
  if (vxx && vxx.price < 22) signals.push('市场恐慌指数低位(VXX=' + vxx.price.toFixed(1) + ')，风险偏好积极，利好A股成长股');
  if (uup && uup.changePercent >= 0.5) signals.push('美元走强(UUP +' + uup.changePercent.toFixed(2) + '%)，人民币承压');
  if (uup && uup.changePercent <= -0.5) signals.push('美元走弱(UUP ' + uup.changePercent.toFixed(2) + '%)，人民币升值预期');

  return {
    score: score,
    level: level,
    signals: signals,
    components: {
      adr: usData.adrs && usData.adrs.length > 0 ? Math.round(summarizeADR(usData.adrs).composite * 10) : null,
      spy: spy ? Math.round(spy.changePercent * 20) : null,
      qqq: qqq ? Math.round(qqq.changePercent * 20) : null,
      vxx: vxx ? Math.round((25 - vxx.price) * 5) : null,
      uup: uup ? Math.round((27.5 - uup.price) * 40) : null,
    },
  };
}

/**
 * Predict A-stock sector outlook based on US sector ETF performance.
 */
function computeSectorOutlook(usData) {
  if (!usData.sectorETFs || usData.sectorETFs.length === 0) return [];

  var outlook = [];
  for (var i = 0; i < usData.sectorETFs.length; i++) {
    var q = usData.sectorETFs[i];
    var aSector = UM.sectorMapping[q.symbol];
    if (!aSector) continue;

    var impact = 'neutral';
    if (q.changePercent >= 1.5) impact = 'strong_positive';
    else if (q.changePercent >= 0.5) impact = 'positive';
    else if (q.changePercent <= -1.5) impact = 'strong_negative';
    else if (q.changePercent <= -0.5) impact = 'negative';

    outlook.push({
      symbol: q.symbol,
      usName: q.name,
      aStockSector: aSector,
      changePercent: q.changePercent,
      impact: impact,
    });
  }

  outlook.sort(function(a, b) { return (b.changePercent || 0) - (a.changePercent || 0); });
  return outlook;
}

function findQuote(arr, symbol) {
  if (!arr) return null;
  for (var i = 0; i < arr.length; i++) {
    if (arr[i].symbol === symbol) return arr[i];
  }
  return null;
}

/**
 * Generate a plain-text summary suitable for display or embedding.
 */
function formatTextSummary(summary, title) {
  if (!summary) return '暂无美国市场数据';

  var lines = [];
  if (title) lines.push(title);

  // Indices
  if (summary.indices && summary.indices.length > 0) {
    var idxLine = '指数: ';
    for (var i = 0; i < summary.indices.length; i++) {
      var q = summary.indices[i];
      var sign = q.changePercent >= 0 ? '+' : '';
      idxLine += q.name + ' ' + q.price.toFixed(2) + ' (' + sign + q.changePercent.toFixed(2) + '%)  ';
    }
    lines.push(idxLine.trim());
  }

  // ADR
  if (summary.adr && summary.adr.composite != null) {
    var sign = summary.adr.composite >= 0 ? '+' : '';
    lines.push('中概ADR综合: ' + sign + summary.adr.composite.toFixed(2) + '%  [' + summary.adr.sentiment + ']');
  }

  // A-stock sentiment
  if (summary.aStockSentiment) {
    lines.push('A股次日情绪: ' + summary.aStockSentiment.score + '  [' + summary.aStockSentiment.level + ']');
    if (summary.aStockSentiment.signals && summary.aStockSentiment.signals.length > 0) {
      for (var j = 0; j < summary.aStockSentiment.signals.length; j++) {
        lines.push('  ' + summary.aStockSentiment.signals[j]);
      }
    }
  }

  return lines.join('\n');
}

module.exports = {
  generateOvernightSummary,
  summarizeADR,
  summarizeSectors,
  computeAStockSentiment,
  computeSectorOutlook,
  formatTextSummary,
};
