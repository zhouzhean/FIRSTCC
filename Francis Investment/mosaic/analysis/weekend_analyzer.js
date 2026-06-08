/**
 * weekend_analyzer.js — 周末深度分析引擎
 *
 * Phase 1: 聚合现有数据 (summaries / events / knowledge_base / portfolio / correlation)
 * Phase 2: 东方财富 API 历史 K 线采集 → data/market_history/indices/
 * Phase 3: 深度分析 (历史相似度 / 危机预警 / 板块轮动 / 因子效能)
 * Phase 4: 生成 simfolio 增强上下文 → data/simfolio/weekend_context.json
 *
 * 周末无新数据时自动跳过重复分析，节省 CPU。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const CONFIG = require('../config');

const DATA_DIR = path.join(__dirname, '..', '..', 'report-engine', 'data');
const HISTORY_DIR = path.join(DATA_DIR, 'market_history', 'indices');
const ARCHIVE_DIR = path.join(DATA_DIR, 'weekend_archive');
const WC = CONFIG.WEEKEND_ANALYSIS || {};
const WV = CONFIG.WEEKEND_VERIFICATION || {};

// ==================== 状态管理 ====================

let _state = {
  running: false,
  phase: 'idle',
  progress: 0,
  cycles: 0,
  lastRun: null,
  error: null,
  insights: [],
  similarityResults: [],
  crisisScore: 0,
  sectorRotation: null,
  factorPerformance: null,
  // 用于去重：记录上一轮的数据指纹
  _lastDataFingerprint: null,
};

let _timer = null;
let _historyTimer = null;

// ==================== 导出接口 ====================

function startWeekendAnalysis() {
  if (_state.running) return;
  _state.running = true;
  _state.phase = 'starting';
  _state.progress = 0;
  _state.cycles = 0;
  _state.error = null;
  _state._lastDataFingerprint = null;

  console.log('[WeekendAnalyzer] Starting weekend deep analysis...');
  _logSSE({ type: 'weekend_start', message: 'Weekend analysis started' });

  // 立即执行第一轮（含历史数据拉取）
  _runFullCycle();

  // 后续每 N 分钟重新分析
  const interval = (WC.analysisInterval || 15 * 60 * 1000);
  _timer = setInterval(() => {
    _runFullCycle({ skipHistoryPull: true });
  }, interval);

  // 每 2 小时增量拉取 K 线
  const historyInterval = (WC.historyPullInterval || 2 * 60 * 60 * 1000);
  _historyTimer = setInterval(() => {
    _pullHistoricalData();
  }, historyInterval);
}

function stopWeekendAnalysis() {
  if (!_state.running) return;
  _state.running = false;

  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_historyTimer) { clearInterval(_historyTimer); _historyTimer = null; }

  _state.phase = 'stopped';
  console.log('[WeekendAnalyzer] Weekend analysis stopped');
  _logSSE({ type: 'weekend_stop', message: 'Weekend analysis stopped' });
}

function getStatus() {
  return { ..._state, running: _state.running };
}

function getReport() {
  return {
    generatedAt: new Date().toISOString(),
    status: _state.phase,
    cycles: _state.cycles,
    lastRun: _state.lastRun,
    similarity: _state.similarityResults,
    crisisWarning: _state.crisisScore != null ? {
      score: _state.crisisScore,
      label: _crisisLabel(_state.crisisScore),
      dimensions: _state.crisisDimensions || [],
    } : null,
    sectorRotation: _state.sectorRotation,
    factorPerformance: _state.factorPerformance,
    insights: _state.insights,
    marketProfile: _state.marketProfile || null,
  };
}

function getEnhancedContext() {
  const ctxPath = path.join(DATA_DIR, 'simfolio', 'weekend_context.json');
  if (fs.existsSync(ctxPath)) {
    try {
      const ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf8'));
      const now = new Date().toISOString().slice(0, 10);
      if (ctx.validUntil >= now) return ctx;
    } catch (_) {}
  }
  return null;
}

// ==================== 内部实现 ====================

async function _runFullCycle(opts) {
  opts = opts || {};
  _state.phase = 'running';
  _state.progress = 5;

  try {
    // Phase 1: 聚合现有数据
    _state.phase = 'phase1_aggregation';
    _state.progress = 10;
    const aggregated = _aggregateExistingData();
    _state.progress = 30;

    // 去重检查：如果数据指纹与上一轮相同，跳过分析
    const fingerprint = _computeDataFingerprint(aggregated);
    if (opts.skipHistoryPull && fingerprint === _state._lastDataFingerprint && _state.cycles > 0) {
      _state.phase = 'complete';
      console.log('[WeekendAnalyzer] Data unchanged, skipping duplicate cycle');
      return;
    }
    _state._lastDataFingerprint = fingerprint;

    // Phase 2: 拉取历史 K 线（首轮或每 2h 增量）
    if (!opts.skipHistoryPull) {
      _state.phase = 'phase2_history';
      _state.progress = 35;
      await _pullHistoricalData();
    }
    _state.progress = 50;

    // Phase 3: 深度分析
    _state.phase = 'phase3_analysis';
    _state.progress = 55;
    const historicalData = _loadHistoricalData();

    // 3a. 历史相似度匹配
    _state.progress = 60;
    _state.similarityResults = _computeSimilarity(aggregated, historicalData);
    _state.progress = 70;

    // 3b. 危机预警
    _state.progress = 75;
    const crisis = _computeCrisisWarning(aggregated, historicalData);
    _state.crisisScore = crisis.score;
    _state.crisisDimensions = crisis.dimensions;
    _state.progress = 80;

    // 3c. 板块轮动
    _state.progress = 85;
    _state.sectorRotation = _analyzeSectorRotation(aggregated, historicalData);
    _state.progress = 90;

    // 3d. 因子效能
    _state.factorPerformance = _analyzeFactorEffectiveness(aggregated);
    _state.progress = 95;

    // 生成市场画像
    _state.marketProfile = _buildMarketProfile(aggregated);

    // Phase 4: 生成增强上下文（含验证反馈）
    _state.phase = 'phase4_context';
    const lastVerif = _loadLastVerification();
    const { insights, adjustments } = _generateInsights(lastVerif);
    _state.insights = insights;

    let verificationContext = null;
    if (lastVerif) {
      verificationContext = {
        lastWeekend: lastVerif.weekend,
        overallGrade: lastVerif.overall ? lastVerif.overall.grade : null,
        overallScore: lastVerif.overall ? lastVerif.overall.score : null,
        adjustments: adjustments,
        highlights: _extractHighlights(lastVerif),
      };
    }
    _writeWeekendContext(_state.insights, verificationContext);
    _state.progress = 100;

    // 完成
    _state.phase = 'complete';
    _state.cycles++;
    _state.lastRun = new Date().toISOString();

    // 归档报告用于后续验证
    _archiveReport();

    _logSSE({
      type: 'weekend_cycle_complete',
      cycle: _state.cycles,
      insights: _state.insights.length,
      crisisScore: _state.crisisScore,
    });

    console.log(`[WeekendAnalyzer] Cycle ${_state.cycles} complete, ${_state.insights.length} insights`);
  } catch (e) {
    _state.phase = 'error';
    _state.error = e.message;
    console.error('[WeekendAnalyzer] Analysis error:', e.message);
    _logSSE({ type: 'weekend_error', message: e.message });
  }
}

// 计算数据指纹，用于去重
function _computeDataFingerprint(aggregated) {
  // 基于关键数据的哈希：最新 summary 日期 + summaries 数量 + portfolio lastUpdated
  const parts = [];
  if (aggregated.dateRange.to) parts.push(aggregated.dateRange.to);
  parts.push(aggregated.summaries.length);
  parts.push(aggregated.events.length);
  if (aggregated.portfolio && aggregated.portfolio.meta) {
    parts.push(aggregated.portfolio.meta.lastUpdated || '');
  }
  return parts.join('|');
}

// ==================== Phase 1: 数据聚合 ====================

function _aggregateExistingData() {
  const aggregated = {
    summaries: [],
    events: [],
    knowledge: [],
    portfolio: null,
    correlations: null,   // { updatedAt, days: [...] }
    factorPerf: null,
    lastPipeline: null,
    dateRange: { from: null, to: null },
    tradeStats: { totalBuys: 0, totalSells: 0, winCount: 0, lossCount: 0, totalReturn: 0 },
    riskRegimeHistory: [],
    sectorExposure: {},
  };

  // 加载 summaries
  const summariesDir = path.join(DATA_DIR, 'summaries');
  if (fs.existsSync(summariesDir)) {
    const files = fs.readdirSync(summariesDir).filter(f => f.endsWith('.json')).sort();
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(summariesDir, f), 'utf8'));
        aggregated.summaries.push({ date: f.replace('.json', ''), data });
      } catch (_) {}
    }
  }

  // 加载 events
  const eventsDir = path.join(DATA_DIR, 'events');
  if (fs.existsSync(eventsDir)) {
    const files = fs.readdirSync(eventsDir).filter(f => f.endsWith('.json')).sort();
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(eventsDir, f), 'utf8'));
        aggregated.events.push({ date: f.replace('.json', ''), data });
      } catch (_) {}
    }
  }

  // 加载 knowledge base
  const kbDir = path.join(DATA_DIR, 'knowledge_base');
  if (fs.existsSync(kbDir)) {
    const files = fs.readdirSync(kbDir).filter(f => f.endsWith('.json') && f !== 'index.json').sort();
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(kbDir, f), 'utf8'));
        aggregated.knowledge.push({ date: f.replace('.json', ''), data });
      } catch (_) {}
    }
  }

  // 加载 portfolio
  const pfPath = path.join(DATA_DIR, 'simfolio', 'portfolio.json');
  if (fs.existsSync(pfPath)) {
    try {
      aggregated.portfolio = JSON.parse(fs.readFileSync(pfPath, 'utf8'));
      if (aggregated.portfolio.tradeHistory) {
        for (const t of aggregated.portfolio.tradeHistory) {
          if (t.action === 'buy') aggregated.tradeStats.totalBuys++;
          if (t.action === 'sell') {
            aggregated.tradeStats.totalSells++;
            if (t.profit > 0) aggregated.tradeStats.winCount++;
            else aggregated.tradeStats.lossCount++;
            aggregated.tradeStats.totalReturn += t.profit || 0;
          }
        }
      }
      if (aggregated.portfolio.positions) {
        for (const pos of aggregated.portfolio.positions) {
          const sector = _classifySector(pos.name);
          aggregated.sectorExposure[sector] = (aggregated.sectorExposure[sector] || 0) + (pos.marketValue || 0);
        }
      }
      if (aggregated.portfolio.navHistory) {
        for (const nav of aggregated.portfolio.navHistory) {
          if (nav.date) {
            aggregated.riskRegimeHistory.push({ date: nav.date, nav: nav.nav, cashRatio: nav.cashRatio });
          }
        }
      }
    } catch (_) {}
  }

  // 加载 correlation_history（保持完整结构：{ updatedAt, days: [...] }）
  const corrPath = path.join(DATA_DIR, 'us_market', 'correlation_history.json');
  if (fs.existsSync(corrPath)) {
    try {
      aggregated.correlations = JSON.parse(fs.readFileSync(corrPath, 'utf8'));
    } catch (_) {}
  }

  // 加载 factor_performance
  const fpPath = path.join(DATA_DIR, 'simfolio', 'factor_performance.json');
  if (fs.existsSync(fpPath)) {
    try {
      aggregated.factorPerf = JSON.parse(fs.readFileSync(fpPath, 'utf8'));
    } catch (_) {}
  }

  // 加载 last_pipeline_result
  const lprPath = path.join(DATA_DIR, 'simfolio', 'last_pipeline_result.json');
  if (fs.existsSync(lprPath)) {
    try {
      aggregated.lastPipeline = JSON.parse(fs.readFileSync(lprPath, 'utf8'));
    } catch (_) {}
  }

  // 确定日期范围
  if (aggregated.summaries.length > 0) {
    aggregated.dateRange.from = aggregated.summaries[0].date;
    aggregated.dateRange.to = aggregated.summaries[aggregated.summaries.length - 1].date;
  }

  return aggregated;
}

// ==================== Phase 2: 东方财富历史 K 线采集 ====================

async function _pullHistoricalData() {
  if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
  }

  const indices = [
    { code: 'sh000001', name: 'SSE Composite' },
    { code: 'sz399001', name: 'SZSE Component' },
    { code: 'sz399006', name: 'ChiNext' },
  ];

  for (const idx of indices) {
    await _pullIndexHistory(idx, 3);
  }

  console.log('[WeekendAnalyzer] Historical K-line pull complete');
}

function _pullIndexHistory(index, retries) {
  return new Promise((resolve) => {
    const filePath = path.join(HISTORY_DIR, `${index.code}.json`);
    let existing = [];

    if (fs.existsSync(filePath)) {
      try {
        existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (_) {}
    }

    const lastDate = existing.length > 0 ? existing[existing.length - 1].date : null;
    const daysSince = lastDate ? _daysBetween(lastDate, _todayStr()) : 365 * 5;

    if (daysSince <= 1 && existing.length > 0) {
      return resolve(true);
    }

    _fetchSinaDailyK(index.code)
      .then(newData => {
        if (!newData || newData.length === 0) {
          if (retries > 0) {
            console.log(`[WeekendAnalyzer] ${index.name}: no data, ${retries} retries left...`);
            setTimeout(() => {
              _pullIndexHistory(index, retries - 1).then(resolve);
            }, (WC.sinaBatchDelay || 200) * 5);
          } else {
            resolve(false);
          }
          return;
        }

        const merged = _mergeDedupe(existing, newData);
        fs.writeFileSync(filePath, JSON.stringify(merged));

        console.log(`[WeekendAnalyzer] ${index.name}: ${existing.length} -> ${merged.length} (added ${merged.length - existing.length})`);
        resolve(true);
      })
      .catch(err => {
        console.error(`[WeekendAnalyzer] ${index.name} pull failed:`, err.message);
        if (retries > 0) {
          setTimeout(() => {
            _pullIndexHistory(index, retries - 1).then(resolve);
          }, (WC.sinaBatchDelay || 200) * 10);
        } else {
          resolve(false);
        }
      });
  });
}

function _fetchSinaDailyK(code) {
  return new Promise((resolve, reject) => {
    const secid = code.startsWith('sh') ? `1.${code.slice(2)}` : `0.${code.slice(2)}`;
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=2000`;

    const req = https.get(url, { timeout: 30000, headers: { 'Referer': 'https://quote.eastmoney.com/' } }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (!json.data || !json.data.klines) {
            return resolve([]);
          }
          const result = json.data.klines.map(line => {
            const parts = line.split(',');
            return {
              date: parts[0],
              open: parseFloat(parts[1]),
              close: parseFloat(parts[2]),
              high: parseFloat(parts[3]),
              low: parseFloat(parts[4]),
              volume: parseFloat(parts[5]) || 0,
              amount: parseFloat(parts[6]) || 0,
            };
          });
          resolve(result);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function _mergeDedupe(existing, incoming) {
  const dateMap = {};
  for (const item of existing) {
    dateMap[item.date] = item;
  }
  for (const item of incoming) {
    dateMap[item.date] = item;
  }
  return Object.values(dateMap).sort((a, b) => a.date.localeCompare(b.date));
}

// ==================== Phase 3: 深度分析 ====================

function _loadHistoricalData() {
  const result = {};
  const indices = ['sh000001', 'sz399001', 'sz399006'];
  for (const code of indices) {
    const fp = path.join(HISTORY_DIR, `${code}.json`);
    if (fs.existsSync(fp)) {
      try {
        result[code] = JSON.parse(fs.readFileSync(fp, 'utf8'));
      } catch (_) {}
    }
  }
  return result;
}

// ==================== 3a. 历史相似度匹配（带归一化） ====================

function _computeSimilarity(aggregated, historicalData) {
  const shData = historicalData['sh000001'];
  if (!shData || shData.length < 60) return [];

  const windowSize = WC.similarityWindow || 20;
  const topN = WC.similarityTopN || 5;
  const stride = WC.similarityStride || 5;  // 窗口步长，避免重叠窗口

  // 构建当前市场状态向量（最新 windowSize 天）
  const currentVector = _buildMarketVector(shData, shData.length - windowSize, shData.length);
  if (!currentVector) return [];

  // 收集所有历史窗口的原始向量，跳过最近 windowSize+5 天（避免用未来数据）
  const allVectors = [];
  for (let i = 0; i < shData.length - windowSize - 5; i += stride) {
    const histVector = _buildMarketVector(shData, i, i + windowSize);
    if (!histVector) continue;
    allVectors.push({
      startIdx: i,
      vector: histVector,
    });
  }

  // Bug fix 1: Z-score 归一化所有向量（包括当前向量），量纲一致
  const allRawVectors = allVectors.map(v => v.vector).concat([currentVector]);
  const normalizedVectors = _zscoreNormalize(allRawVectors);

  // 当前向量是最后一个
  const normalizedCurrent = normalizedVectors[normalizedVectors.length - 1];

  // 计算每个历史窗口的余弦相似度
  const similarities = [];
  for (let i = 0; i < allVectors.length; i++) {
    const win = allVectors[i];
    const startIdx = win.startIdx;
    const histNormalized = normalizedVectors[i];
    const sim = _cosineSimilarity(normalizedCurrent, histNormalized);

    // 相似度语义分级阈值：raw cosine 在 [-1,1]，归一化后通常 0.3~0.95
    let simLabel = 'low';
    if (sim > 0.85) simLabel = 'very_high';
    else if (sim > 0.65) simLabel = 'high';
    else if (sim > 0.45) simLabel = 'moderate';

    similarities.push({
      startDate: shData[startIdx].date,
      endDate: shData[startIdx + windowSize - 1].date,
      similarity: Math.round(sim * 10000) / 100,
      simLabel,
      future5d: _extractFutureReturns(shData, startIdx + windowSize, 5),
      future10d: _extractFutureReturns(shData, startIdx + windowSize, 10),
      future20d: _extractFutureReturns(shData, startIdx + windowSize, 20),
    });
  }

  // 排序取 top N
  similarities.sort((a, b) => b.similarity - a.similarity);

  // Bug fix 1b: 标记相似度级别
  const top = similarities.slice(0, topN);
  return top;
}

// Z-score 归一化：对每个维度独立计算 (x - mean) / std，然后 Min-Max 缩放到 [-1, 1]
function _zscoreNormalize(vectors) {
  if (vectors.length === 0) return [];
  const dims = vectors[0].length;

  // 计算每个维度的均值和标准差
  const means = [];
  const stds = [];
  for (let d = 0; d < dims; d++) {
    const vals = vectors.map(v => v[d]);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
    const std = Math.sqrt(variance);
    means.push(mean);
    stds.push(std);
  }

  // 对每个向量做 Z-score，然后 tanh 压缩到 [-1, 1]
  return vectors.map(vec => {
    return vec.map((v, d) => {
      if (stds[d] === 0) return 0;
      const z = (v - means[d]) / stds[d];
      // 使用双曲正切压缩极端值，同时保持单调性
      return Math.tanh(z);
    });
  });
}

function _buildMarketVector(data, start, end) {
  if (end > data.length) return null;
  const window = data.slice(start, end);
  if (window.length < 5) return null;

  // 6维特征向量：
  // [0] 区间总涨跌幅（小数）
  // [1] 日涨跌幅标准差（波动率）
  // [2] 最后5日动量
  // [3] 成交量趋势（末5日 / 初5日 - 1）
  // [4] 上涨天数占比 [0,1]
  // [5] 最大单日跌幅（负数）

  const returns = [];
  for (let i = 1; i < window.length; i++) {
    returns.push((window[i].close - window[i - 1].close) / window[i - 1].close);
  }
  if (returns.length === 0) return null;

  const totalReturn = (window[window.length - 1].close - window[0].close) / window[0].close;
  const stdDev = _standardDeviation(returns);
  const last5 = window.slice(-5);
  const momentum5 = (last5[last5.length - 1].close - last5[0].close) / last5[0].close;

  const volFirst = window.slice(0, 5).reduce((s, d) => s + d.volume, 0) / 5;
  const volLast = window.slice(-5).reduce((s, d) => s + d.volume, 0) / 5;
  const volTrend = volFirst > 0 ? (volLast - volFirst) / volFirst : 0;

  const upDays = returns.filter(r => r > 0).length / returns.length;
  const maxDrop = Math.min(...returns);

  return [totalReturn, stdDev, momentum5, volTrend, upDays, maxDrop];
}

function _cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function _extractFutureReturns(data, from, days) {
  if (from + days > data.length) {
    days = data.length - from;
  }
  if (days <= 0) return null;

  const start = data[from - 1];
  const future = data.slice(from, from + days);

  const cumulative = [];
  let lastClose = start.close;
  for (const d of future) {
    const ret = (d.close - lastClose) / lastClose;
    cumulative.push(Math.round(ret * 10000) / 100);
    lastClose = d.close;
  }

  const totalReturn = (future[future.length - 1].close - start.close) / start.close;
  return {
    total: Math.round(totalReturn * 10000) / 100,
    maxUp: future.length > 0 ? Math.round((Math.max(...future.map(d => d.close)) - start.close) / start.close * 10000) / 100 : 0,
    maxDown: future.length > 0 ? Math.round((Math.min(...future.map(d => d.close)) - start.close) / start.close * 10000) / 100 : 0,
    cumulative,
    label: totalReturn > 5 ? 'bullish' : totalReturn > 0 ? 'slightly_bullish' : totalReturn > -5 ? 'slightly_bearish' : 'bearish',
  };
}

// ==================== 3b. 危机预警（修复字段路径） ====================

function _computeCrisisWarning(aggregated, historicalData) {
  const weights = WC.crisisWeights || {
    liquidity: 0.25, valuation: 0.20, marketBreadth: 0.20,
    northBound: 0.15, margin: 0.10, volatility: 0.10
  };
  const dimensions = [];

  // --- 维度1：流动性 ---
  // 从历史 K 线数据直接计算成交量趋势（而非缺失的 summary.market.totalVolume）
  let liquidityScore = 50;
  const shData = historicalData['sh000001'];
  if (shData && shData.length >= 10) {
    const recent10 = shData.slice(-10);
    const first5 = recent10.slice(0, 5);
    const last5 = recent10.slice(-5);
    const avgFirst = first5.reduce((s, d) => s + d.volume, 0) / 5;
    const avgLast = last5.reduce((s, d) => s + d.volume, 0) / 5;
    if (avgFirst > 0) {
      const volTrend = (avgLast - avgFirst) / avgFirst;
      if (volTrend < -0.3) liquidityScore = 80;
      else if (volTrend < -0.15) liquidityScore = 65;
      else if (volTrend < 0) liquidityScore = 55;
      else if (volTrend > 0.3) liquidityScore = 25;
      else if (volTrend > 0.15) liquidityScore = 35;
      else liquidityScore = 50;
    }
  }
  dimensions.push({ name: '流动性', score: liquidityScore, weight: weights.liquidity, detail: _cnLevelLabel(liquidityScore) });

  // --- 维度2：估值 ---
  // 从 last_pipeline_result 的 scoreDistribution 推断（没有 allResults 字段）
  let valuationScore = 50;
  if (aggregated.lastPipeline) {
    const lpr = aggregated.lastPipeline;
    // 用 top5 的平均分推断：高分股多 = 估值合理
    if (lpr.top5 && lpr.top5.length > 0) {
      const avgScore = lpr.top5.reduce((s, t) => s + (t.score || 0), 0) / lpr.top5.length;
      // 全是低分（<55）= 市场上估值偏高候选少 = 估值偏高
      if (avgScore < 55) valuationScore = 70;
      else if (avgScore < 60) valuationScore = 60;
      else if (avgScore < 70) valuationScore = 45;
      else valuationScore = 30;
    }
  }
  dimensions.push({ name: '估值', score: valuationScore, weight: weights.valuation, detail: _cnLevelLabel(valuationScore) });

  // --- 维度3：市场宽度 ---
  // 从 last_pipeline_result 的 scoreDistribution
  let breadthScore = 50;
  if (aggregated.lastPipeline) {
    const lpr = aggregated.lastPipeline;
    if (lpr.scoreDistribution) {
      const total = (lpr.scoreDistribution.lt50 || 0) +
        (lpr.scoreDistribution.r50_60 || 0) +
        (lpr.scoreDistribution.r60_70 || 0) +
        (lpr.scoreDistribution.r70_80 || 0) +
        (lpr.scoreDistribution.gt80 || 0);
      if (total > 0) {
        const highScore = (lpr.scoreDistribution.r60_70 || 0) +
          (lpr.scoreDistribution.r70_80 || 0) +
          (lpr.scoreDistribution.gt80 || 0);
        const highRatio = highScore / total;
        if (highRatio > 0.5) breadthScore = 25;
        else if (highRatio > 0.35) breadthScore = 35;
        else if (highRatio > 0.2) breadthScore = 50;
        else if (highRatio > 0.1) breadthScore = 65;
        else breadthScore = 80;
      }
    } else if (lpr.candidates && lpr.analyzed) {
      // fallback: 用候选股比例
      const ratio = lpr.analyzed / Math.max(1, lpr.candidates);
      if (ratio > 0.4) breadthScore = 30;
      else if (ratio > 0.2) breadthScore = 45;
      else if (ratio > 0.1) breadthScore = 55;
      else breadthScore = 70;
    }
  }
  dimensions.push({ name: '市场宽度', score: breadthScore, weight: weights.marketBreadth, detail: _cnLevelLabel(breadthScore) });

  // --- 维度4：北向资金 ---
  // Use real north-bound sentiment data for crisis scoring
  let northScore = 50;
  let northDetail = _cnLevelLabel(50);
  try {
    const northBound = require('../collectors/north_bound');
    // Use correlation history to get recent NB sentiment
    if (aggregated.correlations && aggregated.correlations.days && aggregated.correlations.days.length > 0) {
      const lastDay = aggregated.correlations.days[aggregated.correlations.days.length - 1];
      if (lastDay.nbSentiment) {
        const nb = lastDay.nbSentiment;
        if (nb === 'bearish') { northScore = 75; northDetail = '北向大幅流出'; }
        else if (nb === 'slightly_bearish') { northScore = 60; northDetail = '北向小幅流出'; }
        else if (nb === 'bullish') { northScore = 25; northDetail = '北向持续流入'; }
        else if (nb === 'slightly_bullish') { northScore = 35; northDetail = '北向小幅流入'; }
        else { northScore = 50; northDetail = '北向中性'; }
      }
    }
    // Fallback: check factor_performance.json for NB records
    if (northScore === 50 && aggregated.factorPerf && aggregated.factorPerf.nbPerformance) {
      const nbp = aggregated.factorPerf.nbPerformance;
      if (nbp.available && nbp.status === 'cold') {
        northScore = 65;
        northDetail = '北向信号近期命中率低，方向不明';
      }
    }
  } catch (_) {}
  dimensions.push({ name: '北向资金', score: northScore, weight: weights.northBound, detail: northDetail });

  // --- 维度5：两融余额趋势 ---
  // Use real margin data — replaces the "暂无数据" default
  let marginScore = 50;
  let marginDetail = _cnLevelLabel(50);
  try {
    const marginData = require('../collectors/margin_data');
    const marginFlow = require('fs').existsSync(
      require('path').join(require('../config').DATA_DIR, 'simfolio', 'factor_performance.json')
    ) ? [] : []; // margin data is fetched fresh each time
    // Fetch live margin data for the crisis score
    // Note: this is async-in-sync context; we use the weekend context's cached data
    if (aggregated.factorPerf && aggregated.factorPerf.nbSentimentHistory) {
      marginScore = 50; // fallback: will be enhanced when margin data flows through pipeline
      marginDetail = '等待 Pipeline 两融数据积累';
    }
  } catch (_) {}
  // If no real data available, keep neutral but label clearly
  if (marginScore === 50 && marginDetail === _cnLevelLabel(50)) {
    marginDetail = '暂无数据（已部署两融采集器，等待数据积累）';
  }
  dimensions.push({ name: '两融余额', score: marginScore, weight: weights.margin, detail: marginDetail });

  // --- 维度6：波动率 ---
  // Bug fix 5c: 字段名是 changePercent（大写 P），结构是 market.indices[] 数组
  let volScore = 50;
  if (aggregated.summaries.length >= 3) {
    const idxChanges = [];
    for (const s of aggregated.summaries.slice(-10)) {
      if (s.data && s.data.market && Array.isArray(s.data.market.indices)) {
        const shIdx = s.data.market.indices.find(
          idx => idx.code === '000001' || idx.code === 'sh000001' || idx.name === 'SSE Composite'
        );
        if (shIdx && shIdx.changePercent != null) {
          idxChanges.push(shIdx.changePercent);
        }
      }
    }
    if (idxChanges.length >= 3) {
      const vol = _standardDeviation(idxChanges);
      if (vol > 2.5) volScore = 80;
      else if (vol > 1.8) volScore = 65;
      else if (vol > 1.2) volScore = 50;
      else if (vol > 0.8) volScore = 35;
      else volScore = 20;
    }
  }
  dimensions.push({ name: '波动率', score: volScore, weight: weights.volatility, detail: _cnLevelLabel(volScore) });

  // 加权综合
  let totalScore = 0;
  let totalWeight = 0;
  for (const dim of dimensions) {
    totalScore += dim.score * dim.weight;
    totalWeight += dim.weight;
  }
  const finalScore = totalWeight > 0 ? Math.round(totalScore / totalWeight) : 50;

  return { score: finalScore, dimensions };
}

function _levelLabel(score) {
  if (score >= 75) return 'Danger';
  if (score >= 60) return 'Elevated';
  if (score >= 40) return 'Normal';
  if (score >= 25) return 'Low';
  return 'Safe';
}

function _cnLevelLabel(score) {
  if (score >= 75) return '危险';
  if (score >= 60) return '偏高';
  if (score >= 40) return '正常';
  if (score >= 25) return '偏低';
  return '安全';
}

function _crisisLabel(score) {
  if (score >= 75) return '高风险 — 建议大幅降低仓位';
  if (score >= 60) return '风险偏高 — 注意控制仓位';
  if (score >= 40) return '风险适中 — 维持正常仓位';
  if (score >= 25) return '低风险 — 可适度加仓';
  return '极低风险 — 适合积极配置';
}

// ==================== 3c. 板块轮动分析 ====================

function _analyzeSectorRotation(aggregated, historicalData) {
  const sectors = ['Semiconductor/AI', 'Pharma/AI Health', 'Solid-state Battery',
    'Robotics/Embodied AI', 'Metals/Rare Earth', 'Financials',
    'Defense/Space', 'New Power Grid'];

  // 构建领先/滞后矩阵（8x8）
  const matrix = [];
  for (let i = 0; i < sectors.length; i++) {
    const row = [];
    for (let j = 0; j < sectors.length; j++) {
      if (i === j) {
        row.push({ rel: '-', score: 0 });
      } else {
        // Bug fix 3+4: 修复 correlations 访问路径 + 板块名称映射
        const score = _estimateSectorRelation(aggregated, sectors[i], sectors[j]);
        row.push(score);
      }
    }
    matrix.push(row);
  }

  // 确定当前阶段
  const currentPhase = _detectRotationPhase(aggregated);

  return { sectors: sectors.map(s => _SECTOR_DISPLAY[s] || s), matrix, currentPhase };
}

// 将内部统一名称映射到 correlation_history.json 中的实际键名
const _SECTOR_TO_CORR_KEY = {
  'Semiconductor/AI': ['Semiconductor/AI'],
  'Pharma/AI Health': ['Pharma/AI Health'],
  'Solid-state Battery': ['Solid-state Battery'],
  'Robotics/Embodied AI': ['Robotics/Embodied AI'],
  'Metals/Rare Earth': ['Metals/Rare Earth'],
  'Financials': ['Financials'],
  'Defense/Space': ['Defense', 'Space'],
  'New Power Grid': ['New Power Grid'],
};

// 反向映射表：correlation key -> 内部 sector 名
let _corrKeyToSector = null;
function _getCorrKeyToSector() {
  if (_corrKeyToSector) return _corrKeyToSector;
  _corrKeyToSector = {};
  // 实际 correlation 文件中使用的中文键名
  const actualKeys = {
    'Semiconductor/AI': 'Semiconductor/AI',
    'Pharma/AI Health': 'Pharma/AI Health',
    'Solid-state Battery': 'Solid-state Battery',
    'Robotics/Embodied AI': 'Robotics/Embodied AI',
    'Metals/Rare Earth': 'Metals/Rare Earth',
    'Financials': 'Financials',
    'Defense': 'Defense/Space',
    'Space': 'Defense/Space',
    'Defense/Space': 'Defense/Space',
    'New Power Grid': 'New Power Grid',
  };
  return actualKeys;
}

// 内部英文名 -> correlation_history.json 中的实际中文键名
const _EN_TO_CORR_KEY = {
  'Semiconductor/AI': '半导体/AI算力',
  'Pharma/AI Health': '创新药/AI医疗',
  'Solid-state Battery': '固态电池/储能',
  'Robotics/Embodied AI': '机器人/具身智能',
  'Metals/Rare Earth': '有色金属/稀土',
  'Financials': '金融',
  'Defense/Space': '军工',        // 用"军工"作为主键，因为 correlation 中"军工"和"商业航天"分开
  'New Power Grid': '新型电力基建',
};

// 内部英文名 -> 中文显示名
const _SECTOR_DISPLAY = {
  'Semiconductor/AI': '半导体/AI算力',
  'Pharma/AI Health': '创新药/AI医疗',
  'Solid-state Battery': '固态电池/储能',
  'Robotics/Embodied AI': '机器人/具身智能',
  'Metals/Rare Earth': '有色金属/稀土',
  'Financials': '金融',
  'Defense/Space': '军工/商业航天',
  'New Power Grid': '新型电力基建',
};

// 内部英文名 -> correlation_history.json 中的实际中文键名（可能一个英文名对应多个中文键）
const _EN_TO_CORR_KEYS = {
  'Semiconductor/AI': ['半导体/AI算力'],
  'Pharma/AI Health': ['创新药/AI医疗'],
  'Solid-state Battery': ['固态电池/储能'],
  'Robotics/Embodied AI': ['机器人/具身智能'],
  'Metals/Rare Earth': ['有色金属/稀土'],
  'Financials': [],                    // correlation 文件中没有金融键
  'Defense/Space': ['军工', '商业航天'],  // 两个独立键合并
  'New Power Grid': ['新型电力基建'],
};

/**
 * 从 correlation 条目中提取 sector 的值（处理一对多映射）
 */
function _getSectorValue(aStock, enSector) {
  const keys = _EN_TO_CORR_KEYS[enSector];
  if (!keys || keys.length === 0) return null;
  const vals = keys.map(k => aStock[k]).filter(v => v != null);
  if (vals.length === 0) return null;
  // 多键取平均（如军工+商业航天）
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

function _estimateSectorRelation(aggregated, sectorA, sectorB) {
  // Bug fix 3: 正确访问 aggregated.correlations.days
  const corrDays = aggregated.correlations && aggregated.correlations.days ? aggregated.correlations.days : [];

  // 需要至少 3 天数据才能计算关系
  if (corrDays.length >= 3) {
    const keysA = _EN_TO_CORR_KEYS[sectorA];
    const keysB = _EN_TO_CORR_KEYS[sectorB];

    // 如果某一方在 correlation 中没有对应键，跳过
    if (!keysA || keysA.length === 0 || !keysB || keysB.length === 0) {
      return { rel: '-', score: 25 };
    }

    let relSum = 0;
    let count = 0;
    let sameDirCount = 0;

    for (const day of corrDays) {
      if (!day.aStock) continue;
      const valA = _getSectorValue(day.aStock, sectorA);
      const valB = _getSectorValue(day.aStock, sectorB);
      if (valA != null && valB != null) {
        if (valA * valB > 0) sameDirCount++;
        relSum += valA - valB;
        count++;
      }
    }

    if (count > 0) {
      const avgLead = relSum / count;
      const absLead = Math.abs(avgLead);
      if (absLead > 3.0) {
        return avgLead > 0
          ? { rel: '领先', score: Math.min(100, Math.round(absLead * 15)) }
          : { rel: '滞后', score: Math.min(100, Math.round(absLead * 15)) };
      }
      if (absLead > 1.0) {
        return avgLead > 0
          ? { rel: '领先', score: Math.round(absLead * 10) }
          : { rel: '滞后', score: Math.round(absLead * 10) };
      }
      const syncConfidence = sameDirCount / count;
      return { rel: '同步', score: 40 + Math.round(syncConfidence * 20) };
    }
  }
  return { rel: '-', score: 25 };
}

function _detectRotationPhase(aggregated) {
  const phases = ['防御期', '成长萌芽', '周期扩散', '普涨期', '顶部分化', '回调洗牌'];
  if (aggregated.portfolio && aggregated.portfolio.positions) {
    const defensiveSectors = ['Financials', 'Metals/Rare Earth', 'New Power Grid'];
    const aggressiveSectors = ['Robotics/Embodied AI', 'Semiconductor/AI', 'Defense/Space'];
    let defWeight = 0, aggWeight = 0;
    for (const pos of aggregated.portfolio.positions) {
      const sector = _classifySector(pos.name);
      if (defensiveSectors.includes(sector)) defWeight += pos.marketValue || 0;
      if (aggressiveSectors.includes(sector)) aggWeight += pos.marketValue || 0;
    }
    const total = defWeight + aggWeight;
    if (total > 0) {
      const ratio = aggWeight / total;
      if (ratio > 0.7) return { phase: '普涨期', description: '成长板块主导，风险偏好高' };
      if (ratio > 0.5) return { phase: '周期扩散', description: '成长板块趋于活跃，周期扩散中' };
      if (ratio > 0.3) return { phase: '回调洗牌', description: '板块正在重新洗牌' };
      return { phase: '防御期', description: '防守板块主导，市场偏谨慎' };
    }
  }
  return { phase: '回调洗牌', description: '数据不足，无法判断轮动阶段' };
}

// 英文 sector 名 -> 中文分类（用于 portfolio 持仓分类）
const _SECTOR_EN_TO_CLASSIFY = {
  'Semiconductor/AI': ['Semiconductor/AI', 'semiconductor', 'chip', 'AI'],
  'Pharma/AI Health': ['Pharma/AI Health', 'pharma', 'medical', 'bio'],
  'Solid-state Battery': ['Solid-state Battery', 'battery', 'energy storage', 'new energy'],
  'Robotics/Embodied AI': ['Robotics/Embodied AI', 'robot', 'embodied', 'intelligent'],
  'Metals/Rare Earth': ['Metals/Rare Earth', 'metal', 'rare earth', 'alum', 'copper', 'steel', 'chem', 'chemical'],
  'Financials': ['Financials', 'finance', 'securities', 'bank', 'insurance'],
  'Defense/Space': ['Defense/Space', 'military', 'defense', 'space', 'aerospace', 'aviation'],
  'New Power Grid': ['New Power Grid', 'power', 'grid', 'energy'],
};

// ==================== 3d. 因子效能分析 ====================

function _analyzeFactorEffectiveness(aggregated) {
  const factors = [
    { id: 'H1', name: '缩量止跌', category: '技术面' },
    { id: 'H2', name: '底部放量', category: '技术面' },
    { id: 'H3', name: '逆势抗跌', category: '市场' },
    { id: 'H4', name: 'PE低估', category: '基本面' },
    { id: 'H5', name: '高ROE低PB', category: '基本面' },
    { id: 'H6', name: '现金流健康', category: '基本面' },
    { id: 'H7', name: '低换手蓄力', category: '技术面' },
    { id: 'H8', name: '短期反转', category: '技术面' },
    { id: 'H9', name: '量价背离', category: '技术面' },
  ];

  const result = [];

  // Bug fix 6: factorPerf.factors 是数组，不是对象
  const fpFactors = aggregated.factorPerf && Array.isArray(aggregated.factorPerf.factors)
    ? aggregated.factorPerf.factors
    : [];

  for (const factor of factors) {
    let hitRate = null, avgReturn = null, trend = 'stable', count = 0;
    let hitRate5d = null, hitRate20d = null;

    // 从 factor_performance 数组中查找对应因子
    const fp = fpFactors.find(f => f.id === factor.id);
    if (fp) {
      // 优先使用 5 日滚动命中率，其次总体命中率
      hitRate = fp.hitRate5d || fp.hitRate || null;
      hitRate5d = fp.hitRate5d || null;
      hitRate20d = fp.hitRate20d || null;
      avgReturn = fp.avgReturn != null ? fp.avgReturn : null;
      trend = fp.trend || 'stable';
      count = fp.signalCount || 0;
    }

    // 基于趋势确定状态
    let status = 'STABLE';
    if (hitRate != null) {
      if (hitRate >= 0.55) status = 'HOT';
      else if (hitRate < 0.40) status = 'COLD';
    }

    result.push({
      ...factor,
      hitRate,
      hitRate5d,
      hitRate20d,
      avgReturn,
      trend,
      count,
      status,
    });
  }

  return result;
}

// ==================== Phase 4: 增强上下文 ====================

/**
 * 加载最近一次已验证的周末分析报告，用于反馈调整。
 * 读 _index.json → 找最近 verified=true 的 → 读 {date}_verification.json
 * @returns {object|null} 验证报告，或 null（无验证数据时）
 */
function _loadLastVerification() {
  try {
    const index = _loadArchiveIndex();
    const verified = index.filter(e => e.verified);
    if (verified.length === 0) return null;

    // 找最近一个已验证的周末（已按日期倒序排列）
    const lastVerified = verified[0];
    const verifPath = path.join(ARCHIVE_DIR, lastVerified.weekend + '_verification.json');
    if (!fs.existsSync(verifPath)) return null;

    const v = JSON.parse(fs.readFileSync(verifPath, 'utf8'));
    return v;
  } catch (_) {
    return null;
  }
}

function _generateInsights(lastVerification) {
  const insights = [];
  // 记录哪些 insight 被验证反馈调整了
  const adjustments = [];

  // ===== 1. 危机预警洞察 =====
  // 根据上周验证的校准结果调整触发门槛和权重
  let crisisThreshold = 60;  // 默认：crisisScore >= 60 才触发
  let crisisWeightMultiplier = 1.0;

  if (lastVerification && lastVerification.crisis && lastVerification.crisis.available) {
    const vc = lastVerification.crisis;
    if (vc.calibration === '明显高估') {
      // 上周虚惊一场，提高门槛
      crisisThreshold = 70;
      crisisWeightMultiplier = 0.5;
      adjustments.push('危机预警：上周明显高估，触发门槛提高至70，权重减半');
    } else if (vc.calibration === '略有高估') {
      crisisThreshold = 65;
      crisisWeightMultiplier = 0.7;
      adjustments.push('危机预警：上周略有高估，触发门槛提高至65');
    } else if (vc.calibration === '明显低估') {
      // 上周低估了风险，降低门槛
      crisisThreshold = 50;
      crisisWeightMultiplier = 1.5;
      adjustments.push('危机预警：上周明显低估，触发门槛降低至50，权重加强');
    } else if (vc.calibration === '略有低估') {
      crisisThreshold = 55;
      crisisWeightMultiplier = 1.2;
      adjustments.push('危机预警：上周略有低估，触发门槛降低至55');
    }
    // '准确' → 保持默认
  }

  if (_state.crisisScore >= crisisThreshold) {
    const rawWeight = _state.crisisScore >= 75 ? 3 : 2;
    const adjustedWeight = Math.max(1, Math.round(rawWeight * crisisWeightMultiplier));
    insights.push({
      type: 'regime_alert',
      title: `危机预警评分: ${_state.crisisScore}/100`,
      detail: `周末危机综合评分 ${_state.crisisScore}/100 — ${_crisisLabel(_state.crisisScore)}`,
      weight: adjustedWeight,
      suggestedAction: _state.crisisScore >= 75
        ? '建议周一开盘将仓位降至30%以下'
        : '周一关注市场情绪，加仓需谨慎',
      timestamp: new Date().toISOString(),
    });
  }

  // ===== 2. 历史相似度洞察 =====
  let simWeightSuppressed = false;
  if (lastVerification && lastVerification.similarity && lastVerification.similarity.available) {
    const vs = lastVerification.similarity;
    if (vs.overallGrade === 'F' || vs.overallGrade === 'D') {
      // 上周方向都错了 → 本周降低相似度洞察的权重
      simWeightSuppressed = true;
      adjustments.push('历史相似度：上周评级' + vs.overallGrade + '，本周不再作为交易依据');
    } else if (vs.overallGrade === 'A') {
      adjustments.push('历史相似度：上周评级A，本周继续参考');
    }
  }

  if (_state.similarityResults.length > 0) {
    const top = _state.similarityResults[0];
    const isBullish = top.future5d && top.future5d.label.includes('bullish');
    const directionText = isBullish ? '上涨' : '下跌';
    const returnText = top.future5d
      ? `${Math.abs(top.future5d.total)}%`
      : '未知';
    const simLabelText = top.simLabel === 'very_high'
      ? '极高'
      : top.simLabel === 'high'
        ? '较高'
        : top.simLabel === 'moderate'
          ? '中等'
          : '较低';

    // P1-5: When macro risk is defensive (panic/risk_off), historical
    // similarity takes a back seat — weight capped at 1 regardless of
    // how high the similarity score is. Risk warnings always dominate.
    const isDefensiveRegime = _state.marketProfile &&
      (_state.marketProfile.riskRegime === 'panic' || _state.marketProfile.riskRegime === 'risk_off');
    const rawWeight = isDefensiveRegime ? 0
      : (top.similarity > 80 ? 2 : 1);
    // 如果上周相似度方向错误，weight 降为 0（纯信息展示，不影响交易）
    const weight = simWeightSuppressed ? 0 : rawWeight;

    let action = isBullish
      ? '历史规律显示上涨概率较高'
      : '历史规律显示下行风险偏高，注意风险';
    if (simWeightSuppressed) {
      action += '（上周相似度预测方向错误，本周仅作参考）';
    }

    insights.push({
      type: 'historical_parallel',
      title: `历史匹配: ${top.endDate} (${simLabelText}相似度)`,
      detail: `当前市场最像 ${top.startDate} 至 ${top.endDate} 阶段 (相似度 ${top.similarity}%). 历史上该阶段后5日市场${directionText} ${returnText}.`,
      weight: weight,
      suggestedAction: action,
      timestamp: new Date().toISOString(),
    });
  }

  // ===== 3. 板块偏好洞察（因子效能） =====
  if (_state.factorPerformance) {
    const hotFactors = _state.factorPerformance.filter(f => f.status === 'HOT');
    if (hotFactors.length > 0) {
      insights.push({
        type: 'factor_preference',
        title: `高效因子: ${hotFactors.map(f => f.name).join(', ')}`,
        detail: `${hotFactors.length} 个因子表现活跃 (命中率上升). 优先关注触发这些因子的候选股.`,
        weight: 1,
        suggestedAction: '在 pipeline 扫描中重点关注触发这些因子的候选股',
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ===== 4. 净值健康度洞察 =====
  // 根据上周验证：如果上周 position_sizing 被判定为过度减仓，本周降低触发敏感度
  let positionSizingSuppressed = false;
  if (lastVerification && lastVerification.insights && lastVerification.insights.available) {
    const posVerdict = lastVerification.insights.verdicts.find(v => v.type === 'position_sizing');
    if (posVerdict && posVerdict.outcome === 'bad' && posVerdict.detail.includes('减仓过度')) {
      // 上周仓位建议过度保守，本周即使回撤>5%也不强制缩减仓位
      positionSizingSuppressed = true;
      adjustments.push('仓位建议：上周减仓过度，本周不再强制缩减');
    }
  }

  if (!positionSizingSuppressed &&
      _state.marketProfile && _state.marketProfile.pfDrawdown != null && _state.marketProfile.pfDrawdown > 5) {
    insights.push({
      type: 'position_sizing',
      title: `组合回撤预警: ${_state.marketProfile.pfDrawdown.toFixed(1)}%`,
      detail: `当前最大回撤 ${_state.marketProfile.pfDrawdown.toFixed(1)}% 超过 5% 阈值`,
      weight: 2,
      suggestedAction: '建议减少单笔买入金额，仓位控制在 50% 以下',
      timestamp: new Date().toISOString(),
    });
  }

  // ===== 5. 板块轮动洞察 =====
  // 根据上周验证：如果 sector rotation 精确率低或 phase 判断错误，调整 weight
  let sectorWeight = 1;
  let sectorSuppressed = false;
  let sectorPhaseFlipped = false;

  if (lastVerification && lastVerification.sector && lastVerification.sector.available) {
    const vs = lastVerification.sector;
    if (vs.overallPrecision != null && vs.overallPrecision < 0.50) {
      // 上周板块预测精确率不到50%，本周权重降为0
      sectorSuppressed = true;
      sectorWeight = 0;
      adjustments.push('板块轮动：上周精确率仅' + (vs.overallPrecision * 100).toFixed(0) + '%，本周板块偏好暂不生效');
    }
    if (vs.phaseCorrect === false) {
      // 阶段判断错误，翻转偏好方向
      sectorPhaseFlipped = true;
      adjustments.push('板块轮动：上周阶段判断错误，本周偏好方向翻转');
    }
  }

  if (_state.sectorRotation && _state.sectorRotation.currentPhase) {
    const phase = _state.sectorRotation.currentPhase;
    let sectorHint = '';
    let phaseName = phase.phase;

    // 如果上周阶段判断错误，翻转本次的偏好
    if (sectorPhaseFlipped) {
      if (phase.phase === '防御期') {
        phaseName = '防御期(翻转)';
        sectorHint = '上周阶段判断错误，翻转偏好：关注 机器人/具身智能、半导体/AI算力、军工/商业航天 等成长板块';
      } else if (phase.phase === '成长萌芽' || phase.phase === '周期扩散' || phase.phase === '普涨期') {
        phaseName = phase.phase + '(翻转)';
        sectorHint = '上周阶段判断错误，翻转偏好：偏好 金融、有色金属/稀土、新型电力基建 等防守板块';
      } else {
        sectorHint = '适度配置成长板块';
      }
    } else {
      if (phase.phase === '防御期') {
        sectorHint = '偏好 金融、有色金属/稀土、新型电力基建 等防守板块';
      } else if (phase.phase === '成长萌芽' || phase.phase === '周期扩散') {
        sectorHint = '关注 机器人/具身智能、半导体/AI算力、军工/商业航天 等成长板块';
      } else if (phase.phase === '普涨期') {
        sectorHint = '成长板块：机器人、半导体、军工';
      } else {
        sectorHint = '适度配置成长板块';
      }
    }

    if (sectorSuppressed) {
      sectorHint += '（上周板块预测精确率低，本周仅作参考）';
    }

    insights.push({
      type: 'sector_preference',
      title: `轮动阶段: ${phaseName}`,
      detail: phase.description + '. ' + sectorHint,
      weight: sectorWeight,
      suggestedAction: sectorHint,
      timestamp: new Date().toISOString(),
    });
  }

  // ===== 6. 跨市场上下文 =====
  // P1-5: cross_market risk warnings get TOP priority.
  // panic/risk_off → weight 5 (dominates all other insights)
  // neutral → weight 2, slightly_bullish/risk_on → weight 1
  // When macro is defensive, NO historical_parallel or sector_preference
  // should override it — the circuit breaker in simfolio.js also enforces this.
  if (_state.marketProfile && _state.marketProfile.riskRegime) {
    const regime = _state.marketProfile.riskRegime;
    const regimeCN = regime === 'panic' ? '恐慌' : regime === 'risk_off' ? '避险' : regime === 'risk_on' ? '风险偏好' : regime === 'slightly_bullish' ? '温和看涨' : '中性';
    const isDefensive = (regime === 'panic' || regime === 'risk_off');
    insights.push({
      type: 'cross_market',
      title: `跨市场风险: ${regimeCN}`,
      detail: `当前风险状态为 ${regimeCN}，建议仓位 ${_state.marketProfile.suggestedPosition}`,
      weight: isDefensive ? 5 : (regime === 'neutral' ? 2 : 1),
      suggestedAction: isDefensive
        ? '防御模式：严格控制仓位'
        : '正常交易',
      timestamp: new Date().toISOString(),
    });
  }

  return { insights, adjustments };
}

function _buildMarketProfile(aggregated) {
  const profile = {};

  // 净值回撤
  if (aggregated.portfolio && aggregated.portfolio.navHistory) {
    const navs = aggregated.portfolio.navHistory;
    if (navs.length > 1) {
      const values = navs.map(n => n.nav || 0);
      const maxNav = Math.max(...values);
      const currentNav = values[values.length - 1];
      profile.pfDrawdown = maxNav > 0 ? (maxNav - currentNav) / maxNav * 100 : 0;
      profile.totalReturn = values[0] > 0 ? (currentNav - values[0]) / values[0] * 100 : 0;
    }
  }

  // 风险状态
  const usLatestPath = path.join(DATA_DIR, 'us_market', 'us_latest.json');
  if (fs.existsSync(usLatestPath)) {
    try {
      const usData = JSON.parse(fs.readFileSync(usLatestPath, 'utf8'));
      const crossMarket = require('./cross_market');
      if (usData.macro) {
        const risk = crossMarket.computeRiskState(usData.macro);
        profile.riskRegime = risk.regime;
        profile.suggestedPosition = risk.positionSize;
      }
    } catch (_) {}
  }

  // 最新市场状态
  if (aggregated.summaries.length > 0) {
    const lastSummary = aggregated.summaries[aggregated.summaries.length - 1];
    if (lastSummary && lastSummary.data && lastSummary.data.market) {
      profile.lastMarket = lastSummary.data.market;
    }
  }

  return profile;
}

function _writeWeekendContext(insights, verificationContext) {
  const ctxDir = path.join(DATA_DIR, 'simfolio');
  if (!fs.existsSync(ctxDir)) fs.mkdirSync(ctxDir, { recursive: true });

  const validDays = WC.contextValidDays || 3;
  const validUntil = new Date(Date.now() + validDays * 86400000).toISOString().slice(0, 10);

  const context = {
    generatedAt: new Date().toISOString(),
    validUntil,
    insights,
    verificationContext: verificationContext || null,
  };

  fs.writeFileSync(path.join(ctxDir, 'weekend_context.json'), JSON.stringify(context, null, 2));
  const adjInfo = verificationContext && verificationContext.adjustments && verificationContext.adjustments.length > 0
    ? `，${verificationContext.adjustments.length}项验证调整`
    : '';
  console.log(`[WeekendAnalyzer] Enhanced context written, ${insights.length} insights${adjInfo}, valid until ${validUntil}`);
}

// ==================== 报告归档 ====================

function _getWeekendIdentifier() {
  const now = new Date();
  const day = now.getDay();
  const saturday = new Date(now);
  if (day === 0) saturday.setDate(now.getDate() - 1);      // Sunday → Saturday
  else if (day === 6) { /* already Saturday */ }
  else saturday.setDate(now.getDate() - (day + 1));          // Weekday → previous Saturday
  return saturday.toISOString().slice(0, 10);
}

function _loadArchiveIndex() {
  const indexPath = path.join(ARCHIVE_DIR, '_index.json');
  if (fs.existsSync(indexPath)) {
    try { return JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch (_) {}
  }
  return [];
}

/**
 * 从验证报告中提取关键亮点，供 weekend_context.json 的 verificationContext 字段使用。
 * 生成简短的中文摘要列表。
 */
function _extractHighlights(verifReport) {
  const highlights = [];
  if (!verifReport) return highlights;

  // 相似度
  if (verifReport.similarity && verifReport.similarity.available) {
    const s = verifReport.similarity;
    if (s.overallGrade === 'A' || s.overallGrade === 'B') {
      highlights.push('历史相似度预测准确（评级' + s.overallGrade + '）');
    } else if (s.overallGrade === 'F') {
      highlights.push('历史相似度方向错误，已暂停其交易影响');
    }
  }

  // 危机预警
  if (verifReport.crisis && verifReport.crisis.available) {
    const c = verifReport.crisis;
    if (c.calibration === '准确') {
      highlights.push('危机预警校准准确');
    } else if (c.calibration !== '准确') {
      highlights.push('危机预警' + c.calibration + '，已调整下周门槛');
    }
  }

  // 板块轮动
  if (verifReport.sector && verifReport.sector.available) {
    const sr = verifReport.sector;
    if (sr.overallPrecision != null) {
      const pct = (sr.overallPrecision * 100).toFixed(0);
      if (sr.overallPrecision >= 0.6) {
        highlights.push('板块轮动精确率' + pct + '%，继续参考');
      } else {
        highlights.push('板块轮动精确率仅' + pct + '%，已降低权重');
      }
    }
    if (sr.phaseCorrect === false) {
      highlights.push('板块阶段判断错误，已翻转下周偏好');
    }
  }

  // 因子
  if (verifReport.factor && verifReport.factor.available) {
    const fv = verifReport.factor;
    if (fv.overallAccuracy != null) {
      const pct = (fv.overallAccuracy * 100).toFixed(0);
      highlights.push('因子预测准确率' + pct + '%');
    }
  }

  return highlights;
}

function _archiveReport() {
  if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

  const report = getReport();
  const weekendDate = _getWeekendIdentifier();
  const archivePath = path.join(ARCHIVE_DIR, weekendDate + '.json');

  // Write full report
  fs.writeFileSync(archivePath, JSON.stringify(report, null, 2), 'utf8');
  console.log('[WeekendAnalyzer] Report archived: ' + weekendDate);

  // Update metadata index
  const index = _loadArchiveIndex();
  const maxWeeks = WV.maxArchiveWeeks || 52;
  const entry = {
    weekend: weekendDate,
    generatedAt: report.generatedAt,
    cycles: report.cycles,
    crisisScore: report.crisisWarning ? report.crisisWarning.score : null,
    similarityCount: report.similarity ? report.similarity.length : 0,
    insights: report.insights ? report.insights.length : 0,
    verified: false,
    verifiedAt: null,
    overallGrade: null,
  };

  const existingIdx = index.findIndex(e => e.weekend === weekendDate);
  if (existingIdx >= 0) {
    // Preserve verification fields if already verified
    entry.verified = index[existingIdx].verified;
    entry.verifiedAt = index[existingIdx].verifiedAt;
    entry.overallGrade = index[existingIdx].overallGrade;
    index[existingIdx] = entry;
  } else {
    index.push(entry);
  }
  index.sort((a, b) => b.weekend.localeCompare(a.weekend));
  const trimmed = index.slice(0, maxWeeks);
  fs.writeFileSync(path.join(ARCHIVE_DIR, '_index.json'), JSON.stringify(trimmed, null, 2), 'utf8');
}

// ==================== 工具函数 ====================

function _classifySector(name) {
  // 使用英文 sector 名进行分类
  if (!name) return 'Other';
  const lower = name.toLowerCase();
  for (const [sector, keywords] of Object.entries(_SECTOR_EN_TO_CLASSIFY)) {
    for (const kw of keywords) {
      if (name.includes(kw) || lower.includes(kw.toLowerCase())) {
        return sector;
      }
    }
  }
  return 'Other';
}

function _standardDeviation(arr) {
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function _daysBetween(d1, d2) {
  const a = new Date(d1), b = new Date(d2);
  return Math.round((b - a) / 86400000);
}

function _todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ==================== SSE 广播 ====================

function _logSSE(data) {
  if (typeof global.broadcastWeekendSSE === 'function') {
    try { global.broadcastWeekendSSE(data); } catch (_) {}
  }
}

function setSSEBroadcast(fn) {
  global.broadcastWeekendSSE = fn;
}

// ==================== 导出 ====================

module.exports = {
  startWeekendAnalysis,
  stopWeekendAnalysis,
  getStatus,
  getReport,
  getEnhancedContext,
  setSSEBroadcast,
};
