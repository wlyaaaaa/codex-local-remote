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
});
