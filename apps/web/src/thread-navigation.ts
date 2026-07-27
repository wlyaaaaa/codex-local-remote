import type {
  ConversationItem,
  RemoteEvent,
  ThreadDetail,
  ThreadSummary,
} from "@codex-local-remote/contracts";

export interface ThreadNavigationState {
  initialPrompt?: string;
  threadSeed: ThreadDetail;
}

export interface ThreadCreationMergeContext {
  creationSeed?: ThreadDetail;
  initialPrompt?: string;
  liveAliasItemId?: string;
}

const threadModes = new Set(["desktop-snapshot", "managed"]);
const runStates = new Set(["idle", "running", "waiting-for-approval", "failed", "complete"]);
const threadNavigationCacheMaxAgeMs = 6 * 60 * 60 * 1000;

export function sortThreadsForDisplay<T extends ThreadSummary>(threads: readonly T[]): T[] {
  return [...threads].sort((left, right) => {
    const leftPinned = left.pinnedRank;
    const rightPinned = right.pinnedRank;
    if (leftPinned !== undefined || rightPinned !== undefined) {
      if (leftPinned === undefined) return 1;
      if (rightPinned === undefined) return -1;
      if (leftPinned !== rightPinned) return leftPinned - rightPinned;
    }
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

export function threadSeedFromNavigationState(
  state: unknown,
  threadId: string,
): ThreadDetail | undefined {
  const candidate = asRecord(state).threadSeed;
  return isThreadDetail(candidate) && candidate.id === threadId ? candidate : undefined;
}

export function threadInitialPromptFromNavigationState(
  state: unknown,
  threadId: string,
): string | undefined {
  const record = asRecord(state);
  const seed = threadSeedFromNavigationState(record, threadId);
  if (!seed) return undefined;
  return typeof record.initialPrompt === "string" && record.initialPrompt.length > 0
    ? record.initialPrompt
    : firstUserMessage(seed.items)?.text;
}

export function threadNavigationState(
  threadSeed: ThreadDetail,
  initialPrompt?: string,
): ThreadNavigationState {
  return {
    threadSeed,
    ...(initialPrompt === undefined ? {} : { initialPrompt }),
  };
}

export function compactThreadNavigationState(
  thread: ThreadDetail,
  initialPrompt?: string,
): ThreadNavigationState {
  const firstPromptItem =
    initialPrompt === undefined
      ? undefined
      : thread.items.find((item) => item.kind === "user-message" && item.text === initialPrompt);
  return threadNavigationState(
    {
      ...thread,
      items: firstPromptItem ? [firstPromptItem] : [],
    },
    initialPrompt,
  );
}

export function readThreadNavigationCache(
  storage: Pick<Storage, "getItem" | "removeItem">,
  threadId: string,
  now = Date.now(),
): ThreadNavigationState | undefined {
  const key = threadNavigationCacheKey(threadId);
  try {
    const record = asRecord(JSON.parse(storage.getItem(key) ?? "null"));
    const cachedAt = typeof record.cachedAt === "number" ? record.cachedAt : Number.NaN;
    if (
      !Number.isFinite(cachedAt) ||
      cachedAt > now ||
      now - cachedAt > threadNavigationCacheMaxAgeMs
    ) {
      storage.removeItem(key);
      return undefined;
    }
    const state = asRecord(record.state);
    const threadSeed = threadSeedFromNavigationState(state, threadId);
    if (!threadSeed) {
      storage.removeItem(key);
      return undefined;
    }
    const initialPrompt = threadInitialPromptFromNavigationState(state, threadId);
    return {
      threadSeed,
      ...(initialPrompt === undefined ? {} : { initialPrompt }),
    };
  } catch {
    storage.removeItem(key);
    return undefined;
  }
}

export function writeThreadNavigationCache(
  storage: Pick<Storage, "setItem">,
  state: ThreadNavigationState,
  now = Date.now(),
): void {
  try {
    storage.setItem(
      threadNavigationCacheKey(state.threadSeed.id),
      JSON.stringify({ cachedAt: now, state }),
    );
  } catch {
    // A full or disabled session store must never block the task view.
  }
}

function threadNavigationCacheKey(threadId: string): string {
  return `thread-navigation:${encodeURIComponent(threadId)}`;
}

export function mergeThreadRefresh(
  current: ThreadDetail | undefined,
  incoming: ThreadDetail,
  creation?: ThreadCreationMergeContext,
): ThreadDetail {
  if (!current || current.id !== incoming.id) {
    return incoming;
  }

  const freshness = compareUpdatedAt(incoming.updatedAt, current.updatedAt);
  const advancesThreadLifecycle = incomingAdvancesThreadLifecycle(current, incoming);
  const preferIncoming =
    freshness > 0 ||
    incomingHydratesSummaryPlaceholder(current, incoming) ||
    incomingAdvancesToolLifecycle(current.items, incoming.items) ||
    advancesThreadLifecycle;
  const reconcileTerminalTextAliases =
    isTerminalThreadState(incoming.state) &&
    (advancesThreadLifecycle ||
      (!isActiveThreadState(current.state) && incomingCoversLatestUser(current, incoming)));
  const base = preferIncoming ? incoming : current;
  const mergedItems = mergeConversationItems(
    incoming.items,
    current.items,
    preferIncoming,
    reconcileTerminalTextAliases,
    advancesThreadLifecycle,
  );
  const items = reconcileCreationSeedFirstUserMessage(mergedItems, incoming, creation);

  if (base === current && sameItemSequence(items, current.items)) {
    return current;
  }
  if (base === incoming && sameItemSequence(items, incoming.items)) {
    return incoming;
  }
  return { ...base, items };
}

export function mergeAuthoritativeThreadControl(
  current: ThreadDetail | undefined,
  incoming: ThreadDetail,
  creation?: ThreadCreationMergeContext,
): ThreadDetail {
  const merged = mergeThreadRefresh(current, incoming, creation);
  const { activeTurnId: _staleActiveTurnId, ...withoutActiveTurn } = merged;
  return {
    ...withoutActiveTurn,
    state: incoming.state,
    availableActions: incoming.availableActions,
    ...(incoming.activeTurnId === undefined ? {} : { activeTurnId: incoming.activeTurnId }),
  };
}

function incomingHydratesSummaryPlaceholder(
  current: ThreadDetail,
  incoming: ThreadDetail,
): boolean {
  const currentIsSummaryPlaceholder =
    current.items.length === 0 &&
    current.activeTurnId === undefined &&
    !Object.values(current.availableActions).some(Boolean);
  if (!currentIsSummaryPlaceholder) return false;

  return (
    incoming.items.length > 0 ||
    incoming.activeTurnId !== undefined ||
    Object.values(incoming.availableActions).some(Boolean)
  );
}

function reconcileCreationSeedFirstUserMessage(
  mergedItems: readonly ConversationItem[],
  incoming: ThreadDetail,
  creation: ThreadCreationMergeContext | undefined,
): ConversationItem[] {
  const creationSeed = creation?.creationSeed;
  if (!creationSeed || creationSeed.id !== incoming.id) {
    return [...mergedItems];
  }
  const seededFirstMessage = firstUserMessage(creationSeed.items);
  const initialPrompt = creation.initialPrompt ?? seededFirstMessage?.text;
  const persistedFirstMessage = firstUserMessage(incoming.items);
  if (!initialPrompt || !persistedFirstMessage || persistedFirstMessage.text !== initialPrompt) {
    return [...mergedItems];
  }
  const aliases = new Set(
    [seededFirstMessage?.id, creation.liveAliasItemId].filter(
      (id): id is string => id !== undefined && id !== persistedFirstMessage.id,
    ),
  );
  return aliases.size === 0
    ? [...mergedItems]
    : mergedItems.filter(
        (item) =>
          !(item.kind === "user-message" && item.text === initialPrompt && aliases.has(item.id)),
      );
}

export function findCreationPromptLiveAliasItemId(
  events: readonly RemoteEvent[],
  creation: ThreadCreationMergeContext | undefined,
): string | undefined {
  if (creation?.liveAliasItemId) return creation.liveAliasItemId;
  const creationSeed = creation?.creationSeed;
  const initialPrompt =
    creation?.initialPrompt ?? firstUserMessage(creationSeed?.items ?? [])?.text;
  if (!creationSeed?.activeTurnId || !initialPrompt) return undefined;

  for (const event of events) {
    if (
      event.type !== "thread.item" ||
      event.threadId !== creationSeed.id ||
      event.turnId !== creationSeed.activeTurnId
    ) {
      continue;
    }
    const payloadItems = asRecord(event.payload).item;
    if (!Array.isArray(payloadItems)) continue;
    const alias = payloadItems
      .map((item) => asRecord(item))
      .find((item) => item.kind === "user-message" && item.text === initialPrompt);
    if (typeof alias?.id === "string" && alias.id.length > 0) {
      return alias.id;
    }
  }
  return undefined;
}

export function persistedCreationPromptItemId(
  thread: ThreadDetail,
  initialPrompt: string | undefined,
): string | undefined {
  const first = firstUserMessage(thread.items);
  return initialPrompt && first?.text === initialPrompt ? first.id : undefined;
}

export function reconcileLiveCreationPromptAlias(
  thread: ThreadDetail,
  creation: ThreadCreationMergeContext | undefined,
  persistedItemId?: string,
): ThreadDetail {
  const aliasId = creation?.liveAliasItemId;
  const seedMessage = firstUserMessage(creation?.creationSeed?.items ?? []);
  const initialPrompt = creation?.initialPrompt ?? seedMessage?.text;
  if (!aliasId || !initialPrompt) return thread;

  const aliasExists = thread.items.some(
    (item) => item.kind === "user-message" && item.id === aliasId && item.text === initialPrompt,
  );
  if (!aliasExists) return thread;

  const dropId =
    persistedItemId &&
    persistedItemId !== aliasId &&
    thread.items.some(
      (item) =>
        item.kind === "user-message" && item.id === persistedItemId && item.text === initialPrompt,
    )
      ? aliasId
      : seedMessage?.id !== aliasId
        ? seedMessage?.id
        : undefined;
  if (!dropId) return thread;
  const items = thread.items.filter(
    (item) => !(item.kind === "user-message" && item.id === dropId && item.text === initialPrompt),
  );
  return items.length === thread.items.length ? thread : { ...thread, items };
}

function mergeConversationItems(
  persistedOrder: readonly ConversationItem[],
  currentItems: readonly ConversationItem[],
  preferIncoming: boolean,
  reconcileTerminalTextAliases: boolean,
  dropUnpersistedRunningTools: boolean,
): ConversationItem[] {
  const currentById = new Map(currentItems.map((item) => [item.id, item]));
  const contextCompactionAliasIds = findContextCompactionAliasIds(persistedOrder, currentItems);
  const seen = new Set<string>();
  const merged: ConversationItem[] = [];

  for (const incoming of persistedOrder) {
    const current = currentById.get(incoming.id);
    merged.push(mergeConversationItem(current, incoming, preferIncoming));
    seen.add(incoming.id);
  }
  for (const item of currentItems) {
    if (!seen.has(item.id)) {
      if (
        (dropUnpersistedRunningTools && item.kind === "tool" && item.status === "running") ||
        contextCompactionAliasIds.has(item.id) ||
        isOptimisticSteerAlias(item, persistedOrder) ||
        (reconcileTerminalTextAliases &&
          isTextItem(item) &&
          persistedOrder.some(
            (persisted) =>
              isTextItem(persisted) && persisted.kind === item.kind && persisted.text === item.text,
          )) ||
        isCurrentTurnAssistantAlias(item, persistedOrder, currentItems)
      ) {
        continue;
      }
      merged.push(item);
      seen.add(item.id);
    }
  }
  return merged;
}

function isOptimisticSteerAlias(
  item: ConversationItem,
  persistedOrder: readonly ConversationItem[],
): boolean {
  return (
    item.kind === "user-message" &&
    item.id.startsWith("pending-steer-") &&
    persistedOrder.some(
      (persisted) =>
        persisted.kind === "user-message" &&
        persisted.id !== item.id &&
        persisted.text === item.text,
    )
  );
}

function findContextCompactionAliasIds(
  persistedOrder: readonly ConversationItem[],
  currentItems: readonly ConversationItem[],
): Set<string> {
  const aliases = new Set<string>();
  const consumedPersisted = new Set<string>();
  const persistedCompactions = persistedOrder.filter(isContextCompactionItem);
  const currentCompactions = currentItems.filter(isContextCompactionItem);

  for (const current of currentCompactions) {
    if (persistedOrder.some((persisted) => persisted.id === current.id) || !current.createdAt) {
      continue;
    }
    const currentTime = Date.parse(current.createdAt);
    if (!Number.isFinite(currentTime)) continue;
    const match = persistedCompactions.find((persisted) => {
      if (
        persisted.id === current.id ||
        consumedPersisted.has(persisted.id) ||
        !persisted.createdAt
      ) {
        return false;
      }
      const persistedTime = Date.parse(persisted.createdAt);
      return Number.isFinite(persistedTime) && Math.abs(persistedTime - currentTime) <= 5_000;
    });
    if (match) {
      aliases.add(current.id);
      consumedPersisted.add(match.id);
    }
  }

  const currentIds = new Set(currentItems.map((item) => item.id));
  const persistedIds = new Set(persistedOrder.map((item) => item.id));
  const unpairedPersisted = persistedCompactions.filter(
    (item) => !currentIds.has(item.id) && !consumedPersisted.has(item.id),
  );
  const unpairedCurrent = currentCompactions.filter(
    (item) =>
      !persistedIds.has(item.id) &&
      !aliases.has(item.id) &&
      (item.createdAt === undefined || !Number.isFinite(Date.parse(item.createdAt))),
  );
  const pairCount = Math.min(unpairedPersisted.length, unpairedCurrent.length);
  for (let offset = 1; offset <= pairCount; offset += 1) {
    const alias = unpairedCurrent.at(-offset);
    if (alias) aliases.add(alias.id);
  }
  return aliases;
}

function isContextCompactionItem(
  item: ConversationItem,
): item is Extract<ConversationItem, { kind: "tool" }> {
  return item.kind === "tool" && item.operation === "context-compaction";
}

function isCurrentTurnAssistantAlias(
  item: ConversationItem,
  persistedOrder: readonly ConversationItem[],
  currentItems: readonly ConversationItem[],
): boolean {
  if (
    (item.kind !== "assistant-message" && item.kind !== "reasoning-summary") ||
    persistedOrder.length === 0
  ) {
    return false;
  }
  const persistedUserIndex = persistedOrder.findLastIndex(
    (candidate) => candidate.kind === "user-message",
  );
  if (persistedUserIndex < 0) return false;
  const persistedUser = persistedOrder[persistedUserIndex];
  const currentUserIndex = currentItems.findIndex(
    (candidate) => candidate.id === persistedUser?.id && candidate.kind === "user-message",
  );
  const currentItemIndex = currentItems.findIndex((candidate) => candidate.id === item.id);
  if (currentUserIndex < 0 || currentItemIndex <= currentUserIndex) return false;
  return persistedOrder
    .slice(persistedUserIndex + 1)
    .some(
      (candidate) =>
        candidate.kind === item.kind && isTextItem(candidate) && candidate.text === item.text,
    );
}

function isTextItem(item: ConversationItem): item is ConversationItem & {
  kind: "user-message" | "assistant-message" | "reasoning-summary";
  text: string;
} {
  return (
    item.kind === "user-message" ||
    item.kind === "assistant-message" ||
    item.kind === "reasoning-summary"
  );
}

function mergeConversationItem(
  current: ConversationItem | undefined,
  incoming: ConversationItem,
  preferIncoming: boolean,
): ConversationItem {
  if (!current) return incoming;
  if (current.kind === "tool" && incoming.kind === "tool") {
    if (isTerminalToolStatus(current.status) && incoming.status === "running") return current;
    if (current.status === "running" && isTerminalToolStatus(incoming.status)) return incoming;
  }
  return preferIncoming ? incoming : current;
}

function incomingAdvancesToolLifecycle(
  currentItems: readonly ConversationItem[],
  incomingItems: readonly ConversationItem[],
): boolean {
  const currentById = new Map(currentItems.map((item) => [item.id, item]));
  return incomingItems.some((incoming) => {
    const current = currentById.get(incoming.id);
    return (
      current?.kind === "tool" &&
      incoming.kind === "tool" &&
      current.status === "running" &&
      isTerminalToolStatus(incoming.status)
    );
  });
}

function incomingAdvancesThreadLifecycle(current: ThreadDetail, incoming: ThreadDetail): boolean {
  if (
    !isActiveThreadState(current.state) ||
    !isTerminalThreadState(incoming.state) ||
    incoming.activeTurnId !== undefined ||
    !incoming.availableActions.reply
  ) {
    return false;
  }

  const incomingIds = new Set(incoming.items.map((item) => item.id));
  const currentUserIndex = current.items.findLastIndex((item) => item.kind === "user-message");
  const latestCurrentUser = current.items[currentUserIndex];
  if (latestCurrentUser === undefined || !incomingIds.has(latestCurrentUser.id)) {
    return false;
  }
  const currentIds = new Set(current.items.map((item) => item.id));
  const incomingUserIndex = incoming.items.findIndex((item) => item.id === latestCurrentUser.id);
  const coversCurrentTurnItem = current.items
    .slice(currentUserIndex + 1)
    .some((item) => incomingIds.has(item.id));
  const addsPersistedCurrentTurnItem = incoming.items
    .slice(incomingUserIndex + 1)
    .some((item) => !currentIds.has(item.id));
  return coversCurrentTurnItem || addsPersistedCurrentTurnItem;
}

function incomingCoversLatestUser(current: ThreadDetail, incoming: ThreadDetail): boolean {
  const latestCurrentUser = current.items.findLast((item) => item.kind === "user-message");
  if (latestCurrentUser?.kind !== "user-message") return false;
  if (
    incoming.items.some((item) => item.kind === "user-message" && item.id === latestCurrentUser.id)
  ) {
    return true;
  }
  const latestIncomingUser = incoming.items.findLast((item) => item.kind === "user-message");
  return (
    latestIncomingUser?.kind === "user-message" &&
    latestIncomingUser.text === latestCurrentUser.text &&
    current.items.some((item) => item.kind === "user-message" && item.id === latestIncomingUser.id)
  );
}

function isActiveThreadState(state: ThreadDetail["state"]): boolean {
  return state === "running" || state === "waiting-for-approval";
}

function isTerminalThreadState(state: ThreadDetail["state"]): boolean {
  return state === "idle" || state === "complete" || state === "failed";
}

function isTerminalToolStatus(status: "running" | "complete" | "failed"): boolean {
  return status === "complete" || status === "failed";
}

function compareUpdatedAt(left: string, right: string): number {
  const leftTimestamp = Date.parse(left);
  const rightTimestamp = Date.parse(right);
  if (Number.isFinite(leftTimestamp) && Number.isFinite(rightTimestamp)) {
    return leftTimestamp - rightTimestamp;
  }
  if (Number.isFinite(leftTimestamp)) return 1;
  if (Number.isFinite(rightTimestamp)) return -1;
  return left.localeCompare(right);
}

function sameItemSequence(
  left: readonly ConversationItem[],
  right: readonly ConversationItem[],
): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function firstUserMessage(
  items: readonly ConversationItem[],
): (ConversationItem & { kind: "user-message"; text: string }) | undefined {
  return items.find(
    (item): item is ConversationItem & { kind: "user-message"; text: string } =>
      item.kind === "user-message",
  );
}

function isThreadDetail(value: unknown): value is ThreadDetail {
  const candidate = asRecord(value);
  const actions = asRecord(candidate.availableActions);
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.updatedAt === "string" &&
    typeof candidate.mode === "string" &&
    threadModes.has(candidate.mode) &&
    typeof candidate.state === "string" &&
    runStates.has(candidate.state) &&
    Array.isArray(candidate.items) &&
    candidate.items.every(isConversationItem) &&
    typeof actions.steer === "boolean" &&
    typeof actions.interrupt === "boolean" &&
    typeof actions.reply === "boolean" &&
    typeof actions.changeModelNextTurn === "boolean"
  );
}

function isConversationItem(value: unknown): value is ConversationItem {
  const item = asRecord(value);
  if (typeof item.id !== "string" || typeof item.kind !== "string") return false;
  if (
    item.kind === "user-message" ||
    item.kind === "assistant-message" ||
    item.kind === "reasoning-summary"
  ) {
    return typeof item.text === "string";
  }
  if (item.kind === "tool") {
    return (
      typeof item.title === "string" &&
      (item.status === "running" || item.status === "complete" || item.status === "failed")
    );
  }
  if (item.kind === "file-change") {
    return (
      typeof item.path === "string" &&
      (item.change === "added" || item.change === "modified" || item.change === "deleted")
    );
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
