import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");
const windowsScript = (name: string) =>
  readFileSync(join(repositoryRoot, "scripts", "windows", name), "utf8");

function functionBlock(source: string, name: string, nextName: string): string {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  expect(start, `${name} was not found`).toBeGreaterThanOrEqual(0);
  expect(end, `${nextName} was not found after ${name}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("Windows infrastructure-first on-demand handoff", () => {
  it("prepares the selected immutable runtime before touching Desktop", () => {
    const handoff = windowsScript("Invoke-CodexLocalRemoteOnDemandHandoff.ps1");
    const prepare = handoff.lastIndexOf("Prepare-OnDemandSelectedRemoteRuntime `");
    const desktopExit = handoff.lastIndexOf("Invoke-OnDemandPreparedAttach `");

    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(desktopExit).toBeGreaterThan(prepare);
    expect(handoff).toContain("desktopConnected");
    expect(handoff).toContain("unknownCount");
    expect(handoff).toContain("unsafeThreadCount");
    expect(handoff).toContain("Read-CodexLocalRemoteDesktopHandoffPreparation");
    const remoteState = functionBlock(
      handoff,
      "Get-OnDemandRemoteState",
      "Get-VerifiedOnDemandStartupTask",
    );
    expect(remoteState).toMatch(/\[int\]\$readiness\.unsafeThreadCount -ne 0/u);
  });

  it("publishes the exact Desktop preparation before enabling a pending runtime", () => {
    const handoff = windowsScript("Invoke-CodexLocalRemoteOnDemandHandoff.ps1");
    const prepare = functionBlock(
      handoff,
      "Prepare-OnDemandSelectedRemoteRuntime",
      "Stop-OnDemandDesktopProcessGroup",
    );
    const preflight = prepare.indexOf("Assert-OnDemandSelectedRemoteRuntimeActivationPreflight");
    const preparation = prepare.indexOf("New-CodexLocalRemoteDesktopHandoffPreparation");
    const desiredRemote = prepare.indexOf("Set-OnDemandOpenDesiredRemote -Runtime $Runtime");
    const activation = prepare.indexOf("Start-OnDemandSelectedRemoteRuntime `");

    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(preparation).toBeGreaterThan(preflight);
    expect(desiredRemote).toBeGreaterThan(preparation);
    expect(activation).toBeGreaterThan(desiredRemote);

    const mainPreparation = handoff.lastIndexOf("Prepare-OnDemandSelectedRemoteRuntime `");
    const mainAdmission = handoff.lastIndexOf(
      "$runtime =\n        Assert-OnDemandSelectedRuntimeUnchanged",
      mainPreparation,
    );
    expect(mainAdmission).toBeGreaterThanOrEqual(0);
    expect(handoff.slice(mainAdmission, mainPreparation)).not.toContain(
      "Set-OnDemandOpenDesiredRemote",
    );
  });

  it("fails fast when the selected startup task exits before preparation", () => {
    const handoff = windowsScript("Invoke-CodexLocalRemoteOnDemandHandoff.ps1");
    const prepare = functionBlock(
      handoff,
      "Prepare-OnDemandSelectedRemoteRuntime",
      "Stop-OnDemandDesktopProcessGroup",
    );
    const remoteState = prepare.indexOf("$remoteState = Get-OnDemandRemoteState");
    const taskRefresh = prepare.indexOf("Get-ScheduledTask `", remoteState);
    const earlyExit = prepare.indexOf("'preparation completed.'", taskRefresh);

    expect(remoteState).toBeGreaterThanOrEqual(0);
    expect(taskRefresh).toBeGreaterThan(remoteState);
    expect(earlyExit).toBeGreaterThan(taskRefresh);
  });

  it("gives cold infrastructure preparation its own complete startup budget", () => {
    const handoff = windowsScript("Invoke-CodexLocalRemoteOnDemandHandoff.ps1");
    const prepare = functionBlock(
      handoff,
      "Prepare-OnDemandSelectedRemoteRuntime",
      "Stop-OnDemandDesktopProcessGroup",
    );

    expect(handoff).toMatch(
      /\[ValidateRange\(15, 300\)\]\s+\[int\]\$InfrastructureReadyWaitSeconds = 240/u,
    );
    expect(prepare).toMatch(/AddSeconds\(\s+\$InfrastructureReadyWaitSeconds\s+\)/u);
    expect(prepare).not.toMatch(/AddSeconds\(\s*\$ReadyWaitSeconds\s*\)/u);
  });

  it("keeps the post-close path attach-only", () => {
    const handoff = windowsScript("Invoke-CodexLocalRemoteOnDemandHandoff.ps1");
    const attachOnly = functionBlock(
      handoff,
      "Invoke-OnDemandPreparedAttach",
      "Invoke-OnDemandPreparedAttachCompensation",
    );

    expect(attachOnly.indexOf("Assert-OnDemandPreparedInfrastructureReadyForAttach")).toBeLessThan(
      attachOnly.indexOf("Set-CodexLocalRemoteDesktopHandoffPreparationAttaching"),
    );
    expect(attachOnly).toContain("Stop-OnDemandDesktopProcessGroup");
    expect(attachOnly).toContain("New-CodexDesktopOwnerIntent");
    expect(attachOnly).not.toMatch(
      /Start-OnDemandSelectedRemoteRuntime|Start-ScheduledTask|Stop-ScheduledTask|Register-ScheduledTask|Set-CodexLocalRemoteCurrentRuntime|Switch-CodexLocalRemoteRuntimeGeneration|Stop-CodexAppServerBroker|Stop-CodexLocalRemoteSidecar/u,
    );
  });

  it("proves the exact prepared transport before reporting that only attach remains", () => {
    const handoff = windowsScript("Invoke-CodexLocalRemoteOnDemandHandoff.ps1");
    const transportSnapshot = functionBlock(
      handoff,
      "Get-OnDemandPreparedTransportSnapshot",
      "Prepare-OnDemandSelectedRemoteRuntime",
    );
    const processInspection = functionBlock(
      handoff,
      "Get-OnDemandExactProcessInspection",
      "Test-OnDemandReceiptProcessIdentity",
    );
    const readyGate = functionBlock(
      handoff,
      "Assert-OnDemandPreparedInfrastructureReadyForAttach",
      "Assert-OnDemandPreparedInfrastructureStillExact",
    );
    const calls = handoff.match(/\bAssert-OnDemandPreparedInfrastructureReadyForAttach\s+`/gu);

    expect(readyGate).toContain("-RequireLiveOwnership");
    expect(readyGate).toContain("'ready'");
    expect(readyGate).toContain("RuntimeInvocationId");
    expect(readyGate).toContain("BrokerProcessId");
    expect(readyGate).toContain("UpstreamProcessId");
    expect(readyGate).toContain("SidecarProcessId");
    expect(transportSnapshot).toContain("Get-OnDemandExactProcessInspection");
    expect(transportSnapshot).toContain("MaintenanceTokenFilePath");
    expect(transportSnapshot).toContain("ParentProcessId");
    expect(transportSnapshot).toContain("Get-OnDemandManagedPortListeners");
    expect(transportSnapshot).toContain("OwningProcess");
    expect(transportSnapshot).toContain("$rawFinal -cne $rawBefore");
    expect(processInspection).toContain("Get-CodexLocalRemoteProcessCommandLine");
    expect(calls?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(handoff).toContain("-Outcome 'preclose-drift'");
  });

  it("replaces a failed newly attached root with one native Desktop", () => {
    const handoff = windowsScript("Invoke-CodexLocalRemoteOnDemandHandoff.ps1");
    const compensation = functionBlock(
      handoff,
      "Invoke-OnDemandPreparedAttachCompensation",
      "Invoke-OnDemandOpenCompensation",
    );

    expect(compensation).toContain("DesktopRootIdentityKey");
    expect(compensation).toContain("Stop-OnDemandDesktopRoot");
    expect(compensation).toContain("Start-OnDemandNativeDesktop");
    expect(compensation).not.toMatch(
      /Start-OnDemandSelectedRemoteRuntime|Start-ScheduledTask|Stop-ScheduledTask|Register-ScheduledTask|Set-CodexLocalRemoteCurrentRuntime|Switch-CodexLocalRemoteRuntimeGeneration|Stop-CodexAppServerBroker|Stop-CodexLocalRemoteSidecar/u,
    );
  });

  it("lets the task prepare transport without launching or taking over Desktop", () => {
    const startup = windowsScript("Start-CodexLocalRemote.ps1");
    const initialLaunchStart = startup.indexOf("$initialDesktopLaunch = $null");
    const initialLaunchEnd = startup.indexOf("$initialRequestReady =", initialLaunchStart);
    const initialLaunch = startup.slice(initialLaunchStart, initialLaunchEnd);

    expect(startup).toContain("Read-CodexLocalRemoteDesktopHandoffPreparation");
    expect(startup).toContain("$liveDesktopHandoffPreparation");
    expect(startup).toContain("$desktopHandoffPreparationPathPresent");
    expect(initialLaunch).toContain("'handoff-preparing'");
    expect(initialLaunch).toContain("'handoff-preparation-blocked'");
    expect(initialLaunch).toContain("$desktopHandoffPreparation");
    expect(initialLaunch.indexOf("$desktopHandoffPreparation")).toBeLessThan(
      initialLaunch.indexOf("Invoke-ManagedDesktopLaunch"),
    );
    const independentStdioGate = startup.slice(
      startup.indexOf("$desktopStdioPids ="),
      startup.indexOf("function Get-BrokerListeners"),
    );
    expect(independentStdioGate).toContain(
      "$liveDesktopHandoffPreparation.DesktopAppServerProcessId",
    );
    expect(independentStdioGate).toContain("continue");
    expect(independentStdioGate).toContain("$desktopStdioPids.Add");
  });

  it("revalidates preparation at the final background switch boundaries", () => {
    const launcher = windowsScript("Launch-CodexWithRemote.ps1");
    const generationSwitch = functionBlock(
      launcher,
      "Switch-CodexLocalRemoteRuntimeGeneration",
      "Wait-CodexLocalRemoteCodexRuntimeReady",
    );
    const cleanup = functionBlock(
      launcher,
      "Stop-CodexLocalRemotePossiblyStartedSelectedGeneration",
      "Test-CodexLocalRemotePathEqual",
    );
    const brokerStop = generationSwitch.indexOf("$null = & $brokerStop");
    const selectedStart = generationSwitch.indexOf(
      "Start-CodexLocalRemoteScheduledTaskBounded",
      brokerStop,
    );

    expect(brokerStop).toBeGreaterThanOrEqual(0);
    expect(selectedStart).toBeGreaterThan(brokerStop);
    expect(generationSwitch.slice(0, brokerStop)).toContain("-Phase 'before-broker-stop'");
    expect(generationSwitch.slice(brokerStop, selectedStart)).toContain(
      "-Phase 'before-selected-task-start'",
    );
    expect(cleanup).toContain("[object]$DesktopHandoffPreparation");
    expect(cleanup).toContain("Assert-CodexLocalRemoteDesktopHandoffProcessGate");
    expect(cleanup).not.toContain("@(Get-CodexDesktopHandoffProcesses).Count");
  });

  it("cancels a live preparation when the user closes Remote", () => {
    const handoff = windowsScript("Invoke-CodexLocalRemoteOnDemandHandoff.ps1");
    const closeStart = handoff.indexOf("if ($Operation -ceq 'Close')");
    const closeEnd = handoff.indexOf("if ([string]$startupTask.State -ceq 'Running'", closeStart);
    const close = handoff.slice(closeStart, closeEnd);

    expect(close).toContain("Read-CodexLocalRemoteDesktopHandoffPreparation");
    expect(close).toContain("Complete-CodexLocalRemoteDesktopHandoffPreparation");
    expect(close).toContain("-Outcome 'closed-by-user'");
  });
});
