# Francis Investment · A股量化交易系统 v3.4.9.4.1

Node.js 零外部依赖，阿里云 ECS `8.153.101.112:8765`。低价(≤20元)非创业板A股子策略，全自动日内交易+24/7自主学习进化+报告引擎。

## v3.4.9.4.1: Evidence Cohort Production Acceptance — 9 files changed.
- **P0-1 Manifest 路径统一**: prediction_ledger dataDir 统一为 report-engine/data 根目录。simfolio/mosaic_server/verification_runner 调用 readRunManifest/writeRunManifest 都传 DATA_ROOT，不传 data/simfolio。Manifest 文件落在 data 根而非 simfolio 子目录。
- **P0-2 Canonical 由 Scheduler 任务身份决定**: Scheduler 启动 full pipeline 时从 reason 提取 scheduledSlot（如 `scheduled_09:30`→`'09:30'`）。makeTradingDecisions 不再用 `new Date()` 判断 canonical。只有 `scanType='full'` + `scheduledSlot='09:30'` 创建 manifest；10:00/11:00/13:00 full + 全部 mid 都是 intraday。
- **P0-3 六层资格接入真实决策**: 每只候选股真实调用 `expectedReturn.meetsEvidenceThreshold(prediction, dataQualityPenalty)`，写入 executionCandidateEligible。`globalTradePermission = kernelDecision.canBuy && kernelDecision.maxBuysPerDay > 0`（非仅 verdict 字符串）。向后兼容旧调用方式（字符串 verdict）。
- **P0-4 Cockpit/API 只统计有效当前 cohort**: 旧 250 条 `invalid_schema_v3492` 单独显示为 `quarantinedCount`，不计入 active cohort 的任何字段。`actualBought` 从 `decision_events_YYYY-MM-DD.jsonl` 按 predictionId 汇总（非 prediction ledger 的 wasBought 字段）。API 返回 `canonicalCohortCount`/`intradayCount`/`quarantinedCount` 三个独立数字。
- **P0-5 测试与部署身份**: 测试开始前立即计算真实 data hash，全部结束后再计算一次——hash 一致。使用固定 fixture（无 Math.random）。真实测试覆盖 no-index/BLOCK/REDUCE/ALLOW/canonical-09:30/noncanonical-10:00。云端无 .git 时通过 `deploy_manifest.json` 记录 commit SHA + 每文件 hash。
- **Test**: v3.4.9.4 → 58 passed; v3.4.9.4.1 → 66 passed (local + cloud both).

## v3.4.9.4: Evidence Cohort Integrity — 8 files changed, 2 new modules.
- **research_cohort.js (NEW)**: Pure module — normalizeResearchFeatureSnapshot, computeResearchEligibility (pure), computeAllEligibility (6-field), buildResearchSnapshot (dedup by code, sort E[R] DESC→compositeScore DESC→code ASC, top 50), hashCandidateSet (DJB2), _hashNormalizedSnapshot
- **prediction_ledger.js (NEW)**: I/O module — buildLedgerEntry (full v3.4.9.4 fields: predictionId=`<runId>_<code>_T+3`, 6-field eligibility, data lineage), writeLedgerFile (idempotency + input drift detection), writeRunManifest/readRunManifest (daily_research_manifest), writeDecisionEvent (immutable decision_event JSONL)
- **Eligibility semantics**: schemaValid → predictionValid → researchEligible → executionCandidateEligible → globalTradePermission → executionEligible。wasBought 不在 prediction ledger 中改写——追加不可变 decision_event。
- **Canonical cohort**: 仅 09:30 full scan 是 canonical。daily_research_manifest_YYYY-MM-DD.json 跟踪 started→completed。Top-50 dedup by code（持最高 E[R]）。verification_runner 按 manifest.canonicalRunId 过滤 ledger entries。_countIndependentTradingDays 从 manifests 计数。
- **Model lineage**: modelVersionId 从 model_registry.getBaselineParams().versionId（非 config.version）。codeVersion/buildCommit/parameterSetHash/featureSchemaVersion/featureCoverage/dataCutoffAt/quoteSource/quoteAsOf 全量记入。
- **UI**: Cockpit "Research Cohort Integrity" 面板（Panel 10）显示 canonical runId/status/6-field counts/feature coverage/quarantined count。

v3.4.9.1: **真实生产闭环P0修复** — 6 files changed.
- **P0.1 统一研究快照**: buildResearchSnapshot()纯函数(Top-50按E[R]排序)在所有闸门之前调用, captureResearchSnapshot()每runId仅写一次, 删除了5处散落的_appendPredictionLedger调用(修复rankedTop50作用域bug→无账本落盘)
- **P0.2 每日唯一观测**: full scan→canonical=true, mid scan→canonical=false, _countIndependentTradingDays仅统计canonical日, mid scan不混入Kendall tau/升级证据
- **P0.3 Outcome身份修复**: verifyOneScan按predictionId匹配(非code), 缺kline数据写unavailable outcome(非静默continue), exitPrice从真实日线收盘价取(非公式反推), researchEligible需featureSnapshot+predictionId
- **P0.4 CI/统计真实口径**: _aggregateRankIC在independentDays<20时强制null, T+3 pending统计researchEligible(非executionEligible), verification_summary.json CI下界/上界为null时正确输出
- **P0.5 UI口径**: 午休/盘后quoteAge显示not_applicable, 非交易时段不显示行情过期BLOCK

v3.4.9: **可持续预测数据闭环** — 12 files changed.
- **A 预测账本**: 稳定runId (sessionId+scanType+counter), modelVersion从config读取(非硬编码'v3.4.7'), 5条执行路径各写一次幂等不重复
- **B 3-tier资格**: researchEligible(可研究/校准), executionEligible(可模拟买入), promotionEligible(可晋升); evidence_fail保留为researchEligible校准分层样本
- **C T+3结算重写**: verification_runner为outcome_ledger唯一写入者, outcome含entryPrice/exitPrice/benchmarkEntry/benchmarkExit/actualReturn_3d/benchmarkReturn/postCostNetExcess/所有成本, 缺数据标记unavailable不补0不跳过
- **D 统计指标**: Kendall tau-b替代naive Spearman (tie-aware), baseline对比(naive score/compositeScore≥60/equal-weight Top-N)必须模型τ>基线τ才"预测有效", <20日CI=null, outcome_ledger只读净超额收益
- **E 锁模型升级**: allowAutoPromotion=false, Shadow需≥1000 researchEligible样本+≥60独立交易日+τ CI下界>0+成本后收益>0+校准通过, 删除累计IC fallback, 禁止auto-demote, 生成review proposal JSON
- **F 行情独立服务**: market_quote_service.js每30s刷新4核心指数(Eastmoney→Tencent→Sina级联), 写market_quote_latest.json含quoteAge/sourceChain/fallbackSource/failureReason
- **G UI**: 预测结算面板显示runId+researchEligible+executionEligible+独立交易日, 空状态"预测采集尚未开始", 区分"行情过期"vs"核心指数不足"vs"市场风险"

v3.4.8: **Evidence + Visibility** — 7 files changed, ~200 lines net.
- **证据链A1**: model_registry 启动时 champion→baseline 迁移, 保留版本+参数+IC+评估天数+历史记录
- **证据链A2**: _aggregateRankIC bootstrap 改为 xorshift 伪随机数发生器, 每个replicate独立有放回抽样, <20天ci=null
- **证据链A3**: cockpit verification 统一读 overall.rankIC{mean/ci_lower/ci_upper/independentDays}+postCostNetExcessReturn
- **证据链A4**: 4项单元测试: champion迁移/bootstrap方差/<20天null CI/postCostNetExcess数值
- **可监督B1**: Cockpit Permissions 面板新增 Market Validation 行 (validCoreCount/sourceChain/lastQuote/reason)
- **可监督B2**: 新增"预测结算"面板: Top50/eligible/evaluationEligible/exclusionReason分布/T+3待结算/今日已结算
- **可监督B3**: Verification 面板: 独立交易日/20进度、Rank IC+CI、净超额收益; <20天显示"积累中不构成预测证据"
- **可监督B4**: Think-Tank Loop2 (北向权重): 数据不可用时显示degraded(非active/off), 基于真实nb.available

v3.4.7: **统计完整性修复 (P1.5)** — 5 files changed, ~150 lines net.
- **P0 严格结算**: targetDate精确匹配(非>), outcome写入前predictionId去重, prediction_ledger永久保留不可改写
- **P0 基准收益修复**: benchmarkReturn用目标日指数真实close(非股票价格), _getIndexCloseForDate三级回退(index_history→snapshot→null), benchmarkUnavailable/null时netExcessReturn=null
- **P1 统一验证统计**: verification_summary新增overall{rankIC{mean/ci_lower/ci_upper/independentDays/samples}, postCostNetExcessReturn}, dailyRankIC持久化到daily_rank_ic.json, block bootstrap跨日重抽样
- **P1 账本资格**: eligible调用真实meetsEvidenceThreshold(非废弃predictedDims), 新增marketDataValid/evaluationEligible/exclusionReason字段, <20日强制null CI
- **Bug修复**: _computeBootstrapCI死循环(j++→k++), expected_return.js DATA_DIR双重simfolio路径, getEffectiveWeights重复证据检查(移至tier)
- **P0 行情fail-closed**: 统一 validIndexQuote/validateIndices, 4消费者同源校验, 无效行情不覆写快照, API输出 validCoreCount/invalidIndices/sourceChain
- **P0 预测验证净化**: prediction_ledger 补全8字段 (scanId/asOf/targetDate/modelVersion/featureSnapshot/entryPrice/benchmarkPrice/eligible), Top50在买入筛选前记录, 交易日历结算, last_pipeline_result→legacy_untrusted, benchmarkPrice无效时跳过超额收益(不产生Infinity)
- **P1 Rank IC重做**: prediction_ledger源(非scan_records.top5), block bootstrap按交易日(非同日逐股重抽样), ≥20交易日门槛, CI下界>0才"预测有效", HS300/行业基准+扣除成本净收益
- **P1 动态权重fail-closed**: icLower/null→suggest_only(非shadow_allowed), getEffectiveWeights检查tier+证据完整, Champion→Baseline重命名(~35处), postCostPositive用实际净收益(非cumulativeIC代理), calibrationCheck用分桶校准
- **P2 交易真实性**: 买入+0.15%滑点, 卖出-0.15%滑点, 策略健康"8笔交易"→"风险收缩/样本不足"(非策略失效), delta≠0→active_effective, ThinkTank score=0→"已执行无影响", 策略边界精确描述

v3.4.5: **Data Bus Unification** — pipeline.fetchIndices 写入 market_snapshot_latest.json，loadLatestIndices 每指数独立 freshnessStatus (live/recorder/stale_daily)，IndexRecorder 新增创业板399006。MarketDirection 修复 (changePercent=null→warn)。decision_audit 补全 (dataQualityPenalty/strategyHealthSampleCount/version)。Think-tank circuit 更新。

v3.4.5+: **Trustworthy Verifiable Trader** — 11 files changed, +900 lines.
- **P0**: buildCommit追踪, silent catch→catch_failures.jsonl, Eastmoney price=0 bug修复, 每指数EM→Tencent→Sina级联, 2/3核心指数门槛, midTradeResult bug修复, expected_return_below_zero修复, strategy_health_reduce新增, 早盘昨日成交额替代日内筛选
- **P1**: 不可改写Prediction Ledger (Top50, 5个返回路径全量记录), Outcome Ledger (含基准/行业/扣除成本后净收益), Rank IC Bootstrap CI+十分位收益, 证据门槛 (conf≥0.60, ≥3维度, 数据质量正常)→advisoryOnly
- **P2**: 动态权重3级门控 (record_only<300/suggest_only<1000/shadow_allowed≥1000+IC显著+净超额为正), 一键回滚, classifyCausal (决策delta审计)

## Unified Decision Kernel (v3.4.5)

`mosaic/decision_kernel.js` — `computeDecision(context)` 是交易决策的单一真相来源。

### 6 Hard Blockers (优先级顺序):

| 优先级 | 门禁 | 阻断条件 |
|--------|------|----------|
| 0 | **marketSession** | 非交易时段 (closed/post_market/pre_market/lunch_break) |
| 1 | **marketData** | 交易时段 validCoreCount<2 (统一 validIndexQuote: price>0, prevClose>0, ts在交易窗口内, 5min新鲜度) |
| 2 | **circuitBreaker** | regime = panic / risk_off |
| 3 | **leakageAudit** | CRITICAL / DATA_LEAKAGE_RISK / NO_SAMPLES |
| 4 | **strategyHealth** | masterControl.verdict = BLOCK |
| 5 | **dataQuality** | penalty ≥ 7 |

### marketData gate (v3.4.6)

`validIndexQuote(ix, opts)` → `validateIndices(indices, opts)` → 全部消费者同源:
- `computeDecision`: 有效核心指数<2 → BLOCK + primaryBlocker=marketData + invalidIndices详情
- `_buildAllGateStates`: 门禁状态+validCoreCount/invalidIndices/sourceChain
- `writeMarketSnapshot`: 过滤无效报价，有效=0时不覆写上一份快照
- `loadLatestIndices`: 返回数据自带 freshnessStatus（live/recorder/stale_daily）
- API cockpit: `permissions.marketValidation{status, validCoreCount, invalidIndices[], lastValidQuoteAt, sourceChain}`

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
