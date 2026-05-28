# Francis Investment CLAUDE.md

A股量化交易系统 + 跨市场分析引擎。Node.js 零外部依赖，24/7 阿里云 ECS 运行，全自动采集+评分+模拟交易+盘后总结+美股→A股相关性追踪。

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
│   ├── scheduler.js             #   ★ 状态机调度器：tick→状态转换→Pipeline→美股采集→16:00总结+相关性快照
│   ├── pipeline.js              #   主流程编排（EventEmitter）
│   ├── simfolio.js              #   模拟交易引擎（买卖+风控+净值+持久化）
│   ├── collectors/              #   数据采集
│   │   ├── market_data.js       #   A股行情（腾讯+Sina双源）
│   │   ├── us_market.js         #   ★ 美股行情（Yahoo Finance, 30只符号, 60s/120s轮询）
│   │   ├── index_recorder.js    #   指数分钟线记录器
│   │   ├── capital_flow.js      #   资金流
│   │   ├── dragon_tiger.js      #   龙虎榜
│   │   ├── north_bound.js       #   北向资金
│   │   └── news_collector.js    #   新闻采集
│   ├── factors/                 #   评分引擎（hidden_signals 9因子 + composite 5维 + event_signals）
│   └── analysis/                #   盘后分析
│       ├── quant_report.js      #   交易归因+新闻预测
│       ├── knowledge_base.js    #   因子追踪知识库
│       ├── cross_market.js      #   ★ 跨市场相关性引擎 + 风险状态机
│       └── us_macro.js          #   ★ 美股隔夜总结生成器
├── report-engine/               # ★ 前端（纯静态）
│   ├── index.html               #   主仪表板（7个section，含海外市场+跨市场分析）
│   ├── think-tank.html          #   AI 思考舱（SSE 实时 + Canvas 指数折线图 + 扫描记录）
│   ├── app.js                   #   ★ 前端控制器（section导航+异步直渲染+移动端组件）
│   ├── style.css                #   仪表板样式（桌面端+移动端≤720px重写）
│   ├── templates/
│   │   ├── css.js               #   报告内容样式
│   │   ├── us-market.js         #   ★ 海外市场模板（玻璃拟态白主题）
│   │   ├── cross-market.js      #   ★ 跨市场分析模板（Canvas半圆仪表盘+相关性矩阵）
│   │   └── ...                  #   (其他模板: simfolio, news-policy, holdings-analysis, etc.)
│   └── data/
│       ├── simfolio/            #   ★ 运行时：portfolio.json + scheduler_state.json
│       ├── us_market/           #   ★ 运行时：us_latest.json + correlation_history.json + us_close_*.json
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
- **美股采集**：美股时段（21:30-04:00 CST）60s 采集 30 只符号 → `us_latest.json`，SSE 广播
- **美股隔夜总结**：凌晨 5:00 CST 生成盘后总结 → `us_close_YYYY-MM-DD.json`
- 日期切换时自动清空 `scheduledOps`，portfolio 跨天连续
- `_runDailySummary()` 异步 fire-and-forget；16:00 触发 → 盘后总结 + **相关性快照**（US ETF → A股板块）
- 事件日志仅内存保存，`stop()` 时才写入磁盘

### Simfolio — 交易日连续

- 初始 ¥100,000，T+1，持仓上限 5 只，单只 ≤30%
- `loadPortfolio()` 始终从 `portfolio.json` 读取，**不会自动重置**
- 买入阈值：百分位 Top 20% + 绝对分 ≥50；强信号 → 投入 20% 现金
- 卖出：硬止损 -8% / 软止损 评分<50 / 移动止盈
- **T+1 严格限制**：当天买入的股票只有硬止损(-8%)可触发卖出，移动止盈/止盈/预警当天不生效
- `checkRiskThresholds` 中 `isBoughtToday` 检查 → 跳过非止损警报
- **portfolio.json.bak** 自动备份

### 数据源（见 config.js 完整配置）

腾讯 `qt.gtimg.cn`（主力，含PE）+ Sina `hq.sinajs.cn`（备选，无PE）+ Eastmoney（资金流/龙虎榜/北向）+ Sina 财经 roll（新闻）

### 美股数据采集（scheduler._recordUSMarkets）

美股交易时段（21:30-04:00 CST）每 60s 自动采集 30 只符号（指数/宏观/ADR/板块ETF/情绪标杆），写入 `us_latest.json`，SSE 广播 `think_usmarket` 事件供 Think-Tank 实时消费。

### 跨市场相关性引擎（analysis/cross_market.js）

**风险状态机**：VXX(VIX) 40% + UUP(美元) 30% + TLT(美债) 30% → 加权评分(-65~+65) → 5 档风险区间 → 仓位建议(10%-90%)

**相关性矩阵**：Pearson R 计算 US ETF 涨跌 ↔ A股板块涨跌（8 对映射），+ 方向命中率 + 近5日趋势

**数据流**：每日 16:00 `_runDailySummary()` → `recordDailyCorrelationSnapshot()` → 读 `us_latest.json`（今凌晨美股收盘价）+ 实时查询 Sina A股板块代表股 → 写入 `correlation_history.json`（保留60个交易日）

⚠️ 需要 5 个交易日数据后相关性矩阵才有统计意义。16:00 快照若被服务器重启中断，当天数据会丢失（fire-and-forget）。

### 盘后总结生成流程

`16:00后 tick` → `_runDailySummary()` → 采集指数+持仓+交易+新闻 → `quantReport.buildTradeAnalysis()` → 写入 `summaries/YYYY-MM-DD.json` + `knowledge_base/YYYY-MM-DD.json` + 触发相关性快照

---

## 前端架构（app.js）

### Section 导航

**桌面端**：左侧 sidebar 苹果风玻璃按钮（毛玻璃 `backdrop-filter: blur` + 半透明白底 + 渐变小圆点替代 emoji + 金色激活态发光）
**移动端 (≤720px)**：顶部 sticky `#mobile-top-bar`，包含 date-strip + section-tabs（5标签页：模拟交易/时政要点/交易分析与报告/海外市场/跨市场分析，可左右滑动）。持仓分析和 AI 知识库不在移动端 tabs 中显示。

| ID | 标签 | 渲染方式 | 时间限制 |
|----|------|---------|---------|
| `simfolio` | 模拟交易 | `renderSimfolioLive()` 实时 | 始终可用 |
| `newsPolicy` | 时政要点 | `renderNewsPolicySection()` → API | 16:00后 |
| `tradingReport` | 交易分析与报告 | `renderTradeAnalysisSection()` → API | 16:00后 |
| `holdingsAnalysis` | 持仓分析 | `renderSectionByTime()` | 16:00后 |
| `usMarket` | 海外市场 | `renderUSMarketDirect()` → API `/api/us-market/current` | 始终可用 |
| `crossMarket` | 跨市场分析 | `renderCrossMarketDirect()` → API `/api/cross-market/analysis` | 始终可用 |
| `knowledgeBase` | AI 知识库 | `renderKnowledgeBaseSection()` → API | 始终可用 |

自动交易 toast 通知：右上角滑入，毛玻璃背景 + 关闭按钮 + 点击关闭 + 6s 自动消失 + 多条堆叠不覆盖 + `_notifiedTradeIds` 对象防重复弹窗。

`usMarket` 和 `crossMarket` 使用**异步直渲染模式**：清空 contentArea → 创建容器 → `setTimeout` 后 fetch API → 填充 DOM。绕过 `renderTimeAwareSectionDirect()`，在 `renderCurrentSection()` 中直接分发。

### 日历与历史日期

- 左侧日历支持点击切换日期，周末不可点击（灰色）
- 点击历史日期后 `state.simfolioData` 置空，从 `/api/daily-summary/latest?date=` 加载历史快照（alpha/benchmark 显示 "--"）
- 所有 API 调用自动附加 `?date=` 参数当 `cal.activeDate !== today`
- Simfolio 后台刷新在历史模式下自动跳过

### 移动端组件 (≤720px)

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

### 关键 API（详见 mosaic_server.js）

所有 `/api/news/latest`, `/api/analysis/latest`, `/api/daily-summary/latest` 支持 `?date=YYYY-MM-DD` 查询历史日期。

| 路由 | 用途 |
|------|------|
| `/api/status` | 服务器状态+交易日 |
| `/api/simfolio/status` | 模拟账户快照 |
| `/api/pipeline/run` | 手动触发全量扫描 |
| `/api/scheduler/status` | 调度器状态 |
| `/api/news/latest` | 新闻+影响预测（支持 ?date=） |
| `/api/analysis/latest` | 交易归因分析（支持 ?date=） |
| `/api/daily-summary/latest` | 每日盘后总结（支持 ?date=） |
| `/api/knowledge/summary` | 知识库摘要 |
| `/api/indices/today` | 指数分钟线数据（支持 ?date=） |
| `/api/think-tank/stream` | SSE 实时事件流 |
| `/api/us-market/current` | ★ 美股实时快照（含指数/宏观/ADR/板块ETF/情绪标杆） |
| `/api/us-market/status` | ★ 美股市场状态（open/closed + 下次开盘倒计时） |
| `/api/us-market/summary` | ★ 美股隔夜总结（支持 ?date=，含A股盘前参考） |
| `/api/us-market/intraday` | 美股日内分钟线（支持 ?date=） |
| `/api/cross-market/analysis` | ★ 跨市场分析（风险状态+相关性矩阵+板块展望） |
| `/api/cross-market/risk-state` | 风险状态机单独查询（轻量） |
| `/api/cross-market/correlation` | 相关性矩阵单独查询 |

---

## ⚠ 关键约束

### 数据准确性铁律
- **所有股价/涨跌幅/PE/成交额必须实时查询，绝不估算**
- 每只潜力股单独查询，PE 亏损写 "亏损" 或 null
- section5、recommendation-history、section6 三处数据完全一致

### 文件修改规则
- **绝不提交运行时数据**：`portfolio.json`, `scheduler_state.json`, `events/*.json`, `summaries/*.json`, `knowledge_base/*.json`, `index_history_*.json`, `us_latest.json`, `correlation_history.json`, `us_close_*.json`, `us_intraday_*.json`
- **config.js 是唯一配置入口**：改阈值/权重/时间表/US_MARKET符号表只需改这一个文件
- **前端无 fetch polyfill**：旧浏览器可能不支持
- **`report-engine/data/` 是 DATA_DIR**：所有运行时数据在此目录下，不在 `mosaic/` 下

### Think-Tank 页面

- 指数显示使用 Canvas 折线图（上证红/深证蓝/北证绿），30s 轮询 `/api/indices/today`
- **折线图改用百分比模式**：以各自开盘价为 0% 基准，Y 轴显示涨跌幅百分比，带零线参考
- 扫描记录持久化到 localStorage，按上午/下午分 session（`YYYY-MM-DD-am` / `YYYY-MM-DD-pm`），最多50条
- **扫描记录服务器端持久化**：`_saveLastPipelineResult` 写入 `scan_records_YYYY-MM-DD.json`（最多20条），`/api/think-tank/initial` 返回 `scanRecords`
- **前端双路径加载**：优先从 `scanRecords` API 加载，fallback 从 `todayEvents` 提取扫描事件
- SSE 事件：`scan_complete`、`scheduler_status`、`think_usmarket`（美股实时更新）触发 UI 刷新
- 美股 SSE 事件含 indices/macro/status 字段，Think-Tank 可订阅展示美股实时卡片

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
- **美股 Yahoo Finance API 无官方文档**：延迟或限流时可能返回空数据，采集器已设 45s 超时
