import {
  type ApprovalRequest,
  type CollaborationModeOption,
  type ModelOption,
  type PermissionProfileOption,
  type ProductCapabilities,
  type QueuedTurnItem,
  type RemoteEvent,
  type SetThreadGoalInput,
  type ThreadDetail,
  type ThreadGoal,
  type TurnQueueSnapshot,
} from "../../packages/contracts/src/index.js";
import type { BrowserContext, Page, Route } from "@playwright/test";

type EventSourceHarness = Window & {
  __codexRemoteE2eDispatch?: (event: RemoteEvent) => void;
  __codexRemoteE2eSetOnline?: (online: boolean) => void;
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

const runtimeApprovalPolicies = [{ id: "on-request" }, { id: "never" }];
const runtimeApprovalReviewers = [{ id: "auto_review" }, { id: "guardian_subagent" }];

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
  approvalPolicies: "available",
  approvalReviewers: "available",
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
  readonly goalUpdates: Array<SetThreadGoalInput | null> = [];
  readonly settingsUpdates: Array<Record<string, string | null | undefined>> = [];
  private readonly contexts = new Set<BrowserContext>();
  private sequence = 0;
  private approvals: ApprovalRequest[];
  private goal: ThreadGoal | null = null;
  private queueSnapshot: TurnQueueSnapshot;
  private thread: ThreadDetail;

  constructor({
    complexState = false,
    longWorkLog = false,
  }: { complexState?: boolean; longWorkLog?: boolean } = {}) {
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
      approvalPolicy: runtimeApprovalPolicies[0]!.id,
      approvalsReviewer: runtimeApprovalReviewers[0]!.id,
      collaborationMode: runtimeCollaborationModes[0]!.id,
      activeTurnId: "shared-running-turn",
      items: [
        {
          id: "shared-user-message",
          kind: "user-message",
          text: "验证两个独立 Web 客户端能否看到同一运行任务。",
          attachments: [
            {
              kind: "file",
              name: "mobile-evidence.json",
              path: "Q:/PublicFixtures/reports/mobile-evidence.json",
            },
            {
              kind: "image",
              name: "mobile-evidence.svg",
              path: "Q:/PublicFixtures/reports/mobile-evidence.svg",
            },
          ],
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
        {
          id: "shared-local-file-link",
          kind: "assistant-message",
          phase: "final_answer",
          text: "查看 [fresh-task (line 87)](Q:/PublicFixtures/reports/review-evidence.json:87)。",
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
    if (complexState) {
      const goalTimestamp = now();
      this.goal = {
        threadId: this.thread.id,
        objective:
          "完成移动端复杂状态验收、真实任务闭环、断线安全排队与发布前最终复核，确保所有关键操作在手机上清晰可用",
        status: "active",
        tokensUsed: 3,
        timeUsedSeconds: 90,
        createdAt: goalTimestamp,
        updatedAt: goalTimestamp,
      };
      this.thread.items.push(
        {
          id: "shared-plan-question",
          kind: "interaction-record",
          interaction: "question",
          status: "answered",
          title: "已回答 1 个计划问题",
          questions: [
            {
              id: "delivery-priority",
              header: "优先级",
              question: "这次移动端验收优先保证什么？",
              isSecret: false,
              options: [
                {
                  label: "稳定闭环",
                  description: "先保证真实任务、审批与下一轮都可完成。",
                },
                {
                  label: "视觉微调",
                  description: "先调整字号、间距与颜色。",
                },
              ],
              answers: ["稳定闭环"],
            },
          ],
          turnId: "shared-running-turn",
          createdAt: now(),
        },
        {
          id: "shared-formal-plan",
          kind: "formal-plan",
          text: "## 移动端验收计划\n\n1. 验证动态审批与计划提问。\n2. 验证命令、输出和文件均可查看、滚动与复制。",
          turnId: "shared-running-turn",
          createdAt: now(),
        },
        {
          id: "shared-long-command",
          kind: "tool",
          title: "运行命令",
          status: "completed",
          summary: `pwsh -NoProfile -Command "${Array.from(
            { length: 80 },
            (_, index) => `Write-Output 'COMMAND-${index + 1}-ABCDEFGHIJKLMNOPQRSTUVWXYZ'`,
          ).join("\n")}"`,
          detail: Array.from(
            { length: 80 },
            (_, index) =>
              `OUTPUT-${String(index + 1).padStart(2, "0")}: ${"0123456789abcdefghijklmnopqrstuvwxyz".repeat(5)}`,
          ).join("\n"),
          createdAt: now(),
        },
      );
    }
    if (longWorkLog) {
      const createdAt = now();
      this.thread.state = "complete";
      delete this.thread.activeTurnId;
      this.thread.availableActions = {
        steer: false,
        interrupt: false,
        reply: true,
        changeModelNextTurn: true,
        compact: true,
        updateSettings: true,
      };
      this.thread.items = [
        {
          id: "long-work-user",
          kind: "user-message",
          text: "请完整检查长对话，不能丢失任何工作记录。",
          turnId: "long-work-turn",
          createdAt,
        },
        {
          id: "long-work-reasoning-a",
          kind: "reasoning-summary",
          text: "先确认真实历史基线",
          turnId: "long-work-turn",
          createdAt,
        },
        {
          id: "long-work-commentary-a",
          kind: "assistant-message",
          phase: "commentary",
          text: "正在核对长对话顺序",
          turnId: "long-work-turn",
          createdAt,
        },
        {
          id: "long-work-command",
          kind: "tool",
          title: "运行命令",
          status: "complete",
          summary: "pnpm --filter @codex-local-remote/web test",
          detail: "Test Files 33 passed\nTests 269 passed",
          turnId: "long-work-turn",
          createdAt,
        },
        {
          id: "long-work-file",
          kind: "file-change",
          path: "C:/Projects/codex-local-remote/apps/web/src/App.tsx",
          change: "modified",
          status: "completed",
          diff: "@@ -1 +1 @@\n-old\n+new",
          additions: 1,
          deletions: 1,
          turnId: "long-work-turn",
          createdAt,
        },
        {
          id: "long-work-subagent",
          kind: "subagent-activity",
          action: "close",
          agents: [{ threadId: "long-work-agent", label: "历史完整性检查" }],
          status: "complete",
          summary: "检查完成",
          turnId: "long-work-turn",
          createdAt,
        },
        {
          id: "long-work-reasoning-b",
          kind: "reasoning-summary",
          text: "已完成合并并验证无重复",
          turnId: "long-work-turn",
          createdAt,
        },
        {
          id: "long-work-commentary-b",
          kind: "assistant-message",
          phase: "commentary",
          text: "准备给出最终结果",
          turnId: "long-work-turn",
          createdAt,
        },
        {
          id: "long-work-generated-image",
          kind: "image-activity",
          action: "generated",
          attachments: [
            {
              kind: "image",
              name: "generated-evidence.svg",
              path: "Q:/PublicFixtures/reports/mobile-evidence.svg",
            },
          ],
          status: "complete",
          summary: "AI 生成的验收图片",
          turnId: "long-work-turn",
          createdAt,
        },
        {
          id: "long-work-final",
          kind: "assistant-message",
          phase: "final_answer",
          text: "完整工作记录之后的最终回答。",
          turnId: "long-work-turn",
          createdAt,
        },
      ];
    }
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
        onerror: ((event: Event) => void) | null;
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
      (window as EventSourceHarness).__codexRemoteE2eSetOnline = (online) => {
        for (const source of sources) {
          if (source.closed) continue;
          if (online) {
            source.readyState = HarnessEventSource.OPEN;
            source.onopen?.(new Event("open"));
          } else {
            source.readyState = HarnessEventSource.CONNECTING;
            source.onerror?.(new Event("error"));
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

  async setOnline(online: boolean): Promise<void> {
    await Promise.all(
      [...this.contexts].flatMap((context) =>
        context.pages().map(async (page) => {
          await page
            .evaluate(
              (nextOnline) =>
                (window as EventSourceHarness).__codexRemoteE2eSetOnline?.(nextOnline),
              online,
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
        {
          id: "fixture-project",
          name: "Fixture Project",
          rootLabel: "Q:/PublicFixtures",
          source: "registered",
          lastUsedAt: now(),
        },
      ]);
    }
    if (method === "GET" && path === "/models") return this.json(route, runtimeModels);
    if (method === "GET" && path === "/permission-profiles") {
      return this.json(route, runtimePermissionProfiles);
    }
    if (method === "GET" && path === "/approval-policies") {
      return this.json(route, runtimeApprovalPolicies);
    }
    if (method === "GET" && path === "/approval-reviewers") {
      return this.json(route, runtimeApprovalReviewers);
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
    if (method === "GET" && path === "/files/resolve") {
      const requestedPath = url.searchParams.get("path") ?? "";
      const isImage = requestedPath.endsWith("mobile-evidence.svg");
      return this.json(route, {
        downloadable: true,
        kind: "file",
        modifiedAt: now(),
        name: isImage
          ? "mobile-evidence.svg"
          : requestedPath.endsWith("mobile-evidence.json")
            ? "mobile-evidence.json"
            : "review-evidence.json",
        projectId: "fixture-project",
        relativePath: isImage
          ? "reports/mobile-evidence.svg"
          : requestedPath.endsWith("mobile-evidence.json")
            ? "reports/mobile-evidence.json"
            : "reports/review-evidence.json",
        size: 128,
      });
    }
    if (method === "GET" && path === "/files/preview") {
      const requestedPath = url.searchParams.get("path") ?? "";
      if (requestedPath.endsWith("mobile-evidence.svg")) {
        return route.fulfill({
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#e8f7ef"/><text x="24" y="96" font-size="24" fill="#08783e">mobile evidence</text></svg>',
          contentType: "image/svg+xml",
          status: 200,
        });
      }
      if (requestedPath.endsWith("mobile-evidence.json")) {
        return route.fulfill({
          body: '{\n  "attachment": "visible"\n}\n',
          contentType: "application/json; charset=utf-8",
          status: 200,
        });
      }
      return route.fulfill({
        body: '{\n  "fresh-task": "not_retested"\n}\n',
        contentType: "application/json; charset=utf-8",
        status: 200,
      });
    }
    if (method === "GET" && path === "/files/download") {
      return route.fulfill({
        body: '{\n  "fresh-task": "not_retested"\n}\n',
        contentType: "application/octet-stream",
        headers: {
          "content-disposition": 'attachment; filename="review-evidence.json"',
        },
        status: 200,
      });
    }

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
        return this.json(route, { goal: this.goal });
      }
      if (segments[2] === "goal" && method === "PUT") {
        const input = request.postDataJSON() as SetThreadGoalInput;
        const timestamp = now();
        const existing = this.goal;
        const tokenBudget = input.tokenBudget ?? existing?.tokenBudget;
        this.goal = {
          threadId: this.thread.id,
          objective: input.objective ?? existing?.objective ?? "持续完成当前任务",
          status: input.status ?? existing?.status ?? "active",
          ...(tokenBudget === undefined ? {} : { tokenBudget }),
          tokensUsed: existing?.tokensUsed ?? 0,
          timeUsedSeconds: existing?.timeUsedSeconds ?? 0,
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp,
        };
        this.goalUpdates.push(structuredClone(input));
        return this.json(route, undefined, 204);
      }
      if (segments[2] === "goal" && method === "DELETE") {
        this.goal = null;
        this.goalUpdates.push(null);
        return this.json(route, undefined, 204);
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
          ...(input["approvalPolicy"] ? { approvalPolicy: input["approvalPolicy"] } : {}),
          ...(input["approvalsReviewer"] ? { approvalsReviewer: input["approvalsReviewer"] } : {}),
          ...(input["collaborationMode"] ? { collaborationMode: input["collaborationMode"] } : {}),
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
