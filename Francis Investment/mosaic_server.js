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
  });

  // Run in background (don't await)
  pipeline.run().then(result => {
    console.log('  Pipeline done: ' + result.analyzed + ' stocks analyzed in ' + result.duration + 's');
    console.log('  Top pick: ' + (result.top5[0] ? result.top5[0].name + ' (' + result.top5[0].compositeScore + '分)' : 'N/A'));
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
  const result = simfolio.makeTradingDecisions(pf, pipeline.result.allResults, pipeline.result.indices);

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

server.listen(PORT, '127.0.0.1', function() {
  // 启动全自动调度器
  scheduler = new Scheduler();
  scheduler.start();
  scheduler.on('event', (evt) => {
    // 重要事件自动输出到控制台（scheduler 内部已处理）
  });
  scheduler.on('trades_executed', (trades) => {
    console.log('  [Server] Auto-trades executed:', trades.length);
  });

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
