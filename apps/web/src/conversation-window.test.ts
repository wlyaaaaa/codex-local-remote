import { describe, expect, it } from "vitest";
import {
  INITIAL_CONVERSATION_ITEM_LIMIT,
  conversationHistoryAwayAfterLoad,
  conversationHistoryAnchorElementScrollTop,
  conversationHistoryControlVisible,
  conversationHistoryFlightBlocksRequest,
  conversationHistoryScrollTop,
  conversationHistoryShouldAutoLoad,
  conversationItemLimitForThread,
  hiddenConversationItemCount,
  loadConversationHistoryPages,
  nextConversationItemLimit,
  visibleConversationItems,
} from "./conversation-window";

describe("长对话渐进渲染", () => {
  const items = Array.from({ length: 350 }, (_, index) => ({ id: `item-${index}` }));

  it("首屏只渲染最近一段历史，最新运行事件永远在窗口内", () => {
    const visible = visibleConversationItems(items, INITIAL_CONVERSATION_ITEM_LIMIT);
    expect(visible).toHaveLength(INITIAL_CONVERSATION_ITEM_LIMIT);
    expect(visible[0]?.id).toBe(`item-${350 - INITIAL_CONVERSATION_ITEM_LIMIT}`);
    expect(visible.at(-1)?.id).toBe("item-349");
    expect(hiddenConversationItemCount(items.length, INITIAL_CONVERSATION_ITEM_LIMIT)).toBe(
      350 - INITIAL_CONVERSATION_ITEM_LIMIT,
    );
  });

  it("每次只扩一段且最终完整显示，不丢历史", () => {
    const secondLimit = nextConversationItemLimit(INITIAL_CONVERSATION_ITEM_LIMIT, items.length);
    expect(secondLimit).toBeGreaterThan(INITIAL_CONVERSATION_ITEM_LIMIT);
    expect(nextConversationItemLimit(secondLimit, items.length)).toBe(items.length);
    expect(visibleConversationItems(items, items.length)).toEqual(items);
  });

  it("大量工具事件不能把最近的用户消息、回答和压缩事件挤出首屏", () => {
    const longItems = [
      { id: "user", kind: "user-message" },
      { id: "answer", kind: "assistant-message" },
      { id: "compaction", kind: "tool", operation: "context-compaction" },
      ...Array.from({ length: 500 }, (_, index) => ({
        id: `tool-${index}`,
        kind: "tool",
        operation: "command",
      })),
    ];
    const visible = visibleConversationItems(
      longItems,
      INITIAL_CONVERSATION_ITEM_LIMIT,
      (item) =>
        item.kind === "user-message" ||
        item.kind === "assistant-message" ||
        item.operation === "context-compaction",
    );

    expect(visible.slice(0, 3).map((item) => item.id)).toEqual(["user", "answer", "compaction"]);
    expect(visible).toHaveLength(INITIAL_CONVERSATION_ITEM_LIMIT + 3);
    expect(hiddenConversationItemCount(longItems.length, visible.length)).toBe(
      longItems.length - visible.length,
    );
  });

  it("进行中和等待操作任务显示全部本地项目并自动耗尽远端分页", () => {
    expect(conversationItemLimitForThread(350, 160, "running", "turn-live")).toBe(350);
    expect(conversationItemLimitForThread(350, 160, "waiting-for-approval", undefined)).toBe(350);
    expect(conversationItemLimitForThread(350, 160, "complete", undefined)).toBe(160);
    expect(conversationHistoryShouldAutoLoad("running", "turn-live", "page-2")).toBe(true);
    expect(conversationHistoryShouldAutoLoad("waiting-for-approval", undefined, "page-2")).toBe(
      true,
    );
    expect(conversationHistoryShouldAutoLoad("complete", undefined, "page-2")).toBe(false);
    expect(
      conversationHistoryShouldAutoLoad("running", "turn-live", "local-page-2", "explicit"),
    ).toBe(false);
    expect(
      conversationHistoryControlVisible(
        "running",
        "turn-live",
        "local-page-2",
        0,
        "idle",
        "explicit",
      ),
    ).toBe(true);
    expect(conversationHistoryControlVisible("running", "turn-live", "page-2", 0, "idle")).toBe(
      false,
    );
  });

  it("自动历史链逐页耗尽，显式和滚动加载仅取一页", async () => {
    const pages = new Map([
      ["page-2", { historyNextCursor: "page-3", items: [2] }],
      ["page-3", { items: [1] }],
    ]);
    const loaded: string[] = [];
    const accepted: number[] = [];
    const result = await loadConversationHistoryPages({
      initialCursor: "page-2",
      isCurrent: (threadId) => threadId === "thread",
      loadPage: async (_threadId, cursor) => {
        loaded.push(cursor);
        return pages.get(cursor)!;
      },
      mode: "automatic",
      onPage: (page) => {
        accepted.push(...page.items);
      },
      threadId: "thread",
    });
    expect(loaded).toEqual(["page-2", "page-3"]);
    expect(accepted).toEqual([2, 1]);
    expect(result).toEqual({ status: "complete" });

    loaded.length = 0;
    expect(
      await loadConversationHistoryPages({
        initialCursor: "page-2",
        isCurrent: () => true,
        loadPage: async (_threadId, cursor) => {
          loaded.push(cursor);
          return pages.get(cursor)!;
        },
        mode: "explicit",
        onPage: () => undefined,
        threadId: "thread",
      }),
    ).toEqual({ nextCursor: "page-3", status: "stopped" });
    expect(loaded).toEqual(["page-2"]);
  });

  it("分页对线程切换、循环游标和读取失败均失败安全", async () => {
    expect(conversationHistoryFlightBlocksRequest({ threadId: "thread-a" }, "thread-a")).toBe(true);
    expect(conversationHistoryFlightBlocksRequest({ threadId: "thread-a" }, "thread-b")).toBe(
      false,
    );
    let current = true;
    await expect(
      loadConversationHistoryPages({
        initialCursor: "page-2",
        isCurrent: () => current,
        loadPage: async () => ({ historyNextCursor: "page-3", items: [2] }),
        mode: "automatic",
        onPage: () => {
          current = false;
        },
        threadId: "thread",
      }),
    ).resolves.toEqual({ nextCursor: "page-3", status: "stale" });

    await expect(
      loadConversationHistoryPages({
        initialCursor: "loop",
        isCurrent: () => true,
        loadPage: async () => ({ historyNextCursor: "loop" }),
        mode: "automatic",
        onPage: () => undefined,
        threadId: "thread",
      }),
    ).rejects.toThrow("历史分页游标重复");

    await expect(
      loadConversationHistoryPages({
        initialCursor: "page-2",
        isCurrent: () => true,
        loadPage: async () => Promise.reject(new Error("network")),
        mode: "automatic",
        onPage: () => undefined,
        threadId: "thread",
      }),
    ).rejects.toThrow("network");
  });

  it("显式加载真正揭示新内容，后台补页保持阅读锚点和原贴底状态", () => {
    expect(conversationHistoryScrollTop("explicit", 240, 2_400, 3_100)).toBe(240);
    expect(conversationHistoryScrollTop("scroll", 240, 2_400, 3_100)).toBe(940);
    expect(conversationHistoryScrollTop("automatic", 240, 2_400, 3_100)).toBe(940);
    expect(conversationHistoryAwayAfterLoad("explicit", false)).toBe(true);
    expect(conversationHistoryAwayAfterLoad("automatic", false)).toBe(false);
    expect(conversationHistoryAwayAfterLoad("scroll", true)).toBe(true);
    expect(conversationHistoryAnchorElementScrollTop(240, 120, 820)).toBe(940);
    expect(conversationHistoryAnchorElementScrollTop(240, 120, 120)).toBe(240);
  });
});
