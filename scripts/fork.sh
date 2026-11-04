#!/usr/bin/env bash
# Personal-fork helper: set up a machine, show drift from upstream, build and install the macOS app.
#
#   scripts/fork.sh setup [--yes]     one-time machine setup (toolchains, remotes, dependencies)
#   scripts/fork.sh status [--no-fetch]  how far the fork is from pingdotgg/t3code
#   scripts/fork.sh build             build the DMG for the current checkout
#   scripts/fork.sh install           verify the DMG and swap it into /Applications
#   scripts/fork.sh deploy            build + install (the old /local-build-flow)
#
# Environment:
#   T3_FORK_OUT      where DMGs, logs and the rollback app go (default ~/Code/T3ForkContainer)
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
  [ -f "$VP_ENV" ] || die "Vite+ is not installed. Run: scripts/fork.sh setup"
  # shellcheck disable=SC1090
  . "$VP_ENV"
  (cd "$REPO" && vp env exec --node "$NODE_VERSION" bash -c "$1")
}

# ---------------------------------------------------------------- status

# Newest nightly version merged into this checkout, without the leading "v".
current_version() {
  local tag
  tag="$(git -C "$REPO" describe --tags --match 'v*nightly*' --abbrev=0 HEAD 2>/dev/null)" \
    || die "No nightly tag is reachable from HEAD. Run: scripts/fork.sh status"
  printf '%s' "${tag#v}"
}

cmd_status() {
  cd "$REPO"
  git remote get-url upstream >/dev/null 2>&1 || die "No 'upstream' remote. Run: scripts/fork.sh setup"
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

# ---------------------------------------------------------------- setup

ensure_remote() {
  if git -C "$REPO" remote get-url upstream >/dev/null 2>&1; then
    echo "upstream remote: $(git -C "$REPO" remote get-url upstream)"
  else
    git -C "$REPO" remote add upstream "$UPSTREAM_URL"
    echo "added upstream remote: $UPSTREAM_URL"
  fi
}

rust_ok() {
  command -v rustc >/dev/null 2>&1 || return 1
  local minor
  minor="$(rustc --version | sed -n 's/^rustc 1\.\([0-9]*\)\..*/\1/p')"
  # The 2024 edition needs Rust 1.85 or newer.
  [ -n "$minor" ] && [ "$minor" -ge 85 ]
}

cmd_setup() {
  [ "$(uname -s)" = Darwin ] || die "This script builds the macOS app and only runs on macOS."
  [ "$(uname -m)" = arm64 ] || echo "warning: the build targets Apple Silicon (arm64); this machine is $(uname -m)."

  say "Xcode command line tools"
  if xcode-select -p >/dev/null 2>&1; then
    echo "found at $(xcode-select -p)"
  else
    echo "Missing. Run 'xcode-select --install', finish the installer, then re-run setup."
    exit 1
  fi

  say "Rust (1.85 or newer)"
  if rust_ok; then
    rustc --version
  elif command -v rustup >/dev/null 2>&1; then
    confirm "Update Rust with rustup?" && rustup update stable
    rust_ok || die "Rust is still older than 1.85."
  else
    confirm "Install Rust with rustup?" || die "Rust is required for the desktop build."
    curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y
    # shellcheck disable=SC1091
    . "$HOME/.cargo/env"
  fi

  say "Vite+ (task runner and Node $NODE_VERSION manager)"
  if [ -f "$VP_ENV" ]; then
    echo "found $VP_ENV"
  else
    confirm "Install Vite+ from https://vite.plus?" || die "Vite+ is required."
    curl -fsSL https://vite.plus | bash
  fi
  [ -f "$VP_ENV" ] || die "Vite+ install did not create $VP_ENV. Open a new shell and re-run setup."

  say "Git remotes and tags"
  ensure_remote
  git -C "$REPO" fetch --quiet --tags upstream main
  git -C "$REPO" fetch --quiet --tags origin
  if [ "$(git -C "$REPO" branch --show-current)" != "$BRANCH" ]; then
    if git -C "$REPO" show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
      git -C "$REPO" switch "$BRANCH" 2>/dev/null || git -C "$REPO" switch --track "origin/$BRANCH"
    else
      echo "warning: origin has no '$BRANCH' branch; staying on $(git -C "$REPO" branch --show-current)."
    fi
  fi

  say "Dependencies (Node $NODE_VERSION)"
  in_node 'vp i'

  mkdir -p "$OUT"
  say "Ready"
  echo "Output directory: $OUT"
  cmd_status
  echo
  echo "Next: scripts/fork.sh deploy"
}

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
  say "Building $version (about 2 minutes, log: $log)"
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

  say "Verifying the build"
  mount="$(hdiutil attach -nobrowse -readonly "$dmg" 2>/dev/null | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -1)"
  [ -n "$mount" ] || die "Could not mount $dmg"
  built="$mount/$APP_NAME.app"
  trap 'hdiutil detach "$mount" -quiet >/dev/null 2>&1 || true' EXIT
  built_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$built/Contents/Info.plist")"
  [ "$built_version" = "$version" ] || die "DMG contains version $built_version, expected $version."
  [ ! -e "$built/Contents/Resources/app-update.yml" ] \
    || die "The build contains app-update.yml and would self-update from upstream. Rebuild without update variables."
  echo "version $built_version, no self-update config"

  say "Replacing $APP"
  if pgrep -f "$APP_NAME" >/dev/null 2>&1; then
    osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
    local waited=0
    while pgrep -f "$APP_NAME" >/dev/null 2>&1; do
      sleep 1
      waited=$((waited + 1))
      [ "$waited" -lt 30 ] || die "$APP_NAME is still running after 30 seconds. Quit it and re-run install."
    done
  fi
  rm -rf "$OUT/T3-old-nightly.app"
  [ ! -e "$APP" ] || mv "$APP" "$OUT/T3-old-nightly.app"
  ditto "$built" "$APP"
  xattr -dr com.apple.quarantine "$APP"
  hdiutil detach "$mount" -quiet >/dev/null 2>&1 || true
  trap - EXIT
  open "$APP"

  say "Done"
  local count
  count="$(find /Applications -maxdepth 1 -name 'T3*.app' | wc -l | tr -d ' ')"
  echo "Installed $version. T3 apps in /Applications: $count."
  [ ! -e "$OUT/T3-old-nightly.app" ] || echo "Rollback copy: $OUT/T3-old-nightly.app (quit T3 and move it back into /Applications)."
}

# ---------------------------------------------------------------- main

[ $# -ge 1 ] || { sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 1; }
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
  setup) cmd_setup ;;
  status) cmd_status ;;
  build) cmd_build ;;
  install) cmd_install ;;
  deploy) cmd_build && cmd_install ;;
  *) die "Unknown command '$cmd'. Use setup, status, build, install, or deploy." ;;
esac
