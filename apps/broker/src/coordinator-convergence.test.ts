import { describe, expect, it, vi } from "vitest";

import {
  BROKER_HIDDEN_ID_PREFIX,
  BrokerCoordinator,
  type BrokerPair,
  type BrokerWire,
} from "./coordinator.js";

class RecordingWire implements BrokerWire {
  readonly closes: Array<{ code: number; reason: string }> = [];
  readonly sent: string[] = [];

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }

  send(frame: string): void {
    this.sent.push(frame);
  }
}

interface Fixture {
  downstream: RecordingWire;
  pair: BrokerPair;
  upstream: RecordingWire;
}

function attach(coordinator: BrokerCoordinator): Fixture {
  const downstream = new RecordingWire();
  const upstream = new RecordingWire();
  return {
    downstream,
    pair: coordinator.attach({ downstream, upstream }),
    upstream,
  };
}

function messages(wire: RecordingWire): Record<string, unknown>[] {
  return wire.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
}

async function hiddenAfter(
  fixture: Fixture,
  method: string,
  after: number,
): Promise<Record<string, unknown> & { id: string }> {
  let found: (Record<string, unknown> & { id: string }) | undefined;
  await vi.waitFor(() => {
    found = messages(fixture.upstream)
      .slice(after)
      .find(
        (message): message is Record<string, unknown> & { id: string } =>
          message.method === method &&
          typeof message.id === "string" &&
          message.id.startsWith(BROKER_HIDDEN_ID_PREFIX),
      );
    expect(found).toBeDefined();
  });
  if (!found) {
    throw new Error(`Missing hidden ${method}`);
  }
  return found;
}

async function hiddenRequests(
  fixture: Fixture,
  method: string,
  count: number,
): Promise<Array<Record<string, unknown> & { id: string }>> {
  let found: Array<Record<string, unknown> & { id: string }> = [];
  await vi.waitFor(() => {
    found = messages(fixture.upstream).filter(
      (message): message is Record<string, unknown> & { id: string } =>
        message.method === method &&
        typeof message.id === "string" &&
        message.id.startsWith(BROKER_HIDDEN_ID_PREFIX),
    );
    expect(found.length).toBeGreaterThanOrEqual(count);
  });
  return found.slice(0, count);
}

async function initialize(
  fixture: Fixture,
  role: "desktop" | "sidecar",
  loadedThreadIds: string[],
): Promise<void> {
  const id = `${role}-${Math.random().toString(16).slice(2)}-initialize`;
  await fixture.pair.receiveDownstream(
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
            : { name: "codex-local-remote", version: "fixture" },
      },
    }),
  );
  await fixture.pair.receiveUpstream(
    JSON.stringify({ id, result: { userAgent: "codex-cli/fixture" } }),
  );
  await fixture.pair.receiveDownstream(JSON.stringify({ method: "initialized" }));
  const loaded = await hiddenAfter(fixture, "thread/loaded/list", 0);
  await fixture.pair.receiveUpstream(
    JSON.stringify({
      id: loaded.id,
      result: { data: loadedThreadIds, nextCursor: null },
    }),
  );
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function answerNextLoadedList(fixture: Fixture, after: number, data: string[]) {
  const request = await hiddenAfter(fixture, "thread/loaded/list", after);
  await fixture.pair.receiveUpstream(
    JSON.stringify({ id: request.id, result: { data, nextCursor: null } }),
  );
  return request;
}

describe("BrokerCoordinator cross-client convergence", () => {
  it("does not resume threads a client already reported as loaded", async () => {
    const coordinator = new BrokerCoordinator();
    const desktop = attach(coordinator);

    await initialize(desktop, "desktop", ["already-loaded"]);

    expect(
      messages(desktop.upstream).filter((message) => message.method === "thread/resume"),
    ).toEqual([]);
    expect(coordinator.snapshot().degraded).toBe(false);
  });

  it("exposes the Desktop loaded union to Sidecar and subscribes status and approvals", async () => {
    const coordinator = new BrokerCoordinator();
    const desktop = attach(coordinator);
    await initialize(desktop, "desktop", ["desktop-active-a", "desktop-active-b"]);

    const sidecar = attach(coordinator);
    const initializePromise = initialize(sidecar, "sidecar", []);
    const sidecarResumes = await hiddenRequests(sidecar, "thread/resume", 2);
    for (const resume of sidecarResumes) {
      await sidecar.pair.receiveUpstream(
        JSON.stringify({
          id: resume.id,
          result: {
            thread: {
              id: (resume.params as { threadId: string }).threadId,
              status: { type: "active" },
            },
          },
        }),
      );
    }
    await initializePromise;

    const desktopLoadedOffset = desktop.upstream.sent.length;
    const sidecarLoadedOffset = sidecar.upstream.sent.length;
    const visibleList = sidecar.pair.receiveDownstream(
      JSON.stringify({
        id: "visible-loaded-union",
        method: "thread/loaded/list",
        params: { limit: 100 },
      }),
    );
    await Promise.all([
      answerNextLoadedList(desktop, desktopLoadedOffset, ["desktop-active-a", "desktop-active-b"]),
      answerNextLoadedList(sidecar, sidecarLoadedOffset, ["desktop-active-a", "desktop-active-b"]),
    ]);
    await visibleList;

    expect(
      messages(sidecar.downstream).find((message) => message.id === "visible-loaded-union"),
    ).toEqual({
      id: "visible-loaded-union",
      result: {
        data: ["desktop-active-a", "desktop-active-b"],
        nextCursor: null,
      },
    });

    await sidecar.pair.receiveUpstream(
      JSON.stringify({
        method: "thread/status/changed",
        params: {
          status: { type: "active" },
          threadId: "desktop-active-a",
        },
      }),
    );
    await sidecar.pair.receiveUpstream(
      JSON.stringify({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "item-1",
          threadId: "desktop-active-a",
          turnId: "desktop-active-a-turn",
        },
      }),
    );

    expect(
      messages(sidecar.downstream).some(
        (message) =>
          message.method === "thread/status/changed" &&
          (message.params as { threadId?: string }).threadId === "desktop-active-a",
      ),
    ).toBe(true);
    expect(
      messages(sidecar.downstream).some(
        (message) =>
          message.method === "item/commandExecution/requestApproval" && message.id === "approval-1",
      ),
    ).toBe(true);
  });

  it("allows exactly one simultaneous Desktop/Sidecar turn start and never forwards the loser", async () => {
    const coordinator = new BrokerCoordinator();
    const desktop = attach(coordinator);
    const sidecar = attach(coordinator);
    await initialize(desktop, "desktop", []);
    await initialize(sidecar, "sidecar", []);

    await desktop.pair.receiveDownstream(
      JSON.stringify({
        id: "thread-start",
        method: "thread/start",
        params: { cwd: "C:\\workspace" },
      }),
    );
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        id: "thread-start",
        result: { thread: { id: "thread-race" } },
      }),
    );
    const resume = await hiddenAfter(sidecar, "thread/resume", 0);
    await sidecar.pair.receiveUpstream(
      JSON.stringify({
        id: resume.id,
        result: { thread: { id: "thread-race", status: { type: "idle" }, turns: [] } },
      }),
    );

    await Promise.all([
      desktop.pair.receiveDownstream(
        JSON.stringify({
          id: "desktop-turn",
          method: "turn/start",
          params: { input: [], threadId: "thread-race" },
        }),
      ),
      sidecar.pair.receiveDownstream(
        JSON.stringify({
          id: "sidecar-turn",
          method: "turn/start",
          params: { input: [], threadId: "thread-race" },
        }),
      ),
    ]);

    const forwarded = [...messages(desktop.upstream), ...messages(sidecar.upstream)].filter(
      (message) => message.method === "turn/start",
    );
    const rejected = [...messages(desktop.downstream), ...messages(sidecar.downstream)].filter(
      (message) =>
        (message.id === "desktop-turn" || message.id === "sidecar-turn") &&
        (message.error as { code?: number } | undefined)?.code === -32_094,
    );

    expect(forwarded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it("lets Desktop reply in an existing conversation after an authoritative read repairs a missed completion", async () => {
    const coordinator = new BrokerCoordinator();
    const desktop = attach(coordinator);
    await initialize(desktop, "desktop", []);

    await desktop.pair.receiveDownstream(
      JSON.stringify({
        id: "thread-start",
        method: "thread/start",
        params: { cwd: "C:\\workspace" },
      }),
    );
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        id: "thread-start",
        result: { thread: { id: "thread-existing" } },
      }),
    );
    await desktop.pair.receiveDownstream(
      JSON.stringify({
        id: "turn-first",
        method: "turn/start",
        params: { input: [], threadId: "thread-existing" },
      }),
    );
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        id: "turn-first",
        result: { turn: { id: "turn-finished" } },
      }),
    );

    const beforeRead = desktop.upstream.sent.length;
    const reply = desktop.pair.receiveDownstream(
      JSON.stringify({
        id: "turn-reply",
        method: "turn/start",
        params: { input: [], threadId: "thread-existing" },
      }),
    );
    const inspection = await hiddenAfter(desktop, "thread/read", beforeRead);
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        id: inspection.id,
        result: { thread: { id: "thread-existing", status: { type: "idle" } } },
      }),
    );
    await reply;

    expect(
      messages(desktop.upstream).filter(
        (message) => message.method === "turn/start" && message.id === "turn-reply",
      ),
    ).toHaveLength(1);
    expect(
      messages(desktop.downstream).some(
        (message) =>
          message.id === "turn-reply" &&
          (message.error as { code?: number } | undefined)?.code === -32_094,
      ),
    ).toBe(false);
  });

  it("reconverges a Sidecar reconnect without duplicate resumes or duplicate notifications", async () => {
    const coordinator = new BrokerCoordinator();
    const desktop = attach(coordinator);
    await initialize(desktop, "desktop", ["loaded-a", "loaded-b"]);

    const firstSidecar = attach(coordinator);
    const firstInitialization = initialize(firstSidecar, "sidecar", []);
    const firstResumes = await hiddenRequests(firstSidecar, "thread/resume", 2);
    for (const resume of firstResumes) {
      await firstSidecar.pair.receiveUpstream(
        JSON.stringify({
          id: resume.id,
          result: {
            thread: {
              id: (resume.params as { threadId: string }).threadId,
              status: { type: "active" },
            },
          },
        }),
      );
    }
    await firstInitialization;
    firstSidecar.pair.close();

    const reconnected = attach(coordinator);
    const reconnection = initialize(reconnected, "sidecar", []);
    const reconnectedResumes = await hiddenRequests(reconnected, "thread/resume", 2);
    expect(
      reconnectedResumes.map((resume) => (resume.params as { threadId: string }).threadId),
    ).toEqual(["loaded-a", "loaded-b"]);
    for (const resume of reconnectedResumes) {
      await reconnected.pair.receiveUpstream(
        JSON.stringify({
          id: resume.id,
          result: {
            thread: {
              id: (resume.params as { threadId: string }).threadId,
              status: { type: "active" },
            },
          },
        }),
      );
    }
    await reconnection;
    expect(
      messages(reconnected.upstream).filter((message) => message.method === "thread/resume"),
    ).toHaveLength(2);

    await reconnected.pair.receiveUpstream(
      JSON.stringify({
        method: "thread/status/changed",
        params: { status: { type: "idle" }, threadId: "loaded-a" },
      }),
    );
    expect(
      messages(reconnected.downstream).filter(
        (message) =>
          message.method === "thread/status/changed" &&
          (message.params as { threadId?: string }).threadId === "loaded-a",
      ),
    ).toHaveLength(1);
  });

  it("coalesces overlapping convergence and bounds resume concurrency during Sidecar reconnect", async () => {
    const coordinator = new BrokerCoordinator({
      maxBackfillConcurrency: 2,
    });
    const desktop = attach(coordinator);
    const threadIds = ["loaded-a", "loaded-b", "loaded-c", "loaded-d", "loaded-e"];
    await initialize(desktop, "desktop", threadIds);

    const sidecar = attach(coordinator);
    await initialize(sidecar, "sidecar", []);

    await vi.waitFor(() => {
      expect(
        messages(sidecar.upstream).filter((message) => message.method === "thread/resume"),
      ).toHaveLength(2);
    });

    const desktopLoadedOffset = desktop.upstream.sent.length;
    const sidecarLoadedOffset = sidecar.upstream.sent.length;
    const overlappingConvergence = Promise.all([
      coordinator.listLoadedUnion(),
      coordinator.listLoadedUnion(),
    ]);
    await Promise.all([
      answerNextLoadedList(desktop, desktopLoadedOffset, threadIds),
      answerNextLoadedList(sidecar, sidecarLoadedOffset, []),
    ]);

    const answered = new Set<string>();
    while (answered.size < threadIds.length) {
      const resumes = messages(sidecar.upstream).filter(
        (message): message is Record<string, unknown> & { id: string } =>
          message.method === "thread/resume" &&
          typeof message.id === "string" &&
          message.id.startsWith(BROKER_HIDDEN_ID_PREFIX),
      );
      expect(resumes.length - answered.size).toBeLessThanOrEqual(2);
      const next = resumes.find((resume) => !answered.has(resume.id));
      expect(next).toBeDefined();
      if (!next) {
        throw new Error("Missing bounded resume request");
      }
      answered.add(next.id);
      await sidecar.pair.receiveUpstream(
        JSON.stringify({
          id: next.id,
          result: {
            thread: {
              id: (next.params as { threadId: string }).threadId,
              status: { type: "active" },
            },
          },
        }),
      );
      if (answered.size < threadIds.length) {
        await vi.waitFor(() => {
          expect(
            messages(sidecar.upstream).filter(
              (message) =>
                message.method === "thread/resume" &&
                typeof message.id === "string" &&
                !answered.has(message.id),
            ).length,
          ).toBeGreaterThan(0);
        });
      }
    }

    await overlappingConvergence;
    const resumes = messages(sidecar.upstream).filter(
      (message) => message.method === "thread/resume",
    );
    expect(resumes).toHaveLength(threadIds.length);
    expect(
      resumes.map((resume) => (resume.params as { threadId: string }).threadId).sort(),
    ).toEqual([...threadIds].sort());
    expect(coordinator.snapshot().degraded).toBe(false);
  });

  it("paginates the intercepted loaded union with a bounded caller cursor", async () => {
    const coordinator = new BrokerCoordinator();
    const desktop = attach(coordinator);
    const threadIds = ["active-a", "active-b", "active-c"];
    await initialize(desktop, "desktop", threadIds);

    const firstOffset = desktop.upstream.sent.length;
    const firstRequest = desktop.pair.receiveDownstream(
      JSON.stringify({
        id: "loaded-page-1",
        method: "thread/loaded/list",
        params: { limit: 2 },
      }),
    );
    await answerNextLoadedList(desktop, firstOffset, threadIds);
    await firstRequest;
    const first = messages(desktop.downstream).find((message) => message.id === "loaded-page-1");
    expect(first).toMatchObject({
      id: "loaded-page-1",
      result: { data: ["active-a", "active-b"] },
    });
    const cursor = (first?.result as { nextCursor?: unknown } | undefined)?.nextCursor;
    expect(cursor).toEqual(expect.any(String));

    const secondOffset = desktop.upstream.sent.length;
    const secondRequest = desktop.pair.receiveDownstream(
      JSON.stringify({
        id: "loaded-page-2",
        method: "thread/loaded/list",
        params: { cursor, limit: 2 },
      }),
    );
    await answerNextLoadedList(desktop, secondOffset, threadIds);
    await secondRequest;

    expect(messages(desktop.downstream).find((message) => message.id === "loaded-page-2")).toEqual({
      id: "loaded-page-2",
      result: {
        data: ["active-c"],
        nextCursor: null,
      },
    });
  });

  it("rejects invalid loaded-list cursors and limits before refreshing upstream", async () => {
    const coordinator = new BrokerCoordinator();
    const desktop = attach(coordinator);
    await initialize(desktop, "desktop", []);
    const before = desktop.upstream.sent.length;

    await desktop.pair.receiveDownstream(
      JSON.stringify({
        id: "loaded-invalid-limit",
        method: "thread/loaded/list",
        params: { limit: 0 },
      }),
    );
    await desktop.pair.receiveDownstream(
      JSON.stringify({
        id: "loaded-invalid-cursor",
        method: "thread/loaded/list",
        params: { cursor: "not-a-broker-cursor", limit: 10 },
      }),
    );

    expect(desktop.upstream.sent).toHaveLength(before);
    expect(
      messages(desktop.downstream).filter(
        (message) =>
          message.id === "loaded-invalid-limit" || message.id === "loaded-invalid-cursor",
      ),
    ).toEqual([
      {
        error: { code: -32_602, message: "Invalid loaded-thread pagination" },
        id: "loaded-invalid-limit",
      },
      {
        error: { code: -32_602, message: "Invalid loaded-thread pagination" },
        id: "loaded-invalid-cursor",
      },
    ]);
  });

  it("keeps an in-flight new thread visible until terminal state confirms it can leave", async () => {
    const coordinator = new BrokerCoordinator();
    const desktop = attach(coordinator);
    await initialize(desktop, "desktop", []);

    await desktop.pair.receiveDownstream(
      JSON.stringify({
        id: "new-thread",
        method: "thread/start",
        params: { cwd: "C:\\workspace" },
      }),
    );
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        id: "new-thread",
        result: { thread: { id: "new-active-thread" } },
      }),
    );
    await desktop.pair.receiveDownstream(
      JSON.stringify({
        id: "new-turn",
        method: "turn/start",
        params: { input: [], threadId: "new-active-thread" },
      }),
    );
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        id: "new-turn",
        result: { turn: { id: "new-active-turn" } },
      }),
    );

    const activeOffset = desktop.upstream.sent.length;
    const activeList = desktop.pair.receiveDownstream(
      JSON.stringify({
        id: "active-loaded-list",
        method: "thread/loaded/list",
        params: { limit: 100 },
      }),
    );
    await answerNextLoadedList(desktop, activeOffset, []);
    await activeList;
    expect(
      messages(desktop.downstream).find((message) => message.id === "active-loaded-list"),
    ).toEqual({
      id: "active-loaded-list",
      result: { data: ["new-active-thread"], nextCursor: null },
    });

    await desktop.pair.receiveUpstream(
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "new-active-thread",
          turn: { id: "new-active-turn" },
        },
      }),
    );
    const terminalOffset = desktop.upstream.sent.length;
    const terminalList = desktop.pair.receiveDownstream(
      JSON.stringify({
        id: "terminal-loaded-list",
        method: "thread/loaded/list",
        params: { limit: 100 },
      }),
    );
    await answerNextLoadedList(desktop, terminalOffset, []);
    await terminalList;
    expect(
      messages(desktop.downstream).find((message) => message.id === "terminal-loaded-list"),
    ).toEqual({
      id: "terminal-loaded-list",
      result: { data: [], nextCursor: null },
    });
  });
});
