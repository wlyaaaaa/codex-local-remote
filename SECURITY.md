# Security policy

Codex Local Remote sits between the public internet and a local coding agent.
Please do not publish a working exploit, credential, conversation, hostname, or
machine snapshot in a public issue.

## Reporting a vulnerability

Use GitHub's private security-advisory reporting flow for this repository.
Include the affected version, prerequisites, impact, and the smallest safe
reproduction. Use synthetic projects and credentials.

Particularly sensitive reports include:

- authentication or session bypass;
- cross-origin state changes;
- path, junction, or symlink escape;
- XSS through Markdown, tool output, diffs, filenames, SVG, or downloads;
- exposure of raw app-server methods;
- approval spoofing or replay;
- a Funnel configuration change that overwrites another handler.

## Supported versions

Until the first stable release, only the most recent tagged preview is supported.
Protocol compatibility is checked against the Codex version listed in each
release note.

## Safe defaults

The project never asks reporters to attach real Codex auth data, real prompts,
private source code, or the Sidecar runtime state file. Redacted diagnostics should
contain versions, capability states, request IDs, and bounded error codes only.
