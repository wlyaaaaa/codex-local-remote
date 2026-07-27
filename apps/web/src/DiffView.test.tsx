import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DiffView, parseUnifiedDiff } from "./DiffView";

describe("DiffView", () => {
  it("parses unified diff line numbers without treating file headers as changes", () => {
    expect(
      parseUnifiedDiff(
        [
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -10,2 +10,3 @@",
          " const oldValue = 1;",
          "-return oldValue;",
          "+const newValue = 2;",
          "+return newValue;",
        ].join("\n"),
      ),
    ).toEqual([
      { kind: "header", text: "--- a/src/app.ts" },
      { kind: "header", text: "+++ b/src/app.ts" },
      { kind: "hunk", text: "@@ -10,2 +10,3 @@" },
      { kind: "context", newLine: 10, oldLine: 10, text: " const oldValue = 1;" },
      { kind: "deletion", oldLine: 11, text: "-return oldValue;" },
      { kind: "addition", newLine: 11, text: "+const newValue = 2;" },
      { kind: "addition", newLine: 12, text: "+return newValue;" },
    ]);
  });

  it("renders accessible red and green line classes instead of a raw terminal block", () => {
    const html = renderToStaticMarkup(<DiffView diff={"@@ -1 +1 @@\n-old\n+new"} />);

    expect(html).toContain('aria-label="文件差异"');
    expect(html).toContain("diff-view__line--deletion");
    expect(html).toContain("diff-view__line--addition");
    expect(html).not.toContain("<pre");
  });
});
