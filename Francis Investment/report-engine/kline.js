/**
 * kline.js
 * Pure JavaScript SVG K-line (candlestick) chart generator for Chinese A-stocks.
 *
 * Exports: renderKlineSVG(stockCode, klineData) -> SVG string
 *
 * Color convention (CHINESE MARKET — opposite of Western):
 *   Close > Open → RED (#e74c3c) = 阳线(涨) UP
 *   Close < Open → GREEN (#2ecc71) = 阴线(跌) DOWN
 *
 * Usage:
 *   var svg = renderKlineSVG("600143", stock.kline);
 *   // Insert svg into HTML; loaded via <script> tag, sits in global scope.
 */

function renderKlineSVG(stockCode, klineData) {
  var chartTitle = klineData.chartTitle || "";
  var priceMin   = klineData.priceMin;
  var priceMax   = klineData.priceMax;
  var candles    = klineData.candles || [];
  var ma5Values  = klineData.ma5Values || [];

  // ---------------------------------------------------------------------------
  // Price-to-pixel mapping
  // ---------------------------------------------------------------------------
  var priceSpan   = priceMax - priceMin;
  var chartHeight = 185;   // y=15 (top) to y=200 (bottom)

  function yPixel(price) {
    var y = 15 + chartHeight * (1 - (price - priceMin) / priceSpan);
    return Math.round(y);
  }

  // ---------------------------------------------------------------------------
  // Candle x-positions (5 days, spacing 90px, body width 36px)
  // ---------------------------------------------------------------------------
  var centerX = [65, 155, 245, 335, 425];

  // ---------------------------------------------------------------------------
  // Grid lines & price labels
  // ---------------------------------------------------------------------------
  var priceStep = priceSpan / 4;
  var gridPrices = [
    priceMax,
    priceMax - priceStep,
    priceMax - 2 * priceStep,
    priceMax - 3 * priceStep,
    priceMin
  ];
  var gridYs = gridPrices.map(function (p) { return yPixel(p); });

  // ---------------------------------------------------------------------------
  // Volume calculations
  // ---------------------------------------------------------------------------
  var maxVolume = 0;
  for (var vi = 0; vi < candles.length; vi++) {
    var v = candles[vi].volumeMoney;
    if (typeof v === "number" && v > maxVolume) {
      maxVolume = v;
    }
  }
  if (maxVolume <= 0) { maxVolume = 1; }   // guard against zero volume
  var volMaxHeight = 55;
  var volBaseY = 275;

  // ---------------------------------------------------------------------------
  // MA5 points
  // ---------------------------------------------------------------------------
  var ma5Points = [];
  for (var mi = 0; mi < 5; mi++) {
    var ma5y = yPixel(ma5Values[mi] || 0);
    ma5Points.push(centerX[mi] + "," + ma5y);
  }
  var ma5Polyline = ma5Points.join(" ");

  // MA5 label — append "↓" if last MA5 value is lower than previous
  var lastMa5Val  = ma5Values[4];
  var prevMa5Val  = ma5Values[3];
  var lastMa5Y    = yPixel(lastMa5Val || 0);
  var ma5LabelStr = (typeof lastMa5Val === "number" && typeof prevMa5Val === "number" && lastMa5Val < prevMa5Val)
    ? "MA5↓"
    : "MA5";

  // ---------------------------------------------------------------------------
  // Build SVG string
  // ---------------------------------------------------------------------------
  var lines = [];

  lines.push('<svg viewBox="0 0 560 320" width="100%" max-width="560" height="auto" xmlns="http://www.w3.org/2000/svg">');

  // --- <defs> : volume bar gradients ---
  lines.push('  <defs>');
  lines.push('    <linearGradient id="volGrad' + stockCode + 'u" x1="0" y1="0" x2="0" y2="1">');
  lines.push('      <stop offset="0%" stop-color="#e74c3c" stop-opacity="0.35"/>');
  lines.push('      <stop offset="100%" stop-color="#e74c3c" stop-opacity="0.08"/>');
  lines.push('    </linearGradient>');
  lines.push('    <linearGradient id="volGrad' + stockCode + 'd" x1="0" y1="0" x2="0" y2="1">');
  lines.push('      <stop offset="0%" stop-color="#2ecc71" stop-opacity="0.35"/>');
  lines.push('      <stop offset="100%" stop-color="#2ecc71" stop-opacity="0.08"/>');
  lines.push('    </linearGradient>');
  lines.push('  </defs>');

  // --- Chart title ---
  var escapedTitle = chartTitle
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  lines.push('  <text x="280" y="11" fill="#8899aa" font-size="10" text-anchor="middle" font-family="sans-serif">' + escapedTitle + '</text>');

  // --- Grid lines ---
  for (var gi = 0; gi < 5; gi++) {
    lines.push('  <line x1="50" y1="' + gridYs[gi] + '" x2="530" y2="' + gridYs[gi] + '" stroke="#1e3050" stroke-width="0.5"/>');
  }

  // --- Price labels (left axis) ---
  for (var pi = 0; pi < 5; pi++) {
    var labelY = gridYs[pi] + 3;   // baseline offset for vertical centering
    lines.push('  <text x="35" y="' + labelY + '" fill="#8899aa" font-size="10" text-anchor="end" font-family="sans-serif">' + gridPrices[pi].toFixed(2) + '</text>');
  }

  // --- Volume axis labels (left) ---
  lines.push('  <text x="10" y="235" fill="#8899aa" font-size="9" font-family="sans-serif">成交</text>');
  lines.push('  <text x="10" y="248" fill="#8899aa" font-size="9" font-family="sans-serif">(亿)</text>');

  // --- Candles ---
  for (var i = 0; i < 5; i++) {
    var c  = candles[i];
    var cx = centerX[i];

    var openY  = yPixel(c.open);
    var closeY = yPixel(c.close);
    var highY  = yPixel(c.high);
    var lowY   = yPixel(c.low);

    // Body: higher price = smaller y = top of body
    var bodyTop    = Math.round(yPixel(Math.max(c.open, c.close)));
    var bodyBottom = Math.round(yPixel(Math.min(c.open, c.close)));
    var bodyHeight = Math.max(1, bodyBottom - bodyTop);

    var isUp  = c.close > c.open;
    var color = isUp ? "#e74c3c" : "#2ecc71";
    var dir   = isUp ? "UP" : "DOWN";

    // HTML comment before each candle
    lines.push('  <!-- Day' + (i + 1) + ' ' + c.date + ': O=' + c.open.toFixed(2) + ' H=' + c.high.toFixed(2) + ' L=' + c.low.toFixed(2) + ' C=' + c.close.toFixed(2) + ' (' + dir + ') -->');

    // Wick
    lines.push('  <line x1="' + cx + '" y1="' + highY + '" x2="' + cx + '" y2="' + lowY + '" stroke="' + color + '" stroke-width="1.5"/>');

    // Body
    var bodyX = cx - 18;
    lines.push('  <rect x="' + bodyX + '" y="' + bodyTop + '" width="36" height="' + bodyHeight + '" fill="' + color + '" rx="1"/>');
  }

  // --- MA5 polyline ---
  lines.push('  <polyline points="' + ma5Polyline + '" fill="none" stroke="#f39c12" stroke-width="1.2" stroke-dasharray="4,2"/>');

  // --- MA5 label ---
  lines.push('  <text x="435" y="' + (lastMa5Y + 2) + '" fill="#f39c12" font-size="9" font-family="sans-serif">' + ma5LabelStr + '</text>');

  // --- Volume bars ---
  for (var vi2 = 0; vi2 < 5; vi2++) {
    var cv    = candles[vi2];
    var cvx   = centerX[vi2];
    var barH  = Math.round((cv.volumeMoney / maxVolume) * volMaxHeight);
    var barYv = volBaseY - barH;
    var barXv = cvx - 18;
    var isVolUp = cv.close > cv.open;
    var gradSuffix = isVolUp ? "u" : "d";
    var gradId = "volGrad" + stockCode + gradSuffix;

    lines.push('  <rect x="' + barXv + '" y="' + barYv + '" width="36" height="' + barH + '" fill="url(#' + gradId + ')" rx="1" opacity="0.7"/>');
  }

  // --- Divider line (between price and volume areas) ---
  lines.push('  <line x1="50" y1="215" x2="530" y2="215" stroke="#1e3050" stroke-width="1"/>');

  // --- Date labels ---
  for (var di = 0; di < 5; di++) {
    var dc   = candles[di];
    var dcx  = centerX[di];

    // Determine label text
    var labelText;
    if (dc.labelHighlight) {
      labelText = dc.labelHighlight;
    } else {
      labelText = dc.date;
    }

    // Determine fill color and font-weight
    var labelFill   = "#8899aa";
    var labelWeight = "normal";

    if (dc.labelHighlight && dc.labelClass === "down") {
      labelFill   = "#e74c3c";
      labelWeight = "700";
    } else if (di === 4) {
      // Day 5 — "today" column, always gold bold
      labelFill   = "#c9a84c";
      labelWeight = "700";
    }

    lines.push('  <text x="' + dcx + '" y="290" fill="' + labelFill + '" font-size="10" text-anchor="middle" font-family="sans-serif" font-weight="' + labelWeight + '">' + labelText + '</text>');
  }

  // --- Legend (bottom of volume area) ---
  lines.push('  <rect x="250" y="298" width="10" height="10" fill="#e74c3c" rx="1"/>');
  lines.push('  <text x="264" y="306" fill="#8899aa" font-size="9" font-family="sans-serif">阳线(涨)</text>');

  lines.push('  <rect x="310" y="298" width="10" height="10" fill="#2ecc71" rx="1"/>');
  lines.push('  <text x="324" y="306" fill="#8899aa" font-size="9" font-family="sans-serif">阴线(跌)</text>');

  lines.push('  <text x="380" y="306" fill="#f39c12" font-size="9" font-family="sans-serif">--- MA5均线</text>');

  // Close SVG
  lines.push('</svg>');

  return lines.join("\n");
}

// ===========================================================================
// Animated Canvas K-line chart — professional financial software style
// Returns HTML string: <canvas> + inline <script> for self-contained animation
// Includes MACD and BOLL indicators with toggle buttons
// ===========================================================================
function renderKlineCanvas(stockCode, klineData) {
  var priceMin   = klineData.priceMin;
  var priceMax   = klineData.priceMax;
  var candles    = klineData.candles || [];
  var ma5Values  = klineData.ma5Values || [];
  var chartTitle = klineData.chartTitle || "";

  var W = 560, H = 440;
  var priceH = 190, priceTop = 18, priceBot = 208;
  var dividerY1 = 218;
  var macdTop = 222, macdH = 50, macdBot = 272;
  var dividerY2 = 278;
  var volBase = 340, volMaxH = 52;
  var dateY = 354;
  var priceSpan = priceMax - priceMin;
  var centerX = [65, 155, 245, 335, 425];

  function yPrice(p) { return priceTop + priceH * (1 - (p - priceMin) / priceSpan); }

  var maxVol = 0;
  for (var i = 0; i < candles.length; i++) {
    if (candles[i].volumeMoney > maxVol) maxVol = candles[i].volumeMoney;
  }
  if (maxVol <= 0) maxVol = 1;

  // ---- Compute MACD ----
  var closes = [];
  for (var i = 0; i < candles.length; i++) { closes.push(candles[i].close); }

  function ema(arr, period) {
    var k = 2 / (period + 1);
    var result = [arr[0]];
    for (var i = 1; i < arr.length; i++) {
      result.push(arr[i] * k + result[i - 1] * (1 - k));
    }
    return result;
  }
  function mean(arr) {
    var s = 0; for (var i = 0; i < arr.length; i++) s += arr[i]; return s / arr.length;
  }
  function stdev(arr) {
    var m = mean(arr);
    var sq = 0;
    for (var i = 0; i < arr.length; i++) { sq += (arr[i] - m) * (arr[i] - m); }
    return Math.sqrt(sq / arr.length);
  }

  var ema3 = ema(closes, 3);
  var ema5 = ema(closes, 5);
  var macdVals = [];
  for (var i = 0; i < closes.length; i++) { macdVals.push(ema3[i] - ema5[i]); }
  var signalVals = ema(macdVals, 3);
  var histVals = [];
  for (var i = 0; i < closes.length; i++) { histVals.push(macdVals[i] - signalVals[i]); }

  var macdAbsMax = 0;
  for (var i = 0; i < closes.length; i++) {
    var av = Math.abs(macdVals[i]);
    var sv = Math.abs(signalVals[i]);
    var hv = Math.abs(histVals[i]);
    if (av > macdAbsMax) macdAbsMax = av;
    if (sv > macdAbsMax) macdAbsMax = sv;
    if (hv > macdAbsMax) macdAbsMax = hv;
  }
  if (macdAbsMax < 0.01) macdAbsMax = 0.01;
  macdAbsMax *= 1.15;

  // ---- Compute BOLL (MA5 ± 2σ) ----
  var bollMid = [];
  var bollUpper = [];
  var bollLower = [];
  for (var i = 0; i < closes.length; i++) {
    var subset = closes.slice(0, i + 1);
    var m = mean(subset);
    var s = stdev(subset);
    bollMid.push(m);
    bollUpper.push(m + 2 * s);
    bollLower.push(m - 2 * s);
  }

  // Extend price range if BOLL bands exceed current bounds
  var adjPriceMin = priceMin;
  var adjPriceMax = priceMax;
  for (var i = 0; i < closes.length; i++) {
    if (bollLower[i] < adjPriceMin) adjPriceMin = bollLower[i];
    if (bollUpper[i] > adjPriceMax) adjPriceMax = bollUpper[i];
  }
  var adjPriceSpan = adjPriceMax - adjPriceMin;
  function yPriceAdj(p) { return priceTop + priceH * (1 - (p - adjPriceMin) / adjPriceSpan); }

  // ---- MACD Analysis (professional financial interpretation) ----
  var lastMACD = macdVals[4], prevMACD = macdVals[3];
  var lastSignal = signalVals[4];
  var lastHist = histVals[4], prevHist = histVals[3];
  var macdAnaText = '';
  if (lastMACD > lastSignal) {
    if (lastHist > prevHist) {
      macdAnaText = '<p><strong>MACD指标解读：</strong>DIF位于DEA上方呈多头排列，红柱较前日放大，多头动能持续增强，短期看涨信号明确。</p>';
    } else {
      macdAnaText = '<p><strong>MACD指标解读：</strong>DIF位于DEA上方但红柱缩短，多头动能边际减弱。若红柱持续缩小，需警惕短期顶背离及回调风险。</p>';
    }
  } else {
    if (lastHist < prevHist) {
      macdAnaText = '<p><strong>MACD指标解读：</strong>DIF位于DEA下方呈空头排列，绿柱负向扩大，空头动能增强，短期仍有下行压力。</p>';
    } else {
      macdAnaText = '<p><strong>MACD指标解读：</strong>DIF位于DEA下方但绿柱收窄，空头动能减弱。若DIF向上穿越DEA形成金叉，则有望迎来短期反弹。</p>';
    }
  }
  if (Math.abs(lastMACD - lastSignal) < macdAbsMax * 0.12) {
    macdAnaText += '<p>DIF与DEA趋于粘合，即将进行方向选择。若放量上穿则为金叉买入信号，若再度分离向下则延续弱势，下一交易日为关键观察窗口。</p>';
  }
  macdAnaText += '<p><strong>📈 下一交易日预测：</strong>' + (lastMACD > lastSignal ? 'MACD多头排列，若成交量配合放大，预计股价延续震荡上行。操作上可持股待涨，关注DIF与DEA是否维持多头发散。' : 'MACD空头排列，预计股价短期仍有调整需求。操作上建议观望为主，等待DIF上穿DEA形成金叉后再行介入。') + '</p>';

  // ---- BOLL Analysis (professional financial interpretation) ----
  var lastClose = closes[4];
  var lastUpper = bollUpper[4], lastLower = bollLower[4], lastMid = bollMid[4];
  var bandWidth = lastUpper - lastLower;
  var prevBandWidth = bollUpper[3] - bollLower[3];
  var pricePosition = (lastClose - lastLower) / (bandWidth || 0.01);
  var bollAnaText = '';
  if (pricePosition > 0.8) {
    bollAnaText = '<p><strong>BOLL指标解读：</strong>股价运行至上轨附近（位置' + (pricePosition*100).toFixed(0) + '%），处于超买区域。上轨构成强阻力位，短期存在技术性回调需求。</p>';
  } else if (pricePosition < 0.2) {
    bollAnaText = '<p><strong>BOLL指标解读：</strong>股价运行至下轨附近（位置' + (pricePosition*100).toFixed(0) + '%），处于超卖区域。下轨构成技术支撑，短期或有超跌反弹。</p>';
  } else if (pricePosition > 0.45 && pricePosition < 0.55) {
    bollAnaText = '<p><strong>BOLL指标解读：</strong>股价运行于中轨附近（位置' + (pricePosition*100).toFixed(0) + '%），处于合理波动中枢。中轨为短期多空分水岭。</p>';
  } else {
    bollAnaText = '<p><strong>BOLL指标解读：</strong>股价位于布林带' + (pricePosition > 0.5 ? '中轨与上轨之间' : '中轨与下轨之间') + '（位置' + (pricePosition*100).toFixed(0) + '%），波动空间适中。</p>';
  }
  if (bandWidth > prevBandWidth * 1.1) {
    bollAnaText += '<p>BOLL带宽较前日明显扩大，市场波动率上升，建议关注仓位管理和止损设置。</p>';
  } else if (bandWidth < prevBandWidth * 0.9) {
    bollAnaText += '<p>BOLL带宽收窄，市场进入盘整整固阶段。窄幅整理后往往伴随方向性突破，需密切关注突破方向及量能配合。</p>';
  }
  bollAnaText += '<p><strong>📈 下一交易日预测：</strong>' + (pricePosition > 0.8 ? '股价触及上轨压力位，若无超预期利好催化，大概率冲高回落或横盘消化。建议逢高适当减仓，等待回踩中轨后再评估介入时机。' : pricePosition < 0.2 ? '股价触及下轨支撑，若成交量放大配合，存在超跌技术性反弹需求。可轻仓博弈反弹，但需设好止损。' : '股价处于中轨附近，预计短期延续震荡格局。关注上下轨突破方向及成交量变化，突破上轨则转强，跌破下轨则转弱。') + '</p>';

  // Serialize data as JSON for inline script
  var chartJSON = JSON.stringify({
    W: W, H: H,
    priceMin: adjPriceMin, priceMax: adjPriceMax, priceSpan: adjPriceSpan,
    priceTop: priceTop, priceH: priceH, priceBot: priceBot,
    dividerY1: dividerY1, dividerY2: dividerY2,
    macdTop: macdTop, macdH: macdH, macdBot: macdBot,
    macdAbsMax: macdAbsMax,
    macdVals: macdVals, signalVals: signalVals, histVals: histVals,
    bollUpper: bollUpper, bollMid: bollMid, bollLower: bollLower,
    volBase: volBase, volMaxH: volMaxH, maxVol: maxVol,
    centerX: centerX, dateY: dateY,
    candles: candles,
    ma5Values: ma5Values,
    chartTitle: chartTitle,
    showMACD: true, showBOLL: true
  });

  var canvasId = 'klCanvas_' + stockCode + '_' + Math.random().toString(36).slice(2, 8);

  var anaIdBase = 'klAna_' + stockCode + '_' + Math.random().toString(36).slice(2, 6);

  return '<div class="kline-chart-wrapper">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">'
    + '<h4 style="margin:0;font-size:14px;">' + escHtmlKV(chartTitle) + '</h4>'
    + '<div style="display:flex;gap:5px;">'
    + '<button class="kl-ind-btn macd-btn active" id="macdBtn_' + canvasId + '" style="font-size:10px;padding:3px 10px;border:1px solid #d97706;border-radius:4px;background:#fef3c7;color:#92400e;cursor:pointer;font-weight:600;transition:all 0.15s;">MACD</button>'
    + '<button class="kl-ind-btn boll-btn active" id="bollBtn_' + canvasId + '" style="font-size:10px;padding:3px 10px;border:1px solid #7c3aed;border-radius:4px;background:#ede9fe;color:#5b21b6;cursor:pointer;font-weight:600;transition:all 0.15s;">BOLL</button>'
    + '</div></div>'
    + '<canvas id="' + canvasId + '" width="' + W + '" height="' + H + '" style="display:block;margin:0 auto;max-width:100%;border-radius:2px;"></canvas>'
    // MACD analysis panel
    + '<div id="macdAna_' + canvasId + '" style="margin-top:10px;padding:12px 16px;background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;font-size:0.85em;line-height:1.7;color:#1e293b;">'
    + macdAnaText
    + '</div>'
    // BOLL analysis panel
    + '<div id="bollAna_' + canvasId + '" style="margin-top:8px;padding:12px 16px;background:#f5f3ff;border:1px solid #c4b5fd;border-radius:6px;font-size:0.85em;line-height:1.7;color:#1e293b;">'
    + bollAnaText
    + '</div>'
    // Inline script — animation + toggle redraw
    + '<script>(function(){'
    + 'var data=' + chartJSON + ';'
    + 'var c=document.getElementById("' + canvasId + '");'
    + 'if(!c)return;'
    + 'var ctx=c.getContext("2d");'
    + 'var W=data.W,H=data.H;'
    + 'function yp(p){return data.priceTop+data.priceH*(1-(p-data.priceMin)/data.priceSpan);}'

    // Toggle state
    + 'var showMACD=true,showBOLL=true;'
    + 'var macdBt=document.getElementById("macdBtn_' + canvasId + '");'
    + 'var bollBt=document.getElementById("bollBtn_' + canvasId + '");'
    + 'var macdAna=document.getElementById("macdAna_' + canvasId + '");'
    + 'var bollAna=document.getElementById("bollAna_' + canvasId + '");'

    // drawFrame(done) — draws everything; done=0..5 candles visible, 5=all
    + 'function drawFrame(done){'
    + 'ctx.clearRect(0,0,W,H);'
    + 'ctx.fillStyle="#fafbfc";ctx.fillRect(0,0,W,H);'

    // Price grid
    + 'ctx.strokeStyle="#e2e8f0";ctx.lineWidth=0.5;'
    + 'for(var i=0;i<5;i++){var gy=yp(data.priceMin+data.priceSpan*i/4);'
    + 'ctx.beginPath();ctx.moveTo(50,gy);ctx.lineTo(530,gy);ctx.stroke();'
    + 'ctx.fillStyle="#94a3b8";ctx.font="10px sans-serif";ctx.textAlign="end";'
    + 'ctx.fillText((data.priceMin+data.priceSpan*i/4).toFixed(2),46,gy+3);}'

    // Dividers
    + 'ctx.strokeStyle="#cbd5e1";ctx.lineWidth=1;'
    + 'ctx.beginPath();ctx.moveTo(50,data.dividerY1);ctx.lineTo(530,data.dividerY1);ctx.stroke();'
    + 'ctx.beginPath();ctx.moveTo(50,data.dividerY2);ctx.lineTo(530,data.dividerY2);ctx.stroke();'
    + 'ctx.fillStyle="#94a3b8";ctx.font="9px sans-serif";ctx.textAlign="start";'
    + 'ctx.fillText("MACD",8,data.macdTop+14);'
    + 'ctx.fillText("成交(亿)",8,data.dividerY2+14);'

    // BOLL bands
    + 'if(showBOLL&&done>=2){'
    + 'ctx.fillStyle="rgba(124,58,237,0.06)";ctx.strokeStyle="rgba(124,58,237,0.3)";ctx.lineWidth=1;ctx.setLineDash([5,4]);'
    + 'ctx.beginPath();'
    + 'for(var i=0;i<Math.min(done,5);i++){'
    + 'var uy=yp(data.bollUpper[i]),ly=yp(data.bollLower[i]);'
    + 'var bx=data.centerX[i]-16;'
    + 'if(i===0){ctx.moveTo(bx,uy);ctx.lineTo(bx,ly);ctx.lineTo(bx+32,ly);}'
    + 'else{ctx.moveTo(data.centerX[i-1]+16,yp(data.bollUpper[i-1]));ctx.lineTo(bx,uy);ctx.lineTo(bx,ly);ctx.lineTo(data.centerX[i-1]+16,yp(data.bollLower[i-1]));}'
    + '}'
    + 'ctx.closePath();ctx.fill();'
    + 'ctx.beginPath();'
    + 'for(var i=0;i<Math.min(done,5);i++){var bx2=data.centerX[i];var uy2=yp(data.bollUpper[i]);'
    + 'if(i===0)ctx.moveTo(bx2,uy2);else ctx.lineTo(bx2,uy2);}'
    + 'ctx.strokeStyle="rgba(124,58,237,0.55)";ctx.stroke();'
    + 'ctx.beginPath();'
    + 'for(var i=0;i<Math.min(done,5);i++){var ly2=yp(data.bollLower[i]);'
    + 'if(i===0)ctx.moveTo(data.centerX[i],ly2);else ctx.lineTo(data.centerX[i],ly2);}'
    + 'ctx.stroke();'
    + 'if(done>=5){ctx.fillStyle="#7c3aed";ctx.font="9px sans-serif";ctx.textAlign="start";ctx.fillText("BOLL",480,yp(data.bollUpper[4])+2);}'
    + 'ctx.setLineDash([]);'
    + '}'

    // Candles + volume
    + 'for(var i=0;i<done;i++){'
    + 'var cx=data.centerX[i],cd=data.candles[i];'
    + 'var vh=Math.round((cd.volumeMoney/data.maxVol)*data.volMaxH);'
    + 'var vy=data.volBase-vh;'
    + 'var isUp=cd.close>cd.open;'
    + 'var volGrad=ctx.createLinearGradient(0,vy,0,data.volBase);'
    + 'if(isUp){volGrad.addColorStop(0,"rgba(220,38,38,0.4)");volGrad.addColorStop(1,"rgba(220,38,38,0.06)");}'
    + 'else{volGrad.addColorStop(0,"rgba(22,163,74,0.4)");volGrad.addColorStop(1,"rgba(22,163,74,0.06)");}'
    + 'ctx.fillStyle=volGrad;'
    + 'ctx.fillRect(cx-16,vy,32,vh);'
    + 'var hiY=yp(cd.high),loY=yp(cd.low);'
    + 'var col=isUp?"#dc2626":"#16a34a";'
    + 'ctx.strokeStyle=col;ctx.lineWidth=1.2;'
    + 'ctx.beginPath();ctx.moveTo(cx,hiY);ctx.lineTo(cx,loY);ctx.stroke();'
    + 'var bodyTop=yp(Math.max(cd.open,cd.close));'
    + 'var bodyBot=yp(Math.min(cd.open,cd.close));'
    + 'var bh=bodyBot-bodyTop;'
    + 'if(bh<1)bh=1;'
    + 'ctx.shadowColor=col;ctx.shadowBlur=3;'
    + 'ctx.fillStyle=col;'
    + 'ctx.fillRect(cx-15,bodyTop,30,bh);'
    + 'ctx.shadowBlur=0;'
    + 'ctx.fillStyle=i===4?"#b8942c":"#94a3b8";'
    + 'ctx.font=(i===4?"bold ":"")+"10px sans-serif";ctx.textAlign="center";'
    + 'var lbl=cd.labelHighlight||cd.date;'
    + 'if(cd.labelHighlight&&cd.labelClass==="down")ctx.fillStyle="#dc2626";'
    + 'ctx.fillText(lbl,cx,data.dateY);'
    + '}'

    // MA5
    + 'if(done>=2){'
    + 'ctx.strokeStyle="#d97706";ctx.lineWidth=1.5;ctx.setLineDash([4,3]);'
    + 'ctx.beginPath();'
    + 'for(var i=0;i<Math.min(done,5);i++){'
    + 'var mx=data.centerX[i],my=yp(data.ma5Values[i]||0);'
    + 'if(i===0)ctx.moveTo(mx,my);else ctx.lineTo(mx,my);'
    + '}'
    + 'ctx.stroke();ctx.setLineDash([]);'
    + 'for(var i=0;i<Math.min(done,5);i++){'
    + 'ctx.fillStyle="#d97706";ctx.beginPath();'
    + 'ctx.arc(data.centerX[i],yp(data.ma5Values[i]||0),2.5,0,Math.PI*2);ctx.fill();'
    + '}'
    + 'if(done>=5){'
    + 'var lastMa5=data.ma5Values[4],prevMa5=data.ma5Values[3];'
    + 'var lblMa5=(lastMa5<prevMa5)?"MA5↓":"MA5";'
    + 'ctx.fillStyle="#d97706";ctx.font="9px sans-serif";ctx.textAlign="start";'
    + 'ctx.fillText(lblMa5,435,yp(data.ma5Values[4])+2);'
    + '}'
    + '}'

    // MACD panel
    + 'if(showMACD){'
    + 'var zeroY=data.macdTop+data.macdH/2;'
    + 'ctx.strokeStyle="#e2e8f0";ctx.lineWidth=0.8;'
    + 'ctx.beginPath();ctx.moveTo(50,zeroY);ctx.lineTo(530,zeroY);ctx.stroke();'
    + 'ctx.fillStyle="#94a3b8";ctx.font="8px sans-serif";ctx.textAlign="end";'
    + 'ctx.fillText("0",46,zeroY+3);'
    + 'if(done>=2){'
    + 'ctx.strokeStyle="#d97706";ctx.lineWidth=1.2;ctx.setLineDash([3,3]);'
    + 'ctx.beginPath();'
    + 'for(var i=0;i<Math.min(done,5);i++){'
    + 'var sy=zeroY-(data.signalVals[i]/data.macdAbsMax)*(data.macdH/2);'
    + 'if(i===0)ctx.moveTo(data.centerX[i],sy);else ctx.lineTo(data.centerX[i],sy);'
    + '}'
    + 'ctx.stroke();ctx.setLineDash([]);'
    + '}'
    + 'for(var i=0;i<done;i++){'
    + 'var hv2=data.histVals[i],hx=data.centerX[i];'
    + 'var barH=Math.abs(hv2)/data.macdAbsMax*(data.macdH/2);'
    + 'if(barH<0.5)barH=0.5;'
    + 'var barY=hv2>=0?zeroY-barH:zeroY;'
    + 'ctx.fillStyle=hv2>=0?"rgba(220,38,38,0.7)":"rgba(22,163,74,0.7)";'
    + 'ctx.fillRect(hx-10,barY,20,barH);'
    + '}'
    + 'if(done>=3){'
    + 'ctx.fillStyle="#d97706";ctx.font="8px sans-serif";ctx.textAlign="start";'
    + 'ctx.fillText("SIGNAL",435,zeroY-(data.signalVals[Math.min(done-1,4)]/data.macdAbsMax)*(data.macdH/2));'
    + 'ctx.fillStyle="#dc2626";ctx.fillText("MACD",470,data.macdTop+12);'
    + '}'
    + '}'

    // Title + Legend
    + 'ctx.fillStyle="#94a3b8";ctx.font="10px sans-serif";ctx.textAlign="center";'
    + 'ctx.fillText(data.chartTitle,W/2,12);'
    + 'var legY=data.dateY+20;'
    + 'ctx.fillStyle="#dc2626";ctx.fillRect(220,legY,9,9);'
    + 'ctx.fillStyle="#64748b";ctx.font="9px sans-serif";ctx.textAlign="start";'
    + 'ctx.fillText("阳线(涨)",233,legY+8);'
    + 'ctx.fillStyle="#16a34a";ctx.fillRect(286,legY,9,9);'
    + 'ctx.fillText("阴线(跌)",299,legY+8);'
    + 'ctx.fillStyle="#d97706";ctx.fillText("--- MA5均线",356,legY+8);'
    + 'if(showBOLL){ctx.fillStyle="#7c3aed";ctx.fillText("--- BOLL带",424,legY+8);}'
    + '}'

    // Animation loop
    + 'var t=0;'
    + 'function animate(){'
    + 'var done=Math.min(Math.floor(t/12),5);'
    + 'drawFrame(done);'
    + 't++;'
    + 'if(t<=65)requestAnimationFrame(animate);'
    + '}'

    // Toggle button handlers — redraw full chart + toggle analysis panels
    + 'if(macdBt)macdBt.onclick=function(){showMACD=!showMACD;macdBt.classList.toggle("active",showMACD);'
    + 'macdBt.style.background=showMACD?"#fef3c7":"#f5f5f5";macdBt.style.color=showMACD?"#92400e":"#999";'
    + 'if(macdAna)macdAna.style.display=showMACD?"":"none";'
    + 'drawFrame(5);};'
    + 'if(bollBt)bollBt.onclick=function(){showBOLL=!showBOLL;bollBt.classList.toggle("active",showBOLL);'
    + 'bollBt.style.background=showBOLL?"#ede9fe":"#f5f5f5";bollBt.style.color=showBOLL?"#5b21b6":"#999";'
    + 'if(bollAna)bollAna.style.display=showBOLL?"":"none";'
    + 'drawFrame(5);};'

    + 'animate();'
    + '})();</' + 'script></div>';
}

function escHtmlKV(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
