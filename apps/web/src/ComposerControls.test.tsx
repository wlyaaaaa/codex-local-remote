import { renderToStaticMarkup } from "react-dom/server";
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
  DeliveryModeSwitch,
  GoalSheet,
  InlineDecisionStack,
  PlanProgressControl,
  QueueShelf,
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
    expect(html).not.toContain("下一轮设置：5.3 Spark");
  });

  it("运行中明确提供当前回复与下一轮两个发送目的地", () => {
    const html = renderToStaticMarkup(
      <DeliveryModeSwitch mode="steer" onChange={() => undefined} queueSupported />,
    );
    expect(html).toContain("发送到");
    expect(html).toContain("当前回复");
    expect(html).toContain("下一轮");
    expect(html).toContain('aria-pressed="true"');
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
    expect(html).toContain("下一轮队列");
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
});
