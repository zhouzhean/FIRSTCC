/**
 * market_cycle.js — A股市场周期识别引擎
 *
 * 判断当前 A 股处于什么周期阶段（牛市/震荡偏多/震荡/震荡偏空/熊市），
 * 基于三个维度：
 *   1. 均线排列（多头/空头/纠缠）
 *   2. 成交量趋势（放量 vs 缩量）
 *   3. 新高新低比例（市场宽度）
 *
 * 输出影响：
 *   - 仓位上限调整：牛市 max 5 → 熊市 max 2
 *   - 风险偏好微调
 *   - 通过 /api/market/cycle 暴露给前端
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

const DATA_DIR = config.DATA_DIR;

// ---- MA Alignment Detection ----

/**
 * Compute simple moving averages from index K-line data.
 * Returns { ma5, ma10, ma20, ma60, alignment: 'bullish'|'bearish'|'mixed' }
 */
function computeMAAlignment(klines) {
  if (!klines || klines.length < 60) {
    return { ma5: null, ma10: null, ma20: null, ma60: null, alignment: 'insufficient_data' };
  }

  const closes = klines.map(k => k.close || k.price);

  const ma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const ma10 = closes.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const ma60 = closes.slice(-60).reduce((a, b) => a + b, 0) / 60;

  // Bullish alignment: MA5 > MA10 > MA20 > MA60 (all pointing up, short-term on top)
  // Bearish alignment: MA5 < MA10 < MA20 < MA60 (all pointing down, short-term below)
  if (ma5 > ma10 && ma10 > ma20 && ma20 > ma60) return { ma5, ma10, ma20, ma60, alignment: 'bullish' };
  if (ma5 < ma10 && ma10 < ma20 && ma20 < ma60) return { ma5, ma10, ma20, ma60, alignment: 'bearish' };

  // Mixed: check partial alignments
  if (ma5 > ma20 && ma10 > ma20) return { ma5, ma10, ma20, ma60, alignment: 'slightly_bullish' };
  if (ma5 < ma20 && ma10 < ma20) return { ma5, ma10, ma20, ma60, alignment: 'slightly_bearish' };

  return { ma5, ma10, ma20, ma60, alignment: 'mixed' };
}

// ---- Volume Trend ----

/**
 * Compute 5-day vs 20-day average volume comparison.
 * Returns 'expanding' | 'contracting' | 'stable' | 'insufficient_data'
 */
function computeVolumeTrend(klines) {
  if (!klines || klines.length < 20) return 'insufficient_data';

  const volumes = klines.map(k => k.volume || 0);
  const avg5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const avg20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;

  if (avg20 === 0) return 'insufficient_data';

  const ratio = avg5 / avg20;
  if (ratio > 1.3) return 'expanding';       // 放量
  if (ratio < 0.7) return 'contracting';     // 缩量
  return 'stable';                           // 平稳
}

// ---- Market Breadth (New High / New Low) ----

/**
 * Compute the ratio of stocks near 20-day high vs near 20-day low.
 * Only uses the index data as proxy (K-line high/low comparison).
 * Returns { highRatio, lowRatio, breadth: 'wide'|'narrow'|'balanced'|'insufficient_data' }
 */
function computeBreadth(klines) {
  if (!klines || klines.length < 20) return { highRatio: null, lowRatio: null, breadth: 'insufficient_data' };

  // Use last 20 bars — count how many are near 20-day high
  const last20 = klines.slice(-20);
  const periodHigh = Math.max(...last20.map(k => k.high || k.close));
  const periodLow = Math.min(...last20.map(k => k.low || k.close));
  const range = periodHigh - periodLow;

  if (range === 0) return { highRatio: 0.5, lowRatio: 0.5, breadth: 'balanced' };

  const currentPrice = last20[last20.length - 1].close || klines[klines.length - 1].price;
  const positionInRange = (currentPrice - periodLow) / range; // 0-1

  if (positionInRange > 0.8) return { highRatio: positionInRange, lowRatio: 1 - positionInRange, breadth: 'wide_high' };
  if (positionInRange < 0.2) return { highRatio: positionInRange, lowRatio: 1 - positionInRange, breadth: 'narrow_low' };
  return { highRatio: positionInRange, lowRatio: 1 - positionInRange, breadth: 'balanced' };
}

// ---- Cycle Detection ----

/**
 * Main cycle detection function.
 * Combines MA alignment, volume trend, and market breadth to determine
 * the current A-share market cycle.
 *
 * Returns an object with:
 *   - cycle: 'bull' | 'slightly_bullish' | 'sideways' | 'slightly_bearish' | 'bear'
 *   - label: 中文标签
 *   - confidence: 0-100 confidence score
 *   - suggestedMaxPositions: 建议最大持仓数
 *   - suggestedMultiplier: 仓位乘数
 *   - details: { ma, volume, breadth }
 */
function detectMarketCycle(shKlines, szKlines) {
  // Use Shanghai as primary, Shenzhen as confirmation
  const ma = computeMAAlignment(shKlines);
  const vol = computeVolumeTrend(shKlines);
  const breadth = computeBreadth(shKlines);

  // Confirm with Shenzhen if available
  let confirmMa = null;
  if (szKlines && szKlines.length >= 60) {
    confirmMa = computeMAAlignment(szKlines);
  }

  let score = 50; // neutral starting point (0=bear, 100=bull)
  const factors = [];

  // 1. MA Alignment (weight: 40%)
  if (ma.alignment === 'bullish') { score += 20; factors.push('均线多头排列+20'); }
  else if (ma.alignment === 'bearish') { score -= 20; factors.push('均线空头排列-20'); }
  else if (ma.alignment === 'slightly_bullish') { score += 10; factors.push('均线偏多+10'); }
  else if (ma.alignment === 'slightly_bearish') { score -= 10; factors.push('均线偏空-10'); }
  // mixed: no change

  // Confirm with Shenzhen
  if (confirmMa) {
    if (ma.alignment === confirmMa.alignment) {
      score += (score > 50 ? 5 : -5);
      factors.push('深证确认均线排列' + (score > 50 ? '+5' : '-5'));
    } else if (
      (ma.alignment === 'bullish' && confirmMa.alignment === 'slightly_bullish') ||
      (ma.alignment === 'slightly_bullish' && confirmMa.alignment === 'bullish')
    ) {
      score += 3; factors.push('深证偏多+3');
    } else if (
      (ma.alignment === 'bearish' && confirmMa.alignment === 'slightly_bearish') ||
      (ma.alignment === 'slightly_bearish' && confirmMa.alignment === 'bearish')
    ) {
      score -= 3; factors.push('深证偏空-3');
    }
  }

  // 2. Volume trend (weight: 30%)
  if (vol === 'expanding' && ma.alignment.includes('bull')) {
    score += 15; factors.push('放量上涨+15');
  } else if (vol === 'expanding' && ma.alignment.includes('bear')) {
    score -= 5; factors.push('放量下跌-5');
  } else if (vol === 'contracting' && ma.alignment.includes('bull')) {
    score -= 5; factors.push('缩量上涨-5');
  } else if (vol === 'contracting' && ma.alignment.includes('bear')) {
    score += 10; factors.push('缩量止跌+10');
  } else if (vol === 'expanding') {
    score += 5; factors.push('放量+5');
  } else if (vol === 'contracting') {
    score -= 5; factors.push('缩量-5');
  }

  // 3. Market breadth (weight: 30%)
  if (breadth.breadth === 'wide_high') { score += 15; factors.push('市场宽度偏多+15'); }
  else if (breadth.breadth === 'narrow_low') { score -= 15; factors.push('市场宽度偏空-15'); }
  // balanced: no change

  // Normalize to 0-100
  score = Math.max(0, Math.min(100, score));

  // Determine cycle and suggested max positions
  let cycle, label, suggestedMaxPositions, suggestedMultiplier;
  if (score >= 75) {
    cycle = 'bull'; label = '牛市';
    suggestedMaxPositions = 5; suggestedMultiplier = 1.0;
  } else if (score >= 60) {
    cycle = 'slightly_bullish'; label = '震荡偏多';
    suggestedMaxPositions = 4; suggestedMultiplier = 0.8;
  } else if (score >= 40) {
    cycle = 'sideways'; label = '震荡';
    suggestedMaxPositions = 3; suggestedMultiplier = 0.6;
  } else if (score >= 25) {
    cycle = 'slightly_bearish'; label = '震荡偏空';
    suggestedMaxPositions = 2; suggestedMultiplier = 0.4;
  } else {
    cycle = 'bear'; label = '熊市';
    suggestedMaxPositions = 1; suggestedMultiplier = 0.2;
  }

  return {
    cycle,
    label,
    confidence: score,
    suggestedMaxPositions,
    suggestedMultiplier,
    details: {
      ma: { alignment: ma.alignment, values: { ma5: ma.ma5, ma10: ma.ma10, ma20: ma.ma20, ma60: ma.ma60 } },
      volume: { trend: vol },
      breadth: { breadth: breadth.breadth, positionInRange: breadth.highRatio },
    },
    factors,
  };
}

/**
 * Load index K-line data from disk.
 * Returns array of kline objects, or empty array on failure.
 */
function loadIndexKlines(indexCode) {
  try {
    const filePath = path.join(DATA_DIR, 'market_history', 'indices', indexCode + '.json');
    if (!fs.existsSync(filePath)) return [];
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // Handle different data formats
    if (Array.isArray(raw)) return raw;
    if (raw.klines && Array.isArray(raw.klines)) return raw.klines;
    if (raw.data && Array.isArray(raw.data)) return raw.data;
    return [];
  } catch (e) {
    return [];
  }
}

/**
 * Get current market cycle — callable from API or scheduler.
 * Returns null if insufficient data.
 */
function getMarketCycle() {
  const shKlines = loadIndexKlines('sh000001');
  const szKlines = loadIndexKlines('sz399001');

  if (shKlines.length < 20) {
    return { cycle: 'sideways', label: '震荡(数据不足)', confidence: 50, suggestedMaxPositions: 3, suggestedMultiplier: 0.6, dataAvailable: false };
  }

  const result = detectMarketCycle(shKlines, szKlines);
  result.dataAvailable = shKlines.length >= 20;
  result.generatedAt = new Date().toISOString();
  return result;
}

module.exports = { detectMarketCycle, getMarketCycle, loadIndexKlines, computeMAAlignment, computeVolumeTrend, computeBreadth };
