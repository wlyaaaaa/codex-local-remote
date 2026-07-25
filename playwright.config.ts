import { defineConfig, devices } from "@playwright/test";

const externalBaseUrl = process.env["CODEX_REMOTE_E2E_URL"];
const previewPort = Number(process.env["CODEX_REMOTE_E2E_PREVIEW_PORT"] ?? "18792");
if (!Number.isInteger(previewPort) || previewPort < 1 || previewPort > 65_535) {
  throw new Error("CODEX_REMOTE_E2E_PREVIEW_PORT must be a valid TCP port");
}
const previewOrigin = `http://127.0.0.1:${previewPort}/`;
const viewports = [
  { name: "android-small", width: 360, height: 800 },
  { name: "android-standard", width: 390, height: 844 },
  { name: "xiaomi-15-pro", width: 412, height: 915 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
  { name: "desktop-wide", width: 1440, height: 900 },
];

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never" }]],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: `pnpm --filter @codex-local-remote/web build && pnpm --filter @codex-local-remote/web preview --host 127.0.0.1 --port ${previewPort} --strictPort`,
        reuseExistingServer: process.env["CI"] !== "true",
        timeout: 120_000,
        url: previewOrigin,
      },
  use: {
    baseURL: externalBaseUrl ?? previewOrigin,
    colorScheme: "light",
    locale: "zh-CN",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: viewports.map(({ name, width, height }) => ({
    name,
    use: {
      ...(width < 800 ? devices["Pixel 7"] : devices["Desktop Chrome"]),
      viewport: { width, height },
    },
  })),
});
