/**
 * hidden_signals.js — X因子计算引擎
 *
 * 7 个可从东方财富 API 直接计算的隐藏因子。
 * 每个因子返回 { triggered: bool, signal: 'strong'|'medium'|'weak'|null, detail: str }
 */
const config = require('../config');

/**
 * H1: 缩量止跌 — 成交量极度萎缩 + 跌幅收窄 = 卖盘枯竭
 * 条件：今日跌幅<1% + 量比<0.5 + 前5日累计跌幅>3%
 * 含义：空方力量耗尽，可能反转
 */
function signalVolumeDryUp(stock, klines) {
  const todayChg = stock.changePercent || 0;
  const volRatio = stock.volumeRatio || 1;

  // P2-7: Relaxed thresholds — original required a rare combo of
  // 5d drop > 3% AND vol < 50% of average. The new thresholds also
  // trigger on moderate pullbacks with volume contraction.
  // Fallback path (no klines): use stock.volumeRatio
  if (!klines || klines.length < 5) {
    if (volRatio < 0.55 && todayChg > -3 && todayChg < 1) {
      return { triggered: true, signal: 'medium', detail: '量比' + volRatio.toFixed(2) + '萎缩，跌幅收窄至' + todayChg.toFixed(1) + '%，卖盘枯竭' };
    }
    if (volRatio < 0.7 && todayChg > -2 && todayChg < 1.5) {
      return { triggered: true, signal: 'weak', detail: '量比' + volRatio.toFixed(2) + '偏低，关注止跌' };
    }
    return { triggered: false, signal: null, detail: '' };
  }

  const recent = klines.slice(-5);
  const prev5Chg = (recent[recent.length - 1].close - recent[0].close) / recent[0].close * 100;
  const avgVol = recent.slice(0, -1).reduce((s, k) => s + k.volume, 0) / (recent.length - 1);
  const todayVol = recent[recent.length - 1].volume;
  const kVolRatio = avgVol > 0 ? todayVol / avgVol : 1;

  // Strong: clear volume dry-up after a meaningful drop (was: prev5Chg<-3 & volRatio<0.5)
  if (todayChg > -3 && todayChg < 1.5 && kVolRatio < 0.55 && prev5Chg < -2) {
    return { triggered: true, signal: 'strong', detail: '5日跌' + Math.abs(prev5Chg).toFixed(1) + '%，今日量缩至均量' + (kVolRatio * 100).toFixed(0) + '%，卖盘枯竭' };
  }
  // Medium: volume contraction + mild pullback (was: volRatio<0.6 & prev5Chg<-2)
  if (kVolRatio < 0.65 && prev5Chg < -1) {
    return { triggered: true, signal: 'medium', detail: '量缩' + (kVolRatio * 100).toFixed(0) + '%，跌幅收窄，关注反转' };
  }
  // Weak: volume contraction any time
  if (volRatio < 0.6 && todayChg <= 2) {
    return { triggered: true, signal: 'weak', detail: '量比' + volRatio.toFixed(2) + '偏低，关注量能变化' };
  }
  return { triggered: false, signal: null, detail: '' };
}

/**
 * H2: 底部放量 — 大跌 + 巨量 = 恐慌性抛售，可能是最后一跌
 * 条件：今日跌>3% + 量比>2 + 前5日累计跌>5%
 * 含义：恐慌盘出清，底部信号
 */
function signalPanicVolume(stock, klines) {
  const chg = stock.changePercent || 0;
  const volRatio = stock.volumeRatio || 1;
  const turnoverRate = stock.turnoverRate || 0;

  // P2-7: Relaxed from chg<-3 & volRatio>2 & turnoverRate>3 (too rare)
  // Now triggers on significant drops with elevated volume — any sign of
  // capitulation selling, which is often the final flush before a reversal.
  if (chg < -3 && volRatio > 1.5 && turnoverRate > 2) {
    return { triggered: true, signal: 'strong', detail: '跌' + Math.abs(chg).toFixed(1) + '% + 量比' + volRatio.toFixed(1) + ' + 换手' + turnoverRate.toFixed(1) + '%，恐慌抛售，底部放量' };
  }
  if (chg < -2 && volRatio > 1.3) {
    return { triggered: true, signal: 'medium', detail: '放量下跌，关注恐慌出清后的反弹' };
  }
  if (chg < -1.5 && volRatio > 1.0) {
    return { triggered: true, signal: 'weak', detail: '放量回调' + Math.abs(chg).toFixed(1) + '%，量比' + volRatio.toFixed(1) + '，关注企稳' };
  }
  return { triggered: false, signal: null, detail: '' };
}

/**
 * H3: 逆势抗跌 — 大盘跌但个股涨 = 相对强度
 * 条件：个股涨>0.5% + 板块预计下跌
 * 注意：需要外部传入市场涨跌方向
 */
function signalRelativeStrength(stock, marketDown) {
  const chg = stock.changePercent || 0;
  if (!marketDown) return { triggered: false, signal: null, detail: '' };

  if (chg > 2) {
    return { triggered: true, signal: 'strong', detail: '大盘下跌但个股逆势涨+' + chg.toFixed(1) + '%，资金逆势介入' };
  }
  if (chg > 0.5) {
    return { triggered: true, signal: 'medium', detail: '大盘下跌中个股抗跌+' + chg.toFixed(1) + '%，相对强势' };
  }
  return { triggered: false, signal: null, detail: '' };
}

/**
 * H4: PE极度低估 — PE < 12 + 负债率低 + 营收正增长
 * 条件：PE < 12 + debtRatio < 40% + revenueGrowth > 0
 */
function signalPEUndervalued(stock, detail) {
  const pe = stock.peTTM || stock.pe;
  const debtRatio = (detail && detail.debtRatio) ? detail.debtRatio : null;
  const revGrowth = (detail && detail.revenueGrowth) ? detail.revenueGrowth : null;

  if (pe != null && pe > 0 && pe < 12) {
    let score = 0;
    let desc = 'PE仅' + pe.toFixed(1);

    if (debtRatio != null && debtRatio < 30) { score++; desc += ' + 负债率' + debtRatio.toFixed(1) + '%'; }
    if (revGrowth != null && revGrowth > 0) { score++; desc += ' + 营收增长' + revGrowth.toFixed(1) + '%'; }

    if (score >= 2) return { triggered: true, signal: 'strong', detail: desc + '，极度低估' };
    if (score >= 1) return { triggered: true, signal: 'medium', detail: desc + '，估值偏低' };
    return { triggered: true, signal: 'weak', detail: desc + '，关注估值修复' };
  }
  return { triggered: false, signal: null, detail: '' };
}

/**
 * H5: 高ROE低PB — ROE>15% + PB<1.5 = 格雷厄姆式价值
 */
function signalROEPB(stock, detail) {
  const roe = (detail && detail.roe) ? detail.roe : null;
  const pb = stock.pb;

  // P2-7: Relaxed — original ROE>15 + PB<1.5 was impossibly strict
  // for A-shares under ¥20. New thresholds calibrated for Chinese market:
  // ROE>10% is solid, ROE>6% is acceptable. PB<1.5 is deep value, PB<2 is value.
  if (roe != null && roe > 12 && pb != null && pb < 2.0) {
    return { triggered: true, signal: 'strong', detail: 'ROE' + roe.toFixed(1) + '% + PB' + pb.toFixed(2) + '，高ROE低估值' };
  }
  if (roe != null && roe > 8 && pb != null && pb < 2.5) {
    return { triggered: true, signal: 'medium', detail: 'ROE' + roe.toFixed(1) + '% + PB' + pb.toFixed(2) + '，性价比尚可' };
  }
  if (roe != null && roe > 5 && pb != null && pb < 3.0) {
    return { triggered: true, signal: 'weak', detail: 'ROE' + roe.toFixed(1) + '% + PB' + pb.toFixed(2) + '，估值合理' };
  }
  return { triggered: false, signal: null, detail: '' };
}

/**
 * H6: 经营现金流健康 — OCF为正 + 低负债 + 高净利率
 */
function signalCashFlowQuality(stock, detail) {
  const ocf = (detail && detail.ocfPerShare != null) ? detail.ocfPerShare : null;
  const debtRatio = (detail && detail.debtRatio) ? detail.debtRatio : null;
  const npm = (detail && detail.npm) ? detail.npm : null;

  if (ocf != null && ocf > 0 && debtRatio != null && debtRatio < 30) {
    let desc = '经营现金流' + ocf.toFixed(2) + '/股 + 负债率' + debtRatio.toFixed(1) + '%';
    if (npm != null && npm > 10) {
      desc += ' + 净利率' + npm.toFixed(1) + '%';
      return { triggered: true, signal: 'strong', detail: desc + '，财务质量优秀' };
    }
    return { triggered: true, signal: 'medium', detail: desc + '，财务健康' };
  }
  if (ocf != null && ocf > 0) {
    return { triggered: true, signal: 'weak', detail: '经营现金流为正，财务基本健康' };
  }
  return { triggered: false, signal: null, detail: '' };
}

/**
 * H7: 低换手蓄力 — 换手率<1% + 波动<2% = 筹码锁定，蓄势待发
 */
function signalLowChurnAccumulation(stock) {
  const turnoverRate = stock.turnoverRate || 0;
  const amplitude = stock.amplitude || 0;
  const chg = stock.changePercent || 0;

  if (turnoverRate < 1 && amplitude < 2 && Math.abs(chg) < 1 && stock.price < 15) {
    return { triggered: true, signal: 'medium', detail: '换手' + turnoverRate.toFixed(2) + '% + 振幅' + amplitude.toFixed(1) + '%，筹码锁定，低价蓄力' };
  }
  if (turnoverRate < 0.5 && stock.price < 10) {
    return { triggered: true, signal: 'weak', detail: '超低换手' + turnoverRate.toFixed(2) + '%，无人关注可能是机会' };
  }
  return { triggered: false, signal: null, detail: '' };
}

/**
 * H8: 短期反转 — 5日累计跌幅较大，短期有反弹动能
 * A股小盘股存在显著的短期反转效应（5日负收益→正收益）。
 * 条件：5日累计跌幅>5% + 今日止跌(涨跌幅>-1%)
 */
function signalReversal(stock, klines) {
  const todayChg = stock.changePercent || 0;

  // P2-7: Relaxed — added fallback for when klines not available.
  // Original required 5d drop of -8% (strong) / -5% (medium), which almost
  // never fires in a sideways/up-trending market.
  if (!klines || klines.length < 5) {
    // Fallback: use stock's own changePercent pattern
    if (todayChg > 0 && todayChg < 3) {
      return { triggered: true, signal: 'weak', detail: '今日翻红+' + todayChg.toFixed(1) + '%，关注反弹持续性' };
    }
    return { triggered: false, signal: null, detail: '' };
  }

  const closes = klines.map(k => k.close);
  const chg5d = (closes[closes.length - 1] - closes[closes.length - 5]) / closes[closes.length - 5] * 100;

  // Strong: deep drop + clear stabilization (was: -8% drop)
  if (chg5d < -6 && todayChg > -0.5) {
    return { triggered: true, signal: 'strong', detail: '5日跌' + Math.abs(chg5d).toFixed(1) + '%后止跌，强势反转信号' };
  }
  // Medium: moderate drop + stabilization (was: -5% drop)
  if (chg5d < -4 && todayChg > -1) {
    return { triggered: true, signal: 'medium', detail: '5日跌' + Math.abs(chg5d).toFixed(1) + '%，关注超跌反弹' };
  }
  // Weak: any pullback + today is green (was: -3% drop)
  if (chg5d < -2 && todayChg > 0) {
    return { triggered: true, signal: 'weak', detail: '5日跌' + Math.abs(chg5d).toFixed(1) + '%后翻红，短线止跌' };
  }
  return { triggered: false, signal: null, detail: '' };
}

/**
 * H9: 量价背离 — 成交量萎缩 + 价格企稳 = 吸筹信号
 * 近5日量价相关系数为负（量缩价稳或量增价不跌），说明有资金在暗中吸筹。
 */
function signalVolumePriceDivergence(stock, klines) {
  const todayChg = stock.changePercent || 0;
  const volRatio = stock.volumeRatio || 1;

  // P2-7: Relaxed — original required klines for Pearson correlation,
  // with threshold <-0.5 (almost never triggers). Added fallback path
  // for when klines unavailable, and lowered correlation threshold.
  if (!klines || klines.length < 5) {
    // Fallback: volume ratio + price change as proxy for divergence
    // Low volume + flat/slightly positive price = potential accumulation
    if (volRatio < 0.6 && todayChg > -0.5 && todayChg < 2 && stock.price < 20) {
      return { triggered: true, signal: 'medium', detail: '量比' + volRatio.toFixed(2) + '萎缩，价格企稳于' + (stock.price || 0).toFixed(2) + '，疑似吸筹' };
    }
    if (volRatio < 0.75 && todayChg > -1 && todayChg < 2.5 && stock.price < 30) {
      return { triggered: true, signal: 'weak', detail: '量价弱背离，关注量价关系' };
    }
    return { triggered: false, signal: null, detail: '' };
  }

  const recent = klines.slice(-5);
  const priceChanges = [];
  const volumeChanges = [];

  for (let i = 1; i < recent.length; i++) {
    priceChanges.push((recent[i].close - recent[i - 1].close) / recent[i - 1].close);
    volumeChanges.push((recent[i].volume - recent[i - 1].volume) / Math.max(1, recent[i - 1].volume));
  }

  // Pearson correlation
  const n = priceChanges.length;
  if (n < 3) return { triggered: false, signal: null, detail: '' };

  const avgP = priceChanges.reduce((a, b) => a + b, 0) / n;
  const avgV = volumeChanges.reduce((a, b) => a + b, 0) / n;

  let cov = 0, varP = 0, varV = 0;
  for (let i = 0; i < n; i++) {
    cov += (priceChanges[i] - avgP) * (volumeChanges[i] - avgV);
    varP += (priceChanges[i] - avgP) ** 2;
    varV += (volumeChanges[i] - avgV) ** 2;
  }

  const correlation = varP > 0 && varV > 0 ? cov / Math.sqrt(varP * varV) : 0;

  // Negative correlation + price stabilizing = accumulation
  // P2-7: Lowered from -0.5 to -0.35 (strong), -0.3 to -0.15 (medium)
  if (correlation < -0.35 && todayChg > -0.5 && todayChg < 2) {
    return { triggered: true, signal: 'strong', detail: '量价背离度' + correlation.toFixed(2) + '，缩量企稳，疑似吸筹' };
  }
  if (correlation < -0.15 && todayChg > -1) {
    return { triggered: true, signal: 'medium', detail: '量价弱背离' + correlation.toFixed(2) + '，关注量价关系' };
  }
  // Also catch volRatio-based divergence when correlation is marginal
  if (correlation < 0 && volRatio < 0.65 && todayChg > -1.5) {
    return { triggered: true, signal: 'weak', detail: '量价微背离' + correlation.toFixed(2) + '，量比偏低' };
  }
  return { triggered: false, signal: null, detail: '' };
}

// ---- Main scoring function ----

/**
 * Compute all hidden factor signals for a stock.
 * @param {object} stock - Stock object from market_data
 * @param {object} detail - Optional detailed financial data
 * @param {Array} klines - Optional K-line array
 * @param {boolean} marketDown - Whether market is down today
 * @returns {object} { signals: [], score: number (0-100) }
 */
function computeHiddenSignals(stock, detail, klines, marketDown) {
  const signals = [];

  const s1 = signalVolumeDryUp(stock, klines);
  if (s1.triggered) signals.push({ id: 'H1', name: '缩量止跌', level: s1.signal, detail: s1.detail });

  const s2 = signalPanicVolume(stock, klines);
  if (s2.triggered) signals.push({ id: 'H2', name: '底部放量', level: s2.signal, detail: s2.detail });

  const s3 = signalRelativeStrength(stock, marketDown);
  if (s3.triggered) signals.push({ id: 'H3', name: '逆势抗跌', level: s3.signal, detail: s3.detail });

  const s4 = signalPEUndervalued(stock, detail);
  if (s4.triggered) signals.push({ id: 'H4', name: 'PE低估', level: s4.signal, detail: s4.detail });

  const s5 = signalROEPB(stock, detail);
  if (s5.triggered) signals.push({ id: 'H5', name: '高ROE低PB', level: s5.signal, detail: s5.detail });

  const s6 = signalCashFlowQuality(stock, detail);
  if (s6.triggered) signals.push({ id: 'H6', name: '现金流健康', level: s6.signal, detail: s6.detail });

  const s7 = signalLowChurnAccumulation(stock);
  if (s7.triggered) signals.push({ id: 'H7', name: '低换手蓄力', level: s7.signal, detail: s7.detail });

  const s8 = signalReversal(stock, klines);
  if (s8.triggered) signals.push({ id: 'H8', name: '短期反转', level: s8.signal, detail: s8.detail });

  const s9 = signalVolumePriceDivergence(stock, klines);
  if (s9.triggered) signals.push({ id: 'H9', name: '量价背离', level: s9.signal, detail: s9.detail });

  // Score: strong=3, medium=2, weak=1
  const weights = { strong: 3, medium: 2, weak: 1 };
  let rawScore = 0;
  let maxScore = 0;
  for (const s of signals) {
    rawScore += weights[s.level] || 0;
    maxScore += 3;
  }

  // No signals = below-average 35 (not 50). A stock with zero hidden signals
  // is below par — real opportunities should trigger at least 1-2 signals.
  // Signals map range to 35-100 (was 50-100, which inflated all scores).
  const normalizedScore = maxScore > 0 ? Math.round(35 + (rawScore / maxScore) * 65) : 35;

  return {
    signals: signals,
    signalCount: signals.length,
    score: normalizedScore,
    hasStrong: signals.some(s => s.level === 'strong'),
  };
}

module.exports = { computeHiddenSignals };
