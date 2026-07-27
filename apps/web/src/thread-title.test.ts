import { describe, expect, it } from "vitest";

import { threadLocationLabelForDisplay, threadTitleForDisplay } from "./thread-title";

describe("threadTitleForDisplay", () => {
  it("decodes the legacy percent-encoded Markdown title regression", () => {
    expect(threadTitleForDisplay("%2A%2Asteamcommunity.com%2A%2A")).toBe("steamcommunity.com");
  });

  it("keeps malformed percent input readable", () => {
    expect(threadTitleForDisplay("完成 100% 与 %2G")).toBe("完成 100% 与 %2G");
  });
});

describe("threadLocationLabelForDisplay", () => {
  it("labels managed tasks without a registered project as no-project tasks", () => {
    expect(
      threadLocationLabelForDisplay({
        mode: "managed",
      }),
    ).toBe("无项目");
  });

  it("preserves an explicit Desktop snapshot location", () => {
    expect(
      threadLocationLabelForDisplay({
        cwdLabel: ".agents",
        mode: "desktop-snapshot",
      }),
    ).toBe(".agents");
  });
});
