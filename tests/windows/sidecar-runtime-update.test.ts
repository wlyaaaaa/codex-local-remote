import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");
const windowsPath = (name: string) => join(repositoryRoot, "scripts", "windows", name);
const fixturePath = join(
  repositoryRoot,
  "tests",
  "windows",
  "fixtures",
  "sidecar-runtime-update-transaction-driver.ps1",
);

interface Result {
  Status: string;
  SidecarProcessId: number;
  Failure: string;
  Events: string[];
}

function run(mode: string): Result {
  const result = spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      fixturePath,
      "-ModulePath",
      windowsPath("CodexLocalRemote.Windows.psm1"),
      "-Mode",
      mode,
    ],
    { encoding: "utf8" },
  );
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as Result;
}

describe("Sidecar-only immutable runtime update", () => {
  it("adopts the selected Sidecar without touching Broker or Desktop", () => {
    expect(run("success")).toEqual({
      Status: "updated",
      SidecarProcessId: 200,
      Failure: "",
      Events: ["stop-old", "start-new", "verify-new-200"],
    });
  });

  it("restores the old Sidecar when the selected child fails", () => {
    const result = run("new-start-fails");

    expect(result).toMatchObject({
      Status: "rolled-back",
      SidecarProcessId: 100,
      Events: ["stop-old", "start-new", "start-old", "verify-old-100"],
    });
    expect(result.Failure).toContain("injected new Sidecar failure");
  });

  it("fails closed on Broker identity drift and restores the old Sidecar", () => {
    const result = run("invariant-drifts");

    expect(result).toMatchObject({
      Status: "rolled-back",
      SidecarProcessId: 100,
      Events: ["stop-old", "start-old", "verify-old-100"],
    });
    expect(result.Failure).toContain("BrokerProcessId");
  });

  it("fails closed on selected runtime drift and restores the old Sidecar", () => {
    const result = run("selected-runtime-drifts");

    expect(result).toMatchObject({
      Status: "rolled-back",
      SidecarProcessId: 100,
      Events: ["stop-old", "start-old", "verify-old-100"],
    });
    expect(result.Failure).toContain("SelectedVersionId");
  });

  it("does not stop the old Sidecar while managed turns are active", () => {
    const result = run("active-turns");

    expect(result.Status).toBe("failed");
    expect(result.Events).toEqual([]);
    expect(result.Failure).toContain("safe connected lease");
  });

  it("does not stop the old Sidecar across a Broker/Sidecar compatibility boundary", () => {
    const result = run("compatibility-mismatch");

    expect(result.Status).toBe("failed");
    expect(result.Events).toEqual([]);
    expect(result.Failure).toContain("safe connected lease");
  });

  it("keeps legacy manifests valid while exposing no hot-update compatibility", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "codex-runtime-compat-"));
    try {
      const result = spawnSync(
        "pwsh",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          join(
            repositoryRoot,
            "tests",
            "windows",
            "fixtures",
            "runtime-manifest-compatibility-driver.ps1",
          ),
          "-ModulePath",
          windowsPath("CodexLocalRemote.Windows.psm1"),
          "-SandboxRoot",
          sandbox,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        LegacyValid: true,
        LegacyCompatibility: "",
        CurrentValid: true,
        CurrentCompatibility: "codex-local-remote/broker-sidecar/v1",
      });
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  });

  it("surfaces a bounded rollback failure without a Broker/Desktop restart path", () => {
    const result = run("rollback-fails");

    expect(result.Status).toBe("failed");
    expect(result.SidecarProcessId).toBe(0);
    expect(result.Failure).toContain("rollback failed without restarting Broker or Desktop");
    expect(result.Events).toEqual(["stop-old", "start-new", "start-old"]);
  });

  it("binds the live supervisor to selected immutable roots, not startup paths", () => {
    const start = readFileSync(windowsPath("Start-CodexLocalRemote.ps1"), "utf8");
    const updateStart = start.indexOf("Invoke-CodexLocalRemoteSidecarUpdateTransaction");
    const updateEnd = start.indexOf("if ($DesktopOwnerCoordinator", updateStart);
    const update = start.slice(updateStart, updateEnd);

    expect(start).toContain("Get-VerifiedSidecarRuntimeBinding");
    expect(start).toContain("Get-SidecarOnlyUpdateInvariant");
    expect(start).toContain("Get-CodexLocalRemoteCurrentRuntime");
    expect(start).toContain("Test-CodexLocalRemoteRuntimeVersion");
    expect(start).toContain("unsafeThreadCount");
    expect(start).toContain("unknownCount");
    expect(start).toContain("desktopConnected");
    expect(update).toContain("Start-ManagedSidecarChild");
    expect(update).not.toContain("Stop-CodexAppServerBroker");
    expect(update).not.toContain("Stop-ProcessIdentityHandle `\n");
    expect(update).not.toContain("CloseMainWindow");
  });

  it("keeps public close Sidecar-only until Desktop exits naturally", () => {
    const start = readFileSync(windowsPath("Start-CodexLocalRemote.ps1"), "utf8");
    const nativeStart = start.indexOf("if ([string]$desiredMode.Mode -ceq 'Native')");
    const recoveryStart = start.indexOf(
      "if ($null -eq $sidecarProcess -or $sidecarProcess.HasExited)",
      nativeStart,
    );
    const native = start.slice(nativeStart, recoveryStart);

    expect(native).toContain("Stop-ManagedSidecarChildExact");
    expect(native).toContain("$remainingDesktopRoots.Count -eq 0");
    expect(native).toContain("Stop-ExactManagedBrokerAndOrphan");
    expect(native).not.toContain("CloseMainWindow");
    expect(native).not.toContain("Stop-ScheduledTask");
    expect(start).toContain("$null -ne $pendingIntent -and");
    expect(start).toContain("$null -eq $desktopOwnerResumeSuppressedAtUtc");
  });
});
