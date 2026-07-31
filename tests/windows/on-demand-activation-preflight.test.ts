import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");
const fixturePath = join(
  repositoryRoot,
  "tests",
  "windows",
  "fixtures",
  "on-demand-activation-preflight-driver.ps1",
);
const handoffPath = join(
  repositoryRoot,
  "scripts",
  "windows",
  "Invoke-CodexLocalRemoteOnDemandHandoff.ps1",
);

describe("Windows on-demand activation preflight", () => {
  it("allows only an exact switchable generation and fails closed on unsafe ownership", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "codex-on-demand-preflight-"));
    try {
      const result = spawnSync(
        "pwsh",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          fixturePath,
          "-ScriptPath",
          handoffPath,
          "-SandboxRoot",
          sandbox,
        ],
        { encoding: "utf8" },
      );

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        ExactTransition: {
          Passed: true,
          GenerationStatus: "transition-required",
          SidecarConnected: true,
          UnknownCount: 0,
          UnsafeThreadCount: 0,
        },
        IdentityDrift: {
          Passed: false,
          Failure:
            "Remote activation preflight found an active, unknown, detached-unsafe, or identity-mismatched managed generation.",
        },
        UnknownClient: {
          Passed: false,
          Failure:
            "Remote activation preflight found an active, unknown, detached-unsafe, or identity-mismatched managed generation.",
        },
        UnsafeThread: {
          Passed: false,
          Failure:
            "Remote activation preflight found an active, unknown, detached-unsafe, or identity-mismatched managed generation.",
        },
        ForeignListenerStart: {
          Passed: false,
          Failure:
            "Remote activation preflight found an unowned listener on managed TCP port 18790.",
        },
        MissingSelectedStart: {
          Passed: false,
          Failure:
            "Remote activation preflight cannot start from generation 'missing-selected-runtime'.",
        },
        MutationCalls: 0,
      });
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  });
});
