import { describe, expect, it } from "vitest";

import {
  createCsrfToken,
  createSession,
  digestSessionToken,
  touchSession,
  validateSession,
  verifyCsrfToken,
} from "../../packages/security/src/index.js";

describe("session and CSRF tokens", () => {
  it("stores only a digest and enforces idle plus absolute expiry", () => {
    const now = Date.UTC(2026, 6, 25, 12);
    const session = createSession({
      now,
      absoluteTtlMs: 60_000,
      idleTtlMs: 10_000,
    });

    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(session.record.tokenDigest).toBe(digestSessionToken(session.token));
    expect(JSON.stringify(session.record)).not.toContain(session.token);
    expect(validateSession(session.token, session.record, now + 9_999)).toEqual({
      valid: true,
    });
    expect(validateSession(session.token, session.record, now + 10_000)).toEqual({
      valid: false,
      reason: "idle-expired",
    });
    expect(validateSession("not-the-token", session.record, now)).toEqual({
      valid: false,
      reason: "token-mismatch",
    });
  });

  it("touches idle expiry without extending the absolute lifetime", () => {
    const now = 1_000;
    const { record } = createSession({
      now,
      absoluteTtlMs: 10_000,
      idleTtlMs: 4_000,
    });

    const touched = touchSession(record, now + 3_000, 9_000);
    expect(touched.idleExpiresAtMs).toBe(now + 10_000);
    expect(touched.absoluteExpiresAtMs).toBe(now + 10_000);
  });

  it("rejects invalid TTLs", () => {
    expect(() => createSession({ now: 0, absoluteTtlMs: 0, idleTtlMs: 1 })).toThrow();
    expect(() => createSession({ now: 0, absoluteTtlMs: 1, idleTtlMs: -1 })).toThrow();
  });

  it("generates a separate CSRF secret and compares its digest safely", () => {
    const csrf = createCsrfToken();
    expect(csrf.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(csrf.digest).not.toBe(csrf.token);
    expect(verifyCsrfToken(csrf.token, csrf.digest)).toBe(true);
    expect(verifyCsrfToken(`${csrf.token}x`, csrf.digest)).toBe(false);
    expect(verifyCsrfToken("", csrf.digest)).toBe(false);
  });
});
