import { AppServerSupervisor } from "@codex-local-remote/app-server-client";
import type {
  AppServerSupervisorSnapshot,
  CapabilitySupport,
} from "@codex-local-remote/app-server-client";
import type {
  CapabilityState,
  DiagnosticSnapshot,
  ProductCapabilities,
} from "@codex-local-remote/contracts";
import {
  ApprovalCoordinator,
  CodexDomainService,
  ProjectRegistry,
  RemoteEventBuffer,
} from "@codex-local-remote/domain";
import type { FastifyInstance } from "fastify";

import type { SidecarConfig } from "./config.js";
import { createSidecarServer } from "./server.js";
import { SidecarStateStore } from "./state-store.js";

const SIDECAR_VERSION = "0.1.0";

export interface RunningSidecar {
  app: FastifyInstance;
  config: SidecarConfig;
  diagnostics(): DiagnosticSnapshot;
  stop(): Promise<void>;
}

export async function startSidecar(config: SidecarConfig): Promise<RunningSidecar> {
  const state = await SidecarStateStore.open(config.dataDir);
  const events = new RemoteEventBuffer(1_000);
  const approvals = new ApprovalCoordinator(events);
  const supervisor = new AppServerSupervisor({
    clientVersion: SIDECAR_VERSION,
  });
  const projects = new ProjectRegistry(state.listProjects());
  const domain = new CodexDomainService({
    events,
    gateway: supervisor,
    managedThreadIds: state.listManagedThreadIds(),
    persistManagedThread: async (threadId) => {
      await state.markManagedThread(threadId);
    },
    projects,
    resolveRegisteredProjectRoot: async (projectId) =>
      await state.authorizeRegisteredProjectRoot(projectId),
  });

  supervisor.on("notification", (notification) => {
    approvals.handleNotification(notification);
    domain.handleNotification(notification);
  });
  supervisor.on("serverRequest", (request) => {
    approvals.handleServerRequest(request);
  });
  supervisor.on("state", (snapshot) => {
    if (snapshot.state === "degraded") {
      domain.handleBackendRestart();
      approvals.handleBackendRestart();
    }
    events.append("diagnostic", {
      appServerState: snapshot.state,
      restartAttempt: snapshot.restartAttempt,
    });
  });

  const diagnostics = (): DiagnosticSnapshot =>
    createDiagnostics(config, supervisor.snapshot(), domain.historyTruncated, state);
  const app = await createSidecarServer({
    approvals,
    config,
    diagnostics,
    domain,
    events,
    state,
  });
  await app.listen({ host: config.host, port: config.port });
  let stopping = false;
  void supervisor
    .start()
    .then(async () => {
      if (!stopping) {
        await domain.listProjects();
      }
    })
    .catch(() => {
      // The web surface remains available for setup and diagnostics while the
      // supervisor performs bounded background restarts.
    });

  return {
    app,
    config,
    diagnostics,
    stop: async () => {
      stopping = true;
      await app.close();
      await supervisor.stop();
    },
  };
}

function createDiagnostics(
  config: SidecarConfig,
  snapshot: AppServerSupervisorSnapshot,
  historyTruncated: boolean,
  state: SidecarStateStore,
): DiagnosticSnapshot {
  const appServer = appServerCapability(snapshot);
  const running = snapshot.state === "running";
  const capabilities: ProductCapabilities = {
    appServer,
    desktopSnapshots: running ? "available" : "degraded",
    fileBrowser: state.listProjects().some((project) => project.source === "registered")
      ? "available"
      : "degraded",
    liveEvents: "available",
    subagents: running ? "available" : "degraded",
    usage: capabilityFromProbe(snapshot.capabilities?.rateLimits, running),
  };
  const warnings: string[] = snapshot.diagnostics.map((diagnostic) =>
    diagnostic.code === "WINDOWS_APP_PACKAGE_REQUIRES_MATERIALIZED_BINARY"
      ? "检测到 Codex Desktop，但当前只能使用其可启动的本机副本。"
      : diagnostic.code === "DESKTOP_USER_BUNDLE_NOT_FOUND"
        ? "未找到 Codex Desktop 的可启动副本，正在尝试其他本机安装。"
        : "当前使用兼容的 Codex 本机安装。",
  );
  if (historyTruncated) {
    warnings.push("历史对话较多，当前最多显示最近 500 条。");
  }
  const appServerVersion = safeAppServerVersion(snapshot.userAgent);
  return {
    capabilities,
    generatedAt: new Date().toISOString(),
    listener: {
      basePath: config.basePath,
      host: config.host,
      port: config.port,
    },
    version: SIDECAR_VERSION,
    warnings: [...new Set(warnings)],
    ...(appServerVersion === undefined ? {} : { appServerVersion }),
  };
}

function appServerCapability(snapshot: AppServerSupervisorSnapshot): CapabilityState {
  if (snapshot.state === "running") {
    return "available";
  }
  return snapshot.state === "stopped" ? "unavailable" : "degraded";
}

function capabilityFromProbe(
  probe: CapabilitySupport | undefined,
  running: boolean,
): CapabilityState {
  if (!running) {
    return "degraded";
  }
  return probe?.state ?? "degraded";
}

function safeAppServerVersion(userAgent: string | undefined): string | undefined {
  if (!userAgent) {
    return undefined;
  }
  return userAgent.match(/\b\d+\.\d+\.\d+(?:[-+.][A-Za-z0-9.-]+)?\b/u)?.[0];
}
