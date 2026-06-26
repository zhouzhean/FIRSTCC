# Migration Checklist · Francis Investment v3.4.9.9

新电脑迁移完成前逐项确认。

## Phase 0: Pre-Migration (旧电脑)

- [ ] `git status` — 无未提交更改
- [ ] `git log --oneline -5` — 最新 commit 是 P1.7 TDZ fix 或更新
- [ ] `node --check mosaic_server.js` — 语法 OK
- [ ] `node --check mosaic/simfolio.js` — 语法 OK
- [ ] `node --check mosaic/research/candidate_runner.js` — 语法 OK
- [ ] CLAUDE.md 内容最新 (含 H1/H2 REJECTED_RESEARCH + H3 pending)
- [ ] SUPERVISOR.md 内容最新 (含 P1.7 acceptance + H2 rejection documentation)
- [ ] 确认 `report-engine/data/research/snapshots/` 完整 (应 ~654 个 .jsonl 文件)
- [ ] 确认 `report-engine/data/research/model_artifacts/` 完整
  - [ ] `H1/window_001/` ~ `H1/window_004/`
  - [ ] `H2/window_001/`
  - [ ] `smoke_summary.json` (H1)
  - [ ] `smoke_summary_h2.json` (H2)
  - [ ] `true_walk_forward_summary.json`
- [ ] 确认 `report-engine/data/research/candidate_registry.json` 存在
  - [ ] H1 candidate REJECTED_RESEARCH with 4 windows
  - [ ] H2 candidate REJECTED_RESEARCH with smoke evidence
- [ ] 确认 `report-engine/data/research/oos_evaluation_results/` 完整
- [ ] 确认 `report-engine/data/research/trade_simulation/` 完整
- [ ] 确认 `report-engine/data/simfolio/` 完整
  - [ ] `simfolio_positions.json`
  - [ ] `simfolio_capital.json`
  - [ ] `simfolio_ledger.json`
  - [ ] `prediction_ledger.json`
  - [ ] `pipeline_results_for_kernel.json`
- [ ] 确认 `report-engine/data/evolution/` 完整
  - [ ] `model_registry.json`
  - [ ] `rejected_models.json`
  - [ ] `demotion_log.json`
- [ ] 确认 `report-engine/data/deploy_manifest.json` 存在
- [ ] 确认 `.gitignore` 不会排除上述关键数据
- [ ] 复制/打包 `Francis Investment/` 目录到迁移介质

## Phase 1: Setup (新电脑)

- [ ] Node.js >= 16 已安装 (`node --version`)
- [ ] Git 已安装 (`git --version`)
- [ ] GitHub CLI 已安装并登录 (`gh auth status`)
- [ ] Clone 成功: `git clone https://github.com/zhouzhean/FIRSTCC.git`
- [ ] `git log --oneline -5` 与旧电脑一致
- [ ] 迁移数据目录已复制到 `report-engine/data/`
- [ ] 确认 `report-engine/data/research/snapshots/` 文件数 = 旧电脑文件数 (654)
- [ ] 确认 `candidate_registry.json` H1+H2 拒绝记录存在
- [ ] 确认 `deploy_manifest.json` 存在
- [ ] SSH key 已配置: `ssh root@8.153.101.112 "echo ok"` 成功
- [ ] `.env` 配置（如需要，从 `.env.example` 复制）

## Phase 2: Local Verification

- [ ] `node --check mosaic_server.js` — 语法全部通过
- [ ] `node mosaic_server.js` 本地启动成功 (端口 8765)
- [ ] 浏览器打开 `http://localhost:8765` — Cockpit 渲染正常

### API 验证

- [ ] `curl http://localhost:8765/api/status`
  - [ ] `version` = `v3.4.9.9` (或更新)
  - [ ] `buildCommit` 非空
  - [ ] `deployManifestValid` = true (或 git commit 匹配)
  - [ ] `uptime` > 0
- [ ] `curl http://localhost:8765/api/cockpit`
  - [ ] `researchLab` 存在
  - [ ] `researchLab.h1Rejection` 存在 (aggregateRankIC = -0.0443)
  - [ ] `researchLab.h2Rejection` 存在 (rankIC = 0.019, pValue = 0.3548)
  - [ ] `researchLab.h1Smoke` 存在
  - [ ] `researchLab.h2Smoke` 存在
  - [ ] `researchLab.canonicalCohort` 存在
  - [ ] `researchLab.modelVerdict` = `REJECTED_RESEARCH`
- [ ] `curl http://localhost:8765/api/prediction-settlement`
  - [ ] `predictionSource` = `"rankByExpectedReturn"`
  - [ ] `predictionValid` > 0
  - [ ] `expectedReturnInjected` > 0 (如果今日已运行 P1.7)
- [ ] `curl http://localhost:8765/api/cohort-integrity`
  - [ ] `researchEligible` 有值
  - [ ] `canonicalCohortCount` 有值 (如果今日已运行)
- [ ] `curl http://localhost:8765/api/think-tank/decision-status`
  - [ ] `kernelStatus` 存在 (BLOCKED_RESEARCH/ACTIVE)
  - [ ] `todayDecisions` 有数据或空数组
  - [ ] `blockers` 列出当前阻塞

### UI 验收

- [ ] Cockpit → Research Lab
  - [ ] H1 REJECTED_RESEARCH banner 显示（红色）
  - [ ] H2 Smoke Evidence 显示（红色，Rank IC=0.019, p=0.3548）
  - [ ] Research Gate Summary 显示（H1/H2/H3 状态）
  - [ ] Canonical Cohort 状态显示
- [ ] Cockpit → Think Tank
  - [ ] 决策历史可滚动
  - [ ] Kernel blocker 可见
- [ ] Cockpit → Simfolio
  - [ ] 持仓/资本显示正常

## Phase 3: Cloud Deployment

- [ ] 检查哪些文件需要部署 (diff 旧电脑 vs 云端)
- [ ] `scp` 关键文件到 `root@8.153.101.112:/root/FIRSTCC/Francis Investment/`
- [ ] `ssh root@8.153.101.112 "systemctl restart mosaic"`
- [ ] `sleep 3 && curl -s http://8.153.101.112:8765/api/status`
  - [ ] version、buildCommit、uptime 正常
  - [ ] deployManifestValid = true
- [ ] `curl -s http://8.153.101.112:8765/api/cockpit` — 数据与本地一致
- [ ] 浏览器打开 `http://8.153.101.112:8765` — Cockpit 正常渲染

## Phase 4: Cleanup (旧电脑 — 可选)

- [ ] 确认云端运行正常 ≥ 1 小时后，旧电脑可停用
- [ ] 旧电脑 `git push` 所有最终更改
- [ ] 记录新电脑 git user.email: `git config user.email "your-email"`
- [ ] 新电脑 `git config user.name "anzhezhou"`
