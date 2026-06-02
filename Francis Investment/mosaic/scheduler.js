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
const { IndexRecorder } = require('./collectors/index_recorder');

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
    this._indexRecorder = new IndexRecorder();
    this._lastMidScanTime = null;
    this._lastPositionCheck = null;
    this._positionAlerts = [];      // 当前活跃的风控警报
    this._positionCheckFailures = 0;// 连续失败计数
    this._usDataToday = [];         // 美股当日分钟线数据
    this._lastUSRecord = null;      // 上次美股记录时间
    this._usOpsRunning = false;     // 美股操作锁
    this._weekendAnalysisRunning = false; // 周末分析运行标记
    this._broadcastSSE = null;      // SSE 广播函数引用
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
    if (this._indexRecorder) this._indexRecorder.stop();
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

  /** Set SSE broadcast function (called by mosaic_server) */
  setSSEBroadcast(fn) {
    this._broadcastSSE = fn;
    // Also propagate to weekend analyzer if available
    try {
      const weekendAnalyzer = require('./analysis/weekend_analyzer');
      weekendAnalyzer.setSSEBroadcast(fn);
    } catch (_) {}
  }

  // ==================== 时钟 ====================

  _scheduleNextTick() {
    if (this._nextTickTimer) clearTimeout(this._nextTickTimer);

    const isActive = this._state === 'morning_session' || this._state === 'afternoon_session';
    let interval;
    if (isActive) {
      interval = SC.activeTickMs;
    } else if (this._isUSMarketActive()) {
      interval = 60000; // 60s during US market hours
    } else {
      interval = SC.idleTickMs;
    }

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

    // US Market: record intraday data during US active hours
    if (this._isUSMarketActive(now)) {
      const usKey = 'us_record_' + dateStr + '_' + String(now.getMinutes()).padStart(2, '0');
      const lastRec = this._lastUSRecord;
      const shouldRecord = !lastRec || (now - lastRec) >= 55000; // ~60s
      if (shouldRecord && !this._usOpsRunning) {
        this._lastUSRecord = now;
        this._recordUSMarkets(dateStr);
      }
    }

    // US Market: 5:00 AM generate overnight summary
    if (hourNow === 5 && !this._scheduledOps.has('us_summary_' + dateStr)) {
      this._scheduledOps.add('us_summary_' + dateStr);
      this._runOvernightSummary(dateStr);
    }

    // 周末深度分析：周六/周日全天运行
    if (this._isWeekend(now) && !this._weekendAnalysisRunning) {
      this._startWeekendAnalysis();
    } else if (!this._isWeekend(now) && this._weekendAnalysisRunning) {
      this._stopWeekendAnalysis();
    }

    // 周五 15:30 后：触发周末分析验证
    const VConfig = config.WEEKEND_VERIFICATION || {};
    const vHour = (VConfig.verificationSchedule && VConfig.verificationSchedule.hour) || 15;
    const vMinute = (VConfig.verificationSchedule && VConfig.verificationSchedule.minute) || 30;
    if (now.getDay() === 5 && hourNow === vHour && now.getMinutes() >= vMinute &&
        !this._scheduledOps.has('weekend_verification_' + dateStr)) {
      this._scheduledOps.add('weekend_verification_' + dateStr);
      this._runWeekendVerification();
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

  _isWeekend(date) {
    if (!date) date = new Date();
    const d = date.getDay();
    return d === 0 || d === 6;
  }

  _startWeekendAnalysis() {
    if (this._weekendAnalysisRunning) return;
    try {
      const weekendAnalyzer = require('./analysis/weekend_analyzer');
      // Inject SSE broadcast function
      if (typeof this._broadcastSSE === 'function') {
        weekendAnalyzer.setSSEBroadcast(this._broadcastSSE);
      }
      weekendAnalyzer.startWeekendAnalysis();
      this._weekendAnalysisRunning = true;
      this._logEvent('weekend_analysis_start', { date: this._todayDate });
      console.log('[Scheduler] 周末深度分析已启动');
    } catch (e) {
      console.error('[Scheduler] 启动周末分析失败:', e.message);
    }
  }

  _stopWeekendAnalysis() {
    if (!this._weekendAnalysisRunning) return;
    try {
      const weekendAnalyzer = require('./analysis/weekend_analyzer');
      weekendAnalyzer.stopWeekendAnalysis();
      this._weekendAnalysisRunning = false;
      this._logEvent('weekend_analysis_stop', { date: this._todayDate });
      console.log('[Scheduler] 周末深度分析已停止');
    } catch (e) {
      console.error('[Scheduler] 停止周末分析失败:', e.message);
    }
  }

  async _runWeekendVerification() {
    console.log('[Scheduler] 周五盘后: 触发周末分析验证...');
    try {
      const verifier = require('./analysis/weekend_verifier');
      const results = await verifier.verifyAllPending();
      const successCount = results.filter(r => r.ok).length;
      console.log('[Scheduler] 周末分析验证完成: ' + successCount + '/' + results.length + ' 成功');
      this._logEvent('weekend_verification', {
        date: this._todayDate,
        totalArchives: results.length,
        verified: successCount,
      });

      // Broadcast via SSE if available
      if (typeof this._broadcastSSE === 'function') {
        this._broadcastSSE({
          type: 'weekend_verification',
          message: '周末分析验证完成',
          verified: successCount,
          total: results.length,
        });
      }
    } catch (e) {
      console.error('[Scheduler] 周末分析验证失败:', e.message);
      this._logEvent('weekend_verification_error', { date: this._todayDate, error: e.message });
    }
  }

  /** Check if US market is currently in regular trading (21:30-04:00 CST on weekdays). */
  _isUSMarketActive(now) {
    if (!now) now = new Date();
    const day = now.getDay();
    if (day === 0 || day === 6) return false; // US market closed weekends
    // US extended hours including pre-market (4AM ET) and post-market (8PM ET):
    // EDT (UTC-4): pre=16:00 CST, regular=21:30 CST, post ends=05:00 CST next day
    // EST (UTC-5): pre=17:00 CST, regular=22:30 CST, post ends=06:00 CST next day
    // Active window: 16:00 - 06:00 CST (covers both DST and non-DST)
    const h = now.getHours();
    const m = now.getMinutes();
    const t = h * 60 + m;
    // US closes Friday 4PM ET → post-market ends Sat ~5-6AM CST
    const isFriNight = day === 5 && h >= 21;
    if (isFriNight) return false;
    // Sunday before 16:00 CST: US weekend
    const isSunBefore = day === 0 && h < 16;
    if (isSunBefore) return false;
    return t >= 16 * 60 || t < 6 * 60;
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

    // Index recorder: start during trading states, stop otherwise
    if (newState === 'morning_session' || newState === 'afternoon_session') {
      if (!this._indexRecorder.isRunning) {
        this._indexRecorder.start();
      }
    } else {
      if (this._indexRecorder.isRunning) {
        this._indexRecorder.stop();
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

      // Emit factor performance after scan
      try {
        const factorPerf = require('./analysis/factor_performance');
        const signalCounts = {};
        if (result.allResults) {
          for (const r of result.allResults) {
            const sigs = r.hiddenSignals || r.signals || [];
            for (const s of sigs) {
              signalCounts[s.id] = (signalCounts[s.id] || 0) + 1;
            }
          }
        }
        factorPerf.updatePerformanceCache(this._todayDate, signalCounts, result.analyzed);

        // Record north-bound sentiment for performance tracking
        // This data feeds back into composite.js — if NB proves unreliable, its weight is reduced
        if (result.nbSentiment && result.nbSentiment.available) {
          try {
            factorPerf.updateNBSentimentRecord(this._todayDate, result.nbSentiment.sentiment);
          } catch (_) {}
        }

        const perf = factorPerf.computeFactorPerformance({ days: 20 });
        this.emit('think_factor_perf', perf);
      } catch (_) {}

      // 自动交易
      try {
        const pf = simfolio.loadPortfolio();
        const crossMarket = require('./analysis/cross_market');
        const macroContext = { riskState: crossMarket.getCachedRiskState() };
        const tradeResult = simfolio.makeTradingDecisions(pf, result.allResults || [], result.indices || [], 'full', macroContext);
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

      // 预评分 — 使用增强的8维评分（与Full Pipeline一致）
      const preScored = topByTurnover.map(s => {
        let score = 0;
        // 1. PE估值
        const pe = s.peTTM || s.pe;
        if (pe && pe > 0 && pe < 12) score += 25;
        else if (pe && pe > 0 && pe < 18) score += 18;
        else if (pe && pe > 0 && pe < 25) score += 10;
        else if (pe && pe > 0 && pe < 40) score += 3;
        else if (!pe) score += 8;
        else score -= 3;
        // 2. PB
        if (s.pb && s.pb > 0 && s.pb < 1.0) score += 10;
        else if (s.pb && s.pb > 0 && s.pb < 2.0) score += 5;
        // 3. 动量
        const chg = s.changePercent || 0;
        if (chg > 1 && chg < 5) score += 12;
        else if (chg > 0 && chg <= 1) score += 6;
        else if (chg > -1 && chg <= 0) score += 2;
        else if (chg > -3) score -= 2;
        else score -= 5;
        // 4. 流动性
        const to = s.turnover || 0;
        if (to > 5e8) score += 20;
        else if (to > 2e8) score += 14;
        else if (to > 1e8) score += 8;
        // 5. 换手率
        const tr = s.turnoverRate || 0;
        if (tr >= 1 && tr <= 5) score += 8;
        else if (tr > 0.5 && tr < 1) score += 4;
        // 6. 振幅
        const ampl = s.amplitude || 0;
        if (ampl > 2 && ampl < 6) score += 5;
        else if (ampl >= 1 && ampl <= 2) score += 2;
        // 7. 资金流
        if (s.majorNetFlow != null && to > 0) {
          const fr = s.majorNetFlow / to;
          if (fr > 0.05) score += 10;
          else if (fr > 0.02) score += 6;
          else if (fr > 0) score += 3;
          else if (fr < -0.05) score -= 8;
        }
        // 8. 流通市值
        const cmv = s.circCap || 0;
        if (cmv > 2e9 && cmv < 5e10) score += 5;
        return { ...s, preScore: score };
      }).sort((a, b) => b.preScore - a.preScore);

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

      // Record north-bound sentiment for mid-scan too
      if (nbSentiment && nbSentiment.available) {
        try {
          const factorPerf = require('./analysis/factor_performance');
          factorPerf.updateNBSentimentRecord(this._todayDate, nbSentiment.sentiment);
        } catch (_) {}
      }

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
          const crossMarket = require('./analysis/cross_market');
          const macroContext = { riskState: crossMarket.getCachedRiskState() };
          const tradeResult = simfolio.makeTradingDecisions(pf, results, indices, 'mid', macroContext);
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

      // Get today's trades (with analysisContext preserved)
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

      // === NEW: Collect financial news ===
      let newsData = null;
      try {
        const newsCollector = require('./collectors/news_collector');
        newsData = await Promise.race([
          newsCollector.fetchDailyNews(),
          this._timeout(config.NEWS ? config.NEWS.fetchTimeoutMs || 20000 : 20000, '新闻采集超时'),
        ]);
      } catch (e) {
        this._logEvent('news_collection_error', { error: e.message });
        newsData = { items: [], count: 0, generatedAt: null, error: e.message };
      }

      // === NEW: Generate quant trade analysis ===
      let analysisData = null;
      try {
        const quantReport = require('./analysis/quant_report');
        const knowledgeBase = require('./analysis/knowledge_base');
        let priorKnowledge = [];
        try {
          priorKnowledge = knowledgeBase.loadRecentPatterns(5);
        } catch (e) { /* ignore */ }

        analysisData = quantReport.buildTradeAnalysis(
          dateStr, pf, lastResult, todayTrades, indices,
          todayEvents, (newsData && newsData.items) || [], priorKnowledge
        );
      } catch (e) {
        this._logEvent('analysis_error', { error: e.message });
        analysisData = { date: dateStr, generatedAt: null, error: e.message };
      }

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
          analysisContext: t.analysisContext || null,
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
        // === NEW fields ===
        news: (function() {
          var n = newsData || { items: [], count: 0, generatedAt: null };
          if (analysisData && analysisData.newsImpact) {
            n.impact = analysisData.newsImpact;
          }
          return n;
        })(),
        tradeAnalysis: analysisData || { date: dateStr, generatedAt: null },
      };

      // Save summary
      const summaryDir = path.join(config.DATA_DIR, 'summaries');
      if (!fs.existsSync(summaryDir)) fs.mkdirSync(summaryDir, { recursive: true });
      const summaryPath = path.join(summaryDir, dateStr + '.json');
      fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

      // === NEW: Persist to knowledge base for self-growth ===
      try {
        const knowledgeBase = require('./analysis/knowledge_base');
        if (analysisData && (analysisData.tradesAnalysis && analysisData.tradesAnalysis.length > 0 ||
            analysisData.marketNarrative && analysisData.marketNarrative.narrative)) {
          knowledgeBase.saveDailyAnalysis(analysisData, summary);
          this._logEvent('knowledge_saved', { date: dateStr });
        }
      } catch (e) {
        this._logEvent('knowledge_save_error', { error: e.message });
      }

      this._logEvent('daily_summary_complete', {
        totalValue: snap.totalValue,
        tradeCount: todayTrades.length,
        topScore: lastResult ? lastResult.maxScore : null,
        newsCount: newsData ? newsData.count : 0,
        analysisGenerated: !!analysisData,
      });

      // Record cross-market correlation snapshot (US ETF → A-stock sector)
      try {
        const crossMarket = require('./analysis/cross_market');
        crossMarket.recordDailyCorrelationSnapshot(dateStr).catch(function() {});
      } catch (e) { /* silent */ }

      // Broadcast to SSE clients
      this.emit('think_scan', {
        type: 'daily_summary',
        summary: summary,
        time: new Date().toISOString(),
      });
    } catch (err) {
      this._logEvent('daily_summary_error', { error: err.message });
    }
  }

  // ==================== 操作：美股记录 ====================

  async _recordUSMarkets(dateStr) {
    if (this._usOpsRunning) return;
    this._usOpsRunning = true;

    try {
      const usMarket = require('./collectors/us_market');
      const data = await Promise.race([
        usMarket.fetchAllUSMonitors(),
        this._timeout(45000, '美股采集超时'),
      ]);

      if (!data) { this._usOpsRunning = false; return; }

      // Strip heavy nested objects for storage (keep only essentials)
      const point = {
        time: new Date().toISOString(),
        status: data.status,
        indices: (data.indices || []).map(q => ({ s: q.symbol, p: q.price, cp: q.changePercent })),
        macro: (data.macro || []).map(q => ({ s: q.symbol, p: q.price, cp: q.changePercent })),
      };

      this._usDataToday.push(point);
      // Keep max 500 points per day (~8 hours of 60s recording)
      if (this._usDataToday.length > 500) this._usDataToday = this._usDataToday.slice(-500);

      // Persist full data to file
      try {
        const fullData = {
          time: data.time,
          status: data.status,
          indices: data.indices || [],
          macro: data.macro || [],
          futures: data.futures || [],
          adrs: data.adrs || [],
          sectorETFs: data.sectorETFs || [],
          sentiment: data.sentiment || [],
        };
        const dir = path.join(config.DATA_DIR, 'us_market');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'us_latest.json'),
          JSON.stringify(fullData, null, 2),
          'utf8'
        );
      } catch (e) { /* silent */ }

      // SSE broadcast
      this.emit('think_usmarket', {
        type: 'us_update',
        indices: data.indices || [],
        macro: data.macro || [],
        status: data.status,
        time: data.time,
      });
    } catch (err) {
      // silent — US market recording is non-critical
    } finally {
      this._usOpsRunning = false;
    }
  }

  // ==================== 操作：美股隔夜总结 ====================

  async _runOvernightSummary(dateStr) {
    this._logEvent('us_summary_start', { date: dateStr });

    try {
      const usMarket = require('./collectors/us_market');
      const usMacro = require('./analysis/us_macro');

      // Fetch fresh snapshot
      const usData = await Promise.race([
        usMarket.fetchAllUSMonitors(),
        this._timeout(60000, '美股总结采集超时'),
      ]);

      if (!usData) {
        this._logEvent('us_summary_skip', { reason: 'no_data' });
        return;
      }

      const summary = usMacro.generateOvernightSummary(usData, dateStr);
      if (!summary) return;

      // Persist summary
      const dir = path.join(config.DATA_DIR, 'us_market');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'us_close_' + dateStr + '.json'),
        JSON.stringify(summary, null, 2),
        'utf8'
      );

      // Also save latest snapshot
      fs.writeFileSync(
        path.join(dir, 'us_latest.json'),
        JSON.stringify(usData, null, 2),
        'utf8'
      );

      this._logEvent('us_summary_complete', {
        sentiment: summary.aStockSentiment ? summary.aStockSentiment.score : null,
        level: summary.aStockSentiment ? summary.aStockSentiment.level : null,
      });

      // Broadcast
      this.emit('think_usmarket', {
        type: 'us_summary',
        summary: summary,
        time: new Date().toISOString(),
      });
    } catch (err) {
      this._logEvent('us_summary_error', { error: err.message });
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
        } else if (r.signals) {
          for (const sig of r.signals) {
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

      // Also append to today's scan records file for think-tank display
      const scanRecordsDir = path.join(config.DATA_DIR, 'simfolio');
      const scanFile = path.join(scanRecordsDir, 'scan_records_' + this._todayDate + '.json');
      let records = [];
      if (fs.existsSync(scanFile)) {
        try { records = JSON.parse(fs.readFileSync(scanFile, 'utf8')); } catch (e2) {}
      }
      records.push({
        time: new Date().toISOString(),
        scanType: type || 'full',
        totalStocks: result.totalStocks || 0,
        candidates: result.candidates || 0,
        analyzed: result.analyzed || 0,
        top5: (result.top5 || []).slice(0, 5).map(s => ({
          code: s.code, name: s.name, score: s.compositeScore || s.score, rating: s.rating,
        })),
        signalCounts: signalCounts,
        avgScore: summary.avgScore,
        maxScore: summary.maxScore,
      });
      if (records.length > 20) records = records.slice(-20);
      fs.writeFileSync(scanFile, JSON.stringify(records, null, 2), 'utf8');
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
