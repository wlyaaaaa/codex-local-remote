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
): CodexDomainService {
  return new CodexDomainService({
    gateway: {
      request: async <T = unknown>(method: string, params?: unknown): Promise<T> =>
        (await request(method, params)) as T,
    },
    ...(notifyManagedThreadCreated === undefined ? {} : { notifyManagedThreadCreated }),
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
    const service = createService(async () => ({}));

    await expect(service.steerTurn("desktop-thread", "turn-1", "补充要求")).rejects.toMatchObject({
      code: "THREAD_READ_ONLY",
    } satisfies Partial<DomainError>);
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

  it("tracks automatic context compaction and blocks every competing mutation until its turn ends", async () => {
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
