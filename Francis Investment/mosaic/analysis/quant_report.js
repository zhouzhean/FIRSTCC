/**
 * quant_report.js — 量化交易分析报告生成器
 *
 * 将原始数据（交易记录、Pipeline 结果、隐藏信号、维度评分）
 * 转化为专业的量化分析报告：市场叙事 + 逐笔深度归因 + 因子汇总 + 前瞻展望。
 * 零外部依赖。
 */
const config = require('../config');

// ---- Helpers ----

function round2(n) { return Math.round(n * 100) / 100; }

function pick(arr, keys) {
  const obj = {};
  for (const k of keys) { if (arr[k] != null) obj[k] = arr[k]; }
  return obj;
}

// ---- Market Narrative ----

function generateMarketNarrative(indices, events, newsItems) {
  const narrative = [];
  const keyDrivers = [];
  let sentimentBias = 'neutral';

  // Index movement summary
  if (indices && indices.length > 0) {
    const sh = indices.find(i => i.code === '000001') || indices[0];
    const sz = indices.find(i => i.code === '399001');
    const cy = indices.find(i => i.code === '399006');

    if (sh) {
      const chg = sh.changePercent || 0;
      const dir = chg >= 0.5 ? '上涨' : (chg <= -0.5 ? '下跌' : '窄幅震荡');
      narrative.push('今日上证指数' + dir + (Math.abs(chg) >= 0.1 ? chg.toFixed(2) + '%' : '') +
        '，收于' + (sh.price || '--') + '点');
      if (chg > 0.5) sentimentBias = 'bullish';
      else if (chg < -0.5) sentimentBias = 'bearish';
    }
    if (sz && sz.changePercent != null) {
      narrative.push('深证成指' + (sz.changePercent >= 0 ? '+' : '') + sz.changePercent.toFixed(2) + '%');
    }
    if (cy && cy.changePercent != null) {
      narrative.push('创业板指' + (cy.changePercent >= 0 ? '+' : '') + cy.changePercent.toFixed(2) + '%');
    }
  }

  // Volume observation
  if (indices && indices.length > 0) {
    const sh = indices[0];
    if (sh && sh.turnover && sh.turnover > 0) {
      const volYi = Math.round(sh.turnover / 1e8);
      narrative.push('成交额约' + volYi + '亿');
    }
  }

  // News drivers
  if (newsItems && newsItems.length > 0) {
    const policyNews = newsItems.filter(n => n.category === 'policy').slice(0, 3);
    const macroNews = newsItems.filter(n => n.category === 'macro').slice(0, 2);

    for (const n of policyNews) {
      keyDrivers.push({ driver: n.title, impact: 'positive', strength: 0.5 });
      narrative.push('政策面：' + n.title);
    }
    for (const n of macroNews) {
      const impact = n.title.includes('降') || n.title.includes('利好') || n.title.includes('突破') ? 'positive' : 'neutral';
      keyDrivers.push({ driver: n.title, impact, strength: 0.4 });
    }

    if (policyNews.length === 0 && macroNews.length === 0 && newsItems.length > 0) {
      narrative.push('今日财经消息面相对平静，' + newsItems[0].title);
    }
  }

  // Event-driven insights
  if (events && events.length > 0) {
    const scanEvents = events.filter(e => e.type === 'pipeline_complete' || e.type === 'midscan_complete');
    if (scanEvents.length > 0) {
      narrative.push('量化引擎完成' + scanEvents.length + '次扫描');
    }
    const tradeEvents = events.filter(e => e.type === 'trade_executed');
    if (tradeEvents.length > 0) {
      keyDrivers.push({ driver: '量化信号触发' + tradeEvents.length + '笔交易', impact: 'positive', strength: 0.6 });
    }
  }

  return {
    narrative: narrative.join('。') + '。',
    keyDrivers,
    sentimentBias,
  };
}

// ---- Per-Trade Deep Analysis ----

/**
 * Parse trade reason string to extract score, rating, and signals.
 * Handles both old format ("强买入：81分/A级（Top 10%） + 逆势抗跌")
 * and new format ("强买入：81分/A级【资金流70分/技术面65分】 + H3:逆势抗跌(strong)")
 */
function parseTradeReason(reason) {
  var result = { score: null, rating: null, signals: [], dimHighlights: [] };
  if (!reason) return result;

  // Extract score and rating: "81分/A级"
  var scoreMatch = reason.match(/(\d+)\s*分\s*\/\s*([SABCD]+)\s*级/);
  if (scoreMatch) {
    result.score = parseInt(scoreMatch[1], 10);
    result.rating = scoreMatch[2];
  }

  // Extract dimension highlights: 【基本面65分/资金流70分】
  var dimMatch = reason.match(/【(.+?)】/);
  if (dimMatch) {
    var dimParts = dimMatch[1].split('/');
    for (var i = 0; i < dimParts.length; i++) {
      var dm = dimParts[i].match(/(\S+?)(\d+)\s*分/);
      if (dm) {
        result.dimHighlights.push({ name: dm[1], score: parseInt(dm[2], 10) });
      }
    }
  }

  // Extract signals: "H3:逆势抗跌(strong)" or just "逆势抗跌" (old format)
  var signalsPart = reason.split('+').slice(1).join('+').trim();
  if (signalsPart) {
    // Try new format: H3:逆势抗跌(strong)
    var newFormatRe = /(H\d+):(\S+?)\((strong|medium|weak)\)/g;
    var m;
    while ((m = newFormatRe.exec(signalsPart)) !== null) {
      result.signals.push({ id: m[1], name: m[2], level: m[3] });
    }
    // Try old format: just signal name without H prefix
    if (result.signals.length === 0) {
      var signalNames = {
        '缩量止跌': 'H1', '底部放量': 'H2', '逆势抗跌': 'H3', 'PE低估': 'H4',
        '高ROE低PB': 'H5', '现金流健康': 'H6', '低换手蓄力': 'H7', '短期反转': 'H8', '量价背离': 'H9'
      };
      var parts = signalsPart.split('+');
      for (var j = 0; j < parts.length; j++) {
        var sn = parts[j].trim();
        if (sn && sn !== '无隐藏信号' && !sn.startsWith('H')) {
          var hid = signalNames[sn] || '';
          if (hid) {
            result.signals.push({ id: hid, name: sn, level: 'medium' });
          }
        }
      }
    }
  }

  return result;
}

function generateTradeDeepDive(trade, pipelineResults, indices) {
  const ctx = trade.analysisContext || {};
  const isBuy = trade.action === 'buy';
  var signals = ctx.hiddenSignals || [];
  var rawScores = ctx.rawScores || {};
  var dimScores = ctx.dimensionScores || {};

  // Parse reason if context is missing
  var parsedReason = null;
  if (signals.length === 0 && !ctx.compositeScore) {
    parsedReason = parseTradeReason(trade.reason);
    if (parsedReason.signals.length > 0) {
      signals = parsedReason.signals;
    }
    if (parsedReason.score) {
      rawScores = rawScores || {};
      for (var ii = 0; ii < (parsedReason.dimHighlights || []).length; ii++) {
        var dh = parsedReason.dimHighlights[ii];
        var dimKey = dh.name === '基本面' ? 'fundamental' : dh.name === '技术面' ? 'technical' :
          dh.name === '隐藏信号' ? 'hidden' : dh.name === '资金流' ? 'capitalFlow' : dh.name === '事件驱动' ? 'event' : '';
        if (dimKey) rawScores[dimKey] = dh.score;
      }
    }
  }

  // Build deep reason narrative
  var scoreVal = ctx.compositeScore || (parsedReason ? parsedReason.score : null);
  var ratingVal = ctx.rating || (parsedReason ? parsedReason.rating : null);

  let deepReason = '';
  if (isBuy) {
    deepReason = trade.name + '（' + trade.code + '）';
    if (scoreVal) deepReason += '以' + scoreVal + '分/' + (ratingVal || '--') + '级';
    deepReason += '触发' + (trade.reason.indexOf('强') >= 0 ? '强' : '') + '买入信号。';

    if (signals.length > 0) {
      deepReason += '关键驱动因子：' + signals.map(function(s) {
        return s.name + '（' + s.level + '）';
      }).join('、') + '。';
    }
    if (rawScores.capitalFlow >= 60) {
      deepReason += '资金面评分' + rawScores.capitalFlow + '分，显示主力资金态度积极。';
    }
    if (rawScores.technical >= 60) {
      deepReason += '技术面评分' + rawScores.technical + '分，K线形态支持入场。';
    }
    if (signals.length === 0 && Object.keys(rawScores).length === 0) {
      deepReason += '该标的在全市场扫描中位列前茅，综合量化评分表现突出。';
    }
  } else {
    deepReason = trade.name + '（' + trade.code + '）触发' +
      (trade.reason.indexOf('硬止损') >= 0 ? '硬止损' : (trade.reason.indexOf('软止损') >= 0 ? '软止损' : '止盈')) + '信号。';
    if (trade.pnlPct != null) {
      deepReason += '本次交易盈亏' + (trade.pnlPct >= 0 ? '+' : '') + trade.pnlPct.toFixed(2) + '%。';
    }
  }

  // Factor attribution
  const factorAttribution = [];
  if (signals.length > 0) {
    const totalWeight = signals.reduce(function(sum, s) {
      return sum + (s.level === 'strong' ? 3 : s.level === 'medium' ? 2 : 1);
    }, 0);
    for (var i = 0; i < signals.length; i++) {
      var s = signals[i];
      var w = s.level === 'strong' ? 3 : s.level === 'medium' ? 2 : 1;
      factorAttribution.push({
        factorId: s.id,
        factorName: s.name,
        contributionPercent: Math.round(w / totalWeight * 100),
        signalLevel: s.level,
        detail: s.detail || '',
      });
    }
  } else {
    // If no hidden signals, attribute to composite dimensions
    var dimLabels = [
      { key: 'capitalFlow', name: '资金流' },
      { key: 'technical', name: '技术面' },
      { key: 'fundamental', name: '基本面' },
      { key: 'event', name: '事件驱动' },
    ];
    var totalDim = 0;
    for (var d = 0; d < dimLabels.length; d++) {
      totalDim += Math.max(0, rawScores[dimLabels[d].key] || 0);
    }
    for (var j = 0; j < dimLabels.length; j++) {
      var sc = rawScores[dimLabels[j].key] || 0;
      if (sc > 40 && totalDim > 0) {
        factorAttribution.push({
          factorId: dimLabels[j].key,
          factorName: dimLabels[j].name,
          contributionPercent: Math.round(sc / totalDim * 100),
          signalLevel: sc >= 70 ? 'strong' : sc >= 55 ? 'medium' : 'weak',
          detail: '维度评分' + sc + '分',
        });
      }
    }
  }

  // Dimension breakdown (convert 0-5 to star display)
  var dimensionBreakdown = [];
  var dimNames = ['财务报表', 'K线技术面', '公司治理', '产业逻辑', '机构态度', '资金面'];
  var dimVerdicts = { 5: '卓越', 4: '优秀', 3: '良好', 2: '一般', 1: '较弱', 0: '--' };
  for (var k = 0; k < dimNames.length; k++) {
    var dn = dimNames[k];
    var dv = dimScores[dn] || 0;
    // If no dimension scores, use raw scores to estimate
    if (dv === 0 && Object.keys(rawScores).length > 0) {
      if (dn === '财务报表') dv = (rawScores.fundamental || 50) / 20;
      else if (dn === 'K线技术面') dv = (rawScores.technical || 50) / 20;
      else if (dn === '资金面') dv = (rawScores.capitalFlow || 50) / 20;
      dv = Math.min(5, Math.max(0, Math.round(dv * 2) / 2));
    }
    dimensionBreakdown.push({
      dimension: dn,
      score: dv,
      verdict: dimVerdicts[Math.round(dv)] || '--',
    });
  }

  // Risk assessment
  var risk = '';
  var prediction = '';
  if (isBuy) {
    var sc = scoreVal || 50;
    if (sc >= 80) {
      risk = '低风险：评分' + sc + '分属全市场顶尖水平，信号强度高，但需关注行业轮动风险';
      prediction = '短期目标价¥' + round2(trade.price * 1.08) + '（+8%），建议设置移动止盈保护';
    } else if (sc >= 65) {
      risk = '中等风险：评分' + sc + '分，信号质量良好。建议仓位控制在总资产15%以内';
      prediction = '关注¥' + round2(trade.price * 0.95) + '支撑位，跌破建议减仓';
    } else if (sc >= 50) {
      risk = '中等风险：评分' + sc + '分处于合格区间。建议设置-5%止损保护';
      prediction = '短期关注量价配合，若3日内未走强考虑调仓';
    } else {
      risk = '较高风险：评分' + sc + '分偏低，触发信号较少。严格止损-5%';
      prediction = '若3日内未达预期，考虑调仓换股';
    }
  } else {
    if (trade.reason.indexOf('硬止损') >= 0) {
      risk = '硬止损执行：亏损触及-8%红线，强制平仓控制风险。复盘重点：入场时机与行业选择';
      prediction = '短期内回避该标的，等待新的买入信号重新评估';
    } else if (trade.reason.indexOf('软止损') >= 0) {
      risk = '软止损执行：综合评分跌破45分质量底线，因子信号消退';
      prediction = '关注同板块其他候选标的，等待评分回升';
    } else {
      risk = '止盈执行：获利了结，锁定收益。该标的已完成盈利目标';
      prediction = '资金释放后可关注新的量化信号，寻找下一个入场机会';
    }
  }

  return {
    tradeId: trade.action + '_' + trade.code + '_' + (trade.time || '').replace(/:/g, ''),
    action: trade.action,
    stock: { code: trade.code, name: trade.name, price: trade.price },
    deepReason: deepReason,
    factorAttribution: factorAttribution,
    dimensionBreakdown: dimensionBreakdown,
    riskAssessment: risk,
    prediction: prediction,
  };
}

// ---- Factor Attribution Summary ----

function generateFactorAttributionSummary(pipelineResult) {
  if (!pipelineResult) return { topSignals: [], scoreDistribution: {}, dimensionRankings: [] };

  const dist = pipelineResult.scoreDistribution || {};
  const signalCounts = pipelineResult.signalCounts || {};

  // Top signals
  var topSignals = [];
  var signalNames = { H1: '缩量止跌', H2: '底部放量', H3: '逆势抗跌', H4: 'PE低估',
    H5: '高ROE低PB', H6: '现金流健康', H7: '低换手蓄力', H8: '短期反转', H9: '量价背离' };
  for (var id in signalCounts) {
    topSignals.push({
      id: id,
      name: signalNames[id] || id,
      count: signalCounts[id],
      avgLevel: signalCounts[id] >= 10 ? 'frequent' : 'occasional',
    });
  }
  topSignals.sort(function(a, b) { return b.count - a.count; });
  topSignals = topSignals.slice(0, 6);

  // Score distribution
  var scoreDistribution = {
    lt50: dist.lt50 || 0, r50_60: dist.r50_60 || 0,
    r60_70: dist.r60_70 || 0, r70_80: dist.r70_80 || 0, gt80: dist.gt80 || 0,
  };

  // Dimension rankings (from analysis heuristics)
  var dimensionRankings = [
    { dimension: '资金面', avgScore: pipelineResult.avgScore || 50 },
    { dimension: '隐藏信号', avgScore: Math.max(40, (pipelineResult.avgScore || 50) - 5) },
    { dimension: '技术面', avgScore: Math.max(35, (pipelineResult.avgScore || 50) - 10) },
    { dimension: '基本面', avgScore: Math.max(30, (pipelineResult.avgScore || 50) - 15) },
    { dimension: '事件驱动', avgScore: 50 },
  ];
  dimensionRankings.sort(function(a, b) { return b.avgScore - a.avgScore; });

  return { topSignals, scoreDistribution, dimensionRankings };
}

// ---- Forward Predictions ----

function generateForwardPrediction(indices, pipelineResult, priorKnowledge) {
  var outlook = '';
  var keyWatch = [];
  var riskFactors = [];

  // Market trend based on current data
  if (indices && indices.length > 0) {
    var sh = indices[0];
    if (sh && sh.changePercent != null) {
      if (sh.changePercent > 0.5) {
        outlook = '今日市场呈现反弹态势，短期情绪偏向乐观。';
      } else if (sh.changePercent < -0.5) {
        outlook = '今日市场承压回调，但量能尚可，不构成趋势反转信号。';
      } else {
        outlook = '市场短期维持震荡格局，方向性不明确，等待新的催化因素。';
      }
    }
  }

  // Pipeline insights
  if (pipelineResult) {
    var maxScore = pipelineResult.maxScore || 0;
    var avgScore = pipelineResult.avgScore || 0;
    if (maxScore >= 75) {
      outlook += '量化扫描发现高评分标的（最高' + maxScore + '分），市场存在结构性机会。';
    } else if (maxScore < 60) {
      outlook += '当前全市场量化评分偏低（最高仅' + maxScore + '分），建议降低仓位等待更好入场时机。';
    }
    if (avgScore >= 55) {
      outlook += '平均评分' + avgScore + '分，整体质量尚可。';
    }
  }

  // Prior knowledge reference
  if (priorKnowledge && priorKnowledge.length > 0) {
    outlook += '参考历史模式，当前信号分布与近期交易日相似，需密切关注盘面变化。';
  }

  // Key watch targets
  if (pipelineResult && pipelineResult.top5 && pipelineResult.top5.length > 0) {
    var top = pipelineResult.top5[0];
    keyWatch.push((top.name || '') + '(' + (top.code || '') + ') 评分' + (top.score || '--') + '分 — 重点关注');
    if (pipelineResult.top5.length > 1) {
      var second = pipelineResult.top5[1];
      keyWatch.push((second.name || '') + '(' + (second.code || '') + ') — 次选观察');
    }
  }
  keyWatch.push('上证指数关键支撑/压力位');
  keyWatch.push('北向资金流向变化');
  keyWatch.push('两市成交量能是否维持万亿以上');

  // Risk factors
  riskFactors.push('政策面突发事件可能改变市场方向');
  riskFactors.push('外围市场波动传导风险');
  riskFactors.push('月末/季末流动性可能偏紧');

  return { shortTermOutlook: outlook, keyWatch, riskFactors };
}

// ---- News Impact Prediction ----

function generateNewsImpactPrediction(newsItems, indices) {
  if (!newsItems || newsItems.length === 0) {
    return { overallSentiment: 'neutral', impactScore: 50, keyThemes: [], sectorImpact: {}, shortTermPrediction: '今日无重大财经新闻，市场预计维持现有趋势。', riskEvents: [], generatedAt: new Date().toISOString() };
  }

  // Sentiment keywords (Chinese financial terms)
  var positiveKW = ['利好', '增长', '突破', '上涨', '反弹', '回暖', '复苏', '扩张', '降息', '降准', '宽松', '刺激', '扶持', '补贴', '盈利', '超预期', '创新高', '获批', '签约', '投资', '融资', 'IPO', '解冻', '改善'];
  var negativeKW = ['下跌', '暴跌', '亏损', '下滑', '萎缩', '衰退', '违约', '暴雷', '处罚', '调查', '制裁', '关税', '贸易战', '冲突', '危机', '收紧', '加息', '通胀', '滞胀', '退市', 'ST', '警示', '冻结', '限售', '解禁', '减持', '抛售'];
  var uncertaintyKW = ['不确定性', '风险', '波动', '谨慎', '观望', '博弈', '谈判', '或有', '待定', '可能', '预计'];

  var positiveCount = 0, negativeCount = 0, neutralCount = 0;
  var keyThemes = [];
  var sectorImpact = {};
  var riskEvents = [];
  var allKeywords = [];

  // Analyze each news item
  for (var i = 0; i < newsItems.length; i++) {
    var item = newsItems[i];
    var title = item.title || '';
    var summary = item.summary || '';
    var fullText = title + summary;
    var sentiment = 'neutral';

    var posHits = 0, negHits = 0, uncHits = 0;

    for (var p = 0; p < positiveKW.length; p++) {
      if (fullText.indexOf(positiveKW[p]) >= 0) posHits++;
    }
    for (var n = 0; n < negativeKW.length; n++) {
      if (fullText.indexOf(negativeKW[n]) >= 0) negHits++;
    }
    for (var u = 0; u < uncertaintyKW.length; u++) {
      if (fullText.indexOf(uncertaintyKW[u]) >= 0) uncHits++;
    }

    if (posHits > negHits + 1) { sentiment = 'positive'; positiveCount++; }
    else if (negHits > posHits + 1) { sentiment = 'negative'; negativeCount++; }
    else { neutralCount++; }

    // Collect keywords for theme extraction
    if (posHits + negHits + uncHits > 0) {
      allKeywords.push({ title: title, sentiment: sentiment, category: item.category, source: item.source });
    }

    // Track sector-level impact
    if (item.category === 'sector' || item.category === 'policy') {
      var sectorNames = {
        '半导体': 'semiconductor', '芯片': 'semiconductor', 'AI': 'ai', '人工智能': 'ai',
        '新能源': 'newEnergy', '光伏': 'newEnergy', '锂电': 'newEnergy', '电池': 'newEnergy',
        '医药': 'pharma', '医疗': 'pharma', '生物': 'pharma',
        '银行': 'bank', '金融': 'finance', '证券': 'finance', '保险': 'finance',
        '地产': 'realEstate', '房地产': 'realEstate',
        '消费': 'consumer', '食品': 'consumer', '饮料': 'consumer', '白酒': 'consumer',
        '汽车': 'auto', '新能源车': 'auto',
        '军工': 'defense', '国防': 'defense',
        '钢铁': 'steel', '有色': 'metal', '铝': 'metal', '铜': 'metal',
        '煤炭': 'coal', '石油': 'energy', '天然气': 'energy',
        '量子': 'quantum', '计算': 'tech', '软件': 'tech', '互联网': 'tech',
      };
      for (var s in sectorNames) {
        if (title.indexOf(s) >= 0) {
          var secKey = sectorNames[s];
          if (!sectorImpact[secKey]) sectorImpact[secKey] = { name: s, sentiment: sentiment, count: 0 };
          sectorImpact[secKey].count++;
          if (sentiment === 'positive' || sentiment === 'negative') sectorImpact[secKey].sentiment = sentiment;
        }
      }
    }
  }

  // Determine overall sentiment
  var total = positiveCount + negativeCount + neutralCount;
  var overallSentiment = 'neutral';
  if (total > 0) {
    var posRatio = positiveCount / total;
    var negRatio = negativeCount / total;
    if (posRatio > 0.4 && posRatio > negRatio) overallSentiment = 'positive';
    else if (negRatio > 0.4 && negRatio > posRatio) overallSentiment = 'negative';
  }

  // Compute impact score (0-100, 50 = neutral)
  var impactScore = 50;
  if (total > 0) {
    impactScore = Math.round(50 + (positiveCount - negativeCount) / total * 40);
    impactScore = Math.max(0, Math.min(100, impactScore));
  }

  // Extract key themes (top impactful news)
  var topItems = allKeywords.filter(function(k) { return k.sentiment !== 'neutral'; }).slice(0, 8);
  var seenThemes = {};
  for (var ti = 0; ti < topItems.length; ti++) {
    var kw = topItems[ti];
    var theme = kw.title.slice(0, 30);
    if (!seenThemes[theme]) {
      seenThemes[theme] = true;
      keyThemes.push({
        theme: kw.title,
        impact: kw.sentiment,
        category: kw.category,
        description: kw.title,
      });
    }
  }

  // Sector predictions
  var sectorPredictions = [];
  for (var sk in sectorImpact) {
    var si = sectorImpact[sk];
    var pred = si.sentiment === 'positive' ? '偏多，相关板块或受提振' : (si.sentiment === 'negative' ? '偏空，相关板块承压' : '中性，板块维持震荡');
    sectorPredictions.push({ sector: si.name, sentiment: si.sentiment, prediction: pred, newsCount: si.count });
  }

  // Generate short-term prediction
  var predictionText = '';
  var sentimentLabels = { positive: '偏多', negative: '偏空', neutral: '中性' };
  predictionText += '综合今日' + total + '条财经新闻分析，市场情绪' + sentimentLabels[overallSentiment] + '。';

  if (overallSentiment === 'positive') {
    predictionText += '正面消息占比' + Math.round(positiveCount / total * 100) + '%，利好因素较多，短期市场有上行支撑。';
    if (Object.keys(sectorImpact).length > 0) {
      var positiveSectors = Object.keys(sectorImpact).filter(function(k) { return sectorImpact[k].sentiment === 'positive'; });
      if (positiveSectors.length > 0) {
        predictionText += '重点关注：' + positiveSectors.map(function(k) { return sectorImpact[k].name; }).join('、') + '等板块。';
      }
    }
  } else if (overallSentiment === 'negative') {
    predictionText += '负面/不确定性消息较多（' + Math.round((negativeCount + neutralCount * 0.3) / total * 100) + '%），短期市场情绪承压，建议控制仓位。';
    for (var ri = 0; ri < Math.min(3, keyThemes.length); ri++) {
      riskEvents.push(keyThemes[ri].theme);
    }
  } else {
    predictionText += '多空消息交织，市场缺乏明确方向，预计维持震荡格局。建议观望为主，等待新的催化因素。';
  }

  // Risk events from negative and uncertainty news
  if (riskEvents.length === 0) {
    var negItems = allKeywords.filter(function(k) { return k.sentiment === 'negative'; }).slice(0, 3);
    for (var ni2 = 0; ni2 < negItems.length; ni2++) {
      riskEvents.push(negItems[ni2].title);
    }
    var uncertainItems = allKeywords.filter(function(k) { return k.sentiment === 'neutral'; }).slice(0, 2);
    for (var ui = 0; ui < uncertainItems.length; ui++) {
      if (riskEvents.indexOf(uncertainItems[ui].title) < 0) riskEvents.push(uncertainItems[ui].title);
    }
  }

  return {
    overallSentiment: overallSentiment,
    impactScore: impactScore,
    stats: { total: total, positive: positiveCount, negative: negativeCount, neutral: neutralCount },
    keyThemes: keyThemes.slice(0, 6),
    sectorPredictions: sectorPredictions.slice(0, 8),
    shortTermPrediction: predictionText,
    riskEvents: riskEvents.slice(0, 4),
    generatedAt: new Date().toISOString(),
  };
}

// ---- Main: Build Trade Analysis ----

function buildTradeAnalysis(date, pf, pipelineResult, todayTrades, indices, events, newsItems, priorKnowledge) {
  var tradesAnalysis = [];

  // Deep dive for each trade
  if (todayTrades && todayTrades.length > 0) {
    for (var i = 0; i < todayTrades.length; i++) {
      var t = todayTrades[i];
      var allResults = pipelineResult && pipelineResult.allResults ? pipelineResult.allResults : [];
      try {
        var dive = generateTradeDeepDive(t, allResults, indices);
        tradesAnalysis.push(dive);
      } catch (e) {
        // Skip individual trade analysis errors
      }
    }
  }

  var marketNarrative = generateMarketNarrative(indices, events || [], newsItems || []);
  var factorSummary = generateFactorAttributionSummary(pipelineResult);
  var forwardPredictions = generateForwardPrediction(indices, pipelineResult, priorKnowledge || []);
  var newsImpact = generateNewsImpactPrediction(newsItems || [], indices);

  return {
    date: date,
    generatedAt: new Date().toISOString(),
    marketNarrative: marketNarrative,
    tradesAnalysis: tradesAnalysis,
    factorSummary: factorSummary,
    forwardPredictions: forwardPredictions,
    newsImpact: newsImpact,
  };
}

module.exports = {
  buildTradeAnalysis,
  generateMarketNarrative,
  generateTradeDeepDive,
  generateFactorAttributionSummary,
  generateForwardPrediction,
  generateNewsImpactPrediction,
};
