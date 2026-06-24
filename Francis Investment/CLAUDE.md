# Francis Investment · A股量化交易系统 v3.4.9.8

Node.js 零外部依赖，阿里云 ECS `8.153.101.112:8765`。全天候自动交易+24/7自主学习+报告引擎。低价(≤20元)非创业板A股子策略。

## v3.4.9.8: P1.2 Unified Execution + P1.3 H1 Smoke Test

### P1.2 — Unified executionConfig & Idempotent Evaluation (2026-06-24)

- **Unified executionConfig**: `compareRankingsAgainstRandom` accepts `executionConfig {costAssumptions, topN, holdDays, maxPositionsPerSleeve, numSleeves}` — candidate and EVERY random portfolio use IDENTICAL params
- **Empirical quantile CI**: Sorted `modelMinusRandom` deltas → 2.5%/97.5% quantiles (replaces `mean ± 1.96*SD`)
- **Lock window fix**: Windows 4-5 use same vsRandom empirical delta CI as research windows. Deleted old `vsBenchmark ± 1.0` hack. Lock record writes `windowPlanHash` + `executionHash`
- **Resumable & idempotent**: Startup unions registry `evaluatedWindows` + progress file. `recordEvaluation` idempotent on `(versionId, windowIndex, snapshotHash, executionHash)`
- **Test isolation**: `createRegistry({dataDir})` returns independent instance. `candidate_runner` accepts `options.registry` for injection
- **Deploy**: Commit `96b3b3f`, 120 tests pass, cloud `buildCommit === deployCommit`

### P1.3 — H1 Smoke Test (2026-06-24)

- **Window range support**: `evolution_scheduler` passes `{hypotheses, windowsStart, windowsEnd}` to `runAllHypotheses` from `config.js CANDIDATE_RUNNER`. Out-of-range → fail closed; never auto-enter lock windows
- **smokeOnly mode**: `runAllHypotheses({smokeOnly:true})` → H1 window 0 only. Runs real snapshots/kline/costs/random control. Writes `smoke_summary.json`. Does NOT touch registry, progress, RESEARCH_ONLY/SHADOW_CANDIDATE, lock windows, or Simfolio
- **Real-trade cost test**: New fixture with nonzero trades (modelNetReturn 4.78% vs 0.00%). Asserts low/high cost change BOTH candidate AND random netReturn
- **Research Lab UI**: `h1Smoke` field in `/api/cockpit` → `not_run | completed | failed`. Completed shows run time, window, trade count, data hash
- **H1 Smoke result (2026-06-24)**: 361K train samples, 852 trades, Rank IC=-0.0378, vsRandom pairedDelta=-4.81% [CI: -8.60, -1.66], benchmark unavailable. **Nonzero samples + nonzero trades + random control CI available** — smoke passed
- **Deploy**: Commit `ce58c2d`, 34 integration tests pass, cloud verified

### P0 Research Integrity (carry-over)

- **P0-1 — Unified Label Convention**: T close signal → T+1 open entry → hold 3 trading days → T+4 close exit
- **P0-2 — Repaired Trade Simulator**: 3 equal-weight sleeves, overlapping daily cohorts, T+1 entry→T+4 exit, exit tradability roll-forward
- **P0-3 — Deterministic Random-Portfolio Monte Carlo**: Fixed-seed XorShift (42), Laplace-smoothed p-value, empirical paired delta CI

### P0.2 Research Output Interpretability

- **T1** ✅ Benchmark strict availability
- **T1-fix** ✅ Residual null semantics (17/17 regression tests)
- **T2** ✅ Coverage dual constraint (649=636+13, 636=636+0)
- **T3** ✅ Cohort API consistency
- **T4** ✅ Release identity
- **T5** ⏳ 09:30 runtime verification — 2026-06-25 scheduler canonical full scan

### Known Issues

- **Cloud OOM on full walk-forward**: 2GB ECS can't hold all train+test+MC samples. smokeOnly with 30 MC samples works. Full runs need `--max-old-space-size=1536` or sequential window execution
- **Benchmark unavailable**: `benchmarkTradeCount=0` — same-path benchmark sleeve not in historical snapshots yet
- **Ridge-v1 REJECTED**: 6 windows, avg Rank IC negative, paired delta CI negative

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
│   ├── H1/window_001/{model,standardizer,feature_schema,dates,data_hash}.json
│   ├── smoke_summary.json       # P1.3: H1 single-window smoke output
│   └── candidate_runner_progress.json
├── snapshots/  (654 JSONL files)
├── oos_evaluation_results/
└── candidate_registry.json
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
| v3.4.9.8 | 2026-06-24 | **P1.2**: unified executionConfig, empirical quantile CI, lock window fix, idempotent eval, test isolation. **P1.3**: smokeOnly mode, window range, H1 smoke test (852 trades), Research Lab h1Smoke UI |
| v3.4.9.7 | 2026-06-23 | **P0.2**: deploy identity, fixed capacity, same-path benchmark, exit tradability, Monte Carlo, Laplace p-value, paired delta CI |
| v3.4.9.6 | 2026-06-23 | Phase 1.1: honest data boundaries, real feature availability, trade simulation |
| v3.4.9.5 | 2026-06-23 | PIT Historical Research Lab: 5 modules, 835 days x 953K records |
| v3.4.5 | 2026-06-18 | Data bus unification, per-index freshness |
| v3.4.0 | 2026-06-17 | Unified Decision Kernel (5→6 blockers), Decision Audit, Cockpit WNB |
| v3.3.x | 2026-06 | Walk-Forward, IC decomposition, Shadow evaluation, Model Registry |
