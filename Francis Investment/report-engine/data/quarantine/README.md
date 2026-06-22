# Quarantined Test Fixture Data

**Date quarantined**: 2026-06-22
**Source**: v3.4.9.1_test.js integration test
**Fixture IDs**: `v3491t_d0` through `v3491t_d3` (runId `v3491t_full_1`), `past_0` through `past_4` (runId `past_full_1`)

## Why quarantined

These files contain synthetic test fixture data written directly into the real `report-engine/data/` directory by the v3.4.9.1 integration test. They are NOT real market data, kline data, or production predictions/outcomes.

## MUST NOT

- Be used for training, verification, or calibration
- Feed into Rank IC, Kendall tau, or any statistical computation
- Be used as evidence for model promotion or weight updates
- Be restored to their original locations

## Preserved for

Forensic reference only. These files document what the v3.4.9.1 test wrote to production directories.

## Files

| File | Content |
|------|---------|
| `simfolio/prediction_ledger_2026-06-15.jsonl` | 4 fixture predictions (v3491t_d0..d3) |
| `simfolio/prediction_ledger_2026-06-13.jsonl` | 5 fixture predictions (past_0..past_4) |
| `simfolio/outcome_ledger.jsonl` | 4 settled/unavailable outcomes for v3491t_d0..d3 |
| `simfolio/index_history_2026-06-18.json` | Synthetic sh=3316.5, sz=10600 |
| `klines/600001.json` | Test kline data (~2109 bytes, created Jun 22 12:28) |
| `klines/600002.json` | Test kline data (~2130 bytes, created Jun 22 12:28) |
| `klines/600003.json` | Test kline data (~2070 bytes, created Jun 22 12:28) |
| `klines/600999.json` | Empty kline fixture (38 bytes, created Jun 22 12:28) |

## Recovery

Real kline data for 600001/600002/600003 can be re-fetched from Tencent ifzq API.
Real prediction/outcome ledgers for these dates must be rebuilt from production scans.
