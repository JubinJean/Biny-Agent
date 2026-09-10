/**
 * 工具调用块。
 *
 * 两种呈现：
 * - card（默认）：状态图标芯片 + 标题 + 摘要 + 用时 + chevron，对应消息里独立工具卡片；
 * - row（compact）：聚合组导轨里的紧凑行——无图标芯片，运行中是琥珀脉冲点、失败圆圈叉，
 *   摘要始终是普通宾语（失败也保留路径原样，只由动词染红 + 圆圈叉表达错误），
 *   密度对齐 Alma 的 ActivityToolRow。
 *
 * 运行中：card 模式图标芯片带呼吸光环，用时实时跳动；
 * 失败/中断：折叠摘要替换为错误首行；展开体由调用方承载（权限卡、命令日志、diff 等）。
 */
import { memo, type ReactNode } from "react";
import { type ToolRowState, type ToolRowVariant, VARIANT_ICON_NAMES } from "../../chatModel.js";
import { Icon } from "../Icon.js";
import { BreathingDot } from "./BreathingDot.js";
import { Collapse } from "./Collapse.js";

export interface ToolCallBlockProps {
  variant: ToolRowVariant;
  state: ToolRowState;
  title: string;
  /** 折叠摘要文本；错误行会被 `errorSummary` 整体替换。 */
  summary: string;
  /** 错误首行（错误行折叠摘要）；null/undefined 表示非错误行。 */
  errorSummary?: string | null;
  /** 是否有展开体。 */
  expandable: boolean;
  expanded: boolean;
  onToggle(): void;
  /** 聚合组导轨里的紧凑行呈现。 */
  compact?: boolean;
  /** 用时标签（如 `12s`），运行中实时跳动；紧凑行不显示。 */
  durationLabel?: string;
  children?: ReactNode;
}

export const ToolCallBlock = memo(function ToolCallBlock({
  variant,
  state,
  title,
  summary,
  errorSummary,
  expandable,
  expanded,
  onToggle,
  compact = false,
  durationLabel,
  children,
}: ToolCallBlockProps): React.JSX.Element {
  // 紧凑行不吞错误首行：错误细节在展开体里，行上只靠圆圈叉 + 红动词表达（对齐 Alma）。
  const failureLine = !compact && state === "error" ? errorSummary ?? null : null;
  const summaryText = failureLine ?? summary;
  return (
    <section
      className={`chat-tool${compact ? " is-row" : ""}${expanded ? " is-open" : ""}`}
      data-state={state}
      data-variant={variant}
    >
      {state !== "ok" ? <span className="chat-visually-hidden">{stateLabel(state)}</span> : null}
      <button
        aria-expanded={expandable ? expanded : undefined}
        className="chat-row-header chat-tool-header"
        disabled={!expandable}
        onClick={expandable ? onToggle : undefined}
        type="button"
      >
        {compact ? (
          state === "running" ? (
            <span aria-hidden="true" className="chat-tool-run-dot" />
          ) : state === "error" || state === "stopped" ? (
            <span aria-hidden="true" className="chat-tool-status-icon"><Icon name={state === "error" ? "circle-close" : "warning"} size={12} /></span>
          ) : null
        ) : (
          <span className="chat-tool-icon">
            {state === "running"
              ? <BreathingDot breathing tone="accent" />
              : <Icon name={VARIANT_ICON_NAMES[variant]} size={14} />}
          </span>
        )}
        <span className="chat-tool-title">{title}</span>
        {summaryText !== "" ? (
          <span
            className={`chat-tool-summary${failureLine !== null ? " is-error" : ""}`}
            title={summaryText}
          >
            {summaryText}
          </span>
        ) : null}
        {!compact && durationLabel !== undefined ? <span className="chat-row-meta chat-tool-duration">{durationLabel}</span> : null}
        {expandable ? <span className="chat-row-chevron"><Icon name="chevron" size={compact ? 14 : 12} /></span> : null}
      </button>
      {expandable ? (
        <Collapse open={expanded}>
          <div className="chat-tool-body">{children}</div>
        </Collapse>
      ) : null}
    </section>
  );
});

function stateLabel(state: ToolRowState): string {
  if (state === "running") return "正在执行";
  if (state === "error") return "执行失败";
  if (state === "stopped") return "已中断";
  return "";
}
