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
    await page.locator('[data-testid="new-thread"]:visible').click();
    await expect(page.getByTestId("new-thread-form")).toBeVisible();
    await expect(page.getByTestId("general-conversation-option")).toContainText("不关联项目");
    await expectNoHorizontalOverflow(page);
    await expectPrimaryTouchTargets(page);

    const prompt = page.getByTestId("new-thread-prompt");
    const draft = "一段很长的移动端测试任务，确保输入区和模型选择器不会撑破页面。";
    await prompt.fill(draft);
    await expectNoHorizontalOverflow(page);
    await page.reload();
    await expect(page.getByTestId("new-thread-prompt")).toHaveValue(draft);
  });

  test("运行中模型选择始终明确标注为下一轮", async ({ page }) => {
    await login(page);
    await page.goto("./?demo=1#/threads/thread-active");

    const badge = page.locator(".next-turn-badge");
    const hint = page.getByTestId("next-turn-model-notice");
    await expect(badge).toBeVisible();
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("下一轮");
    const hintFontSize = await hint.evaluate((element) =>
      Number.parseFloat(window.getComputedStyle(element).fontSize),
    );
    expect(hintFontSize).toBeGreaterThanOrEqual(12);
    await expectNoHorizontalOverflow(page);
  });

  test("运行中只显示真实最新动作，不显示计时、历史思考框或边框", async ({ page }) => {
    await login(page);
    await page.goto("./?demo=1#/threads/thread-active");

    const livePhase = page.locator(".live-phase");
    await expect(livePhase).toBeVisible();
    await expect(livePhase).not.toContainText(/(?:正在思考|已处理)\s*\d+\s*秒/u);
    await expect(page.locator(".reasoning-item")).toHaveCount(0);
    await expect(livePhase).toHaveText("正在验证前端构建");

    const chrome = await livePhase.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderWidth: style.borderWidth,
        boxShadow: style.boxShadow,
      };
    });
    expect(chrome).toEqual({
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderWidth: "0px",
      boxShadow: "none",
    });
  });

  test("长审批抽屉的底部决定按钮始终在视口内可操作", async ({ page }) => {
    await login(page);
    await page.getByTestId("approval-open").click();
    const action = page.getByTestId("approval-choice-allow");
    await expect(action).toBeVisible();
    const geometry = await action.evaluate((element) => {
      const actionRect = element.getBoundingClientRect();
      const sheetRect = element.closest(".ui-sheet")?.getBoundingClientRect();
      const body = element.closest(".ui-sheet")?.querySelector<HTMLElement>(".ui-sheet__body");
      return {
        actionBottom: actionRect.bottom,
        actionTop: actionRect.top,
        bodyClientHeight: body?.clientHeight ?? 0,
        bodyScrollHeight: body?.scrollHeight ?? 0,
        sheetBottom: sheetRect?.bottom ?? 0,
        sheetTop: sheetRect?.top ?? 0,
        viewportHeight: window.innerHeight,
      };
    });
    expect(geometry.actionTop).toBeGreaterThanOrEqual(geometry.sheetTop);
    expect(geometry.actionBottom).toBeLessThanOrEqual(
      Math.min(geometry.sheetBottom, geometry.viewportHeight) + 1,
    );
    expect(geometry.bodyScrollHeight).toBeGreaterThanOrEqual(geometry.bodyClientHeight);
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

  test("搜索输入与文件路径按钮保持至少 44px 的触控高度", async ({ page }) => {
    await login(page);
    await page.goto("./?demo=1#/threads");
    const conversationSearch = page.getByLabel("搜索任务");
    await expect(conversationSearch).toBeVisible();
    expect((await conversationSearch.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

    await page.goto("./?demo=1#/files");
    const fileSearch = page.getByLabel("筛选当前文件夹");
    const breadcrumbButtons = page.locator(".breadcrumbs button");
    await expect(fileSearch).toBeVisible();
    await expect(breadcrumbButtons.first()).toBeVisible();
    expect((await fileSearch.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    const breadcrumbCount = await breadcrumbButtons.count();
    for (let index = 0; index < breadcrumbCount; index += 1) {
      expect(
        (await breadcrumbButtons.nth(index).boundingBox())?.height ?? 0,
      ).toBeGreaterThanOrEqual(44);
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
    await expect(page.locator('[data-testid="new-thread"]:visible')).toBeVisible();
  });
});
