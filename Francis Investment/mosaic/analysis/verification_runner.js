/**
 * verification_runner.js — [v3.2.2] 赛后验证执行器
 *
 * 从历史 scan_records 提取预测，对照实际 K 线计算验证指标。
 * 每天收盘后运行，输出到 verification/ 目录供前端仪表板消费。
 *
 * 数据源:
 *   - simfolio/scan_records_*.json (历史预测)
 *   - klines/*.json (实际收益)
 *
 * 输出:
 *   - data/verification/daily_verification.json (每日验证记录)
 *   - data/verification/verification_summary.json (汇总)
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
 * Verify one scan record: compare top5 predictions with actual forward returns
 */
function verifyOneScan(scanRecord) {
  if (!scanRecord || !scanRecord.top5 || scanRecord.top5.length === 0) return null;

  var date = scanRecord.date || scanRecord.time ? (scanRecord.date || scanRecord.time).slice(0, 10) : null;
  if (!date) return null;

  var results = [];
  var top5 = scanRecord.top5;

  for (var i = 0; i < top5.length; i++) {
    var pred = top5[i];
    var code = pred.code;
    if (!code) continue;

    var fwd = lookupForwardReturn(code, date);
    if (!fwd) continue;

    var directionCorrect = (pred.score >= 60 && fwd.fwd3d > 0) || (pred.score < 60 && fwd.fwd3d <= 0);

    results.push({
      code: code,
      name: pred.name || code,
      score: pred.score,
      rating: pred.rating || '-',
      fwd1d: fwd.fwd1d,
      fwd3d: fwd.fwd3d,
      fwd5d: fwd.fwd5d,
      fwd10d: fwd.fwd10d,
      directionCorrect: directionCorrect,
    });
  }

  if (results.length === 0) return null;

  // Aggregate stats
  var correctCount = results.filter(function(r) { return r.directionCorrect; }).length;
  var avgReturn3d = results.reduce(function(s, r) { return s + (r.fwd3d || 0); }, 0) / results.length;
  var avgReturn5d = results.reduce(function(s, r) { return s + (r.fwd5d || 0); }, 0) / results.length;

  return {
    date: date,
    predictions: results.length,
    correctCount: correctCount,
    directionHitRate: +(correctCount / results.length * 100).toFixed(1),
    avgFwd3d: +avgReturn3d.toFixed(2),
    avgFwd5d: +avgReturn5d.toFixed(2),
    results: results,
  };
}

/**
 * Compute Rank IC from scan record's top5 vs actual forward returns
 */
function computeRankIC(date, results) {
  if (!results || results.length < 3) return null;

  // Rank by score
  var byScore = results.slice().sort(function(a, b) { return b.score - a.score; });
  var byReturn = results.slice().sort(function(a, b) { return (b.fwd5d || 0) - (a.fwd5d || 0); });

  var scoreRank = {};
  var returnRank = {};
  for (var i = 0; i < byScore.length; i++) { scoreRank[byScore[i].code] = i + 1; }
  for (var j = 0; j < byReturn.length; j++) { returnRank[byReturn[j].code] = j + 1; }

  var n = results.length;
  var dSqSum = 0;
  for (var k = 0; k < results.length; k++) {
    var code = results[k].code;
    var d = (scoreRank[code] || 0) - (returnRank[code] || 0);
    dSqSum += d * d;
  }

  var rankIC = 1 - (6 * dSqSum) / (n * (n * n - 1));
  return {
    date: date,
    rankIC: +rankIC.toFixed(3),
    samples: n,
    interpretation: rankIC > 0.2 ? '强正相关' : rankIC > 0.1 ? '弱正相关' : rankIC > 0 ? '微正相关' : rankIC > -0.1 ? '微负相关' : '负相关',
  };
}

// ====== 主流程 ======

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

  // Scan for scan_records files
  var scanFiles = [];
  try {
    var allFiles = fs.readdirSync(SIMFOLIO_DIR);
    allFiles.forEach(function(f) {
      var m = f.match(/^scan_records_(\d{4}-\d{2}-\d{2})\.json$/);
      if (m) {
        var d = m[1];
        if (!verifiedDates[d]) {
          scanFiles.push({ file: f, date: d });
        }
      }
    });
    scanFiles.sort(function(a, b) { return a.date.localeCompare(b.date); });
  } catch (e) {
    console.error('无法读取 simfolio 目录:', e.message);
    return null;
  }

  var toVerify = onlyLatest ? scanFiles.slice(-1) : scanFiles;
  console.log('待验证: ' + toVerify.length + ' 天');
  console.log('');

  var entries = [];
  var rankICEntries = [];
  var verified = 0;
  var skipped = 0;

  for (var i = 0; i < toVerify.length; i++) {
    var sf = toVerify[i];
    var records = _readJSON(path.join(SIMFOLIO_DIR, sf.file));
    if (!records) continue;

    // Handle both array and single-object formats
    var scanList = Array.isArray(records) ? records : [records];

    // Deduplicate by date: take only the first full scan per day
    var seenDates = {};
    var deduped = [];
    for (var j = 0; j < scanList.length; j++) {
      var s = scanList[j];
      if (!s || !s.top5 || s.top5.length === 0) continue;
      var sd = s.time ? s.time.slice(0, 10) : s.date ? s.date.slice(0, 10) : null;
      if (!sd || seenDates[sd]) continue;
      seenDates[sd] = true;
      s.date = sd; // Normalize date field
      deduped.push(s);
    }

    for (var j = 0; j < deduped.length; j++) {
      var result = verifyOneScan(deduped[j]);
      if (!result) { skipped++; continue; }

      // Only verify if at least 3 trading days have passed (fwd3d available)
      var hasRealVerification = result.results.some(function(r) { return r.fwd3d !== 0 && r.fwd3d !== null; });

      entries.push(result);
      verified++;

      // Compute Rank IC only if we have real forward returns
      if (hasRealVerification) {
        var ic = computeRankIC(result.date, result.results);
        if (ic) rankICEntries.push(ic);
      }

      if (verified % 5 === 0 || verified === toVerify.length) {
        process.stdout.write('\r  验证中... ' + verified + '/' + toVerify.length + ' (跳过:' + skipped + ')');
      }
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

  var summary = {
    generatedAt: new Date().toISOString(),
    totalDays: allEntries.length,
    totalPredictions: totalPredictions,
    totalCorrect: totalCorrect,
    overallHitRate: overallHitRate,
    avgFwd3dReturn: overallFwd3d,
    avgFwd5dReturn: overallFwd5d,
    avgRankIC: avgIC,
    rankICSamples: rankICEntries.length,
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

module.exports = { run, lookupForwardReturn, verifyOneScan };
