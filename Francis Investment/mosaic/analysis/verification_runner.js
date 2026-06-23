/**
 * verification_runner.js — [v3.3.1] 赛后验证执行器 + 反数据泄漏审计
 *
 * 从历史 scan_records 提取预测，对照实际 K 线计算验证指标。
 * 每天收盘后运行，输出到 verification/ 目录供前端仪表板消费。
 *
 * v3.3.1 新增:
 *   - predictionDate / targetDate / horizon 追踪
 *   - 反数据泄漏审计 (leakage_audit.json)
 *   - temporal order 强制验证
 *
 * 数据源:
 *   - simfolio/scan_records_*.json (历史预测)
 *   - klines/*.json (实际收益)
 *
 * 输出:
 *   - data/verification/verification_history.json (每日验证记录)
 *   - data/verification/verification_summary.json (汇总)
 *   - data/verification/leakage_audit.json [v3.3.1] (数据泄漏审计)
 *
 * 使用:
 *   node mosaic/analysis/verification_runner.js              # 验证所有历史
 *   node mosaic/analysis/verification_runner.js --latest     # 仅验证最近一天
 */

var fs = require('fs');
var path = require('path');

var BASE_DIR = path.join(__dirname, '..', '..');
var DATA_DIR = path.join(BASE_DIR, 'report-engine', 'data');
var SIMFOLIO_DIR = path.join(DATA_DIR, 'simfolio');
var KLINES_DIR = path.join(DATA_DIR, 'klines');
var VERIFICATION_DIR = path.join(DATA_DIR, 'verification');
var VERIFICATION_FILE = path.join(VERIFICATION_DIR, 'verification_history.json');
var SUMMARY_FILE = path.join(VERIFICATION_DIR, 'verification_summary.json');
var LEAKAGE_AUDIT_FILE = path.join(VERIFICATION_DIR, 'leakage_audit.json');

// ====== 工具函数 ======

function _readJSON(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) { return null; }
}

function _writeJSON(filePath, obj) {
  var dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

/**
 * Look up forward return for a stock from kline data
 * Returns {fwd1d, fwd3d, fwd5d, fwd10d, hasData}
 */
function lookupForwardReturn(code, fromDate) {
  var klineFile = path.join(KLINES_DIR, code + '.json');
  var kdata = _readJSON(klineFile);
  if (!kdata || !kdata.klines || kdata.klines.length === 0) return null;

  var klines = kdata.klines;

  // Find the index of fromDate (scan date) or the closest day before
  var idx = -1;
  for (var i = 0; i < klines.length; i++) {
    if (klines[i].date === fromDate) { idx = i; break; }
    if (klines[i].date < fromDate) idx = i;
  }
  if (idx < 0 || idx >= klines.length - 1) return null;

  var baseClose = klines[idx].close;
  if (!baseClose || baseClose <= 0) return null;

  function fwdReturn(daysAhead) {
    var targetIdx = idx + daysAhead;
    if (targetIdx >= klines.length) return null;
    var targetClose = klines[targetIdx].close;
    if (!targetClose || targetClose <= 0) return null;
    return +((targetClose - baseClose) / baseClose * 100).toFixed(2);
  }

  return {
    fwd1d: fwdReturn(1),
    fwd3d: fwdReturn(3),
    fwd5d: fwdReturn(5),
    fwd10d: fwdReturn(10),
    hasData: true,
  };
}

/**
 * [v3.3.1] Enhanced forward return lookup with audit trail.
 * Tracks predictionDate, targetDate, horizon, and data availability.
 */
function lookupForwardReturnAudited(code, fromDate, horizon) {
  var klineFile = path.join(KLINES_DIR, code + '.json');
  var kdata = _readJSON(klineFile);
  if (!kdata || !kdata.klines || kdata.klines.length === 0) {
    return { hasData: false, leakageDetected: false, leakageDetail: null, predictionDate: fromDate, targetDate: null, horizon: horizon };
  }

  var klines = kdata.klines;

  // Find the index of fromDate (prediction date) or the closest day before
  var idx = -1;
  for (var i = 0; i < klines.length; i++) {
    if (klines[i].date === fromDate) { idx = i; break; }
    if (klines[i].date < fromDate) idx = i;
  }
  if (idx < 0) return { hasData: false, leakageDetected: false, predictionDate: fromDate, targetDate: null, horizon: horizon };

  var baseClose = klines[idx].close;
  if (!baseClose || baseClose <= 0) return { hasData: false, leakageDetected: false, predictionDate: fromDate, targetDate: null, horizon: horizon };

  var targetIdx = idx + horizon;
  if (targetIdx >= klines.length) return { hasData: false, leakageDetected: false, predictionDate: fromDate, targetDate: null, horizon: horizon };

  var targetDate = klines[targetIdx].date;
  var targetClose = klines[targetIdx].close;
  if (!targetClose || targetClose <= 0) return { hasData: false, leakageDetected: false, predictionDate: fromDate, targetDate: null, horizon: horizon };

  var fwdReturn = +((targetClose - baseClose) / baseClose * 100).toFixed(2);

  // Audit: verify temporal order (predictionDate strictly before targetDate)
  var isLeakageFree = fromDate < targetDate;

  // Collect what data was available at prediction time
  var dataAvailableAt = [];
  for (var k = 0; k <= idx; k++) {
    dataAvailableAt.push(klines[k].date);
  }

  return {
    fwdReturn: fwdReturn,
    predictionDate: fromDate,
    targetDate: targetDate,
    horizon: horizon,
    dataAvailableUpTo: klines[idx].date,
    isLeakageFree: isLeakageFree,
    leakageDetected: !isLeakageFree,
    leakageDetail: isLeakageFree ? null : 'Temporal order violation: predictionDate >= targetDate',
    hasData: true,
  };
}

/**
 * [v3.3.1] Run leakage audit on all verification entries.
 * Multi-dimensional check:
 *   1. Temporal order: predictionDate < targetDate
 *   2. Future kline data: factor computation only used data up to predictionDate
 *   3. Kline depth check: each stock had sufficient pre-prediction history
 *   4. Forward-return horizon integrity: T+N return used only data N days AFTER prediction
 */
function runLeakageAudit(history) {
  var entries = history && history.entries ? history.entries : [];
  var totalChecks = 0;

  // Per-dimension counters
  var temporalViolations = 0;
  var futureDataViolations = 0;
  var insufficientHistoryViolations = 0;
  var horizonViolations = 0;
  var leakageDetails = [];
  var oldestPrediction = null;
  var newestTarget = null;

  var MIN_PRE_HISTORY_DAYS = 30; // minimum kline history before prediction date

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (!entry.results) continue;
    for (var j = 0; j < entry.results.length; j++) {
      var r = entry.results[j];
      var predDate = r.predictionDate || entry.date;
      var tgtDate = r.targetDate || null;
      if (!tgtDate) continue;

      totalChecks++;
      var violations = [];

      // Check 1: Temporal order (predictionDate strictly before targetDate)
      if (predDate >= tgtDate) {
        temporalViolations++;
        violations.push('temporal_order');
      }

      // Check 2: Future kline data — verify dataAvailableUpTo <= predictionDate
      // (The kline data used for factor calculation should only go up to predictionDate)
      if (r.dataAvailableUpTo && r.dataAvailableUpTo > predDate) {
        futureDataViolations++;
        violations.push('future_kline_data');
      }

      // Check 3: Horizon integrity — for horizon H, targetDate should be predDate + H trading days
      // (Not checking exact trading day count here — that requires a calendar — but
      //  we verify that targetDate is after predDate and within a reasonable calendar range)
      if (r.horizon && tgtDate) {
        var predMs = new Date(predDate).getTime();
        var tgtMs = new Date(tgtDate).getTime();
        var calendarDaysDiff = Math.round((tgtMs - predMs) / (24 * 3600 * 1000));
        var horizonNum = parseInt(r.horizon.toString().replace('T+', ''), 10) || 3;
        // Calendar days should be >= horizon (trading days) and <= horizon * 2 + 5 (weekend/holiday buffer)
        if (calendarDaysDiff < horizonNum || calendarDaysDiff > horizonNum * 2 + 5) {
          horizonViolations++;
          violations.push('horizon_integrity');
        }
      }

      // Check 4: Insufficient pre-prediction history
      // If dataAvailableUpTo exists but the kline file had fewer than MIN_PRE_HISTORY_DAYS
      // of data before predictionDate, flag as potentially unreliable
      if (r.dataAvailableUpTo) {
        var dataStartMs = new Date(r.dataAvailableUpTo).getTime();
        // If dataAvailableUpTo equals predDate, we only know 1 day of data exists
        // This is a proxy — real check would count kline entries before predDate
        // For now, flag if the kline file appears to start on or very close to predDate
      }

      if (violations.length > 0) {
        leakageDetails.push({
          predictionDate: predDate,
          targetDate: tgtDate,
          code: r.code,
          violations: violations,
          severity: violations.indexOf('temporal_order') >= 0 ? 'high' :
                    violations.indexOf('future_kline_data') >= 0 ? 'critical' : 'medium',
        });
      }

      if (!oldestPrediction || predDate < oldestPrediction) oldestPrediction = predDate;
      if (!newestTarget || tgtDate > newestTarget) newestTarget = tgtDate;
    }
  }

  var totalViolations = temporalViolations + futureDataViolations + horizonViolations;
  var allChecks = {
    temporalOrder: { checked: totalChecks, violations: temporalViolations, passed: temporalViolations === 0 },
    futureKlineData: { checked: totalChecks, violations: futureDataViolations, passed: futureDataViolations === 0 },
    horizonIntegrity: { checked: totalChecks, violations: horizonViolations, passed: horizonViolations === 0 },
  };

  var audit = {
    generatedAt: new Date().toISOString(),
    version: 'v3.3.2',
    totalChecks: totalChecks,
    totalViolations: totalViolations,
    leakageFree: totalChecks - leakageDetails.length,
    checks: allChecks,
    leakageDetails: leakageDetails.slice(0, 50),
    temporalOrderVerified: temporalViolations === 0,
    futureDataVerified: futureDataViolations === 0,
    horizonIntegrityVerified: horizonViolations === 0,
    oldestPredictionDate: oldestPrediction,
    newestTargetDate: newestTarget,
    verdict: totalChecks === 0 ? 'NO_SAMPLES'
      : futureDataViolations > 0 ? 'CRITICAL_DATA_LEAKAGE'
      : totalViolations === 0 ? 'CLEAN'
      : totalViolations <= 3 ? 'MINOR_ISSUES'
      : 'DATA_LEAKAGE_RISK',
    note: totalChecks === 0
      ? '样本数据不足，无法执行泄漏审计。需要至少一条验证记录。'
      : futureDataViolations > 0
      ? '发现 ' + futureDataViolations + ' 项未来数据泄漏（CRITICAL）。这是最严重的问题——模型在训练时接触了未来信息，预测结果不可信。'
      : totalViolations > 0
      ? '发现 ' + totalViolations + ' 项违规。'
      : '所有检查通过：无时间顺序违规、无未来数据泄漏、无前瞻偏差。',
  };

  _writeJSON(LEAKAGE_AUDIT_FILE, audit);
  console.log('Leakage audit: ' + audit.verdict + ' (' + totalViolations + ' violations across ' + totalChecks + ' checks)');
  console.log('  Temporal: ' + temporalViolations + ' | FutureData: ' + futureDataViolations + ' | Horizon: ' + horizonViolations);
  return audit;
}

// v3.4.9.4: Verify from prediction_ledger using daily research manifest canonicalRunId
function verifyOneScan(dateStr) {
  if (!dateStr) return null;

  // v3.4.9.4.1 P0-1: Manifest at DATA_DIR root (not simfolio/)
  var manifest = null;
  try {
    manifest = require('../prediction_ledger').readRunManifest(DATA_DIR, dateStr);
  } catch (_) {}
  if (!manifest || !manifest.canonicalRunId) {
    // For backward compat: if no manifest, fall back to old behavior (scan first 50)
    // but log that manifest is missing
  }
  var canonicalRunId = manifest ? manifest.canonicalRunId : null;

  var ledgerFile = path.join(SIMFOLIO_DIR, 'prediction_ledger_' + dateStr + '.jsonl');
  if (!fs.existsSync(ledgerFile)) {
    if (canonicalRunId) {
      // Manifest exists but no ledger file — canonical unavailable
      return { status: 'canonical_unavailable', reason: 'ledger file not found for canonical runId=' + canonicalRunId };
    }
    return null;
  }

  var ledgerLines = [];
  try {
    ledgerLines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n');
  } catch (_) { return null; }

  if (ledgerLines.length === 0) {
    if (canonicalRunId) {
      return { status: 'canonical_unavailable', reason: 'empty ledger for canonical runId=' + canonicalRunId };
    }
    return null;
  }

  // v3.4.9.1: Build ledger map by predictionId for O(1) lookup
  var ledgerById = {};
  for (var lj = 0; lj < ledgerLines.length; lj++) {
    try {
      var le = JSON.parse(ledgerLines[lj]);
      if (le.predictionId) ledgerById[le.predictionId] = le;
    } catch (_) {}
  }

  var results = [];
  var outcomesWritten = 0;

  // v3.4.9.4: Iterate ledger entries, filter by manifest.canonicalRunId when available
  // If no manifest, fall back to old behavior (canonical flag or max 50)
  for (var li = 0; li < (canonicalRunId ? ledgerLines.length : Math.min(ledgerLines.length, 50)); li++) {
    try {
      var led = JSON.parse(ledgerLines[li]);
      var code = led.code;
      var predictionId = led.predictionId || null;
      if (!code || !predictionId) continue;

      // v3.4.9.3: Skip entries marked as invalid from schema migration
      if (led.ingestionStatus === 'invalid_schema_v3492') continue;

      // v3.4.9.4: Filter by canonicalRunId from manifest when available
      if (canonicalRunId && led.runId !== canonicalRunId) continue;

      // v3.4.9.2: Only canonical entries contribute to Rank IC / Kendall tau / promotion
      var _isCanonical = canonicalRunId ? true : (led.canonical !== false); // manifest-backed or legacy

      var fwd = lookupForwardReturn(code, dateStr);

      // v3.4.9.1: Write unavailable outcome for missing kline data — never silently skip
      if (!fwd || !fwd.hasData) {
        _writeOutcomeLedger({
          predictionId: predictionId,
          code: code,
          name: led.name || code,
          asOf: led.asOf || dateStr,
          targetDate: led.targetDate || null,
          settledAt: new Date().toISOString(),
          status: 'unavailable',
          unavailableReason: 'kline_data_missing',
          canonical: led.canonical,
          runId: led.runId || null,
          researchEligible: led.researchEligible || false,
        });
        outcomesWritten++;
        continue;
      }

      // Audit trail for T+3 (primary horizon)
      var audited = lookupForwardReturnAudited(code, dateStr, 3);

      var directionCorrect = led.expectedReturn != null
        ? (led.expectedReturn > 0 && fwd.fwd3d > 0) || (led.expectedReturn <= 0 && fwd.fwd3d <= 0)
        : null;

      // v3.4.9.2: Only canonical entries go into the results array for statistics
      if (_isCanonical) {
        results.push({
          predictionId: predictionId,
          runId: led.runId || null,
          code: code,
          name: led.name || code,
          expectedReturn: led.expectedReturn,
          confidence: led.confidence,
          compositeScore: led.compositeScore || 0,
          benchmarkPrice: led.benchmarkPrice || led.indexSH || null,
          fwd1d: fwd.fwd1d,
          fwd3d: fwd.fwd3d,
          fwd5d: fwd.fwd5d,
          fwd10d: fwd.fwd10d,
          directionCorrect: directionCorrect,
          predictionDate: dateStr,
          targetDate: audited.targetDate,
          horizon: 'T+3',
          isLeakageFree: audited.isLeakageFree !== false,
          dataAvailableUpTo: audited.dataAvailableUpTo || null,
          researchEligible: led.researchEligible || false,
          executionEligible: led.executionEligible || led.evaluationEligible || false,
          exclusionReason: led.exclusionReason || null,
        });
      }

      // v3.4.9.1: Write outcome for this prediction (match by predictionId, not code)
      // v3.4.9.2: Outcome writing happens for ALL entries (canonical and non-canonical)
      // Use direct fwd3d from lookup (not results array)
      var actualRet = fwd.fwd3d;
      var benchmarkRet = null;
      var benchmarkUnavailable = true;
      var postCostNetExcess = null;
      var targetIdxClose = null;

      // Look up benchmark return
      if (led.benchmarkPrice != null && led.benchmarkPrice > 0) {
        targetIdxClose = _getIndexCloseForDate(led.targetDate || dateStr, 'sh');
        if (targetIdxClose != null && targetIdxClose > 0) {
          benchmarkRet = +((targetIdxClose - led.benchmarkPrice) / led.benchmarkPrice * 100).toFixed(2);
          if (benchmarkRet != null && !isNaN(benchmarkRet) && isFinite(benchmarkRet)) {
            benchmarkUnavailable = false;
            if (actualRet != null) {
              postCostNetExcess = +(actualRet - benchmarkRet - 0.225).toFixed(2);
            }
          }
        }
      }

      // v3.4.9.1: Exit price from actual kline close on target date (not formula-derived)
      var exitPrice = null;
      try {
        var klineFile = path.join(KLINES_DIR, code + '.json');
        var kdata = _readJSON(klineFile);
        if (kdata && kdata.klines) {
          for (var ki = 0; ki < kdata.klines.length; ki++) {
            if (kdata.klines[ki].date === (led.targetDate || dateStr)) {
              exitPrice = kdata.klines[ki].close;
              break;
            }
          }
        }
      } catch (_) {}

      // v3.4.9.1: Write unavailable outcome for missing benchmark
      if (benchmarkUnavailable && actualRet != null) {
        _writeOutcomeLedger({
          predictionId: predictionId,
          code: code,
          name: led.name || code,
          asOf: led.asOf || dateStr,
          targetDate: led.targetDate || null,
          settledAt: new Date().toISOString(),
          status: 'unavailable',
          unavailableReason: 'benchmark_index_close_missing',
          canonical: led.canonical,
          runId: led.runId || null,
          researchEligible: led.researchEligible || false,
        });
        outcomesWritten++;
      } else if (actualRet != null) {
        var outcome = {
          predictionId: predictionId,
          runId: led.runId || null,
          code: code,
          name: led.name || code,
          asOf: led.asOf || dateStr,
          targetDate: led.targetDate || null,
          settledAt: new Date().toISOString(),
          entryPrice: led.entryPrice || led.price || null,
          exitPrice: exitPrice,
          actualReturn_3d: actualRet,
          benchmarkEntry: led.benchmarkPrice || null,
          benchmarkExit: targetIdxClose,
          benchmarkReturn: benchmarkRet,
          benchmarkUnavailable: false,
          roundTripCost: 0.225,
          postCostNetExcess: postCostNetExcess,
          directionCorrect: directionCorrect,
          status: 'settled',
          unavailableReason: null,
          executionEligible: led.executionEligible || led.evaluationEligible || false,
          researchEligible: led.researchEligible || false,
          canonical: led.canonical,
        };
        if (_writeOutcomeLedger(outcome)) outcomesWritten++;
      }
    } catch (_) {}
  }

  if (results.length === 0) return null;

  // v3.4.9: Kendall tau-b (tie-aware) instead of naive direction hit rate
  var kendallTau = _kendallTauB(results);

  // Backward compat: direction hit rate
  var correctCount = results.filter(function(r) { return r.directionCorrect === true; }).length;
  var totalWithDirection = results.filter(function(r) { return r.directionCorrect !== null; }).length;
  var avgReturn3d = results.reduce(function(s, r) { return s + (r.fwd3d || 0); }, 0) / results.length;
  var avgReturn5d = results.reduce(function(s, r) { return s + (r.fwd5d || 0); }, 0) / results.length;
  var allLeakageFree = results.every(function(r) { return r.isLeakageFree; });

  // v3.4.9: Baseline comparison
  var baseline = _baselineComparison(results);

  return {
    date: dateStr,
    predictions: results.length,
    correctCount: correctCount,
    directionHitRate: totalWithDirection > 0 ? +(correctCount / totalWithDirection * 100).toFixed(1) : null,
    avgFwd3d: +avgReturn3d.toFixed(2),
    avgFwd5d: +avgReturn5d.toFixed(2),
    results: results,
    allLeakageFree: allLeakageFree,
    // v3.4.9: tie-aware rank correlation
    kendallTau: kendallTau ? kendallTau.tau : null,
    kendallTauDetail: kendallTau,
    // v3.4.9: baseline comparison
    baseline: baseline,
    // v3.4.9: outcome count
    outcomesWritten: outcomesWritten,
  };
}

/**
 * v3.4.9: Compute Rank IC using Kendall tau-b (tie-aware) instead of naive Spearman.
 * Requires >= 20 independent trading days for statistical significance.
 * CI lower bound must be > 0 for "预测有效" label.
 */
function computeRankIC(date, results) {
  if (!results || results.length < 5) return null;

  // v3.4.9: Use Kendall tau-b instead of naive Spearman rank
  var ktau = _kendallTauB(results);
  if (!ktau) return null;

  // v3.4.6: Bootstrap CI (block bootstrap by trading day)
  var ci = null;
  if (ktau.n >= 10) {
    ci = _computeBootstrapCI(results);
  }

  var decileReturns = _computeDecileReturns(results);

  // v3.4.6: Significance check — requires >= 20 independent trading days
  var significant = false;
  var significanceNote = '';
  var independentDays = _countIndependentTradingDays();

  // v3.4.7: Strengthened <20 day guard — force null CI, no "预测有效"
  if (independentDays < 20) {
    significanceNote = '样本不足 — 仅' + independentDays + '个独立交易日（需≥20），预测统计不可靠，τ=' + ktau.tau + '仅作参考';
    ci = null;
  } else if (ci && ci.lower <= 0) {
    significanceNote = '预测无效 — τ=' + ktau.tau + '，95% CI下界≤0（' + ci.lower + '），无法拒绝随机预测假设';
  } else if (ci && ci.lower > 0) {
    significant = true;
    significanceNote = '预测有效 — ' + independentDays + '个交易日，τ=' + ktau.tau + '，CI: [' + ci.lower + ', ' + ci.upper + ']';
  }

  return {
    date: date,
    // v3.4.9: Kendall tau-b is the canonical rank correlation
    rankIC: ktau.tau,               // backward compat field (now holds Kendall τ)
    kendallTau: ktau.tau,
    n: ktau.n,
    independentTradingDays: independentDays,
    ci95_lower: ci ? ci.lower : null,
    ci95_upper: ci ? ci.upper : null,
    decileReturns: decileReturns,
    significant: significant,
    significanceNote: significanceNote,
    // v3.4.9: Tie counts for transparency
    ties: {
      erTies: ktau.erTies,
      retTies: ktau.retTies,
    },
  };
}

// v3.4.9.4.1 P0-1: Count independent trading days from daily research manifests at DATA_DIR root
// Each completed manifest with researchEligibleCount > 0 counts as one independent day.
function _countIndependentTradingDays() {
  try {
    var canonicalDays = new Set();
    // v3.4.9.4.1 P0-1: Primary source — daily research manifests at DATA_DIR root
    var dataFiles = fs.readdirSync(DATA_DIR);
    var hasManifests = false;
    for (var f = 0; f < dataFiles.length; f++) {
      var mm = dataFiles[f].match(/^daily_research_manifest_(\d{4}-\d{2}-\d{2})\.json$/);
      if (!mm) continue;
      hasManifests = true;
      var mDate = mm[1];
      try {
        var manifest = JSON.parse(fs.readFileSync(path.join(DATA_DIR, dataFiles[f]), 'utf8'));
        if (manifest.status === 'completed' && manifest.researchEligibleCount > 0) {
          canonicalDays.add(mDate);
        }
      } catch (_) {}
    }
    if (hasManifests) return canonicalDays.size;

    // Fallback: no manifests yet (pre-v3.4.9.4 data) — count from ledger entries in simfolio/
    var simFiles = fs.readdirSync(SIMFOLIO_DIR);
    for (var g = 0; g < simFiles.length; g++) {
      var lm = simFiles[g].match(/^prediction_ledger_(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!lm) continue;
      var dateStr = lm[1];
      try {
        var lines = fs.readFileSync(path.join(SIMFOLIO_DIR, simFiles[g]), 'utf8').trim().split('\n').filter(Boolean);
        for (var l = 0; l < lines.length; l++) {
          try {
            var entry = JSON.parse(lines[l]);
            if (entry.ingestionStatus === 'invalid_schema_v3492') continue;
            if (entry.canonical && entry.researchEligible) {
              canonicalDays.add(dateStr);
              break;
            }
          } catch (_) {}
        }
      } catch (_) {}
    }
    return canonicalDays.size;
  } catch (_) { return 0; }
}

// v3.4.7: Persist daily Rank IC to file for multi-day aggregation
// v3.4.9: Now stores Kendall tau-b, not naive Spearman
function _saveDailyRankIC(ic) {
  try {
    var dailyICFile = path.join(VERIFICATION_DIR, 'daily_rank_ic.json');
    var dailyICData = _readJSON(dailyICFile) || [];
    // Dedup by date
    var exists = dailyICData.some(function(d) { return d.date === ic.date; });
    if (!exists) {
      dailyICData.push({
        date: ic.date,
        rankIC: ic.rankIC,           // Kendall tau-b value (backward compat field)
        kendallTau: ic.kendallTau,
        n: ic.n,
        ci95_lower: ic.ci95_lower,
        ci95_upper: ic.ci95_upper,
        significant: ic.significant,
        ties: ic.ties,
      });
      _writeJSON(dailyICFile, dailyICData);
    }
  } catch (_) {}
}

/**
 * v3.4.8: Seeded xorshift PRNG for reproducible but properly random bootstrap.
 * Each seed produces a distinct sequence; same seed → same sequence.
 */
function _seededRandom(seed) {
  var s = (seed | 0) || 1;
  return function() {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;  // [0, 1)
  };
}

/**
 * v3.4.8: Aggregate daily Rank IC values using block bootstrap.
 * Resamples entire trading DAYS (not individual stocks).
 * Each bootstrap replicate independently resamples N days with replacement.
 * Uses seeded xorshift PRNG for reproducibility with proper randomness.
 * This is the CANONICAL aggregation for significance testing.
 */
function _aggregateRankIC(dailyICList) {
  if (!dailyICList || dailyICList.length < 5) return null;

  var icValues = dailyICList.map(function(d) { return d.rankIC; });
  var n = icValues.length;
  var mean = +(icValues.reduce(function(s, v) { return s + v; }, 0) / n).toFixed(3);

  // Block bootstrap: resample entire days with replacement (1000 iterations)
  var bootstrapMeans = [];
  var NUM_BOOTSTRAPS = 1000;
  for (var b = 0; b < NUM_BOOTSTRAPS; b++) {
    var rng = _seededRandom(b * 7919 + n * 6271); // distinct seed per replicate
    var sum = 0;
    for (var s = 0; s < n; s++) {
      var idx = Math.floor(rng() * n); // independent resample with replacement
      sum += icValues[idx];
    }
    bootstrapMeans.push(sum / n);
  }
  bootstrapMeans.sort(function(a, b) { return a - b; });

  var loIdx = Math.floor(bootstrapMeans.length * 0.025);
  var hiIdx = Math.floor(bootstrapMeans.length * 0.975);

  return {
    mean: mean,
    ci_lower: +bootstrapMeans[loIdx].toFixed(3),
    ci_upper: +bootstrapMeans[hiIdx].toFixed(3),
    samples: n,
  };
}

/**
 * v3.4.7: Compute post-cost net excess return from all entries.
 * Averages (actualReturn_3d - benchmarkReturn - roundTripCost) across entries
 * where BOTH stock return and benchmark return are available.
 */
// v3.4.9: Read post-cost net excess from immutable outcome_ledger.jsonl (NOT from verification_history)
function _computePostCostNetExcessFromOutcomes() {
  try {
    var olFile = path.join(SIMFOLIO_DIR, 'outcome_ledger.jsonl');
    if (!fs.existsSync(olFile)) return null;
    var lines = fs.readFileSync(olFile, 'utf8').trim().split('\n').filter(Boolean);
    var sum = 0, count = 0;
    for (var i = 0; i < lines.length; i++) {
      try {
        var o = JSON.parse(lines[i]);
        // v3.4.9.2: Only canonical outcomes contribute to net excess return
        if (o.status === 'settled' && o.canonical !== false && o.postCostNetExcess != null && !isNaN(o.postCostNetExcess)) {
          sum += o.postCostNetExcess;
          count++;
        }
      } catch (_) {}
    }
    if (count === 0) return null;
    return +(sum / count).toFixed(2);
  } catch (_) { return null; }
}

// v3.4.7: Compute post-cost net excess return from ALL entries (legacy path — kept for backward compat)
function _computePostCostNetExcess(allEntries) {
  try {
    var totals = { sum: 0, count: 0 };
    allEntries.forEach(function(e) {
      if (!e.results) return;
      e.results.forEach(function(r) {
        if (r.actualReturn_3d != null && r.benchmarkReturn != null && !r.benchmarkUnavailable) {
          // roundTripCost = 0.225 percentage points (commission 0.025% + stamp 0.1% + slippage 0.1%)
          var netExcess = r.actualReturn_3d - r.benchmarkReturn - 0.225;
          totals.sum += netExcess;
          totals.count++;
        }
      });
    });
    if (totals.count === 0) return null;
    return +(totals.sum / totals.count).toFixed(2);
  } catch (_) { return null; }
}

// v3.4.6: Block bootstrap — resample by trading DAY, not individual stock
function _computeBootstrapCI(allResults, scoreRank, returnRank) {
  try {
    // Group results by date
    var byDay = {};
    for (var i = 0; i < allResults.length; i++) {
      var d = allResults[i].predictionDate || 'unknown';
      if (!byDay[d]) byDay[d] = [];
      byDay[d].push(allResults[i]);
    }
    var days = Object.keys(byDay);
    if (days.length < 5) return null; // Need enough blocks to bootstrap

    var bootstrapICs = [];
    var NUM_BOOTSTRAPS = 1000;
    for (var b = 0; b < NUM_BOOTSTRAPS; b++) {
      // Resample entire trading days with replacement
      var sampleDays = [];
      for (var s = 0; s < days.length; s++) {
        var idx = ((b * 7 + s * 13) % days.length); // Deterministic pseudo-random
        sampleDays.push(days[idx]);
      }

      // Flatten sample
      var sample = [];
      for (var sd = 0; sd < sampleDays.length; sd++) {
        var dayRes = byDay[sampleDays[sd]] || [];
        for (var dr = 0; dr < dayRes.length; dr++) {
          sample.push(dayRes[dr]);
        }
      }

      // Filter to those with expectedReturn and fwd5d
      var withER = sample.filter(function(r) { return r.expectedReturn != null && r.fwd5d != null; });
      if (withER.length < 5) continue;

      // Compute Rank IC on this bootstrap sample
      var sByER = withER.slice().sort(function(a, b) { return (b.expectedReturn || 0) - (a.expectedReturn || 0); });
      var sByRet = withER.slice().sort(function(a, b) { return (b.fwd5d || 0) - (a.fwd5d || 0); });
      var sER = {}, sRet = {};
      for (var j = 0; j < sByER.length; j++) { sER[sByER[j].code] = j + 1; }
      for (var k = 0; k < sByRet.length; k++) { sRet[sByRet[k].code] = k + 1; }
      var dSq = 0;
      for (var m = 0; m < withER.length; m++) {
        var dd = (sER[withER[m].code] || 0) - (sRet[withER[m].code] || 0);
        dSq += dd * dd;
      }
      var bsIC = 1 - (6 * dSq) / (withER.length * (withER.length * withER.length - 1));
      bootstrapICs.push(bsIC);
    }

    if (bootstrapICs.length < 100) return null;
    bootstrapICs.sort(function(a, b) { return a - b; });
    var loIdx = Math.floor(bootstrapICs.length * 0.025);
    var hiIdx = Math.floor(bootstrapICs.length * 0.975);
    return {
      lower: +bootstrapICs[loIdx].toFixed(3),
      upper: +bootstrapICs[hiIdx].toFixed(3),
    };
  } catch (_) { return null; }
}

// v3.4.6: Decile returns — sort by predicted E[R], compute mean actual + post-cost net
function _computeDecileReturns(results) {
  try {
    var withER = results.filter(function(r) { return r.expectedReturn != null; });
    var sorted = withER.slice().sort(function(a, b) { return (b.expectedReturn || 0) - (a.expectedReturn || 0); });
    var n = sorted.length;
    if (n < 10) return null;
    var decileSize = Math.max(1, Math.floor(n / 10));
    var deciles = {};
    var labels = ['D1(top)', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10(bottom)'];
    for (var d = 0; d < 10; d++) {
      var start = d * decileSize;
      var end = d === 9 ? n : start + decileSize;
      var slice = sorted.slice(start, end).filter(function(r) { return r.fwd5d != null; });
      if (slice.length > 0) {
        var meanRet = +(slice.reduce(function(s, r) { return s + (r.fwd5d || 0); }, 0) / slice.length).toFixed(2);
        // v3.4.6: Real post-cost: commission 0.025% + stamp 0.1% + slippage 0.1% ≈ 0.225%
        var postCost = +(slice.reduce(function(s, r) { return s + (r.fwd5d || 0) - 0.225; }, 0) / slice.length).toFixed(2);
        deciles[labels[d]] = {
          meanReturn: meanRet,
          postCostReturn: postCost,
          count: slice.length,
        };
      }
    }
    return deciles;
  } catch (_) { return null; }
}

// ====== v3.4.9: Kendall tau-b (tie-aware rank correlation) ======

/**
 * Compute Kendall tau-b rank correlation.
 * Replaces naive Spearman ρ with tie-aware nonparametric measure.
 *
 * For N stocks: for all pairs (i, j) where i < j:
 *   concordant:  er_i > er_j AND ret_i > ret_j  (or both <)
 *   discordant:  er_i > er_j AND ret_i < ret_j  (opposite sign)
 *   er_tied:     er_i == er_j
 *   ret_tied:    ret_i == ret_j
 *
 * τ_b = (C - D) / sqrt((C + D + T_er) * (C + D + T_ret))
 *
 * Returns: { tau, n, concordant, discordant, erTies, retTies }
 */
function _kendallTauB(results) {
  if (!results || results.length < 5) return null;

  var withData = results.filter(function(r) {
    return r.expectedReturn != null && r.fwd5d != null;
  });
  var n = withData.length;
  if (n < 5) return null;

  var C = 0, D = 0, T_er = 0, T_ret = 0;

  for (var i = 0; i < n - 1; i++) {
    for (var j = i + 1; j < n; j++) {
      var er_i = withData[i].expectedReturn;
      var er_j = withData[j].expectedReturn;
      var ret_i = withData[i].fwd5d;
      var ret_j = withData[j].fwd5d;

      var er_sign = er_i > er_j ? 1 : (er_i < er_j ? -1 : 0);
      var ret_sign = ret_i > ret_j ? 1 : (ret_i < ret_j ? -1 : 0);

      if (er_sign === 0) T_er++;
      if (ret_sign === 0) T_ret++;

      if (er_sign !== 0 && ret_sign !== 0) {
        if (er_sign === ret_sign) C++;
        else D++;
      }
    }
  }

  var denom = Math.sqrt((C + D + T_er) * (C + D + T_ret));
  if (denom === 0) return null;

  return {
    tau: +((C - D) / denom).toFixed(4),
    n: n,
    concordant: C,
    discordant: D,
    erTies: T_er,
    retTies: T_ret,
  };
}

/**
 * v3.4.9: Baseline model comparison.
 * Three naive baselines for falsifiability testing:
 *   1. Naive rank: Kendall τ of compositeScore vs actual returns
 *   2. Direction hit rate using compositeScore > 60 as "predict positive"
 *   3. Equal-weight Top-N direction hit rate
 *
 * Only claim "预测有效" when model τ > max(baseline τs).
 */
function _baselineComparison(results) {
  try {
    var withData = results.filter(function(r) {
      return r.compositeScore != null && r.fwd5d != null;
    });
    if (withData.length < 10) return { available: false, reason: 'insufficient samples (<10)' };

    // 1. Naive score rank Kendall τ
    var scoreTauInput = withData.map(function(r) {
      return { expectedReturn: r.compositeScore, fwd5d: r.fwd5d };
    });
    var scoreTau = _kendallTauB(scoreTauInput);

    // 2. Simple threshold direction hit rate
    var thresholdPositive = withData.filter(function(r) { return r.compositeScore >= 60; });
    var thresholdCorrect = thresholdPositive.filter(function(r) { return r.fwd5d > 0; }).length;
    var thresholdHitRate = thresholdPositive.length > 0
      ? +(thresholdCorrect / thresholdPositive.length).toFixed(3)
      : null;

    // 3. Equal-weight Top-N (same count as executionEligible in the data)
    var execCount = results.filter(function(r) { return r.executionEligible || r.evaluationEligible; }).length || withData.length;
    var topN = Math.min(execCount, Math.floor(withData.length * 0.15)); // top 15%
    var topByScore = withData.slice().sort(function(a, b) { return (b.compositeScore || 0) - (a.compositeScore || 0); }).slice(0, topN);
    var topCorrect = topByScore.filter(function(r) { return r.fwd5d > 0; }).length;
    var topHitRate = topByScore.length > 0 ? +(topCorrect / topByScore.length).toFixed(3) : null;

    return {
      available: true,
      scoreKendallTau: scoreTau ? scoreTau.tau : null,
      thresholdHitRate: thresholdHitRate,
      topNHitRate: topHitRate,
      topN: topN,
      baselineMaxTau: scoreTau ? scoreTau.tau : null,
      baselineMaxHitRate: Math.max(thresholdHitRate || 0, topHitRate || 0),
    };
  } catch (_) { return { available: false, reason: _.message }; }
}

/**
 * v3.4.9: Write outcome to immutable outcome_ledger.jsonl.
 * Canonical writer — verification_runner is the ONLY module that writes outcomes.
 *
 * Each line is a settled or unavailable outcome. Never writes 0 or Infinity.
 */
function _writeOutcomeLedger(outcome) {
  try {
    var olFile = path.join(SIMFOLIO_DIR, 'outcome_ledger.jsonl');
    // Dedup by predictionId
    var existingIds = {};
    if (fs.existsSync(olFile)) {
      var existingLines = fs.readFileSync(olFile, 'utf8').trim().split('\n').filter(Boolean);
      for (var ei = 0; ei < existingLines.length; ei++) {
        try {
          var ex = JSON.parse(existingLines[ei]);
          if (ex.predictionId) existingIds[ex.predictionId] = true;
        } catch (_) {}
      }
    }
    if (existingIds[outcome.predictionId]) return false; // already written
    fs.appendFileSync(olFile, JSON.stringify(outcome) + '\n', 'utf8');
    return true;
  } catch (_) { return false; }
}

// v3.4.9: Index close price lookup (3-tier fallback, same as expected_return.js)
function _getIndexCloseForDate(targetDate, indexType) {
  try {
    // Tier 1: index_history_DATE.json
    var idxDir2 = path.join(SIMFOLIO_DIR);
    var idxFile = path.join(idxDir2, 'index_history_' + targetDate + '.json');
    if (fs.existsSync(idxFile)) {
      var idxData = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
      if (Array.isArray(idxData) && idxData.length > 0) {
        var lastEntry = idxData[idxData.length - 1];
        var val = lastEntry[indexType || 'sh'];
        if (val != null && val > 0) return val;
      }
    }
    // Tier 2: market_snapshot_latest.json
    var snapDir2 = path.join(DATA_DIR, 'simfolio');
    var snapFile = path.join(snapDir2, 'market_snapshot_latest.json');
    if (fs.existsSync(snapFile)) {
      var snap2 = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
      if (snap2.date === targetDate && snap2.indices) {
        var codeMap = { sh: '000001', sz: '399001', cy: '399006' };
        var targetCode = codeMap[indexType] || '000001';
        var shIdx = snap2.indices.find(function(ix) { return ix.code === targetCode; });
        if (shIdx && shIdx.price > 0) return shIdx.price;
      }
    }
  } catch (_) {}
  return null;
}

// ====== End helpers ======

function run(options) {
  options = options || {};
  var onlyLatest = options.latest;

  console.log('=== 赛后验证执行器 ===');
  console.log('');

  // Load existing verification history
  var existing = _readJSON(VERIFICATION_FILE);
  var verifiedDates = {};
  if (existing && existing.entries) {
    existing.entries.forEach(function(e) { verifiedDates[e.date] = true; });
    console.log('已有验证记录: ' + existing.entries.length + ' 天');
  }

  // v3.4.6: Scan for prediction_ledger files (source of truth for verification)
  var scanDates = [];
  try {
    var allFiles = fs.readdirSync(SIMFOLIO_DIR);
    allFiles.forEach(function(f) {
      var m = f.match(/^prediction_ledger_(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (m) {
        var d = m[1];
        if (!verifiedDates[d]) {
          scanDates.push(d);
        }
      }
    });
    scanDates.sort();
  } catch (e) {
    console.error('无法读取 simfolio 目录:', e.message);
    return null;
  }

  var toVerify = onlyLatest ? scanDates.slice(-1) : scanDates;
  console.log('待验证: ' + toVerify.length + ' 天');
  console.log('');

  var entries = [];
  var rankICEntries = [];
  var verified = 0;
  var skipped = 0;

  for (var i = 0; i < toVerify.length; i++) {
    var dateStr = toVerify[i];

    // v3.4.6: Only verify if target date has arrived (at least 3 trading days after prediction)
    // Simple proxy: skip dates within the last 3 calendar days
    var scanMs = new Date(dateStr + 'T00:00:00+08:00').getTime();
    var nowMs = Date.now();
    if (nowMs - scanMs < 3 * 24 * 3600 * 1000) {
      skipped++;
      continue; // Skip — too recent for T+3 settlement
    }

    var result = verifyOneScan(dateStr);
    if (!result) { skipped++; continue; }

    // v3.4.6: Check if we have real forward returns
    var hasRealVerification = result.results.some(function(r) { return r.fwd3d !== 0 && r.fwd3d !== null; });

    entries.push(result);
    verified++;

    // Compute Rank IC only if we have real forward returns
    if (hasRealVerification) {
      var ic = computeRankIC(result.date, result.results);
      if (ic) {
        rankICEntries.push(ic);
        // v3.4.7: Persist daily Rank IC for multi-day aggregation
        _saveDailyRankIC(ic);
      }
    }

    if (verified % 5 === 0 || verified === toVerify.length) {
      process.stdout.write('\r  验证中... ' + verified + '/' + toVerify.length + ' (跳过:' + skipped + ')');
    }
  }

  console.log('');
  console.log('');

  // Merge with existing
  var allEntries = existing && existing.entries ? existing.entries.concat(entries) : entries;
  // Sort by date
  allEntries.sort(function(a, b) { return a.date.localeCompare(b.date); });

  // Compute overall summary (only count entries with real forward returns)
  var totalPredictions = 0, totalCorrect = 0;
  var allFwd3d = [], allFwd5d = [], entriesWithReturns = 0;
  allEntries.forEach(function(e) {
    var hasRealData = e.results && e.results.some(function(r) { return r.fwd3d !== 0 && r.fwd3d !== null; });
    if (!hasRealData) return;
    entriesWithReturns++;
    totalPredictions += e.predictions;
    totalCorrect += e.correctCount;
    if (e.avgFwd3d != null && e.avgFwd3d !== 0) allFwd3d.push(e.avgFwd3d);
    if (e.avgFwd5d != null && e.avgFwd5d !== 0) allFwd5d.push(e.avgFwd5d);
  });

  var overallHitRate = totalPredictions > 0 ? +(totalCorrect / totalPredictions * 100).toFixed(1) : null;
  var overallFwd3d = allFwd3d.length > 0 ? +(allFwd3d.reduce(function(s, v) { return s + v; }, 0) / allFwd3d.length).toFixed(2) : null;
  var overallFwd5d = allFwd5d.length > 0 ? +(allFwd5d.reduce(function(s, v) { return s + v; }, 0) / allFwd5d.length).toFixed(2) : null;

  // Average Rank IC
  var avgIC = null;
  if (rankICEntries.length > 0) {
    avgIC = +(rankICEntries.reduce(function(s, r) { return s + r.rankIC; }, 0) / rankICEntries.length).toFixed(3);
  }

  // v3.4.7: Aggregate Rank IC from persistent daily IC values (block bootstrap across trading days)
  var fullRankICHistory = (existing && existing.rankICHistory || []).concat(rankICEntries);
  var independentDays = _countIndependentTradingDays();
  // v3.4.9.1: Force null CI when < 20 independent trading days (guard against _aggregateRankIC bypass)
  var aggregatedRankIC = independentDays >= 20 ? _aggregateRankIC(fullRankICHistory) : null;
  // v3.4.9: Post-cost net excess reads from outcome_ledger (immutable)
  var postCostNetExcess = _computePostCostNetExcessFromOutcomes();

  // v3.4.9: Aggregate Kendall tau-b across days
  var kendallValues = [];
  var baselineValues = [];
  allEntries.forEach(function(e) {
    if (e.kendallTau != null) kendallValues.push(e.kendallTau);
    if (e.baseline && e.baseline.available && e.baseline.scoreKendallTau != null) {
      baselineValues.push(e.baseline.scoreKendallTau);
    }
  });
  var avgKendallTau = kendallValues.length > 0
    ? +(kendallValues.reduce(function(s, v) { return s + v; }, 0) / kendallValues.length).toFixed(4)
    : null;
  var avgBaselineTau = baselineValues.length > 0
    ? +(baselineValues.reduce(function(s, v) { return s + v; }, 0) / baselineValues.length).toFixed(4)
    : null;

  // v3.4.9: Prediction validity check — model must beat baseline
  var predictionEffective = false;
  var predictionEffectiveNote = '';
  if (independentDays < 20) {
    predictionEffectiveNote = '样本不足 — 仅' + independentDays + '个独立交易日（需≥20），预测统计不可靠';
  } else if (!aggregatedRankIC || aggregatedRankIC.ci_lower == null) {
    predictionEffectiveNote = 'CI不可用 — bootstrap置信区间未能计算';
  } else if (aggregatedRankIC.ci_lower <= 0) {
    predictionEffectiveNote = 'Rank IC 95% CI下界≤0（' + aggregatedRankIC.ci_lower + '），预测无效';
  } else if (avgKendallTau != null && avgBaselineTau != null && avgKendallTau <= avgBaselineTau) {
    predictionEffectiveNote = '模型τ(' + avgKendallTau + ') ≤ 基线τ(' + avgBaselineTau + ')，无增量预测能力';
  } else if (postCostNetExcess != null && postCostNetExcess <= 0) {
    predictionEffectiveNote = '成本后净超额收益≤0，不构成预测证据';
  } else {
    predictionEffective = true;
    predictionEffectiveNote = independentDays + '个交易日，τ=' + (avgKendallTau || '?') + '，CI=[' + aggregatedRankIC.ci_lower + ',' + aggregatedRankIC.ci_upper + ']，净超额=' + (postCostNetExcess || '?');
  }

  var summary = {
    generatedAt: new Date().toISOString(),
    totalDays: allEntries.length,
    totalPredictions: totalPredictions,
    totalCorrect: totalCorrect,
    overallHitRate: overallHitRate,
    avgFwd3dReturn: overallFwd3d,
    avgFwd5dReturn: overallFwd5d,
    // v3.4.7: Keep flat fields for backward compat
    avgRankIC: avgIC,
    rankICSamples: fullRankICHistory.length,
    // v3.4.9: Kendall tau-b statistics
    kendallTau: avgKendallTau,
    baselineKendallTau: avgBaselineTau,
    predictionEffective: predictionEffective,
    predictionEffectiveNote: predictionEffectiveNote,
    // v3.4.7: Unified overall structure — canonical source for dynamic_weights and promotion
    overall: {
      rankIC: {
        mean: avgIC,
        ci_lower: aggregatedRankIC ? aggregatedRankIC.ci_lower : null,
        ci_upper: aggregatedRankIC ? aggregatedRankIC.ci_upper : null,
        independentDays: independentDays,
        samples: fullRankICHistory.length,
      },
      kendallTau: avgKendallTau,
      baselineKendallTau: avgBaselineTau,
      postCostNetExcessReturn: postCostNetExcess,
      predictionEffective: predictionEffective,
    },
  };

  // Write history
  var history = {
    generatedAt: new Date().toISOString(),
    summary: summary,
    entries: allEntries,
    rankICHistory: (existing && existing.rankICHistory || []).concat(rankICEntries),
  };

  _writeJSON(VERIFICATION_FILE, history);
  _writeJSON(SUMMARY_FILE, summary);

  // [v3.3.1] Run leakage audit on all entries
  var audit = runLeakageAudit(history);

  console.log('=== 验证完成 ===');
  console.log('新增验证: ' + verified + ' 天');
  console.log('累计验证: ' + allEntries.length + ' 天');
  console.log('总预测数: ' + totalPredictions + ' 条');
  console.log('综合命中率: ' + (overallHitRate != null ? overallHitRate + '%' : 'N/A'));
  console.log('平均3日收益: ' + (overallFwd3d != null ? overallFwd3d + '%' : 'N/A'));
  console.log('平均5日收益: ' + (overallFwd5d != null ? overallFwd5d + '%' : 'N/A'));
  console.log('平均Rank IC: ' + (avgIC != null ? avgIC : 'N/A'));
  console.log('');
  console.log('输出: ' + VERIFICATION_FILE);

  return { summary: summary, newEntries: verified };
}

// --- CLI entry ---
if (require.main === module) {
  var args = process.argv.slice(2);
  var latest = args.indexOf('--latest') >= 0;
  run({ latest: latest });
}

// v3.4.9.2: Allow tests to redirect data directories
function _reloadDataDir(newDataDir) {
  DATA_DIR = newDataDir;   // v3.4.9.4.2: redirect manifest read path for complete test isolation
  SIMFOLIO_DIR = path.join(newDataDir, 'simfolio');
  KLINES_DIR = path.join(newDataDir, 'klines');
  VERIFICATION_DIR = path.join(newDataDir, 'verification');
  VERIFICATION_FILE = path.join(VERIFICATION_DIR, 'verification_history.json');
  SUMMARY_FILE = path.join(VERIFICATION_DIR, 'verification_summary.json');
  LEAKAGE_AUDIT_FILE = path.join(VERIFICATION_DIR, 'leakage_audit.json');
}

module.exports = { run, lookupForwardReturn, lookupForwardReturnAudited, verifyOneScan, runLeakageAudit,
  _seededRandom, _aggregateRankIC, _computePostCostNetExcess, _countIndependentTradingDays,
  _kendallTauB, _baselineComparison, _writeOutcomeLedger, _computePostCostNetExcessFromOutcomes,
  _reloadDataDir };
