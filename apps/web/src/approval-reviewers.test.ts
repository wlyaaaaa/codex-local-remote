import { describe, expect, it } from "vitest";

import {
  approvalReviewerDescription,
  approvalReviewerLabel,
  chooseApprovalReviewer,
} from "./approval-reviewers";

describe("approval reviewer product mapping", () => {
  it("chooses only ids actually advertised by the runtime", () => {
    const options = [{ id: "future-reviewer" }, { id: "user" }];

    expect(chooseApprovalReviewer(options, "user")).toBe("user");
    expect(chooseApprovalReviewer(options, "not-advertised")).toBe("future-reviewer");
    expect(chooseApprovalReviewer([], "user")).toBe("");
  });

  it("keeps unknown future reviewer ids visible verbatim", () => {
    expect(approvalReviewerLabel("future-reviewer-v9")).toBe("future-reviewer-v9");
    expect(approvalReviewerLabel("auto_review")).toBe("Codex 自动确认");
  });

  it("用人话解释谁会作出审批决定", () => {
    expect(approvalReviewerLabel("user")).toBe("我来确认");
    expect(approvalReviewerDescription("user")).toContain("手机");
    expect(approvalReviewerLabel("guardian_subagent")).toBe("安全智能体代我确认");
  });
});
