import type { RunState } from "@codex-local-remote/contracts";

export const WORKSPACE_REFRESH_MS = 10_000;

export function threadRefreshDelay(state: RunState | undefined) {
  return state === "running" ? 3_000 : 10_000;
}

export function canRefreshDocument(visibilityState: DocumentVisibilityState) {
  return visibilityState === "visible";
}
