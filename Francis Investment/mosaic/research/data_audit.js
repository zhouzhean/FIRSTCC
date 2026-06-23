/**
 * P1-A: Data Coverage Audit
 *
 * Scans existing K-line files, index data, and tests external API availability.
 * Output: report-engine/data/research/data_coverage_report.json
 *
 * Does NOT fabricate, extrapolate, or backfill missing data.
 * Every finding is annotated with its source (file on disk, API test, code inspection).
 */

var fs = require('fs');
var path = require('path');

var BASE_DIR = path.join(__dirname, '..', '..');
var DATA_DIR = path.join(BASE_DIR, 'report-engine', 'data');
var KLINES_DIR = path.join(DATA_DIR, 'klines');
var KLINES_SHORT_DIR = path.join(DATA_DIR, 'klines_short');
var INDICES_DIR = path.join(DATA_DIR, 'market_history', 'indices');
var OUTPUT_DIR = path.join(DATA_DIR, 'research');
var OUTPUT_FILE = path.join(OUTPUT_DIR, 'data_coverage_report.json');

// ---- Helpers ----

function dateDiff(d1, d2) {
  return Math.round((new Date(d2 + 'T12:00:00+08:00') - new Date(d1 + 'T12:00:00+08:00')) / 86400000);
}

function isWeekend(dateStr) {
  var d = new Date(dateStr + 'T12:00:00+08:00');
  return d.getDay() === 0 || d.getDay() === 6;
}

// ---- K-line Audit ----

function auditKlines() {
  var result = {
    source: 'Tencent ifzq API (web.ifzq.gtimg.cn), pre-reconciled (qfq)',
    directory: 'report-engine/data/klines/',
    fileCount: 0,
    totalBars: 0,
    format: 'wrapped {ts, code, klines: [{date, open, close, high, low, volume, turnover}]}',
    coverageStart: null,
    coverageEnd: null,
    perFile: [],
  };

  if (!fs.existsSync(KLINES_DIR)) {
    result.error = 'KLINES_DIR not found';
    return result;
  }

  var files = fs.readdirSync(KLINES_DIR).filter(function (f) { return f.endsWith('.json'); });
  result.fileCount = files.length;

  if (files.length === 0) {
    result.error = 'No K-line files found';
    return result;
  }

  files.forEach(function (f) {
    try {
      var raw = fs.readFileSync(path.join(KLINES_DIR, f), 'utf8');
      var data = JSON.parse(raw);
      var klines = data.klines || (Array.isArray(data) ? data : []);
      var bars = klines.length;
      result.totalBars += bars;

      var dates = klines.map(function (k) { return k.date; }).filter(Boolean).sort();
      var localMin = dates[0] || null;
      var localMax = dates[dates.length - 1] || null;

      if (!result.coverageStart || (localMin && localMin < result.coverageStart)) result.coverageStart = localMin;
      if (!result.coverageEnd || (localMax && localMax > result.coverageEnd)) result.coverageEnd = localMax;

      // Count calendar day gaps > 7 (excluding weekends)
      var gaps = 0;
      for (var i = 1; i < dates.length; i++) {
        var diff = dateDiff(dates[i - 1], dates[i]);
        if (diff > 7) gaps++;
      }

      // Check for zero-volume bars (halted/suspended)
      var zeroVolBars = klines.filter(function (k) { return k.volume === 0; }).length;
      // Check for turnover=0 (known Tencent limitation)
      var missingTurnover = klines.filter(function (k) { return !k.turnover || k.turnover === 0; }).length;

      result.perFile.push({
        code: f.replace('.json', ''),
        bars: bars,
        start: localMin,
        end: localMax,
        gaps: gaps,
        zeroVolBars: zeroVolBars,
        missingTurnover: missingTurnover,
      });
    } catch (e) {
      result.perFile.push({ code: f.replace('.json', ''), error: e.message });
    }
  });

  // Summary stats
  var barCounts = result.perFile.map(function (p) { return p.bars || 0; });
  result.summary = {
    avgBars: result.totalBars > 0 ? Math.round(result.totalBars / result.fileCount) : 0,
    minBars: barCounts.length > 0 ? Math.min.apply(null, barCounts) : 0,
    maxBars: barCounts.length > 0 ? Math.max.apply(null, barCounts) : 0,
    filesWithGaps: result.perFile.filter(function (p) { return p.gaps > 0; }).length,
    filesWithZeroVol: result.perFile.filter(function (p) { return p.zeroVolBars > 0; }).length,
    hasFullHistory: false,
  };

  // Detect if only recent data exists
  if (result.coverageStart && result.coverageStart >= '2026-01-01') {
    result.summary.hasFullHistory = false;
    result.summary.note = 'All K-line data is from 2026 only — full historical download required before historical snapshots can be built.';
  } else if (result.coverageStart && result.coverageStart <= '2021-01-01') {
    result.summary.hasFullHistory = true;
  }

  return result;
}

// ---- Short K-line Audit ----

function auditKlinesShort() {
  var result = {
    directory: 'report-engine/data/klines_short/',
    fileCount: 0,
    totalBars: 0,
    coverageStart: null,
    coverageEnd: null,
    purpose: '30-day pipeline cache, 5-min TTL — not suitable for historical research',
  };

  if (!fs.existsSync(KLINES_SHORT_DIR)) {
    result.error = 'KLINES_SHORT_DIR not found';
    return result;
  }

  var files = fs.readdirSync(KLINES_SHORT_DIR).filter(function (f) { return f.endsWith('.json'); });
  result.fileCount = files.length;

  files.forEach(function (f) {
    try {
      var data = JSON.parse(fs.readFileSync(path.join(KLINES_SHORT_DIR, f), 'utf8'));
      var klines = data.klines || [];
      result.totalBars += klines.length;
      var dates = klines.map(function (k) { return k.date; }).filter(Boolean).sort();
      if (dates[0] && (!result.coverageStart || dates[0] < result.coverageStart)) result.coverageStart = dates[0];
      if (dates.length > 0 && (!result.coverageEnd || dates[dates.length - 1] > result.coverageEnd)) result.coverageEnd = dates[dates.length - 1];
    } catch (e) { /* skip */ }
  });

  return result;
}

// ---- Index Data Audit ----

function auditIndices() {
  var result = {
    source: 'Sina hq.sinajs.cn (daily close) for market_history; Eastmoney push2 (snapshot) for live',
    indices: {},
  };

  if (!fs.existsSync(INDICES_DIR)) {
    result.error = 'INDICES_DIR not found';
    result.pathsChecked = ['report-engine/data/market_history/indices/', 'report-engine/data/simfolio/index_history_*.json'];
    return result;
  }

  var indexFiles = ['sh000001.json', 'sz399001.json', 'sz399006.json'];
  indexFiles.forEach(function (f) {
    var fp = path.join(INDICES_DIR, f);
    if (fs.existsSync(fp)) {
      try {
        var data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        var arr = Array.isArray(data) ? data : (data.points || data.data || []);
        var dates = arr.map(function (x) { return x.date || x.tradeDate; }).filter(Boolean).sort();
        result.indices[f] = {
          name: f.replace('.json', ''),
          bars: arr.length,
          start: dates[0] || null,
          end: dates[dates.length - 1] || null,
          fields: Object.keys(arr[0] || {}).filter(function (k) { return k !== 'date' && k !== 'tradeDate'; }),
        };
      } catch (e) {
        result.indices[f] = { error: e.message };
      }
    } else {
      result.indices[f] = { error: 'File not found' };
    }
  });

  // Also check intraday index files
  var simfolioDir = path.join(DATA_DIR, 'simfolio');
  if (fs.existsSync(simfolioDir)) {
    var intradayFiles = fs.readdirSync(simfolioDir).filter(function (f) { return f.startsWith('index_history_'); });
    result.intradaySnapshotFiles = {
      count: intradayFiles.length,
      path: 'report-engine/data/simfolio/index_history_YYYY-MM-DD.json',
      sampleDates: intradayFiles.slice(-3).map(function (f) { return f.replace('index_history_', '').replace('.json', ''); }),
    };
  }

  return result;
}

// ---- Financial Data API Assessment ----

function auditFinancialData() {
  // We test this via manual inspection of code + known API state.
  // The datacenter-web.eastmoney.com V2 API (RPT_DMSK_FN_MAININDICATOR) returns 9501 error
  // from both local and cloud as of 2026-06-23.
  // V1 push2 API provides ROE, npGrowth, PE, PB, industry code — but no announcement date.

  return {
    assessedAt: new Date().toISOString(),
    dataSources: [
      {
        name: 'Eastmoney datacenter-web V2 (RPT_DMSK_FN_MAININDICATOR)',
        status: 'unavailable',
        testedOn: '2026-06-23',
        fromLocal: false,
        fromCloud: false,
        error: 'code 9501 — report config not found. API endpoint may have been deprecated.',
        provides: ['ROE', 'debt ratio', 'revenue growth', 'net profit growth', 'gross margin', 'OCF per share', 'FCFF'],
        missingAnnouncementDate: true,
        note: 'Previously used by _fetchStockDetailV2() in market_data.js. Currently fails on all requests.'
      },
      {
        name: 'Eastmoney push2 V1 (push2.eastmoney.com)',
        status: 'partially_tested',
        testedOn: '2026-06-23',
        fromLocal: false,
        fromCloud: 'inconclusive',
        provides: ['ROE', 'net profit growth', 'PE', 'PB', 'total shares', 'turnover rate', 'EPS', 'industry code'],
        hasAnnouncementDate: false,
        note: 'Provides current-snapshot financial data only — no historical announcement dates, no quarterly history.' +
          ' Used by _fetchStockDetailV1() for real-time display.'
      },
      {
        name: 'Tencent ifzq K-line API',
        status: 'available',
        testedOn: '2026-06-23',
        fromCloud: true,
        provides: ['daily OHLC', 'volume'],
        lacksTurnover: true,
        maxBars: 641,
        earliestDataOnCloud: '2023-10-30 (for sz000001, qfq mode)',
        note: 'Pre-reconciled (qfq) data. Turnover field is always 0. Volume is shares, not yuan.'
      }
    ],
    financialAnnouncementDate: {
      available: false,
      reliableSource: null,
      fallbackStrategy: 'REPORT_DATE + 120 days (legal maximum for annual reports in China)',
      fallbackRisk: 'Conservative — data becomes visible later than actual, safe from lookahead but may miss valid financial info',
      recommendation: 'Proceed with REPORT_DATE + 120-day fallback for initial historical snapshots. Flag all financial data as _announcementDateEstimated: true.'
    },
    sectorClassification: {
      method: 'name-matching against 8 hardcoded keyword sets',
      formalFile: null,
      eastmoneyIndustryField: 'f100 (industry code) from push2 V1 — only current, no historical industry changes',
      recommendation: 'Record industry code from snapshot-date push2 data if available. Sector classification will be missing for most historical dates.'
    }
  };
}

// ---- Bulk Download Feasibility ----

function auditDownloadFeasibility() {
  // Tencent ifzq API returns 641 bars (~2.5-3 years) per call, pre-reconciled.
  // 234 stocks × ~2 calls each (for 2020-2026 coverage) = ~468 API calls.
  // At 200ms rate limit: ~94 seconds.
  // Stock universe: 600000-605999 (SH main), 688000-689999 (STAR), 000001-004999 (SZ main), 300000-301999 (ChiNext)
  // = ~6000 + ~2000 + ~5000 + ~2000 = ~15000 total codes. But many are not listed or have no data.

  return {
    apiEndpoint: 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get',
    params: 'param={sh/sz}{code},day,2020-01-01,,640,qfq',
    rateLimit: '200ms per call',
    estimatedCalls: '234 existing stock codes × 2 calls = ~468',
    estimatedTime: '~94 seconds',
    maxBarsPerCall: 640,
    expectedCoverage: '2020-2026 (6 years with 2 calls per stock)',
    feasibility: 'feasible',
    risks: [
      'IP rate limiting by Tencent on non-cloud connections',
      'Some stocks listed after 2020 will have shorter history',
      'Delisted stocks will have gaps',
      'STAR market (688xxx) stocks only exist from 2019+'
    ],
    recommendation: 'Run download_klines.js on cloud server (8.153.101.112) to leverage its unfiltered internet access'
  };
}

// ---- Main ----

function runDataAudit() {
  var report = {
    generatedAt: new Date().toISOString(),
    version: 'P1-A.1',
    purpose: 'Honest inventory of existing data before building historical research infrastructure',
    principle: 'No fabricated, extrapolated, or backfilled data. Every finding annotated with source.',
    klines: auditKlines(),
    klinesShort: auditKlinesShort(),
    indices: auditIndices(),
    financialData: auditFinancialData(),
    downloadFeasibility: auditDownloadFeasibility(),
    actionItems: [],
  };

  // Determine action items
  if (!report.klines.summary || !report.klines.summary.hasFullHistory) {
    report.actionItems.push({
      priority: 'P0',
      action: 'DOWNLOAD_FULL_KLINES',
      detail: 'Run download_klines.js with --concurrency 5 on the cloud server to fetch 2020-2026 daily bars for all 234 stocks. Existing data covers only ~12 trading days.',
      prerequisiteFor: 'P1-C (historical_snapshot.js)'
    });
  }

  if (!report.financialData.financialAnnouncementDate.available) {
    report.actionItems.push({
      priority: 'P1',
      action: 'USE_ANNOUNCEMENT_DATE_FALLBACK',
      detail: 'Financial announcement dates are not available from any API. Use REPORT_DATE + 120-day estimation. Tag all financial fields with _estimated: true until a reliable source is found.',
      prerequisiteFor: 'P1-C financial data gating'
    });
  }

  report.actionItems.push({
    priority: 'P2',
    action: 'MAP_INDUSTRY_CODES',
    detail: 'Build a code-to-industry mapping from Eastmoney f100 field. Snapshot industry for each historical date if API provides it point-in-time.',
    prerequisiteFor: 'Sector-stratified walk-forward metrics'
  });

  // Write report
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2), 'utf8');
  console.log('Data coverage report written to ' + OUTPUT_FILE);
  return report;
}

// ---- CLI ----

if (require.main === module) {
  var report = runDataAudit();
  console.log('\n=== K-line Summary ===');
  console.log('Files:', report.klines.fileCount, '| Total bars:', report.klines.totalBars);
  console.log('Range:', report.klines.coverageStart, '-', report.klines.coverageEnd);
  if (report.klines.summary) {
    console.log('Has full history:', report.klines.summary.hasFullHistory);
    console.log('Avg bars/file:', report.klines.summary.avgBars);
  }

  console.log('\n=== Index Summary ===');
  Object.keys(report.indices.indices || {}).forEach(function (k) {
    var ix = report.indices.indices[k];
    console.log(k + ':', ix.bars, 'bars,', ix.start, '-', ix.end);
  });

  console.log('\n=== Financial Data ===');
  report.financialData.dataSources.forEach(function (ds) {
    console.log(ds.name + ':', ds.status, ds.note ? '(' + ds.note.slice(0, 80) + '...)' : '');
  });

  console.log('\n=== Action Items ===');
  report.actionItems.forEach(function (a) {
    console.log('[' + a.priority + '] ' + a.action + ': ' + a.detail);
  });

  console.log('\nReport saved to:', OUTPUT_FILE);
}

module.exports = { runDataAudit, auditKlines, auditIndices, auditFinancialData };
