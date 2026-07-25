export const API_SCHEMA_VERSION = 1 as const;

export type CapabilityState = "available" | "degraded" | "unavailable";
export type ThreadMode = "managed" | "desktop-snapshot";
export type RunState = "idle" | "running" | "waiting-for-approval" | "failed" | "complete";

export interface ProductCapabilities {
  appServer: CapabilityState;
  desktopSnapshots: CapabilityState;
  fileBrowser: CapabilityState;
  liveEvents: CapabilityState;
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
  isDefault: boolean;
}

/**
 * app-server deliberately treats reasoning effort as an open string so that a
 * newly introduced level can flow through without requiring a remote-client
 * release first.
 */
export type ReasoningEffort = string;
export type PermissionMode = "read-only" | "workspace-write" | "ask";

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
  projectId?: string;
  cwdLabel?: string;
  mode: ThreadMode;
  state: RunState;
  updatedAt: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  parentThreadId?: string;
  childCount?: number;
  snapshotDelaySeconds?: number;
}

export type ConversationItem =
  | {
      id: string;
      kind: "user-message" | "assistant-message" | "reasoning-summary";
      text: string;
      createdAt?: string;
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
      createdAt?: string;
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
      createdAt?: string;
    };

export interface ThreadDetail extends ThreadSummary {
  items: ConversationItem[];
  activeTurnId?: string;
  availableActions: {
    steer: boolean;
    interrupt: boolean;
    reply: boolean;
    changeModelNextTurn: boolean;
  };
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
    | "diagnostic";
  emittedAt: string;
  threadId?: string;
  turnId?: string;
  payload: T;
}

export interface CreateThreadInput {
  projectId: string;
  prompt: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  permissionMode?: PermissionMode;
  collaborationMode?: string;
}

export interface SendTurnInput {
  prompt: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface SteerTurnInput {
  prompt: string;
}

export interface FileEntry {
  name: string;
  relativePath: string;
  kind: "file" | "directory";
  size?: number;
  modifiedAt?: string;
  downloadable: boolean;
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
