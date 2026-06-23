#!/bin/bash
# P0.2 Snapshot rebuild — one-shot background job
# Run: bash /root/rebuild_snapshots.sh

cd "/root/FIRSTCC/Francis Investment"

echo "=== P0.2 Snapshot Rebuild ==="
echo "Start: $(date)"
echo "Log: /root/snapshot_rebuild.log"

node mosaic/research/historical_snapshot.js 2023-10-27 2026-06-23 > /root/snapshot_rebuild.log 2>&1

RC=$?
echo "Exit code: $RC"
echo "End: $(date)"

if [ $RC -eq 0 ]; then
  SNAP_COUNT=$(ls report-engine/data/research/snapshots/*.jsonl 2>/dev/null | wc -l)
  echo "Snapshots generated: $SNAP_COUNT"
  echo "SNAP_COUNT=$SNAP_COUNT" > /root/snapshot_rebuild_result.txt

  echo "=== Running rolling OOS evaluation ==="
  node mosaic/research/rolling_oos_evaluation.js 2023-10-30 2026-06-15 > /root/oos_rebuild.log 2>&1
  echo "OOS exit: $?"
  echo "OOS done: $(date)"

  echo "=== Running true walk-forward ==="
  node mosaic/research/true_walk_forward.js 2023-10-30 2026-06-15 > /root/walkforward_rebuild.log 2>&1
  echo "Walk-forward exit: $?"
  echo "WF done: $(date)"

  # Restart server to pick up new data
  systemctl restart mosaic
  echo "Server restarted"
fi

echo "=== All done: $(date) ==="
