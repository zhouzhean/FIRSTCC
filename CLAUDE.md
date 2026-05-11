# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Static web project — no build tools, no package manager, no tests. All HTML/CSS/JS files run directly in a browser.

## Contents

| Path | Description |
|------|-------------|
| `pomodoro/index.html` | Pomodoro timer UI |
| `pomodoro/app.js` | Timer state machine, task CRUD, Web Audio alarms, Notification API, localStorage persistence |
| `pomodoro/style.css` | Dark theme, centered flex layout |
| `calendar.html` | Standalone cyberpunk-themed calendar (Orbitron font, neon glow, scanlines, month navigation) |
| `Global_GDP_Top100_Cities_2025.xlsx` | Reference data file |

## Architecture notes

- **pomodoro**: Pure vanilla JS state machine with phases `work → short_break → long_break → work`. Timer runs via `setInterval` at 1s ticks. Task list persisted to `localStorage` key `pomodoro_tasks_v1`. Active task auto-accumulates pomodoro count on work interval completion. No frameworks.
- **calendar.html**: Self-contained single file with embedded CSS/JS. Generates month grid dynamically from `Date` API.

## Git remote

- Remote: `https://github.com/zhouzhean/FIRSTCC`
- Auth: HTTPS via GitHub CLI (`gh auth login`)

## No build/lint/test infrastructure

There is no `package.json`, no build step, no linter config, and no test suite. To preview changes, open the HTML file directly in a browser.
