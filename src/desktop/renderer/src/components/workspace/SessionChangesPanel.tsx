/**
 * 右侧 dock 的「变更」视图：当前会话里 Agent 改过的文件。
 *
 * 复刻 ArtifactSidebar Files/Changes tab 的人体工学：顶部统计头（N 个文件 · 写入/编辑
 * 次数 · ±行数），下面每个文件一行，行上带类型角标、操作 chip 和 diffstat；点行展开
 * 完整路径与合并 diff（同聊天里的合并编辑行同款样式），没有 diff 的写入给「预览」
 * 入口。数据由 App 从时间线收集后注入，这里只做展示与本地展开状态。
 */
import { useMemo, useState } from "react";
import { parseDiffHunks, sessionChangeTotals, type SessionFileChange } from "../../sessionChanges.js";
import { Icon } from "../Icon.js";
import { FileTypeMarker } from "./FileTypeMarker.js";

export function SessionChangesPanel({ changes, onPreviewFile }: {
  changes: SessionFileChange[];
  onPreviewFile(path: string): void;
}): React.JSX.Element {
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

  if (changes.length === 0) {
    return (
      <div className="biny-session-changes-empty">
        <Icon name="diff" size={22} />
        <p className="biny-session-changes-empty-title">暂无文件变更</p>
        <p className="biny-session-changes-empty-hint">Agent 修改过的文件会出现在这里</p>
      </div>
    );
  }

  return (
    <div className="biny-session-changes">
      <header className="biny-session-changes-summary">
        <span className="biny-session-changes-count">{totals.files} 个文件</span>
        {totals.writes > 0 ? (
          <span className="biny-session-changes-stat is-write">
            <Icon name="file" size={12} />
            {totals.writes} 次写入
          </span>
        ) : null}
        {totals.edits > 0 ? (
          <span className="biny-session-changes-stat is-edit">
            <Icon name="edit" size={12} />
            {totals.edits} 次编辑
          </span>
        ) : null}
        {totals.add + totals.del > 0 ? (
          <span className="diff-stats biny-session-changes-diffstat">
            <span className="diff-add">+{totals.add}</span>
            <span className="diff-delete">-{totals.del}</span>
          </span>
        ) : null}
      </header>
      <div className="biny-session-changes-list">
        {changes.map((change) => (
          <ChangeRow
            change={change}
            expanded={expandedPaths.has(change.path)}
            key={change.path}
            onPreviewFile={onPreviewFile}
            onToggle={() => togglePath(change.path)}
          />
        ))}
      </div>
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
        <FileTypeMarker name={name} />
        <span className="biny-session-change-name">{name}</span>
        {dir !== "" ? <span className="biny-session-change-dir">{dir}</span> : null}
        <span className={`biny-session-change-chip${change.status === "writing" ? " is-active" : ""} is-${change.operation}`}>
          {change.operation === "write" ? (change.changeCount > 1 ? `${change.changeCount} 次写入` : "写入") : (change.changeCount > 1 ? `${change.changeCount} 次编辑` : "编辑")}
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
          <div className="biny-session-change-path" title={change.path}>{change.path}</div>
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
            <div className="biny-session-change-preview">
              <span>这个文件没有可展示的 diff</span>
              <button onClick={() => onPreviewFile(change.path)} type="button">
                <Icon name="eye" size={12} />
                预览文件
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
