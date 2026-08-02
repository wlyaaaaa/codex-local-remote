import { expect, test } from "@playwright/test";

import {
  EVENT_STREAM_OFFLINE_CONFIRM_MS,
  EVENT_STREAM_OFFLINE_GRACE_MS,
} from "../../apps/web/src/api.js";
import { login } from "./helpers.js";
import { openSharedThread, SharedRuntime } from "./shared-runtime.js";

const confirmedDisconnectTimeoutMs =
  EVENT_STREAM_OFFLINE_GRACE_MS + EVENT_STREAM_OFFLINE_CONFIRM_MS + 5_000;

test.describe("单密码登录与完整远程旅程", () => {
  test("Desktop 置顶顺序在手机端独立于最近对话显示", async ({ page }) => {
    await login(page);
    await page.goto("./?demo=1#/threads");

    const pinned = page.getByTestId("pinned-threads-group");
    const recent = page.getByTestId("recent-threads-group");
    const threadList = page.locator(".thread-list-card").filter({ has: pinned });
    await expect(pinned).toBeVisible();
    await expect(recent).toBeVisible();
    await expect(
      threadList.getByText("完成移动端控制台并验证响应式布局", { exact: true }),
    ).toBeVisible();
    await expect(threadList.getByText("梳理首页信息架构", { exact: true })).toBeVisible();
    expect(
      await pinned.evaluate((element) => {
        const recentElement = document.querySelector('[data-testid="recent-threads-group"]');
        return (
          recentElement !== null &&
          Boolean(element.compareDocumentPosition(recentElement) & Node.DOCUMENT_POSITION_FOLLOWING)
        );
      }),
    ).toBe(true);
  });

  test("从列表进入已有运行任务时恢复消息、引导、停止与下一轮模型", async ({ page }) => {
    await login(page);
    await page.goto("./?demo=1#/threads/thread-active");

    await expect(page.getByText("把移动端首页和对话页做完整。", { exact: false })).toBeVisible();
    await expect(page.getByTestId("turn-composer")).toBeVisible();
    await expect(page.getByTestId("turn-interrupt")).toBeVisible();
    await page.getByTestId("turn-composer").click();
    await page.getByTestId("turn-composer").fill("补充一条不会立即提交的验收要求");
    await expect(page.getByTestId("turn-steer-submit")).toBeVisible();
    await expect(page.getByTestId("composer-settings-open")).toBeVisible();
    await expect(page.getByTestId("next-turn-model-notice")).toHaveCount(0);
  });

  test("Desktop 创建的运行任务在手机端保持实时可控", async ({ page }) => {
    await login(page);
    await page.goto("./?demo=1#/threads/thread-desktop-running");
    await expect(page.getByTestId("thread-view")).toBeVisible();
    await expect(page.getByText("运行中", { exact: true })).toBeVisible();
    await expect(page.getByTestId("turn-running")).toHaveCount(0);
    await expect(page.getByTestId("turn-composer")).toBeVisible();
    await expect(page.getByTestId("turn-interrupt")).toBeVisible();
    await page.getByTestId("turn-composer").click();
    await page.getByTestId("turn-composer").fill("验证 Desktop 创建任务仍可从手机引导");
    await expect(page.getByTestId("turn-steer-submit")).toBeVisible();
  });

  test("浏览器草稿存储不可用时输入器仍可编辑并诚实提示", async ({ page }) => {
    await page.addInitScript(() => {
      const getItem = Object.getOwnPropertyDescriptor(Storage.prototype, "getItem")
        ?.value as Storage["getItem"];
      const setItem = Object.getOwnPropertyDescriptor(Storage.prototype, "setItem")
        ?.value as Storage["setItem"];
      const removeItem = Object.getOwnPropertyDescriptor(Storage.prototype, "removeItem")
        ?.value as Storage["removeItem"];
      Storage.prototype.getItem = function getItemWithDraftFailure(key) {
        if (key.startsWith("draft:")) throw new DOMException("quota", "QuotaExceededError");
        return Reflect.apply(getItem, this, [key]);
      };
      Storage.prototype.setItem = function setItemWithDraftFailure(key, value) {
        if (key.startsWith("draft:")) throw new DOMException("quota", "QuotaExceededError");
        return Reflect.apply(setItem, this, [key, value]);
      };
      Storage.prototype.removeItem = function removeItemWithDraftFailure(key) {
        if (key.startsWith("draft:")) throw new DOMException("quota", "QuotaExceededError");
        return Reflect.apply(removeItem, this, [key]);
      };
    });

    await login(page);
    await page.goto("./?demo=1#/threads/thread-active");
    const composer = page.getByTestId("turn-composer");
    await composer.focus();
    await composer.fill("这段文字仍留在当前页面");
    await expect(composer).toHaveValue("这段文字仍留在当前页面");
    await expect(page.getByTestId("conversation-draft-persistence")).toHaveText(
      "仅保存在当前页面，刷新会丢失",
    );
  });

  test("事件流断开但 HTTP 可用时仍可安全排队", async ({ page }) => {
    const runtime = new SharedRuntime();
    await runtime.attach(page.context());
    try {
      await openSharedThread(page);
      await expect(page.getByTestId("thread-view")).toBeVisible();
      await runtime.setOnline(false);
      await expect(page.getByText("实时更新已中断", { exact: true })).toHaveCount(0);
      await expect(page.getByText("实时更新已中断", { exact: true }).first()).toBeVisible({
        timeout: confirmedDisconnectTimeoutMs,
      });

      const composer = page.getByTestId("turn-composer");
      await composer.focus();
      await composer.fill("事件流断开后仍要安全排队");
      const submit = page.getByTestId("turn-steer-submit");
      await expect(submit).toBeEnabled();
      await expect(submit).toHaveAttribute("aria-label", "尝试安全排队");
      await submit.click();

      await expect(page.getByTestId("turn-queued")).toBeVisible();
      await expect(page.getByTestId("queue-shelf")).toContainText("事件流断开后仍要安全排队");
      await expect(composer).toHaveValue("");
    } finally {
      await runtime.close();
    }
  });

  test("事件流断开且 HTTP 排队失败时保留草稿并明确报错", async ({ page }) => {
    const runtime = new SharedRuntime();
    await runtime.attach(page.context());
    await page.route("**/api/v1/threads/shared-running-thread/queue", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        body: JSON.stringify({
          error: { code: "E2E_QUEUE_UNAVAILABLE", message: "排队服务暂时不可用" },
        }),
        contentType: "application/json",
        status: 503,
      });
    });
    try {
      await openSharedThread(page);
      await expect(page.getByTestId("thread-view")).toBeVisible();
      await runtime.setOnline(false);
      await expect(page.getByText("实时更新已中断", { exact: true })).toHaveCount(0);
      await expect(page.getByText("实时更新已中断", { exact: true }).first()).toBeVisible({
        timeout: confirmedDisconnectTimeoutMs,
      });

      const composer = page.getByTestId("turn-composer");
      await composer.focus();
      await composer.fill("排队失败也不能丢失的草稿");
      await page.getByTestId("turn-steer-submit").click();

      await expect(page.getByText("排队服务暂时不可用", { exact: true })).toBeVisible();
      await expect(page.getByTestId("turn-queued")).toHaveCount(0);
      await expect(composer).toHaveValue("排队失败也不能丢失的草稿");
    } finally {
      await runtime.close();
    }
  });

  test("切换任务时草稿和附件始终留在各自任务", async ({ page }) => {
    await login(page);
    await page.evaluate(() => {
      window.localStorage.setItem("draft:thread-active", "A 的草稿");
      window.localStorage.setItem("draft:thread-desktop-running", "B 的草稿");
      window.localStorage.setItem(
        "conversation-attachments:thread-active",
        JSON.stringify([
          {
            kind: "file",
            relativePath: "a-only.txt",
            uploadId: "11111111-1111-4111-8111-111111111111",
          },
        ]),
      );
      window.localStorage.setItem(
        "conversation-attachments:thread-desktop-running",
        JSON.stringify([
          {
            kind: "file",
            relativePath: "b-only.txt",
            uploadId: "22222222-2222-4222-8222-222222222222",
          },
        ]),
      );
    });
    await page.goto("./?demo=1#/threads/thread-active");
    await expect(page.getByTestId("turn-composer")).toHaveValue("A 的草稿");
    await page.getByTestId("turn-composer").focus();
    await expect(page.getByText("a-only.txt", { exact: true })).toBeVisible();

    await page.evaluate(() => {
      window.location.hash = "#/threads/thread-desktop-running";
    });

    await expect(page.getByTestId("turn-composer")).toHaveValue("B 的草稿");
    await page.getByTestId("turn-composer").focus();
    await expect(page.getByText("b-only.txt", { exact: true })).toBeVisible();
    await expect(page.getByText("a-only.txt", { exact: true })).toHaveCount(0);
    expect(
      await page.evaluate(() => ({
        attachments: window.localStorage.getItem("conversation-attachments:thread-desktop-running"),
        draft: window.localStorage.getItem("draft:thread-desktop-running"),
      })),
    ).toEqual({
      attachments: JSON.stringify([
        {
          kind: "file",
          relativePath: "b-only.txt",
          uploadId: "22222222-2222-4222-8222-222222222222",
        },
      ]),
      draft: "B 的草稿",
    });
  });

  test("登录、启动对话、引导、停止并查看额度、子智能体与文件", async ({ page }) => {
    await test.step("只使用一个密码登录", async () => {
      await login(page);
      await expect(page.getByTestId("current-host-status")).toBeVisible();
    });

    await test.step("在已有项目中启动对话", async () => {
      await page.locator('[data-testid="new-thread"]:visible').click();
      await expect(page.getByTestId("new-thread-form")).toBeVisible();
      await page.getByTestId("project-option").first().click();
      await page.getByTestId("new-thread-prompt").fill("检查示例项目并给出一段简短摘要。");
      await page.getByTestId("new-thread-model").selectOption({ index: 0 });
      await page.getByTestId("new-thread-effort").selectOption("medium");
      await page.getByTestId("new-thread-submit").click();
      await expect(page.getByTestId("thread-view")).toBeVisible();
      await expect(page.getByText("运行中", { exact: true })).toBeVisible();
    });

    await test.step("运行中追加引导并停止", async () => {
      const composer = page.getByTestId("turn-composer");
      await composer.click();
      await composer.fill("先只检查，不要修改任何文件。");
      await page.getByTestId("turn-steer-submit").click();
      await expect(page.getByTestId("steer-accepted")).toBeVisible();
      await page.getByTestId("turn-interrupt").click();
      await expect(page.getByTestId("turn-interrupted")).toBeVisible();
      await expect(page.getByTestId("turn-interrupt")).toHaveCount(0);
      await expect(page.getByTestId("turn-reply-submit")).toBeVisible();
    });

    await test.step("模型选择在专用面板说明生效范围，不占用输入区提示行", async () => {
      await page.getByTestId("turn-composer").click();
      await page.getByTestId("composer-settings-open").click();
      const settings = page.getByRole("dialog");
      await expect(settings.getByRole("heading", { name: "模型与运行设置" })).toBeVisible();
      await settings.getByRole("button", { name: "高", exact: true }).click();
      await settings.getByRole("button", { name: "保存设置" }).click();
      await expect(page.getByTestId("next-turn-model-notice")).toHaveCount(0);
    });

    await test.step("额度缺失时也不伪造为零", async () => {
      const usageOrb = page.getByTestId("usage-open");
      await usageOrb.click();
      await expect(page.getByTestId("usage-panel")).toBeVisible();
      const panel = page.getByTestId("usage-panel");
      await expect(panel).not.toContainText(/剩余\s*0%/u);
      await expect(
        panel.getByTestId("usage-window").or(panel.getByTestId("usage-unavailable")),
      ).toBeVisible();
      await usageOrb.click();
      await expect(panel).toBeHidden();
      await usageOrb.click();
      await expect(panel).toBeVisible();
    });

    await test.step("手动压缩复用一次请求，并只把 202 解释为已受理", async () => {
      const compact = page.getByTestId("context-compact");
      await expect(compact).toBeEnabled();
      await compact.evaluate((button) => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await expect(page.getByTestId("context-compact-status")).toContainText("已受理");
      await expect(page.getByTestId("turn-composer")).toBeVisible();
      const compactionRecord = page.getByTestId("context-compaction-record");
      await expect(compactionRecord).toHaveCount(1);
      await expect(compactionRecord).toHaveAttribute("aria-label", "上下文压缩记录");
      await expect(compactionRecord).toContainText("上下文已压缩");
      await expect(compactionRecord).toContainText("后续内容已使用新的上下文继续");
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
      await expect(
        page.getByText("只检查分配给你的模块，并把可验证结论返回父对话。"),
      ).toBeVisible();
      await expect(
        page.getByText("相关文件和边界已经核对完成，正在整理可以回读的验证结果。"),
      ).toBeVisible();
      await expect(
        page.getByText("子任务已完成：检查记录、工具活动和最终结论都保留在这个子智能体对话中。"),
      ).toBeVisible();
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
