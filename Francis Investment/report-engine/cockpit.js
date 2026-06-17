/**
 * Autonomy Cockpit — v3.3.0
 * 30-second polling dashboard for autonomous trading status.
 * Text labels only — no emoji.
 */

var API = '/api/cockpit';
var POLL_INTERVAL = 30000;
var pollTimer = null;

// ── Init ──

(function init() {
  setConnectionStatus('CONNECTING', 'info');
  fetchData();
  pollTimer = setInterval(fetchData, POLL_INTERVAL);
})();

function fetchData() {
  fetch(API)
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (data && data.ok) {
        setConnectionStatus('OK', 'ok');
        document.getElementById('last-update').textContent =
          new Date().toLocaleTimeString('zh-CN', { hour12: false });
        renderAll(data);
      } else {
        setConnectionStatus('ERROR', 'error');
      }
    })
    .catch(function() {
      setConnectionStatus('ERROR', 'error');
    });
}

function setConnectionStatus(text, cls) {
  var el = document.getElementById('connection-status');
  el.textContent = text;
  el.className = 'badge ' + cls;
}

// ── Render ──

function renderAll(data) {
  renderTasks(data.tasks);
  renderModels(data.models);
  renderDataQuality(data.dataQuality);
  renderPermissions(data.permissions);
  renderVerification(data.verification);
  renderFailures(data.failures);
}

// ── Panel 1: Tasks ──

function renderTasks(tasks) {
  var el = document.getElementById('tasks-body');
  if (!tasks || tasks.length === 0) {
    el.innerHTML = '<div class="loading">No task data</div>';
    return;
  }

  var html = '';
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    var statusClass = t.status === 'ok' ? 'ok'
      : t.status === 'waiting' ? 'waiting'
      : t.status === 'running' ? 'running'
      : 'failed';
    var statusLabel = t.status === 'ok' ? '[OK]'
      : t.status === 'waiting' ? '[WAIT]'
      : t.status === 'running' ? '[RUN]'
      : '[FAIL]';
    html += '<div class="task-item">' +
      '<span class="task-name">' + esc(t.name) + '</span>' +
      '<span class="task-status ' + statusClass + '">' + statusLabel + '</span>' +
      '</div>';
  }
  el.innerHTML = html;
}

// ── Panel 2: Model Registry ──

function renderModels(models) {
  var el = document.getElementById('models-body');
  if (!models) {
    el.innerHTML = '<div class="loading">Not available</div>';
    return;
  }

  var html = '';

  // Champion
  if (models.champion) {
    html += '<div class="row">' +
      '<span class="label">Champion</span>' +
      '<span class="value good">' + esc(models.champion.versionId || '--') + '</span>' +
      '</div>';
    if (models.champion.cumulativeIC != null) {
      html += '<div class="row">' +
        '<span class="label">Champion IC</span>' +
        '<span class="value good">' + models.champion.cumulativeIC.toFixed(3) + '</span>' +
        '</div>';
    }
  } else {
    html += '<div class="row"><span class="value muted">No champion</span></div>';
  }

  // Shadows
  var shadowCount = models.shadowCount || 0;
  html += '<div class="row">' +
    '<span class="label">Shadows</span>' +
    '<span class="value ' + (shadowCount > 0 ? 'good' : 'muted') + '">' + shadowCount + ' active</span>' +
    '</div>';

  // Latest shadow details
  if (models.shadows && models.shadows.length > 0) {
    var latest = models.shadows[0];
    html += '<div class="row" style="font-size:11px; color:#7a8ba0; margin-top:4px;">Latest shadow: ' +
      esc(latest.versionId) + ' (IC=' + (latest.cumulativeIC != null ? latest.cumulativeIC.toFixed(3) : '?') + ', ' +
      (latest.evaluationDays || 0) + ' days)' +
      '</div>';
  }

  // Promotions
  if (models.promotionHistory && models.promotionHistory.length > 0) {
    html += '<div style="margin-top:8px; font-size:11px; color:#7a8ba0;">Recent promotions:</div>';
    var history = models.promotionHistory.slice(-3);
    for (var i = 0; i < history.length; i++) {
      html += '<div style="font-size:11px; padding-left:8px;">' +
        esc(history[i].date) + ': ' + esc(history[i].from) + ' -> ' + esc(history[i].to) +
        '</div>';
    }
  }

  el.innerHTML = html;
}

// ── Panel 3: Data Quality ──

function renderDataQuality(dq) {
  var el = document.getElementById('data-body');
  if (!dq) {
    el.innerHTML = '<div class="loading">Not available</div>';
    return;
  }

  var html = '';
  var score = dq.qualityScore != null ? dq.qualityScore : dq.score;
  var scoreClass = score >= 90 ? 'good' : score >= 85 ? 'warn' : 'bad';
  html += '<div class="row">' +
    '<span class="label">Quality Score</span>' +
    '<span class="value ' + scoreClass + '">' + (score != null ? score : '?') + '</span>' +
    '</div>';

  html += '<div class="row">' +
    '<span class="label">Confidence Penalty</span>' +
    '<span class="value ' + ((dq.penalty || 0) === 0 ? 'good' : 'warn') + '">' +
    (dq.penalty != null ? '-' + dq.penalty : '0') + '</span>' +
    '</div>';

  if (dq.reasons && dq.reasons.length > 0) {
    for (var i = 0; i < dq.reasons.length; i++) {
      html += '<div class="row" style="font-size:11px; color:#ffab00;">' +
        '[!] ' + esc(dq.reasons[i]) + '</div>';
    }
  }

  // Auto-pause
  if (dq.autoPause != null) {
    html += '<div style="margin-top:8px;">' +
      '<span class="label">Auto-Pause: </span>';
    if (dq.autoPause.paused) {
      html += '<span class="value bad">ACTIVE — ' + esc(dq.autoPause.pauseReason || '') + '</span>';
    } else {
      html += '<span class="value good">Inactive</span>';
    }
    html += '</div>';
  }

  el.innerHTML = html;
}

// ── Panel 4: Trading Permissions ──

function renderPermissions(perms) {
  var el = document.getElementById('permissions-body');
  if (!perms) {
    el.innerHTML = '<div class="loading">Not available</div>';
    return;
  }

  var html = '';

  // Main verdict
  html += '<div style="text-align:center; margin-bottom:10px;">' +
    '<span class="verdict ' + (perms.verdict || 'ALLOW') + '">' + (perms.verdict || 'ALLOW') + '</span>' +
    '</div>';

  html += '<div class="row">' +
    '<span class="label">Verdict Label</span>' +
    '<span class="value">' + esc(perms.verdictLabel || '--') + '</span>' +
    '</div>';

  if (perms.maxBuysPerDay != null) {
    html += '<div class="row">' +
      '<span class="label">Max Buys/Day</span>' +
      '<span class="value ' + (perms.maxBuysPerDay > 0 ? 'good' : 'bad') + '">' + perms.maxBuysPerDay + '</span>' +
      '</div>';
  }

  if (perms.gates) {
    html += '<div class="row">' +
      '<span class="label">Drawdown Gate</span>' +
      '<span class="value ' + (perms.gates.drawdownActive ? 'bad' : 'good') + '">' +
      (perms.gates.drawdownActive ? 'ACTIVE' : 'OK') + '</span>' +
      '</div>';
    html += '<div class="row">' +
      '<span class="label">Market Gate</span>' +
      '<span class="value ' + (perms.gates.marketGateActive ? 'warn' : 'good') + '">' +
      (perms.gates.marketGateActive ? 'ACTIVE' : 'OK') + '</span>' +
      '</div>';
    html += '<div class="row">' +
      '<span class="label">Circuit Breaker</span>' +
      '<span class="value ' + (perms.gates.circuitBreakerActive ? 'bad' : 'good') + '">' +
      (perms.gates.circuitBreakerActive ? 'ACTIVE' : 'OK') + '</span>' +
      '</div>';
  }

  // Reasons
  if (perms.reasons && perms.reasons.length > 0) {
    html += '<div style="margin-top:6px; font-size:11px;">';
    for (var i = 0; i < perms.reasons.length; i++) {
      html += '<div style="color:#ffab00; padding:2px 0;">[!] ' + esc(perms.reasons[i]) + '</div>';
    }
    html += '</div>';
  }

  el.innerHTML = html;
}

// ── Panel 5: Verification ──

function renderVerification(verif) {
  var el = document.getElementById('verify-body');
  if (!verif) {
    el.innerHTML = '<div class="loading">Not available</div>';
    return;
  }

  var html = '';

  html += '<div class="row">' +
    '<span class="label">Overall Hit Rate</span>' +
    '<span class="value ' + (verif.overallHitRate > 50 ? 'good' : verif.overallHitRate > 40 ? 'warn' : 'bad') + '">' +
    (verif.overallHitRate != null ? verif.overallHitRate.toFixed(1) + '%' : '?') + '</span>' +
    '</div>';

  html += '<div class="row">' +
    '<span class="label">Total Predictions</span>' +
    '<span class="value">' + (verif.totalPredictions || 0) + '</span>' +
    '</div>';

  if (verif.rankIC != null) {
    var icClass = verif.rankIC > 0.1 ? 'good' : verif.rankIC > 0 ? 'warn' : 'bad';
    html += '<div class="row">' +
      '<span class="label">Rank IC</span>' +
      '<span class="value ' + icClass + '">' + verif.rankIC.toFixed(3) + '</span>' +
      '</div>';
  } else {
    html += '<div class="row">' +
      '<span class="label">Rank IC</span>' +
      '<span class="value muted">Pending</span>' +
      '</div>';
  }

  html += '<div class="row">' +
    '<span class="label">Data Status</span>' +
    '<span class="value ' + (verif.dataQuality === 'stable' ? 'good' : verif.dataQuality === 'accumulating' ? 'warn' : 'muted') + '">' +
    esc(verif.dataQuality || '?') + '</span>' +
    '</div>';

  // Factor hit rates
  if (verif.factors && verif.factors.length > 0) {
    html += '<div style="margin-top:6px; font-size:11px; color:#7a8ba0;">Factor detail:</div>';
    for (var i = 0; i < Math.min(verif.factors.length, 5); i++) {
      var f = verif.factors[i];
      var fClass = f.verified ? 'good' : 'muted';
      html += '<div class="row" style="font-size:11px;">' +
        '<span>' + esc(f.id) + '</span>' +
        '<span class="value ' + fClass + '">' +
        (f.hitRate != null ? f.hitRate.toFixed(0) + '%' : '?') + ' (' + (f.samples || 0) + ')</span>' +
        '</div>';
    }
  }

  el.innerHTML = html;
}

// ── Panel 6: Failed Tasks ──

function renderFailures(failures) {
  var el = document.getElementById('failures-body');
  if (!failures || failures.length === 0) {
    el.innerHTML = '<div style="color:#00c853;">No recent failures</div>';
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

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
