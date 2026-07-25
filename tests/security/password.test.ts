import { describe, expect, it } from "vitest";

import {
  checkPasswordStrength,
  hashPassword,
  verifyPassword,
} from "../../packages/security/src/index.js";

describe("password security", () => {
  it.each([
    "",
    "short",
    "password123!",
    "aaaaaaaaaaaa!",
    "aaaaaaaaaaaaaaaaaaaa",
    "             ",
    "correct horse",
  ])("rejects weak password %j", (password) => {
    expect(checkPasswordStrength(password).ok).toBe(false);
  });

  it("accepts a long passphrase without forcing ASCII-only composition", () => {
    expect(checkPasswordStrength("青山-河流-玻璃-月光-7429").ok).toBe(true);
    expect(checkPasswordStrength("thisisalongpassphrase").ok).toBe(true);
  });

  it("hashes with a unique salt and verifies without storing plaintext", async () => {
    const password = "Green!Remote#2026";
    const first = await hashPassword(password);
    const second = await hashPassword(password);

    expect(first).not.toBe(second);
    expect(first).not.toContain(password);
    await expect(verifyPassword(password, first)).resolves.toBe(true);
    await expect(verifyPassword("Green!Remote#2027", first)).resolves.toBe(false);
  });

  it.each([
    "",
    "not-a-hash",
    "scrypt$v=1$N=999999999$r=8$p=1$bad$bad",
    "scrypt$v=2$N=16384$r=8$p=1$bad$bad",
  ])("fails closed for malformed or hostile encoded hashes", async (encoded) => {
    await expect(verifyPassword("Green!Remote#2026", encoded)).resolves.toBe(false);
  });

  it("rejects an oversized verification input before spending scrypt work", async () => {
    const encoded = await hashPassword("Green!Remote#2026");
    await expect(verifyPassword("x".repeat(2_000), encoded)).resolves.toBe(false);
  });
});
