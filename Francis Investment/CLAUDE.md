A股量化交易系统 v3.2.1 + 报告引擎 + 24/7 自主学习进化引擎。Node.js 零外部依赖，阿里云 ECS `8.153.101.112:8765`。

## 核心理念

全部服务端计算，零 Claude tokens 消耗。数据下载→清洗→因子回测→有效性矩阵→参数搜索→跨市场相关性→自动报告，全部 Node.js 本地跑。

## v3.2 (2026-06-16) — 智能投研系统升级

### 数据架构修复
- K线分离存储：`klines_short/`（日常 Pipeline 30天缓存）+ `klines/`（Bootstrap 3-5年历史），不再互相覆盖

### 训练矩阵全链路消费
- `/api/evolution/training-matrix` 返回完整 `factorCombos`/`factorMatrix`/`crossMarket`/`paramSearch`
- 前端 Canvas 全部真实数据：板块热力图、验证趋势 sparkline、训练因子柱状图
- 新增 `GET /api/history/deep-analysis` — 相似行情后的胜率/收益/回撤/风险收益比

### 因子按市场阶段有效性
- `composite.js` 新增 `detectCurrentRegime()` — 自动识别 bull/bear/high_vol/low_liquidity/sideways
- 当前 regime 下表现好的因子 +3 分，表现差的 -3 分
- Pipeline 自动计算 `marketContext`（涨跌比/成交额/波动率）传入评分引擎

### 赛后验证体系
- 新模块 `mosaic/analysis/verification_dashboard.js` — 聚合因子信号/US预测/期望收益/个股预测/Rank IC
- 新 API `GET /api/verification/dashboard` + 前端验证仪表板 `/#verification`
- 追踪：方向命中率、平均误差、Rank IC、综合胜率

### 概率化预测输出
- `expected_return.js` 新增 `P(up)/P(flat)/P(down)` 校准概率 + 68% 置信区间
- Kelly 启发式仓位建议 + 失效条件列表

### Bootstrap 历史训练引擎 (`mosaic/evolution/bootstrap_history.js`)

7 Phase 训练链路，默认沪深300 × 2021-2026：

| Phase | 内容 |
|-------|------|
| 1 | K线下载（腾讯 ifzq API，前复权） |
| 2 | 每日回放（每3天采1天+最近60天全量） |
| 3 | 因子有效性矩阵（17因子 × T+1/3/5/10/20 × 5种市场状态） |
| 4 | 因子组合挖掘（协同/冲突对） |
| 5 | 跨市场相关性（需美股数据） |
| 6 | 参数网格搜索（止损/阈值/仓位） |
| 7 | 输出 training_matrix.json + 自动 Markdown 报告 |

```bash
# 手动全量 (~34min)
node mosaic/evolution/bootstrap_history.js
# 手动增量 (~2-3min)
node mosaic/evolution/bootstrap_history.js --incremental
# 云端触发
curl -X POST http://8.153.101.112:8765/api/evolution/run-bootstrap
```

调度器自动判断模式：首次全量 → 后续每周增量（最近20天，EMA alpha=0.15 合并）。

### 新增 API

| 路由 | 用途 |
|------|------|
| `GET /api/evolution/training-matrix` | 训练矩阵（含 factorCombos/factorMatrix） |
| `GET /api/evolution/factor-effectiveness` | 因子有效性详情（含 byRegime） |
| `GET /api/evolution/param-search` | 参数搜索最优结果 |
| `GET /api/evolution/training-report` | 最新训练报告 Markdown |
| `GET /api/evolution/bootstrap-status` | 训练状态 |
| `POST /api/evolution/run-bootstrap` | 手动触发训练 |
| `GET /api/history/deep-analysis` | 深度综合分析（v3.2） |
| `GET /api/verification/dashboard` | 赛后验证仪表板（v3.2） |

---

## 核心架构

### Pipeline 执行流程

1. 全 A 股列表 → 过滤（价格≤20/成交额>1亿/PE≤40/排除ST创业板）
2. 计算 H1-H9 + 并行 LHB/板块/北向/两融
3. 8 维预评分 → top 80 → 5 维综合评分 → 排序/评级/SSE 广播

### 综合评分 (composite.js)

5 维加权：fundamental(25%) + technical(15%) + hidden(20%) + capital_flow(25%) + event(15%)。动态权重 OLS R²≥0.05 时启用。无财务数据时 fundamental→10%，总分上限 65。v3.2 新增 regime-aware 因子加权。

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

初始 ¥100,000，T+1，持仓上限 5 只，单只 ≤30%。强买 15-25%/普通 8-12%。6 门风控（回撤/市场方向/跨市场熔断/数据质量惩罚/持仓浮亏/思维舱防御+归因避让）。卖出：硬止损 -8%/软止损 评分<35/移动止盈。

### 进化引擎调度（8 任务）

| 任务 | 时间 | 闭环 |
|------|------|------|
| bootstrap_history | 周日 01:00 | 首次全量，后续增量 EMA 合并 |
| night_backtest | 每天 02:00 | stock_predictor 优先读验证数据 |
| weight_grid_search | 每天 03:00 | dynamic_weights 自动替换最优参数 |
| parameter_push | 每天 04:00 | 检测参数漂移→标记重搜 |
| us_predict_generate | 每天 05:30 | — |
| us_predict_verify | 每天 16:10 | 跨市场信号权重自动调整 |
| self_reflection | 每天 20:00 | — |
| full_backtest | 周日 02:00 | 7 种市场状态独立验证 |

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
│   ├── collectors/              # 数据采集
│   ├── factors/                 # 评分引擎（hidden_signals + composite）
│   ├── evolution/               # 自主学习进化引擎
│   │   ├── bootstrap_history.js # ★ 7 Phase历史训练+增量更新
│   │   ├── evolution_scheduler.js
│   │   ├── night_backtest.js / full_backtest.js
│   │   ├── self_reflection.js / us_as_predict.js
│   │   ├── weight_grid_search.js / weekend_factor_mining.js
│   ├── predict/                 # 预测引擎（6模块）
│   │   ├── expected_return.js   # ★ v3.2 概率化输出
│   │   ├── stock_predictor.js / dynamic_weights.js
│   │   ├── cycle_factor_matrix.js / sector_leadlag.js / trade_attribution.js
│   └── analysis/                # 盘后+历史复盘+风险
│       ├── history_review.js    # ★ v3.2 deepAnalysis
│       ├── verification_dashboard.js # ★ v3.2 赛后验证
│       ├── strategy_health.js / risk_budget.js / data_quality.js
│       └── market_cycle.js / cross_market.js / knowledge_base.js
├── report-engine/               # 前端（纯静态）
│   ├── index.html               # 主仪表板（10 section）
│   ├── think-tank.html          # AI 思考舱（SSE实时）
│   ├── app.js                   # 前端控制器
│   ├── style.css                # 仪表板样式
│   └── templates/               # UI模板
│       ├── history-review.js    # 历史复盘+训练分析
│       ├── verification-dashboard.js # ★ v3.2 验证仪表板
│       └── simfolio/strategy-health/predict/cross-market/...
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
curl -s http://8.153.101.112:8765/api/evolution/training-matrix
curl -s http://8.153.101.112:8765/api/verification/dashboard
```

---

## 关键约束

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
- 前端 simfolio/strategyHealth/usMarket/crossMarket/predict/historyReview/verification 在 `renderCurrentSection()` 中有专用路由

### 已知陷阱速查

| 陷阱 | 要点 |
|------|------|
| SSH 路径含空格 | 必须引号 `"/root/FIRSTCC/Francis Investment/..."` |
| `_runDailySummary()` 无 await | fire-and-forget，16:00 附近重启会导致当天总结丢失 |
| `safeFixed()` | simfolio.js 所有 `.toFixed()` 必须用它包装 |
| Eastmoney 在 ECS 被墙 | K 线用腾讯 ifzq API；两融/板块资金流等 push2his 也受影响 |
| portfolio.json 损坏 | .bak 自动恢复，不要手动删除 |
| compositeScore 返回类型 | 对象 `{compositeScore, rating, ...}` 非数字，需提取 `.compositeScore` |
| Canvas Retina | 已加 `devicePixelRatio` 适配，width/height 不能 HTML 属性写死 |
| inline style 陷阱 | grid 布局必须在 CSS 定义，否则 `@media` 被覆盖 |
| 回测止损冷却期 | 4 个交易日冷却，`STOP_LOSS_COOLDOWN_DAYS=4` |
| 总控 attributionSummary | 必须传入 `computeMasterControlJudgment()`，否则 consecutiveLosses=0 |
| regime 字段路径 | `riskState.regime`，不是 `riskState.riskRegime` |
| **klines 目录冲突 [v3.2]** | `market_data.js`→`klines_short/`，`bootstrap_history.js`→`klines/`，不可混用 |
| **training-matrix API [v3.2]** | 默认返回完整数据（含 factorCombos），`?full=0` 轻量模式 |

### 绝不提交的运行时数据
`portfolio.json`, `scheduler_state.json`, `events/*.json`, `summaries/*.json`, `knowledge_base/*.json`, `index_history_*.json`, `us_latest.json`, `correlation_history.json`, `factor_performance.json`, `scan_records_*.json`, `last_pipeline_result.json`, `weekend_context.json`, `market_history/indices/*.json`, `weekend_archive/*.json`, `margin_cache.json`, `dynamic_weights.json`, `stock_factor_performance.json`, `cycle_factor_matrix.json`, `sector_leadlag.json`, `trade_attribution.json`, `klines/*.json`, `klines_short/*.json`, `night_backtest_result.json`, `self_reflection_result.json`, `us_as_predictions.json`, `us_as_verification_history.json`, `factor_combinations.json`, `weight_grid_result.json`, `full_backtest_result*.json`, `data_quality_report.json`, `strategy_health_snapshot.json`, `*_snapshot.json`, `bootstrap_state.json`, `training_matrix.json`, `factor_effectiveness.json`, `param_search_results.json`, `cross_market_linkage.json`, `expected_return_verification.json`, `history_context.json`
