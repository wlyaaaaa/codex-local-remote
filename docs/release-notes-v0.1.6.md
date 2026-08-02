# ChatGPT / Codex Local Remote v0.1.6

`v0.1.6` fixes an intermittent Windows fast-restart failure in which the
managed app-server exited but one of its console descendants retained the
upstream listener handle.

> 简体中文：快速切换现在会在关闭旧运行代之前锁定 app-server 的完整进程树，
> 并在启动新运行代前确认所有受管端口已经连续释放。旧版本已经留下的精确
> `conhost.exe` 残留也可以通过受保护的运行回执安全恢复。

## Fast-restart process ownership

- Captures the exact managed app-server root and every existing descendant by
  process creation identity before an authorized Desktop handoff begins.
- Stops the held process tree after the old Supervisor drains, then requires
  two consecutive empty observations across the Sidecar, Broker and upstream
  ports before Remote mode is re-armed.
- Uses full-tree termination for exact managed Broker/app-server shutdowns so
  inherited Windows handles do not outlive their owner.
- Reads image paths and command lines through bounded native
  `PROCESS_QUERY_LIMITED_INFORMATION` queries when Windows redacts those CIM
  fields across the scheduled task's higher integrity boundary. The result is
  still checked against the exact immutable-runtime command contract; an
  unreadable or mismatched process remains fail-closed.
- Binds the prepared Sidecar to its recorded Bootstrap parent, process-start
  identity and unique loopback listener before Desktop is closed, then rechecks
  the unchanged receipt and listener after the identity handle is open.
- Includes the v0.1.5 Sidecar maintenance-token argument in the exact ownership
  contract. The legacy no-token contract remains distinct and cannot accept an
  unexpected token path.

## Compatibility recovery

- Repairs the specific legacy state where the protected Broker receipt still
  binds the dead upstream PID, the TCP row still names that PID, and exactly
  one direct `System32\conhost.exe` descendant has the matching startup-time
  identity.
- Re-reads the receipt, listener owner, dead parent and held child identity
  immediately before cleanup. Any missing, ambiguous, foreign or changed
  evidence remains fail-closed.
- If Windows keeps a loopback listener after both the exact process root and
  descendants are gone, an internal offline-only recovery can atomically move
  the managed upstream to a verified empty registered port. It requires the
  task to be `Ready`, desired mode `Native`, no active runtime, an exact
  selected task/pointer binding, and changes no other managed configuration.
- The port, task definition, selected-runtime binding and configuration use the
  existing rollback transaction; partial migration restores the exact prior
  task/pointer/configuration pair.
- Migration holds the same on-demand control fence used by every supported
  Open/Close path, then rechecks `Ready`, `Native`, runtime silence and empty
  target ports immediately before changing the task/runtime binding.
- Managed configuration and desired-mode updates use mutex-scoped
  compare-and-swap writes with exact post-write verification. A failed
  verification restores the original bytes before the writer lock is released.
- Never scans or stops unrelated console hosts, Desktop stdio app-servers or
  listeners outside the configured managed ports.

## Upgrade

```powershell
pnpm install --frozen-lockfile
pnpm check
.\scripts\windows\Register-CodexLocalRemoteStartup.ps1 -NoStart
```

Registration remains non-disruptive. Adoption is complete only after one
explicit `Open` operation proves that the selected immutable runtime is also
the active Broker/Sidecar/Supervisor runtime and both local and public ready
endpoints return `200`.
