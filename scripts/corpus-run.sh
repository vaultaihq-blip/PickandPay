#!/usr/bin/env bash
# Runs the parser debug tool over the whole corpus with frozen Vision responses
# (so OCR is identical between runs; only the GPT pass varies), writing one
# report per receipt into the given folder. The Oligark runs 3 times.
#   bash scripts/corpus-run.sh <output folder>
set -u
out="$1"
mkdir -p "$out"
fixtures=(supabase/functions/parse-receipt/__fixtures__/vision-*.json backups/corpus-vision-2026-11-03/vision-*.json)
for f in "${fixtures[@]}"; do
  name=$(basename "$f" .json)
  runs=1
  [[ "$name" == *oligark* ]] && runs=3
  for i in $(seq 1 "$runs"); do
    echo "[corpus] $name run $i"
    npx tsx scripts/debug-parse-receipt.ts --fixture="$f" "$out/$name-run$i.debug.json" > "$out/$name-run$i.log" 2>&1 \
      || echo "[corpus] $name run $i FAILED (see $out/$name-run$i.log)"
  done
done
echo "[corpus] done"
