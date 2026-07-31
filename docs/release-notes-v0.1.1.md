# ChatGPT / Codex Local Remote v0.1.1

> **Superseded — do not install for new deployments.** Upgrade to `v0.1.2` or
> later. The `v0.1.1` tag remains immutable so the original release can still be
> audited and rolled back precisely.
>
> 简体中文：`v0.1.1` 已被 `v0.1.2` 取代，不建议新安装。源码自动化曾通过，
> 但发布后的真实运行态复审发现运行代接管与长期恢复阻断；旧标签不会移动。

`v0.1.1` was a repair release for regressions found after `v0.1.0`. It
substantially improved queue recovery, long-task pagination, login throttling,
Desktop fail-open launch and immutable runtime packaging. A later live audit
showed that its update lifecycle was not yet release-safe.

## What shipped

- Kept **Stop** independently visible when the mobile composer was collapsed.
- Isolated drafts and browser uploads when switching between tasks.
- Reconciled crash-after-complete queue entries without reviving a terminal
  Desktop turn or poisoning later state saves.
- Replaced unbounded long-task reads with bounded item/turn pagination and an
  explicit unavailable state when the installed runtime lacked that capability.
- Hardened the single-Broker lease, alias-resolved file boundaries, login
  throttling and uninstall preflight checks.
- Launched the exact Desktop child with a process-scoped Broker endpoint while
  preserving native Desktop as the fail-open path.
- Installed content-addressed immutable runtimes with current/previous pointers
  and bounded rollback.

## Post-release finding

The release assumed that registering a new immutable runtime with `-NoStart`
would make it active on the next natural Desktop launch. That assumption was
incomplete when the old scheduled-task generation was already running: Desktop
could reopen while the old Broker generation remained active, leaving the new
selected runtime unapplied.

The later audit also found durable retry and lifecycle races that required a
new release: persisted `started` queue reconciliation, logical-intent
idempotency across restarts, serialized Supervisor start/stop, authoritative
terminal control state, and transactional selected-versus-active runtime
handoff.

Accordingly:

- the frozen `v0.1.1` source checks remain valid historical evidence;
- the original live shared-owner conclusion is **BLOCK**, not PASS or DEGRADED;
- `v0.1.1` is retained for audit and rollback only.

## Upgrade

Prefer the published `v0.1.2` tag or a later release. From a clean checkout of
that tag:

```powershell
pnpm install --frozen-lockfile
pnpm check
.\scripts\windows\Register-CodexLocalRemoteStartup.ps1 -NoStart
```

Registration is non-disruptive. Do not stop an active Desktop task merely to
apply an update. Registration does not open Remote and does not change the
normal vendor Desktop entry. After installing `v0.1.2` or later, use its stable
DataDir dispatcher for an explicit `Status` or `Open`; if `Open` reports that a
Desktop handoff is required, grant that one restart separately. Do not use the
ordinary Desktop launch as an adoption signal. In v0.1.2 and later, the exact
managed shortcut is only an optional alias for the same explicit `Open`
dispatcher; old runtime-bound shortcut definitions are migrated rather than
trusted as current.
See [`windows-install.md`](windows-install.md).

## Rollback and native recovery

To withdraw a selected update without terminating the currently running
Desktop:

```powershell
.\scripts\windows\Rollback-CodexLocalRemoteRuntime.ps1
```

Rollback changes the selected runtime and task definition for a later explicit
adoption; it does not restart Broker, app-server or Desktop. To remove the
managed control path entirely, first satisfy the uninstall preflight and then
use:

```powershell
.\scripts\windows\Unregister-CodexLocalRemoteStartup.ps1
```

Neither operation authorizes killing an unrelated Desktop or app-server
process.

## Compatibility and boundaries

- Windows 11 x64.
- ChatGPT / Codex Desktop is discovered dynamically; no WindowsApps version
  directory is pinned.
- `CODEX_APP_SERVER_WS_URL` is process-scoped and is not persisted.
- An incompatible Desktop build must fail open to native Desktop and report
  Remote unavailable.
- Broker and raw app-server listeners stay loopback-only. Public HTTPS exposes
  only the authenticated Sidecar route.
- This is an unofficial self-hosted companion, not an OpenAI product.

## Historical verification

The `v0.1.1` frozen tree passed formatting, lint, type checking, 981 automated
tests, production builds and its public-safety scan. Six supported browser
viewports passed the targeted stop/steer/compaction journey.

Those checks did not include a successful packaged-Desktop cold start on the
same immutable generation. Repository automation is therefore preserved as
historical source evidence and must not be cited as proof that the `v0.1.1`
live runtime takeover passed.
