# Francis Investment CLAUDE.md

A股投资分析报告引擎 + Mosaic 量化系统。Node.js 本地服务器驱动，全自动联网采集+量化评分+模拟交易。

---

## 项目概述

Francis Investment 经历了两个阶段的演进：

| 阶段 | 架构 | 数据来源 |
|------|------|----------|
| **v1**（静态引擎） | 纯静态HTML，Chrome file:// 打开，数据通过 `<script>` 注入 | Claude WebSearch 手动采集 |
| **v2**（Mosaic 量化） | Node.js HTTP 服务器 (localhost:8765)，Chrome --app 模式 | 腾讯+Sina+Eastmoney 三源自动采集 |
| **v2.3**（2026-05-26） | 专业量化升级：百分位阈值+5维评分+主力资金流+龙虎榜+北向 | 五数据源（+datacenter-web+push2his） |

v2 新增：7因子隐藏信号引擎、4维综合评分模型、Simfolio 模拟交易（10万虚拟资金，T+1，真实费率）。

**v2.3**（2026-05-26）：专业量化系统升级。评分引擎重构（百分位阈值+中性分修复+基本面自适应降权），新增3大数据采集器（主力资金流/龙虎榜/北向资金），因子引擎从4维升级为5维（+事件驱动），隐藏信号从7个扩展至9个（H8短期反转+H9量价背离），买入逻辑从绝对阈值改为Top 20%百分位制。

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

## 架构（v2 Mosaic）

### 项目结构

```
Francis Investment/
├── start.bat                    # ★ 一键启动：Node服务器 + Chrome独立窗口
├── launch.vbs                   # ★ 静默启动 Mosaic Server（无终端窗口，开机自启用）
├── open.vbs                     # ★ 静默打开 Chrome（无终端窗口，桌面快捷方式用）
├── mosaic_server.js             # ★ Node.js HTTP 主服务器（零外部依赖）
├── CLAUDE.md                    # 本文件
├── setup-startup.ps1            # 开机自启设置脚本
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
│       ├── composite.js         #   综合评分模型（5维加权：fundamental+technical+hidden+capitalFlow+event）
│       └── event_signals.js     #   事件驱动因子（龙虎榜/北向情绪）
├── report-engine/               # ★ 前端报告引擎
│   ├── index.html               #   主UI（服务器模式下用fetch读取API）
│   ├── think-tank.html           # ★ Mosaic AI 思考舱（SSE实时 dashboard：因子分析+评分分布+TOP5+扫描倒计时）
│   ├── style.css                #   样式（含 .btn-accent 进度条等）
│   ├── app.js                   #   状态管理、实时监控轮询、Simfolio渲染、PDF（v2.2：Simfolio优先布局）
│   ├── renderer.js              #   renderFullReport(data, mode) 串联9个section
│   ├── kline.js                 #   K线SVG生成 + renderKlineSVG()
│   ├── export-static.html       #   PDF导出中间文件（临时）
│   ├── FI-icon.ico              #   桌面快捷方式图标（金色FI标志）
│   ├── logo.ico                 #   备用图标
│   ├── data/
│   │   ├── template-default.json
│   │   ├── reports-index.json / .js
│   │   ├── recommendation-history.json / .js
│   │   ├── simfolio/            # ★ Simfolio 持久化目录
│   │   │   ├── portfolio.json   #   持仓+交易记录+净值历史
│   │   │   ├── last_pipeline_result.json  #   最近一次Pipeline结果（重启后保留）
│   │   │   └── scheduler_state.json       #   调度器状态持久化
│   │   └── YYYY-MM-DD/          #   每日报告数据（8个 .js 文件）
│   └── templates/               #   12个模板函数
│       ├── css.js / cover.js / news-policy.js / market-overview.js
│       ├── holdings-analysis.js / sector-tracking.js / low-price-picks.js
│       ├── top5-ranking.js / risk-matrix.js / recommendation-history.js
│       ├── simfolio.js          # ★ Simfolio 模拟交易看板模板
│       └── disclaimer-footer.js
└── reports/                     # 导出的PDF文件
```

### v2.2 前端布局

左侧边栏（320px）板块导航（自上而下）：

| 板块 | 图标 | 说明 |
|------|------|------|
| **模拟交易** | 💰 | ★ 置顶，实时看板：倒计时+资产卡片+交易动态推送+持仓表+净值曲线 |
| **时政要点** | 📰 | 当日政策/新闻摘要 |
| **交易分析与报告** | 📊 | 合并板块（封面+大盘综述+板块跟踪+潜力股推荐+TOP5+风险矩阵） |
| **持仓分析** | 💼 | 暂不可用（灰色），等待宇树科技上市后清仓再开放 |

工具栏右侧：
- 🟢 AI 交易员状态指示灯（休市/盘前/交易中/午休/盘后）
- 生成PDF 按钮
- 发送PDF至邮箱 按钮

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

### 启动方式

**正常使用**：双击桌面快捷方式 `Francis Investment.lnk`（或直接双击 `start.bat`）
- 桌面快捷方式 → `open.vbs` → 静默打开 Chrome（无终端弹窗）
- 开机自启快捷方式 → `launch.vbs` → 后台静默启动 Mosaic Server
- 自动启动 Node.js Mosaic Server（后台最小化窗口）
- 2秒后打开 Chrome 独立窗口 → `http://localhost:8765`
- 交易日自动触发量化分析+模拟交易

**手动启动**：
```bash
cd "C:/Users/anzhe/FIRSTCC/Francis Investment"
node mosaic_server.js
# 浏览器打开 http://localhost:8765
```

**停止服务器**：关闭 Node 控制台窗口，或 `taskkill /F /IM node.exe`

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
| `/api/simfolio/status` | GET | 模拟账户快照（持仓+净值） |
| `/api/simfolio/history` | GET | 净值曲线数据 |
| `/api/simfolio/trade` | POST | 基于Pipeline结果执行交易决策 |
| `/api/simfolio/reset` | POST | 重置模拟账户至10万初始资金 |
| `/api/pipeline/last-result` | GET | 最近一次Pipeline持久化结果（重启后可用） |
| `/api/events` | GET | SSE 实时事件流（heartbeat + scan_complete + position_snapshot + last_result） |

### 自动运行流程

```
双击 start.bat
  → 启动 Mosaic Server (localhost:8765)
  → Chrome --app 模式打开 http://localhost:8765
  → 前端 checkServerStatus() 检测连接
  → 加载最新报告
  → 如果是交易日（周一至周五）：
      → 1秒后自动 POST /api/pipeline/run
      → 实时进度条（1秒轮询 /api/pipeline/status）
      → Pipeline 流程：
          1. 全A股采集（5000+股票，腾讯主力+Sina备选）
          2. 筛选（价格<20 + PE≤40 + 成交额>1亿 + 排除ST + 排除创业板）
          3. 预评分排序，取TOP 30提取K线+详情
          4. 计算7个隐藏因子 + 4维综合评分
          5. 8大板块分类 + TOP5排序
          6. 生成报告数据文件
      → 分析完成后 POST /api/simfolio/trade
      → Simfolio 读取量化信号，自动买卖
      → 持仓+净值更新，持久化到 portfolio.json
```

---

## 量化评分体系

### 9个隐藏因子（H1-H9, v2.3）

基于 API 可计算因子，权重占综合评分 **20%**：

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

> **评分校准（v2.3）**：无信号触发时 hidden score = 50（中性），有信号时映射到 50-100 区间。此前为 0-100 导致无信号=0分，35%权重直接清零。

### 综合评分公式（v2.3 5维模型）

```
TotalScore = fundamental(0-25%*) + technical(15%) + hidden(20%) + capitalFlow(25%) + event(15%)
```

- `*` 基本面权重自适应：detail数据完整=25%，detail缺失=10%（差额分配给其他维度）
- event 维度：龙虎榜净买入=85分(strong)/70分(medium)/60分(weak)，无上榜=50分且权重重新分配
- 北向情绪调整：连续净流入→总分+1~3分；大幅流出→总分-5分
- 资金流维度优先使用方向性数据（主力净流入/超大单vs小单背离/板块排名），无数据时回退到活跃度指标

| 评级 | 分数 | 含义 |
|------|------|------|
| S | 85+ | 卓越 |
| A | 75-84 | 优秀 |
| B | 60-74 | 良好 |
| C | 45-59 | 一般 |
| D | <45 | 回避 |

### 推荐股6维展示评分（兼容v1格式）

综合评分映射为6维★评分（0-5★，★=1分/☆=0.5分），每维 = 原始分/20 四舍五入到0.5：

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

**买入**（基于全市场分析结果百分位排名）：
| 条件 | 操作 |
|------|------|
| Top 10% + 触发强信号（hasStrongSignal） | 强买入：投入现金20% |
| Top 20%（百分位阈值，≈80分位以上） | 买入：投入现金10% |
| 绝对得分 <50（质量底线） | 即使百分位达标也不买入 |
| 已持仓 | 跳过 |

**卖出**：
| 条件 | 操作 |
|------|------|
| 亏损 ≥8% | 硬止损，全仓清 |
| 综合分 <50 | 软止损，清仓 |
| 移动止盈触发（当前价 ≤ trailingStopPrice） | 止盈 |
| 盈利 >20% 且信号消失 | 止盈，落袋为安 |

**移动止盈**（v2.2）：盈利>3%激活，分档回撤：+5%→回撤3%止盈、+10%→回撤5%止盈、+20%→回撤10%止盈。每5分钟检查一次。

**买入阈值配置**（`config.js`）：
```
BUY_THRESHOLD: {
  percentileTop: 0.20,       // top 20% = 普通买入
  percentileStrong: 0.10,    // top 10% = 强买入
  minAbsoluteScore: 50,      // 绝对质量底线
  northBoundRiskOffset: 5,   // 北向大幅流出时额外提高阈值
}
```

### 数据结构

```json
{
  "meta": { "initialCapital": 100000, "startDate": "2026-05-24" },
  "cash": 85420.50,
  "positions": [{
    "code": "600366", "name": "宁波韵升",
    "shares": 500, "avgCost": 13.35, "currentPrice": 14.20,
    "entryDate": "2026-05-26", "entryReason": "强买入：85分/S级+H1+H5+H7"
  }],
  "tradeHistory": [{ "date": "2026-05-26", "action": "buy", "price": 13.35, ... }],
  "dailyNav": [{ "date": "2026-05-24", "nav": 100000, "benchmarkReturn": 0 }]
}
```

### 前端展示（Section 9: 模拟交易）

- 4张资产概览卡片：总资产、现金、超额收益α、统计（胜率/最大回撤/夏普）
- SVG净值曲线图：Simfolio 净值（金线）vs 上证基准（虚线灰线）
- 当前持仓表：成本价、现价、盈亏%、入场理由
- 交易记录表：最近20条，买卖方向+触发原因

---

## Mosaic AI 思考舱（Think Tank, v2.3）

实时量化分析仪表板，通过 SSE (Server-Sent Events) 接收服务器推送，无需轮询。

### 访问方式

- URL: `http://127.0.0.1:8765/think-tank.html`
- 或从主UI工具栏点击 "AI 思考舱" 按钮

### SSE 事件流（`/api/events`）

| 事件类型 | 触发时机 | 载荷 |
|----------|----------|------|
| `connected` | SSE 连接建立 | `{ sessionId, serverTime }` |
| `heartbeat` | 每30秒（活跃）/ 每5分钟（空闲） | `{ time, marketState, nextScan: { time, label, type }, positions }` |
| `last_result` | SSE 连接后立即发送 | 最近一次 Pipeline 完整摘要（TOP5 + 评分分布 + 信号统计） |
| `scan_complete` | Pipeline/Mid-Scan 完成 | `{ type, top5, scoreDistribution, signalCounts, stats }` |
| `position_snapshot` | 持仓价格更新 | `{ positions, totalValue, cash }` |
| `trade` | 自动交易执行 | `{ action, code, name, price, reason }` |
| `pipeline_progress` | Pipeline 运行中 | `{ progress, step }` |

### 扫描调度（活跃交易日）

| 时间 | 类型 | 说明 |
|------|------|------|
| 9:30 | 全量扫描 (full) | 全A股过滤+评分+TOP5 |
| 10:30 | 盘中扫描 (mid) | 成交额TOP200中深析15只 |
| 11:00 | 全量扫描 (full) | 午间收盘前全量 |
| 11:25 | 盘中扫描 (mid) | 午休前最后检查 |
| 13:00 | 全量扫描 (full) | 下午开盘全量 |
| 14:00 | 盘中扫描 (mid) | 尾盘前检查 |
| 14:35 | 盘中扫描 (mid) | 收盘前25分钟最后机会 |

### 持久化机制

- Pipeline 完成后结果写入 `report-engine/data/simfolio/last_pipeline_result.json`
- 调度器状态写入 `report-engine/data/simfolio/scheduler_state.json`
- 服务器重启后 SSE 连接自动推送 `last_result` 事件，思考舱无需等待下一次扫描

### 思考舱面板布局

- **状态栏**：AI 交易员状态指示灯 + 距下次扫描倒计时
- **因子信号面板**：各隐藏因子触发次数柱状图 + 评分分布直方图
- **TOP5 排名**：最近扫描的 Top 5 股票卡片（代码/名称/评分/评级/信号标签）
- **浓缩面板**：市场总览文本摘要（Pipeline 自动生成）
- **空闲态**：无实时扫描时显示上次结果 + 下次扫描倒计时

---

## v1 资源（向后兼容）

### 数据注入模式（手动更新时使用）

```javascript
window.__REPORT_DATA__ = window.__REPORT_DATA__ || {};
var _d = window.__REPORT_DATA__['2026-05-22'] = window.__REPORT_DATA__['2026-05-22'] || {};
_d.section5_lowPricePicks = { "filterCallout": {...}, "stocks": [...] };
```

**关键约束**：
- `index.html` 中 meta.js 必须在最前面
- 模板函数签名 `renderXxx(data, mode)`，mode=`'app'`|`'pdf'`
- iframe srcdoc 渲染，sandbox: `allow-same-origin allow-scripts`，CSS完全隔离
- iframe 内 onclick 回调必须使用 `parent.functionName()` 前缀

### 推荐数据库规则

- `recommendation-history.json` 为推荐数据库，上限 **50只**
- 每次更新时新推荐股打分入库，**不得推荐数据库中已有的股票**
- 超过50只时，按综合得分**淘汰最低分**（同分则淘汰最早推荐的）
- ⚠ recommendation-history.json 和 recommendation-history.js 必须同步更新

### TOP5 排名规则

**TOP5直接从推荐数据库按 compositeScore 取前5名：**
- 先按 compositeScore 降序，同分按 firstRecommended 降序，再同分按JSON顺序
- section6 和推荐历史面板的 sort 逻辑必须完全一致
- TOP5中价格/PE为当日实时数据，但排名依据是数据库中的 compositeScore

### PDF导出机制

```bash
# 步骤1: Node.js生成静态HTML（加载所有模板+数据脚本）
cd "report-engine" && node -e "..."  # 详见旧版CLAUDE.md底部
# 步骤2: Chrome headless打印
chrome --headless --print-to-pdf="reports/报告.pdf" --no-sandbox "file:///.../export-static.html"
```

---

## 邮件发送

```bash
cd "C:/Users/anzhe/FIRSTCC" && node send_mail.js "anzhezhouclaude@163.com" "NXtVgDqN5E4S8dSB" "anzhezhou@126.com" "主题" "正文" "附件路径"
```
SMTP: smtp.163.com:465 (SSL)

**主题格式**：`YYYY年M月D日 每日行情分析报告`

---

## 桌面快捷方式

### 桌面快捷方式（`Francis Investment.lnk`）
- 路径：`C:\Users\anzhe\Desktop\Francis Investment.lnk`
- 目标：`C:\Users\anzhe\FIRSTCC\Francis Investment\open.vbs`（直接指向，无需 wscript 包装）
- 图标：`report-engine\FI-icon.ico`（金色 FI 标志）
- 功能：双击 → 检测服务器状态 → 未运行则静默启动 → 打开 Chrome 独立窗口到 `http://127.0.0.1:8765`

### 开机自启快捷方式（`Francis Investment.lnk`）
- 路径：`C:\Users\anzhe\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\Francis Investment.lnk`
- 目标：`C:\Users\anzhe\FIRSTCC\Francis Investment\launch.vbs`
- 功能：开机后台静默启动 Mosaic Server（仅服务器，不打开浏览器）

### 架构说明
- `open.vbs` — 先检测 `127.0.0.1:8765` 是否已运行，未运行则 `node mosaic_server.js` 隐藏启动（等5秒），最后打开 Chrome `--app` 模式。桌面快捷方式用。
- `launch.vbs` — 隐藏启动 `node mosaic_server.js`（仅服务器，不开浏览器）。开机自启用。
- `start.bat` — 手动启动用（有控制台窗口），含服务器检测+Chrome 启动。双击可直接调试。
- VBS 使用 `Chr(34)` 拼接含空格的路径（`Francis Investment`），避免 VBS 嵌套引号转义问题。

---

## 已知教训

### 2026-05-21（数据准确性）
16只推荐股中11只股价错误，3只超20元上限，2只涨跌方向写反。
- **改进**：验证步骤独立成章，每只股票强制WebSearch确认，三文件交叉验证。

### 2026-05-22（渲染/排名/PDF）
推荐历史面板关闭按钮无响应（iframe隔离）、TOP5与推荐历史排名不一致、中文引号导致Node.js解析失败。
- **改进**：iframe onclick 加 `parent.` 前缀、TOP5直接从数据库排序、PDF导出前语法检查。

### 2026-05-24（架构升级）
从静态 file:// 架构升级为 Mosaic Server (Node.js HTTP)，前端从 `<script>` 数据注入改为 `fetch()` API 调用。
- 新增：7因子隐藏信号引擎、综合评分模型、Simfolio模拟交易、一键启动脚本。

### 2026-05-26（VBS 启动脚本修复）

`open.vbs` 桌面快捷方式一直显示"无法连接网站"——服务器根本没启动。
- **根因**：VBScript 中 `Err.Number = 0 And http.Status = 200` 这个条件在服务器未运行时行为异常。`http.Send` 失败后 `http.Status` 返回 `Empty`，`Empty = 200` 在 VBScript 中结果是 `Empty`（而非 `False`），导致整个 `And` 表达式塌陷为 `Empty`，检测逻辑错误地判定"服务器已运行"，跳过了启动步骤。
- **修复**：改用嵌套 `If` 逐个条件判断（先判 `Err.Number = 0`，再判 `http.Status = 200`），避免 `And` 运算符的 `Empty` 传播问题。同时用 `Chr(34)` 拼接含空格路径（`Francis Investment`），替代嵌套引号转义。
- **设计变更**：`open.vbs` 从"仅打开 Chrome"改为"检测服务器 → 按需启动 → 打开 Chrome"，确保无论何种场景双击桌面快捷方式都能正常工作。`start.bat` 保留为手动调试备选方案（有可见控制台窗口）。

### 2026-05-25（快捷方式 + UI 打磨）

v2.2 收尾优化：
- **快捷方式 VBS 化**：`cmd.exe` → `wscript.exe` 包装 → 最终直接指向 `.vbs` 文件。前两种方案因 Windows Shell 引号处理问题导致双击无反应。直接指向 .vbs（Windows 自动用 wscript.exe 执行）最可靠。
- **UI 去冗余**：删除工具栏 `#live-next-check` 倒计时（Simfolio 面板已有更详细的倒计时条）；删除日历 `.has-report` 圆点装饰（保持日历干净，仅金色高亮选中日期）。
- **文件新增**：`launch.vbs`（静默启动服务器）、`open.vbs`（静默打开 Chrome）、`FI-icon.ico`（金色 FI 快捷方式图标）。
Eastmoney push2 API 被限（TCP连接成功但服务器不发HTTP响应），导致候选股仅8只、评分最高57分。
- **修复**：新增腾讯API（`qt.gtimg.cn`）为主力源（含PE），新浪API为备选。候选股从8只恢复至864只（PE≤40过滤后）。
- **PE过滤**：FILTER.maxPE = 40（亏损股null保留），排除高PE泡沫股。
- **残留问题**：Eastmoney 详情/K线API仍不可用 → 财务数据（ROE/负债率/利润增长）缺失 → 基本面评分~50默认值 → 综合评分上限约63分（B级），H4/H5/H6难以触发。需寻找替代基本面数据源。
- Simfolio 持仓（2026-05-25）：5只试探买入（72分/B级），评分过于集中因基本面维度单一。

### 2026-05-26（评分体系重构 + 专业量化升级）

AI 交易员全天零交易——扫描 5,539 只股票后 TOP5 最高仅 53 分，远低于 70 分绝对阈值。
- **根因分析**：三个叠加问题：(1) 隐藏信号无触发时得分=0（应=50），35%权重直接清零；(2) 基本面数据常缺失（Eastmoney API 不稳定），评分锚定在50；(3) 绝对阈值70脱离实际分数分布（当日可达到的最高分约63）。
- **修复**：
  - Phase 1（评分校准）：隐藏信号中性分50、基本面缺失自适应降权（25%→10%）、百分位阈值替代绝对70分（Top 20% = 买入线）
  - Phase 2（新数据源）：新建3个采集器——`capital_flow.js`（主力资金流方向性数据，f62/f64/f66/f70/f72）、`dragon_tiger.js`（龙虎榜 datacenter-web API，独立于 push2 反爬）、`north_bound.js`（北向资金 push2his kamt.kline API）
  - Phase 3（因子升级）：资金流评分从"纯活跃度"重构为"方向性"（主力净流入占比+超大单vs小单背离+板块资金流排名+连续流入天数）；新增事件驱动维度（龙虎榜加分+北向情绪调整）；新增H8（短期反转）+H9（量价背离）动量因子
  - Phase 4（权重+集成）：因子权重调整为 fundamental(25%)+technical(15%)+hidden(20%)+capital_flow(25%)+event(15%)，Pipeline+调度器全链路集成新采集器
- **效果**：TOP5 评分从 52-53 提升至 58-63（提高6-10分），首次触发买入决策（中国石油 63分/B级 900股 ¥9,693）。评分仍偏低因基本面数据缺失（东方财富详情API仍不可用）+ 当日行情低迷（TOP5全部为银行/石油等防御性大盘股）。

---

## 已有报告

| 日期 | 内容 |
|------|------|
| 2026-05-14 | 每日行情分析（仅PDF） |
| 2026-05-15 | 每日行情+K线诊断+8板块筛选+TOP5（14→16只潜力股） |
| 2026-05-21 | 暴跌日报告+8板块16只精选+TOP5重评 |
| 2026-05-22 | 缩量修复+科创50领涨+1.51%+FSD入华+商业航天双催化（当前最新，48只推荐数据库） |

---

## 更新流程（手动模式，v1兼容）

用户说"更新报告"时使用。v2模式下 Pipeline 自动完成大部分步骤。

### 0. 检查
- 确认交易日（周一至周五，非节假日）
- 阅读 `recommendation-history.json` 了解已有推荐
- 参考最近一期 `data/YYYY-MM-DD/` 文件作为格式范例

### 1. 数据搜索（6-8个并行WebSearch）
1. 大盘行情：上证/深证/创业板/科创50
2. 时政新闻
3. 金发科技(600143)：股价+资金+融资+5日K线
4. 利欧股份(002131)：同上
5. 8大板块当日动态
6. 每板块筛2只新股（<20元，非创业板，成交>1亿，不与数据库重复）
7. 每只候选股单独确认：收盘价+涨跌幅+PE+成交额

### 2. 创建数据文件
在 `data/YYYY-MM-DD/` 下创建8个 .js 文件（meta + 7 section），更新 `index.html` 引用。

### 3. 更新索引和推荐历史
更新 `reports-index.json/js` 和 `recommendation-history.json/js`。

### 4. 预览和导出
Chrome 打开 `index.html` 逐板块检查，PDF导出。
