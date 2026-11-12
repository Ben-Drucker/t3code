#!/usr/bin/env bash
# Test stub for `update.sh --test`. Imitates `scripts/fork.sh deploy` (detached mode, step markers,
# step-times, log files) at compressed time. It builds nothing and never touches /Applications.
#
# Environment: T3_FORK_OUT (required), FAKE_SCALE (seconds multiplier, default 1),
# FAKE_FAIL_STEP (step name that fails, default none).
set -euo pipefail

OUT="${T3_FORK_OUT:?T3_FORK_OUT is required}"
SCALE="${FAKE_SCALE:-1}"
FAIL_STEP="${FAKE_FAIL_STEP:-}"
TIMINGS="$OUT/step-times"
VERSION="0.0.0-nightly.test"
# Name:base seconds:fallback estimate, the same names and fallbacks as fork.sh.
STEPS=("Fetching upstream:2:5" "Installing dependencies:3:15" "Building the app:6:130" "Installing:2:12")

[ "${1:-}" = deploy ] || { echo "error: the stub only supports 'deploy'" >&2; exit 2; }
mkdir -p "$OUT"

fmt_secs() { printf '%d:%02d' $(($1 / 60)) $(($1 % 60)); }
say() { printf '\n==> %s\n' "$*"; }
estimate_for() {
  local saved=""
  [ -f "$TIMINGS" ] && saved="$(awk -F'\t' -v n="$1" '$1 == n { v = $2 } END { print v }' "$TIMINGS")"
  printf '%s' "${saved:-$2}"
}
record_time() {
  { [ -f "$TIMINGS" ] && grep -v "^$1	" "$TIMINGS" || true; printf '%s\t%s\n' "$1" "$2"; } >"$TIMINGS.tmp"
  mv "$TIMINGS.tmp" "$TIMINGS"
}

if [ "${T3_FORK_DETACHED:-0}" != 1 ]; then
  detail="$OUT/deploy-detached.log"
  : >"$detail"
  T3_FORK_DETACHED=1 nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' \
    bash "${BASH_SOURCE[0]}" "$@" >"$detail" 2>&1 </dev/null &
  echo "$!" >"$OUT/deploy.pid"
  echo "Deploy started in the background (pid $!). Progress: tail -f $detail"
  echo "Details: $OUT/deploy.log"
  exit 0
fi

log="$OUT/deploy.log"
: >"$log"
total=0
for entry in "${STEPS[@]}"; do
  IFS=: read -r name _ fallback <<<"$entry"
  total=$((total + $(estimate_for "$name" "$fallback")))
done
echo "stub args: $*" >>"$log"
say "Deploying $VERSION (estimated $(fmt_secs "$total"); log: $log)"

started_all="$(date +%s)"
idx=0
count=${#STEPS[@]}
for entry in "${STEPS[@]}"; do
  IFS=: read -r name base fallback <<<"$entry"
  est="$(estimate_for "$name" "$fallback")"
  idx=$((idx + 1))
  act="$log"
  [ "$name" != "Building the app" ] || act="$OUT/build.log"
  echo "[$idx/$count] $name (about $(fmt_secs "$est"))"
  started="$(date +%s)"
  pause="$(awk -v b="$base" -v s="$SCALE" 'BEGIN { printf "%.3f", b * s / 6 }')"
  for chunk in 1 2 3 4 5 6; do
    echo "[$name] working on part $chunk of 6" >>"$act"
    sleep "$pause"
    if [ "$name" = "$FAIL_STEP" ] && [ "$chunk" = 4 ]; then
      echo "ERROR: simulated failure in '$name'" >>"$act"
      tail -25 "$act"
      echo "error: '$name' failed. Full log: $act" >&2
      exit 1
    fi
  done
  record_time "$name" "$(($(date +%s) - started))"
done

echo "Done in $(fmt_secs $(($(date +%s) - started_all))). Installed $VERSION; T3 apps in /Applications: 0."
echo "Rollback copy: $OUT/T3-old-nightly.app (quit T3 and move it back into /Applications)."
