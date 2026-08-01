import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");
const windowsOnly = process.platform === "win32" ? describe : describe.skip;

windowsOnly("Desktop handoff preparation receipt", () => {
  it("moves through requested, ready, attaching, and completion with exact read-back", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "codex-handoff-preparation-"));
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
            "desktop-handoff-preparation-driver.ps1",
          ),
          "-ModulePath",
          join(repositoryRoot, "scripts", "windows", "CodexLocalRemote.Windows.psm1"),
          "-SandboxPath",
          sandbox,
        ],
        { encoding: "utf8" },
      );

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        RequestedPhase: "requested",
        ReadyPhase: "ready",
        ReadyInvocationId: "c".repeat(32),
        ReadySidecarProcessId: 42003,
        AttachingPhase: "attaching",
        Completed: true,
        CurrentRemovedAfterCompletion: true,
        LastReceiptWritten: true,
        TamperedRejected: true,
        TamperedReplaced: true,
        DifferentFreshPreparationBlocked: true,
        DifferentRuntimeOrphanReplaced: true,
        SameRuntimeOrphanReplaced: true,
        AmbiguousDesktopRootsBlocked: true,
      });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
