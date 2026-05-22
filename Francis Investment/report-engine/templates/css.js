// Shared CSS for Francis Investment Report Engine
// Exports renderCSS() (PDF/dark theme) and renderSoftwareCSS() (app/light theme)

function renderSoftwareCSS() {
  return `
    :root {
      --primary: #1e293b;
      --accent: #b8942c;
      --accent-dark: #8b6914;
      --accent-light: #fdf6e8;
      --bg: #f8f9fb;
      --card-bg: #ffffff;
      --text: #1e293b;
      --text-muted: #64748b;
      --text-light: #94a3b8;
      --border: #e2e8f0;
      --border-light: #f1f5f9;
      --green: #16a34a;
      --red: #dc2626;
      --warning: #d97706;
      --shadow-sm: 0 1px 2px rgba(0,0,0,0.04);
      --shadow: 0 2px 12px rgba(0,0,0,0.06);
      --shadow-md: 0 4px 20px rgba(0,0,0,0.08);
      --radius: 10px;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Noto Sans SC', 'Microsoft YaHei', -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.7;
      -webkit-font-smoothing: antialiased;
    }

    .content {
      max-width: 1000px;
      margin: 0 auto;
      padding: 28px 48px;
    }

    /* Section header */
    .section-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 20px;
      padding-bottom: 12px;
      border-bottom: 2px solid var(--border);
    }
    .section-header .icon { font-size: 22px; }
    .section-header h2 {
      font-size: 1.25em;
      font-weight: 700;
      color: var(--primary);
      border: none;
      padding: 0;
      margin: 0;
      page-break-before: auto;
      page-break-after: auto;
    }
    /* Sector filter bar (潜力股推荐) */
    .sector-filter-bar { margin-bottom: 16px; }
    .sector-tag { user-select: none; }
    .sector-tag:hover { border-color: var(--accent) !important; color: var(--accent) !important; }

    .section-header .badge-count {
      margin-left: auto;
      font-size: 12px;
      color: var(--text-muted);
      background: var(--border-light);
      padding: 3px 10px;
      border-radius: 12px;
    }

    /* Metric cards row */
    .metrics-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin: 16px 0 24px;
    }
    .metric-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px 18px;
      text-align: center;
      box-shadow: var(--shadow-sm);
      transition: all 0.2s;
    }
    .metric-card:hover {
      transform: translateY(-2px);
      box-shadow: var(--shadow-md);
    }
    .metric-card .label {
      font-size: 12px;
      color: var(--text-muted);
      letter-spacing: 0.5px;
      margin-bottom: 8px;
      font-weight: 500;
    }
    .metric-card .value {
      font-size: 28px;
      font-weight: 800;
      margin: 4px 0;
      font-variant-numeric: tabular-nums;
    }
    .metric-card .sub {
      font-size: 11px;
      color: var(--text-light);
      margin-top: 4px;
    }
    .metric-card.good { border-left: 3px solid var(--green); }
    .metric-card.good .value { color: var(--green); }
    .metric-card.bad { border-left: 3px solid var(--red); }
    .metric-card.bad .value { color: var(--red); }

    /* Tables */
    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      margin: 16px 0;
      font-size: 13px;
      border-radius: var(--radius);
      overflow: hidden;
      border: 1px solid var(--border);
      box-shadow: var(--shadow-sm);
    }
    thead th {
      background: #f1f5f9;
      color: var(--primary);
      padding: 12px 14px;
      text-align: left;
      font-weight: 700;
      font-size: 12px;
      letter-spacing: 0.3px;
      border-bottom: 1px solid var(--border);
    }
    tbody td {
      padding: 11px 14px;
      border-bottom: 1px solid var(--border-light);
      color: var(--text);
      background: var(--card-bg);
    }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:hover td { background: #fafbfc; }
    .price-up { color: var(--red); font-weight: 600; }
    .price-down { color: var(--green); font-weight: 600; }
    .price-flat { color: var(--text-muted); }

    /* Event cards (news/policy) */
    .event-cards {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin: 16px 0;
    }
    .event-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-left: 4px solid var(--accent);
      border-radius: var(--radius);
      padding: 16px 20px;
      box-shadow: var(--shadow-sm);
      transition: all 0.2s;
    }
    .event-card:hover {
      box-shadow: var(--shadow);
      transform: translateX(2px);
    }
    .event-card .event-dim {
      font-size: 11px;
      font-weight: 700;
      color: var(--accent);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 4px;
    }
    .event-card .event-content {
      font-size: 14px;
      color: var(--text);
      margin-bottom: 6px;
      line-height: 1.6;
    }
    .event-card .event-impact {
      font-size: 12px;
      font-weight: 600;
      padding: 2px 0;
    }

    /* Stock cards (software) */
    .stock-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px 24px;
      margin: 16px 0;
      box-shadow: var(--shadow-sm);
      page-break-inside: avoid;
    }
    .stock-card.recommend { border-left: 4px solid var(--green); }
    .stock-card.hold { border-left: 4px solid var(--warning); }
    .stock-card.sell { border-left: 4px solid var(--red); }
    .stock-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 12px;
    }
    .stock-name { font-size: 1.15em; font-weight: 700; color: var(--primary); }
    .stock-price {
      background: var(--accent);
      color: #fff;
      padding: 5px 16px;
      border-radius: 20px;
      font-weight: 700;
      font-size: 0.9em;
      white-space: nowrap;
    }
    .stock-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 10px;
    }
    .stock-tags span {
      background: var(--accent-light);
      color: var(--accent-dark);
      padding: 3px 12px;
      border-radius: 12px;
      font-size: 0.8em;
      font-weight: 600;
      border: 1px solid rgba(184,148,44,0.2);
    }

    /* Section sub-headers */
    h3 {
      font-size: 1em;
      color: var(--primary);
      margin: 20px 0 10px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--border);
      font-weight: 700;
    }

    /* Callouts */
    .callout {
      padding: 16px 20px;
      margin: 16px 0;
      border-left: 4px solid;
      border-radius: 8px;
      font-size: 13px;
      background: #fff;
      box-shadow: var(--shadow-sm);
    }
    .callout.info { border-color: #3b82f6; background: #eff6ff; }
    .callout.warning { border-color: var(--warning); background: #fffbeb; }
    .callout.danger { border-color: var(--red); background: #fef2f2; }
    .callout.success { border-color: var(--green); background: #f0fdf4; }
    .callout strong { display: block; margin-bottom: 6px; font-size: 14px; color: var(--primary); }

    /* Sector grid */
    .sector-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
      margin: 16px 0;
    }
    @media (max-width: 900px) {
      .sector-grid { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 600px) {
      .sector-grid { grid-template-columns: 1fr; }
    }
    .sector-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 18px 20px;
      box-shadow: var(--shadow-sm);
      transition: all 0.2s;
    }
    .sector-card:hover {
      transform: translateY(-2px);
      box-shadow: var(--shadow);
    }
    .sector-card .sector-name { font-size: 1.05em; font-weight: 700; margin-bottom: 8px; color: var(--primary); }
    .sector-card .impact {
      display: inline-block;
      padding: 3px 12px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    .impact.positive { background: #dcfce7; color: #166534; }
    .impact.negative { background: #fee2e2; color: #991b1b; }
    .impact.neutral { background: #fef3c7; color: #92400e; }
    .sector-card p { font-size: 0.88em; color: var(--text-muted); margin: 0; }

    /* Tech grid */
    .tech-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      margin: 16px 0;
    }
    .tech-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 18px 20px;
      box-shadow: var(--shadow-sm);
    }
    .tech-card h4 {
      color: var(--primary);
      margin-bottom: 8px;
      font-size: 14px;
    }
    .signal-buy { color: var(--red); font-weight: 700; }
    .signal-sell { color: var(--green); font-weight: 700; }
    .signal-neutral { color: var(--warning); font-weight: 700; }

    /* K-line wrapper */
    .kline-chart-wrapper {
      background: #fafbfc;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px 20px;
      margin: 16px 0;
      box-shadow: var(--shadow-sm);
    }
    .kline-chart-wrapper h4 {
      color: var(--text-muted);
      font-size: 12px;
      margin-bottom: 8px;
      text-align: center;
      font-weight: 500;
    }

    /* Ranking */
    .rank-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      font-weight: 900;
      font-size: 15px;
    }
    .rank-1 { background: linear-gradient(135deg, #FFD700, #FFA500); color: #000; }
    .rank-2 { background: linear-gradient(135deg, #C0C0C0, #A0A0A0); color: #000; }
    .rank-3 { background: linear-gradient(135deg, #CD7F32, #A0522D); color: #fff; }
    .rank-4, .rank-5 { background: #f1f5f9; color: var(--text-muted); border: 2px solid #e2e8f0; }

    /* Disclaimer */
    .disclaimer {
      background: #fef2f2;
      border: 2px solid #fecaca;
      border-radius: var(--radius);
      padding: 20px 24px;
      margin: 20px 0;
    }
    .disclaimer h3 { color: var(--red); border: none; margin-top: 0; }

    .footer {
      text-align: center;
      padding: 24px;
      color: var(--text-light);
      font-size: 12px;
      border-top: 1px solid var(--border);
      margin-top: 24px;
    }

    /* Cover (software) */
    .cover-software {
      text-align: center;
      padding: 80px 48px;
      background: linear-gradient(135deg, #fafbfc 0%, #f0f4f8 100%);
      border-radius: var(--radius);
      border: 1px solid var(--border);
      min-height: 70vh;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
    }
    .cover-software .ci-badge {
      display: inline-block;
      border: 2px solid var(--accent);
      color: var(--accent);
      padding: 10px 28px;
      font-size: 14px;
      letter-spacing: 4px;
      margin-bottom: 32px;
      font-weight: 600;
    }
    .cover-software h1 {
      font-size: 42px;
      font-weight: 900;
      color: var(--primary);
      margin-bottom: 12px;
      line-height: 1.3;
    }
    .cover-software h1 span { color: var(--accent); }
    .cover-software .subtitle {
      font-size: 18px;
      color: var(--text-muted);
      margin-bottom: 32px;
      max-width: 640px;
    }
    .cover-software .meta-row {
      display: flex;
      justify-content: center;
      gap: 28px;
      flex-wrap: wrap;
      font-size: 14px;
      color: var(--text-muted);
      margin-bottom: 20px;
    }
    .cover-software .meta-item {
      display: flex;
      align-items: center;
      gap: 6px;
      background: #fff;
      padding: 8px 16px;
      border-radius: 8px;
      border: 1px solid var(--border);
    }
    .cover-software .meta-item strong { color: var(--primary); font-weight: 600; }
    .cover-software .alert-line {
      color: var(--red);
      font-size: 13px;
      border: 1px solid #fecaca;
      display: inline-block;
      padding: 10px 22px;
      border-radius: 6px;
      background: #fff;
      margin-top: 8px;
    }

    @media (max-width: 768px) {
      .tech-grid { grid-template-columns: 1fr; }
      .sector-grid { grid-template-columns: 1fr; }
      .metrics-row { grid-template-columns: repeat(2, 1fr); }
      .cover-software h1 { font-size: 24px; }
      table { font-size: 12px; }
    }

    @media print {
      html, body {
        background: #fff;
        font-size: 14px;
        line-height: 1.7;
      }

      .cover-software {
        page-break-after: always;
        padding: 60px 40px;
      }

      h2 { page-break-before: auto; page-break-after: avoid; }
      h3 { page-break-after: avoid; }
      .stock-card, .kline-chart-wrapper, .kline-chart-wrapper + table,
      .tech-grid, .callout, .disclaimer { page-break-inside: avoid; }
      .tech-grid { grid-template-columns: 1fr; }
      .sector-grid { grid-template-columns: 1fr 1fr; }

      @page { size: A4; margin: 12mm 10mm; }
    }
  `;
}

function renderCSS() {
  return `
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@300;400;500;700;900&display=swap');

    :root {
      --primary: #0a1f3f;
      --accent: #c9a84c;
      --bg: #0a1628;
      --card-bg: #0f1f3a;
      --text: #e0e0e0;
      --text-muted: #8899aa;
      --border: #1e3050;
      --green: #2ecc71;
      --red: #e74c3c;
      --warning: #f39c12;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.8;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    @page { size: A4; margin: 12mm 10mm; }

    /* COVER */
    .cover {
      background: linear-gradient(135deg, #050d1a 0%, #0a1f3f 40%, #0d1a30 100%);
      padding: 60px 32px;
      text-align: center;
      border-bottom: 3px solid var(--accent);
      position: relative;
      overflow: hidden;
      page-break-after: always;
    }
    .cover::before {
      content: '';
      position: absolute;
      top: -50%; left: -50%;
      width: 200%; height: 200%;
      background: radial-gradient(circle at 30% 50%, rgba(201,168,76,0.08) 0%, transparent 60%),
                  radial-gradient(circle at 70% 30%, rgba(46,204,113,0.05) 0%, transparent 50%);
    }
    .cover .badge {
      display: inline-block;
      border: 2px solid var(--accent);
      color: var(--accent);
      padding: 8px 24px;
      font-size: 14px;
      letter-spacing: 4px;
      margin-bottom: 36px;
      position: relative;
      z-index: 1;
    }
    .cover h1 {
      font-size: 42px;
      font-weight: 900;
      color: #fff;
      position: relative;
      z-index: 1;
    }
    .cover h1 span { color: var(--accent); }
    .cover .subtitle {
      font-size: 18px;
      color: var(--text-muted);
      margin-top: 12px;
      position: relative;
      z-index: 1;
    }
    .cover .meta {
      margin-top: 36px;
      font-size: 13px;
      color: #5a6a80;
      position: relative;
      z-index: 1;
      line-height: 2;
    }
    .cover .alert-badge {
      display: inline-block;
      margin-top: 24px;
      padding: 8px 18px;
      border: 1px solid var(--red);
      color: var(--red);
      border-radius: 4px;
      font-size: 13px;
      position: relative;
      z-index: 1;
    }

    /* CONTENT */
    .content { max-width: 1000px; margin: 0 auto; padding: 28px 20px; }

    h2 {
      font-size: 1.5em;
      color: var(--accent);
      border-left: 4px solid var(--accent);
      padding-left: 14px;
      margin: 48px 0 20px;
      page-break-before: always;
    }
    h2:first-of-type { page-break-before: avoid; }
    h3 {
      font-size: 1.15em;
      color: #d0d8e8;
      margin: 24px 0 12px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--border);
    }

    /* Metric cards */
    .metrics-row {
      display: flex; gap: 14px; margin: 20px 0; flex-wrap: wrap;
    }
    .metric-card {
      flex: 1; min-width: 140px;
      background: var(--card-bg); border: 1px solid var(--border);
      padding: 18px 16px; text-align: center; border-radius: 8px;
    }
    .metric-card .label { font-size: 12px; color: var(--text-muted); letter-spacing: 1px; }
    .metric-card .value { font-size: 26px; font-weight: 700; margin: 6px 0; }
    .metric-card .sub { font-size: 11px; color: var(--text-muted); }
    .metric-card.warn { border-color: var(--warning); }
    .metric-card.bad { border-color: var(--red); }
    .metric-card.good { border-color: var(--green); }

    /* Tables */
    table {
      width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px;
    }
    thead th {
      background: var(--primary); color: var(--accent); padding: 10px 12px;
      text-align: left; font-weight: 600; border-bottom: 2px solid var(--border);
    }
    tbody td {
      padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.06); color: #c8d0dc;
    }
    tbody tr:hover td { background: rgba(201,168,76,0.04); }
    .price-up { color: var(--green); }
    .price-down { color: var(--red); }
    .price-flat { color: var(--text-muted); }

    /* Stock cards */
    .stock-card {
      background: var(--card-bg); border: 1px solid var(--border);
      border-left: 4px solid var(--accent); border-radius: 8px;
      padding: 20px 24px; margin: 16px 0; page-break-inside: avoid;
    }
    .stock-card.recommend { border-left-color: var(--green); }
    .stock-card.hold { border-left-color: var(--warning); }
    .stock-card.sell { border-left-color: var(--red); }
    .stock-header {
      display: flex; justify-content: space-between; align-items: center;
      flex-wrap: wrap; gap: 10px; margin-bottom: 12px;
    }
    .stock-name { font-size: 1.2em; font-weight: 700; color: #fff; }
    .stock-price {
      background: var(--accent); color: #0a1628; padding: 4px 14px;
      border-radius: 20px; font-weight: 700; font-size: 0.9em;
    }
    .stock-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
    .stock-tags span {
      background: rgba(201,168,76,0.12); color: var(--accent);
      padding: 2px 10px; border-radius: 10px; font-size: 0.78em;
      border: 1px solid rgba(201,168,76,0.25);
    }

    /* Callouts */
    .callout {
      padding: 16px 20px; margin: 16px 0; border-left: 4px solid;
      border-radius: 4px; font-size: 14px; page-break-inside: avoid;
    }
    .callout.info { background: rgba(58,123,213,0.1); border-color: #3a7bd5; }
    .callout.warning { background: rgba(243,156,18,0.1); border-color: var(--warning); }
    .callout.danger { background: rgba(231,76,60,0.1); border-color: var(--red); }
    .callout.success { background: rgba(46,204,113,0.1); border-color: var(--green); }
    .callout strong { display: block; margin-bottom: 6px; font-size: 15px; }

    /* Sector cards */
    .sector-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 14px; margin: 16px 0;
    }
    .sector-card {
      background: var(--card-bg); border: 1px solid var(--border);
      border-radius: 8px; padding: 18px 20px; page-break-inside: avoid;
    }
    .sector-card .sector-name { font-size: 1.05em; font-weight: 700; margin-bottom: 8px; }
    .sector-card .impact { display: inline-block; padding: 3px 10px; border-radius: 12px;
      font-size: 11px; font-weight: 600; margin-bottom: 8px; }
    .impact.positive { background: rgba(46,204,113,0.2); color: var(--green); }
    .impact.negative { background: rgba(231,76,60,0.2); color: var(--red); }
    .impact.neutral { background: rgba(243,156,18,0.2); color: var(--warning); }
    .sector-card p { font-size: 0.88em; color: var(--text-muted); margin: 0; }

    /* Technical section */
    .tech-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 16px 0;
    }
    .tech-card {
      background: var(--card-bg); border: 1px solid var(--border);
      border-radius: 8px; padding: 16px 18px;
    }
    .signal-buy { color: var(--green); font-weight: 700; }
    .signal-sell { color: var(--red); font-weight: 700; }
    .signal-neutral { color: var(--warning); font-weight: 700; }

    /* Ranking */
    .ranking-table { margin: 20px 0; }
    .ranking-table td { vertical-align: middle; }
    .rank-badge {
      display: inline-flex; align-items: center; justify-content: center;
      width: 36px; height: 36px; border-radius: 50%; font-weight: 900; font-size: 18px;
    }
    .rank-1 { background: linear-gradient(135deg, #FFD700, #FFA500); color: #000; }
    .rank-2 { background: linear-gradient(135deg, #C0C0C0, #A0A0A0); color: #000; }
    .rank-3 { background: linear-gradient(135deg, #CD7F32, #A0522D); color: #fff; }
    .rank-4, .rank-5 { background: var(--primary); color: var(--accent); border: 2px solid var(--border); }

    /* K-line review */
    .kline-chart-wrapper {
      background: #080e18;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 16px 8px;
      margin: 16px 0;
      overflow-x: auto;
    }
    .kline-chart-wrapper h4 {
      color: var(--accent);
      font-size: 13px;
      margin-bottom: 4px;
      text-align: center;
    }
    .kline-chart-wrapper svg {
      display: block;
      margin: 0 auto;
    }

    .footer {
      text-align: center; padding: 40px; color: #4a5a70; font-size: 12px;
      border-top: 1px solid var(--border); margin-top: 40px;
    }

    .disclaimer {
      background: rgba(231,76,60,0.08); border: 2px solid rgba(231,76,60,0.4);
      border-radius: 8px; padding: 24px 28px; margin: 20px 0; page-break-inside: avoid;
    }
    .disclaimer h3 { color: var(--red); border: none; }

    @media (max-width: 768px) {
      .tech-grid { grid-template-columns: 1fr; }
      .sector-grid { grid-template-columns: 1fr; }
      .cover h1 { font-size: 28px; }
      .content { padding: 16px 10px; }
      table { font-size: 12px; }
      thead th, tbody td { padding: 6px 8px; }
      .kline-chart-wrapper { padding: 8px 6px; }
      .kline-chart-wrapper svg { max-width: 100%; height: auto; }
    }

    @media print {
      html, body {
        background: #0a1628;
        font-size: 15px;
        line-height: 1.75;
        margin: 0;
        padding: 0;
      }

      .cover {
        page-break-after: always;
        padding: 80px 50px;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        justify-content: center;
      }
      .cover h1 { font-size: 36px; }
      .cover .subtitle { font-size: 18px; }
      .cover .meta { font-size: 14px; }
      .cover .badge { font-size: 15px; padding: 10px 28px; }

      .content {
        max-width: 100%;
        padding: 20px 28px;
      }

      h2 {
        font-size: 1.4em;
        page-break-before: auto;
        page-break-after: avoid;
        margin: 36px 0 16px;
        padding-left: 16px;
      }
      h2:first-of-type { page-break-before: avoid; }

      h3 {
        font-size: 1.15em;
        margin: 20px 0 10px;
        page-break-after: avoid;
      }

      .tech-grid {
        grid-template-columns: 1fr;
        gap: 12px;
        page-break-inside: avoid;
      }
      .sector-grid { grid-template-columns: 1fr 1fr; gap: 10px; }
      .metrics-row { gap: 10px; flex-wrap: wrap; }
      .metric-card { min-width: 130px; padding: 16px 14px; flex: 1 1 30%; }
      .metric-card .value { font-size: 24px; }

      table { font-size: 13px; margin: 12px 0; }
      thead th { padding: 9px 10px; font-size: 12px; }
      tbody td { padding: 9px 10px; }

      .stock-card {
        padding: 18px 22px;
        page-break-inside: avoid;
      }

      .kline-chart-wrapper {
        padding: 14px 12px;
        page-break-inside: avoid;
        margin: 14px 0;
      }
      .kline-chart-wrapper svg { max-width: 100%; height: auto; }

      .kline-chart-wrapper + table {
        page-break-inside: avoid;
      }

      .stock-header + .stock-tags + h3 { page-break-before: auto; }

      .stock-card.recommend {
        page-break-inside: avoid;
        margin: 14px 0;
      }

      h3 + p { page-break-before: avoid; }
      h3 + table { page-break-before: avoid; }
      h3 + .tech-grid { page-break-before: avoid; }
      h3 + .kline-chart-wrapper { page-break-before: avoid; }

      .callout {
        font-size: 13px;
        padding: 15px 18px;
        page-break-inside: avoid;
      }

      .footer { padding: 30px 22px; font-size: 11px; }
      .disclaimer {
        padding: 22px 24px;
        font-size: 13px;
        page-break-inside: avoid;
      }

      @page {
        size: A4;
        margin: 0;
      }
    }
  `;
}
