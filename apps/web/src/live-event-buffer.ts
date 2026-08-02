export type BufferedLiveEvent = {
  deliveryId: number;
  event: { type: string };
};

export type LiveEventFrameBuffer<T extends BufferedLiveEvent> = {
  dispose(): void;
  enqueue(envelope: T): void;
};

export function createLiveEventFrameBuffer<T extends BufferedLiveEvent>(options: {
  cancelFrame(frameId: number): void;
  commit(incoming: readonly T[], resetsRetainedState: boolean): void;
  limit: number;
  scheduleFrame(callback: () => void): number;
}): LiveEventFrameBuffer<T> {
  const limit = Math.max(1, Math.floor(options.limit));
  let disposed = false;
  let frameId: number | undefined;
  let pending: T[] = [];
  let resetsRetainedState = false;

  const flush = () => {
    frameId = undefined;
    if (disposed || pending.length === 0) return;
    const incoming = pending;
    const resets = resetsRetainedState;
    pending = [];
    resetsRetainedState = false;
    options.commit(incoming, resets);
  };

  return {
    dispose() {
      disposed = true;
      pending = [];
      resetsRetainedState = false;
      if (frameId !== undefined) {
        options.cancelFrame(frameId);
        frameId = undefined;
      }
    },
    enqueue(envelope) {
      if (disposed) return;
      if (envelope.event.type === "connection.reset") {
        pending = [];
        resetsRetainedState = true;
      }
      pending.push(envelope);
      if (pending.length > limit) pending = pending.slice(-limit);
      if (frameId === undefined) frameId = options.scheduleFrame(flush);
    },
  };
}

/**
 * Appends one animation-frame batch while preserving the stream reset boundary.
 * A reset invalidates everything before it, including events already retained.
 */
export function appendLiveEventBatch<T extends BufferedLiveEvent>(
  current: readonly T[],
  incoming: readonly T[],
  limit: number,
): T[] {
  if (incoming.length === 0) return [...current];
  const boundedLimit = Math.max(1, Math.floor(limit));
  const lastResetIndex = incoming.findLastIndex(
    (envelope) => envelope.event.type === "connection.reset",
  );
  const next = lastResetIndex >= 0 ? incoming.slice(lastResetIndex) : [...current, ...incoming];
  return next.length > boundedLimit ? next.slice(next.length - boundedLimit) : [...next];
}
