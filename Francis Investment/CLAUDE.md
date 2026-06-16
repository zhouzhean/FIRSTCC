# Francis Investment CLAUDE.md

A股量化交易系统 v3.1.1 + 报告引擎 + **24/7 自主学习进化引擎**。Node.js 零外部依赖，阿里云 ECS `8.153.101.112:8765`。

## v3.1 (2026-06-16) — 历史训练+增量学习

### 核心理念：全部服务端计算，零 Claude tokens 消耗

数据下载→清洗→因子回测→有效性矩阵→参数搜索→跨市场相关性→自动报告，全部 Node.js 本地跑，AI 只在解释/改策略/审查异常时介入。

### Bootstrap 历史训练引擎 (`mosaic/evolution/bootstrap_history.js`)

7 Phase 训练链路，默认沪深300 × 2021-2026。通过 `factor_effectiveness.json`/`training_matrix.json` 对外暴露结果。

| Phase | 内容 |
|-------|------|
| 1 | K线下载（腾讯 ifzq API，前复权，Eastmoney 在 ECS 被墙） |
| 2 | 每日回放（真实 hidden_signals + composite 引擎，每3天采1天+最近60天全量） |
| 3 | 因子有效性矩阵（17因子 × T+1/3/5/10/20 × 5种市场状态） |
| 4 | 因子组合挖掘（协同/冲突对） |
| 5 | 跨市场相关性（需美股数据） |
| 6 | 参数网格搜索（止损/阈值/仓位） |
| 7 | 输出 training_matrix.json + 自动 Markdown 报告 |

### 增量更新 (v3.1.1)

调度器**自动判断模式**：首次全量 → 后续每周增量（只跑最近 20 天，EMA alpha=0.15 合并到已有矩阵）。`incrementalUpdate()` 完整实现，非空壳。

```bash
# 手动全量 (~34min for hs300)
node mosaic/evolution/bootstrap_history.js
# 手动增量 (~2-3min)
node mosaic/evolution/bootstrap_history.js --incremental
# 云端触发
curl -X POST http://8.153.101.112:8765/api/evolution/run-bootstrap
```

### 新增 API

| 路由 | 用途 |
|------|------|
| `GET /api/evolution/training-matrix` | 训练矩阵摘要 |
| `GET /api/evolution/factor-effectiveness` | 因子有效性详情 |
| `GET /api/evolution/param-search` | 参数搜索最优结果 |
| `GET /api/evolution/training-report` | 最新训练报告 (markdown) |
| `GET /api/evolution/bootstrap-status` | 训练状态 |
| `POST /api/evolution/run-bootstrap` | 手动触发训练 |

### 设计决策

- K线：腾讯 ifzq API，单次 ~640 条，不含 turnover
- 采样：每3天+最近60天，约 530/1468 天
- 耗时：hs300 全量 ~34min（下载 5min + 回放 25-30min），增量 ~2-3min
- 输出：`data/evolution/` 下 ~116KB（training_matrix 57K + factor_effectiveness 40K + param_search 6K）

---

## 版本历史摘要

### v3.0.4 — 策略体检 UI/数据修复
Canvas Retina 适配（`devicePixelRatio`）、移动端响应式（inline style → CSS class 4/2/1列）、交易成本读实际 `trade.costs`、回撤 yMax 动态计算、云端版本同步。

### v3.0.3 — 数据质量+回测修复
`affectedModules` 含 WARN/PROXY、回测止损 4 天冷却期、`signalQuality`/`factorHitRate` 拆分百分比显示。

### v3.0.1 — 策略体检+风险预算+完整回测+数据质量
`strategy_health.js`（Sharpe/Sortino/Calmar/NAV/回撤/热力图/总控 ALLOW-CAUTIOUS-REDUCE-BLOCK）、`risk_budget.js`（波动率/Kelly/相关性/流动性/熔断）、`full_backtest.js`（7种市场状态）、`data_quality.js`（8源监控）。

### v3.0.2 — 反馈修复
连续亏损传入总控、数据质量面板同步 WARN/PROXY、回测接入真实因子引擎。

---

## 核心架构

### 调度器 24/7 自动运行

`closed → pre_market → morning_session → lunch_break → afternoon_session → post_market → closed`，活跃 20s tick，空闲 300s tick。`_runDailySummary()` 16:00 fire-and-forget。

### Pipeline 执行流程

1. 全 A 股列表 → 过滤（价格≤20/成交额>1亿/PE≤40/排除ST创业板）
2. 计算 H1-H9 + 并行 LHB/板块/北向/两融
3. 8 维预评分 → top 80 → 5 维综合评分 → 排序/评级/SSE 广播

### Simfolio 模拟交易

初始 ¥100,000，T+1，持仓上限 5 只，单只 ≤30%。强买 15-25%/普通 8-12%。6 门风控（回撤/市场方向/跨市场熔断/数据质量惩罚/持仓浮亏/思维舱防御+归因避让）。卖出：硬止损 -8%/软止损 评分<35/移动止盈。

### 综合评分 (composite.js)

5 维加权：fundamental(25%) + technical(15%) + hidden(20%) + capital_flow(25%) + event(15%)。动态权重 OLS R²≥0.05 时启用。无财务数据时 fundamental→10%，总分上限 65。

### 隐藏因子 H1-H9

| ID | 名称 | 类别 |
|----|------|------|
| H1 | 缩量止跌 | 技术 |
| H2 | 底部放量 | 技术 |
| H3 | 逆势抗跌 | 市场 |
| H4 | PE低估 | 基本面 |
| H5 | 高ROE低PB | 基本面 |
| H6 | 现金流健康 | 基本面 |
| H7 | 低换手蓄力 | 技术 |
| H8 | 短期反转 | 技术 |
| H9 | 量价背离 | 技术 |

### 进化引擎调度（8 任务）

| 任务 | 时间 | 闭环 |
|------|------|------|
| bootstrap_history [v3.1] | 周日 01:00 | 首次全量，后续增量 EMA 合并 |
| night_backtest | 每天 02:00 | stock_predictor 优先读验证数据 |
| weight_grid_search | 每天 03:00 | dynamic_weights 自动替换最优参数 |
| parameter_push | 每天 04:00 | 检测参数漂移→标记重搜 |
| us_predict_generate | 每天 05:30 | — |
| us_predict_verify | 每天 16:10 | 跨市场信号权重自动调整 |
| self_reflection | 每天 20:00 | — |
| full_backtest | 周日 02:00 | 7 种市场状态独立验证 |

### 7 条反馈闭环

北向资金→评分降权 / 知识库→交易决策 / 思考舱→防御门 / 交易→归因→参数反馈 / 动态权重→评分适应 / 进化引擎→全回路 / 历史复盘→分析引擎。

---

## 项目结构

```
Francis Investment/
├── mosaic_server.js             # HTTP 主服务器 (50+ API)
├── mosaic/                      # 量化引擎
│   ├── config.js                # 唯一配置入口
│   ├── scheduler.js             # 状态机调度器
│   ├── pipeline.js              # 主流程编排（EventEmitter+SSE）
│   ├── simfolio.js              # 模拟交易引擎（6门风控+T+1）
│   ├── collectors/              # 数据采集（market_data/us_market/north_bound/capital_flow/dragon_tiger/index_recorder/margin_data/news_collector）
│   ├── factors/                 # 评分引擎（hidden_signals + composite）
│   ├── evolution/               # 自主学习进化引擎
│   │   ├── bootstrap_history.js # ★ v3.1 历史训练（7 Phase+增量更新）
│   │   ├── evolution_scheduler.js # 进化任务统一调度
│   │   ├── night_backtest.js    # 夜间回测
│   │   ├── full_backtest.js     # 多周期完整回测
│   │   ├── self_reflection.js   # 自我质疑
│   │   ├── us_as_predict.js     # 美股→A股预测+验证
│   │   ├── weight_grid_search.js # 网格搜索
│   │   └── weekend_factor_mining.js # 因子组合挖掘
│   ├── predict/                 # 预测引擎（6模块）
│   └── analysis/                # 盘后+历史复盘+风险
│       ├── strategy_health.js   # ★ v3.0 策略体检
│       ├── risk_budget.js       # ★ v3.0 风险预算
│       ├── data_quality.js      # ★ v3.0 数据质量
│       └── ...                  # market_cycle/cross_market/history_review/knowledge_base
├── report-engine/               # 前端（纯静态）
│   ├── index.html               # 主仪表板（9 section）
│   ├── think-tank.html          # AI 思考舱（SSE实时）
│   ├── app.js                   # 前端控制器
│   ├── style.css                # 仪表板样式
│   └── templates/               # UI模板（simfolio/strategy-health/predict/cross-market/history-review...）
└── reports/                     # 历史报告归档
```

---

## 云端部署

| 项目 | 详情 |
|------|------|
| IP | `8.153.101.112:8765` |
| 系统 | Ubuntu 22.04, 2 vCPU/2 GiB, CST |
| 进程 | systemd `mosaic.service`（Restart=always, RestartSec=10） |

```bash
# 部署后端（需重启）
scp "C:/Users/anzhe/FIRSTCC/Francis Investment/<path>" "root@8.153.101.112:/root/FIRSTCC/Francis Investment/<path>"
ssh root@8.153.101.112 "systemctl restart mosaic"

# 前端无需重启
# 验证
curl -s http://8.153.101.112:8765/api/status
curl -s http://8.153.101.112:8765/api/strategy/health
curl -s http://8.153.101.112:8765/api/evolution/bootstrap-status
```

---

## 关键约束

### 数据准确性
- 所有股价/涨跌幅/PE/成交额必须实时查询，绝不估算。PE 亏损写 "亏损" 或 null。
- 交易成本优先读 `trade.costs`（simfolio 精确记录），fallback 到 A 股费率估算。

### 部署铁律
- 云端永远优先：改动后立即 scp 部署
- 后端文件（`mosaic/` .js）部署后需 `systemctl restart mosaic`
- 前端静态文件无需重启
- 部署后 curl 验证

### 配置规则
- **config.js 是唯一配置入口**：阈值/权重/时间表/风险预算/进化引擎统一修改
- **`report-engine/data/` 是 DATA_DIR**：所有运行时数据在此目录下
- **`.gitignore` 运行时数据**：新增数据目录务必同步更新 .gitignore

### GUI 风格规范
- 全项目不使用 emoji，状态用纯文本标签（`[ACTIVE]`, `[OK]`, `[X]`, `[UP]`, `[DN]`）
- 前端 simfolio/strategyHealth/usMarket/crossMarket/predict/historyReview 在 `renderCurrentSection()` 中有专用路由

### 已知陷阱速查

| 陷阱 | 要点 |
|------|------|
| SSH 路径含空格 | 必须引号 `"/root/FIRSTCC/Francis Investment/..."` |
| `_runDailySummary()` 无 await | fire-and-forget，16:00 附近重启会导致当天总结丢失 |
| `safeFixed()` | simfolio.js 所有 `.toFixed()` 必须用它包装 |
| Eastmoney 在 ECS 被墙 | K 线用腾讯 ifzq API；两融/板块资金流等 push2his 也受影响 |
| portfolio.json 损坏 | .bak 自动恢复，不要手动删除 |
| compositeScore 返回类型 | 对象 `{compositeScore, rating, ...}` 非数字，需提取 `.compositeScore` |
| 策略体检 tradingDays < 20 | Sharpe/Sortino/Calmar 返回 null，前端显示"数据不足" |
| Canvas Retina | 已加 `devicePixelRatio` 适配，width/height 不能 HTML 属性写死 |
| inline style 陷阱 | grid 布局必须在 CSS 定义，否则 `@media` 被覆盖 |
| 回测真实因子限制 | 模拟 stock 缺 PE/ROE/负债率，H4/H5/H6 无法触发 |
| 回测止损冷却期 | 4 个交易日冷却，`STOP_LOSS_COOLDOWN_DAYS=4` |
| 总控 attributionSummary | 必须传入 `computeMasterControlJudgment()`，否则 consecutiveLosses=0 |
| regime 字段路径 | `riskState.regime`，不是 `riskState.riskRegime` |

### 绝不提交的运行时数据
`portfolio.json`, `scheduler_state.json`, `events/*.json`, `summaries/*.json`, `knowledge_base/*.json`, `index_history_*.json`, `us_latest.json`, `correlation_history.json`, `factor_performance.json`, `scan_records_*.json`, `last_pipeline_result.json`, `weekend_context.json`, `market_history/indices/*.json`, `weekend_archive/*.json`, `margin_cache.json`, `dynamic_weights.json`, `stock_factor_performance.json`, `cycle_factor_matrix.json`, `sector_leadlag.json`, `trade_attribution.json`, `klines/*.json`, `night_backtest_result.json`, `self_reflection_result.json`, `us_as_predictions.json`, `us_as_verification_history.json`, `factor_combinations.json`, `weight_grid_result.json`, `full_backtest_result*.json`, `data_quality_report.json`, `strategy_health_snapshot.json`, `*_snapshot.json`, `bootstrap_state.json`, `training_matrix.json`, `factor_effectiveness.json`, `param_search_results.json`, `cross_market_linkage.json`
