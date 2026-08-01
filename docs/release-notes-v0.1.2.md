# ChatGPT / Codex Local Remote v0.1.2

`v0.1.2` is the reliability and recovery release containing the fixes for the
live-runtime blockers found after `v0.1.1`. The `v0.1.0` and `v0.1.1` tags
remain unchanged.

> 简体中文：本版重点修复 Windows V5 Desktop owner 的按需远程交接、
> 崩溃后队列与停止状态、完整长任务历史、可逆 WorkLog、移动端输入/附件/
> 文件预览、动态审批/计划，以及管理员文件管理。普通启动、Codex 更新、
> Windows 重启和睡眠恢复均保持原生；只有显式 `Open` 且无法热恢复时，
> 才可在授权后最多执行一次受控 Desktop 重开。
>
> 置顶限制：当前 app-server 没有受支持的 pin/unpin 方法。Web 只读镜像
> Desktop 的置顶顺序，不写 Desktop 私有状态，也不伪装置顶操作已同步。

> Publication integrity: this source is eligible for `v0.1.2` only after it is
> sealed as an immutable runtime and that exact runtime passes live adoption.
> The sealed `fa50e18` base passed formatting, lint, type checking, all 1565
> tests across 106 files, the production build and a public-safety scan of 351
> files. The bounded presentation delta after that seal is verified separately
> by its focused suites, affected-package type checks/builds and public scan; it
> does not claim a second full-suite run. Source evidence alone is not
> live-adoption evidence.

## Highlights

### Native-default, on-demand Remote control

- Keeps ordinary ChatGPT / Codex Desktop startup, Store updates, Windows
  restarts and sleep/resume native. Registration selects an immutable runtime
  but does not enable automatic Remote takeover.
- Installs one stable, DataDir-scoped `control-dispatcher/v1` with explicit
  `Open`, `Close` and `Status` operations. Before dispatch, it validates
  `runtime-current.json`, the selected immutable runtime root, its manifest,
  file sizes and SHA-256 hashes; it never executes an unverified worktree path.
- Makes `Open` idempotent. An already healthy Remote lease returns without a
  restart; missing public components are repaired first without restarting
  Desktop. Only when the native Desktop cannot be attached safely may one
  explicitly authorized, bounded Desktop handoff occur.
- When one verified previous generation is still serving active turns, an
  authorized `Open` queues exactly one hidden worker and returns
  `restart-deferred` so the controller survives Desktop exit. The worker only
  re-enters the stable dispatcher with the exact selected pointer, manifest and
  desired-mode intent. Inside one DataDir control-mutex critical section, that
  dispatcher rechecks the intent, closes only one exact package Desktop root
  through its PID plus creation identity, waits for the exact startup task to
  become `Ready`, rechecks the intent and continues the installed `Open`.
  `Close` cannot interleave between shutdown and adoption, and a cancelled
  intent causes zero Desktop stops. Existing workers are reused only when their
  live PID/start-time claim, intent, runtime version and path all match; a later
  `Open` therefore cannot be swallowed by a revoked waiter.
- Makes `Close` clear public Remote intent and stop the exact Sidecar without
  reopening Desktop. An already attached Desktop may keep its exact Broker and
  app-server owner until natural exit; the next ordinary launch is native.
- Makes `Status` read-only. It reports the selected runtime, exact lease and
  readiness state without starting, stopping, repairing or adopting anything.
- While an explicit lease is active, may roll the authenticated Web/Sidecar
  public layer to an eligible validated public repair while preserving the
  Broker, app-server and Desktop processes. A Sidecar crash is recovered within
  the same exact lease. Broker or app-server loss fails closed and requires a
  new explicit recovery decision; it is never disguised as a harmless public
  restart or implicit authority to reopen Desktop.

### Transactional explicit handoff

The generation-switch and compensation paths below run only inside an explicit
`Open` or separately requested adoption. They are not public-layer recovery:
an eligible Web/Sidecar repair must preserve Broker, app-server and Desktop,
and Broker/app-server loss fails closed.

- Compares the selected immutable runtime with the active Broker receipt instead
  of treating a running scheduled task as proof that an update was adopted.
- Preflights that generation before closing Desktop. A missing selected
  runtime, an unowned managed-port listener, a pointer/task-binding change or
  any readiness identity drift fails while the native Desktop is still
  untouched. The transactional activator receives and rechecks the exact
  selected version, root and manifest again after Desktop drain.
- Switches generations only while Desktop is fully closed. Identity and
  readiness barriers are repeated after the task stops and before the new
  Desktop is accepted.
- Handles a stopped scheduled task whose exact previous-generation Sidecar is
  still attached to the previous Broker. It stops that exact Sidecar first,
  repeats the no-Desktop/no-work identity barrier, and only then retires the
  previous Broker/upstream and starts the selected generation.
- Treats the stopped-task state as requiring `sidecarConnected=false`. The
  post-stop barrier no longer waits for a Sidecar that the stopped supervisor
  is expected to terminate.
- Treats an exact native Desktop process as present even when it is not attached
  to the Broker. A disconnected-but-running Desktop is closed before the
  generation switch instead of being mistaken for an absent Desktop.
- Fails the handoff if Windows process discovery cannot be completed, and
  rechecks that no Desktop process remains after the bounded shutdown window
  before it starts the managed launcher.
- Captures the complete prior scheduled-task XML as a hash-bound rollback
  pre-image, and binds the complete selected-task XML hash to the selected
  runtime pointer. The launcher verifies the selected definition before any
  stop; after any forward start request, rollback repeatedly cancels the task
  and removes selected-generation owners before restoring the exact prior
  definition and pointer. Partial or delayed Sidecar/Broker startup cannot be
  reported as a successful update.
- Runs fresh registration, same-runtime task upgrades and current-pointer
  repair through the same effect-aware transaction. A scheduler or pointer
  write that throws after taking effect is accepted only after a live exact
  selected-pair audit; otherwise the captured task/pointer baseline is restored
  and verified.
- Blocks registration with zero writes when an already selected immutable
  generation has not been adopted. A separately requested repair reconstructs
  the exact active task/pointer pair transactionally; an ambiguous ancestry
  never overwrites the rollback predecessor.
- Compensates a failed Sidecar, Broker or selected-generation start by
  restoring the prior task and pointer and restarting that exact prior
  generation within bounded checks.
- If the inner switch restores that exact prior runtime and then reports the
  original failure, the outer on-demand controller re-resolves only the
  requested or hash-bound rollback generation, rebinds the Remote intent and
  requests Desktop recovery for that same generation. It does not validate the
  restored task against the now-stale selected object or turn a successful
  rollback into a second compensation failure.
- Binds Broker attachment to each launch with a process-scoped high-entropy
  nonce, retains only its SHA-256 digest in readiness, and revalidates the
  uniquely launched Desktop root. A stale, concurrent or foreign connection
  fails closed.
- Keeps control feedback structured and bounded. `desktop-launch/v2` records
  only allowlisted status, stage, code, correlation and feedback fields;
  exception text, paths, command lines and credentials are never serialized.
- Separates privileged control from the Desktop token. The stable dispatcher is
  the supported entry; when an explicit handoff needs privileged coordination,
  Desktop is still created from the same-user, same-session,
  medium-integrity Explorer primary token with an explicit one-launch
  environment.
- Makes the `Interactive` / `Highest` scheduled-task coordinator the sole
  managed Desktop process owner during an explicit Remote lease. The on-demand
  controller publishes a generation-bound launch intent instead of racing the
  owner.
- Handles the real exit race between a newly selected immutable generation and
  an older scheduled-task instance that is still `Running` under Task
  Scheduler's `IgnoreNew` policy. A `runtime-handoff/desktop-running` result
  waits for two consecutive observations where strict CIM process discovery
  finds no Desktop root and Broker readiness explicitly reports Desktop
  disconnected, then retries the owner request exactly once. Unknown process
  or Broker state, a stable Desktop, or a failed second request never enters a
  restart loop.
- Uses strict, throwing CIM discovery across the complete requester compensation
  path: existing-root checks, post-intent-cancellation checks and the final
  native recovery duplicate guard. An enumeration failure is reported as
  `runtime-handoff/runtime-generation-unverified`; it is never interpreted as
  zero Desktop processes and cannot authorize a duplicate native root.
- Fails closed for an explicitly generation-bound launch unless expected
  version and root are both present, valid and still match selected. A
  version-only request, root-only request, malformed pair or later mismatch
  remains unresolved with a structured diagnostic and is never converted into
  a native launch.
- Preserves the original structured failure stage and code across the
  requester, bounded native compensation and `desktop-launch/v2` receipt. A failed Remote
  launch no longer displays a green success title or collapses a precise
  `runtime-handoff/desktop-running` result into `unexpected/unexpected`.
- Rejects a Desktop-class Broker connection without a launch nonce using
  WebSocket policy close 1008. An unbound native or temporary bridge connection
  cannot be counted as the managed Desktop owner merely because it completed a
  protocol initialize.
- Aligns runtime status with the v5 owner contract. The coordinator, stable
  dispatcher and selected immutable target are verified exactly. Legacy
  headless v4 tasks and direct-takeover shortcuts remain detectable for
  migration diagnostics but are never reported as a supported ready entry.
- Does not treat a newly opened vendor root or a Store update as an implicit
  takeover request. Package and active-runtime identity are revalidated only
  when an explicit `Open` needs a handoff; otherwise the native root is
  preserved and Remote remains closed or update-pending.
- Revalidates a package refresh at three destructive-safety observations,
  including one immediately before stopping the exact Desktop root. Every
  observation requires `unsafeThreadCount=0`, the same Broker/runtime
  invocation, a `current` generation and the same root identity. Unknown CIM
  state, late work, reconnect or generation drift produces zero stops and zero
  restarts.
- During an explicitly authorized generation adoption, after
  `Stop-ScheduledTask` completes but before stopping Sidecar or Broker, the
  generation-adoption transaction repeats the complete exact-generation, Broker,
  `unsafeThreadCount=0`, `unknownCount=0` and strict-CIM barrier. A failed
  post-task-stop barrier makes zero Sidecar/Broker stop calls and compensates by
  leaving or restarting the exact V5 task.
- Uses a nonce plus PID/start-time atomic worker claim, exact intent
  compare-and-delete, and same-mutex suppression reads. Child-first launch,
  stale or dead workers, interleaved intents and late restart failure therefore
  converge without duplicate roots. Failure produces at most one bounded native
  compensation, one notification and one receipt before the v5 task is
  compensated.
- Retains the bounded natural-exit handoff helper for an explicitly requested
  adoption window. It leaves Desktop and the current runtime untouched while
  waiting for Desktop to exit normally; ordinary startup and background
  monitoring never schedule this helper.
- Serializes natural-exit workers with a dedicated mutex derived from the
  normalized DataDir. Each worker captures one expected runtime version and
  root, revalidates that fixed target before launch, and accepts success only
  when the Broker belongs to that root and `desktop-launch/v2` has a timestamp
  after this launch began with CorrelationId exactly equal to the launcher's
  returned IntentId. A concurrent worker or unrelated fresh receipt cannot
  satisfy the handoff.

### Durable control and recovery

- Monitors both legs of every Broker pair with WebSocket ping/pong heartbeats.
  Two consecutive missed deadlines remove a half-open Desktop or upstream leg;
  with the default interval and deadline, cleanup takes at most approximately
  90 seconds. The Sidecar Supervisor then reconnects the shared session and
  restores notification forwarding.
- Treats a large timer gap as sleep/resume rather than an immediate heartbeat
  failure: stale miss state is reset and both legs receive a fresh probe. It
  does not authorize Remote takeover or Desktop restart. Within an existing
  explicit lease, disconnected public-component recovery requires an
  approximately three-second consecutive safety window; any reconnect, unsafe
  work or runtime drift cancels the repair.
- Reconciles persisted `started` queue entries after Sidecar restart. Known
  terminal outcomes converge; uncertain outcomes pause later work instead of
  being replayed.
- Preserves one logical idempotency key across browser response loss and stores
  bounded mutation receipts across process restarts.
- Serializes Supervisor start and stop so an older stop cannot overwrite a newer
  running session.
- Protects Desktop resume snapshots with lifecycle revisions and uses
  authoritative terminal state, eliminating stale Stop controls and terminal
  turns that reappear as active.
- Keeps Broker and Desktop intact while a crashed Sidecar is recovered by the
  same managed supervisor.
- Treats an exact active turn's non-retryable `error` as a failed terminal
  outcome and clears its control state instead of leaving the task indefinitely
  stoppable.
- Rejects a late terminal `turn.state` from another turn as authority to clear
  the current `activeTurnId`. The fresh live-thread suite passes 37/37 for this
  mechanism; it does not claim to reproduce or close the separate, unstable
  field signal of a possible cross-client activity/message split.

### Complete, truthful task history

- Streams the complete Desktop JSONL for child-agent tasks, supports Windows
  extended-length local paths, and separates recent root-task reads from full
  child-task reads and lightweight runtime-setting recovery.
- Projects the public conversation timeline rather than commentary alone:
  reasoning summaries, commentary and final answers, bounded command details
  and output, file diffs and change counts, trusted local image activity, plan
  questions and child-agent lifecycle records remain in their original order.
  Encrypted reasoning, secret answers, collaboration polling and unknown tool
  parameters remain suppressed.
- Suppresses a standalone `<codex_internal_context>...</codex_internal_context>`
  host envelope in both app-server projections and persisted Desktop history,
  while preserving ordinary user text that quotes or discusses that reserved
  tag and preserving any real attachment carried beside it.
- Verifies one stable file snapshot, retries exactly once when either a recent
  or complete JSONL read grows, and fails closed if the writer continues
  changing it.
- Merges persisted history as the stable timeline spine while fresher app-server
  items replace matching records without duplication or same-turn reordering.
- Marks complete, partial, failed and unverified history explicitly. Invalid,
  truncated, unstable or unterminated records are never presented as a verified
  complete conversation; the task view surfaces partial or failed persisted
  history instead of silently hiding the evidence.
- Carries subagent-list integrity through Sidecar and Web pagination. Multi-page
  counts and completion text describe the accumulated list rather than only the
  last page.
- Binds every detail response to its own `streamInstanceId:sequence` cursor and
  sends that cursor back on the client's first thread-scoped SSE connection.
  Concurrent readers and unrelated-thread cache eviction therefore cannot
  replace the watermark belonging to an older snapshot; a Sidecar instance
  change produces an explicit reset and authoritative reload.

### Mobile and browser experience

- Stabilizes ordering across live events, persisted history, context compaction
  and upward pagination.
- Groups reasoning, progress, tools, file changes and child-agent activity into
  a reversible Work Log. Only the newest real public reasoning summary from the
  active turn is shown; historical reasoning and commentary output stay hidden.
  Tool, file and child-agent records remain reversible, while final answers,
  user messages and image activity remain first-class conversation content.
- Makes the composer a deterministic collapsed/expanded state machine, keeps
  send and Stop visible with many attachments, keeps offline drafts editable
  while remote mutations remain disabled, and restores the caret and bottom
  anchor. An active goal occupies its own full-width row above delivery mode and
  plan progress. The conversation composer no longer carries a persistent
  permission/approval settings button; real approval requests remain actionable.
- Adds a three-second SSE offline grace so a short native or fetch-stream
  reconnect does not flash an offline banner or gray the composer. A sustained
  disconnect still fails closed for every remote mutation.
- Keeps the last verified app-server capability for at most 30 seconds when one
  optional diagnostics refresh fails, so a healthy SSE connection does not
  gray the composer because of a single polling error. Expired or malformed
  diagnostics still fail closed, and account usage is never retained through a
  failed refresh.
- Keeps an exact live Broker lease usable when only the package/startup receipt
  is temporarily stale or unverifiable; missing/invalid receipts and any real
  Broker, Desktop, Sidecar or core capability failure still fail closed.
- Hides the Stop control when the authoritative control path is unavailable and
  disables sending until the state can be controlled safely; an unavailable
  button is never presented as an actionable interrupt.
- Reconciles multiple in-flight steer aliases one-to-one, including repeated
  identical prompts and a second browser, merges stale queue refreshes through
  the latest live thread, and restores a bounded retryable Stop control when
  terminal confirmation does not arrive.
- Keeps pending approvals, runtime-driven plan questions and completed plan
  records in the task stream.
- Uses authoritative read-back for model, reasoning, speed, permissions and
  reviewer choices; unsupported values remain visible as compatibility
  diagnostics instead of fake controls.
- Adds bounded preview, download or copy actions for attachments, local file
  references, images, command output, prompts, final answers, drafts and task
  identifiers. Absolute attachment paths from persisted history use the
  authenticated host-file resolver, so existing Codex temporary images are not
  misclassified as files outside the thread project.
- Removes standalone Codex UI directives such as `::git-stage{...}` and
  `::git-commit{...}` from projected assistant answers while preserving literal
  examples inside fenced code blocks.
- Adds an accessible action menu for top-level threads: rename, copy ID,
  archive and restore. Renames and archive changes use protected idempotent
  requests. Archival stays disabled until active work stops and durably
  releases Sidecar ownership. After commit, the UI converges current and
  archived lists with bounded read-only retries, never repeats a committed
  mutation because list read-back failed, and reports refresh failure
  separately. The app-server capability surface validated for this release
  exposes no supported pin/unpin method, so Desktop pin order remains a
  read-only mirror.
- Invalidates late file-preview requests when the user selects another file or
  closes the sheet, labels historical child-agent activity without a terminal
  record as status unverified instead of completed, and keeps nested mobile
  actions and file-detail tabs at least 44 CSS pixels tall.

## Filesystem authority change

The authenticated **Computer Files** surface follows the Windows identity of the
managed Sidecar task at `Highest` run level and can reach every detected drive
that identity can access. It is not limited to registered projects and does not
add extension, hidden-file or junction denylists on top of Windows permissions.

This is an intentional single-owner design:

- treat the app password and signed-in browser sessions as administrator-grade
  credentials;
- overwrite remains opt-in;
- deletion defaults to the Windows Recycle Bin;
- permanent deletion requires a separate confirmation;
- locked encryption, offline volumes and another Windows account's credentials
  are not bypassed.

The stable DataDir control dispatcher is the only supported implementation for
`Open`, `Close` and `Status`. The managed **Codex Remote (Safe Start)** shortcut
is retained only as an optional, backwards-compatible alias for an explicit
`Open -AllowDesktopRestart`; it points to that stable dispatcher instead of an
immutable runtime or Desktop launcher. The normal vendor Desktop entry always
stays native, and Remote never depends on the user clicking the managed
shortcut. When an explicitly authorized `Open` requires a privileged,
generation-bound handoff, ChatGPT / Codex Desktop does not inherit the
administrator token: the scheduled-task coordinator creates it from the same
user's medium-integrity Explorer primary token in the same interactive session.
The task remains `Interactive` / `Highest` while it owns an explicit Remote
lease; neither component runs as `LocalSystem`.

Registration still performs one complete owner-marker, ACL and descendant
reparse-boundary verification before trusting a DataDir. Later protection calls
in that same short-lived registration process may reuse the result only while
the exact owner marker, root ACL and immediate reparse boundary still pass. This
removes repeated full-tree ACL verification and per-item ACL reads without
weakening the first verification or a later process's checks.

## Compatibility and prerequisites

- Windows 11 x64 with PowerShell 7, Node.js 24 or later and pnpm 11.
- A supported ChatGPT / Codex Desktop package discoverable for the signed-in
  user.
- Every launch dynamically discovers the current Desktop package, bundled
  app-server and capability surface; no WindowsApps version directory is
  pinned. A normal Codex update does not rebuild the stable dispatcher and does
  not automatically open Remote.
- `CODEX_APP_SERVER_WS_URL` remains process-scoped and is never persisted.
- Public HTTPS exposes only the authenticated Sidecar route. Broker and raw
  app-server listeners remain loopback-only.
- An incompatible future Desktop build fails open to native Desktop and reports
  Remote unavailable.

## Upgrade

From a clean checkout of the sealed candidate:

```powershell
pnpm install --frozen-lockfile
pnpm check
.\scripts\windows\Register-CodexLocalRemoteStartup.ps1 -NoStart
```

`-NoStart` installs and selects the immutable runtime without stopping the
currently running Desktop, Broker or Sidecar. It also installs the stable
DataDir dispatcher and repairs the exact managed shortcut as an optional
explicit-Open alias; it does not open Remote or replace the normal vendor
Desktop entry.

Use the installed dispatcher explicitly:

```powershell
$control = Join-Path $env:LOCALAPPDATA `
  'CodexLocalRemote\control\CodexLocalRemote.Control.ps1'
& $control -Operation Status
& $control -Operation Open
& $control -Operation Close
```

`Open` repairs or starts the public chain without a Desktop restart whenever
possible. If it reports that one Desktop handoff is required, repeat `Open`
with `-AllowDesktopRestart` only under explicit restart authority. `Close`
clears public intent and stops Sidecar without reopening Desktop; an attached
owner exits naturally. See
[`windows-install.md`](windows-install.md) for the full status checks.

An optional companion global AI control skill calls `Status` directly. For `Open` and
`Close`, it checks the current Windows token before execution: an administrator
token calls the dispatcher directly, while a medium token uses the already
enabled Windows `sudo` once. The dispatcher never self-elevates into a second
process, so structured output, exit status, mutex ownership and intent remain
on one execution path.

An explicitly requested unattended adoption window may still wait for a
natural Desktop exit:

```powershell
.\scripts\windows\Complete-CodexLocalRemoteDeferredHandoff.ps1 `
  -WaitForNaturalDesktopExit
```

This mode waits without closing Desktop. It performs the handoff only after a
later natural exit passes the strict process and Broker-disconnect barrier. It
is never armed by normal startup, update, restart or sleep/resume.

## Rollback

To select the previous validated immutable runtime without terminating the
current Desktop:

```powershell
.\scripts\windows\Rollback-CodexLocalRemoteRuntime.ps1
```

The previous runtime becomes eligible only for a later explicit `Open` or
separately requested adoption. Rollback does not authorize a hot switch,
Broker restart, Desktop restart or unrelated process stop.

## Verification and release integrity

The sealed source must pass `pnpm check`, the standalone public-safety scan and
the focused Windows, JSONL reader, domain/runtime and Sidecar-to-Web integrity
suites. Responsive acceptance covers all six supported viewports, including
412×915.

The earlier startup, package-refresh and heartbeat baseline passed a combined
focused run of 11 files and 220 tests. Its subsequent full `pnpm check` passed
formatting, lint, type checking, 96 test files with 1458/1458 tests, the
production build and a public-safety scan of 323 files. Those counts predate the
native-default control delta and must not be described as final-candidate or
live-adoption evidence.

The current delta adds focused source regressions for the unavailable Stop
state, non-retryable `error` terminal projection, fresh thread-scoped SSE
replay, late foreign-turn terminal rejection and native-default on-demand
control. The client-bound SSE cursor passes the fresh Sidecar 51/51 suite,
including concurrent readers plus cache eviction; the fresh live-thread suite
passes 37/37 for the foreign-turn guard. A 71/71 Web state/API combination also
covers the one-time snapshot-cursor subscription handoff, overlap de-duplication
and the stale-route callback race, so a late detail response from task A cannot
replace task B's already-bound cursor.

The 2026-08-01 current-tree `pnpm check` passed formatting, lint, type checking,
106/106 test files with 1565/1565 tests, the production build and the embedded
public-safety scan of 351 files. Earlier closure attempts stopped before product
tests on two formatting findings and one over-narrow TypeScript test-fixture
inference; after those test-only corrections, one complete closure run passed.
A standalone public-safety scan remains a release-commit gate after document
closeout.

The final delta review also closed release-blocking edge cases. Failed
`Open` compensation can stop a just-started task only when exact-generation
readiness proves it idle; otherwise it preserves the running generation,
Remote intent and a structured recovery intent. Thread rename, archive and
restore readback now traverses both current and archived lists with a bounded
cursor walk, requires proof of absence from the other list, and preserves
already-loaded list tails. The immediate restart barrier now keeps desired-mode
validation, exact package/creation-identity shutdown, task drain and installed
Open under one control mutex; focused verification covers pre-stop cancellation,
post-stop supersession, empty or foreign executable paths and PID/creation
drift. The Web diagnostics grace is covered through the real composer control
decision rather than only a generic snapshot helper. PowerShell AST, focused
tests and the complete suite pass. The public acceptance discovery that exposed
a Codex internal-context envelope as a user message is now covered by both live
projection and persisted-history regressions; final independent source re-review
remains required after this delta.

The owner explicitly deferred a new real cold-restart timing run for this final
restart-path delta to later field acceptance. This closeout did not stop or
restart the running Desktop. The existing live public lease supplied functional
Web evidence, but it must not be cited as live proof of the new locked restart
barrier or its timing.

A subsequent Codex package update exposed a host-specific control-plane stall:
`Get-NetTCPConnection` did not return while native `netstat.exe` remained
responsive, leaving startup at `preflight` before Desktop was closed. Every
supported startup, status, handoff, registration and exact-stop path now uses a
strictly parsed native listener snapshot with a five-second hard timeout;
fixture-only provider shims remain isolated behind the test gate. The focused
Windows regression run passed 11 files and 212/212 tests, and a source-tree
status probe returned without stopping or restarting Desktop. This is
no-restart source evidence only; adoption and real remote readiness still wait
for the separately authorized final restart.

Two real `-NoStart` attempts against the pre-fix candidate were rejected by
Windows Task Scheduler without adopting a partial generation. Both attempts
restored the exact prior task/runtime-pointer pair; Desktop/Codex process
identities, managed listeners and task running state were unchanged. The
counterexample isolated an invalid zero-retry definition that still emitted a
`RestartOnFailure` block with `Count=0`. The current definition omits that block,
retains exact recognition of legacy `3/PT1M` tasks, and normalizes the real
scheduler's null trigger collection to zero triggers. A never-started temporary
task schema probe accepted the corrected definition, reported
`RestartCount=0` and an empty restart interval, and left no task behind. The
focused Windows registration/readback suites pass 146/146. Final registration
of the sealed release commit remains a separate live gate.

A field observation still suggests a possible P0 cross-client
activity/message split, but it has not reproduced stably and is not yet
severity-confirmed. The release remains blocked until the same sealed
immutable candidate passes real Desktop, loopback Web, public desktop Web and
public mobile Web validation; source regressions cannot close that field signal
by themselves.

Publication is additionally gated on real four-surface validation of that same
immutable candidate:

1. selected and active runtime identities match;
2. normal startup, update, Windows restart and sleep/resume remain native;
3. one explicit `Open` reaches `remote-connected`, using zero Desktop restarts
   when possible and at most one authorized handoff when necessary;
4. an eligible Web/Sidecar repair and same-lease Sidecar crash recovery preserve
   Broker/app-server/Desktop, while Broker loss fails closed; `Close` disables
   the public lease without reopening Desktop;
5. no visible terminal hosts the supervisor;
6. loopback and configured public readiness both return HTTP 200;
7. Desktop, loopback Web, public desktop Web and 412×915 public mobile Web
   observe the same safe smoke-test thread and turn, including Stop
   convergence, terminal `error` and fresh-SSE replay;
8. the scheduled task runs as `Interactive` / `Highest` with the exact v5 owner
   coordinator definition, the stable DataDir dispatcher validates and invokes
   only the selected immutable runtime, Desktop uses the same-user/same-session
   medium-integrity Explorer token, and the administrator file flow passes in
   an isolated temporary directory.

Repository automation cannot replace these live receipts. The user-designated
independent final audit must report PASS or an explicit evidence BLOCK against
the final commit. For this candidate, the owner explicitly permits the new cold
restart timing/barrier field run to remain deferred and will validate it later;
no release record may represent that deferred item as passed. All non-waived
gates must pass before a tag is created. The release tag, GitHub Release and
`main` must all resolve to the same commit.

## Known limitations

- This is an unofficial self-hosted companion, not an OpenAI product.
- Desktop integration relies on a compatibility hook and must be revalidated
  after future Desktop or app-server changes.
- Opening the normal vendor shortcut remains native. Remote begins only through
  explicit `Open`; if a Desktop handoff is necessary, the caller must separately
  authorize that one bounded restart.
- A running Desktop cannot be hot-switched between Broker generations.
- Large root tasks intentionally load a recent bounded window first; older
  history remains available through pagination.
- Child-agent tasks are read-only in the Web UI and must be continued from their
  controlling parent.
- Approval and plan controls are shown only when the current runtime provides an
  explicit schema; unknown shapes fail closed.
