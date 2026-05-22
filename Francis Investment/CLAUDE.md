# Francis Investment CLAUDE.md

A股投资分析报告引擎。纯静态Web应用，双模式渲染（软件白底/PDF暗色学术），数据通过 `<script>` 注入 `window.__REPORT_DATA__` 全局变量，规避Chrome `file://` 的fetch限制。

---

## ⚠ 数据准确性铁律（2026-05-21 教训更新）

**根本原则：所有股价、涨跌幅、PE、成交额必须来自WebSearch实时查询，绝不估算。**

### 绝对禁止
- ❌ 凭板块走势推算个股价格（同一个板块不同股票差异巨大）
- ❌ 用"约XX元"模糊估算代替精确价格
- ❌ 假设股票"逆势抗跌/逆势上涨"而不验证实际涨跌幅
- ❌ 直接用上次推荐时的价格作为本次价格（股价每天变化）
- ❌ 在未查PE的情况下填写PE值（亏损股PE为负值/null，不能填具体数字）
- ❌ 根据涨跌方向编造"主力净流入/流出"——必须查资金流向数据

### 必须遵守
- ✅ 每只潜力股单独WebSearch查询当日收盘价+涨跌幅
- ✅ PE需查实时数据，亏损股票PE写"亏损"或null，不编造数字
- ✅ 涨跌%的正负号决定"逆势/跟跌"定性——写K线分析前先确认方向
- ✅ 20元股价上限用实时价格判断（之前符合条件不等于现在符合）
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

### 推荐股6维评分标准

每只推荐股从6个维度打分（1-5★，★=1分/☆=0.5分），综合分 = 原始总分/30×100（四舍五入）。评级：85+ = S（卓越），75-84 = A（优秀），60-74 = B（良好），45-59 = C（一般），<45 = D（回避）。

| 维度 | 5★（满分）标准 | 3★（及格）标准 | 1★（差）标准 |
|------|---------------|---------------|-------------|
| 📊 财务报表 | 营收+净利双增20%+、负债率<30%、ROE>15%、经营现金流为正 | 营收/净利个位数增长、负债率40-60%、ROE 5-10% | 持续亏损、负债率>70%、现金流为负、有退市风险 |
| 📈 K线技术面 | 均线多头排列、MACD金叉、量价配合良好、处于上升趋势 | 均线走平/小幅纠结、MACD零轴附近、低波动横盘 | 均线空头排列、MACD死叉、持续放量下跌、破位形态 |
| 🏛 公司治理 | 央企/国资控股、年报无保留意见、无负面舆情、分红稳定 | 民企但治理规范、无重大负面、信息披露合规 | 实控人风险、商誉/应收悬顶、曾有违规记录 |
| 🏭 产业逻辑 | 政策强驱动+行业增速>30%、市占率龙头、多催化叠加 | 行业增速10-20%、有政策支撑、但非核心受益 | 产业萎缩、政策利空、无差异化竞争力 |
| 🏦 机构态度 | 多家机构覆盖+买入评级、北向增持、主力持续净流入 | 1-2家覆盖、主力中性、机构轻度参与 | 无机构覆盖、主力持续流出、机构大幅减持 |
| 💰 资金面 | 日成交>5亿+换手2-5%、融资余额稳定、无恐慌抛售 | 日成交1-5亿、换手1-2%、资金面平淡 | 日成交<1亿、流动性枯竭、主力连续出逃 |

### 推荐数据库规则

- `recommendation-history.json` 为推荐数据库，上限 **50只**
- 每次更新时新推荐股打分入库，**不得推荐数据库中已有的股票**
- 超过50只时，按综合得分**淘汰最低分**（同分则淘汰最早推荐的）
- 只有数据库中的股票参与 **TOP5 排行**
- TOP5 右上角"推荐历史记录"按钮可查看全部排名
- ⚠ recommendation-history.json 和 recommendation-history.js 必须同步更新

### TOP5 排名规则（⚠ 2026-05-22 修正）

**TOP5直接从推荐数据库按 compositeScore 取前5名，与推荐历史面板完全同步。**

- 排序规则：先按 `compositeScore` 降序，同分按 `firstRecommended` 降序（新推荐优先），再同分按JSON原有顺序
- ⚠ **section6 和推荐历史面板必须使用完全相同的排序逻辑**（两处代码需同步维护）
- TOP5中展示的价格/PE为**当日实时数据**（来自WebSearch验证），但排名依据是数据库中的 `compositeScore`
- 推荐历史面板模板 (`templates/recommendation-history.js`) 的sort函数需包含同分tiebreaker

### 历史记录维护

- ⚠ **历史推荐股票需定期用最新收盘价重评**：`priceAtRec`/`peAtRec` 保留推荐时快照，但 `compositeScore` 和 `dimensionScores` 应反映最新评估
- 低分股票（C级<60分）应每期审查：若确实不合格则从市场重新搜索替换
- 评分需注意小盘股偏见：机构态度/资金面维度对小盘股天然不利，需结合实际情况调整
- 替换股票时需保持各板块股票数量平衡

---

## 架构

```
report-engine/
├── index.html / style.css     # 主UI：左侧320px边栏 + 16px gap + 右侧内容区
├── app.js                     # 状态管理、日历、板块导航、PDF生成
├── renderer.js                # renderFullReport(data, mode) 串联8个section + 推荐历史
├── kline.js                   # K线SVG生成（纯计算，无DOM依赖）+ renderKlineSVG()
├── export-static.html         # ★ PDF导出中间文件（Node.js生成静态HTML，可删除）
├── FI-icon.ico                # 桌面快捷方式图标（金色圆角矩形+Georgia "FI"）
├── data/
│   ├── template-default.json   # ★ 新报告数据模板（8个section完整结构）
│   ├── reports-index.json      # 报告索引（app.js通过fetch读取）
│   ├── reports-index.js        # 同上（script注入，全局变量 __REPORTS_INDEX__）
│   ├── recommendation-history.json  # 推荐数据库（JSON源）
│   ├── recommendation-history.js    # 同上（script注入，window.__RECOMMENDATION_HISTORY__）
│   └── YYYY-MM-DD/             # 每日期一个目录，8个分板块 .js 文件
│       ├── meta.js              #   元信息 + disclaimer
│       ├── section1_newsPolicy.js
│       ├── section2_marketOverview.js
│       ├── section3_holdingsAnalysis.js
│       ├── section4_sectorTracking.js
│       ├── section5_lowPricePicks.js  # ★ 最常更新（潜力股推荐）
│       ├── section6_top5Ranking.js
│       └── section7_riskMatrix.js
└── templates/                  # 11个模板函数
    ├── css.js                  #   统一定义所有CSS样式
    ├── cover.js
    ├── news-policy.js
    ├── market-overview.js
    ├── holdings-analysis.js
    ├── sector-tracking.js
    ├── low-price-picks.js
    ├── top5-ranking.js
    ├── risk-matrix.js
    ├── recommendation-history.js  # 推荐历史面板（iframe渲染）
    └── disclaimer-footer.js
```

### 数据注入模式

每个分板块文件使用 accumulator 模式合并到 `window.__REPORT_DATA__`：

```javascript
window.__REPORT_DATA__ = window.__REPORT_DATA__ || {};
var _d = window.__REPORT_DATA__['2026-05-15'] = window.__REPORT_DATA__['2026-05-15'] || {};
_d.section5_lowPricePicks = { "filterCallout": {...}, "stocks": [...] };
```

**关键约束**：
- 数据通过 `<script>` 注入全局变量，不使用 fetch
- `index.html` 中 meta.js 必须在最前面（提供 `reportTitle` 等元信息）
- **增量更新**：只需重写变化的板块文件，不必重新生成整个报告
- 模板函数签名 `renderXxx(data, mode)`，mode=`'app'`|`'pdf'`
- iframe srcdoc 渲染内容（sandbox: `allow-same-origin allow-scripts`），CSS完全隔离

### PDF导出机制

PDF通过两步生成（因为Chrome headless无法执行file://页面的JS）：
1. **Node.js生成静态HTML**：`node -e "vm.runInThisContext(...)"` 加载所有模板+数据脚本，调用 `renderFullReport(data, 'pdf')` 输出纯HTML
2. **Chrome headless打印**：`chrome --headless --print-to-pdf` 将静态HTML转为PDF

注意：Node.js需要包含 kline.js（renderKlineSVG依赖），且需stub全局变量 `window`、`document`、`escHtml`。

---

## 更新流程

用户说"更新"时（非交易日跳过），按以下步骤执行。

### 0. 更新前检查

- [ ] 确认当日为交易日（周一至周五，非节假日）
- [ ] 阅读 `data/recommendation-history.json` 了解已有推荐股（避免推荐重复）
- [ ] 阅读 `data/template-default.json` 确认数据结构
- [ ] 参考最近一期 `data/YYYY-MM-DD/` 目录下的文件作为格式范例
- [ ] 确认8大板块：机器人/具身智能、创新药/AI医疗、半导体/AI算力、商业航天、固态电池/储能、有色金属/稀土、新型电力基建、军工

### 1. 数据搜索（6-8个并行WebSearch）

**所有数据必须重新搜索，不得复用旧报告。每只股票单独查询，不要批量估算。**

1. 大盘行情：上证/深证/创业板/科创50 收盘点位+涨跌幅+成交额
2. 时政新闻：重大政策/中美关系动态
3. 金发科技(600143)：股价+主力资金+融资余额+近5日K线
4. 利欧股份(002131)：同上
5. 8大板块当日动态
6. **每板块筛2只新股**：<20元（实时价格！），非创业板(300/301xxx)，日成交>1亿，不与 `recommendation-history.json` 重复
7. ⚠ **每只候选股单独WebSearch确认：收盘价+涨跌幅+PE（亏损填null）+成交额**

来源优先级：东方财富 > 证券时报 > 同花顺 > 新浪财经。

### 2. 验证步骤（⚠ 新增 - 防止数据编造）

**写完所有16只股票数据后，必须执行以下交叉验证：**

- [ ] **价格验证**：逐只WebSearch确认当日实际收盘价（不要信任任何估算）
- [ ] **20元上限检查**：所有price字段 < 20.00
- [ ] **涨跌方向验证**：每只确认changePercent正负号，与"逆势/跟跌"定性一致
- [ ] **PE核实**：至少查Q1归母净利润，亏损股填"亏损"或null，不编造数字
- [ ] **三文件一致性**：section5 stocks[] 的 price/pe/reason 必须与 recommendation-history.json 中对应条目一致
- [ ] **section6数据对齐**：TOP5中每个股票的价格/PE必须与section5一致
- [ ] **K线分析叙事检查**：逆势上涨→changePercent为正；跟跌→changePercent为负。数字和叙事不能矛盾

### 3. 创建数据文件

```bash
mkdir -p "report-engine/data/YYYY-MM-DD"
# 参考 data/template-default.json 的8个section结构，创建8个 .js 文件
# 每个文件用 accumulator 模式注入 window.__REPORT_DATA__
```

**section 文件对应关系**：
| 文件 | template key | 渲染模板 |
|------|-------------|---------|
| `meta.js` | `meta` + `disclaimer` | `cover.js` + `disclaimer-footer.js` |
| `section1_newsPolicy.js` | `section1_newsPolicy` | `news-policy.js` |
| `section2_marketOverview.js` | `section2_marketOverview` | `market-overview.js` |
| `section3_holdingsAnalysis.js` | `section3_holdingsAnalysis` | `holdings-analysis.js` |
| `section4_sectorTracking.js` | `section4_sectorTracking` | `sector-tracking.js` |
| `section5_lowPricePicks.js` | `section5_lowPricePicks` | `low-price-picks.js` |
| `section6_top5Ranking.js` | `section6_top5Ranking` | `top5-ranking.js` |
| `section7_riskMatrix.js` | `section7_riskMatrix` | `risk-matrix.js` |

### 4. 更新 index.html

将 `<script src="data/YYYY-MM-DD/...">` 中旧日期路径替换为新日期（共8个引用），`meta.js` 必须排在最前。

### 5. 更新索引和推荐历史

- `data/reports-index.json` 和 `data/reports-index.js` 添加新条目
- `data/recommendation-history.json` 追加新推荐股（含6维评分）
- ⚠ **同步更新 `data/recommendation-history.js`**（必须与JSON完全一致）
- 每只新入库股票需写入：code, name, sector, firstRecommended, priceAtRec, peAtRec, reason, compositeScore, dimensionScores
- 如数据库超50只，淘汰综合分最低的（同分则淘汰最早推荐的）

### 6. Section 6 TOP5 排名（⚠ 与推荐历史数据库同步）

**TOP5直接从推荐历史数据库按 compositeScore 取前5名**（与推荐历史面板的排序完全一致）。

- 排序规则：先按 compositeScore 降序，同分按 firstRecommended 降序（新推荐优先），再同分按JSON原有顺序
- ⚠ `templates/recommendation-history.js` 和 `section6_top5Ranking.js` 的sort函数必须使用完全相同的排序逻辑
- TOP5中展示的价格/PE应为当日实时数据（来自WebSearch验证），但排名依据是数据库中的 compositeScore
- 生成section6前必须验证：TOP5数据与section5、recommendation-history.json三处完全对齐

### 7. 预览和导出

1. Chrome打开 `index.html` 逐板块检查
2. **PDF导出**（两步法）：
```bash
# 步骤1: Node.js生成静态HTML
cd "report-engine" && node -e "
var fs=require('fs');var vm=require('vm');
global.window=global;global.document={createElement:function(){return{};}};
global.escHtml=function(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');};
['templates/css.js','templates/cover.js','templates/news-policy.js','templates/market-overview.js','templates/holdings-analysis.js','templates/sector-tracking.js','templates/low-price-picks.js','templates/top5-ranking.js','templates/risk-matrix.js','templates/recommendation-history.js','templates/disclaimer-footer.js','kline.js','data/recommendation-history.js','data/YYYY-MM-DD/meta.js','data/YYYY-MM-DD/section1_newsPolicy.js','data/YYYY-MM-DD/section2_marketOverview.js','data/YYYY-MM-DD/section3_holdingsAnalysis.js','data/YYYY-MM-DD/section4_sectorTracking.js','data/YYYY-MM-DD/section5_lowPricePicks.js','data/YYYY-MM-DD/section6_top5Ranking.js','data/YYYY-MM-DD/section7_riskMatrix.js','renderer.js'].forEach(function(f){vm.runInThisContext(fs.readFileSync(f,'utf8'),f);});
var data=global.__REPORT_DATA__['YYYY-MM-DD'];var html=renderFullReport(data,'pdf');
fs.writeFileSync('export-static.html','<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"UTF-8\">\n<title>Report</title>\n</head>\n<body>\n'+html+'\n</body>\n</html>','utf8');
console.log('OK: '+fs.statSync('export-static.html').size+' bytes');
"
# 步骤2: Chrome headless打印
"C:/Program Files/Google/Chrome/Application/chrome.exe" --headless --disable-gpu --print-to-pdf="reports/报告名称.pdf" --no-sandbox "file:///C:/Users/anzhe/FIRSTCC/Francis%20Investment/report-engine/export-static.html"
# 步骤3: 清理
rm -f "export-static.html"
```
3. K线MACD/BOLL切换、板块3列布局、潜力股筛选标签、TOP5字体逐项检查

---

## 邮件发送

### 发送命令
```bash
cd "C:/Users/anzhe/FIRSTCC" && node send_mail.js "anzhezhouclaude@163.com" "NXtVgDqN5E4S8dSB" "anzhezhou@126.com" "主题" "正文" "附件路径"
```
SMTP: smtp.163.com:465 (SSL)

### 邮件格式规范

- **主题**：`YYYY年M月D日 每日行情分析报告`（如 "2026年5月22日 每日行情分析报告"）
- **正文格式**：

```
Dear Francis,

附件是 YYYY年M月D日 的A股每日行情分析报告（PDF格式）。

报告标题：<reportTitle>

本报告基于今日收盘数据实时生成，涵盖以下内容：
· 时政新闻与政策解读
· 大盘行情概览（上证/深证/创业板/科创50）
· 持仓股诊断（金发科技600143、利欧股份002131）
· 8大热门板块跟踪（机器人/创新药/半导体/商业航天/固态电池/有色金属/新型电力基建/军工）
· 低位潜力股精选（<20元 × 16只 × 6维评分）
· TOP5综合排名（推荐数据库compositeScore排序）
· 风险矩阵与五大纪律

⚠ 本报告不构成投资建议，仅供参考。投资有风险，入市需谨慎。

Best regards,
Francis Investment Report Engine
```

---

## 桌面快捷方式

`C:\Users\anzhe\Desktop\Francis Investment.lnk` — Chrome `--app` 模式独立窗口
- Target: `C:\Program Files\Google\Chrome\Application\chrome.exe`
- Args: `--app="file:///C:/Users/anzhe/FIRSTCC/Francis Investment/report-engine/index.html" --window-size=1400,900`
- Icon: `FI-icon.ico`（金色圆角矩形+白色Georgia "FI"字，64×64）

---

## 已知教训（2026-05-21）

**问题**：16只推荐股中11只股价数据错误，3只超20元上限未发现，2只涨跌方向完全写反。

**根因**：
1. 股价凭感觉估算而非逐个WebSearch验证
2. "涨了/跌了"基于板块推测而非实际数据
3. PE等财务数据照抄历史而非实时查询
4. section5、recommendation-history、section6三处数据未交叉验证

**改进措施**（已纳入上述流程）：
1. 验证步骤独立成章（步骤2），16只股票逐一核查
2. 强制每只候选股WebSearch确认收盘价
3. PE亏损股统一标记"亏损"或null
4. 三文件一致性检查纳入流程
5. K线叙事先确认涨跌方向再落笔

---

## 已知教训（2026-05-22）

**问题**：推荐历史面板关闭按钮无响应、TOP5与推荐历史排名不一致、Node.js解析JS时中文引号报错、低分股票长期未审查。

**根因**：
1. 推荐历史面板通过iframe srcdoc渲染，`onclick="closeRecommendationHistory()"` 无法访问父窗口函数——需加 `parent.` 前缀
2. section6使用独立的"实时重评加权"计算TOP5，与推荐历史的compositeScore排序逻辑完全不同
3. section7风险矩阵中 `"多杀多"` 含未转义的ASCII双引号，Node.js `vm.runInThisContext` 解析报错
4. 低分股票（<60分C级）未定期审查替换——应每期检查

**改进措施**（已纳入上述流程）：
1. iframe srcdoc中的所有onclick回调必须使用 `parent.functionName()` 格式
2. TOP5直接从数据库按compositeScore取前5名（而非独立加权计算），两文件sort逻辑完全同步
3. PDF导出前必须逐文件 `new Function(code)` 语法检查所有JS数据文件
4. 数据库<60分股票每期审查替换、60-70分股票定期重评（利用最新季报数据）
5. PDF导出Node.js命令需包含 `data/recommendation-history.js` 文件

---

## 已有报告

| 日期 | 内容 |
|------|------|
| 2026-05-14 | 每日行情分析（仅PDF） |
| 2026-05-15 | 每日行情+K线诊断+8板块筛选+TOP5（当前最新，含14→16只潜力股） |
| 2026-05-21 | 暴跌日报告+8板块16只精选+TOP5重评（全部数据经WebSearch核实） |
| 2026-05-22 | 缩量修复+科创50领涨+1.51%+FSD入华+商业航天双催化+TOP5改数据库同步（当前最新，含48只推荐数据库） |
