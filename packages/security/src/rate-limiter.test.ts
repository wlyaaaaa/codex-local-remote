import { describe, expect, it } from "vitest";

import { LoginRateLimiter } from "./rate-limiter.js";

describe("LoginRateLimiter reservations", () => {
  it("counts in-flight verification against source and global attempt limits", () => {
    const limiter = new LoginRateLimiter({
      baseDelayMs: 500,
      global: { lockoutMs: 10_000, maxAttempts: 6, windowMs: 60_000 },
      maxDelayMs: 5_000,
      maxSources: 16,
      source: { lockoutMs: 10_000, maxAttempts: 2, windowMs: 60_000 },
    });

    expect(limiter.reserveAttempt("source-a", 1_000)).toEqual({ allowed: true });
    expect(limiter.reserveAttempt("source-a", 1_000)).toEqual({ allowed: true });
    expect(limiter.reserveAttempt("source-a", 1_000)).toMatchObject({
      allowed: false,
      scope: "source",
    });
    expect(limiter.reserveAttempt("source-b", 1_000)).toEqual({ allowed: true });
    expect(limiter.reserveAttempt("source-c", 1_000)).toEqual({ allowed: true });
    expect(limiter.reserveAttempt("source-d", 1_000)).toEqual({ allowed: true });
    expect(limiter.reserveAttempt("source-e", 1_000)).toEqual({ allowed: true });
    expect(limiter.reserveAttempt("source-f", 1_000)).toMatchObject({
      allowed: false,
      scope: "global",
    });

    limiter.cancelAttempt("source-a", 1_001);
    expect(limiter.reserveAttempt("source-a", 1_001)).toEqual({ allowed: true });
  });
});
