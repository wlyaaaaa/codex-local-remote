import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readBrokerDesktopHealth } from "./broker-desktop-health.js";

const cleanupDirectories: string[] = [];
const cleanupServers: Server[] = [];
const runtimeInvocationId = "b".repeat(32);

afterEach(async () => {
  await Promise.all(
    cleanupServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    cleanupDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-remote-broker-health-"));
  cleanupDirectories.push(directory);
  return directory;
}

async function writeReceipt(dataDir: string): Promise<void> {
  await writeFile(
    path.join(dataDir, "app-server-broker.json"),
    JSON.stringify({
      Signature: "codex-local-remote/app-server-broker/v3",
      Version: 3,
      Status: "ready",
      RuntimeInvocationId: runtimeInvocationId,
      ProcessId: 1234,
      Upstream: {
        ProcessId: 5678,
        RuntimeInvocationId: runtimeInvocationId,
      },
    }),
    "utf8",
  );
}

async function brokerEndpoint(overrides: Partial<Record<string, unknown>> = {}): Promise<string> {
  const server = createServer((_request, response) => {
    const body = JSON.stringify({
      status: "ready",
      appServerReady: true,
      brokerProcessId: 1234,
      degraded: false,
      desktopConnected: true,
      runtimeInvocationId,
      sidecarConnected: true,
      unknownCount: 0,
      upstreamProcessId: 5678,
      ...overrides,
    });
    response.writeHead(200, {
      "content-length": Buffer.byteLength(body),
      "content-type": "application/json",
    });
    response.end(body);
  });
  cleanupServers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test listener");
  return `ws://127.0.0.1:${address.port}/shared`;
}

describe("readBrokerDesktopHealth", () => {
  it("accepts only the exact healthy shared Desktop and Sidecar connection", async () => {
    const dataDir = await fixtureDirectory();
    await writeReceipt(dataDir);

    await expect(readBrokerDesktopHealth(dataDir, await brokerEndpoint())).resolves.toEqual({
      state: "current",
    });
  });

  it.each([
    ["Desktop disconnected", { desktopConnected: false }],
    ["Sidecar disconnected", { sidecarConnected: false }],
    ["unknown client", { unknownCount: 1 }],
  ])("degrades when %s", async (_label, override) => {
    const dataDir = await fixtureDirectory();
    await writeReceipt(dataDir);

    await expect(
      readBrokerDesktopHealth(dataDir, await brokerEndpoint(override)),
    ).resolves.toMatchObject({ state: "degraded" });
  });

  it("separates an application backfill degradation from connection identity failure", async () => {
    const dataDir = await fixtureDirectory();
    await writeReceipt(dataDir);

    await expect(
      readBrokerDesktopHealth(dataDir, await brokerEndpoint({ degraded: true })),
    ).resolves.toMatchObject({ state: "application-degraded" });
  });

  it.each([
    ["receipt is missing", undefined],
    ["runtime invocation differs", { runtimeInvocationId: "c".repeat(32) }],
    ["Broker PID differs", { brokerProcessId: 9999 }],
    ["upstream PID differs", { upstreamProcessId: 9999 }],
  ])("fails closed when %s", async (_label, override) => {
    const dataDir = await fixtureDirectory();
    if (override !== undefined) await writeReceipt(dataDir);

    await expect(
      readBrokerDesktopHealth(dataDir, await brokerEndpoint(override)),
    ).resolves.toMatchObject({ state: "degraded" });
  });
});
