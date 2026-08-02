import { describe, expect, it } from "vitest";
import type {
  ApprovalRequest,
  ModelOption,
  QueuedTurnItem,
  ThreadDetail,
} from "@codex-local-remote/contracts";
import {
  collaborationModeSetting,
  collaborationModeDisplayLabel,
  composerGoalForDisplay,
  composerCapabilityState,
  composerCanSubmit,
  composerDeliveryDecision,
  composerDeliveryDecisionForRuntime,
  composerFeatureSupported,
  composerToolActions,
  filterThreadApprovals,
  modelComposerLabel,
  moveQueueItem,
  queueIdsForReorder,
  serviceTierChoices,
  serviceTierDisplayLabel,
  serviceTierSetting,
  serviceTierOptions,
} from "./composer-product";

describe("移动端 composer 产品契约", () => {
  it("把已知默认协作模式统一显示为标准，未知模式保留运行时真值", () => {
    expect(collaborationModeDisplayLabel("default", "Default")).toBe("标准");
    expect(collaborationModeDisplayLabel("Default", "默认运行模式")).toBe("标准");
    expect(collaborationModeDisplayLabel("future-mode", "Future Mode")).toBe("Future Mode");
  });

  it("完成目标退出输入区，其他状态仍保留可操作目标", () => {
    const goal = {
      createdAt: "2026-08-02T00:00:00.000Z",
      objective: "完成最终发布",
      status: "active" as const,
      threadId: "thread",
      timeUsedSeconds: 10,
      tokensUsed: 20,
      updatedAt: "2026-08-02T00:00:10.000Z",
    };

    expect(composerGoalForDisplay(goal)).toBe(goal);
    expect(composerGoalForDisplay({ ...goal, status: "paused" })).toMatchObject({
      status: "paused",
    });
    expect(composerGoalForDisplay({ ...goal, status: "complete" })).toBeUndefined();
  });

  it("从服务端名称生成完整而紧凑的模型标签，不维护版本表", () => {
    expect(modelComposerLabel("GPT-5.3-Codex-Spark")).toBe("5.3 Spark");
    expect(modelComposerLabel("OpenAI GPT-5.4 mini")).toBe("5.4 mini");
    expect(modelComposerLabel("future_model_alpha")).toBe("future model alpha");
  });

  it("保留服务端速度档顺序并兼容字符串与对象形状", () => {
    const model = {
      id: "future",
      displayName: "Future",
      supportedReasoningEfforts: ["medium"],
      isDefault: true,
      additionalSpeedTiers: ["fast"],
      serviceTiers: [
        { id: "default", displayName: "标准" },
        { id: "priority", displayName: "极速", description: "消耗更多额度" },
      ],
      defaultServiceTier: "default",
    } as ModelOption;

    expect(serviceTierOptions(model)).toEqual([
      { id: "priority", label: "极速", description: "消耗更多额度" },
      { id: "fast", label: "Fast" },
    ]);
  });

  it("所选模型没有公布速度档时只保留 Codex 默认速度", () => {
    const model = {
      id: "gpt-5.3-codex-spark",
      displayName: "GPT-5.3-Codex-Spark",
      supportedReasoningEfforts: ["high"],
      isDefault: true,
    } satisfies ModelOption;

    expect(serviceTierChoices(model)).toEqual([
      {
        id: null,
        label: "标准",
        description: "按 Codex 的标准速度运行，不启用额外加速",
      },
    ]);
  });

  it("当前运行参数把 default/normal/standard 统一显示成标准并保留未来档位", () => {
    expect(serviceTierDisplayLabel("Default")).toBe("标准");
    expect(serviceTierDisplayLabel("normal")).toBe("标准");
    expect(serviceTierDisplayLabel("standard")).toBe("标准");
    expect(serviceTierDisplayLabel("fast")).toBe("Fast");
    expect(serviceTierDisplayLabel("turbo-v2")).toBe("turbo-v2");
  });

  it("按运行时能力而不是 Codex 版本号决定功能", () => {
    expect(
      composerCapabilityState(
        {
          queue: { state: "available", source: "runtime-probe" },
          goals: "degraded",
        },
        "queue",
      ),
    ).toBe("available");
    expect(
      composerCapabilityState(
        {
          queue: { state: "available", source: "runtime-probe" },
          goals: "degraded",
        },
        "goal",
      ),
    ).toBe("degraded");
    expect(composerCapabilityState({}, "queue")).toBe("unavailable");
    expect(
      composerFeatureSupported(
        {
          goals: "degraded",
        },
        "goal",
      ),
    ).toBe(false);
    expect(serviceTierSetting({ serviceTiers: "degraded" }, "fast")).toEqual({});
    expect(serviceTierSetting({ serviceTiers: "unavailable" }, null)).toEqual({});
    expect(serviceTierSetting({ serviceTiers: "available" }, "future-fast")).toEqual({
      serviceTier: "future-fast",
    });
  });

  it("运行时撤回旧协作模式后不让陈旧设置阻塞消息发送", () => {
    const modes = [
      {
        id: "plan",
        displayName: "计划",
        description: "先规划",
        available: true,
      },
    ];

    expect(collaborationModeSetting({ collaborationModes: "available" }, modes, "plan")).toEqual({
      collaborationMode: "plan",
    });
    expect(collaborationModeSetting({ collaborationModes: "available" }, modes, "Default")).toEqual(
      {},
    );
    expect(
      collaborationModeSetting(
        { collaborationModes: "available" },
        [...modes, { id: "Default", displayName: "默认", available: true }],
        "Default",
        { includeDefault: true },
      ),
    ).toEqual({ collaborationMode: "Default" });
    expect(collaborationModeSetting({ collaborationModes: "available" }, [], "Default")).toEqual(
      {},
    );
    expect(collaborationModeSetting({ collaborationModes: "degraded" }, modes, "plan")).toEqual({});
  });

  it("已有对话仍在运行但 activeTurnId 暂未投影时绝不误发 turn/start", () => {
    const thread = {
      availableActions: {
        changeModelNextTurn: true,
        interrupt: true,
        reply: false,
        steer: true,
      },
      state: "running",
    } satisfies Pick<ThreadDetail, "activeTurnId" | "availableActions" | "state">;

    expect(composerDeliveryDecision(thread, "steer", true)).toBe("synchronize");
    expect(composerDeliveryDecision(thread, "queue", true)).toBe("queue");
  });

  it("只有明确空闲的已有对话才开始新一轮", () => {
    const idle = {
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
      state: "complete",
    } satisfies Pick<ThreadDetail, "activeTurnId" | "availableActions" | "state">;

    expect(composerDeliveryDecision(idle, "steer", true)).toBe("start");
  });

  it("运行时恢复期间仍允许把消息安全写入持久队列", () => {
    const running = {
      activeTurnId: "turn-1",
      availableActions: {
        changeModelNextTurn: true,
        interrupt: true,
        reply: false,
        steer: true,
      },
      state: "running",
    } satisfies Pick<ThreadDetail, "activeTurnId" | "availableActions" | "state">;

    expect(composerCanSubmit(true, false, true)).toBe(true);
    expect(composerCanSubmit(true, false, false)).toBe(false);
    expect(composerCanSubmit(false, true, true)).toBe(true);
    expect(composerCanSubmit(false, true, false)).toBe(false);
    expect(composerDeliveryDecisionForRuntime(running, "steer", true, false)).toBe("queue");
    expect(composerDeliveryDecisionForRuntime(running, "steer", true, true)).toBe("steer");
    expect(composerDeliveryDecisionForRuntime(running, "steer", true, true, false)).toBe("queue");
  });

  it("只在服务器支持时显示目标、计划模式与压缩入口", () => {
    expect(
      composerToolActions({
        capabilities: {
          goals: "available",
          collaborationModes: "available",
          contextCompaction: "unavailable",
        },
        canCompact: false,
        canAttach: false,
        hasCollaborationModes: true,
      }).map((action) => action.id),
    ).toEqual(["goal", "plan"]);
  });

  it("Remote 队列移动保持稳定顺序且不修改原数组", () => {
    const base = {
      threadId: "thread",
      clientUserMessageId: "client",
      state: "queued" as const,
      revision: 1,
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
    };
    const queue: QueuedTurnItem[] = [
      { ...base, id: "one", clientUserMessageId: "client-one", prompt: "第一条", position: 0 },
      { ...base, id: "two", clientUserMessageId: "client-two", prompt: "第二条", position: 1 },
      { ...base, id: "three", clientUserMessageId: "client-three", prompt: "第三条", position: 2 },
    ];
    const moved = moveQueueItem(queue, "three", -1);

    expect(moved.map((item) => [item.id, item.position])).toEqual([
      ["one", 0],
      ["three", 1],
      ["two", 2],
    ]);
    expect(queue.map((item) => item.id)).toEqual(["one", "two", "three"]);
  });

  it("Remote 队列排序跳过已由 Codex 接管的项目", () => {
    const base = {
      threadId: "thread",
      revision: 1,
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    };
    const queue: QueuedTurnItem[] = [
      {
        ...base,
        id: "started",
        clientUserMessageId: "client-started",
        state: "started",
        position: 0,
      },
      {
        ...base,
        id: "one",
        clientUserMessageId: "client-one",
        state: "queued",
        prompt: "第一条",
        position: 1,
      },
      {
        ...base,
        id: "two",
        clientUserMessageId: "client-two",
        state: "queued",
        prompt: "第二条",
        position: 2,
      },
    ];

    const moved = moveQueueItem(queue, "one", 1);

    expect(moved.map((item) => [item.id, item.position])).toEqual([
      ["started", 0],
      ["two", 1],
      ["one", 2],
    ]);
    expect(queueIdsForReorder(moved)).toEqual(["two", "one"]);
    expect(queue.map((item) => item.id)).toEqual(["started", "one", "two"]);
  });

  it("线程内审批不因详情 turn id 延迟而隐藏，并把当前 turn 的问题排在前面", () => {
    const approvals: ApprovalRequest[] = [
      {
        id: "other",
        threadId: "other-thread",
        title: "其他任务",
        choices: [],
      },
      {
        id: "thread-wide",
        threadId: "thread",
        title: "线程级问题",
        choices: [],
      },
      {
        id: "active",
        threadId: "thread",
        turnId: "turn-current",
        title: "当前轮问题",
        choices: [],
      },
      {
        id: "newer-than-detail",
        threadId: "thread",
        turnId: "turn-not-yet-projected",
        title: "详情尚未同步的新一轮问题",
        choices: [],
      },
    ];

    expect(
      filterThreadApprovals(approvals, "thread", "turn-current").map((item) => item.id),
    ).toEqual(["active", "thread-wide", "newer-than-detail"]);
  });
});
