import {
  type ApprovalRequest,
  type CollaborationModeOption,
  type ModelOption,
  type PermissionProfileOption,
  type ProductCapabilities,
  type QueuedTurnItem,
  type RemoteEvent,
  type ThreadDetail,
  type TurnQueueSnapshot,
} from "../../packages/contracts/src/index.js";
import type { BrowserContext, Page, Route } from "@playwright/test";

type EventSourceHarness = Window & {
  __codexRemoteE2eDispatch?: (event: RemoteEvent) => void;
};

const now = () => new Date().toISOString();

export const runtimeModels: ModelOption[] = [
  {
    id: "runtime-model-next",
    displayName: "Runtime Model Next",
    description: "由运行时动态提供的验收模型",
    supportedReasoningEfforts: ["brief-next", "deep-next"],
    defaultReasoningEffort: "deep-next",
    serviceTiers: [
      { id: "balanced-next", displayName: "均衡" },
      { id: "rapid-next", displayName: "快速" },
    ],
    defaultServiceTier: "balanced-next",
    isDefault: true,
  },
  {
    id: "runtime-model-light",
    displayName: "Runtime Model Light",
    supportedReasoningEfforts: [],
    isDefault: false,
  },
];

export const runtimePermissionProfiles: PermissionProfileOption[] = [
  {
    id: "confirm-risk-next",
    description: "风险操作动态请求确认",
    allowed: true,
  },
  {
    id: "workspace-delegate-next",
    description: "允许当前项目内的运行时操作",
    allowed: true,
  },
];

const runtimeCollaborationModes: CollaborationModeOption[] = [
  {
    id: "runtime-auto-next",
    displayName: "运行时自动协作",
    description: "由当前 Codex 运行时决定如何协作",
    available: true,
  },
];

const capabilities: ProductCapabilities = {
  appServer: "available",
  collaborationModes: "available",
  compact: "available",
  desktopSnapshots: "available",
  fileBrowser: "available",
  goals: "available",
  inlineApprovals: "available",
  liveEvents: "available",
  permissionProfiles: "available",
  queue: "available",
  serviceTiers: "available",
  settingsUpdate: "available",
  subagents: "available",
  usage: "available",
};

function queueItem(
  id: string,
  state: QueuedTurnItem["state"],
  position: number,
  prompt: string,
): QueuedTurnItem {
  const timestamp = now();
  return {
    id,
    threadId: "shared-running-thread",
    clientUserMessageId: `client-${id}`,
    state,
    position,
    revision: 3,
    createdAt: timestamp,
    updatedAt: timestamp,
    prompt,
    model: runtimeModels[0]!.id,
    reasoningEffort: runtimeModels[0]!.defaultReasoningEffort,
  };
}

function approval(id: string, title: string, choiceSuffix: string): ApprovalRequest {
  return {
    id,
    threadId: "shared-running-thread",
    turnId: "shared-running-turn",
    title,
    explanation: "此审批由运行时动态提供，移动端必须完整显示并允许处理。",
    choices: [
      {
        id: `accept-${choiceSuffix}`,
        label: "允许本次动态操作",
        tone: "primary",
      },
      {
        id: `reject-${choiceSuffix}`,
        label: "拒绝本次动态操作",
        tone: "neutral",
      },
    ],
  };
}

export class SharedRuntime {
  readonly settingsUpdates: Array<Record<string, string | null | undefined>> = [];
  private readonly contexts = new Set<BrowserContext>();
  private sequence = 0;
  private approvals: ApprovalRequest[];
  private queueSnapshot: TurnQueueSnapshot;
  private thread: ThreadDetail;

  constructor({ complexState = false }: { complexState?: boolean } = {}) {
    this.thread = {
      id: "shared-running-thread",
      title: "双客户端实时同步自动验收",
      projectId: "shared-project",
      cwdLabel: "…/shared-project",
      mode: "managed",
      state: "running",
      updatedAt: now(),
      model: runtimeModels[0]!.id,
      reasoningEffort: runtimeModels[0]!.defaultReasoningEffort,
      serviceTier: runtimeModels[0]!.defaultServiceTier,
      permissionProfileId: runtimePermissionProfiles[0]!.id,
      collaborationMode: runtimeCollaborationModes[0]!.id,
      activeTurnId: "shared-running-turn",
      items: [
        {
          id: "shared-user-message",
          kind: "user-message",
          text: "验证两个独立 Web 客户端能否看到同一运行任务。",
          createdAt: now(),
        },
        {
          id: "shared-tool",
          kind: "tool",
          title: "运行共享状态验收",
          status: "running",
          summary: "自动 UI 证据，不代表 Desktop 实机三端证据",
          createdAt: now(),
        },
      ],
      availableActions: {
        steer: true,
        interrupt: true,
        reply: false,
        changeModelNextTurn: true,
        compact: true,
        updateSettings: true,
      },
    };
    const items = complexState
      ? [
          queueItem("queue-queued", "queued", 0, "排队消息：等待当前回复结束"),
          queueItem("queue-paused", "paused", 1, "暂停消息：需要人工恢复"),
          queueItem("queue-ambiguous", "ambiguous", 2, "未知消息：发送结果需要确认"),
        ]
      : [];
    this.queueSnapshot = {
      threadId: this.thread.id,
      revision: complexState ? 3 : 0,
      items,
    };
    this.approvals = complexState
      ? [
          approval("approval-dynamic-a", "动态审批：运行项目命令", "command-next"),
          approval("approval-dynamic-b", "动态审批：访问项目文件", "file-next"),
        ]
      : [];
  }

  async attach(context: BrowserContext): Promise<void> {
    this.contexts.add(context);
    await context.addInitScript(() => {
      const sources = new Set<{
        closed: boolean;
        onmessage: ((event: MessageEvent<string>) => void) | null;
        onopen: ((event: Event) => void) | null;
      }>();

      class HarnessEventSource {
        static readonly CLOSED = 2;
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        readonly url: string;
        closed = false;
        onerror: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent<string>) => void) | null = null;
        onopen: ((event: Event) => void) | null = null;
        readyState = HarnessEventSource.CONNECTING;
        withCredentials = true;

        constructor(url: string | URL) {
          this.url = String(url);
          sources.add(this);
          window.setTimeout(() => {
            if (this.closed) return;
            this.readyState = HarnessEventSource.OPEN;
            this.onopen?.(new Event("open"));
          }, 0);
        }

        addEventListener(): void {}
        dispatchEvent(): boolean {
          return true;
        }
        removeEventListener(): void {}

        close(): void {
          this.closed = true;
          this.readyState = HarnessEventSource.CLOSED;
          sources.delete(this);
        }
      }

      Object.defineProperty(window, "EventSource", {
        configurable: true,
        value: HarnessEventSource,
      });
      (window as EventSourceHarness).__codexRemoteE2eDispatch = (event) => {
        for (const source of sources) {
          if (!source.closed) {
            source.onmessage?.(
              new MessageEvent("message", {
                data: JSON.stringify(event),
              }),
            );
          }
        }
      };
    });
    await context.route("**/api/v1/**", (route) => this.handle(route));
  }

  async dispatch(event: Omit<RemoteEvent, "schemaVersion" | "seq" | "emittedAt">): Promise<void> {
    const envelope: RemoteEvent = {
      ...event,
      schemaVersion: 1,
      seq: ++this.sequence,
      emittedAt: now(),
    };
    await Promise.all(
      [...this.contexts].flatMap((context) =>
        context.pages().map(async (page) => {
          await page
            .evaluate(
              (nextEvent) => (window as EventSourceHarness).__codexRemoteE2eDispatch?.(nextEvent),
              envelope,
            )
            .catch(() => undefined);
        }),
      ),
    );
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.contexts].map(async (context) => {
        await context.unroute("**/api/v1/**").catch(() => undefined);
        await context.close();
      }),
    );
    this.contexts.clear();
  }

  private async json(route: Route, body: unknown, status = 200): Promise<void> {
    await route.fulfill({
      body: JSON.stringify(body),
      contentType: "application/json; charset=utf-8",
      status,
    });
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^.*\/api\/v1/u, "") || "/";
    const method = request.method();
    const segments = path.split("/").filter(Boolean).map(decodeURIComponent);

    if (method === "GET" && path === "/bootstrap") {
      return this.json(route, {
        schemaVersion: 1,
        productName: "Local Remote E2E",
        basePath: "/",
        configured: true,
        authenticated: true,
      });
    }
    if (method === "GET" && path === "/auth/session") {
      return this.json(route, {
        authenticated: true,
        csrfToken: "e2e-csrf",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        idleExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (method === "GET" && path === "/projects") {
      return this.json(route, [
        {
          id: "shared-project",
          name: "shared-project",
          rootLabel: "…/shared-project",
          source: "registered",
          lastUsedAt: now(),
        },
      ]);
    }
    if (method === "GET" && path === "/models") return this.json(route, runtimeModels);
    if (method === "GET" && path === "/permission-profiles") {
      return this.json(route, runtimePermissionProfiles);
    }
    if (method === "GET" && path === "/collaboration-modes") {
      return this.json(route, runtimeCollaborationModes);
    }
    if (method === "GET" && path === "/threads") {
      return this.json(route, url.searchParams.get("archived") === "true" ? [] : [this.thread]);
    }
    if (method === "GET" && path === "/usage") {
      return this.json(route, {
        updatedAt: now(),
        windows: [],
        credits: [],
        context: { usedTokens: 42_000, limitTokens: 200_000, usedPercent: 21 },
      });
    }
    if (method === "GET" && path === "/diagnostics") {
      return this.json(route, {
        generatedAt: now(),
        version: "runtime-negotiated",
        capabilities,
        listener: { host: "127.0.0.1", port: 1, basePath: "/" },
        warnings: [],
      });
    }
    if (method === "GET" && path === "/approvals") return this.json(route, this.approvals);

    if (segments[0] === "approvals" && segments[2] === "resolve" && method === "POST") {
      const approvalId = segments[1]!;
      this.approvals = this.approvals.filter((item) => item.id !== approvalId);
      await this.json(route, undefined, 204);
      void this.dispatch({
        type: "approval.resolved",
        threadId: this.thread.id,
        turnId: this.thread.activeTurnId,
        payload: { approvalId },
      });
      return;
    }

    if (segments[0] === "threads" && segments[1] === this.thread.id) {
      if (segments.length === 2 && method === "GET") return this.json(route, this.thread);
      if (segments[2] === "subagents" && method === "GET") return this.json(route, []);
      if (segments[2] === "goal" && method === "GET") {
        return this.json(route, { goal: null });
      }
      if (segments[2] === "settings" && method === "PATCH") {
        const input = request.postDataJSON() as Record<string, string | null | undefined>;
        this.settingsUpdates.push(structuredClone(input));
        this.thread = {
          ...this.thread,
          ...(input["model"] ? { model: input["model"] } : {}),
          ...(input["reasoningEffort"] ? { reasoningEffort: input["reasoningEffort"] } : {}),
          ...(input["serviceTier"] ? { serviceTier: input["serviceTier"] } : {}),
          ...(input["permissionProfileId"]
            ? { permissionProfileId: input["permissionProfileId"] }
            : {}),
        };
        return this.json(route, undefined, 204);
      }
      if (segments[2] === "queue") {
        if (segments.length === 3 && method === "GET") {
          return this.json(route, this.queueSnapshot);
        }
        if (segments.length === 3 && method === "POST") {
          const input = request.postDataJSON() as {
            prompt: string;
            model?: string;
            reasoningEffort?: string;
          };
          const revision = this.queueSnapshot.revision + 1;
          const item = queueItem(
            `queue-${revision}`,
            "queued",
            this.queueSnapshot.items.length,
            input.prompt,
          );
          item.revision = revision;
          if (input.model) item.model = input.model;
          if (input.reasoningEffort) item.reasoningEffort = input.reasoningEffort;
          this.queueSnapshot = {
            threadId: this.thread.id,
            revision,
            items: [...this.queueSnapshot.items, item],
          };
          await this.json(route, this.queueSnapshot);
          void this.dispatch({
            type: "queue.updated",
            threadId: this.thread.id,
            turnId: this.thread.activeTurnId,
            payload: { action: "enqueued", revision, item },
          });
          return;
        }
        if (segments.length === 4 && method === "PATCH") {
          const itemId = segments[3]!;
          const input = request.postDataJSON() as { prompt: string };
          const revision = this.queueSnapshot.revision + 1;
          this.queueSnapshot = {
            threadId: this.thread.id,
            revision,
            items: this.queueSnapshot.items.map((item) =>
              item.id === itemId
                ? { ...item, prompt: input.prompt, revision, updatedAt: now() }
                : { ...item, revision },
            ),
          };
          await this.json(route, this.queueSnapshot);
          void this.dispatch({
            type: "queue.updated",
            threadId: this.thread.id,
            turnId: this.thread.activeTurnId,
            payload: { action: "updated", revision },
          });
          return;
        }
      }
    }

    await this.json(
      route,
      { error: { code: "E2E_ROUTE_NOT_IMPLEMENTED", message: `${method} ${path}` } },
      501,
    );
  }
}

export async function openSharedThread(page: Page): Promise<void> {
  await page.goto("./#/threads/shared-running-thread");
}
