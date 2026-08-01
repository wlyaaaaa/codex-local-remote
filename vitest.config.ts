import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["apps/*/src/**/*.ts", "packages/*/src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "html"],
    },
    exclude: ["**/.local/**", "**/node_modules/**", "**/dist/**", "tests/e2e/**"],
    // The root suite contains many Windows fixtures that synchronously launch
    // isolated PowerShell processes. Keep enough parallelism for fast unit
    // tests without exhausting process/ACL resources and creating false
    // timeout failures on high-core Windows hosts.
    maxWorkers: process.platform === "win32" ? 4 : undefined,
    passWithNoTests: false,
    // The Windows contract tests launch real, isolated pwsh processes. Under a
    // full parallel suite, process creation and ACL inspection can legitimately
    // exceed Vitest's 5 s unit-test default without indicating a product hang.
    testTimeout: process.platform === "win32" ? 15_000 : 5_000,
  },
});
