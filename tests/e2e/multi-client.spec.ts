import { expect, test } from "@playwright/test";

import {
  EVENT_STREAM_OFFLINE_CONFIRM_MS,
  EVENT_STREAM_OFFLINE_GRACE_MS,
} from "../../apps/web/src/api.js";
import { expectNoHorizontalOverflow } from "./helpers.js";
import { openSharedThread, runtimeModels, SharedRuntime } from "./shared-runtime.js";

const confirmedDisconnectTimeoutMs =
  EVENT_STREAM_OFFLINE_GRACE_MS + EVENT_STREAM_OFFLINE_CONFIRM_MS + 5_000;

test.beforeEach(({ browser: _browser }, testInfo) => {
  test.skip(
    testInfo.project.name !== "xiaomi-15-pro",
    "本文件专门记录 412×915 双客户端与复杂移动态自动证据",
  );
});

test.describe("共享运行时的双 Web 自动证据", () => {
  test("两个独立 browser context 实时同步同一运行任务与下一轮队列", async ({ browser }) => {
    const runtime = new SharedRuntime();
    const webA = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 412, height: 915 },
    });
    const webB = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 412, height: 915 },
    });
    await runtime.attach(webA);
    await runtime.attach(webB);
    const pageA = await webA.newPage();
    const pageB = await webB.newPage();

    try {
      await Promise.all([openSharedThread(pageA), openSharedThread(pageB)]);
      await expect(pageA.getByTestId("thread-view")).toBeVisible();
      await expect(pageB.getByTestId("thread-view")).toBeVisible();
      await expect(pageA.getByText("运行中", { exact: true })).toBeVisible();
      await expect(pageB.getByText("运行中", { exact: true })).toBeVisible();
      await expect(pageA.getByText("正在运行共享状态验收", { exact: true })).toBeVisible();
      await expect(pageB.getByText("正在运行共享状态验收", { exact: true })).toBeVisible();
      await expect(
        pageA.getByText("自动 UI 证据，不代表 Desktop 实机三端证据", { exact: true }),
      ).toBeVisible();

      const queuedText = `Web A 排队，Web B 自动收到 ${Date.now()}`;
      await pageA.getByTestId("turn-composer").click();
      await pageA.getByTestId("delivery-queue").click();
      await pageA.getByTestId("turn-composer").fill(queuedText);
      await pageA.getByTestId("turn-steer-submit").click();
      await expect(pageA.getByTestId("turn-queued")).toBeVisible();

      await expect(pageB.getByTestId("queue-shelf")).toBeVisible();
      await expect(pageB.getByTestId("queue-shelf")).toContainText(queuedText);
      await expect(pageB.getByTestId("queue-item")).toHaveCount(1);
    } finally {
      await runtime.close();
    }
  });
});

test.describe("412×915 动态复杂态 UI", () => {
  test("360px 与 412px 均可打开每行 44px 操作菜单且不横向溢出", async ({ browser }) => {
    for (const width of [360, 412]) {
      const context = await browser.newContext({
        colorScheme: "light",
        locale: "zh-CN",
        viewport: { width, height: width === 360 ? 800 : 915 },
      });
      const page = await context.newPage();
      try {
        await page.goto("./?demo=1#/");
        const trigger = page.locator('[data-testid^="thread-actions-"]').first();
        await expect(trigger).toBeVisible();
        const box = await trigger.boundingBox();
        expect(box?.width).toBe(44);
        expect(box?.height).toBe(44);
        await trigger.click();
        const menu = page.locator('[data-testid^="thread-actions-menu-"]').first();
        const rename = menu.getByRole("button", { name: "重命名" });
        await expect(rename).toBeVisible();
        await expect(rename).toBeFocused();
        await expect(menu.getByRole("button", { name: "复制对话 ID" })).toBeVisible();
        await expect(menu.getByRole("button", { name: "归档" })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(trigger).toBeFocused();

        const bottomTrigger = page.locator('[data-testid^="thread-actions-"]').last();
        await bottomTrigger.scrollIntoViewIfNeeded();
        await bottomTrigger.click();
        const bottomMenu = page.locator('[data-testid^="thread-actions-menu-"]').last();
        await expect(bottomMenu).toBeVisible();
        const [menuBox, navigationBox] = await Promise.all([
          bottomMenu.boundingBox(),
          page.getByTestId("primary-navigation").boundingBox(),
        ]);
        expect(menuBox).not.toBeNull();
        expect(navigationBox).not.toBeNull();
        expect(menuBox!.y).toBeGreaterThanOrEqual(8);
        expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(navigationBox!.y - 8);
        await expectNoHorizontalOverflow(page);
      } finally {
        await context.close();
      }
    }
  });

  test("412px 行菜单完成重命名、归档失败重试、归档与恢复的 mutation/readback", async ({
    browser,
  }) => {
    const runtime = new SharedRuntime();
    const mobile = await browser.newContext({
      colorScheme: "light",
      locale: "zh-CN",
      viewport: { width: 412, height: 915 },
    });
    await runtime.attach(mobile);
    const page = await mobile.newPage();
    let archived = false;
    let title = "共享运行任务";
    let failNextArchive = true;
    const mutationBodies: Array<Record<string, unknown>> = [];
    const readbackScopes: boolean[] = [];

    await page.route("**/api/v1/threads**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      if (method === "GET" && url.pathname.endsWith("/api/v1/threads")) {
        const requestedArchived = url.searchParams.get("archived") === "true";
        readbackScopes.push(requestedArchived);
        const items =
          requestedArchived === archived
            ? [
                {
                  id: "shared-running-thread",
                  title,
                  mode: "managed",
                  state: "complete",
                  updatedAt: new Date().toISOString(),
                  ...(archived ? { archived: true } : {}),
                },
              ]
            : [];
        await route.fulfill({
          body: JSON.stringify(items),
          contentType: "application/json",
          status: 200,
        });
        return;
      }
      if (method === "PUT" && url.pathname.endsWith("/name")) {
        const body = request.postDataJSON() as { name: string };
        mutationBodies.push(body);
        await new Promise((resolve) => setTimeout(resolve, 250));
        title = body.name;
        await route.fulfill({ status: 204 });
        return;
      }
      if (method === "PUT" && url.pathname.endsWith("/archive")) {
        const body = request.postDataJSON() as { archived: boolean };
        mutationBodies.push(body);
        if (failNextArchive && body.archived) {
          failNextArchive = false;
          await route.fulfill({
            body: JSON.stringify({
              error: { code: "SYNTHETIC_ARCHIVE_FAILURE", message: "模拟归档失败" },
            }),
            contentType: "application/json",
            status: 503,
          });
          return;
        }
        archived = body.archived;
        await route.fulfill({ status: 204 });
        return;
      }
      await route.fallback();
    });

    try {
      await page.goto("./#/");
      const trigger = page.getByTestId("thread-actions-shared-running-thread");
      await expect(trigger).toBeVisible();
      readbackScopes.length = 0;

      await trigger.click();
      let menu = page.getByTestId("thread-actions-menu-shared-running-thread");
      await menu.getByRole("button", { name: "重命名" }).click();
      await menu.getByRole("textbox", { name: "新对话名称" }).fill("手机端权威新名称");
      await menu.getByRole("button", { name: "保存", exact: true }).click();
      await expect(page.getByTestId("thread-action-feedback")).toContainText("正在重命名");
      await expect(menu.getByRole("button", { name: "保存中…", exact: true })).toBeDisabled();
      await expect(page.getByText("手机端权威新名称", { exact: true })).toBeVisible();
      await expect(page.getByTestId("thread-action-feedback")).toContainText("已重命名");
      expect(readbackScopes.slice(-2)).toEqual([false, true]);

      await page.getByTestId("thread-actions-shared-running-thread").click();
      menu = page.getByTestId("thread-actions-menu-shared-running-thread");
      await menu.getByRole("button", { name: "复制对话 ID" }).click();
      await expect(menu).toContainText("已复制对话 ID");
      await menu.getByRole("button", { name: "归档", exact: true }).click();
      await expect(page.getByTestId("thread-action-feedback")).toContainText(
        "归档失败：模拟归档失败",
      );
      await expect(menu.getByRole("button", { name: "归档", exact: true })).toBeEnabled();

      await menu.getByRole("button", { name: "归档", exact: true }).click();
      await expect(page.getByTestId("thread-action-feedback")).toContainText("已归档");
      await expect(page.getByTestId("thread-actions-shared-running-thread")).toHaveCount(0);
      expect(readbackScopes.slice(-2)).toEqual([false, true]);

      await page.getByRole("tab", { name: "已归档", exact: true }).click();
      await expect(page.getByText("手机端权威新名称", { exact: true })).toBeVisible();
      await page.getByTestId("thread-actions-shared-running-thread").click();
      menu = page.getByTestId("thread-actions-menu-shared-running-thread");
      await expect(menu.getByRole("button", { name: "恢复对话" })).toBeVisible();
      await menu.getByRole("button", { name: "恢复对话" }).click();
      await expect(page.getByTestId("thread-action-feedback")).toContainText("已恢复");
      await expect(page.getByTestId("thread-actions-shared-running-thread")).toHaveCount(0);
      expect(readbackScopes.slice(-2)).toEqual([false, true]);

      await page.getByRole("tab", { name: "当前", exact: true }).click();
      await expect(page.getByText("手机端权威新名称", { exact: true })).toBeVisible();
      expect(mutationBodies).toEqual([
        { name: "手机端权威新名称" },
        { archived: true },
        { archived: true },
        { archived: false },
      ]);
      await expectNoHorizontalOverflow(page);
    } finally {
      await runtime.close();
    }
  });

  test("PUT 已提交但双列表持续失败时锁定同一对话，显式恢复只做 GET", async ({ browser }) => {
    const runtime = new SharedRuntime();
    const mobile = await browser.newContext({
      colorScheme: "light",
      locale: "zh-CN",
      viewport: { width: 412, height: 915 },
    });
    await runtime.attach(mobile);
    const page = await mobile.newPage();
    let title = "共享运行任务";
    let readbackBlocked = false;
    let getCount = 0;
    const semanticPuts: Array<{ path: string; body: unknown }> = [];

    await page.route("**/api/v1/threads**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "GET" && url.pathname.endsWith("/api/v1/threads")) {
        getCount += 1;
        if (readbackBlocked) {
          await route.fulfill({
            body: JSON.stringify({
              error: { code: "SYNTHETIC_LIST_FAILURE", message: "模拟双列表持续失败" },
            }),
            contentType: "application/json",
            status: 503,
          });
          return;
        }
        const archived = url.searchParams.get("archived") === "true";
        await route.fulfill({
          body: JSON.stringify(
            archived
              ? []
              : [
                  {
                    id: "shared-running-thread",
                    mode: "managed",
                    state: "complete",
                    title,
                    updatedAt: new Date().toISOString(),
                  },
                ],
          ),
          contentType: "application/json",
          status: 200,
        });
        return;
      }
      if (request.method() === "PUT" && url.pathname.endsWith("/name")) {
        const body = request.postDataJSON() as { name: string };
        semanticPuts.push({ body, path: url.pathname });
        title = body.name;
        readbackBlocked = true;
        await route.fulfill({ status: 204 });
        return;
      }
      if (request.method() === "PUT" && url.pathname.endsWith("/archive")) {
        semanticPuts.push({ body: request.postDataJSON(), path: url.pathname });
        await route.fulfill({ status: 204 });
        return;
      }
      await route.fallback();
    });

    try {
      await page.goto("./#/");
      const trigger = page.getByTestId("thread-actions-shared-running-thread");
      await trigger.click();
      let menu = page.getByTestId("thread-actions-menu-shared-running-thread");
      await menu.getByRole("button", { name: "重命名" }).click();
      await menu.getByRole("textbox", { name: "新对话名称" }).fill("只提交一次的新名称");
      await menu.getByRole("button", { name: "保存", exact: true }).click();
      await expect(page.getByTestId("thread-action-feedback")).toContainText(
        "列表仍未同步；请重新同步",
        { timeout: 10_000 },
      );
      expect(semanticPuts).toHaveLength(1);
      const getCountAfterBoundedRetry = getCount;

      await trigger.click();
      menu = page.getByTestId("thread-actions-menu-shared-running-thread");
      const rename = menu.getByRole("button", { name: "重命名" });
      const archive = menu.getByRole("button", { name: "归档", exact: true });
      await expect(rename).toHaveAttribute("aria-disabled", "true");
      await expect(archive).toHaveAttribute("aria-disabled", "true");
      await expect(rename).toHaveAttribute("aria-describedby", /pending-reason/u);
      await rename.focus();
      await page.keyboard.press("Enter");
      await archive.focus();
      await page.keyboard.press("Enter");
      expect(semanticPuts).toHaveLength(1);
      expect(getCount).toBe(getCountAfterBoundedRetry);

      readbackBlocked = false;
      await menu.getByRole("button", { name: "重新同步" }).click();
      await expect(page.getByTestId("thread-action-feedback")).toContainText("列表已同步");
      await expect(page.getByText("只提交一次的新名称", { exact: true })).toBeVisible();
      await expect(menu.getByRole("button", { name: "重命名" })).toHaveAttribute(
        "aria-disabled",
        "false",
      );
      expect(semanticPuts).toEqual([
        {
          body: { name: "只提交一次的新名称" },
          path: "/api/v1/threads/shared-running-thread/name",
        },
      ]);
      expect(getCount).toBeGreaterThan(getCountAfterBoundedRetry);
    } finally {
      await runtime.close();
    }
  });

  test("超长工作记录隐藏历史思考，操作详情和最终回答仍完整可用", async ({ browser }) => {
    const runtime = new SharedRuntime({ longWorkLog: true });
    const mobile = await browser.newContext({
      colorScheme: "light",
      locale: "zh-CN",
      viewport: { width: 412, height: 915 },
    });
    await runtime.attach(mobile);
    const page = await mobile.newPage();

    try {
      await openSharedThread(page);
      const workLog = page.locator("section.work-log");
      const toggle = workLog.getByRole("button", { name: /工作记录/u }).first();

      await expect(workLog).toHaveCount(1);
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByText("先确认真实历史基线", { exact: true })).toHaveCount(0);
      await expect(page.getByText("完整工作记录之后的最终回答。", { exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page);

      await expect(page.getByText("先确认真实历史基线", { exact: true })).toHaveCount(0);
      await expect(page.getByText("正在核对长对话顺序", { exact: true })).toBeVisible();
      await expect(page.getByText("已完成合并并验证无重复", { exact: true })).toHaveCount(0);
      await expect(page.getByText("准备给出最终结果", { exact: true })).toBeVisible();
      await expect(page.getByText("历史完整性检查", { exact: true })).toBeVisible();

      const expandedTextOrder = await workLog.locator(".work-log__items").evaluate((element) => {
        const text = element.textContent ?? "";
        return ["编辑了 1 个文件 · 运行了 1 个命令", "历史完整性检查"].map((value) =>
          text.indexOf(value),
        );
      });
      expect(expandedTextOrder.every((index) => index >= 0)).toBe(true);
      expect(expandedTextOrder).toEqual([...expandedTextOrder].sort((a, b) => a - b));

      const activity = workLog.locator("details.activity-record");
      await activity.locator("summary").click();
      await expect(activity).toContainText("App.tsx");
      const commandRow = activity.getByRole("button", { name: /运行命令/u });
      const fileRow = activity.locator("button.activity-row--file");
      const subagentChip = workLog.getByRole("button", { name: "历史完整性检查" });
      for (const target of [
        toggle,
        activity.locator("summary"),
        commandRow,
        fileRow,
        subagentChip,
      ]) {
        expect((await target.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      }

      await commandRow.click();
      const detailSheet = page.getByRole("dialog");
      await expect(detailSheet.getByTestId("activity-detail-command")).toContainText(
        "@codex-local-remote/web test",
      );
      await expect(detailSheet.getByTestId("activity-detail-output")).toContainText(
        "Tests 269 passed",
      );
      await detailSheet.getByRole("button", { name: "复制命令" }).click();
      await expect(detailSheet.getByRole("button", { name: "复制命令" })).toHaveAttribute(
        "data-copy-state",
        "copied",
      );
      await detailSheet.getByRole("button", { name: "关闭", exact: true }).click();

      await fileRow.click();
      const diffTab = detailSheet.getByRole("tab", { name: "修改内容" });
      const fileTab = detailSheet.getByRole("tab", { name: "最新文件" });
      await expect(diffTab).toHaveAttribute("aria-selected", "true");
      for (const tab of [diffTab, fileTab]) {
        const box = await tab.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      }
      await expect(detailSheet.locator(".diff-view")).toContainText("old");
      await expect(detailSheet.locator(".diff-view")).toContainText("new");
      await detailSheet.getByRole("button", { name: "关闭", exact: true }).click();

      await page.getByRole("button", { name: "预览 generated-evidence.svg" }).click();
      const imageSheet = page.getByRole("dialog");
      await expect(imageSheet.getByRole("img", { name: "mobile-evidence.svg" })).toBeVisible();
      await expect(imageSheet.getByRole("link", { name: "下载文件" })).toBeVisible();
      await imageSheet.getByRole("button", { name: "关闭", exact: true }).click();

      const copyFinal = page.getByRole("button", { name: "复制最终回答" });
      await copyFinal.click();
      await expect(copyFinal).toHaveAttribute("data-copy-state", "copied");

      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByText("先确认真实历史基线", { exact: true })).toHaveCount(0);
      await expect(page.getByText("完整工作记录之后的最终回答。", { exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    } finally {
      await runtime.close();
    }
  });

  test("草稿和二十个附件阻止输入框误收起，发送和停止操作不被遮挡", async ({ browser }) => {
    const runtime = new SharedRuntime();
    const mobile = await browser.newContext({
      colorScheme: "light",
      locale: "zh-CN",
      viewport: { width: 412, height: 915 },
    });
    await runtime.attach(mobile);
    const page = await mobile.newPage();

    try {
      await page.addInitScript(() => {
        window.localStorage.setItem(
          "conversation-attachments:shared-running-thread",
          JSON.stringify(
            Array.from({ length: 20 }, (_, index) => ({
              kind: "file",
              relativePath: `非常长的移动端附件名称-${String(index + 1).padStart(2, "0")}.json`,
              uploadId: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
            })),
          ),
        );
      });
      await openSharedThread(page);
      const composer = page.getByTestId("turn-composer");
      const draft = "第一行\n第二行\n这是用于验证反复收起与展开的最后一行";

      await composer.click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await composer.fill(draft);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await page.locator(".conversation-header").click();
        await expect(page.locator(".composer-shell")).not.toHaveClass(/composer-shell--collapsed/u);
        await expect(composer).toHaveValue(draft);
        await composer.click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(composer).toHaveValue(draft);
        await expect(composer).toBeFocused();
      }

      const chips = page.locator(".attachment-chips");
      await expect(chips.locator(".attachment-chip")).toHaveCount(20);
      await expect(page.getByTestId("turn-steer-submit")).toBeVisible();
      await expect(page.getByTestId("turn-interrupt")).toBeVisible();
      const geometry = await chips.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }));
      expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
      await expectNoHorizontalOverflow(page);
    } finally {
      await runtime.close();
    }
  });

  test("工具、运行时模型与思考、复杂队列和多审批均清晰可操作", async ({ browser }) => {
    test.setTimeout(60_000);
    const runtime = new SharedRuntime({ complexState: true });
    const mobile = await browser.newContext({
      colorScheme: "light",
      locale: "zh-CN",
      viewport: { width: 412, height: 915 },
    });
    await runtime.attach(mobile);
    const page = await mobile.newPage();

    try {
      await openSharedThread(page);
      await expect(page.getByTestId("thread-view")).toBeVisible();
      await expect(page.getByTestId("thread-approval-stack")).toBeVisible();
      await expect(page.getByTestId("queue-shelf")).toBeVisible();
      await expectNoHorizontalOverflow(page);

      await test.step("待处理审批会自动弹出、可关闭，并可逐项提交动态决定", async () => {
        const approvalSheet = page.getByRole("dialog");
        await expect(approvalSheet).toBeVisible();
        await expect(
          approvalSheet.getByRole("heading", { name: "动态审批：运行项目命令" }),
        ).toBeVisible();
        await approvalSheet.getByRole("button", { name: "关闭", exact: true }).click();
        await expect(approvalSheet).toHaveCount(0);

        const stack = page.getByTestId("thread-approval-stack");
        await expect(stack.getByRole("button")).toHaveCount(2);
        await stack.getByRole("button").first().click();
        let dynamicChoices = approvalSheet.locator('[data-testid^="approval-choice-"]');
        await expect(dynamicChoices).toHaveCount(2);
        const firstChoiceId = await dynamicChoices.first().getAttribute("data-testid");
        expect(firstChoiceId).toMatch(/^approval-choice-(?!allow$|deny$).+/u);
        await dynamicChoices.first().click();
        await expect(
          approvalSheet.getByRole("heading", { name: "动态审批：访问项目文件" }),
        ).toBeVisible();
        dynamicChoices = approvalSheet.locator('[data-testid^="approval-choice-"]');
        await expect(dynamicChoices).toHaveCount(2);
        await dynamicChoices.first().click();
        await expect(approvalSheet).toHaveCount(0);
      });

      await test.step("目标独占输入器顶行，不与发送方式和计划挤在一行", async () => {
        await page.getByTestId("turn-composer").click();
        const goalRow = page.locator(".composer__goal-row");
        const controlRow = page.locator(".composer__context-bar");
        await expect(goalRow.getByTestId("composer-goal-open")).toBeVisible();
        await expect(controlRow).toBeVisible();
        const [goalBox, controlBox] = await Promise.all([
          goalRow.boundingBox(),
          controlRow.boundingBox(),
        ]);
        expect((goalBox?.y ?? 0) + (goalBox?.height ?? 0)).toBeLessThanOrEqual(
          (controlBox?.y ?? 0) + 1,
        );
      });

      await test.step("设置抽屉动态读取模型、思考和速度，不绑定固定版本", async () => {
        await page.getByTestId("turn-composer").click();
        await page.getByTestId("composer-settings-open").click();
        const settingsSheet = page.getByRole("dialog");
        await expect(settingsSheet).toBeVisible();
        await expect(
          settingsSheet.getByRole("heading", { name: "模型与运行设置", exact: true }),
        ).toBeVisible();
        for (const model of runtimeModels) {
          await expect(settingsSheet.getByText(model.displayName, { exact: true })).toBeVisible();
        }
        const dynamicEffort = runtimeModels[0]!.supportedReasoningEfforts.at(-1)!;
        await expect(settingsSheet.getByRole("button", { name: dynamicEffort })).toBeVisible();
        await settingsSheet.getByRole("button", { name: dynamicEffort }).click();
        await expectNoHorizontalOverflow(page);
        await settingsSheet.getByRole("button", { name: "保存设置" }).click();
        await expect
          .poll(() => runtime.settingsUpdates.at(-1)?.["reasoningEffort"])
          .toBe(dynamicEffort);
      });

      await test.step("对话内不常驻权限与审批设置按钮，真实审批请求仍保留", async () => {
        await page.getByTestId("turn-composer").click();
        await expect(page.getByTestId("composer-permission-open")).toHaveCount(0);
      });

      await test.step("加号工具菜单显示运行时支持的动态工具", async () => {
        await page.getByTestId("turn-composer").click();
        await page.getByTestId("composer-tools-open").click();
        const toolsSheet = page.getByRole("dialog");
        await expect(toolsSheet).toBeVisible();
        await expect(
          toolsSheet.getByRole("heading", { name: "对话工具", exact: true }),
        ).toBeVisible();
        await expect(toolsSheet.getByRole("button", { name: /任务目标/u })).toBeVisible();
        await expect(toolsSheet.getByRole("button", { name: /计划模式/u })).toBeVisible();
        await expect(toolsSheet.getByRole("button", { name: /压缩上下文/u })).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await toolsSheet.getByRole("button", { name: "关闭", exact: true }).click();
      });

      await test.step("计划提问与正式计划会作为可读历史完整显示", async () => {
        const interaction = page.locator(".interaction-record").filter({
          hasText: "已回答 1 个计划问题",
        });
        await expect(interaction).toBeVisible();
        await expect(interaction).toContainText("这次移动端验收优先保证什么？");
        await expect(interaction).toContainText("稳定闭环");

        const plan = page.locator(".formal-plan").filter({
          hasText: "移动端验收计划",
        });
        await expect(plan).toBeVisible();
        await expect(plan.getByRole("button", { name: "复制计划" })).toBeVisible();
        await expectNoHorizontalOverflow(page);
      });

      await test.step("任务目标可保存、再次编辑并清除", async () => {
        const openGoal = async () => {
          await page.getByTestId("turn-composer").click();
          await page.getByTestId("composer-tools-open").click();
          const toolsSheet = page.getByRole("dialog");
          await toolsSheet.getByRole("button", { name: /任务目标/u }).click();
          const goalSheet = page.getByRole("dialog");
          await expect(goalSheet.getByRole("heading", { name: "任务目标" })).toBeVisible();
          return goalSheet;
        };

        let goalSheet = await openGoal();
        const goalEditor = goalSheet.getByRole("textbox", { name: "持续目标" });
        await goalEditor.fill("先完成真实移动端闭环，再发布 v0.1.2");
        await goalSheet.getByRole("button", { name: /保存目标|保存修改/u }).click();
        await expect
          .poll(() => runtime.goalUpdates.at(-1)?.objective)
          .toBe("先完成真实移动端闭环，再发布 v0.1.2");

        goalSheet = await openGoal();
        await expect(goalSheet.getByRole("textbox", { name: "持续目标" })).toHaveValue(
          "先完成真实移动端闭环，再发布 v0.1.2",
        );
        await goalSheet
          .getByRole("textbox", { name: "持续目标" })
          .fill("完成全部定向验收后发布 v0.1.2");
        await goalSheet.getByRole("button", { name: /保存目标|保存修改/u }).click();
        await expect
          .poll(() => runtime.goalUpdates.at(-1)?.objective)
          .toBe("完成全部定向验收后发布 v0.1.2");

        goalSheet = await openGoal();
        await goalSheet.getByRole("button", { name: /清除|删除目标/u }).click();
        await expect.poll(() => runtime.goalUpdates.at(-1)).toBeNull();
      });

      await test.step("回答里的跨项目本机文件链接可预览并下载最新源文件", async () => {
        const link = page.getByRole("link", { name: "fresh-task (line 87)" });
        await expect(link).toBeVisible();
        await link.click();
        const fileSheet = page.getByRole("dialog");
        await expect(fileSheet).toBeVisible();
        await expect(fileSheet.getByText("源文件第 87 行", { exact: true })).toBeVisible();
        await expect(
          fileSheet.getByText('"fresh-task": "not_retested"', { exact: false }),
        ).toBeVisible();
        await expect(fileSheet.getByRole("link", { name: "下载最新源文件" })).toHaveAttribute(
          "href",
          /projectId=fixture-project.*path=reports%2Freview-evidence\.json/u,
        );
        await fileSheet.getByRole("button", { name: "关闭", exact: true }).click();
        const nextApproval = page.getByRole("dialog");
        if (await nextApproval.isVisible().catch(() => false)) {
          await nextApproval.getByRole("button", { name: "关闭", exact: true }).click();
        }
      });

      await test.step("用户消息附件可回显，文本可复制，图片可放大查看", async () => {
        const userMessage = page.locator("article.message--user").first();
        await expect(
          userMessage.getByRole("button", { name: "mobile-evidence.json" }),
        ).toBeVisible();
        await userMessage.getByRole("button", { name: "mobile-evidence.json" }).click();
        let attachmentSheet = page.getByRole("dialog");
        await expect(
          attachmentSheet.getByText('"attachment": "visible"', { exact: false }),
        ).toBeVisible();
        await attachmentSheet.getByRole("button", { name: "复制完整内容" }).click();
        await expect(
          attachmentSheet.getByRole("button", { name: "已复制", exact: true }),
        ).toBeVisible();
        await attachmentSheet.getByRole("button", { name: "关闭", exact: true }).click();

        await userMessage.getByRole("button", { name: "mobile-evidence.svg" }).click();
        attachmentSheet = page.getByRole("dialog");
        await expect(
          attachmentSheet.getByRole("img", { name: "mobile-evidence.svg" }),
        ).toBeVisible();
        await expect(attachmentSheet.getByRole("link", { name: "下载文件" })).toBeVisible();
        await attachmentSheet.getByRole("button", { name: "关闭", exact: true }).click();
      });

      await test.step("命令与输出各自可双向滚动并可独立复制", async () => {
        const activity = page.locator("details.activity-record").filter({
          hasText: "运行了 1 个命令",
        });
        await expect(activity).toBeVisible();
        await activity.locator("summary").click();
        await activity.getByRole("button", { name: /运行命令/u }).click();
        const command = page.getByTestId("activity-detail-command");
        const output = page.getByTestId("activity-detail-output");
        await expect(command).toBeVisible();
        await expect(output).toBeVisible();
        const geometry = await Promise.all(
          [command, output].map((target) =>
            target.evaluate((element) => ({
              clientHeight: element.clientHeight,
              clientWidth: element.clientWidth,
              scrollHeight: element.scrollHeight,
              scrollWidth: element.scrollWidth,
            })),
          ),
        );
        expect(geometry[0]!.scrollWidth).toBeGreaterThan(geometry[0]!.clientWidth);
        expect(geometry[0]!.scrollHeight).toBeGreaterThan(geometry[0]!.clientHeight);
        expect(geometry[1]!.scrollHeight).toBeGreaterThan(geometry[1]!.clientHeight);
        expect(geometry[1]!.scrollWidth).toBeGreaterThan(geometry[1]!.clientWidth);
        const copyCommand = page.getByRole("button", { name: "复制命令" });
        const copyOutput = page.getByRole("button", { name: "复制输出" });
        await copyCommand.click();
        await copyOutput.click();
        await expect(copyCommand).toHaveAttribute("data-copy-state", "copied");
        await expect(copyOutput).toHaveAttribute("data-copy-state", "copied");
        await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
      });

      await test.step("用户消息、最终回答、草稿与对话 ID 均可一键复制", async () => {
        const copyUser = page.getByRole("button", { name: "复制你的消息" }).first();
        const copyAnswer = page.getByRole("button", { name: "复制最终回答" }).first();
        await copyUser.click();
        await copyAnswer.click();
        await expect(copyUser).toHaveAttribute("data-copy-state", "copied");
        await expect(copyAnswer).toHaveAttribute("data-copy-state", "copied");

        const composer = page.getByTestId("turn-composer");
        await composer.click();
        await composer.fill("离线也要能够复制的草稿");
        const copyDraft = page.getByTestId("draft-copy");
        await copyDraft.click();
        await expect(copyDraft).toHaveAttribute("data-copy-state", "copied");

        await page.getByTestId("usage-open").click();
        const usagePanel = page.getByTestId("usage-panel");
        await usagePanel.getByRole("button", { name: "复制对话 ID" }).click();
        await expect(usagePanel.getByRole("button", { name: "复制对话 ID" })).toContainText(
          "已复制",
        );
        await usagePanel.getByRole("button", { name: "关闭额度面板" }).click();
      });

      await test.step("连接中断保留草稿与复制入口，并移除不可执行的停止入口", async () => {
        await runtime.setOnline(false);
        await expect(page.getByText("实时更新已中断", { exact: true })).toHaveCount(0);
        await expect(page.getByText("实时更新已中断", { exact: true }).first()).toBeVisible({
          timeout: confirmedDisconnectTimeoutMs,
        });
        const composer = page.getByTestId("turn-composer");
        await expect(composer).toBeVisible();
        await expect(composer).toHaveValue("离线也要能够复制的草稿");
        await expect(
          page.getByRole("button", { name: /输入框内容已复制|复制输入框内容/u }),
        ).toBeVisible();
        await expect(page.getByTestId("turn-steer-submit")).toBeEnabled();
        await expect(page.getByTestId("turn-steer-submit")).toHaveAttribute(
          "aria-label",
          "尝试安全排队",
        );
        await expect(page.getByTestId("turn-interrupt")).toHaveCount(0);
        await runtime.setOnline(true);
        await expect(page.getByText("实时更新已中断", { exact: true })).toHaveCount(0);
        await expect(page.getByTestId("turn-interrupt")).toBeVisible();
      });

      await test.step("排队、暂停、发送结果未知三种复杂状态均可读且可编辑", async () => {
        const shelf = page.getByTestId("queue-shelf");
        await expect(shelf).toBeVisible();
        await expect(page.getByTestId("queue-item")).toHaveCount(3);
        await expect(shelf).toContainText("暂停消息：需要人工恢复");
        await expect(shelf).toContainText("未知消息：发送结果需要确认");
        await page.getByLabel("编辑排队消息").nth(1).click();
        await page.locator('textarea[aria-label="编辑排队消息"]').fill("暂停消息已由手机重新编辑");
        await page.getByRole("button", { name: "保存", exact: true }).click();
        await expect(shelf).toContainText("暂停消息已由手机重新编辑");
        await expectNoHorizontalOverflow(page);
      });

      await expectNoHorizontalOverflow(page);
    } finally {
      await runtime.close();
    }
  });
});
