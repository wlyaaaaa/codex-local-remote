# ChatGPT / Codex Local Remote v0.1.1

`v0.1.1` is a repair release for the Windows lifecycle, long-task reader, and
remote-control regressions found after `v0.1.0`. The `v0.1.0` tag remains
unchanged.

## What changed

- Keeps **Stop** independently visible while the message composer is collapsed.
- Isolates drafts and browser uploads when switching between tasks.
- Recovers a queued next turn after a crash without turning an already completed
  Desktop turn back into a permanently active turn.
- Recovers from an individual state-file write failure without poisoning later
  saves.
- Reads long tasks only through bounded item/turn pagination. If the installed
  Desktop runtime does not expose a bounded reader, the Web UI reports the
  capability as unavailable instead of attempting an unbounded `thread/read`.
- Uses the physical data-directory identity for the single Broker lease and
  rejects sensitive paths after resolving filesystem aliases.
- Reserves login-attempt capacity before asynchronous password verification, so
  concurrent requests cannot bypass the configured limits.
- Performs every uninstall safety check before the first mutation.
- Installs each runtime into a content-addressed, immutable
  `RuntimeVersions/<sha256>` directory. The scheduled task and the managed
  shortcut point to the selected version; one previous validated version is
  retained for bounded rollback.

## Windows lifecycle

Normal use remains:

1. Open the managed **ChatGPT Remote** shortcut.
2. The hidden scheduled task starts the selected Broker and Sidecar runtime.
3. ChatGPT / Codex Desktop starts with the process-scoped Broker endpoint only
   when that endpoint is ready.
4. If Remote cannot start, the launcher opens native Desktop without a persistent
   app-server override.

Use `scripts/windows/Rollback-CodexLocalRemoteRuntime.ps1` to select the previous
validated runtime for the next start. Rollback does not kill a running Desktop
session.

## Compatibility receipt

- Windows: Windows 11 x64
- Desktop package: `OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0`
- Product version: `0.1.1`
- Runtime selection: dynamic package/runtime discovery; no pinned WindowsApps
  version directory
- Persistent `CODEX_APP_SERVER_WS_URL`: not used

This receipt proves the version tested for this release only. Future ChatGPT /
Codex Desktop builds are discovered dynamically, but cannot be promised
compatible before they exist. An incompatible build must leave native Desktop
usable and report Remote as unavailable.

## Verification

The frozen candidate passed the repository's local `pnpm check` chain: 83 test
files and 978 tests, production builds, and a scan of 270 public files. The six
supported browser viewports passed the stop/steer journey, and the immutable
version test covered two installs, current/previous switching, and tamper
rejection. Publication still requires one cold start from the exact packaged
runtime.

GitHub CI is useful follow-up evidence but is not used as a substitute for these
local functional checks.

## Known boundaries

- This is an unofficial self-hosted companion, not an OpenAI product.
- The app-server is loopback-only. Public HTTPS exposure is limited to the Web
  Sidecar route and still requires its password/session protections.
- A historical task can be much larger than a browser frame. The UI loads its
  newest bounded page first and fetches older pages only when requested.
- A Desktop approval can be answered remotely only when the current runtime
  provides an explicit response schema. Unknown approval shapes fail closed.
