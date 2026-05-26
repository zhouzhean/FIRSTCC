// Francis Investment Report Engine — Dashboard Controller
// Section-based navigation: click a section → see that content
// v2.2 — simfolio-first layout, live countdown, merged report, AI status badge

// -- State --
var state = {
  reportData: null,
  currentViewMode: null,
  currentDate: null,
  currentReportMeta: null,
  reportsIndex: [],
  reportsByDate: {},
  dirty: false,
  activeSection: 'simfolio',    // default: simfolio first
  activeMode: 'section',
  serverConnected: false,
  serverStatus: null,
  schedulerStatus: null,
  liveMode: false,
  tradeNotifications: [],
  lastSimfolioRefresh: null,
  simfolioData: null,          // cached simfolio data for live rendering
  countdownSec: 0,             // live countdown seconds
  countdownInterval: null,     // countdown timer ref
};

// Color palette — 红涨绿跌 (Chinese market convention)
var UP_COLOR = '#dc2626', DOWN_COLOR = '#16a34a', MUTED_COLOR = '#64748b', TEXT_COLOR = '#1e293b';

// Calendar state
var cal = {
  year: 2026,
  month: 5,
  activeDate: '2026-05-25',
};

// Section definitions — v2.2: simfolio first, merged report, holdings greyed
// v2.4: time-aware sections — show status based on market hours
function getMarketTimeState() {
  var now = new Date();
  var h = now.getHours();
  var m = now.getMinutes();
  var t = h * 60 + m;
  var day = now.getDay();
  var isTradingDay = day >= 1 && day <= 5;

  if (!isTradingDay) return 'closed';

  // Market sessions: 9:30-11:30, 13:00-15:00
  var inMorningSession = t >= 9*60+30 && t < 11*60+30;
  var inAfternoonSession = t >= 13*60 && t < 15*60;

  if (inMorningSession || inAfternoonSession) return 'trading';      // 交易中 → 暂不可用
  if (t >= 15*60 && t < 16*60) return 'generating';                   // 15:00-16:00 → 正在生成
  if (t >= 16*60 || (t >= 0 && t < 9*60+30)) return 'ready';         // 16:00后 → 可查看总结
  return 'closed';
}

function renderSectionByTime(data, mode, reportRenderer, sectionLabel) {
  var timeState = getMarketTimeState();
  var html = '';

  if (timeState === 'trading') {
    html += '<div class="unavailable-placeholder">';
    html += '<div class="lock-icon">⏳</div>';
    html += '<div class="lock-title">' + sectionLabel + ' — 暂不可用</div>';
    html += '<div class="lock-desc">市场交易中，AI 量化交易员正在实时监控。盘后总结报告将于每日16:00自动生成，届时可在此查看完整分析。</div>';
    html += '</div>';
  } else if (timeState === 'generating') {
    html += '<div class="unavailable-placeholder" style="border:2px dashed #f59e0b;">';
    html += '<div class="lock-icon">🔄</div>';
    html += '<div class="lock-title">正在分析并生成中...</div>';
    html += '<div class="lock-desc">市场已收盘，AI 正在汇总今日交易数据、量化评分、资金流向和板块动态，预计16:00前完成。请稍后再来查看。</div>';
    html += '</div>';
  } else if (timeState === 'ready') {
    // Try to load daily summary
    html += '<div id="daily-summary-container" style="max-width:960px;margin:0 auto;padding:20px 24px;">';
    html += '<div style="text-align:center;padding:40px;color:#64748b;">';
    html += '<div style="font-size:32px;margin-bottom:12px;">📊</div>';
    html += '<div style="font-size:16px;font-weight:600;">正在加载今日总结...</div>';
    html += '</div></div>';
    // Async load
    setTimeout(function() { loadDailySummaryIntoDOM(); }, 100);
  } else {
    // closed / non-trading day — use original report data
    html = reportRenderer(data, mode);
  }

  return html;
}

var SECTIONS = [
  { id: 'simfolio',        label: '模拟交易',         icon: '💰', render: function(d,m) { return renderSimfolioLive(d,m); } },
  { id: 'newsPolicy',      label: '时政要点',         icon: '📰', render: function(d,m) { return renderSectionByTime(d, m, renderNewsPolicy, '时政要点'); } },
  { id: 'tradingReport',   label: '交易分析与报告',   icon: '📊', render: function(d,m) { return renderSectionByTime(d, m, renderTradingReport, '交易分析与报告'); } },
  { id: 'holdingsAnalysis',label: '持仓分析',         icon: '💼', render: function(d,m) { return renderSectionByTime(d, m, renderHoldingsUnavailable, '持仓分析'); } },
];

// -- DOM refs --
var $contentArea, $contentTitle, $btnSendPdf, $btnGenPDF, $statusBar;
var $calendarWidget, $reportListItems, $sectionNavList;
var $toolbarDate, $pipelineProgress, $pipelineStep, $pipelineBar, $pipelinePct;
var $aiStatusBadge, $aiStatusDot, $aiStatusLabel;
var $navSimfolioBadge;

// -- Init --
function initApp() {
  $contentArea     = document.getElementById('content-area');
  $contentTitle    = document.getElementById('content-title');
  $btnSendPdf      = document.getElementById('btn-send-pdf');
  $btnGenPDF       = document.getElementById('btn-gen-pdf');
  $statusBar       = document.getElementById('status-bar');
  $calendarWidget  = document.getElementById('calendar-widget');
  $reportListItems = document.getElementById('report-list-items');
  $sectionNavList  = document.getElementById('section-nav-list');
  $toolbarDate     = document.getElementById('toolbar-date');
  $pipelineProgress = document.getElementById('pipeline-progress');
  $pipelineStep    = document.getElementById('pipeline-step');
  $pipelineBar     = document.getElementById('pipeline-bar');
  $pipelinePct     = document.getElementById('pipeline-pct');
  $aiStatusBadge   = document.getElementById('ai-status-badge');
  $aiStatusDot     = document.getElementById('ai-status-dot');
  $aiStatusLabel   = document.getElementById('ai-status-label');
  $navSimfolioBadge = document.getElementById('nav-simfolio-badge');

  var today = new Date();
  cal.year = today.getFullYear();
  cal.month = today.getMonth() + 1;

  // Check Mosaic server connection first
  checkServerStatus(function() {
    loadReportsIndex();

    // Enter live monitoring mode
    state.liveMode = true;
    startLivePoll();
    startCountdown();
  });

  // Bind events - PDF & email buttons
  if ($btnSendPdf) $btnSendPdf.addEventListener('click', onSendPdf);
  if ($btnGenPDF) $btnGenPDF.addEventListener('click', onGenPDF);

  // Think Tank button
  var $btnThinkTank = document.getElementById('btn-think-tank');
  if ($btnThinkTank) $btnThinkTank.addEventListener('click', function() {
    window.open('/think-tank.html', 'mosaic_think_tank', 'width=1400,height=900');
  });

  // Section nav delegation
  $sectionNavList.addEventListener('click', function(e) {
    var item = e.target.closest('.section-nav-item');
    if (!item) return;
    // Ignore disabled sections
    if (item.classList.contains('section-nav-disabled')) return;
    var sectionId = item.getAttribute('data-section');
    if (sectionId) {
      setActiveSection(sectionId);
    }
  });
}

// ============ Mosaic Server Connection ============

function checkServerStatus(callback) {
  fetch('/api/status')
    .then(function(res) { return res.json(); })
    .then(function(data) {
      state.serverConnected = true;
      state.serverStatus = data;
      state.schedulerStatus = data.scheduler || null;
      if (!state.liveMode) {
        updateStatus('Mosaic Server · ' + data.date + ' ' + data.weekday + ' · ' + (data.isTradingDay ? '🟢 交易日' : '⚫ 休市'));
      }
      if (callback) callback();
    })
    .catch(function() {
      state.serverConnected = false;
      state.serverStatus = null;
      updateStatus('离线模式 · 本地数据（未连接Mosaic Server）');
      if (callback) callback();
    });
}

// ============ Simfolio Live Section (v2.2) ============

function fetchSimfolioData(callback) {
  fetch('/api/simfolio/status')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var sfData = {
        snapshot: { totalValue: data.totalValue, cash: data.cash, totalReturn: data.totalReturn, benchmarkReturn: data.benchmarkReturn, alpha: data.alpha, positions: data.positions, positionValue: data.positionValue },
        stats: data.stats || {},
        tradeHistory: data.tradeHistory || [],
        dailyNav: [],
        time: new Date().toISOString(),
      };
      fetch('/api/simfolio/history')
        .then(function(r) { return r.json(); })
        .then(function(hist) {
          sfData.dailyNav = hist.dailyNav || [];
          callback(sfData);
        })
        .catch(function() { callback(sfData); });
    })
    .catch(function() { callback(null); });
}

function renderSimfolioLive(data, mode) {
  // In app mode, render live panel with countdown + activity feed
  // The actual render goes through renderSimfolio template with enhanced wrapper
  var sfData = state.simfolioData;
  if (!sfData || !sfData.snapshot) {
    return renderSimfolioEmpty();
  }
  return renderSimfolioLivePanel(sfData);
}

function renderSimfolioEmpty() {
  var html = '<div class="unavailable-placeholder">';
  html += '<div class="lock-icon">📊</div>';
  html += '<div class="lock-title">等待交易数据...</div>';
  html += '<div class="lock-desc">AI 量化交易员正在后台运行，交易数据将在开盘后自动生成。请确保 Mosaic Server 已启动。</div>';
  html += '</div>';
  return html;
}

function renderSimfolioLivePanel(sfData) {
  var snap = sfData.snapshot;
  var stats = sfData.stats || {};
  var trades = sfData.tradeHistory || [];
  var sched = state.schedulerStatus || {};

  // Build countdown bar
  var countdownHTML = renderCountdownBar(sched);

  // Build asset cards
  var cardsHTML = renderSimfolioCards(snap, stats);

  // Build trade activity feed
  var feedHTML = renderTradeActivityFeed(trades);

  // Build positions table (compact)
  var posHTML = '';
  if (snap.positions && snap.positions.length > 0) {
    posHTML += '<h3 style="font-size:14px;color:#1e293b;margin:16px 16px 8px;">📌 当前持仓</h3>';
    posHTML += renderCompactPositions(snap.positions);
  }

  // Build NAV chart if data available
  var chartHTML = '';
  if (sfData.dailyNav && sfData.dailyNav.length >= 2) {
    chartHTML += '<div style="margin:0 16px 16px;">';
    chartHTML += renderNavChart(sfData.dailyNav, false);
    chartHTML += '</div>';
  }

  var html = countdownHTML + cardsHTML + feedHTML + posHTML + chartHTML;

  // Wrap in a container
  return '<div id="simfolio-live-panel">' + html + '</div>';
}

function renderCountdownBar(sched) {
  var stateLabels = {
    'closed': '⚫ 休市等待中',
    'pre_market': '🌅 盘前准备',
    'morning_session': '🟢 早盘交易中',
    'lunch_break': '🍱 午间休市',
    'afternoon_session': '🟢 午盘交易中',
    'post_market': '🌇 盘后总结',
  };
  var label = stateLabels[sched.state] || sched.state;
  var nextTickMs = sched.nextTickMs || 0;
  var nextSec = Math.max(0, Math.round(nextTickMs / 1000));
  var isActive = sched.state === 'morning_session' || sched.state === 'afternoon_session';

  var html = '<div class="sf-countdown-bar' + (nextSec <= 10 && isActive ? ' flash-warn' : '') + '" id="sf-countdown-bar">';
  html += '<span style="font-size:14px;">⏱</span>';
  html += '<span>下次检查:</span>';
  html += '<span class="countdown-num" id="sf-countdown-num">' + nextSec + '</span>';
  html += '<span>秒</span>';
  html += '<span style="flex:1;"></span>';
  html += '<span>' + label + '</span>';
  if (sched.lastPipeline) {
    var ago = Math.round((Date.now() - new Date(sched.lastPipeline).getTime()) / 60000);
    html += '<span style="font-size:10px;opacity:0.7;"> · 上次扫描:' + ago + '分钟前</span>';
  }
  if (sched.opsRunning) {
    html += '<span style="font-size:11px;color:#f59e0b;"> · ⚙ 运行中...</span>';
  }
  html += '</div>';
  return html;
}

function renderSimfolioCards(snap, stats) {
  var prevSnap = (state.simfolioData && state.simfolioData._prevSnapshot) ? state.simfolioData._prevSnapshot : null;

  function flashClass(newVal, oldVal) {
    if (!oldVal || newVal === oldVal) return '';
    return newVal > oldVal ? ' flash-up' : ' flash-down';
  }

  var tvFlash = prevSnap ? flashClass(snap.totalValue, prevSnap.totalValue) : '';

  var html = '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:12px 16px;">';

  html += '<div style="background:#fff;border-radius:8px;padding:14px;border:1px solid #e2e5eb;">';
  html += '<div style="font-size:11px;color:' + MUTED_COLOR + ';margin-bottom:4px;">总资产</div>';
  html += '<div class="sf-card-value' + tvFlash + '" style="font-size:20px;font-weight:700;color:' + TEXT_COLOR + ';">¥' + formatMoneyCN(snap.totalValue) + '</div>';
  html += '<div style="font-size:11px;color:' + (snap.totalReturn >= 0 ? UP_COLOR : DOWN_COLOR) + ';">' + (snap.totalReturn >= 0 ? '+' : '') + snap.totalReturn.toFixed(2) + '%</div>';
  html += '</div>';

  html += '<div style="background:#fff;border-radius:8px;padding:14px;border:1px solid #e2e5eb;">';
  html += '<div style="font-size:11px;color:' + MUTED_COLOR + ';margin-bottom:4px;">现金</div>';
  html += '<div class="sf-card-value" style="font-size:20px;font-weight:700;color:' + TEXT_COLOR + ';">¥' + formatMoneyCN(snap.cash) + '</div>';
  html += '<div style="font-size:11px;color:' + MUTED_COLOR + ';">' + (snap.totalValue > 0 ? (snap.cash / snap.totalValue * 100).toFixed(0) : '0') + '% 可用</div>';
  html += '</div>';

  html += '<div style="background:#fff;border-radius:8px;padding:14px;border:1px solid #e2e5eb;">';
  html += '<div style="font-size:11px;color:' + MUTED_COLOR + ';margin-bottom:4px;">超额收益 α</div>';
  html += '<div class="sf-card-value" style="font-size:20px;font-weight:700;color:' + (snap.alpha >= 0 ? UP_COLOR : DOWN_COLOR) + ';">' + (snap.alpha >= 0 ? '+' : '') + snap.alpha.toFixed(2) + '%</div>';
  html += '<div style="font-size:11px;color:' + MUTED_COLOR + ';">基准: ' + (snap.benchmarkReturn >= 0 ? '+' : '') + snap.benchmarkReturn.toFixed(2) + '%</div>';
  html += '</div>';

  html += '<div style="background:#fff;border-radius:8px;padding:14px;border:1px solid #e2e5eb;">';
  html += '<div style="font-size:11px;color:' + MUTED_COLOR + ';margin-bottom:4px;">持仓 / 统计</div>';
  html += '<div style="font-size:13px;color:' + TEXT_COLOR + ';line-height:1.7;">';
  html += '<b>' + (snap.positions ? snap.positions.length : 0) + '</b> 只股票';
  if (stats.winRate != null) html += ' · 胜率 <b style="color:' + (stats.winRate >= 50 ? UP_COLOR : DOWN_COLOR) + ';">' + stats.winRate + '%</b>';
  if (stats.maxDrawdown != null) html += '<br>最大回撤 <b style="color:#dc2626;">' + stats.maxDrawdown.toFixed(2) + '%</b>';
  if (stats.totalTrades) html += ' · ' + stats.totalTrades + '笔交易';
  html += '</div>';
  html += '</div>';

  html += '</div>';
  return html;
}

function renderTradeActivityFeed(trades) {
  var html = '<div class="sf-trade-feed">';
  html += '<div class="sf-trade-feed-header">📋 交易动态 <span style="font-weight:400;font-size:10px;margin-left:auto;" id="feed-update-time"></span></div>';

  if (!trades || trades.length === 0) {
    html += '<div class="sf-trade-feed-empty">暂无交易记录 — AI 交易员将在开盘后自动执行买卖</div>';
  } else {
    var recent = trades.slice(-8).reverse();
    for (var i = 0; i < recent.length; i++) {
      var t = recent[i];
      var isBuy = t.action === 'buy';
      var isAuto = !!t.triggeredBy;
      var cls = isAuto ? 'auto' : (isBuy ? 'buy' : 'sell');
      var icon = isAuto ? '🤖' : (isBuy ? '🔴' : '🟢');
      var actionLabel = isBuy ? '买入' : '卖出';

      html += '<div class="sf-trade-feed-item ' + cls + '">';
      html += '<span>' + icon + '</span>';
      html += '<span style="font-weight:600;color:' + (isBuy ? '#dc2626' : '#16a34a') + ';">' + actionLabel + '</span>';
      html += '<span style="font-weight:600;">' + escHtml(t.name) + '</span>';
      html += '<span style="color:#94a3b8;font-size:11px;">' + t.code + '</span>';
      html += '<span>¥' + t.price.toFixed(2) + ' × ' + t.shares + '股</span>';
      html += '<span style="font-weight:600;">¥' + formatMoneyCN(t.amount) + '</span>';
      if (t.action === 'sell' && t.pnlPct != null) {
        html += '<span style="color:' + (t.pnlPct >= 0 ? UP_COLOR : DOWN_COLOR) + ';font-size:11px;">' + (t.pnlPct >= 0 ? '+' : '') + t.pnlPct.toFixed(2) + '%</span>';
      }
      html += '<span style="flex:1;"></span>';
      html += '<span style="font-size:10px;color:#94a3b8;">' + (t.date || '') + ' ' + (t.time || '') + '</span>';
      html += '</div>';
    }
  }
  html += '</div>';
  return html;
}

function renderCompactPositions(positions) {
  var html = '<div style="margin:0 16px;border-radius:8px;overflow:hidden;border:1px solid #e2e5eb;">';
  html += '<table style="width:100%;border-collapse:collapse;font-size:12px;">';
  html += '<thead><tr style="background:#f8fafc;border-bottom:2px solid #b8942c;">';
  html += '<th style="padding:8px;text-align:left;">股票</th><th style="padding:8px;text-align:right;">成本</th><th style="padding:8px;text-align:right;">现价</th><th style="padding:8px;text-align:right;">股数</th><th style="padding:8px;text-align:right;">市值</th><th style="padding:8px;text-align:right;">盈亏</th></tr></thead><tbody>';

  for (var i = 0; i < positions.length; i++) {
    var p = positions[i];
    var pnlColor = p.pnl >= 0 ? UP_COLOR : DOWN_COLOR;
    html += '<tr style="border-bottom:1px solid #f1f5f9;">';
    html += '<td style="padding:8px;"><b>' + escHtml(p.name) + '</b><br><span style="color:#94a3b8;font-size:10px;">' + p.code + '</span></td>';
    html += '<td style="padding:8px;text-align:right;">¥' + p.avgCost.toFixed(2) + '</td>';
    html += '<td style="padding:8px;text-align:right;">¥' + p.currentPrice.toFixed(2) + '</td>';
    html += '<td style="padding:8px;text-align:right;">' + p.shares + '</td>';
    html += '<td style="padding:8px;text-align:right;">¥' + formatMoneyCN(p.marketValue) + '</td>';
    html += '<td style="padding:8px;text-align:right;color:' + pnlColor + ';font-weight:600;">' + (p.pnl >= 0 ? '+' : '') + formatMoneyCN(p.pnl) + '<br><span style="font-size:10px;">' + (p.pnlPct >= 0 ? '+' : '') + p.pnlPct.toFixed(2) + '%</span></td>';
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  return html;
}

function formatMoneyCN(val) {
  if (val == null) return '0';
  return val.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}

// ============ Trading Report (Merged) ============

function renderTradingReport(data, mode) {
  // Merge: cover + marketOverview + sectorTracking + lowPricePicks + top5Ranking + riskMatrix
  var sections = [
    { title: '报告封面', html: renderCover(data, mode) },
    { title: '大盘综述', html: renderMarketOverview(data, mode) },
    { title: '板块跟踪', html: renderSectorTracking(data, mode) },
    { title: '潜力股推荐', html: renderLowPricePicks(data, mode) },
    { title: 'TOP5 排行', html: renderTop5Ranking(data, mode) },
    { title: '风险矩阵', html: renderRiskMatrix(data, mode) },
  ];

  var html = '<div style="max-width:960px;margin:0 auto;padding:20px 24px;">';
  for (var i = 0; i < sections.length; i++) {
    html += '<div style="margin-bottom:24px;">';
    html += sections[i].html;
    html += '</div>';
  }
  html += '</div>';
  return html;
}

// ============ Daily Summary Loader (v2.4) ============

function loadDailySummaryIntoDOM() {
  var container = document.getElementById('daily-summary-container');
  if (!container) return;

  fetch('/api/daily-summary/latest')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.ok) {
        container.innerHTML = '<div class="unavailable-placeholder">' +
          '<div class="lock-icon">📊</div>' +
          '<div class="lock-title">今日总结尚未生成</div>' +
          '<div class="lock-desc">' + (data.message || '请于16:00后查看') + '</div>' +
          '</div>';
        return;
      }
      container.innerHTML = renderDailySummary(data);
    })
    .catch(function() {
      container.innerHTML = '<div class="unavailable-placeholder">' +
        '<div class="lock-icon">⚠️</div>' +
        '<div class="lock-title">加载失败</div>' +
        '<div class="lock-desc">无法连接到服务器，请检查 Mosaic Server 是否运行。</div>' +
        '</div>';
    });
}

function renderDailySummary(s) {
  var html = '';

  // Title
  html += '<div style="text-align:center;margin-bottom:24px;">';
  html += '<h2 style="font-size:22px;color:#1e293b;margin:0 0 4px;">📋 ' + (s.date || '') + ' 盘后总结报告</h2>';
  html += '<p style="font-size:12px;color:#94a3b8;">生成时间: ' + new Date(s.generatedAt).toTimeString().slice(0,8) + ' · Mosaic AI 量化引擎自动生成</p>';
  html += '</div>';

  // Market Overview
  if (s.market && s.market.indices && s.market.indices.length > 0) {
    html += '<div style="background:#fff;border-radius:8px;padding:16px;margin-bottom:16px;border:1px solid #e2e5eb;">';
    html += '<h3 style="font-size:14px;color:#1e293b;margin:0 0 12px;">📈 大盘行情</h3>';
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;">';
    for (var i = 0; i < s.market.indices.length; i++) {
      var idx = s.market.indices[i];
      var changeColor = (idx.changePercent || 0) >= 0 ? UP_COLOR : DOWN_COLOR;
      var changeSign = (idx.changePercent || 0) >= 0 ? '+' : '';
      html += '<div style="background:#f8fafc;border-radius:6px;padding:10px 14px;">';
      html += '<div style="font-size:13px;font-weight:600;color:#1e293b;">' + escHtml(idx.name) + '</div>';
      html += '<div style="font-size:18px;font-weight:700;margin:4px 0;">' + (idx.price || '--') + '</div>';
      html += '<div style="font-size:12px;color:' + changeColor + ';">' + changeSign + (idx.changePercent || 0).toFixed(2) + '%</div>';
      html += '</div>';
    }
    html += '</div></div>';
  }

  // Portfolio Summary
  if (s.portfolio) {
    var p = s.portfolio;
    var retColor = p.totalReturn >= 0 ? UP_COLOR : DOWN_COLOR;
    var alphaColor = p.alpha >= 0 ? UP_COLOR : DOWN_COLOR;
    html += '<div style="background:#fff;border-radius:8px;padding:16px;margin-bottom:16px;border:1px solid #e2e5eb;">';
    html += '<h3 style="font-size:14px;color:#1e293b;margin:0 0 12px;">💰 模拟交易总结</h3>';
    html += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px;">';
    html += '<div style="text-align:center;"><div style="font-size:11px;color:#94a3b8;">总资产</div><div style="font-size:18px;font-weight:700;">¥' + formatMoneyCN(p.totalValue) + '</div></div>';
    html += '<div style="text-align:center;"><div style="font-size:11px;color:#94a3b8;">总收益</div><div style="font-size:18px;font-weight:700;color:' + retColor + ';">' + (p.totalReturn >= 0 ? '+' : '') + p.totalReturn.toFixed(2) + '%</div></div>';
    html += '<div style="text-align:center;"><div style="font-size:11px;color:#94a3b8;">超额收益 α</div><div style="font-size:18px;font-weight:700;color:' + alphaColor + ';">' + (p.alpha >= 0 ? '+' : '') + p.alpha.toFixed(2) + '%</div></div>';
    html += '<div style="text-align:center;"><div style="font-size:11px;color:#94a3b8;">可用现金</div><div style="font-size:18px;font-weight:700;">¥' + formatMoneyCN(p.cash) + '</div></div>';
    html += '</div>';

    // Positions
    if (p.positions && p.positions.length > 0) {
      html += '<table style="width:100%;border-collapse:collapse;font-size:12px;">';
      html += '<thead><tr style="background:#f8fafc;border-bottom:2px solid #b8942c;">';
      html += '<th style="padding:8px;text-align:left;">股票</th><th style="padding:8px;text-align:right;">成本</th><th style="padding:8px;text-align:right;">现价</th><th style="padding:8px;text-align:right;">盈亏</th></tr></thead><tbody>';
      for (var j = 0; j < p.positions.length; j++) {
        var pos = p.positions[j];
        var pnlColor = pos.pnl >= 0 ? UP_COLOR : DOWN_COLOR;
        html += '<tr style="border-bottom:1px solid #f1f5f9;">';
        html += '<td style="padding:8px;"><b>' + escHtml(pos.name) + '</b><br><span style="color:#94a3b8;font-size:10px;">' + pos.code + '</span></td>';
        html += '<td style="padding:8px;text-align:right;">¥' + pos.avgCost.toFixed(2) + '</td>';
        html += '<td style="padding:8px;text-align:right;">¥' + pos.currentPrice.toFixed(2) + '</td>';
        html += '<td style="padding:8px;text-align:right;color:' + pnlColor + ';font-weight:600;">' + (pos.pnl >= 0 ? '+' : '') + pos.pnlPct.toFixed(2) + '%</td>';
        html += '</tr>';
      }
      html += '</tbody></table>';
    }
    html += '</div>';
  }

  // Today's Trades
  if (s.todayTrades && s.todayTrades.length > 0) {
    html += '<div style="background:#fff;border-radius:8px;padding:16px;margin-bottom:16px;border:1px solid #e2e5eb;">';
    html += '<h3 style="font-size:14px;color:#1e293b;margin:0 0 12px;">📋 今日交易记录 (' + s.todayTrades.length + '笔)</h3>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:12px;">';
    html += '<thead><tr style="background:#f8fafc;border-bottom:2px solid #b8942c;">';
    html += '<th style="padding:8px;">时间</th><th style="padding:8px;">操作</th><th style="padding:8px;">股票</th><th style="padding:8px;text-align:right;">价格</th><th style="padding:8px;text-align:right;">数量</th><th style="padding:8px;text-align:right;">金额</th><th style="padding:8px;">原因</th></tr></thead><tbody>';
    for (var k = 0; k < s.todayTrades.length; k++) {
      var tr = s.todayTrades[k];
      var isBuy = tr.action === 'buy';
      var actionLabel = isBuy ? '🔴 买入' : '🟢 卖出';
      html += '<tr style="border-bottom:1px solid #f1f5f9;">';
      html += '<td style="padding:8px;font-size:11px;">' + (tr.date||'') + ' ' + (tr.time||'') + '</td>';
      html += '<td style="padding:8px;font-weight:600;color:' + (isBuy ? UP_COLOR : DOWN_COLOR) + ';">' + actionLabel + '</td>';
      html += '<td style="padding:8px;"><b>' + escHtml(tr.name) + '</b><br><span style="color:#94a3b8;font-size:10px;">' + tr.code + '</span></td>';
      html += '<td style="padding:8px;text-align:right;">¥' + tr.price.toFixed(2) + '</td>';
      html += '<td style="padding:8px;text-align:right;">' + tr.shares + '股</td>';
      html += '<td style="padding:8px;text-align:right;">¥' + formatMoneyCN(tr.amount) + '</td>';
      html += '<td style="padding:8px;font-size:11px;color:#64748b;">' + escHtml(tr.reason || '') + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table></div>';
  }

  // Pipeline Summary
  if (s.pipeline) {
    var pl = s.pipeline;
    html += '<div style="background:#fff;border-radius:8px;padding:16px;margin-bottom:16px;border:1px solid #e2e5eb;">';
    html += '<h3 style="font-size:14px;color:#1e293b;margin:0 0 12px;">🔬 量化分析总结</h3>';
    html += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px;">';
    html += '<div style="text-align:center;"><div style="font-size:11px;color:#94a3b8;">扫描类型</div><div style="font-size:16px;font-weight:600;">' + (pl.type === 'full' ? '全量扫描' : '盘中扫描') + '</div></div>';
    html += '<div style="text-align:center;"><div style="font-size:11px;color:#94a3b8;">深度分析</div><div style="font-size:16px;font-weight:600;">' + (pl.analyzed || 0) + ' 只</div></div>';
    html += '<div style="text-align:center;"><div style="font-size:11px;color:#94a3b8;">平均分</div><div style="font-size:16px;font-weight:600;">' + (pl.avgScore || 0) + '</div></div>';
    html += '<div style="text-align:center;"><div style="font-size:11px;color:#94a3b8;">最高分</div><div style="font-size:16px;font-weight:600;color:#f59e0b;">' + (pl.maxScore || 0) + '</div></div>';
    html += '</div>';

    if (pl.top5 && pl.top5.length > 0) {
      html += '<div style="font-size:12px;color:#64748b;margin-bottom:4px;">TOP5 推荐:</div>';
      for (var ti = 0; ti < pl.top5.length; ti++) {
        var top = pl.top5[ti];
        html += '<div style="padding:4px 0;font-size:13px;border-bottom:1px solid #f1f5f9;">';
        html += '<span style="font-weight:600;color:#1e293b;">#' + (ti+1) + ' ' + escHtml(top.name) + '</span> ';
        html += '<span style="color:#94a3b8;">' + top.code + '</span> ';
        html += '<span style="color:#f59e0b;font-weight:600;">' + top.score + '分</span> ';
        html += '<span style="color:#94a3b8;">' + (top.rating || '') + '</span>';
        html += '</div>';
      }
    }
    html += '</div>';
  }

  // Stats
  if (s.stats) {
    html += '<div style="background:#fff;border-radius:8px;padding:16px;margin-bottom:16px;border:1px solid #e2e5eb;">';
    html += '<h3 style="font-size:14px;color:#1e293b;margin:0 0 12px;">📊 账户统计</h3>';
    html += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;">';
    html += '<div style="text-align:center;"><div style="font-size:11px;color:#94a3b8;">胜率</div><div style="font-size:16px;font-weight:600;">' + (s.stats.winRate != null ? s.stats.winRate + '%' : '--') + '</div></div>';
    html += '<div style="text-align:center;"><div style="font-size:11px;color:#94a3b8;">最大回撤</div><div style="font-size:16px;font-weight:600;color:#dc2626;">' + (s.stats.maxDrawdown || 0).toFixed(2) + '%</div></div>';
    html += '<div style="text-align:center;"><div style="font-size:11px;color:#94a3b8;">夏普比率</div><div style="font-size:16px;font-weight:600;">' + (s.stats.sharpeRatio || '--') + '</div></div>';
    html += '<div style="text-align:center;"><div style="font-size:11px;color:#94a3b8;">总交易</div><div style="font-size:16px;font-weight:600;">' + (s.stats.totalTrades || 0) + ' 笔</div></div>';
    html += '</div></div>';
  }

  // Activity summary
  html += '<div style="background:#fff;border-radius:8px;padding:16px;border:1px solid #e2e5eb;">';
  html += '<h3 style="font-size:14px;color:#1e293b;margin:0 0 8px;">📡 今日活动</h3>';
  html += '<div style="font-size:13px;color:#64748b;line-height:1.8;">';
  html += '<div>🔍 量化扫描: <b>' + (s.scanCount || 0) + '</b> 次</div>';
  html += '<div>💹 交易执行: <b>' + (s.tradeCount || 0) + '</b> 笔</div>';
  html += '<div>📝 事件记录: <b>' + (s.eventCount || 0) + '</b> 条</div>';
  html += '</div></div>';

  return html;
}

// ============ Holdings Unavailable ============

function renderHoldingsUnavailable(data, mode) {
  var html = '<div class="unavailable-placeholder">';
  html += '<div class="lock-icon">🔒</div>';
  html += '<div class="lock-title">持仓分析 — 暂不可用</div>';
  html += '<div class="lock-desc">您当前的持仓策略是长期持有等待宇树科技上市后再清仓。持仓分析功能将在您准备进行下一步操作时重新开放。</div>';
  html += '</div>';
  return html;
}

// ============ Live Monitoring (v2.2) ============

var _livePollTimer = null;
var _lastNotifiedTradeTime = null;

function startCountdown() {
  if (state.countdownInterval) clearInterval(state.countdownInterval);
  state.countdownInterval = setInterval(tickCountdown, 1000);
}

function tickCountdown() {
  if (!state.schedulerStatus || state.schedulerStatus.nextTickMs == null) return;

  var ms = state.schedulerStatus.nextTickMs - 1000;
  if (ms < 0) ms = 0;
  state.schedulerStatus.nextTickMs = ms;

  var sec = Math.round(ms / 1000);
  state.countdownSec = sec;

  // Update countdown in simfolio panel
  var countdownEl = document.getElementById('sf-countdown-num');
  if (countdownEl) {
    countdownEl.textContent = sec;
    if (sec <= 10) {
      countdownEl.style.color = '#ef4444';
    } else if (sec <= 30) {
      countdownEl.style.color = '#f59e0b';
    } else {
      countdownEl.style.color = '#d4a843';
    }
  }

  // Flash the countdown bar when close to tick
  var bar = document.getElementById('sf-countdown-bar');
  if (bar) {
    var isActive = state.schedulerStatus.state === 'morning_session' || state.schedulerStatus.state === 'afternoon_session';
    if (sec <= 10 && isActive) {
      bar.classList.add('flash-warn');
    } else {
      bar.classList.remove('flash-warn');
    }
  }

}

function startLivePoll() {
  if (_livePollTimer) clearTimeout(_livePollTimer);
  state.liveMode = true;
  pollLiveStatus();
  // Also refresh simfolio data periodically
  refreshSimfolioPeriodic();
}

function stopLivePoll() {
  state.liveMode = false;
  if (_livePollTimer) { clearTimeout(_livePollTimer); _livePollTimer = null; }
  if (state.countdownInterval) { clearInterval(state.countdownInterval); state.countdownInterval = null; }
}

function pollLiveStatus() {
  if (!state.serverConnected) {
    _livePollTimer = setTimeout(pollLiveStatus, 30000);
    return;
  }

  // Fetch scheduler status
  fetch('/api/scheduler/status')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      state.schedulerStatus = data;

      // Fetch simfolio status for trade notifications
      fetch('/api/simfolio/status')
        .then(function(r) { return r.json(); })
        .then(function(sfData) {
          // Check for new auto-trades
          var trades = sfData.tradeHistory || [];
          for (var i = trades.length - 1; i >= 0; i--) {
            var t = trades[i];
            if (t.triggeredBy && t.time) {
              var tradeId = t.date + 'T' + t.time + '_' + t.code;
              if (_lastNotifiedTradeTime !== tradeId) {
                _lastNotifiedTradeTime = tradeId;
                showTradeNotification(t);
                break;
              }
            }
          }
        })
        .catch(function() {});

      // Update AI status badge
      updateAIStatusBadge(data);
      // Update live status display
      updateLiveStatusDisplay(data);
      // Update nav simfolio badge
      updateNavSimfolioBadge(data);

      var isActive = data.state === 'morning_session' || data.state === 'afternoon_session';
      var interval = isActive ? 5000 : 15000;
      _livePollTimer = setTimeout(pollLiveStatus, interval);
    })
    .catch(function() {
      setAIStatusOffline();
      _livePollTimer = setTimeout(pollLiveStatus, 30000);
    });
}

function updateAIStatusBadge(sched) {
  if (!$aiStatusBadge || !$aiStatusLabel) return;

  var state = sched.state || 'closed';
  var isTrading = state === 'morning_session' || state === 'afternoon_session';
  var isPrePost = state === 'pre_market' || state === 'post_market';
  var opsRunning = sched.opsRunning;

  // Remove all state classes
  $aiStatusBadge.classList.remove('live', 'trading', 'error');

  if (opsRunning) {
    $aiStatusBadge.classList.add('trading');
    $aiStatusLabel.textContent = '量化交易 · 运行中';
  } else if (isTrading) {
    $aiStatusBadge.classList.add('trading');
    $aiStatusLabel.textContent = '量化交易 · 进行中';
  } else if (isPrePost) {
    $aiStatusBadge.classList.add('live');
    $aiStatusLabel.textContent = '量化交易 · ' + (state === 'pre_market' ? '盘前准备' : '盘后总结');
  } else {
    $aiStatusBadge.classList.add('live');
    $aiStatusLabel.textContent = '量化交易 · 就绪';
  }
}

function setAIStatusOffline() {
  if (!$aiStatusBadge || !$aiStatusLabel) return;
  $aiStatusBadge.classList.remove('live', 'trading');
  $aiStatusBadge.classList.add('error');
  $aiStatusLabel.textContent = '量化交易 · 离线';
}

function updateNavSimfolioBadge(sched) {
  if (!$navSimfolioBadge) return;
  var isActive = sched.state === 'morning_session' || sched.state === 'afternoon_session';
  if (isActive) {
    $navSimfolioBadge.style.display = 'inline-block';
    $navSimfolioBadge.textContent = 'LIVE';
    $navSimfolioBadge.style.background = '#fef3c7';
    $navSimfolioBadge.style.color = '#92400e';
  } else if (sched.state === 'pre_market' || sched.state === 'post_market') {
    $navSimfolioBadge.style.display = 'inline-block';
    $navSimfolioBadge.textContent = '待命';
    $navSimfolioBadge.style.background = '#f1f5f9';
    $navSimfolioBadge.style.color = '#64748b';
  } else {
    $navSimfolioBadge.style.display = 'none';
  }
}

function updateLiveStatusDisplay(sched) {
  if (!sched) return;

  var stateLabels = {
    'closed': '⚫ 休市',
    'pre_market': '🌅 盘前准备',
    'morning_session': '🟢 早盘交易中',
    'lunch_break': '🍱 午休',
    'afternoon_session': '🟢 午盘交易中',
    'post_market': '🌇 盘后总结',
  };

  var label = stateLabels[sched.state] || sched.state;
  var statusText = '📡 ' + label;

  if (sched.nextTickMs != null && sched.nextTickMs > 0) {
    var secs = Math.round(sched.nextTickMs / 1000);
    statusText += ' · 下次检查: ' + secs + 's';
  }

  if (sched.positionAlerts && sched.positionAlerts.length > 0) {
    var criticalCount = 0;
    for (var i = 0; i < sched.positionAlerts.length; i++) {
      if (sched.positionAlerts[i].priority === 'critical') criticalCount++;
    }
    if (criticalCount > 0) {
      statusText += ' · ⚠️ ' + criticalCount + '个股触发止损';
    }
  }

  if (sched.lastPipeline) {
    var lastTime = new Date(sched.lastPipeline);
    var minAgo = Math.round((Date.now() - lastTime) / 60000);
    statusText += ' · 上次扫描: ' + minAgo + '分钟前';
  }

  updateStatus(statusText);
}

// Separate periodic simfolio data refresh for the live panel
function refreshSimfolioPeriodic() {
  if (!state.serverConnected) {
    setTimeout(refreshSimfolioPeriodic, 30000);
    return;
  }

  var prevSnapshot = state.simfolioData ? state.simfolioData.snapshot : null;
  var prevTradeCount = state.simfolioData ? (state.simfolioData.tradeHistory ? state.simfolioData.tradeHistory.length : 0) : 0;

  fetchSimfolioData(function(sfData) {
    if (sfData) {
      sfData._prevSnapshot = prevSnapshot;
      state.simfolioData = sfData;

      // Only re-render if data changed meaningfully and simfolio is active
      if (state.activeSection === 'simfolio') {
        var newTotal = sfData.snapshot ? sfData.snapshot.totalValue : null;
        var prevTotal = prevSnapshot ? prevSnapshot.totalValue : null;
        var newTradeCount = sfData.tradeHistory ? sfData.tradeHistory.length : 0;

        // Re-render if value changed or new trades
        if (newTotal !== prevTotal || newTradeCount !== prevTradeCount) {
          updateSimfolioDOM(sfData);
        }
        // Update feed timestamp
        var timeEl = document.getElementById('feed-update-time');
        if (timeEl) {
          var now = new Date();
          timeEl.textContent = now.toTimeString().slice(0, 8);
        }
      }
    }
    var isActive = state.schedulerStatus &&
      (state.schedulerStatus.state === 'morning_session' || state.schedulerStatus.state === 'afternoon_session');
    setTimeout(refreshSimfolioPeriodic, isActive ? 5000 : 30000);
  });
}

// Lightweight DOM update without full re-render
function updateSimfolioDOM(sfData) {
  // Update the countdown bar (scheduler status may have changed)
  if (state.schedulerStatus) {
    var bar = document.getElementById('sf-countdown-bar');
    if (bar) {
      bar.outerHTML = renderCountdownBar(state.schedulerStatus);
    }
  }

  // Update asset cards
  var container = $contentArea.querySelector('.report-preview');
  if (!container) return;

  // Find and update card values
  var cards = container.querySelectorAll('.sf-card-value');
  var snap = sfData.snapshot;
  if (snap && cards.length >= 4) {
    cards[0].textContent = '¥' + formatMoneyCN(snap.totalValue);
    cards[1].textContent = '¥' + formatMoneyCN(snap.cash);
    cards[2].textContent = (snap.alpha >= 0 ? '+' : '') + snap.alpha.toFixed(2) + '%';
  }

  // Update positions table if present
  if (snap && snap.positions && snap.positions.length > 0) {
    var posTable = container.querySelector('table');
    // For now, if positions changed significantly, do full refresh
    // Simple check: if table row count differs
    if (posTable) {
      var rows = posTable.querySelectorAll('tbody tr');
      if (rows.length !== snap.positions.length) {
        renderCurrentSection();
      }
    }
  }
}

// ---- Trade Notification Toast ----

function showTradeNotification(trade) {
  var isBuy = trade.action === 'buy';
  var isAuto = !!trade.triggeredBy;
  var icon = isAuto ? '🤖' : (isBuy ? '🔴' : '🟢');
  var actionLabel = isBuy ? '买入' : '卖出';
  var autoLabel = isAuto ? '[自动] ' : '';
  var pnlText = '';
  if (!isBuy && trade.pnlPct != null) {
    pnlText = ' | ' + (trade.pnl >= 0 ? '+' : '') + trade.pnlPct.toFixed(2) + '%';
  }

  var toast = document.createElement('div');
  toast.className = 'trade-toast';
  toast.style.cssText = 'position:fixed;top:70px;right:20px;z-index:10000;' +
    'background:#1e293b;color:#e2e8f0;border-left:4px solid ' + (isAuto ? '#f59e0b' : (isBuy ? '#ef4444' : '#22c55e')) + ';' +
    'border-radius:8px;padding:12px 18px;font-size:13px;max-width:360px;' +
    'box-shadow:0 8px 32px rgba(0,0,0,0.4);animation:slideInRight 0.3s ease-out;' +
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

  toast.innerHTML = '<div style="font-weight:600;margin-bottom:4px;">' + icon + ' ' + autoLabel + actionLabel + ' · ' + trade.name + ' (' + trade.code + ')</div>' +
    '<div style="font-size:12px;opacity:0.8;">' +
    '价格: ¥' + trade.price.toFixed(2) + ' · ' + trade.shares + '股 | 金额: ¥' + formatMoneyCN(trade.amount) + pnlText +
    '</div>' +
    '<div style="font-size:11px;opacity:0.6;margin-top:2px;">' + (trade.date || '') + ' ' + (trade.time || '') + ' ' + (trade.reason || '') + '</div>';

  document.body.appendChild(toast);

  // Remove after 8 seconds
  setTimeout(function() {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.5s';
    setTimeout(function() {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 500);
  }, 8000);

  // Store in state
  state.tradeNotifications.unshift(trade);
  if (state.tradeNotifications.length > 20) state.tradeNotifications.pop();
}

// ============ Reports Index ============

function loadReportsIndex() {
  var index = window.__REPORTS_INDEX__;
  if (!index || !index.reports) {
    updateStatus('报告索引加载失败，请检查 data/reports-index.js');
    renderCalendar();
    renderReportList();
    return;
  }

  state.reportsIndex = index.reports;
  state.reportsByDate = {};
  index.reports.forEach(function(r) {
    if (!state.reportsByDate[r.date]) state.reportsByDate[r.date] = [];
    state.reportsByDate[r.date].push(r);
  });

  // Find the latest viewable report and auto-load it
  var sorted = index.reports.slice().sort(function(a, b) { return b.date.localeCompare(a.date); });
  var latest = null;
  for (var i = 0; i < sorted.length; i++) {
    if (sorted[i].viewMode !== 'pdf-only') {
      latest = sorted[i];
      break;
    }
  }
  if (latest) {
    cal.activeDate = latest.date;
    loadReportByMeta(latest);
  }

  renderCalendar();
  renderReportList();
}

function loadReportByMeta(meta) {
  state.currentDate = meta.date;
  state.currentReportMeta = meta;
  state.currentViewMode = meta.viewMode;
  cal.activeDate = meta.date;

  // Update toolbar date
  if ($toolbarDate) {
    $toolbarDate.textContent = formatDateChinese(meta.date);
  }

  if (meta.viewMode === 'engine' && meta.jsonFile) {
    var key = meta.jsonFile.replace('.json', '');
    var data = (window.__REPORT_DATA__ || {})[key];
    if (data) {
      state.reportData = data;
      state.dirty = false;
      // Render current section (or cover by default)
      setActiveSection(state.activeSection);
      updateStatus('已加载 ' + meta.title + ' (' + meta.date + ')');
    } else {
      updateStatus('加载失败: 找不到 ' + key + ' 的数据');
    }
  } else if (meta.viewMode === 'html' && meta.sourceFile) {
    state.reportData = null;
    state.dirty = false;
    // For HTML reports, show in iframe
    $contentArea.innerHTML = '<iframe src="' + meta.sourceFile + '" style="width:100%;height:100%;border:none;min-height:80vh;"></iframe>';
    updateStatus('已加载 ' + meta.title + ' (' + meta.date + ')  [原始报告]');
  } else if (meta.viewMode === 'pdf-only') {
    $contentArea.innerHTML = '<div class="content-placeholder"><p style="font-size:48px;margin-bottom:16px;">📄</p><p style="font-size:16px;font-weight:600;">' + meta.title + '</p><p style="font-size:13px;color:#94a3b8;">此报告仅存有 PDF 版本，请在文件管理器中打开</p></div>';
    updateStatus(meta.title + ' (' + meta.date + ') — 仅PDF，无预览');
  }
}

// ============ Section Navigation ============

function setActiveSection(sectionId) {
  state.activeSection = sectionId;
  state.activeMode = 'section';

  // Update nav highlight
  var items = $sectionNavList.querySelectorAll('.section-nav-item');
  items.forEach(function(item) {
    item.classList.toggle('active', item.getAttribute('data-section') === sectionId);
  });

  // Find section definition
  var sec = null;
  for (var i = 0; i < SECTIONS.length; i++) {
    if (SECTIONS[i].id === sectionId) { sec = SECTIONS[i]; break; }
  }

  if ($contentTitle) {
    $contentTitle.textContent = sec ? sec.label : sectionId;
    // Add simfolio accent class
    if (sectionId === 'simfolio') {
      $contentTitle.parentElement.classList.add('simfolio-header');
    } else {
      $contentTitle.parentElement.classList.remove('simfolio-header');
    }
  }

  renderCurrentSection();
}

function renderCurrentSection() {
  // For non-engine views, loadReportByMeta already handled content
  if (!state.reportData || state.currentViewMode !== 'engine') {
    // But still allow simfolio to render without report data
    if (state.activeSection === 'simfolio' && state.serverConnected) {
      renderSimfolioDirect();
      return;
    }
    return;
  }

  var sectionId = state.activeSection;
  var sec = null;
  for (var i = 0; i < SECTIONS.length; i++) {
    if (SECTIONS[i].id === sectionId) { sec = SECTIONS[i]; break; }
  }

  if (!sec) return;

  // Simfolio renders directly (no iframe) for live DOM updates
  if (sectionId === 'simfolio') {
    renderSimfolioDirect();
    return;
  }

  // Time-aware sections may need async loading, render directly
  var timeState = getMarketTimeState();
  if (sectionId !== 'simfolio' && (timeState === 'trading' || timeState === 'generating' || timeState === 'ready')) {
    renderTimeAwareSectionDirect(sectionId);
    return;
  }

  try {
    var sectionHTML = sec.render(state.reportData, 'app');
    var css = renderSoftwareCSS();

    var fullHTML = '<div class="report-preview">' + sectionHTML + '</div>';

    // Use srcdoc in a sandboxed iframe for proper CSS isolation
    var wrapperHTML = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>' + css + '</style></head><body>' + fullHTML + '</body></html>';

    $contentArea.innerHTML = '';
    var iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:100%;height:100%;border:none;min-height:70vh;';
    iframe.sandbox = 'allow-same-origin allow-scripts';
    iframe.srcdoc = wrapperHTML;
    $contentArea.appendChild(iframe);
  } catch (e) {
    $contentArea.innerHTML = '<div class="content-placeholder"><p style="color:#e74c3c;">渲染出错: ' + escHtml(e.message) + '</p></div>';
  }
}

// Direct render time-aware section into content area (no iframe, allows async loading)
function renderTimeAwareSectionDirect(sectionId) {
  var sec = null;
  for (var i = 0; i < SECTIONS.length; i++) {
    if (SECTIONS[i].id === sectionId) { sec = SECTIONS[i]; break; }
  }
  if (!sec) return;

  try {
    var sectionHTML = sec.render(state.reportData, 'app');
    var css = renderSoftwareCSS();

    $contentArea.innerHTML = '';
    var container = document.createElement('div');
    container.style.cssText = 'height:100%;overflow-y:auto;background:#f5f6fa;';

    var styleEl = document.createElement('style');
    styleEl.textContent = css;
    container.appendChild(styleEl);

    var contentDiv = document.createElement('div');
    contentDiv.className = 'report-preview';
    contentDiv.innerHTML = sectionHTML;
    container.appendChild(contentDiv);

    $contentArea.appendChild(container);
  } catch (e) {
    $contentArea.innerHTML = '<div class="content-placeholder"><p style="color:#e74c3c;">渲染出错: ' + escHtml(e.message) + '</p></div>';
  }
}

// Direct render simfolio into content area (no iframe, allows live DOM updates)
function renderSimfolioDirect() {
  if (!state.simfolioData || !state.simfolioData.snapshot) {
    // Need to load data first
    fetchSimfolioData(function(sfData) {
      if (sfData) {
        state.simfolioData = sfData;
      }
      renderSimfolioDirectDOM();
    });
    return;
  }
  renderSimfolioDirectDOM();
}

function renderSimfolioDirectDOM() {
  var sfData = state.simfolioData;
  var sectionHTML = sfData && sfData.snapshot
    ? renderSimfolioLivePanel(sfData)
    : renderSimfolioEmpty();

  var css = renderSoftwareCSS();

  $contentArea.innerHTML = '';
  var container = document.createElement('div');
  container.style.cssText = 'height:100%;overflow-y:auto;background:#f5f6fa;';

  // Inject CSS
  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  container.appendChild(styleEl);

  // Inject content
  var contentDiv = document.createElement('div');
  contentDiv.className = 'report-preview';
  contentDiv.innerHTML = sectionHTML;
  container.appendChild(contentDiv);

  $contentArea.appendChild(container);

  // Initialize countdown display
  if (state.schedulerStatus) {
    tickCountdown();
  }

  // Refresh simfolio data in background
  fetchSimfolioData(function(freshData) {
    if (freshData) {
      var prevSnap = state.simfolioData ? state.simfolioData.snapshot : null;
      freshData._prevSnapshot = prevSnap;
      state.simfolioData = freshData;
    }
  });
}

// ============ Send PDF to Email ============

function onSendPdf() {
  if (!state.reportData || state.currentViewMode !== 'engine') {
    updateStatus('当前报告不支持PDF邮件发送');
    return;
  }

  var dateStr = state.currentDate || '';
  var reportTitle = (state.currentReportMeta && state.currentReportMeta.title) || '投资分析报告';
  var safeTitle = reportTitle.replace(/[\/\\:*?"<>|]/g, '_');

  // Format email subject: "2026年5月22日 每日行情分析报告"
  var emailSubject = formatDateChinese(dateStr) + ' 每日行情分析报告';

  // Format email body with greeting (compact for command line)
  var emailBody = 'Dear Francis, 附件是 ' + formatDateChinese(dateStr) + ' 的A股每日行情分析报告（PDF格式）。报告标题：' + reportTitle + '。本报告基于今日收盘数据实时生成，包含时政要点、大盘综述、持仓分析、8大板块跟踪、16只低位潜力股推荐、TOP5排名、风险矩阵等8个板块。Best regards, Francis Investment Report Engine';

  // Step 1: Generate the full PDF HTML content
  updateStatus('正在准备PDF内容...');
  var fullHTML;
  try {
    fullHTML = renderFullReport(state.reportData, 'pdf');
  } catch (e) {
    updateStatus('PDF内容生成失败: ' + e.message);
    return;
  }

  // Step 2: Open print dialog for user to save PDF
  var pdfWindow = window.open('', '_blank', 'width=900,height=700');
  if (pdfWindow) {
    pdfWindow.document.write(fullHTML);
    pdfWindow.document.close();
    setTimeout(function() {
      pdfWindow.print();
    }, 600);
  }

  // Step 3: Construct the email send command
  var pdfPath = 'C:/Users/anzhe/FIRSTCC/Francis Investment/report-engine/reports/' + safeTitle + '.pdf';
  var emailCmd = 'cd "C:/Users/anzhe/FIRSTCC" && node send_mail.js "anzhezhouclaude@163.com" "NXtVgDqN5E4S8dSB" "anzhezhou@126.com" "' + emailSubject + '" "' + emailBody + '" "' + pdfPath + '"';

  // Show modal with instructions
  showSendPdfModal(dateStr, safeTitle, emailCmd, pdfPath, emailSubject, emailBody);
}

function showSendPdfModal(dateStr, safeTitle, emailCmd, pdfPath, emailSubject, emailBody) {
  // Remove existing modal if any
  var existing = document.getElementById('send-pdf-modal-overlay');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'send-pdf-modal-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;';

  var modal = document.createElement('div');
  modal.style.cssText = 'background:#fff;border-radius:12px;padding:28px 32px;max-width:620px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.3);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

  modal.innerHTML = '<h3 style="margin:0 0 8px;font-size:18px;">📧 发送PDF至邮箱</h3>' +
    '<p style="margin:0 0 16px;font-size:13px;color:#64748b;">PDF打印对话框已打开，请<b>选择"另存为PDF"</b>保存到以下路径，然后复制命令到终端发送邮件。</p>' +
    '<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px 16px;margin-bottom:10px;">' +
    '<div style="font-size:11px;color:#64748b;margin-bottom:4px;">📌 邮件主题：</div>' +
    '<div style="font-size:13px;font-weight:600;color:#166534;">' + escHtml(emailSubject) + '</div>' +
    '</div>' +
    '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;margin-bottom:10px;">' +
    '<div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">📝 邮件正文：</div>' +
    '<div style="font-size:12px;color:#475569;line-height:1.5;">' + escHtml(emailBody) + '</div>' +
    '</div>' +
    '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;margin-bottom:10px;">' +
    '<div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">📎 PDF 保存路径：</div>' +
    '<code style="font-size:11px;word-break:break-all;color:#334155;">' + escHtml(pdfPath) + '</code>' +
    '</div>' +
    '<div style="background:#1e293b;border-radius:8px;padding:14px 16px;margin-bottom:16px;position:relative;">' +
    '<div style="font-size:11px;color:#94a3b8;margin-bottom:6px;">📋 邮件发送命令（点击复制）：</div>' +
    '<code id="send-pdf-cmd" style="font-size:11px;color:#e2e8f0;word-break:break-all;white-space:pre-wrap;">' + escHtml(emailCmd) + '</code>' +
    '</div>' +
    '<div style="display:flex;gap:10px;justify-content:flex-end;">' +
    '<button id="btn-copy-cmd" style="padding:8px 20px;border-radius:6px;border:1px solid #b8942c;background:#b8942c;color:#fff;cursor:pointer;font-size:13px;font-weight:600;">复制命令</button>' +
    '<button id="btn-close-modal" style="padding:8px 20px;border-radius:6px;border:1px solid #d1d5db;background:#fff;cursor:pointer;font-size:13px;color:#64748b;">关闭</button>' +
    '</div>';

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Copy button
  document.getElementById('btn-copy-cmd').addEventListener('click', function() {
    var cmdText = emailCmd;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(cmdText).then(function() {
        updateStatus('命令已复制到剪贴板！请在终端中粘贴运行');
      }).catch(function() {
        fallbackCopy(cmdText);
      });
    } else {
      fallbackCopy(cmdText);
    }
  });

  // Close button
  document.getElementById('btn-close-modal').addEventListener('click', function() {
    overlay.remove();
    updateStatus('已取消邮件发送');
  });

  // Click overlay background to close
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) overlay.remove();
  });

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); updateStatus('命令已复制到剪贴板！请在终端中粘贴运行'); }
    catch (err) { updateStatus('复制失败，请手动复制命令'); }
    document.body.removeChild(ta);
  }
}

// ============ Calendar ============

function renderCalendar() {
  if (!$calendarWidget) return;

  var year = cal.year;
  var month = cal.month;
  var today = new Date();
  var todayStr = today.getFullYear() + '-' +
    String(today.getMonth() + 1).padStart(2, '0') + '-' +
    String(today.getDate()).padStart(2, '0');

  var firstDay = new Date(year, month - 1, 1);
  var lastDay = new Date(year, month, 0);
  var startDow = firstDay.getDay();
  var daysInMonth = lastDay.getDate();
  var daysInPrevMonth = new Date(year, month - 1, 0).getDate();

  var monthNames = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
  var dayHeaders = ['日', '一', '二', '三', '四', '五', '六'];

  var html = '';

  html += '<div class="calendar-header">';
  html += '<button class="calendar-nav" onclick="calPrevMonth()">◀</button>';
  html += '<span class="calendar-month-label">' + year + '年 ' + monthNames[month - 1] + '</span>';
  html += '<button class="calendar-nav" onclick="calNextMonth()">▶</button>';
  html += '</div>';

  html += '<div class="calendar-grid">';
  for (var d = 0; d < 7; d++) {
    html += '<div class="calendar-day-header">' + dayHeaders[d] + '</div>';
  }

  for (var i = startDow - 1; i >= 0; i--) {
    html += '<div class="calendar-day">' + (daysInPrevMonth - i) + '</div>';
  }

  for (var day = 1; day <= daysInMonth; day++) {
    var dateStr = year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    var hasReport = state.reportsByDate[dateStr] !== undefined;
    var isToday = dateStr === todayStr;
    var isActive = dateStr === cal.activeDate;

    var cls = 'calendar-day current-month';
    if (isToday) cls += ' today';
    if (isActive) cls += ' active';

    var clickAttr = hasReport ? ' onclick="onDateClick(\'' + dateStr + '\')"' : '';
    html += '<div class="' + cls + '"' + clickAttr + '>' + day + '</div>';
  }

  var remaining = 7 - ((startDow + daysInMonth) % 7);
  if (remaining < 7) {
    for (var j = 1; j <= remaining; j++) {
      html += '<div class="calendar-day">' + j + '</div>';
    }
  }

  html += '</div>';
  $calendarWidget.innerHTML = html;
}

function calPrevMonth() {
  if (cal.month === 1) { cal.month = 12; cal.year--; }
  else { cal.month--; }
  renderCalendar();
}

function calNextMonth() {
  if (cal.month === 12) { cal.month = 1; cal.year++; }
  else { cal.month++; }
  renderCalendar();
}

function onDateClick(dateStr) {
  var reports = state.reportsByDate[dateStr];
  if (!reports || reports.length === 0) return;

  var best = null;
  for (var i = 0; i < reports.length; i++) {
    if (reports[i].viewMode === 'engine') { best = reports[i]; break; }
    if (reports[i].viewMode === 'html' && !best) { best = reports[i]; }
  }
  if (!best && reports[0].viewMode === 'pdf-only') {
    best = reports[0];
  }
  if (!best) best = reports[0];

  cal.activeDate = dateStr;
  // Default to simfolio section
  state.activeSection = 'simfolio';
  loadReportByMeta(best);
  renderCalendar();
  renderReportList();
}

// ============ Report List ============

function renderReportList() {
  if (!$reportListItems) return;

  var sorted = state.reportsIndex.slice().sort(function(a, b) {
    return b.date.localeCompare(a.date);
  });

  var badgeClassMap = {
    daily: 'badge-daily',
    macro: 'badge-macro',
    picks: 'badge-picks',
    portfolio: 'badge-portfolio',
  };

  var html = '';
  for (var i = 0; i < sorted.length; i++) {
    var r = sorted[i];
    var isActive = r.date === cal.activeDate &&
                   state.currentReportMeta &&
                   state.currentReportMeta.date === r.date &&
                   state.currentReportMeta.title === r.title;
    var cls = 'report-item' + (isActive ? ' active' : '');
    var badgeCls = badgeClassMap[r.type] || 'badge-daily';
    var clickable = r.viewMode !== 'pdf-only';

    var clickHandler = clickable
      ? ' onclick="onReportItemClick(\'' + r.date + '\',\'' + escAttr(r.title) + '\')"'
      : '';

    html += '<div class="' + cls + '"' + clickHandler + '>';
    html += '  <div class="report-item-head">';
    html += '    <span class="report-item-date">' + formatDateChinese(r.date) + '</span>';
    html += '    <span class="badge ' + badgeCls + '">' + r.typeLabel + '</span>';
    html += '  </div>';
    html += '  <div class="report-item-type">' + escHtml(r.title) + '</div>';
    html += '</div>';
  }
  $reportListItems.innerHTML = html;
}

function onReportItemClick(dateStr, title) {
  var reports = state.reportsByDate[dateStr];
  if (!reports) return;

  var meta = null;
  for (var i = 0; i < reports.length; i++) {
    if (reports[i].title === title) { meta = reports[i]; break; }
  }
  if (!meta) meta = reports[0];

  cal.activeDate = dateStr;
  state.activeSection = 'simfolio';
  loadReportByMeta(meta);
  renderCalendar();
  renderReportList();
}

// ============ PDF Generation ============

function onGenPDF() {
  if (!state.reportData || state.currentViewMode !== 'engine') {
    updateStatus('当前报告不支持PDF生成');
    return;
  }

  updateStatus('正在生成PDF报告...');

  try {
    var fullHTML = renderFullReport(state.reportData, 'pdf');
    var pdfWindow = window.open('', '_blank', 'width=900,height=700');
    if (pdfWindow) {
      pdfWindow.document.write(fullHTML);
      pdfWindow.document.close();
      // Let content render, then trigger print
      setTimeout(function() {
        pdfWindow.print();
        updateStatus('PDF打印对话框已打开 — 请选择"另存为PDF"保存至桌面');
      }, 800);
    } else {
      updateStatus('弹窗被拦截，请允许弹窗后重试');
    }
  } catch (e) {
    updateStatus('PDF生成失败: ' + e.message);
  }
}

// ============ Utilities ============

function updateStatus(msg) {
  if ($statusBar) $statusBar.textContent = msg;
}

function formatDateChinese(dateStr) {
  var parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  var y = parseInt(parts[0], 10);
  var m = parseInt(parts[1], 10);
  var d = parseInt(parts[2], 10);
  var weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var dt = new Date(y, m - 1, d);
  var wd = weekdays[dt.getDay()];
  return y + '年' + m + '月' + d + '日 ' + wd;
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(str) {
  if (!str) return '';
  return String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// ============ Recommendation History Panel ============

var _historyPrevSection = null;

function showRecommendationHistory() {
  // Save current section to restore later
  _historyPrevSection = state.activeSection;

  // Highlight trading report nav item
  var items = $sectionNavList.querySelectorAll('.section-nav-item');
  items.forEach(function(item) {
    item.classList.toggle('active', item.getAttribute('data-section') === 'tradingReport');
  });

  if ($contentTitle) {
    $contentTitle.textContent = '推荐历史数据库';
  }

  try {
    var historyHTML = renderRecommendationHistory();
    var css = renderSoftwareCSS();
    var wrapperHTML = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>' + css + ' body { overflow-y: auto; }</style></head><body>' + historyHTML + '</body></html>';

    $contentArea.innerHTML = '';
    var iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:100%;height:100%;border:none;min-height:70vh;';
    iframe.sandbox = 'allow-same-origin allow-scripts';
    iframe.srcdoc = wrapperHTML;
    $contentArea.appendChild(iframe);
    updateStatus('推荐历史数据库 — 共 ' + (window.__RECOMMENDATION_HISTORY__ ? window.__RECOMMENDATION_HISTORY__.history.length : 0) + ' 只股票');
  } catch (e) {
    $contentArea.innerHTML = '<div class="content-placeholder"><p style="color:#e74c3c;">渲染出错: ' + escHtml(e.message) + '</p></div>';
  }
}

function closeRecommendationHistory() {
  if (_historyPrevSection) {
    setActiveSection(_historyPrevSection);
  } else {
    setActiveSection('simfolio');
  }
}

// Expose to window for iframe onclick access
window.showRecommendationHistory = showRecommendationHistory;
window.closeRecommendationHistory = closeRecommendationHistory;

// Periodic server status check (every 5 min, only when NOT in live mode)
var _serverPollTimer = null;
function startServerPoll() {
  if (_serverPollTimer) clearInterval(_serverPollTimer);
  _serverPollTimer = setInterval(function() {
    if (!state.liveMode) {
      checkServerStatus();
    }
  }, 300000); // 5 min when idle
}

// -- Start --
document.addEventListener('DOMContentLoaded', function() {
  initApp();
  startServerPoll();
});
