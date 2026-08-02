import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const modulePath = join(repositoryRoot, "scripts", "windows", "CodexLocalRemote.Windows.psm1");
const driver = join(import.meta.dirname, "fixtures", "process-tree-identity-driver.ps1");

interface ProcessSnapshot {
  ProcessId: number;
  ParentProcessId: number;
  CreationDate: string;
  Name: string;
  ExecutablePath: string;
  CommandLine: string;
}

interface Outcome {
  Succeeded: boolean;
  Error: string | null;
  Members: Array<{
    ProcessId: number;
    ParentProcessId: number;
    Depth: number;
  }>;
  OpenIds: number[];
  StopIds: number[];
  StopTreeFlags: boolean[];
  DisposeIds: number[];
  ExportedCommands?: string[];
  ImagePath?: string;
}

windowsOnly("Windows process-tree startup identity snapshots", () => {
  let sandbox: string;
  let scenarioFile: string;

  beforeEach(() => {
    sandbox = join(tmpdir(), `codex-process-tree-${crypto.randomUUID()}`);
    scenarioFile = join(sandbox, "scenario.json");
    mkdirSync(sandbox, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function processTree(childPredatesParent = false): ProcessSnapshot[] {
    return [
      {
        ProcessId: 6100,
        ParentProcessId: 1,
        CreationDate: "20260726010101.000000-000",
        Name: "root.exe",
        ExecutablePath: "C:\\Managed\\root.exe",
        CommandLine: '"C:\\Managed\\root.exe"',
      },
      {
        ProcessId: 6101,
        ParentProcessId: 6100,
        CreationDate: childPredatesParent
          ? "20260726010100.000000-000"
          : "20260726010102.000000-000",
        Name: "child.exe",
        ExecutablePath: "C:\\Managed\\child.exe",
        CommandLine: '"C:\\Managed\\child.exe"',
      },
      {
        ProcessId: 6102,
        ParentProcessId: 6101,
        CreationDate: "20260726010103.000000-000",
        Name: "grandchild.exe",
        ExecutablePath: "C:\\Managed\\grandchild.exe",
        CommandLine: '"C:\\Managed\\grandchild.exe"',
      },
    ];
  }

  function runScenario(
    mode:
      | "exports"
      | "native-image-query"
      | "root-exits-after-open"
      | "root-creation-drift"
      | "child-predates-parent",
    processes = processTree(mode === "child-predates-parent"),
  ) {
    writeFileSync(
      scenarioFile,
      JSON.stringify({ RootProcessId: 6100, Processes: processes }),
      "utf8",
    );
    const execution = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        driver,
        "-ModulePath",
        modulePath,
        "-ScenarioFile",
        scenarioFile,
        "-Mode",
        mode,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    return {
      execution,
      outcome: JSON.parse(execution.stdout.trim()) as Outcome,
    };
  }

  it("exports every process-tree command used by production scripts", () => {
    const { execution, outcome } = runScenario("exports");

    expect(execution.status).toBe(0);
    expect(outcome.Succeeded).toBe(true);
    expect(outcome.ExportedCommands).toEqual([
      "Close-ProcessTreeIdentitySnapshot",
      "Get-CodexLocalRemoteProcessImagePath",
      "Open-ProcessTreeIdentitySnapshot",
      "Stop-ProcessTreeIdentitySnapshot",
    ]);
  });

  it("queries a real process image through the exported native helper", () => {
    const { execution, outcome } = runScenario("native-image-query");

    expect(execution.status).toBe(0);
    expect(outcome.Succeeded).toBe(true);
    expect(basename(outcome.ImagePath ?? "").toLowerCase()).toBe("pwsh.exe");
  });

  it("captures one exact two-level tree and still retires surviving descendants leaf-to-root after the root exits", () => {
    const { execution, outcome } = runScenario("root-exits-after-open");

    expect(execution.status).toBe(0);
    expect(outcome).toMatchObject({
      Succeeded: true,
      Members: [
        { ProcessId: 6100, ParentProcessId: 1, Depth: 0 },
        { ProcessId: 6101, ParentProcessId: 6100, Depth: 1 },
        { ProcessId: 6102, ParentProcessId: 6101, Depth: 2 },
      ],
      OpenIds: [6100, 6101, 6102],
      StopIds: [6102, 6101],
      StopTreeFlags: [true, true],
      DisposeIds: [6100, 6101, 6102],
    });
  });

  it("fails closed before opening or killing anything when the root creation identity drifts", () => {
    const { execution, outcome } = runScenario("root-creation-drift");

    expect(execution.status).not.toBe(0);
    expect(outcome.Succeeded).toBe(false);
    expect(outcome.Error).toContain("root PID 6100 changed creation identity");
    expect(outcome.OpenIds).toEqual([]);
    expect(outcome.StopIds).toEqual([]);
    expect(outcome.DisposeIds).toEqual([]);
  });

  it("fails closed before any kill and disposes the already-held root when a child predates its parent", () => {
    const { execution, outcome } = runScenario("child-predates-parent");

    expect(execution.status).not.toBe(0);
    expect(outcome.Succeeded).toBe(false);
    expect(outcome.Error).toContain("descendant PID 6101 predates its parent");
    expect(outcome.OpenIds).toEqual([6100]);
    expect(outcome.StopIds).toEqual([]);
    expect(outcome.DisposeIds).toEqual([6100]);
  });
});
