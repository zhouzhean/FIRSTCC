# Francis Investment CLAUDE.md

A股量化交易系统。Node.js 零外部依赖，24/7 阿里云 ECS 运行，全自动采集+评分+模拟交易+盘后总结。

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
curl http://8.153.101.112:8765/api/news/latest
curl http://8.153.101.112:8765/api/analysis/latest
curl http://8.153.101.112:8765/api/knowledge/summary
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
│   ├── config.js                #   所有配置（阈值/权重/时间表/因子名）→ 改配置只看这个
│   ├── scheduler.js             #   ★ 状态机调度器：tick→状态转换→Pipeline→持仓监控→16:00总结
│   ├── pipeline.js              #   主流程编排（EventEmitter）
│   ├── simfolio.js              #   模拟交易引擎（买卖+风控+净值+持久化）
│   ├── collectors/              #   数据采集（market_data/capital_flow/dragon_tiger/north_bound/news_collector）
│   ├── factors/                 #   评分引擎（hidden_signals 9因子 + composite 5维 + event_signals）
│   └── analysis/                #   盘后分析（quant_report 交易归因+新闻预测 + knowledge_base 因子追踪）
├── report-engine/               # ★ 前端（纯静态）
│   ├── index.html               #   主仪表板
│   ├── think-tank.html          #   AI 思考舱（SSE 实时）
│   ├── app.js                   #   ★ 前端控制器（section导航+API调用+渲染）
│   ├── style.css                #   仪表板样式（含移动端≤720px/≤400px）
│   ├── templates/css.js         #   报告内容样式（含移动端≤768px/≤480px）
│   └── data/
│       ├── simfolio/            #   ★ 运行时数据（portfolio.json + scheduler_state.json）
│       ├── events/              #   每日事件日志 YYYY-MM-DD.json
│       ├── summaries/           #   每日盘后总结 YYYY-MM-DD.json（含 news + tradeAnalysis）
│       └── knowledge_base/      #   AI 知识库（factor_tracker.json + YYYY-MM-DD.json）
└── deploy.sh                    # 一键部署脚本
```

---

## 核心架构

### 调度器（scheduler.js）— 24/7 自动运行

状态机：`closed → pre_market → morning_session → lunch_break → afternoon_session → post_market → closed`

- 活跃时段 tick 每 20s，空闲时段每 300s
- 日期切换时自动清空 `scheduledOps`，portfolio 跨天连续
- `_runDailySummary()` 异步执行（含 await 网络请求），调用时无 await（fire-and-forget）
- 事件日志仅内存保存，`stop()` 时才写入磁盘；`daily_summary_start/completed` 不输出到 console（不在 importantTypes 列表）

### Simfolio — 交易日连续

- 初始 ¥100,000，T+1，持仓上限 5 只，单只 ≤30%
- `loadPortfolio()` 始终从 `portfolio.json` 读取，**不会自动重置**
- 买入阈值：百分位 Top 20% + 绝对分 ≥50；强信号 → 投入 20% 现金
- 卖出：硬止损 -8% / 软止损 评分<50 / 移动止盈
- **portfolio.json.bak** 自动备份

### 数据源（见 config.js 完整配置）

腾讯 `qt.gtimg.cn`（主力，含PE）+ Sina `hq.sinajs.cn`（备选，无PE）+ Eastmoney（资金流/龙虎榜/北向）+ Sina 财经 roll（新闻）

### 盘后总结生成流程

`16:00后 tick` → `_runDailySummary()` → 采集指数+持仓+交易+新闻 → `quantReport.buildTradeAnalysis()` → 写入 `summaries/YYYY-MM-DD.json` + `knowledge_base/YYYY-MM-DD.json`

---

## 前端架构（app.js）

### Section 导航（左侧边栏）

| ID | 标签 | 渲染方式 | 时间限制 |
|----|------|---------|---------|
| `simfolio` | 模拟交易 | `renderSimfolioLive()` 实时 | 始终可用 |
| `newsPolicy` | 时政要点 | `renderNewsPolicySection()` → API `/api/news/latest` | 16:00后 |
| `tradingReport` | 交易分析与报告 | `renderTradeAnalysisSection()` → API `/api/analysis/latest` | 16:00后 |
| `holdingsAnalysis` | 持仓分析 | `renderSectionByTime()` | 16:00后 |
| `knowledgeBase` | AI 知识库 | `renderKnowledgeBaseSection()` → API `/api/knowledge/summary` | 始终可用 |

- `getMarketTimeState()` 返回 `trading` / `generating` / `ready` / `closed`
- 时政要点底部有 🔮 AI 新闻影响预测卡片（由 `generateNewsImpactPrediction()` 生成）
- 交易分析底部有 🧠 知识库摘要卡片

### 关键 API（详见 mosaic_server.js）

| 路由 | 用途 |
|------|------|
| `/api/status` | 服务器状态+交易日 |
| `/api/simfolio/status` | 模拟账户快照 |
| `/api/pipeline/run` | 手动触发全量扫描 |
| `/api/scheduler/status` | 调度器状态 |
| `/api/news/latest` | 今日新闻+影响预测 |
| `/api/analysis/latest` | 交易归因分析 |
| `/api/knowledge/summary` | 知识库摘要 |
| `/api/think-tank/stream` | SSE 实时事件流 |

---

## ⚠ 关键约束

### 数据准确性铁律
- **所有股价/涨跌幅/PE/成交额必须实时查询，绝不估算**
- 每只潜力股单独查询，PE 亏损写 "亏损" 或 null
- section5、recommendation-history、section6 三处数据完全一致

### 文件修改规则
- **绝不提交运行时数据**：`portfolio.json`, `scheduler_state.json`, `events/*.json`, `summaries/*.json`, `knowledge_base/*.json`
- **config.js 是唯一配置入口**：改阈值/权重/时间表只需改这一个文件
- **前端无 fetch polyfill**：旧浏览器可能不支持

### 已知陷阱
- **SSH 路径含空格**：必须用引号包裹 → `"/root/FIRSTCC/Francis Investment/..."`
- **git push 偶发 connection reset**：重试即可，网络问题
- **scheduler 的 `_runDailySummary()` 无 await**：async 函数 fire-and-forget，错误不会抛到 tick
- **Eastmoney push2 K线 API 不可用**：基本面评分会自适应降权（25%→10%）
- **Tencent API 每批 60 只**：全量扫描需分批，Sina 备选每批 80 只
- **portfolio.json 损坏时有 .bak 自动恢复**：不要手动删除 .bak 文件
- **⚠ `git pull` 会覆盖运行时数据**：`.gitignore` 已排除 data 目录，但如果新增运行时文件必须确认不在 git 追踪中。云端的实时数据（持仓/调度状态/总结/知识库）被 git 覆盖后难以恢复
