/**
 * holdings-analysis.js
 * Section 3: 当前持仓深度分析
 *
 * Renders full holdings analysis for both 金发科技(600143) and 利欧股份(002131).
 * Depends on renderKlineSVG() from kline.js (loaded via <script> tag, global scope).
 */

function mapClass(judgmentClass) {
  switch (judgmentClass) {
    case "up":   return "price-up";
    case "down": return "price-down";
    case "flat": return "price-flat";
    default:     return "";
  }
}

function renderHoldingsAnalysis(data, mode) {
  mode = mode || 'pdf';
  var stocks = data.section3_holdingsAnalysis.stocks;
  if (!stocks || !stocks.length) {
    return "";
  }

  var sectionTitle = mode === 'app'
    ? '<div class="section-header"><span class="icon"></span><h2>当前持仓深度分析</h2><span class="badge-count">' + stocks.length + ' 只持仓</span></div>'
    : '<h2>三、当前持仓深度分析</h2>';

  var html = sectionTitle + '\n';

  for (var i = 0; i < stocks.length; i++) {
    var stock = stocks[i];

    // --- Card type border color ---
    var borderColorVar;
    switch (stock.cardType) {
      case "sell":      borderColorVar = "var(--red)";     break;
      case "recommend": borderColorVar = "var(--green)";   break;
      case "hold":
      default:          borderColorVar = "var(--warning)"; break;
    }

    // --- Price formatting ---
    var priceStr = (typeof stock.price === "number") ? stock.price.toFixed(2) : stock.price;
    var changePct = stock.changePercent;
    var changeSign = (changePct >= 0) ? "+" : "";
    var changePctStr = changeSign + changePct + "%";

    html += '<div class="stock-card ' + stock.cardType + '" style="border-left-color:' + borderColorVar + ';">\n';

    // --- Stock header ---
    html += '  <div class="stock-header">\n';
    html += '    <div>\n';
    html += '      <span class="stock-name">' + stock.name + '</span>\n';
    html += '      <span style="color:var(--text-muted);font-size:0.85em;">' + stock.code + ' · ' + stock.exchange + '</span>\n';
    html += '    </div>\n';
    html += '    <span class="stock-price">' + priceStr + '元 (' + changePctStr + '%)</span>\n';
    html += '  </div>\n';

    // --- Tags ---
    html += '  <div class="stock-tags">\n';
    var tags = stock.tags || [];
    for (var t = 0; t < tags.length; t++) {
      html += '    <span>' + tags[t] + '</span>\n';
    }
    html += '  </div>\n';

    // --- Fundamentals table ---
    html += '  <h3 style="font-size:14px;color:var(--accent);margin:16px 0 8px;">基本面速览</h3>\n';
    html += '  <table>\n';
    html += '    <thead><tr><th>维度</th><th>数据</th><th>判断</th></tr></thead>\n';
    html += '    <tbody>\n';
    var fundamentals = stock.fundamentals || [];
    for (var f = 0; f < fundamentals.length; f++) {
      var row = fundamentals[f];
      html += '      <tr>\n';
      html += '        <td><strong>' + row.dimension + '</strong></td>\n';
      html += '        <td>' + row.data + '</td>\n';
      html += '        <td class="' + mapClass(row.judgmentClass) + '">' + row.judgment + '</td>\n';
      html += '      </tr>\n';
    }
    html += '    </tbody>\n';
    html += '  </table>\n';

    // --- K-line section ---
    var kline = stock.kline;
    html += '  <h3 style="font-size:14px;color:var(--accent);margin:16px 0 8px;">近一周K线走势回顾（5月11日-15日）</h3>\n';
    if (mode === 'app') {
      html += '  ' + renderKlineCanvas(stock.code, kline) + '\n';
    } else {
      html += '  <div class="kline-chart-wrapper">\n';
      html += '    <h4>' + (kline.chartTitle || "") + '</h4>\n';
      html += '    ' + renderKlineSVG(stock.code, kline) + '\n';
      html += '  </div>\n';
    }

    // --- K-line data table ---
    html += '  <table>\n';
    html += '    <thead><tr><th>日期</th><th>开盘</th><th>收盘</th><th>最高</th><th>最低</th><th>涨跌幅</th><th>成交额</th><th>特征</th></tr></thead>\n';
    html += '    <tbody>\n';
    var candles = kline.candles || [];
    for (var c = 0; c < candles.length; c++) {
      var candle = candles[c];
      var cChangePct = candle.changePercent;
      var cChangeSign = (cChangePct >= 0) ? "+" : "";
      var cChangePctStr = cChangeSign + cChangePct + "%";
      var cChangeClass;
      if (cChangePct > 0) {
        cChangeClass = "price-up";
      } else if (cChangePct < 0) {
        cChangeClass = "price-down";
      } else {
        cChangeClass = "";
      }
      var openStr  = (typeof candle.open  === "number") ? candle.open.toFixed(2)  : candle.open;
      var closeStr = (typeof candle.close === "number") ? candle.close.toFixed(2) : candle.close;
      var highStr  = (typeof candle.high  === "number") ? candle.high.toFixed(2)  : candle.high;
      var lowStr   = (typeof candle.low   === "number") ? candle.low.toFixed(2)   : candle.low;
      var volStr   = (typeof candle.volumeMoney === "number") ? candle.volumeMoney.toFixed(2) : candle.volumeMoney;

      if (candle.highlighted) {
        html += '      <tr>\n';
        html += '        <td><strong>' + candle.date + '(' + candle.dayOfWeek + ')</strong></td>\n';
        html += '        <td><strong>' + openStr  + '</strong></td>\n';
        html += '        <td><strong>' + closeStr + '</strong></td>\n';
        html += '        <td><strong>' + highStr  + '</strong></td>\n';
        html += '        <td><strong>' + lowStr   + '</strong></td>\n';
        html += '        <td class="' + cChangeClass + '"><strong>' + cChangePctStr + '%</strong></td>\n';
        html += '        <td><strong>' + volStr + '亿</strong></td>\n';
        html += '        <td><strong>' + (candle.feature || "") + '</strong></td>\n';
        html += '      </tr>\n';
      } else {
        html += '      <tr>\n';
        html += '        <td>' + candle.date + '(' + candle.dayOfWeek + ')</td>\n';
        html += '        <td>' + openStr  + '</td>\n';
        html += '        <td>' + closeStr + '</td>\n';
        html += '        <td>' + highStr  + '</td>\n';
        html += '        <td>' + lowStr   + '</td>\n';
        html += '        <td class="' + cChangeClass + '">' + cChangePctStr + '%</td>\n';
        html += '        <td>' + volStr + '亿</td>\n';
        html += '        <td>' + (candle.feature || "") + '</td>\n';
        html += '      </tr>\n';
      }
    }
    html += '    </tbody>\n';
    html += '  </table>\n';

    // --- Weekly review ---
    html += '  <p style="font-size:0.9em;color:var(--text-muted);margin:8px 0;">\n';
    html += '    <strong>近一周走势总结：</strong>' + (stock.weeklyReview || "") + '\n';
    html += '  </p>\n';

    // --- Monthly review ---
    html += '  <h3 style="font-size:14px;color:var(--accent);margin:16px 0 8px;">近一月走势回顾</h3>\n';
    html += '  <p style="font-size:0.9em;color:var(--text-muted);">' + (stock.monthlyReview || "") + '</p>\n';

    // --- Tech analysis grid ---
    var tech = stock.techAnalysis || {};
    html += '  <h3 style="font-size:14px;color:var(--accent);margin:16px 0 8px;">技术面综合评估</h3>\n';
    html += '  <div class="tech-grid">\n';
    html += '    <div class="tech-card">\n';
    html += '      <h4 style="color:var(--accent);margin-bottom:8px;"> K线与均线系统</h4>\n';
    html += '      <p style="font-size:0.9em;">' + (tech.maSystem || "") + '</p>\n';
    html += '    </div>\n';
    html += '    <div class="tech-card">\n';
    html += '      <h4 style="color:var(--accent);margin-bottom:8px;"> 技术指标</h4>\n';
    html += '      <p style="font-size:0.9em;">' + (tech.indicators || "") + '</p>\n';
    html += '    </div>\n';
    html += '  </div>\n';

    // --- Overall rating callout ---
    var rating = stock.overallRating || {};
    html += '  <div class="callout ' + (rating.calloutType || "success") + '">\n';
    html += '    <strong>' + (rating.title || "") + '</strong>\n';
    html += '    ' + (rating.body || "") + '\n';
    html += '  </div>\n';

    html += '</div>\n'; // close stock-card
  }

  return html;
}
