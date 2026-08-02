export const INITIAL_CONVERSATION_ITEM_LIMIT = 160;
export const CONVERSATION_ITEM_PAGE_SIZE = 160;
export const CONVERSATION_PRIORITY_ITEM_LIMIT = 24;

export type ConversationHistoryLoadMode = "automatic" | "explicit" | "scroll";

export function conversationHistoryIsActive(
  state: string | undefined,
  activeTurnId: string | undefined,
): boolean {
  return activeTurnId !== undefined || state === "running" || state === "waiting-for-approval";
}

export function conversationItemLimitForThread(
  total: number,
  configuredLimit: number,
  state: string | undefined,
  activeTurnId: string | undefined,
): number {
  const boundedTotal = Math.max(0, Math.floor(total));
  return conversationHistoryIsActive(state, activeTurnId)
    ? boundedTotal
    : Math.max(1, Math.floor(configuredLimit));
}

export function conversationHistoryShouldAutoLoad(
  state: string | undefined,
  activeTurnId: string | undefined,
  nextCursor: string | undefined,
  loadPolicy: "automatic" | "explicit" = "automatic",
): boolean {
  return (
    loadPolicy === "automatic" &&
    Boolean(nextCursor) &&
    conversationHistoryIsActive(state, activeTurnId)
  );
}

export function conversationHistoryControlVisible(
  state: string | undefined,
  activeTurnId: string | undefined,
  nextCursor: string | undefined,
  hiddenItems: number,
  loadState: "idle" | "loading" | "error",
  loadPolicy: "automatic" | "explicit" = "automatic",
): boolean {
  if (loadState !== "idle") return true;
  if (loadPolicy === "explicit" && Boolean(nextCursor)) return true;
  return (
    !conversationHistoryIsActive(state, activeTurnId) && (hiddenItems > 0 || Boolean(nextCursor))
  );
}

export function conversationHistoryFlightBlocksRequest(
  flight: { threadId: string } | undefined,
  threadId: string,
): boolean {
  return flight?.threadId === threadId;
}

export function conversationHistoryScrollTop(
  mode: ConversationHistoryLoadMode,
  previousScrollTop: number,
  previousScrollHeight: number,
  nextScrollHeight: number,
): number {
  if (mode === "explicit") return Math.max(0, previousScrollTop);
  if (
    !Number.isFinite(previousScrollTop) ||
    !Number.isFinite(previousScrollHeight) ||
    !Number.isFinite(nextScrollHeight)
  ) {
    return 0;
  }
  return Math.max(0, previousScrollTop + Math.max(0, nextScrollHeight - previousScrollHeight));
}

export function conversationHistoryAnchorElementScrollTop(
  currentScrollTop: number,
  previousAnchorTop: number,
  nextAnchorTop: number,
): number {
  if (
    !Number.isFinite(currentScrollTop) ||
    !Number.isFinite(previousAnchorTop) ||
    !Number.isFinite(nextAnchorTop)
  ) {
    return 0;
  }
  return Math.max(0, currentScrollTop + nextAnchorTop - previousAnchorTop);
}

export function conversationHistoryAwayAfterLoad(
  mode: ConversationHistoryLoadMode,
  wasAway: boolean,
): boolean {
  return mode === "explicit" ? true : wasAway;
}

export async function loadConversationHistoryPages<
  Page extends { historyNextCursor?: string | undefined },
>({
  initialCursor,
  isCurrent,
  loadPage,
  maxPages = 1_000,
  mode,
  onPage,
  threadId,
}: {
  initialCursor: string;
  isCurrent: (threadId: string) => boolean;
  loadPage: (threadId: string, cursor: string) => Promise<Page>;
  maxPages?: number;
  mode: ConversationHistoryLoadMode;
  onPage: (page: Page, cursor: string) => void | Promise<void>;
  threadId: string;
}): Promise<{ status: "complete" } | { nextCursor: string; status: "stale" | "stopped" }> {
  const visited = new Set<string>();
  let cursor = initialCursor;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    if (!isCurrent(threadId)) return { nextCursor: cursor, status: "stale" };
    if (visited.has(cursor)) throw new Error("历史分页游标重复，已停止自动加载");
    visited.add(cursor);
    const page = await loadPage(threadId, cursor);
    if (!isCurrent(threadId)) {
      return { nextCursor: page.historyNextCursor ?? cursor, status: "stale" };
    }
    await onPage(page, cursor);
    const nextCursor = page.historyNextCursor;
    if (!nextCursor) return { status: "complete" };
    if (!isCurrent(threadId)) return { nextCursor, status: "stale" };
    if (mode !== "automatic") return { nextCursor, status: "stopped" };
    cursor = nextCursor;
  }
  throw new Error("历史分页超过安全上限，已停止自动加载");
}

export function visibleConversationItems<T>(
  items: readonly T[],
  limit: number,
  isPriority?: (item: T) => boolean,
): readonly T[] {
  const boundedLimit = Math.max(1, Math.floor(limit));
  if (items.length <= boundedLimit) return items;
  const tailStart = items.length - boundedLimit;
  if (!isPriority) return items.slice(tailStart);
  const priority = items
    .slice(0, tailStart)
    .filter(isPriority)
    .slice(-CONVERSATION_PRIORITY_ITEM_LIMIT);
  return [...priority, ...items.slice(tailStart)];
}

export function hiddenConversationItemCount(total: number, visible: number): number {
  return Math.max(0, Math.floor(total) - Math.max(0, Math.floor(visible)));
}

export function nextConversationItemLimit(current: number, total: number): number {
  return Math.min(
    Math.max(0, Math.floor(total)),
    Math.max(1, Math.floor(current)) + CONVERSATION_ITEM_PAGE_SIZE,
  );
}
