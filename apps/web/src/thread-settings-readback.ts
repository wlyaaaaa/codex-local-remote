import type { ThreadDetail, ThreadSettingsInput } from "@codex-local-remote/contracts";

const settingLabels = {
  model: "模型",
  reasoningEffort: "思考等级",
  serviceTier: "速度",
  permissionProfileId: "文件与命令权限",
  approvalPolicy: "确认时机",
  approvalsReviewer: "审批方式",
  collaborationMode: "协作模式",
} satisfies Record<keyof ThreadSettingsInput, string>;

const settingKeys = Object.keys(settingLabels) as Array<keyof ThreadSettingsInput>;

function normalizedSetting(value: string | null | undefined): string | undefined {
  return value === null || value === "" ? undefined : value;
}

export function threadSettingsReadbackMismatches(
  requested: ThreadSettingsInput,
  authoritative: ThreadDetail,
): string[] {
  return settingKeys.flatMap((key) => {
    if (requested[key] === undefined) return [];
    return normalizedSetting(requested[key]) === normalizedSetting(authoritative[key])
      ? []
      : [settingLabels[key]];
  });
}

export function rejectedApprovalReviewerId(
  requested: ThreadSettingsInput,
  authoritative: ThreadDetail,
): string | undefined {
  const requestedReviewer = normalizedSetting(requested.approvalsReviewer);
  if (
    !requestedReviewer ||
    requestedReviewer === normalizedSetting(authoritative.approvalsReviewer)
  ) {
    return undefined;
  }
  return requestedReviewer;
}
