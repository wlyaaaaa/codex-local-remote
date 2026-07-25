import { mkdir, mkdtemp, open, realpath, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  authorizeDownload,
  evaluateDownload,
  sanitizeAuditMetadata,
} from "../../packages/security/src/index.js";

describe("download policy", () => {
  it.each([
    ".git/config",
    ".codex/auth.json",
    "node_modules/pkg/index.js",
    ".env",
    ".env.production",
    ".npmrc",
    "credentials.json",
    "certificates/client.PFX",
    "keys/private.pem",
    "id_rsa",
  ])("blocks sensitive path %s", (relativePath) => {
    expect(evaluateDownload({ relativePath, size: 10, kind: "file" })).toMatchObject({
      allowed: false,
    });
  });

  it("blocks directories, invalid sizes, and oversized files", () => {
    expect(evaluateDownload({ relativePath: "docs", size: 0, kind: "directory" })).toEqual({
      allowed: false,
      reason: "not-file",
    });
    expect(evaluateDownload({ relativePath: "docs/a.txt", size: -1, kind: "file" })).toEqual({
      allowed: false,
      reason: "invalid-size",
    });
    expect(
      evaluateDownload({
        relativePath: "build/result.zip",
        size: 101,
        kind: "file",
        maxBytes: 100,
      }),
    ).toEqual({ allowed: false, reason: "too-large" });
  });

  it("allows an ordinary bounded artifact", () => {
    expect(
      evaluateDownload({
        relativePath: "build/report.pdf",
        size: 1024,
        kind: "file",
      }),
    ).toEqual({ allowed: true });
  });

  it("rechecks the canonical target so a junction cannot alias a sensitive directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "clr-download-root-"));
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), "synthetic");
    await symlink(join(root, ".git"), join(root, "innocent"), "junction");

    await expect(authorizeDownload(root, "innocent/config")).rejects.toThrow(
      /sensitive-directory/iu,
    );
  });

  it("returns a canonical path and size for a normal artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "clr-download-root-"));
    await mkdir(join(root, "build"));
    await writeFile(join(root, "build", "report.txt"), "safe");

    const authorized = await authorizeDownload(root, "build/report.txt");
    expect(authorized.size).toBe(4);
    await expect(authorized.handle.readFile({ encoding: "utf8" })).resolves.toBe("safe");
    await authorized.handle.close();
  });

  it("rejects a junction swapped in between containment validation and open", async () => {
    const root = await mkdtemp(join(tmpdir(), "clr-download-root-"));
    const outside = await mkdtemp(join(tmpdir(), "clr-download-outside-"));
    await mkdir(join(root, "slot"));
    await writeFile(join(root, "slot", "report.txt"), "safe");
    await writeFile(join(outside, "report.txt"), "outside");
    let swapped = false;

    await expect(
      authorizeDownload(root, "slot/report.txt", undefined, {
        open: async (candidate, flags) => {
          if (!swapped) {
            swapped = true;
            await rename(join(root, "slot"), join(root, "slot-original"));
            await symlink(outside, join(root, "slot"), "junction");
          }
          return await open(candidate, flags);
        },
        realpath,
        stat: async (candidate, options) => await stat(candidate, options),
      }),
    ).rejects.toThrow(/unsafe-path|file-changed/iu);
  });

  it("rejects a sensitive project root even when the requested relative path is ordinary", async () => {
    const parent = await mkdtemp(join(tmpdir(), "clr-download-root-"));
    const root = join(parent, ".codex");
    await mkdir(root);
    await writeFile(join(root, "report.txt"), "synthetic");

    await expect(authorizeDownload(root, "report.txt")).rejects.toThrow(/sensitive-directory/iu);
  });
});

describe("audit redaction", () => {
  it("redacts secrets, content, commands, absolute paths and credential-shaped text", () => {
    const sanitized = sanitizeAuditMetadata({
      requestId: "req_public",
      projectId: "project_demo",
      password: "NeverStoreThis!",
      csrfToken: "csrf-secret",
      prompt: "read my private file",
      command: "type C:\\Users\\Example\\secret.txt",
      path: "C:\\Users\\Example\\secret.txt",
      nested: {
        Authorization: "Bearer abc.def.ghi",
        note: "token sk-example12345678901234567890",
      },
    });
    const json = JSON.stringify(sanitized);

    expect(sanitized).toMatchObject({
      requestId: "req_public",
      projectId: "project_demo",
      password: "[REDACTED]",
      csrfToken: "[REDACTED]",
      prompt: "[REDACTED]",
      command: "[REDACTED]",
      path: "[REDACTED_PATH]",
    });
    expect(json).not.toContain("NeverStoreThis");
    expect(json).not.toContain("abc.def.ghi");
    expect(json).not.toContain("sk-example");
    expect(json).not.toContain("C:\\\\Users");
  });

  it("bounds deep and oversized metadata", () => {
    const sanitized = sanitizeAuditMetadata({
      huge: "x".repeat(10_000),
      list: Array.from({ length: 100 }, (_, index) => index),
    });
    expect(JSON.stringify(sanitized).length).toBeLessThan(4_000);
  });
});
