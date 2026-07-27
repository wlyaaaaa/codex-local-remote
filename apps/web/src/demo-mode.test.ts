import { describe, expect, it } from "vitest";

import { isDemoModeAllowed } from "./demo-mode";

describe("demo mode boundary", () => {
  it.each(["127.0.0.1", "localhost", "::1", "[::1]"])(
    "allows explicit demo data on the loopback host %s",
    (hostname) => {
      expect(
        isDemoModeAllowed({
          buildEnabled: false,
          hostname,
          search: "?demo=1",
          storedPreference: null,
        }),
      ).toBe(true);
    },
  );

  it("never exposes synthetic demo data on a public hostname", () => {
    expect(
      isDemoModeAllowed({
        buildEnabled: true,
        hostname: "remote.example.com",
        search: "?demo=1",
        storedPreference: "1",
      }),
    ).toBe(false);
  });

  it("keeps a normal loopback visit on the real API", () => {
    expect(
      isDemoModeAllowed({
        buildEnabled: false,
        hostname: "127.0.0.1",
        search: "",
        storedPreference: null,
      }),
    ).toBe(false);
  });
});
