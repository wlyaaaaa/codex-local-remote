import type { ConversationItem, RemoteEvent, ThreadDetail } from "@codex-local-remote/contracts";

export type ContextCompactionRequestState = "idle" | "requesting" | "accepted";
export type ContextCompactionResolution = "pending" | "succeeded" | "failed";

type ContextCompactionTerminalState = "idle" | "complete" | "failed";

export interface ContextCompactionAttempt {
  threadId: string;
  idempotencyKey: string;
  knownItemIds: readonly string[];
  itemId?: string;
  turnId?: string;
  started: boolean;
  completed: boolean;
  itemFailed: boolean;
  terminalState?: ContextCompactionTerminalState;
  recoveryRequired: boolean;
  terminalSnapshotsWithoutEvidence: number;
}

export interface ContextCompactionProgress {
  attempt: ContextCompactionAttempt;
  resolution: ContextCompactionResolution;
}

export interface ContextCompactionRequestFlight {
  idempotencyKey: string;
  promise: Promise<void>;
}

export function latestContextCompaction(
  items: readonly ConversationItem[],
): Extract<ConversationItem, { kind: "tool" }> | undefined {
  return [...items]
    .reverse()
    .find((item) => item.kind === "tool" && item.operation === "context-compaction") as
    | Extract<ConversationItem, { kind: "tool" }>
    | undefined;
}

export function canRequestContextCompaction(
  thread: ThreadDetail,
  online: boolean,
  requestState: ContextCompactionRequestState,
): boolean {
  const latest = latestContextCompaction(thread.items);
  return (
    online &&
    requestState === "idle" &&
    thread.mode === "managed" &&
    !thread.parentThreadId &&
    !thread.activeTurnId &&
    latest?.status !== "running" &&
    thread.availableActions.reply
  );
}

export function isContextCompactionBusy(
  thread: ThreadDetail,
  requestState: ContextCompactionRequestState,
): boolean {
  const latest = latestContextCompaction(thread.items);
  return requestState !== "idle" || latest?.status === "running";
}

export function contextCompactionAttemptFromThread(
  thread: ThreadDetail,
  idempotencyKey: string,
): ContextCompactionAttempt {
  return {
    threadId: thread.id,
    idempotencyKey,
    knownItemIds: thread.items
      .filter((item) => item.kind === "tool" && item.operation === "context-compaction")
      .map((item) => item.id),
    started: false,
    completed: false,
    itemFailed: false,
    recoveryRequired: false,
    terminalSnapshotsWithoutEvidence: 0,
  };
}

export function applyContextCompactionEvents(
  attempt: ContextCompactionAttempt,
  events: readonly RemoteEvent[],
): ContextCompactionProgress {
  let next = attempt;
  for (const event of events) {
    if (event.threadId !== attempt.threadId) continue;
    if (event.type === "thread.item") {
      next = applyContextCompactionItemEvent(next, event);
      continue;
    }
    if (event.type === "turn.state" && next.turnId && event.turnId === next.turnId) {
      const state = asTerminalState(asRecord(event.payload).state);
      if (state) next = { ...next, terminalState: state };
    }
  }
  return progress(next);
}

export function markContextCompactionRecoveryRequired(
  attempt: ContextCompactionAttempt,
): ContextCompactionAttempt {
  return attempt.recoveryRequired ? attempt : { ...attempt, recoveryRequired: true };
}

export function reconcileContextCompactionSnapshot(
  attempt: ContextCompactionAttempt,
  thread: ThreadDetail,
): ContextCompactionProgress {
  if (thread.id !== attempt.threadId) return progress(attempt);

  const candidate = snapshotCompactionCandidate(attempt, thread.items);
  const threadIsActive =
    Boolean(thread.activeTurnId) ||
    thread.state === "running" ||
    thread.state === "waiting-for-approval";
  let next = attempt;

  if (candidate?.status === "running" && thread.activeTurnId) {
    if (!attempt.itemId && !attempt.turnId) {
      next = {
        ...attempt,
        itemId: candidate.id,
        turnId: thread.activeTurnId,
        started: true,
        terminalSnapshotsWithoutEvidence: 0,
      };
    } else if (attempt.itemId === candidate.id && attempt.turnId === thread.activeTurnId) {
      next = {
        ...attempt,
        started: true,
        terminalSnapshotsWithoutEvidence: 0,
      };
    }
    return progress(next);
  }

  const stableTerminal = threadIsActive ? undefined : asTerminalState(thread.state);
  if (candidate && candidate.status !== "running") {
    const belongsToBoundAttempt =
      Boolean(attempt.itemId && attempt.turnId && attempt.started) &&
      candidate.id === attempt.itemId;
    if (!belongsToBoundAttempt) {
      return stableTerminal ? { attempt: next, resolution: "failed" } : progress(next);
    }

    next = {
      ...attempt,
      completed: candidate.status === "complete",
      itemFailed: candidate.status === "failed",
      terminalSnapshotsWithoutEvidence: 0,
      ...(stableTerminal === undefined ? {} : { terminalState: stableTerminal }),
    };
    if (
      candidate.status === "complete" &&
      stableTerminal === "complete" &&
      thread.availableActions.reply
    ) {
      return { attempt: next, resolution: "succeeded" };
    }
    if (candidate.status === "failed" || stableTerminal === "failed" || stableTerminal === "idle") {
      return { attempt: next, resolution: "failed" };
    }
    return progress(next);
  }

  if (stableTerminal) {
    next = {
      ...attempt,
      terminalSnapshotsWithoutEvidence: attempt.terminalSnapshotsWithoutEvidence + 1,
    };
    const requiredConfirmations = attempt.recoveryRequired ? 2 : 3;
    if (next.terminalSnapshotsWithoutEvidence >= requiredConfirmations) {
      return { attempt: next, resolution: "failed" };
    }
  }
  return progress(next);
}

export function beginContextCompactionRequest(
  current: ContextCompactionRequestFlight | undefined,
  send: (idempotencyKey: string) => Promise<void>,
  createIdempotencyKey: () => string = () => crypto.randomUUID(),
): ContextCompactionRequestFlight {
  if (current) return current;
  const idempotencyKey = createIdempotencyKey();
  return {
    idempotencyKey,
    promise: send(idempotencyKey),
  };
}

function applyContextCompactionItemEvent(
  attempt: ContextCompactionAttempt,
  event: RemoteEvent,
): ContextCompactionAttempt {
  const payload = asRecord(event.payload);
  const lifecycle = payload.lifecycle;
  if (lifecycle !== "started" && lifecycle !== "completed") return attempt;
  if (!event.turnId) return attempt;
  const items = Array.isArray(payload.item) ? payload.item : [];
  let next = attempt;

  for (const rawItem of items) {
    const item = asRecord(rawItem);
    const itemId = typeof item.id === "string" ? item.id : undefined;
    if (
      !itemId ||
      item.operation !== "context-compaction" ||
      attempt.knownItemIds.includes(itemId)
    ) {
      continue;
    }
    const status =
      item.status === "running" || item.status === "complete" || item.status === "failed"
        ? item.status
        : undefined;
    if (!status) continue;

    if (!next.itemId || !next.turnId) {
      if (lifecycle !== "started" || status !== "running") continue;
      next = {
        ...next,
        itemId,
        turnId: event.turnId,
      };
    }
    if (next.itemId !== itemId || next.turnId !== event.turnId) continue;

    if (lifecycle === "started" && status === "running") {
      next = { ...next, started: true };
    } else if (lifecycle === "completed" && status === "complete") {
      next = { ...next, completed: true };
    } else if (lifecycle === "completed" && status === "failed") {
      next = { ...next, itemFailed: true };
    }
  }
  return next;
}

function snapshotCompactionCandidate(
  attempt: ContextCompactionAttempt,
  items: readonly ConversationItem[],
): Extract<ConversationItem, { kind: "tool" }> | undefined {
  if (attempt.itemId) {
    const bound = items.find(
      (item) =>
        item.id === attempt.itemId &&
        item.kind === "tool" &&
        item.operation === "context-compaction",
    );
    return bound?.kind === "tool" ? bound : undefined;
  }
  return [...items]
    .reverse()
    .find(
      (item) =>
        item.kind === "tool" &&
        item.operation === "context-compaction" &&
        !attempt.knownItemIds.includes(item.id),
    ) as Extract<ConversationItem, { kind: "tool" }> | undefined;
}

function progress(attempt: ContextCompactionAttempt): ContextCompactionProgress {
  if (attempt.terminalState === "failed" || attempt.terminalState === "idle") {
    return { attempt, resolution: "failed" };
  }
  if (
    attempt.terminalState === "complete" &&
    attempt.started &&
    attempt.completed &&
    !attempt.itemFailed
  ) {
    return { attempt, resolution: "succeeded" };
  }
  if (attempt.terminalState === "complete" && attempt.itemFailed) {
    return { attempt, resolution: "failed" };
  }
  return { attempt, resolution: "pending" };
}

function asTerminalState(value: unknown): ContextCompactionTerminalState | undefined {
  return value === "idle" || value === "complete" || value === "failed" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
