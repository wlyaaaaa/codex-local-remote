import type { ThreadDetail, ThreadSettingsInput } from "@codex-local-remote/contracts";
import { describe, expect, it } from "vitest";

import {
  rejectedApprovalReviewerId,
  threadSettingsReadbackMismatches,
} from "./thread-settings-readback";

const detail: ThreadDetail = {
  id: "thread-settings",
  title: "设置回读",
  mode: "managed",
  state: "running",
  updatedAt: "2026-07-28T10:00:00.000Z",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  serviceTier: "standard",
  permissionProfileId: "full-access",
  approvalPolicy: "on-request",
  approvalsReviewer: "auto_review",
  collaborationMode: "default",
  items: [],
  availableActions: {
    steer: true,
    interrupt: true,
    reply: false,
    changeModelNextTurn: true,
    updateSettings: true,
  },
};

describe("thread settings authoritative readback", () => {
  it("只核对本次实际提交的字段", () => {
    const requested: ThreadSettingsInput = {
      permissionProfileId: "full-access",
      approvalPolicy: "on-request",
    };

    expect(threadSettingsReadbackMismatches(requested, detail)).toEqual([]);
  });

  it("明确指出运行时没有接受的动态选项", () => {
    const requested: ThreadSettingsInput = {
      approvalsReviewer: "guardian_subagent",
      collaborationMode: "plan",
    };

    expect(threadSettingsReadbackMismatches(requested, detail)).toEqual(["审批方式", "协作模式"]);
  });

  it("把 null 与权威快照中的缺省值视为同一个清除结果", () => {
    const { serviceTier: _serviceTier, ...withoutServiceTier } = detail;
    expect(threadSettingsReadbackMismatches({ serviceTier: null }, withoutServiceTier)).toEqual([]);
  });

  it("只隔离运行时明确拒绝的审批人，不隐藏已经真实回读的动态审批人", () => {
    expect(rejectedApprovalReviewerId({ approvalsReviewer: "guardian_subagent" }, detail)).toBe(
      "guardian_subagent",
    );
    expect(
      rejectedApprovalReviewerId({ approvalsReviewer: "auto_review" }, detail),
    ).toBeUndefined();
    expect(rejectedApprovalReviewerId({}, detail)).toBeUndefined();
  });
});
