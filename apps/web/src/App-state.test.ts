import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteEvent, ThreadDetail, ThreadSummary } from "@codex-local-remote/contracts";
import type * as AppStateModule from "./App";
import { applyThreadRemoteEvents, createThreadRemoteEventProjectionState } from "./live-thread";
import {
  DIAGNOSTICS_LAST_KNOWN_TTL_MS,
  retainLastKnownDiagnosticSnapshot,
} from "./workspace-recovery";

type AppStateHelpers = typeof AppStateModule;

let helpers: AppStateHelpers;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function threadSummary(id: string, title: string): ThreadSummary {
  return {
    id,
    mode: "managed",
    state: "complete",
    title,
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

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

describe("对话行操作", () => {
  it("mutation 成功后并发分页回读当前与归档列表，直到旧页目标出现或列表耗尽", async () => {
    const calls: Array<{ archived: boolean; cursor?: string }> = [];
    const client = {
      threads: vi.fn(
        async ({ archived = false, cursor }: { archived?: boolean; cursor?: string }) => {
          calls.push({ archived, ...(cursor === undefined ? {} : { cursor }) });
          if (!archived) {
            return cursor === undefined
              ? { items: [{ id: "current-first", title: "当前首屏" }], nextCursor: "current-2" }
              : { items: [{ id: "current-last", title: "当前尾页" }] };
          }
          if (cursor === undefined) {
            return {
              items: [{ id: "archived-first", title: "归档首屏" }],
              nextCursor: "archived-2",
            };
          }
          return cursor === "archived-2"
            ? { items: [{ id: "archived-middle", title: "归档中页" }], nextCursor: "archived-3" }
            : { items: [{ id: "old-page-target", title: "已归档目标" }], nextCursor: "archived-4" };
        },
      ),
    };

    const result = await helpers.readAuthoritativeThreadLists(
      client as unknown as Parameters<typeof helpers.readAuthoritativeThreadLists>[0],
      "old-page-target",
    );

    expect(result).toEqual({
      archived: {
        firstPageItemCount: 1,
        items: [
          { id: "archived-first", title: "归档首屏" },
          { id: "archived-middle", title: "归档中页" },
          { id: "old-page-target", title: "已归档目标" },
        ],
        nextCursor: "archived-4",
      },
      current: {
        firstPageItemCount: 1,
        items: [
          { id: "current-first", title: "当前首屏" },
          { id: "current-last", title: "当前尾页" },
        ],
      },
    });
    expect(
      helpers.threadMutationMatchesAuthoritativeLists(result, {
        mutation: { archived: true, kind: "archive" },
        threadId: "old-page-target",
      }),
    ).toBe(true);
    expect(calls).toEqual([
      { archived: false },
      { archived: true },
      { archived: false, cursor: "current-2" },
      { archived: true, cursor: "archived-2" },
      { archived: true, cursor: "archived-3" },
    ]);
  });

  it("有界分页未找到且未耗尽时不会把目标缺席误判为 receipt 收敛", async () => {
    const client = {
      threads: vi.fn(
        async ({ archived = false, cursor }: { archived?: boolean; cursor?: string }) => ({
          items: [{ id: `${archived ? "archived" : "current"}-${cursor ?? "first"}` }],
          nextCursor: `${archived ? "archived" : "current"}-next`,
        }),
      ),
    };

    const result = await helpers.readAuthoritativeThreadLists(
      client as unknown as Parameters<typeof helpers.readAuthoritativeThreadLists>[0],
      "old-page-target",
      1,
    );

    expect(
      helpers.threadMutationMatchesAuthoritativeLists(result, {
        mutation: { archived: true, kind: "archive" },
        threadId: "old-page-target",
      }),
    ).toBe(false);
  });

  it("旧页目标恢复或重命名后也会遍历到当前列表目标，并以归档列表耗尽解除 receipt", async () => {
    const client = {
      threads: vi.fn(
        async ({ archived = false, cursor }: { archived?: boolean; cursor?: string }) => {
          if (archived) return { items: [] };
          return cursor === undefined
            ? {
                items: [threadSummary("current-first", "当前首屏")],
                nextCursor: "current-2",
              }
            : { items: [threadSummary("old-page-target", "新名称")] };
        },
      ),
    };
    const result = await helpers.readAuthoritativeThreadLists(
      client as unknown as Parameters<typeof helpers.readAuthoritativeThreadLists>[0],
      "old-page-target",
    );

    expect(
      helpers.threadMutationMatchesAuthoritativeLists(result, {
        mutation: { archived: false, kind: "archive" },
        threadId: "old-page-target",
      }),
    ).toBe(true);
    expect(
      helpers.threadMutationMatchesAuthoritativeLists(result, {
        mutation: { kind: "rename", name: "新名称" },
        threadId: "old-page-target",
      }),
    ).toBe(true);
    expect(client.threads).toHaveBeenCalledWith({ archived: false, cursor: "current-2" });
  });

  it("权威旧页前缀更新目标时保留已加载尾页，耗尽源列表时移除陈旧目标", () => {
    const preserved = helpers.mergeThreadListReadback(
      [
        threadSummary("old-first", "旧首屏"),
        threadSummary("old-page-target", "旧名称"),
        threadSummary("loaded-tail", "已加载尾页"),
      ],
      "loaded-next",
      new Set(["old-page-target", "loaded-tail"]),
      {
        firstPageItemCount: 1,
        items: [threadSummary("new-first", "新首屏"), threadSummary("old-page-target", "新名称")],
        nextCursor: "readback-next",
      },
    );

    expect({
      ...preserved,
      items: preserved.items.map(({ id, title }) => ({ id, title })),
    }).toEqual({
      items: [
        { id: "new-first", title: "新首屏" },
        { id: "old-page-target", title: "新名称" },
        { id: "loaded-tail", title: "已加载尾页" },
      ],
      loadedTailIds: new Set(["old-page-target", "loaded-tail"]),
      nextCursor: "loaded-next",
    });

    expect(
      helpers.mergeThreadListReadback(
        preserved.items,
        preserved.nextCursor,
        preserved.loadedTailIds,
        {
          firstPageItemCount: 1,
          items: [threadSummary("new-first", "新首屏")],
        },
      ),
    ).toMatchObject({
      items: [threadSummary("new-first", "新首屏")],
      loadedTailIds: new Set(),
    });
  });

  it("PUT 已确认后即使一侧列表首次回读失败，也只重试只读收敛而不重复 PUT", async () => {
    const commit = vi.fn(async () => undefined);
    const apply = vi.fn();
    const wait = vi.fn(async () => undefined);
    let currentReads = 0;
    const client = {
      threads: vi.fn(async ({ archived = false }: { archived?: boolean }) => {
        if (!archived && currentReads++ === 0) {
          throw new Error("current list temporarily unavailable");
        }
        return {
          items: [
            {
              id: archived ? "archived-thread" : "current-thread",
              title: archived ? "已归档" : "当前",
            },
          ],
        };
      }),
    };

    const result = await helpers.commitThenConvergeThreadLists({
      apply,
      commit,
      read: () =>
        helpers.readAuthoritativeThreadLists(
          client as unknown as Parameters<typeof helpers.readAuthoritativeThreadLists>[0],
          "archived-thread",
        ),
      retryDelaysMs: [0, 0],
      wait,
    });

    expect(result.kind).toBe("committed-refreshing");
    expect(commit).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    if (result.kind !== "committed-refreshing") throw new Error("expected background refresh");
    await expect(result.refresh).resolves.toEqual({ kind: "converged" });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(client.threads).toHaveBeenCalledTimes(4);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("PUT 已确认但列表持续失败时有界停止，并保持 committed 而不重复语义写入", async () => {
    const commit = vi.fn(async () => undefined);
    const apply = vi.fn();
    const wait = vi.fn(async () => undefined);
    const read = vi.fn(async () => {
      throw new Error("lists unavailable");
    });

    const result = await helpers.commitThenConvergeThreadLists({
      apply,
      commit,
      read,
      retryDelaysMs: [0, 0],
      wait,
    });

    expect(result.kind).toBe("committed-refreshing");
    if (result.kind !== "committed-refreshing") throw new Error("expected background refresh");
    const refreshResult = await result.refresh;
    expect(refreshResult.kind).toBe("failed");
    if (refreshResult.kind !== "failed" || !(refreshResult.error instanceof Error)) {
      throw new Error("expected a bounded refresh failure");
    }
    expect(refreshResult.error.message).toBe("lists unavailable");
    expect(commit).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(apply).not.toHaveBeenCalled();
  });

  it("committed receipt 后显式恢复只做 GET，权威收敛前不会再次语义写入", async () => {
    const commit = vi.fn(async () => undefined);
    const apply = vi.fn();
    const wait = vi.fn(async () => undefined);
    const authoritative = {
      archived: { items: [] },
      current: {
        items: [
          {
            id: "thread-receipt",
            mode: "managed" as const,
            state: "complete" as const,
            title: "权威新名称",
            updatedAt: "2026-07-29T00:00:00.000Z",
          },
        ],
      },
    };
    const read = vi
      .fn<() => Promise<typeof authoritative>>()
      .mockRejectedValueOnce(new Error("current unavailable"))
      .mockRejectedValueOnce(new Error("archived unavailable"))
      .mockResolvedValue(authoritative);

    const result = await helpers.commitThenConvergeThreadLists({
      apply,
      commit,
      read,
      retryDelaysMs: [0],
      wait,
    });
    expect(result.kind).toBe("committed-refreshing");
    if (result.kind !== "committed-refreshing") throw new Error("expected committed receipt");
    await expect(result.refresh).resolves.toMatchObject({ kind: "failed" });

    await expect(
      helpers.convergeThreadLists({
        apply,
        read,
        retryDelaysMs: [0],
        wait,
      }),
    ).resolves.toEqual({ kind: "converged" });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(3);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("rename/archive/restore receipts 只有在对应双列表权威状态出现后才收敛", () => {
    const current = {
      id: "thread-receipt",
      mode: "managed" as const,
      state: "complete" as const,
      title: "新名称",
      updatedAt: "2026-07-29T00:00:00.000Z",
    };
    const archived = {
      id: "thread-receipt",
      mode: "managed" as const,
      state: "complete" as const,
      title: "新名称",
      updatedAt: "2026-07-29T00:00:00.000Z",
    };

    expect(
      helpers.threadMutationMatchesAuthoritativeLists(
        { archived: { items: [] }, current: { items: [current] } },
        {
          mutation: { kind: "rename", name: "新名称" },
          threadId: "thread-receipt",
        },
      ),
    ).toBe(true);
    expect(
      helpers.threadMutationMatchesAuthoritativeLists(
        { archived: { items: [] }, current: { items: [current] } },
        {
          mutation: { archived: true, kind: "archive" },
          threadId: "thread-receipt",
        },
      ),
    ).toBe(false);
    expect(
      helpers.threadMutationMatchesAuthoritativeLists(
        { archived: { items: [archived] }, current: { items: [] } },
        {
          mutation: { archived: true, kind: "archive" },
          threadId: "thread-receipt",
        },
      ),
    ).toBe(true);
    expect(
      helpers.threadMutationMatchesAuthoritativeLists(
        { archived: { items: [] }, current: { items: [current] } },
        {
          mutation: { archived: false, kind: "archive" },
          threadId: "thread-receipt",
        },
      ),
    ).toBe(true);
  });

  it("底部锚点在空间不足时向上翻转并避开移动底栏", () => {
    const position = helpers.anchoredThreadActionMenuPosition({
      anchor: {
        bottom: 730,
        height: 44,
        left: 320,
        right: 364,
        top: 686,
        width: 44,
      },
      bottomBoundary: 720,
      floating: { height: 260, width: 280 },
      viewportWidth: 360,
    });

    expect(position).toEqual({ left: 68, top: 420 });
    expect(position.top + 260).toBeLessThanOrEqual(720);
  });

  it("PUT 本身失败时不启动列表回读，只有显式再次调用才会重试语义写入", async () => {
    const commit = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("PUT unavailable"))
      .mockResolvedValueOnce(undefined);
    const apply = vi.fn();
    const read = vi.fn(async () => ({
      archived: { items: [] },
      current: { items: [] },
    }));
    const input = {
      apply,
      commit,
      read,
      retryDelaysMs: [0],
      wait: vi.fn(async () => undefined),
    };

    await expect(helpers.commitThenConvergeThreadLists(input)).rejects.toThrow("PUT unavailable");
    expect(commit).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();

    await expect(helpers.commitThenConvergeThreadLists(input)).resolves.toEqual({
      kind: "converged",
    });
    expect(commit).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("当前与归档行呈现正确操作，忙时禁用 mutation 并保留复制", () => {
    const common = {
      busy: true,
      feedback: "正在归档…",
      onArchiveChange: () => undefined,
      onCopy: () => undefined,
      onRename: () => undefined,
      onRequestClose: () => undefined,
      onRequestRename: () => undefined,
      onRetryConvergence: () => undefined,
      online: true,
      pendingConvergence: false,
      renameValue: "测试对话",
      thread: {
        id: "thread-menu",
        mode: "managed" as const,
        state: "complete" as const,
        title: "测试对话",
        updatedAt: "2026-07-29T00:00:00.000Z",
      },
    };
    const current = renderToStaticMarkup(
      helpers.ThreadActionMenuView({
        ...common,
        archived: false,
        mode: "menu",
      }),
    );
    const archived = renderToStaticMarkup(
      helpers.ThreadActionMenuView({
        ...common,
        archived: true,
        mode: "menu",
      }),
    );

    expect(current).toContain("重命名");
    expect(current).toContain("复制对话 ID");
    expect(current).toContain("归档");
    expect(current).toContain("置顶请在 Desktop 管理");
    expect(current).not.toContain("恢复对话");
    expect(archived).toContain("重命名");
    expect(archived).toContain("复制对话 ID");
    expect(archived).toContain("恢复对话");
    expect(archived).not.toContain(">归档<");
    expect(current).toContain("正在归档…");
    expect(current).toContain('aria-disabled="true"');
  });

  it.each(["running", "waiting-for-approval"] as const)("%s 任务明确要求先停止再归档", (state) => {
    const html = renderToStaticMarkup(
      helpers.ThreadActionMenuView({
        archived: false,
        busy: false,
        feedback: "",
        mode: "menu",
        onArchiveChange: () => undefined,
        onCopy: () => undefined,
        onRename: () => undefined,
        onRequestClose: () => undefined,
        onRequestRename: () => undefined,
        onRetryConvergence: () => undefined,
        online: true,
        pendingConvergence: false,
        renameValue: "运行中的任务",
        thread: {
          id: "thread-running",
          mode: "managed",
          state,
          title: "运行中的任务",
          updatedAt: "2026-07-29T00:00:00.000Z",
        },
      }),
    );

    expect(html).toContain("请先停止正在运行的任务再归档");
    expect(html).toMatch(
      /<button[^>]*aria-describedby="[^"]*active-reason"[^>]*aria-disabled="true"[^>]*>.*归档<\/button>/su,
    );
  });

  it.each([false, true])(
    "pending receipt 对当前与归档行均锁定 mutation，并提供可发现的 GET-only 恢复",
    (archived) => {
      const html = renderToStaticMarkup(
        helpers.ThreadActionMenuView({
          archived,
          busy: false,
          feedback: "",
          mode: "menu",
          onArchiveChange: () => undefined,
          onCopy: () => undefined,
          onRename: () => undefined,
          onRequestClose: () => undefined,
          onRequestRename: () => undefined,
          onRetryConvergence: () => undefined,
          online: true,
          pendingConvergence: true,
          renameValue: "待同步任务",
          thread: {
            id: "thread-pending",
            mode: "managed",
            state: "complete",
            title: "待同步任务",
            updatedAt: "2026-07-29T00:00:00.000Z",
          },
        }),
      );

      expect(html).toContain("重新同步");
      expect(html).toContain("上次操作已提交");
      expect(html).toMatch(/aria-describedby="[^"]*pending-reason"/u);
      expect(html.match(/aria-disabled="true"/gu)).toHaveLength(2);
    },
  );

  it("离线 mutation 保持键盘可聚焦，并用 aria-describedby 暴露禁用原因", () => {
    const html = renderToStaticMarkup(
      helpers.ThreadActionMenuView({
        archived: false,
        busy: false,
        feedback: "",
        mode: "menu",
        onArchiveChange: () => undefined,
        onCopy: () => undefined,
        onRename: () => undefined,
        onRequestClose: () => undefined,
        onRequestRename: () => undefined,
        online: false,
        renameValue: "离线任务",
        thread: {
          id: "thread-offline",
          mode: "managed",
          state: "complete",
          title: "离线任务",
          updatedAt: "2026-07-29T00:00:00.000Z",
        },
      }),
    );

    expect(html).toContain("连接恢复后才能修改对话");
    expect(html).toMatch(/aria-describedby="[^"]*offline-reason" aria-disabled="true"/u);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>.*(?:重命名|归档)/su);
  });
});

describe("持续目标首次加载", () => {
  it("能力降级但目标接口仍可读时继续尝试回读现有目标", () => {
    expect(helpers.shouldReadThreadGoal(undefined)).toBe(false);
    expect(helpers.shouldReadThreadGoal({ goals: "unavailable" })).toBe(false);
    expect(helpers.shouldReadThreadGoal({ goals: "degraded" })).toBe(true);
    expect(helpers.shouldReadThreadGoal({ goals: "available" })).toBe(true);
  });

  it("能力尚未就绪或临时读取失败时不锁死后续真实目标回读", () => {
    expect(helpers.shouldCommitThreadGoalLoad(false, undefined)).toBe(false);
    expect(helpers.shouldCommitThreadGoalLoad(false, { goal: null })).toBe(true);
    expect(
      helpers.shouldCommitThreadGoalLoad(false, {
        goal: {
          threadId: "thread-goal",
          objective: "完成真实目标",
          status: "active",
          tokensUsed: 1,
          timeUsedSeconds: 2,
          createdAt: "2026-07-31T00:00:00.000Z",
          updatedAt: "2026-07-31T00:00:01.000Z",
        },
      }),
    ).toBe(true);
    expect(helpers.shouldCommitThreadGoalLoad(true, { goal: null })).toBe(true);
  });

  it("目标编辑器关闭时接受轮询到的远端目标更新", () => {
    const goalResult = {
      goal: {
        threadId: "thread-goal",
        objective: "由另一端更新后的真实目标",
        status: "active" as const,
        tokensUsed: 1,
        timeUsedSeconds: 2,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:01:00.000Z",
      },
    };
    expect(helpers.shouldCommitThreadGoalLoad(true, goalResult, false, false)).toBe(true);
    expect(helpers.shouldCommitThreadGoalLoad(true, goalResult, true, false)).toBe(false);
    expect(helpers.shouldCommitThreadGoalLoad(true, goalResult, false, true)).toBe(false);
  });

  it("首次目标读取不能在编辑器打开或保存忙时覆盖草稿，编辑器关闭后才允许恢复", () => {
    const goalResult = {
      goal: {
        threadId: "thread-goal",
        objective: "远端首载目标",
        status: "active" as const,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: "2026-08-02T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:01.000Z",
      },
    };

    expect(helpers.shouldCommitThreadGoalLoad(false, goalResult, true, false)).toBe(false);
    expect(helpers.shouldCommitThreadGoalLoad(false, goalResult, false, true)).toBe(false);
    expect(helpers.shouldCommitThreadGoalLoad(false, goalResult, false, false)).toBe(true);
  });

  it("只在目标编辑器从打开变为关闭时触发恢复读取", () => {
    expect(helpers.shouldRefreshThreadGoalAfterEditorClose(true, false)).toBe(true);
    expect(helpers.shouldRefreshThreadGoalAfterEditorClose(false, false)).toBe(false);
    expect(helpers.shouldRefreshThreadGoalAfterEditorClose(false, true)).toBe(false);
    expect(helpers.shouldRefreshThreadGoalAfterEditorClose(true, true)).toBe(false);
  });

  it("目标编辑或写入期间不启动可能回写旧状态的刷新", () => {
    expect(helpers.shouldStartThreadGoalRefresh(true, false, false)).toBe(true);
    expect(helpers.shouldStartThreadGoalRefresh(true, true, false)).toBe(false);
    expect(helpers.shouldStartThreadGoalRefresh(true, false, true)).toBe(false);
    expect(helpers.shouldStartThreadGoalRefresh(false, false, false)).toBe(false);
  });

  it("终态目标刷新只接受当前任务的最新请求，旧请求不能覆盖完成状态", () => {
    expect(helpers.shouldCommitThreadGoalRefresh("thread", "thread", 3, 3, false, false)).toBe(
      true,
    );
    expect(helpers.shouldCommitThreadGoalRefresh("thread", "thread", 2, 3, false, false)).toBe(
      false,
    );
    expect(helpers.shouldCommitThreadGoalRefresh("old", "thread", 3, 3, false, false)).toBe(false);
    expect(helpers.shouldCommitThreadGoalRefresh("thread", "thread", 3, 3, true, false)).toBe(
      false,
    );
    expect(helpers.shouldCommitThreadGoalRefresh("thread", "thread", 3, 3, false, true)).toBe(
      false,
    );
  });

  it("文件根位置仅显示规范根标签，不重复盘符名称", () => {
    expect(helpers.fileRootDisplayLabel({ name: "C:", rootLabel: "C:\\" })).toBe("C:\\");
    expect(helpers.fileRootDisplayLabel({ name: "V:", rootLabel: "V:\\" })).toBe("V:\\");
  });

  it("附件面板的移除动作只更新选择，不产生关闭信号", () => {
    const items = [
      { kind: "file" as const, projectId: "project", relativePath: "one.txt" },
      { kind: "file" as const, projectId: "project", relativePath: "two.txt" },
    ];
    expect(helpers.removeAttachmentReference(items, items[0]!)).toEqual([items[1]]);
  });
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

  it("resolveFile 的 A 请求晚于 B 返回时只允许 B 写入", async () => {
    const requests = helpers.createLatestRequestController();
    const first = deferred<string>();
    const second = deferred<string>();
    const committed: string[] = [];
    const resolve = async (requestKey: string, promise: Promise<string>) => {
      const request = requests.begin(requestKey);
      const value = await promise;
      if (requests.isCurrent(request)) committed.push(value);
    };

    const firstResult = resolve("attachment-a", first.promise);
    const secondResult = resolve("attachment-b", second.promise);
    first.resolve("A");
    await firstResult;
    expect(committed).toEqual([]);

    second.resolve("B");
    await secondResult;
    expect(committed).toEqual(["B"]);
  });

  it("预览在 resolveFile 请求中关闭后不会被晚到响应重新打开", async () => {
    const requests = helpers.createLatestRequestController();
    const pending = deferred<string>();
    const committed: string[] = [];
    const request = requests.begin("local-file");
    const result = pending.promise.then((value) => {
      if (requests.isCurrent(request)) committed.push(value);
    });

    requests.cancel();
    pending.resolve("late");
    await result;

    expect(committed).toEqual([]);
  });
});

describe("工作记录局部状态", () => {
  it("对话展示身份同时区分线程与连接重置代次", () => {
    expect(helpers.conversationPresentationIdentity("thread-a", 2)).not.toBe(
      helpers.conversationPresentationIdentity("thread-b", 2),
    );
    expect(helpers.conversationPresentationIdentity("thread-a", 2)).not.toBe(
      helpers.conversationPresentationIdentity("thread-a", 3),
    );
  });

  it("未手动切换时跨过自动折叠阈值会双向同步开合状态", () => {
    expect(
      helpers.workLogOpenAfterItemsChange({
        activeHeader: false,
        currentOpen: false,
        itemCount: 6,
        manuallyToggled: false,
      }),
    ).toBe(true);
    expect(
      helpers.workLogOpenAfterItemsChange({
        activeHeader: false,
        currentOpen: true,
        itemCount: 7,
        manuallyToggled: false,
      }),
    ).toBe(false);
    expect(
      helpers.workLogOpenAfterItemsChange({
        activeHeader: false,
        currentOpen: false,
        itemCount: 6,
        manuallyToggled: true,
      }),
    ).toBe(false);
  });

  it("进行中的最新工作段超过折叠阈值时仍默认展开，并尊重手动折叠", () => {
    expect(
      helpers.workLogOpenAfterItemsChange({
        activeHeader: true,
        currentOpen: false,
        itemCount: 7,
        manuallyToggled: false,
      }),
    ).toBe(true);
    expect(
      helpers.workLogOpenAfterItemsChange({
        activeHeader: true,
        currentOpen: false,
        itemCount: 8,
        manuallyToggled: true,
      }),
    ).toBe(false);
  });

  it("活动详情按 id 从最新 items 派生，状态更新且删除后关闭", () => {
    const running = {
      id: "tool-current",
      kind: "tool" as const,
      status: "running" as const,
      title: "运行命令",
    };
    const complete = {
      ...running,
      output: "验证通过",
      status: "complete" as const,
    };

    expect(helpers.selectedActivityItem([running], running.id)).toBe(running);
    expect(helpers.selectedActivityItem([complete], running.id)).toBe(complete);
    expect(helpers.selectedActivityItem([], running.id)).toBeUndefined();
  });
});

describe("子智能体历史完整性提示", () => {
  const integrity = {
    reason: "verified-exhaustive" as const,
    observedCount: 3,
    streams: {
      current: { status: "exhausted" as const, observedCount: 3 },
      archived: { status: "exhausted" as const, observedCount: 0 },
    },
  };

  it("完整或旧端未提供元数据时不打扰", () => {
    expect(helpers.subagentHistoryIntegrityNotice(undefined)).toBe("");
    expect(helpers.subagentHistoryIntegrityNotice({ ...integrity, status: "complete" })).toBe("");
  });

  it("只对非完整状态给出带已获取数量的真实提示", () => {
    expect(
      helpers.subagentHistoryIntegrityNotice({
        ...integrity,
        status: "partial",
        reason: "pagination-pending",
      }),
    ).toContain("当前已获取 3 条记录");
    expect(
      helpers.subagentHistoryIntegrityNotice({
        ...integrity,
        status: "failed",
        reason: "read-failed",
      }),
    ).toContain("读取失败");
    expect(
      helpers.subagentHistoryIntegrityNotice({
        ...integrity,
        status: "unknown",
        reason: "continuation-unverified",
      }),
    ).toContain("无法确认");
  });

  it("只有从第一页连续读到明确闭合的末页才升级为完整", () => {
    const firstPage = helpers.accumulateSubagentHistoryIntegrity({
      accumulatedCount: 2,
      continuing: false,
      incoming: {
        ...integrity,
        status: "partial",
        reason: "pagination-pending",
        observedCount: 2,
        streams: {
          current: { status: "more-available", observedCount: 2 },
          archived: { status: "exhausted", observedCount: 0 },
        },
      },
      nextCursor: "page-2",
    });
    const closed = helpers.accumulateSubagentHistoryIntegrity({
      accumulatedCount: 4,
      continuing: true,
      incoming: {
        ...integrity,
        status: "complete",
        reason: "verified-exhaustive",
        observedCount: 2,
        streams: {
          current: { status: "exhausted", observedCount: 2 },
          archived: { status: "not-requested", observedCount: 0 },
        },
      },
      previous: firstPage,
    });
    const orphanedContinuation = helpers.accumulateSubagentHistoryIntegrity({
      accumulatedCount: 2,
      continuing: true,
      incoming: {
        ...integrity,
        status: "complete",
        observedCount: 2,
      },
    });

    expect(closed).toMatchObject({
      status: "complete",
      reason: "verified-exhaustive",
      observedCount: 4,
    });
    expect(helpers.subagentHistoryPaginationCompleteLabel(closed)).toBe("已显示全部子智能体");
    expect(orphanedContinuation).toMatchObject({
      status: "unknown",
      reason: "continuation-unverified",
      observedCount: 2,
    });
  });

  it("末页 continuation unknown 或分页失败时保留累计风险，绝不显示已全部加载", () => {
    const firstPage = helpers.accumulateSubagentHistoryIntegrity({
      accumulatedCount: 2,
      continuing: false,
      incoming: {
        ...integrity,
        status: "partial",
        reason: "pagination-pending",
        observedCount: 2,
      },
      nextCursor: "page-2",
    });
    const unknownEnd = helpers.accumulateSubagentHistoryIntegrity({
      accumulatedCount: 4,
      continuing: true,
      incoming: {
        ...integrity,
        status: "unknown",
        reason: "continuation-unverified",
        observedCount: 2,
      },
      previous: firstPage,
    });
    const failedEnd = helpers.accumulateSubagentHistoryIntegrity({
      accumulatedCount: 2,
      continuing: true,
      incoming: {
        ...integrity,
        status: "failed",
        reason: "pagination-failed",
        observedCount: 0,
        streams: {
          current: { status: "failed", observedCount: 0 },
          archived: { status: "not-requested", observedCount: 0 },
        },
      },
      nextCursor: "page-2",
      previous: firstPage,
    });

    expect(unknownEnd).toMatchObject({
      status: "unknown",
      reason: "continuation-unverified",
      observedCount: 4,
    });
    expect(failedEnd).toMatchObject({
      status: "failed",
      reason: "pagination-failed",
      observedCount: 2,
    });
    expect(helpers.subagentHistoryPaginationCompleteLabel(unknownEnd)).toBe(
      "子智能体历史尚未确认完整",
    );
    expect(helpers.subagentHistoryPaginationCompleteLabel(failedEnd)).toBe(
      "子智能体历史尚未确认完整",
    );
  });

  it("后续成功页不能抹掉较早页已经确认的 failed、partial 或 unknown 风险", () => {
    const completedPage = {
      ...integrity,
      status: "complete" as const,
      observedCount: 1,
    };
    const previousStates = [
      {
        ...integrity,
        status: "failed" as const,
        reason: "pagination-failed" as const,
        observedCount: 2,
      },
      {
        ...integrity,
        status: "partial" as const,
        reason: "read-truncated" as const,
        observedCount: 2,
      },
      {
        ...integrity,
        status: "unknown" as const,
        reason: "verification-mismatch" as const,
        observedCount: 2,
      },
    ];

    expect(
      previousStates.map(
        (previous) =>
          helpers.accumulateSubagentHistoryIntegrity({
            accumulatedCount: 3,
            continuing: true,
            incoming: completedPage,
            previous,
          })?.status,
      ),
    ).toEqual(["failed", "partial", "unknown"]);
  });

  it("累计 observedCount 服从当前去重列表，而不是把重复页计数相加", () => {
    const firstPage = helpers.accumulateSubagentHistoryIntegrity({
      accumulatedCount: 2,
      continuing: false,
      incoming: {
        ...integrity,
        status: "partial",
        reason: "pagination-pending",
        observedCount: 2,
      },
      nextCursor: "page-2",
    });
    const deduplicatedEnd = helpers.accumulateSubagentHistoryIntegrity({
      accumulatedCount: 3,
      continuing: true,
      incoming: {
        ...integrity,
        status: "unknown",
        reason: "continuation-unverified",
        observedCount: 2,
      },
      previous: firstPage,
    });

    expect(deduplicatedEnd?.observedCount).toBe(3);
  });

  it("已扩展列表刷新第一页时保留累计风险和去重后的累计数量", () => {
    const previous = {
      ...integrity,
      status: "unknown" as const,
      reason: "continuation-unverified" as const,
      observedCount: 4,
    };
    const refreshed = helpers.accumulateSubagentHistoryIntegrity({
      accumulatedCount: 5,
      continuing: false,
      incoming: {
        ...integrity,
        status: "partial",
        reason: "pagination-pending",
        observedCount: 2,
      },
      nextCursor: "page-2",
      preserveExpandedHistory: true,
      previous,
    });

    expect(refreshed).toMatchObject({
      status: "partial",
      reason: "pagination-pending",
      observedCount: 5,
    });
    expect(helpers.subagentHistoryPaginationCompleteLabel(undefined)).toBe(
      "子智能体历史尚未确认完整",
    );
  });
});

describe("持久会话历史完整性提示", () => {
  const verifiedComplete = {
    observedCount: 12,
    reason: "verified-complete" as const,
    scope: "complete" as const,
    status: "complete" as const,
  };

  it("子任务全文件读取并验证完整时保持静默", () => {
    expect(
      helpers.persistedConversationHistoryNotice({
        historyNextCursor: "protocol-page-2",
        persistedHistoryIntegrity: verifiedComplete,
      }),
    ).toBe("");
  });

  it("部分读取明确说明只显示已验证记录且历史不完整", () => {
    const notice = helpers.persistedConversationHistoryNotice({
      persistedHistoryIntegrity: {
        ...verifiedComplete,
        reason: "invalid-json",
        status: "partial",
      },
    });

    expect(notice).toContain("仅显示已验证记录");
    expect(notice).toContain("历史不完整");
  });

  it("持久历史读取失败时给出明确失败提示", () => {
    expect(
      helpers.persistedConversationHistoryNotice({
        persistedHistoryIntegrity: {
          ...verifiedComplete,
          observedCount: 0,
          reason: "read-failed",
          status: "failed",
        },
      }),
    ).toContain("读取失败");
  });

  it("根任务最近窗口是内部渐进来源时保持静默，由分页控件表达可用动作", () => {
    expect(
      helpers.persistedConversationHistoryNotice({
        historyNextCursor: "older-page",
        persistedHistoryIntegrity: {
          ...verifiedComplete,
          observedCount: 8,
          reason: "recent-window",
          scope: "recent",
          status: "partial",
        },
      }),
    ).toBe("");
  });

  it("有更早页时，缺失或畸形完整性元数据也保持未确认完整", () => {
    expect(
      helpers.persistedConversationHistoryNotice({
        historyNextCursor: "older-page",
      }),
    ).toContain("尚未确认完整");
    expect(
      helpers.persistedConversationHistoryNotice({
        historyNextCursor: "older-page",
        persistedHistoryIntegrity: {
          observedCount: -1,
          reason: "verified-complete",
          scope: "complete",
          status: "complete",
        },
      }),
    ).toContain("尚未确认完整");
  });
});

describe("当前详情实时投影门禁", () => {
  it("发送前只读取轻量控制壳，不把超长历史放进提交关键路径", async () => {
    const shell = {
      id: "thread-long",
      title: "超长任务",
      mode: "managed" as const,
      state: "idle" as const,
      updatedAt: "2026-07-28T00:00:00.000Z",
      items: [],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    };
    const threadShell = vi.fn().mockResolvedValue(shell);

    await expect(
      helpers.readThreadControlBeforeSubmit({ threadShell }, "thread-long"),
    ).resolves.toBe(shell);
    expect(threadShell).toHaveBeenCalledTimes(1);
    expect(threadShell).toHaveBeenCalledWith("thread-long");
  });

  it("运行态刷新同时读取缓存正文和新鲜控制壳，以便 Desktop 停止后恢复发送", async () => {
    const staleActive = {
      id: "thread-stop-refresh",
      title: "停止收敛",
      mode: "managed" as const,
      state: "running" as const,
      updatedAt: "2026-07-29T00:00:00.000Z",
      items: [{ id: "assistant-partial", kind: "assistant-message" as const, text: "部分输出" }],
      activeTurnId: "turn-running",
      availableActions: {
        changeModelNextTurn: true,
        interrupt: true,
        reply: false,
        steer: true,
      },
    };
    const terminalControl = {
      ...staleActive,
      state: "idle" as const,
      items: [],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    };
    const { activeTurnId: _stoppedTurnId, ...idleControl } = terminalControl;
    const thread = vi.fn().mockResolvedValue(staleActive);
    const threadShell = vi.fn().mockResolvedValue(idleControl);

    await expect(
      helpers.readThreadRefreshSnapshots({ thread, threadShell }, staleActive.id, staleActive),
    ).resolves.toEqual({
      control: idleControl,
      detail: staleActive,
    });
    expect(thread).toHaveBeenCalledWith(staleActive.id);
    expect(threadShell).toHaveBeenCalledWith(staleActive.id);
  });

  it("稳定空闲态刷新不额外读取控制壳", async () => {
    const idle = {
      id: "thread-idle-refresh",
      title: "空闲任务",
      mode: "managed" as const,
      state: "idle" as const,
      updatedAt: "2026-07-29T00:00:00.000Z",
      items: [],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    };
    const thread = vi.fn().mockResolvedValue(idle);
    const threadShell = vi.fn();

    await expect(
      helpers.readThreadRefreshSnapshots({ thread, threadShell }, idle.id, idle),
    ).resolves.toEqual({ detail: idle });
    expect(threadShell).not.toHaveBeenCalled();
  });

  it("普通下一轮在网络响应前先生成可回滚的本地用户气泡", () => {
    const thread = {
      id: "thread-long",
      title: "超长任务",
      mode: "managed" as const,
      state: "idle" as const,
      updatedAt: "2026-07-28T00:00:00.000Z",
      items: [],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    };

    const optimistic = helpers.appendOptimisticUserMessage(
      thread,
      "本地立即显示",
      "pending-send-1",
    );
    expect(optimistic.items).toEqual([
      {
        id: "pending-send-1",
        kind: "user-message",
        text: "本地立即显示",
      },
    ]);
    expect(helpers.removeOptimisticConversationItem(optimistic, "pending-send-1").items).toEqual(
      [],
    );
  });

  it("排队动作的较旧详情回包不会擦除请求期间到达的实时消息和控制状态", () => {
    const live = {
      id: "thread-queued-race",
      title: "排队竞态",
      mode: "managed" as const,
      state: "running" as const,
      updatedAt: "2026-07-29T00:00:02.000Z",
      activeTurnId: "turn-current",
      items: [
        {
          id: "queued-live-user",
          kind: "user-message" as const,
          text: "排队后立即引导",
          turnId: "turn-current",
        },
      ],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: true,
        reply: false,
        steer: true,
      },
    };
    const stale = {
      ...live,
      state: "idle" as const,
      updatedAt: "2026-07-29T00:00:01.000Z",
      items: [],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
    };
    const { activeTurnId: _staleTurnId, ...staleWithoutTurn } = stale;

    expect(helpers.mergeQueuedThreadRefresh(live, staleWithoutTurn)).toMatchObject({
      state: "running",
      activeTurnId: "turn-current",
      items: [{ id: "queued-live-user" }],
      availableActions: {
        interrupt: true,
        reply: false,
        steer: true,
      },
    });
  });

  it("只有对话详情页订阅该任务的重型实时明细", () => {
    expect(helpers.threadIdFromConversationPath("/threads/thread-1")).toBe("thread-1");
    expect(helpers.threadIdFromConversationPath("/threads/a%2Fb")).toBe("a/b");
    expect(helpers.threadIdFromConversationPath("/threads")).toBeUndefined();
    expect(helpers.threadIdFromConversationPath("/")).toBeUndefined();
  });

  it("详情快照游标只换代一次订阅，旧新流重叠事件仍只投影一次", () => {
    type Subscription = {
      active: boolean;
      deliver: (event: RemoteEvent) => void;
      options: { cursor?: string; threadId?: string } | undefined;
    };
    const order: string[] = [];
    const subscriptions: Subscription[] = [];
    const apiClient = {
      subscribe: vi.fn(
        (
          onEvent: (event: RemoteEvent) => void,
          _onConnection: (online: boolean) => void,
          options?: { cursor?: string; threadId?: string },
        ) => {
          const generation = subscriptions.length + 1;
          const subscription: Subscription = {
            active: true,
            deliver: (event) => {
              if (subscription.active) onEvent(event);
            },
            options,
          };
          subscriptions.push(subscription);
          order.push(`subscribe:${generation}`);
          return () => {
            subscription.active = false;
            order.push(`unsubscribe:${generation}`);
          };
        },
      ),
    };
    const projection = createThreadRemoteEventProjectionState();
    let thread: ThreadDetail = {
      id: "thread-1",
      title: "游标交接",
      mode: "managed",
      state: "running",
      updatedAt: "2026-07-30T00:00:00.000Z",
      items: [],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: true,
        reply: false,
        steer: true,
      },
    };
    const event: RemoteEvent = {
      schemaVersion: 1,
      seq: 7,
      type: "thread.item",
      threadId: thread.id,
      turnId: "turn-1",
      emittedAt: "2026-07-30T00:00:07.000Z",
      payload: {
        kind: "assistant-message-delta",
        itemId: "assistant-1",
        delta: "只出现一次",
      },
    };
    const initialCursorState: AppStateModule.WorkspaceSnapshotEventCursor | undefined = undefined;
    let unsubscribe = helpers.subscribeWorkspaceEventStream(
      apiClient,
      (nextEvent) => {
        thread = applyThreadRemoteEvents(thread, [nextEvent], { projection });
      },
      () => undefined,
      thread.id,
      helpers.workspaceBootstrapEventCursor(initialCursorState, thread.id),
    );

    expect(subscriptions[0]?.options).toEqual({ threadId: "thread-1" });
    subscriptions[0]?.deliver(event);

    const firstCursorState = helpers.retainWorkspaceSnapshotEventCursor(
      initialCursorState,
      thread.id,
      {
        cursor: "stream-response:7",
        threadId: thread.id,
      },
    );
    expect(firstCursorState).not.toBe(initialCursorState);
    const cursorState = firstCursorState;
    unsubscribe();
    unsubscribe = helpers.subscribeWorkspaceEventStream(
      apiClient,
      (nextEvent) => {
        thread = applyThreadRemoteEvents(thread, [nextEvent], { projection });
      },
      () => undefined,
      thread.id,
      helpers.workspaceBootstrapEventCursor(cursorState, thread.id),
    );

    expect(order).toEqual(["subscribe:1", "unsubscribe:1", "subscribe:2"]);
    expect(subscriptions[1]?.options).toEqual({
      cursor: "stream-response:7",
      threadId: "thread-1",
    });
    subscriptions[0]?.deliver(event);
    subscriptions[1]?.deliver(event);
    expect(thread.items).toEqual([
      expect.objectContaining({
        id: "assistant-1",
        kind: "assistant-message",
        text: "只出现一次",
      }),
    ]);

    const repeatedCursorState = helpers.retainWorkspaceSnapshotEventCursor(cursorState, thread.id, {
      cursor: "stream-response:8",
      threadId: thread.id,
    });
    expect(repeatedCursorState).toBe(cursorState);
    expect(subscriptions).toHaveLength(2);

    expect(
      helpers.retainWorkspaceSnapshotEventCursor(cursorState, "thread-2", {
        cursor: "stream-thread-2:3",
        threadId: "thread-2",
      }),
    ).toEqual({
      cursor: "stream-thread-2:3",
      threadId: "thread-2",
    });
    expect(helpers.workspaceBootstrapEventCursor(cursorState, "thread-2")).toBeUndefined();
    unsubscribe();
  });

  it("旧路由详情回调晚到时不能覆盖当前路由已经绑定的快照游标", () => {
    const activeThreadIdRef: { current: string | undefined } = { current: "thread-a" };
    let cursorState: AppStateModule.WorkspaceSnapshotEventCursor | undefined;
    const remember = (observed: AppStateModule.WorkspaceSnapshotEventCursor) => {
      cursorState = helpers.retainWorkspaceSnapshotEventCursorForCurrentRoute(
        cursorState,
        activeThreadIdRef,
        observed,
      );
    };
    const lateThreadACallback = () =>
      remember({
        cursor: "stream-a:9",
        threadId: "thread-a",
      });

    activeThreadIdRef.current = "thread-b";
    remember({
      cursor: "stream-b:4",
      threadId: "thread-b",
    });
    lateThreadACallback();

    expect(cursorState).toEqual({
      cursor: "stream-b:4",
      threadId: "thread-b",
    });
    expect(helpers.workspaceBootstrapEventCursor(cursorState, "thread-b")).toBe("stream-b:4");
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
      label: "实时更新中断",
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
      reason: "与电脑的实时更新已中断",
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

  it("诊断接口单次抖动不把已连通的输入器置灰，但过期快照必须失效", () => {
    const generatedAt = Date.parse("2026-07-31T12:00:00.000Z");
    const previous = {
      generatedAt: new Date(generatedAt).toISOString(),
      capabilities: { appServer: "available" as const },
    };
    const withinGrace = retainLastKnownDiagnosticSnapshot(undefined, previous, generatedAt + 1_000);
    const expired = retainLastKnownDiagnosticSnapshot(
      undefined,
      previous,
      generatedAt + DIAGNOSTICS_LAST_KNOWN_TTL_MS + 1,
    );

    expect(helpers.conversationControlState(true, withinGrace?.capabilities, false)).toEqual({
      available: true,
      reason: "",
    });
    expect(helpers.conversationControlState(true, expired?.capabilities, false)).toEqual({
      available: false,
      reason: "Codex 运行时兼容性待确认",
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

  it("托管任务断线时仍保留可编辑草稿，只禁用真正的远程操作", () => {
    expect(
      helpers.canShowThreadComposer(
        {
          mode: "managed",
          state: "idle",
          availableActions: {
            steer: false,
            interrupt: false,
            reply: true,
            changeModelNextTurn: true,
          },
        },
        false,
      ),
    ).toBe(true);
    expect(helpers.composerDraftReadOnly(true, false)).toBe(false);
    expect(helpers.composerDraftReadOnly(false, false)).toBe(true);
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
    expect(helpers.shouldShowConversationLoading(true, 10, false)).toBe(true);
    expect(helpers.shouldShowConversationLoading(true, 10, true)).toBe(false);
    expect(helpers.conversationPositionIsReady("thread-b", "thread-a")).toBe(false);
    expect(helpers.conversationPositionIsReady("thread-b", "thread-b")).toBe(true);
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

  it("空输入框可随交互收起，但草稿、附件、发送与打开面板会阻止隐式收起", () => {
    expect(helpers.composerExpandedAfterIntent("thread-change")).toBe(false);
    expect(helpers.composerExpandedAfterIntent("focus")).toBe(true);
    expect(helpers.composerExpandedAfterIntent("conversation-scroll")).toBe(false);
    expect(helpers.composerExpandedAfterIntent("blur")).toBe(false);
    expect(helpers.composerExpandedAfterIntent("submit")).toBe(false);
    expect(helpers.composerCanSafelyCollapse("", 0, false, false)).toBe(true);
    expect(helpers.composerCanSafelyCollapse("未发送草稿", 0, false, false)).toBe(false);
    expect(helpers.composerCanSafelyCollapse("", 1, false, false)).toBe(false);
    expect(helpers.composerCanSafelyCollapse("", 0, true, false)).toBe(false);
    expect(helpers.composerCanSafelyCollapse("", 0, false, true)).toBe(false);
    expect(helpers.composerExpandedAfterIntent("blur", false)).toBe(true);
    expect(helpers.composerExpandedAfterIntent("thread-change", false)).toBe(true);
  });

  it("收起时把多行草稿压成一行并明确省略剩余内容", () => {
    expect(helpers.collapsedComposerText("第一行\n\n第二行   第三段")).toBe(
      "第一行 第二行 第三段…",
    );
    expect(helpers.collapsedComposerText("单行短草稿")).toBe("单行短草稿");
    expect(helpers.collapsedComposerText("一二三四五六七八", 6)).toBe("一二三四五…");
    expect(helpers.collapsedComposerText("   \n  ")).toBe("");
  });

  it("重新展开输入框时把光标和输入区都放到草稿末尾", () => {
    const calls: Array<[number, number]> = [];
    const control = {
      focus: () => undefined,
      scrollHeight: 320,
      scrollTop: 0,
      setSelectionRange: (start: number, end: number) => calls.push([start, end]),
      value: "第一行\n第二行",
    };

    helpers.focusComposerControlAtEnd(control);

    expect(calls).toEqual([[control.value.length, control.value.length]]);
    expect(control.scrollTop).toBe(320);
  });

  it("把旧页插入现有对话顶部并去重，不改变当前运行控制状态", () => {
    const current = {
      id: "thread-1",
      title: "长对话",
      mode: "managed" as const,
      state: "running" as const,
      updatedAt: "2026-07-27T00:00:00.000Z",
      historyLoadPolicy: "explicit" as const,
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
      historyLoadPolicy: "explicit" as const,
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
    expect(helpers.composerActionVisibility(false, true, true)).toEqual({
      showInterrupt: false,
      showSubmit: true,
    });
    expect(helpers.composerActionVisibility(true, true, false, true)).toEqual({
      showInterrupt: false,
      showSubmit: true,
    });
  });

  it("运行控制链不可用时不保留一个点击后静默无效的停止按钮", () => {
    expect(helpers.composerActionVisibility(true, true, false, false, false)).toEqual({
      showInterrupt: false,
      showSubmit: false,
    });
  });

  it("停止确认超过有界轮询后返回可重试状态，而不是永久等待终态", async () => {
    const readActiveTurnId = vi.fn().mockResolvedValue("turn-still-running");
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      helpers.pollInterruptTerminal("turn-still-running", readActiveTurnId, {
        attempts: 3,
        wait,
      }),
    ).resolves.toEqual({ state: "still-active" });
    expect(readActiveTurnId).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("停止确认一旦观察到目标 turn 消失就立即结束轮询", async () => {
    const readActiveTurnId = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce("turn-stopping")
      .mockResolvedValueOnce(undefined);
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      helpers.pollInterruptTerminal("turn-stopping", readActiveTurnId, {
        attempts: 8,
        wait,
      }),
    ).resolves.toEqual({ state: "terminal" });
    expect(readActiveTurnId).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("停止确认从瞬时读取错误恢复后不会保留过时的失败提示", async () => {
    const readActiveTurnId = vi
      .fn<() => Promise<string | undefined>>()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue("turn-stopping");

    await expect(
      helpers.pollInterruptTerminal("turn-stopping", readActiveTurnId, {
        attempts: 2,
        wait: vi.fn().mockResolvedValue(undefined),
      }),
    ).resolves.toEqual({ state: "still-active" });
  });
});

describe("对话附件草稿恢复", () => {
  it("浏览器拒绝提供 localStorage 时不会让对话崩溃", () => {
    expect(helpers.readConversationAttachments(undefined, "thread-1")).toEqual([]);
    expect(() => helpers.writeConversationAttachments(undefined, "thread-1", [])).not.toThrow();
  });

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
