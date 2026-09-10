/**
 * Markdown 围栏代码块卡片：语言标签 + 复制按钮 + 高亮正文。
 *
 * 高亮走异步 hook，结果没跟上时先展示转义纯文本；MermaidBlock 解析失败时的
 * 回退展示也复用这一块。
 */
import { useHighlightedCode } from "../useHighlightedCode.js";
import { CopyButton } from "./CopyButton.js";

export function MarkdownCodeBlock({ code, language }: { code: string; language?: string }): React.JSX.Element {
  const highlighted = useHighlightedCode(code, language);
  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-language">{language ?? "文本"}</span>
        <CopyButton className="markdown-code-copy" label="复制代码" showLabel value={code} />
      </div>
      <pre><code className="shiki" dangerouslySetInnerHTML={{ __html: highlighted.html }} /></pre>
    </div>
  );
}
