/**
 * cross_market.js — 跨市场相关性引擎 & 风险状态机
 *
 * 1. Risk State Machine: VXX + UUP + TLT → risk regime → position sizing
 * 2. Correlation Engine: US ETF %change ↔ A-stock sector next-day %change
 * 3. Sector Heatmap: which US→A-stock mappings are currently predictive
 *
 * Pure Node.js, zero dependencies. All calculations deterministic.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const https = require('https');

const UM = config.US_MARKET;
const DATA_DIR = config.DATA_DIR;
const CORRELATION_FILE = path.join(DATA_DIR, 'us_market', 'correlation_history.json');

// A-stock sector → representative stock codes for aggregate performance
const SECTOR_STOCKS = {
  '半导体/AI算力': ['sh688981', 'sh688012', 'sz002371', 'sh603501', 'sz300604'],
  '创新药/AI医疗': ['sh688266', 'sh688180', 'sz300558', 'sh688331', 'sz300759'],
  '机器人/具身智能': ['sz300124', 'sh603728', 'sh688017', 'sz002747', 'sz300024'],
  '商业航天': ['sh600118', 'sh600879', 'sz300034', 'sh688568', 'sz002025'],
  '固态电池/储能': ['sz300750', 'sz002074', 'sh688567', 'sz300014', 'sz002709'],
  '有色金属/稀土': ['sh600111', 'sz000831', 'sh601600', 'sz002460', 'sh600392'],
  '新型电力基建': ['sh601012', 'sz300274', 'sh600406', 'sh688599', 'sz300763'],
  '军工': ['sh600760', 'sz000768', 'sh600893', 'sh688122', 'sz002389'],
};

// ---- Risk State Machine ----

/**
 * Compute risk regime from macro indicators.
 * @param {Object} macro — { VXX: {price,changePercent}, UUP: {price,changePercent}, TLT: {price,changePercent} }
 * @returns {Object} risk state with position sizing recommendation
 */
function computeRiskState(macro) {
  var vxx = findMacro(macro, 'VXX');
  var uup = findMacro(macro, 'UUP');
  var tlt = findMacro(macro, 'TLT');

  var vxxScore = 0, uupScore = 0, tltScore = 0;
  var signals = [];
  var riskLevel = 'neutral';

  // VXX (VIX proxy): <22 = calm, 22-28 = normal, 28-40 = elevated, >40 = panic
  if (vxx && vxx.price) {
    var vxxPrice = vxx.price;
    if (vxxPrice < 22) { vxxScore = 25; signals.push({ icon: 'shield', text: 'VIX低位(' + vxxPrice.toFixed(1) + ') — 市场平静，风险偏好积极', level: 'positive' }); }
    else if (vxxPrice < 28) { vxxScore = 0; signals.push({ icon: 'activity', text: 'VIX正常区间(' + vxxPrice.toFixed(1) + ') — 中性', level: 'neutral' }); }
    else if (vxxPrice < 40) { vxxScore = -25; signals.push({ icon: 'alert-triangle', text: 'VIX警戒(' + vxxPrice.toFixed(1) + ') — 市场焦虑上升，注意风控', level: 'warning' }); }
    else { vxxScore = -40; signals.push({ icon: 'alert-circle', text: 'VIX恐慌(' + vxxPrice.toFixed(1) + ') — 全球避险模式，建议减仓', level: 'danger' }); }
  }

  // UUP (USD proxy): change% > 0.5 = dollar strengthening = negative for A-stock
  if (uup && uup.changePercent != null) {
    var uupChg = uup.changePercent;
    if (uupChg < -0.5) { uupScore = 20; signals.push({ icon: 'trending-down', text: '美元走弱(' + fmtPct(uupChg) + ') — 利好人民币资产，北向倾向流入', level: 'positive' }); }
    else if (uupChg < 0) { uupScore = 5; signals.push({ icon: 'minus', text: '美元微跌(' + fmtPct(uupChg) + ') — 略偏正面', level: 'neutral' }); }
    else if (uupChg < 0.5) { uupScore = -5; signals.push({ icon: 'minus', text: '美元微涨(' + fmtPct(uupChg) + ') — 略偏负面', level: 'neutral' }); }
    else { uupScore = -20; signals.push({ icon: 'trending-up', text: '美元走强(' + fmtPct(uupChg) + ') — 人民币承压，北向倾向流出', level: 'warning' }); }
  }

  // TLT (Treasury proxy): price drops = yields rise = tightening
  if (tlt && tlt.changePercent != null) {
    var tltChg = tlt.changePercent;
    if (tltChg > 0.5) { tltScore = 20; signals.push({ icon: 'trending-down', text: '美债收益率下行(TLT +' + tltChg.toFixed(2) + '%) — 利好成长股估值', level: 'positive' }); }
    else if (tltChg > 0) { tltScore = 5; signals.push({ icon: 'minus', text: '美债平稳偏多(TLT +' + tltChg.toFixed(2) + '%)', level: 'neutral' }); }
    else if (tltChg > -0.5) { tltScore = -5; signals.push({ icon: 'minus', text: '美债收益率微升(TLT ' + tltChg.toFixed(2) + '%)', level: 'neutral' }); }
    else { tltScore = -20; signals.push({ icon: 'trending-up', text: '美债收益率急升(TLT ' + tltChg.toFixed(2) + '%) — 利空全球成长股', level: 'warning' }); }
  }

  var totalScore = vxxScore + uupScore + tltScore;
  var regime, positionSize, riskColor, riskGradient;

  if (totalScore >= 35) {
    regime = 'risk_on'; positionSize = 90; riskColor = '#059669'; riskGradient = 'linear-gradient(135deg, #ecfdf5, #d1fae5)';
  } else if (totalScore >= 10) {
    regime = 'slightly_bullish'; positionSize = 70; riskColor = '#10b981'; riskGradient = 'linear-gradient(135deg, #f0fdf4, #dcfce7)';
  } else if (totalScore >= -10) {
    regime = 'neutral'; positionSize = 50; riskColor = '#d97706'; riskGradient = 'linear-gradient(135deg, #fffbeb, #fef3c7)';
  } else if (totalScore >= -35) {
    regime = 'risk_off'; positionSize = 30; riskColor = '#ef4444'; riskGradient = 'linear-gradient(135deg, #fef2f2, #fee2e2)';
  } else {
    regime = 'panic'; positionSize = 10; riskColor = '#dc2626'; riskGradient = 'linear-gradient(135deg, #fef2f2, #fecaca)';
  }

  var regimeLabels = {
    'risk_on': '风险偏好', 'slightly_bullish': '谨慎乐观',
    'neutral': '中性观望', 'risk_off': '避险防御', 'panic': '恐慌撤退',
  };

  // Compute component breakdown
  var components = [];
  if (vxx) components.push({ label: 'VIX恐慌', value: vxx.price.toFixed(1), score: vxxScore, maxScore: 25, weight: '40%' });
  if (uup) components.push({ label: '美元指数', value: fmtPct(uup.changePercent), score: uupScore, maxScore: 20, weight: '30%' });
  if (tlt) components.push({ label: '美债利率', value: fmtPct(tlt.changePercent), score: tltScore, maxScore: 20, weight: '30%' });

  return {
    regime: regime,
    regimeLabel: regimeLabels[regime] || '未知',
    totalScore: totalScore,
    scoreRange: { min: -65, max: 65 },
    positionSize: positionSize,
    riskColor: riskColor,
    riskGradient: riskGradient,
    signals: signals,
    components: components,
    recommendation: getRecommendation(regime, positionSize),
  };
}

function getRecommendation(regime, positionSize) {
  var recs = {
    'risk_on': { action: '进攻', desc: '宏观环境支持风险资产，建议提高仓位至' + positionSize + '%，重点配置科技成长板块', style: 'bullish' },
    'slightly_bullish': { action: '偏多', desc: '宏观信号偏正面，建议维持' + positionSize + '%仓位，均衡配置', style: 'slightly_bullish' },
    'neutral': { action: '观望', desc: '宏观信号多空交织，建议' + positionSize + '%中性仓位，等待明确方向', style: 'neutral' },
    'risk_off': { action: '防御', desc: '宏观风险上升，建议降至' + positionSize + '%仓位，转向防御性板块', style: 'bearish' },
    'panic': { action: '避险', desc: '宏观环境恶化，建议降至' + positionSize + '%极低仓位或空仓观望', style: 'panic' },
  };
  return recs[regime] || recs['neutral'];
}

// ---- Correlation Engine ----

/**
 * Compute Pearson correlation coefficient between two arrays.
 */
function pearsonR(x, y) {
  var n = x.length;
  if (n < 5) return null; // need at least 5 data points
  if (n !== y.length) return null;

  var sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (var i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
    sumY2 += y[i] * y[i];
  }

  var denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (denom === 0) return 0;
  return Math.round(((n * sumXY - sumX * sumY) / denom) * 100) / 100;
}

/**
 * Compute hit rate: US ETF up → A-stock sector up next day.
 */
function hitRate(usChanges, aChanges) {
  var hits = 0, total = 0;
  for (var i = 0; i < usChanges.length; i++) {
    if (usChanges[i] === 0) continue;
    total++;
    if ((usChanges[i] > 0 && aChanges[i] > 0) || (usChanges[i] < 0 && aChanges[i] < 0)) {
      hits++;
    }
  }
  return total >= 5 ? Math.round(hits / total * 100) : null;
}

/**
 * Compute all pairwise correlations from correlation history.
 * @param {Array} history — array of daily snapshots
 * @returns {Object} correlation matrix + sector outlook
 */
function computeCorrelationMatrix(history) {
  if (!history || history.length < 5) {
    return { ready: false, daysNeeded: 5 - (history ? history.length : 0), matrix: [], outlook: [] };
  }

  var etfSectors = Object.keys(UM.sectorMapping);
  var matrix = [];

  for (var e = 0; e < etfSectors.length; e++) {
    var etf = etfSectors[e];
    var aSector = UM.sectorMapping[etf];
    if (!aSector) continue;

    var usVals = [];
    var aVals = [];
    for (var i = 0; i < history.length; i++) {
      var day = history[i];
      if (day.us && day.us[etf] != null && day.aStock && day.aStock[aSector] != null) {
        usVals.push(day.us[etf]);
        aVals.push(day.aStock[aSector]);
      }
    }

    var r = pearsonR(usVals, aVals);
    var hr = hitRate(usVals, aVals);
    var dir = r !== null ? (r >= 0.3 ? 'positive' : (r <= -0.3 ? 'negative' : 'weak')) : 'insufficient';

    // Recent bias: last 5 days
    var recentUs = usVals.slice(-5);
    var recentA = aVals.slice(-5);
    var recentR = pearsonR(recentUs, recentA);

    // Today's signal: what does the latest US ETF move imply?
    var latestUS = usVals[usVals.length - 1];
    var signal = 'neutral';
    if (r !== null && r >= 0.3) {
      signal = latestUS >= 0.5 ? 'bullish' : (latestUS <= -0.5 ? 'bearish' : 'neutral');
    }

    matrix.push({
      etf: etf,
      etfName: getETFName(etf),
      aSector: aSector,
      correlation: r,
      recentCorrelation: recentR,
      hitRate: hr,
      direction: dir,
      dataPoints: usVals.length,
      latestUSChange: Math.round(latestUS * 100) / 100,
      signal: signal,
      strength: r !== null ? (Math.abs(r) >= 0.7 ? 'strong' : (Math.abs(r) >= 0.4 ? 'moderate' : 'weak')) : 'none',
    });
  }

  // Sort by correlation strength
  matrix.sort(function(a, b) {
    return Math.abs(b.correlation || 0) - Math.abs(a.correlation || 0);
  });

  // Generate sector outlook from the matrix
  var outlook = matrix.map(function(m) {
    var impact = 'neutral';
    if (m.signal === 'bullish' && m.strength === 'strong') impact = 'strong_positive';
    else if (m.signal === 'bullish') impact = 'positive';
    else if (m.signal === 'bearish' && m.strength === 'strong') impact = 'strong_negative';
    else if (m.signal === 'bearish') impact = 'negative';

    return {
      aSector: m.aSector,
      etf: m.etf,
      correlation: m.correlation,
      impact: impact,
      signal: m.signal,
    };
  });

  return {
    ready: true,
    dataPoints: history.length,
    matrix: matrix,
    outlook: outlook,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Load correlation history from disk.
 */
function loadCorrelationHistory() {
  try {
    if (fs.existsSync(CORRELATION_FILE)) {
      var raw = JSON.parse(fs.readFileSync(CORRELATION_FILE, 'utf8'));
      return (raw && raw.days) ? raw.days : [];
    }
  } catch (e) { /* ignore */ }
  return [];
}

/**
 * Save correlation history to disk.
 */
function saveCorrelationHistory(days) {
  try {
    var dir = path.dirname(CORRELATION_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CORRELATION_FILE, JSON.stringify({
      updatedAt: new Date().toISOString(),
      days: days.slice(-60), // keep last 60 trading days
    }, null, 2), 'utf8');
  } catch (e) { /* silent */ }
}

/**
 * Fetch A-stock sector performance using representative stocks.
 * Aggregates average %change of representative stocks for each sector.
 */
function fetchAStockSectorPerformance() {
  return new Promise(function(resolve, reject) {
    var allCodes = [];
    var sectorKeys = Object.keys(SECTOR_STOCKS);
    var codeToSector = {};
    for (var i = 0; i < sectorKeys.length; i++) {
      var codes = SECTOR_STOCKS[sectorKeys[i]];
      for (var j = 0; j < codes.length; j++) {
        allCodes.push(codes[j]);
        codeToSector[codes[j]] = sectorKeys[i];
      }
    }

    // Use Sina API to fetch all representative stocks
    var sinaCodes = allCodes.map(function(c) {
      return c.slice(0, 2) === 'sh' ? 'sh' + c.slice(2) : 'sz' + c.slice(2);
    }).join(',');

    var url = 'https://hq.sinajs.cn/list=' + sinaCodes;

    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://finance.sina.com.cn',
      }
    }, function(res) {
      var chunks = [];
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() {
        var buf = Buffer.concat(chunks);
        var decoder = new TextDecoder('gbk');
        var text = decoder.decode(buf);

        var sectorChanges = {};
        var sectorCounts = {};
        var lines = text.split('\n');

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line || !line.includes('=')) continue;

          var codeMatch = line.match(/hq_str_(s[hz]\d+)=/);
          if (!codeMatch) continue;

          var sinaCode = codeMatch[1];
          var m = line.match(/"([^"]*)"/);
          if (!m) continue;

          var fields = m[1].split(',');
          if (fields.length < 4) continue;

          var price = parseFloat(fields[3]); // current price
          var prevClose = parseFloat(fields[2]); // previous close
          if (!price || !prevClose || prevClose <= 0) continue;

          var changePct = (price - prevClose) / prevClose * 100;
          var sector = codeToSector[sinaCode];
          if (!sector) continue;

          if (!sectorChanges[sector]) { sectorChanges[sector] = 0; sectorCounts[sector] = 0; }
          sectorChanges[sector] += changePct;
          sectorCounts[sector]++;
        }

        // Average change per sector
        var result = {};
        for (var k = 0; k < sectorKeys.length; k++) {
          var sk = sectorKeys[k];
          if (sectorCounts[sk] && sectorCounts[sk] > 0) {
            result[sk] = Math.round(sectorChanges[sk] / sectorCounts[sk] * 100) / 100;
          } else {
            result[sk] = null;
          }
        }

        resolve(result);
      });
    }).on('error', function(e) {
      reject(e);
    });
  });
}

/**
 * Record today's US→A-stock data point for correlation history.
 * Called after A-stock market close (16:00 daily summary time).
 */
async function recordDailyCorrelationSnapshot(dateStr) {
  var history = loadCorrelationHistory();

  // Check if already recorded for today
  for (var i = 0; i < history.length; i++) {
    if (history[i].date === dateStr) return history; // already recorded
  }

  try {
    // Get US ETF close data from us_latest.json
    var usData = null;
    var usLatestPath = path.join(DATA_DIR, 'us_market', 'us_latest.json');
    if (fs.existsSync(usLatestPath)) {
      usData = JSON.parse(fs.readFileSync(usLatestPath, 'utf8'));
    }

    // Get A-stock sector performance
    var aStockSectors = {};
    try {
      aStockSectors = await fetchAStockSectorPerformance();
    } catch (e) {
      // Use empty data if fetch fails — will try again tomorrow
    }

    // Build US ETF changes map
    var usChanges = {};
    if (usData && usData.sectorETFs) {
      for (var j = 0; j < usData.sectorETFs.length; j++) {
        var etf = usData.sectorETFs[j];
        usChanges[etf.symbol] = etf.changePercent || 0;
      }
    }
    // Also add major indices
    if (usData && usData.indices) {
      for (var k = 0; k < usData.indices.length; k++) {
        var idx = usData.indices[k];
        usChanges[idx.symbol] = idx.changePercent || 0;
      }
    }

    var snapshot = {
      date: dateStr,
      us: usChanges,
      aStock: aStockSectors,
    };

    history.push(snapshot);
    saveCorrelationHistory(history);
    return history;
  } catch (e) {
    return history;
  }
}

/**
 * Get the full cross-market analysis package.
 * @param {Object} usCurrent — latest US market data (from us_latest.json or fetchAllUSMonitors)
 */
function getFullAnalysis(usCurrent) {
  var history = loadCorrelationHistory();
  var correlationResult = computeCorrelationMatrix(history);

  // Extract macro data for risk state
  var macro = [];
  if (usCurrent && usCurrent.macro) {
    macro = usCurrent.macro;
  }

  var riskState = computeRiskState(macro);

  // Compute historical risk trend (last 5 risk assessments from correlation history)
  var riskTrend = [];
  if (history.length > 0) {
    var recentHistory = history.slice(-5);
    for (var i = 0; i < recentHistory.length; i++) {
      var day = recentHistory[i];
      if (day.riskState) {
        riskTrend.push({ date: day.date, regime: day.riskState.regime, score: day.riskState.score });
      }
    }
  }

  return {
    riskState: riskState,
    correlation: correlationResult,
    riskTrend: riskTrend,
    generatedAt: new Date().toISOString(),
  };
}

// ---- Persist risk state to correlation history ----

function saveRiskStateToHistory(dateStr, riskState) {
  try {
    var history = loadCorrelationHistory();
    for (var i = history.length - 1; i >= 0; i--) {
      if (history[i].date === dateStr) {
        history[i].riskState = {
          regime: riskState.regime,
          score: riskState.totalScore,
        };
        saveCorrelationHistory(history);
        return;
      }
    }
  } catch (e) { /* silent */ }
}

// ---- Helpers ----

function findMacro(macro, symbol) {
  if (!macro) return null;
  for (var i = 0; i < macro.length; i++) {
    if (macro[i].symbol === symbol) return macro[i];
  }
  return null;
}

function fmtPct(v) {
  if (v == null) return '--';
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}

function getETFName(etf) {
  var names = {
    'SMH': '半导体ETF', 'XBI': '生物科技ETF', 'TAN': '太阳能ETF',
    'ARKQ': '机器人ETF', 'XLE': '能源ETF', 'XLF': '金融ETF', 'XAR': '军工ETF',
  };
  return names[etf] || etf;
}

// ---- SSE Summary (lightweight text for think-tank) ----

function formatThinkTankSummary(analysis) {
  if (!analysis) return '暂无跨市场分析数据';
  var lines = [];
  var rs = analysis.riskState;
  lines.push('风险状态: ' + rs.regimeLabel + ' [' + rs.regime + '] 得分' + rs.totalScore);
  lines.push('建议仓位: ' + rs.positionSize + '% — ' + rs.recommendation.action);
  if (analysis.correlation && analysis.correlation.ready) {
    lines.push('有效映射: ' + analysis.correlation.matrix.length + '对');
    for (var i = 0; i < Math.min(3, analysis.correlation.matrix.length); i++) {
      var m = analysis.correlation.matrix[i];
      var rSign = (m.correlation || 0) >= 0 ? '+' : '';
      lines.push('  ' + m.etf + '→' + m.aSector + ' r=' + rSign + (m.correlation || 0).toFixed(2) + ' 命中率' + (m.hitRate || '?') + '%');
    }
  }
  return lines.join('\n');
}

module.exports = {
  computeRiskState,
  computeCorrelationMatrix,
  loadCorrelationHistory,
  saveCorrelationHistory,
  recordDailyCorrelationSnapshot,
  getFullAnalysis,
  saveRiskStateToHistory,
  fetchAStockSectorPerformance,
  formatThinkTankSummary,
  pearsonR,
};
