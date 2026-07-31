import { describe, expect, it } from "vitest";

import {
  encodeLocalFileHrefForMarkdown,
  localFilePathFromHref,
  localFileReferenceFromHref,
} from "./file-link";

describe("localFilePathFromHref", () => {
  it("normalizes Desktop-style Windows links and removes a line number", () => {
    expect(localFilePathFromHref("Q:\\FixtureRoot\\AGENTS.md:41")).toBe("Q:/FixtureRoot/AGENTS.md");
  });

  it("removes line and column suffixes without removing the drive colon", () => {
    expect(localFilePathFromHref("V:/repo/src/App.tsx:657:12")).toBe("V:/repo/src/App.tsx");
    expect(localFileReferenceFromHref("V:/repo/src/App.tsx:657:12")).toEqual({
      path: "V:/repo/src/App.tsx",
      line: 657,
      column: 12,
    });
  });

  it("supports encoded file URLs and GitHub-style line fragments", () => {
    expect(localFilePathFromHref("file:///C:/Users/fixture/My%20Project/README.md%23L12C4")).toBe(
      "C:/Users/fixture/My Project/README.md",
    );
    expect(
      localFileReferenceFromHref("file:///C:/Users/fixture/My%20Project/README.md%23L12C4"),
    ).toEqual({
      path: "C:/Users/fixture/My Project/README.md",
      line: 12,
      column: 4,
    });
  });

  it("does not intercept web links or document anchors", () => {
    expect(localFilePathFromHref("https://example.com/file.ts:41")).toBeUndefined();
    expect(localFilePathFromHref("#L41")).toBeUndefined();
  });

  it("encodes local paths as sanitizer-safe relative links and rejects executable schemes", () => {
    const encoded = encodeLocalFileHrefForMarkdown(
      "Q:/PublicFixtures/reports/review-evidence.json:87",
    );
    expect(encoded).toMatch(/^\/__codex_local_file__\//u);
    expect(localFileReferenceFromHref(encoded)).toEqual({
      path: "Q:/PublicFixtures/reports/review-evidence.json",
      line: 87,
    });
    expect(encodeLocalFileHrefForMarkdown("docs/guide.md:12")).toBeTruthy();
    expect(encodeLocalFileHrefForMarkdown("javascript:alert(1)")).toBeUndefined();
    expect(encodeLocalFileHrefForMarkdown("https://example.com/readme.md")).toBeUndefined();
  });
});
