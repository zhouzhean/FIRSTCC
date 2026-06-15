/**
 * risk_budget.js — 组合风险预算模型 v3.0
 *
 * 升级固定百分比仓位为风险预算驱动仓位。
 * 新增：波动率调整、相关性惩罚、流动性限制、Kelly准则、连续亏损熔断。
 *
 * 集成点：simfolio.js 的 getTargetAllocation() 调用。
 */

var config = require('../config');

// ===== Main Entry =====

/**
 * 计算基于风险预算的建议仓位
 * @param {Object} candidate — { code, name, price, compositeScore, expectedReturn, confidence }
 * @param {Object} pf — portfolio (loadPortfolio result)
 * @param {Object} marketContext — { riskRegime, marketVolatility, ... }
 */
function computeRiskBudgetPosition(candidate, pf, marketContext) {
  var baseWeight = getBaseWeightByScore(candidate.compositeScore || 50);
  var result = {
    baseWeight: baseWeight,
    adjustments: [],
    finalWeight: baseWeight,
    finalShares: 0,
    maxLossThisTrade: 0,
    riskBudgetUsed: 0,
    blockers: [],
  };

  // 1. Score-based base weight (existing logic)
  result.adjustments.push({ reason: '评分基础仓位', weight: baseWeight });

  // 2. Volatility adjustment — wider vol -> smaller position
  if (config.RISK_BUDGET && config.RISK_BUDGET.useVolatilityAdjustment) {
    baseWeight = applyVolatilityAdjustment(candidate.code, baseWeight, result);
  }

  // 3. Correlation penalty — high correlation with existing positions -> smaller
  if (config.RISK_BUDGET && config.RISK_BUDGET.useCorrelationPenalty) {
    baseWeight = applyCorrelationPenalty(candidate, pf, baseWeight, result);
  }

  // 4. Liquidity limit — ensure position < N% of daily volume
  if (config.RISK_BUDGET && config.RISK_BUDGET.useLiquidityLimit) {
    var liqResult = applyLiquidityLimit(candidate, baseWeight, pf);
    if (liqResult.blocked) {
      result.blockers.push(liqResult.reason);
      result.finalWeight = 0;
      return result;
    }
    baseWeight = liqResult.weight;
    if (liqResult.adjustment) result.adjustments.push(liqResult.adjustment);
  }

  // 5. Kelly fraction
  if (config.RISK_BUDGET && config.RISK_BUDGET.useKellySizing) {
    baseWeight = applyKellyCriterion(pf, baseWeight, result);
  }

  // 6. Risk regime multiplier
  baseWeight = applyRegimeMultiplier(baseWeight, marketContext, result);

  // 6b. Panic regime: hard block — no position sizing justifies buying
  if (marketContext && marketContext.riskRegime === 'panic') {
    result.blockers.push('跨市场恐慌状态(panic)，禁止任何新开仓');
    result.finalWeight = 0;
    return result;
  }

  // 7. Check circuit breakers
  var breakerResult = checkCircuitBreakers(pf);
  if (breakerResult.blocked) {
    result.blockers.push(breakerResult.reason);
    result.finalWeight = 0;
    return result;
  }

  // Clamp to config limits
  var maxSinglePos = config.SIMFOLIO && config.SIMFOLIO.maxSinglePositionPct
    ? config.SIMFOLIO.maxSinglePositionPct * 100
    : 30;
  baseWeight = Math.min(baseWeight, maxSinglePos);
  // Min weight: 0 for panic/risk_off (already handled above), otherwise min 1%
  baseWeight = Math.max(baseWeight <= 0 ? 0 : 1, baseWeight);

  result.finalWeight = Math.round(baseWeight * 100) / 100;

  // Compute shares and risk budget
  var cash = pf.cash || 0;
  var amount = Math.round(cash * result.finalWeight / 100);
  var price = candidate.price || 0;
  result.finalShares = price > 0 ? Math.floor(amount / price / 100) * 100 : 0;

  // Max loss this trade (stop loss at -8%)
  var stopLossPct = config.SIMFOLIO && config.SIMFOLIO.stopLossPct ? config.SIMFOLIO.stopLossPct : -0.08;
  result.maxLossThisTrade = Math.round(amount * Math.abs(stopLossPct));
  result.riskBudgetUsed = result.finalWeight;

  return result;
}

// ===== Step Functions =====

function getBaseWeightByScore(score) {
  if (typeof score !== 'number' || isNaN(score)) return 8;
  if (score >= 85) return 22;
  if (score >= 75) return 18;
  if (score >= 65) return 12;
  if (score >= 55) return 8;
  return 5;
}

function applyVolatilityAdjustment(code, weight, result) {
  var maxVol = (config.RISK_BUDGET && config.RISK_BUDGET.maxPositionVolatility) || 0.35;

  // Estimate 20-day vol from K-line cache
  var vol = estimateVolatility(code);

  if (vol <= 0) {
    result.adjustments.push({ reason: '波动率无法估算，保持原始仓位', weight: weight });
    return weight;
  }

  // Scale: target 15% annualized vol. If stock vol > target, reduce.
  var targetVol = 0.15;
  var adjFactor = Math.min(1, targetVol / vol);
  var newWeight = Math.round(weight * adjFactor * 100) / 100;

  if (newWeight < weight) {
    result.adjustments.push({
      reason: '波动率调整（股票年化波动' + Math.round(vol * 100) + '% > 目标15%）',
      weight: newWeight,
    });
  }

  return newWeight;
}

function estimateVolatility(code) {
  try {
    var fs = require('fs');
    var path = require('path');
    var klineFile = path.join(__dirname, '..', '..', 'report-engine', 'data', 'klines', code + '.json');
    if (!fs.existsSync(klineFile)) return 0;

    var data = JSON.parse(fs.readFileSync(klineFile, 'utf8'));
    if (!data || !data.klines || data.klines.length < 5) return 0;

    var closes = data.klines.map(function(k) { return k.close || 0; }).filter(function(c) { return c > 0; });
    if (closes.length < 5) return 0;

    // Daily returns -> annualized volatility
    var returns = [];
    for (var i = 1; i < closes.length; i++) {
      returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }

    var avg = returns.reduce(function(a, b) { return a + b; }, 0) / returns.length;
    var variance = returns.reduce(function(s, r) { return s + Math.pow(r - avg, 2); }, 0) / returns.length;
    var dailyVol = Math.sqrt(variance);
    return Math.round(dailyVol * Math.sqrt(252) * 100) / 100;
  } catch (_) {
    return 0;
  }
}

function applyCorrelationPenalty(candidate, pf, weight, result) {
  var threshold = (config.RISK_BUDGET && config.RISK_BUDGET.correlationThreshold) || 0.6;
  var positions = pf.positions || [];
  if (positions.length === 0) return weight;

  // Simplified correlation: if same sector -> high correlation
  var sector = guessSector(candidate.name || '');
  var sameSectorCount = 0;
  for (var i = 0; i < positions.length; i++) {
    var posSector = guessSector(positions[i].name || '');
    if (posSector === sector && sector !== '其他') sameSectorCount++;
  }

  if (sameSectorCount >= 2) {
    var penalty = 0.5; // 50% reduction when 2+ same sector
    var newWeight = Math.round(weight * penalty * 100) / 100;
    result.adjustments.push({
      reason: '同板块已持有' + sameSectorCount + '只（板块=' + sector + '），仓位减半',
      weight: newWeight,
    });
    return newWeight;
  }

  return weight;
}

function applyLiquidityLimit(candidate, weight, pf) {
  var limitPct = (config.RISK_BUDGET && config.RISK_BUDGET.liquidityLimitPct) || 0.05;
  var cash = pf.cash || 0;
  var amount = cash * weight / 100;

  // Check daily volume from K-line cache
  try {
    var fs = require('fs');
    var path = require('path');
    var klineFile = path.join(__dirname, '..', '..', 'report-engine', 'data', 'klines', candidate.code + '.json');
    if (fs.existsSync(klineFile)) {
      var data = JSON.parse(fs.readFileSync(klineFile, 'utf8'));
      if (data && data.klines && data.klines.length > 0) {
        var latest = data.klines[data.klines.length - 1];
        var dailyVolume = (latest.volume || 0) * (latest.close || 1); // approximate turnover
        if (dailyVolume < 50000000) { // < 50M daily turnover
          return {
            blocked: true,
            reason: '日均成交额过低（' + Math.round(dailyVolume / 10000) + '万），流动性不足',
          };
        }
        var maxAmount = dailyVolume * limitPct;
        if (amount > maxAmount) {
          var newWeight = Math.round((maxAmount / cash) * 10000) / 100;
          return {
            weight: Math.max(1, newWeight),
            adjustment: {
              reason: '流动性限制（' + Math.round(dailyVolume / 10000) + '万日成交÷5%上限=¥' + Math.round(maxAmount) + '），仓位从' + Math.round(weight) + '%降至' + Math.round(newWeight) + '%',
              weight: Math.round(newWeight),
            },
          };
        }
      }
    }
  } catch (_) {}

  return { weight: weight };
}

function applyKellyCriterion(pf, weight, result) {
  var kellyFraction = (config.RISK_BUDGET && config.RISK_BUDGET.kellyFraction) || 0.5;
  var sells = (pf.tradeHistory || []).filter(function(t) { return t.action === 'sell'; });

  if (sells.length < 5) {
    result.adjustments.push({ reason: '交易少于5笔，跳过Kelly计算', weight: weight });
    return weight;
  }

  var wins = sells.filter(function(t) { return (t.pnl || 0) > 0; });
  var losses = sells.filter(function(t) { return (t.pnl || 0) <= 0; });
  var winRate = wins.length / sells.length;

  if (winRate === 0 || losses.length === 0) {
    result.adjustments.push({ reason: '无胜/负交易，跳过Kelly', weight: weight });
    return weight;
  }

  var avgWin = wins.reduce(function(s, t) { return s + (t.pnl || 0); }, 0) / wins.length;
  var avgLoss = Math.abs(losses.reduce(function(s, t) { return s + (t.pnl || 0); }, 0) / losses.length);
  var avgWinLossRatio = avgLoss > 0 ? avgWin / avgLoss : 0;

  if (avgWinLossRatio <= 0) {
    result.adjustments.push({ reason: '盈亏比≤0，Kelly建议为0', weight: 0 });
    return 0;
  }

  // Kelly formula: f = winRate - (1 - winRate) / avgWinLossRatio
  var kelly = winRate - (1 - winRate) / avgWinLossRatio;

  // Half-Kelly (conservative)
  var halfKelly = Math.max(0, kelly * kellyFraction);

  // Scale: Kelly = 0.25 means bet 25% of bankroll
  // Convert to position weight (cap at 25%)
  var kellyWeight = Math.min(25, Math.round(halfKelly * 100 * 100) / 100);

  // Blend: take the more conservative of score-based vs Kelly
  var finalWeight = Math.min(weight, kellyWeight);
  finalWeight = Math.max(3, finalWeight); // minimum 3%

  if (finalWeight < weight) {
    result.adjustments.push({
      reason: 'Kelly准则（胜率' + (winRate * 100).toFixed(0) + '% 盈亏比' + avgWinLossRatio.toFixed(2) + ' f*=' + halfKelly.toFixed(2) + '），仓位从' + Math.round(weight) + '%降至' + Math.round(finalWeight) + '%',
      weight: finalWeight,
    });
  }

  return finalWeight;
}

function applyRegimeMultiplier(weight, marketContext, result) {
  if (!marketContext || !marketContext.riskRegime) return weight;

  var multipliers = {
    'panic': 0.0,
    'risk_off': 0.3,
    'neutral': 0.8,
    'slightly_bullish': 1.0,
    'risk_on': 1.2,
  };

  var mult = multipliers[marketContext.riskRegime] || 1.0;
  var newWeight = Math.round(weight * mult * 100) / 100;

  if (newWeight < weight) {
    result.adjustments.push({
      reason: '风险状态=' + marketContext.riskRegime + '（乘数=' + mult + '），仓位从' + Math.round(weight) + '%降至' + Math.round(newWeight) + '%',
      weight: newWeight,
    });
  }

  return newWeight;
}

function checkCircuitBreakers(pf) {
  var sells = (pf.tradeHistory || []).filter(function(t) { return t.action === 'sell'; });

  // Daily max loss
  var today = new Date().toISOString().slice(0, 10);
  var todaySells = sells.filter(function(t) { return t.date === today; });
  var todayLoss = todaySells.reduce(function(s, t) { return s + Math.min(0, (t.pnl || 0)); }, 0);
  var totalValue = pf.cash + (pf.positions || []).reduce(function(s, p) {
    return s + (p.shares || 0) * (p.currentPrice || p.avgCost || 0);
  }, 0);

  if (totalValue > 0 && Math.abs(todayLoss) / totalValue > 0.02) {
    return { blocked: true, reason: '今日已亏损超2% NAV，熔断' };
  }

  // Consecutive loss
  var consecutiveLossCap = (config.RISK_BUDGET && config.RISK_BUDGET.consecutiveLossCap) || 5;
  var consecCount = 0;
  for (var i = sells.length - 1; i >= 0; i--) {
    if ((sells[i].pnl || 0) <= 0) consecCount++;
    else break;
  }

  if (consecCount >= consecutiveLossCap) {
    return { blocked: true, reason: '连续' + consecCount + '笔亏损，触发熔断' };
  }

  return { blocked: false };
}

function guessSector(stockName) {
  if (!stockName) return '其他';
  if (stockName.includes('电') || stockName.includes('能')) return '电力/能源';
  if (stockName.includes('铝') || stockName.includes('铜') || stockName.includes('稀土') || stockName.includes('有色')) return '有色金属/稀土';
  if (stockName.includes('药') || stockName.includes('医') || stockName.includes('生物')) return '医药/医疗';
  if (stockName.includes('证券') || stockName.includes('银行') || stockName.includes('保险')) return '金融';
  if (stockName.includes('半导') || stockName.includes('芯片') || stockName.includes('电子') || stockName.includes('光电')) return '半导体/电子';
  if (stockName.includes('机器人') || stockName.includes('智能') || stockName.includes('自动')) return '机器人/AI';
  if (stockName.includes('军工') || stockName.includes('航天') || stockName.includes('航空')) return '军工/航天';
  if (stockName.includes('汽车') || stockName.includes('车')) return '汽车';
  if (stockName.includes('化工') || stockName.includes('化')) return '化工';
  if (stockName.includes('铁') || stockName.includes('钢') || stockName.includes('建') || stockName.includes('工')) return '基建/钢铁';
  return '其他';
}

module.exports = {
  computeRiskBudgetPosition,
  estimateVolatility,
  checkCircuitBreakers,
};
