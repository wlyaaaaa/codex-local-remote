import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const modulePath = join(repositoryRoot, "scripts", "windows", "CodexLocalRemote.Windows.psm1");
const driver = join(import.meta.dirname, "fixtures", "runtime-promotion-driver.ps1");

windowsOnly("legacy active runtime promotion", () => {
  function evaluate(mode: string) {
    return spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        driver,
        "-ModulePath",
        modulePath,
        "-Mode",
        mode,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
  }

  it("allows promotion only for the exact same active path and freshly computed hash", () => {
    const same = evaluate("same");
    expect(same.status, `${same.stdout}${same.stderr}`).toBe(0);
    expect(JSON.parse(same.stdout)).toBe(true);
  });

  it.each(["path-drift", "hash-drift", "invalid-active"])(
    "rejects legacy promotion for %s",
    (mode) => {
      const result = evaluate(mode);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toBe(false);
    },
  );

  it("requires exact healthy Broker and Desktop connection before the promotion branch", async () => {
    const { readFile } = await import("node:fs/promises");
    const start = await readFile(
      join(repositoryRoot, "scripts", "windows", "Start-CodexLocalRemote.ps1"),
      "utf8",
    );
    const reuseStart = start.indexOf("if ($listenerPids.Count -eq 1)");
    const reuseEnd = start.indexOf("if ($null -eq $brokerProcess)", reuseStart);
    const reuse = start.slice(reuseStart, reuseEnd);
    expect(reuse).toContain("Get-VerifiedBrokerRuntimeSnapshot");
    expect(reuse).toContain("$brokerRuntimeSnapshot.Readiness.desktopConnected");
    expect(reuse).toContain("Test-ActiveCodexRuntimeMatchesCurrentDiscovery");
    expect(reuse).toContain("$runtimeDiscovery = $currentDesktopRuntime");
    expect(reuse.indexOf("Get-VerifiedBrokerRuntimeSnapshot")).toBeLessThan(
      reuse.indexOf("Test-ActiveCodexRuntimeMatchesCurrentDiscovery"),
    );
  });

  it("retries the bounded legacy promotion after Desktop reconnects", async () => {
    const { readFile } = await import("node:fs/promises");
    const start = await readFile(
      join(repositoryRoot, "scripts", "windows", "Start-CodexLocalRemote.ps1"),
      "utf8",
    );
    const supervisionStart = start.indexOf("if ($desktopRuntimeCheckClock.ElapsedMilliseconds -ge");
    const supervisionEnd = start.indexOf(
      "$nextDesktopRuntimeCheckElapsedMilliseconds =",
      supervisionStart,
    );
    const supervision = start.slice(supervisionStart, supervisionEnd);

    expect(supervision).toContain("Get-VerifiedBrokerRuntimeSnapshot");
    expect(supervision).toContain("Read-CodexDesktopOwnerConnectionProof");
    expect(supervision).toContain("Test-CodexDesktopOwnerConnectionProof");
    expect(supervision).toContain("-ExpectedRuntimeInvocationId $runtimeInvocationId");
    expect(supervision).toContain("-RootIdentityKey $currentDesktopRootIdentityKey");
    expect(supervision).toContain("Test-ActiveCodexRuntimeMatchesCurrentDiscovery");
    expect(supervision).toContain("$runtimeDiscovery = $currentDesktopRuntime");
    expect(supervision).toContain("elseif (-not $desktopConnected)");
    expect(supervision.indexOf("Get-VerifiedBrokerRuntimeSnapshot")).toBeLessThan(
      supervision.indexOf("Test-ActiveCodexRuntimeMatchesCurrentDiscovery"),
    );
  });
});
