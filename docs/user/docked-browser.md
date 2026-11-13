# Use Chrome or Firefox beside the chat (macOS)

Choose **Settings → Browser → Preview browser → Chrome (docked)** or **Firefox (docked)**
to keep a browser beside the chat with extensions such as 1Password. T3 makes room by shrinking
its window by the preview panel's width. The browser follows T3's moves and resizes after a brief
pause; closing its window restores T3's width. This requires the desktop app and server on the
same Mac. Other clients use the built-in preview. Install Chrome or Firefox in `/Applications` to
use its docked mode.

Choose **Allow**, then enable T3 Code under **System Settings → Privacy & Security →
Device Control and Data Access**. Without this permission, the browser opens separately.
Full-screen T3 windows hide the docked browser. Moving the pair between Spaces is unsupported.

## Firefox and 1Password

T3 Code launches a separate Firefox instance with its own profile, so your personal Firefox
windows and profile stay untouched. Install the 1Password extension in that Firefox window once
and sign in. T3 starts its Firefox profile with Marionette, WebDriver BiDi, and system access
enabled automatically.

Open a preview and ask the agent to use `preview_autofill`, optionally with an exact username
and entry title. Keep 1Password unlocked. T3 clicks the inline 1Password banner from inside its
Firefox window, so your cursor and other apps are untouched. It reports the selected entry's
title and username and the URL after the click; passwords and verification codes stay in
1Password.

Only one Firefox instance can use T3 Code's profile; if it is already open, quit that window and
try again. Firefox supports snapshots and browser actions; video recording and the streamed
preview are unavailable. Use the docked Firefox window to view the page. Autofill requires macOS.

## Chrome and 1Password

T3 Code uses its own Chrome profile, so your regular Chrome profile stays untouched. Install the
1Password extension from the Chrome Web Store in that window and sign in. T3 Code copies
1Password's desktop-app connection files into the profile each time Chrome starts, so Touch ID
unlock keeps working.

Closing the preview closes its Chrome window, and closing Chrome closes its preview tab.
Only one Chrome can use T3 Code's profile;
if it is already open, quit that window and try again. Chrome does not support `preview_autofill`.
