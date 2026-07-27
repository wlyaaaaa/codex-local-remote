import { describe, expect, it } from "vitest";
import type { ThreadSummary } from "@codex-local-remote/contracts";
import {
  homeActivityStateLabel,
  homeActivityStateTone,
  homeActivityThreads,
  isHomeActivityThread,
} from "./home-activity";

function thread(id: string, state: string, overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id,
    mode: "managed",
    state: state as ThreadSummary["state"],
    title: id,
    updatedAt: "2026-07-26T00:00:00.000Z",
    ...overrides,
  };
}

describe("首页实时活动任务", () => {
  it("展示全部顶层非终态任务且不按 managed 模式或前三条截断", () => {
    const active = homeActivityThreads([
      thread("running", "running"),
      thread("approval", "waiting-for-approval"),
      thread("input", "waiting-for-user-input"),
      thread("starting", "starting"),
      thread("fifth", "queued", { mode: "future-runtime" as ThreadSummary["mode"] }),
    ]);

    expect(active.map((item) => item.id)).toEqual([
      "running",
      "approval",
      "input",
      "starting",
      "fifth",
    ]);
  });

  it("保留具有真实运行状态的 Desktop 快照，避免订阅提升失败时漏任务", () => {
    const active = homeActivityThreads([
      thread("desktop-running", "running", { mode: "desktop-snapshot" }),
      thread("desktop-approval", "waiting-for-approval", { mode: "desktop-snapshot" }),
      thread("desktop-idle", "idle", { mode: "desktop-snapshot" }),
    ]);

    expect(active.map((item) => item.id)).toEqual(["desktop-running", "desktop-approval"]);
  });

  it("排除子智能体、归档项与终态或空闲任务", () => {
    const active = homeActivityThreads([
      thread("child", "running", { parentThreadId: "parent" }),
      thread("archived", "running", { archived: true }),
      thread("idle", "idle"),
      thread("complete", "complete"),
      thread("failed", "failed"),
      thread("cancelled", "cancelled"),
      thread("real-running", "running"),
    ]);

    expect(active.map((item) => item.id)).toEqual(["real-running"]);
    expect(isHomeActivityThread(thread("idle", "idle"))).toBe(false);
    expect(isHomeActivityThread(thread("managed-running", "running"))).toBe(true);
  });

  it("未来等待态仍以真实状态提供可读文案和警示色", () => {
    expect(homeActivityStateLabel("waiting-for-user-input")).toBe("等待用户输入");
    expect(homeActivityStateTone("waiting-for-user-input")).toBe("warning");
    expect(homeActivityStateLabel("future-live-state")).toBe("future live state");
  });
});
