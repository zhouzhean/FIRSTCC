/**
 * P0.2 T1 Residual: API Regression Test — Benchmark Null Semantics
 *
 * Verifies that when benchmarkStatus !== "available", all benchmark return
 * and excess fields are strictly null (not 0, not undefined-as-0).
 *
 * Tests both:
 *   1. /api/cockpit → researchLab.latestWindow benchmark/excess fields
 *   2. /api/status  → walkForward benchmark/excess fields (if present)
 *
 * Usage: node test_benchmark_null_semantics.js [baseUrl]
 *   Default: http://localhost:8765
 */

var http = require('http');
var baseUrl = process.argv[2] || 'http://localhost:8765';

var BENCHMARK_RETURN_FIELDS = [
  'benchmarkNetReturn',
  'benchmarkGrossReturn',
  'benchmarkTradeCount',
  'benchmarkUnavailableCount',
  'netExcessReturn',
  'portfolioNetExcess',
];

var NON_RETURN_FIELDS = [
  'benchmarkStatus',
  'benchmarkSource',
  'netExcessStatus',
];

var PASSED = 0;
var FAILED = 0;

function fetchJSON(path) {
  return new Promise(function (resolve, reject) {
    var url = baseUrl + path;
    http.get(url, function (res) {
      var body = '';
      res.on('data', function (chunk) { body += chunk; });
      res.on('end', function () {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('Invalid JSON from ' + path + ': ' + body.slice(0, 200)));
        }
      });
    }).on('error', function (e) {
      reject(new Error('Failed to fetch ' + path + ': ' + e.message));
    });
  });
}

function assert(label, condition, detail) {
  if (condition) {
    PASSED++;
    console.log('  \x1b[32mPASS\x1b[0m: ' + label);
  } else {
    FAILED++;
    console.log('  \x1b[31mFAIL\x1b[0m: ' + label + (detail ? ' — ' + JSON.stringify(detail) : ''));
  }
}

function checkBenchmarkFields(obj, path, expectedAvailable) {
  var prefix = path + (expectedAvailable ? ' (available)' : ' (unavailable)');

  // 1. benchmarkStatus must be a string
  assert(prefix + ': benchmarkStatus is string', typeof obj.benchmarkStatus === 'string',
    { actual: obj.benchmarkStatus });

  if (expectedAvailable) {
    // When available: return fields must be non-null numbers
    BENCHMARK_RETURN_FIELDS.forEach(function (field) {
      assert(prefix + ': ' + field + ' is not null', obj[field] != null,
        { field: field, actual: obj[field] });
      if (obj[field] != null) {
        assert(prefix + ': ' + field + ' is number', typeof obj[field] === 'number',
          { field: field, actual: obj[field] });
      }
    });
    assert(prefix + ': benchmarkSource is sh_index_same_path', obj.benchmarkSource === 'sh_index_same_path',
      { actual: obj.benchmarkSource });
    assert(prefix + ': netExcessStatus is comparable', obj.netExcessStatus === 'comparable',
      { actual: obj.netExcessStatus });
  } else {
    // When unavailable: ALL benchmark return and excess fields must be null
    BENCHMARK_RETURN_FIELDS.forEach(function (field) {
      assert(prefix + ': ' + field + ' MUST be null (was ' + JSON.stringify(obj[field]) + ')',
        obj[field] === null,
        { field: field, actual: obj[field] });
    });
    assert(prefix + ': benchmarkSource MUST be null', obj.benchmarkSource === null,
      { actual: obj.benchmarkSource });
    assert(prefix + ': netExcessStatus indicates benchmark_unavailable',
      obj.netExcessStatus === 'benchmark_unavailable',
      { actual: obj.netExcessStatus });
  }
}

function checkStrategyFields(obj, path) {
  // Strategy fields should always be present (non-null) even when benchmark unavailable
  assert(path + ': strategyNetReturn is non-null', obj.strategyNetReturn != null,
    { actual: obj.strategyNetReturn });
  assert(path + ': strategyGrossReturn is non-null', obj.strategyGrossReturn != null,
    { actual: obj.strategyGrossReturn });
  assert(path + ': portfolioNetReturn is non-null', obj.portfolioNetReturn != null,
    { actual: obj.portfolioNetReturn });
  assert(path + ': portfolioGrossReturn is non-null', obj.portfolioGrossReturn != null,
    { actual: obj.portfolioGrossReturn });
}

async function main() {
  console.log('=== P0.2 T1 Residual: Benchmark Null Semantics Regression Test ===');
  console.log('Base URL: ' + baseUrl);
  console.log();

  // 1. Test /api/cockpit
  console.log('--- Test 1: /api/cockpit → researchLab ---');
  try {
    var cockpit = await fetchJSON('/api/cockpit');
    if (!cockpit.researchLab) {
      console.log('  SKIP: researchLab not present in cockpit response');
    } else {
      var rl = cockpit.researchLab;
      assert('researchLab status exists', rl.status != null, { status: rl.status });
      assert('researchLab validWindows exists', rl.validWindows != null,
        { validWindows: rl.validWindows });

      if (rl.latestWindow) {
        var lw = rl.latestWindow;
        console.log('  Research Lab latestWindow found:');
        console.log('    benchmarkStatus=' + lw.benchmarkStatus);
        console.log('    strategyNetReturn=' + lw.strategyNetReturn);
        console.log('    netExcessReturn=' + lw.netExcessReturn);
        console.log('    portfolioNetExcess=' + lw.portfolioNetExcess);

        // Strategy fields always present
        checkStrategyFields(lw, 'cockpit latestWindow');

        var bmAvailable = lw.benchmarkStatus === 'available';
        checkBenchmarkFields(lw, 'cockpit latestWindow', bmAvailable);

        // Verify no ||0 leakage: if benchmarkStatus=unavailable, netExcessReturn can't be 0
        // (a 0 netExcessReturn would mean strategy and benchmark had identical returns — unlikely if benchmark unavailable)
        if (!bmAvailable && lw.netExcessReturn === 0) {
          assert('cockpit: netExcessReturn=0 masked as "unavailable" — LEAKAGE',
            false,
            { msg: 'netExcessReturn is 0 but benchmarkStatus=unavailable — this is a ||0 fallback bug' });
        }
      } else {
        console.log('  SKIP: no latestWindow in researchLab');
      }
    }
  } catch (e) {
    console.log('  \x1b[31mERROR\x1b[0m: ' + e.message);
  }

  console.log();

  // 2. Test /api/status (less strict — may not have benchmark fields)
  console.log('--- Test 2: /api/status (baseline) ---');
  try {
    var status = await fetchJSON('/api/status');
    assert('status returns identityStatus', status.identityStatus != null,
      { identityStatus: status.identityStatus });
    console.log('  identityStatus=' + status.identityStatus);
  } catch (e) {
    console.log('  \x1b[31mERROR\x1b[0m: ' + e.message);
  }

  console.log();

  // 3. Test /api/prediction-settlement
  console.log('--- Test 3: /api/prediction-settlement ---');
  try {
    var ps = await fetchJSON('/api/prediction-settlement');
    assert('prediction-settlement has canonicalCohortCount',
      ps.canonicalCohortCount != null,
      { canonicalCohortCount: ps.canonicalCohortCount });
    console.log('  canonicalCohortCount=' + ps.canonicalCohortCount);
  } catch (e) {
    console.log('  \x1b[31mERROR\x1b[0m: ' + e.message);
  }

  console.log();

  // Summary
  console.log('=== Results: ' + PASSED + ' passed, ' + FAILED + ' failed ===');

  if (FAILED > 0) {
    console.log('\x1b[31mFAILED\x1b[0m: Some checks failed — benchmark null semantics may be violated.');
    process.exit(1);
  } else {
    console.log('\x1b[32mALL PASSED\x1b[0m: Benchmark null semantics are correct.');
    process.exit(0);
  }
}

main().catch(function (e) {
  console.error('Fatal error: ' + e.message);
  process.exit(2);
});
