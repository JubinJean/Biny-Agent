/**
 * 设置搜索的静态关键词索引。
 *
 * 只收录分页名和产品关键词，供侧栏搜索框就地过滤导航项；绝不接触表单值，
 * 因此 API Key、自定义指令和记忆正文不会意外进入搜索字符串或日志。
 */
import type { SettingsTab } from "./SettingsOverlay.js";

export const settingsTabKeywords: Record<SettingsTab, string> = {
  通用: "theme font size appearance dark light 主题 背景 字体 字号 外观 显示模式",
  聊天: "temperature max tokens tool skill compaction context auto 温度 输出 令牌 工具 压缩 上下文 保留 摘要",
  快速对话: "quickchat shortcut overlay 悬浮窗 快捷键 失焦 屏幕上下文 穿透",
  模型: "provider api key base url model connection default 供应商 密钥 模型 连接 默认模型 服务地址",
  "MCP 服务器": "mcp server stdio remote sse http 服务器 工具 市场 扩展",
  技能: "skill agent 技能 本机 预览 自动提取",
  插件: "plugin extension module 插件 扩展 模块 市场",
  记忆: "memory recall embedding entry 记忆 召回 生成 列表 搜索 整理",
  联网搜索: "web search cookie provider 搜索 联网 网页 浏览器 导入 导出",
  活动记录: "activity recorder snapshot ocr screen privacy 活动 记录 截图 权限 隐私 存储",
  权限: "permission approval mode safety macos 权限 批准 安全 系统 屏幕录制 辅助功能",
  关于: "about version 关于 版本 产品"
};

/** 空格分词后要求全部命中（分页名 + 关键词），与设置侧栏的过滤语义保持一致。 */
export function matchesSettingsSearch(label: string, keywords: string, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (!terms.length) return true;
  const haystack = `${label} ${keywords}`.toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}
