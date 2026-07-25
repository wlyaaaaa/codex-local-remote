import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  CreateThreadInput,
  DiagnosticSnapshot,
  SendTurnInput,
} from "@codex-local-remote/contracts";
import { ApprovalCoordinator, RemoteEventBuffer } from "@codex-local-remote/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setupPassword } from "./auth.js";
import { createSidecarServer, type SidecarDomainApi } from "./server.js";
import { SidecarStateStore } from "./state-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

function cookieFrom(response: {
  headers: Record<string, number | string | string[] | undefined>;
}): string {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" ? (value.split(";", 1)[0] ?? "") : "";
}

async function createFixture(configured = true) {
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
  const domain: SidecarDomainApi = {
    compactThread,
    createThread: vi.fn(async (_input: CreateThreadInput) => ({
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
    })),
    getThread: vi.fn(async () => {
      throw new Error("not used");
    }),
    getUsage: vi.fn(async () => ({
      data: { updatedAt: "2026-07-25T00:00:00.000Z", windows: [] },
      degradations: [],
    })),
    interruptTurn: vi.fn(async () => ({
      state: "idle" as const,
      threadId: "thread-new",
      turnId: "turn-new",
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
    listProjects,
    listSubagents: vi.fn(async () => ({ data: [] })),
    listThreads,
    resumeThread: vi.fn(async () => {
      throw new Error("not used");
    }),
    setThreadName: vi.fn(async () => undefined),
    startTurn: vi.fn(async (_threadId: string, _input: SendTurnInput) => ({
      state: "running" as const,
      threadId: "thread-new",
      turnId: "turn-next",
    })),
    steerTurn: vi.fn(async (_threadId: string, _turnId: string, _prompt: string) => ({
      state: "running" as const,
      threadId: "thread-new",
      turnId: "turn-new",
    })),
  };
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
  const app = await createSidecarServer({
    approvals: new ApprovalCoordinator(events),
    config: {
      basePath: "/codex-remote",
      dataDir: directory,
      desktopSyncEnabled: true,
      host: "127.0.0.1",
      port: 18_790,
      webDir: path.join(directory, "missing-web"),
    },
    diagnostics: () => diagnostics,
    domain,
    events,
    state,
  });
  return { app, compactThread, domain, events, listProjects, listThreads, password, state };
}

describe("sidecar REST surface", () => {
  it("keeps the full proxy prefix and redirects the bare base path", async () => {
    const fixture = await createFixture();

    const redirect = await fixture.app.inject({ method: "GET", url: "/codex-remote" });
    expect(redirect.statusCode).toBe(308);
    expect(redirect.headers.location).toBe("/codex-remote/");

    const missingPrefix = await fixture.app.inject({ method: "GET", url: "/api/v1/bootstrap" });
    expect(missingPrefix.statusCode).toBe(404);
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
