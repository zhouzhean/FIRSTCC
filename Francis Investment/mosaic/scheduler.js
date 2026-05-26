/**
 * scheduler.js — 全自动量化交易调度器
 *
 * A股交易时段状态机，驱动定时 Pipeline + 持仓监控 + 风控执行。
 * 纯 Node.js 内置模块，零外部依赖。
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const config = require('./config');

const STATE_FILE = path.join(config.DATA_DIR, 'simfolio', 'scheduler_state.json');
const SC = config.SCHEDULER;

class Scheduler extends EventEmitter {
  constructor() {
    super();
    this._state = 'closed';
    this._nextTickTimer = null;
    this._opsRunning = false;       // 操作锁
    this._todayDate = '';           // 当前交易日日期
    this._events = [];              // 事件日志环形缓冲区
    this._scheduledOps = new Set(); // 今日已执行的操作（防重复）
    this._lastPipelineTime = null;
    this._lastMidScanTime = null;
    this._lastPositionCheck = null;
    this._positionAlerts = [];      // 当前活跃的风控警报
    this._positionCheckFailures = 0;// 连续失败计数
  }

  // ==================== 公开 API ====================

  start() {
    this._loadState();
    const now = new Date();
    this._todayDate = this._dateStr(now);
    this._transition(this._determineState(now), 'boot');

    // If booting after market close, refresh position prices to capture closing prices
    if (this._state === 'post_market' || this._state === 'closed') {
      this._refreshPositionPrices().catch(() => {});
    }

    this._scheduleNextTick();
    this._logEvent('scheduler_start', { state: this._state, date: this._todayDate });
  }

  stop() {
    if (this._nextTickTimer) clearTimeout(this._nextTickTimer);
    this._nextTickTimer = null;
    this._saveState();
    this._logEvent('scheduler_stop', { state: this._state });
  }

  getStatus() {
    const now = new Date();
    return {
      state: this._state,
      today: this._todayDate,
      isTradingDay: this._isTradingDay(now),
      nextTickMs: this._nextTickTime ? Math.max(0, this._nextTickTime - Date.now()) : null,
      opsRunning: this._opsRunning,
      scheduledOps: Array.from(this._scheduledOps),
      lastPipeline: this._lastPipelineTime,
      lastMidScan: this._lastMidScanTime,
      lastPositionCheck: this._lastPositionCheck,
      positionAlerts: this._positionAlerts.slice(),
      positionCheckFailures: this._positionCheckFailures,
      todayEventCount: this._events.filter(e => e.date === this._todayDate).length,
      totalEvents: this._events.length,
    };
  }

  getEvents(limit) {
    return this._events.slice(-(limit || 100));
  }

  // ==================== 时钟 ====================

  _scheduleNextTick() {
    if (this._nextTickTimer) clearTimeout(this._nextTickTimer);

    const isActive = this._state === 'morning_session' || this._state === 'afternoon_session';
    const interval = isActive ? SC.activeTickMs : SC.idleTickMs;

    this._nextTickTime = Date.now() + interval;
    this._nextTickTimer = setTimeout(() => this._tick(), interval);
  }

  _tick() {
    const now = new Date();
    const dateStr = this._dateStr(now);

    // 日期切换
    if (dateStr !== this._todayDate) {
      this._todayDate = dateStr;
      this._scheduledOps = new Set();
      this._positionAlerts = [];
      this._positionCheckFailures = 0;
      this._logEvent('new_day', { date: dateStr });
    }

    const newState = this._determineState(now);
    if (newState !== this._state) {
      this._transition(newState, 'tick');
    }

    // 活跃时段：检查是否有操作到期
    if (this._state === 'morning_session' || this._state === 'afternoon_session') {
      this._checkScheduledOps(now);
    }

    // 收盘后：执行收盘总结
    if (this._state === 'post_market' && !this._scheduledOps.has('post_market_wrapup_' + dateStr)) {
      this._runPostMarketWrapup();
    }

    // 16:00 后：生成每日盘后总结报告
    const hourNow = now.getHours();
    const isAfter4pm = hourNow >= 16;
    const summaryKey = 'daily_summary_' + dateStr;
    if (isAfter4pm && !this._scheduledOps.has(summaryKey)) {
      this._scheduledOps.add(summaryKey);
      this._runDailySummary();
    }

    this._saveState();
    this._scheduleNextTick();
  }

  // ==================== 状态机 ====================

  _determineState(now) {
    if (!this._isTradingDay(now)) return 'closed';

    const h = now.getHours();
    const m = now.getMinutes();
    const t = h * 60 + m;

    const preStart = SC.preMarketStart.hour * 60 + SC.preMarketStart.minute;
    const sessionStart = SC.morningSessionStart.hour * 60 + SC.morningSessionStart.minute;
    const sessionEnd = SC.morningSessionEnd.hour * 60 + SC.morningSessionEnd.minute;
    const afternoonStart = SC.afternoonSessionStart.hour * 60 + SC.afternoonSessionStart.minute;
    const afternoonEnd = SC.afternoonSessionEnd.hour * 60 + SC.afternoonSessionEnd.minute;
    const postEnd = SC.postMarketEnd.hour * 60 + SC.postMarketEnd.minute;

    if (t < preStart) return 'closed';
    if (t < sessionStart) return 'pre_market';
    if (t < sessionEnd) return 'morning_session';
    if (t < afternoonStart) return 'lunch_break';
    if (t < afternoonEnd) return 'afternoon_session';
    if (t < postEnd) return 'post_market';
    return 'closed';
  }

  _isTradingDay(date) {
    const d = date.getDay();
    return d >= 1 && d <= 5;
  }

  _transition(newState, reason) {
    const oldState = this._state;
    this._state = newState;
    this._logEvent('state_change', {
      from: oldState,
      to: newState,
      reason: reason,
    });

    // 进入活跃时段：重置操作锁
    if (newState === 'morning_session' || newState === 'afternoon_session') {
      this._opsRunning = false;
      this._positionCheckFailures = 0;
    }

    // 离开活跃时段：清除警报
    if (oldState === 'morning_session' || oldState === 'afternoon_session') {
      if (newState !== 'morning_session' && newState !== 'afternoon_session') {
        this._positionAlerts = [];
      }
    }

    this.emit('state_change', { from: oldState, to: newState });
    this.emit('think_state', {
      type: 'state_change',
      from: oldState,
      to: newState,
      reason: reason,
      time: new Date().toISOString(),
    });
  }

  // ==================== 调度检查 ====================

  _checkScheduledOps(now) {
    const dateStr = this._dateStr(now);
    const h = now.getHours();
    const m = now.getMinutes();

    // Full Pipeline
    for (const time of SC.fullPipelineTimes) {
      const opKey = 'full_pipeline_' + dateStr + '_' + time.hour + ':' + time.minute;
      if (!this._scheduledOps.has(opKey) && h === time.hour && m >= time.minute && m < time.minute + 5) {
        this._scheduledOps.add(opKey);
        this._runFullPipeline('scheduled_' + time.hour + ':' + String(time.minute).padStart(2, '0'));
      }
    }

    // Mid-Day Scan
    for (const time of SC.midDayScanTimes) {
      const opKey = 'mid_scan_' + dateStr + '_' + time.hour + ':' + time.minute;
      if (!this._scheduledOps.has(opKey) && h === time.hour && m >= time.minute && m < time.minute + 5) {
        this._scheduledOps.add(opKey);
        this._runMidDayScan();
      }
    }

    // Position Monitor（每N分钟）
    const interval = SC.positionMonitorIntervalMin;
    const lastCheck = this._lastPositionCheck ? new Date(this._lastPositionCheck) : null;
    const shouldCheck = !lastCheck || (now - lastCheck) >= interval * 60 * 1000;
    if (shouldCheck && !this._opsRunning) {
      this._lastPositionCheck = now.toISOString();
      this._runPositionMonitor();
    }
  }

  // ==================== 操作：Full Pipeline ====================

  async _runFullPipeline(reason) {
    if (this._opsRunning) {
      this._logEvent('pipeline_skip', { reason: 'ops_running' });
      return;
    }

    this._opsRunning = true;
    this._logEvent('pipeline_start', { reason });
    this.emit('think_scan', { type: 'scan_start', reason, time: new Date().toISOString() });

    try {
      const { Pipeline } = require('./pipeline');
      const simfolio = require('./simfolio');

      const pipeline = new Pipeline();
      pipeline.on('progress', (p) => {
        this.emit('pipeline_progress', p);
        this.emit('think_progress', { type: 'progress', ...p });
      });
      pipeline.on('enrichment', (data) => {
        this.emit('think_enrichment', { type: 'enrichment', ...data });
      });
      pipeline.on('stock_analyzed', (data) => {
        this.emit('think_stock', { type: 'stock_analyzed', ...data });
      });
      pipeline.on('factor_stats', (data) => {
        this.emit('think_stats', { type: 'factor_stats', ...data });
      });

      // 超时竞速
      const result = await Promise.race([
        pipeline.run(),
        this._timeout(SC.fullPipelineTimeoutMs, 'Full Pipeline 超时'),
      ]);

      if (!result) {
        this._logEvent('pipeline_timeout', { reason });
        this._opsRunning = false;
        return;
      }

      this._lastPipelineTime = new Date().toISOString();
      this._logEvent('pipeline_complete', {
        totalStocks: result.totalStocks,
        candidates: result.candidates,
        analyzed: result.analyzed,
        top5: (result.top5 || []).map(s => s.code + ' ' + s.name + ' ' + s.compositeScore + '分'),
        duration: result.duration,
      });
      // Persist result for think-tank initial load
      this._saveLastPipelineResult(result, 'full');

      this.emit('think_scan', {
        type: 'scan_complete',
        totalStocks: result.totalStocks,
        candidates: result.candidates,
        analyzed: result.analyzed,
        top5: (result.top5 || []).map(s => ({ code: s.code, name: s.name, score: s.compositeScore, rating: s.rating })),
        duration: result.duration,
        time: new Date().toISOString(),
      });

      // 自动交易
      try {
        const pf = simfolio.loadPortfolio();
        const tradeResult = simfolio.makeTradingDecisions(pf, result.allResults || [], result.indices || [], 'full');
        this._logEvent('trade_complete', {
          decisions: tradeResult.decisions ? tradeResult.decisions.length : 0,
          executed: tradeResult.executed ? tradeResult.executed.length : 0,
          totalValue: tradeResult.snapshot ? tradeResult.snapshot.totalValue : null,
        });

        if (tradeResult.executed && tradeResult.executed.length > 0) {
          for (const t of tradeResult.executed) {
            this._logEvent('trade_executed', {
              action: t.action,
              code: t.code,
              name: t.name,
              price: t.price,
              shares: t.shares,
              reason: t.reason,
            });
            this.emit('think_trade', {
              type: 'trade_executed',
              action: t.action,
              code: t.code,
              name: t.name,
              price: t.price,
              shares: t.shares,
              reason: t.reason,
              time: new Date().toISOString(),
            });
          }
          this.emit('trades_executed', tradeResult.executed);
        } else if (!tradeResult.decisions || tradeResult.decisions.length === 0) {
          this.emit('think_trade', {
            type: 'trade_skip',
            reason: 'no_candidates_above_threshold',
            analyzedCount: result.analyzed,
            time: new Date().toISOString(),
          });
        }
      } catch (tradeErr) {
        this._logEvent('trade_error', { error: tradeErr.message });
      }
    } catch (err) {
      this._logEvent('pipeline_error', { error: err.message, reason });
    } finally {
      this._opsRunning = false;
    }
  }

  // ==================== 操作：Mid-Day Scan ====================

  async _runMidDayScan() {
    if (this._opsRunning) {
      this._logEvent('midscan_skip', { reason: 'ops_running' });
      return;
    }

    this._opsRunning = true;
    this._logEvent('midscan_start', {});
    this.emit('think_scan', { type: 'scan_start', reason: 'mid_scan', time: new Date().toISOString() });

    try {
      const marketData = require('./collectors/market_data');
      const dragonTiger = require('./collectors/dragon_tiger');
      const northBound = require('./collectors/north_bound');
      const { computeHiddenSignals } = require('./factors/hidden_signals');
      const { computeCompositeScore } = require('./factors/composite');
      const simfolio = require('./simfolio');

      // 获取全市场数据，按成交额排序取 Top N
      const allStocks = await marketData.fetchAllStocks();
      const candidates = marketData.screenStocks(allStocks);
      const indices = await marketData.fetchIndices();
      const marketDown = indices.length > 0 && indices[0].changePercent != null && indices[0].changePercent < -0.3;

      // Lightweight enrichment: LHB + NB only
      let lhbMap, nbSentiment;
      try {
        const [lhbResult, nbFlow] = await Promise.all([
          dragonTiger.fetchLHBDailyMap().catch(() => new Map()),
          northBound.fetchNorthBoundFlow(20).catch(() => []),
        ]);
        lhbMap = lhbResult;
        nbSentiment = northBound.computeSentiment(nbFlow);
      } catch (e) {
        lhbMap = new Map();
        nbSentiment = { available: false, sentiment: 'neutral' };
      }

      // 按成交额排取 Top
      const topByTurnover = candidates
        .sort((a, b) => (b.turnover || 0) - (a.turnover || 0))
        .slice(0, SC.midScanTopCount);

      // 预评分
      const preScored = topByTurnover.map(s => ({
        ...s,
        preScore: (s.pe && s.pe > 0 && s.pe < 20 ? 20 : 0) +
                  (s.changePercent > 0 ? 10 : -5) +
                  (s.turnover > 3e8 ? 15 : 0),
      })).sort((a, b) => b.preScore - a.preScore);

      // 对 Top N 进行深析
      const deepList = preScored.slice(0, SC.midScanDeepAnalyze);
      const results = [];

      for (let i = 0; i < deepList.length; i++) {
        const stock = deepList[i];
        try {
          const klines = await marketData.fetchKline(stock.code, 10);
          const detail = await marketData.fetchStockDetail(stock.code);
          const hiddenResult = computeHiddenSignals(stock, detail, klines, marketDown);
          const lhbSignal = dragonTiger.checkLHB(stock.code, lhbMap);
          const scoreResult = computeCompositeScore(stock, detail, klines, hiddenResult, marketDown, {
            lhbSignal,
            northBoundSentiment: nbSentiment,
          });

          results.push({
            ...stock,
            klines,
            detail,
            hiddenSignals: hiddenResult.signals,
            hasStrongSignal: hiddenResult.hasStrong,
            ...scoreResult,
          });

          this.emit('think_stock', {
            type: 'stock_analyzed',
            code: stock.code,
            name: stock.name,
            index: i + 1,
            total: deepList.length,
            price: stock.price,
            changePercent: stock.changePercent,
            signals: hiddenResult.signals.map(s => ({ id: s.id, name: s.name, level: s.level })),
            signalCount: hiddenResult.signalCount,
            hiddenScore: hiddenResult.score,
            hasStrongSignal: hiddenResult.hasStrong,
            compositeScore: scoreResult.compositeScore,
            rating: scoreResult.rating,
          });
        } catch (e) {
          // skip individual stock errors in mid-scan
        }
        await this._sleep(config.API.rateLimitMs || 200);
      }

      this._lastMidScanTime = new Date().toISOString();
      this._logEvent('midscan_complete', {
        topCount: topByTurnover.length,
        deepAnalyzed: results.length,
      });
      // Persist mid-scan result for think-tank
      this._saveLastPipelineResult({ totalStocks: allStocks.length, candidates: candidates.length, analyzed: results.length, top5: results.slice(0, 5), allResults: results }, 'mid');

      this.emit('think_scan', {
        type: 'scan_complete',
        totalStocks: allStocks.length,
        candidates: candidates.length,
        analyzed: results.length,
        top5: results.slice(0, 5).map(s => ({ code: s.code, name: s.name, score: s.compositeScore, rating: s.rating })),
        duration: 0,
        time: new Date().toISOString(),
      });

      // 自动交易
      if (results.length > 0) {
        try {
          const pf = simfolio.loadPortfolio();
          const tradeResult = simfolio.makeTradingDecisions(pf, results, indices, 'mid');
          if (tradeResult.executed && tradeResult.executed.length > 0) {
            for (const t of tradeResult.executed) {
              this._logEvent('trade_executed', {
                action: t.action,
                code: t.code,
                name: t.name,
                price: t.price,
                shares: t.shares,
                reason: t.reason,
              });
              this.emit('think_trade', {
                type: 'trade_executed',
                action: t.action,
                code: t.code,
                name: t.name,
                price: t.price,
                shares: t.shares,
                reason: t.reason,
                time: new Date().toISOString(),
              });
            }
            this.emit('trades_executed', tradeResult.executed);
          } else if (!tradeResult.decisions || tradeResult.decisions.length === 0) {
            this.emit('think_trade', {
              type: 'trade_skip',
              reason: 'no_candidates_above_threshold',
              analyzedCount: results.length,
              time: new Date().toISOString(),
            });
          }
        } catch (tradeErr) {
          this._logEvent('trade_error', { error: tradeErr.message });
        }
      }
    } catch (err) {
      this._logEvent('midscan_error', { error: err.message });
    } finally {
      this._opsRunning = false;
    }
  }

  // ==================== 操作：持仓监控 ====================

  async _runPositionMonitor() {
    try {
      const marketData = require('./collectors/market_data');
      const simfolio = require('./simfolio');

      const pf = simfolio.loadPortfolio();
      if (!pf.positions || pf.positions.length === 0) {
        this._positionCheckFailures = 0;
        return; // 没有持仓，跳过
      }

      const codes = pf.positions.map(p => p.code);

      // 获取持仓股实时价格（带重试）
      let priceMap = null;
      try {
        const stocks = await Promise.race([
          marketData.fetchSpecificStocks(codes),
          this._timeout(SC.positionMonitorTimeoutMs, '持仓价格查询超时'),
        ]);
        if (stocks && stocks.length > 0) {
          priceMap = {};
          for (const s of stocks) {
            if (s && s.price != null) {
              priceMap[s.code] = s;
            }
          }
        }
      } catch (e) {
        // Tencent 失败，尝试 Sina 后备
        try {
          const sinaStocks = await Promise.race([
            marketData.fetchSpecificStocksSina(codes),
            this._timeout(SC.positionMonitorTimeoutMs, 'Sina持仓价格超时'),
          ]);
          if (sinaStocks && sinaStocks.length > 0) {
            priceMap = {};
            for (const s of sinaStocks) {
              if (s && s.price != null) {
                priceMap[s.code] = s;
              }
            }
          }
        } catch (e2) {
          this._positionCheckFailures++;
          this._logEvent('position_monitor_fetch_fail', {
            error: e.message,
            sinaError: e2.message,
            failures: this._positionCheckFailures,
          });
          return;
        }
      }

      if (!priceMap || Object.keys(priceMap).length === 0) {
        this._positionCheckFailures++;
        return;
      }

      this._positionCheckFailures = 0;

      // 更新持仓现价
      simfolio.updatePositionPrices(pf, priceMap);

      // Emit position update for think tank
      const positionUpdates = pf.positions.map(pos => {
        const marketData = priceMap[pos.code];
        const currentPrice = marketData ? marketData.price : pos.currentPrice;
        const pnl = (currentPrice - pos.avgCost) * pos.shares;
        const pnlPct = pos.avgCost > 0 ? ((currentPrice - pos.avgCost) / pos.avgCost * 100) : 0;
        return {
          code: pos.code,
          name: pos.name,
          shares: pos.shares,
          avgCost: pos.avgCost,
          currentPrice: currentPrice,
          pnl: Math.round(pnl * 100) / 100,
          pnlPct: Math.round(pnlPct * 100) / 100,
        };
      });
      this.emit('think_position', {
        type: 'position_update',
        positions: positionUpdates,
        totalValue: pf.cash + pf.positions.reduce((sum, p) => {
          const mp = priceMap[p.code];
          return sum + (mp ? mp.price : p.currentPrice) * p.shares;
        }, 0),
        cash: pf.cash,
        time: new Date().toISOString(),
      });

      // 更新移动止盈
      simfolio.updateTrailingStop(pf, priceMap);

      // 检查风控阈值
      const alerts = simfolio.checkRiskThresholds(pf, priceMap);
      this._positionAlerts = alerts;

      // 执行风控交易
      let executedCount = 0;
      for (const alert of alerts) {
        try {
          const trade = simfolio.executeRiskTrade(pf, alert, priceMap);
          if (trade) {
            executedCount++;
            this._logEvent('risk_trade', {
              action: trade.action,
              code: trade.code,
              name: trade.name,
              price: trade.price,
              reason: trade.reason,
              pnl: trade.pnl,
              pnlPct: trade.pnlPct,
            });
          }
        } catch (e) {
          this._logEvent('risk_trade_error', { alert, error: e.message });
        }
      }

      if (alerts.length > 0 || executedCount > 0) {
        this.emit('risk_alerts', { alerts, executedCount });
        for (const alert of alerts) {
          this.emit('think_alert', {
            type: 'risk_alert',
            level: alert.level || 'warning',
            code: alert.code,
            name: alert.name,
            message: alert.reason || alert.message || '',
            time: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      this._logEvent('position_monitor_error', { error: err.message });
    }
  }

  // ==================== 操作：持仓现价刷新 ====================

  async _refreshPositionPrices() {
    try {
      const simfolio = require('./simfolio');
      const marketData = require('./collectors/market_data');
      const pf = simfolio.loadPortfolio();
      if (pf.positions.length === 0) return;

      const codes = pf.positions.map(p => p.code);
      let priceMap = {};
      try {
        const stocks = await marketData.fetchSpecificStocks(codes);
        for (const s of (stocks || [])) {
          if (s && s.price != null) priceMap[s.code] = s;
        }
      } catch (e) {
        try {
          const sinaStocks = await marketData.fetchSpecificStocksSina(codes);
          for (const s of (sinaStocks || [])) {
            if (s && s.price != null) priceMap[s.code] = s;
          }
        } catch (e2) { /* both failed */ }
      }
      if (Object.keys(priceMap).length > 0) {
        simfolio.updatePositionPrices(pf, priceMap);
        this._logEvent('position_refresh', {
          codes: Object.keys(priceMap),
          reason: this._state === 'post_market' ? 'post_market_boot' : 'closed_boot',
        });
      }
    } catch (e) { /* silent */ }
  }

  // ==================== 操作：收盘总结 ====================

  async _runPostMarketWrapup() {
    const dateStr = this._todayDate;
    this._scheduledOps.add('post_market_wrapup_' + dateStr);

    try {
      const simfolio = require('./simfolio');

      // Refresh position prices to capture closing prices
      await this._refreshPositionPrices().catch(() => {});

      const pf = simfolio.loadPortfolio();
      const snap = simfolio.getSnapshot(pf);

      this._logEvent('post_market_wrapup', {
        totalValue: snap.totalValue,
        totalReturn: snap.totalReturn,
        cash: snap.cash,
        positionCount: pf.positions.length,
      });
    } catch (err) {
      this._logEvent('wrapup_error', { error: err.message });
    }
  }

  // ==================== 操作：每日盘后总结报告（16:00） ====================

  async _runDailySummary() {
    const dateStr = this._todayDate;
    this._logEvent('daily_summary_start', { date: dateStr });

    try {
      const simfolio = require('./simfolio');
      const marketData = require('./collectors/market_data');

      const pf = simfolio.loadPortfolio();
      const snap = simfolio.getSnapshot(pf);
      const stats = simfolio.computeStats(pf);

      // Get today's trades
      const todayTrades = pf.tradeHistory.filter(t => t.date === dateStr);

      // Get index data
      let indices = [];
      try {
        indices = await Promise.race([
          marketData.fetchIndices(),
          this._timeout(30000, '指数获取超时'),
        ]);
      } catch (e) { /* silent */ }

      // Get last pipeline result
      let lastResult = null;
      try {
        const resultPath = path.join(config.DATA_DIR, 'simfolio', 'last_pipeline_result.json');
        if (fs.existsSync(resultPath)) {
          lastResult = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        }
      } catch (e) { /* silent */ }

      // Get today's events
      let todayEvents = [];
      try {
        const eventsPath = path.join(config.DATA_DIR, 'events', dateStr + '.json');
        if (fs.existsSync(eventsPath)) {
          todayEvents = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
        }
      } catch (e) { /* silent */ }

      const summary = {
        date: dateStr,
        generatedAt: new Date().toISOString(),
        market: {
          indices: indices.map(i => ({
            name: i.name, code: i.code,
            price: i.price, changePercent: i.changePercent,
          })),
        },
        portfolio: {
          totalValue: snap.totalValue,
          totalReturn: snap.totalReturn,
          cash: snap.cash,
          positionValue: snap.positionValue,
          benchmarkReturn: snap.benchmarkReturn,
          alpha: snap.alpha,
          positions: snap.positions.map(p => ({
            code: p.code, name: p.name, shares: p.shares,
            avgCost: p.avgCost, currentPrice: p.currentPrice,
            pnl: p.pnl, pnlPct: p.pnlPct,
          })),
        },
        stats: {
          winRate: stats.winRate,
          maxDrawdown: stats.maxDrawdown,
          sharpeRatio: stats.sharpeRatio,
          totalTrades: stats.totalTrades,
        },
        todayTrades: todayTrades.map(t => ({
          action: t.action, code: t.code, name: t.name,
          price: t.price, shares: t.shares, amount: t.amount,
          reason: t.reason, time: t.time, date: t.date,
          pnl: t.pnl, pnlPct: t.pnlPct,
        })),
        pipeline: lastResult ? {
          type: lastResult.type,
          analyzed: lastResult.analyzed,
          avgScore: lastResult.avgScore,
          maxScore: lastResult.maxScore,
          top5: lastResult.top5 || [],
          scoreDistribution: lastResult.scoreDistribution,
        } : null,
        eventCount: todayEvents.length,
        scanCount: todayEvents.filter(e => e.type === 'pipeline_complete' || e.type === 'midscan_complete').length,
        tradeCount: todayTrades.length,
      };

      // Save summary
      const summaryDir = path.join(config.DATA_DIR, 'summaries');
      if (!fs.existsSync(summaryDir)) fs.mkdirSync(summaryDir, { recursive: true });
      const summaryPath = path.join(summaryDir, dateStr + '.json');
      fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

      this._logEvent('daily_summary_complete', {
        totalValue: snap.totalValue,
        tradeCount: todayTrades.length,
        topScore: lastResult ? lastResult.maxScore : null,
      });

      // 广播到 SSE 客户端
      this.emit('think_scan', {
        type: 'daily_summary',
        summary: summary,
        time: new Date().toISOString(),
      });
    } catch (err) {
      this._logEvent('daily_summary_error', { error: err.message });
    }
  }

  // ==================== 持久化 Pipeline 结果 ====================

  _saveLastPipelineResult(result, type) {
    try {
      const dir = path.join(config.DATA_DIR, 'simfolio');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const allResults = result.allResults || [];
      const dist = { lt50: 0, r50_60: 0, r60_70: 0, r70_80: 0, gt80: 0 };
      const signalCounts = {};
      for (const r of allResults) {
        const s = r.compositeScore || 0;
        if (s < 50) dist.lt50++;
        else if (s < 60) dist.r50_60++;
        else if (s < 70) dist.r60_70++;
        else if (s < 80) dist.r70_80++;
        else dist.gt80++;

        if (r.hiddenSignals) {
          for (const sig of r.hiddenSignals) {
            signalCounts[sig.id] = (signalCounts[sig.id] || 0) + 1;
          }
        }
      }

      const summary = {
        type: type || 'full',
        date: this._todayDate,
        time: new Date().toISOString(),
        totalStocks: result.totalStocks || 0,
        candidates: result.candidates || 0,
        analyzed: result.analyzed || 0,
        duration: result.duration || 0,
        top5: (result.top5 || []).map(s => ({
          code: s.code, name: s.name, score: s.compositeScore, rating: s.rating,
        })),
        scoreDistribution: dist,
        signalCounts: signalCounts,
        avgScore: allResults.length > 0
          ? Math.round(allResults.reduce((a, r) => a + (r.compositeScore || 0), 0) / allResults.length)
          : 0,
        maxScore: allResults.length > 0
          ? Math.max(...allResults.map(r => r.compositeScore || 0))
          : 0,
      };

      const filePath = path.join(dir, 'last_pipeline_result.json');
      fs.writeFileSync(filePath, JSON.stringify(summary, null, 2), 'utf8');
    } catch (e) {
      // 静默失败
    }
  }

  // ==================== 事件日志 ====================

  _logEvent(type, detail) {
    const event = {
      time: new Date().toISOString(),
      date: this._todayDate,
      state: this._state,
      type,
      detail,
    };

    this._events.push(event);
    if (this._events.length > SC.eventLogMaxSize) {
      this._events = this._events.slice(-SC.eventLogMaxSize);
    }

    this.emit('event', event);

    // 重要事件也输出到控制台
    const importantTypes = [
      'pipeline_complete', 'pipeline_error', 'pipeline_timeout',
      'trade_executed', 'risk_trade', 'trade_error',
      'state_change', 'position_monitor_fetch_fail',
      'scheduler_start', 'scheduler_stop', 'position_refresh',
    ];
    if (importantTypes.includes(type)) {
      const ts = new Date().toTimeString().slice(0, 8);
      console.log('  [Scheduler ' + ts + '] ' + type + ':', JSON.stringify(detail));
    }
  }

  // ==================== 状态持久化 ====================

  _saveState() {
    try {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const state = {
        state: this._state,
        todayDate: this._todayDate,
        scheduledOps: Array.from(this._scheduledOps),
        lastPipelineTime: this._lastPipelineTime,
        lastMidScanTime: this._lastMidScanTime,
        lastPositionCheck: this._lastPositionCheck,
        positionCheckFailures: this._positionCheckFailures,
        savedAt: new Date().toISOString(),
      };

      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
      // 静默失败，不影响运行
    }
  }

  _loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

        // 只在同一天恢复上下文
        const today = this._dateStr(new Date());
        if (raw.todayDate === today) {
          this._state = raw.state || 'closed';
          this._scheduledOps = new Set(raw.scheduledOps || []);
          this._lastPipelineTime = raw.lastPipelineTime || null;
          this._lastMidScanTime = raw.lastMidScanTime || null;
          this._lastPositionCheck = raw.lastPositionCheck || null;
          this._positionCheckFailures = raw.positionCheckFailures || 0;
        }

        // 恢复后重新评估当前状态
        const now = new Date();
        const actualState = this._determineState(now);
        if (actualState !== this._state) {
          this._state = actualState;
        }
      }
    } catch (e) {
      // 文件损坏，从头开始
      this._state = 'closed';
    }
  }

  // ==================== 工具函数 ====================

  _dateStr(date) {
    return date.toISOString().slice(0, 10);
  }

  _timeout(ms, msg) {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(msg)), ms);
    });
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { Scheduler };
