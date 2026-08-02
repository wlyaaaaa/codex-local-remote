import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PromptProtector } from "./prompt-protector.js";
import { DurableTurnOutbox, OutboxConflictError } from "./turn-outbox.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

const protector: PromptProtector = {
  protect: async (plaintext) =>
    Buffer.from([...plaintext].reverse().join(""), "utf8").toString("base64"),
  unprotect: async (protectedValue) =>
    [...Buffer.from(protectedValue, "base64").toString("utf8")].reverse().join(""),
};

async function openOutbox() {
  const directory = await DurableTurnOutbox.createTemporaryDirectoryForTests(
    path.join(os.tmpdir(), "codex-local-remote-outbox-"),
  );
  temporaryDirectories.push(directory);
  let sequence = 0;
  return {
    directory,
    outbox: await DurableTurnOutbox.open({
      clock: () => new Date(1_750_000_000_000 + sequence * 1_000),
      dataDir: directory,
      idFactory: () => `id-${++sequence}`,
      protector,
    }),
  };
}

describe("DurableTurnOutbox", () => {
  it("persists pending prompts encrypted and restores them with FIFO metadata", async () => {
    const { directory, outbox } = await openOutbox();
    const prompt = "这段未发送消息只能经 DPAPI 还原";

    const queued = await outbox.enqueue({
      idempotencyScope: "session:POST:/queue:enqueue-1",
      input: {
        attachments: [
          {
            kind: "file",
            projectId: "project-1",
            relativePath: "docs/private-plan.md",
          },
        ],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        collaborationMode: "Default",
        model: "gpt-fixture",
        permissionProfileId: ":workspace",
        prompt,
        reasoningEffort: "high",
        serviceTier: "fast",
      },
      threadId: "thread-1",
    });

    const serialized = await readFile(path.join(directory, "turn-outbox.json"), "utf8");
    expect(serialized).not.toContain(prompt);
    expect(serialized).not.toContain("private-plan.md");
    expect(queued).toMatchObject({
      attachments: [
        {
          kind: "file",
          projectId: "project-1",
          relativePath: "docs/private-plan.md",
        },
      ],
      clientUserMessageId: "id-1",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      collaborationMode: "Default",
      model: "gpt-fixture",
      permissionProfileId: ":workspace",
      position: 0,
      prompt,
      reasoningEffort: "high",
      serviceTier: "fast",
      state: "queued",
    });

    const reopened = await DurableTurnOutbox.open({ dataDir: directory, protector });
    await expect(reopened.snapshot("thread-1")).resolves.toMatchObject({
      items: [
        {
          attachments: [
            {
              kind: "file",
              projectId: "project-1",
              relativePath: "docs/private-plan.md",
            },
          ],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          id: queued.id,
          permissionProfileId: ":workspace",
          prompt,
          state: "queued",
        },
      ],
      revision: 1,
      threadId: "thread-1",
    });
  });

  it("deduplicates concurrent enqueue retries durably by HTTP idempotency scope", async () => {
    const { directory, outbox } = await openOutbox();

    const [first, second] = await Promise.all([
      outbox.enqueue({
        idempotencyScope: "same-session-route-key",
        input: { prompt: "只应排队一次" },
        threadId: "thread-1",
      }),
      outbox.enqueue({
        idempotencyScope: "same-session-route-key",
        input: { prompt: "重试正文不会覆盖首个请求" },
        threadId: "thread-1",
      }),
    ]);

    expect(second.id).toBe(first.id);
    expect((await outbox.snapshot("thread-1")).items).toHaveLength(1);
    const reopened = await DurableTurnOutbox.open({ dataDir: directory, protector });
    expect((await reopened.snapshot("thread-1")).items).toHaveLength(1);
  });

  it("persists a browser-uploaded file reference without treating it as a project file", async () => {
    const { directory, outbox } = await openOutbox();
    const attachment = {
      kind: "file" as const,
      relativePath: "phone/report.txt",
      uploadId: "4d423d3a-b0ec-4c0b-aac6-cb87ce47a438",
    };

    await outbox.enqueue({
      idempotencyScope: "browser-upload-enqueue",
      input: { attachments: [attachment], prompt: "读取手机上传的文件" },
      threadId: "thread-upload",
    });

    const reopened = await DurableTurnOutbox.open({ dataDir: directory, protector });
    await expect(reopened.snapshot("thread-upload")).resolves.toMatchObject({
      items: [{ attachments: [attachment] }],
    });
  });

  it("publishes queue metadata without leaking the protected prompt into SSE payloads", async () => {
    const { outbox } = await openOutbox();
    const changes: unknown[] = [];
    outbox.subscribe((change) => changes.push(change));
    const prompt = "SSE 里不能出现这段正文";

    await outbox.enqueue({
      idempotencyScope: "sse-enqueue",
      input: { prompt },
      threadId: "thread-1",
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      event: {
        action: "enqueued",
        item: { state: "queued", threadId: "thread-1" },
        revision: 1,
      },
      threadId: "thread-1",
    });
    expect(JSON.stringify(changes)).not.toContain(prompt);
  });

  it("claims a queued message for steer and removes it only after acknowledgement", async () => {
    const { outbox } = await openOutbox();
    const queued = await outbox.enqueue({
      idempotencyScope: "steer-enqueue",
      input: {
        attachments: [{ kind: "directory", projectId: "project-1", relativePath: "docs" }],
        prompt: "改成当前引导",
      },
      threadId: "thread-1",
    });

    await expect(
      outbox.claimForSteer({
        expectedRevision: 1,
        idempotencyScope: "steer-once",
        queueId: queued.id,
        threadId: "thread-1",
      }),
    ).resolves.toMatchObject({
      attachments: [{ kind: "directory", projectId: "project-1", relativePath: "docs" }],
      id: queued.id,
      prompt: "改成当前引导",
    });
    await expect(outbox.snapshot("thread-1")).resolves.toMatchObject({
      items: [{ prompt: "改成当前引导", state: "dispatching" }],
      revision: 2,
    });

    await outbox.markSteered({
      idempotencyScope: "steer-once",
      queueId: queued.id,
      threadId: "thread-1",
    });
    await expect(outbox.snapshot("thread-1")).resolves.toMatchObject({ items: [], revision: 3 });
    await expect(
      outbox.claimForSteer({
        expectedRevision: 1,
        idempotencyScope: "steer-once",
        queueId: queued.id,
        threadId: "thread-1",
      }),
    ).resolves.toBe("already-complete");
  });

  it("edits, reorders and removes through optimistic per-thread revisions", async () => {
    const { outbox } = await openOutbox();
    const first = await outbox.enqueue({
      idempotencyScope: "enqueue-first",
      input: { prompt: "first" },
      threadId: "thread-1",
    });
    const second = await outbox.enqueue({
      idempotencyScope: "enqueue-second",
      input: { prompt: "second" },
      threadId: "thread-1",
    });

    const reordered = await outbox.reorder({
      expectedRevision: 2,
      idempotencyScope: "reorder-once",
      queueIds: [second.id, first.id],
      threadId: "thread-1",
    });
    expect(reordered.items.map((item) => item.id)).toEqual([second.id, first.id]);

    const edited = await outbox.edit({
      expectedRevision: 3,
      idempotencyScope: "edit-once",
      input: { prompt: "second edited", reasoningEffort: "xhigh" },
      queueId: second.id,
      threadId: "thread-1",
    });
    expect(edited).toMatchObject({
      prompt: "second edited",
      reasoningEffort: "xhigh",
      revision: 4,
    });

    await expect(
      outbox.remove({
        expectedRevision: 3,
        idempotencyScope: "stale-delete",
        queueId: first.id,
        threadId: "thread-1",
      }),
    ).rejects.toBeInstanceOf(OutboxConflictError);

    const removed = await outbox.remove({
      expectedRevision: 4,
      idempotencyScope: "delete-once",
      queueId: first.id,
      threadId: "thread-1",
    });
    expect(removed.items.map((item) => item.id)).toEqual([second.id]);
    expect(removed.revision).toBe(5);
  });

  it("never returns a claimed prompt to another dispatcher", async () => {
    const { outbox } = await openOutbox();
    const queued = await outbox.enqueue({
      idempotencyScope: "claim-one",
      input: { prompt: "dispatch exactly once" },
      threadId: "thread-1",
    });

    const [first, second] = await Promise.all([
      outbox.claimNext("thread-1"),
      outbox.claimNext("thread-1"),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(first ?? second).toMatchObject({
      clientUserMessageId: queued.clientUserMessageId,
      prompt: "dispatch exactly once",
    });
    expect((await outbox.snapshot("thread-1")).items[0]?.state).toBe("dispatching");
  });

  it("never lets a late ambiguous result downgrade an already confirmed client message", async () => {
    const { outbox } = await openOutbox();
    const queued = await outbox.enqueue({
      idempotencyScope: "monotonic-client-message",
      input: { prompt: "状态只能向已确认收敛" },
      threadId: "thread-1",
    });
    await outbox.claimNext("thread-1");

    await outbox.confirmClientMessage(queued.clientUserMessageId, "turn-confirmed");
    await outbox.markAmbiguous(queued.id);

    await expect(outbox.snapshot("thread-1")).resolves.toMatchObject({
      items: [
        {
          id: queued.id,
          state: "started",
          turnId: "turn-confirmed",
        },
      ],
    });
  });

  it("removes a started tombstone when only the terminal notification carries the turn id", async () => {
    const { outbox } = await openOutbox();
    const accepted = await outbox.enqueue({
      idempotencyScope: "terminal-identifies-started-turn",
      input: { prompt: "客户端确认先到，但没有携带 turn id" },
      threadId: "thread-1",
    });
    await outbox.claimNext("thread-1");
    await outbox.confirmClientMessage(accepted.clientUserMessageId);
    const pending = await outbox.enqueue({
      idempotencyScope: "pending-after-unidentified-started-turn",
      input: { prompt: "上一轮完成后继续发送" },
      threadId: "thread-1",
    });

    await outbox.recordTerminal("thread-1", {
      status: "completed",
      turnId: "turn-confirmed-by-terminal",
    });

    await expect(outbox.snapshot("thread-1")).resolves.toMatchObject({
      items: [{ id: pending.id, state: "queued" }],
    });
    await expect(outbox.authorizeIdleDispatch("thread-1")).resolves.toBe("authorized");
  });

  it("captures items and revision atomically before decrypting a snapshot", async () => {
    const directory = await DurableTurnOutbox.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-outbox-atomic-"),
    );
    temporaryDirectories.push(directory);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let blockDecrypt = false;
    let sequence = 0;
    const blockingProtector: PromptProtector = {
      protect: async (value) => await protector.protect(value),
      unprotect: async (value) => {
        if (blockDecrypt) {
          entered.resolve();
          await release.promise;
        }
        return await protector.unprotect(value);
      },
    };
    const outbox = await DurableTurnOutbox.open({
      dataDir: directory,
      idFactory: () => `atomic-${++sequence}`,
      protector: blockingProtector,
    });
    const first = await outbox.enqueue({
      idempotencyScope: "atomic-first",
      input: { prompt: "first" },
      threadId: "thread-1",
    });
    const second = await outbox.enqueue({
      idempotencyScope: "atomic-second",
      input: { prompt: "second" },
      threadId: "thread-1",
    });

    blockDecrypt = true;
    const snapshotPromise = outbox.snapshot("thread-1");
    await entered.promise;
    await outbox.pauseThread("thread-1");
    release.resolve();

    await expect(snapshotPromise).resolves.toMatchObject({
      items: [
        { id: first.id, position: 0 },
        { id: second.id, position: 1 },
      ],
      revision: 2,
    });
  });

  it("rejects malformed persisted pending items instead of silently loading them", async () => {
    const directory = await DurableTurnOutbox.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-outbox-invalid-"),
    );
    temporaryDirectories.push(directory);
    await writeFile(
      path.join(directory, "turn-outbox.json"),
      JSON.stringify({
        items: [
          {
            clientUserMessageId: "client-1",
            createdAt: "2026-07-26T00:00:00.000Z",
            id: "queue-1",
            revision: 1,
            state: "queued",
            threadId: "thread-1",
            updatedAt: "2026-07-26T00:00:00.000Z",
          },
        ],
        receiptOrder: [],
        receipts: {},
        revisions: { "thread-1": 1 },
        schemaVersion: 1,
      }),
      "utf8",
    );

    await expect(DurableTurnOutbox.open({ dataDir: directory, protector })).rejects.toThrow(
      "远程消息队列无法读取",
    );
  });

  it("enforces per-thread, total-item and protected-byte capacity limits", async () => {
    const directory = await DurableTurnOutbox.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-outbox-limits-"),
    );
    temporaryDirectories.push(directory);
    let sequence = 0;
    const outbox = await DurableTurnOutbox.open({
      dataDir: directory,
      idFactory: () => `limit-${++sequence}`,
      limits: {
        maxItemsPerThread: 2,
        maxProtectedBytes: 32,
        maxTotalItems: 3,
      },
      protector,
    });
    await outbox.enqueue({
      idempotencyScope: "limit-thread-1-a",
      input: { prompt: "a" },
      threadId: "thread-1",
    });
    await outbox.enqueue({
      idempotencyScope: "limit-thread-1-b",
      input: { prompt: "b" },
      threadId: "thread-1",
    });
    await expect(
      outbox.enqueue({
        idempotencyScope: "limit-thread-1-c",
        input: { prompt: "c" },
        threadId: "thread-1",
      }),
    ).rejects.toMatchObject({ code: "QUEUE_THREAD_CAPACITY_EXCEEDED" });

    await outbox.enqueue({
      idempotencyScope: "limit-thread-2-a",
      input: { prompt: "d" },
      threadId: "thread-2",
    });
    await expect(
      outbox.enqueue({
        idempotencyScope: "limit-total",
        input: { prompt: "e" },
        threadId: "thread-3",
      }),
    ).rejects.toMatchObject({ code: "QUEUE_TOTAL_CAPACITY_EXCEEDED" });

    const byteLimitedDirectory = await DurableTurnOutbox.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-outbox-byte-limit-"),
    );
    temporaryDirectories.push(byteLimitedDirectory);
    const byteLimited = await DurableTurnOutbox.open({
      dataDir: byteLimitedDirectory,
      limits: {
        maxItemsPerThread: 10,
        maxProtectedBytes: 4,
        maxTotalItems: 10,
      },
      protector,
    });
    await expect(
      byteLimited.enqueue({
        idempotencyScope: "limit-bytes",
        input: { prompt: "ciphertext is larger than four bytes" },
        threadId: "thread-1",
      }),
    ).rejects.toMatchObject({ code: "QUEUE_PROTECTED_CAPACITY_EXCEEDED" });
  });

  it("bounds concurrent prompt decryption when projecting a large queue snapshot", async () => {
    const directory = await DurableTurnOutbox.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-outbox-crypto-limit-"),
    );
    temporaryDirectories.push(directory);
    let active = 0;
    let maximumActive = 0;
    let observeConcurrency = false;
    const limitedProtector: PromptProtector = {
      protect: async (value) => await protector.protect(value),
      unprotect: async (value) => {
        if (!observeConcurrency) {
          return await protector.unprotect(value);
        }
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return await protector.unprotect(value);
      },
    };
    let sequence = 0;
    const outbox = await DurableTurnOutbox.open({
      cryptoConcurrency: 2,
      dataDir: directory,
      idFactory: () => `crypto-${++sequence}`,
      protector: limitedProtector,
    });
    for (let index = 0; index < 6; index += 1) {
      await outbox.enqueue({
        idempotencyScope: `crypto-${index}`,
        input: { prompt: `prompt-${index}` },
        threadId: "thread-1",
      });
    }

    observeConcurrency = true;
    await outbox.snapshot("thread-1");

    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(maximumActive).toBeGreaterThan(0);
  });

  it("does not acknowledge or retain an enqueue that could not be persisted", async () => {
    const { directory, outbox } = await openOutbox();
    await rm(directory, { force: true, recursive: true });
    await writeFile(directory, "block persistence", "utf8");

    await expect(
      outbox.enqueue({
        idempotencyScope: "failed-durable-enqueue",
        input: { prompt: "must not survive only in memory" },
        threadId: "thread-1",
      }),
    ).rejects.toBeDefined();

    await rm(directory, { force: true });
    await mkdir(directory, { recursive: true });
    await expect(outbox.snapshot("thread-1")).resolves.toMatchObject({
      items: [],
      revision: 0,
    });
  });
});
