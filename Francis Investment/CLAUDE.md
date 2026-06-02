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
curl http://8.153.101.112:8765/api/margin/status
curl http://8.153.101.112:8765/api/knowledge/factor-combos
curl http://8.153.101.112:8765/api/config/public

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
├── mosaic_server.js             # ★ HTTP 主服务器 (0.0.0.0:8765) — 含 30+ API 路由
├── mosaic/                      # ★ 量化引擎
│   ├── config.js                #   所有配置（阈值/权重/时间表/因子名/分层仓位/周末分析/验证）→ 改配置只看这个
│   ├── scheduler.js             #   ★ 状态机调度器：tick→状态转换→Pipeline→美股采集→16:00总结+相关性快照+因子绩效
│   ├── pipeline.js              #   主流程编排（EventEmitter）— 8维预评分+SSE实时广播+两融数据集成
│   ├── simfolio.js              #   模拟交易引擎（分层仓位+思维舱防御门+周末上下文注入+T+1风控+净值持久化）
│   ├── collectors/              #   数据采集
│   │   ├── market_data.js       #   A股行情（Eastmoney push2+datacenter双源基本面，腾讯+Sina备选）
│   │   ├── us_market.js         #   ★ 美股行情（Sina gb_ API, 30只符号, 60s轮询）
│   │   ├── index_recorder.js    #   指数分钟线记录器
│   │   ├── capital_flow.js      #   资金流（含个股资金流历史+板块资金流）
│   │   ├── dragon_tiger.js      #   龙虎榜（LHB）
│   │   ├── north_bound.js       #   北向资金（含情绪计算）
│   │   ├── margin_data.js       #   ★ 两融数据采集器（融资融券情绪代理，Eastmoney push2 K线）
│   │   └── news_collector.js    #   新闻采集（含7级情感词典评分）
│   ├── factors/                 #   评分引擎
│   │   ├── hidden_signals.js    #   ★ H1-H9 隐藏因子（9个）→ computeHiddenSignals()
│   │   └── composite.js         #   ★ 5维综合评分 + 北向绩效动态权重 + 两融情绪调整 + LHB增强
│   └── analysis/                #   盘后+周末分析
│       ├── quant_report.js      #   交易归因+新闻预测
│       ├── knowledge_base.js    #   因子追踪知识库（含因子组合模式提取）
│       ├── cross_market.js      #   ★ 跨市场相关性引擎 + 风险状态机（5档）
│       ├── us_macro.js          #   ★ 美股隔夜总结生成器
│       ├── factor_performance.js #   ★ 因子绩效追踪引擎（命中率/平均收益/趋势 + 北向绩效追踪）
│       ├── weekend_analyzer.js  #   ★ 周末深度分析引擎（4阶段：聚合→K线→分析→上下文+验证反馈）
│       ├── weekend_verifier.js  #   ★ 周末分析验证引擎（相似度/危机/板块/因子/洞察 5维验证→反馈到下周）
├── report-engine/               # ★ 前端（纯静态）
│   ├── index.html               #   主仪表板（8个section，含两融情绪指标+新闻情感标签+仓位分层+验证反馈链路）
│   ├── think-tank.html          #   ★ AI 思考舱（SSE实时+4卡风险中枢+因子组合+评分维度分解+资金流方向+因子命中率标签+Standard动态化）
│   ├── app.js                   #   ★ 前端控制器（section导航+异步直渲染+移动端组件+日期过滤+市场情绪指标+新闻情感+验证反馈）
│   ├── style.css                #   仪表板样式（桌面端+移动端≤720px重写）
│   ├── templates/
│   │   ├── css.js               #   报告内容样式
│   │   ├── us-market.js         #   ★ 海外市场模板（玻璃拟态白主题）
│   │   ├── cross-market.js      #   ★ 跨市场分析模板（Canvas半圆仪表盘+相关性矩阵+分层仓位表）
│   │   ├── weekend-analysis.js  #   ★ 周末深度分析模板（相似度卡片+危机仪表盘+板块轮动矩阵+因子效能）
│   │   ├── weekend-verification.js # ★ 周末验证反馈模板（5维调整表+验证报告显示）
│   │   └── ...                  #   (其他模板: simfolio, news-policy, holdings-analysis, etc.)
│   └── data/
│       ├── simfolio/            #   ★ 运行时：portfolio.json + scheduler_state.json + factor_performance.json + weekend_context.json
│       ├── us_market/           #   ★ 运行时：us_latest.json + correlation_history.json + us_close_*.json + margin_cache.json
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
- **周末深度分析**：周六/周日自动启动→每15分钟一轮→拉取5年历史K线→历史相似度匹配+危机预警+板块轮动+因子效能→生成 `weekend_context.json` 供周一交易决策使用

### 数据采集层

**A股行情** (`market_data.js`)：
- **主力**：Eastmoney push2 API（`push2.eastmoney.com`）— 含PE/PB/流通市值/换手率/涨跌幅，支持批量查询
- **双源基本面**（V1+V2合并）：push2 API（快速）+ datacenter API（更完整的ROE/负债率/营收增长/现金流）
- **备选**：腾讯 `qt.gtimg.cn`（无PE，每批60只）+ Sina `hq.sinajs.cn`（无PE，每批80只）
- 指数代码自动标准化：去除 `sh/sz/s_` 前缀

**两融数据** (`margin_data.js`)：
- Eastmoney push2 K线 API（secid=90.BK0707 沪股通聚合）作为杠杆资金情绪代理
- 30分钟缓存，计算两融情绪评分（0-100）+ 信号（连续流入/流出天数、资金活跃度趋势）
- 评分逻辑：近5日净流入方向（±10分）+ 累计净流入量（±8分）+ 成交量趋势变化（±5分）

**新闻情感** (`news_collector.js`)：
- 7级情感词典评分（强正+3/中正+2/弱正+1/中性0/弱负-1/中负-2/强负-3），含~70个金融关键词
- 输出：`{ score, hits, sentiment }` — sentiment 为 `strongly_positive | positive | negative | strongly_negative | neutral`
- 7种颜色编码：强正👍绿色/利好浅绿/偏正微绿/中性灰色/偏负微红/利空橙色/强负👎红色

### 因子绩效追踪（factor_performance.js）

在每次 Pipeline 扫描完成后自动计算：
- 读取 `scan_records_YYYY-MM-DD.json`（fallback `last_pipeline_result.json`）获取各因子的信号触发次数
- 读取 `summaries/YYYY-MM-DD.json` 获取次日市场收益作为 benchmark
- 计算：命中率（信号触发后市场涨的概率）、平均收益、5日/20日滚动命中率、趋势方向
- 输出到 `factor_performance.json`，API `GET /api/factors/performance`，SSE 广播到 Think-Tank
- 需 ≥2 天数据后才出命中率，≤1 天只显示信号计数
- **北向资金绩效追踪** (`getNBPerformance()`)：追踪北向情绪信号的历史命中率，≥5信号日后判定 HOT/STABLE/COLD

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

**8维预评分**（Pipeline Step 4，决定深析优先级）：
1. 估值(PE) 0-25分 / 2. 市净率(PB) 0-10分 / 3. 价格动量 -5~12分 / 4. 流动性(成交额) 0-20分
5. 换手率适中 0-8分 / 6. 振幅适中 0-5分 / 7. 资金流比率 ±10分 / 8. 流通市值偏好 0-5分

**5维综合评分**（加权，thin-data自适应降权）：
- fundamental(25%) + technical(15%) + hidden(20%) + capital_flow(25%) + event(15%)
- 无详细财务数据时：fundamental 降至 10%，其他均衡分配，总分上限 65

**复合调整**：
- 北向情绪调整：根据北向历史绩效动态缩放权重 — HOT(≥55%)=全额(±3/±5)，COLD(<40%且≥5日)=降至1/3(±1/±2)
- 两融情绪调整：bullish +2 / bearish -3
- LHB增强：强净买 +5，强净买+强资金流 +3 叠加，强净卖 -3

### Pipeline 执行流程（pipeline.js）

1. **Step 1**: 获取全A股列表（Eastmoney push2 批量）
2. **Step 2**: 过滤器（价格/成交额/PE/ST/创业板/科创板）
3. **Step 3a**: 计算隐藏因子（H1-H9）
4. **Step 3b**: 并行获取 LHB + 板块资金流 + 北向资金 + **两融数据** → SSE `enrichment` 广播（含 lhbDetail/marginSentiment/marginSignals）
5. **Step 4**: 8维预评分排序 → 取 top N（默认80只）进入深析
6. **Step 5**: 逐只深析（双源基本面 + K线 + 资金流历史 + LHB匹配）→ 5维综合评分
7. **Step 6**: 排序/评级/SSE `stock_analyzed` 广播（含 capitalFlow/lhb/dimensions）
8. 广播 `scan_complete` + `factor_perf`

### Simfolio — 交易日连续

- 初始 ¥100,000，T+1，持仓上限 5 只，单只 ≤30%
- `loadPortfolio()` 始终从 `portfolio.json` 读取，**不会自动重置**
- **分层仓位管理**（config.positionSizing）：
  - 强买入（top 5%+强信号）：85+→25%现金 / 75+→20% / 65+→15%
  - 普通买入（top 15%）：65+→12% / 55+→8%
  - 信号加成：超过2个信号每多1个 +2%
  - 风险乘数：恐慌×0.3 / 避险×0.5 / 中性×0.8 / 温和看涨×1.0 / 风险偏好×1.2
- 卖出：硬止损 -8% / 软止损 评分<50 / 移动止盈
- **T+1 严格限制**：当天买入的股票只有硬止损(-8%)可触发卖出，移动止盈/止盈/预警当天不生效
- `checkRiskThresholds` 中 `isBoughtToday` 检查 → 跳过非止损警报
- **市场方向门**：上证跌幅 >0.5% → 跳过所有买入，仅允许卖出
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
| **4** | 思考舱→防御门 | **6维**综合评分（因子健康+持仓压力+连续回撤+跨市场风险+信号评分背离+知识库历史）→score≥2→防御模式→跳过所有买入（仅允许卖出） | `simfolio.js` (`checkThinkTankGate()`) + `mosaic_server.js` (`generateTodaysVerdict()`) |

**关键设计原则**：
- **闭环 1+2 是"学习回路"**：系统从过去的预测错误中学习，自动调整参数——周末分析的验证结果反馈到下一周的预测，北向资金的命中率反馈到综合评分权重
- **闭环 3+4 是"防御回路"**：系统综合多个维度判断当前市场是否适合交易——知识库的历史经验、因子信号的健康度、持仓的压力状态、跨市场的宏观风险——形成"思维舱"的防御性判断
- 所有回路需要真实交易数据积累才能生效（验证反馈需1-2周，NB绩效需≥5信号日，知识库需≥2天）
- `checkThinkTankGate()` 在 `makeTradingDecisions()` 的 Step 3.5（市场方向门之后、宏观惩罚之前）执行

### 美股数据采集（us_market.js + scheduler._recordUSMarkets）

- 活跃窗口：**16:00-06:00 CST**（覆盖美股 pre-market 4:00 ET → post-market 20:00 ET）
- 周五 21:00+ 跳过（美股周六凌晨不开），周日 <16:00 跳过
- 美股状态实时计算：`formatUSSessionStatus()` 根据当前北京时间判断 session（pre_market/regular/post_market/closed）
- API `/api/us-market/current` 返回实时 status，不依赖缓存

### 跨市场相关性引擎（analysis/cross_market.js）

**风险状态机**：VXX(VIX) 40% + UUP(美元) 30% + TLT(美债) 30% → 加权评分(-65~+65) → 5 档风险区间：
- panic(恐慌)×0.3 / risk_off(避险)×0.5 / neutral(中性)×0.8 / slightly_bullish(温和看涨)×1.0 / risk_on(风险偏好)×1.2

**相关性矩阵**：Pearson R 计算 US ETF 涨跌 ↔ A股板块涨跌（8 对映射），+ 方向命中率 + 近5日趋势

**数据流**：每日 16:00 `_runDailySummary()` → `recordDailyCorrelationSnapshot()` → 读 `us_latest.json`（今凌晨美股收盘价）+ 实时查询 Sina A股板块代表股 → 写入 `correlation_history.json`（保留60个交易日）

⚠️ 需要 5 个交易日数据后相关性矩阵才有统计意义。16:00 快照若被服务器重启中断，当天数据会丢失（fire-and-forget）。

### 周末深度分析引擎（analysis/weekend_analyzer.js）

周六/周日全天自动运行，4 阶段分析循环，**所有输出为中文（无 emoji）**：

**Phase 1 — 数据聚合**：加载所有 summaries/events/knowledge_base/portfolio/correlation_history/factor_performance → 构建市场画像

**Phase 2 — 历史K线采集**：从 Eastmoney API 拉取上证/深证/创业板日K线（首次~5年），存到 `data/market_history/indices/`，后续增量更新

**Phase 3 — 深度分析**：
- **历史相似度**：Z-score 标准化 6 维特征向量（涨跌幅/量比/上涨天数占比/量趋势/ATR/新高新低比）→ 余弦相似度匹配 → top 5 最相似时期（5日滑动窗口），展示后续 5/10/20 日走势。相似度标签：极高(>80%)/高(60-80%)/中等(40-60%)/低(<40%)
- **危机预警**：6 维度加权评分（流动性25%/估值20%/市场宽度20%/北向15%/两融10%/波动率10%）→ 综合0-100分 → 5 档中文标签（高风险/风险偏高/风险适中/低风险/极低风险）+ 仓位建议
- **板块轮动**：8×8 领先/滞后/同步矩阵（中文板块名+中文关系值）
- **因子效能**：9 因子 H1-H9 全中文名+分类，命中率/信号次数/趋势

**Phase 4 — 增强上下文（含验证反馈）**：`_loadLastVerification()` 读取上周验证报告→5维调整本周 insight（危机门槛、相似度权重、板块偏好权重/方向、仓位建议）→生成 `data/simfolio/weekend_context.json`（insights数组+verificationContext，全中文，有效期覆盖到周一）

**循环机制**：首轮执行 Phase 1-4（含K线拉取），后续每 15 分钟执行 Phase 3-4，每 2 小时增量拉取 K 线。

### 周末分析验证引擎（analysis/weekend_verifier.js）

周五盘后自动运行（周五 15:30），验证上周周末分析的预测准确度：

1. **历史相似度** → 加权综合预测 vs 实际涨跌幅
2. **危机预警** → 危机分 vs 实际最大回撤
3. **板块轮动** → 领先/滞后矩阵 vs 实际板块收益
4. **因子效能** → HOT/COLD 预测 vs 实际命中率
5. **智能洞察** → 每类 insight 建议 vs 实际结果

验证报告写入 `data/weekend_archive/{date}_verification.json`，保留最多52周归档。

---

## 前端架构

### Section 导航（index.html / app.js）

**桌面端**：左侧 sidebar 苹果风玻璃按钮（毛玻璃 `backdrop-filter: blur` + 半透明白底 + 渐变小圆点替代 emoji + 金色激活态发光）
**移动端 (≤720px)**：顶部 sticky `#mobile-top-bar`，包含 date-strip + section-tabs（模拟交易/时政要点/交易分析与报告/海外市场/跨市场分析，周末增加"周末分析"），可左右滑动。持仓分析和 AI 知识库不在移动端 tabs 中显示。

| ID | 标签 | 渲染方式 | 时间限制 |
|----|------|---------|---------|
| `simfolio` | 模拟交易 | `renderSimfolioLive()` 实时 + 市场情绪指标 | 始终可用 |
| `newsPolicy` | 时政要点 | `renderNewsPolicySection()` → API + 新闻情感标签 | 16:00后 |
| `tradingReport` | 交易分析与报告 | `renderTradeAnalysisSection()` → API | 16:00后 |
| `holdingsAnalysis` | 持仓分析 | `renderSectionByTime()` | 16:00后 |
| `usMarket` | 海外市场 | `renderUSMarketDirect()` → API `/api/us-market/current` | 始终可用 |
| `crossMarket` | 跨市场分析 | `renderCrossMarketDirect()` → API `/api/cross-market/analysis` | 始终可用 |
| `weekendAnalysis` | 周末深度分析 | `renderWeekendAnalysisDirect()` → API `/api/weekend-analysis/report` | 仅周末显示 |
| `knowledgeBase` | AI 知识库 | `renderKnowledgeBaseSection()` → API | 始终可用 |

**主仪表板特色功能**：
- 自动交易 toast 通知：右上角滑入，毛玻璃背景 + 6s 自动消失 + 多条堆叠不覆盖 + 按日期隔离
- **市场情绪指标**：Simfolio 面板底部 3 个迷你指标（两融情绪/北向资金/Smart Money），颜色编码，自动刷新
- **新闻情感标签**：每条新闻标题旁 7 级情感标签（强正👍/利好/偏正/中性/偏负/利空/强负👎），颜色编码
- **仓位分层表格**：跨市场分析 Position Recommendation 下方 Tiered Allocation 表（强买/普通买分层+风险乘数）
- **验证反馈链路**：周末分析面板 → "验证反馈→下周参数调整"（5维调整表：危机门槛/相似度权重/板块偏好/仓位建议/板块权重，before→after箭头）

### 日历与历史日期（app.js）

- 左侧日历支持点击切换日期，周末不可点击（灰色）
- 点击历史日期后 `state.simfolioData` 置空，从 `/api/daily-summary/latest?date=` 加载历史快照（alpha/benchmark 显示 "--"）
- 所有 API 调用自动附加 `?date=` 参数当 `cal.activeDate !== today`
- Simfolio 后台刷新在历史模式下自动跳过
- **交易动态日期过滤**：`renderTradeActivityFeed()` 按 `cal.activeDate` 过滤
- **板块实时走势日期限制**：`renderSectorLiveChart()` 在历史日期显示"历史日期无实时板块数据"

### Think-Tank 页面（think-tank.html）

AI 思考舱，独立页面。两栏布局：

**左侧 — AI 思维流**：
- 实时思维显示（扫描线动画 + 思维内容 + 进度条）
- **指数分钟折线图**（Canvas 百分比模式：上证红/深证蓝/北证绿，30s 轮询）
- **今日扫描记录**：显示当日扫描历史（次数 + TOP5 股票名称）
- **因子绩效追踪**：3×3 卡片网格，每个因子一张卡片，含 Canvas 圆形仪表盘（命中率%）+ 微型折线图（信号趋势）+ 状态标签（HOT/STABLE/COLD）+ 命中率标签（🔥HOT/❄COLD）

**右侧 — 评分与信号面板**：
- H1-H9 因子柱状图（触发次数 + 命中率标签）
- 评分分布直方图（<50/50-60/60-70/70-80/80+）
- **因子组合模式面板**：显示 2+因子组合的历史命中率和置信度星标，数据来自 `/api/knowledge/factor-combos`
- **评分维度分解**：Canvas 水平条形图，展示 TOP1 股票的 5 维度得分（基本面/技术面/隐藏因子/资金流/事件驱动）
- 市场情报（LHB数/板块资金/北向情绪）
- TOP 5 最新推荐

**智能风险中枢**（4卡 2×2 grid，60s 轮询，数据来自 `/api/market/microstructure`）：
| 卡片 | 指标 | 数据源 |
|------|------|--------|
| **资金面热度** | 北向情绪 + 连续流入天数 + 5日方向柱状图 | `north_bound.js` |
| **波动率状态** | 上证 20 日年化波动率 + 5档标签 + 渐变色指针 | `summaries/` 指数收盘价 |
| **Smart Money** | 主力vs散户资金背离度 + LHB详情（净买X只·净卖X只） | `capital_flow.js` + `dragon_tiger.js` |
| **两融杠杆** | 两融情绪评分(0-100) + 情绪标签 + 近7日净变化柱状图 + 信号文字 | `margin_data.js` |

**仓位决策面板**：风险中枢下方 → 风险状态→仓位乘数 + 强买/普通买分层表 + 当前现金% + 信号加成规则

**Standard 弹窗**：动态从 `/api/config/public` 获取配置（筛选条件/权重/仓位分层/交易规则/扫描计划/数据源），不再硬编码

**SSE 实时事件流**：`scan_start` → `progress` → `stock_analyzed`（含 capitalFlow/lhb/dimensions）→ `stats` → `scan_complete` → `enrichment`（含 lhbDetail/marginSentiment/marginSignals）→ `factor_perf` + trade/position/state/alert/usmarket/weekend

**个股资金流展示**：SSE `stock_analyzed` 事件显示主力净流入/流出金额 + 占成交额比例 + 方向箭头（▲流入/▼流出）+ 连续流入天数

### 关键 API（详见 mosaic_server.js）

所有 `/api/news/latest`, `/api/analysis/latest`, `/api/daily-summary/latest` 支持 `?date=YYYY-MM-DD` 查询历史日期。

| 路由 | 用途 |
|------|------|
| `/api/status` | 服务器状态+交易日 |
| `/api/simfolio/status` | 模拟账户快照 |
| `/api/pipeline/run` | 手动触发全量扫描（POST） |
| `/api/scheduler/status` | 调度器状态 |
| `/api/news/latest` | 新闻+7级情感标签（支持 ?date=） |
| `/api/analysis/latest` | 交易归因分析（支持 ?date=） |
| `/api/daily-summary/latest` | 每日盘后总结（支持 ?date=） |
| `/api/knowledge/summary` | 知识库摘要 |
| `/api/knowledge/factor-combos` | ★ 因子组合模式+板块资金流模式 |
| `/api/config/public` | ★ 公开配置（筛选/权重/仓位/交易规则） |
| `/api/indices/today` | 指数分钟线数据（支持 ?date=） |
| `/api/think-tank/stream` | SSE 实时事件流 |
| `/api/think-tank/initial` | Think-Tank 初始数据（含因子绩效+margin+appConfig+verdict） |
| `/api/us-market/current` | ★ 美股实时快照（含实时状态） |
| `/api/us-market/status` | ★ 美股市场状态 |
| `/api/us-market/summary` | ★ 美股隔夜总结（支持 ?date=） |
| `/api/us-market/intraday` | 美股日内分钟线（支持 ?date=） |
| `/api/cross-market/analysis` | ★ 跨市场分析 |
| `/api/cross-market/risk-state` | 风险状态机单独查询 |
| `/api/cross-market/correlation` | 相关性矩阵单独查询 |
| `/api/factors/performance` | ★ 因子绩效追踪数据（含北向绩效） |
| `/api/market/microstructure` | ★ 智能风险中枢（北向+波动率+Smart Money） |
| `/api/margin/status` | ★ 两融数据+情绪评分 |
| `/api/sectors/live` | 板块实时行情（Sina 实时，仅当日） |
| `/api/weekend-analysis/status` | ★ 周末分析进度/状态 |
| `/api/weekend-analysis/report` | ★ 周末完整报告（相似度+危机+轮动+因子） |
| `/api/weekend-analysis/context` | ★ 周末增强上下文（simfolio 周一读取） |
| `/api/weekend-analysis/history` | 历史相似度匹配结果 |
| `/api/weekend-analysis/verification` | ★ 周末验证报告（支持 ?week=） |
| `/api/weekend-analysis/verification-history` | ★ 验证历史列表 |
| `/api/pipeline/last-result` | 最近一次扫描结果（持久化） |

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
- **绝不提交运行时数据**：`portfolio.json`, `scheduler_state.json`, `events/*.json`, `summaries/*.json`, `knowledge_base/*.json`, `index_history_*.json`, `us_latest.json`, `correlation_history.json`, `us_close_*.json`, `us_intraday_*.json`, `factor_performance.json`, `scan_records_*.json`, `last_pipeline_result.json`, `weekend_context.json`, `market_history/indices/*.json`, `weekend_archive/*.json`, `margin_cache.json`
- **config.js 是唯一配置入口**：改阈值/权重/时间表/分层仓位/周末分析/US_MARKET符号表只需改这一个文件
- **前端无 fetch polyfill**：旧浏览器可能不支持
- **`report-engine/data/` 是 DATA_DIR**：所有运行时数据在此目录下，不在 `mosaic/` 下

### Think-Tank 页面

- 指数显示使用 Canvas 折线图（上证红/深证蓝/北证绿），30s 轮询 `/api/indices/today`
- **折线图改用百分比模式**：以各自开盘价为 0% 基准，Y 轴显示涨跌幅百分比，带零线参考
- 扫描记录持久化到 localStorage，按上午/下午分 session（`YYYY-MM-DD-am` / `YYYY-MM-DD-pm`），最多50条
- **扫描记录服务器端持久化**：`_saveLastPipelineResult` 写入 `scan_records_YYYY-MM-DD.json`（包含 signalCounts，最多20条），`/api/think-tank/initial` 返回 `scanRecords`
- **前端双路径加载**：优先从 `scanRecords` API 加载，fallback 从 `todayEvents` 提取扫描事件
- **智能风险中枢 4 卡布局**（2×2 grid）：资金面热度/波动率状态/Smart Money/两融杠杆，60s 轮询，脉冲动画+数值过渡
- **仓位决策面板**：风险中枢下方独立面板，显示风险状态→仓位乘数+分层仓位表+现金%+信号加成规则
- **因子组合模式面板**：显示当前扫描中出现的 2+因子组合，对比知识库历史命中率，颜色编码（🔥HOT/❄COLD/⚠️中等），置信度星标
- **评分维度分解 Canvas**：5维水平条形图（每维不同颜色+权重标签+得分），数据随扫描更新
- **个股资金流方向**：SSE 实时展示主力净流入/流出金额+占成交额比例+连续流入天数+方向箭头
- **因子命中率标签**：H1-H9 柱状图右侧命中率标签（≥55% 🔥HOT / ≤35% ❄COLD）
- **Standard 弹窗动态化**：从 `/api/config/public` 获取配置，修改 config.js 后 UI 自动同步
- SSE 事件：`scan_complete`、`scheduler_status`、`think_usmarket`（美股实时更新）、`factor_perf`（因子绩效）、`weekend`（周末分析进度）
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
- **两融数据为代理指标**：使用 Eastmoney push2 沪股通聚合K线（secid=90.BK0707）作为杠杆资金情绪代理，非官方融资融券余额数据。30分钟缓存，API `/api/margin/status`
- **config API 字段映射**：`cfg.FILTER`（非 FILTERS），`cfg.FILTER.exclude300`（非 excludeGEM），`cfg.FILTER.exclude688 === false`（非 includeSTAR），`cfg.FACTOR_WEIGHTS`（非 COMPOSITE_WEIGHTS），`cfg.SIMFOLIO.maxSinglePositionPct`（非 maxPositionPct）
- **因子组合面板**：数据来自 `/api/knowledge/factor-combos`，调用 `knowledge_base.extractFactorCombos()`。需要知识库积累足够交易日数据后才显示有意义的命中率，目前数据量有限
