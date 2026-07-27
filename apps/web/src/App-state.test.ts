import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as AppStateModule from "./App";

type AppStateHelpers = typeof AppStateModule;

let helpers: AppStateHelpers;

beforeAll(async () => {
  vi.stubGlobal("document", { baseURI: "http://localhost/" });
  vi.stubGlobal("window", {
    localStorage: {
      getItem: () => null,
    },
    location: { hostname: "localhost", search: "" },
  });
  helpers = await import("./App");
});

describe("文件预览请求状态", () => {
  it("从文本切到图片或二进制时立即原子清空旧派生状态", () => {
    const textKey = helpers.filePreviewRequestKey("project-a", "notes/readme.md");
    const imageKey = helpers.filePreviewRequestKey("project-a", "assets/logo.png");
    const binaryKey = helpers.filePreviewRequestKey("project-b", "dist/app.bin");
    const textReady = {
      generation: 1,
      requestKey: textKey,
      state: "ready" as const,
      text: "旧文本",
      url: "",
      contentType: "text/markdown",
      error: "",
    };

    expect(helpers.visibleFilePreviewState(textReady, imageKey, 2)).toEqual({
      generation: 2,
      requestKey: imageKey,
      state: "loading",
      text: "",
      url: "",
      contentType: "",
      error: "",
    });
    expect(helpers.visibleFilePreviewState(textReady, binaryKey, 3)).toEqual({
      generation: 3,
      requestKey: binaryKey,
      state: "loading",
      text: "",
      url: "",
      contentType: "",
      error: "",
    });
    expect(
      helpers.visibleFilePreviewState(
        {
          generation: 2,
          requestKey: imageKey,
          state: "ready",
          text: "",
          url: "blob:current-image",
          contentType: "image/png",
          error: "",
        },
        imageKey,
        2,
      ),
    ).toMatchObject({ state: "ready", text: "", url: "blob:current-image" });
    expect(
      helpers.visibleFilePreviewState(
        {
          generation: 3,
          requestKey: binaryKey,
          state: "ready",
          text: "",
          url: "",
          contentType: "application/octet-stream",
          error: "",
        },
        binaryKey,
        3,
      ),
    ).toMatchObject({ state: "ready", text: "", url: "" });
  });

  it("只接受当前 generation 的晚到结果", () => {
    const textRequest = {
      generation: 4,
      requestKey: helpers.filePreviewRequestKey("project-a", "slow.txt"),
    };
    const imageRequest = {
      generation: 5,
      requestKey: helpers.filePreviewRequestKey("project-a", "current.png"),
    };

    expect(helpers.isCurrentFilePreviewRequest(imageRequest, textRequest)).toBe(false);
    expect(helpers.isCurrentFilePreviewRequest(imageRequest, imageRequest)).toBe(true);
  });
});

describe("当前详情实时投影门禁", () => {
  it("只有对话详情页订阅该任务的重型实时明细", () => {
    expect(helpers.threadIdFromConversationPath("/threads/thread-1")).toBe("thread-1");
    expect(helpers.threadIdFromConversationPath("/threads/a%2Fb")).toBe("a/b");
    expect(helpers.threadIdFromConversationPath("/threads")).toBeUndefined();
    expect(helpers.threadIdFromConversationPath("/")).toBeUndefined();
  });

  it("遇到 reset 只消费到 reset，保留新代际低序号事件等待详情快照", () => {
    const pending = [
      {
        deliveryId: 10,
        replayed: false,
        event: { type: "thread.item" },
      },
      {
        deliveryId: 11,
        replayed: false,
        event: { type: "connection.reset" },
      },
      {
        deliveryId: 12,
        replayed: false,
        event: { type: "thread.item" },
      },
    ];

    expect(helpers.partitionLiveDeliveriesAtReset(pending)).toEqual({
      beforeReset: [pending[0]],
      reset: pending[1],
      afterReset: [pending[2]],
    });
  });

  it("把完整详情载入前已保留的 live delivery 视为 replay，之后的新事件仍为 live", () => {
    expect(helpers.isReplayDelivery({ deliveryId: 20, replayed: false }, 20)).toBe(true);
    expect(helpers.isReplayDelivery({ deliveryId: 21, replayed: false }, 20)).toBe(false);
    expect(helpers.isReplayDelivery({ deliveryId: 22, replayed: true }, 20)).toBe(true);
  });
});

describe("Desktop 运行时健康门禁", () => {
  it("SSE 仍连通但 app-server 已降级时不再显示电脑在线", () => {
    expect(helpers.hostStatus(true, { appServer: "degraded" })).toEqual({
      label: "兼容性待确认",
      ready: false,
      tone: "warning",
    });
    expect(helpers.appServerReady({ appServer: "degraded" })).toBe(false);
  });

  it("只有实时连接与 app-server 能力同时正常才允许新建任务", () => {
    expect(helpers.hostStatus(true, { appServer: "available" })).toEqual({
      label: "电脑在线",
      ready: true,
      tone: "success",
    });
    expect(helpers.hostStatus(false, { appServer: "available" })).toEqual({
      label: "连接中断",
      ready: false,
      tone: "danger",
    });
  });

  it("对话控制必须同时满足浏览器在线、Desktop 运行时可用和非历史快照", () => {
    expect(helpers.conversationControlState(true, { appServer: "available" }, false)).toEqual({
      available: true,
      reason: "",
    });
    expect(helpers.conversationControlState(false, { appServer: "available" }, false)).toEqual({
      available: false,
      reason: "与电脑的实时连接已中断",
    });
    expect(helpers.conversationControlState(true, { appServer: "degraded" }, false)).toEqual({
      available: false,
      reason: "Codex 运行时兼容性待确认",
    });
    expect(helpers.conversationControlState(true, { appServer: "available" }, true)).toEqual({
      available: false,
      reason: "先把这项历史任务接入 Desktop，才能继续操作",
    });
  });

  it("运行中的托管任务始终保留聊天框，即使当前动作暂时不能直接接收输入", () => {
    expect(
      helpers.canShowThreadComposer(
        {
          mode: "managed",
          state: "running",
          availableActions: {
            steer: false,
            interrupt: false,
            reply: false,
            changeModelNextTurn: true,
          },
        },
        true,
      ),
    ).toBe(true);
    expect(
      helpers.canShowThreadComposer(
        {
          mode: "desktop-snapshot",
          state: "idle",
          availableActions: {
            steer: false,
            interrupt: false,
            reply: false,
            changeModelNextTurn: false,
          },
        },
        true,
      ),
    ).toBe(false);
  });

  it("子智能体快照只提供完整记录与返回父对话，不显示无法执行的 Desktop 接入入口", () => {
    expect(helpers.desktopSnapshotPresentation("parent-thread", 15)).toEqual({
      description:
        "这里会完整显示子智能体的进度与结果。子智能体由父任务控制；需要补充要求时，请返回父对话。",
      resumable: false,
      statusLabel: "子智能体",
      title: "子智能体记录",
    });
    expect(helpers.desktopSnapshotPresentation(undefined, 15)).toEqual({
      description:
        "当前显示的是电脑上的历史记录，内容可能延迟约 15 秒。接入后会把同一任务同步到 Desktop、Web 和手机；不需要先在电脑里手动打开。",
      resumable: true,
      statusLabel: "历史记录",
      title: "这是一项历史任务",
    });
  });

  it("直达任务刷新时允许稍后到达的任务摘要先恢复输入框", () => {
    expect(helpers.shouldSeedThreadFromLateSummary(undefined, undefined, "thread-1")).toBe(true);
    expect(helpers.shouldSeedThreadFromLateSummary("thread-1", undefined, "thread-1")).toBe(false);
    expect(helpers.shouldSeedThreadFromLateSummary(undefined, "thread-1", "thread-1")).toBe(false);
    expect(helpers.shouldSeedThreadFromLateSummary(undefined, undefined, undefined)).toBe(false);
  });

  it("完整对话尚未到达时始终显示加载状态，摘要工具事件不能掩盖它", () => {
    expect(helpers.shouldShowConversationLoading(false, 0)).toBe(true);
    expect(helpers.shouldShowConversationLoading(false, 1)).toBe(true);
    expect(helpers.shouldShowConversationLoading(true, 0)).toBe(false);
  });
});

describe("任务初始滚动位置", () => {
  it("首次进入任务默认定位到当前对话最下方", () => {
    expect(helpers.initialConversationScrollTop(2_400, 915)).toBe(1_485);
    expect(helpers.initialConversationScrollTop(600, 915)).toBe(0);
  });

  it("向上插入旧记录时按新增高度保持当前阅读锚点", () => {
    expect(helpers.conversationHistoryAnchorTop(240, 2_400, 3_100)).toBe(940);
    expect(helpers.conversationHistoryAnchorTop(0, 2_400, 3_100)).toBe(700);
    expect(helpers.conversationHistoryAnchorTop(240, 3_100, 2_400)).toBe(240);
  });

  it("只用底部距离判断是否应继续自动锚定，不再用它展开输入区", () => {
    expect(helpers.conversationAwayFromBottom(2_400, 915, 1_100)).toBe(true);
    expect(helpers.conversationAwayFromBottom(2_400, 915, 1_470)).toBe(false);
    expect(helpers.conversationAwayFromBottom(600, 915, 0)).toBe(false);
  });

  it("只有用户明确向上滚动才收起，布局高度变化不会让输入区反复闪烁", () => {
    expect(helpers.conversationAwayAfterScroll(false, 1_485, 2_700, 915, 1_485)).toBe(false);
    expect(helpers.conversationAwayAfterScroll(false, 1_485, 2_400, 915, 1_100)).toBe(true);
    expect(helpers.conversationAwayAfterScroll(true, 1_100, 2_050, 915, 1_100)).toBe(true);
    expect(helpers.conversationAwayAfterScroll(true, 1_100, 2_400, 915, 1_485)).toBe(false);
    expect(helpers.conversationScrollWasUserDriven(1_000, 1_799)).toBe(true);
    expect(helpers.conversationScrollWasUserDriven(1_000, 1_801)).toBe(false);
    expect(helpers.conversationScrollWasUserDriven(0, 1_000)).toBe(false);
  });

  it("输入框默认一行，只有明确聚焦才展开，滚动到底也必须收回", () => {
    expect(helpers.composerExpandedAfterIntent("thread-change")).toBe(false);
    expect(helpers.composerExpandedAfterIntent("focus")).toBe(true);
    expect(helpers.composerExpandedAfterIntent("conversation-scroll")).toBe(false);
    expect(helpers.composerExpandedAfterIntent("blur")).toBe(false);
    expect(helpers.composerExpandedAfterIntent("submit")).toBe(false);
  });

  it("把旧页插入现有对话顶部并去重，不改变当前运行控制状态", () => {
    const current = {
      id: "thread-1",
      title: "长对话",
      mode: "managed" as const,
      state: "running" as const,
      updatedAt: "2026-07-27T00:00:00.000Z",
      historyNextCursor: "page-2",
      items: [
        { id: "shared", kind: "user-message" as const, text: "当前页起点" },
        { id: "latest", kind: "assistant-message" as const, text: "最新回答" },
      ],
      activeTurnId: "turn-live",
      availableActions: {
        changeModelNextTurn: true,
        interrupt: true,
        reply: false,
        steer: true,
      },
    };
    const olderPage = {
      ...current,
      historyNextCursor: "page-3",
      items: [{ id: "old", kind: "user-message" as const, text: "更早内容" }, current.items[0]!],
    };

    expect(helpers.prependConversationHistory(current, olderPage)).toEqual({
      added: 1,
      detail: {
        ...current,
        historyNextCursor: "page-3",
        items: [olderPage.items[0], ...current.items],
      },
    });
  });
});

describe("运行中控制动作", () => {
  it("输入引导消息时仍同时保留独立停止按钮", () => {
    expect(helpers.composerActionVisibility(true, true, true)).toEqual({
      showInterrupt: true,
      showSubmit: true,
    });
    expect(helpers.composerActionVisibility(true, true, false)).toEqual({
      showInterrupt: true,
      showSubmit: false,
    });
    expect(helpers.composerActionVisibility(false, false, true)).toEqual({
      showInterrupt: false,
      showSubmit: true,
    });
  });
});

describe("对话附件草稿恢复", () => {
  it("刷新后保留浏览器上传与电脑文件引用，但不保存文件正文", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const attachments = [
      {
        kind: "file" as const,
        relativePath: "phone/note.txt",
        uploadId: "4d423d3a-b0ec-4c0b-aac6-cb87ce47a438",
      },
      {
        kind: "directory" as const,
        projectId: "project-1",
        relativePath: "docs",
      },
    ];

    helpers.writeConversationAttachments(storage, "thread/upload", attachments);

    expect(helpers.readConversationAttachments(storage, "thread/upload")).toEqual(attachments);
    expect([...values.values()].join("")).not.toContain("file body");
  });

  it("拒绝同时伪装为上传和项目来源的附件草稿", () => {
    const storage = {
      getItem: () =>
        JSON.stringify([
          {
            kind: "file",
            projectId: "project-1",
            uploadId: "upload-1",
            relativePath: "note.txt",
          },
        ]),
    };

    expect(helpers.readConversationAttachments(storage, "thread-1")).toEqual([]);
  });
});
