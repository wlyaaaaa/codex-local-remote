import type { ModelOption, ReasoningEffort } from "@codex-local-remote/contracts";

export function normalizeReasoningEffortForModel(
  model: ModelOption | undefined,
  current: ReasoningEffort,
): ReasoningEffort {
  if (!model) return current;
  if (model.supportedReasoningEfforts.includes(current)) return current;
  const defaultEffort = model.defaultReasoningEffort;
  if (defaultEffort && model.supportedReasoningEfforts.includes(defaultEffort)) {
    return defaultEffort;
  }
  return model.supportedReasoningEfforts[0] ?? current;
}

export function defaultReasoningEffortForModel(
  model: ModelOption | undefined,
  fallback: ReasoningEffort = "medium",
): ReasoningEffort {
  if (!model) return fallback;
  const defaultEffort = model.defaultReasoningEffort;
  if (defaultEffort && model.supportedReasoningEfforts.includes(defaultEffort)) {
    return defaultEffort;
  }
  return model.supportedReasoningEfforts[0] ?? fallback;
}

export function normalizeReasoningEffort(
  models: ModelOption[],
  modelId: string,
  current: ReasoningEffort,
): ReasoningEffort {
  return normalizeReasoningEffortForModel(
    models.find((model) => model.id === modelId) ?? models[0],
    current,
  );
}
