/**
 * Markdown 里的 mermaid 图表块。
 *
 * mermaid 体积大，走 dynamic import 懒加载：第一条图表出现才拉取，未用到不进主包。
 * 渲染结果跟随明暗主题重出；流式期间语法经常是半截的，解析失败不报错，
 * 回退成普通代码块展示原文，成功过的 SVG 保留到最后一份有效结果。
 *
 * 图表内容是模型输出，mermaid 保持默认 securityLevel=strict（净化 HTML 标签、禁事件回调）。
 */
import { useEffect, useState } from "react";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock.js";

/** 流式增量到达频繁，debounce 掉中间态，只在停顿后尝试渲染。 */
const MERMAID_DEBOUNCE_MS = 300;

interface MermaidState {
  code: string;
  svg: string;
}

export function MermaidBlock({ code }: { code: string }): React.JSX.Element {
  const dark = useIsDarkTheme();
  const [state, setState] = useState<MermaidState | undefined>();

  useEffect(() => {
    const source = code.trim();
    if (!source) return;
    let active = true;
    const timer = setTimeout(() => {
      renderMermaid(source, dark)
        .then((svg) => {
          if (active) setState({ code: source, svg });
        })
        .catch(() => {});
    }, MERMAID_DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [code, dark]);

  // 成功过就保留最后一份有效 SVG（即使源码又变了）；从没成功过（含解析失败）回退代码块
  if (state) return <div className="markdown-mermaid" dangerouslySetInnerHTML={{ __html: state.svg }} />;
  return <MarkdownCodeBlock code={code} language="mermaid" />;
}

type MermaidApi = (typeof import("mermaid"))["default"];

let mermaidPromise: Promise<MermaidApi> | undefined;
let initializedTheme: "dark" | "default" | undefined;
let renderSequence = 0;

async function renderMermaid(source: string, dark: boolean): Promise<string> {
  const mermaid = await (mermaidPromise ??= import("mermaid").then((module) => module.default));
  const theme = dark ? "dark" : "default";
  if (initializedTheme !== theme) {
    // startOnLoad=false + suppressErrorRendering：手动控制渲染，不往页面注入错误 SVG
    mermaid.initialize({ startOnLoad: false, theme, suppressErrorRendering: true });
    initializedTheme = theme;
  }
  const id = `biny-mermaid-${++renderSequence}`;
  const container = document.createElement("div");
  container.style.position = "absolute";
  container.style.left = "-99999px";
  document.body.appendChild(container);
  try {
    const { svg } = await mermaid.render(id, source, container);
    return svg;
  } finally {
    container.remove();
    // mermaid 渲染出错时可能把临时节点遗留在 body 上，按本次 id 清扫兜底
    document.querySelectorAll(`svg[id^="${id}"], #d${id}`).forEach((element) => element.remove());
  }
}

/** 明暗判断：读 data-theme（light/dark/system），system 跟随系统偏好。 */
function useIsDarkTheme(): boolean {
  const [dark, setDark] = useState(currentIsDark);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setDark(currentIsDark());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    media.addEventListener("change", update);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  }, []);
  return dark;
}

function currentIsDark(): boolean {
  const theme = document.documentElement.dataset.theme;
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
