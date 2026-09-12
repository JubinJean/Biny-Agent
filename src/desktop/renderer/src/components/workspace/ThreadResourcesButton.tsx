/** 会话产出索引与文件详情分离；原生 popover 负责顶层命中、外部关闭及 Escape。 */
import { useId, useMemo, useRef, useState } from "react";
import { collectSessionChanges } from "../../sessionChanges.js";
import type { TimelineTurn } from "../../sessionTimeline.js";
import { Icon } from "../Icon.js";
import { FileTypeMarker } from "./FileTypeMarker.js";

export function ThreadResourcesButton({ turns, onPreviewFile, onOpenExternal }: {
  turns: TimelineTurn[];
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
}): React.JSX.Element | null {
  const id = useId();
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [showOutputs, setShowOutputs] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [copyError, setCopyError] = useState(false);
  const { outputs, sources } = useMemo(() => {
    const links = new Map<string, string>();
    // 只收集回答中实际引用的 HTTP 链接，不把工具参数、代码或凭据扫描成来源。
    for (const turn of turns) {
      const prose = turn.assistant.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
      for (const match of prose.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
        try { const url = new URL(match[2]!); links.set(url.href, url.hostname); } catch { /* 不显示不完整的流式链接。 */ }
      }
    }
    return { outputs: collectSessionChanges(turns).filter((file) => file.status === "completed"), sources: [...links].map(([url, title]) => ({ url, title })) };
  }, [turns]);
  if (!outputs.length) return null;
  const close = (): void => { popup.current?.hidePopover(); trigger.current?.focus(); };
  const selectedFile = outputs.find((file) => file.path === selected);
  return <>
    <button ref={trigger} type="button" popoverTarget={id} aria-controls={id} aria-expanded={open} aria-haspopup="dialog" aria-label={`产出与来源，${outputs.length + sources.length} 项`} title="产出与来源" className={`biny-toolbar-button biny-resource-trigger${open ? " is-active" : ""}`}>
      <Icon name="list-tree" size={15} /><span className="biny-resource-count">{outputs.length + sources.length}</span>
    </button>
    <div ref={popup} id={id} popover="auto" role="dialog" aria-label="产出与来源" className="biny-thread-resources" onToggle={(event) => {
      setOpen(event.newState === "open");
      if (event.newState === "closed") { setShowOutputs(false); setShowSources(false); setSelected(undefined); setCopyError(false); }
    }}>
      <div className="biny-resource-scroll">
        <h2>产出</h2>
        {(showOutputs ? outputs : outputs.slice(0, 6)).map((file) => <button key={file.path} type="button" className="biny-resource-row" aria-expanded={selected === file.path} onClick={() => { setSelected(selected === file.path ? undefined : file.path); setCopyError(false); }} title={file.path}>
          <span className="biny-resource-icon"><FileTypeMarker name={file.path} /></span>
          <span className="biny-resource-label"><strong>{file.path.replaceAll("\\", "/").split("/").at(-1)}</strong><small>{file.path}</small></span>
        </button>)}
        {outputs.length > 6 ? <button className="biny-resource-more" type="button" onClick={() => setShowOutputs(!showOutputs)}>{showOutputs ? "收起" : `再显示 ${outputs.length - 6} 项`}</button> : null}
        {sources.length ? <h2>来源</h2> : null}
        {(showSources ? sources : sources.slice(0, 6)).map((source) => <button className="biny-resource-row" type="button" key={source.url} title={source.url} onClick={() => { close(); onOpenExternal(source.url); }}><span className="biny-resource-icon"><Icon name="globe" size={16} /></span><span className="biny-resource-label"><strong>{source.title}</strong></span><Icon name="arrow-up-right" size={12} /></button>)}
        {sources.length > 6 ? <button className="biny-resource-more" type="button" onClick={() => setShowSources(!showSources)}>{showSources ? "收起" : `再显示 ${sources.length - 6} 项`}</button> : null}
      </div>
      {selectedFile ? <div className="biny-resource-actions" aria-label="文件操作">
        <button type="button" onClick={() => { close(); onPreviewFile(selectedFile.path); }}><Icon name="eye" size={15} />在右侧预览</button>
        <button type="button" onClick={() => { void navigator.clipboard.writeText(selectedFile.path).then(close).catch(() => setCopyError(true)); }}><Icon name="copy" size={15} />复制路径</button>
        {copyError ? <small role="alert">复制失败，请重试</small> : null}
      </div> : null}
    </div>
  </>;
}
