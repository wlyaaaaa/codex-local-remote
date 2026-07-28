import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");

function windowsScript(name: string) {
  return readFileSync(join(repositoryRoot, "scripts", "windows", name), "utf8");
}

describe("Windows capability and lifecycle safety contract", () => {
  it("passes only the fixed token file path to the broker and never writes the token to state", () => {
    const start = windowsScript("Start-CodexLocalRemote.ps1");
    expect(start).toContain("'--capability-token-file'");
    expect(start).toContain("(ConvertTo-WindowsCommandLineArgument -Value $capabilityTokenPath)");
    expect(start).not.toMatch(/^\s*CapabilityTokenFilePath\s*=/mu);
    expect(start).not.toMatch(/Token\s*=\s*\$token\b/u);
    expect(start).not.toMatch(/WebSocketUrl\s*=\s*\$webSocketUrl/u);
  });

  it("keeps the Broker alive and respawns an unexpectedly exited Sidecar in-process", () => {
    const start = windowsScript("Start-CodexLocalRemote.ps1");
    const registration = windowsScript("Register-CodexLocalRemoteStartup.ps1");
    expect(start).toContain("function Start-ManagedSidecarChild");
    expect(start).toContain("if ($null -eq $sidecarProcess -or $sidecarProcess.HasExited)");
    expect(start).toContain("$startupStage = 'sidecar-recovery'");
    expect(start).toContain("$sidecarChild = Start-ManagedSidecarChild");
    expect(start).toContain("Write-BrokerRuntimeReceipt");
    expect(start).toContain("Test-BrokerInfrastructureReady");
    expect(start).toContain("Get-SharedRuntimeDecision");
    expect(start).toContain("-Phase RuntimeTransition");
    expect(start).toContain("Stop-ProcessIdentityHandle");
    expect(registration).toContain("-RestartCount 3");
    expect(registration).toContain("-RestartInterval (New-TimeSpan -Minutes 1)");
  });

  it("leaves the Broker running while an exact Sidecar hot reload is recovered", () => {
    const start = windowsScript("Start-CodexLocalRemote.ps1");
    const sidecarExitStart = start.indexOf(
      "if ($null -eq $sidecarProcess -or $sidecarProcess.HasExited)",
    );
    const brokerRefresh = start.indexOf(
      "$brokerIdentityHandle.Process.Refresh()",
      sidecarExitStart,
    );
    const sidecarExit = start.slice(sidecarExitStart, brokerRefresh);
    expect(sidecarExitStart).toBeGreaterThan(-1);
    expect(brokerRefresh).toBeGreaterThan(sidecarExitStart);
    expect(sidecarExit).toContain("Start-ManagedSidecarChild");
    expect(sidecarExit).toContain("sidecar-recovery");
    expect(sidecarExit).not.toMatch(/\bexit\b/u);
    expect(sidecarExit).not.toContain("Stop-ExactManagedBrokerAndOrphan");
    expect(sidecarExit).not.toContain("-IdentityHandle $brokerIdentityHandle");
  });

  it("keeps the cold Sidecar transport alive before Desktop request readiness", () => {
    const start = windowsScript("Start-CodexLocalRemote.ps1");
    expect(start).toContain("[int]$SidecarHandshakeTimeoutSeconds");
    expect(start).toContain("$sidecarLocalUrl = Join-BasePathUrl");
    expect(start).toContain("function Test-SidecarRequestReady");
    expect(start).toContain('-Uri "${sidecarLocalUrl}api/v1/ready"');
    expect(start).toContain("$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)");
    expect(start).toContain(
      "Get-BrokerReadinessDecision `\n            -Readiness $readiness `\n            -Phase SidecarHandshake",
    );
    const handshakeStart = start.indexOf("function Wait-ForSidecarHandshake");
    const runtimeDecisionStart = start.indexOf(
      "function Get-SharedRuntimeDecision",
      handshakeStart,
    );
    const handshake = start.slice(handshakeStart, runtimeDecisionStart);
    expect(handshake).not.toContain("Test-SidecarRequestReady");
    expect(handshake).toMatch(/if\s*\(\$decision -ceq 'Ready'\)[\s\S]*?return \$upstream/u);
    expect(start).toContain("$initialRequestReady = Test-SidecarRequestReady");
    expect(start).toContain("$startupStage = if (-not $initialRequestReady)");
    expect(start).toContain("'waiting-desktop'");
    expect(start).toContain("} while ([DateTime]::UtcNow -lt $deadline)");
    expect(start).toContain(
      'throw "Sidecar did not complete its Broker handshake within $TimeoutSeconds seconds."',
    );
    expect(start).toContain("-Phase RuntimeTransition");
  });

  it("keeps the verified transport alive through true client reconnects", () => {
    const start = windowsScript("Start-CodexLocalRemote.ps1");
    expect(start).toContain("[int]$RuntimeHandshakeTimeoutSeconds");
    expect(start).toContain("[int]$SidecarHandshakeTimeoutSeconds = 60");
    expect(start).toContain("[int]$RuntimeHandshakeTimeoutSeconds = 60");
    expect(start).toContain("-Phase RuntimeTransition");
    expect(start).toMatch(
      /\$runtimeDecision = Get-SharedRuntimeDecision\s+if\s*\(\$runtimeDecision -ceq 'Ready' -and\s+-not \(Test-SidecarRequestReady\)\)\s*\{\s*\$runtimeDecision = 'Degraded'\s*\}/u,
    );
    expect(start).toContain("if ($runtimeDecision -ceq 'Degraded')");
    expect(start).toContain("$runtimeApplicationDegraded = $true");
    expect(start).toContain("$runtimeTransitionDeadline = $null");
    expect(start).toContain("if ($runtimeDecision -ceq 'Wait')");
    expect(start).toContain("$runtimeTransitionDeadline = [DateTime]::UtcNow.AddSeconds(");
    expect(start).toContain("} elseif ([DateTime]::UtcNow -ge $runtimeTransitionDeadline) {");
    expect(start).toContain(
      '"Runtime client handshake remains unavailable after $RuntimeHandshakeTimeoutSeconds seconds.',
    );
    const waitStart = start.indexOf("} elseif ($runtimeDecision -ceq 'Wait') {");
    const readyStart = start.indexOf("} else {", waitStart);
    const waitBranch = start.slice(waitStart, readyStart);
    expect(waitBranch).toContain("$startupStage = 'runtime-recovery-wait'");
    expect(waitBranch).toContain("-Status 'degraded'");
    expect(waitBranch).not.toContain("Stop-ProcessIdentityHandle");
    expect(waitBranch).not.toContain("exit 1");
    expect(start).toMatch(
      /else\s*\{\s*\$runtimeTransitionDeadline\s*=\s*\$null\s+if\s*\(\$runtimeApplicationDegraded\)/u,
    );
    expect(start).toContain("exit 1");
  });

  it("periodically reports Desktop package drift without terminating the live stack", () => {
    const start = windowsScript("Start-CodexLocalRemote.ps1");
    expect(start).toContain("[int]$DesktopRuntimeCheckIntervalSeconds");
    expect(start).toContain("$nextDesktopRuntimeCheckAt");
    const driftCheckStart = start.indexOf("if ([DateTime]::UtcNow -ge $nextDesktopRuntimeCheckAt)");
    const driftCheckEnd = start.indexOf("Start-Sleep -Seconds 1", driftCheckStart);
    expect(driftCheckStart).toBeGreaterThan(-1);
    expect(driftCheckEnd).toBeGreaterThan(driftCheckStart);
    const driftCheck = start.slice(driftCheckStart, driftCheckEnd);
    expect(driftCheck).toContain("Resolve-NewCodexDesktopRuntime");
    expect(driftCheck).toContain("Test-DesktopRuntimeIdentityCurrent");
    expect(driftCheck).toContain("$startupStage = 'update-pending'");
    expect(driftCheck).toContain("-Status 'degraded'");
    expect(driftCheck).not.toContain("Stop-ProcessIdentityHandle");
    expect(driftCheck).not.toMatch(/\bexit\b/u);
  });

  it("checks Desktop package identity before reusing an already healthy Broker", () => {
    const start = windowsScript("Start-CodexLocalRemote.ps1");
    const reuseStart = start.indexOf("if ($listenerPids.Count -eq 1)");
    const newBrokerStart = start.indexOf("if ($null -eq $brokerProcess)", reuseStart);
    expect(reuseStart).toBeGreaterThan(-1);
    expect(newBrokerStart).toBeGreaterThan(reuseStart);
    const reuse = start.slice(reuseStart, newBrokerStart);
    expect(reuse).toContain("Resolve-NewCodexDesktopRuntime");
    expect(reuse).toContain("Test-DesktopRuntimeIdentityCurrent");
    expect(reuse).toContain("$desktopRuntimeHealthStatus = 'update-pending'");
    expect(reuse).toContain("while the managed Broker remained active");
  });

  it("never replaces an existing managed Broker when readiness becomes temporarily unprovable", () => {
    const start = windowsScript("Start-CodexLocalRemote.ps1");
    const snapshotRead = start.indexOf(
      "$brokerRuntimeSnapshot = Get-VerifiedBrokerRuntimeSnapshot",
    );
    const nextBranch = start.indexOf(
      "} elseif ([bool]$brokerRuntimeSnapshot.Readiness.desktopConnected",
      snapshotRead,
    );
    const unprovable = start.slice(snapshotRead, nextBranch);
    expect(unprovable).toContain("stopping it could interrupt Codex Desktop");
    expect(unprovable).not.toContain("Stop-ExactManagedBrokerAndOrphan");
    expect(unprovable).not.toContain("$brokerProcess = $null");
  });

  it("allows aggregate readiness only for a current Desktop runtime", () => {
    const status = windowsScript("Get-CodexLocalRemoteStatus.ps1");
    const readyStart = status.indexOf("Ready = (");
    const readyEnd = status.indexOf("\n    TaskState =", readyStart);
    expect(readyStart).toBeGreaterThan(-1);
    expect(readyEnd).toBeGreaterThan(readyStart);
    expect(status.slice(readyStart, readyEnd)).toContain("$desktopRuntimeStatus -ceq 'current'");
    expect(status.slice(readyStart, readyEnd)).toContain("$sidecarRequestReady");
    expect(status).toContain("SidecarRequestReady = $sidecarRequestReady");
  });

  it("writes only redacted startup diagnostics for scheduled-task failures", () => {
    const start = windowsScript("Start-CodexLocalRemote.ps1");
    expect(start).toContain("startup-last.json");
    expect(start).toContain("Protect-StartupStatusText");
    expect(start).toContain("/ws/<redacted>");
    expect(start).not.toMatch(/Write-StartupStatus[\s\S]{0,160}\$webSocketUrl/u);
  });

  it("protects the data directory before the first startup status write", () => {
    const start = windowsScript("Start-CodexLocalRemote.ps1");
    const protection = start.indexOf(
      "Protect-CodexLocalRemoteDataDirectory -DataDir $resolvedDataDir",
    );
    const firstStatusWrite = start.indexOf("Write-StartupStatus -Status 'starting'");
    expect(protection).toBeGreaterThan(-1);
    expect(firstStatusWrite).toBeGreaterThan(-1);
    expect(start.slice(0, protection)).not.toContain("New-Item");
    expect(protection).toBeLessThan(firstStatusWrite);
  });

  it("rejects a filesystem root in the pure ownership plan before any mutation", () => {
    const module = windowsScript("CodexLocalRemote.Windows.psm1");
    const planStart = module.indexOf("function Get-CodexLocalRemoteDataDirectoryOwnershipPlan");
    const protectStart = module.indexOf("function Protect-CodexLocalRemoteDataDirectory");
    const protectEnd = module.indexOf("\nfunction Test-BrokerCapabilityToken", protectStart);
    const plan = module.slice(planStart, protectStart);
    const protect = module.slice(protectStart, protectEnd);
    const guard = plan.indexOf("Assert-CodexLocalRemoteDataDirectoryPath");
    expect(guard).toBeGreaterThan(-1);
    for (const laterRead of [
      "Assert-CodexLocalRemoteDataDirectoryAncestors",
      "Test-CodexLocalRemoteBroadKnownFolder",
      "Test-Path",
    ]) {
      const position = plan.indexOf(laterRead);
      expect(position).toBeGreaterThan(guard);
    }
    const ownershipPlan = protect.indexOf("Get-CodexLocalRemoteDataDirectoryOwnershipPlan");
    expect(ownershipPlan).toBeGreaterThan(-1);
    for (const mutation of [
      "$PSCmdlet.ShouldProcess",
      "[System.IO.Directory]::CreateDirectory",
      "New-CodexLocalRemoteDataDirectoryOwnerMarker",
      "Repair-CodexLocalRemoteDataDirectoryAcl",
    ]) {
      expect(protect.indexOf(mutation)).toBeGreaterThan(ownershipPlan);
    }
  });

  it("never installs a persistent Desktop override and rolls back only newly created ancillary state", () => {
    const registration = windowsScript("Register-CodexLocalRemoteStartup.ps1");
    expect(registration).not.toContain("Install-BrokerUserEnvironment");
    expect(registration).toContain("Restore-BrokerUserEnvironment");
    expect(registration).toContain("Remove-LegacyPersistentOverride");
    expect(registration).toContain("Install-ManagedLauncherShortcut");
    expect(registration).toContain("0x5B89, 0x5168, 0x542F, 0x52A8");
    expect(registration).toContain("$null -ne $token -and $token.Status -ceq 'created'");
    expect(registration).toContain("$launcher.Status -ceq 'created'");
    expect(registration).toContain("Remove-BrokerCapabilityToken -DataDir $expected.DataDir");
    expect(registration).not.toMatch(/Set-UserEnvironmentValue\s+`?\s*[\s\S]*?-Exists\s+\$true/u);
  });

  it("checks only the exact broker and upstream ports before orphan cleanup", () => {
    const stop = windowsScript("Stop-CodexAppServerBroker.ps1");
    expect(stop).toContain("Get-ExactListenerOwner -Port $BrokerPort");
    expect(stop).toContain("Get-ExactListenerOwner -Port $BrokerUpstreamPort");
    expect(stop).toContain("Test-ManagedAppServerProcess");
    expect(stop).toContain("-TokenFilePath $upstreamTokenPath");
    expect(stop).not.toMatch(/-LocalPort\s+18789/u);
    expect(stop).not.toMatch(/Name\s*=\s*['"](?:ChatGPT|Codex)/u);
  });

  it("never permits a Broker stop while Desktop is connected", () => {
    const stop = windowsScript("Stop-CodexAppServerBroker.ps1");

    expect(stop).not.toContain("AllowDesktopDisruption");
    expect(stop).toContain("if ($null -ne $brokerTarget) {");
    expect(stop).toContain("Codex Desktop is connected to the shared Broker. Close Desktop first");
  });

  it("binds one ready receipt and broker stop to exact process creation identities", () => {
    const start = windowsScript("Start-CodexLocalRemote.ps1");
    const stop = windowsScript("Stop-CodexAppServerBroker.ps1");
    const receipt = start.slice(
      start.indexOf("function Write-BrokerRuntimeReceipt"),
      start.indexOf("\ntrap {"),
    );
    for (const field of [
      "BootstrapInvocationId",
      "RuntimeInvocationId",
      "Bootstrap",
      "Broker",
      "Sidecar",
      "Upstream",
      "CreationDate",
      "CreationDateUtcTicks",
      "ProcessStartTimeUtcTicks",
    ]) {
      expect(start).toContain(field);
    }
    expect(start).toContain("codex-local-remote/startup-status/v3");
    expect(start).toContain("codex-local-remote/app-server-broker/v3");
    expect(start).toContain("-Status 'ready'");
    expect(receipt).not.toMatch(/WebSocketUrl|CapabilityToken|(?:Broker|Upstream|Sidecar)Port/u);
    expect(stop).toContain("RuntimeInvocationId");
    expect(stop).toContain("CreationDateUtcTicks");
    expect(stop).toContain("ProcessStartTimeUtcTicks");
    expect(stop).toContain("Open-ProcessIdentityHandle");
    expect(stop).toContain("Stop-ProcessIdentityHandle");
    expect(stop).not.toMatch(/Stop-Process\s+-Id/u);
  });

  it("uses held process handles for Sidecar termination instead of reopening a PID", () => {
    const stop = windowsScript("Stop-CodexLocalRemoteSidecar.ps1");
    expect(stop).toContain("Open-ProcessIdentityHandle");
    expect(stop).toContain("Stop-ProcessIdentityHandle");
    expect(stop).toContain("CreationDateUtcTicks");
    expect(stop).not.toMatch(/Stop-Process\s+-Id/u);
  });

  it("stops an exact managed Sidecar before removing broker state or its task", () => {
    const removal = windowsScript("Unregister-CodexLocalRemoteStartup.ps1");
    expect(removal).toContain("Stop-CodexLocalRemoteSidecar.ps1");
    expect(removal).toContain("-ExpectedSidecarCliPath");
    expect(removal.indexOf("$sidecarStopScript")).toBeLessThan(
      removal.indexOf("$brokerStopScript"),
    );
    expect(removal.indexOf("& $sidecarStopScript")).toBeLessThan(
      removal.indexOf("Unregister-ScheduledTask"),
    );
  });

  it("proves Desktop and turn quiescence before the first uninstall mutation", () => {
    const removal = windowsScript("Unregister-CodexLocalRemoteStartup.ps1");
    const initialPreflight = removal.indexOf(
      "$runtimeStopPreflight = Get-UninstallRuntimePreflight",
    );
    const mutationGate = removal.indexOf(
      "if ($PSCmdlet.ShouldProcess($TaskName, 'Stop and remove the startup task'))",
    );
    const finalPreflight = removal.indexOf(
      "$runtimeStopPreflight = Get-UninstallRuntimePreflight",
      initialPreflight + 1,
    );
    const firstTaskStop = removal.indexOf("Stop-ScheduledTask", mutationGate);
    const firstSidecarStop = removal.indexOf("& $sidecarStopScript", mutationGate);

    expect(removal).toContain("function Get-UninstallRuntimePreflight");
    expect(removal).toContain("$readiness.desktopConnected");
    expect(removal).toContain("$readiness.unsafeThreadCount");
    expect(removal).toContain("Test-ManagedBrokerProcess");
    expect(initialPreflight).toBeGreaterThan(-1);
    expect(initialPreflight).toBeLessThan(mutationGate);
    expect(finalPreflight).toBeGreaterThan(mutationGate);
    expect(finalPreflight).toBeLessThan(firstTaskStop);
    expect(firstTaskStop).toBeLessThan(firstSidecarStop);
  });

  it("keeps capability endpoints and applied secrets out of command and status objects", () => {
    const module = windowsScript("CodexLocalRemote.Windows.psm1");
    const registration = windowsScript("Register-CodexLocalRemoteStartup.ps1");
    const status = windowsScript("Get-CodexLocalRemoteStatus.ps1");
    expect(module).toContain("AppliedValueSha256 = Get-StringSha256");
    expect(module).not.toMatch(/^\s*AppliedValue\s*=/mu);
    expect(registration).not.toMatch(/^\s*BrokerWebSocketUrl\s*=/mu);
    expect(status).not.toMatch(/^\s*BrokerWebSocketUrl\s*=/mu);
    expect(status).toContain("DesktopConnected = $desktopConnected");
    expect(status).toContain("SidecarConnected = $sidecarConnected");
    expect(status).toContain("LauncherConfigured = $launcherConfigured");
    expect(status).toContain("LegacyPersistentOverrideBlocked = $legacyPersistentOverrideBlocked");
    expect(status).toContain("LaunchMode = $launchMode");
    expect(status).not.toContain("DesktopEnvironmentConfigured =");
    expect(status).toContain("Degraded = ($degraded -or $desktopRuntimeDegraded)");
    expect(status).toContain("UnknownCount = $unknownCount");
    expect(status).toContain("$unknownCount -eq 0");
  });
});
