#!/usr/bin/env bash
# Runs given corpus fixtures N times with the parser of a given checkout, to
# tell model variance from a code change (same OCR every run).
#   bash scripts/corpus-repeat.sh <checkout dir> <output dir> <runs> <fixture name>...
#   e.g. bash scripts/corpus-repeat.sh . out/after 2 madgod-pt sulbarreiro-pt
set -u
dir="$1"; out="$2"; runs="$3"; shift 3
mkdir -p "$out"
out_abs="$(cd "$out" && pwd)"
cd "$dir"
for name in "$@"; do
  for i in $(seq 1 "$runs"); do
    echo "[repeat] $name run $i ($dir)"
    npx tsx scripts/debug-parse-receipt.ts --fixture="supabase/functions/parse-receipt/__fixtures__/vision-$name.json" \
      "$out_abs/vision-$name-run$i.debug.json" > "$out_abs/vision-$name-run$i.log" 2>&1 \
      || echo "[repeat] $name run $i FAILED"
  done
done
echo "[repeat] done"
