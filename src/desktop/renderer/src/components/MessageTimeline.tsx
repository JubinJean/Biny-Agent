/**
 * 对话时间线：逐轮渲染用户消息、思考过程、助手回复和工具活动。
 *
 * 数据由 `buildSessionTimeline` 算好，这里只做渲染和局部交互（展开思考、复制、编辑重发、
 * 回滚文件等）。整体用 memo 包住，因为流式输出期间父组件会高频重渲染。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ThinkingOrb } from "thinking-orbs";
import type { PermissionResult } from "../../../../permission/PermissionManager.js";
import type { SessionUsage } from "../../../../session/metadata.js";
import { splitAttachmentReferences, type AttachmentReference } from "../../../attachmentReferences.js";
import { copyToClipboard } from "../copyToClipboard.js";
import { useInlineImage } from "../inlineImage.js";
import { listChangedFiles, type TimelineReasoningStep, type TimelineStep, type TimelineTurn } from "../sessionTimeline.js";
import { reasoningDetailText } from "../reasoningPresentation.js";
import { buildUsageDetailRows, finishReasonTone, formatDuration, formatMessageClock, formatRunDuration, isRunErrorRetryable, isRunErrorStatus, turnMetrics, type TurnMetrics } from "../chatModel.js";
import { speak, speechSupported } from "../speech.js";
import { CopyButton } from "./CopyButton.js";
import { Icon } from "./Icon.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { useTypewriter } from "./useTypewriter.js";
import { ToolActivity } from "./ToolActivity.js";
import { CompactionRow } from "./chat/NoticeRow.js";
import { MessageClock } from "./chat/MessageClock.js";
import { ThinkingBlock } from "./chat/ThinkingBlock.js";
import { ExecutionGroup, type ExecutionGroupStep } from "./chat/ExecutionGroup.js";
import { ChangesSummary } from "./chat/ChangesSummary.js";
import { RunErrorCard, RunErrorRow } from "./chat/RunErrorCard.js";

interface MessageTimelineProps {
  projectId: string;
  turns: TimelineTurn[];
  pendingUserMessage?: PendingUserMessage;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  thinking: boolean;
  onRetry(targetMessageId: string, input: string, idempotencyKey: string): Promise<void>;
  onSwitchVersion(messageId: string, direction: "prev" | "next"): Promise<void>;
  /** 点「编辑」：把消息文本交给底部输入框（Alma 式编辑），提交由 Composer 走 App 回调。 */
  onEditRequest(turn: TimelineTurn): void;
  /** 进行中的编辑重写：App 提交时置位，替换回合出现后由 App 清除。 */
  editInFlight?: { turnId: string; user: string; userMessageIndex?: number };
  onCreateBranch(): void;
  onRollbackFiles(turn: TimelineTurn): void;
  onDeleteUserMessage(turnId: string): void;
}

interface PendingUserMessage {
  id: string;
  messageId?: string;
  content: string;
}

interface OptimisticRewrite {
  turnId: string;
  user: string;
  userMessageIndex?: number;
  assistantMessageId?: string;
  mode: "retry" | "edit";
  settled: boolean;
}

export const MessageTimeline = memo(function MessageTimeline({ projectId, turns, pendingUserMessage, onPreviewFile, onOpenExternal, onResolvePermission, thinking, onRetry, onSwitchVersion, onEditRequest, editInFlight, onCreateBranch, onRollbackFiles, onDeleteUserMessage }: MessageTimelineProps): React.JSX.Element {
  // 重试会先把目标之后的消息从视图中撤掉，再等待新回合流入；这里保留同样的乐观投影。
  // 编辑的重写投影来自 App（editInFlight），提交入口在底部输入框，不经过本组件状态。
  const [optimisticRewrite, setOptimisticRewrite] = useState<OptimisticRewrite>();

  const startOptimisticRewrite = useCallback((turn: TimelineTurn, mode: OptimisticRewrite["mode"], user = turn.user): void => {
    setOptimisticRewrite({
      turnId: turn.id,
      user,
      userMessageIndex: turn.userMessageIndex,
      assistantMessageId: turn.assistantMessageId,
      mode,
      settled: false
    });
  }, []);

  const settleOptimisticRewrite = useCallback((turnId: string, succeeded: boolean): void => {
    setOptimisticRewrite((current) => {
      if (!current || current.turnId !== turnId) return current;
      return succeeded ? { ...current, settled: true } : undefined;
    });
  }, []);

  // 编辑投影与重试投影共用同一套渲染；编辑投影的清除（替换回合已出现）由 App 负责。
  const rewrite: OptimisticRewrite | undefined = useMemo(
    () => optimisticRewrite ?? (editInFlight
      ? { turnId: editInFlight.turnId, user: editInFlight.user, userMessageIndex: editInFlight.userMessageIndex, mode: "edit", settled: false }
      : undefined),
    [optimisticRewrite, editInFlight]
  );

  useEffect(() => {
    const pending = optimisticRewrite;
    if (!pending?.settled || pending.mode !== "retry") return;
    const target = turns.find((turn) => turn.id === pending.turnId);
    const hasRetryReplacement = target !== undefined
      && (target.retryOfMessageId !== undefined
        || target.assistantMessageId !== pending.assistantMessageId);
    if (hasRetryReplacement) {
      setOptimisticRewrite((current) => current?.turnId === pending.turnId ? undefined : current);
    }
  }, [optimisticRewrite, turns]);

  const hasRealPendingMessage = pendingUserMessage !== undefined && turns.some((turn) => (
    pendingUserMessage.messageId !== undefined
      ? turn.userMessageId === pendingUserMessage.messageId
      : turn.user === pendingUserMessage.content
  ));
  const displayedTurns = useMemo(() => {
    const pending = rewrite;
    if (!pending) return turns;
    const targetIndex = turns.findIndex((turn) => turn.id === pending.turnId);
    const replacementIndex = targetIndex >= 0
      ? targetIndex
      : pending.userMessageIndex === undefined
        ? -1
        : turns.findIndex((turn) => turn.userMessageIndex === pending.userMessageIndex && turn.user === pending.user);
    if (replacementIndex >= 0) {
      const target = turns[replacementIndex];
      if (!target) return turns;
      return [...turns.slice(0, replacementIndex), optimisticRewriteTurn(target, pending.user)];
    }
    return [...turns, optimisticRewriteTurn({
      id: pending.turnId,
      user: pending.user,
      userMessageIndex: pending.userMessageIndex,
      userMessageId: undefined,
      assistant: "",
      assistantMessageId: undefined,
      versionSlotId: undefined,
      versionIndex: undefined,
      versionCount: undefined,
      retryOfMessageId: undefined,
      reasoning: "",
      reasoningStatus: undefined,
      reasoningDurationMs: undefined,
      reasoningStartedAt: undefined,
      skills: [],
      status: "running",
      model: undefined,
      tools: [],
      steps: [],
      error: undefined,
      durationMs: undefined,
      usage: undefined,
      timestamp: undefined,
      resumable: undefined,
      firstTokenAt: undefined,
      startedAt: undefined,
      ttftMs: undefined,
      decodeMs: undefined,
      decodeTokens: undefined,
      finishReason: undefined
    }, pending.user)];
  }, [rewrite, turns]);

  // 失败不在消息流里展示：最近一次失败由 Workspace 的生成错误横幅（输入框上方）承载，
  // 重试入口在消息操作条的「重新生成」，与 Alma 的失败呈现一致。
  // 只有最近的失败/未完成轮次展开完整错误卡；更早的错误折叠成一行，避免历史错误长期占据时间线。
  const latestFailedTurnId = useMemo(() => {
    for (let index = displayedTurns.length - 1; index >= 0; index -= 1) {
      const turn = displayedTurns[index];
      if (turn && turn.error && isRunErrorStatus(turn.status)) return turn.id;
    }
    return undefined;
  }, [displayedTurns]);

  // 失败/未完成轮次在消息流内展示错误（卡片/一行式），输入框上方的生成错误横幅只承载最近一次。
  return (
    <div className="message-timeline">
      {pendingUserMessage && !hasRealPendingMessage ? (
        <PendingUserMessage
          content={pendingUserMessage.content}
          id={pendingUserMessage.id}
          onOpenExternal={onOpenExternal}
          onPreviewFile={onPreviewFile}
          projectId={projectId}
        />
      ) : null}
      {displayedTurns.map((turn) => (
        <Turn
          key={turn.id}
          errorExpanded={turn.id === latestFailedTurnId}
          onCreateBranch={onCreateBranch}
          onDeleteUserMessage={onDeleteUserMessage}
          onEditRequest={onEditRequest}
          onPreviewFile={onPreviewFile}
          onOpenExternal={onOpenExternal}
          onResolvePermission={onResolvePermission}
          onRollbackFiles={onRollbackFiles}
          onRetry={onRetry}
          onRetryStart={startOptimisticRewrite}
          onRetrySettled={settleOptimisticRewrite}
          onSwitchVersion={onSwitchVersion}
          projectId={projectId}
          turn={turn}
        />
      ))}
      {rewrite && !thinking ? (
        <div className="biny-thinking-status" role="status">
          <ThinkingOrb aria-label="思考中" className="biny-thinking-status-orb" size={20} state="solving" theme="auto" />
          <span className="biny-thinking-status-label chat-shimmer-text">思考中…</span>
        </div>
      ) : null}
    </div>
  );
});

const PendingUserMessage = memo(function PendingUserMessage({ content, id, onOpenExternal, onPreviewFile, projectId }: {
  content: string;
  id: string;
  onOpenExternal(url: string): void;
  onPreviewFile(path: string): void;
  projectId: string;
}): React.JSX.Element {
  const message = splitAttachmentReferences(content);
  return (
    <article className="chat-message user-message is-pending-entry" data-message-id={id} data-sender="user">
      <div className="user-bubble">
        {message.text ? <MarkdownContent content={message.text} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} projectId={projectId} /> : null}
        {message.attachments.length ? <MessageAttachments attachments={message.attachments} projectId={projectId} /> : null}
      </div>
    </article>
  );
});

function optimisticRewriteTurn(turn: TimelineTurn, user: string): TimelineTurn {
  return {
    ...turn,
    user,
    assistant: "",
    reasoning: "",
    reasoningStatus: undefined,
    reasoningDurationMs: undefined,
    reasoningStartedAt: undefined,
    skills: [],
    status: "running",
    model: undefined,
    tools: [],
    steps: [],
    error: undefined,
    durationMs: undefined,
    usage: undefined,
    firstTokenAt: undefined,
    startedAt: undefined,
    ttftMs: undefined,
    decodeMs: undefined,
    decodeTokens: undefined,
    finishReason: undefined
  };
}

const Turn = memo(function Turn({
  projectId,
  turn,
  errorExpanded,
  onPreviewFile,
  onOpenExternal,
  onResolvePermission,
  onRetry,
  onRetryStart,
  onRetrySettled,
  onSwitchVersion,
  onEditRequest,
  onCreateBranch,
  onRollbackFiles,
  onDeleteUserMessage
}: {
  projectId: string;
  turn: TimelineTurn;
  /** 是否为最近的失败轮次：驱动错误展示默认展开还是折叠。 */
  errorExpanded: boolean;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  onRetry(targetMessageId: string, input: string, idempotencyKey: string): Promise<void>;
  onRetryStart(turn: TimelineTurn, mode: "retry" | "edit", user?: string): void;
  onRetrySettled(turnId: string, succeeded: boolean): void;
  onSwitchVersion(messageId: string, direction: "prev" | "next"): Promise<void>;
  onEditRequest(turn: TimelineTurn): void;
  onCreateBranch(): void;
  onRollbackFiles(turn: TimelineTurn): void;
  onDeleteUserMessage(turnId: string): void;
}): React.JSX.Element {
  const running = turn.status === "running" || turn.status === "waiting_permission";
  // 失败/未完成的轮次和正常结束一样渲染完整收尾：错误展示落在模型消息位置（卡片或一行式），
  // footer 照常出现，重试入口同时在错误卡和操作条里。
  const runFailed = !running && isRunErrorStatus(turn.status);
  // 完整错误卡只给「当场发生的失败」：挂载期间经历过运行态再落败才算当场；
  // 重新打开会话时看到的旧失败（哪怕是最新的那条）一律默认折叠成一行，避免旧错误长期占着时间线。
  const [sawRunning, setSawRunning] = useState(running);
  useEffect(() => {
    if (running && !sawRunning) setSawRunning(true);
  }, [running, sawRunning]);
  const liveFailure = runFailed && sawRunning;
  const retryPromiseRef = useRef<Promise<void> | undefined>(undefined);
  const retry = useCallback((): Promise<void> => {
    if (running) return Promise.resolve();
    const targetMessageId = turn.assistantMessageId ?? turn.userMessageId;
    if (!turn.user || !targetMessageId) return Promise.resolve();
    const existing = retryPromiseRef.current;
    if (existing) return existing;
    onRetryStart(turn, "retry");
    const pending = Promise.resolve().then(() => onRetry(targetMessageId, turn.user, globalThis.crypto.randomUUID()));
    retryPromiseRef.current = pending;
    void pending.then(
      () => {
        if (retryPromiseRef.current === pending) retryPromiseRef.current = undefined;
        onRetrySettled(turn.id, true);
      },
      () => {
        if (retryPromiseRef.current === pending) retryPromiseRef.current = undefined;
        onRetrySettled(turn.id, false);
      }
    );
    return pending;
  }, [onRetry, onRetrySettled, onRetryStart, running, turn]);
  const switchVersion = useCallback((direction: "prev" | "next"): Promise<void> => {
    if (!turn.assistantMessageId) return Promise.resolve();
    return onSwitchVersion(turn.assistantMessageId, direction);
  }, [onSwitchVersion, turn.assistantMessageId]);
  const canRetry = !running && Boolean(turn.user && (turn.assistantMessageId ?? turn.userMessageId));
  const executionSteps = turn.steps.length ? turn.steps : fallbackExecutionSteps(turn);
  // 收尾的「修改文件」卡：只在本轮真正落定（非运行态）且存在完成写入/编辑时出现。
  const completedChangedFiles = useMemo(
    () => running ? [] : listChangedFiles(turn).filter((file) => file.status === "completed"),
    [running, turn]
  );
  return (
    <section className={`timeline-turn is-${turn.status}`}>
      {turn.user ? (
        <UserMessage
          content={turn.user}
          hasChangedFiles={listChangedFiles(turn).length > 0}
          onCreateBranch={onCreateBranch}
          onDelete={() => onDeleteUserMessage(turn.id)}
          onEdit={() => onEditRequest(turn)}
          onOpenExternal={onOpenExternal}
          onPreviewFile={onPreviewFile}
          onRegenerate={canRetry ? retry : undefined}
          onRollbackFiles={() => onRollbackFiles(turn)}
          projectId={projectId}
          time={turn.timestamp}
        />
      ) : null}
      <article className="chat-message desktop-assistant-message" data-sender="assistant">
        <div className="agent-response">
        {executionSteps.length || turn.skills.length ? (
          <ExecutionTimeline
            onPreviewFile={onPreviewFile}
            onOpenExternal={onOpenExternal}
            onResolvePermission={onResolvePermission}
            projectId={projectId}
            running={running}
            steps={executionSteps}
            skills={turn.skills}
          />
        ) : null}
        {!executionSteps.some((step) => step.kind === "assistant") && turn.assistant ? <TypewriterMarkdown active={running} content={turn.assistant} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} projectId={projectId} /> : null}

        {runFailed && turn.error ? (
          <TurnRunError
            expandedByDefault={errorExpanded && liveFailure}
            message={turn.error}
            onRetry={retry}
            retryable={canRetry && !turn.resumable && isRunErrorRetryable(turn.error)}
            status={turn.status}
          />
        ) : null}

        {turn.assistant || runFailed ? (
          <AssistantActions
            content={turn.assistant}
            finishReason={turn.finishReason}
            metrics={turnMetrics(turn)}
            onCreateBranch={onCreateBranch}
            onRegenerate={canRetry ? retry : undefined}
            onSwitchVersion={turn.versionCount && turn.versionCount > 1 ? switchVersion : undefined}
            runMs={turn.durationMs}
            timestamp={turn.timestamp}
            usage={turn.usage}
            versionCount={turn.versionCount}
            versionIndex={turn.versionIndex}
          />
        ) : null}

        {completedChangedFiles.length ? (
          <ChangesSummary files={completedChangedFiles} onPreviewFile={onPreviewFile} />
        ) : null}

        </div>
      </article>
    </section>
  );
});

function fallbackExecutionSteps(turn: TimelineTurn): TimelineStep[] {
  if (!turn.reasoningStatus && !turn.reasoning && turn.durationMs === undefined) return [];
  return [{
    kind: "reasoning",
    id: `${turn.id}:reasoning:fallback`,
    content: turn.reasoning,
    status: turn.reasoningStatus,
    durationMs: turn.reasoningDurationMs ?? (turn.status === "running" || turn.status === "waiting_permission" ? undefined : turn.durationMs),
    completed: turn.status !== "running" && turn.status !== "waiting_permission"
  }];
}

/**
 * 轮次内联的错误展示：默认展开与否由「是否为当场发生且仍是最近的失败」决定，
 * 重开历史会话时一律折叠成一行。用户点行可展开、点 × 收起，之后以用户操作为准。
 */
const TurnRunError = memo(function TurnRunError({
  expandedByDefault,
  message,
  onRetry,
  retryable,
  status
}: {
  expandedByDefault: boolean;
  message: string;
  onRetry(): Promise<void>;
  retryable: boolean;
  status: TimelineTurn["status"];
}): React.JSX.Element | null {
  // undefined = 跟随默认值；用户点过行/×后以用户操作为准。重试期间组件会卸载，重挂载即恢复默认。
  const [override, setOverride] = useState<boolean>();
  if (override ?? expandedByDefault) {
    return (
      <RunErrorCard
        message={message}
        onDismiss={() => setOverride(false)}
        onRetry={retryable ? onRetry : undefined}
        status={status}
      />
    );
  }
  return <RunErrorRow message={message} onExpand={() => setOverride(true)} status={status} />;
});

/** 流式打字机版 Markdown：仅 reveal 新增量，历史/完结内容直出 */
const TypewriterMarkdown = memo(function TypewriterMarkdown({ active, content, onOpenExternal, onPreviewFile, projectId }: {
  active: boolean;
  content: string;
  onOpenExternal(url: string): void;
  onPreviewFile(path: string): void;
  projectId: string;
}): React.JSX.Element {
  const typed = useTypewriter(content, active);
  return (
    <div className={active ? "with-streaming-cursor" : undefined}>
      <MarkdownContent content={typed} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} projectId={projectId} />
    </div>
  );
});

function ExecutionTimeline({
  onPreviewFile,
  onOpenExternal,
  onResolvePermission,
  projectId,
  running,
  skills,
  steps
}: {
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  projectId: string;
  running: boolean;
  skills: string[];
  steps: TimelineStep[];
}): React.JSX.Element {
  return (
    <div className="execution-timeline">
      {skills.length ? (
        <div className="execution-step execution-skills">
          <Icon name="wand" size={14} />
          <span>使用 {String(skills.length)} 个技能</span>
          <span className="execution-skills-list">{skills.join(" · ")}</span>
        </div>
      ) : null}
      {groupExecutionSteps(steps).map((entry) => {
        // 连续的工具 + 思考步骤聚合成一个可展开块；单个步骤不套聚合壳。
        if (Array.isArray(entry)) {
          if (entry.length === 1) {
            const only = entry[0];
            // noUncheckedIndexedAccess：entry[0] 类型含 undefined，先收窄再判 kind。
            if (!only) return null;
            if (only.kind === "tool") {
              return <ToolActivity key={only.id} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} onResolvePermission={onResolvePermission} projectId={projectId} tool={only.tool} />;
            }
            return <ReasoningStepView key={only.id} running={running} step={only} />;
          }
          return (
            <ExecutionGroup
              key={entry[0]?.id ?? "execution-group"}
              onOpenExternal={onOpenExternal}
              onPreviewFile={onPreviewFile}
              onResolvePermission={onResolvePermission}
              projectId={projectId}
              running={running}
              steps={entry}
            />
          );
        }
        const step = entry;
        if (step.kind === "reasoning") {
          // 上下文压缩标记渲染为独立的压缩通知行。
          if (step.notice === "compaction") {
            return (
              <section className="execution-step" key={step.id}>
                <CompactionRow summary={step.status ?? ""} title="上下文已压缩" />
              </section>
            );
          }
          return <ReasoningStepView key={step.id} running={running} step={step} />;
        }
        if (step.kind === "user") {
          return (
            <div className="execution-step execution-user-step user-message" key={step.id}>
              <div className="user-bubble"><MarkdownContent breaks content={step.content} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} projectId={projectId} /></div>
            </div>
          );
        }
        if (step.kind === "tool") return null;
        if (step.summary) {
          return (
            <ActivitySummaryStep
              content={step.content}
              key={step.id}
              onOpenExternal={onOpenExternal}
              onPreviewFile={onPreviewFile}
              projectId={projectId}
            />
          );
        }
        return <div className="execution-step execution-assistant-step" key={step.id}><TypewriterMarkdown active={running} content={step.content} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} projectId={projectId} /></div>;
      })}
    </div>
  );
}

/**
 * 把连续的可聚合步骤（工具调用 + 非压缩通知的思考）收成一组；其余步骤原样保留顺序。
 *
 * 思考不再把工具组切断：reasoning 步骤与相邻 tool 步骤进同一个聚合块。压缩标记
 * （notice === "compaction"）、assistant 正文/摘要、用户插话仍然是分组断点。
 */
function groupExecutionSteps(steps: TimelineStep[]): Array<TimelineStep | ExecutionGroupStep[]> {
  const grouped: Array<TimelineStep | ExecutionGroupStep[]> = [];
  for (const step of steps) {
    if (!isGroupableStep(step)) {
      grouped.push(step);
      continue;
    }
    const last = grouped.at(-1);
    if (Array.isArray(last)) last.push(step);
    else grouped.push([step]);
  }
  return grouped;
}

function isGroupableStep(step: TimelineStep): step is ExecutionGroupStep {
  if (step.kind === "tool") return true;
  return step.kind === "reasoning" && step.notice !== "compaction";
}

function ActivitySummaryStep({ content, onOpenExternal, onPreviewFile, projectId }: {
  content: string;
  onOpenExternal(url: string): void;
  onPreviewFile(path: string): void;
  projectId: string;
}): React.JSX.Element {
  return (
    <div className="execution-step execution-assistant-step execution-summary-step">
      <MarkdownContent content={content} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} projectId={projectId} />
    </div>
  );
}

function ReasoningStepView({ running, step }: {
  running: boolean;
  step: TimelineReasoningStep;
}): React.JSX.Element {
  // The status is a label for the disclosure row, not the model's reasoning
  // content. Providers that do not return reasoning deltas must not make
  // statuses such as “分析完成” look like generated content.
  const text = reasoningDetailText(step);
  return (
    <section className="execution-step execution-reasoning">
      <ThinkingBlock
        durationMs={step.durationMs}
        running={running && !step.completed}
        text={text}
      />
    </section>
  );
}

function UserMessage({
  content,
  hasChangedFiles,
  onCreateBranch,
  onDelete,
  onEdit,
  onOpenExternal,
  onPreviewFile,
  onRegenerate,
  onRollbackFiles,
  projectId,
  time
}: {
  content: string;
  hasChangedFiles: boolean;
  onCreateBranch(): void;
  onDelete(): void;
  onEdit(): void;
  onOpenExternal(url: string): void;
  onPreviewFile(path: string): void;
  onRegenerate?(): Promise<void>;
  onRollbackFiles(): void;
  projectId: string;
  /** 消息时间（ISO 字符串）；存在时操作行前置 hover 揭示的日期感知时钟。 */
  time?: string;
}): React.JSX.Element {
  // 更多菜单走 portal fixed 定位（与助手菜单共用 hook），内联渲染会把消息列表往下挤。
  const { open: menuOpen, position: menuPosition, anchorRef: moreAnchorRef, menuRef, toggle, close: closeMenu } = useAnchoredMenu({ width: 208, estimatedHeight: 180 });
  // 发送时追加给模型的附件清单不该原样显示，拆出来渲染成附件卡片。
  const message = useMemo(() => splitAttachmentReferences(content), [content]);
  const clock = time ? <MessageClock time={Date.parse(time)} /> : null;
  return (
    <article className="chat-message user-message" data-sender="user">
      <div className="user-bubble">
        {message.text ? <MarkdownContent content={message.text} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} projectId={projectId} /> : null}
        {message.attachments.length ? <MessageAttachments attachments={message.attachments} projectId={projectId} /> : null}
      </div>
      <div className={`user-message-actions${menuOpen ? " is-open" : ""}`} data-time-hover-root>
        {clock}
        <button aria-label="复制消息" className="user-message-action" onClick={() => copyText(message.text)} title="复制消息" type="button"><Icon name="copy" size={16} /></button>
        {onRegenerate ? <button aria-label="重新生成" className="user-message-action" onClick={() => { void onRegenerate(); }} title="重新生成" type="button"><Icon name="refresh" size={16} /></button> : null}
        <button aria-label="编辑消息" className="user-message-action" onClick={onEdit} title="编辑消息" type="button"><Icon name="edit" size={16} /></button>
        <button aria-expanded={menuOpen} aria-haspopup="menu" aria-label="更多消息操作" className="user-message-action" onClick={toggle} ref={moreAnchorRef} title="更多" type="button"><Icon name="more" size={16} /></button>
      </div>
      {menuOpen && menuPosition ? createPortal(
        <div className="message-menu" data-direction={menuPosition.direction} ref={menuRef} role="menu" style={menuPosition.style}>
          <button className="message-menu-item" onClick={() => { copyText(message.text); closeMenu(); }} role="menuitem" type="button"><Icon name="copy" size={14} /><span>复制为 Markdown</span></button>
          <button className="message-menu-item" onClick={() => { copyText(plainTextFromMarkdown(message.text)); closeMenu(); }} role="menuitem" type="button"><Icon name="copy" size={14} /><span>复制为纯文本</span></button>
          <button className="message-menu-item" onClick={() => { onCreateBranch(); closeMenu(); }} role="menuitem" type="button"><Icon name="branch" size={14} /><span>创建分支</span></button>
          <button className="message-menu-item" disabled={!hasChangedFiles} onClick={() => { onRollbackFiles(); closeMenu(); }} role="menuitem" title={hasChangedFiles ? "回滚本条消息产生的文件修改" : "当前消息没有可回滚的文件修改"} type="button"><Icon name="arrow-left" size={14} /><span>回滚文件</span></button>
          <div className="message-menu-separator" />
          <button className="message-menu-item is-danger" onClick={() => { onDelete(); closeMenu(); }} role="menuitem" type="button"><Icon name="trash" size={14} /><span>删除消息</span></button>
        </div>,
        document.body
      ) : null}
    </article>
  );
}

function copyText(content: string): void {
  void copyToClipboard(content);
}

function plainTextFromMarkdown(content: string): string {
  return content
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~`]/g, "")
    .trim();
}

/** 助手回复下方的操作条：
 *  复制/朗读/重新生成/更多 四个图标按钮 hover 揭示；日期感知时钟 + 运行指标
 *  （LLM 用时 / 首 token / 解码吞吐）常显。更多菜单与用量悬浮卡都走 portal
 *  fixed 定位：用量项悬停出详情卡（80ms 悬停意图防抖），结束原因带语义色点，
 *  复制成功后图标变勾并延迟收菜单。 */
function AssistantActions({ content, timestamp, metrics, runMs, usage, finishReason, onCreateBranch, onRegenerate, onSwitchVersion, versionIndex, versionCount }: {
  content: string;
  timestamp?: string;
  metrics?: TurnMetrics;
  runMs?: number;
  usage?: SessionUsage;
  finishReason?: string;
  onCreateBranch(): void;
  onRegenerate?(): Promise<void>;
  onSwitchVersion?(direction: "prev" | "next"): Promise<void>;
  versionIndex?: number;
  versionCount?: number;
}): React.JSX.Element {
  const [speaking, setSpeaking] = useState(false);
  const stopSpeechRef = useRef<() => void>(undefined);
  const usageRows = buildUsageDetailRows(usage, metrics ?? {});
  const tone = finishReason ? finishReasonTone(finishReason) : undefined;
  // 更多菜单走 portal fixed 定位；条目数按需增减（用量/结束原因 + 分隔线），高度用于弹出方向判断。
  const menuItemCount = 3 + (usageRows.length ? 1 : 0) + (finishReason ? 1 : 0) + ((usageRows.length || finishReason) ? 1 : 0);
  const { open: menuOpen, position: menuPosition, anchorRef: moreButtonRef, menuRef, toggle: toggleMenu, close: closeMenu } = useAnchoredMenu({ width: 208, estimatedHeight: menuItemCount * 32 + 12 });
  const usageItemRef = useRef<HTMLButtonElement>(null);
  const [usagePopover, setUsagePopover] = useState<{ top: number; left: number }>();
  const usageHideTimerRef = useRef<number | undefined>(undefined);
  const [copiedKind, setCopiedKind] = useState<"markdown" | "plain">();

  // 组件卸载（切会话、消息被折叠）时朗读与悬浮卡定时器都要跟着停。
  useEffect(() => () => {
    stopSpeechRef.current?.();
    if (usageHideTimerRef.current !== undefined) window.clearTimeout(usageHideTimerRef.current);
  }, []);

  const toggleSpeech = (): void => {
    if (speaking) {
      stopSpeechRef.current?.();
      return;
    }
    setSpeaking(true);
    stopSpeechRef.current = speak(plainTextFromMarkdown(content), () => setSpeaking(false));
  };

  const cancelUsageHide = useCallback((): void => {
    if (usageHideTimerRef.current === undefined) return;
    window.clearTimeout(usageHideTimerRef.current);
    usageHideTimerRef.current = undefined;
  }, []);

  const scheduleUsageHide = useCallback((): void => {
    cancelUsageHide();
    usageHideTimerRef.current = window.setTimeout(() => {
      usageHideTimerRef.current = undefined;
      setUsagePopover(undefined);
    }, 80);
  }, [cancelUsageHide]);

  // 用量悬浮卡贴用量菜单项右侧（放不下换左侧），垂直方向与条目居中对齐。
  const showUsagePopover = useCallback((): void => {
    if (!usageRows.length) return;
    cancelUsageHide();
    const anchor = usageItemRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const gap = 10;
    const width = 240;
    let left = anchor.right + gap + width <= window.innerWidth ? anchor.right + gap : anchor.left - gap - width;
    left = Math.min(Math.max(gap, left), Math.max(gap, window.innerWidth - width - gap));
    const top = Math.min(Math.max(anchor.top + anchor.height / 2, gap), window.innerHeight - gap);
    setUsagePopover({ top, left });
  }, [usageRows.length, cancelUsageHide]);

  // 菜单收起时悬浮卡与复制成功态一并复位。
  useEffect(() => {
    if (menuOpen) return;
    cancelUsageHide();
    setUsagePopover(undefined);
    setCopiedKind(undefined);
  }, [menuOpen, cancelUsageHide]);

  const copyAs = (kind: "markdown" | "plain"): void => {
    copyText(kind === "markdown" ? content : plainTextFromMarkdown(content));
    setCopiedKind(kind);
    window.setTimeout(() => {
      setCopiedKind(undefined);
      closeMenu();
    }, 800);
  };

  const durationText = useMemo(() => {
    const parts: string[] = [];
    if (timestamp) {
      parts.push(formatMessageClock(Date.parse(timestamp)));
    }
    if (runMs !== undefined) {
      parts.push(`Worked for ${formatRunDuration(runMs)}`);
    } else if (metrics?.llmMs !== undefined) {
      parts.push(`LLM ${formatDuration(metrics.llmMs)}`);
    }
    return parts.join(" · ");
  }, [runMs, metrics, timestamp]);
  // 失败轮可能没有任何正文：复制/朗读无从作用，只保留重试、版本与更多菜单。
  const hasContent = content.trim().length > 0;
  const hasInfoSection = usageRows.length > 0 || Boolean(finishReason);
  return (
    <div className={`assistant-actions${menuOpen ? " is-open" : ""}`}>
      <div className="assistant-actions-duration">
        <Icon name="activity" size={14} />
        <span>{durationText}</span>
      </div>
      <div className="assistant-actions-buttons">
        {hasContent ? <CopyButton className="assistant-action" label="复制回复" size={16} value={content} /> : null}
        {hasContent && speechSupported() ? (
          <button aria-label={speaking ? "停止朗读" : "朗读回复"} className={`assistant-action${speaking ? " is-active" : ""}`} onClick={toggleSpeech} title={speaking ? "停止朗读" : "朗读回复"} type="button"><Icon name={speaking ? "volume-off" : "volume"} size={16} /></button>
        ) : null}
        {onRegenerate ? (
          <button aria-label="重新生成" className="assistant-action" onClick={() => { void onRegenerate(); }} title="重新生成" type="button"><Icon name="refresh" size={16} /></button>
        ) : null}
        {onSwitchVersion && versionCount !== undefined && versionCount > 1 && versionIndex !== undefined ? (
          <VersionSwitcher
            onSwitchVersion={onSwitchVersion}
            versionCount={versionCount}
            versionIndex={versionIndex}
          />
        ) : null}
        <button aria-expanded={menuOpen} aria-haspopup="menu" aria-label="更多回复操作" className="assistant-action" onClick={toggleMenu} ref={moreButtonRef} title="更多" type="button"><Icon name="more" size={16} /></button>
      </div>
      {menuOpen && menuPosition ? createPortal(
        <div
          className="message-menu"
          data-direction={menuPosition.direction}
          onClick={(event) => event.stopPropagation()}
          ref={menuRef}
          role="menu"
          style={menuPosition.style}
        >
          {hasInfoSection ? (
            <>
              {usageRows.length ? (
                <button
                  className="message-menu-item"
                  onBlur={scheduleUsageHide}
                  onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
                  onFocus={showUsagePopover}
                  onMouseEnter={showUsagePopover}
                  onMouseLeave={scheduleUsageHide}
                  ref={usageItemRef}
                  role="menuitem"
                  type="button"
                >
                  <Icon name="info" size={14} /><span>用量</span>
                </button>
              ) : null}
              {finishReason && tone ? (
                <div className="message-menu-item is-static" role="menuitem">
                  <span aria-hidden="true" className={`finish-reason-dot is-${tone}`} />
                  <span className="finish-reason-label">Turn 结束原因</span>
                  <span className="finish-reason-value">{finishReason}</span>
                </div>
              ) : null}
              <div className="message-menu-separator" />
            </>
          ) : null}
          {hasContent ? (
            <>
              <button className={`message-menu-item${copiedKind === "markdown" ? " is-success" : ""}`} onClick={() => copyAs("markdown")} role="menuitem" type="button">
                <Icon name={copiedKind === "markdown" ? "check" : "copy"} size={14} /><span>复制为 Markdown</span>
              </button>
              <button className={`message-menu-item${copiedKind === "plain" ? " is-success" : ""}`} onClick={() => copyAs("plain")} role="menuitem" type="button">
                <Icon name={copiedKind === "plain" ? "check" : "copy"} size={14} /><span>复制为纯文本</span>
              </button>
            </>
          ) : null}
          <button className="message-menu-item" onClick={() => { onCreateBranch(); closeMenu(); }} role="menuitem" type="button"><Icon name="branch" size={14} /><span>创建分支</span></button>
        </div>,
        document.body
      ) : null}
      {usagePopover && usageRows.length ? createPortal(
        <div
          className="usage-detail-popover"
          onMouseEnter={cancelUsageHide}
          onMouseLeave={scheduleUsageHide}
          role="status"
          style={{ top: usagePopover.top, left: usagePopover.left }}
        >
          <div className="usage-detail-title">用量</div>
          <div className="usage-detail-rows">
            {usageRows.map((row) => (
              <div className="usage-detail-row" key={row.key}>
                <span className="usage-detail-label">{row.label}</span>
                <span className="usage-detail-value">{row.value}</span>
              </div>
            ))}
          </div>
        </div>,
        document.body
      ) : null}
    </div>
  );
}

/** 消息版本控件：箭头、当前版本/总版本，跟随回复操作条显示。 */
function VersionSwitcher({ onSwitchVersion, versionIndex, versionCount }: {
  onSwitchVersion(direction: "prev" | "next"): Promise<void>;
  versionIndex: number;
  versionCount: number;
}): React.JSX.Element {
  const [pending, setPending] = useState<"prev" | "next">();
  const switchVersion = async (direction: "prev" | "next"): Promise<void> => {
    if (pending) return;
    setPending(direction);
    try {
      await onSwitchVersion(direction);
    } finally {
      setPending(undefined);
    }
  };
  return (
    <div aria-label="回复版本" className="message-version-switcher">
      <button
        aria-label="上一版本"
        className="assistant-action message-version-button"
        disabled={pending !== undefined}
        onClick={() => { void switchVersion("prev"); }}
        title="上一版本"
        type="button"
      >‹</button>
      <span className="message-version-count">{versionIndex + 1} / {versionCount}</span>
      <button
        aria-label="下一版本"
        className="assistant-action message-version-button"
        disabled={pending !== undefined}
        onClick={() => { void switchVersion("next"); }}
        title="下一版本"
        type="button"
      >›</button>
    </div>
  );
}

/** 用户消息里的附件：图片直接显示缩略图，其他类型退回成带文件名的卡片。 */
function MessageAttachments({ attachments, projectId }: { attachments: AttachmentReference[]; projectId: string }): React.JSX.Element {
  return (
    <div className="message-attachments">
      {attachments.map((attachment) => (
        <AttachmentCard attachment={attachment} key={attachment.path} projectId={projectId} />
      ))}
    </div>
  );
}

function AttachmentCard({ attachment, projectId }: { attachment: AttachmentReference; projectId: string }): React.JSX.Element {
  const isImage = attachment.mimeType?.startsWith("image/") ?? false;
  const source = useInlineImage(projectId, isImage ? attachment.path : "");
  if (source) return <img alt={attachment.name} className="message-attachment-image" src={source} title={attachment.name} />;
  return (
    <div className="message-attachment" title={attachment.path}>
      <Icon name={isImage ? "spark" : "file"} size={13} />
      <span>{attachment.name}</span>
    </div>
  );
}

/**
 * 消息"更多"菜单的开合与 fixed 定位：菜单通过 portal 挂到 document.body（脱离消息列表文档流，
 * 不会被滚动容器裁剪），打开时按锚点按钮的视口位置算坐标，下方放不下就向上弹；
 * 点击锚点/菜单以外、Esc、滚动或缩放窗口时收起。portal 不在组件 DOM 树内，
 * 外部点击判断必须显式比对锚点和菜单两个 ref。
 */
function useAnchoredMenu({ width, estimatedHeight }: { width: number; estimatedHeight: number }): {
  open: boolean;
  position: { direction: "up" | "down"; style: CSSProperties } | undefined;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  menuRef: React.RefObject<HTMLDivElement | null>;
  toggle(): void;
  close(): void;
} {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ direction: "up" | "down"; style: CSSProperties }>();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback((): void => setOpen(false), []);

  const toggle = useCallback((): void => {
    if (open) {
      setOpen(false);
      return;
    }
    const anchor = anchorRef.current?.getBoundingClientRect();
    if (!anchor) {
      setOpen(true);
      return;
    }
    const gap = 6;
    const spaceBelow = window.innerHeight - anchor.bottom - gap;
    const direction = spaceBelow >= estimatedHeight || spaceBelow >= anchor.top - gap ? "down" : "up";
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
    setPosition(direction === "down"
      ? { direction, style: { left, top: anchor.bottom + gap } }
      : { direction, style: { left, bottom: window.innerHeight - anchor.top + gap } });
    setOpen(true);
  }, [open, estimatedHeight, width]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    const dismiss = (): void => setOpen(false);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);

  return { open, position, anchorRef, menuRef, toggle, close };
}
