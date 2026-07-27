import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const modulePath = join(repositoryRoot, "scripts", "windows", "CodexLocalRemote.Windows.psm1");
const driver = join(import.meta.dirname, "fixtures", "runtime-discovery-driver.ps1");

interface RuntimeResult {
  Signature: string;
  PackageFullName: string;
  PackageVersion: string;
  CodexPath: string;
  CodexSha256: string;
  BundledCodexSha256: string;
  Source: string;
}

windowsOnly("dynamic Codex Desktop runtime discovery", () => {
  let sandbox: string;
  let packageRoot: string;
  let localAppData: string;
  let bundledCodex: string;

  beforeEach(() => {
    sandbox = join(tmpdir(), `codex-runtime-discovery-${process.pid}-${crypto.randomUUID()}`);
    packageRoot = join(sandbox, "WindowsApps", "OpenAI.Codex_dynamic");
    localAppData = join(sandbox, "LocalAppData");
    bundledCodex = join(packageRoot, "app", "resources", "codex.exe");
    const desktopExecutable = join(packageRoot, "app", "ChatGPT.exe");
    mkdirSync(dirname(bundledCodex), { recursive: true });
    writeFileSync(bundledCodex, "current desktop managed runtime", "utf8");
    writeFileSync(desktopExecutable, "current desktop executable", "utf8");
  });

  function discover(mode: string) {
    return spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        driver,
        "-ModulePath",
        modulePath,
        "-PackageRoot",
        packageRoot,
        "-LocalAppDataPath",
        localAppData,
        "-Mode",
        mode,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
  }

  function discoverStatus(mode: string) {
    return spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        driver,
        "-ModulePath",
        modulePath,
        "-PackageRoot",
        packageRoot,
        "-LocalAppDataPath",
        localAppData,
        "-Mode",
        mode,
        "-StatusOnly",
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
  }

  it("prefers a dynamically named Desktop cache entry only when its hash matches", () => {
    const cacheCodex = join(
      localAppData,
      "OpenAI",
      "Codex",
      "bin",
      "future-random-generation",
      "codex.exe",
    );
    mkdirSync(dirname(cacheCodex), { recursive: true });
    writeFileSync(cacheCodex, readFileSync(bundledCodex));

    const result = discover("valid");

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const runtime = JSON.parse(result.stdout) as RuntimeResult;
    expect(runtime).toMatchObject({
      Signature: "codex-local-remote/codex-desktop-runtime/v1",
      PackageFullName: "OpenAI.Codex_dynamic-fixture_x64__2p2nqsd0c76g0",
      PackageVersion: "999.1.2.3",
      CodexPath: resolve(cacheCodex),
      Source: "desktop-cache-hash-match",
    });
    expect(runtime.CodexSha256).toMatch(/^[0-9A-F]{64}$/u);
    expect(runtime.CodexSha256).toBe(runtime.BundledCodexSha256);
  });

  it("uses the current package runtime when no hydrated cache exists", () => {
    const result = discover("valid");

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout) as RuntimeResult).toMatchObject({
      CodexPath: resolve(bundledCodex),
      Source: "package-bundled",
    });
  });

  it("ignores stale cache generations whose content does not match the package", () => {
    const staleCodex = join(localAppData, "OpenAI", "Codex", "bin", "old-fixed-hash", "codex.exe");
    mkdirSync(dirname(staleCodex), { recursive: true });
    writeFileSync(staleCodex, "old runtime", "utf8");

    const result = discover("valid");

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout) as RuntimeResult).toMatchObject({
      CodexPath: resolve(bundledCodex),
      Source: "package-bundled",
    });
  });

  it.each([
    ["missing-package", "found 0"],
    ["multiple-packages", "found 2"],
    ["unhealthy-package", "found 0"],
    ["foreign-running-desktop", "different package generation"],
  ])("fails closed for %s with a clear diagnostic", (mode, message) => {
    const result = discover(mode);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(message);
    expect(`${result.stdout}${result.stderr}`).toContain(
      mode === "foreign-running-desktop" ? "left untouched" : "Remote startup is disabled",
    );
  });

  it("keeps the persistent task definition free of package versions and cache hashes", () => {
    const module = readFileSync(modulePath, "utf8");
    const start = module.indexOf("function Get-StartupTaskDefinition");
    const end = module.indexOf("\nfunction Get-PinnedStartupTaskDefinitionV2", start);
    const definition = module.slice(start, end);
    expect(definition).not.toContain("WindowsApps");
    expect(definition).not.toContain("OpenAI.Codex");
    expect(definition).not.toContain("'-CodexPath'");
    expect(definition).not.toContain("$resolvedCodex");
  });

  it("provides a bounded package-generation identity for routine status checks", () => {
    const result = discoverStatus("valid");

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      Signature: "codex-local-remote/codex-desktop-package-status/v1",
      PackageFullName: "OpenAI.Codex_dynamic-fixture_x64__2p2nqsd0c76g0",
      PackageVersion: "999.1.2.3",
      Source: "package-metadata",
      CodexSha256: null,
    });
  });
});
