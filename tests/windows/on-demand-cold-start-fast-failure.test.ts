import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const handoffPath = join(
  repositoryRoot,
  "scripts",
  "windows",
  "Invoke-CodexLocalRemoteOnDemandHandoff.ps1",
);
const windowsModulePath = join(
  repositoryRoot,
  "scripts",
  "windows",
  "CodexLocalRemote.Windows.psm1",
);
const startupPath = join(repositoryRoot, "scripts", "windows", "Start-CodexLocalRemote.ps1");
const launcherPath = join(repositoryRoot, "scripts", "windows", "Launch-CodexWithRemote.ps1");
const driverPath = join(
  import.meta.dirname,
  "fixtures",
  "on-demand-cold-start-fast-failure-driver.ps1",
);

interface FixtureResult {
  RuntimeValidationCallsAfterCache: number;
  RuntimeValidationCallsAfterRefresh: number;
  CompatibilityCalls: number;
  Native: {
    Status: string;
    CorrelationId: string;
  } | null;
  Unverified: {
    Status: string;
    RemoteFailureStage: string;
    RemoteFailureCode: string;
  } | null;
  Stale: null;
  WrongCorrelation: null;
  AlternateCorrelationFailedFast: boolean;
  InvalidAllowlist: null;
  ErrorData: {
    Status: string;
    Stage: string;
    Code: string;
  };
}

windowsOnly("Windows cold-start Open fast failure", () => {
  it("validates each immutable proof once and accepts only fresh correlated terminal receipts", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "codex-cold-open-"));
    try {
      const result = spawnSync(
        "pwsh",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          driverPath,
          "-ScriptPath",
          handoffPath,
          "-ModulePath",
          windowsModulePath,
          "-SandboxRoot",
          sandbox,
        ],
        { cwd: repositoryRoot, encoding: "utf8" },
      );

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      const receipt = JSON.parse(result.stdout) as FixtureResult;
      expect(receipt.RuntimeValidationCallsAfterCache).toBe(1);
      expect(receipt.RuntimeValidationCallsAfterRefresh).toBe(2);
      expect(receipt.CompatibilityCalls).toBe(1);
      expect(receipt.Native).toMatchObject({
        Status: "launched-native",
        CorrelationId: "c".repeat(32),
      });
      expect(receipt.Unverified).toMatchObject({
        Status: "remote-launch-unverified",
        RemoteFailureStage: "desktop-attach",
        RemoteFailureCode: "desktop-attach-failed",
      });
      expect(receipt.Stale).toBeNull();
      expect(receipt.WrongCorrelation).toBeNull();
      expect(receipt.AlternateCorrelationFailedFast).toBe(true);
      expect(receipt.InvalidAllowlist).toBeNull();
      expect(receipt.ErrorData).toEqual({
        Status: "launched-native",
        Stage: "desktop-launch",
        Code: "native-fallback",
      });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("observes a launcher terminal receipt inside the bounded poll without issuing a second start", () => {
    const handoffSource = readFileSync(handoffPath, "utf8");
    const windowsModuleSource = readFileSync(windowsModulePath, "utf8");
    const startupSource = readFileSync(startupPath, "utf8");
    const launcherSource = readFileSync(launcherPath, "utf8");
    const coldStart = handoffSource.slice(
      handoffSource.lastIndexOf("$desiredMode = Set-OnDemandOpenDesiredRemote"),
      handoffSource.indexOf("$startStatus =", handoffSource.lastIndexOf("$readyDeadline =")),
    );
    const initialLaunch = startupSource.slice(
      startupSource.indexOf("$initialDesktopLaunch = $null"),
      startupSource.indexOf("$initialRequestReady ="),
    );
    const desktopSwitchStart = launcherSource.lastIndexOf("-StartDesktopAction {");
    const desktopSwitch = launcherSource.slice(
      desktopSwitchStart,
      launcherSource.indexOf("-GetCreatedDesktopStateAction {", desktopSwitchStart),
    );
    const backgroundRecoveryStart = handoffSource.indexOf(
      "if ($decision -ceq 'wait-background-recovery')",
    );
    const activeLeaseRecoveryStart = handoffSource.indexOf(
      "if ($decision -ceq 'request-active-lease-recovery' -and",
      backgroundRecoveryStart,
    );
    const backgroundRecovery = handoffSource.slice(
      backgroundRecoveryStart,
      activeLeaseRecoveryStart,
    );
    const activeLeaseRecovery = handoffSource.slice(
      activeLeaseRecoveryStart,
      handoffSource.indexOf(
        "if ($decision -ceq 'request-active-lease-recovery' -and",
        activeLeaseRecoveryStart + 1,
      ),
    );
    const terminalRead = coldStart.indexOf("Assert-OnDemandDesktopLaunchNotTerminal");
    const remoteStateRead = coldStart.indexOf("$remoteState = Get-OnDemandRemoteState");

    expect(windowsModuleSource).toContain("function Read-CodexDesktopLaunchReceipt");
    expect(handoffSource).toContain("function Assert-OnDemandDesktopLaunchNotTerminal");
    expect(handoffSource).not.toContain("function Read-OnDemandDesktopLaunchTerminalReceipt");
    expect(handoffSource).not.toContain("function New-OnDemandDesktopLaunchTerminalError");
    expect(handoffSource.match(/Assert-OnDemandDesktopLaunchNotTerminal/gu)).toHaveLength(5);
    expect(terminalRead).toBeGreaterThanOrEqual(0);
    expect(remoteStateRead).toBeGreaterThan(terminalRead);
    expect(coldStart).toContain("Assert-OnDemandDesktopLaunchNotTerminal");
    expect(coldStart.match(/Start-OnDemandSelectedRemoteRuntime/gu)).toHaveLength(1);
    const immediateLeaseGate = coldStart.indexOf("if ($ImmediateAuthorizedDesktopRestartForOpen");
    const immediateOwnerIntent = coldStart.indexOf(
      "New-CodexDesktopOwnerIntent",
      immediateLeaseGate,
    );
    const taskStart = coldStart.indexOf(
      "Start-OnDemandSelectedRemoteRuntime",
      immediateOwnerIntent,
    );
    expect(immediateLeaseGate).toBeGreaterThanOrEqual(0);
    expect(immediateOwnerIntent).toBeGreaterThan(immediateLeaseGate);
    expect(taskStart).toBeGreaterThan(immediateOwnerIntent);
    expect(coldStart.slice(immediateLeaseGate, immediateOwnerIntent)).toContain(
      "$decision -ceq 'start-without-desktop-restart'",
    );
    expect(coldStart).toContain("-AlternateCorrelationId");
    expect(coldStart).toContain("$script:immediateFreshStartOwnerIntent.IntentId");
    expect(initialLaunch).toContain("-LaunchCorrelationId");
    expect(initialLaunch).toContain("$initialDesiredMode.IntentId");
    expect(backgroundRecovery).toContain("$backgroundRecoveryDesiredMode =");
    expect(backgroundRecovery).toContain("$backgroundRecoveryDesiredMode.IntentId");
    expect(backgroundRecovery.indexOf("Assert-OnDemandDesktopLaunchNotTerminal")).toBeLessThan(
      backgroundRecovery.indexOf("$remoteState = Get-OnDemandRemoteState"),
    );
    expect(activeLeaseRecovery).toContain("$intent = New-CodexDesktopOwnerIntent");
    expect(activeLeaseRecovery).toContain("-ExpectedCorrelationId ([string]$intent.IntentId)");
    expect(activeLeaseRecovery.indexOf("Assert-OnDemandDesktopLaunchNotTerminal")).toBeLessThan(
      activeLeaseRecovery.indexOf("$remoteState = Get-OnDemandRemoteState"),
    );
    expect(desktopSwitch).toContain("Assert-CodexExpectedSelectedRuntime");
    expect(handoffSource).toContain("Assert-OnDemandRuntimeFreshForDesktopSwitch");
    expect(handoffSource).toMatch(
      /Assert-OnDemandRuntimeFreshForDesktopSwitch\s+`[\s\S]{0,500}Stop-OnDemandDesktopProcessGroup/u,
    );
    expect(handoffSource).toContain("'CodexLocalRemote.DesktopLaunchStatus'");
    expect(handoffSource).toContain(
      "'The correlated Desktop launch ended in a terminal non-Remote state; no second launch was attempted.'",
    );
  });

  it("keeps recursive runtime and payload validation out of repeated readiness observations", () => {
    const handoff = readFileSync(handoffPath, "utf8");
    const stateStart = handoff.indexOf("function Get-OnDemandRemoteState");
    const stateEnd = handoff.indexOf("\nfunction ", stateStart + 1);
    const state = handoff.slice(stateStart, stateEnd);

    expect(state).toContain("Get-OnDemandCachedRuntimeValidation");
    expect(state).toContain("Get-OnDemandCachedBrokerPayloadCompatibility");
    expect(state).not.toMatch(/\bTest-CodexLocalRemoteRuntimeVersion\s+`/u);
    expect(state).not.toMatch(/\bTest-CodexLocalRemoteBrokerPayloadCompatibility\s+`/u);
  });
});
