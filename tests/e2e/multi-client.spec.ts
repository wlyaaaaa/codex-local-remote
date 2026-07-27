import { expect, test } from "@playwright/test";

import { expectNoHorizontalOverflow } from "./helpers.js";
import {
  openSharedThread,
  runtimeModels,
  runtimePermissionProfiles,
  SharedRuntime,
} from "./shared-runtime.js";

function dynamicIdPattern(value: string): RegExp {
  const parts = value.split(/[-_]+/u).map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  return new RegExp(parts.join("[\\s_-]+"), "iu");
}

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
  test("工具、运行时模型与思考、权限、复杂队列和多审批均清晰可操作", async ({ browser }) => {
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
      await expectNoHorizontalOverflow(page);

      await test.step("设置抽屉动态读取模型、思考和速度，不绑定固定版本", async () => {
        await page.getByTestId("composer-settings-open").click();
        const settingsSheet = page.getByRole("dialog");
        await expect(settingsSheet).toBeVisible();
        await expect(
          settingsSheet.getByRole("heading", { name: "下一轮设置", exact: true }),
        ).toBeVisible();
        for (const model of runtimeModels) {
          await expect(settingsSheet.getByText(model.displayName, { exact: true })).toBeVisible();
        }
        const dynamicEffort = runtimeModels[0]!.supportedReasoningEfforts.at(-1)!;
        await expect(settingsSheet.getByRole("button", { name: dynamicEffort })).toBeVisible();
        await settingsSheet.getByRole("button", { name: dynamicEffort }).click();
        await expectNoHorizontalOverflow(page);
        await settingsSheet.getByRole("button", { name: "应用于下一轮" }).click();
        await expect
          .poll(() => runtime.settingsUpdates.at(-1)?.["reasoningEffort"])
          .toBe(dynamicEffort);
      });

      await test.step("权限按钮使用运行时返回的 profile", async () => {
        await page.getByTestId("composer-permission-open").click();
        const permissionSheet = page.getByRole("dialog");
        await expect(permissionSheet).toBeVisible();
        await expect(permissionSheet.getByRole("heading", { name: /权限/u }).first()).toBeVisible();
        for (const profile of runtimePermissionProfiles) {
          await expect(
            permissionSheet.getByRole("button", {
              name: dynamicIdPattern(profile.id),
            }),
          ).toBeVisible();
        }
        const targetProfile = permissionSheet.getByRole("button", {
          name: dynamicIdPattern(runtimePermissionProfiles.at(-1)!.id),
        });
        await targetProfile.click();
        const applyPermission = permissionSheet.getByRole("button", { name: /应用.*下一轮/u });
        if (await applyPermission.isVisible().catch(() => false)) {
          await applyPermission.click();
        }
        await expect
          .poll(() => runtime.settingsUpdates.at(-1)?.["permissionProfileId"])
          .toBe(runtimePermissionProfiles.at(-1)!.id);
      });

      await test.step("加号工具菜单显示运行时支持的动态工具", async () => {
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
        await page.getByLabel("关闭抽屉").click();
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

      await test.step("多个审批入口与动态决定按钮可见且可提交", async () => {
        const stack = page.getByTestId("thread-approval-stack");
        await expect(stack).toBeVisible();
        await expect(stack.getByRole("button")).toHaveCount(2);
        await stack.getByRole("button").first().click();
        const approvalSheet = page.getByRole("dialog");
        await expect(approvalSheet).toBeVisible();
        const dynamicChoices = approvalSheet.locator('[data-testid^="approval-choice-"]');
        await expect(dynamicChoices).toHaveCount(2);
        const firstChoice = dynamicChoices.first();
        const firstChoiceId = await firstChoice.getAttribute("data-testid");
        expect(firstChoiceId).toMatch(/^approval-choice-(?!allow$|deny$).+/u);
        await firstChoice.click();
        await expect(approvalSheet).toHaveCount(0);
      });

      await expectNoHorizontalOverflow(page);
    } finally {
      await runtime.close();
    }
  });
});
