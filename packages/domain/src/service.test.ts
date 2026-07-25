import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CreateThreadInput } from "@codex-local-remote/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DomainError } from "./service.js";
import { RemoteEventBuffer } from "./events.js";
import { CodexDomainService, ProjectRegistry } from "./service.js";

const threadFixture = {
  canAcceptDirectInput: true,
  id: "thread-new",
  name: null,
  preview: "",
  parentThreadId: null,
  cwd: "C:\\workspace\\sample",
  createdAt: 1_721_000_000,
  updatedAt: 1_721_000_000,
  status: { type: "idle" },
  turns: [],
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

function createService(
  request: (method: string, params?: unknown) => Promise<unknown>,
  resolveRegisteredProjectRoot: (projectId: string) => Promise<string | undefined> = async (
    projectId,
  ) => (projectId === "project-1" ? "C:\\workspace\\sample" : undefined),
): CodexDomainService {
  return new CodexDomainService({
    gateway: {
      request: async <T = unknown>(method: string, params?: unknown): Promise<T> =>
        (await request(method, params)) as T,
    },
    projects: new ProjectRegistry([
      { id: "project-1", name: "示例项目", root: "C:\\workspace\\sample" },
    ]),
    resolveRegisteredProjectRoot,
  });
}

describe("CodexDomainService", () => {
  it("preserves app-server reasoning effort names without a stale local allowlist", async () => {
    const calls: unknown[] = [];
    const service = createService(async (method, params) => {
      if (method === "model/list") {
        calls.push(params);
        if ((params as { cursor?: string } | undefined)?.cursor === "models-2") {
          return {
            data: [
              {
                displayName: "Model B",
                defaultReasoningEffort: "ultra",
                isDefault: false,
                model: "model-b",
                supportedReasoningEfforts: [{ reasoningEffort: "ultra" }],
              },
            ],
          };
        }
        return {
          data: [
            {
              displayName: "Model",
              defaultReasoningEffort: "max",
              isDefault: true,
              model: "model-a",
              supportedReasoningEfforts: [{ reasoningEffort: "max" }],
            },
          ],
          nextCursor: "models-2",
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await expect(service.listModels()).resolves.toMatchObject({
      data: [
        { defaultReasoningEffort: "max", supportedReasoningEfforts: ["max"] },
        { defaultReasoningEffort: "ultra", supportedReasoningEfforts: ["ultra"] },
      ],
    });
    expect(calls).toHaveLength(2);
  });

  it("maps permission and collaboration choices to real app-server operations", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params });
      switch (method) {
        case "thread/start":
          return { thread: threadFixture, model: "model-a" };
        case "collaborationMode/list":
          return {
            data: [
              {
                name: "pair",
                mode: "default",
                model: "model-a",
                reasoning_effort: "high",
              },
            ],
          };
        case "thread/settings/update":
          return {};
        case "turn/start":
          return {
            turn: {
              id: "turn-new",
              status: "inProgress",
              startedAt: 1_721_000_001,
              items: [],
            },
          };
        default:
          throw new Error(`unexpected method ${method}`);
      }
    });
    const service = createService(request);
    const input: CreateThreadInput = {
      projectId: "project-1",
      prompt: "实现移动端首页",
      model: "model-a",
      reasoningEffort: "high",
      permissionMode: "ask",
      collaborationMode: "pair",
    };

    const result = await service.createThread(input);

    expect(calls[0]).toEqual({
      method: "thread/start",
      params: {
        approvalPolicy: "untrusted",
        cwd: "C:\\workspace\\sample",
        model: "model-a",
        sandbox: "workspace-write",
        threadSource: "codex-local-remote",
      },
    });
    expect(calls[2]).toEqual({
      method: "thread/settings/update",
      params: {
        collaborationMode: {
          mode: "default",
          settings: {
            developer_instructions: null,
            model: "model-a",
            reasoning_effort: "high",
          },
        },
        threadId: "thread-new",
      },
    });
    expect(calls[3]).toEqual({
      method: "turn/start",
      params: {
        effort: "high",
        input: [{ text: "实现移动端首页", text_elements: [], type: "text" }],
        model: "model-a",
        threadId: "thread-new",
      },
    });
    expect(result.degradations).toEqual([]);
    expect(result.data).toMatchObject({
      activeTurnId: "turn-new",
      id: "thread-new",
      model: "model-a",
      mode: "managed",
      reasoningEffort: "high",
      state: "running",
    });
  });

  it("continues with a normal turn when experimental collaboration is unavailable", async () => {
    const methods: string[] = [];
    const service = createService(async (method) => {
      methods.push(method);
      if (method === "thread/start") {
        return { thread: threadFixture, model: "model-a" };
      }
      if (method === "collaborationMode/list") {
        throw Object.assign(new Error("method missing"), { code: -32_601 });
      }
      if (method === "turn/start") {
        return {
          turn: { id: "turn-new", status: "inProgress", startedAt: 1_721_000_001, items: [] },
        };
      }
      return {};
    });

    const result = await service.createThread({
      collaborationMode: "pair",
      projectId: "project-1",
      prompt: "继续实现",
    });

    expect(methods).toEqual(["thread/start", "collaborationMode/list", "turn/start"]);
    expect(result.degradations).toEqual([
      {
        code: "feature-unavailable",
        feature: "collaboration-mode",
        message: "当前 Codex 版本不支持所选协作方式，已使用普通对话。",
      },
    ]);
  });

  it("rejects a changed registered root before thread creation and before the first turn", async () => {
    const noCalls = vi.fn(async () => ({}));
    const rejectedBeforeThread = createService(noCalls, async () => undefined);

    await expect(
      rejectedBeforeThread.createThread({ projectId: "project-1", prompt: "不能越界" }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_AUTHORIZED" } satisfies Partial<DomainError>);
    expect(noCalls).not.toHaveBeenCalled();

    let authorizationChecks = 0;
    const methods: string[] = [];
    const rejectedBeforeTurn = createService(
      async (method) => {
        methods.push(method);
        if (method === "thread/start") {
          return { thread: threadFixture };
        }
        throw new Error(`unexpected method ${method}`);
      },
      async () => {
        authorizationChecks += 1;
        return authorizationChecks === 1 ? "C:\\workspace\\sample" : undefined;
      },
    );

    await expect(
      rejectedBeforeTurn.createThread({ projectId: "project-1", prompt: "仍然不能越界" }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_AUTHORIZED" } satisfies Partial<DomainError>);
    expect(methods).toEqual(["thread/start"]);
  });

  it("rejects the next turn when a managed thread project root loses authorization", async () => {
    let rootAuthorized = true;
    const methods: string[] = [];
    const service = createService(
      async (method) => {
        methods.push(method);
        if (method === "thread/start") {
          return { thread: threadFixture };
        }
        if (method === "thread/read") {
          return { thread: threadFixture };
        }
        if (method === "turn/start") {
          return {
            turn: { id: "turn-new", status: "inProgress", startedAt: 1_721_000_001, items: [] },
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      async () => (rootAuthorized ? "C:\\workspace\\sample" : undefined),
    );
    await service.createThread({ projectId: "project-1", prompt: "第一轮" });
    service.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-new", turn: { id: "turn-new" } },
    });
    rootAuthorized = false;

    await expect(
      service.startTurn("thread-new", { prompt: "第二轮不能越界" }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_AUTHORIZED" } satisfies Partial<DomainError>);
    expect(methods).toEqual(["thread/start", "turn/start", "thread/read"]);
  });

  it("does not steer a desktop snapshot that this sidecar does not own", async () => {
    const service = createService(async () => ({}));

    await expect(service.steerTurn("desktop-thread", "turn-1", "补充要求")).rejects.toMatchObject({
      code: "THREAD_READ_ONLY",
    } satisfies Partial<DomainError>);
  });

  it("restores managed ownership and rebuilds the active turn from live thread state", async () => {
    const methods: string[] = [];
    const service = new CodexDomainService({
      gateway: {
        request: async <T = unknown>(method: string): Promise<T> => {
          methods.push(method);
          if (method === "thread/resume") {
            return {
              thread: {
                ...threadFixture,
                id: "thread-restored",
                status: { type: "active" },
                turns: [
                  {
                    id: "turn-live",
                    status: "inProgress",
                    startedAt: 1_721_000_001,
                    items: [],
                  },
                ],
              },
            } as T;
          }
          throw new Error(`unexpected method ${method}`);
        },
      },
      managedThreadIds: ["thread-restored"],
      projects: new ProjectRegistry([
        { id: "project-1", name: "示例项目", root: "C:\\workspace\\sample" },
      ]),
      resolveRegisteredProjectRoot: async () => "C:\\workspace\\sample",
    });

    expect(service.isManagedThread("thread-restored")).toBe(true);
    await expect(
      service.startTurn("thread-restored", { prompt: "不要重复启动" }),
    ).rejects.toMatchObject({ code: "TURN_CONTROL_LOST" } satisfies Partial<DomainError>);
    expect(methods).toEqual(["thread/resume"]);
  });

  it("hydrates an idle persisted managed thread before showing reply controls", async () => {
    const methods: string[] = [];
    const service = new CodexDomainService({
      gateway: {
        request: async <T = unknown>(method: string): Promise<T> => {
          methods.push(method);
          return {
            thread: {
              ...threadFixture,
              id: "thread-restored-idle",
              status: { type: "idle" },
            },
          } as T;
        },
      },
      managedThreadIds: ["thread-restored-idle"],
      projects: new ProjectRegistry([
        { id: "project-1", name: "示例项目", root: "C:\\workspace\\sample" },
      ]),
      resolveRegisteredProjectRoot: async () => "C:\\workspace\\sample",
    });

    await expect(service.getThread("thread-restored-idle")).resolves.toMatchObject({
      availableActions: { reply: true },
      mode: "managed",
    });
    expect(methods).toEqual(["thread/resume"]);
  });

  it("asks app-server for descendants across every source kind and preserves nested parents", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const service = createService(async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/read") {
        const threadId = (params as { threadId?: string } | undefined)?.threadId;
        if (threadId === "thread-root") {
          return {
            thread: {
              ...threadFixture,
              id: "thread-root",
              turns: [
                {
                  id: "turn-root",
                  items: [
                    {
                      agentPath: "/root/legacy-worker",
                      agentThreadId: "sub-legacy-source",
                      kind: "started",
                      type: "subAgentActivity",
                    },
                  ],
                },
              ],
            },
          };
        }
        return {
          thread: {
            ...threadFixture,
            id: threadId,
            parentThreadId: "thread-root",
          },
        };
      }
      return (params as { archived?: boolean } | undefined)?.archived === true
        ? {
            data: [
              {
                ...threadFixture,
                id: "sub-direct",
                parentThreadId: "thread-root",
              },
              {
                ...threadFixture,
                id: "sub-nested",
                parentThreadId: "sub-direct",
              },
            ],
          }
        : {
            data: [
              {
                ...threadFixture,
                id: "sub-direct",
                parentThreadId: "thread-root",
              },
            ],
          };
    });

    const subagents = await service.listSubagents("thread-root");

    expect(calls).toEqual([
      {
        method: "thread/list",
        params: {
          ancestorThreadId: "thread-root",
          archived: false,
          limit: 100,
          sortDirection: "desc",
          sortKey: "updated_at",
        },
      },
      {
        method: "thread/list",
        params: {
          ancestorThreadId: "thread-root",
          archived: true,
          limit: 100,
          sortDirection: "desc",
          sortKey: "updated_at",
        },
      },
      {
        method: "thread/read",
        params: { includeTurns: true, threadId: "thread-root" },
      },
      {
        method: "thread/read",
        params: { includeTurns: true, threadId: "sub-legacy-source" },
      },
    ]);
    expect(subagents.data).toMatchObject([
      { depth: 1, parentThreadId: "thread-root", threadId: "sub-direct" },
      { depth: 2, parentThreadId: "sub-direct", threadId: "sub-nested" },
      {
        depth: 1,
        parentThreadId: "thread-root",
        threadId: "sub-legacy-source",
        title: "/root/legacy-worker",
      },
    ]);
  });

  it("uses one opaque cursor to continue current and archived subagent streams", async () => {
    const calls: Array<{ archived?: boolean; cursor?: string }> = [];
    const service = createService(async (_method, params) => {
      const query = params as { archived?: boolean; cursor?: string };
      calls.push(query);
      if (query.cursor === "current-next") {
        return {
          data: [
            {
              ...threadFixture,
              id: "sub-current-older",
              parentThreadId: "thread-root",
            },
          ],
        };
      }
      if (query.cursor === "archived-next") {
        return {
          data: [
            {
              ...threadFixture,
              id: "sub-archived-older",
              parentThreadId: "thread-root",
            },
          ],
        };
      }
      return query.archived === true
        ? {
            data: [
              {
                ...threadFixture,
                id: "sub-archived",
                parentThreadId: "thread-root",
              },
            ],
            nextCursor: "archived-next",
          }
        : {
            data: [
              {
                ...threadFixture,
                id: "sub-current",
                parentThreadId: "thread-root",
              },
            ],
            nextCursor: "current-next",
          };
    });

    const first = await service.listSubagents("thread-root", { limit: 1 });

    expect(first.data.map((subagent) => subagent.threadId)).toEqual([
      "sub-current",
      "sub-archived",
    ]);
    expect(first.nextCursor).toMatch(/^clr-subagents-v1\./u);
    const nextCursor = first.nextCursor;
    if (!nextCursor) {
      throw new Error("expected a composite subagent cursor");
    }

    const second = await service.listSubagents("thread-root", {
      cursor: nextCursor,
      limit: 1,
    });

    expect(second.data.map((subagent) => subagent.threadId)).toEqual([
      "sub-current-older",
      "sub-archived-older",
    ]);
    expect(second.nextCursor).toBeUndefined();
    expect(calls.slice(-2)).toMatchObject([
      { archived: false, cursor: "current-next" },
      { archived: true, cursor: "archived-next" },
    ]);
  });

  it("keeps discovered workspaces read-only and rejects sensitive absolute path segments", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-remote-projects-"));
    temporaryDirectories.push(temporary);
    const safeRoot = path.join(temporary, "existing-project");
    const sensitiveRoots = [
      path.join(temporary, ".ssh"),
      path.join(temporary, ".codex"),
      path.join(temporary, ".git"),
      path.join(temporary, "nested", "node_modules", "package"),
    ];
    await mkdir(safeRoot, { recursive: true });
    for (const sensitiveRoot of sensitiveRoots) {
      await mkdir(sensitiveRoot, { recursive: true });
    }
    const canonicalSafeRoot = await realpath(safeRoot);
    const requests: Array<{ method: string; params?: unknown }> = [];
    const service = new CodexDomainService({
      gateway: {
        request: async <T = unknown>(method: string, params?: unknown): Promise<T> => {
          requests.push({ method, params });
          if ((params as { archived?: boolean } | undefined)?.archived !== true) {
            return { data: [] } as T;
          }
          return {
            data: [
              { ...threadFixture, cwd: safeRoot, id: "safe-thread" },
              { ...threadFixture, cwd: safeRoot, id: "safe-duplicate" },
              ...sensitiveRoots.map((cwd, index) => ({
                ...threadFixture,
                cwd,
                id: `sensitive-thread-${index}`,
              })),
              { ...threadFixture, cwd: ".\\relative", id: "relative-thread" },
              { ...threadFixture, cwd: path.parse(safeRoot).root, id: "root-thread" },
              {
                ...threadFixture,
                cwd: safeRoot,
                id: "nested-thread",
                parentThreadId: "safe-thread",
              },
            ],
          } as T;
        },
      },
      projects: new ProjectRegistry(),
      resolveRegisteredProjectRoot: async () => undefined,
    });

    const projects = await service.listProjects();

    expect(projects).toEqual([
      expect.objectContaining({
        rootLabel: "existing-project",
        source: "thread",
      }),
    ]);
    expect(projects[0]?.id).toBeDefined();
    expect(service.projects.requireRoot(projects[0]?.id ?? "")).toBe(canonicalSafeRoot);
    expect(() => service.projects.requireRegisteredRoot(projects[0]?.id ?? "")).toThrow(
      "尚未在电脑本机登记",
    );
    await expect(
      service.createThread({
        projectId: projects[0]?.id ?? "",
        prompt: "这个调用不应到达 app-server",
      }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_AUTHORIZED" } satisfies Partial<DomainError>);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      method: "thread/list",
      params: {
        archived: false,
        limit: 100,
        sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
      },
    });
    expect(requests[1]).toMatchObject({
      method: "thread/list",
      params: {
        archived: true,
        limit: 100,
        sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
      },
    });
  });

  it("aggregates paginated thread history for the array-based browser contract", async () => {
    const calls: unknown[] = [];
    const service = createService(async (_method, params) => {
      calls.push(params);
      const cursor = (params as { cursor?: string } | undefined)?.cursor;
      return cursor === "page-2"
        ? {
            data: [{ ...threadFixture, id: "thread-older", updatedAt: 1_721_000_000 }],
          }
        : {
            data: [{ ...threadFixture, id: "thread-newer", updatedAt: 1_721_000_100 }],
            nextCursor: "page-2",
          };
    });

    const result = await service.listThreads();

    expect(result.data.map((thread) => thread.id)).toEqual(["thread-newer", "thread-older"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ archived: false, limit: 100 });
    expect(calls[1]).toMatchObject({ cursor: "page-2", limit: 100 });
  });

  it("keeps archived history on an explicit independent cursor stream", async () => {
    const calls: unknown[] = [];
    const service = createService(async (_method, params) => {
      calls.push(params);
      return {
        data: [{ ...threadFixture, id: "thread-archived" }],
        nextCursor: "archived-next",
      };
    });

    const result = await service.listThreads({
      archived: true,
      cursor: "archived-current",
      limit: 25,
    });

    expect(calls).toEqual([
      {
        archived: true,
        cursor: "archived-current",
        limit: 25,
        sortDirection: "desc",
        sortKey: "updated_at",
      },
    ]);
    expect(result).toMatchObject({
      data: [{ archived: true, id: "thread-archived" }],
      nextCursor: "archived-next",
    });
  });

  it("updates live thread settings and events when app-server reroutes a model", async () => {
    const events = new RemoteEventBuffer(8);
    const service = new CodexDomainService({
      events,
      gateway: {
        request: async <T = unknown>(method: string): Promise<T> => {
          if (method !== "thread/read") {
            throw new Error(`unexpected method ${method}`);
          }
          return { thread: threadFixture } as T;
        },
      },
      projects: new ProjectRegistry([
        { id: "project-1", name: "示例项目", root: "C:\\workspace\\sample" },
      ]),
      resolveRegisteredProjectRoot: async () => "C:\\workspace\\sample",
    });

    service.handleNotification({
      method: "model/rerouted",
      params: {
        fromModel: "model-a",
        reason: "capacity",
        threadId: "thread-new",
        toModel: "model-b",
        turnId: "turn-new",
      },
    });

    await expect(service.getThread("thread-new")).resolves.toMatchObject({
      id: "thread-new",
      model: "model-b",
    });
    expect(events.replayAfter(0).events).toEqual([
      expect.objectContaining({
        payload: { model: "model-b", reason: "model-rerouted" },
        threadId: "thread-new",
        type: "thread.updated",
      }),
      expect.objectContaining({
        threadId: "thread-new",
        type: "diagnostic",
      }),
    ]);
  });

  it("clears a cached reasoning effort when app-server explicitly resets it to null", async () => {
    const service = createService(async (method) => {
      if (method !== "thread/read") {
        throw new Error(`unexpected method ${method}`);
      }
      return { thread: threadFixture };
    });
    service.handleNotification({
      method: "thread/settings/updated",
      params: {
        threadId: "thread-new",
        threadSettings: { effort: "high", model: "model-a" },
      },
    });
    await expect(service.getThread("thread-new")).resolves.toMatchObject({
      model: "model-a",
      reasoningEffort: "high",
    });

    service.handleNotification({
      method: "thread/settings/updated",
      params: {
        threadId: "thread-new",
        threadSettings: { effort: null, model: "model-a" },
      },
    });
    const reset = await service.getThread("thread-new");
    expect(reset.model).toBe("model-a");
    expect(reset.reasoningEffort).toBeUndefined();
  });

  it("projects account token history and credits from schema-native usage responses", async () => {
    const service = createService(async (method) => {
      if (method === "account/read") {
        return { account: { planType: "plus" } };
      }
      if (method === "account/rateLimits/read") {
        return {
          rateLimitsByLimitId: {
            codex: {
              credits: {
                balance: "12.50",
                hasCredits: true,
                unlimited: false,
              },
              limitId: "codex",
              limitName: "Codex",
              primary: { resetsAt: 1_721_000_000, usedPercent: 25 },
              secondary: null,
            },
          },
        };
      }
      if (method === "account/usage/read") {
        return {
          dailyUsageBuckets: [
            { startDate: "2026-07-24", tokens: 1200 },
            { startDate: "2026-07-25", tokens: "3400" },
          ],
          summary: {
            currentStreakDays: 2,
            lifetimeTokens: "12345678901234567890",
            longestRunningTurnSec: 90,
            longestStreakDays: 7,
            peakDailyTokens: 3400,
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const result = await service.getUsage();

    expect(result.degradations).toEqual([]);
    expect(result.data).toMatchObject({
      credits: [
        {
          balance: "12.50",
          hasCredits: true,
          id: "codex",
          label: "Codex",
          unlimited: false,
        },
      ],
      dailyUsageBuckets: [
        { startDate: "2026-07-24", tokens: "1200" },
        { startDate: "2026-07-25", tokens: "3400" },
      ],
      plan: "plus",
      tokenUsageSummary: {
        currentStreakDays: 2,
        lifetimeTokens: "12345678901234567890",
        longestRunningTurnSec: 90,
        longestStreakDays: 7,
        peakDailyTokens: "3400",
      },
      windows: [
        {
          id: "codex-primary",
          label: "Codex · 当前周期",
          remainingPercent: 75,
          resetsAt: "2024-07-14T23:33:20.000Z",
          usedPercent: 25,
        },
      ],
    });
    expect(typeof result.data.updatedAt).toBe("string");
  });

  it("keeps quota and credits available when account usage history independently fails", async () => {
    const service = createService(async (method) => {
      if (method === "account/read") {
        return { account: { planType: "plus" } };
      }
      if (method === "account/rateLimits/read") {
        return {
          rateLimits: {
            credits: { balance: null, hasCredits: true, unlimited: true },
            limitId: "codex",
            limitName: "Codex",
            primary: { resetsAt: null, usedPercent: 10 },
            secondary: null,
          },
          rateLimitsByLimitId: null,
        };
      }
      if (method === "account/usage/read") {
        throw new Error("optional method unavailable");
      }
      throw new Error(`unexpected method ${method}`);
    });

    const result = await service.getUsage();

    expect(result.data).toMatchObject({
      credits: [{ hasCredits: true, id: "codex", unlimited: true }],
      plan: "plus",
      windows: [{ id: "codex-primary", usedPercent: 10 }],
    });
    expect(result.data.tokenUsageSummary).toBeUndefined();
    expect(result.data.dailyUsageBuckets).toBeUndefined();
    expect(result.degradations).toEqual([
      {
        code: "temporarily-unavailable",
        feature: "usage",
        message: "累计与每日用量暂时不可用。",
      },
    ]);
  });

  it("keeps token context scoped to its thread and never guesses without a thread id", async () => {
    const service = createService(async (method) => {
      if (method === "account/read") {
        return { account: { planType: "plus" } };
      }
      if (method === "account/rateLimits/read") {
        return { rateLimitsByLimitId: {} };
      }
      throw new Error(`unexpected method ${method}`);
    });
    service.handleNotification({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        tokenUsage: {
          last: { totalTokens: 25 },
          modelContextWindow: 100,
          total: { totalTokens: 250 },
        },
        turnId: "turn-1",
      },
    });
    service.handleNotification({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-2",
        tokenUsage: {
          last: { totalTokens: 150 },
          modelContextWindow: 200,
          total: { totalTokens: 900 },
        },
        turnId: "turn-2",
      },
    });

    await expect(service.getUsage("thread-1")).resolves.toMatchObject({
      data: {
        context: { limitTokens: 100, usedPercent: 25, usedTokens: 25 },
      },
    });
    const accountOnlyUsage = await service.getUsage();
    expect(accountOnlyUsage.data.context).toBeUndefined();
  });
});
