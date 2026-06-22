/**
 * scheduler.js — 全自动量化交易调度器 v3.4.5
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

// Phase 1.7: Catch audit helper — appends failure record to catch_failures.jsonl
function _auditCatch(source, err) {
  try {
    var _acDir = path.join(config.DATA_DIR, 'simfolio');
    if (!fs.existsSync(_acDir)) fs.mkdirSync(_acDir, { recursive: true });
    var _acEntry = {
      timestamp: new Date().toISOString(),
      source: source || 'scheduler.unknown',
      errorCode: (err && err.code) || 'UNKNOWN',
      errorMessage: (err && err.message) || '',
      lastSuccessAt: null,
      fallbackUsed: null,
    };
    fs.appendFileSync(path.join(_acDir, 'catch_failures.jsonl'), JSON.stringify(_acEntry) + '\n', 'utf8');
  } catch (_) {}
}

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
    this._weekendAnalysisRunning = false; // 周末分析运行标记 (DEPRECATED v2.9)
    this._historyWeekendActive = false;   // 历史复盘周末持续运行标记
    this._sessionId = Date.now().toString(36); // v3.4.9: stable session ID for runId
    this._scanCounter = 0;               // v3.4.9: per-scan counter (resets on new day)
    this._lastQuoteRefresh = 0;          // v3.4.9: last market quote refresh time
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
    // Also propagate to history review engine
    try {
      const historyReview = require('./analysis/history_review');
      historyReview.setSSEBroadcast(fn);
    } catch (_) {}
    // Backward compat: also set on weekend_analyzer if still loaded
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
      this._scanCounter = 0;  // v3.4.9: reset scan counter for new day
      this._logEvent('new_day', { date: dateStr });
    }

    const newState = this._determineState(now);
    if (newState !== this._state) {
      this._transition(newState, 'tick');
    }

    // === v3.4.9: Independent market quote refresh (every 30s during trading) ===
    var isTrading = newState === 'morning_session' || newState === 'afternoon_session';
    if (isTrading && (now - this._lastQuoteRefresh) >= 30000) {
      this._lastQuoteRefresh = now;
      try {
        var mqs = require('./market_quote_service');
        mqs.refresh().catch(function() {});
      } catch (_) {}
    }

    // === Pre-market warmup (09:00-09:30, once per day) ===
    // Load overnight US summary and cross-market risk state before the opening scan,
    // so the 09:30 pipeline starts with pre-warmed context.
    var preMarketKey = 'premarket_brief_' + dateStr;
    if (this._state === 'pre_market' && !this._scheduledOps.has(preMarketKey)) {
      this._scheduledOps.add(preMarketKey);
      try {
        var preBrief = {};
        // Load US overnight summary
        try {
          var usSummaryPath = path.join(config.DATA_DIR, 'us_market', 'us_close_' + dateStr + '.json');
          if (fs.existsSync(usSummaryPath)) {
            preBrief.usSummary = JSON.parse(fs.readFileSync(usSummaryPath, 'utf8'));
          }
        } catch (_) {}
        // Load cross-market risk state
        try {
          var crossMarket = require('./analysis/cross_market');
          preBrief.riskState = crossMarket.getCachedRiskState();
        } catch (_) {}
        // Load weekend context if still valid
        try {
          var wcPath = path.join(config.DATA_DIR, 'simfolio', 'weekend_context.json');
          if (fs.existsSync(wcPath)) {
            var wc = JSON.parse(fs.readFileSync(wcPath, 'utf8'));
            if (wc.validUntil && wc.validUntil >= dateStr) {
              preBrief.weekendContext = { validUntil: wc.validUntil, insightCount: (wc.insights || []).length };
            }
          }
        } catch (_) {}
        if (Object.keys(preBrief).length > 0) {
          this.emit('think_status', {
            type: 'premarket_brief',
            brief: preBrief,
            time: new Date().toISOString(),
          });
          this._logEvent('premarket_brief', { items: Object.keys(preBrief).join(',') });
        }
      } catch (_) {}
    }

    // 活跃时段：检查是否有操作到期
    if (this._state === 'morning_session' || this._state === 'afternoon_session') {
      this._checkScheduledOps(now);
    }

    // 收盘后：执行收盘总结
    if (this._state === 'post_market' && !this._scheduledOps.has('post_market_wrapup_' + dateStr)) {
      this._runPostMarketWrapup();
    }

    // 15:30 后：每日赛后验证（仅交易日，收盘后30分钟）
    const hourNow = now.getHours();
    const minNow = now.getMinutes();
    var verifyKey = 'daily_verification_' + dateStr;
    if (this._isTradingDay(now) && hourNow >= 15 && minNow >= 30 &&
        !this._scheduledOps.has(verifyKey)) {
      this._scheduledOps.add(verifyKey);
      this._runDailyVerification(dateStr);
    }

    // 16:00 后：生成每日盘后总结报告（仅交易日）
    const isAfter4pm = hourNow >= 16;
    const summaryKey = 'daily_summary_' + dateStr;
    if (isAfter4pm && this._isTradingDay(now) && !this._scheduledOps.has(summaryKey)) {
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

    // === 历史复盘引擎 (v2.9) ===
    // Daily Light: 工作日 16:30
    var hrConfig = config.HISTORY_REVIEW || {};
    var hrDaily = hrConfig.daily || {};
    var hrDailyTime = hrDaily.time || { hour: 16, minute: 30 };
    var hrDailyKey = 'history_daily_' + dateStr;
    if (this._isTradingDay(now) && hourNow === hrDailyTime.hour && now.getMinutes() >= hrDailyTime.minute &&
        !this._scheduledOps.has(hrDailyKey)) {
      this._scheduledOps.add(hrDailyKey);
      try {
        var historyReview = require('./analysis/history_review');
        historyReview.runDaily();
        this._logEvent('history_daily', { date: dateStr });
      } catch (e) {
        console.error('[Scheduler] History daily error:', e.message);
      }
    }

    // Weekend Deep: 周六 10:30
    var hrDeep = hrConfig.deep || {};
    var hrDeepTime = hrDeep.time || { hour: 10, minute: 30 };
    var hrDeepKey = 'history_deep_' + dateStr;
    if (now.getDay() === 6 && hourNow === hrDeepTime.hour && now.getMinutes() >= hrDeepTime.minute &&
        !this._scheduledOps.has(hrDeepKey)) {
      this._scheduledOps.add(hrDeepKey);
      try {
        var hr = require('./analysis/history_review');
        hr.runWeekendDeep();
        this._logEvent('history_deep_start', { date: dateStr });
      } catch (e) {
        console.error('[Scheduler] History deep error:', e.message);
      }
    }

    // Sunday Discovery: 周日 09:00
    var hrSun = hrConfig.sundayDiscovery || {};
    var hrSunTime = hrSun.time || { hour: 9, minute: 0 };
    var hrSunKey = 'history_discovery_' + dateStr;
    if (now.getDay() === 0 && hourNow === hrSunTime.hour && now.getMinutes() >= hrSunTime.minute &&
        !this._scheduledOps.has(hrSunKey)) {
      this._scheduledOps.add(hrSunKey);
      try {
        var hr2 = require('./analysis/history_review');
        hr2.runWeekendDiscovery({ similarityWindow: hrSun.similarityWindow || 30, similarityTopN: hrSun.similarityTopN || 8, similarityStride: hrSun.similarityStride || 3 });
        this._logEvent('history_discovery_start', { date: dateStr });
      } catch (e) {
        console.error('[Scheduler] History discovery error:', e.message);
      }
    }

    // Weekend ticks: Saturday 14:00-23:00 and Sunday 12:00-23:00 (every 2 hours)
    if ((now.getDay() === 6 && hourNow >= 14) || (now.getDay() === 0 && hourNow >= 12)) {
      if (!this._historyWeekendActive) {
        this._historyWeekendActive = true;
        // The engine handles its own tick timer via _startWeekendTicks()
      }
    }
    if (now.getDay() === 1 && this._historyWeekendActive) {
      // Monday — stop weekend ticks
      this._historyWeekendActive = false;
      try {
        var hr3 = require('./analysis/history_review');
        hr3.stopWeekendTicks();
      } catch (_) {}
    }

    // === DEPRECATED v2.9: 保留旧 weekend_analyzer 作为 fallback (如果 history engine 不存在) ===
    // 周末深度分析：周六/周日全天运行
    if (this._isWeekend(now) && !this._weekendAnalysisRunning) {
      this._startWeekendAnalysis();
    } else if (!this._isWeekend(now) && this._weekendAnalysisRunning) {
      this._stopWeekendAnalysis();
    }

    // === DEPRECATED v2.9: 周五验证现在由 history engine 自动处理 ===
    // 旧的 weekend_verification 仅作为 fallback
    var VConfig = config.WEEKEND_VERIFICATION || {};
    const vHour = (VConfig.verificationSchedule && VConfig.verificationSchedule.hour) || 15;
    const vMinute = (VConfig.verificationSchedule && VConfig.verificationSchedule.minute) || 30;
    if (now.getDay() === 5 && hourNow === vHour && now.getMinutes() >= vMinute &&
        !this._scheduledOps.has('weekend_verification_' + dateStr)) {
      this._scheduledOps.add('weekend_verification_' + dateStr);
      this._runWeekendVerification();
    }

    // === 24/7 自主学习进化引擎 (v2.8: 每5分钟检查一次，非每次tick) ===
    if (config.EVOLUTION && config.EVOLUTION.enabled !== false) {
      var evoMin = now.getMinutes();
      if (this._lastEvoCheckMinute == null || Math.abs(evoMin - this._lastEvoCheckMinute) >= 5 || evoMin < this._lastEvoCheckMinute) {
        this._lastEvoCheckMinute = evoMin;
        try {
          const evolutionScheduler = require('./evolution/evolution_scheduler');
          evolutionScheduler.checkAndRun(now, dateStr);
        } catch (e) { /* 进化任务调度失败不影响主流程 */ }
      }
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
    if (d < 1 || d > 5) return false; // weekend
    // Check public holidays
    const dateStr = date.toISOString().slice(0, 10);
    if (this._isHoliday(dateStr)) return false;
    return true;
  }

  _isHoliday(dateStr) {
    try {
      const holidays = config.HOLIDAYS_2026 || [];
      return holidays.indexOf(dateStr) >= 0;
    } catch (_) { return false; }
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

      // P3: Record stock-level factor signals for prediction engine (Loop 5)
      try {
        const stockPredictor = require('./predict/stock_predictor');
        stockPredictor.recordDailyStockSignals(this._todayDate, result.allResults || []);
      } catch (_) {}

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
        // v3.4.9: Generate stable runId BEFORE any gate decisions
        this._scanCounter++;
        var runId = this._sessionId + '_' + 'full' + '_' + this._scanCounter;

        const pf = simfolio.loadPortfolio();
        const crossMarket = require('./analysis/cross_market');
        const macroContext = { riskState: crossMarket.getCachedRiskState() };
        // v3.4.2: Pass market state so kernel can distinguish "market closed" vs "data anomaly"
        var stateLabels = { closed: '离市', pre_market: '盘前', morning_session: '上午交易', lunch_break: '午休', afternoon_session: '下午交易', post_market: '盘后' };
        const tradeResult = simfolio.makeTradingDecisions(pf, result.allResults || [], result.indices || [], 'full', macroContext, this._state, stateLabels[this._state] || this._state, runId);
        this._logEvent('trade_complete', {
          decisions: tradeResult.decisions ? tradeResult.decisions.length : 0,
          executed: tradeResult.executed ? tradeResult.executed.length : 0,
          totalValue: tradeResult.snapshot ? tradeResult.snapshot.totalValue : null,
          // v3.4.2: Kernel audit fields
          kernelVerdict: tradeResult.kernelVerdict || null,
          primaryBlocker: tradeResult.kernelDecision ? tradeResult.kernelDecision.primaryBlocker : null,
          allActiveGates: tradeResult.kernelDecision ? tradeResult.kernelDecision.allActiveBlockers.map(function(g){return g.gate+':'+g.status;}) : [],
          displayReasons: tradeResult.kernelDecision ? tradeResult.kernelDecision.displayReasons : [],
          analyzed: result.analyzed || 0,
          topScore: result.allResults ? Math.max.apply(null, result.allResults.map(function(r){return r.compositeScore||0;})) : 0,
          buyCandidates: tradeResult.buyCandidates ? tradeResult.buyCandidates.length : 0,
          executedBuyCount: tradeResult.executed ? tradeResult.executed.filter(function(t){return t.action==='buy';}).length : 0,
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
            // v3.4.3: Reason priority — kernel's skipReason or primaryBlocker tells the real story
            reason: tradeResult.skipReason || (tradeResult.kernelDecision && tradeResult.kernelDecision.primaryBlocker) || 'no_candidates_above_threshold',
            analyzedCount: result.analyzed,
            time: new Date().toISOString(),
            // v3.4.2: Kernel context for event consumers
            kernelVerdict: tradeResult.kernelVerdict || null,
            primaryBlocker: tradeResult.kernelDecision ? tradeResult.kernelDecision.primaryBlocker : null,
            allActiveGates: tradeResult.kernelDecision ? tradeResult.kernelDecision.allActiveBlockers.map(function(g){return g.gate+':'+g.status;}) : [],
            displayReasons: tradeResult.kernelDecision ? tradeResult.kernelDecision.displayReasons : [],
            buyCandidates: tradeResult.buyCandidates ? tradeResult.buyCandidates.length : 0,
            topScore: result.allResults ? Math.max.apply(null, result.allResults.map(function(r){return r.compositeScore||0;})) : 0,
            skipReason: tradeResult.skipReason || null,
          });
        }

        // Persist gate state + emit decision SSE for think-tank
        if (tradeResult.gateResults) {
          try {
            const fs = require('fs');
            const path = require('path');
            const DATA_DIR = path.join(__dirname, '..', 'report-engine', 'data', 'simfolio');
            const gateStatePath = path.join(DATA_DIR, 'last_gate_state.json');
            const gateState = {
              ...tradeResult.gateResults,
              timestamp: new Date().toISOString(),
              scanType: 'full',
              executed: (tradeResult.executed || []).map(t => ({ action: t.action, code: t.code, name: t.name, price: t.price, shares: t.shares, reason: t.reason })),
              nearMisses: tradeResult.nearMisses || [],
              decisions: (tradeResult.decisions || []).length,
            };
            fs.writeFileSync(gateStatePath, JSON.stringify(gateState, null, 2), 'utf8');

            // [v3.4.5] Decision audit log — standardized no-buy reasons + complete field set
            try {
              var buyCandidates = tradeResult.buyCandidates || [];
              var executedBuys = (tradeResult.executed || []).filter(function(t) { return t.action === 'buy'; });
              var kd = tradeResult.kernelDecision || null;

              // Build audit entry from kernelDecision (the single source of truth)
              var verdict = kd ? kd.finalVerdict : (tradeResult.drawdownGateActive || tradeResult.circuitBreakerActive || tradeResult.leakageAuditBlock || tradeResult.strategyHealthBlock ? 'BLOCK' :
                (tradeResult.strategyHealthReduce || tradeResult.leakageReduceActive ? 'REDUCE' :
                  (executedBuys.length > 0 ? 'ALLOW' : 'CAUTIOUS')));

              // v3.4.5: Standardized no-buy reasons via shared module
              var noBuyReasons = null;
              try {
                var nbr = require('./no_buy_reasons');
                var _maxER_full = buyCandidates.length > 0
                  ? Math.max.apply(null, buyCandidates.map(function(c) {
                      return (c.prediction && c.prediction.expectedReturn != null) ? c.prediction.expectedReturn : -999;
                    })) : null;
                noBuyReasons = nbr.deriveNoBuyReasons({
                  kernelDecision: kd,
                  executionResult: tradeResult,
                  candidateCount: buyCandidates.length,
                  buyCount: executedBuys.length,
                  maxExpectedReturn: _maxER_full,
                });
              } catch (nbrErr) {
                try {
                  var _nbrErrEntry = { timestamp: new Date().toISOString(), source: 'scheduler._runFullPipeline.noBuyReasons', errorCode: 'DERIVE_ERR', errorMessage: nbrErr.message || '' };
                  require('fs').appendFileSync(require('path').join(__dirname, '..', 'report-engine', 'data', 'simfolio', 'catch_failures.jsonl'), JSON.stringify(_nbrErrEntry) + '\n', 'utf8');
                } catch (_) {}
              }

              var note = '';
              if (noBuyReasons && noBuyReasons.primaryNoBuyReason) {
                var nbrMeta = noBuyReasons.reasonLabels.join(' → ');
                note = noBuyReasons.reasonLabels[0] + (noBuyReasons.reasonLabels.length > 1 ? '（' + noBuyReasons.reasonLabels.slice(1).join(', ') + '）' : '');
              } else if (kd && kd.hardBlockers && kd.hardBlockers.length > 0) {
                note = '今天不买入：' + kd.hardBlockers.map(function(b) { return b.gate; }).join('+');
              } else if (kd && kd.softReducers && kd.softReducers.length > 0) {
                note = '今天限制买入：' + kd.softReducers.map(function(r) { return r.gate; }).join('+');
              } else if (verdict === 'ALLOW' && executedBuys.length > 0) {
                note = '今天买入' + executedBuys.length + '只' + (buyCandidates.length > executedBuys.length ? '（共' + buyCandidates.length + '只候选）' : '');
              } else if (verdict === 'ALLOW' && buyCandidates.length > 0) {
                note = '有' + buyCandidates.length + '只候选但未执行';
              } else {
                note = '今天无候选股达标';
              }

              // v3.4.5: Load index freshness with per-index freshnessStatus (no fake-fresh)
              var indexFreshness = 'unknown';
              try {
                var dk = require('./decision_kernel');
                var liveIdxs = dk.loadLatestIndices();
                if (liveIdxs && liveIdxs.length > 0) {
                  var idxDetails = liveIdxs.map(function(ix) {
                    return ix.code + ':' + (ix.freshnessStatus || ix.source || '?');
                  });
                  indexFreshness = idxDetails.join(', ');
                }
              } catch (_) {}

              // v3.4.5: Load buy threshold from config
              var buyThreshold = null;
              try {
                var cfg = require('./config');
                buyThreshold = cfg.BUY_THRESHOLD ? cfg.BUY_THRESHOLD.minAbsoluteScore : null;
              } catch (_) {}

              // v3.4.5: dataQuality penalty and strategyHealth sample count
              var dqPenalty = null;
              var shSampleCount = null;
              if (kd && kd.gateStates) {
                if (kd.gateStates.dataQuality) dqPenalty = kd.gateStates.dataQuality.penalty;
                if (kd.gateStates.strategyHealth) shSampleCount = kd.gateStates.strategyHealth.totalTrades;
              }

              var auditEntry = {
                timestamp: new Date().toISOString(),
                scanType: 'full',
                version: cfg ? (cfg.version || 'v3.4.5') : 'v3.4.5',
                // Funnel
                totalStocks: result.totalStocks || 0,
                candidates: result.candidates || 0,
                analyzed: result.analyzed || 0,
                // Signal quality
                topScore: result.allResults ? Math.max.apply(null, result.allResults.map(function(r) { return r.compositeScore || 0; })) : 0,
                avgScore: result.allResults ? Math.round(result.allResults.reduce(function(a, r) { return a + (r.compositeScore || 0); }, 0) / result.allResults.length) : 0,
                // Decision result
                buyCandidates: buyCandidates.length,
                buyThreshold: buyThreshold,
                executedBuyCount: executedBuys.length,
                // Kernel decision (single source of truth)
                kernelVerdict: kd ? kd.finalVerdict : verdict,
                canBuy: kd ? kd.canBuy : (verdict === 'ALLOW'),
                maxBuysPerDay: kd ? kd.maxBuysPerDay : null,
                hardBlockers: kd ? kd.hardBlockers.map(function(b) { return b.gate; }) : [],
                softReducers: kd ? kd.softReducers.map(function(r) { return r.gate; }) : [],
                primaryBlocker: kd ? kd.primaryBlocker : null,
                allActiveGates: kd ? kd.allActiveBlockers.map(function(g) { return g.gate + ':' + g.status; }) : [],
                // v3.4.5: Standardized no-buy reasons
                primaryNoBuyReason: noBuyReasons ? noBuyReasons.primaryNoBuyReason : null,
                secondaryReasons: noBuyReasons ? noBuyReasons.secondaryReasons : [],
                // v3.4.4: Context metadata
                marketState: this._state || 'unknown',
                indexFreshness: indexFreshness,
                indicesCount: result.indices ? result.indices.length : 0,
                // v3.4.5: Diagnostic fields for "why not buying" triage
                dataQualityPenalty: dqPenalty,
                strategyHealthSampleCount: shSampleCount,
                note: note,
                // v3.4.9.2: Research capture audit
                researchCaptureWritten: tradeResult._plCaptureResult ? tradeResult._plCaptureResult.writtenCount : null,
                researchCaptureDuplicates: tradeResult._plCaptureResult ? tradeResult._plCaptureResult.duplicateCount : null,
                researchCaptureFailed: tradeResult._plCaptureResult ? tradeResult._plCaptureResult.writeError : null,
              };
              _appendDecisionAudit(auditEntry);
            } catch (_) {}
          } catch (_) {}
          this.emit('think_decision', {
            type: 'decision_update',
            scanType: 'full',
            gateResults: tradeResult.gateResults,
            executed: (tradeResult.executed || []).map(t => ({ action: t.action, code: t.code, name: t.name, price: t.price, shares: t.shares, reason: t.reason })),
            nearMisses: tradeResult.nearMisses || [],
            decisions: (tradeResult.decisions || []).length,
            time: new Date().toISOString(),
            // v3.4.2: Kernel context
            kernelVerdict: tradeResult.kernelVerdict || null,
            primaryBlocker: tradeResult.kernelDecision ? tradeResult.kernelDecision.primaryBlocker : null,
            allActiveGates: tradeResult.kernelDecision ? tradeResult.kernelDecision.allActiveBlockers.map(function(g){return g.gate+':'+g.status;}) : [],
            displayReasons: tradeResult.kernelDecision ? tradeResult.kernelDecision.displayReasons : [],
            buyCandidates: tradeResult.buyCandidates ? tradeResult.buyCandidates.length : 0,
            effectiveMaxBuys: tradeResult.effectiveMaxBuys != null ? tradeResult.effectiveMaxBuys : null,
            skipReason: tradeResult.skipReason || null,
          });
        }
      } catch (tradeErr) {
        this._logEvent('trade_error', {
          error: tradeErr.message,
          stack: tradeErr.stack ? tradeErr.stack.split('\n').slice(1, 3).map(function(s){return s.trim();}).join(' -> ') : '(no stack)',
        });
        _auditCatch('scheduler._runFullPipeline.trade', tradeErr);
      }
    } catch (err) {
      this._logEvent('pipeline_error', { error: err.message, reason });
      _auditCatch('scheduler._runFullPipeline', err);
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

      // 获取低价(≤20元)非创业板A股子策略数据，按成交额排序取 Top N
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

      // 预评分 — 使用共享的8维评分（v2.8: 复用pipeline.preScoreStocks）
      var preScoreStocks = require('./pipeline').preScoreStocks;
      var preScored = preScoreStocks(topByTurnover).sort(function(a, b) { return b.preScore - a.preScore; });

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

      // P3: Record stock-level factor signals for prediction engine (Loop 5)
      try {
        const stockPredictor = require('./predict/stock_predictor');
        stockPredictor.recordDailyStockSignals(this._todayDate, results);
      } catch (_) {}

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
          // v3.4.9: Generate stable runId for mid-scan
          this._scanCounter++;
          var midRunId = this._sessionId + '_mid_' + this._scanCounter;

          const pf = simfolio.loadPortfolio();
          const crossMarket = require('./analysis/cross_market');
          const macroContext = { riskState: crossMarket.getCachedRiskState() };
          // v3.4.2: Pass market state
          var midStateLabels = { closed: '离市', pre_market: '盘前', morning_session: '上午交易', lunch_break: '午休', afternoon_session: '下午交易', post_market: '盘后' };
          const tradeResult = simfolio.makeTradingDecisions(pf, results, indices, 'mid', macroContext, this._state, midStateLabels[this._state] || this._state, midRunId);
          // v3.4.2: trade_complete event for mid-scan (was missing — only full scan had it)
          this._logEvent('trade_complete', {
            decisions: tradeResult.decisions ? tradeResult.decisions.length : 0,
            executed: tradeResult.executed ? tradeResult.executed.length : 0,
            totalValue: tradeResult.snapshot ? tradeResult.snapshot.totalValue : null,
            scanType: 'mid',
            kernelVerdict: tradeResult.kernelVerdict || null,
            primaryBlocker: tradeResult.kernelDecision ? tradeResult.kernelDecision.primaryBlocker : null,
            allActiveGates: tradeResult.kernelDecision ? tradeResult.kernelDecision.allActiveBlockers.map(function(g){return g.gate+':'+g.status;}) : [],
            displayReasons: tradeResult.kernelDecision ? tradeResult.kernelDecision.displayReasons : [],
            analyzed: results.length,
            topScore: results.length > 0 ? Math.max.apply(null, results.map(function(r){return r.compositeScore||0;})) : 0,
            buyCandidates: tradeResult.buyCandidates ? tradeResult.buyCandidates.length : 0,
            executedBuyCount: tradeResult.executed ? tradeResult.executed.filter(function(t){return t.action==='buy';}).length : 0,
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
              // v3.4.3: Reason priority — kernel's skipReason or primaryBlocker tells the real story
              reason: tradeResult.skipReason || (tradeResult.kernelDecision && tradeResult.kernelDecision.primaryBlocker) || 'no_candidates_above_threshold',
              analyzedCount: results.length,
              time: new Date().toISOString(),
              // v3.4.2: Kernel context
              kernelVerdict: tradeResult.kernelVerdict || null,
              primaryBlocker: tradeResult.kernelDecision ? tradeResult.kernelDecision.primaryBlocker : null,
              allActiveGates: tradeResult.kernelDecision ? tradeResult.kernelDecision.allActiveBlockers.map(function(g){return g.gate+':'+g.status;}) : [],
              displayReasons: tradeResult.kernelDecision ? tradeResult.kernelDecision.displayReasons : [],
              buyCandidates: tradeResult.buyCandidates ? tradeResult.buyCandidates.length : 0,
              topScore: results.length > 0 ? Math.max.apply(null, results.map(function(r){return r.compositeScore||0;})) : 0,
              skipReason: tradeResult.skipReason || null,
            });
          }

          // Persist gate state + emit decision SSE for think-tank
          if (tradeResult.gateResults) {
            try {
              const fs = require('fs');
              const path = require('path');
              const DATA_DIR = path.join(__dirname, '..', 'report-engine', 'data', 'simfolio');
              const gateStatePath = path.join(DATA_DIR, 'last_gate_state.json');
              const gateState = {
                ...tradeResult.gateResults,
                timestamp: new Date().toISOString(),
                scanType: 'mid',
                executed: (tradeResult.executed || []).map(t => ({ action: t.action, code: t.code, name: t.name, price: t.price, shares: t.shares, reason: t.reason })),
                nearMisses: tradeResult.nearMisses || [],
                decisions: (tradeResult.decisions || []).length,
              };
              fs.writeFileSync(gateStatePath, JSON.stringify(gateState, null, 2), 'utf8');

            // [v3.4.1] Decision audit log for mid scan (P0-2 fix)
            try {
              var midBuyCandidates = tradeResult.buyCandidates || [];
              var midExecutedBuys = (tradeResult.executed || []).filter(function(t) { return t.action === 'buy'; });
              var midKd = tradeResult.kernelDecision || null;

              var midVerdict = midKd ? midKd.finalVerdict : (tradeResult.drawdownGateActive || tradeResult.circuitBreakerActive || tradeResult.leakageAuditBlock || tradeResult.strategyHealthBlock ? 'BLOCK' :
                (tradeResult.strategyHealthReduce || tradeResult.leakageReduceActive ? 'REDUCE' :
                  (midExecutedBuys.length > 0 ? 'ALLOW' : 'CAUTIOUS')));

              var midNote = '';
              if (midKd && midKd.hardBlockers && midKd.hardBlockers.length > 0) {
                midNote = 'mid-scan不买入：' + midKd.hardBlockers.map(function(b) { return b.gate; }).join('+');
              } else if (midKd && midKd.softReducers && midKd.softReducers.length > 0) {
                midNote = 'mid-scan限制买入：' + midKd.softReducers.map(function(r) { return r.gate; }).join('+');
              } else if (midExecutedBuys.length > 0) {
                midNote = 'mid-scan买入' + midExecutedBuys.length + '只';
              } else {
                midNote = 'mid-scan无候选达标';
              }

              // v3.4.5: Load index freshness with per-index freshnessStatus
              var midIndexFreshness = 'unknown';
              try {
                var midDk = require('./decision_kernel');
                var midLiveIdxs = midDk.loadLatestIndices();
                if (midLiveIdxs && midLiveIdxs.length > 0) {
                  var midIdxDetails = midLiveIdxs.map(function(ix) {
                    return ix.code + ':' + (ix.freshnessStatus || ix.source || '?');
                  });
                  midIndexFreshness = midIdxDetails.join(', ');
                }
              } catch (_) {}
              var midBuyThreshold = null;
              try { var midCfg = require('./config'); midBuyThreshold = midCfg.BUY_THRESHOLD ? midCfg.BUY_THRESHOLD.minAbsoluteScore : null; } catch (_) {}

              // v3.4.5: dataQuality penalty and strategyHealth sample count
              var midDqPenalty = null;
              var midShSampleCount = null;
              if (midKd && midKd.gateStates) {
                if (midKd.gateStates.dataQuality) midDqPenalty = midKd.gateStates.dataQuality.penalty;
                if (midKd.gateStates.strategyHealth) midShSampleCount = midKd.gateStates.strategyHealth.totalTrades;
              }

              // v3.4.5: Standardized no-buy reasons
              var midNoBuyReasons = null;
              try {
                var midNbr = require('./no_buy_reasons');
                var _maxER_mid = midBuyCandidates.length > 0
                  ? Math.max.apply(null, midBuyCandidates.map(function(c) {
                      return (c.prediction && c.prediction.expectedReturn != null) ? c.prediction.expectedReturn : -999;
                    })) : null;
                midNoBuyReasons = midNbr.deriveNoBuyReasons({
                  kernelDecision: midKd,
                  executionResult: tradeResult,
                  candidateCount: midBuyCandidates.length,
                  buyCount: midExecutedBuys.length,
                  maxExpectedReturn: _maxER_mid,
                });
              } catch (midNbrErr) {
                // Phase 1.3: Log this failure explicitly — no more silent swallows
                try {
                  var _midErrEntry = { timestamp: new Date().toISOString(), source: 'scheduler._runMidScan.noBuyReasons', errorCode: 'DERIVE_ERR', errorMessage: midNbrErr.message || '' };
                  require('fs').appendFileSync(require('path').join(__dirname, '..', 'report-engine', 'data', 'simfolio', 'catch_failures.jsonl'), JSON.stringify(_midErrEntry) + '\n', 'utf8');
                } catch (_) {}
              }

              _appendDecisionAudit({
                timestamp: new Date().toISOString(),
                scanType: 'mid',
                version: midCfg ? (midCfg.version || 'v3.4.5') : 'v3.4.5',
                totalStocks: results.length > 0 ? candidates.length : 0,
                candidates: candidates.length,
                analyzed: results.length,
                topScore: results.length > 0 ? Math.max.apply(null, results.map(function(r) { return r.compositeScore || 0; })) : 0,
                avgScore: results.length > 0 ? Math.round(results.reduce(function(a, r) { return a + (r.compositeScore || 0); }, 0) / results.length) : 0,
                buyCandidates: midBuyCandidates.length,
                buyThreshold: midBuyThreshold,
                executedBuyCount: midExecutedBuys.length,
                // v3.4.1: Direct kernelDecision fields
                kernelVerdict: midKd ? midKd.finalVerdict : midVerdict,
                canBuy: midKd ? midKd.canBuy : (midVerdict === 'ALLOW'),
                maxBuysPerDay: midKd ? midKd.maxBuysPerDay : null,
                hardBlockers: midKd ? midKd.hardBlockers.map(function(b) { return b.gate; }) : [],
                softReducers: midKd ? midKd.softReducers.map(function(r) { return r.gate; }) : [],
                primaryBlocker: midKd ? midKd.primaryBlocker : null,
                allActiveGates: midKd ? midKd.allActiveBlockers.map(function(g) { return g.gate + ':' + g.status; }) : [],
                // v3.4.5: Standardized no-buy reasons
                primaryNoBuyReason: midNoBuyReasons ? midNoBuyReasons.primaryNoBuyReason : null,
                secondaryReasons: midNoBuyReasons ? midNoBuyReasons.secondaryReasons : [],
                // v3.4.4: Context metadata
                marketState: this._state || 'unknown',
                indexFreshness: midIndexFreshness,
                indicesCount: indices ? indices.length : 0,
                // v3.4.5: Diagnostic fields
                dataQualityPenalty: midDqPenalty,
                strategyHealthSampleCount: midShSampleCount,
                note: midNote,
                // v3.4.9.2: Research capture audit
                researchCaptureWritten: tradeResult._plCaptureResult ? tradeResult._plCaptureResult.writtenCount : null,
                researchCaptureDuplicates: tradeResult._plCaptureResult ? tradeResult._plCaptureResult.duplicateCount : null,
                researchCaptureFailed: tradeResult._plCaptureResult ? tradeResult._plCaptureResult.writeError : null,
              });
            } catch (_) {}
            } catch (_) {}
            this.emit('think_decision', {
              type: 'decision_update',
              scanType: 'mid',
              gateResults: tradeResult.gateResults,
              executed: (tradeResult.executed || []).map(t => ({ action: t.action, code: t.code, name: t.name, price: t.price, shares: t.shares, reason: t.reason })),
              nearMisses: tradeResult.nearMisses || [],
              decisions: (tradeResult.decisions || []).length,
              time: new Date().toISOString(),
              // v3.4.2: Kernel context
              kernelVerdict: tradeResult.kernelVerdict || null,
              primaryBlocker: tradeResult.kernelDecision ? tradeResult.kernelDecision.primaryBlocker : null,
              allActiveGates: tradeResult.kernelDecision ? tradeResult.kernelDecision.allActiveBlockers.map(function(g){return g.gate+':'+g.status;}) : [],
              displayReasons: tradeResult.kernelDecision ? tradeResult.kernelDecision.displayReasons : [],
              buyCandidates: tradeResult.buyCandidates ? tradeResult.buyCandidates.length : 0,
              effectiveMaxBuys: tradeResult.effectiveMaxBuys != null ? tradeResult.effectiveMaxBuys : null,
              skipReason: tradeResult.skipReason || null,
            });
          }
        } catch (tradeErr) {
          this._logEvent('trade_error', {
            error: tradeErr.message,
            stack: tradeErr.stack ? tradeErr.stack.split('\n').slice(1, 3).map(function(s){return s.trim();}).join(' -> ') : '(no stack)',
          });
          _auditCatch('scheduler._runMidScan.trade', tradeErr);
        }
      }
    } catch (err) {
      this._logEvent('midscan_error', { error: err.message });
      _auditCatch('scheduler._runMidScan', err);
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
        const resultPath = path.join(config.DATA_DIR, 'simfolio', 'last_pipeline_result.legacy_untrusted.json');
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

      // P3: Run trade attribution for completed sells (Loop 5 — trade→parameter feedback)
      try {
        const tradeAttribution = require('./predict/trade_attribution');
        const sellTrades = todayTrades.filter(t => t.action === 'sell' && t.pnlPct != null);
        for (const sellTrade of sellTrades) {
          // Find matching buy trade
          const buyTrade = todayTrades.find(t => t.action === 'buy' && t.code === sellTrade.code)
            || pf.tradeHistory.find(t => t.action === 'buy' && t.code === sellTrade.code && t.date === sellTrade.date);
          if (buyTrade || sellTrades.length <= 3) {
            try {
              tradeAttribution.analyzeAttribution(sellTrade, buyTrade, pf, {
                indices, marketNarrative: (analysisData && analysisData.marketNarrative) || null,
              });
            } catch (_) {}
          }
        }
        if (sellTrades.length > 0) {
          this._logEvent('trade_attribution', { sellCount: sellTrades.length, date: dateStr });
        }
      } catch (_) {}

      // P3: Update dynamic weights (Loop 6 — OLS regression learning)
      try {
        const dynamicWeights = require('./predict/dynamic_weights');
        const dwResult = dynamicWeights.updateDynamicWeights();
        this._logEvent('dynamic_weights_updated', { updated: dwResult.updated, r2: dwResult.r2, sampleCount: dwResult.sampleCount || 0 });
      } catch (_) {}

      // P3: Update cycle×factor matrix (Loop 5 — market cycle tracking)
      try {
        const cycleFactorMatrix = require('./predict/cycle_factor_matrix');
        const marketCycle = require('./analysis/market_cycle');
        const cycleHistory = marketCycle.loadCycleHistory ? (marketCycle.loadCycleHistory() || []) : [];
        cycleFactorMatrix.updateCycleFactorMatrix(cycleHistory);
      } catch (_) {}

      // P4: Verify expected return predictions (v2.8 — Loop 6 closing feedback)
      try {
        const er = require('./predict/expected_return');
        er.verifyExpectedReturns(dateStr);
      } catch (_) {}

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

  // ==================== 操作：每日赛后验证 ====================

  async _runDailyVerification(dateStr) {
    console.log('[Scheduler] 赛后验证: 开始 (' + dateStr + ')');
    this._logEvent('daily_verification_start', { date: dateStr });
    try {
      var runner = require('./analysis/verification_runner');
      var result = runner.run({ latest: true });
      var summary = result ? result.summary : null;
      console.log('[Scheduler] 赛后验证: 完成, 命中率=' +
        (summary && summary.overallHitRate != null ? summary.overallHitRate + '%' : 'N/A'));
      this._logEvent('daily_verification_done', {
        date: dateStr,
        newEntries: result ? result.newEntries : 0,
        overallHitRate: summary ? summary.overallHitRate : null,
        avgRankIC: summary ? summary.avgRankIC : null,
      });
      // v3.3.0: Evaluate shadow models against verification results
      try {
        var mr = require('./evolution/model_registry');
        var evalResult = mr.evaluateShadow(dateStr);
        if (evalResult && !evalResult.skipped) {
          console.log('[Scheduler] Shadow评估: ' +
            (evalResult.evaluated ? evalResult.evaluated.length : 0) + ' 个模型, ' +
            (evalResult.promoted ? 'PROMOTED!' : '无晋级'));
        }
      } catch (_) { /* model_registry is advisory */ }
    } catch (e) {
      console.error('[Scheduler] 赛后验证失败:', e.message);
      this._logEvent('daily_verification_error', { date: dateStr, error: e.message });
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
    // v3.4.4: Delegate to shared pipeline_summary module.
    // Both scheduler AND server manual runs use the same function now,
    // guaranteeing pipelineResultsForKernel is always present.
    try {
      var psum = require('./pipeline_summary');
      psum.savePipelineSummary(result, type, this._todayDate, {
        version: config.version || 'v3.4.5',
      });
    } catch (e) {
      // Fallback: inline save if shared module unavailable
      try {
        var dir = path.join(config.DATA_DIR, 'simfolio');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        var allResults = result.allResults || [];
        var dist = { lt50: 0, r50_60: 0, r60_70: 0, r70_80: 0, gt80: 0 };
        var signalCounts = {};
        for (var i = 0; i < allResults.length; i++) {
          var r = allResults[i];
          var s = r.compositeScore || 0;
          if (s < 50) dist.lt50++;
          else if (s < 60) dist.r50_60++;
          else if (s < 70) dist.r60_70++;
          else if (s < 80) dist.r70_80++;
          else dist.gt80++;
          var sigs = r.hiddenSignals || r.signals || [];
          for (var j = 0; j < sigs.length; j++) {
            signalCounts[sigs[j].id] = (signalCounts[sigs[j].id] || 0) + 1;
          }
        }
        var summary = {
          type: type || 'full', date: this._todayDate, time: new Date().toISOString(),
          totalStocks: result.totalStocks || 0, candidates: result.candidates || 0,
          analyzed: result.analyzed || 0, duration: result.duration || 0,
          top5: (result.top5 || []).map(function(s) { return { code: s.code, name: s.name, score: s.compositeScore, rating: s.rating, signals: s.signals || (s.hiddenSignals || []).map(function(h) { return { id: h.id, name: h.name, level: h.level }; }), }; }),
          scoreDistribution: dist, signalCounts: signalCounts,
          avgScore: allResults.length > 0 ? Math.round(allResults.reduce(function(a, r) { return a + (r.compositeScore || 0); }, 0) / allResults.length) : 0,
          maxScore: allResults.length > 0 ? Math.max.apply(null, allResults.map(function(r) { return r.compositeScore || 0; })) : 0,
          pipelineResultsForKernel: allResults.slice(0, 100).map(function(rr) { return { code: rr.code, name: rr.name, compositeScore: rr.compositeScore || 0, prediction: rr.prediction ? { expectedReturn: rr.prediction.expectedReturn, confidence: rr.prediction.confidence, label: rr.prediction.label } : null }; }),
        };
        summary.legacy_untrusted = true;
        summary._warning = 'This file feeds the OLD verification path. Read prediction_ledger for verification.';
        fs.writeFileSync(path.join(dir, 'last_pipeline_result.legacy_untrusted.json'), JSON.stringify(summary, null, 2), 'utf8');
      } catch (_) {}
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

// [v3.4.0] Decision audit log helper — append one JSONL line per scan decision.
// Called from the Scheduler from full and mid scan execution paths.
// Each line captures the complete decision context for post-hoc review:
//   - totalStocks / candidates / analyzed (funnel)
//   - topScore / avgScore (signal quality)
//   - buyCandidates / executedBuyCount (decision result)
//   - blockReasons (WHY the system didn't buy, if applicable)
function _appendDecisionAudit(entry) {
  var dir = require('path').join(__dirname, '..', 'report-engine', 'data', 'simfolio');
  if (!require('fs').existsSync(dir)) require('fs').mkdirSync(dir, { recursive: true });
  var filePath = require('path').join(dir, 'decision_audit_' + new Date().toISOString().slice(0, 10) + '.jsonl');
  require('fs').appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
}

module.exports = { Scheduler };
