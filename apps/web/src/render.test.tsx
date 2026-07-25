import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import { Button, Sheet, StatusPill } from "@codex-local-remote/ui";
import {
  OTHER_ANSWER,
  approvalInputType,
  buildApprovalResolution,
  choiceRequiresAnswers,
  isApprovalQuestionAnswered,
} from "./approval";
import { canDirectlyCompose } from "./permissions";
import { registeredProjects } from "./project-access";
import { authenticatedBootstrap, loggedOutBootstrap } from "./auth-state";
import { WORKSPACE_REFRESH_MS, canRefreshDocument, threadRefreshDelay } from "./refresh";
import { PaginationFooter } from "./PaginationFooter";
import { mergeCursorItems, nextCursorAfterRefresh, nextCursorFrom } from "./pagination";
import { threadRuntimeSummary } from "./thread-runtime";
import {
  defaultReasoningEffortForModel,
  normalizeReasoningEffort,
  normalizeReasoningEffortForModel,
} from "./model-effort";
import { fileChangeStatusLabel, toolFallbackSummary } from "./terminal-display";
import {
  creditBalanceLabel,
  remainingFromUsedPercent,
  remainingPercentLabel,
  usedPercentLabel,
} from "./usage-display";

describe("界面基础渲染", () => {
  it("为主要按钮保留可访问名称与触控标记", () => {
    const html = renderToStaticMarkup(
      <Button icon="plus" variant="primary">
        新建对话
      </Button>,
    );
    expect(html).toContain("新建对话");
    expect(html).toContain('data-touch-target="primary"');
    expect(html).toContain("<svg");
  });

  it("审批抽屉使用模态对话语义", () => {
    const html = renderToStaticMarkup(
      <Sheet
        description="只修改当前项目"
        footer={<Button variant="primary">允许这一次</Button>}
        onClose={() => undefined}
        open
        title="允许修改文件？"
      >
        <StatusPill tone="warning">等待审批</StatusPill>
      </Sheet>,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("允许这一次");
  });

  it("Markdown 清理脚本与事件属性", () => {
    const html = renderToStaticMarkup(
      <ReactMarkdown rehypePlugins={[rehypeSanitize]} skipHtml>
        {'正常文字<script>alert("x")</script><img src=x onerror=alert(1)>'}
      </ReactMarkdown>,
    );
    expect(html).toContain("正常文字");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
  });

  it("运行中操作使用明确的停止文案", () => {
    const html = renderToStaticMarkup(
      <Button aria-label="停止当前工作" data-testid="turn-interrupt" icon="stop" variant="danger">
        停止
      </Button>,
    );
    expect(html).toContain("停止当前工作");
    expect(html).toContain(">停止<");
    expect(html).toContain('data-testid="turn-interrupt"');
  });

  it("只让契约明确授权的线程显示直接输入", () => {
    expect(
      canDirectlyCompose({
        activeTurnId: "turn-1",
        availableActions: {
          steer: true,
          interrupt: true,
          reply: false,
          changeModelNextTurn: true,
        },
      }),
    ).toBe(true);
    expect(
      canDirectlyCompose({
        availableActions: {
          steer: false,
          interrupt: false,
          reply: false,
          changeModelNextTurn: false,
        },
      }),
    ).toBe(false);
  });

  it("自动发现项目只用于历史归类，不进入新任务或文件授权选择", () => {
    expect(
      registeredProjects([
        {
          id: "registered",
          name: "已登记",
          rootLabel: "registered",
          source: "registered",
        },
        {
          id: "thread-only",
          name: "历史归类",
          rootLabel: "thread-only",
          source: "thread",
        },
      ]).map((project) => project.id),
    ).toEqual(["registered"]);
  });

  it("结构化审批只在允许操作时要求完整回答", () => {
    const approval = {
      id: "approval-test",
      threadId: "thread-test",
      title: "允许操作？",
      choices: [
        { id: "allow", label: "允许", tone: "primary" as const },
        { id: "cancel", label: "取消", tone: "neutral" as const },
      ],
      questions: [
        {
          id: "scope",
          header: "范围",
          question: "选择范围",
          isOther: true,
          isSecret: false,
          options: [{ label: "当前项目", description: "仅限当前项目" }],
        },
        {
          id: "token",
          header: "临时凭据",
          question: "输入临时凭据",
          isOther: false,
          isSecret: true,
        },
      ],
    };
    const drafts = {
      scope: { selected: OTHER_ANSWER, text: "仅检查锁文件" },
      token: { text: "synthetic-secret" },
    };
    expect(choiceRequiresAnswers(approval, "allow")).toBe(true);
    expect(choiceRequiresAnswers(approval, "cancel")).toBe(false);
    expect(isApprovalQuestionAnswered(approval.questions[0]!, drafts.scope)).toBe(true);
    expect(buildApprovalResolution("allow", approval.questions, drafts)).toEqual({
      choiceId: "allow",
      answers: {
        scope: ["仅检查锁文件"],
        token: ["synthetic-secret"],
      },
    });
  });

  it("秘密回答使用密码输入且空值不会进入提交体", () => {
    expect(approvalInputType(true)).toBe("password");
    expect(approvalInputType(false)).toBe("text");
    expect(
      buildApprovalResolution(
        "allow",
        [
          {
            id: "secret",
            header: "秘密",
            question: "输入秘密",
            isOther: false,
            isSecret: true,
          },
        ],
        { secret: { text: "   " } },
      ),
    ).toEqual({ choiceId: "allow" });
  });

  it("只在页面可见时按运行状态选择静默刷新频率", () => {
    expect(threadRefreshDelay("running")).toBe(3_000);
    expect(threadRefreshDelay("complete")).toBe(10_000);
    expect(WORKSPACE_REFRESH_MS).toBe(10_000);
    expect(canRefreshDocument("visible")).toBe(true);
    expect(canRefreshDocument("hidden")).toBe(false);
  });

  it("从响应头读取续页游标并按 ID 去重合并", () => {
    const headers = new Headers({ "X-Next-Cursor": " older-page " });
    expect(nextCursorFrom(headers)).toBe("older-page");
    expect(nextCursorAfterRefresh("loaded-tail", "new-first-page", true)).toBe("loaded-tail");
    expect(nextCursorAfterRefresh(undefined, "new-first-page", false)).toBe("new-first-page");
    expect(
      mergeCursorItems(
        [
          { id: "new", value: 1 },
          { id: "same", value: 1 },
        ],
        [
          { id: "same", value: 2 },
          { id: "old", value: 1 },
        ],
        (item) => item.id,
      ),
    ).toEqual([
      { id: "same", value: 2 },
      { id: "old", value: 1 },
      { id: "new", value: 1 },
    ]);
    expect(
      mergeCursorItems(
        [
          { id: "new", value: 1 },
          { id: "same", value: 1 },
        ],
        [
          { id: "same", value: 2 },
          { id: "old", value: 1 },
        ],
        (item) => item.id,
        "append",
      ),
    ).toEqual([
      { id: "new", value: 1 },
      { id: "same", value: 1 },
      { id: "old", value: 1 },
    ]);
  });

  it("分页状态明确区分加载、错误与无更多内容", () => {
    const loading = renderToStaticMarkup(
      <PaginationFooter
        completeLabel="已显示全部对话"
        error=""
        hasMore
        label="加载更早对话"
        loading
        onLoadMore={() => undefined}
      />,
    );
    expect(loading).toContain("正在加载…");
    expect(loading).toContain("disabled");

    const failed = renderToStaticMarkup(
      <PaginationFooter
        completeLabel="已显示全部对话"
        error="较早对话加载失败"
        hasMore={false}
        label="加载更早对话"
        loading={false}
        onLoadMore={() => undefined}
      />,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("较早对话加载失败");
    expect(failed).toContain("重试加载");

    const complete = renderToStaticMarkup(
      <PaginationFooter
        completeLabel="已显示全部对话"
        error=""
        hasMore={false}
        label="加载更早对话"
        loading={false}
        onLoadMore={() => undefined}
      />,
    );
    expect(complete).toContain("已显示全部对话");
  });

  it("桌面快照缺少协议字段时不伪装成默认模型与思考等级", () => {
    expect(
      threadRuntimeSummary({
        mode: "desktop-snapshot",
      }),
    ).toBe("模型未知 / 思考等级未知（桌面接口未提供）");
    expect(
      threadRuntimeSummary({
        mode: "managed",
      }),
    ).toBe("默认模型 · 默认思考");
    expect(
      threadRuntimeSummary({
        mode: "managed",
        model: "future-model",
        reasoningEffort: "future-effort",
      }),
    ).toBe("future-model · future-effort思考");
  });

  it("首次设置完成并退出后仍保持已配置状态", () => {
    const initial = {
      schemaVersion: 1 as const,
      productName: "Local Remote",
      basePath: "/",
      configured: false,
      authenticated: false,
    };
    const authenticated = authenticatedBootstrap(initial);
    expect(authenticated).toMatchObject({ configured: true, authenticated: true });
    expect(loggedOutBootstrap(authenticated)).toMatchObject({
      configured: true,
      authenticated: false,
    });
  });

  it("切换模型及提交前都会把思考等级规范化到目标模型支持范围", () => {
    const models = [
      {
        id: "broad",
        displayName: "Broad",
        supportedReasoningEfforts: ["low", "high"],
        isDefault: true,
      },
      {
        id: "fast",
        displayName: "Fast",
        supportedReasoningEfforts: ["none", "low"],
        defaultReasoningEffort: "low",
        isDefault: false,
      },
      {
        id: "fallback",
        displayName: "Fallback",
        supportedReasoningEfforts: ["minimal", "none"],
        defaultReasoningEffort: "unsupported",
        isDefault: false,
      },
    ];
    expect(normalizeReasoningEffortForModel(models[1], "high")).toBe("low");
    expect(normalizeReasoningEffortForModel(models[2], "high")).toBe("minimal");
    expect(defaultReasoningEffortForModel(models[1])).toBe("low");
    expect(defaultReasoningEffortForModel(models[2])).toBe("minimal");
    expect(normalizeReasoningEffort(models, "fast", "high")).toBe("low");
    expect(normalizeReasoningEffort(models, "fast", "none")).toBe("none");
  });

  it("终端失败与拒绝状态使用真实文案", () => {
    expect(toolFallbackSummary("failed")).toBe("执行失败");
    expect(toolFallbackSummary("running")).toBe("正在执行");
    expect(fileChangeStatusLabel("modified", "inProgress")).toBe("正在修改");
    expect(fileChangeStatusLabel("added", "failed")).toBe("新增失败");
    expect(fileChangeStatusLabel("deleted", "declined")).toBe("已拒绝删除");
  });

  it("额度文案明确区分已用、剩余与不可用", () => {
    expect(usedPercentLabel(27.6)).toBe("已用 28%");
    expect(remainingPercentLabel(72.4)).toBe("剩余额度 72%");
    expect(remainingPercentLabel(undefined)).toBe("剩余额度暂时无法读取");
    expect(remainingFromUsedPercent(27.6)).toBeCloseTo(72.4);
    expect(
      creditBalanceLabel({
        id: "credits",
        label: "Credits",
        hasCredits: true,
        unlimited: false,
        balance: "18.50",
      }),
    ).toBe("余额 18.50");
    expect(
      creditBalanceLabel({
        id: "credits",
        label: "Credits",
        hasCredits: true,
        unlimited: true,
      }),
    ).toBe("无限额度");
  });
});
