# Use Chrome or Firefox beside the chat (macOS)

Choose **Settings → Browser → Preview browser → Chrome (docked)** or **Firefox (docked)**
to keep a browser beside the chat with extensions such as 1Password. T3 makes room by shrinking
its window by the preview panel's width. The browser follows T3's moves and resizes; closing
its window restores T3's width. This requires the desktop app and server on the same Mac.
Other clients use the built-in preview. Install Chrome in `/Applications` to use Chrome (docked).

Choose **Allow**, then enable T3 Code under **System Settings → Privacy & Security →
Device Control and Data Access**. Without this permission, the browser opens separately.
Full-screen T3 windows hide the docked browser. Moving the pair between Spaces is unsupported.

## Firefox and 1Password

Firefox attaches to your running browser, using its signed-in profile and installed extensions.
Quit Firefox normally, then start it with both automation listeners and system access enabled.
System access lets T3 click 1Password's banner from inside Firefox:

```sh
/Applications/Firefox.app/Contents/MacOS/firefox --marionette --remote-debugging-port=9333 --remote-allow-system-access
```

Marionette uses port 2828 by default. If you change `marionette.port` in Firefox, set
`T3CODE_FIREFOX_PORT` to match in the T3 server's environment. Set
`T3CODE_FIREFOX_BIDI_PORT=9333` there to check the BiDi listener for port conflicts.
Choose a free port; Chrome often uses 9222. Launch arguments must reach a new Firefox process,
so opening another window in an already-running Firefox does not enable the listeners.

Open a preview and ask the agent to use `preview_autofill`, optionally with an exact username
and entry title. Keep 1Password unlocked. T3 clicks the inline 1Password banner from inside
Firefox, so your cursor and other apps are untouched. It reports the selected entry's title and
username and the URL after the click; passwords and verification codes stay in 1Password.

T3 opens a separate Firefox work window and closes only tabs it created. Your other tabs and
profile stay yours. Firefox allows one automation session at a time. Stop another automation
client before connecting; restart Firefox if an abandoned session still occupies it.
`preview_status` reports when BiDi is off or its configured port belongs to Chrome.

Firefox supports snapshots and browser actions; video recording and the streamed preview are
unavailable. Use the docked Firefox window to view the page. Autofill requires macOS.

## Chrome and 1Password

T3 Code uses its own Chrome profile, so your regular Chrome profile stays untouched. Install the
1Password extension from the Chrome Web Store in that window and sign in. T3 Code copies
1Password's desktop-app connection files into the profile each time Chrome starts, so Touch ID
unlock keeps working.

Closing the preview closes its Chrome window, and closing Chrome closes its preview tab.
Only one Chrome can use T3 Code's profile;
if it is already open, quit that window and try again. Chrome does not support `preview_autofill`.
