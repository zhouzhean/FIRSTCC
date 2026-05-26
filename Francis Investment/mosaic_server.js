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

const server = http.createServer(function(req, res) {
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

  // Daily summary report
  if (pathname === '/api/daily-summary/latest') {
    const today = new Date().toISOString().slice(0, 10);
    const summaryPath = path.join(DATA_DIR, 'summaries', today + '.json');
    if (fs.existsSync(summaryPath)) {
      return jsonResponse(res, { ok: true, ...JSON.parse(fs.readFileSync(summaryPath, 'utf8')) });
    }
    return jsonResponse(res, { ok: false, message: '今日总结尚未生成，请于16:00后查看' });
  }
  const summaryDateMatch = pathname.match(/^\/api\/daily-summary\/(\d{4}-\d{2}-\d{2})$/);
  if (summaryDateMatch) {
    const summaryPath = path.join(DATA_DIR, 'summaries', summaryDateMatch[1] + '.json');
    if (fs.existsSync(summaryPath)) {
      return jsonResponse(res, { ok: true, ...JSON.parse(fs.readFileSync(summaryPath, 'utf8')) });
    }
    return jsonResponse(res, { ok: false, message: '该日期的总结不存在' });
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
    'think_scan', 'think_trade', 'think_position', 'think_state', 'think_alert'];
  for (const evt of thinkEvents) {
    scheduler.on(evt, (data) => {
      if (sseClients.size > 0) {
        // Strip 'think_' prefix for the SSE event name
        const sseEvent = evt.replace('think_', '');
        broadcastSSE(sseEvent, data);
      }
    });
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
