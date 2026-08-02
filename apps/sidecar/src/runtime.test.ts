import { describe, expect, it, vi } from "vitest";

import type { SidecarConfig } from "./config.js";
import type { BrokerDesktopHealth } from "./broker-desktop-health.js";
import type { DesktopRuntimeHealth } from "./desktop-runtime-health.js";
import {
  createSharedAppServerSupervisorOptions,
  createDiagnostics,
  createSharedThreadReconnectHandler,
  isSidecarRequestReady,
  persistedConversationHistoryIntegrity,
  runtimeConnectionHealthChanged,
} from "./runtime.js";
import type { SidecarStateStore } from "./state-store.js";

const config: SidecarConfig = {
  appServerUrl: "ws://127.0.0.1:18791",
  basePath: "/codex-remote",
  dataDir: "C:\\fixture\\data",
  desktopSyncEnabled: true,
  host: "127.0.0.1",
  port: 18_790,
  webDir: "C:\\fixture\\web",
};

const stateWithoutProjects = {
  listProjects: () => [],
} as unknown as SidecarStateStore;

describe("persistedConversationHistoryIntegrity", () => {
  it.each(["invalid-json", "unterminated-line"] as const)(
    "maps %s reader diagnostics to precise partial history integrity",
    (reason) => {
      expect(
        persistedConversationHistoryIntegrity("complete", 2, {
          capturedBytes: "128",
          processedBytes: "128",
          reason,
          skippedItems: 0,
          skippedLines: 1,
          status: "truncated",
        }),
      ).toEqual({
        observedCount: 2,
        reason,
        scope: "complete",
        status: "partial",
      });
    },
  );

  it("fails closed when a persisted-history diagnostic is unavailable", () => {
    expect(persistedConversationHistoryIntegrity("complete", 0, undefined)).toEqual({
      observedCount: 0,
      reason: "diagnostic-unavailable",
      scope: "complete",
      status: "failed",
    });
  });
});

describe("createSharedAppServerSupervisorOptions", () => {
  it("gives Desktop capability probes a bounded recovery window during loaded-thread backfill", () => {
    expect(createSharedAppServerSupervisorOptions("ws://127.0.0.1:18791/ws/capability")).toEqual({
      clientVersion: "0.1.4",
      endpoint: "ws://127.0.0.1:18791/ws/capability",
      maxFrameBytes: 128 * 1024 * 1024,
      mode: "shared-websocket",
      probeTimeoutMs: 30_000,
    });
  });
});

describe("createSharedThreadReconnectHandler", () => {
  it("resubscribes once on the initial running transition and once after reconnect", async () => {
    const releaseInitial = Promise.withResolvers<void>();
    const resubscribe = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(async () => {
        await releaseInitial.promise;
      })
      .mockResolvedValue(undefined);
    const handleRunningState = createSharedThreadReconnectHandler(resubscribe);

    expect(handleRunningState(false)).toBeUndefined();
    const initial = handleRunningState(true);
    expect(handleRunningState(true)).toBeUndefined();
    expect(resubscribe).toHaveBeenCalledTimes(1);

    expect(handleRunningState(false)).toBeUndefined();
    const reconnect = handleRunningState(true);
    expect(handleRunningState(true)).toBeUndefined();
    expect(resubscribe).toHaveBeenCalledTimes(1);

    releaseInitial.resolve();
    await expect(initial).resolves.toBeUndefined();
    await expect(reconnect).resolves.toBeUndefined();
    expect(resubscribe).toHaveBeenCalledTimes(2);
  });
});

describe("isSidecarRequestReady", () => {
  const snapshot = {
    capabilities: {
      account: { state: "available" as const },
      collaborationModes: { state: "available" as const },
      models: { state: "available" as const },
      permissions: { state: "available" as const },
      rateLimits: { state: "available" as const },
      threadList: { state: "available" as const },
      usage: { state: "available" as const },
    },
    diagnostics: [],
    mode: "shared-websocket" as const,
    restartAttempt: 0,
    runtimeFailureCount: 0,
    state: "running" as const,
  };

  it("accepts verified startup transition, a still-probed update, and steady state", () => {
    expect(
      isSidecarRequestReady(
        snapshot,
        { state: "starting", warning: "启动中" },
        { state: "current" },
      ),
    ).toBe(true);
    expect(
      isSidecarRequestReady(
        snapshot,
        { state: "update-pending", warning: "更新待切换" },
        { state: "current" },
      ),
    ).toBe(true);
    expect(
      isSidecarRequestReady(
        snapshot,
        { state: "runtime-check-blocked", warning: "启动回执暂时无法确认" },
        { state: "current" },
      ),
    ).toBe(true);
    expect(
      isSidecarRequestReady(
        snapshot,
        { state: "current" },
        { state: "application-degraded", warning: "历史任务正在后台恢复" },
      ),
    ).toBe(true);
    expect(isSidecarRequestReady(snapshot, { state: "current" }, { state: "current" })).toBe(true);
  });

  it("fails closed when neither the startup receipt nor the live Broker can prove the connection", () => {
    expect(
      isSidecarRequestReady(
        snapshot,
        { state: "runtime-check-blocked", warning: "无法验证更新" },
        { state: "degraded", warning: "断开" },
      ),
    ).toBe(false);
    expect(
      isSidecarRequestReady(snapshot, { state: "current" }, { state: "degraded", warning: "断开" }),
    ).toBe(false);
    expect(
      isSidecarRequestReady(
        {
          ...snapshot,
          capabilities: {
            ...snapshot.capabilities,
            models: { reason: "probe-failed" as const, state: "degraded" as const },
          },
        },
        { state: "current" },
        { state: "current" },
      ),
    ).toBe(false);
    expect(
      isSidecarRequestReady(
        {
          ...snapshot,
          capabilities: {
            ...snapshot.capabilities,
            threadList: { reason: "method-not-supported" as const, state: "unavailable" as const },
          },
        },
        { state: "current" },
        { state: "current" },
      ),
    ).toBe(false);
    expect(
      isSidecarRequestReady(
        { ...snapshot, state: "degraded" },
        { state: "current" },
        { state: "current" },
      ),
    ).toBe(false);
  });
});

describe("createDiagnostics", () => {
  it("publishes runtime-probed capabilities without a Codex version gate", () => {
    const diagnostics = createDiagnostics(
      config,
      {
        capabilities: {
          account: { state: "available" },
          approvalReviewers: { state: "available" },
          collaborationModes: { state: "available" },
          compact: { state: "available" },
          goals: { state: "available" },
          models: { state: "available" },
          permissions: { reason: "method-not-supported", state: "unavailable" },
          rateLimits: { reason: "method-not-supported", state: "unavailable" },
          serviceTiers: { reason: "not-advertised", state: "unavailable" },
          settingsUpdate: { reason: "method-not-supported", state: "unavailable" },
          threadList: { state: "available" },
          usage: { state: "available" },
        },
        diagnostics: [],
        mode: "shared-websocket",
        restartAttempt: 0,
        runtimeFailureCount: 0,
        state: "running",
        userAgent: "codex-cli 9999.0.0-future",
      },
      false,
      stateWithoutProjects,
    );

    expect(diagnostics.capabilities).toMatchObject({
      appServer: "available",
      approvalReviewers: "available",
      collaborationModes: "available",
      compact: "available",
      goals: "available",
      inlineApprovals: "available",
      liveEvents: "available",
      permissionProfiles: "unavailable",
      queue: "available",
      serviceTiers: "unavailable",
      settingsUpdate: "unavailable",
      subagents: "available",
      usage: "available",
    });
    expect(diagnostics.appServerVersion).toBe("9999.0.0-future");
  });

  it("uses dynamically generated client methods when destructive capability probes are inconclusive", () => {
    const diagnostics = createDiagnostics(
      config,
      {
        capabilities: {
          account: { state: "available" },
          approvalReviewers: { state: "available" },
          collaborationModes: { state: "available" },
          compact: { reason: "method-not-supported", state: "unavailable" },
          goals: { reason: "method-not-supported", state: "unavailable" },
          models: { state: "available" },
          permissions: { state: "available" },
          rateLimits: { state: "available" },
          serviceTiers: { state: "available" },
          settingsUpdate: { reason: "method-not-supported", state: "unavailable" },
          threadList: { state: "available" },
          usage: { state: "available" },
        },
        diagnostics: [],
        mode: "shared-websocket",
        restartAttempt: 0,
        runtimeFailureCount: 0,
        state: "running",
      },
      false,
      stateWithoutProjects,
      { state: "current" },
      { state: "current" },
      {
        approvalPolicies: [],
        approvalReviewers: [],
        clientMethods: [
          "thread/compact/start",
          "thread/goal/get",
          "thread/goal/set",
          "thread/goal/clear",
          "thread/settings/update",
        ],
        serverRequestDecisionFallbacks: {},
      },
    );

    expect(diagnostics.capabilities).toMatchObject({
      compact: "available",
      goals: "available",
      settingsUpdate: "available",
    });
  });

  it("keeps the durable queue visible while backend-only controls report degraded", () => {
    const diagnostics = createDiagnostics(
      config,
      {
        diagnostics: [],
        mode: "shared-websocket",
        restartAttempt: 1,
        runtimeFailureCount: 0,
        state: "degraded",
      },
      false,
      stateWithoutProjects,
    );

    expect(diagnostics.capabilities).toMatchObject({
      approvalReviewers: "degraded",
      collaborationModes: "degraded",
      compact: "degraded",
      goals: "degraded",
      inlineApprovals: "degraded",
      liveEvents: "degraded",
      permissionProfiles: "degraded",
      queue: "available",
      serviceTiers: "degraded",
      settingsUpdate: "degraded",
    });
  });

  it.each([
    {
      appServer: "available",
      health: {
        state: "update-pending",
        warning: "Codex Desktop 已更新；当前实时能力探针通过，可继续使用。",
      } satisfies DesktopRuntimeHealth,
    },
    {
      appServer: "available",
      health: {
        state: "runtime-check-blocked",
        warning: "无法确认 Codex Desktop 更新兼容性",
      } satisfies DesktopRuntimeHealth,
    },
    {
      appServer: "degraded",
      health: {
        state: "invalid",
        warning: "Codex Desktop 启动健康回执无效，远程控制已标记为降级。",
      } satisfies DesktopRuntimeHealth,
    },
    {
      appServer: "available",
      health: { state: "current" } satisfies DesktopRuntimeHealth,
    },
    {
      appServer: "degraded",
      health: {
        state: "missing",
        warning: "Codex Desktop 启动健康回执缺失，远程控制已标记为降级。",
      } satisfies DesktopRuntimeHealth,
    },
    {
      appServer: "degraded",
      health: {
        state: "starting",
        warning: "Codex Desktop 受管连接正在启动，远程控制暂不可用。",
      } satisfies DesktopRuntimeHealth,
    },
  ])("projects receipt state $health.state into app-server health", ({ appServer, health }) => {
    const diagnostics = createDiagnostics(
      config,
      {
        diagnostics: [],
        mode: "shared-websocket",
        restartAttempt: 0,
        runtimeFailureCount: 0,
        state: "running",
      },
      false,
      stateWithoutProjects,
      health,
    );

    expect(diagnostics.capabilities.appServer).toBe(appServer);
    if (health.warning) {
      expect(diagnostics.warnings).toContain(health.warning);
    }
  });

  it("does not let a stale startup receipt override a real Broker disconnect", () => {
    const diagnostics = createDiagnostics(
      config,
      {
        diagnostics: [],
        mode: "shared-websocket",
        restartAttempt: 0,
        runtimeFailureCount: 0,
        state: "running",
      },
      false,
      stateWithoutProjects,
      { state: "runtime-check-blocked", warning: "启动回执暂时无法确认" },
      { state: "degraded", warning: "实时 Broker 已断开" },
    );

    expect(diagnostics.capabilities.appServer).toBe("degraded");
  });

  it("keeps core app-server controls available during exact-identity application backfill", () => {
    const diagnostics = createDiagnostics(
      config,
      {
        capabilities: {
          account: { state: "available" },
          collaborationModes: { state: "available" },
          models: { state: "available" },
          permissions: { state: "available" },
          rateLimits: { state: "available" },
          threadList: { state: "available" },
          usage: { state: "available" },
        },
        diagnostics: [],
        mode: "shared-websocket",
        restartAttempt: 0,
        runtimeFailureCount: 0,
        state: "running",
      },
      false,
      stateWithoutProjects,
      { state: "current" },
      { state: "application-degraded", warning: "历史任务正在后台恢复" },
    );

    expect(diagnostics.capabilities.appServer).toBe("available");
    expect(diagnostics.warnings).toContain("历史任务正在后台恢复");
  });
});

describe("runtimeConnectionHealthChanged", () => {
  const currentDesktop = { state: "current" } satisfies DesktopRuntimeHealth;
  const currentBroker = { state: "current" } satisfies BrokerDesktopHealth;

  it("reports a Desktop or Broker transition so Web clients refresh immediately", () => {
    expect(
      runtimeConnectionHealthChanged(currentDesktop, currentBroker, currentDesktop, {
        state: "degraded",
        warning: "Desktop disconnected",
      }),
    ).toBe(true);
    expect(
      runtimeConnectionHealthChanged(
        currentDesktop,
        currentBroker,
        {
          state: "update-pending",
          warning: "Desktop updated",
        },
        currentBroker,
      ),
    ).toBe(true);
  });

  it("does not generate a refresh event for an unchanged health snapshot", () => {
    expect(
      runtimeConnectionHealthChanged(
        currentDesktop,
        { state: "degraded", warning: "same" },
        currentDesktop,
        { state: "degraded", warning: "same" },
      ),
    ).toBe(false);
  });
});
