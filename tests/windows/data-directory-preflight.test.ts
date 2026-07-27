import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const scripts = join(repositoryRoot, "scripts", "windows");
const fixtures = join(import.meta.dirname, "fixtures");
const schedulerDriver = join(fixtures, "scheduler-mock-driver.ps1");
const migrationDriver = join(fixtures, "migration-datadir-preflight-mock-driver.ps1");

interface SchedulerState {
  Task: null;
  Operations: string[];
}

interface RegistrationResult {
  Status: string;
  DataDirectoryAction: string;
  DataDir: string;
}

interface MigrationPreflightResult {
  UnexpectedSuccess: boolean;
  Error: string;
  ForbiddenCalls: string[];
  OutputContainsTokenSentinel: boolean;
}

function runPowerShell(script: string, arguments_: string[]) {
  return spawnSync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script, ...arguments_],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 15_000,
    },
  );
}

function lastJsonLine<T>(stdout: string): T {
  const lines = stdout.trim().split(/\r?\n/u);
  const last = lines.at(-1);
  if (!last) throw new Error("PowerShell produced no JSON result");
  return JSON.parse(last) as T;
}

windowsOnly("DataDir preflight gates", () => {
  let sandbox: string;
  let installRoot: string;
  let dataDir: string;
  let nodePath: string;
  let stateFile: string;

  beforeEach(() => {
    sandbox = join(tmpdir(), `codex-datadir-preflight-${process.pid}-${crypto.randomUUID()}`);
    installRoot = join(sandbox, "install root");
    dataDir = join(sandbox, "data root");
    nodePath = join(sandbox, "Node Runtime", "node.exe");
    stateFile = join(sandbox, "scheduler-state.json");

    mkdirSync(dirname(nodePath), { recursive: true });
    mkdirSync(join(installRoot, "apps", "sidecar", "dist"), { recursive: true });
    mkdirSync(join(installRoot, "apps", "broker", "dist"), { recursive: true });
    mkdirSync(join(installRoot, "scripts", "windows"), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(nodePath, "", "utf8");
    writeFileSync(join(installRoot, "apps", "sidecar", "dist", "cli.js"), "", "utf8");
    writeFileSync(join(installRoot, "apps", "broker", "dist", "cli.js"), "", "utf8");
    writeFileSync(
      join(installRoot, "scripts", "windows", "Start-CodexLocalRemote.ps1"),
      "",
      "utf8",
    );
    writeFileSync(stateFile, JSON.stringify({ Task: null, Operations: [] }), "utf8");
  });

  function registrationArguments() {
    return [
      "-TargetScript",
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "-StateFile",
      stateFile,
      "-Operation",
      "register",
      "-InstallRoot",
      installRoot,
      "-DataDir",
      dataDir,
      "-NodePath",
      nodePath,
      "-WhatIf",
      "-JsonResult",
    ];
  }

  it("returns the canonical read-only ownership plan during registration WhatIf", () => {
    const result = runPowerShell(schedulerDriver, registrationArguments());
    expect(result.status, `${result.error?.message ?? ""}\n${result.stderr}`).toBe(0);
    const registration = lastJsonLine<RegistrationResult>(result.stdout);
    expect(registration).toMatchObject({
      Status: "what-if",
      DataDirectoryAction: "claim",
    });
    expect(registration.DataDir.toLowerCase()).toBe(resolve(dataDir).toLowerCase());
    // The mock state is evidence that no scheduler mutation was attempted.
    const scheduler = JSON.parse(readFileSync(stateFile, "utf8")) as SchedulerState;
    expect(scheduler.Operations).toEqual([]);
    expect(existsSync(join(dataDir, ".codex-local-remote-data-owner.json"))).toBe(false);
  });

  it("rejects an unowned non-empty DataDir even under registration WhatIf", () => {
    const sentinel = "TOKEN_SENTINEL_MUST_NOT_BE_READ";
    writeFileSync(join(dataDir, "foreign.token"), sentinel, "utf8");
    const result = runPowerShell(schedulerDriver, registrationArguments());
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("refusing");
    expect(`${result.stdout}${result.stderr}`).not.toContain(sentinel);
    const scheduler = JSON.parse(readFileSync(stateFile, "utf8")) as SchedulerState;
    expect(scheduler.Operations).toEqual([]);
    expect(existsSync(join(dataDir, ".codex-local-remote-data-owner.json"))).toBe(false);
  });

  it("fails migration preflight before any task or process command for an unsafe DataDir", () => {
    const sentinel = "TOKEN_SENTINEL_MUST_NOT_BE_READ";
    writeFileSync(join(dataDir, "foreign.token"), sentinel, "utf8");
    const result = runPowerShell(migrationDriver, [
      "-TargetScript",
      join(scripts, "Migrate-CodexLocalRemoteSharedOwner.ps1"),
      "-ModulePath",
      join(scripts, "CodexLocalRemote.Windows.psm1"),
      "-InstallRoot",
      join(sandbox, "migration install"),
      "-RollbackRoot",
      join(sandbox, "migration rollback"),
      "-DataDir",
      dataDir,
    ]);
    expect(result.status, `${result.error?.message ?? ""}\n${result.stderr}`).toBe(0);
    const preflight = lastJsonLine<MigrationPreflightResult>(result.stdout);
    expect(preflight.UnexpectedSuccess).toBe(false);
    expect(preflight.Error).toContain("refusing");
    expect(preflight.ForbiddenCalls).toEqual([]);
    expect(preflight.OutputContainsTokenSentinel).toBe(false);
  });
});
