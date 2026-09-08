/**
 * 轮次级失败/未完成展示：blocked / incomplete / cancelled / aborted / failed 的统一出口。
 *
 * 两种形态：`RunErrorCard` 完整卡片（图标 + 语义标题 + 人话错误信息 + 下一步提示 +
 * 可展开的技术详情 + 可重试操作），`RunErrorRow` 折叠成一行的一行式提示。
 * 完整卡片只给当场发生的最近一次失败；重新打开会话看到的旧错误一律折叠成一行，
 * 避免时间线里长期挂着大错误卡。原始错误码不直接作为主文案，避免用户只能看到实现层错误。
 */
import { memo, useCallback, useRef, useState } from "react";
import { humanizeRunError, isRunErrorRetryable, runErrorPresentation, runErrorRecovery } from "../../chatModel.js";
import type { TimelineRunStatus } from "../../sessionTimeline.js";
import { Icon } from "../Icon.js";

export const RunErrorCard = memo(function RunErrorCard({
  status,
  message,
  onRetry,
  onDismiss,
}: {
  /** 轮次终态；驱动标题与语义色。 */
  status: TimelineRunStatus;
  /** 原始错误文本（可能是错误码）；卡片显示精简后的人话，完整原文放 tooltip。 */
  message: string;
  /** 可重试时展示「重试」；不可重试或任务需要外部处理时缺省。 */
  onRetry?(): Promise<void>;
  /** 收起为一行式提示（不删除轮次记录，点折叠行可重新展开）。 */
  onDismiss?(): void;
}): React.JSX.Element {
  const { title, variant } = runErrorPresentation(status, message);
  const summary = humanizeRunError(message);
  const recovery = runErrorRecovery(status, message);
  const retryAvailable = Boolean(onRetry) && isRunErrorRetryable(message);
  const [retrying, setRetrying] = useState(false);
  const retryingRef = useRef(false);
  const handleRetry = useCallback(async (): Promise<void> => {
    if (!onRetry || retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      retryingRef.current = false;
      setRetrying(false);
    }
  }, [onRetry]);
  return (
    <section aria-live="polite" className="run-error-card" data-variant={variant} role="alert">
      <span aria-hidden="true" className="run-error-card-icon"><Icon name="warning" size={17} /></span>
      <div className="run-error-card-body">
        <div className="run-error-card-heading">
          <strong className="run-error-card-title">{title}</strong>
          <span className="run-error-card-kind">{retryAvailable ? "可重试" : "需要处理"}</span>
        </div>
        {summary ? <span className="run-error-card-message">{summary}</span> : null}
        {recovery ? <span className="run-error-card-recovery">{recovery}</span> : null}
        <details className="run-error-card-details">
          <summary>查看技术详情</summary>
          <pre>{message}</pre>
        </details>
      </div>
      {retryAvailable ? (
        <div className="run-error-card-actions">
          <button className="run-error-card-action is-primary" disabled={retrying} onClick={() => { void handleRetry(); }} type="button">{retrying ? "重试中…" : "重试"}</button>
        </div>
      ) : null}
      {onDismiss ? (
        <button
          aria-label="收起错误提示"
          className="run-error-card-dismiss"
          onClick={onDismiss}
          title="收起错误提示"
          type="button"
        >
          <Icon name="close" size={14} />
        </button>
      ) : null}
    </section>
  );
});

/** 历史错误的一行式提示：图标 + 语义标题 + 折叠摘要，完整卡片点行展开；原始错误放 tooltip。 */
export const RunErrorRow = memo(function RunErrorRow({
  message,
  onExpand,
  status,
}: {
  message: string;
  onExpand(): void;
  status: TimelineRunStatus;
}): React.JSX.Element {
  const { title, variant } = runErrorPresentation(status, message);
  return (
    <div className="chat-notice is-compaction" data-variant={variant}>
      <button
        aria-expanded={false}
        className="chat-row-header chat-notice-header run-error-row"
        onClick={onExpand}
        title={message}
        type="button"
      >
        <span aria-hidden="true" className="chat-row-leading run-error-row-icon"><Icon name="warning" size={13} /></span>
        <span className="chat-notice-title">{title}</span>
        <span className="chat-notice-summary">{humanizeRunError(message)}</span>
        <span aria-hidden="true" className="chat-row-chevron"><Icon name="chevron" size={12} /></span>
      </button>
    </div>
  );
});
