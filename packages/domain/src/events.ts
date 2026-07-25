import { API_SCHEMA_VERSION, type RemoteEvent } from "@codex-local-remote/contracts";

export interface RemoteEventContext {
  threadId?: string;
  turnId?: string;
}

export interface EventReplay {
  events: RemoteEvent[];
  resetRequired: boolean;
}

export class RemoteEventBuffer {
  readonly #capacity: number;
  readonly #clock: () => Date;
  readonly #events: RemoteEvent[] = [];
  readonly #subscribers = new Set<(event: RemoteEvent) => void>();
  #latestSequence = 0;

  constructor(capacity = 1_000, clock: () => Date = () => new Date()) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("事件缓冲区容量必须为正整数");
    }
    this.#capacity = capacity;
    this.#clock = clock;
  }

  get latestSequence(): number {
    return this.#latestSequence;
  }

  append<T>(
    type: RemoteEvent<T>["type"],
    payload: T,
    context: RemoteEventContext = {},
  ): RemoteEvent<T> {
    const event: RemoteEvent<T> = {
      emittedAt: this.#clock().toISOString(),
      payload,
      schemaVersion: API_SCHEMA_VERSION,
      seq: ++this.#latestSequence,
      type,
      ...(context.threadId === undefined ? {} : { threadId: context.threadId }),
      ...(context.turnId === undefined ? {} : { turnId: context.turnId }),
    };

    this.#events.push(event);
    if (this.#events.length > this.#capacity) {
      this.#events.splice(0, this.#events.length - this.#capacity);
    }

    for (const subscriber of this.#subscribers) {
      try {
        subscriber(event);
      } catch {
        // A disconnected or faulty SSE subscriber must not block the event bus.
      }
    }
    return event;
  }

  replayAfter(lastSequence?: number): EventReplay {
    if (lastSequence === undefined) {
      return { events: [...this.#events], resetRequired: false };
    }
    if (!Number.isSafeInteger(lastSequence) || lastSequence < 0) {
      return { events: [], resetRequired: true };
    }
    if (lastSequence > this.#latestSequence) {
      return { events: [], resetRequired: true };
    }

    const oldest = this.#events[0]?.seq;
    if (oldest !== undefined && lastSequence < oldest - 1) {
      return { events: [], resetRequired: true };
    }
    return {
      events: this.#events.filter((event) => event.seq > lastSequence),
      resetRequired: false,
    };
  }

  createResetEvent(): RemoteEvent<{
    latestSequence: number;
    oldestAvailableSequence: number;
    reason: "events-expired";
  }> {
    return {
      emittedAt: this.#clock().toISOString(),
      payload: {
        latestSequence: this.#latestSequence,
        oldestAvailableSequence: this.#events[0]?.seq ?? this.#latestSequence,
        reason: "events-expired",
      },
      schemaVersion: API_SCHEMA_VERSION,
      seq: this.#latestSequence,
      type: "connection.reset",
    };
  }

  subscribe(subscriber: (event: RemoteEvent) => void): () => void {
    this.#subscribers.add(subscriber);
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }
}
