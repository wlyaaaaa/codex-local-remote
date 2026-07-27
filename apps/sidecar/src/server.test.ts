import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";

import type {
  CreateThreadInput,
  DiagnosticSnapshot,
  LocalInputReference,
  RemoteEvent,
  SendTurnInput,
  SteerTurnInput,
  ThreadDetail,
} from "@codex-local-remote/contracts";
import {
  RpcConnectionClosedError,
  RpcRequestError,
  RpcTimeoutError,
  SharedAppServerConnectionError,
} from "@codex-local-remote/app-server-client";
import { ApprovalCoordinator, RemoteEventBuffer } from "@codex-local-remote/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setupPassword } from "./auth.js";
import { BrowserUploadStore } from "./browser-uploads.js";
import {
  createSidecarServer,
  eventMatchesSubscription,
  writeEvent,
  type SidecarDomainApi,
} from "./server.js";
import { SidecarStateStore } from "./state-store.js";
import type { SidecarTurnQueueApi } from "./turn-queue.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("SSE 对话明细订阅", () => {
  const event = (type: RemoteEvent["type"], threadId?: string): RemoteEvent => ({
    emittedAt: "2026-07-26T00:00:00.000Z",
    payload: {},
    schemaVersion: 1,
    seq: 1,
    type,
    ...(threadId ? { threadId } : {}),
  });

  it("列表页只接收轻量全局事件，详情页只接收当前任务的重型明细", () => {
    expect(eventMatchesSubscription(event("thread.snapshot", "other"))).toBe(true);
    expect(eventMatchesSubscription(event("turn.state", "other"))).toBe(true);
    expect(eventMatchesSubscription(event("thread.item", "other"))).toBe(false);
    expect(eventMatchesSubscription(event("usage.updated"))).toBe(true);
    expect(eventMatchesSubscription(event("usage.updated", "other"))).toBe(false);

    expect(eventMatchesSubscription(event("thread.item", "current"), "current")).toBe(true);
    expect(eventMatchesSubscription(event("thread.item", "other"), "current")).toBe(false);
    expect(eventMatchesSubscription(event("diagnostic", "other"), "current")).toBe(false);
    expect(eventMatchesSubscription(event("diagnostic"), "current")).toBe(true);
  });
});

function cookieFrom(response: {
  headers: Record<string, number | string | string[] | undefined>;
}): string {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" ? (value.split(";", 1)[0] ?? "") : "";
}

async function createFixture(
  configured = true,
  queue?: SidecarTurnQueueApi,
  webFilesAtStartup?: Record<string, string>,
  requestReady?: () => boolean,
) {
  const directory = await SidecarStateStore.createTemporaryDirectoryForTests(
    path.join(os.tmpdir(), "codex-local-remote-server-"),
  );
  temporaryDirectories.push(directory);
  const state = await SidecarStateStore.open(directory);
  const password = "这是一个用于自动化测试且长度足够的本机口令";
  if (configured) {
    await setupPassword(state, password, password);
  }
  const events = new RemoteEventBuffer(8);
  const compactThread = vi.fn(async () => undefined);
  const listProjects = vi.fn(() => [
    {
      id: "project-1",
      name: "示例项目",
      rootLabel: "sample",
      source: "registered" as const,
    },
  ]);
  const listThreads = vi.fn<SidecarDomainApi["listThreads"]>(async () => ({ data: [] }));
  const createThread = vi.fn(async (_input: CreateThreadInput) => ({
    data: {
      id: "thread-new",
      title: "新对话",
      mode: "managed" as const,
      state: "running" as const,
      updatedAt: "2026-07-25T00:00:00.000Z",
      items: [],
      activeTurnId: "turn-new",
      availableActions: {
        changeModelNextTurn: true,
        interrupt: true,
        reply: false,
        steer: true,
      },
    },
    degradations: [],
  }));
  const getThread = vi.fn<SidecarDomainApi["getThread"]>(async () => {
    throw new Error("not used");
  });
  const resumeThread = vi.fn<SidecarDomainApi["resumeThread"]>(async () => {
    throw new Error("not used");
  });
  const startTurn = vi.fn<SidecarDomainApi["startTurn"]>(
    async (_threadId: string, _input: SendTurnInput) => ({
      state: "running" as const,
      threadId: "thread-new",
      turnId: "turn-next",
    }),
  );
  const domain = {
    clearThreadGoal: vi.fn(async () => undefined),
    compactThread,
    createThread,
    getThread,
    getThreadGoal: vi.fn(async () => undefined),
    getUsage: vi.fn(async () => ({
      data: { updatedAt: "2026-07-25T00:00:00.000Z", windows: [] },
      degradations: [],
    })),
    interruptTurn: vi.fn(async () => ({
      state: "idle" as const,
      threadId: "thread-new",
      turnId: "turn-new",
    })),
    listApprovalPolicies: vi.fn(async () => ({
      data: [{ id: "on-request" }, { id: "never" }],
      degradations: [],
    })),
    listApprovalReviewers: vi.fn(async () => ({
      data: [{ id: "user" }, { id: "future-reviewer" }],
      degradations: [],
    })),
    listCollaborationModes: vi.fn(async () => ({ data: [], degradations: [] })),
    listModels: vi.fn(async () => ({
      data: [
        {
          id: "model-a",
          displayName: "Model A",
          supportedReasoningEfforts: ["medium" as const],
          isDefault: true,
        },
      ],
      degradations: [],
    })),
    listPermissionProfiles: vi.fn(async () => ({
      data: [
        {
          allowed: true,
          description: "允许项目内读写",
          id: ":workspace",
        },
      ],
      degradations: [],
    })),
    listProjects,
    listSubagents: vi.fn(async () => ({ data: [] })),
    listThreads,
    resumeThread,
    setThreadGoal: vi.fn(async () => undefined),
    setThreadName: vi.fn(async () => undefined),
    startTurn,
    steerTurn: vi.fn(async (_threadId: string, _turnId: string, _input: SteerTurnInput) => ({
      state: "running" as const,
      threadId: "thread-new",
      turnId: "turn-new",
    })),
    updateThreadSettings: vi.fn(async () => undefined),
  } satisfies SidecarDomainApi;
  const diagnostics: DiagnosticSnapshot = {
    generatedAt: "2026-07-25T00:00:00.000Z",
    version: "0.1.0",
    capabilities: {
      appServer: "available",
      desktopSnapshots: "available",
      fileBrowser: "available",
      liveEvents: "available",
      subagents: "degraded",
      usage: "available",
    },
    listener: {
      host: "127.0.0.1",
      port: 18_790,
      basePath: "/codex-remote",
    },
    warnings: [],
  };
  const webDir = path.join(directory, webFilesAtStartup ? "web" : "missing-web");
  for (const [relativePath, content] of Object.entries(webFilesAtStartup ?? {})) {
    const absolutePath = path.join(webDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
  const app = await createSidecarServer({
    approvals: new ApprovalCoordinator(events),
    config: {
      appServerUrl: "ws://127.0.0.1:18791/",
      basePath: "/codex-remote",
      dataDir: directory,
      desktopSyncEnabled: true,
      host: "127.0.0.1",
      port: 18_790,
      webDir,
    },
    diagnostics: () => diagnostics,
    domain,
    events,
    requestReady: requestReady ?? (() => diagnostics.capabilities.appServer === "available"),
    ...(queue === undefined ? {} : { queue }),
    state,
  });
  return {
    app,
    compactThread,
    createThread,
    diagnostics,
    directory,
    domain,
    events,
    getThread,
    listProjects,
    listThreads,
    password,
    resumeThread,
    startTurn,
    state,
    webDir,
  };
}

interface SseFrame {
  event: RemoteEvent;
  id: string;
}

function parseSseFrames(text: string): SseFrame[] {
  return text
    .split(/\r?\n\r?\n/u)
    .map((block) => block.split(/\r?\n/u))
    .filter((lines) => lines.some((line) => line.startsWith("data: ")))
    .map((lines) => {
      const id = lines.find((line) => line.startsWith("id: "))?.slice(4);
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
      if (!id || !data) {
        throw new Error(`Malformed SSE frame: ${lines.join("\\n")}`);
      }
      return { event: JSON.parse(data) as RemoteEvent, id };
    });
}

async function readEventHandshake(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  cookie: string,
  lastEventId?: string,
  queryCursor?: string,
): Promise<SseFrame[]> {
  if (!fixture.app.server.listening) {
    await fixture.app.listen({ host: "127.0.0.1", port: 0 });
  }
  const address = fixture.app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing test listener address");
  }
  const port = address.port;
  const text = await new Promise<string>((resolve, reject) => {
    let settled = false;
    let body = "";
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        request.destroy();
        reject(new Error("Timed out waiting for SSE ready frame"));
      }
    }, 3_000);
    const request = httpRequest({
      headers: {
        cookie,
        ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
      },
      host: "127.0.0.1",
      method: "GET",
      path:
        "/codex-remote/api/v1/events" +
        (queryCursor === undefined ? "" : `?cursor=${encodeURIComponent(queryCursor)}`),
      port,
    });
    request.on("response", (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
        if (!settled && body.includes('"type":"connection.ready"')) {
          settled = true;
          clearTimeout(timeout);
          response.destroy();
          resolve(body);
        }
      });
      response.on("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });
    request.end();
  });
  return parseSseFrames(text);
}

async function observeSseRevocation(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  cookie: string,
  revoke: () => void | Promise<void>,
): Promise<{ closed: boolean; frames: SseFrame[] }> {
  if (!fixture.app.server.listening) {
    await fixture.app.listen({ host: "127.0.0.1", port: 0 });
  }
  const address = fixture.app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing test listener address");
  }

  return await new Promise<{ closed: boolean; frames: SseFrame[] }>((resolve, reject) => {
    let body = "";
    let finished = false;
    let revocationStarted = false;
    let observationTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      finish(false, new Error("Timed out waiting for SSE revocation"));
    }, 3_000);
    const request = httpRequest({
      headers: { cookie },
      host: "127.0.0.1",
      method: "GET",
      path: "/codex-remote/api/v1/events",
      port: address.port,
    });

    const finish = (closed: boolean, error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (observationTimer !== undefined) clearTimeout(observationTimer);
      request.destroy();
      if (error) {
        reject(error);
      } else {
        resolve({ closed, frames: parseSseFrames(body) });
      }
    };

    request.on("response", (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
        if (!revocationStarted && body.includes('"type":"connection.ready"')) {
          revocationStarted = true;
          void Promise.resolve(revoke())
            .then(() => {
              fixture.events.append("diagnostic", { message: "must-not-cross-revocation" });
              observationTimer = setTimeout(() => finish(false), 100);
            })
            .catch((error: unknown) => {
              finish(false, error instanceof Error ? error : new Error(String(error)));
            });
        }
      });
      response.on("end", () => finish(revocationStarted));
      response.on("close", () => finish(revocationStarted));
      response.on("error", (error) => finish(false, error));
    });
    request.on("error", (error) => {
      if (!finished) finish(false, error);
    });
    request.end();
  });
}

async function login(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<{
  cookie: string;
  csrfToken: string;
  expiresAt: string;
  idleExpiresAt: string;
}> {
  const response = await fixture.app.inject({
    method: "POST",
    url: "/codex-remote/api/v1/auth/login",
    headers: {
      host: "127.0.0.1:18790",
      origin: "http://127.0.0.1:18790",
      "sec-fetch-site": "same-origin",
    },
    payload: { password: fixture.password },
  });
  expect(response.statusCode).toBe(200);
  return {
    cookie: cookieFrom(response),
    ...response.json<{
      csrfToken: string;
      expiresAt: string;
      idleExpiresAt: string;
    }>(),
  };
}

describe("SSE backpressure", () => {
  const event: RemoteEvent = {
    emittedAt: "2026-07-26T00:00:00.000Z",
    payload: { state: "running" },
    schemaVersion: 1,
    seq: 7,
    threadId: "thread-1",
    type: "turn.state",
  };

  it("returns false when the response buffer is full so the caller can close and replay", () => {
    const write = vi.fn(() => false);
    const stream = {
      destroyed: false,
      writableEnded: false,
      write,
    } as never;

    expect(writeEvent(stream, event, "instance")).toBe(false);
    expect(write).toHaveBeenCalledOnce();
  });

  it("does not write after the stream is destroyed or ended", () => {
    const write = vi.fn(() => true);

    expect(
      writeEvent({ destroyed: true, writableEnded: false, write } as never, event, "instance"),
    ).toBe(false);
    expect(
      writeEvent({ destroyed: false, writableEnded: true, write } as never, event, "instance"),
    ).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("sidecar REST surface", () => {
  it("accepts one authenticated browser file upload as a durable local input reference", async () => {
    const fixture = await createFixture();
    const session = await login(fixture);
    const response = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/uploads?name=phone-note.txt&relativePath=notes%2Fphone-note.txt",
      headers: {
        cookie: session.cookie,
        "content-type": "application/octet-stream",
        host: "127.0.0.1:18790",
        origin: "http://127.0.0.1:18790",
        "sec-fetch-site": "same-origin",
        "x-csrf-token": session.csrfToken,
        "idempotency-key": "browser-upload-phone-note",
      },
      payload: Buffer.from("uploaded from phone", "utf8"),
    });

    expect(response.statusCode).toBe(201);
    const reference = response.json<LocalInputReference>();
    expect(reference).toMatchObject({
      kind: "file",
      relativePath: "notes/phone-note.txt",
    });
    const uploads = await BrowserUploadStore.open(fixture.directory);
    const resolved = await uploads.resolve(reference);
    expect(await readFile(resolved.path, "utf8")).toBe("uploaded from phone");
  });

  it("keeps the full proxy prefix and redirects the bare base path", async () => {
    const fixture = await createFixture();

    const redirect = await fixture.app.inject({ method: "GET", url: "/codex-remote" });
    expect(redirect.statusCode).toBe(308);
    expect(redirect.headers.location).toBe("/codex-remote/");

    const missingPrefix = await fixture.app.inject({ method: "GET", url: "/api/v1/bootstrap" });
    expect(missingPrefix.statusCode).toBe(404);
    await fixture.app.close();
  });

  it("serves newly built hashed assets without restarting and never masks missing assets as HTML", async () => {
    const fixture = await createFixture(true, undefined, {
      "assets/index-old.js": "console.log('old');",
      "index.html": '<!doctype html><div id="root"></div>',
    });
    await mkdir(path.join(fixture.webDir, "assets"), { recursive: true });
    await writeFile(
      path.join(fixture.webDir, "assets", "index-new.js"),
      "console.log('new');",
      "utf8",
    );

    const newAsset = await fixture.app.inject({
      method: "GET",
      url: "/codex-remote/assets/index-new.js",
    });
    expect(newAsset.statusCode).toBe(200);
    expect(newAsset.headers["content-type"]).toContain("javascript");
    expect(newAsset.body).toBe("console.log('new');");

    const missingAsset = await fixture.app.inject({
      method: "GET",
      url: "/codex-remote/assets/index-missing.js",
    });
    expect(missingAsset.statusCode).toBe(404);
    expect(missingAsset.headers["content-type"]).not.toContain("text/html");

    const clientRoute = await fixture.app.inject({
      method: "GET",
      url: "/codex-remote/threads/thread-1",
    });
    expect(clientRoute.statusCode).toBe(200);
    expect(clientRoute.headers["content-type"]).toContain("text/html");
    await fixture.app.close();
  });

  it("exposes only bootstrap before login and authenticates through a Secure scoped cookie", async () => {
    const fixture = await createFixture();
    const bootstrap = await fixture.app.inject({
      method: "GET",
      url: "/codex-remote/api/v1/bootstrap",
    });

    expect(bootstrap.json()).toEqual({
      authenticated: false,
      basePath: "/codex-remote",
      configured: true,
      productName: "Codex Local Remote",
      schemaVersion: 1,
    });

    const denied = await fixture.app.inject({
      method: "GET",
      url: "/codex-remote/api/v1/projects",
    });
    expect(denied.statusCode).toBe(401);
    expect(fixture.listProjects).not.toHaveBeenCalled();

    const login = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/auth/login",
      headers: {
        host: "127.0.0.1:18790",
        origin: "http://127.0.0.1:18790",
        "sec-fetch-site": "same-origin",
      },
      payload: { password: fixture.password },
    });
    expect(login.statusCode).toBe(200);
    const loginBody = login.json<{ authenticated: boolean; csrfToken: string }>();
    expect(loginBody.authenticated).toBe(true);
    expect(typeof loginBody.csrfToken).toBe("string");
    expect(login.headers["set-cookie"]).toContain("Secure");
    expect(login.headers["set-cookie"]).toContain("HttpOnly");
    expect(login.headers["set-cookie"]).toContain("SameSite=Strict");
    expect(login.headers["set-cookie"]).toContain("Path=/codex-remote");

    const projects = await fixture.app.inject({
      method: "GET",
      url: "/codex-remote/api/v1/projects",
      headers: { cookie: cookieFrom(login) },
    });
    expect(projects.statusCode).toBe(200);
    expect(projects.headers["cache-control"]).toBe("no-store, private");
    expect(projects.json()).toEqual([
      { id: "project-1", name: "示例项目", rootLabel: "sample", source: "registered" },
    ]);
    await fixture.app.close();
  });

  it("exposes only bounded request readiness and fails closed while Desktop is recovering", async () => {
    const fixture = await createFixture();

    const ready = await fixture.app.inject({
      method: "GET",
      url: "/codex-remote/api/v1/ready",
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready" });

    fixture.diagnostics.capabilities.appServer = "degraded";
    const recovering = await fixture.app.inject({
      method: "GET",
      url: "/codex-remote/api/v1/ready",
    });
    expect(recovering.statusCode).toBe(503);
    expect(recovering.headers["retry-after"]).toBe("2");
    expect(recovering.json()).toEqual({ status: "recovering" });
    await fixture.app.close();
  });

  it("passes archived history onto its own cursor stream and defaults current history to false", async () => {
    const fixture = await createFixture();
    const login = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/auth/login",
      headers: {
        host: "127.0.0.1:18790",
        origin: "http://127.0.0.1:18790",
        "sec-fetch-site": "same-origin",
      },
      payload: { password: fixture.password },
    });
    const cookie = cookieFrom(login);
    fixture.listThreads
      .mockResolvedValueOnce({ data: [], nextCursor: "archived-next" })
      .mockResolvedValueOnce({ data: [] });

    const archived = await fixture.app.inject({
      method: "GET",
      url: "/codex-remote/api/v1/threads?archived=true&cursor=archived-current&limit=25",
      headers: { cookie },
    });
    const current = await fixture.app.inject({
      method: "GET",
      url: "/codex-remote/api/v1/threads",
      headers: { cookie },
    });

    expect(archived.statusCode).toBe(200);
    expect(archived.headers["x-next-cursor"]).toBe("archived-next");
    expect(fixture.listThreads).toHaveBeenNthCalledWith(1, {
      archived: true,
      cursor: "archived-current",
      limit: 25,
    });
    expect(fixture.listThreads).toHaveBeenNthCalledWith(2, { archived: false });
    expect(current.statusCode).toBe(200);
    await fixture.app.close();
  });

  it("returns dynamic permission profiles for the selected thread without exposing its cwd", async () => {
    const fixture = await createFixture();
    const authenticated = await login(fixture);

    const response = await fixture.app.inject({
      method: "GET",
      url: "/codex-remote/api/v1/permission-profiles?threadId=thread-new",
      headers: { cookie: authenticated.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        allowed: true,
        description: "允许项目内读写",
        id: ":workspace",
      },
    ]);
    expect(fixture.domain.listPermissionProfiles).toHaveBeenCalledWith({
      threadId: "thread-new",
    });
    await fixture.app.close();
  });

  it("serves a lightweight task shell before the full conversation history", async () => {
    const fixture = await createFixture();
    const authenticated = await login(fixture);
    fixture.domain.getThread.mockResolvedValue({
      id: "thread-shell",
      title: "超长任务",
      mode: "managed",
      state: "running",
      updatedAt: "2026-07-27T00:00:00.000Z",
      items: [],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: false,
        steer: false,
      },
    });

    const response = await fixture.app.inject({
      method: "GET",
      url: "/codex-remote/api/v1/threads/thread-shell?includeItems=false",
      headers: { cookie: authenticated.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: "thread-shell", items: [] });
    expect(fixture.domain.getThread).toHaveBeenCalledWith("thread-shell", {
      includeTurns: false,
    });
    await fixture.app.close();
  });

  it("reuses a bounded recent transcript immediately and keeps its replay watermark", async () => {
    const fixture = await createFixture();
    const authenticated = await login(fixture);
    const recentDetail: ThreadDetail = {
      id: "thread-recent-cache",
      title: "超长任务",
      mode: "managed",
      state: "running",
      updatedAt: "2026-07-27T00:00:00.000Z",
      historyNextCursor: "older-page",
      items: [
        {
          id: "assistant-latest",
          kind: "assistant-message",
          text: "最近回复",
        },
      ],
      activeTurnId: "turn-1",
      availableActions: {
        changeModelNextTurn: true,
        interrupt: true,
        reply: false,
        steer: true,
      },
    };
    fixture.events.append("diagnostic", { message: "快照前事件" });
    fixture.domain.getThread.mockResolvedValue(recentDetail);

    const first = await fixture.app.inject({
      method: "GET",
      url: "/codex-remote/api/v1/threads/thread-recent-cache",
      headers: { cookie: authenticated.cookie },
    });
    fixture.events.append("diagnostic", { message: "快照后事件" });
    const refreshed = await fixture.app.inject({
      method: "GET",
      url: "/codex-remote/api/v1/threads/thread-recent-cache",
      headers: { cookie: authenticated.cookie },
    });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      historyNextCursor: "older-page",
      items: [{ id: "assistant-latest", text: "最近回复" }],
      snapshotEventSeq: 1,
      state: "running",
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({
      historyNextCursor: "older-page",
      items: [{ id: "assistant-latest", text: "最近回复" }],
      snapshotEventSeq: 1,
      state: "running",
    });
    expect(fixture.domain.getThread).toHaveBeenNthCalledWith(1, "thread-recent-cache");
    expect(fixture.domain.getThread).toHaveBeenCalledTimes(1);
    await fixture.app.close();
  });

  it("passes opaque bottom-up history cursors through without decoding them", async () => {
    const fixture = await createFixture();
    const authenticated = await login(fixture);
    fixture.domain.getThread.mockResolvedValue({
      id: "thread-history",
      title: "超长任务",
      mode: "managed",
      state: "running",
      updatedAt: "2026-07-27T00:00:00.000Z",
      items: [],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: true,
        reply: false,
        steer: true,
      },
    });

    const response = await fixture.app.inject({
      method: "GET",
      url: "/codex-remote/api/v1/threads/thread-history?historyCursor=opaque%2Fpage%2B2",
      headers: { cookie: authenticated.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(fixture.domain.getThread).toHaveBeenCalledWith("thread-history", {
      historyCursor: "opaque/page+2",
    });
    await fixture.app.close();
  });

  it("returns only the approval reviewers advertised by the runtime catalog", async () => {
    const fixture = await createFixture();
    const authenticated = await login(fixture);

    const response = await fixture.app.inject({
      method: "GET",
      url: "/codex-remote/api/v1/approval-reviewers",
      headers: { cookie: authenticated.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ id: "user" }, { id: "future-reviewer" }]);
    expect(fixture.domain.listApprovalReviewers).toHaveBeenCalledTimes(1);
    await fixture.app.close();
  });

  it("routes native next-turn settings and goal mutations without hardcoded option allowlists", async () => {
    const fixture = await createFixture();
    const authenticated = await login(fixture);
    const mutationHeaders = {
      cookie: authenticated.cookie,
      host: "127.0.0.1:18790",
      origin: "http://127.0.0.1:18790",
      "sec-fetch-site": "same-origin",
      "x-csrf-token": authenticated.csrfToken,
    };

    const settings = await fixture.app.inject({
      method: "PATCH",
      url: "/codex-remote/api/v1/threads/thread-new/settings",
      headers: { ...mutationHeaders, "idempotency-key": "settings-dynamic-1" },
      payload: {
        approvalsReviewer: "future-reviewer",
        collaborationMode: "future-plan",
        model: "future-model",
        permissionProfileId: "future-profile",
        reasoningEffort: "future-effort",
        serviceTier: "future-speed",
      },
    });
    expect(settings.statusCode).toBe(204);
    expect(fixture.domain.updateThreadSettings).toHaveBeenCalledWith("thread-new", {
      approvalsReviewer: "future-reviewer",
      collaborationMode: "future-plan",
      model: "future-model",
      permissionProfileId: "future-profile",
      reasoningEffort: "future-effort",
      serviceTier: "future-speed",
    });

    const setGoal = await fixture.app.inject({
      method: "PUT",
      url: "/codex-remote/api/v1/threads/thread-new/goal",
      headers: { ...mutationHeaders, "idempotency-key": "goal-set-dynamic-1" },
      payload: {
        objective: "完成三端实时验收",
        tokenBudget: 50_000,
      },
    });
    expect(setGoal.statusCode).toBe(204);
    expect(fixture.domain.setThreadGoal).toHaveBeenCalledWith("thread-new", {
      objective: "完成三端实时验收",
      tokenBudget: 50_000,
    });

    const clearGoal = await fixture.app.inject({
      method: "DELETE",
      url: "/codex-remote/api/v1/threads/thread-new/goal",
      headers: { ...mutationHeaders, "idempotency-key": "goal-clear-dynamic-1" },
    });
    expect(clearGoal.statusCode).toBe(204);
    expect(fixture.domain.clearThreadGoal).toHaveBeenCalledWith("thread-new");
    await fixture.app.close();
  });

  it("broadcasts an accepted steer to every Web client exactly once across idempotent retries", async () => {
    const fixture = await createFixture();
    const authenticated = await login(fixture);
    const sequenceBeforeSteer = fixture.events.latestSequence;
    const headers = {
      cookie: authenticated.cookie,
      host: "127.0.0.1:18790",
      origin: "http://127.0.0.1:18790",
      "sec-fetch-site": "same-origin",
      "x-csrf-token": authenticated.csrfToken,
      "idempotency-key": "steer-live-broadcast-1",
    };
    const request = {
      method: "POST" as const,
      url: "/codex-remote/api/v1/threads/thread-new/turns/turn-new/steer",
      headers,
      payload: { prompt: "跨页立即显示这条引导" },
    };

    const first = await fixture.app.inject(request);
    const retry = await fixture.app.inject(request);
    expect(first.statusCode).toBe(204);
    expect(retry.statusCode).toBe(204);
    expect(fixture.domain.steerTurn).toHaveBeenCalledTimes(1);
    expect(fixture.domain.steerTurn).toHaveBeenCalledWith("thread-new", "turn-new", {
      prompt: "跨页立即显示这条引导",
    });

    const broadcast = fixture.events
      .replayAfter(sequenceBeforeSteer)
      .events.filter((event) => event.type === "thread.item");
    expect(broadcast).toHaveLength(1);
    expect(broadcast[0]).toMatchObject({
      threadId: "thread-new",
      turnId: "turn-new",
      payload: {
        lifecycle: "started",
        localRemoteAlias: "steer",
        item: [
          {
            kind: "user-message",
            text: "跨页立即显示这条引导",
          },
        ],
      },
    });
    expect((broadcast[0]?.payload as { item: Array<{ id: string }> }).item[0]?.id).toMatch(
      /^pending-steer-/u,
    );
    await fixture.app.close();
  });

  it("withdraws the cross-Web steer alias when Desktop rejects the steer", async () => {
    const fixture = await createFixture();
    fixture.domain.steerTurn.mockRejectedValueOnce(new Error("turn ended"));
    const authenticated = await login(fixture);
    const sequenceBeforeSteer = fixture.events.latestSequence;
    const response = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/threads/thread-new/turns/turn-new/steer",
      headers: {
        cookie: authenticated.cookie,
        host: "127.0.0.1:18790",
        origin: "http://127.0.0.1:18790",
        "sec-fetch-site": "same-origin",
        "x-csrf-token": authenticated.csrfToken,
        "idempotency-key": "steer-live-rejected-1",
      },
      payload: { prompt: "这次引导会失败" },
    });
    expect(response.statusCode).toBe(500);
    const broadcast = fixture.events
      .replayAfter(sequenceBeforeSteer)
      .events.filter((event) => event.type === "thread.item");
    expect(broadcast).toHaveLength(2);
    const aliases = broadcast.map((event) => {
      const payload = event.payload as {
        item: Array<{ id: string }>;
        localRemoteAlias: string;
      };
      return {
        alias: payload.localRemoteAlias,
        itemId: payload.item[0]?.id,
      };
    });
    expect(aliases.map((entry) => entry.alias)).toEqual(["steer", "steer-cancel"]);
    expect(aliases[0]?.itemId).toBe(aliases[1]?.itemId);
    await fixture.app.close();
  });

  it("attaches the current event watermark to a complete thread detail snapshot", async () => {
    const fixture = await createFixture();
    const login = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/auth/login",
      headers: {
        host: "127.0.0.1:18790",
        origin: "http://127.0.0.1:18790",
        "sec-fetch-site": "same-origin",
      },
      payload: { password: fixture.password },
    });
    fixture.getThread.mockResolvedValue({
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
      id: "thread-watermark",
      items: [],
      mode: "managed",
      state: "idle",
      title: "水位快照",
      updatedAt: "2026-07-25T00:00:00.000Z",
    });
    fixture.events.append("diagnostic", { message: "快照前事件" });
    fixture.events.append("diagnostic", { message: "快照前事件 2" });

    const response = await fixture.app.inject({
      method: "GET",
      url: "/codex-remote/api/v1/threads/thread-watermark",
      headers: { cookie: cookieFrom(login) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "thread-watermark",
      snapshotEventSeq: 2,
    });
    expect(fixture.getThread).toHaveBeenCalledWith("thread-watermark");
    await fixture.app.close();
  });

  it("does not overestimate a snapshot watermark when events advance during the domain read", async () => {
    const fixture = await createFixture();
    const login = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/auth/login",
      headers: {
        host: "127.0.0.1:18790",
        origin: "http://127.0.0.1:18790",
        "sec-fetch-site": "same-origin",
      },
      payload: { password: fixture.password },
    });
    fixture.events.append("diagnostic", { message: "covered before snapshot" });
    fixture.getThread.mockImplementation(async () => {
      fixture.events.append("diagnostic", { message: "arrived during snapshot" });
      return {
        availableActions: {
          changeModelNextTurn: true,
          interrupt: false,
          reply: true,
          steer: false,
        },
        id: "thread-concurrent-watermark",
        items: [],
        mode: "managed",
        state: "idle",
        title: "并发水位快照",
        updatedAt: "2026-07-25T00:00:00.000Z",
      };
    });

    const response = await fixture.app.inject({
      method: "GET",
      url: "/codex-remote/api/v1/threads/thread-concurrent-watermark",
      headers: { cookie: cookieFrom(login) },
    });

    expect(response.statusCode).toBe(200);
    expect(fixture.events.latestSequence).toBe(2);
    expect(response.json()).toMatchObject({
      id: "thread-concurrent-watermark",
      snapshotEventSeq: 1,
    });
    await fixture.app.close();
  });

  it("attaches a safe event watermark to create, resume, and cached turn snapshots", async () => {
    const fixture = await createFixture();
    const origin = "https://phone.example.test";
    const forwardedHeaders = {
      host: "127.0.0.1:18790",
      origin,
      "sec-fetch-site": "same-origin",
      "x-forwarded-host": "phone.example.test",
      "x-forwarded-proto": "https",
    };
    const login = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/auth/login",
      remoteAddress: "127.0.0.1",
      headers: forwardedHeaders,
      payload: { password: fixture.password },
    });
    const session = login.json<{ csrfToken: string }>();
    const detail: ThreadDetail = {
      availableActions: {
        changeModelNextTurn: true,
        interrupt: false,
        reply: true,
        steer: false,
      },
      id: "thread-watermark",
      items: [],
      mode: "managed",
      state: "idle",
      title: "水位快照",
      updatedAt: "2026-07-25T00:00:00.000Z",
    };
    vi.mocked(fixture.resumeThread).mockResolvedValue(detail);
    fixture.getThread.mockResolvedValue(detail);
    const mutationHeaders = {
      ...forwardedHeaders,
      cookie: cookieFrom(login),
      "x-csrf-token": session.csrfToken,
    };

    fixture.events.append("diagnostic", { message: "create watermark" });
    const created = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/threads",
      headers: { ...mutationHeaders, "idempotency-key": "watermark-create" },
      payload: { prompt: "创建对话" },
    });
    expect(created.json()).toMatchObject({ id: "thread-new", snapshotEventSeq: 1 });

    fixture.events.append("diagnostic", { message: "resume watermark" });
    const resumed = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/threads/thread-watermark/resume",
      headers: { ...mutationHeaders, "idempotency-key": "watermark-resume" },
    });
    expect(resumed.json()).toMatchObject({ id: "thread-watermark", snapshotEventSeq: 2 });

    fixture.events.append("diagnostic", { message: "turn watermark" });
    const turned = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/threads/thread-watermark/turns",
      headers: { ...mutationHeaders, "idempotency-key": "watermark-turn" },
      payload: { prompt: "继续" },
    });
    expect(turned.json()).toMatchObject({ id: "thread-watermark", snapshotEventSeq: 2 });
    expect(fixture.startTurn).toHaveBeenCalledWith("thread-watermark", { prompt: "继续" });
    await fixture.app.close();
  });

  it("replays only newer events for a Last-Event-ID from the same stream instance", async () => {
    const fixture = await createFixture();
    const login = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/auth/login",
      headers: {
        host: "127.0.0.1:18790",
        origin: "http://127.0.0.1:18790",
        "sec-fetch-site": "same-origin",
      },
      payload: { password: fixture.password },
    });
    const cookie = cookieFrom(login);
    fixture.events.append("diagnostic", { message: "first generation event" });
    try {
      const first = await readEventHandshake(fixture, cookie);
      expect(first.map((frame) => frame.event.type)).toEqual(["connection.ready"]);
      const firstReady = first.find((frame) => frame.event.type === "connection.ready");
      expect(firstReady?.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:1$/u,
      );

      fixture.events.append("diagnostic", { message: "second generation event" });
      const replayed = await readEventHandshake(fixture, cookie, firstReady?.id);
      expect(replayed.map((frame) => frame.event.type)).toEqual(["diagnostic", "connection.ready"]);
      expect(replayed.map((frame) => frame.event.seq)).toEqual([2, 2]);
      expect(replayed.every((frame) => frame.id.endsWith(":2"))).toBe(true);
      expect(replayed.every((frame) => typeof frame.event.seq === "number")).toBe(true);
    } finally {
      await fixture.app.close();
    }
  });

  it("starts a fresh event stream at the current watermark instead of replaying stale buffer", async () => {
    const fixture = await createFixture();
    const session = await login(fixture);
    for (let sequence = 1; sequence <= 128; sequence += 1) {
      fixture.events.append("diagnostic", { message: `stale event ${sequence}` });
    }
    try {
      const frames = await readEventHandshake(fixture, session.cookie);
      expect(frames.map((frame) => frame.event.type)).toEqual(["connection.ready"]);
      expect(frames[0]?.event.seq).toBe(128);
      expect(frames[0]?.id).toMatch(/:128$/u);
    } finally {
      await fixture.app.close();
    }
  });

  it("resets before ready for a foreign or legacy Last-Event-ID even at a higher latest seq", async () => {
    const oldFixture = await createFixture();
    const oldLogin = await oldFixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/auth/login",
      headers: {
        host: "127.0.0.1:18790",
        origin: "http://127.0.0.1:18790",
        "sec-fetch-site": "same-origin",
      },
      payload: { password: oldFixture.password },
    });
    oldFixture.events.append("diagnostic", { message: "old instance event" });
    const oldFrames = await readEventHandshake(oldFixture, cookieFrom(oldLogin));
    const oldId = oldFrames.find((frame) => frame.event.type === "connection.ready")?.id;
    await oldFixture.app.close();
    expect(oldId).toBeDefined();

    const newFixture = await createFixture();
    const newLogin = await newFixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/auth/login",
      headers: {
        host: "127.0.0.1:18790",
        origin: "http://127.0.0.1:18790",
        "sec-fetch-site": "same-origin",
      },
      payload: { password: newFixture.password },
    });
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      newFixture.events.append("diagnostic", { message: `new instance event ${sequence}` });
    }
    try {
      for (const lastEventId of [oldId, "1"]) {
        const frames = await readEventHandshake(newFixture, cookieFrom(newLogin), lastEventId);
        expect(frames.map((frame) => frame.event.type)).toEqual([
          "connection.reset",
          "connection.ready",
        ]);
        expect(frames.map((frame) => frame.event.seq)).toEqual([5, 5]);
        expect(frames[0]?.id).not.toBe(oldId);
        expect(frames.every((frame) => frame.id.endsWith(":5"))).toBe(true);
        expect(frames.every((frame) => typeof frame.event.seq === "number")).toBe(true);
      }
    } finally {
      await newFixture.app.close();
    }
  });

  it("accepts the bounded query cursor used by browsers without native EventSource", async () => {
    const fixture = await createFixture();
    const session = await login(fixture);
    fixture.events.append("diagnostic", { code: "before-restart" });
    try {
      const frames = await readEventHandshake(
        fixture,
        session.cookie,
        undefined,
        "foreign-stream:1",
      );
      expect(frames.map((frame) => frame.event.type)).toEqual([
        "connection.reset",
        "connection.ready",
      ]);
    } finally {
      await fixture.app.close();
    }
  });

  it("closes an established event stream before an event can cross same-session logout", async () => {
    const fixture = await createFixture();
    const session = await login(fixture);
    try {
      const observed = await observeSseRevocation(fixture, session.cookie, async () => {
        const logout = await fixture.app.inject({
          method: "POST",
          url: "/codex-remote/api/v1/auth/logout",
          headers: {
            cookie: session.cookie,
            host: "127.0.0.1:18790",
            origin: "http://127.0.0.1:18790",
            "sec-fetch-site": "same-origin",
            "x-csrf-token": session.csrfToken,
          },
        });
        expect(logout.statusCode).toBe(204);
      });

      expect(observed.closed).toBe(true);
      expect(observed.frames.map((frame) => frame.event.type)).toEqual(["connection.ready"]);
    } finally {
      await fixture.app.close();
    }
  });

  it("closes every established event stream after a password change revokes all sessions", async () => {
    const fixture = await createFixture();
    const firstSession = await login(fixture);
    const secondSession = await login(fixture);
    let passwordChange: Promise<void> | undefined;
    try {
      const revokeAll = () => {
        passwordChange ??= setupPassword(
          fixture.state,
          "这是一个用于撤销现有会话且长度足够的新口令",
          "这是一个用于撤销现有会话且长度足够的新口令",
        );
        return passwordChange;
      };
      const observed = await Promise.all([
        observeSseRevocation(fixture, firstSession.cookie, revokeAll),
        observeSseRevocation(fixture, secondSession.cookie, revokeAll),
      ]);

      expect(observed.every((stream) => stream.closed)).toBe(true);
      expect(observed.map((stream) => stream.frames.map((frame) => frame.event.type))).toEqual([
        ["connection.ready"],
        ["connection.ready"],
      ]);
    } finally {
      await fixture.app.close();
    }
  });

  it("keeps an independent session stream alive when another session logs out", async () => {
    const fixture = await createFixture();
    const loggedOutSession = await login(fixture);
    const independentSession = await login(fixture);
    try {
      const observed = await observeSseRevocation(fixture, independentSession.cookie, async () => {
        const logout = await fixture.app.inject({
          method: "POST",
          url: "/codex-remote/api/v1/auth/logout",
          headers: {
            cookie: loggedOutSession.cookie,
            host: "127.0.0.1:18790",
            origin: "http://127.0.0.1:18790",
            "sec-fetch-site": "same-origin",
            "x-csrf-token": loggedOutSession.csrfToken,
          },
        });
        expect(logout.statusCode).toBe(204);
      });

      expect(observed.closed).toBe(false);
      expect(observed.frames.map((frame) => frame.event.type)).toEqual([
        "connection.ready",
        "diagnostic",
      ]);
    } finally {
      await fixture.app.close();
    }
  });

  it.each(["idle", "absolute"] as const)(
    "closes an established event stream at %s session expiry before sending another event",
    async (expiryKind) => {
      const fixture = await createFixture();
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      try {
        const session = await login(fixture);
        if (expiryKind === "absolute") {
          const token = session.cookie.slice(session.cookie.indexOf("=") + 1);
          const justBeforeAbsoluteExpiry = Date.parse(session.expiresAt) - 1_000;
          for (
            let activeAt = 1_000_000 + 23 * 60 * 60 * 1_000;
            activeAt < justBeforeAbsoluteExpiry;
            activeAt += 23 * 60 * 60 * 1_000
          ) {
            now.mockReturnValue(activeAt);
            await fixture.state.touchSession(token, activeAt);
          }
          now.mockReturnValue(justBeforeAbsoluteExpiry);
          await fixture.state.touchSession(token, justBeforeAbsoluteExpiry);
        }
        const observed = await observeSseRevocation(fixture, session.cookie, () => {
          now.mockReturnValue(
            Date.parse(expiryKind === "idle" ? session.idleExpiresAt : session.expiresAt),
          );
        });

        expect(observed.closed).toBe(true);
        expect(observed.frames.map((frame) => frame.event.type)).toEqual(["connection.ready"]);
      } finally {
        now.mockRestore();
        await fixture.app.close();
      }
    },
  );

  it("requires same-origin CSRF and an idempotency key for retryable commands", async () => {
    const fixture = await createFixture();
    const origin = "https://phone.example.test";
    const login = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/auth/login",
      remoteAddress: "127.0.0.1",
      headers: {
        host: "127.0.0.1:18790",
        origin,
        "sec-fetch-site": "same-origin",
        "x-forwarded-host": "phone.example.test",
        "x-forwarded-proto": "https",
      },
      payload: { password: fixture.password },
    });
    const session = login.json<{ csrfToken: string }>();
    const cookie = cookieFrom(login);

    const missingCsrf = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/threads",
      headers: {
        cookie,
        host: "127.0.0.1:18790",
        origin,
        "sec-fetch-site": "same-origin",
        "x-forwarded-host": "phone.example.test",
        "x-forwarded-proto": "https",
        "idempotency-key": "create-1",
      },
      payload: { projectId: "project-1", prompt: "开始" },
    });
    expect(missingCsrf.statusCode).toBe(403);

    const missingKey = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/threads",
      headers: {
        cookie,
        host: "127.0.0.1:18790",
        origin,
        "sec-fetch-site": "same-origin",
        "x-forwarded-host": "phone.example.test",
        "x-forwarded-proto": "https",
        "x-csrf-token": session.csrfToken,
      },
      payload: { projectId: "project-1", prompt: "开始" },
    });
    expect(missingKey.statusCode).toBe(400);

    const created = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/threads",
      headers: {
        cookie,
        host: "127.0.0.1:18790",
        origin,
        "sec-fetch-site": "same-origin",
        "x-forwarded-host": "phone.example.test",
        "x-forwarded-proto": "https",
        "x-csrf-token": session.csrfToken,
        "idempotency-key": "create-1",
      },
      payload: { projectId: "project-1", prompt: "开始" } satisfies CreateThreadInput,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: "thread-new" });
    await fixture.app.close();
  });

  it("accepts a new conversation without a project selection", async () => {
    const fixture = await createFixture();
    const origin = "https://phone.example.test";
    const forwardedHeaders = {
      host: "127.0.0.1:18790",
      origin,
      "sec-fetch-site": "same-origin",
      "x-forwarded-host": "phone.example.test",
      "x-forwarded-proto": "https",
    };
    const login = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/auth/login",
      remoteAddress: "127.0.0.1",
      headers: forwardedHeaders,
      payload: { password: fixture.password },
    });
    const session = login.json<{ csrfToken: string }>();

    const created = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/threads",
      headers: {
        ...forwardedHeaders,
        cookie: cookieFrom(login),
        "idempotency-key": "create-without-project",
        "x-csrf-token": session.csrfToken,
      },
      payload: { prompt: "开始无项目对话" },
    });

    expect(created.statusCode).toBe(201);
    expect(fixture.createThread).toHaveBeenCalledWith({ prompt: "开始无项目对话" });
    await fixture.app.close();
  });

  it("fails closed when creating a task while Desktop runtime compatibility is degraded", async () => {
    const fixture = await createFixture();
    fixture.diagnostics.capabilities.appServer = "degraded";
    const origin = "https://phone.example.test";
    const forwardedHeaders = {
      host: "127.0.0.1:18790",
      origin,
      "sec-fetch-site": "same-origin",
      "x-forwarded-host": "phone.example.test",
      "x-forwarded-proto": "https",
    };
    const login = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/auth/login",
      remoteAddress: "127.0.0.1",
      headers: forwardedHeaders,
      payload: { password: fixture.password },
    });
    const session = login.json<{ csrfToken: string }>();

    const response = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/threads",
      headers: {
        ...forwardedHeaders,
        cookie: cookieFrom(login),
        "idempotency-key": "create-runtime-degraded",
        "x-csrf-token": session.csrfToken,
      },
      payload: { prompt: "不应发送到 Desktop" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "DESKTOP_RUNTIME_NOT_READY" } });
    expect(fixture.createThread).not.toHaveBeenCalled();
    await fixture.app.close();
  });

  it("uses request readiness instead of transient diagnostic presentation state when creating a task", async () => {
    const fixture = await createFixture(true, undefined, undefined, () => true);
    fixture.diagnostics.capabilities.appServer = "degraded";
    const origin = "https://phone.example.test";
    const forwardedHeaders = {
      host: "127.0.0.1:18790",
      origin,
      "sec-fetch-site": "same-origin",
      "x-forwarded-host": "phone.example.test",
      "x-forwarded-proto": "https",
    };
    const login = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/auth/login",
      remoteAddress: "127.0.0.1",
      headers: forwardedHeaders,
      payload: { password: fixture.password },
    });
    const session = login.json<{ csrfToken: string }>();

    const response = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/threads",
      headers: {
        ...forwardedHeaders,
        cookie: cookieFrom(login),
        "idempotency-key": "create-while-diagnostics-refresh",
        "x-csrf-token": session.csrfToken,
      },
      payload: { prompt: "兼容性轮询期间仍应创建" },
    });

    expect(response.statusCode).toBe(201);
    expect(fixture.createThread).toHaveBeenCalledWith({ prompt: "兼容性轮询期间仍应创建" });
    await fixture.app.close();
  });

  it.each([
    new RpcConnectionClosedError(),
    new RpcTimeoutError("thread/list", 30_000),
    new SharedAppServerConnectionError("ws://127.0.0.1:18791/"),
  ])("maps a transient Desktop connection failure to retryable 503", async (failure) => {
    const fixture = await createFixture();
    fixture.domain.listModels = vi.fn(async () => {
      throw failure;
    });
    const login = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/auth/login",
      remoteAddress: "127.0.0.1",
      headers: {
        host: "127.0.0.1:18790",
        origin: "http://127.0.0.1:18790",
        "sec-fetch-site": "same-origin",
      },
      payload: { password: fixture.password },
    });

    const response = await fixture.app.inject({
      method: "GET",
      url: "/codex-remote/api/v1/models",
      headers: { cookie: cookieFrom(login) },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("2");
    expect(response.json()).toMatchObject({
      error: {
        code: "DESKTOP_RUNTIME_NOT_READY",
        message: "电脑端连接正在恢复，请稍后重试",
      },
    });
    await fixture.app.close();
  });

  it("does not disguise an app-server business error as a connection outage", async () => {
    const fixture = await createFixture();
    fixture.domain.listModels = vi.fn(async () => {
      throw new RpcRequestError("model/list", -32_000, "schema mismatch");
    });
    const login = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/auth/login",
      remoteAddress: "127.0.0.1",
      headers: {
        host: "127.0.0.1:18790",
        origin: "http://127.0.0.1:18790",
        "sec-fetch-site": "same-origin",
      },
      payload: { password: fixture.password },
    });

    const response = await fixture.app.inject({
      method: "GET",
      url: "/codex-remote/api/v1/models",
      headers: { cookie: cookieFrom(login) },
    });

    expect(response.statusCode).toBe(500);
    expect(response.headers["retry-after"]).toBeUndefined();
    expect(response.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
    await fixture.app.close();
  });

  it("accepts context compaction only as a protected idempotent mutation", async () => {
    const fixture = await createFixture();
    const origin = "https://phone.example.test";
    const forwardedHeaders = {
      host: "127.0.0.1:18790",
      "sec-fetch-site": "same-origin",
      "x-forwarded-host": "phone.example.test",
      "x-forwarded-proto": "https",
    };
    const login = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/auth/login",
      remoteAddress: "127.0.0.1",
      headers: { ...forwardedHeaders, origin },
      payload: { password: fixture.password },
    });
    const session = login.json<{ csrfToken: string }>();
    const cookie = cookieFrom(login);
    const url = "/codex-remote/api/v1/threads/thread-new/compact";

    const crossOrigin = await fixture.app.inject({
      method: "POST",
      url,
      headers: {
        ...forwardedHeaders,
        cookie,
        "idempotency-key": "compact-cross-origin",
        origin: "https://attacker.example.test",
        "x-csrf-token": session.csrfToken,
      },
    });
    expect(crossOrigin.statusCode).toBe(403);

    const missingCsrf = await fixture.app.inject({
      method: "POST",
      url,
      headers: {
        ...forwardedHeaders,
        cookie,
        "idempotency-key": "compact-missing-csrf",
        origin,
      },
    });
    expect(missingCsrf.statusCode).toBe(403);

    const missingKey = await fixture.app.inject({
      method: "POST",
      url,
      headers: {
        ...forwardedHeaders,
        cookie,
        origin,
        "x-csrf-token": session.csrfToken,
      },
    });
    expect(missingKey.statusCode).toBe(400);

    const headers = {
      ...forwardedHeaders,
      cookie,
      "idempotency-key": "compact-thread-new",
      origin,
      "x-csrf-token": session.csrfToken,
    };
    const accepted = await fixture.app.inject({ method: "POST", url, headers });
    const retried = await fixture.app.inject({ method: "POST", url, headers });

    expect(accepted.statusCode).toBe(202);
    expect(accepted.body).toBe("");
    expect(retried.statusCode).toBe(202);
    expect(retried.body).toBe("");
    expect(fixture.compactThread).toHaveBeenCalledOnce();
    expect(fixture.compactThread).toHaveBeenCalledWith("thread-new");
    await fixture.app.close();
  });

  it("keeps bounded CSRF generations valid across two browser tabs", async () => {
    const fixture = await createFixture();
    const origin = "http://127.0.0.1:18790";
    const commonHeaders = {
      host: "127.0.0.1:18790",
      origin,
      "sec-fetch-site": "same-origin",
    };
    const login = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/auth/login",
      headers: commonHeaders,
      payload: { password: fixture.password },
    });
    const tabOne = login.json<{ csrfToken: string }>();
    const cookie = cookieFrom(login);
    const session = await fixture.app.inject({
      method: "GET",
      url: "/codex-remote/api/v1/auth/session",
      headers: { cookie },
    });
    const tabTwo = session.json<{ csrfToken: string }>();
    expect(tabTwo.csrfToken).not.toBe(tabOne.csrfToken);

    for (const [index, csrfToken] of [tabOne.csrfToken, tabTwo.csrfToken].entries()) {
      const created = await fixture.app.inject({
        method: "POST",
        url: "/codex-remote/api/v1/threads",
        headers: {
          ...commonHeaders,
          cookie,
          "idempotency-key": `browser-tab-${index}`,
          "x-csrf-token": csrfToken,
        },
        payload: { projectId: "project-1", prompt: "开始" },
      });
      expect(created.statusCode).toBe(201);
    }
    await fixture.app.close();
  });

  it("allows initial password setup only from the actual loopback socket", async () => {
    const fixture = await createFixture(false);
    const password = "这是一个用于首次设置且长度足够的本机口令";

    const remote = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/setup/password",
      remoteAddress: "192.0.2.10",
      payload: { confirmation: password, password },
    });
    expect(remote.statusCode).toBe(403);

    const local = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/setup/password",
      remoteAddress: "127.0.0.1",
      headers: {
        host: "127.0.0.1:18790",
        origin: "http://127.0.0.1:18790",
        "sec-fetch-site": "same-origin",
      },
      payload: { confirmation: password, password },
    });
    expect(local.statusCode).toBe(200);
    const localBody = local.json<{ authenticated: boolean; csrfToken: string }>();
    expect(localBody.authenticated).toBe(true);
    expect(typeof localBody.csrfToken).toBe("string");
    expect(fixture.state.configured).toBe(true);
    await fixture.app.close();
  });

  it("rejects password-setup claims that arrived through a loopback proxy", async () => {
    const fixture = await createFixture(false);
    const password = "这是一个用于首次设置且长度足够的本机口令";

    const response = await fixture.app.inject({
      method: "POST",
      url: "/codex-remote/api/v1/setup/password",
      remoteAddress: "127.0.0.1",
      headers: {
        host: "127.0.0.1:18790",
        origin: "http://127.0.0.1:18790",
        "sec-fetch-site": "same-origin",
        "x-forwarded-for": "203.0.113.10",
        "x-forwarded-host": "public.example.test",
        "x-forwarded-proto": "https",
      },
      payload: { confirmation: password, password },
    });

    expect(response.statusCode).toBe(403);
    expect(fixture.state.configured).toBe(false);
    await fixture.app.close();
  });
});

describe("sidecar durable turn queue routes", () => {
  it("routes authenticated queue mutations with one durable idempotency scope", async () => {
    const snapshot = {
      items: [],
      revision: 4,
      threadId: "thread-queue",
    };
    const queue = {
      edit: vi.fn(async () => snapshot),
      enqueue: vi.fn(async () => snapshot),
      list: vi.fn(async () => snapshot),
      remove: vi.fn(async () => snapshot),
      reorder: vi.fn(async () => snapshot),
      send: vi.fn(async () => snapshot),
      steer: vi.fn(async () => snapshot),
    } satisfies SidecarTurnQueueApi;
    const fixture = await createFixture(true, queue);
    const session = await login(fixture);
    const mutationHeaders = {
      cookie: session.cookie,
      host: "127.0.0.1:18790",
      origin: "http://127.0.0.1:18790",
      "sec-fetch-site": "same-origin",
      "x-csrf-token": session.csrfToken,
    };

    const listed = await fixture.app.inject({
      headers: { cookie: session.cookie },
      method: "GET",
      url: "/codex-remote/api/v1/threads/thread-queue/queue",
    });
    const enqueued = await fixture.app.inject({
      headers: { ...mutationHeaders, "idempotency-key": "queue-enqueue-1" },
      method: "POST",
      payload: { model: "gpt-fixture", prompt: "排队到下一轮", reasoningEffort: "high" },
      url: "/codex-remote/api/v1/threads/thread-queue/queue",
    });
    const edited = await fixture.app.inject({
      headers: { ...mutationHeaders, "idempotency-key": "queue-edit-0001" },
      method: "PATCH",
      payload: { expectedRevision: 1, prompt: "编辑后的下一轮" },
      url: "/codex-remote/api/v1/threads/thread-queue/queue/queue-1",
    });
    const reordered = await fixture.app.inject({
      headers: { ...mutationHeaders, "idempotency-key": "queue-order-001" },
      method: "PUT",
      payload: { expectedRevision: 2, queueIds: ["queue-2", "queue-1"] },
      url: "/codex-remote/api/v1/threads/thread-queue/queue/order",
    });
    const sent = await fixture.app.inject({
      headers: { ...mutationHeaders, "idempotency-key": "queue-send-0001" },
      method: "POST",
      payload: { expectedRevision: 3, retryAmbiguous: true },
      url: "/codex-remote/api/v1/threads/thread-queue/queue/queue-1/send",
    });
    const steered = await fixture.app.inject({
      headers: { ...mutationHeaders, "idempotency-key": "queue-steer-001" },
      method: "POST",
      payload: { expectedRevision: 4, turnId: "turn-current" },
      url: "/codex-remote/api/v1/threads/thread-queue/queue/queue-2/steer",
    });
    const removed = await fixture.app.inject({
      headers: { ...mutationHeaders, "idempotency-key": "queue-delete-01" },
      method: "DELETE",
      payload: { expectedRevision: 5 },
      url: "/codex-remote/api/v1/threads/thread-queue/queue/queue-2",
    });

    expect(listed.statusCode).toBe(200);
    expect(enqueued.statusCode).toBe(202);
    expect(edited.statusCode).toBe(200);
    expect(reordered.statusCode).toBe(200);
    expect(sent.statusCode).toBe(200);
    expect(steered.statusCode).toBe(200);
    expect(removed.statusCode).toBe(200);
    expect(queue.enqueue).toHaveBeenCalledWith(
      "thread-queue",
      {
        model: "gpt-fixture",
        prompt: "排队到下一轮",
        reasoningEffort: "high",
      },
      expect.stringContaining("threadId=thread-queue"),
    );
    expect(queue.reorder).toHaveBeenCalledWith(
      "thread-queue",
      { expectedRevision: 2, queueIds: ["queue-2", "queue-1"] },
      expect.stringContaining("threadId=thread-queue"),
    );
    expect(queue.send).toHaveBeenCalledWith(
      "thread-queue",
      "queue-1",
      { expectedRevision: 3, retryAmbiguous: true },
      expect.stringContaining("queueId=queue-1"),
    );
    expect(queue.steer).toHaveBeenCalledWith(
      "thread-queue",
      "queue-2",
      { expectedRevision: 4, turnId: "turn-current" },
      expect.stringContaining("queueId=queue-2"),
    );
    await fixture.app.close();
  });
});
