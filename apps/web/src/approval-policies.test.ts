import { describe, expect, it } from "vitest";

import {
  approvalPolicyDescription,
  approvalPolicyLabel,
  chooseApprovalPolicy,
} from "./approval-policies";

describe("approval policies", () => {
  it("keeps future runtime values visible and selects only advertised values", () => {
    const options = [{ id: "future-policy" }, { id: "on-request" }];
    expect(chooseApprovalPolicy(options, "future-policy")).toBe("future-policy");
    expect(chooseApprovalPolicy(options, "not-advertised")).toBe("on-request");
    expect(approvalPolicyLabel("future-policy")).toBe("future-policy");
  });

  it("用人话解释何时会停下来询问", () => {
    expect(approvalPolicyLabel("never")).toBe("自动允许，不再询问");
    expect(approvalPolicyDescription("on-request")).toContain("有风险");
    expect(approvalPolicyLabel("untrusted")).toBe("每次都询问我");
  });
});
