# Francis Investment CLAUDE.md

A股量化交易系统 + 跨市场分析引擎 + 周末深度分析。Node.js 零外部依赖，24/7 阿里云 ECS 运行。全自动采集+评分+模拟交易+盘后总结+美股→A股相关性追踪+周末历史学习+市场周期识别。**所有分析面板均回馈到模拟交易引擎，形成"学习循环"。**

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

# 验证核心 API
curl -s http://8.153.101.112:8765/api/status
curl -s http://8.153.101.112:8765/api/simfolio/status
curl -s http://8.153.101.112:8765/api/market/cycle
curl -s http://8.153.101.112:8765/api/cross-market/analysis
curl -s http://8.153.101.112:8765/api/factors/performance
curl -s http://8.153.101.112:8765/api/margin/status

# 手动触发相关性快照（补录丢失数据）
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
├── mosaic_server.js             # ★ HTTP 主服务器 (0.0.0.0:8765) — 40+ API 路由
├── mosaic/                      # ★ 量化引擎
│   ├── config.js                #   唯一配置入口（阈值/权重/时间表/回撤门/建仓节奏/因子诊断）
│   ├── scheduler.js             #   ★ 状态机调度器：tick→状态转换→Pipeline→美股采集→16:00总结+相关性快照+因子绩效
│   ├── pipeline.js              #   主流程编排（EventEmitter）— 8维预评分+SSE实时广播+两融数据
│   ├── simfolio.js              #   模拟交易引擎（分层仓位+回撤门+建仓节奏+思维舱防御门+市场周期仓位+T+1风控）
│   ├── collectors/              #   数据采集（market_data/us_market/index_recorder/capital_flow/dragon_tiger/north_bound/margin_data/news_collector）
│   ├── factors/                 #   评分引擎
│   │   ├── hidden_signals.js    #   ★ H1-H9 隐藏因子 → computeHiddenSignals()
│   │   └── composite.js         #   ★ 5维综合评分 + 北向动态权重 + 两融情绪 + LHB增强 + 板块相对评分
│   └── analysis/                #   盘后+周末分析
│       ├── market_cycle.js      #   ★ A股周期识别（MA排列+量能+宽度→5档+仓位建议）
│       ├── cross_market.js      #   ★ 跨市场相关性引擎 + 风险状态机（5档）
│       ├── factor_performance.js #   ★ 因子绩效（命中率/平均收益/趋势 + 北向绩效）
│       ├── knowledge_base.js    #   因子追踪知识库（含因子组合模式提取）
│       ├── weekend_analyzer.js  #   ★ 周末深度分析引擎（4阶段全中文）
│       ├── weekend_verifier.js  #   ★ 周末分析验证引擎（5维验证→反馈到下周）
│       ├── us_macro.js          #   美股隔夜总结生成器
│       └── quant_report.js      #   交易归因+新闻预测
├── report-engine/               # ★ 前端（纯静态）
│   ├── index.html               #   主仪表板（8 section + 日历 + 侧边栏）
│   ├── think-tank.html          #   ★ AI 思考舱（SSE实时+4卡风险中枢+因子组合+维度分解）
│   ├── app.js                   #   ★ 前端控制器（section导航+异步渲染+移动端+情绪指标+持仓健康度）
│   ├── style.css                #   仪表板样式（桌面+移动端≤720px）
│   ├── templates/               #   UI模板（simfolio/cross-market/us-market/weekend-analysis/等）
│   └── data/
│       ├── simfolio/            #   ★ 运行时：portfolio.json + factor_performance.json + weekend_context.json
│       ├── us_market/           #   运行时：us_latest.json + correlation_history.json + margin_cache.json
│       ├── market_history/      #   历史K线：indices/sh000001.json + sz399001.json + sz399006.json
│       ├── events/              #   每日事件日志 YYYY-MM-DD.json
│       ├── summaries/           #   每日盘后总结 YYYY-MM-DD.json
│       └── knowledge_base/      #   AI 知识库
└── deploy.sh
```

---

## 核心架构

### 调度器（scheduler.js）— 24/7 自动运行

状态机：`closed → pre_market → morning_session → lunch_break → afternoon_session → post_market → closed`

- 活跃时段 tick 每 20s，空闲时段每 300s
- IndexRecorder：交易时段 60s 记录指数分钟线，自动清理 7 天前
- 美股采集：16:00-06:00 CST 采集 30 只符号 → `us_latest.json`，SSE 广播
- 美股隔夜总结：凌晨 5:00 CST → `us_close_YYYY-MM-DD.json`
- `_runDailySummary()`：16:00 异步 fire-and-forget → 盘后总结 + 相关性快照 + 因子绩效追踪
- 周末深度分析：周六/周日自动启动 → 每 15 分钟一轮 → 5 年历史K线 → 相似度+危机+轮动+因子 → `weekend_context.json`

### Pipeline 执行流程（pipeline.js）

1. 获取全 A 股列表（Eastmoney push2 批量）
2. 过滤器（价格≤20/成交额>1亿/PE≤40/排除ST和创业板）
3. 计算隐藏因子 H1-H9 + 并行获取 LHB/板块资金流/北向/两融
4. 8 维预评分排序 → top 80 进入深析
5. 逐只深析（双源基本面 + K线 + 资金流历史）→ 5 维综合评分
6. 排序/评级/SSE 广播 + `scan_complete` + `factor_perf`

### Simfolio — 交易日连续

- 初始 ¥100,000，T+1，持仓上限 5 只，单只 ≤30%
- **分层仓位**：强买入 top 5% → 15-25%现金 / 普通买入 top 15% → 8-12%
- **回撤管理**：每次 NAV 更新自动计算 maxDrawdown，3 档回撤门：
  - warn(-5%) → 日志告警 / restrict(-8%) → 每日最多 1 只买入 / halt(-10%) → 暂停所有买入
- **建仓节奏**：maxBuysPerDay=2 / 已持 3+只时降为 1 / 同日内买入间隔 30 分钟
- **动态阈值**：连续 2 天 TOP1 评分<65 → 最低买入分从 50 提高到 60
- **市场周期仓位**：market_cycle.js 自动调整最大持仓数（牛市 5 → 熊市 1-2）
- **多级风控门**（按优先级）：回撤门 → 市场方向门（上证跌>0.5%禁止买） → 跨市场熔断 → 思维舱防御门
- 卖出：硬止损 -8% / 软止损 评分<35 / 移动止盈
- T+1：当天买入的股票只有硬止损可卖出

### 反馈闭环（4 条"学习回路"）

| # | 回路 | 数据流 |
|---|------|--------|
| **1** | 周末验证→分析引擎 | 上周验证报告 → 调整本周 insight 权重/门槛/方向 → `weekend_context.json` |
| **2** | 北向资金→评分降权 | NB sentiment → 计算命中率 → composite.js 按 HOT/COLD 动态调整权重 |
| **3** | 知识库→交易决策 | 每日分析 → knowledge_base → 检查历史高效因子当前是否偏冷 → 触发防御模式 |
| **4** | 思考舱→防御门 | 6 维综合（因子健康/持仓压力/连续回撤/跨市场风险/信号背离/知识库） → score≥2 → 跳过买入 |

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
- 无详细财务数据时：fundamental→10%，总分上限 65
- 复合调整：北向情绪 ±3-5（COLD 时 ×0.33）+ 两融 ±2-3 + 板块相对评分 ±3-5 + LHB 增强 ±3-5 + COLD 因子惩罚 -3/信号
- 冷因子实时惩罚：历史命中率<40% 的因子触发时扣 3-8 分

### 市场周期识别（market_cycle.js）

均线排列(40%) + 成交量趋势(30%) + 市场宽度(20日高低位 30%) → 评分 0-100 → 5 档周期：
- 牛市(≥75)→5 只 / 震荡偏多(≥60)→4 只 / 震荡(≥40)→3 只 / 震荡偏空(≥25)→2 只 / 熊市(<25)→1 只

### 跨市场相关性（cross_market.js）

- **风险状态机**：VXX(40%) + UUP(30%) + TLT(30%) → -65~+65 → 5 档（panic/risk_off/neutral/slightly_bullish/risk_on）
- **相关性矩阵**：8 对 US ETF→A 股板块映射（Pearson R），每日 16:00 快照，保留 60 个交易日

---

## 前端架构

### Section 导航

**桌面端**：左侧 sidebar 玻璃按钮（毛玻璃 + 渐变小圆点 + 金色激活态）
**移动端 (≤720px)**：顶部 sticky bar — date-strip + section-tabs，可左右滑动

| ID | 标签 | 特色 |
|----|------|------|
| `simfolio` | 模拟交易 | ★ 实时面板：资产卡片+回撤等级+持仓健康度+交易动态+情绪指标 |
| `newsPolicy` | 时政要点 | 新闻+7 级情感标签（16:00 后） |
| `tradingReport` | 交易分析与报告 | 归因+预测+因子总结（16:00 后） |
| `usMarket` | 海外市场 | 美股实时快照（玻璃拟态白主题） |
| `crossMarket` | 跨市场分析 | ★ 风险仪表盘+市场周期+相关性矩阵+分层仓位 |
| `historyReview` | 历史复盘 | 因子组合模式+交易日归档+因子排行+复盘洞察 |
| `weekendAnalysis` | 周末深度分析 | 仅周末显示：相似度+危机+轮动+因子效能+验证反馈 |

### 新增 UI 组件（v2.4.x）

- **持仓健康度卡片**（Simfolio 面板）：每只持仓一张卡 — 盈亏%/持仓天数/距离止损进度条/推荐操作标签
- **回撤等级指示器**（Simfolio 统计卡片）：🟢正常/⚪提醒/🟡限仓/🔴熔断 四色标签
- **市场周期仪表盘**（跨市场分析顶部）：5 档周期标签+置信度+仓位上限+均线/量能/宽度三维分解
- **因子诊断告警**（Simfolio 面板）：静默因子/信号多样性不足时显示黄色横幅

### Think-Tank 页面（think-tank.html）

独立页面，两栏布局：
- **左侧**：AI 思维流（扫描线动画）+ 指数分钟折线图（Canvas 百分比模式）+ 因子绩效 3×3 卡片网格
- **右侧**：H1-H9 柱状图+命中率标签 + 评分分布直方图 + 因子组合模式 + 评分维度分解
- **智能风险中枢**（4 卡 2×2）：资金面热度/波动率状态/Smart Money/两融杠杆（60s 轮询）
- **仓位决策面板**：风险状态→仓位乘数+分层仓位表
- **SSE 实时流**：`scan_start`→`progress`→`stock_analyzed`→`scan_complete`→`enrichment`→`factor_perf`

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
| `/api/scheduler/status` | 调度器状态 |
| `/api/news/latest` | 新闻+7 级情感标签 |
| `/api/analysis/latest` | 交易归因分析 |
| `/api/daily-summary/latest` | 每日盘后总结 |
| `/api/knowledge/summary` | 知识库摘要 |
| `/api/knowledge/factor-combos` | 因子组合模式+板块资金流模式 |
| `/api/config/public` | 公开配置（筛选/权重/仓位/交易规则） |
| `/api/indices/today` | 指数分钟线数据 |
| `/api/think-tank/stream` | SSE 实时事件流 |
| `/api/think-tank/initial` | Think-Tank 初始数据 |
| `/api/us-market/current` | 美股实时快照 |
| `/api/us-market/summary` | 美股隔夜总结 |
| `/api/cross-market/analysis` | ★ 跨市场分析（风险状态+相关性矩阵） |
| `/api/cross-market/risk-state` | 风险状态机单独查询 |
| `/api/market/cycle` | ★ A 股市场周期（MA+量能+宽度→5 档+仓位建议） |
| `/api/factors/performance` | 因子绩效追踪（含北向绩效） |
| `/api/market/microstructure` | 智能风险中枢（北向+波动率+Smart Money） |
| `/api/margin/status` | 两融数据+情绪评分 |
| `/api/sectors/live` | 板块实时行情（仅当日） |
| `/api/weekend-analysis/status` | 周末分析进度 |
| `/api/weekend-analysis/report` | 周末完整报告 |
| `/api/weekend-analysis/context` | 周末增强上下文 |
| `/api/weekend-analysis/verification` | 周末验证报告 |
| `/api/pipeline/last-result` | 最近扫描结果 |

---

## ⚠ 关键约束

### 数据准确性铁律
- **所有股价/涨跌幅/PE/成交额必须实时查询，绝不估算**
- PE 亏损写 "亏损" 或 null

### 部署优先级
- **云端永远优先**：改动完成后立即 scp 到 `root@8.153.101.112:/root/FIRSTCC/Francis Investment/`，需要时 `systemctl restart mosaic`
- 前端静态文件无需重启，刷新浏览器即可
- 部署后 curl 验证关键 API

### 文件修改规则
- **绝不提交运行时数据**：`portfolio.json`, `scheduler_state.json`, `events/*.json`, `summaries/*.json`, `knowledge_base/*.json`, `index_history_*.json`, `us_latest.json`, `correlation_history.json`, `us_close_*.json`, `factor_performance.json`, `scan_records_*.json`, `last_pipeline_result.json`, `weekend_context.json`, `market_history/indices/*.json`, `weekend_archive/*.json`, `margin_cache.json`
- **config.js 是唯一配置入口**：改阈值/权重/时间表/回撤门/建仓节奏/因子诊断/仓位分层只需改这一个文件
- **`report-engine/data/` 是 DATA_DIR**：所有运行时数据在此目录下，不在 `mosaic/` 下

### 已知陷阱

- **SSH 路径含空格**：必须引号包裹 → `"/root/FIRSTCC/Francis Investment/..."`
- **scheduler `_runDailySummary()` 无 await**：fire-and-forget，16:00 附近重启服务器会导致当天总结+相关性快照丢失
- **Eastmoney push2 K 线 API 不可用**：基本面评分自适应降权 25%→10%，总分上限 65
- **portfolio.json 损坏时 .bak 自动恢复**：不要手动删除 .bak
- **跨市场相关性需 5 个交易日累积**：首次部署后需等待一周
- **因子绩效需 ≥2 天 scan_records**：首日只显示信号计数
- **周末分析全中文无 emoji**：`weekend_context.json` 用中文板块名，simfolio 用 `WEEKEND_SECTOR_KEYWORDS` 中文匹配
- **两融数据为代理指标**：Eastmoney 沪股通聚合 K 线（secid=90.BK0707），非官方融资融券余额
- **correlation_history.json 不含"金融"板块**：数据源限制，非 bug
- **因子命中率 `factor_performance.json` 中 factors 为数组**：需用 `Array.find` 查找
- **config API 字段映射**：`cfg.FILTER.exclude300`（非 excludeGEM），`cfg.FILTER.exclude688 === false`（非 includeSTAR），`cfg.SIMFOLIO.maxSinglePositionPct`（非 maxPositionPct）
