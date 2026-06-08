/**
 * knowledge_base.js — AI 自我成长知识库
 *
 * 每天 16:00 持久化量化分析结果，累计因子表现统计，支持历史模式匹配。
 * 零外部依赖，纯文件 JSON 存储。
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

const DATA_DIR = config.DATA_DIR;
const KB_DIR = path.join(DATA_DIR, 'knowledge_base');
const FACTOR_TRACKER_FILE = path.join(KB_DIR, 'factor_tracker.json');
const INDEX_FILE = path.join(KB_DIR, 'index.json');

// ---- Helpers ----

function ensureDir() {
  if (!fs.existsSync(KB_DIR)) {
    fs.mkdirSync(KB_DIR, { recursive: true });
  }
}

function readJSON(filePath, defaultVal) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) { /* corrupted */ }
  return defaultVal;
}

function writeJSON(filePath, data) {
  ensureDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ---- Factor Tracker ----

var SIGNAL_NAMES = {
  H1: '缩量止跌', H2: '底部放量', H3: '逆势抗跌', H4: 'PE低估',
  H5: '高ROE低PB', H6: '现金流健康', H7: '低换手蓄力', H8: '短期反转', H9: '量价背离',
};

function initFactorTracker() {
  var tracker = { factors: {}, signalCombos: [], lastUpdated: null, totalDays: 0 };
  for (var id in SIGNAL_NAMES) {
    tracker.factors[id] = {
      name: SIGNAL_NAMES[id],
      triggerCount: 0,
      daysTopSignal: 0,
      avgContribution: 0,
      totalContribution: 0,
      contributionCount: 0,
      lastTriggered: null,
    };
  }
  return tracker;
}

function loadFactorTracker() {
  var tracker = readJSON(FACTOR_TRACKER_FILE, null);
  if (!tracker || !tracker.factors) return initFactorTracker();
  // Ensure all factors exist (migration)
  for (var id in SIGNAL_NAMES) {
    if (!tracker.factors[id]) {
      tracker.factors[id] = {
        name: SIGNAL_NAMES[id],
        triggerCount: 0,
        daysTopSignal: 0,
        avgContribution: 0,
        totalContribution: 0,
        contributionCount: 0,
        lastTriggered: null,
      };
    }
  }
  return tracker;
}

function updateFactorTracker(analysisObj, summary) {
  var tracker = loadFactorTracker();
  var date = analysisObj.date || summary.date;

  // Update from trade deep dives
  if (analysisObj.tradesAnalysis && analysisObj.tradesAnalysis.length > 0) {
    var topFactorsToday = new Set();
    for (var i = 0; i < analysisObj.tradesAnalysis.length; i++) {
      var ta = analysisObj.tradesAnalysis[i];
      var attribs = ta.factorAttribution || [];
      for (var j = 0; j < attribs.length; j++) {
        var fa = attribs[j];
        var factorId = fa.factorId;
        if (tracker.factors[factorId]) {
          tracker.factors[factorId].triggerCount++;
          tracker.factors[factorId].lastTriggered = date;
          tracker.factors[factorId].totalContribution = (tracker.factors[factorId].totalContribution || 0) + fa.contributionPercent;
          tracker.factors[factorId].contributionCount = (tracker.factors[factorId].contributionCount || 0) + 1;
        }
        if (fa.contributionPercent >= 25) {
          topFactorsToday.add(factorId);
        }
      }
    }
    // Mark top factors for this day
    topFactorsToday.forEach(function(fid) {
      if (tracker.factors[fid]) tracker.factors[fid].daysTopSignal++;
    });
  }

  // Update from factor summary (pipeline result signal counts)
  if (analysisObj.factorSummary && analysisObj.factorSummary.topSignals) {
    for (var k = 0; k < analysisObj.factorSummary.topSignals.length; k++) {
      var sig = analysisObj.factorSummary.topSignals[k];
      if (tracker.factors[sig.id]) {
        // Already counted above from individual trades, so only add if no trades
      }
    }
  }

  // Compute avg contributions
  for (var fid in tracker.factors) {
    var f = tracker.factors[fid];
    if (f.contributionCount > 0) {
      f.avgContribution = Math.round(f.totalContribution / f.contributionCount);
    }
  }

  tracker.totalDays = (tracker.totalDays || 0) + 1;
  tracker.lastUpdated = new Date().toISOString();

  writeJSON(FACTOR_TRACKER_FILE, tracker);
  return tracker;
}

// ---- Daily Analysis Persistence ----

function saveDailyAnalysis(analysisObj, summary) {
  ensureDir();
  var date = analysisObj.date || (summary ? summary.date : new Date().toISOString().slice(0, 10));
  var filePath = path.join(KB_DIR, date + '.json');

  // Save full analysis
  writeJSON(filePath, {
    analysis: analysisObj,
    summary: summary ? {
      totalValue: summary.portfolio ? summary.portfolio.totalValue : null,
      totalReturn: summary.portfolio ? summary.portfolio.totalReturn : null,
      tradeCount: summary.todayTrades ? summary.todayTrades.length : 0,
      maxScore: summary.pipeline ? summary.pipeline.maxScore : null,
      avgScore: summary.pipeline ? summary.pipeline.avgScore : null,
    } : null,
    savedAt: new Date().toISOString(),
  });

  // Update factor tracker
  updateFactorTracker(analysisObj, summary);

  // Update index
  updateIndex(date);
}

// ---- Index Management ----

function updateIndex(date) {
  var index = readJSON(INDEX_FILE, { entries: [] });
  // Deduplicate
  if (!index.entries.includes(date)) {
    index.entries.push(date);
    index.entries.sort().reverse();
    // Keep last N days
    var maxDays = (config.ANALYSIS && config.ANALYSIS.knowledgeBaseDays) || 30;
    if (index.entries.length > maxDays) {
      index.entries = index.entries.slice(0, maxDays);
    }
    writeJSON(INDEX_FILE, index);
  }
}

function loadRecentPatterns(days) {
  days = days || 5;
  var index = readJSON(INDEX_FILE, { entries: [] });
  var patterns = [];
  var loaded = 0;
  for (var i = 0; i < index.entries.length && loaded < days; i++) {
    var filePath = path.join(KB_DIR, index.entries[i] + '.json');
    var data = readJSON(filePath, null);
    if (data && data.analysis) {
      patterns.push({
        date: index.entries[i],
        marketNarrative: data.analysis.marketNarrative,
        factorSummary: data.analysis.factorSummary,
        forwardPredictions: data.analysis.forwardPredictions,
        summary: data.summary,
      });
      loaded++;
    }
  }
  return patterns;
}

function findSimilarPatterns(currentConditions, topN) {
  topN = topN || 3;
  var recent = loadRecentPatterns(30);
  if (recent.length === 0) return [];

  var scored = [];
  for (var i = 0; i < recent.length; i++) {
    var pattern = recent[i];
    var score = 0;

    // Compare sentiment bias
    if (currentConditions.sentimentBias && pattern.marketNarrative) {
      if (currentConditions.sentimentBias === pattern.marketNarrative.sentimentBias) score += 0.3;
    }

    // Compare top signals overlap
    if (currentConditions.topSignals && pattern.factorSummary && pattern.factorSummary.topSignals) {
      var currentSignalIds = {};
      for (var s = 0; s < currentConditions.topSignals.length; s++) {
        currentSignalIds[currentConditions.topSignals[s].id] = true;
      }
      var overlap = 0;
      for (var p = 0; p < pattern.factorSummary.topSignals.length; p++) {
        if (currentSignalIds[pattern.factorSummary.topSignals[p].id]) overlap++;
      }
      if (currentConditions.topSignals.length > 0) {
        score += (overlap / currentConditions.topSignals.length) * 0.5;
      }
    }

    // Similar avg score range
    if (currentConditions.avgScore && pattern.summary && pattern.summary.avgScore) {
      var scoreDiff = Math.abs(currentConditions.avgScore - pattern.summary.avgScore);
      if (scoreDiff <= 5) score += 0.2;
    }

    scored.push({ date: pattern.date, similarity: Math.round(score * 100), outcome: pattern.summary });
  }

  scored.sort(function(a, b) { return b.similarity - a.similarity; });

  var threshold = (config.ANALYSIS && config.ANALYSIS.similarityThreshold) || 0.6;
  return scored.filter(function(s) { return s.similarity >= threshold * 100; }).slice(0, topN);
}

// ---- Knowledge Summary ----

function getKnowledgeSummary() {
  var index = readJSON(INDEX_FILE, { entries: [] });
  var tracker = loadFactorTracker();

  // Rank factors by contribution
  var rankedFactors = [];
  for (var fid in tracker.factors) {
    rankedFactors.push({
      id: fid,
      name: tracker.factors[fid].name,
      triggerCount: tracker.factors[fid].triggerCount,
      daysTopSignal: tracker.factors[fid].daysTopSignal,
      avgContribution: tracker.factors[fid].avgContribution,
      lastTriggered: tracker.factors[fid].lastTriggered,
    });
  }
  rankedFactors.sort(function(a, b) { return b.avgContribution - a.avgContribution; });

  return {
    totalDays: index.entries.length,
    dates: index.entries,
    factorTracker: {
      factors: rankedFactors,
      totalTriggers: rankedFactors.reduce(function(s, f) { return s + f.triggerCount; }, 0),
    },
    lastUpdated: tracker.lastUpdated,
  };
}

// ---- Factor Combo Pattern Extraction ----

/**
 * Get the next trading day after a given date (skip weekends).
 */
function getNextTradingDay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00+08:00');
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Extract factor combination patterns from historical knowledge base.
 * Identifies which factor combos (2+ factors triggering simultaneously)
 * historically predict positive next-day returns.
 *
 * @param {number} topN - Number of top combos to return
 * @returns {Array} [{ combo, hitRate, sampleSize, recentDates }]
 */
function extractFactorCombos(topN) {
  topN = topN || 10;
  const index = readJSON(INDEX_FILE, { entries: [] });
  const combos = {}; // { 'H1,H4': { hits: 0, total: 0, dates: [] } }

  for (let i = 0; i < index.entries.length; i++) {
    const date = index.entries[i];
    const filePath = path.join(KB_DIR, date + '.json');
    const data = readJSON(filePath, null);
    if (!data || !data.analysis) continue;

    // Get next-day return from the next day's summary
    const nextDate = getNextTradingDay(date);
    const nextFile = path.join(config.DATA_DIR, 'summaries', nextDate + '.json');
    const nextSummary = readJSON(nextFile, null);
    if (!nextSummary || nextSummary.portfolio == null) continue;

    // Check if next day was positive (use portfolio return as proxy)
    const nextReturn = nextSummary.portfolio.totalReturn || 0;
    // Use market indices if available for better accuracy
    let marketUp = false;
    if (nextSummary.market && nextSummary.market.indices && nextSummary.market.indices.length > 0) {
      const sh = nextSummary.market.indices.find(idx => idx.code === '000001' || idx.code === 'sh000001');
      if (sh && sh.changePercent != null) {
        marketUp = sh.changePercent > 0;
      } else {
        marketUp = nextReturn > 0;
      }
    } else {
      marketUp = nextReturn > 0;
    }

    // Get top signals for this day from factor summary
    const factorSummary = data.analysis.factorSummary;
    if (!factorSummary || !factorSummary.topSignals) continue;

    const signalIds = factorSummary.topSignals.map(s => s.id).sort();
    if (signalIds.length >= 2) {
      const comboKey = signalIds.slice(0, 3).join(','); // cap at 3 to avoid sparse combos
      if (!combos[comboKey]) combos[comboKey] = { hits: 0, total: 0, dates: [] };
      combos[comboKey].total++;
      if (marketUp) combos[comboKey].hits++;
      combos[comboKey].dates.push(date);
    }
  }

  // P2-8: Confidence based on actual hit rate AND sample size.
  // Old logic: sampleSize >= 5 → "high" regardless of hit rate.
  // This incorrectly labeled a 25% hit-rate combo (H4,H6,H7) as "high confidence."
  //
  // New logic:
  //   Confidence = hit rate quality × sample adequacy
  //   high:   hitRate >= 0.55 AND sampleSize >= 4  (convincing)
  //   medium: hitRate >= 0.45 AND sampleSize >= 3  (suggestive)
  //   low:    everything else (insufficient evidence or poor performance)
  //   A combo with hitRate < 0.40 is NEVER "high" or "medium" regardless of N.
  const ranked = Object.entries(combos)
    .filter(([, v]) => v.total >= 2)
    .map(([key, v]) => {
      const hitRate = +(v.hits / v.total).toFixed(2);
      let confidence;
      if (hitRate >= 0.55 && v.total >= 4) {
        confidence = 'high';
      } else if (hitRate >= 0.45 && v.total >= 3) {
        confidence = 'medium';
      } else {
        confidence = 'low';
      }
      return {
        combo: key,
        hitRate: hitRate,
        sampleSize: v.total,
        recentDates: v.dates.slice(-3),
        confidence: confidence,
      };
    })
    .sort((a, b) => (b.hitRate * b.sampleSize) - (a.hitRate * a.sampleSize))
    .slice(0, topN);

  return ranked;
}

/**
 * Extract sector capital flow consistency patterns.
 * Tracks which sectors show persistent capital inflow and
 * whether this persistence predicts sector performance.
 *
 * @returns {object} { sectorStreaks, predictiveSectors }
 */
function extractSectorFlowPatterns() {
  const index = readJSON(INDEX_FILE, { entries: [] });
  const sectorFlowHistory = {}; // { sector: [{ date, netFlow, return }] }

  for (let i = 0; i < index.entries.length; i++) {
    const date = index.entries[i];

    // Read daily summary which may contain sector flow data
    const summaryPath = path.join(config.DATA_DIR, 'summaries', date + '.json');
    const summary = readJSON(summaryPath, null);
    if (!summary || !summary.portfolio) continue;

    // Check for sector flows in the summary
    const sectorFlows = summary.sectorFlows || [];
    for (const sf of sectorFlows) {
      if (!sectorFlowHistory[sf.name]) {
        sectorFlowHistory[sf.name] = [];
      }
      sectorFlowHistory[sf.name].push({
        date,
        netFlow: sf.netFlow || 0,
        // Check next-day market return as proxy
      });
    }
  }

  // Compute streaks and hit rates for each sector
  const sectorPatterns = {};
  for (const [sector, history] of Object.entries(sectorFlowHistory)) {
    if (history.length < 3) continue;

    let currentStreak = 0;
    let maxStreak = 0;
    let inflowDays = 0;
    const hitResults = [];

    for (let i = 0; i < history.length; i++) {
      const entry = history[i];
      if (entry.netFlow > 0) {
        currentStreak++;
        inflowDays++;
        if (currentStreak > maxStreak) maxStreak = currentStreak;
      } else {
        currentStreak = 0;
      }

      // Check next-day outcome if we have it
      const nextDate = getNextTradingDay(entry.date);
      const nextSummary = readJSON(
        path.join(config.DATA_DIR, 'summaries', nextDate + '.json'),
        null
      );
      if (nextSummary && nextSummary.market && nextSummary.market.indices) {
        const sh = nextSummary.market.indices.find(
          idx => idx.code === '000001' || idx.code === 'sh000001'
        );
        if (sh && sh.changePercent != null) {
          hitResults.push({
            inflow: entry.netFlow > 0,
            marketUp: sh.changePercent > 0,
          });
        }
      }
    }

    const inflowHitResults = hitResults.filter(r => r.inflow);
    const hitRate = inflowHitResults.length > 0
      ? +(inflowHitResults.filter(r => r.marketUp).length / inflowHitResults.length).toFixed(2)
      : null;

    sectorPatterns[sector] = {
      totalDays: history.length,
      inflowDays,
      maxStreak,
      currentStreak,
      hitRate,
      sampleSize: inflowHitResults.length,
    };
  }

  return sectorPatterns;
}

module.exports = {
  saveDailyAnalysis,
  loadRecentPatterns,
  findSimilarPatterns,
  getKnowledgeSummary,
  loadFactorTracker,
  updateFactorTracker,
  extractFactorCombos,
  extractSectorFlowPatterns,
  getNextTradingDay,
};
