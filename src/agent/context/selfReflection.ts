/**
 * 每日自省的文件投影。
 *
 * 自省只消费当天的聊天/活动摘要和可选的持久事实，输出写回当天 Markdown 的独立 section；
 * 它不会修改条目记忆，也不会把文件内容当成新的工具授权。
 */
import { createHash } from "node:crypto";
import { generateNativeText, nativeJsonMessages } from "../../llm/nativeJson.js";
import type { AgentModel, ModelRequestContext, ModelRequestObserver } from "../core/types.js";
import type { ModelUsageObserver } from "../../observability/usage.js";
import { redactSecrets } from "../../utils/secrets.js";
import {
  readDailyMemoryNote,
  readDailyMemorySection,
  upsertDailyMemorySection
} from "../../activity/dailyNotes.js";

const maxReflectionSourceChars = 18_000;
const maxReflectionOutputTokens = 700;

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
  force?: boolean;
}

export interface SelfReflectionResult {
  dateKey: string;
  written: boolean;
  model?: string;
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
  if (!options.force && existing?.includes(marker)) return { dateKey, written: false, reason: "up_to_date" };
  if (!options.model) return { dateKey, written: false, reason: "no_model" };

  let reflection: string;
  try {
    const result = await generateNativeText(
      options.model,
      nativeJsonMessages(
        "You write a brief, honest daily self-reflection from local chat, activity, and durable memory context. Return plain text only, in the source language, with 2-5 sentences. Mention one useful observation and one concrete adjustment when evidence supports them. Do not invent feelings or facts, do not expose secrets, and do not include headings or code fences.",
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
    reflection = redactSecrets(result.text).trim();
    if (result.usage) await options.onUsage?.(result.usage, "memory");
  } catch (error) {
    options.signal?.throwIfAborted();
    throw error;
  }
  if (!reflection) return { dateKey, written: false, reason: "empty" };
  await upsertDailyMemorySection(
    dateKey,
    "自我反思",
    `${marker}\n${reflection}`,
    { agentDir: options.agentDir }
  );
  return { dateKey, written: true, model: options.model.modelId };
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `…\n${value.slice(-maxChars)}`;
}
