# Francis Investment CLAUDE.md

A股投资分析报告引擎 + Mosaic 量化系统。Node.js 本地服务器驱动，全自动联网采集+量化评分+模拟交易。

---

## 项目概述

Francis Investment 经历了两个阶段的演进：

| 阶段 | 架构 | 数据来源 |
|------|------|----------|
| **v1**（静态引擎） | 纯静态HTML，Chrome file:// 打开，数据通过 `<script>` 注入 | Claude WebSearch 手动采集 |
| **v2**（Mosaic 量化） | Node.js HTTP 服务器 (localhost:8765)，Chrome --app 模式 | 腾讯+Sina+Eastmoney 三源自动采集 |

v2 新增：7因子隐藏信号引擎、4维综合评分模型、Simfolio 模拟交易（10万虚拟资金，T+1，真实费率）。

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
├── mosaic_server.js             # ★ Node.js HTTP 主服务器（零外部依赖）
├── CLAUDE.md                    # 本文件
├── update-shortcut.vbs          # 桌面快捷方式创建器
├── make-shortcut.ps1            # PowerShell 快捷方式创建器
├── mosaic/                      # ★ 量化引擎
│   ├── config.js                #   配置文件（筛选条件、因子权重、交易参数）
│   ├── pipeline.js              #   主流程编排器（EventEmitter，进度推送）
│   ├── simfolio.js              #   模拟交易引擎（自动买卖+风控+净值跟踪）
│   ├── collectors/
│   │   └── market_data.js       #   数据采集（Tencent主源+Sina备选+Eastmoney详情，三源架构）
│   └── factors/
│       ├── hidden_signals.js    #   7因子隐藏信号引擎（H1-H7）
│       └── composite.js         #   综合评分模型（4维加权+6维展示）
├── report-engine/               # ★ 前端报告引擎
│   ├── index.html               #   主UI（服务器模式下用fetch读取API）
│   ├── style.css                #   样式（含 .btn-accent 进度条等）
│   ├── app.js                   #   状态管理、Pipeline轮询、Simfolio渲染、PDF
│   ├── renderer.js              #   renderFullReport(data, mode) 串联9个section
│   ├── kline.js                 #   K线SVG生成 + renderKlineSVG()
│   ├── export-static.html       #   PDF导出中间文件（临时）
│   ├── data/
│   │   ├── template-default.json
│   │   ├── reports-index.json / .js
│   │   ├── recommendation-history.json / .js
│   │   ├── simfolio/            # ★ Simfolio 持久化目录
│   │   │   └── portfolio.json   #   持仓+交易记录+净值历史
│   │   └── YYYY-MM-DD/          #   每日报告数据（8个 .js 文件）
│   └── templates/               #   12个模板函数
│       ├── css.js / cover.js / news-policy.js / market-overview.js
│       ├── holdings-analysis.js / sector-tracking.js / low-price-picks.js
│       ├── top5-ranking.js / risk-matrix.js / recommendation-history.js
│       ├── simfolio.js          # ★ Simfolio 模拟交易看板模板
│       └── disclaimer-footer.js
└── reports/                     # 导出的PDF文件
```

### 数据源架构（三源双活）

Eastmoney push2 API 自2025年起实施反爬限制，TCP连接成功但服务器不返回HTTP响应。Mosaic 采用三数据源架构：

| 数据源 | 端点 | 用途 | 状态 |
|--------|------|------|------|
| **Tencent** | `qt.gtimg.cn` | 全A股行情列表（含PE/PB/成交额），每批60只 | ✅ 主力 |
| **Sina** | `hq.sinajs.cn` | 全A股行情列表（无PE），每批80只 | ✅ 备选 |
| **Eastmoney** | `push2.eastmoney.com` | 个股详情（ROE/负债率/利润增长）+ K线数据 | ❌ 被限 |

**PE 数据来源**：腾讯API第39字段（动态PE），Sina不提供PE。PE ≤ 40 过滤（亏损股PE为null，保留）。

**关键限制**：Eastmoney 详情/K线 API 不可用导致基本面评分维度缺失（ROE、负债率、利润增长等均为null），综合评分上限约63分（B级），H4/H5/H6 难以触发。

### 启动方式

**正常使用**：双击 `start.bat`（或桌面快捷方式 `Francis Investment.lnk`）
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

### 7个隐藏因子（H1-H7）

基于 Eastmoney API 可计算因子，权重占综合评分 **35%**：

| # | 因子 | 信号逻辑 | 权重 |
|---|------|---------|------|
| H1 | 缩量止跌 | 5日跌幅>3% + 成交量缩至20日均量50%以下 → 卖压枯竭 | 中 |
| H2 | 底部放量 | 价格距20日低点<5% + 当日成交量>20日均量2倍 → 反转信号 | 高 |
| H3 | 逆势抗跌 | 大盘跌>0.5%但个股涨>1% → 有资金护盘 | 高 |
| H4 | PE极度低估 | PE<15 + 净利润增长>10% → 低估值成长 | 高 |
| H5 | 高ROE低PB | ROE>15% + PB<2 → 质优价廉 | 中 |
| H6 | 经营现金流健康 | OCF/股 > 每股收益×0.8 → 利润真实 | 中 |
| H7 | 低换手蓄力 | 换手率<1% + 连续3日窄幅震荡 → 蓄势待发 | 低 |

> ⚠ H4/H5/H6 依赖 Eastmoney 详情API（ROE、负债率、利润增长、经营现金流）。当前 Eastmoney 被限，这三个因子基本不触发。H1/H2/H3/H7 仅需行情数据，正常运作。

### 综合评分公式

```
TotalScore = fundamental(25%) + technical(20%) + hidden(35%) + capitalFlow(20%)
```

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

### 自动交易逻辑

**买入**：
| 条件 | 操作 |
|------|------|
| 综合分 ≥80 + 触发强信号 | 强买入：投入现金20% |
| 综合分 ≥70 | 试探买入：投入现金10% |
| 已持仓 | 跳过 |

**卖出**：
| 条件 | 操作 |
|------|------|
| 亏损 ≥8% | 硬止损，全仓清 |
| 综合分 <50 | 软止损，清仓 |
| 盈利 >20% 且信号消失 | 止盈，落袋为安 |

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

`C:\Users\anzhe\Desktop\Francis Investment.lnk`
- Target: `C:\Windows\System32\cmd.exe`
- Args: `/c ""C:\Users\anzhe\FIRSTCC\Francis Investment\start.bat""`
- 功能：双击 → 启动 Mosaic Server + Chrome 独立窗口

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

### 2026-05-25（Eastmoney API 反爬 + 数据源切换）
Eastmoney push2 API 被限（TCP连接成功但服务器不发HTTP响应），导致候选股仅8只、评分最高57分。
- **修复**：新增腾讯API（`qt.gtimg.cn`）为主力源（含PE），新浪API为备选。候选股从8只恢复至864只（PE≤40过滤后）。
- **PE过滤**：FILTER.maxPE = 40（亏损股null保留），排除高PE泡沫股。
- **残留问题**：Eastmoney 详情/K线API仍不可用 → 财务数据（ROE/负债率/利润增长）缺失 → 基本面评分~50默认值 → 综合评分上限约63分（B级），H4/H5/H6难以触发。需寻找替代基本面数据源。
- Simfolio 持仓（2026-05-25）：5只试探买入（72分/B级），评分过于集中因基本面维度单一。

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
