import type {
  ApprovalRequest,
  CapabilityState,
  CollaborationModeOption,
  ModelOption,
  PermissionProfileOption,
  ProductCapabilities,
  QueuedTurnItem,
  ThreadDetail,
  ThreadGoal,
  ThreadSettingsInput,
} from "@codex-local-remote/contracts";

export type { PermissionProfileOption, ThreadGoal, ThreadSettingsInput };

export type ComposerFeature =
  | "queue"
  | "settings"
  | "goal"
  | "plan"
  | "compact"
  | "permissionProfiles"
  | "serviceTiers"
  | "inlineApprovals";

export type ComposerCapabilities = ProductCapabilities | Record<string, unknown>;
export type ComposerDeliveryDecision = "queue" | "start" | "steer" | "synchronize";

const featureAliases: Readonly<Record<ComposerFeature, readonly string[]>> = {
  queue: ["queue", "remoteQueue", "remoteOwnedQueue"],
  settings: ["settingsUpdate", "threadSettings", "threadSettingsUpdate"],
  goal: ["goal", "goals", "threadGoal", "threadGoals"],
  plan: ["collaborationModes", "collaborationMode"],
  compact: ["contextCompaction", "compact"],
  permissionProfiles: ["permissionProfiles", "permissionProfile"],
  serviceTiers: ["serviceTiers", "speedTiers"],
  inlineApprovals: ["inlineApprovals", "approvals"],
};

export function composerCapabilityState(
  capabilities: ComposerCapabilities | undefined,
  feature: ComposerFeature,
): CapabilityState {
  if (!capabilities) return "unavailable";
  const capabilityRecord = capabilities as Record<string, unknown>;
  for (const alias of featureAliases[feature]) {
    const raw = capabilityRecord[alias];
    if (raw === "available" || raw === "degraded" || raw === "unavailable") {
      return raw;
    }
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const state = (raw as { state?: unknown }).state;
      if (state === "available" || state === "degraded" || state === "unavailable") {
        return state;
      }
    }
  }
  return "unavailable";
}

export function composerFeatureSupported(
  capabilities: ComposerCapabilities | undefined,
  feature: ComposerFeature,
): boolean {
  return composerCapabilityState(capabilities, feature) === "available";
}

export function composerDeliveryDecision(
  thread: Pick<ThreadDetail, "activeTurnId" | "availableActions" | "state">,
  mode: "queue" | "steer",
  queueSupported: boolean,
): ComposerDeliveryDecision {
  const active =
    thread.activeTurnId !== undefined ||
    thread.state === "running" ||
    thread.state === "waiting-for-approval";
  if (active) {
    if (mode === "queue" && queueSupported) return "queue";
    if (thread.activeTurnId && thread.availableActions.steer) return "steer";
    return "synchronize";
  }
  return thread.availableActions.reply ? "start" : "synchronize";
}

export function serviceTierSetting(
  capabilities: ComposerCapabilities | undefined,
  value: string | undefined,
): { serviceTier?: string };
export function serviceTierSetting(
  capabilities: ComposerCapabilities | undefined,
  value: null,
): { serviceTier?: null };
export function serviceTierSetting(
  capabilities: ComposerCapabilities | undefined,
  value: string | null | undefined,
): { serviceTier?: string | null } {
  if (!composerFeatureSupported(capabilities, "serviceTiers") || value === undefined) {
    return {};
  }
  return { serviceTier: value };
}

export function collaborationModeSetting(
  capabilities: ComposerCapabilities | undefined,
  modes: readonly CollaborationModeOption[],
  value: string | undefined,
  options: { includeDefault?: boolean } = {},
): { collaborationMode?: string } {
  if (
    !value ||
    !composerFeatureSupported(capabilities, "plan") ||
    !modes.some((mode) => mode.id === value && mode.available) ||
    (!options.includeDefault && value.trim().toLowerCase() === "default")
  ) {
    return {};
  }
  return { collaborationMode: value };
}

export function modelComposerLabel(displayName: string): string {
  const original = displayName.trim();
  if (!original) return "模型";
  const compact = original
    .replace(/^OpenAI[\s_-]*/iu, "")
    .replace(/[_-]+/gu, " ")
    .replace(/^GPT\s*/iu, "")
    .replace(/\bCodex\b/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return compact || original;
}

export type ServiceTierOption = {
  id: string;
  label: string;
  description?: string;
};

export type ServiceTierChoice = {
  id: string | null;
  label: string;
  description?: string;
};

export const CODEX_DEFAULT_SERVICE_TIER: ServiceTierChoice = {
  id: null,
  label: "标准",
  description: "按 Codex 的标准速度运行，不启用额外加速",
};

function isStandardTier(option: ServiceTierOption): boolean {
  return /^(?:default|normal|standard)$/iu.test(option.id.trim());
}

function asTierOption(value: unknown): ServiceTierOption | undefined {
  if (typeof value === "string" && value.trim()) {
    const id = value.trim();
    return { id, label: /^fast$/iu.test(id) ? "Fast" : id };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id =
    typeof record.id === "string"
      ? record.id.trim()
      : typeof record.value === "string"
        ? record.value.trim()
        : "";
  if (!id) return undefined;
  const label = [record.displayName, record.label, record.name].find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0,
  );
  const description =
    typeof record.description === "string" && record.description.trim()
      ? record.description.trim()
      : undefined;
  return {
    id,
    label: label?.trim() ?? (/^fast$/iu.test(id) ? "Fast" : id),
    ...(description ? { description } : {}),
  };
}

export function serviceTierOptions(model: ModelOption | undefined): ServiceTierOption[] {
  if (!model) return [];
  const record = model as ModelOption & {
    serviceTiers?: unknown;
    additionalSpeedTiers?: unknown;
  };
  const result: ServiceTierOption[] = [];
  const seen = new Set<string>();
  for (const collection of [record.serviceTiers, record.additionalSpeedTiers]) {
    if (!Array.isArray(collection)) continue;
    for (const raw of collection) {
      const option = asTierOption(raw);
      if (!option || isStandardTier(option) || seen.has(option.id)) continue;
      seen.add(option.id);
      result.push(option);
    }
  }
  return result;
}

export function serviceTierChoices(model: ModelOption | undefined): ServiceTierChoice[] {
  return [CODEX_DEFAULT_SERVICE_TIER, ...serviceTierOptions(model)];
}

export function serviceTierDisplayLabel(value: string | null | undefined): string {
  const normalized = value?.trim() ?? "";
  if (!normalized || /^(?:default|normal|standard)$/iu.test(normalized)) {
    return CODEX_DEFAULT_SERVICE_TIER.label;
  }
  return /^fast$/iu.test(normalized) ? "Fast" : normalized;
}

export function moveQueueItem(
  queue: readonly QueuedTurnItem[],
  id: string,
  offset: -1 | 1,
): QueuedTurnItem[] {
  const index = queue.findIndex((item) => item.id === id);
  if (index < 0) return [...queue];
  const target = index + offset;
  if (target < 0 || target >= queue.length) return [...queue];
  const next = [...queue];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next.map((item, position) => ({ ...item, position }));
}

export function filterThreadApprovals(
  approvals: readonly ApprovalRequest[],
  threadId: string,
  activeTurnId?: string,
): ApprovalRequest[] {
  return approvals
    .filter((approval) => approval.threadId === threadId)
    .sort((left, right) => {
      const leftCurrent = activeTurnId !== undefined && left.turnId === activeTurnId ? 0 : 1;
      const rightCurrent = activeTurnId !== undefined && right.turnId === activeTurnId ? 0 : 1;
      return leftCurrent - rightCurrent;
    });
}

export type ComposerToolAction = {
  id: "attach" | "goal" | "plan" | "compact";
  label: string;
  description: string;
  disabled?: boolean;
};

export function composerToolActions(input: {
  capabilities: ComposerCapabilities | undefined;
  hasCollaborationModes: boolean;
  canCompact: boolean;
  canAttach: boolean;
}): ComposerToolAction[] {
  const result: ComposerToolAction[] = [];
  if (input.canAttach) {
    result.push({
      id: "attach",
      label: "添加文件",
      description: "从此设备上传，或选择电脑已有文件",
    });
  }
  if (composerFeatureSupported(input.capabilities, "goal")) {
    result.push({
      id: "goal",
      label: "任务目标",
      description: "为这个对话设置持续目标",
    });
  }
  if (input.hasCollaborationModes && composerFeatureSupported(input.capabilities, "plan")) {
    result.push({
      id: "plan",
      label: "计划模式",
      description: "选择下一轮的协作方式",
    });
  }
  if (composerFeatureSupported(input.capabilities, "compact")) {
    result.push({
      id: "compact",
      label: "压缩上下文",
      description: input.canCompact ? "释放上下文空间后继续" : "当前回复结束后可用",
      ...(!input.canCompact ? { disabled: true } : {}),
    });
  }
  return result;
}
