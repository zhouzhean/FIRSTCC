/**
 * pipeline.js — Mosaic 量化分析主流程
 *
 * 步骤：
 *   1. 采集全市场行情 → 筛选候选股票
 *   2. 采集指数数据 → 判断市场方向
 *   3. 对候选股计算隐藏因子 + 综合评分
 *   4. 排序 → 按板块分配 → 生成 TOP5
 *   5. 输出报告数据文件
 *
 * 通过 EventEmitter 报告进度，供 API 轮询。
 */
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const marketData = require('./collectors/market_data');
const capitalFlow = require('./collectors/capital_flow');
const dragonTiger = require('./collectors/dragon_tiger');
const northBound = require('./collectors/north_bound');
const hiddenSignals = require('./factors/hidden_signals');
const composite = require('./factors/composite');
const config = require('./config');

class Pipeline extends EventEmitter {
  constructor() {
    super();
    this.status = 'idle';    // idle | running | done | error
    this.progress = 0;       // 0-100
    this.step = '';
    this.result = null;
    this.error = null;
    this.startTime = null;
  }

  _setProgress(progress, step) {
    this.progress = progress;
    this.step = step;
    this.emit('progress', { progress, step });
  }

  /**
   * Main entry point. Runs the full pipeline.
   */
  async run(options = {}) {
    if (this.status === 'running') {
      throw new Error('Pipeline already running');
    }

    this.status = 'running';
    this.progress = 0;
    this.error = null;
    this.result = null;
    this.startTime = new Date();

    try {
      this._setProgress(5, '正在连接东方财富API...');

      // === Step 1: Fetch all stocks ===
      this._setProgress(10, '正在获取全市场股票数据...');
      const allStocks = await marketData.fetchAllStocks();
      this._setProgress(25, '已获取 ' + allStocks.length + ' 只股票');

      // === Step 2: Screen candidates ===
      this._setProgress(30, '正在筛选候选股票（价格<' + config.FILTER.maxPrice + '元, 成交额>1亿）...');
      const candidates = marketData.screenStocks(allStocks, config.FILTER);
      this._setProgress(40, '筛选出 ' + candidates.length + ' 只候选股票');

      // === Step 3: Fetch market indices ===
      this._setProgress(45, '正在获取大盘指数...');
      const indices = await marketData.fetchIndices();
      const marketDown = indices.length > 0 && (indices[0].changePercent || 0) < -0.3;

      // === Step 3b: Fetch enrichment data (LHB, sector flow, north-bound) ===
      this._setProgress(47, '正在获取龙虎榜+板块资金流+北向资金...');
      const [lhbMap, sectorFlows, nbFlowData] = await Promise.all([
        dragonTiger.fetchLHBDailyMap().catch(() => new Map()),
        capitalFlow.fetchSectorFlow().catch(() => []),
        northBound.fetchNorthBoundFlow(20).catch(() => []),
      ]);

      // Build sector flow map
      const sectorFlowMap = new Map();
      for (const s of sectorFlows) {
        sectorFlowMap.set(s.code, s);
      }

      // Compute north-bound sentiment
      const nbSentiment = northBound.computeSentiment(nbFlowData);

      this._setProgress(49, '龙虎榜:' + lhbMap.size + '只 板块:' + sectorFlows.length + '个 北向:' + (nbSentiment.available ? nbSentiment.sentiment : 'N/A'));

      this.emit('enrichment', {
        lhbCount: lhbMap.size,
        sectorCount: sectorFlows.length,
        nbSentiment: nbSentiment.available ? nbSentiment.sentiment : 'N/A',
        nbAvailable: nbSentiment.available,
        topSectors: sectorFlows.slice(0, 5).map(s => ({
          name: s.name || s.code,
          netFlow: s.majorNetFlow || 0,
        })),
      });

      // === Step 4: Sort by preliminary score and take top N for detail ===
      // Pre-score using available fields for ranking
      const preScored = candidates.map(s => ({
        ...s,
        preScore: (s.pe && s.pe > 0 && s.pe < 20 ? 20 : 0) +
                  (s.changePercent > 0 ? 10 : -5) +
                  (s.turnover > 3e8 ? 15 : 0),
      })).sort((a, b) => b.preScore - a.preScore);

      const topCount = Math.min(config.API.maxDetailFetches, preScored.length);
      const finalists = preScored.slice(0, topCount);

      this._setProgress(50, '正在为前 ' + finalists.length + ' 只股票计算量化指标...');

      // === Step 5: Compute factors for each finalist ===
      const results = [];
      for (let i = 0; i < finalists.length; i++) {
        const stock = finalists[i];
        const progress = 50 + Math.round((i / finalists.length) * 35);

        if (i % 5 === 0) {
          this._setProgress(progress, '分析中: ' + stock.name + ' (' + stock.code + ') [' + (i + 1) + '/' + finalists.length + ']');
        }

        // Fetch K-line data for richer analysis
        let klines = [];
        try {
          klines = await marketData.fetchKline(stock.code, 10);
        } catch (e) {
          // K-line fetch failed, continue without it
        }

        // Fetch stock detail for fundamental scoring (ROE, debt ratio, profit growth, etc.)
        let detail = null;
        try {
          detail = await marketData.fetchStockDetail(stock.code);
        } catch (e) {
          // Detail fetch failed, continue without it
        }

        // Compute hidden signals (with fundamental data for H4, H5, H6, H8, H9)
        const hiddenResult = hiddenSignals.computeHiddenSignals(stock, detail, klines, marketDown);

        // Build enrichment context for this stock
        const lhbSignal = dragonTiger.checkLHB(stock.code, lhbMap);
        const ctx = {
          sectorFlowMap,
          lhbSignal,
          northBoundSentiment: nbSentiment,
        };

        // Compute composite score with full context
        const scoreResult = composite.computeCompositeScore(stock, detail, klines, hiddenResult, marketDown, ctx);

        const stockResult = {
          code: stock.code,
          name: stock.name,
          price: stock.price,
          changePercent: stock.changePercent,
          pe: stock.peTTM || stock.pe,
          pb: stock.pb,
          turnover: stock.turnover,
          turnoverRate: stock.turnoverRate,
          marketCap: stock.circCap,
          ...scoreResult,
          hiddenSignals: hiddenResult.signals,
          hiddenScore: hiddenResult.score,
          hasStrongSignal: hiddenResult.hasStrong,
          detail: detail,
          klines: klines,
        };
        results.push(stockResult);

        this.emit('stock_analyzed', {
          code: stock.code,
          name: stock.name,
          index: i + 1,
          total: finalists.length,
          price: stock.price,
          changePercent: stock.changePercent,
          pe: stock.peTTM || stock.pe,
          signals: hiddenResult.signals.map(s => ({ id: s.id, name: s.name, level: s.level })),
          signalCount: hiddenResult.signalCount,
          hiddenScore: hiddenResult.score,
          hasStrongSignal: hiddenResult.hasStrong,
          compositeScore: stockResult.compositeScore,
          rating: stockResult.rating,
          dimensions: {
            fundamental: stockResult.fundamentalScore,
            technical: stockResult.technicalScore,
            hidden: stockResult.hiddenScore,
            capitalFlow: stockResult.capitalFlowScore,
            event: stockResult.eventScore,
          },
        });

        // Rate limit
        if (i < finalists.length - 1) {
          await delay(config.API.rateLimitMs);
        }
      }

      // === Step 6: Sort by composite score ===
      results.sort((a, b) => b.compositeScore - a.compositeScore);

      // === Step 7: Assign sectors and build per-sector picks ===
      this._setProgress(88, '正在按板块分配推荐...');
      const sectorPicks = assignSectors(results);

      // Emit factor statistics
      const signalCounts = {};
      for (const r of results) {
        for (const s of (r.hiddenSignals || [])) {
          signalCounts[s.id] = (signalCounts[s.id] || 0) + 1;
        }
      }
      const dist = { lt50: 0, r50_60: 0, r60_70: 0, r70_80: 0, gt80: 0 };
      for (const r of results) {
        const s = r.compositeScore || 0;
        if (s < 50) dist.lt50++;
        else if (s < 60) dist.r50_60++;
        else if (s < 70) dist.r60_70++;
        else if (s < 80) dist.r70_80++;
        else dist.gt80++;
      }
      this.emit('factor_stats', {
        signalCounts,
        scoreDistribution: dist,
        totalAnalyzed: results.length,
        avgScore: results.length > 0 ? Math.round(results.reduce((a, r) => a + (r.compositeScore || 0), 0) / results.length) : 0,
        maxScore: results.length > 0 ? Math.max(...results.map(r => r.compositeScore || 0)) : 0,
      });

      // === Step 8: Build TOP5 ===
      const top5 = results.slice(0, 5).map((r, i) => ({
        rank: i + 1,
        name: r.name,
        code: r.code,
        price: r.price,
        pe: r.pe != null ? String(r.pe) : '亏损',
        risk: r.compositeScore >= 75 ? '低' : r.compositeScore >= 60 ? '中' : '高',
        riskClass: r.compositeScore >= 75 ? 'up' : r.compositeScore >= 60 ? 'flat' : 'down',
        suggestedPosition: r.compositeScore >= 80 ? '10-15%' : r.compositeScore >= 65 ? '5-10%' : '<5%',
        oneLiner: r.hiddenSignals.map(s => s.name).join('+') || r.rating + '级量化评分',
        fullLogic: buildStockLogic(r),
        borderColor: ['#FFD700', '#C0C0C0', '#CD7F32', '#8B7355', '#5a6a80'][i],
        compositeScore: r.compositeScore,
        rating: r.rating,
      }));

      // === Step 9: Build output ===
      this._setProgress(95, '正在生成报告数据...');

      const reportDate = new Date().toISOString().slice(0, 10);
      const result = {
        date: reportDate,
        indices: indices,
        marketDown: marketDown,
        totalStocks: allStocks.length,
        candidates: candidates.length,
        analyzed: finalists.length,
        sectorPicks: sectorPicks,
        top5: top5,
        allResults: results,
        duration: Math.round((Date.now() - this.startTime) / 1000),
      };

      this._setProgress(100, '分析完成！共分析 ' + finalists.length + ' 只股票，用时 ' + result.duration + ' 秒');

      this.status = 'done';
      this.result = result;
      this.emit('done', result);

      return result;
    } catch (e) {
      this.status = 'error';
      this.error = e.message;
      this.emit('error', e);
      throw e;
    }
  }

  getStatus() {
    return {
      status: this.status,
      progress: this.progress,
      step: this.step,
      error: this.error,
      result: this.result ? {
        date: this.result.date,
        candidates: this.result.candidates,
        analyzed: this.result.analyzed,
        top5: this.result.top5,
        duration: this.result.duration,
      } : null,
      startTime: this.startTime ? this.startTime.toISOString() : null,
    };
  }
}

// ---- Helpers ----

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Assign stocks to the 8 tracked sectors.
 * Simple keyword-based sector classification.
 */
function assignSectors(results) {
  const sectorKeywords = {
    '机器人/具身智能': ['机器人', '智能', '减速器', '电机', '伺服', '驱动的', '传感', '运动控制', '自动化'],
    '创新药/AI医疗': ['药', '医疗', '医', '生物', '基因', '细胞', '疫苗', '诊断', '试剂'],
    '半导体/AI算力': ['半导体', '芯片', '电子', '光电', '封测', '晶圆', '硅', '算力', '存储'],
    '商业航天': ['航天', '卫星', '航空', '火箭', '军工电子', '雷达', '导航'],
    '固态电池/储能': ['电池', '储能', '锂', '电解', '正极', '负极', '新能源', '光伏', '风电'],
    '有色金属/稀土': ['有色', '稀土', '矿', '铝', '铜', '钢', '金属', '材料', '磁'],
    '新型电力基建': ['电力', '电网', '特高压', '电缆', '电气', '充电桩', '能源', '配电'],
    '军工': ['军工', '弹药', '装备', '船舶', '电磁', '武器', '防务'],
  };

  const picks = {};
  const assigned = new Set();

  for (const [sector, keywords] of Object.entries(sectorKeywords)) {
    picks[sector] = [];
    for (const r of results) {
      if (assigned.has(r.code)) continue;
      const name = r.name;
      if (keywords.some(kw => name.includes(kw))) {
        picks[sector].push(r);
        assigned.add(r.code);
        if (picks[sector].length >= 2) break; // 2 per sector
      }
    }
  }

  // Fill any sector with < 2 stocks from unassigned
  for (const [sector, stocks] of Object.entries(picks)) {
    while (stocks.length < 2) {
      const unassigned = results.find(r => !assigned.has(r.code));
      if (!unassigned) break;
      stocks.push(unassigned);
      assigned.add(unassigned.code);
    }
  }

  return picks;
}

function buildStockLogic(r) {
  const parts = [];
  if (r.hiddenSignals && r.hiddenSignals.length > 0) {
    parts.push('隐藏信号: ' + r.hiddenSignals.map(s => s.name + '(' + s.level + ')').join(', '));
  }
  parts.push('综合评分: ' + r.compositeScore + '分 (' + r.rating + '级)');
  if (r.pe != null && r.pe > 0) parts.push('PE: ' + r.pe.toFixed(1));
  if (r.pb != null) parts.push('PB: ' + r.pb.toFixed(2));
  parts.push('成交额: ' + (r.turnover / 1e8).toFixed(2) + '亿');
  return parts.join(' | ');
}

module.exports = { Pipeline };
