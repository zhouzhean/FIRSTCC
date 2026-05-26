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

module.exports = {
  saveDailyAnalysis,
  loadRecentPatterns,
  findSimilarPatterns,
  getKnowledgeSummary,
  loadFactorTracker,
  updateFactorTracker,
};
