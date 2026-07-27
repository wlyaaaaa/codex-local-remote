import { describe, expect, it } from "vitest";
import { ApiRequestError } from "./api";
import { WORKSPACE_RECOVERY_RETRY_MS, workspaceLoadFailurePolicy } from "./workspace-recovery";

describe("工作区请求恢复策略", () => {
  it("401 立即回到登录，不把会话过期伪装成电脑离线", () => {
    expect(workspaceLoadFailurePolicy(new ApiRequestError("登录已过期", 401), true)).toEqual({
      kind: "authentication",
      preserveSnapshot: false,
      retryAfterMs: undefined,
    });
  });

  it.each([0, 502, 503, 504])("状态 %s 会自动重试，并在已有快照时保留当前界面", (status) => {
    expect(workspaceLoadFailurePolicy(new ApiRequestError("暂时不可用", status), true)).toEqual({
      kind: "transient",
      preserveSnapshot: true,
      retryAfterMs: WORKSPACE_RECOVERY_RETRY_MS,
    });
    expect(workspaceLoadFailurePolicy(new ApiRequestError("暂时不可用", status), false)).toEqual({
      kind: "transient",
      preserveSnapshot: false,
      retryAfterMs: WORKSPACE_RECOVERY_RETRY_MS,
    });
  });

  it("普通业务错误不进入快速无限重试", () => {
    expect(workspaceLoadFailurePolicy(new ApiRequestError("请求内容无效", 400), true)).toEqual({
      kind: "fatal",
      preserveSnapshot: true,
      retryAfterMs: undefined,
    });
  });
});
