import { describe, expect, it } from "vitest";

import { createCsrfToken, validateBrowserMutation } from "../../packages/security/src/index.js";

const allowedOrigins = ["https://remote.example.test"];

describe("browser mutation guards", () => {
  const csrf = createCsrfToken();

  it("accepts an authenticated same-origin mutation with valid CSRF", () => {
    expect(
      validateBrowserMutation({
        method: "POST",
        authenticated: true,
        origin: "https://remote.example.test",
        secFetchSite: "same-origin",
        csrfToken: csrf.token,
        expectedCsrfDigest: csrf.digest,
        allowedOrigins,
      }),
    ).toEqual({ allowed: true });
  });

  it.each([
    {
      name: "missing authentication",
      patch: { authenticated: false },
      reason: "unauthenticated",
    },
    {
      name: "missing origin",
      patch: { origin: undefined },
      reason: "origin-required",
    },
    {
      name: "cross origin",
      patch: { origin: "https://evil.example" },
      reason: "origin-denied",
    },
    {
      name: "Fetch Metadata cross-site",
      patch: { secFetchSite: "cross-site" },
      reason: "fetch-site-denied",
    },
    {
      name: "missing Fetch Metadata",
      patch: { secFetchSite: undefined },
      reason: "fetch-site-required",
    },
    {
      name: "invalid CSRF",
      patch: { csrfToken: "wrong" },
      reason: "csrf-invalid",
    },
  ])("rejects $name", ({ patch, reason }) => {
    expect(
      validateBrowserMutation({
        method: "POST",
        authenticated: true,
        origin: "https://remote.example.test",
        secFetchSite: "same-origin",
        csrfToken: csrf.token,
        expectedCsrfDigest: csrf.digest,
        allowedOrigins,
        ...patch,
      }),
    ).toEqual({ allowed: false, reason });
  });

  it.each([
    "null",
    "https://remote.example.test.evil.test",
    "https://user@remote.example.test",
    "file://remote.example.test",
    "https://remote.example.test https://evil.example",
  ])("rejects malformed or deceptive origin %s", (origin) => {
    const result = validateBrowserMutation({
      method: "POST",
      authenticated: true,
      origin,
      secFetchSite: "same-origin",
      csrfToken: csrf.token,
      expectedCsrfDigest: csrf.digest,
      allowedOrigins,
    });
    expect(result.allowed).toBe(false);
  });

  it("does not treat GET as a valid mutation endpoint", () => {
    expect(
      validateBrowserMutation({
        method: "GET",
        authenticated: true,
        origin: "https://remote.example.test",
        secFetchSite: "same-origin",
        csrfToken: csrf.token,
        expectedCsrfDigest: csrf.digest,
        allowedOrigins,
      }),
    ).toEqual({ allowed: false, reason: "safe-method" });
  });
});
