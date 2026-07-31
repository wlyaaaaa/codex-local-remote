export interface LivenessWebSocket {
  readonly readyState: number;
  off(event: "pong", listener: () => void): void;
  on(event: "pong", listener: () => void): void;
  ping(): void;
}

export interface WebSocketLivenessMonitorOptions {
  deadlineMs: number;
  intervalMs: number;
  resumeToleranceMs: number;
}

interface SocketHeartbeatState {
  missedHeartbeats: number;
  readonly onPong: () => void;
  readonly socket: LivenessWebSocket;
  nextPingAt: number;
  pendingPingAt: number | undefined;
  registeredAt: number;
}

interface PairHeartbeatState {
  readonly onStale: () => void;
  readonly sockets: SocketHeartbeatState[];
}

const CONNECTING = 0;
const OPEN = 1;
// One missed deadline can be a sleep/resume boundary where the timer runs
// before the WebSocket stack can answer. The second ping is the fresh probe.
const MISSED_HEARTBEATS_BEFORE_CLOSE = 2;

export class WebSocketLivenessMonitor {
  readonly #checkIntervalMs: number;
  readonly #deadlineMs: number;
  readonly #intervalMs: number;
  readonly #pairs = new Set<PairHeartbeatState>();
  readonly #resumeToleranceMs: number;
  #lastSweepAt: number | undefined;
  #stopped = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: WebSocketLivenessMonitorOptions) {
    assertPositiveInteger(options.deadlineMs, "deadlineMs");
    assertPositiveInteger(options.intervalMs, "intervalMs");
    assertNonNegativeInteger(options.resumeToleranceMs, "resumeToleranceMs");
    this.#deadlineMs = options.deadlineMs;
    this.#intervalMs = options.intervalMs;
    this.#resumeToleranceMs = options.resumeToleranceMs;
    this.#checkIntervalMs = Math.min(this.#deadlineMs, this.#intervalMs);
  }

  watchPair(first: LivenessWebSocket, second: LivenessWebSocket, onStale: () => void): () => void {
    if (this.#stopped) {
      throw new Error("WebSocket liveness monitor is stopped");
    }
    const now = Date.now();
    const pair: PairHeartbeatState = {
      onStale,
      sockets: [],
    };
    pair.sockets.push(
      this.#createSocketState(pair, first, now),
      this.#createSocketState(pair, second, now),
    );
    this.#pairs.add(pair);
    this.#ensureTimer();
    return () => {
      this.#removePair(pair);
    };
  }

  stop(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    for (const pair of [...this.#pairs]) {
      this.#removePair(pair);
    }
    this.#clearTimer();
  }

  #createSocketState(
    pair: PairHeartbeatState,
    socket: LivenessWebSocket,
    now: number,
  ): SocketHeartbeatState {
    const state: SocketHeartbeatState = {
      missedHeartbeats: 0,
      nextPingAt: now + this.#intervalMs,
      onPong: () => {
        if (!this.#pairs.has(pair)) {
          return;
        }
        state.missedHeartbeats = 0;
        state.pendingPingAt = undefined;
        state.nextPingAt = Date.now() + this.#intervalMs;
      },
      pendingPingAt: undefined,
      registeredAt: now,
      socket,
    };
    socket.on("pong", state.onPong);
    return state;
  }

  #ensureTimer(): void {
    if (this.#timer || this.#stopped) {
      return;
    }
    this.#lastSweepAt = Date.now();
    this.#timer = setInterval(this.#sweep, this.#checkIntervalMs);
    this.#timer.unref();
  }

  #clearTimer(): void {
    if (!this.#timer) {
      return;
    }
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#lastSweepAt = undefined;
  }

  #removePair(pair: PairHeartbeatState): void {
    if (!this.#pairs.delete(pair)) {
      return;
    }
    for (const state of pair.sockets) {
      state.socket.off("pong", state.onPong);
    }
    if (this.#pairs.size === 0) {
      this.#clearTimer();
    }
  }

  #failPair(pair: PairHeartbeatState): void {
    this.#removePair(pair);
    try {
      pair.onStale();
    } catch {
      // A liveness callback must never escape the timer and crash the Broker.
    }
  }

  readonly #sweep = (): void => {
    if (this.#stopped) {
      return;
    }
    const now = Date.now();
    const elapsed =
      this.#lastSweepAt === undefined ? this.#checkIntervalMs : now - this.#lastSweepAt;
    const resumed = elapsed < 0 || elapsed > this.#checkIntervalMs + this.#resumeToleranceMs;
    this.#lastSweepAt = now;

    for (const pair of [...this.#pairs]) {
      if (resumed) {
        for (const state of pair.sockets) {
          state.missedHeartbeats = 0;
          state.pendingPingAt = undefined;
          state.registeredAt = now;
          state.nextPingAt = now;
        }
      }

      let stale = false;
      for (const state of pair.sockets) {
        if (state.socket.readyState === CONNECTING) {
          stale ||= now - state.registeredAt >= this.#deadlineMs * 2;
          continue;
        }
        if (state.socket.readyState !== OPEN) {
          stale = true;
          break;
        }
        if (state.pendingPingAt !== undefined && now - state.pendingPingAt >= this.#deadlineMs) {
          state.missedHeartbeats += 1;
          state.pendingPingAt = undefined;
          state.nextPingAt = now;
          if (state.missedHeartbeats >= MISSED_HEARTBEATS_BEFORE_CLOSE) {
            stale = true;
            break;
          }
        }
      }
      if (stale) {
        this.#failPair(pair);
        continue;
      }

      for (const state of pair.sockets) {
        if (
          state.socket.readyState !== OPEN ||
          state.pendingPingAt !== undefined ||
          now < state.nextPingAt
        ) {
          continue;
        }
        try {
          state.socket.ping();
          state.pendingPingAt = now;
        } catch {
          stale = true;
          break;
        }
      }
      if (stale) {
        this.#failPair(pair);
      }
    }
  };
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}
