import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@codex-local-remote/domain";

import type { PromptProtector } from "./prompt-protector.js";
import { DurableTurnOutbox } from "./turn-outbox.js";
import { TurnQueueDispatcher, type TurnQueueGateway } from "./turn-queue-dispatcher.js";

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

async function fixture(initialState: "active" | "idle" | "unknown" = "idle") {
  const directory = await DurableTurnOutbox.createTemporaryDirectoryForTests(
    path.join(os.tmpdir(), "codex-local-remote-dispatcher-"),
  );
  temporaryDirectories.push(directory);
  let sequence = 0;
  const outbox = await DurableTurnOutbox.open({
    dataDir: directory,
    idFactory: () => `fixture-${++sequence}`,
    protector,
  });
  let threadState = initialState;
  const startTurn = vi.fn(
    async (
      _threadId: string,
      _input: Parameters<TurnQueueGateway["startTurn"]>[1],
    ): Promise<{ turnId: string }> => ({ turnId: "turn-dispatched" }),
  );
  const reconcileClientUserMessage = vi.fn<TurnQueueGateway["reconcileClientUserMessage"]>(
    async () => ({ state: "absent-idle" }),
  );
  const steerTurn = vi.fn<TurnQueueGateway["steerTurn"]>(async () => undefined);
  const gateway: TurnQueueGateway = {
    inspectThread: vi.fn(async () => ({ state: threadState })),
    reconcileClientUserMessage,
    startTurn,
    steerTurn,
  };
  const dispatcher = new TurnQueueDispatcher({ gateway, outbox });
  return {
    directory,
    dispatcher,
    gateway,
    outbox,
    reconcileClientUserMessage,
    setThreadState: (value: typeof threadState) => {
      threadState = value;
    },
    startTurn,
    steerTurn,
  };
}

describe("TurnQueueDispatcher", () => {
  it("does not call turn/start while the authoritative thread is active", async () => {
    const { dispatcher, outbox, startTurn } = await fixture("active");
    await outbox.enqueue({
      idempotencyScope: "active-enqueue",
      input: { prompt: "下一轮再执行" },
      threadId: "thread-1",
    });

    await dispatcher.wake("thread-1");

    expect(startTurn).not.toHaveBeenCalled();
    expect((await outbox.snapshot("thread-1")).items[0]?.state).toBe("queued");
  });

  it("atomically turns one queued message into guidance for the active turn", async () => {
    const { dispatcher, outbox, steerTurn } = await fixture("active");
    const queued = await outbox.enqueue({
      idempotencyScope: "steer-enqueue",
      input: {
        attachments: [{ kind: "file", projectId: "project-1", relativePath: "docs/acceptance.md" }],
        prompt: "把这条下一轮消息改成当前引导",
      },
      threadId: "thread-1",
    });

    await dispatcher.steerQueued(
      "thread-1",
      queued.id,
      { expectedRevision: 1, turnId: "turn-current" },
      "steer-once",
    );

    expect(steerTurn).toHaveBeenCalledWith("thread-1", "turn-current", {
      attachments: [{ kind: "file", projectId: "project-1", relativePath: "docs/acceptance.md" }],
      prompt: "把这条下一轮消息改成当前引导",
    });
    await expect(outbox.snapshot("thread-1")).resolves.toMatchObject({
      items: [],
      revision: 3,
    });

    await dispatcher.steerQueued(
      "thread-1",
      queued.id,
      { expectedRevision: 1, turnId: "turn-current" },
      "steer-once",
    );
    expect(steerTurn).toHaveBeenCalledTimes(1);
  });

  it("keeps the encrypted prompt recoverable when steer acknowledgement is uncertain", async () => {
    const { dispatcher, outbox, steerTurn } = await fixture("active");
    const queued = await outbox.enqueue({
      idempotencyScope: "steer-uncertain-enqueue",
      input: { prompt: "不确定时不能丢失" },
      threadId: "thread-1",
    });
    steerTurn.mockRejectedValueOnce(new Error("connection closed after send"));

    await expect(
      dispatcher.steerQueued(
        "thread-1",
        queued.id,
        { expectedRevision: 1, turnId: "turn-current" },
        "steer-uncertain",
      ),
    ).rejects.toThrow("connection closed after send");
    await expect(outbox.snapshot("thread-1")).resolves.toMatchObject({
      items: [
        {
          issue: "STEER_RESULT_UNKNOWN",
          prompt: "不确定时不能丢失",
          state: "ambiguous",
        },
      ],
    });
  });

  it("dispatches once only after a normal completion and authoritative idle", async () => {
    const { dispatcher, outbox, setThreadState, startTurn } = await fixture("active");
    const queued = await outbox.enqueue({
      idempotencyScope: "completion-enqueue",
      input: {
        approvalPolicy: "on-request",
        model: "gpt-fixture",
        prompt: "完成上一轮后发送",
        reasoningEffort: "high",
      },
      threadId: "thread-1",
    });

    await dispatcher.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-current", status: "completed" },
      },
    });
    expect(startTurn).not.toHaveBeenCalled();

    setThreadState("idle");
    await dispatcher.handleNotification({
      method: "thread/status/changed",
      params: { status: { type: "idle" }, threadId: "thread-1" },
    });
    await dispatcher.handleNotification({
      method: "thread/status/changed",
      params: { status: { type: "idle" }, threadId: "thread-1" },
    });

    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(startTurn).toHaveBeenCalledWith("thread-1", {
      approvalPolicy: "on-request",
      clientUserMessageId: queued.clientUserMessageId,
      model: "gpt-fixture",
      prompt: "完成上一轮后发送",
      reasoningEffort: "high",
    });
    const started = (await outbox.snapshot("thread-1")).items[0];
    expect(started).toMatchObject({
      state: "started",
      turnId: "turn-dispatched",
    });
    expect(started).not.toHaveProperty("prompt");
  });

  it("uses an authoritative idle read when a compatible backend omits the idle event", async () => {
    const { dispatcher, outbox, startTurn } = await fixture("idle");
    await outbox.enqueue({
      idempotencyScope: "completion-without-status-event",
      input: { prompt: "不要依赖某个版本是否发送 idle 事件" },
      threadId: "thread-1",
    });

    await dispatcher.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-current", status: "completed" },
      },
    });

    expect(startTurn).toHaveBeenCalledTimes(1);
    expect((await outbox.snapshot("thread-1")).items[0]?.state).toBe("started");

    await dispatcher.handleNotification({
      method: "thread/status/changed",
      params: { status: { type: "idle" }, threadId: "thread-1" },
    });
    expect(startTurn).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "interrupted", "cancelled"])(
    "pauses pending messages after a %s turn",
    async (status) => {
      const { dispatcher, outbox, startTurn } = await fixture("active");
      await outbox.enqueue({
        idempotencyScope: `pause-${status}`,
        input: { prompt: "失败后不要自动连发" },
        threadId: "thread-1",
      });

      await dispatcher.handleNotification({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-current", status } },
      });

      expect(startTurn).not.toHaveBeenCalled();
      expect((await outbox.snapshot("thread-1")).items[0]).toMatchObject({
        issue: "PREVIOUS_TURN_DID_NOT_COMPLETE",
        state: "paused",
      });
    },
  );

  it("reconciles a crash-after-send by client id and otherwise fails closed as ambiguous", async () => {
    const acceptedFixture = await fixture("idle");
    const accepted = await acceptedFixture.outbox.enqueue({
      idempotencyScope: "accepted-enqueue",
      input: { prompt: "already accepted" },
      threadId: "thread-accepted",
    });
    await acceptedFixture.outbox.claimNext("thread-accepted");
    acceptedFixture.reconcileClientUserMessage.mockResolvedValueOnce({
      state: "accepted",
      turnId: "turn-existing",
    });

    await acceptedFixture.dispatcher.reconcileAfterRestart();
    const reconciled = (await acceptedFixture.outbox.snapshot("thread-accepted")).items[0];
    expect(reconciled).toMatchObject({
      state: "started",
      turnId: "turn-existing",
    });
    expect(reconciled).not.toHaveProperty("prompt");
    expect(acceptedFixture.startTurn).not.toHaveBeenCalled();

    const ambiguousFixture = await fixture("idle");
    const ambiguous = await ambiguousFixture.outbox.enqueue({
      idempotencyScope: "ambiguous-enqueue",
      input: { prompt: "maybe accepted" },
      threadId: "thread-ambiguous",
    });
    await ambiguousFixture.outbox.claimNext("thread-ambiguous");
    ambiguousFixture.reconcileClientUserMessage.mockResolvedValueOnce({
      state: "absent-idle",
    });

    await ambiguousFixture.dispatcher.reconcileAfterRestart();
    expect((await ambiguousFixture.outbox.snapshot("thread-ambiguous")).items[0]).toMatchObject({
      clientUserMessageId: ambiguous.clientUserMessageId,
      issue: "SEND_RESULT_UNKNOWN",
      prompt: "maybe accepted",
      state: "ambiguous",
    });
    expect(ambiguousFixture.startTurn).not.toHaveBeenCalled();
    expect(accepted.clientUserMessageId).toBeTruthy();
  });

  it("removes an already-completed accepted turn after restart and dispatches the next message", async () => {
    const current = await fixture("idle");
    await current.outbox.enqueue({
      idempotencyScope: "completed-before-restart",
      input: { prompt: "已经完成，不应在重启后卡住队列" },
      threadId: "thread-completed",
    });
    await current.outbox.claimNext("thread-completed");
    await current.outbox.enqueue({
      idempotencyScope: "next-after-completed",
      input: { prompt: "完成项清理后应继续发送" },
      threadId: "thread-completed",
    });
    current.reconcileClientUserMessage.mockResolvedValueOnce({
      lifecycle: "completed",
      state: "accepted",
      turnId: "turn-already-completed",
    });

    await current.dispatcher.reconcileAfterRestart();

    expect(current.startTurn).toHaveBeenCalledTimes(1);
    expect(current.startTurn).toHaveBeenCalledWith(
      "thread-completed",
      expect.objectContaining({ prompt: "完成项清理后应继续发送" }),
    );
    await expect(current.outbox.snapshot("thread-completed")).resolves.toMatchObject({
      items: [
        {
          state: "started",
          turnId: "turn-dispatched",
        },
      ],
    });
  });

  it("pauses an unknown previous lifecycle after restart instead of dispatching from idle alone", async () => {
    const beforeRestart = await fixture("active");
    await beforeRestart.outbox.enqueue({
      idempotencyScope: "restart-active-enqueue",
      input: { prompt: "上一轮结果未知时不能自动发送" },
      threadId: "thread-1",
    });
    await beforeRestart.dispatcher.wake("thread-1");

    const reopened = await DurableTurnOutbox.open({
      dataDir: beforeRestart.directory,
      protector,
    });
    const startTurn = vi.fn(async () => ({ turnId: "must-not-start" }));
    const dispatcher = new TurnQueueDispatcher({
      gateway: {
        inspectThread: async () => ({ state: "idle" }),
        reconcileClientUserMessage: async () => ({ state: "absent-idle" }),
        startTurn,
        steerTurn: async () => undefined,
      },
      outbox: reopened,
    });

    await dispatcher.reconcileAfterRestart();

    expect(startTurn).not.toHaveBeenCalled();
    await expect(reopened.snapshot("thread-1")).resolves.toMatchObject({
      items: [
        {
          issue: "PREVIOUS_TURN_RESULT_UNKNOWN_AFTER_RESTART",
          state: "paused",
        },
      ],
    });
  });

  it("pauses deterministic domain rejection but reserves ambiguous for transport uncertainty", async () => {
    const deterministic = await fixture("idle");
    await deterministic.outbox.enqueue({
      idempotencyScope: "deterministic-rejection",
      input: { prompt: "无效设置不代表已经跨边界发送" },
      threadId: "thread-1",
    });
    deterministic.startTurn.mockRejectedValueOnce(
      new DomainError("INVALID_INPUT", "fixture invalid model", 409),
    );

    await deterministic.dispatcher.wake("thread-1");

    await expect(deterministic.outbox.snapshot("thread-1")).resolves.toMatchObject({
      items: [{ issue: "TURN_START_REJECTED:INVALID_INPUT", state: "paused" }],
    });

    const uncertain = await fixture("idle");
    await uncertain.outbox.enqueue({
      idempotencyScope: "transport-uncertain",
      input: { prompt: "连接断开可能发生在发送之后" },
      threadId: "thread-1",
    });
    uncertain.startTurn.mockRejectedValueOnce(new Error("transport closed"));

    await uncertain.dispatcher.wake("thread-1");

    await expect(uncertain.outbox.snapshot("thread-1")).resolves.toMatchObject({
      items: [{ issue: "SEND_RESULT_UNKNOWN", state: "ambiguous" }],
    });
  });

  it("returns a deterministic busy rejection to the front of the queue", async () => {
    const busy = await fixture("idle");
    await busy.outbox.enqueue({
      idempotencyScope: "deterministic-busy",
      input: { prompt: "等待实际活动轮结束" },
      threadId: "thread-1",
    });
    busy.startTurn.mockRejectedValueOnce(
      new DomainError("TURN_MISMATCH", "fixture active turn", 409),
    );

    await busy.dispatcher.wake("thread-1");

    await expect(busy.outbox.snapshot("thread-1")).resolves.toMatchObject({
      items: [{ state: "queued" }],
    });
  });

  it("removes the started queue tombstone once its turn is terminal", async () => {
    const current = await fixture("idle");
    await current.outbox.enqueue({
      idempotencyScope: "started-tombstone",
      input: { prompt: "终态后不应永久留在下一轮队列" },
      threadId: "thread-1",
    });
    await current.dispatcher.wake("thread-1");
    expect((await current.outbox.snapshot("thread-1")).items).toHaveLength(1);

    await current.dispatcher.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-dispatched", status: "completed" },
      },
    });

    expect((await current.outbox.snapshot("thread-1")).items).toHaveLength(0);
  });
});
