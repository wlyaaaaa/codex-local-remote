import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  CreateThreadInput,
  LocalInputReference,
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

function createService(
  request: (method: string, params?: unknown) => Promise<unknown>,
  resolveRegisteredProjectRoot: (projectId: string) => Promise<string | undefined> = async (
    projectId,
  ) => (projectId === "project-1" ? "C:\\workspace\\sample" : undefined),
  notifyManagedThreadCreated?: (threadId: string) => void | Promise<void>,
  options: {
    events?: RemoteEventBuffer;
    generalConversationRoot?: string;
    listPinnedThreadIds?: () => Promise<readonly string[]>;
    managedThreadIds?: Iterable<string>;
    protocolCatalog?: {
      approvalPolicies?: readonly string[];
      approvalReviewers?: readonly string[];
    };
    readPersistedUsageContext?: (
      threadId: string,
      sessionPath?: string,
    ) => Promise<NonNullable<UsageSnapshot["context"]> | undefined>;
    resolveLocalInputReference?: (reference: LocalInputReference) => Promise<{
      kind: "file" | "directory";
      name: string;
      path: string;
    }>;
    sharedAppServer?: boolean;
    sharedResumeDelaysMs?: number[];
  } = {},
): CodexDomainService {
  return new CodexDomainService({
    gateway: {
      request: async <T = unknown>(method: string, params?: unknown): Promise<T> =>
        (await request(method, params)) as T,
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
    ...(options.generalConversationRoot === undefined
      ? {}
      : { generalConversationRoot: options.generalConversationRoot }),
    ...(options.listPinnedThreadIds === undefined
      ? {}
      : { listPinnedThreadIds: options.listPinnedThreadIds }),
    ...(options.protocolCatalog === undefined ? {} : { protocolCatalog: options.protocolCatalog }),
    ...(options.readPersistedUsageContext === undefined
      ? {}
      : { readPersistedUsageContext: options.readPersistedUsageContext }),
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
    const registry = new ProjectRegistry([{ id: "agents", name: ".agents", root: "E:\\.agents" }]);

    expect(registry.findIdByCwd("\\\\?\\E:\\.agents")).toBe("agents");
    expect(registry.findIdByCwd("\\\\?\\e:\\.AGENTS\\")).toBe("agents");
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
    await service.clearThreadGoal("thread-goal");
    expect(calls).toContainEqual({
      method: "thread/goal/set",
      params: {
        objective: "继续完成真实验收",
        threadId: "thread-goal",
        tokenBudget: 50_000,
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
          const includeTurns = (params as { includeTurns?: boolean }).includeTurns;
          return {
            thread: {
              ...threadFixture,
              cwd: generalConversationRoot,
              status: { type: "idle" },
              turns:
                includeTurns === true
                  ? [
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
                    ]
                  : [],
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
        request: async <T = unknown>(method: string): Promise<T> => {
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
        },
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

    await service.createThread({ projectId: "project-1", prompt: "极快完成" });

    await expect(service.startTurn(threadId, { prompt: "继续执行" })).resolves.toMatchObject({
      state: "running",
      threadId,
      turnId: "turn-second",
    });
    expect(turnStarts).toBe(2);
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
        request: async <T = unknown>(method: string): Promise<T> => {
          methods.push(method);
          if (method === "thread/start") {
            return { thread: { ...threadFixture, id: threadId } } as T;
          }
          if (method === "turn/start") {
            throw new Error("turn start failed");
          }
          throw new Error(`unexpected method ${method}`);
        },
      },
      notifyManagedThreadCreated,
      persistManagedThread,
      projects: new ProjectRegistry([
        { id: "project-1", name: "示例项目", root: "C:\\workspace\\sample" },
      ]),
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
        request: async <T = unknown>(method: string): Promise<T> => {
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
        },
      },
      notifyManagedThreadCreated,
      persistManagedThread: async () => undefined,
      projects: new ProjectRegistry([
        { id: "project-1", name: "示例项目", root: "C:\\workspace\\sample" },
      ]),
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
        request: async <T = unknown>(method: string, params?: unknown): Promise<T> => {
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
      },
      managedThreadIds: [historicalId, terminalId, activeId],
      notifyManagedThreadCreated,
      pendingDesktopNotificationThreadIds: [terminalId, activeId],
      projects: new ProjectRegistry(),
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
        request: async <T = unknown>(method: string): Promise<T> => {
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
        },
      },
      notifyManagedThreadCreated,
      persistManagedThread: async () => undefined,
      projects: new ProjectRegistry([
        { id: "project-1", name: "示例项目", root: "C:\\workspace\\sample" },
      ]),
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
        request: async <T = unknown>(method: string, params?: unknown): Promise<T> => {
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
      },
      managedThreadIds: [threadId],
      notifyManagedThreadCreated,
      pendingDesktopNotificationThreadIds: [threadId],
      projects: new ProjectRegistry(),
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
        request: async <T = unknown>(method: string, params?: unknown): Promise<T> => {
          calls.push({ method, params });
          if (method === "thread/resume" || method === "thread/read") {
            return { thread: desktopThread } as T;
          }
          throw new Error(`unexpected method ${method}`);
        },
      },
      persistManagedThread,
      projects: new ProjectRegistry([
        { id: "project-1", name: "示例项目", root: "C:\\workspace\\sample" },
      ]),
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
      { sharedAppServer: true, sharedResumeDelaysMs: [0] },
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
      "thread/read",
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
      { sharedAppServer: true, sharedResumeDelaysMs: [0] },
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
        itemsView: "summary",
        limit: 1,
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
      {
        method: "thread/read",
        params: { includeTurns: false, threadId: "desktop-hydrated" },
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
        params: { includeTurns: true, threadId: historicalThread.id },
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
                  turns: [{ id: "reconnect-turn", items: [], status: "completed" }],
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
        state: "complete",
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
          (params as { includeTurns?: boolean } | undefined)?.includeTurns === true
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
