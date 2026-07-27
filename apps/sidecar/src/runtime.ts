import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  AppServerSupervisor,
  DEFAULT_APP_SERVER_MAX_FRAME_BYTES,
} from "@codex-local-remote/app-server-client";
import type {
  AppServerSupervisorOptions,
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
import { readBrokerDesktopHealth, type BrokerDesktopHealth } from "./broker-desktop-health.js";
import { BrowserUploadStore } from "./browser-uploads.js";
import { createDesktopThreadNotifier } from "./desktop-thread-notifier.js";
import { DesktopPinnedThreadReader } from "./desktop-global-state.js";
import { readDesktopRuntimeHealth, type DesktopRuntimeHealth } from "./desktop-runtime-health.js";
import { DesktopSessionUsageReader } from "./desktop-session-usage.js";
import { resolveProjectInputReference } from "./files.js";
import { createWindowsDpapiPromptProtector } from "./prompt-protector.js";
import { loadCodexProtocolCatalog, type CodexProtocolCatalog } from "./protocol-catalog.js";
import { createSidecarServer } from "./server.js";
import { SidecarStateStore } from "./state-store.js";
import { DurableTurnOutbox } from "./turn-outbox.js";
import { TurnQueueService } from "./turn-queue.js";
import { TurnQueueDispatcher } from "./turn-queue-dispatcher.js";

const SIDECAR_VERSION = "0.1.0";
const DESKTOP_RECONCILIATION_INTERVAL_MS = 5_000;
const SHARED_CAPABILITY_PROBE_TIMEOUT_MS = 30_000;

export interface RunningSidecar {
  app: FastifyInstance;
  config: SidecarConfig;
  diagnostics(): DiagnosticSnapshot;
  stop(): Promise<void>;
}

export function createSharedAppServerSupervisorOptions(
  endpoint: string,
): AppServerSupervisorOptions {
  return {
    clientVersion: SIDECAR_VERSION,
    endpoint,
    maxFrameBytes: DEFAULT_APP_SERVER_MAX_FRAME_BYTES,
    mode: "shared-websocket",
    probeTimeoutMs: SHARED_CAPABILITY_PROBE_TIMEOUT_MS,
  };
}

export function isSidecarRequestReady(
  snapshot: AppServerSupervisorSnapshot,
  desktopRuntimeHealth: DesktopRuntimeHealth,
  brokerDesktopHealth: BrokerDesktopHealth,
): boolean {
  return (
    snapshot.state === "running" &&
    snapshot.capabilities?.models.state === "available" &&
    snapshot.capabilities.threadList?.state === "available" &&
    desktopRuntimeCanServeRequests(desktopRuntimeHealth) &&
    brokerDesktopCanServeRequests(brokerDesktopHealth)
  );
}

function desktopRuntimeCanServeRequests(health: DesktopRuntimeHealth): boolean {
  return (
    health.state === "current" || health.state === "starting" || health.state === "update-pending"
  );
}

function desktopRuntimeCanReportAvailable(health: DesktopRuntimeHealth): boolean {
  return health.state === "current" || health.state === "update-pending";
}

function brokerDesktopCanServeRequests(health: BrokerDesktopHealth): boolean {
  return health.state === "current" || health.state === "application-degraded";
}

export function createSharedThreadReconnectHandler(
  resubscribe: () => Promise<void>,
): (running: boolean) => Promise<void> | undefined {
  let wasRunning = false;
  let tail: Promise<void> | undefined;
  return (running) => {
    const transitionedToRunning = running && !wasRunning;
    wasRunning = running;
    if (!transitionedToRunning) {
      return undefined;
    }
    const operation =
      tail === undefined ? resubscribe() : tail.catch(() => undefined).then(resubscribe);
    tail = operation;
    void operation.then(
      () => {
        if (tail === operation) {
          tail = undefined;
        }
      },
      () => {
        if (tail === operation) {
          tail = undefined;
        }
      },
    );
    return operation;
  };
}

export async function startSidecar(config: SidecarConfig): Promise<RunningSidecar> {
  const state = await SidecarStateStore.open(config.dataDir);
  const browserUploads = await BrowserUploadStore.open(config.dataDir);
  const generalConversationRoot = path.join(config.dataDir, "RemoteConversations");
  await mkdir(generalConversationRoot, { recursive: true });
  const events = new RemoteEventBuffer(1_000);
  const protocolCatalog = await loadCodexProtocolCatalog(config.codexPath);
  const approvals = new ApprovalCoordinator(events, protocolCatalog.serverRequestDecisionFallbacks);
  const supervisor = new AppServerSupervisor(
    createSharedAppServerSupervisorOptions(config.appServerUrl),
  );
  const desktopPins = new DesktopPinnedThreadReader();
  const desktopSessionUsage = new DesktopSessionUsageReader();
  const projects = new ProjectRegistry(state.listProjects());
  const notifyManagedThreadCreated = createDesktopThreadNotifier({
    enabled: config.desktopSyncEnabled,
  });
  const domain = new CodexDomainService({
    clearPendingDesktopNotification: async (threadId) => {
      await state.clearPendingDesktopNotification(threadId);
    },
    events,
    gateway: supervisor,
    generalConversationRoot,
    listPinnedThreadIds: async () => {
      const codexHome = supervisor.snapshot().codexHome;
      return codexHome === undefined ? undefined : await desktopPins.read(codexHome);
    },
    managedThreadIds: state.listManagedThreadIds(),
    ...(notifyManagedThreadCreated === undefined ? {} : { notifyManagedThreadCreated }),
    pendingDesktopNotificationThreadIds: state.listPendingDesktopNotificationThreadIds(),
    protocolCatalog,
    readPersistedUsageContext: async (threadId, sessionPath) => {
      const codexHome = supervisor.snapshot().codexHome;
      return codexHome === undefined
        ? undefined
        : await desktopSessionUsage.read({
            codexHome,
            ...(sessionPath === undefined ? {} : { sessionPath }),
            threadId,
          });
    },
    persistManagedThread: async (threadId, options) => {
      await state.markManagedThread(threadId, options);
    },
    projects,
    resolveLocalInputReference: async (reference) => {
      if (reference.uploadId !== undefined) {
        return await browserUploads.resolve(reference);
      }
      if (reference.projectId === undefined) {
        throw new Error("local input reference has no source");
      }
      const resolved = await resolveProjectInputReference(
        state,
        reference.projectId,
        reference.relativePath,
      );
      return {
        kind: resolved.kind,
        name: resolved.name,
        path: resolved.absolutePath,
      };
    },
    resolveRegisteredProjectRoot: async (projectId) =>
      await state.authorizeRegisteredProjectRoot(projectId),
    sharedAppServer: true,
  });
  const outbox = await DurableTurnOutbox.open({
    dataDir: config.dataDir,
    protector: createWindowsDpapiPromptProtector(),
  });
  const queueDispatcher = new TurnQueueDispatcher({
    gateway: {
      inspectThread: async (threadId) => {
        const thread = await domain.getThread(threadId);
        if (
          thread.activeTurnId !== undefined ||
          thread.state === "running" ||
          thread.state === "waiting-for-approval"
        ) {
          return { state: "active" as const };
        }
        return {
          state: thread.availableActions.reply ? ("idle" as const) : ("unknown" as const),
        };
      },
      reconcileClientUserMessage: async (threadId, clientUserMessageId) =>
        await domain.reconcileClientUserMessage(threadId, clientUserMessageId),
      startTurn: async (threadId, input) => {
        const result = await domain.startTurn(threadId, input);
        return { turnId: result.turnId };
      },
      steerTurn: async (threadId, turnId, input) => {
        await domain.steerTurn(threadId, turnId, input);
      },
    },
    outbox,
  });
  const queue = new TurnQueueService({ dispatcher: queueDispatcher, outbox });
  const unsubscribeOutbox = outbox.subscribe((change) => {
    events.append("queue.updated", change.event, { threadId: change.threadId });
  });
  let backendRunning = false;
  let desktopRuntimeHealth = await readDesktopRuntimeHealth(config.dataDir);
  let brokerDesktopHealth = await readBrokerDesktopHealth(config.dataDir, config.appServerUrl);
  let stopping = false;
  const resubscribeSharedThreads = createSharedThreadReconnectHandler(async () => {
    if (!stopping) {
      await domain.resubscribeSharedThreads();
    }
  });
  const reconcilePendingDesktopNotifications = () => {
    if (!backendRunning || stopping || notifyManagedThreadCreated === undefined) {
      return;
    }
    void domain.reconcilePendingDesktopNotifications().catch(() => {
      // The interval and the next running transition retry durable pending IDs.
    });
  };

  supervisor.on("notification", (notification) => {
    approvals.handleNotification(notification);
    domain.handleNotification(notification);
    void queueDispatcher.handleNotification(notification).catch(() => {
      const notificationThreadId =
        typeof (notification.params as { threadId?: unknown } | undefined)?.threadId === "string"
          ? (notification.params as { threadId: string }).threadId
          : undefined;
      events.append(
        "diagnostic",
        {
          code: "QUEUE_NOTIFICATION_RECONCILIATION_FAILED",
          message: "排队消息状态暂时无法更新，请刷新后重试",
        },
        notificationThreadId === undefined ? {} : { threadId: notificationThreadId },
      );
    });
  });
  supervisor.on("serverRequest", (request) => {
    approvals.handleServerRequest(request);
  });
  supervisor.on("state", (snapshot) => {
    backendRunning = snapshot.state === "running";
    const resubscription = resubscribeSharedThreads(backendRunning);
    if (resubscription !== undefined) {
      void resubscription
        .then(async () => {
          if (!stopping) {
            await queueDispatcher.reconcileAfterRestart();
          }
        })
        .catch(() => {
          // The next non-running -> running transition retries both loaded
          // subscriptions and the durable outbox reconciliation.
        });
    }
    if (snapshot.state === "degraded") {
      domain.handleBackendRestart();
      approvals.handleBackendRestart();
    }
    if (backendRunning) {
      reconcilePendingDesktopNotifications();
    }
    events.append("diagnostic", {
      appServerState: snapshot.state,
      restartAttempt: snapshot.restartAttempt,
    });
  });

  const diagnostics = (): DiagnosticSnapshot =>
    createDiagnostics(
      config,
      supervisor.snapshot(),
      domain.historyTruncated,
      state,
      desktopRuntimeHealth,
      brokerDesktopHealth,
      protocolCatalog,
    );
  const app = await createSidecarServer({
    approvals,
    config,
    diagnostics,
    domain,
    events,
    queue,
    requestReady: () =>
      isSidecarRequestReady(supervisor.snapshot(), desktopRuntimeHealth, brokerDesktopHealth),
    state,
  });
  await app.listen({ host: config.host, port: config.port });
  const reconciliationTimer = setInterval(() => {
    reconcilePendingDesktopNotifications();
    void Promise.all([
      readDesktopRuntimeHealth(config.dataDir),
      readBrokerDesktopHealth(config.dataDir, config.appServerUrl),
    ]).then(([runtimeHealth, brokerHealth]) => {
      const healthChanged = runtimeConnectionHealthChanged(
        desktopRuntimeHealth,
        brokerDesktopHealth,
        runtimeHealth,
        brokerHealth,
      );
      desktopRuntimeHealth = runtimeHealth;
      brokerDesktopHealth = brokerHealth;
      if (healthChanged) {
        const snapshot = supervisor.snapshot();
        events.append("diagnostic", {
          appServerState: snapshot.state,
          restartAttempt: snapshot.restartAttempt,
        });
      }
    });
  }, DESKTOP_RECONCILIATION_INTERVAL_MS);
  reconciliationTimer.unref();
  void supervisor.start().catch(() => {
    // The web surface remains available for setup and diagnostics while the
    // supervisor performs bounded background restarts.
  });

  return {
    app,
    config,
    diagnostics,
    stop: async () => {
      stopping = true;
      clearInterval(reconciliationTimer);
      unsubscribeOutbox();
      await app.close();
      await supervisor.stop();
    },
  };
}

export function createDiagnostics(
  config: SidecarConfig,
  snapshot: AppServerSupervisorSnapshot,
  historyTruncated: boolean,
  state: SidecarStateStore,
  desktopRuntimeHealth: DesktopRuntimeHealth = { state: "current" },
  brokerDesktopHealth: BrokerDesktopHealth = { state: "current" },
  protocolCatalog: CodexProtocolCatalog = {
    approvalPolicies: [],
    approvalReviewers: [],
    clientMethods: [],
    serverRequestDecisionFallbacks: {},
  },
): DiagnosticSnapshot {
  const appServer =
    desktopRuntimeCanReportAvailable(desktopRuntimeHealth) &&
    brokerDesktopCanServeRequests(brokerDesktopHealth)
      ? appServerCapability(snapshot)
      : "degraded";
  const running = snapshot.state === "running";
  const capabilities: ProductCapabilities = {
    appServer,
    approvalPolicies:
      running && protocolCatalog.approvalPolicies.length > 0 ? "available" : "degraded",
    approvalReviewers:
      running && protocolCatalog.approvalReviewers.length > 0
        ? "available"
        : capabilityFromProbe(snapshot.capabilities?.approvalReviewers, running),
    collaborationModes: capabilityFromProbe(snapshot.capabilities?.collaborationModes, running),
    compact: capabilityFromProbeOrMethods(
      snapshot.capabilities?.compact,
      running,
      appServer,
      protocolCatalog.clientMethods,
      ["thread/compact/start"],
    ),
    desktopSnapshots: capabilityFromProbe(snapshot.capabilities?.threadList, running),
    fileBrowser: state.listProjects().some((project) => project.source === "registered")
      ? "available"
      : "degraded",
    goals: capabilityFromProbeOrMethods(
      snapshot.capabilities?.goals,
      running,
      appServer,
      protocolCatalog.clientMethods,
      ["thread/goal/get", "thread/goal/set", "thread/goal/clear"],
    ),
    inlineApprovals: running && appServer === "available" ? "available" : "degraded",
    liveEvents: running && appServer === "available" ? "available" : "degraded",
    permissionProfiles: capabilityFromProbe(snapshot.capabilities?.permissions, running),
    queue: "available",
    serviceTiers: capabilityFromProbe(snapshot.capabilities?.serviceTiers, running),
    settingsUpdate: capabilityFromProbeOrMethods(
      snapshot.capabilities?.settingsUpdate,
      running,
      appServer,
      protocolCatalog.clientMethods,
      ["thread/settings/update"],
    ),
    subagents: capabilityFromProbe(snapshot.capabilities?.threadList, running),
    usage: capabilityFromProbe(snapshot.capabilities?.usage, running),
  };
  const warnings: string[] = snapshot.diagnostics.map((diagnostic) =>
    diagnostic.code === "WINDOWS_APP_PACKAGE_REQUIRES_MATERIALIZED_BINARY"
      ? "检测到 Codex Desktop，但当前只能使用其可启动的本机副本。"
      : diagnostic.code === "DESKTOP_USER_BUNDLE_NOT_FOUND"
        ? "未找到 Codex Desktop 的可启动副本，正在尝试其他本机安装。"
        : "当前使用兼容的 Codex 本机安装。",
  );
  if (snapshot.mode === "shared-websocket" && !running) {
    warnings.push("共享 Codex 后台尚未连接；为避免双重执行，远程端不会另起备用后台。");
  }
  if (historyTruncated) {
    warnings.push("历史对话较多，可在对话页继续加载更早记录。");
  }
  if ("warning" in desktopRuntimeHealth) {
    warnings.push(desktopRuntimeHealth.warning);
  }
  if ("warning" in brokerDesktopHealth) {
    warnings.push(brokerDesktopHealth.warning);
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

export function runtimeConnectionHealthChanged(
  previousDesktop: DesktopRuntimeHealth,
  previousBroker: BrokerDesktopHealth,
  nextDesktop: DesktopRuntimeHealth,
  nextBroker: BrokerDesktopHealth,
): boolean {
  return (
    healthFingerprint(previousDesktop) !== healthFingerprint(nextDesktop) ||
    healthFingerprint(previousBroker) !== healthFingerprint(nextBroker)
  );
}

function healthFingerprint(health: DesktopRuntimeHealth | BrokerDesktopHealth): string {
  return "warning" in health ? `${health.state}\u0000${health.warning}` : health.state;
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

function capabilityFromProbeOrMethods(
  probe: CapabilitySupport | undefined,
  running: boolean,
  appServer: CapabilityState,
  clientMethods: readonly string[],
  requiredMethods: readonly string[],
): CapabilityState {
  if (
    running &&
    appServer === "available" &&
    requiredMethods.every((method) => clientMethods.includes(method))
  ) {
    return "available";
  }
  return capabilityFromProbe(probe, running);
}

function safeAppServerVersion(userAgent: string | undefined): string | undefined {
  if (!userAgent) {
    return undefined;
  }
  return userAgent.match(/\b\d+\.\d+\.\d+(?:[-+.][A-Za-z0-9.-]+)?\b/u)?.[0];
}
