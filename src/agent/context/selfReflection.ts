/**
 * 每日自省的后台投影。
 *
 * 自省消费当天的聊天/活动摘要和可选的持久事实，输出写回当天 Markdown 的独立 section；
 * 只有结构化结果中的高置信度记忆和明确未完成行动，才会通过宿主提供的回调继续落盘。
 * 这些回调不执行工具，也不改变权限、安全和任务事实。
 */
import { createHash } from "node:crypto";
import { generateNativeText, nativeJsonMessages, parseNativeJson } from "../../llm/nativeJson.js";
import type { AgentModel, ModelRequestContext, ModelRequestObserver } from "../core/types.js";
import type { ModelUsageObserver } from "../../observability/usage.js";
import { redactSecrets } from "../../utils/secrets.js";
import type { MemoryDurability, MemoryKind } from "./memoryTypes.js";
import {
  readDailyMemoryNote,
  readDailyMemorySection,
  upsertDailyMemorySection
} from "../../activity/dailyNotes.js";

const maxReflectionSourceChars = 18_000;
const maxReflectionOutputTokens = 700;
const maxReflectionMemories = 3;
const maxReflectionActions = 2;

export interface SelfReflectionMemoryCandidate {
  dateKey: string;
  sourceHash: string;
  title: string;
  topic: string;
  summary: string;
  kind: MemoryKind;
  durability: MemoryDurability;
  evidence?: string;
}

export interface SelfReflectionActionCandidate {
  taskRunId: string;
  dateKey: string;
  sourceHash: string;
  title: string;
  description: string;
  evidence?: string;
}

export interface SelfReflectionOptions {
  agentDir?: string;
  model?: AgentModel;
  memoryContext?: string;
  activityContext?: string;
  signal?: AbortSignal;
  now?: () => Date;
  onUsage?: ModelUsageObserver;
  onModelRequest?: ModelRequestObserver;
  requestContext?: ModelRequestContext;
  /** 仅接收高置信度记忆；返回 true 表示本次确实写入了新条目。 */
  promoteMemory?: (candidate: SelfReflectionMemoryCandidate) => Promise<boolean>;
  /** 仅接收明确未完成行动；宿主负责持久化，不在此处启动任务。 */
  createTask?: (candidate: SelfReflectionActionCandidate) => Promise<boolean>;
  force?: boolean;
}

export interface SelfReflectionResult {
  dateKey: string;
  written: boolean;
  model?: string;
  memoriesCreated?: number;
  tasksCreated?: number;
  reason?: "empty" | "up_to_date" | "no_model";
}

export async function refreshSelfReflection(
  dateKey: string,
  options: SelfReflectionOptions = {}
): Promise<SelfReflectionResult> {
  const note = await readDailyMemoryNote(dateKey, { agentDir: options.agentDir });
  const chat = note ? readDailyMemorySection(note, "聊天摘要") : undefined;
  const activity = note ? readDailyMemorySection(note, "活动记录") : undefined;
  const source = [chat, activity, options.activityContext, options.memoryContext]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n\n")
    .trim();
  if (!source) return { dateKey, written: false, reason: "empty" };
  const sourceHash = createHash("sha256").update(source).digest("hex").slice(0, 24);
  const existing = note ? readDailyMemorySection(note, "自我反思") : undefined;
  const marker = `<!-- biny-reflection-source:${sourceHash} -->`;
  const promotionMarker = `<!-- biny-reflection-promoted:${sourceHash} -->`;
  const promotionRequested = options.promoteMemory !== undefined || options.createTask !== undefined;
  if (!options.force && existing?.includes(marker) && (!promotionRequested || existing.includes(promotionMarker))) {
    return { dateKey, written: false, reason: "up_to_date" };
  }
  if (!options.model) return { dateKey, written: false, reason: "no_model" };

  let reflection: string;
  let memories: SelfReflectionMemoryCandidate[] = [];
  let actions: SelfReflectionActionCandidate[] = [];
  let structuredOutput = false;
  try {
    const result = await generateNativeText(
      options.model,
      nativeJsonMessages(
        [
          "You produce a brief, honest daily self-reflection from local chat, activity, and durable memory context.",
          "Return only one JSON object with this shape:",
          '{"reflection":"2-5 sentences","memories":[],"actions":[]}',
          "Use the source language, defaulting to Chinese. Do not invent feelings or facts, expose secrets, or include headings.",
          "Only include a memory when it is stable, useful beyond this day, and directly supported by the source. Each memory must include summary, title, topic, kind, and durability; kind is one of preference, working_style, fact, decision, workflow, gotcha; durability is temporary or permanent.",
          "Only include an action when the source explicitly shows an unfinished commitment or pending follow-up. Set explicit to true for those actions. Do not turn a suggestion, reflection, or vague improvement into an action.",
          "Keep memories and actions empty when evidence is insufficient. Never include credentials, secrets, private tokens, or unrelated personal data."
        ].join("\n"),
        [`Date: ${dateKey}`, "Source:", truncate(source, maxReflectionSourceChars)].join("\n\n")
      ),
      {
        signal: options.signal,
        maxOutputTokens: maxReflectionOutputTokens,
        reasoning: "off",
        timeoutMs: 30_000,
        onRequestMetrics: options.onModelRequest,
        requestContext: { ...options.requestContext, operation: "memory" }
      }
    );
    const parsed = parseReflectionOutput(result.text, dateKey, sourceHash);
    reflection = parsed.reflection;
    memories = parsed.memories;
    actions = parsed.actions;
    structuredOutput = parsed.structured;
    if (result.usage) await options.onUsage?.(result.usage, "memory");
  } catch (error) {
    options.signal?.throwIfAborted();
    throw error;
  }
  if (!reflection) return { dateKey, written: false, reason: "empty" };

  let promotionComplete = !promotionRequested || structuredOutput;
  let memoriesCreated = 0;
  let tasksCreated = 0;
  if (promotionRequested) {
    if (memories.length && !options.promoteMemory) promotionComplete = false;
    for (const memory of memories) {
      if (!options.promoteMemory) continue;
      try {
        if (await options.promoteMemory(memory)) memoriesCreated += 1;
      } catch {
        options.signal?.throwIfAborted();
        promotionComplete = false;
      }
    }
    if (actions.length && !options.createTask) promotionComplete = false;
    for (const action of actions) {
      if (!options.createTask) continue;
      try {
        if (await options.createTask(action)) tasksCreated += 1;
      } catch {
        options.signal?.throwIfAborted();
        promotionComplete = false;
      }
    }
  }
  await upsertDailyMemorySection(
    dateKey,
    "自我反思",
    [marker, promotionComplete ? promotionMarker : undefined, reflection].filter((value): value is string => value !== undefined).join("\n"),
    { agentDir: options.agentDir }
  );
  return { dateKey, written: true, model: options.model.modelId, memoriesCreated, tasksCreated };
}

interface ParsedReflectionOutput {
  reflection: string;
  memories: SelfReflectionMemoryCandidate[];
  actions: SelfReflectionActionCandidate[];
  structured: boolean;
}

function parseReflectionOutput(
  text: string,
  dateKey: string,
  sourceHash: string
): ParsedReflectionOutput {
  const fallback = { reflection: redactSecrets(text).trim(), memories: [], actions: [], structured: false };
  let value: unknown;
  try {
    value = parseNativeJson(text);
  } catch {
    // 保留旧模型的纯文本结果兼容性；纯文本不会触发任何后台晋升。
    return fallback;
  }
  if (!isRecord(value) || typeof value.reflection !== "string") return fallback;
  const memories = Array.isArray(value.memories)
    ? value.memories.slice(0, maxReflectionMemories).flatMap((candidate) => normalizeMemoryCandidate(candidate, dateKey, sourceHash))
    : [];
  const actions = Array.isArray(value.actions)
    ? value.actions.slice(0, maxReflectionActions).flatMap((candidate, index) => normalizeActionCandidate(candidate, dateKey, sourceHash, index))
    : [];
  return { reflection: redactSecrets(value.reflection).trim(), memories, actions, structured: true };
}

function normalizeMemoryCandidate(
  value: unknown,
  dateKey: string,
  sourceHash: string
): SelfReflectionMemoryCandidate[] {
  if (!isRecord(value) || typeof value.summary !== "string" || typeof value.durability !== "string") return [];
  const summary = cleanCandidateText(value.summary, 2_000);
  if (!summary || (value.durability !== "temporary" && value.durability !== "permanent")) return [];
  const kind = isMemoryKind(value.kind) ? value.kind : "fact";
  const title = cleanCandidateText(typeof value.title === "string" ? value.title : summary, 120) || summary.slice(0, 120);
  const topic = cleanCandidateText(typeof value.topic === "string" ? value.topic : "reflection", 120) || "reflection";
  const evidence = typeof value.evidence === "string" ? cleanCandidateText(value.evidence, 500) || undefined : undefined;
  return [{ dateKey, sourceHash, title, topic, summary, kind, durability: value.durability, evidence }];
}

function normalizeActionCandidate(
  value: unknown,
  dateKey: string,
  sourceHash: string,
  index: number
): SelfReflectionActionCandidate[] {
  if (!isRecord(value) || value.explicit !== true || typeof value.title !== "string") return [];
  const title = cleanCandidateText(value.title, 200);
  if (!title) return [];
  const description = cleanCandidateText(typeof value.description === "string" ? value.description : title, 2_000);
  if (!description) return [];
  const evidence = typeof value.evidence === "string" ? cleanCandidateText(value.evidence, 500) || undefined : undefined;
  const taskRunId = `reflection-${createHash("sha256").update(`${dateKey}\0${sourceHash}\0${index}\0${title}`).digest("hex").slice(0, 24)}`;
  return [{ taskRunId, dateKey, sourceHash, title, description, evidence }];
}

function cleanCandidateText(value: string, maxChars: number): string {
  return redactSecrets(value).replace(/\s+/gu, " ").trim().slice(0, maxChars);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMemoryKind(value: unknown): value is MemoryKind {
  return value === "preference"
    || value === "working_style"
    || value === "fact"
    || value === "decision"
    || value === "workflow"
    || value === "gotcha";
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `…\n${value.slice(-maxChars)}`;
}
