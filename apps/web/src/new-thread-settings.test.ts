import { describe, expect, it } from "vitest";
import type {
  CollaborationModeOption,
  ModelOption,
  PermissionProfileOption,
} from "@codex-local-remote/contracts";
import {
  choosePermissionProfileId,
  chooseServiceTier,
  newThreadRuntimeSettings,
} from "./new-thread-settings";

const collaborationModes: CollaborationModeOption[] = [
  { id: "auto-next", displayName: "自动", available: true },
];

describe("新建任务运行时设置", () => {
  it("只透传运行时声明的未来权限、思考等级和速度档", () => {
    const models: ModelOption[] = [
      {
        id: "future-model",
        displayName: "Future model",
        supportedReasoningEfforts: ["deep-next"],
        defaultReasoningEffort: "deep-next",
        serviceTiers: [{ id: "burst-next", displayName: "Burst next" }],
        defaultServiceTier: "burst-next",
        isDefault: true,
      },
    ];
    const profiles: PermissionProfileOption[] = [
      { id: "future-guarded", description: "未来权限", allowed: true },
    ];

    expect(
      newThreadRuntimeSettings({
        models,
        modelId: "future-model",
        reasoningEffort: "deep-next",
        permissionProfilesAvailable: true,
        permissionProfiles: profiles,
        permissionProfileId: "future-guarded",
        serviceTiersAvailable: true,
        serviceTier: "burst-next",
        collaborationModes,
        collaborationMode: "auto-next",
      }),
    ).toEqual({
      model: "future-model",
      reasoningEffort: "deep-next",
      permissionProfileId: "future-guarded",
      serviceTier: "burst-next",
      collaborationMode: "auto-next",
    });
  });

  it("能力或模型未声明时不臆造 ask、medium 或速度档", () => {
    const settings = newThreadRuntimeSettings({
      models: [
        {
          id: "opaque-model",
          displayName: "Opaque",
          supportedReasoningEfforts: [],
          isDefault: true,
        },
      ],
      modelId: "opaque-model",
      reasoningEffort: undefined,
      permissionProfilesAvailable: false,
      permissionProfiles: [],
      permissionProfileId: "ask",
      serviceTiersAvailable: false,
      serviceTier: "fast",
      collaborationModes: [],
      collaborationMode: "auto",
    });

    expect(settings).toEqual({ model: "opaque-model" });
    expect(settings).not.toHaveProperty("permissionMode");
    expect(settings).not.toHaveProperty("permissionProfileId");
    expect(settings).not.toHaveProperty("reasoningEffort");
    expect(settings).not.toHaveProperty("serviceTier");
  });

  it("拒绝已禁用或未声明的选择并退回第一个真实可用值", () => {
    const profiles: PermissionProfileOption[] = [
      { id: "blocked", allowed: false },
      { id: "allowed-next", allowed: true },
    ];
    const model: ModelOption = {
      id: "model",
      displayName: "Model",
      supportedReasoningEfforts: ["low"],
      serviceTiers: [{ id: "standard-next", displayName: "Standard next" }],
      isDefault: true,
    };

    expect(choosePermissionProfileId(profiles, "blocked")).toBe("allowed-next");
    expect(chooseServiceTier(model, "invented-fast")).toBeUndefined();
  });

  it("标准速度不发送附加加速档，只有显式选择才透传", () => {
    const models: ModelOption[] = [
      {
        id: "model",
        displayName: "Model",
        supportedReasoningEfforts: ["low"],
        serviceTiers: [{ id: "fast", displayName: "Fast" }],
        defaultServiceTier: "fast",
        isDefault: true,
      },
    ];

    expect(
      newThreadRuntimeSettings({
        models,
        modelId: "model",
        reasoningEffort: "low",
        permissionProfilesAvailable: false,
        permissionProfiles: [],
        permissionProfileId: undefined,
        serviceTiersAvailable: true,
        serviceTier: undefined,
        collaborationModes: [],
        collaborationMode: undefined,
      }),
    ).toEqual({
      model: "model",
      reasoningEffort: "low",
    });
    expect(chooseServiceTier(models[0], undefined)).toBeUndefined();
    expect(chooseServiceTier(models[0], "fast")).toBe("fast");
  });
});
