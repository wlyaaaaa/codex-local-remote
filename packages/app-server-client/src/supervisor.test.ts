import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { CodexExecutable } from "./discovery.js";
import {
  JsonlRpcConnection,
  RpcConnectionClosedError,
  RpcRequestError,
} from "./jsonl-connection.js";
import {
  AppServerSupervisor,
  ChildProcessAppServerSession,
  connectSharedAppServerSession,
  probeAppServerCapabilities,
  SharedAppServerConnectionError,
  type AppServerSession,
  type CapabilitySupport,
} from "./supervisor.js";
import type { WebSocketLike } from "./websocket-connection.js";

function available(): CapabilitySupport {
  return { state: "available" };
}

function createChildFixture(): {
  child: ChildProcessWithoutNullStreams;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const kill = vi.fn(() => true);
  Object.assign(child, {
    exitCode: null,
    kill,
    signalCode: null,
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    stdout: new PassThrough(),
  });
  return { child, kill };
}

function createChildSession(
  child: ChildProcessWithoutNullStreams,
  connection: JsonlRpcConnection,
): ChildProcessAppServerSession {
  return new ChildProcessAppServerSession(
    child,
    connection,
    "desktop-user-bundle",
    {
      codexHome: "C:\\fixture",
      platformFamily: "windows",
      platformOs: "windows",
      userAgent: "codex-cli/fixture",
    },
    {
      account: available(),
      collaborationModes: available(),
      models: available(),
      permissions: available(),
      rateLimits: available(),
      usage: available(),
    },
  );
}

function createSession(
  request = vi.fn(async (_method: string, _params?: unknown) => ({ ok: true })),
): AppServerSession & { exit(): void } {
  const exitListeners = new Set<(error?: Error) => void>();
  return {
    capabilities: {
      account: available(),
      collaborationModes: available(),
      models: available(),
      permissions: available(),
      rateLimits: available(),
      usage: available(),
    },
    executableSource: "desktop-user-bundle",
    initialization: {
      codexHome: "C:\\fixture",
      platformFamily: "windows",
      platformOs: "windows",
      userAgent: "codex-cli/fixture",
    },
    exit() {
      for (const listener of exitListeners) {
        listener(new Error("fixture exit"));
      }
    },
    notify: vi.fn(async () => undefined),
    onExit(listener) {
      exitListeners.add(listener);
      return () => {
        exitListeners.delete(listener);
      };
    },
    onNotification() {
      return () => undefined;
    },
    onServerRequest() {
      return () => undefined;
    },
    request: async <T = unknown>(method: string, params?: unknown): Promise<T> =>
      (await request(method, params)) as T,
    stop: vi.fn(async () => undefined),
  };
}

describe("probeAppServerCapabilities", () => {
  it("keeps startup usable when optional methods are missing or temporarily fail", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "collaborationMode/list") {
        throw new RpcRequestError(method, -32601, "Method not found");
      }
      if (method === "account/usage/read") {
        throw new RpcRequestError(method, -32_000, "Temporarily unavailable");
      }
      if (method === "model/list") {
        return {
          data: [
            {
              model: "fixture",
              serviceTiers: [{ id: "fast", name: "Fast" }],
            },
          ],
        };
      }
      return {};
    });

    await expect(probeAppServerCapabilities(request, 50)).resolves.toEqual({
      account: { state: "available" },
      approvalReviewers: {
        reason: "not-advertised",
        state: "unavailable",
      },
      collaborationModes: {
        reason: "method-not-supported",
        state: "unavailable",
      },
      compact: { state: "available" },
      goals: { state: "available" },
      models: { state: "available" },
      permissions: { state: "available" },
      rateLimits: { state: "available" },
      serviceTiers: { state: "available" },
      settingsUpdate: { state: "available" },
      threadList: { state: "available" },
      usage: {
        reason: "probe-failed",
        state: "degraded",
      },
    });
  });

  it("enables reviewer selection only from a non-empty runtime requirements catalog", async () => {
    const request = vi.fn(async (method: string) =>
      method === "configRequirements/read"
        ? {
            requirements: {
              allowedApprovalsReviewers: ["user", "future-reviewer"],
            },
          }
        : {},
    );

    const capabilities = await probeAppServerCapabilities(request, 50);

    expect(capabilities.approvalReviewers).toEqual({ state: "available" });
    expect(request).toHaveBeenCalledWith("configRequirements/read", undefined, {
      timeoutMs: 50,
    });
  });

  it("only treats a structured method-bound sentinel miss as proof of method presence", async () => {
    const sentinelThreadId = "00000000-0000-0000-0000-000000000000";
    const request = vi.fn(async (method: string) => {
      if (method === "thread/compact/start") {
        throw new RpcRequestError(method, -32_601, "Method not found");
      }
      if (method === "thread/goal/get") {
        throw new RpcRequestError(method, -32_000, "opaque", {
          kind: "not_found",
          method,
          resource: "thread",
          resourceId: sentinelThreadId,
          details: { source: "future-runtime" },
        });
      }
      if (method === "thread/settings/update") {
        throw new RpcRequestError(method, -32_000, "Thread not found");
      }
      return {};
    });

    const capabilities = await probeAppServerCapabilities(request, 50);

    expect(capabilities.compact).toEqual({
      reason: "method-not-supported",
      state: "unavailable",
    });
    expect(capabilities.goals).toEqual({ state: "available" });
    expect(capabilities.settingsUpdate).toEqual({
      reason: "probe-failed",
      state: "degraded",
    });
  });

  it.each([
    {
      code: -32_001,
      data: { kind: "authentication_failed" },
      label: "authentication failure",
    },
    {
      code: -32_602,
      data: { field: "threadId" },
      label: "invalid params",
    },
    {
      code: -32_000,
      data: undefined,
      label: "generic server failure with a tempting message",
    },
  ])("keeps $label degraded during a method-presence probe", async ({ code, data }) => {
    const request = vi.fn(async (method: string) => {
      if (method === "thread/goal/get") {
        throw new RpcRequestError(method, code, "Thread not found", data);
      }
      return {};
    });

    const capabilities = await probeAppServerCapabilities(request, 50);

    expect(capabilities.goals).toEqual({
      reason: "probe-failed",
      state: "degraded",
    });
  });

  it("derives service-tier support only from model metadata", async () => {
    const requestWithoutTiers = vi.fn(async (method: string) =>
      method === "model/list" ? { data: [{ model: "fixture" }] } : {},
    );
    const requestWithTierOnSecondPage = vi.fn(async (method: string, params?: unknown) => {
      if (method !== "model/list") return {};
      return (params as { cursor?: string } | undefined)?.cursor === "models-2"
        ? {
            data: [
              {
                model: "future-tier-model",
                serviceTiers: [{ id: "fast", name: "快速" }],
              },
            ],
          }
        : { data: [{ model: "fixture" }], nextCursor: "models-2" };
    });

    await expect(probeAppServerCapabilities(requestWithoutTiers, 50)).resolves.toMatchObject({
      models: { state: "available" },
      serviceTiers: { reason: "not-advertised", state: "unavailable" },
    });
    await expect(
      probeAppServerCapabilities(requestWithTierOnSecondPage, 50),
    ).resolves.toMatchObject({
      models: { state: "available" },
      serviceTiers: { state: "available" },
    });
    expect(requestWithTierOnSecondPage).toHaveBeenCalledWith(
      "model/list",
      { cursor: "models-2", includeHidden: false, limit: 100 },
      { timeoutMs: 50 },
    );
  });
});

describe("AppServerSupervisor", () => {
  it("tries the next executable when a candidate cannot initialize", async () => {
    const first = { path: "C:\\Desktop\\codex.exe", source: "desktop-user-bundle" as const };
    const second = { path: "D:\\bin\\codex.exe", source: "path" as const };
    const goodSession = createSession();
    const launchCandidate = vi.fn(async (candidate: CodexExecutable) => {
      if (candidate === first) {
        throw new Error("access denied");
      }
      return goodSession;
    });
    const supervisor = new AppServerSupervisor({
      candidateProvider: async () => ({
        candidates: [first, second],
        diagnostics: [],
      }),
      launchCandidate,
      restartDelaysMs: [10],
    });

    await supervisor.start();

    expect(launchCandidate).toHaveBeenNthCalledWith(1, first);
    expect(launchCandidate).toHaveBeenNthCalledWith(2, second);
    expect(supervisor.snapshot()).toMatchObject({
      codexHome: "C:\\fixture",
      executableSource: "desktop-user-bundle",
      state: "running",
    });
    await expect(supervisor.request("model/list", {})).resolves.toEqual({ ok: true });
  });

  it("restarts after an unexpected exit and stops retrying after an explicit stop", async () => {
    vi.useFakeTimers();
    try {
      const candidate = { path: "C:\\Desktop\\codex.exe", source: "desktop-user-bundle" as const };
      const firstSession = createSession();
      const sessions = [firstSession, createSession()];
      const launchCandidate = vi.fn(async () => sessions.shift() ?? createSession());
      const supervisor = new AppServerSupervisor({
        candidateProvider: async () => ({ candidates: [candidate], diagnostics: [] }),
        launchCandidate,
        restartDelaysMs: [10, 20],
      });

      await supervisor.start();
      firstSession.exit();

      expect(supervisor.snapshot().state).toBe("degraded");
      await vi.advanceTimersByTimeAsync(10);
      expect(launchCandidate).toHaveBeenCalledTimes(2);
      expect(supervisor.snapshot().state).toBe("running");

      await supervisor.stop();
      await vi.advanceTimersByTimeAsync(100);
      expect(launchCandidate).toHaveBeenCalledTimes(2);
      expect(supervisor.snapshot().state).toBe("stopped");
    } finally {
      vi.useRealTimers();
    }
  });

  it("degrades and retries when executable discovery itself fails", async () => {
    vi.useFakeTimers();
    try {
      const candidate = {
        path: "C:\\Desktop\\codex.exe",
        source: "desktop-user-bundle" as const,
      };
      const candidateProvider = vi
        .fn<() => Promise<{ candidates: CodexExecutable[]; diagnostics: [] }>>()
        .mockRejectedValueOnce(new Error("temporary discovery failure"))
        .mockResolvedValue({ candidates: [candidate], diagnostics: [] });
      const supervisor = new AppServerSupervisor({
        candidateProvider,
        launchCandidate: vi.fn(async () => createSession()),
        restartDelaysMs: [10],
      });

      await expect(supervisor.start()).rejects.toBeInstanceOf(Error);
      expect(supervisor.snapshot()).toMatchObject({
        restartAttempt: 1,
        state: "degraded",
      });

      await vi.advanceTimersByTimeAsync(10);
      expect(candidateProvider).toHaveBeenCalledTimes(2);
      expect(supervisor.snapshot().state).toBe("running");
      await supervisor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses only the explicit shared connector, then degrades and reconnects after disconnect", async () => {
    vi.useFakeTimers();
    try {
      const candidateProvider = vi.fn(async () => ({ candidates: [], diagnostics: [] }));
      const launchCandidate = vi.fn(async () => createSession());
      const firstSession = createSession();
      const secondSession = createSession();
      const sessions = [firstSession, secondSession];
      const connectSharedSession = vi.fn(async () => sessions.shift() ?? createSession());
      const supervisor = new AppServerSupervisor({
        mode: "shared-websocket",
        endpoint: "ws://127.0.0.1:4747",
        candidateProvider,
        connectSharedSession,
        launchCandidate,
        restartDelaysMs: [10],
      });

      await supervisor.start();
      expect(supervisor.snapshot()).toMatchObject({
        endpoint: "ws://127.0.0.1:4747/",
        mode: "shared-websocket",
        state: "running",
      });
      expect(candidateProvider).not.toHaveBeenCalled();
      expect(launchCandidate).not.toHaveBeenCalled();

      firstSession.exit();
      expect(supervisor.snapshot().state).toBe("degraded");
      await vi.advanceTimersByTimeAsync(10);

      expect(connectSharedSession).toHaveBeenCalledTimes(2);
      expect(supervisor.snapshot().state).toBe("running");
      await supervisor.stop();
      expect((secondSession.stop as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
      expect(candidateProvider).not.toHaveBeenCalled();
      expect(launchCandidate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never falls back to discovery or stdio when the shared endpoint is unavailable", async () => {
    const candidateProvider = vi.fn(async () => ({
      candidates: [{ path: "C:\\codex.exe", source: "path" as const }],
      diagnostics: [],
    }));
    const launchCandidate = vi.fn(async () => createSession());
    const supervisor = new AppServerSupervisor({
      mode: "shared-websocket",
      endpoint: "ws://127.0.0.1:4747",
      candidateProvider,
      connectSharedSession: vi.fn(async () => {
        throw new Error("connection refused");
      }),
      launchCandidate,
      restartDelaysMs: [60_000],
    });

    await expect(supervisor.start()).rejects.toBeInstanceOf(SharedAppServerConnectionError);
    expect(supervisor.snapshot().state).toBe("degraded");
    expect(candidateProvider).not.toHaveBeenCalled();
    expect(launchCandidate).not.toHaveBeenCalled();
    await supervisor.stop();
  });
});

class SharedSessionFakeWebSocket extends EventTarget implements WebSocketLike {
  readonly close = vi.fn(() => {
    this.readyState = 3;
  });
  readonly sent: string[] = [];
  readyState = 0;

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  send(data: string): void {
    this.sent.push(data);
    const request = JSON.parse(data) as {
      id?: string | number;
      method?: string;
    };
    if (request.id === undefined) {
      return;
    }
    queueMicrotask(() => {
      this.receive(
        JSON.stringify({
          id: request.id,
          result:
            request.method === "initialize"
              ? {
                  codexHome: "C:\\fixture",
                  platformFamily: "windows",
                  platformOs: "windows",
                  userAgent: "codex-cli/shared-fixture",
                }
              : {},
        }),
      );
    });
  }
}

describe("connectSharedAppServerSession", () => {
  it("connects, initializes, probes capabilities, and stop never owns the broker", async () => {
    const socket = new SharedSessionFakeWebSocket();
    const sessionPromise = connectSharedAppServerSession("ws://127.0.0.1:4747", {
      clientVersion: "0.1.0",
      webSocketFactory: () => {
        queueMicrotask(() => {
          socket.open();
        });
        return socket;
      },
    });

    const session = await sessionPromise;

    expect(session.initialization.userAgent).toBe("codex-cli/shared-fixture");
    expect(session.capabilities).toEqual({
      account: { state: "available" },
      approvalReviewers: { reason: "not-advertised", state: "unavailable" },
      collaborationModes: { state: "available" },
      compact: { state: "available" },
      goals: { state: "available" },
      models: { state: "available" },
      permissions: { state: "available" },
      rateLimits: { state: "available" },
      serviceTiers: { reason: "probe-failed", state: "degraded" },
      settingsUpdate: { state: "available" },
      threadList: { state: "available" },
      usage: { state: "available" },
    });
    expect(
      socket.sent.map((message) => {
        const envelope = JSON.parse(message) as Record<string, unknown>;
        return envelope.method;
      }),
    ).toEqual(
      expect.arrayContaining([
        "initialize",
        "initialized",
        "model/list",
        "account/read",
        "account/rateLimits/read",
        "account/usage/read",
        "permissionProfile/list",
        "collaborationMode/list",
        "thread/list",
      ]),
    );

    await session.stop();
    expect(socket.close).toHaveBeenCalledTimes(1);
  });
});

describe("ChildProcessAppServerSession", () => {
  it("turns an oversized JSONL close into one exit and terminates the owned child", async () => {
    const { child, kill } = createChildFixture();
    const connection = new JsonlRpcConnection({
      maxBufferBytes: 16,
      readable: child.stdout,
      writable: child.stdin,
    });
    const session = createChildSession(child, connection);
    const exits: Array<Error | undefined> = [];
    session.onExit((error) => {
      exits.push(error);
    });

    (child.stdout as PassThrough).write("x".repeat(17));
    await vi.waitFor(() => {
      expect(exits).toHaveLength(1);
    });
    expect(exits[0]).toBeInstanceOf(RpcConnectionClosedError);
    expect(kill).toHaveBeenCalledTimes(1);

    connection.close(new RpcConnectionClosedError("late duplicate close"));
    child.emit("exit", 1, null);
    await Promise.resolve();
    expect(exits).toHaveLength(1);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("rejects construction over an already closed transport and reaps the child", () => {
    const { child, kill } = createChildFixture();
    const connection = new JsonlRpcConnection({
      readable: child.stdout,
      writable: child.stdin,
    });
    const reason = new RpcConnectionClosedError("transport already closed");
    connection.close(reason);

    expect(() => createChildSession(child, connection)).toThrow(reason);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("notifies a late supervisor subscriber when the transport closes in the attach race", async () => {
    const { child } = createChildFixture();
    const connection = new JsonlRpcConnection({
      readable: child.stdout,
      writable: child.stdin,
    });
    const session = createChildSession(child, connection);
    const reason = new RpcConnectionClosedError("closed before supervisor attach");
    connection.close(reason);
    const exit = vi.fn();

    session.onExit(exit);
    await Promise.resolve();

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(reason);
  });
});
