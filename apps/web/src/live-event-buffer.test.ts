import { describe, expect, it } from "vitest";

import { appendLiveEventBatch, createLiveEventFrameBuffer } from "./live-event-buffer";

const envelope = (deliveryId: number, type = "thread.item") => ({
  deliveryId,
  event: { type },
});

describe("live event animation-frame buffer", () => {
  it("appends a whole frame in delivery order and trims only the oldest retained events", () => {
    expect(
      appendLiveEventBatch(
        [envelope(1), envelope(2)],
        [envelope(3), envelope(4), envelope(5)],
        4,
      ).map((item) => item.deliveryId),
    ).toEqual([2, 3, 4, 5]);
  });

  it("keeps only the last reset and everything delivered after it", () => {
    expect(
      appendLiveEventBatch(
        [envelope(1), envelope(2)],
        [
          envelope(3),
          envelope(4, "connection.reset"),
          envelope(5),
          envelope(6, "connection.reset"),
          envelope(7),
        ],
        20,
      ).map((item) => [item.deliveryId, item.event.type]),
    ).toEqual([
      [6, "connection.reset"],
      [7, "thread.item"],
    ]);
  });

  it("does not mutate either source array", () => {
    const current = [envelope(1)];
    const incoming = [envelope(2)];

    appendLiveEventBatch(current, incoming, 20);

    expect(current.map((item) => item.deliveryId)).toEqual([1]);
    expect(incoming.map((item) => item.deliveryId)).toEqual([2]);
  });

  it("commits many token events at most once in one animation frame", () => {
    const scheduled: Array<() => void> = [];
    const commits: Array<{ ids: number[]; reset: boolean }> = [];
    const buffer = createLiveEventFrameBuffer({
      cancelFrame: () => undefined,
      commit: (incoming, reset) =>
        commits.push({ ids: incoming.map((item) => item.deliveryId), reset }),
      limit: 20,
      scheduleFrame: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
    });

    for (let deliveryId = 1; deliveryId <= 10; deliveryId += 1) {
      buffer.enqueue(envelope(deliveryId));
    }

    expect(scheduled).toHaveLength(1);
    expect(commits).toEqual([]);
    scheduled[0]!();
    expect(commits).toEqual([{ ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], reset: false }]);
  });

  it("drops pre-reset pending work and cancels an unflushed frame on disposal", () => {
    const scheduled: Array<() => void> = [];
    const cancelled: number[] = [];
    const commits: Array<{ ids: number[]; reset: boolean }> = [];
    const buffer = createLiveEventFrameBuffer({
      cancelFrame: (frameId) => void cancelled.push(frameId),
      commit: (incoming, reset) =>
        commits.push({ ids: incoming.map((item) => item.deliveryId), reset }),
      limit: 2,
      scheduleFrame: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
    });

    buffer.enqueue(envelope(1));
    buffer.enqueue(envelope(2, "connection.reset"));
    buffer.enqueue(envelope(3));
    scheduled[0]!();
    expect(commits).toEqual([{ ids: [2, 3], reset: true }]);

    buffer.enqueue(envelope(4));
    buffer.dispose();
    expect(cancelled).toEqual([2]);
    scheduled[1]!();
    expect(commits).toHaveLength(1);
  });
});
