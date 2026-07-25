import { describe, expect, it, vi } from "vitest";

import { RemoteEventBuffer } from "./events.js";

describe("RemoteEventBuffer", () => {
  it("assigns monotonic ids and replays only events newer than Last-Event-ID", () => {
    const clock = vi.fn(() => new Date("2026-07-25T00:00:00.000Z"));
    const buffer = new RemoteEventBuffer(4, clock);

    buffer.append("diagnostic", { message: "一" });
    buffer.append("thread.updated", { id: "thread-1" }, { threadId: "thread-1" });
    buffer.append("turn.state", { state: "running" }, { threadId: "thread-1", turnId: "turn-1" });

    expect(buffer.replayAfter(1)).toEqual({
      events: [
        expect.objectContaining({ seq: 2, type: "thread.updated" }),
        expect.objectContaining({ seq: 3, type: "turn.state" }),
      ],
      resetRequired: false,
    });
    expect(buffer.latestSequence).toBe(3);
  });

  it("requires a snapshot reset when the requested event has fallen out of the ring", () => {
    const buffer = new RemoteEventBuffer(2);
    buffer.append("diagnostic", { index: 1 });
    buffer.append("diagnostic", { index: 2 });
    buffer.append("diagnostic", { index: 3 });

    expect(buffer.replayAfter(0)).toEqual({
      events: [],
      resetRequired: true,
    });
    expect(buffer.createResetEvent()).toMatchObject({
      seq: 3,
      type: "connection.reset",
      payload: {
        latestSequence: 3,
        oldestAvailableSequence: 2,
        reason: "events-expired",
      },
    });
    expect(buffer.replayAfter(99)).toEqual({
      events: [],
      resetRequired: true,
    });
  });

  it("notifies subscribers without allowing a failing subscriber to block publication", () => {
    const buffer = new RemoteEventBuffer(3);
    const received: number[] = [];
    buffer.subscribe(() => {
      throw new Error("fixture subscriber");
    });
    const unsubscribe = buffer.subscribe((event) => {
      received.push(event.seq);
    });

    expect(() => buffer.append("diagnostic", {})).not.toThrow();
    unsubscribe();
    buffer.append("diagnostic", {});

    expect(received).toEqual([1]);
  });
});
