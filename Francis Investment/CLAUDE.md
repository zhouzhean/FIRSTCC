# Francis Investment CLAUDE.md

A股量化交易系统 + 跨市场分析引擎 + 周末深度分析。Node.js 零外部依赖，24/7 阿里云 ECS 运行，全自动采集+评分+模拟交易+盘后总结+美股→A股相关性追踪+周末历史学习。**所有分析面板均回馈到模拟交易引擎，形成"学习循环"。**

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
# 部署代码到云端
scp "C:/Users/anzhe/FIRSTCC/Francis Investment/<path>" "root@8.153.101.112:/root/FIRSTCC/Francis Investment/<path>"
ssh root@8.153.101.112 "systemctl restart mosaic"

# 查看运行状态
ssh root@8.153.101.112 "systemctl status mosaic --no-pager | head -10"
ssh root@8.153.101.112 "journalctl -u mosaic --no-pager -n 20"

# 手动触发生成每日总结（云端）
ssh root@8.153.101.112 "cd '/root/FIRSTCC/Francis Investment' && node -e \"...直接执行 _runDailySummary 逻辑...\""

# 验证 API
curl http://8.153.101.112:8765/api/us-market/current
curl http://8.153.101.112:8765/api/cross-market/analysis
curl http://8.153.101.112:8765/api/news/latest
curl http://8.153.101.112:8765/api/factors/performance
curl http://8.153.101.112:8765/api/weekend-analysis/status

# 手动触发相关性快照（补录丢失的数据点）
ssh root@8.153.101.112 "cd '/root/FIRSTCC/Francis Investment' && node -e \"
  const cm = require('./mosaic/analysis/cross_market');
  cm.recordDailyCorrelationSnapshot(new Date().toISOString().slice(0,10)).then(h => console.log('Done:', h.length, 'points'));
\""
```

---

## 用户档案

- **称呼**：Francis | **总资产**：~14.5万元
- **持仓**：金发科技(600143) 6800股，成本≈17.75元；利欧股份(002131) 2200股，成本≈6.96元
- **偏好**：机器人/科技板块，20元以下低位潜力股，政策驱动型机会
- **跟踪板块**：机器人/具身智能、创新药/AI医疗、半导体/AI算力、商业航天、固态电池/储能、有色金属/稀土、新型电力基建、军工

---

## 项目结构（关键文件）

```
Francis Investment/
├── mosaic_server.js             # ★ HTTP 主服务器 (0.0.0.0:8765)
├── mosaic/                      # ★ 量化引擎
│   ├── config.js                #   所有配置（阈值/权重/时间表/因子名/US_MARKET符号表）→ 改配置只看这个
│   ├── scheduler.js             #   ★ 状态机调度器：tick→状态转换→Pipeline→美股采集→16:00总结+相关性快照+因子绩效
│   ├── pipeline.js              #   主流程编排（EventEmitter）
│   ├── simfolio.js              #   模拟交易引擎（买卖+风控+净值+持久化）
│   ├── collectors/              #   数据采集
│   │   ├── market_data.js       #   A股行情（腾讯+Sina双源）
│   │   ├── us_market.js         #   ★ 美股行情（Sina gb_ API, 30只符号, 60s轮询）
│   │   ├── index_recorder.js    #   指数分钟线记录器
│   │   ├── capital_flow.js      #   资金流
│   │   ├── dragon_tiger.js      #   龙虎榜
│   │   ├── north_bound.js       #   北向资金
│   │   └── news_collector.js    #   新闻采集
│   ├── factors/                 #   评分引擎
│   │   ├── hidden_signals.js    #   ★ H1-H9 隐藏因子（9个）→ computeHiddenSignals()
│   │   └── composite.js         #   ★ 5维综合评分 → computeCompositeScore()
│   └── analysis/                #   盘后+周末分析
│       ├── quant_report.js      #   交易归因+新闻预测
│       ├── knowledge_base.js    #   因子追踪知识库
│       ├── cross_market.js      #   ★ 跨市场相关性引擎 + 风险状态机
│       ├── us_macro.js          #   ★ 美股隔夜总结生成器
│       ├── factor_performance.js #   ★ 因子绩效追踪引擎（命中率/平均收益/趋势）
│       ├── weekend_analyzer.js  #   ★ 周末深度分析引擎（4阶段：聚合→K线→分析→上下文+验证反馈）
│       ├── weekend_verifier.js  #   ★ 周末分析验证引擎（相似度/危机/板块/因子 4维验证→反馈到下周）
├── report-engine/               # ★ 前端（纯静态）
│   ├── index.html               #   主仪表板（8个section，含海外市场+跨市场分析+周末深度分析）
│   ├── think-tank.html          #   ★ AI 思考舱（SSE实时+Canvas指数折线图+扫描记录+因子绩效追踪）
│   ├── app.js                   #   ★ 前端控制器（section导航+异步直渲染+移动端组件+日期过滤）
│   ├── style.css                #   仪表板样式（桌面端+移动端≤720px重写）
│   ├── templates/
│   │   ├── css.js               #   报告内容样式
│   │   ├── us-market.js         #   ★ 海外市场模板（玻璃拟态白主题）
│   │   ├── cross-market.js      #   ★ 跨市场分析模板（Canvas半圆仪表盘+相关性矩阵）
│   │   ├── weekend-analysis.js  #   ★ 周末深度分析模板（相似度卡片+危机仪表盘+板块轮动矩阵+因子效能）
│   │   └── ...                  #   (其他模板: simfolio, news-policy, holdings-analysis, etc.)
│   └── data/
│       ├── simfolio/            #   ★ 运行时：portfolio.json + scheduler_state.json + factor_performance.json + weekend_context.json
│       ├── us_market/           #   ★ 运行时：us_latest.json + correlation_history.json + us_close_*.json
│       ├── market_history/      #   ★ 历史K线存档：indices/sh000001.json + sz399001.json + sz399006.json (Eastmoney日线)
│       ├── events/              #   每日事件日志 YYYY-MM-DD.json
│       ├── summaries/           #   每日盘后总结 YYYY-MM-DD.json
│       └── knowledge_base/      #   AI 知识库
└── deploy.sh                    # 一键部署脚本
```

---

## 核心架构

### 调度器（scheduler.js）— 24/7 自动运行

状态机：`closed → pre_market → morning_session → lunch_break → afternoon_session → post_market → closed`

- 活跃时段 tick 每 20s，空闲时段每 300s
- `IndexRecorder`：交易时段 60s 记录指数分钟线到 `index_history_YYYY-MM-DD.json`，自动清理 7 天前
- **美股采集**：美股活跃时段（16:00-06:00 CST）采集 30 只符号 → `us_latest.json`，SSE 广播
- **美股隔夜总结**：凌晨 5:00 CST 生成盘后总结 → `us_close_YYYY-MM-DD.json`
- 日期切换时自动清空 `scheduledOps`，portfolio 跨天连续
- `_runDailySummary()` 异步 fire-and-forget；16:00 触发 → 盘后总结 + **相关性快照**（US ETF → A股板块）
- 事件日志仅内存保存，`stop()` 时才写入磁盘
- **因子绩效追踪**：每次全量扫描完成后计算并广播因子绩效数据 → SSE `factor_perf` 事件
- **周末深度分析**：周六/周日自动启动→每15分钟一轮→拉取8年历史K线→历史相似度匹配+危机预警+板块轮动+因子效能→生成 `weekend_context.json` 供周一交易决策使用

### 因子绩效追踪（factor_performance.js）

在每次 Pipeline 扫描完成后自动计算：
- 读取 `scan_records_YYYY-MM-DD.json`（fallback `last_pipeline_result.json`）获取各因子的信号触发次数
- 读取 `summaries/YYYY-MM-DD.json` 获取次日市场收益作为 benchmark
- 计算：命中率（信号触发后市场涨的概率）、平均收益、5日/20日滚动命中率、趋势方向
- 输出到 `factor_performance.json`，API `GET /api/factors/performance`，SSE 广播到 Think-Tank
- 需 ≥2 天数据后才出命中率，≤1 天只显示信号计数

### 隐藏因子（hidden_signals.js）

9 个隐藏因子，每个返回 `{ triggered: bool, signal: 'strong'|'medium'|'weak', detail: str }`：

| ID | 名称 | 类别 | 含义 |
|----|------|------|------|
| H1 | 缩量止跌 | 技术 | 成交量萎缩+跌幅收窄=卖盘枯竭 |
| H2 | 底部放量 | 技术 | 大跌+巨量=恐慌抛售，可能最后一跌 |
| H3 | 逆势抗跌 | 市场 | 大盘跌但个股涨=相对强度 |
| H4 | PE低估 | 基本面 | PE<12+低负债+营收增长=价值洼地 |
| H5 | 高ROE低PB | 基本面 | ROE>15%+PB<1.5=格雷厄姆式价值 |
| H6 | 现金流健康 | 基本面 | OCF为正+低负债+高净利率 |
| H7 | 低换手蓄力 | 技术 | 换手<1%+波动<2%=筹码锁定 |
| H8 | 短期反转 | 技术 | 5日跌幅大+今日止跌=反弹动能 |
| H9 | 量价背离 | 技术 | 量缩价稳=吸筹信号 |

### 综合评分（composite.js）

5 维加权：fundamental(25%) + technical(15%) + hidden(20%) + capital_flow(25%) + event(15%)

无详细财务数据时自适应降权：fundamental 降至 10%，其他均衡分配。

### Simfolio — 交易日连续

- 初始 ¥100,000，T+1，持仓上限 5 只，单只 ≤30%
- `loadPortfolio()` 始终从 `portfolio.json` 读取，**不会自动重置**
- 买入阈值：百分位 Top 20% + 绝对分 ≥50；强信号 → 投入 20% 现金
- 卖出：硬止损 -8% / 软止损 评分<50 / 移动止盈
- **T+1 严格限制**：当天买入的股票只有硬止损(-8%)可触发卖出，移动止盈/止盈/预警当天不生效
- `checkRiskThresholds` 中 `isBoughtToday` 检查 → 跳过非止损警报
- **周末上下文注入**：`loadWeekendContext()` 读取 `weekend_context.json` → `cross_market`（恐慌/避险全市场-3分+仓位×0.5）、`sector_preference`（`WEEKEND_SECTOR_KEYWORDS` 中文关键词匹配板块+3分）、`position_sizing`（防守×0.5）、`regime_alert`（风险惩罚）
- `WEEKEND_SECTOR_KEYWORDS` 使用中文板块名直接匹配（如"半导体/AI算力"），不再需要英中转译
- **portfolio.json.bak** 自动备份

### 反馈闭环（4条"学习回路"）

所有分析面板的结果均回馈到模拟交易引擎，形成 AI 量化交易员持续进化的循环：

| # | 回路 | 数据流 | 核心文件 |
|---|------|--------|---------|
| **1** | 周末验证→分析引擎 | 上周验证报告→`_loadLastVerification()`→调整本周 insight 权重/门槛/方向（5维：危机门槛±10/相似度降权/板块权重归零/板块偏好翻转/仓位建议抑制）→`weekend_context.json` | `weekend_analyzer.js` + `weekend_verifier.js` |
| **2** | 北向资金→评分降权 | Pipeline 记录 NB sentiment→`updateNBSentimentRecord()`→计算命中率→`getNBPerformance()`→`composite.js` 按 HOT/COLD 动态调整 NB 权重（COLD=×0.33） | `factor_performance.js` + `composite.js` + `pipeline.js` + `scheduler.js` |
| **3** | 知识库→交易决策 | 每日分析存入 knowledge_base→`getKnowledgeSummary()`→`checkThinkTankGate()` 检查历史高效因子当前是否偏冷→触发防御模式 | `knowledge_base.js` + `simfolio.js` |
| **4** | 思考舱→防御门 | 4维综合评分（因子健康+持仓压力+跨市场风险+知识库历史）→score≥3→防御模式→跳过所有买入（仅允许卖出） | `simfolio.js` (`checkThinkTankGate()`) + `mosaic_server.js` (`generateTodaysVerdict()`) |

**关键设计原则**：
- **闭环 1+2 是"学习回路"**：系统从过去的预测错误中学习，自动调整参数——周末分析的验证结果反馈到下一周的预测，北向资金的命中率反馈到综合评分权重
- **闭环 3+4 是"防御回路"**：系统综合多个维度判断当前市场是否适合交易——知识库的历史经验、因子信号的健康度、持仓的压力状态、跨市场的宏观风险——形成"思维舱"的防御性判断
- 所有回路需要真实交易数据积累才能生效（验证反馈需1-2周，NB绩效需≥5信号日，知识库需≥2天）
- `checkThinkTankGate()` 在 `makeTradingDecisions()` 的 Step 3.5（市场方向门之后、宏观惩罚之前）执行

### 数据源（见 config.js 完整配置）

腾讯 `qt.gtimg.cn`（主力，含PE）+ Sina `hq.sinajs.cn`（备选，无PE）+ Eastmoney（资金流/龙虎榜/北向）+ Sina 财经 roll（新闻）

### 美股数据采集（us_market.js + scheduler._recordUSMarkets）

- 活跃窗口：**16:00-06:00 CST**（覆盖美股 pre-market 4:00 ET → post-market 20:00 ET）
- 周五 21:00+ 跳过（美股周六凌晨不开），周日 <16:00 跳过
- 美股状态实时计算：`formatUSSessionStatus()` 根据当前北京时间判断 session（pre_market/regular/post_market/closed）
- API `/api/us-market/current` 返回实时 status，不依赖缓存

### 跨市场相关性引擎（analysis/cross_market.js）

**风险状态机**：VXX(VIX) 40% + UUP(美元) 30% + TLT(美债) 30% → 加权评分(-65~+65) → 5 档风险区间 → 仓位建议(10%-90%)

**相关性矩阵**：Pearson R 计算 US ETF 涨跌 ↔ A股板块涨跌（8 对映射），+ 方向命中率 + 近5日趋势

**数据流**：每日 16:00 `_runDailySummary()` → `recordDailyCorrelationSnapshot()` → 读 `us_latest.json`（今凌晨美股收盘价）+ 实时查询 Sina A股板块代表股 → 写入 `correlation_history.json`（保留60个交易日）

⚠️ 需要 5 个交易日数据后相关性矩阵才有统计意义。16:00 快照若被服务器重启中断，当天数据会丢失（fire-and-forget）。

### 周末深度分析引擎（analysis/weekend_analyzer.js）

周六/周日全天自动运行，4 阶段分析循环，**所有输出为中文（无 emoji）**：

**Phase 1 — 数据聚合**：加载所有 summaries/events/knowledge_base/portfolio/correlation_history/factor_performance → 构建市场画像

**Phase 2 — 历史K线采集**：从 Eastmoney API 拉取上证/深证/创业板日K线（首次~2000条=~8年），存到 `data/market_history/indices/`，后续增量更新

**Phase 3 — 深度分析**：
- **历史相似度**：Z-score 标准化 6 维特征向量（涨跌幅/量比/上涨天数占比/量趋势/ATR/新高新低比）→ 余弦相似度匹配 → top 5 最相似时期（5日滑动窗口），展示后续 5/10/20 日走势。相似度标签：极高(>80%)/高(60-80%)/中等(40-60%)/低(<40%)
- **危机预警**：6 维度加权评分（流动性25%/估值20%/市场宽度20%/北向15%/两融10%/波动率10%）→ 综合0-100分 → 5 档中文标签（高风险/风险偏高/风险适中/低风险/极低风险）+ 仓位建议
- **板块轮动**：8×8 领先/滞后/同步矩阵（中文板块名+中文关系值）。矩阵行=该板块相对其他板块的关系（横向读判断谁是龙头），列=其他板块相对该板块的关系（纵向读判断谁被拖着走）。阶段判定：防御期/周期扩散/回调洗牌，`_SECTOR_DISPLAY` 映射中英文板块名
- **因子效能**：9 因子 H1-H9 全中文名+分类（技术/基本面/市场），命中率/信号次数/趋势，数据不足时 hitRate 为 null

**Phase 4 — 增强上下文（含验证反馈）**：`_loadLastVerification()` 读取上周验证报告→5维调整本周 insight（危机门槛、相似度权重、板块偏好权重/方向、仓位建议）→生成 `data/simfolio/weekend_context.json`（insights数组+verificationContext，全中文，有效期覆盖到周一），周一 `simfolio.makeTradingDecisions()` 自动读取并注入：
- `cross_market` → 恐慌/避险时全市场 -3 分 + 仓位 ×0.5（新增）
- `regime_alert` → 额外风险惩罚（验证反馈可能调整门槛和权重）
- `sector_preference` → `WEEKEND_SECTOR_KEYWORDS` 中文直接匹配偏好板块买入候选 +3 分（验证反馈可能降权归零或翻转方向）
- `position_sizing` → 现金分配系数调整（防守模式 ×0.5，验证反馈可能抑制过度减仓）
- `historical_parallel` → 历史相似窗口方向提示（验证反馈 D/F 级时权重归零）
- `historical_parallel` → 历史相似窗口方向提示

**循环机制**：首轮执行 Phase 1-4（含K线拉取），后续每 15 分钟执行 Phase 3-4，每 2 小时增量拉取 K 线。

**集成点**：scheduler `_tick()` 检测周末→`startWeekendAnalysis()`；非周末→`stopWeekendAnalysis()`；SSE `weekend` 事件广播进度。

### 盘后总结生成流程

`16:00后 tick` → `_runDailySummary()` → 采集指数+持仓+交易+新闻 → `quantReport.buildTradeAnalysis()` → 写入 `summaries/YYYY-MM-DD.json` + `knowledge_base/YYYY-MM-DD.json` + 触发相关性快照

---

## 前端架构

### Section 导航（index.html / app.js）

**桌面端**：左侧 sidebar 苹果风玻璃按钮（毛玻璃 `backdrop-filter: blur` + 半透明白底 + 渐变小圆点替代 emoji + 金色激活态发光）
**移动端 (≤720px)**：顶部 sticky `#mobile-top-bar`，包含 date-strip + section-tabs（模拟交易/时政要点/交易分析与报告/海外市场/跨市场分析，周末增加"周末分析"，可左右滑动）。持仓分析和 AI 知识库不在移动端 tabs 中显示。

| ID | 标签 | 渲染方式 | 时间限制 |
|----|------|---------|---------|
| `simfolio` | 模拟交易 | `renderSimfolioLive()` 实时 | 始终可用 |
| `newsPolicy` | 时政要点 | `renderNewsPolicySection()` → API | 16:00后 |
| `tradingReport` | 交易分析与报告 | `renderTradeAnalysisSection()` → API | 16:00后 |
| `holdingsAnalysis` | 持仓分析 | `renderSectionByTime()` | 16:00后 |
| `usMarket` | 海外市场 | `renderUSMarketDirect()` → API `/api/us-market/current` | 始终可用 |
| `crossMarket` | 跨市场分析 | `renderCrossMarketDirect()` → API `/api/cross-market/analysis` | 始终可用 |
| `weekendAnalysis` | 周末深度分析 | `renderWeekendAnalysisDirect()` → API `/api/weekend-analysis/report` | 仅周末显示 |
| `knowledgeBase` | AI 知识库 | `renderKnowledgeBaseSection()` → API | 始终可用 |

自动交易 toast 通知：右上角滑入，毛玻璃背景 + 关闭按钮 + 点击关闭 + 6s 自动消失 + 多条堆叠不覆盖。`_notifiedTradeIds` 存 localStorage，按日期隔离——当天弹过的交易不再弹，过了当天自动清除。页面刷新/跨天不会重复弹窗。

`usMarket`、`crossMarket` 和 `weekendAnalysis` 使用**异步直渲染模式**：清空 contentArea → 创建容器 → `setTimeout` 后 fetch API → 填充 DOM。绕过 `renderTimeAwareSectionDirect()`，在 `renderCurrentSection()` 中直接分发。

### 日历与历史日期（app.js）

- 左侧日历支持点击切换日期，周末不可点击（灰色）
- 点击历史日期后 `state.simfolioData` 置空，从 `/api/daily-summary/latest?date=` 加载历史快照（alpha/benchmark 显示 "--"）
- 所有 API 调用自动附加 `?date=` 参数当 `cal.activeDate !== today`
- Simfolio 后台刷新在历史模式下自动跳过
- **交易动态日期过滤**：`renderTradeActivityFeed()` 按 `cal.activeDate` 过滤，只显示选中日期的交易
- **板块实时走势日期限制**：`renderSectorLiveChart()` 在历史日期显示"历史日期无实时板块数据"，不请求实时 API

### 移动端组件 (≤720px, index.html)

| 组件 | ID | 说明 |
|------|-----|------|
| Date Strip | `#date-strip` | 水平滑动 ±7 天日期胶囊，左右箭头跳 5 天，日历按钮弹出 overlay |
| Section Tabs | `#section-tabs` | 5 个苹果风玻璃标签页（模拟交易/时政要点/交易分析与报告/海外市场/跨市场分析），可左右滑动 |
| Calendar Overlay | `#cal-overlay` | 点击 📅 弹出，复用 `renderCalendar()`，背景毛玻璃 |
| Report Ribbon | `#report-ribbon` | 底部报告快速切换条，显示最近 6 份报告 |

- `getMarketTimeState()` 返回 `trading` / `generating` / `ready` / `closed`
- 时政要点底部有 🔮 AI 新闻影响预测卡片（由 `generateNewsImpactPrediction()` 生成）
- 交易分析底部有 🧠 知识库摘要卡片
- 选历史日期后自动折叠 calendar overlay

### Think-Tank 页面（think-tank.html）

AI 思考舱，独立页面。两栏布局：

**左侧 — AI 思维流**：
- 实时思维显示（扫描线动画 + 思维内容 + 进度条）
- **指数分钟折线图**（Canvas 百分比模式：上证红/深证蓝/北证绿，30s 轮询）
- **今日扫描记录**：显示当日扫描历史（次数 + TOP5 股票名称）
- **因子绩效追踪**：3×3 卡片网格，每个因子一张卡片，含 Canvas 圆形仪表盘（命中率%）+ 微型折线图（信号趋势）+ 状态标签（HOT/STABLE/COLD）。数据来自 `/api/factors/performance` + SSE `factor_perf` 事件

**右侧 — 隐藏因子扫描**：
- H1-H9 因子柱状图（触发次数）
- 评分分布直方图（<50/50-60/60-70/70-80/80+）
- 市场情报（LHB数/板块资金/北向情绪）
- TOP 5 最新推荐
- **智能风险中枢**：3张动态卡片（资金面热度/波动率状态/Smart Money），数据来自 `/api/market/microstructure`，60s 轮询，含脉冲呼吸灯+柱状图+波动率指针+板块标签等动态效果

**底部**：事件时间线 + 持仓监控条

SSE 实时事件流：`scan_start` → `progress` → `stock_analyzed` → `stats` → `scan_complete` → `factor_perf` + trade/position/state/alert/usmarket

### 智能风险中枢（/api/market/microstructure）

聚合 A 股资金面 + 波动率数据，一次请求返回三个维度：

| 卡片 | 指标 | 数据源 |
|------|------|--------|
| **资金面热度** | 北向情绪（bullish/slightly_bullish/neutral/bearish）+ 连续流入天数 + 5日方向柱状图 | `north_bound.js` → Eastmoney kamt.kline |
| **波动率状态** | 上证 20 日年化历史波动率 + 5档标签（低/正常/偏高/高）+ 渐变色指针 | 每日总结 `summaries/YYYY-MM-DD.json` 指数收盘价 |
| **Smart Money** | 主力（超大单）vs 散户（小单）资金背离度 + 板块流入/流出标签 | `capital_flow.js` → Eastmoney 板块资金流 |

- 北向数据 `computeSentiment()` 分类：连续 ≥5 日流入 = bullish，≥3 日 = slightly_bullish，单日流出 >50 亿 = bearish
- 波动率从 daily summary 的指数 close price 计算 log return → annualized HV
- `computeFlowPerformance()` 在 `factor_performance.js` 中预留了资金面信号准确率追踪接口

### 关键 API（详见 mosaic_server.js）

所有 `/api/news/latest`, `/api/analysis/latest`, `/api/daily-summary/latest` 支持 `?date=YYYY-MM-DD` 查询历史日期。

| 路由 | 用途 |
|------|------|
| `/api/status` | 服务器状态+交易日 |
| `/api/simfolio/status` | 模拟账户快照 |
| `/api/pipeline/run` | 手动触发全量扫描（POST） |
| `/api/scheduler/status` | 调度器状态 |
| `/api/news/latest` | 新闻+影响预测（支持 ?date=） |
| `/api/analysis/latest` | 交易归因分析（支持 ?date=） |
| `/api/daily-summary/latest` | 每日盘后总结（支持 ?date=） |
| `/api/knowledge/summary` | 知识库摘要 |
| `/api/indices/today` | 指数分钟线数据（支持 ?date=） |
| `/api/think-tank/stream` | SSE 实时事件流 |
| `/api/think-tank/initial` | Think-Tank 初始数据（含因子绩效） |
| `/api/us-market/current` | ★ 美股实时快照（含实时状态） |
| `/api/us-market/status` | ★ 美股市场状态 |
| `/api/us-market/summary` | ★ 美股隔夜总结（支持 ?date=） |
| `/api/us-market/intraday` | 美股日内分钟线（支持 ?date=） |
| `/api/cross-market/analysis` | ★ 跨市场分析 |
| `/api/cross-market/risk-state` | 风险状态机单独查询 |
| `/api/cross-market/correlation` | 相关性矩阵单独查询 |
| `/api/factors/performance` | ★ 因子绩效追踪数据 |
| `/api/market/microstructure` | ★ 智能风险中枢（北向+波动率+Smart Money） |
| `/api/sectors/live` | 板块实时行情（Sina 实时，仅当日） |
| `/api/weekend-analysis/status` | ★ 周末分析进度/状态 |
| `/api/weekend-analysis/report` | ★ 周末完整报告（相似度+危机+轮动+因子） |
| `/api/weekend-analysis/context` | ★ 周末增强上下文（simfolio 周一读取） |
| `/api/weekend-analysis/history` | 历史相似度匹配结果 |

---

## ⚠ 关键约束

### 数据准确性铁律
- **所有股价/涨跌幅/PE/成交额必须实时查询，绝不估算**
- 每只潜力股单独查询，PE 亏损写 "亏损" 或 null
- section5、recommendation-history、section6 三处数据完全一致

### 部署优先级
- **云端永远优先**：任何新功能/修复完成后，立即 scp 到 `root@8.153.101.112:/root/FIRSTCC/Francis Investment/` 并 `systemctl restart mosaic`
- 部署文件清单：`mosaic_server.js`, `mosaic/` 下所有改动, `report-engine/` 下所有前端文件
- 部署后必须 curl 验证云端 API 返回正确

### 文件修改规则
- **绝不提交运行时数据**：`portfolio.json`, `scheduler_state.json`, `events/*.json`, `summaries/*.json`, `knowledge_base/*.json`, `index_history_*.json`, `us_latest.json`, `correlation_history.json`, `us_close_*.json`, `us_intraday_*.json`, `factor_performance.json`, `scan_records_*.json`, `last_pipeline_result.json`, `weekend_context.json`, `market_history/indices/*.json`, `weekend_archive/*.json`
- **config.js 是唯一配置入口**：改阈值/权重/时间表/US_MARKET符号表只需改这一个文件
- **前端无 fetch polyfill**：旧浏览器可能不支持
- **`report-engine/data/` 是 DATA_DIR**：所有运行时数据在此目录下，不在 `mosaic/` 下

### Think-Tank 页面

- 指数显示使用 Canvas 折线图（上证红/深证蓝/北证绿），30s 轮询 `/api/indices/today`
- **折线图改用百分比模式**：以各自开盘价为 0% 基准，Y 轴显示涨跌幅百分比，带零线参考
- 扫描记录持久化到 localStorage，按上午/下午分 session（`YYYY-MM-DD-am` / `YYYY-MM-DD-pm`），最多50条
- **扫描记录服务器端持久化**：`_saveLastPipelineResult` 写入 `scan_records_YYYY-MM-DD.json`（包含 signalCounts，最多20条），`/api/think-tank/initial` 返回 `scanRecords`
- **前端双路径加载**：优先从 `scanRecords` API 加载，fallback 从 `todayEvents` 提取扫描事件
- SSE 事件：`scan_complete`、`scheduler_status`、`think_usmarket`（美股实时更新）、`factor_perf`（因子绩效）触发 UI 刷新
- 美股 SSE 事件含 indices/macro/status 字段，Think-Tank 可订阅展示美股实时卡片
- **因子绩效追踪面板**：位于左侧扫描记录下方，3×3 卡片网格，Canvas 仪表盘+折线图，数据源 `/api/factors/performance` + SSE

### 已知陷阱
- **SSH 路径含空格**：必须用引号包裹 → `"/root/FIRSTCC/Francis Investment/..."`
- **git push 偶发 connection reset**：重试即可，网络问题
- **scheduler 的 `_runDailySummary()` 无 await**：async 函数 fire-and-forget，错误不会抛到 tick。16:00 附近重启服务器会导致当天总结+相关性快照丢失
- **Eastmoney push2 K线 API 不可用**：基本面评分会自适应降权（25%→10%）
- **Tencent API 每批 60 只**：全量扫描需分批，Sina 备选每批 80 只
- **portfolio.json 损坏时有 .bak 自动恢复**：不要手动删除 .bak 文件
- **移动端 `renderCalendar()` 被复用**：calendar overlay 中需临时替换 `$calendarWidget` 指向 popup 容器，退出时恢复
- **⚠ `git pull` 会覆盖运行时数据**：`.gitignore` 已排除 data 目录，但如果新增运行时文件必须确认不在 git 追踪中
- **跨市场相关性需要 5 个交易日累积**：首次部署后 correlation matrix 显示 "BUILDING DATA"，需等待一周才有统计意义
- **美股 Sina gb_ API 无官方文档**：延迟或限流时可能返回空数据，采集器已设超时
- **因子绩效追踪需 ≥2 天数据**：命中率在积累 2 天 scan_records 后才开始计算，首日只显示信号计数
- **scan_records 文件的 signalCounts**：全量扫描（full）写入信号计数，盘中扫描（mid）记录 `signals` 字段（非 `hiddenSignals`），`_saveLastPipelineResult` 同时兼容两种字段名
- **周末分析中文化**：所有输出（API + UI 模板）均为中文，无 emoji。`weekend_context.json` 中板块名用中文，simfolio 用 `WEEKEND_SECTOR_KEYWORDS` 中文匹配
- **cross_market 风险状态 5 档**：panic(恐慌)/risk_off(避险)/risk_on(风险偏好)/slightly_bullish(温和看涨)/neutral(中性)，全部有中文映射
- **因子命中率需要 ≥2 天 scan_records**：`factor_performance.json` 中 `factors` 为数组（非对象），需用 `Array.find` 查找。数据不足时 hitRate 为 null
- **correlation_history.json 不含"金融"板块**：8×8 矩阵中金融行/列全为 "-"（22 个），是数据源限制而非 bug
- **周末分析引擎 `_runFullCycle` 为 async 自循环**：通过 setInterval 调用，错误不会冒泡。首次K线拉取 ~3-5s（3只指数 × Eastmoney API），后续增量仅拉差异天数。`weekend_context.json` 有效期 3 天覆盖到周一
