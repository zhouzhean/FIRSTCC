/**
 * trade_attribution.js — 交易归因→参数反馈
 *
 * 每笔平仓后自动分析盈亏原因，反哺决策参数。
 *
 * 归因维度：
 *   1. 因子归因：买入时触发的因子后续表现如何？
 *   2. 板块归因：该板块是否近期不适合交易？
 *   3. 周期归因：当前周期判断是否准确？
 *   4. 期望收益归因：预期 vs 实际差距
 *
 * 反馈动作：
 *   - 调整因子全局信任度偏移量
 *   - 更新板块临时避让列表
 *   - 调整周期置信度乘数
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'simfolio');
const ATTRIBUTION_FILE = path.join(DATA_DIR, 'trade_attribution.json');
const ADJUSTMENTS_FILE = path.join(DATA_DIR, 'attribution_adjustments.json');

/**
 * 分析一笔已完成的卖出交易。
 *
 * @param {object} sellTrade - 卖出交易记录（来自 tradeHistory）
 * @param {object} buyTrade - 对应的买入交易记录
 * @param {object} pf - 当前投资组合
 * @param {object} context - 市场上下文
 * @returns {object} 归因分析结果
 */
function analyzeAttribution(sellTrade, buyTrade, pf, context) {
  const ctx = context || {};
  const actualReturn = sellTrade.pnlPct || 0;
  const isWin = actualReturn > 0;

  const attribution = {
    date: sellTrade.date,
    code: sellTrade.code,
    name: sellTrade.name,
    actualReturn: actualReturn,
    isWin: isWin,
    sellReason: sellTrade.reason,
    factors: [],
  };

  // ---- 1. 因子归因 ----
  if (buyTrade && buyTrade.analysisContext && buyTrade.analysisContext.hiddenSignals) {
    const signals = buyTrade.analysisContext.hiddenSignals;
    for (const sig of signals) {
      const perf = getFactorStockPerf(sig.id);
      attribution.factors.push({
        id: sig.id,
        level: sig.level,
        globalHitRate: perf ? perf.hitRate : null,
        globalAvgReturn: perf ? perf.avgReturn : null,
        outcome: isWin ? 'hit' : 'miss',
        note: isWin
          ? '因子' + sig.id + '预测正确'
          : '因子' + sig.id + '本次失误' + (perf && perf.hitRate < 0.50 ? '（该因子全局命中率偏低）' : ''),
      });
    }
  }

  // ---- 2. 板块归因 ----
  const sector = classifySector(sellTrade.name);
  if (sector !== '其他') {
    attribution.sector = sector;
    attribution.sectorNote = isWin
      ? sector + '板块本次交易盈利'
      : sector + '板块本次亏损，需关注该板块近期走势';
  }

  // ---- 3. 期望收益归因 ----
  if (buyTrade && buyTrade.analysisContext && buyTrade.analysisContext.expectedReturn != null) {
    const expected = buyTrade.analysisContext.expectedReturn;
    const error = actualReturn - expected;
    attribution.expectedReturn = expected;
    attribution.expectedError = +error.toFixed(2);
    attribution.expectedAccuracy = Math.abs(error) < 3 ? 'good' : Math.abs(error) < 5 ? 'moderate' : 'poor';
  }

  // ---- 4. 触发参数反馈 ----
  const adjustments = {};

  // If expectedReturn was positive but actual loss > 3%, flag model issue
  // v2.9.1: lowered threshold from >2% expected + < -5% actual → >0% expected + < -3% actual
  if (attribution.expectedReturn != null && attribution.expectedReturn > 0 && actualReturn < -3) {
    adjustments.factorWeightReduce = {
      reason: '期望收益+' + attribution.expectedReturn + '%但实际亏损' + Math.abs(actualReturn).toFixed(1) + '%',
      action: '降低期望收益模型中因子组合权重10%',
    };
  }

  // If consecutive misses on same factor
  if (!isWin && attribution.factors.length > 0) {
    adjustments.factorPenalty = attribution.factors.map(f => ({
      id: f.id,
      penalty: '该因子连续失误，考虑临时降权',
    }));
  }

  // If loss > 5%, flag sector as toxic for avoidance
  // v2.9.1: Expanded from hard-stop-loss only to ANY significant loss (>=5%)
  // Includes hard stop-loss (-8%), soft stop-loss, and trailing-stop losses
  if (actualReturn < -5 && sector !== '其他') {
    const lossType = sellTrade.reason && sellTrade.reason.includes('硬止损') ? '硬止损' :
                     sellTrade.reason && sellTrade.reason.includes('软止损') ? '软止损' :
                     sellTrade.reason && sellTrade.reason.includes('移动止盈') ? '移动止盈反转' : '亏损卖出';
    const avoidDays = actualReturn < -8 ? 5 : 3; // deeper loss = longer avoidance
    adjustments.sectorAvoid = {
      sector: sector,
      reason: '该板块' + lossType + '(亏损' + Math.abs(actualReturn).toFixed(1) + '%)，建议' + avoidDays + '天内避让',
      expiresAt: new Date(Date.now() + avoidDays * 86400000).toISOString().slice(0, 10),
      lossSeverity: actualReturn,
    };
  }

  attribution.adjustments = adjustments;

  // Persist
  try {
    const history = loadAttributionHistory();
    history.records.push(attribution);
    // Keep last 50 records
    if (history.records.length > 50) {
      history.records = history.records.slice(-50);
    }
    history.updatedAt = new Date().toISOString();
    saveAttributionHistory(history);
  } catch (_) {}

  // Apply adjustments
  if (Object.keys(adjustments).length > 0) {
    applyAdjustments(adjustments);
  }

  return attribution;
}

/**
 * 获取当前生效的参数调整。
 * 被 simfolio.js 和 composite.js 读取。
 */
function getActiveAdjustments() {
  if (!fs.existsSync(ADJUSTMENTS_FILE)) return {};
  try {
    const adj = JSON.parse(fs.readFileSync(ADJUSTMENTS_FILE, 'utf8'));
    // Filter expired adjustments
    const now = new Date().toISOString().slice(0, 10);
    let changed = false;

    if (adj.sectorAvoidList) {
      adj.sectorAvoidList = adj.sectorAvoidList.filter(a => !a.expiresAt || a.expiresAt >= now);
      if (adj.sectorAvoidList.length !== (adj._originalSectorCount || 0)) changed = true;
    }

    if (changed) {
      adj.updatedAt = new Date().toISOString();
      saveAdjustments(adj);
    }

    return adj;
  } catch (_) { return {}; }
}

/**
 * 获取应避让的板块列表。
 */
function getAvoidSectors() {
  const adj = getActiveAdjustments();
  if (adj.sectorAvoidList && adj.sectorAvoidList.length > 0) {
    return adj.sectorAvoidList.map(a => a.sector);
  }
  return [];
}

function applyAdjustments(adjustments) {
  let existing = {};
  if (fs.existsSync(ADJUSTMENTS_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(ADJUSTMENTS_FILE, 'utf8'));
    } catch (_) {}
  }

  // Merge sector avoid list
  if (adjustments.sectorAvoid) {
    if (!existing.sectorAvoidList) existing.sectorAvoidList = [];
    existing.sectorAvoidList.push(adjustments.sectorAvoid);
    // Dedup by sector
    const seen = new Set();
    existing.sectorAvoidList = existing.sectorAvoidList.filter(a => {
      if (seen.has(a.sector)) return false;
      seen.add(a.sector);
      return true;
    });
    existing._originalSectorCount = existing.sectorAvoidList.length;
  }

  // Factor weight offsets
  if (adjustments.factorWeightReduce) {
    if (!existing.factorWeightOffsets) existing.factorWeightOffsets = {};
    existing.factorWeightOffsets.reduced = true;
    existing.factorWeightOffsets.reason = adjustments.factorWeightReduce.reason;
  }

  existing.updatedAt = new Date().toISOString();
  saveAdjustments(existing);
}

function saveAdjustments(data) {
  try {
    const dir = path.dirname(ADJUSTMENTS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ADJUSTMENTS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
}

// ---- Helpers ----

function getFactorStockPerf(factorId) {
  const spfPath = path.join(DATA_DIR, 'stock_factor_performance.json');
  if (!fs.existsSync(spfPath)) return null;
  try {
    const spf = JSON.parse(fs.readFileSync(spfPath, 'utf8'));
    // Try to compute from daily records
    const stockPredictor = require('./stock_predictor');
    const perf = stockPredictor.computeStockFactorPerformance(3);
    if (perf.factors) {
      const f = perf.factors.find(x => x.id === factorId);
      return f || null;
    }
  } catch (_) {}
  return null;
}

function classifySector(stockName) {
  const SECTOR_KEYWORDS = {
    '有色金属/稀土': ['有色', '稀土', '矿', '铝', '铜', '钢', '金属', '材料', '磁'],
    '半导体/AI算力': ['半导体', '芯片', '电子', '光电', '封测', '晶圆', '硅', '算力', '存储'],
    '机器人/具身智能': ['机器人', '智能', '减速器', '电机', '伺服', '传感', '运动控制', '自动化'],
    '创新药/AI医疗': ['药', '医疗', '医', '生物', '基因', '细胞', '疫苗', '诊断', '试剂'],
    '商业航天': ['航天', '卫星', '航空', '火箭', '军工电子', '雷达', '导航'],
    '固态电池/储能': ['电池', '储能', '锂', '电解', '正极', '负极', '新能源', '光伏', '风电'],
    '新型电力基建': ['电力', '电网', '特高压', '电缆', '电气', '充电桩', '配电'],
    '军工': ['军工', '弹药', '装备', '船舶', '电磁', '武器', '防务'],
  };
  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    if (keywords.some(kw => (stockName || '').includes(kw))) return sector;
  }
  return '其他';
}

function loadAttributionHistory() {
  if (!fs.existsSync(ATTRIBUTION_FILE)) return { records: [], updatedAt: null };
  try {
    return JSON.parse(fs.readFileSync(ATTRIBUTION_FILE, 'utf8'));
  } catch (_) { return { records: [], updatedAt: null }; }
}

function saveAttributionHistory(history) {
  try {
    const dir = path.dirname(ATTRIBUTION_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ATTRIBUTION_FILE, JSON.stringify(history, null, 2), 'utf8');
  } catch (_) {}
}

module.exports = {
  analyzeAttribution,
  getActiveAdjustments,
  getAvoidSectors,
};
