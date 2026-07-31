import { describe, expect, it, vi } from "vitest";

import { reconcileBrokerLifecycle } from "./unsafe-reconciliation.js";

const CAPABILITY_TOKEN = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

describe("reconcileBrokerLifecycle", () => {
  it("connects as a temporary Sidecar and asks the Broker to converge its loaded union", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const close = vi.fn();
    const notify = vi.fn(async () => undefined);
    const connection: {
      close(): void;
      notify(method: string, params?: unknown): Promise<void>;
      request<T = unknown>(method: string, params?: unknown): Promise<T>;
    } = {
      close,
      notify,
      async request<T = unknown>(method: string, params?: unknown): Promise<T> {
        calls.push({ method, ...(params === undefined ? {} : { params }) });
        if (method === "initialize") {
          return {
            codexHome: "C:\\fixture",
            platformFamily: "windows",
            platformOs: "windows",
            userAgent: "fixture",
          } as T;
        }
        if (method === "thread/loaded/list") {
          return { data: ["thread-a", "thread-b"], nextCursor: null } as T;
        }
        if (method === "thread/resume") {
          return {
            thread: { id: (params as { threadId: string }).threadId, status: "idle" },
          } as T;
        }
        throw new Error("unexpected method");
      },
    };
    const connect = vi.fn(async () => connection);

    await expect(
      reconcileBrokerLifecycle(
        { capabilityToken: CAPABILITY_TOKEN, port: 18_791, timeoutMs: 30_000 },
        { connect },
      ),
    ).resolves.toEqual({
      hasMore: false,
      observedThreadCount: 2,
      resumedThreadCount: 2,
      signature: "codex-local-remote/broker-lifecycle-reconciliation/v1",
      status: "reconciled",
      version: 1,
    });
    expect(connect).toHaveBeenCalledWith(`ws://127.0.0.1:18791/ws/${CAPABILITY_TOKEN}`, 30_000);
    expect(calls.map((call) => call.method)).toEqual([
      "initialize",
      "thread/loaded/list",
      "thread/resume",
      "thread/resume",
    ]);
    expect(calls.slice(2).map((call) => call.params)).toEqual([
      { threadId: "thread-a" },
      { threadId: "thread-b" },
    ]);
    expect(notify).toHaveBeenCalledWith("initialized");
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the temporary connection when convergence returns an invalid page", async () => {
    const close = vi.fn();
    const connection: {
      close(): void;
      notify(method: string, params?: unknown): Promise<void>;
      request<T = unknown>(method: string, params?: unknown): Promise<T>;
    } = {
      close,
      notify: vi.fn(async () => undefined),
      async request<T = unknown>(method: string): Promise<T> {
        return method === "initialize"
          ? ({
              codexHome: "C:\\fixture",
              platformFamily: "windows",
              platformOs: "windows",
              userAgent: "fixture",
            } as T)
          : ({ data: "invalid", nextCursor: null } as T);
      },
    };

    await expect(
      reconcileBrokerLifecycle(
        { capabilityToken: CAPABILITY_TOKEN, port: 18_791 },
        { connect: async () => connection },
      ),
    ).rejects.toThrow("invalid loaded-thread page");
    expect(close).toHaveBeenCalledOnce();
  });
});
