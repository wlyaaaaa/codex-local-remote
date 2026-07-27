import { describe, expect, it } from "vitest";

import { createWindowsDpapiPromptProtector } from "./prompt-protector.js";

describe.runIf(process.platform === "win32")("Windows DPAPI prompt protector", () => {
  it("round-trips a synthetic pending message without exposing it in the envelope", async () => {
    const protector = createWindowsDpapiPromptProtector();
    const marker = `合成队列标记-${Date.now()}\nemoji: 🧪 𠮷`;

    const protectedValue = await protector.protect(marker);

    expect(protectedValue).not.toContain(marker);
    await expect(protector.unprotect(protectedValue)).resolves.toBe(marker);
  });
});
