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
  summaryDates: [],            // dates with available summaries (for calendar dots)
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
  { id: 'newsPolicy',      label: '时政要点',         icon: '📰', render: function(d,m) { return renderNewsPolicySection(d,m); } },
  { id: 'tradingReport',   label: '交易分析与报告',   icon: '📊', render: function(d,m) { return renderTradeAnalysisSection(d,m); } },
  { id: 'holdingsAnalysis',label: '持仓分析',         icon: '💼', render: function(d,m) { return renderSectionByTime(d, m, renderHoldingsUnavailable, '持仓分析'); } },
  { id: 'knowledgeBase',   label: 'AI 知识库',        icon: '🧠', render: function(d,m) { return renderKnowledgeBaseSection(d,m); } },
  { id: 'historyReview',   label: '历史复盘',         icon: '📅', render: function(d,m) { return renderHistoryReview(d,m); } },
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
    loadSummaryDates();

    // Enter live monitoring mode
    state.liveMode = true;
    startLivePoll();
    startCountdown();
  });

  // Bind events - PDF & email buttons
  if ($btnSendPdf) $btnSendPdf.addEventListener('click', onSendPdf);
  if ($btnGenPDF) $btnGenPDF.addEventListener('click', onGenPDF);

  // Calendar toggle for mobile
  var $btnCalToggle = document.getElementById('btn-calendar-toggle');
  if ($btnCalToggle) $btnCalToggle.addEventListener('click', function() {
    var sidebar = document.getElementById('sidebar');
    if (sidebar) {
      sidebar.style.display = sidebar.style.display === 'none' ? '' : 'none';
      this.textContent = sidebar.style.display === 'none' ? '📅 展开' : '📅 日历';
    }
  });

  // Think Tank button
  var $btnThinkTank = document.getElementById('btn-think-tank');
  if ($btnThinkTank) $btnThinkTank.addEventListener('click', function(e) {
    // Save selected calendar date so think-tank timeline can sync
    try {
      localStorage.setItem('franciz_selected_date', cal.activeDate);
    } catch(ex) {}
    // On desktop, open as sized popup; on mobile, let the <a> link handle it naturally
    if (window.innerWidth >= 900) {
      e.preventDefault();
      window.open('/think-tank.html', 'mosaic_think_tank', 'width=1400,height=900');
    }
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

  // Build sector live chart (replaces NAV chart)
  var sectorHTML = renderSectorLiveChart();

  var html = countdownHTML + cardsHTML + feedHTML + posHTML + sectorHTML;

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

// ============ Sector Live Chart (replaces NAV chart) ============
function renderSectorLiveChart() {
  var html = '<div id="sector-live-container" style="margin:0 16px 16px;">';
  html += '<div style="background:#fff;border-radius:8px;padding:16px;border:1px solid #e2e5eb;">';
  html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">';
  html += '<h3 style="font-size:14px;color:#1e293b;margin:0;">📊 板块实时走势</h3>';
  html += '<span style="font-size:10px;color:#94a3b8;" id="sector-update-time">加载中...</span>';
  html += '</div>';
  html += '<div id="sector-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;">';
  // Placeholder cards
  var sectorNames = ['上证指数', '深证成指', '北证50', '科创50', '创业板指', '医药生物', '中证军工', '半导体/AI'];
  for (var i = 0; i < sectorNames.length; i++) {
    html += '<div class="sector-card-mini" style="background:#f8fafc;border-radius:6px;padding:10px;text-align:center;border:1px solid #eef0f4;">';
    html += '<div style="font-size:11px;color:#64748b;">' + sectorNames[i] + '</div>';
    html += '<div style="font-size:16px;font-weight:700;color:#94a3b8;margin:4px 0;">--</div>';
    html += '<div style="font-size:11px;">--</div>';
    html += '</div>';
  }
  html += '</div></div></div>';

  // Async load sector data
  setTimeout(function() {
    fetch('/api/sectors/live')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data.ok || !data.sectors) return;
        var grid = document.getElementById('sector-grid');
        var timeEl = document.getElementById('sector-update-time');
        if (timeEl) {
          var now = new Date();
          timeEl.textContent = now.toTimeString().slice(0, 8);
        }
        if (!grid) return;
        var html2 = '';
        for (var i = 0; i < data.sectors.length; i++) {
          var s = data.sectors[i];
          var changeColor = s.changePercent >= 0 ? '#dc2626' : '#16a34a';
          var sign = s.changePercent >= 0 ? '+' : '';
          html2 += '<div class="sector-card-mini" style="background:#f8fafc;border-radius:6px;padding:10px;text-align:center;border:1px solid #eef0f4;">';
          html2 += '<div style="font-size:11px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escHtml(s.name) + '</div>';
          html2 += '<div style="font-size:16px;font-weight:700;color:#1e293b;margin:4px 0;font-variant-numeric:tabular-nums;">' + s.price.toFixed(2) + '</div>';
          html2 += '<div style="font-size:12px;font-weight:600;color:' + changeColor + ';">' + sign + s.changePercent.toFixed(2) + '%</div>';
          html2 += '</div>';
        }
        grid.innerHTML = html2;
      })
      .catch(function() {
        var timeEl = document.getElementById('sector-update-time');
        if (timeEl) timeEl.textContent = '获取失败';
      });
  }, 200);

  return html;
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

// ============ News Policy Section (v2.5 — dedicated daily news) ============

function renderNewsPolicySection(data, mode) {
  var timeState = getMarketTimeState();
  if (timeState === 'trading') {
    return renderPlaceholder('时政要点', 'trading');
  }
  if (timeState === 'generating') {
    return renderPlaceholder('时政要点', 'generating');
  }
  if (timeState === 'closed') {
    return renderPlaceholder('时政要点', 'closed');
  }
  // timeState === 'ready': load news from API
  var html = '<div id="news-policy-container" style="max-width:960px;margin:0 auto;padding:20px 24px;">';
  html += '<div style="text-align:center;padding:40px;color:#64748b;">';
  html += '<div style="font-size:32px;margin-bottom:12px;">📰</div>';
  html += '<div>正在加载时政要点...</div>';
  html += '</div></div>';
  setTimeout(function() { loadNewsIntoDOM(); }, 100);
  return html;
}

function loadNewsIntoDOM() {
  var container = document.getElementById('news-policy-container');
  if (!container) return;
  fetch('/api/news/latest')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.ok || !data.news || !data.news.items || data.news.items.length === 0) {
        container.innerHTML = '<div class="unavailable-placeholder">' +
          '<div class="lock-icon">📭</div>' +
          '<div class="lock-title">暂无重大财经新闻</div>' +
          '<div class="lock-desc">新闻采集API可能暂时不可用或今日暂无重要新闻，请稍后刷新重试。</div>' +
          '</div>';
        return;
      }
      container.innerHTML = renderNewsDigest(data.news, data.date);
    })
    .catch(function() {
      container.innerHTML = '<div class="unavailable-placeholder">' +
        '<div class="lock-icon">⚠️</div>' +
        '<div class="lock-title">加载失败</div>' +
        '<div class="lock-desc">无法获取新闻数据，请检查 Mosaic Server 是否运行。</div>' +
        '</div>';
    });
}

function renderNewsDigest(news, date) {
  var html = '';
  html += '<h2 style="font-size:20px;color:#1e293b;margin:0 0 4px;">📰 ' + date + ' 时政要点</h2>';
  html += '<p style="font-size:12px;color:#94a3b8;margin:0 0 16px;">共 ' + news.count + ' 条新闻 · 由 Mosaic AI 自动采集自新浪财经</p>';

  // Category counts
  var catCounts = { policy: 0, sector: 0, company: 0, macro: 0 };
  for (var i = 0; i < news.items.length; i++) {
    var c = news.items[i].category;
    if (c && catCounts[c] != null) catCounts[c]++;
  }

  // Filter tabs
  var cats = [
    { key: 'all', label: '全部', count: news.count },
    { key: 'policy', label: '政策', count: catCounts.policy },
    { key: 'sector', label: '板块', count: catCounts.sector },
    { key: 'company', label: '公司', count: catCounts.company },
    { key: 'macro', label: '宏观', count: catCounts.macro },
  ];
  html += '<div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;" id="news-category-tabs">';
  for (var ci = 0; ci < cats.length; ci++) {
    var cat = cats[ci];
    var activeStyle = cat.key === 'all' ? 'background:#1e293b;color:#fff;border-color:#1e293b;' : 'background:#fff;color:#475569;border:1px solid #e2e5eb;';
    html += '<button class="news-tab-btn" data-cat="' + cat.key + '" style="padding:5px 12px;border-radius:14px;font-size:12px;cursor:pointer;' + activeStyle + '" onclick="filterNewsCategory(\'' + cat.key + '\')">';
    html += cat.label + ' (' + cat.count + ')';
    html += '</button>';
  }
  html += '</div>';

  // News timeline
  html += '<div id="news-timeline">';
  for (var j = 0; j < news.items.length; j++) {
    var item = news.items[j];
    var catColors = { policy: '#7c3aed', sector: '#059669', company: '#d97706', macro: '#dc2626' };
    var catColor = catColors[item.category] || '#64748b';
    var timeHHMM = item.time ? new Date(item.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';

    html += '<div class="news-item" data-category="' + item.category + '" style="display:flex;gap:14px;padding:12px 0;border-bottom:1px solid #f1f5f9;">';
    html += '<div style="min-width:48px;font-size:11px;color:#94a3b8;padding-top:2px;">' + timeHHMM + '</div>';
    html += '<div style="flex:1;">';
    html += '<span style="display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;color:#fff;background:' + catColor + ';margin-right:6px;">' + item.category + '</span>';
    html += '<a href="' + (item.url || '#') + '" target="_blank" style="font-size:13px;color:#1e293b;text-decoration:none;font-weight:500;" onmouseover="this.style.color=\'#b8942c\'" onmouseout="this.style.color=\'#1e293b\'">' + escHtml(item.title) + '</a>';
    html += '<div style="font-size:11px;color:#94a3b8;margin-top:2px;">来源: ' + escHtml(item.source) + '</div>';
    if (item.summary) {
      html += '<div style="font-size:12px;color:#64748b;margin-top:4px;line-height:1.5;">' + escHtml(item.summary) + '</div>';
    }
    html += '</div></div>';
  }
  html += '</div>';

  if (news.items.length === 0) {
    html += '<div style="text-align:center;padding:40px;color:#94a3b8;">📭 今日暂无重大财经新闻</div>';
  }

  // News Impact Prediction
  if (news.impact && news.impact.keyThemes && news.impact.keyThemes.length > 0) {
    var imp = news.impact;
    var sentColors = { positive: '#dc2626', negative: '#16a34a', neutral: '#64748b' };
    var sentIcons = { positive: '📈', negative: '📉', neutral: '➡️' };
    var sentLabels = { positive: '偏多', negative: '偏空', neutral: '中性' };

    html += '<div style="background:linear-gradient(135deg,#fef3c7,#fef9e7);border-radius:10px;padding:20px;margin-top:20px;border:1px solid #f59e0b;">';
    html += '<h3 style="font-size:14px;color:#1e293b;margin:0 0 12px;">🔮 AI 新闻影响预测</h3>';

    // Overall sentiment bar
    var scoreWidth = imp.impactScore || 50;
    var scoreColor = scoreWidth > 60 ? UP_COLOR : (scoreWidth < 40 ? DOWN_COLOR : '#f59e0b');
    html += '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">';
    html += '<div style="font-size:12px;color:#64748b;">市场情绪</div>';
    html += '<div style="flex:1;height:8px;background:#e5e7eb;border-radius:4px;position:relative;">';
    html += '<div style="width:' + scoreWidth + '%;height:100%;background:' + scoreColor + ';border-radius:4px;"></div>';
    html += '</div>';
    html += '<div style="font-size:12px;font-weight:700;color:' + scoreColor + ';">' + sentLabels[imp.overallSentiment] + ' (' + scoreWidth + '分)</div>';
    html += '</div>';

    // Stats
    if (imp.stats) {
      html += '<div style="display:flex;gap:16px;margin-bottom:14px;font-size:12px;">';
      html += '<span style="color:#dc2626;">📈 利好 ' + (imp.stats.positive || 0) + '条</span>';
      html += '<span style="color:#16a34a;">📉 利空 ' + (imp.stats.negative || 0) + '条</span>';
      html += '<span style="color:#64748b;">➡️ 中性 ' + (imp.stats.neutral || 0) + '条</span>';
      html += '</div>';
    }

    // Prediction text
    html += '<p style="font-size:13px;line-height:1.8;color:#334155;margin:0 0 12px;">' + escHtml(imp.shortTermPrediction || '') + '</p>';

    // Key themes
    if (imp.keyThemes && imp.keyThemes.length > 0) {
      html += '<div style="margin-bottom:10px;font-size:12px;color:#64748b;font-weight:600;">关键主题</div>';
      html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">';
      for (var kt = 0; kt < imp.keyThemes.length; kt++) {
        var theme = imp.keyThemes[kt];
        var tc = theme.impact === 'positive' ? '#dc2626' : (theme.impact === 'negative' ? '#16a34a' : '#64748b');
        html += '<span style="padding:4px 10px;background:#fff;border-radius:14px;font-size:11px;color:' + tc + ';border:1px solid #e2e5eb;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escHtml(theme.theme || '') + '">' + escHtml((theme.theme || '').slice(0, 40)) + '</span>';
      }
      html += '</div>';
    }

    // Sector predictions
    if (imp.sectorPredictions && imp.sectorPredictions.length > 0) {
      html += '<div style="margin-bottom:10px;font-size:12px;color:#64748b;font-weight:600;">板块影响</div>';
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:6px;margin-bottom:12px;">';
      for (var sp = 0; sp < imp.sectorPredictions.length; sp++) {
        var sec = imp.sectorPredictions[sp];
        var sc = sec.sentiment === 'positive' ? '#dc2626' : (sec.sentiment === 'negative' ? '#16a34a' : '#64748b');
        html += '<div style="background:#fff;padding:8px 10px;border-radius:6px;font-size:11px;">';
        html += '<b style="color:#1e293b;">' + escHtml(sec.sector) + '</b> ';
        html += '<span style="color:' + sc + ';">' + escHtml(sec.prediction || '') + '</span>';
        html += '</div>';
      }
      html += '</div>';
    }

    // Risk events
    if (imp.riskEvents && imp.riskEvents.length > 0) {
      html += '<div style="font-size:11px;color:#dc2626;line-height:1.7;">⚠ 风险关注: ' + imp.riskEvents.map(function(r) { return escHtml(r).slice(0,50); }).join(' · ') + '</div>';
    }

    html += '</div>'; // end impact card
  }

  return html;
}

// Expose filter function globally
window.filterNewsCategory = function(cat) {
  var btns = document.querySelectorAll('.news-tab-btn');
  btns.forEach(function(btn) {
    if (btn.getAttribute('data-cat') === cat) {
      btn.style.background = '#1e293b'; btn.style.color = '#fff'; btn.style.borderColor = '#1e293b';
    } else {
      btn.style.background = '#fff'; btn.style.color = '#475569'; btn.style.border = '1px solid #e2e5eb';
    }
  });
  var items = document.querySelectorAll('.news-item');
  items.forEach(function(item) {
    item.style.display = (cat === 'all' || item.getAttribute('data-category') === cat) ? '' : 'none';
  });
};

// ============ Trade Analysis Section (v2.5 — dedicated quant report) ============

function renderTradeAnalysisSection(data, mode) {
  var timeState = getMarketTimeState();
  if (timeState === 'trading') {
    return renderPlaceholder('交易分析与报告', 'trading');
  }
  if (timeState === 'generating') {
    return renderPlaceholder('交易分析与报告', 'generating');
  }
  if (timeState === 'closed') {
    return renderPlaceholder('交易分析与报告', 'closed');
  }
  var html = '<div id="trade-analysis-container" style="max-width:960px;margin:0 auto;padding:20px 24px;">';
  html += '<div style="text-align:center;padding:40px;color:#64748b;">';
  html += '<div style="font-size:32px;margin-bottom:12px;">📊</div>';
  html += '<div>正在加载交易分析...</div>';
  html += '</div></div>';
  setTimeout(function() { loadTradeAnalysisIntoDOM(); }, 100);
  return html;
}

function loadTradeAnalysisIntoDOM() {
  var container = document.getElementById('trade-analysis-container');
  if (!container) return;
  fetch('/api/analysis/latest')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.ok || !data.tradeAnalysis) {
        container.innerHTML = '<div class="unavailable-placeholder">' +
          '<div class="lock-icon">📊</div>' +
          '<div class="lock-title">暂无交易分析</div>' +
          '<div class="lock-desc">今日无交易发生或分析尚未生成，请于16:00后查看。</div>' +
          '</div>';
        return;
      }
      var html = renderQuantAnalysisReport(data.tradeAnalysis, data.date);
      // Add knowledge base placeholder for async loading
      html += '<div id="knowledge-base-container" style="max-width:960px;margin:0 auto;padding:0 0 20px;"></div>';
      container.innerHTML = html;
      // Load knowledge base after analysis renders
      setTimeout(function() { loadKnowledgeBaseIntoDOM(); }, 200);
    })
    .catch(function() {
      container.innerHTML = '<div class="unavailable-placeholder">' +
        '<div class="lock-icon">⚠️</div>' +
        '<div class="lock-title">加载失败</div>' +
        '<div class="lock-desc">无法获取分析数据，请检查 Mosaic Server 是否运行。</div>' +
        '</div>';
    });
}

function loadKnowledgeBaseIntoDOM() {
  var kbContainer = document.getElementById('knowledge-base-container');
  if (!kbContainer) return;
  fetch('/api/knowledge/summary')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.ok || !data.factorTracker || !data.factorTracker.factors) {
        kbContainer.innerHTML = '';
        return;
      }
      kbContainer.innerHTML = renderKnowledgeBaseCard(data);
    })
    .catch(function() {
      kbContainer.innerHTML = ''; // Silent fail - knowledge base is optional
    });
}

function renderKnowledgeBaseCard(kb) {
  var html = '';
  html += '<div style="background:#fff;border-radius:8px;padding:20px;margin-top:16px;border:2px solid #b8942c;">';
  html += '<h3 style="font-size:14px;color:#1e293b;margin:0 0 4px;">🧠 AI 自我成长知识库</h3>';
  html += '<p style="font-size:11px;color:#94a3b8;margin:0 0 16px;">累计学习 ' + (kb.totalDays || 0) + ' 天 · 追踪 ' + (kb.factorTracker.factors ? kb.factorTracker.factors.length : 0) + ' 个因子 · 总触发 ' + (kb.factorTracker.totalTriggers || 0) + ' 次 · 更新于 ' + new Date(kb.lastUpdated).toLocaleString('zh-CN') + '</p>';

  // Factor performance ranking
  var factors = kb.factorTracker.factors || [];
  if (factors.length > 0) {
    // Sort by triggerCount descending
    var sorted = factors.slice().sort(function(a, b) { return b.triggerCount - a.triggerCount; });
    var maxTrigger = Math.max(1, sorted[0].triggerCount || 0);

    html += '<div style="font-size:12px;color:#64748b;margin-bottom:8px;font-weight:600;">因子触发排行榜</div>';
    html += '<div style="display:grid;grid-template-columns:1fr;gap:6px;margin-bottom:16px;">';
    for (var i = 0; i < sorted.length; i++) {
      var f = sorted[i];
      var barW = Math.max(2, Math.round((f.triggerCount || 0) / maxTrigger * 100));
      var isActive = f.triggerCount > 0;
      var barColor = isActive ? '#b8942c' : '#e5e7eb';
      html += '<div style="display:flex;align-items:center;gap:10px;font-size:12px;">';
      html += '<span style="width:30px;text-align:right;color:#94a3b8;">' + (i + 1) + '</span>';
      html += '<span style="width:90px;font-weight:600;color:#1e293b;">' + f.id + ' ' + f.name + '</span>';
      html += '<div style="flex:1;height:6px;background:#f1f5f9;border-radius:3px;">';
      html += '<div style="height:100%;width:' + barW + '%;background:' + barColor + ';border-radius:3px;"></div></div>';
      html += '<span style="width:50px;text-align:right;font-weight:600;' + (isActive ? 'color:#1e293b;' : 'color:#cbd5e1;') + '">' + (f.triggerCount || 0) + '次</span>';
      if (f.avgContribution > 0) {
        html += '<span style="width:60px;text-align:right;color:#b8942c;font-size:11px;">贡献' + f.avgContribution + '%</span>';
      }
      html += '</div>';
    }
    html += '</div>';

    // Summary stats
    var activeFactors = sorted.filter(function(f) { return f.triggerCount > 0; });
    if (activeFactors.length > 0) {
      html += '<div style="background:#fef9e7;border-radius:6px;padding:14px;font-size:12px;line-height:1.8;">';
      html += '<b style="color:#1e293b;">📊 学习总结</b><br>';
      html += '<span style="color:#64748b;">过去 ' + kb.totalDays + ' 个交易日中，共触发了 ' + kb.factorTracker.totalTriggers + ' 次因子信号。<br>';
      if (activeFactors.length > 0) {
        var topF = activeFactors[0];
        html += '最活跃因子：<b style="color:#b8942c;">' + topF.id + ' ' + topF.name + '</b>（触发' + topF.triggerCount + '次';
        if (topF.avgContribution > 0) html += '，平均贡献' + topF.avgContribution + '%';
        html += '）。<br>';
      }
      if (activeFactors.length >= 2) {
        var secondF = activeFactors[1];
        html += '次活跃因子：<b>' + secondF.id + ' ' + secondF.name + '</b>（触发' + secondF.triggerCount + '次）。<br>';
      }
      html += '因子追踪器持续学习市场规律，累积数据越多，预测越准确。</span>';
      html += '</div>';
    }
  }

  html += '</div>'; // end knowledge base card
  return html;
}

function renderQuantAnalysisReport(anal, date) {
  var html = '';
  html += '<h2 style="font-size:20px;color:#1e293b;margin:0 0 4px;">📊 ' + date + ' 交易分析与报告</h2>';
  html += '<p style="font-size:12px;color:#94a3b8;margin:0 0 20px;">Mosaic AI 量化引擎自动生成 · ' + new Date(anal.generatedAt).toTimeString().slice(0,8) + '</p>';

  // 1. Market Narrative
  if (anal.marketNarrative && anal.marketNarrative.narrative) {
    var mn = anal.marketNarrative;
    var sentimentColors = { bullish: '#dc2626', bearish: '#16a34a', neutral: '#64748b' };
    var sentimentLabels = { bullish: '偏多 ↑', bearish: '偏空 ↓', neutral: '中性 →' };
    html += '<div style="background:#fff;border-radius:8px;padding:20px;margin-bottom:16px;border-left:4px solid #b8942c;">';
    html += '<h3 style="margin:0 0 12px;font-size:14px;">🏛 市场叙事</h3>';
    html += '<p style="font-size:14px;line-height:1.9;color:#334155;margin:0;">' + escHtml(mn.narrative) + '</p>';
    if (mn.keyDrivers && mn.keyDrivers.length > 0) {
      html += '<div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;">';
      for (var d = 0; d < mn.keyDrivers.length; d++) {
        var drv = mn.keyDrivers[d];
        var drvColor = drv.impact === 'positive' ? UP_COLOR : (drv.impact === 'negative' ? DOWN_COLOR : MUTED_COLOR);
        html += '<span style="padding:4px 10px;background:#f8fafc;border-radius:12px;font-size:11px;color:' + drvColor + ';border:1px solid #e2e5eb;">' + escHtml(drv.driver) + '</span>';
      }
      html += '</div>';
    }
    if (mn.sentimentBias) {
      html += '<div style="margin-top:10px;font-size:12px;color:' + (sentimentColors[mn.sentimentBias] || MUTED_COLOR) + ';font-weight:600;">市场情绪: ' + (sentimentLabels[mn.sentimentBias] || mn.sentimentBias) + '</div>';
    }
    html += '</div>';
  }

  // 2. Per-Trade Deep Analysis
  if (anal.tradesAnalysis && anal.tradesAnalysis.length > 0) {
    html += '<h3 style="font-size:14px;color:#1e293b;margin:20px 0 12px;">📋 交易决策深度解析 (' + anal.tradesAnalysis.length + '笔)</h3>';
    for (var t = 0; t < anal.tradesAnalysis.length; t++) {
      var ta = anal.tradesAnalysis[t];
      var isBuy = ta.action === 'buy';
      var actionColor = isBuy ? UP_COLOR : DOWN_COLOR;
      var actionIcon = isBuy ? '🔴 买入' : '🟢 卖出';
      var stock = ta.stock || {};

      html += '<div style="background:#fff;border-radius:8px;padding:20px;margin-bottom:16px;border:1px solid #e2e5eb;">';
      // Header
      html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">';
      html += '<div><span style="color:' + actionColor + ';font-weight:700;font-size:14px;">' + actionIcon + '</span> ';
      html += '<b style="font-size:14px;">' + escHtml(stock.name || '') + '</b> ';
      html += '<span style="color:#94a3b8;font-size:12px;">' + (stock.code || '') + '</span> ';
      html += '<span style="font-size:14px;font-weight:600;">¥' + (stock.price || 0).toFixed(2) + '</span></div>';
      html += '</div>';

      // Deep reason
      html += '<p style="font-size:13px;line-height:1.8;color:#334155;margin:0 0 14px;">' + escHtml(ta.deepReason || '') + '</p>';

      // Factor attribution bars
      if (ta.factorAttribution && ta.factorAttribution.length > 0) {
        html += '<div style="margin-bottom:12px;">';
        html += '<div style="font-size:11px;color:#94a3b8;margin-bottom:6px;">因子贡献归因</div>';
        for (var f = 0; f < ta.factorAttribution.length; f++) {
          var fa = ta.factorAttribution[f];
          var barColor = fa.signalLevel === 'strong' ? '#dc2626' : (fa.signalLevel === 'medium' ? '#f59e0b' : '#94a3b8');
          html += '<div style="display:flex;align-items:center;margin-bottom:4px;font-size:12px;">';
          html += '<span style="width:100px;color:#1e293b;font-weight:500;">' + fa.factorId + ' ' + fa.factorName + '</span>';
          html += '<div style="flex:1;height:6px;background:#f1f5f9;border-radius:3px;margin:0 8px;">';
          html += '<div style="height:100%;width:' + fa.contributionPercent + '%;background:' + barColor + ';border-radius:3px;"></div></div>';
          html += '<span style="width:36px;text-align:right;font-weight:600;color:' + barColor + ';">' + fa.contributionPercent + '%</span></div>';
          if (fa.detail) {
            html += '<div style="margin-left:100px;font-size:10px;color:#94a3b8;margin-bottom:6px;">' + escHtml(fa.detail) + '</div>';
          }
        }
        html += '</div>';
      }

      // Dimension stars
      if (ta.dimensionBreakdown && ta.dimensionBreakdown.length > 0) {
        html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px;">';
        for (var dim = 0; dim < ta.dimensionBreakdown.length; dim++) {
          var db = ta.dimensionBreakdown[dim];
          var stars = '';
          for (var s = 0; s < 5; s++) stars += s < Math.floor(db.score) ? '★' : '☆';
          html += '<div style="background:#f8fafc;padding:8px;border-radius:6px;text-align:center;font-size:11px;">';
          html += '<div style="color:#64748b;">' + db.dimension + '</div>';
          html += '<div style="color:#f59e0b;font-size:13px;">' + stars + '</div>';
          html += '<div style="color:#94a3b8;">' + (db.verdict || '') + '</div></div>';
        }
        html += '</div>';
      }

      // Risk + Prediction
      html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">';
      html += '<div style="background:#fef3c7;padding:10px 12px;border-radius:6px;font-size:12px;line-height:1.5;"><b>⚠ 风险评估</b><br><span style="color:#64748b;">' + escHtml(ta.riskAssessment || '') + '</span></div>';
      html += '<div style="background:#dbeafe;padding:10px 12px;border-radius:6px;font-size:12px;line-height:1.5;"><b>📈 预测</b><br><span style="color:#64748b;">' + escHtml(ta.prediction || '') + '</span></div>';
      html += '</div>';

      html += '</div>'; // end trade card
    }
  }

  // 3. Factor Summary
  if (anal.factorSummary && anal.factorSummary.topSignals && anal.factorSummary.topSignals.length > 0) {
    var fs = anal.factorSummary;
    html += '<div style="background:#fff;border-radius:8px;padding:20px;margin-bottom:16px;border:1px solid #e2e5eb;">';
    html += '<h3 style="font-size:14px;margin:0 0 12px;">🔬 全市场因子触发汇总</h3>';
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;">';
    for (var si = 0; si < fs.topSignals.length; si++) {
      var sig = fs.topSignals[si];
      html += '<div style="background:#f8fafc;padding:12px;border-radius:6px;text-align:center;">';
      html += '<div style="font-weight:600;color:#1e293b;font-size:12px;">' + sig.id + ' ' + sig.name + '</div>';
      html += '<div style="font-size:22px;font-weight:700;color:#1e293b;margin:4px 0;">' + sig.count + '</div>';
      html += '<div style="font-size:10px;color:#94a3b8;">次触发</div></div>';
    }
    html += '</div></div>';
  }

  // 4. Forward Predictions
  if (anal.forwardPredictions) {
    var fp = anal.forwardPredictions;
    html += '<div style="background:#fff;border-radius:8px;padding:20px;margin-bottom:16px;border:1px solid #e2e5eb;">';
    html += '<h3 style="font-size:14px;margin:0 0 12px;">🔮 前瞻展望</h3>';
    if (fp.shortTermOutlook) {
      html += '<p style="font-size:14px;line-height:1.9;color:#334155;margin:0 0 12px;">' + escHtml(fp.shortTermOutlook) + '</p>';
    }
    if (fp.keyWatch && fp.keyWatch.length > 0) {
      html += '<div style="margin-bottom:8px;"><b style="font-size:12px;color:#1e293b;">关注要点:</b></div>';
      html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">';
      for (var w = 0; w < fp.keyWatch.length; w++) {
        html += '<span style="padding:4px 10px;background:#dbeafe;border-radius:6px;font-size:11px;color:#1e40af;">' + escHtml(fp.keyWatch[w]) + '</span>';
      }
      html += '</div>';
    }
    if (fp.riskFactors && fp.riskFactors.length > 0) {
      html += '<div style="font-size:11px;color:#dc2626;line-height:1.7;">⚠ 风险因素: ' + fp.riskFactors.map(function(rf) { return escHtml(rf); }).join(' · ') + '</div>';
    }
    html += '</div>';
  }

  // Empty state
  var hasContent = (anal.marketNarrative && anal.marketNarrative.narrative) ||
    (anal.tradesAnalysis && anal.tradesAnalysis.length > 0);
  if (!hasContent) {
    html += '<div style="text-align:center;padding:40px;color:#94a3b8;background:#fff;border-radius:8px;">';
    html += '<div style="font-size:32px;margin-bottom:12px;">📊</div>';
    html += '<div style="font-size:14px;font-weight:600;">暂无交易分析数据</div>';
    html += '<div style="font-size:12px;margin-top:4px;">今日无交易发生或分析尚未生成</div></div>';
  }

  return html;
}

// ============ Knowledge Base Section (always available) ============

function renderKnowledgeBaseSection(data, mode) {
  var html = '<div id="knowledge-base-section-container" style="max-width:960px;margin:0 auto;padding:20px 24px;">';
  html += '<div style="text-align:center;padding:40px;color:#64748b;">';
  html += '<div style="font-size:32px;margin-bottom:12px;">🧠</div>';
  html += '<div>正在加载 AI 知识库...</div>';
  html += '</div></div>';
  setTimeout(function() { loadKnowledgeBaseSection(); }, 100);
  return html;
}

function loadKnowledgeBaseSection() {
  var container = document.getElementById('knowledge-base-section-container');
  if (!container) return;
  fetch('/api/knowledge/summary')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.ok || !data.factorTracker) {
        container.innerHTML = '<div class="unavailable-placeholder">' +
          '<div class="lock-icon">🧠</div>' +
          '<div class="lock-title">知识库数据暂不可用</div>' +
          '<div class="lock-desc">知识库需要至少一个交易日的分析数据才能激活。请等待今日盘后总结生成。</div>' +
          '</div>';
        return;
      }
      container.innerHTML = renderKnowledgeBaseFull(data);
    })
    .catch(function() {
      container.innerHTML = '<div class="unavailable-placeholder">' +
        '<div class="lock-icon">⚠️</div>' +
        '<div class="lock-title">加载失败</div>' +
        '<div class="lock-desc">无法连接知识库服务，请检查 Mosaic Server 是否运行。</div>' +
        '</div>';
    });
}

function renderKnowledgeBaseFull(kb) {
  var html = '';
  html += '<h2 style="font-size:20px;color:#1e293b;margin:0 0 4px;">🧠 AI 自我成长知识库</h2>';
  html += '<p style="font-size:12px;color:#94a3b8;margin:0 0 20px;">量化因子追踪 · 模式学习 · 交易复盘 · 知识累积</p>';

  // Overview card
  html += '<div style="background:linear-gradient(135deg,#1e293b,#334155);border-radius:10px;padding:20px;margin-bottom:16px;color:#fff;">';
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:16px;text-align:center;">';
  html += '<div><div style="font-size:28px;font-weight:700;">' + (kb.totalDays || 0) + '</div><div style="font-size:11px;color:#94a3b8;">学习天数</div></div>';
  html += '<div><div style="font-size:28px;font-weight:700;">' + (kb.factorTracker.factors ? kb.factorTracker.factors.length : 0) + '</div><div style="font-size:11px;color:#94a3b8;">追踪因子</div></div>';
  html += '<div><div style="font-size:28px;font-weight:700;">' + (kb.factorTracker.totalTriggers || 0) + '</div><div style="font-size:11px;color:#94a3b8;">累计触发</div></div>';
  html += '<div><div style="font-size:28px;font-weight:700;">' + new Date(kb.lastUpdated).toLocaleDateString('zh-CN') + '</div><div style="font-size:11px;color:#94a3b8;">最后更新</div></div>';
  html += '</div></div>';

  // Factor rankings
  var factors = kb.factorTracker.factors || [];
  if (factors.length > 0) {
    var sorted = factors.slice().sort(function(a, b) { return b.triggerCount - a.triggerCount; });
    var maxTrigger = Math.max(1, sorted[0].triggerCount || 0);
    var activeFactors = sorted.filter(function(f) { return f.triggerCount > 0; });
    var inactiveFactors = sorted.filter(function(f) { return f.triggerCount === 0; });

    // Active factors
    if (activeFactors.length > 0) {
      html += '<div style="background:#fff;border-radius:8px;padding:20px;margin-bottom:16px;border:1px solid #e2e5eb;">';
      html += '<h3 style="font-size:14px;color:#1e293b;margin:0 0 12px;">🔥 活跃因子排行</h3>';
      for (var i = 0; i < activeFactors.length; i++) {
        var f = activeFactors[i];
        var barW = Math.max(3, Math.round(f.triggerCount / maxTrigger * 100));
        var daysActive = f.lastTriggered ? '最近触发: ' + f.lastTriggered : '未触发';
        html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;font-size:12px;">';
        html += '<span style="width:24px;text-align:right;color:#b8942c;font-weight:700;">' + (i + 1) + '</span>';
        html += '<span style="width:100px;font-weight:600;color:#1e293b;">' + f.id + ' ' + f.name + '</span>';
        html += '<div style="flex:1;height:8px;background:#f1f5f9;border-radius:4px;">';
        html += '<div style="height:100%;width:' + barW + '%;background:linear-gradient(90deg,#b8942c,#f59e0b);border-radius:4px;"></div></div>';
        html += '<span style="width:40px;text-align:right;font-weight:700;color:#1e293b;">' + f.triggerCount + '次</span>';
        html += '<span style="width:80px;text-align:right;color:#94a3b8;font-size:10px;">' + daysActive + '</span>';
        html += '</div>';
      }
      html += '</div>';
    }

    // Dormant factors
    if (inactiveFactors.length > 0) {
      html += '<div style="background:#fff;border-radius:8px;padding:20px;margin-bottom:16px;border:1px solid #e2e5eb;">';
      html += '<h3 style="font-size:14px;color:#94a3b8;margin:0 0 12px;">💤 待激活因子</h3>';
      html += '<div style="display:flex;flex-wrap:wrap;gap:8px;">';
      for (var di = 0; di < inactiveFactors.length; di++) {
        html += '<span style="padding:4px 12px;background:#f8fafc;border-radius:12px;font-size:11px;color:#94a3b8;border:1px solid #e5e7eb;">' + inactiveFactors[di].id + ' ' + inactiveFactors[di].name + '</span>';
      }
      html += '</div>';
      html += '<p style="font-size:11px;color:#cbd5e1;margin-top:8px;">这些因子尚未被市场触发，随着扫描数据累积，它们将在合适的市场环境下激活。</p>';
      html += '</div>';
    }

    // Factor details table
    html += '<div style="background:#fff;border-radius:8px;padding:20px;margin-bottom:16px;border:1px solid #e2e5eb;">';
    html += '<h3 style="font-size:14px;color:#1e293b;margin:0 0 12px;">📋 因子详细数据</h3>';
    html += '<div style="overflow-x:auto;">';
    html += '<table style="width:100%;font-size:12px;border-collapse:collapse;">';
    html += '<thead><tr style="text-align:left;border-bottom:2px solid #e2e5eb;">';
    html += '<th style="padding:8px;color:#64748b;">因子</th><th style="padding:8px;color:#64748b;">名称</th><th style="padding:8px;color:#64748b;text-align:right;">触发次数</th><th style="padding:8px;color:#64748b;text-align:right;">Top日数</th><th style="padding:8px;color:#64748b;text-align:right;">平均贡献</th><th style="padding:8px;color:#64748b;">最近触发</th></tr></thead>';
    html += '<tbody>';
    for (var ti = 0; ti < sorted.length; ti++) {
      var row = sorted[ti];
      var isActiveRow = row.triggerCount > 0;
      html += '<tr style="border-bottom:1px solid #f1f5f9;' + (isActiveRow ? '' : 'color:#cbd5e1;') + '">';
      html += '<td style="padding:8px;font-weight:600;">' + row.id + '</td>';
      html += '<td style="padding:8px;">' + row.name + '</td>';
      html += '<td style="padding:8px;text-align:right;font-weight:600;">' + row.triggerCount + '</td>';
      html += '<td style="padding:8px;text-align:right;">' + (row.daysTopSignal || 0) + '</td>';
      html += '<td style="padding:8px;text-align:right;">' + (row.avgContribution > 0 ? row.avgContribution + '%' : '--') + '</td>';
      html += '<td style="padding:8px;font-size:11px;">' + (row.lastTriggered || '--') + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table></div></div>';

    // Learning insight
    html += '<div style="background:#fef9e7;border-radius:8px;padding:16px;border:1px solid #f59e0b;">';
    html += '<h3 style="font-size:14px;color:#1e293b;margin:0 0 8px;">💡 系统学习洞察</h3>';
    html += '<ul style="font-size:12px;color:#64748b;line-height:1.9;margin:0;padding-left:18px;">';
    html += '<li>知识库已运行 <b>' + kb.totalDays + ' 天</b>，累计追踪了 ' + kb.factorTracker.factors.length + ' 个量化因子</li>';
    if (activeFactors.length > 0) {
      html += '<li>目前 <b>' + activeFactors.length + ' 个因子</b>已被市场触发，' + inactiveFactors.length + ' 个因子等待激活</li>';
      var topFactor = activeFactors[0];
      html += '<li>最强因子 <b>' + topFactor.id + ' ' + topFactor.name + '</b> 共触发 ' + topFactor.triggerCount + ' 次，平均贡献度 ' + (topFactor.avgContribution || 0) + '%</li>';
    }
    html += '<li>随着交易日累积，系统将自动学习因子间的协同模式，提升交易决策质量</li>';
    html += '<li>当数据积累到 20+ 交易日时，将启用历史模式匹配功能，提供更精准的前瞻预测</li>';
    html += '</ul></div>';
  }

  return html;
}

// ============ Placeholder Helper ============

function renderPlaceholder(label, phase) {
  var html = '<div class="unavailable-placeholder';
  if (phase === 'generating') html += ' style="border:2px dashed #f59e0b;"';
  html += '">';
  if (phase === 'trading') {
    html += '<div class="lock-icon">⏳</div>';
    html += '<div class="lock-title">' + label + ' — 暂不可用</div>';
    html += '<div class="lock-desc">市场交易中，AI 量化交易员正在实时监控。盘后总结报告将于每日16:00自动生成，届时可在此查看完整内容。</div>';
  } else if (phase === 'generating') {
    html += '<div class="lock-icon">🔄</div>';
    html += '<div class="lock-title">正在分析并生成中...</div>';
    html += '<div class="lock-desc">市场已收盘，AI 正在汇总今日数据，预计16:00前完成，请稍后再来查看。</div>';
  } else if (phase === 'closed') {
    html += '<div class="lock-icon">🔒</div>';
    html += '<div class="lock-title">' + label + ' — 休市</div>';
    html += '<div class="lock-desc">今日非交易日，请在下一个交易日16:00后查看盘后总结。</div>';
  }
  html += '</div>';
  return html;
}

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

// === Load summary dates from server for calendar highlighting ===
function loadSummaryDates() {
  fetch('/api/summary-dates')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok && data.dates) {
        state.summaryDates = data.dates;
        renderCalendar(); // Re-render calendar to show summary dots
      }
    })
    .catch(function() {});
}

// ============ History Review (Calendar-based Backtesting) ============

function renderHistoryReview(data, mode) {
  var dateStr = cal.activeDate;
  var html = '<div id="history-review-container" style="max-width:960px;margin:0 auto;padding:20px 24px;">';
  html += '<div style="text-align:center;padding:40px;color:#64748b;">';
  html += '<div style="font-size:32px;margin-bottom:12px;">📅</div>';
  html += '<div>正在加载 ' + dateStr + ' 的历史数据...</div>';
  html += '</div></div>';
  setTimeout(function() { loadHistoryReviewData(dateStr); }, 100);
  return html;
}

function loadHistoryReviewData(dateStr) {
  var container = document.getElementById('history-review-container');
  if (!container) return;

  // Fetch all available data for this date in parallel
  var summaryPromise = fetch('/api/daily-summary/' + dateStr).then(function(r) { return r.json(); }).catch(function() { return null; });
  var newsPromise = fetch('/api/news/' + dateStr).then(function(r) { return r.json(); }).catch(function() { return null; });
  var analysisPromise = fetch('/api/analysis/' + dateStr).then(function(r) { return r.json(); }).catch(function() { return null; });
  var eventsPromise = fetch('/api/events/' + dateStr).then(function(r) { return r.json(); }).catch(function() { return null; });

  Promise.all([summaryPromise, newsPromise, analysisPromise, eventsPromise]).then(function(results) {
    var summaryData = results[0];
    var newsData = results[1];
    var analysisData = results[2];
    var eventsData = results[3];

    var hasSummary = summaryData && summaryData.ok;
    var hasNews = newsData && newsData.ok && newsData.news && newsData.news.items && newsData.news.items.length > 0;
    var hasAnalysis = analysisData && analysisData.ok && analysisData.tradeAnalysis;
    var hasEvents = eventsData && eventsData.ok && eventsData.events && eventsData.events.length > 0;

    if (!hasSummary && !hasNews && !hasAnalysis && !hasEvents) {
      container.innerHTML = '<div class="unavailable-placeholder">' +
        '<div class="lock-icon">📭</div>' +
        '<div class="lock-title">' + dateStr + ' 无历史数据</div>' +
        '<div class="lock-desc">该日期没有可用的盘后总结、新闻或分析数据。</div>' +
        '</div>';
      return;
    }

    var html = '';

    // Title
    html += '<h2 style="font-size:20px;color:#1e293b;margin:0 0 16px;">📅 ' + dateStr + ' 历史复盘</h2>';

    // Tab bar
    html += '<div style="display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap;" id="history-tabs">';
    if (hasSummary) html += '<button class="history-tab-btn active" data-tab="summary" style="padding:6px 14px;border-radius:6px;font-size:12px;cursor:pointer;background:#1e293b;color:#fff;border:1px solid #1e293b;font-weight:600;" onclick="switchHistoryTab(\'summary\')">📊 收盘总结</button>';
    if (hasNews) html += '<button class="history-tab-btn" data-tab="news" style="padding:6px 14px;border-radius:6px;font-size:12px;cursor:pointer;background:#fff;color:#475569;border:1px solid #e2e5eb;" onclick="switchHistoryTab(\'news\')">📰 时政要点</button>';
    if (hasAnalysis) html += '<button class="history-tab-btn" data-tab="analysis" style="padding:6px 14px;border-radius:6px;font-size:12px;cursor:pointer;background:#fff;color:#475569;border:1px solid #e2e5eb;" onclick="switchHistoryTab(\'analysis\')">📊 交易分析</button>';
    if (hasEvents) html += '<button class="history-tab-btn" data-tab="events" style="padding:6px 14px;border-radius:6px;font-size:12px;cursor:pointer;background:#fff;color:#475569;border:1px solid #e2e5eb;" onclick="switchHistoryTab(\'events\')">📋 事件时间线</button>';
    html += '</div>';

    // Tab content containers
    html += '<div id="history-tab-content">';
    if (hasSummary) {
      html += '<div class="history-tab-pane" id="history-tab-summary">' + renderHistorySummary(summaryData) + '</div>';
    } else {
      html += '<div class="history-tab-pane" id="history-tab-summary" style="display:none;"></div>';
    }
    if (hasNews) {
      html += '<div class="history-tab-pane" id="history-tab-news" style="display:none;">' + renderHistoryNews(newsData) + '</div>';
    } else {
      html += '<div class="history-tab-pane" id="history-tab-news" style="display:none;"></div>';
    }
    if (hasAnalysis) {
      html += '<div class="history-tab-pane" id="history-tab-analysis" style="display:none;">' + renderHistoryAnalysis(analysisData) + '</div>';
    } else {
      html += '<div class="history-tab-pane" id="history-tab-analysis" style="display:none;"></div>';
    }
    if (hasEvents) {
      html += '<div class="history-tab-pane" id="history-tab-events" style="display:none;">' + renderHistoryEvents(eventsData) + '</div>';
    } else {
      html += '<div class="history-tab-pane" id="history-tab-events" style="display:none;"></div>';
    }
    html += '</div>';

    container.innerHTML = html;
  });
}

function renderHistorySummary(s) {
  var html = '';

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
    html += '<div style="background:#fff;border-radius:8px;padding:16px;margin-bottom:16px;border:1px solid #e2e5eb;">';
    html += '<h3 style="font-size:14px;color:#1e293b;margin:0 0 12px;">💰 当日持仓快照</h3>';
    html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px;">';
    html += '<div style="text-align:center;background:#f8fafc;border-radius:6px;padding:10px;"><div style="font-size:11px;color:#94a3b8;">总资产</div><div style="font-size:18px;font-weight:700;">¥' + formatMoneyCN(p.totalValue) + '</div></div>';
    html += '<div style="text-align:center;background:#f8fafc;border-radius:6px;padding:10px;"><div style="font-size:11px;color:#94a3b8;">收益</div><div style="font-size:18px;font-weight:700;color:' + ((p.totalReturn||0) >= 0 ? UP_COLOR : DOWN_COLOR) + ';">' + ((p.totalReturn||0) >= 0 ? '+' : '') + (p.totalReturn||0).toFixed(2) + '%</div></div>';
    html += '<div style="text-align:center;background:#f8fafc;border-radius:6px;padding:10px;"><div style="font-size:11px;color:#94a3b8;">现金</div><div style="font-size:18px;font-weight:700;">¥' + formatMoneyCN(p.cash) + '</div></div>';
    html += '</div>';
    if (p.positions && p.positions.length > 0) {
      html += '<table style="width:100%;border-collapse:collapse;font-size:12px;">';
      html += '<thead><tr style="background:#f8fafc;border-bottom:2px solid #b8942c;">';
      html += '<th style="padding:8px;text-align:left;">股票</th><th style="padding:8px;text-align:right;">成本</th><th style="padding:8px;text-align:right;">现价</th><th style="padding:8px;text-align:right;">盈亏</th></tr></thead><tbody>';
      for (var j = 0; j < p.positions.length; j++) {
        var pos = p.positions[j];
        html += '<tr style="border-bottom:1px solid #f1f5f9;">';
        html += '<td style="padding:8px;"><b>' + escHtml(pos.name) + '</b><br><span style="color:#94a3b8;font-size:10px;">' + pos.code + '</span></td>';
        html += '<td style="padding:8px;text-align:right;">¥' + pos.avgCost.toFixed(2) + '</td>';
        html += '<td style="padding:8px;text-align:right;">¥' + pos.currentPrice.toFixed(2) + '</td>';
        html += '<td style="padding:8px;text-align:right;color:' + ((pos.pnl||0) >= 0 ? UP_COLOR : DOWN_COLOR) + ';font-weight:600;">' + ((pos.pnl||0) >= 0 ? '+' : '') + (pos.pnlPct||0).toFixed(2) + '%</td>';
        html += '</tr>';
      }
      html += '</tbody></table>';
    }
    html += '</div>';
  }

  // Pipeline Summary
  if (s.pipeline) {
    var pl = s.pipeline;
    html += '<div style="background:#fff;border-radius:8px;padding:16px;margin-bottom:16px;border:1px solid #e2e5eb;">';
    html += '<h3 style="font-size:14px;color:#1e293b;margin:0 0 12px;">🔬 量化分析总结</h3>';
    html += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px;">';
    html += '<div style="text-align:center;"><div style="font-size:11px;color:#94a3b8;">深度分析</div><div style="font-size:16px;font-weight:600;">' + (pl.analyzed || 0) + ' 只</div></div>';
    html += '<div style="text-align:center;"><div style="font-size:11px;color:#94a3b8;">平均分</div><div style="font-size:16px;font-weight:600;">' + (pl.avgScore || 0) + '</div></div>';
    html += '<div style="text-align:center;"><div style="font-size:11px;color:#94a3b8;">最高分</div><div style="font-size:16px;font-weight:600;color:#f59e0b;">' + (pl.maxScore || 0) + '</div></div>';
    if (pl.duration) html += '<div style="text-align:center;"><div style="font-size:11px;color:#94a3b8;">耗时</div><div style="font-size:16px;font-weight:600;">' + pl.duration + '秒</div></div>';
    html += '</div>';
    if (pl.top5 && pl.top5.length > 0) {
      html += '<div style="font-size:12px;color:#64748b;margin-bottom:4px;">当日 TOP5 推荐:</div>';
      for (var ti = 0; ti < pl.top5.length; ti++) {
        var top = pl.top5[ti];
        html += '<div style="padding:4px 0;font-size:13px;border-bottom:1px solid #f1f5f9;">';
        html += '<span style="font-weight:600;color:#1e293b;">#' + (ti+1) + ' ' + escHtml(top.name) + '</span> ';
        html += '<span style="color:#94a3b8;">' + top.code + '</span> ';
        html += '<span style="color:#f59e0b;font-weight:600;">' + top.score + '分</span>';
        html += '</div>';
      }
    }
    html += '</div>';
  }

  // Today's trades
  if (s.todayTrades && s.todayTrades.length > 0) {
    html += '<div style="background:#fff;border-radius:8px;padding:16px;margin-bottom:16px;border:1px solid #e2e5eb;">';
    html += '<h3 style="font-size:14px;color:#1e293b;margin:0 0 12px;">📋 当日交易 (' + s.todayTrades.length + '笔)</h3>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:12px;">';
    html += '<thead><tr style="background:#f8fafc;border-bottom:2px solid #b8942c;">';
    html += '<th style="padding:8px;">时间</th><th style="padding:8px;">操作</th><th style="padding:8px;">股票</th><th style="padding:8px;text-align:right;">价格</th><th style="padding:8px;text-align:right;">数量</th><th style="padding:8px;text-align:right;">金额</th><th style="padding:8px;">原因</th></tr></thead><tbody>';
    for (var k = 0; k < s.todayTrades.length; k++) {
      var tr = s.todayTrades[k];
      var isBuy = tr.action === 'buy';
      html += '<tr style="border-bottom:1px solid #f1f5f9;">';
      html += '<td style="padding:8px;font-size:11px;">' + (tr.time||'') + '</td>';
      html += '<td style="padding:8px;font-weight:600;color:' + (isBuy ? UP_COLOR : DOWN_COLOR) + ';">' + (isBuy ? '买入' : '卖出') + '</td>';
      html += '<td style="padding:8px;"><b>' + escHtml(tr.name) + '</b><br><span style="color:#94a3b8;font-size:10px;">' + tr.code + '</span></td>';
      html += '<td style="padding:8px;text-align:right;">¥' + tr.price.toFixed(2) + '</td>';
      html += '<td style="padding:8px;text-align:right;">' + tr.shares + '股</td>';
      html += '<td style="padding:8px;text-align:right;">¥' + formatMoneyCN(tr.amount) + '</td>';
      html += '<td style="padding:8px;font-size:11px;color:#64748b;">' + escHtml(tr.reason || '') + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table></div>';
  }

  return html;
}

function renderHistoryNews(newsData) {
  var news = newsData.news;
  if (!news || !news.items || news.items.length === 0) {
    return '<div class="unavailable-placeholder"><div class="lock-icon">📭</div><div class="lock-title">该日期无新闻数据</div></div>';
  }
  var html = '<h3 style="font-size:14px;color:#1e293b;margin:0 0 12px;">📰 当日时政要点 (' + news.count + '条)</h3>';
  for (var i = 0; i < news.items.length; i++) {
    var item = news.items[i];
    var catColors = { policy: '#7c3aed', sector: '#059669', company: '#d97706', macro: '#dc2626' };
    var timeHHMM = item.time ? new Date(item.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
    html += '<div style="display:flex;gap:14px;padding:12px 0;border-bottom:1px solid #f1f5f9;">';
    html += '<div style="min-width:48px;font-size:11px;color:#94a3b8;padding-top:2px;">' + timeHHMM + '</div>';
    html += '<div style="flex:1;">';
    html += '<span style="display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;color:#fff;background:' + (catColors[item.category]||'#64748b') + ';margin-right:6px;">' + item.category + '</span>';
    html += '<a href="' + (item.url||'#') + '" target="_blank" style="font-size:13px;color:#1e293b;text-decoration:none;font-weight:500;">' + escHtml(item.title) + '</a>';
    html += '<div style="font-size:11px;color:#94a3b8;margin-top:2px;">' + escHtml(item.source) + '</div>';
    if (item.summary) html += '<div style="font-size:12px;color:#64748b;margin-top:4px;">' + escHtml(item.summary) + '</div>';
    html += '</div></div>';
  }
  return html;
}

function renderHistoryAnalysis(analysisData) {
  var anal = analysisData.tradeAnalysis;
  var html = '';
  if (anal.marketNarrative && anal.marketNarrative.narrative) {
    html += '<div style="background:#fff;border-radius:8px;padding:20px;margin-bottom:16px;border-left:4px solid #b8942c;">';
    html += '<h3 style="font-size:14px;color:#1e293b;margin:0 0 12px;">🏛 市场叙事</h3>';
    html += '<p style="font-size:14px;line-height:1.9;color:#334155;">' + escHtml(anal.marketNarrative.narrative) + '</p>';
    html += '</div>';
  }
  if (anal.tradesAnalysis && anal.tradesAnalysis.length > 0) {
    for (var t = 0; t < anal.tradesAnalysis.length; t++) {
      var ta = anal.tradesAnalysis[t];
      var isBuy = ta.action === 'buy';
      html += '<div style="background:#fff;border-radius:8px;padding:20px;margin-bottom:16px;border:1px solid #e2e5eb;">';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">';
      html += '<div><span style="color:' + (isBuy ? UP_COLOR : DOWN_COLOR) + ';font-weight:700;">' + (isBuy ? '🔴 买入' : '🟢 卖出') + '</span> ';
      html += '<b>' + escHtml((ta.stock||{}).name || '') + '</b> ';
      html += '<span style="color:#94a3b8;">' + ((ta.stock||{}).code || '') + '</span></div>';
      html += '</div>';
      html += '<p style="font-size:13px;line-height:1.8;color:#334155;">' + escHtml(ta.deepReason || '') + '</p>';
      html += '</div>';
    }
  }
  if (!html) {
    html = '<div class="unavailable-placeholder"><div class="lock-icon">📊</div><div class="lock-title">该日期无交易分析</div></div>';
  }
  return html;
}

function renderHistoryEvents(eventsData) {
  var evts = eventsData.events;
  var html = '<h3 style="font-size:14px;color:#1e293b;margin:0 0 12px;">📋 当日事件 (' + evts.length + '条)</h3>';
  // Reverse chronological
  for (var i = evts.length - 1; i >= 0; i--) {
    var evt = evts[i];
    var time = evt.time ? new Date(evt.time).toTimeString().slice(0,8) : '--:--:--';
    var tag = mapEventTag_review(evt.type);
    var tagClass = mapEventClass_review(evt.type);
    var msg = formatEventMsg_review(evt);
    html += '<div class="tl-entry" style="display:flex;gap:8px;padding:4px 8px;font-size:11px;border-bottom:1px solid #f1f5f9;">';
    html += '<span style="color:#94a3b8;white-space:nowrap;min-width:70px;">' + time + '</span>';
    html += '<span style="padding:0 6px;border-radius:3px;font-size:10px;font-weight:bold;white-space:nowrap;min-width:50px;text-align:center;background:rgba(0,212,255,0.15);color:#00d4ff;">' + tag + '</span>';
    html += '<span style="color:#64748b;flex:1;">' + msg + '</span>';
    html += '</div>';
  }
  return html;
}

function switchHistoryTab(tabId) {
  // Update tab buttons
  var btns = document.querySelectorAll('.history-tab-btn');
  btns.forEach(function(btn) {
    if (btn.getAttribute('data-tab') === tabId) {
      btn.style.background = '#1e293b';
      btn.style.color = '#fff';
      btn.style.borderColor = '#1e293b';
    } else {
      btn.style.background = '#fff';
      btn.style.color = '#475569';
      btn.style.border = '1px solid #e2e5eb';
    }
  });
  // Show/hide panes
  var panes = document.querySelectorAll('.history-tab-pane');
  panes.forEach(function(pane) {
    pane.style.display = pane.id === 'history-tab-' + tabId ? 'block' : 'none';
  });
}
window.switchHistoryTab = switchHistoryTab;

function mapEventTag_review(type) {
  var m = {
    pipeline_start: '扫描', pipeline_complete: '扫描', pipeline_error: '扫描',
    midscan_start: '扫描', midscan_complete: '扫描',
    trade_executed: '交易', trade_complete: '交易', trade_skip: '跳过',
    state_change: '状态', risk_trade: '风控',
    scheduler_start: '系统', scheduler_stop: '系统',
    position_refresh: '刷新', post_market_wrapup: '收盘',
    daily_summary_start: '总结', daily_summary_complete: '总结',
    new_day: '新日',
  };
  return m[type] || '信息';
}
function mapEventClass_review(type) {
  if (type.includes('trade')) return 'trade';
  if (type.includes('scan') || type.includes('pipeline') || type.includes('summary')) return 'scan';
  if (type.includes('risk') || type.includes('error')) return 'alert';
  return 'state';
}
function formatEventMsg_review(evt) {
  var d = evt.detail || {};
  switch (evt.type) {
    case 'pipeline_complete': return '扫描完成: ' + (d.totalStocks||'?') + '只 → ' + (d.candidates||'?') + '候选';
    case 'trade_executed': return (d.action==='buy'?'买入':'卖出') + ' ' + (d.name||'') + ' ' + (d.shares||'?') + '股';
    case 'state_change': return '状态: ' + (d.from||'') + ' → ' + (d.to||'');
    case 'post_market_wrapup': return '收盘: 总资产¥' + (d.totalValue||0);
    default: return evt.type + (d.reason ? ': ' + d.reason : '');
  }
}
// End of History Review

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
  var sectionId = state.activeSection;
  var sec = null;
  for (var i = 0; i < SECTIONS.length; i++) {
    if (SECTIONS[i].id === sectionId) { sec = SECTIONS[i]; break; }
  }
  if (!sec) return;

  // Simfolio: always render directly (no iframe, works without report data)
  if (sectionId === 'simfolio') {
    renderSimfolioDirect();
    return;
  }

  // News Policy, Trade Analysis, Knowledge Base, History Review: always render directly
  // These sections handle all states internally
  if (sectionId === 'newsPolicy' || sectionId === 'tradingReport' || sectionId === 'holdingsAnalysis' || sectionId === 'knowledgeBase' || sectionId === 'historyReview') {
    renderTimeAwareSectionDirect(sectionId);
    return;
  }

  // For non-engine views, loadReportByMeta already handled content
  if (!state.reportData || state.currentViewMode !== 'engine') {
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
    var hasSummary = state.summaryDates && state.summaryDates.indexOf(dateStr) >= 0;

    var cls = 'calendar-day current-month';
    if (isToday) cls += ' today';
    if (isActive) cls += ' active';
    if (hasSummary) cls += ' has-summary';

    var clickAttr = ' onclick="onDateClick(\'' + dateStr + '\')"';
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
  cal.activeDate = dateStr;

  // If there's a report for this date, load it and switch to simfolio
  var reports = state.reportsByDate[dateStr];
  if (reports && reports.length > 0) {
    var best = null;
    for (var i = 0; i < reports.length; i++) {
      if (reports[i].viewMode === 'engine') { best = reports[i]; break; }
      if (reports[i].viewMode === 'html' && !best) { best = reports[i]; }
    }
    if (!best && reports[0].viewMode === 'pdf-only') {
      best = reports[0];
    }
    if (!best) best = reports[0];
    state.activeSection = 'simfolio';
    loadReportByMeta(best);
  } else {
    // No report — check if there's a summary for this date (historical data)
    var hasSummary = state.summaryDates && state.summaryDates.indexOf(dateStr) >= 0;
    if (hasSummary) {
      // Switch to history review section
      setActiveSection('historyReview');
    } else {
      // Just select the date in calendar with no data
      if ($contentTitle) $contentTitle.textContent = dateStr + ' — 无数据';
      $contentArea.innerHTML = '<div class="unavailable-placeholder">' +
        '<div class="lock-icon">📅</div>' +
        '<div class="lock-title">该日期无数据</div>' +
        '<div class="lock-desc">所选日期没有盘后总结或其他报告数据。</div>' +
        '</div>';
    }
  }
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
