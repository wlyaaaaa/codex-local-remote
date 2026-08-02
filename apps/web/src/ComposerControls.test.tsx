import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  ApprovalRequest,
  CollaborationModeOption,
  ModelOption,
  QueuedTurnItem,
} from "@codex-local-remote/contracts";
import {
  ComposerSettingsButton,
  ComposerSettingsSheet,
  ComposerToolsSheet,
  ComposerContextRows,
  DeliveryModeSwitch,
  GoalSheet,
  GoalInlineControl,
  InlineDecisionStack,
  PlanProgressControl,
  QueueShelf,
  reasoningEffortLabel,
} from "./ComposerControls";

const model: ModelOption = {
  id: "gpt-5.3-codex-spark",
  displayName: "GPT-5.3-Codex-Spark",
  supportedReasoningEfforts: ["high", "xhigh"],
  defaultReasoningEffort: "xhigh",
  serviceTiers: [
    { id: "default", displayName: "标准" },
    { id: "fast", displayName: "Fast" },
  ],
  defaultServiceTier: "fast",
  isDefault: true,
};

describe("composer 组件结构", () => {
  it("目标独占上方一行，发送方式与计划位于下方控制行", () => {
    const html = renderToStaticMarkup(
      <ComposerContextRows
        controls={<span data-testid="controls">发送方式与计划</span>}
        goal={<button data-testid="goal">进行中的目标</button>}
      />,
    );

    expect(html).toContain('class="composer__goal-row"');
    expect(html).toContain('class="composer__context-bar"');
    expect(html.indexOf('data-testid="goal"')).toBeLessThan(html.indexOf('data-testid="controls"'));
    expect(html).not.toMatch(/composer__context-bar[^>]*>[^<]*<button[^>]*data-testid="goal"/u);
  });

  it("设置按钮同时显示完整短模型名、思考等级与速度", () => {
    const html = renderToStaticMarkup(
      <ComposerSettingsButton
        effort="xhigh"
        model={model.id}
        models={[model]}
        onEffort={() => undefined}
        onModel={() => undefined}
        onOpen={() => undefined}
        serviceTier="fast"
        serviceTiersSupported
      />,
    );

    expect(html).toContain("5.3 Spark");
    expect(html).toContain("极高");
    expect(html).toContain("Fast");
    expect(html).not.toContain("GPT-5.3-C…");
    expect(html).toContain('data-testid="composer-settings-open"');
    expect(html).not.toContain('class="next-turn-badge"');
    expect(html).toContain("模型与运行设置：5.3 Spark");
  });

  it("速度能力未确认时不在现有对话设置中展示运行时档位", () => {
    const html = renderToStaticMarkup(
      <ComposerSettingsButton
        effort="xhigh"
        model={model.id}
        models={[model]}
        onEffort={() => undefined}
        onModel={() => undefined}
        onOpen={() => undefined}
        serviceTier="fast"
        serviceTiersSupported={false}
      />,
    );

    expect(html).toContain("5.3 Spark");
    expect(html).not.toContain("Fast");
  });

  it("速度目录只返回 Fast 时仍提供标准速度", () => {
    const fastOnly = {
      ...model,
      serviceTiers: [{ id: "fast", displayName: "Fast" }],
      defaultServiceTier: "fast",
    };
    const html = renderToStaticMarkup(
      <ComposerSettingsSheet
        busy={false}
        effort="xhigh"
        model={fastOnly.id}
        models={[fastOnly]}
        onApply={() => undefined}
        onClose={() => undefined}
        onEffort={() => undefined}
        onModel={() => undefined}
        onServiceTier={() => undefined}
        open
        serviceTier={null}
        serviceTiersSupported
      />,
    );

    expect(html).toContain(">标准<");
    expect(html).toContain("不启用额外加速");
    expect(html).toContain("Fast");
    expect(html).toContain("模型与运行设置");
    expect(html).toContain("保存设置");
    expect(html).toContain("运行中的回复不会变更");
    expect(html).not.toContain("只影响下一轮");
  });

  it("演示目录明确标注样例，且 Spark 不会继承别的模型的 Fast", () => {
    const {
      serviceTiers: _serviceTiers,
      defaultServiceTier: _defaultServiceTier,
      ...sparkWithoutSpeedTiers
    } = model;
    const html = renderToStaticMarkup(
      <ComposerSettingsSheet
        busy={false}
        demo
        effort="high"
        model={sparkWithoutSpeedTiers.id}
        models={[sparkWithoutSpeedTiers]}
        onApply={() => undefined}
        onClose={() => undefined}
        onEffort={() => undefined}
        onModel={() => undefined}
        onServiceTier={() => undefined}
        open
        serviceTier="fast"
        serviceTiersSupported
      />,
    );

    expect(html).toContain("当前是演示模式");
    expect(html).toContain("实时显示 Codex Desktop");
    expect(html).toContain(">标准<");
    expect(html).not.toContain(">Fast<");
    expect(html).toContain('data-testid="demo-model-note"');
  });

  it("目录外实际模型与未来思考等级按真值显示，不伪装成默认模型", () => {
    const html = renderToStaticMarkup(
      <>
        <ComposerSettingsButton
          effort="ultra-future"
          model="provider/custom-model"
          models={[model]}
          onEffort={() => undefined}
          onModel={() => undefined}
          onOpen={() => undefined}
          serviceTiersSupported
        />
        <ComposerSettingsSheet
          busy={false}
          effort="ultra-future"
          model="provider/custom-model"
          models={[model]}
          onApply={() => undefined}
          onClose={() => undefined}
          onEffort={() => undefined}
          onModel={() => undefined}
          onServiceTier={() => undefined}
          open
          serviceTiersSupported
        />
      </>,
    );

    expect(html).toContain("provider/custom-model");
    expect(html).toContain("ultra-future");
    expect(html).toContain('data-testid="runtime-model-outside-catalog"');
    expect(html).not.toContain("下一轮设置");
  });

  it("运行中明确提供当前回复与排队两个发送目的地", () => {
    const html = renderToStaticMarkup(
      <DeliveryModeSwitch mode="steer" onChange={() => undefined} queueSupported />,
    );
    expect(html).toContain("发送到");
    expect(html).toContain("当前回复");
    expect(html).toContain("排队");
    expect(html).not.toContain("下一轮");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('class="delivery-switch__compact-label">当前</span>');
  });

  it("移动端工具栏保留短标签并禁止计划步数折断", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

    expect(css).toMatch(
      /\.composer-plan-progress\s*>\s*summary\s+strong\s*\{[^}]*white-space:\s*nowrap;/su,
    );
    expect(css).toMatch(
      /@media \(max-width: 700px\)[\s\S]*?\.delivery-switch__label[^}]*\{[^}]*display:\s*none;/u,
    );
    expect(css).toMatch(
      /@media \(max-width: 700px\)[\s\S]*?\.delivery-switch__compact-label\s*\{[^}]*display:\s*inline;/u,
    );
    expect(css).not.toMatch(/\.composer__context-bar[^}]*word-break:\s*(?:break-all|break-word)/u);
  });

  it("计划进度以输入区右侧胶囊展示并可展开全部步骤", () => {
    const html = renderToStaticMarkup(
      <PlanProgressControl
        plan={{
          explanation: "先实现，再验证",
          id: "plan",
          kind: "plan-progress",
          steps: [
            { status: "completed", text: "读取需求" },
            { status: "inProgress", text: "实现界面" },
            { status: "pending", text: "验证交互" },
          ],
        }}
      />,
    );

    expect(html).toContain('data-testid="composer-plan-progress"');
    expect(html).toContain("第 2/3 步");
    expect(html).toContain("1/3 步已完成");
    expect(html).toContain("读取需求");
    expect(html).toContain("验证交互");
    expect(html).toContain('aria-label="关闭任务进度"');
    expect(html).toContain('data-testid="composer-plan-progress-close"');
  });

  it("工具抽屉只渲染运行时确认支持的入口", () => {
    const collaborationModes: CollaborationModeOption[] = [
      { id: "plan", displayName: "计划", available: true },
    ];
    const html = renderToStaticMarkup(
      <ComposerToolsSheet
        canAttach={false}
        canCompact={false}
        capabilities={{
          appServer: "available",
          desktopSnapshots: "available",
          fileBrowser: "available",
          goals: "available",
          collaborationModes: "unavailable",
          compact: "unavailable",
          liveEvents: "available",
          subagents: "available",
          usage: "available",
        }}
        collaborationModes={collaborationModes}
        onClose={() => undefined}
        onAttach={() => undefined}
        onCompact={() => undefined}
        onGoal={() => undefined}
        onPlan={() => undefined}
        open
      />,
    );
    expect(html).toContain("任务目标");
    expect(html).not.toContain("计划模式");
    expect(html).not.toContain("压缩上下文");
  });

  it("已有目标提供运行时真实支持的暂停和继续能力", () => {
    const html = renderToStaticMarkup(
      <GoalSheet
        busy={false}
        hasGoal
        onChange={() => undefined}
        onClear={() => undefined}
        onClose={() => undefined}
        onSave={() => undefined}
        onStatusChange={() => undefined}
        open
        status="active"
        value="完成候选版本"
      />,
    );

    expect(html).toContain("保存修改");
    expect(html).toContain("删除目标");
    expect(html).toContain("暂停目标");

    const pausedHtml = renderToStaticMarkup(
      <GoalSheet
        busy={false}
        hasGoal
        onChange={() => undefined}
        onClear={() => undefined}
        onClose={() => undefined}
        onSave={() => undefined}
        onStatusChange={() => undefined}
        open
        status="paused"
        value="完成候选版本"
      />,
    );
    expect(pausedHtml).toContain("继续目标");
  });

  it("目标独占一行完整展示并直接提供暂停继续开始和删除", () => {
    const goal = {
      threadId: "thread-goal",
      objective: "完成完整目标文本，不截断任何验收条件，并保持移动端可连续操作。",
      status: "active" as const,
      tokensUsed: 10,
      timeUsedSeconds: 20,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:01:00.000Z",
    };
    const activeHtml = renderToStaticMarkup(
      <GoalInlineControl
        busy={false}
        goal={goal}
        onClear={() => undefined}
        onOpen={() => undefined}
        onStatusChange={() => undefined}
      />,
    );
    expect(activeHtml).toContain(goal.objective);
    expect(activeHtml).toContain("暂停");
    expect(activeHtml).toContain("删除");
    expect(activeHtml).not.toContain("text-overflow");

    const pausedHtml = renderToStaticMarkup(
      <GoalInlineControl
        busy={false}
        goal={{ ...goal, status: "paused" }}
        onClear={() => undefined}
        onOpen={() => undefined}
        onStatusChange={() => undefined}
      />,
    );
    expect(pausedHtml).toContain("继续");

    const completedHtml = renderToStaticMarkup(
      <GoalInlineControl
        busy={false}
        goal={{ ...goal, status: "complete" }}
        onClear={() => undefined}
        onOpen={() => undefined}
        onStatusChange={() => undefined}
      />,
    );
    expect(completedHtml).toBe("");
  });

  it("Ultra 在默认和已选位置统一只显示 ultra", () => {
    expect(reasoningEffortLabel("ultra")).toBe("ultra");
    expect(reasoningEffortLabel("max")).toBe("最高");
    expect(
      renderToStaticMarkup(
        <ComposerSettingsButton
          effort="ultra"
          model={model.id}
          models={[
            { ...model, supportedReasoningEfforts: ["ultra"], defaultReasoningEffort: "ultra" },
          ]}
          onEffort={() => undefined}
          onModel={() => undefined}
          onOpen={() => undefined}
          serviceTiersSupported={false}
        />,
      ),
    ).toContain("ultra");
    expect(
      renderToStaticMarkup(
        <ComposerSettingsButton
          effort="ultra"
          model={model.id}
          models={[
            { ...model, supportedReasoningEfforts: ["ultra"], defaultReasoningEffort: "ultra" },
          ]}
          onEffort={() => undefined}
          onModel={() => undefined}
          onOpen={() => undefined}
          serviceTiersSupported={false}
        />,
      ),
    ).not.toContain("最高");
  });

  it("当前线程的结构化问题固定显示在对话内", () => {
    const approvals: ApprovalRequest[] = [
      {
        id: "approval",
        threadId: "thread",
        title: "请选择实现范围",
        choices: [{ id: "allow", label: "继续", tone: "primary" }],
        questions: [
          {
            id: "scope",
            header: "范围",
            question: "只修改当前项目吗？",
            isOther: false,
            isSecret: false,
          },
        ],
      },
    ];
    const html = renderToStaticMarkup(
      <InlineDecisionStack approvals={approvals} onOpen={() => undefined} />,
    );
    expect(html).toContain('data-testid="thread-approval-stack"');
    expect(html).toContain("请选择实现范围");
    expect(html).toContain("只修改当前项目吗？");
  });

  it("当前线程超过三项审批时仍全部显示", () => {
    const approvals: ApprovalRequest[] = Array.from({ length: 5 }, (_, index) => ({
      id: `approval-${index + 1}`,
      threadId: "thread",
      title: `审批 ${index + 1}`,
      choices: [{ id: "allow", label: "继续", tone: "primary" }],
    }));

    const html = renderToStaticMarkup(
      <InlineDecisionStack approvals={approvals} onOpen={() => undefined} />,
    );

    for (const approval of approvals) expect(html).toContain(approval.title);
  });

  it("队列 shelf 显示完整待发内容并提供可访问的编辑与发送操作", () => {
    const item: QueuedTurnItem = {
      id: "queue",
      threadId: "thread",
      clientUserMessageId: "client",
      state: "queued",
      position: 0,
      revision: 1,
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
      prompt: "完成真实三端同步验收，并保留全部证据。",
    };
    const html = renderToStaticMarkup(
      <QueueShelf
        items={[item]}
        onDelete={() => undefined}
        onDispatch={() => undefined}
        onMove={() => undefined}
        onUpdate={() => undefined}
        running={false}
      />,
    );
    expect(html).toContain("消息队列");
    expect(html).toContain("完成真实三端同步验收，并保留全部证据。");
    expect(html).toContain('aria-label="编辑排队消息"');
    expect(html).toContain('aria-label="立即发送这条消息"');
  });

  it("暂停和发送结果未知的消息仍可编辑删除，并提供明确的人工恢复入口", () => {
    const base: QueuedTurnItem = {
      clientUserMessageId: "client",
      createdAt: "2026-07-26T00:00:00.000Z",
      id: "queue-paused",
      issue: "PREVIOUS_TURN_DID_NOT_COMPLETE",
      position: 0,
      prompt: "人工确认后恢复",
      revision: 2,
      state: "paused",
      threadId: "thread",
      updatedAt: "2026-07-26T00:01:00.000Z",
    };
    const html = renderToStaticMarkup(
      <QueueShelf
        items={[
          base,
          {
            ...base,
            clientUserMessageId: "client-ambiguous",
            id: "queue-ambiguous",
            issue: "SEND_RESULT_UNKNOWN",
            position: 1,
            state: "ambiguous",
          },
        ]}
        onDelete={() => undefined}
        onDispatch={() => undefined}
        onMove={() => undefined}
        onUpdate={() => undefined}
        running={false}
      />,
    );

    expect(html).toContain('aria-label="重新发送这条消息"');
    expect(html).toContain('aria-label="确认重试发送结果未知的消息"');
    expect(html.match(/aria-label="删除排队消息"/gu)).toHaveLength(2);
    expect(html.match(/aria-label="编辑排队消息"/gu)).toHaveLength(2);
  });

  it("运行中可把下一轮队列项直接改为当前引导", () => {
    const item: QueuedTurnItem = {
      clientUserMessageId: "client-steer",
      createdAt: "2026-07-26T00:00:00.000Z",
      id: "queue-steer",
      position: 0,
      prompt: "补充当前正在执行的任务",
      revision: 1,
      state: "queued",
      threadId: "thread",
      updatedAt: "2026-07-26T00:00:00.000Z",
    };
    const html = renderToStaticMarkup(
      <QueueShelf
        canSteer
        items={[item]}
        onDelete={() => undefined}
        onDispatch={() => undefined}
        onMove={() => undefined}
        onSteer={() => undefined}
        onUpdate={() => undefined}
        running
      />,
    );

    expect(html).toContain('aria-label="将排队消息改为当前引导"');
    expect(html).toContain("改为引导");
    expect(html).not.toContain('aria-label="当前回复结束后可手动发送"');
  });

  it("已由 Codex 接收的 started 回执不再伪装成可删除的排队消息", () => {
    const item: QueuedTurnItem = {
      clientUserMessageId: "client-started",
      createdAt: "2026-08-02T00:00:00.000Z",
      id: "queue-started",
      position: 0,
      revision: 3,
      state: "started",
      threadId: "thread",
      turnId: "turn-active",
      updatedAt: "2026-08-02T00:00:01.000Z",
    };
    const html = renderToStaticMarkup(
      <QueueShelf
        items={[item]}
        onDelete={() => undefined}
        onDispatch={() => undefined}
        onMove={() => undefined}
        onUpdate={() => undefined}
        running
      />,
    );

    expect(html).toBe("");
  });

  it("started 回执与待发消息并存时只统计和展示真正待发的消息", () => {
    const base: QueuedTurnItem = {
      clientUserMessageId: "client-pending",
      createdAt: "2026-08-02T00:00:00.000Z",
      id: "queue-pending",
      position: 1,
      prompt: "真正等待发送的消息",
      revision: 4,
      state: "queued",
      threadId: "thread",
      updatedAt: "2026-08-02T00:00:01.000Z",
    };
    const { prompt: _pendingPrompt, ...startedBase } = base;
    const html = renderToStaticMarkup(
      <QueueShelf
        items={[
          {
            ...startedBase,
            clientUserMessageId: "client-started",
            id: "queue-started",
            position: 0,
            state: "started",
            turnId: "turn-active",
          },
          base,
        ]}
        onDelete={() => undefined}
        onDispatch={() => undefined}
        onMove={() => undefined}
        onUpdate={() => undefined}
        running
      />,
    );

    expect(html).toContain("1 条");
    expect(html).toContain("真正等待发送的消息");
    expect(html).not.toContain("这条消息正在由 Codex 处理");
  });

  it("dispatching 消息明确说明发送边界，不显示一排无法解释的禁用按钮", () => {
    const item: QueuedTurnItem = {
      clientUserMessageId: "client-dispatching",
      createdAt: "2026-08-02T00:00:00.000Z",
      id: "queue-dispatching",
      position: 0,
      prompt: "正在提交的消息",
      revision: 5,
      state: "dispatching",
      threadId: "thread",
      updatedAt: "2026-08-02T00:00:01.000Z",
    };
    const html = renderToStaticMarkup(
      <QueueShelf
        items={[item]}
        onDelete={() => undefined}
        onDispatch={() => undefined}
        onMove={() => undefined}
        onUpdate={() => undefined}
        running
      />,
    );

    expect(html).toContain("正在发送，结果确认前暂不可修改或删除");
    expect(html).not.toContain('aria-label="删除排队消息"');
    expect(html).not.toContain('aria-label="编辑排队消息"');
  });
});
