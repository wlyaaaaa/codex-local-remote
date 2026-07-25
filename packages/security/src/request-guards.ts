import { verifyCsrfToken } from "./csrf.js";

export interface BrowserMutationInput {
  method: string;
  authenticated: boolean;
  origin?: string | undefined;
  secFetchSite?: string | undefined;
  csrfToken?: string | undefined;
  expectedCsrfDigest?: string | undefined;
  allowedOrigins: readonly string[];
}

export type BrowserMutationResult =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "safe-method"
        | "unauthenticated"
        | "origin-required"
        | "origin-denied"
        | "fetch-site-required"
        | "fetch-site-denied"
        | "csrf-invalid";
    };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function parseOrigin(value: string, requireCanonical: boolean): string | null {
  if (value === "null" || /\s/u.test(value)) {
    return null;
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.origin === "null"
    ) {
      return null;
    }
    if (requireCanonical && value !== url.origin) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function validateBrowserMutation(input: BrowserMutationInput): BrowserMutationResult {
  if (SAFE_METHODS.has(input.method.toUpperCase())) {
    return { allowed: false, reason: "safe-method" };
  }
  if (!input.authenticated) {
    return { allowed: false, reason: "unauthenticated" };
  }
  if (input.origin === undefined || input.origin.length === 0) {
    return { allowed: false, reason: "origin-required" };
  }

  const requestOrigin = parseOrigin(input.origin, true);
  const allowed = input.allowedOrigins
    .map((origin) => parseOrigin(origin, false))
    .filter((origin): origin is string => origin !== null);
  if (requestOrigin === null || !allowed.includes(requestOrigin)) {
    return { allowed: false, reason: "origin-denied" };
  }

  if (input.secFetchSite === undefined || input.secFetchSite.length === 0) {
    return { allowed: false, reason: "fetch-site-required" };
  }
  if (input.secFetchSite !== "same-origin") {
    return { allowed: false, reason: "fetch-site-denied" };
  }
  if (
    input.csrfToken === undefined ||
    input.expectedCsrfDigest === undefined ||
    !verifyCsrfToken(input.csrfToken, input.expectedCsrfDigest)
  ) {
    return { allowed: false, reason: "csrf-invalid" };
  }
  return { allowed: true };
}
