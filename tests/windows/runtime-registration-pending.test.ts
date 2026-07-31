import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const registration = join(
  repositoryRoot,
  "scripts",
  "windows",
  "Register-CodexLocalRemoteStartup.ps1",
);
const driver = join(
  import.meta.dirname,
  "fixtures",
  "runtime-registration-pending-gate-driver.ps1",
);
const repairDriver = join(
  import.meta.dirname,
  "fixtures",
  "runtime-registration-repair-driver.ps1",
);

function runGate(mode: string) {
  return spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      driver,
      "-RegistrationPath",
      registration,
      "-Mode",
      mode,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
}

function runRepair(mode: string) {
  const sandbox = join(
    process.env.TEMP ?? repositoryRoot,
    `codex-registration-repair-${process.pid}-${crypto.randomUUID()}`,
  );
  return spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      repairDriver,
      "-RegistrationPath",
      registration,
      "-SandboxRoot",
      sandbox,
      "-Mode",
      mode,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
}

windowsOnly("Windows pending runtime registration gate", () => {
  it.each([
    ["pending-new", "block"],
    ["pending-same", "same-selected"],
    ["damaged-repair", "repair-active"],
    ["stable-new", "continue"],
    ["no-active-pending-new", "block"],
    ["no-active-pending-supersede", "supersede-offline-selected"],
    ["no-active-pending-supersede-mismatch", "block"],
    ["no-active-current-only-supersede", "block"],
    ["no-active-same-supersede", "block"],
    ["active-pending-supersede", "block"],
    ["no-active-current-only-new", "block"],
    ["repair-without-active", "block"],
  ])("resolves %s before registration mutation", (mode, expectedAction) => {
    const result = runGate(mode);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ Action: expectedAction });
  });

  it("exposes an internal active-version repair switch and gates before writes", () => {
    const source = readFileSync(registration, "utf8");
    expect(source).toMatch(
      /\[Parameter\(DontShow\)\]\s+\[ValidatePattern\('\^\[a-f0-9\]\{64\}\$'\)\]\s+\[string\]\$RepairPendingRuntimeFromActiveVersionId/u,
    );
    expect(source).toContain("RepairPendingRuntimeFromActiveVersionId cannot start Remote");
    const gate = source.indexOf("Invoke-RegistrationPendingRuntimeGate");
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(source.indexOf("$existing = Get-ScheduledTask"));
    expect(gate).toBeLessThan(source.indexOf("Protect-CodexLocalRemoteDataDirectory"));
    expect(gate).toBeLessThan(source.indexOf("Install-CodexLocalRemoteRuntimeVersion"));
    expect(source).toContain("$registrationPendingGate.Pointer.CurrentRoot");
    expect(source).toContain("$previousLauncherDefinitions.Add($repairedSelectedDefinition)");
    expect(source).toContain("$activeRuntimeBefore.PreviousRoot");
    const repairStart = source.indexOf("function Repair-RegistrationPendingRuntimeFromActive");
    const repairEnd = source.indexOf("function Invoke-RegistrationPendingRuntimeGate", repairStart);
    const repair = source.slice(repairStart, repairEnd);
    expect(repair).not.toContain("Stop-ScheduledTask");
    expect(repair).not.toContain("Start-ScheduledTask");
    expect(repair).not.toContain("Unregister-ScheduledTask");
    const repairCall = source.indexOf("Repair-RegistrationPendingRuntimeFromActive", repairEnd);
    const secondGate = source.indexOf(
      "$registrationPendingGate = Invoke-RegistrationPendingRuntimeGate",
      repairCall,
    );
    expect(secondGate).toBeGreaterThan(repairCall);
    const secondGateEnd = source.indexOf("$existing = Get-ScheduledTask", secondGate);
    const secondGateValidation = source.slice(secondGate, secondGateEnd);
    expect(secondGateValidation).toContain("Test-RegistrationActiveRuntimeSnapshot");
    expect(secondGateValidation).toContain("Test-RegistrationRuntimePointerSnapshot");
    expect(secondGate).toBeLessThan(
      source.indexOf("Install-CodexLocalRemoteRuntimeVersion", secondGate),
    );
  });

  it("requires an exact explicit offline selected supersession before registration writes", () => {
    const source = readFileSync(registration, "utf8");
    expect(source).toMatch(
      /\[Parameter\(DontShow\)\]\s+\[ValidatePattern\('\^\[a-f0-9\]\{64\}\$'\)\]\s+\[string\]\$SupersedeOfflineSelectedRuntimeVersionId/u,
    );
    expect(source).toContain("SupersedeOfflineSelectedRuntimeVersionId cannot start Remote");
    const gate = source.indexOf("Invoke-RegistrationPendingRuntimeGate");
    const mutation = source.indexOf("$existing = Get-ScheduledTask", gate);
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(mutation).toBeGreaterThan(gate);
    expect(source.slice(gate, mutation)).toContain(
      "Assert-RegistrationOfflineSelectedSupersession",
    );

    const assertionStart = source.indexOf(
      "function Assert-RegistrationOfflineSelectedSupersession",
    );
    const gateDefinition = source.indexOf(
      "function Invoke-RegistrationPendingRuntimeGate",
      assertionStart,
    );
    expect(assertionStart).toBeGreaterThanOrEqual(0);
    expect(gateDefinition).toBeGreaterThan(assertionStart);
    const assertion = source.slice(assertionStart, gateDefinition);
    expect(assertion).toContain("Get-RegistrationRepairTaskEvidence");
    expect(assertion).toContain("Get-CodexLocalRemoteDesiredMode");
    expect(assertion).toContain("Test-RegistrationRuntimePointerSnapshot");
    expect(
      assertion.match(/Get-RegistrationActiveRuntimeEvidence/gu)?.length,
    ).toBeGreaterThanOrEqual(2);

    const shouldProcess = source.indexOf("if ($PSCmdlet.ShouldProcess(", mutation);
    const baseline = source.indexOf("$runtimeBindingBaseline =", shouldProcess);
    const firstMutation = source.indexOf("Protect-CodexLocalRemoteDataDirectory", baseline);
    expect(shouldProcess).toBeGreaterThan(mutation);
    expect(baseline).toBeGreaterThan(shouldProcess);
    expect(firstMutation).toBeGreaterThan(baseline);
    const finalAdmission = source.slice(baseline, firstMutation);
    expect(finalAdmission).toContain("Assert-RegistrationOfflineSelectedSupersession");
    expect(finalAdmission).toContain("Test-RegistrationRuntimePointerSnapshot");
    expect(finalAdmission).toContain("TaskXmlSha256");
  });

  it("heals the proved A/C/B state to active A before the next registration", () => {
    const result = runRepair("success");
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      Succeeded: true,
      Failure: null,
      FinalTask: "active",
      FinalCurrent: "a".repeat(64),
      FinalPrevious: "c".repeat(64),
      Operations: ["register-active-task", "write-active-pointer"],
    });
  });

  it("repairs a pending selection without stopping its running active instance", () => {
    const result = runRepair("success-running");
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      Succeeded: boolean;
      Failure: string | null;
      FinalTask: string;
      FinalTaskState: string;
      FinalCurrent: string;
      FinalPrevious: string;
      Operations: string[];
    };
    expect(receipt).toMatchObject({
      Succeeded: true,
      Failure: null,
      FinalTask: "active",
      FinalTaskState: "Running",
      FinalCurrent: "a".repeat(64),
      FinalPrevious: "c".repeat(64),
      Operations: ["register-active-task", "write-active-pointer"],
    });
    expect(receipt.Operations).not.toContain("stop");
    expect(receipt.Operations).not.toContain("start");
    expect(receipt.Operations).not.toContain("unregister");
  });

  it("does not mutate when active runtime evidence is invalid", () => {
    const result = runRepair("invalid-active");
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      Succeeded: false,
      FinalTask: "selected",
      FinalCurrent: "c".repeat(64),
      FinalPrevious: "b".repeat(64),
      Operations: [],
    });
  });

  it("restores the exact C/B pre-image after a pointer write failure", () => {
    const result = runRepair("pointer-after-effect");
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      Succeeded: false,
      FinalTask: "selected",
      FinalCurrent: "c".repeat(64),
      FinalPrevious: "b".repeat(64),
      Operations: [
        "register-active-task",
        "write-active-pointer",
        "restore-task",
        "restore-pointer",
      ],
    });
  });

  it("restores a running selected pre-image without stop/start after a pointer failure", () => {
    const result = runRepair("pointer-after-effect-running");
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      Succeeded: boolean;
      FinalTask: string;
      FinalTaskState: string;
      FinalCurrent: string;
      FinalPrevious: string;
      Operations: string[];
    };
    expect(receipt).toMatchObject({
      Succeeded: false,
      FinalTask: "selected",
      FinalTaskState: "Running",
      FinalCurrent: "c".repeat(64),
      FinalPrevious: "b".repeat(64),
      Operations: [
        "register-active-task",
        "write-active-pointer",
        "restore-task",
        "restore-pointer",
      ],
    });
    expect(receipt.Operations).not.toContain("stop");
    expect(receipt.Operations).not.toContain("start");
    expect(receipt.Operations).not.toContain("unregister");
  });

  it("restores the running selected pre-image when active receipt identity drifts after mutation", () => {
    const result = runRepair("active-drift-after-running");
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      Succeeded: boolean;
      Failure: string | null;
      FinalTask: string;
      FinalTaskState: string;
      FinalCurrent: string;
      FinalPrevious: string;
      ActiveEvidenceReads: number;
      Operations: string[];
    };
    expect(receipt).toMatchObject({
      Succeeded: false,
      FinalTask: "selected",
      FinalTaskState: "Running",
      FinalCurrent: "c".repeat(64),
      FinalPrevious: "b".repeat(64),
      ActiveEvidenceReads: 4,
      Operations: ["register-active-task", "restore-task"],
    });
    expect(receipt.Failure).toContain("rollback was incomplete");
    expect(receipt.Operations).not.toContain("write-active-pointer");
    expect(receipt.Operations).not.toContain("restore-pointer");
    expect(receipt.Operations).not.toContain("stop");
    expect(receipt.Operations).not.toContain("start");
    expect(receipt.Operations).not.toContain("unregister");
  });

  it("rechecks the complete active snapshot after active task verification and before pointer mutation", () => {
    const result = runRepair("active-drift-before-pointer-running");
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      Succeeded: boolean;
      Failure: string | null;
      FinalPair: string;
      FinalTaskState: string;
      ActiveEvidenceReads: number;
      Operations: string[];
    };
    expect(receipt).toMatchObject({
      Succeeded: false,
      FinalPair: "selected",
      FinalTaskState: "Running",
      ActiveEvidenceReads: 4,
    });
    expect(receipt.Failure).toContain("active runtime");
    expect(receipt.Operations).toContain("register-active-task");
    expect(receipt.Operations).toContain("restore-task");
    expect(receipt.Operations).not.toContain("write-active-pointer");
    expect(receipt.Operations).not.toContain("restore-pointer");
    expect(receipt.Operations).not.toContain("stop");
    expect(receipt.Operations).not.toContain("start");
    expect(receipt.Operations).not.toContain("unregister");
  });

  it("restores one exact pair when the complete active snapshot drifts after pointer mutation", () => {
    const result = runRepair("active-drift-after-pointer-running");
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      Succeeded: boolean;
      Failure: string | null;
      FinalPair: string;
      FinalTaskState: string;
      ActiveEvidenceReads: number;
      Operations: string[];
    };
    expect(receipt).toMatchObject({
      Succeeded: false,
      FinalPair: "selected",
      FinalTaskState: "Running",
      ActiveEvidenceReads: 5,
    });
    expect(receipt.Failure).toContain("active runtime");
    expect(receipt.Operations).toEqual([
      "register-active-task",
      "write-active-pointer",
      "restore-task",
      "restore-pointer",
    ]);
    expect(receipt.Operations).not.toContain("stop");
    expect(receipt.Operations).not.toContain("start");
    expect(receipt.Operations).not.toContain("unregister");
  });

  it.each([
    ["rollback-task-before-effect-running", "restore-task-before-effect"],
    ["rollback-task-after-effect-running", "restore-task-after-effect"],
    ["rollback-pointer-before-effect-running", "restore-pointer-before-effect"],
    ["rollback-pointer-after-effect-running", "restore-pointer-after-effect"],
  ] as const)("never leaves a mixed pair after %s", (mode, expectedFaultOperation) => {
    const result = runRepair(mode);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      Succeeded: boolean;
      Failure: string | null;
      FinalPair: string;
      FinalTaskState: string;
      Operations: string[];
    };
    expect(receipt.Succeeded).toBe(false);
    expect(receipt.Failure).toContain("Pending runtime repair failed");
    expect(["selected", "active"]).toContain(receipt.FinalPair);
    expect(receipt.FinalPair).not.toBe("mixed");
    expect(receipt.FinalTaskState).toBe("Running");
    expect(receipt.Operations).toContain(expectedFaultOperation);
    expect(receipt.Operations).not.toContain("stop");
    expect(receipt.Operations).not.toContain("start");
    expect(receipt.Operations).not.toContain("unregister");
  });

  it("reconstructs an exact active binding after initial registration throws after effect and selected restore persistently fails", () => {
    const result = runRepair("register-active-after-effect-restore-before-running");
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      Succeeded: boolean;
      Failure: string | null;
      FinalTask: string;
      FinalTaskState: string;
      FinalCurrent: string;
      FinalPair: string;
      PointerWritesWithoutBinding: number;
      FinalPointerHasExactActiveBinding: boolean;
      Operations: string[];
    };
    expect(receipt).toMatchObject({
      Succeeded: false,
      FinalTask: "active",
      FinalTaskState: "Running",
      FinalCurrent: "a".repeat(64),
      FinalPair: "active",
      PointerWritesWithoutBinding: 0,
      FinalPointerHasExactActiveBinding: true,
      Operations: [
        "register-active-task-after-effect",
        "restore-task-before-effect",
        "write-active-pointer",
      ],
    });
    expect(receipt.Failure).toContain("fixture active task registration failed after effect");
    expect(receipt.Failure).toContain(
      "the exact active task/pointer pair and live runtime were preserved",
    );
    expect(receipt.Failure).not.toMatch(
      /not been set|cannot retrieve|uninitialized|not recognized/u,
    );
    expect(receipt.Operations).not.toContain("write-active-pointer-without-binding");
    expect(receipt.Operations).not.toContain("stop");
    expect(receipt.Operations).not.toContain("start");
    expect(receipt.Operations).not.toContain("unregister");
  });

  it("reports an explicit mixed-incomplete result instead of publishing an active pointer without an exact binding", () => {
    const result = runRepair("register-unbound-after-effect-restore-before-running");
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      Succeeded: boolean;
      Failure: string | null;
      FinalTask: string;
      FinalTaskState: string;
      FinalCurrent: string;
      FinalPair: string;
      PointerWritesWithoutBinding: number;
      FinalPointerHasExactActiveBinding: boolean;
      Operations: string[];
    };
    expect(receipt).toMatchObject({
      Succeeded: false,
      FinalTask: "unbound-active",
      FinalTaskState: "Running",
      FinalCurrent: "c".repeat(64),
      FinalPair: "mixed",
      PointerWritesWithoutBinding: 0,
      FinalPointerHasExactActiveBinding: false,
      Operations: ["register-unbound-task-after-effect"],
    });
    expect(receipt.Failure).toContain("fixture unbound task registration failed after effect");
    expect(receipt.Failure).toContain("rollback was incomplete");
    expect(receipt.Failure).toContain("configuration pair is task=unknown pointer=selected");
    expect(receipt.Failure).not.toMatch(
      /not been set|cannot retrieve|uninitialized|not recognized/u,
    );
    expect(receipt.Operations).not.toContain("write-active-pointer");
    expect(receipt.Operations).not.toContain("write-active-pointer-without-binding");
    expect(receipt.Operations).not.toContain("restore-task-before-effect");
    expect(receipt.Operations).not.toContain("stop");
    expect(receipt.Operations).not.toContain("start");
    expect(receipt.Operations).not.toContain("unregister");
  });

  it("fails closed when task registration no longer reports the running instance", () => {
    const result = runRepair("task-state-drop-after-running");
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      Succeeded: boolean;
      Failure: string | null;
      FinalTask: string;
      FinalTaskState: string;
      FinalCurrent: string;
      FinalPrevious: string;
      Operations: string[];
    };
    expect(receipt).toMatchObject({
      Succeeded: false,
      FinalTask: "selected",
      FinalTaskState: "Ready",
      FinalCurrent: "c".repeat(64),
      FinalPrevious: "b".repeat(64),
      Operations: ["register-active-task", "restore-task"],
    });
    expect(receipt.Failure).toContain("rollback was incomplete");
    expect(receipt.Operations).not.toContain("stop");
    expect(receipt.Operations).not.toContain("start");
    expect(receipt.Operations).not.toContain("unregister");
  });
});
