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
function scoreCapitalFlow(stock) {
  let score = 50;
  const turnover = stock.turnover || 0;
  const turnoverRate = stock.turnoverRate || 0;

  // Turnover (100M = 1e8)
  if (turnover > 5e8) score += 15;
  else if (turnover > 2e8) score += 10;
  else if (turnover > 1e8) score += 5;
  else if (turnover < 5e7) score -= 5;

  // Turnover rate
  if (turnoverRate > 2 && turnoverRate < 8) score += 10;
  else if (turnoverRate >= 1 && turnoverRate <= 2) score += 5;
  else if (turnoverRate < 0.5) score -= 3;
  else if (turnoverRate > 15) score -= 3; // too hot

  // Volume ratio
  const volRatio = stock.volumeRatio || 1;
  if (volRatio > 1 && volRatio < 2.5) score += 5;

  return Math.max(0, Math.min(100, score));
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
function computeCompositeScore(stock, detail, klines, hiddenResult, marketDown) {
  const fundamental = scoreFundamental(stock, detail);
  const technical = scoreTechnical(stock, klines);
  const hidden = hiddenResult ? hiddenResult.score : 0;
  const capitalFlow = scoreCapitalFlow(stock);

  // Weighted total
  const total = Math.round(
    fundamental * config.FACTOR_WEIGHTS.fundamental +
    technical * config.FACTOR_WEIGHTS.technical +
    hidden * config.FACTOR_WEIGHTS.hidden +
    capitalFlow * config.FACTOR_WEIGHTS.capital_flow
  );

  // Rating
  let rating;
  if (total >= 85) rating = 'S';
  else if (total >= 75) rating = 'A';
  else if (total >= 60) rating = 'B';
  else if (total >= 45) rating = 'C';
  else rating = 'D';

  // 6-dimension display scores (0-5 scale)
  return {
    compositeScore: total,
    rating: rating,
    dimensionScores: {
      [dimName('fundamental')]: roundHalf(fundamental / 20),   // 0-100 → 0-5
      [dimName('technical')]: roundHalf(technical / 20),
      [dimName('governance')]: roundHalf(60 / 20),   // default neutral (can't assess governance from API)
      [dimName('industry')]: roundHalf(55 / 20),
      [dimName('institutional')]: roundHalf(50 / 20),
      [dimName('capital')]: roundHalf(capitalFlow / 20),
    },
    rawScores: { fundamental, technical, hidden, capitalFlow },
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

module.exports = { computeCompositeScore, starsFromScore, scoreFundamental, scoreTechnical, scoreCapitalFlow };
