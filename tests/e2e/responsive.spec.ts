import { expect, test } from "@playwright/test";

import { expectNoHorizontalOverflow, expectPrimaryTouchTargets, login } from "./helpers.js";
import { openSharedThread, SharedRuntime } from "./shared-runtime.js";

test.describe("六视口布局契约", () => {
  test("长工作记录在六视口均可紧凑展开且不丢最终回答", async ({ page }) => {
    const runtime = new SharedRuntime({ longWorkLog: true });
    await runtime.attach(page.context());

    try {
      await openSharedThread(page);
      const workLog = page.locator("section.work-log");
      const toggle = workLog.getByRole("button", { name: /工作记录/u }).first();

      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByText("先确认真实历史基线", { exact: true })).toHaveCount(0);
      await expect(page.getByText("正在核对长对话顺序", { exact: true })).toBeVisible();
      await expect(page.getByText("准备给出最终结果", { exact: true })).toBeVisible();
      await expect(workLog.getByText("进展", { exact: true }).first()).toBeVisible();
      await expect(workLog.getByText("思考", { exact: true })).toHaveCount(0);
      await expect(page.getByText("完整工作记录之后的最终回答。", { exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      expect((await toggle.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByText("完整工作记录之后的最终回答。", { exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page);

      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByText("先确认真实历史基线", { exact: true })).toHaveCount(0);
      await expectNoHorizontalOverflow(page);

      if ((page.viewportSize()?.width ?? 0) <= 700) {
        const activity = workLog.locator("details.activity-record");
        const subagent = workLog.getByRole("button", { name: "历史完整性检查" });
        expect(
          (await activity.locator("summary").boundingBox())?.height ?? 0,
        ).toBeGreaterThanOrEqual(44);
        expect((await subagent.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      }
    } finally {
      await runtime.close();
    }
  });

  test("超大运行中对话只在用户要求时向前加载一页本地历史", async ({ page }) => {
    const runtime = new SharedRuntime({ deferredHistory: true });
    await runtime.attach(page.context());

    try {
      await openSharedThread(page);
      const history = page.getByTestId("conversation-history-more");
      await expect(history).toBeVisible();
      await page.waitForTimeout(250);
      expect(runtime.historyRequests).toEqual([]);

      await history.click();
      await expect.poll(() => runtime.historyRequests).toEqual(["persisted-page-2"]);
      await expect(
        page.getByText("这是从本地固定窗口安全加载的更早记录。", { exact: true }),
      ).toBeVisible();
      await expect(history).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
    } finally {
      await runtime.close();
    }
  });

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

  test("运行中设置按钮保持简洁、完整且没有重复提示行", async ({ page }) => {
    await login(page);
    await page.goto("./?demo=1#/threads/thread-active");

    const settings = page.getByTestId("composer-settings-open");
    const modelLabel = settings.locator(".composer-settings-button__model");
    await expect(page.locator(".next-turn-badge")).toHaveCount(0);
    await expect(page.getByTestId("next-turn-model-notice")).toHaveCount(0);
    await expect(modelLabel).toHaveText("GPT-5.4");
    expect(
      await modelLabel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    await expect(settings).toHaveAttribute("aria-label", /模型与运行设置/u);
    await settings.click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("heading", { name: "模型与运行设置" })).toBeVisible();
    await expect(sheet.getByTestId("runtime-model-outside-catalog")).toContainText("GPT-5.4");
    await sheet.getByRole("button", { name: /^GPT-5\.3-Codex-Spark/u }).click();
    await expect(sheet.getByRole("button", { name: "高", exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: /^标准/u })).toBeVisible();
    await sheet.getByRole("button", { name: "保存设置" }).click();
    await expect(modelLabel).toHaveText("5.3 Spark");
    expect(
      await modelLabel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    if ((page.viewportSize()?.width ?? 0) <= 412) {
      const composer = page.getByTestId("turn-composer");
      await composer.focus();
      await expect(composer).not.toHaveAttribute("readonly");
      const mobileControls = [
        settings,
        page.getByTestId("composer-mode-open"),
        page.getByTestId("composer-plan-progress").locator("summary"),
      ];
      await expect(page.getByTestId("composer-plan-progress")).toContainText(/第 \d+\/\d+ 步/u);
      for (const control of mobileControls) {
        const box = await control.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      }
      await page.getByTestId("composer-plan-progress").evaluate((details) => {
        if (details instanceof HTMLDetailsElement) {
          details.open = true;
          details.dispatchEvent(new Event("toggle"));
        }
      });
      const close = page.getByTestId("composer-plan-progress-close");
      await expect(close).toBeVisible();
      const closeBox = await close.boundingBox();
      expect(closeBox?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(closeBox?.width ?? 0).toBeGreaterThanOrEqual(44);
    }
    await expectNoHorizontalOverflow(page);
  });

  test("设置页显示 Codex 登录账号且额度卡片不重复报错", async ({ page }) => {
    await login(page);
    await page.goto("./?demo=1#/settings");

    const account = page.getByTestId("codex-account-identity");
    await expect(account).toContainText("Codex 登录账号");
    await expect(account).toContainText("demo@example.invalid");
    await expect(page.getByTestId("usage-panel")).not.toContainText("暂时无法读取");
    await expectNoHorizontalOverflow(page);
    await expectPrimaryTouchTargets(page);
  });

  test("手机端目标与运行控制均保持至少 44px 触控高度", async ({ page }) => {
    const runtime = new SharedRuntime({ complexState: true });
    await runtime.attach(page.context());

    try {
      await openSharedThread(page);
      if ((page.viewportSize()?.width ?? 0) > 412) return;
      const composer = page.getByTestId("turn-composer");
      await composer.focus();
      await expect(composer).not.toHaveAttribute("readonly");

      const targets = [
        page.getByTestId("composer-settings-open"),
        page.getByTestId("composer-goal-open"),
        page.getByTestId("composer-mode-open"),
      ];
      for (const target of targets) {
        await expect(target).toBeVisible();
        const box = await target.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      }

      const goalRow = page.locator(".composer__goal-row");
      const contextRow = page.locator(".composer__context-bar");
      const [goalBox, contextBox] = await Promise.all([
        goalRow.boundingBox(),
        contextRow.boundingBox(),
      ]);
      expect(
        goalBox === null ? Number.POSITIVE_INFINITY : goalBox.y + goalBox.height,
      ).toBeLessThanOrEqual((contextBox?.y ?? 0) + 1);

      const goalText = page.locator(".composer-goal__summary strong");
      await expect(goalText).toContainText("完成移动端复杂状态验收");
      const goalPresentation = await goalText.evaluate((element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const buttonRect = element.closest("button")?.getBoundingClientRect();
        return {
          whiteSpace: style.whiteSpace,
          insideButton: buttonRect ? rect.right <= buttonRect.right + 1 : false,
          visibleHeight: rect.height,
        };
      });
      expect(goalPresentation.whiteSpace).toBe("normal");
      expect(goalPresentation.insideButton).toBe(true);
      expect(goalPresentation.visibleHeight).toBeGreaterThan(0);

      await expectNoHorizontalOverflow(page);
    } finally {
      await runtime.close();
    }
  });

  test("手机端折叠输入框与发送控件互不覆盖", async ({ page }) => {
    if ((page.viewportSize()?.width ?? 0) > 412) return;
    await login(page);
    await page.goto("./?demo=1#/threads/thread-active");

    await expect(page.getByTestId("conversation-loading")).toHaveCount(0);
    const shell = page.locator(".composer-shell--collapsed");
    await expect(shell).toBeVisible();
    const textarea = page.getByTestId("turn-composer");
    const footer = shell.locator(".composer__footer");
    await expect(textarea).toBeVisible();
    await expect(footer).toBeVisible();
    const [textareaBox, footerBox] = await Promise.all([
      textarea.boundingBox(),
      footer.boundingBox(),
    ]);
    expect(
      textareaBox === null ? Number.POSITIVE_INFINITY : textareaBox.x + textareaBox.width,
    ).toBeLessThanOrEqual((footerBox?.x ?? 0) + 1);
    await expectNoHorizontalOverflow(page);
  });

  test("手机端逐个移除附件不会关闭选择器或误收起输入框", async ({ page }) => {
    if ((page.viewportSize()?.width ?? 0) > 412) return;
    await login(page);
    await page.evaluate(() => {
      const attachments = Array.from({ length: 13 }, (_, index) => ({
        kind: "file",
        relativePath: `file-${String(index + 1).padStart(2, "0")}.txt`,
        uploadId: `upload-${String(index + 1).padStart(2, "0")}`,
      }));
      window.localStorage.setItem(
        "conversation-attachments:thread-active",
        JSON.stringify(attachments),
      );
    });
    await page.goto("./?demo=1#/threads/thread-active");
    await expect(page.getByTestId("conversation-loading")).toHaveCount(0);

    const composer = page.getByTestId("turn-composer");
    await composer.focus();
    await page.getByTestId("composer-tools-open").click();
    const tools = page.getByRole("dialog").filter({ hasText: "对话工具" });
    await tools.getByRole("button", { name: /^添加文件/u }).click();

    const picker = page.getByRole("dialog").filter({ hasText: "从此设备上传" });
    await expect(picker).toBeVisible();
    const removeButtons = picker.getByRole("button", { name: /^移除 /u });
    await expect(removeButtons).toHaveCount(13);
    await removeButtons.first().click();
    await expect(picker).toBeVisible();
    await expect(removeButtons).toHaveCount(12);

    await picker.getByRole("button", { name: "取消", exact: true }).click();
    await expect(picker).toHaveCount(0);
    const composerShell = page.locator(".composer-shell");
    await expect(composerShell).not.toHaveClass(/composer-shell--collapsed/u);
    await expect(composerShell.locator(".attachment-chip")).toHaveCount(13);
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
    const conversationSearch = page.getByLabel("搜索当前任务");
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

  test("文件页四个主要动作在手机端保持两列且文字不竖排", async ({ page }) => {
    await login(page);
    await page.goto("./?demo=1#/files");
    const actions = page.locator(".file-manager-actions");
    await expect(actions).toBeVisible();
    await expect(actions.getByRole("button")).toHaveCount(4);
    const { geometry, mobileLayout } = await actions.evaluate((element) => ({
      geometry: Array.from(element.querySelectorAll<HTMLElement>("button")).map((button) => ({
        height: button.getBoundingClientRect().height,
        width: button.getBoundingClientRect().width,
        text: button.textContent?.trim() ?? "",
        whiteSpace: window.getComputedStyle(button).whiteSpace,
      })),
      mobileLayout: window.matchMedia("(max-width: 700px)").matches,
    }));
    for (const action of geometry) {
      expect(action.height).toBeGreaterThanOrEqual(44);
      expect(action.width).toBeGreaterThanOrEqual(44);
      if (action.text && mobileLayout) {
        expect(action.width).toBeGreaterThanOrEqual(120);
        expect(action.whiteSpace).toBe("nowrap");
      }
    }
    await expectNoHorizontalOverflow(page);
  });

  test("文件页可预览、复制、下载并打开完整管理动作", async ({ page }) => {
    await login(page);
    await page.goto("./?demo=1#/files");

    const readme = page.locator("button.file-entry-main").filter({ hasText: "README.md" });
    await expect(readme).toBeVisible();
    await readme.click();

    const preview = page.locator(".file-preview");
    await expect(preview).toBeVisible();
    await expect(preview.getByRole("heading", { name: "Local Remote" })).toBeVisible();
    await expect(preview.getByRole("link", { name: "下载文件" })).toHaveAttribute(
      "download",
      "README.md",
    );
    await preview.getByRole("button", { name: "复制完整内容" }).click();
    await expect(preview.getByRole("button", { name: "已复制", exact: true })).toBeVisible();
    await preview.getByRole("button", { name: "关闭预览" }).click();

    await page.getByRole("button", { name: "管理 README.md" }).click();
    const manager = page.getByRole("dialog").filter({ hasText: "README.md" });
    await expect(manager).toBeVisible();
    for (const action of ["预览", "重命名", "复制到…", "移动到…", "删除…"]) {
      await expect(manager.getByRole("button", { name: action, exact: true })).toBeVisible();
    }
    await expectNoHorizontalOverflow(page);
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
