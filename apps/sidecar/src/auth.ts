import { checkPasswordStrength, hashPassword } from "@codex-local-remote/security";

import { ProductHttpError } from "./errors.js";
import type { SidecarStateStore } from "./state-store.js";

export async function setupPassword(
  store: SidecarStateStore,
  password: string,
  confirmation: string,
): Promise<void> {
  if (password !== confirmation) {
    throw new ProductHttpError("PASSWORD_MISMATCH", "两次输入不一致", 400);
  }
  const strength = checkPasswordStrength(password);
  if (!strength.ok) {
    throw new ProductHttpError("PASSWORD_POLICY", "密码至少需要 15 个字符，且不能过于简单", 400);
  }
  await store.setPasswordHash(await hashPassword(password));
}
