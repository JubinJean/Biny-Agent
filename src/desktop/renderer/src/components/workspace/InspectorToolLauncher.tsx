/** 审阅和侧聊的展示层：保留结果和草稿，模型任务由上层送往独立只读会话。 */
import { useEffect, useRef, useState } from "react";
import type { DesktopSlashResult } from "../../../../protocol.js";
import type { InspectorMessage } from "../../../../inspectorTask.js";
import { MarkdownContent } from "../MarkdownContent.js";
import { CopyButton } from "../CopyButton.js";
import { Icon } from "../Icon.js";

export type InspectorCommandState = {
  status: "idle" | "loading" | "ready" | "error";
  result?: DesktopSlashResult;
  error?: string;
};
interface OutputProps {
  projectId: string;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
}

export function InspectorReview({ state, onRetry, projectId, onPreviewFile, onOpenExternal }: OutputProps & {
  state: InspectorCommandState;
  onRetry(input: string): void;
}): React.JSX.Element {
  const [focus, setFocus] = useState("");
  return <section aria-label="审阅结果" className="inspector-review">
    <div className="inspector-subtoolbar"><Icon name="shield" size={14} /><span>工作区审阅</span>{state.result ? <CopyButton label="复制审阅结果" value={state.result.content} /> : null}</div>
    <div className="inspector-review-scope">
      <label htmlFor="inspector-review-focus">审阅重点</label>
      <textarea id="inspector-review-focus" rows={2} maxLength={8000} value={focus} onChange={(event) => setFocus(event.target.value)} placeholder="可选，例如：关注错误处理和并发问题" />
      <div><span>当前未提交改动 · 只读</span><button type="button" disabled={state.status === "loading"} onClick={() => onRetry(focus)}>{state.status === "loading" ? "正在审阅…" : state.result ? "重新审阅" : "开始审阅"}</button></div>
    </div>
    <div className="inspector-result-scroll">
      {state.status === "error" ? <div role="alert" className="inspector-error">{state.error}</div> : null}
      {state.status === "loading" ? <div role="status" className="inspector-progress"><span className="mini-spinner" />正在检查改动…</div> : null}
      {state.result ? <MarkdownContent content={state.result.content} projectId={projectId} onPreviewFile={onPreviewFile} onOpenExternal={onOpenExternal} /> : state.status === "idle" ? <div className="inspector-empty"><Icon name="shield" size={26} /><p>检查这次改动</p><small>查找错误、回归风险和缺失的测试。<br />点击开始后执行，不会修改文件。</small></div> : null}
    </div>
  </section>;
}

export function InspectorSideChat({ state, history, onSend, onClear, projectId, onPreviewFile, onOpenExternal }: OutputProps & {
  state: InspectorCommandState;
  history: InspectorMessage[];
  onSend(input: string): void;
  onClear(): void;
}): React.JSX.Element {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const node = scrollRef.current; if (node) node.scrollTop = node.scrollHeight; }, [history.length, state.status]);
  const submit = (): void => {
    const question = input.trim();
    if (!question || state.status === "loading") return;
    onSend(question);
    setInput("");
  };
  return <section aria-label="侧边聊天" className="inspector-sidechat">
    <div className="inspector-subtoolbar"><Icon name="message" size={14} /><span>侧聊</span><button type="button" title="清空侧聊上下文" aria-label="清空侧聊上下文" disabled={!history.length || state.status === "loading"} onClick={onClear}><Icon name="compose" size={14} /></button></div>
    <div className="inspector-result-scroll" ref={scrollRef} role="log" aria-label="侧聊消息">
      {!history.length ? <div className="inspector-empty"><Icon name="message" size={26} /><p>随时问个问题</p><small>只读查看当前项目，独立于主对话。<br />可以继续追问，切换面板会保留上下文。</small></div> : null}
      {history.map((message, index) => <article className={`inspector-chat-message is-${message.role}`} key={index}>
        <div className="inspector-chat-author">{message.role === "user" ? "你" : "Biny"}{message.role === "assistant" ? <CopyButton label="复制回答" value={message.content} /> : null}</div>
        <MarkdownContent content={message.content} projectId={projectId} onPreviewFile={onPreviewFile} onOpenExternal={onOpenExternal} />
      </article>)}
      {state.status === "loading" ? <div className="inspector-progress" role="status"><span className="mini-spinner" />正在思考…</div> : null}
      {state.status === "error" ? <div className="inspector-error" role="alert">{state.error}<button type="button" onClick={() => { const last = history.at(-1); if (last?.role === "user") setInput(last.content); }}>重新编辑问题</button></div> : null}
    </div>
    <form className="inspector-chat-composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <textarea aria-label="侧聊问题" placeholder="询问当前项目…" rows={3} maxLength={8000} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
      }} />
      <div><small>Enter 发送 · Shift+Enter 换行</small><button type="submit" aria-label="发送侧聊问题" disabled={!input.trim() || state.status === "loading"}><Icon name="arrow-up" size={16} /></button></div>
    </form>
  </section>;
}
