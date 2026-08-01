import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  ConversationItem,
  CreateThreadInput,
  LocalInputReference,
  PersistedConversationHistoryScope,
  PersistedConversationReadResult,
  ThreadSettingsInput,
  UsageSnapshot,
} from "@codex-local-remote/contracts";
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

function deferred<T>() {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

function adaptLegacyHistoryRequest(
  request: (method: string, params?: unknown) => Promise<unknown>,
): <T = unknown>(method: string, params?: unknown) => Promise<T> {
  const shellReads = new Map<string, Promise<unknown>>();
  return async <T = unknown>(method: string, params?: unknown): Promise<T> => {
    const threadId = (params as { threadId?: string } | undefined)?.threadId;
    if (method === "thread/turns/list" && threadId) {
      const shell =
        shellReads.get(threadId) ??
        Promise.resolve(
          request("thread/read", {
            includeTurns: false,
            threadId,
          }),
        );
      const response = (await shell) as {
        thread?: {
          turns?: unknown[];
        };
      };
      return { data: response.thread?.turns ?? [] } as T;
    }
    if (method === "thread/read" && threadId) {
      const shell = Promise.resolve(request(method, params));
      shellReads.set(threadId, shell);
      return (await shell) as T;
    }
    return (await request(method, params)) as T;
  };
}

function createService(
  request: (method: string, params?: unknown) => Promise<unknown>,
  resolveRegisteredProjectRoot: (projectId: string) => Promise<string | undefined> = async (
    projectId,
  ) => (projectId === "project-1" ? "C:\\workspace\\sample" : undefined),
  notifyManagedThreadCreated?: (threadId: string) => void | Promise<void>,
  options: {
    archiveCleanupRetryDelaysMs?: number[];
    archiveIntents?: Iterable<{
      desktopNotificationPending: boolean;
      managed: boolean;
      targetArchived: boolean;
      threadId: string;
    }>;
    beginArchiveIntent?: (
      threadId: string,
      targetArchived: boolean,
    ) => Promise<{
      desktopNotificationPending: boolean;
      managed: boolean;
      targetArchived: boolean;
      threadId: string;
    }>;
    events?: RemoteEventBuffer;
    generalConversationRoot?: string;
    listPinnedThreadIds?: () => Promise<readonly string[]>;
    managedThreadIds?: Iterable<string>;
    protocolCatalog?: {
      approvalPolicies?: readonly string[];
      approvalReviewers?: readonly string[];
      clientMethods?: readonly string[];
    };
    readPersistedUsageContext?: (
      threadId: string,
      sessionPath?: string,
    ) => Promise<NonNullable<UsageSnapshot["context"]> | undefined>;
    readPersistedConversationItems?: (
      threadId: string,
      sessionPath?: string,
      scope?: PersistedConversationHistoryScope,
    ) => Promise<ConversationItem[] | PersistedConversationReadResult>;
    readPersistedRuntimeSettings?: (
      threadId: string,
      sessionPath?: string,
    ) => Promise<ThreadSettingsInput | undefined>;
    readPersistedThreadHead?: (
      threadId: string,
      sessionPath?: string,
    ) => Promise<{ activeTurnId?: string; sourceBytes: number } | undefined>;
    persistManagedThread?: (
      threadId: string,
      options: { desktopNotificationPending: boolean },
    ) => Promise<void>;
    unpersistManagedThread?: (threadId: string) => Promise<void>;
    resolveLocalInputReference?: (reference: LocalInputReference) => Promise<{
      kind: "file" | "directory";
      name: string;
      path: string;
    }>;
    sharedAppServer?: boolean;
    sharedResumeDelaysMs?: number[];
    settleArchiveIntent?: (threadId: string, observedArchived: boolean) => Promise<void>;
  } = {},
): CodexDomainService {
  // Most pre-pagination fixtures expose their turns on thread/read. Adapt those
  // fixtures to the bounded turn-page contract so legacy unit setup does not
  // accidentally require the production unbounded-history path.
  const adaptLegacyHistoryFixture = options.protocolCatalog === undefined;
  const adaptedRequest = adaptLegacyHistoryFixture
    ? adaptLegacyHistoryRequest(request)
    : async <T = unknown>(method: string, params?: unknown): Promise<T> =>
        (await request(method, params)) as T;
  return new CodexDomainService({
    ...(options.archiveCleanupRetryDelaysMs === undefined
      ? {}
      : { archiveCleanupRetryDelaysMs: options.archiveCleanupRetryDelaysMs }),
    ...(options.archiveIntents === undefined ? {} : { archiveIntents: options.archiveIntents }),
    ...(options.beginArchiveIntent === undefined
      ? {}
      : { beginArchiveIntent: options.beginArchiveIntent }),
    gateway: {
      request: adaptedRequest,
    },
    ...(options.events === undefined ? {} : { events: options.events }),
    ...(options.managedThreadIds === undefined
      ? {}
      : { managedThreadIds: options.managedThreadIds }),
    ...(notifyManagedThreadCreated === undefined ? {} : { notifyManagedThreadCreated }),
    ...(options.sharedAppServer === undefined ? {} : { sharedAppServer: options.sharedAppServer }),
    ...(options.sharedResumeDelaysMs === undefined
      ? {}
      : { sharedResumeDelaysMs: options.sharedResumeDelaysMs }),
    ...(options.settleArchiveIntent === undefined
      ? {}
      : { settleArchiveIntent: options.settleArchiveIntent }),
    ...(options.generalConversationRoot === undefined
      ? {}
      : { generalConversationRoot: options.generalConversationRoot }),
    ...(options.listPinnedThreadIds === undefined
      ? {}
      : { listPinnedThreadIds: options.listPinnedThreadIds }),
    protocolCatalog:
      options.protocolCatalog ??
      ({
        clientMethods: ["thread/turns/list"],
      } as const),
    ...(options.readPersistedUsageContext === undefined
      ? {}
      : { readPersistedUsageContext: options.readPersistedUsageContext }),
    ...(options.readPersistedConversationItems === undefined
      ? {}
      : { readPersistedConversationItems: options.readPersistedConversationItems }),
    ...(options.readPersistedRuntimeSettings === undefined
      ? {}
      : { readPersistedRuntimeSettings: options.readPersistedRuntimeSettings }),
    ...(options.readPersistedThreadHead === undefined
      ? {}
      : { readPersistedThreadHead: options.readPersistedThreadHead }),
    ...(options.persistManagedThread === undefined
      ? {}
      : { persistManagedThread: options.persistManagedThread }),
    ...(options.unpersistManagedThread === undefined
      ? {}
      : { unpersistManagedThread: options.unpersistManagedThread }),
    ...(options.resolveLocalInputReference === undefined
      ? {}
      : { resolveLocalInputReference: options.resolveLocalInputReference }),
    projects: new ProjectRegistry([
      { id: "project-1", name: "示例项目", root: "C:\\workspace\\sample" },
    ]),
    resolveRegisteredProjectRoot,
  });
}

describe("CodexDomainService", () => {
  it("matches registered Windows projects when app-server returns an extended-length cwd", () => {
    const registry = new ProjectRegistry([
      { id: "fixture", name: "Fixture", root: "Q:\\FixtureRoot" },
    ]);

    expect(registry.findIdByCwd("\\\\?\\Q:\\FixtureRoot")).toBe("fixture");
    expect(registry.findIdByCwd("\\\\?\\q:\\FIXTUREROOT\\")).toBe("fixture");
  });

  it("treats native Desktop scratch directories as controllable non-project conversations", async () => {
    const scratchRoot = path.win32.join(
      os.homedir(),
      "Documents",
      "Codex",
      "2026-07-26",
      "new-chat",
    );
    const desktopThread = {
      ...threadFixture,
      cwd: `\\\\?\\${scratchRoot}`,
      id: "desktop-native-scratch",
    };
    const service = createService(async (method) => {
      if (method === "thread/resume") return { thread: desktopThread };
      throw new Error(`unexpected method ${method}`);
    });

    const resumed = await service.resumeThread(desktopThread.id);
    expect(resumed).toMatchObject({
      id: desktopThread.id,
      mode: "managed",
    });
    expect(resumed.projectId).toBeUndefined();
  });

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
              defaultServiceTier: "standard",
              defaultReasoningEffort: "max",
              isDefault: true,
              model: "model-a",
              serviceTiers: [
                {
                  description: "更低延迟",
                  id: "fast",
                  name: "快速",
                },
                {
                  description: "标准速度",
                  id: "standard",
                  name: "标准",
                },
              ],
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
        {
          defaultReasoningEffort: "max",
          defaultServiceTier: "standard",
          serviceTiers: [
            { description: "更低延迟", displayName: "快速", id: "fast" },
            { description: "标准速度", displayName: "标准", id: "standard" },
          ],
          supportedReasoningEfforts: ["max"],
        },
        { defaultReasoningEffort: "ultra", supportedReasoningEfforts: ["ultra"] },
      ],
    });
    expect(calls).toHaveLength(2);
  });

  it("stops model pagination when a future runtime repeats its cursor", async () => {
    const calls: unknown[] = [];
    const service = createService(async (method, params) => {
      if (method !== "model/list") {
        throw new Error(`unexpected method ${method}`);
      }
      calls.push(params);
      return {
        data: [
          {
            displayName: "Spark",
            model: "gpt-5.3-codex-spark",
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
          },
        ],
        nextCursor: "repeated-model-cursor",
      };
    });

    await expect(service.listModels()).resolves.toMatchObject({
      data: [{ id: "gpt-5.3-codex-spark" }],
      degradations: [{ feature: "models" }],
    });
    expect(calls).toHaveLength(2);
  });

  it("lists thread-scoped permission profiles as open server-defined identifiers", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/read") {
          return {
            thread: {
              ...threadFixture,
              cwd: "C:\\workspace\\sample",
              status: { type: "idle" },
            },
          };
        }
        if (method === "permissionProfile/list") {
          if ((params as { cursor?: string }).cursor === "profiles-2") {
            return {
              data: [
                {
                  allowed: true,
                  description: "来自未来 Codex 的自定义权限",
                  id: "future-custom-profile",
                },
              ],
            };
          }
          return {
            data: [
              { allowed: true, description: "工作区写入", id: ":workspace" },
              { allowed: false, description: "被组织策略禁用", id: ":full-disk" },
            ],
            nextCursor: "profiles-2",
          };
        }
        if (method === "thread/resume") {
          return {
            thread: {
              ...threadFixture,
              canAcceptDirectInput: true,
              status: { type: "idle" },
            },
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      async () => "C:\\workspace\\sample",
      undefined,
      { managedThreadIds: ["thread-new"], sharedAppServer: true },
    );

    await expect(service.listPermissionProfiles({ threadId: "thread-new" })).resolves.toMatchObject(
      {
        data: [
          { allowed: true, description: "工作区写入", id: ":workspace" },
          { allowed: false, description: "被组织策略禁用", id: ":full-disk" },
          {
            allowed: true,
            description: "来自未来 Codex 的自定义权限",
            id: "future-custom-profile",
          },
        ],
      },
    );
    expect(calls.filter((call) => call.method === "permissionProfile/list")).toEqual([
      {
        method: "permissionProfile/list",
        params: { cwd: "C:\\workspace\\sample", limit: 100 },
      },
      {
        method: "permissionProfile/list",
        params: { cursor: "profiles-2", cwd: "C:\\workspace\\sample", limit: 100 },
      },
    ]);
  });

  it("lists approval reviewers only from config requirements without a built-in fallback", async () => {
    const service = createService(async (method) => {
      if (method === "configRequirements/read") {
        return {
          requirements: {
            allowedApprovalsReviewers: ["user", "future-reviewer", "future-reviewer"],
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await expect(service.listApprovalReviewers()).resolves.toEqual({
      data: [{ id: "user" }, { id: "future-reviewer" }],
      degradations: [],
    });

    const noCatalog = createService(async (method) => {
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      throw new Error(`unexpected method ${method}`);
    });
    await expect(noCatalog.listApprovalReviewers()).resolves.toMatchObject({
      data: [],
      degradations: [{ feature: "approval-reviewer" }],
    });
  });

  it("uses the current Codex protocol catalog when config requirements are unrestricted", async () => {
    const service = createService(
      async (method) => {
        if (method === "configRequirements/read") {
          return {
            requirements: {
              allowedApprovalPolicies: null,
              allowedApprovalsReviewers: null,
            },
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        protocolCatalog: {
          approvalPolicies: ["untrusted", "on-request", "never", "future-policy"],
          approvalReviewers: ["user", "auto_review", "future-reviewer"],
        },
      },
    );

    await expect(service.listApprovalPolicies()).resolves.toEqual({
      data: [{ id: "untrusted" }, { id: "on-request" }, { id: "never" }, { id: "future-policy" }],
      degradations: [],
    });
    await expect(service.listApprovalReviewers()).resolves.toEqual({
      data: [{ id: "user" }, { id: "auto_review" }, { id: "future-reviewer" }],
      degradations: [],
    });
  });

  it("updates dynamic next-turn settings without pretending to change the active turn", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const activeThread = {
      ...threadFixture,
      id: "thread-settings",
      status: { activeFlags: [], type: "active" },
      turns: [
        {
          id: "turn-active",
          items: [],
          status: "inProgress",
        },
      ],
    };
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/resume" || method === "thread/read") {
          return { thread: activeThread };
        }
        if (method === "permissionProfile/list") {
          return {
            data: [
              {
                allowed: true,
                description: "动态完全访问",
                id: "future-full-access",
              },
            ],
          };
        }
        if (method === "configRequirements/read") {
          return {
            requirements: {
              allowedApprovalPolicies: ["future-policy"],
              allowedApprovalsReviewers: ["future-reviewer"],
            },
          };
        }
        if (method === "collaborationMode/list") {
          return {
            data: [
              {
                mode: "plan",
                model: "server-default",
                name: "future-plan",
                reasoning_effort: "medium",
              },
            ],
          };
        }
        if (method === "thread/settings/update") {
          return {};
        }
        throw new Error(`unexpected method ${method}`);
      },
      async () => "C:\\workspace\\sample",
      undefined,
      {
        managedThreadIds: ["thread-settings"],
        sharedAppServer: true,
        sharedResumeDelaysMs: [0],
      },
    );

    await service.updateThreadSettings("thread-settings", {
      approvalPolicy: "future-policy",
      approvalsReviewer: "future-reviewer",
      collaborationMode: "future-plan",
      model: "future-model",
      permissionProfileId: "future-full-access",
      reasoningEffort: "future-effort",
      serviceTier: "future-speed",
    });

    expect(calls.at(-1)).toEqual({
      method: "thread/settings/update",
      params: {
        approvalPolicy: "future-policy",
        approvalsReviewer: "future-reviewer",
        collaborationMode: {
          mode: "plan",
          settings: {
            developer_instructions: null,
            model: "future-model",
            reasoning_effort: "future-effort",
          },
        },
        effort: "future-effort",
        model: "future-model",
        permissions: "future-full-access",
        serviceTier: "future-speed",
        threadId: "thread-settings",
      },
    });
    expect(calls.some((call) => call.method === "turn/interrupt")).toBe(false);
    expect(calls.some((call) => call.method === "turn/start")).toBe(false);
  });

  it("uses the live thread model when explicitly switching collaboration back to Default", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const defaultThread = {
      ...threadFixture,
      id: "thread-default-mode",
      model: "gpt-5.3-codex-spark",
      reasoningEffort: "xhigh",
    };
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/resume" || method === "thread/read") {
          return { thread: defaultThread };
        }
        if (method === "collaborationMode/list") {
          return { data: [{ mode: "default", name: "Default" }] };
        }
        if (method === "thread/settings/update") return {};
        throw new Error(`unexpected method ${method}`);
      },
      async () => "C:\\workspace\\sample",
      undefined,
      {
        managedThreadIds: ["thread-default-mode"],
        sharedAppServer: true,
        sharedResumeDelaysMs: [0],
      },
    );

    await service.updateThreadSettings("thread-default-mode", {
      collaborationMode: "Default",
    });

    expect(calls.at(-1)).toEqual({
      method: "thread/settings/update",
      params: {
        collaborationMode: {
          mode: "default",
          settings: {
            developer_instructions: null,
            model: "gpt-5.3-codex-spark",
            reasoning_effort: "xhigh",
          },
        },
        threadId: "thread-default-mode",
      },
    });
  });

  it("round-trips the native thread goal without inventing missing budget data", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/resume" || method === "thread/read") {
          return { thread: { ...threadFixture, id: "thread-goal" } };
        }
        if (method === "thread/goal/get") {
          return {
            goal: {
              createdAt: 1_721_000_000,
              objective: "把实时三端验收做完",
              status: "active",
              threadId: "thread-goal",
              timeUsedSeconds: 42,
              tokenBudget: null,
              tokensUsed: 1234,
              updatedAt: 1_721_000_100,
            },
          };
        }
        if (method === "thread/goal/set" || method === "thread/goal/clear") {
          return {};
        }
        throw new Error(`unexpected method ${method}`);
      },
      async () => "C:\\workspace\\sample",
      undefined,
      {
        managedThreadIds: ["thread-goal"],
        sharedAppServer: true,
        sharedResumeDelaysMs: [0],
      },
    );

    await expect(service.getThreadGoal("thread-goal")).resolves.toEqual({
      createdAt: "2024-07-14T23:33:20.000Z",
      objective: "把实时三端验收做完",
      status: "active",
      threadId: "thread-goal",
      timeUsedSeconds: 42,
      tokensUsed: 1234,
      updatedAt: "2024-07-14T23:35:00.000Z",
    });
    await service.setThreadGoal("thread-goal", {
      objective: "继续完成真实验收",
      tokenBudget: 50_000,
    });
    await service.setThreadGoal("thread-goal", { status: "paused" });
    await service.clearThreadGoal("thread-goal");
    expect(calls).toContainEqual({
      method: "thread/goal/set",
      params: {
        objective: "继续完成真实验收",
        threadId: "thread-goal",
        tokenBudget: 50_000,
      },
    });
    expect(calls).toContainEqual({
      method: "thread/goal/set",
      params: {
        status: "paused",
        threadId: "thread-goal",
      },
    });
    expect(calls.at(-1)).toEqual({
      method: "thread/goal/clear",
      params: { threadId: "thread-goal" },
    });
  });

  it("sends one idle next turn with its dynamic model, speed, permission, reviewer, and mode snapshot", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const idleThread = {
      ...threadFixture,
      id: "thread-dynamic-turn",
      status: { type: "idle" },
    };
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/resume" || method === "thread/read") {
          return { thread: idleThread };
        }
        if (method === "permissionProfile/list") {
          return {
            data: [{ allowed: true, id: "future-profile" }],
          };
        }
        if (method === "configRequirements/read") {
          return {
            requirements: {
              allowedApprovalPolicies: ["future-policy"],
              allowedApprovalsReviewers: ["future-reviewer"],
            },
          };
        }
        if (method === "collaborationMode/list") {
          return {
            data: [{ mode: "plan", model: null, name: "future-plan", reasoning_effort: null }],
          };
        }
        if (method === "turn/start") {
          return {
            turn: {
              id: "turn-dynamic",
              items: [],
              status: "inProgress",
            },
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      async () => "C:\\workspace\\sample",
      undefined,
      {
        managedThreadIds: ["thread-dynamic-turn"],
        sharedAppServer: true,
        sharedResumeDelaysMs: [0],
      },
    );

    await service.startTurn("thread-dynamic-turn", {
      approvalPolicy: "future-policy",
      approvalsReviewer: "future-reviewer",
      clientUserMessageId: "client-dynamic-turn",
      collaborationMode: "future-plan",
      model: "future-model",
      permissionProfileId: "future-profile",
      prompt: "使用当前动态能力开始下一轮",
      reasoningEffort: "future-effort",
      serviceTier: "future-speed",
    });

    expect(calls.at(-1)).toEqual({
      method: "turn/start",
      params: {
        approvalPolicy: "future-policy",
        approvalsReviewer: "future-reviewer",
        clientUserMessageId: "client-dynamic-turn",
        collaborationMode: {
          mode: "plan",
          settings: {
            developer_instructions: null,
            model: "future-model",
            reasoning_effort: "future-effort",
          },
        },
        effort: "future-effort",
        input: [
          {
            text: "使用当前动态能力开始下一轮",
            text_elements: [],
            type: "text",
          },
        ],
        model: "future-model",
        permissions: "future-profile",
        serviceTier: "future-speed",
        threadId: "thread-dynamic-turn",
      },
    });
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
                model: "model-default",
                reasoning_effort: "low",
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

  it("resolves project files and folders into native app-server inputs", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const resolveLocalInputReference = vi.fn(async (reference: LocalInputReference) => ({
      kind: reference.kind,
      name: path.win32.basename(reference.relativePath),
      path: path.win32.join("C:\\workspace\\sample", reference.relativePath),
    }));
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/start") return { thread: threadFixture };
        if (method === "turn/start") {
          return {
            turn: { id: "turn-with-files", status: "inProgress", items: [] },
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { resolveLocalInputReference },
    );

    await service.createThread({
      attachments: [
        {
          kind: "file",
          projectId: "project-1",
          relativePath: "screenshots/mobile.png",
        },
        {
          kind: "directory",
          projectId: "project-1",
          relativePath: "apps/web/src",
        },
      ],
      projectId: "project-1",
      prompt: "检查这些内容",
    });

    expect(resolveLocalInputReference).toHaveBeenCalledTimes(2);
    expect(calls.find((call) => call.method === "turn/start")).toEqual({
      method: "turn/start",
      params: {
        input: [
          { text: "检查这些内容", text_elements: [], type: "text" },
          { path: "C:\\workspace\\sample\\screenshots\\mobile.png", type: "localImage" },
          {
            name: "src",
            path: "C:\\workspace\\sample\\apps\\web\\src",
            type: "mention",
          },
        ],
        threadId: "thread-new",
      },
    });
  });

  it("allows a browser-uploaded file in a non-project conversation", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const resolveLocalInputReference = vi.fn(async () => ({
      kind: "file" as const,
      name: "phone-note.txt",
      path: "C:\\remote-data\\BrowserUploads\\upload\\phone-note.txt",
    }));
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/start") {
          return {
            thread: {
              ...threadFixture,
              cwd: "C:\\remote-data\\RemoteConversations",
            },
          };
        }
        if (method === "turn/start") {
          return {
            turn: { id: "turn-with-upload", status: "inProgress", items: [] },
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        generalConversationRoot: "C:\\remote-data\\RemoteConversations",
        resolveLocalInputReference,
      },
    );

    await service.createThread({
      attachments: [
        {
          kind: "file",
          relativePath: "phone-note.txt",
          uploadId: "4d423d3a-b0ec-4c0b-aac6-cb87ce47a438",
        },
      ],
      prompt: "读取手机上传文件",
    });

    expect(resolveLocalInputReference).toHaveBeenCalledOnce();
    expect(calls.find((call) => call.method === "turn/start")).toEqual({
      method: "turn/start",
      params: {
        input: [
          { text: "读取手机上传文件", text_elements: [], type: "text" },
          {
            name: "phone-note.txt",
            path: "C:\\remote-data\\BrowserUploads\\upload\\phone-note.txt",
            type: "mention",
          },
        ],
        threadId: "thread-new",
      },
    });
  });

  it("keeps Default collaboration implicit so Desktop shows the selected model", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const service = createService(async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/start") {
        return { thread: threadFixture, model: "gpt-5.3-codex-spark" };
      }
      if (method === "turn/start") {
        return {
          turn: { id: "turn-new", status: "inProgress", startedAt: 1_721_000_001, items: [] },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await service.createThread({
      collaborationMode: "Default",
      model: "gpt-5.3-codex-spark",
      projectId: "project-1",
      prompt: "验证桌面模型标签",
      reasoningEffort: "xhigh",
    });

    expect(calls.map((call) => call.method)).toEqual(["thread/start", "turn/start"]);
    expect(calls[1]).toEqual({
      method: "turn/start",
      params: {
        effort: "xhigh",
        input: [{ text: "验证桌面模型标签", text_elements: [], type: "text" }],
        model: "gpt-5.3-codex-spark",
        threadId: "thread-new",
      },
    });
  });

  it("creates an isolated non-project conversation and keeps its next turn controllable", async () => {
    const generalConversationRoot = "C:\\CodexLocalRemote\\RemoteConversations";
    const calls: Array<{ method: string; params: unknown }> = [];
    let turnNumber = 0;
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/start") {
          return {
            thread: { ...threadFixture, cwd: generalConversationRoot },
          };
        }
        if (method === "thread/read") {
          return {
            thread: {
              ...threadFixture,
              cwd: generalConversationRoot,
              status: { type: "idle" },
            },
          };
        }
        if (method === "turn/start") {
          turnNumber += 1;
          return {
            turn: {
              id: `turn-${turnNumber}`,
              items: [],
              startedAt: 1_721_000_001 + turnNumber,
              status: "inProgress",
            },
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { generalConversationRoot },
    );

    const created = await service.createThread({ prompt: "开始一个不关联项目的任务" });
    service.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-new", turn: { id: "turn-1", status: "completed" } },
    });
    const continued = await service.startTurn("thread-new", { prompt: "继续这个任务" });

    expect(calls[0]).toEqual({
      method: "thread/start",
      params: {
        cwd: generalConversationRoot,
        threadSource: "codex-local-remote",
      },
    });
    expect(calls.at(-1)).toEqual({
      method: "turn/start",
      params: {
        input: [{ text: "继续这个任务", text_elements: [], type: "text" }],
        threadId: "thread-new",
      },
    });
    expect(created.data.projectId).toBeUndefined();
    expect(created.data.mode).toBe("managed");
    expect(continued).toEqual({ state: "running", threadId: "thread-new", turnId: "turn-2" });
  });

  it("releases a stopped turn from terminal thread status even when turn/completed is omitted", async () => {
    const generalConversationRoot = "C:\\CodexLocalRemote\\RemoteConversations";
    let turnNumber = 0;
    const service = createService(
      async (method) => {
        if (method === "thread/start") {
          return { thread: { ...threadFixture, cwd: generalConversationRoot } };
        }
        if (method === "thread/read") {
          return {
            thread: {
              ...threadFixture,
              cwd: generalConversationRoot,
              status: { type: "idle" },
              turns: [],
            },
          };
        }
        if (method === "turn/start") {
          turnNumber += 1;
          return {
            turn: {
              id: `turn-${turnNumber}`,
              items: [],
              status: "inProgress",
            },
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { generalConversationRoot },
    );

    await service.createThread({ prompt: "开始任务" });
    service.handleNotification({
      method: "thread/status/changed",
      params: {
        status: { type: "idle" },
        threadId: "thread-new",
      },
    });

    await expect(service.startTurn("thread-new", { prompt: "停止后继续" })).resolves.toEqual({
      state: "running",
      threadId: "thread-new",
      turnId: "turn-2",
    });
  });

  it("releases only the exact active turn on a non-retryable error without turn/completed", async () => {
    const events = new RemoteEventBuffer();
    const generalConversationRoot = "C:\\CodexLocalRemote\\RemoteConversations";
    let turnNumber = 0;
    const service = createService(
      async (method) => {
        if (method === "thread/start") {
          return { thread: { ...threadFixture, cwd: generalConversationRoot } };
        }
        if (method === "thread/read") {
          return {
            thread: {
              ...threadFixture,
              cwd: generalConversationRoot,
              status: { type: "idle" },
              turns: [],
            },
          };
        }
        if (method === "turn/start") {
          turnNumber += 1;
          return {
            turn: {
              id: `turn-${turnNumber}`,
              items: [],
              status: "inProgress",
            },
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { events, generalConversationRoot },
    );

    await service.createThread({ prompt: "开始任务" });
    service.handleNotification({
      method: "error",
      params: {
        error: { message: "无关任务失败" },
        threadId: "thread-new",
        turnId: "turn-other",
        willRetry: false,
      },
    });
    await expect(
      service.startTurn("thread-new", { prompt: "不能越过仍活动的任务" }),
    ).rejects.toMatchObject({
      code: "TURN_MISMATCH",
    });
    service.handleNotification({
      method: "error",
      params: {
        error: { message: "将自动重试" },
        threadId: "thread-new",
        turnId: "turn-1",
        willRetry: true,
      },
    });
    await expect(
      service.startTurn("thread-new", { prompt: "重试错误仍不能清理" }),
    ).rejects.toMatchObject({
      code: "TURN_MISMATCH",
    });

    const beforeTerminalError = events.latestSequence;
    service.handleNotification({
      method: "error",
      params: {
        error: { message: "最终失败" },
        threadId: "thread-new",
        turnId: "turn-1",
        willRetry: false,
      },
    });

    await expect(service.startTurn("thread-new", { prompt: "失败后继续" })).resolves.toEqual({
      state: "running",
      threadId: "thread-new",
      turnId: "turn-2",
    });
    expect(
      events.replayAfter(beforeTerminalError).events.filter((event) => event.type === "turn.state"),
    ).toEqual([
      expect.objectContaining({
        payload: {
          state: "failed",
          turn: { id: "turn-1", status: "failed" },
        },
        threadId: "thread-new",
        turnId: "turn-1",
      }),
    ]);
  });

  it("forwards a stable queued-message client id and reconciles it from raw history", async () => {
    const generalConversationRoot = "C:\\CodexLocalRemote\\RemoteConversations";
    const calls: Array<{ method: string; params: unknown }> = [];
    let turnNumber = 0;
    const clientUserMessageId = "queue-client-message-1";
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/start") {
          return { thread: { ...threadFixture, cwd: generalConversationRoot } };
        }
        if (method === "thread/read") {
          return {
            thread: {
              ...threadFixture,
              cwd: generalConversationRoot,
              status: { type: "idle" },
              turns: [],
            },
          };
        }
        if (method === "thread/turns/list") {
          return {
            data: [
              {
                id: "turn-queued",
                items: [
                  {
                    clientId: clientUserMessageId,
                    content: [{ text: "不会投影到对账结果", type: "text" }],
                    id: "user-message-queued",
                    type: "userMessage",
                  },
                ],
                status: "completed",
              },
            ],
          };
        }
        if (method === "turn/start") {
          turnNumber += 1;
          return {
            turn: {
              id: `turn-${turnNumber}`,
              items: [],
              startedAt: 1_721_000_001 + turnNumber,
              status: "inProgress",
            },
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        generalConversationRoot,
        protocolCatalog: { clientMethods: ["thread/turns/list"] },
      },
    );
    await service.createThread({ prompt: "创建队列测试对话" });
    service.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-new", turn: { id: "turn-1", status: "completed" } },
    });

    await service.startTurn("thread-new", {
      clientUserMessageId,
      prompt: "从持久队列发送",
    });
    service.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-new", turn: { id: "turn-2", status: "completed" } },
    });

    expect(calls.findLast((call) => call.method === "turn/start")).toEqual({
      method: "turn/start",
      params: {
        clientUserMessageId,
        input: [{ text: "从持久队列发送", text_elements: [], type: "text" }],
        threadId: "thread-new",
      },
    });
    await expect(
      service.reconcileClientUserMessage("thread-new", clientUserMessageId),
    ).resolves.toEqual({
      lifecycle: "completed",
      state: "accepted",
      turnId: "turn-queued",
    });
  });

  it("waits for the initial turn to become terminal before notifying the host", async () => {
    const threadId = "01900000-0000-7000-8000-000000000001";
    const sequence: string[] = [];
    let persistedTerminal = false;
    const spawned = deferred<void>();
    const notifyManagedThreadCreated = vi.fn(async (createdThreadId: string) => {
      sequence.push(`notify:${createdThreadId}`);
      await spawned.promise;
    });
    const service = new CodexDomainService({
      gateway: {
        request: adaptLegacyHistoryRequest(async <T = unknown>(method: string): Promise<T> => {
          sequence.push(method);
          if (method === "thread/start") {
            return {
              thread: { ...threadFixture, id: threadId },
            } as T;
          }
          if (method === "turn/start") {
            return {
              turn: {
                id: "turn-new",
                status: "inProgress",
                startedAt: 1_721_000_001,
                items: [],
              },
            } as T;
          }
          if (method === "thread/read") {
            return {
              thread: {
                ...threadFixture,
                id: threadId,
                status: { type: persistedTerminal ? "idle" : "active" },
                turns: [
                  {
                    id: "turn-new",
                    items: [{ id: "user-1", type: "userMessage" }],
                    status: persistedTerminal ? "completed" : "inProgress",
                  },
                ],
              },
            } as T;
          }
          throw new Error(`unexpected method ${method}`);
        }),
      },
      notifyManagedThreadCreated,
      clearPendingDesktopNotification: async (createdThreadId) => {
        sequence.push(`clear:${createdThreadId}`);
      },
      persistManagedThread: async (createdThreadId, options) => {
        sequence.push(`persist:${createdThreadId}:${String(options.desktopNotificationPending)}`);
      },
      projects: new ProjectRegistry([
        { id: "project-1", name: "示例项目", root: "C:\\workspace\\sample" },
      ]),
      protocolCatalog: { clientMethods: ["thread/turns/list"] },
      resolveRegisteredProjectRoot: async () => "C:\\workspace\\sample",
    });

    await expect(
      service.createThread({ projectId: "project-1", prompt: "同步到桌面端" }),
    ).resolves.toMatchObject({
      data: { activeTurnId: "turn-new", id: threadId, state: "running" },
    });
    expect(sequence).toEqual(["thread/start", `persist:${threadId}:true`, "turn/start"]);
    expect(notifyManagedThreadCreated).not.toHaveBeenCalled();

    await service.reconcilePendingDesktopNotifications();
    expect(sequence).toEqual([
      "thread/start",
      `persist:${threadId}:true`,
      "turn/start",
      "thread/read",
    ]);
    expect(notifyManagedThreadCreated).not.toHaveBeenCalled();

    service.handleNotification({
      method: "turn/started",
      params: {
        threadId,
        turn: { id: "turn-new", status: "inProgress" },
      },
    });
    service.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "01900000-0000-7000-8000-000000000002",
        turn: { id: "turn-other", status: "completed" },
      },
    });
    expect(notifyManagedThreadCreated).not.toHaveBeenCalled();

    service.handleNotification({
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: "turn-new",
          items: [{ id: "user-1", type: "userMessage" }],
          status: "completed",
        },
      },
    });
    await vi.waitFor(() => {
      expect(sequence.filter((entry) => entry === "thread/read")).toHaveLength(2);
    });
    await service.reconcilePendingDesktopNotifications();
    expect(notifyManagedThreadCreated).not.toHaveBeenCalled();

    persistedTerminal = true;
    const terminalReconciliation = service.reconcilePendingDesktopNotifications();
    await vi.waitFor(() => expect(notifyManagedThreadCreated).toHaveBeenCalledOnce());
    expect(sequence.at(-2)).toBe("thread/read");
    expect(sequence.at(-1)).toBe(`notify:${threadId}`);

    const repeatedReconciliation = service.reconcilePendingDesktopNotifications();
    expect(notifyManagedThreadCreated).toHaveBeenCalledOnce();

    spawned.resolve();
    await Promise.all([terminalReconciliation, repeatedReconciliation]);
    expect(notifyManagedThreadCreated).toHaveBeenCalledOnce();
    expect(sequence.filter((entry) => entry === "thread/read")).toHaveLength(3);
    expect(sequence.at(-1)).toBe(`clear:${threadId}`);
  });

  it("does not retain a false active turn when completion arrives before turn/start resolves", async () => {
    const threadId = "01900000-0000-7000-8000-000000000001";
    let turnStarts = 0;
    const service = createService(async (method) => {
      if (method === "thread/start") {
        return { thread: { ...threadFixture, id: threadId } };
      }
      if (method === "thread/read") {
        return { thread: { ...threadFixture, id: threadId } };
      }
      if (method === "turn/start") {
        turnStarts += 1;
        if (turnStarts === 1) {
          service.handleNotification({
            method: "turn/completed",
            params: {
              threadId,
              turn: {
                id: "turn-fast",
                items: [{ id: "user-fast", type: "userMessage" }],
                status: "completed",
              },
            },
          });
          return {
            turn: {
              id: "turn-fast",
              items: [],
              startedAt: 1_721_000_001,
              status: "inProgress",
            },
          };
        }
        return {
          turn: {
            id: "turn-second",
            items: [],
            startedAt: 1_721_000_002,
            status: "inProgress",
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const created = await service.createThread({ projectId: "project-1", prompt: "极快完成" });

    expect(created.data).toMatchObject({
      availableActions: {
        interrupt: false,
        reply: true,
        steer: false,
      },
      state: "complete",
    });
    expect(created.data.activeTurnId).toBeUndefined();

    await expect(service.startTurn(threadId, { prompt: "继续执行" })).resolves.toMatchObject({
      state: "running",
      threadId,
      turnId: "turn-second",
    });
    expect(turnStarts).toBe(2);
  });

  it("does not restore a pending turn after terminal thread status arrives before turn/start resolves", async () => {
    const threadId = "01900000-0000-7000-8000-000000000003";
    let turnStarts = 0;
    const service = createService(async (method) => {
      if (method === "thread/start") {
        return { thread: { ...threadFixture, id: threadId } };
      }
      if (method === "thread/read") {
        return { thread: { ...threadFixture, id: threadId } };
      }
      if (method === "turn/start") {
        turnStarts += 1;
        if (turnStarts === 1) {
          service.handleNotification({
            method: "turn/started",
            params: {
              threadId,
              turn: { id: "turn-stopped-before-response", status: "inProgress" },
            },
          });
          service.handleNotification({
            method: "thread/status/changed",
            params: {
              status: { type: "idle" },
              threadId,
            },
          });
          return {
            turn: {
              id: "turn-stopped-before-response",
              items: [],
              status: "inProgress",
            },
          };
        }
        return {
          turn: {
            id: "turn-after-stop",
            items: [],
            status: "inProgress",
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const created = await service.createThread({
      projectId: "project-1",
      prompt: "启动后立即停止",
    });

    expect(created.data).toMatchObject({
      availableActions: {
        interrupt: false,
        reply: true,
        steer: false,
      },
      state: "idle",
    });
    expect(created.data.activeTurnId).toBeUndefined();

    await expect(service.startTurn(threadId, { prompt: "停止后下一轮" })).resolves.toEqual({
      state: "running",
      threadId,
      turnId: "turn-after-stop",
    });
  });

  it("does not let an unrelated completion suppress the active turn returned by turn/start", async () => {
    const threadId = "01900000-0000-7000-8000-000000000001";
    const service = createService(async (method) => {
      if (method === "thread/start") {
        return { thread: { ...threadFixture, id: threadId } };
      }
      if (method === "turn/start") {
        service.handleNotification({
          method: "turn/completed",
          params: {
            threadId,
            turn: {
              id: "turn-unrelated",
              items: [{ id: "user-unrelated", type: "userMessage" }],
              status: "completed",
            },
          },
        });
        return {
          turn: {
            id: "turn-real",
            items: [],
            startedAt: 1_721_000_001,
            status: "inProgress",
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await service.createThread({ projectId: "project-1", prompt: "保持真实活动状态" });

    await expect(service.startTurn(threadId, { prompt: "不能并发" })).rejects.toMatchObject({
      code: "TURN_MISMATCH",
    });
  });

  it("maps a Broker active-turn race to a stable product conflict instead of leaking RPC text", async () => {
    const threadId = "01900000-0000-7000-8000-000000000001";
    let turnStarts = 0;
    const service = createService(async (method) => {
      if (method === "thread/start") {
        return { thread: { ...threadFixture, id: threadId } };
      }
      if (method === "thread/read") {
        return { thread: { ...threadFixture, id: threadId } };
      }
      if (method === "turn/start") {
        turnStarts += 1;
        if (turnStarts === 1) {
          return { turn: { id: "turn-initial", status: "inProgress" } };
        }
        throw Object.assign(new Error("Thread already has an active or pending turn"), {
          code: -32_094,
          method: "turn/start",
        });
      }
      throw new Error(`unexpected method ${method}`);
    });

    await service.createThread({ projectId: "project-1", prompt: "第一轮" });
    service.handleNotification({
      method: "turn/completed",
      params: { threadId, turn: { id: "turn-initial", status: "completed" } },
    });

    await expect(service.startTurn(threadId, { prompt: "在已有对话继续" })).rejects.toMatchObject({
      code: "TURN_MISMATCH",
      httpStatus: 409,
      message: "Codex 仍在收尾当前回复，消息没有发送，请稍后重试",
    } satisfies Partial<DomainError>);
  });

  it("clears a pending desktop marker when the initial turn fails to start", async () => {
    const threadId = "01900000-0000-7000-8000-000000000001";
    const methods: string[] = [];
    const clearPendingDesktopNotification = vi.fn(async () => undefined);
    const notifyManagedThreadCreated = vi.fn(async () => undefined);
    const persistManagedThread = vi.fn(async () => undefined);
    const service = new CodexDomainService({
      clearPendingDesktopNotification,
      gateway: {
        request: adaptLegacyHistoryRequest(async <T = unknown>(method: string): Promise<T> => {
          methods.push(method);
          if (method === "thread/start") {
            return { thread: { ...threadFixture, id: threadId } } as T;
          }
          if (method === "turn/start") {
            throw new Error("turn start failed");
          }
          throw new Error(`unexpected method ${method}`);
        }),
      },
      notifyManagedThreadCreated,
      persistManagedThread,
      projects: new ProjectRegistry([
        { id: "project-1", name: "示例项目", root: "C:\\workspace\\sample" },
      ]),
      protocolCatalog: { clientMethods: ["thread/turns/list"] },
      resolveRegisteredProjectRoot: async () => "C:\\workspace\\sample",
    });

    await expect(
      service.createThread({ projectId: "project-1", prompt: "启动失败" }),
    ).rejects.toThrow("turn start failed");

    expect(persistManagedThread).toHaveBeenCalledWith(threadId, {
      desktopNotificationPending: true,
    });
    expect(clearPendingDesktopNotification).toHaveBeenCalledOnce();
    expect(clearPendingDesktopNotification).toHaveBeenCalledWith(threadId);
    expect(notifyManagedThreadCreated).not.toHaveBeenCalled();

    await service.reconcilePendingDesktopNotifications();
    expect(methods).toEqual(["thread/start", "turn/start"]);
  });

  it("contains host notification failures after the real first turn is terminal", async () => {
    const threadId = "01900000-0000-7000-8000-000000000001";
    const methods: string[] = [];
    const clearPendingDesktopNotification = vi.fn(async () => undefined);
    let notificationAttempts = 0;
    const notifyManagedThreadCreated = vi.fn(async () => {
      notificationAttempts += 1;
      if (notificationAttempts === 1) {
        throw new Error("desktop unavailable");
      }
    });
    const service = new CodexDomainService({
      clearPendingDesktopNotification,
      gateway: {
        request: adaptLegacyHistoryRequest(async <T = unknown>(method: string): Promise<T> => {
          methods.push(method);
          if (method === "thread/start") {
            return { thread: { ...threadFixture, id: threadId } } as T;
          }
          if (method === "turn/start") {
            return {
              turn: {
                id: "turn-new",
                status: "inProgress",
                startedAt: 1_721_000_001,
                items: [],
              },
            } as T;
          }
          if (method === "thread/read") {
            return {
              thread: {
                ...threadFixture,
                id: threadId,
                status: { type: "idle" },
                turns: [
                  {
                    id: "turn-new",
                    items: [{ id: "user-1", type: "userMessage" }],
                    status: "completed",
                  },
                ],
              },
            } as T;
          }
          throw new Error(`unexpected method ${method}`);
        }),
      },
      notifyManagedThreadCreated,
      persistManagedThread: async () => undefined,
      projects: new ProjectRegistry([
        { id: "project-1", name: "示例项目", root: "C:\\workspace\\sample" },
      ]),
      protocolCatalog: { clientMethods: ["thread/turns/list"] },
      resolveRegisteredProjectRoot: async () => "C:\\workspace\\sample",
    });

    await expect(
      service.createThread({ projectId: "project-1", prompt: "通知失败也要继续" }),
    ).resolves.toMatchObject({
      data: { activeTurnId: "turn-new", id: threadId, state: "running" },
    });
    expect(methods).toEqual(["thread/start", "turn/start"]);
    expect(service.isManagedThread(threadId)).toBe(true);
    expect(notifyManagedThreadCreated).not.toHaveBeenCalled();

    expect(() =>
      service.handleNotification({
        method: "turn/completed",
        params: {
          threadId,
          turn: {
            id: "turn-new",
            items: [{ id: "user-1", type: "userMessage" }],
            status: "completed",
          },
        },
      }),
    ).not.toThrow();
    await vi.waitFor(() => expect(notifyManagedThreadCreated).toHaveBeenCalledOnce());
    await new Promise((resolve) => setImmediate(resolve));
    expect(clearPendingDesktopNotification).not.toHaveBeenCalled();

    await service.reconcilePendingDesktopNotifications();

    expect(notifyManagedThreadCreated).toHaveBeenCalledTimes(2);
    expect(clearPendingDesktopNotification).toHaveBeenCalledOnce();
  });

  it("reconciles only durable pending threads after a full Sidecar restart", async () => {
    const terminalId = "01900000-0000-7000-8000-000000000001";
    const activeId = "01900000-0000-7000-8000-000000000002";
    const historicalId = "01900000-0000-7000-8000-000000000003";
    const reads: string[] = [];
    let activeReads = 0;
    const notifyManagedThreadCreated = vi.fn(async () => undefined);
    const clearPendingDesktopNotification = vi.fn(async () => undefined);
    const service = new CodexDomainService({
      clearPendingDesktopNotification,
      gateway: {
        request: adaptLegacyHistoryRequest(
          async <T = unknown>(method: string, params?: unknown): Promise<T> => {
            if (method !== "thread/read") {
              throw new Error(`unexpected method ${method}`);
            }
            const threadId = (params as { threadId?: string }).threadId ?? "";
            reads.push(threadId);
            if (threadId === activeId) {
              activeReads += 1;
              return {
                thread: {
                  ...threadFixture,
                  id: threadId,
                  status: { type: "active" },
                  turns: [
                    {
                      id: "turn-active",
                      items: activeReads === 1 ? [] : [{ id: "user-active", type: "userMessage" }],
                      status: "inProgress",
                    },
                  ],
                },
              } as T;
            }
            return {
              thread: {
                ...threadFixture,
                id: threadId,
                status: { type: "idle" },
                turns: [
                  {
                    id: "turn-complete",
                    items: [{ id: "user-complete", type: "userMessage" }],
                    status: "completed",
                  },
                ],
              },
            } as T;
          },
        ),
      },
      managedThreadIds: [historicalId, terminalId, activeId],
      notifyManagedThreadCreated,
      pendingDesktopNotificationThreadIds: [terminalId, activeId],
      projects: new ProjectRegistry(),
      protocolCatalog: { clientMethods: ["thread/turns/list"] },
      resolveRegisteredProjectRoot: async () => undefined,
    });

    await service.reconcilePendingDesktopNotifications();

    expect(reads).toEqual([terminalId, activeId]);
    expect(reads).not.toContain(historicalId);
    expect(notifyManagedThreadCreated).toHaveBeenCalledTimes(1);
    expect(notifyManagedThreadCreated).toHaveBeenCalledWith(terminalId);
    expect(clearPendingDesktopNotification).toHaveBeenCalledWith(terminalId);

    await service.reconcilePendingDesktopNotifications();

    expect(reads).toEqual([terminalId, activeId, activeId]);
    expect(notifyManagedThreadCreated).toHaveBeenCalledTimes(2);
    expect(notifyManagedThreadCreated).toHaveBeenLastCalledWith(activeId);
    expect(clearPendingDesktopNotification).toHaveBeenLastCalledWith(activeId);
  });

  it("treats current pending desktop notifications as restored after a backend restart", async () => {
    const threadId = "01900000-0000-7000-8000-000000000001";
    const notifyManagedThreadCreated = vi.fn(async () => undefined);
    const clearPendingDesktopNotification = vi.fn(async () => undefined);
    const service = new CodexDomainService({
      clearPendingDesktopNotification,
      gateway: {
        request: adaptLegacyHistoryRequest(async <T = unknown>(method: string): Promise<T> => {
          if (method === "thread/start") {
            return { thread: { ...threadFixture, id: threadId } } as T;
          }
          if (method === "turn/start") {
            return {
              turn: {
                id: "turn-before-restart",
                items: [],
                startedAt: 1_721_000_001,
                status: "inProgress",
              },
            } as T;
          }
          if (method === "thread/read") {
            return {
              thread: {
                ...threadFixture,
                id: threadId,
                status: { type: "active" },
                turns: [
                  {
                    id: "turn-before-restart",
                    items: [{ id: "user-visible", type: "userMessage" }],
                    status: "inProgress",
                  },
                ],
              },
            } as T;
          }
          throw new Error(`unexpected method ${method}`);
        }),
      },
      notifyManagedThreadCreated,
      persistManagedThread: async () => undefined,
      projects: new ProjectRegistry([
        { id: "project-1", name: "示例项目", root: "C:\\workspace\\sample" },
      ]),
      protocolCatalog: { clientMethods: ["thread/turns/list"] },
      resolveRegisteredProjectRoot: async () => "C:\\workspace\\sample",
    });

    await service.createThread({ projectId: "project-1", prompt: "重启后继续同步" });
    service.handleBackendRestart();
    await service.reconcilePendingDesktopNotifications();

    expect(notifyManagedThreadCreated).toHaveBeenCalledOnce();
    expect(notifyManagedThreadCreated).toHaveBeenCalledWith(threadId);
    expect(clearPendingDesktopNotification).toHaveBeenCalledWith(threadId);
  });

  it("clears a restored idle empty shell without opening it in Desktop", async () => {
    const threadId = "01900000-0000-7000-8000-000000000001";
    const reads: string[] = [];
    const notifyManagedThreadCreated = vi.fn(async () => undefined);
    const clearPendingDesktopNotification = vi.fn(async () => undefined);
    const service = new CodexDomainService({
      clearPendingDesktopNotification,
      gateway: {
        request: adaptLegacyHistoryRequest(
          async <T = unknown>(method: string, params?: unknown): Promise<T> => {
            if (method !== "thread/read") {
              throw new Error(`unexpected method ${method}`);
            }
            reads.push((params as { threadId: string }).threadId);
            return {
              thread: {
                ...threadFixture,
                id: threadId,
                status: { type: "idle" },
                turns: [],
              },
            } as T;
          },
        ),
      },
      managedThreadIds: [threadId],
      notifyManagedThreadCreated,
      pendingDesktopNotificationThreadIds: [threadId],
      projects: new ProjectRegistry(),
      protocolCatalog: { clientMethods: ["thread/turns/list"] },
      resolveRegisteredProjectRoot: async () => undefined,
    });

    await service.reconcilePendingDesktopNotifications();
    await service.reconcilePendingDesktopNotifications();

    expect(reads).toEqual([threadId]);
    expect(notifyManagedThreadCreated).not.toHaveBeenCalled();
    expect(clearPendingDesktopNotification).toHaveBeenCalledOnce();
    expect(clearPendingDesktopNotification).toHaveBeenCalledWith(threadId);
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
    const request = vi.fn(async () => ({}));
    const service = createService(request, undefined, undefined, {
      sharedAppServer: true,
      sharedResumeDelaysMs: [0],
    });

    await expect(service.steerTurn("desktop-thread", "turn-1", "补充要求")).rejects.toMatchObject({
      code: "THREAD_READ_ONLY",
    } satisfies Partial<DomainError>);
    expect(request).not.toHaveBeenCalled();
  });

  it("explicitly takes over a historical Desktop snapshot before making it controllable", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const persistManagedThread = vi.fn(async () => undefined);
    const desktopThread = {
      ...threadFixture,
      id: "desktop-history",
      status: { activeFlags: [], type: "idle" },
      turns: [],
    };
    const service = new CodexDomainService({
      gateway: {
        request: adaptLegacyHistoryRequest(
          async <T = unknown>(method: string, params?: unknown): Promise<T> => {
            calls.push({ method, params });
            if (method === "thread/resume" || method === "thread/read") {
              return { thread: desktopThread } as T;
            }
            throw new Error(`unexpected method ${method}`);
          },
        ),
      },
      persistManagedThread,
      projects: new ProjectRegistry([
        { id: "project-1", name: "示例项目", root: "C:\\workspace\\sample" },
      ]),
      protocolCatalog: { clientMethods: ["thread/turns/list"] },
      resolveRegisteredProjectRoot: async () => "C:\\workspace\\sample",
      sharedAppServer: true,
      sharedResumeDelaysMs: [0],
    });

    await expect(service.resumeThread(desktopThread.id)).resolves.toMatchObject({
      availableActions: { reply: true },
      id: desktopThread.id,
      mode: "managed",
    });
    expect(persistManagedThread).toHaveBeenCalledWith(desktopThread.id, {
      desktopNotificationPending: false,
    });
    expect(calls.some((call) => call.method === "thread/resume")).toBe(true);
  });

  it.each([
    {
      upstream: "Codex Desktop is not connected",
      message: "电脑上的 Codex Desktop 当前未连接，因此只能查看历史记录。",
    },
    {
      upstream: "Thread subscription barrier failed",
      message: "Desktop 未能同步加载这项历史任务，请保持 Desktop 打开后重试。",
    },
  ])("explains why a shared history thread remains read-only", async ({ upstream, message }) => {
    const service = createService(
      async (method) => {
        if (method === "thread/resume") throw new Error(upstream);
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        protocolCatalog: { clientMethods: ["thread/turns/list"] },
        sharedAppServer: true,
        sharedResumeDelaysMs: [0],
      },
    );

    await expect(service.resumeThread("desktop-history")).rejects.toMatchObject({
      code: "THREAD_READ_ONLY",
      message,
    } satisfies Partial<DomainError>);
  });

  it("resumes a Desktop-created thread through the shared app-server and makes it controllable", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const desktopThread = {
      ...threadFixture,
      id: "desktop-thread",
      status: { activeFlags: [], type: "active" },
      turns: [
        {
          id: "desktop-turn",
          items: [],
          startedAt: 1_721_000_001,
          status: "inProgress",
        },
      ],
    };
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/loaded/list") return { data: [desktopThread.id] };
        if (method === "thread/resume") return { thread: desktopThread };
        if (method === "thread/read") return { thread: desktopThread };
        if (method === "turn/steer") return { turnId: "desktop-turn" };
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { sharedAppServer: true, sharedResumeDelaysMs: [0] },
    );

    await service.resubscribeSharedThreads();
    await expect(service.getThread("desktop-thread")).resolves.toMatchObject({
      activeTurnId: "desktop-turn",
      availableActions: { interrupt: true, steer: true },
      mode: "managed",
    });
    await expect(
      service.steerTurn("desktop-thread", "desktop-turn", "手机补充要求"),
    ).resolves.toEqual({
      state: "running",
      threadId: "desktop-thread",
      turnId: "desktop-turn",
    });
    expect(calls.map((call) => call.method)).toEqual([
      "thread/loaded/list",
      "thread/resume",
      "thread/read",
      "turn/steer",
    ]);
  });

  it("recovers the current Desktop turn from the paginated turn head when thread/read omits it", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const desktopThread = {
      ...threadFixture,
      id: "desktop-active-without-read-turn",
      status: { activeFlags: [], type: "active" },
      turns: [],
    };
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/loaded/list") return { data: [desktopThread.id] };
        if (method === "thread/resume" || method === "thread/read") {
          return { thread: desktopThread };
        }
        if (method === "thread/turns/list") {
          return {
            backwardsCursor: "latest",
            data: [
              {
                id: "desktop-recovered-turn",
                items: [],
                itemsView: "summary",
                startedAt: 1_721_000_001,
                status: "inProgress",
              },
            ],
            nextCursor: null,
          };
        }
        if (method === "turn/steer") return { turnId: "desktop-recovered-turn" };
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        protocolCatalog: { clientMethods: ["thread/turns/list"] },
        sharedAppServer: true,
        sharedResumeDelaysMs: [0],
      },
    );

    await service.resubscribeSharedThreads();
    await expect(service.getThread(desktopThread.id)).resolves.toMatchObject({
      activeTurnId: "desktop-recovered-turn",
      availableActions: {
        interrupt: true,
        reply: false,
        steer: true,
      },
      state: "running",
    });
    await expect(
      service.steerTurn(desktopThread.id, "desktop-recovered-turn", "继续当前回复"),
    ).resolves.toMatchObject({
      state: "running",
      turnId: "desktop-recovered-turn",
    });
    expect(calls).toContainEqual({
      method: "thread/turns/list",
      params: {
        itemsView: "full",
        limit: 12,
        sortDirection: "desc",
        threadId: desktopThread.id,
      },
    });
  });

  it("loads a lightweight thread shell without pulling historical turns", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const service = createService(async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/read") {
        return {
          thread: {
            ...threadFixture,
            id: "thread-shell",
            turns: [],
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await expect(service.getThread("thread-shell", { includeTurns: false })).resolves.toMatchObject(
      {
        id: "thread-shell",
        items: [],
      },
    );
    expect(calls).toEqual([
      {
        method: "thread/read",
        params: { includeTurns: false, threadId: "thread-shell" },
      },
    ]);
  });

  it("loads only recent full turns when the paginated protocol is available", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const recentTurn = {
      id: "turn-recent",
      items: [
        {
          content: [{ text: "最近消息", type: "text" }],
          id: "message-recent",
          type: "userMessage",
        },
      ],
      startedAt: 1_721_000_100,
      status: "completed",
    };
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/read") {
          return { thread: { ...threadFixture, turns: [] } };
        }
        if (method === "thread/turns/list") {
          return {
            data: [recentTurn],
            nextCursor: "older",
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { protocolCatalog: { clientMethods: ["thread/turns/list"] } },
    );

    await expect(service.getThread(threadFixture.id)).resolves.toMatchObject({
      items: [{ id: "message-recent", kind: "user-message", text: "最近消息" }],
    });
    expect(calls).toEqual([
      {
        method: "thread/read",
        params: { includeTurns: false, threadId: threadFixture.id },
      },
      {
        method: "thread/turns/list",
        params: {
          itemsView: "full",
          limit: 12,
          sortDirection: "desc",
          threadId: threadFixture.id,
        },
      },
    ]);
  });

  it("merges persisted plan questions and formal plans before the turn final answer", async () => {
    const sessionPath = "C:\\TestCodexHome\\sessions\\2026\\07\\28\\thread-new.jsonl";
    const readPersistedConversationItems = vi.fn(async () => [
      {
        id: "interaction-question",
        interaction: "question" as const,
        kind: "interaction-record" as const,
        questions: [
          {
            answers: ["方案 A"],
            header: "选择",
            id: "choice",
            isSecret: false,
            question: "采用哪个方案？",
          },
        ],
        status: "answered" as const,
        title: "Codex 提出了问题",
        turnId: "turn-plan",
      },
      {
        id: "formal-plan",
        kind: "formal-plan" as const,
        text: "# 方案 A",
        turnId: "turn-plan",
      },
    ]);
    const service = createService(
      async (method) => {
        if (method === "thread/read") {
          return {
            thread: {
              ...threadFixture,
              path: sessionPath,
              turns: [
                {
                  completedAt: 1_721_000_020,
                  id: "turn-plan",
                  items: [
                    {
                      content: [{ text: "先规划", type: "text" }],
                      id: "user-plan",
                      type: "userMessage",
                    },
                    {
                      id: "commentary-plan",
                      phase: "commentary",
                      text: "我会先提问",
                      type: "agentMessage",
                    },
                    {
                      id: "final-plan",
                      phase: "final_answer",
                      text: "<proposed_plan># 方案 A</proposed_plan>",
                      type: "agentMessage",
                    },
                  ],
                  startedAt: 1_721_000_010,
                  status: "completed",
                },
              ],
            },
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { readPersistedConversationItems },
    );

    await expect(service.getThread(threadFixture.id)).resolves.toMatchObject({
      items: [
        { id: "user-plan" },
        { id: "commentary-plan" },
        { id: "interaction-question" },
        { id: "formal-plan" },
        { id: "final-plan" },
      ],
    });
    expect(readPersistedConversationItems).toHaveBeenCalledWith(
      threadFixture.id,
      sessionPath,
      "recent",
    );
  });

  it("reads complete persisted history for a child thread and keeps early items in chronology", async () => {
    const sessionPath = "C:\\TestCodexHome\\sessions\\2026\\07\\28\\child-thread.jsonl";
    const readPersistedConversationItems = vi.fn(
      async (
        _threadId: string,
        _sessionPath?: string,
        scope: PersistedConversationHistoryScope = "recent",
      ): Promise<PersistedConversationReadResult> => ({
        integrity: {
          observedCount: 5,
          reason: "verified-complete",
          scope,
          status: "complete",
        },
        items: [
          {
            createdAt: "2026-07-28T00:00:00.000Z",
            id: "child-user-early",
            kind: "user-message",
            text: "最早的问题",
          },
          {
            createdAt: "2026-07-28T00:00:01.000Z",
            id: "child-assistant-early",
            kind: "assistant-message",
            phase: "commentary",
            text: "最早的回复",
          },
          {
            createdAt: "2026-07-28T00:01:00.000Z",
            id: "child-user-recent",
            kind: "user-message",
            text: "持久记录中的最近问题",
            turnId: "child-turn-recent",
          },
          {
            createdAt: "2026-07-28T00:01:01.000Z",
            id: "child-persisted-only",
            kind: "assistant-message",
            phase: "commentary",
            text: "app-server 最近页遗漏的中间回复",
            turnId: "child-turn-recent",
          },
          {
            createdAt: "2026-07-28T00:01:02.000Z",
            id: "child-assistant-recent",
            kind: "assistant-message",
            phase: "final_answer",
            text: "持久记录中的最近结论",
            turnId: "child-turn-recent",
          },
        ],
      }),
    );
    const service = createService(
      async (method) => {
        if (method === "thread/read") {
          return {
            thread: {
              ...threadFixture,
              id: "child-thread",
              parentThreadId: "root-thread",
              path: sessionPath,
              turns: [
                {
                  id: "child-turn-recent",
                  items: [
                    {
                      content: [{ text: "协议中的最近问题", type: "text" }],
                      id: "child-user-recent",
                      type: "userMessage",
                    },
                    {
                      id: "child-assistant-recent",
                      phase: "final_answer",
                      text: "协议中的最近结论",
                      type: "agentMessage",
                    },
                  ],
                  status: "completed",
                },
              ],
            },
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { readPersistedConversationItems },
    );

    const result = await service.getThread("child-thread");

    expect(result.items.map((item) => item.id)).toEqual([
      "child-user-early",
      "child-assistant-early",
      "child-user-recent",
      "child-persisted-only",
      "child-assistant-recent",
    ]);
    expect(result.items.find((item) => item.id === "child-user-recent")).toMatchObject({
      createdAt: "2026-07-28T00:01:00.000Z",
      text: "协议中的最近问题",
    });
    expect(result.persistedHistoryIntegrity).toEqual({
      observedCount: 5,
      reason: "verified-complete",
      scope: "complete",
      status: "complete",
    });
    expect(readPersistedConversationItems).toHaveBeenCalledWith(
      "child-thread",
      sessionPath,
      "complete",
    );
  });

  it("keeps duplicate persisted ids stable while exposing a partial recent root read", async () => {
    const readPersistedConversationItems = vi.fn(
      async (): Promise<PersistedConversationReadResult> => ({
        integrity: {
          observedCount: 2,
          reason: "recent-window",
          scope: "recent",
          status: "partial",
        },
        items: [
          { id: "root-user", kind: "user-message", text: "持久问题" },
          { id: "root-user", kind: "user-message", text: "重复项不得出现" },
        ],
      }),
    );
    const service = createService(
      async (method) => {
        if (method === "thread/read") {
          return {
            thread: {
              ...threadFixture,
              turns: [
                {
                  id: "root-turn",
                  items: [
                    {
                      content: [{ text: "协议问题", type: "text" }],
                      id: "root-user",
                      type: "userMessage",
                    },
                  ],
                  status: "completed",
                },
              ],
            },
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { readPersistedConversationItems },
    );

    const result = await service.getThread(threadFixture.id);

    expect(result.items).toEqual([expect.objectContaining({ id: "root-user", text: "协议问题" })]);
    expect(result.persistedHistoryIntegrity).toMatchObject({
      reason: "recent-window",
      scope: "recent",
      status: "partial",
    });
  });

  it("deduplicates the same persisted and protocol compaction when their synthetic ids differ", async () => {
    const readPersistedConversationItems = vi.fn(async () => [
      {
        createdAt: "2026-07-29T12:00:01.000Z",
        id: "persisted-context-compaction-turn-1-1",
        kind: "tool" as const,
        operation: "context-compaction" as const,
        status: "complete" as const,
        title: "压缩对话上下文",
        turnId: "turn-1",
      },
    ]);
    const service = createService(
      async (method) => {
        if (method === "thread/read") {
          return {
            thread: {
              ...threadFixture,
              turns: [
                {
                  completedAt: "2026-07-29T12:00:02.000Z",
                  id: "turn-1",
                  items: [
                    {
                      id: "protocol-context-compaction",
                      status: "completed",
                      type: "contextCompaction",
                    },
                  ],
                  startedAt: "2026-07-29T12:00:00.000Z",
                  status: "completed",
                },
              ],
            },
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { readPersistedConversationItems },
    );

    const result = await service.getThread(threadFixture.id);

    expect(
      result.items.filter(
        (item) => item.kind === "tool" && item.operation === "context-compaction",
      ),
    ).toEqual([
      expect.objectContaining({
        id: "protocol-context-compaction",
        status: "complete",
        turnId: "turn-1",
      }),
    ]);
  });

  it("correlates repeated persisted tools with the fresher protocol items in reverse chronology", async () => {
    const readPersistedConversationItems = vi.fn(async () => [
      {
        createdAt: "2026-07-29T12:00:01.000Z",
        id: "persisted-command-1",
        kind: "tool" as const,
        status: "complete" as const,
        title: "运行命令",
        turnId: "turn-tools",
      },
      {
        createdAt: "2026-07-29T12:00:02.000Z",
        id: "persisted-command-2",
        kind: "tool" as const,
        status: "complete" as const,
        title: "运行命令",
        turnId: "turn-tools",
      },
    ]);
    const service = createService(
      async (method) => {
        if (method === "thread/read") {
          return {
            thread: {
              ...threadFixture,
              turns: [
                {
                  completedAt: "2026-07-29T12:00:03.000Z",
                  id: "turn-tools",
                  items: [
                    {
                      aggregatedOutput: "first result",
                      command: "first command",
                      id: "protocol-command-1",
                      status: "completed",
                      type: "commandExecution",
                    },
                    {
                      aggregatedOutput: "second result",
                      command: "second command",
                      id: "protocol-command-2",
                      status: "completed",
                      type: "commandExecution",
                    },
                  ],
                  startedAt: "2026-07-29T12:00:00.000Z",
                  status: "completed",
                },
              ],
            },
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { readPersistedConversationItems },
    );

    const result = await service.getThread(threadFixture.id);

    expect(result.items).toMatchObject([
      {
        id: "protocol-command-1",
        kind: "tool",
        status: "complete",
        summary: "first command",
        turnId: "turn-tools",
      },
      {
        id: "protocol-command-2",
        kind: "tool",
        status: "complete",
        summary: "second command",
        turnId: "turn-tools",
      },
    ]);
  });

  it("preserves protocol order for multiple same-turn user items missing from persisted history", async () => {
    const sessionPath = "C:\\TestCodexHome\\sessions\\2026\\07\\28\\child-order.jsonl";
    const readPersistedConversationItems = vi.fn(
      async (): Promise<PersistedConversationReadResult> => ({
        integrity: {
          observedCount: 1,
          reason: "verified-complete",
          scope: "complete",
          status: "complete",
        },
        items: [
          {
            id: "persisted-assistant",
            kind: "assistant-message",
            phase: "final_answer",
            text: "持久记录中的回答",
            turnId: "child-turn",
          },
        ],
      }),
    );
    const service = createService(
      async (method) => {
        if (method === "thread/read") {
          return {
            thread: {
              ...threadFixture,
              id: "child-order",
              parentThreadId: "root-thread",
              path: sessionPath,
              turns: [
                {
                  id: "child-turn",
                  items: [
                    {
                      content: [{ text: "第一条协议用户消息", type: "text" }],
                      id: "protocol-user-1",
                      type: "userMessage",
                    },
                    {
                      content: [{ text: "第二条协议用户消息", type: "text" }],
                      id: "protocol-user-2",
                      type: "userMessage",
                    },
                  ],
                  status: "completed",
                },
              ],
            },
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { readPersistedConversationItems },
    );

    const result = await service.getThread("child-order");

    expect(result.items.map((item) => item.id)).toEqual([
      "protocol-user-1",
      "protocol-user-2",
      "persisted-assistant",
    ]);
  });

  it("exposes failed complete-history integrity when a child persisted reader throws", async () => {
    const sessionPath = "C:\\TestCodexHome\\sessions\\2026\\07\\28\\child-throw.jsonl";
    const readPersistedConversationItems = vi.fn(async () => {
      throw new Error("fixture persisted read failure");
    });
    const service = createService(
      async (method) => {
        if (method === "thread/read") {
          return {
            thread: {
              ...threadFixture,
              id: "child-throw",
              parentThreadId: "root-thread",
              path: sessionPath,
              turns: [
                {
                  id: "child-turn",
                  items: [
                    {
                      content: [{ text: "协议最近页仍保留", type: "text" }],
                      id: "child-user",
                      type: "userMessage",
                    },
                  ],
                  status: "completed",
                },
              ],
            },
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { readPersistedConversationItems },
    );

    const result = await service.getThread("child-throw");

    expect(result.items).toEqual([
      expect.objectContaining({ id: "child-user", text: "协议最近页仍保留" }),
    ]);
    expect(result.persistedHistoryIntegrity).toEqual({
      observedCount: 0,
      reason: "read-failed",
      scope: "complete",
      status: "failed",
    });
    expect(readPersistedConversationItems).toHaveBeenCalledWith(
      "child-throw",
      sessionPath,
      "complete",
    );
  });

  it("restores missing runtime parameters from the Desktop session while preserving protocol values", async () => {
    const sessionPath = "C:\\TestCodexHome\\sessions\\2026\\07\\28\\thread-new.jsonl";
    const readPersistedRuntimeSettings = vi.fn(async () => ({
      approvalPolicy: "never",
      approvalsReviewer: "guardian_subagent",
      collaborationMode: "default",
      model: "persisted-model",
      reasoningEffort: "max",
      serviceTier: "fast",
    }));
    const service = createService(
      async (method) => {
        if (method === "thread/read") {
          return {
            thread: {
              ...threadFixture,
              model: "protocol-model",
              path: sessionPath,
              turns: [],
            },
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { readPersistedRuntimeSettings },
    );

    await expect(service.getThread(threadFixture.id)).resolves.toMatchObject({
      approvalPolicy: "never",
      approvalsReviewer: "guardian_subagent",
      collaborationMode: "default",
      model: "protocol-model",
      reasoningEffort: "max",
      serviceTier: "fast",
    });
    expect(readPersistedRuntimeSettings).toHaveBeenCalledWith(threadFixture.id, sessionPath);
  });

  it("prefers a bounded recent item page for very long conversations", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/read") {
          return {
            thread: {
              ...threadFixture,
              status: { type: "active" },
              turns: [],
            },
          };
        }
        if (method === "thread/items/list") {
          return {
            data: [
              {
                item: {
                  id: "assistant-latest",
                  text: "最新回答",
                  type: "agentMessage",
                },
                turnId: "turn-live",
              },
              {
                item: {
                  content: [{ text: "最近问题", type: "text" }],
                  id: "user-recent",
                  type: "userMessage",
                },
                turnId: "turn-recent",
              },
            ],
            nextCursor: "older-items",
          };
        }
        if (method === "thread/turns/list") {
          return {
            data: [
              {
                id: "turn-live",
                items: [],
                itemsView: "summary",
                startedAt: 1_721_000_002,
                status: "inProgress",
              },
              {
                completedAt: 1_721_000_001,
                id: "turn-recent",
                items: [],
                itemsView: "summary",
                startedAt: 1_721_000_000,
                status: "completed",
              },
            ],
            nextCursor: "older-turns",
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        protocolCatalog: {
          clientMethods: ["thread/items/list", "thread/turns/list"],
        },
      },
    );

    await expect(service.getThread(threadFixture.id)).resolves.toMatchObject({
      activeTurnId: "turn-live",
      historyNextCursor: "older-items",
      items: [
        { id: "user-recent", kind: "user-message", text: "最近问题" },
        { id: "assistant-latest", kind: "assistant-message", text: "最新回答" },
      ],
      state: "running",
    });
    expect(calls).toEqual([
      {
        method: "thread/read",
        params: { includeTurns: false, threadId: threadFixture.id },
      },
      {
        method: "thread/items/list",
        params: {
          limit: 160,
          sortDirection: "desc",
          threadId: threadFixture.id,
        },
      },
      {
        method: "thread/turns/list",
        params: {
          itemsView: "summary",
          limit: 12,
          sortDirection: "desc",
          threadId: threadFixture.id,
        },
      },
    ]);
  });

  it("continues loading older item pages with the opaque app-server cursor", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/read") {
          return { thread: { ...threadFixture, turns: [] } };
        }
        if (method === "thread/items/list") {
          return {
            data: [
              {
                item: {
                  content: [{ text: "更早问题", type: "text" }],
                  id: "user-older",
                  type: "userMessage",
                },
                turnId: "turn-older",
              },
            ],
          };
        }
        if (method === "thread/turns/list") {
          return { data: [] };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        protocolCatalog: {
          clientMethods: ["thread/items/list", "thread/turns/list"],
        },
      },
    );

    await expect(
      service.getThread(threadFixture.id, { historyCursor: "opaque-older-page" }),
    ).resolves.toMatchObject({
      items: [{ id: "user-older", kind: "user-message", text: "更早问题" }],
    });
    expect(calls).toContainEqual({
      method: "thread/items/list",
      params: {
        cursor: "opaque-older-page",
        limit: 160,
        sortDirection: "desc",
        threadId: threadFixture.id,
      },
    });
  });

  it("never falls back to an unbounded thread read when bounded history fails", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/read") {
          expect(params).toEqual({ includeTurns: false, threadId: threadFixture.id });
          return { thread: { ...threadFixture, turns: [] } };
        }
        if (method === "thread/turns/list") {
          throw new Error("future protocol mismatch");
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { protocolCatalog: { clientMethods: ["thread/turns/list"] } },
    );

    await expect(service.getThread(threadFixture.id)).rejects.toMatchObject({
      code: "FEATURE_UNAVAILABLE",
    });
    expect(calls).not.toContainEqual({
      method: "thread/read",
      params: { includeTurns: true, threadId: threadFixture.id },
    });
  });

  it("refuses unbounded history when the runtime has no paginated thread method", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { protocolCatalog: { clientMethods: [] } },
    );

    await expect(service.getThread(threadFixture.id)).rejects.toMatchObject({
      code: "FEATURE_UNAVAILABLE",
    });
    expect(calls).toEqual([]);
  });

  it("keeps an active Desktop status conservative when the turn-head capability is unavailable", async () => {
    const desktopThread = {
      ...threadFixture,
      id: "desktop-active-unknown-turn",
      status: { activeFlags: [], type: "active" },
      turns: [],
    };
    const service = createService(
      async (method) => {
        if (method === "thread/loaded/list") return { data: [desktopThread.id] };
        if (method === "thread/resume" || method === "thread/read") {
          return { thread: desktopThread };
        }
        if (method === "thread/turns/list") {
          throw new Error("Method not found");
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { sharedAppServer: true, sharedResumeDelaysMs: [0] },
    );

    await service.resubscribeSharedThreads();
    const detail = await service.getThread(desktopThread.id);
    expect(detail).toMatchObject({
      availableActions: {
        interrupt: false,
        steer: false,
      },
      state: "running",
    });
    expect(detail.activeTurnId).toBeUndefined();
  });

  it("recovers control from a bounded persisted head and bypasses paginated history for a huge active goal", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const desktopThread = {
      ...threadFixture,
      id: "desktop-huge-goal",
      path: "C:\\sessions\\rollout-desktop-huge-goal.jsonl",
      status: { activeFlags: [], type: "active" },
      turns: [],
    };
    const readPersistedConversationItems = vi.fn(async () => [
      {
        id: "persisted-recent",
        kind: "assistant-message" as const,
        text: "最近的有界历史",
        turnId: "tail-active-turn",
      },
    ]);
    const readPersistedThreadHead = vi.fn(async () => ({
      activeTurnId: "tail-active-turn",
      sourceBytes: 1_985_428_985,
    }));
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/resume" || method === "thread/read") {
          return { thread: desktopThread };
        }
        if (method === "thread/goal/set") return {};
        if (method === "turn/steer") return { turnId: "tail-active-turn" };
        if (method === "turn/interrupt") return {};
        if (method === "thread/items/list" || method === "thread/turns/list") {
          throw new Error("huge rollout history must stay off the control path");
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        managedThreadIds: [desktopThread.id],
        protocolCatalog: { clientMethods: ["thread/items/list", "thread/turns/list"] },
        readPersistedConversationItems,
        readPersistedThreadHead,
        sharedAppServer: true,
        sharedResumeDelaysMs: [0],
      },
    );

    await expect(
      service.getThread(desktopThread.id, { includeTurns: false }),
    ).resolves.toMatchObject({
      activeTurnId: "tail-active-turn",
      availableActions: { interrupt: true, reply: false, steer: true },
      state: "running",
    });
    const detail = await service.getThread(desktopThread.id);
    expect(detail.items).toContainEqual(
      expect.objectContaining({ id: "persisted-recent", turnId: "tail-active-turn" }),
    );
    await expect(
      service.steerTurn(desktopThread.id, "tail-active-turn", "继续当前目标"),
    ).resolves.toMatchObject({ state: "running", turnId: "tail-active-turn" });
    await expect(
      service.setThreadGoal(desktopThread.id, { status: "paused" }),
    ).resolves.toBeUndefined();
    await expect(
      service.interruptTurn(desktopThread.id, "tail-active-turn"),
    ).resolves.toMatchObject({ state: "running", turnId: "tail-active-turn" });
    expect(calls).toContainEqual({
      method: "thread/goal/set",
      params: { status: "paused", threadId: desktopThread.id },
    });
    expect(calls).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: desktopThread.id, turnId: "tail-active-turn" },
    });
    expect(calls.some((call) => call.method === "thread/items/list")).toBe(false);
    expect(calls.some((call) => call.method === "thread/turns/list")).toBe(false);
    expect(calls.filter((call) => call.method === "thread/read")).toHaveLength(0);
    expect(calls.filter((call) => call.method === "thread/resume")).toEqual([
      {
        method: "thread/resume",
        params: { excludeTurns: true, threadId: desktopThread.id },
      },
    ]);
    expect(readPersistedThreadHead).toHaveBeenCalledWith(desktopThread.id, desktopThread.path);
  });

  it("keeps cold shared pause, steer, and interrupt paths off thread/read when the persisted head fails", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const desktopThread = {
      ...threadFixture,
      id: "desktop-cold-control",
      path: "C:\\sessions\\rollout-desktop-cold-control.jsonl",
      status: { activeFlags: [], type: "active" },
      turns: [
        {
          id: "desktop-cold-turn",
          items: [],
          startedAt: 1_721_000_001,
          status: "inProgress",
        },
      ],
    };
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/resume" || method === "thread/read") {
          return { thread: desktopThread };
        }
        if (method === "thread/goal/set" || method === "turn/interrupt") return {};
        if (method === "turn/steer") return { turnId: "desktop-cold-turn" };
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        managedThreadIds: [desktopThread.id],
        readPersistedThreadHead: async () => {
          throw new Error("persisted head temporarily unavailable");
        },
        sharedAppServer: true,
        sharedResumeDelaysMs: [0],
      },
    );

    await expect(
      service.getThread(desktopThread.id, { includeTurns: false }),
    ).resolves.toMatchObject({
      activeTurnId: "desktop-cold-turn",
      id: desktopThread.id,
      mode: "managed",
    });
    await expect(
      service.setThreadGoal(desktopThread.id, { status: "paused" }),
    ).resolves.toBeUndefined();
    await expect(
      service.steerTurn(desktopThread.id, "desktop-cold-turn", "继续执行"),
    ).resolves.toMatchObject({ state: "running", turnId: "desktop-cold-turn" });
    await expect(
      service.interruptTurn(desktopThread.id, "desktop-cold-turn"),
    ).resolves.toMatchObject({ state: "running", turnId: "desktop-cold-turn" });

    expect(calls.filter((call) => call.method === "thread/read")).toHaveLength(0);
    expect(calls.filter((call) => call.method === "thread/resume")).toEqual([
      {
        method: "thread/resume",
        params: { excludeTurns: true, threadId: desktopThread.id },
      },
    ]);
  });

  it("fails shared control authorization closed without reading thread history", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const desktopThread = {
      ...threadFixture,
      cwd: "D:\\unregistered",
      id: "desktop-unauthorized-control",
    };
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/resume" || method === "thread/read") {
          return { thread: desktopThread };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        managedThreadIds: [desktopThread.id],
        sharedAppServer: true,
        sharedResumeDelaysMs: [0],
      },
    );

    await expect(
      service.setThreadGoal(desktopThread.id, { status: "paused" }),
    ).rejects.toMatchObject({
      code: "PROJECT_NOT_AUTHORIZED",
    });
    expect(calls.filter((call) => call.method === "thread/read")).toHaveLength(0);
  });

  it("uses bounded shared metadata for usage and permission-profile lookups", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const desktopThread = {
      ...threadFixture,
      id: "desktop-bounded-metadata",
      path: "C:\\sessions\\rollout-desktop-bounded-metadata.jsonl",
    };
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/resume" || method === "thread/read") {
          return { thread: desktopThread };
        }
        if (method === "thread/goal/get") return { goal: null };
        if (method === "permissionProfile/list") return { data: [] };
        if (method === "account/read") return { account: {} };
        if (method === "account/rateLimits/read" || method === "account/usage/read") return {};
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        managedThreadIds: [desktopThread.id],
        readPersistedUsageContext: async () => ({
          limitTokens: 100,
          usedPercent: 25,
          usedTokens: 25,
        }),
        sharedAppServer: true,
        sharedResumeDelaysMs: [0],
      },
    );

    await expect(service.getThreadGoal(desktopThread.id)).resolves.toBeUndefined();
    await expect(
      service.listPermissionProfiles({ threadId: desktopThread.id }),
    ).resolves.toMatchObject({
      data: [],
    });
    await expect(service.getUsage(desktopThread.id)).resolves.toMatchObject({
      data: { context: { limitTokens: 100, usedTokens: 25 } },
    });
    expect(calls.filter((call) => call.method === "thread/read")).toHaveLength(0);
  });

  it.each([undefined, false] as const)(
    "uses a successful shared subscription as the active-turn control contract when the legacy direct-input hint is %s",
    async (directInputHint) => {
      const calls: Array<{ method: string; params?: unknown }> = [];
      const desktopThread = {
        ...threadFixture,
        canAcceptDirectInput: directInputHint,
        id: "desktop-compatible-active",
        status: { activeFlags: [], type: "active" },
        turns: [
          {
            id: "desktop-compatible-turn",
            items: [],
            startedAt: 1_721_000_001,
            status: "inProgress",
          },
        ],
      };
      const service = createService(
        async (method, params) => {
          calls.push({ method, params });
          if (method === "thread/loaded/list") return { data: [desktopThread.id] };
          if (method === "thread/resume" || method === "thread/read") {
            return { thread: desktopThread };
          }
          if (method === "turn/steer") {
            return { turnId: "desktop-compatible-turn" };
          }
          if (method === "turn/interrupt") {
            return {};
          }
          throw new Error(`unexpected method ${method}`);
        },
        undefined,
        undefined,
        { sharedAppServer: true, sharedResumeDelaysMs: [0] },
      );

      await service.resubscribeSharedThreads();
      await expect(service.getThread(desktopThread.id)).resolves.toMatchObject({
        activeTurnId: "desktop-compatible-turn",
        availableActions: {
          interrupt: true,
          reply: false,
          steer: true,
        },
        mode: "managed",
      });
      await expect(
        service.steerTurn(desktopThread.id, "desktop-compatible-turn", "继续兼容控制"),
      ).resolves.toMatchObject({ state: "running", turnId: "desktop-compatible-turn" });
      await expect(
        service.interruptTurn(desktopThread.id, "desktop-compatible-turn"),
      ).resolves.toMatchObject({ state: "running", turnId: "desktop-compatible-turn" });
      expect(calls.map((call) => call.method)).toContain("turn/steer");
      expect(calls.map((call) => call.method)).toContain("turn/interrupt");
    },
  );

  it.each([undefined, false] as const)(
    "allows an idle shared subscribed thread to start its next turn when the legacy direct-input hint is %s",
    async (directInputHint) => {
      const desktopThread = {
        ...threadFixture,
        canAcceptDirectInput: directInputHint,
        id: "desktop-compatible-idle",
      };
      const service = createService(
        async (method) => {
          if (method === "thread/loaded/list") return { data: [desktopThread.id] };
          if (method === "thread/resume" || method === "thread/read") {
            return { thread: desktopThread };
          }
          if (method === "turn/start") {
            return { turn: { id: "desktop-next-turn", items: [], status: "inProgress" } };
          }
          throw new Error(`unexpected method ${method}`);
        },
        undefined,
        undefined,
        { sharedAppServer: true, sharedResumeDelaysMs: [0] },
      );

      await service.resubscribeSharedThreads();
      await expect(service.getThread(desktopThread.id)).resolves.toMatchObject({
        availableActions: {
          interrupt: false,
          reply: true,
          steer: false,
        },
        mode: "managed",
      });
      await expect(
        service.startTurn(desktopThread.id, { prompt: "开始下一轮" }),
      ).resolves.toMatchObject({
        state: "running",
        turnId: "desktop-next-turn",
      });
    },
  );

  it("retries the thread/started persistence race and subscribes before tracking Desktop turns", async () => {
    let resumeAttempts = 0;
    const service = createService(
      async (method) => {
        if (method === "thread/resume") {
          resumeAttempts += 1;
          if (resumeAttempts === 1) throw new Error("no rollout found");
          return { thread: { ...threadFixture, id: "desktop-race" } };
        }
        if (method === "thread/read") {
          return { thread: { ...threadFixture, id: "desktop-race" } };
        }
        if (method === "turn/steer") return { turnId: "desktop-race-turn" };
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { sharedAppServer: true, sharedResumeDelaysMs: [0, 0] },
    );

    service.handleNotification({
      method: "thread/started",
      params: { thread: { ...threadFixture, id: "desktop-race" } },
    });
    await vi.waitFor(() => expect(resumeAttempts).toBe(2));
    service.handleNotification({
      method: "turn/started",
      params: {
        threadId: "desktop-race",
        turn: { id: "desktop-race-turn", status: "inProgress" },
      },
    });

    await expect(
      service.steerTurn("desktop-race", "desktop-race-turn", "竞态后仍可引导"),
    ).resolves.toMatchObject({ turnId: "desktop-race-turn" });
  });

  it("hydrates an incomplete Desktop thread/started shell before publishing a runnable snapshot", async () => {
    const events = new RemoteEventBuffer(8);
    const calls: Array<{ method: string; params?: unknown }> = [];
    const hydratedThread = {
      ...threadFixture,
      id: "desktop-hydrated",
      preview: "桌面刚创建的真实任务",
    };
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/resume") {
          return {
            model: "actual-model",
            reasoningEffort: "high",
            thread: hydratedThread,
          };
        }
        if (method === "thread/read") {
          return { thread: hydratedThread };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        events,
        sharedAppServer: true,
        sharedResumeDelaysMs: [0],
      },
    );

    service.handleNotification({
      method: "thread/started",
      params: { thread: { id: "desktop-hydrated" } },
    });

    expect(service.isManagedThread("desktop-hydrated")).toBe(false);
    expect(events.replayAfter(0).events).toEqual([]);
    await vi.waitFor(() =>
      expect(events.replayAfter(0).events.some((event) => event.type === "thread.snapshot")).toBe(
        true,
      ),
    );

    expect(calls).toEqual([
      {
        method: "thread/resume",
        params: { excludeTurns: true, threadId: "desktop-hydrated" },
      },
    ]);
    const [snapshotEvent] = events.replayAfter(0).events;
    expect(snapshotEvent).toMatchObject({
      threadId: "desktop-hydrated",
      type: "thread.snapshot",
    });
    expect(snapshotEvent?.payload).toMatchObject({
      id: "desktop-hydrated",
      mode: "managed",
      model: "actual-model",
      reasoningEffort: "high",
      title: "桌面刚创建的真实任务",
    });
    expect(service.isManagedThread("desktop-hydrated")).toBe(true);
  });

  it("never promotes an unpersisted Desktop thread/started shell to runnable state", async () => {
    const events = new RemoteEventBuffer(8);
    const service = createService(
      async (method) => {
        if (method === "thread/resume") {
          throw new Error("no rollout found");
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        events,
        sharedAppServer: true,
        sharedResumeDelaysMs: [0],
      },
    );

    service.handleNotification({
      method: "thread/started",
      params: { thread: { id: "desktop-empty-shell" } },
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(service.isManagedThread("desktop-empty-shell")).toBe(false);
    expect(events.replayAfter(0).events).toEqual([]);
  });

  it("opens a shared mobile-created thread only after its first turn is persisted and started", async () => {
    const sequence: string[] = [];
    const notify = vi.fn(async (threadId: string) => {
      sequence.push(`desktop:${threadId}`);
    });
    const service = createService(
      async (method) => {
        sequence.push(method);
        if (method === "thread/start") return { thread: threadFixture };
        if (method === "turn/start") {
          return {
            turn: { id: "turn-new", items: [], status: "inProgress" },
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      notify,
      { sharedAppServer: true, sharedResumeDelaysMs: [0] },
    );

    await service.createThread({
      collaborationMode: "Default",
      model: "gpt-5.3-codex-spark",
      projectId: "project-1",
      prompt: "共享线程首轮",
      reasoningEffort: "xhigh",
    });

    expect(sequence).toEqual(["thread/start", "turn/start", "desktop:thread-new"]);
    expect(notify).toHaveBeenCalledWith("thread-new");
  });

  it("does not navigate Desktop to a shared empty shell when the first turn fails", async () => {
    const notify = vi.fn(async () => undefined);
    const service = createService(
      async (method) => {
        if (method === "thread/start") return { thread: threadFixture };
        if (method === "turn/start") throw new Error("subscription barrier failed");
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      notify,
      { sharedAppServer: true, sharedResumeDelaysMs: [0] },
    );

    await expect(
      service.createThread({ projectId: "project-1", prompt: "不得显示空任务" }),
    ).rejects.toThrow("subscription barrier failed");
    expect(notify).not.toHaveBeenCalled();
  });

  it("resubscribes every broker-loaded thread after a Sidecar reconnect", async () => {
    const resumes: string[] = [];
    const service = createService(
      async (method, params) => {
        if (method === "thread/loaded/list") {
          return { data: ["desktop-active", "mobile-active"] };
        }
        if (method === "thread/resume") {
          const threadId = (params as { threadId: string }).threadId;
          resumes.push(threadId);
          return { thread: { ...threadFixture, id: threadId } };
        }
        if (method === "thread/read") {
          const threadId = (params as { threadId: string }).threadId;
          return { thread: { ...threadFixture, id: threadId } };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { sharedAppServer: true, sharedResumeDelaysMs: [0] },
    );

    await service.resubscribeSharedThreads();

    expect(resumes.sort()).toEqual(["desktop-active", "mobile-active"]);
    expect(service.isManagedThread("desktop-active")).toBe(true);
    expect(service.isManagedThread("mobile-active")).toBe(true);
  });

  it("paginates loaded-thread backfill and resubscribes again after a later reconnect", async () => {
    let backfillPass = 0;
    const resumes: string[] = [];
    const loadedCalls: Array<{ cursor?: string; limit?: number }> = [];
    const service = createService(
      async (method, params) => {
        if (method === "thread/loaded/list") {
          const query = (params ?? {}) as { cursor?: string; limit?: number };
          loadedCalls.push(query);
          if (backfillPass === 0) {
            backfillPass += 1;
            return { data: ["thread-first"] };
          }
          if (query.cursor === "loaded-next") {
            return { data: ["thread-later-b"] };
          }
          return { data: ["thread-first", "thread-later-a"], nextCursor: "loaded-next" };
        }
        if (method === "thread/resume") {
          const threadId = (params as { threadId: string }).threadId;
          resumes.push(threadId);
          return {
            model: `model-for-${threadId}`,
            reasoningEffort: "medium",
            thread: { ...threadFixture, id: threadId },
          };
        }
        if (method === "thread/read") {
          const threadId = (params as { threadId: string }).threadId;
          return { thread: { ...threadFixture, id: threadId } };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { sharedAppServer: true, sharedResumeDelaysMs: [0] },
    );

    await service.resubscribeSharedThreads();
    service.handleBackendRestart();
    await service.resubscribeSharedThreads();

    expect(loadedCalls).toEqual([
      { limit: 100 },
      { limit: 100 },
      { cursor: "loaded-next", limit: 100 },
    ]);
    expect(resumes).toEqual(["thread-first", "thread-first", "thread-later-a", "thread-later-b"]);
    expect(service.isManagedThread("thread-later-b")).toBe(true);
  });

  it("merges active loaded roots into the first current page and folds loaded descendants into them", async () => {
    const activeRoot = {
      ...threadFixture,
      id: "active-root",
      preview: "活跃父任务",
      status: { activeFlags: [], type: "active" },
      updatedAt: 1_721_000_300,
    };
    const waitingChild = {
      ...threadFixture,
      id: "waiting-child",
      parentThreadId: "active-root",
      preview: "等待中的子智能体",
      status: { activeFlags: ["waitingOnApproval"], type: "active" },
      updatedAt: 1_721_000_290,
    };
    const byId = new Map<string, Record<string, unknown>>([
      [activeRoot.id, activeRoot],
      [waitingChild.id, waitingChild],
    ]);
    const service = createService(
      async (method, params) => {
        if (method === "thread/loaded/list") {
          return { data: [activeRoot.id, waitingChild.id] };
        }
        if (method === "thread/resume" || method === "thread/read") {
          const threadId = (params as { threadId: string }).threadId;
          return { thread: byId.get(threadId) };
        }
        if (method === "thread/list") {
          return {
            data: [
              {
                ...threadFixture,
                id: "history-root",
                preview: "历史父任务",
                updatedAt: 1_721_000_200,
              },
            ],
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { sharedAppServer: true, sharedResumeDelaysMs: [0] },
    );

    const result = await service.listThreads();

    expect(result.data.map((thread) => thread.id)).toEqual(["active-root", "history-root"]);
    expect(result.data[0]).toMatchObject({
      childCount: 1,
      mode: "managed",
      state: "waiting-for-approval",
    });
    expect(service.isManagedThread(activeRoot.id)).toBe(true);
    expect(service.isManagedThread(waitingChild.id)).toBe(false);
    expect(result.data.some((thread) => thread.parentThreadId !== undefined)).toBe(false);
  });

  it("promotes the resumable root when only its running child appears in Desktop loaded inventory", async () => {
    const root = {
      ...threadFixture,
      id: "loaded-child-root",
      preview: "桌面正在运行的根任务",
      status: { activeFlags: [], type: "active" },
    };
    const child = {
      ...threadFixture,
      id: "loaded-child-agent",
      parentThreadId: root.id,
      preview: "桌面正在运行的子智能体",
      status: { activeFlags: [], type: "active" },
    };
    const byId = new Map<string, Record<string, unknown>>([
      [root.id, root],
      [child.id, child],
    ]);
    const service = createService(
      async (method, params) => {
        if (method === "thread/loaded/list") {
          return { data: [child.id] };
        }
        if (method === "thread/list") {
          return { data: [child] };
        }
        if (method === "thread/resume" || method === "thread/read") {
          const threadId = (params as { threadId: string }).threadId;
          return { thread: byId.get(threadId) };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { sharedAppServer: true, sharedResumeDelaysMs: [0] },
    );

    await service.resubscribeSharedThreads();

    expect(service.isManagedThread(root.id)).toBe(true);
    expect(service.isManagedThread(child.id)).toBe(false);
    await expect(service.listSubagents(root.id)).resolves.toMatchObject({
      data: [
        expect.objectContaining({
          isDirectlyControllable: false,
          parentThreadId: root.id,
          threadId: child.id,
        }),
      ],
    });
  });

  it("keeps a readable historical Desktop thread as a snapshot when it was never loaded", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const historicalThread = {
      ...threadFixture,
      id: "desktop-history-only",
      preview: "仅历史记录",
      status: { type: "idle" },
    };
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/read") {
          return { thread: historicalThread };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { sharedAppServer: true, sharedResumeDelaysMs: [0] },
    );

    await expect(service.getThread(historicalThread.id)).resolves.toMatchObject({
      id: historicalThread.id,
      mode: "desktop-snapshot",
    });
    expect(service.isManagedThread(historicalThread.id)).toBe(false);
    expect(calls).toEqual([
      {
        method: "thread/read",
        params: { includeTurns: false, threadId: historicalThread.id },
      },
    ]);
  });

  it.each(["waitingOnApproval", "waitingOnUserInput"] as const)(
    "publishes the top-level active snapshot when a child reports %s",
    async (activeFlag) => {
      const events = new RemoteEventBuffer(32);
      const root = {
        ...threadFixture,
        id: "event-root",
        preview: "事件父任务",
      };
      const child = {
        ...threadFixture,
        id: "event-child",
        parentThreadId: root.id,
        preview: "事件子智能体",
      };
      const byId = new Map<string, Record<string, unknown>>([
        [root.id, root],
        [child.id, child],
      ]);
      const service = createService(
        async (method, params) => {
          if (method === "thread/loaded/list") {
            return { data: [root.id, child.id] };
          }
          if (method === "thread/resume" || method === "thread/read") {
            const threadId = (params as { threadId: string }).threadId;
            return { thread: byId.get(threadId) };
          }
          throw new Error(`unexpected method ${method}`);
        },
        undefined,
        undefined,
        {
          events,
          sharedAppServer: true,
          sharedResumeDelaysMs: [0],
        },
      );
      await service.resubscribeSharedThreads();
      const before = events.latestSequence;

      service.handleNotification({
        method: "thread/status/changed",
        params: {
          status: { activeFlags: [activeFlag], type: "active" },
          threadId: child.id,
        },
      });

      const snapshots = events
        .replayAfter(before)
        .events.filter((event) => event.type === "thread.snapshot");
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        threadId: root.id,
        payload: {
          childCount: 1,
          id: root.id,
          mode: "managed",
          state: "waiting-for-approval",
        },
      });
    },
  );

  it("hydrates an unseen child lifecycle notification before publishing its waiting root", async () => {
    const events = new RemoteEventBuffer(32);
    const root = {
      ...threadFixture,
      id: "unseen-event-root",
      preview: "尚未进入侧车缓存的父任务",
    };
    const child = {
      ...threadFixture,
      id: "unseen-event-child",
      parentThreadId: root.id,
      preview: "尚未进入侧车缓存的子智能体",
    };
    const byId = new Map<string, Record<string, unknown>>([
      [root.id, root],
      [child.id, child],
    ]);
    const service = createService(
      async (method, params) => {
        if (method === "thread/resume" || method === "thread/read") {
          const threadId = (params as { threadId: string }).threadId;
          return { thread: byId.get(threadId) };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        events,
        sharedAppServer: true,
        sharedResumeDelaysMs: [0],
      },
    );

    service.handleNotification({
      method: "thread/status/changed",
      params: {
        status: { activeFlags: ["waitingOnApproval"], type: "active" },
        threadId: child.id,
      },
    });

    await vi.waitFor(() => {
      expect(
        events
          .replayAfter(0)
          .events.some(
            (event) =>
              event.type === "thread.snapshot" &&
              event.threadId === root.id &&
              (event.payload as { state?: string }).state === "waiting-for-approval",
          ),
      ).toBe(true);
    });
    expect(service.isManagedThread(root.id)).toBe(true);
    expect(service.isManagedThread(child.id)).toBe(false);
  });

  it("publishes top-level running and terminal snapshots from child and root turn events", async () => {
    const events = new RemoteEventBuffer(32);
    const root = {
      ...threadFixture,
      id: "turn-event-root",
      preview: "轮次父任务",
    };
    const child = {
      ...threadFixture,
      id: "turn-event-child",
      parentThreadId: root.id,
      preview: "轮次子智能体",
    };
    const byId = new Map<string, Record<string, unknown>>([
      [root.id, root],
      [child.id, child],
    ]);
    const service = createService(
      async (method, params) => {
        if (method === "thread/loaded/list") {
          return { data: [root.id, child.id] };
        }
        if (method === "thread/resume" || method === "thread/read") {
          const threadId = (params as { threadId: string }).threadId;
          return { thread: byId.get(threadId) };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        events,
        sharedAppServer: true,
        sharedResumeDelaysMs: [0],
      },
    );
    await service.resubscribeSharedThreads();
    const before = events.latestSequence;

    service.handleNotification({
      method: "turn/started",
      params: {
        threadId: child.id,
        turn: { id: "child-turn", items: [], status: "inProgress" },
      },
    });
    service.handleNotification({
      method: "turn/completed",
      params: {
        threadId: child.id,
        turn: { id: "child-turn", items: [], status: "completed" },
      },
    });
    service.handleNotification({
      method: "turn/started",
      params: {
        threadId: root.id,
        turn: { id: "root-turn", items: [], status: "inProgress" },
      },
    });
    service.handleNotification({
      method: "turn/completed",
      params: {
        threadId: root.id,
        turn: { id: "root-turn", items: [], status: "completed" },
      },
    });

    const states = events
      .replayAfter(before)
      .events.filter((event) => event.type === "thread.snapshot")
      .map((event) => (event.payload as { state?: string }).state);
    expect(states).toEqual(["running", "idle", "running", "complete"]);
  });

  it("reconciles a previously active root to terminal after reconnect even when it left loaded/list", async () => {
    const events = new RemoteEventBuffer(32);
    let reconnecting = false;
    const service = createService(
      async (method, params) => {
        if (method === "thread/loaded/list") {
          return { data: reconnecting ? [] : ["reconnect-root"] };
        }
        if (method === "thread/resume" || method === "thread/read") {
          const threadId = (params as { threadId: string }).threadId;
          return {
            thread: reconnecting
              ? {
                  ...threadFixture,
                  id: threadId,
                  status: { type: "idle" },
                  turns: [{ id: "reconnect-turn", items: [], status: "inProgress" }],
                }
              : {
                  ...threadFixture,
                  id: threadId,
                  status: { activeFlags: [], type: "active" },
                },
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        events,
        sharedAppServer: true,
        sharedResumeDelaysMs: [0],
      },
    );
    await service.resubscribeSharedThreads();
    const before = events.latestSequence;

    service.handleBackendRestart();
    reconnecting = true;
    await service.resubscribeSharedThreads();

    const snapshots = events
      .replayAfter(before)
      .events.filter((event) => event.type === "thread.snapshot");
    expect(snapshots.at(-1)).toMatchObject({
      threadId: "reconnect-root",
      payload: {
        id: "reconnect-root",
        state: "idle",
      },
    });
  });

  it("reserves an ordinary turn before asynchronous authorization can race another tab", async () => {
    const authorizationGate = deferred<void>();
    const authorizationStarted = deferred<void>();
    let blockAuthorization = false;
    let nextTurnStarts = 0;
    let threadReads = 0;
    const service = createService(async (method) => {
      if (method === "thread/start") {
        return { thread: threadFixture };
      }
      if (method === "turn/start") {
        nextTurnStarts += 1;
        return {
          turn: {
            id: nextTurnStarts === 1 ? "turn-initial" : `turn-next-${nextTurnStarts}`,
            items: [],
            startedAt: 1_721_000_001 + nextTurnStarts,
            status: "inProgress",
          },
        };
      }
      if (method === "thread/read") {
        threadReads += 1;
        if (blockAuthorization) {
          authorizationStarted.resolve();
          await authorizationGate.promise;
        }
        return { thread: threadFixture };
      }
      throw new Error(`unexpected method ${method}`);
    });
    await service.createThread({ projectId: "project-1", prompt: "第一轮" });
    service.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-new", turn: { id: "turn-initial", status: "completed" } },
    });
    blockAuthorization = true;

    const first = service.startTurn("thread-new", { prompt: "标签一" });
    await authorizationStarted.promise;
    const second = service.startTurn("thread-new", { prompt: "标签二" });
    await Promise.resolve();
    authorizationGate.resolve();
    const outcomes = await Promise.allSettled([first, second]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      reason: { code: "TURN_MISMATCH" },
    });
    expect(threadReads).toBe(1);
    expect(nextTurnStarts).toBe(2);
  });

  it("runs real manual compaction once and blocks turns and steer until its terminal event", async () => {
    const compactAccepted = deferred<void>();
    const compactRequested = deferred<void>();
    const calls: Array<{ method: string; params?: unknown }> = [];
    let laggingCompactionSnapshot = false;
    let turnStarts = 0;
    const service = createService(async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/start") {
        return { thread: threadFixture };
      }
      if (method === "turn/start") {
        turnStarts += 1;
        return {
          turn: {
            id: turnStarts === 1 ? "turn-initial" : "turn-after-compaction",
            items: [],
            startedAt: 1_721_000_001 + turnStarts,
            status: "inProgress",
          },
        };
      }
      if (method === "thread/read") {
        if (
          laggingCompactionSnapshot &&
          (params as { includeTurns?: boolean } | undefined)?.includeTurns === false
        ) {
          return {
            thread: {
              ...threadFixture,
              status: { activeFlags: [], type: "active" },
              turns: [
                {
                  id: "turn-compact",
                  items: [{ id: "compaction-1", type: "contextCompaction" }],
                  status: "inProgress",
                },
              ],
            },
          };
        }
        return { thread: threadFixture };
      }
      if (method === "thread/compact/start") {
        compactRequested.resolve();
        await compactAccepted.promise;
        return {};
      }
      throw new Error(`unexpected method ${method}`);
    });
    await service.createThread({ projectId: "project-1", prompt: "第一轮" });
    service.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-new", turn: { id: "turn-initial", status: "completed" } },
    });

    const compaction = service.compactThread("thread-new");
    await compactRequested.promise;
    await expect(service.compactThread("thread-new")).rejects.toMatchObject({
      code: "TURN_MISMATCH",
    } satisfies Partial<DomainError>);
    await expect(service.startTurn("thread-new", { prompt: "不能抢跑" })).rejects.toMatchObject({
      code: "TURN_MISMATCH",
    } satisfies Partial<DomainError>);
    await expect(
      service.steerTurn("thread-new", "turn-compact", "不能把压缩当成普通回复"),
    ).rejects.toMatchObject({
      code: "TURN_MISMATCH",
    } satisfies Partial<DomainError>);
    await expect(service.getThread("thread-new")).resolves.toMatchObject({
      availableActions: {
        changeModelNextTurn: false,
        interrupt: false,
        reply: false,
        steer: false,
      },
    });
    compactAccepted.resolve();
    await expect(compaction).resolves.toBeUndefined();

    service.handleNotification({
      method: "turn/started",
      params: {
        threadId: "thread-new",
        turn: { id: "turn-compact", status: "inProgress" },
      },
    });
    service.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-new",
        turn: { id: "turn-unrelated", status: "completed" },
      },
    });
    await expect(
      service.startTurn("thread-new", { prompt: "不能被旁路终态解锁" }),
    ).rejects.toMatchObject({
      code: "TURN_MISMATCH",
    } satisfies Partial<DomainError>);
    service.handleNotification({
      method: "item/started",
      params: {
        item: { id: "compaction-1", type: "contextCompaction" },
        threadId: "thread-new",
        turnId: "turn-compact",
      },
    });
    service.handleNotification({
      method: "item/completed",
      params: {
        item: { id: "compaction-1", type: "contextCompaction" },
        threadId: "thread-new",
        turnId: "turn-compact",
      },
    });
    await expect(service.startTurn("thread-new", { prompt: "仍需等终态" })).rejects.toMatchObject({
      code: "TURN_MISMATCH",
    } satisfies Partial<DomainError>);
    service.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-new",
        turn: { id: "turn-compact", status: "completed" },
      },
    });
    laggingCompactionSnapshot = true;
    await expect(service.getThread("thread-new")).resolves.toMatchObject({
      availableActions: { interrupt: false, reply: false, steer: false },
    });
    laggingCompactionSnapshot = false;

    await expect(service.startTurn("thread-new", { prompt: "压缩后继续" })).resolves.toMatchObject({
      state: "running",
      threadId: "thread-new",
      turnId: "turn-after-compaction",
    });
    expect(calls.filter((call) => call.method === "thread/compact/start")).toEqual([
      {
        method: "thread/compact/start",
        params: { threadId: "thread-new" },
      },
    ]);
    expect(calls.some((call) => call.method === "turn/steer")).toBe(false);
  });

  it("releases automatic context compaction when the same turn starts its next item", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    let turnStarts = 0;
    const service = createService(async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: threadFixture };
      if (method === "thread/read") return { thread: threadFixture };
      if (method === "turn/start") {
        turnStarts += 1;
        return {
          turn: {
            id: turnStarts === 1 ? "turn-initial" : "turn-after-automatic-compaction",
            items: [],
            startedAt: 1_721_000_001 + turnStarts,
            status: "inProgress",
          },
        };
      }
      if (method === "thread/compact/start") return {};
      if (method === "turn/steer") return { turnId: "turn-auto-compact" };
      throw new Error(`unexpected method ${method}`);
    });
    await service.createThread({ projectId: "project-1", prompt: "第一轮" });
    service.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-new", turn: { id: "turn-initial", status: "completed" } },
    });

    service.handleNotification({
      method: "turn/started",
      params: {
        threadId: "thread-new",
        turn: { id: "turn-auto-compact", status: "inProgress" },
      },
    });
    service.handleNotification({
      method: "item/started",
      params: {
        item: { id: "automatic-compaction", type: "contextCompaction" },
        threadId: "thread-new",
        turnId: "turn-auto-compact",
      },
    });

    await expect(service.compactThread("thread-new")).rejects.toMatchObject({
      code: "TURN_MISMATCH",
    });
    await expect(
      service.startTurn("thread-new", { prompt: "不能与自动压缩并发" }),
    ).rejects.toMatchObject({ code: "TURN_MISMATCH" });
    await expect(
      service.steerTurn("thread-new", "turn-auto-compact", "仍需等待"),
    ).rejects.toMatchObject({ code: "TURN_MISMATCH" });
    await expect(service.interruptTurn("thread-new", "turn-auto-compact")).rejects.toMatchObject({
      code: "TURN_MISMATCH",
    });
    await expect(service.getThread("thread-new")).resolves.toMatchObject({
      availableActions: { interrupt: false, reply: false, steer: false },
    });

    service.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-new", turn: { id: "turn-unrelated", status: "completed" } },
    });
    await expect(service.compactThread("thread-new")).rejects.toMatchObject({
      code: "TURN_MISMATCH",
    });

    service.handleNotification({
      method: "item/started",
      params: {
        item: { id: "next-reasoning", type: "reasoning" },
        threadId: "thread-new",
        turnId: "turn-auto-compact",
      },
    });
    await expect(
      service.steerTurn("thread-new", "turn-auto-compact", "压缩结束后继续引导"),
    ).resolves.toMatchObject({
      state: "running",
      turnId: "turn-auto-compact",
    });

    service.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-new",
        turn: { id: "turn-auto-compact", status: "completed" },
      },
    });
    await expect(
      service.startTurn("thread-new", { prompt: "自动压缩后继续" }),
    ).resolves.toMatchObject({
      state: "running",
      turnId: "turn-after-automatic-compaction",
    });
    expect(calls.some((call) => call.method === "thread/compact/start")).toBe(false);
  });

  it("enforces managed direct-input and registered-root gates before compaction", async () => {
    const snapshot = createService(async () => {
      throw new Error("gateway must not be called");
    });
    await expect(snapshot.compactThread("desktop-thread")).rejects.toMatchObject({
      code: "THREAD_READ_ONLY",
    } satisfies Partial<DomainError>);

    const noDirectInput = new CodexDomainService({
      gateway: {
        request: async <T = unknown>(method: string): Promise<T> => {
          if (method === "thread/resume") {
            return {
              thread: {
                ...threadFixture,
                canAcceptDirectInput: false,
                id: "thread-restored",
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
    await expect(noDirectInput.compactThread("thread-restored")).rejects.toMatchObject({
      code: "DIRECT_INPUT_UNAVAILABLE",
    } satisfies Partial<DomainError>);

    let rootAuthorized = true;
    const changedRoot = createService(
      async (method) => {
        if (method === "thread/start") {
          return { thread: threadFixture };
        }
        if (method === "turn/start") {
          return {
            turn: { id: "turn-initial", items: [], status: "inProgress" },
          };
        }
        if (method === "thread/read") {
          return { thread: threadFixture };
        }
        throw new Error(`unexpected method ${method}`);
      },
      async () => (rootAuthorized ? "C:\\workspace\\sample" : undefined),
    );
    await changedRoot.createThread({ projectId: "project-1", prompt: "第一轮" });
    changedRoot.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-new", turn: { id: "turn-initial", status: "completed" } },
    });
    rootAuthorized = false;
    await expect(changedRoot.compactThread("thread-new")).rejects.toMatchObject({
      code: "PROJECT_NOT_AUTHORIZED",
    } satisfies Partial<DomainError>);
  });

  it("releases compaction state after RPC failure, failed terminal notification, and restart", async () => {
    let compactRequests = 0;
    let resumes = 0;
    const service = new CodexDomainService({
      gateway: {
        request: async <T = unknown>(method: string): Promise<T> => {
          if (method === "thread/resume") {
            resumes += 1;
            return {
              thread: { ...threadFixture, id: "thread-restored" },
            } as T;
          }
          if (method === "thread/read") {
            return {
              thread: { ...threadFixture, id: "thread-restored" },
            } as T;
          }
          if (method === "thread/compact/start") {
            compactRequests += 1;
            if (compactRequests === 1) {
              throw new Error("compaction rpc failed");
            }
            return {} as T;
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

    await expect(service.compactThread("thread-restored")).rejects.toThrow("compaction rpc failed");
    await expect(service.compactThread("thread-restored")).resolves.toBeUndefined();
    service.handleNotification({
      method: "turn/started",
      params: {
        threadId: "thread-restored",
        turn: { id: "turn-failed-compaction", status: "inProgress" },
      },
    });
    service.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-restored",
        turn: { id: "turn-failed-compaction", status: "failed" },
      },
    });
    await expect(service.compactThread("thread-restored")).resolves.toBeUndefined();

    service.handleBackendRestart();
    await expect(service.compactThread("thread-restored")).resolves.toBeUndefined();
    expect(compactRequests).toBe(4);
    expect(resumes).toBe(2);
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
        params: { includeTurns: false, threadId: "thread-root" },
      },
      {
        method: "thread/read",
        params: { includeTurns: false, threadId: "sub-legacy-source" },
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

  it("keeps a third-level descendant when its parents are outside the current filtered page", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/list") {
          return (params as { archived?: boolean }).archived
            ? { data: [] }
            : {
                data: [
                  {
                    ...threadFixture,
                    id: "sub-level-3",
                    parentThreadId: "sub-level-2",
                  },
                ],
              };
        }
        if (method === "thread/read") {
          const threadId = (params as { threadId: string }).threadId;
          if (threadId === "sub-level-2") {
            return {
              thread: {
                ...threadFixture,
                id: threadId,
                parentThreadId: "sub-level-1",
              },
            };
          }
          if (threadId === "sub-level-1") {
            return {
              thread: {
                ...threadFixture,
                id: threadId,
                parentThreadId: "thread-root",
              },
            };
          }
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { managedThreadIds: ["thread-root"] },
    );

    const result = await service.listSubagents("thread-root", { limit: 1 });

    expect(result.data).toEqual([
      expect.objectContaining({
        depth: 3,
        parentThreadId: "sub-level-2",
        threadId: "sub-level-3",
      }),
    ]);
    expect(calls.filter((call) => call.method === "thread/read")).toEqual([
      {
        method: "thread/read",
        params: { includeTurns: false, threadId: "thread-root" },
      },
      {
        method: "thread/read",
        params: { includeTurns: false, threadId: "sub-level-2" },
      },
      {
        method: "thread/read",
        params: { includeTurns: false, threadId: "sub-level-1" },
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

  it("marks a short subagent page complete only when paged history and root reads close", async () => {
    const service = createService(
      async (method, params) => {
        const query = params as { archived?: boolean; threadId?: string };
        if (method === "thread/list") {
          return query.archived
            ? { data: [] }
            : {
                data: [
                  {
                    ...threadFixture,
                    id: "sub-verified",
                    parentThreadId: "thread-root",
                  },
                ],
              };
        }
        if (method === "thread/read") {
          return {
            thread: {
              ...threadFixture,
              id: query.threadId,
              parentThreadId:
                query.threadId === "sub-verified" ? "thread-root" : threadFixture.parentThreadId,
            },
          };
        }
        if (method === "thread/items/list") {
          return query.threadId === "thread-root"
            ? {
                data: [
                  {
                    item: {
                      agentPath: "/root/verified",
                      agentThreadId: "sub-verified",
                      kind: "started",
                      type: "subAgentActivity",
                    },
                    turnId: "turn-root",
                  },
                ],
              }
            : { data: [] };
        }
        if (method === "thread/turns/list") {
          return {
            data:
              query.threadId === "thread-root" ? [{ id: "turn-root", status: "completed" }] : [],
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        protocolCatalog: {
          clientMethods: ["thread/items/list", "thread/turns/list"],
        },
      },
    );

    const result = await service.listSubagents("thread-root");

    expect(result.data.map((subagent) => subagent.threadId)).toEqual(["sub-verified"]);
    expect(result.historyIntegrity).toEqual({
      observedCount: 1,
      reason: "verified-exhaustive",
      status: "complete",
      streams: {
        archived: { observedCount: 0, status: "exhausted" },
        current: { observedCount: 1, status: "exhausted" },
      },
    });
  });

  it("does not call an uncorroborated one-item upstream page complete", async () => {
    const service = createService(
      async (method, params) => {
        const query = params as { archived?: boolean; threadId?: string };
        if (method === "thread/list") {
          return query.archived
            ? { data: [] }
            : {
                data: [
                  {
                    ...threadFixture,
                    id: "sub-upstream-only",
                    parentThreadId: "thread-root",
                  },
                ],
              };
        }
        if (method === "thread/read") {
          return {
            thread: {
              ...threadFixture,
              id: query.threadId,
            },
          };
        }
        if (method === "thread/items/list" || method === "thread/turns/list") {
          return { data: [] };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        protocolCatalog: {
          clientMethods: ["thread/items/list", "thread/turns/list"],
        },
      },
    );

    const result = await service.listSubagents("thread-root");

    expect(result.data.map((subagent) => subagent.threadId)).toEqual(["sub-upstream-only"]);
    expect(result.historyIntegrity).toMatchObject({
      observedCount: 1,
      reason: "upstream-short-page-without-cursor",
      status: "unknown",
    });
  });

  it("preserves a retry cursor and reports an interrupted subagent continuation", async () => {
    const service = createService(async (method, params) => {
      const query = params as { archived?: boolean; cursor?: string; threadId?: string };
      if (method === "thread/list") {
        if (query.cursor === "current-next") {
          throw new Error("upstream page interrupted");
        }
        return query.archived
          ? { data: [] }
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
      }
      if (method === "thread/read") {
        return { thread: { ...threadFixture, id: query.threadId } };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const first = await service.listSubagents("thread-root");
    expect(first.historyIntegrity).toMatchObject({
      reason: "pagination-pending",
      status: "partial",
    });
    expect(first.nextCursor).toBeDefined();
    const retryCursor = first.nextCursor;
    if (!retryCursor) {
      throw new Error("expected a retryable subagent cursor");
    }

    const interrupted = await service.listSubagents("thread-root", {
      cursor: retryCursor,
    });

    expect(interrupted.data).toEqual([]);
    expect(interrupted.historyIntegrity).toEqual({
      observedCount: 0,
      reason: "pagination-failed",
      status: "failed",
      streams: {
        archived: { observedCount: 0, status: "not-requested" },
        current: { observedCount: 0, status: "failed" },
      },
    });
    expect(interrupted.nextCursor).toBe(retryCursor);
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

    expect(await service.listProjects()).toEqual([]);
    await service.listThreads({ archived: true });
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
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "thread/list",
      params: {
        archived: true,
        limit: 25,
      },
    });
  });

  it("returns registered projects without launching a competing history scan", async () => {
    let requestCount = 0;
    const service = new CodexDomainService({
      gateway: {
        request: async <T = unknown>(): Promise<T> => {
          requestCount += 1;
          return { data: [] } as T;
        },
      },
      projects: new ProjectRegistry([
        {
          id: "registered",
          name: "已登记项目",
          root: "C:\\workspace\\registered",
        },
      ]),
      resolveRegisteredProjectRoot: async () => "C:\\workspace\\registered",
    });

    const result = await service.listProjects();
    expect(result).toEqual([
      expect.objectContaining({
        id: "registered",
        source: "registered",
      }),
    ]);
    expect(requestCount).toBe(0);
  });

  it("returns the history page when loaded-thread reconciliation is slow", async () => {
    const releaseInventory = deferred<{ data: [] }>();
    const service = createService(
      async (method) => {
        if (method === "thread/loaded/list") {
          return await releaseInventory.promise;
        }
        if (method === "thread/list") {
          return {
            data: [{ ...threadFixture, id: "history-while-inventory-loads" }],
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { sharedAppServer: true, sharedResumeDelaysMs: [0] },
    );

    const result = await Promise.race([
      service.listThreads(),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);
    releaseInventory.resolve({ data: [] });

    expect(result).not.toBe("timeout");
    expect(result).toMatchObject({
      data: [{ id: "history-while-inventory-loads" }],
    });
  });

  it("returns one bounded history page and exposes the runtime cursor", async () => {
    const calls: unknown[] = [];
    const service = createService(async (_method, params) => {
      calls.push(params);
      return {
        data: [{ ...threadFixture, id: "thread-newer", updatedAt: 1_721_000_100 }],
        nextCursor: "page-2",
      };
    });

    const result = await service.listThreads();

    expect(result.data.map((thread) => thread.id)).toEqual(["thread-newer"]);
    expect(result.nextCursor).toBe("page-2");
    expect(calls).toEqual([expect.objectContaining({ archived: false, limit: 25 })]);
  });

  it("projects direct child-agent counts discovered in the aggregated history window", async () => {
    const service = createService(async () => ({
      data: [
        { ...threadFixture, id: "thread-parent", updatedAt: 1_721_000_100 },
        {
          ...threadFixture,
          id: "thread-child-a",
          parentThreadId: "thread-parent",
          updatedAt: 1_721_000_090,
        },
        {
          ...threadFixture,
          id: "thread-child-b",
          parentThreadId: "thread-parent",
          updatedAt: 1_721_000_080,
        },
      ],
    }));

    const result = await service.listThreads();

    expect(result.data.map((thread) => thread.id)).toEqual(["thread-parent"]);
    expect(result.data.find((thread) => thread.id === "thread-parent")?.childCount).toBe(2);
  });

  it("mirrors Desktop pin order and metadata-only reads pinned threads outside the 500-item window", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/list") {
          return {
            data: [
              {
                ...threadFixture,
                id: "thread-recent",
                updatedAt: 1_721_000_300,
              },
              {
                ...threadFixture,
                id: "thread-pinned-present",
                updatedAt: 1_721_000_200,
              },
            ],
          };
        }
        if (method === "thread/read") {
          expect(params).toEqual({ includeTurns: false, threadId: "thread-pinned-old" });
          return {
            thread: {
              ...threadFixture,
              id: "thread-pinned-old",
              updatedAt: 1_700_000_000,
            },
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        listPinnedThreadIds: async () => [
          "thread-pinned-old",
          "thread-pinned-present",
          "thread-pinned-old",
        ],
      },
    );

    const result = await service.listThreads();

    expect(result.data.map((thread) => [thread.id, thread.pinnedRank])).toEqual([
      ["thread-pinned-old", 0],
      ["thread-pinned-present", 1],
      ["thread-recent", undefined],
    ]);
    expect(calls.filter((call) => call.method === "thread/read")).toHaveLength(1);
  });

  it("does not re-inject the pinned first-page group into later cursor pages", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/list") {
          return { data: [{ ...threadFixture, id: "thread-page-two" }] };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        listPinnedThreadIds: async () => ["thread-pinned-old"],
      },
    );

    const result = await service.listThreads({ cursor: "page-two" });

    expect(result.data.map((thread) => thread.id)).toEqual(["thread-page-two"]);
    expect(calls.some((call) => call.method === "thread/read")).toBe(false);
  });

  it("bounds Desktop pin supplements and metadata-read concurrency", async () => {
    let activeReads = 0;
    let maximumActiveReads = 0;
    let readCount = 0;
    const service = createService(
      async (method, params) => {
        if (method === "thread/list") {
          return { data: [] };
        }
        if (method === "thread/read") {
          readCount += 1;
          activeReads += 1;
          maximumActiveReads = Math.max(maximumActiveReads, activeReads);
          await new Promise((resolve) => setTimeout(resolve, 1));
          activeReads -= 1;
          const threadId = (params as { threadId: string }).threadId;
          return { thread: { ...threadFixture, id: threadId } };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        listPinnedThreadIds: async () =>
          Array.from({ length: 105 }, (_, index) => `thread-pin-${index}`),
      },
    );

    const result = await service.listThreads();

    expect(result.data).toHaveLength(100);
    expect(readCount).toBe(100);
    expect(maximumActiveReads).toBeLessThanOrEqual(8);
  });

  it("does not inject unrelated Desktop pins into project or search result pages", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/list") {
          return { data: [{ ...threadFixture, id: "thread-filtered" }] };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        listPinnedThreadIds: async () => ["thread-unrelated-pin"],
      },
    );

    await expect(service.listThreads({ projectId: "project-1" })).resolves.toMatchObject({
      data: [{ id: "thread-filtered" }],
    });
    await expect(service.listThreads({ searchTerm: "命中词" })).resolves.toMatchObject({
      data: [{ id: "thread-filtered" }],
    });

    expect(calls.some((call) => call.method === "thread/read")).toBe(false);
  });

  it("renames an authorized stored thread without resuming it and publishes the new title", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const events = new RemoteEventBuffer(8);
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/read") {
          return { thread: { ...threadFixture, id: "thread-rename" } };
        }
        if (method === "thread/name/set") {
          return {};
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        events,
        protocolCatalog: {
          clientMethods: ["thread/name/set", "thread/turns/list"],
        },
      },
    );

    await service.setThreadName("thread-rename", "新的对话名称");

    expect(calls).toEqual([
      {
        method: "thread/read",
        params: { includeTurns: false, threadId: "thread-rename" },
      },
      {
        method: "thread/name/set",
        params: { name: "新的对话名称", threadId: "thread-rename" },
      },
    ]);
    expect(events.replayAfter(0).events).toContainEqual(
      expect.objectContaining({
        threadId: "thread-rename",
        type: "thread.updated",
        payload: { name: "新的对话名称", threadId: "thread-rename" },
      }),
    );
  });

  it("rejects an overlong thread name before reading or mutating the thread", async () => {
    const request = vi.fn(async () => ({}));
    const service = createService(request);

    await expect(service.setThreadName("thread-rename", "名".repeat(201))).rejects.toMatchObject({
      code: "INVALID_INPUT",
      httpStatus: 400,
    } satisfies Partial<DomainError>);
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps a Desktop-origin renamed title in the shared cache across later lifecycle updates", async () => {
    const threadId = "thread-desktop-renamed";
    const events = new RemoteEventBuffer(32);
    const storedThread = {
      ...threadFixture,
      id: threadId,
      name: "旧名称",
      preview: "旧预览",
    };
    const service = createService(
      async (method, params) => {
        if (method === "thread/loaded/list") {
          return { data: [threadId] };
        }
        if (method === "thread/resume" || method === "thread/read") {
          expect((params as { threadId: string }).threadId).toBe(threadId);
          return { thread: storedThread };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        events,
        sharedAppServer: true,
        sharedResumeDelaysMs: [0],
      },
    );
    await service.resubscribeSharedThreads();
    const before = events.latestSequence;

    service.handleNotification({
      method: "thread/name/updated",
      params: { threadId, threadName: "新名称" },
    });
    service.handleNotification({
      method: "thread/status/changed",
      params: { status: { type: "idle" }, threadId },
    });

    const snapshots = events
      .replayAfter(before)
      .events.filter((event) => event.type === "thread.snapshot");
    expect(snapshots.at(-1)).toMatchObject({
      payload: { id: threadId, title: "新名称" },
      threadId,
    });
  });

  it("archives an authorized idle thread, durably releases management, and publishes convergence", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const events = new RemoteEventBuffer(8);
    const unpersistManagedThread = vi.fn(async (_threadId: string) => undefined);
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/read") {
          return { thread: { ...threadFixture, id: "thread-archive" } };
        }
        if (method === "thread/archive") {
          return {};
        }
        if (method === "thread/unsubscribe") {
          return { status: "unsubscribed" };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        events,
        managedThreadIds: ["thread-archive"],
        protocolCatalog: {
          clientMethods: [
            "thread/archive",
            "thread/name/set",
            "thread/turns/list",
            "thread/unarchive",
            "thread/unsubscribe",
          ],
        },
        unpersistManagedThread,
      },
    );

    await service.setThreadArchived("thread-archive", true);

    expect(calls.slice(0, 2)).toEqual([
      {
        method: "thread/read",
        params: { includeTurns: false, threadId: "thread-archive" },
      },
      {
        method: "thread/archive",
        params: { threadId: "thread-archive" },
      },
    ]);
    expect(unpersistManagedThread).toHaveBeenCalledWith("thread-archive");
    expect(service.isManagedThread("thread-archive")).toBe(false);
    expect(events.replayAfter(0).events).toContainEqual(
      expect.objectContaining({
        threadId: "thread-archive",
        type: "thread.updated",
        payload: { archived: true, threadId: "thread-archive" },
      }),
    );
  });

  it("restores an archived authorized thread and publishes convergence", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const events = new RemoteEventBuffer(8);
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/read") {
          return { thread: { ...threadFixture, id: "thread-restore" } };
        }
        if (method === "thread/unarchive") {
          return { thread: { ...threadFixture, id: "thread-restore" } };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        events,
        protocolCatalog: {
          clientMethods: ["thread/archive", "thread/turns/list", "thread/unarchive"],
        },
      },
    );

    await service.setThreadArchived("thread-restore", false);

    expect(calls).toEqual([
      {
        method: "thread/read",
        params: { includeTurns: false, threadId: "thread-restore" },
      },
      {
        method: "thread/unarchive",
        params: { threadId: "thread-restore" },
      },
    ]);
    expect(events.replayAfter(0).events).toContainEqual(
      expect.objectContaining({
        threadId: "thread-restore",
        type: "thread.updated",
        payload: { archived: false, threadId: "thread-restore" },
      }),
    );
  });

  it("fails closed before archive mutation when the runtime lacks the official pair", async () => {
    const request = vi.fn(async () => ({}));
    const service = createService(request, undefined, undefined, {
      protocolCatalog: { clientMethods: ["thread/archive", "thread/turns/list"] },
    });

    await expect(service.setThreadArchived("thread-archive", true)).rejects.toMatchObject({
      code: "FEATURE_UNAVAILABLE",
      httpStatus: 409,
    } satisfies Partial<DomainError>);
    expect(request).not.toHaveBeenCalled();
  });

  it("does not archive an active thread", async () => {
    const calls: string[] = [];
    const service = createService(
      async (method) => {
        calls.push(method);
        if (method === "thread/read") {
          return {
            thread: {
              ...threadFixture,
              id: "thread-running",
              status: { activeFlags: [], type: "active" },
            },
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        protocolCatalog: {
          clientMethods: ["thread/archive", "thread/turns/list", "thread/unarchive"],
        },
      },
    );

    await expect(service.setThreadArchived("thread-running", true)).rejects.toMatchObject({
      code: "THREAD_READ_ONLY",
      httpStatus: 409,
    } satisfies Partial<DomainError>);
    expect(calls).toEqual(["thread/read"]);
  });

  it("does not archive while context compaction is still active", async () => {
    const threadId = "thread-compacting";
    const calls: string[] = [];
    const service = createService(
      async (method) => {
        calls.push(method);
        if (method === "thread/read") {
          return { thread: { ...threadFixture, id: threadId, status: { type: "idle" } } };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        managedThreadIds: [threadId],
        protocolCatalog: {
          clientMethods: ["thread/archive", "thread/turns/list", "thread/unarchive"],
        },
      },
    );
    service.handleNotification({
      method: "item/started",
      params: {
        item: { id: "compaction-item", type: "contextCompaction" },
        threadId,
        turnId: "turn-compacting",
      },
    });

    await expect(service.setThreadArchived(threadId, true)).rejects.toMatchObject({
      code: "THREAD_READ_ONLY",
      httpStatus: 409,
    } satisfies Partial<DomainError>);
    expect(calls).toEqual(["thread/read"]);
  });

  it("restores durable management when archive fails after release", async () => {
    const persistManagedThread = vi.fn(
      async (_threadId: string, _options: { desktopNotificationPending: boolean }) => undefined,
    );
    const unpersistManagedThread = vi.fn(async (_threadId: string) => undefined);
    const service = createService(
      async (method) => {
        if (method === "thread/read") {
          return { thread: { ...threadFixture, id: "thread-archive-fails" } };
        }
        if (method === "thread/archive") {
          throw new Error("archive failed");
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        managedThreadIds: ["thread-archive-fails"],
        persistManagedThread,
        protocolCatalog: {
          clientMethods: ["thread/archive", "thread/turns/list", "thread/unarchive"],
        },
        unpersistManagedThread,
      },
    );

    await expect(service.setThreadArchived("thread-archive-fails", true)).rejects.toThrow(
      "archive failed",
    );
    expect(unpersistManagedThread).toHaveBeenCalledWith("thread-archive-fails");
    expect(persistManagedThread).toHaveBeenCalledWith("thread-archive-fails", {
      desktopNotificationPending: false,
    });
    expect(service.isManagedThread("thread-archive-fails")).toBe(true);
  });

  it("persists an archive intent before release and settles it only after the RPC succeeds", async () => {
    const order: string[] = [];
    const archiveIntent = {
      desktopNotificationPending: true,
      managed: true,
      targetArchived: true,
      threadId: "thread-durable-archive",
    };
    const beginArchiveIntent = vi.fn(async () => {
      order.push("begin-intent");
      return archiveIntent;
    });
    const unpersistManagedThread = vi.fn(async () => {
      order.push("release-managed");
    });
    const settleArchiveIntent = vi.fn(async (_threadId: string, observedArchived: boolean) => {
      order.push(`settle-${String(observedArchived)}`);
    });
    const service = createService(
      async (method) => {
        if (method === "thread/read") {
          return { thread: { ...threadFixture, id: archiveIntent.threadId } };
        }
        if (method === "thread/archive") {
          order.push("archive-rpc");
          return {};
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        beginArchiveIntent,
        managedThreadIds: [archiveIntent.threadId],
        protocolCatalog: {
          clientMethods: ["thread/archive", "thread/turns/list", "thread/unarchive"],
        },
        settleArchiveIntent,
        unpersistManagedThread,
      },
    );

    await service.setThreadArchived(archiveIntent.threadId, true);

    expect(order).toEqual(["begin-intent", "release-managed", "archive-rpc", "settle-true"]);
    expect(beginArchiveIntent).toHaveBeenCalledWith(archiveIntent.threadId, true);
    expect(settleArchiveIntent).toHaveBeenCalledWith(archiveIntent.threadId, true);
    expect(service.isManagedThread(archiveIntent.threadId)).toBe(false);
  });

  it("preserves the archive failure and a durable recovery intent when compensation persistence fails", async () => {
    const archiveFailure = new Error("archive failed at app-server");
    const compensationFailure = new Error("state restore failed");
    const archiveIntent = {
      desktopNotificationPending: true,
      managed: true,
      targetArchived: true,
      threadId: "thread-compensation-fails",
    };
    const service = createService(
      async (method) => {
        if (method === "thread/read") {
          return { thread: { ...threadFixture, id: archiveIntent.threadId } };
        }
        if (method === "thread/archive") {
          throw archiveFailure;
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        archiveIntents: [],
        beginArchiveIntent: async () => archiveIntent,
        managedThreadIds: [archiveIntent.threadId],
        protocolCatalog: {
          clientMethods: ["thread/archive", "thread/turns/list", "thread/unarchive"],
        },
        settleArchiveIntent: async () => {
          throw compensationFailure;
        },
        unpersistManagedThread: async () => undefined,
      },
    );

    let failure: unknown;
    try {
      await service.setThreadArchived(archiveIntent.threadId, true);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([archiveFailure, compensationFailure]);
    expect(service.isManagedThread(archiveIntent.threadId)).toBe(true);
  });

  it.each([
    { archived: false, expectedManaged: true, stream: "current" },
    { archived: true, expectedManaged: false, stream: "archived" },
  ] as const)(
    "reconciles a restarted archive intent from the authoritative $stream list without replaying the RPC",
    async ({ archived, expectedManaged }) => {
      const threadId = `thread-restart-${archived ? "archived" : "current"}`;
      const archiveIntent = {
        desktopNotificationPending: true,
        managed: true,
        targetArchived: true,
        threadId,
      };
      const calls: Array<{ method: string; params?: unknown }> = [];
      const settleArchiveIntent = vi.fn(async () => undefined);
      const service = createService(
        async (method, params) => {
          calls.push({ method, params });
          if (method === "thread/list") {
            const requestedArchived = (params as { archived?: boolean }).archived === true;
            return {
              data: requestedArchived === archived ? [{ ...threadFixture, id: threadId }] : [],
            };
          }
          if (method === "thread/loaded/list") {
            return { data: [] };
          }
          if (method === "thread/resume" || method === "thread/read") {
            return { thread: { ...threadFixture, id: threadId } };
          }
          if (method === "thread/turns/list") {
            return { data: [] };
          }
          throw new Error(`unexpected method ${method}`);
        },
        undefined,
        undefined,
        {
          archiveIntents: [archiveIntent],
          protocolCatalog: {
            clientMethods: ["thread/archive", "thread/turns/list", "thread/unarchive"],
          },
          settleArchiveIntent,
          sharedAppServer: true,
          sharedResumeDelaysMs: [0],
        },
      );

      await service.resubscribeSharedThreads();

      expect(settleArchiveIntent).toHaveBeenCalledWith(threadId, archived);
      if (expectedManaged) {
        await expect(service.getThread(threadId)).resolves.toMatchObject({ mode: "managed" });
      }
      expect(service.isManagedThread(threadId)).toBe(expectedManaged);
      expect(calls.some((call) => call.method === "thread/archive")).toBe(false);
    },
  );

  it("cleans a stale managed id from an authoritative archived list even if intent creation crashed", async () => {
    const threadId = "thread-archived-before-intent-write";
    const settleArchiveIntent = vi.fn(async () => undefined);
    const service = createService(
      async (method, params) => {
        if (method === "thread/list") {
          return (params as { archived?: boolean }).archived === true
            ? { data: [{ ...threadFixture, id: threadId }] }
            : { data: [] };
        }
        if (method === "thread/loaded/list") {
          return { data: [] };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        managedThreadIds: [threadId],
        settleArchiveIntent,
        sharedAppServer: true,
        sharedResumeDelaysMs: [0],
      },
    );

    await service.resubscribeSharedThreads();

    expect(settleArchiveIntent).toHaveBeenCalledWith(threadId, true);
    expect(service.isManagedThread(threadId)).toBe(false);
  });

  it("retries Desktop-origin archived cleanup within one bounded attempt", async () => {
    const threadId = "thread-desktop-archived";
    const archiveIntent = {
      desktopNotificationPending: false,
      managed: true,
      targetArchived: true,
      threadId,
    };
    const beginArchiveIntent = vi.fn(async () => archiveIntent);
    const unpersistManagedThread = vi
      .fn<(threadId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("first write failed"))
      .mockRejectedValueOnce(new Error("second write failed"))
      .mockResolvedValue(undefined);
    const settleArchiveIntent = vi.fn(async () => undefined);
    const service = createService(async () => ({}), undefined, undefined, {
      archiveCleanupRetryDelaysMs: [0, 0, 0],
      beginArchiveIntent,
      managedThreadIds: [threadId],
      settleArchiveIntent,
      unpersistManagedThread,
    });

    service.handleNotification({
      method: "thread/archived",
      params: { threadId },
    });

    await vi.waitFor(() => {
      expect(unpersistManagedThread).toHaveBeenCalledTimes(3);
      expect(settleArchiveIntent).toHaveBeenCalledWith(threadId, true);
    });
    expect(beginArchiveIntent).toHaveBeenCalledWith(threadId, true);
    expect(service.isManagedThread(threadId)).toBe(false);
  });

  it("rejects archiving a subagent thread before any mutation or ownership release", async () => {
    const beginArchiveIntent = vi.fn();
    const unpersistManagedThread = vi.fn();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/read") {
        return {
          thread: {
            ...threadFixture,
            id: "thread-child-archive",
            parentThreadId: "thread-root",
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const service = createService(request, undefined, undefined, {
      beginArchiveIntent,
      managedThreadIds: ["thread-child-archive"],
      protocolCatalog: {
        clientMethods: ["thread/archive", "thread/turns/list", "thread/unarchive"],
      },
      unpersistManagedThread,
    });

    await expect(service.setThreadArchived("thread-child-archive", true)).rejects.toMatchObject({
      code: "THREAD_READ_ONLY",
      httpStatus: 409,
    } satisfies Partial<DomainError>);
    expect(beginArchiveIntent).not.toHaveBeenCalled();
    expect(unpersistManagedThread).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("awaits the complete shared inventory and rejects an unseen active child before archiving its root", async () => {
    const root = {
      ...threadFixture,
      id: "archive-root-with-unseen-active-child",
      status: { type: "idle" },
    };
    const child = {
      ...threadFixture,
      id: "unseen-active-child",
      parentThreadId: root.id,
      status: { activeFlags: [], type: "active" },
    };
    const byId = new Map<string, Record<string, unknown>>([
      [root.id, root],
      [child.id, child],
    ]);
    const calls: string[] = [];
    const service = createService(
      async (method, params) => {
        calls.push(method);
        if (method === "thread/loaded/list") {
          return { data: [child.id] };
        }
        if (method === "thread/resume" || method === "thread/read") {
          const threadId = (params as { threadId: string }).threadId;
          return { thread: byId.get(threadId) };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        protocolCatalog: {
          clientMethods: ["thread/archive", "thread/turns/list", "thread/unarchive"],
        },
        sharedAppServer: true,
        sharedResumeDelaysMs: [0],
      },
    );

    await expect(service.setThreadArchived(root.id, true)).rejects.toMatchObject({
      code: "THREAD_READ_ONLY",
      httpStatus: 409,
    } satisfies Partial<DomainError>);
    expect(calls).toContain("thread/loaded/list");
    expect(calls).not.toContain("thread/archive");
  });

  it("fails closed when loaded-thread inventory still has a cursor after the bounded page limit", async () => {
    const threadId = "archive-root-incomplete-loaded-pages";
    let loadedCalls = 0;
    let archiveCalls = 0;
    const service = createService(
      async (method) => {
        if (method === "thread/read") {
          return { thread: { ...threadFixture, id: threadId } };
        }
        if (method === "thread/loaded/list") {
          loadedCalls += 1;
          return { data: [], nextCursor: `loaded-page-${loadedCalls}` };
        }
        if (method === "thread/archive") {
          archiveCalls += 1;
          return {};
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        protocolCatalog: {
          clientMethods: ["thread/archive", "thread/turns/list", "thread/unarchive"],
        },
        sharedAppServer: true,
        sharedResumeDelaysMs: [0],
      },
    );

    await expect(service.setThreadArchived(threadId, true)).rejects.toMatchObject({
      code: "THREAD_READ_ONLY",
      httpStatus: 409,
    } satisfies Partial<DomainError>);
    expect(loadedCalls).toBe(20);
    expect(archiveCalls).toBe(0);
  });

  it("fails closed when loaded-thread inventory repeats a cursor or a listed thread cannot hydrate", async () => {
    const rootId = "archive-root-unsafe-inventory";
    for (const failure of ["repeated-cursor", "hydrate-failed"] as const) {
      let loadedCalls = 0;
      let archiveCalls = 0;
      const service = createService(
        async (method, params) => {
          if (method === "thread/read") {
            const requestedThreadId = (params as { threadId: string }).threadId;
            if (requestedThreadId === rootId) {
              return { thread: { ...threadFixture, id: rootId } };
            }
            throw new Error("listed child cannot hydrate");
          }
          if (method === "thread/loaded/list") {
            loadedCalls += 1;
            return failure === "repeated-cursor"
              ? { data: [], nextCursor: "same-cursor" }
              : { data: ["unreadable-loaded-child"] };
          }
          if (method === "thread/resume") {
            throw new Error("listed child cannot hydrate");
          }
          if (method === "thread/archive") {
            archiveCalls += 1;
            return {};
          }
          throw new Error(`unexpected method ${method}`);
        },
        undefined,
        undefined,
        {
          protocolCatalog: {
            clientMethods: ["thread/archive", "thread/turns/list", "thread/unarchive"],
          },
          sharedAppServer: true,
          sharedResumeDelaysMs: [0],
        },
      );

      await expect(service.setThreadArchived(rootId, true)).rejects.toMatchObject({
        code: "THREAD_READ_ONLY",
        httpStatus: 409,
      } satisfies Partial<DomainError>);
      expect(loadedCalls).toBe(failure === "repeated-cursor" ? 2 : 1);
      expect(archiveCalls).toBe(0);
    }
  });

  it("serializes concurrent archive mutations so a late failure cannot restore a successful archive", async () => {
    const threadId = "thread-concurrent-archive";
    const firstArchiveGate = deferred<void>();
    let archiveCalls = 0;
    let persistedManaged = true;
    let persistedIntent:
      | {
          desktopNotificationPending: boolean;
          managed: boolean;
          targetArchived: boolean;
          threadId: string;
        }
      | undefined;
    const service = createService(
      async (method) => {
        if (method === "thread/read") {
          return { thread: { ...threadFixture, id: threadId } };
        }
        if (method === "thread/archive") {
          archiveCalls += 1;
          if (archiveCalls === 1) {
            await firstArchiveGate.promise;
            return {};
          }
          throw new Error("second archive failed");
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        beginArchiveIntent: async () => {
          persistedIntent ??= {
            desktopNotificationPending: false,
            managed: persistedManaged,
            targetArchived: true,
            threadId,
          };
          return persistedIntent;
        },
        managedThreadIds: [threadId],
        protocolCatalog: {
          clientMethods: ["thread/archive", "thread/turns/list", "thread/unarchive"],
        },
        settleArchiveIntent: async (_threadId, observedArchived) => {
          if (!observedArchived && persistedIntent?.managed) {
            persistedManaged = true;
          }
          persistedIntent = undefined;
        },
        unpersistManagedThread: async () => {
          persistedManaged = false;
        },
      },
    );

    const first = service.setThreadArchived(threadId, true);
    const second = service.setThreadArchived(threadId, true);
    await vi.waitFor(() => {
      expect(archiveCalls).toBe(1);
    });
    firstArchiveGate.resolve();

    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toThrow("second archive failed");
    expect(archiveCalls).toBe(2);
    expect(persistedManaged).toBe(false);
    expect(service.isManagedThread(threadId)).toBe(false);
  });

  it("lets an authoritative Desktop archive cleanup win over a lost Web archive response", async () => {
    const threadId = "thread-desktop-archive-response-loss";
    const archiveResponse = deferred<void>();
    let persistedManaged = true;
    let persistedIntent:
      | {
          desktopNotificationPending: boolean;
          managed: boolean;
          targetArchived: boolean;
          threadId: string;
        }
      | undefined;
    const settleObservations: boolean[] = [];
    const service = createService(
      async (method) => {
        if (method === "thread/read") {
          return { thread: { ...threadFixture, id: threadId } };
        }
        if (method === "thread/archive") {
          await archiveResponse.promise;
          return {};
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        archiveCleanupRetryDelaysMs: [0],
        beginArchiveIntent: async () => {
          persistedIntent ??= {
            desktopNotificationPending: false,
            managed: persistedManaged,
            targetArchived: true,
            threadId,
          };
          return persistedIntent;
        },
        managedThreadIds: [threadId],
        protocolCatalog: {
          clientMethods: ["thread/archive", "thread/turns/list", "thread/unarchive"],
        },
        settleArchiveIntent: async (_threadId, observedArchived) => {
          settleObservations.push(observedArchived);
          persistedManaged = observedArchived ? false : (persistedIntent?.managed ?? false);
          persistedIntent = undefined;
        },
        unpersistManagedThread: async () => {
          persistedManaged = false;
        },
      },
    );

    const archive = service.setThreadArchived(threadId, true);
    await vi.waitFor(() => {
      expect(persistedManaged).toBe(false);
    });
    service.handleNotification({
      method: "thread/archived",
      params: { threadId },
    });
    archiveResponse.reject(new Error("archive response lost"));

    await expect(archive).rejects.toThrow("archive response lost");
    await vi.waitFor(() => {
      expect(settleObservations).toEqual([false, true]);
    });
    expect(persistedManaged).toBe(false);
    expect(service.isManagedThread(threadId)).toBe(false);
  });

  it("does not re-add a pinned thread to current history after Web archives it", async () => {
    const threadId = "thread-pinned-then-archived";
    let archived = false;
    const calls: string[] = [];
    const archiveIntent = {
      desktopNotificationPending: false,
      managed: true,
      targetArchived: true,
      threadId,
    };
    const service = createService(
      async (method) => {
        calls.push(method);
        if (method === "thread/read") {
          return { thread: { ...threadFixture, id: threadId } };
        }
        if (method === "thread/archive") {
          archived = true;
          return {};
        }
        if (method === "thread/list") {
          return { data: archived ? [] : [{ ...threadFixture, id: threadId }] };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        beginArchiveIntent: async () => archiveIntent,
        listPinnedThreadIds: async () => [threadId],
        managedThreadIds: [threadId],
        protocolCatalog: {
          clientMethods: ["thread/archive", "thread/turns/list", "thread/unarchive"],
        },
        settleArchiveIntent: async () => undefined,
        unpersistManagedThread: async () => undefined,
      },
    );

    await service.setThreadArchived(threadId, true);
    const current = await service.listThreads();

    expect(current.data).toEqual([]);
    expect(calls.filter((method) => method === "thread/read")).toHaveLength(1);
  });

  it("keeps a Desktop-pinned archived thread out of current history after restart reconciliation", async () => {
    const threadId = "thread-restarted-pinned-archived";
    const calls: string[] = [];
    let archivedListCalls = 0;
    const service = createService(
      async (method, params) => {
        calls.push(method);
        if (method === "thread/list") {
          if ((params as { archived?: boolean }).archived === true) {
            archivedListCalls += 1;
            return { data: [{ ...threadFixture, id: threadId }] };
          }
          return { data: [] };
        }
        if (method === "thread/loaded/list") {
          return { data: [] };
        }
        if (method === "thread/read") {
          return { thread: { ...threadFixture, id: threadId } };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      {
        listPinnedThreadIds: async () => [threadId],
        protocolCatalog: {
          clientMethods: ["thread/archive", "thread/turns/list", "thread/unarchive"],
        },
        sharedAppServer: true,
        sharedResumeDelaysMs: [0],
      },
    );

    await service.resubscribeSharedThreads();
    const current = await service.listThreads();

    expect(current.data).toEqual([]);
    expect(calls).not.toContain("thread/read");
    expect(archivedListCalls).toBe(1);
  });

  it("keeps archived history on an explicit independent cursor stream", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const service = createService(
      async (method, params) => {
        calls.push({ method, params });
        if (method !== "thread/list") {
          throw new Error(`unexpected method ${method}`);
        }
        return {
          data: [{ ...threadFixture, id: "thread-archived" }],
          nextCursor: "archived-next",
        };
      },
      undefined,
      undefined,
      {
        listPinnedThreadIds: async () => ["thread-active-pin"],
      },
    );

    const result = await service.listThreads({
      archived: true,
      cursor: "archived-current",
      limit: 25,
    });

    expect(calls).toEqual([
      {
        method: "thread/list",
        params: {
          archived: true,
          cursor: "archived-current",
          limit: 25,
          sortDirection: "desc",
          sortKey: "updated_at",
        },
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
        request: adaptLegacyHistoryRequest(async <T = unknown>(method: string): Promise<T> => {
          if (method !== "thread/read") {
            throw new Error(`unexpected method ${method}`);
          }
          return { thread: threadFixture } as T;
        }),
      },
      projects: new ProjectRegistry([
        { id: "project-1", name: "示例项目", root: "C:\\workspace\\sample" },
      ]),
      protocolCatalog: { clientMethods: ["thread/turns/list"] },
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

  it("prefers actual response and latest turn settings while leaving absent restored settings unknown", async () => {
    const service = createService(async (method) => {
      if (method !== "thread/read") {
        throw new Error(`unexpected method ${method}`);
      }
      return {
        model: "response-model",
        reasoningEffort: "high",
        thread: {
          ...threadFixture,
          model: "thread-model",
          settings: { effort: "low", model: "thread-settings-model" },
          turns: [
            {
              effort: "medium",
              id: "turn-settings",
              items: [],
              model: "turn-model",
              status: "completed",
            },
          ],
        },
      };
    });

    await expect(service.getThread("thread-new")).resolves.toMatchObject({
      model: "response-model",
      reasoningEffort: "high",
    });

    const restoredWithoutActualSettings = new CodexDomainService({
      gateway: {
        request: async <T = unknown>(): Promise<T> =>
          ({
            thread: {
              ...threadFixture,
              id: "thread-restored-unknown",
            },
          }) as T,
      },
      managedThreadIds: ["thread-restored-unknown"],
      projects: new ProjectRegistry([
        { id: "project-1", name: "示例项目", root: "C:\\workspace\\sample" },
      ]),
      resolveRegisteredProjectRoot: async () => "C:\\workspace\\sample",
    });
    const restored = await restoredWithoutActualSettings.getThread("thread-restored-unknown");
    expect(restored.mode).toBe("managed");
    expect(restored.model).toBeUndefined();
    expect(restored.reasoningEffort).toBeUndefined();
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

  it("hydrates recoverable context usage from thread snapshots and leaves unsupported history unavailable", async () => {
    const service = createService(async (method) => {
      if (method === "thread/read") {
        return {
          thread: {
            ...threadFixture,
            tokenUsage: {
              last: { totalTokens: 32_000 },
              modelContextWindow: 128_000,
              total: { totalTokens: 96_000 },
            },
          },
        };
      }
      if (method === "account/read") {
        return { account: { planType: "plus" } };
      }
      if (method === "account/rateLimits/read") {
        return { rateLimitsByLimitId: {} };
      }
      if (method === "account/usage/read") {
        return { dailyUsageBuckets: [], summary: {} };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await service.getThread("thread-new");
    await expect(service.getUsage("thread-new")).resolves.toMatchObject({
      data: {
        context: {
          limitTokens: 128_000,
          usedPercent: 25,
          usedTokens: 32_000,
        },
      },
    });

    const unavailable = createService(async (method) => {
      if (method === "thread/read") {
        return { thread: threadFixture };
      }
      if (method === "account/read") {
        return { account: { planType: "plus" } };
      }
      if (method === "account/rateLimits/read") {
        return { rateLimitsByLimitId: {} };
      }
      if (method === "account/usage/read") {
        return { dailyUsageBuckets: [], summary: {} };
      }
      throw new Error(`unexpected method ${method}`);
    });
    await unavailable.getThread("thread-new");
    const missing = await unavailable.getUsage("thread-new");
    expect(missing.data.context).toBeUndefined();
    expect(JSON.stringify(missing.data)).not.toContain('"usedTokens":0');
    expect(JSON.stringify(missing.data)).not.toContain('"limitTokens":0');
  });

  it("uses a read-only Desktop session fallback only when thread/read omits context usage", async () => {
    const readPersistedUsageContext = vi.fn(
      async (
        threadId: string,
        sessionPath?: string,
      ): Promise<NonNullable<UsageSnapshot["context"]>> => {
        expect(threadId).toBe("thread-new");
        expect(sessionPath).toBe("C:\\TestCodexHome\\sessions\\thread-new.jsonl");
        return {
          limitTokens: 258_400,
          usedPercent: 92.42,
          usedTokens: 238_814,
        };
      },
    );
    const service = createService(
      async (method) => {
        if (method === "thread/read") {
          return {
            thread: {
              ...threadFixture,
              path: "C:\\TestCodexHome\\sessions\\thread-new.jsonl",
            },
          };
        }
        if (method === "account/read") {
          return { account: { planType: "plus" } };
        }
        if (method === "account/rateLimits/read") {
          return { rateLimitsByLimitId: {} };
        }
        if (method === "account/usage/read") {
          return { dailyUsageBuckets: [], summary: {} };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { readPersistedUsageContext },
    );

    const usage = await service.getUsage("thread-new");
    expect(usage).toMatchObject({
      data: {
        context: {
          limitTokens: 258_400,
          usedTokens: 238_814,
        },
      },
    });
    expect(usage.data.context?.usedPercent).toBeCloseTo(92.42, 2);
    expect(readPersistedUsageContext).toHaveBeenCalledTimes(1);
  });

  it("prefers the app-server context snapshot over the persisted session fallback", async () => {
    const readPersistedUsageContext = vi.fn(async () => ({
      limitTokens: 999,
      usedPercent: 99,
      usedTokens: 989,
    }));
    const service = createService(
      async (method) => {
        if (method === "thread/read") {
          return {
            thread: {
              ...threadFixture,
              path: "C:\\TestCodexHome\\sessions\\thread-new.jsonl",
              tokenUsage: {
                last: { totalTokens: 32_000 },
                modelContextWindow: 128_000,
              },
            },
          };
        }
        if (method === "account/read") {
          return { account: { planType: "plus" } };
        }
        if (method === "account/rateLimits/read") {
          return { rateLimitsByLimitId: {} };
        }
        if (method === "account/usage/read") {
          return { dailyUsageBuckets: [], summary: {} };
        }
        throw new Error(`unexpected method ${method}`);
      },
      undefined,
      undefined,
      { readPersistedUsageContext },
    );

    await expect(service.getUsage("thread-new")).resolves.toMatchObject({
      data: {
        context: {
          limitTokens: 128_000,
          usedPercent: 25,
          usedTokens: 32_000,
        },
      },
    });
    expect(readPersistedUsageContext).not.toHaveBeenCalled();
  });

  it("refreshes context usage from a lightweight thread snapshot on every usage read", async () => {
    let threadReadCount = 0;
    const threadReadParams: unknown[] = [];
    const service = createService(async (method, params) => {
      if (method === "thread/read") {
        threadReadParams.push(params);
        threadReadCount += 1;
        return {
          thread: {
            ...threadFixture,
            tokenUsage: {
              last: { totalTokens: threadReadCount === 1 ? 89_000 : 102_000 },
              modelContextWindow: 258_000,
            },
          },
        };
      }
      if (method === "account/read") {
        return { account: { planType: "pro" } };
      }
      if (method === "account/rateLimits/read") {
        return { rateLimitsByLimitId: {} };
      }
      if (method === "account/usage/read") {
        return { dailyUsageBuckets: [], summary: {} };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await expect(service.getUsage("thread-live")).resolves.toMatchObject({
      data: {
        context: {
          limitTokens: 258_000,
          usedTokens: 89_000,
        },
      },
    });
    await expect(service.getUsage("thread-live")).resolves.toMatchObject({
      data: {
        context: {
          limitTokens: 258_000,
          usedTokens: 102_000,
        },
      },
    });
    expect(threadReadParams).toEqual([
      { includeTurns: false, threadId: "thread-live" },
      { includeTurns: false, threadId: "thread-live" },
    ]);
  });
});
