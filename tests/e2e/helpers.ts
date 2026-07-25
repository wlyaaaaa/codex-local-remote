import { expect, type Page } from "@playwright/test";

export const E2E_PASSWORD =
  process.env["CODEX_REMOTE_E2E_PASSWORD"] ?? "e2e-only-not-a-real-secret";

export async function login(page: Page): Promise<void> {
  await page.goto(process.env["CODEX_REMOTE_E2E_URL"] ? "./" : "./?demo=1");
  const loginForm = page.getByTestId("login-form");
  if (await loginForm.isVisible().catch(() => false)) {
    await page.getByTestId("login-password").fill(E2E_PASSWORD);
    await page.getByTestId("login-submit").click();
  }
  await expect(page.getByTestId("app-shell")).toBeVisible();
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(
    Math.max(dimensions.document, dimensions.body),
    `页面宽度 ${Math.max(dimensions.document, dimensions.body)} 超过视口 ${dimensions.viewport}`,
  ).toBeLessThanOrEqual(dimensions.viewport + 1);
}

export async function expectPrimaryTouchTargets(page: Page): Promise<void> {
  const targets = page.locator('[data-touch-target="primary"]:visible');
  const count = await targets.count();
  expect(count, "页面应标记至少一个主要触控目标").toBeGreaterThan(0);

  const violations: Array<{
    testId: string | null;
    width: number;
    height: number;
  }> = [];
  for (let index = 0; index < count; index += 1) {
    const target = targets.nth(index);
    const box = await target.boundingBox();
    if (box !== null && (box.width < 44 || box.height < 44)) {
      violations.push({
        testId: await target.getAttribute("data-testid"),
        width: box.width,
        height: box.height,
      });
    }
  }
  expect(violations, "主要触控目标必须至少为 44×44 CSS px").toEqual([]);
}
