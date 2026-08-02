import type { RemoteEvent, ThreadDetail, UsageSnapshot } from "@codex-local-remote/contracts";
import { describe, expect, it } from "vitest";
import {
  applyThreadRemoteEvents,
  applyUsageRemoteEvents,
  cancelSubmittedTurnUserAlias,
  consumeNextTurnSettingsDraft,
  createThreadRemoteEventProjectionState,
  detailFromThreadSummary,
  nextTurnSettingsInput,
  nextTurnSettingsDraft,
  rememberSubmittedTurnUserAlias,
  reserveSubmittedTurnUserAlias,
  reconcileThreadSnapshotLists,
  reconcileNextTurnSettingsDraft,
  synchronizeThreadRemoteEventProjection,
  threadControlSnapshotIsCurrent,
  threadSummaryFromSnapshotEvent,
  updateNextTurnSettingsDraft,
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
  it("把实际运行设置与下一轮草稿分离，直到成功发送才消费用户选择", () => {
    const models = [
      {
        id: "model-a",
        displayName: "A",
        supportedReasoningEfforts: ["medium"],
        defaultReasoningEffort: "medium",
        isDefault: true,
      },
      {
        id: "model-b",
        displayName: "B",
        supportedReasoningEfforts: ["medium", "high"],
        defaultReasoningEffort: "medium",
        isDefault: false,
      },
    ];
    const runtimeA = detail({ model: "model-a", reasoningEffort: "medium", state: "running" });
    let draft = nextTurnSettingsDraft(models, runtimeA);

    draft = updateNextTurnSettingsDraft(draft, { model: "model-b", effort: "high" });
    draft = reconcileNextTurnSettingsDraft(draft, models, runtimeA);
    const completedRuntime = {
      ...runtimeA,
      state: "complete" as const,
    };
    draft = reconcileNextTurnSettingsDraft(draft, models, completedRuntime);

    expect(draft).toEqual({
      model: "model-b",
      effort: "high",
      dirty: true,
      runtimeEffortKnown: true,
      runtimeModelKnown: true,
    });

    draft = consumeNextTurnSettingsDraft(
      draft,
      models,
      detail({ model: "model-b", reasoningEffort: "high", state: "running" }),
    );
    expect(draft).toEqual({
      model: "model-b",
      effort: "high",
      dirty: false,
      runtimeEffortKnown: true,
      runtimeModelKnown: true,
    });

    const switchedThreadDraft = nextTurnSettingsDraft(
      models,
      detail({ id: "thread-2", model: "model-a", reasoningEffort: "medium" }),
    );
    expect(switchedThreadDraft).toMatchObject({
      model: "model-a",
      effort: "medium",
      dirty: false,
    });
  });

  it("原样保留目录外的实际模型与思考等级，绝不伪装默认值或静默发送", () => {
    const models = [
      {
        id: "model-a",
        displayName: "A",
        supportedReasoningEfforts: ["medium"],
        defaultReasoningEffort: "medium",
        isDefault: true,
      },
      {
        id: "model-b",
        displayName: "B",
        supportedReasoningEfforts: ["medium", "high"],
        defaultReasoningEffort: "medium",
        isDefault: false,
      },
    ];
    const displayOnly = nextTurnSettingsDraft(models, detail());
    expect(displayOnly).toMatchObject({ model: "model-a", effort: "medium", dirty: false });
    expect(nextTurnSettingsInput(displayOnly, models)).toEqual({});
    const unsupportedActual = nextTurnSettingsDraft(
      models,
      detail({ model: "future-model", reasoningEffort: "future-effort" }),
    );
    expect(unsupportedActual).toEqual({
      model: "future-model",
      effort: "future-effort",
      dirty: false,
      runtimeModelKnown: true,
      runtimeEffortKnown: true,
    });
    expect(nextTurnSettingsInput(unsupportedActual, models)).toEqual({});

    const selected = updateNextTurnSettingsDraft(displayOnly, {
      model: "model-b",
      effort: "high",
    });
    expect(nextTurnSettingsInput(selected, models)).toEqual({
      model: "model-b",
      reasoningEffort: "high",
    });
  });

  it("目录外实际模型没有思考等级时保持未知，目录刷新也不能拿默认模型补写", () => {
    const initialModels = [
      {
        id: "default-a",
        displayName: "Default A",
        supportedReasoningEfforts: ["medium"],
        defaultReasoningEffort: "medium",
        isDefault: true,
      },
    ];
    const runtime = detail({ model: "provider/custom-model" });
    const initial = nextTurnSettingsDraft(initialModels, runtime);
    expect(initial).toEqual({
      model: "provider/custom-model",
      effort: undefined,
      dirty: false,
      runtimeModelKnown: true,
      runtimeEffortKnown: false,
    });

    const refreshed = reconcileNextTurnSettingsDraft(
      initial,
      [
        {
          id: "new-default",
          displayName: "New Default",
          supportedReasoningEfforts: ["xhigh"],
          defaultReasoningEffort: "xhigh",
          isDefault: true,
        },
      ],
      runtime,
    );
    expect(refreshed).toEqual(initial);
    expect(nextTurnSettingsInput(refreshed, initialModels)).toEqual({});
  });

  it("实际目录模型的未来思考等级保持原样，只有用户选择目录项后才规范化并发送", () => {
    const models = [
      {
        id: "model-a",
        displayName: "A",
        supportedReasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "low",
        isDefault: true,
      },
      {
        id: "model-b",
        displayName: "B",
        supportedReasoningEfforts: ["minimal"],
        defaultReasoningEffort: "minimal",
        isDefault: false,
      },
    ];
    const actual = nextTurnSettingsDraft(
      models,
      detail({ model: "model-a", reasoningEffort: "ultra-future" }),
    );
    expect(actual).toEqual({
      model: "model-a",
      effort: "ultra-future",
      dirty: false,
      runtimeModelKnown: true,
      runtimeEffortKnown: true,
    });
    expect(nextTurnSettingsInput(actual, models)).toEqual({});

    const userSelected = updateNextTurnSettingsDraft(actual, {
      model: "model-b",
      effort: "ultra-future",
    });
    expect(nextTurnSettingsInput(userSelected, models)).toEqual({
      model: "model-b",
      reasoningEffort: "minimal",
    });
  });

  it("拒绝把程序写入的目录外 dirty 值按默认模型发送", () => {
    const models = [
      {
        id: "default-a",
        displayName: "Default A",
        supportedReasoningEfforts: ["medium"],
        defaultReasoningEffort: "medium",
        isDefault: true,
      },
    ];
    const invalid = updateNextTurnSettingsDraft(nextTurnSettingsDraft(models, detail()), {
      model: "not-in-runtime-catalog",
      effort: "future-effort",
    });
    expect(nextTurnSettingsInput(invalid, models)).toEqual({});
  });

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
      createdAt: "2026-07-25T10:00:02.000Z",
      id: "tool-1",
      kind: "tool",
      title: "运行命令",
      status: "running",
      summary: "长时间真实任务",
      turnId: "turn-1",
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
        turnId: "turn-1",
      },
      {
        id: "assistant-1",
        kind: "assistant-message",
        text: "正在处理真实任务。",
        createdAt: "2026-07-25T10:00:03.000Z",
        turnId: "turn-1",
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
      createdAt: "2026-07-25T10:00:01.000Z",
      kind: "assistant-message",
      text: "哈哈",
    });
  });

  it("用完整快照水位在 projection 重建后忽略旧 delta，同时保留真正新 delta", () => {
    const projection = createThreadRemoteEventProjectionState();
    const abcEvents = [
      event(1, "thread.item", {
        kind: "assistant-message-delta",
        itemId: "assistant-1",
        delta: "A",
      }),
      event(2, "thread.item", {
        kind: "assistant-message-delta",
        itemId: "assistant-1",
        delta: "B",
      }),
      event(3, "thread.item", {
        kind: "assistant-message-delta",
        itemId: "assistant-1",
        delta: "C",
      }),
    ];
    const refreshedSnapshot = {
      ...detail({
        items: [{ id: "assistant-1", kind: "assistant-message", text: "ABC" }],
      }),
      snapshotEventSeq: 3,
    };
    synchronizeThreadRemoteEventProjection(projection, refreshedSnapshot);
    let replayed: ThreadDetail = refreshedSnapshot;
    for (const oldEvent of abcEvents) {
      replayed = applyThreadRemoteEvents(replayed, [oldEvent], {
        projection,
        replayed: true,
      });
    }
    expect(replayed.items[0]).toMatchObject({ text: "ABC" });

    replayed = applyThreadRemoteEvents(
      replayed,
      [
        event(4, "thread.item", {
          kind: "assistant-message-delta",
          itemId: "assistant-1",
          delta: "D",
        }),
      ],
      { projection, replayed: true },
    );
    expect(replayed.items[0]).toMatchObject({ text: "ABCD" });
  });

  it("缺少快照水位时用 overlap 保守合并，并在 connection reset 后接受重置的 seq", () => {
    const projection = createThreadRemoteEventProjectionState();
    const priorGeneration = projection.generation;
    const snapshot = detail({
      items: [{ id: "assistant-1", kind: "assistant-message", text: "ABC" }],
    });
    let projected = snapshot;
    for (const oldEvent of [
      event(1, "thread.item", {
        kind: "assistant-message-delta",
        itemId: "assistant-1",
        delta: "A",
      }),
      event(2, "thread.item", {
        kind: "assistant-message-delta",
        itemId: "assistant-1",
        delta: "B",
      }),
      event(3, "thread.item", {
        kind: "assistant-message-delta",
        itemId: "assistant-1",
        delta: "C",
      }),
    ]) {
      projected = applyThreadRemoteEvents(projected, [oldEvent], {
        projection,
        replayed: true,
      });
    }
    expect(projected.items[0]).toMatchObject({ text: "ABC" });

    projected = applyThreadRemoteEvents(
      projected,
      [
        event(
          0,
          "connection.reset",
          { latestSequence: 0, oldestAvailableSequence: 0, reason: "events-expired" },
          {},
        ),
        event(1, "thread.item", {
          kind: "assistant-message-delta",
          itemId: "assistant-1",
          delta: "D",
        }),
      ],
      { projection },
    );
    expect(projected.items[0]).toMatchObject({ text: "ABCD" });
    expect(
      synchronizeThreadRemoteEventProjection(
        projection,
        {
          ...snapshot,
          snapshotEventSeq: 99,
        },
        priorGeneration,
      ),
    ).toBe(false);
    projected = applyThreadRemoteEvents(
      projected,
      [
        event(2, "thread.item", {
          kind: "assistant-message-delta",
          itemId: "assistant-1",
          delta: "E",
        }),
      ],
      { projection },
    );
    expect(projected.items[0]).toMatchObject({ text: "ABCDE" });
  });

  it("只接受覆盖当前事件水位和连接代际的权威控制壳", () => {
    const projection = createThreadRemoteEventProjectionState();
    const generation = projection.generation;
    const snapshot = {
      ...detail({ state: "running" }),
      snapshotEventSeq: 3,
    };
    synchronizeThreadRemoteEventProjection(projection, snapshot);
    applyThreadRemoteEvents(
      snapshot,
      [
        event(4, "turn.state", {
          state: "complete",
          turn: { id: "turn-1", status: "completed" },
        }),
      ],
      { projection },
    );

    expect(
      threadControlSnapshotIsCurrent(projection, { ...snapshot, snapshotEventSeq: 3 }, generation),
    ).toBe(false);
    expect(
      threadControlSnapshotIsCurrent(projection, { ...snapshot, snapshotEventSeq: 4 }, generation),
    ).toBe(true);

    applyThreadRemoteEvents(
      snapshot,
      [
        event(
          4,
          "connection.reset",
          { latestSequence: 4, oldestAvailableSequence: 4, reason: "events-expired" },
          {},
        ),
      ],
      { projection },
    );
    expect(
      threadControlSnapshotIsCurrent(projection, { ...snapshot, snapshotEventSeq: 4 }, generation),
    ).toBe(false);
    expect(
      threadControlSnapshotIsCurrent(projection, {
        ...snapshot,
        snapshotEventSeq: 4,
      }),
    ).toBe(true);
  });

  it("即时接纳合法 Desktop thread.snapshot，拒绝空壳并保持当前/归档互斥", () => {
    const desktopSnapshotEvent = event(
      7,
      "thread.snapshot",
      {
        id: "desktop-started",
        title: "Desktop 新任务",
        mode: "desktop-snapshot",
        state: "running",
        serviceTier: "fast",
        permissionProfileId: "workspace-write",
        collaborationMode: "plan",
        updatedAt: "2026-07-25T10:00:07.000Z",
      },
      { threadId: "desktop-started" },
    );
    const snapshot = threadSummaryFromSnapshotEvent(desktopSnapshotEvent);
    expect(snapshot).toMatchObject({
      id: "desktop-started",
      title: "Desktop 新任务",
      mode: "desktop-snapshot",
      serviceTier: "fast",
      permissionProfileId: "workspace-write",
      collaborationMode: "plan",
    });
    expect(
      threadSummaryFromSnapshotEvent(
        event(8, "thread.snapshot", { title: "缺少 ID" }, { threadId: "ghost" }),
      ),
    ).toBeUndefined();

    const reconciled = reconcileThreadSnapshotLists(
      [
        {
          id: "loaded-tail",
          title: "已加载尾页",
          mode: "managed",
          state: "idle",
          updatedAt: "2026-07-25T09:00:00.000Z",
        },
      ],
      [
        {
          id: "desktop-started",
          title: "旧归档行",
          mode: "desktop-snapshot",
          state: "idle",
          updatedAt: "2026-07-25T08:00:00.000Z",
          archived: true,
        },
      ],
      snapshot!,
    );
    expect(reconciled.current.map((thread) => thread.id)).toEqual([
      "desktop-started",
      "loaded-tail",
    ]);
    expect(reconciled.archived).toEqual([]);
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
        createdAt: "2026-07-25T10:00:01.000Z",
        id: "tool-1",
        kind: "tool",
        title: "运行命令",
        status: "running",
        summary: "等待 90 秒",
        turnId: "turn-1",
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
        createdAt: "2026-07-25T10:00:02.000Z",
        id: "tool-1",
        kind: "tool",
        title: "运行命令",
        status: "complete",
        summary: "等待 90 秒",
        detail: "已完成",
        turnId: "turn-1",
      },
    ]);
  });

  it("保留上下文压缩标识并用完成态替换同一运行项", () => {
    const running = applyThreadRemoteEvents(detail(), [
      event(1, "thread.item", {
        lifecycle: "started",
        item: [
          {
            id: "compaction-1",
            kind: "tool",
            operation: "context-compaction",
            title: "压缩对话上下文",
            status: "running",
          },
        ],
      }),
    ]);
    const completed = applyThreadRemoteEvents(running, [
      event(2, "thread.item", {
        lifecycle: "completed",
        item: [
          {
            id: "compaction-1",
            kind: "tool",
            operation: "context-compaction",
            title: "压缩对话上下文",
            status: "complete",
          },
        ],
      }),
    ]);

    expect(completed.items).toEqual([
      {
        createdAt: "2026-07-25T10:00:02.000Z",
        id: "compaction-1",
        kind: "tool",
        operation: "context-compaction",
        title: "压缩对话上下文",
        status: "complete",
        turnId: "turn-1",
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

  it("不可重试错误投影为 failed 后清除活动轮次并恢复下一轮回复", () => {
    const running = detail({
      activeTurnId: "turn-1",
      state: "running",
      availableActions: {
        changeModelNextTurn: true,
        interrupt: true,
        reply: false,
        steer: true,
      },
    });

    const failed = applyThreadRemoteEvents(running, [
      event(1, "turn.state", {
        state: "failed",
        turn: { id: "turn-1", status: "failed" },
      }),
    ]);

    expect(failed.activeTurnId).toBeUndefined();
    expect(failed).toMatchObject({
      state: "failed",
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    });
  });

  it("迟到的其他轮次失败终态不会清除当前活动轮次", () => {
    const running = detail({
      activeTurnId: "turn-current",
      state: "running",
      availableActions: {
        changeModelNextTurn: true,
        interrupt: true,
        reply: false,
        steer: true,
      },
    });

    const unchanged = applyThreadRemoteEvents(running, [
      event(1, "turn.state", {
        state: "failed",
        turn: { id: "turn-old", status: "failed" },
      }),
    ]);

    expect(unchanged).toMatchObject({
      activeTurnId: "turn-current",
      state: "running",
      availableActions: {
        interrupt: true,
        reply: false,
        steer: true,
      },
    });
  });

  it("投影任务名称、模型和等待审批状态，但不接管其他任务", () => {
    const projected = applyThreadRemoteEvents(detail(), [
      event(1, "thread.updated", {
        archived: true,
        name: "手机端真实任务",
        status: { type: "active", activeFlags: ["waitingOnUserInput"] },
        threadSettings: {
          model: "gpt-5.6-terra",
          reasoningEffort: "high",
          serviceTier: "fast",
          permissionProfileId: "workspace-write",
          collaborationMode: "plan",
        },
      }),
      event(2, "thread.updated", { name: "其他任务" }, { threadId: "thread-other" }),
    ]);

    expect(projected).toMatchObject({
      archived: true,
      title: "手机端真实任务",
      state: "waiting-for-approval",
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
      serviceTier: "fast",
      permissionProfileId: "workspace-write",
      collaborationMode: "plan",
      availableActions: {
        changeModelNextTurn: false,
        interrupt: false,
        reply: false,
        steer: false,
      },
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

  it("turn/start 快照与实时生命周期使用不同 id 时仍只显示一条用户消息", () => {
    const seeded = detail({
      state: "running",
      activeTurnId: "turn-1",
      items: [
        {
          id: "item-12",
          kind: "user-message",
          text: "同一条真实消息",
          turnId: "turn-1",
        },
      ],
    });
    const projected = applyThreadRemoteEvents(seeded, [
      event(
        1,
        "thread.item",
        {
          item: [
            {
              id: "019f-live-user",
              kind: "user-message",
              text: "同一条真实消息",
            },
          ],
          lifecycle: "started",
        },
        { turnId: "turn-1" },
      ),
      event(
        2,
        "thread.item",
        {
          item: [
            {
              id: "019f-live-user",
              kind: "user-message",
              text: "同一条真实消息",
            },
          ],
          lifecycle: "completed",
        },
        { turnId: "turn-1" },
      ),
    ]);

    expect(projected.items).toEqual([
      {
        id: "item-12",
        kind: "user-message",
        text: "同一条真实消息",
        turnId: "turn-1",
      },
    ]);
  });

  it("相邻同文用户事件属于不同 turn 时保留两次真实发送", () => {
    const prompt = "继续检查";
    const projected = applyThreadRemoteEvents(
      detail({
        state: "running",
        activeTurnId: "turn-current",
        items: [
          {
            id: "previous-user",
            kind: "user-message",
            text: prompt,
            turnId: "turn-previous",
          },
        ],
      }),
      [
        event(
          1,
          "thread.item",
          {
            item: [{ id: "current-live-user", kind: "user-message", text: prompt }],
            lifecycle: "started",
          },
          { threadId: "thread-1", turnId: "turn-current" },
        ),
      ],
    );

    expect(
      projected.items.filter((item) => item.kind === "user-message").map((item) => item.id),
    ).toEqual(["previous-user", "current-live-user"]);
  });

  it("Desktop 快照按当前 turn 一对一吞掉越过思考到达的实时别名", () => {
    const prompt = "请继续做完整审计";
    const projected = applyThreadRemoteEvents(
      detail({
        state: "running",
        activeTurnId: "turn-current",
        items: [
          {
            id: "persisted-current-user",
            kind: "user-message",
            text: prompt,
            turnId: "turn-current",
          },
          {
            id: "current-reasoning",
            kind: "reasoning-summary",
            text: "正在审计",
            turnId: "turn-current",
          },
        ],
      }),
      [
        event(
          1,
          "thread.item",
          {
            item: [{ id: "desktop-live-alias", kind: "user-message", text: prompt }],
            lifecycle: "started",
          },
          { threadId: "thread-1", turnId: "turn-current" },
        ),
        event(
          2,
          "thread.item",
          {
            item: [{ id: "desktop-real-repeat", kind: "user-message", text: prompt }],
            lifecycle: "started",
          },
          { threadId: "thread-1", turnId: "turn-current" },
        ),
      ],
      { projection: createThreadRemoteEventProjectionState() },
    );

    expect(projected.items.map((item) => item.id)).toEqual([
      "persisted-current-user",
      "current-reasoning",
      "desktop-real-repeat",
    ]);
  });

  it("turn/start 回包后即使思考已插入，也只消费该次提交的实时用户别名", () => {
    const projection = createThreadRemoteEventProjectionState();
    const seeded = detail({
      state: "running",
      activeTurnId: "turn-1",
      items: [
        {
          id: "turn-start-user",
          kind: "user-message",
          text: "开始执行",
          turnId: "turn-1",
        },
        {
          id: "turn-start-reasoning",
          kind: "reasoning-summary",
          text: "准备创建文件",
          turnId: "turn-1",
        },
      ],
    });
    reserveSubmittedTurnUserAlias(projection, seeded.id, "开始执行");
    rememberSubmittedTurnUserAlias(projection, seeded, "开始执行");

    const projected = applyThreadRemoteEvents(
      seeded,
      [
        event(
          1,
          "thread.item",
          {
            item: [
              {
                id: "live-user-alias",
                kind: "user-message",
                text: "开始执行",
              },
            ],
            lifecycle: "started",
          },
          { threadId: "thread-1", turnId: "turn-1" },
        ),
        event(
          2,
          "thread.item",
          {
            item: [
              {
                id: "live-user-alias",
                kind: "user-message",
                text: "开始执行",
              },
            ],
            lifecycle: "completed",
          },
          { threadId: "thread-1", turnId: "turn-1" },
        ),
        event(
          3,
          "thread.item",
          {
            item: [
              {
                id: "later-real-repeat",
                kind: "user-message",
                text: "开始执行",
              },
            ],
            lifecycle: "completed",
          },
          { threadId: "thread-1", turnId: "turn-1" },
        ),
      ],
      { projection },
    );

    expect(projected.items.map((item) => item.id)).toEqual([
      "turn-start-user",
      "turn-start-reasoning",
      "later-real-repeat",
    ]);
  });

  it("实时用户事件先于 turn/start 回包时也不会短暂重复", () => {
    const projection = createThreadRemoteEventProjectionState();
    const prompt = "批准写入";
    const beforeResponse = detail({ items: [] });
    reserveSubmittedTurnUserAlias(projection, beforeResponse.id, prompt);

    const liveProjected = applyThreadRemoteEvents(
      beforeResponse,
      [
        event(
          1,
          "thread.item",
          {
            item: [
              {
                id: "live-user-before-response",
                kind: "user-message",
                text: prompt,
              },
            ],
            lifecycle: "started",
          },
          { threadId: beforeResponse.id, turnId: "turn-1" },
        ),
      ],
      { projection },
    );
    expect(liveProjected.items).toEqual([]);

    const authoritative = detail({
      activeTurnId: "turn-1",
      items: [
        {
          id: "turn-start-user",
          kind: "user-message",
          text: prompt,
          turnId: "turn-1",
        },
      ],
      state: "running",
    });
    rememberSubmittedTurnUserAlias(projection, authoritative, prompt);
    expect(
      applyThreadRemoteEvents(
        authoritative,
        [
          event(
            2,
            "thread.item",
            {
              item: [
                {
                  id: "live-user-before-response",
                  kind: "user-message",
                  text: prompt,
                },
              ],
              lifecycle: "completed",
            },
            { threadId: authoritative.id, turnId: "turn-1" },
          ),
        ],
        { projection },
      ).items,
    ).toEqual(authoritative.items);
  });

  it("turn/start 回包后仍吞掉第二个不同 ID 的迟到用户别名", () => {
    const projection = createThreadRemoteEventProjectionState();
    const prompt = "第二个别名也不能重复";
    const beforeResponse = detail({ items: [] });
    reserveSubmittedTurnUserAlias(projection, beforeResponse.id, prompt);
    const firstLive = applyThreadRemoteEvents(
      beforeResponse,
      [
        event(
          1,
          "thread.item",
          {
            item: [{ id: "live-user-first", kind: "user-message", text: prompt }],
          },
          { threadId: beforeResponse.id, turnId: "turn-1" },
        ),
      ],
      { projection },
    );
    expect(firstLive.items).toEqual([]);

    const authoritative = detail({
      activeTurnId: "turn-1",
      items: [
        {
          id: "turn-start-user",
          kind: "user-message",
          text: prompt,
          turnId: "turn-1",
        },
        {
          id: "reasoning-after-user",
          kind: "reasoning-summary",
          text: "准备执行",
          turnId: "turn-1",
        },
      ],
      state: "running",
    });
    rememberSubmittedTurnUserAlias(projection, authoritative, prompt);
    const projected = applyThreadRemoteEvents(
      authoritative,
      [
        event(
          2,
          "thread.item",
          {
            item: [{ id: "live-user-second", kind: "user-message", text: prompt }],
          },
          { threadId: authoritative.id, turnId: "turn-1" },
        ),
      ],
      { projection },
    );
    expect(projected.items).toEqual(authoritative.items);
  });

  it("引导回包先到时保留一条乐观消息，并吞掉随后到达的实时别名", () => {
    const projection = createThreadRemoteEventProjectionState();
    const prompt = "调整实现方向";
    const beforeResponse = detail({
      activeTurnId: "turn-1",
      items: [],
      state: "running",
    });
    reserveSubmittedTurnUserAlias(projection, beforeResponse.id, prompt);
    const optimistic = detail({
      activeTurnId: "turn-1",
      items: [
        {
          id: "pending-steer",
          kind: "user-message",
          text: prompt,
          turnId: "turn-1",
        },
      ],
      state: "running",
    });
    rememberSubmittedTurnUserAlias(projection, optimistic, prompt);

    const projected = applyThreadRemoteEvents(
      optimistic,
      [
        event(
          1,
          "thread.item",
          {
            item: [
              {
                id: "live-steer",
                kind: "user-message",
                text: prompt,
              },
            ],
          },
          { threadId: optimistic.id, turnId: "turn-1" },
        ),
      ],
      { projection },
    );

    expect(projected.items).toEqual(optimistic.items);
  });

  it("连续提交两条引导时按提交顺序一对一消费各自的官方用户事件", () => {
    const projection = createThreadRemoteEventProjectionState();
    let projected = detail({
      activeTurnId: "turn-1",
      items: [],
      state: "running",
    });

    for (const [id, prompt] of [
      ["pending-steer-a", "先检查 A"],
      ["pending-steer-b", "再检查 B"],
    ] as const) {
      reserveSubmittedTurnUserAlias(projection, projected.id, prompt);
      projected = {
        ...projected,
        items: [...projected.items, { id, kind: "user-message", text: prompt, turnId: "turn-1" }],
      };
      rememberSubmittedTurnUserAlias(projection, projected, prompt);
    }

    projected = applyThreadRemoteEvents(
      projected,
      [
        event(
          1,
          "thread.item",
          {
            item: [{ id: "canonical-a", kind: "user-message", text: "先检查 A" }],
          },
          { threadId: projected.id, turnId: "turn-1" },
        ),
        event(
          2,
          "thread.item",
          {
            item: [{ id: "canonical-b", kind: "user-message", text: "再检查 B" }],
          },
          { threadId: projected.id, turnId: "turn-1" },
        ),
      ],
      { projection },
    );

    expect(projected.items.map((item) => item.id)).toEqual(["pending-steer-a", "pending-steer-b"]);
  });

  it("连续提交同文引导时也为每次提交保留一条消息", () => {
    const projection = createThreadRemoteEventProjectionState();
    const prompt = "继续检查";
    let projected = detail({
      activeTurnId: "turn-1",
      items: [],
      state: "running",
    });

    for (const id of ["pending-steer-first", "pending-steer-second"]) {
      reserveSubmittedTurnUserAlias(projection, projected.id, prompt);
      projected = {
        ...projected,
        items: [...projected.items, { id, kind: "user-message", text: prompt, turnId: "turn-1" }],
      };
      rememberSubmittedTurnUserAlias(projection, projected, prompt);
    }
    projected = {
      ...projected,
      items: [
        ...projected.items,
        {
          id: "reasoning-after-repeated-steers",
          kind: "reasoning-summary",
          text: "继续处理",
          turnId: "turn-1",
        },
      ],
    };

    projected = applyThreadRemoteEvents(
      projected,
      [
        event(
          1,
          "thread.item",
          {
            item: [{ id: "canonical-first", kind: "user-message", text: prompt }],
          },
          { threadId: projected.id, turnId: "turn-1" },
        ),
        event(
          2,
          "thread.item",
          {
            item: [{ id: "canonical-second", kind: "user-message", text: prompt }],
          },
          { threadId: projected.id, turnId: "turn-1" },
        ),
      ],
      { projection },
    );

    expect(
      projected.items.filter((item) => item.kind === "user-message").map((item) => item.id),
    ).toEqual(["pending-steer-first", "pending-steer-second"]);
  });

  it("权威快照同步不会过早清除尚未消费的用户消息别名", () => {
    const projection = createThreadRemoteEventProjectionState();
    const prompt = "只保留一条消息";
    const authoritative = detail({
      activeTurnId: "turn-1",
      items: [
        {
          id: "turn-response-user",
          kind: "user-message",
          text: prompt,
          turnId: "turn-1",
        },
      ],
      snapshotEventSeq: 4,
      state: "running",
    });
    reserveSubmittedTurnUserAlias(projection, authoritative.id, prompt);
    rememberSubmittedTurnUserAlias(projection, authoritative, prompt);
    expect(synchronizeThreadRemoteEventProjection(projection, authoritative)).toBe(true);

    const projected = applyThreadRemoteEvents(
      authoritative,
      [
        event(
          5,
          "thread.item",
          {
            item: [
              {
                id: "late-live-user-alias",
                kind: "user-message",
                text: prompt,
              },
            ],
          },
          { threadId: authoritative.id, turnId: "turn-1" },
        ),
      ],
      { projection },
    );

    expect(projected.items).toEqual(authoritative.items);
  });

  it("引导实时事件先到时由回包后的乐观消息补齐且不会再次回显", () => {
    const projection = createThreadRemoteEventProjectionState();
    const prompt = "继续但不要扩大范围";
    const beforeResponse = detail({
      activeTurnId: "turn-1",
      items: [],
      state: "running",
    });
    reserveSubmittedTurnUserAlias(projection, beforeResponse.id, prompt);

    const liveProjected = applyThreadRemoteEvents(
      beforeResponse,
      [
        event(
          1,
          "thread.item",
          {
            item: [
              {
                id: "live-steer-before-response",
                kind: "user-message",
                text: prompt,
              },
            ],
          },
          { threadId: beforeResponse.id, turnId: "turn-1" },
        ),
      ],
      { projection },
    );
    expect(liveProjected.items).toEqual([]);

    const optimistic = {
      ...liveProjected,
      items: [
        ...liveProjected.items,
        {
          id: "pending-steer-after-response",
          kind: "user-message" as const,
          text: prompt,
          turnId: "turn-1",
        },
      ],
    };
    rememberSubmittedTurnUserAlias(projection, optimistic, prompt);

    const replayed = applyThreadRemoteEvents(
      optimistic,
      [
        event(
          2,
          "thread.item",
          {
            item: [
              {
                id: "live-steer-before-response",
                kind: "user-message",
                text: prompt,
              },
            ],
          },
          { threadId: optimistic.id, turnId: "turn-1" },
        ),
      ],
      { projection },
    );

    expect(replayed.items).toEqual(optimistic.items);
  });

  it("另一浏览器立即显示 Sidecar 引导别名，随后官方事件不会重复", () => {
    const projection = createThreadRemoteEventProjectionState();
    const prompt = "跨页立即同步引导";
    const before = detail({
      activeTurnId: "turn-1",
      items: [],
      state: "running",
    });
    const aliasEvent = event(
      1,
      "thread.item",
      {
        item: [
          {
            id: "pending-steer-broadcast",
            kind: "user-message",
            text: prompt,
          },
        ],
        lifecycle: "completed",
        localRemoteAlias: "steer",
      },
      { threadId: before.id, turnId: "turn-1" },
    );
    const immediate = applyThreadRemoteEvents(before, [aliasEvent], { projection });
    expect(immediate.items).toEqual([
      expect.objectContaining({
        id: "pending-steer-broadcast",
        kind: "user-message",
        text: prompt,
        turnId: "turn-1",
      }),
    ]);

    const canonical = applyThreadRemoteEvents(
      immediate,
      [
        event(
          2,
          "thread.item",
          {
            item: [
              {
                id: "canonical-steer",
                kind: "user-message",
                text: prompt,
              },
            ],
          },
          { threadId: before.id, turnId: "turn-1" },
        ),
      ],
      { projection },
    );
    expect(canonical.items).toEqual(immediate.items);
  });

  it("另一浏览器连续收到两条同文 Sidecar 引导时保留两次真实提交", () => {
    const projection = createThreadRemoteEventProjectionState();
    const prompt = "继续检查";
    const before = detail({
      activeTurnId: "turn-1",
      items: [],
      state: "running",
    });

    const projected = applyThreadRemoteEvents(
      before,
      [
        event(
          1,
          "thread.item",
          {
            item: [
              {
                id: "pending-steer-broadcast-first",
                kind: "user-message",
                text: prompt,
              },
            ],
            localRemoteAlias: "steer",
          },
          { threadId: before.id, turnId: "turn-1" },
        ),
        event(
          2,
          "thread.item",
          {
            item: [
              {
                id: "pending-steer-broadcast-second",
                kind: "user-message",
                text: prompt,
              },
            ],
            localRemoteAlias: "steer",
          },
          { threadId: before.id, turnId: "turn-1" },
        ),
      ],
      { projection },
    );

    expect(projected.items.map((item) => item.id)).toEqual([
      "pending-steer-broadcast-first",
      "pending-steer-broadcast-second",
    ]);

    const canonical = applyThreadRemoteEvents(
      projected,
      [
        event(
          3,
          "thread.item",
          {
            item: [{ id: "canonical-first", kind: "user-message", text: prompt }],
          },
          { threadId: before.id, turnId: "turn-1" },
        ),
        event(
          4,
          "thread.item",
          {
            item: [{ id: "canonical-second", kind: "user-message", text: prompt }],
          },
          { threadId: before.id, turnId: "turn-1" },
        ),
      ],
      { projection },
    );
    expect(canonical.items.map((item) => item.id)).toEqual([
      "pending-steer-broadcast-first",
      "pending-steer-broadcast-second",
    ]);
  });

  it("Sidecar 拒绝引导时会撤下另一浏览器的乐观别名", () => {
    const projection = createThreadRemoteEventProjectionState();
    const before = detail({
      activeTurnId: "turn-1",
      items: [],
      state: "running",
    });
    const immediate = applyThreadRemoteEvents(
      before,
      [
        event(
          1,
          "thread.item",
          {
            item: [
              {
                id: "pending-steer-rejected",
                kind: "user-message",
                text: "这次引导会失败",
              },
            ],
            localRemoteAlias: "steer",
          },
          { threadId: before.id, turnId: "turn-1" },
        ),
      ],
      { projection },
    );
    expect(immediate.items).toHaveLength(1);
    const rolledBack = applyThreadRemoteEvents(
      immediate,
      [
        event(
          2,
          "thread.item",
          {
            item: [
              {
                id: "pending-steer-rejected",
                kind: "user-message",
                text: "这次引导会失败",
              },
            ],
            localRemoteAlias: "steer-cancel",
          },
          { threadId: before.id, turnId: "turn-1" },
        ),
      ],
      { projection },
    );
    expect(rolledBack.items).toEqual([]);
  });

  it("发送页吞掉 Sidecar 引导别名，并在回包与官方事件之间保持一条消息", () => {
    const projection = createThreadRemoteEventProjectionState();
    const prompt = "发送页只显示一次";
    const before = detail({
      activeTurnId: "turn-1",
      items: [],
      state: "running",
    });
    reserveSubmittedTurnUserAlias(projection, before.id, prompt);
    const afterBroadcast = applyThreadRemoteEvents(
      before,
      [
        event(
          1,
          "thread.item",
          {
            item: [
              {
                id: "pending-steer-sidecar",
                kind: "user-message",
                text: prompt,
              },
            ],
            localRemoteAlias: "steer",
          },
          { threadId: before.id, turnId: "turn-1" },
        ),
      ],
      { projection },
    );
    expect(afterBroadcast.items).toEqual([]);

    const optimistic = {
      ...afterBroadcast,
      items: [
        {
          id: "pending-steer-browser",
          kind: "user-message" as const,
          text: prompt,
          turnId: "turn-1",
        },
      ],
    };
    rememberSubmittedTurnUserAlias(projection, optimistic, prompt);
    const afterCanonical = applyThreadRemoteEvents(
      optimistic,
      [
        event(
          2,
          "thread.item",
          {
            item: [
              {
                id: "canonical-steer",
                kind: "user-message",
                text: prompt,
              },
            ],
          },
          { threadId: before.id, turnId: "turn-1" },
        ),
      ],
      { projection },
    );
    expect(afterCanonical.items).toEqual(optimistic.items);
  });

  it("官方引导事件先到时也不会在 Sidecar 广播和回包后出现第二条", () => {
    const projection = createThreadRemoteEventProjectionState();
    const prompt = "官方事件先到";
    const before = detail({
      activeTurnId: "turn-1",
      items: [],
      state: "running",
    });
    reserveSubmittedTurnUserAlias(projection, before.id, prompt);
    const afterCanonical = applyThreadRemoteEvents(
      before,
      [
        event(
          1,
          "thread.item",
          {
            item: [{ id: "canonical-first", kind: "user-message", text: prompt }],
          },
          { threadId: before.id, turnId: "turn-1" },
        ),
      ],
      { projection },
    );
    expect(afterCanonical.items).toEqual([]);
    const afterBroadcast = applyThreadRemoteEvents(
      afterCanonical,
      [
        event(
          2,
          "thread.item",
          {
            item: [{ id: "pending-steer-sidecar", kind: "user-message", text: prompt }],
            localRemoteAlias: "steer",
          },
          { threadId: before.id, turnId: "turn-1" },
        ),
      ],
      { projection },
    );
    expect(afterBroadcast.items).toEqual([]);

    const optimistic = {
      ...afterBroadcast,
      items: [
        {
          id: "pending-steer-browser",
          kind: "user-message" as const,
          text: prompt,
          turnId: "turn-1",
        },
      ],
    };
    rememberSubmittedTurnUserAlias(projection, optimistic, prompt);
    expect(
      applyThreadRemoteEvents(
        optimistic,
        [
          event(
            3,
            "thread.item",
            {
              item: [{ id: "canonical-first", kind: "user-message", text: prompt }],
            },
            { threadId: before.id, turnId: "turn-1" },
          ),
        ],
        { projection },
      ).items,
    ).toEqual(optimistic.items);
  });

  it("发送失败会撤销用户消息别名预留，不吞掉下一次真实消息", () => {
    const projection = createThreadRemoteEventProjectionState();
    reserveSubmittedTurnUserAlias(projection, "thread-1", "重试消息");
    cancelSubmittedTurnUserAlias(projection, "thread-1", "重试消息");

    const projected = applyThreadRemoteEvents(
      detail(),
      [
        event(1, "thread.item", {
          item: [{ id: "real-retry", kind: "user-message", text: "重试消息" }],
        }),
      ],
      { projection },
    );
    expect(projected.items).toContainEqual(
      expect.objectContaining({ id: "real-retry", kind: "user-message", text: "重试消息" }),
    );
  });

  it("实时 user-message 保留 Desktop 声明的文件与图片附件", () => {
    const projected = applyThreadRemoteEvents(
      detail(),
      [
        event(1, "thread.item", {
          item: [
            {
              id: "user-with-attachments",
              kind: "user-message",
              text: "请查看附件",
              attachments: [
                {
                  kind: "file",
                  name: "evidence.json",
                  path: "E:\\PublicFixtures\\BrowserUploads\\upload-id\\evidence.json",
                },
                {
                  kind: "image",
                  name: "screen.png",
                  path: "E:\\PublicFixtures\\BrowserUploads\\upload-id\\screen.png",
                },
              ],
            },
          ],
        }),
      ],
      { projection: createThreadRemoteEventProjectionState() },
    );

    expect(projected.items).toContainEqual(
      expect.objectContaining({
        id: "user-with-attachments",
        kind: "user-message",
        attachments: [
          expect.objectContaining({ kind: "file", name: "evidence.json" }),
          expect.objectContaining({ kind: "image", name: "screen.png" }),
        ],
      }),
    );
  });

  it("部分额度事件只更新对应窗口，不让其他模型额度从面板消失", () => {
    const usage: UsageSnapshot = {
      updatedAt: "2026-07-25T10:00:00.000Z",
      windows: [
        {
          id: "spark-primary",
          label: "GPT-5.3-Codex-Spark · 当前周期",
          usedPercent: 4,
          remainingPercent: 96,
        },
        {
          id: "codex-primary",
          label: "Codex · 当前周期",
          usedPercent: 99,
          remainingPercent: 1,
        },
      ],
    };

    const projected = applyUsageRemoteEvents(usage, "thread-1", [
      event(1, "usage.updated", {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: { usedPercent: 100 },
        },
      }),
    ]);

    expect(projected?.windows).toEqual([
      expect.objectContaining({
        id: "spark-primary",
        remainingPercent: 96,
      }),
      expect.objectContaining({
        id: "codex-primary",
        remainingPercent: 0,
      }),
    ]);
  });
});
