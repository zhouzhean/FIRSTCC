/**
 * composite.js — 综合评分引擎
 *
 * 替代人工6维评分，自动计算：
 *   TotalScore = fundamental(25%) + technical(20%) + hidden(35%) + capital_flow(20%)
 *
 * 输出与现有 recommendation-history.json 兼容的评分结构。
 */
const config = require('../config');

// ---- Individual dimension scorers (each returns 0-100) ----

/**
 * 基本面评分 (0-100)
 * 基于：PE、ROE、负债率、营收增长、净利增长、经营现金流
 */
function scoreFundamental(stock, detail) {
  let score = 50; // neutral start
  const pe = stock.peTTM || stock.pe;
  const d = detail || {};

  // PE: lower is better (but negative PE is bad)
  if (pe != null && pe > 0 && pe < 15) score += 15;
  else if (pe != null && pe > 0 && pe < 25) score += 8;
  else if (pe != null && pe > 0 && pe < 40) score += 3;
  else if (pe != null && pe < 0) score -= 10;
  else score -= 3;

  // ROE
  if (d.roe != null && d.roe > 15) score += 12;
  else if (d.roe != null && d.roe > 10) score += 6;
  else if (d.roe != null && d.roe > 5) score += 2;
  else if (d.roe != null && d.roe < 0) score -= 8;

  // Debt ratio
  if (d.debtRatio != null && d.debtRatio < 30) score += 10;
  else if (d.debtRatio != null && d.debtRatio < 50) score += 4;
  else if (d.debtRatio != null && d.debtRatio > 70) score -= 8;

  // Revenue growth
  if (d.revenueGrowth != null && d.revenueGrowth > 20) score += 10;
  else if (d.revenueGrowth != null && d.revenueGrowth > 0) score += 4;
  else if (d.revenueGrowth != null && d.revenueGrowth < -10) score -= 8;

  // Net profit growth
  if (d.npGrowth != null && d.npGrowth > 30) score += 10;
  else if (d.npGrowth != null && d.npGrowth > 0) score += 3;
  else if (d.npGrowth != null && d.npGrowth < 0) score -= 6;

  // OCF
  if (d.ocfPerShare != null && d.ocfPerShare > 0.5) score += 8;
  else if (d.ocfPerShare != null && d.ocfPerShare > 0) score += 3;
  else if (d.ocfPerShare != null && d.ocfPerShare < 0) score -= 5;

  return Math.max(0, Math.min(100, score));
}

/**
 * 技术面评分 (0-100)
 * 基于：涨跌幅、振幅、量比、价格位置（距52周高低点）
 */
function scoreTechnical(stock, klines) {
  let score = 50;
  const chg = stock.changePercent || 0;
  const ampl = stock.amplitude || 0;
  const volRatio = stock.volumeRatio || 1;
  const price = stock.price || 0;
  const high = stock.high || price;
  const low = stock.low || price;

  // Change direction: moderate up is ideal
  if (chg > 1 && chg < 5) score += 12;
  else if (chg > 0 && chg <= 1) score += 5;
  else if (chg > 5) score += 2; // too hot
  else if (chg > -1) score += 0;
  else if (chg > -3) score -= 5;
  else score -= 12; // big drop

  // Volatility: moderate is best
  if (ampl > 2 && ampl < 6) score += 8;
  else if (ampl < 2) score += 2; // too quiet
  else if (ampl > 8) score -= 5;

  // Volume ratio
  if (volRatio > 0.8 && volRatio < 2) score += 5;
  else if (volRatio >= 2) score += 3; // active
  else if (volRatio < 0.5) score -= 3;

  // Price position within day
  if (price > 0 && high > 0) {
    const pos = (price - low) / (high - low); // 0-1
    if (pos > 0.6) score += 5; // closed near high
    else if (pos < 0.3) score -= 5; // closed near low
  }

  // K-line based scoring (if available)
  if (klines && klines.length >= 5) {
    const closes = klines.map(k => k.close);
    // Simple MA trend
    const ma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    if (price > ma5 * 1.02) score += 8; // above MA
    else if (price < ma5 * 0.98) score -= 5; // below MA
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * 资金面评分 (0-100)
 * 基于：成交额、换手率
 */
/**
 * 资金面评分 (0-100) — 方向性资金流 + 活跃度
 *
 * 优先使用主力资金流方向数据；无数据时回退到成交活跃度指标。
 * @param {object} stock - Stock with optional capital flow fields
 * @param {Map} sectorFlowMap - Optional sector→flowRecord map for sector ranking
 * @param {object} stockFlowHistory - Optional per-stock flow history { majorNetFlow[] }
 */
function scoreCapitalFlow(stock, sectorFlowMap, stockFlowHistory) {
  // If we have directional capital flow data, use it
  if (stock.majorNetFlow != null) {
    return scoreDirectionalFlow(stock, sectorFlowMap, stockFlowHistory);
  }
  // Fallback: activity-based scoring
  return scoreActivity(stock);
}

/**
 * Directional capital flow scoring.
 * Measures: big money direction, smart/money divergence, sector flow resonance.
 */
function scoreDirectionalFlow(stock, sectorFlowMap, stockFlowHistory) {
  let score = 50;
  const turnover = stock.turnover || 0;

  // 1. 主力净流入占比 (majorNetFlow / turnover)
  if (turnover > 0) {
    const flowRatio = stock.majorNetFlow / turnover;
    if (flowRatio > 0.05) score += 20;       // >5% = strong buying
    else if (flowRatio > 0.02) score += 12;
    else if (flowRatio > 0) score += 5;
    else if (flowRatio < -0.05) score -= 20; // >5% = strong selling
    else if (flowRatio < -0.02) score -= 12;
    else if (flowRatio < 0) score -= 5;
  }

  // 2. 超大单 vs 小单背离 (smart money vs retail)
  if (stock.superLargeNetFlow != null && stock.smallNetFlow != null) {
    const divergence = stock.superLargeNetFlow - stock.smallNetFlow;
    if (divergence > 0) score += 15;   // Institutions buying, retail selling = bullish
    else score -= 10;                   // Institutions selling, retail buying = bearish
  }

  // 3. 板块资金流共振
  if (sectorFlowMap && sectorFlowMap.size > 0) {
    const sectorRank = getSectorFlowRank(stock, sectorFlowMap);
    if (sectorRank != null) {
      if (sectorRank <= 0.10) score += 10;      // Top 10% sector
      else if (sectorRank <= 0.25) score += 5;
      else if (sectorRank >= 0.75) score -= 8;   // Bottom 25% sector
    }
  }

  // 4. 连续流入天数
  if (stockFlowHistory && stockFlowHistory.length >= 3) {
    let consecutiveInflows = 0;
    for (let i = stockFlowHistory.length - 1; i >= 0; i--) {
      if (stockFlowHistory[i].majorNetFlow > 0) consecutiveInflows++;
      else break;
    }
    if (consecutiveInflows >= 5) score += 10;
    else if (consecutiveInflows >= 3) score += 5;
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Activity-based scoring (fallback when no directional data).
 */
function scoreActivity(stock) {
  // Base score 35 (was 50) — activity alone does not mean capital is bullish.
  // Without directional flow data, the stock gets a below-average starting point.
  let score = 35;
  const turnover = stock.turnover || 0;
  const turnoverRate = stock.turnoverRate || 0;

  if (turnover > 5e8) score += 15;
  else if (turnover > 2e8) score += 10;
  else if (turnover > 1e8) score += 5;
  else if (turnover < 5e7) score -= 5;

  if (turnoverRate > 2 && turnoverRate < 8) score += 10;
  else if (turnoverRate >= 1 && turnoverRate <= 2) score += 5;
  else if (turnoverRate < 0.5) score -= 3;
  else if (turnoverRate > 15) score -= 3;

  const volRatio = stock.volumeRatio || 1;
  if (volRatio > 1 && volRatio < 2.5) score += 5;

  return Math.max(0, Math.min(100, score));
}

/**
 * Get a stock's sector flow percentile rank.
 * Lower = better (top 10% = 0.10).
 */
function getSectorFlowRank(stock, sectorFlowMap) {
  const sectors = Array.from(sectorFlowMap.values());
  if (sectors.length === 0) return null;

  // Sort by majorNetFlow descending
  sectors.sort((a, b) => (b.majorNetFlow || 0) - (a.majorNetFlow || 0));

  // Find matching sector via keyword in stock name
  // Simple approach: scan all sectors, find best keyword match
  let bestRank = null;
  for (let i = 0; i < sectors.length; i++) {
    const sec = sectors[i];
    if (!sec.name) continue;
    // Check if sector name keywords appear in stock name or vice versa
    if (stock.name && stock.name.includes(sec.name.slice(0, 2))) {
      bestRank = i / sectors.length;
      break;
    }
  }
  return bestRank;
}

// ---- 6-dimension star ratings (compatible with existing format) ----

function starsFromScore(score) {
  if (score >= 90) return { stars: '★★★★★', rating: 5.0, cls: 'up' };
  if (score >= 80) return { stars: '★★★★☆', rating: 4.0, cls: 'up' };
  if (score >= 70) return { stars: '★★★☆', rating: 3.5, cls: 'up' };
  if (score >= 60) return { stars: '★★★', rating: 3.0, cls: 'flat' };
  if (score >= 50) return { stars: '★★☆', rating: 2.5, cls: 'flat' };
  if (score >= 40) return { stars: '★★', rating: 2.0, cls: 'down' };
  /* <40 */  return { stars: '★☆', rating: 1.5, cls: 'down' };
}

// ---- Main composite score ----

/**
 * Compute composite score and 6-dimension breakdown for a stock.
 * @returns {object} compositeScore (0-100 int), dimensionScores {6 keys}, rating letter
 */
function computeCompositeScore(stock, detail, klines, hiddenResult, marketDown, context) {
  const ctx = context || {};
  const fundamental = scoreFundamental(stock, detail);
  const technical = scoreTechnical(stock, klines);
  const hidden = hiddenResult ? hiddenResult.score : 50;  // neutral=50, not 0
  const capitalFlow = scoreCapitalFlow(stock, ctx.sectorFlowMap, ctx.stockFlowHistory);

  // Event score: dragon-tiger board signal
  let eventScore = 50;
  if (ctx.lhbSignal) {
    const sig = ctx.lhbSignal;
    if (sig.signal === 'strong') eventScore = 85;
    else if (sig.signal === 'medium') eventScore = 70;
    else if (sig.signal === 'weak' && sig.netAmt > 0) eventScore = 60;
    else if (sig.netAmt < 0) eventScore = 40;
  }

  // Detect data quality: if detail is missing, fundamental data is thin
  const hasDetail = detail && (detail.roe != null || detail.debtRatio != null || detail.revenueGrowth != null);
  const dataQuality = hasDetail ? 'full' : 'thin';

  // === P1-4: Real-time factor performance penalty ===
  // If a hidden factor signal was triggered but that factor has historically
  // low hit rate (< 30%), downgrade the signal level or discard it entirely.
  // This prevents 0% hit-rate factors like H3 from inflating scores.
  let coldFactorPenalty = 0;
  let coldFactorsSet = null;
  try {
    const factorPerf = require('../analysis/factor_performance');
    coldFactorsSet = factorPerf.getColdFactors();
    if (coldFactorsSet.size > 0 && hiddenResult && hiddenResult.signals) {
      for (const sig of hiddenResult.signals) {
        if (coldFactorsSet.has(sig.id)) {
          // Each COLD factor that triggered = hidden score penalty
          // strong: -8, medium: -5, weak: -3 (approx -10% per signal)
          const penalty = sig.level === 'strong' ? 8 : sig.level === 'medium' ? 5 : 3;
          coldFactorPenalty += penalty;
        }
      }
    }
  } catch (_) { /* factor_performance not available */ }

  // Adaptive weights
  let weights;
  if (!hasDetail) {
    // Redistribute fundamental's 15% (25%→10%) proportionally
    weights = {
      fundamental: 0.10,
      technical: 0.18,
      hidden: 0.24,
      capital_flow: 0.30,
      event: 0.18,
    };
  } else {
    weights = config.FACTOR_WEIGHTS;
  }

  // Weighted total (exclude event if no LHB data)
  const eventWeight = ctx.lhbSignal ? weights.event : 0;
  let total = Math.round(
    fundamental * (weights.fundamental + (ctx.lhbSignal ? 0 : weights.event * 0.4)) +
    technical * (weights.technical + (ctx.lhbSignal ? 0 : weights.event * 0.3)) +
    hidden * (weights.hidden + (ctx.lhbSignal ? 0 : weights.event * 0.3)) +
    capitalFlow * weights.capital_flow +
    eventScore * eventWeight
  );

  // P1-4: Apply cold factor penalty to final score
  if (coldFactorPenalty > 0) {
    total = Math.max(0, total - coldFactorPenalty);
  }

  // Thin data cap: stocks without ROE/debt/revenue data cannot exceed 65.
  // This prevents "empty" stocks from scoring 76+ purely on cheap PE + activity.
  if (dataQuality === 'thin' && total > 65) {
    total = 65;
  }

  // North-bound sentiment adjustment
  // 根据北向资金历史绩效动态调整权重：
  //   HOT (命中率≥55%): 全额 (±3/±5)
  //   STABLE (命中率40-55%或数据不足): 全额（默认）
  //   COLD (命中率<40%且≥5个信号日): 降至 1/3（±1/±2）
  let adjustedTotal = total;
  let nbWeightMultiplier = 1.0;
  if (ctx.northBoundSentiment && ctx.northBoundSentiment.available) {
    try {
      const factorPerf = require('../analysis/factor_performance');
      const nbPerf = factorPerf.getNBPerformance();
      if (nbPerf && nbPerf.available && nbPerf.status === 'cold' && nbPerf.signalDays >= 5) {
        // NB historically unreliable — reduce weight to 1/3
        nbWeightMultiplier = 0.33;
      }
      // HOT: keep full weight (1.0). STABLE / insufficient data: keep full weight.
    } catch (_) { /* factor_performance not available, use default weight */ }

    const nb = ctx.northBoundSentiment;
    if (nb.sentiment === 'bullish') {
      const adj = Math.round(3 * nbWeightMultiplier);
      adjustedTotal = Math.min(100, total + adj);
    } else if (nb.sentiment === 'bearish') {
      const adj = Math.round(5 * nbWeightMultiplier);
      adjustedTotal = Math.max(0, total - adj);
    } else if (nb.sentiment === 'slightly_bullish') {
      const adj = Math.round(1 * nbWeightMultiplier);
      adjustedTotal = Math.min(100, total + adj);
    }
  }

  // === Margin sentiment adjustment (两融杠杆资金情绪) ===
  if (ctx.marginSentiment && ctx.marginSentiment.available) {
    const ms = ctx.marginSentiment;
    if (ms.sentiment === 'bullish') {
      adjustedTotal = Math.min(100, adjustedTotal + 2);
    } else if (ms.sentiment === 'bearish') {
      adjustedTotal = Math.max(0, adjustedTotal - 3);
    }
    // neutral: no adjustment
  }

  // === Enhanced LHB integration: use as confirmation/contradiction signal ===
  if (ctx.lhbSignal && ctx.lhbSignal.signal === 'strong') {
    // LHB strong net buy — institutional confirmation, direct bonus
    if (ctx.lhbSignal.netAmt > 0) {
      adjustedTotal = Math.min(100, adjustedTotal + 5);
    }
    // LHB strong net buy + strong capital flow = amplified conviction
    if (ctx.lhbSignal.netAmt > 0 && capitalFlow > 60) {
      adjustedTotal = Math.min(100, adjustedTotal + 3);
    }
  }
  if (ctx.lhbSignal && ctx.lhbSignal.signal === 'strong' && ctx.lhbSignal.netAmt < 0) {
    // LHB net sell — contradiction to any positive capital flow
    adjustedTotal = Math.max(0, adjustedTotal - 3);
  }

  // === P1-3: Sector strength bonus ===
  // If we have sector flow data, add a relative strength bonus.
  // Stocks in strong-flow sectors get a boost; stocks in weak sectors are penalized.
  // Only applied when sector flow data is available.
  let sectorBonus = 0;
  let sectorBonusLabel = '';
  if (ctx.sectorFlowMap && ctx.sectorFlowMap.size > 0) {
    const sectorRank = getSectorFlowPercentile(stock, ctx.sectorFlowMap);
    if (sectorRank != null) {
      if (sectorRank <= 0.10) {
        sectorBonus = 5;
        sectorBonusLabel = '板块资金Top10%(+' + sectorBonus + '分)';
      } else if (sectorRank <= 0.25) {
        sectorBonus = 3;
        sectorBonusLabel = '板块资金Top25%(+' + sectorBonus + '分)';
      } else if (sectorRank >= 0.85) {
        sectorBonus = -4;
        sectorBonusLabel = '板块资金Bottom15%(' + sectorBonus + '分)';
      } else if (sectorRank >= 0.70) {
        sectorBonus = -2;
        sectorBonusLabel = '板块资金偏弱(' + sectorBonus + '分)';
      }
    }
  }
  adjustedTotal = Math.max(0, Math.min(100, adjustedTotal + sectorBonus));

  // Rating (based on adjusted total)
  let rating;
  if (adjustedTotal >= 80) rating = 'S';
  else if (adjustedTotal >= 70) rating = 'A';
  else if (adjustedTotal >= 55) rating = 'B';
  else if (adjustedTotal >= 40) rating = 'C';
  else rating = 'D';

  // 6-dimension display scores (0-5 scale)
  return {
    compositeScore: adjustedTotal,
    rating: rating,
    dataQuality: dataQuality,
    northBoundAdjustment: adjustedTotal - total,
    sectorBonus: sectorBonus,
    sectorBonusLabel: sectorBonusLabel,
    dimensionScores: {
      [dimName('fundamental')]: roundHalf(fundamental / 20),
      [dimName('technical')]: roundHalf(technical / 20),
      [dimName('governance')]: roundHalf(60 / 20),
      [dimName('industry')]: roundHalf(55 / 20),
      [dimName('institutional')]: roundHalf(50 / 20),
      [dimName('capital')]: roundHalf(capitalFlow / 20),
    },
    rawScores: { fundamental, technical, hidden, capitalFlow, event: eventScore },
  };
}

function dimName(category) {
  const map = {
    'fundamental': '财务报表',
    'technical': 'K线技术面',
    'governance': '公司治理',
    'industry': '产业逻辑',
    'institutional': '机构态度',
    'capital': '资金面',
  };
  return map[category] || category;
}

function roundHalf(val) {
  return Math.round(val * 2) / 2; // round to nearest 0.5
}

/**
 * P1-3: Get a stock's percentile rank in sector flow.
 * Uses sector keyword matching against the flow map entries.
 * Returns 0-1 (0 = top sector, 1 = bottom sector), or null if unknown.
 */
function getSectorFlowPercentile(stock, sectorFlowMap) {
  const entries = Array.from(sectorFlowMap.entries()).map(([code, val]) => ({ code, ...val }));
  if (entries.length === 0) return null;

  // Sort by majorNetFlow descending
  const sorted = entries.sort((a, b) => (b.majorNetFlow || 0) - (a.majorNetFlow || 0));

  // Find best matching sector for this stock
  // Use the classifySector-style keyword matching
  const SECTOR_PATTERNS = [
    { sector: '半导体/AI算力', keys: ['半导体', '芯片', '电子', '光电', '封测', '晶圆', '硅', '算力', '存储'] },
    { sector: '机器人/具身智能', keys: ['机器人', '智能', '减速器', '电机', '伺服', '传感', '运动控制', '自动化'] },
    { sector: '创新药/AI医疗', keys: ['药', '医疗', '医', '生物', '基因', '细胞', '疫苗', '诊断', '试剂'] },
    { sector: '商业航天', keys: ['航天', '卫星', '航空', '火箭', '军工电子', '雷达', '导航'] },
    { sector: '固态电池/储能', keys: ['电池', '储能', '锂', '电解', '正极', '负极', '新能源', '光伏', '风电'] },
    { sector: '新型电力基建', keys: ['电力', '电网', '特高压', '电缆', '电气', '充电桩', '配电'] },
    { sector: '军工', keys: ['军工', '弹药', '装备', '船舶', '电磁', '武器', '防务'] },
    { sector: '有色金属/稀土', keys: ['有色', '稀土', '矿', '铝', '铜', '钢', '金属', '材料', '磁'] },
  ];

  let stockSector = '其他';
  for (const pat of SECTOR_PATTERNS) {
    if (pat.keys.some(kw => (stock.name || '').includes(kw))) {
      stockSector = pat.sector;
      break;
    }
  }

  // Find this sector's rank in the flow map
  for (let i = 0; i < sorted.length; i++) {
    const sec = sorted[i];
    if (!sec.name) continue;
    // Match by sector name overlap
    const secNameParts = sec.name.slice(0, 3);
    for (const pat of SECTOR_PATTERNS) {
      if (pat.sector === stockSector && pat.keys.some(kw => (sec.name || '').includes(kw))) {
        return i / sorted.length;
      }
    }
  }

  return null;
}

module.exports = { computeCompositeScore, starsFromScore, scoreFundamental, scoreTechnical, scoreCapitalFlow, getSectorFlowPercentile };
