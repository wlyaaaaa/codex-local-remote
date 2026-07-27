import type { ModelOption, ReasoningEffort } from "@codex-local-remote/contracts";

export function normalizeReasoningEffortForModel(
  model: ModelOption | undefined,
  current: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  if (!model) return undefined;
  if (current !== undefined && model.supportedReasoningEfforts.includes(current)) return current;
  const defaultEffort = model.defaultReasoningEffort;
  if (defaultEffort && model.supportedReasoningEfforts.includes(defaultEffort)) {
    return defaultEffort;
  }
  return model.supportedReasoningEfforts[0];
}

export function defaultReasoningEffortForModel(
  model: ModelOption | undefined,
): ReasoningEffort | undefined {
  if (!model) return undefined;
  const defaultEffort = model.defaultReasoningEffort;
  if (defaultEffort && model.supportedReasoningEfforts.includes(defaultEffort)) {
    return defaultEffort;
  }
  return model.supportedReasoningEfforts[0];
}

export function normalizeReasoningEffort(
  models: ModelOption[],
  modelId: string,
  current: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  return normalizeReasoningEffortForModel(
    models.find((model) => model.id === modelId) ?? models[0],
    current,
  );
}
