import { expect, test } from "@playwright/test";

import { login } from "./helpers.js";

test.describe("不可信模型内容渲染", () => {
  test("Markdown、SVG 和脚本载荷不会执行", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "__codexRemoteXssProbe", {
        configurable: false,
        value: false,
        writable: true,
      });
    });
    await login(page);
    await page.goto("./?demo=1#/threads/unsafe-content-thread");
    await expect(page.getByTestId("app-shell")).toBeVisible();
    const message = page.getByTestId("unsafe-content-message");
    await expect(message).toBeVisible();
    await expect(message.locator("script, iframe, object, embed")).toHaveCount(0);
    await expect(message.locator('a[href^="javascript:"]')).toHaveCount(0);
    await expect(message.locator("svg")).toHaveCount(0);
    await expect(
      page.evaluate(
        () => (window as Window & { __codexRemoteXssProbe?: boolean }).__codexRemoteXssProbe,
      ),
    ).resolves.toBe(false);
  });
});
