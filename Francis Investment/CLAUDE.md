# Francis Investment · A股量化交易系统 v3.4.5

Node.js 零外部依赖，阿里云 ECS `8.153.101.112:8765`。全自动日内交易+24/7自主学习进化+报告引擎。

v3.4.5: **Data Bus Unification** — pipeline.fetchIndices 写入 market_snapshot_latest.json (最完整数据: changePercent/prevClose/high/low/open)，loadLatestIndices 每指数独立 freshnessStatus (live/recorder/stale_daily)，IndexRecorder 新增创业板399006。MarketDirection 修复 (changePercent=null→warn)。decision_audit 补全 (dataQualityPenalty/strategyHealthSampleCount/version)。

## Unified Decision Kernel (v3.4.5)

`mosaic/decision_kernel.js` — `computeDecision(context)` 是交易决策的单一真相来源。

### 6 Hard Blockers (优先级顺序):

| 优先级 | 门禁 | 阻断条件 |
|--------|------|----------|
| 0 | **marketSession** | 非交易时段 (closed/post_market/pre_market/lunch_break) |
| 1 | **marketData** | 交易时段无指数行情数据 |
| 2 | **circuitBreaker** | regime = panic / risk_off |
| 3 | **leakageAudit** | CRITICAL / DATA_LEAKAGE_RISK / NO_SAMPLES |
| 4 | **strategyHealth** | masterControl.verdict = BLOCK |
| 5 | **dataQuality** | penalty ≥ 7 |

Soft Reducers: leakageAudit MINOR_ISSUES / strategyHealth REDUCE/CAUTIOUS / dataQuality penalty 4-6 → 降级但不阻断。

### 数据总线 (v3.4.5)

```
pipeline.fetchIndices() [Eastmoney] → market_snapshot_latest.json (主, 最完整)
  └─ 含 changePercent/prevClose/high/low/open, freshnessStatus=live
IndexRecorder [Sina, 每60s] → index_history_DATE.json (补充, 仅价格)
loadLatestIndices() → Tier1:snapshot → Tier2:recorder → Tier3:历史日线(stale)
  └─ 每指数独立: source / fetchAt / quoteDate / freshnessStatus
data_quality.checkIndexData() → 同源读取 snapshot freshnessStatus
```

### 返回结构:
```js
{
  canBuy, finalVerdict: 'ALLOW'|'CAUTIOUS'|'REDUCE'|'BLOCK',
  finalVerdictLabel, maxBuysPerDay,
  hardBlockers: [{gate, reason, severity}],
  softReducers: [{gate, reason}],
  primaryBlocker, allActiveBlockers, displayReasons,
  gateStates: { marketSession, marketData, drawdown, marketDirection, circuitBreaker, leakageAudit, strategyHealth, dataQuality },
}
```

## 核心架构

```
mosaic_server.js (HTTP 主服务器)
├── mosaic/decision_kernel.js    # ★ v3.4.5 决策内核 — 6 hard blockers + writeMarketSnapshot
├── mosaic/pipeline_summary.js   # Pipeline持久化共享函数
├── mosaic/scheduler.js          # 状态机调度器 — 全自动扫描+交易
├── mosaic/pipeline.js           # 主流程编排 (写入market_snapshot)
├── mosaic/simfolio.js           # 模拟交易引擎 — 服从kernel裁决
├── mosaic/config.js             # ★ 唯一配置入口

├── mosaic/collectors/           # 数据采集
│   ├── market_data.js           # 行情/K线 (Eastmoney+腾讯ifzq+Sina)
│   ├── index_recorder.js        # 日内指数快照 (4指数: 上证/深证/创业板/北证)
│   ├── capital_flow.js          # 板块/个股资金流
│   ├── north_bound.js           # 北向资金
│   ├── margin_data.js           # 两融数据
│   ├── dragon_tiger.js          # 龙虎榜
│   └── us_market.js             # 美股监控

├── mosaic/factors/              # 评分引擎
│   ├── hidden_signals.js        # H1-H9 隐藏因子
│   └── composite.js             # 5维加权综合评分

├── mosaic/analysis/             # 盘后+深度分析
│   ├── data_quality.js          # 数据源健康+置信度惩罚
│   ├── strategy_health.js       # 策略健康→BLOCK/REDUCE/CAUTIOUS/ALLOW
│   ├── cross_market.js          # 跨市场风险状态机
│   ├── risk_budget.js           # 风险预算 (Kelly/Vol/Corr)
│   ├── market_cycle.js          # A股市场周期
│   ├── factor_performance.js    # 因子命中率 (HOT/WARM/COLD)
│   ├── verification_runner.js   # 赛后验证+数据泄漏审计
│   ├── verification_dashboard.js # IC分解+置信度校准
│   ├── history_review.js        # 统一历史复盘
│   └── quant_report.js          # 每日量化报告

├── mosaic/predict/              # 预测引擎
│   ├── expected_return.js       # 6维 E[R5d]
│   ├── dynamic_weights.js       # OLS动态权重 (R²≥0.05启用)
│   └── trade_attribution.js     # 卖出归因→参数反馈

├── mosaic/evolution/            # 24/7 进化引擎
│   ├── evolution_scheduler.js   # 10任务编排 (catch-up, 超时+重试)
│   ├── bootstrap_history.js     # 7 Phase历史训练+Walk-Forward Split
│   ├── model_registry.js        # Shadow/Champion注册 (6项晋升检查)
│   ├── full_backtest.js         # 多周期全回测 2020-2026
│   └── self_reflection.js       # 每日自我复盘

└── report-engine/               # 前端 (纯静态)
    ├── cockpit.html / .js       # ★ Autonomous Cockpit (Gate Matrix + Funnel)
    ├── think-tank.html          # AI思考舱 (SSE实时流)
    └── index.html               # 主仪表板
```

## Pipeline 执行流程

```
1. 全A股列表 → 过滤 (价格≤20/成交额>1亿/PE≤40/排除ST+创业板)
2. 指数行情 → writeMarketSnapshot() 写入统一快照
3. 计算 H1-H9 + LHB/板块/北向/两融
4. 8维预评分 → top 80 → 5维综合评分 → 排序/评级
5. Simfolio 执行 → kernel统一裁决 → 持仓监控→止损/止盈
```

### Simfolio 交易规则

初始 ¥100,000，T+1，持仓上限 5 只，单只 ≤30%。Kernel 裁决链: marketSession → marketData → circuitBreaker → leakageAudit → strategyHealth → dataQuality。卖出: 硬止损-8%/软止损评分<35/移动止盈，止损冷却期 4 交易日。

## 云端部署

| 项目 | 详情 |
|------|------|
| IP | `8.153.101.112:8765` |
| 系统 | Ubuntu 22.04, 2 vCPU/2 GiB |
| 进程 | systemd `mosaic.service` (Restart=always) |

```bash
# 部署后端 (需重启服务)
scp "<local-path>" "root@8.153.101.112:/root/FIRSTCC/Francis Investment/<path>"
ssh root@8.153.101.112 "systemctl restart mosaic"

# 验证
curl -s http://8.153.101.112:8765/api/status
curl -s http://8.153.101.112:8765/api/cockpit
```

## 关键约束

- **云端永远优先**: 改动后立即 scp 部署
- **config.js 是唯一配置入口**; `report-engine/data/` 是 DATA_DIR
- **`.gitignore` 运行时数据**: 新增数据目录务必同步更新
- **SSH 路径含空格**: 必须引号 `"/root/FIRSTCC/Francis Investment/..."`
- **Eastmoney 在 ECS 被墙**: K线用腾讯 ifzq API
- **`node --check`** 部署前验证，一个前端 JS 语法错误全挂

### config.js 关键配置

```
FILTER:         maxPrice=20, PE<=40, minTurnover=1亿
FACTOR_WEIGHTS: fundamental(25%)/technical(15%)/hidden(20%)/capital_flow(25%)/event(15%)
BUY_THRESHOLD:  compositeScore>=70, expectedReturn>=0
SIMFOLIO:       初始¥100,000, 最大5持仓, 单只≤30%
SCHEDULER:      3次全扫描(09:30/11:00/13:00)+7次中盘扫描
STOP_LOSS_COOLDOWN_DAYS: 4
```

### v3.4.x 陷阱速查

| 陷阱 | 要点 |
|------|------|
| kernel 上下文一致性 | 三个消费者必须传同一套 portfolio+indices+pipelineResults+marketState |
| simfolio P0-1 | 先检查 `kernelDecision.finalVerdict` BLOCK/REDUCE→sell-only |
| decision audit | 从 `kernelDecision.gateStates` 取字段，不用旧 flags |
| marketClosed vs noMarketData | kernel 接受 marketState 字段区分 |
| market_snapshot_latest.json | pipeline.fetchIndices 写入 (含changePercent)，loadLatestIndices 只读 |
| freshnessStatus | live/recorder/cached/stale_daily — 历史日线不伪装成今日 |
| IndexRecorder | 仅价格无涨跌幅，pipeline snapshot 优先 |
| strategy_health totalTrades | 在 masterControl.totalTrades，用于决策审计 |

## 版本历史

| 版本 | 日期 | 关键变更 |
|------|------|----------|
| v3.4.5 | 2026-06-18 | 数据总线统一: pipeline写snapshot, 每指数独立freshness, 399006接入, marketDirection修复, decision_audit补全 |
| v3.4.4 | 2026-06-18 | Session gate (非交易时段禁止买入), 数据总线初始统一, pipeline_summary共享, 样本门控 |
| v3.4.3 | 2026-06-18 | Kernel Closure: 所有路径过kernel, marketState贯穿全链路 |
| v3.4.0 | 2026-06-17 | Unified Decision Kernel (5→6 Hard Blockers), Decision Audit, Cockpit WNB Banner |
| v3.3.x | 2026-06 | Walk-Forward验证, IC分解, Shadow评估对齐, 泄漏审计, Model Registry |
| v3.0 | 2026-05 | 策略健康仪表板, 风险预算, 全回测框架 |
