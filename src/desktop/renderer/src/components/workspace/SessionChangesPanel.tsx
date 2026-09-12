/**
 * 右侧 dock 的「产物」视图：当前会话里 Agent 改过的文件。
 *
 * 按文件聚合，列表突出名称与路径，展开后展示编辑记录和文件预览入口。
 * 数据由 App 从时间线注入，这里只负责展示与本地展开状态。
 */
import { useMemo, useState } from "react";
import { parseDiffHunks, sessionChangeTotals, type SessionFileChange } from "../../sessionChanges.js";
import { Icon } from "../Icon.js";

export function SessionChangesPanel({ changes, onPreviewFile }: {
  changes: SessionFileChange[];
  onPreviewFile(path: string): void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const visibleChanges = changes.filter((change) => change.path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const totals = useMemo(() => sessionChangeTotals(changes), [changes]);
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const togglePath = (path: string): void => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="biny-session-changes">
      <header className="biny-session-changes-summary">
        <div className="biny-session-changes-heading">
          <h2>更改的文件 <span>{totals.files}</span></h2>
          <p>本次对话</p>
        </div>
        {totals.add + totals.del > 0 ? (
          <span className="diff-stats biny-session-changes-diffstat">
            <span className="diff-add">+{totals.add}</span>
            <span className="diff-delete">-{totals.del}</span>
          </span>
        ) : null}
      </header>
      {changes.length > 0 ? <div className="inspector-subtoolbar"><input aria-label="筛选产物" placeholder="按文件路径筛选…" value={query} onChange={(event) => setQuery(event.target.value)} /><button type="button" onClick={() => setExpandedPaths(new Set(visibleChanges.map((change) => change.path)))}>展开</button><button type="button" onClick={() => setExpandedPaths(new Set())}>折叠</button></div> : null}
      {changes.length === 0 ? (
        <div className="biny-session-changes-empty">
          <Icon name="file-diff" size={28} />
          <p className="biny-session-changes-empty-title">还没有文件更改</p>
          <p className="biny-session-changes-empty-hint">对话中写入或编辑的文件会显示在这里</p>
        </div>
      ) : <div className="biny-session-changes-list">
        {visibleChanges.length === 0 ? <div className="inspector-empty">没有匹配的文件</div> : null}
        {visibleChanges.map((change) => (
          <ChangeRow
            change={change}
            expanded={expandedPaths.has(change.path)}
            key={change.path}
            onPreviewFile={onPreviewFile}
            onToggle={() => togglePath(change.path)}
          />
        ))}
      </div>}
    </div>
  );
}

function ChangeRow({ change, expanded, onToggle, onPreviewFile }: {
  change: SessionFileChange;
  expanded: boolean;
  onToggle(): void;
  onPreviewFile(path: string): void;
}): React.JSX.Element {
  const name = change.path.slice(change.path.lastIndexOf("/") + 1);
  const dir = name === change.path ? "" : change.path.slice(0, change.path.lastIndexOf("/"));
  const hunks = useMemo(() => parseDiffHunks(change.diff), [change.diff]);
  return (
    <div className={`biny-session-change${expanded ? " is-open" : ""}`}>
      <button
        aria-expanded={expanded}
        className="biny-session-change-row"
        onClick={onToggle}
        title={change.path}
        type="button"
      >
        <span aria-hidden="true" className={`biny-session-change-chevron${expanded ? " is-open" : ""}`}>
          <Icon name="chevron" size={12} />
        </span>
        <span className={`biny-session-change-icon is-${change.operation}`}>
          <Icon name={change.operation === "write" ? "file-text" : "file-pen"} size={16} />
        </span>
        <span className="biny-session-change-label">
          <span className="biny-session-change-name">{name}</span>
          {dir !== "" ? <span className="biny-session-change-dir">{dir}</span> : null}
        </span>
        <span className={`biny-session-change-chip${change.status === "writing" ? " is-active" : ""} is-${change.operation}`}>
          {change.status === "writing" ? "处理中" : change.operation === "write" ? "写入" : "编辑"}
        </span>
        {change.add + change.del > 0 ? (
          <span className="diff-stats biny-session-change-stats">
            <span className="diff-add">+{change.add}</span>
            <span className="diff-delete">-{change.del}</span>
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className="biny-session-change-body">
          <div className="biny-session-change-detail-header">
            <span>{change.changeCount > 1 ? `${change.changeCount} 次操作记录` : "操作记录"}</span>
            <button onClick={() => onPreviewFile(change.path)} type="button">
              <Icon name="eye" size={13} />
              预览文件
            </button>
          </div>
          {hunks.length > 0 ? (
            <pre className="merged-edit-diff biny-session-change-diff"><code>
              {hunks.map((hunk, hunkIndex) => (
                <span key={hunkIndex}>
                  {hunkIndex > 0 ? <span className="merged-diff-line merged-diff-gap"><span className="merged-diff-ln">⋮</span><span className="merged-diff-sign" /><span className="merged-diff-text" />{"\n"}</span> : null}
                  {hunk.lines.map((line, lineIndex) => (
                    <span className="merged-diff-line" data-line={line.kind} key={lineIndex}>
                      <span className="merged-diff-ln">{line.lineNo ?? ""}</span>
                      <span className="merged-diff-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : ""}</span>
                      <span className="merged-diff-text">{line.text}</span>{"\n"}
                    </span>
                  ))}
                </span>
              ))}
            </code></pre>
          ) : (
            <p className="biny-session-change-no-diff">没有差异记录，可预览文件当前内容。</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
