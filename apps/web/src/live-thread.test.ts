import type { RemoteEvent, ThreadDetail, UsageSnapshot } from "@codex-local-remote/contracts";
import { describe, expect, it } from "vitest";
import {
  applyThreadRemoteEvents,
  applyUsageRemoteEvents,
  detailFromThreadSummary,
} from "./live-thread";

function detail(overrides: Partial<ThreadDetail> = {}): ThreadDetail {
  return {
    id: "thread-1",
    title: "真实验收",
    mode: "managed",
    state: "idle",
    updatedAt: "2026-07-25T10:00:00.000Z",
    items: [],
    availableActions: {
      changeModelNextTurn: true,
      interrupt: false,
      reply: true,
      steer: false,
    },
    ...overrides,
  };
}

function event(
  seq: number,
  type: RemoteEvent["type"],
  payload: unknown,
  context: { threadId?: string; turnId?: string } = {
    threadId: "thread-1",
    turnId: "turn-1",
  },
): RemoteEvent {
  return {
    schemaVersion: 1,
    seq,
    type,
    payload,
    emittedAt: `2026-07-25T10:00:${String(seq).padStart(2, "0")}.000Z`,
    ...context,
  };
}

describe("实时任务事件投影", () => {
  it("仅有任务列表摘要时也能先用 replay 呈现正在运行的工具", () => {
    const fallback = detailFromThreadSummary({
      id: "thread-1",
      title: "刷新中的真实任务",
      mode: "managed",
      state: "running",
      updatedAt: "2026-07-25T10:00:00.000Z",
    });
    const projected = applyThreadRemoteEvents(fallback, [
      event(1, "turn.state", { state: "running", turn: { id: "turn-1" } }),
      event(2, "thread.item", {
        lifecycle: "started",
        item: [
          {
            id: "tool-1",
            kind: "tool",
            title: "运行命令",
            status: "running",
            summary: "长时间真实任务",
          },
        ],
      }),
    ]);

    expect(projected.items).toContainEqual({
      id: "tool-1",
      kind: "tool",
      title: "运行命令",
      status: "running",
      summary: "长时间真实任务",
    });
    expect(projected.availableActions).toEqual({
      changeModelNextTurn: false,
      interrupt: false,
      reply: false,
      steer: false,
    });
  });

  it("直接累加官方推理摘要与回复增量，同时忽略隐藏推理文本", () => {
    const projected = applyThreadRemoteEvents(detail(), [
      event(1, "thread.item", {
        kind: "reasoning-summary-delta",
        itemId: "reasoning-1",
        delta: "先检查边界。",
        summaryIndex: 0,
      }),
      event(2, "thread.item", {
        kind: "reasoning-text-delta",
        itemId: "reasoning-1",
        delta: "不得显示的隐藏推理",
      }),
      event(3, "thread.item", {
        kind: "assistant-message-delta",
        itemId: "assistant-1",
        delta: "正在处理",
      }),
      event(4, "thread.item", {
        kind: "assistant-message-delta",
        itemId: "assistant-1",
        delta: "真实任务。",
      }),
    ]);

    expect(projected.items).toEqual([
      {
        id: "reasoning-1",
        kind: "reasoning-summary",
        text: "先检查边界。",
        createdAt: "2026-07-25T10:00:01.000Z",
      },
      {
        id: "assistant-1",
        kind: "assistant-message",
        text: "正在处理真实任务。",
        createdAt: "2026-07-25T10:00:03.000Z",
      },
    ]);
    expect(JSON.stringify(projected)).not.toContain("不得显示的隐藏推理");
  });

  it("让首次 SSE replay 与已经包含同一文本的快照保持幂等", () => {
    const snapshot = detail({
      items: [
        {
          id: "assistant-1",
          kind: "assistant-message",
          text: "电脑已经完成这一步。",
        },
      ],
    });
    const projected = applyThreadRemoteEvents(
      snapshot,
      [
        event(1, "thread.item", {
          kind: "assistant-message-delta",
          itemId: "assistant-1",
          delta: "电脑已经",
        }),
        event(2, "thread.item", {
          kind: "assistant-message-delta",
          itemId: "assistant-1",
          delta: "完成这一步。",
        }),
      ],
      { replayed: true },
    );

    expect(projected.items[0]).toMatchObject({
      kind: "assistant-message",
      text: "电脑已经完成这一步。",
    });
  });

  it("实时增量即使重复相同文字也按官方事件顺序保留", () => {
    const projected = applyThreadRemoteEvents(
      detail({
        items: [{ id: "assistant-1", kind: "assistant-message", text: "哈" }],
      }),
      [
        event(1, "thread.item", {
          kind: "assistant-message-delta",
          itemId: "assistant-1",
          delta: "哈",
        }),
      ],
    );

    expect(projected.items[0]).toMatchObject({
      kind: "assistant-message",
      text: "哈哈",
    });
  });

  it("投影工具开始与完成生命周期，并用完成态替换运行态", () => {
    const running = applyThreadRemoteEvents(detail(), [
      event(1, "thread.item", {
        lifecycle: "started",
        item: [
          {
            id: "tool-1",
            kind: "tool",
            title: "运行命令",
            status: "running",
            summary: "等待 90 秒",
          },
        ],
      }),
    ]);
    expect(running.items).toEqual([
      {
        id: "tool-1",
        kind: "tool",
        title: "运行命令",
        status: "running",
        summary: "等待 90 秒",
      },
    ]);

    const projected = applyThreadRemoteEvents(running, [
      event(2, "thread.item", {
        lifecycle: "completed",
        item: [
          {
            id: "tool-1",
            kind: "tool",
            title: "运行命令",
            status: "complete",
            summary: "等待 90 秒",
            detail: "已完成",
          },
        ],
      }),
    ]);

    expect(projected.items).toEqual([
      {
        id: "tool-1",
        kind: "tool",
        title: "运行命令",
        status: "complete",
        summary: "等待 90 秒",
        detail: "已完成",
      },
    ]);
  });

  it("立即切换 turn 状态和可用操作，完成后恢复下一轮回复", () => {
    const running = applyThreadRemoteEvents(detail(), [
      event(1, "turn.state", {
        state: "running",
        turn: { id: "turn-1" },
      }),
    ]);
    expect(running).toMatchObject({
      state: "running",
      activeTurnId: "turn-1",
      availableActions: {
        changeModelNextTurn: true,
        interrupt: true,
        reply: false,
        steer: true,
      },
    });

    const completed = applyThreadRemoteEvents(running, [
      event(2, "turn.state", {
        state: "complete",
        turn: { id: "turn-1", status: "completed" },
      }),
    ]);
    expect(completed.activeTurnId).toBeUndefined();
    expect(completed).toMatchObject({
      state: "complete",
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    });
  });

  it("投影任务名称、模型和等待审批状态，但不接管其他任务", () => {
    const projected = applyThreadRemoteEvents(detail(), [
      event(1, "thread.updated", {
        name: "手机端真实任务",
        status: { type: "active", activeFlags: ["waitingOnUserInput"] },
        threadSettings: { model: "gpt-5.6-terra", reasoningEffort: "high" },
      }),
      event(2, "thread.updated", { name: "其他任务" }, { threadId: "thread-other" }),
    ]);

    expect(projected).toMatchObject({
      title: "手机端真实任务",
      state: "waiting-for-approval",
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
    });
  });

  it("用 tokenUsage 事件即时更新当前任务上下文", () => {
    const usage: UsageSnapshot = {
      updatedAt: "2026-07-25T10:00:00.000Z",
      windows: [],
    };
    const projected = applyUsageRemoteEvents(usage, "thread-1", [
      event(1, "usage.updated", {
        tokenUsage: {
          last: { totalTokens: 32_000 },
          modelContextWindow: 128_000,
        },
      }),
    ]);

    expect(projected).toMatchObject({
      updatedAt: "2026-07-25T10:00:01.000Z",
      context: {
        usedTokens: 32_000,
        limitTokens: 128_000,
        usedPercent: 25,
      },
    });
  });
});
