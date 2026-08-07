# ChatGPT / Codex Local Remote 0.1.6 candidate — unreleased

> **Status (2026-08-03):** This document records the nine local Windows-handoff
> changes after the public `v0.1.5` release. It is not a GitHub Release, tag,
> stable Remote build, supported upgrade, or proof that the candidate was
> adopted by a real runtime. The postmortem records E1 code/static evidence;
> E3 and E4 real-machine recovery acceptance are incomplete.

> 简体中文：这是 `v0.1.5` 之后九个本地 Windows 交接修复的**未发布候选**记录，
> 不是 GitHub Release、tag、稳定 Remote 构建、支持升级路径，也不能证明真实运行代
> 已采用该候选。现有证据仅到 E1；E3、E4 实机恢复验收尚未完成。

See the [failure postmortem](failure-postmortem-2026-08-03.md) for the evidence
boundary and the required future publication gates.

## Candidate changes: fast-restart process ownership

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
- Resolves the Sidecar ownership matcher from the selected immutable runtime's
  exact module export, so a stale same-named PowerShell module cannot shadow the
  token-bound contract during a runtime handoff.

## Candidate changes: compatibility recovery

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

## Static candidate validation (not adoption)

```powershell
pnpm install --frozen-lockfile
pnpm check
```

These commands establish only E1 static candidate evidence. Do not register,
adopt, or invoke `Open` for this candidate from this document, and do not
create a tag, GitHub Release, or stable-release claim. Any future work must
have separate authorization and meet the postmortem's E2, E3, and E4 gates.
