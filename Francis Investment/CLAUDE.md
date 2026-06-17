# Francis Investment · A股量化交易系统 v3.3.1

Node.js 零外部依赖，阿里云 ECS `8.153.101.112:8765`。全自动日内交易+24/7自主学习进化+报告引擎。

v3.3.1: 从"看起来智能"到"可证明预测能力" — Walk-Forward 验证、反数据泄漏审计、收紧 Champion 晋升、IC 分解、置信度校准、市场状态分层验证。

**[2026-06-17] v3.3.1 修复版**: Shadow/Champion评估链路对齐 (predictionDate+code+horizon)、calibration路径统一、API Health真实状态、Cockpit UI 8面板全部返回真实数据 (不再空白/假OK)。详见 `### v3.3.1 修复记录`。

## 核心架构

```
mosaic_server.js (HTTP 主服务器, 55+ API)
├── mosaic/scheduler.js         # 状态机调度器 (1734行) — 全自动
├── mosaic/pipeline.js          # 主流程编排 (EventEmitter+SSE)
├── mosaic/simfolio.js          # 模拟交易引擎 (2228行) — 6门风控
├── mosaic/config.js            # ★ 唯一配置入口 (520+行)

├── mosaic/collectors/          # 数据采集
│   ├── market_data.js          #   行情/K线 (Eastmoney+腾讯ifzq+Sina)
│   ├── capital_flow.js         #   板块/个股资金流
│   ├── north_bound.js          #   北向资金 (沪港通/深港通)
│   ├── margin_data.js          #   两融数据
│   ├── dragon_tiger.js         #   龙虎榜
│   ├── news_collector.js       #   财经新闻 (Sina)
│   ├── index_recorder.js       #   日内指数快照
│   └── us_market.js            #   美股监控 (SPY/QQQ/ADR等)

├── mosaic/factors/             # 评分引擎
│   ├── hidden_signals.js       #   H1-H9 隐藏因子
│   └── composite.js            #   5维加权综合评分 (regime-aware)

├── mosaic/evolution/           # 24/7 自主学习进化引擎
│   ├── evolution_scheduler.js  #   任务编排 (10任务, catch-up, 超时+重试)
│   ├── bootstrap_history.js    #   ★ 7 Phase历史训练 + Walk-Forward Split (~2000行)
│   ├── full_backtest.js        #   多周期全回测 2020-2026
│   ├── model_registry.js       #   ★ v3.3.1 Shadow/Champion注册 (6项晋升检查+降级)
│   ├── night_backtest.js       #   每日因子回测 T+1/3/5
│   ├── weight_grid_search.js   #   OLS权重网格搜索
│   ├── us_as_predict.js        #   美股→A股预测
│   ├── self_reflection.js      #   每日自我复盘
│   └── weekend_factor_mining.js#   周末因子组合挖掘

├── mosaic/predict/             # 预测引擎
│   ├── expected_return.js      #   6维 E[R5d] 预期收益
│   ├── stock_predictor.js      #   个股因子命中率追踪
│   ├── dynamic_weights.js      #   OLS回归动态权重学习
│   ├── cycle_factor_matrix.js  #   周期×因子有效性热力图
│   ├── sector_leadlag.js       #   板块轮动领先/滞后矩阵
│   └── trade_attribution.js    #   卖出归因分析→参数反馈

├── mosaic/analysis/            # 盘后+深度分析
│   ├── cross_market.js         #   美股-A股相关性+风险状态机
│   ├── data_quality.js         #   数据源健康+置信度惩罚
│   ├── factor_performance.js   #   因子命中率 (HOT/WARM/COLD)
│   ├── knowledge_base.js       #   每日知识积累+因子追踪
│   ├── market_cycle.js         #   A股市场周期分类
│   ├── risk_budget.js          #   ★ v3.0 风险预算 (Kelly/Vol/Corr)
│   ├── strategy_health.js      #   策略健康评估→BLOCK/REDUCE/CAUTIOUS
│   ├── history_review.js       #   ★ v3.2 统一历史复盘 (日度/深度/发现)
│   ├── history_verifier.js     #   历史相似性预测验证
│   ├── verification_dashboard.js # ★ v3.3.1 IC分解+置信度校准+市场状态分层
│   ├── verification_runner.js  #   ★ v3.3.1 赛后验证+反数据泄漏审计
│   ├── quant_report.js         #   每日量化报告
│   ├── us_macro.js             #   美股隔夜宏观摘要
│   ├── weekend_analyzer.js     #   (DEPRECATED→history_review)
│   └── weekend_verifier.js     #   (DEPRECATED→history_review)

└── mosaic/tools/               # 独立工具
    └── download_klines.js      #   ★ v3.2.3 批量K线下载 (ifzq, 5并发)

report-engine/                   # 前端 (纯静态)
├── index.html                  #   主仪表板 (多Section路由)
├── think-tank.html             #   AI思考舱 (SSE实时流)
├── cockpit.html                #   ★ v3.3.1 自主驾驶舱 (9面板, 30s轮询)
├── app.js / style.css          #   主控制器+样式
├── cockpit.js / cockpit.css    #   ★ v3.3.1 驾驶舱逻辑+样式 (IC分解/校准/Shadow追踪)
├── renderer.js                 #   PDF报告渲染
├── kline.js                    #   K线图渲染
└── templates/                  #   报告模板 (18个)
```

## Pipeline 执行流程

```
1. 全A股列表 → 过滤 (价格≤20/成交额>1亿/PE≤40/排除ST+创业板)
2. 计算 H1-H9 + 并行 LHB/板块/北向/两融
3. 8维预评分 → top 80 → 5维综合评分 → 排序/评级/SSE广播
4. Simfolio 自动执行买卖决策 (6门风控→持仓监控→止损/止盈)
```

### 综合评分 (composite.js)

5维加权: fundamental(25%) + technical(15%) + hidden(20%) + capital_flow(25%) + event(15%)。动态权重 OLS R²≥0.05 时启用。无财务数据时 fundamental→10%，总分上限 65。regime-aware 因子加权。

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

初始 ¥100,000，T+1，持仓上限 5 只，单只 ≤30%。v3.3.0 6门风控:
1. **回撤门禁**: warn(-5%)/restrict(-8%)/halt(-10%)
2. **市场方向门禁**: 指数跌幅超-0.5%
3. **跨市场熔断**: panic/risk_off → sell-only
4. **Think-Tank防御**: 6维评分阈值≥3
5. **策略健康门禁**: BLOCK/REDUCE/CAUTIOUS/ALLOW
6. **自动暂停**: 5条件触发 (数据质量/训练失败/验证下滑/连续亏损/API异常)

卖出: 硬止损-8%/软止损评分<35/移动止盈。止损冷却期 4 交易日不回买 (v3.3.0)。

### Risk Budget 风险预算 (v3.0)

波动率调整 → 相关性惩罚(>0.6) → 流动性限制(≤5%日均成交量) → Kelly仓位(Half-Kelly 0.5) → 日最大亏损上限(2% NAV) → 连续亏损上限(5次=冻结买入)。

### Model Registry 模型注册 (v3.3.1)

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

新训练版本先以 "shadow" 身份进入，记录预测但不影响实盘。每日赛后验证: Shadow 6项全过才晋升。最大 20 版本，支持 `retireVersion`、`demoteChampion`。

## 24/7 进化引擎调度

| 任务 | 时间 | 说明 |
|------|------|------|
| bootstrap_history | 周日 01:00 | 7 Phase历史训练 (首次全量，后续增量) |
| full_backtest | 周日 02:00 | 多周期全回测 2020-2026 |
| night_backtest | 每天 02:00 | 因子回测 T+1/3/5 |
| weight_grid_search | 每天 03:00 | OLS权重网格搜索 |
| parameter_push | 每天 04:00 | 参数推送 (grid search/bootstrap完成后) |
| us_predict_generate | 每天 05:30 | 美股→A股预测生成 |
| us_predict_verify | 每天 16:10 | 美股预测验证 |
| self_reflection | 每天 20:00 | 每日自我复盘 |
| weekend_factor_mining | 周六 10:00 | 因子组合挖掘 (协同/冲突对) |
| weekly_report | 周日 14:00 | 周度报告生成 |
| **daily_verification** | **每天 15:30** | **[v3.2.3] 赛后验证 (命中率+Rank IC+泄漏审计)** |

全部10个任务支持 catch-up (服务器重启不丢窗口)、30分钟超时+1次重试 (`_executeWithRetry`)。

## Bootstrap 历史训练 (bootstrap_history.js)

7 Phase: K线下载→每日回放→因子矩阵→组合挖掘→跨市场→参数搜索→输出报告。
首次全量，后续每周增量 (EMA alpha=0.15)。

**v3.3.1 Walk-Forward Split**: `--split` 模式将数据分为训练(2021-2024)、验证(2025)、前向(2026)三段，输出 `walk_forward_report.json` 和 `ic_decomposition.json`。

```bash
node mosaic/evolution/bootstrap_history.js              # 全量
node mosaic/evolution/bootstrap_history.js --incremental # 增量
node mosaic/evolution/bootstrap_history.js --split --skipDownload  # Walk-Forward验证
curl -X POST http://8.153.101.112:8765/api/evolution/run-bootstrap
```

## 反数据泄漏审计 (v3.3.1)

`verification_runner.js` 每条验证记录增加 `predictionDate`、`targetDate`、`horizon`、`isLeakageFree` 字段。每日赛后运行 `runLeakageAudit()` 验证 temporal order (predictionDate < targetDate)，输出 `leakage_audit.json`。

## 置信度校准 (v3.3.1)

预测按分数分 bin (low 0-55/medium 55-70/high 70-100)，比较预期命中率 vs 实际命中率，计算 ECE。输出 `calibration.json`。Cockpit Panel 6 显示校准柱状图。

## IC 分解 (v3.3.1)

从 walk_forward_report + verification_history 拆解:
- **Training IC**: Bootstrap 样本内 (2021-2024)
- **Validation IC**: 留出验证期 (2025)
- **Forward IC**: 最近30天真实样本外
- **Overfit Ratio**: (trainIC - forwardIC) / trainIC，>0.3 标记过拟合

Cockpit Panel 5 显示三栏 IC + overfit verdict。

## 关键 API 路由

### 核心状态
| 路由 | 说明 |
|------|------|
| `/api/status` | 服务器+管线+调度器状态 |
| `/api/config/public` | 公开配置 (UI Standard) |
| `/api/cockpit` | **[v3.3.1]** 9面板自主驾驶舱 (含IC分解/校准/泄漏/Shadow追踪) |

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
| `/api/evolution/walk-forward-report` | **[v3.3.1]** Walk-Forward报告 |

### 模型注册 (v3.3.1 收紧)
| 路由 | 说明 |
|------|------|
| `/api/model-registry/status` | 模型注册状态 (含forwardSamples/demotionLog) |
| `/api/model-registry/champion` | 当前冠军模型参数 |
| `/api/model-registry/evaluate` (POST) | 触发Shadow评估 (6项晋升检查) |

### 验证 (v3.3.1 扩展)
| 路由 | 说明 |
|------|------|
| `/api/verification/dashboard` | 赛后验证仪表板 (含IC分解/校准/市场状态) |
| `/api/verification/ic-breakdown` | **[v3.3.1]** IC分解 (train/validate/forward) |
| `/api/verification/leakage-audit` | **[v3.3.1]** 数据泄漏审计 |
| `/api/verification/calibration` | **[v3.3.1]** 置信度校准 |

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
curl -s http://8.153.101.112:8765/api/verification/dashboard
curl -s http://8.153.101.112:8765/api/verification/ic-breakdown
curl -s http://8.153.101.112:8765/api/verification/leakage-audit
curl -s http://8.153.101.112:8765/api/verification/calibration
curl -s http://8.153.101.112:8765/api/evolution/walk-forward-report
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

[v3.3.0 新增]
SHADOW_MODE:    { enabled: true, minEvalDays: 5, promotionThreshold: 0.05 }
MODEL_REGISTRY: { maxVersions: 20, minEvaluationDays: 5, minVerificationSamples: 30 }
AUTO_PAUSE:     { dataQualityMin: 85, maxConsecutiveLosses: 5, ... }
STOP_LOSS_COOLDOWN_DAYS: 4

[v3.3.1 新增]
WALK_FORWARD:      { train:2021-2024, validate:2025, forward:2026, expandingWindow:true }
IC_DECOMPOSITION:  { rollingICWindow:30, overfitWarningRatio:0.3 }
VERIFICATION_AUDIT: { enforceTemporalOrder:true, maxLookbackGap:5 }
CONFIDENCE_CALIBRATION: { bins:[low/medium/high], minSamplesPerBin:30 }
REGIME_VERIFICATION: { minSamplesPerRegime:10 }
SHADOW_MODE 收紧:   { minForwardSamplesPerShadow:100, minDirectionHitRate:0.52,
                     requirePostCostPositive:true, maxDrawdownNotWorse:true,
                     requireCalibrationCheck:true }
MODEL_REGISTRY:     { forwardSamplesFile, demotionLogFile }
```

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
| stock_factor_performance 结构 | `dailyRecords` (对象 key=日期) 不是 `records` (数组); factorSignals 无 hit 字段=待验证 |
| scan_records 路径+格式 | 在 `SIMFOLIO_DIR` (非 DATA_DIR); 纯数组，非 `{results:...}` 对象 |
| macroContext 作用域 | `checkBuySignal` 是模块级函数，无法闭包访问 `makeTradingDecisions` 局部变量，必须显式传入 [v3.3] |
| 策略健康门禁 | `strategy_health` 返回 BLOCK/REDUCE/CAUTIOUS/ALLOW，`simfolio.js` 必须消费此裁决 [v3.3] |
| 止损冷却期 | `STOP_LOSS_COOLDOWN_DAYS=4`，`executeSell` 中触发止损时记录，`makeTradingDecisions` 候选遍历中检查冷却 [v3.3] |
| 任务超时 | `evolution_scheduler` 30分钟超时 + 1次重试，`_executeWithRetry` 防止 `_state.running` 永久卡住 [v3.3] |
| model_registry 数据 | `model_registry.json` 在 `report-engine/data/evolution/`，运行时数据不提交 git [v3.3] |
| avoidSectors 来源 | 从 `trade_attribution.json` 的 `_avoidSectors` 读取，由 `trade_attribution.js` 在卖出归因后更新 [v3.3] |

**v3.3.1 新增陷阱**:

| 陷阱 | 要点 |
|------|------|
| Shadow 晋升 6 项检查 | `checkPromotionCriteria()` 返回 `{eligible, failingChecks[]}`，晋升前必须全部通过；早期 Shadow 会因为缺少 forward 样本被阻塞 |
| Bootstrap --split | 需要 klines/ 目录已有数据（`--skipDownload`），否则 Phase 1 下载会覆盖训练/验证/前向分区 |
| Walk-forward 报告路径 | `walk_forward_report.json` 和 `ic_decomposition.json` 都在 `report-engine/data/evolution/`，不提交 git |
| 泄漏审计 | `leakage_audit.json` 在首次 verification_runner 运行后生成；`totalChecks=0` 表示验证数据中尚无 predictionDate/targetDate 字段 (向后兼容) |
| 置信度校准 | 需要 ≥30 条验证样本/bin 才有结果；初始阶段 low bin 和 medium bin 样本最多 |
| demoteChampion | 触发条件: championIC < 0 AND bestShadowIC > championIC + 0.10；降级后 `_state.champion` 变为 null |
| 孤儿注释 `/**` | verification_runner.js 中注意：插入代码块时不要留下孤立的 JSDoc 开头标记 |
| Shadow 验证对齐 | `_computeRankIC` 和 `evaluateShadow` 必须统一使用 `_buildShadowPredictionMap()` 按 predictionDate+code+horizon 匹配，不能只用 code-only `predMap[code]` |
| calibration.json 路径 | 唯一路径: `data/evolution/calibration.json`；`verification_dashboard.js` 写到这里，`buildDataFileHealth()` 也查这里 |
| API Health 不能写死 | `buildCockpitData()` 中每个 apiHealth 字段必须基于真实文件存在性或数据内容判断，用 `_fileExists()` 或检查 result 对象 |
| `_loadVerification()` 字段完整 | 必须携带 predictionDate/targetDate/horizon（不只是 code/actualReturn/score），否则 evaluateShadow 无法做日期对齐 |
| latestByCode/code-only fallback | **禁用**。`_buildShadowPredictionMap._getPrediction`、`evaluateShadow`、`_computeRankIC` 三处均不允许跨日期 code-only 匹配，只能 date+code+horizon 精确对齐 |
| forwardSamples 重复累计 | `updateForwardSamples` 必须持久化 `sampleKeys[]` 数组；每次调用只统计新 key；`evaluateShadow` 传 `(versionId, dateStr, sampleKeys, hitSampleKeys)` |
| Cockpit 加载态阻塞 | API 失败时必须调用 `renderAllError(msg)` 填充所有 panel body；不能只设 connection status 让面板永久 Loading |
| config.js calibrationFile | 必须指向 `data/evolution/calibration.json`；`CONFIDENCE_CALIBRATION.calibrationFile` 与 `verification_dashboard.js` 内 EVOLUTION_DIR 必须一致 |

### 绝不提交的运行时数据

`portfolio.json`, `scheduler_state.json`, `events/*.json`, `summaries/*.json`, `knowledge_base/*.json`, `index_history_*.json`, `us_latest.json`, `correlation_history.json`, `factor_performance.json`, `scan_records_*.json`, `last_pipeline_result.json`, `weekend_context.json`, `market_history/indices/*.json`, `weekend_archive/*.json`, `margin_cache.json`, `dynamic_weights.json`, `stock_factor_performance.json`, `cycle_factor_matrix.json`, `sector_leadlag.json`, `trade_attribution.json`, `klines/*.json`, `klines_short/*.json`, `night_backtest_result.json`, `self_reflection_result.json`, `us_as_predictions.json`, `us_as_verification_history.json`, `factor_combinations.json`, `weight_grid_result.json`, `full_backtest_result*.json`, `data_quality_report.json`, `strategy_health_snapshot.json`, `*_snapshot.json`, `bootstrap_state.json`, `training_matrix.json`, `factor_effectiveness.json`, `param_search_results.json`, `cross_market_linkage.json`, `expected_return_verification.json`, `history_context.json`, `verification/`, `evolution/`, `stop_loss_cooldowns.json`, `model_registry.json`, `daily_reflections/`, `attribution_adjustments.json`, `last_gate_state.json`, `position_diagnosis.json`, `false_signal_patterns.json`, `missed_opportunities.json`, `evo_task_history.json`, `version_history.json`

**[v3.3.1 新增]** `walk_forward_report.json`, `ic_decomposition.json`, `shadow_forward_samples.json`, `demotion_log.json`, `leakage_audit.json`, `calibration.json`

### v3.3.1 修复记录 (2026-06-17)

**第一轮**: 6个bug修复，解决"API返回200但数据空洞"问题:

| 问题 | 修复 | 涉及文件 |
|------|------|----------|
| `_loadVerification()` 丢失 predictionDate/targetDate/horizon | 补全6字段到 actualReturns 列表 | `model_registry.js` |
| `_computeRankIC()` code-only 匹配，忽略日期对齐 | 改用 `_buildShadowPredictionMap()` + date-aligned lookup | `model_registry.js` |
| calibration.json 路径不一致 (写到 evolution/，数据健康检查查 data/根) | 统一为 `data/evolution/calibration.json` | `mosaic_server.js`, `.gitignore` |
| API Health 写死 OK (walkForward/cockpit/calibration) | 新增 `_fileExists()` helper, 7个API均基于真实文件/数据判断 | `mosaic_server.js` |
| 核心数据文件未生成 (evolution/ + verification/ 目录空) | 云端运行 `verification_runner.js` 生成全部9个文件 | 运维操作 |
| Cockpit 预测能力面板数据缺失时显示空白 | 缺失时 fallback 显示 Verification Summary 基本命中率 | `cockpit.js` |

**第二轮 (2026-06-17)**: 4个深层硬问题修复:

| 问题 | 修复 | 涉及文件 |
|------|------|----------|
| `_buildShadowPredictionMap._getPrediction` 仍保留 latestByCode fallback | 彻底移除 latestByCode 和 code-only fallback，只允许 date+code+horizon 精确匹配 | `model_registry.js` |
| `evaluateShadow` 和 `_computeRankIC` 保留 code-only fallback | 移除所有 `predMap[code]` 回退逻辑 | `model_registry.js` |
| `updateForwardSamples` 无 sampleKeys 持久化，重复评估累加 | 新增 sampleKeys 持久化数组，`updateForwardSamples` 跳过已计入的 key，返回 `{addedTotal, addedHits}` | `model_registry.js` |
| Cockpit API 失败时面板永久 Loading | 新增 `renderAllError(msg)` 函数，API 404/error 时所有面板显示错误原因而非 spinner | `cockpit.js` |
| config.js calibrationFile 指向错误路径 `data/verification/` | 修正为 `data/evolution/calibration.json`，与 dashboard/cockpit 统一 | `config.js` |
| .gitignore 同时存在 evolution/calibration.json 和 verification/calibration.json | 删除 verification/calibration.json，只保留 evolution/ | `.gitignore` |

**修复后状态**: 
- 5个核心API全部200 OK 返回真实数据
- 9个核心数据文件全部落盘（evolution/ 8个 + verification/ 3个）
- Shadow/Champion 按 (predictionDate, code, horizon) 严格对齐，无 code-only fallback
- forwardSamples 持久化 sampleKeys 防重复累计
- Cockpit 所有面板：数据缺失/API失败时显示原因而非空转

**当前 Shadow 状态** (2026-06-17):
- Champion: `v_2026-06-16` (bootstrap), params: stopLoss=-0.03, buyMinScore=45
- Shadow: `v_2026-06-17` (grid_search), cumulativeIC=0.377, forwardSamples=7, directionHitRate=42.86%
- Promotion blocked: directionHitRate(>52%), forwardSamples(≥100), evaluationDays(≥5)
- Leakage Audit: CLEAN (47 checks, 0 violations)
