# ChatGPT / Codex Local Remote v0.1.3

`v0.1.3` is a post-release product and stability update for `v0.1.2`. It keeps
the native-default, explicit-Remote owner model unchanged and focuses on making
the browser surface feel like the same Codex task rather than a diagnostic
viewer.

> 简体中文：本版修复发布后发现的对话控制、超大历史、手机输入、附件、
> 连接抖动、额度展示和快速恢复问题，并重新验收桌面、平板和手机布局。
> 普通 Codex 启动、更新、Windows 重启和睡眠恢复仍保持原生；安装源码不等于
> 授权重启 Desktop，也不会自动打开 Remote。

## Product fixes

- Restores reliable pause, Stop, steer and resume controls for active goals and
  prevents a submitted user message from appearing more than once when the
  live event and the authoritative snapshot arrive through different paths.
- Keeps the active goal on its own full-width row above the composer, with
  start/pause/delete actions and real `第 n/m 步` plan progress. Conversation
  permission and approval settings no longer occupy the composer; actual
  approval requests remain actionable in the task stream.
- Shows only the latest public Codex reasoning status with the desktop-like
  shimmer treatment. Historical reasoning cards stay hidden, while public
  Chinese progress updates, tools and final answers remain visible.
- Loads every current task page automatically, but stops with a visible,
  recoverable error if a provider repeats or cycles a cursor, makes no
  progress, or crosses the bounded page/item budget. Archived tasks retain
  explicit pagination. Switching tasks cannot apply a late response or scroll
  decision from task A to task B.
- Keeps very large Desktop sessions off the app-server control path. The first
  view remains bounded; older JSONL history is available through explicit,
  bounded local pages that validate the thread, file identity and snapshot
  before every continuation. Active tasks never automatically scan an entire
  multi-gigabyte session.
- Recovers active control lifecycle records in bounded 8 MiB reverse pages,
  up to a 64 MiB safety budget. If no trustworthy active/idle anchor is found,
  the task is marked unknown and all mutating turn controls fail closed until a
  stable later read resolves it.
- Continues history on runtimes that expose paginated turns without paginated
  items by forwarding the opaque turn cursor; no unbounded `includeTurns`
  fallback is introduced.

## Mobile and UI fixes

- Keeps the composer expanded while it contains a draft or attachments and
  while a sheet is open. Removing one of many attachments no longer closes the
  attachment picker, and returning from the device file chooser no longer
  collapses the draft.
- Gives the goal, delivery mode, collaboration mode, model, plan and send/Stop
  controls stable mobile geometry without moving important controls below the
  composer. Primary touch targets remain at least 44 CSS pixels.
- Uses concise runtime labels: `Ultra` has no parenthetical suffix and `Max` is
  presented as `最高`. Drive choices show one readable path (`C:\`, `D:\`, …)
  instead of duplicated drive prefixes.
- Suppresses recognized host-only attachment scaffolding and standalone Codex
  UI directives. Literal examples written by the user or assistant are still
  preserved.
- Shows the current safe Codex account identity in Settings. Account, rate-limit
  and token-usage failures are reported once with an actionable degraded state
  instead of repeating `暂时无法读取` across every card.

## Connection and recovery

- Buffers live rendering to animation frames and gives short SSE interruptions
  a confirmation window, reducing one-frame disconnect flashes and uneven
  mobile token updates.
- Adds a bounded per-client SSE queue with real Node backpressure handling,
  overflow reset cursors and drain cleanup. One slow phone cannot accumulate an
  unbounded queue or turn normal backpressure into a reconnect loop.
- Retries only replay-safe, idempotent mutations once after a qualifying
  transport loss or transient gateway response. The same idempotency key is
  retained; `429` and unqualified `503` responses are not replayed.
- Makes cold-start terminal failures observable quickly instead of leaving an
  `Open` caller in a long ambiguous wait. Desktop launch receipt validation is
  shared by status, deferred handoff and on-demand recovery so all paths apply
  the same closed schema and allowlists.
- Migrates the exact historical localized launcher even when WScript persisted
  its four Chinese description characters as `????` on a non-Chinese Windows
  code page. Target, arguments, working directory, icon, window mode and
  RunAs/link flags remain exact, so foreign shortcuts are still rejected.

## Upgrade

From a clean checkout of the released tag:

```powershell
pnpm install --frozen-lockfile
pnpm check
.\scripts\windows\Register-CodexLocalRemoteStartup.ps1 -NoStart
```

`-NoStart` installs and selects the immutable runtime without stopping the
currently running Desktop, Broker or Sidecar. Use the stable installed control
dispatcher for an explicit `Status`, `Open` or `Close`; authorize a Desktop
handoff separately only if `Open` proves that hot recovery is impossible.

## Known limitations

- A temporary image already deleted by Codex or Windows cannot be reconstructed
  from a path-only historical record.
- Desktop integration still relies on the process-scoped
  `CODEX_APP_SERVER_WS_URL` compatibility hook. A future Codex Desktop update
  must pass the shared-owner acceptance again before Remote adoption is treated
  as verified.
- Multi-gigabyte session history is intentionally loaded one local page at a
  time. This preserves control responsiveness and phone memory at the cost of
  requiring an explicit request for older pages.
