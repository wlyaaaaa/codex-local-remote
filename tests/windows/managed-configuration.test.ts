import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const modulePath = join(repositoryRoot, "scripts", "windows", "CodexLocalRemote.Windows.psm1");
const driverPath = join(import.meta.dirname, "fixtures", "managed-config-driver.ps1");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function run(mode: "duplicate-port" | "round-trip") {
  const directory = mkdtempSync(join(tmpdir(), "codex-local-remote-managed-config-"));
  temporaryDirectories.push(directory);
  const result = spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      driverPath,
      "-ModulePath",
      modulePath,
      "-DataDir",
      directory,
      "-Mode",
      mode,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as {
    Rejected?: boolean;
    Reopened?: {
      BasePath: string;
      BrokerPort: number;
      BrokerUpstreamPort: number;
      SidecarPort: number;
      Signature: string;
      TaskName: string;
    };
  };
}

windowsOnly("durable managed runtime configuration", () => {
  it("round-trips the non-default upstream port through protected managed state", () => {
    expect(run("round-trip").Reopened).toMatchObject({
      BasePath: "/codex-remote",
      BrokerPort: 18791,
      BrokerUpstreamPort: 18795,
      SidecarPort: 18790,
      Signature: "codex-local-remote/managed-config/v1",
      TaskName: "Codex Local Remote",
    });
  });

  it("rejects a configuration that aliases two managed listeners", () => {
    expect(run("duplicate-port").Rejected).toBe(true);
  });
});
