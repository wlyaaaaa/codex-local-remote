import { describe, expect, it } from "vitest";

import config from "./vite.config.js";

describe("Vite development listener", () => {
  it("uses an ephemeral port instead of a managed runtime port", () => {
    expect(typeof config).toBe("object");
    if (typeof config !== "object" || config === null) {
      throw new TypeError("Expected an object Vite config.");
    }

    expect(config.server?.port).toBe(0);
    expect([18_790, 18_791, 18_792]).not.toContain(config.server?.port);
  });
});
