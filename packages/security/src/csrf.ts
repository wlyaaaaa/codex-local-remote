import { randomBytes, timingSafeEqual } from "node:crypto";

import { digestSessionToken } from "./session.js";

export interface CsrfToken {
  token: string;
  digest: string;
}

export function createCsrfToken(): CsrfToken {
  const token = randomBytes(32).toString("base64url");
  return { token, digest: digestSessionToken(token) };
}

export function verifyCsrfToken(token: string, expectedDigest: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token) || !/^[A-Za-z0-9_-]{43}$/u.test(expectedDigest)) {
    return false;
  }
  const actualDigest = digestSessionToken(token);
  const actual = Buffer.from(actualDigest, "utf8");
  const expected = Buffer.from(expectedDigest, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
