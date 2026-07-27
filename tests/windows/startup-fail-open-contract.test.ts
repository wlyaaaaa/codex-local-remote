import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");

function windowsScript(name: string) {
  return readFileSync(join(repositoryRoot, "scripts", "windows", name), "utf8");
}

describe("Windows fail-open startup contract", () => {
  it("never depends on a persistent Desktop WebSocket override", () => {
    const start = windowsScript("Start-CodexLocalRemote.ps1");

    expect(start).not.toContain("Assert-BrokerUserEnvironmentRestorable");
    expect(start).not.toContain("[System.EnvironmentVariableTarget]::User");
    expect(start).not.toContain("[System.EnvironmentVariableTarget]::Machine");
  });

  it("scopes the capability endpoint to the Sidecar bootstrap process only", () => {
    const start = windowsScript("Start-CodexLocalRemote.ps1");
    const brokerReady = start.indexOf("$startupStage = 'broker-ready'");
    const childFunction = start.indexOf("function Start-ManagedSidecarChild");
    const processOverride = start.indexOf(
      "$env:CODEX_APP_SERVER_WS_URL = $webSocketUrl",
      childFunction,
    );
    const sidecarStart = start.indexOf("$process = Start-Process", processOverride);

    expect(brokerReady).toBeGreaterThan(-1);
    expect(childFunction).toBeGreaterThan(brokerReady);
    expect(processOverride).toBeGreaterThan(brokerReady);
    expect(sidecarStart).toBeGreaterThan(processOverride);
    expect(start.slice(Math.max(0, processOverride - 500), sidecarStart)).toContain(
      "Sidecar child process",
    );
  });

  it("never stops an existing Desktop and delegates automatic recovery to the fail-open launcher", () => {
    const start = windowsScript("Start-CodexLocalRemote.ps1");

    expect(start).not.toMatch(/Start-Process[\s\S]{0,160}\$resolvedCodex/u);
    expect(start).not.toMatch(/Stop-Process[\s\S]{0,160}(?:ChatGPT|Desktop)/u);
    expect(start).toContain("Codex Desktop still owns an independent stdio app-server");
    expect(start).toContain("[switch]$NoDesktopLaunch");
    expect(start).toContain("function Invoke-ManagedDesktopLaunch");
    expect(start).toContain("Launch-CodexWithRemote.ps1");
    expect(start).toContain("$initialDesktopLaunch = Invoke-ManagedDesktopLaunch");
    expect(start).toContain("$desktopRecoveryLaunch = Invoke-ManagedDesktopLaunch");
  });

  it("lets the cold shared runtime finish discovery before falling back to native Desktop", () => {
    const launcher = windowsScript("Launch-CodexWithRemote.ps1");
    const start = windowsScript("Start-CodexLocalRemote.ps1");

    expect(launcher).toContain("[int]$InfrastructureStartupTimeoutSeconds = 30");
    expect(launcher).toMatch(
      /\[ValidateRange\(0, 60000\)\]\s*\[int\]\$RemoteStartupTimeoutMilliseconds = 30000/u,
    );
    const handshakeStart = start.indexOf("function Wait-ForSidecarHandshake");
    const runtimeDecisionStart = start.indexOf(
      "function Get-SharedRuntimeDecision",
      handshakeStart,
    );
    expect(handshakeStart).toBeGreaterThan(-1);
    expect(runtimeDecisionStart).toBeGreaterThan(handshakeStart);
    expect(start.slice(handshakeStart, runtimeDecisionStart)).not.toContain(
      "Test-SidecarRequestReady",
    );
  });

  it("does not execute an if statement as a parenthesized command argument", () => {
    const start = windowsScript("Start-CodexLocalRemote.ps1");

    expect(start).not.toMatch(/-Message\s*\(\s*if\b/u);
    expect(start).toContain("$initialStartupMessage = if (-not $initialRequestReady)");
    expect(start).toContain("-Message $initialStartupMessage");
  });

  it("does not let an unrelated IPv6 loopback listener poison the managed IPv4 endpoint", () => {
    const start = windowsScript("Start-CodexLocalRemote.ps1");
    const module = windowsScript("CodexLocalRemote.Windows.psm1");

    expect(module).toContain("function Test-IsLoopbackListenerAddress");
    expect(module).toContain("'::1'");
    expect(module).toContain("function Get-ManagedIpv4Listeners");
    expect(start).toContain("Test-IsLoopbackListenerAddress -Address $_.LocalAddress");
    expect(start).toContain("Get-ManagedIpv4Listeners -Listeners $listeners");
    expect(start).not.toContain("$listeners | Where-Object { $_.LocalAddress -cne '127.0.0.1' }");
  });

  it("preserves an empty listener query as an empty collection during cold startup", () => {
    const start = windowsScript("Start-CodexLocalRemote.ps1");

    expect(start).toContain("$listeners = @(Get-UpstreamListeners)");
    expect(start).toContain("$listeners = @(Get-BrokerListeners)");
    expect(start).not.toMatch(/\$listeners\s*=\s*Get-(?:Broker|Upstream)Listeners\b/u);
  });
});
