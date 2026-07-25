import type { ConversationItem, ThreadDetail } from "@codex-local-remote/contracts";

interface ThreadNavigationState {
  threadSeed: ThreadDetail;
}

const threadModes = new Set(["desktop-snapshot", "managed"]);
const runStates = new Set(["idle", "running", "waiting-for-approval", "failed", "complete"]);

export function threadSeedFromNavigationState(
  state: unknown,
  threadId: string,
): ThreadDetail | undefined {
  const candidate = asRecord(state).threadSeed;
  return isThreadDetail(candidate) && candidate.id === threadId ? candidate : undefined;
}

export function threadNavigationState(threadSeed: ThreadDetail): ThreadNavigationState {
  return { threadSeed };
}

export function mergeThreadRefresh(
  current: ThreadDetail | undefined,
  incoming: ThreadDetail,
  creationSeed?: ThreadDetail,
): ThreadDetail {
  if (!current || current.id !== incoming.id) {
    return incoming;
  }

  const freshness = compareUpdatedAt(incoming.updatedAt, current.updatedAt);
  const preferIncoming =
    freshness > 0 ||
    incomingAdvancesToolLifecycle(current.items, incoming.items) ||
    incomingAdvancesThreadLifecycle(current, incoming);
  const base = preferIncoming ? incoming : current;
  const mergedItems = mergeConversationItems(incoming.items, current.items, preferIncoming);
  const items = reconcileCreationSeedFirstUserMessage(mergedItems, incoming, creationSeed);

  if (base === current && sameItemSequence(items, current.items)) {
    return current;
  }
  if (base === incoming && sameItemSequence(items, incoming.items)) {
    return incoming;
  }
  return { ...base, items };
}

function reconcileCreationSeedFirstUserMessage(
  mergedItems: readonly ConversationItem[],
  incoming: ThreadDetail,
  creationSeed: ThreadDetail | undefined,
): ConversationItem[] {
  if (!creationSeed || creationSeed.id !== incoming.id) {
    return [...mergedItems];
  }
  const seededFirstMessage = creationSeed.items.find(
    (item): item is ConversationItem & { kind: "user-message"; text: string } =>
      item.kind === "user-message",
  );
  const persistedFirstMessage = incoming.items.find(
    (item): item is ConversationItem & { kind: "user-message"; text: string } =>
      item.kind === "user-message",
  );
  if (
    !seededFirstMessage ||
    !persistedFirstMessage ||
    seededFirstMessage.id === persistedFirstMessage.id ||
    seededFirstMessage.text !== persistedFirstMessage.text
  ) {
    return [...mergedItems];
  }
  const seedIndex = mergedItems.findIndex(
    (item) =>
      item.kind === "user-message" &&
      item.id === seededFirstMessage.id &&
      item.text === seededFirstMessage.text,
  );
  return seedIndex < 0
    ? [...mergedItems]
    : mergedItems.filter((_item, index) => index !== seedIndex);
}

function mergeConversationItems(
  persistedOrder: readonly ConversationItem[],
  currentItems: readonly ConversationItem[],
  preferIncoming: boolean,
): ConversationItem[] {
  const currentById = new Map(currentItems.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const merged: ConversationItem[] = [];

  for (const incoming of persistedOrder) {
    const current = currentById.get(incoming.id);
    merged.push(mergeConversationItem(current, incoming, preferIncoming));
    seen.add(incoming.id);
  }
  for (const item of currentItems) {
    if (!seen.has(item.id)) {
      merged.push(item);
      seen.add(item.id);
    }
  }
  return merged;
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

  const currentIds = new Set(current.items.map((item) => item.id));
  const incomingIds = new Set(incoming.items.map((item) => item.id));
  const coversStableCurrentItems = current.items
    .filter((item) => item.kind !== "reasoning-summary")
    .every((item) => incomingIds.has(item.id));
  const hasStrictGrowth = incoming.items.some((item) => !currentIds.has(item.id));
  return coversStableCurrentItems && hasStrictGrowth;
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
