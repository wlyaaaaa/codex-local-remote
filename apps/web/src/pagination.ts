export type CursorPage<T> = {
  items: T[];
  nextCursor?: string;
};

export const DEFAULT_CURSOR_PAGINATION_LIMITS = Object.freeze({
  maxItems: 50_000,
  maxPages: 256,
});

export type CursorPaginationGuardLimits = {
  maxItems: number;
  maxPages: number;
};

export type CursorPaginationGuardReason =
  | "cursor-cycle"
  | "item-limit"
  | "no-progress"
  | "page-limit";

export type CursorPaginationGuard = {
  pageCount: number;
  receivedItemCount: number;
  seenCursors: ReadonlySet<string>;
};

const paginationGuardMessages: Readonly<Record<CursorPaginationGuardReason, string>> = {
  "cursor-cycle": "分页数据出现重复游标，自动加载已暂停",
  "item-limit": "本次自动加载已达到记录安全上限，已暂停",
  "no-progress": "分页没有发现新记录，自动加载已暂停",
  "page-limit": "本次自动加载已达到页数安全上限，已暂停",
};

export class CursorPaginationGuardError extends Error {
  override readonly name = "CursorPaginationGuardError";

  constructor(readonly reason: CursorPaginationGuardReason) {
    super(paginationGuardMessages[reason]);
  }
}

export function createCursorPaginationGuard(): CursorPaginationGuard {
  return {
    pageCount: 0,
    receivedItemCount: 0,
    seenCursors: new Set(),
  };
}

function cursorPaginationLimits(
  limits: CursorPaginationGuardLimits | undefined,
): CursorPaginationGuardLimits {
  return limits ?? DEFAULT_CURSOR_PAGINATION_LIMITS;
}

export function beginCursorPaginationPage(
  guard: CursorPaginationGuard,
  cursor: string,
  limits?: CursorPaginationGuardLimits,
): CursorPaginationGuard {
  const resolvedLimits = cursorPaginationLimits(limits);
  if (guard.seenCursors.has(cursor)) {
    throw new CursorPaginationGuardError("cursor-cycle");
  }
  if (guard.pageCount >= resolvedLimits.maxPages) {
    throw new CursorPaginationGuardError("page-limit");
  }
  return {
    ...guard,
    pageCount: guard.pageCount + 1,
    seenCursors: new Set([...guard.seenCursors, cursor]),
  };
}

export function completeCursorPaginationPage(
  guard: CursorPaginationGuard,
  page: {
    addedItems: number;
    nextCursor?: string | undefined;
    receivedItems: number;
  },
  limits?: CursorPaginationGuardLimits,
): CursorPaginationGuard {
  const resolvedLimits = cursorPaginationLimits(limits);
  if (page.nextCursor && guard.seenCursors.has(page.nextCursor)) {
    throw new CursorPaginationGuardError("cursor-cycle");
  }
  if (page.nextCursor && guard.pageCount >= resolvedLimits.maxPages) {
    throw new CursorPaginationGuardError("page-limit");
  }
  const receivedItemCount = guard.receivedItemCount + Math.max(0, page.receivedItems);
  if (receivedItemCount > resolvedLimits.maxItems) {
    throw new CursorPaginationGuardError("item-limit");
  }
  if (page.nextCursor && page.addedItems <= 0) {
    throw new CursorPaginationGuardError("no-progress");
  }
  return { ...guard, receivedItemCount };
}

export async function loadGuardedCursorPage<
  Page extends { items: readonly unknown[]; nextCursor?: string | undefined },
>({
  countAddedItems,
  cursor,
  guard,
  limits,
  loadPage,
}: {
  countAddedItems: (page: Page) => number;
  cursor: string;
  guard: CursorPaginationGuard;
  limits?: CursorPaginationGuardLimits | undefined;
  loadPage: (cursor: string) => Promise<Page>;
}): Promise<{ guard: CursorPaginationGuard; page: Page }> {
  const requestGuard = beginCursorPaginationPage(guard, cursor, limits);
  const page = await loadPage(cursor);
  const completedGuard = completeCursorPaginationPage(
    requestGuard,
    {
      addedItems: countAddedItems(page),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      receivedItems: page.items.length,
    },
    limits,
  );
  return { guard: completedGuard, page };
}

export function isCursorPaginationGuardError(error: unknown): error is CursorPaginationGuardError {
  return error instanceof CursorPaginationGuardError;
}

export function nextCursorFrom(headers: Headers): string | undefined {
  const cursor = headers.get("X-Next-Cursor")?.trim();
  return cursor || undefined;
}

export function nextCursorAfterRefresh(
  currentTailCursor: string | undefined,
  refreshedFirstPageCursor: string | undefined,
  hasLoadedMore: boolean,
): string | undefined {
  return hasLoadedMore ? currentTailCursor : refreshedFirstPageCursor;
}

export function shouldAutoLoadCurrentThreads(
  workspaceState: "loading" | "ready" | "error",
  nextCursor: string | undefined,
  moreState: "idle" | "loading" | "error",
): boolean {
  return workspaceState === "ready" && nextCursor !== undefined && moreState === "idle";
}

export function mergeCursorItems<T>(
  current: readonly T[],
  incoming: readonly T[],
  key: (item: T) => string,
  position: "prepend" | "append" = "prepend",
): T[] {
  if (position === "append") {
    const currentKeys = new Set(current.map(key));
    return [...current, ...incoming.filter((item) => !currentKeys.has(key(item)))];
  }
  const incomingKeys = new Set(incoming.map(key));
  return [...incoming, ...current.filter((item) => !incomingKeys.has(key(item)))];
}

type RefreshableFirstPageItem = {
  pinnedRank?: number | undefined;
};

export function mergeRefreshedFirstPage<T extends RefreshableFirstPageItem>(
  current: readonly T[],
  incoming: readonly T[],
  key: (item: T) => string,
  loadedTailKeys: ReadonlySet<string>,
): T[] {
  const incomingKeys = new Set(incoming.map(key));
  return [
    ...incoming,
    ...current
      .filter((item) => {
        const itemKey = key(item);
        return loadedTailKeys.has(itemKey) && !incomingKeys.has(itemKey);
      })
      .map((item) => (item.pinnedRank === undefined ? item : { ...item, pinnedRank: undefined })),
  ];
}
