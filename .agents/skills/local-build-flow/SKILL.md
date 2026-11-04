---
name: local-build-flow
description: Build this fork's macOS desktop app and install it as the only T3 in /Applications. Run only when the user types /local-build-flow.
disable-model-invocation: true
---

# Local build flow

The flow lives in `scripts/fork.sh`. By invoking this skill, the user authorizes
you to quit the running T3 and to build and install. That permission covers this
flow only.

Do not use `dev:desktop` or any Electron dev run. It floods the Dock with
"T3 Code (Dev)" icons.

1. Run `scripts/fork.sh status` and note the drift from upstream.
2. If `git status -s` shows changes, ask whether to commit them first. Run
   `vp run typecheck` before committing (pre-commit also runs fmt, lint, knip).
3. Run `scripts/fork.sh deploy` in the background (about 2 minutes). It builds the
   DMG, checks the version and that no `app-update.yml` is inside, quits T3, swaps
   the app into `/Applications`, and relaunches it. Its build log is
   `$T3_FORK_OUT/build.log`.
4. Report whether the app launched and the installed version. Mention the
   rollback copy only if something went wrong.

On a new machine, run `scripts/fork.sh setup` first. Do not touch `~/.t3`. Take a
backup (`cp -Rp ~/.t3 ~/.t3-backup-<date>`) only if a build changes stored data.
