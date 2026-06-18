# Francis Investment · A股量化交易系统 v3.4.4

Node.js 零外部依赖，阿里云 ECS `8.153.101.112:8765`。全自动日内交易+24/7自主学习进化+报告引擎。

v3.4.4: **Session Gate + Data Bus** — market session gate 作为第一个硬阻断 (closed/post_market/pre_market/lunch_break禁止买入)，数据总线统一 (loadLatestIndices三层优先级: IndexRecorder→快照→历史日线, data_quality同源检查)，pipeline summary 提取共享函数 (scheduler+server同路径保存pipelineResultsForKernel)，decision audit 增加 marketState/indexFreshness/buyThreshold 字段，strategy health 样本门控 (<8笔降级为CAUTIOUS)。

v3.4.3: **Kernel Closure** — 所有执行链路100%经过 decision_kernel (05f9e38 deploy + 03f9e38 fix)。v3.4.1: **Unified Decision Kernel 完全控制交易执行链**。

## 核心架构

```
mosaic_server.js (HTTP 主服务器, 98+ API)
├── mosaic/decision_kernel.js    # ★ v3.4.4 统一决策内核 — 6 hard blockers + session gate
├── mosaic/pipeline_summary.js   # ★ v3.4.4 Pipeline持久化共享函数 (scheduler+server同源)
├── mosaic/scheduler.js          # 状态机调度器 (~1900行) — 全自动
├── mosaic/pipeline.js           # 主流程编排 (519行, EventEmitter+SSE)
├── mosaic/simfolio.js           # 模拟交易引擎 (~2550行) — 服从kernel裁决
├── mosaic/config.js             # ★ 唯一配置入口 (507行)

├── mosaic/collectors/           # 数据采集
│   ├── market_data.js           #   行情/K线 (Eastmoney+腾讯ifzq+Sina)
│   ├── capital_flow.js          #   板块/个股资金流
│   ├── north_bound.js           #   北向资金 (沪港通/深港通)
│   ├── margin_data.js           #   两融数据
│   ├── dragon_tiger.js          #   龙虎榜
│   ├── news_collector.js        #   财经新闻 (Sina)
│   ├── index_recorder.js        #   日内指数快照
│   └── us_market.js             #   美股监控 (SPY/QQQ/ADR等)

├── mosaic/factors/              # 评分引擎
│   ├── hidden_signals.js        #   H1-H9 隐藏因子
│   └── composite.js             #   5维加权综合评分 (regime-aware)

├── mosaic/evolution/            # 24/7 自主学习进化引擎
│   ├── evolution_scheduler.js   #   任务编排 (10任务, catch-up, 超时+重试)
│   ├── bootstrap_history.js     #   ★ 7 Phase历史训练 + Walk-Forward Split (~2000行)
│   ├── full_backtest.js         #   多周期全回测 2020-2026
│   ├── model_registry.js        #   ★ Shadow/Champion注册 (6项晋升检查+降级)
│   ├── night_backtest.js        #   每日因子回测 T+1/3/5
│   ├── weight_grid_search.js    #   OLS权重网格搜索
│   ├── us_as_predict.js         #   美股→A股预测
│   ├── self_reflection.js       #   每日自我复盘
│   └── weekend_factor_mining.js #   周末因子组合挖掘

├── mosaic/predict/              # 预测引擎
│   ├── expected_return.js       #   6维 E[R5d] 预期收益
│   ├── stock_predictor.js       #   个股因子命中率追踪
│   ├── dynamic_weights.js       #   OLS回归动态权重学习
│   ├── cycle_factor_matrix.js   #   周期×因子有效性热力图
│   ├── sector_leadlag.js        #   板块轮动领先/滞后矩阵
│   └── trade_attribution.js     #   卖出归因分析→参数反馈

├── mosaic/analysis/             # 盘后+深度分析
│   ├── cross_market.js          #   美股-A股相关性+风险状态机
│   ├── data_quality.js          #   数据源健康+置信度惩罚
│   ├── factor_performance.js    #   因子命中率 (HOT/WARM/COLD)
│   ├── knowledge_base.js        #   每日知识积累+因子追踪
│   ├── market_cycle.js          #   A股市场周期分类
│   ├── risk_budget.js           #   风险预算 (Kelly/Vol/Corr)
│   ├── strategy_health.js       #   策略健康评估→BLOCK/REDUCE/CAUTIOUS
│   ├── history_review.js        #   统一历史复盘 (日度/深度/发现)
│   ├── history_verifier.js      #   历史相似性预测验证
│   ├── verification_dashboard.js #  IC分解+置信度校准+市场状态分层
│   ├── verification_runner.js   #   赛后验证+反数据泄漏审计
│   ├── quant_report.js          #   每日量化报告
│   ├── us_macro.js              #   美股隔夜宏观摘要
│   ├── weekend_analyzer.js      #   (DEPRECATED→history_review)
│   └── weekend_verifier.js      #   (DEPRECATED→history_review)

└── mosaic/tools/
    └── download_klines.js       #   批量K线下载 (ifzq, 5并发)

report-engine/                   # 前端 (纯静态)
├── index.html                   #   主仪表板 (多Section路由)
├── think-tank.html              #   AI思考舱 (SSE实时流)
├── cockpit.html                 #   ★ Autonomous Cockpit (30s轮询)
├── app.js / style.css           #   主控制器+样式
├── cockpit.js / cockpit.css     #   驾驶舱逻辑+样式 (Gate Matrix + Funnel)
├── renderer.js                  #   PDF报告渲染
├── kline.js                     #   K线图渲染
└── templates/                   #   报告模板 (18个)
```

## Unified Decision Kernel (v3.4.4)

`mosaic/decision_kernel.js` — `computeDecision(context)` 是交易决策的单一真相来源。

### 6 Hard Blockers (优先级顺序, first match wins):

| 优先级 | 门禁 | 阻断条件 |
|--------|------|----------|
| 0 | **marketSession** | ★ v3.4.4: 非交易时段 (closed/post_market/pre_market/lunch_break) 禁止买入 |
| 1 | **marketData** | 交易时段无指数行情数据 |
| 2 | **circuitBreaker** | regime = `panic` 或 `risk_off` |
| 3 | **leakageAudit** | verdict = CRITICAL/DATA_LEAKAGE_RISK/NO_SAMPLES |
| 4 | **strategyHealth** | masterControl.verdict = BLOCK |
| 5 | **dataQuality** | penalty ≥ 7 |

### Soft Reducers:
- leakageAudit MINOR_ISSUES → maxBuysPerDay 减半
- strategyHealth REDUCE/CAUTIOUS → 限制买入
- dataQuality penalty 4-6 → 降低置信度

### 返回结构:
```js
{
  canBuy, finalVerdict: 'ALLOW'|'CAUTIOUS'|'REDUCE'|'BLOCK',
  finalVerdictLabel, maxBuysPerDay,
  hardBlockers: [{gate, reason, severity}],
  softReducers: [{gate, reason}],
  advisorySignals: [{signal, value, interpretation}],
  primaryBlocker,        // v3.4.1: 第一个阻断的门禁
  allActiveBlockers,     // v3.4.1: 所有非pass的门禁列表
  displayReasons,        // v3.4.1: 合并显示理由
  gateStates: { circuitBreaker, leakageAudit, strategyHealth, dataQuality, ... },
  marketClosed,          // v3.4.1: 区分离市 vs 数据缺失
}
```

### 三个消费者:
| 消费者 | 上下文 | 使用方式 |
|--------|--------|----------|
| **simfolio** (P0-1) | 实时portfolio+indices+pipeline | `kernelDecision.finalVerdict` BLOCK/REDUCE→sell-only, 跳过所有buy |
| **cockpit** (P1-1) | 同simfolio | 显示 Gate Matrix 标签矩阵 + primaryBlocker |
| **think-tank** (P1-3) | 同simfolio | 映射 verdict→action (BLOCK→defensive, etc.) |

## Pipeline 执行流程

```
1. 全A股列表 → 过滤 (价格≤20/成交额>1亿/PE≤40/排除ST+创业板)
2. 计算 H1-H9 + 并行 LHB/板块/北向/两融
3. 8维预评分 → top 80 → 5维综合评分 → 排序/评级/SSE广播
4. Simfolio 执行买卖决策 → kernel统一裁决 → 持仓监控→止损/止盈
```

### 综合评分 (composite.js)

5维加权: fundamental(25%) + technical(15%) + hidden(20%) + capital_flow(25%) + event(15%)。动态权重 OLS R²≥0.05 时启用。无财务数据时 fundamental→10%，总分上限 65。

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

初始 ¥100,000，T+1，持仓上限 5 只，单只 ≤30%。v3.4.1 Kernel 统一裁决:

1. **Kernel BLOCK/REDUCE check** → sell-only, skip all buys (P0-1)
2. **回撤门禁**: warn(-5%)/restrict(-8%)/halt(-10%)
3. **市场方向门禁**: 指数跌幅超-0.5%
4. **跨市场熔断**: panic/risk_off → sell-only (来自kernel)
5. **Think-Tank防御**: 6维评分阈值≥3
6. **策略健康门禁**: BLOCK/REDUCE/CAUTIOUS/ALLOW (来自kernel)
7. **数据质量**: penalty≥7 → BLOCK (来自kernel)

卖出: 硬止损-8%/软止损评分<35/移动止盈。止损冷却期 4 交易日不回买。

### Risk Budget 风险预算

波动率调整 → 相关性惩罚(>0.6) → 流动性限制(≤5%日均成交量) → Kelly仓位(Half-Kelly 0.5) → 日最大亏损上限(2% NAV) → 连续亏损上限(5次=冻结买入)。

### Model Registry 模型注册

Champion/Challenger (Shadow) 模式，6项严格晋升检查:

| 检查项 | 阈值 | 说明 |
|--------|------|------|
| IC excess | Shadow IC > Champion IC + 0.05 | EMA平滑累积IC |
| 方向命中率 | > 52% | Per-shadow forward 样本命中 |
| 成本后正收益 | cumulativeIC > 0 | 扣除佣金印花税 |
| 回撤不恶化 | shadow DD <= champion DD | 最大回撤不扩大 |
| Forward 样本 | ≥ 100 per shadow | 严格的 per-shadow 计数 |
| 校准检查 | 高分预测确实更准 | cumulativeIC > 0 代理 |
| 评估天数 | ≥ 5 天 | 最小观察期 |

**降级逻辑**: Champion IC < 0 且最佳 Shadow IC 超过 |demotionThreshold|(0.10) → 自动降级。

## 24/7 进化引擎调度

| 任务 | 时间 | 说明 |
|------|------|------|
| bootstrap_history | 周日 01:00 | 7 Phase历史训练 (首次全量，后续增量) |
| full_backtest | 周日 02:00 | 多周期全回测 2020-2026 |
| night_backtest | 每天 02:00 | 因子回测 T+1/3/5 |
| weight_grid_search | 每天 03:00 | OLS权重网格搜索 |
| parameter_push | 每天 04:00 | 参数推送 |
| us_predict_generate | 每天 05:30 | 美股→A股预测生成 |
| us_predict_verify | 每天 16:10 | 美股预测验证 |
| self_reflection | 每天 20:00 | 每日自我复盘 |
| weekend_factor_mining | 周六 10:00 | 因子组合挖掘 |
| weekly_report | 周日 14:00 | 周度报告生成 |
| daily_verification | 每天 15:30 | 赛后验证 (命中率+Rank IC+泄漏审计) |

全部10个任务支持 catch-up、30分钟超时+1次重试。

## Bootstrap 历史训练

7 Phase: K线下载→每日回放→因子矩阵→组合挖掘→跨市场→参数搜索→输出报告。
首次全量，后续每周增量 (EMA alpha=0.15)。

**Walk-Forward Split**: `--split` 模式将数据分为训练(2021-2024)、验证(2025)、前向(2026)三段。

```bash
node mosaic/evolution/bootstrap_history.js                    # 全量
node mosaic/evolution/bootstrap_history.js --incremental      # 增量
node mosaic/evolution/bootstrap_history.js --split --skipDownload  # Walk-Forward验证
curl -X POST http://8.153.101.112:8765/api/evolution/run-bootstrap
```

## 关键 API 路由

### 核心状态
| 路由 | 说明 |
|------|------|
| `/api/status` | 服务器+管线+调度器状态 |
| `/api/config/public` | 公开配置 (UI Standard) |
| `/api/cockpit` | 自主驾驶舱 (含 Gate Matrix + Funnel) |

### 管线+交易
| 路由 | 说明 |
|------|------|
| `/api/pipeline/run` (POST) | 触发全量扫描 |
| `/api/pipeline/status` | 扫描进度 |
| `/api/pipeline/result` | 最新结果 (内存) |
| `/api/pipeline/last-result` | 持久化结果 |
| `/api/simfolio/status` | 持仓快照+健康 |
| `/api/simfolio/history` | NAV历史 |
| `/api/simfolio/trade` (POST) | 手动执行交易 |
| `/api/simfolio/reset` (POST) | 重置持仓 |

### 策略健康+风险
| 路由 | 说明 |
|------|------|
| `/api/strategy/health` | 策略健康完整报告 |
| `/api/strategy/health/summary` | 策略健康摘要 |
| `/api/risk-budget/status` | 风险预算状态 |

### 数据+市场
| 路由 | 说明 |
|------|------|
| `/api/data-quality/status` | 数据源健康 |
| `/api/data-quality/summary` | 数据质量摘要 |
| `/api/us-market/current` | 美股当前快照 |
| `/api/us-market/summary` | 美股隔夜摘要 |
| `/api/market/cycle` | 当前市场周期 |
| `/api/market/microstructure` | Smart Risk Hub |
| `/api/sectors/live` | 实时板块行情 |
| `/api/margin/status` | 两融情绪 |
| `/api/cross-market/analysis` | 跨市场分析 |
| `/api/cross-market/risk-state` | 风险状态 |

### 预测+因子
| 路由 | 说明 |
|------|------|
| `/api/predict/expected-returns` | E[R₅] 预期收益 |
| `/api/predict/expected-return-verification` | 预测vs实际验证 |
| `/api/predict/factor-performance` | 个股因子命中率 |
| `/api/predict/dynamic-weights` | 动态权重+R² |
| `/api/predict/sector-leadlag` | 板块领先/滞后 |
| `/api/predict/cycle-factor-matrix` | 周期×因子热力图 |
| `/api/predict/trade-attribution` | 卖出归因调整 |
| `/api/factors/performance` | 因子HOT/COLD状态 |

### 进化引擎
| 路由 | 说明 |
|------|------|
| `/api/evolution/status` | 进化引擎状态 |
| `/api/evolution/run-bootstrap` (POST) | 手动触发Bootstrap |
| `/api/evolution/bootstrap-status` | Bootstrap运行状态 |
| `/api/evolution/training-matrix` | 训练矩阵数据 |
| `/api/evolution/training-report` | 自动生成的训练报告 |
| `/api/evolution/factor-effectiveness` | 因子有效性矩阵 |
| `/api/evolution/run-night-backtest` (POST) | 手动触发夜盘回测 |
| `/api/evolution/night-backtest/latest` | 最新夜盘回测结果 |
| `/api/evolution/run-grid-search` (POST) | 手动触网格搜索 |
| `/api/evolution/grid-search/latest` | 最新网格搜索结果 |
| `/api/evolution/run-self-reflection` (POST) | 手动触发自我复盘 |
| `/api/evolution/self-reflection/latest` | 最新自我复盘 |
| `/api/evolution/run-factor-mining` (POST) | 手动触发因子挖掘 |
| `/api/evolution/factor-mining/latest` | 最新因子挖掘结果 |
| `/api/evolution/run-us-predict` (POST) | 手动触发美股预测 |
| `/api/evolution/run-us-verify` (POST) | 手动触发美股验证 |
| `/api/evolution/us-predict/today` | 今日美股→A预测 |
| `/api/evolution/us-predict/accuracy` | 美股预测准确率 |
| `/api/evolution/run-all` (POST) | 触发全部进化任务 |
| `/api/evolution/walk-forward-report` | Walk-Forward报告 |

### 模型注册
| 路由 | 说明 |
|------|------|
| `/api/model-registry/status` | 模型注册状态 (含forwardSamples/demotionLog) |
| `/api/model-registry/champion` | 当前冠军模型参数 |
| `/api/model-registry/evaluate` (POST) | 触发Shadow评估 (6项晋升检查) |

### 验证
| 路由 | 说明 |
|------|------|
| `/api/verification/dashboard` | 赛后验证仪表板 (含IC分解/校准/市场状态) |
| `/api/verification/ic-breakdown` | IC分解 (train/validate/forward) |
| `/api/verification/leakage-audit` | 数据泄漏审计 |
| `/api/verification/calibration` | 置信度校准 |

### 历史复盘+知识
| 路由 | 说明 |
|------|------|
| `/api/history/status` | 历史复盘引擎状态 |
| `/api/history/report` | 历史复盘报告 |
| `/api/history/context` | 历史交易日上下文 |
| `/api/history/patterns` | 发现的历史模式 |
| `/api/history/discoveries` | 最新发现 |
| `/api/history/deep-analysis` | 深度截面分析 |
| `/api/knowledge/summary` | 知识库摘要 |
| `/api/knowledge/factor-combos` | 因子组合数据 |

### Think Tank (SSE实时流)
| 路由 | 说明 |
|------|------|
| `/api/think-tank/initial` | 思考舱初始全量状态 |
| `/api/think-tank/decision-status` | 决策审计+6大学习循环 |
| `/api/think-tank/candidate-kline` | 候选股批量K线 |
| `/api/think-tank/stream` | SSE事件流 (实时) |

### 其他
| 路由 | 说明 |
|------|------|
| `/api/backtest/latest` | 最新全回测结果 |
| `/api/backtest/run` (POST) | 手动触发全回测 |
| `/api/events/dates` | 事件日期列表 |
| `/api/events/:date` | 某日事件 |
| `/api/summary-dates` | 每日摘要日期 |
| `/api/daily-summary/latest` | 最新每日摘要 |
| `/api/daily-summary/:date` | 某日摘要 |
| `/api/news/latest` | 最新财经新闻 |
| `/api/analysis/latest` | 最新量化分析 |
| `/api/reports-index` | 报告索引 |
| `/api/report/:date` | 某日报告 |

## 云端部署

| 项目 | 详情 |
|------|------|
| IP | `8.153.101.112:8765` |
| 系统 | Ubuntu 22.04, 2 vCPU/2 GiB, CST |
| 进程 | systemd `mosaic.service` (Restart=always, RestartSec=10) |

```bash
# 部署后端 (需重启)
scp "C:/Users/anzhe/FIRSTCC/Francis Investment/<path>" "root@8.153.101.112:/root/FIRSTCC/Francis Investment/<path>"
ssh root@8.153.101.112 "systemctl restart mosaic"

# 前端无需重启
# 验证
curl -s http://8.153.101.112:8765/api/status
curl -s http://8.153.101.112:8765/api/cockpit
```

## 关键约束

### 部署铁律
- **云端永远优先**: 改动后立即 scp 部署
- 后端文件 (`mosaic/` .js) 部署后需 `systemctl restart mosaic`
- 前端静态文件无需重启
- 部署后 curl 验证

### 配置规则
- **config.js 是唯一配置入口**
- **`report-engine/data/` 是 DATA_DIR**
- **`.gitignore` 运行时数据**: 新增数据目录务必同步更新 .gitignore

### config.js 关键配置

```
FILTER:         maxPrice=20, PE<=40, minTurnover=1亿
FACTOR_WEIGHTS: fundamental(25%)/technical(15%)/hidden(20%)/capital_flow(25%)/event(15%)
BUY_THRESHOLD:  compositeScore>=70, expectedReturn>=0
SIMFOLIO:       初始¥100,000, 最大5持仓, 单只≤30%, Kelly阶梯仓位
SCHEDULER:      3次全扫描(09:30/11:00/13:00)+7次中盘扫描
EVOLUTION:      10个定时任务 (见调度表)
PREDICTION:     6维 E[R5d], OLS动态权重 (R²≥0.05启用)

[v3.4.x]
MID_SCAN:       midScanDeepAnalyze=50, midScanTopCount=300
SHADOW_MODE:    enabled, minEvalDays=5, promotionThreshold=0.05
MODEL_REGISTRY: maxVersions=20, minVerificationSamples=30, forwardSamples persistence
AUTO_PAUSE:     dataQualityMin=85, maxConsecutiveLosses=5
STOP_LOSS_COOLDOWN_DAYS: 4
WALK_FORWARD:   train:2021-2024, validate:2025, forward:2026, expandingWindow
IC_DECOMPOSITION: rollingICWindow=30, overfitWarningRatio=0.3
CONFIDENCE_CALIBRATION: bins:[low/medium/high], minSamplesPerBin=30
LEAKAGE_AUDIT:  enforceTemporalOrder, maxLookbackGap=5
```

### 已知陷阱速查

| 陷阱 | 要点 |
|------|------|
| SSH 路径含空格 | 必须引号 `"/root/FIRSTCC/Francis Investment/..."` |
| Eastmoney 在 ECS 被墙 | K线用腾讯 ifzq API；两融/板块资金流也受影响 |
| compositeScore 返回类型 | 对象，需提取 `.compositeScore` |
| klines 目录冲突 | `market_data.js`→`klines_short/`，`bootstrap_history.js`→`klines/` |
| 前端 JS 语法错误 | `node --check` 部署前验证，一个错误全挂 |
| regime 字段路径 | `riskState.regime`，不是 `riskState.riskRegime` |
| `safeFixed()` | simfolio.js 所有 `.toFixed()` 必须用它包装 |
| macroContext 作用域 | `checkBuySignal` 模块级函数，必须显式传入 |
| 止损冷却期 | `STOP_LOSS_COOLDOWN_DAYS=4`，止损时记录，候选遍历中检查 |
| 任务超时 | `evolution_scheduler` 30分钟超时 + 1次重试 |
| model_registry 数据 | `model_registry.json` 在 `report-engine/data/evolution/` |
| avoidSectors 来源 | 从 `trade_attribution.json` 的 `_avoidSectors` 读取 |

**v3.3.x+ 陷阱:**

| 陷阱 | 要点 |
|------|------|
| Shadow 晋升 6 项检查 | `checkPromotionCriteria()` 返回 `{eligible, failingChecks[]}` |
| Bootstrap --split | 需要 klines/ 已有数据 (`--skipDownload`)，否则 Phase 1 覆盖分区 |
| 泄漏审计 | 首次 verification_runner 运行后生成；向后兼容无 predictionDate 的旧数据 |
| calibration.json 路径 | 唯一路径: `data/evolution/calibration.json` |
| Shadow 验证对齐 | 按 predictionDate+code+horizon 匹配，禁用 code-only fallback |
| forwardSamples 持久化 | `sampleKeys[]` 数组防重复累计 |
| Cockpit 加载态 | API 失败时 `renderAllError(msg)` 填充所有面板 |

**v3.4.x 陷阱:**

| 陷阱 | 要点 |
|------|------|
| kernel 上下文一致性 | 三个消费者 (cockpit/think-tank/simfolio) 必须传同一套 portfolio+indices+pipelineResults+marketState |
| simfolio P0-1 | 在旧 6-gate chain 之前先检查 `kernelDecision.finalVerdict` BLOCK/REDUCE→sell-only |
| decision audit | 直接从 `tradeResult.kernelDecision` 取字段，不要用旧 flags 重建 verdict |
| marketClosed vs noMarketData | kernel 接受 `marketState` 字段区分，cockpit 根据 `marketClosed` 显示不同标签 |
| allActiveBlockers | 数组包含所有 block/reduce/cautious 的门禁，不只第一个 |

### 绝不提交的运行时数据

见 `.gitignore` 完整列表。新增运行时数据文件/目录必须同步更新。

## 版本历史摘要

| 版本 | 日期 | 关键变更 |
|------|------|----------|
| v3.4.4 | 2026-06-18 | Session gate P0 (非交易时段禁止买入), 数据总线统一 (loadLatestIndices三层: Recorder→快照→历史日线, data_quality同源), pipeline_summary共享函数, decision_audit补全(marketState/indexFreshness/buyThreshold), strategy_health样本门控(<8笔→CAUTIOUS) |
| v3.4.3 | 2026-06-18 | Kernel Closure: no-index路径过kernel, marketState贯穿全链路, 手动trade传macroContext, Think-Tank指数路径修正, scheduler事件完整kernel字段, simfolio返回buyCandidates/effectiveMaxBuys/skipReason |
| v3.4.1 | 2026-06-18 | P0/P1修复: Kernel完全控制交易执行链 (finalVerdict→simfolio, kernel→audit, finalize()缓存, allActiveBlockers, marketClosed, 统一上下文) |
| v3.4.0 | 2026-06-17 | Unified Decision Kernel (5 Hard Blockers), Decision Audit, Cockpit WNB Banner + Gate Matrix, MD scan 20→50 |
| v3.3.2 | 2026-06-17 | 泄漏审计升级为真实风控门禁, permissions 诊断修复 |
| v3.3.1 | 2026-06-17 | Walk-Forward验证, IC分解, 置信度校准, Shadow评估对齐, 数据泄漏审计 |
| v3.3.0 | 2026-06-16 | Bootstrap验证, Model Registry, Shadow预测, 自主学习交易员闭环 |
| v3.2.x | 2026-06 | 验证仪表板, 历史复盘, K线数据扩充 |
| v3.0 | 2026-05 | 策略健康仪表板, 风险预算, 全回测框架 |
