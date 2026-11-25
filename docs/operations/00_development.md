# Development

## First checkout

Install [Vite+](https://viteplus.dev/guide/) (`vp` provides the pinned Node version from `package.json`):

```sh
curl -fsSL https://vite.plus | bash
# Windows PowerShell: irm https://vite.plus/ps1 | iex
```

On Windows, clone with long paths enabled so `.repos/` checks out cleanly:

```powershell
git clone -c core.longpaths=true https://github.com/pingdotgg/t3code.git
```

From the repository root:

```sh
vp i
vp run dev
```

Open the pairing URL printed by the dev runner (the bare origin does not authenticate a new browser). Prefer a container? See [Dev container](./01_devcontainer.md).

## Forge mirror (optional)

GitHub is the source of truth; [source.tanstack.com/@pingdotgg/t3code](https://source.tanstack.com/@pingdotgg/t3code) is a two-way mirror for parallel agent work:

```sh
git remote set-url origin https://source.tanstack.com/@pingdotgg/t3code.git
git remote add github https://github.com/pingdotgg/t3code.git
src auth login --web && src auth setup-git
```

With `origin` on the mirror, use `src` instead of `gh`. PRs into `main` still merge on GitHub, and numbers can differ between forges—use the GitHub number in text that reaches GitHub.

## Running dev servers

- `vp run dev` (server + web), `vp run dev:desktop` (Electron), `vp run dev:server`, `vp run dev:web`. See [apps/mobile/README.md](../../apps/mobile/README.md) for mobile.
- Pass flags directly after the task name (e.g. `vp run dev --home-dir /tmp/t3code-dev`, `--browser`).
- **State and ports:** Linked worktrees default to `<worktree>/.t3/userdata` (outranking `T3CODE_HOME`) and seed on first start from a read-only snapshot of `~/.t3/userdata/statev2.sqlite` when it is at most 500 MiB (`--no-seed` or `T3CODE_DEV_SEED=0` skips; `vp run migrate-dev-db` refreshes manually). Plain clones and the main checkout default to `~/.t3/dev`. Never point a dev server at `~/.t3/userdata`. Read actual ports from `[dev-runner]` output (`T3CODE_PORT_OFFSET` / `T3CODE_DEV_INSTANCE` override).
- **Resource monitor:** First start builds `native/resource-monitor` via Cargo when missing; without Rust, dev starts without process telemetry.
- **Sharing:** `vp run dev --share` exposes the web port over Tailscale and prints a pairing URL. Add `--built` to serve `apps/web/dist` via `vp build --watch` (no HMR, faster over slow links). Never set `VITE_HTTP_URL` or `VITE_WS_URL` in dev—Vite proxies `/api` and `/ws` single-origin.
- **Startup profiling:** `vp run profile:startup` captures the first 20 s of Node processes under `.t3/startup-profiles/<timestamp>`.

### Replay provider

`vp run dev` registers `Replay (dev)` ([dev-replay-agent.ts](../../apps/server/scripts/dev-replay-agent.ts)), a local ACP agent that streams recorded transcripts without calling a paid model. Add scenarios under `SCENARIOS` pointing at a generic ACP fixture (`registry_transcript.ndjson`) or a file in `apps/server/scripts/dev-replay`.

### Reusable dev credential

Only use this on a hostname where you trust every service (browsers share cookies across ports on the same hostname). Generate one secret once and put it in the main checkout's gitignored `.env` (which `t3.json` links into worktrees):

```sh
openssl rand -hex 32
# Add to .env: T3CODE_DEV_AUTH_TOKEN=<value>
```

Restart `vp run dev --share` and open its printed pairing URL once per browser profile. Never commit or publish the token or startup URLs. Desktop and non-dev servers ignore it; see [environment auth](../internals/04_environment-auth.md#reusable-dev-credential).

### Firefox server preview

Set `T3CODE_SERVER_BROWSER=firefox` in the server's environment to route the existing
`preview_*` agent tools through Firefox. The default mode attaches to Firefox's Marionette
listener at `127.0.0.1:2828`; `T3CODE_FIREFOX_PORT` changes the port. Start Firefox with
`--marionette` using the profile whose logins you want. T3 opens new work tabs and closes only
tabs it created. Native input selects the work tab, and resizing changes its Firefox window.
T3 never launches, reads, clears, or deletes that profile in attach mode.

For an isolated headless browser, also set `T3CODE_FIREFOX_MODE=launch`. This creates and removes
a temporary profile and stops only the process T3 launched. `T3CODE_FIREFOX_BINARY` selects the
executable; the default is `/Applications/Firefox.app/Contents/MacOS/firefox` on macOS and
`firefox` on PATH elsewhere.

Marionette handles native input, navigation, snapshots, and PNG screenshots. Starting an attached
Firefox with `--remote-debugging-port=0` additionally enables WebDriver BiDi for per-tab color
scheme, navigation readiness other than `load`, prompt type/default value,
and console/network diagnostics. Launch mode enables this automatically. With Marionette alone,
dialogs remain resolvable but report the generic type `dialog` and an empty default value.

Firefox has no Marionette/BiDi screencast stream, so recording and the streamed Browser panel
are unavailable. On macOS desktop, choose **Firefox (docked)** in Settings → Browser to attach to
your running Firefox and create a dedicated window without `T3CODE_SERVER_BROWSER`. Start Firefox
with `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` in its launch environment and
`--marionette --remote-debugging-port=0` (older Firefox also needs `--remote-allow-system-access`). A unique title prefix
identifies T3's window to the native helper; all later operations target its recorded window ID.
Missing or ambiguous matches leave other windows untouched and use the built-in preview.
An unreachable Marionette listener also falls back to the built-in preview. Set
`T3CODE_FIREFOX_MODE=isolated` to opt into the persistent `--no-remote` profile instead; this
profile needs its own extensions and logins. `T3CODE_FIREFOX_MODE=launch` remains the temporary
headless fixture mode. The env var `T3CODE_SERVER_BROWSER`
still selects Firefox for headless and non-desktop hosts. See the
[browser setup guide](../user/docked-browser.md) for docked profile behavior, 1Password autofill,
and permissions. Set
`T3CODE_FIREFOX_BIDI_PORT` to the Firefox remote-debugging port to diagnose a conflicting Chrome
listener. For a visible temporary-profile launch use `T3CODE_FIREFOX_MODE=launch` and
`T3CODE_FIREFOX_HEADLESS=0`. Locators support snapshot refs,
CSS, `text=`, and `role=...[name=...]`; other Playwright selector engines, remote evaluation
handles, and native file-picker interception return unsupported errors. Upload through the
file input's locator instead. Firefox snapshots use a DOM-based accessibility-style tree.
Cache-bypassing reload is attempted through BiDi and returns unsupported on Firefox versions
that do not implement it. Marionette script timeouts can abandon pending promises; they cannot
terminate JavaScript that blocks the content process.

Run the isolated fixture tests with `vp test run apps/server/src/preview/FirefoxBrowser.integration.test.ts`.
They skip when Firefox is absent. `T3CODE_FIREFOX_TEST_BINARY` and `T3CODE_CHROME_TEST_BINARY`
select test binaries; Chrome comparison runs only when its binary exists. Tests always create
temporary profiles and never use the owner's Firefox profile.

## Checks

- `vp run check:changed` — CI's fast checks for your branch (format, lint, knip, affected typechecks, nearby tests, and React Compiler coverage).
- Focused iteration: `vp test run <files>`, `vp lint <files>`, `vp run --filter <pkg> typecheck`, `vp run knip:check`, `vp run lint:mobile`.
- `apps/web` uses real Chromium (`*.browser.test.{ts,tsx}`) for DOM/React tests (no jsdom) and Node for `*.test.ts`.
- Typechecking uses `effect-tsgo tsrs --noEmit` (`@effect/tsgo`), not `typescript` (except `apps/marketing` for Astro). On Windows, open the workspace through WSL for VS Code's `.vscode/tsdk/tsgo`.

## Desktop artifacts

Unsigned local builds write to `release/`:

```sh
vp run dist:desktop:dmg
vp run dist:desktop:linux
vp run dist:desktop:win
# Linux ARM64: vp run dist:desktop:artifact --platform linux --target AppImage --arch arm64
```

Run `vp run dist:desktop:artifact --help` for `--arch`, `--signed`, and `--keep-stage`.

### Linux AppImage prerequisites

Build on Linux (the browser-secret helper links against `libsecret`). Install Rust stable (`rustup`), C/C++ build tools, `libsecret` dev headers, `pkg-config`, ImageMagick, and Electron runtime libs (`gtk3`, `nss`, `alsa`, `gbm`):

```sh
# Ubuntu 24.04 / Debian 13 (on 22.04/Debian 12 use libgtk-3-0 and libasound2)
sudo apt-get install build-essential libsecret-1-dev pkg-config imagemagick libgtk-3-0t64 libnss3 libasound2t64 libgbm1

# Fedora
sudo dnf install gcc gcc-c++ make libsecret-devel pkgconf-pkg-config ImageMagick gtk3 nss alsa-lib mesa-libgbm

# Arch
sudo pacman -S base-devel libsecret pkgconf imagemagick gtk3 nss alsa-lib mesa
```

### macOS DMG prerequisites

Install Xcode Command Line Tools (`xcode-select --install`) and Rust. For cross-arch/universal builds:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

### Windows installer prerequisites

Install Rust, Python 3, and Visual Studio Build Tools (**Desktop development with C++**, Windows SDK, MSVC build tools, Spectre-mitigated libraries), then add the Rust target:

```powershell
rustup target add x86_64-pc-windows-msvc   # or aarch64-pc-windows-msvc
```

WSL support also requires passing the Linux CLI archive via `--wsl-runtime`; see [release runbook](./03_release.md#windows-payload-topology-and-update-validation). For signing and macOS passkeys, see [release](./03_release.md) and [Connect setup](./02_connect-setup.md#desktop-passkeys).
