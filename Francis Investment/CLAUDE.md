# Francis Investment CLAUDE.md

A股量化交易系统 + 跨市场分析引擎 + 历史复盘引擎 + 预测引擎 + **24/7进化引擎**。Node.js 零外部依赖，24/7 阿里云 ECS 运行。全自动采集+评分+模拟交易+盘后总结+美股→A股相关性追踪+历史复盘学习+市场周期识别+6维期望收益预测+动态权重学习+交易归因反馈+期望收益验证。**7条反馈闭环全部接通，历史复盘引擎统一，云端 v2.9.1 运行中。**

---

## v2.9.1 Bug 修复 (2026-06-12 下午) — 已部署云端 2026-06-12 13:28 CST

### 夜间回测 enriched=0 修复 — 因子经验数据终于开始累积

从 v2.7.0 进化引擎上线以来，夜间回测每次 `processed=159, enriched=0, newSamples=0`，所有 9 个因子命中率永远为 null 或 0，标记为 COLD。根因在 `night_backtest.js` 中。

**根因**：
`getKlinesFromCache(q.code, 60)` 传入 `minBars=60`，但 K 线缓存文件实际只有 6-12 条日线（`fetchKline()` 默认获取最近数据）。`klines.length (12) >= minBars (60)` 永远 false，返回 null → 没有任何配对能通过验证 → enriched=0。

**修复详情**：
- **`minBars` 从 60 降到 6**：新增 `MIN_KLINES = 6` 常量，匹配实际缓存大小（当日+T+5 只需 6条）
- **`getKlinesFromCache()` 增加兜底逻辑**：即使缓存不满足 minBars，≥2 条也返回（至少能做 T+1 验证）
- **`getKlinesFromCache()` 的 `minBars` 检查优化**：`Math.min(minBars, 120)` 防止不合理的大值
- **增加异步 fetchKline 框架**：预留了缓存不够时调用异步 `fetchKline` 获取更多历史数据的路径

**验证结果**：
- 修复前：`processed=159, enriched=0, newSamples=0` → 9 因子全 COLD
- 修复后：`processed=175, enriched=143, newSamples=403` → 因子统计有真实数据（H4 PE低估 T+1 命中率 51.7%，H7 低换手蓄力 69.6%）

**影响**：
- 防御门 `factorHealth` 维度不再看到 5/9 COLD → 拦截力度会随数据累积而减弱
- 动态权重学习（Loop 6）将获得真实因子绩效数据而非空值
- 预期 6/16 起 T+5 数据开始出现（最早记录 6/9 + 5 交易日）

### Loop 审计修复 (2026-06-14 下午) — 已部署云端 2026-06-14 13:17 CST

7 条反馈闭环全面审查，发现并修复 4 个问题：

**P0-1: 北向情绪数据丢失 Bug**
- `scheduler.js:1491` 调用 `fp.getNBSentimentRecord()` 但该函数不存在（正确名称 `getNBPerformance`）
- 安全调用 `?.` 不报错但永远返回 null → `_saveLastPipelineResult()` 中期望收益计算的 `nbPerf` 维度数据缺失
- 修复：`getNBSentimentRecord` → `getNBPerformance`

**P0-2: 版本号未同步**
- `mosaic_server.js:373` 写 `'2.9.0'` 但 v2.9.1 修复已在云端运行 → 改为 `'2.9.1'`

**P1-1: Unicode 符号残留（违反全项目无 emoji 规范）**
- `us_macro.js` 5 处：`⚠️⚡📊✅📈📉` → `[PANIC][ALERT][--][OK][UP][DN]`
- `composite.js` 7 行星号评级：`★★★★★` 等 → `[S][A+][A][B][C][D][E]`
- `evolution_scheduler.js` 注释星号：`★v2.7.0` → `[v2.7.0]`

**P1-2: Loop 5 归因覆盖扩展**
- `trade_attribution.js` `sectorAvoid` 触发条件从仅"硬止损"扩展为任何亏损 >5%
  - >8% 亏损 → 5 天避让 / 3-8% 亏损 → 3 天避让
  - 覆盖硬止损、软止损、移动止盈反转等所有类型亏损
- `factorWeightReduce` 阈值放宽：期望 >2%+实际 <-5% → 期望 >0%+实际 <-3%
  → 期望收益模型参数反馈更频繁触发

**影响**：
- 期望收益排名的北向情绪维度数据恢复（nbPerf 不再是 null）
- 软止损/移动止盈的亏损板块也会被避让（之前只有硬止损触发）
- 前端渲染不再出现 Unicode 渲染异常
- 版本号与代码实际功能一致

**额外改进**：
- `.gitignore` 新增 `klines/` 和 `weekend_archive/` 目录（运行时数据，不应提交）

---

## v2.9 关键变更 (2026-06-10 深夜) — 已部署云端 2026-06-11 19:22 CST

### 统一历史复盘引擎 — 6→2 模块合并
将分散的"历史数据学习"6 个模块合并为统一的 **历史复盘引擎**（`history_review.js` + `history_verifier.js`），消除功能重叠和调度碎片化。

**新文件**：
- `mosaic/analysis/history_review.js` — 主引擎 (~1800行)：`runDaily()`, `runWeekendDeep()`, `runWeekendDiscovery()`, `runWeekendTick(angle)`, `getReport(mode)`, `getPatterns()`
- `mosaic/analysis/history_verifier.js` — 精简验证 (~450行)：只验证有真实数据的维度，不制造虚假精度
- `report-engine/templates/history-review.js` — 统一前端面板 (Canvas 可视化): 仪表盘+雷达图+热力图+因子卡片

**24/7 节奏（新增 daily light + 周末持续发现）**：

| 时间 | 任务 | 耗时 |
|------|------|------|
| 每天 16:30 | **Daily Light**：因子验证 + 增量 combo + 1年快速相似度(top3) + 写 history_context.json | ~5-10s |
| 周六 10:30 | **Weekend Deep**：5年全量相似度(top10) + 危机预警 + 板块轮动 + 因子效能 + 周度验证 + 洞察 + 归档 | ~90s |
| 周六 14:00-23:00 | **持续发现 Tick**（每2小时，8个角度轮转）| ~10-15s/tick |
| 周日 09:00 | **Sunday Discovery**（不同参数重扫描）| ~60s |
| 周日 12:00-23:00 | **持续发现 Tick**（继续）| ~10-15s/tick |

**8个周末挖掘角度**（轮转，不重复）：
1. `multi_window` — 多窗口相似度 (window=10/30/40/60)
2. `sector_similarity` — 分行业相似度 (8个板块各自匹配)
3. `volume_patterns` — 纯量能聚类
4. `extreme_market_scenarios` — 极端行情专题
5. `cross_market_linkage` — 跨市场联动 (美股+上证联合特征)
6. `policy_cycle_match` — 政策周期匹配
7. `factor_decay_curves` — 因子衰减曲线 (T+1~T+20)
8. `covariance_structure` — 协方差结构 (8板块收益相关)

**前端统一**：
- 移除 `weekendAnalysis` nav item → 合并为 `historyReview` "历史复盘"
- 新面板 7 排 Canvas 可视化：状态栏→每日洞察→相似度雷达→危机仪表盘→板块热力图→因子网格→发现归档
- `history-review.js` 替代旧 `weekend-analysis.js` + `weekend-verification.js`

**API 变更**：
- **新增 7 个**: `/api/history/status`, `/report?mode=`, `/context`, `/verification?week=`, `/verification-history`, `/patterns`, `/discoveries?limit=`
- **废弃 7 个**: `/api/weekend-analysis/*` → 全部透传到新 API（向后兼容）

**Loop 1 增强**：`simfolio.js` 现在从 `history_context.json` 读取（优先），回退到 `weekend_context.json`。每日刷新替代仅周末更新。

**Bug 修复**：
- `app.js` 语法错误修复：删除了 `_deprecated_weekend_render()` 错误的函数声明（`function _deprecated_weekend_render(\n$contentArea` → `$contentArea.innerHTML` 不是合法参数名）
- `history_verifier.js` `_index.json` 格式兼容：旧格式为数组 `[{...}]`，新格式为对象 `{entries: [...]}` → 新增 `_readArchiveIndex()` 统一处理

**待清理**（v2.10，约1周后）：
- `mosaic/analysis/weekend_analyzer.js`, `weekend_verifier.js`
- `report-engine/templates/weekend-analysis.js`, `weekend-verification.js`
- `mosaic_server.js` 中旧 weekend-analysis 路由
- `config.js` 中 `WEEKEND_ANALYSIS` 和 `WEEKEND_VERIFICATION` 废弃块

### Simfolio 交易引擎紧急修复 — 停止买入问题
从 6/4 起每次 Pipeline/MidScan 完成后均抛出 `trade_error: "Cannot read properties of undefined (reading 'toFixed')"`，导致 5 个交易日零买入。

**根因**（3 层叠加）：
1. `buildGateResults()` `ddCurrent` 读取 `_drawdownLevel.currentDrawdown`（不存在）→ `undefined.toFixed()` 崩溃 ← **主因**
2. `checkSellSignal()` 使用未定义变量 `currentPrice`（应为 `stockData.price`）→ sell 信号计算失败
3. `portfolioInLoss` 在 pre-sell 持仓数上判断且阈值 0% 太严 → 持有 3 只微亏即锁死买入

**修复详情**：
- **新增 `safeFixed()` 工具函数**：所有 `.toFixed()` 调用统一加 null/NaN 守卫
- **`buildGateResults()` ddCurrent 修复**：改为读取 `pf._stats.maxDrawdown`（`_drawdownLevel` 只有 `{level, message, threshold}` 不含数值）
- **`checkSellSignal()` currentPrice 修复**：`currentPrice` → `stockData.price`
- **`portfolioInLoss` 优化**：使用 post-sell 持仓数（pending sells 扣减后），阈值从 0% 提高到 -5%
- **All `.toFixed()` 守卫**：`checkThinkTankGate()` 中 3 处 + `buildGateResults()` 中 6 处全部替换为 `safeFixed()`
- **Think-tank 防御门阈值 2→3**：2 个微弱信号不再拦截，需要实质性问题组合
- **`buildGateResults()` 新增 `portfolioInLoss` 门**：门链从 5 门扩展到 6 门（回撤→市场方向→跨市场熔断→**持仓浮亏**→思维舱防御→归因避让）
- **`scheduler.js` trade_error 日志增强**：增加 stack trace（前 3 行）
- **前端更新**：think-tank 门链 6 门 + 判决区浮亏 pill + trade_error 红色 banner；simfolio 面板浮亏保护 banner

### 修复验证（云端实测）
- `makeTradingDecisions()` 不再崩溃，所有 6 门正确评估
- `checkSellSignal()` 硬止损正确触发（含跳空缺口检测）
- 防御门 7/6 分正确拦截（4 COLD 因子+连续回撤+跨市场防御模式）
- 国电电力 (600795)：浮亏 -4.1%，继续持有，未触发止损

---

## v2.8 关键变更 (2026-06-10 上午) — 已部署云端 2026-06-11

### Bug 修复
- **trade_error 修复**：`simfolio.js` `makeTradingDecisions` 入口增加空 indices 提前返回 + `buildGateResults` 增加 `changePercent` 空值守卫，非交易时段不再崩溃
- **OLS 训练数据修复**：`dynamic_weights.js` `collectTrainingData` 优先读 `rawScores`（pipeline 已输出），替代旧 compositeScore 代理方式（消除多重共线性，Loop 6 从"练垃圾"变成真学习）
- **美股预测验证时间修复**：`evolution_scheduler.js` 15:10→16:10，等 16:00 correlation snapshot 写入后再验证（之前永远拿不到 actual data）

### 新回路接通
- **Loop 5 闭合**：`composite.js` 新增 `loadFalseSignalPatterns()` → 读取 self_reflection 假信号模式 → 匹配的触发组合自动扣分
- **Loop 7 增强**：`composite.js` 新增 `loadCycleFactorPreferences()` → 当前周期 preferred 因子+3 / avoid 因子-5
- **期望收益验证回路（新增）**：`expected_return.js` `verifyExpectedReturns()` → 每天 16:00 自动对比 5 天前预测 vs 实际 → `expected_return_verification.json`
- **期望收益→前端**：`scheduler.js` `_saveLastPipelineResult` 自动调用 `expected_return.rankByExpectedReturn()` → `last_pipeline_result.json` 包含 `expectedReturns`

### 24h 节奏修复
- **盘前准备**：`pre_market` 状态 09:00-09:30 加载隔夜美股+风险状态 → SSE 广播 `premarket_brief`
- **节假日感知**：`config.js` `HOLIDAYS_2026` + `scheduler.js` `_isHoliday()` → 节假日不跑 pipeline/交易
- **进化任务宽窗口**：5 分钟→30 分钟 + 追赶机制 → 服务器重启后任务不再永久丢失
- **evo tick 优化**：每次 tick→每 5 分钟检查一次 → 每天减少 ~48,000 次冗余调度

### 代码质量
- **预评分去重**：提取 `preScoreStocks()` 到 `pipeline.js` → `scheduler.js` `_runMidDayScan` 复用
- **事件日志完善**：新增 `premarket_brief`/`dynamic_weights_updated`/各类 error 的事件类型映射和中文格式

### 新 API
- `GET /api/predict/expected-returns` — 最新 pipeline E[R5d] 排名
- `GET /api/predict/expected-return-verification` — 历史期望收益验证（方向命中率+平均误差）

---

## 云端部署

| 项目 | 详情 |
|------|------|
| IP / URL | `8.153.101.112:8765` |
| 系统 | Ubuntu 22.04, 2 vCPU / 2 GiB, CST (Asia/Shanghai) |
| 进程 | systemd `mosaic.service` — `Restart=always`, `RestartSec=10` |
| 安全组 | 入方向 TCP 8765 开放 |

### 日常运维命令

```bash
# 部署代码到云端（批量）
scp "C:/Users/anzhe/FIRSTCC/Francis Investment/<path>" "root@8.153.101.112:/root/FIRSTCC/Francis Investment/<path>"
# 后端文件部署后需重启，前端文件无需重启
ssh root@8.153.101.112 "systemctl restart mosaic"

# 查看运行状态
ssh root@8.153.101.112 "systemctl status mosaic --no-pager | head -10"
ssh root@8.153.101.112 "journalctl -u mosaic --no-pager -n 20"

# 验证核心 API
curl -s http://8.153.101.112:8765/api/status
curl -s http://8.153.101.112:8765/api/simfolio/status
curl -s http://8.153.101.112:8765/api/market/cycle
curl -s http://8.153.101.112:8765/api/cross-market/analysis
curl -s http://8.153.101.112:8765/api/factors/performance
curl -s http://8.153.101.112:8765/api/predict/factor-performance
curl -s http://8.153.101.112:8765/api/predict/dynamic-weights
curl -s http://8.153.101.112:8765/api/pipeline/last-result
curl -s http://8.153.101.112:8765/api/history/status
curl -s http://8.153.101.112:8765/api/history/report?mode=full
curl -s http://8.153.101.112:8765/api/history/context
curl -s http://8.153.101.112:8765/api/history/patterns
curl -s http://8.153.101.112:8765/api/history/verification-history
curl -s http://8.153.101.112:8765/api/history/discoveries?limit=5

# 手动触发相关性快照
ssh root@8.153.101.112 "cd '/root/FIRSTCC/Francis Investment' && node -e \"
  const cm = require('./mosaic/analysis/cross_market');
  cm.recordDailyCorrelationSnapshot(new Date().toISOString().slice(0,10)).then(h => console.log('Done:', h.length, 'points'));
\""
```

---

## 用户档案

- **称呼**：Francis | **总资产**：~14.5万元（真实持仓，非 Simfolio）
- **偏好**：机器人/科技板块，20元以下低位潜力股，政策驱动型机会
- **跟踪板块**：机器人/具身智能、创新药/AI医疗、半导体/AI算力、商业航天、固态电池/储能、有色金属/稀土、新型电力基建、军工

---

## 项目结构

```
Francis Investment/
├── mosaic_server.js             # ★ HTTP 主服务器 (0.0.0.0:8765) — 50+ API 路由
├── deploy.sh
├── mosaic/                      # ★ 量化引擎
│   ├── config.js                #   唯一配置入口（阈值/权重/时间表/回撤门/建仓节奏/因子诊断/预测引擎开关+EVOLUTION段）
│   ├── scheduler.js             #   ★ 状态机调度器：tick→状态转换→Pipeline→美股采集→16:00总结→动态权重→周期因子矩阵→进化任务调度（8任务+v2.7.0持久化+手动触发）
│   ├── pipeline.js              #   主流程编排（EventEmitter）— 8维预评分+SSE实时广播+两融数据
│   ├── simfolio.js              #   模拟交易引擎（分层仓位+回撤门+建仓节奏+思维舱防御门+市场周期仓位+T+1风控+期望收益排名+归因反馈+避让板块）
│   ├── collectors/              #   数据采集
│   │   ├── market_data.js       #   A股行情（东财主力+腾讯备选+新浪三级备选）+ K线（腾讯主力+东财备选+5分钟磁盘缓存+5s超时）
│   │   ├── us_market.js         #   美股实时监控（30只ETF+指数）
│   │   ├── north_bound.js       #   北向资金流向+情绪计算
│   │   ├── capital_flow.js      #   板块资金流
│   │   ├── dragon_tiger.js      #   龙虎榜+机构席位
│   │   ├── index_recorder.js    #   指数分钟线记录器
│   │   ├── margin_data.js       #   两融数据（代理指标）
│   │   └── news_collector.js    #   财经新闻采集+7级情感分析
│   ├── factors/                 #   评分引擎
│   │   ├── hidden_signals.js    #   ★ H1-H9 隐藏因子 → computeHiddenSignals()
│   │   └── composite.js         #   ★ 5维综合评分 + 北向动态权重 + 两融情绪 + LHB增强 + 板块相对评分 + 动态权重学习 + 因子组合协同/冲突调整 [v2.7.0]
│   ├── evolution/               #   ★ 24/7 自主学习进化引擎（v2.7.0）
│   │   ├── night_backtest.js    #   夜间历史回测→K线精确验证因子信号命中率
│   │   ├── self_reflection.js   #   自我质疑循环→持仓诊断+错过回顾+假信号模式
│   │   ├── us_as_predict.js     #   美股→A股预测+验证闭环→方向命中率追踪
│   │   ├── weight_grid_search.js # 动态权重超参数网格搜索→最优lookback+α
│   │   ├── weekend_factor_mining.js # 周末因子组合协同效应+板块×因子交叉挖掘
│   │   └── evolution_scheduler.js   # ★ 进化任务统一调度器（8任务:02/03/04/05:30/15:10/20/六10/日14）+持久化+手动触发
│   ├── predict/                 #   ★ 预测引擎（v2.5.0）
│   │   ├── stock_predictor.js   #   个股级别因子命中率追踪（H1-H9触发后实际个股收益，含rawScores）[v2.7.0: 优先读取夜间回测验证数据]
│   │   ├── expected_return.js   #   6维期望5日收益率计算（替代硬阈值买入逻辑）
│   │   ├── dynamic_weights.js   #   OLS滚动回归自动调整5维评分权重 [v2.7.0: 读取网格搜索最优lookback+α]
│   │   ├── sector_leadlag.js    #   板块间时移相关性→领先/滞后矩阵+轮动预测
│   │   ├── cycle_factor_matrix.js # 市场周期×因子有效性热力图
│   │   └── trade_attribution.js #   交易归因→参数反馈闭环
│   └── analysis/                #   盘后+历史复盘
│       ├── quant_report.js      #   交易归因+新闻预测
│       ├── market_cycle.js      #   ★ A股周期识别（MA排列+量能+宽度→5档+仓位建议）
│       ├── cross_market.js      #   ★ 跨市场相关性引擎 + 风险状态机（5档）+ getCrossMarketWeightMultiplier() [v2.7.0]
│       ├── factor_performance.js #   ★ 因子绩效（命中率/平均收益/趋势 + 北向绩效）
│       ├── history_review.js    #   ★★ 统一历史复盘引擎 v2.9（daily light + weekend deep + 8角度周末持续发现）
│       ├── history_verifier.js  #   ★ 历史复盘验证 v2.9（只验证有真实数据的维度，~450行）
│       ├── knowledge_base.js    #   因子追踪知识库（v2.9: 移除 factorCombo/sectorFlow 提取）
│       ├── weekend_analyzer.js  #   [DEPRECATED v2.9] 旧周末分析引擎 — 已合并到 history_review.js
│       ├── weekend_verifier.js  #   [DEPRECATED v2.9] 旧周末验证引擎 — 已合并到 history_verifier.js
│       └── us_macro.js          #   美股隔夜总结生成器
├── report-engine/               # ★ 前端（纯静态）
│   ├── index.html               #   主仪表板（9 section + 日历 + 侧边栏）
│   ├── think-tank.html          #   ★ AI 思考舱（SSE实时+4卡风险中枢+因子组合+维度分解）
│   ├── app.js                   #   ★ 前端控制器（section导航+异步渲染+移动端+情绪指标+持仓健康度+预测引擎渲染）
│   ├── style.css                #   仪表板样式（桌面+移动端≤720px+预测引擎样式）
│   ├── kline.js                 #   K线图绘制
│   ├── renderer.js              #   历史报告渲染器
│   ├── templates/               #   UI模板
│   │   ├── predict.js           #   ★ 预测引擎5面板仪表板（排名/因子矩阵/权重/轮动/热力图）
│   │   ├── simfolio.js          #   模拟交易面板（含持仓健康度+回撤指示器）
│   │   ├── cross-market.js      #   跨市场分析面板（含市场周期仪表板）
│   │   ├── us-market.js         #   美股玻璃拟态面板
│   │   ├── history-review.js    #   ★★ 历史复盘统一仪表板 v2.9（Canvas: 仪表盘+雷达+热力图+因子网格）
│   │   ├── weekend-analysis.js  #   [DEPRECATED v2.9] 旧周末分析面板
│   │   ├── weekend-verification.js # [DEPRECATED v2.9] 旧周末验证面板
│   │   ├── css.js               #   CSS 渲染函数
│   │   └── ...                  #   其他历史模板
│   └── data/
│       ├── simfolio/            #   ★ 运行时：portfolio.json + factor_performance.json + weekend_context.json + last_pipeline_result.json + dynamic_weights.json + stock_factor_performance.json + cycle_factor_matrix.json + sector_leadlag.json + trade_attribution.json + attribution_adjustments.json + last_gate_state.json
│       ├── klines/              #   ★ K线缓存：<code>.json (TTL 5分钟)
│       ├── us_market/           #   运行时：us_latest.json + correlation_history.json + margin_cache.json
│       ├── market_history/      #   历史K线：indices/sh000001.json + sz399001.json + sz399006.json
│       ├── events/              #   每日事件日志 YYYY-MM-DD.json
│       ├── summaries/           #   每日盘后总结 YYYY-MM-DD.json
│       ├── knowledge_base/      #   AI 知识库
│       └── 2026-05-*/           #   历史报告数据
└── pomodoro/                    # Pomodoro timer (独立项目)
```

---

## 核心架构

### 调度器（scheduler.js）— 24/7 自动运行

状态机：`closed → pre_market → morning_session → lunch_break → afternoon_session → post_market → closed`

- 活跃时段 tick 每 20s，空闲时段每 300s
- IndexRecorder：交易时段 60s 记录指数分钟线，自动清理 7 天前
- 美股采集：16:00-06:00 CST 采集 30 只符号 → `us_latest.json`，SSE 广播
- 美股隔夜总结：凌晨 5:00 CST → `us_close_YYYY-MM-DD.json`
- `_runDailySummary()`：16:00 异步 fire-and-forget → 盘后总结 + 相关性快照 + 因子绩效追踪 + **动态权重更新 + 周期×因子矩阵更新**
- `_runFullPipeline()` 和 `_runMidDayScan()`：每次扫描完成后记录个股因子信号 → `stock_factor_performance.json`
- **历史复盘引擎 v2.9**：每天 16:30 daily light (~5-10s) + 周六 10:30 deep (~90s) + 周六/周日每2小时 tick discovery (8角度轮转) + 周日 09:00 discovery → `history_context.json`

### Pipeline 执行流程（pipeline.js）

1. 获取全 A 股列表（Eastmoney push2 批量）
2. 过滤器（价格≤20/成交额>1亿/PE≤40/排除ST和创业板）
3. 计算隐藏因子 H1-H9 + 并行获取 LHB/板块资金流/北向/两融
4. 8 维预评分排序 → top 80 进入深析
5. 逐只深析（双源基本面 + K线 + 资金流历史）→ 5 维综合评分（支持动态权重）
6. 排序/评级/SSE 广播 + `scan_complete` + `factor_perf`
7. 记录个股因子信号 → 预测引擎数据累积

### Simfolio — 交易日连续

- 初始 ¥100,000，T+1，持仓上限 5 只，单只 ≤30%
- **分层仓位**：强买入（期望收益>2%+置信度≥50%）→ 15-25%现金 / 普通买入 → 8-12%
- **回撤管理**：每次 NAV 更新自动计算 maxDrawdown，3 档回撤门：
  - warn(-5%) → 日志告警 / restrict(-8%) → 每日最多 1 只买入 / halt(-10%) → 暂停所有买入
- **建仓节奏**：maxBuysPerDay=2 / 已持 3+只时降为 1 / 同日内买入间隔 30 分钟
- **动态阈值**：连续 2 天 TOP1 评分<65 → 最低买入分从 50 提高到 60
- **市场周期仓位**：market_cycle.js 自动调整最大持仓数（牛市 5 → 熊市 1-2）
- **多级风控门**（按优先级，v2.8.1 扩展至 6 门）：回撤门 → 市场方向门（上证跌>0.5%禁止买） → 跨市场熔断 → **持仓浮亏门（v2.8.1 新增）** → 思维舱防御门 → **归因避让板块**
- 卖出：硬止损 -8% / 软止损 评分<35 / 移动止盈
- T+1：当天买入的股票只有硬止损可卖出
- **期望收益排名**（config.PREDICTION.useExpectedReturnRanking=true）：6维期望5日收益替代旧硬阈值

### 预测引擎（v2.5.0）— 6 模块

| 模块 | 文件 | 功能 |
|------|------|------|
| 个股因子追踪 | `predict/stock_predictor.js` | 记录每只股票触发因子后的实际收益，计算每个因子在个股级别的预测能力 |
| 期望收益计算 | `predict/expected_return.js` | 6维加权：因子组合(30%)+板块流向(20%)+市场周期(15%)+北向情绪(15%)+历史相似度(10%)+评分百分位(10%) |
| 动态权重学习 | `predict/dynamic_weights.js` | 每日盘后 OLS 回归，自动调整 5 维评分权重（限 5%-50%，R²<0.05 回退默认） |
| 板块轮动预测 | `predict/sector_leadlag.js` | 时移 Pearson 相关性→领先/滞后矩阵→预测板块轮动 |
| 周期×因子矩阵 | `predict/cycle_factor_matrix.js` | 5 周期×9 因子命中率热力图→当前周期推荐/避免因子 |
| 交易归因反馈 | `predict/trade_attribution.js` | 每笔卖出后分析盈亏原因→生成板块避让/因子降权→反馈到下次交易 |

### 24/7 自主学习进化引擎（v2.7.0）— 8 个夜间/周末任务

利用系统每天 12-14 小时的空闲窗口执行自主学习任务，输出通过闭环回馈到主 Pipeline：

| 模块 | 时间 | 文件 | 功能 | 闭环回馈 |
|------|------|------|------|----------|
| 夜间历史回测 | 02:00 |  | 用K线真实收盘价精确验证历史因子信号→批量增强  |  优先读取  数据（替代粗糙  近似） |
| 权重网格搜索 | 03:00 |  | 尝试 5×5 参数组合（lookback×EMA α）→样本外验证→保存最优参数 |  读取  自动替换默认 lookback/α |
| **参数推送验证** ★v2.7.0 | 04:00 |  | 验证网格搜索最优参数仍有效+检查动态权重是否生效+美股预测准确率状态 | 检测参数漂移→标记需要重新搜索 |
| 美股→A股预测生成 | 05:30 |  | 美股收盘后生成 A股板块方向预测（US ETF R × 实时涨跌） | — |
| 美股→A股预测验证 | 16:10 (v2.8 修复) |  | A股收盘后验证预测方向命中率→追踪历史准确率 |  读取准确率自动调整跨市场信号权重乘数 (0.3~1.0) |
| 自我质疑循环 | 20:00 |  | 持仓健康诊断+错过机会回顾+假信号模式挖掘 | — |
| 因子组合挖掘 | 周六 10:00 |  | 因子协同效应（P(盈利|Hi∧Hj)）+板块×因子交叉效应 |  读取 →协同对加成/冲突对降权 |
| **进化周报** ★v2.7.0 | 周日 14:00 |  | 回溯一周任务执行+因子绩效趋势+美股预测准确率+最优参数+因子组合 | — |

**新增 API**（v2.7.0 扩展至 10 个数据端点 + 7 个手动触发端点）：
- **数据查询**：（含 ） /  /  ★new /  /  ★new /  / 
- **手动触发**（POST）： /  ★new /  ★new /  ★new /  ★new /  ★new /  ★new

**v2.7.0 关键改进**：
- **进化结果闭环接入主 Pipeline**：夜间回测→stock_predictor 优先 / 网格搜索→dynamic_weights 参数 / 因子组合→composite 信号加权 / 美股准确率→cross_market 权重
- **任务历史持久化**：`evo_task_history.json` 保存最近 200 条，服务器重启不丢失
- **运行进度追踪**：`runningProgress` 字段实时反馈任务中间状态
- **新增时间窗口**：04:00 参数推送验证 + 周日 14:00 进化周报
- **UI 全面升级**（think-tank Row 6）：3 列 6 卡片（夜间回测含迷你柱状/网格搜索含 top3/自我质疑/美股预测含 sparkline 迷你折线/因子组合含协同冲突对/任务时间表含 8 任务+运行中绿色闪烁 dot）
- **全局 `runAllNow()`**：一键手动触发全部进化任务（API + 调度器均支持）

### 反馈闭环（7 条"学习回路"）v5 — 三层数据流

每条回路现在提供 **输入→处理→输出** 三层数据，不只是 boolean 状态：

| # | 回路 | 输入 | 处理 | 输出 | 状态 |
|---|------|------|------|------|------|
| **1** | 历史复盘→分析引擎 v2.9 | 历史复盘报告 daily/deep（generatedAt/validUntil/insightCount/discoveries）| 识别关键信号（crossMarketRisk/sectorPreference）→ daily 刷新 | 板块偏好注入+跨市场防御 | ✅ 活跃 (daily refreshed) |
| **2** | 北向资金→评分降权 | 北向情绪历史（signalDays/totalDays） | 方向命中率计算（hitRate→HOT/COLD/stable） | 动态调整composite北向权重±3~±5 | ✅ 活跃 |
| **3** | 知识库→交易决策 | 历史日分析存档（kbDays/factorTrackerDays） | 追踪高效因子（activeFactors/9 + TOP因子列表） | 冷因子检测→防御门knowledgeBase维度分数 | ✅ 活跃 |
| **4** | 思考舱→防御门 | 6维风控维度（因子健康/持仓压力/连续回撤/跨市场/信号背离/知识库） | 综合评分（totalScore/threshold/blocked/dimScores） | 防御触发/通过→决定是否拦截买入 | ✅ 活跃 |
| **5** | 交易→归因→参数反馈 | 已完成交易记录（totalAttributions/recentCount） | 归因分析 → sector avoid list + false signal pattern → composite 惩罚 (v2.8) | 生成板块避让+因子降权→反馈下次交易 | ✅ 活跃 (v2.8 闭合) |
| **6** | 动态权重→评分适应 | OLS训练数据（rawScores+sampleCount） | OLS回归（R²/threshold/activeDimensions）→ 优先使用 rawScores (v2.8) | 学习生效/回退默认权重 | ✅ 活跃 (v2.8 修复) |
| **7** | 进化引擎→全回路 | 7个进化模块 + cycle_factor → composite (v2.8) + expected_return verification (v2.8) | 空闲窗口自动调度（30分宽窗口+追赶机制，v2.8） | 所有回路数据质量增强 + 最优参数反馈 | ✅ 活跃 |

### 隐藏因子（hidden_signals.js）

| ID | 名称 | 类别 | 含义 |
|----|------|------|------|
| H1 | 缩量止跌 | 技术 | 成交量萎缩+跌幅收窄=卖盘枯竭 |
| H2 | 底部放量 | 技术 | 大跌+巨量=恐慌抛售 |
| H3 | 逆势抗跌 | 市场 | 大盘跌但个股涨=相对强度 |
| H4 | PE低估 | 基本面 | PE<12+低负债+营收增长 |
| H5 | 高ROE低PB | 基本面 | ROE>12%+PB<2=格雷厄姆式价值 |
| H6 | 现金流健康 | 基本面 | OCF为正+低负债+高净利率 |
| H7 | 低换手蓄力 | 技术 | 换手<1%+波动<2%=筹码锁定 |
| H8 | 短期反转 | 技术 | 5日跌幅大+今日止跌=反弹动能 |
| H9 | 量价背离 | 技术 | 量缩价稳=吸筹信号 |

### 综合评分（composite.js）

5 维加权：fundamental(25%) + technical(15%) + hidden(20%) + capital_flow(25%) + event(15%)
- 支持动态权重覆盖（`dynamic_weights.json` 存在且 R²≥0.05 时自动启用）
- 无详细财务数据时：fundamental→10%，总分上限 65
- 复合调整：北向情绪 ±3-5（COLD 时 ×0.33）+ 两融 ±2-3 + 板块相对评分 ±3-5 + LHB 增强 ±3-5 + COLD 因子惩罚 -3/信号
- 冷因子实时惩罚：历史命中率<40% 的因子触发时扣 3-8 分
- **v2.8 新增**：周期偏好调整（cycle_factor_matrix preferred +3/avoid -5）+ 假信号模式惩罚（self_reflection lossRate penalty）+ 期望收益验证回路（E[R5d] vs actual）
- **v2.8 修复**：OLS 训练数据改为优先读取 rawScores（之前用 compositeScore 代理导致多重共线性）

### 市场周期识别（market_cycle.js）

均线排列(40%) + 成交量趋势(30%) + 市场宽度(20日高低位 30%) → 评分 0-100 → 5 档周期：
- 牛市(≥75)→5 只 / 震荡偏多(≥60)→4 只 / 震荡(≥40)→3 只 / 震荡偏空(≥25)→2 只 / 熊市(<25)→1 只

### 跨市场相关性（cross_market.js）

- **风险状态机**：VXX(40%) + UUP(30%) + TLT(30%) → -65~+65 → 5 档（panic/risk_off/neutral/slightly_bullish/risk_on）
- **相关性矩阵**：8 对 US ETF→A 股板块映射（Pearson R），每日 16:00 快照，保留 60 个交易日
- **v2.8 UI 增强** (2026-06-09)：
  - Risk Timeline — 5 日风险得分趋势 sparkline（Canvas，高 DPI 适配）
  - Correlation Row — 增加 latestUSChange 列（实时 ETF 涨跌幅）+ 趋势标签
  - Sector Outlook — 按 impact strength 排序（strong→weak，同档按 |R| 降序）
  - Risk Gauge Canvas — devicePixelRatio 高清适配（640×340 内部分辨率→320×170 显示）
  - 所有 Unicode 箭头/HTML entity emoji 已替换为纯文本标签
  - **注意**：Risk Gauge 和 Risk Timeline 依赖 `execInlineScripts()` 执行内联 `<script>`（见已知陷阱）

### US Market 美股面板（us_market.js）

- **核心指数**：SPY/QQQ/DIA/IWM 4 格
- **宏观指标**：VXX/UUP/TLT 含解读文字
- **中概股 ADR**：横向滚动条
- **板块映射 ETF→A股**：SMH/XBI/TAN/ARKQ/XLE/XLF/XAR
- **情绪标杆**：NVDA/AAPL/TSLA/MSFT/GOOGL
- **隔夜总结**：情绪评分+板块预判
- **数据修复** (2026-06-09)：修复 Sina API `prevClose` 字段从 `fields[30]` 改为 `fields[26]`（之前误取为成交量）

---

## 前端架构

### Section 导航

**桌面端**：左侧 sidebar 玻璃按钮（毛玻璃 + 渐变小圆点 + 金色激活态）
**移动端 (≤720px)**：顶部 sticky bar — date-strip + section-tabs，可左右滑动

| ID | 标签 | 特色 | 渲染方式 |
|----|------|------|----------|
| `simfolio` | 模拟交易 | ★ 实时面板：资产卡片+回撤等级+持仓健康度+交易动态+情绪指标+状态栏(市场阶段+扫描信息) | 直接 DOM 渲染 |
| `newsPolicy` | 时政要点 | 新闻+7 级情感标签+AI 影响预测（16:00 后） | 异步 API 加载 |
| `tradingReport` | 交易分析与报告 | 归因+预测+因子总结+知识库（16:00 后） | 异步 API 加载 |
| `usMarket` | 海外市场 | 美股实时快照（玻璃拟态白主题） | 直接 DOM 渲染 |
| `predict` | 预测引擎 | ★ 5 面板仪表板（排名/因子矩阵/权重/轮动/热力图） | 直接 DOM 渲染 |
| `crossMarket` | 跨市场分析 | ★ 风险仪表盘+市场周期+相关性矩阵+分层仓位 | 直接 DOM 渲染 |
| `historyReview` | 历史复盘 | ★★ v2.9 统一面板：仪表盘+雷达图+危机仪表盘+板块热力图+因子网格+发现归档 | 直接 DOM 渲染 (Canvas) |
| `weekendAnalysis` | [v2.9 废弃] | 合并到 historyReview，函数透传不再单独渲染 | — |

**关键**：simfolio/usMarket/predict/crossMarket/historyReview/weekendAnalysis 使用直接 DOM 渲染模式（renderXxxDirect），不走 iframe。它们在 `renderCurrentSection()` 中有专用路由。

**风格规范**：全项目不再使用 emoji，所有标题/标签/状态指示器使用纯文本或 CSS 样式替代。

### 预测引擎仪表板（predict.js）

5 张卡片面板（始终渲染，空状态有友好提示）：
1. **[买入] 候选排名**：Pipeline 最近扫描 Top5，显示评分等级 [S/A/B/C/D] + 信号 pills + E[R5d] + 置信度%
2. **[因子] 个股因子预测力**：H1-H9 各因子在个股级别的命中率/平均收益（需≥3天扫描记录）；空状态显示自动累积进度
3. **[权重] 动态权重**：5 维评分权重柱状图 + R² + 学习信息来源
4. **[轮动] 板块轮动预测**：领先/滞后关系矩阵 + 轮动信号
5. **[周期] 周期×因子有效性**：5 周期×9 因子命中率热力图 + 当前周期推荐/避免因子；空状态说明联动数据源

**v2.5.1 修复** (2026-06-09)：Pipeline top5 无 signals → 修复 `pipeline.js` top5 映射增加 `signals: hiddenSignals.map(...)` + scheduler `_savePipelineResult` 兼容 `hiddenSignals`

### 新增 UI 组件（v2.4.x+）

- **持仓健康度卡片**（Simfolio 面板）：每只持仓一张卡 — 盈亏%/持仓天数/距离止损进度条/推荐操作标签
- **回撤等级指示器**（Simfolio 统计卡片）：[正常]/[提醒]/[限仓]/[熔断] 四色标签
- **市场周期仪表盘**（跨市场分析顶部）：5 档周期标签+置信度+仓位上限+均线/量能/宽度三维分解
- **因子诊断告警**（Simfolio 面板）：静默因子/信号多样性不足时显示黄色横幅

### Think-Tank 页面（think-tank.html）v5

独立页面，白色金融终端风格，**6 行决策指挥中心布局** (v2.7.0 expanded)。

**桌面端布局**：
- **Header**：状态指示灯 + 市场状态标签 + 实时时钟
- **Row 1**：大盘指数分时图（Canvas 三指数涨跌幅对比 — 上证/深证/创业板，直接 Canvas 绘制不依赖 kline.js）+ AI 当前判断面板（决策徽章 + 决策链路摘要 + **回路影响 pills** + 持仓概览）+ **风控门链路**（5 门垂直链式，阻断处红色光晕动画，后续门自动灰化，防御门展开显示6维评分详情）
- **Row 2**：精选候选股横向滚动卡片 — 迷你日 K 线（`drawMiniKline()` + shimmer 骨架 4s 自动降级为文字）+ **SABCD 评级**（不显示具体分数）+ 触发因子 pills + 决策标签
- **Row 3**：因子信号雷达（Canvas 9 轴）+ 动态权重（CSS DOM bars，非 Canvas）
- **Row 4**：**学习回路总览 v5** — SVG 8 节点 Pipeline 流程图 + **7 条**贝塞尔弧线（Loop 7 新增：进化引擎→全回路，金色弧线，从"进化"节点底部弧回"归因"节点 arcBelow:64；活跃弧线 glow filter + 流动点动画 + hover 三层 tooltip: 输入/处理/输出），图例可点击高亮对应弧线
- **Row 5**：AI 思考时间线（紧凑行式 + 分类筛选按钮：扫描/交易/风控/系统）+ 事件记录（可切换日期）
- **Row 6**：**★ 进化引擎面板 v2.7.0**（6 卡片 3 列：夜间回测结果+因子命中率标签 / 自我质疑(持仓诊断+错过回顾+假信号模式) / 美股→A股预测准确率+评估建议 / 进化任务时间表(6任务实时状态)）；进化周报/参数推送 — 每 5 分钟自动刷新；迷你柱状图+sparkline折线图+运行中绿色闪烁dot）

**移动端 (≤720px)**：全部双列变单列，顺序不变。

**Simfolio 状态栏**：白色卡片风格，绿色/琥珀色/灰色圆点指示市场状态，显示市场阶段 + 扫描状态 + 上次扫描时间，已移除倒计时数字。

**核心创新 (v5)**：
- **学习回路 SVG 三层数据流**：每条回路的 tooltip 展示 IN输入/PR处理/OUT输出 三层（如 Loop 1: "周末分析报告(3条insight)"->"跨市场风险+板块偏好"->"板块偏好注入+跨市场防御激活"）
- **回路弧线流动动画**：活跃弧线虚线流动(`flowDash`, 0.8s)+辉光滤镜，降级弧线慢速流动(2s)，离线弧线静态灰色。3条上方长距弧(Loop 1/2/3分别 arcAbove:52/30/74)+2条下方短距弧(Loop 4/5分别 arcBelow:28/46)+1条自环(Loop 6 arcAbove:88)+1条底部外环(Loop 7 arcBelow:64)，避免重叠
- **Loop 7 (进化引擎→全回路)**：金色弧线 `#b8942c`，8 节点 Pipeline（采集→因子→评分→候选→门控→交易→归因→**进化**），状态联动 `evolution_scheduler` 实时任务执行记录
- **进化引擎 UI 面板 (Row 6)**：4 张卡片展示夜间回测、自我质疑、美股预测准确率、任务时间表，每 5 分钟自动刷新，空数据友好提示
- **Verdict 回路影响 pills**：决策徽章下方显示 7 色标签（含进化引擎状态）
- **风控门防御门6维详情**：点击防御门展开显示6维评分明细（因子健康/持仓压力/连续回撤/跨市场/信号背离/知识库 各项分数+详情）
- **图例交互**：点击图例项高亮对应弧线（线宽加大 0.6s 后恢复）
- **评分字母化**：决策链路显示"最高 B (66分)"等评级+分数格式
- **全项目 Emoji 清理**：所有前端/后端文件已移除 emoji，改用纯文本标签
- **v2.7.0 闭环**：夜回测→stock_predictor / 网格搜索→dynamic_weights / 因子组合→composite / 美股准确率→cross_market — 进化输出接入主Pipeline
- **v2.7.0 UI 升级**：6卡片3列（迷你柱状+sparkline+闪烁dot+top3），2新卡片（网格搜索/因子组合），8任务时间表
- **v2.7.0 新任务+API**：04:00参数推送+周日14:00进化周报，10个数据端点+7个手动触发端点，任务历史持久化
- **格式统一**：verdict-chain(9px)/loop-impact-pill(8px)/pos-summary(9px)/gate-label(10px)/gate-status(8px) 全页面字号行高统一

**K 线加载**：候选股通过 `/api/think-tank/candidate-kline?codes=` 批量获取（Tencent API 主源 + Eastmoney 备选，5s 超时，5 分钟磁盘缓存 `data/klines/<code>.json`），前端 `drawMiniKline()` 直接 Canvas 绘制。加载失败 4s 后 shimmer 自动降级为"暂无K线数据"。

**SSE 实时流**：`heartbeat`→`scan_start`→`stock`→`scan_complete`→`trade`→`decision`→`factor_perf`→`position`→`alert`→`daily_events`

**⚠ 关键约束**：
- **大盘 K 线用 Canvas 分时图，不依赖 kline.js**：`drawIndexChart()` 直接绘制三指数% 涨跌幅对比，无需多日数据
- **候选股 mini K 线依赖 `kline.js` 的 `drawMiniKline()`**（纯 Canvas 绘制，无 innerHTML script 问题）
- **`market_data.js` 的 `fetchKline` 采用 GBK 解码**：`new TextDecoder('gbk')`，Tencent API 返回 UTF-8 但函数统一用 GBK
- **K 线缓存是核心依赖**：`data/klines/` 目录必须存在，否则每次请求都走网络
- **Loop 数据源**：`/api/think-tank/decision-status` 的 `predictionHealth.loops` 现在返回每回路 `{status, input, process, output, detail}` 对象，不再是 boolean

### 日历

- 左侧日历支持点击切换日期，周末不可点击（灰色 `#f1f3f6` 背景）
- 点击历史日期后 `state.simfolioData` 置空，从 `/api/daily-summary/latest?date=` 加载
- 所有 API 自动附加 `?date=` 当 `cal.activeDate !== today`

---

## 关键 API

所有 `/api/news/latest`, `/api/analysis/latest`, `/api/daily-summary/latest` 支持 `?date=YYYY-MM-DD`。

| 路由 | 用途 |
|------|------|
| `/api/status` | 服务器状态+交易日 |
| `/api/simfolio/status` | ★ 模拟账户快照（含持仓健康度+回撤等级+因子诊断） |
| `/api/simfolio/holdings-health` | ★ 持仓健康度（距离止损/信号变化/推荐操作） |
| `/api/pipeline/run` | 手动触发全量扫描（POST） |
| `/api/pipeline/result` | 当前 Pipeline 结果（内存中） |
| `/api/pipeline/last-result` | 最近持久化的扫描结果 |
| `/api/pipeline/status` | Pipeline 运行状态 |
| `/api/scheduler/status` | 调度器状态 |
| `/api/news/latest` | 新闻+7 级情感标签+AI 影响预测 |
| `/api/analysis/latest` | 交易归因分析 |
| `/api/daily-summary/latest` | 每日盘后总结 |
| `/api/summary-dates` | 有总结的交易日列表 |
| `/api/events/:date` | 每日事件日志 |
| `/api/events/dates` | 可用事件日期列表 |
| `/api/knowledge/summary` | 知识库摘要 |
| `/api/knowledge/factor-combos` | 因子组合模式+板块资金流模式 |
| `/api/config/public` | 公开配置（筛选/权重/仓位/交易规则） |
| `/api/indices/today` | 指数分钟线数据 |
| `/api/think-tank/stream` | SSE 实时事件流 |
| `/api/think-tank/decision-status` | ★ AI 思考舱一站式数据（含内联 K 线预取 — 5 只候选股日线通过 Tencent API 并行获取，4s 超时返回已有数据） |
| `/api/think-tank/candidate-kline` | 候选股 K 线批量获取（fallback，5s 超时，支持缓存） |
| `/api/us-market/current` | 美股实时快照 |
| `/api/us-market/summary` | 美股隔夜总结 |
| `/api/us-market/status` | 美股交易时段状态 |
| `/api/cross-market/analysis` | ★ 跨市场分析（风险状态+相关性矩阵） |
| `/api/cross-market/risk-state` | 风险状态机单独查询 |
| `/api/cross-market/correlation` | 相关性矩阵单独查询 |
| `/api/market/cycle` | ★ A 股市场周期（MA+量能+宽度→5 档+仓位建议） |
| `/api/factors/performance` | 因子绩效追踪（含北向绩效） |
| `/api/market/microstructure` | 智能风险中枢（北向+波动率+Smart Money） |
| `/api/margin/status` | 两融数据+情绪评分 |
| `/api/sectors/live` | 板块实时行情（仅当日） |
| `/api/history/status` | ★★ 历史复盘引擎状态 v2.9（含 discoveries[] + tickHistory[]） |
| `/api/history/report?mode=` | ★★ 历史复盘报告 v2.9（daily/deep/full） |
| `/api/history/context` | ★★ 历史复盘增强上下文 v2.9（替代 weekend_context） |
| `/api/history/verification?week=` | ★★ 历史验证报告 v2.9 |
| `/api/history/verification-history` | ★★ 多周验证趋势 v2.9 |
| `/api/history/patterns` | ★★ 因子组合+板块模式 v2.9 |
| `/api/history/discoveries?limit=` | ★★ 周末发现的新规律 v2.9 |
| `/api/weekend-analysis/status` | [v2.9 废弃] 透传到 /api/history/status |
| `/api/weekend-analysis/report` | [v2.9 废弃] 透传到 /api/history/report |
| `/api/weekend-analysis/context` | [v2.9 废弃] 透传到 /api/history/context |
| `/api/weekend-analysis/verification` | [v2.9 废弃] 透传到 /api/history/verification |
| `/api/weekend-analysis/verification-history` | [v2.9 废弃] 透传到 /api/history/verification-history |
| `/api/predict/factor-performance` | ★ 个股级别因子预测能力 |
| `/api/predict/dynamic-weights` | ★ 动态权重（OLS 学习） |
| `/api/predict/sector-leadlag` | ★ 板块领先/滞后矩阵 |
| `/api/predict/cycle-factor-matrix` | ★ 周期×因子有效性热力图 |
| `/api/predict/trade-attribution` | ★ 交易归因调整列表 |
| `/api/evolution/status` | ★ 进化任务运行状态+进度+时间表 |
| `/api/evolution/night-backtest/latest` | ★ 最近夜间回测结果 |
| `/api/evolution/self-reflection/latest` | ★ 最近自我质疑报告 |
| `/api/evolution/us-predict/today` | ★ 今日美股→A股预测 |
| `/api/evolution/us-predict/accuracy` | ★ 美股→A股预测历史准确率（?days=N） |
| `/api/evolution/grid-search/latest` | ★ 最近网格搜索结果 [v2.7.0] |
| `/api/evolution/factor-mining/latest` | ★ 最近因子组合挖掘结果 [v2.7.0] |
| `/api/evolution/run-grid-search` | 手动触发网格搜索（POST）[v2.7.0] |
| `/api/evolution/run-self-reflection` | 手动触发自我质疑（POST）[v2.7.0] |
| `/api/evolution/run-factor-mining` | 手动触发因子挖掘（POST）[v2.7.0] |
| `/api/evolution/run-us-predict` | 手动触发美股预测生成（POST）[v2.7.0] |
| `/api/evolution/run-us-verify` | 手动触发美股预测验证（POST）[v2.7.0] |
| `/api/evolution/run-all` | 一键触发全部进化任务（POST）[v2.7.0] |
| `/api/position/force-check` | 手动触发持仓检查（POST） |

---

## ⚠ 关键约束

### 数据准确性铁律
- **所有股价/涨跌幅/PE/成交额必须实时查询，绝不估算**
- PE 亏损写 "亏损" 或 null

### 部署优先级
- **云端永远优先**：改动完成后立即 scp 到 `root@8.153.101.112:/root/FIRSTCC/Francis Investment/`
- 后端文件（`mosaic/` 下的 .js）部署后需 `systemctl restart mosaic`
- 前端静态文件无需重启，刷新浏览器即可
- 部署后 curl 验证关键 API

### 文件修改规则
- **config.js 是唯一配置入口**：改阈值/权重/时间表/回撤门/建仓节奏/因子诊断/仓位分层/预测引擎开关只需改这一个文件
- **`report-engine/data/` 是 DATA_DIR**：所有运行时数据在此目录下，不在 `mosaic/` 下
- **预测引擎开关**：`config.PREDICTION.useExpectedReturnRanking` — true=期望收益排名, false=硬阈值旧逻辑

### 绝不提交运行时数据
`portfolio.json`, `scheduler_state.json`, `events/*.json`, `summaries/*.json`, `knowledge_base/*.json`, `index_history_*.json`, `us_latest.json`, `correlation_history.json`, `us_close_*.json`, `factor_performance.json`, `scan_records_*.json`, `last_pipeline_result.json`, `weekend_context.json`, `history_context.json`, `market_history/indices/*.json`, `weekend_archive/*.json`, `margin_cache.json`, `dynamic_weights.json`, `stock_factor_performance.json`, `cycle_factor_matrix.json`, `sector_leadlag.json`, `trade_attribution.json`, `attribution_adjustments.json`, `klines/*.json`, `last_gate_state.json`, `night_backtest_result.json`, `self_reflection_result.json`, `us_as_predictions.json`, `us_as_verification_history.json`, `factor_combinations.json`, `weight_grid_result.json`, `position_diagnosis.json`, `false_signal_patterns.json`, `missed_opportunities.json`

### 已知陷阱

- **SSH 路径含空格**：必须引号包裹 → `"/root/FIRSTCC/Francis Investment/..."`
- **scheduler `_runDailySummary()` 无 await**：fire-and-forget，16:00 附近重启服务器会导致当天总结+相关性快照丢失
- **`_drawdownLevel` 不含数值字段**：`getDrawdownLevel()` 返回 `{level, message, threshold}`，实际回撤数值存在 `pf._stats.maxDrawdown`。`buildGateResults()` 已修复（v2.8.1），新增代码切勿再次从 `_drawdownLevel` 读 currentDrawdown
- **`safeFixed()` 必须用于所有 `.toFixed()`**：simfolio.js 中所有 `.toFixed()` 调用必须使用 `safeFixed(value, decimals, fallback)` 包装，防止 `undefined.toFixed()` 崩溃导致整个交易决策被丢弃
- **scp 部署检查清单**：部署 simfolio.js 后必须 `systemctl restart mosaic`（后端文件）；前端文件（app.js/think-tank.html）无需重启。部署后 curl 验证关键 API
- **Eastmoney push2 K 线 API 频繁限流**：K 线数据源已改为 **Tencent API 主力**（`web.ifzq.gtimg.cn/appstock/app/fqkline/get`），Eastmoney 降级为备选。`fetchKline()` 带有 5s 超时 + 5 分钟磁盘缓存（`data/klines/<code>.json` TTL）。`fetchJSON()` 和 `fetchRaw()` 均有 5s `req.setTimeout()` 保护
- **`fetchRaw()` 使用 GBK 解码**：`new TextDecoder('gbk')` — 对 Tencent API（UTF-8）也能兼容（JSON 仅 ASCII），但部署时务必确保云端 `market_data.js` 是最新版
- **K 线缓存目录必须存在**：`data/klines/` 需在部署时创建，否则 `fetchKline()` 缓存写入失败（不影响功能但无缓存加速）
- **Tencent K 线不含 turnover（成交额）**：仅 date/open/close/high/low/volume，不影响迷你 K 线渲染（不需要成交量副图）
- **portfolio.json 损坏时 .bak 自动恢复**：不要手动删除 .bak
- **跨市场相关性需 5 个交易日累积**：首次部署后需等待一周
- **因子绩效需 ≥2 天 scan_records**：首日只显示信号计数
- **预测引擎个股因子绩效需 ≥2 天 stock_factor_performance.json**：由 Full/Mid Pipeline 每次扫描后自动记录
- **动态权重需 ≥30 条数据且 R²>0.05**：每日盘后自动运行，未达到前使用 config 默认权重
- **全项目无 emoji**：所有 JS/HTML 文件中不得使用 emoji，Unicode 特殊符号（▲▼↗↘→）也禁止，状态指示器用纯文本标签（如 `[ACTIVE]`, `[OK]`, `[X]`, `[UP]`, `[DN]`），标题用纯文字
- **Sina US stock API 字段映射**：`fields[26]` = prevClose（紧接在 "Jun 08 04:00PM EDT" 字段后），`fields[30]` 是当日收盘价不是昨收。修改 `parseSinaUSLine()` 时务必对照最新 API 返回格式
- **周末分析全中文**：`weekend_context.json` 用中文板块名，simfolio 用 `WEEKEND_SECTOR_KEYWORDS` 中文匹配
- **两融数据为代理指标**：Eastmoney 沪股通聚合 K 线（secid=90.BK0707），非官方融资融券余额
- **correlation_history.json 不含"金融"板块**：数据源限制，非 bug
- **think-tank.html 大盘 K 线不依赖 kline.js**：`drawIndexChart()` 直接 Canvas 绘制三指数分时涨跌幅——修改大盘 K 线区域时不要引用 kline.js 函数
- **`innerHTML` 不执行内联 `<script>`**：跨市场分析的 Risk Gauge Canvas 和 Risk Timeline sparkline 都通过内联 `<script>` 绘制。`loadCrossMarketIntoDOM()` 在 `innerHTML` 后调用 `execInlineScripts(container)` 手动执行脚本。任何通过 innerHTML 插入含 `<script>` 的 HTML 片段的面板都必须加上这一步
- **因子命中率 `factor_performance.json` 中 factors 为数组**：需用 `Array.find` 查找
- **config API 字段映射**：`cfg.FILTER.exclude300`（非 excludeGEM），`cfg.FILTER.exclude688 === false`（非 includeSTAR），`cfg.SIMFOLIO.maxSinglePositionPct`（非 maxPositionPct）
- **前端渲染路由**：simfolio/usMarket/crossMarket/predict/historyReview 面板必须在 `renderCurrentSection()` 中有专用路由，否则不会渲染
- **v2.9 `_index.json` 格式兼容**：旧 weekend_analyzer 写入纯数组 `[...]`，history_verifier 写入对象 `{entries: [...]}`。`_readArchiveIndex()` 自动兼容两种格式
- **predict.js 的 renderPredictionDashboard** 始终渲染 5 面板，子渲染器自行处理空状态——不要再加 `if (data.XXX)` 条件包裹
- **v2.9.1 夜间回测 minBars 陷阱**：`night_backtest.js` 的 `getKlinesFromCache(code, minBars)` 中 minBars 不能超过 K 线缓存实际大小（当前 ~6-12 条）。新增代码调用 `getKlinesFromCache` 时切勿传 60 等大值 → 会导致 enriched 永远为 0。当前 `MIN_KLINES = 6`，兜底 ≥2 条也返回
- **v2.9.1 `scheduler.js` 中北向绩效函数名**：正确函数名是 `factor_performance.getNBPerformance()`（单数 Perf），不是 `getNBSentimentRecord`。传错名字不报错（因为 `?.` 安全调用）但永远返回 null，导致期望收益计算中北向情绪维度数据缺失
- **Loop 5 归因 `sectorAvoid` 触发条件**：v2.9.1 已扩展到所有亏损 >5% 的卖出（不限于硬止损）。新增归因逻辑时注意 `actualReturn < -5` 是新的触发边界，`expiresAt` 按亏损深度分层（>8%→5天，3-8%→3天）
- **`.gitignore` 运行时数据**：`klines/` 和 `weekend_archive/` 已加入 .gitignore。新增运行时数据目录时务必同步更新 .gitignore，防止大量缓存文件被提交
