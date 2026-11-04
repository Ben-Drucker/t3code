#!/usr/bin/env bash
# Personal-fork helper: set up a machine, show drift from upstream, build and install the macOS app.
#
#   scripts/fork.sh deploy [--yes] [--allow-dirty]   set up anything missing, build, install
#   scripts/fork.sh status [--no-fetch]              how far the fork is from pingdotgg/t3code
#   scripts/fork.sh build                            build the DMG only
#   scripts/fork.sh install                          install the DMG for this checkout only
#
# On a new machine: clone the fork, then run `scripts/fork.sh deploy`. It installs missing
# toolchains (after asking, or with --yes), adds the upstream remote, installs dependencies,
# builds, and swaps the app into /Applications. Re-running it on a ready machine skips the setup.
#
# Environment:
#   T3_FORK_OUT      where DMGs, logs, step timings and the rollback app go (default ~/Code/T3ForkContainer)
#   T3_FORK_BRANCH   branch builds must come from (default mine)
#   T3_UPSTREAM_URL  upstream repository (default https://github.com/pingdotgg/t3code.git)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${T3_FORK_OUT:-$HOME/Code/T3ForkContainer}"
BRANCH="${T3_FORK_BRANCH:-mine}"
UPSTREAM_URL="${T3_UPSTREAM_URL:-https://github.com/pingdotgg/t3code.git}"
APP_NAME="T3 Code (Nightly)"
APP="/Applications/$APP_NAME.app"
VP_ENV="$HOME/.config/vite-plus/env"
NODE_VERSION="$(sed -n 's/.*"node": *"\([0-9.]*\)".*/\1/p' "$REPO/package.json" | head -1)"
TIMINGS="$OUT/step-times"
ASSUME_YES=0
ALLOW_DIRTY=0
NO_FETCH=0

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  read -r -p "$1 [y/N] " reply
  [ "$reply" = y ] || [ "$reply" = Y ]
}

# Runs a command under the Node version the repo pins, with the repo's task runner on PATH.
in_node() {
  [ -f "$VP_ENV" ] || die "Vite+ is not installed. Run: scripts/fork.sh deploy"
  # shellcheck disable=SC1090
  . "$VP_ENV"
  (cd "$REPO" && vp env exec --node "$NODE_VERSION" bash -c "$1")
}

# ---------------------------------------------------------------- status

# Newest nightly version merged into this checkout, without the leading "v".
current_version() {
  local tag
  tag="$(git -C "$REPO" describe --tags --match 'v*nightly*' --abbrev=0 HEAD 2>/dev/null)" \
    || die "No nightly tag is reachable from HEAD. Run: scripts/fork.sh deploy"
  printf '%s' "${tag#v}"
}

cmd_status() {
  cd "$REPO"
  git remote get-url upstream >/dev/null 2>&1 || die "No 'upstream' remote. Run: scripts/fork.sh deploy"
  if [ "$NO_FETCH" = 0 ]; then
    say "Fetching upstream"
    git fetch --quiet --tags upstream main
  fi
  local base behind ahead tags newest installed
  base="$(git merge-base HEAD upstream/main)"
  behind="$(git rev-list --count HEAD..upstream/main)"
  ahead="$(git rev-list --count --no-merges upstream/main..HEAD)"
  tags="$(git tag --merged upstream/main --no-merged HEAD -l 'v*nightly*' | sort -V)"
  newest="$(printf '%s\n' "$tags" | tail -1)"
  installed="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
    "$APP/Contents/Info.plist" 2>/dev/null || echo 'not installed')"

  say "Fork status ($(git branch --show-current))"
  printf 'Last reconciled with upstream: %s (%s)\n' "$(git log -1 --format=%cs "$base")" "$(git rev-parse --short "$base")"
  printf 'Upstream commits not yet merged: %s\n' "$behind"
  printf 'Upstream nightly releases not yet merged: %s%s\n' "$(printf '%s' "$tags" | grep -c . || true)" \
    "${newest:+ (newest $newest)}"
  printf 'Fork-only commits on top of upstream: %s\n' "$ahead"
  printf 'Version in this checkout: %s\n' "$(current_version)"
  printf 'Version installed in /Applications: %s\n' "$installed"
}

# ---------------------------------------------------------------- setup pieces

rust_ok() {
  command -v rustc >/dev/null 2>&1 || return 1
  local minor
  minor="$(rustc --version | sed -n 's/^rustc 1\.\([0-9]*\)\..*/\1/p')"
  # The 2024 edition needs Rust 1.85 or newer.
  [ -n "$minor" ] && [ "$minor" -ge 85 ]
}

# Everything that may need a question or a long interactive install runs here, before the progress bar.
preflight() {
  [ "$(uname -s)" = Darwin ] || die "This script builds the macOS app and only runs on macOS."
  [ "$(uname -m)" = arm64 ] || echo "warning: the build targets Apple Silicon (arm64); this machine is $(uname -m)."
  xcode-select -p >/dev/null 2>&1 \
    || die "Xcode command line tools are missing. Run 'xcode-select --install', finish the installer, then re-run."

  if ! rust_ok; then
    if command -v rustup >/dev/null 2>&1; then
      confirm "Rust is older than 1.85. Update it with rustup?" || die "Rust 1.85 or newer is required."
      rustup update stable
    else
      confirm "Rust is not installed. Install it with rustup?" || die "Rust is required for the desktop build."
      curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y
      # shellcheck disable=SC1091
      . "$HOME/.cargo/env"
    fi
    rust_ok || die "Rust is still older than 1.85."
  fi

  if [ ! -f "$VP_ENV" ]; then
    confirm "Vite+ (task runner and Node $NODE_VERSION manager) is not installed. Install it from https://vite.plus?" \
      || die "Vite+ is required."
    curl -fsSL https://vite.plus | bash
    [ -f "$VP_ENV" ] || die "The Vite+ install did not create $VP_ENV. Open a new shell and re-run."
  fi

  mkdir -p "$OUT"
  check_tree_early
}

# Branch and cleanliness are checked before any work starts. A fresh clone may not be on the fork branch yet.
check_tree_early() {
  cd "$REPO"
  git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$UPSTREAM_URL"
  if [ "$(git branch --show-current)" != "$BRANCH" ]; then
    git fetch --quiet origin "$BRANCH" 2>/dev/null || true
    git switch "$BRANCH" 2>/dev/null || git switch --track "origin/$BRANCH" 2>/dev/null \
      || die "Could not switch to '$BRANCH'. Set T3_FORK_BRANCH or create the branch."
  fi
  check_tree
}

step_sync() {
  git -C "$REPO" fetch --quiet --tags upstream main
  git -C "$REPO" fetch --quiet --tags origin
}

step_deps() { in_node 'vp i'; }

# ---------------------------------------------------------------- build

check_tree() {
  cd "$REPO"
  local branch dirty
  branch="$(git branch --show-current)"
  [ "$branch" = "$BRANCH" ] || die "On '$branch', expected '$BRANCH'. Switch branches or set T3_FORK_BRANCH."
  dirty="$(git status -s)"
  if [ -n "$dirty" ] && [ "$ALLOW_DIRTY" = 0 ]; then
    printf '%s\n' "$dirty"
    die "Uncommitted changes. Commit them (run 'vp run typecheck' first) or pass --allow-dirty."
  fi
}

dmg_path() { printf '%s/dist-dmg/T3-Code-%s-arm64.dmg' "$OUT" "$1"; }

cmd_build() {
  check_tree
  local version log
  version="$(current_version)"
  log="$OUT/build.log"
  mkdir -p "$OUT"
  echo "Building $version (log: $log)"
  # Never set the update-repository variables: they add app-update.yml and the app would self-update from upstream.
  if ! in_node "env -u GITHUB_REPOSITORY -u T3CODE_DESKTOP_UPDATE_REPOSITORY \
      node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 \
      --build-version '$version' --output-dir '$OUT/dist-dmg'" >"$log" 2>&1; then
    tail -30 "$log"
    die "Build failed. Full log: $log"
  fi
  [ -f "$(dmg_path "$version")" ] || die "Build finished but $(dmg_path "$version") is missing. See $log"
  echo "Built $(dmg_path "$version")"
}

# ---------------------------------------------------------------- install

cmd_install() {
  local version dmg mount built built_version
  version="$(current_version)"
  dmg="$(dmg_path "$version")"
  [ -f "$dmg" ] || die "No DMG for $version at $dmg. Run: scripts/fork.sh build"

  mount="$(hdiutil attach -nobrowse -readonly "$dmg" 2>/dev/null | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -1)"
  [ -n "$mount" ] || die "Could not mount $dmg"
  built="$mount/$APP_NAME.app"
  trap 'hdiutil detach "$mount" -quiet >/dev/null 2>&1 || true' EXIT
  built_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$built/Contents/Info.plist")"
  [ "$built_version" = "$version" ] || die "DMG contains version $built_version, expected $version."
  [ ! -e "$built/Contents/Resources/app-update.yml" ] \
    || die "The build contains app-update.yml and would self-update from upstream. Rebuild without update variables."

  if pgrep -f "$APP_NAME" >/dev/null 2>&1; then
    osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
    local waited=0
    while pgrep -f "$APP_NAME" >/dev/null 2>&1; do
      sleep 1
      waited=$((waited + 1))
      [ "$waited" -lt 30 ] || die "$APP_NAME is still running after 30 seconds. Quit it and re-run."
    done
  fi
  rm -rf "$OUT/T3-old-nightly.app"
  [ ! -e "$APP" ] || mv "$APP" "$OUT/T3-old-nightly.app"
  ditto "$built" "$APP"
  xattr -dr com.apple.quarantine "$APP"
  hdiutil detach "$mount" -quiet >/dev/null 2>&1 || true
  trap - EXIT
  open "$APP"
  echo "Installed $version"
}

# ---------------------------------------------------------------- deploy with progress

# Step name, function, and a first-run estimate in seconds. Measured times replace the estimates.
STEPS=("Fetching upstream:step_sync:5" "Installing dependencies:step_deps:15" "Building the app:cmd_build:130" "Installing:cmd_install:12")

estimate_for() {
  local name="$1" fallback="$2" saved=""
  [ -f "$TIMINGS" ] && saved="$(awk -F'\t' -v n="$name" '$1 == n { v = $2 } END { print v }' "$TIMINGS")"
  printf '%s' "${saved:-$fallback}"
}

record_time() {
  local tmp="$TIMINGS.tmp"
  { [ -f "$TIMINGS" ] && grep -v "^$1	" "$TIMINGS" || true; printf '%s\t%s\n' "$1" "$2"; } >"$tmp"
  mv "$tmp" "$TIMINGS"
}

fmt_secs() { printf '%d:%02d' $(($1 / 60)) $(($1 % 60)); }

draw_bar() { # done_seconds total_seconds label step_index step_count
  local done_s="$1" total="$2" label="$3" idx="$4" count="$5" width=28 pct filled left
  [ "$total" -gt 0 ] || total=1
  pct=$((done_s * 100 / total)); [ "$pct" -le 99 ] || pct=99
  filled=$((pct * width / 100))
  left=$((total - done_s)); [ "$left" -ge 0 ] || left=0
  printf '\r\033[K[%s%s] %3d%%  %d/%d %s  ~%s left' \
    "$(printf '%*s' "$filled" '' | tr ' ' '#')" "$(printf '%*s' $((width - filled)) '' | tr ' ' '-')" \
    "$pct" "$idx" "$count" "$label" "$(fmt_secs "$left")"
}

cmd_deploy() {
  preflight
  local log="$OUT/deploy.log" total=0 spent=0 idx=0 count=${#STEPS[@]} entry name fn fallback est
  : >"$log"
  for entry in "${STEPS[@]}"; do
    IFS=: read -r name fn fallback <<<"$entry"
    total=$((total + $(estimate_for "$name" "$fallback")))
  done
  say "Deploying $(current_version) (estimated $(fmt_secs "$total"); log: $log)"
  local started_all interactive=0
  started_all="$(date +%s)"
  [ -t 1 ] && interactive=1

  for entry in "${STEPS[@]}"; do
    IFS=: read -r name fn fallback <<<"$entry"
    est="$(estimate_for "$name" "$fallback")"
    idx=$((idx + 1))
    local started pid elapsed
    started="$(date +%s)"
    ("$fn") >>"$log" 2>&1 &
    pid=$!
    [ "$interactive" = 1 ] || echo "[$idx/$count] $name (about $(fmt_secs "$est"))"
    while kill -0 "$pid" 2>/dev/null; do
      elapsed=$(($(date +%s) - started))
      # A step that runs past its estimate holds just under its share instead of overflowing.
      [ "$elapsed" -le "$est" ] || elapsed=$est
      [ "$interactive" = 0 ] || draw_bar $((spent + elapsed)) "$total" "$name" "$idx" "$count"
      sleep 1
    done
    if ! wait "$pid"; then
      [ "$interactive" = 0 ] || printf '\n'
      tail -25 "$log"
      die "'$name' failed. Full log: $log"
    fi
    elapsed=$(($(date +%s) - started))
    record_time "$name" "$elapsed"
    spent=$((spent + est))
  done
  [ "$interactive" = 0 ] || { draw_bar "$total" "$total" "done" "$count" "$count"; printf '\r\033[K'; }

  local count_apps
  count_apps="$(find /Applications -maxdepth 1 -name 'T3*.app' | wc -l | tr -d ' ')"
  echo "Done in $(fmt_secs $(($(date +%s) - started_all))). Installed $(current_version); T3 apps in /Applications: $count_apps."
  [ ! -e "$OUT/T3-old-nightly.app" ] || echo "Rollback copy: $OUT/T3-old-nightly.app (quit T3 and move it back into /Applications)."
}

# ---------------------------------------------------------------- main

[ $# -ge 1 ] || { sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 1; }
cmd="$1"; shift
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --no-fetch) NO_FETCH=1 ;;
    *) die "Unknown option: $arg" ;;
  esac
done

case "$cmd" in
  deploy) cmd_deploy ;;
  status) cmd_status ;;
  build) cmd_build ;;
  install) cmd_install ;;
  *) die "Unknown command '$cmd'. Use deploy, status, build, or install." ;;
esac
