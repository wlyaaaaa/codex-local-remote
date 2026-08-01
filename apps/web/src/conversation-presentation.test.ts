import type { ConversationItem } from "@codex-local-remote/contracts";
import { describe, expect, it } from "vitest";

import {
  activeWorkLogSegmentIndex,
  activitySummary,
  assistantPhaseForDisplay,
  conversationContentItems,
  currentLivePhase,
  groupConversationItems,
  latestActiveReasoning,
  latestPlanProgress,
  latestReasoningText,
  subagentActivityStatusForDisplay,
  workLogSegmentBelongsToActiveTurn,
  workLogHeadline,
  workLogSummary,
} from "./conversation-presentation";

describe("conversation presentation", () => {
  it("groups consecutive secondary work while keeping first-class content separate", () => {
    const items: ConversationItem[] = [
      { id: "reasoning", kind: "reasoning-summary", text: "先检查", turnId: "turn-1" },
      {
        id: "command",
        kind: "tool",
        status: "complete",
        title: "运行命令",
        turnId: "turn-1",
      },
      {
        change: "modified",
        id: "file",
        kind: "file-change",
        path: "src/app.ts",
        turnId: "turn-1",
      },
      {
        id: "answer",
        kind: "assistant-message",
        phase: "final_answer",
        text: "完成",
        turnId: "turn-1",
      },
    ];

    expect(groupConversationItems(items).map((segment) => segment.kind)).toEqual([
      "work",
      "content",
    ]);
    expect(activitySummary(items.slice(1, 3))).toBe("编辑了 1 个文件 · 运行了 1 个命令");
    expect(workLogSummary(items.slice(0, 3))).toBe("1 条进展 · 2 项操作");
    expect(workLogHeadline(items.slice(0, 3))).toBe("先检查");
  });

  it("keeps context compaction as a permanent standalone history record", () => {
    const items: ConversationItem[] = [
      {
        id: "compaction",
        kind: "tool",
        operation: "context-compaction",
        status: "complete",
        title: "压缩对话上下文",
        turnId: "turn-1",
      },
      {
        id: "command",
        kind: "tool",
        status: "complete",
        title: "运行命令",
        turnId: "turn-1",
      },
    ];

    expect(groupConversationItems(items).map((segment) => segment.kind)).toEqual([
      "compaction",
      "work",
    ]);
  });

  it("keeps compact subagent chips together and splits different turns", () => {
    const items: ConversationItem[] = [
      {
        action: "spawn",
        agents: [{ label: "Reviewer", threadId: "agent-1" }],
        id: "spawn-1",
        kind: "subagent-activity",
        status: "running",
        turnId: "turn-1",
      },
      {
        action: "spawn",
        agents: [{ label: "Tester", threadId: "agent-2" }],
        id: "spawn-2",
        kind: "subagent-activity",
        status: "running",
        turnId: "turn-1",
      },
      {
        action: "update",
        agents: [{ label: "Reviewer", threadId: "agent-1" }],
        id: "update",
        kind: "subagent-activity",
        status: "complete",
        turnId: "turn-2",
      },
    ];

    const segments = groupConversationItems(items);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.kind === "work" ? segments[0].items : []).toHaveLength(2);
  });

  it("collapses a long completed thought chain into one reversible work log without losing order", () => {
    const items: ConversationItem[] = [
      { id: "user", kind: "user-message", text: "开始", turnId: "turn-1" },
      {
        id: "reasoning-1",
        kind: "reasoning-summary",
        text: "先检查",
        turnId: "turn-1",
      },
      {
        id: "commentary-1",
        kind: "assistant-message",
        phase: "commentary",
        text: "再实现",
        turnId: "turn-1",
      },
      {
        id: "command",
        kind: "tool",
        status: "complete",
        title: "运行命令",
        turnId: "turn-1",
      },
      {
        id: "commentary-2",
        kind: "assistant-message",
        phase: "commentary",
        text: "最后验证",
        turnId: "turn-1",
      },
      {
        id: "answer",
        kind: "assistant-message",
        phase: "final_answer",
        text: "完成",
        turnId: "turn-1",
      },
    ];

    const segments = groupConversationItems(items);
    expect(segments.map((segment) => segment.kind)).toEqual(["content", "work", "content"]);
    expect(segments[1]?.kind === "work" ? segments[1].items.map((item) => item.id) : []).toEqual([
      "reasoning-1",
      "commentary-1",
      "command",
      "commentary-2",
    ]);
  });

  it("never labels a historical subagent record as live work after its turn completed", () => {
    const historical: ConversationItem[] = [
      {
        action: "activity",
        agents: [{ threadId: "agent-old" }],
        id: "subagent-stale-running",
        kind: "subagent-activity",
        status: "running",
        turnId: "turn-old",
      },
    ];

    const segments = groupConversationItems(historical);
    expect(activeWorkLogSegmentIndex(segments, undefined)).toBe(-1);
    expect(activeWorkLogSegmentIndex(segments, "turn-live")).toBe(-1);
    expect(activeWorkLogSegmentIndex(segments, "turn-old")).toBe(0);
    expect(subagentActivityStatusForDisplay("running", false, "activity")).toBe("unknown");
    expect(subagentActivityStatusForDisplay("running", true)).toBe("running");
    expect(subagentActivityStatusForDisplay("failed", false)).toBe("failed");
    expect(subagentActivityStatusForDisplay("running", false, "close")).toBe("complete");
    expect(subagentActivityStatusForDisplay("complete", false)).toBe("complete");
  });

  it("marks only the latest work log segment in an active turn as live", () => {
    const segments = groupConversationItems([
      { id: "user", kind: "user-message", text: "继续", turnId: "turn-live" },
      {
        id: "reasoning-before",
        kind: "reasoning-summary",
        text: "压缩前",
        turnId: "turn-live",
      },
      {
        id: "compaction",
        kind: "tool",
        operation: "context-compaction",
        status: "complete",
        title: "压缩对话上下文",
        turnId: "turn-live",
      },
      {
        id: "reasoning-after",
        kind: "reasoning-summary",
        text: "压缩后",
        turnId: "turn-live",
      },
    ]);

    expect(segments.map((segment) => segment.kind)).toEqual([
      "content",
      "work",
      "compaction",
      "work",
    ]);
    expect(activeWorkLogSegmentIndex(segments, "turn-live")).toBe(3);
  });

  it("keeps every split work segment from the active turn active for subagent status", () => {
    const segments = groupConversationItems([
      {
        action: "activity",
        agents: [{ threadId: "agent-live" }],
        id: "subagent-running",
        kind: "subagent-activity",
        status: "running",
        turnId: "turn-live",
      },
      {
        action: "viewed",
        attachments: [],
        id: "image",
        kind: "image-activity",
        status: "complete",
        turnId: "turn-live",
      },
      {
        id: "reasoning-after-image",
        kind: "reasoning-summary",
        text: "继续处理",
        turnId: "turn-live",
      },
    ]);

    expect(segments.map((segment) => segment.kind)).toEqual(["work", "content", "work"]);
    expect(activeWorkLogSegmentIndex(segments, "turn-live")).toBe(2);
    expect(workLogSegmentBelongsToActiveTurn(segments, 0, "turn-live")).toBe(true);
    expect(workLogSegmentBelongsToActiveTurn(segments, 2, "turn-live")).toBe(true);
    expect(
      subagentActivityStatusForDisplay(
        "running",
        workLogSegmentBelongsToActiveTurn(segments, 0, "turn-live"),
      ),
    ).toBe("running");
    expect(workLogSegmentBelongsToActiveTurn(segments, 0, undefined)).toBe(false);
  });

  it("does not let an undefined turn item bridge two explicit turns into one work segment", () => {
    const segments = groupConversationItems([
      {
        id: "turn-a",
        kind: "reasoning-summary",
        text: "A",
        turnId: "turn-a",
      },
      {
        id: "turn-unknown",
        kind: "tool",
        status: "complete",
        title: "运行命令",
      },
      {
        id: "turn-b",
        kind: "reasoning-summary",
        text: "B",
        turnId: "turn-b",
      },
    ]);

    expect(
      segments.map((segment) =>
        segment.kind === "work" ? segment.items.map((item) => item.id) : [],
      ),
    ).toEqual([["turn-a", "turn-unknown"], ["turn-b"]]);
  });

  it("uses authoritative message phases and conservatively treats the last legacy message as final", () => {
    const items: ConversationItem[] = [
      { id: "one", kind: "assistant-message", text: "处理中", turnId: "turn-1" },
      { id: "two", kind: "assistant-message", text: "完成", turnId: "turn-1" },
      {
        id: "three",
        kind: "assistant-message",
        phase: "commentary",
        text: "明确思考",
        turnId: "turn-2",
      },
    ];

    expect(assistantPhaseForDisplay(items[0]!, items)).toBe("commentary");
    expect(assistantPhaseForDisplay(items[1]!, items)).toBe("final_answer");
    expect(assistantPhaseForDisplay(items[2]!, items)).toBe("commentary");
  });

  it("keeps only the latest reasoning from the active turn after its latest user message", () => {
    const items: ConversationItem[] = [
      { id: "old-user", kind: "user-message", text: "旧问题", turnId: "turn-old" },
      {
        id: "old-reasoning",
        kind: "reasoning-summary",
        text: "旧思考",
        turnId: "turn-old",
      },
      { id: "live-user", kind: "user-message", text: "新问题" },
      {
        id: "live-reasoning-1",
        kind: "reasoning-summary",
        text: "Planning the first step",
      },
      {
        id: "live-reasoning-2",
        kind: "reasoning-summary",
        text: "Inspecting files\nImplementing the final fix",
      },
    ];

    expect(latestActiveReasoning(items, "turn-live")?.id).toBe("live-reasoning-2");
    expect(latestReasoningText("Inspecting files\nImplementing the final fix")).toBe(
      "Implementing the final fix",
    );
    expect(latestReasoningText("**Planning state**")).toBe("Planning state");
    expect(latestReasoningText("__Reviewing changes__")).toBe("Reviewing changes");
    expect(currentLivePhase(items, "turn-live")).toEqual({
      kind: "reasoning",
      text: "正在思考",
    });
  });

  it("hides internal reasoning summaries while preserving Chinese progress commentary", () => {
    const items: ConversationItem[] = [
      { id: "user-start", kind: "user-message", text: "开始", turnId: "turn-live" },
      {
        id: "reasoning-before-steer",
        kind: "reasoning-summary",
        text: "Verifying read-only product status",
        turnId: "turn-live",
      },
      {
        id: "commentary-before-steer",
        kind: "assistant-message",
        phase: "commentary",
        text: "正在核对真实产品状态",
        turnId: "turn-live",
      },
      { id: "user-steer", kind: "user-message", text: "继续", turnId: "turn-live" },
      {
        id: "reasoning-after-steer-1",
        kind: "reasoning-summary",
        text: "Inspecting the current state",
        turnId: "turn-live",
      },
      {
        id: "command",
        kind: "tool",
        status: "complete",
        title: "运行命令",
        turnId: "turn-live",
      },
      {
        id: "reasoning-after-steer-2",
        kind: "reasoning-summary",
        text: "Implementing the current fix",
        turnId: "turn-live",
      },
      {
        id: "commentary-after-steer",
        kind: "assistant-message",
        phase: "commentary",
        text: "已经找到问题，正在验证修复",
        turnId: "turn-live",
      },
    ];

    expect(latestActiveReasoning(items, "turn-live")?.id).toBe("reasoning-after-steer-2");
    expect(conversationContentItems(items, "turn-live").map((item) => item.id)).toEqual([
      "user-start",
      "commentary-before-steer",
      "user-steer",
      "command",
      "commentary-after-steer",
    ]);
    expect(conversationContentItems(items).map((item) => item.id)).toEqual([
      "user-start",
      "commentary-before-steer",
      "user-steer",
      "command",
      "commentary-after-steer",
    ]);
  });

  it("uses the real running operation instead of claiming that every active turn is thinking", () => {
    const items: ConversationItem[] = [
      { id: "user", kind: "user-message", text: "修改文件" },
      { id: "reasoning", kind: "reasoning-summary", text: "先检查文件" },
      {
        change: "modified",
        id: "file",
        kind: "file-change",
        path: "src/app.ts",
        status: "inProgress",
      },
    ];

    expect(currentLivePhase(items, "turn-live")).toEqual({
      kind: "activity",
      text: "正在编辑文件",
    });
  });

  it("removes a stale phase as soon as the real operation finishes", () => {
    const items: ConversationItem[] = [
      { id: "user", kind: "user-message", text: "继续", turnId: "turn-live" },
      {
        id: "reasoning",
        kind: "reasoning-summary",
        text: "准备运行检查",
        turnId: "turn-live",
      },
      {
        id: "command",
        kind: "tool",
        status: "complete",
        title: "运行命令",
        turnId: "turn-live",
      },
    ];

    expect(currentLivePhase(items, "turn-live")).toBeUndefined();
    expect(
      currentLivePhase(
        items.map((item) =>
          item.id === "command" && item.kind === "tool" ? { ...item, status: "running" } : item,
        ),
        "turn-live",
      ),
    ).toEqual({
      kind: "activity",
      text: "正在运行命令",
    });
  });

  it("does not surface historical reasoning or invent thinking while a sent message is waiting", () => {
    const items: ConversationItem[] = [
      { id: "user", kind: "user-message", text: "问题", turnId: "turn-old" },
      {
        id: "reasoning",
        kind: "reasoning-summary",
        text: "历史思考",
        turnId: "turn-old",
      },
    ];

    expect(latestActiveReasoning(items, undefined)).toBeUndefined();
    expect(latestReasoningText(" \n ")).toBeUndefined();
    expect(currentLivePhase(items, undefined)).toBeUndefined();
    expect(
      currentLivePhase([{ id: "waiting", kind: "user-message", text: "已发送" }], "turn-live"),
    ).toBeUndefined();
    expect(
      currentLivePhase(
        [
          { id: "turn-user", kind: "user-message", text: "开始", turnId: "turn-live" },
          {
            id: "stale-same-turn-reasoning",
            kind: "reasoning-summary",
            text: "Verifying read-only product status",
            turnId: "turn-live",
          },
          { id: "turn-steer", kind: "user-message", text: "继续", turnId: "turn-live" },
        ],
        "turn-live",
      ),
    ).toBeUndefined();
  });

  it("keeps Chinese commentary after a turn completes together with the final answer", () => {
    const items: ConversationItem[] = [
      {
        id: "commentary-1",
        kind: "assistant-message",
        phase: "commentary",
        text: "Planning state",
        turnId: "turn-1",
      },
      {
        id: "commentary-2",
        kind: "assistant-message",
        phase: "commentary",
        text: "Implementing",
        turnId: "turn-1",
      },
      {
        id: "final",
        kind: "assistant-message",
        phase: "final_answer",
        text: "最终回答",
        turnId: "turn-1",
      },
    ];

    expect(conversationContentItems(items).map((item) => item.id)).toEqual([
      "commentary-1",
      "commentary-2",
      "final",
    ]);
    expect(currentLivePhase(items, undefined)).toBeUndefined();
  });

  it("keeps commentary as visible work and removes every internal reasoning summary", () => {
    const items: ConversationItem[] = [
      { id: "user", kind: "user-message", text: "开始", turnId: "turn-live" },
      {
        id: "reasoning-1",
        kind: "reasoning-summary",
        text: "先检查现有状态",
        turnId: "turn-live",
      },
      {
        id: "commentary-1",
        kind: "assistant-message",
        phase: "commentary",
        text: "**Planning state**",
        turnId: "turn-live",
      },
      {
        id: "commentary-2",
        kind: "assistant-message",
        phase: "commentary",
        text: "Inspecting\n**Implementing**",
        turnId: "turn-live",
      },
      {
        id: "reasoning-2",
        kind: "reasoning-summary",
        text: "再实现修复",
        turnId: "turn-live",
      },
      {
        id: "plan",
        kind: "plan-progress",
        steps: [{ status: "inProgress", text: "执行实现" }],
        turnId: "turn-live",
      },
    ];

    expect(conversationContentItems(items, "turn-live").map((item) => item.id)).toEqual([
      "user",
      "commentary-1",
      "commentary-2",
    ]);
    expect(conversationContentItems(items).map((item) => item.id)).toEqual([
      "user",
      "commentary-1",
      "commentary-2",
    ]);
    expect(latestPlanProgress(items)?.id).toBe("plan");
    expect(currentLivePhase(items, "turn-live")).toBeUndefined();
  });

  it("keeps the latest authoritative plan for the composer and treats an empty update as removal", () => {
    const steps: Extract<ConversationItem, { kind: "plan-progress" }>["steps"] = [
      { status: "completed", text: "读取需求" },
      { status: "inProgress", text: "实现界面" },
    ];
    const items: ConversationItem[] = [
      { id: "plan-old", kind: "plan-progress", steps },
      { id: "answer", kind: "assistant-message", text: "继续处理中" },
      { id: "plan-live", kind: "plan-progress", steps },
    ];

    expect(latestPlanProgress(items)?.id).toBe("plan-live");
    expect(conversationContentItems(items).map((item) => item.id)).toEqual(["answer"]);
    expect(
      latestPlanProgress([...items, { id: "plan-cleared", kind: "plan-progress", steps: [] }]),
    ).toBeUndefined();
  });

  it("keeps answered questions and the formal plan while removing only a duplicate plan envelope", () => {
    const items: ConversationItem[] = [
      {
        id: "question-1",
        kind: "interaction-record",
        interaction: "question",
        status: "answered",
        title: "Codex 提出了问题",
        turnId: "turn-plan",
        questions: [
          {
            id: "choice",
            header: "选择",
            isSecret: false,
            question: "采用哪个方案？",
            answers: ["方案 A"],
          },
        ],
      },
      {
        id: "formal-plan",
        kind: "formal-plan",
        text: "# 方案 A\n\n1. 验证",
        turnId: "turn-plan",
      },
      {
        id: "duplicate-envelope",
        kind: "assistant-message",
        phase: "final_answer",
        text: "<proposed_plan>\n# 方案 A\n\n1. 验证\n</proposed_plan>",
        turnId: "turn-plan",
      },
    ];

    expect(conversationContentItems(items).map((item) => item.id)).toEqual([
      "question-1",
      "formal-plan",
    ]);
  });

  it("preserves commentary output without repeating it as a live phase", () => {
    const items: ConversationItem[] = [
      { id: "user", kind: "user-message", text: "开始", turnId: "turn-live" },
      {
        id: "commentary",
        kind: "assistant-message",
        phase: "commentary",
        text: "正在核对真实状态",
        turnId: "turn-live",
      },
    ];

    expect(conversationContentItems(items, "turn-live").map((item) => item.id)).toEqual([
      "user",
      "commentary",
    ]);
    expect(currentLivePhase(items, "turn-live")).toBeUndefined();
  });
});
