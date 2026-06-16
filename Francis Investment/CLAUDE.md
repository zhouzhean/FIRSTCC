# Francis Investment CLAUDE.md

A股量化交易系统 v3.1.0 + 报告引擎 + **24/7 自主学习进化引擎**。Node.js 零外部依赖，阿里云 ECS `8.153.101.112:8765`。

## v3.1.0 (2026-06-16) — 历史训练+实盘校准：量化学习系统

### 核心理念
**全部服务端计算，零 Claude tokens 消耗。**

数据下载 → 清洗 → 因子回测 → 有效性矩阵 → 参数搜索 → 跨市场相关性 → 模型更新 → 自动报告
└──────────── 全部 Node.js 本地跑，0 tokens ────────────┘
AI 只在：解释、改策略、审查异常、总结报告时介入。

### 新增
| 模块 | 文件 | 功能 |
|------|------|------|
| 历史数据训练引擎 | `mosaic/evolution/bootstrap_history.js` | 7 Phase 完整训练链路：K线拉取/清洗 → 每日回放(真实因子引擎) → 因子有效性矩阵 → 因子组合挖掘(协同/冲突) → 跨市场相关性 → 参数网格搜索 → 自动报告生成 |
| 调度集成 | `mosaic/evolution/evolution_scheduler.js` | 周日 01:00 自动触发 bootstrap（在 night_backtest 之前） |
| 因子有效性矩阵 | `data/evolution/factor_effectiveness.json` | 17个因子 × T+1/3/5/10/20 的胜率/平均收益/盈亏比，按市场状态(bull/bear/high_vol/low_liquidity/sideways)分组 |
| 参数优化结果 | `data/evolution/param_search_results.json` | 止损线×买入阈值×仓位×最大持仓数的网格搜索 Top 50 |
| 训练综合矩阵 | `data/evolution/training_matrix.json` | ~50KB 结构JSON，包含所有分析结果汇总 |
| 自动训练报告 | `data/evolution/training_report_YYYYMMDD.md` | Markdown 格式，可直接查看或邮件发送 |

### 新增 API（v3.1）
| 路由 | 用途 |
|------|------|
| `GET /api/evolution/training-matrix` | 查看训练矩阵摘要（summary+config，不含原始数据） |
| `GET /api/evolution/factor-effectiveness` | 因子有效性详情（按 horizon + regime） |
| `GET /api/evolution/param-search` | 参数搜索最优结果 + 推荐配置 |
| `GET /api/evolution/training-report` | 获取最新自动训练报告 (markdown) |
| `GET /api/evolution/bootstrap-status` | 训练状态（上次运行时间、完成阶段、错误） |
| `POST /api/evolution/run-bootstrap` | 手动触发全量训练（后台运行，2-4 小时） |

### 使用
```bash
# 全量训练（沪深300，5年）
node mosaic/evolution/bootstrap_history.js

# 仅增量更新（最近20天）
node mosaic/evolution/bootstrap_history.js --incremental

# 仅使用现有K线缓存（跳过下载）
node mosaic/evolution/bootstrap_history.js --skipDownload

# 全A股（慎用，约1周）
node mosaic/evolution/bootstrap_history.js --universe all
```

### 关键设计决策
- **数据范围**：默认沪深300成分股 (~300只) × 5年，输出 ~50KB JSON。全A股约500MB。
- **采样策略**：每3天采1天 + 最近60天全量，减少计算量但不失真。
- **因子引擎复用**：调用 `hidden_signals.js` 和 `composite.js` 的 REAL 计算函数，不是简化近似。
- **前向收益计算**：当日 close → T+N 日 close，无未来数据泄漏。
- **Token 消耗**：脚本运行时完全不消耗 tokens。仅当 AI 读取输出 JSON 时才消耗 (~15K tokens)。

## v3.0.4 (2026-06-16) — 策略体检板块 UI/响应式/数据修复 + 云端版本同步

### 修复
| # | 问题 | 文件 | 修改 |
|---|------|------|------|
| 1 | Canvas 图表模糊（无 Retina/HiDPI 适配） | `strategy-health.js`, `app.js` | 3 个 Canvas 添加 `devicePixelRatio` 缩放 + CSS `aspect-ratio` 替代固定 width/height |
| 2 | 手机端布局不匀称（inline style 覆盖 CSS @media） | `app.js:2560-2614` | 所有 inline `grid-template-columns` 移除，改用 CSS class `.sh-cards-row/.sh-chart-row/.sh-detail-row` |
| 3 | 总控栏小屏拥挤 | `app.js` renderMCBar() | flex 布局加 `flex-wrap:wrap;gap:8px` |
| 4 | 热力图/Canvas 容器小屏溢出 | `style.css` | `.sh-chart-card` 加 `overflow-x:auto`；超小屏字号缩小 |
| 5 | 交易成本用硬编码费率估算 | `strategy_health.js` computeTradeStats() | 优先读 `trade.costs` 实际记录，fallback 到费率估算 |
| 6 | 回撤曲线 yMax 硬编码 `=2` | `strategy-health.js` drawShDDChart() | 改为动态 `Math.max(2, maxPositive*1.3+1)`，适应各种回撤幅度 |
| 7 | 云端版本号停留在 2.9.1 | `mosaic_server.js:373` | 更新为 `3.0.3`，与本地同步 |
| 8 | `templates/strategy-health.js` 与 `app.js` 双重渲染路径 | `strategy-health.js` 头部 | 标注主渲染路径在 `app.js`，Canvas 绘制函数为共享全局函数 |

### 响应式断点（策略体检专用）
| 断点 | 指标卡片 | 图表区 | 字号 |
|------|---------|--------|------|
| >960px | 4 列 | 2 列 | 标准 (28px value) |
| 720-960px | 2 列 | 1 列 | 标准 |
| 400-720px | 2 列 | 1 列 | 缩小 (22px value) |
| ≤400px | 2 列 | 1 列 | 超小 (18px value) |

## v3.0.3 (2026-06-15) — 数据质量面板修复 + 回测止损冷却期 + 指标统一

### 修复
| # | 问题 | 文件 | 修改 |
|---|------|------|------|
| 1 | `affectedModules` 只含 DOWN/STALE，WARN/PROXY 不显示 | `data_quality.js:66-76` | WARN/PROXY 现在也推入 `affectedModules` |
| 2 | 回测止损后可当日重新买入同一只股票（违反交易纪律） | `full_backtest.js:208-210,+659-672` | 新增 4 天止损冷却期 + `dateDiffTradingDays()` 辅助函数 |
| 3 | `signalQuality` 与 `signalDetail` 统计口径不一致（candidate-level vs factor-level） | `full_backtest.js:168-172,389-394,422-427` | 拆分为 `signalQuality`（候选股命中率%）+ `factorHitRate`（因子级命中率%），均以百分比显示 |

## v3.0.1 (2026-06-15) — 策略体检+风险预算+完整回测+数据质量+增强归因+交易约束闭环

### 新增模块
| 模块 | 文件 | 功能 |
|------|------|------|
| 策略体检引擎 | `mosaic/analysis/strategy_health.js` | Sharpe/Sortino/Calmar、NAV曲线、回撤曲线、月度热力图、总控判断(ALLOW/CAUTIOUS/REDUCE/BLOCK) |
| 策略体检面板 | `report-engine/templates/strategy-health.js` | 前端 Canvas 图表 + 指标卡片 + 总控栏（6 子面板） |
| 完整回测框架 | `mosaic/evolution/full_backtest.js` | 2020-2026 年 7 种市场状态独立回测，周日 02:00 自动调度 |
| 数据质量面板 | `mosaic/analysis/data_quality.js` | 8 个数据源健康监控 + "系统不知道什么"清单 + 置信度影响评估 |
| 风险预算模型 | `mosaic/analysis/risk_budget.js` | 波动率调整/Kelly准则/相关性惩罚/流动性限制/熔断机制 |
| 增强交易归因 | `mosaic/predict/trade_attribution.js` | +市场上下文/择时质量/仓位分析 3 个新维度 |

### 新增 API（v3.0）
| 路由 | 用途 |
|------|------|
| `GET /api/strategy/health` | 策略综合体检报告 |
| `GET /api/strategy/health/summary` | 总控摘要（ALLOW/CAUTIOUS/REDUCE/BLOCK） |
| `GET /api/backtest/latest` | 最近完整回测结果 |
| `GET /api/backtest/status` | 回测框架状态 |
| `POST /api/backtest/run` | 手动触发完整回测 |
| `GET /api/data-quality/status` | 数据源健康状态（8 源综合评分） |
| `GET /api/data-quality/summary` | 数据质量摘要 |

### 前端新增
- **策略体检** section（侧边栏第 2 项，金色渐变圆点）：6 子面板（总控栏/风险指标卡片/NAV+回撤Canvas/月度热力图/交易统计/归因摘要）
- **总控判断栏**：基于策略体检摘要数据，决定今日是否允许开仓
- **AI 状态标识**："策略运行中"（替换旧 "AI 就绪"）

### 修改文件
`mosaic_server.js`, `simfolio.js`（风险预算集成+增强归因传入+数据质量惩罚）, `config.js`（新增 RISK_BUDGET 配置块）, `evolution_scheduler.js`（新增 full_backtest 周日任务）, `app.js`, `index.html`, `style.css`

### v3.0.1 约束闭环补丁
| 修复 | 原因 | 改动 |
|------|------|------|
| 总控判定严格化 | -6.3%回撤+0%胜率仍判"谨慎开仓" | 4 组级联规则：零胜率→BLOCK / 零盈亏比→BLOCK / 回撤+连亏+低胜率叠加升级 / 3+持仓+负收益限买 |
| 风险预算regime映射 | `macroContext.riskRegime` 永远 undefined | 改为 `macroContext.riskState.regime`；panic 直接 blocker 不 clamp |
| 数据质量→信号降权 | 数据异常不影响评分 | `computeConfidencePenalty()` 0-10分惩罚接入评分管线 + gateResults 暴露 |
| 回测接入真实因子 | `estimateSignalsForDate()` 空壳 | 接入 hidden_signals+composite，加止损/止盈/仓位/交易成本模拟 |

### v3.0.2 反馈修复
| 修复 | 原因 | 改动 |
|------|------|------|
| 连续亏损传入总控 | `attributionSummary` 已算出但未传入 `computeMasterControlJudgment()` | 补传参数字段，consecLosses severity 从 0→2 |
| 数据质量面板同步 | 面板 `confidenceReduction` 仅统计 DOWN/STALE，WARN/PROXY 被无视 | `checkAllDataSources()` 改用 `computeConfidencePenalty()` 逻辑填充 `confidenceImpact` |
| 回测跑出首次结果 | 框架已有但从未执行，K线缓存仅近期数据 | `discoverAvailableDates()` 从缓存提取实际日期；修复 compositeScore NaN 解读（composite.js 返回对象）；fallback 信号数评分

---

## 核心架构

### 调度器（scheduler.js）— 24/7 自动运行

状态机：`closed → pre_market → morning_session → lunch_break → afternoon_session → post_market → closed`

- 活跃时段 tick 每 20s，空闲时段每 300s
- IndexRecorder：交易时段 60s 记录指数分钟线
- 美股采集：16:00-06:00 CST 采集 30 只符号 → SSE 广播
- `_runDailySummary()`：16:00 异步 fire-and-forget → 盘后总结 + 相关性快照 + 因子绩效追踪 + 动态权重更新 + 周期×因子矩阵更新
- 历史复盘引擎：每天 16:30 daily light + 周六 10:30 deep + 周末每2小时 tick discovery

### Pipeline 执行流程（pipeline.js）

1. 获取全 A 股列表（Eastmoney push2）
2. 过滤器（价格≤20/成交额>1亿/PE≤40/排除ST和创业板）
3. 计算隐藏因子 H1-H9 + 并行获取 LHB/板块资金流/北向/两融
4. 8 维预评分排序 → top 80 进入深析
5. 逐只深析（双源基本面 + K线 + 资金流历史）→ 5 维综合评分
6. 排序/评级/SSE 广播
7. 记录个股因子信号 → 预测引擎数据累积

### Simfolio — 模拟交易引擎

- 初始 ¥100,000，T+1，持仓上限 5 只，单只 ≤30%
- **分层仓位**：强买入 15-25% / 普通买入 8-12%
- **风险预算模型（v3.0）**：波动率调整 → 相关性惩罚 → 流动性限制 → Kelly准则 → 风险状态乘数 → 熔断检查（回退到固定百分比仓位）
- **回撤管理（3 档）**：warn(-5%) / restrict(-8%) / halt(-10%)
- **多级风控门（6 门+数据质量惩罚）**：回撤门 → 市场方向门 → 跨市场熔断 → 数据质量惩罚(降权0-10分) → 持仓浮亏门 → 思维舱防御门 → 归因避让板块
- 卖出：硬止损 -8% / 软止损 评分<35 / 移动止盈
- T+1：当天买入的股票只有硬止损可卖出

### 预测引擎 — 6 模块

| 模块 | 文件 | 功能 |
|------|------|------|
| 个股因子追踪 | `predict/stock_predictor.js` | 记录每只股票触发因子后的实际收益 |
| 期望收益计算 | `predict/expected_return.js` | 6维加权：因子组合(30%)+板块流向(20%)+市场周期(15%)+北向情绪(15%)+历史相似度(10%)+评分百分位(10%) |
| 动态权重学习 | `predict/dynamic_weights.js` | 每日盘后 OLS 回归，自动调整 5 维评分权重 |
| 板块轮动预测 | `predict/sector_leadlag.js` | 时移 Pearson 相关性→领先/滞后矩阵 |
| 周期×因子矩阵 | `predict/cycle_factor_matrix.js` | 5 周期×9 因子命中率热力图 |
| 交易归因反馈 | `predict/trade_attribution.js` | 每笔卖出分析盈亏原因 + v3.0 增强（市场上下文/择时质量/仓位分析） |

### 24/7 自主学习进化引擎 — 8 个任务

| 任务 | 时间 | 闭环回馈 |
|------|------|----------|
| 夜间历史回测 | 02:00 | stock_predictor 优先读取验证数据 |
| 权重网格搜索 | 03:00 | dynamic_weights 自动替换最优参数 |
| 参数推送验证 | 04:00 | 检测参数漂移→标记重新搜索 |
| 美股→A股预测生成 | 05:30 | — |
| 美股→A股预测验证 | 16:10 | 跨市场信号权重乘数自动调整 |
| 自我质疑循环 | 20:00 | — |
| 因子组合挖掘 | 周六 10:00 | composite 协同对加成/冲突对降权 |
| 完整回测（v3.0） | 周日 02:00 | `full_backtest.js` — 7 种市场状态独立验证 |

### 历史复盘引擎（v2.9 统一）

每天 16:30 Daily Light + 周六 10:30 Weekend Deep + 周末每2小时 8 角度持续发现 + 周日 09:00 Discovery

### 隐藏因子 H1-H9

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
- 支持动态权重覆盖（OLS 学习 R²≥0.05 时启用）
- 无详细财务数据时：fundamental→10%，总分上限 65
- 复合调整：北向情绪 ±3-5 + 两融 ±2-3 + 板块相对评分 ±3-5 + LHB 增强 ±3-5 + COLD 因子惩罚 -3-8 + 周期偏好 + 假信号模式惩罚

### 市场周期识别（market_cycle.js）

均线排列(40%) + 成交量趋势(30%) + 市场宽度(30%) → 5 档：牛市(≥75)/震荡偏多(≥60)/震荡(≥40)/震荡偏空(≥25)/熊市(<25)

### 跨市场相关性（cross_market.js）

- **风险状态机**：VXX(40%) + UUP(30%) + TLT(30%) → 5 档（panic/risk_off/neutral/slightly_bullish/risk_on）
- 每日 16:00 相关性快照，保留 60 个交易日

### 7 条反馈闭环

| # | 回路 | 输入→处理→输出 | 状态 |
|---|------|------|------|
| 1 | 历史复盘→分析引擎 | 复盘报告 → 识别关键信号 → 板块偏好+跨市场防御 | ✅ daily refreshed |
| 2 | 北向资金→评分降权 | 北向情绪历史 → 方向命中率 → composite北向权重±3~5 | ✅ 活跃 |
| 3 | 知识库→交易决策 | 历史日分析存档 → 追踪高效因子 → 冷因子检测→防御门 | ✅ 活跃 |
| 4 | 思考舱→防御门 | 6维风控 → 综合评分 → 防御触发/通过 | ✅ 活跃 |
| 5 | 交易→归因→参数反馈 | 已完成交易 → 归因分析 → 板块避让+因子降权 (v3.0增强) | ✅ 活跃 |
| 6 | 动态权重→评分适应 | OLS训练数据 → OLS回归 → 学习生效/回退默认 | ✅ 活跃 |
| 7 | 进化引擎→全回路 | 7个进化模块 → 空闲窗口调度 → 所有回路数据质量增强 | ✅ 活跃 |

---

## 云端部署

| 项目 | 详情 |
|------|------|
| IP / URL | `8.153.101.112:8765` |
| 系统 | Ubuntu 22.04, 2 vCPU / 2 GiB, CST (Asia/Shanghai) |
| 进程 | systemd `mosaic.service` — `Restart=always`, `RestartSec=10` |

### 日常运维命令

```bash
# 部署后端文件到云端（需重启）
scp "C:/Users/anzhe/FIRSTCC/Francis Investment/<path>" "root@8.153.101.112:/root/FIRSTCC/Francis Investment/<path>"
ssh root@8.153.101.112 "systemctl restart mosaic"

# 前端文件部署后无需重启
# 查看运行状态
ssh root@8.153.101.112 "systemctl status mosaic --no-pager | head -10"
ssh root@8.153.101.112 "journalctl -u mosaic --no-pager -n 20"

# 验证核心 API
curl -s http://8.153.101.112:8765/api/status
curl -s http://8.153.101.112:8765/api/simfolio/status
curl -s http://8.153.101.112:8765/api/market/cycle
curl -s http://8.153.101.112:8765/api/cross-market/analysis
curl -s http://8.153.101.112:8765/api/strategy/health
curl -s http://8.153.101.112:8765/api/data-quality/status
curl -s http://8.153.101.112:8765/api/backtest/latest
```

---

## 项目结构

```
Francis Investment/
├── mosaic_server.js             # ★ HTTP 主服务器 (0.0.0.0:8765) — 50+ API 路由
├── mosaic/                      # ★ 量化引擎
│   ├── config.js                #   唯一配置入口（阈值/权重/时间表/风险预算/预测引擎/进化引擎）
│   ├── scheduler.js             #   状态机调度器
│   ├── pipeline.js              #   主流程编排（EventEmitter）— 8维预评分+SSE实时广播
│   ├── simfolio.js              #   模拟交易引擎（6门风控+风险预算+增强归因+T+1）
│   ├── collectors/              #   数据采集
│   │   ├── market_data.js       #   A股行情（东财+腾讯+新浪三级备选）+ K线（5分钟缓存）
│   │   ├── us_market.js         #   美股实时监控（30只ETF+指数）
│   │   ├── north_bound.js       #   北向资金流向+情绪计算
│   │   ├── capital_flow.js      #   板块资金流
│   │   ├── dragon_tiger.js      #   龙虎榜+机构席位
│   │   ├── index_recorder.js    #   指数分钟线记录器
│   │   ├── margin_data.js       #   两融数据
│   │   └── news_collector.js    #   财经新闻采集+7级情感分析
│   ├── factors/                 #   评分引擎
│   │   ├── hidden_signals.js    #   H1-H9 隐藏因子
│   │   └── composite.js         #   5维综合评分 + 北向/两融/板块/LHB/周期/假信号调整
│   ├── evolution/               #   ★ 24/7 自主学习进化引擎
│   │   ├── night_backtest.js    #   夜间历史回测
│   │   ├── self_reflection.js   #   自我质疑循环
│   │   ├── us_as_predict.js     #   美股→A股预测+验证
│   │   ├── weight_grid_search.js # 动态权重超参数网格搜索
│   │   ├── weekend_factor_mining.js # 周末因子组合协同效应挖掘
│   │   ├── full_backtest.js     #   ★ v3.0 多周期完整回测（2020-2026，7 种市场状态）
│   │   └── evolution_scheduler.js # 进化任务统一调度器（8任务）
│   ├── predict/                 #   预测引擎
│   │   ├── stock_predictor.js   #   个股级别因子命中率追踪
│   │   ├── expected_return.js   #   6维期望5日收益率
│   │   ├── dynamic_weights.js   #   OLS滚动回归自动权重调整
│   │   ├── sector_leadlag.js    #   板块领先/滞后矩阵
│   │   ├── cycle_factor_matrix.js # 市场周期×因子有效性热力图
│   │   └── trade_attribution.js #   交易归因反馈（v3.0 增强：市场上下文+择时+仓位）
│   └── analysis/                #   盘后+历史复盘+风险
│       ├── market_cycle.js      #   A股周期识别（MA+量能+宽度→5档）
│       ├── cross_market.js      #   跨市场相关性引擎 + 风险状态机（5档）
│       ├── factor_performance.js #  因子绩效追踪
│       ├── history_review.js    #   统一历史复盘引擎（daily+deep+8角度发现）
│       ├── history_verifier.js  #   历史复盘验证
│       ├── strategy_health.js   #   ★ v3.0 策略体检引擎（Sharpe/Sortino/Calmar/总控判断）
│       ├── risk_budget.js       #   ★ v3.0 风险预算模型（波动率/Kelly/相关性/流动性/熔断）
│       ├── data_quality.js      #   ★ v3.0 数据质量监控（8源健康检查）
│       ├── knowledge_base.js    #   因子追踪知识库
│       ├── quant_report.js      #   交易归因+新闻预测
│       ├── us_macro.js          #   美股隔夜总结
│       ├── weekend_analyzer.js  #   [DEPRECATED v2.9] 已合并到 history_review.js
│       └── weekend_verifier.js  #   [DEPRECATED v2.9] 已合并到 history_verifier.js
├── report-engine/               # ★ 前端（纯静态）
│   ├── index.html               #   主仪表板（9 section）
│   ├── think-tank.html          #   AI 思考舱（SSE实时+6行决策中心）
│   ├── app.js                   #   前端控制器（section导航+异步渲染+动画工具）
│   ├── style.css                #   仪表板样式（桌面+移动端≤720px）
│   ├── kline.js                 #   K线图绘制
│   ├── renderer.js              #   历史报告渲染器
│   ├── templates/               #   UI模板
│   │   ├── simfolio.js          #   模拟交易面板
│   │   ├── strategy-health.js   #   ★ v3.0 策略体检面板（Canvas图表+指标卡片）
│   │   ├── predict.js           #   预测引擎5面板仪表板
│   │   ├── cross-market.js      #   跨市场分析面板
│   │   ├── us-market.js         #   美股玻璃拟态面板
│   │   ├── history-review.js    #   历史复盘统一仪表板（Canvas可视化）
│   │   └── ...                  #   其他历史模板
│   └── data/                    #   运行时数据目录（不提交）
│       ├── simfolio/            #   portfolio.json + 因子/预测/归因/权重/门状态
│       ├── klines/              #   K线缓存 <code>.json (TTL 5分钟)
│       ├── us_market/           #   美股实时+相关性历史
│       ├── market_history/      #   历史K线 indices/
│       ├── events/              #   每日事件日志
│       ├── summaries/           #   每日盘后总结
│       └── knowledge_base/      #   AI 知识库
```

---

## 前端架构

### Section 导航

| ID | 标签 | 渲染方式 |
|----|------|----------|
| `simfolio` | 模拟交易 | 直接 DOM 渲染（资产卡片+持仓健康度+交易动态） |
| `strategyHealth` | 策略体检 ★v3.0 | 直接 DOM + Canvas（总控栏+风险指标+NAV/回撤+热力图+归因） |
| `newsPolicy` | 时政要点 | 异步 API 加载 |
| `tradingReport` | 交易分析与报告 | 异步 API 加载 |
| `holdingsAnalysis` | 持仓分析 | 暂不可用 |
| `usMarket` | 海外市场 | 直接 DOM 渲染 |
| `predict` | 预测引擎 | 直接 DOM 渲染（5 面板仪表板） |
| `crossMarket` | 跨市场分析 | 直接 DOM 渲染（风险仪表盘+周期+相关性） |
| `historyReview` | 历史复盘 | 直接 DOM 渲染（Canvas 可视化） |

**关键**：simfolio/strategyHealth/usMarket/predict/crossMarket/historyReview 使用直接 DOM 渲染模式，在 `renderCurrentSection()` 中有专用路由。

**风格规范**：全项目不使用 emoji，状态指示器用纯文本标签（如 `[ACTIVE]`, `[OK]`, `[X]`, `[UP]`, `[DN]`）。

---

## 关键 API

所有 `/api/news/latest`, `/api/analysis/latest`, `/api/daily-summary/latest` 支持 `?date=YYYY-MM-DD`。

| 路由 | 用途 |
|------|------|
| `/api/status` | 服务器状态+交易日 |
| `/api/simfolio/status` | 模拟账户快照（持仓健康度+回撤等级+因子诊断） |
| `/api/simfolio/holdings-health` | 持仓健康度 |
| `/api/pipeline/run` | 手动触发全量扫描（POST） |
| `/api/pipeline/result` | 当前 Pipeline 结果（内存中） |
| `/api/pipeline/last-result` | 最近持久化的扫描结果 |
| `/api/scheduler/status` | 调度器状态 |
| `/api/news/latest` | 新闻+7级情感标签 |
| `/api/analysis/latest` | 交易归因分析 |
| `/api/daily-summary/latest` | 每日盘后总结 |
| `/api/events/:date` | 每日事件日志 |
| `/api/knowledge/summary` | 知识库摘要 |
| `/api/config/public` | 公开配置 |
| `/api/think-tank/stream` | SSE 实时事件流 |
| `/api/think-tank/decision-status` | AI 思考舱一站式数据 |
| `/api/us-market/current` | 美股实时快照 |
| `/api/us-market/summary` | 美股隔夜总结 |
| `/api/cross-market/analysis` | 跨市场分析（风险状态+相关性矩阵） |
| `/api/cross-market/risk-state` | 风险状态机单独查询 |
| `/api/market/cycle` | A 股市场周期 |
| `/api/factors/performance` | 因子绩效追踪 |
| `/api/market/microstructure` | 智能风险中枢 |
| `/api/margin/status` | 两融数据+情绪评分 |
| `/api/sectors/live` | 板块实时行情 |
| `/api/history/status` | 历史复盘引擎状态 |
| `/api/history/report?mode=` | 历史复盘报告（daily/deep/full） |
| `/api/history/context` | 历史复盘增强上下文 |
| `/api/history/verification?week=` | 历史验证报告 |
| `/api/history/patterns` | 因子组合+板块模式 |
| `/api/history/discoveries?limit=` | 周末发现的新规律 |
| `/api/predict/factor-performance` | 个股级别因子预测能力 |
| `/api/predict/dynamic-weights` | 动态权重 |
| `/api/predict/sector-leadlag` | 板块领先/滞后矩阵 |
| `/api/predict/cycle-factor-matrix` | 周期×因子有效性热力图 |
| `/api/predict/trade-attribution` | 交易归因调整列表 |
| `/api/evolution/status` | 进化任务运行状态 |
| `/api/evolution/night-backtest/latest` | 最近夜间回测结果 |
| `/api/evolution/self-reflection/latest` | 最近自我质疑报告 |
| `/api/evolution/us-predict/today` | 今日美股→A股预测 |
| `/api/evolution/us-predict/accuracy` | 美股预测历史准确率 |
| `/api/evolution/grid-search/latest` | 最近网格搜索结果 |
| `/api/evolution/factor-mining/latest` | 最近因子组合挖掘结果 |
| `/api/strategy/health` | ★v3.0 策略综合体检报告 |
| `/api/strategy/health/summary` | ★v3.0 总控摘要 |
| `/api/backtest/latest` | ★v3.0 最近完整回测结果 |
| `/api/backtest/status` | ★v3.0 回测框架状态 |
| `/api/backtest/run` | ★v3.0 手动触发完整回测（POST） |
| `/api/data-quality/status` | ★v3.0 数据源健康状态 |
| `/api/data-quality/summary` | ★v3.0 数据质量摘要 |
| `/api/position/force-check` | 手动触发持仓检查（POST） |

---

## 关键约束

### 数据准确性
- **所有股价/涨跌幅/PE/成交额必须实时查询，绝不估算**
- PE 亏损写 "亏损" 或 null

### 部署优先级
- **云端永远优先**：改动完成后立即 scp 到 `root@8.153.101.112:/root/FIRSTCC/Francis Investment/`
- 后端文件（`mosaic/` 下的 .js）部署后需 `systemctl restart mosaic`
- 前端静态文件无需重启，刷新浏览器即可
- 部署后 curl 验证关键 API

### 文件修改规则
- **config.js 是唯一配置入口**：改阈值/权重/时间表/风险预算/进化引擎只需改这一个文件
- **`report-engine/data/` 是 DATA_DIR**：所有运行时数据在此目录下

### 绝不提交运行时数据
`portfolio.json`, `scheduler_state.json`, `events/*.json`, `summaries/*.json`, `knowledge_base/*.json`, `index_history_*.json`, `us_latest.json`, `correlation_history.json`, `us_close_*.json`, `factor_performance.json`, `scan_records_*.json`, `last_pipeline_result.json`, `weekend_context.json`, `history_context.json`, `market_history/indices/*.json`, `weekend_archive/*.json`, `margin_cache.json`, `dynamic_weights.json`, `stock_factor_performance.json`, `cycle_factor_matrix.json`, `sector_leadlag.json`, `trade_attribution.json`, `attribution_adjustments.json`, `klines/*.json`, `last_gate_state.json`, `night_backtest_result.json`, `self_reflection_result.json`, `us_as_predictions.json`, `us_as_verification_history.json`, `factor_combinations.json`, `weight_grid_result.json`, `position_diagnosis.json`, `false_signal_patterns.json`, `missed_opportunities.json`, `full_backtest_result*.json`, `data_quality_report.json`, `strategy_health_snapshot.json`, `version_history.json`

### 已知陷阱

- **SSH 路径含空格**：必须引号包裹 → `"/root/FIRSTCC/Francis Investment/..."`
- **scheduler `_runDailySummary()` 无 await**：fire-and-forget，16:00 附近重启服务器会导致当天总结+相关性快照丢失
- **`_drawdownLevel` 不含数值字段**：`getDrawdownLevel()` 返回 `{level, message, threshold}`，实际回撤数值存在 `pf._stats.maxDrawdown`
- **`safeFixed()` 必须用于所有 `.toFixed()`**：simfolio.js 中所有 `.toFixed()` 调用必须使用 `safeFixed(value, decimals, fallback)` 包装
- **策略体检指标守卫**：tradingDays < 20 时 Sharpe/Sortino/Calmar 返回 null（避免小样本极端外推）
- **Eastmoney push2 K 线 API 频繁限流**：已改 Tencent API 主力，5s 超时 + 5 分钟磁盘缓存
- **Tencent K 线不含 turnover**：仅 date/open/close/high/low/volume
- **portfolio.json 损坏时 .bak 自动恢复**：不要手动删除 .bak
- **全项目无 emoji**：所有 JS/HTML 文件中不得使用 emoji，Unicode 特殊符号禁止
- **`innerHTML` 不执行内联 `<script>`**：含 `<script>` 的 HTML 片段需 `execInlineScripts(container)` 手动执行
- **因子命中率 `factor_performance.json` 中 factors 为数组**：需用 `Array.find` 查找
- **前端渲染路由**：simfolio/strategyHealth/usMarket/crossMarket/predict/historyReview 面板必须在 `renderCurrentSection()` 中有专用路由
- **v2.9.1 夜间回测 minBars 陷阱**：`getKlinesFromCache(code, minBars)` 中 minBars 不能超过 K 线缓存实际大小（~6-12 条）
- **v2.9.1 北向绩效函数名**：正确函数名是 `factor_performance.getNBPerformance()`，不是 `getNBSentimentRecord`
- **Loop 5 归因 `sectorAvoid` 触发条件**：v2.9.1 已扩展到所有亏损 >5% 的卖出（不限于硬止损），按亏损深度分层（>8%→5天，3-8%→3天）
- **v3.0 风险预算集成**：`simfolio.js` 的 `checkBuySignal()` 中 `risk_budget.computeRiskBudgetPosition()` 用 try/catch 包裹，失败时回退到固定百分比仓位
- **v3.0.1 总控判定级联**：`computeMasterControlJudgment()` 现在使用级联规则，零胜率/零盈亏比直接 BLOCK，不再按单维度独立取 max
- **v3.0.1 regime 字段路径**：`getCachedRiskState()` 返回 `{regime, totalScore, ...}`，不是 `{riskRegime}`。读取时用 `riskState.regime`
- **v3.0.1 数据质量惩罚**：`computeConfidencePenalty()` 在每次 pipeline 运行时读取磁盘文件检查数据源年龄，会产生少量 I/O。惩罚已接入 gateResults.dataQuality
- **v3.0.1 回测真实因子限制**：`full_backtest.js` 模拟的 stock 对象缺少 PE/ROE/负债率字段，H4/H5/H6 基本面因子无法触发，仅 H1/H2/H3/H7/H8/H9 生效。完整验证需要历史财务数据
- **v3.0.2 回测数据源**：`discoverAvailableDates()` 从 K 线缓存取实际日期范围。云端当前 ~16 天（2026-05-25 ~ 2026-06-15），全部判为"震荡市"。要获得有意义的多年回测结果，需要历史 K 线数据（通过 Eastmoney/Tencent API 批量拉取或第三方数据源）
- **v3.0.2 compositeScore 返回值类型**：`composite.js` 的 `computeCompositeScore()` 返回对象 `{compositeScore, rating, ...}` 而非数字。使用时需提取 `.compositeScore` 属性并检查 NaN
- **v3.0.2 总控 attributionSummary 依赖**：`computeMasterControlJudgment()` 需要 context.attributionSummary 才能计算 consecutiveLosses 维度。必须传入，否则 severity 始终为 0
- **v3.0.3 止损冷却期**：回测 `STOP_LOSS_COOLDOWN_DAYS = 4`，止损后 4 个交易日内不会重新买入同一只股票。冷却期按自然日计算后扣减非交易日
- **v3.0.3 signalQuality 拆分**：`signalQuality` 现在是候选股命中率（候选股数/正向收益数 %），`factorHitRate` 是因子级信号命中率（信号数/正确信号数 %）。注意 `aggregateRegimes()` 的 `avgSignalQuality` 取的是 `signalQuality` 的均值
- **策略体检 tradingDays < 20**：年化收益率/Sharpe/Sortino/Calmar 全部返回 null，前端显示 "数据不足"
- **策略体检 Canvas Retina**：3 个 Canvas 绘图函数已加 `devicePixelRatio` 适配。注意 `canvas.width/height` 不能通过 HTML 属性写死（会与 DPR 缩放冲突），必须用 CSS 控制尺寸
- **策略体检 inline style 陷阱**：`.sh-cards-row/.sh-chart-row/.sh-detail-row` 的 grid 布局必须在 CSS 定义（不在 HTML inline），否则 `@media` 响应式规则被 inline style 覆盖
- **策略体检渲染双路径**：主路径在 `app.js` renderStrategyHealthDirect()，Canvas 绘制函数在 `templates/strategy-health.js` 全局作用域。修改涉及 DOM 结构需两边同步
- **交易成本数据源**：`computeTradeStats()` 优先读 `trade.costs`（simfolio 精确记录），fallback 到 A 股费率估算（印花税 0.1%+佣金 0.025%+过户费 0.001%）
- **`.gitignore` 运行时数据**：新增运行时数据目录时务必同步更新 .gitignore
