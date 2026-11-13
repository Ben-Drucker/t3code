# Backlog

Keep unfinished items here. Once a feature, fix, or change is completed, move it to MINE_DIVERGENCE_LOG.md and remove its corresponding backlog entry only with evidence of completion.

- Mini QQ: a global hotkey (opt+opt, plus a reliable chord such as Opt+Space as the fallback) opens a small floating window with an exact copy of the composer, QQ on by default. The answer streams into a stripped-down sheet above it. Esc or the hotkey again dismisses it.
  - Starts in the "No project" option. Each question is a normal saved thread, hidden from the sidebar, with an "Open in T3" action.
  - Reopening within 10 minutes (timer starts at the hotkey press) keeps the previous conversation. After that, or on Cmd+N, it starts a fresh "No project" session.
  - T3 runs as a hidden login item with a menu-bar icon so the hotkey works with all windows closed. Cold start is about 1.5-4 s: show the composer at once and queue the first message until the server is up.
  - Riskiest part, test first: taking keyboard focus over a full-screen app without switching Spaces (non-activating panel window). opt+opt needs Accessibility permission and goes dead during macOS secure input (password fields), so keep the chord as the fallback.
  - Other pitfalls: the two windows share draft storage and would overwrite each other (use a separate key), and keep a warm provider session so the first answer is not slow.
  - Estimate: MVP 3-4 days, polished 7-10 days.
- OpenCode models ignore the chosen context window unevenly: some (e.g. Haiku) respect it, others (Gemini 4 Carbon via the API, the 1.05M-context kind, not Antigravity) do not. Find out why.
- Quick explainer (mermaid diagram): how device connect works through a private server, how it reaches the phone, and whether/how the iOS version code needs to change. Ben has a paid Apple developer account ($99/yr).
- Investigate only: how dictation works or doesn't in T3. Do providers such as Claude Code (subscription) offer it over ACP or their SDKs? What about small free local models?
- Clarify Kimi's extra modes (such as yolo), which seem to overlap with permissions. Separate permission defaults are implemented and recorded in MINE_DIVERGENCE_LOG.md; retain this explanatory follow-up until its completion is established.
- Compaction progress bar, shown next to the compaction indicator.
  - Research the industry-standard formula that maps the current context size to the expected size after compaction.
  - Use the tokens per second from the last turn to estimate how long it takes to write that many output tokens.
  - Reconcile the "Context compacted 315K → 18.4K tokens" message (attachment 4bbfbc05-8177-4a3b-b6b7-df38844723d0-d75b9d40-6659-495e-89db-a66b0d06d2e2). Right after it, the context meter showed about 45K, not 18K. Ben believes 45K is right, since a fresh context normally starts at 15-30K. Find where 18.4K comes from. If it is the number of output tokens the summary took, session data can be used to calibrate the formula.
