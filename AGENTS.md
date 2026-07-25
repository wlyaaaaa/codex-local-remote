# Codex Local Remote contributor guidance

This repository is a public, unofficial companion for the Codex desktop app.

## Product boundaries

- The browser UI is a product surface, not a raw JSON-RPC or log viewer.
- The supported control path owns its own `codex app-server` child process over
  stdio. Never expose app-server directly to the network.
- Threads already running inside the native desktop process are read-only
  snapshots. Do not claim that they can be steered or interrupted.
- Show only reasoning summaries and tool activity exposed by Codex. Never claim
  access to hidden chain-of-thought.
- Model and reasoning changes apply to a new turn; they do not hot-swap an
  in-flight turn.
- The public repository must never contain real hostnames, credentials,
  passwords, cookies, auth databases, conversation logs, private file paths, or
  screenshots from a real machine.

## Engineering rules

- TypeScript is strict across the monorepo.
- Browser code depends only on project-owned contracts, never raw app-server
  protocol types.
- Treat model output, Markdown, ANSI, tool results, filenames, and diff content
  as untrusted input.
- File APIs are read-only and constrained to registered project roots. Resolve
  real paths before containment checks and deny symlink/junction escape.
- Mutating HTTP requests require authentication, same-origin validation, CSRF
  protection, and an idempotency key where retries are plausible.
- Do not log prompts, responses, file contents, passwords, cookies, or Codex
  credentials.
- User-facing copy is Chinese-first and uses product language rather than
  protocol names.
- Every primary touch target is at least 44 by 44 CSS pixels.

## Verification

- `pnpm check` is the default local acceptance command.
- Security tests must cover authentication throttling, path traversal,
  symlink/junction escape, origin checks, unsafe Markdown, and session expiry.
- Browser tests cover 360x800, 390x844, 412x915, 768x1024, 1280x800, and
  1440x900 viewports.
- A completion claim requires a real app-server smoke test when Codex is
  available and an explicit degraded result when it is not.
