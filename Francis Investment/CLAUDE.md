# Francis Investment · A股量化交易系统 v3.4.9.9

Node.js 零外部依赖，阿里云 ECS `8.153.101.112:8765`。全天候自动交易+24/7自主学习+报告引擎。低价(≤20元)非创业板A股子策略。

## 当前状态：冻结等待下一交易日 09:30 canonical cohort

**H1** — REJECTED_RESEARCH ✅（已冻结）
**H2** — REJECTED_RESEARCH ✅（已冻结）
**H3** — 等待 canonical acceptance，不启动、不改代码、不改交易参数

### 周末迁移准备 (2026-06-27)

- **P0 迁移包** ✅: `TRANSFER_RUNBOOK.md` + `MIGRATION_CHECKLIST.md` + `scripts/fi_health_check.ps1`
- **P1 可观测性** ✅: Research Gate Summary (H1/H2/H3 统一状态) → Cockpit Research Lab; rejectedModels 统一显示
- **P2 H3 准备** ✅: `smoke_summary_h3.json` fixture + Cockpit H3 占位 UI + 字段验证 (features/interaction 路径已验证)

### P1.7 expectedReturn Wiring — ✅ INTRADAY ACCEPTED，Canonical 待验收 (2026-06-26)

- **Root cause (original)**: `simfolio.js` `makeTradingDecisions()` 在 `rankByExpectedReturn()` 之前构建 research snapshot 并写 prediction ledger，导致 `pipelineResults` 无 `.prediction` → 所有 ledger 条目 `expectedReturn=null`。
- **Root cause (TDZ bug)**: P1.7 block 在 line 936 引用了 `weekendContext`，但 `const weekendContext = loadWeekendContext()` 在 line 1602 声明——660 行之后。JavaScript TDZ 导致 `ReferenceError`，被 try/catch 静默吞掉，`rankByExpectedReturn` 从未执行。
- **Fix**: P1.7 block 内联调用 `loadWeekendContext()`，不再引用后面的 `const` 声明。增加 diagnostic error file (`p17_diag.json`)。
- **11:25 CST Mid-Scan Acceptance** ✅: 50/50 entries with expectedReturn as number, expectedReturnInjected=100, predictionSource="rankByExpectedReturn", predictionValid=100, researchEligible=100。
- **Canonical acceptance pending**: 下一交易日 09:30 必须产生 `predictionValid>0`、`researchEligible>0`、`expectedReturnInjected>0`、`predictionSource="rankByExpectedReturn"`。

### H1 — REJECTED_RESEARCH ✅ (2026-06-25)

4-window formal study: aggregate Rank IC=-0.0443, all windows negative. H1 Momentum+Volatility 无 alpha。已冻结，不再调参。Artifacts: `model_artifacts/H1/window_001-004/`。

### H2 — REJECTED_RESEARCH ✅ (2026-06-26)

- **Hypothesis**: "Derived Hidden-Signal Bundle" — pure hidden signal composite as sole feature. `features: ['hidden']`, `interaction: null`.
- **Smoke result** (Window 0, 30 MC, 361K train samples):

| Metric | Value | Gate |
|--------|-------|------|
| Rank IC | 0.019 | ≈zero |
| Direction Accuracy | 46.13% | <50% ❌ |
| Model Net Return | -8.42% | Negative ❌ |
| vsRandom Δ CI | [-2.78, +4.16] | Crosses zero ❌ |
| p-value | 0.3548 | Not significant ❌ |
| Decile Calibration | Non-monotonic | ❌ |
| Trades | 991/1003 | Healthy |

- **Verdict**: REJECTED_RESEARCH — hidden signals alone don't carry alpha. Hypothesis rationale confirmed: hidden signals are transformed price data, not independent alpha source.
- **H2 frozen**: No further tuning. No parameter changes. No promotion.
- **Artifacts**: `model_artifacts/H2/window_001/`. Registry: `smoke_H2_mqup1zzn`.
- **Infrastructure**: smokeOnly mode generalized for hypothesis-agnostic use. Cockpit Research Lab shows H1+H2 smoke evidence.

### H3 — 等待 canonical acceptance (下一交易日 09:30)

- **Hypothesis**: Signal-Volume Interaction — `features: ['signalCount', 'compositeScore']`, `interaction: 'signalCount * compositeScore'`。测试信号共振效应：多个信号同时指向同一方向时，compositeScore 的预测力是否被放大。
- **Rationale**: 这是有经济含义的假设（信号 confluence），而非继续挖掘 hidden signals 的数据变换。
- **Gate**: 下一交易日 09:30 canonical cohort 必须通过四项验收：
  1. `predictionValid > 0`
  2. `researchEligible > 0`
  3. `expectedReturnInjected > 0`
  4. `predictionSource === "rankByExpectedReturn"`
- **约束**: 仅单窗口 smoke，不改交易参数，不进 live model/shadow，不开 promotion。
- **输出**: Rank IC, Direction Accuracy, Net Return, vsRandom Δ CI, p-value, Decile Calibration → Cockpit Research Lab。

### P1.7 — expectedReturn Wiring Fix ✅ INTRADAY ACCEPTED (2026-06-26)

- **TDZ bug**: `weekendContext` 在 line 936 被引用，但 `const` 声明在 line 1602 → `ReferenceError` 被静默吞掉，`rankByExpectedReturn` 从未执行。
- **Fix**: P1.7 block 内联 `loadWeekendContext()` 调用。
- **11:25 mid_scan acceptance** ✅: 50/50 entries expectedReturn=number, expectedReturnInjected=100, predictionSource="rankByExpectedReturn", predictionValid=100, researchEligible=100。
- **Canonical pending**: 仅 09:30 full scan 产生 canonical cohort。下一交易日验收。

### P1.6 — Canonical Cohort Fix ✅ (2026-06-25)

- `scheduledSlot="9:30"` → `"09:30"` (`.padStart(2,'0')`) — 修复后 2026-06-26 09:30 canonical cohort 成功运行：`completed=true`, `runId=mqtmjuwc_full_1`, `canonicalCohortCount=23`。

### P1.2–P1.5 — Research Infrastructure (2026-06-24/25)

- **P1.2**: Unified executionConfig、empirical quantile CI、lock window fix、idempotent evaluation
- **P1.3**: H1 smoke test、window range support、smokeOnly mode
- **P1.4**: evolution_scheduler catch-up gate、window plan integrity、H1 Smoke UI
- **P1.5**: H1 windowResults bug fix (W2 data corrected)、cloud observability (`/api/health` + heartbeat + currentTask)、release identity unified、Cockpit H1 rejection banner + canonical cohort

### P0 Research Integrity (baseline)

- **P0-1**: Unified Label — T close signal → T+1 open entry → hold 3 trading days → T+4 close exit
- **P0-2**: Trade Simulator — 3 equal-weight sleeves, overlapping daily cohorts, exit tradability roll-forward
- **P0-3**: Random-Portfolio Monte Carlo — Fixed-seed XorShift (42), Laplace-smoothed p-value, empirical paired delta CI

### Known Issues

- **Cloud OOM on full walk-forward**: 2GB ECS can't hold train+test+1000 MC. smokeOnly 30 MC works. Full runs → local execution or `--max-old-space-size=1536`.
- **Benchmark unavailable**: `benchmarkTradeCount=0` — same-path benchmark sleeve not in historical snapshots. Cannot claim post-cost market excess.
- **H1 REJECTED_RESEARCH** ✅: 4-window formal study, all negative. Frozen.
- **H2 REJECTED_RESEARCH** ✅: Smoke single-window, Rank IC≈zero, Δ CI crosses zero, p=0.35. Frozen.
- **H3 pending**: Gate = next 09:30 canonical acceptance. Hypothesis = signalCount × compositeScore interaction. Smoke only.
- **P1.7**: ✅ Intraday accepted (11:25 mid_scan). Canonical acceptance pending next 09:30.

## Research Architecture

### Modules

| Module | Purpose |
|--------|---------|
| `mosaic/research/candidate_runner.js` | P1 walk-forward: per-hypothesis Ridge + trade sim + vsRandom MC + idempotent evaluation |
| `mosaic/research/candidate_registry.js` | Isolated registry: registration, evaluation recording, promotion/rejection, lock windows |
| `mosaic/research/baseline_models.js` | Random-Portfolio Monte Carlo + empirical quantile CI + unified executionConfig |
| `mosaic/research/linear_model.js` | Ridge regression with deriveFeatures + applyInteraction (H1/H2/H3) |
| `mosaic/research/trade_simulator.js` | 3-sleeve equal-weight portfolio with exit tradability roll-forward |
| `mosaic/research/true_walk_forward.js` | Strict train→validate→test pipeline, per-window model artifacts |
| `mosaic/research/rolling_oos_evaluation.js` | Rolling OOS per window with portfolio-level comparison |
| `mosaic/research/historical_snapshot.js` | Daily point-in-time snapshots (654 dates, ~1578 stocks) |
| `mosaic/research/universe_definition.js` | Honest universe: current-file, stable start 2023-10-27 |
| `mosaic/research/cohort_stats.js` | Shared API stats: PS/CI/canonical from ledger + manifest |
| `mosaic/evolution/evolution_scheduler.js` | Nightly/weekend task dispatch + candidate_evaluation scheduling |

### Output Structure

```
report-engine/data/research/
├── model_artifacts/
│   ├── H1/window_001-004/     # H1 REJECTED_RESEARCH artifacts
│   ├── H2/window_001/         # H2 REJECTED_RESEARCH artifacts
│   ├── smoke_summary.json     # H1 single-window smoke output
│   ├── smoke_summary_h2.json  # H2 single-window smoke output
│   ├── smoke_summary_h3.json  # H3 smoke fixture (pending canonical)
│   └── candidate_runner_progress.json
├── snapshots/  (654 JSONL files)
├── oos_evaluation_results/
├── trade_simulation/
└── candidate_registry.json   # H1+H2 rejections recorded + H3 hypothesis locked

scripts/
└── fi_health_check.ps1        # 一键健康检查 (5 API curl)
```

## Core Production Architecture

```
mosaic_server.js (HTTP)
├── mosaic/decision_kernel.js   # 6 Hard Blockers
├── mosaic/scheduler.js          # State machine (3 full + 7 mid scans daily)
├── mosaic/pipeline.js           # Main pipeline: scan → score → execute
├── mosaic/simfolio.js           # Simfolio: kernel-governed trade engine
├── mosaic/config.js             # Single config source
│
├── mosaic/collectors/           # market_data, index_recorder, capital_flow, etc.
├── mosaic/factors/              # hidden_signals.js (H1-H9), composite.js
├── mosaic/analysis/             # data_quality, strategy_health, verification_runner
├── mosaic/predict/              # expected_return.js, dynamic_weights.js
├── mosaic/evolution/            # model_registry, bootstrap_history, evolution_scheduler
│
└── report-engine/               # cockpit.html/js, think-tank.html
```

### Decision Kernel — 6 Hard Blockers

| # | Gate | Blocks when |
|---|------|------------|
| 0 | marketSession | non-trading hours |
| 1 | marketData | validCoreCount < 2 |
| 2 | circuitBreaker | panic/risk_off regime |
| 3 | leakageAudit | CRITICAL/DATA_LEAKAGE |
| 4 | strategyHealth | masterControl=BLOCK |
| 5 | dataQuality | penalty >= 7 |

### Simfolio Rules

Initial 100000 CNY, max 5 positions, single <=30%, T+1. Stop-loss: hard -8%, soft score<35, trailing. Cooldown: 4 trading days.

## Cloud Deployment

```bash
scp "<local>" "root@8.153.101.112:/root/FIRSTCC/Francis Investment/<path>"
ssh root@8.153.101.112 "systemctl restart mosaic"
curl -s http://8.153.101.112:8765/api/status
curl -s http://8.153.101.112:8765/api/cockpit
```

| Item | Detail |
|------|--------|
| IP | `8.153.101.112:8765` |
| OS | Ubuntu 22.04, 2 vCPU/2 GiB |
| Process | systemd `mosaic.service` (Restart=always) |
| K-line source | Tencent ifzq (Eastmoney blocked on ECS) |

## Key Constraints

- **Cloud always first**: deploy immediately after changes
- **`config.js` is single config source**; `report-engine/data/` is DATA_DIR
- **CANDIDATE_RUNNER.enabled=false**: never enable until manual verification
- **`node --check`** before deploy
- **Eastmoney blocked on ECS** → K-line uses Tencent ifzq

### v3.4.x Pitfall Reference

| Trap | Key |
|------|-----|
| kernel context consistency | All 3 consumers must share portfolio+indices+pipelineResults+marketState |
| simfolio P0-1 | Check `kernelDecision.finalVerdict` BLOCK/REDUCE → sell-only |
| marketClosed vs noMarketData | kernel accepts `marketState` field to distinguish |
| freshnessStatus | live/recorder/cached/stale_daily |
| smokeOnly writes | `smoke_summary.json` is safe to delete; no registry or progress side effects |

## Version History

| Version | Date | Key Changes |
|---------|------|-------------|
| v3.4.9.9 | 2026-06-26/27 | **P1.7 intraday accepted** (TDZ fix). **H2 Smoke REJECTED_RESEARCH** (IC=0.019, p=0.35). **Weekend migration**: TRANSFER_RUNBOOK.md + MIGRATION_CHECKLIST.md + fi_health_check.ps1. Research Gate Summary (H1/H2/H3 unified) → Cockpit. H3 smoke fixture + Cockpit placeholder (pending canonical). |
| v3.4.9.8 | 2026-06-25/26 | P1.2–P1.6: unified executionConfig, empirical CI, smokeOnly, H1 4-window formal → REJECTED, windowResults bug fix, cloud observability, canonical cohort fix (`9:30`→`09:30`), Cockpit canonical cohort + H1 rejection banner |
| v3.4.9.7 | 2026-06-23 | P0.2: deploy identity, fixed capacity, same-path benchmark, exit tradability, MC, Laplace p-value, paired delta CI |
| v3.4.9.6 | 2026-06-23 | Phase 1.1: honest data boundaries, real feature availability, trade simulation |
| v3.4.9.5 | 2026-06-23 | PIT Historical Research Lab: 5 modules |
| v3.4.5 | 2026-06-18 | Data bus unification, per-index freshness |
| v3.4.0 | 2026-06-17 | Unified Decision Kernel (5→6 blockers), Decision Audit, Cockpit WNB |
| v3.3.x | 2026-06 | Walk-Forward, IC decomposition, Shadow evaluation, Model Registry |
