import { performance } from "node:perf_hooks";

import { LoadedThreadRegistry } from "./loaded-thread-registry.js";
import {
  ThreadLifecycleArbiter,
  TurnStartConflictError,
  type AuthoritativeThreadState,
  type ThreadArchiveReservation,
  type TurnStartReservation,
} from "./thread-lifecycle.js";

export const BROKER_HIDDEN_ID_PREFIX = "__codex_local_remote_broker__:";

type RpcId = string | number;
export type ClientRole = "desktop" | "sidecar" | "unknown";

export interface BrokerWire {
  close(code: number, reason: string): void;
  send(frame: string): void;
}

export interface BrokerPair {
  readonly id: number;
  close(): void;
  receiveDownstream(frame: string): Promise<void>;
  receiveUpstream(frame: string): Promise<void>;
}

export interface BrokerCoordinatorOptions {
  backfillRetryDelaysMs?: number[];
  hiddenRequestTimeoutMs?: number;
  maxBackfillConcurrency?: number;
  maxFrameBytes?: number;
  resumeRetryDelaysMs?: number[];
  sleep?: (delayMs: number) => Promise<void>;
  unsafeRevalidationMinIntervalMs?: number;
}

export interface BrokerCoordinatorSnapshot {
  degraded: boolean;
  desktopConnected: boolean;
  desktopConnectionCount: number;
  desktopLaunchNonceDigests: string[];
  sidecarConnected: boolean;
  unknownCount: number;
}

interface AttachPairOptions {
  desktopLaunchNonceDigest?: string;
  downstream: BrokerWire;
  upstream: BrokerWire;
}

interface HiddenPending {
  method: string;
  reject(error: Error): void;
  resolve(result: unknown): void;
  timer: NodeJS.Timeout;
}

interface LoadedThreadPagination {
  afterThreadId?: string;
  limit: number;
  requestCursor?: string;
}

class HiddenRpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "HiddenRpcError";
    this.code = code;
  }
}

class SubscriptionBarrierError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "SubscriptionBarrierError";
    this.code = code;
  }
}

class LoadedThreadPaginationError extends Error {
  constructor() {
    super("Invalid loaded-thread pagination");
    this.name = "LoadedThreadPaginationError";
  }
}

class LoadedThreadConvergenceError extends Error {
  readonly failedConnectionIds: ReadonlySet<number>;

  constructor(failedConnectionIds: Iterable<number>) {
    super("Loaded thread convergence failed");
    this.name = "LoadedThreadConvergenceError";
    this.failedConnectionIds = new Set(failedConnectionIds);
  }
}

const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_HIDDEN_TIMEOUT_MS = 10_000;
const DEFAULT_BACKFILL_RETRY_DELAYS_MS = [250, 1_000, 5_000];
const DEFAULT_MAX_BACKFILL_CONCURRENCY = 16;
const DEFAULT_RESUME_RETRY_DELAYS_MS = [20, 50, 100, 250, 500, 1_000];
const DEFAULT_UNSAFE_REVALIDATION_MIN_INTERVAL_MS = 15_000;
const DEFAULT_THREAD_TITLE = "New Codex task";
const DEFAULT_LOADED_THREAD_PAGE_LIMIT = 100;
const LOADED_THREAD_CURSOR_PREFIX = "clr-loaded-v1.";
const MAX_LOADED_THREAD_CURSOR_LENGTH = 8_192;
const MAX_LOADED_THREAD_PAGE_LIMIT = 200;
const MAX_LOADED_THREAD_PAGES = 20;
const MAX_LOADED_THREADS_PER_CONNECTION = MAX_LOADED_THREAD_PAGE_LIMIT * MAX_LOADED_THREAD_PAGES;
const MAX_ARCHIVE_STABILITY_ATTEMPTS = 8;
const MAX_THREAD_TITLE_CODE_POINTS = 80;
const DESKTOP_LAUNCH_NONCE_DIGEST = /^[0-9a-f]{64}$/u;

export class BrokerCoordinator {
  readonly #archivedThreadIds = new Set<string>();
  readonly #archivedThreadTrees = new Map<string, Set<string>>();
  readonly #backfillRetryDelaysMs: number[];
  readonly #backfillInFlight = new Set<number>();
  readonly #connections = new Map<number, BrokerPairConnection>();
  readonly #creatorByThread = new Map<string, BrokerPairConnection>();
  readonly #degradedBackfills = new Set<number>();
  readonly #freshThreadIds = new Set<string>();
  readonly #hiddenRequestTimeoutMs: number;
  readonly #lifecycle = new ThreadLifecycleArbiter();
  readonly #loadedRefreshes = new Map<number, Promise<string[]>>();
  readonly #loadedThreads = new LoadedThreadRegistry();
  readonly #maxBackfillConcurrency: number;
  readonly #maxFrameBytes: number;
  readonly #namedThreadIds = new Set<string>();
  readonly #resumeRetryDelaysMs: number[];
  readonly #sleep: (delayMs: number) => Promise<void>;
  readonly #threadParents = new Map<string, string | undefined>();
  readonly #unsafeRevalidationMinIntervalMs: number;
  #nextConnectionId = 1;
  #convergenceInFlight: Promise<void> | undefined;
  #convergenceRequested = false;
  #lastUnsafeRevalidationAtMs = Number.NEGATIVE_INFINITY;
  #stopped = false;
  #unsafeRevalidationInFlight: Promise<void> | undefined;

  constructor(options: BrokerCoordinatorOptions = {}) {
    this.#backfillRetryDelaysMs = [
      ...(options.backfillRetryDelaysMs ?? DEFAULT_BACKFILL_RETRY_DELAYS_MS),
    ];
    this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.#maxBackfillConcurrency =
      options.maxBackfillConcurrency ?? DEFAULT_MAX_BACKFILL_CONCURRENCY;
    this.#hiddenRequestTimeoutMs = options.hiddenRequestTimeoutMs ?? DEFAULT_HIDDEN_TIMEOUT_MS;
    this.#resumeRetryDelaysMs = [
      ...(options.resumeRetryDelaysMs ?? DEFAULT_RESUME_RETRY_DELAYS_MS),
    ];
    this.#sleep = options.sleep ?? sleep;
    this.#unsafeRevalidationMinIntervalMs =
      options.unsafeRevalidationMinIntervalMs ?? DEFAULT_UNSAFE_REVALIDATION_MIN_INTERVAL_MS;
    assertPositiveInteger(this.#maxFrameBytes, "maxFrameBytes");
    assertPositiveInteger(this.#maxBackfillConcurrency, "maxBackfillConcurrency");
    assertPositiveInteger(this.#hiddenRequestTimeoutMs, "hiddenRequestTimeoutMs");
    assertRetryDelays(this.#backfillRetryDelaysMs, "backfillRetryDelaysMs");
    assertRetryDelays(this.#resumeRetryDelaysMs, "resumeRetryDelaysMs");
    assertNonNegativeInteger(
      this.#unsafeRevalidationMinIntervalMs,
      "unsafeRevalidationMinIntervalMs",
    );
  }

  attach(options: AttachPairOptions): BrokerPair {
    if (this.#stopped) {
      throw new Error("Broker coordinator 已停止");
    }
    const connection = new BrokerPairConnection(
      this,
      this.#nextConnectionId++,
      options,
      this.#maxFrameBytes,
      this.#hiddenRequestTimeoutMs,
    );
    this.#connections.set(connection.id, connection);
    return connection;
  }

  snapshot(): BrokerCoordinatorSnapshot {
    const active = [...this.#connections.values()].filter((connection) => !connection.closed);
    const desktopConnections = active.filter(
      (connection) => connection.initialized && connection.role === "desktop",
    );
    return {
      degraded: this.#degradedBackfills.size > 0,
      desktopConnected: desktopConnections.length > 0,
      desktopConnectionCount: desktopConnections.length,
      desktopLaunchNonceDigests: desktopConnections
        .flatMap((connection) =>
          connection.desktopLaunchNonceDigest === undefined
            ? []
            : [connection.desktopLaunchNonceDigest],
        )
        .sort(),
      sidecarConnected: active.some(
        (connection) => connection.initialized && connection.role === "sidecar",
      ),
      unknownCount: active.filter(
        (connection) => !connection.initialized || connection.role === "unknown",
      ).length,
    };
  }

  unsafeThreadCount(): number {
    return this.#lifecycle.unsafeThreadCount();
  }

  revalidateUnsafeThreads(): Promise<void> {
    if (this.#stopped || this.#unsafeRevalidationInFlight) {
      return this.#unsafeRevalidationInFlight ?? Promise.resolve();
    }
    const unsafeThreadIds = this.#lifecycle.unsafeThreadIds();
    if (unsafeThreadIds.length === 0) {
      return Promise.resolve();
    }
    const now = performance.now();
    if (now - this.#lastUnsafeRevalidationAtMs < this.#unsafeRevalidationMinIntervalMs) {
      return Promise.resolve();
    }
    const connections = this.#initializedConnections();
    const source =
      connections.find((connection) => connection.role === "desktop") ?? connections[0];
    if (!source) {
      return Promise.resolve();
    }
    this.#lastUnsafeRevalidationAtMs = now;
    let nextIndex = 0;
    const run = Promise.all(
      Array.from(
        { length: Math.min(this.#maxBackfillConcurrency, unsafeThreadIds.length) },
        async () => {
          for (;;) {
            const threadId = unsafeThreadIds[nextIndex++];
            if (threadId === undefined) return;
            try {
              await source.inspectThreadState(threadId);
            } catch {
              // A failed or racing read remains unsafe and is retried by a later probe.
            }
          }
        },
      ),
    ).then(() => undefined);
    const tracked = run.finally(() => {
      if (this.#unsafeRevalidationInFlight === tracked) {
        this.#unsafeRevalidationInFlight = undefined;
      }
    });
    this.#unsafeRevalidationInFlight = tracked;
    return tracked;
  }

  stop(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    for (const connection of [...this.#connections.values()]) {
      connection.close();
    }
    this.#connections.clear();
    this.#archivedThreadIds.clear();
    this.#archivedThreadTrees.clear();
    this.#backfillInFlight.clear();
    this.#convergenceRequested = false;
    this.#creatorByThread.clear();
    this.#degradedBackfills.clear();
    this.#freshThreadIds.clear();
    this.#lifecycle.clear();
    this.#loadedRefreshes.clear();
    this.#loadedThreads.clear();
    this.#namedThreadIds.clear();
    this.#threadParents.clear();
  }

  connectionClosed(connection: BrokerPairConnection): void {
    this.#connections.delete(connection.id);
    this.#backfillInFlight.delete(connection.id);
    this.#degradedBackfills.delete(connection.id);
    this.#lifecycle.connectionClosed(connection.id);
    this.#loadedRefreshes.delete(connection.id);
    this.#loadedThreads.removeConnection(connection.id);
    for (const [threadId, creator] of this.#creatorByThread) {
      if (creator === connection) {
        this.#creatorByThread.delete(threadId);
        this.#freshThreadIds.delete(threadId);
      }
    }
  }

  connectionInitialized(connection: BrokerPairConnection): void {
    if (connection.role === "unknown") {
      return;
    }
    void this.#runBackfill(connection);
    for (const connectionId of [...this.#degradedBackfills]) {
      const degraded = this.#connections.get(connectionId);
      if (degraded && degraded !== connection) {
        void this.#runBackfill(degraded);
      }
    }
  }

  canSidecarCreateThread(): boolean {
    return [...this.#connections.values()].some(
      (connection) => connection.initialized && connection.role === "desktop" && !connection.closed,
    );
  }

  observeThreadStarted(
    threadId: string,
    explicitCreator?: BrokerPairConnection,
    fresh = false,
    value?: unknown,
  ): void {
    if (this.#archivedThreadIds.has(threadId) && !fresh) {
      return;
    }
    if (value !== undefined) {
      this.#rememberThreadLineage(threadId, value);
    }
    if (fresh) {
      this.#archivedThreadIds.delete(threadId);
    }
    this.#loadedThreads.remember(
      threadId,
      this.#initializedConnections().map((connection) => connection.id),
    );
    if (fresh) {
      this.#lifecycle.observeStatus(threadId, "idle");
      this.#threadParents.set(threadId, undefined);
    }
    const creator =
      explicitCreator ?? this.#creatorByThread.get(threadId) ?? this.#inferOnlyPendingCreator();
    if (creator) {
      this.#creatorByThread.set(threadId, creator);
      creator.markSubscribed(threadId);
      if (fresh) {
        this.#freshThreadIds.add(threadId);
      }
    }

    for (const connection of this.#initializedConnections()) {
      if (connection !== creator) {
        void connection.resumeThread(threadId, this.#resumeRetryDelaysMs, this.#sleep).catch(() => {
          // turn/start observes the same in-flight result and fails closed.
        });
      }
    }
  }

  observeThreadNamed(threadId: string): void {
    this.#namedThreadIds.add(threadId);
  }

  captureThreadLifecycleRevision(threadId: string): number {
    return this.#lifecycle.revision(threadId);
  }

  observeThreadSnapshot(threadId: string, value: unknown, expectedRevision?: number): void {
    if (this.#archivedThreadIds.has(threadId)) {
      return;
    }
    this.#rememberThreadLineage(threadId, value);
    const state = extractAuthoritativeThreadState(value);
    const applied =
      expectedRevision === undefined
        ? (this.#lifecycle.observeStatus(threadId, state), true)
        : this.#lifecycle.observeStatusAtRevision(threadId, state, expectedRevision);
    if (!applied) {
      return;
    }
    if (state === "active") {
      this.#loadedThreads.markInFlight(threadId);
    } else if (state === "idle") {
      this.#loadedThreads.markIdle(threadId);
    }
  }

  observeTurnStarted(threadId: string, turnId: string, source?: BrokerPairConnection): void {
    if (this.#archivedThreadIds.has(threadId)) {
      return;
    }
    source?.markSubscribed(threadId);
    this.#lifecycle.observeStarted(threadId, turnId);
    if (this.#lifecycle.snapshot(threadId)?.phase === "active") {
      this.#loadedThreads.markInFlight(threadId);
    } else {
      this.#loadedThreads.markTerminal(threadId);
    }
    const creator = this.#creatorByThread.get(threadId);
    for (const connection of this.#initializedConnections()) {
      if (connection === source || connection === creator) {
        continue;
      }
      void connection
        .resumeThread(threadId, this.#resumeRetryDelaysMs, this.#sleep)
        .catch(() => void this.#runBackfill(connection));
    }
  }

  observeTurnCompleted(threadId: string, turnId: string): void {
    if (this.#archivedThreadIds.has(threadId)) {
      return;
    }
    this.#lifecycle.complete(threadId, turnId);
    if (this.#lifecycle.snapshot(threadId)?.phase === "active") {
      this.#loadedThreads.markInFlight(threadId);
    } else {
      this.#loadedThreads.markTerminal(threadId);
    }
  }

  observeThreadStatus(threadId: string, value: unknown): void {
    if (this.#archivedThreadIds.has(threadId)) {
      return;
    }
    this.#rememberThreadLineage(threadId, value);
    const state = extractAuthoritativeThreadState(value);
    this.#lifecycle.observeStatus(threadId, state);
    if (state === "active") {
      this.#loadedThreads.markInFlight(threadId);
    } else if (state === "idle") {
      this.#loadedThreads.markTerminal(threadId);
    }
  }

  async reserveTurnStart(
    source: BrokerPairConnection,
    threadId: string,
  ): Promise<TurnStartReservation> {
    await this.#hydrateLineageForArchiveConflict(source, threadId);
    this.assertTurnStartAllowed(threadId);
    const reservation = await this.#lifecycle.reserve(threadId, source.id, async () => {
      const state = await source.inspectThreadState(threadId);
      this.assertTurnStartAllowed(threadId);
      return state;
    });
    try {
      await this.#hydrateLineageForArchiveConflict(source, threadId);
      this.assertTurnStartAllowed(threadId);
      this.#loadedThreads.markInFlight(threadId);
      return reservation;
    } catch (error) {
      this.#lifecycle.release(reservation);
      throw error;
    }
  }

  assertTurnStartAllowed(threadId: string): void {
    if (this.#archivedThreadIds.has(threadId)) {
      throw new TurnStartConflictError("Thread is archived");
    }
    this.#lifecycle.assertNotArchiving(threadId);
    const rootThreadId = this.#knownRootThreadId(threadId);
    if (rootThreadId !== undefined && rootThreadId !== threadId) {
      this.#lifecycle.assertNotArchiving(rootThreadId);
    }
  }

  async reserveThreadArchive(
    source: BrokerPairConnection,
    threadId: string,
  ): Promise<ThreadArchiveReservation> {
    const knownRootThreadId = this.#knownRootThreadId(threadId);
    if (knownRootThreadId !== undefined && knownRootThreadId !== threadId) {
      throw new TurnStartConflictError("Only top-level threads can be archived");
    }
    const reservation = this.#lifecycle.reserveArchive(
      threadId,
      this.#knownThreadTree(threadId),
      source.id,
    );
    const inspected = new Set<string>();
    const inspectedStates = new Map<string, AuthoritativeThreadState | "no-rollout">();
    let stabilized = false;
    try {
      for (let attempt = 0; attempt < MAX_ARCHIVE_STABILITY_ATTEMPTS; attempt += 1) {
        const loadedRevision = this.#loadedThreads.revision();
        const unresolvedLoadedThreadIds = this.#loadedThreads
          .union()
          .filter(
            (candidate) =>
              !this.#archivedThreadIds.has(candidate) &&
              !this.#threadParents.has(candidate) &&
              !inspected.has(candidate),
          );
        if (unresolvedLoadedThreadIds.length > MAX_LOADED_THREADS_PER_CONNECTION * 2) {
          throw new TurnStartConflictError("Loaded thread lineage exceeds the safety limit");
        }
        for (
          let offset = 0;
          offset < unresolvedLoadedThreadIds.length;
          offset += this.#maxBackfillConcurrency
        ) {
          const batch = unresolvedLoadedThreadIds.slice(
            offset,
            offset + this.#maxBackfillConcurrency,
          );
          await Promise.all(
            batch.map(async (candidate) => {
              try {
                inspectedStates.set(candidate, await source.inspectThreadState(candidate));
              } catch (error) {
                if (!isNoRolloutFoundError(error)) {
                  throw error;
                }
                inspectedStates.set(candidate, "no-rollout");
              } finally {
                inspected.add(candidate);
              }
            }),
          );
        }
        const tree = this.#knownThreadTree(threadId);
        this.#lifecycle.extendArchive(reservation, tree);
        for (const candidate of tree) {
          const observed = inspectedStates.get(candidate);
          if (observed === "active" || observed === "unknown") {
            throw new TurnStartConflictError(
              observed === "active"
                ? "Thread already has an active turn"
                : "Thread idle state could not be confirmed",
            );
          }
        }
        const candidates = tree.filter((candidate) => {
          if (inspected.has(candidate)) {
            return false;
          }
          return candidate === threadId || this.#lifecycle.snapshot(candidate)?.phase !== "idle";
        });
        if (candidates.length === 0) {
          const hasNewUnresolvedThread = this.#loadedThreads
            .union()
            .some(
              (candidate) =>
                !this.#archivedThreadIds.has(candidate) &&
                !this.#threadParents.has(candidate) &&
                !inspected.has(candidate),
            );
          if (this.#loadedThreads.revision() !== loadedRevision || hasNewUnresolvedThread) {
            continue;
          }
          stabilized = true;
          break;
        }
        for (const candidate of candidates) {
          let state: AuthoritativeThreadState;
          try {
            state = await source.inspectThreadState(candidate);
          } catch (error) {
            if (isNoRolloutFoundError(error)) {
              inspected.add(candidate);
              inspectedStates.set(candidate, "no-rollout");
              continue;
            }
            throw error;
          }
          inspected.add(candidate);
          inspectedStates.set(candidate, state);
          if (state !== "idle") {
            throw new TurnStartConflictError(
              state === "active"
                ? "Thread already has an active turn"
                : "Thread idle state could not be confirmed",
            );
          }
        }
        const observedRootThreadId = this.#knownRootThreadId(threadId);
        if (observedRootThreadId !== undefined && observedRootThreadId !== threadId) {
          throw new TurnStartConflictError("Only top-level threads can be archived");
        }
      }
      if (!stabilized) {
        throw new TurnStartConflictError("Loaded thread inventory did not stabilize");
      }
      if (!this.#lifecycle.ownsArchive(reservation)) {
        throw new TurnStartConflictError("Thread archive reservation is no longer active");
      }
      return reservation;
    } catch (error) {
      this.#lifecycle.releaseArchive(reservation);
      throw error;
    }
  }

  releaseThreadArchive(reservation: ThreadArchiveReservation): void {
    this.#lifecycle.releaseArchive(reservation);
  }

  observeThreadArchived(rootThreadId: string): void {
    const threadIds = [
      ...new Set([
        ...(this.#archivedThreadTrees.get(rootThreadId) ?? []),
        ...this.#knownThreadTree(rootThreadId),
      ]),
    ];
    this.#archivedThreadTrees.set(rootThreadId, new Set(threadIds));
    for (const threadId of threadIds) {
      this.#archivedThreadIds.add(threadId);
      this.#creatorByThread.delete(threadId);
      this.#freshThreadIds.delete(threadId);
      this.#namedThreadIds.delete(threadId);
    }
    this.#loadedThreads.forget(threadIds);
    this.#lifecycle.forget(threadIds);
    for (const connection of this.#connections.values()) {
      connection.forgetThreads(threadIds);
    }
    for (const threadId of threadIds) {
      this.#threadParents.delete(threadId);
    }
  }

  observeThreadUnarchived(threadId: string): void {
    this.#archivedThreadIds.delete(threadId);
    for (const [rootThreadId, threadIds] of this.#archivedThreadTrees) {
      threadIds.delete(threadId);
      if (threadIds.size === 0) {
        this.#archivedThreadTrees.delete(rootThreadId);
      }
    }
  }

  isThreadArchived(threadId: string): boolean {
    return this.#archivedThreadIds.has(threadId);
  }

  activateTurnStart(reservation: TurnStartReservation, turnId: string): void {
    this.#lifecycle.activate(reservation, turnId);
    if (this.#lifecycle.snapshot(reservation.threadId)?.phase === "active") {
      this.#loadedThreads.markInFlight(reservation.threadId);
    } else {
      this.#loadedThreads.markTerminal(reservation.threadId);
    }
  }

  releaseTurnStart(reservation: TurnStartReservation): void {
    this.#lifecycle.release(reservation);
    if (this.#lifecycle.snapshot(reservation.threadId)?.phase === "idle") {
      this.#loadedThreads.markIdle(reservation.threadId);
    }
  }

  markTurnStartUnknown(reservation: TurnStartReservation): void {
    this.#lifecycle.markUnknown(reservation);
  }

  async #hydrateLineageForArchiveConflict(
    source: BrokerPairConnection,
    threadId: string,
  ): Promise<void> {
    if (!this.#lifecycle.hasArchiveReservations() || this.#threadParents.has(threadId)) {
      return;
    }
    await source.inspectThreadState(threadId);
  }

  #knownRootThreadId(threadId: string): string | undefined {
    let current = threadId;
    const visited = new Set<string>();
    for (;;) {
      if (visited.has(current) || !this.#threadParents.has(current)) {
        return undefined;
      }
      visited.add(current);
      const parent = this.#threadParents.get(current);
      if (parent === undefined) {
        return current;
      }
      current = parent;
    }
  }

  #knownThreadTree(rootThreadId: string): string[] {
    const result = new Set<string>([rootThreadId]);
    for (const threadId of this.#threadParents.keys()) {
      if (this.#knownRootThreadId(threadId) === rootThreadId) {
        result.add(threadId);
      }
    }
    return [...result];
  }

  #rememberThreadLineage(threadId: string, value: unknown): void {
    const outer = asRecord(value);
    const nested = asRecord(outer.thread);
    const thread = Object.keys(nested).length > 0 ? nested : outer;
    const observedThreadId = extractThreadId(value) ?? threadId;
    if (!isThreadId(observedThreadId) || !Object.hasOwn(thread, "parentThreadId")) {
      return;
    }
    const parentThreadId = thread.parentThreadId;
    if (parentThreadId === null) {
      this.#threadParents.set(observedThreadId, undefined);
    } else if (isThreadId(parentThreadId) && parentThreadId !== observedThreadId) {
      this.#threadParents.set(observedThreadId, parentThreadId);
    }
  }

  async listLoadedUnion(): Promise<string[]> {
    const connections = this.#initializedConnections();
    await Promise.allSettled(
      connections.map(async (connection) => await this.#refreshLoadedThreads(connection)),
    );
    await this.#convergeLoadedThreads();
    return this.#loadedThreads.union();
  }

  async awaitTurnBarrier(
    source: BrokerPairConnection,
    threadId: string,
    derivedTitle: string,
  ): Promise<void> {
    if (!source.initialized || !source.role) {
      throw new SubscriptionBarrierError(-32_090, "Client is not initialized");
    }
    const targets = this.#initializedConnections().filter((connection) => connection !== source);
    if (source.role === "sidecar" && !targets.some((connection) => connection.role === "desktop")) {
      throw new SubscriptionBarrierError(-32_091, "Codex Desktop is not connected");
    }

    const ownsFreshShell =
      this.#freshThreadIds.has(threadId) && this.#creatorByThread.get(threadId) === source;
    this.#creatorByThread.set(threadId, source);
    source.markSubscribed(threadId);
    let failures = await this.#resumeTargets(targets, threadId);
    const mayPersistFreshShell =
      failures.length > 0 && failures.every(isNoRolloutFoundError) && ownsFreshShell;
    if (mayPersistFreshShell) {
      try {
        if (!this.#namedThreadIds.has(threadId)) {
          await source.persistThreadName(threadId, derivedTitle);
          this.#namedThreadIds.add(threadId);
        }
        failures = await this.#resumeTargets(targets, threadId);
      } catch (error) {
        failures = [error];
      }
    }
    const targetClosed = targets.some((target) => target.closed);
    const desktopFreshTurnMustFailOpen =
      ownsFreshShell && source.role === "desktop" && (failures.length > 0 || targetClosed);
    if (desktopFreshTurnMustFailOpen) {
      // A native Desktop first turn is the persistence barrier for some Codex
      // builds. Blocking that turn on a sidecar resume creates a deadlock:
      // there is no rollout to resume until the held turn starts. Let Desktop
      // run, then observeTurnStarted immediately retries peer subscription.
      this.#freshThreadIds.delete(threadId);
      return;
    }
    if (failures.length > 0) {
      throw new SubscriptionBarrierError(-32_092, "Thread subscription barrier failed");
    }
    if (targetClosed) {
      throw new SubscriptionBarrierError(-32_092, "Thread subscription barrier failed");
    }
    this.#freshThreadIds.delete(threadId);
  }

  async awaitHistoryResumeBarrier(source: BrokerPairConnection, threadId: string): Promise<void> {
    if (!source.initialized || !source.role) {
      throw new SubscriptionBarrierError(-32_090, "Client is not initialized");
    }
    const targets = this.#initializedConnections().filter((connection) => connection !== source);
    if (source.role === "sidecar" && !targets.some((connection) => connection.role === "desktop")) {
      throw new SubscriptionBarrierError(-32_091, "Codex Desktop is not connected");
    }

    source.markSubscribed(threadId);
    this.#loadedThreads.remember(
      threadId,
      this.#initializedConnections().map((connection) => connection.id),
    );
    this.#creatorByThread.set(threadId, source);
    const failures = await this.#resumeTargets(targets, threadId);
    if (failures.length > 0 || targets.some((target) => target.closed)) {
      throw new SubscriptionBarrierError(-32_092, "Thread subscription barrier failed");
    }
  }

  #initializedConnections(): BrokerPairConnection[] {
    return [...this.#connections.values()].filter(
      (connection) => connection.initialized && !connection.closed,
    );
  }

  #inferOnlyPendingCreator(): BrokerPairConnection | undefined {
    const candidates = this.#initializedConnections().filter(
      (connection) => connection.hasPendingThreadStart,
    );
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  async #resumeTargets(targets: BrokerPairConnection[], threadId: string): Promise<unknown[]> {
    const results = await Promise.allSettled(
      targets.map(
        async (target) =>
          await target.resumeThread(threadId, this.#resumeRetryDelaysMs, this.#sleep),
      ),
    );
    const failures: unknown[] = [];
    for (const result of results) {
      if (result.status === "rejected") {
        failures.push(result.reason as unknown);
      }
    }
    return failures;
  }

  async #runBackfill(connection: BrokerPairConnection): Promise<void> {
    if (connection.closed || this.#backfillInFlight.has(connection.id)) {
      return;
    }
    this.#backfillInFlight.add(connection.id);
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await this.#refreshLoadedThreads(connection);
          await this.#convergeLoadedThreads();
          if (!connection.closed && this.#connections.get(connection.id) === connection) {
            this.#degradedBackfills.delete(connection.id);
          }
          return;
        } catch (error) {
          if (connection.closed || this.#connections.get(connection.id) !== connection) {
            return;
          }
          const retryDelay = this.#backfillRetryDelaysMs[attempt];
          if (retryDelay === undefined) {
            const failedConnectionIds =
              error instanceof LoadedThreadConvergenceError
                ? error.failedConnectionIds
                : new Set([connection.id]);
            for (const connectionId of failedConnectionIds) {
              const failedConnection = this.#connections.get(connectionId);
              if (failedConnection?.initialized && !failedConnection.closed) {
                this.#degradedBackfills.add(connectionId);
              }
            }
            return;
          }
          await this.#sleep(retryDelay);
        }
      }
    } finally {
      this.#backfillInFlight.delete(connection.id);
    }
  }

  #refreshLoadedThreads(connection: BrokerPairConnection): Promise<string[]> {
    const existing = this.#loadedRefreshes.get(connection.id);
    if (existing) {
      return existing;
    }
    const refreshGeneration = this.#loadedThreads.beginConnectionRefresh(connection.id);
    const refresh = connection
      .collectLoadedThreadIds()
      .then((threadIds) => {
        if (!connection.closed && this.#connections.get(connection.id) === connection) {
          const currentThreadIds = threadIds.filter(
            (threadId) => !this.#archivedThreadIds.has(threadId),
          );
          for (const threadId of currentThreadIds) {
            connection.markSubscribed(threadId);
          }
          this.#loadedThreads.replaceConnection(connection.id, currentThreadIds, refreshGeneration);
          return currentThreadIds;
        }
        return threadIds;
      })
      .finally(() => {
        if (this.#loadedRefreshes.get(connection.id) === refresh) {
          this.#loadedRefreshes.delete(connection.id);
        }
      });
    this.#loadedRefreshes.set(connection.id, refresh);
    return refresh;
  }

  #convergeLoadedThreads(): Promise<void> {
    this.#convergenceRequested = true;
    const existing = this.#convergenceInFlight;
    if (existing) {
      return existing;
    }

    const run = this.#drainLoadedThreadConvergence();
    const tracked = run.finally(async () => {
      if (this.#convergenceInFlight === tracked) {
        this.#convergenceInFlight = undefined;
      }
      if (this.#convergenceRequested && !this.#stopped) {
        await this.#convergeLoadedThreads();
      }
    });
    this.#convergenceInFlight = tracked;
    return tracked;
  }

  async #drainLoadedThreadConvergence(): Promise<void> {
    while (this.#convergenceRequested && !this.#stopped) {
      this.#convergenceRequested = false;
      await this.#convergeLoadedThreadSnapshot();
    }
  }

  async #convergeLoadedThreadSnapshot(): Promise<void> {
    const threadIds = this.#loadedThreads.union();
    const work = new Map<string, { connection: BrokerPairConnection; threadId: string }>();
    for (const connection of this.#initializedConnections()) {
      for (const threadId of threadIds) {
        work.set(`${connection.id}\0${threadId}`, { connection, threadId });
      }
    }

    const items = [...work.values()];
    let nextIndex = 0;
    const failedConnectionIds = new Set<number>();
    const workers = Array.from(
      { length: Math.min(this.#maxBackfillConcurrency, items.length) },
      async () => {
        for (;;) {
          const item = items[nextIndex++];
          if (!item) {
            return;
          }
          try {
            await item.connection.resumeThread(
              item.threadId,
              this.#resumeRetryDelaysMs,
              this.#sleep,
            );
          } catch {
            if (
              !item.connection.closed &&
              this.#connections.get(item.connection.id) === item.connection
            ) {
              failedConnectionIds.add(item.connection.id);
            }
          }
        }
      },
    );
    await Promise.all(workers);
    if (failedConnectionIds.size > 0) {
      throw new LoadedThreadConvergenceError(failedConnectionIds);
    }
  }
}

class BrokerPairConnection implements BrokerPair {
  readonly #coordinator: BrokerCoordinator;
  readonly #downstream: BrokerWire;
  readonly #hiddenPending = new Map<string, HiddenPending>();
  readonly #hiddenRequestTimeoutMs: number;
  readonly #inflightResumes = new Map<string, Promise<void>>();
  readonly #maxFrameBytes: number;
  readonly #pendingThreadStartIds = new Set<RpcId>();
  readonly #pendingThreadResumes = new Map<
    RpcId,
    { lifecycleRevision: number; threadId: string }
  >();
  readonly #pendingThreadArchives = new Map<RpcId, ThreadArchiveReservation>();
  readonly #pendingTurnStarts = new Map<RpcId, TurnStartReservation>();
  readonly #subscribedThreadIds = new Set<string>();
  readonly #upstream: BrokerWire;
  #downstreamChain: Promise<void> = Promise.resolve();
  #hiddenSequence = 1;
  #initializeAcknowledged = false;
  #initializeId: RpcId | undefined;
  #initializedNotificationSent = false;
  #roleCandidate: ClientRole | undefined;
  closed = false;
  readonly desktopLaunchNonceDigest: string | undefined;
  readonly id: number;
  initialized = false;
  role: ClientRole | undefined;

  constructor(
    coordinator: BrokerCoordinator,
    id: number,
    options: AttachPairOptions,
    maxFrameBytes: number,
    hiddenRequestTimeoutMs: number,
  ) {
    this.#coordinator = coordinator;
    this.desktopLaunchNonceDigest =
      options.desktopLaunchNonceDigest === undefined
        ? undefined
        : assertDesktopLaunchNonceDigest(options.desktopLaunchNonceDigest);
    this.id = id;
    this.#downstream = options.downstream;
    this.#upstream = options.upstream;
    this.#maxFrameBytes = maxFrameBytes;
    this.#hiddenRequestTimeoutMs = hiddenRequestTimeoutMs;
  }

  get hasPendingThreadStart(): boolean {
    return this.#pendingThreadStartIds.size > 0;
  }

  receiveDownstream(frame: string): Promise<void> {
    this.#downstreamChain = this.#downstreamChain
      .then(async () => {
        if (!this.closed) {
          await this.#handleDownstream(frame);
        }
      })
      .catch(() => {
        this.close();
      });
    return this.#downstreamChain;
  }

  receiveUpstream(frame: string): Promise<void> {
    this.#handleUpstream(frame);
    return Promise.resolve();
  }

  #handleUpstream(frame: string): void {
    if (this.closed) {
      return;
    }
    const message = this.#parseFrame(frame);
    if (!message) {
      return;
    }
    const id = rpcId(message.id);
    if (typeof id === "string") {
      const hidden = this.#hiddenPending.get(id);
      if (hidden) {
        this.#hiddenPending.delete(id);
        clearTimeout(hidden.timer);
        if ("error" in message) {
          const error = asRecord(message.error);
          hidden.reject(
            new HiddenRpcError(
              typeof error.code === "number" ? error.code : -32_000,
              typeof error.message === "string" ? error.message : `${hidden.method} failed`,
            ),
          );
        } else {
          hidden.resolve(message.result);
        }
        return;
      }
      if (id.startsWith(BROKER_HIDDEN_ID_PREFIX)) {
        this.#closeProtocol(1002, "unknown reserved broker id");
        return;
      }
    }

    if (id !== undefined && id === this.#initializeId) {
      this.#initializeId = undefined;
      this.#initializeAcknowledged = !("error" in message);
      this.#activateIfReady();
    }

    if (id !== undefined && this.#pendingThreadStartIds.delete(id)) {
      const threadId = extractThreadId(message.result);
      if (threadId) {
        this.#coordinator.observeThreadStarted(threadId, this, true);
      }
    }

    if (id !== undefined) {
      const pendingResume = this.#pendingThreadResumes.get(id);
      if (pendingResume) {
        this.#pendingThreadResumes.delete(id);
        if (!("error" in message)) {
          this.markSubscribed(pendingResume.threadId);
          this.#coordinator.observeThreadSnapshot(
            pendingResume.threadId,
            message.result,
            pendingResume.lifecycleRevision,
          );
        }
      }
    }

    if (id !== undefined) {
      const archiveReservation = this.#pendingThreadArchives.get(id);
      if (archiveReservation) {
        this.#pendingThreadArchives.delete(id);
        if ("error" in message) {
          this.#coordinator.releaseThreadArchive(archiveReservation);
        } else {
          this.#coordinator.observeThreadArchived(archiveReservation.rootThreadId);
        }
      }
    }

    if (id !== undefined) {
      const reservation = this.#pendingTurnStarts.get(id);
      if (reservation) {
        this.#pendingTurnStarts.delete(id);
        if ("error" in message) {
          this.#coordinator.releaseTurnStart(reservation);
        } else {
          const turnId = extractTurnId(message.result);
          if (turnId) {
            this.#coordinator.activateTurnStart(reservation, turnId);
          } else {
            this.#coordinator.markTurnStartUnknown(reservation);
          }
        }
      }
    }

    if (message.method === "thread/started") {
      const threadId = extractThreadId(message.params);
      if (threadId) {
        this.#coordinator.observeThreadStarted(threadId, undefined, false, message.params);
      }
    }
    if (message.method === "thread/archived") {
      const threadId = extractThreadId(message.params);
      if (threadId) {
        this.#coordinator.observeThreadArchived(threadId);
      }
    }
    if (message.method === "thread/unarchived") {
      const threadId = extractThreadId(message.params);
      if (threadId) {
        this.#coordinator.observeThreadUnarchived(threadId);
      }
    }
    if (message.method === "turn/started") {
      const threadId = extractThreadId(message.params);
      const turnId = extractTurnId(message.params);
      if (threadId && turnId) {
        this.#coordinator.observeTurnStarted(threadId, turnId, this);
      }
    }
    if (message.method === "turn/completed") {
      const threadId = extractThreadId(message.params);
      const turnId = extractTurnId(message.params);
      if (threadId && turnId) {
        this.markSubscribed(threadId);
        this.#coordinator.observeTurnCompleted(threadId, turnId);
      }
    }
    if (message.method === "thread/status/changed") {
      const threadId = extractThreadId(message.params);
      if (threadId) {
        this.markSubscribed(threadId);
        this.#coordinator.observeThreadStatus(threadId, message.params);
      }
    }
    this.#send(this.#downstream, frame);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const error = new Error("Broker connection closed");
    for (const [id, pending] of this.#hiddenPending) {
      this.#hiddenPending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#inflightResumes.clear();
    this.#pendingThreadResumes.clear();
    this.#coordinator.connectionClosed(this);
    safeClose(this.#downstream, 1001, "broker connection closed");
    safeClose(this.#upstream, 1001, "broker connection closed");
  }

  markSubscribed(threadId: string): void {
    if (!this.#coordinator.isThreadArchived(threadId)) {
      this.#subscribedThreadIds.add(threadId);
    }
  }

  forgetThreads(threadIds: Iterable<string>): void {
    const forgotten = new Set(threadIds);
    for (const threadId of forgotten) {
      this.#inflightResumes.delete(threadId);
      this.#subscribedThreadIds.delete(threadId);
    }
    for (const [id, pending] of this.#pendingThreadResumes) {
      if (forgotten.has(pending.threadId)) {
        this.#pendingThreadResumes.delete(id);
      }
    }
    for (const [id, pending] of this.#pendingTurnStarts) {
      if (forgotten.has(pending.threadId)) {
        this.#pendingTurnStarts.delete(id);
      }
    }
  }

  async persistThreadName(threadId: string, name: string): Promise<void> {
    await this.#sendHidden("thread/name/set", {
      name,
      threadId,
    });
  }

  resumeThread(
    threadId: string,
    retryDelaysMs: number[],
    sleepFor: (delayMs: number) => Promise<void>,
  ): Promise<void> {
    if (this.#coordinator.isThreadArchived(threadId)) {
      return Promise.resolve();
    }
    if (this.#subscribedThreadIds.has(threadId)) {
      return Promise.resolve();
    }
    const existing = this.#inflightResumes.get(threadId);
    if (existing) {
      return existing;
    }
    const resume = this.#resumeWithRetry(threadId, retryDelaysMs, sleepFor).finally(() => {
      this.#inflightResumes.delete(threadId);
    });
    this.#inflightResumes.set(threadId, resume);
    return resume;
  }

  async collectLoadedThreadIds(): Promise<string[]> {
    const loaded = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_LOADED_THREAD_PAGES; page += 1) {
      const result = asRecord(
        await this.#sendHidden("thread/loaded/list", {
          limit: MAX_LOADED_THREAD_PAGE_LIMIT,
          ...(cursor === null ? {} : { cursor }),
        }),
      );
      if (!Array.isArray(result.data) || result.data.length > MAX_LOADED_THREAD_PAGE_LIMIT) {
        throw new Error("thread/loaded/list returned an invalid page");
      }
      for (const threadId of extractLoadedThreadIds(result.data)) {
        loaded.add(threadId);
        if (loaded.size > MAX_LOADED_THREADS_PER_CONNECTION) {
          throw new Error("thread/loaded/list exceeded the loaded thread limit");
        }
      }
      const nextCursor = parseUpstreamLoadedThreadCursor(result.nextCursor);
      if (nextCursor === null || this.closed) {
        return [...loaded];
      }
      if (seenCursors.has(nextCursor)) {
        throw new Error("thread/loaded/list returned a repeated cursor");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new Error("thread/loaded/list exceeded the page limit");
  }

  async inspectThreadState(threadId: string): Promise<AuthoritativeThreadState> {
    const lifecycleRevision = this.#coordinator.captureThreadLifecycleRevision(threadId);
    const result = await this.#sendHidden("thread/read", {
      includeTurns: false,
      threadId,
    });
    const state = extractAuthoritativeThreadState(result);
    this.#coordinator.observeThreadSnapshot(threadId, result, lifecycleRevision);
    return state;
  }

  async #handleDownstream(frame: string): Promise<void> {
    const message = this.#parseFrame(frame);
    if (!message) {
      return;
    }
    const id = rpcId(message.id);
    if (typeof id === "string" && id.startsWith(BROKER_HIDDEN_ID_PREFIX)) {
      if (typeof message.method === "string") {
        this.#sendError(id, -32_600, "Reserved broker request id");
      } else {
        this.#closeProtocol(1002, "reserved broker response id");
      }
      return;
    }

    const requiredUnknownHandshake =
      this.#roleCandidate === "unknown" &&
      !this.initialized &&
      !this.#initializedNotificationSent &&
      message.method === "initialized";
    if (
      (this.#roleCandidate === "unknown" || this.role === "unknown") &&
      !requiredUnknownHandshake
    ) {
      if (id !== undefined && typeof message.method === "string") {
        this.#sendError(id, -32_093, "Unrecognized client is not authorized");
      } else {
        this.#closeProtocol(1008, "unrecognized client is not authorized");
      }
      return;
    }

    if (message.method === "initialize") {
      if (id === undefined) {
        this.#closeProtocol(1002, "initialize requires an id");
        return;
      }
      const roleCandidate = classifyClientRole(message.params);
      if (roleCandidate === "unknown") {
        this.#closeProtocol(1008, "unrecognized client is not authorized");
        return;
      }
      if (roleCandidate === "desktop" && this.desktopLaunchNonceDigest === undefined) {
        this.#closeProtocol(1008, "Codex Desktop launch identity is required");
        return;
      }
      this.#initializeId = id;
      this.#roleCandidate = roleCandidate;
      this.#send(this.#upstream, frame);
      return;
    }

    if (message.method === "initialized") {
      this.#initializedNotificationSent = true;
      this.#send(this.#upstream, frame);
      this.#activateIfReady();
      return;
    }

    if (message.method === "thread/start") {
      if (id === undefined) {
        this.#closeProtocol(1002, "thread/start requires an id");
        return;
      }
      if (!this.initialized || !this.role) {
        this.#sendError(id, -32_090, "Client is not initialized");
        return;
      }
      if (this.role === "sidecar" && !this.#coordinator.canSidecarCreateThread()) {
        this.#sendError(id, -32_091, "Codex Desktop is not connected");
        return;
      }
      this.#pendingThreadStartIds.add(id);
      this.#send(this.#upstream, frame);
      return;
    }

    if (message.method === "thread/resume" && this.role === "sidecar") {
      if (id === undefined) {
        this.#closeProtocol(1002, "thread/resume requires an id");
        return;
      }
      if (!this.initialized) {
        this.#sendError(id, -32_090, "Client is not initialized");
        return;
      }
      const threadId = extractThreadId(message.params);
      if (!threadId) {
        this.#sendError(id, -32_602, "thread/resume threadId is required");
        return;
      }
      if (!this.#coordinator.canSidecarCreateThread()) {
        this.#sendError(id, -32_091, "Codex Desktop is not connected");
        return;
      }
      try {
        const lifecycleRevision = this.#coordinator.captureThreadLifecycleRevision(threadId);
        const result = await this.#sendHidden("thread/resume", message.params);
        this.#coordinator.observeThreadSnapshot(threadId, result, lifecycleRevision);
        await this.#coordinator.awaitHistoryResumeBarrier(this, threadId);
        this.#send(this.#downstream, JSON.stringify({ id, result }));
      } catch (error) {
        const mapped =
          error instanceof HiddenRpcError || error instanceof SubscriptionBarrierError
            ? error
            : new SubscriptionBarrierError(-32_092, "Thread subscription barrier failed");
        this.#sendError(id, mapped.code, mapped.message);
      }
      return;
    }

    if (message.method === "thread/resume" && this.role === "desktop" && id !== undefined) {
      const threadId = extractThreadId(message.params);
      if (threadId) {
        this.#pendingThreadResumes.set(id, {
          lifecycleRevision: this.#coordinator.captureThreadLifecycleRevision(threadId),
          threadId,
        });
      }
    }

    if (message.method === "thread/name/set") {
      const threadId = extractThreadId(message.params);
      if (threadId) {
        this.#coordinator.observeThreadNamed(threadId);
      }
      this.#send(this.#upstream, frame);
      return;
    }

    if (message.method === "thread/archive") {
      if (id === undefined) {
        this.#closeProtocol(1002, "thread/archive requires an id");
        return;
      }
      if (!this.initialized || !this.role) {
        this.#sendError(id, -32_090, "Client is not initialized");
        return;
      }
      const threadId = extractThreadId(message.params);
      if (!threadId) {
        this.#sendError(id, -32_602, "thread/archive threadId is required");
        return;
      }
      try {
        const reservation = await this.#coordinator.reserveThreadArchive(this, threadId);
        if (!this.closed) {
          this.#pendingThreadArchives.set(id, reservation);
          this.#send(this.#upstream, frame);
        } else {
          this.#coordinator.releaseThreadArchive(reservation);
        }
      } catch (error) {
        const conflict =
          error instanceof TurnStartConflictError
            ? error
            : new TurnStartConflictError("Thread archive safety check failed");
        this.#sendError(id, conflict.code, conflict.message);
      }
      return;
    }

    if (message.method === "thread/loaded/list") {
      if (id === undefined) {
        this.#closeProtocol(1002, "thread/loaded/list requires an id");
        return;
      }
      if (!this.initialized || !this.role) {
        this.#sendError(id, -32_090, "Client is not initialized");
        return;
      }
      let pagination: LoadedThreadPagination;
      try {
        pagination = parseLoadedThreadPagination(message.params);
      } catch (error) {
        if (error instanceof LoadedThreadPaginationError) {
          this.#sendError(id, -32_602, error.message);
          return;
        }
        throw error;
      }
      try {
        const union = await this.#coordinator.listLoadedUnion();
        const { data, nextCursor } = paginateLoadedThreads(union, pagination);
        this.#send(
          this.#downstream,
          JSON.stringify({
            id,
            result: { data, nextCursor },
          }),
        );
      } catch {
        this.#sendError(id, -32_095, "Loaded thread convergence failed");
      }
      return;
    }

    if (message.method === "turn/start") {
      if (id === undefined) {
        this.#closeProtocol(1002, "turn/start requires an id");
        return;
      }
      if (!this.initialized || !this.role) {
        this.#sendError(id, -32_090, "Client is not initialized");
        return;
      }
      const threadId = extractThreadId(message.params);
      if (!threadId) {
        this.#sendError(id, -32_602, "turn/start threadId is required");
        return;
      }
      try {
        this.#coordinator.assertTurnStartAllowed(threadId);
        await this.#coordinator.awaitTurnBarrier(this, threadId, deriveThreadTitle(message.params));
        const reservation = await this.#coordinator.reserveTurnStart(this, threadId);
        if (!this.closed) {
          this.#pendingTurnStarts.set(id, reservation);
          this.#send(this.#upstream, frame);
        } else {
          this.#coordinator.releaseTurnStart(reservation);
        }
      } catch (error) {
        const barrier =
          error instanceof SubscriptionBarrierError
            ? error
            : error instanceof TurnStartConflictError
              ? new SubscriptionBarrierError(error.code, error.message)
              : new SubscriptionBarrierError(-32_092, "Thread subscription barrier failed");
        this.#sendError(id, barrier.code, barrier.message);
      }
      return;
    }

    this.#send(this.#upstream, frame);
  }

  #activateIfReady(): void {
    if (this.initialized || !this.#initializeAcknowledged || !this.#roleCandidate) {
      return;
    }
    this.initialized = true;
    this.role = this.#roleCandidate;
    if (this.role === "unknown") {
      this.#closeProtocol(1008, "unrecognized client is not authorized");
      return;
    }
    this.#coordinator.connectionInitialized(this);
  }

  async #resumeWithRetry(
    threadId: string,
    retryDelaysMs: number[],
    sleepFor: (delayMs: number) => Promise<void>,
  ): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      if (this.closed) {
        throw new Error("Broker connection closed");
      }
      try {
        const lifecycleRevision = this.#coordinator.captureThreadLifecycleRevision(threadId);
        const result = await this.#sendHidden("thread/resume", {
          excludeTurns: true,
          threadId,
        });
        this.#coordinator.observeThreadSnapshot(threadId, result, lifecycleRevision);
        this.markSubscribed(threadId);
        return;
      } catch (error) {
        const retryDelay = retryDelaysMs[attempt];
        if (
          retryDelay === undefined ||
          !(error instanceof HiddenRpcError) ||
          !isNoRolloutFound(error)
        ) {
          throw error;
        }
        await sleepFor(retryDelay);
      }
    }
  }

  #sendHidden(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("Broker connection closed"));
    }
    const id = `${BROKER_HIDDEN_ID_PREFIX}${this.id}:${this.#hiddenSequence++}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#hiddenPending.delete(id);
        reject(new Error(`${method} timed out`));
      }, this.#hiddenRequestTimeoutMs);
      timer.unref();
      this.#hiddenPending.set(id, {
        method,
        reject,
        resolve,
        timer,
      });
      try {
        this.#upstream.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.#hiddenPending.delete(id);
        clearTimeout(timer);
        reject(asError(error));
      }
    });
  }

  #sendError(id: RpcId, code: number, message: string): void {
    this.#send(
      this.#downstream,
      JSON.stringify({
        error: { code, message },
        id,
      }),
    );
  }

  #parseFrame(frame: string): Record<string, unknown> | undefined {
    if (Buffer.byteLength(frame, "utf8") > this.#maxFrameBytes) {
      this.#closeProtocol(1009, "protocol frame too large");
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame);
    } catch {
      this.#closeProtocol(1002, "invalid json-rpc frame");
      return undefined;
    }
    if (!isRecord(parsed)) {
      this.#closeProtocol(1002, "invalid json-rpc frame");
      return undefined;
    }
    return parsed;
  }

  #send(wire: BrokerWire, frame: string): void {
    if (this.closed) {
      return;
    }
    try {
      wire.send(frame);
    } catch {
      this.close();
    }
  }

  #closeProtocol(code: number, reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const error = new Error(reason);
    for (const [id, pending] of this.#hiddenPending) {
      this.#hiddenPending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#inflightResumes.clear();
    this.#coordinator.connectionClosed(this);
    safeClose(this.#downstream, code, reason);
    safeClose(this.#upstream, code, reason);
  }
}

function classifyClientRole(value: unknown): ClientRole {
  const params = asRecord(value);
  const clientInfo = asRecord(params.clientInfo);
  const claimsDesktop = clientInfo.title === "Codex Desktop";
  const claimsSidecar = clientInfo.name === "codex-local-remote";
  if (claimsDesktop === claimsSidecar) {
    return "unknown";
  }
  if (claimsDesktop) {
    return "desktop";
  }
  return "sidecar";
}

function extractThreadId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (typeof record.threadId === "string") {
    return record.threadId;
  }
  if (typeof record.id === "string") {
    return record.id;
  }
  const thread = asRecord(record.thread);
  return typeof thread.id === "string" ? thread.id : undefined;
}

function extractTurnId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (typeof record.turnId === "string") {
    return record.turnId;
  }
  const turn = asRecord(record.turn);
  return typeof turn.id === "string" ? turn.id : undefined;
}

function extractLoadedThreadIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result = new Set<string>();
  for (const candidate of value) {
    const threadId =
      typeof candidate === "string" ? candidate : extractThreadId(asRecord(candidate));
    if (threadId && threadId.trim() === threadId && threadId.length <= 512) {
      result.add(threadId);
    }
  }
  return [...result];
}

function parseUpstreamLoadedThreadCursor(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_LOADED_THREAD_CURSOR_LENGTH
  ) {
    throw new Error("thread/loaded/list returned an invalid cursor");
  }
  return value;
}

function parseLoadedThreadPagination(value: unknown): LoadedThreadPagination {
  if (value !== undefined && value !== null && !isRecord(value)) {
    throw new LoadedThreadPaginationError();
  }
  const params = asRecord(value);
  const limit = params.limit ?? DEFAULT_LOADED_THREAD_PAGE_LIMIT;
  if (
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_LOADED_THREAD_PAGE_LIMIT
  ) {
    throw new LoadedThreadPaginationError();
  }
  const cursor = params.cursor;
  if (cursor === undefined || cursor === null) {
    return { limit };
  }
  if (
    typeof cursor !== "string" ||
    cursor.length === 0 ||
    cursor.length > MAX_LOADED_THREAD_CURSOR_LENGTH ||
    !cursor.startsWith(LOADED_THREAD_CURSOR_PREFIX)
  ) {
    throw new LoadedThreadPaginationError();
  }
  const encoded = cursor.slice(LOADED_THREAD_CURSOR_PREFIX.length);
  let afterThreadId: string;
  try {
    afterThreadId = decodeURIComponent(encoded);
  } catch {
    throw new LoadedThreadPaginationError();
  }
  if (!isThreadId(afterThreadId) || encodeURIComponent(afterThreadId) !== encoded) {
    throw new LoadedThreadPaginationError();
  }
  return {
    afterThreadId,
    limit,
    requestCursor: cursor,
  };
}

function paginateLoadedThreads(
  threadIds: string[],
  pagination: LoadedThreadPagination,
): { data: string[]; nextCursor: string | null } {
  const afterThreadId = pagination.afterThreadId;
  const start =
    afterThreadId === undefined
      ? 0
      : threadIds.findIndex((threadId) => compareThreadIds(threadId, afterThreadId) > 0);
  const normalizedStart = start < 0 ? threadIds.length : start;
  const data = threadIds.slice(normalizedStart, normalizedStart + pagination.limit);
  const lastThreadId = data.at(-1);
  const nextCursor =
    lastThreadId !== undefined && normalizedStart + data.length < threadIds.length
      ? `${LOADED_THREAD_CURSOR_PREFIX}${encodeURIComponent(lastThreadId)}`
      : null;
  if (nextCursor !== null && nextCursor === pagination.requestCursor) {
    throw new LoadedThreadPaginationError();
  }
  return { data, nextCursor };
}

function compareThreadIds(left: string, right: string): number {
  return left.localeCompare(right, "en-US");
}

function isThreadId(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 512
  );
}

function extractAuthoritativeThreadState(value: unknown): AuthoritativeThreadState {
  const outer = asRecord(value);
  const paramsThread = asRecord(outer.thread);
  const thread = Object.keys(paramsThread).length > 0 ? paramsThread : outer;
  const statusRecord = asRecord(thread.status);
  const status =
    typeof statusRecord.type === "string"
      ? statusRecord.type
      : typeof thread.status === "string"
        ? thread.status
        : typeof asRecord(outer.status).type === "string"
          ? asRecord(outer.status).type
          : typeof outer.status === "string"
            ? outer.status
            : undefined;
  if (status === "active") {
    return "active";
  }
  if (status === "idle" || status === "systemError") {
    return "idle";
  }
  const turns = Array.isArray(thread.turns) ? thread.turns.map(asRecord) : [];
  if (turns.some((turn) => turn.status === "inProgress")) {
    return "active";
  }
  return status === undefined ? "unknown" : "idle";
}

function rpcId(value: unknown): RpcId | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function isNoRolloutFound(error: HiddenRpcError): boolean {
  return error.message.toLocaleLowerCase("en-US").includes("no rollout found");
}

function isNoRolloutFoundError(error: unknown): boolean {
  return error instanceof HiddenRpcError && isNoRolloutFound(error);
}

function deriveThreadTitle(value: unknown): string {
  const input = asRecord(value).input;
  if (!Array.isArray(input)) {
    return DEFAULT_THREAD_TITLE;
  }
  for (const item of input) {
    const record = asRecord(item);
    if (record.type === "text" && typeof record.text === "string") {
      const normalized = normalizeThreadTitle(record.text);
      if (normalized) {
        return truncateCodePoints(normalized, MAX_THREAD_TITLE_CODE_POINTS);
      }
    }
  }
  return DEFAULT_THREAD_TITLE;
}

export function normalizeThreadTitle(value: string): string {
  let decoded = value;
  if (/%[0-9a-f]{2}/iu.test(value)) {
    try {
      decoded = decodeURIComponent(value);
    } catch {
      // A malformed title must not break the first-turn persistence barrier.
    }
  }
  const withoutPresentationMarkdown = decoded
    .replace(/\*\*([^*\r\n]+)\*\*/gu, "$1")
    .replace(/__([^_\r\n]+)__/gu, "$1")
    .replace(/~~([^~\r\n]+)~~/gu, "$1")
    .replace(/`([^`\r\n]+)`/gu, "$1");
  return [...withoutPresentationMarkdown]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      const isControl =
        codePoint < 0x20 ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2066 && codePoint <= 0x2069);
      return isControl ? " " : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
}

function truncateCodePoints(value: string, maximum: number): string {
  const codePoints = [...value];
  if (codePoints.length <= maximum) {
    return value;
  }
  return `${codePoints.slice(0, maximum - 1).join("")}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function safeClose(wire: BrokerWire, code: number, reason: string): void {
  try {
    wire.close(code, reason);
  } catch {
    // Both sides are best-effort closed; no content is retained.
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Broker request failed");
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} 必须是正整数`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}

function assertDesktopLaunchNonceDigest(value: string): string {
  if (!DESKTOP_LAUNCH_NONCE_DIGEST.test(value)) {
    throw new TypeError("desktop launch nonce digest must be a lowercase SHA-256 hex value");
  }
  return value;
}

function assertRetryDelays(value: number[], name: string): void {
  if (value.some((delay) => !Number.isSafeInteger(delay) || delay < 0)) {
    throw new TypeError(`${name} 必须由非负整数组成`);
  }
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref();
  });
}
