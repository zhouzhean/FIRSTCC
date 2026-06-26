# Francis Investment · A股量化交易系统 v3.4.9.8

Node.js 零外部依赖，阿里云 ECS `8.153.101.112:8765`。全天候自动交易+24/7自主学习+报告引擎。低价(≤20元)非创业板A股子策略。

## v3.4.9.8: P1.2–P1.7 (2026-06-24~26)

### P1.7 — expectedReturn Wiring Fix (2026-06-26)

- **Root cause (original)**: `simfolio.js` `makeTradingDecisions()` built research snapshot and wrote prediction ledger BEFORE `rankByExpectedReturn()`. `pipelineResults` had no `.prediction` → all ledger entries got `expectedReturn=null`.
- **Root cause (TDZ bug — found 10:35 CST)**: P1.7 block referenced `weekendContext` at line 936, but `const weekendContext = loadWeekendContext()` was declared at line 1602 — 660 lines later. JavaScript TDZ (Temporal Dead Zone) caused `ReferenceError: Cannot access 'weekendContext' before initialization`. The try/catch silently swallowed this error on every scan, making `rankByExpectedReturn` NEVER execute.
- **Fix (final)**: Load `weekendContext` inline via `loadWeekendContext()` inside P1.7 block instead of referencing the later `const` declaration. Added diagnostic error file write (`p17_diag.json`) for future debugging.
- **Cloud test verified**: Direct `makeTradingDecisions` call with mock mid_scan data → `expectedReturn=-0.09`, `confidence=0.5` written to ledger. No diag file created.
- **Diagnostic fields**: `cohort_stats.js` now counts `missingExpectedReturn`, `expectedReturnInjected`, and sets `predictionSource` (`"rankByExpectedReturn"` | `"none"`). Exposed in `/api/prediction-settlement` and `/api/cohort-integrity`.
- **Release identity**: Cloud `buildCommit` = `bd37b58a` (TDZ fix), `deployManifestValid=true`, 12 files.
- **Intraday fixes deployed**:
  1. `scheduler.js`: mid_scan `scheduledSlot` was hard-coded `null` → now passes actual `HH:MM`.
  2. `simfolio.js`: P1.7 block's `_appendPredictionLedger` context now explicitly passes `buildCommit`.
  3. `simfolio.js`: **TDZ fix** — `weekendContext` loaded inline via `loadWeekendContext()`.
- **Acceptance pending**: Next intraday mid_scan (11:25 CST) must produce `expectedReturnInjected>0`, `predictionSource="rankByExpectedReturn"`. Then next trading day 09:30 canonical run must produce `predictionValid>0`, `researchEligible>0`. **H2 gated until both.**
- **Commits**: `840800f` → `e5a9699` → `ed912cb` → `1039c4a` → `7284863` → `bd37b58` (TDZ fix) → `e55597b` (manifest).

### P1.6 — Canonical Cohort Root-Cause Fix (2026-06-25)

- **Root cause**: `scheduler.js` `_checkScheduledOps()` used `time.hour` (number `9`) without `.padStart(2,'0')`, producing `scheduledSlot="9:30"` instead of `"09:30"`. Three independent checks failed: `_isDesignatedCanonicalWindow()` (`"9:30" !== "09:30"`), `_generateCanonicalAcceptance()` (SKIP), `prediction_ledger.buildLedgerEntry()` (`canonical: false`). The 09:30 full pipeline ran and wrote 309 ledger entries — all with `canonical=false` and zero `canonicalCohortCount`.
- **Fix**: Padded `time.hour` with `.padStart(2,'0')` in `_checkScheduledOps()`; added defensive normalization in `_runFullPipeline()` so any downstream `scheduledSlot` is always `HH:MM`.
- **Cockpit diagnostics enriched**: When manifest missing, `canonicalCohort` now includes `schedulerRun0930`, `scheduledSlotDistribution`, `canonicalEntryCount`, `predictionValidCount`, and auto-generated `diagnosis[]` (e.g. "scheduledSlot='9:30' (missing leading zero) — canonical gate requires '09:30'").
- **Manifest regenerated**: `deploy_manifest.json` → commit `9c3be3c`, 11 file hashes verified.
- **Cloud deployed**: `deployCommit=00ff2cc`, all endpoints healthy, heartbeat alive. Fix validates next trading day's 09:30 run.
- **Commits**: `9c3be3c` (code fix + diagnostics) + `00ff2cc` (manifest update).
- **Constraint**: H2 NOT started per supervisor directive — wait for next 09:30 canonical success.

### P1.5 — Release Consolidation (2026-06-25)

- **H1 windowResults bug fix**: W2 data was duplicated from W3 in rejection summary. Added `buildWindowResultsFromEvaluations()` in `candidate_registry.js` to programmatically generate `windowResults` from authoritative `evaluationResults`. `rejectCandidate()` auto-generates when caller doesn't provide `windowResults`. Fixed `candidate_registry.json` data (W2: rankIC=-0.0608, netReturn=-12.5, deltaCI=[-13.25, -5.83]). Corrected `aggregateRankIC` from -0.037425 to -0.044325. 4 new tests.
- **Cloud observability**: Added `/api/health` endpoint (responds <10ms, no file I/O). Added 1-second heartbeat `setInterval` to detect event loop blockage. Added `currentTask` tracking via `evolution_scheduler.setTaskObserver()`. `/api/status` now includes `currentTask`, `lastHeartbeat`, `eventLoopBlocked`.
- **Release identity unified**: `config.js` version → v3.4.9.8. `deploy_manifest.json` commit → 9ce7732, version → v3.4.9.8, file hashes regenerated. Cloud `identityStatus=manifest_verified_no_git`.
- **Cockpit updates**: H1 REJECTED_RESEARCH banner with W1-W4 metrics. Canonical Cohort status section (date, runId, records, research/exec eligible, block reason).
- **Tests**: 143 total passing (35 reg + 46 int + 18 canonical + 11 cohort + 17 benchmark + 16 model reg).

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

### P1.4 — Candidate Runner Lifecycle & H1 Formal Research (2026-06-25)

**P1.4-A: evolution_scheduler catch-up gate**
- Catch-up `candidate_evaluation` case now checks `CANDIDATE_RUNNER.enabled` before dispatching — matches normal path
- Default fail-closed: `{enabled: false}` on config load failure (was `{enabled: true}`)
- Test 13 verifies safe default

**P1.4-B: Window plan integrity**
- `setEvaluationWindows()` always writes full 6-window `allWindows` to registry, not sliced subset
- `windowsStart`/`windowsEnd` only control which windows execute this run
- Idempotency guard: skips overwrite when `existingWinCount > 0` (resume safety)
- Lock windows 4-5 preserved after research run 0-3. Tests 10-11 verify

**P1.4-C: H1 Smoke Evidence UI**
- New H1 Smoke Evidence section in cockpit `renderResearchLab()` — renders between Model Artifacts and Legacy note
- Evidence verdict logic: Rank IC > 0 AND delta CI upper >= 0 → green pass; otherwise red "Evidence Negative / 未通过"
- Expanded `/api/cockpit` h1Smoke payload: samples, benchmarkStatus, rankIC, netReturn, deltaCiLower/Upper, directionAccuracy
- Test 12 verifies smoke isolation (only `smoke_summary.json` changes)

**H1 4-window formal research result (2026-06-25)**
| Window | Rank IC | Net Return | Δ CI (model − random) |
|--------|---------|------------|----------------------|
| W1 | -0.0378 | -14.24% | [-8.60, -2.27] |
| W2 | -0.0608 | -12.50% | [-13.25, -5.83] |
| W3 | -0.0332 | -8.47% | [-14.91, -8.03] |
| W4 | -0.0455 | -4.43% | [-4.48, 2.06] |

**Verdict: REJECTED_RESEARCH** — aggregate Rank IC=-0.0374, all 4 windows negative.
Artifacts preserved in `model_artifacts/H1/window_001-004/`. H1 frozen — no further tuning.
Next: H2 → H3 per pre-registered rules.

**Tests**: 46 integration + 26 registry = 72 total, all passing.
**Deploy**: Commits `6b387f7` + `9ce7732`.

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

- **Cloud OOM on full walk-forward**: 2GB ECS can't hold all train+test+MC samples (85274 test × 1000 MC). smokeOnly with 30 MC works. Full runs need local execution or `--max-old-space-size=1536` (still borderline on 2GB)
- **Benchmark unavailable**: `benchmarkTradeCount=0` — same-path benchmark sleeve not in historical snapshots yet. Cannot claim post-cost market excess without it
- **H1 REJECTED_RESEARCH**: 4-window formal study complete, all windows negative Rank IC, negative delta CI. Frozen — no more H1 tuning
- **H2, H3 not yet run**: Pre-registered sequence — H2 follows H1 rejection. P1.6 supervisor directive: wait for next trading day 09:30 canonical cohort to generate naturally before entering H2
- **Prediction engine wiring**: P1.7 fixed — `rankByExpectedReturn()` now runs before research snapshot+ledger write. Diagnostic fields (`expectedReturnInjected`, `predictionSource`) visible in API. Awaiting next 09:30 run for production acceptance (predictionValid>0, researchEligible>0).

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
| v3.4.9.8 | 2026-06-26 | **P1.2**: unified executionConfig, empirical CI, lock window fix, idempotent eval. **P1.3**: smokeOnly, window range, H1 smoke test. **P1.4**: catch-up gate, window plan integrity, H1 Smoke UI, H1 4-window formal study → REJECTED_RESEARCH. **P1.5**: windowResults bug fix, cloud observability (/api/health+heartbeat+currentTask), release identity unified, Cockpit H1 rejection banner + canonical cohort. **P1.6**: canonical cohort root-cause fix (`scheduledSlot="9:30"` → `"09:30"`), enriched cockpit diagnostics. **P1.7**: expectedReturn wiring fix — `rankByExpectedReturn()` now runs before research snapshot, ledger entries will carry expectedReturn/confidence/breakdown (acceptance pending next 09:30) |
| v3.4.9.7 | 2026-06-23 | **P0.2**: deploy identity, fixed capacity, same-path benchmark, exit tradability, Monte Carlo, Laplace p-value, paired delta CI |
| v3.4.9.6 | 2026-06-23 | Phase 1.1: honest data boundaries, real feature availability, trade simulation |
| v3.4.9.5 | 2026-06-23 | PIT Historical Research Lab: 5 modules, 835 days x 953K records |
| v3.4.5 | 2026-06-18 | Data bus unification, per-index freshness |
| v3.4.0 | 2026-06-17 | Unified Decision Kernel (5→6 blockers), Decision Audit, Cockpit WNB |
| v3.3.x | 2026-06 | Walk-Forward, IC decomposition, Shadow evaluation, Model Registry |
