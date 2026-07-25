# Contributing

Start with [the architecture](docs/architecture.md) and
[the threat model](docs/threat-model.md). This project intentionally keeps the
browser contract separate from the evolving Codex app-server protocol.

```powershell
pnpm install --frozen-lockfile
pnpm check
```

Changes to authentication, file access, approvals, Markdown rendering, Funnel
configuration, or protocol adaptation require focused negative tests. UI changes
must remain usable at 360 CSS pixels and keep primary touch targets at least
44×44 CSS pixels.

Do not include real hostnames, user paths, credentials, conversations, project
files, runtime databases, or screenshots from a real machine in commits,
fixtures, issues, or pull requests.
