// Francis Investment Report Engine — Dashboard Controller
// Section-based navigation: click a section → see that content
// v2.0 — integrated with Mosaic Flask server

// -- State --
var state = {
  reportData: null,
  currentViewMode: null,
  currentDate: null,
  currentReportMeta: null,
  reportsIndex: [],
  reportsByDate: {},
  dirty: false,
  activeSection: 'cover',       // currently selected section
  activeMode: 'section',        // 'section' | 'full'
  serverConnected: false,       // Mosaic server connection status
  serverStatus: null,           // last /api/status response
};

// Calendar state
var cal = {
  year: 2026,
  month: 5,
  activeDate: '2026-05-15',
};

// Section definitions
var SECTIONS = [
  { id: 'cover',           label: '报告封面',     icon: '📋', render: function(d,m) { return renderCover(d,m); } },
  { id: 'newsPolicy',      label: '时政要点',     icon: '📰', render: function(d,m) { return renderNewsPolicy(d,m); } },
  { id: 'marketOverview',  label: '大盘综述',     icon: '📊', render: function(d,m) { return renderMarketOverview(d,m); } },
  { id: 'holdingsAnalysis',label: '持仓分析',     icon: '💼', render: function(d,m) { return renderHoldingsAnalysis(d,m); } },
  { id: 'sectorTracking',  label: '板块跟踪',     icon: '🔥', render: function(d,m) { return renderSectorTracking(d,m); } },
  { id: 'lowPricePicks',   label: '潜力股推荐',   icon: '💎', render: function(d,m) { return renderLowPricePicks(d,m); } },
  { id: 'top5Ranking',     label: 'TOP5 排行',    icon: '🏆', render: function(d,m) { return renderTop5Ranking(d,m); } },
  { id: 'simfolio',        label: '模拟交易',     icon: '💰', render: function(d,m) { return renderSimfolioWrapper(d,m); } },
  { id: 'riskMatrix',      label: '风险矩阵',     icon: '⚠️', render: function(d,m) { return renderRiskMatrix(d,m); } },
];

// -- DOM refs --
var $contentArea, $contentTitle, $btnSendPdf, $btnGenPDF, $btnRunAnalysis, $statusBar;
var $calendarWidget, $reportListItems, $sectionNavList;
var $toolbarDate, $pipelineProgress, $pipelineStep, $pipelineBar, $pipelinePct;

// -- Init --
function initApp() {
  $contentArea     = document.getElementById('content-area');
  $contentTitle    = document.getElementById('content-title');
  $btnSendPdf      = document.getElementById('btn-send-pdf');
  $btnGenPDF       = document.getElementById('btn-gen-pdf');
  $btnRunAnalysis  = document.getElementById('btn-run-analysis');
  $statusBar       = document.getElementById('status-bar');
  $calendarWidget  = document.getElementById('calendar-widget');
  $reportListItems = document.getElementById('report-list-items');
  $sectionNavList  = document.getElementById('section-nav-list');
  $toolbarDate     = document.getElementById('toolbar-date');
  $pipelineProgress = document.getElementById('pipeline-progress');
  $pipelineStep    = document.getElementById('pipeline-step');
  $pipelineBar     = document.getElementById('pipeline-bar');
  $pipelinePct     = document.getElementById('pipeline-pct');

  var today = new Date();
  cal.year = today.getFullYear();
  cal.month = today.getMonth() + 1;

  // Check Mosaic server connection first
  checkServerStatus(function() {
    // Then load reports index — auto-load latest report
    loadReportsIndex();

    // Auto-start pipeline on trading days
    if (state.serverStatus && state.serverStatus.isTradingDay) {
      updateStatus('交易日 — 正在自动启动量化分析...');
      setTimeout(function() {
        onRunAnalysis();
      }, 1000);
    }
  });

  // Bind events
  if ($btnSendPdf) $btnSendPdf.addEventListener('click', onSendPdf);
  if ($btnGenPDF) $btnGenPDF.addEventListener('click', onGenPDF);
  if ($btnRunAnalysis) $btnRunAnalysis.addEventListener('click', onRunAnalysis);

  // Section nav delegation
  $sectionNavList.addEventListener('click', function(e) {
    var item = e.target.closest('.section-nav-item');
    if (!item) return;
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
      updateStatus('Mosaic Server · ' + data.date + ' ' + data.weekday + ' · ' + (data.isTradingDay ? '🟢 交易日' : '⚫ 休市'));
      if (callback) callback();
    })
    .catch(function() {
      state.serverConnected = false;
      state.serverStatus = null;
      updateStatus('离线模式 · 本地数据（未连接Mosaic Server）');
      if (callback) callback();
    });
}

// ============ Pipeline / Run Analysis ============

var _pipelinePollTimer = null;

function onRunAnalysis() {
  if (!state.serverConnected) {
    updateStatus('未连接到 Mosaic Server，请确认服务器已启动');
    return;
  }

  if (!state.serverStatus || !state.serverStatus.isTradingDay) {
    updateStatus('今日休市，无需运行分析');
    return;
  }

  // Disable button
  if ($btnRunAnalysis) {
    $btnRunAnalysis.disabled = true;
    $btnRunAnalysis.textContent = '⏳ 运行中...';
  }

  // Show progress bar
  if ($pipelineProgress) $pipelineProgress.style.display = 'block';
  if ($pipelineStep) $pipelineStep.textContent = '正在启动分析...';
  if ($pipelineBar) $pipelineBar.style.width = '0%';
  if ($pipelinePct) $pipelinePct.textContent = '0%';

  updateStatus('正在启动量化分析...');

  // Call API to start pipeline
  fetch('/api/pipeline/run', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) {
        updateStatus('量化分析已启动 — 正在联网采集数据...');
        startPipelinePoll();
      } else {
        updateStatus(data.message || '启动失败');
        resetRunButton();
      }
    })
    .catch(function(err) {
      updateStatus('启动失败: ' + err.message);
      resetRunButton();
    });
}

function startPipelinePoll() {
  if (_pipelinePollTimer) clearInterval(_pipelinePollTimer);
  _pipelinePollTimer = setInterval(pollPipelineStatus, 1000);
}

// ---- Simfolio Section ----

var _cachedSimfolioData = null;

function renderSimfolioWrapper(data, mode) {
  // Load simfolio data from API for app mode
  if (mode === 'app' && state.serverConnected) {
    fetchSimfolioData(function(sfData) {
      _cachedSimfolioData = sfData;
      // Re-render after data loaded
      var sec = null;
      for (var i = 0; i < SECTIONS.length; i++) {
        if (SECTIONS[i].id === 'simfolio') { sec = SECTIONS[i]; break; }
      }
      if (sec && state.activeSection === 'simfolio') {
        renderSimfolioSection();
      }
    });
  }

  // Use cached or empty data
  var wrapper = { _simfolio: _cachedSimfolioData || {} };
  return renderSimfolio(wrapper, mode);
}

function fetchSimfolioData(callback) {
  fetch('/api/simfolio/status')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var sfData = {
        snapshot: { totalValue: data.totalValue, cash: data.cash, totalReturn: data.totalReturn, benchmarkReturn: data.benchmarkReturn, alpha: data.alpha, positions: data.positions, positionValue: data.positionValue },
        stats: data.stats || {},
        tradeHistory: data.tradeHistory || [],
        dailyNav: [],
      };
      // Also fetch history for chart
      fetch('/api/simfolio/history')
        .then(function(r) { return r.json(); })
        .then(function(hist) {
          sfData.dailyNav = hist.dailyNav || [];
          callback(sfData);
        })
        .catch(function() { callback(sfData); });
    })
    .catch(function() { callback({}); });
}

function renderSimfolioSection() {
  if (!state.reportData) state.reportData = {};
  var sfData = _cachedSimfolioData || {};
  state.reportData._simfolio = sfData;

  var sectionHTML = renderSimfolio(state.reportData, 'app');
  var css = renderSoftwareCSS();
  var wrapperHTML = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>' + css + ' body { overflow-y: auto; }</style></head><body><div class="report-preview">' + sectionHTML + '</div><script>window.parent.postMessage("simfolio-ready","*");</' + 'script></body></html>';

  $contentArea.innerHTML = '';
  var iframe = document.createElement('iframe');
  iframe.style.cssText = 'width:100%;height:100%;border:none;min-height:70vh;';
  iframe.sandbox = 'allow-same-origin allow-scripts';
  iframe.srcdoc = wrapperHTML;
  $contentArea.appendChild(iframe);
}

// ---- Auto-trade after pipeline ----

function triggerAutoTrade() {
  updateStatus('分析完成 — 正在执行模拟交易...');
  fetch('/api/simfolio/trade', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok && data.executed) {
        updateStatus('交易完成！执行 ' + data.executed.length + ' 笔交易 | 总资产 ¥' + formatMoneyCN(data.snapshot.totalValue));
        // Refresh simfolio data
        fetchSimfolioData(function(sfData) {
          _cachedSimfolioData = sfData;
        });
      } else {
        updateStatus(data.message || '交易决策完成');
      }
    })
    .catch(function(err) {
      updateStatus('模拟交易执行失败: ' + err.message);
    });
}

function formatMoneyCN(val) {
  if (val == null) return '0';
  return val.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}

function pollPipelineStatus() {
  fetch('/api/pipeline/status')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      // Update progress UI
      if ($pipelineBar) $pipelineBar.style.width = data.progress + '%';
      if ($pipelinePct) $pipelinePct.textContent = data.progress + '%';
      if ($pipelineStep && data.step) $pipelineStep.textContent = data.step;

      if (data.status === 'done') {
        // Analysis complete
        clearInterval(_pipelinePollTimer);
        _pipelinePollTimer = null;
        updateStatus('分析完成！共分析 ' + (data.result ? data.result.analyzed : '?') + ' 只股票');
        if ($pipelineStep) $pipelineStep.textContent = '分析完成！';
        if ($pipelineProgress) setTimeout(function() { $pipelineProgress.style.display = 'none'; }, 5000);
        resetRunButton();

        // Auto-trigger Simfolio trading
        setTimeout(function() { triggerAutoTrade(); }, 500);

        // Show summary
        if (data.result) {
          showAnalysisSummary(data.result);
        }
      } else if (data.status === 'error') {
        clearInterval(_pipelinePollTimer);
        _pipelinePollTimer = null;
        updateStatus('分析出错: ' + (data.error || '未知错误'));
        resetRunButton();
      }
    })
    .catch(function() {
      // Server might be busy, keep polling
    });
}

function resetRunButton() {
  if ($btnRunAnalysis) {
    $btnRunAnalysis.disabled = false;
    $btnRunAnalysis.textContent = '⚡ 运行分析';
  }
}

function showAnalysisSummary(result) {
  if (!result || !result.top5) return;

  var summary = '📊 量化分析完成！TOP5: ';
  for (var i = 0; i < result.top5.length; i++) {
    var s = result.top5[i];
    summary += (i > 0 ? ', ' : '') + s.name + '(' + s.compositeScore + '分/' + s.rating + '级)';
  }
  updateStatus(summary);

  // Reload page to show new data (for P1, just refresh the state)
  // For now, the analysis results are available via API
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
  }

  renderCurrentSection();
}

function renderCurrentSection() {
  if (!state.reportData || state.currentViewMode !== 'engine') {
    // For HTML/pdfs-only, loadReportByMeta already handled content
    return;
  }

  var sectionId = state.activeSection;
  var sec = null;
  for (var i = 0; i < SECTIONS.length; i++) {
    if (SECTIONS[i].id === sectionId) { sec = SECTIONS[i]; break; }
  }

  if (!sec) return;

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
    var reportCount = hasReport ? state.reportsByDate[dateStr].length : 0;
    var isToday = dateStr === todayStr;
    var isActive = dateStr === cal.activeDate;

    var cls = 'calendar-day current-month';
    if (isToday) cls += ' today';
    if (hasReport) {
      cls += ' has-report';
      if (reportCount > 1) cls += ' multi';
    }
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
  // Reset to cover when switching dates
  state.activeSection = 'cover';
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
  state.activeSection = 'cover';
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

  // Highlight TOP5 nav item
  var items = $sectionNavList.querySelectorAll('.section-nav-item');
  items.forEach(function(item) {
    item.classList.toggle('active', item.getAttribute('data-section') === 'top5Ranking');
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
    setActiveSection('top5Ranking');
  }
}

// Expose to window for iframe onclick access
window.showRecommendationHistory = showRecommendationHistory;
window.closeRecommendationHistory = closeRecommendationHistory;

// Periodic server status check (every 60s)
var _serverPollTimer = null;
function startServerPoll() {
  if (_serverPollTimer) clearInterval(_serverPollTimer);
  _serverPollTimer = setInterval(function() {
    checkServerStatus();
  }, 60000);
}

// -- Start --
document.addEventListener('DOMContentLoaded', function() {
  initApp();
  startServerPoll();
});
