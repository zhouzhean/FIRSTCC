/**
 * Section 7: 核心风险矩阵
 * Data path: data.section7_riskMatrix
 */

function formatFiveDisciplines(body) {
  if (!body) return "";
  const lines = body.split("\n");
  const wrapped = lines.map(function (line) {
    // If line contains ①-⑤ and is not already wrapped in <b>, wrap it
    if (/[①-⑤]/.test(line) && !/<b>/.test(line)) {
      return "<b>" + line + "</b>";
    }
    return line;
  });
  return wrapped.join("<br>\n");
}

function renderRiskMatrix(data, mode) {
  mode = mode || 'pdf';
  const d = data.section7_riskMatrix;
  if (!d) return "";

  var html = "";

  const sectionTitle = mode === 'app'
    ? '<div class="section-header"><span class="icon">⚠️</span><h2>核心风险矩阵</h2></div>'
    : '<h2>七、核心风险矩阵</h2>';

  html += sectionTitle + '\n\n';

  // ---- Risks table ----
  html += '<table>\n';
  html += '  <thead><tr><th>风险</th><th>概率</th><th>影响程度</th><th>应对策略</th></tr></thead>\n';
  html += '  <tbody>\n';

  if (d.risks && d.risks.length > 0) {
    for (var i = 0; i < d.risks.length; i++) {
      var r = d.risks[i];
      html += '    <tr>\n';
      html += '      <td><strong>' + (r.risk || "") + '</strong></td>\n';
      html += '      <td>' + (r.probability || "") + '</td>\n';
      html += '      <td>' + (r.impact || "") + '</td>\n';
      html += '      <td>' + (r.strategy || "") + '</td>\n';
      html += '    </tr>\n';
    }
  }

  html += '  </tbody>\n';
  html += '</table>\n\n';

  // ---- fiveDisciplines callout ----
  if (d.fiveDisciplines) {
    var fd = d.fiveDisciplines;
    html += '<div class="callout ' + (fd.calloutType || "danger") + '">\n';
    html += '  <strong>' + (fd.title || "") + '</strong>\n';
    html += '  ' + formatFiveDisciplines(fd.body || "") + '\n';
    html += '</div>\n';
  }

  return html;
}

// CommonJS export (also works as global via <script> tag)
if (typeof module !== "undefined" && module.exports) {
  module.exports = { renderRiskMatrix, formatFiveDisciplines };
}
