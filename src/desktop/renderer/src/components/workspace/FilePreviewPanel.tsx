/**
 * 右侧 Inspector 的文件面板。
 *
 * 预览按文件类型分三路：文本/代码走高亮 + 行号 gutter；图片走主进程 data URL
 * 内联显示；二进制/超限给「使用系统应用打开」兜底。文件树支持懒加载展开和名称
 * 过滤。这里只做展示与本地交互，数据请求全部由 useWorkspaceInspector 的回调注入。
 */
import { useState } from "react";
import { IconButton } from "@astryxdesign/core/IconButton";
import { TextInput } from "@astryxdesign/core/TextInput";
import type {
  DesktopWorkspaceDirectoryEntry,
  DesktopWorkspaceFilePreview
} from "../../../../protocol.js";
import { highlightWorkspaceFile } from "../../syntaxHighlight.js";
import { workspaceFileMarker } from "../../workspaceFileMarker.js";
import { useInlineImage } from "../../inlineImage.js";
import { CopyButton } from "../CopyButton.js";
import { Icon } from "../Icon.js";

export interface FilePreviewState {
  source: string;
  path: string;
  status: "loading" | "ready" | "error";
  file?: DesktopWorkspaceFilePreview;
  error?: string;
}

export interface FileDirectoryState {
  status: "loading" | "ready" | "error";
  entries?: DesktopWorkspaceDirectoryEntry[];
  error?: string;
}

export function FilePreviewPanel({ preview, directoryStates, expandedDirectories, projectId, onOpenFile, onPreviewFile, onShowFiles, onToggleDirectory }: {
  preview?: FilePreviewState;
  directoryStates: ReadonlyMap<string, FileDirectoryState>;
  expandedDirectories: ReadonlySet<string>;
  projectId: string;
  onOpenFile(path: string): void;
  onPreviewFile(path: string): void;
  onShowFiles(): void;
  onToggleDirectory(path: string): void;
}): React.JSX.Element {
  const file = preview?.file;
  const path = file?.path ?? preview?.path;
  const [query, setQuery] = useState("");
  const [fileTreeOpen, setFileTreeOpen] = useState(true);
  const browserOnly = !preview;
  const treeVisible = browserOnly || fileTreeOpen;
  return (
    <aside aria-label={preview ? "文件预览" : "文件浏览器"} className="file-preview-panel file-browser-panel">
      <header className="file-browser-path">
        <span className="file-browser-current-path">{path ? `/${path}` : "/"}</span>
        <div className="file-browser-path-actions">
          {preview?.status === "ready" && path ? <IconButton icon={<Icon name="external" size={14} />} label="使用系统应用打开" onClick={() => onOpenFile(path)} size="sm" tooltip="使用系统应用打开" variant="ghost" /> : null}
          {preview ? <IconButton icon={<Icon name="close" size={14} />} label="关闭当前文件" onClick={onShowFiles} size="sm" tooltip="返回文件列表" variant="ghost" /> : null}
          {preview ? (
            <IconButton
              aria-pressed={fileTreeOpen}
              icon={<Icon name="folder-panel" size={15} />}
              label={fileTreeOpen ? "隐藏文件树" : "显示文件树"}
              onClick={() => setFileTreeOpen((current) => !current)}
              size="sm"
              tooltip={fileTreeOpen ? "隐藏文件树" : "显示文件树"}
              variant={fileTreeOpen ? "secondary" : "ghost"}
            />
          ) : null}
        </div>
      </header>
      <div className={`file-browser-body${treeVisible ? "" : " is-tree-hidden"}${browserOnly ? " is-browser-only" : ""}`}>
        {preview ? <div className="file-browser-content"><FilePreviewContent preview={preview} projectId={projectId} onOpenFile={onOpenFile} /></div> : null}
        <div aria-hidden={treeVisible ? undefined : true} className="file-browser-tree" inert={treeVisible ? undefined : true}>
          <TextInput hasClear isLabelHidden label="筛选文件" onChange={setQuery} placeholder="筛选文件…" size="sm" startIcon={<Icon name="search" size={13} />} value={query} width="100%" />
          <FileTree
            directoryStates={directoryStates}
            expandedDirectories={expandedDirectories}
            onPreviewFile={onPreviewFile}
            onToggleDirectory={onToggleDirectory}
            path="."
            query={query}
          />
        </div>
      </div>
    </aside>
  );
}

/** 可内联显示的图片扩展名（与主进程 readInlineImage 的 media type 表一致）。 */
const imageExtensions = new Set(["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]);

function FilePreviewContent({ preview, projectId, onOpenFile }: {
  preview: FilePreviewState;
  projectId: string;
  onOpenFile(path: string): void;
}): React.JSX.Element {
  const file = preview.file;
  if (preview.status === "loading") return <PreviewState icon="file" text="正在读取文件…" />;
  if (preview.status === "error") return <PreviewState icon="warning" error text={preview.error ?? "读取失败"} />;
  if (!file) return <PreviewState icon="file" text="无法读取文件" />;
  const path = file.path;
  if (file.binary) {
    return imageExtensions.has(extensionOf(path))
      ? <ImagePreview path={path} projectId={projectId} onOpenFile={onOpenFile} />
      : (
        <PreviewState icon="file" text="这是二进制文件，请使用系统应用打开。">
          <button className="file-preview-open" onClick={() => onOpenFile(path)} type="button">使用系统应用打开</button>
        </PreviewState>
      );
  }
  if (!file.content) return <PreviewState icon="file" text="空文件" />;
  return <CodeFilePreview file={file} />;
}

/** 文本/代码预览：语言 + 大小元信息行，正文是行号 gutter + 高亮代码。 */
function CodeFilePreview({ file }: { file: DesktopWorkspaceFilePreview }): React.JSX.Element {
  const highlighted = highlightWorkspaceFile(file.path, file.content ?? "");
  const lines = (file.content ?? "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return (
    <div className="file-preview-document">
      <div className="file-preview-meta">
        <span>{highlighted.language ?? "纯文本"}</span>
        <div className="file-preview-meta-actions">
          <span>{formatBytes(file.bytes)}{file.truncated ? " · 仅显示前 512 KB" : ""}</span>
          <CopyButton className="copy-button" label="复制文件内容" value={file.content ?? ""} />
        </div>
      </div>
      <div className="file-preview-body">
        <div aria-hidden="true" className="file-preview-gutter">
          {lines.map((_, index) => <span key={index}>{index + 1}</span>)}
        </div>
        <pre className="file-preview-code"><code className={highlighted.language ? `hljs language-${highlighted.language}` : "hljs"} dangerouslySetInnerHTML={{ __html: highlighted.html }} /></pre>
      </div>
    </div>
  );
}

/** 图片预览：主进程转 data URL 内联显示；读不到或超限时退回二进制兜底。 */
function ImagePreview({ path, projectId, onOpenFile }: { path: string; projectId: string; onOpenFile(path: string): void }): React.JSX.Element {
  const source = useInlineImage(projectId, path);
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>();
  if (!source) {
    return (
      <PreviewState icon="file" text="图片无法内联预览，请使用系统应用打开。">
        <button className="file-preview-open" onClick={() => onOpenFile(path)} type="button">使用系统应用打开</button>
      </PreviewState>
    );
  }
  return (
    <div className="file-preview-document">
      <div className="file-preview-meta">
        <span>{extensionOf(path).toUpperCase()}</span>
        {dimensions ? <span>{`${String(dimensions.width)} × ${String(dimensions.height)}`}</span> : null}
      </div>
      <div className="file-preview-image">
        <img
          alt={path}
          onLoad={(event) => {
            const target = event.currentTarget;
            setDimensions({ width: target.naturalWidth, height: target.naturalHeight });
          }}
          src={source}
        />
      </div>
    </div>
  );
}

function PreviewState({ icon, text, error, children }: { icon: "file" | "warning"; text: string; error?: boolean; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className={`file-preview-state${error ? " is-error" : ""}`}>
      <Icon name={icon} size={18} />
      <span>{text}</span>
      {children}
    </div>
  );
}

function FileTree({ path, query, directoryStates, expandedDirectories, onToggleDirectory, onPreviewFile, depth = 0 }: {
  path: string;
  query: string;
  directoryStates: ReadonlyMap<string, FileDirectoryState>;
  expandedDirectories: ReadonlySet<string>;
  onToggleDirectory(path: string): void;
  onPreviewFile(path: string): void;
  depth?: number;
}): React.JSX.Element {
  const state = directoryStates.get(path);
  if (!state || state.status === "loading") return <div className="file-tree-state"><span className="mini-spinner" /><span>正在读取目录…</span></div>;
  if (state.status === "error") return <div className="file-tree-state is-error"><Icon name="warning" size={14} /><span>{state.error}</span></div>;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const entries = (state.entries ?? []).filter((entry) => !normalizedQuery || entry.name.toLocaleLowerCase().includes(normalizedQuery));
  if (!entries.length) return <div className="file-tree-state">{normalizedQuery ? "没有匹配文件" : "目录为空"}</div>;
  return (
    <div className="file-tree-level">
      {entries.map((entry) => {
        const isDirectory = entry.kind === "directory";
        const isExpanded = isDirectory && expandedDirectories.has(entry.path);
        return (
          <div key={entry.path}>
            <button className={`file-tree-row${isDirectory ? " is-directory" : ""}`} onClick={() => isDirectory ? onToggleDirectory(entry.path) : onPreviewFile(entry.path)} style={{ paddingLeft: `${8 + depth * 16}px` }} title={entry.path} type="button">
              {isDirectory ? <span className={`file-tree-disclosure${isExpanded ? " is-expanded" : ""}`}><Icon name="chevron" size={13} /></span> : <span aria-hidden="true" className="file-tree-disclosure is-file-slot" />}
              {isDirectory ? <Icon className="file-tree-folder-icon" name="folder" size={14} /> : <FileTreeMarker name={entry.name} />}
              <span>{entry.name}</span>
            </button>
            {isDirectory && isExpanded ? <FileTree directoryStates={directoryStates} depth={depth + 1} expandedDirectories={expandedDirectories} onPreviewFile={onPreviewFile} onToggleDirectory={onToggleDirectory} path={entry.path} query={query} /> : null}
          </div>
        );
      })}
    </div>
  );
}

function FileTreeMarker({ name }: { name: string }): React.JSX.Element {
  const marker = workspaceFileMarker(name);
  return <span aria-hidden="true" className={`file-type-marker is-${marker.tone}${marker.label.length > 2 ? " is-wide" : ""}`}>{marker.label}</span>;
}

function extensionOf(path: string): string {
  return path.split(".").at(-1)?.toLocaleLowerCase() ?? "";
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${String(bytes)} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(bytes >= 10_240 ? 0 : 1)} KB`;
  return `${(bytes / 1_024 / 1_024).toFixed(1)} MB`;
}
