import { expect, test } from "@playwright/test";

import { login } from "./helpers.js";

test.describe("单密码登录与完整远程旅程", () => {
  test("Desktop 运行中快照不会伪装成实时可控任务", async ({ page }) => {
    await login(page);
    await expect(
      page.locator(".active-grid").getByText("Desktop 报告运行中：只读快照验收"),
    ).toHaveCount(0);

    await page.goto("./?demo=1#/threads/thread-snapshot-running");
    await expect(page.getByTestId("thread-view")).toBeVisible();
    await expect(page.getByText("只读快照", { exact: true })).toBeVisible();
    await expect(page.getByText("实时更新", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("turn-running")).toHaveCount(0);
    await expect(page.getByText(/无法实时跟随、追加要求或停止 Desktop 当前回复/u)).toBeVisible();
    await expect(page.getByTestId("turn-composer")).toHaveCount(0);
  });

  test("登录、启动对话、引导、停止并查看额度、子智能体与文件", async ({ page }) => {
    await test.step("只使用一个密码登录", async () => {
      await login(page);
      await expect(page.getByTestId("current-host-status")).toBeVisible();
    });

    await test.step("在已有项目中启动对话", async () => {
      await page.getByTestId("new-thread").click();
      await expect(page.getByTestId("new-thread-form")).toBeVisible();
      await page.getByTestId("project-option").first().click();
      await page.getByTestId("new-thread-prompt").fill("检查示例项目并给出一段简短摘要。");
      await page.getByTestId("new-thread-model").selectOption({ index: 0 });
      await page.getByTestId("new-thread-effort").selectOption("medium");
      await page.getByTestId("new-thread-submit").click();
      await expect(page.getByTestId("thread-view")).toBeVisible();
      await expect(page.getByTestId("turn-running")).toBeVisible();
    });

    await test.step("运行中追加引导并停止", async () => {
      await page.getByTestId("turn-composer").fill("先只检查，不要修改任何文件。");
      await page.getByTestId("turn-steer-submit").click();
      await expect(page.getByTestId("steer-accepted")).toBeVisible();
      await page.getByTestId("turn-interrupt").click();
      await expect(page.getByTestId("turn-interrupted")).toBeVisible();
    });

    await test.step("模型选择明确标为下一轮", async () => {
      await page.getByTestId("next-turn-model").selectOption({ index: 0 });
      await page.getByTestId("next-turn-effort").selectOption("high");
      await expect(page.getByTestId("next-turn-model-notice")).toContainText("下一轮");
    });

    await test.step("额度缺失时也不伪造为零", async () => {
      await page.getByTestId("usage-open").click();
      await expect(page.getByTestId("usage-panel")).toBeVisible();
      const panel = page.getByTestId("usage-panel");
      await expect(panel).not.toContainText(/剩余\s*0%/u);
      await expect(
        panel.getByTestId("usage-window").or(panel.getByTestId("usage-unavailable")),
      ).toBeVisible();
    });

    await test.step("手动压缩复用一次请求，并只把 202 解释为已受理", async () => {
      const compact = page.getByTestId("context-compact");
      await expect(compact).toBeEnabled();
      await compact.evaluate((button) => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await expect(page.getByTestId("context-compact-status")).toContainText("已受理");
      await expect(page.getByTestId("turn-composer")).toHaveCount(0);
      await expect(page.getByText("压缩对话上下文", { exact: true })).toHaveCount(1);
      await expect(page.getByTestId("context-compact-status")).toContainText("已压缩", {
        timeout: 6_000,
      });
      await expect(compact).toBeEnabled();
      await expect(page.getByTestId("turn-composer")).toBeVisible();
    });

    await test.step("可进入并退出任意状态的子智能体", async () => {
      await page.getByTestId("subagents-open").click();
      await expect(page.getByTestId("subagent-tree")).toBeVisible();
      await page.getByTestId("subagent-node").first().click();
      await expect(page.getByTestId("subagent-thread")).toBeVisible();
      await expect(page.getByTestId("parent-thread-back")).toBeVisible();
      await page.getByTestId("parent-thread-back").click();
      await expect(page.getByTestId("thread-view")).toBeVisible();
    });

    await test.step("文件页只提供项目内浏览和下载", async () => {
      await page.getByTestId("files-open").click();
      await expect(page.getByTestId("file-browser")).toBeVisible();
      await expect(page.getByTestId("file-entry").first()).toBeVisible();
      await expect(page.getByTestId("file-download").first()).toBeVisible();
    });
  });
});
