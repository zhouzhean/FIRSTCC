# Francis Investment CLAUDE.md

A股投资分析报告引擎 + Mosaic 量化系统。Node.js 服务器驱动，全自动联网采集+量化评分+模拟交易，24/7 阿里云 ECS 运行。

---

## 项目概述

Francis Investment 经历了三个阶段的演进：

| 阶段 | 架构 | 数据来源 |
|------|------|----------|
| **v1**（静态引擎） | 纯静态HTML，Chrome file:// 打开，数据通过 `<script>` 注入 | Claude WebSearch 手动采集 |
| **v2**（Mosaic 量化） | Node.js HTTP 服务器 (localhost:8765)，Chrome --app 模式 | 腾讯+Sina+Eastmoney 三源自动采集 |
| **v2.3**（2026-05-26） | 专业量化升级：百分位阈值+5维评分+主力资金流+龙虎榜+北向 | 五数据源（+datacenter-web+push2his） |
| **v2.4**（2026-05-26） | 阿里云 ECS 24/7 部署 + 移动端适配 + 三端同步（电脑/手机/平板） | 同上，云端运行 |
| **v2.5**（2026-05-26） | 每日盘后总结报告 + 事件时间线持久化 + 交易时间戳 + 思考舱移动端修复 | 同上，新增事件日志+总结文件系统 |

v2 新增：7因子隐藏信号引擎、4维综合评分模型、Simfolio 模拟交易（10万虚拟资金，T+1，真实费率）。

**v2.4**（2026-05-26）：部署至阿里云 ECS（华东2·上海，2核2G，Ubuntu 22.04），systemd 托管 24/7 运行（崩溃自动重启+开机自启）。桌面快捷方式改为直连云端。全站移动端响应式适配（外层仪表板+iframe 报告内容）。

**v2.5**（2026-05-26）：每日16:00自动生成盘后总结报告（市场行情+交易记录+量化分析+账户统计）。事件时间线按日期持久化（`data/events/YYYY-MM-DD.json`），支持历史回溯。交易动态显示完整日期+时间。AI思考舱移动端可用（`<a>` 链接替代 popup、100dvh、禁用背景粒子）。时政要点/交易分析/持仓分析三板块根据市场时段自动切换状态。

---

## Cloud Deployment（v2.4）

### 服务器信息

| 项目 | 详情 |
|------|------|
| 公网 IP | `8.153.101.112` |
| 访问地址 | `http://8.153.101.112:8765` |
| 思考舱 | `http://8.153.101.112:8765/think-tank.html` |
| 系统 | Ubuntu 22.04 64位，2 vCPU / 2 GiB |
| 进程管理 | systemd（`mosaic.service`），崩溃自动重启，开机自启 |
| 安全组 | 入方向开放 TCP 8765 |

### 部署脚本

`deploy.sh` — 在服务器上首次部署或重装时运行：
- 安装 Node.js 20 + git
- 克隆 `https://github.com/zhouzhean/FIRSTCC.git`
- 修改 `mosaic_server.js` 绑定 `0.0.0.0`
- 注册 systemd 服务 → enable + start → 24/7 运行

### 更新流程（云端）

```
本地修改代码 → git commit → git push origin master
  → SSH 登录服务器:
    cd /root/FIRSTCC && git pull && systemctl restart mosaic
```

之后所有设备（电脑浏览器、手机浏览器、平板）访问 `http://8.153.101.112:8765` 均为最新版本。

### systemd 服务管理

```bash
systemctl status mosaic    # 查看运行状态
systemctl restart mosaic   # 重启服务（更新代码后）
systemctl stop mosaic      # 停止服务
journalctl -u mosaic -f    # 实时日志
```

---

## 用户档案

- **称呼**：Francis | **总资产**：~14.5万元
- **持仓**：金发科技(600143) 6800股，成本≈17.75元；利欧股份(002131) 2200股，成本≈6.96元
- **偏好**：机器人/科技板块，20元以下低位潜力股，政策驱动型机会

## 热门跟踪板块

| 板块 | 逻辑 |
|------|------|
| 机器人/具身智能 | 宇树供应链+特斯拉Optimus |
| 创新药/AI医疗 | AI制药元年+BD交易超600亿美元 |
| 半导体/AI算力 | 国产替代+AI芯片需求 |
| 商业航天 | 卫星互联网+可回收火箭 |
| 固态电池/储能 | 新能源产业链延伸 |
| 有色金属/稀土 | 全球供应链重构 |
| 新型电力基建 | 特高压/虚拟电厂/智能电网 |
| 军工 | 弹药垄断+军工信息化+地缘催化 |

---

## ⚠ 数据准确性铁律（2026-05-21）

**根本原则：所有股价、涨跌幅、PE、成交额必须来自实时查询，绝不估算。**

### 绝对禁止
- ❌ 凭板块走势推算个股价格
- ❌ 用"约XX元"模糊估算代替精确价格
- ❌ 假设股票"逆势抗跌/逆势上涨"而不验证实际涨跌幅
- ❌ 直接用上次推荐时的价格作为本次价格
- ❌ 在未查PE的情况下填写PE值（亏损股PE为负值/null）
- ❌ 根据涨跌方向编造"主力净流入/流出"

### 必须遵守
- ✅ 每只潜力股单独查询当日收盘价+涨跌幅
- ✅ PE需查实时数据，亏损股票PE写"亏损"或null
- ✅ 涨跌%的正负号决定"逆势/跟跌"定性
- ✅ 20元股价上限用实时价格判断
- ✅ section5、recommendation-history、section6 三处数据完全一致

---

## 架构（v2 Mosaic）

### 项目结构

```
Francis Investment/
├── deploy.sh                    # ★ 阿里云 ECS 部署脚本
├── start.bat                    # 手动启动脚本（本地调试用）
├── launch.vbs                   # 静默启动本地 Mosaic Server（开机自启，已弃用，云端替代）
├── open.vbs                     # ★ 桌面快捷方式 → 直接打开云端 http://8.153.101.112:8765
├── .env                         # SMTP 凭据（163邮箱）
├── mosaic_server.js             # ★ Node.js HTTP 主服务器（零外部依赖）
├── CLAUDE.md                    # 本文件
├── setup-startup.ps1            # 开机自启设置脚本（已弃用）
├── mosaic/                      # ★ 量化引擎
│   ├── config.js                #   配置文件（筛选条件、因子权重、交易参数）
│   ├── pipeline.js              #   主流程编排器（EventEmitter，进度推送）
│   ├── scheduler.js             # ★ 全自动交易调度器（状态机+定时Pipeline+持仓监控）
│   ├── simfolio.js              #   模拟交易引擎（自动买卖+风控+净值跟踪）
│   ├── collectors/
│   │   ├── market_data.js       #   行情采集（Tencent主源+Sina备选+Eastmoney，三源架构）
│   │   ├── capital_flow.js      #   主力资金流采集（f62/f64/f66/f70/f72 + 板块资金流）
│   │   ├── dragon_tiger.js      #   龙虎榜采集（datacenter-web API，独立域名）
│   │   └── north_bound.js       #   北向资金采集（push2his kamt.kline）
│   └── factors/
│       ├── hidden_signals.js    #   9因子隐藏信号引擎（H1-H9）
│       ├── composite.js         #   综合评分模型（5维加权）
│       └── event_signals.js     #   事件驱动因子（龙虎榜/北向情绪）
├── report-engine/               # ★ 前端报告引擎
│   ├── index.html               #   主UI（fetch API 读取数据）
│   ├── think-tank.html          # ★ Mosaic AI 思考舱（SSE 实时 dashboard）
│   ├── style.css                #   外层仪表板样式（含移动端响应式）
│   ├── app.js                   #   状态管理、实时监控轮询、Simfolio渲染、PDF
│   ├── renderer.js              #   renderFullReport(data, mode) 串联9个section
│   ├── kline.js                 #   K线SVG生成 + renderKlineSVG()
│   ├── export-static.html       #   PDF导出中间文件（临时）
│   ├── FI-icon.ico              #   桌面快捷方式图标（金色FI标志）
│   ├── data/
│   │   ├── reports-index.json / .js
│   │   ├── recommendation-history.json / .js
│   │   ├── simfolio/            # ★ Simfolio 持久化目录
│   │   │   ├── portfolio.json   #   持仓+交易记录+净值历史
│   │   │   ├── portfolio.json.bak  # 自动备份（防损坏）
│   │   │   ├── last_pipeline_result.json
│   │   │   └── scheduler_state.json
│   │   ├── events/              # ★ 每日事件日志（v2.5）
│   │   │   └── YYYY-MM-DD.json  #   当天所有交易/扫描/状态事件
│   │   ├── summaries/           # ★ 每日盘后总结（v2.5）
│   │   │   └── YYYY-MM-DD.json  #   16:00自动生成的完整总结报告
│   │   └── YYYY-MM-DD/          #   每日报告数据
│   └── templates/               #   模板函数（含移动端响应式 CSS）
│       ├── css.js               #   renderSoftwareCSS() + renderCSS()，含移动端断点
│       ├── cover.js / news-policy.js / market-overview.js
│       ├── holdings-analysis.js / sector-tracking.js / low-price-picks.js
│       ├── top5-ranking.js / risk-matrix.js / recommendation-history.js
│       ├── simfolio.js          # ★ Simfolio 模拟交易看板模板
│       └── disclaimer-footer.js
└── reports/                     # 导出的PDF文件
```

### 启动方式

**日常使用（推荐）**：
- 桌面快捷方式 `Francis Investment.lnk` → `open.vbs` → 直接打开 Chrome `--app` 模式到 `http://8.153.101.112:8765`
- 手机/平板浏览器直接访问 `http://8.153.101.112:8765`
- 云端服务器 24/7 运行，无需本地启动任何东西

**本地调试**：
```bash
cd "C:/Users/anzhe/FIRSTCC/Francis Investment"
node mosaic_server.js
# 浏览器打开 http://localhost:8765
```

**桌面快捷方式**：
- 路径：`C:\Users\anzhe\Desktop\Francis Investment.lnk`
- 目标：`C:\Users\anzhe\FIRSTCC\Francis Investment\open.vbs`
- 图标：`report-engine\FI-icon.ico`
- 功能：直接打开 Chrome `--app` 模式到云端地址

### 移动端响应式（v2.4）

外层仪表板（`style.css`）：
- ≤720px：工具栏自动换行+缩小，侧边栏变为顶部横向滚动，板块导航改为横排标签
- ≤400px：进一步压缩字体和间距

报告内容 iframe（`templates/css.js`）：
- ≤768px：内容区缩窄边距，表格缩小字体，卡片垂直堆叠，单列布局
- ≤480px：最小边距，表格可横向滑动，K线图自适应缩放

### 前端布局（v2.5）

左侧边栏（320px）板块导航（自上而下）：

| 板块 | 图标 | 说明 |
|------|------|------|
| **模拟交易** | 💰 | ★ 置顶，实时看板：交易动态（完整日期+时间）+资产卡片+持仓表+净值曲线 |
| **时政要点** | 📰 | 分时段：盘后16:00前"暂不可用"，16:00后显示完整总结 |
| **交易分析与报告** | 📊 | 分时段：盘后16:00前"暂不可用"，16:00后显示完整总结 |
| **持仓分析** | 💼 | 分时段：盘后16:00前"暂不可用"，16:00后显示完整总结 |

**工具栏变更（v2.5）**：
- 移除 `#live-indicator`（倒计时+状态行，与 Simfolio 面板重复）
- AI 思考舱按钮改为 `<a>` 标签（移动端兼容），桌面端用 JS 拦截开 popup

**时间感知渲染**：四个板块通过 `renderTimeAwareSectionDirect()` 直接渲染到 DOM，支持异步数据加载。`getMarketTimeState()` 返回四种状态：`trading` / `generating` / `ready` / `closed`。

### 数据源架构（五源协同，v2.3）

| 数据源 | 端点 | 用途 | 状态 |
|--------|------|------|------|
| **Tencent** | `qt.gtimg.cn` | 全A股行情列表（含PE/PB/成交额），每批60只 | ✅ 主力 |
| **Sina** | `hq.sinajs.cn` | 全A股行情列表（无PE），每批80只 | ✅ 备选 |
| **Eastmoney push2** | `push2.eastmoney.com` | 全A股行情（含主力资金流f62/f64/f66/f70/f72）+ 板块资金流 | ⚠️ 部分可用 |
| **Eastmoney datacenter-web** | `datacenter-web.eastmoney.com` | 龙虎榜每日明细（RPT_DAILYBILLBOARD_DETAILSNEW） | ✅ 独立域名 |
| **Eastmoney push2his** | `push2his.eastmoney.com` | 个股资金流K线 + 北向资金沪深港通（kamt.kline） | ⚠️ 部分可用 |

**PE 数据来源**：腾讯API第39字段（动态PE），Sina不提供PE。PE ≤ 40 过滤（亏损股PE为null，保留）。

**资金流字段**（Eastmoney clist/get）：f62=主力净流入, f64=超大单净流入, f66=大单净流入, f70=中单净流入, f72=小单净流入。

**关键限制**：Eastmoney 详情/K线 API（push2 stock/get, push2his kline/get）不可用导致基本面评分维度缺失（ROE、负债率、利润增长等均为null）。v2.3 通过基本面自适应降权（detail缺失时25%→10%）+ 新增方向性资金流因子来补偿。

### Mosaic Server API

| 路由 | 方法 | 用途 |
|------|------|------|
| `/api/status` | GET | 服务器状态+交易日检测+日期 |
| `/api/reports-index` | GET | 已有报告索引 |
| `/api/recommendation-history` | GET | 推荐历史数据库 |
| `/api/report/<date>` | GET | 指定日期完整报告数据 |
| `/api/pipeline/run` | POST | 启动全流程量化分析 |
| `/api/pipeline/status` | GET | 实时进度（0-100%+步骤名） |
| `/api/pipeline/result` | GET | 分析完成后获取结果 |
| `/api/pipeline/last-result` | GET | 最近一次Pipeline持久化结果（重启后可用） |
| `/api/simfolio/status` | GET | 模拟账户快照（持仓+净值+交易记录） |
| `/api/simfolio/history` | GET | 净值曲线数据 |
| `/api/simfolio/trade` | POST | 基于Pipeline结果执行交易决策 |
| `/api/simfolio/reset` | POST | 重置模拟账户至10万初始资金 |
| `/api/scheduler/status` | GET | 调度器状态（state/nextTick/scheduledOps） |
| `/api/scheduler/events` | GET | 调度器内存事件日志（最近N条） |
| `/api/position/force-check` | POST | 手动触发持仓检查 |
| `/api/think-tank/initial` | GET | 思考舱初始数据REST接口（调度器状态+持仓+最新扫描+今日事件） |
| `/api/think-tank/stream` | GET | SSE 实时事件流（heartbeat/scan/progress/trade/position/state/daily_events） |
| `/api/events/dates` | GET | 有事件记录的日期列表（v2.5） |
| `/api/events/<date>` | GET | 指定日期的完整事件日志（v2.5） |
| `/api/daily-summary/latest` | GET | 今日盘后总结报告（v2.5） |
| `/api/daily-summary/<date>` | GET | 指定日期的盘后总结报告（v2.5） |

### 自动运行流程

云端服务器 24/7 运行，调度器按交易日自动执行：

```
交易日 9:25 开盘前
  → Pipeline 全量扫描（5000+股票，腾讯主力+Sina备选）
  → 筛选（价格<20 + PE≤40 + 成交额>1亿 + 排除ST + 排除创业板）
  → 预评分排序，取TOP 30提取K线+详情
  → 计算9个隐藏因子 + 5维综合评分
  → 8大板块分类 + TOP5排序
  → 生成报告数据文件
  → Simfolio 读取量化信号，自动买卖
  → 持仓+净值更新，持久化到 portfolio.json
  → 前端 SSE 推送 scan_complete 事件，思考舱实时更新

盘中多次 mid-scan（10:00/10:30/11:25/13:30/14:00/14:30/14:50，共7次）
```

---

## 量化评分体系

### 9个隐藏因子（H1-H9, v2.3）

| # | 因子 | 信号逻辑 | 权重 |
|---|------|---------|------|
| H1 | 缩量止跌 | 5日跌幅>3% + 成交量缩至20日均量50%以下 → 卖压枯竭 | 中 |
| H2 | 底部放量 | 价格距20日低点<5% + 当日成交量>20日均量2倍 → 反转信号 | 高 |
| H3 | 逆势抗跌 | 大盘跌>0.5%但个股涨>1% → 有资金护盘 | 高 |
| H4 | PE极度低估 | PE<15 + 净利润增长>10% → 低估值成长 | 高 |
| H5 | 高ROE低PB | ROE>15% + PB<2 → 质优价廉 | 中 |
| H6 | 经营现金流健康 | OCF/股 > 每股收益×0.8 → 利润真实 | 中 |
| H7 | 低换手蓄力 | 换手率<1% + 连续3日窄幅震荡 → 蓄势待发 | 低 |
| H8 | 短期反转 | 5日累计跌幅>5% + 今日止跌翻红 → 超跌反弹动能 | 高 |
| H9 | 量价背离 | 5日量价相关系数<-0.5 + 价格企稳 → 疑似吸筹 | 中 |

> **评分校准（v2.3）**：无信号触发时 hidden score = 50（中性），有信号时映射到 50-100 区间。

### 综合评分公式（v2.3 5维模型）

```
TotalScore = fundamental(0-25%*) + technical(15%) + hidden(20%) + capitalFlow(25%) + event(15%)
```

- `*` 基本面权重自适应：detail数据完整=25%，detail缺失=10%
- event 维度：龙虎榜净买入=85分(strong)/70分(medium)/60分(weak)，无上榜=50分
- 北向情绪调整：连续净流入→总分+1~3分；大幅流出→总分-5分

| 评级 | 分数 | 含义 |
|------|------|------|
| S | 85+ | 卓越 |
| A | 75-84 | 优秀 |
| B | 60-74 | 良好 |
| C | 45-59 | 一般 |
| D | <45 | 回避 |

### 推荐股6维展示评分

| 维度 | 5★标准 | 3★标准 | 1★标准 |
|------|--------|--------|--------|
| 📊 财务报表 | 营收+净利双增20%+、负债率<30%、ROE>15% | 营收/净利个位数增长、负债率40-60% | 持续亏损、负债率>70% |
| 📈 K线技术面 | 均线多头排列、MACD金叉、量价配合 | 均线走平、MACD零轴附近 | 均线空头排列、MACD死叉 |
| 🏛 公司治理 | 央企/国资控股、无负面舆情 | 民企但治理规范 | 实控人风险、曾有违规 |
| 🏭 产业逻辑 | 政策强驱动+行业增速>30% | 有政策支撑 | 产业萎缩、政策利空 |
| 🏦 机构态度 | 多家机构买入评级+北向增持 | 1-2家覆盖、中性 | 无机构覆盖 |
| 💰 资金面 | 日成交>5亿+换手2-5% | 日成交1-5亿 | 日成交<1亿 |

---

## Simfolio 模拟交易

### 基本参数

| 参数 | 值 |
|------|-----|
| 初始资金 | ¥100,000 |
| 交易规则 | T+1（今日买明日才能卖） |
| 持仓上限 | 5只股票 |
| 单只上限 | ≤30% 总仓位 |
| 费率 | 印花税0.1%(卖) + 佣金0.025% + 过户费0.001% |
| 持久化 | `report-engine/data/simfolio/portfolio.json` |

### 自动交易逻辑（v2.3 百分位制）

**买入**：
| 条件 | 操作 |
|------|------|
| Top 10% + 触发强信号（hasStrongSignal） | 强买入：投入现金20% |
| Top 20%（百分位阈值） | 买入：投入现金10% |
| 绝对得分 <50（质量底线） | 即使百分位达标也不买入 |
| 已持仓 | 跳过 |

**卖出**：
| 条件 | 操作 |
|------|------|
| 亏损 ≥8% | 硬止损，全仓清 |
| 综合分 <50 | 软止损，清仓 |
| 移动止盈触发（当前价 ≤ trailingStopPrice） | 止盈 |
| 盈利 >20% 且信号消失 | 止盈 |

**移动止盈**：盈利>3%激活，分档回撤：+5%→回撤3%止盈、+10%→回撤5%止盈、+20%→回撤10%止盈。

---

## Mosaic AI 思考舱（Think Tank, v2.5）

实时量化分析仪表板，REST + SSE 双通道加载（REST 即时初始数据 → SSE 实时更新）。

### 访问方式

- 云端：`http://8.153.101.112:8765/think-tank.html`
- 主UI工具栏点击 "AI 思考舱" 按钮
- **桌面端**（≥900px）：`window.open` 独立窗口（1400×900）
- **移动端**（<900px）：`<a href="/think-tank.html" target="_blank">` 直接导航（避免 popup 被拦截）

### 移动端响应式（v2.5）

三层断点：900px（平板）/ 600px（手机）/ 380px（小屏手机）
- ≤600px：禁用背景网格 + 粒子动画（性能优化），面板全宽堆叠
- `100dvh` + `-webkit-overflow-scrolling: touch` 解决 iOS Safari 视口问题
- 系统字体栈优先（`system-ui, -apple-system, ...`）

### REST + SSE 双通道加载

1. 页面加载 → `GET /api/think-tank/initial` → 即时渲染调度器状态+持仓+最新扫描+今日事件+事件日期列表
2. 连接建立 → `GET /api/think-tank/stream` (SSE) → 持续推送实时更新
3. SSE `connected` 事件保留 REST 已加载的事件（幂等去重），避免闪烁

### SSE 事件流（`/api/think-tank/stream`）

| 事件类型 | 触发时机 | 载荷 |
|----------|----------|------|
| `connected` | SSE 连接建立 | `{ sessionId, serverTime }` |
| `heartbeat` | 每30秒（活跃）/ 每5分钟（空闲） | `{ time, marketState, nextScan, positions }` |
| `last_result` | SSE 连接后立即发送 | 最近一次 Pipeline 完整摘要 |
| `scan_complete` | Pipeline/Mid-Scan 完成 | `{ type, top5, scoreDistribution, stats, daily_summary }` |
| `position_snapshot` | 持仓价格更新 | `{ positions, totalValue, cash }` |
| `trade` | 自动交易执行 | `{ action, code, name, price, reason }` |
| `pipeline_progress` | Pipeline 运行中 | `{ progress, step }` |
| `daily_events` | SSE 连接建立时 | 今日全部事件日志（用于时间线渲染） |

### 事件时间线（v2.5）

- **持久化**：每日事件按 `data/events/YYYY-MM-DD.json` 存储（环形缓冲，上限500条）
- **日期选择器**：时间线面板顶部 `<select>` 下拉框，可切换查看历史日期
- **API**：`GET /api/events/dates` 获取有记录的日期列表，`GET /api/events/<date>` 获取指定日期事件
- **每日清空**：调度器跨日时自动切换新日期文件
- **事件类型**：pipeline_complete, midscan_complete, trade_buy, trade_sell, position_refresh, daily_summary_start/complete 等

### 扫描调度（活跃交易日，3 full + 7 mid = 10次/天）

| 时间 | 类型 | 说明 |
|------|------|------|
| 9:30 | 全量扫描 (full) | 开盘全A股过滤+评分+TOP5 |
| 10:00 | 盘中扫描 (mid) | 成交额TOP250深析20只 |
| 10:30 | 盘中扫描 (mid) | 盘中二次检查 |
| 11:00 | 全量扫描 (full) | 午间收盘前全量 |
| 11:25 | 盘中扫描 (mid) | 午休前最后检查 |
| 13:00 | 全量扫描 (full) | 下午开盘全量 |
| 13:30 | 盘中扫描 (mid) | 下午盘中检查 |
| 14:00 | 盘中扫描 (mid) | 尾盘前检查 |
| 14:30 | 盘中扫描 (mid) | 尾盘二次检查 |
| 14:50 | 盘中扫描 (mid) | 收盘前10分钟最后机会 |

---

## 每日盘后总结报告（v2.5）

每日 16:00 CST 自动生成完整盘后总结报告，持久化到 `data/summaries/YYYY-MM-DD.json`。

### 自动生成流程

调度器 `_tick()` 检测 `hourNow >= 16` → `_runDailySummary()` 执行：
1. 收集当日市场行情（上证/深证/创业板指数）
2. 收集持仓快照（持仓股价格+涨跌+市值+盈亏）
3. 收集当日交易记录（买入/卖出明细）
4. 收集最新 Pipeline 结果（TOP5 + 评分分布）
5. 收集量化因子触发情况
6. 统计账户数据（总资产/现金/市值/总盈亏）
7. 统计当日事件数量（扫描次数/交易次数/错误数）
8. 写入 JSON 文件 + 推送 SSE `daily_summary` 事件到思考舱

### API

| 路由 | 用途 |
|------|------|
| `/api/daily-summary/latest` | 获取今日盘后总结（如未生成返回 null） |
| `/api/daily-summary/<date>` | 获取指定日期盘后总结 |

### 前端集成

时政要点、交易分析、持仓分析三个板块根据 `getMarketTimeState()` 自动切换：

| 时段 | 状态 | 显示内容 |
|------|------|---------|
| 交易日 9:30-15:00 | `trading` | "暂不可用"（盘中交易时段） |
| 交易日 15:00-16:00 | `generating` | "正在分析并生成中..."（等待16:00自动生成） |
| 交易日 16:00+ | `ready` | 完整的盘后总结报告 |
| 非交易日 | `closed` | "暂不可用"（休市） |

前端通过 `renderTimeAwareSectionDirect()` 直接渲染到 DOM（非 iframe srcdoc），支持异步加载每日总结数据。

---

## v1 资源（向后兼容）

### 数据注入模式

```javascript
window.__REPORT_DATA__ = window.__REPORT_DATA__ || {};
var _d = window.__REPORT_DATA__['2026-05-22'] = ...;
_d.section5_lowPricePicks = { "filterCallout": {...}, "stocks": [...] };
```

**关键约束**：
- `index.html` 中 meta.js 必须在最前面
- 模板函数签名 `renderXxx(data, mode)`，mode=`'app'`|`'pdf'`
- iframe srcdoc 渲染，sandbox: `allow-same-origin allow-scripts`，CSS完全隔离
- iframe 内 onclick 回调必须使用 `parent.functionName()` 前缀

### 推荐数据库规则

- `recommendation-history.json` 上限 **50只**
- 新推荐股不得与数据库中已有的股票重复
- 超50只时按综合得分淘汰最低分（同分淘汰最早推荐）

### TOP5 排名规则

- 直接从推荐数据库按 compositeScore 取前5名
- section6 和推荐历史面板的 sort 逻辑必须完全一致
- TOP5中价格/PE为当日实时数据，排名依据是数据库中的 compositeScore

---

## 邮件发送

```bash
cd "C:/Users/anzhe/FIRSTCC" && node send_mail.js "anzhezhouclaude@163.com" "NXtVgDqN5E4S8dSB" "anzhezhou@126.com" "主题" "正文" "附件路径"
```
SMTP: smtp.163.com:465 (SSL)
主题格式：`YYYY年M月D日 每日行情分析报告`

---

## 已知教训

### 2026-05-26（v2.5 盘后总结 + 思考舱移动端 + 事件持久化）

盘后总结报告全自动生成 + 思考舱移动端彻底修复 + 交易时间戳完善 + 事件时间线跨天持久化。

- **AI 思考舱移动端打不开**：根因是 `<button>` + `window.open('...', 'mosaic_think_tank', 'width=1400,height=900')` 在手机上被拦截或行为异常。修复：改为 `<a href="/think-tank.html" target="_blank">`，仅在桌面端（≥900px）用 JS 拦截开 popup。同时添加三层响应式断点（900/600/380）、禁用移动端背景粒子、`100dvh` 解决 iOS Safari 视口问题。
- **思考舱 REST+SSE 双通道**：页面首次加载通过 REST `/api/think-tank/initial` 获取即时数据（调度器状态+持仓+最新扫描+今日事件+事件日期列表），然后 SSE 连接做增量更新。SSE `connected` 事件去重保护已渲染的事件，避免闪烁。
- **事件时间线持久化**：每日事件写入 `data/events/YYYY-MM-DD.json`（环形缓冲500条），时间线面板新增日期选择器可回溯历史。API：`/api/events/dates` + `/api/events/<date>`。
- **盘后总结自动生成**：调度器 `_tick()` 中检测 `hourNow >= 16` → `_runDailySummary()`，收集当日市场行情+持仓+交易+扫描结果+账户统计，写入 `data/summaries/`，SSE 推送到思考舱。前端三个板块（时政要点/交易分析/持仓分析）通过 `getMarketTimeState()` 分时切换（trading→"暂不可用" / generating→"生成中" / ready→完整总结）。
- **交易动态时间戳**：从 `(t.time || '')` 改为 `(t.date || '') + ' ' + (t.time || '')`，显示完整日期+时间（如 "2026-05-26 09:35"）。
- **调度器 bug**：`_tick()` 中使用了未定义的变量 `h`，修复为 `const hourNow = now.getHours()`。

### 2026-05-26（云端部署 + 移动端适配）

阿里云 ECS 部署上线，实现 24/7 云端运行 + 三端同步。
- **部署**：`deploy.sh` 一键脚本（Node.js 20 + git clone + systemd 服务）。坑：systemd ExecStart 含空格路径需引号包裹；首次启动因手动测试进程占用端口导致 systemd 启动失败。
- **安全组**：阿里云 ECS 默认拦截所有入站流量，需在控制台手动开放 8765 端口（自定义 TCP，0.0.0.0/0）。
- **快捷方式**：`open.vbs` 从"检测+启动本地服务器+打开 Chrome"简化为"直接打开云端 URL"，不再依赖本地服务器。
- **移动端**：外层仪表板 ≤720px 工具栏换行+侧边栏变横排标签；iframe 报告 ≤768px 表格可滑动+卡片堆叠+封面缩小；≤480px 进一步压缩。两层 CSS（style.css + templates/css.js）均需各自适配。

### 2026-05-26（评分体系重构 + 专业量化升级）

AI 交易员全天零交易——TOP5 最高仅 53 分，远低于 70 分绝对阈值。
- **根因**：(1) 隐藏信号无触发时得分=0；(2) 基本面数据缺失；(3) 绝对阈值70脱离实际。
- **修复**：中性分50、基本面自适应降权、百分位阈值替代绝对阈值、新增3个采集器（资金流/龙虎榜/北向）、因子升级为5维+9因子。
- **效果**：TOP5 评分从 52-53 提升至 58-63，首次触发买入决策。

### 2026-05-25（快捷方式 + UI 打磨）

- **快捷方式 VBS 化**：直接指向 `.vbs` 文件最可靠（Windows 自动用 wscript.exe 执行）。
- **UI 去冗余**：删除工具栏倒计时（Simfolio 面板已有）、删除日历圆点装饰。
- Eastmoney push2 API 被限，候选股仅8只。新增腾讯API为主力源，恢复至864只。

### 2026-05-24（架构升级）

从静态 file:// 架构升级为 Mosaic Server (Node.js HTTP)，前端从 `<script>` 数据注入改为 `fetch()` API 调用。

### 2026-05-22（渲染/排名/PDF）

推荐历史面板关闭按钮无响应（iframe隔离）、TOP5与推荐历史排名不一致、中文引号导致Node.js解析失败。

### 2026-05-21（数据准确性）

16只推荐股中11只股价错误，3只超20元上限，2只涨跌方向写反。改进：每只股票强制WebSearch确认，三文件交叉验证。

---

## 已有报告

| 日期 | 内容 |
|------|------|
| 2026-05-14 | 每日行情分析（仅PDF） |
| 2026-05-15 | 每日行情+K线诊断+8板块筛选+TOP5 |
| 2026-05-21 | 暴跌日报告+8板块16只精选+TOP5重评 |
| 2026-05-22 | 缩量修复+科创50领涨+FSD入华+商业航天双催化（48只推荐数据库） |

---

## 更新流程（手动模式，v1兼容）

用户说"更新报告"时使用。v2 模式下 Pipeline 自动完成大部分步骤。

### 1. 数据搜索（6-8个并行WebSearch）
大盘行情 + 时政新闻 + 2只持仓股 + 8大板块动态 + 每板块2只新股（<20元，非创业板，成交>1亿，不与数据库重复）

### 2. 创建数据文件
在 `data/YYYY-MM-DD/` 下创建 .js 文件，更新 `index.html` 引用。

### 3. 更新索引和推荐历史
更新 `reports-index.json/js` 和 `recommendation-history.json/js`。

### 4. 预览和导出
Chrome 打开 `index.html` 逐板块检查，PDF导出。
