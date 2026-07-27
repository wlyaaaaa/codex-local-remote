# Codex Local Remote contributor guidance

This repository is a public, unofficial companion for the Codex desktop app.

## Product boundaries

- The browser UI is a product surface, not a raw JSON-RPC or log viewer.
- The supported control path uses one loopback-only Broker that owns one
  `codex app-server`. Codex Desktop and the Sidecar connect to that Broker as
  separate WebSocket clients. Never expose either raw WebSocket listener to the
  LAN or public network.
- app-server subscriptions are connection-scoped. Before a phone-created
  thread may start its first turn, the Broker must make the idle shell durable
  with a hidden `thread/name/set` when needed, complete the Desktop
  `thread/resume` barrier, and fail closed if Desktop is absent.
- Desktop must remain usable through the Broker when the Sidecar is absent.
  Sidecar loss must not create a second app-server owner or terminate Desktop's
  task.
- New conversations may use a locally registered project or an isolated
  projectless temporary root. The file gateway remains limited to registered
  projects.
- Show only reasoning summaries and tool activity exposed by Codex. Never claim
  access to hidden chain-of-thought.
- Model and reasoning changes apply to a new turn; they do not hot-swap an
  in-flight turn.
- Windows Desktop integration currently depends on the hidden
  `CODEX_APP_SERVER_WS_URL` compatibility hook. Treat every Desktop or bundled
  Codex upgrade as unverified until the shared-owner path passes a real-machine
  acceptance test.
- The public repository must never contain real hostnames, credentials,
  passwords, cookies, auth databases, conversation logs, private file paths, or
  screenshots from a real machine.

## Engineering rules

- TypeScript is strict across the monorepo.
- Browser code depends only on project-owned contracts, never raw app-server
  protocol types.
- Broker-injected RPC ids are reserved implementation details and must never be
  forwarded to either product client.
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
- A completion claim for the shared-owner path requires real-machine smoke
  tests with Desktop and Sidecar attached to the same Broker, covering one
  registered-project thread and one isolated projectless thread. It must verify
  sidebar visibility, matching thread/turn ids, live events, and fail-closed
  behavior when Desktop is absent. Record an explicit degraded result when that
  test cannot run.
