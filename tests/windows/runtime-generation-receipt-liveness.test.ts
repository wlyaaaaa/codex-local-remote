import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const launcher = join(repositoryRoot, "scripts", "windows", "Launch-CodexWithRemote.ps1");
const driver = join(
  import.meta.dirname,
  "fixtures",
  "runtime-generation-receipt-liveness-driver.ps1",
);

windowsOnly("Windows stale transition receipt classification", () => {
  it("cold-starts only after every exact prior process identity is absent", () => {
    const result = spawnSync(
      "pwsh",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", driver, "-LauncherPath", launcher],
      { cwd: repositoryRoot, encoding: "utf8" },
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      AllAbsent: "absent",
      BrokerLive: "live",
      OneUnknown: "unknown",
      MissingMandatory: "unknown",
      IncompleteBrokerReadyAbsent: "absent",
      IncompleteBrokerReadyListener: "unknown",
      IncompleteBrokerReadyNotFound: "unknown",
      IncompleteBrokerReadyLive: "live",
    });
  });

  it("routes stale and unverified transition receipts before task mutation", () => {
    const source = readFileSync(launcher, "utf8");
    const generationStart = source.indexOf("function Get-CodexLocalRemoteRuntimeGenerationStatus");
    const generationEnd = source.indexOf(
      "function Get-CodexLocalRemoteActiveCodexRuntimeStatus",
      generationStart,
    );
    const generation = source.slice(generationStart, generationEnd);
    expect(generation).toContain("Get-CodexLocalRemoteReceiptProcessLiveness");
    expect(generation).toContain("-AllowIncompleteBrokerReadyReceipt");
    expect(generation).toContain("-ManagedPorts @(");
    expect(source).toContain("Get-CodexLocalRemoteTcpListenerSnapshot");
    expect(source).toContain("CODEX_REMOTE_TEST_FIXTURE");
    expect(generation).toContain("stale-transition-receipt");
    expect(generation).toContain("transition-process-unverified");
  });
});
