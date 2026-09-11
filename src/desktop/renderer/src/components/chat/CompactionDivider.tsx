/**
 * 上下文压缩分隔条（时间线里的普通一行，居中药丸样式）。
 *
 * 折叠态：fold 图标 + 「上下文已压缩 · N 条消息已摘要 · 节省约 X tokens」，
 * 有摘要正文时可点开（markdown 由调用方决定，这里按纯文本段落渲染）。
 * 计数/节省缺失的段自动省略；无正文时整条不可展开。
 */
import React, { memo, useState } from "react";
import { Icon } from "../Icon.js";

export const CompactionDivider = memo(function CompactionDivider({ count, savedTokens, summary }: {
  /** 被摘要掉的消息条数；缺失时省略该段。 */
  count?: number;
  /** 估算节省的 token 数；缺失或 ≤0 时省略该段。 */
  savedTokens?: number;
  /** 可选的压缩摘要正文；存在才可展开。 */
  summary?: string;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const hasSummary = (summary ?? "").trim().length > 0;
  return (
    <div className="chat-compaction">
      <button
        aria-expanded={hasSummary ? expanded : undefined}
        className={`chat-compaction-pill${hasSummary ? " is-expandable" : ""}`}
        onClick={hasSummary ? () => setExpanded((current) => !current) : undefined}
        type="button"
      >
        <span className="chat-compaction-segment">
          <Icon name="fold" size={12} />
          <span>上下文已压缩</span>
        </span>
        {count !== undefined ? (
          <>
            <span aria-hidden="true" className="chat-compaction-dot">•</span>
            <span>{String(count)} 条消息已摘要</span>
          </>
        ) : null}
        {savedTokens !== undefined && savedTokens > 0 ? (
          <>
            <span aria-hidden="true" className="chat-compaction-dot">•</span>
            <span>节省约 {savedTokens.toLocaleString("en-US")} tokens</span>
          </>
        ) : null}
        {hasSummary ? <span className={`chat-compaction-chevron${expanded ? " is-open" : ""}`}><Icon name="chevron" size={12} /></span> : null}
      </button>
      {expanded && hasSummary ? <div className="chat-compaction-body">{summary}</div> : null}
    </div>
  );
});
