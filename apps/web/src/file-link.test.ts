import { describe, expect, it } from "vitest";

import { localFilePathFromHref } from "./file-link";

describe("localFilePathFromHref", () => {
  it("normalizes Desktop-style Windows links and removes a line number", () => {
    expect(localFilePathFromHref("E:\\.agents\\AGENTS.md:41")).toBe("E:/.agents/AGENTS.md");
  });

  it("removes line and column suffixes without removing the drive colon", () => {
    expect(localFilePathFromHref("V:/repo/src/App.tsx:657:12")).toBe("V:/repo/src/App.tsx");
  });

  it("supports encoded file URLs and GitHub-style line fragments", () => {
    expect(localFilePathFromHref("file:///C:/Users/10979/My%20Project/README.md%23L12C4")).toBe(
      "C:/Users/10979/My Project/README.md",
    );
  });

  it("does not intercept web links or document anchors", () => {
    expect(localFilePathFromHref("https://example.com/file.ts:41")).toBeUndefined();
    expect(localFilePathFromHref("#L41")).toBeUndefined();
  });
});
