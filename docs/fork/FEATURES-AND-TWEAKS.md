# Features and tweaks to implement in the fork

Written 2026-10-31 against upstream `pingdotgg/t3code` at `50c1c5d` (v0.1.5). Paths are relative to
the upstream repo root; line numbers are approximate and will drift, so grep for the symbol names.
Read `BACKGROUND.md` and `HANDOFF.md` first (build, branch layout, `MODS.md` ledger, weekly merge).

Everything below came from reading the code (and, for Kimi, third-party docs). **Nothing has been
run or confirmed in the app.** Each section separates what was read from what is a hypothesis.
Verify hypotheses before building on them.

## Ben's decisions

- Providers used: **Claude, OpenAI Codex, Google Antigravity, Kimi Code CLI.**
- Tasks panel: show **the todo list the agent makes, only** (not background tasks, scheduled
  tasks, or subagents).
- Kimi usage: **quota** (remaining allowance and reset times), not token/cost history.
- Live streaming: **toggleable right in the main chat UI**. It is a **global** (per-environment)
  setting that persists across sessions, not a per-project override. Default on.
- Tasks panel: **does not open automatically.** The user opens it from the tab menu.
- Kimi sign-in: **the Kimi CLI login** (not an API key). Kimi also offers API keys for the coding
  plan, but Ben is not sure they are needed; treat an API key as a fallback only if the CLI's
  login credential cannot call the quota endpoint.

## Suggested order

1. Live reasoning/response streaming with a toggle in the chat UI (small).
2. Context meter updates per step (probably small; start by reproducing).
3. Tasks side panel for the todo list (small to medium; new right-panel kind).
4. Kimi quota in the Usage area (medium; needs a credential investigation first).

Do one feature per commit (or small commit series) on `mine`, and add a `MODS.md` entry for each.

## Shared conventions

- Follow upstream `AGENTS.md`: performance matters (avoid sending more data over websockets, avoid
  re-render storms), and persisted events must stay decodable on replay.
- **Prefer a new optional settings key over widening an existing enum.** An older client (the
  mobile apps, `app.t3.codes`) talking to the fork's server might fail to decode an unknown enum
  literal. An extra optional key is more likely to be ignored. This is an inference from how the
  schemas are written, not tested; check with a quick decode test if a contract changes.
- Avoid database migrations. Avoid changing RPC shapes in `packages/contracts/src/rpc.ts`.
- Run `vp run check:changed` per feature, and the full typecheck and tests before each weekly build.

---

## 1. See reasoning, responses and reasoning summaries as they stream (with a chat-UI toggle)

### What the code does today (read)

Text reaches the screen through several layers, and the middle one is what hides it:

1. **Adapters** coalesce provider deltas. `apps/server/src/orchestration-v2/Adapters/ProviderTextDeltaCoalescer.ts`
   with a flush interval of 50 ms in `ClaudeAdapterV2.ts` (`flushIntervalMs: 50`, around the
   `reasoningDeltas` setup) and `CODEX_ASSISTANT_DELTA_FLUSH_INTERVAL_MS` in `CodexAdapterV2.ts`.
   Fast enough. Claude reasoning comes from `thinking_delta`; Codex from
   `item/reasoning/summaryTextDelta` and `item/reasoning/textDelta`. The ACP adapter (Antigravity,
   Kimi) declares `streamsReasoning: true` too.
2. **`makeAssistantStreamingFilter`** in `apps/server/src/orchestration-v2/assistantStreaming.ts`,
   created in `RunExecutionService.ts` (`filterAssistantEvent`). It applies to **both**
   `assistant_message` and `reasoning` items while they stream:
   - mode `turn`: drops every in-progress update; text appears when the turn finishes.
   - mode `paragraph` (the default): emits only text up to the last complete paragraph, list item or
     closed code fence (`splitBufferedAssistantText`), and at most once per 400 ms per item.
     So mid-paragraph text is deliberately withheld. This is almost certainly why streaming looks
     chunky or late.
3. **`ThreadLiveEventCoalescer.ts`** collapses updates for the same running item inside a 50 ms
   window. Harmless; keep it.
4. **Web**: `ReasoningTraceContent` and `ChatMarkdown` (`isStreaming`, `markdown-incremental.ts`)
   in `apps/web/src/components/chat/TimelineWorkEntryRow.tsx`. A reasoning row that is not
   expanded shows only a one-line inline preview of `workEntry.detail`. The full text, with
   `WorkLogDetails followLive`, shows only when the row is expanded.

The existing setting is `responseStreamingMode` in `packages/contracts/src/settings.ts` (literals
`"turn" | "paragraph"`, default `"paragraph"`, also a project-overridable key). It is edited only in
Settings (`apps/web/src/components/settings/SettingsPanels.tsx`, `RESPONSE_STREAMING_MODE_LABELS`;
mobile: `SettingsServerControlsRouteScreen.tsx`). The server reads it **once, at run preparation**
(`RunExecutionService.ts`, where `responseStreamingMode` is resolved through
`resolveProjectSettings`), so a change applies from the next run.

### Plan

1. **Setting.** Add a new optional boolean server setting (working name `liveStreaming`) next to
   `responseStreamingMode` in `packages/contracts/src/settings.ts`, with default `true`. Global only: do
   **not** add it to the project-scoped override lists next to `responseStreamingMode`. When true, the filter returns events
   unchanged (optionally floor at ~50 ms). A boolean avoids touching the existing enum.
2. **Apply immediately, not next run (optional but nice for a toggle).** Because the mode is read
   once per run, a mid-run click would do nothing visible. Either re-read the setting per event in
   `filterAssistantEvent` (cheap if cached in a `Ref` refreshed from the settings stream) or accept
   next-run and say so in the tooltip. Recommended: re-read, so the toggle feels instant.
3. **Toggle in the main chat UI.** Put a small icon button in the composer footer next to the
   Plan/Build toggle: `apps/web/src/components/chat/ComposerFooterControls.tsx`, copy the
   `interactionModeToggle` pattern (`Tooltip` + `aria-pressed` button). Write the value with
   `useUpdateEnvironmentSettings(environmentId)` from `apps/web/src/hooks/useSettings.ts`, using the
   active thread's environment; read it with the existing settings hooks. Handle the failure toast
   path that hook already has. Web and desktop only. The toggle writes the global environment setting (decided), so it persists
   and applies to all projects on that environment.
4. **Show live reasoning without a click.** Default the active reasoning row to expanded while
   `toolLifecycleStatus === "inProgress"` (in `TimelineWorkEntryRow.tsx`) or render the live text
   under the "Thinking" label; collapse when the item completes. Make this follow the same toggle.
5. Settings page: show the new toggle there too (and in `settingsSearch.ts`), or leave a note that
   the chat toggle is the control. Keep the old "Response streaming" setting working underneath.

### Risks and checks

- **Half-formed Markdown.** Raw streaming can flicker (open code fences, partial list markers,
  headings). `splitBufferedAssistantText` exists to avoid this. Test `ChatMarkdown` with raw
  prefixes: stream a fenced block, a list, a table and a heading. If it is bad, keep the paragraph
  logic for committed text and append the in-flight partial line as plain text.
- **Performance.** Per-token updates multiply re-renders. Use
  `docs/internals/performance-regressions.md` and `vp run report:renders` before and after.
- **What providers actually send.** Some models return summarized or no thinking text (Codex gives a
  summary stream; Claude may hide or summarize thinking depending on model and options; Kimi and
  Antigravity go through ACP `agent_thought_chunk`). Confirm with a real run on each provider before
  blaming the filter.
- Tests: `assistantStreaming.test.ts` exists; add cases for the live path. A browser test for the
  toggle. Use the `Replay (dev)` provider (`vp run dev`) to watch streaming without a paid model.

---

## 2. Context usage meter updates after every step, not at the end of the response

### What the code does today (read)

The meter is `apps/web/src/components/chat/ContextWindowMeter.tsx`, fed by
`deriveLatestContextWindowSnapshot` in `apps/web/src/lib/contextWindow.ts`, called from
`ChatView.tsx` (`activeContextWindow`). That function takes two sources and **prefers the first**:

1. `liveUsage` = `latestProviderTurnTokenUsage(serverProjection.providerTurns, ...)`, the newest
   `tokenUsage` found on any provider turn.
2. `providerThread.contextUsage`, only if (1) is null.

How each of Ben's providers feeds them:

- **Claude** (`ClaudeAdapterV2.ts`, `emitContextUsage`): emits `provider_turn.updated` with
  `tokenUsage` at `message_start` and `message_delta` of every streamed message, so it should
  already update per step.
- **Codex** (`CodexAdapterV2.ts`, handler for `thread/tokenUsage/updated`): emits
  `provider_turn.updated` with `tokenUsage` on each notification. Should also be per step.
- **Antigravity and Kimi** both run on the shared ACP adapter (`packages/provider-acp/src/server/adapter.ts`;
  Antigravity is a thin flavor over it, Kimi is a generic ACP Registry agent). On `usage_update` it
  stores `contextUsage` and emits `provider_thread.updated`. It does **not** emit a turn-level
  `tokenUsage` mid-turn; the per-turn figure (`acpPerTurnPromptUsage`) arrives at turn completion.

### Hypothesis (not verified)

On the ACP providers, after the first completed turn the previous turn's `tokenUsage` exists, so
source (1) is always non-null. During the next turn the fresher `providerThread.contextUsage` is
ignored until the turn completes and writes a new `tokenUsage`. That matches "updates only at the
end of the user's response". Claude and Codex may already be fine. One fix in the ACP adapter would
cover both Antigravity and Kimi.

### Plan

1. **Reproduce first**, on each of the four providers: run a multi-tool turn and watch the meter;
   if possible capture the live events (`provider_turn.updated` vs `provider_thread.updated`) to see
   which arrive mid-turn. Record findings in the commit message and `MODS.md`.
2. If the hypothesis holds, fix at the source in the ACP adapter: on each `usage_update` also emit
   `provider_turn.updated` with a `tokenUsage` built from the same usage (mirroring Claude's and
   Codex's shape, status `running`). This keeps the web unchanged and makes all adapters consistent.
   Check `ProviderEventIngestor.ts` (`case "provider_turn.updated"`) accepts it and that
   `ThreadLiveEventCoalescer` does not drop it (provider-turn events are not coalesced today).
3. Optional web-side fallback in `deriveLatestContextWindowSnapshot`: choose the newer of the two
   sources. `providerThread.updatedAt` changes for other reasons, so only do this if a dedicated
   timestamp is available.
4. If Claude or Codex also lag in the reproduction, trace them separately; the adapter code above
   suggests they should not.

Checks: unit tests for `deriveLatestContextWindowSnapshot` precedence (`contextWindow.test.ts`
exists); a replay fixture or adapter test that asserts a mid-turn usage update reaches the
projection.

---

## 3. "Tasks" panel in the right-hand side panel (the agent's todo list)

### What the code does today (read)

**Data.** The todo list is a plan artifact with `kind: "todo_list"` and `steps`
(`OrchestrationV2PlanStep` in `packages/contracts/src/orchestrationV2.ts`: `id`, `text`,
`status` of `pending | running | completed`, optional `durationMs`/`durationAnchorAt`, plus an
optional `explanation`). All of Ben's providers produce it: Claude (`ClaudeAdapterV2.ts`, todo
handling around the `kind: "todo_list"` constructors), Codex (`CodexAdapterV2.ts` plan updates),
and the ACP adapter (`emitsTodoList: true`; `plan.updated` events, `adapter.ts` ~4049-4071, which
covers Antigravity and Kimi). Step durations are computed server-side in
`ProviderEventIngestor.ts` (`withPlanStepDurations`). The projection keeps the latest
non-superseded todo list per thread (`ProjectionStore.ts`, queries on `plan.kind = 'todo_list'`).

**Today's UI.** The list shows up only as a timeline row summarized like `Tasks 2/5 · <current step>`
(`apps/web/src/session-logic.ts`, `case "todo_list"`) and as raw text in `V2ItemInspector.tsx`.
There is no panel that shows the whole list persistently.

**The side panel.** Surfaces are tabs; Browser is `kind: "preview"`. Relevant files:

- `apps/web/src/rightPanelStore.ts`: `RIGHT_PANEL_KINDS`, the `RightPanelSurface` union, and the
  persisted zustand store. Singleton surfaces like Diff are `{ id: "diff", kind: "diff" }`; copy
  that shape for `{ id: "tasks", kind: "tasks" }`.
- `apps/web/src/components/RightPanelTabs.tsx`: tab rendering plus the "+" menu; switches on
  `surface.kind` in a few places (look near the `"side-chat"` cases).
- `apps/web/src/components/chat/RightPanelSurfaceContent.tsx`: renders the body per kind and passes
  `threadRef` to panels such as `ThreadPullRequestsPanel`.
- Also touched per kind: `closedViewStore.ts`, `reopenClosedView.ts`,
  `hooks/useRightPanelSurfaceClose.ts`, and tests (`RightPanelTabs.test.tsx`, store tests).
  Adding `"tasks"` to `RIGHT_PANEL_KINDS` should make TypeScript flag the exhaustive switches.

### Plan

1. Add the `tasks` kind to the store and wire a singleton open/close action (see how Diff opens).
2. Add a tab icon/label ("Tasks", the `list-todo` icon is already used for todo rows) and a "+"
   menu entry in `RightPanelTabs.tsx`.
3. Build `TasksPanel.tsx` in `apps/web/src/components/chat/`. Read the latest non-superseded
   `todo_list` item for the thread from the same projection `ChatView` uses (`serverProjection` /
   `serverVisibleTurnItems`; use the hooks `ThreadDetailsPanel.tsx` uses). Render: a progress header
   (`done/total`), the steps with a status icon (pending, running, completed) and `durationMs` when
   present, and the `explanation` if any. Add an empty state ("No task list yet"). Optionally keep
   earlier lists from the same thread in a collapsed history.
4. Keep renders cheap: memoized selector on the single todo item; the list changes often while the
   agent works.
5. Persisted state: confirm an old persisted blob without `tasks` loads, and that a blob containing
   `tasks` does not crash if the fork is later reverted.
6. Do **not** auto-open the panel (decided). Optional: a keybinding/command-palette entry
   (`keybindings.ts`, `docs/user/keybindings.md`) so it is quick to open.
7. Web and desktop only; skip mobile.

Out of scope (Ben's call): background tasks, scheduled tasks, subagents, cross-thread task views.

Checks: browser test for the panel (`*.browser.test.tsx` runs in headless Chromium); existing
right-panel tests; a replay run with the `todo_list` fixture in the dev replay agent
(`apps/server/scripts/dev-replay-agent.ts`) to see the panel update live.

---

## 4. Kimi quota in the Usage area

### What the code does today (read)

- **Kimi is only an ACP Registry agent** in T3 Code (`packages/provider-acp-registry`); it has no
  dedicated driver or usage code.
- The Usage page shows **limits** from `usageLimits` on each provider's status
  (`ServerProviderUsageLimits`, `packages/contracts/src/providerUsageLimits.ts`):
  `checkedAt`, `windows[]` and an optional `unavailable` marker. A window is
  `{ id, kind: "session" | "weekly" | "monthly" | "other", label, usedPercent (0-100), resetsAt?,
  windowDurationMins? }`. Other providers fill it with a probe (Antigravity: `probeUsage` in
  `apps/server/src/provider/AntigravityProvider.ts` with `resolveUsageLimitsAfterProbe` from
  `@t3tools/provider-core/server/usageLimits`; also Codex/Claude drivers). Bars are rendered by
  `apps/web/src/components/usage/UsageLimits.tsx`, which keys colors/visibility off
  `PROVIDER_PRESENTATION[...].driverKind` in `usageProviders.ts`.
- The ACP Registry driver builds the provider snapshot in
  `packages/provider-acp-registry/src/server/driver.ts` (uses `makeManagedServerProvider`), and it
  already has per-agent helper files (`devinAcp.ts`, `droidAcp.ts`, `claudeAcp.ts`). A
  `kimiUsage.ts` there follows the existing precedent. Nothing in that package sets `usageLimits`
  today, so the plumbing from the driver snapshot to the Usage page needs to be traced.

### What Kimi exposes (from third-party sources; **unofficial, unverified**)

Reverse-engineered by the Rust crate `quotas` (docs captured July 2026; confirmed by reading its
`kimi.md` and `kimi.rs`):
[docs-usage/kimi.md](https://docs.rs/crate/quotas/latest/source/docs-usage/kimi.md),
[src/providers/kimi.rs](https://docs.rs/crate/quotas/latest/source/src/providers/kimi.rs).

- Request: `GET https://api.kimi.com/coding/v1/usages`, header `Authorization: Bearer <key>`, no
  body. The base URL is overridable in the Kimi CLI by an environment variable (name not
  confirmed).
- Response, as parsed by that crate:
  - Weekly window: object `usage` with `limit`, `remaining`, `resetTime` (ISO 8601 UTC). `used` is
    derived as `limit - remaining`.
  - 5-hour window: an entry of `limits[]` whose `window` has `duration: 300` and
    `timeUnit: "TIME_UNIT_MINUTE"`; its `detail` holds `limit`, `remaining`, `resetTime`.
  - Numbers may arrive as strings (`"100"`). Units are not stated (likely tokens or requests).
  - Reset field names seen: `reset_at`, `resetTime`, `resetAt`. Also a `parallel.limit` (concurrency)
    and a `totalQuota` object that the crate treats as unreliable.
- Official docs only say quota refreshes every 7 days from the subscription date, unused quota does
  not roll over, and the CLI has a `/usage` command:
  <https://www.kimi.com/code/docs/en/kimi-code/membership.html>.
- The endpoint is **not documented by Kimi** and may change. The crate's confidence is "medium".

Mapping to T3's window shape: 5 h window -> `{ id: "kimi-session", kind: "session",
windowDurationMins: 300 }`; weekly -> `{ id: "kimi-weekly", kind: "weekly",
windowDurationMins: 10080 }`; `usedPercent = (limit - remaining) / limit * 100`, clamped to 0-100;
`resetsAt` from `resetTime`.

### Unknowns (resolve first, on Ben's Mac)

1. **Where does the Kimi CLI keep its login credential, and what is it?** Look at the Kimi CLI's
   config and login files (probably under `~/.kimi/`; unverified) and its source on GitHub. The
   crate examples use an `sk-kimi-*` API key; it is unknown whether the login token the CLI stores
   is accepted by `/usages` (the crate itself lists this as an open question). Ben uses CLI login.
2. Run the CLI's `/usage` command and compare its numbers with the endpoint response to confirm
   field meanings and units.
3. Whether the response shape has changed since July 2026.

### Plan

1. Investigate the unknowns above and write the confirmed request/response and credential source
   into this file. Ben signs in with the **Kimi CLI login**, so the first thing to test is whether
   the token the CLI stores works as the Bearer token for `/usages` (try it with `curl` on his
   Mac; never paste the token into logs, commits or this repo). Do not proceed to code if the CLI's
   credential cannot be read safely.
   - If the CLI token works: read it from the CLI's own credential store at probe time (do not copy
     it into T3 settings), and handle expiry (the CLI may refresh it; re-read on each probe, treat
     401 as `unavailable`).
   - If it does not work: fall back to an optional API key setting (a secret field like
     `managementKey` in `UsageLimitSourceConfig`, using `secretSetting` in
     `packages/contracts/src/settings.ts`) that Ben creates from his Kimi coding-plan console. Only
     build this if needed.
2. Implement the probe as an isolated module (for example
   `packages/provider-acp-registry/src/server/kimiUsage.ts`): read the credential on the server
   only, call the endpoint with a short timeout, parse defensively (strings or numbers, missing
   windows), map to `ServerProviderUsageLimits`. Never log the token. On failure return
   `unavailable: { reason: "probeFailed" }` and keep the last good bars
   (`resolveUsageLimitsAfterProbe`).
3. Hook it into the ACP Registry driver snapshot for the registry id `kimi` only, on the same
   background refresh cadence the other providers use (respect `BackgroundPolicy` and the
   existing "no heavy probes in background status checks" rule in
   `docs/internals/adding-a-provider.md`).
4. Make the Usage page show it: check how `UsageLimits.tsx` labels and colors a registry-agent
   instance (its driver kind is the registry driver, not "kimi") and add a Kimi label/color if
   needed. Prefer a small special case keyed on the registry agent id over editing
   `UsageProviderKind` (that enum drives the token-history half, which is not wanted).
5. Document in `docs/user/usage.md` (fork note) and `MODS.md`, including that the endpoint is
   unofficial and may break.

Checks: unit tests for the parser with captured, redacted responses (both string and number
forms); confirm bars appear and reset times look right against `/usage`; confirm an unauthenticated
or offline Kimi shows an `unavailable` state rather than an error.

---

## Open questions

None blocking. Resolved on 2026-10-31: toggle is global, Tasks panel never auto-opens, Kimi is
signed in via the CLI. The remaining unknowns are technical (Kimi credential format and whether
`/usages` accepts it) and are the first step of section 4.
