import { describe, expect, it } from "vitest";
import { browserAttentionTitle } from "./browser-attention";

describe("浏览器后台注意状态", () => {
  it("优先显示断线和待处理状态", () => {
    expect(
      browserAttentionTitle({
        approvalCount: 3,
        online: false,
        runningCount: 8,
      }),
    ).toBe("连接中断 · Codex Local Remote");
    expect(
      browserAttentionTitle({
        approvalCount: 3,
        online: true,
        runningCount: 8,
      }),
    ).toBe("(3) 等待处理 · Codex Local Remote");
  });

  it("在当前任务运行、失败和空闲时给出可识别的标签页标题", () => {
    expect(
      browserAttentionTitle({
        approvalCount: 0,
        currentState: "running",
        currentTitle: "  修复   远程同步  ",
        online: true,
        runningCount: 1,
      }),
    ).toBe("运行中 · 修复 远程同步 · Codex Remote");
    expect(
      browserAttentionTitle({
        approvalCount: 0,
        currentState: "failed",
        currentTitle: "修复远程同步",
        online: true,
        runningCount: 0,
      }),
    ).toBe("任务失败 · 修复远程同步 · Codex Remote");
    expect(
      browserAttentionTitle({
        approvalCount: 0,
        online: true,
        runningCount: 0,
      }),
    ).toBe("Codex Local Remote");
  });

  it("限制标题和计数长度，避免手机标签页被异常内容占满", () => {
    expect(
      browserAttentionTitle({
        approvalCount: 0,
        currentState: "complete",
        currentTitle: "a".repeat(100),
        online: true,
        runningCount: 0,
      }),
    ).toBe(`${"a".repeat(31)}… · Codex Remote`);
    expect(
      browserAttentionTitle({
        approvalCount: 0,
        online: true,
        runningCount: 1_000,
      }),
    ).toBe("(99) 运行中 · Codex Local Remote");
  });
});
