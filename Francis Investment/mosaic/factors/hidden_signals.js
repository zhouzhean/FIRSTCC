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
  if (!klines || klines.length < 5) {
    // Fallback: use volume ratio as proxy
    if (stock.volumeRatio != null && stock.volumeRatio < 0.4 && stock.changePercent > -2 && stock.changePercent < 1) {
      return { triggered: true, signal: 'medium', detail: '量比' + stock.volumeRatio.toFixed(2) + '极度萎缩，跌幅收窄至' + stock.changePercent.toFixed(1) + '%，卖盘枯竭' };
    }
    return { triggered: false, signal: null, detail: '' };
  }

  const recent = klines.slice(-5);
  const todayChg = stock.changePercent || 0;
  const prev5Chg = (recent[recent.length - 1].close - recent[0].close) / recent[0].close * 100;
  const avgVol = recent.slice(0, -1).reduce((s, k) => s + k.volume, 0) / (recent.length - 1);
  const todayVol = recent[recent.length - 1].volume;
  const volRatio = avgVol > 0 ? todayVol / avgVol : 1;

  if (todayChg > -2 && todayChg < 1 && volRatio < 0.5 && prev5Chg < -3) {
    return { triggered: true, signal: 'strong', detail: '5日跌' + prev5Chg.toFixed(1) + '%，今日量缩至均量' + (volRatio * 100).toFixed(0) + '%，卖盘枯竭' };
  }
  if (volRatio < 0.6 && prev5Chg < -2) {
    return { triggered: true, signal: 'medium', detail: '量缩' + (volRatio * 100).toFixed(0) + '%，跌幅收窄，关注反转' };
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

  if (chg < -3 && volRatio > 2 && turnoverRate > 3) {
    return { triggered: true, signal: 'strong', detail: '跌' + Math.abs(chg).toFixed(1) + '% + 量比' + volRatio.toFixed(1) + ' + 换手' + turnoverRate.toFixed(1) + '%，恐慌抛售，底部放量' };
  }
  if (chg < -2 && volRatio > 1.8) {
    return { triggered: true, signal: 'medium', detail: '放量下跌，关注恐慌出清后的反弹' };
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

  if (roe != null && roe > 15 && pb != null && pb < 1.5) {
    return { triggered: true, signal: 'strong', detail: 'ROE' + roe.toFixed(1) + '% + PB' + pb.toFixed(2) + '，高ROE低估值' };
  }
  if (roe != null && roe > 10 && pb != null && pb < 2) {
    return { triggered: true, signal: 'medium', detail: 'ROE' + roe.toFixed(1) + '% + PB' + pb.toFixed(2) + '，性价比尚可' };
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

  // Score: strong=3, medium=2, weak=1
  const weights = { strong: 3, medium: 2, weak: 1 };
  let rawScore = 0;
  let maxScore = 0;
  for (const s of signals) {
    rawScore += weights[s.level] || 0;
    maxScore += 3;
  }

  // If no signals triggered at all, score = 0
  const normalizedScore = maxScore > 0 ? Math.round((rawScore / maxScore) * 100) : 0;

  return {
    signals: signals,
    signalCount: signals.length,
    score: normalizedScore,
    hasStrong: signals.some(s => s.level === 'strong'),
  };
}

module.exports = { computeHiddenSignals };
