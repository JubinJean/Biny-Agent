/** 工具面板读取当前时间线；浏览器与提交动作复用现有桌面入口。 */
import { useState } from "react";
import type { TimelineTool } from "../../sessionTimeline.js";
import type { SessionFileChange } from "../../sessionChanges.js";
import { Icon } from "../Icon.js";
import { CopyButton } from "../CopyButton.js";

export function WorkspaceToolsPanel({ tools }: { tools: TimelineTool[] }): React.JSX.Element {
  const labels: Record<string, string> = { waiting: "等待中", running: "运行中", success: "已完成", failed: "失败", denied: "已拒绝", aborted: "已中断", cancelled: "已取消", skipped: "已跳过", unknown: "状态未知" };
  return <section className="inspector-utility-panel">
    <header className="inspector-utility-heading"><h2>工具运行</h2><p>本次对话中的工具调用、状态和耗时。</p></header>
    <div className="inspector-result-scroll">{tools.length === 0 ? <p className="inspector-muted">此对话还没有工具调用。</p> : [...tools].reverse().map((tool, index) => <details className="inspector-tool-row" key={`${tool.id}:${index}`}>
      <summary><Icon name="wrench" size={14} /><span>{tool.tool}</span><small>{labels[tool.status] ?? tool.status}</small>{tool.durationMs !== undefined ? <small>{(tool.durationMs / 1000).toFixed(1)}s</small> : null}</summary>
      {tool.description ? <p>{tool.description}</p> : null}
      {tool.error ? <p className="inspector-error">{tool.error}</p> : null}
      <pre>{JSON.stringify(tool.args, null, 2)}</pre>
    </details>)}</div>
  </section>;
}

export function WorkspaceBrowserPanel({ onWarning }: { onWarning(message: string): void }): React.JSX.Element {
  const [url, setUrl] = useState("");
  const [opening, setOpening] = useState(false);
  const open = async (): Promise<void> => {
    if (opening) return;
    setOpening(true);
    try {
      const value = url.trim();
      const target = value ? new URL(/^https?:\/\//i.test(value) ? value : `${/^(?:localhost|127\.0\.0\.1)(?::|\/|$)/i.test(value) ? "http" : "https"}://${value}`) : undefined;
      if (target && !["http:", "https:"].includes(target.protocol)) throw new Error("请输入 HTTP 或 HTTPS 地址。");
      await window.biny.openBrowser(target?.href);
    } catch (error) { onWarning(error instanceof Error ? error.message : String(error)); }
    finally { setOpening(false); }
  };
  return <section className="inspector-utility-panel"><header className="inspector-utility-heading"><h2>浏览器</h2><p>使用内置浏览器打开网页或本地预览地址。</p></header>
    <form className="inspector-browser-form" onSubmit={(event) => { event.preventDefault(); void open(); }}><label htmlFor="inspector-browser-url">网址</label><input id="inspector-browser-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https:// 或 localhost:3000" /><button type="submit" disabled={opening}>{opening ? "正在打开…" : "打开浏览器"}<Icon name="external" size={14} /></button></form>
  </section>;
}

export function WorkspaceCommitPanel({ changes, onOpenTerminal }: { changes: SessionFileChange[]; onOpenTerminal(): void }): React.JSX.Element {
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const paths = changes.filter((change) => selected.has(change.path) && change.status === "completed").map((change) => change.path);
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const command = paths.length && message.trim() ? `git --literal-pathspecs add -- ${paths.map(quote).join(" ")} &&\ngit diff --cached --check && git --literal-pathspecs commit --only -m ${quote(message.trim())} -- ${paths.map(quote).join(" ")}` : "";
  return <section className="inspector-utility-panel"><header className="inspector-utility-heading"><h2>提交</h2><p>选择本次对话更改的文件，在终端检查并提交。</p></header>
    <div className="inspector-result-scroll">
      {!changes.length ? <p className="inspector-muted">本次对话还没有文件更改。可在终端查看项目的 Git 状态。</p> : changes.map((change) => <label className="inspector-commit-file" key={change.path}><input type="checkbox" checked={selected.has(change.path)} disabled={change.status !== "completed"} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(change.path)) next.delete(change.path); else next.add(change.path); return next; })} /><span>{change.path}</span></label>)}
      <label className="inspector-commit-message">提交说明<textarea rows={3} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="fix(desktop): 优化工作区面板" /></label>
      {command ? <div className="inspector-commit-command"><pre>{command}</pre><CopyButton value={command} label="复制提交命令" /></div> : null}
      <button className="inspector-open-terminal" type="button" onClick={onOpenTerminal}><Icon name="terminal" size={14} />打开终端</button>
    </div>
  </section>;
}
