export interface LoginRateLimitScopeConfig {
  maxAttempts: number;
  windowMs: number;
  lockoutMs: number;
}

export interface LoginRateLimiterConfig {
  source: LoginRateLimitScopeConfig;
  global: LoginRateLimitScopeConfig;
  baseDelayMs: number;
  maxDelayMs: number;
  maxSources: number;
}

interface AttemptState {
  failures: number[];
  inFlight: number;
  nextAllowedAt: number;
  lockedUntil: number;
  lastSeenAt: number;
}

export type LoginRateLimitDecision =
  | { allowed: true }
  | {
      allowed: false;
      retryAfterMs: number;
      scope: "source" | "global";
    };

function validateScope(config: LoginRateLimitScopeConfig, label: string): void {
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${label}.${key} must be a positive safe integer`);
    }
  }
}

function emptyState(): AttemptState {
  return {
    failures: [],
    inFlight: 0,
    nextAllowedAt: 0,
    lockedUntil: 0,
    lastSeenAt: 0,
  };
}

export class LoginRateLimiter {
  readonly #config: LoginRateLimiterConfig;
  readonly #sources = new Map<string, AttemptState>();
  readonly #global = emptyState();

  constructor(config: LoginRateLimiterConfig) {
    validateScope(config.source, "source");
    validateScope(config.global, "global");
    if (
      !Number.isSafeInteger(config.baseDelayMs) ||
      config.baseDelayMs <= 0 ||
      !Number.isSafeInteger(config.maxDelayMs) ||
      config.maxDelayMs < config.baseDelayMs ||
      !Number.isSafeInteger(config.maxSources) ||
      config.maxSources <= 0
    ) {
      throw new TypeError("invalid login rate limiter configuration");
    }
    this.#config = config;
  }

  get trackedSourceCount(): number {
    return this.#sources.size;
  }

  beforeAttempt(source: string, now: number): LoginRateLimitDecision {
    this.#validateSource(source);
    this.#validateNow(now);
    this.#prune(this.#global, this.#config.global, now);
    const globalDecision = this.#decision(this.#global, now, "global");
    if (!globalDecision.allowed) {
      return globalDecision;
    }

    const state = this.#sources.get(source);
    if (state === undefined) {
      return { allowed: true };
    }
    this.#prune(state, this.#config.source, now);
    state.lastSeenAt = now;
    return this.#decision(state, now, "source");
  }

  reserveAttempt(source: string, now: number): LoginRateLimitDecision {
    this.#validateSource(source);
    this.#validateNow(now);
    this.#prune(this.#global, this.#config.global, now);
    const globalDecision = this.#reservationDecision(
      this.#global,
      this.#config.global,
      now,
      "global",
    );
    if (!globalDecision.allowed) {
      return globalDecision;
    }
    const sourceState = this.#getOrCreateSource(source, now);
    this.#prune(sourceState, this.#config.source, now);
    const sourceDecision = this.#reservationDecision(
      sourceState,
      this.#config.source,
      now,
      "source",
    );
    if (!sourceDecision.allowed) {
      return sourceDecision;
    }
    sourceState.inFlight += 1;
    sourceState.lastSeenAt = now;
    this.#global.inFlight += 1;
    this.#global.lastSeenAt = now;
    return { allowed: true };
  }

  recordFailure(source: string, now: number): void {
    this.#validateSource(source);
    this.#validateNow(now);
    const sourceState = this.#getOrCreateSource(source, now);
    this.#releaseReservation(sourceState);
    this.#releaseReservation(this.#global);
    this.#recordFailureForState(sourceState, this.#config.source, now, true);
    this.#recordFailureForState(this.#global, this.#config.global, now, false);
  }

  recordSuccess(source: string): void {
    this.#validateSource(source);
    const sourceState = this.#sources.get(source);
    if (sourceState !== undefined) {
      this.#releaseReservation(sourceState);
      sourceState.failures = [];
      sourceState.lockedUntil = 0;
      sourceState.nextAllowedAt = 0;
      if (sourceState.inFlight === 0) {
        this.#sources.delete(source);
      }
    }
    this.#releaseReservation(this.#global);
  }

  cancelAttempt(source: string, now: number): void {
    this.#validateSource(source);
    this.#validateNow(now);
    const sourceState = this.#sources.get(source);
    if (sourceState !== undefined) {
      this.#releaseReservation(sourceState);
      sourceState.lastSeenAt = now;
      if (sourceState.inFlight === 0 && sourceState.failures.length === 0) {
        this.#sources.delete(source);
      }
    }
    this.#releaseReservation(this.#global);
  }

  #recordFailureForState(
    state: AttemptState,
    scope: LoginRateLimitScopeConfig,
    now: number,
    applyBackoff: boolean,
  ): void {
    this.#prune(state, scope, now);
    state.failures.push(now);
    state.lastSeenAt = now;
    if (state.failures.length >= scope.maxAttempts) {
      state.lockedUntil = now + scope.lockoutMs;
      state.nextAllowedAt = state.lockedUntil;
      return;
    }
    if (applyBackoff) {
      const exponent = Math.max(0, state.failures.length - 1);
      const delay = Math.min(this.#config.maxDelayMs, this.#config.baseDelayMs * 2 ** exponent);
      state.nextAllowedAt = now + delay;
    }
  }

  #decision(state: AttemptState, now: number, scope: "source" | "global"): LoginRateLimitDecision {
    const blockedUntil = Math.max(state.nextAllowedAt, state.lockedUntil);
    if (now < blockedUntil) {
      return {
        allowed: false,
        retryAfterMs: blockedUntil - now,
        scope,
      };
    }
    return { allowed: true };
  }

  #reservationDecision(
    state: AttemptState,
    config: LoginRateLimitScopeConfig,
    now: number,
    scope: "source" | "global",
  ): LoginRateLimitDecision {
    const current = this.#decision(state, now, scope);
    if (!current.allowed) {
      return current;
    }
    if (state.failures.length + state.inFlight >= config.maxAttempts) {
      return {
        allowed: false,
        retryAfterMs: this.#config.baseDelayMs,
        scope,
      };
    }
    return { allowed: true };
  }

  #releaseReservation(state: AttemptState): void {
    state.inFlight = Math.max(0, state.inFlight - 1);
  }

  #prune(state: AttemptState, scope: LoginRateLimitScopeConfig, now: number): void {
    const threshold = now - scope.windowMs;
    state.failures = state.failures.filter((timestamp) => timestamp > threshold);
  }

  #getOrCreateSource(source: string, now: number): AttemptState {
    const existing = this.#sources.get(source);
    if (existing !== undefined) {
      return existing;
    }
    while (this.#sources.size >= this.#config.maxSources) {
      let oldestKey: string | undefined;
      let oldestTimestamp = Number.POSITIVE_INFINITY;
      for (const [key, state] of this.#sources) {
        if (state.lastSeenAt < oldestTimestamp) {
          oldestKey = key;
          oldestTimestamp = state.lastSeenAt;
        }
      }
      if (oldestKey === undefined) {
        break;
      }
      this.#sources.delete(oldestKey);
    }
    const state = emptyState();
    state.lastSeenAt = now;
    this.#sources.set(source, state);
    return state;
  }

  #validateSource(source: string): void {
    if (source.trim().length === 0 || source.length > 512) {
      throw new TypeError("source must be a bounded non-empty identifier");
    }
  }

  #validateNow(now: number): void {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError("now must be a non-negative safe integer");
    }
  }
}
