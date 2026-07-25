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
  probeAppServerCapabilities,
  type AppServerSession,
  type CapabilitySupport,
} from "./supervisor.js";

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
      return {};
    });

    await expect(probeAppServerCapabilities(request, 50)).resolves.toEqual({
      account: { state: "available" },
      collaborationModes: {
        reason: "method-not-supported",
        state: "unavailable",
      },
      models: { state: "available" },
      permissions: { state: "available" },
      rateLimits: { state: "available" },
      usage: {
        reason: "probe-failed",
        state: "degraded",
      },
    });
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
