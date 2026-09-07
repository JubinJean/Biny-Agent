/**
 * 桌面端侧栏的状态和几何快照。
 *
 * 展开宽度固定（见 sidebarSizing），这里只描述 expanded / rail / collapsed 三种
 * 基础模式以及 collapsed 下的 peek 临时覆盖层，供 Sidebar 和 DesktopShell 共用。
 */
import { DEFAULT_SIDEBAR_WIDTH, SIDEBAR_RAIL_WIDTH } from "./sidebarSizing.js";

export type SidebarBaseMode = "expanded" | "rail" | "collapsed";
export type SidebarMode = SidebarBaseMode | "peek";
export type SidebarPeekPhase = "idle" | "peeking" | "peekClosing" | "peekExited" | "pinning";
export type SidebarTransition = "idle" | "peek-closing" | "peek-exited" | "pinning";

export interface SidebarLayoutSnapshot {
  mode: SidebarMode;
  visualWidth: number;
  flowWidth: number;
  contentWidth: number;
  transition: SidebarTransition;
}

export interface SidebarLayoutState {
  baseMode: SidebarBaseMode;
  peekPhase: SidebarPeekPhase;
}

export const DEFAULT_SIDEBAR_LAYOUT: SidebarLayoutState = {
  baseMode: "expanded",
  peekPhase: "idle"
};

/**
 * 由同一份输入生成 Sidebar 和 DesktopShell 共用的布局快照。
 * peek 是 collapsed 的临时覆盖层；pinning 期间只让 spacer 推动主区，不改变
 * collapsed 基础状态，直到 pin 定时器完成后再切换为 expanded。
 */
export function resolveSidebarLayout(input: SidebarLayoutState): SidebarLayoutSnapshot {
  const mode: SidebarMode = input.baseMode === "collapsed"
    && input.peekPhase !== "idle"
    && input.peekPhase !== "peekExited"
    ? "peek"
    : input.baseMode;
  const expandedWidth = DEFAULT_SIDEBAR_WIDTH;
  const visualWidth = mode === "collapsed" ? 0 : mode === "rail" ? SIDEBAR_RAIL_WIDTH : expandedWidth;
  const isPeek = mode === "peek";
  const flowWidth = isPeek
    ? input.peekPhase === "pinning" ? expandedWidth : 0
    : visualWidth;
  // contentWidth 是当前可见内容的实际盒宽，稳定 rail 也只应保留 78px 的盒宽。
  const contentWidth = mode === "rail" ? SIDEBAR_RAIL_WIDTH : expandedWidth;
  const transition: SidebarTransition = input.peekPhase === "pinning"
    ? "pinning"
    : input.peekPhase === "peekClosing"
      ? "peek-closing"
      : input.peekPhase === "peekExited"
        ? "peek-exited"
      : "idle";
  return { mode, visualWidth, flowWidth, contentWidth, transition };
}
