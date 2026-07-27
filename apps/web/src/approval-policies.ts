import type { ApprovalPolicyOption } from "@codex-local-remote/contracts";

const LABELS: Readonly<Record<string, string>> = {
  never: "自动允许，不再询问",
  "on-request": "仅在需要时询问我",
  untrusted: "每次都询问我",
};

const DESCRIPTIONS: Readonly<Record<string, string>> = {
  never: "Codex 不会停下来等待你的确认。",
  "on-request": "遇到可能有风险的操作时停下来询问你。",
  untrusted: "每个需要授权的操作都等你确认。",
};

export function approvalPolicyLabel(id: string): string {
  return LABELS[id] ?? id;
}

export function approvalPolicyDescription(id: string): string {
  return DESCRIPTIONS[id] ?? `由当前 Codex 运行时提供：${id}`;
}

export function chooseApprovalPolicy(
  options: readonly ApprovalPolicyOption[],
  preferred?: string | null,
): string {
  if (preferred && options.some((option) => option.id === preferred)) {
    return preferred;
  }
  return options.find((option) => option.id === "on-request")?.id ?? options[0]?.id ?? "";
}
