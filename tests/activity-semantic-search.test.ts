/**
 * 语义检索与后台索引分离测试：后台补向量，前台只计算查询向量和 cosine top N；
 * 本地嵌入不可用时返回友好降级（ok=false, no_runtime），由工具层引导回退关键词检索。
 *
 * 用 fake EmbeddingModelRuntime 提供确定性向量：不依赖任何下载/网络。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { precomputeActivityEmbeddings, searchActivitySemantic } from "../src/activity/semanticSearch.js";
import { ActivityStore, type ActivitySessionAnalysis } from "../src/activity/store.js";
import type { EmbeddingModelRuntime, EmbeddingResult } from "../src/llm/embedding/types.js";

const FINGERPRINT = "test-fingerprint";
const NOW = new Date(2026, 7, 26, 15, 0, 0);

await testSemanticSearchEmbedsAndRanks();
await testSemanticSearchHonorsTop100Limit();
await testSemanticQueryPreservesWhitespace();
await testSemanticSearchFallsBackWhenNoRuntime();
await testSemanticSearchExcludesPlaceholderSessions();
await testSemanticSearchSkipsTrivialSessionsInBackfill();
await testSemanticSearchToleratesPassageBatchFailure();
await testSemanticSearchKeepsExistingVectorsWhenBatchFails();
await testSearchNeverBackfills();
await testLateEmbeddingDoesNotPersist();
await testLongOcrUsesOneFrameVector();
await testOcrFramesDiscardLateResults();
await testDiscardChunkIndexKeepsFrames();

async function testDiscardChunkIndexKeepsFrames(): Promise<void> {
  await withStore(async (store, root) => {
    const sessionId = store.startSession(todayAt(9));
    const text = "保留已有 OCR 正文和整帧向量";
    await store.recordFallbackCapture({
      sessionId, occurredAt: todayAt(9), eventType: "fallback_capture",
      rawOcrText: text, jpeg: Buffer.from("test-jpeg")
    });
    const frame = store.listOcrEmbeddingSources(FINGERPRINT)[0]!;
    store.upsertOcrEmbedding(frame.id, FINGERPRINT, vec([1, 0, 0, 0]), todayAt(9));
    await store.close();
    const database = new DatabaseSync(path.join(root, "activity.sqlite"));
    try {
      database.exec(`
        CREATE TABLE activity_ocr_chunks (id TEXT PRIMARY KEY, frame_id TEXT, embedding BLOB);
        CREATE INDEX activity_ocr_chunks_fp_idx ON activity_ocr_chunks(frame_id);
        CREATE TRIGGER activity_ocr_chunks_text_changed AFTER UPDATE OF text ON activity_ocr_frames
        BEGIN DELETE FROM activity_ocr_chunks WHERE frame_id = NEW.id; END;
      `);
      database.prepare("INSERT INTO activity_ocr_chunks VALUES (?, ?, ?)").run("old-chunk", frame.id, Buffer.from([1]));
      await store.open(root);
      assert.equal(database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'activity_ocr_chunks%'").get()?.n, 0);
      assert.equal(store.listRecentOcrFrames(todayAt(9))[0]?.text, text);
      assert.deepEqual(store.listOcrEmbeddingSources(FINGERPRINT), []);
      assert.deepEqual(store.listOcrEmbeddingRows(FINGERPRINT)[0]?.embedding, vec([1, 0, 0, 0]));
    } finally {
      database.close();
    }
  });
}

async function testLongOcrUsesOneFrameVector(): Promise<void> {
  await withStore(async (store, root) => {
    const sessionId = store.startSession(todayAt(9));
    const text = "数据库锁等待排查。" + "普通正文".repeat(2_000) + "完整尾部";
    await store.recordFallbackCapture({
      sessionId, occurredAt: todayAt(9), eventType: "fallback_capture",
      rawOcrText: text, jpeg: Buffer.from("test-jpeg")
    });
    const sources = store.listOcrEmbeddingSources(FINGERPRINT);
    assert.equal(sources.length, 1, "长 OCR 也只对应一个整帧向量");
    assert.equal(sources[0]?.text, text);
    const runtime = ruleRuntime([{ match: /数据库锁等待/u, vector: vec([1, 0, 0, 0]) }]);
    const embed = runtime.embed.bind(runtime);
    const passages: string[] = [];
    runtime.embed = async (request) => {
      if (request.inputType === "passage") passages.push(...request.texts);
      return embed(request);
    };
    const first = await precomputeActivityEmbeddings({ store, getEmbeddingRuntime: async () => runtime });
    assert.ok(first.ok);
    assert.equal(first.embedded, 1);
    assert.equal(store.listOcrEmbeddingRows(FINGERPRINT).length, 1);
    await store.close();
    await store.open(root);
    const resumed = await precomputeActivityEmbeddings({ store, getEmbeddingRuntime: async () => runtime });
    assert.ok(resumed.ok);
    assert.equal(resumed.embedded, 0, "重启不重算已有的整帧向量");
    assert.deepEqual(passages, [text], "整帧正文完整交给嵌入运行时，不自行分块或截断");
    assert.equal(store.listRecentOcrFrames(todayAt(9))[0]?.text, text, "完整正文仍保存在本地");
    store.listOcrEmbeddingSources = () => { throw new Error("前台搜索不得回填向量"); };
    const result = await searchActivitySemantic({ store, getEmbeddingRuntime: async () => runtime, query: "数据库锁等待" });
    assert.ok(result.ok);
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0]?.sessionId, sessionId);
    assert.equal(result.hits[0]?.excerpt, text.slice(0, 2_000));
    assert.deepEqual(passages, [text], "前台只嵌入查询文本");
    assert.equal(store.listOcrEmbeddingRows("replacement-model").length, 0);
  });
}

async function testOcrFramesDiscardLateResults(): Promise<void> {
  for (const mutation of ["update", "clear"] as const) {
    await withStore(async (store, root) => {
      const sessionId = store.startSession(todayAt(9));
      const capture = await store.recordFallbackCapture({
        sessionId, occurredAt: todayAt(9), eventType: "fallback_capture",
        rawOcrText: "旧 OCR 结论", jpeg: Buffer.from("test-jpeg")
      });
      const sources = store.listOcrEmbeddingSources(FINGERPRINT);
      const runtime = ruleRuntime([{ match: /结论/u, vector: vec([1, 0, 0, 0]) }]);
      const embed = runtime.embed.bind(runtime);
      const other = new ActivityStore();
      await other.open(root);
      try {
        runtime.embed = async (request) => {
          if (mutation === "update") other.updateSnapshotOcr(capture.snapshotId!, "新 OCR 结论");
          else await other.clear();
          return embed(request);
        };
        const result = await precomputeActivityEmbeddings({ store, getEmbeddingRuntime: async () => runtime });
        assert.ok(result.ok);
        assert.equal(result.embedded, 0, "另一连接更新或清空 OCR 后，迟到向量不能落库");
        assert.equal(store.listOcrEmbeddingRows(FINGERPRINT).length, 0);
        assert.equal(store.upsertOcrEmbedding(sources[0]!.id, FINGERPRINT, vec([1, 0, 0, 0]), todayAt(9)), false);
        runtime.embed = embed;
        const resumed = await precomputeActivityEmbeddings({ store, getEmbeddingRuntime: async () => runtime });
        assert.ok(resumed.ok);
        assert.equal(resumed.embedded, mutation === "update" ? 1 : 0);
        if (mutation === "update") assert.equal(store.listOcrEmbeddingRows(FINGERPRINT)[0]?.text, "新 OCR 结论");
      } finally {
        await other.close();
      }
    });
  }
}

async function testSemanticQueryPreservesWhitespace(): Promise<void> {
  await withStore(async (store) => {
    seedAnalyzedSession(store, todayAt(9), { summary: "登录", sourceEventCount: 5 });
    const runtime = ruleRuntime([{ match: /登录/u, vector: vec([1, 0, 0, 0]) }]);
    await precomputeActivityEmbeddings({ store, getEmbeddingRuntime: async () => runtime });
    const embed = runtime.embed.bind(runtime);
    const queries: string[][] = [];
    const listOcrRows = store.listOcrEmbeddingRows.bind(store);
    const candidateLimits: Array<number | undefined> = [];
    store.listOcrEmbeddingRows = (fingerprint, limit) => {
      candidateLimits.push(limit);
      return listOcrRows(fingerprint, limit);
    };
    runtime.embed = async (request) => {
      if (request.inputType === "query") queries.push([...request.texts]);
      return embed(request);
    };
    const query = "  登录\n\t";
    const result = await searchActivitySemantic({ store, getEmbeddingRuntime: async () => runtime, query });
    assert.equal(result.ok, true);
    assert.deepEqual(queries, [[query]]);
    assert.deepEqual(candidateLimits, [5_000]);
    const empty = await searchActivitySemantic({
      store,
      getEmbeddingRuntime: async () => { throw new Error("空白查询不应加载模型"); },
      query: " \n\t "
    });
    assert.equal(empty.ok, false);
    assert.deepEqual(queries, [[query]]);
  });
}

/** 后台补嵌入缺失向量后，查询命中相关 session。 */
async function testSemanticSearchEmbedsAndRanks(): Promise<void> {
  await withStore(async (store) => {
    const login = seedAnalyzedSession(store, todayAt(9), {
      summary: "修复登录崩溃",
      topics: ["登录", "auth"],
      highlights: ["定位到 token 过期"],
      project: "biny",
      sourceEventCount: 5
    });
    seedAnalyzedSession(store, todayAt(11), {
      summary: "写公众号文章",
      topics: ["写作", "文章"],
      sourceEventCount: 5
    });
    const runtime = ruleRuntime([
      { match: /修复登录|登录/u, vector: vec([1, 0, 0, 0]) },
      { match: /写文章/u, vector: vec([0, 0, 1, 0]) }
    ]);

    const indexed = await precomputeActivityEmbeddings({ store, getEmbeddingRuntime: async () => runtime });
    assert.ok(indexed.ok);
    assert.equal(indexed.embedded, 2);
    const hit = await searchActivitySemantic({
      store,
      getEmbeddingRuntime: async () => runtime,
      query: "修复登录",
      limit: 3
    });
    assert.equal(hit.ok, true);
    if (!hit.ok) return;
    assert.equal(hit.hits.length, 1, "相似度 > 0 的才上榜");
    assert.equal(hit.hits[0]?.sessionId, login);
    assert.ok(hit.hits[0]!.similarity > 0.9);
    assert.equal(hit.hits[0]!.project, "biny");
  });
}

/** 语义检索结果上限与 OCR 检索协议一致，limit=100 不应被内部 20 条上限截断。 */
async function testSemanticSearchHonorsTop100Limit(): Promise<void> {
  await withStore(async (store) => {
    for (let index = 0; index < 21; index += 1) {
      seedAnalyzedSession(store, new Date(NOW.getTime() + index * 60 * 60 * 1_000).toISOString(), {
        summary: `登录活动 ${index}`,
        sourceEventCount: 5
      });
    }
    const runtime = ruleRuntime([{ match: /登录/u, vector: vec([1, 0, 0, 0]) }]);
    await precomputeActivityEmbeddings({ store, getEmbeddingRuntime: async () => runtime });
    const result = await searchActivitySemantic({
      store,
      getEmbeddingRuntime: async () => runtime,
      query: "登录",
      limit: 100
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.model, "multilingual-e5-small");
    assert.equal(result.hits.length, 21);
  });
}

/** 嵌入运行时不可用 → ok:false + no_runtime，不抛错。 */
async function testSemanticSearchFallsBackWhenNoRuntime(): Promise<void> {
  await withStore(async (store) => {
    seedAnalyzedSession(store, todayAt(9), { summary: "修复登录崩溃", sourceEventCount: 5 });
    const result = await searchActivitySemantic({
      store,
      getEmbeddingRuntime: async () => undefined,
      query: "登录"
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "no_runtime");
    assert.match(result.message, /activity_search/u);
  });
}

/** 占位摘要（零星/失败）不进嵌入清单，也不会变成可检索命中。 */
async function testSemanticSearchExcludesPlaceholderSessions(): Promise<void> {
  await withStore(async (store) => {
    seedAnalyzedSession(store, todayAt(9), { summary: "零星活动", sourceEventCount: 1 });
    seedAnalyzedSession(store, todayAt(10), { summary: "活动分析失败", sourceEventCount: 5 });
    const runtime = ruleRuntime([{ match: /登录/u, vector: vec([1, 0, 0, 0]) }]);
    await precomputeActivityEmbeddings({ store, getEmbeddingRuntime: async () => runtime });
    const result = await searchActivitySemantic({
      store,
      getEmbeddingRuntime: async () => runtime,
      query: "登录"
    });
    // 只有占位行时没有可检索的向量：返回友好提示（no_vectors），由工具层引导
    // 模型回退关键词 activity_search；占位行绝不进入嵌入清单或命中集合。
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "no_vectors");
    assert.match(result.message, /可检索/u);
    assert.equal(store.listAnalysisEmbeddingRows(FINGERPRINT).length, 0, "占位行没有被写入向量表");
  });
}

/** 缺向量补嵌入（backfill）跳过 source_event_count < 3 的心跳行。 */
async function testSemanticSearchSkipsTrivialSessionsInBackfill(): Promise<void> {
  await withStore(async (store) => {
    seedAnalyzedSession(store, todayAt(9), { summary: "闪了一下", sourceEventCount: 2 });
    const real = seedAnalyzedSession(store, todayAt(10), { summary: "修 bug", sourceEventCount: 5 });
    const runtime = ruleRuntime([{ match: /修 bug/u, vector: vec([1, 0, 0, 0]) }]);
    const indexed = await precomputeActivityEmbeddings({ store, getEmbeddingRuntime: async () => runtime });
    assert.ok(indexed.ok);
    assert.equal(indexed.embedded, 1, "后台只补真实行的向量");
    const result = await searchActivitySemantic({
      store,
      getEmbeddingRuntime: async () => runtime,
      query: "修 bug"
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.hits.map((hit) => hit.sessionId), [real]);
  });
}

/** passage 批次嵌入失败不穿透：没有任何可用向量时友好返回 ok:false，而不是把异常抛给工具层。 */
async function testSemanticSearchToleratesPassageBatchFailure(): Promise<void> {
  await withStore(async (store) => {
    seedAnalyzedSession(store, todayAt(9), { summary: "修复登录崩溃", sourceEventCount: 5 });
    const runtime = failingPassageRuntime([{ match: /登录/u, vector: vec([1, 0, 0, 0]) }]);
    await precomputeActivityEmbeddings({ store, getEmbeddingRuntime: async () => runtime });
    const result = await searchActivitySemantic({
      store,
      getEmbeddingRuntime: async () => runtime,
      query: "登录"
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "no_vectors");
  });
}

/** 批次失败只跳过本批：已有向量继续参与检索，缺的行仍待下次补嵌入。 */
async function testSemanticSearchKeepsExistingVectorsWhenBatchFails(): Promise<void> {
  await withStore(async (store) => {
    const login = seedAnalyzedSession(store, todayAt(9), {
      summary: "修复登录崩溃",
      topics: ["登录", "auth"],
      sourceEventCount: 5
    });
    const healthy = ruleRuntime([{ match: /登录/u, vector: vec([1, 0, 0, 0]) }]);
    await precomputeActivityEmbeddings({ store, getEmbeddingRuntime: async () => healthy });
    const first = await searchActivitySemantic({
      store,
      getEmbeddingRuntime: async () => healthy,
      query: "登录"
    });
    assert.equal(first.ok, true, "先在健康运行时下写入旧向量");

    seedAnalyzedSession(store, todayAt(11), { summary: "写公众号文章", sourceEventCount: 5 });
    const degraded = failingPassageRuntime([{ match: /登录/u, vector: vec([1, 0, 0, 0]) }]);
    const indexed = await precomputeActivityEmbeddings({ store, getEmbeddingRuntime: async () => degraded });
    assert.ok(indexed.ok);
    assert.equal(indexed.embedded, 0);
    const second = await searchActivitySemantic({
      store,
      getEmbeddingRuntime: async () => degraded,
      query: "登录"
    });
    assert.equal(second.ok, true, "新批次失败不应拖垮整体检索");
    if (!second.ok) return;
    assert.deepEqual(second.hits.map((hit) => hit.sessionId), [login], "已有向量仍可命中");
    assert.equal(store.listAnalysisEmbeddingSources(FINGERPRINT).length, 1, "失败批次的行仍缺向量，留给下次补");
  });
}

async function testSearchNeverBackfills(): Promise<void> {
  await withStore(async (store) => {
    const indexed = seedAnalyzedSession(store, todayAt(9), { summary: "登录", sourceEventCount: 5 });
    const runtime = ruleRuntime([{ match: /登录/u, vector: vec([1, 0, 0, 0]) }]);
    const embed = runtime.embed.bind(runtime);
    let queries = 0;
    runtime.embed = async (request) => {
      assert.equal(request.inputType, "query", "前台查询不能补算 passage");
      queries += 1;
      return embed(request);
    };
    const empty = await searchActivitySemantic({ store, getEmbeddingRuntime: async () => runtime, query: "登录" });
    assert.ok(!empty.ok);
    assert.equal(empty.reason, "no_vectors");
    assert.equal(queries, 0, "空索引不必计算查询向量");
    assert.equal(store.listAnalysisEmbeddingRows(FINGERPRINT).length, 0);
    store.upsertAnalysisEmbedding(indexed, FINGERPRINT, vec([1, 0, 0, 0]), NOW.toISOString());
    seedAnalyzedSession(store, todayAt(11), { summary: "登录待处理", sourceEventCount: 5 });
    const result = await searchActivitySemantic({ store, getEmbeddingRuntime: async () => runtime, query: "登录" });
    assert.ok(result.ok);
    assert.deepEqual(result.hits.map((hit) => hit.sessionId), [indexed]);
    assert.equal(queries, 1);
    assert.equal(store.listAnalysisEmbeddingSources(FINGERPRINT).length, 1, "积压项仍由后台处理");
    const controller = new AbortController();
    runtime.embed = async (request) => {
      controller.abort();
      return embed(request);
    };
    await assert.rejects(searchActivitySemantic({
      store, getEmbeddingRuntime: async () => runtime, query: "登录", signal: controller.signal
    }), { name: "AbortError" });
  });
}

async function testLateEmbeddingDoesNotPersist(): Promise<void> {
  for (const source of ["ocr", "analysis"] as const) {
    await withStore(async (store) => {
      const sessionId = seedAnalyzedSession(store, todayAt(9), { summary: "登录", sourceEventCount: 5 });
      if (source === "ocr") {
        await store.recordFallbackCapture({
          sessionId, occurredAt: todayAt(9), eventType: "fallback_capture",
          application: "Editor", rawOcrText: "登录", jpeg: Buffer.from("test-jpeg")
        });
      }
      const runtime = ruleRuntime([{ match: /登录/u, vector: vec([1, 0, 0, 0]) }]);
      const embed = runtime.embed.bind(runtime);
      const controller = new AbortController();
      let calls = 0;
      runtime.embed = async (request) => {
        calls += 1;
        controller.abort();
        return embed(request);
      };
      await assert.rejects(precomputeActivityEmbeddings({
        store, getEmbeddingRuntime: async () => runtime, signal: controller.signal
      }), { name: "AbortError" });
      assert.equal(calls, 1);
      assert.equal(store.listOcrEmbeddingRows(FINGERPRINT).length, 0);
      assert.equal(store.listAnalysisEmbeddingRows(FINGERPRINT).length, 0);
      runtime.embed = embed;
      const resumed = await precomputeActivityEmbeddings({ store, getEmbeddingRuntime: async () => runtime });
      assert.ok(resumed.ok);
      assert.equal(resumed.embedded, 1, "取消项保持待处理，可在下一轮恢复；新增 OCR 会使旧分析失效");
      await assert.rejects(precomputeActivityEmbeddings({
        store, signal: controller.signal,
        getEmbeddingRuntime: async () => { throw new Error("取消后不应加载模型"); }
      }), { name: "AbortError" });
    });
  }
}

/** passage 嵌入必失败、query 按规则返回的 fake 运行时：验证批次失败被容错而非穿透。 */
function failingPassageRuntime(rules: ReadonlyArray<{ match: RegExp; vector: Float32Array }>): EmbeddingModelRuntime {
  const base = ruleRuntime(rules);
  return {
    ...base,
    embed: async (request) => {
      if (request.inputType === "passage") throw new Error("embedding backend offline");
      return await base.embed(request);
    }
  };
}

// —— helpers ——

function vec(value: readonly number[]): Float32Array {
  return new Float32Array(value);
}

/** 按规则匹配文本的 fake 嵌入运行时：命中最先匹配的规则取向量，缺省 0 向量（不相似）。 */
function ruleRuntime(rules: ReadonlyArray<{ match: RegExp; vector: Float32Array }>): EmbeddingModelRuntime {
  return {
    fingerprint: FINGERPRINT,
    descriptor: {
      ref: { kind: "local", model: "multilingual-e5-small" },
      fingerprint: FINGERPRINT,
      displayName: "test-embedder",
      dimensions: 4,
      recommendedThresholds: { currentWorkspace: 0.3, crossWorkspace: 0.2 },
      source: "local",
      available: true,
      installed: true
    },
    async embed(request: { texts: readonly string[]; inputType: "query" | "passage" }): Promise<EmbeddingResult> {
      return {
        embeddings: request.texts.map((text) => {
          const rule = rules.find((candidate) => candidate.match.test(text));
          return rule?.vector ?? new Float32Array(4);
        }),
        dimensions: 4,
        fingerprint: FINGERPRINT,
        model: { kind: "local", model: "multilingual-e5-small" }
      };
    }
  };
}

async function withStore(run: (store: ActivityStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-semantic-"));
  const store = new ActivityStore();
  try {
    await store.open(root);
    await run(store, root);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function todayAt(hour: number): string {
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), hour, 0, 0).toISOString();
}

function seedAnalyzedSession(store: ActivityStore, startedAtIso: string, overrides: Partial<ActivitySessionAnalysis> = {}): string {
  const sessionId = store.startSession(startedAtIso);
  const startMs = Date.parse(startedAtIso);
  for (let index = 0; index < 3; index += 1) {
    store.recordEvent({
      sessionId,
      occurredAt: new Date(startMs + index * 1_000).toISOString(),
      eventType: "focus_changed",
      application: "Test App",
      rawText: `Test App event ${index}`
    });
  }
  store.endSession(sessionId, new Date(Date.parse(startedAtIso) + 60 * 60 * 1_000).toISOString());
  store.recordAnalysis({
    sessionId,
    analyzedAt: todayAt(12),
    analyzerModel: "analyzer-test-model",
    project: "side",
    summary: "修了点东西",
    topics: [],
    prs: [],
    issues: [],
    people: [],
    versions: [],
    decisions: [],
    entities: [],
    highlights: [],
    worthMemory: false,
    worthKnowledge: false,
    isMeeting: false,
    storageTier: "standard",
    confidence: 0.7,
    sourceEventCount: 3,
    inputHash: `hash-${sessionId}`,
    ...overrides
  });
  return sessionId;
}
