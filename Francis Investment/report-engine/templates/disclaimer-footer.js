/** Disclaimer and footer template for the Francis Investment Report Engine. */

function renderDisclaimer(data, mode) {
  mode = mode || 'pdf';
  const d = data.disclaimer;

  return `<div class="disclaimer">
  <h3>&#9888; 免责声明</h3>
  <p>${d.introLine}</p>
  <p>${d.sourceNote}</p>
  <p>${d.analysisNote}</p>
  <p>${d.techNote}</p>
  <p style="margin-top:12px;">${d.dateLine}</p>
</div>

<div class="footer">
  ${d.footerHTML}
</div>`;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { renderDisclaimer };
}
