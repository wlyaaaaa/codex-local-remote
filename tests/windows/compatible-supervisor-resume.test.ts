import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");

describe("Windows compatible supervisor resume", () => {
  it("starts only the current supervisor when the previous Broker is exact and attached", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "codex-compatible-supervisor-"));
    try {
      const result = spawnSync(
        "pwsh",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          join(
            repositoryRoot,
            "tests",
            "windows",
            "fixtures",
            "compatible-supervisor-resume-driver.ps1",
          ),
          "-ScriptPath",
          join(repositoryRoot, "scripts", "windows", "Launch-CodexWithRemote.ps1"),
          "-SandboxRoot",
          sandbox,
        ],
        { encoding: "utf8" },
      );

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      const receipt = JSON.parse(result.stdout) as {
        Exact: {
          Passed: boolean;
          Decision: string;
          ActiveRoot: string;
          BrokerProcessId: number;
          DesktopProcessIdentity: string;
          UnsafeThreadCount: number;
        };
        PayloadMismatch: { Passed: boolean };
        StaleSidecarAlive: { Passed: boolean };
        SidecarPortOccupied: { Passed: boolean };
        IdentityDrift: { Passed: boolean };
        UnknownClient: { Passed: boolean };
        ProofMatches: boolean;
        StartCalls: number;
        SwitchCalls: number;
        DesktopGateCalls: number;
        TaskDefinitionDriftFailed: boolean;
        WithoutProofFailed: boolean;
      };

      expect(receipt.Exact).toMatchObject({
        Passed: true,
        Decision: "resume-compatible-supervisor",
        BrokerProcessId: 4101,
        DesktopProcessIdentity: "4301:638896302000000000",
        UnsafeThreadCount: 8,
      });
      expect(receipt.Exact.ActiveRoot).toMatch(/[\\/]b{64}$/u);
      expect(receipt.PayloadMismatch.Passed).toBe(false);
      expect(receipt.StaleSidecarAlive.Passed).toBe(false);
      expect(receipt.SidecarPortOccupied.Passed).toBe(false);
      expect(receipt.IdentityDrift.Passed).toBe(false);
      expect(receipt.UnknownClient.Passed).toBe(false);
      expect(receipt.ProofMatches).toBe(true);
      expect(receipt.StartCalls).toBe(1);
      expect(receipt.SwitchCalls).toBe(0);
      expect(receipt.DesktopGateCalls).toBe(0);
      expect(receipt.TaskDefinitionDriftFailed).toBe(true);
      expect(receipt.WithoutProofFailed).toBe(true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
