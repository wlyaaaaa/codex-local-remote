export const INITIAL_CONVERSATION_ITEM_LIMIT = 160;
export const CONVERSATION_ITEM_PAGE_SIZE = 160;
export const CONVERSATION_PRIORITY_ITEM_LIMIT = 24;

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
