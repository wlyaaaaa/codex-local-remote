import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const scanner = resolve(import.meta.dirname, "..", "..", "scripts", "check-public-safety.mjs");

function scan(files: Record<string, Buffer | string>) {
  const root = join(tmpdir(), `codex-local-remote-scan-${process.pid}-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return spawnSync(process.execPath, [scanner, "--root", root], {
    cwd: root,
    encoding: "utf8",
  });
}

describe("public-safety scanner", () => {
  it("scans UTF-8, UTF-16LE, and escaped Windows paths", () => {
    const cloudKey = ["AKIA", "1234567890ABCDEF"].join("");
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(`key=${cloudKey}`, "utf16le"),
    ]);
    const result = scan({
      "safe.txt": "mock.example.ts.net\nC:\\\\Users\\\\fixture\\\\AppData",
      "secret.txt": utf16,
      "path.json": `{"path":"C:${"\\\\Users\\\\ActualPerson\\\\private"}"}`,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("AWS access key");
    expect(result.stderr).toContain("machine-specific Windows user path");
    expect(result.stderr).not.toContain("safe.txt");
  });

  it("rejects sensitive names, private keys, OAuth secrets, binary, and oversized files", () => {
    const privateHeader = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
    const oauthSecret = ["not-a-real-", "but-long-oauth-secret"].join("");
    const result = scan({
      ".env.local": "SAFE=placeholder",
      "key.txt": privateHeader,
      "oauth.txt": JSON.stringify({ client_secret: oauthSecret }),
      "binary.bin": Buffer.from([0, 1, 2, 3, 0, 255]),
      "large.txt": Buffer.alloc(2_000_001, 65),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("sensitive filename");
    expect(result.stderr).toContain("private key material");
    expect(result.stderr).toContain("OAuth client secret");
    expect(result.stderr).toContain("binary or unsupported encoding");
    expect(result.stderr).toContain("oversized file");
  });

  it("allows explicit examples and rejects a likely real Funnel hostname", () => {
    const result = scan({
      ".env.example": "API_KEY=example",
      "hosts.txt": `device.tailnet-name.ts.net\n${["workstation", "bluebird123", "ts", "net"].join(
        ".",
      )}\n`,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("real Funnel hostname");
    expect(result.stderr).not.toContain(".env.example");
  });

  it("allows only explicitly reviewed product screenshots with a valid image signature", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
    const result = scan({
      "docs/assets/desktop-tasks-en.jpg": jpeg,
      "docs/assets/mobile-approval-zh.jpg": jpeg,
      "docs/assets/unreviewed.jpg": jpeg,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain("desktop-tasks-en.jpg");
    expect(result.stderr).not.toContain("mobile-approval-zh.jpg");
    expect(result.stderr).toContain("unreviewed.jpg");
    expect(result.stderr).toContain("binary or unsupported encoding");
  });
});
