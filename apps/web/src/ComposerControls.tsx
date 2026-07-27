import { useState } from "react";
import type {
  ApprovalRequest,
  CollaborationModeOption,
  ConversationItem,
  ModelOption,
  PermissionProfileOption,
  QueuedTurnItem,
  ReasoningEffort,
} from "@codex-local-remote/contracts";
import { Button, Icon, Sheet, type IconName } from "@codex-local-remote/ui";
import {
  composerToolActions,
  CODEX_DEFAULT_SERVICE_TIER,
  modelComposerLabel,
  serviceTierChoices,
  serviceTierOptions,
  type ComposerCapabilities,
  type ServiceTierChoice,
} from "./composer-product";
import { normalizeReasoningEffortForModel } from "./model-effort";

const effortLabels: Readonly<Record<string, string>> = {
  none: "无",
  minimal: "极简",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  ultra: "Ultra（最高）",
};

export function reasoningEffortLabel(effort: ReasoningEffort | undefined): string {
  if (effort === undefined) return "由 Codex 决定";
  return effortLabels[effort] ?? effort;
}

export type ComposerDestination = "steer" | "queue";

export function DeliveryModeSwitch({
  mode,
  queueSupported,
  onChange,
}: {
  mode: ComposerDestination;
  queueSupported: boolean;
  onChange: (mode: ComposerDestination) => void;
}) {
  return (
    <div className="delivery-switch" data-testid="delivery-mode">
      <span>发送到</span>
      <button
        aria-pressed={mode === "steer"}
        data-testid="delivery-steer"
        onClick={() => onChange("steer")}
        type="button"
      >
        当前回复
      </button>
      {queueSupported ? (
        <button
          aria-pressed={mode === "queue"}
          data-testid="delivery-queue"
          onClick={() => onChange("queue")}
          type="button"
        >
          下一轮
        </button>
      ) : null}
    </div>
  );
}

export function PlanProgressControl({
  plan,
}: {
  plan: Extract<ConversationItem, { kind: "plan-progress" }>;
}) {
  const firstUnfinishedStep = plan.steps.findIndex((step) => step.status !== "completed");
  const currentStep = firstUnfinishedStep >= 0 ? firstUnfinishedStep + 1 : plan.steps.length;
  const completedSteps = plan.steps.filter((step) => step.status === "completed").length;

  return (
    <details className="composer-plan-progress" data-testid="composer-plan-progress">
      <summary aria-label={`查看计划进度，第 ${currentStep}/${plan.steps.length} 步`}>
        <span className="composer-plan-progress__ring" aria-hidden="true">
          {currentStep}
        </span>
        <strong>
          第 {currentStep}/{plan.steps.length} 步
        </strong>
        <Icon name="chevron-down" size={14} />
      </summary>
      <div className="composer-plan-progress__popover">
        <header>
          <span>
            <strong>任务进度</strong>
            <small>
              {completedSteps}/{plan.steps.length} 步已完成
            </small>
          </span>
        </header>
        {plan.explanation ? <p>{plan.explanation}</p> : null}
        <ol>
          {plan.steps.map((step, index) => (
            <li
              className={`composer-plan-progress__step composer-plan-progress__step--${step.status}`}
              key={`${index}-${step.text}`}
            >
              <span aria-hidden="true">
                <Icon
                  name={
                    step.status === "completed"
                      ? "check"
                      : step.status === "inProgress"
                        ? "activity"
                        : "clock"
                  }
                  size={14}
                />
              </span>
              <span>
                <small>第 {index + 1} 步</small>
                {step.text}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}

function selectedTier(
  model: ModelOption | undefined,
  serviceTier: string | null | undefined,
): ServiceTierChoice {
  if (serviceTier === null || serviceTier === undefined) {
    return CODEX_DEFAULT_SERVICE_TIER;
  }
  return (
    serviceTierOptions(model).find((option) => option.id === serviceTier) ??
    CODEX_DEFAULT_SERVICE_TIER
  );
}

export function ComposerSettingsButton({
  disabled,
  effort,
  model,
  models,
  onEffort,
  onModel,
  onOpen,
  serviceTier,
  serviceTiersSupported,
}: {
  disabled?: boolean;
  effort: ReasoningEffort | undefined;
  model: string;
  models: ModelOption[];
  onEffort: (effort: ReasoningEffort | undefined) => void;
  onModel: (model: string) => void;
  onOpen: () => void;
  serviceTier?: string | null;
  serviceTiersSupported: boolean;
}) {
  const selected = models.find((option) => option.id === model);
  const displayedEffort = selected ? normalizeReasoningEffortForModel(selected, effort) : effort;
  const tier = serviceTiersSupported ? selectedTier(selected, serviceTier) : undefined;
  const detailedLabel = [
    selected ? modelComposerLabel(selected.displayName) : model,
    reasoningEffortLabel(displayedEffort),
    tier?.label,
  ]
    .filter(Boolean)
    .join(" · ");
  const compactLabel = [
    selected ? modelComposerLabel(selected.displayName) : model,
    reasoningEffortLabel(displayedEffort),
    tier ? (tier.id === null ? "标准" : tier.label) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="composer-settings-control">
      <button
        aria-label={`下一轮设置：${detailedLabel}`}
        className="composer-settings-button"
        data-testid="composer-settings-open"
        disabled={disabled}
        onClick={onOpen}
        type="button"
      >
        <span className="next-turn-badge">下一轮</span>
        <span className="composer-settings-button__label">
          {compactLabel || "选择模型与思考等级"}
        </span>
        <Icon name="chevron-down" size={14} />
      </button>
      <select
        aria-hidden="true"
        className="composer-compat-select composer-compat-select--model"
        data-testid="next-turn-model"
        onChange={(event) => onModel(event.target.value)}
        tabIndex={-1}
        value={model}
      >
        {!selected && model ? <option value={model}>{model}</option> : null}
        {models.map((option) => (
          <option key={option.id} value={option.id}>
            {option.displayName}
          </option>
        ))}
      </select>
      {selected?.supportedReasoningEfforts.length ? (
        <select
          aria-hidden="true"
          className="composer-compat-select composer-compat-select--effort"
          data-testid="next-turn-effort"
          onChange={(event) => onEffort(event.target.value)}
          tabIndex={-1}
          value={displayedEffort}
        >
          {selected.supportedReasoningEfforts.map((option) => (
            <option key={option} value={option}>
              {reasoningEffortLabel(option)}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

function OptionButton({
  active,
  description,
  disabled,
  label,
  onClick,
}: {
  active: boolean;
  description?: string;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={`composer-option ${active ? "is-selected" : ""}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span>
        <strong>{label}</strong>
        {description ? <small>{description}</small> : null}
      </span>
      {active ? <Icon name="check" size={17} /> : null}
    </button>
  );
}

export function ComposerSettingsSheet({
  busy,
  demo = false,
  effort,
  model,
  models,
  onApply,
  onClose,
  onEffort,
  onModel,
  onServiceTier,
  open,
  serviceTier,
  serviceTiersSupported,
}: {
  busy: boolean;
  demo?: boolean;
  effort: ReasoningEffort | undefined;
  model: string;
  models: ModelOption[];
  onApply: () => void;
  onClose: () => void;
  onEffort: (effort: ReasoningEffort | undefined) => void;
  onModel: (model: string) => void;
  onServiceTier: (tier: string | null) => void;
  open: boolean;
  serviceTier?: string | null;
  serviceTiersSupported: boolean;
}) {
  const selected = models.find((option) => option.id === model);
  const normalizedEffort = selected ? normalizeReasoningEffortForModel(selected, effort) : effort;
  const tiers = serviceTiersSupported ? serviceTierChoices(selected) : [];
  const currentTier = selectedTier(selected, serviceTier);
  return (
    <Sheet
      description="这些设置只影响下一轮，不会热切换正在运行的回复。"
      footer={
        <Button disabled={busy} onClick={onApply} variant="primary">
          {busy ? "正在应用…" : "应用于下一轮"}
        </Button>
      }
      onClose={onClose}
      open={open}
      title="下一轮设置"
    >
      <div className="composer-sheet-section">
        <h3>模型</h3>
        {demo ? (
          <p
            className="composer-sheet-note composer-sheet-note--demo"
            data-testid="demo-model-note"
          >
            当前是演示模式，下面只用于展示交互。正式连接会实时显示 Codex Desktop
            当前提供的全部模型，并且只显示所选模型真实支持的速度档。
          </p>
        ) : null}
        {!selected && model ? (
          <p className="composer-sheet-note" data-testid="runtime-model-outside-catalog">
            当前实际模型：{model}。它不在 Codex
            当前可选目录中；只有主动选择下方模型后才会切换下一轮。
          </p>
        ) : null}
        <div className="composer-option-list">
          {models.map((option) => (
            <OptionButton
              active={option.id === selected?.id}
              {...(option.description ? { description: option.description } : {})}
              key={option.id}
              label={option.displayName}
              onClick={() => onModel(option.id)}
            />
          ))}
        </div>
      </div>
      <div className="composer-sheet-section">
        <h3>思考等级</h3>
        {selected?.supportedReasoningEfforts.length ? (
          <div className="composer-choice-row">
            {selected.supportedReasoningEfforts.map((option) => (
              <button
                aria-pressed={option === normalizedEffort}
                className={option === normalizedEffort ? "is-selected" : ""}
                key={option}
                onClick={() => onEffort(option)}
                type="button"
              >
                {reasoningEffortLabel(option)}
              </button>
            ))}
          </div>
        ) : (
          <p className="composer-sheet-note">
            {effort
              ? `当前实际思考等级：${reasoningEffortLabel(effort)}；Codex 未公开这个模型的可选等级。`
              : "当前模型未公开可选思考等级，将由 Codex 决定。"}
          </p>
        )}
      </div>
      {tiers.length ? (
        <div className="composer-sheet-section">
          <h3>速度</h3>
          <div className="composer-option-list composer-option-list--compact">
            {tiers.map((tier) => (
              <OptionButton
                active={tier.id === currentTier?.id}
                {...(tier.description ? { description: tier.description } : {})}
                key={tier.id ?? "codex-default"}
                label={tier.label}
                onClick={() => onServiceTier(tier.id)}
              />
            ))}
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}

export function PermissionButton({
  disabled,
  label,
  onOpen,
}: {
  disabled?: boolean;
  label: string;
  onOpen: () => void;
}) {
  return (
    <button
      aria-label={`下一轮权限：${label}`}
      className="composer-permission-button"
      data-testid="composer-permission-open"
      disabled={disabled}
      onClick={onOpen}
      type="button"
    >
      <Icon name="shield" size={18} />
    </button>
  );
}

export function PermissionSheet({
  onChange,
  onClose,
  open,
  profiles,
  value,
}: {
  onChange: (id: string) => void;
  onClose: () => void;
  open: boolean;
  profiles: PermissionProfileOption[];
  value: string;
}) {
  return (
    <Sheet
      description="权限只影响下一轮；当前正在执行的操作仍按原权限继续。"
      onClose={onClose}
      open={open}
      title="下一轮权限"
    >
      <div className="composer-option-list">
        {profiles.map((profile) => (
          <OptionButton
            active={profile.id === value}
            {...(profile.description ? { description: profile.description } : {})}
            disabled={!profile.allowed}
            key={profile.id}
            label={profile.id.replace(/[_-]+/gu, " ")}
            onClick={() => {
              onChange(profile.id);
              onClose();
            }}
          />
        ))}
      </div>
    </Sheet>
  );
}

const toolIcons: Record<"attach" | "goal" | "plan" | "compact", IconName> = {
  attach: "paperclip",
  goal: "target",
  plan: "layers",
  compact: "spark",
};

export function ComposerToolsSheet({
  canAttach,
  canCompact,
  capabilities,
  collaborationModes,
  onClose,
  onAttach,
  onCompact,
  onGoal,
  onPlan,
  open,
}: {
  canAttach: boolean;
  canCompact: boolean;
  capabilities: ComposerCapabilities | undefined;
  collaborationModes: CollaborationModeOption[];
  onClose: () => void;
  onAttach: () => void;
  onCompact: () => void;
  onGoal: () => void;
  onPlan: () => void;
  open: boolean;
}) {
  const actions = composerToolActions({
    capabilities,
    canAttach,
    canCompact,
    hasCollaborationModes: collaborationModes.some((mode) => mode.available),
  });
  return (
    <Sheet
      description="这里只显示当前 Codex 运行时确认支持的操作。"
      onClose={onClose}
      open={open}
      title="对话工具"
    >
      {actions.length ? (
        <div className="composer-tools-list">
          {actions.map((action) => (
            <button
              disabled={action.disabled}
              key={action.id}
              onClick={() => {
                if (action.id === "attach") onAttach();
                if (action.id === "goal") onGoal();
                if (action.id === "plan") onPlan();
                if (action.id === "compact") onCompact();
              }}
              type="button"
            >
              <span className="composer-tools-list__icon">
                <Icon name={toolIcons[action.id]} size={19} />
              </span>
              <span>
                <strong>{action.label}</strong>
                <small>{action.description}</small>
              </span>
              <Icon name="chevron-right" size={17} />
            </button>
          ))}
        </div>
      ) : (
        <p className="composer-sheet-empty">当前运行时没有可用的附加工具。</p>
      )}
    </Sheet>
  );
}

export function GoalSheet({
  busy,
  onChange,
  onClear,
  onClose,
  onSave,
  open,
  value,
}: {
  busy: boolean;
  onChange: (value: string) => void;
  onClear: () => void;
  onClose: () => void;
  onSave: () => void;
  open: boolean;
  value: string;
}) {
  return (
    <Sheet
      description="目标会随这个对话保存；要立刻改变当前回复，请同时发送一条引导。"
      footer={
        <>
          <Button disabled={busy || !value.trim()} onClick={onSave} variant="primary">
            保存目标
          </Button>
          <Button disabled={busy} onClick={onClear} variant="ghost">
            清除
          </Button>
        </>
      }
      onClose={onClose}
      open={open}
      title="任务目标"
    >
      <label className="goal-editor">
        <span>持续目标</span>
        <textarea
          maxLength={2_000}
          onChange={(event) => onChange(event.target.value)}
          placeholder="例如：完成可发布的实现，并用真实移动端流程验收。"
          rows={5}
          value={value}
        />
      </label>
    </Sheet>
  );
}

export function PlanModeSheet({
  modes,
  onChange,
  onClose,
  open,
  value,
}: {
  modes: CollaborationModeOption[];
  onChange: (id: string) => void;
  onClose: () => void;
  open: boolean;
  value: string;
}) {
  return (
    <Sheet
      description="计划模式只影响下一轮；当前回复可通过“发送到当前回复”继续引导。"
      onClose={onClose}
      open={open}
      title="计划模式"
    >
      <div className="composer-option-list">
        {modes.map((mode) => (
          <OptionButton
            active={mode.id === value}
            {...(mode.description ? { description: mode.description } : {})}
            disabled={!mode.available}
            key={mode.id}
            label={mode.displayName}
            onClick={() => {
              onChange(mode.id);
              onClose();
            }}
          />
        ))}
      </div>
    </Sheet>
  );
}

export function InlineDecisionStack({
  approvals,
  onOpen,
}: {
  approvals: ApprovalRequest[];
  onOpen: (approval: ApprovalRequest) => void;
}) {
  if (!approvals.length) return null;
  return (
    <section
      aria-label="当前对话等待处理"
      className="thread-decision-stack"
      data-testid="thread-approval-stack"
    >
      {approvals.map((approval) => (
        <button key={approval.id} onClick={() => onOpen(approval)} type="button">
          <span className="thread-decision-stack__icon">
            <Icon name={approval.questions?.length ? "message" : "shield"} size={18} />
          </span>
          <span>
            <strong>{approval.title}</strong>
            <small>
              {approval.questions?.[0]?.question ??
                approval.explanation ??
                "Codex 正在等待你的决定"}
            </small>
          </span>
          <span className="thread-decision-stack__action">处理</span>
        </button>
      ))}
    </section>
  );
}

export function QueueShelf({
  busyId,
  canSteer = false,
  items,
  running,
  onDelete,
  onDispatch,
  onMove,
  onSteer,
  onUpdate,
}: {
  busyId?: string;
  canSteer?: boolean;
  items: QueuedTurnItem[];
  running: boolean;
  onDelete: (item: QueuedTurnItem) => void;
  onDispatch: (item: QueuedTurnItem) => void;
  onMove: (item: QueuedTurnItem, offset: -1 | 1) => void;
  onSteer?: (item: QueuedTurnItem) => void;
  onUpdate: (item: QueuedTurnItem, prompt: string) => void;
}) {
  const [editingId, setEditingId] = useState("");
  const [editDraft, setEditDraft] = useState("");
  if (!items.length) return null;
  return (
    <section className="queue-shelf" data-testid="queue-shelf">
      <header>
        <span>
          <Icon name="clock" size={15} />
          下一轮队列
        </span>
        <b>{items.length} 条</b>
      </header>
      <div className="queue-shelf__items">
        {items.map((item, index) => {
          const editing = editingId === item.id;
          const busy = busyId === item.id;
          const recoverable =
            item.state === "queued" || item.state === "paused" || item.state === "ambiguous";
          const dispatchLabel =
            item.state === "ambiguous"
              ? "确认重试发送结果未知的消息"
              : item.state === "paused"
                ? "重新发送这条消息"
                : running
                  ? "当前回复结束后可手动发送"
                  : "立即发送这条消息";
          return (
            <article className="queue-item" data-testid="queue-item" key={item.id}>
              <span className="queue-item__order">{index + 1}</span>
              <div className="queue-item__body">
                {editing ? (
                  <textarea
                    aria-label="编辑排队消息"
                    onChange={(event) => setEditDraft(event.target.value)}
                    rows={2}
                    value={editDraft}
                  />
                ) : (
                  <p>{item.prompt ?? "这条消息正在由 Codex 处理"}</p>
                )}
                {item.attachments?.length ? (
                  <small className="queue-item__attachments">
                    <Icon name="paperclip" size={13} />
                    {item.attachments.length} 个文件或文件夹
                  </small>
                ) : null}
                <div className="queue-item__actions">
                  {editing ? (
                    <>
                      <Button
                        disabled={!editDraft.trim() || busy}
                        onClick={() => {
                          onUpdate(item, editDraft.trim());
                          setEditingId("");
                        }}
                        size="compact"
                        variant="primary"
                      >
                        保存
                      </Button>
                      <Button onClick={() => setEditingId("")} size="compact" variant="ghost">
                        取消
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        aria-label="上移排队消息"
                        disabled={!recoverable || index === 0 || busy}
                        icon="arrow-up"
                        onClick={() => onMove(item, -1)}
                        size="icon"
                        variant="ghost"
                      />
                      <Button
                        aria-label="下移排队消息"
                        disabled={!recoverable || index === items.length - 1 || busy}
                        icon="arrow-down"
                        onClick={() => onMove(item, 1)}
                        size="icon"
                        variant="ghost"
                      />
                      <Button
                        aria-label="编辑排队消息"
                        disabled={!recoverable || !item.prompt || busy}
                        icon="edit"
                        onClick={() => {
                          setEditingId(item.id);
                          setEditDraft(item.prompt ?? "");
                        }}
                        size="icon"
                        variant="ghost"
                      />
                      <Button
                        aria-label="删除排队消息"
                        disabled={!recoverable || busy}
                        icon="trash"
                        onClick={() => onDelete(item)}
                        size="icon"
                        variant="ghost"
                      />
                      {canSteer && item.state !== "ambiguous" && onSteer ? (
                        <Button
                          aria-label="将排队消息改为当前引导"
                          className="queue-item__steer"
                          disabled={!recoverable || busy}
                          icon="target"
                          onClick={() => onSteer(item)}
                          size="compact"
                          variant="secondary"
                        >
                          改为引导
                        </Button>
                      ) : (
                        <Button
                          aria-label={dispatchLabel}
                          disabled={!recoverable || running || busy}
                          icon="send"
                          onClick={() => onDispatch(item)}
                          size="icon"
                          variant="secondary"
                        />
                      )}
                    </>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
