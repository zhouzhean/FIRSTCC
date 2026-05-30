# CLAUDE.md

Static web project — no build tools, no package manager, no tests. HTML/CSS/JS run directly in browser.

## Contents

| Path | Description |
|------|-------------|
| `pomodoro/` | Pomodoro timer (vanilla JS, localStorage) |
| `calendar.html` | Cyberpunk calendar (self-contained single file) |
| `Francis Investment/` | A-stock quant system + report engine → see `Francis Investment/CLAUDE.md` |

## Francis Investment (quick reference)

- **Cloud**: `http://8.153.101.112:8765` (Alibaba Cloud ECS, Ubuntu 22.04, systemd `mosaic.service`)
- **Local debug**: `node mosaic_server.js` → `http://localhost:8765`
- **Desktop shortcut**: `open.vbs` → opens cloud URL in Chrome `--app` mode
- **Stop server**: `taskkill /F /IM node.exe` (local) or `systemctl stop mosaic` (cloud)

## Git

- Remote: `https://github.com/zhouzhean/FIRSTCC`
- Auth: HTTPS via GitHub CLI (`gh auth login`)
- **Runtime data files (never commit)**: `portfolio.json`, `scheduler_state.json`, `events/*.json`, `summaries/*.json`, `knowledge_base/*.json`, `us_market/*.json`, `correlation_history.json`, `index_history_*.json`, `factor_performance.json`, `weekend_context.json`, `scan_records_*.json`, `last_pipeline_result.json`, `market_history/indices/*.json`
