import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PromptProtector } from "./prompt-protector.js";
import { DurableTurnOutbox } from "./turn-outbox.js";
import { TurnQueueDispatcher } from "./turn-queue-dispatcher.js";
import { TurnQueueService } from "./turn-queue.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

const protector: PromptProtector = {
  protect: async (value) => Buffer.from(value, "utf8").toString("base64"),
  unprotect: async (value) => Buffer.from(value, "base64").toString("utf8"),
};

describe("TurnQueueService", () => {
  it("acknowledges a durably queued message while the Codex backend is reconnecting", async () => {
    const directory = await DurableTurnOutbox.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-queue-service-"),
    );
    temporaryDirectories.push(directory);
    let sequence = 0;
    const outbox = await DurableTurnOutbox.open({
      dataDir: directory,
      idFactory: () => `fixture-${++sequence}`,
      protector,
    });
    const dispatcher = new TurnQueueDispatcher({
      gateway: {
        inspectThread: async () => {
          throw new Error("backend reconnecting");
        },
        reconcileClientUserMessage: async () => ({ state: "unknown" }),
        startTurn: async () => {
          throw new Error("must not be reached");
        },
        steerTurn: async () => {
          throw new Error("must not be reached");
        },
      },
      outbox,
    });
    const service = new TurnQueueService({ dispatcher, outbox });

    await expect(
      service.enqueue(
        "thread-1",
        { prompt: "连接恢复后再发送" },
        "session:POST:/threads/thread-1/queue:retry-safe",
      ),
    ).resolves.toMatchObject({
      items: [{ prompt: "连接恢复后再发送", state: "queued" }],
      revision: 1,
      threadId: "thread-1",
    });

    const reopened = await DurableTurnOutbox.open({ dataDir: directory, protector });
    await expect(reopened.snapshot("thread-1")).resolves.toMatchObject({
      items: [{ prompt: "连接恢复后再发送", state: "queued" }],
    });
  });

  it("allows an explicit immediate send for queued, paused and acknowledged-ambiguous items", async () => {
    const directory = await DurableTurnOutbox.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-queue-manual-"),
    );
    temporaryDirectories.push(directory);
    let sequence = 0;
    const outbox = await DurableTurnOutbox.open({
      dataDir: directory,
      idFactory: () => `manual-${++sequence}`,
      protector,
    });
    const dispatcher = new TurnQueueDispatcher({
      gateway: {
        inspectThread: async () => ({ state: "idle" }),
        reconcileClientUserMessage: async () => ({ state: "absent-idle" }),
        startTurn: async (threadId) => ({ turnId: `turn-${threadId}` }),
        steerTurn: async () => undefined,
      },
      outbox,
    });
    const service = new TurnQueueService({ dispatcher, outbox });

    const queued = await outbox.enqueue({
      idempotencyScope: "manual-queued-enqueue",
      input: { prompt: "立即发送 queued" },
      threadId: "thread-queued",
    });
    await expect(
      service.send("thread-queued", queued.id, { expectedRevision: 1 }, "manual-queued-send"),
    ).resolves.toMatchObject({
      items: [{ state: "started", turnId: "turn-thread-queued" }],
    });

    const paused = await outbox.enqueue({
      idempotencyScope: "manual-paused-enqueue",
      input: { prompt: "恢复 paused" },
      threadId: "thread-paused",
    });
    await outbox.pauseThread("thread-paused");
    await expect(
      service.send("thread-paused", paused.id, { expectedRevision: 2 }, "manual-paused-send"),
    ).resolves.toMatchObject({
      items: [{ state: "started", turnId: "turn-thread-paused" }],
    });

    const ambiguous = await outbox.enqueue({
      idempotencyScope: "manual-ambiguous-enqueue",
      input: { prompt: "确认后重试 ambiguous" },
      threadId: "thread-ambiguous",
    });
    await outbox.claimNext("thread-ambiguous");
    await outbox.markAmbiguous(ambiguous.id);
    await expect(
      service.send(
        "thread-ambiguous",
        ambiguous.id,
        { expectedRevision: 3, retryAmbiguous: true },
        "manual-ambiguous-send",
      ),
    ).resolves.toMatchObject({
      items: [{ state: "started", turnId: "turn-thread-ambiguous" }],
    });
  });
});
