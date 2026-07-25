import { describe, expect, it, vi } from "vitest";

import { ApprovalCoordinator } from "./approvals.js";
import { RemoteEventBuffer } from "./events.js";

describe("ApprovalCoordinator", () => {
  it("projects a command approval into product language and returns a protocol decision", async () => {
    const respond = vi.fn(async () => undefined);
    const events = new RemoteEventBuffer(8);
    const coordinator = new ApprovalCoordinator(events);

    expect(
      coordinator.handleServerRequest({
        id: "request-1",
        method: "item/commandExecution/requestApproval",
        params: {
          command: "pnpm test",
          itemId: "item-1",
          reason: "需要运行测试",
          threadId: "thread-1",
          turnId: "turn-1",
        },
        reject: vi.fn(async () => undefined),
        respond,
      }),
    ).toBe(true);

    expect(coordinator.listPending()).toEqual([
      {
        choices: [
          { id: "allow-once", label: "仅本次允许", tone: "primary" },
          { id: "allow-session", label: "本次对话允许", tone: "neutral" },
          { id: "deny", label: "拒绝", tone: "danger" },
        ],
        command: "pnpm test",
        explanation: "需要运行测试",
        id: "request-1",
        threadId: "thread-1",
        title: "允许运行此操作？",
        turnId: "turn-1",
      },
    ]);
    expect(events.replayAfter().events[0]).toMatchObject({
      type: "approval.requested",
      threadId: "thread-1",
      turnId: "turn-1",
    });

    await coordinator.resolve("request-1", { choiceId: "allow-session" });

    expect(respond).toHaveBeenCalledWith({ decision: "acceptForSession" });
    expect(coordinator.listPending()).toEqual([]);
    expect(events.replayAfter().events.at(-1)).toMatchObject({
      type: "approval.resolved",
      payload: { approvalId: "request-1", choiceId: "allow-session" },
    });
  });

  it("does not expose credential-refresh or arbitrary dynamic-tool requests to the browser", async () => {
    const reject = vi.fn(async () => undefined);
    const coordinator = new ApprovalCoordinator(new RemoteEventBuffer(4));

    expect(
      coordinator.handleServerRequest({
        id: 9,
        method: "account/chatgptAuthTokens/refresh",
        params: { reason: "fixture" },
        reject,
        respond: vi.fn(async () => undefined),
      }),
    ).toBe(false);
    expect(reject).toHaveBeenCalledWith({
      code: -32_601,
      message: "此请求不能由移动端处理",
    });
    expect(coordinator.listPending()).toEqual([]);
  });

  it("projects request-user-input questions and wraps validated answers for app-server", async () => {
    const respond = vi.fn(async () => undefined);
    const coordinator = new ApprovalCoordinator(new RemoteEventBuffer(4));

    expect(
      coordinator.handleServerRequest({
        id: "input-1",
        method: "item/tool/requestUserInput",
        params: {
          itemId: "item-1",
          questions: [
            {
              header: "实现方式",
              id: "approach",
              isOther: true,
              isSecret: false,
              options: [
                { description: "保持变更较小", label: "小步修改" },
                { description: "统一整理结构", label: "集中重构" },
              ],
              question: "你希望采用哪种方式？",
            },
          ],
          threadId: "thread-1",
          turnId: "turn-1",
        },
        reject: vi.fn(async () => undefined),
        respond,
      }),
    ).toBe(true);
    expect(coordinator.listPending()[0]?.questions?.[0]).toMatchObject({
      id: "approach",
      isOther: true,
      isSecret: false,
    });
    expect(coordinator.listPending()[0]?.questions?.[0]?.options?.[0]).toMatchObject({
      label: "小步修改",
    });

    await coordinator.resolve("input-1", {
      answers: { approach: ["小步修改"] },
      choiceId: "submit",
    });
    expect(respond).toHaveBeenCalledWith({
      answers: { approach: { answers: ["小步修改"] } },
    });
  });

  it("expires stale approvals when the app-server connection restarts", () => {
    const coordinator = new ApprovalCoordinator(new RemoteEventBuffer(4));
    coordinator.handleServerRequest({
      id: "stale-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1" },
      reject: vi.fn(async () => undefined),
      respond: vi.fn(async () => undefined),
    });

    coordinator.handleBackendRestart();

    expect(coordinator.listPending()).toEqual([]);
  });

  it("removes a pending approval when app-server resolves it elsewhere", () => {
    const coordinator = new ApprovalCoordinator(new RemoteEventBuffer(4));
    coordinator.handleServerRequest({
      id: "resolved-elsewhere",
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1" },
      reject: vi.fn(async () => undefined),
      respond: vi.fn(async () => undefined),
    });

    coordinator.handleNotification({
      method: "serverRequest/resolved",
      params: { requestId: "resolved-elsewhere", threadId: "thread-1" },
    });

    expect(coordinator.listPending()).toEqual([]);
  });

  it("offers and returns only command decisions allowed by app-server", async () => {
    const respond = vi.fn(async () => undefined);
    const coordinator = new ApprovalCoordinator(new RemoteEventBuffer(4));
    coordinator.handleServerRequest({
      id: "restricted-command",
      method: "item/commandExecution/requestApproval",
      params: {
        availableDecisions: ["accept", "decline"],
        threadId: "thread-1",
      },
      reject: vi.fn(async () => undefined),
      respond,
    });

    expect(coordinator.listPending()[0]?.choices.map((choice) => choice.id)).toEqual([
      "allow-once",
      "deny",
    ]);
    await expect(
      coordinator.resolve("restricted-command", { choiceId: "allow-session" }),
    ).rejects.toMatchObject({ code: "INVALID_APPROVAL_CHOICE" });
    await coordinator.resolve("restricted-command", { choiceId: "allow-once" });
    expect(respond).toHaveBeenCalledWith({ decision: "accept" });
  });
});
