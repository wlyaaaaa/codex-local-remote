import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const modulePath = join(
  repositoryRoot,
  "scripts",
  "windows",
  "CodexLocalRemote.Windows.psm1",
);
const driver = join(
  import.meta.dirname,
  "fixtures",
  "native-desktop-root-candidates-driver.ps1",
);

windowsOnly("Windows native Desktop root classification", () => {
  it("ignores only metadata-empty transient children of an exact root", () => {
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        driver,
        "-ModulePath",
        modulePath,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      TransientChild: [41001],
      TrueSecondRoot: [41001, 42001],
      ForeignRoot: [41001, 43001],
      UnresolvedRoot: [41001, 44001],
    });
  });
});
