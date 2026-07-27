import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const driver = join(import.meta.dirname, "fixtures", "migration-hardening-driver.ps1");

windowsOnly("shared-owner migration hardening", () => {
  it("passes the pure migration race, rollback, and evidence simulations", () => {
    const result = spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-File", driver], {
      encoding: "utf8",
      windowsHide: true,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      Status: "pass",
      Tests: 40,
    });
    expect(result.stdout).not.toMatch(/Bearer\s+|\/ws\/[A-Za-z0-9_-]{20,}/);
    expect(result.stderr).not.toMatch(/Bearer\s+|\/ws\/[A-Za-z0-9_-]{20,}/);
  });
});
