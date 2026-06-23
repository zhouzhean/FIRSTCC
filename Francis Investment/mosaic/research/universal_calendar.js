/**
 * P1-B: Universal Trading Calendar (2020-2026)
 *
 * Extracted from bootstrap_history.js generateTradingDays().
 * Provides a single source of truth for trading date calculations.
 *
 * Cached to report-engine/data/research/trading_calendar_2020_2026.json
 * to avoid repeated computation across research modules.
 *
 * Functions:
 *   loadCalendar()        → array of 'YYYY-MM-DD' (all trading days)
 *   isTradingDay(date)    → boolean
 *   getTradingDay(date, offset) → 'YYYY-MM-DD' or null
 *   countTradingDays(start, end) → number
 */

var path = require('path');
var fs = require('fs');

var BASE_DIR = path.join(__dirname, '..', '..');
var DATA_DIR = path.join(BASE_DIR, 'report-engine', 'data');
var RESEARCH_DIR = path.join(DATA_DIR, 'research');
var CALENDAR_FILE = path.join(RESEARCH_DIR, 'trading_calendar_2020_2026.json');

// Chinese holidays for 2020-2026 (all major exchange closures)
var HOLIDAYS_2020_2026 = [
  // 2020
  '2020-01-01',
  '2020-01-24', '2020-01-27', '2020-01-28', '2020-01-29', '2020-01-30', '2020-01-31',
  '2020-04-06',
  '2020-05-01', '2020-05-04', '2020-05-05',
  '2020-06-25', '2020-06-26',
  '2020-10-01', '2020-10-02', '2020-10-05', '2020-10-06', '2020-10-07', '2020-10-08',
  // 2021
  '2021-01-01',
  '2021-02-11', '2021-02-12', '2021-02-15', '2021-02-16', '2021-02-17',
  '2021-04-05',
  '2021-05-03', '2021-05-04', '2021-05-05',
  '2021-06-14',
  '2021-09-20', '2021-09-21',
  '2021-10-01', '2021-10-04', '2021-10-05', '2021-10-06', '2021-10-07',
  // 2022
  '2022-01-03',
  '2022-01-31', '2022-02-01', '2022-02-02', '2022-02-03', '2022-02-04',
  '2022-04-04', '2022-04-05',
  '2022-05-02', '2022-05-03', '2022-05-04',
  '2022-06-03',
  '2022-09-12',
  '2022-10-03', '2022-10-04', '2022-10-05', '2022-10-06', '2022-10-07',
  // 2023
  '2023-01-02',
  '2023-01-23', '2023-01-24', '2023-01-25', '2023-01-26', '2023-01-27',
  '2023-04-05',
  '2023-05-01', '2023-05-02', '2023-05-03',
  '2023-06-22', '2023-06-23',
  '2023-09-29',
  '2023-10-02', '2023-10-03', '2023-10-04', '2023-10-05', '2023-10-06',
  // 2024
  '2024-01-01',
  '2024-02-12', '2024-02-13', '2024-02-14', '2024-02-15', '2024-02-16',
  '2024-04-04', '2024-04-05',
  '2024-05-01', '2024-05-02', '2024-05-03',
  '2024-06-10',
  '2024-09-17',
  '2024-10-01', '2024-10-02', '2024-10-03', '2024-10-04', '2024-10-07',
  // 2025
  '2025-01-01',
  '2025-01-29', '2025-01-30', '2025-01-31', '2025-02-03', '2025-02-04',
  '2025-04-04',
  '2025-05-01', '2025-05-02',
  '2025-06-02',
  '2025-09-26',
  '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-06', '2025-10-07',
  // 2026
  '2026-01-01',
  '2026-05-01', '2026-05-04', '2026-05-05',
  '2026-06-19',
  '2026-09-25',
  '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
];

function _buildHolidaySet() {
  var set = Object.create(null);
  HOLIDAYS_2020_2026.forEach(function (d) { set[d] = true; });
  return set;
}

var _holidaySet = _buildHolidaySet();

function _isTradingDay(dateStr) {
  var d = new Date(dateStr + 'T12:00:00+08:00');
  var dow = d.getDay();
  if (dow === 0 || dow === 6) return false;
  if (_holidaySet[dateStr]) return false;
  return true;
}

function generateTradingDays(startYear, endYear) {
  var days = [];
  var d = new Date(Date.UTC(startYear, 0, 1));
  var end = new Date(Date.UTC(endYear, 11, 31, 23, 59, 59));

  while (d <= end) {
    var ds = d.toISOString().slice(0, 10);
    if (_isTradingDay(ds)) {
      days.push(ds);
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

// ---- Cached calendar (lazy init) ----

var _calendar = null;

function loadCalendar() {
  if (_calendar) return _calendar;

  // Try cache first
  try {
    if (fs.existsSync(CALENDAR_FILE)) {
      var cached = JSON.parse(fs.readFileSync(CALENDAR_FILE, 'utf8'));
      if (cached && cached.days && Array.isArray(cached.days)) {
        _calendar = cached.days;
        return _calendar;
      }
    }
  } catch (_) { /* regenerate */ }

  // Generate and cache
  _calendar = generateTradingDays(2020, 2026);

  try {
    if (!fs.existsSync(RESEARCH_DIR)) fs.mkdirSync(RESEARCH_DIR, { recursive: true });
    fs.writeFileSync(CALENDAR_FILE, JSON.stringify({
      generatedAt: new Date().toISOString(),
      startYear: 2020,
      endYear: 2026,
      count: _calendar.length,
      days: _calendar,
    }, null, 2), 'utf8');
  } catch (_) { /* non-fatal */ }

  return _calendar;
}

function isTradingDay(dateStr) {
  if (!dateStr) return false;
  var ds = typeof dateStr === 'string' ? dateStr.slice(0, 10) : dateStr.toISOString().slice(0, 10);
  return _isTradingDay(ds);
}

function getTradingDay(dateStr, offset) {
  var calendar = loadCalendar();
  var ds = typeof dateStr === 'string' ? dateStr.slice(0, 10) : dateStr.toISOString().slice(0, 10);

  var idx = calendar.indexOf(ds);
  if (idx < 0) {
    // Date is not a trading day — find the nearest one before it
    for (var i = calendar.length - 1; i >= 0; i--) {
      if (calendar[i] < ds) { idx = i; break; }
    }
    if (idx < 0) return null;
  }

  var target = idx + offset;
  if (target < 0 || target >= calendar.length) return null;
  return calendar[target];
}

function countTradingDays(startStr, endStr) {
  var calendar = loadCalendar();
  var s = typeof startStr === 'string' ? startStr.slice(0, 10) : startStr.toISOString().slice(0, 10);
  var e = typeof endStr === 'string' ? endStr.slice(0, 10) : endStr.toISOString().slice(0, 10);
  var count = 0;
  for (var i = 0; i < calendar.length; i++) {
    if (calendar[i] >= s && calendar[i] <= e) count++;
  }
  return count;
}

function calendarStats() {
  var cal = loadCalendar();
  var byYear = {};
  cal.forEach(function (d) {
    var y = d.slice(0, 4);
    byYear[y] = (byYear[y] || 0) + 1;
  });
  return { total: cal.length, byYear: byYear, first: cal[0], last: cal[cal.length - 1] };
}

// ---- Freeze: write immutable manifest of raw data used ----

function freezeRawDataManifest() {
  var manifest = {
    frozenAt: new Date().toISOString(),
    version: 'P1-B.1',
    purpose: 'Record all raw data sources and their state at research initiation',
    klines: {
      source: 'Tencent ifzq API (web.ifzq.gtimg.cn)',
      params: 'param={sh/sz}{code},day,2020-01-01,,640,qfq',
      format: 'pre-reconciled daily OHLCV bars',
      knownLimitations: [
        'Turnover field is always 0 (Tencent qfqday does not provide it)',
        'Max 640 bars per call (~2.5-3 years)',
        'Pre-reconciled prices mean historical prices are adjusted for all corporate actions'
      ],
      directory: 'report-engine/data/klines/',
    },
    indexDaily: {
      source: 'Sina hq.sinajs.cn (daily close)',
      directory: 'report-engine/data/market_history/indices/',
      indices: ['sh000001.json', 'sz399001.json', 'sz399006.json'],
    },
    financialData: {
      source: 'NOT available with announcement dates',
      fallback: 'REPORT_DATE + 120 days estimation',
      flag: '_announcementDateEstimated: true',
      impact: 'Fundamental features (PE, ROE, debt ratio) will be stale for 1-4 months in historical snapshots'
    },
    sectorClassification: {
      method: 'Name-matching against 8 hardcoded sector keyword sets',
      mappingFile: null,
      alternative: 'Eastmoney f100 industry code (current snapshot only, no history)'
    },
    tradingCalendar: calendarStats(),
  };

  var manifestPath = path.join(RESEARCH_DIR, 'raw_data_manifest.json');
  if (!fs.existsSync(RESEARCH_DIR)) fs.mkdirSync(RESEARCH_DIR, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log('Raw data manifest frozen to ' + manifestPath);
  return manifest;
}

// ---- CLI ----

if (require.main === module) {
  var cal = loadCalendar();
  console.log('Calendar loaded: ' + cal.length + ' trading days (2020-2026)');
  console.log('First:', cal[0], 'Last:', cal[cal.length - 1]);
  console.log('Stats:', JSON.stringify(calendarStats(), null, 2));
  console.log();

  // Test T+3
  var testDate = '2024-06-15';
  var t3 = getTradingDay(testDate, 3);
  console.log(testDate + ' + 3 trading days = ' + t3);

  var isTD = isTradingDay('2024-06-15');
  console.log('2024-06-15 is trading day?', isTD, '(Saturday)');

  var cnt = countTradingDays('2024-01-01', '2024-12-31');
  console.log('2024 trading days:', cnt);

  freezeRawDataManifest();
}

module.exports = {
  loadCalendar,
  isTradingDay,
  getTradingDay,
  countTradingDays,
  calendarStats,
  freezeRawDataManifest,
  generateTradingDays,
};
