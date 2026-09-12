import type { AgentMessage, AgentModel, AgentUsage, ModelRequestContext, ModelRequestObserver } from "../agent/core/types.js";

export interface NativeTextGenerationOptions {
  systemPrompt?: string;
  signal?: AbortSignal;
  maxOutputTokens?: number;
  providerOptions?: Record<string, unknown>;
  reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
  onRequestMetrics?: ModelRequestObserver;
  requestContext?: ModelRequestContext;
}

export interface NativeTextGenerationResult {
  text: string;
  usage?: AgentUsage;
}

/** Small native helper for structured side tasks such as memory and compaction. */
export async function generateNativeText(
  model: AgentModel,
  messages: AgentMessage[],
  options: NativeTextGenerationOptions = {}
): Promise<NativeTextGenerationResult> {
  options.signal?.throwIfAborted();
  const timeout = options.timeoutMs === undefined ? undefined : new AbortController();
  const timer = timeout && setTimeout(() => timeout.abort(new DOMException("Auxiliary model request timed out.", "TimeoutError")), options.timeoutMs);
  const signal = timeout
    ? (options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal)
    : options.signal;
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    // 辅助任务没有工具副作用；不等待忽略取消的 Provider，迟到流也不得产出有效结果。
    return await Promise.race([consumeNativeText(model, messages, { ...options, signal }), aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

async function consumeNativeText(
  model: AgentModel,
  messages: AgentMessage[],
  options: NativeTextGenerationOptions
): Promise<NativeTextGenerationResult> {
  options.signal?.throwIfAborted();
  let text = "";
  let usage: AgentUsage | undefined;
  const streamModel = model.streamSimple?.bind(model) ?? model.stream.bind(model);
  const { systemPrompt, ...streamOptions } = options;
  for await (const event of await streamModel({ systemPrompt, messages, tools: [] }, streamOptions)) {
    options.signal?.throwIfAborted();
    if (event.type === "text-delta") text += event.text;
    else if (event.type === "finish") usage = event.usage;
    else if (event.type === "error") throw event.error instanceof Error ? event.error : new Error(String(event.error));
  }
  options.signal?.throwIfAborted();
  return { text, usage };
}

export function nativeJsonMessages(systemPrompt: string, prompt: string): AgentMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: `${systemPrompt}\n\n${prompt}` }] }
  ];
}

export function parseNativeJson(text: string): unknown {
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/u, "");
  return JSON.parse(normalized);
}
