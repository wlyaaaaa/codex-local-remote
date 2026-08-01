import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const scripts = join(repositoryRoot, "scripts", "windows");

interface ListenerSnapshotResult {
  Count: number;
  LocalAddress: string | null;
  LocalPort: number | null;
  OwningProcess: number | null;
  ExpectedPort: number;
  ExpectedProcess: number;
  LegacyTcpQueryCalls: number;
}

windowsOnly("Windows TCP listener snapshot", () => {
  it("reads exact listener ownership without the blocking NetTCPIP provider", () => {
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        join(import.meta.dirname, "fixtures", "tcp-listener-snapshot-driver.ps1"),
        "-ModulePath",
        join(scripts, "CodexLocalRemote.Windows.psm1"),
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: 15_000,
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const snapshot = JSON.parse(result.stdout.trim()) as ListenerSnapshotResult;
    expect(snapshot).toMatchObject({
      Count: 1,
      LocalAddress: "127.0.0.1",
      LocalPort: snapshot.ExpectedPort,
      OwningProcess: snapshot.ExpectedProcess,
      LegacyTcpQueryCalls: 0,
    });
  });

  it("routes every supported control path through the bounded native snapshot", () => {
    for (const name of [
      "Get-CodexLocalRemoteStatus.ps1",
      "Invoke-CodexLocalRemoteOnDemandHandoff.ps1",
      "Launch-CodexWithRemote.ps1",
      "Register-CodexLocalRemoteStartup.ps1",
      "Start-CodexLocalRemote.ps1",
      "Stop-CodexAppServerBroker.ps1",
      "Stop-CodexLocalRemoteSidecar.ps1",
      "Unregister-CodexLocalRemoteStartup.ps1",
    ]) {
      const source = readFileSync(join(scripts, name), "utf8");
      expect(source, name).toContain("Get-CodexLocalRemoteTcpListenerSnapshot");
      expect(source, name).toContain("CODEX_REMOTE_TEST_FIXTURE");
    }
  });
});
