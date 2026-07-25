import { describe, expect, it } from "vitest";

import { LoginRateLimiter } from "../../packages/security/src/index.js";

const config = {
  source: {
    maxAttempts: 3,
    windowMs: 60_000,
    lockoutMs: 30_000,
  },
  global: {
    maxAttempts: 5,
    windowMs: 60_000,
    lockoutMs: 20_000,
  },
  baseDelayMs: 1_000,
  maxDelayMs: 8_000,
  maxSources: 100,
} as const;

describe("login rate limiter", () => {
  it("applies exponential backoff and then a per-source lockout", () => {
    const limiter = new LoginRateLimiter(config);

    expect(limiter.beforeAttempt("source-a", 0)).toEqual({ allowed: true });
    limiter.recordFailure("source-a", 0);
    expect(limiter.beforeAttempt("source-a", 999)).toEqual({
      allowed: false,
      retryAfterMs: 1,
      scope: "source",
    });
    expect(limiter.beforeAttempt("source-a", 1_000)).toEqual({ allowed: true });

    limiter.recordFailure("source-a", 1_000);
    expect(limiter.beforeAttempt("source-a", 2_000)).toMatchObject({
      allowed: false,
      scope: "source",
    });

    limiter.recordFailure("source-a", 3_000);
    expect(limiter.beforeAttempt("source-a", 20_000)).toEqual({
      allowed: false,
      retryAfterMs: 13_000,
      scope: "source",
    });
    expect(limiter.beforeAttempt("source-a", 33_000)).toEqual({ allowed: true });
  });

  it("has a global limit that distributed sources cannot bypass", () => {
    const limiter = new LoginRateLimiter(config);
    for (let index = 0; index < 5; index += 1) {
      limiter.recordFailure(`source-${index}`, index);
    }

    expect(limiter.beforeAttempt("new-source", 5)).toEqual({
      allowed: false,
      retryAfterMs: 19_999,
      scope: "global",
    });
  });

  it("clears source backoff after successful authentication", () => {
    const limiter = new LoginRateLimiter(config);
    limiter.recordFailure("source-a", 0);
    limiter.recordSuccess("source-a");
    expect(limiter.beforeAttempt("source-a", 1)).toEqual({ allowed: true });
  });

  it("bounds tracked sources and rejects empty source identifiers", () => {
    const limiter = new LoginRateLimiter({ ...config, maxSources: 2 });
    limiter.recordFailure("source-a", 0);
    limiter.recordFailure("source-b", 1);
    limiter.recordFailure("source-c", 2);
    expect(limiter.trackedSourceCount).toBeLessThanOrEqual(2);
    expect(() => limiter.recordFailure("", 3)).toThrow();
  });
});
