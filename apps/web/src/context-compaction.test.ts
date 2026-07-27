import { describe, expect, it } from "vitest";
import type { ThreadDetail } from "@codex-local-remote/contracts";

import {
  applyContextCompactionEvents,
  beginContextCompactionRequest,
  canRequestContextCompaction,
  contextCompactionItemsForDisplay,
  contextCompactionAttemptFromThread,
  isContextCompactionBusy,
  latestContextCompaction,
  markContextCompactionRecoveryRequired,
  reconcileContextCompactionSnapshot,
} from "./context-compaction";

const idleManagedThread: ThreadDetail = {
  id: "thread-compact",
  title: "压缩验收",
  mode: "managed",
  state: "complete",
  updatedAt: "2026-07-25T20:00:00.000Z",
  items: [],
  availableActions: {
    changeModelNextTurn: true,
    interrupt: false,
    reply: true,
    steer: false,
  },
};

describe("上下文压缩界面门禁", () => {
  it("只允许在线、托管、空闲的父对话发起压缩", () => {
    expect(canRequestContextCompaction(idleManagedThread, true, "idle")).toBe(true);
    expect(canRequestContextCompaction(idleManagedThread, false, "idle")).toBe(false);
    expect(canRequestContextCompaction(idleManagedThread, true, "accepted")).toBe(false);
    expect(
      canRequestContextCompaction({ ...idleManagedThread, mode: "desktop-snapshot" }, true, "idle"),
    ).toBe(false);
    expect(
      canRequestContextCompaction(
        { ...idleManagedThread, parentThreadId: "parent-thread" },
        true,
        "idle",
      ),
    ).toBe(false);
    expect(
      canRequestContextCompaction(
        {
          ...idleManagedThread,
          activeTurnId: "active-turn",
          state: "running",
          availableActions: { ...idleManagedThread.availableActions, reply: false },
        },
        true,
        "idle",
      ),
    ).toBe(false);
  });

  it("只把当前活跃轮次最后一个压缩工具项判断为运行中", () => {
    const running: ThreadDetail = {
      ...idleManagedThread,
      activeTurnId: "turn-compact",
      state: "running",
      items: [
        {
          id: "compact-old",
          kind: "tool",
          operation: "context-compaction",
          status: "complete",
          title: "压缩对话上下文",
        },
        {
          id: "compact-current",
          kind: "tool",
          operation: "context-compaction",
          status: "running",
          title: "压缩对话上下文",
          turnId: "turn-compact",
        },
      ],
      availableActions: { ...idleManagedThread.availableActions, reply: false },
    };
    expect(latestContextCompaction(running.items)?.id).toBe("compact-current");
    expect(isContextCompactionBusy(running, "idle")).toBe(true);
    expect(isContextCompactionBusy(idleManagedThread, "requesting")).toBe(true);
    expect(canRequestContextCompaction(running, true, "idle")).toBe(false);
  });

  it("终态快照里残留的 running 压缩项不再显示为正在压缩", () => {
    const stale: ThreadDetail = {
      ...idleManagedThread,
      items: [
        {
          id: "compact-stale",
          kind: "tool",
          operation: "context-compaction",
          status: "running",
          title: "压缩对话上下文",
          turnId: "turn-compact",
        },
      ],
    };

    expect(isContextCompactionBusy(stale, "idle")).toBe(false);
    expect(canRequestContextCompaction(stale, true, "idle")).toBe(true);
    expect(contextCompactionItemsForDisplay(stale)).toEqual([
      expect.objectContaining({ id: "compact-stale", status: "complete" }),
    ]);
  });

  it("压缩项后已有新轮次内容时清除旧的运行状态", () => {
    const superseded: ThreadDetail = {
      ...idleManagedThread,
      activeTurnId: "turn-new",
      state: "running",
      items: [
        {
          id: "compact-stale",
          kind: "tool",
          operation: "context-compaction",
          status: "running",
          title: "压缩对话上下文",
          turnId: "turn-compact",
        },
        {
          id: "new-user",
          kind: "user-message",
          text: "压缩后继续",
          turnId: "turn-new",
        },
      ],
      availableActions: { ...idleManagedThread.availableActions, reply: false, steer: true },
    };

    expect(isContextCompactionBusy(superseded, "idle")).toBe(false);
    expect(contextCompactionItemsForDisplay(superseded)).toEqual([
      expect.objectContaining({ id: "compact-stale", status: "complete" }),
      expect.objectContaining({ id: "new-user" }),
    ]);
  });
});

describe("上下文压缩完成判据", () => {
  it("只接受同一 turnId 和同一 itemId 的 started 与 completed", () => {
    const attempt = contextCompactionAttemptFromThread(idleManagedThread, "compact-attempt-key");
    const beforeTerminal = applyContextCompactionEvents(attempt, [
      compactionItemEvent("started", "running", "turn-compact", "compaction-current", 1),
      turnStateEvent("complete", "turn-unrelated", 2),
      compactionItemEvent("completed", "complete", "turn-compact", "compaction-other", 3),
      turnStateEvent("complete", "turn-compact", 4),
    ]);

    expect(beforeTerminal.resolution).toBe("pending");
    expect(beforeTerminal.attempt).toMatchObject({
      completed: false,
      itemId: "compaction-current",
      started: true,
      terminalState: "complete",
      turnId: "turn-compact",
    });

    const completed = applyContextCompactionEvents(beforeTerminal.attempt, [
      compactionItemEvent("completed", "complete", "turn-compact", "compaction-current", 5),
    ]);
    expect(completed.resolution).toBe("succeeded");
  });

  it("同一压缩 turn 的失败或中断会失败，无关 turn 的失败不会抢先结束", () => {
    const attempt = contextCompactionAttemptFromThread(idleManagedThread, "compact-attempt-key");
    const running = applyContextCompactionEvents(attempt, [
      compactionItemEvent("started", "running", "turn-compact", "compaction-current", 1),
      turnStateEvent("failed", "turn-unrelated", 2),
    ]);
    expect(running.resolution).toBe("pending");

    const interrupted = applyContextCompactionEvents(running.attempt, [
      turnStateEvent("idle", "turn-compact", 3),
    ]);
    expect(interrupted.resolution).toBe("failed");
  });

  it("断线后用已绑定的同一 item 权威终态恢复成功", () => {
    const attempt = contextCompactionAttemptFromThread(idleManagedThread, "compact-attempt-key");
    const started = applyContextCompactionEvents(attempt, [
      compactionItemEvent("started", "running", "turn-compact", "compaction-current", 1),
    ]);
    const snapshot: ThreadDetail = {
      ...idleManagedThread,
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
    };

    expect(reconcileContextCompactionSnapshot(started.attempt, snapshot).resolution).toBe(
      "succeeded",
    );
  });

  it("running 快照用 activeTurnId 绑定本次操作，item 完成后立即结束等待", () => {
    const attempt = contextCompactionAttemptFromThread(idleManagedThread, "compact-attempt-key");
    const runningSnapshot: ThreadDetail = {
      ...idleManagedThread,
      activeTurnId: "turn-from-snapshot",
      state: "running",
      items: [
        {
          id: "compaction-from-snapshot",
          kind: "tool",
          operation: "context-compaction",
          status: "running",
          title: "压缩对话上下文",
        },
      ],
      availableActions: {
        ...idleManagedThread.availableActions,
        reply: false,
      },
    };
    const bound = reconcileContextCompactionSnapshot(attempt, runningSnapshot);
    expect(bound.attempt).toMatchObject({
      itemId: "compaction-from-snapshot",
      started: true,
      turnId: "turn-from-snapshot",
    });

    const unrelatedTerminal = applyContextCompactionEvents(bound.attempt, [
      compactionItemEvent(
        "completed",
        "complete",
        "turn-from-snapshot",
        "compaction-from-snapshot",
        1,
      ),
      turnStateEvent("complete", "turn-unrelated", 2),
    ]);
    expect(unrelatedTerminal.resolution).toBe("succeeded");
  });

  it("同一 turn 继续运行时，权威快照里的已完成 item 仍立即结束等待", () => {
    const attempt = contextCompactionAttemptFromThread(idleManagedThread, "compact-attempt-key");
    const started = applyContextCompactionEvents(attempt, [
      compactionItemEvent("started", "running", "turn-compact", "compaction-current", 1),
    ]);
    const snapshot: ThreadDetail = {
      ...idleManagedThread,
      activeTurnId: "turn-compact",
      state: "running",
      items: [
        {
          id: "compaction-current",
          kind: "tool",
          operation: "context-compaction",
          status: "complete",
          title: "压缩对话上下文",
        },
        {
          id: "later-command",
          kind: "tool",
          status: "running",
          title: "运行命令",
        },
      ],
      availableActions: {
        ...idleManagedThread.availableActions,
        reply: false,
      },
    };

    expect(reconcileContextCompactionSnapshot(started.attempt, snapshot).resolution).toBe(
      "succeeded",
    );
  });

  it("reset 后权威快照没有本次压缩证据时明确失败并解锁", () => {
    const attempt = markContextCompactionRecoveryRequired(
      contextCompactionAttemptFromThread(idleManagedThread, "compact-attempt-key"),
    );
    const first = reconcileContextCompactionSnapshot(attempt, idleManagedThread);
    expect(first.resolution).toBe("pending");
    const confirmed = reconcileContextCompactionSnapshot(first.attempt, idleManagedThread);

    expect(confirmed.resolution).toBe("failed");
  });

  it("无 reset 时给启动传播一次机会，连续权威空闲快照后明确失败", () => {
    const attempt = contextCompactionAttemptFromThread(idleManagedThread, "compact-attempt-key");
    const first = reconcileContextCompactionSnapshot(attempt, idleManagedThread);
    expect(first.resolution).toBe("pending");

    const second = reconcileContextCompactionSnapshot(first.attempt, idleManagedThread);
    expect(second.resolution).toBe("pending");

    const third = reconcileContextCompactionSnapshot(second.attempt, idleManagedThread);
    expect(third.resolution).toBe("failed");
  });
});

describe("上下文压缩请求互斥", () => {
  it("快速重复调用复用同一个 promise 和幂等键", async () => {
    const keys: string[] = [];
    const first = beginContextCompactionRequest(
      undefined,
      async (idempotencyKey) => {
        keys.push(idempotencyKey);
      },
      () => "same-attempt-key",
    );
    const repeated = beginContextCompactionRequest(
      first,
      async (idempotencyKey) => {
        keys.push(idempotencyKey);
      },
      () => "must-not-be-used",
    );

    expect(repeated).toBe(first);
    expect(repeated.promise).toBe(first.promise);
    await repeated.promise;
    expect(keys).toEqual(["same-attempt-key"]);
  });
});

function compactionItemEvent(
  lifecycle: "started" | "completed",
  status: "running" | "complete" | "failed",
  turnId: string,
  itemId: string,
  seq: number,
) {
  return {
    schemaVersion: 1 as const,
    seq,
    type: "thread.item" as const,
    emittedAt: `2026-07-25T20:00:0${seq}.000Z`,
    threadId: idleManagedThread.id,
    turnId,
    payload: {
      lifecycle,
      item: [
        {
          id: itemId,
          kind: "tool",
          operation: "context-compaction",
          status,
          title: "压缩对话上下文",
        },
      ],
    },
  };
}

function turnStateEvent(state: "idle" | "complete" | "failed", turnId: string, seq: number) {
  return {
    schemaVersion: 1 as const,
    seq,
    type: "turn.state" as const,
    emittedAt: `2026-07-25T20:00:0${seq}.000Z`,
    threadId: idleManagedThread.id,
    turnId,
    payload: { state },
  };
}
