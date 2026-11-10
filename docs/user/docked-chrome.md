# Use your own Chrome in the preview (macOS)

The preview can open your real Google Chrome next to the chat, so extensions such as 1Password
and Touch ID unlock work. Agents keep controlling the same page with the usual browser tools.

This is macOS only, needs Google Chrome in `/Applications`, and only works when T3 Code runs the
server on the same Mac. Otherwise the built-in preview is used.

## Turn it on

1. Open **Settings → Browser → Preview browser** and choose **Chrome (docked)**.
2. Choose **Allow** and turn on T3 Code under **System Settings → Privacy & Security →
   Accessibility**. T3 Code uses this only to move and resize the Chrome window.
3. Open a preview. Chrome opens on top of the preview panel and follows it as you move or resize
   the T3 Code window.

Without the permission, Chrome opens as a normal window that does not follow the panel.

## Set up 1Password once

T3 Code uses its own Chrome profile, so your regular Chrome profile stays untouched. Install the
1Password extension from the Chrome Web Store in that window and sign in. T3 Code copies
1Password's desktop-app connection files into the profile each time Chrome starts, so Touch ID
unlock keeps working.

## Good to know

- Closing the preview closes Chrome, and closing the Chrome window closes the preview tab.
- Only one Chrome can use the T3 Code profile. If it is already open, quit it and try again.
- Menus and dialogs that overlap the preview panel appear behind Chrome. Spaces and full-screen
  T3 Code windows are not supported; Chrome hides while T3 Code is full screen.
