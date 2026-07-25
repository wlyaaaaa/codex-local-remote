import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveContainedPath,
  validateSafeWindowsProjectRoot,
  validateSafeWindowsRelativePath,
} from "../../packages/security/src/index.js";

describe("Windows relative path validation", () => {
  it.each([
    "..",
    "../secret.txt",
    "safe/../../secret.txt",
    "C:\\Windows\\win.ini",
    "C:relative.txt",
    "\\\\server\\share\\secret.txt",
    "\\\\?\\C:\\Windows\\win.ini",
    "\\\\.\\PhysicalDrive0",
    "\\rooted.txt",
    "/rooted.txt",
    "file.txt:secret",
    "CON",
    "con.txt",
    "LPT9.log",
    "folder\\NUL.txt",
    "trailing.\\file.txt",
    "trailing \\file.txt",
    "bad<name>.txt",
    "bad\u0000name.txt",
    "double//separator.txt",
  ])("rejects unsafe Windows path %j", (value) => {
    expect(validateSafeWindowsRelativePath(value).ok).toBe(false);
  });

  it.each([
    "",
    "README.md",
    "docs/设计说明.md",
    "src\\nested\\file.ts",
    "Folder/File.Name-2026.txt",
  ])("accepts safe project-relative path %j", (value) => {
    expect(validateSafeWindowsRelativePath(value)).toMatchObject({ ok: true });
  });

  it.each([
    "C:\\Users\\Example\\.ssh",
    "C:\\Users\\Example\\.codex\\projects\\demo",
    "C:\\work\\repo\\.git",
    "C:\\work\\.gnupg\\nested\\project",
    "C:\\work\\node_modules\\package",
    "\\\\server\\share\\.SSH\\project",
  ])("rejects a sensitive segment anywhere in normalized project root %j", (value) => {
    expect(validateSafeWindowsProjectRoot(value)).toEqual({
      ok: false,
      reason: "sensitive-directory",
    });
  });

  it("normalizes an ordinary absolute project root", () => {
    expect(validateSafeWindowsProjectRoot("C:\\work\\safe\\..\\project")).toEqual({
      normalized: "C:\\work\\project",
      ok: true,
    });
  });

  it("resolves a normal file inside a registered root", async () => {
    const root = await mkdtemp(join(tmpdir(), "clr-security-root-"));
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "safe.txt"), "safe");

    const resolved = await resolveContainedPath(root, "docs/safe.txt");
    expect(resolved).toBe(await realpath(join(root, "docs", "safe.txt")));
  });

  it("rejects a directory junction or symlink that escapes the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "clr-security-root-"));
    const outside = await mkdtemp(join(tmpdir(), "clr-security-outside-"));
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(root, "escape"), "junction");

    await expect(resolveContainedPath(root, "escape/secret.txt")).rejects.toThrow(
      /outside|containment/iu,
    );
  });
});
