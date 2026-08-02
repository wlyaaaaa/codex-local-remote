# ChatGPT / Codex Local Remote v0.1.5

`v0.1.5` fixes the release path that could leave a selected Web/Sidecar runtime
waiting indefinitely whenever any Codex task remained active.

> 简体中文：兼容的公网更新不再等待所有 Codex 任务结束。旧 Sidecar 会先排空
> 已接纳的写请求，再短暂切换到新运行代；Broker、app-server、Codex Desktop
> 和正在运行的任务保持不动。

## Active-task Sidecar updates

- Replaces the global `unsafeThreadCount=0` gate with one Sidecar activity drain
  covering browser mutations and automatic next-turn dispatch. Active Codex
  turns remain owned by the unchanged Broker/app-server.
- Authenticates the loopback drain command with a protected Supervisor-session capability and
  binds its receipt to one canonical update id. A failed or mismatched drain
  never stops the old Sidecar.
- Preserves the existing immutable-runtime checks, Broker/upstream/Desktop
  process identities, compatibility id, unknown-connection gate and exact
  rollback path.
- Keeps the update bounded: the public listener has a short same-port gap, but
  the browser reconnects to the new Sidecar and refreshes the authoritative
  thread snapshot.

## Message continuity

- Idempotent browser mutations retry through a bounded recovery window with the
  same idempotency key. This covers a Sidecar restart without duplicating a
  message, upload or control action, and still terminates with an explicit
  offline result when recovery does not complete.
- New writes received after draining begins get a retryable `503`, and no new
  queued turn is dispatched; already accepted writes or dispatches finish
  before the drain receipt is issued. A timed-out drain returns to serving
  instead of leaving the phone permanently read-only.

## Upgrade

```powershell
pnpm install --frozen-lockfile
pnpm check
.\scripts\windows\Register-CodexLocalRemoteStartup.ps1 -NoStart
```

Registration remains non-disruptive and never restarts Codex Desktop. An
already-running pre-v0.1.5 Supervisor cannot gain the new drain protocol in
memory; its first adoption of v0.1.5 therefore still follows the previous safe
boundary. Once the v0.1.5 Supervisor is active, later compatible Web/Sidecar
updates can roll while Codex tasks are running.

Broker/app-server changes or a compatibility-id change still require the
separate explicit runtime handoff and must not be disguised as a public-layer
update.
