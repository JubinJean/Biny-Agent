/**
 * 聊天行的纯函数模型。
 *
 * 把工具名分类成视觉变体、派生行标题与状态语义；以及消息时钟的时间/指标格式化
 * （日期感知时钟、用时、首 token 延迟、解码吞吐）。全部为纯函数，不依赖 React，便于单测。
 */
import type { TimelineReasoningStep, TimelineRunStatus, TimelineTool, TimelineToolStep, TimelineTurn } from "./sessionTimeline.js";
import { executionToolLabel } from "./sessionTimeline.js";
import type { SessionUsage } from "../../../session/metadata.js";
import type { IconName } from "./components/Icon.js";

/** 工具行视觉变体（标题字面量来自 DSH figma 设计）。 */
export type ToolRowVariant = "search" | "read" | "bash" | "write" | "edit" | "git" | "process" | "skill" | "others";

/** 行状态语义；驱动工具行图标芯片的着色与呼吸光环。 */
export type ToolRowState = "running" | "ok" | "error" | "stopped";

/** 变体 leading 图标名（Biny Icon 名；对齐 alma/lucide 的语义：read=带正文的文件、bash=终端、write/edit=笔）。 */
export const VARIANT_ICON_NAMES: Record<ToolRowVariant, IconName> = {
  search: "search",
  read: "file-text",
  bash: "terminal",
  write: "edit",
  edit: "edit",
  git: "branch",
  process: "activity",
  skill: "wand",
  others: "wrench",
};

/** 变体行标题（DSH figma 字面量，非翻译文案）。 */
export const VARIANT_TITLES: Record<ToolRowVariant, string> = {
  search: "Search",
  read: "Read",
  bash: "Bash",
  write: "Write",
  edit: "Edit",
  git: "Git",
  process: "Process",
  skill: "Skill",
  others: "Tool call",
};

/** 已知工具名 → 变体；未知工具落到通用 `others`，行标题回退显示原始工具名。 */
const TOOL_VARIANTS: Record<string, ToolRowVariant> = {
  Bash: "bash",
  Read: "read",
  WebFetch: "read",
  WebSearch: "search",
  Grep: "search",
  Write: "write",
  edit_file: "edit",
  delete_file: "edit",
  move_file: "edit",
  git_diff: "git",
  git_status: "git",
  git_commit: "git",
  start_process: "process",
  stop_process: "process",
  process_status: "process",
  read_process_output: "process",
  list_processes: "process",
  Glob: "read",
  read_tool_result: "read",
  TodoWrite: "edit",
  Skill: "skill",
  skill_call: "skill",
  read_skill_resource: "read",
  activity_search: "search",
  activity_search_semantic: "search",
  activity_sessions: "read",
  activity_session_show: "read",
  activity_report: "read",
  activity_digest: "read",
  mcp_list_resources: "search",
  mcp_read_resource: "read",
};

/** 把工具名分类成行变体。 */
export function classifyTool(toolName: string): ToolRowVariant {
  if (/(?:^|_)zvec_grep_search$/u.test(toolName)) return "search";
  return TOOL_VARIANTS[toolName] ?? "others";
}

/** 从时间线工具状态派生行状态语义。 */
export function toolRowState(tool: TimelineTool): ToolRowState {
  if (tool.status === "running" || tool.status === "waiting") return "running";
  if (tool.status === "failed" || tool.status === "denied" || tool.status === "unknown") return "error";
  if (tool.status === "cancelled" || tool.status === "aborted") return "stopped";
  return "ok";
}

/** 实时与历史消息共用同一身份判断，已接收的消息不再保留发送占位或驱动忙碌状态。 */
export function hasSubmittedUserMessage(turns: TimelineTurn[], messageId: string | undefined, content: string): boolean {
  return turns.some((turn) => messageId !== undefined ? turn.userMessageId === messageId : turn.user === content);
}

/** 从运行事实派生的状态行文案。 */
export interface TurnActivity {
  label: string;
}

const THINKING_ACTIVITY: TurnActivity = { label: "思考中" };

/**
 * 从运行中的轮次派生当前真实活动，驱动聊天底部的状态行（Alma 式）。
 * 优先级：等待授权 > 正在运行的工具/技能 > 思考；轮次不存在或已落定时回到「思考中」。
 */
export function currentTurnActivity(turn: TimelineTurn | undefined): TurnActivity {
  if (!turn || (turn.status !== "running" && turn.status !== "waiting_permission")) return THINKING_ACTIVITY;
  if (turn.status === "waiting_permission") {
    const pending = [...turn.tools].reverse().find((tool) => tool.permission && !tool.permission.resolved);
    return {
      label: pending ? `等待授权：${executionToolLabel(pending.tool)}` : "等待授权"
    };
  }
  const active = [...turn.tools].reverse().find((tool) => tool.status === "running" || tool.status === "waiting");
  if (active) return toolCallActivity(active);
  return turn.memoryInjectedCount && turn.steps.length === 0
    ? { label: `已注入 ${String(turn.memoryInjectedCount)} 条记忆，思考中` }
    : THINKING_ACTIVITY;
}

/** 运行中工具的状态行文案，显示正在执行的工具或技能名称。 */
function toolCallActivity(tool: TimelineTool): TurnActivity {
  if (tool.tool === "Skill" || tool.tool === "skill_call") {
    const args = typeof tool.args === "object" && tool.args !== null ? tool.args as Record<string, unknown> : undefined;
    const skill = typeof args?.skill === "string" ? args.skill.trim() : "";
    return { label: skill ? `正在使用技能 ${skill}` : "正在使用技能" };
  }
  if (tool.tool === "WebSearch") return { label: "正在搜索网页" };
  const display = tool.display;
  if (display?.kind === "command") return { label: `正在运行 ${executionToolLabel(tool.tool)}` };
  if (display?.kind === "file_io") {
    if (display.operation === "read") return { label: `正在读取文件 · ${executionToolLabel(tool.tool)}` };
    if (display.operation === "write" || display.operation === "edit") return { label: `正在修改文件 · ${executionToolLabel(tool.tool)}` };
    if (display.operation === "search" || display.operation === "grep") return { label: `正在搜索项目 · ${executionToolLabel(tool.tool)}` };
    if (display.operation === "git") return { label: "正在检查 Git 状态" };
  }
  if (tool.description) return { label: tool.description };
  return { label: `正在执行 ${executionToolLabel(tool.tool)}` };
}

/** 错误行的折叠摘要 = 失败文本首行（DSH：错误摘要替换摘要槽）。 */
export function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline);
}

/** 需要在对应消息旁呈现原因或重试入口的非成功终态；取消使用中性提示。 */
export function isRunErrorStatus(status: TimelineRunStatus): boolean {
  return status === "failed"
    || status === "blocked"
    || status === "incomplete"
    || status === "cancelled"
    || status === "aborted";
}

/** 折叠的 token 计数：517 / 12.2K / 517K / 1.2M（一位小数仅在三位数以下）。 */
export function formatTokens(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`;
  return `${scaled(n / 1_000_000)}M`;
}

/** 紧凑时长：45.2s（不足一分钟）、2m42s（以上）。 */
export function formatDuration(ms: number): string {
  const s = ms / 1_000;
  if (s < 60) return `${Math.round(s * 10) / 10}s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, "0")}s`;
}

/** 亚轮延迟数字：10 秒内一位小数，以上取整（单位由调用方补）。 */
export function formatLatencySeconds(ms: number): string {
  const s = Math.max(0, ms) / 1_000;
  return s < 10 ? String(Math.round(s * 10) / 10) : String(Math.round(s));
}

/** 解码吞吐数字：10 以上取整，以下一位小数（单位由调用方补）。 */
export function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps);
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}

/**
 * 日期感知的本地时钟：当天 `HH:mm`；今年 `M/D HH:mm`；跨年 `Y/M/D HH:mm`。
 * @param time - Unix epoch ms。
 * @param now - 参考时刻，默认墙钟。
 */
export function formatMessageClock(time: number, now: number = Date.now()): string {
  const d = new Date(time);
  const n = new Date(now);
  const pad2 = (value: number): string => String(value).padStart(2, "0");
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    return clock;
  }
  const date = d.getFullYear() === n.getFullYear()
    ? `${d.getMonth() + 1}/${d.getDate()}`
    : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  return `${date} ${clock}`;
}

/** 一轮的展示指标：首 token 延迟、解码吞吐、模型耗时（TTFT + 解码，两者齐全才给出）。 */
export interface TurnMetrics {
  ttftMs?: number;
  tokensPerSecond?: number;
  llmMs?: number;
}

/** 从时间线轮次派生展示指标；历史轮次缺 firstTokenAt 时只保留可用的部分。 */
export function turnMetrics(turn: TimelineTurn): TurnMetrics {
  const metrics: TurnMetrics = {};
  if (turn.ttftMs !== undefined) metrics.ttftMs = turn.ttftMs;
  if (turn.decodeMs !== undefined && turn.decodeTokens !== undefined && turn.decodeMs > 0) {
    metrics.tokensPerSecond = turn.decodeTokens / (turn.decodeMs / 1_000);
  }
  if (turn.ttftMs !== undefined && turn.decodeMs !== undefined) {
    metrics.llmMs = turn.ttftMs + turn.decodeMs;
  }
  return metrics;
}

/* ============ 用量悬浮卡（消息菜单的 Usage 详情） ============ */

/** 悬浮用量卡的一行：标签 + 已格式化值。 */
export interface UsageDetailRow {
  key: string;
  label: string;
  value: string;
}

/** 精确 token 计数（千分位）；缺失/非法回退 N/A 由调用方过滤。 */
function formatTokenCountExact(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "N/A";
  return value.toLocaleString("en-US");
}

/** 缓存命中率 = 缓存读取 / 完整输入；输入为 0 或缺数据时 N/A。 */
function formatCacheHitRate(cacheRead: number | undefined, input: number | undefined): string {
  if (typeof cacheRead !== "number" || typeof input !== "number") return "N/A";
  if (!Number.isFinite(cacheRead) || !Number.isFinite(input) || input <= 0 || cacheRead < 0) return "N/A";
  return `${Math.min(100, (cacheRead / input) * 100).toFixed(1)}%`;
}

/** 悬浮卡里的吞吐精度：≥10 一位小数，以下两位（比时钟上的整数更细）。 */
function formatTokensPerSecondPrecise(tps: number): string {
  if (typeof tps !== "number" || !Number.isFinite(tps) || tps <= 0) return "N/A";
  return tps >= 10 ? tps.toFixed(1) : tps.toFixed(2);
}

/**
 * 组装悬浮用量卡的行：输入/输出/缓存读取/命中率/缓存写入/总量 + 首个 Token 时间与吞吐。
 * 输入与缓存读取优先取回合内最后一次完整请求的口径（latest*），缺数据行整条不出现。
 */
export function buildUsageDetailRows(usage: SessionUsage | undefined, metrics: TurnMetrics): UsageDetailRow[] {
  if (!usage) return [];
  const input = usage.latestRequestInputTokens ?? usage.inputTokens;
  const cacheRead = usage.latestRequestCacheReadTokens ?? usage.cacheReadTokens;
  const rows: UsageDetailRow[] = [
    { key: "input", label: "输入 Token", value: formatTokenCountExact(input) },
    { key: "output", label: "输出 Token", value: formatTokenCountExact(usage.outputTokens) },
    { key: "cacheRead", label: "缓存读取", value: formatTokenCountExact(cacheRead) },
    { key: "cacheHit", label: "缓存命中率", value: formatCacheHitRate(cacheRead, input) },
    { key: "cacheWrite", label: "缓存写入", value: formatTokenCountExact(usage.cacheWriteTokens) },
    { key: "total", label: "总 Token", value: formatTokenCountExact(usage.totalTokens) },
    { key: "ttft", label: "首个 Token 时间", value: metrics.ttftMs !== undefined ? formatDuration(metrics.ttftMs) : "N/A" },
    { key: "tps", label: "Token/秒", value: metrics.tokensPerSecond !== undefined ? formatTokensPerSecondPrecise(metrics.tokensPerSecond) : "N/A" },
  ];
  return rows.filter((row) => row.value !== "N/A");
}

/** Turn 结束原因的语义色：绿=正常停止，琥珀=长度截断，蓝=工具调用，橙=内容过滤，红=错误/中止。 */
export type FinishReasonTone = "ok" | "limit" | "tool" | "filter" | "error" | "unknown";

/** 把各家 provider 的原始 finishReason（含 biny 归一化的 stopReason）映射成色点语义。 */
export function finishReasonTone(reason: string): FinishReasonTone {
  if (/^(stop|end_turn|stop_sequence)$/i.test(reason)) return "ok";
  if (/^(length|max_tokens)$/i.test(reason)) return "limit";
  if (/^(tool[-_]calls|tool_use|function_call)$/i.test(reason)) return "tool";
  if (/^(content_filter|safety|recitation)$/i.test(reason)) return "filter";
  if (/^(error|aborted|cancelled|failed)$/i.test(reason)) return "error";
  return "unknown";
}

/** 压缩分隔条的数据：条数 / 节省 token / 可选摘要正文。 */
export interface CompactionNotice {
  count?: number;
  savedTokens?: number;
  summary?: string;
}

/**
 * 从压缩标记步骤的状态文案解析药丸数据。
 * 兼容「已压缩 N 条消息，正在恢复请求」「已压缩 N 条消息，节省约 X tokens」两种口径；
 * 解析不出的字段省略。
 */
export function parseCompactionNotice(status: string | undefined): CompactionNotice {
  if (!status) return {};
  const notice: CompactionNotice = {};
  const count = /已压缩\s*([\d,]+)\s*条消息/.exec(status);
  if (count?.[1]) notice.count = Number.parseInt(count[1].replaceAll(",", ""), 10);
  const tokens = /节省[约了]\s*([\d,]+)\s*tokens?/.exec(status);
  if (tokens?.[1]) notice.savedTokens = Number.parseInt(tokens[1].replaceAll(",", ""), 10);
  return notice;
}

/* ============ 活动相位模型（聚合组头部的相位头像与摘要文案） ============ *//** 聚合组里的一个步骤项：步骤本身 + 它在步骤数组里的下标（用作 key）。 */
export interface ActivityPhaseItem {
  step: TimelineToolStep | TimelineReasoningStep;
  index: number;
}

/** 相位语义：思考 / 探索（只读）/ 修改（写入）/ 运行（命令）/ 通用。 */
export type ActivityPhaseKind = "thinking" | "exploring" | "making" | "running" | "generic";

export interface ActivityPhase {
  kind: ActivityPhaseKind;
  items: ActivityPhaseItem[];
  startIndex: number;
}

/** 只读类工具：归入「探索」相位。 */
const EXPLORING_TOOLS = new Set([
  "Read", "Glob", "Grep", "WebSearch", "WebFetch",
  "read_tool_result", "read_skill_resource",
  "mcp_list_resources", "mcp_read_resource",
  "git_diff", "git_status",
  "activity_search", "activity_search_semantic", "activity_sessions", "activity_session_show",
  "activity_report", "activity_digest",
  "recall_memory", "skill_search", "BrowserReadDom",
]);

/** 写入类工具：归入「修改」相位。 */
const MAKING_TOOLS = new Set(["Write", "edit_file", "delete_file", "move_file", "TodoWrite", "git_commit", "save_memory", "skill_install"]);

/** 命令类工具：归入「运行」相位。 */
const RUNNING_TOOLS = new Set(["Bash", "start_process", "stop_process", "process_status", "read_process_output", "list_processes"]);

/** 步骤的相位语义：思考步骤 → thinking；工具按工具名分箱；其余 → generic。 */
export function activityPhaseKindOf(step: TimelineToolStep | TimelineReasoningStep): ActivityPhaseKind {
  if (step.kind === "reasoning") return "thinking";
  if (EXPLORING_TOOLS.has(step.tool.tool)) return "exploring";
  if (MAKING_TOOLS.has(step.tool.tool)) return "making";
  if (RUNNING_TOOLS.has(step.tool.tool)) return "running";
  return "generic";
}

/** 把连续同相位的步骤收成一相；相位序列驱动头部的头像串与展开体分相。 */
export function buildActivityPhases(items: ActivityPhaseItem[]): ActivityPhase[] {
  const phases: ActivityPhase[] = [];
  for (const item of items) {
    const kind = activityPhaseKindOf(item.step);
    const last = phases.at(-1);
    if (last && last.kind === kind) {
      last.items.push(item);
    } else {
      phases.push({ kind, items: [item], startIndex: item.index });
    }
  }
  return phases;
}

/** 相位里的思考耗时：累计 reasoning 步骤的 durationMs，至少 1 秒。 */
export function phaseThinkingSeconds(phase: ActivityPhase): number | undefined {
  let ms = 0;
  let found = false;
  for (const { step } of phase.items) {
    if (step.kind !== "reasoning") continue;
    const d = step.durationMs;
    if (typeof d === "number" && Number.isFinite(d) && d >= 0) {
      ms += d;
      found = true;
    }
  }
  return found ? Math.max(1, Math.round(ms / 1000)) : undefined;
}

/** 活动单元数 = 每个思考相位算 1，工具逐个计数；驱动「用了 N 个工具」。 */
export function countActivityUnits(phases: ActivityPhase[]): number {
  return phases.reduce((sum, phase) => sum + (phase.kind === "thinking" ? 1 : phase.items.length), 0);
}

/** 相位是否整体落定（思考完成、工具离开运行态）；活体 shimmer 只给最后一个未落定相位。 */
export function phaseSettled(phase: ActivityPhase): boolean {
  return phase.items.every(({ step }) => {
    if (step.kind === "reasoning") return Boolean(step.completed);
    const status = step.tool.status;
    return status !== "running" && status !== "waiting";
  });
}

/** 相位摘要的动宾结构：verb 是加重前景词，rest 是弱化补语（数量/对象）。 */
export interface ActivityPhaseLabel {
  verb: string;
  rest: string;
}

/** 相位的摘要文案（对齐 alma activity.phase.* 中文语料）。 */
export function phaseLabel(phase: ActivityPhase, live: boolean, thinkingSeconds?: number): ActivityPhaseLabel {
  const n = phase.items.length;
  switch (phase.kind) {
    case "thinking":
      if (live) return { verb: "思考中", rest: "" };
      return { verb: "已思考", rest: thinkingSeconds ? `${String(thinkingSeconds)} 秒` : "" };
    case "exploring": {
      const reads = phase.items.filter(({ step }) => step.kind === "tool" && step.tool.tool === "Read").length;
      const rest = reads === n ? `${String(n)} 个文件` : `${String(n)} 处`;
      return { verb: live ? "探索中" : "已探索", rest };
    }
    case "making": {
      let creates = 0;
      let edits = 0;
      for (const { step } of phase.items) {
        if (step.kind === "tool" && step.tool.tool === "Write") creates += 1;
        else edits += 1;
      }
      const pieces: string[] = [];
      if (creates) pieces.push(`新建 ${String(creates)}`);
      if (edits) pieces.push(`编辑 ${String(edits)}`);
      return { verb: live ? "修改中" : "已修改", rest: pieces.join(", ") };
    }
    case "running":
      return { verb: live ? "执行中" : "已执行", rest: `${String(n)} 条命令` };
    default: {
      const names = new Set(phase.items.flatMap(({ step }) => step.kind === "tool" ? [step.tool.tool] : []));
      if (names.size === 1) {
        const name = [...names][0]?.replace(/[_-]+/g, " ") ?? "tool";
        return { verb: live ? "使用中" : "已使用", rest: n === 1 ? name : `${name} ×${String(n)}` };
      }
      return { verb: live ? "进行中" : "已完成", rest: `${String(n)} 步` };
    }
  }
}

/* ---- 工具行（轨道里的紧凑动宾行） ---- */

/** 展开轨道里一个工具的动宾行：verb 加重、object 弱化截断、± 行数统计。 */
export interface ActivityToolRowModel {
  verb: string;
  object: string;
  plus?: number;
  minus?: number;
  running: boolean;
  error: boolean;
}

/** 路径收窄：超过 3 段只保留最后 3 段（对齐 alma shortenPath）。 */
function shortenPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 3 ? path.replace(/^\//, "") : parts.slice(-3).join("/");
}

function countLines(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.split("\n").length;
}

function stringArg(tool: TimelineTool, key: string): string | undefined {
  const args = typeof tool.args === "object" && tool.args !== null ? tool.args as Record<string, unknown> : undefined;
  const value = args?.[key];
  return typeof value === "string" && value ? value : undefined;
}

/** 工具的动宾行模型；措辞对齐 alma activity.verb.* 中文语料，未识别工具回退工具名。 */
export function activityToolRow(tool: TimelineTool): ActivityToolRowModel {
  const display = tool.display?.kind === "file_io" ? tool.display : undefined;
  const args = typeof tool.args === "object" && tool.args !== null ? tool.args as Record<string, unknown> : undefined;
  const argPath = typeof args?.path === "string" ? args.path : undefined;
  const filePath = shortenPath(display?.path ?? tool.path ?? argPath ?? "");
  const running = tool.status === "running" || tool.status === "waiting";
  const error = tool.status === "failed" || tool.status === "denied" || tool.status === "unknown";
  const row: ActivityToolRowModel = { verb: "", object: "", running, error };
  switch (tool.tool) {
    case "Read":
    case "read_tool_result":
    case "read_skill_resource":
    case "mcp_read_resource":
      row.verb = "读取";
      row.object = filePath || display?.detail || stringArg(tool, "uri") || stringArg(tool, "name") || "…";
      return row;
    case "Glob":
      row.verb = "匹配";
      row.object = display?.detail ?? stringArg(tool, "pattern") ?? stringArg(tool, "path") ?? "…";
      return row;
    case "Grep":
    case "activity_search":
    case "activity_search_semantic":
      row.verb = "搜索";
      row.object = display?.detail ?? stringArg(tool, "pattern") ?? stringArg(tool, "query") ?? "…";
      return row;
    case "WebSearch":
      row.verb = "搜索网页";
      row.object = stringArg(tool, "query") ?? tool.description ?? "…";
      return row;
    case "WebFetch":
      row.verb = "抓取";
      row.object = stringArg(tool, "url") ?? tool.description ?? "…";
      return row;
    case "edit_file": {
      row.verb = "编辑";
      row.object = filePath || "…";
      row.minus = countLines(display?.before ?? stringArg(tool, "oldText"));
      row.plus = countLines(display?.after ?? stringArg(tool, "newText"));
      return row;
    }
    case "Write": {
      row.verb = "写入";
      row.object = filePath || "…";
      row.plus = countLines(display?.content ?? stringArg(tool, "content"));
      return row;
    }
    case "delete_file":
      row.verb = "删除";
      row.object = filePath || "…";
      return row;
    case "move_file":
      row.verb = "移动";
      row.object = filePath || "…";
      return row;
    case "TodoWrite":
      row.verb = "更新";
      row.object = "待办事项";
      return row;
    case "Bash": {
      row.verb = "执行";
      row.object = tool.description ?? (stringArg(tool, "command") ?? "").slice(0, 80) ?? "…";
      return row;
    }
    case "start_process": {
      row.verb = "执行";
      row.object = tool.description ?? (stringArg(tool, "command") ?? "").slice(0, 80) ?? "…";
      return row;
    }
    case "stop_process":
      row.verb = "终止";
      row.object = stringArg(tool, "processId") ?? stringArg(tool, "id") ?? "进程";
      return row;
    case "process_status":
    case "read_process_output":
      row.verb = "查看";
      row.object = stringArg(tool, "processId") ?? stringArg(tool, "id") ?? "进程输出";
      return row;
    case "list_processes":
      row.verb = "查看";
      row.object = "进程列表";
      return row;
    case "Skill":
    case "skill_call":
      row.verb = "使用技能";
      row.object = stringArg(tool, "skill") ?? stringArg(tool, "name") ?? "…";
      return row;
    case "git_diff":
      row.verb = "查看";
      row.object = "git 变更";
      return row;
    case "git_status":
      row.verb = "查看";
      row.object = "git 状态";
      return row;
    case "git_commit":
      row.verb = "提交";
      row.object = stringArg(tool, "message") ?? "…";
      return row;
    case "mcp_list_resources":
      row.verb = "列出";
      row.object = stringArg(tool, "server") ?? "资源";
      return row;
    case "recall_memory":
      row.verb = "检索记忆";
      row.object = stringArg(tool, "query") ?? tool.description ?? "…";
      return row;
    case "save_memory":
      row.verb = "保存记忆";
      row.object = stringArg(tool, "topic") ?? stringArg(tool, "title") ?? "…";
      return row;
    case "skill_search":
      row.verb = "搜索技能";
      row.object = stringArg(tool, "query") ?? "…";
      return row;
    case "skill_install":
      row.verb = "安装技能";
      row.object = stringArg(tool, "slug") ?? stringArg(tool, "name") ?? stringArg(tool, "id") ?? "…";
      return row;
    case "BrowserOpen":
      row.verb = "打开";
      row.object = stringArg(tool, "url") ?? tool.description ?? "…";
      return row;
    case "BrowserClick":
      row.verb = "点击";
      row.object = stringArg(tool, "element") ?? stringArg(tool, "target") ?? tool.description ?? "…";
      return row;
    case "BrowserType":
      row.verb = "输入";
      row.object = stringArg(tool, "text") ?? tool.description ?? "…";
      return row;
    case "BrowserPress":
      row.verb = "按键";
      row.object = stringArg(tool, "key") ?? tool.description ?? "…";
      return row;
    case "BrowserReadDom":
      row.verb = "读取页面";
      row.object = tool.description ?? "";
      return row;
    case "update_emotion":
      row.verb = "更新情绪";
      row.object = "";
      return row;
    case "Task":
      row.verb = "派发任务";
      row.object = stringArg(tool, "description") ?? stringArg(tool, "prompt")?.slice(0, 80) ?? "…";
      return row;
    default: {
      row.verb = tool.tool.replace(/[_-]+/g, " ");
      row.object = tool.description ?? "";
      if (!row.object && args) {
        const first = Object.values(args).find((value) => typeof value === "string" && value.length > 0 && value.length < 200);
        if (typeof first === "string") row.object = first;
      }
      return row;
    }
  }
}
