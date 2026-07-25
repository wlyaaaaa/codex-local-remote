import { expect, test } from "@playwright/test";

import { expectNoHorizontalOverflow, expectPrimaryTouchTargets, login } from "./helpers.js";

test.describe("六视口布局契约", () => {
  test("首页没有横向溢出且主要触控目标至少 44px", async ({ page }) => {
    await login(page);
    await expectNoHorizontalOverflow(page);
    await expectPrimaryTouchTargets(page);
  });

  test("新建对话和运行页保持移动端可用", async ({ page }) => {
    await login(page);
    await page.getByTestId("new-thread").click();
    await expect(page.getByTestId("new-thread-form")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectPrimaryTouchTargets(page);

    const prompt = page.getByTestId("new-thread-prompt");
    await prompt.fill("一段很长的移动端测试任务，确保输入区和模型选择器不会撑破页面。");
    await expectNoHorizontalOverflow(page);
  });

  test("导航标签具有文字或无障碍名称，不只依赖绿色", async ({ page }) => {
    await login(page);
    const navigation = page.getByTestId("primary-navigation");
    await expect(navigation).toBeVisible();
    const controls = navigation.getByRole("link").or(navigation.getByRole("button"));
    const count = await controls.count();
    expect(count).toBeGreaterThanOrEqual(3);
    for (let index = 0; index < count; index += 1) {
      const name = await controls.nth(index).getAttribute("aria-label");
      const text = (await controls.nth(index).textContent())?.trim();
      expect(Boolean(name?.trim() || text)).toBe(true);
    }
  });

  test("200% 字体放大后仍无页面级横向滚动", async ({ page }) => {
    await login(page);
    await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll<HTMLElement>("body, body *"));
      const originalSizes = elements.map((element) =>
        Number.parseFloat(window.getComputedStyle(element).fontSize),
      );
      elements.forEach((element, index) => {
        const originalSize = originalSizes[index];
        if (originalSize !== undefined && Number.isFinite(originalSize) && originalSize > 0) {
          element.style.setProperty("font-size", `${originalSize * 2}px`, "important");
        }
      });
    });
    await expectNoHorizontalOverflow(page);
    const structuralOverflow = await page.evaluate(() =>
      [
        document.documentElement,
        document.body,
        document.querySelector<HTMLElement>(".workspace-main"),
        document.querySelector<HTMLElement>('[data-testid="primary-navigation"]'),
      ]
        .filter((element): element is HTMLElement => element instanceof HTMLElement)
        .map((element) => ({
          className: element.className,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }))
        .filter(({ clientWidth, scrollWidth }) => scrollWidth > clientWidth + 1),
    );
    expect(structuralOverflow, "200% 真实计算字号下结构容器不能横向溢出").toEqual([]);
    await expect(page.getByTestId("primary-navigation")).toBeVisible();
    await expect(page.getByTestId("new-thread")).toBeVisible();
  });
});
