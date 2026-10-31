# T3 Code fork: background

Written 2026-10-31. This folder lives in the `network-inventory` repo only because that is where
the planning session happened; the content is unrelated to network inventory. Move it to the fork
once the fork exists.

## Goal

Ben wants **one** T3 Code on his Mac: his own build, with his modifications, replacing the stock
app. No second copy side by side. No auto-update from upstream. About once a week, an AI agent
looks at upstream's current nightly, merges Ben's changes onto it, builds a new DMG, and Ben
installs it over the old one.

## What T3 Code is

- Upstream: <https://github.com/pingdotgg/t3code> (MIT, TypeScript monorepo, very active; ~33k
  stars at time of writing, thousands of open issues).
- An "agent harness control surface": a Node WebSocket server wraps provider CLIs (Claude Code,
  Codex, Cursor, Grok Build, OpenCode, Antigravity). Web, desktop (Electron) and mobile clients
  control it over RPC. The desktop app bundles the server.
- Upstream's `AGENTS.md` says "a large number of our users run forks" and the README says they want
  people to be able to fork and build the editor they want. Forking is the intended path.
- `CONTRIBUTING.md`: they are mostly not accepting outside features. Do not plan on upstreaming.

Snapshot inspected: `main` at `50c1c5d` (2026-10-31, "feat: side chats beside the main thread"),
desktop/server package version `0.1.5`. Layout: `apps/{desktop,server,web,mobile,marketing}`,
`packages/*` (contracts, client-runtime, provider-_, source-control-_, ...), `scripts/`, `docs/`.

Key docs in the upstream repo: `docs/operations/development.md` (setup, checks, desktop builds),
`docs/operations/release.md` (release/signing), `docs/internals/overview.md` (architecture),
`docs/internals/adding-a-provider.md`, `AGENTS.md` (conventions and hazards).

## How building and running works (macOS)

Toolchain:

- `vp` (Vite+): `curl -fsSL https://vite.plus | bash`. It supplies the pinned Node (Node 26) and
  the pnpm version, so no separate Node install.
- Xcode Command Line Tools (`xcode-select --install`) and Rust (`rustup`). A native
  resource-monitor helper is built with cargo during packaging.
- At least one provider CLI installed and logged in (`claude auth login`, `codex login`, ...).

Commands (from the repo root):

| Purpose                  | Command                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------- |
| Install deps             | `vp i`                                                                             |
| Dev (server + web)       | `vp run dev` (open the pairing URL it prints; a bare origin does not authenticate) |
| Dev (Electron)           | `vp run dev:desktop`                                                               |
| Fast checks on your diff | `vp run check:changed`                                                             |
| Single checks            | `vp test run <files>`, `vp lint <files>`, `vp run --filter <pkg> typecheck`        |
| Build DMG                | `vp run dist:desktop:dmg` (host arch; add `--arch arm64` or `--arch x64`)          |

Local DMGs are unsigned by default and land in `release/`.

## Decision: replace the stock app, keep its identity

Because Ben wants a single T3 Code, the fork should **keep** the stock identity:

- App ID stays `com.t3tools.t3code` (`DESKTOP_APP_ID`, `scripts/build-desktop-artifact.ts` line ~65).
- Product name stays "T3 Code" (`apps/desktop/package.json` `productName`).
- Data stays in `~/.t3` (default; overridable with `T3CODE_HOME`), so existing projects and
  threads carry over.

Consequence: the new DMG installs over `/Applications/T3 Code.app` and picks up the existing data.
There is nothing to rename. (If Ben ever wants a side-by-side copy, change `DESKTOP_APP_ID`,
`productName` and `T3CODE_HOME`. That is explicitly not the plan.)

Things this implies:

1. **Remove the Homebrew cask or never run it again.** If the stock app was installed with
   `brew install --cask t3-code`, run `brew uninstall --cask t3-code` (this should not delete
   `~/.t3`, but back it up first anyway). Otherwise `brew upgrade` will replace the fork build.
2. **Data compatibility goes one way.** The server's SQLite schema migrates forward. Never run a
   build older than the one that last touched `~/.t3`. Building from upstream nightly is always at
   or ahead of stable, so that is fine; building from an old commit is not.
3. **Avoid adding database migrations in the fork.** Upstream numbers them (for example
   `apps/server/src/persistence/Migrations/050_...`). A fork migration with a number upstream later
   uses will collide on a weekly merge. If a mod truly needs one, flag it prominently in `MODS.md`.
4. **Back up `~/.t3` before the first swap**, and ideally before each weekly install
   (`cp -R ~/.t3 ~/.t3-backup-YYYY-MM-DD`). Do not point a dev server at the live `~/.t3/userdata`
   (upstream's `AGENTS.md` forbids it); dev mode uses `~/.t3/dev` or a per-worktree `.t3`.

## Decision: no auto-update

Read from the code (not yet confirmed by running a build):

- `apps/desktop/src/updates/DesktopUpdates.ts` (`getAutoUpdateDisabledReason`): updates are
  disabled when there is no update feed config, in dev, or when `T3CODE_DISABLE_AUTO_UPDATE` is set.
- `scripts/build-desktop-artifact.ts` sets `buildConfig.publish = null`, then only fills it in if
  `resolveGitHubPublishConfig` finds `T3CODE_DESKTOP_UPDATE_REPOSITORY` or `GITHUB_REPOSITORY` in
  the environment (or mock updates are on). So a local build with neither variable set ships
  without an update feed, and the updater reports "no update feed is configured".

So the default local build should already never update itself. **Do not set
`T3CODE_DESKTOP_UPDATE_REPOSITORY` or `GITHUB_REPOSITORY` when building**, and make sure the build
shell does not inherit `GITHUB_REPOSITORY` (it is set in GitHub Actions). Setting
`T3CODE_DISABLE_AUTO_UPDATE` is a weak backstop only: a Finder-launched app does not see shell
variables. After the first install, confirm in the app (Settings, updates) that it shows updates as
unavailable.

Related: the optional `t3` CLI (`curl -fsSL https://t3.codes/install.sh | sh`) and `t3 update` are
a separate install path for the server. If Ben has that installed, it is a second T3 Code. Check
for it (`which t3`) and decide whether to remove it.

## Other facts worth knowing

- Unsigned app on macOS: Gatekeeper may block first launch. Fix with right-click, Open, or
  `xattr -dr com.apple.quarantine "/Applications/T3 Code.app"`. Ben builds it himself, so this is
  expected. Features needing a signed, provisioned app (macOS passkeys, see
  `docs/operations/connect-setup.md`) will not work unsigned; signing needs an Apple Developer
  account and is not part of this plan.
- Mobile apps and the hosted web app (`app.t3.codes`) are upstream's, and talk to a server over the
  RPC protocol. A fork that changes the RPC contract (`packages/contracts/src/rpc.ts`) may stop
  working with them. Prefer mods that do not touch the contract.
- Upstream has a "preview" release train and CI workflows (`.github/workflows/`). The fork does not
  need them; leave them alone to keep merges clean, and consider disabling Actions on the fork.

## Open questions for Ben

- Which mods does he want first? (Nothing has been decided; no code has been changed.)
- Was the current install from Homebrew, the GitHub release DMG, or the `t3` CLI?
- Apple Silicon or Intel Mac? (Assumed Apple Silicon: `--arch arm64` is the default on that host.)
- Where should the weekly agent run: Ben's Mac (needed for the actual DMG build and install, since
  this is a macOS build) or a cloud session (can do the merge and checks, not the Mac build)?
