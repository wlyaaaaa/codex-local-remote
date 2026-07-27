import { describe, expect, it, vi } from "vitest";

import {
  RpcConnectionClosedError,
  RpcTimeoutError,
  type RpcServerRequest,
} from "./jsonl-connection.js";
import { WebSocketRpcConnection, type WebSocketLike } from "./websocket-connection.js";

class FakeWebSocket extends EventTarget implements WebSocketLike {
  readonly sent: string[] = [];
  readonly close = vi.fn((code?: number, reason?: string) => {
    this.readyState = 3;
    this.dispatchEvent(closeEvent(code ?? 1000, reason ?? ""));
  });
  readyState = 0;
  onSend: ((data: string) => void) | undefined;

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  remoteClose(code = 1006): void {
    this.readyState = 3;
    this.dispatchEvent(closeEvent(code, ""));
  }

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  send(data: string): void {
    if (this.readyState !== 1) {
      throw new Error("socket is not open");
    }
    this.sent.push(data);
    this.onSend?.(data);
  }
}

function closeEvent(code: number, reason: string): Event {
  const event = new Event("close");
  Object.defineProperties(event, {
    code: { value: code },
    reason: { value: reason },
  });
  return event;
}

async function createFixture(
  options: { defaultTimeoutMs?: number; maxFrameBytes?: number } = {},
): Promise<{ connection: WebSocketRpcConnection; socket: FakeWebSocket }> {
  const socket = new FakeWebSocket();
  const connected = WebSocketRpcConnection.connect({
    endpoint: "ws://127.0.0.1:4747",
    webSocketFactory: () => {
      queueMicrotask(() => {
        socket.open();
      });
      return socket;
    },
    ...options,
  });
  return { connection: await connected, socket };
}

describe("WebSocketRpcConnection", () => {
  it("correlates JSON-RPC responses and dispatches notifications", async () => {
    const { connection, socket } = await createFixture();
    const notifications: unknown[] = [];
    connection.on("notification", (notification) => {
      notifications.push(notification);
    });

    const response = connection.request("model/list", { limit: 2 });
    expect(JSON.parse(socket.sent[0] ?? "")).toEqual({
      id: 1,
      method: "model/list",
      params: { limit: 2 },
    });

    socket.receive(
      JSON.stringify({
        method: "turn/started",
        params: { threadId: "thread-1" },
      }),
    );
    socket.receive(JSON.stringify({ id: 1, result: { data: ["model-a"] } }));

    await expect(response).resolves.toEqual({ data: ["model-a"] });
    expect(notifications).toEqual([
      {
        method: "turn/started",
        params: { threadId: "thread-1" },
      },
    ]);
  });

  it("supports responding to and rejecting server requests", async () => {
    const { connection, socket } = await createFixture();
    const requests: RpcServerRequest[] = [];
    connection.on("serverRequest", (request) => {
      requests.push(request);
    });

    socket.receive(
      JSON.stringify({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: { itemId: "item-1" },
      }),
    );
    socket.receive(
      JSON.stringify({
        id: "approval-2",
        method: "item/fileChange/requestApproval",
      }),
    );
    await vi.waitFor(() => {
      expect(requests).toHaveLength(2);
    });

    await requests[0]?.respond({ decision: "accept" });
    await requests[1]?.reject({
      code: -32_000,
      message: "approval unavailable",
      data: { retryable: false },
    });

    expect(socket.sent.map((message) => JSON.parse(message) as unknown)).toEqual([
      { id: "approval-1", result: { decision: "accept" } },
      {
        error: {
          code: -32_000,
          data: { retryable: false },
          message: "approval unavailable",
        },
        id: "approval-2",
      },
    ]);
  });

  it("honors request timeout and abort without poisoning later requests", async () => {
    const { connection, socket } = await createFixture({ defaultTimeoutMs: 10 });

    await expect(connection.request("account/usage/read")).rejects.toBeInstanceOf(RpcTimeoutError);

    const controller = new AbortController();
    const aborted = connection.request("thread/read", undefined, {
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    controller.abort(new Error("fixture abort"));
    await expect(aborted).rejects.toThrow("fixture abort");

    const healthy = connection.request("model/list");
    socket.receive(JSON.stringify({ id: 3, result: { data: [] } }));
    await expect(healthy).resolves.toEqual({ data: [] });
  });

  it("rejects pending work on close and closes only the client socket", async () => {
    const { connection, socket } = await createFixture();
    const pending = connection.request("thread/list");
    const reason = new RpcConnectionClosedError("shared broker disconnected");

    connection.close(reason);

    await expect(pending).rejects.toBe(reason);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledWith(1000, "client stop");
    expect(connection.closed).toBe(true);
  });

  it("closes the connection when a single frame exceeds the configured limit", async () => {
    const { connection, socket } = await createFixture({ maxFrameBytes: 16 });
    const errors: Error[] = [];
    connection.on("protocolError", (error) => {
      errors.push(error);
    });

    socket.receive("x".repeat(17));

    await vi.waitFor(() => {
      expect(connection.closed).toBe(true);
      expect(errors).toHaveLength(1);
    });
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("accepts a long-thread snapshot larger than the legacy 16 MiB default", async () => {
    const { connection, socket } = await createFixture();
    const response = connection.request<{ payload: string }>("thread/read");
    const payload = "x".repeat(16 * 1024 * 1024);

    socket.receive(JSON.stringify({ id: 1, result: { payload } }));

    await expect(response).resolves.toMatchObject({ payload });
    expect(connection.closed).toBe(false);
  });

  it("rejects non-loopback endpoints before creating a socket", async () => {
    const webSocketFactory = vi.fn(() => new FakeWebSocket());

    await expect(
      WebSocketRpcConnection.connect({
        endpoint: "ws://example.com:4747",
        webSocketFactory,
      }),
    ).rejects.toThrow("loopback");
    expect(webSocketFactory).not.toHaveBeenCalled();
  });

  it("times out or aborts a connection attempt and closes only that client socket", async () => {
    const timedOutSocket = new FakeWebSocket();
    await expect(
      WebSocketRpcConnection.connect({
        connectionTimeoutMs: 5,
        endpoint: "ws://127.0.0.1:4747",
        webSocketFactory: () => timedOutSocket,
      }),
    ).rejects.toBeInstanceOf(RpcConnectionClosedError);
    expect(timedOutSocket.close).toHaveBeenCalledTimes(1);

    const abortedSocket = new FakeWebSocket();
    const controller = new AbortController();
    const connecting = WebSocketRpcConnection.connect({
      connectionTimeoutMs: 1_000,
      endpoint: "ws://127.0.0.1:4747",
      signal: controller.signal,
      webSocketFactory: () => abortedSocket,
    });
    controller.abort(new Error("connection aborted"));

    await expect(connecting).rejects.toThrow("connection aborted");
    expect(abortedSocket.close).toHaveBeenCalledTimes(1);
  });

  it("turns a remote socket close into one connection close", async () => {
    const { connection, socket } = await createFixture();
    const closed = vi.fn();
    connection.on("closed", closed);
    const pending = connection.request("thread/list");

    socket.remoteClose();

    await expect(pending).rejects.toBeInstanceOf(RpcConnectionClosedError);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(socket.close).not.toHaveBeenCalled();
  });
});
