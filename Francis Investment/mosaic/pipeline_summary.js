/**
 * Francis Investment · Pipeline Summary Saver v3.4.4
 *
 * Single shared function for persisting pipeline results. Called by both:
 *   1. scheduler._saveLastPipelineResult() — automated scans
 *   2. mosaic_server.saveLastPipelineResult() — manual pipeline runs
 *
 * Both paths now save the same complete structure so cockpit/think-tank
 * always see the same context after restart.
 */

var fs = require('fs');
var path = require('path');

/**
 * Save unified pipeline summary to last_pipeline_result.json.
 *
 * @param {Object} result   - raw pipeline result {allResults, top5, totalStocks, candidates, analyzed, duration, indices, ...}
 * @param {string} type     - 'full' | 'mid'
 * @param {string} dateStr  - YYYY-MM-DD (defaults to today)
 * @param {Object} [opts]   - optional extras:
 *   { buyCandidates, threshold, maxBuysPerDay, kernelVerdict, primaryBlocker, skipReason, version }
 */
function savePipelineSummary(result, type, dateStr, opts) {
  opts = opts || {};
  var today = dateStr || new Date().toISOString().slice(0, 10);

  try {
    // Resolve paths
    var config = require('./config');
    var dir = path.join(config.DATA_DIR, 'simfolio');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    var allResults = result.allResults || [];

    // Score distribution
    var dist = { lt50: 0, r50_60: 0, r60_70: 0, r70_80: 0, gt80: 0 };
    var signalCounts = {};
    for (var i = 0; i < allResults.length; i++) {
      var r = allResults[i];
      var s = r.compositeScore || 0;
      if (s < 50) dist.lt50++;
      else if (s < 60) dist.r50_60++;
      else if (s < 70) dist.r60_70++;
      else if (s < 80) dist.r70_80++;
      else dist.gt80++;

      var sigs = r.hiddenSignals || r.signals || [];
      for (var j = 0; j < sigs.length; j++) {
        signalCounts[sigs[j].id] = (signalCounts[sigs[j].id] || 0) + 1;
      }
    }

    var avgScore = allResults.length > 0
      ? Math.round(allResults.reduce(function(a, r) { return a + (r.compositeScore || 0); }, 0) / allResults.length)
      : 0;
    var maxScore = allResults.length > 0
      ? Math.max.apply(null, allResults.map(function(r) { return r.compositeScore || 0; }))
      : 0;

    // Compute expected returns for top candidates
    var expectedReturns = [];
    try {
      var er = require('./predict/expected_return');
      var context = {};
      try {
        var spfPath = path.join(dir, 'stock_factor_performance.json');
        if (fs.existsSync(spfPath)) context.stockFactorPerf = JSON.parse(fs.readFileSync(spfPath, 'utf8'));
      } catch (_) {}
      try {
        var mc = require('./analysis/market_cycle');
        context.marketCycle = mc.getMarketCycle ? mc.getMarketCycle() : null;
      } catch (_) {}
      try {
        var fp = require('./analysis/factor_performance');
        context.nbPerf = fp.getNBPerformance ? fp.getNBPerformance() : null;
      } catch (_) {}
      try {
        if (result.sectorFlowMap && Array.isArray(result.sectorFlowMap)) {
          context.sectorFlowRank = { entries: result.sectorFlowMap };
        }
      } catch (_) {}
      try {
        var wcPath = path.join(dir, 'history_context.json');
        if (fs.existsSync(wcPath)) context.weekendContext = JSON.parse(fs.readFileSync(wcPath, 'utf8'));
      } catch (_) {}
      var ranked = er.rankByExpectedReturn(allResults, context);
      expectedReturns = ranked.slice(0, 10).map(function(rr) {
        var breakdownSummary = null;
        if (rr.prediction && rr.prediction.breakdown) {
          breakdownSummary = {};
          var bd = rr.prediction.breakdown;
          var dimKeys = ['factorCombo', 'sectorFlow', 'marketCycle', 'nbSentiment', 'stockSimilarity', 'scorePercentile'];
          for (var dk = 0; dk < dimKeys.length; dk++) {
            var key = dimKeys[dk];
            if (bd[key] && bd[key].available) {
              breakdownSummary[key] = { value: bd[key].value, label: bd[key].label, weight: bd[key].weight };
            }
          }
        }
        return {
          code: rr.code, name: rr.name,
          compositeScore: rr.compositeScore, rating: rr.rating,
          expectedReturn: rr.prediction ? rr.prediction.expectedReturn : null,
          confidence: rr.prediction ? rr.prediction.confidence : null,
          label: rr.prediction ? rr.prediction.label : null,
          breakdown: breakdownSummary,
        };
      });
    } catch (_) {}

    var summary = {
      type: type || 'full',
      date: today,
      time: new Date().toISOString(),
      version: opts.version || 'v3.4.4',
      totalStocks: result.totalStocks || 0,
      candidates: result.candidates || 0,
      analyzed: result.analyzed || 0,
      duration: result.duration || 0,
      top5: (result.top5 || []).map(function(s) {
        return {
          code: s.code, name: s.name, score: s.compositeScore || s.score, rating: s.rating,
          signals: s.signals || (s.hiddenSignals || []).map(function(h) { return { id: h.id, name: h.name, level: h.level }; }),
        };
      }),
      scoreDistribution: dist,
      signalCounts: signalCounts,
      avgScore: avgScore,
      maxScore: maxScore,
      expectedReturns: expectedReturns,

      // v3.4.4: Kernel decision context (from opts — filled by scheduler trade path)
      buyThreshold: opts.threshold != null ? opts.threshold : null,
      buyCandidates: opts.buyCandidates != null ? opts.buyCandidates : 0,
      effectiveMaxBuys: opts.maxBuysPerDay != null ? opts.maxBuysPerDay : null,
      kernelVerdict: opts.kernelVerdict || null,
      primaryBlocker: opts.primaryBlocker || null,
      skipReason: opts.skipReason || null,

      // v3.4.3: Lightweight kernel context for cockpit/think-tank after restart.
      // Top 100 scored stocks with just the fields decision_kernel consumers need.
      pipelineResultsForKernel: allResults.slice(0, 100).map(function(rr) {
        return {
          code: rr.code, name: rr.name,
          compositeScore: rr.compositeScore || 0,
          prediction: rr.prediction ? {
            expectedReturn: rr.prediction.expectedReturn,
            confidence: rr.prediction.confidence,
            label: rr.prediction.label,
          } : null,
        };
      }),
    };

    var filePath = path.join(dir, 'last_pipeline_result.json');
    fs.writeFileSync(filePath, JSON.stringify(summary, null, 2), 'utf8');

    // Also append to today's scan records
    var scanFile = path.join(dir, 'scan_records_' + today + '.json');
    var records = [];
    if (fs.existsSync(scanFile)) {
      try { records = JSON.parse(fs.readFileSync(scanFile, 'utf8')); } catch (_) {}
    }
    records.push({
      time: new Date().toISOString(),
      scanType: type || 'full',
      totalStocks: result.totalStocks || 0,
      candidates: result.candidates || 0,
      analyzed: result.analyzed || 0,
      top5: (result.top5 || []).slice(0, 5).map(function(s) { return { code: s.code, name: s.name, score: s.compositeScore || s.score, rating: s.rating }; }),
      signalCounts: signalCounts,
      avgScore: avgScore,
      maxScore: maxScore,
      // v3.4.4: Include decision context in scan records too
      kernelVerdict: opts.kernelVerdict || null,
      primaryBlocker: opts.primaryBlocker || null,
      buyCandidates: opts.buyCandidates != null ? opts.buyCandidates : 0,
    });
    if (records.length > 20) records = records.slice(-20);
    fs.writeFileSync(scanFile, JSON.stringify(records, null, 2), 'utf8');

    return summary;
  } catch (e) {
    // Silent — pipeline summary is advisory
    return null;
  }
}

module.exports = { savePipelineSummary };
