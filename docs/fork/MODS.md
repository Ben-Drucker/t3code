# MODS: Ben's fork ledger

Base: upstream `pingdotgg/t3code` nightly tag `v0.1.6-nightly.20261031.3969` == `main` tip
`e5909e53` (2026-10-31). Fork branch: `claude/t3code-mods` (one commit per mod below). No database
migrations. No RPC changes (one additive setting field, see mod 1).

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

- Why: the meter should move during a response, not only when it ends.
- Where: no production change. Reading the code showed Claude (`emitContextUsage` at
  `message_start`/`message_delta`), Codex (`thread/tokenUsage/updated`) and ACP agents
  (`usage_update` -> `provider_thread.updated`) already publish per step; the server forwards them
  unfiltered and the client recomputes on each projection change. Added a regression test that ACP
  usage surfaces before the turn terminal:
  `apps/server/src/orchestration-v2/Adapters/AcpRegistryAdapterV2.test.ts`
  ("reports context usage after each usage update, before the turn ends").
- Contract or migration impact: none.
- Conflict-prone: no (test only).
- Commit: `e12d7b7e`
- Open: whether the meter really lags on Claude, Codex or Antigravity is NOT reproduced (needs real
  providers on the Mac). Kimi's ACP server never sends `usage_update`, so its meter cannot move
  mid-response from T3's side. See CLOUD-HANDOFF.md.

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
  - `packages/provider-acp-registry/src/server/driver.ts`: for the `kimi` registry agent only,
    attach `usageLimits` to the enriched snapshot (`withKimiUsage`), keeping the last good bars when
    a probe fails (`resolveUsageLimitsAfterProbe`).
  - `packages/provider-acp-registry/src/server/kimiUsage.test.ts`: redacted-fixture tests.
  - No web change: the Usage UI already renders `usageLimits` for any provider.
- Contract or migration impact: none.
- Conflict-prone: low for `kimiUsage.ts`; moderate for `driver.ts` (one helper plus one changed
  `publishSnapshot` pipeline).
- Commit: `5feea1b6`
- UNVERIFIED: endpoint, credential file and response shape come from public CLI sources, not a live
  call. Isolated in `kimiUsage.ts`; see CLOUD-HANDOFF.md for the Mac checks.
