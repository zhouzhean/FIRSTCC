A股量化交易系统 v3.3.0 + 报告引擎 + 24/7 自主学习进化引擎。Node.js 零外部依赖，阿里云 ECS `8.153.101.112:8765`。

## 核心理念

全部服务端计算，零 Claude tokens 消耗。数据下载→清洗→因子回测→有效性矩阵→参数搜索→跨市场相关性→自动报告，全部 Node.js 本地跑。

## 版本历史

### v3.3.0 (2026-06-17) — 自主学习交易员闭环优化
- **P0 Bug 修复**: `checkBuySignal` macroContext 作用域修复（+第5参数）、`history_review` marketProfile 持久化
- **P0 调度增强**: `evolution_scheduler` catch-up 覆盖全部10个任务、超时保护+重试（`_executeWithRetry`）
- **P1 数据+训练**: `download_klines` 新增 `cacheValid()` 三重检查（新鲜度/长度/连续性）
- **P1 学习闭环**: 新建 `model_registry.js`（shadow mode → champion 自动晋升）
- **P1 风控自我约束**: 策略健康门禁集成（BLOCK/REDUCE/CAUTIOUS→交易限制）、止损冷却期（4交易日不回买）、自动暂停机制
- **P2 驾驶舱**: `cockpit.html` 6面板自主监控（30秒轮询）、每日自我复盘报告 `daily_reflections/`
- **Config**: 新增 `SHADOW_MODE`, `MODEL_REGISTRY`, `AUTO_PAUSE`, `STOP_LOSS_COOLDOWN_DAYS`

### v3.2.4 (2026-06-17) — 验证仪表板工程Bug修复
- `verification_dashboard.js`：`_computeStockPredictorVerification()` 适配 `dailyRecords` 对象结构，新增 `verified` 状态标记
- `verification_dashboard.js`：`_computeRankIC()` fallback 路径从 `DATA_DIR` 修正为 `SIMFOLIO_DIR`
- `verification_dashboard.js`：scan_records 格式修正（纯数组，非 `{results:...}` 对象）

### v3.2.3 (2026-06-17) — K线扩充 + 赛后验证闭环
- `mosaic/tools/download_klines.js`：批量 K 线下载（腾讯 ifzq, 5 并发），284→1563 只 (110MB)
- `mosaic/analysis/verification_runner.js`：赛后验证，scan_records 对照实盘 K 线 → 命中率 / Rank IC
- scheduler 新增每日 15:30 `_runDailyVerification()` 任务

### v3.2.2 (2026-06-16) — 历史复盘/验证板块显示修复
- `history-review.js` `_drawTrainingFactorChart()` 未闭合 if 块 → 语法错误，两个板块全挂

### v3.2 (2026-06-16) — 智能投研系统升级
- K 线分离存储（`klines_short/` vs `klines/`）、训练矩阵全链路、regime-aware 因子、概率化输出、赛后验证 API

## 核心架构

### Pipeline 执行流程

1. 全 A 股列表 → 过滤（价格≤20/成交额>1亿/PE≤40/排除ST创业板）
2. 计算 H1-H9 + 并行 LHB/板块/北向/两融
3. 8 维预评分 → top 80 → 5 维综合评分 → 排序/评级/SSE 广播

### 综合评分 (composite.js)

5 维加权：fundamental(25%) + technical(15%) + hidden(20%) + capital_flow(25%) + event(15%)。动态权重 OLS R²≥0.05 时启用。无财务数据时 fundamental→10%，总分上限 65。regime-aware 因子加权。

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

### Simfolio 模拟交易

初始 ¥100,000，T+1，持仓上限 5 只，单只 ≤30%。6 门风控。卖出：硬止损 -8%/软止损 评分<35/移动止盈。

### Bootstrap 历史训练 (mosaic/evolution/bootstrap_history.js)

7 Phase：K线下载 → 每日回放 → 因子矩阵 → 组合挖掘 → 跨市场 → 参数搜索 → 输出报告。
首次全量，后续每周增量（EMA alpha=0.15）。

```bash
node mosaic/evolution/bootstrap_history.js              # 全量
node mosaic/evolution/bootstrap_history.js --incremental # 增量
curl -X POST http://8.153.101.112:8765/api/evolution/run-bootstrap
```

### 进化引擎调度

| 任务 | 时间 |
|------|------|
| bootstrap_history | 周日 01:00 |
| night_backtest | 每天 02:00 |
| weight_grid_search | 每天 03:00 |
| parameter_push | 每天 04:00 |
| us_predict_generate | 每天 05:30 |
| us_predict_verify | 每天 16:10 |
| self_reflection | 每天 20:00 |
| full_backtest | 周日 02:00 |
| **daily_verification** | **每天 15:30 [v3.2.3]** |

---

## 项目结构

```
Francis Investment/
├── mosaic_server.js             # HTTP 主服务器 (50+ API)
├── mosaic/                      # 量化引擎
│   ├── config.js                # 唯一配置入口
│   ├── scheduler.js             # 状态机调度器
│   ├── pipeline.js              # 主流程编排（EventEmitter+SSE）
│   ├── simfolio.js              # 模拟交易引擎
│   ├── collectors/              # 数据采集
│   ├── factors/                 # 评分引擎（hidden_signals + composite）
│   ├── evolution/               # 自主学习进化引擎
│   │   ├── bootstrap_history.js # ★ 7 Phase历史训练
│   │   └── evolution_scheduler.js / night_backtest.js / ...
│   ├── predict/                 # 预测引擎
│   │   └── expected_return.js / stock_predictor.js / ...
│   ├── analysis/                # 盘后+历史复盘+风险
│   │   ├── history_review.js    # 历史复盘 deepAnalysis
│   │   ├── verification_dashboard.js  # 赛后验证仪表板
│   │   ├── verification_runner.js     # ★ v3.2.3 验证执行器
│   │   └── strategy_health.js / risk_budget.js / ...
│   └── tools/                   # 独立工具
│       └── download_klines.js   # ★ v3.2.3 批量K线下载
├── report-engine/               # 前端（纯静态）
│   ├── index.html               # 主仪表板
│   ├── think-tank.html          # AI 思考舱
│   ├── app.js / style.css       # 前端控制器+样式
│   └── templates/               # UI模板
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
curl -s http://8.153.101.112:8765/api/verification/dashboard
```

---

## 关键约束

### 部署铁律
- **云端永远优先**：改动后立即 scp 部署
- 后端文件（`mosaic/` .js）部署后需 `systemctl restart mosaic`
- 前端静态文件无需重启
- 部署后 curl 验证

### 配置规则
- **config.js 是唯一配置入口**
- **`report-engine/data/` 是 DATA_DIR**
- **`.gitignore` 运行时数据**：新增数据目录务必同步更新 .gitignore

### GUI 风格
- 全项目不使用 emoji，状态用纯文本标签（`[ACTIVE]`, `[OK]`, `[X]`）
- 前端 section 路由在 `renderCurrentSection()` 中定义

### 已知陷阱速查

| 陷阱 | 要点 |
|------|------|
| SSH 路径含空格 | 必须引号 `"/root/FIRSTCC/Francis Investment/..."` |
| Eastmoney 在 ECS 被墙 | K 线用腾讯 ifzq API；两融/板块资金流也受影响 |
| compositeScore 返回类型 | 对象，需提取 `.compositeScore` |
| klines 目录冲突 | `market_data.js`→`klines_short/`，`bootstrap_history.js`→`klines/` |
| 前端 JS 语法错误 | `node --check` 部署前验证，一个错误全挂 |
| regime 字段路径 | `riskState.regime`，不是 `riskState.riskRegime` |
| 回测止损冷却期 | `STOP_LOSS_COOLDOWN_DAYS=4` |
| `safeFixed()` | simfolio.js 所有 `.toFixed()` 必须用它包装 |
| stock_factor_performance 结构 | `dailyRecords`（对象 key=日期）不是 `records`（数组）；factorSignals 无 hit 字段时=待验证 |
| scan_records 路径+格式 | 在 `SIMFOLIO_DIR`（非 DATA_DIR）；纯数组，非 `{results:...}` 对象 |
| macroContext 作用域 | `checkBuySignal` 是模块级函数，无法闭包访问 `makeTradingDecisions` 局部变量，必须显式传入 [v3.3] |
| 策略健康门禁 | `strategy_health` 返回 BLOCK/REDUCE/CAUTIOUS/ALLOW，`simfolio.js` 必须消费此裁决，否则无效 |
| 止损冷却期 | `STOP_LOSS_COOLDOWN_DAYS=4`，`executeSell` 中触发止损时记录，`makeTradingDecisions` 候选遍历中检查冷却 |
| 任务超时 | `evolution_scheduler` 30分钟超时 + 1次重试，`_executeWithRetry` 防止 `_state.running` 永久卡住 |
| model_registry 数据 | `model_registry.json` 在 `report-engine/data/evolution/`，运行时数据不提交 git |

### 绝不提交的运行时数据
`portfolio.json`, `scheduler_state.json`, `events/*.json`, `summaries/*.json`, `knowledge_base/*.json`, `index_history_*.json`, `us_latest.json`, `correlation_history.json`, `factor_performance.json`, `scan_records_*.json`, `last_pipeline_result.json`, `weekend_context.json`, `market_history/indices/*.json`, `weekend_archive/*.json`, `margin_cache.json`, `dynamic_weights.json`, `stock_factor_performance.json`, `cycle_factor_matrix.json`, `sector_leadlag.json`, `trade_attribution.json`, `klines/*.json`, `klines_short/*.json`, `night_backtest_result.json`, `self_reflection_result.json`, `us_as_predictions.json`, `us_as_verification_history.json`, `factor_combinations.json`, `weight_grid_result.json`, `full_backtest_result*.json`, `data_quality_report.json`, `strategy_health_snapshot.json`, `*_snapshot.json`, `bootstrap_state.json`, `training_matrix.json`, `factor_effectiveness.json`, `param_search_results.json`, `cross_market_linkage.json`, `expected_return_verification.json`, `history_context.json`, `verification/`, `evolution/`
