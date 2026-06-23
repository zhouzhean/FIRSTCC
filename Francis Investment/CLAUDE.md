# Francis Investment · A股量化交易系统 v3.4.9.7

Node.js 零外部依赖，阿里云 ECS `8.153.101.112:8765`。全天候自动交易+24/7自主学习+报告引擎。低价(≤20元)非创业板A股子策略。

## v3.4.9.7: Research Validity + Output Interpretability (P0-P1 + P0.2)

### P0 Research Integrity

- **P0-1 — Unified Label Convention**: T close signal → T+1 open entry → hold 3 trading days → T+4 close exit. Immutable `unavailable` when untradeable. Fields: `entryDate`, `exitDate`, `entryPrice`, `exitPrice`, `targetStatus`
- **P0-2 — Repaired Trade Simulator**: 3 equal-weight sleeves, overlapping daily cohorts, T+1 entry→T+4 exit, NAV extended through last exit. 8 fixture tests (20 assertions)
- **P0-3 — Deterministic Random-Portfolio Monte Carlo**: Fixed-seed XorShift (42), full time-series portfolio comparison against random Top-N, Laplace-smoothed p-value `(extreme+1)/(n+1)`, paired delta CI

### P0.2 Research Output Interpretability

- **Deploy identity**: deploy_manifest.json → `/api/status` shows `identityStatus=matched` (version/commit chain verified)
- **Fixed portfolio capacity**: topNPerCohort=50, 3 sleeves, max 17/sleeve = 150 concurrent max. Config in `config.js` RESEARCH_PORTFOLIO
- **Same-path benchmark sleeve**: parallel benchmark sleeves mirror strategy (same dates/structure/compounding), tracks SH index return. Output: `netReturn`, `grossReturn` (true pre-cost), `benchmarkReturn`, `netExcessReturn`
- **Exit tradability**: exit date checked for suspension/limit-down, roll-forward up to 5 days. Fields: `plannedExitDate`, `actualExitDate`, `exitDelayDays`, `exitStatus`
- **Calibration fix**: prediction key = `asOfDate + '|' + code` (not just code)

### P1 Fixes

- **Standardized Walk-Forward**: Ridge with unregularized intercept, train-only standardization, Kendall tau-b Rank IC
- **P1-UI — Research Lab Panel**: Cockpit Panel 11 — P0 status, capacity, latest window net/gross/excess, Monte Carlo CI
- **Status colors**: Yellow "Code fixtures passed — historical data not yet rebuilt" → Green "Research Operational" when snapshots regenerated with P0.2 fields

## Research Architecture (v3.4.9.x)

### Modules

| Module | Purpose |
|--------|---------|
| `mosaic/research/historical_snapshot.js` | Daily point-in-time snapshots with labels (654 dates, ~1578 stocks) |
| `mosaic/research/trade_simulator.js` | 3-sleeve equal-weight portfolio with exit tradability roll-forward |
| `mosaic/research/baseline_models.js` | Random-Portfolio Monte Carlo + technical-only baseline |
| `mosaic/research/linear_model.js` | Ridge regression (closed-form normal equations) |
| `mosaic/research/rolling_oos_evaluation.js` | Rolling OOS per window with portfolio-level compareFullTimeSeries |
| `mosaic/research/true_walk_forward.js` | Strict train→validate→test pipeline, per-window model artifacts |
| `mosaic/research/universe_definition.js` | Honest universe: current-file, stable start 2023-10-27 |
| `mosaic/research/data_audit_v2.js` | Per-date coverage %, stock-start cliff, gap analysis |

### Data Boundaries

- **K-line source**: Tencent ifzq (qfq), 1578 stocks, ~980K bars from 2020-01-02
- **Stable universe start**: 2023-10-27 (90% coverage threshold)
- **Available features**: technical (price/vol), hidden (H1-H9) — real PIT
- **Unavailable**: financial, capitalFlow, event — all null with `_estimated:true`

### Output Structure

```
report-engine/data/research/
├── universe_coverage_index.json
├── data_coverage_report_v2.json
├── model_artifacts/window_NNN/{model,feature_schema,dates,data_hash}.json
├── trade_simulation/{portfolio_nav.jsonl, trade_simulation_summary.json}
├── oos_evaluation_results/{rolling_oos_summary, window_NNN}.json
├── snapshots/  (654 JSONL files)
└── ...
```

## Core Production Architecture

```
mosaic_server.js (HTTP)
├── mosaic/decision_kernel.js   # 6 Hard Blockers → canBuy/maxBuysPerDay
├── mosaic/scheduler.js          # State machine (3 full + 7 mid scans daily)
├── mosaic/pipeline.js           # Main pipeline: scan → score → execute
├── mosaic/simfolio.js           # Simfolio: kernel-governed trade engine
├── mosaic/config.js             # ★ Single config source
│
├── mosaic/collectors/           # market_data, index_recorder, capital_flow, north_bound, etc.
├── mosaic/factors/              # hidden_signals.js (H1-H9), composite.js (5-dim weighted)
├── mosaic/analysis/             # data_quality, strategy_health, verification_runner, risk_budget, etc.
├── mosaic/predict/              # expected_return.js, dynamic_weights.js, trade_attribution.js
├── mosaic/evolution/            # model_registry, bootstrap_history, full_backtest, self_reflection
│
└── report-engine/               # cockpit.html/js, think-tank.html, index.html (static)
```

### Decision Kernel — 6 Hard Blockers (priority order)

| # | Gate | Blocks when |
|---|------|------------|
| 0 | marketSession | non-trading hours |
| 1 | marketData | validCoreCount < 2 |
| 2 | circuitBreaker | panic/risk_off regime |
| 3 | leakageAudit | CRITICAL/DATA_LEAKAGE |
| 4 | strategyHealth | masterControl=BLOCK |
| 5 | dataQuality | penalty ≥ 7 |

Soft reducers: leakageAudit MINOR / strategyHealth REDUCE/CAUTIOUS / dataQuality 4-6 → downgrade, not block.

### Simfolio Rules

Initial ¥100,000, max 5 positions, single ≤30%, T+1. Stop-loss: hard -8%, soft score<35, trailing. Cooldown: 4 trading days.

## Cloud Deployment

```bash
# Deploy backend
scp "<local>" "root@8.153.101.112:/root/FIRSTCC/Francis Investment/<path>"
ssh root@8.153.101.112 "systemctl restart mosaic"

# Verify
curl -s http://8.153.101.112:8765/api/status
curl -s http://8.153.101.112:8765/api/cockpit
```

| Item | Detail |
|------|--------|
| IP | `8.153.101.112:8765` |
| OS | Ubuntu 22.04, 2 vCPU/2 GiB |
| Process | systemd `mosaic.service` (Restart=always) |
| SSH paths | Must quote: `"/root/FIRSTCC/Francis Investment/..."` |
| K-line source | Tencent ifzq (Eastmoney blocked on ECS) |

## Key Constraints

- **Cloud always first**: deploy immediately after changes
- **`config.js` is single config source**; `report-engine/data/` is DATA_DIR
- **`.gitignore` runtime data**: sync when adding data directories
- **`node --check`** before deploy — one frontend JS syntax error breaks everything
- **Eastmoney blocked on ECS** → K-line uses Tencent ifzq

### v3.4.x Pitfall Reference

| Trap | Key |
|------|-----|
| kernel context consistency | All 3 consumers must share portfolio+indices+pipelineResults+marketState |
| simfolio P0-1 | Check `kernelDecision.finalVerdict` BLOCK/REDUCE → sell-only |
| decision audit | Use `gateStates` fields, not old flags |
| marketClosed vs noMarketData | kernel accepts `marketState` field to distinguish |
| market_snapshot_latest.json | pipeline.fetchIndices writes, loadLatestIndices reads |
| freshnessStatus | live/recorder/cached/stale_daily — history doesn't masquerade as today |
| IndexRecorder | Price only, no changePct; pipeline snapshot is primary |
| strategy_health totalTrades | In `masterControl.totalTrades`, used for decision audit |

## Version History

| Version | Date | Key Changes |
|---------|------|-------------|
| v3.4.9.7 | 2026-06-23 | **P0.2**: deploy identity, fixed capacity (50/sleeve×3=150), same-path benchmark sleeve, exit tradability roll-forward, Monte Carlo rename, Laplace p-value, paired delta CI, Research Lab yellow→green status |
| v3.4.9.6 | 2026-06-23 | Phase 1.1: honest data boundaries, real feature availability, proper trade simulation (7 new + 3 modified modules) |
| v3.4.9.5 | 2026-06-23 | PIT Historical Research Lab: 5 modules (data_audit, calendar, snapshot, walk-forward, baselines), 835 days × 953K records |
| v3.4.9.4.2 | 2026-06-22 | API counting unified, deploy identity fallback, verification test fix |
| v3.4.9.4.1 | 2026-06-22 | Manifest path unification, canonical by scheduler identity, 6-layer eligibility, quarantined separation |
| v3.4.9.4 | 2026-06-21 | Research cohort + prediction ledger, eligibility dedup, daily_research_manifest |
| v3.4.5 | 2026-06-18 | Data bus unification: pipeline writes snapshot, per-index freshness, 399006 index |
| v3.4.0 | 2026-06-17 | Unified Decision Kernel (5→6 blockers), Decision Audit, Cockpit WNB |
| v3.3.x | 2026-06 | Walk-Forward, IC decomposition, Shadow evaluation, Model Registry |
| v3.0 | 2026-05 | Strategy health dashboard, risk budget, full backtest framework |
