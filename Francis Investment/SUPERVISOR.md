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

| Version | Supervisory conclusion |
|---|---|
| v3.4.6 | Market data became fail-closed; Top 50 ledger and evidence gating were introduced. |
| v3.4.7 | Target-date settlement, outcome deduplication, baseline benchmark handling, and preliminary multi-day evidence schema were added. P0 is materially safer; P1 still needs statistical and UI completion. |
| v3.4.8 | Baseline migration, seeded bootstrap, and basic evidence UI were added. A production review found the ledger is skipped by the unified BLOCK/REDUCE early return, outcome fields do not feed post-cost excess return, and CI/promotion guards are not enforced at the canonical summary/registry boundary. The next milestone is data-producing research operations, not more factors. |
| v3.4.9 | The intended research-data architecture, promotion lock, tie-aware statistic, quote service, and UI were deployed. Focused tests pass, but source review found the critical unified BLOCK/REDUCE early return still skips ledger capture, and production has not yet run a new scan. Current status: deployed but not production-accepted. |
