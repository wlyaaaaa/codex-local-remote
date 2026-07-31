export type AuthoritativeThreadState = "active" | "idle" | "unknown";

export interface TurnStartReservation {
  ownerConnectionId: number;
  threadId: string;
  token: number;
}

export interface ThreadArchiveReservation {
  ownerConnectionId: number;
  rootThreadId: string;
  token: number;
}

export interface ThreadLifecycleSnapshot {
  ownerConnectionId?: number;
  phase: "active" | "checking" | "idle" | "reserved" | "unknown";
  token?: number;
  turnId?: string;
}

type LifecycleEntry = ThreadLifecycleSnapshot;
type ArchiveEntry = ThreadArchiveReservation;

export class TurnStartConflictError extends Error {
  readonly code = -32_094;

  constructor(message = "Thread already has an active or pending turn") {
    super(message);
    this.name = "TurnStartConflictError";
  }
}

/**
 * Serializes turn starts across independent app-server connections.
 *
 * app-server treats turn/start during a regular active turn as steering. The
 * broker therefore owns a small, connection-agnostic reservation before any
 * client request may be forwarded.
 */
export class ThreadLifecycleArbiter {
  readonly #archiveEntries = new Map<string, ArchiveEntry>();
  readonly #completedTurnIds = new Map<string, string[]>();
  readonly #entries = new Map<string, LifecycleEntry>();
  readonly #revisions = new Map<string, number>();
  #nextToken = 1;

  async reserve(
    threadId: string,
    ownerConnectionId: number,
    inspect: () => Promise<AuthoritativeThreadState>,
  ): Promise<TurnStartReservation> {
    const normalized = requireThreadId(threadId);
    this.assertNotArchiving(normalized);
    const current = this.#entries.get(normalized);
    if (current?.phase === "checking" || current?.phase === "reserved") {
      throw new TurnStartConflictError();
    }

    const token = this.#nextToken++;
    const reservation: TurnStartReservation = {
      ownerConnectionId,
      threadId: normalized,
      token,
    };
    if (current?.phase === "idle") {
      this.#set(normalized, {
        ownerConnectionId,
        phase: "reserved",
        token,
      });
      return reservation;
    }

    this.#set(normalized, {
      ownerConnectionId,
      phase: "checking",
      token,
    });
    let observed: AuthoritativeThreadState;
    try {
      observed = await inspect();
    } catch (error) {
      if (this.#matches(reservation, "checking")) {
        this.#set(normalized, { phase: "unknown" });
      }
      throw error;
    }
    if (!this.#matches(reservation, "checking")) {
      throw new TurnStartConflictError("Thread lifecycle changed during the idle check");
    }
    if (observed !== "idle") {
      this.#set(
        normalized,
        observed === "active"
          ? {
              ...(current?.ownerConnectionId === undefined
                ? {}
                : { ownerConnectionId: current.ownerConnectionId }),
              phase: "active",
              ...(current?.token === undefined ? {} : { token: current.token }),
              ...(current?.turnId === undefined ? {} : { turnId: current.turnId }),
            }
          : { phase: "unknown" },
      );
      throw new TurnStartConflictError(
        observed === "active"
          ? "Thread already has an active turn"
          : "Thread idle state could not be confirmed",
      );
    }
    this.#set(normalized, {
      ownerConnectionId,
      phase: "reserved",
      token,
    });
    return reservation;
  }

  reserveArchive(
    rootThreadId: string,
    descendantThreadIds: Iterable<string>,
    ownerConnectionId: number,
  ): ThreadArchiveReservation {
    const normalizedRoot = requireThreadId(rootThreadId);
    const threadIds = new Set<string>([
      normalizedRoot,
      ...[...descendantThreadIds].map(requireThreadId),
    ]);
    const reservation: ThreadArchiveReservation = {
      ownerConnectionId,
      rootThreadId: normalizedRoot,
      token: this.#nextToken++,
    };
    this.#assertArchiveExtensionSafe(reservation, threadIds);
    for (const threadId of threadIds) {
      this.#archiveEntries.set(threadId, reservation);
    }
    return reservation;
  }

  extendArchive(
    reservation: ThreadArchiveReservation,
    descendantThreadIds: Iterable<string>,
  ): void {
    if (!this.ownsArchive(reservation)) {
      throw new TurnStartConflictError("Thread archive reservation is no longer active");
    }
    const threadIds = new Set([...descendantThreadIds].map(requireThreadId));
    this.#assertArchiveExtensionSafe(reservation, threadIds);
    for (const threadId of threadIds) {
      this.#archiveEntries.set(threadId, reservation);
    }
  }

  releaseArchive(reservation: ThreadArchiveReservation): void {
    for (const [threadId, entry] of this.#archiveEntries) {
      if (sameArchiveReservation(entry, reservation)) {
        this.#archiveEntries.delete(threadId);
      }
    }
  }

  ownsArchive(reservation: ThreadArchiveReservation): boolean {
    const rootEntry = this.#archiveEntries.get(reservation.rootThreadId);
    return rootEntry !== undefined && sameArchiveReservation(rootEntry, reservation);
  }

  assertNotArchiving(threadId: string): void {
    if (this.#archiveEntries.has(requireThreadId(threadId))) {
      throw new TurnStartConflictError("Thread is being archived");
    }
  }

  hasArchiveReservations(): boolean {
    return this.#archiveEntries.size > 0;
  }

  forget(threadIds: Iterable<string>): void {
    for (const rawThreadId of threadIds) {
      const threadId = requireThreadId(rawThreadId);
      this.#archiveEntries.delete(threadId);
      this.#completedTurnIds.delete(threadId);
      this.#entries.delete(threadId);
      this.#revisions.delete(threadId);
    }
  }

  activate(reservation: TurnStartReservation, turnId: string): void {
    const normalizedTurnId = requireTurnId(turnId);
    if (!this.#matches(reservation, "reserved", "active")) {
      return;
    }
    if (this.#completedTurnIds.get(reservation.threadId)?.includes(normalizedTurnId)) {
      this.#set(reservation.threadId, { phase: "idle" });
      return;
    }
    this.#set(reservation.threadId, {
      ownerConnectionId: reservation.ownerConnectionId,
      phase: "active",
      token: reservation.token,
      turnId: normalizedTurnId,
    });
  }

  release(reservation: TurnStartReservation): void {
    if (this.#matches(reservation, "checking", "reserved")) {
      this.#set(reservation.threadId, { phase: "idle" });
    }
  }

  markUnknown(reservation: TurnStartReservation): void {
    if (this.#matches(reservation, "checking", "reserved", "active")) {
      this.#set(reservation.threadId, { phase: "unknown" });
    }
  }

  observeStarted(threadId: string, turnId: string): void {
    const normalized = requireThreadId(threadId);
    const normalizedTurnId = requireTurnId(turnId);
    if (this.#completedTurnIds.get(normalized)?.includes(normalizedTurnId)) {
      return;
    }
    const current = this.#entries.get(normalized);
    this.#set(normalized, {
      ...(current?.ownerConnectionId === undefined
        ? {}
        : { ownerConnectionId: current.ownerConnectionId }),
      phase: "active",
      ...(current?.token === undefined ? {} : { token: current.token }),
      turnId: normalizedTurnId,
    });
  }

  complete(threadId: string, turnId: string): void {
    const normalized = requireThreadId(threadId);
    const normalizedTurnId = requireTurnId(turnId);
    const completed = this.#completedTurnIds.get(normalized) ?? [];
    this.#completedTurnIds.set(
      normalized,
      [...completed.filter((candidate) => candidate !== normalizedTurnId), normalizedTurnId].slice(
        -16,
      ),
    );
    const current = this.#entries.get(normalized);
    if (
      current?.phase === "active" &&
      (current.turnId === undefined || current.turnId === normalizedTurnId)
    ) {
      this.#set(normalized, { phase: "idle" });
    }
  }

  revision(threadId: string): number {
    return this.#revisions.get(requireThreadId(threadId)) ?? 0;
  }

  observeStatus(threadId: string, status: AuthoritativeThreadState): void {
    const normalized = requireThreadId(threadId);
    const current = this.#entries.get(normalized);
    if (status === "idle") {
      if (current?.phase === "checking" || current?.phase === "reserved") {
        return;
      }
      this.#set(normalized, { phase: "idle" });
      return;
    }
    if (status === "active") {
      if (current?.phase === "checking" || current?.phase === "reserved") {
        return;
      }
      this.#set(normalized, {
        ...(current?.ownerConnectionId === undefined
          ? {}
          : { ownerConnectionId: current.ownerConnectionId }),
        phase: "active",
        ...(current?.token === undefined ? {} : { token: current.token }),
        ...(current?.turnId === undefined ? {} : { turnId: current.turnId }),
      });
      return;
    }
    if (!current) {
      this.#set(normalized, { phase: "unknown" });
    }
  }

  observeStatusAtRevision(
    threadId: string,
    status: AuthoritativeThreadState,
    expectedRevision: number,
  ): boolean {
    const normalized = requireThreadId(threadId);
    if (this.revision(normalized) !== expectedRevision) {
      return false;
    }
    this.observeStatus(normalized, status);
    return true;
  }

  connectionClosed(connectionId: number): void {
    for (const [threadId, entry] of this.#archiveEntries) {
      if (entry.ownerConnectionId === connectionId) {
        this.#archiveEntries.delete(threadId);
      }
    }
    for (const [threadId, entry] of this.#entries) {
      if (
        entry.ownerConnectionId === connectionId &&
        (entry.phase === "checking" || entry.phase === "reserved" || entry.phase === "active")
      ) {
        this.#set(threadId, { phase: "unknown" });
      }
    }
  }

  snapshot(threadId: string): ThreadLifecycleSnapshot | undefined {
    const entry = this.#entries.get(threadId);
    return entry === undefined ? undefined : { ...entry };
  }

  unsafeThreadCount(): number {
    return this.unsafeThreadIds().length;
  }

  unsafeThreadIds(): string[] {
    const unsafeThreadIds = new Set(this.#archiveEntries.keys());
    for (const [threadId, entry] of this.#entries) {
      if (entry.phase !== "idle") unsafeThreadIds.add(threadId);
    }
    return [...unsafeThreadIds].sort((left, right) => left.localeCompare(right, "en-US"));
  }

  clear(): void {
    this.#archiveEntries.clear();
    this.#completedTurnIds.clear();
    this.#entries.clear();
    this.#revisions.clear();
  }

  #assertArchiveExtensionSafe(
    reservation: ThreadArchiveReservation,
    threadIds: Iterable<string>,
  ): void {
    for (const threadId of threadIds) {
      const archive = this.#archiveEntries.get(threadId);
      if (archive !== undefined && !sameArchiveReservation(archive, reservation)) {
        throw new TurnStartConflictError("Thread is already being archived");
      }
      const lifecycle = this.#entries.get(threadId);
      if (lifecycle?.phase === "checking" || lifecycle?.phase === "reserved") {
        throw new TurnStartConflictError("Thread has a pending turn");
      }
    }
  }

  #matches(reservation: TurnStartReservation, ...phases: LifecycleEntry["phase"][]): boolean {
    const current = this.#entries.get(reservation.threadId);
    return (
      current !== undefined &&
      phases.includes(current.phase) &&
      current.ownerConnectionId === reservation.ownerConnectionId &&
      current.token === reservation.token
    );
  }

  #set(threadId: string, entry: LifecycleEntry): void {
    this.#entries.set(threadId, entry);
    this.#revisions.set(threadId, (this.#revisions.get(threadId) ?? 0) + 1);
  }
}

function sameArchiveReservation(
  left: ThreadArchiveReservation,
  right: ThreadArchiveReservation,
): boolean {
  return (
    left.ownerConnectionId === right.ownerConnectionId &&
    left.rootThreadId === right.rootThreadId &&
    left.token === right.token
  );
}

function requireThreadId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) {
    throw new TypeError("Invalid thread id");
  }
  return normalized;
}

function requireTurnId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) {
    throw new TypeError("Invalid turn id");
  }
  return normalized;
}
