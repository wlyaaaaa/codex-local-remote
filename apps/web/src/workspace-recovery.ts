import { ApiRequestError } from "./api";

export const WORKSPACE_RECOVERY_RETRY_MS = 2_000;
export const DIAGNOSTICS_LAST_KNOWN_TTL_MS = 30_000;

export type WorkspaceLoadFailurePolicy = {
  kind: "authentication" | "transient" | "fatal";
  preserveSnapshot: boolean;
  retryAfterMs: number | undefined;
};

const TRANSIENT_STATUSES = new Set([0, 502, 503, 504]);

export function retainLastKnownDiagnosticSnapshot<T extends { generatedAt: string }>(
  refreshed: T | undefined,
  current: T | undefined,
  nowMs = Date.now(),
): T | undefined {
  if (refreshed !== undefined) return refreshed;
  if (current === undefined) return undefined;
  const generatedAtMs = Date.parse(current.generatedAt);
  if (!Number.isFinite(generatedAtMs)) return undefined;
  const ageMs = nowMs - generatedAtMs;
  return ageMs >= 0 && ageMs <= DIAGNOSTICS_LAST_KNOWN_TTL_MS ? current : undefined;
}

export function workspaceLoadFailurePolicy(
  error: unknown,
  hasSnapshot: boolean,
): WorkspaceLoadFailurePolicy {
  if (error instanceof ApiRequestError && error.status === 401) {
    return {
      kind: "authentication",
      preserveSnapshot: false,
      retryAfterMs: undefined,
    };
  }
  if (error instanceof ApiRequestError && TRANSIENT_STATUSES.has(error.status)) {
    return {
      kind: "transient",
      preserveSnapshot: hasSnapshot,
      retryAfterMs: WORKSPACE_RECOVERY_RETRY_MS,
    };
  }
  return {
    kind: "fatal",
    preserveSnapshot: hasSnapshot,
    retryAfterMs: undefined,
  };
}
