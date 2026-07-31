import type {
  ConversationAttachment,
  ConversationItem,
  ModelOption,
  ReasoningEffort,
  RemoteEvent,
  RunState,
  ThreadDetail,
  ThreadSummary,
  ToolOccurrenceDetail,
  UsageCredits,
  UsageSnapshot,
  UsageWindow,
} from "@codex-local-remote/contracts";
import { defaultReasoningEffortForModel, normalizeReasoningEffortForModel } from "./model-effort";

export type NextTurnSettingsDraft = {
  model: string;
  effort: ReasoningEffort | undefined;
  dirty: boolean;
  runtimeModelKnown: boolean;
  runtimeEffortKnown: boolean;
};

export type ThreadRemoteEventProjectionState = {
  generation: number;
  sequenceFloorByThread: Map<string, number>;
  authoritativeSnapshotByThread: Set<string>;
  accumulatedDeltaByItem: Map<string, string>;
  replayBaselineByItem: Map<string, string>;
  submittedTurnUserAliasByThread: Map<string, SubmittedTurnUserAlias[]>;
  consumedLiveUserAliasIds: Set<string>;
};

type SubmittedTurnUserAlias = {
  itemId: string;
  text: string;
  turnId?: string;
  pending?: boolean;
  canonicalConsumed?: boolean;
  remoteAlias?: boolean;
};

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

export function nextTurnSettingsDraft(
  models: readonly ModelOption[],
  runtime: Pick<ThreadSummary, "model" | "reasoningEffort"> | undefined,
  fallback?: Pick<NextTurnSettingsDraft, "model" | "effort">,
): NextTurnSettingsDraft {
  const runtimeModel = runtime?.model;
  const model =
    runtimeModel ??
    fallback?.model ??
    models.find((item) => item.isDefault)?.id ??
    models[0]?.id ??
    "";
  const selected =
    models.find((item) => item.id === model) ??
    (runtimeModel === undefined && fallback?.model === undefined
      ? (models.find((item) => item.isDefault) ?? models[0])
      : undefined);
  const runtimeEffort = runtime?.reasoningEffort;
  const effort =
    runtimeEffort ??
    (runtimeModel === undefined
      ? normalizeReasoningEffortForModel(
          selected,
          fallback?.effort ?? defaultReasoningEffortForModel(selected),
        )
      : undefined);
  return {
    model,
    effort,
    dirty: false,
    runtimeModelKnown: runtimeModel !== undefined,
    runtimeEffortKnown: runtimeEffort !== undefined,
  };
}

export function updateNextTurnSettingsDraft(
  current: NextTurnSettingsDraft,
  update: Partial<Pick<NextTurnSettingsDraft, "model" | "effort">>,
): NextTurnSettingsDraft {
  return { ...current, ...update, dirty: true };
}

export function reconcileNextTurnSettingsDraft(
  current: NextTurnSettingsDraft,
  models: readonly ModelOption[],
  runtime: Pick<ThreadSummary, "model" | "reasoningEffort"> | undefined,
): NextTurnSettingsDraft {
  return current.dirty ? current : nextTurnSettingsDraft(models, runtime, current);
}

export function consumeNextTurnSettingsDraft(
  current: NextTurnSettingsDraft,
  models: readonly ModelOption[],
  response: Pick<ThreadSummary, "model" | "reasoningEffort"> | undefined,
): NextTurnSettingsDraft {
  return nextTurnSettingsDraft(models, response, current);
}

export function nextTurnSettingsInput(
  draft: NextTurnSettingsDraft,
  models: readonly ModelOption[],
): { model?: string; reasoningEffort?: ReasoningEffort } {
  if (!draft.dirty) return {};
  const selected = models.find((model) => model.id === draft.model);
  if (!selected) return {};
  const reasoningEffort = normalizeReasoningEffortForModel(selected, draft.effort);
  return {
    model: selected.id,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

export function createThreadRemoteEventProjectionState(): ThreadRemoteEventProjectionState {
  return {
    generation: 0,
    sequenceFloorByThread: new Map(),
    authoritativeSnapshotByThread: new Set(),
    accumulatedDeltaByItem: new Map(),
    replayBaselineByItem: new Map(),
    submittedTurnUserAliasByThread: new Map(),
    consumedLiveUserAliasIds: new Set(),
  };
}

export function rememberSubmittedTurnUserAlias(
  projection: ThreadRemoteEventProjectionState,
  response: ThreadDetail,
  prompt: string,
): void {
  const aliases = projection.submittedTurnUserAliasByThread.get(response.id) ?? [];
  const reservationIndex = aliases.findLastIndex(
    (alias) => alias.pending === true && alias.text === prompt,
  );
  const reservation = aliases[reservationIndex];
  if (reservation === undefined) return;
  const claimedItemIds = new Set(
    aliases.flatMap((alias, index) =>
      index === reservationIndex || alias.itemId.length === 0 ? [] : [alias.itemId],
    ),
  );
  const item = response.items.findLast(
    (candidate) =>
      candidate.kind === "user-message" &&
      candidate.text === prompt &&
      !claimedItemIds.has(candidate.id),
  );
  if (!item || item.kind !== "user-message") {
    replaceSubmittedTurnUserAliases(
      projection,
      response.id,
      aliases.filter((_, index) => index !== reservationIndex),
    );
    return;
  }
  const turnId = item.turnId ?? response.activeTurnId;
  const next = [...aliases];
  next[reservationIndex] = {
    itemId: item.id,
    text: item.text,
    ...(turnId ? { turnId } : {}),
  };
  replaceSubmittedTurnUserAliases(projection, response.id, next);
}

export function reserveSubmittedTurnUserAlias(
  projection: ThreadRemoteEventProjectionState,
  threadId: string,
  prompt: string,
): void {
  const aliases = projection.submittedTurnUserAliasByThread.get(threadId) ?? [];
  replaceSubmittedTurnUserAliases(projection, threadId, [
    ...aliases,
    {
      itemId: "",
      pending: true,
      text: prompt,
    },
  ]);
}

export function cancelSubmittedTurnUserAlias(
  projection: ThreadRemoteEventProjectionState,
  threadId: string,
  prompt: string,
): void {
  const aliases = projection.submittedTurnUserAliasByThread.get(threadId) ?? [];
  const reservationIndex = aliases.findLastIndex(
    (alias) => alias.pending === true && alias.text === prompt,
  );
  if (reservationIndex < 0) return;
  replaceSubmittedTurnUserAliases(
    projection,
    threadId,
    aliases.filter((_, index) => index !== reservationIndex),
  );
}

function replaceSubmittedTurnUserAliases(
  projection: ThreadRemoteEventProjectionState,
  threadId: string,
  aliases: SubmittedTurnUserAlias[],
): void {
  if (aliases.length === 0) {
    projection.submittedTurnUserAliasByThread.delete(threadId);
  } else {
    projection.submittedTurnUserAliasByThread.set(threadId, aliases);
  }
}

function submittedAliasIndexForItem(
  aliases: readonly SubmittedTurnUserAlias[],
  item: Extract<ConversationItem, { kind: "user-message" }>,
  incomingIsRemoteAlias: boolean,
): number {
  return aliases.findIndex(
    (alias) =>
      alias.itemId !== item.id &&
      (!incomingIsRemoteAlias || alias.remoteAlias !== true) &&
      alias.text === item.text &&
      (alias.turnId === undefined || item.turnId === undefined || alias.turnId === item.turnId),
  );
}

export function synchronizeThreadRemoteEventProjection(
  projection: ThreadRemoteEventProjectionState,
  snapshot: ThreadDetail & { snapshotEventSeq?: number },
  expectedGeneration: number = projection.generation,
): boolean {
  if (projection.generation !== expectedGeneration) return false;
  const sequence = asUnsignedInteger(snapshot.snapshotEventSeq);
  if (sequence === undefined) return false;
  const current = projection.sequenceFloorByThread.get(snapshot.id);
  projection.sequenceFloorByThread.set(
    snapshot.id,
    current === undefined ? sequence : Math.max(current, sequence),
  );
  projection.authoritativeSnapshotByThread.add(snapshot.id);
  clearReplayDeltaState(projection, snapshot.id);
  return true;
}

export function threadControlSnapshotIsCurrent(
  projection: Pick<ThreadRemoteEventProjectionState, "generation" | "sequenceFloorByThread">,
  snapshot: Pick<ThreadDetail, "id" | "snapshotEventSeq">,
  expectedGeneration: number = projection.generation,
): boolean {
  if (projection.generation !== expectedGeneration) return false;
  const snapshotSequence = asUnsignedInteger(snapshot.snapshotEventSeq);
  const projectedSequence = projection.sequenceFloorByThread.get(snapshot.id);
  if (snapshotSequence === undefined) {
    return projectedSequence === undefined;
  }
  return projectedSequence === undefined || snapshotSequence >= projectedSequence;
}

export function applyThreadRemoteEvents(
  snapshot: ThreadDetail,
  events: readonly RemoteEvent[],
  options: { projection?: ThreadRemoteEventProjectionState; replayed?: boolean } = {},
): ThreadDetail {
  let thread = snapshot;
  const projection = options.projection ?? createThreadRemoteEventProjectionState();

  for (const event of events) {
    if (event.type === "connection.reset") {
      resetThreadRemoteEventProjection(projection);
      continue;
    }
    if (event.threadId !== snapshot.id) {
      continue;
    }
    const sequenceFloor = projection.sequenceFloorByThread.get(snapshot.id);
    if (sequenceFloor !== undefined && event.seq <= sequenceFloor) {
      continue;
    }
    projection.sequenceFloorByThread.set(snapshot.id, event.seq);
    switch (event.type) {
      case "turn.state":
        thread = applyTurnState(thread, event);
        break;
      case "thread.item":
        thread = applyThreadItem(thread, event, projection, options.replayed === true);
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

export function threadSummaryFromSnapshotEvent(event: RemoteEvent): ThreadSummary | undefined {
  if (event.type !== "thread.snapshot") return undefined;
  const payload = asRecord(event.payload);
  const id = productString(payload.id, 512);
  const title = productString(payload.title, 200);
  const mode =
    payload.mode === "managed" || payload.mode === "desktop-snapshot" ? payload.mode : undefined;
  const state = asRunState(payload.state);
  const updatedAt = productString(payload.updatedAt, 128);
  if (
    !id ||
    (event.threadId !== undefined && event.threadId !== id) ||
    !title ||
    !mode ||
    !state ||
    !updatedAt
  ) {
    return undefined;
  }
  const projectId = productString(payload.projectId, 512);
  const cwdLabel = productString(payload.cwdLabel, 4_096);
  const model = productString(payload.model, 256);
  const reasoningEffort = productString(payload.reasoningEffort, 128);
  const serviceTier = productString(payload.serviceTier, 128);
  const permissionProfileId = productString(payload.permissionProfileId, 256);
  const approvalPolicy = productString(payload.approvalPolicy, 256);
  const approvalsReviewer = productString(payload.approvalsReviewer, 256);
  const collaborationMode = productString(payload.collaborationMode, 256);
  const parentThreadId = productString(payload.parentThreadId, 512);
  const childCount = asUnsignedInteger(payload.childCount);
  const pinnedRank = asUnsignedInteger(payload.pinnedRank);
  return {
    id,
    title,
    mode,
    state,
    updatedAt,
    ...(payload.archived === true ? { archived: true } : {}),
    ...(projectId === undefined ? {} : { projectId }),
    ...(cwdLabel === undefined ? {} : { cwdLabel }),
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(serviceTier === undefined ? {} : { serviceTier }),
    ...(permissionProfileId === undefined ? {} : { permissionProfileId }),
    ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
    ...(approvalsReviewer === undefined ? {} : { approvalsReviewer }),
    ...(collaborationMode === undefined ? {} : { collaborationMode }),
    ...(parentThreadId === undefined ? {} : { parentThreadId }),
    ...(childCount === undefined ? {} : { childCount }),
    ...(pinnedRank === undefined ? {} : { pinnedRank }),
  };
}

export function reconcileThreadSnapshotLists(
  current: readonly ThreadSummary[],
  archived: readonly ThreadSummary[],
  snapshot: ThreadSummary,
): { current: ThreadSummary[]; archived: ThreadSummary[] } {
  if (snapshot.archived) {
    return {
      current: current.filter((thread) => thread.id !== snapshot.id),
      archived: upsertThreadSummary(archived, snapshot),
    };
  }
  return {
    current: upsertThreadSummary(current, snapshot),
    archived: archived.filter((thread) => thread.id !== snapshot.id),
  };
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
      ...(windows.length === 0 ? {} : { windows: mergeUsageEntries(current.windows, windows) }),
      ...(credits.length === 0
        ? {}
        : { credits: mergeUsageEntries(current.credits ?? [], credits) }),
      ...(context === undefined ? {} : { context }),
    };
  }
  return usage;
}

function mergeUsageEntries<T extends { id: string }>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  const incomingById = new Map(incoming.map((entry) => [entry.id, entry]));
  const merged = current.map((entry) => incomingById.get(entry.id) ?? entry);
  const seen = new Set(current.map((entry) => entry.id));
  for (const entry of incoming) {
    if (!seen.has(entry.id)) {
      merged.push(entry);
      seen.add(entry.id);
    }
  }
  return merged;
}

function applyTurnState(thread: ThreadDetail, event: RemoteEvent): ThreadDetail {
  const payload = asRecord(event.payload);
  const state = asRunState(payload.state);
  if (!state) {
    return thread;
  }
  const turn = asRecord(payload.turn);
  const turnId = productString(event.turnId, 256) ?? productString(turn.id, 256);
  const startedAtSeconds = asFiniteNumber(turn.startedAt);
  const completedAtSeconds = asFiniteNumber(turn.completedAt);
  const turnStartedAt =
    startedAtSeconds === undefined ? undefined : new Date(startedAtSeconds * 1_000).toISOString();
  const turnCompletedAt =
    completedAtSeconds === undefined
      ? state === "running" || state === "waiting-for-approval"
        ? undefined
        : event.emittedAt
      : new Date(completedAtSeconds * 1_000).toISOString();
  const timedThread =
    turnId === undefined
      ? thread
      : {
          ...thread,
          items: thread.items.map((item) =>
            item.turnId === turnId
              ? {
                  ...item,
                  ...(turnStartedAt === undefined ? {} : { turnStartedAt }),
                  ...(turnCompletedAt === undefined ? {} : { turnCompletedAt }),
                }
              : item,
          ),
        };
  const terminal = state !== "running" && state !== "waiting-for-approval";
  if (
    terminal &&
    turnId !== undefined &&
    thread.activeTurnId !== undefined &&
    turnId !== thread.activeTurnId
  ) {
    return timedThread;
  }
  return withRunState(timedThread, state, event.emittedAt, turnId);
}

function applyThreadItem(
  thread: ThreadDetail,
  event: RemoteEvent,
  projection: ThreadRemoteEventProjectionState,
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
    const deltaKey = `${thread.id}:${itemKind}:${itemId}`;
    const index = thread.items.findIndex((item) => item.id === itemId && item.kind === itemKind);
    const existing = index < 0 ? undefined : thread.items[index];
    const existingText = existing && "text" in existing ? existing.text : "";
    const conservativeReplay = replayed && !projection.authoritativeSnapshotByThread.has(thread.id);
    if (!conservativeReplay) {
      projection.accumulatedDeltaByItem.delete(deltaKey);
      projection.replayBaselineByItem.delete(deltaKey);
    }
    const baseline = conservativeReplay
      ? (projection.replayBaselineByItem.get(deltaKey) ?? existingText)
      : existingText;
    if (conservativeReplay && !projection.replayBaselineByItem.has(deltaKey)) {
      projection.replayBaselineByItem.set(deltaKey, baseline);
    }
    const aggregate = conservativeReplay
      ? `${projection.accumulatedDeltaByItem.get(deltaKey) ?? ""}${delta}`
      : delta;
    if (conservativeReplay) {
      projection.accumulatedDeltaByItem.set(deltaKey, aggregate);
    }
    const projectedText = conservativeReplay
      ? reconcileReplayedStreamText(baseline, aggregate)
      : `${existingText}${delta}`;
    if (index < 0) {
      return {
        ...thread,
        updatedAt: event.emittedAt,
        items: [
          ...thread.items,
          {
            id: itemId,
            kind: itemKind,
            text: projectedText,
            createdAt: event.emittedAt,
            ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
          },
        ],
      };
    }
    if (!existing || !("text" in existing)) {
      return thread;
    }
    if (projectedText === existing.text) {
      return thread.updatedAt === event.emittedAt
        ? thread
        : { ...thread, updatedAt: event.emittedAt };
    }
    const items = [...thread.items];
    items[index] = {
      ...existing,
      text: projectedText,
      ...(existing.createdAt === undefined ? { createdAt: event.emittedAt } : {}),
    };
    return { ...thread, items, updatedAt: event.emittedAt };
  }

  const incoming = Array.isArray(payload.item)
    ? payload.item
        .map((item) => asConversationItem(item))
        .filter((item): item is ConversationItem => item !== undefined)
        .map((item) => ({
          ...item,
          ...(item.createdAt === undefined ? { createdAt: event.emittedAt } : {}),
          ...(item.turnId === undefined && event.turnId !== undefined
            ? { turnId: event.turnId }
            : {}),
        }))
    : [];
  if (incoming.length === 0) {
    // Deliberately ignore unknown item payloads, including raw reasoning text.
    return thread;
  }
  if (payload.localRemoteAlias === "steer-cancel") {
    const cancelledIds = new Set(
      incoming.filter((item) => item.kind === "user-message").map((item) => item.id),
    );
    if (cancelledIds.size === 0) return thread;
    const submittedAliases = projection.submittedTurnUserAliasByThread.get(thread.id) ?? [];
    replaceSubmittedTurnUserAliases(
      projection,
      thread.id,
      submittedAliases.filter((alias) => !cancelledIds.has(alias.itemId)),
    );
    return {
      ...thread,
      items: thread.items.filter((item) => !cancelledIds.has(item.id)),
      updatedAt: event.emittedAt,
    };
  }
  let items = thread.items;
  for (const item of incoming) {
    const liveAliasKey = `${thread.id}:${item.id}`;
    if (projection.consumedLiveUserAliasIds.has(liveAliasKey)) {
      continue;
    }
    const isLocalRemoteSteerAlias =
      item.kind === "user-message" && payload.localRemoteAlias === "steer";
    const submittedAliases = projection.submittedTurnUserAliasByThread.get(thread.id) ?? [];
    const submittedAliasIndex =
      item.kind === "user-message"
        ? submittedAliasIndexForItem(submittedAliases, item, isLocalRemoteSteerAlias)
        : -1;
    const submittedAlias =
      submittedAliasIndex < 0 ? undefined : submittedAliases[submittedAliasIndex];
    const matchesSubmittedAlias = submittedAlias !== undefined;
    if (isLocalRemoteSteerAlias && matchesSubmittedAlias) {
      projection.consumedLiveUserAliasIds.add(liveAliasKey);
      continue;
    }
    if (isLocalRemoteSteerAlias && item.kind === "user-message") {
      replaceSubmittedTurnUserAliases(projection, thread.id, [
        ...submittedAliases,
        {
          itemId: item.id,
          remoteAlias: true,
          text: item.text,
          ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
        },
      ]);
    } else if (matchesSubmittedAlias && submittedAlias !== undefined) {
      const nextAliases = [...submittedAliases];
      if (submittedAlias.pending === true) {
        nextAliases[submittedAliasIndex] = {
          ...submittedAlias,
          canonicalConsumed: true,
          itemId: item.id,
          ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
        };
      } else {
        nextAliases.splice(submittedAliasIndex, 1);
      }
      replaceSubmittedTurnUserAliases(projection, thread.id, nextAliases);
      projection.consumedLiveUserAliasIds.add(liveAliasKey);
      continue;
    }
    const lastItem = items.at(-1);
    if (
      item.kind === "user-message" &&
      lastItem?.kind === "user-message" &&
      lastItem.text === item.text &&
      !(isLocalRemoteSteerAlias && lastItem.id.startsWith("pending-steer-"))
    ) {
      // A turn/start response (or the optimistic steer row) already contains
      // the user text, while app-server lifecycle notifications use a
      // different transient item id for the same message.
      continue;
    }
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
  if (Object.hasOwn(payload, "archived")) {
    if (payload.archived === true) {
      const { activeTurnId: _activeTurnId, ...withoutActiveTurn } = next;
      next = {
        ...withoutActiveTurn,
        archived: true,
        availableActions: {
          ...next.availableActions,
          changeModelNextTurn: false,
          compact: false,
          interrupt: false,
          reply: false,
          steer: false,
          updateSettings: false,
        },
      };
    } else {
      const { archived: _archived, ...withoutArchived } = next;
      next = withoutArchived;
    }
  }
  if (hasEffort) {
    if (rawEffort === null) {
      const { reasoningEffort: _reasoningEffort, ...withoutEffort } = next;
      next = withoutEffort;
    } else if (effort !== undefined) {
      next = { ...next, reasoningEffort: effort };
    }
  }
  for (const key of [
    "serviceTier",
    "permissionProfileId",
    "approvalPolicy",
    "approvalsReviewer",
    "collaborationMode",
  ] as const) {
    const direct = Object.hasOwn(payload, key);
    const nested = Object.hasOwn(settings, key);
    if (!direct && !nested) continue;
    const raw = direct ? payload[key] : settings[key];
    if (raw === null) {
      const withoutSetting = { ...next };
      delete withoutSetting[key];
      next = withoutSetting;
      continue;
    }
    const value = productString(raw, 256);
    if (value !== undefined) {
      next = { ...next, [key]: value };
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

function reconcileReplayedStreamText(baseline: string, aggregate: string): string {
  if (!baseline) return aggregate;
  if (baseline.includes(aggregate)) return baseline;
  if (aggregate.startsWith(baseline)) {
    return aggregate;
  }
  const overlap = suffixPrefixOverlap(baseline, aggregate);
  return `${baseline}${aggregate.slice(overlap)}`;
}

function suffixPrefixOverlap(left: string, right: string): number {
  for (let length = Math.min(left.length, right.length); length > 0; length -= 1) {
    if (left.endsWith(right.slice(0, length))) return length;
  }
  return 0;
}

function clearReplayDeltaState(
  projection: ThreadRemoteEventProjectionState,
  threadId: string,
): void {
  const prefix = `${threadId}:`;
  for (const key of projection.accumulatedDeltaByItem.keys()) {
    if (key.startsWith(prefix)) projection.accumulatedDeltaByItem.delete(key);
  }
  for (const key of projection.replayBaselineByItem.keys()) {
    if (key.startsWith(prefix)) projection.replayBaselineByItem.delete(key);
  }
  for (const key of projection.consumedLiveUserAliasIds) {
    if (key.startsWith(prefix)) projection.consumedLiveUserAliasIds.delete(key);
  }
}

function resetThreadRemoteEventProjection(projection: ThreadRemoteEventProjectionState): void {
  projection.generation += 1;
  projection.sequenceFloorByThread.clear();
  projection.authoritativeSnapshotByThread.clear();
  projection.accumulatedDeltaByItem.clear();
  projection.replayBaselineByItem.clear();
  projection.submittedTurnUserAliasByThread.clear();
  projection.consumedLiveUserAliasIds.clear();
}

function upsertThreadSummary(
  threads: readonly ThreadSummary[],
  snapshot: ThreadSummary,
): ThreadSummary[] {
  const index = threads.findIndex((thread) => thread.id === snapshot.id);
  if (index < 0) return [snapshot, ...threads];
  const next = [...threads];
  next[index] = snapshot;
  return next;
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
  const turnId = productString(item.turnId, 512);
  const turnStartedAt = productString(item.turnStartedAt, 128);
  const turnCompletedAt = productString(item.turnCompletedAt, 128);
  const itemContext = {
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(turnId === undefined ? {} : { turnId }),
    ...(turnStartedAt === undefined ? {} : { turnStartedAt }),
    ...(turnCompletedAt === undefined ? {} : { turnCompletedAt }),
  };
  if (!id || !kind) {
    return undefined;
  }
  if (
    (kind === "user-message" || kind === "assistant-message" || kind === "reasoning-summary") &&
    typeof item.text === "string"
  ) {
    const attachments =
      kind === "user-message" ? asConversationAttachments(item.attachments) : undefined;
    return {
      id,
      kind,
      text: item.text,
      ...(attachments === undefined ? {} : { attachments }),
      ...(kind === "assistant-message" &&
      (item.phase === "commentary" || item.phase === "final_answer")
        ? { phase: item.phase }
        : {}),
      ...itemContext,
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
    const occurrenceDetails = Array.isArray(item.occurrenceDetails)
      ? item.occurrenceDetails
          .slice(0, 50)
          .map((candidate): ToolOccurrenceDetail | undefined => {
            const occurrence = asRecord(candidate);
            const occurrenceId = productString(occurrence.id, 512);
            const occurrenceStatus =
              occurrence.status === "running" ||
              occurrence.status === "complete" ||
              occurrence.status === "failed"
                ? occurrence.status
                : undefined;
            if (!occurrenceId || !occurrenceStatus) return undefined;
            const occurrenceSummary = productString(occurrence.summary, 1_024, true);
            const occurrenceDetail = productString(occurrence.detail, 16_384, true);
            const occurrenceCreatedAt = productString(occurrence.createdAt, 128);
            return {
              id: occurrenceId,
              status: occurrenceStatus,
              ...(occurrenceSummary === undefined ? {} : { summary: occurrenceSummary }),
              ...(occurrenceDetail === undefined ? {} : { detail: occurrenceDetail }),
              ...(occurrenceCreatedAt === undefined ? {} : { createdAt: occurrenceCreatedAt }),
            };
          })
          .filter((candidate): candidate is ToolOccurrenceDetail => candidate !== undefined)
      : undefined;
    const operation = item.operation === "context-compaction" ? item.operation : undefined;
    return {
      id,
      kind,
      title,
      status,
      ...(operation === undefined ? {} : { operation }),
      ...(summary === undefined ? {} : { summary }),
      ...(detail === undefined ? {} : { detail }),
      ...(occurrences === undefined ? {} : { occurrences }),
      ...(occurrenceDetails === undefined || occurrenceDetails.length === 0
        ? {}
        : { occurrenceDetails }),
      ...itemContext,
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
      ...itemContext,
    };
  }
  if (kind === "subagent-activity") {
    const action =
      item.action === "spawn" ||
      item.action === "update" ||
      item.action === "resume" ||
      item.action === "wait" ||
      item.action === "close" ||
      item.action === "activity"
        ? item.action
        : undefined;
    const status =
      item.status === "running" || item.status === "complete" || item.status === "failed"
        ? item.status
        : undefined;
    const agents = Array.isArray(item.agents)
      ? item.agents
          .map((rawAgent) => {
            const agent = asRecord(rawAgent);
            const threadId = productString(agent.threadId, 512);
            const label = productString(agent.label, 256);
            return threadId ? { threadId, ...(label === undefined ? {} : { label }) } : undefined;
          })
          .filter(
            (
              agent,
            ): agent is {
              threadId: string;
              label?: string;
            } => agent !== undefined,
          )
          .slice(0, 32)
      : [];
    if (!action || !status || agents.length === 0) return undefined;
    const summary = productString(item.summary, 1_024, true);
    return {
      id,
      kind,
      action,
      agents,
      status,
      ...(summary === undefined ? {} : { summary }),
      ...itemContext,
    };
  }
  if (kind === "plan-progress") {
    const steps = Array.isArray(item.steps)
      ? item.steps
          .map((rawStep) => {
            const step = asRecord(rawStep);
            const text = productString(step.text, 2_048);
            const status =
              step.status === "pending" ||
              step.status === "inProgress" ||
              step.status === "completed"
                ? step.status
                : undefined;
            return text && status ? { text, status } : undefined;
          })
          .filter(
            (
              step,
            ): step is {
              text: string;
              status: "pending" | "inProgress" | "completed";
            } => step !== undefined,
          )
          .slice(0, 64)
      : [];
    if (steps.length === 0) return undefined;
    const explanation = productString(item.explanation, 4_096, true);
    return {
      id,
      kind,
      steps,
      ...(explanation === undefined ? {} : { explanation }),
      ...itemContext,
    };
  }
  return undefined;
}

function asConversationAttachments(value: unknown): ConversationAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments = value
    .slice(0, 32)
    .map((candidate): ConversationAttachment | undefined => {
      const attachment = asRecord(candidate);
      const kind =
        attachment.kind === "file" || attachment.kind === "image" ? attachment.kind : undefined;
      const name = productString(attachment.name, 255);
      const path = productString(attachment.path, 32_768);
      return kind && name && path ? { kind, name, path } : undefined;
    })
    .filter((attachment): attachment is ConversationAttachment => attachment !== undefined);
  return attachments.length > 0 ? attachments : undefined;
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
