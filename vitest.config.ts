import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["apps/*/src/**/*.ts", "packages/*/src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "html"],
    },
    exclude: ["**/.local/**", "**/node_modules/**", "**/dist/**", "tests/e2e/**"],
    passWithNoTests: false,
    // The Windows contract tests launch real, isolated pwsh processes. Under a
    // full parallel suite, process creation and ACL inspection can legitimately
    // exceed Vitest's 5 s unit-test default without indicating a product hang.
    testTimeout: process.platform === "win32" ? 15_000 : 5_000,
  },
});
