import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_BYTES = 32;

export interface SessionRecord {
  tokenDigest: string;
  createdAtMs: number;
  lastSeenAtMs: number;
  absoluteExpiresAtMs: number;
  idleExpiresAtMs: number;
}

export interface CreateSessionOptions {
  now: number;
  absoluteTtlMs: number;
  idleTtlMs: number;
}

export type SessionValidation =
  | { valid: true }
  | {
      valid: false;
      reason: "token-mismatch" | "idle-expired" | "absolute-expired";
    };

function requirePositiveDuration(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function requireTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("now must be a non-negative safe integer");
  }
}

function safeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function digestSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

export function createSession(options: CreateSessionOptions): {
  token: string;
  record: SessionRecord;
} {
  requireTimestamp(options.now);
  requirePositiveDuration(options.absoluteTtlMs, "absoluteTtlMs");
  requirePositiveDuration(options.idleTtlMs, "idleTtlMs");

  const absoluteExpiresAtMs = options.now + options.absoluteTtlMs;
  if (!Number.isSafeInteger(absoluteExpiresAtMs)) {
    throw new TypeError("session expiry exceeds safe integer range");
  }

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return {
    token,
    record: {
      tokenDigest: digestSessionToken(token),
      createdAtMs: options.now,
      lastSeenAtMs: options.now,
      absoluteExpiresAtMs,
      idleExpiresAtMs: Math.min(absoluteExpiresAtMs, options.now + options.idleTtlMs),
    },
  };
}

export function validateSession(
  token: string,
  record: SessionRecord,
  now: number,
): SessionValidation {
  requireTimestamp(now);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    return { valid: false, reason: "token-mismatch" };
  }
  const actualDigest = digestSessionToken(token);
  if (!safeStringEqual(actualDigest, record.tokenDigest)) {
    return { valid: false, reason: "token-mismatch" };
  }
  if (now >= record.absoluteExpiresAtMs) {
    return { valid: false, reason: "absolute-expired" };
  }
  if (now >= record.idleExpiresAtMs) {
    return { valid: false, reason: "idle-expired" };
  }
  return { valid: true };
}

export function touchSession(record: SessionRecord, now: number, idleTtlMs: number): SessionRecord {
  requireTimestamp(now);
  requirePositiveDuration(idleTtlMs, "idleTtlMs");
  return {
    ...record,
    lastSeenAtMs: now,
    idleExpiresAtMs: Math.min(record.absoluteExpiresAtMs, now + idleTtlMs),
  };
}
