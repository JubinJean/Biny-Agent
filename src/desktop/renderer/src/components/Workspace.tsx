/**
 * Desktop 主工作区。
 *
 * 新建页使用紧凑的单框布局；已有会话继续沿用 Biny 的时间线、
 * 权限和文件检查器回调。页面层只负责把这些能力放到正确的视觉区域。
 */
import type { PermissionResult } from "../../../../permission/PermissionManager.js";
import { useEffect, useRef, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import type { DesktopProject, DesktopRuntimeMutation, DesktopRuntimeProjection, DesktopSessionLimits, DesktopSessionWriterConflict } from "../../../protocol.js";
import type { RecipeNotice } from "../app/useDesktopEventBridge.js";
import { currentTurnActivity, type TurnActivity } from "../chatModel.js";
import type { TimelineTurn } from "../sessionTimeline.js";
import { desktopWorktreeView } from "../worktreePresentation.js";
import { Icon } from "./Icon.js";
import { MessageTimeline } from "./MessageTimeline.js";
import { RuntimePanel } from "./RuntimePanel.js";
import { RecipeReadyBanner } from "./RecipeReadyBanner.js";
import { WelcomeState } from "./WelcomeState.js";

/** 新会话首条消息的临时投影；真实 message.user 到达后由 App 清掉。 */
export interface PendingPrompt {
  id: string;
  projectId: string;
  text: string;
  sessionId?: string;
  messageId?: string;
}

interface WorkspaceProps {
  project?: DesktopProject;
  projectId?: string;
  sessionId?: string;
  sessionTitle?: string;
  sessionIsolation?: "shared" | "worktree";
  turns: TimelineTurn[];
  loading: boolean;
  runtimeError?: string;
  runtimeProjection?: DesktopRuntimeProjection;
  onOpenProject(): void;
  onPreviewFile(path: string): void;
  inspectorOpen: boolean;
  onToggleInspector(): void;
  runtimePanelOpen: boolean;
  onRuntimePanelOpenChange(open: boolean): void;
  thinking: boolean;
  running: boolean;
  thinkingStartedAt?: string;
  /** 当前会话的 Recipe 提示卡；固定在输入框上方，不随消息流滚走。 */
  recipeNotices?: RecipeNotice[];
  onDismissRecipe?(notice: RecipeNotice): void;
  onExtractRecipe?(notice: RecipeNotice): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  onRetry(targetMessageId: string, input: string, idempotencyKey: string): Promise<void>;
  onSwitchVersion(messageId: string, direction: "prev" | "next"): Promise<void>;
  onRetryWriterConflict(): Promise<void>;
  writerConflict?: DesktopSessionWriterConflict;
  /** 会话体量接近持久化上限时的预警信息；未接近时缺省。 */
  sessionLimits?: DesktopSessionLimits;
  /** 点「编辑」用户消息：文本回填到底部输入框。 */
  onEditRequest(turn: TimelineTurn): void;
  /** 进行中的编辑重写投影；提交与清除都由 App 负责。 */
  editInFlight?: { turnId: string; user: string; userMessageIndex?: number };
  /** 当前要展示的生成错误文本（Alma 式瞬态：live 失败事件驱动）；空值 = 不展示。 */
  generationError?: string;
  onDismissGenerationError(): void;
  onCreateBranch(): void;
  onRollbackFiles(turn: TimelineTurn): void;
  onDeleteUserMessage(turnId: string): void;
  onRuntimeError(error: unknown): void;
  onRuntimeMutation(operation: DesktopRuntimeMutation, payload: Record<string, unknown>): Promise<void>;
  onRuntimeRefresh(): Promise<void>;
  /** 建议 pill 点击即提交，由 App 转发给 Composer 的统一提交路径。 */
  onSubmitPrompt(prompt: string): void;
  /** 顶栏的项目/分支选择器胶囊（含菜单），由 App 装配；无项目时缺省。 */
  workspaceContext?: React.ReactNode;
  /** 右缘常驻的工具 rail（文件/终端/审阅/侧聊/浏览器），由 App 装配；无项目时缺省。 */
  inspectorRail?: React.ReactNode;
  /** 项目行「新建任务」直达的空白草稿：跳过欢迎态，直接渲染空白聊天 + 底部 Composer。 */
  blankDraft?: boolean;
  /** 新会话首条消息的临时投影；真实事件到达后由 App 清掉。 */
  pendingPrompt?: PendingPrompt;
  /** 顶部工具条：自动化/技能入口（搜索与新建任务在侧栏 chrome）。 */
  onOpenRuntime(): void;
  onOpenExtensions(): void;
  children?: React.ReactNode;
}

export function Workspace({
  project,
  projectId,
  sessionId,
  sessionTitle,
  sessionIsolation,
  turns,
  loading,
  runtimeError,
  runtimeProjection,
  onOpenProject,
  onPreviewFile,
  inspectorOpen,
  onToggleInspector,
  runtimePanelOpen,
  onRuntimePanelOpenChange,
  thinking,
  running,
  thinkingStartedAt,
  recipeNotices,
  onDismissRecipe,
  onExtractRecipe,
  onOpenExternal,
  onResolvePermission,
  onRetry,
  onSwitchVersion,
  onRetryWriterConflict,
  writerConflict,
  sessionLimits,
  onEditRequest,
  editInFlight,
  generationError,
  onDismissGenerationError,
  onCreateBranch,
  onRollbackFiles,
  onDeleteUserMessage,
  onRuntimeError,
  onRuntimeMutation,
  onRuntimeRefresh,
  onSubmitPrompt,
  blankDraft = false,
  pendingPrompt,
  workspaceContext,
  inspectorRail,
  onOpenRuntime: _onOpenRuntime,
  onOpenExtensions: _onOpenExtensions,
  children
}: WorkspaceProps): React.JSX.Element {
  const visiblePendingPrompt = pendingPrompt && pendingPrompt.projectId === projectId
    && (pendingPrompt.sessionId === undefined || pendingPrompt.sessionId === sessionId)
    ? pendingPrompt
    : undefined;
  const streaming = running || visiblePendingPrompt !== undefined || turns.some((turn) => turn.status === "running" || turn.status === "waiting_permission");
  // 状态行在整个运行期间常驻消息流末尾（Alma 式活动状态）：文案从最后一条轮次的
  // 实时状态派生——思考中 / 正在使用技能 X / 正在读取文件 / 等待授权……，回合结束即退场。
  const lastTurn = turns.at(-1);
  const isHome = !loading && !runtimeError && !projectId;
  const showWelcome = !loading && !runtimeError && !sessionId && !streaming && turns.length === 0;
  // 上限预警按会话 dismiss：换会话要重新提示，同会话点掉后不再打扰。
  const [limitBannerDismissedFor, setLimitBannerDismissedFor] = useState<string>();
  const showLimitBanner = Boolean(sessionLimits?.nearSizeLimit && sessionId && limitBannerDismissedFor !== sessionId);
  const selectedWorktree = sessionId === undefined
    ? undefined
    : runtimeProjection?.worktrees.find((worktree) => worktree.sessionId === sessionId);
  const worktreeView = sessionIsolation === "worktree" ? desktopWorktreeView(selectedWorktree) : undefined;

  // blankDraft（项目行新建）跳过欢迎态；新会话首条消息由临时投影直接进入聊天时间线。
  const renderWelcome = !blankDraft && showWelcome;

  if (isHome) {
    return (
      <div className="workspace biny-workspace biny-workspace-home">
        <RuntimePanel
          onClose={() => onRuntimePanelOpenChange(false)}
          onError={onRuntimeError}
          onMutation={onRuntimeMutation}
          onRefresh={onRuntimeRefresh}
          open={runtimePanelOpen && Boolean(projectId)}
          projection={runtimeProjection}
          selectedSessionId={sessionId}
          worktreeSession={sessionIsolation === "worktree"}
        />
        <div className="biny-chat-body is-welcome">
          <WelcomeState hasProject={false} onOpenProject={onOpenProject} onPickSuggestion={onSubmitPrompt}>
            <div className="biny-welcome-composer-slot biny-hero-fade">{children}</div>
          </WelcomeState>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace biny-workspace biny-workspace-chat">
      <div className="biny-workspace-main">
        {/* 后台运行面板从右上角盖下来时会覆盖 rail 区域，期间先收起 rail 避免互相遮挡。 */}
        {runtimePanelOpen ? null : inspectorRail}
        <header className="biny-chat-toolbar">
          <div className="biny-chat-drag-region">
            {/* 顶栏：会话名截断展示，项目/分支以胶囊选择器跟在标题后；
              未进入会话时标题只有选择器本身，连项目都没有时才显示引导文案。 */}
            {sessionTitle || !project ? (
              <div className="biny-chat-title">
                <strong>{sessionTitle ?? "Biny"}</strong>
                {!sessionTitle && !project ? <span>打开一个本地项目开始</span> : null}
              </div>
            ) : null}
            {workspaceContext}
            {worktreeView ? (
              <button
                aria-label={`隔离工作树：${worktreeView.label}。${worktreeView.detail}`}
                className={`biny-worktree-indicator is-${worktreeView.tone}`}
                onClick={() => onRuntimePanelOpenChange(true)}
                title={`${worktreeView.label}：${worktreeView.detail}`}
                type="button"
              >
                <Icon name="folder-open" size={13} />
                <span>隔离工作树</span>
                <small>{worktreeView.label}</small>
              </button>
            ) : null}
          </div>
          <div className="biny-chat-actions">
            <button
              aria-expanded={inspectorOpen}
              aria-label={inspectorOpen ? "收起工作区工具" : "打开工作区工具"}
              className={`biny-toolbar-button${inspectorOpen ? " is-active" : ""}`}
              disabled={!projectId}
              onClick={onToggleInspector}
              title={inspectorOpen ? "收起工作区工具" : "打开工作区工具"}
              type="button"
            >
              <Icon name="panel-right" size={15} />
            </button>
          </div>
        </header>
        <RuntimePanel
          onClose={() => onRuntimePanelOpenChange(false)}
          onError={onRuntimeError}
          onMutation={onRuntimeMutation}
          onRefresh={onRuntimeRefresh}
          open={runtimePanelOpen}
          projection={runtimeProjection}
          selectedSessionId={sessionId}
          worktreeSession={sessionIsolation === "worktree"}
        />
        <div className={`biny-chat-body${renderWelcome ? " is-welcome" : ""}`}>
          {showLimitBanner && sessionLimits && sessionId ? (
            <div className="biny-session-limit-banner" role="status">
              <span>
                这个会话已写入 {(sessionLimits.sizeBytes / 1048576).toFixed(1)} MB / {Math.round(sessionLimits.maxSizeBytes / 1048576)} MB（{sessionLimits.eventCount.toLocaleString()} 个事件）。
                越大打开和回放越慢，建议分叉出新会话继续。
              </span>
              <button onClick={onCreateBranch} type="button">分叉新会话</button>
              <button aria-label="忽略" className="biny-session-limit-dismiss" onClick={() => setLimitBannerDismissedFor(sessionId)} type="button">×</button>
            </div>
          ) : null}
          {loading ? <LoadingState /> : runtimeError ? <RuntimeError error={runtimeError} onOpenProject={onOpenProject} /> : renderWelcome ? (
            <WelcomeState hasProject={Boolean(projectId)} onOpenProject={onOpenProject} onPickSuggestion={onSubmitPrompt}>
              <div className="biny-welcome-composer-slot biny-hero-fade">
                {writerConflict ? <SessionWriterConflictBanner onRetry={onRetryWriterConflict} /> : children}
              </div>
            </WelcomeState>
          ) : (turns.length > 0 || thinking || visiblePendingPrompt !== undefined) && projectId ? (
            <ChatScroll sessionId={sessionId} streaming={streaming}>
              <MessageTimeline
                onCreateBranch={onCreateBranch}
                onDeleteUserMessage={onDeleteUserMessage}
                editInFlight={editInFlight}
                onEditRequest={onEditRequest}
                onOpenExternal={onOpenExternal}
                onPreviewFile={onPreviewFile}
                onResolvePermission={onResolvePermission}
                onRollbackFiles={onRollbackFiles}
                onRetry={onRetry}
                onSwitchVersion={onSwitchVersion}
                pendingUserMessage={visiblePendingPrompt
                  ? { id: visiblePendingPrompt.id, messageId: visiblePendingPrompt.messageId, content: visiblePendingPrompt.text }
                  : undefined}
                thinking={thinking}
                projectId={projectId}
                turns={turns}
              />
              {/* 活动状态行：消息流末尾、最后一条消息下方，运行期间常驻；
                文案是当前真实活动（思考/工具/技能/等待授权），回合结束即退场。 */}
              {running || visiblePendingPrompt !== undefined ? (
                <ThinkingStatus
                  activity={currentTurnActivity(lastTurn)}
                  key={thinkingStartedAt ?? "thinking"}
                  startedAt={thinkingStartedAt}
                />
              ) : null}
            </ChatScroll>
          ) : (
            <div className="biny-chat-empty"><Icon name="message" size={20} /><span>开始一段新的对话</span></div>
          )}
        </div>
        {renderWelcome ? null : (
          <div className={`biny-chat-composer${visiblePendingPrompt ? " is-entering" : ""}`}>
            {recipeNotices && recipeNotices.length > 0 && projectId ? (
              <div className="biny-recipe-ready-notices">
                <RecipeReadyBanner
                  notice={recipeNotices[0]!}
                  onDismiss={(notice) => onDismissRecipe?.(notice)}
                  onExtract={(notice) => onExtractRecipe?.(notice)}
                />
              </div>
            ) : null}
            {generationError && generationError !== lastTurn?.error ? (
              <GenerationErrorBanner error={generationError} onDismiss={onDismissGenerationError} />
            ) : null}
            {writerConflict ? <SessionWriterConflictBanner onRetry={onRetryWriterConflict} /> : children}
          </div>
        )}
      </div>
      {streaming ? <span className="biny-streaming-state" aria-hidden="true" /> : null}
    </div>
  );
}

/** 尚未进入消息时间线的发送错误仍靠近输入框展示；轮次错误由对应消息承载。 */
function GenerationErrorBanner({ error, onDismiss }: { error: string; onDismiss(): void }): React.JSX.Element {
  return (
    <div className="biny-generation-error" role="alert">
      <Icon name="warning" size={14} />
      <div className="biny-generation-error-body">
        <p className="biny-generation-error-title">生成错误</p>
        <p className="biny-generation-error-text">{error}</p>
      </div>
      <button aria-label="关闭错误提示" onClick={onDismiss} title="关闭" type="button">
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}

function ThinkingStatus({ activity, startedAt }: { activity: TurnActivity; startedAt?: string }): React.JSX.Element {
  const [elapsedSeconds, setElapsedSeconds] = useState(() => elapsedSecondsSince(startedAt));

  useEffect(() => {
    const update = (): void => setElapsedSeconds(elapsedSecondsSince(startedAt));
    update();
    if (!startedAt) return;
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return (
    <div className="biny-thinking-status" role="status">
      {/* thinking-orbs 只有 20/64 两档画布；16px 展示由 CSS 盒子缩小（同 Alma 的 cssSize 做法）。 */}
      <ThinkingOrb aria-label={activity.label} className="biny-thinking-status-orb" size={20} state={activity.orbState} theme="auto" />
      <span className="biny-thinking-status-label chat-shimmer-text">{activity.label}…</span>
      <span className="biny-thinking-status-duration">{elapsedSeconds}s</span>
    </div>
  );
}

function elapsedSecondsSince(startedAt?: string): number {
  if (!startedAt) return 0;
  const timestamp = Date.parse(startedAt);
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
}

/** 距底小于该值视为「钉在底部」：新内容进来继续贴底，回底按钮也在这时收起。 */
const PIN_DISTANCE = 48;
/** 距底超过该值才显示回底按钮；与 PIN_DISTANCE 之间是滞回区，防阈值附近抖动。 */
const JUMP_BUTTON_DISTANCE = 160;

function distanceFromBottom(element: HTMLElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

function ChatScroll({ children, sessionId, streaming }: { children: React.ReactNode; sessionId?: string; streaming: boolean }): React.JSX.Element {
  const [scrollActive, setScrollActive] = useState(false);
  const [jumpVisible, setJumpVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 「钉在底部」用 ref 不用 state：流式期间滚动事件极频繁，贴底状态翻转不该触发重渲染。
  const pinnedRef = useRef(true);

  useEffect(() => () => {
    if (fadeTimerRef.current !== undefined) clearTimeout(fadeTimerRef.current);
  }, []);

  // 切会话从头贴底；内容随后异步长高，由下面的 ResizeObserver 持续贴住。
  useEffect(() => {
    pinnedRef.current = true;
    setJumpVisible(false);
    const container = containerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [sessionId]);

  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) {
        container.scrollTop = container.scrollHeight;
      } else {
        setJumpVisible(distanceFromBottom(container) > JUMP_BUTTON_DISTANCE);
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const revealScrollbar = (): void => {
    setScrollActive(true);
    if (fadeTimerRef.current !== undefined) clearTimeout(fadeTimerRef.current);
    fadeTimerRef.current = setTimeout(() => {
      fadeTimerRef.current = undefined;
      setScrollActive(false);
    }, 1000);
  };

  const handleScroll = (): void => {
    revealScrollbar();
    const container = containerRef.current;
    if (!container) return;
    const distance = distanceFromBottom(container);
    pinnedRef.current = distance < PIN_DISTANCE;
    if (distance > JUMP_BUTTON_DISTANCE) setJumpVisible(true);
    else if (distance < PIN_DISTANCE) setJumpVisible(false);
  };

  // 直达用瞬时滚动而非平滑滚动：流式期间内容一直在长，平滑滚动追不上新底部。
  const jumpToBottom = (): void => {
    const container = containerRef.current;
    if (!container) return;
    pinnedRef.current = true;
    container.scrollTop = container.scrollHeight;
    setJumpVisible(false);
  };

  return (
    <>
      <div
        className={`biny-chat-scroll${scrollActive ? " is-scroll-active" : ""}`}
        onScroll={handleScroll}
        onWheel={revealScrollbar}
        ref={containerRef}
      >
        <div className="biny-chat-scroll-content" ref={contentRef}>{children}</div>
      </div>
      <button
        aria-hidden={!jumpVisible}
        aria-label={streaming ? "正在生成，回到底部" : "回到底部"}
        className={`biny-jump-bottom${jumpVisible ? " is-visible" : ""}`}
        onClick={jumpToBottom}
        tabIndex={jumpVisible ? 0 : -1}
        title={streaming ? "正在生成，回到底部" : "回到底部"}
        type="button"
      >
        {streaming
          ? <ThinkingOrb aria-hidden="true" className="biny-jump-bottom-orb" size={20} state="connecting" theme="auto" />
          : <Icon name="arrow-down" size={16} />}
      </button>
    </>
  );
}

function LoadingState(): React.JSX.Element {
  return <div className="biny-status-state" role="status"><ThinkingOrb aria-label="正在恢复会话" className="thinking-orb" size={20} state="connecting" theme="auto" /><span>正在恢复会话…</span></div>;
}

function RuntimeError({ error, onOpenProject }: { error: string; onOpenProject(): void }): React.JSX.Element {
  return (
    <div className="biny-runtime-error" role="alert">
      <Icon name="warning" size={22} />
      <h2>Agent Runtime 无法启动</h2>
      <p>{error}</p>
      <small>若另一个 Biny/CLI 会话正在占用项目，请先退出该会话；其他错误请检查共享配置后重试。</small>
      <button onClick={onOpenProject} type="button">打开其他项目</button>
    </div>
  );
}

function SessionWriterConflictBanner({ onRetry }: { onRetry(): Promise<void> }): React.JSX.Element {
  const [retrying, setRetrying] = useState(false);
  const retry = async (): Promise<void> => {
    if (retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };
  return (
    <div aria-live="polite" className="biny-session-writer-conflict" role="alert">
      <Icon name="lock" size={17} />
      <div className="biny-session-writer-conflict-copy">
        <strong>已在另一个应用中打开</strong>
        <span>请先在那边关闭会话，才能在这里继续。</span>
      </div>
      <button disabled={retrying} onClick={() => void retry()} type="button">{retrying ? "重试中…" : "重试"}</button>
    </div>
  );
}
