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
| `Francis Investment/` | A-stock investment analysis reports (HTML + PDF) |

## Francis Investment

A股投资分析报告引擎子项目，详见 `Francis Investment/CLAUDE.md`（完整架构文档）。

### 快速更新流程

用户说"更新报告"时（非交易日除外），按以下4步执行：
1. **数据搜索**（6-8个并行WebSearch）：大盘行情 + 时政新闻 + 2只持仓股数据 + 7大板块动态 + 每板块2只潜力股（<20元，不与历史重复）
2. **创建数据文件**：`YYYY-MM-DD.json` + `.js`包装器，更新 `index.html` 引用和 `reports-index.json/js`
3. **更新推荐历史**：新推荐股写入 `recommendation-history.json`
4. **预览验证**：打开 `report-engine/index.html` 逐板块验证

### Report Engine 核心功能

- 纯静态Web应用，双模式渲染（软件白底卡片式 / PDF暗色学术格式）
- 数据通过JS全局变量（`window.__REPORT_DATA__`）加载，规避Chrome `file://` fetch限制
- **K线图**：Canvas动画（65帧），含MACD/BOLL技术指标切换+下一交易日金融分析预测
- **板块筛选**：7大热门板块，潜力股推荐含板块标签筛选，自动防重复+参与TOP5排行
- **日历导航**：左侧320px边栏（日历+板块导航+报告列表），内容通过iframe srcdoc隔离渲染
- **邮件发送**：通过 `send_mail.js` 发送至163邮箱，凭据见子项目CLAUDE.md

## Architecture notes

- **pomodoro**: Pure vanilla JS state machine with phases `work → short_break → long_break → work`. Timer runs via `setInterval` at 1s ticks. Task list persisted to `localStorage` key `pomodoro_tasks_v1`. Active task auto-accumulates pomodoro count on work interval completion. No frameworks.
- **calendar.html**: Self-contained single file with embedded CSS/JS. Generates month grid dynamically from `Date` API.

## Git remote

- Remote: `https://github.com/zhouzhean/FIRSTCC`
- Auth: HTTPS via GitHub CLI (`gh auth login`)

## No build/lint/test infrastructure

There is no `package.json`, no build step, no linter config, and no test suite. To preview changes, open the HTML file directly in a browser.
