export const API_SCHEMA_VERSION = 1 as const;

export type CapabilityState = "available" | "degraded" | "unavailable";
export type ThreadMode = "managed" | "desktop-snapshot";
export type RunState = "idle" | "running" | "waiting-for-approval" | "failed" | "complete";

export interface ProductCapabilities {
  appServer: CapabilityState;
  approvalPolicies?: CapabilityState;
  approvalReviewers?: CapabilityState;
  collaborationModes?: CapabilityState;
  compact?: CapabilityState;
  desktopSnapshots: CapabilityState;
  fileBrowser: CapabilityState;
  goals?: CapabilityState;
  inlineApprovals?: CapabilityState;
  liveEvents: CapabilityState;
  permissionProfiles?: CapabilityState;
  queue?: CapabilityState;
  serviceTiers?: CapabilityState;
  settingsUpdate?: CapabilityState;
  subagents: CapabilityState;
  usage: CapabilityState;
}

export interface PublicBootstrap {
  schemaVersion: typeof API_SCHEMA_VERSION;
  productName: string;
  basePath: string;
  configured: boolean;
  authenticated: boolean;
}

export interface AuthSession {
  authenticated: true;
  csrfToken: string;
  expiresAt: string;
  idleExpiresAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  rootLabel: string;
  source: "registered" | "desktop-import" | "thread";
  lastUsedAt?: string;
}

export interface ModelOption {
  id: string;
  displayName: string;
  description?: string;
  supportedReasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
  serviceTiers?: ModelServiceTierOption[];
  defaultServiceTier?: string;
  isDefault: boolean;
}

export interface ModelServiceTierOption {
  id: string;
  displayName: string;
  description?: string;
}

/**
 * app-server deliberately treats reasoning effort as an open string so that a
 * newly introduced level can flow through without requiring a remote-client
 * release first.
 */
export type ReasoningEffort = string;
export type PermissionMode = "read-only" | "workspace-write" | "ask";

export interface PermissionProfileOption {
  id: string;
  description?: string;
  allowed: boolean;
}

/**
 * A reviewer id advertised by the running app-server requirements catalog.
 * The id is intentionally open-ended so future Codex values flow through
 * without a companion release.
 */
export interface ApprovalReviewerOption {
  id: string;
}

/**
 * A string approval policy discovered from the currently running Codex
 * app-server schema. Structured future policies remain visible to Codex but
 * are not fabricated into lossy buttons here.
 */
export interface ApprovalPolicyOption {
  id: string;
}

export interface CollaborationModeOption {
  id: string;
  displayName: string;
  description?: string;
  available: boolean;
}

export interface UsageWindow {
  id: string;
  label: string;
  usedPercent?: number;
  remainingPercent?: number;
  resetsAt?: string;
}

export interface UsageCredits {
  id: string;
  label: string;
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string;
}

export interface AccountTokenUsageSummary {
  lifetimeTokens?: string;
  peakDailyTokens?: string;
  longestRunningTurnSec?: number;
  currentStreakDays?: number;
  longestStreakDays?: number;
}

export interface DailyTokenUsage {
  startDate: string;
  tokens: string;
}

export interface UsageSnapshot {
  updatedAt: string;
  plan?: string;
  windows: UsageWindow[];
  credits?: UsageCredits[];
  tokenUsageSummary?: AccountTokenUsageSummary;
  dailyUsageBuckets?: DailyTokenUsage[];
  context?: {
    usedTokens?: number;
    limitTokens?: number;
    usedPercent?: number;
  };
}

export interface ThreadSummary {
  id: string;
  title: string;
  archived?: boolean;
  pinnedRank?: number;
  projectId?: string;
  cwdLabel?: string;
  mode: ThreadMode;
  state: RunState;
  updatedAt: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  serviceTier?: string;
  permissionProfileId?: string;
  approvalPolicy?: string;
  approvalsReviewer?: string;
  collaborationMode?: string;
  parentThreadId?: string;
  childCount?: number;
  snapshotDelaySeconds?: number;
}

export interface ConversationItemContext {
  createdAt?: string;
  turnId?: string;
  turnStartedAt?: string;
  turnCompletedAt?: string;
}

export interface ToolOccurrenceDetail {
  id: string;
  status: "running" | "complete" | "failed";
  summary?: string;
  detail?: string;
  createdAt?: string;
}

export type ConversationItem = ConversationItemContext &
  (
    | {
        id: string;
        kind: "user-message" | "assistant-message" | "reasoning-summary";
        text: string;
        phase?: "commentary" | "final_answer";
      }
    | {
        id: string;
        kind: "tool";
        operation?: "context-compaction";
        title: string;
        status: "running" | "complete" | "failed";
        summary?: string;
        detail?: string;
        occurrences?: number;
        occurrenceDetails?: ToolOccurrenceDetail[];
      }
    | {
        id: string;
        kind: "file-change";
        path: string;
        change: "added" | "modified" | "deleted";
        status?: "inProgress" | "completed" | "failed" | "declined";
        targetPath?: string;
        diff?: string;
        additions?: number;
        deletions?: number;
      }
    | {
        id: string;
        kind: "subagent-activity";
        action: "spawn" | "update" | "resume" | "wait" | "close" | "activity";
        agents: Array<{
          threadId: string;
          label?: string;
        }>;
        status: "running" | "complete" | "failed";
        summary?: string;
      }
    | {
        id: string;
        kind: "plan-progress";
        explanation?: string;
        steps: Array<{
          text: string;
          status: "pending" | "inProgress" | "completed";
        }>;
      }
  );

export interface ThreadDetail extends ThreadSummary {
  items: ConversationItem[];
  historyNextCursor?: string;
  activeTurnId?: string;
  snapshotEventSeq?: number;
  availableActions: {
    steer: boolean;
    interrupt: boolean;
    reply: boolean;
    changeModelNextTurn: boolean;
    compact?: boolean;
    updateSettings?: boolean;
  };
}

export interface ThreadSettingsInput {
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  serviceTier?: string | null;
  permissionProfileId?: string | null;
  approvalPolicy?: string | null;
  approvalsReviewer?: string | null;
  collaborationMode?: string | null;
}

export interface ThreadGoal {
  threadId: string;
  objective: string;
  status: string;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface SetThreadGoalInput {
  objective: string;
  tokenBudget?: number;
}

export interface SubagentSummary {
  threadId: string;
  parentThreadId: string;
  title: string;
  depth: number;
  state: RunState;
  updatedAt: string;
  isDirectlyControllable: boolean;
}

export interface ApprovalRequest {
  id: string;
  threadId: string;
  turnId?: string;
  title: string;
  explanation?: string;
  command?: string;
  paths?: string[];
  choices: Array<{
    id: string;
    label: string;
    tone: "primary" | "neutral" | "danger";
  }>;
  /**
   * Present when Codex did not advertise any response choices that the
   * companion can safely return. The request remains visible, but no response
   * is fabricated.
   */
  limitation?: string;
  questions?: Array<{
    id: string;
    header: string;
    question: string;
    isOther: boolean;
    isSecret: boolean;
    options?: Array<{
      label: string;
      description: string;
    }>;
  }>;
  expiresAt?: string;
}

export interface ApprovalResolutionInput {
  choiceId: string;
  answers?: Record<string, string[]>;
}

export interface RemoteEvent<T = unknown> {
  schemaVersion: typeof API_SCHEMA_VERSION;
  seq: number;
  type:
    | "connection.ready"
    | "connection.reset"
    | "thread.snapshot"
    | "thread.updated"
    | "thread.item"
    | "turn.state"
    | "usage.updated"
    | "approval.requested"
    | "approval.resolved"
    | "queue.updated"
    | "diagnostic";
  emittedAt: string;
  threadId?: string;
  turnId?: string;
  payload: T;
}

export interface CreateThreadInput {
  projectId?: string;
  prompt: string;
  attachments?: LocalInputReference[];
  model?: string;
  reasoningEffort?: ReasoningEffort;
  permissionMode?: PermissionMode;
  permissionProfileId?: string;
  approvalPolicy?: string;
  approvalsReviewer?: string;
  serviceTier?: string;
  collaborationMode?: string;
}

export interface SendTurnInput {
  prompt: string;
  attachments?: LocalInputReference[];
  clientUserMessageId?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  serviceTier?: string;
  permissionProfileId?: string;
  approvalPolicy?: string;
  approvalsReviewer?: string;
  collaborationMode?: string;
}

export type QueuedTurnState = "queued" | "dispatching" | "started" | "ambiguous" | "paused";

export interface QueuedTurnSummary {
  id: string;
  threadId: string;
  clientUserMessageId: string;
  state: QueuedTurnState;
  position: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  approvalPolicy?: string;
  approvalsReviewer?: string;
  collaborationMode?: string;
  permissionProfileId?: string;
  serviceTier?: string;
  turnId?: string;
  issue?: string;
}

export interface QueuedTurnItem extends QueuedTurnSummary {
  /**
   * Present only while the message is pending and only on an authenticated
   * queue read. SSE events deliberately carry QueuedTurnSummary instead.
   */
  prompt?: string;
  attachments?: LocalInputReference[];
}

export interface TurnQueueSnapshot {
  threadId: string;
  revision: number;
  items: QueuedTurnItem[];
}

export type QueueTurnInput = Omit<SendTurnInput, "clientUserMessageId">;

export interface EditQueuedTurnInput extends QueueTurnInput {
  expectedRevision: number;
}

export interface ReorderQueuedTurnsInput {
  expectedRevision: number;
  queueIds: string[];
}

export interface SendQueuedTurnInput {
  expectedRevision: number;
  retryAmbiguous?: boolean;
}

export interface SteerQueuedTurnInput {
  expectedRevision: number;
  turnId: string;
}

export interface QueueUpdatedEvent {
  action: "enqueued" | "updated" | "reordered" | "removed" | "state-changed";
  revision: number;
  item?: QueuedTurnSummary;
}

export interface SteerTurnInput {
  prompt: string;
  attachments?: LocalInputReference[];
}

export interface LocalInputReference {
  projectId?: string;
  uploadId?: string;
  relativePath: string;
  kind: "file" | "directory";
}

export interface FileEntry {
  name: string;
  relativePath: string;
  kind: "file" | "directory";
  size?: number;
  modifiedAt?: string;
  downloadable: boolean;
}

export interface ResolvedFileEntry extends FileEntry {
  projectId: string;
}

export interface FileListing {
  projectId: string;
  relativePath: string;
  entries: FileEntry[];
}

export interface DiagnosticSnapshot {
  generatedAt: string;
  version: string;
  appServerVersion?: string;
  capabilities: ProductCapabilities;
  listener: {
    host: string;
    port: number;
    basePath: string;
  };
  warnings: string[];
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}
