# ChatGPT / Codex Local Remote v0.1.4

`v0.1.4` is the final product-state hotfix after the `v0.1.3` runtime audit. It
does not change the native-default ownership model: normal Codex startup,
updates, sleep recovery and Windows startup remain native, while Remote opens
only through explicit user authorization.

> 简体中文：本版集中修复最终公网验收发现的状态归属、手机队列、目标与计划、
> 协作模式和智能体活动展示问题。升级采用不可变运行时热切换，不要求重启
> Codex Desktop。

## Product fixes

- Removes completed goals from the composer immediately while preserving active
  goal controls and current-turn `第 n/m 步` plan progress.
- Keeps only the latest English reasoning headline for the active turn; public
  Chinese progress updates, tool activity and final answers remain visible.
- Treats queue entries that Codex has already accepted as active work rather
  than undeletable pending messages. The queue now shows only genuinely pending,
  paused, ambiguous or in-flight dispatch records. Terminal reconciliation also
  clears an accepted tombstone when only the later terminal event carries the
  turn id, so subsequent queued work cannot remain blocked behind it.
- Renders exact Codex task-delegation envelopes as an explicitly unverified
  format and links to the task id shown in the envelope; the current protocol
  does not provide independent sender provenance. Embedded literal XML examples
  written by a user or assistant remain ordinary content.
- Localizes the built-in collaboration mode as `标准`, renders `ultra` without a
  suffix and renders `Max` as `最高` across desktop and mobile selectors.
- Refreshes goal state independently of slower task snapshots, preventing a
  completed or externally changed goal from being restored by an older request.

## Agent and connection visibility

- Normalizes started/completed lifecycle updates for tools, file changes, image
  inspection and subagents so active work does not remain permanently running.
- Gives cross-task list/read/send/wait operations and Gmail connector activity
  explicit product labels without exposing internal invocation syntax.
- Retains the bounded SSE queue, reconnect confirmation window, idempotent
  mutation retry and authoritative snapshot reconciliation introduced in
  `v0.1.3`; focused regression coverage now includes queue ownership and
  cross-task provenance.

## Upgrade

From a clean checkout of the released tag:

```powershell
pnpm install --frozen-lockfile
pnpm check
.\scripts\windows\Register-CodexLocalRemoteStartup.ps1 -NoStart
```

`-NoStart` installs and selects an immutable runtime. The running supervisor may
roll only the Remote Sidecar/Web runtime at the next safe boundary; it does not
restart Codex Desktop.

## Known limitations

- A temporary image already deleted by Codex or Windows cannot be reconstructed
  from a path-only historical record.
- Desktop integration still depends on the process-scoped
  `CODEX_APP_SERVER_WS_URL` compatibility hook and must be revalidated after a
  material Codex Desktop protocol change.
- Extremely large archived histories remain explicitly paginated to protect
  phone memory and live control responsiveness.
