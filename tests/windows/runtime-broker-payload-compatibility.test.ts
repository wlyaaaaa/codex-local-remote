import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const modulePath = join(repositoryRoot, "scripts", "windows", "CodexLocalRemote.Windows.psm1");
const driverPath = join(
  import.meta.dirname,
  "fixtures",
  "runtime-broker-payload-compatibility-driver.ps1",
);

interface RuntimeIdentity {
  IsValid: boolean;
  ValidationReason: string;
  RuntimeRoot: string;
  VersionId: string;
  ManifestSha256: string;
  BrokerSidecarCompatibilityId: string;
  PayloadSha256: string | null;
  PayloadFileCount: number;
}

interface CompatibilityResult {
  IsCompatible: boolean;
  Reason: string;
  Current: RuntimeIdentity;
  Active: RuntimeIdentity;
}

function run(mode: string): CompatibilityResult {
  const sandbox = mkdtempSync(join(tmpdir(), `codex-runtime-broker-compat-${process.pid}-`));
  try {
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        driverPath,
        "-ModulePath",
        modulePath,
        "-SandboxRoot",
        sandbox,
        "-Mode",
        mode,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    return JSON.parse(result.stdout) as CompatibilityResult;
  } finally {
    rmSync(sandbox, { force: true, recursive: true });
  }
}

windowsOnly("immutable runtime Broker execution-payload compatibility", () => {
  it("accepts distinct valid runtimes only when their closed Broker payloads are exact", () => {
    const result = run("exact");

    expect(result).toMatchObject({
      IsCompatible: true,
      Reason: "compatible",
      Current: {
        BrokerSidecarCompatibilityId: "codex-local-remote/broker-sidecar/v1",
        PayloadFileCount: 3,
      },
      Active: {
        BrokerSidecarCompatibilityId: "codex-local-remote/broker-sidecar/v1",
        PayloadFileCount: 3,
      },
    });
    expect(result.Current.VersionId).not.toBe(result.Active.VersionId);
    expect(result.Current.PayloadSha256).toBe(result.Active.PayloadSha256);
  });

  it("rejects a changed Broker file even when the compatibility id matches", () => {
    const result = run("broker-difference");

    expect(result.IsCompatible).toBe(false);
    expect(result.Reason).toBe("broker-payload-content-mismatch");
    expect(result.Current.PayloadSha256).not.toBe(result.Active.PayloadSha256);
  });

  it("rejects a changed package.json even when Broker dist is unchanged", () => {
    const result = run("package-difference");

    expect(result.IsCompatible).toBe(false);
    expect(result.Reason).toBe("package-json-mismatch");
  });

  it.each(["broker-missing", "broker-extra"])("rejects a %s file-set difference", (mode) => {
    const result = run(mode);

    expect(result.IsCompatible).toBe(false);
    expect(result.Reason).toBe("broker-payload-file-set-mismatch");
  });

  it("rejects matching payload bytes across a declared compatibility boundary", () => {
    const result = run("compatibility-mismatch");

    expect(result.IsCompatible).toBe(false);
    expect(result.Reason).toBe("broker-sidecar-compatibility-mismatch");
  });

  it("rejects a caller manifest identity that does not match the stable manifest bytes", () => {
    const result = run("manifest-identity-mismatch");

    expect(result.IsCompatible).toBe(false);
    expect(result.Reason).toBe("current-manifest-identity-mismatch");
  });

  it("returns an incompatible result rather than throwing for runtime path failures", () => {
    const result = run("missing-runtime");

    expect(result.IsCompatible).toBe(false);
    expect(result.Reason).toBe("current-runtime-invalid");
    expect(result.Current.IsValid).toBe(false);
    expect(result.Active).toMatchObject({ IsValid: true, ValidationReason: "valid" });
  });
});
