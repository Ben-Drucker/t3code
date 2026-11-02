# MODS: Ben's fork ledger

Base: upstream `pingdotgg/t3code` nightly `v0.1.7-nightly.20261102.4093` (merged 2026-11-02, merge
commit `11b048da`). Fork branch: `mine` (= upstream + the mods below; `main` mirrors upstream).
`claude/t3code-mods` is the cloud session's original branch. No database migrations. No RPC changes
(one additive setting field, see mod 1).

The installed app is built from `mine` (unsigned, no `app-update.yml`, bundle id
`com.t3tools.t3code`, so it cannot replace itself with an upstream build). Build with
`GITHUB_REPOSITORY` and `T3CODE_DESKTOP_UPDATE_REPOSITORY` unset:
`node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 --build-version <upstream nightly version> --output-dir <dir>`
under Node 26 (about 2 minutes; needs a current Rust toolchain, `rustup update stable`).

Keep this list current on every weekly refresh. When a rebase conflicts, re-implement the mod from
its "Why" and "Where" rather than forcing the old diff.

## 1. Live streaming of reasoning and responses (toggle in the composer)

- Why: see reasoning, reasoning summaries and replies as they stream in, with a persistent global
  switch in the main chat UI (default on).
- Where:
  - `packages/contracts/src/settings.ts`: new global `ServerSettings.liveStreaming` (default `true`)
    and `ServerSettingsPatch.liveStreaming`. Deliberately NOT in the project-scoped key lists, so
    it is global.
  - `apps/server/src/orchestration-v2/assistantStreaming.ts`: `makeAssistantStreamingFilter` takes a
    third `live` argument. Live mode delivers the full partial text per streaming item, throttled to
    one update per 100 ms per item, whatever `responseStreamingMode` says. Exports
    `isStreamingTextEvent`.
  - `apps/server/src/orchestration-v2/RunExecutionService.ts`: reads `liveStreaming` per streaming
    text event (so toggling applies mid-run) and passes it to the filter.
  - `apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts` and
    `RunExecutionService.test.ts` (one test): `liveStreaming: false` so existing tests stay
    deterministic.
  - `apps/web/src/components/chat/LiveStreamingToggle.tsx` (new), `ComposerFooterControls.tsx`,
    `ChatComposer.tsx`: zap toggle in the composer footer, before the context meter.
  - `apps/web/src/components/chat/TimelineWorkEntryRow.tsx`: an in-progress reasoning row of the
    latest run auto-expands while live streaming is on, until the user toggles it themselves.
- Contract or migration impact: one additive optional settings field with a decoding default. Old
  clients ignore it; old servers drop it on patch.
- Conflict-prone: yes. `RunExecutionService.ts` and `assistantStreaming.ts` are hot upstream files;
  `ComposerFooterControls.tsx` and `TimelineWorkEntryRow.tsx` change often.
- Commit: `2d26eb1c`

## 2. Context meter updates after each step

- Why: the meter should move during a response, not only when it ends. Ben reported that Kimi's
  meter did not move during a multi-step think/tool/output block.
- Where:
  - Claude, Codex and generic ACP agents: no production change. They already publish usage per step
    (Claude `emitContextUsage`, Codex `thread/tokenUsage/updated`, ACP `usage_update`); a regression
    test locks the ACP behaviour in `AcpRegistryAdapterV2.test.ts` ("reports context usage after
    each usage update, before the turn ends").
  - Kimi: its ACP server drops the per-step status event, but Kimi Code 2.3.3 appends
    `token_counting.measured` records (`tokens` = current context size) and `llm.request` records
    (`modelAlias`) to `<KIMI_CODE_HOME or ~/.kimi-code>/sessions/<bucket>/session_<id>/agents/main/wire.jsonl`;
    the window size is `max_context_size` under `[models."<alias>"]` in `config.toml`. New optional
    flavor hook `pollContextUsage` in `packages/provider-acp/src/server/adapter.ts` polls once a
    second while a turn runs and feeds the same path as a real `usage_update`.
    `packages/provider-acp-registry/src/server/kimiSession.ts` implements the reader; `adapter.ts`
    there enables it for the `kimi` registry agent and for a local command named `kimi`
    (`isKimiAgent`). Tests: `kimiSession.test.ts` and "polls Kimi's session files..." in
    `AcpRegistryAdapterV2.test.ts`.
- Contract or migration impact: none. The flavor field is optional.
- Conflict-prone: low (new file plus one hook block in the ACP adapter turn start).
- Commits: `e12d7b7e` (test), `fb455282` (original Kimi 1.x polling), `cd0c91c7` (rewrite for Kimi
  Code 2.3.3), `3549a760` (a stray `.DS_Store` in `sessions/` made the lookup throw, and the reader's
  catch-all hid it: the meter never appeared until this fix)
- Verified live on this Mac (2026-11-02, Kimi Code 2.3.3 through a local `kimi acp` command): the
  stored thread usage and the meter read 48,845 of 262,144 tokens (19%). The ACP session id equals
  the session folder name (without the `session_` prefix). The old Kimi 1.x registry agent is not
  supported by the new reader.
- The meter itself is OFF by default upstream (`contextWindowMeterEnabled`; Settings, Chat). Turn it
  on to see anything.

## 3. Tasks tab in the right panel (agent todo list only)

- Why: a panel next to Browser showing the agent's todo list; never opens by itself.
- Where:
  - `apps/web/src/rightPanelStore.ts`: new singleton surface `{ id: "tasks", kind: "tasks" }`
    (`RIGHT_PANEL_KINDS`, `RightPanelSurface`, `singletonSurface`). Persisted-state version is
    unchanged; the kind is additive.
  - `apps/web/src/closedViewStore.ts`: validates the new kind so Reopen Closed View works.
  - `apps/web/src/components/RightPanelTabs.tsx`: optional `onAddTasks` prop, "Tasks" entry (shortcut
    K, `ListTodo` icon) in the add-tab menu and the empty state, title and icon.
  - `apps/web/src/components/chat/RightPanelSurfaceContent.tsx`, `useRightPanelActions.ts`,
    `ChatView.tsx`: render and wire it (offered only for server threads).
  - `apps/web/src/components/chat/TasksPanel.tsx` and `tasksPanel.logic.ts` (new): latest
    non-superseded `todo_list` plan, progress bar, step status icons, durations, explanation.
  - Tests: `tasksPanel.logic.test.ts`, `rightPanelStore.test.ts` ("opens Tasks only on request...").
- Contract or migration impact: none (reads existing `todo_list` plans).
- Conflict-prone: moderate. `RightPanelTabs.tsx` and `rightPanelStore.ts` get new surface kinds
  often; the Tasks entries are isolated blocks.
- Commit: `53e434c4`

## 4. Kimi quota in the Usage area

- Why: Kimi Code shows a weekly allowance and a rolling 5-hour window; show them like other
  providers' limits. Kimi is signed in through the CLI (`kimi login`).
- Where:
  - `packages/provider-acp-registry/src/server/kimiUsage.ts` (new): credential reader, request,
    defensive parser, probe. Never refreshes tokens.
  - `packages/provider-acp-registry/src/server/driver.ts`: for a Kimi agent (`isKimiAgent`: the
    `kimi` registry agent or a local command named `kimi`), `withKimiUsage` sets `usageLimits` as
    part of `checkProvider` (the readiness check). It must NOT be done in `enrichSnapshot`:
    `publishEnrichedSnapshot` in provider-core overwrites enrichment's `usageLimits` with the stored
    value, so the bars never arrive. The managed provider keeps the last good bars when a probe
    fails.
  - `packages/provider-acp-registry/src/server/kimiUsage.test.ts`: fixture mirrors a real response.
  - No web change: the Usage UI already renders `usageLimits` for any provider (grouped under "ACP
    Registry").
- Contract or migration impact: none.
- Conflict-prone: low for `kimiUsage.ts`; moderate for `driver.ts` (one helper plus one extra step in
  `checkProvider`).
- Commits: `5feea1b6` (original), `cd0c91c7` (Kimi Code 2.3.3 credentials and local command),
  `baa81dc3` (move into `checkProvider`)
- Verified live (2026-11-02): `GET https://api.kimi.com/coding/v1/usages` with the CLI's token returns
  `usage` (weekly) and `limits` (rolling 5-hour) blocks; the Usage page shows both bars. Credentials
  are `<KIMI_CODE_HOME or ~/.kimi-code>/credentials/kimi-code-env-*.json` (newest file with a token;
  `kimi-code.json` is a token-less stub). The token lives about 15 minutes and only the Kimi CLI
  refreshes it; T3 never does, so after a long idle the Usage area says the sign-in is stale until
  a Kimi command runs.

## 5. Claude todo tools stay on (needed by the Tasks tab)

- Why: Claude Code stopped offering its todo tools (TodoWrite/TaskCreate) on newer models, so the
  Tasks tab stayed empty for Claude.
- Where: `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` sets
  `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in the SDK environment (a user-set value wins). Test:
  "ClaudeAdapterV2 todo tools" in `ClaudeAdapterV2.test.ts`.
- Contract or migration impact: none.
- Conflict-prone: low (one environment entry).
- Commit: `6fc9c6b9` (the test fix for a missing `sensitive: false` landed in `cd0c91c7`)
- Verified live: the Tasks tab fills on Claude Haiku 5.5.
