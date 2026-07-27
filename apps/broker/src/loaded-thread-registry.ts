const DEFAULT_MAX_TRANSIENT_THREADS = 2_048;

export interface LoadedThreadRegistryOptions {
  maxTransientThreads?: number;
}

interface PendingDiscovery {
  readonly awaitingRefreshAfter: Map<number, number>;
}

/**
 * Tracks the authoritative per-connection loaded snapshots plus two bounded
 * fallbacks for races that happen before those snapshots converge.
 */
export class LoadedThreadRegistry {
  readonly #byConnection = new Map<number, Set<string>>();
  readonly #inFlight = new Set<string>();
  readonly #lastAppliedRefresh = new Map<number, number>();
  readonly #maxTransientThreads: number;
  readonly #pendingDiscovery = new Map<string, PendingDiscovery>();
  readonly #refreshGeneration = new Map<number, number>();
  readonly #transientOrder = new Map<string, true>();

  constructor(options: LoadedThreadRegistryOptions = {}) {
    this.#maxTransientThreads = options.maxTransientThreads ?? DEFAULT_MAX_TRANSIENT_THREADS;
    if (!Number.isSafeInteger(this.#maxTransientThreads) || this.#maxTransientThreads < 1) {
      throw new TypeError("maxTransientThreads must be a positive integer");
    }
  }

  beginConnectionRefresh(connectionId: number): number {
    const generation = (this.#refreshGeneration.get(connectionId) ?? 0) + 1;
    this.#refreshGeneration.set(connectionId, generation);
    return generation;
  }

  replaceConnection(
    connectionId: number,
    threadIds: Iterable<string>,
    refreshGeneration = this.beginConnectionRefresh(connectionId),
  ): void {
    const latestStarted = this.#refreshGeneration.get(connectionId) ?? 0;
    if (
      !Number.isSafeInteger(refreshGeneration) ||
      refreshGeneration < 1 ||
      refreshGeneration > latestStarted ||
      refreshGeneration <= (this.#lastAppliedRefresh.get(connectionId) ?? 0)
    ) {
      return;
    }
    const normalized = new Set<string>();
    for (const threadId of threadIds) {
      if (isThreadId(threadId)) {
        normalized.add(threadId);
      }
    }
    this.#byConnection.set(connectionId, normalized);
    this.#lastAppliedRefresh.set(connectionId, refreshGeneration);

    for (const [threadId, pending] of this.#pendingDiscovery) {
      const mustRefreshAfter = pending.awaitingRefreshAfter.get(connectionId);
      if (mustRefreshAfter === undefined || refreshGeneration <= mustRefreshAfter) {
        continue;
      }
      pending.awaitingRefreshAfter.delete(connectionId);
      if (normalized.has(threadId)) {
        this.#pendingDiscovery.delete(threadId);
        this.#forgetTransientOrderIfUnused(threadId);
        continue;
      }
      if (pending.awaitingRefreshAfter.size === 0) {
        this.#pendingDiscovery.delete(threadId);
        this.#forgetTransientOrderIfUnused(threadId);
      }
    }
  }

  remember(threadId: string, connectionIds: Iterable<number> = this.#byConnection.keys()): void {
    if (!isThreadId(threadId)) {
      return;
    }
    const existing = this.#pendingDiscovery.get(threadId);
    const awaitingRefreshAfter = existing?.awaitingRefreshAfter ?? new Map<number, number>();
    for (const connectionId of connectionIds) {
      if (Number.isSafeInteger(connectionId) && connectionId > 0) {
        awaitingRefreshAfter.set(connectionId, this.#refreshGeneration.get(connectionId) ?? 0);
      }
    }
    this.#pendingDiscovery.set(threadId, { awaitingRefreshAfter });
    this.#touchTransient(threadId);
  }

  markInFlight(threadId: string): void {
    if (!isThreadId(threadId)) {
      return;
    }
    this.#inFlight.add(threadId);
    this.#touchTransient(threadId);
  }

  markIdle(threadId: string): void {
    if (!isThreadId(threadId)) {
      return;
    }
    this.#inFlight.delete(threadId);
    this.#forgetTransientOrderIfUnused(threadId);
  }

  markTerminal(threadId: string): void {
    if (!isThreadId(threadId)) {
      return;
    }
    this.#inFlight.delete(threadId);
    this.#pendingDiscovery.delete(threadId);
    this.#forgetTransientOrderIfUnused(threadId);
  }

  removeConnection(connectionId: number): void {
    this.#byConnection.delete(connectionId);
    this.#lastAppliedRefresh.delete(connectionId);
    this.#refreshGeneration.delete(connectionId);
    for (const [threadId, pending] of this.#pendingDiscovery) {
      if (
        pending.awaitingRefreshAfter.delete(connectionId) &&
        pending.awaitingRefreshAfter.size === 0
      ) {
        this.#pendingDiscovery.delete(threadId);
        this.#forgetTransientOrderIfUnused(threadId);
      }
    }
  }

  union(): string[] {
    const result = new Set<string>([...this.#pendingDiscovery.keys(), ...this.#inFlight]);
    for (const threadIds of this.#byConnection.values()) {
      for (const threadId of threadIds) {
        result.add(threadId);
      }
    }
    return [...result].sort(compareThreadIds);
  }

  clear(): void {
    this.#byConnection.clear();
    this.#inFlight.clear();
    this.#lastAppliedRefresh.clear();
    this.#pendingDiscovery.clear();
    this.#refreshGeneration.clear();
    this.#transientOrder.clear();
  }

  #touchTransient(threadId: string): void {
    this.#transientOrder.delete(threadId);
    this.#transientOrder.set(threadId, true);
    while (this.#transientCount() > this.#maxTransientThreads) {
      const oldest = this.#transientOrder.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.#transientOrder.delete(oldest);
      this.#pendingDiscovery.delete(oldest);
      this.#inFlight.delete(oldest);
    }
  }

  #transientCount(): number {
    return new Set([...this.#pendingDiscovery.keys(), ...this.#inFlight]).size;
  }

  #forgetTransientOrderIfUnused(threadId: string): void {
    if (!this.#pendingDiscovery.has(threadId) && !this.#inFlight.has(threadId)) {
      this.#transientOrder.delete(threadId);
    }
  }
}

function compareThreadIds(left: string, right: string): number {
  return left.localeCompare(right, "en-US");
}

function isThreadId(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 512
  );
}
