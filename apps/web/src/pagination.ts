export type CursorPage<T> = {
  items: T[];
  nextCursor?: string;
};

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
