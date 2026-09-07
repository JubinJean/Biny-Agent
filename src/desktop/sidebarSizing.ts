/**
 * 桌面端左侧栏宽度常量。
 *
 * 侧栏不支持自由拉伸：展开态固定默认宽度，收起态固定 rail 宽度，避免拖拽预览与
 * 提交宽度之间的偏移问题。
 */
export const DEFAULT_SIDEBAR_WIDTH = 260;
/** Biny rail 需要容纳 macOS 红绿灯和顶部按钮簇，视觉宽度固定为 78px。 */
export const SIDEBAR_RAIL_WIDTH = 78;
export const SIDEBAR_TRANSITION_MS = 250;
export const SIDEBAR_CONTENT_FADE_MS = 200;
export const SIDEBAR_PEEK_OPEN_DELAY_MS = 120;
export const SIDEBAR_PEEK_LEAVE_GRACE_MS = 160;
export const SIDEBAR_PEEK_CLOSE_MS = 200;
export const SIDEBAR_PEEK_PINNING_MS = 300;
