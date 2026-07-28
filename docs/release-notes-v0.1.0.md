# Codex Local Remote v0.1.0

Your ChatGPT / Codex Desktop tasks, available from a polished mobile browser
without exposing the local app-server to the public internet.

## Highlights

- Continue the same Desktop task from phone, tablet, or another browser.
- Watch live replies, tool calls, file edits, subagents, plans, approvals, and
  context compaction.
- Queue a next-turn message, steer the current turn, stop work, and answer
  dynamic approval or plan questions.
- Create project and no-project tasks using the models, reasoning levels, and
  speed modes reported by the current Desktop runtime.
- Upload a file from the browsing device, preview and download registered local
  files, and inspect red/green diffs.
- Inspect context usage, account rate-limit windows, reset times in UTC+8, and
  the exact task ID.
- Use the Chinese-first interface or switch to English.

## Windows lifecycle

- A loopback Broker shares one Desktop app-server with the Sidecar; it is never
  exposed directly through Funnel.
- A hidden scheduled task starts the managed runtime at logon and restarts
  bounded failures.
- The safe launcher opens ChatGPT / Codex Desktop with remote control when the
  runtime is healthy, or starts the native Desktop fail-open when it is not.
- Desktop runtime discovery follows the currently installed package instead of
  pinning a WindowsApps version directory. Unknown incompatible versions are
  reported explicitly and do not leave a persistent app-server override behind.

## Verification

These were the historical release-time reports, not evidence for later `main`:

- repository acceptance reported 80 test files and 943 tests;
- public-safety reported 257 files;
- public-browser checks covered mobile and wide layouts, task creation, live
  state, file upload/download, approval rendering, and notice dismissal.

The exact Codex Desktop package/runtime version was not recorded for v0.1.0.
Compatibility is therefore **unverified**, and later independent review found
lifecycle and long-thread defects that are not backported to this tag. The tag
remains immutable for provenance; use a newer repaired release.

This is an unofficial, self-hosted companion for ChatGPT / Codex Desktop.
