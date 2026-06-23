# CLAUDE.md

Static web project — no build tools, no package manager, no tests. HTML/CSS/JS run directly in browser.

## Contents

| Path | Description |
|------|-------------|
| `pomodoro/` | Pomodoro timer (vanilla JS, localStorage) |
| `calendar.html` | Cyberpunk calendar (self-contained single file) |
| `Francis Investment/` | A-stock quant system v3.4.9.4.2 + report engine → see `Francis Investment/CLAUDE.md` |

## Francis Investment (quick reference)

- **Cloud**: `http://8.153.101.112:8765` (Alibaba Cloud ECS, Ubuntu 22.04, systemd `mosaic.service`)
- **Local debug**: `node mosaic_server.js` → `http://localhost:8765`
- **Desktop shortcut**: `open.vbs` → opens cloud URL in Chrome `--app` mode
- **Stop server**: `taskkill /F /IM node.exe` (local) or `systemctl stop mosaic` (cloud)
- **Version**: v3.4.9.4.2 — Evidence Cohort Production Acceptance: unified API counting, deploy identity fallback, verification test fix

## Git

- Remote: `https://github.com/zhouzhean/FIRSTCC.git`
- Auth: HTTPS via GitHub CLI (`gh auth login`)
- **Runtime data files (never commit)**: See `Francis Investment/.gitignore`
