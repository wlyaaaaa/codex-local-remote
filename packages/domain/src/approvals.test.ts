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
          availableDecisions: ["accept", "acceptForSession", "decline"],
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

  it("projects legacy Desktop command approvals using only decisions discovered from its schema", async () => {
    const respond = vi.fn(async () => undefined);
    const coordinator = new ApprovalCoordinator(new RemoteEventBuffer(8), {
      execCommandApproval: [
        "approved",
        "approved_for_session",
        { denied: { rejection: "用户拒绝" } },
        "abort",
      ],
    });

    expect(
      coordinator.handleServerRequest({
        id: "legacy-command-1",
        method: "execCommandApproval",
        params: {
          callId: "call-1",
          command: ["pwsh", "-Command", "Set-Content fixture.txt marker"],
          conversationId: "thread-legacy",
          cwd: "C:\\fixture",
          parsedCmd: [],
          reason: "需要写入测试标记",
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
          { id: "abort", label: "拒绝并停止", tone: "danger" },
        ],
        command: "pwsh -Command Set-Content fixture.txt marker",
        explanation: "需要写入测试标记",
        id: "legacy-command-1",
        threadId: "thread-legacy",
        title: "允许运行此操作？",
      },
    ]);

    await coordinator.resolve("legacy-command-1", { choiceId: "deny" });
    expect(respond).toHaveBeenCalledWith({
      decision: { denied: { rejection: "用户拒绝" } },
    });
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
      params: {
        availableDecisions: ["decline"],
        threadId: "thread-1",
      },
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

  it("projects future structured command decisions without losing their protocol payload", async () => {
    const respond = vi.fn(async () => undefined);
    const coordinator = new ApprovalCoordinator(new RemoteEventBuffer(4));
    const execPolicyDecision = {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ["git", "status"],
      },
    };
    const networkDecision = {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: {
          action: "allow",
          host: "api.example.test",
        },
      },
    };
    coordinator.handleServerRequest({
      id: "dynamic-command",
      method: "item/commandExecution/requestApproval",
      params: {
        availableDecisions: ["accept", execPolicyDecision, networkDecision, "decline"],
        threadId: "thread-1",
      },
      reject: vi.fn(async () => undefined),
      respond,
    });

    expect(coordinator.listPending()[0]?.choices).toEqual([
      { id: "allow-once", label: "仅本次允许", tone: "primary" },
      {
        id: "protocol-decision-1",
        label: "允许类似命令",
        tone: "neutral",
      },
      {
        id: "protocol-decision-2",
        label: "以后允许访问 api.example.test",
        tone: "neutral",
      },
      { id: "deny", label: "拒绝", tone: "danger" },
    ]);

    await coordinator.resolve("dynamic-command", { choiceId: "protocol-decision-1" });
    expect(respond).toHaveBeenCalledWith({ decision: execPolicyDecision });
  });

  it("renders and returns an unknown advertised decision without interpreting its payload", async () => {
    const respond = vi.fn(async () => undefined);
    const coordinator = new ApprovalCoordinator(new RemoteEventBuffer(4));
    const futureDecision = { aFutureDecision: { scope: "unknown" } };

    expect(
      coordinator.handleServerRequest({
        id: "unknown-command",
        method: "item/commandExecution/requestApproval",
        params: {
          availableDecisions: [futureDecision],
          threadId: "thread-1",
        },
        reject: vi.fn(async () => undefined),
        respond,
      }),
    ).toBe(true);
    expect(coordinator.listPending()[0]?.choices).toEqual([
      {
        id: "protocol-decision-0",
        label: "Codex 选项 1：a Future Decision",
        tone: "neutral",
      },
    ]);

    await coordinator.resolve("unknown-command", { choiceId: "protocol-decision-0" });
    expect(respond).toHaveBeenCalledWith({ decision: futureDecision });
  });

  it.each([
    {
      id: "command-without-choices",
      method: "item/commandExecution/requestApproval",
      params: { command: "pnpm test", threadId: "thread-1" },
    },
    {
      id: "file-without-choices",
      method: "item/fileChange/requestApproval",
      params: { grantRoot: "C:\\fixture", threadId: "thread-1" },
    },
    {
      id: "permissions-without-choices",
      method: "item/permissions/requestApproval",
      params: {
        permissions: { fileSystem: { read: ["C:\\fixture"] } },
        threadId: "thread-1",
      },
    },
  ])("does not fabricate approval decisions for $method", async ({ id, method, params }) => {
    const respond = vi.fn(async () => undefined);
    const coordinator = new ApprovalCoordinator(new RemoteEventBuffer(4));

    expect(
      coordinator.handleServerRequest({
        id,
        method,
        params,
        reject: vi.fn(async () => undefined),
        respond,
      }),
    ).toBe(true);
    const pending = coordinator.listPending()[0];
    expect(pending?.choices).toEqual([]);
    expect(pending?.limitation).toContain("没有声明");
    await expect(coordinator.resolve(id, { choiceId: "allow-once" })).rejects.toMatchObject({
      code: "INVALID_APPROVAL_CHOICE",
    });
    expect(respond).not.toHaveBeenCalled();
  });

  it("uses only dynamically advertised decisions for file, permissions and future methods", async () => {
    const fileRespond = vi.fn(async () => undefined);
    const permissionsRespond = vi.fn(async () => undefined);
    const futureRespond = vi.fn(async () => undefined);
    const coordinator = new ApprovalCoordinator(new RemoteEventBuffer(8));

    coordinator.handleServerRequest({
      id: "dynamic-file",
      method: "item/fileChange/requestApproval",
      params: {
        availableDecisions: ["accept", "cancel"],
        threadId: "thread-1",
      },
      reject: vi.fn(async () => undefined),
      respond: fileRespond,
    });
    coordinator.handleServerRequest({
      id: "dynamic-permissions",
      method: "item/permissions/requestApproval",
      params: {
        availableDecisions: ["acceptForSession", "decline"],
        threadId: "thread-1",
      },
      reject: vi.fn(async () => undefined),
      respond: permissionsRespond,
    });
    coordinator.handleServerRequest({
      id: "dynamic-future",
      method: "item/futureCapability/requestApproval",
      params: {
        availableDecisions: ["futureDecision"],
        reason: "未来类型",
        threadId: "thread-1",
      },
      reject: vi.fn(async () => undefined),
      respond: futureRespond,
    });

    expect(coordinator.listPending().map((approval) => approval.choices)).toEqual([
      [
        { id: "allow-once", label: "仅本次允许", tone: "primary" },
        { id: "cancel", label: "取消", tone: "danger" },
      ],
      [
        { id: "allow-session", label: "本次对话允许", tone: "neutral" },
        { id: "deny", label: "拒绝", tone: "danger" },
      ],
      [{ id: "protocol-decision-0", label: "Codex 选项 1：future Decision", tone: "neutral" }],
    ]);

    await coordinator.resolve("dynamic-file", { choiceId: "cancel" });
    await coordinator.resolve("dynamic-permissions", { choiceId: "allow-session" });
    await coordinator.resolve("dynamic-future", { choiceId: "protocol-decision-0" });
    expect(fileRespond).toHaveBeenCalledWith({ decision: "cancel" });
    expect(permissionsRespond).toHaveBeenCalledWith({ decision: "acceptForSession" });
    expect(futureRespond).toHaveBeenCalledWith({ decision: "futureDecision" });
  });

  it("uses schema-discovered decisions when a namespaced file request omits its choices", async () => {
    const respond = vi.fn(async () => undefined);
    const coordinator = new ApprovalCoordinator(new RemoteEventBuffer(4), {
      "item/fileChange/requestApproval": ["accept", "acceptForSession", "decline", "cancel"],
    });

    expect(
      coordinator.handleServerRequest({
        id: "file-schema-fallback",
        method: "item/fileChange/requestApproval",
        params: {
          grantRoot: "C:\\fixture",
          threadId: "thread-1",
          turnId: "turn-1",
        },
        reject: vi.fn(async () => undefined),
        respond,
      }),
    ).toBe(true);
    expect(coordinator.listPending()[0]?.choices).toEqual([
      { id: "allow-once", label: "仅本次允许", tone: "primary" },
      { id: "allow-session", label: "本次对话允许", tone: "neutral" },
      { id: "deny", label: "拒绝", tone: "danger" },
      { id: "cancel", label: "取消", tone: "danger" },
    ]);

    await coordinator.resolve("file-schema-fallback", { choiceId: "allow-once" });
    expect(respond).toHaveBeenCalledWith({ decision: "accept" });
  });

  it.each([null, []])(
    "uses schema-discovered decisions when runtime choices are %j",
    async (availableDecisions) => {
      const respond = vi.fn(async () => undefined);
      const coordinator = new ApprovalCoordinator(new RemoteEventBuffer(4), {
        "item/fileChange/requestApproval": ["accept", "acceptForSession", "decline", "cancel"],
      });

      expect(
        coordinator.handleServerRequest({
          id: "file-nullable-fallback",
          method: "item/fileChange/requestApproval",
          params: {
            availableDecisions,
            threadId: "thread-1",
            turnId: "turn-1",
          },
          reject: vi.fn(async () => undefined),
          respond,
        }),
      ).toBe(true);
      expect(coordinator.listPending()[0]?.choices.map((choice) => choice.id)).toEqual([
        "allow-once",
        "allow-session",
        "deny",
        "cancel",
      ]);

      await coordinator.resolve("file-nullable-fallback", { choiceId: "allow-once" });
      expect(respond).toHaveBeenCalledWith({ decision: "accept" });
    },
  );

  it("按声明的动态形状接住未来审批方法，而不是依赖固定方法名后缀", async () => {
    const respond = vi.fn(async () => undefined);
    const reject = vi.fn(async () => undefined);
    const coordinator = new ApprovalCoordinator(new RemoteEventBuffer(4));

    expect(
      coordinator.handleServerRequest({
        id: "future-shape",
        method: "server/futureDecision",
        params: {
          availableDecisions: [{ title: "批准新的动态操作", payload: { mode: "future" } }],
          reason: "Codex 更新后新增的审批类型",
          threadId: "thread-1",
        },
        reject,
        respond,
      }),
    ).toBe(true);

    expect(reject).not.toHaveBeenCalled();
    expect(coordinator.listPending()[0]).toMatchObject({
      title: "Codex 请求批准",
      choices: [
        {
          id: "protocol-decision-0",
          label: "批准新的动态操作",
          tone: "neutral",
        },
      ],
    });
    await coordinator.resolve("future-shape", { choiceId: "protocol-decision-0" });
    expect(respond).toHaveBeenCalledWith({
      decision: { title: "批准新的动态操作", payload: { mode: "future" } },
    });
  });

  it("按 questions 形状接住未来计划提问方法并原样返回结构化回答", async () => {
    const respond = vi.fn(async () => undefined);
    const coordinator = new ApprovalCoordinator(new RemoteEventBuffer(4));

    expect(
      coordinator.handleServerRequest({
        id: "future-question-shape",
        method: "server/futurePlanQuestion",
        params: {
          questions: [
            {
              header: "实现策略",
              id: "strategy",
              isOther: true,
              isSecret: false,
              options: [
                { description: "保持稳定兼容", label: "稳妥推进" },
                { description: "更快但风险更高", label: "激进推进" },
              ],
              question: "这次采用哪一种策略？",
            },
          ],
          threadId: "thread-1",
        },
        reject: vi.fn(async () => undefined),
        respond,
      }),
    ).toBe(true);

    expect(coordinator.listPending()[0]).toMatchObject({
      title: "Codex 需要你的选择",
      questions: [{ id: "strategy", question: "这次采用哪一种策略？" }],
    });
    await coordinator.resolve("future-question-shape", {
      answers: { strategy: ["稳妥推进"] },
      choiceId: "submit",
    });
    expect(respond).toHaveBeenCalledWith({
      answers: { strategy: { answers: ["稳妥推进"] } },
    });
  });
});
