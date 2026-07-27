import { describe, expect, it, vi } from "vitest";

import { ThreadLifecycleArbiter, TurnStartConflictError } from "./thread-lifecycle.js";

describe("ThreadLifecycleArbiter", () => {
  it("admits only one concurrent turn start while an idle check is in flight", async () => {
    const arbiter = new ThreadLifecycleArbiter();
    let releaseCheck: ((state: "idle") => void) | undefined;
    const check = new Promise<"idle">((resolve) => {
      releaseCheck = resolve;
    });

    const first = arbiter.reserve("thread-1", 1, async () => await check);
    await vi.waitFor(() => {
      expect(arbiter.snapshot("thread-1")?.phase).toBe("checking");
    });

    await expect(arbiter.reserve("thread-1", 2, async () => "idle")).rejects.toBeInstanceOf(
      TurnStartConflictError,
    );
    releaseCheck?.("idle");
    const reservation = await first;

    expect(arbiter.snapshot("thread-1")).toMatchObject({
      ownerConnectionId: 1,
      phase: "reserved",
      token: reservation.token,
    });
  });

  it("keeps a forwarded turn active until the matching completion arrives", async () => {
    const arbiter = new ThreadLifecycleArbiter();
    arbiter.observeStatus("thread-1", "idle");
    const reservation = await arbiter.reserve("thread-1", 1, async () => {
      throw new Error("known idle should not be re-read");
    });

    arbiter.activate(reservation, "turn-1");
    expect(arbiter.snapshot("thread-1")).toMatchObject({
      phase: "active",
      turnId: "turn-1",
    });

    arbiter.complete("thread-1", "another-turn");
    expect(arbiter.snapshot("thread-1")?.phase).toBe("active");
    arbiter.complete("thread-1", "turn-1");
    expect(arbiter.snapshot("thread-1")?.phase).toBe("idle");
  });

  it("rechecks an active cache entry so a missed completion cannot permanently block replies", async () => {
    const arbiter = new ThreadLifecycleArbiter();
    const inspect = vi.fn(async () => "idle" as const);
    arbiter.observeStarted("thread-1", "turn-finished");

    const reservation = await arbiter.reserve("thread-1", 2, inspect);

    expect(inspect).toHaveBeenCalledOnce();
    expect(arbiter.snapshot("thread-1")).toMatchObject({
      ownerConnectionId: 2,
      phase: "reserved",
      token: reservation.token,
    });
  });

  it("rechecks an active cache entry and still rejects while Codex confirms it is active", async () => {
    const arbiter = new ThreadLifecycleArbiter();
    const inspect = vi.fn(async () => "active" as const);
    arbiter.observeStarted("thread-1", "turn-active");

    await expect(arbiter.reserve("thread-1", 2, inspect)).rejects.toMatchObject({
      message: "Thread already has an active turn",
    });

    expect(inspect).toHaveBeenCalledOnce();
    expect(arbiter.snapshot("thread-1")?.phase).toBe("active");
  });

  it("does not resurrect a turn whose completion beat its start response", async () => {
    const arbiter = new ThreadLifecycleArbiter();
    arbiter.observeStatus("thread-1", "idle");
    const reservation = await arbiter.reserve("thread-1", 1, async () => "idle");

    arbiter.observeStarted("thread-1", "turn-fast");
    arbiter.complete("thread-1", "turn-fast");
    arbiter.activate(reservation, "turn-fast");

    expect(arbiter.snapshot("thread-1")?.phase).toBe("idle");
  });

  it("does not resurrect a completed turn when its started event is delivered late", () => {
    const arbiter = new ThreadLifecycleArbiter();

    arbiter.observeStarted("thread-1", "turn-late");
    arbiter.complete("thread-1", "turn-late");
    arbiter.observeStarted("thread-1", "turn-late");

    expect(arbiter.snapshot("thread-1")?.phase).toBe("idle");
  });

  it("fails closed after an owning connection disappears mid-start", async () => {
    const arbiter = new ThreadLifecycleArbiter();
    arbiter.observeStatus("thread-1", "idle");
    await arbiter.reserve("thread-1", 7, async () => "idle");

    arbiter.connectionClosed(7);

    expect(arbiter.snapshot("thread-1")?.phase).toBe("unknown");
    await expect(arbiter.reserve("thread-1", 8, async () => "unknown")).rejects.toBeInstanceOf(
      TurnStartConflictError,
    );
  });

  it("allows an authoritative idle observation to recover an unknown lifecycle", async () => {
    const arbiter = new ThreadLifecycleArbiter();
    arbiter.observeStatus("thread-1", "active");
    arbiter.connectionClosed(1);
    arbiter.observeStatus("thread-1", "idle");

    const reservation = await arbiter.reserve("thread-1", 2, async () => "unknown");

    expect(reservation.threadId).toBe("thread-1");
    expect(arbiter.snapshot("thread-1")?.phase).toBe("reserved");
  });

  it("reports every non-idle lifecycle as unsafe for Broker maintenance", () => {
    const arbiter = new ThreadLifecycleArbiter();
    arbiter.observeStatus("idle-thread", "idle");
    arbiter.observeStatus("active-thread", "active");
    arbiter.observeStatus("unknown-thread", "unknown");

    expect(arbiter.unsafeThreadCount()).toBe(2);

    arbiter.observeStatus("active-thread", "idle");
    arbiter.observeStatus("unknown-thread", "idle");
    expect(arbiter.unsafeThreadCount()).toBe(0);
  });
});
