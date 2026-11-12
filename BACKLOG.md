# Backlog

- More prominent done/waiting styling: blue dot for done, orange dot for needs the user. Clicking the thread clears the dot. Notifications match the same meanings.
- Mini QQ: a global hotkey (opt+opt, plus a reliable chord such as Opt+Space as the fallback) opens a small floating window with an exact copy of the composer, QQ on by default. The answer streams into a stripped-down sheet above it. Esc or the hotkey again dismisses it.
  - Starts in the "No project" option. Each question is a normal saved thread, hidden from the sidebar, with an "Open in T3" action.
  - Reopening within 10 minutes (timer starts at the hotkey press) keeps the previous conversation. After that, or on Cmd+N, it starts a fresh "No project" session.
  - T3 runs as a hidden login item with a menu-bar icon so the hotkey works with all windows closed. Cold start is about 1.5-4 s: show the composer at once and queue the first message until the server is up.
  - Riskiest part, test first: taking keyboard focus over a full-screen app without switching Spaces (non-activating panel window). opt+opt needs Accessibility permission and goes dead during macOS secure input (password fields), so keep the chord as the fallback.
  - Other pitfalls: the two windows share draft storage and would overwrite each other (use a separate key), and keep a warm provider session so the first answer is not slow.
  - Estimate: MVP 3-4 days, polished 7-10 days.
