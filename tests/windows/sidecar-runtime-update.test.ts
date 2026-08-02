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
  const sandbox = mkdtempSync(join(tmpdir(), "codex-sidecar-update-"));
  try {
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
        "-SandboxRoot",
        sandbox,
        "-Mode",
        mode,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    return JSON.parse(result.stdout) as Result;
  } finally {
    rmSync(sandbox, { force: true, recursive: true });
  }
}

const updateId = "d".repeat(32);
const drainedEvent = `drain-old-${updateId}`;

describe("Sidecar-only immutable runtime update", () => {
  it("adopts the selected Sidecar without touching Broker or Desktop", () => {
    expect(run("success")).toMatchObject({
      Status: "updated",
      SidecarProcessId: 200,
      Failure: "",
      Events: [drainedEvent, "stop-old", "start-new", "verify-new-200"],
    });
  });

  it("restores the old Sidecar when the selected child fails", () => {
    const result = run("new-start-fails");

    expect(result).toMatchObject({
      Status: "rolled-back",
      SidecarProcessId: 100,
      Events: [drainedEvent, "stop-old", "start-new", "start-old", "verify-old-100"],
    });
    expect(result.Failure).toContain("injected new Sidecar failure");
  });

  it("restores the drained Sidecar on a transient Broker identity observation", () => {
    const result = run("invariant-drifts");

    expect(result).toMatchObject({
      Status: "rolled-back",
      SidecarProcessId: 100,
      Events: [drainedEvent, "start-old", "verify-old-100"],
    });
    expect(result.Failure).toContain("BrokerProcessId");
  });

  it("restores the drained Sidecar on a transient selected-runtime observation", () => {
    const result = run("selected-runtime-drifts");

    expect(result).toMatchObject({
      Status: "rolled-back",
      SidecarProcessId: 100,
      Events: [drainedEvent, "start-old", "verify-old-100"],
    });
    expect(result.Failure).toContain("SelectedVersionId");
  });

  it("restores serving when the selected runtime keeps drifting after drain", () => {
    const result = run("selected-runtime-persists");

    expect(result).toMatchObject({
      Status: "rolled-back",
      SidecarProcessId: 100,
      Events: [drainedEvent, "start-old", "verify-old-100"],
    });
    expect(result.Failure).toContain("Selected runtime drifted");
  });

  it("updates the Sidecar while managed turns remain active", () => {
    expect(run("active-turns")).toMatchObject({
      Status: "updated",
      SidecarProcessId: 200,
      Failure: "",
      Events: [drainedEvent, "stop-old", "start-new", "verify-new-200"],
    });
  });

  it("restores the old Sidecar when a drained active update cannot start", () => {
    const result = run("active-new-start-fails");

    expect(result).toMatchObject({
      Status: "rolled-back",
      SidecarProcessId: 100,
      Events: [drainedEvent, "stop-old", "start-new", "start-old", "verify-old-100"],
    });
  });

  it("does not stop the old Sidecar while the Broker has an unknown connection", () => {
    const result = run("unknown-connection");

    expect(result.Status).toBe("failed");
    expect(result.Events).toEqual([]);
    expect(result.Failure).toContain("safe connected lease");
  });

  it("rejects an invalid active-turn observation before preparing the old Sidecar", () => {
    const result = run("invalid-active-count");

    expect(result.Status).toBe("failed");
    expect(result.Events).toEqual([]);
    expect(result.Failure).toContain("safe connected lease");
  });

  it("does not stop the old Sidecar when its bound drain fails", () => {
    const result = run("drain-fails");

    expect(result).toMatchObject({
      Status: "failed",
      SidecarProcessId: 0,
      Events: [drainedEvent],
    });
    expect(result.Failure).toContain("injected old Sidecar drain failure");
  });

  it("does not stop the old Sidecar for a mismatched drain receipt", () => {
    const result = run("drain-receipt-mismatch");

    expect(result).toMatchObject({
      Status: "failed",
      SidecarProcessId: 0,
      Events: [drainedEvent],
    });
    expect(result.Failure).toContain("drain receipt is invalid or unbound");
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
    expect(result.Events).toEqual([drainedEvent, "stop-old", "start-new", "start-old"]);
  });

  it("does not compensate across a persistent owner identity drift", () => {
    const result = run("rollback-owner-drifts");

    expect(result.Status).toBe("failed");
    expect(result.SidecarProcessId).toBe(0);
    expect(result.Events).toEqual([drainedEvent]);
    expect(result.Failure).toContain("rollback invariant drifted at 'BrokerProcessId'");
  });

  it("does not compensate while the Broker has an unknown connection", () => {
    const result = run("rollback-unknown-connection");

    expect(result.Status).toBe("failed");
    expect(result.SidecarProcessId).toBe(0);
    expect(result.Events).toEqual([drainedEvent]);
    expect(result.Failure).toContain("rollback invariant is not one safe owner lease");
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
    expect(start).toContain("--maintenance-token-file");
    expect(start).toContain("RandomNumberGenerator]::Fill");
    expect(start).toContain("X-Codex-Update-Id");
    expect(update).toContain("Invoke-ManagedSidecarDrain");
    expect(update).toContain("-PrepareOldSidecar");
    expect(update).toContain("-CaptureRollbackInvariant");
    expect(update).toContain("Start-ManagedSidecarChild");
    expect(update).not.toContain("Stop-CodexAppServerBroker");
    expect(update).not.toContain("Stop-ProcessIdentityHandle `\n");
    expect(update).not.toContain("CloseMainWindow");
  });

  it("captures rollback safety without reading the selected target", () => {
    const start = readFileSync(windowsPath("Start-CodexLocalRemote.ps1"), "utf8");
    const rollbackStart = start.indexOf("function Get-SidecarOnlyRollbackInvariant");
    const rollbackEnd = start.indexOf("function Invoke-ManagedSidecarDrain", rollbackStart);
    const rollbackCapture = start.slice(rollbackStart, rollbackEnd);

    expect(rollbackCapture).toContain("Test-CodexLocalRemoteRuntimeVersion");
    expect(rollbackCapture).toContain("Get-SidecarOwnerLeaseInvariant");
    expect(rollbackCapture).not.toContain("Get-CodexLocalRemoteCurrentRuntime");
    expect(rollbackCapture).not.toContain("TargetRuntimeBinding");
    expect(rollbackCapture).not.toContain("CandidateSidecarCompatibilityId");
  });

  it("reuses one pending drain id across selected-target drift", () => {
    const start = readFileSync(windowsPath("Start-CodexLocalRemote.ps1"), "utf8");
    const pendingStart = start.indexOf("if ([string]$pendingSidecarUpdateId -cnotmatch");
    const transactionStart = start.indexOf("$sidecarUpdate =", pendingStart);
    const pendingSelection = start.slice(pendingStart, transactionStart);
    const transactionEnd = start.indexOf("if ($DesktopOwnerCoordinator", transactionStart);
    const transaction = start.slice(transactionStart, transactionEnd);

    expect(pendingSelection).toContain("[Guid]::NewGuid().ToString('N')");
    expect(pendingSelection).not.toContain("pendingSidecarUpdateTargetVersionId");
    expect(pendingSelection).not.toContain("pendingSidecarUpdateTargetRoot");
    expect(start).not.toContain("$pendingSidecarUpdateTargetVersionId");
    expect(start).not.toContain("$pendingSidecarUpdateTargetRoot");
    expect(transaction).toContain("$pendingSidecarUpdateId = $null");
    expect(transaction.indexOf("$pendingSidecarUpdateId = $null")).toBeLessThan(
      transaction.indexOf("if ([int]$sidecarUpdate.Sidecar.IdentityHandle.ProcessId"),
    );
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
