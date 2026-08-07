import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")) as {
  version: string;
};
const readme = readFileSync(resolve(repositoryRoot, "README.md"), "utf8");
const candidateNotes = readFileSync(
  resolve(repositoryRoot, "docs", "release-notes-v0.1.6.md"),
  "utf8",
);

describe("unreleased release-candidate metadata", () => {
  it("keeps the local 0.1.6 candidate distinct from the published v0.1.5 release", () => {
    expect(packageJson.version).toBe("0.1.6-unreleased.0");
    expect(readme).toContain("Latest published release: v0.1.5");
    expect(readme).toContain("Unreleased 0.1.6 candidate (E3/E4 pending)");
    expect(candidateNotes).toContain("candidate — unreleased");
    expect(candidateNotes).toContain("not a GitHub Release, tag");
    expect(candidateNotes).toContain("E3 and E4 real-machine recovery acceptance are incomplete");
  });
});
