# Francis Investment Supervisor Charter

> Purpose: this is the durable supervisory record for Francis Investment (FI).
> It records verified conclusions, non-negotiable safeguards, acceptance criteria,
> and the current priority. It is not a runtime log and does not replace `CLAUDE.md`.

## How To Use This File

Before proposing or implementing a material change, read this file first, then
`CLAUDE.md`, then the relevant source code and current cloud API output.

When a change is complete, update this file only when it changes a verified
project state, a guardrail, a milestone, or the current priority. Do not turn
this into a verbose implementation diary.

## Project Mandate

- FI is a conservative automated **paper-trading and research system** for a
  defined A-share sub-strategy: low-priced shares, not a full-market predictor.
- The near-term objective is trustworthy data collection, reproducible
  validation, and safe simulated execution. It is not to maximize trade count.
- FI must not be represented as a proven alpha generator or used for real-money
  deployment until the evidence milestones below are met and independently
  reviewed.
- "No trade" is a valid and often desirable result. Every no-trade result must
  identify whether it was caused by market conditions, data quality, risk
  controls, or insufficient prediction evidence.

## Current Verified State

Last supervisory review: 2026-06-22, v3.4.9.4.2 source and cloud review.

### Latest Verified Milestone

- v3.4.9.4 and v3.4.9.4.1 establish a materially better evidence architecture:
  pure cohort logic, isolated production-path testing, a scheduler-designated
  09:30 canonical run, immutable decision events, model-version lineage, and
  separate active versus quarantined cohort counts.
- v3.4.9.4.2 aligns the two Cockpit/API cohort surfaces: the 250 legacy
  hash-only records are quarantined and no longer count as active global blocks.
- Cloud is running v3.4.9.4.2 after the last trading scan, so it has not yet
  produced a new-format canonical cohort. `canonicalCohortCount=0` and
  `researchEligible=0` are expected until the next 09:30 scheduled run.
- The release-identity acceptance gate is still open. The cloud status endpoint
  reports `deployManifestValid=false`, `deployFileHashCount=0`, and an old
  Git SHA even though the local deployment manifest records v3.4.9.4.2. Do not
  treat a cloud sample as reproducible until this mismatch is resolved.

- Cloud API reported v3.4.7 running with valid live quotes for all three core
  indices (`validCoreCount=3`) during the 11:00 scan.
- The market-data fail-closed gate is verified: invalid core quotes block new
  buys; valid quotes with a 0% change are accepted.
- The latest full scan processed 5,543 stocks, screened 610, and deeply
  analyzed 80. This is better coverage, not proof of predictive quality.
- New buys remain blocked by strategy health and data quality. The health
  sample is only 8 completed trades, with 37.5% win rate and 0.32 profit
  factor. This warrants risk reduction but does not prove the strategy failed.
- Current expected-return outputs have roughly 0.33 confidence and only 2/6
  active dimensions. They are advisory observations, not actionable alpha.
- There is not yet sufficient independent out-of-sample evidence for Rank IC,
  net excess return, calibration, dynamic weights, or model promotion.
- v3.4.8 correctly migrated the persisted historical Champion to `baseline`,
  added a seeded with-replacement bootstrap implementation, and added basic
  Cockpit market-validation and prediction-settlement surfaces.
- These are not predictive-evidence milestones yet. Cloud output currently has
  no prediction ledger or outcome ledger, zero independent evaluation days,
  and null post-cost excess return. The historical bootstrap Baseline has zero
  live evaluation days and must be treated as a frozen reference, not alpha.
- At the 11:19 review, the system was `BLOCK` because its last index snapshot
  was from 11:00 and had become stale. This was a correct fail-closed response,
  but it was an operational data-freshness block, not an investment judgement
  that the market environment was unattractive.
- v3.4.9 deployed the intended research tiers, promotion lock, tie-aware
  statistic, outcome schema, quote service, and Cockpit surfaces. Its focused
  tests and syntax checks pass, but deployment happened during lunch and no
  post-deployment production scan has written a ledger yet.
- Source review found the unified `BLOCK`/`REDUCE` early return and the
  no-index early return still precede ledger capture. The v3.4.9 end-to-end
  test manually constructs records rather than exercising these production
  paths. Do not call the evidence loop operational until a real blocked scan
  writes a stable ledger and later settles it.
- v3.4.9.1 moves Top-50 ledger capture before the no-index and kernel
  `BLOCK`/`REDUCE` returns, writes unavailable outcomes by prediction ID,
  counts research-eligible pending records, and writes null CI bounds below 20
  independent days. These are meaningful control-flow repairs.
- The patch is not production-accepted yet. The ledger writer has no run-ID
  idempotency guard despite its write-once claim, and its focused test writes
  to and deletes real `report-engine/data` files. The test also does not
  invoke real `makeTradingDecisions()` for blocked paths. Cloud restarted
  during lunch after the last scan, so its empty ledger is expected but remains
  unverified until the next active-session scan.
- Local review confirmed test fixture identifiers in
  `outcome_ledger.jsonl` and `prediction_ledger_2026-06-15.jsonl` with the
  test-run timestamp. Treat the affected local ledger and overwritten
  historical files as contaminated for research purposes. Cloud currently has
  no outcome ledger, so this specific contamination has not reached cloud.
- Cockpit hides quote age visually outside a session, but the cloud API still
  exposes stale `marketData` as an active blocker alongside `marketSession`.
  UI and canonical kernel/API state are not yet aligned.
- The independent-day counter filters for canonical full scans, but
  `verifyOneScan()` still iterates all lines in a daily ledger. Intraday
  `canonical=false` records can therefore contaminate the same day's primary
  Rank IC/Kendall statistic. The day-count and sample-count boundaries are not
  fully aligned yet.

## Non-Negotiable Decision Rules

1. `decision_kernel.computeDecision()` is the single source of truth for all
   buy permissions. Cockpit, Think Tank, manual routes, scheduler, and Simfolio
   must pass the same market, portfolio, pipeline, and risk context.
2. During a trading session, fewer than 2 valid core indices among
   `000001`, `399001`, and `399006` is `BLOCK`, not `CAUTIOUS` or `ALLOW`.
3. A valid index quote requires positive price and previous close, a valid
   session timestamp, and acceptable freshness. Cached or historical data may
   be displayed but must not authorize an opening trade.
4. `BLOCK` and `REDUCE` mean sell/risk management only. Background prediction
   collection may continue, but records with invalid market context must not
   qualify for model evaluation or promotion.
5. No module may infer its own final buy permission outside the kernel.

## Data And Evidence Integrity

- Prediction records are append-only and must be captured for the ranked Top 50
  before buy filtering. Each record requires a stable prediction ID, scan ID,
  as-of date, exact trading-day target date, model version, feature snapshot,
  entry price, benchmark price, eligibility, and exclusion reason.
- Outcomes may be written exactly once per prediction ID, only on the exact
  target date. Missing benchmark data must yield unavailable excess return,
  never a fabricated value, zero, or infinity.
- `evaluationEligible=false` records are useful operational observations but
  must be excluded from Rank IC, net excess return, dynamic weights, and model
  promotion.
- Rank IC is a ranking metric, not a direction hit rate. It must be based on
  immutable predictions and mature forward returns across independent trading
  days, with correct tie handling and a valid block-bootstrap confidence
  interval.
- A model or weight change cannot use in-sample hit rate, cumulative IC proxy,
  current pipeline data, or a hand-waved calibration score as evidence.

## Learning And Promotion Gates

| State | Requirement | Permitted action |
|---|---|---|
| Record only | Fewer than 300 mature eligible predictions or 20 trading days | Log observations; keep config weights |
| Suggest only | 300-999 predictions, insufficient evidence, or non-positive CI/net excess | Save proposals only; no automatic use |
| Shadow eligible | At least 1,000 mature predictions, 60 trading days, positive Rank IC CI lower bound, positive post-cost excess return | Compare in shadow only |
| Paper promotion review | Two rolling out-of-sample windows, no drawdown deterioration, valid calibration, and supervisor review | Limited paper-trading parameter test |

The historical bootstrap model is a **Baseline**, not a Champion. A Shadow may
not become a Baseline because of an unverified historical score alone.

## Execution Realism

- Simulated fills must include commissions, transfer fee, stamp tax, and adverse
  slippage. Limit-up/limit-down, liquidity, and fill failure assumptions must be
  visible in future execution audits.
- Strategy health distinguishes "risk reduction with insufficient sample" from
  "strategy statistically disproven." It must continue collecting qualified
  shadow predictions while buys are restricted.

## UI Accountability

Every material P0/P1 backend change requires a minimal reader-facing UI update
in Cockpit or Think Tank. A terminal summary is not a user-facing update.

The UI must expose:

1. **Market validation:** valid core count, source chain, quote age, invalid
   indices, and the exact market-data gate reason.
2. **Decision funnel:** scanned, screened, analyzed, predicted, evidence-
   eligible, buy-eligible, and executed counts, plus the primary no-buy reason.
3. **Prediction settlement:** Top 50 count, eligible/evaluation-eligible
   counts, exclusion-reason distribution, pending T+3 outcomes, and settled
   outcomes.
4. **Evidence state:** independent trading days versus 20, Rank IC with CI,
   post-cost net excess return, and an explicit "insufficient evidence" state.
5. **Model state:** Baseline, Shadows, promotion locks, and dynamic-weight tier.

Labels must be causal and honest. A module is `active_effective` only when its
documented input was available, it executed, and it changed a score, threshold,
position size, or gate. "Executed, no decision impact" is a valid state.

## Current Priority: Release Identity + First Canonical Cohort

Do not add factors, alter strategy thresholds, promote a model, or increase
autonomy before the following are complete:

### Final Evidence-Foundation Gate

1. **Make the deployment identity authoritative.** The cloud must receive a
   valid `deploy_manifest.json` containing the actual committed source SHA and
   file hashes. `/api/status` must expose `deployCommit`, manifest validity,
   file-hash count, and any disagreement with its local Git state.
2. **Collect one real designated cohort.** After the next 09:30 task, require
   a completed manifest, one canonical run ID, no more than 50 unique codes,
   and positive schema/prediction/research counts. A zero execution count is
   acceptable only when the kernel records the actual blocking reason.
3. **Settle that exact cohort.** At T+3, outcomes must be keyed to those
   prediction IDs, with explicit unavailable records where needed. This proves
   the live loop once; it does not prove alpha.
4. **Freeze the execution platform after acceptance.** Further work shifts to
   point-in-time historical research, rolling out-of-sample tests, and baseline
   comparison. Only P0 data-integrity regressions may reopen this layer.

### Historical Acceptance Work (Superseded Record)

### Immediate P0 Acceptance Work

0. **Make capture idempotent and observable.** Keep the shared capture before
   every execution return, but add atomic deduplication by
   `(runId, predictionId)` so retries cannot duplicate research observations.
   Capture must report record count, duplicate count, and write failure to the
   decision audit. A swallowed ledger-write failure is not valid evidence.
1. **Replace the destructive pseudo-integration test.** It must never touch
   live `report-engine/data`, delete a real outcome ledger, or replace real
   K-line/index files. Introduce a test data-root dependency or fixture
   injection, then invoke real `makeTradingDecisions()` for no-index,
   kernel `BLOCK`, `REDUCE`, and normal paths. Assert stable run ID,
   at most 50 unique codes, immutable feature fields, and no duplicates after
   a repeat invocation.
   Quarantine existing local fixture records and overwritten test files; do
   not restore, train, or calculate statistics from them without an identified
   pre-test backup or an explicit rebuild from immutable source data.
2. **Prove the deployed path.** After the next active-session scan, require
   `hasLedger=true`, a non-null stable run ID, and a positive
   `researchEligible` count. `executionEligible=0` is acceptable. Later,
   verify exact T+3 outcome settlement for the same prediction IDs.
3. **Unify session semantics.** Outside a trading session, canonical
   `marketData` must be `not_applicable` with null age and must not occur in
   `allActiveBlockers`; only `marketSession` may explain no new buys.
   Cockpit must render this canonical state instead of cosmetically hiding a
   contradictory API error.
4. **Harden the daily record.** Deduplicate candidate codes before Top-50
   selection and add a duplicate-input test. Keep the full scan as the one
   canonical daily evaluation observation. Primary verification and promotion
   metrics must filter to that canonical run; mid scans remain operational
   observations unless an explicit intraday research design is approved.

0. **Fix and prove the actual control flow.** Create one shared
   `captureResearchSnapshot()` call before every execution early return,
   including no-index, unified kernel `BLOCK`, unified kernel `REDUCE`,
   drawdown, strategy-health, and normal paths. Add an integration test that
   calls real `makeTradingDecisions()` for each path and asserts exactly one
   stable run ID plus 50-or-fewer ledger records, not a hand-built fixture.
   After the next real post-deployment scan, inspect the cloud ledger and UI.
1. **Define one canonical daily research observation.** Full and mid scans
   cannot be silently mixed in a date-only ledger and then truncated to the
   first 50 records. Persist and evaluate by `runId`; declare which scheduled
   snapshot is the daily model-evaluation observation. Treat intraday scans as
   operational observations unless separately modelled.
2. **Settle missing outcomes explicitly.** When stock or benchmark data is
   absent on a mature target date, write an immutable `unavailable` outcome by
   prediction ID. Never simply skip it. Outcome matching must use prediction
   ID, not the first same-code record in a daily file.
3. **Apply the statistical guard at the canonical boundary.** When independent
   days are below 20, the written summary and API must expose null CI bounds,
   not merely set `predictionEffective=false` while retaining a CI. Preserve
   raw exploratory metrics separately and label them non-promotional.
4. **Complete research visibility.** T+3 pending counts must include every
   `researchEligible` record, not only execution-eligible records. The UI
   must show the canonical run and its research/execution split.
5. **Keep session semantics honest.** Outside trading hours, quote age is not
   an active market-data failure. Show it as `not evaluated outside session`;
   during a session, verify the quote service produces fresh source-stamped
   data before it is allowed to replace the pipeline snapshot.

6. **Record before execution gates.** Compute and persist one ranked Top-50
   research ledger for every full scan before every `BLOCK` or `REDUCE` return.
   It must carry a stable scheduler-provided run ID, model version, exact
   as-of timestamp, universe snapshot, market-data verdict, and gate reasons.
   The in-memory scan counter and a hard-coded model version are not stable IDs.
7. **Separate research from execution eligibility.** `researchEligible` means
   point-in-time stock data and a complete immutable record are available.
   `executionEligible` means the stricter evidence/risk gates permit a buy.
   Low-confidence predictions remain valid calibration observations, segmented
   by confidence and feature coverage; they must not be silently discarded.
8. **Settle outcomes from the immutable ledger.** On the exact T+3 trading day,
   write one outcome keyed by prediction ID with entry/exit prices, benchmark
   entry/exit, actual return, post-cost excess return, costs, and settlement
   status. Verification must consume this ledger, not fields it never wrote.
9. **Make evidence gates real end-to-end.** At summary and registry level,
   fewer than 20 independent trading days must emit null Rank IC confidence
   bounds. Use a tie-aware rank statistic because expected-return values often
   tie. Do not use the old simple Spearman shortcut with arbitrary tie ordering.
10. **Lock promotion.** No automatic promotion or demotion. Require at least
   1,000 mature research-eligible predictions, 60 independent trading days,
   positive tie-aware Rank IC CI lower bound, positive post-cost excess return,
   valid calibration, two rolling out-of-sample windows, and explicit manual
   paper-promotion approval. Remove any fallback that calls a positive
   cumulative IC a substitute for post-cost return.
11. **Make market data a service.** Refresh and validate core index snapshots on
   a lightweight cadence throughout the trading session, separately from the
   expensive stock pipeline. Persist source, quote age, fallback source, and
   failure reason. A stale feed may block execution but must not halt valid
   research capture when its point-in-time stock data is intact.
12. **Show the state truthfully.** Cockpit must show scan run ID, record count,
   research/execution eligibility, T+3 pending and settled counts, independent
   days, and a clear distinction between `data freshness block` and `market
   risk block`. Empty-state UI must say collection has not started, not imply
   zero predictive ability.

## Required Completion Evidence

## Latest Review: v3.4.9.6 Phase 1.1 (2026-06-23)

### What is genuinely better

- The research universe is now explicitly labelled `current-file`, with a
  stable-period boundary, daily coverage, and survivorship risk. It must never
  again be described as full A-share history.
- Historical financial, capital-flow, and event fields are represented as
  unavailable rather than silently filled with defaults. The technical-only
  reference model is therefore a meaningful, honest baseline.
- A train / validation / test ridge-model scaffold and per-window artefacts now
  exist. They remain shadow research only.
- Cloud release identity is verified: v3.4.9.6 / commit `84f97b0`, manifest
  valid, identity matched.

### P0: Do before interpreting any historical performance

1. **Use one executable label everywhere.** Current snapshots train on
   `asOf close -> T+3 close`, while the simulator declares `signal at T close
   -> entry T+1 open -> exit after three holding days`. Rebuild labels using
   the latter convention, including the benchmark and an explicit unavailable
   outcome for missing bars, suspensions, and untradeable entry days.
2. **Repair the portfolio simulator before using return, drawdown, Sharpe, or
   cost metrics.** It currently processes a signal on T while using a T+1
   price, ends its NAV series on the last signal date rather than the last
   exit date, and may report executed trades with zero settled trades. Queue
   orders for their entry date, extend NAV through all exits, and apply costs
   once only. Add deterministic fixture tests for one trade, overlapping
   cohorts, final-day exit, suspension, limit, and known drawdown.
3. **Repair statistical aggregation.** Do not average daily p-values. The
   current `significantFraction` denominator is tautological and reports 1
   whenever non-zero significance exists. Compare time-series, post-cost
   portfolio returns against a daily matched random distribution using a
   fixed-seed block/bootstrap across dates; report CI, p-value, and the number
   of independent dates.

### P1: Research acceptance after P0

- Standardize features from training data only, fit an unregularized intercept,
  and apply the saved transform unchanged to validation and test data.
- Evaluate model predictions through the repaired simulator: daily rank IC,
  top-N post-cost return, turnover, maximum drawdown, and calibration by
  prediction decile. Direction accuracy alone is not alpha evidence.
- Treat the legacy composite score as a quarantined comparison only, because
  it still originated from unavailable dimensions. It cannot be a promotion
  candidate or a positive control.
- Add a small Cockpit Research Lab panel with data boundary, feature mask,
  label/execution convention, latest valid test window, and a prominent
  `research invalid - simulator/statistics repair pending` state until P0
  completes.

### Live-loop status

The deployed server has not yet produced a v3.4.9.6 canonical cohort. The
current cloud API shows `canonicalCohortCount=0`, with 250 old intraday records
that have `missing_target_date`; they are not usable learning evidence. After
the next 09:30 canonical run, require a manifest, one canonical run ID, a
non-null target date, and positive research-eligible count before calling the
production loop proven.

## Latest Review: v3.4.9.7 Research Validity Repair (2026-06-23)

### Verified progress

- The revised historical label now expresses the executable convention:
  `T close -> T+1 open -> T+4 close`, and the simulator fixtures pass 20/20.
  The previous unclosed-position / zero-trade-count defect is repaired in the
  fixture environment.
- Train-only feature standardization, an unregularized ridge intercept, and
  simulator-backed test-window evaluation are the correct next research
  architecture. Existing snapshots and artefacts remain invalid until they are
  regenerated under the new label.

### Required corrections before running the new historical study

1. **Restore release identity.** Cloud reports runtime version v3.4.9.7 but
   `buildCommit`, `gitCommit`, and `deployCommit` are still `84f97b0`; its
   deploy manifest is v3.4.9.6. Regenerate the manifest after commit `4965b49`,
   deploy it with source hashes, and require the cloud identity to equal that
   commit. A version string alone is not accepted.
2. **Make portfolio capacity match its stated Top-N.** The three-sleeve code
   currently limits each daily cohort to about 16-17 positions while upstream
   evaluation calls it Top-50. Choose and persist one meaning: either Top-50
   per cohort (up to 150 simultaneous names) or Top-17 per cohort / 50 total.
   Use that same number in every metric and UI label.
3. **Simulate the benchmark as a portfolio, not an average return.** Run the
   same sleeve dates, cash allocation, and entry/exit calendar on the index;
   write a benchmark NAV series. The current average of individual index cohort
   returns is not a matched benchmark for a compounded sleeve portfolio.
4. **Name post-cost results correctly.** Current `grossReturn` is already net
   of entry and exit costs. Output separate pre-cost and post-cost NAV/return,
   and calculate excess from the post-cost strategy return exactly once.
5. **Handle an untradeable exit conservatively.** The simulator checks entry
   suspension and price limits but does not check tradeability at exit. For a
   locked limit-down exit, record a failed exit and either carry to the first
   tradable date under a documented policy or mark it unavailable; never assume
   a fill at the close.
6. **Fix multi-date calibration keys.** Decile calibration maps predictions by
   stock code alone. It must use `(asOfDate, code)`, otherwise later daily
   predictions overwrite earlier ones for the same stock.
7. **Call the random method accurately.** It currently simulates random
   portfolios on fixed dates; it is not a block bootstrap of date sequences.
   Either rename it to deterministic random-portfolio Monte Carlo or add paired
   moving-block resampling and a CI for the model-minus-random return delta.

### UI and live safety

The Cockpit's yellow overall state is directionally correct, but its green
`P0 Status: pass` must become `code fixtures pass; data not regenerated` until
new snapshots, OOS results, and model artefacts carry the current label/data
hash. Do not run `runFixtures()` as a side effect of every cockpit API request;
surface a stored CI/test result instead.

For every change, report all of the following:

- Files changed and the behavioral reason for each.
- Focused unit or fixture tests for the changed guardrail.
- `node --check` for every changed JavaScript file.
- Cloud deployment version, build commit, and relevant API evidence.
- A visible UI location showing the new state and its loading/empty/error state.
- Any known limitation. "No errors" is not evidence that a financial metric is
  valid.
- An end-to-end fixture covering: BLOCK scan -> Top-50 ledger -> exact T+3
  outcome -> summary metrics -> promotion lock. A unit test of an isolated
  condition is not an acceptance test.

## Supervisory Change Log

## Latest Review: P1.3 H1 Smoke Run (2026-06-24)

### Verified evidence

- Cloud release identity is coherent: `buildCommit` and `deployCommit` are
  `ce58c2d`, the deploy manifest is valid, and cloud correctly reports
  `manifest_verified_no_git` rather than pretending a Git checkout exists.
- The smoke run used real historical data and completed without candidate,
  progress, promotion, lock, or Simfolio writes. The production candidate
  registry remains empty.
- H1 did **not** show encouraging alpha in Window 1. It produced 852 executed
  trades from 1,003 test signals; net return was -14.24%, Rank IC was -0.0378
  across 59 days, direction accuracy was 47.33%, and the paired
  model-minus-random result was -4.81% with 95% CI [-8.60%, -1.66%]. This is
  negative research evidence, not a system failure and not a reason to tune H1.

### P1.4 blockers before the formal four-window H1 study

1. **Catch-up must honour `CANDIDATE_RUNNER.enabled`.**
   `evolution_scheduler.js` directly dispatches `candidate_evaluation` in its
   catch-up switch even when the runner is disabled. Make the default
   fail-closed (`enabled: false`) in both scheduled and catch-up paths, and
   regression-test a Wednesday catch-up tick with no candidate, registry, or
   progress write.
2. **Window selection must not rewrite the six-window research plan.**
   `runCandidateEvaluation()` currently calls `setEvaluationWindows()` with the
   selected slice. A 0--3 execution therefore converts the plan into four
   research windows and removes the two future lock windows. Persist the full
   six-window plan from `allWindows`; execute only the selected absolute window
   IDs. Test start/end subsets, absolute IDs, and a later lock run.
3. **Make the smoke result visible and testable.**
   The Cockpit server exposes `researchLab.h1Smoke`, but the browser renderer
   currently has no H1-smoke render path. Show the run time, data/execution
   hash, trades, Rank IC, net return, random delta CI, benchmark status, and an
   explicit outcome label such as `Execution completed - evidence negative`.
   Add tests proving smoke mode changes only `smoke_summary.json`, never the
   registry, progress file, model registry, or Simfolio.
4. **No candidate may be accepted without a matched historical benchmark.**
   Random control is sufficient to reject a weak signal, but unavailable index
   trades are insufficient to claim post-cost market excess or to approve a
   shadow candidate. Build a point-in-time index sleeve later, before any
   positive candidate is advanced.

### P1.4 ✅ COMPLETED (2026-06-25)

**P1.4-A**: `evolution_scheduler.js` catch-up path now checks `CANDIDATE_RUNNER.enabled`
before dispatching. Default fail-closed (`{enabled:false}`) matches normal path.
Test 13 verifies config load failure defaults.

**P1.4-B**: `candidate_runner.js` `setEvaluationWindows()` now always passes the full
6-window `allWindows` to registry, not the sliced subset. Idempotency guard skips
overwrite on resume. `windowsStart`/`windowsEnd` only control which windows execute.
Lock windows 4-5 preserved. Tests 10-11 verify plan integrity and idempotency.

**P1.4-C**: H1 Smoke Evidence section added to `renderResearchLab()` in cockpit.js.
Displays status, runAt, window, samples, tradeCount, netReturn, Rank IC, delta CI,
benchmarkStatus, dataHash, executionHash. Evidence verdict: red "Evidence Negative /
未通过" when Rank IC <= 0 or delta CI upper < 0; no green pass without positive evidence.
Test 12 verifies smoke isolation (only smoke_summary.json changes).

Tests: 46 integration + 26 registry = 72 total, all passing. Cloud deployed.

### Next controlled action

After the three P1.4 lifecycle/UI fixes deploy and pass, run H1 exactly once
over research windows 0--3 with the frozen data, execution configuration, and
hypothesis. Do not alter H1 features, weights, thresholds, or costs. The run
must record all four windows and then make one evidence-backed decision:

- Failure of the pre-registered gates: write `REJECTED_RESEARCH` with all four
  window metrics and preserve artefacts. Do not retry or tune H1.
- Pass: it may become `SHADOW_CANDIDATE` only; first build matched historical
  benchmark data, then run the two untouched lock windows. It still has no
  trading permission.

Only after this decision should FI start H2. H3 follows H2. This keeps the
research factory falsifiable instead of creating an ever-growing pile of
untested factors.

## Latest Review: P0-C.1 and P1.1 local implementation (2026-06-24)

### What is verified locally

- `cohort_stats.js` is now the common implementation used by the two cohort
  API routes and by the scheduler's canonical acceptance calculation. Its
  isolated consistency test passes 11/11.
- Candidate research now has hypothesis-specific interaction features,
  train-only standardization in the runner, deterministic candidate version
  IDs, configurable simulator costs, and isolated test directories. Focused
  candidate tests pass 14/14 and registry tests pass 26/26.
- The candidate scheduler remains disabled. That is correct: none of these
  candidates may influence Simfolio or trade qualification.

### Current release status

- These changes are **local and uncommitted** at this review. They are not a
  cloud release. Cloud remains `v3.4.9.7`, commit `9b26157`, with
  `identityStatus=manifest_verified_no_git`.
- Cloud reports a current scheduler pipeline but `latestReport=2026-05-22`.
  Treat report/data freshness as unresolved observability work; do not infer
  fresh research input from the scheduler timestamp alone.

### Required P1.2 corrections before enabling Candidate Runner

1. **Use one execution configuration in candidate and random control.**
   `compareRankingsAgainstRandom()` currently falls back to its own default
   costs, Top-N, holding period, and sleeve capacity. Pass the exact candidate
   execution object into both model and random simulations, then include its
   hash in both stored records. Otherwise a custom-cost candidate is compared
   with a different-cost control.
2. **Repair lock-window evidence.** The lock path still builds `deltaCI` from
   legacy `vsBenchmark` plus/minus a fabricated 1.0. It must use the same
   empirical `vsRandom` delta distribution as research windows, and persist
   `windowPlanHash` and `executionHash` for windows 5 and 6.
3. **Make resume and records idempotent.** Reconstruct completed work from the
   registry as well as the progress file. `recordEvaluation()` must replace or
   reject a duplicate `(candidateVersionId, windowId, snapshotHash)` record.
   A lost progress file must never double-count evidence or change promotion.
4. **Replace the mutable pseudo-factory.** `createRegistry({dataDir})` mutates
   module-global state and returns the same module object. Use a true isolated
   registry instance or a runner dependency-injection option; reset all state
   on a data-root switch. Test isolation must not depend on require order.
5. **Fix the standardization test.** Its test standardizer has two columns but
   the asserted H1 vector has three including the interaction, producing a
   `NaN` third value. Assert a known finite transformed vector and assert the
   runner's prediction equals that finite calculation.
6. **Keep inference precision.** Candidate runner rounds fitted weights before
   prediction. Preserve full coefficients for ranking/inference and write a
   separately rounded display artifact only.
7. **Use empirical MC intervals.** Store the per-iteration model-minus-random
   deltas and take deterministic 2.5%/97.5% quantiles. Do not present
   `mean +/- 1.96 * randomSD` as a paired confidence interval.

### Next scientific step after P1.2

Run H1 only, in a single fixed research window, with the repaired runner and
the same execution config for strategy, index and random controls. Inspect the
artifact manually. Only then run H1's four research windows; run H2 and H3
sequentially afterwards. A candidate remains `RESEARCH_ONLY` until four
pre-registered windows and two untouched lock windows have passed. No neural
model, factor expansion, or live trading change is justified before then.

| Version | Supervisory conclusion |
|---|---|
| v3.4.6 | Market data became fail-closed; Top 50 ledger and evidence gating were introduced. |
| v3.4.7 | Target-date settlement, outcome deduplication, baseline benchmark handling, and preliminary multi-day evidence schema were added. P0 is materially safer; P1 still needs statistical and UI completion. |
| v3.4.8 | Baseline migration, seeded bootstrap, and basic evidence UI were added. A production review found the ledger is skipped by the unified BLOCK/REDUCE early return, outcome fields do not feed post-cost excess return, and CI/promotion guards are not enforced at the canonical summary/registry boundary. The next milestone is data-producing research operations, not more factors. |
| v3.4.9 | The intended research-data architecture, promotion lock, tie-aware statistic, quote service, and UI were deployed. Focused tests pass, but source review found the critical unified BLOCK/REDUCE early return still skips ledger capture, and production has not yet run a new scan. Current status: deployed but not production-accepted. |
