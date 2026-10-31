# Handoff: personal T3 Code fork

Read `BACKGROUND.md` first. This file is the state of play and the runbook for the next agent.

## Status (2026-10-31)

- Research only. **No fork exists yet. No code has been changed.** Nothing has been built.
- Upstream was cloned shallowly in the planning session at `50c1c5d` and read, not run.
- Claims in `BACKGROUND.md` about the update feed and the app ID come from reading code. Treat them
  as likely correct but unverified until the first build is inspected.

## Planned mods

Ben's four requested changes are researched and planned in `FEATURES-AND-TWEAKS.md`: live
reasoning/response streaming with a toggle in the chat UI, a per-step context meter, a Tasks side
panel (the agent's todo list only), and Kimi quota in the Usage area. Ben's decisions (providers:
Claude, Codex, Antigravity, Kimi Code CLI) are at the top of that file. Start there after Phase 0.
Suggested order: streaming, context meter, Tasks panel, Kimi quota. The Kimi quota endpoint is
unofficial; do the credential investigation in that file before writing code.

## Phase 0: one-time setup (needs Ben on his Mac)

1. Fork `pingdotgg/t3code` to Ben's GitHub account (`gh repo fork pingdotgg/t3code --clone`).
   Add `upstream` as a remote. Ben's GitHub login in this repo is `Ben-Drucker`.
2. Branch layout:
   - `main`: clean mirror of upstream `main`. Never commit mods here.
   - `mine`: upstream plus Ben's mods. This is what gets built. One commit per mod where possible.
3. Install the toolchain (`vp`, Xcode CLT, Rust), then `vp i`.
4. Add `MODS.md` at the root of `mine` (the ledger, format below).
5. First build, before any mods, to prove the pipeline: build from the `mine` branch with no
   publish env vars set (`env -u GITHUB_REPOSITORY -u T3CODE_DESKTOP_UPDATE_REPOSITORY vp run dist:desktop:dmg`).
6. Inspect the built app before installing: the app bundle's `Contents/Resources/app-update.yml`
   should NOT exist (that file is the update feed config). `Info.plist` bundle id should be
   `com.t3tools.t3code`. Report both to Ben and fix `BACKGROUND.md` if either is wrong.
7. Swap-in, with Ben:
   1. Quit T3 Code. `cp -R ~/.t3 ~/.t3-backup-$(date +%F)`.
   2. If installed via Homebrew: `brew uninstall --cask t3-code`.
   3. Open the DMG, replace `/Applications/T3 Code.app`.
   4. First launch: right-click, Open (unsigned). Confirm existing projects and threads load and
      the updater shows as unavailable.

## Weekly update runbook

For the agent doing the weekly refresh. Keep each step reversible.

1. `git fetch upstream`. Pick the target: the commit of upstream's latest published **nightly**
   release (check the GitHub Releases page for `pingdotgg/t3code`, nightlies are prereleases; tag
   naming looked like `<version>-nightly.<date>.<run>` per `docs/operations/release.md`, verify).
   If unsure, use the tip of `upstream/main`. Record the choice.
2. Fast-forward `main` to the target.
3. Rebase `mine` onto `main` (preferred: keeps mods as a clean stack). Resolve conflicts by
   reading both sides; upstream's intent wins unless the mod's purpose is lost, in which case
   re-implement the mod on the new code rather than forcing the old diff. Update `MODS.md`.
4. `vp i`, then `vp run check:changed`, then the full `vp run typecheck` and `vp run test`
   (CI runs the full suites; `check:changed` only covers the diff). Fix or report failures. Never
   skip or disable a test to get green.
5. Look at the upstream diff for anything touching: persistence migrations, `packages/contracts`,
   `scripts/build-desktop-artifact.ts`, `apps/desktop/src/updates/`. Mention these in the summary
   for Ben, because they are where a fork breaks or silently re-enables updating.
6. Build the DMG on a Mac with no publish env vars. Re-run the Phase 0 step 6 inspection (no
   `app-update.yml`, bundle id unchanged).
7. Tag the result `mine/YYYY-MM-DD` and push `main`, `mine` and the tag to the fork.
8. Give Ben the DMG path and a short summary: what upstream changed, what conflicted, what was
   re-implemented, any new migrations. Ben does the install (quit, back up `~/.t3`, replace the
   app, relaunch).
9. Rollback: keep the previous DMG and `~/.t3` backup. A newer build may have migrated the
   database, so rolling back the app may also need restoring the backup (losing work since).

## `MODS.md` format

One entry per mod:

```
## <short name>
- Why: what Ben wanted
- Where: files / packages touched
- Contract or migration impact: none | describe
- Conflict-prone: yes/no and why
- Commit: <sha on mine>
```

Guidelines: keep mods small and isolated, prefer adding new files over editing hot ones, avoid RPC
contract changes and database migrations, and follow upstream's `AGENTS.md` conventions. A short
ledger is what lets a future agent re-apply a mod after a bad conflict.

## Safety rules inherited from upstream's `AGENTS.md`

- Never start a dev server against the live `~/.t3/userdata`, never open it read-write, never
  clean it up. To get test data, copy a snapshot or use `vp run migrate-dev-db`.
- The agent may itself be running inside T3 Code. Do not kill dev servers or processes you did not
  start.

## Not decided

- Nothing blocking in `FEATURES-AND-TWEAKS.md`. Remaining unknowns are technical (Kimi
  credential); see section 4.
- Whether to sign the build (default: no).
- Whether the weekly refresh is scheduled (e.g. a recurring task) or run on request.
- Whether to delete the old `claude/festive-mendel-aysofr` branch on `network-inventory` (it still
  exists on the remote after the rename).
