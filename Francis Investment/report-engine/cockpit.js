/**
 * Autonomy Cockpit — v3.4.5
 * 30-second polling dashboard for autonomous trading status.
 *
 * Design principle: "可监督状态" (supervisable status) — not pretty cards.
 * Every metric shows sample counts. Every restriction shows the reason why.
 * Red/Yellow/Green/Gray color coding on all status.
 */

var API = '/api/cockpit';
var POLL_INTERVAL = 30000;
var pollTimer = null;

(function init() {
  setConnectionStatus('CONNECTING', 'info');
  fetchData();
  pollTimer = setInterval(fetchData, POLL_INTERVAL);
})();

function fetchData() {
  fetch(API)
    .then(function(res) {
      if (!res.ok) {
        throw new Error('HTTP ' + res.status + ' ' + res.statusText);
      }
      return res.json();
    })
    .then(function(data) {
      if (data && data.ok) {
        setConnectionStatus('OK', 'ok');
        document.getElementById('last-update').textContent =
          new Date().toLocaleTimeString('zh-CN', { hour12: false });
        if (data.serverStartTime) {
          var uptime = calcUptime(data.serverStartTime);
          document.getElementById('server-uptime').textContent = 'up ' + uptime;
        }
        renderAll(data);
      } else {
        setConnectionStatus('ERROR', 'error');
        var reason = (data && data.version) ? 'Service v' + data.version + ' returned ok=false' : 'API returned ok=false';
        renderAllError(reason);
      }
    })
    .catch(function(err) {
      setConnectionStatus('ERROR', 'error');
      var msg = err && err.message ? err.message : 'Network error / server unreachable';
      renderAllError(msg);
    });
}

function calcUptime(startTime) {
  var start = new Date(startTime).getTime();
  var now = Date.now();
  var diff = Math.floor((now - start) / 1000);
  var d = Math.floor(diff / 86400);
  var h = Math.floor((diff % 86400) / 3600);
  var m = Math.floor((diff % 3600) / 60);
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

function setConnectionStatus(text, cls) {
  var el = document.getElementById('connection-status');
  el.textContent = text;
  el.className = 'badge ' + cls;
}

// ══════ Render All ══════

// ══════ Why Not Buying Banner (v3.4.0) ══════
// Top-level decision summary — shows WHY the system isn't buying
// before any detailed panels. Unified kernel verdict.

function renderWhyNotBuying(perms, pipelineSummary) {
  var el = document.getElementById('wnb-body');
  if (!el) return;

  if (!perms) {
    el.innerHTML = '<div class="wnb-loading">Decision data not available</div>';
    return;
  }

  var isBlock = perms.verdict === 'BLOCK';
  var isReduce = perms.verdict === 'REDUCE';
  var hasCaveats = perms.verdict === 'CAUTIOUS';
  var isAllow = perms.verdict === 'ALLOW';
  var reasons = perms.reasons || [];
  // v3.4.1: Show all active blocker gates (P1-1)
  var activeBlockers = perms.allActiveBlockers || [];
  var primaryBlocker = perms.primaryBlocker || null;
  var marketClosed = perms.marketClosed || false;

  var html = '';
  var bannerClass = isBlock ? 'wnb-block' : (isReduce ? 'wnb-reduce' : (hasCaveats ? 'wnb-cautious' : 'wnb-clear'));

  if (isBlock) {
    html += '<div class="wnb-header ' + bannerClass + '">';
    html += '<span class="wnb-icon">&#9888;</span>';
    // v3.4.1: Show marketClosed label or generic BLOCK
    if (marketClosed) {
      html += '<span class="wnb-title">离市 — 等待下个交易窗口</span>';
    } else if (primaryBlocker === 'marketClosed') {
      html += '<span class="wnb-title">离市 — 等待下个交易窗口</span>';
    } else {
      html += '<span class="wnb-title">系统当前不买入</span>';
    }
    html += '<span class="wnb-verdict">(BLOCK)</span>';
    html += '</div>';

    // v3.4.1: Show all active blockers as a matrix (P1-1)
    if (activeBlockers.length > 0) {
      html += '<div class="wnb-gates-matrix">';
      for (var g = 0; g < activeBlockers.length; g++) {
        var gb = activeBlockers[g];
        var gbClass = gb.status === 'block' ? 'gate-block' : (gb.status === 'reduce' ? 'gate-reduce' : 'gate-cautious');
        html += '<span class="wnb-gate-tag ' + gbClass + '">' + esc(gb.label) + '</span>';
      }
      html += '</div>';
    }

    html += '<ul class="wnb-reasons">';
    if (reasons.length > 0) {
      for (var i = 0; i < Math.min(5, reasons.length); i++) {
        html += '<li>' + esc(reasons[i]) + '</li>';
      }
    } else if (activeBlockers.length > 0) {
      // Show gate details as reasons when no displayReasons
      for (var ag = 0; ag < activeBlockers.length; ag++) {
        html += '<li>' + esc(activeBlockers[ag].detail || activeBlockers[ag].label) + '</li>';
      }
    }
    if (perms.maxBuysPerDay != null) {
      html += '<li>每日最大买入: <strong>' + perms.maxBuysPerDay + '</strong></li>';
    }
    html += '</ul>';
  } else if (isReduce) {
    html += '<div class="wnb-header ' + bannerClass + '">';
    html += '<span class="wnb-icon">&#9888;</span>';
    html += '<span class="wnb-title">仅允许卖出，禁止买入</span>';
    html += '<span class="wnb-verdict">(REDUCE)</span>';
    html += '</div>';
    if (activeBlockers.length > 0) {
      html += '<div class="wnb-gates-matrix">';
      for (var gr = 0; gr < activeBlockers.length; gr++) {
        var grb = activeBlockers[gr];
        var grbClass = grb.status === 'block' ? 'gate-block' : (grb.status === 'reduce' ? 'gate-reduce' : 'gate-cautious');
        html += '<span class="wnb-gate-tag ' + grbClass + '">' + esc(grb.label) + '</span>';
      }
      html += '</div>';
    }
    if (reasons.length > 0) {
      html += '<ul class="wnb-reasons">';
      for (var j = 0; j < Math.min(5, reasons.length); j++) {
        html += '<li>' + esc(reasons[j]) + '</li>';
      }
      html += '</ul>';
    }
  } else if (hasCaveats) {
    html += '<div class="wnb-header ' + bannerClass + '">';
    html += '<span class="wnb-icon">&#9888;</span>';
    html += '<span class="wnb-title">谨慎交易模式</span>';
    html += '<span class="wnb-verdict">(CAUTIOUS)</span>';
    html += '</div>';
    if (activeBlockers.length > 0) {
      html += '<div class="wnb-gates-matrix">';
      for (var gc = 0; gc < activeBlockers.length; gc++) {
        var gcb = activeBlockers[gc];
        var gcbClass = gcb.status === 'block' ? 'gate-block' : (gcb.status === 'reduce' ? 'gate-reduce' : 'gate-cautious');
        html += '<span class="wnb-gate-tag ' + gcbClass + '">' + esc(gcb.label) + '</span>';
      }
      html += '</div>';
    }
    if (reasons.length > 0) {
      html += '<ul class="wnb-reasons">';
      for (var k = 0; k < reasons.length; k++) {
        html += '<li>' + esc(reasons[k]) + '</li>';
      }
      html += '</ul>';
    }
  } else {
    html += '<div class="wnb-header ' + bannerClass + '">';
    html += '<span class="wnb-icon">&#10003;</span>';
    html += '<span class="wnb-title">系统正常，允许交易</span>';
    html += '</div>';
  }

  // v3.4.0: Pipeline funnel display (if data available)
  if (pipelineSummary) {
    html += '<div class="wnb-funnel">Pipeline: ';
    html += '<strong>' + esc(pipelineSummary.totalStocks || '?') + '</strong> total' + ' → ';
    html += '<strong>' + esc(pipelineSummary.candidates || '?') + '</strong> candidates' + ' → ';
    html += '<strong>' + esc(pipelineSummary.analyzed || '?') + '</strong> analyzed';
    if (pipelineSummary.topScore != null) {
      html += ' → top score <strong>' + pipelineSummary.topScore + '</strong>';
    }
    html += '</div>';
  }

  el.innerHTML = html;
}

function renderAll(data) {
  renderWhyNotBuying(data.permissions, data.pipelineSummary);
  renderSystemStatus(data);
  renderApiHealth(data);
  renderDataFiles(data.dataFiles);
  renderPredictionCapability(data);
  renderShadowBaseline(data);
  renderLeakageAudit(data.leakageAudit);
  renderPermissions(data.permissions);
  renderTasks(data.tasks);
  renderVerification(data.verification);
  renderCalibration(data.calibration);
  renderChangeLog(data.changeLog);
  renderFailures(data.failures);
  // v3.4.8: Fetch prediction settlement data
  fetchPredictionSettlement();
  // v3.4.9.4: Fetch cohort integrity data
  fetchCohortIntegrity();
  // P1-UI: Render Research Lab from cockpit data
  renderResearchLab(data.researchLab);
}

/**
 * Fill ALL panels with error state — prevents perpetual "Loading..." spinners.
 */
function renderAllError(msg) {
  var panelIds = [
    'wnb-body', 'api-health-body', 'data-files-body', 'prediction-body',
    'shadow-baseline-body', 'leakage-body', 'permissions-body',
    'tasks-body', 'verify-body', 'prediction-settlement-body', 'calibration-body',
    'changelog-body', 'failures-body', 'cohort-integrity-body', 'research-lab-body'
  ];
  var errorHtml = '<div class="status-error" style="padding:12px;font-size:13px;">'
    + esc(msg) + '</div>';
  for (var i = 0; i < panelIds.length; i++) {
    var el = document.getElementById(panelIds[i]);
    if (el) el.innerHTML = errorHtml;
  }
  // Also update system panel with error detail
  var sysEl = document.getElementById('system-body');
  if (sysEl) {
    sysEl.innerHTML = '<div class="status-error" style="padding:8px;font-size:13px;">'
      + esc(msg) + '</div>';
  }
}

// ══════ Box A: System Status ══════

function renderSystemStatus(data) {
  var el = document.getElementById('system-body');
  var html = '';

  // Version — v3.4.9.3: show precise patch + build identity
  var version = data.systemVersion || 'v3.4.5';
  var buildId = data.buildCommit ? data.buildCommit.slice(0, 7) : (data.buildTimestamp || '');
  var versionDisplay = version;
  if (buildId) versionDisplay = version + '-' + buildId;
  html += '<div class="sys-row">' +
    '<span class="sys-label">Version</span>' +
    '<span class="sys-value" title="' + esc(data.buildCommit || '') + '">' + esc(versionDisplay) + '</span>' +
    '</div>';

  // v3.4.9.4.2: Phase 0 — deploy identity row showing manifest validity + status
  var identityLabel = {matched:'✅ Matched', mismatch:'⚠️ Mismatch', git_only:'💻 Git only', manifest_only:'☁️ Manifest', manifest_missing:'❌ Missing'}[data.identityStatus] || 'Unknown';
  var identityColor = data.identityStatus === 'matched' ? '#16a34a' : data.identityStatus === 'manifest_only' ? '#2563eb' : data.identityStatus === 'mismatch' ? '#dc2626' : '#94a3b8';
  html += '<div class="sys-row">' +
    '<span class="sys-label">Deploy ID</span>' +
    '<span class="sys-value" style="color:' + identityColor + ';font-size:11px;" title="git: ' + esc(data.gitCommit || 'none') + ' | deploy: ' + esc(data.deployCommit || 'none') + ' | files: ' + (data.deployFileHashCount || 0) + '">' +
    esc(data.deployCommit ? data.deployCommit.slice(0, 7) : '—') + ' · ' + identityLabel + '</span>' +
    '</div>';

  // Server start time
  if (data.serverStartTime) {
    html += '<div class="sys-row">' +
      '<span class="sys-label">Started</span>' +
      '<span class="sys-value">' + esc(data.serverStartTime) + '</span>' +
      '</div>';
  }

  // Code vs runtime version check
  if (data.codeVersionMismatch) {
    html += '<div class="sys-warning">WARNING: Code version ' +
      esc(data.codeVersion) + ' != Runtime version ' + esc(data.serverVersion) +
      '. Service may not have loaded latest code.</div>';
  }

  // Scheduler state
  var schedState = (data.tasks && data.tasks.length > 0) ? 'active' : 'idle';
  var schedClass = schedState === 'active' ? 'status-ok' : 'status-warn';
  html += '<div class="sys-row">' +
    '<span class="sys-label">Scheduler</span>' +
    '<span class="status-light ' + schedClass + '">' + schedState + '</span>' +
    '</div>';

  // Last deploy/restart time
  if (data.lastRestartTime) {
    html += '<div class="sys-row">' +
      '<span class="sys-label">Last Restart</span>' +
      '<span class="sys-value">' + esc(data.lastRestartTime) + '</span>' +
      '</div>';
  }

  el.innerHTML = html;
}

// ══════ Box B: API Health ══════

function renderApiHealth(data) {
  var el = document.getElementById('api-health-body');
  var html = '';

  var apis = [
    { name: '/api/cockpit', key: 'cockpit' },
    { name: '/api/model-registry/status', key: 'modelRegistry' },
    { name: '/api/evolution/walk-forward-report', key: 'walkForward' },
    { name: '/api/verification/leakage-audit', key: 'leakageAudit' },
    { name: '/api/verification/dashboard', key: 'verificationDashboard' },
    { name: '/api/verification/calibration', key: 'calibration' },
    { name: '/api/verification/ic-breakdown', key: 'icBreakdown' },
  ];

  var apiHealth = data.apiHealth || {};
  for (var i = 0; i < apis.length; i++) {
    var a = apis[i];
    var stat = apiHealth[a.key] || { status: 'UNKNOWN' };
    var statusClass = stat.status === 'OK' ? 'status-ok'
      : stat.status === 'ERROR' ? 'status-error'
      : stat.status === 'DATA_MISSING' ? 'status-warn'
      : 'status-gray';
    var label = stat.status === 'DATA_MISSING' ? 'NO DATA' : stat.status;
    html += '<div class="api-row">' +
      '<span class="api-name">' + esc(a.name) + '</span>' +
      '<span class="status-light ' + statusClass + '">' + esc(label) + '</span>' +
      '</div>';
  }

  el.innerHTML = html;
}

// ══════ Box C: Data Files ══════

function renderDataFiles(dataFiles) {
  var el = document.getElementById('data-files-body');
  if (!dataFiles || dataFiles.length === 0) {
    el.innerHTML = '<div class="loading">No data file info</div>';
    return;
  }

  var html = '<table class="file-table"><thead><tr>' +
    '<th>File</th><th>Status</th><th>Updated</th><th>Size</th>' +
    '</tr></thead><tbody>';

  for (var i = 0; i < dataFiles.length; i++) {
    var f = dataFiles[i];
    var statusClass = f.exists ? (f.expired ? 'status-warn' : 'status-ok') : 'status-error';
    var statusLabel = f.exists ? (f.expired ? 'STALE' : 'OK') : 'MISSING';
    html += '<tr>' +
      '<td class="file-name">' + esc(f.name) + '</td>' +
      '<td><span class="status-light ' + statusClass + '">' + statusLabel + '</span></td>' +
      '<td class="file-time">' + (f.updated || '--') + '</td>' +
      '<td class="file-size">' + (f.size || '--') + '</td>' +
      '</tr>';
  }

  html += '</tbody></table>';
  el.innerHTML = html;
}

// ══════ Panel 1: Prediction Capability ══════

function renderPredictionCapability(data) {
  var el = document.getElementById('prediction-body');
  var icd = data.icDecomposition;
  var verif = data.verification;

  // No IC decomposition? Show what we DO have (verification summary fallback)
  if (!icd || !icd.available) {
    var msg = (icd && icd.message) ? esc(icd.message) : 'Walk-forward 报告尚未生成 (需运行 bootstrap --split)';
    var html = '<div class="loading">IC Decomposition: ' + msg + '</div>';

    // Fallback: show verification summary data if available
    if (verif && !verif.error && verif.overallHitRate != null) {
      html += '<div class="metric-section"><h3>Verification Summary (fallback)</h3>';
      html += '<div class="metric-group">';
      html += '<div class="metric-row"><span>Overall Hit Rate</span><span>' + verif.overallHitRate + '% (' + (verif.totalPredictions || 0) + ' samples)</span></div>';
      if (verif.rankIC != null) {
        html += '<div class="metric-row"><span>Rank IC</span><span>' + verif.rankIC.toFixed(3) + '</span></div>';
      }
      html += '</div></div>';
    } else if (verif && verif.error) {
      html += '<div class="metric-row status-error">Verification: ' + esc(verif.error) + '</div>';
    }
    el.innerHTML = html;
    return;
  }

  var html = '';

  // ── Rank IC Row (Spearman) ──
  html += '<div class="metric-section"><h3>Rank IC (Spearman Correlation)</h3>';
  html += '<div class="metric-group">';
  html += icMetric('Train', icd.trainingIC, icd.trainingICSamples, 'ic-train');
  html += icMetric('Validation', icd.validationIC, icd.validationICSamples, 'ic-valid');
  html += icMetric('Forward', icd.forwardIC, icd.forwardSamples, 'ic-forward');
  html += '</div></div>';

  // ── Direction Hit Rate Row (NOT the same as Rank IC) ──
  html += '<div class="metric-section"><h3>Direction Hit Rate</h3>';
  html += '<div class="metric-group">';
  html += icMetric('Train', icd.trainingHitRate, icd.trainingHitSamples, 'hr-train');
  html += icMetric('Validation', icd.validationHitRate, icd.validationHitSamples, 'hr-valid');
  html += icMetric('Forward', icd.forwardHitRate, icd.forwardHitSamples, 'hr-forward');
  html += '</div></div>';

  // Overfit Ratio
  if (icd.overfitRatio != null) {
    var ofrClass = icd.overfitRatio > 0.3 ? 'metric-bad' : icd.overfitRatio > 0.15 ? 'metric-warn' : 'metric-good';
    html += '<div class="metric-row">' +
      '<span>Overfit Ratio</span>' +
      '<span class="' + ofrClass + '">' + (icd.overfitRatio * 100).toFixed(1) + '%</span>' +
      '</div>';
  }

  // IC Stability
  if (icd.icStability != null) {
    var stabClass = icd.icStability < 0.15 ? 'metric-good' : icd.icStability < 0.25 ? 'metric-warn' : 'metric-bad';
    html += '<div class="metric-row">' +
      '<span>IC Stability (30d std)</span>' +
      '<span class="' + stabClass + '">' + icd.icStability.toFixed(4) + '</span>' +
      '</div>';
  }

  // Verdict
  if (icd.verdict) {
    var vLabel = icd.verdict.replace(/_/g, ' ');
    var vClass = (icd.verdict === 'stable' || icd.verdict === 'generalizing') ? 'verdict-ok'
      : icd.verdict === 'moderate_decay' ? 'verdict-warn' : 'verdict-bad';
    html += '<div class="verdict ' + vClass + '">' + esc(vLabel) + '</div>';
  }
  if (icd.recommendation) {
    html += '<div class="recommendation">' + esc(icd.recommendation) + '</div>';
  }

  el.innerHTML = html;
}

function icMetric(label, value, samples, cls) {
  var display = value != null ? (typeof value === 'number' ? value.toFixed(3) : value) : '--';
  var sampText = samples != null ? ' (' + samples + ' samples)' : '';
  if (label === 'Train' && cls.indexOf('hr-') === 0 && typeof value === 'number') {
    display = value.toFixed(1) + '%';
  } else if (label !== 'Train' && cls.indexOf('hr-') === 0 && typeof value === 'number') {
    display = value.toFixed(1) + '%';
  }
  return '<span class="ic-metric ' + cls + '">' +
    '<span class="ic-label">' + label + '</span>' +
    '<span class="ic-value">' + display + '</span>' +
    '<span class="ic-samples">' + sampText + '</span>' +
    '</span>';
}

// ══════ Panel 2: Shadow / Baseline ══════

function renderShadowBaseline(data) {
  var el = document.getElementById('shadow-baseline-body');
  var models = data.models;
  var st = data.shadowTracking;

  var html = '';

  // Baseline Section
  html += '<div class="baseline-section">';
  html += '<h3>Baseline</h3>';
  if (models && models.baseline) {
    var c = models.baseline;
    html += '<div class="champ-card">' +
      '<div class="champ-id">' + esc(c.versionId) + ' <span class="champ-source">[' + esc(c.source || 'unknown') + ']</span></div>';
    if (c.params && Object.keys(c.params).length > 0) {
      html += '<div class="champ-params">Params: ' + esc(JSON.stringify(c.params)) + '</div>';
    }
    html += '<div class="champ-metrics">' +
      '<span>Cumulative IC: <strong>' + (c.cumulativeIC != null ? c.cumulativeIC.toFixed(3) : '?') + '</strong></span>' +
      '<span>Eval Days: ' + (c.evaluationDays || 0) + '</span>' +
      '<span>Promoted: ' + (c.promotedAt ? c.promotedAt.slice(0, 10) : '--') + '</span>' +
      '</div></div>';
  } else {
    html += '<div class="no-data">No baseline yet</div>';
  }
  html += '</div>';

  // Shadows Section
  html += '<div class="shadows-section">';
  html += '<h3>Shadows (' + (st && st.shadows ? st.shadows.length : 0) + ')</h3>';

  if (st && st.shadows && st.shadows.length > 0) {
    for (var i = 0; i < st.shadows.length; i++) {
      var s = st.shadows[i];
      var readyClass = s.meetsPromotionCriteria ? 'shadow-ready' : 'shadow-waiting';
      var readyLabel = s.meetsPromotionCriteria ? 'READY' : 'WAITING';

      html += '<div class="shadow-card ' + readyClass + '">' +
        '<div class="shadow-header">' +
        '<span class="shadow-id">' + esc(s.versionId) + '</span>' +
        '<span class="shadow-badge ' + readyClass + '">' + readyLabel + '</span>' +
        '</div>' +
        '<div class="shadow-stats">' +
        '<div><span>Registered:</span> ' + (s.registeredAt ? s.registeredAt.slice(0, 10) : '--') + '</div>' +
        '<div><span>Forward Samples:</span> <strong>' + (s.forwardSamples || 0) + '</strong></div>' +
        '<div><span>Direction Hit Rate:</span> <strong>' + (s.directionHitRate != null ? (s.directionHitRate * 100).toFixed(1) + '%' : '?') + '</strong></div>' +
        '<div><span>Current IC:</span> ' + (s.cumulativeIC != null ? s.cumulativeIC.toFixed(3) : '?') + '</div>' +
        '<div><span>Evaluation Days:</span> ' + (s.evaluationDays || 0) + '</div>' +
        '</div>';

      // Failing checks (WHY not promoted)
      if (s.failingChecks && s.failingChecks.length > 0) {
        html += '<div class="shadow-failing">';
        for (var j = 0; j < s.failingChecks.length; j++) {
          var reason = explainFailingCheck(s.failingChecks[j]);
          html += '<div class="fail-reason">' + esc(reason) + '</div>';
        }
        html += '</div>';
      }

      html += '</div>';
    }
  } else {
    html += '<div class="no-data">No shadow models registered</div>';
  }
  html += '</div>';

  el.innerHTML = html;
}

function explainFailingCheck(check) {
  switch (check) {
    case 'icExcess': return 'Rank IC not exceeding baseline';
    case 'directionHitRate(>52%)': return 'Direction hit rate below 52%';
    case 'postCostPositive': return 'Post-cost return not positive';
    case 'drawdownNotWorse': return 'Max drawdown worse than baseline';
    case 'forwardSamples(≥100)': return 'Forward samples < 100';
    case 'calibrationCheck': return 'Confidence calibration not verified';
    case 'evaluationDays(≥5)': return 'Evaluation days < 5';
    case 'leakageAuditNotClean': return 'Data leakage audit not CLEAN';
    default: return check;
  }
}

// ══════ Panel 3: Leakage Audit ══════

function renderLeakageAudit(audit) {
  var el = document.getElementById('leakage-body');
  if (!audit) {
    el.innerHTML = '<div class="loading">Leakage audit not yet run</div>';
    return;
  }

  var verdictClass = audit.verdict === 'CLEAN' ? 'verdict-ok'
    : audit.verdict === 'MINOR_ISSUES' ? 'verdict-warn'
    : audit.verdict === 'NO_SAMPLES' || audit.verdict === 'INSUFFICIENT_DATA' ? 'verdict-info'
    : 'verdict-bad';

  var html = '';
  html += '<div class="verdict ' + verdictClass + '" style="font-size:16px;">' + esc(audit.verdict || 'UNKNOWN') + '</div>';

  html += '<div class="audit-stats">' +
    '<div class="audit-row"><span>Total Checks</span><span>' + (audit.totalChecks || 0) + '</span></div>';

  if (audit.checks) {
    var temporal = audit.checks.temporalOrder || {};
    var future = audit.checks.futureKlineData || {};
    var horizon = audit.checks.horizonIntegrity || {};

    html += '<div class="audit-row">' +
      '<span>Temporal Order</span>' +
      '<span class="' + (temporal.passed ? 'metric-good' : 'metric-bad') + '">' +
      (temporal.violations || 0) + ' violations</span></div>';

    html += '<div class="audit-row">' +
      '<span>Future Kline Data</span>' +
      '<span class="' + (future.passed ? 'metric-good' : 'metric-bad') + '">' +
      (future.violations || 0) + ' violations</span></div>';

    html += '<div class="audit-row">' +
      '<span>Horizon Integrity</span>' +
      '<span class="' + (horizon.passed ? 'metric-good' : 'metric-bad') + '">' +
      (horizon.violations || 0) + ' violations</span></div>';
  }

  html += '</div>';

  // Recent issues
  if (audit.leakageDetails && audit.leakageDetails.length > 0) {
    html += '<div class="leakage-details"><h4>Recent Issues</h4>';
    for (var i = 0; i < Math.min(audit.leakageDetails.length, 5); i++) {
      var d = audit.leakageDetails[i];
      var sevClass = d.severity === 'critical' ? 'metric-bad' : d.severity === 'high' ? 'metric-warn' : 'status-warn';
      html += '<div class="leakage-item">' +
        '<span class="' + sevClass + '">[' + (d.severity || 'medium') + ']</span> ' +
        esc(d.code || '?') + ' ' + esc(d.predictionDate) + ' -> ' + esc(d.targetDate) +
        ': ' + (d.violations || []).join(', ') +
        '</div>';
    }
    html += '</div>';
  }

  if (audit.note) {
    html += '<div class="audit-note">' + esc(audit.note) + '</div>';
  }

  el.innerHTML = html;
}

// ══════ Panel 4: Trading Permissions (with reasons) ══════

function renderPermissions(perms) {
  var el = document.getElementById('permissions-body');
  if (!perms) {
    el.innerHTML = '<div class="loading">Not available</div>';
    return;
  }

  var html = '';

  // Verdict
  var verdict = perms.verdict || 'ALLOW';
  var verdictClass = verdict === 'ALLOW' ? 'verdict-ok'
    : verdict === 'CAUTIOUS' ? 'verdict-warn'
    : 'verdict-bad';
  html += '<div class="verdict ' + verdictClass + '" style="font-size:18px; text-align:center; margin-bottom:10px;">' +
    esc(verdict) + '</div>';

  html += '<div class="perm-detail">';

  // Why this verdict?
  html += '<h4>Why ' + esc(verdict) + '?</h4>';

  // Data quality
  html += '<div class="perm-reason">' +
    '<span class="perm-label">Data Quality</span>' +
    '<span class="' + (perms.dataQualityOk ? 'metric-good' : 'metric-warn') + '">' +
    (perms.dataQualityOk ? 'PASS' : 'FAIL') + '</span></div>';

  // Strategy health
  html += '<div class="perm-reason">' +
    '<span class="perm-label">Strategy Health</span>' +
    '<span class="' + (perms.strategyHealthOk ? 'metric-good' : 'metric-warn') + '">' +
    (perms.strategyHealthOk ? 'PASS' : 'FAIL') + '</span></div>';

  // Rank IC positive?
  html += '<div class="perm-reason">' +
    '<span class="perm-label">Forward Rank IC</span>' +
    '<span class="' + (perms.rankICPositive ? 'metric-good' : 'metric-bad') + '">' +
    (perms.rankICPositive ? 'POSITIVE' : 'NEGATIVE') + '</span></div>';

  // Recent win rate
  html += '<div class="perm-reason">' +
    '<span class="perm-label">Recent Win Rate</span>' +
    '<span class="' + (perms.winRateRecovering ? 'metric-good' : 'metric-warn') + '">' +
    (perms.winRateRecovering ? 'RECOVERING' : 'LOW') + '</span></div>';

  // Drawdown
  html += '<div class="perm-reason">' +
    '<span class="perm-label">Drawdown</span>' +
    '<span class="' + (perms.drawdownNarrowing ? 'metric-good' : 'metric-warn') + '">' +
    (perms.drawdownNarrowing ? 'NARROWING' : 'ACTIVE') + '</span></div>';

  // Leakage audit (v3.4.0 — permissive→strict)
  var leakageLabel, leakageClass;
  if (perms.leakageAuditClean) {
    leakageLabel = 'CLEAN';
    leakageClass = 'metric-good';
  } else if (perms.leakageAuditCaution) {
    leakageLabel = 'MINOR_ISSUES';
    leakageClass = 'metric-warn';
  } else if (perms.leakageAuditVerdict === 'NO_SAMPLES' || perms.leakageAuditVerdict === 'INSUFFICIENT_DATA') {
    leakageLabel = 'NO_SAMPLES';
    leakageClass = 'metric-bad';
  } else {
    leakageLabel = perms.leakageAuditVerdict || 'DIRTY';
    leakageClass = 'metric-bad';
  }
  html += '<div class="perm-reason">' +
    '<span class="perm-label">Data Leakage</span>' +
    '<span class="' + leakageClass + '">' +
    leakageLabel + ' (' + (perms.leakageAuditChecks || 0) + ' checks)</span></div>';

  // Current positions
  html += '<div class="perm-reason">' +
    '<span class="perm-label">Current Holdings</span>' +
    '<span>' + (perms.hasPositions ? 'YES (' + (perms.positionCount || 0) + ')' : 'NONE') + '</span></div>';

  // v3.4.8: Market Validation row (v3.4.9: add quoteAge differentiation)
  if (perms.marketValidation) {
    var mv = perms.marketValidation;
    html += '<h4 style="margin-top:12px;">Market Validation</h4>';

    // v3.4.9: Distinguish "行情过期" vs "核心指数不足" vs "市场风险"
    // v3.4.9.2: Trust backend marketData.status — backend sets 'not_applicable' for non-trading
    var quoteAge = mv.quoteAge;
    var quoteStale = mv.quoteStale;
    var coreInsufficient = mv.validCoreCount < 2;
    var mvStatusLabel = '';
    var mvStatusClass = 'metric-good';
    if (mv.status === 'not_applicable') {
      mvStatusLabel = '非交易时段 (N/A)';
      mvStatusClass = 'metric-good';
    } else if (quoteStale && coreInsufficient) {
      mvStatusLabel = '行情过期(' + quoteAge + 's) + 核心不足(' + mv.validCoreCount + '/3)';
      mvStatusClass = 'metric-bad';
    } else if (quoteStale) {
      mvStatusLabel = '行情过期(' + quoteAge + 's) — 超过5分钟';
      mvStatusClass = 'metric-warn';
    } else if (coreInsufficient) {
      mvStatusLabel = '核心指数不足(' + mv.validCoreCount + '/3)';
      mvStatusClass = 'metric-bad';
    } else {
      mvStatusLabel = '数据正常 (' + mv.validCoreCount + '/3)';
    }

    html += '<div class="perm-reason">' +
      '<span class="perm-label">Status</span>' +
      '<span class="' + mvStatusClass + '">' + mvStatusLabel + '</span></div>';
    html += '<div class="perm-reason">' +
      '<span class="perm-label">Source</span>' +
      '<span>' + esc(mv.sourceChain || 'unknown') + '</span></div>';
    html += '<div class="perm-reason">' +
      '<span class="perm-label">Last Quote</span><span>' + (mv.lastValidQuoteAt ? fmtTime(mv.lastValidQuoteAt) : 'never') +
      (quoteAge != null ? ' (' + quoteAge + 's ago)' : '') + '</span></div>';
    if (mv.description) {
      html += '<div class="perm-reason">' +
        '<span class="perm-label">Reason</span><span style="font-size:11px;">' + esc(mv.description) + '</span></div>';
    }
  }

  html += '</div>';

  // Gate states
  if (perms.gates) {
    html += '<div class="perm-gates">';
    html += '<div class="gate-row">' +
      '<span>Drawdown Gate</span>' +
      '<span class="' + (perms.gates.drawdownActive ? 'metric-bad' : 'metric-good') + '">' +
      (perms.gates.drawdownActive ? 'ACTIVE' : 'OK') + '</span></div>';
    html += '<div class="gate-row">' +
      '<span>Market Gate</span>' +
      '<span class="' + (perms.gates.marketGateActive ? 'metric-warn' : 'metric-good') + '">' +
      (perms.gates.marketGateActive ? 'ACTIVE' : 'OK') + '</span></div>';
    html += '<div class="gate-row">' +
      '<span>Circuit Breaker</span>' +
      '<span class="' + (perms.gates.circuitBreakerActive ? 'metric-bad' : 'metric-good') + '">' +
      (perms.gates.circuitBreakerActive ? 'ACTIVE' : 'OK') + '</span></div>';
    html += '</div>';
  }

  if (perms.maxBuysPerDay != null) {
    html += '<div class="perm-buys">Max Buys/Day: <strong>' + perms.maxBuysPerDay + '</strong></div>';
  }

  if (perms.reasons && perms.reasons.length > 0) {
    html += '<div class="perm-reasons-list">';
    for (var i = 0; i < perms.reasons.length; i++) {
      html += '<div class="reason-item">' + esc(perms.reasons[i]) + '</div>';
    }
    html += '</div>';
  }

  el.innerHTML = html;
}

// ══════ Panel 5: Today's Tasks ══════

function renderTasks(tasks) {
  var el = document.getElementById('tasks-body');
  if (!tasks || tasks.length === 0) {
    el.innerHTML = '<div class="no-data">No task data</div>';
    return;
  }

  var html = '';
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    var statusClass = t.status === 'ok' ? 'task-ok'
      : t.status === 'waiting' ? 'task-waiting'
      : t.status === 'running' ? 'task-running'
      : 'task-failed';
    var statusLabel = t.status === 'ok' ? 'OK'
      : t.status === 'waiting' ? 'WAIT'
      : t.status === 'running' ? 'RUN'
      : 'FAIL';
    html += '<div class="task-item">' +
      '<span class="task-name">' + esc(t.name) + '</span>' +
      '<span class="task-status ' + statusClass + '">' + statusLabel + '</span>' +
      '</div>';
  }
  el.innerHTML = html;
}

// ══════ Panel 6: Verification Summary ══════

function renderVerification(verif) {
  var el = document.getElementById('verify-body');
  if (!verif) {
    el.innerHTML = '<div class="loading">Not available</div>';
    return;
  }

  var html = '';

  // v3.4.8: Check independent days threshold
  // Note: verification_summary.json has the canonical overall.rankIC.independentDays
  // but the cockpit API may not include it. We check the verifiedData passed in.
  var indDays = (verif.overall && verif.overall.rankIC && verif.overall.rankIC.independentDays) || 0;
  var dataInsufficient = indDays < 20;

  if (dataInsufficient) {
    html += '<div class="data-insufficient" style="text-align:center;padding:16px;color:#94a3b8;">' +
      '<div style="font-size:28px;margin-bottom:8px;">&#9888;</div>' +
      '<div style="font-size:14px;font-weight:600;margin-bottom:4px;">积累中，不构成预测证据</div>' +
      '<div style="font-size:12px;">独立交易日: ' + indDays + '/20（需≥20天才可统计推断）</div>' +
      '</div>';
  } else {
    // Rank IC with CI
    var rankIC = (verif.overall && verif.overall.rankIC) ? verif.overall.rankIC : null;
    var ciLo = rankIC ? rankIC.ci_lower : null;
    var ciHi = rankIC ? rankIC.ci_upper : null;
    var icMean = rankIC ? rankIC.mean : (verif.rankIC != null ? verif.rankIC : null);

    html += '<div class="metric-row">' +
      '<span>Independent Days</span>' +
      '<span class="' + (indDays >= 20 ? 'metric-good' : 'metric-warn') + '">' +
      indDays + ' / 20' + '</span></div>';

    html += '<div class="metric-row">' +
      '<span>Rank IC</span>' +
      '<span class="' + (icMean > 0.1 ? 'metric-good' : icMean > 0 ? 'metric-warn' : 'metric-bad') + '">' +
      (icMean != null ? icMean.toFixed(3) : '?') +
      (ciLo != null && ciHi != null ? ' [' + ciLo.toFixed(3) + ', ' + ciHi.toFixed(3) + ']' : '') +
      '</span></div>';

    var netExcess = (verif.overall && verif.overall.postCostNetExcessReturn != null)
      ? verif.overall.postCostNetExcessReturn : null;
    html += '<div class="metric-row">' +
      '<span>Net Excess Return</span>' +
      '<span class="' + (netExcess > 0 ? 'metric-good' : netExcess != null ? 'metric-warn' : 'metric-bad') + '">' +
      (netExcess != null ? netExcess.toFixed(2) + '%' : 'N/A') + '</span></div>';
  }

  // Keep legacy fields
  html += '<div class="metric-row">' +
    '<span>Overall Hit Rate</span>' +
    '<span class="' + (verif.overallHitRate > 50 ? 'metric-good' : verif.overallHitRate > 40 ? 'metric-warn' : 'metric-bad') + '">' +
    (verif.overallHitRate != null ? verif.overallHitRate.toFixed(1) + '%' : '?') +
    ' (' + (verif.totalPredictions || 0) + ' samples)' +
    '</span></div>';

  if (!dataInsufficient && verif.factors && verif.factors.length > 0) {
    html += '<div class="factor-list"><h4>Factor Detail</h4>';
    for (var i = 0; i < Math.min(verif.factors.length, 5); i++) {
      var f = verif.factors[i];
      html += '<div class="factor-item">' +
        '<span>' + esc(f.id) + '</span>' +
        '<span class="' + (f.verified ? 'metric-good' : 'status-gray') + '">' +
        (f.hitRate != null ? f.hitRate.toFixed(0) + '%' : '?') +
        ' (' + (f.samples || 0) + ' samples)</span></div>';
    }
    html += '</div>';
  }

  html += '<div class="metric-row">' +
    '<span>Data Status</span>' +
    '<span class="' + (verif.dataQuality === '稳定' ? 'metric-good' : verif.dataQuality === '初步可用' ? 'metric-warn' : 'status-gray') + '">' +
    esc(verif.dataQuality || '?') + '</span></div>';

  el.innerHTML = html;
}

// ══════ Panel 6b: Prediction Settlement (v3.4.8) ══════

function fetchPredictionSettlement() {
  fetch('/api/prediction-settlement')
    .then(function(res) { return res.json(); })
    .then(function(data) { renderPredictionSettlement(data); })
    .catch(function(err) {
      var el = document.getElementById('prediction-settlement-body');
      if (el) el.innerHTML = '<div class="loading">' + esc(err.message || 'Network error') + '</div>';
    });
}

function renderPredictionSettlement(data) {
  var el = document.getElementById('prediction-settlement-body');
  if (!data || !data.ok) {
    el.innerHTML = '<div class="loading">' + (data && data.message ? esc(data.message) : 'Not available') + '</div>';
    return;
  }

  var html = '';
  var hasData = data.hasLedger || data.hasOutcome;
  if (!hasData) {
    // v3.4.9: Empty state with specific message
    html += '<div class="no-data" style="padding:16px;text-align:center;color:#94a3b8;">' +
      '<div style="font-size:14px;margin-bottom:4px;">预测采集尚未开始</div>' +
      '<div style="font-size:11px;">等待首个全量扫描产生预测账本</div></div>';
  } else {
    // v3.4.9: RunId display
    if (data.runId) {
      html += '<div style="margin-bottom:8px;font-size:10px;color:#94a3b8;font-family:monospace;">runId: ' + esc(data.runId) + '</div>';
    }

    // v3.4.9: Top row — researchEligible + executionEligible (3-tier)
    html += '<div class="ps-counts" style="display:flex;gap:10px;margin-bottom:10px;">' +
      '<div style="flex:1;text-align:center;padding:8px;background:#f8fafc;border-radius:6px;">' +
      '<div style="font-size:20px;font-weight:700;color:#1e293b;">' + (data.canonicalCohortCount || data.canonicalTop50 || 0) + ' / ' + (data.intradayCount || data.intradayObservationCount || 0) + '</div>' +
      '<div style="font-size:10px;color:#64748b;">Canonical / Intraday</div></div>' +
      '<div style="flex:1;text-align:center;padding:8px;background:#fefce8;border-radius:6px;">' +
      '<div style="font-size:20px;font-weight:700;color:#a16207;">' + (data.researchEligible || 0) + '</div>' +
      '<div style="font-size:10px;color:#64748b;">Research</div></div>' +
      '<div style="flex:1;text-align:center;padding:8px;background:#f0fdf4;border-radius:6px;">' +
      '<div style="font-size:20px;font-weight:700;color:#16a34a;">' + (data.executionEligible || 0) + '</div>' +
      '<div style="font-size:10px;color:#64748b;">Exec</div></div>' +
      '<div style="flex:1;text-align:center;padding:8px;background:#eff6ff;border-radius:6px;">' +
      '<div style="font-size:20px;font-weight:700;color:#2563eb;">' + (data.independentDays || 0) + '</div>' +
      '<div style="font-size:10px;color:#64748b;">Ind.Days</div></div>' +
      '</div>';

    // v3.4.9.4.2: Quarantined count — old-format entries excluded from all cohort stats
    if (data.quarantinedCount > 0) {
      html += '<div style="margin-bottom:8px;padding:6px 10px;background:#fee2e2;border-radius:4px;text-align:center;border:1px solid #fecaca;">' +
        '<span style="font-size:11px;color:#dc2626;font-weight:600;">Quarantined: ' + data.quarantinedCount + '</span>' +
        '<span style="font-size:9px;color:#94a3b8;margin-left:4px;">(old format, excluded from stats)</span></div>';
    }

    // Exclusion reasons
    if (data.exclusionReasons && Object.keys(data.exclusionReasons).length > 0) {
      html += '<div style="margin-bottom:8px;"><span style="font-size:10px;font-weight:600;">Exclusion Reasons</span></div>';
      var reasons = data.exclusionReasons;
      for (var reason in reasons) {
        if (!reasons.hasOwnProperty(reason)) continue;
        var cls = reason === 'none' ? 'metric-good' : (reason === 'evidence_fail' ? 'metric-warn' : 'metric-bad');
        html += '<div class="metric-row">' +
          '<span style="font-size:10px;">' + esc(reason) + '</span>' +
          '<span class="' + cls + '" style="font-size:10px;">' + reasons[reason] + '</span></div>';
      }
    }

    // Settlement stats
    html += '<div style="margin:10px 0 6px 0;border-top:1px solid #e2e8f0;padding-top:8px;">' +
      '<div class="metric-row">' +
      '<span style="font-size:10px;">T+3 Pending</span>' +
      '<span class="' + (data.t3pending > 0 ? 'metric-warn' : 'metric-good') + '" style="font-size:10px;">' + (data.t3pending || 0) + '</span></div>' +
      '<div class="metric-row">' +
      '<span style="font-size:10px;">Settled / Unavail.</span>' +
      '<span style="font-size:10px;">' + (data.settledToday || 0) + ' / ' + (data.unavailableCount || 0) + '</span></div>' +
      '</div>';
  }

  el.innerHTML = html;
}

// ══════ Panel 6c: Research Cohort Integrity (v3.4.9.4) ══════

// ---- P1-UI: Research Lab ----

function renderResearchLab(researchLab) {
  var el = document.getElementById('research-lab-body');
  if (!researchLab) {
    el.innerHTML = '<div class="loading">Research Lab data not available</div>';
    return;
  }

  // P0 status banner
  var statusBg, statusColor;
  if (researchLab.status === 'invalid') {
    statusBg = '#fee2e2'; statusColor = '#dc2626';
  } else if (researchLab.status === 'p0_verified') {
    statusBg = '#fefce8'; statusColor = '#a16207';
  } else {
    statusBg = '#f0fdf4'; statusColor = '#16a34a';
  }

  var html = '';

  // Status banner
  html += '<div style="padding:8px 12px;margin-bottom:10px;background:' + statusBg + ';border-radius:4px;border-left:3px solid ' + statusColor + ';">';
  html += '<span style="font-weight:700;color:' + statusColor + ';font-size:13px;">' + esc(researchLab.statusLabel || 'Unknown') + '</span>';
  if (researchLab.warning) {
    html += '<div style="font-size:11px;color:' + statusColor + ';margin-top:4px;">' + esc(researchLab.warning) + '</div>';
  }
  html += '</div>';

  // Universe info
  html += '<div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;">';
  html += '<div style="flex:1;min-width:80px;text-align:center;padding:6px;background:#f8fafc;border-radius:4px;border:1px solid #e2e8f0;">';
  html += '<div style="font-size:11px;font-weight:600;">' + esc(researchLab.universe.type || '?') + '</div>';
  html += '<div style="font-size:9px;color:#64748b;">Universe</div></div>';

  html += '<div style="flex:1;min-width:80px;text-align:center;padding:6px;background:#f8fafc;border-radius:4px;border:1px solid #e2e8f0;">';
  html += '<div style="font-size:11px;font-weight:600;">' + (researchLab.universe.stableStart || '?') + '</div>';
  html += '<div style="font-size:9px;color:#64748b;">Stable Start</div></div>';

  html += '<div style="flex:1;min-width:80px;text-align:center;padding:6px;background:' + (researchLab.p0Status === 'pass' ? '#f0fdf4' : '#fee2e2') + ';border-radius:4px;border:1px solid #e2e8f0;">';
  html += '<div style="font-size:11px;font-weight:600;color:' + (researchLab.p0Status === 'pass' ? '#16a34a' : '#dc2626') + ';">' + esc(researchLab.p0Status || '?') + '</div>';
  html += '<div style="font-size:9px;color:#64748b;">P0 Status</div></div>';

  html += '<div style="flex:1;min-width:80px;text-align:center;padding:6px;background:#f8fafc;border-radius:4px;border:1px solid #e2e8f0;">';
  html += '<div style="font-size:11px;font-weight:600;">' + (researchLab.validWindows || 0) + '</div>';
  html += '<div style="font-size:9px;color:#64748b;">Valid Windows</div></div>';
  html += '</div>';

  // Portfolio capacity (P0.2)
  if (researchLab.portfolioCapacity) {
    var cap = researchLab.portfolioCapacity;
    html += '<div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;">';
    html += '<div style="flex:1;min-width:80px;text-align:center;padding:4px;background:#f8fafc;border-radius:4px;border:1px solid #e2e8f0;">';
    html += '<div style="font-size:11px;font-weight:600;">' + (cap.topNPerCohort || '?') + '/sleeve × ' + (cap.numSleeves || '?') + '</div>';
    html += '<div style="font-size:9px;color:#64748b;">Max ' + (cap.maxConcurrentPositions || '?') + ' concurrent</div></div>';
    html += '</div>';
  }

  // Feature mask
  var real = researchLab.universe.realFeatures || [];
  var unavail = researchLab.universe.unavailableFeatures || [];
  html += '<div style="margin-bottom:8px;font-size:10px;">';
  html += '<span style="font-weight:600;">Features: </span>';
  for (var i = 0; i < real.length; i++) {
    html += '<span style="background:#dcfce7;color:#16a34a;padding:1px 4px;border-radius:3px;margin-right:3px;">' + esc(real[i]) + '</span>';
  }
  for (var j = 0; j < unavail.length; j++) {
    html += '<span style="background:#fee2e2;color:#dc2626;padding:1px 4px;border-radius:3px;margin-right:3px;">' + esc(unavail[j]) + '</span>';
  }
  html += '</div>';

  // Label convention
  html += '<div style="margin-bottom:8px;font-size:9px;color:#94a3b8;font-family:monospace;">';
  html += 'Label: ' + esc(researchLab.labelConvention || '?') + '</div>';

  // P1 Model info
  if (researchLab.p1Model) {
    html += '<div style="border-top:1px solid #e2e8f0;padding-top:6px;margin-bottom:8px;">';
    html += '<span style="font-weight:600;font-size:11px;">P1: ' + esc(researchLab.p1Model.type) + '</span>';
    html += '<span style="font-size:9px;color:#64748b;margin-left:6px;">features=' + (researchLab.p1Model.features || []).length + '</span>';
    html += '<span style="font-size:9px;color:#64748b;margin-left:6px;">std=' + esc(researchLab.p1Model.standardization || '?') + '</span>';
    html += '</div>';
  }

  // Latest window metrics
  if (researchLab.latestWindow) {
    var lw = researchLab.latestWindow;
    html += '<div style="border-top:1px solid #e2e8f0;padding-top:6px;margin-bottom:6px;">';
    html += '<div style="font-size:10px;font-weight:600;">Latest Valid Window</div>';
    html += '<div style="font-size:9px;color:#64748b;">' + esc(lw.testStart || '?') + ' → ' + esc(lw.testEnd || '?') + ' (' + (lw.testDays || 0) + ' days)</div>';
    html += '<div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap;">';
    html += '<span style="font-size:9px;">λ=' + esc(String(lw.lambda)) + '</span>';
    html += '<span style="font-size:9px;">MSE=' + esc(String(lw.testMSE)) + '</span>';
    html += '<span style="font-size:9px;">RankIC=' + esc(String(lw.avgRankIC)) + '</span>';
    html += '<span style="font-size:9px;">DirAcc=' + esc(String(lw.directionAccuracy)) + '%</span>';
    html += '<span style="font-size:9px;' + ((lw.portfolioNetReturn || 0) > 0 ? 'color:#16a34a;' : 'color:#dc2626;') + '">Net=' + esc(String(lw.portfolioNetReturn)) + '%</span>';
    html += '<span style="font-size:9px;' + ((lw.portfolioGrossReturn || 0) > 0 ? 'color:#16a34a;' : 'color:#dc2626;') + '">Gross=' + esc(String(lw.portfolioGrossReturn)) + '%</span>';
    html += '<span style="font-size:9px;' + ((lw.portfolioNetExcess || 0) > 0 ? 'color:#16a34a;' : 'color:#dc2626;') + '">Excess=' + esc(String(lw.portfolioNetExcess)) + '%</span>';
    html += '</div></div>';
  }

  // Random CI
  if (researchLab.randomCI) {
    html += '<div style="border-top:1px solid #e2e8f0;padding-top:6px;">';
    html += '<span style="font-size:10px;font-weight:600;">Random Baseline CI (95%)</span>';
    html += '<div style="font-size:9px;color:#64748b;">' +
      'mean=' + esc(String(researchLab.randomCI.mean)) +
      ' [' + esc(String(researchLab.randomCI.ci95_lower)) +
      ', ' + esc(String(researchLab.randomCI.ci95_upper)) + ']' +
      ' n=' + esc(String(researchLab.randomCI.samples)) +
      '</div></div>';
  }

  // Model artifacts
  if (researchLab.modelArtifacts && researchLab.modelArtifacts.length > 0) {
    html += '<div style="border-top:1px solid #e2e8f0;padding-top:6px;margin-top:6px;">';
    html += '<div style="font-size:10px;font-weight:600;">Model Artifacts (' + researchLab.modelArtifacts.length + ' windows)</div>';
    html += '<div style="max-height:100px;overflow-y:auto;font-size:9px;font-family:monospace;">';
    for (var ai = 0; ai < Math.min(researchLab.modelArtifacts.length, 6); ai++) {
      var a = researchLab.modelArtifacts[ai];
      html += '<div>' + esc(a.testStart || '?') + ' λ=' + esc(String(a.lambda)) + ' IC=' + esc(String(a.rankIC)) + ' gross=' + esc(String(a.grossReturn)) + '%</div>';
    }
    html += '</div></div>';
  }

  // Legacy composite note
  html += '<div style="border-top:1px solid #e2e8f0;padding-top:4px;margin-top:6px;font-size:9px;color:#94a3b8;">';
  html += 'Legacy composite: quarantined as historical control only — not used for scoring or promotion.';
  html += '</div>';

  el.innerHTML = html;
}

function fetchCohortIntegrity() {
  fetch('/api/cohort-integrity')
    .then(function(res) { return res.json(); })
    .then(function(data) { renderCohortIntegrity(data); })
    .catch(function(err) {
      var el = document.getElementById('cohort-integrity-body');
      if (el) el.innerHTML = '<div class="loading">' + esc(err.message || 'Network error') + '</div>';
    });
}

function renderCohortIntegrity(data) {
  var el = document.getElementById('cohort-integrity-body');
  if (!data || !data.ok) {
    el.innerHTML = '<div class="loading">' + (data && data.message ? esc(data.message) : 'Not available') + '</div>';
    return;
  }

  var html = '';
  var m = data.manifest;
  var counts = data.counts || {};

  // v3.4.9.4.1 P0-4: Three cohort categories row
  html += '<div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;">' +
    '<div style="flex:1;min-width:90px;text-align:center;padding:8px;background:#f8fafc;border-radius:4px;border:1px solid #e2e8f0;">' +
    '<div style="font-size:20px;font-weight:700;color:#1e293b;">' + (data.canonicalCohortCount || 0) + '</div>' +
    '<div style="font-size:9px;color:#64748b;">Canonical</div></div>' +
    '<div style="flex:1;min-width:90px;text-align:center;padding:8px;background:#fefce8;border-radius:4px;border:1px solid #e2e8f0;">' +
    '<div style="font-size:20px;font-weight:700;color:#a16207;">' + (data.intradayCount || 0) + '</div>' +
    '<div style="font-size:9px;color:#64748b;">Intraday</div></div>' +
    '<div style="flex:1;min-width:90px;text-align:center;padding:8px;background:#fee2e2;border-radius:4px;border:1px solid #e2e8f0;">' +
    '<div style="font-size:20px;font-weight:700;color:#dc2626;">' + (data.quarantinedCount || 0) + '</div>' +
    '<div style="font-size:9px;color:#64748b;">Quarantined</div></div>' +
    '</div>';

  // Canonical runId + status
  html += '<div style="margin-bottom:10px;">';
  if (m && m.canonicalRunId) {
    html += '<div style="font-size:10px;color:#94a3b8;font-family:monospace;margin-bottom:4px;">canonical: ' + esc(m.canonicalRunId) + '</div>';
    var statusDisplay = m.status === 'completed' ? 'completed' : (m.status === 'started' ? 'started' : 'unavailable');
    var statusColor = m.status === 'completed' ? '#16a34a' : (m.status === 'started' ? '#f59e0b' : '#dc2626');
    html += '<div style="font-size:12px;">Designated Window: <span style="font-weight:600;">09:30</span> — Status: <span style="color:' + statusColor + ';font-weight:600;">' + esc(statusDisplay) + '</span></div>';
  } else if (data.hasManifest && m) {
    html += '<div style="font-size:12px;">Status: <span style="color:#dc2626;font-weight:600;">canonical_unavailable</span></div>';
  } else {
    html += '<div style="font-size:12px;color:#94a3b8;">No canonical window yet today</div>';
  }
  if (m && m.candidateSetHash) {
    html += '<div style="font-size:9px;color:#94a3b8;font-family:monospace;margin-top:2px;">hash: ' + esc(m.candidateSetHash.slice(0, 16)) + '</div>';
  }
  html += '</div>';

  // v3.4.9.4.1 P0-4: 6-field eligibility counts (current valid cohort only, quarantined excluded)
  html += '<div class="ps-counts" style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;">' +
    '<div style="flex:1;min-width:70px;text-align:center;padding:6px;background:#f8fafc;border-radius:4px;">' +
    '<div style="font-size:14px;font-weight:700;color:#1e293b;">' + (data.ledgerTotal || 0) + '</div>' +
    '<div style="font-size:9px;color:#64748b;">Total</div></div>' +
    '<div style="flex:1;min-width:70px;text-align:center;padding:6px;background:#f0fdf4;border-radius:4px;">' +
    '<div style="font-size:14px;font-weight:700;color:#16a34a;">' + (counts.schemaValid || 0) + '</div>' +
    '<div style="font-size:9px;color:#64748b;">Schema</div></div>' +
    '<div style="flex:1;min-width:70px;text-align:center;padding:6px;background:#fefce8;border-radius:4px;">' +
    '<div style="font-size:14px;font-weight:700;color:#a16207;">' + (counts.researchEligible || 0) + '</div>' +
    '<div style="font-size:9px;color:#64748b;">Research</div></div>' +
    '<div style="flex:1;min-width:70px;text-align:center;padding:6px;background:#eff6ff;border-radius:4px;">' +
    '<div style="font-size:14px;font-weight:700;color:#2563eb;">' + (counts.executionCandidateEligible || 0) + '</div>' +
    '<div style="font-size:9px;color:#64748b;">Exec.Cand.</div></div>' +
    '<div style="flex:1;min-width:70px;text-align:center;padding:6px;background:#fee2e2;border-radius:4px;">' +
    '<div style="font-size:14px;font-weight:700;color:#dc2626;">' + (counts.globalBlocked || 0) + '</div>' +
    '<div style="font-size:9px;color:#64748b;">Blocked</div></div>' +
    '<div style="flex:1;min-width:70px;text-align:center;padding:6px;background:#f0fdf4;border-radius:4px;">' +
    '<div style="font-size:14px;font-weight:700;color:#16a34a;">' + (counts.actualBought || 0) + '</div>' +
    '<div style="font-size:9px;color:#64748b;">Bought</div></div>' +
    '</div>';

  // Detail rows
  html += '<div style="border-top:1px solid #e2e8f0;padding-top:6px;margin-top:4px;">';
  html += '<div class="metric-row"><span style="font-size:10px;">Missing E[R]</span><span style="font-size:10px;' + (counts.missingExpectedReturn > 0 ? 'color:#dc2626;' : '') + '">' + (counts.missingExpectedReturn || 0) + '</span></div>';
  // v3.4.9.4.1 P0-4: Quarantined shown separately here
  if (data.quarantinedCount > 0) {
    html += '<div class="metric-row"><span style="font-size:10px;">Quarantined (old format)</span><span style="font-size:10px;color:#f59e0b;">' + data.quarantinedCount + '</span></div>';
  }

  // Feature coverage
  if (data.featureCoverage && Object.keys(data.featureCoverage).length > 0) {
    var fcKeys = Object.keys(data.featureCoverage).sort();
    html += '<div style="margin-top:4px;"><span style="font-size:10px;font-weight:600;">Feature Coverage:</span>';
    for (var fi = 0; fi < Math.min(fcKeys.length, 6); fi++) {
      html += ' <span style="font-size:9px;color:#64748b;">' + esc(fcKeys[fi]) + ':' + data.featureCoverage[fcKeys[fi]] + '</span>';
    }
    html += '</div>';
  }

  // Manifest details
  if (m) {
    html += '<div style="margin-top:6px;border-top:1px solid #e2e8f0;padding-top:4px;">';
    html += '<div class="metric-row"><span style="font-size:9px;">Expected/Written/Deduped</span><span style="font-size:9px;">' +
      (m.expectedCount || '?') + ' / ' + (m.writtenCount || '?') + ' / ' + (m.dedupedCount || '0') + '</span></div>';
    if (m.modelVersionId) html += '<div class="metric-row"><span style="font-size:9px;">ModelVersionId</span><span style="font-size:9px;font-family:monospace;">' + esc(String(m.modelVersionId).slice(0, 16)) + '</span></div>';
    html += '</div>';
  }

  // Note
  if (data.note) {
    var noteColor = data.note.indexOf('尚无') >= 0 ? '#f59e0b' : '#16a34a';
    html += '<div style="margin-top:8px;padding:8px;background:#fffbeb;border-radius:4px;font-size:11px;color:' + noteColor + ';text-align:center;">' + esc(data.note) + '</div>';
  }

  el.innerHTML = html;
}

// ══════ Panel 7: Confidence Calibration ══════

function renderCalibration(cal) {
  var el = document.getElementById('calibration-body');
  if (!cal || !cal.available) {
    el.innerHTML = '<div class="loading">' + (cal && cal.message ? esc(cal.message) : 'Not available') + '</div>';
    return;
  }

  var html = '';

  if (cal.bins && cal.bins.length > 0) {
    for (var i = 0; i < cal.bins.length; i++) {
      var b = cal.bins[i];
      var actualPct = b.actualHitRate != null ? (b.actualHitRate * 100).toFixed(0) : 0;
      var predictedPct = b.predictedHitRate != null ? (b.predictedHitRate * 100).toFixed(0) : 50;

      html += '<div class="calib-bin">' +
        '<div class="calib-label">' +
        '<span>' + esc(b.name) + ' (' + (b.count || 0) + ' samples)</span>' +
        '<span>' + actualPct + '% actual vs ' + predictedPct + '% expected</span>' +
        '</div>' +
        '<div class="calib-bar-wrap">' +
        '<div class="calib-bar-fill" style="width:' + actualPct + '%"></div>' +
        '<div class="calib-bar-target" style="left:' + predictedPct + '%"></div>' +
        '</div>' +
        '</div>';
    }
  }

  if (cal.calibrationScore != null) {
    html += '<div class="metric-row">' +
      '<span>Calibration Score</span>' +
      '<span class="' + (cal.calibrationScore > 0.9 ? 'metric-good' : cal.calibrationScore > 0.75 ? 'metric-warn' : 'metric-bad') + '">' +
      cal.calibrationScore.toFixed(3) + '</span></div>';
  }

  if (cal.verdict) {
    var vClass = cal.verdict === 'well_calibrated' ? 'verdict-ok'
      : cal.verdict === 'moderately_calibrated' ? 'verdict-warn'
      : 'verdict-bad';
    html += '<div class="verdict ' + vClass + '">' + esc(cal.verdict.replace(/_/g, ' ')) + '</div>';
  }

  if (cal.highConfidenceAccuracyGap != null) {
    html += '<div class="metric-row">' +
      '<span>High-Low Accuracy Gap</span>' +
      '<span class="' + (cal.highConfidenceAccuracyGap > 0.05 ? 'metric-good' : 'metric-warn') + '">' +
      (cal.highConfidenceAccuracyGap * 100).toFixed(1) + '%</span></div>';
  }

  if (cal.interpretation) {
    html += '<div class="recommendation">' + esc(cal.interpretation) + '</div>';
  }

  el.innerHTML = html;
}

// ══════ Panel 8: Change Log ══════

function renderChangeLog(changeLog) {
  var el = document.getElementById('changelog-body');
  if (!changeLog || changeLog.length === 0) {
    el.innerHTML = '<div class="no-data">No change log entries</div>';
    return;
  }

  var html = '';
  for (var i = 0; i < changeLog.length; i++) {
    var cl = changeLog[i];
    var verifiedClass = cl.syntaxOk && cl.interfaceVerified && cl.hasRealData ? 'verdict-ok'
      : cl.syntaxOk ? 'verdict-warn' : 'verdict-bad';
    html += '<div class="changelog-entry">' +
      '<div class="cl-module">' + esc(cl.module) + '</div>' +
      '<div class="cl-purpose">' + esc(cl.purpose) + '</div>' +
      '<div class="cl-checks">' +
      '<span class="' + (cl.syntaxOk ? 'metric-good' : 'metric-bad') + '">Syntax: ' + (cl.syntaxOk ? 'PASS' : 'FAIL') + '</span> ' +
      '<span class="' + (cl.interfaceVerified ? 'metric-good' : 'status-gray') + '">API: ' + (cl.interfaceVerified ? 'PASS' : 'PENDING') + '</span> ' +
      '<span class="' + (cl.hasRealData ? 'metric-good' : 'status-gray') + '">Data: ' + (cl.hasRealData ? 'REAL' : 'PENDING') + '</span>' +
      '</div></div>';
  }
  el.innerHTML = html;
}

// ══════ Panel 9: Failed Tasks ══════

function renderFailures(failures) {
  var el = document.getElementById('failures-body');
  if (!failures || failures.length === 0) {
    el.innerHTML = '<div class="no-data" style="color:#00c853;">No recent failures</div>';
    return;
  }

  var html = '';
  for (var i = 0; i < failures.length; i++) {
    var f = failures[i];
    html += '<div class="failure-item">' +
      '<div><strong>' + esc(f.task || '?') + '</strong>: ' + esc(f.error || 'Unknown error') + '</div>' +
      '<div class="failure-time">' + esc(f.date || '') + '</div>' +
      '</div>';
  }
  el.innerHTML = html;
}

// ── Util ──

// v3.4.9.3: fmtTime — formats ISO timestamps for display, returns '--' on invalid input
function fmtTime(isoString) {
  if (!isoString) return '--';
  try {
    var d = new Date(isoString);
    if (isNaN(d.getTime())) return '--';
    return d.toLocaleTimeString('zh-CN', { hour12: false });
  } catch (_) { return '--'; }
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
