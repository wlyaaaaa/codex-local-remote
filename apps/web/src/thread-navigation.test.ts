import type { ThreadDetail } from "@codex-local-remote/contracts";
import { describe, expect, it } from "vitest";
import { mergeThreadRefresh, threadSeedFromNavigationState } from "./thread-navigation";

function threadDetail(
  overrides: Partial<ThreadDetail> & Pick<ThreadDetail, "id" | "updatedAt">,
): ThreadDetail {
  return {
    title: "新任务",
    mode: "managed",
    state: "running",
    items: [{ id: "user-1", kind: "user-message", text: "开始" }],
    activeTurnId: "turn-1",
    availableActions: {
      changeModelNextTurn: true,
      interrupt: true,
      reply: false,
      steer: true,
    },
    ...overrides,
  };
}

describe("新任务详情首屏", () => {
  it("只接受与当前路由匹配的完整创建结果", () => {
    const seed = threadDetail({
      id: "thread-created",
      updatedAt: "2026-07-25T12:00:00.000Z",
    });

    expect(threadSeedFromNavigationState({ threadSeed: seed }, seed.id)).toBe(seed);
    expect(threadSeedFromNavigationState({ threadSeed: seed }, "thread-other")).toBeUndefined();
    expect(threadSeedFromNavigationState({ threadSeed: { id: seed.id } }, seed.id)).toBeUndefined();
    expect(threadSeedFromNavigationState(null, seed.id)).toBeUndefined();
  });

  it("静默刷新不能用较旧快照覆盖更近的实时事件", () => {
    const current = threadDetail({
      id: "thread-created",
      updatedAt: "2026-07-25T12:00:02.000Z",
      items: [
        { id: "user-1", kind: "user-message", text: "开始" },
        { id: "assistant-1", kind: "assistant-message", text: "实时增量已到达" },
      ],
    });
    const staleWithActiveTurn = threadDetail({
      id: current.id,
      updatedAt: "2026-07-25T12:00:01.000Z",
      state: "idle",
      items: [{ id: "user-1", kind: "user-message", text: "开始" }],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    });
    const { activeTurnId: _staleTurnId, ...stale } = staleWithActiveTurn;

    expect(mergeThreadRefresh(current, stale)).toEqual(current);
  });

  it("首次持久化刷新只替换创建 seed 的临时首轮用户消息", () => {
    const seed = threadDetail({
      id: "thread-created",
      updatedAt: "2026-07-25T12:00:00.000Z",
      items: [{ id: "seed-user", kind: "user-message", text: "执行真实验收" }],
    });
    const incomingWithActiveTurn = threadDetail({
      id: seed.id,
      updatedAt: "2026-07-25T12:00:01.000Z",
      state: "complete",
      items: [
        { id: "persisted-user", kind: "user-message", text: "执行真实验收" },
        { id: "assistant-1", kind: "assistant-message", text: "已完成" },
      ],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    });
    const { activeTurnId: _incomingTurnId, ...incoming } = incomingWithActiveTurn;

    const merged = mergeThreadRefresh(seed, incoming, seed);

    expect(merged.items).toEqual(incoming.items);
    expect(merged.items.some((item) => item.id === "seed-user")).toBe(false);
  });

  it("seed 收口不能吞掉用户后续故意发送的相同文本", () => {
    const seed = threadDetail({
      id: "thread-created",
      updatedAt: "2026-07-25T12:00:00.000Z",
      items: [{ id: "seed-user", kind: "user-message", text: "再检查一次" }],
    });
    const current = threadDetail({
      id: seed.id,
      updatedAt: "2026-07-25T12:00:01.000Z",
      items: [...seed.items, { id: "later-live-user", kind: "user-message", text: "再检查一次" }],
    });
    const incoming = threadDetail({
      id: seed.id,
      updatedAt: "2026-07-25T12:00:02.000Z",
      items: [{ id: "persisted-first-user", kind: "user-message", text: "再检查一次" }],
    });

    const merged = mergeThreadRefresh(current, incoming, seed);
    const repeatedMessages = merged.items.filter(
      (item) => item.kind === "user-message" && item.text === "再检查一次",
    );

    expect(repeatedMessages.map((item) => item.id)).toEqual([
      "persisted-first-user",
      "later-live-user",
    ]);
    expect(merged.items.some((item) => item.id === "seed-user")).toBe(false);
  });

  it("较新刷新保留尚未持久化的实时项目，同时采用新的运行状态", () => {
    const current = threadDetail({
      id: "thread-created",
      updatedAt: "2026-07-25T12:00:01.000Z",
      items: [
        { id: "user-1", kind: "user-message", text: "开始" },
        { id: "live-only", kind: "reasoning-summary", text: "正在检查" },
      ],
    });
    const refreshedWithActiveTurn = threadDetail({
      id: current.id,
      updatedAt: "2026-07-25T12:00:03.000Z",
      state: "complete",
      items: [
        { id: "user-1", kind: "user-message", text: "开始" },
        { id: "assistant-1", kind: "assistant-message", text: "完成" },
      ],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    });
    const { activeTurnId: _refreshedTurnId, ...refreshed } = refreshedWithActiveTurn;

    const merged = mergeThreadRefresh(current, refreshed);
    expect(merged.state).toBe("complete");
    expect(merged.updatedAt).toBe(refreshed.updatedAt);
    expect(merged.items.map((item) => item.id)).toEqual(["user-1", "assistant-1", "live-only"]);
  });

  it("相同时间戳的终态快照可用严格项目增长收口新任务 seed", () => {
    const current = threadDetail({
      id: "thread-created",
      updatedAt: "2026-07-25T12:00:00.000Z",
      items: [{ id: "user-1", kind: "user-message", text: "开始" }],
    });
    const incomingWithActiveTurn = threadDetail({
      id: current.id,
      updatedAt: current.updatedAt,
      state: "complete",
      items: [
        { id: "user-1", kind: "user-message", text: "开始" },
        { id: "assistant-1", kind: "assistant-message", text: "done" },
      ],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    });
    const { activeTurnId: _incomingTurnId, ...incoming } = incomingWithActiveTurn;

    const merged = mergeThreadRefresh(current, incoming);
    expect(merged.state).toBe("complete");
    expect(merged.activeTurnId).toBeUndefined();
    expect(merged.availableActions.reply).toBe(true);
    expect(merged.items).toContainEqual(
      expect.objectContaining({ id: "assistant-1", text: "done" }),
    );
  });

  it("低精度权威快照也能把同一工具项目从 running 单调推进到 complete", () => {
    const current = threadDetail({
      id: "thread-created",
      updatedAt: "2026-07-25T12:00:00.900Z",
      activeTurnId: "turn-compact",
      items: [
        {
          id: "compaction-current",
          kind: "tool",
          operation: "context-compaction",
          status: "running",
          title: "压缩对话上下文",
        },
      ],
    });
    const incomingWithActiveTurn = threadDetail({
      id: current.id,
      updatedAt: "2026-07-25T12:00:00.000Z",
      state: "complete",
      items: [
        {
          id: "compaction-current",
          kind: "tool",
          operation: "context-compaction",
          status: "complete",
          title: "压缩对话上下文",
        },
      ],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    });
    const { activeTurnId: _incomingTurnId, ...incoming } = incomingWithActiveTurn;

    const merged = mergeThreadRefresh(current, incoming);
    expect(merged.state).toBe("complete");
    expect(merged.activeTurnId).toBeUndefined();
    expect(merged.items).toContainEqual(
      expect.objectContaining({ id: "compaction-current", status: "complete" }),
    );
    expect(merged.availableActions.reply).toBe(true);
  });

  it("较新的 running 快照不能把同一工具项目的终态降级", () => {
    const currentWithActiveTurn = threadDetail({
      id: "thread-created",
      updatedAt: "2026-07-25T12:00:01.000Z",
      state: "complete",
      items: [
        {
          id: "compaction-current",
          kind: "tool",
          operation: "context-compaction",
          status: "complete",
          title: "压缩对话上下文",
        },
      ],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    });
    const { activeTurnId: _currentTurnId, ...current } = currentWithActiveTurn;
    const incoming = threadDetail({
      id: current.id,
      updatedAt: "2026-07-25T12:00:02.000Z",
      items: [
        {
          id: "compaction-current",
          kind: "tool",
          operation: "context-compaction",
          status: "running",
          title: "压缩对话上下文",
        },
      ],
    });

    const merged = mergeThreadRefresh(current, incoming);
    expect(merged.items).toContainEqual(
      expect.objectContaining({ id: "compaction-current", status: "complete" }),
    );
  });
});
