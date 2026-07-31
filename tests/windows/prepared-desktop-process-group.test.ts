import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");
const windowsOnly = process.platform === "win32" ? describe : describe.skip;

windowsOnly("prepared Desktop process-group close", () => {
  it("stops only the exact root, Electron children, and bundled app-server", () => {
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
          "prepared-desktop-process-group-driver.ps1",
        ),
        "-ScriptPath",
        join(repositoryRoot, "scripts", "windows", "Invoke-CodexLocalRemoteOnDemandHandoff.ps1"),
      ],
      { encoding: "utf8" },
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      StoppedProcessIds: [100, 101, 102],
      DisposedProcessIds: [100, 101, 102],
      PreservedUnrelatedDirectChild: true,
      PreservedNestedTaskProcess: true,
    });
  });
});
