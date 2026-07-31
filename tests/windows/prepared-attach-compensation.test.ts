import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");
const windowsOnly = process.platform === "win32" ? describe : describe.skip;

windowsOnly("prepared Desktop attach compensation", () => {
  it("preserves the original root or replaces a failed attached root with one native root", () => {
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
          "prepared-attach-compensation-driver.ps1",
        ),
        "-ScriptPath",
        join(repositoryRoot, "scripts", "windows", "Invoke-CodexLocalRemoteOnDemandHandoff.ps1"),
      ],
      { encoding: "utf8" },
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      OriginalStillPresent: {
        Status: "native-restored",
        DesktopRestored: false,
        StopCalls: 0,
        NativeStartCalls: 0,
        DesiredNativeCalls: 1,
        CompletionCalls: 1,
      },
      NoRootPresent: {
        Status: "native-restored",
        DesktopRestored: true,
        StopCalls: 0,
        NativeStartCalls: 1,
        DesiredNativeCalls: 1,
        CompletionCalls: 1,
      },
      FailedAttachedRootPresent: {
        Status: "native-restored",
        DesktopRestored: true,
        StopCalls: 1,
        NativeStartCalls: 1,
        DesiredNativeCalls: 1,
        CompletionCalls: 1,
      },
    });
  });
});
