import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const modulePath = join(repositoryRoot, "scripts", "windows", "CodexLocalRemote.Windows.psm1");
const driver = join(import.meta.dirname, "fixtures", "runtime-version-package-driver.ps1");

interface RuntimePackageResult {
  FirstVersionId: string;
  SecondVersionId: string;
  FirstRuntimeExists: boolean;
  SecondRuntimeExists: boolean;
  ManifestExists: boolean;
  CurrentVersionId: string;
  PreviousVersionId: string;
  FirstPointerPrevious: null;
  SecondPointerPrevious: string;
  RollbackCurrent: string;
  RollbackPrevious: string;
  StagingValid: boolean;
  StrictStagingValid: boolean;
  StrictStagingReason: string;
  TamperedValid: boolean;
  TamperedReason: string;
}

windowsOnly("immutable runtime version package", () => {
  let sandbox = "";

  beforeEach(() => {
    sandbox = join(tmpdir(), `codex-runtime-version-${process.pid}-${crypto.randomUUID()}`);
    mkdirSync(sandbox, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("installs content-addressed versions, keeps one rollback pointer, and detects drift", () => {
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        driver,
        "-ModulePath",
        modulePath,
        "-Sandbox",
        sandbox,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const runtime = JSON.parse(result.stdout) as RuntimePackageResult;
    expect(runtime.FirstVersionId).toMatch(/^[a-f0-9]{64}$/u);
    expect(runtime.SecondVersionId).toMatch(/^[a-f0-9]{64}$/u);
    expect(runtime.SecondVersionId).not.toBe(runtime.FirstVersionId);
    expect(runtime).toMatchObject({
      FirstRuntimeExists: true,
      SecondRuntimeExists: true,
      ManifestExists: true,
      CurrentVersionId: runtime.SecondVersionId,
      PreviousVersionId: runtime.FirstVersionId,
      FirstPointerPrevious: null,
      SecondPointerPrevious: runtime.FirstVersionId,
      RollbackCurrent: runtime.FirstVersionId,
      RollbackPrevious: runtime.SecondVersionId,
      StagingValid: true,
      StrictStagingValid: false,
      TamperedValid: false,
    });
    expect(runtime.StrictStagingReason).toMatch(/directory name/u);
    expect(runtime.TamperedReason).toMatch(/(?:hash|size)/u);
  }, 30_000);
});
