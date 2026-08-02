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
const onDemandHandoff = join(
  repositoryRoot,
  "scripts",
  "windows",
  "Invoke-CodexLocalRemoteOnDemandHandoff.ps1",
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
const offlinePortMigrationDriver = join(
  import.meta.dirname,
  "fixtures",
  "runtime-registration-offline-port-migration-driver.ps1",
);
const onDemandFenceDriver = join(
  import.meta.dirname,
  "fixtures",
  "runtime-registration-on-demand-fence-driver.ps1",
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

function runOfflinePortMigration(mode: string) {
  return spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      offlinePortMigrationDriver,
      "-RegistrationPath",
      registration,
      "-Mode",
      mode,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
}

function runOnDemandFence() {
  const sandbox = join(
    process.env.TEMP ?? repositoryRoot,
    `codex-registration-fence-${process.pid}-${crypto.randomUUID()}`,
  );
  return spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      onDemandFenceDriver,
      "-RegistrationPath",
      registration,
      "-SandboxRoot",
      sandbox,
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

  it("keeps offline upstream-port migration hidden, NoStart-only, and supersession-bound", () => {
    const source = readFileSync(registration, "utf8");
    expect(source).toMatch(
      /\[Parameter\(DontShow\)\]\s+\[ValidateRange\(1, 65535\)\]\s+\[int\]\$MigrateOfflineBrokerUpstreamPortFrom/u,
    );
    expect(source).toContain("MigrateOfflineBrokerUpstreamPortFrom requires NoStart");
    expect(source).toContain("MigrateOfflineBrokerUpstreamPortFrom requires the exact");
    expect(source).toContain("SupersedeOfflineSelectedRuntimeVersionId");
  });

  it.each([
    "config-sidecar-drift",
    "config-broker-drift",
    "config-base-path-drift",
    "config-task-name-drift",
  ])("permits only BrokerUpstreamPort to differ in the old managed config: %s", (mode) => {
    const result = runOfflinePortMigration(mode);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      Succeeded: boolean;
      Failure: string | null;
    };
    expect(receipt.Succeeded).toBe(false);
    expect(receipt.Failure).toContain(
      "permits only the exact managed BrokerUpstreamPort value to change",
    );
  });

  it("admits the exact old config and selected task binding at the old port", () => {
    const result = runOfflinePortMigration("success");
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      Succeeded: true,
      Failure: null,
      ReturnedBrokerUpstreamPort: 18795,
      ExpectedBrokerUpstreamPorts: [18795, 18795],
      RequestedPortSets: [
        [18789, 18790, 18792],
        [18789, 18790, 18792],
      ],
      ConfigurationReads: 2,
      PointerReads: 1,
      TaskReads: 2,
      ListenerReads: 2,
    });
  });

  it.each(["task-port-drift", "task-version-drift", "task-root-drift", "task-hash-drift"])(
    "fails closed when the old task is not exactly bound: %s",
    (mode) => {
      const result = runOfflinePortMigration(mode);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      const receipt = JSON.parse(result.stdout) as {
        Succeeded: boolean;
        Failure: string | null;
      };
      expect(receipt.Succeeded).toBe(false);
      expect(receipt.Failure).toContain(
        "selected task and runtime pointer are not one exact managed binding",
      );
    },
  );

  it.each([
    ["occupied-sidecar", "18789"],
    ["occupied-broker", "18790"],
    ["occupied-upstream", "18792"],
  ])("requires each new target port to be empty: %s", (mode, port) => {
    const result = runOfflinePortMigration(mode);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      Succeeded: boolean;
      Failure: string | null;
    };
    expect(receipt.Succeeded).toBe(false);
    expect(receipt.Failure).toContain("requires all target ports to be empty");
    expect(receipt.Failure).toContain(port);
  });

  it.each([
    ["pointer-drift-after-read", "changed during its double read-back"],
    ["config-drift-after-read", "changed during its double read-back"],
    [
      "task-drift-after-read",
      "selected task and runtime pointer are not one exact managed binding",
    ],
    ["listener-drift-after-read", "changed during its double read-back"],
  ])("fails closed on migration admission drift: %s", (mode, failure) => {
    const result = runOfflinePortMigration(mode);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      Succeeded: boolean;
      Failure: string | null;
    };
    expect(receipt.Succeeded).toBe(false);
    expect(receipt.Failure).toContain(failure);
  });

  it("routes migration ownership through the existing binding transaction without lifecycle calls", () => {
    const source = readFileSync(registration, "utf8");
    const assertionStart = source.indexOf(
      "function Assert-RegistrationOfflineBrokerUpstreamPortMigration",
    );
    const assertionEnd = source.indexOf("function ", assertionStart + 9);
    expect(assertionStart).toBeGreaterThanOrEqual(0);
    expect(assertionEnd).toBeGreaterThan(assertionStart);
    const assertion = source.slice(assertionStart, assertionEnd);
    expect(assertion).not.toContain("Stop-ScheduledTask");
    expect(assertion).not.toContain("Start-ScheduledTask");
    expect(assertion).not.toContain("Unregister-ScheduledTask");

    const ownershipBranch = source.indexOf("Kind = 'offline-upstream-port-migration'");
    const shouldProcess = source.indexOf("if ($PSCmdlet.ShouldProcess(", ownershipBranch);
    const finalAdmission = source.indexOf(
      "Assert-RegistrationOfflineBrokerUpstreamPortMigration",
      shouldProcess,
    );
    const firstMutation = source.indexOf("Protect-CodexLocalRemoteDataDirectory", shouldProcess);
    const transaction = source.indexOf(
      "Complete-RegistrationRuntimeBindingTransaction",
      shouldProcess,
    );
    expect(ownershipBranch).toBeGreaterThanOrEqual(0);
    expect(source.slice(ownershipBranch, shouldProcess)).toContain(
      "'offline-upstream-port-migration'",
    );
    expect(finalAdmission).toBeGreaterThan(shouldProcess);
    expect(finalAdmission).toBeLessThan(firstMutation);
    expect(transaction).toBeGreaterThan(firstMutation);
  });

  it("captures CAS mutation receipts for exact ancillary rollback", () => {
    const source = readFileSync(registration, "utf8");
    const finalMigrationGate = source.lastIndexOf(
      "Assert-RegistrationOfflineBrokerUpstreamPortMigration",
    );
    const configWrite = source.indexOf(
      "Set-CodexLocalRemoteManagedConfiguration",
      finalMigrationGate,
    );
    const configReceipt = source.indexOf("-PassThruMutationReceipt", configWrite);
    const desiredWrite = source.indexOf("Set-CodexLocalRemoteDesiredMode", configReceipt);
    const desiredReceipt = source.indexOf("-PassThruMutationReceipt", desiredWrite);
    expect(configWrite).toBeGreaterThanOrEqual(0);
    expect(configReceipt).toBeGreaterThan(configWrite);
    expect(desiredWrite).toBeGreaterThan(configWrite);
    expect(desiredReceipt).toBeGreaterThan(desiredWrite);
    const configMutation = source.slice(configWrite, desiredWrite);
    const desiredMutation = source.slice(desiredWrite, desiredReceipt + 1500);
    for (const mutation of [configMutation, desiredMutation]) {
      expect(mutation).toContain("-ExpectedCurrentSha256");
      expect(mutation).toContain("-PassThruMutationReceipt");
      expect(mutation).toContain("WrittenSha256");
    }
  });

  it("holds the shared on-demand fence across final admission, transaction, and rollback", () => {
    const source = readFileSync(registration, "utf8");
    const handoff = readFileSync(onDemandHandoff, "utf8");
    const mutexName = "Global\\CodexLocalRemote.OnDemandControl.";
    expect(handoff).toContain(mutexName);
    expect(source).toContain(mutexName);

    const enterStart = source.indexOf("function Enter-RegistrationOnDemandControlFence");
    const exitStart = source.indexOf("function Exit-RegistrationOnDemandControlFence", enterStart);
    const exitEnd = source.indexOf("# Real registration must cross", exitStart);
    const enter = source.slice(enterStart, exitStart);
    const exit = source.slice(exitStart, exitEnd);
    expect(enter).toContain(mutexName);
    expect(enter).toContain(".WaitOne(");
    expect(exit).toContain(".ReleaseMutex()");
    expect(exit).toContain(".Dispose()");

    const acquire = source.indexOf("Enter-RegistrationOnDemandControlFence", exitEnd);
    const firstMigrationGate = source.indexOf(
      "Assert-RegistrationOfflineBrokerUpstreamPortMigration",
      acquire,
    );
    const finalMigrationGate = source.lastIndexOf(
      "Assert-RegistrationOfflineBrokerUpstreamPortMigration",
    );
    const transaction = source.indexOf(
      "Complete-RegistrationRuntimeBindingTransaction",
      finalMigrationGate,
    );
    const rollback = source.indexOf("Restore-RegistrationAncillaryPreImages", transaction);
    const release = source.lastIndexOf("Exit-RegistrationOnDemandControlFence");
    expect(enterStart).toBeGreaterThanOrEqual(0);
    expect(exitStart).toBeGreaterThan(enterStart);
    expect(acquire).toBeGreaterThan(exitEnd);
    expect(firstMigrationGate).toBeGreaterThan(acquire);
    expect(finalMigrationGate).toBeGreaterThan(firstMigrationGate);
    expect(transaction).toBeGreaterThan(finalMigrationGate);
    expect(rollback).toBeGreaterThan(transaction);
    expect(release).toBeGreaterThan(rollback);

    for (const fenceFunction of [enter, exit]) {
      expect(fenceFunction).not.toContain("Stop-ScheduledTask");
      expect(fenceFunction).not.toContain("Stop-Process");
      expect(fenceFunction).not.toContain("taskkill");
    }
  });

  it("blocks the shared on-demand mutex until the offline migration fence releases", () => {
    const result = runOnDemandFence();
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      BlockedWhileHeld: true,
      AcquiredAfterRelease: true,
    });
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
