/**
 * weekend_factor_mining.js — 周末因子组合协同效应挖掘
 *
 * 周六 10:00 运行（不与周末分析初始历史拉取窗口冲突），
 * 利用周末的计算时间做深度挖掘：
 *   1. 因子组合关联规则 — P(盈利 | Hi ∧ Hj) vs P(盈利 | Hi)
 *   2. 板块×因子交叉效应 — 同一因子在不同板块的效果差异
 *
 * 输出：
 *   - data/simfolio/factor_combinations.json — 协同/冲突因子对
 *   - data/simfolio/sector_factor_effects.json — 板块特异因子效能
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data', 'simfolio');

var _state = {
  running: false,
  lastRun: null,
  lastResult: null,
  error: null,
};

var FACTORS = [
  { id: 'H1', name: '缩量止跌' },
  { id: 'H2', name: '底部放量' },
  { id: 'H3', name: '逆势抗跌' },
  { id: 'H4', name: 'PE低估' },
  { id: 'H5', name: '高ROE低PB' },
  { id: 'H6', name: '现金流健康' },
  { id: 'H7', name: '低换手蓄力' },
  { id: 'H8', name: '短期反转' },
  { id: 'H9', name: '量价背离' },
];

var TRACKED_SECTORS = [
  '半导体/AI算力',
  '机器人/具身智能',
  '创新药/AI医疗',
  '商业航天',
  '固态电池/储能',
  '有色金属/稀土',
  '新型电力基建',
  '军工',
];

// ==================== 主函数 ====================

function runWeekendMining() {
  if (_state.running) {
    console.log('[WeekendFactorMining] 已有任务在运行，跳过');
    return { skipped: true };
  }

  _state.running = true;
  _state.error = null;
  var startTime = Date.now();

  console.log('[WeekendFactorMining] 开始因子组合挖掘...');

  try {
    var result = {
      date: new Date().toISOString().slice(0, 10),
      time: new Date().toISOString(),
      factorCombinations: null,
      sectorFactorEffects: null,
    };

    // 1. 因子组合关联规则
    result.factorCombinations = mineFactorCombinations();

    // 2. 板块×因子交叉效应
    result.sectorFactorEffects = mineSectorFactorPatterns();

    result.durationSec = Math.round((Date.now() - startTime) / 1000);

    // Save
    saveMiningResult(result);

    _state.running = false;
    _state.lastRun = new Date().toISOString();
    _state.lastResult = result;

    console.log('[WeekendFactorMining] 完成: combos=' +
      (result.factorCombinations ? result.factorCombinations.synergistic.length + '+' + result.factorCombinations.conflicting.length : 0) +
      ', sectorEffects=' +
      (result.sectorFactorEffects ? result.sectorFactorEffects.sectorPatterns.length : 0));

    return result;

  } catch (e) {
    console.error('[WeekendFactorMining] 错误:', e.message);
    _state.running = false;
    _state.error = e.message;
    return { date: new Date().toISOString().slice(0, 10), error: e.message };
  }
}

// ==================== 1. 因子组合关联规则 ====================

function mineFactorCombinations() {
  var dataset = loadAllTriggerSamples();
  if (dataset.length < 30) {
    return { available: false, reason: '样本不足(' + dataset.length + '条, 需要>=30)', synergistic: [], conflicting: [] };
  }

  // For each single factor, compute baseline P(profit)
  var singleStats = {};
  for (var fi = 0; fi < FACTORS.length; fi++) {
    var fid = FACTORS[fi].id;
    var triggers = dataset.filter(function(d) { return d.signals.indexOf(fid) >= 0; });
    if (triggers.length >= 3) {
      var profits = triggers.filter(function(d) { return d.profitable; }).length;
      singleStats[fid] = {
        total: triggers.length,
        winRate: profits / triggers.length,
        avgReturn: avg(triggers.map(function(d) { return d.futureReturn; })),
      };
    }
  }

  // For each pair of factors, compute conditional P(profit | Hi ∧ Hj)
  var synergistic = []; // pairs that beat the baseline
  var conflicting = []; // pairs that underperform

  for (var i = 0; i < FACTORS.length; i++) {
    for (var j = i + 1; j < FACTORS.length; j++) {
      var f1 = FACTORS[i];
      var f2 = FACTORS[j];

      // Find samples where both factors are present
      var bothPresent = dataset.filter(function(d) {
        return d.signals.indexOf(f1.id) >= 0 && d.signals.indexOf(f2.id) >= 0;
      });

      if (bothPresent.length < 5) continue;

      var pairWinRate = bothPresent.filter(function(d) { return d.profitable; }).length / bothPresent.length;
      var pairAvgReturn = avg(bothPresent.map(function(d) { return d.futureReturn; }));

      // Baseline: average of individual win rates
      var f1Rate = singleStats[f1.id] ? singleStats[f1.id].winRate : 0;
      var f2Rate = singleStats[f2.id] ? singleStats[f2.id].winRate : 0;
      var baselineRate = (f1Rate + f2Rate) / 2;

      var lift = pairWinRate - baselineRate;

      var pairResult = {
        factor1: f1.id,
        factor2: f2.id,
        pairSamples: bothPresent.length,
        pairWinRate: +pairWinRate.toFixed(2),
        pairAvgReturn: +pairAvgReturn.toFixed(1),
        baselineWinRate: +baselineRate.toFixed(2),
        lift: +lift.toFixed(2),
      };

      if (lift >= 0.10) {
        pairResult.effect = 'synergistic';
        synergistic.push(pairResult);
      } else if (lift <= -0.10) {
        pairResult.effect = 'conflicting';
        conflicting.push(pairResult);
      }
    }
  }

  synergistic.sort(function(a, b) { return b.lift - a.lift; });
  conflicting.sort(function(a, b) { return a.lift - b.lift; });

  return {
    available: synergistic.length > 0 || conflicting.length > 0,
    totalSamples: dataset.length,
    synergistic: synergistic,
    conflicting: conflicting,
    summary: buildComboSummary(synergistic, conflicting),
    recommendation: buildComboRecommendation(synergistic, conflicting),
  };
}

function buildComboSummary(synergistic, conflicting) {
  var parts = [];
  if (synergistic.length > 0) {
    var top = synergistic.slice(0, 3).map(function(s) { return s.factor1 + '+' + s.factor2; }).join(', ');
    parts.push('协同因子对(' + synergistic.length + '对): 同时触发时盈利概率显著提升, e.g. ' + top);
  }
  if (conflicting.length > 0) {
    var worst = conflicting.slice(0, 3).map(function(c) { return c.factor1 + '+' + c.factor2; }).join(', ');
    parts.push('冲突因子对(' + conflicting.length + '对): 同时触发时盈利概率下降, e.g. ' + worst);
  }
  return parts.length > 0 ? parts.join('; ') : '无显著因子组合效应';
}

function buildComboRecommendation(synergistic, conflicting) {
  var recs = [];
  if (synergistic.length > 0) {
    recs.push('优先考虑同时触发协同因子对的股票（信号加成）');
  }
  if (conflicting.length > 0) {
    recs.push('避免买入' + conflicting.map(function(c) { return c.factor1 + '+' + c.factor2; }).slice(0, 3).join(',') + ' 同时触发的股票');
  }
  return recs;
}

// ==================== 2. 板块×因子交叉效应 ====================

function mineSectorFactorPatterns() {
  var dataset = loadAllTriggerSamples();
  if (dataset.length < 50) {
    return { available: false, reason: '样本不足(' + dataset.length + '条,需要>=50)', sectorPatterns: [] };
  }

  var sectorPatterns = [];

  // For each sector, rank factors by win rate
  for (var si = 0; si < TRACKED_SECTORS.length; si++) {
    var sector = TRACKED_SECTORS[si];

    // Find stocks in this sector (keyword matching on the stock name)
    var sectorSamples = dataset.filter(function(d) {
      return matchesSector(d.name || d.code, sector);
    });

    if (sectorSamples.length < 10) continue;

    // For each factor, compute sector-specific win rate
    var factorRanks = [];
    for (var fi = 0; fi < FACTORS.length; fi++) {
      var fid = FACTORS[fi].id;
      var factorSamples = sectorSamples.filter(function(s) { return s.signals.indexOf(fid) >= 0; });
      if (factorSamples.length >= 3) {
        var wins = factorSamples.filter(function(s) { return s.profitable; }).length;
        factorRanks.push({
          factorId: fid,
          factorName: FACTORS[fi].name,
          samples: factorSamples.length,
          winRate: +(wins / factorSamples.length).toFixed(2),
          avgReturn: +avg(factorSamples.map(function(s) { return s.futureReturn; })).toFixed(1),
        });
      }
    }

    factorRanks.sort(function(a, b) { return b.winRate - a.winRate; });

    if (factorRanks.length >= 2) {
      sectorPatterns.push({
        sector: sector,
        totalSamples: sectorSamples.length,
        topFactors: factorRanks.slice(0, 3),
        bottomFactors: factorRanks.slice(-3),
        insight: factorRanks.length > 0
          ? sector + '最佳因子: ' + factorRanks[0].factorId + '(' + factorRanks[0].factorName + ', 命中率' + Math.round(factorRanks[0].winRate * 100) + '%)'
          : '',
      });
    }
  }

  return {
    available: sectorPatterns.length > 0,
    sectorPatterns: sectorPatterns,
    summary: sectorPatterns.map(function(p) { return p.insight; }),
  };
}

// ==================== 工具函数 ====================

function loadAllTriggerSamples() {
  var stockPerfPath = path.join(DATA_DIR, 'stock_factor_performance.json');
  if (!fs.existsSync(stockPerfPath)) return [];

  var data;
  try { data = JSON.parse(fs.readFileSync(stockPerfPath, 'utf8')); } catch (_) { return []; }

  var dailyRecords = data.dailyRecords || {};
  var dates = Object.keys(dailyRecords).sort();
  var samples = [];

  for (var di = 0; di < dates.length - 1; di++) {
    var date = dates[di];
    var records = dailyRecords[date] || [];
    var targetIdx = Math.min(di + 5, dates.length - 1);
    if (targetIdx <= di) continue;
    var targetRecords = dailyRecords[dates[targetIdx]] || [];

    for (var ri = 0; ri < records.length; ri++) {
      var rec = records[ri];
      var targetRec = targetRecords.find(function(r) { return r.code === rec.code; });
      if (!targetRec || !targetRec.price || !rec.price || rec.price <= 0) continue;

      var futureReturn = (targetRec.price - rec.price) / rec.price * 100;
      var signals = (rec.factorSignals || []).map(function(s) { return s.id; });

      if (signals.length === 0) continue;

      samples.push({
        code: rec.code,
        name: rec.name || '',
        date: date,
        price: rec.price,
        score: rec.compositeScore || 0,
        signals: signals,
        futureReturn: +futureReturn.toFixed(2),
        profitable: futureReturn > 0,
      });
    }
  }

  return samples;
}

function matchesSector(name, sector) {
  var keywords = {
    '半导体/AI算力': ['半导体', '芯片', '电子', '光电', '封测', '晶圆', '硅', '算力', '存储', '集成'],
    '机器人/具身智能': ['机器人', '智能', '减速器', '电机', '伺服', '传感', '运动控制', '自动化'],
    '创新药/AI医疗': ['药', '医疗', '医', '生物', '基因', '细胞', '疫苗', '诊断', '试剂'],
    '商业航天': ['航天', '卫星', '航空', '火箭', '军工电子', '雷达', '导航'],
    '固态电池/储能': ['电池', '储能', '锂', '电解', '正极', '负极', '新能源', '光伏', '风电'],
    '新型电力基建': ['电力', '电网', '特高压', '电缆', '电气', '充电桩', '配电'],
    '军工': ['军工', '弹药', '装备', '船舶', '电磁', '武器', '防务'],
    '有色金属/稀土': ['有色', '稀土', '矿', '铝', '铜', '钢', '金属', '材料', '磁'],
  };

  var keys = keywords[sector] || [];
  for (var i = 0; i < keys.length; i++) {
    if (name.indexOf(keys[i]) >= 0) return true;
  }
  return false;
}

function avg(arr) {
  if (!arr || arr.length === 0) return 0;
  var sum = 0;
  for (var i = 0; i < arr.length; i++) sum += arr[i];
  return sum / arr.length;
}

function saveMiningResult(result) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // Save combos
    var comboFile = path.join(DATA_DIR, 'factor_combinations.json');
    fs.writeFileSync(comboFile, JSON.stringify({
      updatedAt: new Date().toISOString(),
      factorCombinations: result.factorCombinations,
      sectorFactorEffects: result.sectorFactorEffects,
    }, null, 2), 'utf8');
  } catch (_) {}
}

function loadMiningResult() {
  var filePath = path.join(DATA_DIR, 'factor_combinations.json');
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return null; }
}

function getStatus() {
  return {
    running: _state.running,
    lastRun: _state.lastRun,
    lastResult: _state.lastResult || loadMiningResult(),
    error: _state.error,
  };
}

// ==================== Daily Incremental Update ====================

/**
 * Lightweight daily update: re-read stock_factor_performance.json
 * and incrementally update hit rates for existing combo pairs.
 * No full 9x9 pair scan — that only happens on weekends.
 */
function runDailyUpdate() {
  var dataset = loadAllTriggerSamples();
  if (dataset.length < 30) return { updated: false, reason: '样本不足' };

  // Only update: recompute synergy pairs and save
  var result = {
    date: new Date().toISOString().slice(0, 10),
    time: new Date().toISOString(),
    factorCombinations: mineFactorCombinations(),
    sectorFactorEffects: null, // sector cross-effects only on weekend
    dailyUpdate: true,
  };

  saveMiningResult(result);
  console.log('[WeekendFactorMining] Daily update: combos refreshed (' +
    (result.factorCombinations ? result.factorCombinations.synergistic.length + ' synergies' : 'N/A') + ')');
  return { updated: true };
}

module.exports = {
  runWeekendMining,
  runDailyUpdate,
  getStatus,
  loadMiningResult,
};
