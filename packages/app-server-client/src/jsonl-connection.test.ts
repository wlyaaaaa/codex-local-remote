import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { JsonlRpcConnection, RpcTimeoutError } from "./jsonl-connection.js";
import { initializeAppServer } from "./initialize.js";

async function waitForLines(lines: string[], count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(lines).toHaveLength(count);
  });
}

function createFixture(defaultTimeoutMs = 250) {
  const serverToClient = new PassThrough();
  const clientToServer = new PassThrough();
  const lines: string[] = [];
  let buffer = "";

  clientToServer.setEncoding("utf8");
  clientToServer.on("data", (chunk: string) => {
    buffer += chunk;
    const complete = buffer.split("\n");
    buffer = complete.pop() ?? "";
    lines.push(...complete.filter((line) => line.length > 0));
  });

  const connection = new JsonlRpcConnection({
    readable: serverToClient,
    writable: clientToServer,
    defaultTimeoutMs,
  });

  return { clientToServer, connection, lines, serverToClient };
}

describe("JsonlRpcConnection", () => {
  it("correlates a response split across chunks and preserves the request shape", async () => {
    const fixture = createFixture();
    const response = fixture.connection.request("model/list", { limit: 25 });

    await waitForLines(fixture.lines, 1);
    expect(JSON.parse(fixture.lines[0] ?? "")).toEqual({
      id: 1,
      method: "model/list",
      params: { limit: 25 },
    });

    fixture.serverToClient.write('{"id":1,"res');
    fixture.serverToClient.write('ult":{"data":[{"id":"model-a"}]}}\n');

    await expect(response).resolves.toEqual({ data: [{ id: "model-a" }] });
  });

  it("dispatches notifications and server requests while continuing after malformed input", async () => {
    const fixture = createFixture();
    const notifications: unknown[] = [];
    const protocolErrors: Error[] = [];
    const serverRequests: Array<{ method: string; respond: (result: unknown) => Promise<void> }> =
      [];

    fixture.connection.on("notification", (notification) => {
      notifications.push(notification);
    });
    fixture.connection.on("protocolError", (error) => {
      protocolErrors.push(error);
    });
    fixture.connection.on("serverRequest", (request) => {
      serverRequests.push(request);
    });

    fixture.serverToClient.write(
      [
        "not-json",
        JSON.stringify({ method: "turn/started", params: { threadId: "thread-1" } }),
        JSON.stringify({
          id: "approval-1",
          method: "item/commandExecution/requestApproval",
          params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" },
        }),
      ].join("\n") + "\n",
    );

    await vi.waitFor(() => {
      expect(protocolErrors).toHaveLength(1);
      expect(notifications).toHaveLength(1);
      expect(serverRequests).toHaveLength(1);
    });

    expect(notifications[0]).toEqual({
      method: "turn/started",
      params: { threadId: "thread-1" },
    });
    expect(serverRequests[0]?.method).toBe("item/commandExecution/requestApproval");

    await serverRequests[0]?.respond({ decision: "decline" });
    await waitForLines(fixture.lines, 1);
    expect(JSON.parse(fixture.lines[0] ?? "")).toEqual({
      id: "approval-1",
      result: { decision: "decline" },
    });
  });

  it("rejects protocol errors returned by the server", async () => {
    const fixture = createFixture();
    const response = fixture.connection.request("thread/read", { threadId: "missing" });

    await waitForLines(fixture.lines, 1);
    fixture.serverToClient.write(
      JSON.stringify({
        id: 1,
        error: { code: -32602, message: "Invalid params", data: { field: "threadId" } },
      }) + "\n",
    );

    await expect(response).rejects.toMatchObject({
      code: -32602,
      message: "Invalid params",
      method: "thread/read",
    });
  });

  it("times out and ignores a late response", async () => {
    const fixture = createFixture(15);
    const response = fixture.connection.request("account/rateLimits/read");

    await expect(response).rejects.toBeInstanceOf(RpcTimeoutError);
    fixture.serverToClient.write(JSON.stringify({ id: 1, result: { ignored: true } }) + "\n");

    await expect(
      fixture.connection.request("model/list", {}, { timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(RpcTimeoutError);
  });

  it("rejects all pending work when the transport closes", async () => {
    const fixture = createFixture();
    const first = fixture.connection.request("model/list");
    const second = fixture.connection.request("thread/list");

    fixture.serverToClient.destroy();

    await expect(first).rejects.toThrow("连接已关闭");
    await expect(second).rejects.toThrow("连接已关闭");
  });

  it("closes on an oversized unterminated protocol line and detaches transport listeners", async () => {
    const serverToClient = new PassThrough();
    const clientToServer = new PassThrough();
    const connection = new JsonlRpcConnection({
      maxBufferBytes: 16,
      readable: serverToClient,
      writable: clientToServer,
    });
    const errors: Error[] = [];
    connection.on("protocolError", (error) => {
      errors.push(error);
    });

    serverToClient.write("x".repeat(17));

    await vi.waitFor(() => {
      expect(connection.closed).toBe(true);
      expect(errors).toHaveLength(1);
    });
    expect(serverToClient.listenerCount("data")).toBe(0);
    expect(serverToClient.listenerCount("error")).toBe(0);
    expect(clientToServer.listenerCount("error")).toBe(0);
  });
});

describe("initializeAppServer", () => {
  it("performs initialize then initialized with explicit capability negotiation", async () => {
    const fixture = createFixture();
    const initialization = initializeAppServer(fixture.connection, {
      clientVersion: "0.1.0",
      experimentalApi: true,
    });

    await waitForLines(fixture.lines, 1);
    expect(JSON.parse(fixture.lines[0] ?? "")).toEqual({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "codex-local-remote",
          title: "Codex Local Remote",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
        },
      },
    });

    fixture.serverToClient.write(
      JSON.stringify({
        id: 1,
        result: {
          userAgent: "codex-cli/fixture",
          codexHome: "C:\\fixture",
          platformFamily: "windows",
          platformOs: "windows",
        },
      }) + "\n",
    );

    await expect(initialization).resolves.toMatchObject({
      userAgent: "codex-cli/fixture",
      platformOs: "windows",
    });
    await waitForLines(fixture.lines, 2);
    expect(JSON.parse(fixture.lines[1] ?? "")).toEqual({ method: "initialized" });
  });
});
