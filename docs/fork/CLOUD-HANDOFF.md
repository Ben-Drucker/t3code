# Cloud handoff: what the cloud session did, and what the Mac session must do

Written 2026-10-31 by the cloud session. Branch `claude/t3code-mods` on `Ben-Drucker/t3code`, based on upstream
nightly `v0.1.6-nightly.20261031.3969` (`main` @ `e5909e53`). Read `MODS.md` for the per-mod ledger
and `HANDOFF.md`/`BACKGROUND.md`/`FEATURES-AND-TWEAKS.md` for the original plan (those four plan
files are copies from the `network-inventory` repo; see "Corrections to the plan" below).

## Mac verification update (2026-11-02)

The Mac session ran everything below against real providers in an isolated dev state
(`~/.t3-fork-dev`, browser pane), then merged upstream nightly `0.1.7-nightly.20261102.4093` into
`mine` (`11b048da`) and installed an unsigned build as `/Applications/T3 Code (Nightly).app`.

| Mod              | Claude                           | Codex           | Antigravity | Kimi Code 2.3.3 (local `kimi acp`)         |
| ---------------- | -------------------------------- | --------------- | ----------- | ------------------------------------------ |
| 1 Live streaming | not judged for smoothness        | not judged      | not tested  | reasoning streams live                     |
| 2 Context meter  | stored per step; meter is opt-in | stored per step | not tested  | works after fix `3549a760` (19% in a turn) |
| 3 Tasks tab      | works (needs fix `6fc9c6b9`)     | works           | not tested  | todo/plan shows in the timeline            |
| 4 Kimi quota     | n/a                              | n/a             | n/a         | weekly and 5-hour bars after `baa81dc3`    |

Fixes found on the Mac: `6fc9c6b9` (Claude todo tools env var), `cd0c91c7` (Kimi Code 2.3.3 layout,
credentials, local command), `3549a760` (stray `.DS_Store` broke the Kimi session lookup silently),
`baa81dc3` (quota must be set in `checkProvider`, not enrichment). Details are in `MODS.md`.

Still open: Antigravity needs a sign-in and was not tested; streaming smoothness on Claude and Codex
and the 100 ms throttle are not judged; the meter's opt-in default means it looks "missing" on a
fresh profile; `ChatView.browser.test.tsx` and two `AcpRegistrySupport.test.ts` install tests
(5 s timeouts under load) were not compared against pristine upstream; the Kimi token is never
refreshed by T3 (stale message after idle). The old Kimi 1.x registry agent is not supported by the
new session reader. Dev-run hygiene: use the browser-pane dev server, never `dev:desktop` (stray
watchers relaunched "T3 Code (Dev)" apps and flooded the Dock, plus macOS 27 keeps a
background-task entry for them).

The rest of this file is the cloud session's original text; the Kimi paths below
(`~/.kimi/...`) are for Kimi 1.x and are superseded by `MODS.md`.

## Status per mod

| #   | Mod                              | Code                 | Verified in the cloud                                                                                    | NOT verified (Mac)                                                                              |
| --- | -------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | Live streaming + composer toggle | done                 | unit tests, typecheck, UI screenshots against the free Replay provider, toggle persistence across reload | real Claude/Codex/Antigravity/Kimi streaming feel; the 100 ms throttle under a real fast stream |
| 2   | Per-step context meter           | no production change | ACP per-update behaviour locked by a test; code audit of Claude/Codex                                    | whether the meter really lags on any real provider; Kimi sends no usage at all                  |
| 3   | Tasks tab (todo list only)       | done                 | unit + store tests, UI screenshots (Replay `showcase` has a todo list), confirmed it does NOT auto-open  | real providers' todo lists (Claude `TodoWrite`, Codex plan, Antigravity, Kimi)                  |
| 4   | Kimi quota                       | done, unverified     | parser/probe tests with redacted fixtures                                                                | the live endpoint, credential file and response shape: everything about it                      |

Screenshots (all from `vp run dev` + the `Replay (dev)` provider, `showcase` scenario) are in
`docs/fork/screenshots/`:

- `01-composer-live-streaming-toggle-on.png`: zap toggle in the composer footer.
- `02-right-panel-add-menu-tasks-not-auto-opened.png`: a thread with a todo list, panel opened by
  hand: it is empty and "Tasks" (K) is only an option in the menu.
- `03-tasks-panel-todo-list.png`: the Tasks tab (1/3 done, one running, durations).
- `04-live-streaming-toggle-tooltip.png`, `05-live-streaming-toggle-off.png`: on/off states.

## Commands that passed (cloud, Node 22.23.4, see environment caveats)

Run from the repo root after `. ~/.config/vite-plus/env`:

```bash
vp run typecheck        # all 39 tasks
vp lint                 # 0 errors (pre-existing warnings only)
vp fmt --check
vp run knip:check
vp run check:changed    # format, lint, knip, graphql, typecheck, react compiler pass; test see below
vp test run src/orchestration-v2/assistantStreaming.test.ts            # in apps/server, 7 new tests
vp test run src/orchestration-v2/Adapters/AcpRegistryAdapterV2.test.ts # in apps/server
vp test run src/server                                                  # in packages/provider-acp-registry, 71 tests
vp test run src/rightPanelStore.test.ts src/closedViewStore.test.ts src/components/chat/tasksPanel.logic.test.ts  # in apps/web
```

Full per-package test results: see "Full test results" at the bottom.

## Known failures that are NOT from these changes

- `apps/web` `src/components/ChatView.browser.test.tsx` > "a new draft does not load its reserved
  thread before the server lists it" times out (15 s) in this container. Reproduced on pristine
  upstream `e5909e53` with none of these commits, so it is environmental (headless browser in the
  container). Re-run it on the Mac.
- `infra/task-cache` `src/Cleanup.test.ts` "cleans three full disjoint batches..." fails on
  `NOT NULL constraint failed: maintenance.secondary_key`. Vendored infra code, unrelated, and the
  container's SQLite is Node 22's ("Node SQLite lacks transaction-state or statement-authorizer
  support" also shows in the server log).

## Environment caveats of the cloud session

- Node was 22.23.4, not the pinned Node 26. Server SQLite warned about missing checkpoint-worker
  support. Re-run `vp run typecheck` and the server tests under the pinned Node on the Mac.
- The browser tests wanted `chromium_headless_shell-1223` but only `-1243` is installed; I
  symlinked it inside the container (outside the repo, nothing to commit).
- The dev server stored its state in the container's `~/.t3/dev`; nothing from it is committed.

## Mac session checklist (per feature, per provider)

Do these with `vp run dev:desktop` (or the built DMG) and the real CLIs signed in. Use the cheapest
model of each provider.

### 1. Live streaming

For each of Claude, Codex, Antigravity, Kimi:

1. New thread, ask for something that makes the model think and write a few paragraphs.
2. Toggle ON (default): reasoning text and the reply grow continuously while the turn runs; the
   in-progress reasoning row expands by itself; finishing leaves a normal collapsed row.
3. Toggle OFF (zap-off icon): behaviour returns to upstream (`responseStreamingMode`, default
   paragraph mode: finished paragraphs only). Toggle mid-run and confirm it applies to the next
   update. Quit and relaunch: the choice persists.
4. Watch for flicker, jank, or the throttle (100 ms floor in `LIVE_STREAMING_MIN_INTERVAL_MS`) feeling
   laggy. If a provider only emits reasoning as one block, that is the provider, not the toggle.
5. Reasoning _summaries_ (Codex) and Claude thinking blocks both go through the same reasoning item.

### 2. Context meter

For each provider, watch the meter in the composer footer during a multi-step turn (several tool
calls). Expected: Claude moves at each model step, Codex on each token-usage tick, Antigravity per
`usage_update` if the agent sends them. Record which ones lag. Facts established in the cloud:

- Claude adapter emits `provider_turn.updated` with `tokenUsage` at `message_start` and
  `message_delta` for every model request. Codex emits on `thread/tokenUsage/updated`.
- ACP adapter (Antigravity, Kimi) emits `provider_thread.updated` with `contextUsage` on each
  `usage_update` and never sets `providerTurn.tokenUsage`.
- The web meter prefers any provider-turn `tokenUsage` over `providerThread.contextUsage`
  (`apps/web/src/lib/contextWindow.ts`), by design. Do not "fix" that without a repro: after a
  compaction an ACP adapter clears `contextUsage` and a lingering turn value would go stale.
- Kimi: its ACP server drops the per-step status event (`StatusUpdate`), so the ACP stream has no
  usage. Fork fix: poll the CLI's own session files while a turn runs (`kimiSession.ts`). Verify on
  the Mac, with a Kimi turn that thinks and calls tools:
  1. `ls ~/.kimi/sessions/*/` shows a directory per session; the newest `context.jsonl` gets a
     `{"role":"_usage","token_count":N}` line after each model step (`tail -f` it during a turn).
  2. `wire.jsonl` lines contain `context_tokens` and `max_context_tokens` somewhere in the record.
  3. (Layout and record shapes are already confirmed from real files.) The ACP session id T3 uses equals that session directory name. If not, the reader finds
     nothing and the meter behaves as before: log the id (ACP native logger) and fix `locate()`.
  4. The meter in T3 then moves about once a second during the block and shows the window size.
     The reader never throws; if any assumption is wrong it just yields no reading.

### 3. Tasks tab

1. Open a thread, open the right panel's "+" menu: "Tasks" (K) must be listed; the panel must not
   open by itself when the agent writes its todo list.
2. Ask each provider to plan a multi-step job. Claude `TodoWrite`, Codex plan, Antigravity and Kimi
   plans should appear as steps; running steps spin, completed steps strike through.
3. Close it, `Reopen closed view` (shortcut) brings it back. Quit and relaunch: the tab persists
   per thread.
4. Only the agent's todo list is shown (not proposed plans). Confirm that is what Ben wants for
   Codex plan-mode output (which is a `proposed_plan`, deliberately excluded).

### 4. Kimi quota (all of it unverified)

Run these on the Mac, signed in with the Kimi CLI, before trusting the code:

1. `ls ~/.kimi/credentials/` and `cat ~/.kimi/credentials/kimi-code.json | python3 -c 'import json,sys; d=json.load(sys.stdin); print({k:(type(v).__name__) for k,v in d.items()})'` (do NOT print token values). Confirm the file exists and has `access_token`. If the layout differs, fix `parseKimiCredentials` / `resolveKimiCredentialsPath` in `packages/provider-acp-registry/src/server/kimiUsage.ts`.
2. Call the endpoint by hand, in a shell where you read the token yourself (never paste it into a chat):
   `curl -s -H "Authorization: Bearer $(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.kimi/credentials/kimi-code.json")))["access_token"])')" https://api.kimi.com/coding/v1/usages | python3 -m json.tool`.
   Compare the shape with the fixture in `kimiUsage.test.ts` (`USAGES_FIXTURE`) and adjust
   `parseKimiUsagePayload` plus the fixture.
3. If the OAuth token is short-lived and often expired, the Usage area will say "Kimi sign-in
   expired. Run `kimi login`..." until a Kimi command refreshes it. T3 never refreshes it. Decide
   whether that is acceptable; the alternatives are shelling out to a CLI command that refreshes
   the token, or using an API key (Ben thinks Kimi has a coding-plan API; not investigated).
4. In the app: Settings > Providers: add the Kimi ACP registry agent (agent id must be `kimi`,
   which is what `KIMI_REGISTRY_AGENT_ID` matches). Open the Usage area: weekly and 5-hour bars with
   reset times. A local-command (non-registry) Kimi instance gets no quota, by design.
5. The quota is read each time the provider snapshot is enriched, not on a timer of its own.
   Check it refreshes often enough; if not, add a short TTL probe in `driver.ts`.

## Risks for the weekly rebase

- `RunExecutionService.ts` is hot upstream. If the streaming filter call moves, keep the per-event
  `liveStreaming` read and the third argument.
- `driver.ts` (ACP registry) `enrichSnapshot` pipeline: the Kimi hook wraps `publishSnapshot` input.
- A new upstream setting with the same name would collide with `liveStreaming`.
- The rightPanelStore persisted-state version is unchanged on purpose (additive kind). If upstream
  bumps it and changes the surface validation, re-check that `"tasks"` survives migration.
- No migrations were added. Keep it that way.

## Corrections to the plan files

- `FEATURES-AND-TWEAKS.md` section 2 (context meter): the suspected cause, a stale previous-turn
  `tokenUsage` winning over a fresher ACP `contextUsage`, is wrong for ACP because the ACP adapter
  never sets `providerTurn.tokenUsage`. Claude and Codex already emit per step. See above.
- Section 4 (Kimi): the endpoint and credential details were gathered from public CLI sources
  by a research subagent, not from a live account. Treat as hypotheses.
- Fork branch name: the plan said `mine`; this session used `claude/t3code-mods` because the task
  designated no branch. Rename or fast-forward `mine` from it as you prefer.

## Optional follow-ups not done

- A Settings page row for `liveStreaming` (the composer toggle is the only control) and its
  `settingsSearch` entry.
- A browser test for `LiveStreamingToggle` and `TasksPanel` components (covered by logic tests and
  the Replay screenshots only).
- `Tasks` command-palette entry.
