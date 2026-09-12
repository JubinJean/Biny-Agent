/**
 * activity_search_semantic 的业务实现：优先检索整帧 OCR，再以 analysis 行作补充。
 *
 * 主检索对象是屏幕 OCR 文本；已分析 session 的 project+summary+topics+highlights
 * 作为 OCR 不足时的补充。查询只使用已有索引，缺失向量由后台补齐，避免积压采集数据
 * 把一次前台搜索变成批量推理和写库。
 *
 * 固定使用本地 multilingual-e5-small；模型未下载/不可用
 * 时返回 ok=false，工具层渲染成友好提示，由模型回退到关键词 activity_search，不抛给调用方。
 */
import { setTimeout as delay } from "node:timers/promises";
import type { ActivityStore, ActivityOcrEmbeddingSource } from "./store.js";
import type { EmbeddingModelRuntime, EmbeddingResult } from "../llm/embedding/types.js";
import { cosineSimilarity } from "../llm/embedding/vector.js";
import { ACTIVITY_ANALYSIS_FAILED_SUMMARY, ACTIVITY_TRIVIAL_SUMMARY } from "./analyzer.js";

/** 单次调用最多补嵌入的分析行数；其余留到下一次调用继续补。 */
const EMBED_BATCH_LIMIT = 200;
/** 每轮最多补齐 32 帧，剩余帧下轮续接。 */
const OCR_EMBED_BATCH_LIMIT = 32;
/** 参与 cosine 排序的向量上限（取最新 N 条，防库体无限增长拖慢检索）。 */
const EMBED_SCORE_LIMIT = 1_000;
const OCR_SCORE_LIMIT = 5_000;
const EMBED_BATCH_SIZE = 32;

export interface ActivitySemanticSearchDeps {
  store: ActivityStore;
  /** 本地嵌入运行时；未安装/不可用时返回 undefined。 */
  getEmbeddingRuntime: () => Promise<EmbeddingModelRuntime | undefined>;
  query: string;
  limit?: number;
  signal?: AbortSignal;
  checkpoint?: () => Promise<void>;
}

export interface ActivityEmbeddingPrecomputeDeps {
  store: ActivityStore;
  getEmbeddingRuntime: () => Promise<EmbeddingModelRuntime | undefined>;
  signal?: AbortSignal;
  checkpoint?: () => Promise<void>;
  now?: () => Date;
}

export type ActivityEmbeddingPrecomputeResult =
  | { ok: true; embedded: number; model: string; dimensions: number }
  | { ok: false; reason: "no_runtime" | "no_vectors"; message: string };

export interface ActivitySemanticHit {
  sessionId: string;
  startedAt: string;
  similarity: number;
  project?: string;
  summary: string;
  topics: string[];
  highlights: string[];
  source?: "ocr" | "analysis";
  excerpt?: string;
  occurredAt?: string;
}

export type ActivitySemanticSearchResult =
  | { ok: true; hits: ActivitySemanticHit[]; model: string; dimensions: number }
  | { ok: false; reason: "no_runtime" | "no_vectors"; message: string };

const PLACEHOLDER_SUMMARIES = new Set([ACTIVITY_TRIVIAL_SUMMARY, ACTIVITY_ANALYSIS_FAILED_SUMMARY]);

/**
 * 后台补齐当前本地模型指纹下的 OCR/analysis 向量。
 * 只接受约定的本地 multilingual-e5-small；模型不可用时不改变数据库。
 */
export async function precomputeActivityEmbeddings(
  deps: ActivityEmbeddingPrecomputeDeps
): Promise<ActivityEmbeddingPrecomputeResult> {
  await deps.checkpoint?.();
  deps.signal?.throwIfAborted();
  const runtime = await resolveActivityEmbeddingRuntime(deps.getEmbeddingRuntime);
  await deps.checkpoint?.();
  deps.signal?.throwIfAborted();
  if (!runtime) return unsupportedRuntimeResult();
  const embedded = await embedMissingActivitySources(deps, runtime);
  return {
    ok: true,
    embedded,
    model: activityEmbeddingModelName(runtime),
    dimensions: runtime.descriptor.dimensions ?? 0
  };
}

export async function searchActivitySemantic(deps: ActivitySemanticSearchDeps): Promise<ActivitySemanticSearchResult> {
  await deps.checkpoint?.();
  deps.signal?.throwIfAborted();
  if (!deps.query.trim()) return { ok: false, reason: "no_vectors", message: "查询不能为空。" };

  const runtime = await resolveActivityEmbeddingRuntime(deps.getEmbeddingRuntime);
  await deps.checkpoint?.();
  deps.signal?.throwIfAborted();
  if (!runtime) return unsupportedRuntimeResult();
  const fingerprint = runtime.fingerprint;

  const ocrRows = deps.store.listOcrEmbeddingRows(fingerprint, OCR_SCORE_LIMIT);
  const analysisRows = deps.store.listAnalysisEmbeddingRows(fingerprint, EMBED_SCORE_LIMIT);
  if (!ocrRows.length && !analysisRows.length) return { ok: false, reason: "no_vectors", message: "还没有可检索的 Activity 向量；后台会补齐索引，当前可用 activity_search 的 keyword 模式查询。" };

  const queryResult = await runtime.embed({ texts: [deps.query], inputType: "query", signal: deps.signal });
  // 推理后端未必能中断在途计算；取消后不再读取或返回迟到结果。
  await deps.checkpoint?.();
  deps.signal?.throwIfAborted();
  const queryVector = queryResult.embeddings[0];
  if (!queryVector) return { ok: false, reason: "no_vectors", message: "查询向量生成失败。" };

  const seenOcrSessions = new Set<string>();
  const ocrScored = ocrRows
    .map((row) => ({ row, similarity: cosineSimilarity(queryVector, row.embedding) }))
    .filter((item) => Number.isFinite(item.similarity) && item.similarity > 0)
    .sort((left, right) => right.similarity - left.similarity)
    .filter(({ row }) => {
      // 先按会话取最佳帧，避免为同一会话反复查询分析。
      if (seenOcrSessions.has(row.sessionId)) return false;
      seenOcrSessions.add(row.sessionId);
      return true;
    })
    .map(({ row, similarity }) => {
      const analysis = deps.store.getAnalysis(row.sessionId);
      // 整帧参与向量检索，返回时才截短；完整脱敏原文仍留在本地。
      const excerpt = row.text.slice(0, 2_000);
      return {
        sessionId: row.sessionId,
        startedAt: row.startedAt,
        similarity,
        project: analysis?.project,
        summary: analysis?.summary ?? excerpt,
        topics: analysis?.topics ?? [],
        highlights: analysis?.highlights ?? [],
        source: "ocr" as const,
        excerpt,
        occurredAt: row.occurredAt
      };
    });
  const analysisScored = analysisRows
    .map((row) => ({ row, similarity: cosineSimilarity(queryVector, row.embedding) }))
    .filter((item) => Number.isFinite(item.similarity) && item.similarity > 0)
    .sort((left, right) => right.similarity - left.similarity)
    .map(({ row, similarity }) => ({ ...row, similarity, source: "analysis" as const }));
  const bestBySession = new Map<string, ActivitySemanticHit>();
  for (const hit of [...ocrScored, ...analysisScored]) {
    const previous = bestBySession.get(hit.sessionId);
    if (!previous || hit.similarity > previous.similarity) {
      bestBySession.set(hit.sessionId, {
        sessionId: hit.sessionId,
        startedAt: hit.startedAt,
        similarity: hit.similarity,
        project: hit.project,
        summary: hit.summary,
        topics: hit.topics,
        highlights: hit.highlights,
        source: hit.source,
        excerpt: "excerpt" in hit ? hit.excerpt : undefined,
        occurredAt: "occurredAt" in hit ? hit.occurredAt : undefined
      });
    }
  }
  const scored = [...bestBySession.values()]
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, Math.max(1, Math.min(100, deps.limit ?? 5)));

  return {
    ok: true,
    model: activityEmbeddingModelName(runtime),
    dimensions: queryResult.dimensions,
    hits: scored
  };
}

async function resolveActivityEmbeddingRuntime(
  getRuntime: () => Promise<EmbeddingModelRuntime | undefined>
): Promise<EmbeddingModelRuntime | undefined> {
  let runtime: EmbeddingModelRuntime | undefined;
  try {
    runtime = await getRuntime();
  } catch {
    runtime = undefined;
  }
  if (!runtime) return undefined;
  const runtimeRef = runtime.descriptor.ref;
  if (runtime.descriptor.source !== "local" || runtimeRef.kind !== "local" || runtimeRef.model !== "multilingual-e5-small") {
    return undefined;
  }
  return runtime;
}

function unsupportedRuntimeResult(): { ok: false; reason: "no_runtime"; message: string } {
  return {
    ok: false,
    reason: "no_runtime",
    message: "Activity 本地 multilingual-e5-small 不可用（未下载或运行时未配置）。可以改用 activity_search 的 keyword 模式。"
  };
}

function activityEmbeddingModelName(runtime: EmbeddingModelRuntime): string {
  const ref = runtime.descriptor.ref;
  return ref.kind === "local" ? ref.model : `${ref.provider}/${ref.model}`;
}

async function embedMissingActivitySources(
  deps: ActivityEmbeddingPrecomputeDeps,
  runtime: EmbeddingModelRuntime
): Promise<number> {
  const fingerprint = runtime.fingerprint;
  const ocrMissing = deps.store.listOcrEmbeddingSources(fingerprint, OCR_EMBED_BATCH_LIMIT);
  const analysisMissing = deps.store.listAnalysisEmbeddingSources(fingerprint, EMBED_BATCH_LIMIT)
    .filter((source) => !PLACEHOLDER_SUMMARIES.has(source.summary));
  let embedded = await embedOcrPassages(deps, runtime, fingerprint, ocrMissing);
  embedded += await embedAnalysisPassages(deps, runtime, fingerprint, analysisMissing);
  return embedded;
}

async function embedOcrPassages(
  deps: ActivityEmbeddingPrecomputeDeps,
  runtime: EmbeddingModelRuntime,
  fingerprint: string,
  sources: ReadonlyArray<ActivityOcrEmbeddingSource>
): Promise<number> {
  let embedded = 0;
  for (const [index, source] of sources.entries()) {
    await deps.checkpoint?.();
    deps.signal?.throwIfAborted();
    try {
      const result = await runtime.embed({ texts: [source.text], inputType: "passage", signal: deps.signal });
      // 本地推理可能忽略取消；结果提交前再次检查，保留缺失项供下一轮恢复。
      await deps.checkpoint?.();
      deps.signal?.throwIfAborted();
      const vector = result.embeddings[0];
      if (vector?.length) {
        const saved = deps.store.upsertOcrEmbedding(
          source.id,
          fingerprint,
          vector,
          (deps.now?.() ?? new Date()).toISOString(),
          runtime.descriptor.ref.model
        );
        if (saved) embedded += 1;
      }
    } catch (error) {
      if (deps.signal?.aborted) throw error;
    }
    if ((index + 1) % 4 === 0 || index === sources.length - 1) {
      await delay(250, undefined, { signal: deps.signal });
    }
  }
  return embedded;
}

async function embedAnalysisPassages(
  deps: ActivityEmbeddingPrecomputeDeps,
  runtime: EmbeddingModelRuntime,
  fingerprint: string,
  sources: ReadonlyArray<{ sessionId: string; project?: string; summary: string; topics: string[]; highlights: string[] }>
): Promise<number> {
  let embedded = 0;
  for (let offset = 0; offset < sources.length; offset += EMBED_BATCH_SIZE) {
    await deps.checkpoint?.();
    deps.signal?.throwIfAborted();
    const batch = sources.slice(offset, offset + EMBED_BATCH_SIZE);
    let result: EmbeddingResult;
    try {
      result = await runtime.embed({ texts: batch.map(embeddingText), inputType: "passage", signal: deps.signal });
      await deps.checkpoint?.();
      deps.signal?.throwIfAborted();
    } catch (error) {
      if (deps.signal?.aborted) throw error;
      continue;
    }
    result.embeddings.forEach((vector, index) => {
      const source = batch[index];
      if (!source) return;
      deps.store.upsertAnalysisEmbedding(source.sessionId, fingerprint, vector, (deps.now?.() ?? new Date()).toISOString());
      embedded += 1;
    });
  }
  return embedded;
}

/** 嵌入文本：project 用 [project] 前缀突出，再拼接 summary 与 topics/highlights。 */
function embeddingText(source: { project?: string; summary: string; topics: string[]; highlights: string[] }): string {
  const parts: string[] = [];
  if (source.project?.trim()) parts.push(`[${source.project.trim()}]`);
  parts.push(source.summary.trim());
  parts.push(...source.topics.map((topic) => topic.trim()));
  parts.push(...source.highlights.map((highlight) => highlight.trim()));
  return parts.filter(Boolean).join("。");
}
