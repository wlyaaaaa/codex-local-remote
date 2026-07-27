export type AuthoritativeThreadState = "active" | "idle" | "unknown";

export interface TurnStartReservation {
  ownerConnectionId: number;
  threadId: string;
  token: number;
}

export interface ThreadLifecycleSnapshot {
  ownerConnectionId?: number;
  phase: "active" | "checking" | "idle" | "reserved" | "unknown";
  token?: number;
  turnId?: string;
}

type LifecycleEntry = ThreadLifecycleSnapshot;

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
  readonly #completedTurnIds = new Map<string, string[]>();
  readonly #entries = new Map<string, LifecycleEntry>();
  #nextToken = 1;

  async reserve(
    threadId: string,
    ownerConnectionId: number,
    inspect: () => Promise<AuthoritativeThreadState>,
  ): Promise<TurnStartReservation> {
    const normalized = requireThreadId(threadId);
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
      this.#entries.set(normalized, {
        ownerConnectionId,
        phase: "reserved",
        token,
      });
      return reservation;
    }

    this.#entries.set(normalized, {
      ownerConnectionId,
      phase: "checking",
      token,
    });
    let observed: AuthoritativeThreadState;
    try {
      observed = await inspect();
    } catch (error) {
      if (this.#matches(reservation, "checking")) {
        this.#entries.set(normalized, { phase: "unknown" });
      }
      throw error;
    }
    if (!this.#matches(reservation, "checking")) {
      throw new TurnStartConflictError("Thread lifecycle changed during the idle check");
    }
    if (observed !== "idle") {
      this.#entries.set(
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
    this.#entries.set(normalized, {
      ownerConnectionId,
      phase: "reserved",
      token,
    });
    return reservation;
  }

  activate(reservation: TurnStartReservation, turnId: string): void {
    const normalizedTurnId = requireTurnId(turnId);
    if (!this.#matches(reservation, "reserved", "active")) {
      return;
    }
    if (this.#completedTurnIds.get(reservation.threadId)?.includes(normalizedTurnId)) {
      this.#entries.set(reservation.threadId, { phase: "idle" });
      return;
    }
    this.#entries.set(reservation.threadId, {
      ownerConnectionId: reservation.ownerConnectionId,
      phase: "active",
      token: reservation.token,
      turnId: normalizedTurnId,
    });
  }

  release(reservation: TurnStartReservation): void {
    if (this.#matches(reservation, "checking", "reserved")) {
      this.#entries.set(reservation.threadId, { phase: "idle" });
    }
  }

  markUnknown(reservation: TurnStartReservation): void {
    if (this.#matches(reservation, "checking", "reserved", "active")) {
      this.#entries.set(reservation.threadId, { phase: "unknown" });
    }
  }

  observeStarted(threadId: string, turnId: string): void {
    const normalized = requireThreadId(threadId);
    const normalizedTurnId = requireTurnId(turnId);
    if (this.#completedTurnIds.get(normalized)?.includes(normalizedTurnId)) {
      return;
    }
    const current = this.#entries.get(normalized);
    this.#entries.set(normalized, {
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
      this.#entries.set(normalized, { phase: "idle" });
    }
  }

  observeStatus(threadId: string, status: AuthoritativeThreadState): void {
    const normalized = requireThreadId(threadId);
    const current = this.#entries.get(normalized);
    if (status === "idle") {
      if (current?.phase === "checking" || current?.phase === "reserved") {
        return;
      }
      this.#entries.set(normalized, { phase: "idle" });
      return;
    }
    if (status === "active") {
      if (current?.phase === "checking" || current?.phase === "reserved") {
        return;
      }
      this.#entries.set(normalized, {
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
      this.#entries.set(normalized, { phase: "unknown" });
    }
  }

  connectionClosed(connectionId: number): void {
    for (const [threadId, entry] of this.#entries) {
      if (
        entry.ownerConnectionId === connectionId &&
        (entry.phase === "checking" || entry.phase === "reserved" || entry.phase === "active")
      ) {
        this.#entries.set(threadId, { phase: "unknown" });
      }
    }
  }

  snapshot(threadId: string): ThreadLifecycleSnapshot | undefined {
    const entry = this.#entries.get(threadId);
    return entry === undefined ? undefined : { ...entry };
  }

  unsafeThreadCount(): number {
    let count = 0;
    for (const entry of this.#entries.values()) {
      if (entry.phase !== "idle") count += 1;
    }
    return count;
  }

  clear(): void {
    this.#completedTurnIds.clear();
    this.#entries.clear();
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
