import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");
const startScript = join(repositoryRoot, "scripts", "windows", "Start-CodexLocalRemote.ps1");
const fixture = join(
  repositoryRoot,
  "tests",
  "windows",
  "fixtures",
  "supervisor-broker-adoption-driver.ps1",
);

interface AdoptionResult {
  AdoptedFromPrevious: boolean;
  Reason: string;
  BrokerCliPath: string;
  BrokerRuntimeVersionId: string;
  BrokerRuntimeRoot: string;
  BrokerRuntimeManifestSha256: string;
  PayloadCompatibilityReason: string;
  BrokerOrDesktopStartStopCount: number;
  Events: string[];
  ReceiptVersion: number;
  ReceiptBrokerCliPath: string;
  ReceiptSupervisorRuntimeVersionId: string;
  ReceiptSupervisorRuntimeRoot: string;
  ReceiptSupervisorRuntimeManifestSha256: string;
  ReceiptSidecarRuntimeVersionId: string;
  ReceiptSidecarRuntimeRoot: string;
  ReceiptSidecarRuntimeManifestSha256: string;
  ReceiptBrokerRuntimeVersionId: string;
  ReceiptBrokerRuntimeRoot: string;
  ReceiptBrokerRuntimeManifestSha256: string;
  ReceiptSupervisorOnlyAdoptedPreviousBroker: boolean;
  DesktopProofValid: boolean;
  DesktopProofReason: string;
  DesktopProofRootIdentityKey: string;
  RecoveryStatus: string;
  RecoveryReason: string;
  RecoveryWriteCount: number;
  RecoveryReadCount: number;
  RecoveryRemoveCount: number;
  RecoveryProofFileExists: boolean;
  RecoveryObservationDelayCount: number;
  RecoveryProofRootIdentityKey: string;
  RecoveryProofLaunchNonceDigest: string;
}

function run(mode: string): AdoptionResult {
  const sandbox = mkdtempSync(join(tmpdir(), "codex-broker-adoption-"));
  try {
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        fixture,
        "-StartScriptPath",
        startScript,
        "-SandboxRoot",
        sandbox,
        "-Mode",
        mode,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    return JSON.parse(result.stdout) as AdoptionResult;
  } finally {
    rmSync(sandbox, { force: true, recursive: true });
  }
}

describe("Current supervisor exact-Previous Broker adoption", () => {
  it("reuses the real Previous Broker path while keeping Current Sidecar ownership", () => {
    const result = run("success");

    expect(result.AdoptedFromPrevious).toBe(true);
    expect(normalize(result.BrokerCliPath)).toContain(
      normalize(join("apps", "broker", "dist", "cli.js")),
    );
    expect(result.BrokerCliPath).toContain("b".repeat(64));
    expect(result.BrokerRuntimeVersionId).toBe("b".repeat(64));
    expect(result.BrokerRuntimeRoot).toContain("b".repeat(64));
    expect(result.BrokerRuntimeManifestSha256).toBe("e".repeat(64));
    expect(result.PayloadCompatibilityReason).toBe("fixture-payload-match");
    expect(result.BrokerOrDesktopStartStopCount).toBe(0);
    expect(result.Events).toEqual(["payload-checked"]);
    expect(result.ReceiptVersion).toBe(3);
    expect(result.ReceiptBrokerCliPath).toBe(result.BrokerCliPath);
    expect(result.ReceiptSupervisorRuntimeVersionId).toBe("c".repeat(64));
    expect(result.ReceiptSupervisorRuntimeRoot).toContain("c".repeat(64));
    expect(result.ReceiptSupervisorRuntimeManifestSha256).toBe("a".repeat(64));
    expect(result.ReceiptSidecarRuntimeVersionId).toBe("c".repeat(64));
    expect(result.ReceiptSidecarRuntimeRoot).toContain("c".repeat(64));
    expect(result.ReceiptSidecarRuntimeManifestSha256).toBe("a".repeat(64));
    expect(result.ReceiptBrokerRuntimeVersionId).toBe("b".repeat(64));
    expect(result.ReceiptBrokerRuntimeRoot).toContain("b".repeat(64));
    expect(result.ReceiptBrokerRuntimeManifestSha256).toBe("e".repeat(64));
    expect(result.ReceiptSupervisorOnlyAdoptedPreviousBroker).toBe(true);
  });

  it.each([
    ["payload-mismatch", "payload"],
    ["old-sidecar-live", "Sidecar receipt PID"],
    ["sidecar-port-occupied", "Sidecar port"],
    ["broker-identity-drift", "Broker identity"],
    ["upstream-identity-drift", "upstream identity"],
    ["invocation-identity-drift", "runtime invocation"],
  ])("fails closed for %s", (mode, reasonFragment) => {
    const result = run(mode);

    expect(result.AdoptedFromPrevious).toBe(false);
    expect(result.Reason).toContain(reasonFragment);
    expect(result.BrokerCliPath).toBe("");
    expect(result.BrokerOrDesktopStartStopCount).toBe(0);
  });

  it("wires adoption before exact managed-process verification and records v3 identities", () => {
    const source = readFileSync(startScript, "utf8");
    const adoptionFunctionStart = source.indexOf("function Get-PreviousBrokerAdoptionBinding");
    const adoptionFunctionEnd = source.indexOf(
      "function Stop-ExactManagedBrokerAndOrphan",
      adoptionFunctionStart,
    );
    const adoptionFunction = source.slice(adoptionFunctionStart, adoptionFunctionEnd);
    const adoptionCall = source.indexOf(
      "$previousBrokerAdoption = Get-PreviousBrokerAdoptionBinding",
    );
    const managedVerification = source.indexOf(
      "$brokerProcess = Get-VerifiedManagedBroker",
      adoptionCall,
    );

    expect(adoptionFunctionStart).toBeGreaterThan(-1);
    expect(adoptionFunction).toContain("Test-CodexLocalRemoteBrokerPayloadCompatibility");
    expect(adoptionFunction).not.toContain("Stop-ExactManagedBrokerAndOrphan");
    expect(adoptionFunction).not.toContain("Start-Process");
    expect(adoptionFunction).not.toContain("Invoke-ManagedDesktopLaunch");
    expect(adoptionCall).toBeGreaterThan(-1);
    expect(managedVerification).toBeGreaterThan(adoptionCall);
    expect(source).toContain("SupervisorRuntimeVersionId =");
    expect(source).toContain("SupervisorRuntimeRoot =");
    expect(source).toContain("SupervisorRuntimeManifestSha256 =");
    expect(source).toContain("SidecarRuntimeVersionId =");
    expect(source).toContain("SidecarRuntimeRoot =");
    expect(source).toContain("SidecarRuntimeManifestSha256 =");
    expect(source).toContain("BrokerRuntimeVersionId =");
    expect(source).toContain("BrokerRuntimeRoot =");
    expect(source).toContain("BrokerRuntimeManifestSha256 =");
    expect(source).toContain("SupervisorOnlyAdoptedPreviousBroker =");
    expect(source).toContain("Signature = 'codex-local-remote/app-server-broker/v3'");
    expect(source).toContain("Version = 3");
    expect(source).toMatch(
      /if \(-not \$brokerRuntimeAdoptedFromPrevious\) \{\s+Write-BrokerRuntimeReceipt\s+`\s+-Status 'broker-ready'/u,
    );
  });

  it("preserves an exact existing Desktop owner proof without launching Desktop again", () => {
    const result = run("proof-preserved");

    expect(result.AdoptedFromPrevious).toBe(true);
    expect(result.DesktopProofValid).toBe(true);
    expect(result.DesktopProofReason).toBe("existing-owner-proof-preserved");
    expect(result.DesktopProofRootIdentityKey).toBe(`42001|638500000000000000|${"9".repeat(64)}`);
    expect(result.BrokerOrDesktopStartStopCount).toBe(0);
  });

  it.each([
    ["proof-missing", "cannot be reconstructed"],
    ["proof-multiple-connections", "exactly one Desktop connection"],
    ["proof-identity-drift", "Broker runtime identity"],
    ["proof-independent-stdio", "independent stdio"],
  ])("fails closed without launching Desktop for %s", (mode, reasonFragment) => {
    const result = run(mode);

    expect(result.AdoptedFromPrevious).toBe(true);
    expect(result.DesktopProofValid).toBe(false);
    expect(result.DesktopProofReason).toContain(reasonFragment);
    expect(result.DesktopProofRootIdentityKey).toBe("");
    expect(result.BrokerOrDesktopStartStopCount).toBe(0);
  });

  it("routes adopted startup around the destructive Desktop launcher", () => {
    const source = readFileSync(startScript, "utf8");
    const coordinatorStart = source.indexOf("if ($DesktopOwnerCoordinator)");
    const handoffBranch = source.indexOf(
      "elseif ($desktopHandoffPreparationPathPresent",
      coordinatorStart,
    );
    const adoptedBranch = source.slice(coordinatorStart, handoffBranch);

    expect(coordinatorStart).toBeGreaterThan(-1);
    expect(handoffBranch).toBeGreaterThan(coordinatorStart);
    expect(adoptedBranch).toContain("$brokerRuntimeAdoptedFromPrevious");
    expect(adoptedBranch).toContain("adopted-existing-owner-proof");
    expect(adoptedBranch).toContain("adopted-owner-proof-blocked");
    expect(adoptedBranch).not.toContain("Invoke-ManagedDesktopLaunch");
    expect(adoptedBranch).not.toContain("Remove-CodexDesktopOwnerConnectionProof");
    expect(adoptedBranch).not.toContain("Write-CodexDesktopOwnerConnectionProof");
  });

  it("keeps later owner recovery and runtime checks fail closed for adopted Broker state", () => {
    const source = readFileSync(startScript, "utf8");
    const recoveryStart = source.indexOf("if ($DesktopOwnerCoordinator -and");
    const recoveryEnd = source.indexOf(
      "$runtimeDecision = Get-SharedRuntimeDecision",
      recoveryStart,
    );
    const recovery = source.slice(recoveryStart, recoveryEnd);
    const runtimeCheckStart = source.indexOf(
      "if ($desktopRuntimeCheckClock.ElapsedMilliseconds",
      recoveryEnd,
    );
    const runtimeCheckEnd = source.indexOf("Start-Sleep -Seconds 1", runtimeCheckStart);
    const runtimeCheck = source.slice(runtimeCheckStart, runtimeCheckEnd);

    expect(recoveryStart).toBeGreaterThan(-1);
    expect(recoveryEnd).toBeGreaterThan(recoveryStart);
    expect(recovery).toMatch(
      /-StartupIntentPending \(\s+\$desktopOwnerState\.StartupIntentPending -and\s+-not \$brokerRuntimeAdoptedFromPrevious\s+\)/u,
    );
    expect(recovery).toMatch(
      /-HasPendingIntent \(\s+\$null -ne \$pendingIntent -and\s+-not \$brokerRuntimeAdoptedFromPrevious\s+\)/u,
    );
    expect(runtimeCheckStart).toBeGreaterThan(recoveryEnd);
    expect(runtimeCheckEnd).toBeGreaterThan(runtimeCheckStart);
    expect(runtimeCheck).toContain("Get-AdoptedDesktopOwnerProofBinding");
    expect(runtimeCheck).toContain("Get-IndependentDesktopAppServerProcessIds");
  });

  it("atomically rebuilds only a missing proof after two identical strict observations", () => {
    const result = run("recovery-success");

    expect(result.AdoptedFromPrevious).toBe(true);
    expect(result.RecoveryStatus).toBe("recovered");
    expect(result.RecoveryReason).toBe("missing-owner-proof-recovered-from-stable-live-binding");
    expect(result.RecoveryWriteCount).toBe(1);
    expect(result.RecoveryReadCount).toBeGreaterThanOrEqual(1);
    expect(result.RecoveryRemoveCount).toBe(0);
    expect(result.RecoveryProofFileExists).toBe(true);
    expect(result.RecoveryObservationDelayCount).toBe(1);
    expect(result.RecoveryProofRootIdentityKey).toBe(`42001|638500000000000000|${"9".repeat(64)}`);
    expect(result.RecoveryProofLaunchNonceDigest).toBe("7".repeat(64));
    expect(result.BrokerOrDesktopStartStopCount).toBe(0);
  });

  it("removes only its recovered proof when the strict post-commit observation drifts", () => {
    const result = run("recovery-post-commit-root-drift");

    expect(result.AdoptedFromPrevious).toBe(true);
    expect(result.RecoveryStatus).toBe("blocked");
    expect(result.RecoveryReason).toContain("post-commit");
    expect(result.RecoveryReason).toContain("Desktop root binding changed");
    expect(result.RecoveryWriteCount).toBe(1);
    expect(result.RecoveryReadCount).toBeGreaterThanOrEqual(2);
    expect(result.RecoveryRemoveCount).toBe(1);
    expect(result.RecoveryProofFileExists).toBe(false);
    expect(result.BrokerOrDesktopStartStopCount).toBe(0);
  });

  it.each([
    ["recovery-receipt-drift", "receipt raw bytes changed"],
    ["recovery-root-drift", "Desktop root binding changed"],
    ["recovery-nonce-drift", "Desktop launch nonce digest changed"],
    ["recovery-runtime-drift", "runtime identity"],
    ["recovery-multiple-connections", "one exact healthy Desktop connection"],
    ["recovery-unknown-readiness", "runtime identity"],
    ["recovery-multiple-roots", "exactly one Desktop root"],
    ["recovery-independent-stdio", "independent stdio"],
    ["recovery-payload-drift", "payload compatibility"],
    ["recovery-proof-race", "owner proof appeared"],
  ])("does not write proof when %s", (mode, reasonFragment) => {
    const result = run(mode);

    expect(result.AdoptedFromPrevious).toBe(true);
    expect(result.RecoveryStatus).toBe("blocked");
    expect(result.RecoveryReason).toContain(reasonFragment);
    expect(result.RecoveryWriteCount).toBe(0);
    expect(result.BrokerOrDesktopStartStopCount).toBe(0);
  });

  it("keeps recovery preserve-only and wires it only inside adopted startup", () => {
    const source = readFileSync(startScript, "utf8");
    const recoveryStart = source.indexOf("function Invoke-AdoptedDesktopOwnerProofRecovery");
    const recoveryEnd = source.indexOf("function Stop-ExactManagedBrokerAndOrphan", recoveryStart);
    const recovery = source.slice(recoveryStart, recoveryEnd);
    const adoptedStartupStart = source.indexOf(
      "if ($brokerRuntimeAdoptedFromPrevious)",
      source.indexOf("$adoptedDesktopOwnerProofBinding = $null"),
    );
    const coordinatorStart = source.indexOf("if ($DesktopOwnerCoordinator)", adoptedStartupStart);
    const adoptedStartup = source.slice(adoptedStartupStart, coordinatorStart);

    expect(recoveryStart).toBeGreaterThan(-1);
    expect(recoveryEnd).toBeGreaterThan(recoveryStart);
    expect(recovery.match(/Get-AdoptedDesktopOwnerRecoveryObservation/g)).toHaveLength(3);
    expect(recovery).toContain("Test-AdoptedDesktopOwnerRecoveryObservationPair");
    expect(recovery).toContain("Write-CodexDesktopOwnerConnectionProof");
    expect(recovery).toContain("Read-CodexDesktopOwnerConnectionProof");
    expect(recovery).toContain("Start-Sleep -Milliseconds");
    expect(recovery).not.toContain("Start-Process");
    expect(recovery).not.toContain("Stop-Process");
    expect(recovery).not.toContain("Invoke-ManagedDesktopLaunch");
    expect(recovery).toContain("Remove-CodexDesktopOwnerConnectionProof");
    expect(adoptedStartupStart).toBeGreaterThan(-1);
    expect(coordinatorStart).toBeGreaterThan(adoptedStartupStart);
    expect(adoptedStartup).toContain("Invoke-AdoptedDesktopOwnerProofRecovery");
  });
});
