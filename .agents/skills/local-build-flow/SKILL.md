---
name: local-build-flow
description: Build this fork's macOS desktop app and install it as the only T3 in /Applications. Run only when the user types /local-build-flow.
disable-model-invocation: true
---

# Local build flow

Builds the `mine` branch into `T3 Code (Nightly).app` and replaces the copy in
`/Applications`. Only the user starts this skill. By invoking it, the user
authorizes you to quit the running T3 and to do the build and install steps
below. That permission covers this flow only.

Do not use `dev:desktop` or any Electron dev run. It floods the Dock with
"T3 Code (Dev)" icons. If a dev run is somehow needed, confirm afterward that no
`electron-runtime` or `dev-electron` processes are left.

## 1. Check the tree

```bash
cd ~/Code/t3code && git status -s && git branch --show-current
```

Build from `mine` with everything committed. If there are uncommitted changes,
ask whether to commit them first. Run `vp run typecheck` before committing
anything (pre-commit also runs fmt, lint, and knip).

## 2. Build the DMG

Everything runs under Node 26 (system Node is older). Takes about 2 minutes, so
run it in the background and log to a file.

```bash
cd ~/Code/t3code && . ~/.config/vite-plus/env && vp env exec --node 26.12.1 bash -c \
  'env -u GITHUB_REPOSITORY -u T3CODE_DESKTOP_UPDATE_REPOSITORY \
   node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 \
   --build-version <VERSION> --output-dir ~/Code/T3ForkContainer/dist-dmg' \
  > /tmp/dmg-build.log 2>&1
```

- `<VERSION>` is the current upstream nightly version in the form
  `0.1.7-nightly.YYYYMMDD.NNNN`. Take it from the latest merged upstream nightly
  tag (`git describe --tags --match 'v*nightly*' mine`).
- Never set the update-repository variables. They create an `app-update.yml`,
  which makes the app try to self-update from upstream.
- The build needs a recent Rust toolchain (`rustup update stable` if Cargo
  complains about the 2024 edition).

## 3. Verify the build

Mount the DMG and check the app before installing:

```bash
hdiutil attach -nobrowse -readonly ~/Code/T3ForkContainer/dist-dmg/T3-Code-<VERSION>-arm64.dmg
APP="/Volumes/T3 Code (Nightly)*/T3 Code (Nightly).app"
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' $APP/Contents/Info.plist
ls $APP/Contents/Resources/app-update.yml   # must NOT exist
```

## 4. Install

Quit T3 (the user has authorized this by invoking the skill), then swap:

```bash
osascript -e 'tell application "T3 Code (Nightly)" to quit'   # wait until `pgrep -f "T3 Code (Nightly)"` is empty
rm -rf ~/Code/T3ForkContainer/T3-old-nightly.app             # keep only the latest rollback copy
mv "/Applications/T3 Code (Nightly).app" ~/Code/T3ForkContainer/T3-old-nightly.app
ditto "/Volumes/T3 Code (Nightly)"*/"T3 Code (Nightly).app" "/Applications/T3 Code (Nightly).app"
xattr -dr com.apple.quarantine "/Applications/T3 Code (Nightly).app"
hdiutil detach "/Volumes/T3 Code (Nightly)"*
open "/Applications/T3 Code (Nightly).app"
```

Confirm `/Applications` holds exactly one T3 app and the new one is running.
Do not touch `~/.t3`. A data backup from the first swap lives at
`~/.t3-backup-2026-11-02`; take a new one (`cp -Rp ~/.t3 ~/.t3-backup-<date>`)
only if a build changes stored data (database migrations).

## 5. Report

Say whether the app launched and the installed version. Mention the rollback
copy only if something went wrong. Rollback is: quit T3, then move
`~/Code/T3ForkContainer/T3-old-nightly.app` back into `/Applications`.
