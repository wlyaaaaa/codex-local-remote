import type { RemoteEvent } from "@codex-local-remote/contracts";
import { describe, expect, it } from "vitest";
import { reduceRuntimeNotice } from "./runtime-notice";

function event(seq: number, type: RemoteEvent["type"], payload: unknown): RemoteEvent {
  return {
    schemaVersion: 1,
    seq,
    type,
    payload,
    emittedAt: `2026-07-26T09:30:${String(seq).padStart(2, "0")}.000Z`,
    threadId: "thread-1",
    turnId: "turn-1",
  };
}

describe("Desktop 运行提示同步", () => {
  it("把额度不足错误原样转成网页阻断提示", () => {
    expect(
      reduceRuntimeNotice(undefined, [
        event(1, "diagnostic", {
          category: "error",
          message: "You have insufficient quota for this request.",
        }),
      ]),
    ).toEqual({
      category: "quota",
      message: "You have insufficient quota for this request.",
      tone: "danger",
      updatedAt: "2026-07-26T09:30:01.000Z",
    });
  });

  it("新一轮开始会清除旧错误，但同批稍后到达的新错误仍显示", () => {
    const oldNotice = {
      category: "runtime" as const,
      message: "旧错误",
      tone: "danger" as const,
      updatedAt: "2026-07-26T09:29:00.000Z",
    };
    expect(
      reduceRuntimeNotice(oldNotice, [
        event(2, "turn.state", { state: "running" }),
        event(3, "diagnostic", { category: "warning", message: "新的运行提示" }),
      ]),
    ).toEqual({
      category: "runtime",
      message: "新的运行提示",
      tone: "warning",
      updatedAt: "2026-07-26T09:30:03.000Z",
    });
  });

  it("忽略没有用户可读消息的内部健康事件", () => {
    expect(
      reduceRuntimeNotice(undefined, [
        event(4, "diagnostic", { appServerState: "running", restartAttempt: 0 }),
      ]),
    ).toBeUndefined();
  });
});
