import { describe, expect, it, vi } from "vitest";

import {
  BROKER_HIDDEN_ID_PREFIX,
  BrokerCoordinator,
  normalizeThreadTitle,
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

interface PairFixture {
  downstream: RecordingWire;
  pair: BrokerPair;
  upstream: RecordingWire;
}

const TEST_DESKTOP_LAUNCH_NONCE_DIGEST = "c".repeat(64);

describe("normalizeThreadTitle", () => {
  it("turns Markdown and percent-encoded URL fragments into readable titles", () => {
    expect(normalizeThreadTitle("https://**steamcommunity.com**/market")).toBe(
      "https://steamcommunity.com/market",
    );
    expect(normalizeThreadTitle("%2A%2Asteamcommunity.com%2A%2A")).toBe("steamcommunity.com");
  });

  it("keeps malformed percent input safe and readable", () => {
    expect(normalizeThreadTitle("检查 100% 完成与 %2G")).toBe("检查 100% 完成与 %2G");
  });
});

function attach(
  coordinator: BrokerCoordinator,
  desktopLaunchNonceDigest: string | null = TEST_DESKTOP_LAUNCH_NONCE_DIGEST,
): PairFixture {
  const downstream = new RecordingWire();
  const upstream = new RecordingWire();
  const options: Parameters<BrokerCoordinator["attach"]>[0] & {
    desktopLaunchNonceDigest?: string;
  } = {
    downstream,
    upstream,
    ...(desktopLaunchNonceDigest === null ? {} : { desktopLaunchNonceDigest }),
  };
  return {
    downstream,
    pair: coordinator.attach(options),
    upstream,
  };
}

async function initialize(fixture: PairFixture, role: "desktop" | "sidecar"): Promise<void> {
  await initializeWithClientInfo(
    fixture,
    role,
    role === "sidecar"
      ? { name: "codex-local-remote", version: "fixture" }
      : {
          name: "codex-desktop-internal",
          title: "Codex Desktop",
          version: "fixture",
        },
  );
}

async function initializeWithClientInfo(
  fixture: PairFixture,
  label: string,
  clientInfo: Record<string, unknown>,
): Promise<void> {
  const initializeId = `${label}-initialize`;
  await fixture.pair.receiveDownstream(
    JSON.stringify({
      id: initializeId,
      method: "initialize",
      params: {
        clientInfo,
      },
    }),
  );
  await fixture.pair.receiveUpstream(
    JSON.stringify({
      id: initializeId,
      result: {
        codexHome: "C:\\fixture",
        platformFamily: "windows",
        platformOs: "windows",
        userAgent: "codex-cli/fixture",
      },
    }),
  );
  await fixture.pair.receiveDownstream(JSON.stringify({ method: "initialized" }));

  const loaded = await nextHiddenRequest(fixture, "thread/loaded/list");
  await fixture.pair.receiveUpstream(
    JSON.stringify({
      id: loaded.id,
      result: { data: [], nextCursor: null },
    }),
  );
}

async function initializeWithLoadedThreads(
  fixture: PairFixture,
  role: "desktop" | "sidecar",
  threadIds: string[],
): Promise<void> {
  const initializeId = `${role}-initialize-loaded`;
  await fixture.pair.receiveDownstream(
    JSON.stringify({
      id: initializeId,
      method: "initialize",
      params: {
        clientInfo:
          role === "sidecar"
            ? { name: "codex-local-remote", version: "fixture" }
            : {
                name: "codex-desktop-internal",
                title: "Codex Desktop",
                version: "fixture",
              },
      },
    }),
  );
  await fixture.pair.receiveUpstream(
    JSON.stringify({
      id: initializeId,
      result: { userAgent: "codex-cli/fixture" },
    }),
  );
  await fixture.pair.receiveDownstream(JSON.stringify({ method: "initialized" }));
  const loaded = await nextHiddenRequest(fixture, "thread/loaded/list");
  await fixture.pair.receiveUpstream(
    JSON.stringify({
      id: loaded.id,
      result: { data: threadIds, nextCursor: null },
    }),
  );
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function nextHiddenRequest(
  fixture: PairFixture,
  method: string,
  after = 0,
): Promise<Record<string, unknown> & { id: string }> {
  let result: (Record<string, unknown> & { id: string }) | undefined;
  await vi.waitFor(() => {
    const messages = fixture.upstream.sent
      .slice(after)
      .map(parseRecord)
      .filter(
        (message): message is Record<string, unknown> & { id: string } =>
          message.method === method &&
          typeof message.id === "string" &&
          message.id.startsWith(BROKER_HIDDEN_ID_PREFIX),
      );
    result = messages[0];
    expect(result).toBeDefined();
  });
  if (!result) {
    throw new Error(`missing hidden ${method}`);
  }
  return result;
}

function parseRecord(frame: string): Record<string, unknown> {
  return JSON.parse(frame) as Record<string, unknown>;
}

function methodFrames(fixture: PairFixture, method: string): Record<string, unknown>[] {
  return fixture.upstream.sent.map(parseRecord).filter((message) => message.method === method);
}

function asTestThreadId(message: Record<string, unknown>): string {
  const params = message.params as Record<string, unknown> | undefined;
  if (typeof params?.threadId !== "string") {
    throw new Error("fixture request has no threadId");
  }
  return params.threadId;
}

async function resumeHistoryThread(
  source: PairFixture,
  peer: PairFixture,
  thread: Record<string, unknown>,
): Promise<void> {
  const threadId = String(thread.id);
  const sourceBefore = source.upstream.sent.length;
  const peerBefore = peer.upstream.sent.length;
  const resumed = source.pair.receiveDownstream(
    JSON.stringify({
      id: `resume-${threadId}`,
      method: "thread/resume",
      params: { excludeTurns: true, threadId },
    }),
  );
  const sourceResume = await nextHiddenRequest(source, "thread/resume", sourceBefore);
  await source.pair.receiveUpstream(
    JSON.stringify({
      id: sourceResume.id,
      result: { thread },
    }),
  );
  const peerResume = await nextHiddenRequest(peer, "thread/resume", peerBefore);
  await peer.pair.receiveUpstream(
    JSON.stringify({
      id: peerResume.id,
      result: { thread },
    }),
  );
  await resumed;
}

describe("BrokerCoordinator subscription barrier", () => {
  it.each([
    { creator: "sidecar" as const, observer: "desktop" as const },
    { creator: "desktop" as const, observer: "sidecar" as const },
  ])(
    "holds the first $creator turn until the $observer resume is acknowledged",
    async ({ creator, observer }) => {
      const coordinator = new BrokerCoordinator();
      const desktop = attach(coordinator);
      const sidecar = attach(coordinator);
      await initialize(desktop, "desktop");
      await initialize(sidecar, "sidecar");
      const source = creator === "desktop" ? desktop : sidecar;
      const target = observer === "desktop" ? desktop : sidecar;

      await source.pair.receiveDownstream(
        JSON.stringify({
          id: `${creator}-thread-start`,
          method: "thread/start",
          params: { cwd: "C:\\workspace" },
        }),
      );
      await source.pair.receiveUpstream(
        JSON.stringify({
          id: `${creator}-thread-start`,
          result: { thread: { id: `thread-${creator}` } },
        }),
      );

      const resume = await nextHiddenRequest(target, "thread/resume");
      expect(resume.params).toEqual({
        excludeTurns: true,
        threadId: `thread-${creator}`,
      });

      const turn = source.pair.receiveDownstream(
        JSON.stringify({
          id: `${creator}-turn-start`,
          method: "turn/start",
          params: { input: [], threadId: `thread-${creator}` },
        }),
      );
      await Promise.resolve();
      expect(methodFrames(source, "turn/start")).toHaveLength(0);

      await target.pair.receiveUpstream(JSON.stringify({ id: resume.id, result: { thread: {} } }));
      await turn;

      expect(methodFrames(source, "turn/start")).toHaveLength(1);
      expect(target.downstream.sent.some((frame) => frame.includes(BROKER_HIDDEN_ID_PREFIX))).toBe(
        false,
      );
    },
  );

  it("retries the no-rollout persistence race before releasing the first turn", async () => {
    const coordinator = new BrokerCoordinator({
      resumeRetryDelaysMs: [0, 0],
      sleep: async () => undefined,
    });
    const desktop = attach(coordinator);
    const sidecar = attach(coordinator);
    await initialize(desktop, "desktop");
    await initialize(sidecar, "sidecar");

    await sidecar.pair.receiveDownstream(
      JSON.stringify({
        id: "thread-start",
        method: "thread/start",
        params: { cwd: "C:\\workspace" },
      }),
    );
    await sidecar.pair.receiveUpstream(
      JSON.stringify({
        id: "thread-start",
        result: { thread: { id: "thread-race" } },
      }),
    );
    const firstResume = await nextHiddenRequest(desktop, "thread/resume");
    const heldTurn = sidecar.pair.receiveDownstream(
      JSON.stringify({
        id: "turn-start",
        method: "turn/start",
        params: { input: [], threadId: "thread-race" },
      }),
    );

    const beforeRetry = desktop.upstream.sent.length;
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        id: firstResume.id,
        error: { code: -32_000, message: "no rollout found for thread thread-race" },
      }),
    );
    const secondResume = await nextHiddenRequest(desktop, "thread/resume", beforeRetry);
    await desktop.pair.receiveUpstream(
      JSON.stringify({ id: secondResume.id, result: { thread: {} } }),
    );
    await heldTurn;

    expect(methodFrames(sidecar, "turn/start")).toHaveLength(1);
    expect(methodFrames(desktop, "thread/resume")).toHaveLength(2);
  });

  it("persists a fresh empty thread with a derived name after resume exhausts no-rollout retries", async () => {
    const coordinator = new BrokerCoordinator({
      resumeRetryDelaysMs: [],
    });
    const desktop = attach(coordinator);
    const sidecar = attach(coordinator);
    await initialize(desktop, "desktop");
    await initialize(sidecar, "sidecar");

    await sidecar.pair.receiveDownstream(
      JSON.stringify({
        id: "thread-start",
        method: "thread/start",
        params: { cwd: "C:\\workspace" },
      }),
    );
    await sidecar.pair.receiveUpstream(
      JSON.stringify({
        id: "thread-start",
        result: { thread: { id: "thread-empty-shell" } },
      }),
    );
    const firstResume = await nextHiddenRequest(desktop, "thread/resume");
    const heldTurn = sidecar.pair.receiveDownstream(
      JSON.stringify({
        id: "turn-start",
        method: "turn/start",
        params: {
          input: [
            {
              text: `  修复首轮\n\t实时可见性 ${"界".repeat(100)}  `,
              type: "text",
            },
          ],
          threadId: "thread-empty-shell",
        },
      }),
    );

    await desktop.pair.receiveUpstream(
      JSON.stringify({
        id: firstResume.id,
        error: { code: -32_000, message: "no rollout found for thread thread-empty-shell" },
      }),
    );
    const persist = await nextHiddenRequest(sidecar, "thread/name/set");
    expect(persist.params).toEqual({
      name: `修复首轮 实时可见性 ${"界".repeat(68)}…`,
      threadId: "thread-empty-shell",
    });
    expect(methodFrames(sidecar, "turn/start")).toHaveLength(0);

    const beforeSecondResume = desktop.upstream.sent.length;
    await sidecar.pair.receiveUpstream(JSON.stringify({ id: persist.id, result: {} }));
    const secondResume = await nextHiddenRequest(desktop, "thread/resume", beforeSecondResume);
    expect(secondResume.id).not.toBe(firstResume.id);
    expect(methodFrames(sidecar, "turn/start")).toHaveLength(0);

    await desktop.pair.receiveUpstream(
      JSON.stringify({ id: secondResume.id, result: { thread: {} } }),
    );
    await heldTurn;

    expect(methodFrames(sidecar, "turn/start")).toHaveLength(1);
    expect(sidecar.downstream.sent.some((frame) => frame.includes(BROKER_HIDDEN_ID_PREFIX))).toBe(
      false,
    );
    expect(desktop.downstream.sent.some((frame) => frame.includes(BROKER_HIDDEN_ID_PREFIX))).toBe(
      false,
    );
  });

  it("does not overwrite an explicit name while retrying a fresh empty thread subscription", async () => {
    const coordinator = new BrokerCoordinator({
      resumeRetryDelaysMs: [],
    });
    const desktop = attach(coordinator);
    const sidecar = attach(coordinator);
    await initialize(desktop, "desktop");
    await initialize(sidecar, "sidecar");

    await sidecar.pair.receiveDownstream(
      JSON.stringify({
        id: "thread-start",
        method: "thread/start",
        params: { cwd: "C:\\workspace" },
      }),
    );
    await sidecar.pair.receiveUpstream(
      JSON.stringify({
        id: "thread-start",
        result: { thread: { id: "thread-explicit-name" } },
      }),
    );
    const firstResume = await nextHiddenRequest(desktop, "thread/resume");
    await sidecar.pair.receiveDownstream(
      JSON.stringify({
        id: "explicit-name",
        method: "thread/name/set",
        params: {
          name: "用户指定名称",
          threadId: "thread-explicit-name",
        },
      }),
    );
    await sidecar.pair.receiveUpstream(JSON.stringify({ id: "explicit-name", result: {} }));
    const heldTurn = sidecar.pair.receiveDownstream(
      JSON.stringify({
        id: "turn-start",
        method: "turn/start",
        params: {
          input: [{ text: "不应覆盖这个标题", type: "text" }],
          threadId: "thread-explicit-name",
        },
      }),
    );

    const beforeSecondResume = desktop.upstream.sent.length;
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        id: firstResume.id,
        error: { code: -32_000, message: "no rollout found for thread thread-explicit-name" },
      }),
    );
    const secondResume = await nextHiddenRequest(desktop, "thread/resume", beforeSecondResume);
    expect(methodFrames(sidecar, "thread/name/set")).toEqual([
      {
        id: "explicit-name",
        method: "thread/name/set",
        params: {
          name: "用户指定名称",
          threadId: "thread-explicit-name",
        },
      },
    ]);

    await desktop.pair.receiveUpstream(
      JSON.stringify({ id: secondResume.id, result: { thread: {} } }),
    );
    await heldTurn;
    expect(methodFrames(sidecar, "turn/start")).toHaveLength(1);
  });

  it("never blocks a Desktop first turn when the sidecar cannot resume the empty shell", async () => {
    const coordinator = new BrokerCoordinator({
      resumeRetryDelaysMs: [],
    });
    const desktop = attach(coordinator);
    const sidecar = attach(coordinator);
    await initialize(desktop, "desktop");
    await initialize(sidecar, "sidecar");

    await desktop.pair.receiveDownstream(
      JSON.stringify({
        id: "desktop-thread-start",
        method: "thread/start",
        params: { cwd: "C:\\workspace" },
      }),
    );
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        id: "desktop-thread-start",
        result: { thread: { id: "desktop-empty-shell" } },
      }),
    );

    const firstResume = await nextHiddenRequest(sidecar, "thread/resume");
    const desktopTurn = desktop.pair.receiveDownstream(
      JSON.stringify({
        id: "desktop-turn-start",
        method: "turn/start",
        params: {
          input: [{ text: "Desktop 首轮必须优先运行", type: "text" }],
          threadId: "desktop-empty-shell",
        },
      }),
    );

    await sidecar.pair.receiveUpstream(
      JSON.stringify({
        id: firstResume.id,
        error: { code: -32_000, message: "no rollout found for thread desktop-empty-shell" },
      }),
    );
    const persist = await nextHiddenRequest(desktop, "thread/name/set");
    const beforeSecondResume = sidecar.upstream.sent.length;
    await desktop.pair.receiveUpstream(JSON.stringify({ id: persist.id, result: {} }));
    const secondResume = await nextHiddenRequest(sidecar, "thread/resume", beforeSecondResume);
    await sidecar.pair.receiveUpstream(
      JSON.stringify({
        id: secondResume.id,
        error: { code: -32_000, message: "no rollout found for thread desktop-empty-shell" },
      }),
    );
    await desktopTurn;

    expect(methodFrames(desktop, "turn/start")).toHaveLength(1);
    expect(
      desktop.downstream.sent
        .map(parseRecord)
        .find((message) => message.id === "desktop-turn-start"),
    ).toBeUndefined();

    const beforeCatchUp = sidecar.upstream.sent.length;
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        method: "turn/started",
        params: {
          threadId: "desktop-empty-shell",
          turn: { id: "desktop-first-turn" },
        },
      }),
    );
    const catchUp = await nextHiddenRequest(sidecar, "thread/resume", beforeCatchUp);
    expect(catchUp.params).toEqual({
      excludeTurns: true,
      threadId: "desktop-empty-shell",
    });
  });

  it("uses a global thread/started notification to subscribe the other peer before the response", async () => {
    const coordinator = new BrokerCoordinator();
    const desktop = attach(coordinator);
    const sidecar = attach(coordinator);
    await initialize(desktop, "desktop");
    await initialize(sidecar, "sidecar");

    await sidecar.pair.receiveDownstream(
      JSON.stringify({
        id: "thread-start-pending",
        method: "thread/start",
        params: { cwd: "C:\\workspace" },
      }),
    );
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        method: "thread/started",
        params: { thread: { id: "thread-notified-first" } },
      }),
    );

    const resume = await nextHiddenRequest(desktop, "thread/resume");
    expect(resume.params).toEqual({
      excludeTurns: true,
      threadId: "thread-notified-first",
    });
  });

  it("fails sidecar thread creation closed when no initialized desktop is present", async () => {
    const coordinator = new BrokerCoordinator();
    const sidecar = attach(coordinator);
    await initialize(sidecar, "sidecar");
    sidecar.downstream.sent.length = 0;
    sidecar.upstream.sent.length = 0;

    await sidecar.pair.receiveDownstream(
      JSON.stringify({
        id: "thread-start",
        method: "thread/start",
        params: { cwd: "C:\\workspace" },
      }),
    );

    expect(methodFrames(sidecar, "thread/start")).toHaveLength(0);
    expect(sidecar.downstream.sent.map(parseRecord)).toEqual([
      {
        error: {
          code: -32_091,
          message: "Codex Desktop is not connected",
        },
        id: "thread-start",
      },
    ]);
  });

  it("opens a sidecar-resumed history thread in Desktop before acknowledging the resume", async () => {
    const coordinator = new BrokerCoordinator();
    const desktop = attach(coordinator);
    const sidecar = attach(coordinator);
    await initialize(desktop, "desktop");
    await initialize(sidecar, "sidecar");
    desktop.downstream.sent.length = 0;
    sidecar.downstream.sent.length = 0;
    const sidecarBeforeResume = sidecar.upstream.sent.length;
    const desktopBeforeResume = desktop.upstream.sent.length;

    const resumed = sidecar.pair.receiveDownstream(
      JSON.stringify({
        id: "resume-history",
        method: "thread/resume",
        params: { excludeTurns: true, threadId: "thread-history" },
      }),
    );

    const sourceResume = await nextHiddenRequest(sidecar, "thread/resume", sidecarBeforeResume);
    expect(sourceResume.params).toEqual({
      excludeTurns: true,
      threadId: "thread-history",
    });
    await sidecar.pair.receiveUpstream(
      JSON.stringify({
        id: sourceResume.id,
        result: { thread: { id: "thread-history", status: { type: "idle" } } },
      }),
    );

    const desktopResume = await nextHiddenRequest(desktop, "thread/resume", desktopBeforeResume);
    expect(sidecar.downstream.sent).toEqual([]);
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        id: desktopResume.id,
        result: { thread: { id: "thread-history", status: { type: "idle" } } },
      }),
    );
    await resumed;

    expect(sidecar.downstream.sent.map(parseRecord)).toEqual([
      {
        id: "resume-history",
        result: { thread: { id: "thread-history", status: { type: "idle" } } },
      },
    ]);
    expect(desktop.downstream.sent.some((frame) => frame.includes(BROKER_HIDDEN_ID_PREFIX))).toBe(
      false,
    );
    expect(sidecar.downstream.sent.some((frame) => frame.includes(BROKER_HIDDEN_ID_PREFIX))).toBe(
      false,
    );
  });

  it("fails a sidecar history resume closed when Desktop is absent", async () => {
    const coordinator = new BrokerCoordinator();
    const sidecar = attach(coordinator);
    await initialize(sidecar, "sidecar");
    sidecar.downstream.sent.length = 0;
    sidecar.upstream.sent.length = 0;

    await sidecar.pair.receiveDownstream(
      JSON.stringify({
        id: "resume-without-desktop",
        method: "thread/resume",
        params: { excludeTurns: true, threadId: "thread-history" },
      }),
    );

    expect(methodFrames(sidecar, "thread/resume")).toEqual([]);
    expect(sidecar.downstream.sent.map(parseRecord)).toEqual([
      {
        error: {
          code: -32_091,
          message: "Codex Desktop is not connected",
        },
        id: "resume-without-desktop",
      },
    ]);
  });

  it("does not claim a history resume when Desktop cannot subscribe", async () => {
    const coordinator = new BrokerCoordinator({ resumeRetryDelaysMs: [] });
    const desktop = attach(coordinator);
    const sidecar = attach(coordinator);
    await initialize(desktop, "desktop");
    await initialize(sidecar, "sidecar");
    desktop.downstream.sent.length = 0;
    sidecar.downstream.sent.length = 0;
    const sidecarBeforeResume = sidecar.upstream.sent.length;
    const desktopBeforeResume = desktop.upstream.sent.length;

    const resumed = sidecar.pair.receiveDownstream(
      JSON.stringify({
        id: "resume-barrier-failure",
        method: "thread/resume",
        params: { excludeTurns: true, threadId: "thread-history" },
      }),
    );
    const sourceResume = await nextHiddenRequest(sidecar, "thread/resume", sidecarBeforeResume);
    await sidecar.pair.receiveUpstream(
      JSON.stringify({
        id: sourceResume.id,
        result: { thread: { id: "thread-history", status: { type: "idle" } } },
      }),
    );
    const desktopResume = await nextHiddenRequest(desktop, "thread/resume", desktopBeforeResume);
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        error: { code: -32_000, message: "fixture resume failure" },
        id: desktopResume.id,
      }),
    );
    await resumed;

    expect(sidecar.downstream.sent.map(parseRecord)).toEqual([
      {
        error: {
          code: -32_092,
          message: "Thread subscription barrier failed",
        },
        id: "resume-barrier-failure",
      },
    ]);
  });

  it("allows a desktop-created thread and first turn when no sidecar is connected", async () => {
    const coordinator = new BrokerCoordinator();
    const desktop = attach(coordinator);
    await initialize(desktop, "desktop");
    desktop.upstream.sent.length = 0;

    await desktop.pair.receiveDownstream(
      JSON.stringify({
        id: "desktop-thread",
        method: "thread/start",
        params: { cwd: "C:\\workspace" },
      }),
    );
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        id: "desktop-thread",
        result: { thread: { id: "desktop-only-thread" } },
      }),
    );
    await desktop.pair.receiveDownstream(
      JSON.stringify({
        id: "desktop-turn",
        method: "turn/start",
        params: { input: [], threadId: "desktop-only-thread" },
      }),
    );

    expect(methodFrames(desktop, "thread/start")).toHaveLength(1);
    expect(methodFrames(desktop, "turn/start")).toHaveLength(1);
  });

  it("atomically blocks a Desktop turn while Sidecar archive is pending and releases after failure", async () => {
    const coordinator = new BrokerCoordinator();
    const desktop = attach(coordinator);
    const sidecar = attach(coordinator);
    await initialize(desktop, "desktop");
    await initialize(sidecar, "sidecar");
    await resumeHistoryThread(sidecar, desktop, {
      id: "thread-archive-race",
      parentThreadId: null,
      status: { type: "idle" },
    });
    const archiveBefore = sidecar.upstream.sent.length;
    const archive = sidecar.pair.receiveDownstream(
      JSON.stringify({
        id: "archive-race",
        method: "thread/archive",
        params: { threadId: "thread-archive-race" },
      }),
    );
    const archiveInspect = await nextHiddenRequest(sidecar, "thread/read", archiveBefore);
    await sidecar.pair.receiveUpstream(
      JSON.stringify({
        id: archiveInspect.id,
        result: {
          thread: {
            id: "thread-archive-race",
            parentThreadId: null,
            status: { type: "idle" },
          },
        },
      }),
    );
    await archive;
    expect(methodFrames(sidecar, "thread/archive")).toHaveLength(1);

    await desktop.pair.receiveDownstream(
      JSON.stringify({
        id: "desktop-turn-during-archive",
        method: "turn/start",
        params: { input: [], threadId: "thread-archive-race" },
      }),
    );
    expect(methodFrames(desktop, "turn/start")).toHaveLength(0);
    expect(desktop.downstream.sent.map(parseRecord)).toContainEqual({
      error: { code: -32_094, message: "Thread is being archived" },
      id: "desktop-turn-during-archive",
    });

    await sidecar.pair.receiveUpstream(
      JSON.stringify({
        error: { code: -32_000, message: "fixture archive failed" },
        id: "archive-race",
      }),
    );
    await desktop.pair.receiveDownstream(
      JSON.stringify({
        id: "desktop-turn-after-archive-failure",
        method: "turn/start",
        params: { input: [], threadId: "thread-archive-race" },
      }),
    );
    expect(methodFrames(desktop, "turn/start")).toHaveLength(1);
  });

  it("blocks archive when a turn start has already been reserved", async () => {
    const coordinator = new BrokerCoordinator();
    const desktop = attach(coordinator);
    const sidecar = attach(coordinator);
    await initialize(desktop, "desktop");
    await initialize(sidecar, "sidecar");
    await resumeHistoryThread(sidecar, desktop, {
      id: "thread-turn-first",
      parentThreadId: null,
      status: { type: "idle" },
    });

    await desktop.pair.receiveDownstream(
      JSON.stringify({
        id: "desktop-turn-first",
        method: "turn/start",
        params: { input: [], threadId: "thread-turn-first" },
      }),
    );
    expect(methodFrames(desktop, "turn/start")).toHaveLength(1);

    await sidecar.pair.receiveDownstream(
      JSON.stringify({
        id: "archive-after-turn-reserved",
        method: "thread/archive",
        params: { threadId: "thread-turn-first" },
      }),
    );
    expect(methodFrames(sidecar, "thread/archive")).toHaveLength(0);
    expect(sidecar.downstream.sent.map(parseRecord)).toContainEqual({
      error: { code: -32_094, message: "Thread has a pending turn" },
      id: "archive-after-turn-reserved",
    });
  });

  it("rejects archive after an authoritative inspection finds an active child", async () => {
    const coordinator = new BrokerCoordinator();
    const desktop = attach(coordinator);
    const sidecar = attach(coordinator);
    await initialize(desktop, "desktop");
    await initialize(sidecar, "sidecar");
    coordinator.observeThreadSnapshot("thread-root-active-child", {
      thread: {
        id: "thread-root-active-child",
        parentThreadId: null,
        status: { type: "idle" },
      },
    });
    coordinator.observeThreadSnapshot("thread-active-child", {
      thread: {
        id: "thread-active-child",
        parentThreadId: "thread-root-active-child",
        status: { type: "active" },
      },
    });
    const beforeArchive = sidecar.upstream.sent.length;
    const archive = sidecar.pair.receiveDownstream(
      JSON.stringify({
        id: "archive-active-child",
        method: "thread/archive",
        params: { threadId: "thread-root-active-child" },
      }),
    );
    const rootInspect = await nextHiddenRequest(sidecar, "thread/read", beforeArchive);
    const afterRootInspect = sidecar.upstream.sent.length;
    await sidecar.pair.receiveUpstream(
      JSON.stringify({
        id: rootInspect.id,
        result: {
          thread: {
            id: "thread-root-active-child",
            parentThreadId: null,
            status: { type: "idle" },
          },
        },
      }),
    );
    const childInspect = await nextHiddenRequest(sidecar, "thread/read", afterRootInspect);
    expect(childInspect.params).toEqual({
      includeTurns: false,
      threadId: "thread-active-child",
    });
    await sidecar.pair.receiveUpstream(
      JSON.stringify({
        id: childInspect.id,
        result: {
          thread: {
            id: "thread-active-child",
            parentThreadId: "thread-root-active-child",
            status: { type: "active" },
          },
        },
      }),
    );
    await archive;

    expect(methodFrames(sidecar, "thread/archive")).toHaveLength(0);
    expect(sidecar.downstream.sent.map(parseRecord)).toContainEqual({
      error: { code: -32_094, message: "Thread already has an active turn" },
      id: "archive-active-child",
    });
  });

  it("hydrates unknown loaded lineage after Broker restart and rejects an active child", async () => {
    const coordinator = new BrokerCoordinator();
    const desktop = attach(coordinator);
    const sidecar = attach(coordinator);
    await initializeWithLoadedThreads(desktop, "desktop", ["restart-root", "restart-active-child"]);
    await initializeWithLoadedThreads(sidecar, "sidecar", ["restart-root", "restart-active-child"]);
    const beforeArchive = sidecar.upstream.sent.length;
    const archive = sidecar.pair.receiveDownstream(
      JSON.stringify({
        id: "archive-after-restart",
        method: "thread/archive",
        params: { threadId: "restart-root" },
      }),
    );

    let restartReads: Array<Record<string, unknown> & { id: string }> = [];
    await vi.waitFor(() => {
      restartReads = sidecar.upstream.sent
        .slice(beforeArchive)
        .map(parseRecord)
        .filter(
          (message): message is Record<string, unknown> & { id: string } =>
            message.method === "thread/read" && typeof message.id === "string",
        );
      expect(restartReads).toHaveLength(2);
    });
    for (const read of restartReads) {
      const readThreadId = asTestThreadId(read);
      await sidecar.pair.receiveUpstream(
        JSON.stringify({
          id: read.id,
          result: {
            thread:
              readThreadId === "restart-active-child"
                ? {
                    id: readThreadId,
                    parentThreadId: "restart-root",
                    status: { type: "active" },
                  }
                : {
                    id: readThreadId,
                    parentThreadId: null,
                    status: { type: "idle" },
                  },
          },
        }),
      );
    }
    await archive;

    expect(new Set(restartReads.map(asTestThreadId))).toEqual(
      new Set(["restart-root", "restart-active-child"]),
    );
    expect(methodFrames(sidecar, "thread/archive")).toHaveLength(0);
    expect(sidecar.downstream.sent.map(parseRecord)).toContainEqual({
      error: { code: -32_094, message: "Thread already has an active turn" },
      id: "archive-after-restart",
    });
  });

  it("rechecks the loaded generation when an unknown active child appears during archive inspection", async () => {
    const coordinator = new BrokerCoordinator();
    const desktop = attach(coordinator);
    const sidecar = attach(coordinator);
    await initializeWithLoadedThreads(desktop, "desktop", ["generation-root"]);
    await initializeWithLoadedThreads(sidecar, "sidecar", ["generation-root"]);
    const beforeArchive = sidecar.upstream.sent.length;
    const archive = sidecar.pair.receiveDownstream(
      JSON.stringify({
        id: "archive-generation-race",
        method: "thread/archive",
        params: { threadId: "generation-root" },
      }),
    );
    const rootRead = await nextHiddenRequest(sidecar, "thread/read", beforeArchive);

    await desktop.pair.receiveUpstream(
      JSON.stringify({
        method: "turn/started",
        params: {
          threadId: "generation-active-child",
          turn: { id: "generation-child-turn" },
        },
      }),
    );
    const afterRootRead = sidecar.upstream.sent.length;
    await sidecar.pair.receiveUpstream(
      JSON.stringify({
        id: rootRead.id,
        result: {
          thread: {
            id: "generation-root",
            parentThreadId: null,
            status: { type: "idle" },
          },
        },
      }),
    );
    const childRead = await nextHiddenRequest(sidecar, "thread/read", afterRootRead);
    expect(childRead.params).toEqual({
      includeTurns: false,
      threadId: "generation-active-child",
    });
    await sidecar.pair.receiveUpstream(
      JSON.stringify({
        id: childRead.id,
        result: {
          thread: {
            id: "generation-active-child",
            parentThreadId: "generation-root",
            status: { type: "active" },
          },
        },
      }),
    );
    await archive;

    expect(methodFrames(sidecar, "thread/archive")).toHaveLength(0);
    expect(sidecar.downstream.sent.map(parseRecord)).toContainEqual({
      error: { code: -32_094, message: "Thread already has an active turn" },
      id: "archive-generation-race",
    });
  });

  it("forgets archived loaded and subscription state even when upstream snapshots stay stale", async () => {
    const coordinator = new BrokerCoordinator();
    const desktop = attach(coordinator);
    const sidecar = attach(coordinator);
    await initialize(desktop, "desktop");
    await initialize(sidecar, "sidecar");
    await resumeHistoryThread(sidecar, desktop, {
      id: "forget-archived-root",
      parentThreadId: null,
      status: { type: "idle" },
    });
    const archiveBefore = sidecar.upstream.sent.length;
    const archive = sidecar.pair.receiveDownstream(
      JSON.stringify({
        id: "archive-forget-state",
        method: "thread/archive",
        params: { threadId: "forget-archived-root" },
      }),
    );
    const archiveInspect = await nextHiddenRequest(sidecar, "thread/read", archiveBefore);
    await sidecar.pair.receiveUpstream(
      JSON.stringify({
        id: archiveInspect.id,
        result: {
          thread: {
            id: "forget-archived-root",
            parentThreadId: null,
            status: { type: "idle" },
          },
        },
      }),
    );
    await archive;
    await sidecar.pair.receiveUpstream(JSON.stringify({ id: "archive-forget-state", result: {} }));

    const desktopBeforeList = desktop.upstream.sent.length;
    const sidecarBeforeList = sidecar.upstream.sent.length;
    const loadedUnion = coordinator.listLoadedUnion();
    const desktopList = await nextHiddenRequest(desktop, "thread/loaded/list", desktopBeforeList);
    const sidecarList = await nextHiddenRequest(sidecar, "thread/loaded/list", sidecarBeforeList);
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        id: desktopList.id,
        result: { data: ["forget-archived-root"], nextCursor: null },
      }),
    );
    await sidecar.pair.receiveUpstream(
      JSON.stringify({
        id: sidecarList.id,
        result: { data: ["forget-archived-root"], nextCursor: null },
      }),
    );

    await expect(loadedUnion).resolves.toEqual([]);
    expect(coordinator.unsafeThreadCount()).toBe(0);
  });

  it("unarchives only the notified rollout and keeps archived descendants blocked", () => {
    const coordinator = new BrokerCoordinator();
    coordinator.observeThreadSnapshot("unarchive-root", {
      thread: {
        id: "unarchive-root",
        parentThreadId: null,
        status: { type: "idle" },
      },
    });
    coordinator.observeThreadSnapshot("unarchive-child", {
      thread: {
        id: "unarchive-child",
        parentThreadId: "unarchive-root",
        status: { type: "idle" },
      },
    });

    coordinator.observeThreadArchived("unarchive-root");
    coordinator.observeThreadUnarchived("unarchive-root");

    expect(() => coordinator.assertTurnStartAllowed("unarchive-root")).not.toThrow();
    expect(() => coordinator.assertTurnStartAllowed("unarchive-child")).toThrow(
      "Thread is archived",
    );

    coordinator.observeThreadUnarchived("unarchive-child");
    expect(() => coordinator.assertTurnStartAllowed("unarchive-child")).not.toThrow();
  });

  it("keeps archive protocol-transparent for an empty shell with no rollout", async () => {
    const coordinator = new BrokerCoordinator();
    const desktop = attach(coordinator);
    const sidecar = attach(coordinator);
    await initialize(desktop, "desktop");
    await initialize(sidecar, "sidecar");
    const beforeArchive = sidecar.upstream.sent.length;
    const archive = sidecar.pair.receiveDownstream(
      JSON.stringify({
        id: "archive-empty-shell",
        method: "thread/archive",
        params: { threadId: "empty-shell" },
      }),
    );
    const inspect = await nextHiddenRequest(sidecar, "thread/read", beforeArchive);
    await sidecar.pair.receiveUpstream(
      JSON.stringify({
        error: { code: -32_000, message: "no rollout found for thread empty-shell" },
        id: inspect.id,
      }),
    );
    await archive;

    expect(methodFrames(sidecar, "thread/archive")).toEqual([
      {
        id: "archive-empty-shell",
        method: "thread/archive",
        params: { threadId: "empty-shell" },
      },
    ]);
    await sidecar.pair.receiveUpstream(
      JSON.stringify({
        error: { code: -32_123, message: "official archive error" },
        id: "archive-empty-shell",
      }),
    );
    expect(sidecar.downstream.sent.map(parseRecord)).toContainEqual({
      error: { code: -32_123, message: "official archive error" },
      id: "archive-empty-shell",
    });
  });

  it("extends a pending root archive lock to a child discovered by Desktop", async () => {
    const coordinator = new BrokerCoordinator();
    const desktop = attach(coordinator);
    const sidecar = attach(coordinator);
    await initialize(desktop, "desktop");
    await initialize(sidecar, "sidecar");
    await resumeHistoryThread(sidecar, desktop, {
      id: "thread-root-archive",
      parentThreadId: null,
      status: { type: "idle" },
    });
    const archiveBefore = sidecar.upstream.sent.length;
    const archive = sidecar.pair.receiveDownstream(
      JSON.stringify({
        id: "archive-root",
        method: "thread/archive",
        params: { threadId: "thread-root-archive" },
      }),
    );
    const archiveInspect = await nextHiddenRequest(sidecar, "thread/read", archiveBefore);
    await sidecar.pair.receiveUpstream(
      JSON.stringify({
        id: archiveInspect.id,
        result: {
          thread: {
            id: "thread-root-archive",
            parentThreadId: null,
            status: { type: "idle" },
          },
        },
      }),
    );
    await archive;

    await desktop.pair.receiveDownstream(
      JSON.stringify({
        id: "desktop-resume-late-child",
        method: "thread/resume",
        params: { excludeTurns: true, threadId: "thread-late-child" },
      }),
    );
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        id: "desktop-resume-late-child",
        result: {
          thread: {
            id: "thread-late-child",
            parentThreadId: "thread-root-archive",
            status: { type: "idle" },
          },
        },
      }),
    );
    await desktop.pair.receiveDownstream(
      JSON.stringify({
        id: "desktop-turn-late-child",
        method: "turn/start",
        params: { input: [], threadId: "thread-late-child" },
      }),
    );

    expect(methodFrames(desktop, "turn/start")).toHaveLength(0);
    expect(desktop.downstream.sent.map(parseRecord)).toContainEqual({
      error: { code: -32_094, message: "Thread is being archived" },
      id: "desktop-turn-late-child",
    });
  });

  it("accepts loaded subscriptions after a desktop reconnect without resuming its own threads", async () => {
    const coordinator = new BrokerCoordinator();
    const firstDesktop = attach(coordinator);
    await initialize(firstDesktop, "desktop");
    firstDesktop.pair.close();

    const reconnected = attach(coordinator);
    const initializeId = "desktop-reconnect";
    await reconnected.pair.receiveDownstream(
      JSON.stringify({
        id: initializeId,
        method: "initialize",
        params: {
          clientInfo: {
            name: "codex-desktop-internal",
            title: "Codex Desktop",
            version: "fixture",
          },
        },
      }),
    );
    await reconnected.pair.receiveUpstream(
      JSON.stringify({ id: initializeId, result: { userAgent: "fixture" } }),
    );
    await reconnected.pair.receiveDownstream(JSON.stringify({ method: "initialized" }));

    const loaded = await nextHiddenRequest(reconnected, "thread/loaded/list");
    await reconnected.pair.receiveUpstream(
      JSON.stringify({
        id: loaded.id,
        result: { data: ["thread-existing"], nextCursor: null },
      }),
    );

    await vi.waitFor(() => {
      expect(coordinator.snapshot()).toEqual({
        degraded: false,
        desktopConnected: true,
        desktopConnectionCount: 1,
        desktopLaunchNonceDigests: [TEST_DESKTOP_LAUNCH_NONCE_DIGEST],
        sidecarConnected: false,
        unknownCount: 0,
      });
    });
    expect(methodFrames(reconnected, "thread/resume")).toEqual([]);
    expect(
      reconnected.downstream.sent.some((frame) => frame.includes(BROKER_HIDDEN_ID_PREFIX)),
    ).toBe(false);
  });

  it("never resumes the same connection that delivered turn/started", async () => {
    const coordinator = new BrokerCoordinator();
    const desktop = attach(coordinator);
    const sidecar = attach(coordinator);
    await initialize(desktop, "desktop");
    await initialize(sidecar, "sidecar");
    const desktopOffset = desktop.upstream.sent.length;
    const sidecarOffset = sidecar.upstream.sent.length;

    await desktop.pair.receiveUpstream(
      JSON.stringify({
        method: "turn/started",
        params: {
          threadId: "thread-source-subscribed",
          turn: { id: "turn-source-subscribed" },
        },
      }),
    );

    const peerResume = await nextHiddenRequest(sidecar, "thread/resume", sidecarOffset);
    expect(peerResume.params).toEqual({
      excludeTurns: true,
      threadId: "thread-source-subscribed",
    });
    expect(
      desktop.upstream.sent
        .slice(desktopOffset)
        .map(parseRecord)
        .filter((message) => message.method === "thread/resume"),
    ).toEqual([]);
    coordinator.stop();
  });

  it("remembers a successful Desktop history resume before a peer starts the next turn", async () => {
    const coordinator = new BrokerCoordinator();
    const desktop = attach(coordinator);
    const sidecar = attach(coordinator);
    await initialize(desktop, "desktop");
    await initialize(sidecar, "sidecar");
    const desktopResumeOffset = desktop.upstream.sent.length;

    await desktop.pair.receiveDownstream(
      JSON.stringify({
        id: "desktop-history-resume",
        method: "thread/resume",
        params: { threadId: "thread-history-subscribed" },
      }),
    );
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        id: "desktop-history-resume",
        result: {
          thread: {
            id: "thread-history-subscribed",
            status: { type: "idle" },
          },
        },
      }),
    );
    const desktopAfterResume = desktop.upstream.sent.length;

    await sidecar.pair.receiveUpstream(
      JSON.stringify({
        method: "turn/started",
        params: {
          threadId: "thread-history-subscribed",
          turn: { id: "turn-from-peer" },
        },
      }),
    );

    expect(
      desktop.upstream.sent
        .slice(desktopAfterResume)
        .map(parseRecord)
        .filter((message) => message.method === "thread/resume"),
    ).toEqual([]);
    expect(
      desktop.upstream.sent
        .slice(desktopResumeOffset)
        .map(parseRecord)
        .filter(
          (message) =>
            message.method === "thread/resume" && message.id === "desktop-history-resume",
        ),
    ).toHaveLength(1);
    coordinator.stop();
  });

  it("does not let a delayed subscription snapshot resurrect a completed turn", async () => {
    const coordinator = new BrokerCoordinator();
    const desktop = attach(coordinator);
    const sidecar = attach(coordinator);
    await initialize(desktop, "desktop");
    await initialize(sidecar, "sidecar");
    const sidecarOffset = sidecar.upstream.sent.length;

    await desktop.pair.receiveUpstream(
      JSON.stringify({
        method: "turn/started",
        params: {
          threadId: "thread-delayed-snapshot",
          turn: { id: "turn-delayed-snapshot" },
        },
      }),
    );
    const delayedResume = await nextHiddenRequest(sidecar, "thread/resume", sidecarOffset);
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "thread-delayed-snapshot",
          turn: { id: "turn-delayed-snapshot" },
        },
      }),
    );
    expect(coordinator.unsafeThreadCount()).toBe(0);

    await sidecar.pair.receiveUpstream(
      JSON.stringify({
        id: delayedResume.id,
        result: {
          thread: {
            id: "thread-delayed-snapshot",
            status: { type: "active" },
          },
        },
      }),
    );
    const unsafeAfterDelayedResume = coordinator.unsafeThreadCount();
    coordinator.stop();

    expect(unsafeAfterDelayedResume).toBe(0);
  });

  it("revalidates stale unsafe lifecycle entries with an authoritative thread read", async () => {
    const coordinator = new BrokerCoordinator({ unsafeRevalidationMinIntervalMs: 0 });
    const desktop = attach(coordinator);
    await initialize(desktop, "desktop");
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        method: "turn/started",
        params: {
          threadId: "thread-stale-active",
          turn: { id: "turn-stale-active" },
        },
      }),
    );
    expect(coordinator.unsafeThreadCount()).toBe(1);

    const beforeRead = desktop.upstream.sent.length;
    const revalidation = coordinator.revalidateUnsafeThreads();
    const read = await nextHiddenRequest(desktop, "thread/read", beforeRead);
    expect((read.params as { threadId?: unknown } | undefined)?.threadId).toBe(
      "thread-stale-active",
    );
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        id: read.id,
        result: {
          thread: {
            id: "thread-stale-active",
            status: { type: "idle" },
          },
        },
      }),
    );
    await revalidation;

    expect(coordinator.unsafeThreadCount()).toBe(0);
    coordinator.stop();
  });

  it("does not let unsafe revalidation overwrite a newer active turn", async () => {
    const coordinator = new BrokerCoordinator({ unsafeRevalidationMinIntervalMs: 0 });
    const desktop = attach(coordinator);
    await initialize(desktop, "desktop");
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        method: "turn/started",
        params: {
          threadId: "thread-revalidation-race",
          turn: { id: "turn-before-read" },
        },
      }),
    );

    const beforeRead = desktop.upstream.sent.length;
    const revalidation = coordinator.revalidateUnsafeThreads();
    const read = await nextHiddenRequest(desktop, "thread/read", beforeRead);
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        method: "turn/started",
        params: {
          threadId: "thread-revalidation-race",
          turn: { id: "turn-after-read" },
        },
      }),
    );
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        id: read.id,
        result: {
          thread: {
            id: "thread-revalidation-race",
            status: { type: "idle" },
          },
        },
      }),
    );
    await revalidation;

    expect(coordinator.unsafeThreadCount()).toBe(1);
    coordinator.stop();
  });
});

describe("BrokerCoordinator client identity and readiness", () => {
  it("rejects non-SHA-256 launch identity metadata before creating a connection", () => {
    const coordinator = new BrokerCoordinator();

    expect(() => attach(coordinator, "not-a-digest")).toThrow("desktop launch nonce digest");
    expect(coordinator.snapshot()).toMatchObject({
      desktopConnectionCount: 0,
      desktopLaunchNonceDigests: [],
      unknownCount: 0,
    });
  });

  it("rejects a legacy Desktop without a launch nonce while allowing a nonce-free Sidecar", async () => {
    const coordinator = new BrokerCoordinator();
    const legacyDesktop = attach(coordinator, null);

    await legacyDesktop.pair.receiveDownstream(
      JSON.stringify({
        id: "legacy-desktop-initialize",
        method: "initialize",
        params: {
          clientInfo: {
            name: "codex-desktop-internal",
            title: "Codex Desktop",
            version: "fixture",
          },
        },
      }),
    );

    expect(legacyDesktop.upstream.sent).toEqual([]);
    expect(legacyDesktop.downstream.closes).toEqual([
      { code: 1008, reason: "Codex Desktop launch identity is required" },
    ]);
    expect(legacyDesktop.upstream.closes).toEqual([
      { code: 1008, reason: "Codex Desktop launch identity is required" },
    ]);
    expect(coordinator.snapshot()).toMatchObject({
      desktopConnected: false,
      desktopConnectionCount: 0,
      desktopLaunchNonceDigests: [],
      sidecarConnected: false,
      unknownCount: 0,
    });

    const sidecar = attach(coordinator, null);
    await initialize(sidecar, "sidecar");

    expect(coordinator.snapshot()).toMatchObject({
      desktopConnected: false,
      desktopConnectionCount: 0,
      desktopLaunchNonceDigests: [],
      sidecarConnected: true,
      unknownCount: 0,
    });
  });

  it("attributes only initialized Desktop connections and removes exact launch digests on close", async () => {
    const ownDigest = "a".repeat(64);
    const foreignDigest = "b".repeat(64);
    const coordinator = new BrokerCoordinator();
    const firstOwn = attach(coordinator, ownDigest);
    const secondOwn = attach(coordinator, ownDigest);
    const foreign = attach(coordinator, foreignDigest);
    const thirdOwn = attach(coordinator, ownDigest);
    const sidecar = attach(coordinator, foreignDigest);

    expect(coordinator.snapshot()).toMatchObject({
      desktopConnectionCount: 0,
      desktopLaunchNonceDigests: [],
      unknownCount: 5,
    });

    await initialize(firstOwn, "desktop");
    await initialize(secondOwn, "desktop");
    await initialize(foreign, "desktop");
    await initialize(thirdOwn, "desktop");
    await initialize(sidecar, "sidecar");

    expect(coordinator.snapshot()).toMatchObject({
      desktopConnected: true,
      desktopConnectionCount: 4,
      desktopLaunchNonceDigests: [ownDigest, ownDigest, ownDigest, foreignDigest],
      sidecarConnected: true,
      unknownCount: 0,
    });

    foreign.pair.close();
    expect(coordinator.snapshot()).toMatchObject({
      desktopConnectionCount: 3,
      desktopLaunchNonceDigests: [ownDigest, ownDigest, ownDigest],
    });

    thirdOwn.pair.close();
    firstOwn.pair.close();
    expect(coordinator.snapshot()).toMatchObject({
      desktopConnectionCount: 1,
      desktopLaunchNonceDigests: [ownDigest],
    });

    secondOwn.pair.close();
    expect(coordinator.snapshot()).toMatchObject({
      desktopConnected: false,
      desktopConnectionCount: 0,
      desktopLaunchNonceDigests: [],
    });
  });

  it("activates Codex Desktop after initialize succeeds without an initialized notification", async () => {
    const coordinator = new BrokerCoordinator();
    const desktop = attach(coordinator);

    await desktop.pair.receiveDownstream(
      JSON.stringify({
        id: "desktop-without-initialized-notification",
        method: "initialize",
        params: {
          clientInfo: {
            name: "codex-desktop-internal",
            title: "Codex Desktop",
            version: "fixture",
          },
        },
      }),
    );
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        id: "desktop-without-initialized-notification",
        result: { userAgent: "fixture" },
      }),
    );

    const loaded = await nextHiddenRequest(desktop, "thread/loaded/list");
    await desktop.pair.receiveUpstream(
      JSON.stringify({ id: loaded.id, result: { data: [], nextCursor: null } }),
    );

    await vi.waitFor(() => {
      expect(coordinator.snapshot()).toEqual({
        degraded: false,
        desktopConnected: true,
        desktopConnectionCount: 1,
        desktopLaunchNonceDigests: [TEST_DESKTOP_LAUNCH_NONCE_DIGEST],
        sidecarConnected: false,
        unknownCount: 0,
      });
    });
  });

  it("does not let an unknown client satisfy the sidecar desktop gate", async () => {
    const coordinator = new BrokerCoordinator();
    const unknown = attach(coordinator);
    await unknown.pair.receiveDownstream(
      JSON.stringify({
        id: "unknown-initialize",
        method: "initialize",
        params: {
          clientInfo: {
            name: "Codex Desktop",
            version: "fixture",
          },
        },
      }),
    );

    expect(unknown.upstream.sent).toEqual([]);
    expect(coordinator.snapshot()).toEqual({
      degraded: false,
      desktopConnected: false,
      desktopConnectionCount: 0,
      desktopLaunchNonceDigests: [],
      sidecarConnected: false,
      unknownCount: 0,
    });

    const sidecar = attach(coordinator);
    await initialize(sidecar, "sidecar");
    sidecar.downstream.sent.length = 0;
    sidecar.upstream.sent.length = 0;

    await sidecar.pair.receiveDownstream(
      JSON.stringify({
        id: "sidecar-thread-start",
        method: "thread/start",
        params: { cwd: "C:\\workspace" },
      }),
    );

    expect(methodFrames(sidecar, "thread/start")).toHaveLength(0);
    expect(sidecar.downstream.sent.map(parseRecord)).toEqual([
      {
        error: {
          code: -32_091,
          message: "Codex Desktop is not connected",
        },
        id: "sidecar-thread-start",
      },
    ]);
    expect(coordinator.snapshot()).toEqual({
      degraded: false,
      desktopConnected: false,
      desktopConnectionCount: 0,
      desktopLaunchNonceDigests: [],
      sidecarConnected: true,
      unknownCount: 0,
    });
  });

  it("closes an unknown client at initialize and suppresses all upstream traffic", async () => {
    const coordinator = new BrokerCoordinator();
    const conflicting = attach(coordinator);
    await conflicting.pair.receiveDownstream(
      JSON.stringify({
        id: "conflicting-initialize",
        method: "initialize",
        params: {
          clientInfo: {
            name: "codex-local-remote",
            title: "Codex Desktop",
            version: "fixture",
          },
        },
      }),
    );

    expect(conflicting.upstream.sent).toEqual([]);
    expect(conflicting.downstream.sent).toEqual([]);
    expect(coordinator.snapshot()).toEqual({
      degraded: false,
      desktopConnected: false,
      desktopConnectionCount: 0,
      desktopLaunchNonceDigests: [],
      sidecarConnected: false,
      unknownCount: 0,
    });
    expect(methodFrames(conflicting, "thread/loaded/list")).toHaveLength(0);
    expect(conflicting.downstream.closes).toEqual([
      { code: 1008, reason: "unrecognized client is not authorized" },
    ]);
    expect(conflicting.upstream.closes).toEqual([
      { code: 1008, reason: "unrecognized client is not authorized" },
    ]);

    conflicting.downstream.sent.length = 0;
    conflicting.upstream.sent.length = 0;
    const blockedMethods = [
      "thread/start",
      "turn/start",
      "thread/resume",
      "turn/steer",
      "turn/interrupt",
      "account/read",
      "initialize",
    ];
    for (const [index, method] of blockedMethods.entries()) {
      await conflicting.pair.receiveDownstream(
        JSON.stringify({
          id: `unknown-request-${index}`,
          method,
          params: {},
        }),
      );
    }

    await conflicting.pair.receiveUpstream(
      JSON.stringify({
        id: "conflicting-initialize",
        result: { userAgent: "must-not-leak" },
      }),
    );
    await conflicting.pair.receiveUpstream(
      JSON.stringify({
        method: "thread/started",
        params: { thread: { id: "must-not-leak" } },
      }),
    );
    await conflicting.pair.receiveUpstream(
      JSON.stringify({
        method: "turn/started",
        params: { threadId: "must-not-leak", turn: { id: "turn-secret" } },
      }),
    );

    expect(conflicting.upstream.sent).toEqual([]);
    expect(conflicting.downstream.sent).toEqual([]);
  });

  it("marks a failed loaded-thread backfill degraded and clears it after a later retry", async () => {
    const coordinator = new BrokerCoordinator({
      backfillRetryDelaysMs: [],
    });
    const desktop = attach(coordinator);
    const desktopInitialize = "desktop-initialize";
    await desktop.pair.receiveDownstream(
      JSON.stringify({
        id: desktopInitialize,
        method: "initialize",
        params: {
          clientInfo: {
            name: "codex-desktop-internal",
            title: "Codex Desktop",
            version: "fixture",
          },
        },
      }),
    );
    await desktop.pair.receiveUpstream(
      JSON.stringify({ id: desktopInitialize, result: { userAgent: "fixture" } }),
    );
    await desktop.pair.receiveDownstream(JSON.stringify({ method: "initialized" }));
    const failedBackfill = await nextHiddenRequest(desktop, "thread/loaded/list");
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        error: { code: -32_000, message: "fixture loaded-thread failure" },
        id: failedBackfill.id,
      }),
    );
    await vi.waitFor(() => {
      expect(coordinator.snapshot().degraded).toBe(true);
    });

    const beforeRetry = desktop.upstream.sent.length;
    const sidecar = attach(coordinator);
    await initialize(sidecar, "sidecar");
    const retriedBackfill = await nextHiddenRequest(desktop, "thread/loaded/list", beforeRetry);
    await desktop.pair.receiveUpstream(
      JSON.stringify({ id: retriedBackfill.id, result: { data: [], nextCursor: null } }),
    );

    await vi.waitFor(() => {
      expect(coordinator.snapshot()).toEqual({
        degraded: false,
        desktopConnected: true,
        desktopConnectionCount: 1,
        desktopLaunchNonceDigests: [TEST_DESKTOP_LAUNCH_NONCE_DIGEST],
        sidecarConnected: true,
        unknownCount: 0,
      });
    });
  });

  it("self-recovers a transient backfill failure with bounded retry", async () => {
    let releaseRetry: (() => void) | undefined;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const retrySleep = vi.fn(async () => await retryGate);
    const coordinator = new BrokerCoordinator({
      backfillRetryDelaysMs: [0],
      sleep: retrySleep,
    });
    const desktop = attach(coordinator);
    const initializeId = "desktop-self-retry";
    await desktop.pair.receiveDownstream(
      JSON.stringify({
        id: initializeId,
        method: "initialize",
        params: {
          clientInfo: {
            name: "codex-desktop-internal",
            title: "Codex Desktop",
            version: "fixture",
          },
        },
      }),
    );
    await desktop.pair.receiveUpstream(
      JSON.stringify({ id: initializeId, result: { userAgent: "fixture" } }),
    );
    await desktop.pair.receiveDownstream(JSON.stringify({ method: "initialized" }));
    const first = await nextHiddenRequest(desktop, "thread/loaded/list");
    const beforeRetry = desktop.upstream.sent.length;
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        error: { code: -32_000, message: "fixture transient failure" },
        id: first.id,
      }),
    );

    await vi.waitFor(() => {
      expect(retrySleep).toHaveBeenCalledOnce();
    });
    expect(coordinator.snapshot().degraded).toBe(false);
    releaseRetry?.();
    const retry = await nextHiddenRequest(desktop, "thread/loaded/list", beforeRetry);
    await desktop.pair.receiveUpstream(
      JSON.stringify({ id: retry.id, result: { data: [], nextCursor: null } }),
    );

    await vi.waitFor(() => {
      expect(coordinator.snapshot()).toEqual({
        degraded: false,
        desktopConnected: true,
        desktopConnectionCount: 1,
        desktopLaunchNonceDigests: [TEST_DESKTOP_LAUNCH_NONCE_DIGEST],
        sidecarConnected: false,
        unknownCount: 0,
      });
    });
  });

  it("fails closed when loaded-thread pagination repeats a cursor", async () => {
    const coordinator = new BrokerCoordinator({
      backfillRetryDelaysMs: [],
    });
    const desktop = attach(coordinator);
    const initializeId = "desktop-repeating-cursor";
    await desktop.pair.receiveDownstream(
      JSON.stringify({
        id: initializeId,
        method: "initialize",
        params: {
          clientInfo: {
            name: "codex-desktop-internal",
            title: "Codex Desktop",
          },
        },
      }),
    );
    await desktop.pair.receiveUpstream(
      JSON.stringify({ id: initializeId, result: { userAgent: "future-codex" } }),
    );
    await desktop.pair.receiveDownstream(JSON.stringify({ method: "initialized" }));

    const first = await nextHiddenRequest(desktop, "thread/loaded/list");
    const afterFirst = desktop.upstream.sent.length;
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        id: first.id,
        result: { data: ["thread-a"], nextCursor: "repeated" },
      }),
    );
    const second = await nextHiddenRequest(desktop, "thread/loaded/list", afterFirst);
    await desktop.pair.receiveUpstream(
      JSON.stringify({
        id: second.id,
        result: { data: ["thread-b"], nextCursor: "repeated" },
      }),
    );

    await vi.waitFor(() => {
      expect(coordinator.snapshot().degraded).toBe(true);
    });
    expect(methodFrames(desktop, "thread/loaded/list")).toHaveLength(2);
  });

  it("fails closed when loaded-thread pagination exceeds the bounded page count", async () => {
    const coordinator = new BrokerCoordinator({
      backfillRetryDelaysMs: [],
    });
    const desktop = attach(coordinator);
    const initializeId = "desktop-unbounded-cursors";
    await desktop.pair.receiveDownstream(
      JSON.stringify({
        id: initializeId,
        method: "initialize",
        params: {
          clientInfo: {
            name: "codex-desktop-internal",
            title: "Codex Desktop",
          },
        },
      }),
    );
    await desktop.pair.receiveUpstream(
      JSON.stringify({ id: initializeId, result: { userAgent: "future-codex" } }),
    );
    await desktop.pair.receiveDownstream(JSON.stringify({ method: "initialized" }));

    let after = 0;
    for (let page = 0; page < 20; page += 1) {
      const request = await nextHiddenRequest(desktop, "thread/loaded/list", after);
      after = desktop.upstream.sent.length;
      await desktop.pair.receiveUpstream(
        JSON.stringify({
          id: request.id,
          result: { data: [], nextCursor: `unique-cursor-${page + 1}` },
        }),
      );
    }

    await vi.waitFor(() => {
      expect(coordinator.snapshot().degraded).toBe(true);
    });
    expect(methodFrames(desktop, "thread/loaded/list")).toHaveLength(20);
  });

  it("uses stable client identity without gating on a Codex version", async () => {
    const coordinator = new BrokerCoordinator();
    const desktop = attach(coordinator);
    const sidecar = attach(coordinator);

    await initializeWithClientInfo(desktop, "desktop-versionless", {
      name: "codex-desktop-internal",
      title: "Codex Desktop",
    });
    await initializeWithClientInfo(sidecar, "sidecar-future", {
      name: "codex-local-remote",
      version: "9999.0.0-future",
    });

    expect(coordinator.snapshot()).toMatchObject({
      desktopConnected: true,
      sidecarConnected: true,
      unknownCount: 0,
    });
  });
});

describe("BrokerCoordinator protocol safety", () => {
  it("rejects reserved downstream IDs and never forwards hidden responses", async () => {
    const coordinator = new BrokerCoordinator();
    const fixture = attach(coordinator);

    await fixture.pair.receiveDownstream(
      JSON.stringify({
        id: `${BROKER_HIDDEN_ID_PREFIX}collision`,
        method: "model/list",
        params: {},
      }),
    );

    expect(fixture.upstream.sent).toEqual([]);
    expect(fixture.downstream.sent.map(parseRecord)).toEqual([
      {
        error: {
          code: -32_600,
          message: "Reserved broker request id",
        },
        id: `${BROKER_HIDDEN_ID_PREFIX}collision`,
      },
    ]);
  });

  it("closes both sides on an oversized or malformed frame", async () => {
    const coordinator = new BrokerCoordinator({ maxFrameBytes: 16 });
    const fixture = attach(coordinator);

    await fixture.pair.receiveDownstream("x".repeat(17));

    expect(fixture.downstream.closes).toEqual([{ code: 1009, reason: "protocol frame too large" }]);
    expect(fixture.upstream.closes).toEqual([{ code: 1009, reason: "protocol frame too large" }]);
  });
});
