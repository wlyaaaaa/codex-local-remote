import { describe, expect, it } from "vitest";

import {
  projectAppServerNotification,
  projectThreadDetail,
  projectThreadItem,
  projectThreadSummary,
} from "./projection.js";

const rawThread = {
  canAcceptDirectInput: true,
  id: "thread-1",
  name: null,
  preview: "修复移动端对话页",
  parentThreadId: null,
  cwd: "C:\\workspace\\sample-project",
  createdAt: 1_721_000_000,
  updatedAt: 1_721_000_100,
  status: { type: "idle" },
  turns: [
    {
      id: "turn-1",
      status: "completed",
      startedAt: 1_721_000_010,
      completedAt: 1_721_000_020,
      items: [
        {
          type: "userMessage",
          id: "user-1",
          content: [{ type: "text", text: "请修复布局", text_elements: [] }],
        },
        {
          type: "reasoning",
          id: "reasoning-1",
          summary: ["已定位到容器宽度问题"],
          content: ["这段隐藏推理绝不能出现在浏览器"],
        },
        {
          type: "commandExecution",
          id: "tool-1",
          command: "pnpm test",
          cwd: "C:\\workspace\\sample-project",
          status: "completed",
          aggregatedOutput: "12 tests passed",
          exitCode: 0,
        },
        {
          type: "agentMessage",
          id: "assistant-1",
          text: "布局已修复。",
        },
      ],
    },
  ],
};

describe("thread projection", () => {
  it("renders legacy percent-encoded Markdown titles as readable text", () => {
    expect(
      projectThreadSummary(
        {
          ...rawThread,
          name: "%2A%2Asteamcommunity.com%2A%2A",
        },
        { managed: false },
      ).title,
    ).toBe("steamcommunity.com");
  });

  it("projects an unowned desktop thread as a read-only snapshot", () => {
    const detail = projectThreadDetail(rawThread, {
      childCount: 2,
      managed: false,
      pinnedRank: 0,
      projectId: "project-1",
    });

    expect(detail).toMatchObject({
      id: "thread-1",
      title: "修复移动端对话页",
      projectId: "project-1",
      cwdLabel: "sample-project",
      childCount: 2,
      mode: "desktop-snapshot",
      pinnedRank: 0,
      state: "complete",
      availableActions: {
        changeModelNextTurn: false,
        interrupt: false,
        reply: false,
        steer: false,
      },
    });
    expect(JSON.stringify(detail)).not.toContain("隐藏推理");
    expect(detail.items).toContainEqual(
      expect.objectContaining({
        id: "reasoning-1",
        kind: "reasoning-summary",
        text: "已定位到容器宽度问题",
        turnStartedAt: "2024-07-14T23:33:30.000Z",
        turnId: "turn-1",
      }),
    );
    expect(detail.items).toContainEqual(
      expect.objectContaining({
        id: "tool-1",
        kind: "tool",
        status: "complete",
        title: "运行命令",
      }),
    );
  });

  it("enables live actions only for a managed thread with an active turn", () => {
    const summary = projectThreadSummary(
      {
        ...rawThread,
        status: { type: "active", activeFlags: [] },
        turns: [
          {
            id: "turn-live",
            status: "inProgress",
            startedAt: 1_721_000_030,
            items: [],
          },
        ],
      },
      { managed: true },
    );
    const detail = projectThreadDetail(
      {
        ...rawThread,
        status: { type: "active", activeFlags: [] },
        turns: [
          {
            id: "turn-live",
            status: "inProgress",
            startedAt: 1_721_000_030,
            items: [],
          },
        ],
      },
      { managed: true },
    );

    expect(summary).toMatchObject({ mode: "managed", state: "running" });
    expect(detail).toMatchObject({
      activeTurnId: "turn-live",
      availableActions: {
        changeModelNextTurn: true,
        interrupt: true,
        reply: false,
        steer: true,
      },
    });
  });

  it("projects the latest actual thread and turn runtime settings without inventing defaults", () => {
    const threadWithRuntimeSettings = {
      ...rawThread,
      model: "thread-model",
      reasoningEffort: "low",
      settings: {
        activePermissionProfile: { id: "future-profile" },
        approvalPolicy: "future-policy",
        approvalsReviewer: "future-reviewer",
        collaborationMode: { mode: "plan" },
        effort: "medium",
        model: "thread-settings-model",
        serviceTier: "future-speed",
      },
      turns: [
        ...rawThread.turns,
        {
          effort: "high",
          id: "turn-runtime",
          items: [],
          model: "turn-model",
          settings: {
            model: "turn-settings-model",
            reasoningEffort: "ultra",
          },
          status: "completed",
        },
      ],
    };

    expect(projectThreadSummary(threadWithRuntimeSettings, { managed: true })).toMatchObject({
      approvalsReviewer: "future-reviewer",
      approvalPolicy: "future-policy",
      collaborationMode: "plan",
      model: "thread-settings-model",
      permissionProfileId: "future-profile",
      reasoningEffort: "medium",
      serviceTier: "future-speed",
    });
    expect(
      projectThreadDetail(threadWithRuntimeSettings, {
        managed: true,
        model: "rerouted-model",
        reasoningEffort: null,
      }),
    ).toMatchObject({
      model: "rerouted-model",
    });
    expect(
      projectThreadDetail(threadWithRuntimeSettings, {
        managed: true,
        model: "rerouted-model",
        reasoningEffort: null,
      }).reasoningEffort,
    ).toBeUndefined();
    expect(projectThreadSummary(rawThread, { managed: true }).model).toBeUndefined();
    expect(projectThreadSummary(rawThread, { managed: true }).reasoningEffort).toBeUndefined();
  });

  it("selects the newest fallback turn settings regardless of thread turn array order", () => {
    const older = {
      id: "turn-older",
      items: [],
      settings: { effort: "low", model: "older-model" },
      startedAt: 100,
      status: "completed",
    };
    const newer = {
      id: "turn-newer",
      items: [],
      settings: { effort: "high", model: "newer-model" },
      startedAt: 200,
      status: "completed",
    };
    for (const turns of [
      [older, newer],
      [newer, older],
    ]) {
      expect(
        projectThreadSummary(
          {
            ...rawThread,
            turns,
          },
          { managed: true },
        ),
      ).toMatchObject({
        model: "newer-model",
        reasoningEffort: "high",
      });
    }
  });

  it("shows active approval and user-input waits as waiting instead of running", () => {
    expect(
      projectThreadSummary(
        {
          ...rawThread,
          status: { activeFlags: ["waitingOnUserInput"], type: "active" },
        },
        { managed: true },
      ).state,
    ).toBe("waiting-for-approval");
  });

  it("aggregates repeated tools and bounds unsafe command output", () => {
    const detail = projectThreadDetail(
      {
        ...rawThread,
        turns: [
          {
            id: "turn-tools",
            items: Array.from({ length: 10 }, (_, index) => ({
              aggregatedOutput: `${"x".repeat(40_000)}\u0000${index}`,
              command: "pnpm test\u0000",
              id: `tool-${index}`,
              status: "completed",
              type: "commandExecution",
            })),
            startedAt: 1_721_000_030,
            status: "completed",
          },
        ],
      },
      { managed: true },
    );

    const tools = detail.items.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      kind: "tool",
      occurrences: 10,
      summary: "pnpm test",
    });
    expect(tools[0]?.kind === "tool" ? tools[0].detail?.length : 0).toBeLessThanOrEqual(16_384);
    expect(tools[0]?.kind === "tool" ? tools[0].occurrenceDetails : undefined).toHaveLength(10);
    expect(tools[0]?.kind === "tool" ? tools[0].occurrenceDetails?.[0]?.id : undefined).toBe(
      "tool-0",
    );
    expect(tools[0]?.kind === "tool" ? tools[0].occurrenceDetails?.[9]?.id : undefined).toBe(
      "tool-9",
    );
    expect(
      tools[0]?.kind === "tool"
        ? tools[0].occurrenceDetails?.every(
            (occurrence) => (occurrence.detail?.length ?? 0) <= 16_384,
          )
        : false,
    ).toBe(true);
    expect(JSON.stringify(tools)).not.toContain("\\u0000");
  });

  it("projects persisted context compaction as a Chinese product tool card", () => {
    expect(
      projectThreadItem({
        id: "compaction-1",
        status: "completed",
        type: "contextCompaction",
      }),
    ).toEqual([
      {
        id: "compaction-1",
        kind: "tool",
        operation: "context-compaction",
        status: "complete",
        title: "压缩对话上下文",
      },
    ]);

    const detail = projectThreadDetail(
      {
        ...rawThread,
        turns: [
          {
            id: "turn-compaction",
            items: [{ id: "compaction-from-history", type: "contextCompaction" }],
            status: "completed",
          },
        ],
      },
      { managed: true },
    );
    expect(detail.items).toEqual([
      expect.objectContaining({
        id: "compaction-from-history",
        kind: "tool",
        operation: "context-compaction",
        status: "complete",
        title: "压缩对话上下文",
        turnId: "turn-compaction",
      }),
    ]);
  });

  it("preserves bounded file-change status, move target, and diff without counting headers", () => {
    const detail = projectThreadDetail(
      {
        ...rawThread,
        turns: [
          {
            id: "turn-diff",
            items: [
              {
                changes: [
                  {
                    diff: "--- a/file.ts\n+++ b/file.ts\n-old\u0000\n+new\n+another",
                    kind: { move_path: "src/moved.ts", type: "update" },
                    path: "src/file.ts",
                  },
                  {
                    diff: "+new",
                    kind: { type: "add" },
                    path: "src/new.ts",
                  },
                  {
                    diff: "-old",
                    kind: { type: "delete" },
                    path: "src/old.ts",
                  },
                ],
                id: "change-1",
                status: "completed",
                type: "fileChange",
              },
            ],
            startedAt: 1_721_000_030,
            status: "completed",
          },
        ],
      },
      { managed: true },
    );

    expect(detail.items).toContainEqual(
      expect.objectContaining({
        additions: 2,
        change: "modified",
        deletions: 1,
        diff: "--- a/file.ts\n+++ b/file.ts\n-old\n+new\n+another",
        kind: "file-change",
        path: "src/file.ts",
        status: "completed",
        targetPath: "src/moved.ts",
      }),
    );
    expect(detail.items).toContainEqual(
      expect.objectContaining({
        change: "added",
        kind: "file-change",
        path: "src/new.ts",
      }),
    );
    expect(detail.items).toContainEqual(
      expect.objectContaining({
        change: "deleted",
        kind: "file-change",
        path: "src/old.ts",
      }),
    );
    expect(JSON.stringify(detail)).not.toContain("\\u0000");
  });

  it("retains every file apply status and hard-bounds diff output", () => {
    for (const status of ["inProgress", "completed", "failed", "declined"] as const) {
      expect(
        projectThreadItem({
          changes: [{ diff: "x".repeat(80_000), kind: { type: "update" }, path: "src/file.ts" }],
          id: `change-${status}`,
          status,
          type: "fileChange",
        })[0],
      ).toMatchObject({ kind: "file-change", status });
    }
    const projected = projectThreadItem({
      changes: [{ diff: "x".repeat(80_000), kind: { type: "update" }, path: "src/file.ts" }],
      id: "change-bounded",
      status: "failed",
      type: "fileChange",
    })[0];
    expect(projected?.kind === "file-change" ? projected.diff?.length : 0).toBeLessThanOrEqual(
      65_536,
    );
  });

  it("maps subagent activity kinds without assuming a missing status is running", () => {
    const detail = projectThreadDetail(
      {
        ...rawThread,
        turns: [
          {
            id: "turn-subagents",
            items: [
              {
                agentPath: "agents/worker",
                agentThreadId: "thread-worker",
                id: "subagent-started",
                kind: "started",
                type: "subAgentActivity",
              },
              {
                agentPath: "agents/worker",
                agentThreadId: "thread-worker",
                id: "subagent-interacted",
                kind: "interacted",
                type: "subAgentActivity",
              },
              {
                agentPath: "agents/worker",
                agentThreadId: "thread-worker",
                id: "subagent-interrupted",
                kind: "interrupted",
                type: "subAgentActivity",
              },
            ],
            startedAt: 1_721_000_030,
            status: "completed",
          },
        ],
      },
      { managed: true },
    );

    expect(detail.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agents: [{ label: "worker", threadId: "thread-worker" }],
          id: "subagent-started",
          kind: "subagent-activity",
          status: "running",
        }),
        expect.objectContaining({ id: "subagent-interacted", status: "complete" }),
        expect.objectContaining({ id: "subagent-interrupted", status: "failed" }),
      ]),
    );
  });

  it("projects bounded tool results and schema-native sleep/image states", () => {
    const items = [
      ...projectThreadItem({
        error: { message: "连接工具失败\u0000" },
        id: "mcp-failed",
        result: null,
        status: "failed",
        tool: "lookup",
        type: "mcpToolCall",
      }),
      ...projectThreadItem({
        error: null,
        id: "mcp-complete",
        result: {
          content: [{ text: "查询完成", type: "text" }],
          structuredContent: null,
        },
        status: "completed",
        tool: "lookup",
        type: "mcpToolCall",
      }),
      ...projectThreadItem({
        contentItems: [
          { text: "工具返回正文\u0000", type: "inputText" },
          { imageUrl: "data:image/png;base64,secret", type: "inputImage" },
        ],
        id: "dynamic-failed",
        status: "completed",
        success: false,
        tool: "render",
        type: "dynamicToolCall",
      }),
      ...projectThreadItem({
        durationMs: 1_500,
        id: "sleep-1",
        type: "sleep",
      }),
      ...projectThreadItem({
        id: "image-1",
        revisedPrompt: "一张测试图",
        status: "inProgress",
        type: "imageGeneration",
      }),
    ];

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail: "连接工具失败",
          id: "mcp-failed",
          status: "failed",
        }),
        expect.objectContaining({
          detail: "查询完成",
          id: "mcp-complete",
          status: "complete",
        }),
        expect.objectContaining({
          detail: "工具返回正文",
          id: "dynamic-failed",
          status: "failed",
        }),
        expect.objectContaining({
          id: "sleep-1",
          status: "complete",
          summary: "1500 毫秒",
          title: "等待",
        }),
        expect.objectContaining({
          id: "image-1",
          status: "running",
          summary: "一张测试图",
        }),
      ]),
    );
    expect(JSON.stringify(items)).not.toContain("base64,secret");
    expect(JSON.stringify(items)).not.toContain("\\u0000");
  });
});

describe("notification projection", () => {
  it("projects a complete thread/started notification as a bounded read-only upsert snapshot", () => {
    const projected = projectAppServerNotification({
      method: "thread/started",
      params: {
        thread: {
          ...rawThread,
          model: `${"m".repeat(300)}\u0000secret`,
          name: `${"标题".repeat(80)}\n不得进入第二行`,
          reasoningEffort: `${"e".repeat(180)}\u0000secret`,
          turns: [],
        },
      },
    });

    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      threadId: "thread-1",
      type: "thread.snapshot",
      payload: {
        cwdLabel: "sample-project",
        id: "thread-1",
        mode: "desktop-snapshot",
        state: "idle",
        updatedAt: "2024-07-14T23:35:00.000Z",
      },
    });
    const payload = projected[0]?.payload as {
      model?: string;
      reasoningEffort?: string;
      title?: string;
    };
    expect(payload.title?.length).toBeLessThanOrEqual(100);
    expect(payload.model?.length).toBeLessThanOrEqual(256);
    expect(payload.reasoningEffort?.length).toBeLessThanOrEqual(128);
    expect(JSON.stringify(projected)).not.toContain("secret");
    expect(JSON.stringify(projected)).not.toContain("不得进入第二行");
  });

  it("defers an incomplete or oversized thread/started shell to safe service hydration", () => {
    expect(
      projectAppServerNotification({
        method: "thread/started",
        params: { thread: { id: "thread-shell" } },
      }),
    ).toEqual([]);
    expect(
      projectAppServerNotification({
        method: "thread/started",
        params: {
          thread: {
            ...rawThread,
            id: "x".repeat(513),
            turns: [],
          },
        },
      }),
    ).toEqual([]);
  });

  it("projects the real context-compaction lifecycle without exposing protocol details", () => {
    const item = {
      id: "compaction-1",
      type: "contextCompaction",
    };

    expect(
      projectAppServerNotification({
        method: "item/started",
        params: { item, threadId: "thread-1", turnId: "turn-compact" },
      }),
    ).toEqual([
      {
        payload: {
          item: [
            {
              id: "compaction-1",
              kind: "tool",
              operation: "context-compaction",
              status: "running",
              title: "压缩对话上下文",
            },
          ],
          lifecycle: "started",
        },
        threadId: "thread-1",
        turnId: "turn-compact",
        type: "thread.item",
      },
    ]);
    expect(
      projectAppServerNotification({
        method: "item/completed",
        params: { item, threadId: "thread-1", turnId: "turn-compact" },
      }),
    ).toEqual([
      {
        payload: {
          item: [
            {
              id: "compaction-1",
              kind: "tool",
              operation: "context-compaction",
              status: "complete",
              title: "压缩对话上下文",
            },
          ],
          lifecycle: "completed",
        },
        threadId: "thread-1",
        turnId: "turn-compact",
        type: "thread.item",
      },
    ]);
  });

  it("projects authoritative plan progress for a clickable step indicator", () => {
    expect(
      projectAppServerNotification({
        method: "turn/plan/updated",
        params: {
          explanation: "按真实步骤推进",
          plan: [
            { status: "completed", step: "读取现状" },
            { status: "inProgress", step: "修复界面" },
            { status: "pending", step: "真实验收" },
          ],
          threadId: "thread-1",
          turnId: "turn-1",
        },
      }),
    ).toEqual([
      {
        payload: {
          item: [
            {
              explanation: "按真实步骤推进",
              id: "plan-progress-turn-1",
              kind: "plan-progress",
              steps: [
                { status: "completed", text: "读取现状" },
                { status: "inProgress", text: "修复界面" },
                { status: "pending", text: "真实验收" },
              ],
            },
          ],
          lifecycle: "updated",
        },
        threadId: "thread-1",
        turnId: "turn-1",
        type: "thread.item",
      },
    ]);
  });

  it("drops raw reasoning content but preserves reasoning summaries", () => {
    expect(
      projectAppServerNotification({
        method: "item/reasoning/textDelta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "reasoning-1",
          delta: "hidden",
        },
      }),
    ).toEqual([]);

    expect(
      projectAppServerNotification({
        method: "item/reasoning/summaryTextDelta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "reasoning-1",
          delta: "可见摘要",
          summaryIndex: 0,
        },
      }),
    ).toEqual([
      {
        type: "thread.item",
        threadId: "thread-1",
        turnId: "turn-1",
        payload: {
          delta: "可见摘要",
          itemId: "reasoning-1",
          kind: "reasoning-summary-delta",
          summaryIndex: 0,
        },
      },
    ]);
  });

  it("projects protocol-specific diagnostic fields without leaking config paths", () => {
    expect(
      projectAppServerNotification({
        method: "error",
        params: {
          error: {
            additionalDetails: "请稍后重试",
            message: "模型暂时不可用",
          },
          threadId: "thread-1",
          turnId: "turn-1",
          willRetry: true,
        },
      }),
    ).toEqual([
      {
        payload: {
          category: "error",
          message: "模型暂时不可用\n\n请稍后重试",
        },
        threadId: "thread-1",
        turnId: "turn-1",
        type: "diagnostic",
      },
    ]);

    const warning = projectAppServerNotification({
      method: "configWarning",
      params: {
        details: "请更新配置项",
        path: "C:\\Users\\fixture\\secret\\config.toml",
        summary: "配置即将过期",
      },
    });
    expect(warning).toEqual([
      {
        payload: {
          category: "configWarning",
          message: "配置即将过期\n\n请更新配置项",
        },
        type: "diagnostic",
      },
    ]);
    expect(JSON.stringify(warning)).not.toContain("config.toml");
  });

  it("projects model reroutes as a settings refresh and a safe diagnostic", () => {
    expect(
      projectAppServerNotification({
        method: "model/rerouted",
        params: {
          fromModel: "model-a",
          reason: "容量调整\u0000",
          threadId: "thread-1",
          toModel: "model-b",
          turnId: "turn-1",
        },
      }),
    ).toEqual([
      {
        payload: { model: "model-b", reason: "model-rerouted" },
        threadId: "thread-1",
        turnId: "turn-1",
        type: "thread.updated",
      },
      {
        payload: {
          category: "model/rerouted",
          message: "Codex 已将模型从 model-a 切换为 model-b：容量调整",
        },
        threadId: "thread-1",
        turnId: "turn-1",
        type: "diagnostic",
      },
    ]);
  });
});
