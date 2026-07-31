import type { RemoteEvent, ThreadDetail } from "@codex-local-remote/contracts";
import { describe, expect, it } from "vitest";
import {
  compactThreadNavigationState,
  findCreationPromptLiveAliasItemId,
  mergeAuthoritativeThreadControl,
  mergeThreadRefresh,
  sortThreadsForDisplay,
  reconcileLiveCreationPromptAlias,
  readThreadNavigationCache,
  threadInitialPromptFromNavigationState,
  threadSeedFromNavigationState,
  writeThreadNavigationCache,
} from "./thread-navigation";

function threadDetail(
  overrides: Partial<ThreadDetail> & Pick<ThreadDetail, "id" | "updatedAt">,
): ThreadDetail {
  return {
    title: "新任务",
    mode: "managed",
    state: "running",
    items: [{ id: "user-1", kind: "user-message", text: "开始" }],
    activeTurnId: "turn-1",
    availableActions: {
      changeModelNextTurn: true,
      interrupt: true,
      reply: false,
      steer: true,
    },
    ...overrides,
  };
}

describe("新任务详情首屏", () => {
  it("发送前权威回读即使时间戳相同也覆盖陈旧的空闲控制状态", () => {
    const idleWithFormerTurn = threadDetail({
      id: "thread-control-race",
      state: "complete",
      updatedAt: "2026-07-25T12:00:00.000Z",
      model: "old-model",
      reasoningEffort: "low",
      serviceTier: "standard",
      permissionProfileId: "confirm-risk",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      collaborationMode: "plan",
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    });
    const { activeTurnId: _formerTurnId, ...idle } = idleWithFormerTurn;
    const active = threadDetail({
      id: idle.id,
      updatedAt: idle.updatedAt,
      activeTurnId: "turn-authoritative",
      model: "new-model",
      reasoningEffort: "high",
      serviceTier: "fast",
      permissionProfileId: "workspace-write",
      approvalPolicy: "never",
      approvalsReviewer: "guardian_subagent",
      collaborationMode: "default",
    });

    expect(mergeAuthoritativeThreadControl(idle, active)).toMatchObject({
      activeTurnId: "turn-authoritative",
      availableActions: { reply: false, steer: true },
      model: "new-model",
      reasoningEffort: "high",
      serviceTier: "fast",
      permissionProfileId: "workspace-write",
      approvalPolicy: "never",
      approvalsReviewer: "guardian_subagent",
      collaborationMode: "default",
      state: "running",
    });
  });

  it("发送确认的轻量控制壳不会清掉本地即时消息和已有正文", () => {
    const current = threadDetail({
      id: "thread-send-shell",
      updatedAt: "2026-07-25T12:00:00.000Z",
      items: [
        { id: "assistant-before", kind: "assistant-message", text: "上一轮回答" },
        { id: "pending-send-1", kind: "user-message", text: "马上继续" },
      ],
    });
    const shell = threadDetail({
      id: current.id,
      updatedAt: "2026-07-25T12:00:01.000Z",
      activeTurnId: "turn-next",
      items: [],
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      serviceTier: "standard",
    });

    const merged = mergeAuthoritativeThreadControl(current, shell);

    expect(merged.items).toEqual(current.items);
    expect(merged).toMatchObject({
      activeTurnId: "turn-next",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      serviceTier: "standard",
      state: "running",
    });
  });

  it("权威终态控制壳覆盖陈旧 activeTurnId，同时保留已显示的对话正文", () => {
    const current = threadDetail({
      id: "thread-stopped-control",
      updatedAt: "2026-07-29T12:00:02.000Z",
      items: [
        { id: "user-current", kind: "user-message", text: "执行长任务" },
        { id: "assistant-partial", kind: "assistant-message", text: "已完成一部分" },
      ],
    });
    const activeShell = threadDetail({
      id: current.id,
      updatedAt: "2026-07-29T12:00:01.000Z",
      items: [],
      state: "idle",
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    });
    const { activeTurnId: _stoppedTurnId, ...terminalShell } = activeShell;

    const merged = mergeAuthoritativeThreadControl(current, terminalShell);

    expect(merged.items).toEqual(current.items);
    expect(merged.activeTurnId).toBeUndefined();
    expect(merged).toMatchObject({
      availableActions: {
        interrupt: false,
        reply: true,
        steer: false,
      },
      state: "idle",
    });
  });

  it("置顶对话按 Desktop 顺序位于最近对话之前", () => {
    const threads = [
      threadDetail({
        id: "recent-new",
        updatedAt: "2026-07-25T12:00:03.000Z",
      }),
      threadDetail({
        id: "pinned-second",
        pinnedRank: 1,
        updatedAt: "2026-07-25T12:00:02.000Z",
      }),
      threadDetail({
        id: "pinned-first",
        pinnedRank: 0,
        updatedAt: "2026-07-25T12:00:01.000Z",
      }),
      threadDetail({
        id: "recent-old",
        updatedAt: "2026-07-25T12:00:00.000Z",
      }),
    ];

    expect(sortThreadsForDisplay(threads).map((thread) => thread.id)).toEqual([
      "pinned-first",
      "pinned-second",
      "recent-new",
      "recent-old",
    ]);
  });

  it("只接受与当前路由匹配的完整创建结果", () => {
    const seed = threadDetail({
      id: "thread-created",
      updatedAt: "2026-07-25T12:00:00.000Z",
    });

    expect(threadSeedFromNavigationState({ threadSeed: seed }, seed.id)).toBe(seed);
    expect(
      threadInitialPromptFromNavigationState(
        { initialPrompt: String.raw`检查 V:\workspace\sample`, threadSeed: seed },
        seed.id,
      ),
    ).toBe(String.raw`检查 V:\workspace\sample`);
    expect(threadSeedFromNavigationState({ threadSeed: seed }, "thread-other")).toBeUndefined();
    expect(threadSeedFromNavigationState({ threadSeed: { id: seed.id } }, seed.id)).toBeUndefined();
    expect(threadSeedFromNavigationState(null, seed.id)).toBeUndefined();
  });

  it("刷新历史只保留轻量运行态，并为新任务保留首轮别名", () => {
    const thread = threadDetail({
      id: "thread-refresh-seed",
      updatedAt: "2026-07-25T12:00:00.000Z",
      items: [
        { id: "initial-user", kind: "user-message", text: "执行真实验收" },
        { id: "assistant-1", kind: "assistant-message", text: "正在执行" },
        {
          id: "command-1",
          kind: "tool",
          status: "running",
          title: "运行命令",
          detail: "很长的命令输出",
        },
      ],
    });

    const compact = compactThreadNavigationState(thread, "执行真实验收");
    expect(compact.threadSeed).toMatchObject({
      id: thread.id,
      activeTurnId: "turn-1",
      state: "running",
      availableActions: thread.availableActions,
    });
    expect(compact.threadSeed.items).toEqual([
      { id: "initial-user", kind: "user-message", text: "执行真实验收" },
    ]);
    expect(compact.initialPrompt).toBe("执行真实验收");

    expect(compactThreadNavigationState(thread).threadSeed.items).toEqual([]);
  });

  it("导航缓存完整保留子智能体活动和计划进度", () => {
    const storageValues = new Map<string, string>();
    const storage = {
      getItem: (key: string) => storageValues.get(key) ?? null,
      removeItem: (key: string) => storageValues.delete(key),
      setItem: (key: string, value: string) => storageValues.set(key, value),
    };
    const detail = threadDetail({
      id: "00000000-0000-0000-0000-000000000042",
      updatedAt: "2026-07-28T10:00:00.000Z",
      items: [
        {
          id: "subagent-history",
          kind: "subagent-activity",
          action: "update",
          agents: [{ threadId: "child-1", label: "M1 thread review" }],
          status: "complete",
          summary: "只读复核已完成",
        },
        {
          id: "plan-history",
          kind: "plan-progress",
          explanation: "收尾",
          steps: [{ text: "复核子智能体记录", status: "completed" }],
        },
      ],
    });

    writeThreadNavigationCache(storage, { threadSeed: detail }, 1_722_160_000_000);

    expect(
      readThreadNavigationCache(storage, detail.id, 1_722_160_000_100)?.threadSeed.items,
    ).toEqual(detail.items);
  });

  it("同一标签刷新可从短期会话缓存立即恢复轻量运行态", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => void values.delete(key),
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    const thread = threadDetail({
      id: "thread-session-refresh",
      updatedAt: "2026-07-25T12:00:00.000Z",
      items: [
        { id: "user-1", kind: "user-message", text: "大段历史不应进入刷新缓存" },
        { id: "assistant-1", kind: "assistant-message", text: "已收到" },
      ],
    });
    const state = compactThreadNavigationState(thread);

    writeThreadNavigationCache(storage, state, 1_000);

    expect(readThreadNavigationCache(storage, thread.id, 2_000)).toEqual(state);
    expect(
      readThreadNavigationCache(storage, thread.id, 6 * 60 * 60 * 1000 + 1_001),
    ).toBeUndefined();
  });

  it("静默刷新不能用较旧快照覆盖更近的实时事件", () => {
    const current = threadDetail({
      id: "thread-created",
      updatedAt: "2026-07-25T12:00:02.000Z",
      items: [
        { id: "user-1", kind: "user-message", text: "开始" },
        { id: "assistant-1", kind: "assistant-message", text: "实时增量已到达" },
      ],
    });
    const staleWithActiveTurn = threadDetail({
      id: current.id,
      updatedAt: "2026-07-25T12:00:01.000Z",
      state: "idle",
      items: [{ id: "user-1", kind: "user-message", text: "开始" }],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    });
    const { activeTurnId: _staleTurnId, ...stale } = staleWithActiveTurn;

    expect(mergeThreadRefresh(current, stale)).toEqual(current);
  });

  it("相同时间戳的完整详情会替换只读列表占位并恢复运行控制", () => {
    const current = threadDetail({
      id: "thread-running",
      updatedAt: "2026-07-25T12:00:00.000Z",
      items: [],
      state: "running",
      availableActions: {
        changeModelNextTurn: false,
        interrupt: false,
        reply: false,
        steer: false,
      },
    });
    const { activeTurnId: _placeholderTurnId, ...summaryPlaceholder } = current;
    const incoming = threadDetail({
      id: current.id,
      updatedAt: current.updatedAt,
      activeTurnId: "turn-running",
      items: [{ id: "user-1", kind: "user-message", text: "执行真实任务" }],
    });

    const merged = mergeThreadRefresh(summaryPlaceholder, incoming);

    expect(merged.activeTurnId).toBe("turn-running");
    expect(merged.availableActions).toEqual(incoming.availableActions);
    expect(merged.items).toEqual(incoming.items);
  });

  it("首次持久化刷新只替换创建 seed 的临时首轮用户消息", () => {
    const seed = threadDetail({
      id: "thread-created",
      updatedAt: "2026-07-25T12:00:00.000Z",
      items: [{ id: "seed-user", kind: "user-message", text: "执行真实验收" }],
    });
    const incomingWithActiveTurn = threadDetail({
      id: seed.id,
      updatedAt: "2026-07-25T12:00:01.000Z",
      state: "complete",
      items: [
        { id: "persisted-user", kind: "user-message", text: "执行真实验收" },
        { id: "assistant-1", kind: "assistant-message", text: "已完成" },
      ],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    });
    const { activeTurnId: _incomingTurnId, ...incoming } = incomingWithActiveTurn;

    const merged = mergeThreadRefresh(seed, incoming, {
      creationSeed: seed,
      initialPrompt: "执行真实验收",
    });

    expect(merged.items).toEqual(incoming.items);
    expect(merged.items.some((item) => item.id === "seed-user")).toBe(false);
  });

  it("seed 收口不能吞掉用户后续故意发送的相同文本", () => {
    const seed = threadDetail({
      id: "thread-created",
      updatedAt: "2026-07-25T12:00:00.000Z",
      items: [{ id: "seed-user", kind: "user-message", text: "再检查一次" }],
    });
    const current = threadDetail({
      id: seed.id,
      updatedAt: "2026-07-25T12:00:01.000Z",
      items: [...seed.items, { id: "later-live-user", kind: "user-message", text: "再检查一次" }],
    });
    const incoming = threadDetail({
      id: seed.id,
      updatedAt: "2026-07-25T12:00:02.000Z",
      items: [{ id: "persisted-first-user", kind: "user-message", text: "再检查一次" }],
    });

    const merged = mergeThreadRefresh(current, incoming, {
      creationSeed: seed,
      initialPrompt: "再检查一次",
    });
    const repeatedMessages = merged.items.filter(
      (item) => item.kind === "user-message" && item.text === "再检查一次",
    );

    expect(repeatedMessages.map((item) => item.id)).toEqual([
      "persisted-first-user",
      "later-live-user",
    ]);
    expect(merged.items.some((item) => item.id === "seed-user")).toBe(false);
  });

  it("首轮实时 user-message 只登记一个别名，刷新后不重复且保留后续同文本", () => {
    const prompt = "执行复杂任务";
    const seed = threadDetail({
      id: "thread-created",
      activeTurnId: "turn-initial",
      updatedAt: "2026-07-25T12:00:00.000Z",
      items: [{ id: "seed-user", kind: "user-message", text: prompt }],
    });
    const events = [
      {
        emittedAt: "2026-07-25T12:00:01.000Z",
        payload: {
          item: [{ id: "later-turn-repeat", kind: "user-message", text: prompt }],
          lifecycle: "started",
        },
        schemaVersion: 1,
        seq: 1,
        threadId: seed.id,
        turnId: "turn-later",
        type: "thread.item",
      },
      {
        emittedAt: "2026-07-25T12:00:02.000Z",
        payload: {
          item: [{ id: "live-first-alias", kind: "user-message", text: prompt }],
          lifecycle: "started",
        },
        schemaVersion: 1,
        seq: 2,
        threadId: seed.id,
        turnId: "turn-initial",
        type: "thread.item",
      },
      {
        emittedAt: "2026-07-25T12:00:03.000Z",
        payload: {
          item: [{ id: "same-turn-repeat", kind: "user-message", text: prompt }],
          lifecycle: "started",
        },
        schemaVersion: 1,
        seq: 3,
        threadId: seed.id,
        turnId: "turn-initial",
        type: "thread.item",
      },
    ] satisfies RemoteEvent[];
    const liveAliasItemId = findCreationPromptLiveAliasItemId(events, {
      creationSeed: seed,
      initialPrompt: prompt,
    });
    expect(liveAliasItemId).toBe("live-first-alias");
    if (!liveAliasItemId) throw new Error("没有识别首轮实时提示词别名");

    const current = threadDetail({
      id: seed.id,
      updatedAt: "2026-07-25T12:00:04.000Z",
      items: [
        { id: "persisted-first", kind: "user-message", text: prompt },
        { id: "steer", kind: "user-message", text: "追加要求" },
        { id: "seed-user", kind: "user-message", text: prompt },
        { id: "live-first-alias", kind: "user-message", text: prompt },
        { id: "later-deliberate-repeat", kind: "user-message", text: prompt },
      ],
    });
    const incoming = threadDetail({
      id: seed.id,
      updatedAt: "2026-07-25T12:00:05.000Z",
      items: [
        { id: "persisted-first", kind: "user-message", text: prompt },
        { id: "steer", kind: "user-message", text: "追加要求" },
      ],
    });
    const merged = mergeThreadRefresh(current, incoming, {
      creationSeed: seed,
      initialPrompt: prompt,
      liveAliasItemId,
    });
    expect(merged.items.map((item) => item.id)).toEqual([
      "persisted-first",
      "steer",
      "later-deliberate-repeat",
    ]);

    const liveOnly = reconcileLiveCreationPromptAlias(
      threadDetail({
        id: seed.id,
        updatedAt: "2026-07-25T12:00:03.000Z",
        items: [
          ...seed.items,
          { id: "live-first-alias", kind: "user-message", text: prompt },
          { id: "later-deliberate-repeat", kind: "user-message", text: prompt },
        ],
      }),
      { creationSeed: seed, initialPrompt: prompt, liveAliasItemId },
    );
    expect(liveOnly.items.map((item) => item.id)).toEqual([
      "live-first-alias",
      "later-deliberate-repeat",
    ]);

    const persistedWins = reconcileLiveCreationPromptAlias(
      threadDetail({
        id: seed.id,
        updatedAt: "2026-07-25T12:00:05.000Z",
        items: [
          { id: "persisted-first", kind: "user-message", text: prompt },
          { id: "live-first-alias", kind: "user-message", text: prompt },
          { id: "later-deliberate-repeat", kind: "user-message", text: prompt },
        ],
      }),
      { creationSeed: seed, initialPrompt: prompt, liveAliasItemId },
      "persisted-first",
    );
    expect(persistedWins.items.map((item) => item.id)).toEqual([
      "persisted-first",
      "later-deliberate-repeat",
    ]);
  });

  it("较新刷新保留尚未持久化的实时项目，同时采用新的运行状态", () => {
    const current = threadDetail({
      id: "thread-created",
      updatedAt: "2026-07-25T12:00:01.000Z",
      items: [
        { id: "user-1", kind: "user-message", text: "开始" },
        { id: "live-only", kind: "reasoning-summary", text: "正在检查" },
      ],
    });
    const refreshedWithActiveTurn = threadDetail({
      id: current.id,
      updatedAt: "2026-07-25T12:00:03.000Z",
      state: "complete",
      items: [
        { id: "user-1", kind: "user-message", text: "开始" },
        { id: "assistant-1", kind: "assistant-message", text: "完成" },
      ],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    });
    const { activeTurnId: _refreshedTurnId, ...refreshed } = refreshedWithActiveTurn;

    const merged = mergeThreadRefresh(current, refreshed);
    expect(merged.state).toBe("complete");
    expect(merged.updatedAt).toBe(refreshed.updatedAt);
    expect(merged.items.map((item) => item.id)).toEqual(["user-1", "live-only", "assistant-1"]);
  });

  it("历史刷新不会把较早的实时思考追加到较晚轮次之后", () => {
    const current = threadDetail({
      id: "thread-stable-chronology",
      state: "running",
      updatedAt: "2026-07-28T10:06:10.000Z",
      items: [
        {
          createdAt: "2026-07-28T10:00:00.000Z",
          id: "old-user",
          kind: "user-message",
          text: "先检查",
          turnId: "turn-old",
          turnStartedAt: "2026-07-28T10:00:00.000Z",
        },
        {
          createdAt: "2026-07-28T10:06:00.000Z",
          id: "new-user",
          kind: "user-message",
          text: "六点以后继续",
          turnId: "turn-new",
          turnStartedAt: "2026-07-28T10:06:00.000Z",
        },
        {
          createdAt: "2026-07-28T10:06:05.000Z",
          id: "new-answer",
          kind: "assistant-message",
          phase: "commentary",
          text: "正在处理新要求",
          turnId: "turn-new",
          turnStartedAt: "2026-07-28T10:06:00.000Z",
        },
        {
          createdAt: "2026-07-28T10:01:00.000Z",
          id: "old-live-reasoning",
          kind: "reasoning-summary",
          text: "上一轮的思考",
          turnId: "turn-old",
          turnStartedAt: "2026-07-28T10:00:00.000Z",
        },
      ],
    });
    const incoming = threadDetail({
      id: current.id,
      state: "running",
      updatedAt: "2026-07-28T10:06:11.000Z",
      items: [
        {
          id: "old-user",
          kind: "user-message",
          text: "先检查",
          turnId: "turn-old",
          turnStartedAt: "2026-07-28T10:00:00.000Z",
        },
        {
          id: "new-user",
          kind: "user-message",
          text: "六点以后继续",
          turnId: "turn-new",
          turnStartedAt: "2026-07-28T10:06:00.000Z",
        },
        {
          id: "new-answer",
          kind: "assistant-message",
          phase: "commentary",
          text: "正在处理新要求",
          turnId: "turn-new",
          turnStartedAt: "2026-07-28T10:06:00.000Z",
        },
      ],
    });

    expect(mergeThreadRefresh(current, incoming).items.map((item) => item.id)).toEqual([
      "old-user",
      "old-live-reasoning",
      "new-user",
      "new-answer",
    ]);
  });

  it("相同时间戳的终态快照可用严格项目增长收口新任务 seed", () => {
    const current = threadDetail({
      id: "thread-created",
      updatedAt: "2026-07-25T12:00:00.000Z",
      items: [{ id: "user-1", kind: "user-message", text: "开始" }],
    });
    const incomingWithActiveTurn = threadDetail({
      id: current.id,
      updatedAt: current.updatedAt,
      state: "complete",
      items: [
        { id: "user-1", kind: "user-message", text: "开始" },
        { id: "assistant-1", kind: "assistant-message", text: "done" },
      ],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    });
    const { activeTurnId: _incomingTurnId, ...incoming } = incomingWithActiveTurn;

    const merged = mergeThreadRefresh(current, incoming);
    expect(merged.state).toBe("complete");
    expect(merged.activeTurnId).toBeUndefined();
    expect(merged.availableActions.reply).toBe(true);
    expect(merged.items).toContainEqual(
      expect.objectContaining({ id: "assistant-1", text: "done" }),
    );
  });

  it("低精度权威快照也能把同一工具项目从 running 单调推进到 complete", () => {
    const current = threadDetail({
      id: "thread-created",
      updatedAt: "2026-07-25T12:00:00.900Z",
      activeTurnId: "turn-compact",
      items: [
        {
          id: "compaction-current",
          kind: "tool",
          operation: "context-compaction",
          status: "running",
          title: "压缩对话上下文",
        },
      ],
    });
    const incomingWithActiveTurn = threadDetail({
      id: current.id,
      updatedAt: "2026-07-25T12:00:00.000Z",
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
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    });
    const { activeTurnId: _incomingTurnId, ...incoming } = incomingWithActiveTurn;

    const merged = mergeThreadRefresh(current, incoming);
    expect(merged.state).toBe("complete");
    expect(merged.activeTurnId).toBeUndefined();
    expect(merged.items).toContainEqual(
      expect.objectContaining({ id: "compaction-current", status: "complete" }),
    );
    expect(merged.availableActions.reply).toBe(true);
  });

  it("终态刷新会按临近时间合并上下文压缩的实时别名而保留历史压缩", () => {
    const current = threadDetail({
      id: "thread-compaction-alias",
      state: "complete",
      updatedAt: "2026-07-25T12:00:10.000Z",
      items: [
        {
          createdAt: "2026-07-25T10:00:00.000Z",
          id: "persisted-old-compaction",
          kind: "tool",
          operation: "context-compaction",
          status: "complete",
          title: "压缩对话上下文",
        },
        {
          id: "live-current-compaction",
          kind: "tool",
          operation: "context-compaction",
          status: "complete",
          title: "压缩对话上下文",
        },
      ],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    });
    const incomingWithActiveTurn = threadDetail({
      id: current.id,
      state: "complete",
      updatedAt: "2026-07-25T12:00:09.000Z",
      items: [
        {
          createdAt: "2026-07-25T10:00:00.000Z",
          id: "persisted-old-compaction",
          kind: "tool",
          operation: "context-compaction",
          status: "complete",
          title: "压缩对话上下文",
        },
        {
          createdAt: "2026-07-25T12:00:05.000Z",
          id: "persisted-current-compaction",
          kind: "tool",
          operation: "context-compaction",
          status: "complete",
          title: "压缩对话上下文",
        },
      ],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    });
    const { activeTurnId: _incomingTurnId, ...incoming } = incomingWithActiveTurn;

    expect(mergeThreadRefresh(current, incoming).items.map((item) => item.id)).toEqual([
      "persisted-old-compaction",
      "persisted-current-compaction",
    ]);
  });

  it("不会把时间相隔较远的两次上下文压缩错误合并", () => {
    const current = threadDetail({
      id: "thread-distinct-compactions",
      state: "complete",
      updatedAt: "2026-07-25T12:00:10.000Z",
      items: [
        {
          createdAt: "2026-07-25T11:00:00.000Z",
          id: "live-earlier-compaction",
          kind: "tool",
          operation: "context-compaction",
          status: "complete",
          title: "压缩对话上下文",
        },
      ],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    });
    const incomingWithActiveTurn = threadDetail({
      id: current.id,
      state: "complete",
      updatedAt: "2026-07-25T12:00:09.000Z",
      items: [
        {
          createdAt: "2026-07-25T12:00:05.000Z",
          id: "persisted-current-compaction",
          kind: "tool",
          operation: "context-compaction",
          status: "complete",
          title: "压缩对话上下文",
        },
      ],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    });
    const { activeTurnId: _incomingTurnId, ...incoming } = incomingWithActiveTurn;

    expect(mergeThreadRefresh(current, incoming).items.map((item) => item.id)).toEqual([
      "live-earlier-compaction",
      "persisted-current-compaction",
    ]);
  });

  it("较新的 running 快照不能把同一工具项目的终态降级", () => {
    const currentWithActiveTurn = threadDetail({
      id: "thread-created",
      updatedAt: "2026-07-25T12:00:01.000Z",
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
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    });
    const { activeTurnId: _currentTurnId, ...current } = currentWithActiveTurn;
    const incoming = threadDetail({
      id: current.id,
      updatedAt: "2026-07-25T12:00:02.000Z",
      items: [
        {
          id: "compaction-current",
          kind: "tool",
          operation: "context-compaction",
          status: "running",
          title: "压缩对话上下文",
        },
      ],
    });

    const merged = mergeThreadRefresh(current, incoming);
    expect(merged.items).toContainEqual(
      expect.objectContaining({ id: "compaction-current", status: "complete" }),
    );
  });

  it("终态权威刷新会移除实时流留下的同文别名而保留仅实时可见的工具", () => {
    const current = threadDetail({
      id: "thread-aliases",
      state: "complete",
      updatedAt: "2026-07-25T12:00:01.000Z",
      items: [
        { id: "persisted-user", kind: "user-message", text: "开始" },
        { id: "live-user-alias", kind: "user-message", text: "开始" },
        { id: "persisted-assistant", kind: "assistant-message", text: "完成" },
        { id: "live-assistant-alias", kind: "assistant-message", text: "完成" },
        {
          id: "live-command",
          kind: "tool",
          status: "complete",
          title: "运行命令",
          summary: "node --test",
        },
      ],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    });
    const incomingWithActiveTurn = threadDetail({
      id: current.id,
      state: "complete",
      updatedAt: "2026-07-25T12:00:00.000Z",
      items: [
        { id: "persisted-user", kind: "user-message", text: "开始" },
        { id: "persisted-assistant", kind: "assistant-message", text: "完成" },
      ],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    });
    const { activeTurnId: _incomingTurnId, ...incoming } = incomingWithActiveTurn;

    const merged = mergeThreadRefresh(current, incoming);
    expect(merged.items.map((item) => item.id)).toEqual([
      "persisted-user",
      "persisted-assistant",
      "live-command",
    ]);
  });

  it("进行中的权威刷新会移除当前轮助手同文别名但保留实时工具", () => {
    const current = threadDetail({
      id: "thread-active-assistant-alias",
      state: "running",
      updatedAt: "2026-07-25T12:00:02.000Z",
      items: [
        { id: "persisted-user", kind: "user-message", text: "开始长任务" },
        { id: "persisted-assistant", kind: "assistant-message", text: "正在执行" },
        { id: "live-assistant-alias", kind: "assistant-message", text: "正在执行" },
        {
          id: "live-command",
          kind: "tool",
          status: "running",
          title: "运行命令",
        },
      ],
    });
    const incoming = threadDetail({
      id: current.id,
      state: "running",
      updatedAt: "2026-07-25T12:00:03.000Z",
      items: [
        { id: "persisted-user", kind: "user-message", text: "开始长任务" },
        { id: "persisted-assistant", kind: "assistant-message", text: "正在执行" },
      ],
    });

    expect(mergeThreadRefresh(current, incoming).items.map((item) => item.id)).toEqual([
      "persisted-user",
      "persisted-assistant",
      "live-command",
    ]);
  });

  it("不会把上一轮相同文字误认为当前轮助手别名", () => {
    const current = threadDetail({
      id: "thread-repeated-assistant-text",
      state: "running",
      updatedAt: "2026-07-25T12:00:02.000Z",
      items: [
        { id: "old-user", kind: "user-message", text: "第一轮" },
        { id: "old-assistant", kind: "assistant-message", text: "收到" },
        { id: "new-user", kind: "user-message", text: "第二轮" },
        { id: "new-live-assistant", kind: "assistant-message", text: "收到" },
      ],
    });
    const incoming = threadDetail({
      id: current.id,
      state: "running",
      updatedAt: "2026-07-25T12:00:03.000Z",
      items: [
        { id: "old-user", kind: "user-message", text: "第一轮" },
        { id: "old-assistant", kind: "assistant-message", text: "收到" },
        { id: "new-user", kind: "user-message", text: "第二轮" },
      ],
    });

    expect(mergeThreadRefresh(current, incoming).items.map((item) => item.id)).toContain(
      "new-live-assistant",
    );
  });

  it("中断终态以当前轮用户消息确认并移除未持久化的运行工具", () => {
    const current = threadDetail({
      id: "thread-interrupted",
      state: "running",
      updatedAt: "2026-07-25T12:00:05.000Z",
      items: [
        { id: "current-user", kind: "user-message", text: "运行长命令" },
        { id: "persisted-assistant", kind: "assistant-message", text: "开始执行" },
        { id: "live-assistant", kind: "assistant-message", text: "开始执行" },
        {
          id: "live-command",
          kind: "tool",
          status: "running",
          title: "运行命令",
        },
      ],
    });
    const incomingWithActiveTurn = threadDetail({
      id: current.id,
      state: "complete",
      updatedAt: "2026-07-25T12:00:01.000Z",
      items: [
        { id: "current-user", kind: "user-message", text: "运行长命令" },
        { id: "persisted-assistant", kind: "assistant-message", text: "开始执行" },
      ],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    });
    const { activeTurnId: _incomingTurnId, ...incoming } = incomingWithActiveTurn;

    const merged = mergeThreadRefresh(current, incoming);
    expect(merged.state).toBe("complete");
    expect(merged.items.map((item) => item.id)).toEqual(["current-user", "persisted-assistant"]);
  });

  it("进行中的当前轮不会因旧终态刷新丢掉同文新消息", () => {
    const current = threadDetail({
      id: "thread-active-alias",
      state: "running",
      updatedAt: "2026-07-25T12:00:03.000Z",
      items: [
        { id: "persisted-user", kind: "user-message", text: "重复文本" },
        { id: "new-live-user", kind: "user-message", text: "重复文本" },
      ],
    });
    const incoming = threadDetail({
      id: current.id,
      state: "complete",
      updatedAt: "2026-07-25T12:00:04.000Z",
      items: [{ id: "persisted-user", kind: "user-message", text: "重复文本" }],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    });

    expect(mergeThreadRefresh(current, incoming).items.map((item) => item.id)).toEqual([
      "persisted-user",
      "new-live-user",
    ]);
  });

  it("未覆盖当前最新用户消息的终态刷新不会清除活跃控制状态", () => {
    const current = threadDetail({
      id: "thread-stale-terminal-control",
      state: "running",
      updatedAt: "2026-07-25T12:00:03.000Z",
      activeTurnId: "turn-current",
      items: [
        { id: "previous-user", kind: "user-message", text: "上一轮", turnId: "turn-previous" },
        { id: "current-user", kind: "user-message", text: "当前轮", turnId: "turn-current" },
      ],
    });
    const incomingWithFormerTurn = threadDetail({
      id: current.id,
      state: "complete",
      updatedAt: "2026-07-25T12:00:04.000Z",
      items: [
        { id: "previous-user", kind: "user-message", text: "上一轮", turnId: "turn-previous" },
      ],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    });
    const { activeTurnId: _formerTurnId, ...incoming } = incomingWithFormerTurn;

    expect(mergeThreadRefresh(current, incoming)).toMatchObject({
      state: "running",
      activeTurnId: "turn-current",
      availableActions: {
        interrupt: true,
        reply: false,
        steer: true,
      },
      items: [{ id: "previous-user" }, { id: "current-user" }],
    });
  });

  it("刷新持久化引导消息后移除同文乐观回显，但保留普通重复消息", () => {
    const current = threadDetail({
      id: "thread-steer-alias",
      state: "running",
      updatedAt: "2026-07-25T12:00:03.000Z",
      items: [
        { id: "earlier-repeat", kind: "user-message", text: "继续检查" },
        { id: "pending-steer-42", kind: "user-message", text: "继续检查" },
      ],
    });
    const incoming = threadDetail({
      id: current.id,
      state: "running",
      updatedAt: "2026-07-25T12:00:04.000Z",
      items: [
        { id: "earlier-repeat", kind: "user-message", text: "继续检查" },
        { id: "persisted-steer", kind: "user-message", text: "继续检查" },
      ],
    });

    expect(mergeThreadRefresh(current, incoming).items.map((item) => item.id)).toEqual([
      "earlier-repeat",
      "persisted-steer",
    ]);
  });

  it("同文引导只按新增持久化消息一对一移除对应乐观回显", () => {
    const current = threadDetail({
      id: "thread-repeated-steer-aliases",
      state: "running",
      updatedAt: "2026-07-25T12:00:03.000Z",
      activeTurnId: "turn-current",
      items: [
        {
          id: "earlier-repeat",
          kind: "user-message",
          text: "继续检查",
          turnId: "turn-previous",
        },
        {
          id: "pending-steer-first",
          kind: "user-message",
          text: "继续检查",
          turnId: "turn-current",
        },
        {
          id: "pending-steer-second",
          kind: "user-message",
          text: "继续检查",
          turnId: "turn-current",
        },
      ],
    });
    const incoming = threadDetail({
      id: current.id,
      state: "running",
      updatedAt: "2026-07-25T12:00:04.000Z",
      activeTurnId: "turn-current",
      items: [
        {
          id: "earlier-repeat",
          kind: "user-message",
          text: "继续检查",
          turnId: "turn-previous",
        },
        {
          id: "persisted-first",
          kind: "user-message",
          text: "继续检查",
          turnId: "turn-current",
        },
      ],
    });

    expect(mergeThreadRefresh(current, incoming).items.map((item) => item.id)).toEqual([
      "earlier-repeat",
      "persisted-first",
      "pending-steer-second",
    ]);
  });

  it("刷新合并不会让稀疏实时消息擦除已投影的附件", () => {
    const current = threadDetail({
      id: "thread-attachment-merge",
      updatedAt: "2026-07-25T12:00:03.000Z",
      items: [
        {
          id: "user-upload",
          kind: "user-message",
          text: "请查看附件",
          attachments: [
            {
              kind: "image",
              name: "screen.png",
              path: "E:\\PublicFixtures\\BrowserUploads\\upload-id\\screen.png",
            },
          ],
        },
      ],
    });
    const incoming = threadDetail({
      id: current.id,
      updatedAt: "2026-07-25T12:00:04.000Z",
      items: [{ id: "user-upload", kind: "user-message", text: "请查看附件" }],
    });

    expect(mergeThreadRefresh(current, incoming).items[0]).toMatchObject({
      id: "user-upload",
      kind: "user-message",
      attachments: [
        {
          kind: "image",
          name: "screen.png",
          path: "E:\\PublicFixtures\\BrowserUploads\\upload-id\\screen.png",
        },
      ],
    });
  });
});
