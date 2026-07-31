import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import type { OwnedAppServer } from "./runtime.js";
import {
  acquireAppServerDataDirLease,
  appServerUpstreamTokenFilePath,
  assertHighEntropyCapabilityToken,
  buildCodexAppServerArgs,
  DEFAULT_BROKER_APP_SERVER_STARTUP_TIMEOUT_MS,
  formatCodexAppServerListenEndpoint,
  startBroker,
} from "./runtime.js";

const cleanup: Array<() => Promise<void>> = [];
const DOWNSTREAM_CAPABILITY_TOKEN =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const DESKTOP_LAUNCH_NONCE = "0123456789_abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ";

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) {
    await dispose();
  }
});

describe("startBroker", () => {
  it("allows a bounded slow Codex app-server cold start", () => {
    expect(DEFAULT_BROKER_APP_SERVER_STARTUP_TIMEOUT_MS).toBe(60_000);
  });

  it("uses the strict ws://IP:PORT syntax accepted by codex app-server", () => {
    expect(formatCodexAppServerListenEndpoint("127.0.0.1", 18_792)).toBe("ws://127.0.0.1:18792");
  });

  it("passes the official capability-token auth arguments to codex app-server", () => {
    const dataDir = resolve("fixture-broker-data");
    expect(appServerUpstreamTokenFilePath(dataDir)).toBe(
      join(dataDir, "app-server-upstream.token"),
    );
    expect(
      buildCodexAppServerArgs("ws://127.0.0.1:18792", "C:\\BrokerData\\app-server-upstream.token"),
    ).toEqual([
      "-c",
      "features.code_mode_host=true",
      "app-server",
      "--listen",
      "ws://127.0.0.1:18792",
      "--ws-auth",
      "capability-token",
      "--ws-token-file",
      "C:\\BrokerData\\app-server-upstream.token",
    ]);
  });

  it("serializes owned app-server launches for the same data directory", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "broker-lease-test-"));
    cleanup.push(async () => {
      await rm(dataDir, { force: true, recursive: true });
    });
    const first = await acquireAppServerDataDirLease(dataDir);

    await expect(acquireAppServerDataDirLease(dataDir)).rejects.toThrow("lease");
    await first.release();

    const replacement = await acquireAppServerDataDirLease(dataDir);
    await replacement.release();
  });

  it("serializes junction aliases that resolve to the same physical data directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "broker-lease-alias-test-"));
    cleanup.push(async () => {
      await rm(parent, { force: true, recursive: true });
    });
    const dataDir = join(parent, "physical");
    const alias = join(parent, "alias");
    await mkdir(dataDir);
    await symlink(dataDir, alias, process.platform === "win32" ? "junction" : "dir").catch(
      async () => {
        await rm(alias, { force: true, recursive: true });
        throw new Error("test alias could not be created");
      },
    );
    const first = await acquireAppServerDataDirLease(dataDir);

    await expect(acquireAppServerDataDirLease(alias)).rejects.toThrow("lease");
    await first.release();
  });

  it("generates a high-entropy downstream capability when none is supplied", async () => {
    const stopOwned = vi.fn(async () => undefined);
    const broker = await startBroker({
      codexPath: "C:\\fixture\\codex.exe",
      dataDir: "C:\\fixture",
      host: "127.0.0.1",
      launchOwnedAppServer: async () => ({
        endpoint: "ws://127.0.0.1:18792/",
        onExit() {
          return () => undefined;
        },
        processId: 41_001,
        stop: stopOwned,
      }),
      port: 0,
      upstreamHost: "127.0.0.1",
      upstreamPort: 18_792,
    });

    const generated = new URL(broker.webSocketEndpoint).pathname.replace(/^\/ws\//u, "");
    expect(assertHighEntropyCapabilityToken(generated)).toBe(generated);
    await broker.stop();
    expect(stopOwned).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid heartbeat bounds before launching the owned app-server", async () => {
    const launchOwnedAppServer = vi.fn(async (): Promise<OwnedAppServer> => {
      throw new Error("must not launch");
    });

    await expect(
      startBroker({
        capabilityToken: DOWNSTREAM_CAPABILITY_TOKEN,
        codexPath: "C:\\fixture\\codex.exe",
        dataDir: "C:\\fixture",
        heartbeatIntervalMs: 0,
        launchOwnedAppServer,
      }),
    ).rejects.toThrow("heartbeatIntervalMs");
    expect(launchOwnedAppServer).not.toHaveBeenCalled();
  });

  it("relays an authenticated app-server snapshot larger than the legacy 16 MiB limit", async () => {
    const upstreamServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(upstreamServer, "listening");
    const upstreamAddress = upstreamServer.address();
    if (typeof upstreamAddress === "string" || upstreamAddress === null) {
      throw new Error("missing upstream address");
    }
    let resolveUpstream: ((socket: WebSocket) => void) | undefined;
    const upstreamConnected = new Promise<WebSocket>((resolve) => {
      resolveUpstream = resolve;
    });
    const upstreamConnections: WebSocket[] = [];
    upstreamServer.on("connection", (socket) => {
      upstreamConnections.push(socket);
      resolveUpstream?.(socket);
    });
    cleanup.push(
      async () =>
        await new Promise<void>((resolve) => {
          for (const socket of upstreamConnections) {
            socket.terminate();
          }
          upstreamServer.close(() => {
            resolve();
          });
        }),
    );

    const broker = await startBroker({
      capabilityToken: DOWNSTREAM_CAPABILITY_TOKEN,
      codexPath: "C:\\fixture\\codex.exe",
      dataDir: "C:\\fixture",
      host: "127.0.0.1",
      launchOwnedAppServer: async () => ({
        endpoint: `ws://127.0.0.1:${upstreamAddress.port}/`,
        onExit() {
          return () => undefined;
        },
        processId: 41_004,
        stop: async () => undefined,
      }),
      port: 0,
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
    });
    cleanup.push(async () => {
      await broker.stop();
    });

    const downstream = new WebSocket(broker.webSocketEndpoint);
    cleanup.push(async () => {
      downstream.terminate();
    });
    await once(downstream, "open");
    const upstream = await upstreamConnected;
    const frame = JSON.stringify({
      method: "fixture/large-thread-snapshot",
      params: { payload: "x".repeat(16 * 1024 * 1024) },
    });
    const outcome = Promise.race([
      once(downstream, "message").then(([data]) => ({
        bytes: Buffer.byteLength(data as Buffer),
        kind: "message" as const,
      })),
      once(downstream, "close").then(() => ({ kind: "closed" as const })),
    ]);

    upstream.send(frame);

    await expect(outcome).resolves.toEqual({
      bytes: Buffer.byteLength(frame),
      kind: "message",
    });
  });

  it("requires the exact capability path, authenticates both upstream clients, and keeps readiness secret-free", async () => {
    const upstreamServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(upstreamServer, "listening");
    const upstreamAddress = upstreamServer.address();
    if (typeof upstreamAddress === "string" || upstreamAddress === null) {
      throw new Error("missing upstream address");
    }
    const upstreamConnections: WebSocket[] = [];
    const upstreamAuthorizations: Array<string | undefined> = [];
    upstreamServer.on("connection", (socket, request) => {
      upstreamConnections.push(socket);
      upstreamAuthorizations.push(request.headers.authorization);
    });
    cleanup.push(
      async () =>
        await new Promise<void>((resolve) => {
          for (const socket of upstreamConnections) {
            socket.terminate();
          }
          upstreamServer.close(() => {
            resolve();
          });
        }),
    );

    const exitListeners = new Set<() => void>();
    const stopOwned = vi.fn(async () => undefined);
    const owned: OwnedAppServer = {
      endpoint: `ws://127.0.0.1:${upstreamAddress.port}/`,
      onExit(listener) {
        exitListeners.add(listener);
        return () => {
          exitListeners.delete(listener);
        };
      },
      processId: 41_002,
      stop: stopOwned,
    };
    let upstreamCapabilityToken: string | undefined;
    const broker = await startBroker({
      capabilityToken: DOWNSTREAM_CAPABILITY_TOKEN,
      codexPath: "C:\\fixture\\codex.exe",
      dataDir: "C:\\fixture",
      host: "127.0.0.1",
      launchOwnedAppServer: async (options) => {
        upstreamCapabilityToken = options.upstreamCapabilityToken;
        return owned;
      },
      port: 0,
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
    });
    cleanup.push(async () => {
      await broker.stop();
    });

    expect(new URL(broker.webSocketEndpoint).pathname).toBe(`/ws/${DOWNSTREAM_CAPABILITY_TOKEN}`);
    const rootUrl = new URL(broker.webSocketEndpoint);
    rootUrl.pathname = "/";
    const wrongTokenUrl = new URL(broker.webSocketEndpoint);
    wrongTokenUrl.pathname = "/ws/not-the-capability-token";

    await expect(rejectedUpgradeStatus(rootUrl.toString())).resolves.toBe(404);
    await expect(rejectedUpgradeStatus(wrongTokenUrl.toString())).resolves.toBe(404);
    await expect(rejectedUpgradeStatus(`${broker.webSocketEndpoint}?probe=1`)).resolves.toBe(404);
    await expect(
      rejectedUpgradeStatus(wrongTokenUrl.toString(), "https://evil.example"),
    ).resolves.toBe(403);
    await expect(
      rejectedUpgradeStatus(broker.webSocketEndpoint, "https://evil.example"),
    ).resolves.toBe(403);
    expect(upstreamConnections).toHaveLength(0);

    const first = new WebSocket(broker.webSocketEndpoint);
    const second = new WebSocket(broker.webSocketEndpoint);
    await Promise.all([once(first, "open"), once(second, "open")]);
    await vi.waitFor(() => {
      expect(upstreamConnections).toHaveLength(2);
    });
    expect(upstreamCapabilityToken).toBeDefined();
    expect(upstreamAuthorizations).toEqual([
      `Bearer ${upstreamCapabilityToken}`,
      `Bearer ${upstreamCapabilityToken}`,
    ]);

    first.close();
    await once(first, "close");
    expect(stopOwned).not.toHaveBeenCalled();

    const health = await fetch(`${broker.httpEndpoint}health`);
    const ready = await fetch(`${broker.httpEndpoint}ready`);
    expect(health.status).toBe(200);
    expect(ready.status).toBe(200);
    const readyBody = await ready.text();
    const readyPayload = JSON.parse(readyBody) as Record<string, unknown>;
    expect(readyPayload).toMatchObject({
      appServerReady: true,
      brokerProcessId: process.pid,
      degraded: false,
      desktopConnected: false,
      sidecarConnected: false,
      status: "ready",
      unknownCount: 1,
      unsafeThreadCount: 0,
      upstreamProcessId: owned.processId,
    });
    expect(typeof readyPayload.runtimeInvocationId).toBe("string");
    expect(readyPayload.runtimeInvocationId).toMatch(/^[0-9a-f]{32}$/u);
    const secondReadyBody = await fetch(`${broker.httpEndpoint}ready`).then(
      async (response) => await response.text(),
    );
    const secondReadyPayload = JSON.parse(secondReadyBody) as Record<string, unknown>;
    expect(secondReadyPayload.runtimeInvocationId).toBe(readyPayload.runtimeInvocationId);
    expect(secondReadyPayload.brokerProcessId).toBe(readyPayload.brokerProcessId);
    expect(secondReadyPayload.upstreamProcessId).toBe(readyPayload.upstreamProcessId);
    expect(readyBody).not.toContain(DOWNSTREAM_CAPABILITY_TOKEN);
    expect(readyBody).not.toContain(upstreamCapabilityToken);
    await broker.stop();
    expect(stopOwned).toHaveBeenCalledTimes(1);
    await expect(broker.closed).resolves.toEqual({ reason: "stopped" });
    second.terminate();
  });

  it("accepts only a strict per-launch nonce query and publishes irreversible initialized-Desktop digests", async () => {
    const upstreamServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(upstreamServer, "listening");
    const upstreamAddress = upstreamServer.address();
    if (typeof upstreamAddress === "string" || upstreamAddress === null) {
      throw new Error("missing upstream address");
    }
    const upstreamConnections: WebSocket[] = [];
    upstreamServer.on("connection", (socket) => {
      upstreamConnections.push(socket);
      socket.on("message", (data) => {
        const message = JSON.parse(textFrame(data)) as Record<string, unknown>;
        if (message.method === "initialize") {
          socket.send(JSON.stringify({ id: message.id, result: { userAgent: "fixture" } }));
        } else if (message.method === "thread/loaded/list") {
          socket.send(
            JSON.stringify({
              id: message.id,
              result: { data: [], nextCursor: null },
            }),
          );
        }
      });
    });
    cleanup.push(
      async () =>
        await new Promise<void>((resolve) => {
          for (const socket of upstreamConnections) {
            socket.terminate();
          }
          upstreamServer.close(() => {
            resolve();
          });
        }),
    );

    const broker = await startBroker({
      capabilityToken: DOWNSTREAM_CAPABILITY_TOKEN,
      codexPath: "C:\\fixture\\codex.exe",
      dataDir: "C:\\fixture",
      host: "127.0.0.1",
      launchOwnedAppServer: async () => ({
        endpoint: `ws://127.0.0.1:${upstreamAddress.port}/`,
        onExit() {
          return () => undefined;
        },
        processId: 41_005,
        stop: async () => undefined,
      }),
      port: 0,
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
    });
    cleanup.push(async () => {
      await broker.stop();
    });

    const launchNonce = DESKTOP_LAUNCH_NONCE;
    const launchDigest = createHash("sha256").update(launchNonce, "utf8").digest("hex");
    expect(broker.webSocketEndpoint).not.toContain("desktopLaunchNonce");
    await expect(
      rejectedUpgradeStatus(`${broker.webSocketEndpoint}?desktopLaunchNonce=short`),
    ).resolves.toBe(404);
    await expect(
      rejectedUpgradeStatus(`${broker.webSocketEndpoint}?desktopLaunchNonce=${"a".repeat(43)}`),
    ).resolves.toBe(404);
    await expect(
      rejectedUpgradeStatus(
        `${broker.webSocketEndpoint}?desktopLaunchNonce=${launchNonce}&desktopLaunchNonce=${launchNonce}`,
      ),
    ).resolves.toBe(404);
    await expect(
      rejectedUpgradeStatus(
        `${broker.webSocketEndpoint}?desktopLaunchNonce=${launchNonce}&probe=1`,
      ),
    ).resolves.toBe(404);

    const attributed = new WebSocket(
      `${broker.webSocketEndpoint}?desktopLaunchNonce=${launchNonce}`,
    );
    const legacyDesktop = new WebSocket(broker.webSocketEndpoint);
    const sidecar = new WebSocket(broker.webSocketEndpoint);
    cleanup.push(async () => {
      attributed.terminate();
      legacyDesktop.terminate();
      sidecar.terminate();
    });
    await Promise.all([
      once(attributed, "open"),
      once(legacyDesktop, "open"),
      once(sidecar, "open"),
    ]);
    const legacyClosed = once(legacyDesktop, "close");
    sendInitialize(legacyDesktop, "legacy-desktop", "desktop");
    await Promise.all([
      initializeDownstream(attributed, "attributed-desktop", "desktop"),
      initializeDownstream(sidecar, "nonce-free-sidecar", "sidecar"),
    ]);
    const legacyCloseEvent: unknown = await legacyClosed;
    if (!Array.isArray(legacyCloseEvent)) {
      throw new Error("missing legacy Desktop close event");
    }
    const [legacyCode, legacyReason] = legacyCloseEvent as unknown[];
    expect(legacyCode).toBe(1008);
    expect(Buffer.from(legacyReason as Buffer).toString("utf8")).toBe(
      "Codex Desktop launch identity is required",
    );

    await vi.waitFor(async () => {
      const readyBody = await fetch(`${broker.httpEndpoint}ready`).then(
        async (response) => await response.text(),
      );
      const ready = JSON.parse(readyBody) as Record<string, unknown>;
      expect(ready).toMatchObject({
        desktopConnected: true,
        desktopConnectionCount: 1,
        desktopLaunchNonceDigests: [launchDigest],
        sidecarConnected: true,
      });
      expect(readyBody).not.toContain(launchNonce);
      expect(readyBody).not.toContain("desktopLaunchNonce=");
    });

    attributed.close();
    await once(attributed, "close");
    await vi.waitFor(async () => {
      const readyBody = await fetch(`${broker.httpEndpoint}ready`).then(
        async (response) => await response.text(),
      );
      const ready = JSON.parse(readyBody) as Record<string, unknown>;
      expect(ready).toMatchObject({
        desktopConnected: false,
        desktopConnectionCount: 0,
        desktopLaunchNonceDigests: [],
        sidecarConnected: true,
      });
    });

    sidecar.close();
    await once(sidecar, "close");
    await vi.waitFor(async () => {
      const readyBody = await fetch(`${broker.httpEndpoint}ready`).then(
        async (response) => await response.text(),
      );
      const ready = JSON.parse(readyBody) as Record<string, unknown>;
      expect(ready).toMatchObject({
        desktopConnected: false,
        desktopConnectionCount: 0,
        desktopLaunchNonceDigests: [],
        sidecarConnected: false,
      });
    });
  });

  it("reclaims a half-open Desktop pair and removes its live readiness count", async () => {
    const upstreamServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(upstreamServer, "listening");
    const upstreamAddress = upstreamServer.address();
    if (typeof upstreamAddress === "string" || upstreamAddress === null) {
      throw new Error("missing upstream address");
    }
    const upstreamConnections: WebSocket[] = [];
    const staleUpstreamClosed = Promise.withResolvers<void>();
    upstreamServer.on("connection", (socket) => {
      upstreamConnections.push(socket);
      socket.on("message", (data) => {
        const message = JSON.parse(textFrame(data)) as Record<string, unknown>;
        if (message.method === "initialize") {
          if (message.id === "stale-desktop") {
            socket.once("close", () => {
              staleUpstreamClosed.resolve();
            });
          }
          socket.send(JSON.stringify({ id: message.id, result: { userAgent: "fixture" } }));
        } else if (message.method === "thread/loaded/list") {
          socket.send(
            JSON.stringify({
              id: message.id,
              result: { data: [], nextCursor: null },
            }),
          );
        }
      });
    });
    cleanup.push(
      async () =>
        await new Promise<void>((resolve) => {
          for (const socket of upstreamConnections) {
            socket.terminate();
          }
          upstreamServer.close(() => {
            resolve();
          });
        }),
    );

    const broker = await startBroker({
      capabilityToken: DOWNSTREAM_CAPABILITY_TOKEN,
      codexPath: "C:\\fixture\\codex.exe",
      dataDir: "C:\\fixture",
      heartbeatDeadlineMs: 250,
      heartbeatIntervalMs: 250,
      heartbeatResumeToleranceMs: 1_000,
      host: "127.0.0.1",
      launchOwnedAppServer: async () => ({
        endpoint: `ws://127.0.0.1:${upstreamAddress.port}/`,
        onExit() {
          return () => undefined;
        },
        processId: 41_006,
        stop: async () => undefined,
      }),
      port: 0,
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
    });
    cleanup.push(async () => {
      await broker.stop();
    });

    const staleDesktop = new WebSocket(
      `${broker.webSocketEndpoint}?desktopLaunchNonce=${DESKTOP_LAUNCH_NONCE}`,
      { autoPong: false },
    );
    const liveSidecar = new WebSocket(broker.webSocketEndpoint);
    cleanup.push(async () => {
      staleDesktop.terminate();
      liveSidecar.terminate();
    });
    await Promise.all([once(staleDesktop, "open"), once(liveSidecar, "open")]);
    const staleClosed = once(staleDesktop, "close");
    await Promise.all([
      initializeDownstream(staleDesktop, "stale-desktop", "desktop"),
      initializeDownstream(liveSidecar, "live-sidecar", "sidecar"),
    ]);

    const before = await fetch(`${broker.httpEndpoint}ready`);
    expect(before.status).toBe(200);
    expect(before.headers.get("cache-control")).toBe("no-store");
    const beforePayload = (await before.json()) as Record<string, unknown>;
    expect(beforePayload).toMatchObject({
      appServerReady: true,
      desktopConnected: true,
      desktopConnectionCount: 1,
      sidecarConnected: true,
    });

    await Promise.all([staleClosed, staleUpstreamClosed.promise]);
    await vi.waitFor(async () => {
      const ready = await fetch(`${broker.httpEndpoint}ready`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({
        appServerReady: true,
        desktopConnected: false,
        desktopConnectionCount: 0,
        runtimeInvocationId: beforePayload.runtimeInvocationId,
        sidecarConnected: true,
      });
    });
    expect(liveSidecar.readyState).toBe(WebSocket.OPEN);
  });

  it("fail-stops the runtime when the owned app-server crashes", async () => {
    const upstreamServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(upstreamServer, "listening");
    const upstreamAddress = upstreamServer.address();
    if (typeof upstreamAddress === "string" || upstreamAddress === null) {
      throw new Error("missing upstream address");
    }
    cleanup.push(
      async () =>
        await new Promise<void>((resolve) => {
          upstreamServer.close(() => {
            resolve();
          });
        }),
    );

    let exitListener: ((error?: Error) => void) | undefined;
    const stopOwned = vi.fn(async () => undefined);
    const broker = await startBroker({
      capabilityToken: DOWNSTREAM_CAPABILITY_TOKEN,
      codexPath: "C:\\fixture\\codex.exe",
      dataDir: "C:\\fixture",
      host: "127.0.0.1",
      launchOwnedAppServer: async () => ({
        endpoint: `ws://127.0.0.1:${upstreamAddress.port}/`,
        onExit(listener) {
          exitListener = listener;
          return () => {
            exitListener = undefined;
          };
        },
        processId: 41_003,
        stop: stopOwned,
      }),
      port: 0,
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
    });

    exitListener?.(new Error("fixture child crash"));
    const exit = await broker.closed;

    expect(exit.reason).toBe("owned-app-server-exit");
    if (exit.reason === "owned-app-server-exit") {
      expect(exit.error.message).toBe("fixture child crash");
    }
    expect(stopOwned).toHaveBeenCalledTimes(1);
    await expect(fetch(`${broker.httpEndpoint}ready`)).rejects.toThrow();
    await broker.stop();
    expect(stopOwned).toHaveBeenCalledTimes(1);
  });

  it("rejects non-loopback listeners before launching a child", async () => {
    const launchOwnedAppServer = vi.fn(async (): Promise<OwnedAppServer> => {
      throw new Error("must not launch");
    });

    await expect(
      startBroker({
        codexPath: "C:\\fixture\\codex.exe",
        dataDir: "C:\\fixture",
        host: "0.0.0.0",
        launchOwnedAppServer,
        port: 18791,
        upstreamHost: "127.0.0.1",
        upstreamPort: 18792,
      }),
    ).rejects.toThrow("loopback");
    expect(launchOwnedAppServer).not.toHaveBeenCalled();
  });
});

async function rejectedUpgradeStatus(url: string, origin?: string): Promise<number | undefined> {
  return await new Promise<number | undefined>((resolve, reject) => {
    const socket = new WebSocket(url, {
      ...(origin === undefined ? {} : { headers: { Origin: origin } }),
    });
    socket.once("open", () => {
      socket.terminate();
      reject(new Error(`unexpected WebSocket acceptance for ${url}`));
    });
    socket.once("unexpected-response", (_request, response) => {
      const status = response.statusCode;
      response.resume();
      resolve(status);
    });
    socket.once("error", (error) => {
      reject(error);
    });
  });
}

async function initializeDownstream(
  socket: WebSocket,
  id: string,
  role: "desktop" | "sidecar",
): Promise<void> {
  const initialized = once(socket, "message");
  sendInitialize(socket, id, role);
  await initialized;
  socket.send(JSON.stringify({ method: "initialized" }));
}

function sendInitialize(socket: WebSocket, id: string, role: "desktop" | "sidecar"): void {
  socket.send(
    JSON.stringify({
      id,
      method: "initialize",
      params: {
        clientInfo:
          role === "desktop"
            ? {
                name: "codex-desktop-internal",
                title: "Codex Desktop",
                version: "fixture",
              }
            : {
                name: "codex-local-remote",
                version: "fixture",
              },
      },
    }),
  );
}

function textFrame(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
}
