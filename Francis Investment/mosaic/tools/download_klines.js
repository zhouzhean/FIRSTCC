/**
 * download_klines.js — 批量下载低价(≤20元)非创业板A股子策略K线数据
 *
 * 从腾讯 ifzq API 批量下载日K线（前复权）。
 * 跳过已有缓存，5 并发下载。
 *
 * 使用:
 *   node mosaic/tools/download_klines.js              # 默认：追加缺失的
 *   node mosaic/tools/download_klines.js --dry-run     # 仅统计
 *   node mosaic/tools/download_klines.js --max 500     # 限制下载数量
 *   node mosaic/tools/download_klines.js --concurrency 10  # 10并发
 */

var fs = require('fs');
var path = require('path');
var https = require('https');

var BASE_DIR = path.join(__dirname, '..', '..');
var KLINES_DIR = path.join(BASE_DIR, 'report-engine', 'data', 'klines');

// 实际A股代码段（排除大量空白段）
// 上海主板 600000-605999, 科创板 688000-689999
// 深圳主板 000001-003099, 创业板 300000-301999
var RANGES = [
  { label: 'SH主板', start: 600000, end: 605999 },
  { label: 'SH科创板', start: 688000, end: 689999 },
  { label: 'SZ主板', start: 1, end: 3099 },
  { label: 'SZ创业板', start: 300000, end: 301999 },
];

// ====== 工具函数 ======

function delay(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

function pad6(n) {
  return String(n).padStart(6, '0');
}

function fetchKlines(code) {
  var market = code.startsWith('6') ? 'sh' : 'sz';
  var symbol = market + code;

  return new Promise(function(resolve) {
    var url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get' +
      '?param=' + symbol + ',day,2020-01-01,,640,qfq';

    var req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try {
          var json = JSON.parse(data);
          if (json && json.code === 0 && json.data && json.data[symbol]) {
            var stored = json.data[symbol];
            var dayKey = null;
            var keys = Object.keys(stored);
            for (var ki = 0; ki < keys.length; ki++) {
              if (keys[ki].indexOf('qfqday') >= 0) { dayKey = keys[ki]; break; }
            }
            if (dayKey && stored[dayKey]) {
              var raw = stored[dayKey];
              var klines = raw.map(function(row) {
                return {
                  date: row[0],
                  open: parseFloat(row[1]),
                  close: parseFloat(row[2]),
                  high: parseFloat(row[3]),
                  low: parseFloat(row[4]),
                  volume: parseFloat(row[5]),
                  turnover: 0,
                };
              });
              resolve(klines);
              return;
            }
          }
          resolve([]);
        } catch (e) {
          resolve([]);
        }
      });
    });

    req.on('error', function() { resolve([]); });
    req.setTimeout(8000, function() { req.destroy(); resolve([]); });
  });
}

function cleanKlines(klines) {
  if (!klines || klines.length === 0) return [];
  var cleaned = [];
  var seenDates = {};
  for (var i = 0; i < klines.length; i++) {
    var k = klines[i];
    if (!k.volume || k.volume <= 0) continue;
    if (!k.close || k.close <= 0) continue;
    if (seenDates[k.date]) continue;
    seenDates[k.date] = true;
    cleaned.push(k);
  }
  cleaned.sort(function(a, b) { return a.date.localeCompare(b.date); });
  return cleaned;
}

/**
 * Check whether cached K-line data is still valid.
 * Returns false (needs redownload) if:
 *   1. File doesn't exist
 *   2. Data is older than 24 hours (stale)
 *   3. K-line count < 100 bars (too few)
 *   4. Gap between any adjacent dates > 5 trading days (discontinuity)
 */
function cacheValid(cacheFile) {
  try {
    if (!fs.existsSync(cacheFile)) return false;
    var raw = fs.readFileSync(cacheFile, 'utf8');
    var cached = JSON.parse(raw);
    var klines = cached.klines;
    if (!klines || !Array.isArray(klines) || klines.length === 0) return false;

    // 1. Freshness: expire after 24 hours
    var ageMs = Date.now() - (cached.ts || 0);
    if (ageMs > 24 * 60 * 60 * 1000) return false;

    // 2. Length: at least 100 bars
    if (klines.length < 100) return false;

    // 3. Continuity: no gaps > 5 trading days between adjacent dates
    for (var i = 1; i < klines.length; i++) {
      var prev = klines[i - 1].date;
      var curr = klines[i].date;
      if (!prev || !curr) continue;
      var prevDate = new Date(prev);
      var currDate = new Date(curr);
      // Simple calendar day diff (not trading-day, but >5 calendar days indicates a real gap)
      var dayDiff = Math.abs((currDate - prevDate) / (24 * 60 * 60 * 1000));
      if (dayDiff > 7) return false; // > 7 calendar days likely means missing trading week
    }

    return true;
  } catch (_) {
    return false;
  }
}

function downloadOne(target, stats) {
  var cacheFile = path.join(KLINES_DIR, target.code + '.json');
  if (cacheValid(cacheFile)) {
    stats.skipped++;
    return Promise.resolve();
  }
  // If cache exists but invalid, increment re-download counter instead of skipped
  if (fs.existsSync(cacheFile)) {
    stats.revalidated = (stats.revalidated || 0) + 1;
  }
  return fetchKlines(target.code).then(function(klines) {
    if (klines.length > 0) {
      var cleaned = cleanKlines(klines);
      if (cleaned.length > 0) {
        fs.writeFileSync(cacheFile, JSON.stringify({
          ts: Date.now(),
          code: target.code,
          klines: cleaned,
        }));
        stats.downloaded++;
      } else {
        stats.empty++;
      }
    } else {
      stats.empty++;
    }
  }).catch(function() {
    stats.failed++;
  });
}

// ====== 并发池 ======

function downloadPool(targets, concurrency, stats, maxDownloads) {
  return new Promise(function(resolve) {
    var idx = 0;
    var active = 0;
    var startTime = Date.now();
    var total = Math.min(targets.length, maxDownloads || Infinity);

    function next() {
      while (active < concurrency && idx < total) {
        var t = targets[idx];
        idx++;
        active++;

        downloadOne(t, stats).then(function() {
          active--;
          var done = stats.downloaded + stats.empty + stats.failed + stats.skipped;
          if (done % 100 === 0 || done === total) {
            var elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
            var rate = (idx / elapsed).toFixed(1);
            var eta = total > idx ? ((total - idx) / (idx / elapsed)).toFixed(0) : '0';
            process.stdout.write('\r  [' + done + '/' + total + '] ' +
              'D:' + stats.downloaded + ' E:' + stats.empty +
              ' F:' + stats.failed + ' S:' + stats.skipped +
              ' | ' + rate + '/s | ETA:' + eta + 's   ');
          }
          next();
        });
      }
      if (active === 0 && idx >= total) {
        var totalElapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        console.log('');
        console.log('');
        console.log('=== 完成 ===');
        console.log('耗时: ' + totalElapsed + 's');
        console.log('新增: ' + stats.downloaded + ' 只');
        console.log('空数据: ' + stats.empty + ' 只');
        console.log('失败: ' + stats.failed + ' 只');
        console.log('跳过(已有): ' + stats.skipped + ' 只');
        resolve(stats);
      }
    }

    // Start initial batch
    for (var i = 0; i < concurrency && i < total; i++) {
      next();
    }
  });
}

// ====== 主流程 ======

async function main() {
  var args = process.argv.slice(2);
  var dryRun = args.indexOf('--dry-run') >= 0;
  var maxDownloads = Infinity;
  var concurrency = 5;

  var maxIdx = args.indexOf('--max');
  if (maxIdx >= 0 && args[maxIdx + 1]) {
    maxDownloads = parseInt(args[maxIdx + 1], 10) || Infinity;
  }
  var concIdx = args.indexOf('--concurrency');
  if (concIdx >= 0 && args[concIdx + 1]) {
    concurrency = parseInt(args[concIdx + 1], 10) || 5;
  }

  // Load existing cache
  var existing = {};
  if (fs.existsSync(KLINES_DIR)) {
    var files = fs.readdirSync(KLINES_DIR);
    files.forEach(function(f) {
      var code = f.replace('.json', '');
      if (/^\d{6}$/.test(code)) {
        existing[code] = true;
      }
    });
  }

  console.log('=== K线批量下载工具 ===');
  console.log('已有缓存: ' + Object.keys(existing).length + ' 只');
  console.log('并发数: ' + concurrency);
  if (maxDownloads < Infinity) console.log('限制: ' + maxDownloads + ' 只');
  if (dryRun) console.log('*** DRY RUN ***');
  console.log('');

  // Build target list
  var targets = [];
  RANGES.forEach(function(r) {
    for (var i = r.start; i <= r.end; i++) {
      var code = pad6(i);
      if (!existing[code]) {
        targets.push({ code: code, label: r.label });
      }
    }
  });

  console.log('待下载: ' + targets.length + ' 只');
  console.log('');

  if (dryRun) {
    targets.slice(0, 20).forEach(function(t) {
      console.log('  ' + t.code + '  [' + t.label + ']');
    });
    console.log('  ...');
    return;
  }

  var stats = { downloaded: 0, empty: 0, failed: 0, skipped: 0 };
  var finalExisting = Object.keys(existing).length;
  console.log('开始下载 (并发=' + concurrency + ')...');
  console.log('');

  await downloadPool(targets, concurrency, stats, maxDownloads);

  var totalNow = finalExisting + stats.downloaded;
  console.log('原有: ' + finalExisting + ' 只');
  console.log('当前: ' + totalNow + ' 只');
}

main().catch(function(e) {
  console.error('FATAL:', e.message);
  process.exit(1);
});
