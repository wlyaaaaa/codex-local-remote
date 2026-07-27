import { describe, expect, it } from "vitest";
import {
  INITIAL_CONVERSATION_ITEM_LIMIT,
  hiddenConversationItemCount,
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
});
