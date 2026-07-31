import { describe, expect, it } from "vitest";
import type { RemoteEvent } from "@codex-local-remote/contracts";
import {
  approvalForCurrentThread,
  WORKSPACE_REFRESH_MS,
  canRefreshDocument,
  isTextEntryElement,
  reconcileFetchedApprovals,
  reconcileSelectedApproval,
  resolvedApprovalId,
  threadRefreshDelay,
  workspaceEventNeedsRefresh,
} from "./refresh";

function event(type: RemoteEvent["type"]): Pick<RemoteEvent, "type"> {
  return { type };
}

describe("工作区实时刷新门禁", () => {
  it("用事件流保持实时，并把整段长对话读取降为低频兜底", () => {
    expect(threadRefreshDelay("running")).toBe(15_000);
    expect(threadRefreshDelay("complete")).toBe(30_000);
    expect(WORKSPACE_REFRESH_MS).toBe(10_000);
    expect(canRefreshDocument("visible")).toBe(true);
    expect(canRefreshDocument("hidden")).toBe(false);
  });

  it("已受理但尚未确认完成的操作使用短暂高频收敛", () => {
    expect(threadRefreshDelay("running", true)).toBe(1_000);
    expect(threadRefreshDelay("complete", true)).toBe(1_000);
  });

  it("识别正在输入的控件，以便延后昂贵的整段历史刷新", () => {
    const element = (tagName: string, contenteditable: string | null = null) => ({
      getAttribute: (name: string) => (name === "contenteditable" ? contenteditable : null),
      tagName,
    });
    expect(isTextEntryElement(element("TEXTAREA"))).toBe(true);
    expect(isTextEntryElement(element("input"))).toBe(true);
    expect(isTextEntryElement(element("DIV", "true"))).toBe(true);
    expect(isTextEntryElement(element("BUTTON"))).toBe(false);
    expect(isTextEntryElement(null)).toBe(false);
  });

  it("不会让诊断、消息流或额度事件形成全工作区刷新反馈环", () => {
    for (const type of [
      "connection.ready",
      "diagnostic",
      "thread.item",
      "usage.updated",
      "queue.updated",
      "thread.snapshot",
    ] as const) {
      expect(workspaceEventNeedsRefresh(event(type))).toBe(false);
    }
  });

  it("只对需要重新读取列表或审批状态的事件刷新", () => {
    for (const type of [
      "connection.reset",
      "thread.updated",
      "turn.state",
      "approval.requested",
      "approval.resolved",
    ] as const) {
      expect(workspaceEventNeedsRefresh(event(type))).toBe(true);
    }
  });

  it("从动态审批完成事件提取审批 ID，供另一浏览器立即关闭抽屉", () => {
    expect(
      resolvedApprovalId({
        type: "approval.resolved",
        payload: { approvalId: "approval-live-1", choiceId: "allow-once" },
      }),
    ).toBe("approval-live-1");
    expect(
      resolvedApprovalId({ type: "approval.resolved", payload: { approvalId: 123 } }),
    ).toBeUndefined();
    expect(
      resolvedApprovalId({ type: "thread.item", payload: { approvalId: "ignored" } }),
    ).toBeUndefined();
  });
});

describe("审批刷新竞态", () => {
  const approval = {
    choices: [{ id: "cancel", label: "取消", tone: "danger" as const }],
    id: "approval-1",
    threadId: "thread-1",
    title: "允许运行此操作？",
  };

  it("不会让较旧的并发刷新复活刚处理完的审批", () => {
    const stale = reconcileFetchedApprovals([approval], new Set(["approval-1"]));
    expect(stale.approvals).toEqual([]);
    expect([...stale.remainingResolvedIds]).toEqual(["approval-1"]);

    const converged = reconcileFetchedApprovals([], stale.remainingResolvedIds);
    expect(converged.approvals).toEqual([]);
    expect([...converged.remainingResolvedIds]).toEqual([]);
  });

  it("另一浏览器处理审批后会关闭本页已经打开的审批抽屉", () => {
    expect(reconcileSelectedApproval(approval, [approval])).toBe(approval);
    expect(reconcileSelectedApproval(approval, [])).toBeUndefined();
    expect(reconcileSelectedApproval(undefined, [approval])).toBeUndefined();
  });

  it("当前任务的新审批自动打开一次，用户关闭后不反复打扰", () => {
    expect(approvalForCurrentThread(undefined, [approval], "thread-1", new Set())).toBe(approval);
    expect(
      approvalForCurrentThread(undefined, [approval], "thread-1", new Set(["approval-1"])),
    ).toBeUndefined();
    expect(approvalForCurrentThread(undefined, [approval], "thread-2", new Set())).toBeUndefined();
  });
});
