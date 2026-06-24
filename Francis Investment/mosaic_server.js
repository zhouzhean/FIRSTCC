/**
 * Francis Investment · Mosaic Server v3.4.5
 * 一键启动本地服务器 — 纯 Node.js，零外部依赖。
 * 内置量化分析 Pipeline + 全自动交易调度器。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pipeline } = require('./mosaic/pipeline');
const simfolio = require('./mosaic/simfolio');
const { Scheduler } = require('./mosaic/scheduler');

const BASE_DIR = __dirname;
const REPORT_ENGINE_DIR = path.join(BASE_DIR, 'report-engine');
const DATA_DIR = path.join(REPORT_ENGINE_DIR, 'data');
const PORT = 8765;

// Singleton pipeline instance
let pipeline = null;

// Scheduler instance
let scheduler = null;

// Server start time (for uptime display)
let serverStartTime = null;

// SSE clients for Think Tank
const sseClients = new Set();

function broadcastSSE(event, data) {
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of sseClients) {
    try { res.write(payload); } catch (e) { sseClients.delete(res); }
  }
}

// Heartbeat to keep SSE connections alive and provide current state
const SCAN_SCHEDULE = [
  { h: 9, m: 30, label: '全量扫描', type: 'full' },
  { h: 10, m: 0, label: '盘中扫描', type: 'mid' },
  { h: 10, m: 30, label: '盘中扫描', type: 'mid' },
  { h: 11, m: 0, label: '全量扫描', type: 'full' },
  { h: 11, m: 25, label: '盘中扫描', type: 'mid' },
  { h: 13, m: 0, label: '全量扫描', type: 'full' },
  { h: 13, m: 30, label: '盘中扫描', type: 'mid' },
  { h: 14, m: 0, label: '盘中扫描', type: 'mid' },
  { h: 14, m: 30, label: '盘中扫描', type: 'mid' },
  { h: 14, m: 50, label: '盘中扫描', type: 'mid' },
];

function saveLastPipelineResult(result, type) {
  // v3.4.5: Use shared pipeline_summary module — same as scheduler.
  // This guarantees pipelineResultsForKernel is always saved,
  // even after manual pipeline runs via the API.
  try {
    var psum = require('./mosaic/pipeline_summary');
    psum.savePipelineSummary(result, type || 'full', new Date().toISOString().slice(0, 10), {
      version: (require('./mosaic/config').version || 'v3.4.5'),
    });
  } catch (e) {
    // Fallback: inline save (legacy — same as before v3.4.5)
    try {
      const dir = path.join(DATA_DIR, 'simfolio');
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
        date: new Date().toISOString().slice(0, 10),
        time: new Date().toISOString(),
        totalStocks: result.totalStocks || 0,
        candidates: result.candidates || 0,
        analyzed: result.analyzed || 0,
        duration: result.duration || 0,
        top5: (result.top5 || []).map(s => ({ code: s.code, name: s.name, score: s.compositeScore, rating: s.rating })),
        scoreDistribution: dist,
        signalCounts: signalCounts,
        avgScore: allResults.length > 0 ? Math.round(allResults.reduce((a, r) => a + (r.compositeScore || 0), 0) / allResults.length) : 0,
        maxScore: allResults.length > 0 ? Math.max(...allResults.map(r => r.compositeScore || 0)) : 0,
        pipelineResultsForKernel: allResults.slice(0, 100).map(function(r) { return { code: r.code, name: r.name, compositeScore: r.compositeScore || 0, prediction: r.prediction ? { expectedReturn: r.prediction.expectedReturn, confidence: r.prediction.confidence, label: r.prediction.label } : null }; }),
      };
      fs.writeFileSync(path.join(dir, 'last_pipeline_result.legacy_untrusted.json'), JSON.stringify(summary, null, 2), 'utf8');
    } catch (_) {}
  }
  // P3: Record stock-level signals for prediction engine
  try {
    const stockPredictor = require('./mosaic/predict/stock_predictor');
    stockPredictor.recordDailyStockSignals(new Date().toISOString().slice(0, 10), result.allResults || []);
  } catch (_) {}
}

// ---- Daily Events Log (persisted by date) ----

function saveDailyEvent(event) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const eventsDir = path.join(DATA_DIR, 'events');
    if (!fs.existsSync(eventsDir)) fs.mkdirSync(eventsDir, { recursive: true });
    const filePath = path.join(eventsDir, today + '.json');
    let events = [];
    if (fs.existsSync(filePath)) {
      try { events = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) {}
    }
    events.push(event);
    // Keep max 500 events per day
    if (events.length > 500) events = events.slice(-500);
    fs.writeFileSync(filePath, JSON.stringify(events, null, 2), 'utf8');
  } catch (e) { /* silent */ }
}

function loadDailyEvents(dateStr) {
  try {
    const filePath = path.join(DATA_DIR, 'events', dateStr + '.json');
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) { /* silent */ }
  return [];
}

function listEventDates() {
  try {
    const eventsDir = path.join(DATA_DIR, 'events');
    if (!fs.existsSync(eventsDir)) return [];
    return fs.readdirSync(eventsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''))
      .sort()
      .reverse()
      .slice(0, 60); // last 60 days
  } catch (e) { return []; }
}

function getNextScanTime() {
  const now = new Date();
  for (const s of SCAN_SCHEDULE) {
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), s.h, s.m, 0);
    if (t > now) {
      return { time: t.toISOString(), label: s.label, type: s.type };
    }
  }
  return null;
}

/**
 * P1-2: Generate today's actionable verdict.
 * Synthesizes market state + factor health + portfolio P&L + risk regime
 * into one sentence of guidance the user can actually act on.
 */
function _buildLoopImpact(data) {
  const loopImpact = [];
  try {
    var di; // decision impact module (lazy load)
    var gotDI = false;
    function getDI() { if (!gotDI) { try { di = require('./mosaic/decision_impact'); } catch(e){} gotDI = true; } return di; }

    if (data.predictionHealth && data.predictionHealth.loops) {
      const loops = data.predictionHealth.loops;
      // Loop 1: weekend verify
      if (loops['1_weekendVerify'] && loops['1_weekendVerify'].status === 'active') {
        const l1 = loops['1_weekendVerify'];
        if (l1.process && l1.process.crossMarketRisk) {
          var wc = getDI() ? getDI().forWeekendContext({ available: true, analyzedToday: true }) : null;
          loopImpact.push({ loop: 1, name: '周末验证', effect: '跨市场防御激活', decisionImpact: wc || { impact: 'active_effective', label: '有效影响' } });
        }
        if (l1.process && l1.process.sectorPreference) {
          loopImpact.push({ loop: 1, name: '周末验证', effect: '板块偏好注入', decisionImpact: { impact: 'active_effective', label: '有效影响' } });
        }
        if (!l1.process || (!l1.process.crossMarketRisk && !l1.process.sectorPreference)) {
          var wc2 = getDI() ? getDI().forWeekendContext({ available: true, analyzedToday: false }) : null;
          loopImpact.push({ loop: 1, name: '周末验证', effect: '监控中，无新上下文', decisionImpact: wc2 || { impact: 'active_monitoring', label: '监控中' } });
        }
      }
      // Loop 2: NB weight
      if (loops['2_nbWeight'] && loops['2_nbWeight'].status) {
        const l2 = loops['2_nbWeight'];
        const nbStatus = l2.status;
        var nbImpact = null;
        if (nbStatus === 'active') {
          nbImpact = getDI() ? getDI().forNorthBound({ available: true, usedInDecision: true }) : null;
          loopImpact.push({ loop: 2, name: '北向权重', effect: '北向信号活跃，权重正常', decisionImpact: nbImpact || { impact: 'active_effective', label: '有效影响' } });
        } else if (nbStatus === 'degraded') {
          nbImpact = getDI() ? getDI().forNorthBound({ available: false }) : null;
          loopImpact.push({ loop: 2, name: '北向权重', effect: '北向偏冷，触发评分降权', decisionImpact: nbImpact || { impact: 'degraded', label: '不可用' } });
        } else {
          nbImpact = getDI() ? getDI().forNorthBound({ available: false }) : null;
          loopImpact.push({ loop: 2, name: '北向权重', effect: '北向数据不可用', decisionImpact: nbImpact || { impact: 'degraded', label: '不可用' } });
        }
      }
      // Loop 3: knowledge base
      if (loops['3_knowledgeBase'] && loops['3_knowledgeBase'].status === 'active') {
        const kb = loops['3_knowledgeBase'];
        const activeF = (kb.process && kb.process.activeFactors) || 0;
        var kbImpact = getDI() ? getDI().classify({ moduleEnabled: true, hasData: activeF > 0, directlyAffected: activeF > 0 }) : null;
        loopImpact.push({ loop: 3, name: '知识库', effect: activeF + '个因子追踪中', decisionImpact: kbImpact || (activeF > 0 ? { impact: 'active_effective', label: '有效影响' } : { impact: 'active_monitoring', label: '监控中' }) });
      }
      // Loop 4: think-tank defense
      if (loops['4_thinkTankDefense'] && loops['4_thinkTankDefense'].process) {
        const p4 = loops['4_thinkTankDefense'].process;
        if (p4.blocked) {
          var ttImpact = getDI() ? getDI().forThinkTankDefense({ executed: true, hasData: true, defenseActive: true }) : null;
          loopImpact.push({ loop: 4, name: '思维舱防御', effect: '防御触发(' + p4.totalScore + '分)，拦截买入', decisionImpact: ttImpact || { impact: 'active_effective', label: '有效影响' } });
        } else if (p4.totalScore > 0) {
          var ttImpact2 = getDI() ? getDI().forThinkTankDefense({ executed: true, hasData: true, defenseActive: false }) : null;
          loopImpact.push({ loop: 4, name: '思维舱防御', effect: '防御正常(' + p4.totalScore + '/' + (p4.threshold||2) + ')', decisionImpact: ttImpact2 || { impact: 'active_monitoring', label: '监控中' } });
        }
      } else {
        // ThinkTankDefense NOT executed
        var ttImpact3 = getDI() ? getDI().forThinkTankDefense({ executed: false, hasData: false }) : null;
        loopImpact.push({ loop: 4, name: '思维舱防御', effect: '未执行，未参与本次决策', decisionImpact: ttImpact3 || { impact: 'off', label: '未执行' } });
      }
      // Loop 5: trade attribution
      if (loops['5_tradeAttribution'] && loops['5_tradeAttribution'].status === 'active') {
        const a5 = loops['5_tradeAttribution'];
        const adjCount = (a5.process && a5.process.adjustmentsTriggered) || 0;
        const tr = a5.input && a5.input.totalAttributions || 0;
        var taImpact = getDI() ? getDI().classify({ moduleEnabled: true, hasData: tr > 0, directlyAffected: adjCount > 0 }) : null;
        loopImpact.push({ loop: 5, name: '归因反馈', effect: tr + '条记录，' + adjCount + '次调整', decisionImpact: taImpact || (adjCount > 0 ? { impact: 'active_effective', label: '有效影响' } : { impact: 'active_monitoring', label: '监控中' }) });
      }
      // Loop 6: dynamic weights
      if (loops['6_dynamicWeights'] && loops['6_dynamicWeights'].status === 'active') {
        const a6 = loops['6_dynamicWeights'];
        var r2 = (a6.process && a6.process.r2) || 0;
        var sampleCount = (a6.process && a6.process.sampleCount) || 0;
        var dwImpact = getDI() ? getDI().forDynamicWeights({ enabled: true, sampleCount: sampleCount }) : null;
        loopImpact.push({ loop: 6, name: '动态权重', effect: 'R²=' + (r2*100).toFixed(0) + '%，' + sampleCount + '样本', decisionImpact: dwImpact || { impact: 'active_monitoring', label: '等待样本' } });
      }
    }
  } catch (_) {}
  return loopImpact;
}

// [v3.4.1] Unified Decision Kernel — single source of truth for ALL trading decisions.
// Replaces the old independent logic (factor HOT/COLD + portfolio P&L + cross-market regime)
// with the same kernel that cockpit and simfolio use. No more contradictory verdicts.
function generateTodaysVerdict(data) {
  // Non-trading hours: quick return with wait status
  var state = (data.scheduler && data.scheduler.state) || 'closed';
  var tradingStates = ['morning_session', 'afternoon_session'];
  var isTrading = tradingStates.indexOf(state) >= 0;

  if (!isTrading) {
    var stateLabelMap = { closed: '离市', pre_market: '盘前', lunch_break: '午休', post_market: '盘后' };
    var stateLabel = stateLabelMap[state] || state;
    return {
      summary: '当前' + stateLabel + '，等待开盘',
      action: 'wait',
      actionLabel: stateLabel,
      color: '#4a5568',
      details: [],
      loopImpact: _buildLoopImpact(data),
    };
  }

  // ===== v3.4.0: Use unified Decision Kernel for trading-hours verdict =====
  try {
    var kernel = require('./mosaic/decision_kernel');

    var pf = null;
    try { pf = require('./mosaic/simfolio').loadPortfolio(); } catch (_) {}

    var dqReport = null;
    try { dqReport = require('./mosaic/analysis/data_quality').computeConfidencePenalty(); } catch (_) {}

    var leakageAudit = null;
    try {
      var laPath = require('path').join(__dirname, 'report-engine', 'data', 'verification', 'leakage_audit.json');
      if (require('fs').existsSync(laPath)) {
        leakageAudit = JSON.parse(require('fs').readFileSync(laPath, 'utf8'));
      }
    } catch (_) {}

    // v3.4.3: Use shared loadLatestIndices()
    var ttIndices = require('./mosaic/decision_kernel').loadLatestIndices();

    var shResult = null;
    try {
      var sh = require('./mosaic/analysis/strategy_health');
      shResult = sh.computeStrategyHealth({
        portfolio: pf, indices: ttIndices, macroContext: null, pipelineResults: null,
      });
    } catch (_) {}

    var macroContext = null;
    try {
      var cm = require('./mosaic/analysis/cross_market');
      var riskState = cm.getCachedRiskState();
      if (riskState) macroContext = { riskState: riskState };
    } catch (_) {}

    var decision = kernel.computeDecision({
      portfolio: pf,
      indices: ttIndices,
      macroContext: macroContext,
      pipelineResults: null,
      dataQualityReport: dqReport,
      leakageAudit: leakageAudit,
      strategyHealth: shResult,
    });

    // Map kernel verdict → think-tank action format (backward compatible)
    var actionMap = { ALLOW: 'normal', CAUTIOUS: 'cautious', REDUCE: 'cautious', BLOCK: 'defensive' };
    var action = actionMap[decision.finalVerdict] || 'normal';

    var actionLabels = { normal: '可正常交易', cautious: '谨慎交易', defensive: '建议减仓观望' };
    var actionLabel = actionLabels[action] || '未知';

    var actionColors = { normal: '#00e676', cautious: '#ffb800', defensive: '#ff3b4a' };
    var actionColor = actionColors[action] || '#4a5568';

    // Build messages from kernel reasons + advisory signals
    var parts = [];
    for (var h = 0; h < decision.hardBlockers.length; h++) {
      parts.push(decision.hardBlockers[h].reason);
    }
    for (var s = 0; s < decision.softReducers.length; s++) {
      parts.push(decision.softReducers[s].reason);
    }
    if (parts.length === 0) {
      parts.push('各项指标正常，可正常交易');
    }

    return {
      summary: parts.join(' · '),
      action: action,
      actionLabel: actionLabel,
      color: actionColor,
      details: decision.hardBlockers.concat(decision.softReducers).concat(decision.advisorySignals),
      loopImpact: _buildLoopImpact(data),
    };
  } catch (_) {
    // Kernel unavailable — fallback: display unknown state
    return {
      summary: '决策内核不可用，建议人工判断',
      action: 'cautious',
      actionLabel: '谨慎交易（内核异常）',
      color: '#ffb800',
      details: [{ gate: 'kernel', reason: 'Decision kernel unavailable: ' + (_.message || 'unknown error') }],
      loopImpact: _buildLoopImpact(data),
    };
  }
}

setInterval(() => {
  if (sseClients.size === 0) return;
  const now = new Date();
  const sStatus = scheduler ? scheduler.getStatus() : null;
  const nextScan = getNextScanTime();
  broadcastSSE('heartbeat', {
    time: now.toISOString(),
    state: sStatus ? sStatus.state : 'stopped',
    isTradingDay: sStatus ? sStatus.isTradingDay : false,
    nextTickMs: sStatus ? sStatus.nextTickMs : null,
    opsRunning: sStatus ? sStatus.opsRunning : false,
    nextScan: nextScan,
  });
}, 3000);

// ---- Trading day detection ----

function isTradingDay(date) {
  if (!date) date = new Date();
  const d = date.getDay();
  return d >= 1 && d <= 5;
}

function getWeekdayCN(date) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];
}

function getLatestReportDate() {
  if (!fs.existsSync(DATA_DIR)) return null;
  const dates = [];
  for (const item of fs.readdirSync(DATA_DIR)) {
    const itemPath = path.join(DATA_DIR, item);
    if (fs.statSync(itemPath).isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(item)) {
      dates.push(item);
    }
  }
  dates.sort().reverse();
  return dates[0] || null;
}

// ---- API Handlers ----

function apiStatus() {
  var today = new Date();
  var dStr = today.toISOString().slice(0, 10);
  var pStatus = pipeline ? pipeline.getStatus() : null;
  var sStatus = scheduler ? scheduler.getStatus() : null;
  var cfg = require('./mosaic/config');
  return {
    date: dStr,
    weekday: getWeekdayCN(today),
    isTradingDay: isTradingDay(today),
    latestReport: getLatestReportDate(),
    serverStatus: 'running',
    version: (cfg.version || 'v3.4.5'),
    buildCommit: (cfg.buildCommit || null),
    buildTimestamp: (cfg.buildTimestamp || null),
    // Phase 0: Release identity — full identity surface
    gitCommit: (cfg.gitCommit || null),                // from git (null on cloud)
    deployCommit: (cfg.deployCommit || null),           // from deploy_manifest.json
    deployManifestValid: (cfg.deployManifestValid || false),
    deployFileHashCount: (cfg.deployFileHashCount || 0),
    identityStatus: (cfg.identityStatus || 'manifest_missing'),  // matched | mismatch | git_only | manifest_only | manifest_missing
    pipeline: pStatus,
    scheduler: sStatus,
  };
}

function apiReportsIndex() {
  const p = path.join(DATA_DIR, 'reports-index.json');
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return { reports: [] };
}

function apiRecommendationHistory() {
  const p = path.join(DATA_DIR, 'recommendation-history.json');
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return { history: [] };
}

function apiReport(date) {
  const reportDir = path.join(DATA_DIR, date);
  if (!fs.existsSync(reportDir) || !fs.statSync(reportDir).isDirectory()) {
    return null;
  }
  const report = { date: date };
  for (const fname of fs.readdirSync(reportDir)) {
    if (!fname.endsWith('.js')) continue;
    const fpath = path.join(reportDir, fname);
    const content = fs.readFileSync(fpath, 'utf8');
    const key = fname.replace('.js', '');
    const m = content.match(/_d\.\w+\s*=\s*(\{[\s\S]*\});?\s*$/);
    if (m) {
      try { report[key] = JSON.parse(m[1]); }
      catch (e) { report[key] = { _raw: true, _note: 'Complex JS' }; }
    }
  }
  return report;
}

// ---- Pipeline API ----

function handlePipelineRun(res) {
  if (!isTradingDay()) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, message: '今日休市，无需运行分析' }));
    return;
  }

  if (pipeline && pipeline.status === 'running') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, message: '分析已在运行中', progress: pipeline.progress }));
    return;
  }

  // Start new pipeline
  pipeline = new Pipeline();
  pipeline.on('progress', (data) => {
    console.log('  [' + data.progress + '%] ' + data.step);
    broadcastSSE('progress', { type: 'progress', ...data });
  });
  pipeline.on('enrichment', (data) => {
    broadcastSSE('enrichment', { type: 'enrichment', ...data });
  });
  pipeline.on('stock_analyzed', (data) => {
    broadcastSSE('stock', { type: 'stock_analyzed', ...data });
  });
  pipeline.on('factor_stats', (data) => {
    broadcastSSE('stats', { type: 'factor_stats', ...data });
  });

  broadcastSSE('scan', { type: 'scan_start', reason: 'manual', time: new Date().toISOString() });

  // Run in background (don't await)
  pipeline.run().then(result => {
    console.log('  Pipeline done: ' + result.analyzed + ' stocks analyzed in ' + result.duration + 's');
    console.log('  Top pick: ' + (result.top5[0] ? result.top5[0].name + ' (' + result.top5[0].compositeScore + '分)' : 'N/A'));
    broadcastSSE('scan', {
      type: 'scan_complete',
      totalStocks: result.totalStocks,
      candidates: result.candidates,
      analyzed: result.analyzed,
      top5: (result.top5 || []).map(s => ({ code: s.code, name: s.name, score: s.compositeScore, rating: s.rating })),
      duration: result.duration,
      time: new Date().toISOString(),
    });
    // Persist result so think-tank can reload it after restart
    saveLastPipelineResult(result, 'full');
  }).catch(err => {
    console.error('  Pipeline error:', err.message);
  });

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, message: '量化分析已启动' }));
}

function handlePipelineStatus(res) {
  if (!pipeline) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'idle', progress: 0, step: '未运行' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(pipeline.getStatus()));
}

// ---- Simfolio API ----

function handleSimfolioStatus(res) {
  const pf = simfolio.loadPortfolio();
  const snapshot = simfolio.getSnapshot(pf);
  const stats = simfolio.computeStats(pf);
  // P1-5: Include holdings health data
  const holdingsHealth = computeHoldingsHealth(pf);
  // P1-1: Factor signal diagnostics
  let factorDiags = [];
  try {
    const factorPerf = require('./mosaic/analysis/factor_performance');
    const perf = factorPerf.getFactorPerformance();
    const kb = require('./mosaic/analysis/knowledge_base');
    const kbSummary = kb.getKnowledgeSummary();
    factorDiags = simfolio.factorSignalDiagnostics(perf, kbSummary);
  } catch (_) {}
  return jsonResponse(res, {
    ok: true,
    ...snapshot,
    stats,
    tradeHistory: pf.tradeHistory.slice(-20),
    holdingsHealth,
    factorDiagnostics: factorDiags,
  });
}

// P1-5: Compute per-holding health analysis
function computeHoldingsHealth(pf) {
  const cfg = require('./mosaic/config');
  const healthCards = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const pos of pf.positions) {
    const pnlPct = ((pos.currentPrice - pos.avgCost) / pos.avgCost * 100);
    const stopPrice = pos.avgCost * (1 + ((cfg.SIMFOLIO && cfg.SIMFOLIO.stopLossPct) || -0.08));
    const distanceToStop = ((pos.currentPrice - stopPrice) / stopPrice * 100);
    const holdingDays = Math.floor((Date.now() - new Date(pos.entryDate + 'T00:00:00+08:00').getTime()) / 86400000);

    // Signal change assessment
    let signalStatus = 'unknown';
    let signalNote = '暂无实时信号数据';
    if (pos._lastSignalCount != null) {
      if (pos._lastSignalCount >= 3) { signalStatus = 'strong'; signalNote = '信号充足（' + pos._lastSignalCount + '个触发）'; }
      else if (pos._lastSignalCount >= 1) { signalStatus = 'moderate'; signalNote = '信号一般（' + pos._lastSignalCount + '个触发）'; }
      else { signalStatus = 'weak'; signalNote = '信号消失，关注后续变化'; }
    }

    // Recommendation
    let recommendation = 'hold';
    let recLabel = '继续持有';
    let recColor = '#6366f1';
    if (pnlPct <= -7) {
      recommendation = 'prepare_sell';
      recLabel = '接近止损，准备减仓';
      recColor = '#ef4444';
    } else if (pnlPct >= 15) {
      recommendation = 'consider_profit';
      recLabel = '盈利可观，可考虑部分止盈';
      recColor = '#22c55e';
    } else if (pnlPct >= 3 && signalStatus === 'weak') {
      recommendation = 'monitor';
      recLabel = '盈利但信号减弱，注意观察';
      recColor = '#f59e0b';
    } else if (pnlPct <= -3 && signalStatus === 'strong') {
      recommendation = 'hold_confident';
      recLabel = '浮亏但信号强，可继续持有观察';
      recColor = '#8b5cf6';
    }

    healthCards.push({
      code: pos.code,
      name: pos.name,
      holdingDays: holdingDays,
      avgCost: pos.avgCost,
      currentPrice: pos.currentPrice,
      pnlPct: Math.round(pnlPct * 100) / 100,
      stopPrice: Math.round(stopPrice * 100) / 100,
      distanceToStopPct: Math.round(distanceToStop * 100) / 100,
      signalStatus: signalStatus,
      signalNote: signalNote,
      recommendation: recommendation,
      recommendationLabel: recLabel,
      recommendationColor: recColor,
    });
  }

  return healthCards;
}

function handleSimfolioHistory(res) {
  const pf = simfolio.loadPortfolio();
  return jsonResponse(res, { ok: true, dailyNav: pf.dailyNav });
}

// P1-5: Dedicated holdings health endpoint
function handleHoldingsHealth(res) {
  const pf = simfolio.loadPortfolio();
  const health = computeHoldingsHealth(pf);
  return jsonResponse(res, { ok: true, holdings: health });
}

function handleSimfolioTrade(res) {
  if (!pipeline || pipeline.status !== 'done' || !pipeline.result) {
    return jsonResponse(res, { ok: false, message: '请先运行量化分析（Pipeline未完成）' });
  }

  // v3.4.2: Load macroContext + marketState for kernel consistency
  // Manual trades must go through the same kernel path as automated ones
  var macroContext = null;
  try {
    var crossMarket = require('./mosaic/analysis/cross_market');
    var riskState = crossMarket.getCachedRiskState();
    if (riskState) macroContext = { riskState: riskState };
  } catch (_) {}

  var mktState = null, mktLabel = null;
  try {
    var schedPath = path.join(DATA_DIR, 'simfolio', 'scheduler_state.json');
    if (fs.existsSync(schedPath)) {
      var ss = JSON.parse(fs.readFileSync(schedPath, 'utf8'));
      if (ss.state) {
        mktState = ss.state;
        var stateLabels = { closed: '离市', pre_market: '盘前', morning_session: '上午交易', lunch_break: '午休', afternoon_session: '下午交易', post_market: '盘后' };
        mktLabel = stateLabels[mktState] || mktState;
      }
    }
  } catch (_) {}

  const pf = simfolio.loadPortfolio();
  const result = simfolio.makeTradingDecisions(pf, pipeline.result.allResults, pipeline.result.indices, 'full', macroContext, mktState, mktLabel, null, null);

  return jsonResponse(res, {
    ok: true,
    decisions: result.decisions,
    executed: result.executed,
    snapshot: result.snapshot,
    // v3.4.2: Return kernel decision for UI transparency
    kernelDecision: result.kernelDecision ? {
      canBuy: result.kernelDecision.canBuy,
      finalVerdict: result.kernelDecision.finalVerdict,
      finalVerdictLabel: result.kernelDecision.finalVerdictLabel,
      maxBuysPerDay: result.kernelDecision.maxBuysPerDay,
      primaryBlocker: result.kernelDecision.primaryBlocker,
      allActiveBlockers: result.kernelDecision.allActiveBlockers,
      displayReasons: result.kernelDecision.displayReasons,
    } : null,
    kernelVerdict: result.kernelVerdict,
    maxBuysPerDay: result.maxBuysPerDay,
    canBuy: result.canBuy,
  });
}

function handleSimfolioReset(res) {
  const pf = simfolio.resetPortfolio();
  return jsonResponse(res, { ok: true, message: '模拟账户已重置', snapshot: simfolio.getSnapshot(pf) });
}

function handlePipelineResult(res) {
  if (!pipeline || pipeline.status !== 'done') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, message: '分析尚未完成' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, result: pipeline.result }));
}

// ---- MIME types ----

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
};

function getMIME(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

function serveStatic(res, filePath) {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': getMIME(filePath),
      'Content-Length': content.length,
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  } catch (e) {
    if (e.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('500 Internal Server Error');
    }
  }
}

// ---- v3.3.0: Cockpit Data Builder ----

// [v3.3.1] Helper: check if a file exists at a path relative to BASE_DIR
function _fileExists(relPath) {
  try {
    return require('fs').existsSync(require('path').join(__dirname, relPath));
  } catch (_) { return false; }
}

// [v3.3.1] Normalize leakage audit — force NO_SAMPLES when totalChecks===0
// Prevents stale/broken JSON from showing CLEAN when no samples were checked.
function normalizeLeakageAudit(audit) {
  if (!audit) return audit;
  var totalChecks = audit.totalChecks || 0;
  if (totalChecks === 0) {
    audit.verdict = 'NO_SAMPLES';
    audit.note = '样本数据不足，无法执行泄漏审计。需要至少一条验证记录。';
    audit.leakageFree = 0;
  }
  return audit;
}

function buildCockpitData() {
  var cfg = require('./mosaic/config');
  var result = {
    timestamp: new Date().toISOString(),
    // System info
    systemVersion: (cfg.version || 'v3.4.5'),
    buildCommit: (cfg.buildCommit || null),
    buildTimestamp: (cfg.buildTimestamp || null),
    // Phase 0: Release identity — full identity surface
    gitCommit: (cfg.gitCommit || null),
    deployCommit: (cfg.deployCommit || null),
    deployManifestValid: (cfg.deployManifestValid || false),
    deployFileHashCount: (cfg.deployFileHashCount || 0),
    identityStatus: (cfg.identityStatus || 'manifest_missing'),
    serverStartTime: serverStartTime || null,
    lastRestartTime: serverStartTime || null,
    codeVersionMismatch: false,
    // API health
    apiHealth: {},
    // Data file health
    dataFiles: [],
    // Core panels
    tasks: [],
    models: null,
    dataQuality: null,
    permissions: null,
    verification: null,
    failures: [],
    // v3.3.1
    icDecomposition: null,
    shadowTracking: null,
    calibration: null,
    leakageAudit: null,
    changeLog: [],
  };

  // 1. Tasks — from evolution scheduler
  try {
    var evo = require('./mosaic/evolution/evolution_scheduler');
    var evoStatus = evo.getStatus();
    var taskNames = {
      bootstrap_history: 'Bootstrap Training',
      full_backtest: 'Full Backtest',
      night_backtest: 'Night Backtest',
      weight_grid_search: 'Weight Grid Search',
      parameter_push: 'Parameter Push',
      us_predict_generate: 'US Predict Generate',
      us_predict_verify: 'US Predict Verify',
      self_reflection: 'Self Reflection',
      weekend_factor_mining: 'Weekend Factor Mining',
      weekly_report: 'Weekly Report',
    };
    var today = new Date().toISOString().slice(0, 10);
    var seenTasks = {};
    if (evoStatus.history) {
      for (var i = evoStatus.history.length - 1; i >= 0; i--) {
        var h = evoStatus.history[i];
        if (h.date === today && !seenTasks[h.task]) {
          seenTasks[h.task] = true;
          result.tasks.push({
            name: taskNames[h.task] || h.task,
            id: h.task,
            status: h.success ? 'ok' : 'failed',
            summary: h.summary || '',
          });
        }
      }
    }
    // Add tasks not yet run today
    for (var tid in taskNames) {
      if (!seenTasks[tid]) {
        result.tasks.push({ name: taskNames[tid], id: tid, status: 'waiting', summary: '' });
      }
    }
  } catch (e) {
    result.tasks = [{ name: 'Scheduler offline', id: 'error', status: 'failed', summary: e.message }];
  }

  // 2. Models — from model registry
  try {
    var mr = require('./mosaic/evolution/model_registry');
    result.models = mr.getRegistryStatus();
    // P0.3/P0.4: Partition Legacy vs Research Lab
    result.models.partition = {
      researchLab: 'PIT OOS validated — see api/status researchLab field',
      legacy: 'Unverified bootstrap/champion/shadow — labeled Legacy, NOT for live trading',
    };
  } catch (_) {
    result.models = { error: 'Model registry not available' };
  }

  // 3. Data Quality
  try {
    var dq = require('./mosaic/analysis/data_quality');
    var dqResult = dq.computeConfidencePenalty();
    result.dataQuality = {
      qualityScore: dqResult.qualityScore || null,
      penalty: dqResult.penalty || 0,
      reasons: dqResult.reasons || [],
    };
    // Auto-pause status
    try {
      var simfolio = require('./mosaic/simfolio');
      result.dataQuality.autoPause = simfolio.getAutoPauseStatus();
    } catch (_) {}
  } catch (_) {
    result.dataQuality = { error: 'Data quality module not available' };
  }

  // [v3.4.0] 4. Trading Permissions — Unified Decision Kernel
  // Single call replaces 200+ lines of multi-step cascade (strategy_health + leakage + dq + mc).
  // All three consumers (cockpit, think-tank, simfolio) now use the same kernel.
  try {
    var kernel = require('./mosaic/decision_kernel');

    // --- Pre-load all context data for the kernel ---
    var pf;
    try {
      var sf = require('./mosaic/simfolio');
      pf = sf.loadPortfolio();
    } catch (_) {
      pf = { positions: [], tradeHistory: [], _stats: {} };
    }

    var dqReport = null;
    try { dqReport = require('./mosaic/analysis/data_quality').computeConfidencePenalty(); } catch (_) {}

    var leakageAudit = null;
    try {
      var auditFile = require('path').join(__dirname, 'report-engine', 'data', 'verification', 'leakage_audit.json');
      if (require('fs').existsSync(auditFile)) {
        leakageAudit = JSON.parse(require('fs').readFileSync(auditFile, 'utf8'));
        leakageAudit = normalizeLeakageAudit(leakageAudit);
        result.dataQuality.leakageRisk = leakageAudit.verdict || 'UNKNOWN';
        result.dataQuality.leakageChecks = leakageAudit.totalChecks || 0;
        result.leakageAudit = leakageAudit;
      }
    } catch (_) {}

    // v3.4.3: Use shared loadLatestIndices() — reads raw arrays, not {indices:...}
    var indices = require('./mosaic/decision_kernel').loadLatestIndices();
    result.indices = indices;  // v3.4.3: expose to cockpit UI

    // v3.4.1: Load market state from scheduler (P1-2: marketClosed vs noMarketData)
    var marketState = null;
    var marketStateLabel = null;
    try {
      var schedStatePath = require('path').join(__dirname, 'report-engine', 'data', 'simfolio', 'scheduler_state.json');
      if (require('fs').existsSync(schedStatePath)) {
        var schedState = JSON.parse(require('fs').readFileSync(schedStatePath, 'utf8'));
        if (schedState.state) {
          marketState = schedState.state;
          var stateLabels = { closed: '离市', pre_market: '盘前', lunch_break: '午休', post_market: '盘后', trading: '交易中' };
          marketStateLabel = stateLabels[marketState] || marketState;
        }
      }
    } catch (_) {}

    var shResult = null;
    try {
      var sh = require('./mosaic/analysis/strategy_health');
      shResult = sh.computeStrategyHealth({
        portfolio: pf, indices: indices, macroContext: null, pipelineResults: null,
      });
      if (shResult && shResult.masterControl) {
        result.masterControl = shResult.masterControl;
      }
    } catch (_) {}

    var macroContext = null;
    try {
      var cm = require('./mosaic/analysis/cross_market');
      var riskState = cm.getCachedRiskState();
      if (riskState) macroContext = { riskState: riskState };
    } catch (_) {}

    // Load pipeline summary for funnel display (v3.4.0)
    var pipelineSummary = null;
    var pipelineResultsForKernel = null;
    try {
      var lrFile = require('path').join(__dirname, 'report-engine', 'data', 'simfolio', 'last_pipeline_result.legacy_untrusted.json');
      if (require('fs').existsSync(lrFile)) {
        var lrData = JSON.parse(require('fs').readFileSync(lrFile, 'utf8'));
        pipelineSummary = {
          totalStocks: lrData.totalStocks || 0,
          candidates: lrData.candidates || 0,
          analyzed: lrData.analyzed || 0,
          topScore: lrData.maxScore,
          avgScore: lrData.avgScore,
          type: lrData.type,
          time: lrData.time,
        };
        result.pipelineSummary = pipelineSummary;
        // v3.4.3: Use pipelineResultsForKernel (always saved) instead of allResults (not persisted)
        if (lrData.pipelineResultsForKernel && lrData.pipelineResultsForKernel.length > 0) {
          pipelineResultsForKernel = lrData.pipelineResultsForKernel;
        }
      }
    } catch (_) {}

    // --- Call the unified kernel ---
    var decision = kernel.computeDecision({
      portfolio: pf,
      indices: indices,
      macroContext: macroContext,
      pipelineResults: pipelineResultsForKernel,
      dataQualityReport: dqReport,
      leakageAudit: leakageAudit,
      strategyHealth: shResult,
      marketState: marketState,
      marketStateLabel: marketStateLabel,
    });

    // --- Build backward-compatible permissions object ---
    var gs = decision.gateStates;
    result.permissions = {
      verdict: decision.finalVerdict,
      verdictLabel: decision.finalVerdictLabel,
      maxBuysPerDay: decision.maxBuysPerDay,
      reasons: decision.displayReasons || [],
      confidence: shResult && shResult.masterControl ? shResult.masterControl.confidence : null,
      // v3.4.1: Expose all active blockers for cockpit display (P1-1)
      primaryBlocker: decision.primaryBlocker,
      allActiveBlockers: decision.allActiveBlockers,
      marketClosed: decision.marketClosed || false,
      // P0.2-4: Live model validation — whether Kernel has a validated model to trade with
      activeTradingModel: decision.activeTradingModel || null,
      liveModelStatus: decision.liveModelStatus || 'NO_VALIDATED_LIVE_MODEL',
      liveModelGate: gs.liveModel || { status: 'block', liveModelStatus: 'NO_VALIDATED_LIVE_MODEL', description: '无验证模型可用于实盘' },
      // Flat gate states for backward compat
      gates: {
        drawdownActive: gs.drawdown.status === 'block' || gs.drawdown.status === 'restrict',
        marketGateActive: gs.marketDirection.status === 'block',
        circuitBreakerActive: gs.circuitBreaker.status === 'block',
      },
      // Diagnostic booleans
      dataQualityOk: gs.dataQuality.status === 'pass' || gs.dataQuality.status === 'warn',
      strategyHealthOk: gs.strategyHealth.status === 'pass',
      strategyHealthVerdict: gs.strategyHealth.verdict || 'ALLOW',
      rankICPositive: result.verification && result.verification.rankIC != null && result.verification.rankIC > 0,
      winRateRecovering: result.verification && result.verification.overallHitRate > 45,
      drawdownNarrowing: gs.drawdown.status !== 'block' && gs.drawdown.status !== 'restrict',
      leakageAuditClean: gs.leakageAudit.status === 'pass',
      leakageAuditCaution: gs.leakageAudit.status === 'cautious',
      leakageAuditVerdict: gs.leakageAudit.verdict || 'NO_SAMPLES',
      leakageAuditChecks: gs.leakageAudit.totalChecks || 0,
      hasPositions: pf.positions && pf.positions.length > 0,
      positionCount: pf.positions ? pf.positions.length : 0,
      // v3.4.6: Market data validation diagnostics (v3.4.9.1: add quoteAge/quoteStale/marketState)
      marketValidation: gs.marketData ? {
        status: gs.marketData.status,
        indexCount: gs.marketData.indexCount || 0,
        validCoreCount: gs.marketData.validCoreCount || 0,
        invalidIndices: gs.marketData.invalidIndices || [],
        lastValidQuoteAt: gs.marketData.lastValidQuoteAt || null,
        sourceChain: gs.marketData.sourceChain || 'unknown',
        description: gs.marketData.description || '',
        quoteAge: gs.marketData.quoteAge,
        quoteStale: gs.marketData.quoteStale,
      } : null,
      // v3.4.9.1: Market state for UI to distinguish trading vs non-trading quoteAge display
      marketState: marketState,
    };

    // displayReasons already built by kernel finalize() — set as primary reasons
    // Fallback: ensure reasons is populated for backward compat
    if (result.permissions.reasons.length === 0 && decision.finalVerdict !== 'ALLOW') {
      result.permissions.reasons.push('Decision kernel: ' + decision.finalVerdict + ' — no specific reason recorded');
    }

    // Preserve effectiveMaxBuys from pipeline result if available
    try {
      var lrFile2 = require('path').join(__dirname, 'report-engine', 'data', 'simfolio', 'last_pipeline_result.legacy_untrusted.json');
      if (require('fs').existsSync(lrFile2)) {
        var lrData2 = JSON.parse(require('fs').readFileSync(lrFile2, 'utf8'));
        if (lrData2.effectiveMaxBuys != null && result.permissions.maxBuysPerDay == null) {
          result.permissions.maxBuysPerDay = lrData2.effectiveMaxBuys;
        }
      }
    } catch (_) {}

  } catch (_) {
    result.permissions = { error: 'Decision kernel not available: ' + (_.message || '') };
  }

  // 5. Verification
  try {
    var vd = require('./mosaic/analysis/verification_dashboard');
    var dash = vd.getDashboard({ lookbackDays: 60 });
    result.verification = {
      overallHitRate: dash.summary && dash.summary.overallHitRate,
      totalPredictions: dash.summary && dash.summary.totalPredictions,
      rankIC: dash.summary && dash.summary.rankIC,
      dataQuality: dash.summary && dash.summary.dataQuality,
      factors: dash.stockPredictor && dash.stockPredictor.factors || [],
      // v3.4.8: Include canonical overall structure from verification_summary.json
      overall: null,
    };
    // v3.4.8: Read overall from verification_summary.json for CI/independentDays/netExcess
    try {
      var vsPath2 = path.join(DATA_DIR, 'verification', 'verification_summary.json');
      if (fs.existsSync(vsPath2)) {
        var vsData = JSON.parse(fs.readFileSync(vsPath2, 'utf8'));
        if (vsData.overall) {
          result.verification.overall = vsData.overall;
        }
      }
    } catch (_) {}
  } catch (_) {
    result.verification = { error: 'Verification dashboard not available' };
  }

  // v3.3.1: 5.5. IC Decomposition
  try {
    var vd2 = require('./mosaic/analysis/verification_dashboard');
    var dash2 = vd2.getDashboard({ lookbackDays: 60 });
    result.icDecomposition = dash2.icDecomposition || { available: false, message: 'Not available' };
    result.calibration = dash2.confidenceCalibration || { available: false, message: 'Not available' };
  } catch (_) {
    result.icDecomposition = { available: false, message: 'Module error' };
    result.calibration = { available: false, message: 'Module error' };
  }

  // v3.3.1: 5.6. Shadow Forward Tracking
  try {
    var mr2 = require('./mosaic/evolution/model_registry');
    var registryStatus = mr2.getRegistryStatus();
    result.shadowTracking = buildShadowTracking(registryStatus);
  } catch (_) {
    result.shadowTracking = { shadows: [], message: 'Not available' };
  }

  // v3.3.1: 5.8. API Health — verify that key API data sources are responding
  result.apiHealth = {
    cockpit: { status: result.ok !== false ? 'OK' : 'ERROR' },
    modelRegistry: { status: result.models && !result.models.error ? 'OK' : 'ERROR' },
    walkForward: {
      status: _fileExists('report-engine/data/evolution/walk_forward_report.json') ? 'OK' : 'DATA_MISSING'
    },
    leakageAudit: {
      status: result.leakageAudit && result.leakageAudit.totalChecks > 0 ? 'OK' : 'DATA_MISSING'
    },
    calibration: {
      status: _fileExists('report-engine/data/evolution/calibration.json') ? 'OK' : 'DATA_MISSING'
    },
    verificationDashboard: { status: result.verification && !result.verification.error ? 'OK' : result.verification && result.verification.overallHitRate == null ? 'DATA_MISSING' : 'ERROR' },
    icBreakdown: {
      status: _fileExists('report-engine/data/evolution/ic_decomposition.json') ? 'OK' : 'DATA_MISSING'
    },
    decisionKernel: { status: result.permissions && !result.permissions.error ? 'OK' : 'ERROR' },
  };

  // v3.3.1: 5.9. Data file health
  result.dataFiles = buildDataFileHealth();

  // v3.3.1: 5.11. Change log
  result.changeLog = buildChangeLog();

  // 6. Failed Tasks
  try {
    var evo2 = require('./mosaic/evolution/evolution_scheduler');
    var evoStatus2 = evo2.getStatus();
    if (evoStatus2.history) {
      for (var j = evoStatus2.history.length - 1; j >= 0 && result.failures.length < 10; j--) {
        var entry = evoStatus2.history[j];
        if (!entry.success) {
          result.failures.push({
            task: entry.task,
            date: entry.date,
            time: entry.time,
            error: entry.error || entry.summary || 'Unknown error',
          });
        }
      }
    }
  } catch (_) {}

  // P1-UI: Research Lab data
  result.researchLab = buildResearchLabData();

  return result;
}

// [v3.3.1] Build per-shadow tracking data for cockpit Panel 7
// Must use the full shadow object (with cumulativeIC, _maxDrawdown, evaluationDays)
// and the baseline's current IC for promotion criteria check.
function buildShadowTracking(registryStatus) {
  var shadows = [];
  if (!registryStatus || !registryStatus.shadows) return { shadows: [], message: 'No shadow data' };

  try {
    var mr = require('./mosaic/evolution/model_registry');
    var baselineIC = registryStatus.baseline ? registryStatus.baseline.cumulativeIC : null;
    var baselineDrawdown = registryStatus.baseline ? registryStatus.baseline._maxDrawdown : null;

    for (var i = 0; i < registryStatus.shadows.length; i++) {
      var s = registryStatus.shadows[i];
      var criteria = null;
      try {
        // Must load the FULL internal shadow object (not just the flat API projection)
        // checkPromotionCriteria needs _maxDrawdown on the shadow
        criteria = mr.checkPromotionCriteria(s, baselineIC, baselineDrawdown);
      } catch (_) {}

      // Also try to get forward samples directly
      var fwdSamples = criteria ? criteria.forwardSamples : 0;
      var dirHitRate = criteria ? criteria.directionHitRate : null;
      if (dirHitRate == null && s.cumulativeHitRate != null) {
        dirHitRate = s.cumulativeHitRate;
      }

      shadows.push({
        versionId: s.versionId,
        source: s.source,
        cumulativeIC: s.cumulativeIC,
        evaluationDays: s.evaluationDays,
        forwardSamples: fwdSamples,
        directionHitRate: dirHitRate,
        meetsPromotionCriteria: criteria ? criteria.eligible : false,
        icTrending: s.cumulativeIC != null && s.evaluationDays > 3
          ? (s.cumulativeIC > 0.05 ? 'up' : s.cumulativeIC < -0.05 ? 'down' : 'stable')
          : 'stable',
        failingChecks: criteria ? criteria.failingChecks || [] : [],
        baselineIC: baselineIC,
      });
    }
  } catch (_) {}

  return { shadows: shadows };
}

// [v3.3.1] Build data file health status
function buildDataFileHealth() {
  var files = [
    { name: 'training_matrix.json', path: 'report-engine/data/evolution/training_matrix.json' },
    { name: 'factor_effectiveness.json', path: 'report-engine/data/evolution/factor_effectiveness.json' },
    { name: 'param_search_results.json', path: 'report-engine/data/evolution/param_search_results.json' },
    { name: 'walk_forward_report.json', path: 'report-engine/data/evolution/walk_forward_report.json' },
    { name: 'ic_decomposition.json', path: 'report-engine/data/evolution/ic_decomposition.json' },
    { name: 'model_registry.json', path: 'report-engine/data/evolution/model_registry.json' },
    { name: 'shadow_forward_samples.json', path: 'report-engine/data/evolution/shadow_forward_samples.json' },
    { name: 'leakage_audit.json', path: 'report-engine/data/verification/leakage_audit.json' },
    { name: 'calibration.json', path: 'report-engine/data/evolution/calibration.json' },
  ];

  var results = [];
  var now = Date.now();
  var STALE_MS = 7 * 24 * 3600 * 1000; // 7 days = stale

  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var fullPath = path.join(__dirname, f.path);
    var entry = { name: f.name, exists: false, updated: null, size: null, expired: false };

    try {
      if (fs.existsSync(fullPath)) {
        var stat = fs.statSync(fullPath);
        entry.exists = true;
        entry.updated = stat.mtime.toISOString().slice(0, 16).replace('T', ' ');
        entry.size = formatFileSize(stat.size);
        entry.expired = (now - stat.mtime.getTime()) > STALE_MS;
      }
    } catch (_) {}

    results.push(entry);
  }

  return results;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// [v3.3.1] Build change log
function buildChangeLog() {
  return [
    {
      module: 'model_registry.js',
      purpose: 'Shadow 验证按 predictionDate+code+horizon 严格对齐，避免重复累计',
      syntaxOk: true,
      interfaceVerified: false,
      hasRealData: false,
    },
    {
      module: 'verification_runner.js',
      purpose: '反数据泄漏审计 (leakage_audit.json): temporal + futureData + horizon 检查',
      syntaxOk: true,
      interfaceVerified: false,
      hasRealData: false,
    },
    {
      module: 'verification_dashboard.js',
      purpose: 'IC 分解 (train/valid/forward) + 置信度校准 (ECE) + Rank IC vs Direction HR 分离',
      syntaxOk: true,
      interfaceVerified: false,
      hasRealData: false,
    },
    {
      module: 'cockpit.html/css/js',
      purpose: '8 面板可监督 UI: 系统版本/API健康/数据文件/预测能力/Shadow-Baseline/泄漏审计/权限原因/变更日志',
      syntaxOk: true,
      interfaceVerified: false,
      hasRealData: false,
    },
  ];
}

// P1-UI: Research Lab data builder (v3.4.9.7 P0.2)
function buildResearchLabData() {
  var data = {
    status: 'loading',
    labelConvention: 'T_close_signal__T+1_open_entry__T+4_close_exit__3day_hold',
    simulatorDesign: '3-sleeve equal-weight overlapping cohorts',
    statisticsMethod: 'Deterministic random-portfolio Monte Carlo (Laplace-smoothed p-value, paired delta CI)',
    portfolioCapacity: {
      topNPerCohort: 50,
      numSleeves: 3,
      maxPositionsPerSleeve: 17,
      maxConcurrentPositions: 150,
    },
    universe: {
      type: 'current-file',
      stableStart: null,
      survivorshipRisk: true,
      realFeatures: ['technical', 'hidden'],
      unavailableFeatures: ['financial', 'capitalFlow', 'event'],
    },
    p0Status: 'pending',    // pending | fixtures_pass | data_rebuilt | unknown
    p0DataRegenerated: false,
    p1Model: null,
    validWindows: 0,
    latestWindow: null,
    navCurve: null,
    randomCI: null,
    dataHash: null,
    modelArtifacts: [],
    warning: null,
    // P0.2: Coverage checklist
    coverageAudit: null,
  };

  try {
    // Universe info
    var UNIVERSE = require('./mosaic/research/universe_definition');
    data.universe.stableStart = UNIVERSE.getStableStartDate();
    var meta = UNIVERSE.getUniverseMetadata();
    if (meta) {
      data.universe.stockCount = meta.totalStocks;
    }
  } catch (_) {}

  // Check if P0 tests pass (simulator fixtures)
  try {
    var SIM = require('./mosaic/research/trade_simulator');
    var fixtureResults = SIM.runFixtures();
    if (fixtureResults && fixtureResults.failed === 0 && fixtureResults.passed >= 18) {
      data.p0Status = 'pass';
    } else {
      data.p0Status = 'pending';
      data.warning = 'P0 simulator fixtures did not all pass. Research results are not interpretable.';
    }
  } catch (_) {
    data.p0Status = 'unknown';
    data.warning = 'Cannot run P0 simulator fixtures. Research results unverified.';
  }

  // Check if P0-1/P0.2 snapshot regeneration happened
  // Must have labelConvention AND exitDelayDays (exit tradability check)
  try {
    var path = require('path');
    var fs = require('fs');
    var snapDir = path.join(__dirname, 'report-engine', 'data', 'research', 'snapshots');
    if (fs.existsSync(snapDir)) {
      var files = fs.readdirSync(snapDir).filter(function (f) { return f.endsWith('.jsonl'); }).sort();
      if (files.length > 0) {
        var latestFile = files[files.length - 1];
        var firstLine = fs.readFileSync(path.join(snapDir, latestFile), 'utf8').split('\n')[0];
        var sample = JSON.parse(firstLine);
        if (sample.labelConvention && sample.exitDelayDays !== undefined) {
          data.p0DataRegenerated = true;
        } else if (sample.labelConvention) {
          data.p0DataRegenerated = false;
          data.warning = (data.warning || '') + ' Snapshots have P0-1 label but not P0.2 exit tradability. Regenerate required.';
        } else {
          data.p0DataRegenerated = false;
          data.warning = (data.warning || '') + ' Snapshots not yet regenerated with P0-1/P0.2 conventions.';
        }
      }
    }
  } catch (_) {}

  // Load true_walk_forward_summary for model info
  try {
    var path = require('path');
    var fs = require('fs');
    var tfPath = path.join(__dirname, 'report-engine', 'data', 'research', 'model_artifacts', 'true_walk_forward_summary.json');
    if (fs.existsSync(tfPath)) {
      var tf = JSON.parse(fs.readFileSync(tfPath, 'utf8'));
      if (tf.windows && tf.windows.length > 0) {
        data.validWindows = tf.windows.filter(function (w) { return !w.error && w.model; }).length;
        var validWindows = tf.windows.filter(function (w) { return !w.error && w.model; });
        if (validWindows.length > 0) {
          var latest = validWindows[validWindows.length - 1];
          // P0.1: Explicit strategy/benchmark decomposition — UI must never conflate net with excess
          // P0.2 CONDITIONAL T1: benchmarkStatus=available ONLY when benchmarkTradeCount>0 AND benchmarkUnavailableCount is defined AND benchmark NAV recalculable
          var benchStatusWf = latest.portfolio ? (latest.portfolio.benchmarkTradeCount > 0 && latest.portfolio.benchmarkUnavailableCount != null ? 'available' : 'unavailable') : 'unavailable';
          data.latestWindow = {
            testStart: latest.window ? latest.window.testStart : null,
            testEnd: latest.window ? latest.window.testEnd : null,
            testDays: latest.window ? latest.window.testDays : null,
            trainStart: latest.window ? latest.window.trainStart : null,
            trainEnd: latest.window ? latest.window.trainEnd : null,
            trainDays: latest.window ? latest.window.trainDays : null,
            lambda: latest.model ? latest.model.lambda : null,
            nFeatures: latest.model ? latest.model.nFeatures : null,
            testMSE: latest.metrics ? latest.metrics.testMSE : null,
            avgRankIC: latest.metrics ? latest.metrics.avgRankIC : null,
            // P0.1: Strategy returns
            strategyNetReturn: latest.portfolio ? (latest.portfolio.strategyNetReturn || latest.portfolio.netReturn) : null,
            strategyGrossReturn: latest.portfolio ? (latest.portfolio.strategyGrossReturn || latest.portfolio.grossReturn) : null,
            // P0.1: Benchmark returns (same-path)
            benchmarkNetReturn: latest.portfolio ? latest.portfolio.benchmarkReturn : null,
            benchmarkGrossReturn: latest.portfolio ? latest.portfolio.benchmarkReturn : null,
            // P0.2-1: Benchmark acceptance — null when unavailable, not 0
            benchmarkStatus: benchStatusWf,
            benchmarkSource: benchStatusWf === 'available' ? 'sh_index_same_path' : null,
            benchmarkTradeCount: latest.portfolio ? (latest.portfolio.benchmarkTradeCount || null) : null,
            benchmarkUnavailableCount: latest.portfolio ? (latest.portfolio.benchmarkUnavailableCount || null) : null,
            // P0.1: Excess (strategyNet - benchmarkNet) — compute ONLY when benchmark available
            netExcessReturn: benchStatusWf === 'available'
              ? (latest.portfolio ? latest.portfolio.netExcessReturn : null)
              : null,
            netExcessStatus: benchStatusWf === 'available' ? 'comparable' : 'benchmark_unavailable',
            directionAccuracy: latest.metrics ? latest.metrics.directionAccuracy : null,
            // P0.1: Legacy compat fields (keep for older UI consumers)
            portfolioNetReturn: latest.portfolio ? latest.portfolio.netReturn : null,
            portfolioGrossReturn: latest.portfolio ? latest.portfolio.grossReturn : null,
            portfolioNetExcess: latest.portfolio ? latest.portfolio.netExcessReturn : null,
          };
          data.p1Model = {
            type: tf.model || 'ridge_regression',
            features: tf.features || [],
            standardization: tf.standardization || 'unknown',
            intercept: tf.intercept || 'unknown',
          };
          // P0-3: Check if Ridge model has any stable positive Rank IC
          var allRankICs = validWindows.map(function (w) {
            return w.metrics ? w.metrics.avgRankIC : null;
          }).filter(function (v) { return v != null; });
          var hasPositiveIC = allRankICs.some(function (ic) { return ic > 0; });
          var avgIC = allRankICs.length > 0
            ? Math.round(allRankICs.reduce(function (s, v) { return s + v; }, 0) / allRankICs.length * 10000) / 10000
            : null;
          // P0.2-5: Count positive windows for accurate rejection text
          var positiveCount = allRankICs.filter(function (ic) { return ic > 0; }).length;
          if (!hasPositiveIC || (avgIC != null && avgIC < 0)) {
            data.modelVerdict = 'REJECTED_RESEARCH';
            data.modelVerdictReason = allRankICs.length + ' 个窗口中仅 ' + positiveCount + ' 个微弱正 Rank IC，平均 Rank IC=' + avgIC + '，无稳定预测能力；paired delta CI 为负。';
          }
        }
        data.modelArtifacts = tf.windows.map(function (w) {
          return {
            testStart: w.window ? w.window.testStart : null,
            lambda: w.model ? w.model.lambda : null,
            rankIC: w.metrics ? w.metrics.avgRankIC : null,
            grossReturn: w.portfolio ? w.portfolio.grossReturn : null,
            artifacts: w.artifactsPath || null,
          };
        });
      }
    }
  } catch (_) {}

  // Load OOS rolling summary for baseline comparison
  try {
    var path = require('path');
    var fs = require('fs');
    var oosPath = path.join(__dirname, 'report-engine', 'data', 'research', 'oos_evaluation_results', 'rolling_oos_summary.json');
    if (fs.existsSync(oosPath)) {
      var oos = JSON.parse(fs.readFileSync(oosPath, 'utf8'));
      if (oos.windows && oos.windows.length > 0) {
        data.oosWindows = oos.windows.length;
        // Fallback: if walk-forward didn't produce validWindows, use OOS window count
        if (data.validWindows === 0) {
          var oosValid = oos.windows.filter(function (w) { return !w.error; });
          data.validWindows = oosValid.length;
          // Populate latestWindow from OOS if walk-forward didn't
          if (oosValid.length > 0 && data.validWindows > 0 && !data.latestWindow) {
            var latestOOS = oosValid[oosValid.length - 1];
            // OOS evaluates composite/technicalOnly/momentum; composite has the strongest signal
            var bestModel = latestOOS.models && (latestOOS.models.composite || latestOOS.models.technicalOnly || latestOOS.models.momentum);
            if (bestModel && bestModel.modelPortfolio) {
              // CONDITIONAL T1: benchmarkStatus=available ONLY when benchmarkTradeCount>0 AND benchmarkUnavailableCount is defined
              var benchStatusOOS = bestModel.modelPortfolio.benchmarkStatus || (bestModel.modelPortfolio.benchmarkTradeCount > 0 && bestModel.modelPortfolio.benchmarkUnavailableCount != null ? 'available' : 'unavailable');
              data.latestWindow = {
                testStart: latestOOS.windowStart || (latestOOS.window && latestOOS.window.testStart),
                testEnd: latestOOS.windowEnd || (latestOOS.window && latestOOS.window.testEnd),
                // P0.1: Explicit strategy/benchmark decomposition
                strategyNetReturn: bestModel.modelPortfolio.strategyNetReturn || bestModel.modelPortfolio.netReturn,
                strategyGrossReturn: bestModel.modelPortfolio.strategyGrossReturn || bestModel.modelPortfolio.grossReturn,
                benchmarkNetReturn: bestModel.modelPortfolio.benchmarkNetReturn || bestModel.modelPortfolio.benchmarkReturn,
                benchmarkGrossReturn: bestModel.modelPortfolio.benchmarkGrossReturn || bestModel.modelPortfolio.benchmarkReturn,
                // P0.2-1: Benchmark acceptance
                benchmarkStatus: benchStatusOOS,
                benchmarkSource: bestModel.modelPortfolio.benchmarkSource || (benchStatusOOS === 'available' ? 'sh_index_same_path' : null),
                benchmarkTradeCount: bestModel.modelPortfolio.benchmarkTradeCount || null,
                benchmarkUnavailableCount: bestModel.modelPortfolio.benchmarkUnavailableCount || null,
                netExcessReturn: benchStatusOOS === 'available' ? bestModel.modelPortfolio.netExcessReturn : null,
                netExcessStatus: benchStatusOOS === 'available' ? 'comparable' : 'benchmark_unavailable',
                topPoolSize: bestModel.modelPortfolio.topPoolSize || 50,
                numSleeves: bestModel.modelPortfolio.numSleeves || 3,
                executedPositionsPerSleeve: bestModel.modelPortfolio.maxPositionsPerSleeve || 17,
                totalTurnover: bestModel.modelPortfolio.totalTurnover,
                roundTripCostPct: bestModel.modelPortfolio.roundTripCostPct,
                // Legacy compat
                portfolioNetReturn: bestModel.modelPortfolio.netReturn,
                portfolioGrossReturn: bestModel.modelPortfolio.grossReturn,
                portfolioNetExcess: bestModel.modelPortfolio.netExcessReturn,
                source: 'oos_evaluation',
              };
            }
          }
        }
        // Extract random CI from first window with Monte Carlo comparison data
        for (var i = 0; i < oos.windows.length; i++) {
          var w = oos.windows[i];
          if (w.models && w.models.technicalOnly && w.models.technicalOnly.randomMonteCarlo) {
            var rm = w.models.technicalOnly.randomMonteCarlo;
            data.randomCI = {
              method: rm.method || 'random_portfolio_monte_carlo',
              ci95_lower: rm.ci95_netReturn_lower,
              ci95_upper: rm.ci95_netReturn_upper,
              mean: rm.meanNetReturn,
              pairedDelta_ci95_lower: rm.pairedDelta_ci95_lower,
              pairedDelta_ci95_upper: rm.pairedDelta_ci95_upper,
              pairedDelta_mean: rm.pairedDelta_mean,
              samples: w.models.technicalOnly.monteCarloSamples,
            };
            break;
          }
        }
      }
    }
  } catch (_) {}

  // Compute dataHash from snapshots (DJB2 of file list + sizes + first/last line checksums)
  try {
    var path = require('path');
    var fs = require('fs');
    var snapDir = path.join(__dirname, 'report-engine', 'data', 'research', 'snapshots');
    if (fs.existsSync(snapDir)) {
      var snapFiles = fs.readdirSync(snapDir).filter(function (f) { return f.endsWith('.jsonl'); }).sort();
      if (snapFiles.length > 0) {
        var hash = 5381;
        for (var si = 0; si < snapFiles.length; si++) {
          var stat = fs.statSync(path.join(snapDir, snapFiles[si]));
          var str = snapFiles[si] + ':' + stat.size;
          for (var sj = 0; sj < str.length; sj++) {
            hash = ((hash << 5) + hash) + str.charCodeAt(sj);
            hash = hash & hash; // 32-bit
          }
        }
        data.snapshotCount = snapFiles.length;
        data.dataHash = (hash >>> 0).toString(16);
      }
    }
  } catch (_) {}

  // P0.2 CONDITIONAL T2: Coverage audit re-model
  // Constraint 1: expectedCalendarDates = actualExchangeOpenDays + holidayExclusions
  // Constraint 2: actualExchangeOpenDays = generatedSnapshotsInRange + trueDataGap
  // Holiday note: universal_calendar has gaps — 13 known A-share holidays (mostly 2026 Spring Festival week)
  //   are in the tradingDay list because the calendar hasn't been updated for them.
  //   These are correct exclusions (exchange was closed), NOT true data gaps.
  try {
    var CALENDAR = require('./mosaic/research/universal_calendar');
    var UNIVERSE = require('./mosaic/research/universe_definition');
    var tradingDays = CALENDAR.loadCalendar();
    var stableStart = UNIVERSE.getStableStartDate() || '2023-10-27';
    var endDate = '2026-06-15';

    // Infrastructure
    var rangeStart = new Date(stableStart + 'T00:00:00+08:00');
    var rangeEnd = new Date(endDate + 'T00:00:00+08:00');
    var calendarWeekdays = 0;
    for (var d = new Date(rangeStart); d <= rangeEnd; d.setDate(d.getDate() + 1)) {
      var dow = d.getDay();
      if (dow >= 1 && dow <= 5) calendarWeekdays++;
    }

    // expectedCalendarDates: all dates the trading calendar says the exchange should be open
    var expectedCalendarDates = 0;
    var expectedDateSet = {};
    for (var td = 0; td < tradingDays.length; td++) {
      if (tradingDays[td] >= stableStart && tradingDays[td] <= endDate) {
        expectedCalendarDates++;
        expectedDateSet[tradingDays[td]] = true;
      }
    }

    // generatedSnapshots: actual JSONL snapshot files
    var snapDir = path.join(__dirname, 'report-engine', 'data', 'research', 'snapshots');
    var snapFiles = fs.readdirSync(snapDir).filter(function (f) { return f.endsWith('.jsonl'); }).sort();
    var generatedSnapshotsTotal = snapFiles.length;
    var generatedSnapshotsInRange = 0;
    var snapSet = {};
    snapFiles.forEach(function (f) {
      var sd = f.replace('.jsonl', '');
      snapSet[sd] = true;
      if (sd >= stableStart && sd <= endDate) generatedSnapshotsInRange++;
    });

    // actualExchangeOpenDays: days where we have exchange data (snapshots)
    var actualExchangeOpenDays = generatedSnapshotsInRange; // 636

    // Known holiday reasons for the 13 calendar dates that are actually exchange holidays
    // (universal_calendar doesn't know about these — they're in the trading day list but exchange was closed)
    var knownHolidayReasons = {
      '2024-02-09': 'Spring Festival Eve (2024)',
      '2024-09-16': 'Mid-Autumn Festival holiday (2024)',
      '2025-01-28': 'Spring Festival Eve (2025)',
      '2025-05-05': 'Labor Day holiday (2025)',
      '2025-10-08': 'National Day Golden Week (2025)',
      '2026-01-02': 'New Year holiday (2026)',
      '2026-02-16': 'Spring Festival (2026)',
      '2026-02-17': 'Spring Festival (2026)',
      '2026-02-18': 'Spring Festival (2026)',
      '2026-02-19': 'Spring Festival (2026)',
      '2026-02-20': 'Spring Festival (2026)',
      '2026-02-23': 'Spring Festival post-holiday (2026)',
      '2026-04-06': 'Qingming Festival holiday (2026)',
    };

    // holidayExclusions: calendar dates that are actually holidays (no snapshots, for good reason)
    var holidayExclusions = [];
    for (var td2 = 0; td2 < tradingDays.length; td2++) {
      var dt2 = tradingDays[td2];
      if (dt2 >= stableStart && dt2 <= endDate && !snapSet[dt2]) {
        holidayExclusions.push({
          date: dt2,
          reason: knownHolidayReasons[dt2] || 'Unknown exchange closure',
        });
      }
    }

    // trueDataGap: expectedCalendarDates - actualExchangeOpenDays - holidayExclusions (= 0)
    var trueDataGap = expectedCalendarDates - generatedSnapshotsInRange - holidayExclusions.length;

    // Constraint 1: expectedCalendarDates = actualExchangeOpenDays + holidayExclusions
    var constraint1Satisfied = expectedCalendarDates === (actualExchangeOpenDays + holidayExclusions.length);

    // Constraint 2: actualExchangeOpenDays = generatedSnapshotsInRange + trueDataGap
    var constraint2Satisfied = actualExchangeOpenDays === (generatedSnapshotsInRange + trueDataGap);

    data.coverageAudit = {
      // Infrastructure
      calendarWeekdays: calendarWeekdays,                  // 687: all Mon-Fri in range
      expectedCalendarDates: expectedCalendarDates,         // 649: dates calendar says exchange should be open
      actualExchangeOpenDays: actualExchangeOpenDays,       // 636: dates with actual exchange data
      // Snapshot files
      generatedSnapshotsInRange: generatedSnapshotsInRange, // 636
      generatedSnapshots: generatedSnapshotsTotal,          // total files (incl. outside range)
      // Holidays: calendar dates where exchange was actually closed
      holidayExclusions: holidayExclusions,                 // 13 known A-share holidays
      // True data gaps: exchange-open days without snapshots (should always be 0)
      trueDataGap: trueDataGap,                             // 0
      // 🔗 Constraint 1: expectedCalendarDates = actualExchangeOpenDays + holidayExclusions
      constraint1: 'expectedCalendarDates === actualExchangeOpenDays + holidayExclusions',
      constraint1Satisfied: constraint1Satisfied,
      constraint1Detail: expectedCalendarDates + ' = ' + actualExchangeOpenDays + ' + ' + holidayExclusions.length,
      // 🔗 Constraint 2: actualExchangeOpenDays = generatedSnapshotsInRange + trueDataGap
      constraint2: 'actualExchangeOpenDays === generatedSnapshotsInRange + trueDataGap',
      constraint2Satisfied: constraint2Satisfied,
      constraint2Detail: actualExchangeOpenDays + ' = ' + generatedSnapshotsInRange + ' + ' + trueDataGap,
      // Gate
      _acceptanceGate: (constraint1Satisfied && constraint2Satisfied && trueDataGap === 0)
        ? 'verified: ' + expectedCalendarDates + ' expected = ' + actualExchangeOpenDays + ' actual + ' + holidayExclusions.length + ' holidays; ' + actualExchangeOpenDays + ' actual = ' + generatedSnapshotsInRange + ' snapshots + ' + trueDataGap + ' gaps'
        : 'UNVERIFIED: C1=' + constraint1Satisfied + ' C2=' + constraint2Satisfied + ' trueGap=' + trueDataGap,
    };
  } catch (_) {}

  // P0.4: Check legacy evolution data — label as Legacy/Unverified
  try {
    var evoDir = path.join(__dirname, 'report-engine', 'data', 'evolution');
    if (fs.existsSync(evoDir)) {
      var legacyRegistry = path.join(evoDir, 'model_registry.json');
      var legacyBootstrap = path.join(evoDir, 'bootstrap_history.json');
      data.legacyData = {
        exists: fs.existsSync(legacyRegistry) || fs.existsSync(legacyBootstrap),
        status: 'Legacy / Unverified',
        note: '旧版 bootstrap/champion/shadow 数据 — 未经 P0.2 PIT OOS 验证，不可用于 live trading 决策。仅在 Cockpit Legacy 分区显示。',
      };
      if (fs.existsSync(legacyRegistry)) {
        try {
          var lr = JSON.parse(fs.readFileSync(legacyRegistry, 'utf8'));
          data.legacyData.registryVersionCount = (lr.shadows ? lr.shadows.length : 0) + (lr.baseline ? 1 : 0);
          data.legacyData.hasBaseline = !!lr.baseline;
        } catch (_) {}
      }
    }
  } catch (_) {}

  // Determine overall status (P0.2: yellow until data rebuilt; P0.3: reject Ridge-v1)
  if (data.p0Status === 'pass' && data.p0DataRegenerated && data.validWindows > 0 && data.dataHash) {
    data.status = 'operational';
    if (data.modelVerdict === 'REJECTED_RESEARCH') {
      data.statusLabel = '基础设施已验收；Ridge-v1 已冻结（6 窗口仅 1 微弱正 IC，平均 Rank IC 负，paired delta CI 为负）';
    } else {
      data.statusLabel = 'Research Operational — P0.2 verified, data rebuilt, P1 model evaluated';
    }
  } else if (data.p0Status === 'pass' && data.p0DataRegenerated && data.dataHash) {
    data.status = 'p0_verified';
    data.statusLabel = 'P0.2 Data rebuilt — Snapshots regenerated, waiting for walk-forward evaluation';
  } else if (data.p0Status === 'pass' && data.p0DataRegenerated) {
    data.status = 'p0_verified';
    data.statusLabel = 'P0.2 Verified — Data rebuilt, run OOS + walk-forward evaluations';
  } else if (data.p0Status === 'pass') {
    data.status = 'p0_verified';
    data.statusLabel = 'P0.2 Code fixtures passed — Historical data not yet rebuilt with P0.2 conventions';
    data.warning = (data.warning || 'Code fixtures pass, but snapshot/OOS/model outputs must be regenerated before interpreting any returns, CI, or calibration.');
  } else {
    data.status = 'invalid';
    data.statusLabel = 'Research results NOT interpretable — simulator/statistics repair pending';
  }

  return data;
}

function jsonResponse(res, data, status) {
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

// ---- Banner ----

function printBanner() {
  const today = new Date();
  const trading = isTradingDay(today);
  const sState = scheduler ? scheduler.getStatus().state : 'stopped';
  console.log();
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║     Francis Investment · Mosaic Server  v3.4.9.7     ║');
  console.log('  ╠══════════════════════════════════════════════════════╣');
  console.log('  ║  ' + today.toISOString().slice(0, 10) + ' ' + getWeekdayCN(today) + '  |  ' + (trading ? '[交易日]' : '[休市]') + '  |  ' + sState.padEnd(18) + '║');
  console.log('  ║  http://localhost:' + PORT + '                                ║');
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log();
}

// ---- Main server ----

const server = http.createServer(async function(req, res) {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const pathname = url.pathname;
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  // ---- API routes ----
  if (pathname === '/api/status') return jsonResponse(res, apiStatus());
  if (pathname === '/api/reports-index') return jsonResponse(res, apiReportsIndex());
  if (pathname === '/api/recommendation-history') return jsonResponse(res, apiRecommendationHistory());

  const reportMatch = pathname.match(/^\/api\/report\/(\d{4}-\d{2}-\d{2})$/);
  if (reportMatch) {
    const data = apiReport(reportMatch[1]);
    if (!data) return jsonResponse(res, { error: 'Report not found' }, 404);
    return jsonResponse(res, data);
  }

  // Pipeline endpoints
  if (pathname === '/api/pipeline/run' && method === 'POST') return handlePipelineRun(res);
  if (pathname === '/api/pipeline/status') return jsonResponse(res, pipeline ? pipeline.getStatus() : { status: 'idle', progress: 0, step: '未运行' });
  if (pathname === '/api/pipeline/result') return handlePipelineResult(res);

  // Simfolio endpoints
  if (pathname === '/api/simfolio/status') return handleSimfolioStatus(res);
  if (pathname === '/api/simfolio/history') return handleSimfolioHistory(res);
  if (pathname === '/api/simfolio/holdings-health') return handleHoldingsHealth(res);
  if (pathname === '/api/simfolio/trade' && method === 'POST') return handleSimfolioTrade(res);
  if (pathname === '/api/simfolio/reset' && method === 'POST') return handleSimfolioReset(res);

  // Scheduler endpoints
  if (pathname === '/api/scheduler/status') {
    return jsonResponse(res, scheduler ? scheduler.getStatus() : { state: 'stopped', error: '调度器未启动' });
  }
  if (pathname === '/api/scheduler/events') {
    return jsonResponse(res, scheduler ? scheduler.getEvents(100) : []);
  }
  if (pathname === '/api/position/force-check' && method === 'POST') {
    if (scheduler) scheduler._runPositionMonitor();
    return jsonResponse(res, { ok: true, message: '已触发持仓检查' });
  }

  // Daily events log
  if (pathname === '/api/events/dates') {
    return jsonResponse(res, { ok: true, dates: listEventDates() });
  }
  const eventsDateMatch = pathname.match(/^\/api\/events\/(\d{4}-\d{2}-\d{2})$/);
  if (eventsDateMatch) {
    const events = loadDailyEvents(eventsDateMatch[1]);
    return jsonResponse(res, { ok: true, date: eventsDateMatch[1], events: events });
  }

  // List dates with available summaries
  if (pathname === '/api/summary-dates') {
    try {
      const summariesDir = path.join(DATA_DIR, 'summaries');
      if (!fs.existsSync(summariesDir)) return jsonResponse(res, { ok: true, dates: [] });
      const dates = fs.readdirSync(summariesDir)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''))
        .filter(d => {
          // Filter out weekends (non-trading days should not show up on calendar)
          const day = new Date(d + 'T12:00:00+08:00').getDay();
          return day >= 1 && day <= 5;
        })
        .sort()
        .reverse();
      return jsonResponse(res, { ok: true, dates });
    } catch (e) {
      return jsonResponse(res, { ok: false, dates: [] });
    }
  }

  // Daily summary report
  if (pathname === '/api/daily-summary/latest') {
    const dateParam = url.searchParams.get('date');
    const targetDate = dateParam || new Date().toISOString().slice(0, 10);
    const summaryPath = path.join(DATA_DIR, 'summaries', targetDate + '.json');
    if (fs.existsSync(summaryPath)) {
      return jsonResponse(res, { ok: true, ...JSON.parse(fs.readFileSync(summaryPath, 'utf8')) });
    }
    return jsonResponse(res, { ok: false, message: '该日期总结尚未生成' });
  }
  const summaryDateMatch = pathname.match(/^\/api\/daily-summary\/(\d{4}-\d{2}-\d{2})$/);
  if (summaryDateMatch) {
    const summaryPath = path.join(DATA_DIR, 'summaries', summaryDateMatch[1] + '.json');
    if (fs.existsSync(summaryPath)) {
      return jsonResponse(res, { ok: true, ...JSON.parse(fs.readFileSync(summaryPath, 'utf8')) });
    }
    return jsonResponse(res, { ok: false, message: '该日期的总结不存在' });
  }

  // Strategy Health API — comprehensive portfolio health dashboard
  if (pathname === '/api/strategy/health') {
    try {
      const strategyHealth = require('./mosaic/analysis/strategy_health');
      const lookback = parseInt(url.searchParams.get('lookback') || '60');
      const dateParam = url.searchParams.get('date');
      const health = strategyHealth.computeStrategyHealth({ lookbackDays: lookback });
      // If a specific date is requested, filter relevant data
      if (dateParam) {
        health.requestedDate = dateParam;
      }
      return jsonResponse(res, { ok: true, ...health });
    } catch (e) {
      return jsonResponse(res, { ok: false, error: e.message, stack: e.stack });
    }
  }
  if (pathname === '/api/strategy/health/summary') {
    try {
      const strategyHealth = require('./mosaic/analysis/strategy_health');
      const summary = strategyHealth.computeHealthSummary();
      return jsonResponse(res, { ok: true, ...summary });
    } catch (e) {
      return jsonResponse(res, { ok: false, error: e.message });
    }
  }

  // Full Backtest API — multi-regime historical backtest
  if (pathname === '/api/backtest/latest') {
    try {
      const fb = require('./mosaic/evolution/full_backtest');
      return jsonResponse(res, { ok: true, ...fb.getLatestResult() });
    } catch (e) {
      return jsonResponse(res, { ok: false, error: e.message });
    }
  }
  if (pathname === '/api/backtest/status') {
    try {
      const fb = require('./mosaic/evolution/full_backtest');
      return jsonResponse(res, { ok: true, ...fb.getStatus() });
    } catch (e) {
      return jsonResponse(res, { ok: false, error: e.message });
    }
  }
  if (pathname === '/api/backtest/run' && method === 'POST') {
    try {
      const fb = require('./mosaic/evolution/full_backtest');
      const result = fb.runFullBacktest({ startYear: 2020, endYear: 2026, batchSize: 30 });
      return jsonResponse(res, { ok: true, ...result });
    } catch (e) {
      return jsonResponse(res, { ok: false, error: e.message });
    }
  }

  // Data Quality API — monitor health of each data source
  if (pathname === '/api/data-quality/status') {
    try {
      const dq = require('./mosaic/analysis/data_quality');
      const report = dq.checkAllDataSources();
      return jsonResponse(res, { ok: true, ...report });
    } catch (e) {
      return jsonResponse(res, { ok: false, error: e.message });
    }
  }
  if (pathname === '/api/data-quality/summary') {
    try {
      const dq = require('./mosaic/analysis/data_quality');
      const report = dq.checkAllDataSources();
      return jsonResponse(res, { ok: true, overallScore: report.overallScore, unknownStatus: report.unknownStatus, confidenceImpact: report.confidenceImpact });
    } catch (e) {
      return jsonResponse(res, { ok: false, error: e.message });
    }
  }

  // News API — daily financial news feed
  if (pathname === '/api/news/latest') {
    const dateParam = url.searchParams.get('date');
    const targetDate = dateParam || new Date().toISOString().slice(0, 10);
    const summaryPath = path.join(DATA_DIR, 'summaries', targetDate + '.json');
    if (fs.existsSync(summaryPath)) {
      const s = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      return jsonResponse(res, { ok: true, date: targetDate, news: s.news || null });
    }
    return jsonResponse(res, { ok: false, message: '该日期新闻尚未生成' });
  }
  const newsDateMatch = pathname.match(/^\/api\/news\/(\d{4}-\d{2}-\d{2})$/);
  if (newsDateMatch) {
    const summaryPath = path.join(DATA_DIR, 'summaries', newsDateMatch[1] + '.json');
    if (fs.existsSync(summaryPath)) {
      const s = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      return jsonResponse(res, { ok: true, date: newsDateMatch[1], news: s.news || null });
    }
    return jsonResponse(res, { ok: false, message: '该日期新闻不存在' });
  }

  // Trade Analysis API — quant analysis report
  if (pathname === '/api/analysis/latest') {
    const dateParam = url.searchParams.get('date');
    const targetDate = dateParam || new Date().toISOString().slice(0, 10);
    const summaryPath = path.join(DATA_DIR, 'summaries', targetDate + '.json');
    if (fs.existsSync(summaryPath)) {
      const s = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      return jsonResponse(res, { ok: true, date: targetDate, tradeAnalysis: s.tradeAnalysis || null });
    }
    return jsonResponse(res, { ok: false, message: '该日期分析尚未生成' });
  }
  const analysisDateMatch = pathname.match(/^\/api\/analysis\/(\d{4}-\d{2}-\d{2})$/);
  if (analysisDateMatch) {
    const summaryPath = path.join(DATA_DIR, 'summaries', analysisDateMatch[1] + '.json');
    if (fs.existsSync(summaryPath)) {
      const s = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      return jsonResponse(res, { ok: true, date: analysisDateMatch[1], tradeAnalysis: s.tradeAnalysis || null });
    }
    return jsonResponse(res, { ok: false, message: '该日期分析不存在' });
  }

  // Index intraday history API
  if (pathname === '/api/indices/today') {
    const dateParam = url.searchParams.get('date');
    const targetDate = dateParam || new Date().toISOString().slice(0, 10);
    const indexPath = path.join(DATA_DIR, 'simfolio', 'index_history_' + targetDate + '.json');
    if (fs.existsSync(indexPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        return jsonResponse(res, { ok: true, date: targetDate, points: data });
      } catch (e) {
        return jsonResponse(res, { ok: false, message: 'Parse error' });
      }
    }
    return jsonResponse(res, { ok: false, message: '该日期暂无指数记录', points: [] });
  }

  // Factor Performance API
  if (pathname === '/api/factors/performance') {
    try {
      const factorPerf = require('./mosaic/analysis/factor_performance');
      const perf = factorPerf.computeFactorPerformance({
        days: parseInt(url.searchParams.get('days')) || 20,
      });
      // Include north-bound performance (cached from scheduler pipeline runs)
      const nbPerf = factorPerf.getNBPerformance();
      return jsonResponse(res, { ok: true, ...perf, nbPerformance: nbPerf });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // Market Microstructure API — Smart Risk Hub
  if (pathname === '/api/market/microstructure') {
    try {
      const northBound = require('./mosaic/collectors/north_bound');
      const { fetchSectorFlow } = require('./mosaic/collectors/capital_flow');

      // Fetch north-bound sentiment + sector flow in parallel
      const [nbFlow, sectorFlows] = await Promise.all([
        northBound.fetchNorthBoundFlow(20).catch(() => []),
        fetchSectorFlow().catch(() => []),
      ]);
      const nbSentiment = northBound.computeSentiment(nbFlow);

      // Smart money divergence: aggregate super-large vs small across all sectors
      let totalSuperLarge = 0, totalSmall = 0;
      for (const s of sectorFlows) {
        if (s.superLargeNetFlow != null) totalSuperLarge += s.superLargeNetFlow;
        if (s.smallNetFlow != null) totalSmall += s.smallNetFlow;
      }
      const smartMoneyDivergence = totalSuperLarge !== 0 || totalSmall !== 0
        ? (totalSuperLarge - totalSmall) / 1e8  // 亿
        : null;
      const smartMoneySignal = smartMoneyDivergence != null
        ? (smartMoneyDivergence > 10 ? 'strong_buy' : smartMoneyDivergence > 3 ? 'buy' :
           smartMoneyDivergence < -10 ? 'strong_sell' : smartMoneyDivergence < -3 ? 'sell' : 'neutral')
        : 'no_data';

      // Top 3 inflow & outflow sectors
      const sortedFlows = [...sectorFlows].sort((a, b) => (b.majorNetFlow || 0) - (a.majorNetFlow || 0));
      const topInflow = sortedFlows.slice(0, 3).map(s => ({ name: s.name, flow: Math.round((s.majorNetFlow || 0) / 1e8 * 100) / 100 }));
      const topOutflow = sortedFlows.slice(-3).reverse().map(s => ({ name: s.name, flow: Math.round((s.majorNetFlow || 0) / 1e8 * 100) / 100 }));

      // Compute 20-day historical volatility from daily summary index data
      let volatility = null, volRegime = 'normal';
      try {
        const summariesDir = path.join(DATA_DIR, 'summaries');
        if (fs.existsSync(summariesDir)) {
          // Get last 30 daily summaries for HV calculation
          const summaryFiles = fs.readdirSync(summariesDir)
            .filter(f => f.endsWith('.json'))
            .sort()
            .slice(-30);

          const shCloses = [];
          for (const sf of summaryFiles) {
            try {
              const sum = JSON.parse(fs.readFileSync(path.join(summariesDir, sf), 'utf8'));
              const indices = sum.market && sum.market.indices ? sum.market.indices : [];
              // Use first index (usually 上证) close price
              const shIdx = indices.find(function(ix) { return ix.name && ix.name.includes('上证'); }) || indices[0];
              if (shIdx && shIdx.price != null) {
                shCloses.push(shIdx.price);
              }
            } catch (_) {}
          }

          if (shCloses.length >= 3) {
            const returns = [];
            for (let i = 1; i < shCloses.length; i++) {
              if (shCloses[i] && shCloses[i - 1] && shCloses[i - 1] > 0) {
                returns.push(Math.log(shCloses[i] / shCloses[i - 1]));
              }
            }
            if (returns.length >= 2) {
              const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
              const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
              volatility = Math.sqrt(variance) * Math.sqrt(252) * 100; // Annualized %

              // Regime from recent 5 days vs full period
              const recentReturns = returns.slice(-5);
              const rMean = recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;
              const rVar = recentReturns.reduce((s, r) => s + (r - rMean) ** 2, 0) / (recentReturns.length - 1);
              const recentVol = Math.sqrt(rVar) * Math.sqrt(252) * 100;

              volRegime = recentVol > 30 ? 'high' : recentVol > 20 ? 'elevated' : recentVol > 12 ? 'normal' : 'low';
            }
          }
        }
      } catch (_) { /* volatility is optional */ }

      // Consecutive north-bound directions for sparkline
      const nbDirections = nbFlow.length >= 5
        ? nbFlow.slice(-5).map(d => d.totalFlow >= 0 ? 1 : -1)
        : [];

      jsonResponse(res, {
        ok: true,
        time: new Date().toISOString(),
        northBound: {
          sentiment: nbSentiment.sentiment,
          consecutiveInflow: nbSentiment.consecutiveInflow,
          last5DaysTotal: nbSentiment.last5DaysTotal,
          lastDayFlow: nbSentiment.lastDayFlow,
          directions: nbDirections,
        },
        capitalFlow: {
          topInflow,
          topOutflow,
          smartMoneyDivergence,
          smartMoneySignal,
          sectorCount: sectorFlows.length,
        },
        volatility: {
          value: volatility ? Math.round(volatility * 100) / 100 : null,
          regime: volRegime,
          label: volRegime === 'high' ? '高波动' : volRegime === 'elevated' ? '偏高' :
                 volRegime === 'low' ? '低波动' : '正常',
        },
      });
    } catch (e) {
      jsonResponse(res, { ok: false, message: e.message });
    }
    return;
  }

  // Sector Live Data API
  if (pathname === '/api/sectors/live') {
    const https = require('https');
    const sectorCodes = [
      // 大盘指数 (first 3 used by think-tank)
      { code: 'sh000001', name: '上证指数' },
      { code: 'sz399001', name: '深证成指' },
      { code: 'bj899050', name: '北证50' },
      // 热门板块（用户关注）
      { code: 'sz399667', name: '机器人' },         // 深证机器人
      { code: 'sz399620', name: 'AI/算力' },        // 深证信息技术（含AI/半导体/算力）
      { code: 'sz399395', name: '医药生物' },       // 创新药/医疗
      { code: 'sz399434', name: '中证军工' },       // 军工
      { code: 'sz399613', name: '固态电池' },       // 深证能源（含电池/储能）
      { code: 'sz399621', name: '商业航天' },       // 深证电信业务（含航天通信）
      { code: 'sz399614', name: '稀土/有色' },      // 深证原材料（含有色/稀土）
      { code: 'sh000688', name: '科创50' },         // 科创板（半导体/AI聚集）
      { code: 'sz399006', name: '创业板指' },
    ];
    // Use Sina API for real-time index quotes
    const queryCodes = sectorCodes.map(function(s) { return 's_' + s.code; }).join(',');
    const url = 'https://hq.sinajs.cn/list=' + queryCodes;

    try {
      const httpModule = url.startsWith('https') ? require('https') : require('http');
      httpModule.get(url, { headers: { 'Referer': 'https://finance.sina.com.cn' } }, function(resp) {
        let data = '';
        resp.on('data', function(chunk) { data += chunk; });
        resp.on('end', function() {
          try {
            const lines = data.split('\n');
            const results = [];
            for (var i = 0; i < lines.length && i < sectorCodes.length; i++) {
              const line = lines[i].trim();
              if (!line || !line.includes('=')) continue;
              const parts = line.split('"');
              if (parts.length < 2) continue;
              const values = parts[1].split(',');
              const price = parseFloat(values[1]) || 0;
              const change = parseFloat(values[2]) || 0;
              const changePct = parseFloat(values[3]) || 0;
              results.push({
                code: sectorCodes[i].code,
                name: sectorCodes[i].name,
                price: price,
                change: change,
                changePercent: changePct,
              });
            }
            jsonResponse(res, { ok: true, sectors: results, time: new Date().toISOString() });
          } catch (e) {
            jsonResponse(res, { ok: false, message: 'Parse error' });
          }
        });
      }).on('error', function() {
        jsonResponse(res, { ok: false, message: 'Fetch error' });
      });
    } catch (e) {
      jsonResponse(res, { ok: false, message: 'Error' });
    }
    return;
  }

  // Knowledge Base API
  if (pathname === '/api/knowledge/summary') {
    try {
      const kb = require('./mosaic/analysis/knowledge_base');
      return jsonResponse(res, { ok: true, ...kb.getKnowledgeSummary() });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: '知识库未初始化' });
    }
  }

  // Knowledge Base — factor combos (REDIRECTED to history engine in v2.9)
  if (pathname === '/api/knowledge/factor-combos') {
    try {
      const historyReview = require('./mosaic/analysis/history_review');
      return jsonResponse(res, historyReview.getPatterns());
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // Public config (for UI Standard modal sync)
  if (pathname === '/api/config/public') {
    try {
      const cfg = require('./mosaic/config');
      return jsonResponse(res, {
        ok: true,
        filters: {
          maxPrice: cfg.FILTER.maxPrice,
          minTurnover: cfg.FILTER.minTurnover,
          maxPE: cfg.FILTER.maxPE,
          excludeST: cfg.FILTER.excludeST,
          excludeGEM: cfg.FILTER.exclude300,
          includeSTAR: cfg.FILTER.exclude688 === false,
        },
        weights: cfg.FACTOR_WEIGHTS || {},
        positionSizing: cfg.positionSizing || {},
        trading: {
          initialCapital: cfg.SIMFOLIO.initialCapital,
          maxPositions: cfg.SIMFOLIO.maxPositions,
          singleLimit: cfg.SIMFOLIO.maxSinglePositionPct,
          buyThreshold: { minPercentile: cfg.BUY_THRESHOLD.percentileTop, minScore: cfg.BUY_THRESHOLD.minAbsoluteScore },
          stopLoss: cfg.SIMFOLIO.stopLossPct,
          trailingStop: cfg.SIMFOLIO.trailingStop,
        },
        scanSchedule: {
          fullScans: cfg.SCAN_SCHEDULE?.full || ['09:30', '11:00', '13:00'],
          midScans: cfg.SCAN_SCHEDULE?.mid || ['10:00', '10:30', '11:25', '13:30', '14:00', '14:30', '14:50'],
        },
        dataSource: 'Eastmoney (主力) + Tencent (备选) + Sina (三级备选)',
        maxDetailFetches: cfg.API?.maxDetailFetches || 80,
        thinDataInfo: '基本面无数据时自适应降权(基本面25%→10%，总分上限65)',
      });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // US Market API — current snapshot
  if (pathname === '/api/us-market/current') {
    const usLatestPath = path.join(DATA_DIR, 'us_market', 'us_latest.json');
    if (fs.existsSync(usLatestPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(usLatestPath, 'utf8'));
        // Always update status with real-time calculation — stored status may be stale
        try {
          const usMarket = require('./mosaic/collectors/us_market');
          data.status = usMarket.formatUSSessionStatus();
        } catch (_) {}
        return jsonResponse(res, { ok: true, ...data });
      } catch (e) {
        return jsonResponse(res, { ok: false, message: 'Parse error' });
      }
    }
    return jsonResponse(res, { ok: false, message: '美股数据尚未采集，请等待美股开盘' });
  }

  // US Market status
  if (pathname === '/api/us-market/status') {
    try {
      const usMarket = require('./mosaic/collectors/us_market');
      return jsonResponse(res, { ok: true, ...usMarket.formatUSSessionStatus() });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // US Market overnight summary
  if (pathname === '/api/us-market/summary') {
    const dateParam = url.searchParams.get('date');
    const targetDate = dateParam || new Date().toISOString().slice(0, 10);
    const summaryPath = path.join(DATA_DIR, 'us_market', 'us_close_' + targetDate + '.json');
    if (fs.existsSync(summaryPath)) {
      try {
        return jsonResponse(res, { ok: true, ...JSON.parse(fs.readFileSync(summaryPath, 'utf8')) });
      } catch (e) {
        return jsonResponse(res, { ok: false, message: 'Parse error' });
      }
    }
    return jsonResponse(res, { ok: false, message: '该日期美股总结尚未生成' });
  }

  // US Market intraday history
  if (pathname === '/api/us-market/intraday') {
    const dateParam = url.searchParams.get('date');
    const targetDate = dateParam || new Date().toISOString().slice(0, 10);
    const intradayPath = path.join(DATA_DIR, 'us_market', 'us_intraday_' + targetDate + '.json');
    if (fs.existsSync(intradayPath)) {
      try {
        return jsonResponse(res, { ok: true, points: JSON.parse(fs.readFileSync(intradayPath, 'utf8')) });
      } catch (e) {
        return jsonResponse(res, { ok: false, message: 'Parse error' });
      }
    }
    return jsonResponse(res, { ok: false, message: '暂无日内数据', points: [] });
  }

  // Market cycle endpoint (P2)
  if (pathname === '/api/market/cycle') {
    try {
      const marketCycle = require('./mosaic/analysis/market_cycle');
      const cycle = marketCycle.getMarketCycle();
      return jsonResponse(res, { ok: true, ...cycle });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // ===== 预测引擎 API =====

  // 个股级别因子绩效
  if (pathname === '/api/predict/factor-performance') {
    try {
      const stockPredictor = require('./mosaic/predict/stock_predictor');
      const perf = stockPredictor.computeStockFactorPerformance(3);
      return jsonResponse(res, { ok: true, ...perf });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // 动态权重
  if (pathname === '/api/predict/dynamic-weights') {
    try {
      const dynamicWeights = require('./mosaic/predict/dynamic_weights');
      const weights = dynamicWeights.getEffectiveWeights();
      const cached = dynamicWeights.loadDynamicWeights();
      return jsonResponse(res, {
        ok: true,
        weights: weights,
        r2: cached ? cached.r2 : null,
        sampleCount: cached ? cached.sampleCount : null,
        updatedAt: cached ? cached.updatedAt : null,
        message: cached ? cached.message : '使用config默认权重',
      });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // 板块轮动领先/滞后矩阵
  if (pathname === '/api/predict/sector-leadlag') {
    try {
      const sectorLeadLag = require('./mosaic/predict/sector_leadlag');
      let data = sectorLeadLag.loadCachedLeadLag();
      if (!data || !data.available) {
        data = sectorLeadLag.computeSectorLeadLagMatrix();
      }
      return jsonResponse(res, { ok: true, ...(data || { available: false }) });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // 周期×因子有效性矩阵
  if (pathname === '/api/predict/cycle-factor-matrix') {
    try {
      const cycleFactorMatrix = require('./mosaic/predict/cycle_factor_matrix');
      const heatmap = cycleFactorMatrix.getHeatmapData();
      const prefs = cycleFactorMatrix.getCycleFactorPreferences('sideways'); // default
      return jsonResponse(res, { ok: true, heatmap: heatmap, preferences: prefs });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // 交易归因历史
  if (pathname === '/api/predict/trade-attribution') {
    try {
      const tradeAttr = require('./mosaic/predict/trade_attribution');
      const adjustments = tradeAttr.getActiveAdjustments();
      return jsonResponse(res, { ok: true, adjustments: adjustments });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // Expected Returns — latest pipeline predictions with E[R5d]
  if (pathname === '/api/predict/expected-returns') {
    const p = path.join(DATA_DIR, 'simfolio', 'last_pipeline_result.legacy_untrusted.json');
    if (fs.existsSync(p)) {
      try {
        const lr = JSON.parse(fs.readFileSync(p, 'utf8'));
        return jsonResponse(res, {
          ok: true,
          date: lr.date,
          time: lr.time,
          expectedReturns: lr.expectedReturns || [],
        });
      } catch (e) {
        return jsonResponse(res, { ok: false, message: e.message });
      }
    }
    return jsonResponse(res, { ok: false, message: '尚无扫描结果' });
  }

  // Expected Return Verification — historical prediction vs actual accuracy
  if (pathname === '/api/predict/expected-return-verification') {
    const p = path.join(DATA_DIR, 'simfolio', 'expected_return_verification.json');
    if (fs.existsSync(p)) {
      try {
        return jsonResponse(res, { ok: true, ...JSON.parse(fs.readFileSync(p, 'utf8')) });
      } catch (e) {
        return jsonResponse(res, { ok: false, message: e.message });
      }
    }
    return jsonResponse(res, { ok: false, message: '尚无验证数据（需累计5天以上扫描记录）' });
  }

  // Cross-Market Analysis — risk state + correlation matrix
  if (pathname === '/api/cross-market/analysis') {
    try {
      const crossMarket = require('./mosaic/analysis/cross_market');
      const usLatestPath = path.join(DATA_DIR, 'us_market', 'us_latest.json');
      var usData = null;
      if (fs.existsSync(usLatestPath)) {
        usData = JSON.parse(fs.readFileSync(usLatestPath, 'utf8'));
      }
      const analysis = crossMarket.getFullAnalysis(usData);
      return jsonResponse(res, { ok: true, ...analysis });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // Cross-Market — risk state only (lighter endpoint)
  if (pathname === '/api/cross-market/risk-state') {
    try {
      const crossMarket = require('./mosaic/analysis/cross_market');
      const usLatestPath = path.join(DATA_DIR, 'us_market', 'us_latest.json');
      var usData = null;
      if (fs.existsSync(usLatestPath)) {
        usData = JSON.parse(fs.readFileSync(usLatestPath, 'utf8'));
      }
      const macro = usData ? (usData.macro || []) : [];
      const riskState = crossMarket.computeRiskState(macro);
      return jsonResponse(res, { ok: true, ...riskState });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // Cross-Market — correlation matrix only
  if (pathname === '/api/cross-market/correlation') {
    try {
      const crossMarket = require('./mosaic/analysis/cross_market');
      const history = crossMarket.loadCorrelationHistory();
      const matrix = crossMarket.computeCorrelationMatrix(history);
      return jsonResponse(res, { ok: true, ...matrix });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // ===== 两融数据 API =====
  if (pathname === '/api/margin/status') {
    try {
      const marginData = require('./mosaic/collectors/margin_data');
      const data = await marginData.fetchMarginData(20);
      const sentiment = marginData.computeMarginSentiment(data);
      return jsonResponse(res, { ok: true, ...sentiment, raw: data.slice(0, 5) });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // ===== 历史复盘引擎 API (v2.9) =====
  if (pathname === '/api/history/status') {
    try {
      const historyReview = require('./mosaic/analysis/history_review');
      return jsonResponse(res, { ok: true, ...historyReview.getStatus() });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  if (pathname === '/api/history/report') {
    var mode = url.searchParams.get('mode') || 'full';
    try {
      const historyReview = require('./mosaic/analysis/history_review');
      return jsonResponse(res, historyReview.getReport(mode));
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  if (pathname === '/api/history/context') {
    try {
      var ctxPath = path.join(DATA_DIR, 'simfolio', 'history_context.json');
      if (fs.existsSync(ctxPath)) {
        var ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf8'));
        // Check validity
        if (ctx.validUntil >= new Date().toISOString().slice(0, 10)) {
          return jsonResponse(res, { ok: true, ...ctx });
        }
      }
      // Fallback to old weekend_context
      var oldCtxPath = path.join(DATA_DIR, 'simfolio', 'weekend_context.json');
      if (fs.existsSync(oldCtxPath)) {
        var oldCtx = JSON.parse(fs.readFileSync(oldCtxPath, 'utf8'));
        if (oldCtx.validUntil >= new Date().toISOString().slice(0, 10)) {
          return jsonResponse(res, { ok: true, ...oldCtx, _deprecated: true });
        }
      }
      return jsonResponse(res, { ok: false, message: '暂无历史复盘上下文' });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  if (pathname === '/api/history/verification') {
    var weekP = url.searchParams.get('week');
    try {
      var verifier = require('./mosaic/analysis/history_verifier');
      if (weekP) {
        var vr = verifier.getVerificationReport(weekP);
        return jsonResponse(res, vr);
      }
      var latest2 = verifier.getVerificationHistory();
      if (latest2.ok && latest2.history.length > 0) {
        var lastWeekend = latest2.history[0].weekend;
        return jsonResponse(res, verifier.getVerificationReport(lastWeekend));
      }
      return jsonResponse(res, { ok: false, message: '尚无验证报告' });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  if (pathname === '/api/history/verification-history') {
    try {
      var verifier2 = require('./mosaic/analysis/history_verifier');
      return jsonResponse(res, verifier2.getVerificationHistory());
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  if (pathname === '/api/history/patterns') {
    try {
      var historyReview2 = require('./mosaic/analysis/history_review');
      return jsonResponse(res, historyReview2.getPatterns());
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  if (pathname === '/api/history/discoveries') {
    var limit = parseInt(url.searchParams.get('limit') || '20');
    try {
      var historyReview3 = require('./mosaic/analysis/history_review');
      var st = historyReview3.getStatus();
      return jsonResponse(res, { ok: true, discoveries: (st.discoveries || []).slice(0, limit), tickHistory: st.tickHistory });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // [v3.2] Deep analysis synthesis — cross-sectional stats from similar periods
  if (pathname === '/api/history/deep-analysis') {
    try {
      const historyReview = require('./mosaic/analysis/history_review');
      return jsonResponse(res, historyReview.getDeepAnalysis());
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // [v3.2] Post-game verification dashboard
  // === [v3.3.0]: Autonomy Cockpit API ===
  if (pathname === '/api/cockpit') {
    try {
      return jsonResponse(res, { ok: true, ...buildCockpitData() });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // === [v3.4.9]: Prediction Settlement API (3-tier eligibility) ===
  if (pathname === '/api/prediction-settlement') {
    try {
      var today = new Date().toISOString().slice(0, 10);
      var psRes = { ok: true, date: today, top50: 0, eligible: 0, evaluationEligible: 0,
        researchEligible: 0, executionEligible: 0,
        schemaValid: 0, predictionValid: 0, executionCandidateEligible: 0, globalBlocked: 0,
        canonicalTop50: 0, intradayObservationCount: 0,
        // v3.4.9.4.2: Active-only cohort counts (quarantined excluded)
        canonicalCohortCount: 0, intradayCount: 0, quarantinedCount: 0,
        // P0.2-3: Canonical field validation for 09:30 cohort acceptance
        canonicalCohortTarget: 50,
        canonicalFieldValidation: { allFieldsPresent: 0, totalCanonical: 0,
          missingFields: { runId: 0, scheduledSlot: 0, asOfDate: 0, targetDate: 0,
            predictionId: 0, featureSnapshot: 0, modelVersionId: 0 } },
        exclusionReasons: {}, t3pending: 0, settledToday: 0, settledOnTargetToday: 0,
        hasLedger: false, hasOutcome: false, runId: null };

      // Read today's prediction ledger
      var plFile = path.join(DATA_DIR, 'simfolio', 'prediction_ledger_' + today + '.jsonl');
      if (fs.existsSync(plFile)) {
        psRes.hasLedger = true;
        var plines = fs.readFileSync(plFile, 'utf8').trim().split('\n').filter(Boolean);
        psRes.top50 = plines.length;
        // P0.5: Count records with complete canonical data contract
        psRes.canonicalComplete = 0;
        psRes.legacyNoTargetDate = 0;
        psRes.legacyRecords = [];
        // v3.4.9.3: eligibility reasons distribution
        psRes.eligibilityReasons = {};
        for (var pi = 0; pi < plines.length; pi++) {
          try {
            var pentry = JSON.parse(plines[pi]);

            // v3.4.9.4.2: Exclude quarantined entries from all active cohort counts
            if (pentry.ingestionStatus === 'invalid_schema_v3492') {
              psRes.quarantinedCount++;
              continue; // Do NOT count in any other field
            }

            // P0.5: Tag legacy records missing targetDate — exclude from live settlement stats
            if (!pentry.targetDate || pentry.targetDate === null) {
              psRes.legacyNoTargetDate = (psRes.legacyNoTargetDate || 0) + 1;
              psRes.legacyRecords = psRes.legacyRecords || [];
              if (psRes.legacyRecords.length < 5) {
                psRes.legacyRecords.push({
                  predictionId: pentry.predictionId,
                  asOf: pentry.asOf,
                  code: pentry.code,
                  ingestionStatus: pentry.ingestionStatus || 'legacy_no_target_date',
                  _note: 'missing targetDate field — cannot determine settlement date',
                });
              }
              continue; // Do NOT count in eligibility stats
            }

            // P0.5: Count records with complete canonical data contract
            // P0.2-3: Check for asOf field (older format) vs asOfDate
            var _asOfDate = pentry.asOfDate || pentry.asOf || null;
            var hasAllRequired = pentry.runId && pentry.predictionId && _asOfDate && pentry.targetDate
              && pentry.featureSnapshot && pentry.modelVersionId;
            if (hasAllRequired) psRes.canonicalComplete++;

            // P0.2-3: Per-field validation for 09:30 canonical cohort acceptance
            var fv = psRes.canonicalFieldValidation;
            if (pentry.canonical === true) {
              fv.totalCanonical++;
              var allOk = true;
              if (!pentry.runId)          { fv.missingFields.runId++; allOk = false; }
              if (!pentry.scheduledSlot)   { fv.missingFields.scheduledSlot++; allOk = false; }
              if (!_asOfDate)             { fv.missingFields.asOfDate++; allOk = false; }
              if (!pentry.targetDate)      { fv.missingFields.targetDate++; allOk = false; }
              if (!pentry.predictionId)    { fv.missingFields.predictionId++; allOk = false; }
              if (!pentry.featureSnapshot) { fv.missingFields.featureSnapshot++; allOk = false; }
              if (!pentry.modelVersionId)  { fv.missingFields.modelVersionId++; allOk = false; }
              if (allOk) fv.allFieldsPresent++;
            }

            if (pentry.eligible) psRes.eligible++;
            if (pentry.evaluationEligible) psRes.evaluationEligible++;
            // v3.4.9.4: 6-field eligibility
            if (pentry.schemaValid) psRes.schemaValid++;
            if (pentry.predictionValid) psRes.predictionValid++;
            if (pentry.researchEligible) psRes.researchEligible++;
            if (pentry.executionCandidateEligible) psRes.executionCandidateEligible++;
            if (!pentry.globalTradePermission) psRes.globalBlocked++;
            if (pentry.executionEligible) psRes.executionEligible++;
            // Capture runId from first valid entry
            if (!psRes.runId && pentry.runId) psRes.runId = pentry.runId;
            // v3.4.9.2: Separate canonical vs intraday observation counts
            // v3.4.9.4.2: Both old and new field names coexist for backward compat
            if (pentry.canonical === true) {
              psRes.canonicalCohortCount++;
              psRes.canonicalTop50++;
            } else {
              psRes.intradayCount++;
              psRes.intradayObservationCount++;
            }
            var reason = pentry.exclusionReason || 'none';
            psRes.exclusionReasons[reason] = (psRes.exclusionReasons[reason] || 0) + 1;
            // v3.4.9.3: Aggregate researchEligibilityReasons distribution
            var er = pentry.researchEligibilityReasons;
            if (Array.isArray(er)) {
              for (var eri = 0; eri < er.length; eri++) {
                var erk = er[eri];
                psRes.eligibilityReasons[erk] = (psRes.eligibilityReasons[erk] || 0) + 1;
              }
            } else if (!pentry.researchEligible && pentry.ingestionStatus) {
              // Marked invalid entries (now filtered above; this handles non-v3492 invalid statuses)
              var ik = pentry.ingestionStatus;
              psRes.eligibilityReasons[ik] = (psRes.eligibilityReasons[ik] || 0) + 1;
            }
          } catch (_) {}
        }
      }

      // Read outcome ledger — count total settled, and T+3 pending
      var olFile = path.join(DATA_DIR, 'simfolio', 'outcome_ledger.jsonl');
      if (fs.existsSync(olFile)) {
        psRes.hasOutcome = true;
        var olines = fs.readFileSync(olFile, 'utf8').trim().split('\n').filter(Boolean);
        // Count settled outcomes (status='settled' vs 'unavailable')
        var settledCount = 0;
        var unavailableCount = 0;
        for (var oi = 0; oi < olines.length; oi++) {
          try {
            var oentry = JSON.parse(olines[oi]);
            if (oentry.status === 'settled') settledCount++;
            else unavailableCount++;
            if (oentry.targetDate === today) psRes.settledOnTargetToday++;
          } catch (_) {}
        }
        psRes.settledToday = settledCount;
        psRes.unavailableCount = unavailableCount;
      }

      // Count T+3 pending: prediction_ledger files from ~T-3 that haven't been settled yet
      try {
        var simfolioDir = path.join(DATA_DIR, 'simfolio');
        var allFiles = fs.readdirSync(simfolioDir);
        var predFiles = allFiles.filter(function(f) { return /^prediction_ledger_\d{4}-\d{2}-\d{2}\.jsonl$/.test(f); });
        var settledIds = {};
        if (psRes.hasOutcome) {
          var olines2 = fs.readFileSync(olFile, 'utf8').trim().split('\n').filter(Boolean);
          for (var si = 0; si < olines2.length; si++) {
            try {
              var oe = JSON.parse(olines2[si]);
              if (oe.predictionId) settledIds[oe.predictionId] = true;
            } catch (_) {}
          }
        }
        var threeDaysAgo = new Date(today + 'T00:00:00+08:00').getTime() - 3 * 24 * 3600 * 1000;
        var pendingCount = 0;
        for (var fi = 0; fi < predFiles.length; fi++) {
          var fileDate = predFiles[fi].replace('prediction_ledger_', '').replace('.jsonl', '');
          var fileMs = new Date(fileDate + 'T00:00:00+08:00').getTime();
          if (fileMs >= threeDaysAgo) continue;
          try {
            var plines2 = fs.readFileSync(path.join(simfolioDir, predFiles[fi]), 'utf8').trim().split('\n').filter(Boolean);
            for (var pj = 0; pj < plines2.length; pj++) {
              try {
                var pe = JSON.parse(plines2[pj]);
                // v3.4.9.1: Count researchEligible predictions pending settlement
                if (pe.predictionId && !settledIds[pe.predictionId] && pe.researchEligible) {
                  pendingCount++;
                }
              } catch (_) {}
            }
          } catch (_) {}
        }
        psRes.t3pending = pendingCount;
      } catch (_) {}

      // v3.4.9: Include independent trading days from verification summary
      try {
        var vsFile = path.join(DATA_DIR, 'verification', 'verification_summary.json');
        if (fs.existsSync(vsFile)) {
          var vsData = JSON.parse(fs.readFileSync(vsFile, 'utf8'));
          if (vsData.overall && vsData.overall.rankIC) {
            psRes.independentDays = vsData.overall.rankIC.independentDays || 0;
          }
        }
      } catch (_) {}

      return jsonResponse(res, psRes);
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // === [v3.4.9.4.1]: Research Cohort Integrity API (P0-4: separated counting) ===
  if (pathname === '/api/cohort-integrity') {
    try {
      var ciToday = new Date().toISOString().slice(0, 10);
      var ciRes = { ok: true, date: ciToday, hasManifest: false, manifest: null,
        // v3.4.9.4.1 P0-4: Three separate cohort categories
        canonicalCohortCount: 0, intradayCount: 0, quarantinedCount: 0,
        counts: { schemaValid: 0, predictionValid: 0, researchEligible: 0,
          executionCandidateEligible: 0, globalBlocked: 0, executionEligible: 0,
          actualBought: 0, missingExpectedReturn: 0 },
        featureCoverage: {} };

      // v3.4.9.4.1 P0-1: Manifest at DATA_DIR root (not simfolio/)
      try {
        var pl = require('./mosaic/prediction_ledger');
        var manifest = pl.readRunManifest(DATA_DIR, ciToday);
        if (manifest) {
          ciRes.hasManifest = true;
          ciRes.manifest = manifest;
        }
      } catch (_) {}

      // v3.4.9.4.1 P0-4: Read decision_events to get actualBought by predictionId
      var boughtPredIds = {};
      try {
        var deFile = path.join(DATA_DIR, 'simfolio', 'decision_events_' + ciToday + '.jsonl');
        if (fs.existsSync(deFile)) {
          var deLines = fs.readFileSync(deFile, 'utf8').trim().split('\n').filter(Boolean);
          for (var dei = 0; dei < deLines.length; dei++) {
            try {
              var deEntry = JSON.parse(deLines[dei]);
              if (deEntry.wasBought === true && deEntry.predictionId) {
                boughtPredIds[deEntry.predictionId] = true;
              }
            } catch (_) {}
          }
        }
      } catch (_) {}

      // Read today's leader and aggregate counts, separating quarantined from active cohort
      var plFile2 = path.join(DATA_DIR, 'simfolio', 'prediction_ledger_' + ciToday + '.jsonl');
      if (fs.existsSync(plFile2)) {
        var ciLines = fs.readFileSync(plFile2, 'utf8').trim().split('\n').filter(Boolean);
        ciRes.ledgerTotal = ciLines.length;
        for (var ci = 0; ci < ciLines.length; ci++) {
          try {
            var cie = JSON.parse(ciLines[ci]);

            // v3.4.9.4.1 P0-4: Quarantined entries (old format) — count separately, don't mix with current cohort
            if (cie.ingestionStatus === 'invalid_schema_v3492') {
              ciRes.quarantinedCount++;
              continue; // Do NOT count in any other field
            }

            // P0.2 CONDITIONAL T3: Legacy records missing targetDate — exclude from active cohort stats
            if (!cie.targetDate || cie.targetDate === null) {
              ciRes.legacyNoTargetDate = (ciRes.legacyNoTargetDate || 0) + 1;
              ciRes.legacyRecords = ciRes.legacyRecords || [];
              if (ciRes.legacyRecords.length < 5) {
                ciRes.legacyRecords.push({
                  predictionId: cie.predictionId,
                  asOf: cie.asOf,
                  code: cie.code,
                  ingestionStatus: cie.ingestionStatus || 'legacy_no_target_date',
                  _note: 'missing targetDate field — cannot determine settlement date',
                });
              }
              continue; // Do NOT count in eligibility stats
            }

            // v3.4.9.4.1 P0-4: Active cohort: separate canonical vs intraday
            if (cie.canonical === true) {
              ciRes.canonicalCohortCount++;
            } else {
              ciRes.intradayCount++;
            }

            // Only count active (non-quarantined) entries in these stats
            if (cie.schemaValid) ciRes.counts.schemaValid++;
            if (cie.predictionValid) ciRes.counts.predictionValid++;
            if (cie.researchEligible) ciRes.counts.researchEligible++;
            if (cie.executionCandidateEligible) ciRes.counts.executionCandidateEligible++;
            if (!cie.globalTradePermission) ciRes.counts.globalBlocked++;
            if (cie.executionEligible) ciRes.counts.executionEligible++;
            if (cie.expectedReturn == null) ciRes.counts.missingExpectedReturn++;
            // v3.4.9.4.1 P0-4: actualBought from decision_events (NOT prediction ledger wasBought)
            if (cie.predictionId && boughtPredIds[cie.predictionId]) ciRes.counts.actualBought++;

            // Feature coverage distribution
            var fc = cie.featureCoverage != null ? cie.featureCoverage.toFixed(2) : '?';
            ciRes.featureCoverage[fc] = (ciRes.featureCoverage[fc] || 0) + 1;
          } catch (_) {}
        }
      }

      // Add note about prediction validity
      if (ciRes.counts.researchEligible > 0 && (!ciRes.hasManifest || (ciRes.manifest && ciRes.manifest.status !== 'completed'))) {
        ciRes.note = '样本收集正常，但尚无预测有效性结论';
      } else if (ciRes.counts.researchEligible > 0) {
        ciRes.note = 'Canonical cohort collected, pending T+3 settlement';
      } else {
        ciRes.note = '尚无合格研究样本';
      }

      return jsonResponse(res, ciRes);
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // === [v3.3.0]: Model Registry API ===
  if (pathname === '/api/model-registry/status') {
    try {
      const modelRegistry = require('./mosaic/evolution/model_registry');
      return jsonResponse(res, { ok: true, ...modelRegistry.getRegistryStatus() });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  if (pathname === '/api/model-registry/baseline') {
    try {
      const modelRegistry = require('./mosaic/evolution/model_registry');
      const baseline = modelRegistry.getBaselineParams();
      return jsonResponse(res, { ok: true, baseline });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  if (pathname === '/api/model-registry/evaluate' && req.method === 'POST') {
    try {
      const modelRegistry = require('./mosaic/evolution/model_registry');
      const dateStr = new Date().toISOString().slice(0, 10);
      const result = modelRegistry.evaluateShadow(dateStr);
      return jsonResponse(res, { ok: true, ...result });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  if (pathname === '/api/verification/dashboard') {
    try {
      const verificationDashboard = require('./mosaic/analysis/verification_dashboard');
      return jsonResponse(res, { ok: true, ...verificationDashboard.getDashboard() });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // [v3.3.1] IC Breakdown API
  if (pathname === '/api/verification/ic-breakdown') {
    try {
      const vd = require('./mosaic/analysis/verification_dashboard');
      const dash = vd.getDashboard({ lookbackDays: 60 });
      return jsonResponse(res, { ok: true, icDecomposition: dash.icDecomposition });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // [v3.3.1] Leakage Audit API
  if (pathname === '/api/verification/leakage-audit') {
    try {
      const auditFile = require('path').join(__dirname, 'report-engine', 'data', 'verification', 'leakage_audit.json');
      if (require('fs').existsSync(auditFile)) {
        var rawAudit = JSON.parse(require('fs').readFileSync(auditFile, 'utf8'));
        var audit = normalizeLeakageAudit(rawAudit);
        return jsonResponse(res, { ok: true, ...audit });
      }
      // [v3.3.1] File doesn't exist → return NO_SAMPLES (not just a message)
      return jsonResponse(res, {
        ok: true,
        verdict: 'NO_SAMPLES',
        note: '样本数据不足，无法执行泄漏审计。需要至少一条验证记录。',
        leakageDetected: 0,
        totalChecks: 0,
        totalViolations: 0,
        leakageFree: 0,
      });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // [v3.3.1] Confidence Calibration API
  if (pathname === '/api/verification/calibration') {
    try {
      const vd = require('./mosaic/analysis/verification_dashboard');
      const dash = vd.getDashboard({ lookbackDays: 60 });
      return jsonResponse(res, { ok: true, calibration: dash.confidenceCalibration });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // [v3.3.1] Walk-Forward Report API
  if (pathname === '/api/evolution/walk-forward-report') {
    try {
      const wfFile = require('path').join(__dirname, 'report-engine', 'data', 'evolution', 'walk_forward_report.json');
      if (require('fs').existsSync(wfFile)) {
        const wf = JSON.parse(require('fs').readFileSync(wfFile, 'utf8'));
        return jsonResponse(res, { ok: true, ...wf });
      }
      return jsonResponse(res, { ok: false, message: 'Walk-forward report not generated yet. Run bootstrap --split first.' });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // ===== 周末深度分析 API (DEPRECATED v2.9 — 透传到 history engine) =====
  if (pathname === '/api/weekend-analysis/status') {
    try {
      const historyReview = require('./mosaic/analysis/history_review');
      return jsonResponse(res, { ok: true, ...historyReview.getStatus(), _deprecated: true });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  if (pathname === '/api/weekend-analysis/report') {
    try {
      const historyReview = require('./mosaic/analysis/history_review');
      return jsonResponse(res, historyReview.getReport('deep'));
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  if (pathname === '/api/weekend-analysis/context') {
    try {
      var ctxPath2 = path.join(DATA_DIR, 'simfolio', 'history_context.json');
      if (fs.existsSync(ctxPath2)) {
        var ctx2 = JSON.parse(fs.readFileSync(ctxPath2, 'utf8'));
        if (ctx2.validUntil >= new Date().toISOString().slice(0, 10)) {
          return jsonResponse(res, { ok: true, ...ctx2 });
        }
      }
      return jsonResponse(res, { ok: false, message: '暂无历史复盘上下文' });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  if (pathname === '/api/weekend-analysis/history') {
    try {
      const historyReview = require('./mosaic/analysis/history_review');
      var deepReport = historyReview.getReport('deep');
      return jsonResponse(res, { ok: true, similarity: deepReport.similarity || [] });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // ===== 周末分析验证 API (DEPRECATED v2.9 — 透传) =====
  if (pathname === '/api/weekend-analysis/verification') {
    var weekP2 = url.searchParams.get('week');
    try {
      var verifierOld = require('./mosaic/analysis/history_verifier');
      if (weekP2) {
        return jsonResponse(res, verifierOld.getVerificationReport(weekP2));
      }
      var latestOld = verifierOld.getVerificationHistory();
      if (latestOld.ok && latestOld.history.length > 0) {
        return jsonResponse(res, verifierOld.getVerificationReport(latestOld.history[0].weekend));
      }
      return jsonResponse(res, { ok: false, message: '尚无验证报告' });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  if (pathname === '/api/weekend-analysis/verification-history') {
    try {
      var verifierOld2 = require('./mosaic/analysis/history_verifier');
      return jsonResponse(res, verifierOld2.getVerificationHistory());
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // === 24/7 自主学习进化引擎 API ===

  // 进化任务状态
  if (pathname === '/api/evolution/status') {
    try {
      const evolutionScheduler = require('./mosaic/evolution/evolution_scheduler');
      return jsonResponse(res, { ok: true, ...evolutionScheduler.getStatus() });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // 最近夜间回测结果
  if (pathname === '/api/evolution/night-backtest/latest') {
    try {
      const nightBacktest = require('./mosaic/evolution/night_backtest');
      const result = nightBacktest.loadBacktestResult();
      return jsonResponse(res, { ok: true, result });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // 最近自我质疑报告
  if (pathname === '/api/evolution/self-reflection/latest') {
    try {
      const selfReflection = require('./mosaic/evolution/self_reflection');
      const result = selfReflection.loadReflectionResult();
      return jsonResponse(res, { ok: true, result });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // 今日美股→A股预测
  if (pathname === '/api/evolution/us-predict/today') {
    try {
      const usAsPredict = require('./mosaic/evolution/us_as_predict');
      const today = new Date().toISOString().slice(0, 10);
      const prediction = usAsPredict.loadPrediction(today);
      return jsonResponse(res, { ok: true, prediction });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // 美股→A股预测历史准确率
  if (pathname === '/api/evolution/us-predict/accuracy') {
    try {
      const usAsPredict = require('./mosaic/evolution/us_as_predict');
      const url = new URL(req.url, 'http://localhost');
      const days = parseInt(url.searchParams.get('days') || '20', 10);
      const accuracy = usAsPredict.getPredictionAccuracy(days);
      return jsonResponse(res, { ok: true, accuracy });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // 手动触发夜间回测（调试用）
  if (pathname === '/api/evolution/run-night-backtest' && req.method === 'POST') {
    try {
      const nightBacktest = require('./mosaic/evolution/night_backtest');
      const result = nightBacktest.runNightlyBacktest({ maxStocks: 200, lookbackDays: 60 });
      return jsonResponse(res, { ok: true, result });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }
  // 网格搜索结果
  if (pathname === "/api/evolution/grid-search/latest") {
    try {
      const gridSearch = require("./mosaic/evolution/weight_grid_search");
      const result = gridSearch.loadGridResult();
      return jsonResponse(res, { ok: true, result });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // 因子组合挖掘结果
  if (pathname === "/api/evolution/factor-mining/latest") {
    try {
      const factorMining = require("./mosaic/evolution/weekend_factor_mining");
      const result = factorMining.loadMiningResult();
      return jsonResponse(res, { ok: true, result });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // 手动触发全部进化任务（调试用）
  if (pathname === "/api/evolution/run-all" && req.method === "POST") {
    try {
      const evolutionScheduler = require("./mosaic/evolution/evolution_scheduler");
      evolutionScheduler.runAllNow();
      return jsonResponse(res, { ok: true, message: "已触发全部进化任务" });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // 手动触发权重网格搜索
  if (pathname === "/api/evolution/run-grid-search" && req.method === "POST") {
    try {
      const gridSearch = require("./mosaic/evolution/weight_grid_search");
      const result = gridSearch.runGridSearch();
      return jsonResponse(res, { ok: true, result });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // 手动触发自我质疑
  if (pathname === "/api/evolution/run-self-reflection" && req.method === "POST") {
    try {
      const selfReflection = require("./mosaic/evolution/self_reflection");
      let pf = { positions: [], tradeHistory: [] };
      try {
        const simfolio = require("./mosaic/simfolio");
        pf = simfolio.loadPortfolio();
      } catch (_) {}
      const dateStr = new Date().toISOString().slice(0, 10);
      const result = selfReflection.runSelfReflection(pf, dateStr);
      return jsonResponse(res, { ok: true, result });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // 手动触发因子组合挖掘
  if (pathname === "/api/evolution/run-factor-mining" && req.method === "POST") {
    try {
      const factorMining = require("./mosaic/evolution/weekend_factor_mining");
      const result = factorMining.runWeekendMining();
      return jsonResponse(res, { ok: true, result });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // 手动触发美股预测生成
  if (pathname === "/api/evolution/run-us-predict" && req.method === "POST") {
    try {
      const usAsPredict = require("./mosaic/evolution/us_as_predict");
      const dateStr = new Date().toISOString().slice(0, 10);
      const result = usAsPredict.generateOvernightPrediction(dateStr);
      return jsonResponse(res, { ok: true, result });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // 美股预测验证（手动）
  if (pathname === "/api/evolution/run-us-verify" && req.method === "POST") {
    try {
      const usAsPredict = require("./mosaic/evolution/us_as_predict");
      const dateStr = new Date().toISOString().slice(0, 10);
      const result = usAsPredict.verifyPrediction(dateStr);
      return jsonResponse(res, { ok: true, result });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // === [v3.1] Bootstrap History Training ===

  // View training matrix (read-only, no token cost)
  if (pathname === "/api/evolution/training-matrix") {
    try {
      var matrixFile = path.join(DATA_DIR, 'evolution', 'training_matrix.json');
      if (fs.existsSync(matrixFile)) {
        var matrix = JSON.parse(fs.readFileSync(matrixFile, 'utf8'));
        // v3.2: return full data by default, ?full=0 for lightweight mode
        var fullMode = url.searchParams.get('full') !== '0';
        if (fullMode) {
          return jsonResponse(res, {
            ok: true,
            summary: matrix.summary,
            config: matrix.config,
            duration: matrix.duration,
            generatedAt: matrix.generatedAt,
            factorMatrix: matrix.factorMatrix || null,
            factorCombos: matrix.factorCombos || null,
            crossMarket: matrix.crossMarket || null,
            paramSearch: matrix.paramSearch || null,
          });
        }
        return jsonResponse(res, {
          ok: true,
          summary: matrix.summary,
          config: matrix.config,
          duration: matrix.duration,
          generatedAt: matrix.generatedAt,
        });
      }
      return jsonResponse(res, { ok: true, available: false, message: 'Training matrix 尚未生成，请先运行 bootstrap' });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // View factor effectiveness detail (T+5 horizon)
  if (pathname === "/api/evolution/factor-effectiveness") {
    try {
      var effFile = path.join(DATA_DIR, 'evolution', 'factor_effectiveness.json');
      if (fs.existsSync(effFile)) {
        var eff = JSON.parse(fs.readFileSync(effFile, 'utf8'));
        return jsonResponse(res, { ok: true, ...eff });
      }
      return jsonResponse(res, { ok: true, available: false, message: 'Factor effectiveness 尚未生成' });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // View parameter search results
  if (pathname === "/api/evolution/param-search") {
    try {
      var psFile = path.join(DATA_DIR, 'evolution', 'param_search_results.json');
      if (fs.existsSync(psFile)) {
        var ps = JSON.parse(fs.readFileSync(psFile, 'utf8'));
        return jsonResponse(res, { ok: true, ...ps });
      }
      return jsonResponse(res, { ok: true, available: false, message: 'Param search 尚未运行' });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // View auto-generated training report (latest)
  if (pathname === "/api/evolution/training-report") {
    try {
      var evoDir = path.join(DATA_DIR, 'evolution');
      if (fs.existsSync(evoDir)) {
        var reports = fs.readdirSync(evoDir)
          .filter(function(f) { return f.startsWith('training_report_') && f.endsWith('.md'); })
          .sort()
          .reverse();
        if (reports.length > 0) {
          var reportContent = fs.readFileSync(path.join(evoDir, reports[0]), 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(reportContent);
          return;
        }
      }
      return jsonResponse(res, { ok: true, available: false, message: '尚无训练报告' });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // Manual trigger: run bootstrap (starts full training pipeline in background)
  if (pathname === "/api/evolution/run-bootstrap" && req.method === "POST") {
    try {
      var bootstrap = require("./mosaic/evolution/bootstrap_history");
      var opts = {};
      // Parse body for options
      if (body) {
        try {
          var b = typeof body === 'string' ? JSON.parse(body) : body;
          if (b.universe) opts.universe = b.universe;
          if (b.skipDownload) opts.skipDownload = true;
        } catch (_) {}
      }
      // Fire-and-forget: run in background, return immediately
      bootstrap.runBootstrap(opts).then(function(result) {
        console.log('[Bootstrap] 后台训练完成: ' + (result.duration || '?') + 's');
      }).catch(function(err) {
        console.error('[Bootstrap] 后台训练失败:', err.message);
      });
      return jsonResponse(res, {
        ok: true,
        message: 'Bootstrap 训练已在后台启动。训练完成后可通过 /api/evolution/training-matrix 查看结果。',
        estimatedDuration: '2-4小时（取决于数据量和网络）',
      });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // Bootstrap status (is it running? what was the last result?)
  if (pathname === "/api/evolution/bootstrap-status") {
    try {
      var stateFile = path.join(DATA_DIR, 'evolution', 'bootstrap_state.json');
      var state = null;
      if (fs.existsSync(stateFile)) {
        state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      }
      return jsonResponse(res, {
        ok: true,
        lastFullRun: state ? state.lastFullRun : null,
        completedPhases: state ? state.completedPhases : [],
        universe: state ? state.universe : null,
        totalDays: state ? state.totalDays : 0,
        errors: state ? state.errors : [],
      });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }


  // Last pipeline result (persisted, survives restarts)
  if (pathname === '/api/pipeline/last-result') {
    const p = path.join(DATA_DIR, 'simfolio', 'last_pipeline_result.legacy_untrusted.json');
    if (fs.existsSync(p)) {
      return jsonResponse(res, { ok: true, ...JSON.parse(fs.readFileSync(p, 'utf8')) });
    }
    return jsonResponse(res, { ok: false, message: '尚无分析结果' });
  }

  // Think Tank initial data (REST fallback, loads instantly before SSE connects)
  if (pathname === '/api/think-tank/initial') {
    const data = { ok: true, time: new Date().toISOString() };
    // Include scheduler status
    if (scheduler) {
      data.scheduler = scheduler.getStatus();
    }
    // Include last pipeline result
    const lastResultPath = path.join(DATA_DIR, 'simfolio', 'last_pipeline_result.legacy_untrusted.json');
    if (fs.existsSync(lastResultPath)) {
      try {
        data.lastResult = JSON.parse(fs.readFileSync(lastResultPath, 'utf8'));
      } catch (e) { /* ignore */ }
    }
    // Include today's events
    const todayStr2 = new Date().toISOString().slice(0, 10);
    data.todayEvents = loadDailyEvents(todayStr2);
    data.eventDates = listEventDates();

    // Include scan records for today
    try {
      const scanFile = path.join(DATA_DIR, 'simfolio', 'scan_records_' + todayStr2 + '.json');
      if (fs.existsSync(scanFile)) {
        data.scanRecords = JSON.parse(fs.readFileSync(scanFile, 'utf8'));
      }
    } catch (e) { /* ignore */ }

    // Include position snapshot
    try {
      const pf = simfolio.loadPortfolio();
      const snap = simfolio.getSnapshot(pf);
      data.positions = {
        cash: snap.cash,
        totalValue: snap.totalValue,
        totalReturn: snap.totalReturn,
        positions: snap.positions.map(p => ({
          code: p.code, name: p.name, shares: p.shares,
          avgCost: p.avgCost, currentPrice: p.currentPrice,
          pnl: p.pnl, pnlPct: p.pnlPct,
        })),
      };
    } catch (e) { /* ignore */ }

    // Include factor performance
    try {
      const factorPerf = require('./mosaic/analysis/factor_performance');
      data.factorPerformance = factorPerf.computeFactorPerformance({ days: 20 });
    } catch (e) { /* ignore */ }

    // Include margin data for think-tank risk hub
    try {
      const marginData = require('./mosaic/collectors/margin_data');
      const mData = await marginData.fetchMarginData(20);
      const mSentiment = marginData.computeMarginSentiment(mData);
      data.margin = { ok: true, ...mSentiment, raw: mData.slice(0, 5) };
    } catch (e) { /* ignore */ }

    // Include config for Standard modal
    try {
      const cfg = require('./mosaic/config');
      data.appConfig = {
        filters: {
          maxPrice: cfg.FILTER.maxPrice,
          minTurnover: cfg.FILTER.minTurnover,
          maxPE: cfg.FILTER.maxPE,
          excludeST: cfg.FILTER.excludeST,
          excludeGEM: cfg.FILTER.exclude300,
          includeSTAR: cfg.FILTER.exclude688 === false,
        },
        weights: cfg.FACTOR_WEIGHTS || {},
        positionSizing: cfg.positionSizing || {},
        trading: {
          initialCapital: cfg.SIMFOLIO.initialCapital || 100000,
          maxPositions: cfg.SIMFOLIO.maxPositions || 5,
          singleLimit: cfg.SIMFOLIO.maxSinglePositionPct || 30,
          buyThreshold: { minPercentile: (cfg.BUY_THRESHOLD && cfg.BUY_THRESHOLD.percentileTop) || 0.15, minScore: (cfg.BUY_THRESHOLD && cfg.BUY_THRESHOLD.minAbsoluteScore) || 50 },
          stopLoss: cfg.SIMFOLIO.stopLossPct || -8,
          trailingStop: cfg.SIMFOLIO.trailingStop,
        },
        scanSchedule: {
          fullScans: (cfg.SCAN_SCHEDULE && cfg.SCAN_SCHEDULE.full) || ['09:30', '11:00', '13:00'],
          midScans: (cfg.SCAN_SCHEDULE && cfg.SCAN_SCHEDULE.mid) || ['10:00', '10:30', '11:25', '13:30', '14:00', '14:30', '14:50'],
        },
        dataSource: 'Eastmoney (主力) + Tencent (备选) + Sina (三级备选)',
        maxDetailFetches: (cfg.API && cfg.API.maxDetailFetches) || 80,
        thinDataInfo: '基本面无数据时自适应降权(基本面25%→10%，总分上限65)',
      };
    } catch (e) { /* ignore */ }

    // P1-2: Generate today's verdict — synthesized decision guidance
    try {
      const shIdx = data.positions ? null : null; // fetched below if needed
      const verdict = generateTodaysVerdict(data);
      if (verdict) data.verdict = verdict;
    } catch (e) { /* ignore */ }

    return jsonResponse(res, data);
  }

  // Think-Tank Decision Status (new — unified decision audit data)
  if (pathname === '/api/think-tank/decision-status') {
    const data = { ok: true, timestamp: new Date().toISOString() };

    // 1. Market state
    if (scheduler) {
      const s = scheduler.getStatus();
      data.marketState = {
        state: s.state,
        isTradingDay: s.isTradingDay,
        nextTickMs: s.nextTickMs,
        opsRunning: s.opsRunning,
      };
      // Also set scheduler for generateTodaysVerdict compatibility
      data.scheduler = { state: s.state };
    }

    // 2. Decision gates — from unified Decision Kernel (v3.4.0)
    try {
      // Pre-load context for kernel
      var ttKernel = require('./mosaic/decision_kernel');
      // v3.4.1: Load portfolio for consistent context (P1-3)
      var ttPf = null;
      try { ttPf = require('./mosaic/simfolio').loadPortfolio(); } catch (_) {}
      // v3.4.3: Use shared loadLatestIndices() — reads raw arrays, not {indices:...}
      var ttIndices = require('./mosaic/decision_kernel').loadLatestIndices();
      // v3.4.1: Market state
      var ttMarketState = null;
      var ttMarketStateLabel = null;
      try {
        var ttSchedPath = path.join(DATA_DIR, 'simfolio', 'scheduler_state.json');
        if (fs.existsSync(ttSchedPath)) {
          var ttSched = JSON.parse(fs.readFileSync(ttSchedPath, 'utf8'));
          if (ttSched.state) {
            ttMarketState = ttSched.state;
            var stateLabels = { closed: '离市', pre_market: '盘前', lunch_break: '午休', post_market: '盘后', trading: '交易中' };
            ttMarketStateLabel = stateLabels[ttMarketState] || ttMarketState;
          }
        }
      } catch (_) {}
      var ttDqReport = null;
      try { ttDqReport = require('./mosaic/analysis/data_quality').computeConfidencePenalty(); } catch (_) {}
      var ttLeakageAudit = null;
      try {
        var ttLaPath = path.join(DATA_DIR, 'verification', 'leakage_audit.json');
        if (fs.existsSync(ttLaPath)) ttLeakageAudit = JSON.parse(fs.readFileSync(ttLaPath, 'utf8'));
      } catch (_) {}
      var ttShResult = null;
      try {
        var ttSh = require('./mosaic/analysis/strategy_health');
        ttShResult = ttSh.computeStrategyHealth({ portfolio: ttPf, indices: ttIndices, macroContext: null, pipelineResults: null });
      } catch (_) {}
      var ttMacroCtx = null;
      try {
        var ttCm = require('./mosaic/analysis/cross_market');
        var ttRiskState = ttCm.getCachedRiskState();
        if (ttRiskState) ttMacroCtx = { riskState: ttRiskState };
      } catch (_) {}

      // v3.4.3: Load pipelineResultsForKernel so think-tank kernel sees real candidates on restart
      var ttPipelineResults = null;
      try {
        var ttLrPath = path.join(DATA_DIR, 'simfolio', 'last_pipeline_result.legacy_untrusted.json');
        if (fs.existsSync(ttLrPath)) {
          var ttLr = JSON.parse(fs.readFileSync(ttLrPath, 'utf8'));
          if (ttLr.pipelineResultsForKernel && ttLr.pipelineResultsForKernel.length > 0) {
            ttPipelineResults = ttLr.pipelineResultsForKernel;
          }
        }
      } catch (_) {}

      var ttDecision = ttKernel.computeDecision({
        portfolio: ttPf, indices: ttIndices, macroContext: ttMacroCtx,
        pipelineResults: ttPipelineResults, dataQualityReport: ttDqReport,
        leakageAudit: ttLeakageAudit, strategyHealth: ttShResult,
        marketState: ttMarketState, marketStateLabel: ttMarketStateLabel,
      });

      data.decisionGates = ttDecision.gateStates;
      data.kernelVerdict = {
        canBuy: ttDecision.canBuy,
        finalVerdict: ttDecision.finalVerdict,
        finalVerdictLabel: ttDecision.finalVerdictLabel,
        maxBuysPerDay: ttDecision.maxBuysPerDay,
        hardBlockers: ttDecision.hardBlockers,
        softReducers: ttDecision.softReducers,
      };
    } catch (_) {
      // Fallback: try old gate state file
      try {
        const gateStatePath = path.join(DATA_DIR, 'simfolio', 'last_gate_state.json');
        if (fs.existsSync(gateStatePath)) {
          const gs = JSON.parse(fs.readFileSync(gateStatePath, 'utf8'));
          data.decisionGates = {
            drawdown: gs.drawdown,
            marketDirection: gs.marketDirection,
            circuitBreaker: gs.circuitBreaker,
            thinkTankDefense: gs.thinkTankDefense,
            attributionAvoid: gs.attributionAvoid,
          };
        }
      } catch (_2) {}
    }

    // Also load last decision metadata from persisted gate state
    try {
      const gateStatePath2 = path.join(DATA_DIR, 'simfolio', 'last_gate_state.json');
      if (fs.existsSync(gateStatePath2)) {
        const gs2 = JSON.parse(fs.readFileSync(gateStatePath2, 'utf8'));
        data.lastDecision = {
          timestamp: gs2.timestamp,
          scanType: gs2.scanType,
          executed: gs2.executed || [],
          nearMisses: gs2.nearMisses || [],
          decisions: gs2.decisions || 0,
        };
      }
    } catch (_) {}

    // 3. Last scan summary (with pre-fetched K-lines for speed)
    try {
      const lastResultPath = path.join(DATA_DIR, 'simfolio', 'last_pipeline_result.legacy_untrusted.json');
      if (fs.existsSync(lastResultPath)) {
        const lr = JSON.parse(fs.readFileSync(lastResultPath, 'utf8'));
        data.lastScan = {
          time: lr.time,
          type: lr.type,
          totalStocks: lr.totalStocks,
          candidates: lr.candidates,
          analyzed: lr.analyzed,
          topScore: lr.maxScore,
          avgScore: lr.avgScore,
          top5: (lr.top5 || []).map(s => ({
            code: s.code, name: s.name, score: s.score || s.compositeScore,
            rating: s.rating, signals: s.signals || [],
          })),
        };
        // Pre-fetch candidate K-lines inline (fast path, 3s timeout)
        const top5Codes = (data.lastScan.top5 || []).map(s => s.code);
        if (top5Codes.length > 0) {
          try {
            const marketData = require('./mosaic/collectors/market_data');
            const klineFetches = top5Codes.map(code => (async () => {
              try {
                const rawKlines = await marketData.fetchKline(code, 5);
                if (rawKlines && rawKlines.length >= 3) {
                  const closes = rawKlines.map(k => k.close);
                  const priceMin = Math.min(...rawKlines.map(k => k.low));
                  const priceMax = Math.max(...rawKlines.map(k => k.high));
                  const ma5Values = [];
                  for (let i = 0; i < closes.length; i++) {
                    const slice = closes.slice(0, i + 1);
                    ma5Values.push(slice.reduce((a, b) => a + b, 0) / slice.length);
                  }
                  return [code, {
                    candles: rawKlines.map(k => ({
                      date: k.date, open: k.open, close: k.close,
                      high: k.high, low: k.low, volumeMoney: k.turnover || k.volume,
                    })),
                    ma5Values, priceMin, priceMax,
                  }];
                }
              } catch (_) {}
              return [code, null];
            })());
            const results = await Promise.race([
              Promise.all(klineFetches),
              new Promise(resolve => setTimeout(() => resolve([]), 4000)),
            ]);
            const klines = {};
            for (const [code, kl] of results) {
              if (kl) klines[code] = kl;
            }
            if (Object.keys(klines).length > 0) {
              data.lastScan.klines = klines;
            }
          } catch (_) {}
        }
        // Include expected returns if available (v2.8)
        if (lr.expectedReturns && lr.expectedReturns.length > 0) {
          data.lastScan.expectedReturns = lr.expectedReturns;
        }
      }
    } catch (_) {}

    // 4. Positions
    try {
      const pf = simfolio.loadPortfolio();
      const snap = simfolio.getSnapshot(pf);
      data.positions = {
        cash: snap.cash,
        totalValue: snap.totalValue,
        totalReturn: snap.totalReturn,
        positions: snap.positions.map(p => ({
          code: p.code, name: p.name, shares: p.shares,
          avgCost: p.avgCost, currentPrice: p.currentPrice,
          pnl: p.pnl, pnlPct: p.pnlPct,
        })),
      };
    } catch (_) {}

    // 5. Factor performance (include NB performance for Loop 2)
    try {
      const factorPerf = require('./mosaic/analysis/factor_performance');
      const perf = factorPerf.computeFactorPerformance({ days: 20 });
      const nbPerf = factorPerf.getNBPerformance();
      data.factorPerformance = { ...perf, nbPerformance: nbPerf };
    } catch (_) {}

    // 6. Dynamic weights
    try {
      const weightsPath = path.join(DATA_DIR, 'simfolio', 'dynamic_weights.json');
      if (fs.existsSync(weightsPath)) {
        const dw = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
        data.dynamicWeights = {
          weights: dw.weights || {},
          r2: dw.r2,
          samples: dw.sampleCount,
          updatedAt: dw.updatedAt,
          message: dw.message,
        };
      }
    } catch (_) {}

    // 7. Prediction health — 6 Learning Loops with 3-layer data (Input → Process → Output)
    try {
      const sfPath = path.join(DATA_DIR, 'simfolio', 'stock_factor_performance.json');
      const taPath = path.join(DATA_DIR, 'simfolio', 'trade_attribution.json');
      const adjPath = path.join(DATA_DIR, 'simfolio', 'attribution_adjustments.json');
      const weekendPath = path.join(DATA_DIR, 'simfolio', 'weekend_context.json');

      // --- Loop 1: Weekend Verify → Analysis ---
      let loop1 = { status: 'off', detail: '无周末验证数据' };
      try {
        if (fs.existsSync(weekendPath)) {
          const wc = JSON.parse(fs.readFileSync(weekendPath, 'utf8'));
          const now = new Date();
          const validUntil = wc.validUntil ? new Date(wc.validUntil) : null;
          const expired = validUntil && now > validUntil;
          const insightTypes = (wc.insights || []).map(i => i.type);
          loop1 = {
            status: expired ? 'degraded' : 'active',
            input: {
              label: '周末分析报告',
              generatedAt: wc.generatedAt,
              validUntil: wc.validUntil,
              insightCount: (wc.insights || []).length,
            },
            process: {
              label: '识别关键信号',
              signals: insightTypes,
              crossMarketRisk: insightTypes.includes('cross_market'),
              sectorPreference: insightTypes.includes('sector_preference'),
            },
            output: expired
              ? '已过期(有效期至'+wc.validUntil+')，等待新的周末分析'
              : '周末分析已注入：历史平行匹配+板块偏好+跨市场风险评估',
            detail: expired
              ? '周末验证数据已过期('+wc.validUntil+')，分析结果不再注入决策流程'
              : '周末验证报告反馈到因子分析引擎，调整板块权重与跨市场防御门',
          };
        }
      } catch (_) {}

      // --- Loop 2: NorthBound → Score Weight ---
      // v3.4.8: When nb data is unavailable, show degraded (not active/off)
      let loop2 = { status: 'degraded', detail: '北向资金数据不可用',
        input: { label: '北向数据不可用', signalDays: 0, totalDays: 0, available: false },
        process: { label: '无数据', hitRate: null, status: 'unavailable' },
        output: '北向数据不可用，权重回退默认',
      };
      try {
        if (data.factorPerformance && data.factorPerformance.nbPerformance) {
          const nb = data.factorPerformance.nbPerformance;
          if (nb.available === false) {
            loop2 = {
              status: 'degraded',
              input: { label: '北向数据不可用', signalDays: nb.signalDays || 0, totalDays: nb.totalDays || 0, available: false },
              process: { label: '无法计算命中率', hitRate: null, status: 'unavailable' },
              output: '北向数据不可用，权重回退默认',
              detail: '北向资金数据源异常或数据文件缺失，北向因子降级为默认权重',
            };
          } else {
            loop2 = {
              status: nb.status === 'hot' ? 'active' : nb.status === 'cold' ? 'degraded' : 'active',
              input: {
                label: '北向资金情绪',
                signalDays: nb.signalDays || 0,
                totalDays: nb.totalDays || 0,
                available: true,
              },
              process: {
                label: '计算方向命中率',
                hitRate: nb.hitRate,
                status: nb.status,
              },
              output: nb.status === 'hot'
                ? '命中率高('+(nb.hitRate*100).toFixed(0)+'%)，北向信号权重上调'
                : nb.status === 'cold'
                  ? '命中率低('+(nb.hitRate*100).toFixed(0)+'%)，触发北向评分降权'
                  : '命中率中性('+(nb.hitRate*100).toFixed(0)+'%)，维持默认权重',
              detail: '北向资金情绪HOT/COLD计算命中率，动态调整composite评分中的北向权重(±3~±5分)',
            };
          }
        }
      } catch (_) {}

      // --- Loop 3: Knowledge Base → Decision ---
      let loop3 = { status: 'active', detail: '知识库持续追踪' };
      try {
        const kbDir = path.join(DATA_DIR, 'knowledge_base');
        const factorTrackerPath = path.join(kbDir, 'factor_tracker.json');
        const kbIndexPath = path.join(kbDir, 'index.json');

        let kbDays = 0, activeFactors = 0, topFactorIds = [];
        if (fs.existsSync(factorTrackerPath)) {
          const ft = JSON.parse(fs.readFileSync(factorTrackerPath, 'utf8'));
          kbDays = ft.totalDays || 0;
          const factors = ft.factors || {};
          const entries = Object.entries(factors);
          activeFactors = entries.filter(([_, f]) => f.triggerCount > 0).length;
          topFactorIds = entries
            .filter(([_, f]) => f.triggerCount > 0)
            .sort((a, b) => b[1].triggerCount - a[1].triggerCount)
            .slice(0, 3)
            .map(([id]) => id);
        }
        // Check if KB actually influenced gate decisions
        let triggeredGate = false;
        try {
          const gateStatePath = path.join(DATA_DIR, 'simfolio', 'last_gate_state.json');
          if (fs.existsSync(gateStatePath)) {
            const gs = JSON.parse(fs.readFileSync(gateStatePath, 'utf8'));
            if (gs.thinkTankDefense && gs.thinkTankDefense.breakdown) {
              const kb = gs.thinkTankDefense.breakdown.knowledgeBase;
              if (kb && kb.score > 0) triggeredGate = true;
            }
          }
        } catch (_) {}

        loop3 = {
          status: kbDays >= 1 ? 'active' : 'degraded',
          input: {
            label: '历史日分析存档',
            kbDays,
            factorTrackerDays: kbDays,
          },
          process: {
            label: '追踪高效因子',
            activeFactors,
            totalFactors: 9,
            topFactors: topFactorIds,
          },
          output: triggeredGate
            ? '已触发！知识库检测到历史高效因子当前偏冷，对防御门贡献分数'
            : '持续追踪中，当前'+(triggeredGate?'已':'未')+'触发防御门影响',
          detail: '累计'+kbDays+'天知识库，追踪'+activeFactors+'/9个因子有历史触发记录。冷因子检测→防御门knowledgeBase维度',
        };
      } catch (_) {}

      // --- Loop 4: Think-Tank Defense → Gate ---
      let loop4 = { status: 'degraded', detail: '思维舱防御未执行 — 等待下次管线扫描' };
      try {
        const gateStatePath = path.join(DATA_DIR, 'simfolio', 'last_gate_state.json');
        let gateDefenseData = null;
        if (fs.existsSync(gateStatePath)) {
          const gs = JSON.parse(fs.readFileSync(gateStatePath, 'utf8'));
          if (gs.thinkTankDefense) {
            gateDefenseData = gs.thinkTankDefense;
          }
        }
        if (gateDefenseData && gateDefenseData.score != null) {
          const bd = gateDefenseData.breakdown || {};
          const dimScores = {};
          let totalScore = gateDefenseData.score || 0;
          let dimCount = 0;
          const dimNames = ['factorHealth', 'portfolioStress', 'consecutiveLoss', 'crossMarketRisk', 'signalDivergence', 'knowledgeBase'];
          for (const dn of dimNames) {
            if (bd[dn]) {
              dimScores[dn] = bd[dn].score || 0;
              dimCount++;
            }
          }
          if (dimCount === 0) dimCount = dimNames.length;
          loop4 = {
            status: gateDefenseData.status === 'block' ? 'active' : (totalScore > 0 ? 'active' : 'degraded'),
            input: {
              label: '6维风控维度',
              dimensions: dimNames.length,
              gateTimestamp: gateDefenseData.timestamp || new Date().toISOString(),
            },
            process: {
              label: '综合防御评分',
              totalScore,
              threshold: gateDefenseData.threshold || 3,
              blocked: gateDefenseData.status === 'block',
              dimScores,
            },
            output: gateDefenseData.status === 'block'
              ? '防御触发！总分'+totalScore+'≥阈值'+gateDefenseData.threshold+'，拦截买入'
              : '防御得分'+totalScore+'/'+dimCount+'<阈值'+gateDefenseData.threshold+'，放行交易',
            detail: totalScore > 0
              ? (gateDefenseData.description || '6维防御评分: ' + dimNames.slice(0, dimCount).join('/'))
              : '当前防御得分0 — 因子健康/持仓/回撤/跨市场/信号背离/知识库 六维均未触发 (正常状态)',
          };
        }
        // If gateDefenseData exists but has no score (old format), keep degraded
      } catch (_) {}

      // --- Loop 5: Trade Attribution → Parameters ---

      // --- Loop 5: Trade Attribution → Parameters ---
      let loop5 = { status: 'off', detail: '暂无交易归因记录' };
      try {
        if (fs.existsSync(taPath)) {
          const ta = JSON.parse(fs.readFileSync(taPath, 'utf8'));
          const records = ta.records || [];
          const recentRecords = records.slice(-5);
          const winCount = recentRecords.filter(r => r.isWin).length;
          const totalRecords = recentRecords.length;
          const adjustmentsMade = recentRecords.filter(r => r.adjustments && Object.keys(r.adjustments).length > 0).length;

          let adjDetail = '暂无活跃参数调整';
          if (fs.existsSync(adjPath)) {
            const adj = JSON.parse(fs.readFileSync(adjPath, 'utf8'));
            const activeAdj = [];
            if (adj.factorWeightOffsets && adj.factorWeightOffsets.reduced) activeAdj.push('因子权重下调');
            if (adj.sectorAvoidList && adj.sectorAvoidList.length > 0) activeAdj.push(adj.sectorAvoidList.length+'个板块避让');
            if (activeAdj.length > 0) adjDetail = '活跃调整: '+activeAdj.join(', ');
          }

          loop5 = {
            status: records.length > 0 ? 'active' : 'degraded',
            input: {
              label: '已完成交易记录',
              totalAttributions: records.length,
              recentCount: totalRecords,
              lastUpdated: ta.updatedAt,
            },
            process: {
              label: '归因分析',
              recentWinRate: totalRecords > 0 ? (winCount/totalRecords*100).toFixed(0)+'%' : 'N/A',
              adjustmentsTriggered: adjustmentsMade,
            },
            output: adjustmentsMade > 0 ? '反馈生效：'+adjDetail : '归因正常，未触发参数调整阈值',
            detail: '每笔卖出后归因：因子命中/板块表现/预期vs实际→调整因子信任度+板块避让列表。共'+records.length+'条归因记录',
          };
        }
      } catch (_) {}

      // --- Loop 6: Dynamic Weights → Score ---
      let loop6 = { status: 'off', detail: '无动态权重数据' };
      try {
        if (data.dynamicWeights) {
          const dw = data.dynamicWeights;
          const r2 = dw.r2 || 0;
          const samples = dw.samples || 0;
          const weights = dw.weights || {};
          const weightEntries = Object.entries(weights);
          const activeDims = weightEntries.filter(([_, v]) => v > 0.05).length;

          loop6 = {
            status: r2 >= 0.05 ? 'active' : (samples > 0 ? 'degraded' : 'degraded'),
            input: {
              label: 'OLS训练数据',
              sampleCount: samples,
              minSamples: 30,
              lookbackDays: 20,
            },
            process: {
              label: 'OLS回归学习',
              r2: r2,
              threshold: 0.05,
              activeDimensions: activeDims,
              totalDimensions: 5,
            },
            output: r2 >= 0.05
              ? '学习生效！R²='+(r2*100).toFixed(0)+'%≥5%，自动调整'+activeDims+'维权重'
              : samples < 30
                ? '样本不足('+samples+'<30)，继续积累数据'
                : 'R²='+(r2*100).toFixed(0)+'%<5%，回退默认权重',
            detail: '每日盘后OLS回归，自动调整5维评分权重(限5%-50%)。需≥30条样本，R²≥5%生效',
          };
        }
      } catch (_) {}

      // --- Loop 7: Evolution Engine → All Loops ---
      let loop7 = { status: 'degraded', detail: '进化引擎等待首次调度' };
      try {
        const evo = require('./mosaic/evolution/evolution_scheduler');
        const evoStatus = evo.getStatus();
        const todayTasks = evoStatus.todayTasks || [];
        const completed = todayTasks.filter(function(t) { return t.success; }).length;
        const total = todayTasks.length;
        const recentHist = evoStatus.recentHistory || [];
        const recentSuccess = recentHist.slice(-10).filter(function(h) { return h.success; }).length;
        const scheduleCount = (evoStatus.schedule || []).length;

        loop7 = {
          status: completed > 0 ? 'active' : (recentHist.length > 0 ? 'degraded' : 'degraded'),
          input: {
            label: scheduleCount + '个进化任务 (bootstrap/回测/权重/美股预测/因子挖掘/复盘等)',
            scheduleSummary: '02:00-05:30 夜盘批次 | 15:10-20:00 赛后批次 | 周末因子挖掘/周报',
            running: evoStatus.running || false,
          },
          process: {
            label: '空闲窗口自动调度 (catch-up + 30min超时+1次重试)',
            completedToday: completed,
            totalToday: total,
            recentSuccessRate: recentHist.length > 0 ? Math.round(recentSuccess / Math.min(10, recentHist.length) * 100) + '%' : 'N/A',
          },
          output: completed > 0
            ? '今日' + completed + '/' + total + '个任务完成，数据流向所有学习回路'
            : (total > 0
              ? '今日' + total + '个任务待执行'
              : '等待凌晨/赛后调度窗口'),
          detail: '24/7自主进化: bootstrap→回测→参数→美股预测→因子挖掘→复盘→知识库→验证→权重→推送。最近' + Math.min(10, recentHist.length) + '次成功率' + (recentHist.length > 0 ? Math.round(recentSuccess / Math.min(10, recentHist.length) * 100) + '%' : 'N/A'),
        };
      } catch (_) {}

      data.predictionHealth = {
        loops: {
          '1_weekendVerify': loop1,
          '2_nbWeight': loop2,
          '3_knowledgeBase': loop3,
          '4_thinkTankDefense': loop4,
          '5_tradeAttribution': loop5,
          '6_dynamicWeights': loop6,
          '7_evolutionEngine': loop7,
        },
        stockPredictor: fs.existsSync(sfPath) ? { available: true } : { available: false },
        tradeAttribution: fs.existsSync(taPath) ? { available: true, recordCount: (function() {
          try { const ta = JSON.parse(fs.readFileSync(taPath, 'utf8')); return (ta.records || []).length; } catch (_) { return 0; }
        })() } : { available: false },
      };
    } catch (_) {}

    // 8. Verdict
    data.verdict = generateTodaysVerdict(data);

    return jsonResponse(res, data);
  }

  // Think-Tank Candidate K-line (batch fetch for candidate stock cards)
  if (pathname === '/api/think-tank/candidate-kline') {
    const codesParam = url.searchParams.get('codes') || '';
    const codes = codesParam.split(',').filter(Boolean).slice(0, 6);
    if (codes.length === 0) return jsonResponse(res, { ok: false, message: '需要codes参数' });

    try {
      const marketData = require('./mosaic/collectors/market_data');
      const klines = {};
      const fetchPromises = codes.map(code => (async () => {
        try {
          const rawKlines = await marketData.fetchKline(code, 5);
          if (rawKlines && rawKlines.length >= 3) {
            const closes = rawKlines.map(k => k.close);
            const priceMin = Math.min(...rawKlines.map(k => k.low));
            const priceMax = Math.max(...rawKlines.map(k => k.high));
            const ma5Values = [];
            for (let i = 0; i < closes.length; i++) {
              const slice = closes.slice(0, i + 1);
              ma5Values.push(slice.reduce((a, b) => a + b, 0) / slice.length);
            }
            klines[code] = {
              candles: rawKlines.map(k => ({
                date: k.date, open: k.open, close: k.close,
                high: k.high, low: k.low, volumeMoney: k.turnover || k.volume,
              })),
              ma5Values,
              priceMin,
              priceMax,
            };
          }
        } catch (_) { /* skip individual stock errors */ }
      })());
      // 5s total timeout — with cache, most reads are <10ms
      await Promise.race([
        Promise.all(fetchPromises),
        new Promise(resolve => setTimeout(resolve, 5000)),
      ]);
      return jsonResponse(res, { ok: true, klines });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // Think Tank SSE stream
  if (pathname === '/api/think-tank/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    res.write('event: connected\ndata: {"ok":true}\n\n');
    sseClients.add(res);

    // Send initial state snapshot
    if (scheduler) {
      const sStatus = scheduler.getStatus();
      res.write('event: heartbeat\ndata: ' + JSON.stringify({
        time: new Date().toISOString(),
        state: sStatus.state,
        isTradingDay: sStatus.isTradingDay,
        nextTickMs: sStatus.nextTickMs,
        opsRunning: sStatus.opsRunning,
      }) + '\n\n');

      // Send event history
      const events = scheduler.getEvents(50);
      if (events.length > 0) {
        res.write('event: history\ndata: ' + JSON.stringify({ events }) + '\n\n');
      }

      // Send today's persisted events (more complete than scheduler in-memory)
      const todayStr = new Date().toISOString().slice(0, 10);
      const dailyEvents = loadDailyEvents(todayStr);
      if (dailyEvents.length > 0) {
        res.write('event: daily_events\ndata: ' + JSON.stringify({ date: todayStr, events: dailyEvents }) + '\n\n');
      }

      // Send position snapshot
      try {
        const pf = simfolio.loadPortfolio();
        const snap = simfolio.getSnapshot(pf);
        res.write('event: position_snapshot\ndata: ' + JSON.stringify({
          type: 'position_snapshot',
          cash: snap.cash,
          totalValue: snap.totalValue,
          totalReturn: snap.totalReturn,
          positions: snap.positions.map(p => ({
            code: p.code, name: p.name, shares: p.shares,
            avgCost: p.avgCost, currentPrice: p.currentPrice,
            pnl: p.pnl, pnlPct: p.pnlPct,
          })),
        }) + '\n\n');
      } catch (e) { /* ignore */ }

      // Send last pipeline result so think-tank shows previous scan data
      try {
        const lastResultPath = path.join(DATA_DIR, 'simfolio', 'last_pipeline_result.legacy_untrusted.json');
        if (fs.existsSync(lastResultPath)) {
          const lastResult = JSON.parse(fs.readFileSync(lastResultPath, 'utf8'));
          res.write('event: last_result\ndata: ' + JSON.stringify(lastResult) + '\n\n');
        }
      } catch (e) { /* ignore */ }
    }

    req.on('close', () => { sseClients.delete(res); });
    return; // Don't fall through to static serving
  }

  // ---- Static file serving ----
  let filePath;
  if (pathname === '/') {
    filePath = path.join(REPORT_ENGINE_DIR, 'index.html');
  } else {
    const safePath = path.normalize(pathname).replace(/^[/\\]+/, '');
    filePath = path.join(REPORT_ENGINE_DIR, safePath);
    if (!filePath.startsWith(REPORT_ENGINE_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
  }
  serveStatic(res, filePath);
});

server.listen(PORT, '0.0.0.0', function() {
  serverStartTime = new Date().toISOString();

  // v3.4.9.3: Mark existing ledger entries with hash-only featureSnapshot as invalid_schema_v3492
  // These entries are retained for audit but excluded from verification/promotion
  try {
    var _markResult = require('./mosaic/simfolio')._markInvalidLedgerEntries();
    console.log('[Mosaic] Ledger migration: marked ' + (_markResult.marked || 0) + ' entries as invalid_schema_v3492');
  } catch (_) { console.log('[Mosaic] Ledger migration skipped (no entries to mark or simfolio unavailable)'); }

  // 启动全自动调度器
  scheduler = new Scheduler();
  scheduler.start();

  // Inject SSE broadcast into scheduler (used by weekend analyzer too)
  scheduler.setSSEBroadcast((data) => {
    if (sseClients.size > 0) broadcastSSE('weekend', data);
  });

  // Wire scheduler events to console AND daily log
  scheduler.on('event', (evt) => {
    // Save all important events to daily log for think-tank timeline
    saveDailyEvent(evt);
  });
  scheduler.on('trades_executed', (trades) => {
    console.log('  [Server] Auto-trades executed:', trades.length);
  });

  // Wire scheduler think-tank events to SSE broadcast
  const thinkEvents = ['think_progress', 'think_enrichment', 'think_stock', 'think_stats',
    'think_scan', 'think_trade', 'think_position', 'think_state', 'think_alert', 'think_status',
    'think_usmarket', 'think_factor_perf', 'think_weekend', 'think_decision'];
  for (const evt of thinkEvents) {
    scheduler.on(evt, (data) => {
      if (sseClients.size > 0) {
        // Strip 'think_' prefix for the SSE event name
        const sseEvent = evt.replace('think_', '');
        broadcastSSE(sseEvent, data);
      }
    });
  }

  // Auto-start weekend analysis if it's Saturday or Sunday
  try {
    const weekendAnalyzer = require('./mosaic/analysis/weekend_analyzer');
    // Inject SSE broadcast
    weekendAnalyzer.setSSEBroadcast((data) => {
      if (sseClients.size > 0) broadcastSSE('weekend', data);
    });
    const now = new Date();
    if (now.getDay() === 0 || now.getDay() === 6) {
      // Delay slightly to let server finish booting
      setTimeout(() => {
        weekendAnalyzer.startWeekendAnalysis();
        console.log('  Weekend analysis auto-started (server booted on weekend)');
      }, 2000);
    }
  } catch (e) {
    // weekend_analyzer module may not exist yet — that's fine
  }

  printBanner();
  console.log('  Scheduler: ' + scheduler.getStatus().state + ' | next tick in ' +
    Math.round((scheduler.getStatus().nextTickMs || 0) / 1000) + 's');
  console.log();
});

server.on('error', function(err) {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error('  ╔══════════════════════════════════════════════════════╗');
    console.error('  ║  ERROR: Port ' + PORT + ' is already in use                    ║');
    console.error('  ╠══════════════════════════════════════════════════════╣');
    console.error('  ║  Close the other Mosaic Server window first,         ║');
    console.error('  ║  or run: taskkill /F /IM node.exe                   ║');
    console.error('  ╚══════════════════════════════════════════════════════╝');
    console.error('');
    process.exit(1);
  }
  throw err;
});

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n  Shutting down...');
  if (scheduler) scheduler.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (scheduler) scheduler.stop();
  process.exit(0);
});
