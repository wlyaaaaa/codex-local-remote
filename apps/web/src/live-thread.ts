import type {
  ConversationItem,
  RemoteEvent,
  RunState,
  ThreadDetail,
  ThreadSummary,
  UsageCredits,
  UsageSnapshot,
  UsageWindow,
} from "@codex-local-remote/contracts";

const runStates = new Set<RunState>([
  "idle",
  "running",
  "waiting-for-approval",
  "failed",
  "complete",
]);

export function detailFromThreadSummary(summary: ThreadSummary): ThreadDetail {
  return {
    ...summary,
    items: [],
    availableActions: {
      changeModelNextTurn: false,
      interrupt: false,
      reply: false,
      steer: false,
    },
  };
}

export function applyThreadRemoteEvents(
  snapshot: ThreadDetail,
  events: readonly RemoteEvent[],
  options: { replayed?: boolean } = {},
): ThreadDetail {
  let thread = snapshot;
  const accumulatedDeltas = new Map<string, string>();

  for (const event of events) {
    if (event.threadId !== snapshot.id) {
      continue;
    }
    switch (event.type) {
      case "turn.state":
        thread = applyTurnState(thread, event);
        break;
      case "thread.item":
        thread = applyThreadItem(thread, event, accumulatedDeltas, options.replayed === true);
        break;
      case "thread.updated":
        thread = applyThreadUpdate(thread, event);
        break;
      default:
        break;
    }
  }
  return thread;
}

export function applyUsageRemoteEvents(
  snapshot: UsageSnapshot | undefined,
  threadId: string,
  events: readonly RemoteEvent[],
): UsageSnapshot | undefined {
  let usage = snapshot;
  for (const event of events) {
    if (event.type !== "usage.updated" || (event.threadId && event.threadId !== threadId)) {
      continue;
    }
    const payload = asRecord(event.payload);
    const tokenUsage = asRecord(payload.tokenUsage);
    const last = asRecord(tokenUsage.last);
    const usedTokens = asFiniteNumber(last.totalTokens);
    const limitTokens = asFiniteNumber(tokenUsage.modelContextWindow);
    const windows = projectUsageWindows(payload);
    const credits = projectUsageCredits(payload);
    const current = usage ?? { updatedAt: event.emittedAt, windows: [] };
    const currentContext = current.context;
    const nextUsedTokens = usedTokens ?? currentContext?.usedTokens;
    const nextLimitTokens = limitTokens ?? currentContext?.limitTokens;
    const usedPercent =
      nextUsedTokens !== undefined && nextLimitTokens !== undefined && nextLimitTokens > 0
        ? clampPercent((nextUsedTokens / nextLimitTokens) * 100)
        : currentContext?.usedPercent;
    const context =
      nextUsedTokens === undefined && nextLimitTokens === undefined && usedPercent === undefined
        ? undefined
        : {
            ...(nextUsedTokens === undefined ? {} : { usedTokens: nextUsedTokens }),
            ...(nextLimitTokens === undefined ? {} : { limitTokens: nextLimitTokens }),
            ...(usedPercent === undefined ? {} : { usedPercent }),
          };

    usage = {
      ...current,
      updatedAt: event.emittedAt,
      ...(windows.length === 0 ? {} : { windows }),
      ...(credits.length === 0 ? {} : { credits }),
      ...(context === undefined ? {} : { context }),
    };
  }
  return usage;
}

function applyTurnState(thread: ThreadDetail, event: RemoteEvent): ThreadDetail {
  const payload = asRecord(event.payload);
  const state = asRunState(payload.state);
  if (!state) {
    return thread;
  }
  const turn = asRecord(payload.turn);
  const turnId = productString(event.turnId, 256) ?? productString(turn.id, 256);
  return withRunState(thread, state, event.emittedAt, turnId);
}

function applyThreadItem(
  thread: ThreadDetail,
  event: RemoteEvent,
  accumulatedDeltas: Map<string, string>,
  replayed: boolean,
): ThreadDetail {
  const payload = asRecord(event.payload);
  const kind = productString(payload.kind, 64);
  if (kind === "reasoning-summary-delta" || kind === "assistant-message-delta") {
    const itemId = productString(payload.itemId, 512);
    const delta = productString(payload.delta, 32_768, true);
    if (!itemId || !delta) {
      return thread;
    }
    const itemKind = kind === "reasoning-summary-delta" ? "reasoning-summary" : "assistant-message";
    const deltaKey = `${itemKind}:${itemId}`;
    const aggregate = `${accumulatedDeltas.get(deltaKey) ?? ""}${delta}`;
    accumulatedDeltas.set(deltaKey, aggregate);
    const index = thread.items.findIndex((item) => item.id === itemId && item.kind === itemKind);
    if (index < 0) {
      return {
        ...thread,
        updatedAt: event.emittedAt,
        items: [
          ...thread.items,
          {
            id: itemId,
            kind: itemKind,
            text: aggregate,
            createdAt: event.emittedAt,
          },
        ],
      };
    }
    const existing = thread.items[index];
    if (!existing || !("text" in existing)) {
      return thread;
    }
    const text = replayed
      ? reconcileReplayedStreamText(existing.text, aggregate, delta)
      : `${existing.text}${delta}`;
    if (text === existing.text) {
      return thread.updatedAt === event.emittedAt
        ? thread
        : { ...thread, updatedAt: event.emittedAt };
    }
    const items = [...thread.items];
    items[index] = { ...existing, text };
    return { ...thread, items, updatedAt: event.emittedAt };
  }

  const incoming = Array.isArray(payload.item)
    ? payload.item
        .map((item) => asConversationItem(item))
        .filter((item): item is ConversationItem => item !== undefined)
    : [];
  if (incoming.length === 0) {
    // Deliberately ignore unknown item payloads, including raw reasoning text.
    return thread;
  }
  let items = thread.items;
  for (const item of incoming) {
    const index = items.findIndex((candidate) => candidate.id === item.id);
    if (index < 0) {
      items = [...items, item];
      continue;
    }
    const existing = items[index];
    const replacement =
      item.createdAt || !existing?.createdAt ? item : { ...item, createdAt: existing.createdAt };
    const next = [...items];
    next[index] = replacement;
    items = next;
  }
  return { ...thread, items, updatedAt: event.emittedAt };
}

function applyThreadUpdate(thread: ThreadDetail, event: RemoteEvent): ThreadDetail {
  const payload = asRecord(event.payload);
  const settings = asRecord(payload.threadSettings);
  const title =
    productString(payload.name, 200) ??
    productString(payload.title, 200) ??
    productString(asRecord(payload.thread).name, 200);
  const model =
    productString(payload.model, 256) ??
    productString(settings.model, 256) ??
    productString(asRecord(payload.thread).model, 256);
  const hasEffort =
    Object.hasOwn(payload, "reasoningEffort") ||
    Object.hasOwn(payload, "effort") ||
    Object.hasOwn(settings, "reasoningEffort") ||
    Object.hasOwn(settings, "effort");
  const rawEffort = Object.hasOwn(payload, "reasoningEffort")
    ? payload.reasoningEffort
    : Object.hasOwn(payload, "effort")
      ? payload.effort
      : Object.hasOwn(settings, "reasoningEffort")
        ? settings.reasoningEffort
        : settings.effort;
  const effort = productString(rawEffort, 128);
  const state =
    asRunState(payload.state) ??
    projectStatus(payload.status) ??
    projectStatus(asRecord(payload.thread).status);

  let next: ThreadDetail = {
    ...thread,
    updatedAt: event.emittedAt,
    ...(title === undefined ? {} : { title }),
    ...(model === undefined ? {} : { model }),
  };
  if (hasEffort) {
    if (rawEffort === null) {
      const { reasoningEffort: _reasoningEffort, ...withoutEffort } = next;
      next = withoutEffort;
    } else if (effort !== undefined) {
      next = { ...next, reasoningEffort: effort };
    }
  }
  return state ? withRunState(next, state, event.emittedAt) : next;
}

function withRunState(
  thread: ThreadDetail,
  state: RunState,
  updatedAt: string,
  turnId?: string,
): ThreadDetail {
  const canControl =
    thread.mode === "managed" &&
    (thread.availableActions.changeModelNextTurn ||
      thread.availableActions.interrupt ||
      thread.availableActions.reply ||
      thread.availableActions.steer);
  const active = state === "running" || state === "waiting-for-approval";
  const activeTurnId = turnId ?? thread.activeTurnId;
  const { activeTurnId: _activeTurnId, ...withoutActiveTurn } = thread;
  return {
    ...withoutActiveTurn,
    state,
    updatedAt,
    ...(active && activeTurnId ? { activeTurnId } : {}),
    availableActions: {
      changeModelNextTurn: canControl,
      interrupt: canControl && active,
      reply: canControl && !active,
      steer: canControl && active,
    },
  };
}

function reconcileReplayedStreamText(current: string, aggregate: string, delta: string): string {
  if (current === aggregate || current.startsWith(aggregate) || current.endsWith(aggregate)) {
    return current;
  }
  if (aggregate.startsWith(current)) {
    return aggregate;
  }
  return `${current}${delta}`;
}

function projectStatus(value: unknown): RunState | undefined {
  const statusRecord = asRecord(value);
  const status = productString(statusRecord.type, 64) ?? productString(value, 64);
  if (status === "active") {
    const flags = Array.isArray(statusRecord.activeFlags)
      ? statusRecord.activeFlags.filter((flag): flag is string => typeof flag === "string")
      : [];
    return flags.includes("waitingOnApproval") || flags.includes("waitingOnUserInput")
      ? "waiting-for-approval"
      : "running";
  }
  if (status === "systemError" || status === "failed") {
    return "failed";
  }
  if (status === "completed" || status === "complete") {
    return "complete";
  }
  if (status === "idle" || status === "notLoaded") {
    return "idle";
  }
  return undefined;
}

function asRunState(value: unknown): RunState | undefined {
  return typeof value === "string" && runStates.has(value as RunState)
    ? (value as RunState)
    : undefined;
}

function asConversationItem(value: unknown): ConversationItem | undefined {
  const item = asRecord(value);
  const id = productString(item.id, 512);
  const kind = productString(item.kind, 64);
  const createdAt = productString(item.createdAt, 128);
  if (!id || !kind) {
    return undefined;
  }
  if (
    (kind === "user-message" || kind === "assistant-message" || kind === "reasoning-summary") &&
    typeof item.text === "string"
  ) {
    return {
      id,
      kind,
      text: item.text,
      ...(createdAt === undefined ? {} : { createdAt }),
    };
  }
  if (kind === "tool") {
    const title = productString(item.title, 1_024);
    const status =
      item.status === "running" || item.status === "complete" || item.status === "failed"
        ? item.status
        : undefined;
    if (!title || !status) {
      return undefined;
    }
    const summary = productString(item.summary, 1_024, true);
    const detail = productString(item.detail, 16_384, true);
    const occurrences = asPositiveInteger(item.occurrences);
    return {
      id,
      kind,
      title,
      status,
      ...(summary === undefined ? {} : { summary }),
      ...(detail === undefined ? {} : { detail }),
      ...(occurrences === undefined ? {} : { occurrences }),
      ...(createdAt === undefined ? {} : { createdAt }),
    };
  }
  if (kind === "file-change") {
    const path = productString(item.path, 4_096);
    const change =
      item.change === "added" || item.change === "modified" || item.change === "deleted"
        ? item.change
        : undefined;
    if (!path || !change) {
      return undefined;
    }
    const status =
      item.status === "inProgress" ||
      item.status === "completed" ||
      item.status === "failed" ||
      item.status === "declined"
        ? item.status
        : undefined;
    const targetPath = productString(item.targetPath, 4_096);
    const diff = productString(item.diff, 65_536, true);
    const additions = asUnsignedInteger(item.additions);
    const deletions = asUnsignedInteger(item.deletions);
    return {
      id,
      kind,
      path,
      change,
      ...(status === undefined ? {} : { status }),
      ...(targetPath === undefined ? {} : { targetPath }),
      ...(diff === undefined ? {} : { diff }),
      ...(additions === undefined ? {} : { additions }),
      ...(deletions === undefined ? {} : { deletions }),
      ...(createdAt === undefined ? {} : { createdAt }),
    };
  }
  return undefined;
}

function projectUsageWindows(payload: Record<string, unknown>): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const [fallbackId, rawSnapshot] of rateLimitSnapshots(payload)) {
    const snapshot = asRecord(rawSnapshot);
    const limitId = productString(snapshot.limitId, 128) ?? fallbackId;
    const label = productString(snapshot.limitName, 256) ?? "Codex";
    for (const [kind, rawWindow] of [
      ["primary", snapshot.primary],
      ["secondary", snapshot.secondary],
    ] as const) {
      const window = asRecord(rawWindow);
      const usedPercent = asFiniteNumber(window.usedPercent);
      if (usedPercent === undefined) {
        continue;
      }
      const resetsAt = asFiniteNumber(window.resetsAt);
      windows.push({
        id: `${limitId}-${kind}`,
        label: kind === "primary" ? `${label} · 当前周期` : `${label} · 较长周期`,
        usedPercent: clampPercent(usedPercent),
        remainingPercent: clampPercent(100 - usedPercent),
        ...(resetsAt === undefined ? {} : { resetsAt: new Date(resetsAt * 1_000).toISOString() }),
      });
    }
  }
  return windows;
}

function projectUsageCredits(payload: Record<string, unknown>): UsageCredits[] {
  const credits: UsageCredits[] = [];
  for (const [fallbackId, rawSnapshot] of rateLimitSnapshots(payload)) {
    const snapshot = asRecord(rawSnapshot);
    const rawCredits = asRecord(snapshot.credits);
    if (typeof rawCredits.hasCredits !== "boolean" || typeof rawCredits.unlimited !== "boolean") {
      continue;
    }
    const balance = productString(rawCredits.balance, 128);
    credits.push({
      id: productString(snapshot.limitId, 128) ?? fallbackId,
      label: productString(snapshot.limitName, 256) ?? "Codex",
      hasCredits: rawCredits.hasCredits,
      unlimited: rawCredits.unlimited,
      ...(balance === undefined ? {} : { balance }),
    });
  }
  return credits;
}

function rateLimitSnapshots(payload: Record<string, unknown>): Array<[string, unknown]> {
  const byId = asRecord(payload.rateLimitsByLimitId);
  if (Object.keys(byId).length > 0) {
    return Object.entries(byId).slice(0, 64);
  }
  return Object.hasOwn(payload, "rateLimits") ? [["codex", payload.rateLimits]] : [];
}

function productString(
  value: unknown,
  maxLength: number,
  allowWhitespace = false,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.slice(0, maxLength);
  return allowWhitespace ? (text.length > 0 ? text : undefined) : text.trim() || undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function asUnsignedInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}
