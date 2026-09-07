/* eslint-disable react-refresh/only-export-components -- Inspector 请求状态与私有视图必须共享同一生命周期。 */
/**
 * Workspace 右侧工具区的状态与命令。
 *
 * 右缘是一条常驻的浮动 rail（文件/终端/审阅/侧聊/浏览器），点击前四个打开 tab 化的
 * dock 面板，浏览器是直接动作。文件树、文件预览的展示在 FilePreviewPanel；这里只负责
 * 预览/目录的请求状态、面板尺寸与 previewFile 命令，会话区只拿到 rail/dock 节点。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DesktopWorkspaceDirectory, DesktopWorkspaceFilePreview, DesktopSlashResult } from "../../../../protocol.js";
import {
  clampFilePanelWidth,
  MAX_FILE_PANEL_WIDTH,
  MIN_FILE_PANEL_WIDTH
} from "../../../../filePanelSizing.js";
import { Icon, type IconName } from "../Icon.js";
import { TerminalView } from "../TerminalView.js";
import { useClosingPresence } from "../../useClosingPresence.js";
import { FilePreviewPanel, type FileDirectoryState, type FilePreviewState } from "./FilePreviewPanel.js";
import {
  InspectorReview,
  InspectorSideChat,
  type InspectorCommandState
} from "./InspectorToolLauncher.js";

interface UseWorkspaceInspectorOptions {
  filePanelResizing: boolean;
  filePanelWidth: number;
  projectId?: string;
  source: string;
  onFilePanelResizeEnd(width: number): void;
  onFilePanelResizeStart(): void;
  onFilePanelWidthChange(width: number): void;
  onListDirectory(path: string): Promise<DesktopWorkspaceDirectory>;
  onOpenFile(path: string): void;
  onOpenBrowser(): Promise<void>;
  onReadFile(path: string): Promise<DesktopWorkspaceFilePreview>;
  onRunCommand(command: string): Promise<DesktopSlashResult>;
  /** rail 动作（浏览器打开等）失败的提示通道。 */
  onWarning(message: string): void;
}

type InspectorView = "files" | "terminal" | "review" | "side-chat";

const inspectorViewMetadata: Record<InspectorView, { icon: IconName; label: string }> = {
  files: { icon: "folder", label: "文件" },
  terminal: { icon: "terminal", label: "终端" },
  review: { icon: "shield", label: "审阅" },
  "side-chat": { icon: "message", label: "侧聊" }
};

/** rail 上「审阅」先打开面板再触发 /review，其余面板视图直接切换；浏览器是纯动作。 */
type RailAction = InspectorView | "browser";

export function useWorkspaceInspector({
  filePanelResizing,
  filePanelWidth,
  projectId,
  source,
  onFilePanelResizeEnd,
  onFilePanelResizeStart,
  onFilePanelWidthChange,
  onListDirectory,
  onOpenFile,
  onOpenBrowser,
  onRunCommand,
  onReadFile,
  onWarning
}: UseWorkspaceInspectorOptions): {
  dock?: React.JSX.Element;
  rail?: React.JSX.Element;
  layout: {
    open: boolean;
    resizing: boolean;
    width: number;
  };
  open: boolean;
  filesOpen: boolean;
  terminalOpen: boolean;
  openFiles(): void;
  previewFile(path: string): void;
  toggleInspector(): void;
  toggleTerminal(): void;
} {
  const previewRequestRef = useRef(0);
  const directoryRequestIdRef = useRef(0);
  const directoryRequestRef = useRef(new Map<string, number>());
  const reviewRequestRef = useRef(0);
  const reviewRunningRef = useRef(false);
  const sideChatRequestRef = useRef(0);
  const sideChatRunningRef = useRef(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorView, setInspectorView] = useState<InspectorView>("files");
  const [preview, setPreview] = useState<FilePreviewState>();
  const [directoryStates, setDirectoryStates] = useState<Map<string, FileDirectoryState>>(new Map());
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() => new Set());
  const [reviewState, setReviewState] = useState<InspectorCommandState>({ status: "idle" });
  const [sideChatState, setSideChatState] = useState<InspectorCommandState>({ status: "idle" });
  // 和左侧侧栏共用 250ms 的几何过渡，关闭时要等宽度动画结束后再卸载。
  const inspectorPresence = useClosingPresence(inspectorOpen && Boolean(projectId), 250);
  const activePreview = preview?.source === source ? preview : undefined;

  useLayoutEffect(() => {
    previewRequestRef.current += 1;
    directoryRequestIdRef.current += 1;
    directoryRequestRef.current.clear();
    setPreview(undefined);
    setDirectoryStates(new Map());
    setExpandedDirectories(new Set());
    reviewRequestRef.current += 1;
    reviewRunningRef.current = false;
    sideChatRequestRef.current += 1;
    sideChatRunningRef.current = false;
    setReviewState({ status: "idle" });
    setSideChatState({ status: "idle" });
  }, [source]);

  const loadDirectory = useCallback((relativePath: string): void => {
    const normalizedPath = normalizeWorkspacePath(relativePath);
    const requestId = directoryRequestIdRef.current + 1;
    directoryRequestIdRef.current = requestId;
    directoryRequestRef.current.set(normalizedPath, requestId);
    setDirectoryStates((current) => {
      const next = new Map(current);
      next.set(normalizedPath, { status: "loading" });
      return next;
    });
    void onListDirectory(normalizedPath).then((directory) => {
      if (directoryRequestRef.current.get(normalizedPath) !== requestId) return;
      setDirectoryStates((current) => {
        const next = new Map(current);
        next.set(normalizeWorkspacePath(directory.path), { status: "ready", entries: directory.entries });
        return next;
      });
    }).catch((error: unknown) => {
      if (directoryRequestRef.current.get(normalizedPath) !== requestId) return;
      setDirectoryStates((current) => {
        const next = new Map(current);
        next.set(normalizedPath, { status: "error", error: errorMessage(error) });
        return next;
      });
    });
  }, [onListDirectory]);

  const openInspector = useCallback((view: InspectorView): void => {
    if (!projectId) return;
    setInspectorView(view);
    setInspectorOpen(true);
    if (view === "files" && !directoryStates.has(".")) loadDirectory(".");
  }, [directoryStates, loadDirectory, projectId]);

  const toggleInspector = useCallback((): void => {
    if (inspectorOpen) {
      setInspectorOpen(false);
      return;
    }
    openInspector(inspectorView);
  }, [inspectorOpen, inspectorView, openInspector]);

  const openFiles = useCallback((): void => {
    openInspector("files");
  }, [openInspector]);

  const toggleTerminal = useCallback((): void => {
    if (inspectorOpen && inspectorView === "terminal") {
      setInspectorOpen(false);
      return;
    }
    openInspector("terminal");
  }, [inspectorOpen, inspectorView, openInspector]);

  const previewFile = useCallback((path: string): void => {
    const request = previewRequestRef.current + 1;
    previewRequestRef.current = request;
    setInspectorView("files");
    setInspectorOpen(true);
    setPreview({ source, path, status: "loading", file: undefined, error: undefined });
    void onReadFile(path).then((file) => {
      if (previewRequestRef.current !== request) return;
      setPreview({ source, path: file.path, status: "ready", file, error: undefined });
    }).catch((error: unknown) => {
      if (previewRequestRef.current !== request) return;
      setPreview({ source, path, status: "error", file: undefined, error: errorMessage(error) });
    });
    if (!directoryStates.has(".")) loadDirectory(".");
  }, [directoryStates, loadDirectory, onReadFile, source]);

  const showFileBrowser = useCallback((): void => {
    previewRequestRef.current += 1;
    setPreview(undefined);
    if (!directoryStates.has(".")) loadDirectory(".");
  }, [directoryStates, loadDirectory]);

  const toggleDirectory = useCallback((relativePath: string): void => {
    const normalizedPath = normalizeWorkspacePath(relativePath);
    const willExpand = !expandedDirectories.has(normalizedPath);
    setExpandedDirectories((current) => {
      const next = new Set(current);
      if (willExpand) next.add(normalizedPath);
      else next.delete(normalizedPath);
      return next;
    });
    const state = directoryStates.get(normalizedPath);
    if (willExpand && (!state || state.status === "error")) loadDirectory(normalizedPath);
  }, [directoryStates, expandedDirectories, loadDirectory]);

  const runReview = useCallback((): void => {
    if (reviewRunningRef.current) return;
    reviewRunningRef.current = true;
    const request = reviewRequestRef.current + 1;
    reviewRequestRef.current = request;
    setReviewState({ status: "loading" });
    void onRunCommand("/review").then((result) => {
      if (reviewRequestRef.current !== request) return;
      setReviewState({ status: "ready", result });
    }).catch((error: unknown) => {
      if (reviewRequestRef.current !== request) return;
      setReviewState({ status: "error", error: errorMessage(error) });
    }).finally(() => {
      if (reviewRequestRef.current === request) reviewRunningRef.current = false;
    });
  }, [onRunCommand]);

  const runSideChat = useCallback((input: string): void => {
    if (sideChatRunningRef.current) return;
    sideChatRunningRef.current = true;
    const request = sideChatRequestRef.current + 1;
    sideChatRequestRef.current = request;
    setSideChatState({ status: "loading" });
    // `--` 明确要求走前台问答，避免问题恰好以 status/start/cancel/agents 开头时触发控制命令。
    void onRunCommand(`/subagent -- ${input}`).then((result) => {
      if (sideChatRequestRef.current !== request) return;
      setSideChatState({ status: "ready", result });
    }).catch((error: unknown) => {
      if (sideChatRequestRef.current !== request) return;
      setSideChatState({ status: "error", error: errorMessage(error) });
    }).finally(() => {
      if (sideChatRequestRef.current === request) sideChatRunningRef.current = false;
    });
  }, [onRunCommand]);

  const openBrowser = useCallback((): void => {
    void onOpenBrowser().catch((error: unknown) => onWarning(errorMessage(error)));
  }, [onOpenBrowser, onWarning]);

  const openRailAction = useCallback((action: RailAction): void => {
    if (action === "browser") {
      openBrowser();
      return;
    }
    if (action === "review") {
      openInspector("review");
      runReview();
      return;
    }
    // rail 上点当前已打开的 tab 再点一次是收起面板。
    if (inspectorOpen && inspectorView === action) {
      setInspectorOpen(false);
      return;
    }
    openInspector(action);
  }, [inspectorOpen, inspectorView, openBrowser, openInspector, runReview]);

  useEffect(() => {
    if (!projectId) return;
    const handleShortcut = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat || isTextEntryTarget(event.target) || !event.metaKey) return;
      if (event.shiftKey && !event.altKey && event.code === "KeyG") {
        event.preventDefault();
        openRailAction("review");
        return;
      }
      if (!event.shiftKey && !event.altKey && event.code === "KeyT") {
        event.preventDefault();
        openRailAction("browser");
        return;
      }
      if (!event.shiftKey && !event.altKey && event.code === "KeyP") {
        event.preventDefault();
        openRailAction("files");
        return;
      }
      if (!event.shiftKey && event.altKey && event.code === "KeyS") {
        event.preventDefault();
        openRailAction("side-chat");
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [openRailAction, projectId]);

  const toolContent = !projectId ? null : inspectorView === "terminal" ? <TerminalView projectId={projectId} />
    : inspectorView === "files" ? (
      <FilePreviewPanel
        directoryStates={directoryStates}
        expandedDirectories={expandedDirectories}
        onOpenFile={onOpenFile}
        onPreviewFile={previewFile}
        onShowFiles={showFileBrowser}
        onToggleDirectory={toggleDirectory}
        preview={activePreview}
        projectId={projectId}
      />
    ) : inspectorView === "review" ? <InspectorReview onRetry={runReview} state={reviewState} />
      : <InspectorSideChat onSend={runSideChat} state={sideChatState} />;

  const inspector = inspectorPresence.present && projectId ? (
    <div
      className={`desktop-inspector-wrap is-${inspectorPresence.phase}${filePanelResizing ? " is-resizing" : ""}`}
    >
      <FilePanelResizer
        onResizeEnd={onFilePanelResizeEnd}
        onResizeStart={onFilePanelResizeStart}
        onWidthChange={onFilePanelWidthChange}
        width={filePanelWidth}
      />
      <aside aria-label="工作区工具" className="desktop-inspector" role="complementary">
        <header className="desktop-inspector-header">
          <span className="biny-inspector-title">{inspectorViewMetadata[inspectorView].label}</span>
          <button aria-label="收起工作区工具" className="desktop-inspector-close" onClick={() => setInspectorOpen(false)} title="收起工作区工具" type="button">
            <Icon name="panel-right" size={15} />
          </button>
        </header>
        <nav aria-label="工具切换" className="biny-inspector-tabs">
          {(Object.keys(inspectorViewMetadata) as InspectorView[]).map((view) => {
            const active = inspectorView === view;
            return (
              <button
                aria-current={active ? "page" : undefined}
                aria-label={inspectorViewMetadata[view].label}
                className={`biny-inspector-tab${active ? " is-active" : ""}`}
                key={view}
                onClick={() => openInspector(view)}
                type="button"
              >
                <Icon name={inspectorViewMetadata[view].icon} size={13} />
                <span>{inspectorViewMetadata[view].label}</span>
              </button>
            );
          })}
        </nav>
        <div className="desktop-inspector-body" id="desktop-inspector-panel">
          <div className="biny-inspector-view-content" key={inspectorView}>{toolContent}</div>
        </div>
      </aside>
    </div>
  ) : undefined;

  // rail 常驻右缘（有项目即可见）；right 随 dock 流宽度变量滑动，与面板开合同帧。
  const rail = projectId ? (
    <div aria-label="工作区工具" className="biny-inspector-rail" role="toolbar">
      {(Object.keys(inspectorViewMetadata) as InspectorView[]).map((view) => (
        <RailButton
          active={inspectorOpen && inspectorView === view}
          icon={inspectorViewMetadata[view].icon}
          key={view}
          label={inspectorViewMetadata[view].label}
          onClick={() => openRailAction(view)}
        />
      ))}
      <RailButton active={false} icon="site" label="浏览器" onClick={openBrowser} />
    </div>
  ) : undefined;

  return {
    dock: inspector,
    rail,
    layout: {
      open: inspectorOpen && Boolean(projectId),
      resizing: filePanelResizing,
      width: filePanelWidth
    },
    open: inspectorOpen && Boolean(projectId),
    filesOpen: inspectorOpen && inspectorView === "files",
    terminalOpen: inspectorOpen && inspectorView === "terminal",
    openFiles,
    previewFile,
    toggleInspector,
    toggleTerminal
  };
}

function RailButton({ active, icon, label, onClick }: { active: boolean; icon: IconName; label: string; onClick(): void }): React.JSX.Element {
  return (
    <button
      aria-label={label}
      aria-pressed={active}
      className={`biny-inspector-rail-btn${active ? " is-active" : ""}`}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Icon name={icon} size={16} />
    </button>
  );
}

function FilePanelResizer({ width, onWidthChange, onResizeStart, onResizeEnd }: {
  width: number;
  onWidthChange(width: number): void;
  onResizeStart(): void;
  onResizeEnd(width: number): void;
}): React.JSX.Element {
  const resizeWithKeyboard = (direction: -1 | 1, resizer: HTMLDivElement): void => {
    const layoutRoot = resizer.closest<HTMLElement>(".biny-app-shell");
    const currentWidth = resizer.parentElement?.getBoundingClientRect().width ?? width;
    const next = clampFilePanelWidthForLayout(currentWidth + direction * 16, layoutRoot);
    onWidthChange(next);
    onResizeEnd(next);
  };
  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onResizeStart();
    const layoutRoot = event.currentTarget.closest<HTMLElement>(".biny-app-shell");
    const startX = event.clientX;
    const startWidth = event.currentTarget.parentElement?.getBoundingClientRect().width ?? width;
    let currentWidth = startWidth;
    let active = true;
    const move = (moveEvent: PointerEvent): void => {
      currentWidth = clampFilePanelWidthForLayout(startWidth + startX - moveEvent.clientX, layoutRoot);
      onWidthChange(currentWidth);
    };
    const stop = (): void => {
      if (!active) return;
      active = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      onResizeEnd(currentWidth);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
  };
  return (
    <div
      aria-label="调整检查器宽度"
      aria-orientation="vertical"
      aria-valuemax={MAX_FILE_PANEL_WIDTH}
      aria-valuemin={MIN_FILE_PANEL_WIDTH}
      aria-valuenow={Math.round(width)}
      className="desktop-inspector-resizer"
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") { event.preventDefault(); resizeWithKeyboard(1, event.currentTarget); }
        if (event.key === "ArrowRight") { event.preventDefault(); resizeWithKeyboard(-1, event.currentTarget); }
      }}
      onPointerDown={startResize}
      role="separator"
      tabIndex={0}
    />
  );
}

function clampFilePanelWidthForLayout(width: number, layoutRoot: HTMLElement | null): number {
  const appWidth = layoutRoot?.clientWidth ?? document.documentElement.clientWidth;
  const sidebar = layoutRoot?.querySelector<HTMLElement>(":scope > .biny-sidebar-block");
  const sidebarWidth = sidebar?.getBoundingClientRect().width ?? 0;
  return clampFilePanelWidth(width, appWidth, sidebarWidth);
}

function normalizeWorkspacePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized || ".";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select"));
}
