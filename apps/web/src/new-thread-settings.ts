import type {
  CollaborationModeOption,
  CreateThreadInput,
  ModelOption,
  PermissionProfileOption,
  ReasoningEffort,
} from "@codex-local-remote/contracts";
import { serviceTierOptions } from "./composer-product";
import { normalizeReasoningEffort } from "./model-effort";

export function choosePermissionProfileId(
  profiles: readonly PermissionProfileOption[],
  current?: string,
): string | undefined {
  if (current && profiles.some((profile) => profile.id === current && profile.allowed)) {
    return current;
  }
  return profiles.find((profile) => profile.allowed)?.id;
}

export function chooseServiceTier(
  model: ModelOption | undefined,
  current?: string | null,
): string | undefined {
  const tiers = serviceTierOptions(model);
  if (current && tiers.some((tier) => tier.id === current)) return current;
  return undefined;
}

export function chooseCollaborationMode(
  modes: readonly CollaborationModeOption[],
  current?: string,
): string | undefined {
  if (current && modes.some((mode) => mode.id === current && mode.available)) return current;
  const available = modes.filter((mode) => mode.available);
  const normalized = (value: string) => value.trim().toLowerCase();
  const standard = available.find((mode) => {
    const id = normalized(mode.id);
    const label = normalized(mode.displayName);
    return (
      id === "default" ||
      id === "standard" ||
      id === "normal" ||
      id === "auto" ||
      label === "默认" ||
      label === "标准" ||
      label === "default" ||
      label === "standard"
    );
  });
  if (standard) return standard.id;
  return available.find((mode) => {
    const signature = `${normalized(mode.id)} ${normalized(mode.displayName)}`;
    return !signature.includes("plan") && !signature.includes("计划");
  })?.id;
}

export function newThreadRuntimeSettings(input: {
  models: ModelOption[];
  modelId: string;
  reasoningEffort: ReasoningEffort | undefined;
  permissionProfilesAvailable: boolean;
  permissionProfiles: readonly PermissionProfileOption[];
  permissionProfileId: string | undefined;
  serviceTiersAvailable: boolean;
  serviceTier: string | undefined;
  collaborationModes: readonly CollaborationModeOption[];
  collaborationMode: string | undefined;
}): Omit<CreateThreadInput, "prompt" | "projectId"> {
  const selectedModel =
    input.models.find((candidate) => candidate.id === input.modelId) ?? input.models[0];
  const reasoningEffort = normalizeReasoningEffort(
    input.models,
    input.modelId,
    input.reasoningEffort,
  );
  const permissionProfileId = input.permissionProfilesAvailable
    ? choosePermissionProfileId(input.permissionProfiles, input.permissionProfileId)
    : undefined;
  const serviceTier = input.serviceTiersAvailable
    ? chooseServiceTier(selectedModel, input.serviceTier)
    : undefined;
  const collaborationMode = chooseCollaborationMode(
    input.collaborationModes,
    input.collaborationMode,
  );

  return {
    ...(selectedModel ? { model: selectedModel.id } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(permissionProfileId ? { permissionProfileId } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(collaborationMode ? { collaborationMode } : {}),
  };
}
