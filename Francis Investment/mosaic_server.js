/**
 * Francis Investment · Mosaic Server v2.2.0
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
    };
    fs.writeFileSync(path.join(dir, 'last_pipeline_result.json'), JSON.stringify(summary, null, 2), 'utf8');
  } catch (e) { /* silent */ }
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
function generateTodaysVerdict(data) {
  const parts = [];
  let action = 'normal';
  let actionLabel = '正常交易';
  let actionColor = '#00e676';

  // 1. Market state
  const state = (data.scheduler && data.scheduler.state) || 'closed';
  const tradingStates = ['morning_session', 'afternoon_session'];
  const isTrading = tradingStates.includes(state);

  if (!isTrading) {
    const stateLabel = { closed: '离市', pre_market: '盘前', lunch_break: '午休', post_market: '盘后' }[state] || state;
    return {
      summary: '当前' + stateLabel + '，等待开盘',
      action: 'wait',
      color: '#4a5568',
      details: [],
    };
  }

  // 2. Factor health: count HOT vs COLD, plus NB performance
  let hotCount = 0, coldCount = 0;
  const factorDetails = [];
  if (data.factorPerformance && data.factorPerformance.factors) {
    for (const f of data.factorPerformance.factors) {
      if (f.status === 'hot') hotCount++;
      else if (f.status === 'cold') coldCount++;
    }
  }

  // Include north-bound performance in verdict
  if (data.factorPerformance && data.factorPerformance.nbPerformance && data.factorPerformance.nbPerformance.available) {
    const nb = data.factorPerformance.nbPerformance;
    if (nb.status === 'cold') {
      parts.push('北向信号偏冷(命中率' + (nb.hitRate * 100).toFixed(0) + '%)');
      action = action === 'normal' ? 'cautious' : action;
    }
  }

  if (coldCount >= 3) {
    parts.push('因子信号大面积偏冷(' + coldCount + '/9)');
    action = 'defensive';
  } else if (hotCount >= 2) {
    parts.push('因子信号活跃(HOT: ' + hotCount + '/9)');
  } else {
    parts.push('因子信号中性');
  }

  // 3. Portfolio status
  if (data.positions) {
    const totalReturn = data.positions.totalReturn || 0;
    const posCount = (data.positions.positions || []).length;
    if (posCount === 0) {
      parts.push('空仓');
    } else if (totalReturn < -3) {
      parts.push('持仓浮亏' + totalReturn.toFixed(1) + '%');
      action = action === 'normal' ? 'cautious' : action;
    } else if (totalReturn > 2) {
      parts.push('持仓盈利' + totalReturn.toFixed(1) + '%');
    } else {
      parts.push('持仓' + posCount + '只(±' + Math.abs(totalReturn).toFixed(1) + '%)');
    }
  }

  // 4. Last scan info
  if (data.lastResult) {
    const lr = data.lastResult;
    if (lr.maxScore != null) {
      const maxLabel = lr.maxScore >= 70 ? '高' : lr.maxScore >= 55 ? '中' : '低';
      parts.push('最近扫描最高' + lr.maxScore + '分(' + maxLabel + '质量)');
    }
  }

  // 5. Cross-market risk
  if (data.scheduler && data.scheduler.riskState) {
    const regime = data.scheduler.riskState;
    if (regime === 'panic' || regime === 'risk_off') {
      parts.push('跨市场风险偏高');
      action = 'defensive';
    }
  }

  // Determine final action
  switch (action) {
    case 'defensive':
      actionLabel = '建议减仓观望';
      actionColor = '#ff3b4a';
      parts.push('→ 减少新买入，关注止损');
      break;
    case 'cautious':
      actionLabel = '谨慎交易';
      actionColor = '#ffb800';
      parts.push('→ 控制仓位，优选质量');
      break;
    default:
      actionLabel = '可正常交易';
      actionColor = '#00e676';
      parts.push('→ 按信号执行，注意风控');
  }

  return {
    summary: parts.join(' · '),
    action: action,
    actionLabel: actionLabel,
    color: actionColor,
    details: [],
  };
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
  const today = new Date();
  const dStr = today.toISOString().slice(0, 10);
  const pStatus = pipeline ? pipeline.getStatus() : null;
  const sStatus = scheduler ? scheduler.getStatus() : null;
  return {
    date: dStr,
    weekday: getWeekdayCN(today),
    isTradingDay: isTradingDay(today),
    latestReport: getLatestReportDate(),
    serverStatus: 'running',
    version: '2.2.0',
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
  return jsonResponse(res, { ok: true, ...snapshot, stats, tradeHistory: pf.tradeHistory.slice(-20) });
}

function handleSimfolioHistory(res) {
  const pf = simfolio.loadPortfolio();
  return jsonResponse(res, { ok: true, dailyNav: pf.dailyNav });
}

function handleSimfolioTrade(res) {
  if (!pipeline || pipeline.status !== 'done' || !pipeline.result) {
    return jsonResponse(res, { ok: false, message: '请先运行量化分析（Pipeline未完成）' });
  }

  const pf = simfolio.loadPortfolio();
  const result = simfolio.makeTradingDecisions(pf, pipeline.result.allResults, pipeline.result.indices, 'full');

  return jsonResponse(res, {
    ok: true,
    decisions: result.decisions,
    executed: result.executed,
    snapshot: result.snapshot,
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
  console.log('  ║     Francis Investment · Mosaic Server  v2.2.0       ║');
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

  // Knowledge Base — factor combos pattern extraction
  if (pathname === '/api/knowledge/factor-combos') {
    try {
      const kb = require('./mosaic/analysis/knowledge_base');
      const combos = kb.extractFactorCombos(10);
      const sectorPatterns = kb.extractSectorFlowPatterns();
      return jsonResponse(res, { ok: true, combos, sectorPatterns });
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

  // ===== 周末深度分析 API =====
  if (pathname === '/api/weekend-analysis/status') {
    try {
      const weekendAnalyzer = require('./mosaic/analysis/weekend_analyzer');
      return jsonResponse(res, { ok: true, ...weekendAnalyzer.getStatus() });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  if (pathname === '/api/weekend-analysis/report') {
    try {
      const weekendAnalyzer = require('./mosaic/analysis/weekend_analyzer');
      return jsonResponse(res, { ok: true, ...weekendAnalyzer.getReport() });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  if (pathname === '/api/weekend-analysis/context') {
    try {
      const weekendAnalyzer = require('./mosaic/analysis/weekend_analyzer');
      const ctx = weekendAnalyzer.getEnhancedContext();
      if (ctx) {
        return jsonResponse(res, { ok: true, ...ctx });
      }
      return jsonResponse(res, { ok: false, message: '暂无周末分析上下文' });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  if (pathname === '/api/weekend-analysis/history') {
    try {
      const weekendAnalyzer = require('./mosaic/analysis/weekend_analyzer');
      const report = weekendAnalyzer.getReport();
      return jsonResponse(res, { ok: true, similarity: report.similarity || [] });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // ===== 周末分析验证 API =====
  if (pathname === '/api/weekend-analysis/verification') {
    const weekParam = url.searchParams.get('week');
    try {
      const verifier = require('./mosaic/analysis/weekend_verifier');
      if (weekParam) {
        const vReport = verifier.getVerificationReport(weekParam);
        if (vReport) return jsonResponse(res, { ok: true, ...vReport });
        return jsonResponse(res, { ok: false, message: '该周末的验证报告不存在' }, 404);
      }
      // No week specified: return latest
      const latest = verifier.getLatestVerification();
      if (latest) return jsonResponse(res, { ok: true, ...latest });
      return jsonResponse(res, { ok: false, message: '尚无验证报告' }, 404);
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  if (pathname === '/api/weekend-analysis/verification-history') {
    try {
      const verifier = require('./mosaic/analysis/weekend_verifier');
      const history = verifier.getVerificationHistory();
      return jsonResponse(res, { ok: true, history });
    } catch (e) {
      return jsonResponse(res, { ok: false, message: e.message });
    }
  }

  // Last pipeline result (persisted, survives restarts)
  if (pathname === '/api/pipeline/last-result') {
    const p = path.join(DATA_DIR, 'simfolio', 'last_pipeline_result.json');
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
    const lastResultPath = path.join(DATA_DIR, 'simfolio', 'last_pipeline_result.json');
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
        const lastResultPath = path.join(DATA_DIR, 'simfolio', 'last_pipeline_result.json');
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
    'think_scan', 'think_trade', 'think_position', 'think_state', 'think_alert', 'think_usmarket', 'think_factor_perf', 'think_weekend'];
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
