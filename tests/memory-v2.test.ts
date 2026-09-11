import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { load as loadSqliteVec } from "sqlite-vec";
import type { AgentModel } from "../src/agent/core/types.js";
import {
  LocalMemory,
  MemoryRevisionConflictError,
  type MemoryEntry,
  type MemoryEntryInput
} from "../src/agent/context/LocalMemory.js";
import { MemoryEmbeddingService } from "../src/agent/context/MemoryEmbeddingService.js";
import { MemoryVectorIndex } from "../src/agent/context/MemoryVectorIndex.js";
import { MemoryStorage, memoryDatabaseFileName } from "../src/agent/context/memoryStorage.js";
import { sleepMergePrompt } from "../src/agent/context/sleepMergePrompt.js";
import { memoryExtractionPrompt, temporaryMemoryCleanupPrompt, parseMemoryOperations } from "../src/agent/context/memoryExtraction.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import type { LocalEmbeddingManager } from "../src/llm/embedding/LocalEmbeddingRuntime.js";
import type { EmbeddingModelDescriptor, EmbeddingModelRuntime } from "../src/llm/embedding/types.js";

async function main(): Promise<void> {
  testMemoryExtractionProtocol();
  await testSingleStoreCasOriginAndEdit();
  await testSharedLibraryAndLexicalFallbackBoundary();
  await testBoundedIndexConcurrentCasAndUsageProjection();
  await testExactDuplicateNormalization();
  await testAutomaticSemanticDedup();
  await testSemanticDeleteAndTemporaryCleanup();
  await testSemanticDeleteResponseProtocol();
  await testTemporaryCleanupRequiresExactCandidateIds();
  await testTemporaryCleanupFailureKeepsMemories();
  await testPersonMemoryRouting();
  await testSummarizationUsesToolModelAndRequiresCompleteTurn();
  await testExtractionUsesOnlyConversationText();
  await testAutomaticSummarySkipsWithoutSemanticEmbedding();
  await testDirectExtractionAndOriginBoundaries();
  await testSingleRootSafetyBoundary();
  await testListEntriesPagination();
  await testArchiveAndRestore();
  await testTemporaryMemoryExpiry();
  await testSleepBridgesCurrentWorkspaceAndUser();
  await testSleepDoesNotCrossWorkspaceDedup();
  await testSleepUserNamespaceCollision();
  await testSleepSimilarityUsesUserNamespaces();
  await testSleepSimilarityBoundaries();
  await testSleepSynthesisArchivesCluster();
  await testSleepSynthesisFailureArchivesDeletedIds();
  await testSleepInvalidDeleteIsSafe();
  await testSleepRunRecord();
  await testSleepPreviewDoesNotMutate();
  await testSleepBatchOrdering();
  await testSleepWeightedSurvivor();
  await testEmbeddingStatusDoesNotCreateIndex();
  await testEmbeddingStatusReadsSelfReflectionMemory();
  await testSemanticSearchTreatsUnbuiltIndexAsEmptyCandidates();
  await testFactsAndVectorsShareDatabase();
  await testInitialEmbeddingGeneration();
  await testMemoryVectorProjectionLifecycle();
  await testLocalMemoryMutationKeepsIndexInSync();
  console.log("memory v3 tests passed");
}

function testMemoryExtractionProtocol(): void {
  assert.deepEqual(parseMemoryOperations('["NO_MEMORY"]'), []);
  assert.deepEqual(parseMemoryOperations("NO_MEMORY"), []);
  assert.deepEqual(parseMemoryOperations("[]"), []);
  assert.deepEqual(parseMemoryOperations('[{"content":"unfinished"'), []);
  assert.deepEqual(parseMemoryOperations("A reusable fact"), [{ content: "A reusable fact", operation: "add", durability: "permanent" }]);
  assert.deepEqual(parseMemoryOperations("Result: [{content:'forget this',operation:'delete'}, 'keep this'] done"), [
    { content: "forget this", operation: "delete", durability: "permanent" },
    { content: "keep this", operation: "add", durability: "permanent" }
  ]);
  assert.deepEqual(parseMemoryOperations('[null,7,"NO_MEMORY",{"content":"NO_MEMORY"},{"content":"valid","operation":"other","durability":"other"}]'), [
    { content: "valid", operation: "add", durability: "permanent" }
  ]);
  assert.equal(parseMemoryOperations(JSON.stringify(Array.from({ length: 20 }, (_, index) => `fact ${index}`))).length, 20);
}

/** 分页：offset/limit 切片 + total 为分页前计数，页间不重复不遗漏。 */
async function testListEntriesPagination(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const storage = new MemoryStorage(workspaceRoot);
    let revision = 0;
    for (let index = 0; index < 7; index += 1) {
      revision = (await storage.writeEntry(projectEntry(
        `分页条目 ${String(index)}`,
        `分页测试内容 ${String(index)}，用于验证 offset 与 limit 切片正确且 total 准确。`
      ), { expectedRevision: revision })).revision;
    }
    const page0 = await storage.listEntries({ origins: ["all"], offset: 0, limit: 3 });
    assert.equal(page0.entries.length, 3);
    assert.equal(page0.total, 7);
    const page1 = await storage.listEntries({ origins: ["all"], offset: 3, limit: 3 });
    assert.equal(page1.entries.length, 3);
    assert.equal(page1.total, 7);
    const page2 = await storage.listEntries({ origins: ["all"], offset: 6, limit: 3 });
    assert.equal(page2.entries.length, 1);
    assert.equal(page2.total, 7);
    // 三页并集 = 全集，无重复。
    const ids = new Set([...page0.entries, ...page1.entries, ...page2.entries].map((entry) => entry.id));
    assert.equal(ids.size, 7, "分页必须覆盖全部条目且无重复");
    // offset 超出范围返回空页但 total 仍准确。
    const beyond = await storage.listEntries({ origins: ["all"], offset: 100, limit: 3 });
    assert.equal(beyond.entries.length, 0);
    assert.equal(beyond.total, 7);
  });
}

async function testSingleStoreCasOriginAndEdit(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const overview = await memory.getOverview();
    assert.equal(overview.storeRevision, 0);
    assert.deepEqual(overview.origins, { user: 0, currentWorkspace: 0, otherWorkspaces: 0 });

    const universal = await memory.writeEntry({
      audience: "universal",
      kind: "working_style",
      topic: "working-style",
      title: "Concise updates",
      summary: "The user explicitly prefers concise progress updates during long coding tasks.",
      importance: 5,
      lineage: {
        source: "explicit",
        externalContext: false,
        userEvidence: "Please keep progress updates concise."
      }
    }, { expectedRevision: 0, now: new Date("2026-08-01T00:00:00.000Z") });
    assert.equal(universal.entry?.origin.kind, "user");
    assert.equal(universal.revision, 1);

    const workspace = await memory.writeEntry(projectEntry(
      "Weather source",
      "Use src/weather.ts for deterministic weather requests."
    ), { expectedRevision: 1, now: new Date("2026-08-01T01:00:00.000Z") });
    assert.equal(workspace.entry?.origin.kind, "workspace");
    assert.equal(workspace.revision, 2, "user and workspace writes must share one revision");

    await assert.rejects(memory.writeEntry(projectEntry(
      "Stale write",
      "This stale single-store CAS write must not overwrite newer entries."
    ), { expectedRevision: 1 }), MemoryRevisionConflictError);

    await assert.rejects(memory.writeEntry({
      audience: "universal",
      kind: "decision",
      topic: "decisions",
      title: "Repository decision",
      summary: "Use src/weather.ts as this repository's weather entry point.",
      paths: ["src/weather.ts"],
      lineage: { source: "explicit", externalContext: false, userEvidence: "Use src/weather.ts." }
    }, { expectedRevision: 2 }), /Universal memory|Project paths and decisions|Global memory/u);

    const created = workspace.entry;
    assert.ok(created);
    const updated = await memory.updateEntry(created.id, {
      title: "Deterministic weather source",
      summary: "Use src/weather.ts as the deterministic weather request entry point.",
      importance: 4
    }, { expectedRevision: 2, now: new Date("2026-08-02T00:00:00.000Z") });
    assert.equal(updated.entry?.id, created.id);
    assert.equal(updated.entry?.createdAt, created.createdAt);
    assert.deepEqual(updated.entry?.origin, created.origin);
    assert.equal(updated.entry?.lineage.at(-1)?.source, "explicit_edit");
    assert.equal(updated.revision, 3);

    const database = new DatabaseSync(path.join(agentRoot, "memory", memoryDatabaseFileName), { readOnly: true });
    try {
      const rows = database.prepare("SELECT content, metadata FROM memories").all() as Array<{ content: string; metadata: string }>;
      assert.equal(rows.length, 2);
      assert.equal(rows.some((row) => row.content.includes("concise progress updates")), true);
      assert.equal(rows.some((row) => row.metadata.includes("\"kind\":\"user\"") === false), true);
      assert.equal(rows.every((row) => row.metadata.includes(path.resolve(workspaceRoot)) === false), true, "origin must not persist an absolute workspace path");
    } finally {
      database.close();
    }
  });
}

async function testSharedLibraryAndLexicalFallbackBoundary(): Promise<void> {
  await withSharedAgent(async (agentRoot) => {
    const firstWorkspace = await mkdtemp(path.join(os.tmpdir(), "biny-memory-v3-first-"));
    const secondWorkspace = await mkdtemp(path.join(os.tmpdir(), "biny-memory-v3-second-"));
    try {
      const first = new LocalMemory(firstWorkspace, unusedModel);
      await first.writeEntry({
        ...projectEntry("Release workflow", "Run pnpm test before publishing the first workspace."),
        topic: "release",
        keywords: ["release", "publish"]
      }, { expectedRevision: 0 });

      const second = new LocalMemory(secondWorkspace, unusedModel);
      const overview = await second.getOverview();
      assert.equal(overview.entryCount, 1);
      assert.deepEqual(overview.origins, { user: 0, currentWorkspace: 0, otherWorkspaces: 1 });
      assert.equal((await second.listMemoryEntries({ origins: ["other_workspaces"] })).entries.length, 1);
      assert.equal((await second.search("release publish", [], { origins: ["all"] })).matches.length, 1, "manual all-origin search can inspect shared memory");
      assert.equal((await second.search("release publish", [], { origins: ["user", "current_workspace"] })).matches.length, 0, "lexical fallback must not auto-inject another workspace");

      const own = await second.writeEntry({
        ...projectEntry("Second release", "Run typecheck before publishing the second workspace."),
        topic: "release",
        keywords: ["release", "publish"]
      }, { expectedRevision: overview.storeRevision });
      assert.equal(own.revision, 2);
      const filtered = await second.search("release publish", [], { origins: ["user", "current_workspace"] });
      assert.equal(filtered.matches.length, 1);
      assert.equal(filtered.matches[0]?.entry.origin.kind, "workspace");
      assert.equal((filtered.matches[0]?.entry.origin as { workspaceName?: string }).workspaceName, path.basename(secondWorkspace));
      assert.equal(await fs.realpath(path.join(agentRoot, "memory")), path.join(await fs.realpath(agentRoot), "memory"));
    } finally {
      await rm(firstWorkspace, { recursive: true, force: true });
      await rm(secondWorkspace, { recursive: true, force: true });
    }
  });
}

async function testBoundedIndexConcurrentCasAndUsageProjection(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const storage = new MemoryStorage(workspaceRoot);
    let revision = 0;
    for (let index = 0; index < 18; index += 1) {
      revision = (await storage.writeEntry(projectEntry(
        `Long indexed title ${String(index)} ${"x".repeat(70)}`,
        `Durable indexed summary ${String(index)} ${"content ".repeat(20)}`
      ), { expectedRevision: revision })).revision;
    }
    const overview = await storage.getOverview();
    assert.equal(overview.entryCount, 18);

    const concurrent = await Promise.allSettled([
      storage.writeEntry(projectEntry("Concurrent A", "Concurrent A must win or conflict without overwriting another writer."), { expectedRevision: revision }),
      storage.writeEntry(projectEntry("Concurrent B", "Concurrent B must win or conflict without overwriting another writer."), { expectedRevision: revision })
    ]);
    assert.equal(concurrent.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(concurrent.some((result) => result.status === "rejected" && result.reason instanceof MemoryRevisionConflictError), true);

    const entry = (await storage.listEntries({ origins: ["current_workspace"] })).entries[0];
    assert.ok(entry);
    const beforeRevision = (await storage.getOverview()).storeRevision;
    await storage.recordRecallUsage([entry.id, entry.id], { now: new Date("2026-08-03T00:00:00.000Z") });
    const recalled = (await storage.listEntries({ origins: ["current_workspace"] })).entries.find(({ id }) => id === entry.id);
    assert.equal(recalled?.accessCount, 1, "one citation call counts an id once");
    assert.equal(recalled?.lastAccessedAt, "2026-08-03T00:00:00.000Z");
    assert.equal((await storage.getOverview()).storeRevision, beforeRevision, "derived usage must not advance content revision");
    const database = new DatabaseSync(path.join(agentRoot, "memory", memoryDatabaseFileName), { readOnly: true });
    try {
      const row = database.prepare("SELECT metadata FROM memories WHERE id = ?").get(entry.id) as { metadata?: string } | undefined;
      assert.equal(row?.metadata?.includes("accessCount"), true, "usage metadata follows the canonical field name");
      assert.equal(row?.metadata?.includes("recallCount"), false, "the legacy usage alias is absent");
    } finally {
      database.close();
    }

    await storage.deleteEntry(entry.id, { expectedRevision: (await storage.getOverview()).storeRevision });
    const pruned = (await storage.listEntries({ origins: ["current_workspace"] })).entries.filter(({ id }) => id === entry.id);
    assert.equal(pruned.length, 0, "deleted entry must be removed");
  });
}

async function testExactDuplicateNormalization(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const storage = new MemoryStorage(workspaceRoot);
    const first = await storage.writeEntry({
      ...projectEntry("Cafe\u0301   rule", "Keep the cafe\u0301 rule.\n\nIt must be checked before release."),
      decisions: ["  Check it before release.  "],
      paths: ["src/ cafe.ts"],
      keywords: ["Cafe\u0301"]
    }, { expectedRevision: 0 });
    assert.equal(first.written, true);
    const duplicate = await storage.writeEntry({
      ...projectEntry("A different title", "Keep the café rule. It must be checked before release."),
      decisions: ["A different metadata value"],
      paths: ["src/other.ts"],
      keywords: ["other-keyword"]
    }, { expectedRevision: first.revision });
    assert.equal(duplicate.written, false, "only NFC and whitespace-normalized content determines an exact duplicate");
    assert.equal(duplicate.entry?.id, first.entry?.id);
    assert.equal((await storage.getOverview()).entryCount, 1);
    let revision = duplicate.revision;
    for (const summary of [
      "keep the café rule. It must be checked before release.",
      "Keep the café rule! It must be checked before release.",
      "Keep the cafe rule. It must be checked before release.",
      "Keep the ｃａｆé rule. It must be checked before release."
    ]) {
      const distinct = await storage.writeEntry(projectEntry("Distinct spelling", summary), { expectedRevision: revision });
      assert.equal(distinct.written, true, "case, punctuation, accents and compatibility characters are not exact duplicates");
      revision = distinct.revision;
    }
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    try {
      const preview = await memory.previewMaintenance({ useLlm: false });
      assert.deepEqual(preview.archiveProposed, []);
      await memory.runMemoryMaintenance({ useLlm: false });
      assert.equal((await storage.getOverview()).entryCount, 5);
    } finally {
      memory.close();
      storage.close();
    }
  });
}

async function testAutomaticSemanticDedup(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    let response: Record<string, unknown> = { isDuplicate: true, reason: "same core fact", duplicateOf: 1 };
    const model = jsonMemoryModel((prompt) => prompt.startsWith('New memory to add: "')
      ? `Result: ${JSON.stringify(response)}`
      : "{}");
    const seed = new LocalMemory(workspaceRoot, unusedModel);
    const first = await seed.writeEntry(projectEntry(
      "Release verification",
      "The release workflow requires running the complete test suite before publishing the package."
    ), { expectedRevision: 0 });
    assert.ok(first.entry);
    const memory = new LocalMemory(
      workspaceRoot,
      () => model,
      undefined,
      3,
      undefined,
      undefined,
      undefined,
      async () => [first.entry!]
    );
    const result = await memory.writeAutoEntry({
      ...projectEntry(
        "A shorter release rule",
        "Run the complete test suite before publishing the package as part of the release workflow."
      ),
      lineage: { source: "completed_task", externalContext: false }
    }, { expectedRevision: first.revision });
    assert.equal(result.written, false);
    assert.equal(result.entry?.id, first.entry.id);
    assert.equal((await memory.getOverview()).entryCount, 1);
    for (const duplicateOf of [undefined, 0, -1, 1.5, 99, "1", null]) {
      response = { isDuplicate: true, reason: { unexpected: "type" }, duplicateOf };
      const skipped = await memory.writeAutoEntry({
        ...projectEntry("Unlinked duplicate", "A paraphrased release rule repeats the existing verification requirements."),
        lineage: { source: "completed_task", externalContext: false }
      }, { expectedRevision: first.revision });
      assert.equal(skipped.written, false);
      assert.equal(skipped.entry, undefined);
      assert.equal(skipped.path, undefined);
      assert.equal((await memory.getOverview()).entryCount, 1);
    }
    memory.close();
    seed.close();
  });
}

async function testSemanticDeleteAndTemporaryCleanup(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const seed = new LocalMemory(workspaceRoot, unusedModel);
    const obsolete = await seed.writeEntry(projectEntry(
      "Old release rule",
      "The old release process requires publishing directly without running the complete test suite first."
    ), { expectedRevision: 0 });
    const temporary = await seed.writeEntry({
      ...projectEntry(
        "Temporary branch note",
        "The temporary branch note is only relevant to the previous release investigation and can expire."
      ),
      durability: "temporary",
      expiresAt: "2026-08-20T00:00:00.000Z"
    }, { expectedRevision: obsolete.revision });
    assert.ok(obsolete.entry);
    assert.ok(temporary.entry);
    const model = jsonMemoryModel((prompt) => {
      if (prompt.includes("Extract memories from this conversation:")) return JSON.stringify([{ operation: "delete", content: "the old release rule" }]);
      if (prompt.startsWith("The user wants to delete memories about:")) return "[1]";
      if (prompt.startsWith("Current date and time:")) return JSON.stringify([temporary.entry!.id]);
      return "[]";
    });
    const memory = new LocalMemory(
      workspaceRoot,
      () => model,
      undefined,
      3,
      undefined,
      undefined,
      undefined,
      async (_query, options) => options.minimumSimilarity === 0
        ? [obsolete.entry!]
        : [temporary.entry!]
    );
    const result = await memory.summarizeAndStoreMemories([
      { role: "user", content: "The old release rule is no longer valid; the temporary note is no longer relevant." },
      { role: "assistant", content: "I will remove the obsolete temporary context." }
    ], {
      sessionId: "semantic-delete-session",
      turnId: "semantic-delete-turn",
      runId: "semantic-delete-run",
      externalContext: false,
      excludeExternalContext: false,
      now: new Date("2026-08-21T00:00:00.000Z")
    });
    assert.deepEqual(result.deleted, [
      { id: obsolete.entry.id, content: obsolete.entry.summary },
      { id: temporary.entry.id, content: temporary.entry.summary }
    ]);
    assert.deepEqual(result.created, []);
    assert.equal((await memory.getOverview()).entryCount, 0);
  });
}

async function testSemanticDeleteResponseProtocol(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    let description = "   ";
    let selection = "[]";
    let searches = 0;
    const prompts: string[] = [];
    const memory = new LocalMemory(workspaceRoot, () => jsonMemoryModel((prompt) => (
      prompt.startsWith("Extract memories from this conversation:")
        ? JSON.stringify([{ operation: "delete", content: description }])
        : selection
    ), prompts), undefined, 3, undefined, undefined, undefined, async (query, options) => {
      if (options.minimumSimilarity === 0.3) return [];
      assert.equal(query, "forget the release rule");
      assert.equal(options.minimumSimilarity, 0);
      assert.equal(options.limit, 10);
      searches += 1;
      return [candidate];
    });
    const written = await memory.writeEntry(projectEntry("Release rule", "The user previously preferred publishing without running the complete test suite."), { expectedRevision: 0 });
    assert.ok(written.entry);
    const candidate = written.entry;
    const runDelete = () => memory.summarizeAndStoreMemories([
      { role: "user", content: "Forget the old release rule." },
      { role: "assistant", content: "I will remove it." }
    ], { sessionId: "delete-session", turnId: "delete-turn", runId: "delete-run", externalContext: false, excludeExternalContext: false });
    assert.deepEqual((await runDelete()).deleted, []);
    assert.equal(searches, 0);
    description = "  forget the release rule  ";
    for (const response of ['["1"]', "[-1]", "[1.0]", "[1,]", "[0,99]", "[] then [1]"]) {
      selection = response;
      assert.deepEqual((await runDelete()).deleted, [], response);
      assert.equal((await memory.getOverview()).entryCount, 1);
    }
    selection = `Selected: ${JSON.stringify(Array.from({ length: 12 }, () => 1))} because the user asked to forget it.`;
    assert.deepEqual((await runDelete()).deleted, [{ id: candidate.id, content: candidate.summary }]);
    assert.equal((await memory.getOverview()).entryCount, 0);
    assert.equal(prompts.at(-1), `The user wants to delete memories about: "${description}"\n\nHere are the candidate memories from the database:\n1. [permanent] ${candidate.summary}\n\nWhich memories should be deleted? Respond with ONLY a JSON array of the numbers (1-indexed) of memories that should be deleted.\nIf none should be deleted, respond with [].\nExample response: [1, 3, 5] or []\n\nBe precise - only select memories that truly match what the user wants to delete.`);
    memory.close();
  });
}

async function testTemporaryCleanupRequiresExactCandidateIds(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    let cleanupResponse = "[1]";
    const prompts: string[] = [];
    const now = new Date("2026-08-21T18:34:56.000Z");
    const memory = new LocalMemory(workspaceRoot, () => jsonMemoryModel((prompt) => (
      prompt.includes("Extract memories from this conversation:") ? '["NO_MEMORY"]' : cleanupResponse
    ), prompts), undefined, 3, undefined, undefined, undefined, async (query, options) => {
      assert.equal(query, "user: The project has finished.\n\nassistant: The deadline is no longer relevant.");
      assert.equal(options.limit, 20);
      assert.equal(options.minimumSimilarity, 0.3);
      return [candidate];
    });
    const written = await memory.writeEntry({
      ...projectEntry("Temporary project", "The user is preparing a multi-session project with an upcoming deadline."),
      durability: "temporary"
    }, { expectedRevision: 0 });
    assert.ok(written.entry);
    const candidate = written.entry;
    const runCleanup = () => memory.summarizeAndStoreMemories([
      { role: "user", content: "The project has finished." },
      { role: "assistant", content: "The deadline is no longer relevant." }
    ], { sessionId: "cleanup-session", turnId: "cleanup-turn", runId: "cleanup-run", externalContext: false, excludeExternalContext: false, now });
    for (const response of ["[1]", JSON.stringify([` ${candidate.id} `]), '["unknown-id"]', `["${candidate.id}"`, `[] followed by ["${candidate.id}"]`]) {
      cleanupResponse = response;
      assert.deepEqual((await runCleanup()).deleted, [], response);
      assert.equal((await memory.getOverview()).entryCount, 1);
    }
    cleanupResponse = JSON.stringify([null, 1, "unknown-id", candidate.id, candidate.id]);
    assert.deepEqual((await runCleanup()).deleted, [{ id: candidate.id, content: candidate.summary }]);
    assert.equal((await memory.getOverview()).entryCount, 0);
    const created = new Date(candidate.createdAt);
    const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${date.toLocaleTimeString()}`;
    assert.equal(prompts.at(-1), `Current date and time: ${localDate(now)}\n\nCurrent conversation context:\nuser: The project has finished.\n\nassistant: The deadline is no longer relevant.\n\nTemporary memories related to this conversation:\n- id: "${candidate.id}", created: "${localDate(created)}", content: "${candidate.summary}"`);
    memory.close();
  });
}

async function testTemporaryCleanupFailureKeepsMemories(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    let mode: "empty" | "permanent" | "embedding-error" | "model-error" | "abort" = "empty";
    let cleanupCalls = 0;
    const controller = new AbortController();
    const memory = new LocalMemory(workspaceRoot, () => jsonMemoryModel((prompt) => {
      if (prompt.startsWith("Extract memories from this conversation:")) return '["NO_MEMORY"]';
      cleanupCalls += 1;
      if (mode === "abort") controller.abort();
      throw new Error("cleanup model unavailable");
    }), undefined, 3, undefined, undefined, undefined, async () => {
      if (mode === "embedding-error") throw new Error("embedding unavailable");
      if (mode === "empty") return [];
      return mode === "permanent" ? [permanent.entry!] : [temporary.entry!];
    });
    const temporary = await memory.writeEntry({
      ...projectEntry("Temporary work", "The user is working on a temporary project with an upcoming deadline."),
      durability: "temporary"
    }, { expectedRevision: 0 });
    const permanent = await memory.writeEntry(projectEntry("Stable preference", "The user prefers written project updates with specific next steps."), { expectedRevision: temporary.revision });
    const runCleanup = () => memory.summarizeAndStoreMemories([
      { role: "user", content: "The project is finished." },
      { role: "assistant", content: "The deadline has passed." }
    ], { sessionId: "failure-session", turnId: "failure-turn", runId: "failure-run", externalContext: false, excludeExternalContext: false, signal: controller.signal });
    for (const scenario of ["empty", "permanent", "embedding-error", "model-error"] as const) {
      mode = scenario;
      assert.deepEqual(await runCleanup(), { created: [], deleted: [] });
      assert.equal((await memory.getOverview()).entryCount, 2);
    }
    assert.equal(cleanupCalls, 1);
    mode = "abort";
    await assert.rejects(runCleanup(), { name: "AbortError" });
    assert.equal((await memory.getOverview()).entryCount, 2);
    memory.close();
  });
}

async function testPersonMemoryRouting(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const result = await memory.writeAutoEntry({
      ...projectEntry(
        "Person profile",
        "PERSON: Alice: Alice prefers concise written updates and clear next steps."
      ),
      lineage: { source: "completed_task", externalContext: false }
    }, { expectedRevision: 0 });
    assert.equal(result.written, false);
    assert.equal((await memory.getOverview()).entryCount, 0);
    const profile = await fs.readFile(path.join(agentRoot, "people", "Alice.md"), "utf8");
    assert.match(profile, /prefers concise written updates/u);
  });
}

async function testSummarizationUsesToolModelAndRequiresCompleteTurn(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    let extractionCalls = 0;
    let toolCalls = 0;
    const extractionModel = jsonMemoryModel(() => {
      extractionCalls += 1;
      return JSON.stringify([]);
    });
    const toolModel = jsonMemoryModel(() => {
      toolCalls += 1;
      return JSON.stringify([{ operation: "add",
          audience: "workspace",
          kind: "fact",
          topic: "tool-model",
          title: "Tool model memory",
          content: "The memory summarizer must use the configured tool model for completed turns."
         }]);
    });
    const memory = new LocalMemory(
      workspaceRoot,
      () => extractionModel,
      undefined,
      3,
      undefined,
      undefined,
      undefined,
      async () => [],
      () => toolModel
    );

    const incomplete = await memory.summarizeAndStoreMemories(
      [{ role: "user", content: "A single message is not enough to summarize." }],
      {
        sessionId: "tool-model-session",
        turnId: "tool-model-incomplete",
        runId: "tool-model-run-1",
        externalContext: false,
        excludeExternalContext: false
      }
    );
    assert.deepEqual(incomplete, { created: [], deleted: [] });
    assert.equal(toolCalls, 0);
    assert.equal(extractionCalls, 0);

    const complete = await memory.summarizeAndStoreMemories(
      [
        { role: "user", content: "Use the configured tool model for this durable memory rule." },
        { role: "assistant", content: "I will store the stable rule after the completed turn." }
      ],
      {
        sessionId: "tool-model-session",
        turnId: "tool-model-complete",
        messageId: "M_2",
        runId: "tool-model-run-2",
        externalContext: false,
        excludeExternalContext: false,
        onMemoryWritten: async () => { throw new Error("downstream projection unavailable"); }
      }
    );
    assert.equal(complete.created.length, 1);
    const linked = (await memory.listMemoryEntries({ origins: ["current_workspace"] })).entries.find((entry) => entry.messageId === "M_2");
    assert.deepEqual(complete.created, [{ id: linked?.id, content: linked?.summary }]);
    assert.deepEqual(complete.deleted, []);
    assert.equal(linked?.threadId, "tool-model-session");
    assert.deepEqual(linked?.tags, ["conversation-summary"]);
    assert.equal(linked?.importance, 0.5);
    assert.ok(linked?.lineage.some((item) => item.turnId === "tool-model-complete"));
    assert.equal(toolCalls, 1);
    assert.equal(extractionCalls, 0);
  });
}

async function testExtractionUsesOnlyConversationText(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const prompts: string[] = [];
    const memory = new LocalMemory(workspaceRoot, () => jsonMemoryModel(() => '["NO_MEMORY"]', prompts));
    const longText = "  用户长期信息 ".repeat(1200);
    try {
      await memory.summarizeAndStoreMemories([
        { role: "user", content: "outside the last four" },
        { role: "assistant", content: [{ type: "text", text: "old answer" }] },
        { role: "user", content: longText },
        { role: "assistant", content: [
          { type: "reasoning", text: "private reasoning must not become memory" },
          { type: "text", text: "visible first" },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "tool arguments must not become memory" } },
          { type: "text", text: "visible second" }
        ] },
        { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "tool result must not become memory" }] },
        { role: "user", content: "  final question  " },
        { role: "assistant", content: [{ type: "text", text: "final answer" }] }
      ], { sessionId: "text-session", turnId: "text-turn", runId: "text-run", externalContext: false, excludeExternalContext: false });
      assert.equal(prompts.length, 1);
      assert.equal(prompts[0], "Extract memories from this conversation:\n\n"
        + `user: ${longText}\n\nassistant: visible first\nvisible second\n\nuser:   final question  \n\nassistant: final answer`);
    } finally {
      memory.close();
    }
  });
}

async function testAutomaticSummarySkipsWithoutSemanticEmbedding(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const model = jsonMemoryModel(() => JSON.stringify([{ operation: "add",
        audience: "workspace",
        kind: "fact",
        topic: "semantic-gate",
        title: "Semantic write gate",
        content: "Automatic memory writes require a semantic embedding before they enter the durable store."
       }]));
    const memory = new LocalMemory(
      workspaceRoot,
      () => model,
      undefined,
      3,
      undefined,
      undefined,
      undefined,
      async () => undefined
    );
    const result = await memory.summarizeAndStoreMemories([
      { role: "user", content: "Only store this automatic fact when semantic deduplication is available." },
      { role: "assistant", content: "I will apply the semantic write gate." }
    ], {
      sessionId: "semantic-gate-session",
      turnId: "semantic-gate-turn",
      runId: "semantic-gate-run",
      externalContext: false,
      excludeExternalContext: false
    });
    assert.deepEqual(result.created, []);
    assert.equal((await memory.getOverview()).entryCount, 0);
  });
}


async function testDirectExtractionAndOriginBoundaries(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(
      workspaceRoot,
      () => jsonMemoryModel(() => JSON.stringify([{ operation: "add",
            audience: "workspace",
            kind: "workflow",
            topic: "release",
            title: "Durable release workflow",
            content: "Completed root turn established a durable release workflow for this workspace.",
            decisions: [],
            paths: [],
            keywords: ["release", "workflow"]
           },{ operation: "add",
            audience: "universal",
            kind: "working_style",
            topic: "working-style",
            title: "Actionable summaries",
            content: "The user prefers durable summaries to remain concise and directly actionable.",
            decisions: [],
            paths: [],
            keywords: ["concise", "actionable"],
            userEvidence: "The user explicitly prefers durable summaries to remain concise and directly actionable."
           }])),
      undefined,
      3,
      undefined,
      undefined,
      undefined,
      async () => []
    );
    const result = await memory.summarizeAndStoreMemories(
      [
        { role: "user", content: "Remember the durable release workflow and my preference for concise actionable summaries." },
        { role: "assistant", content: "I will retain those durable memory rules." }
      ],
      {
        sessionId: "session-1",
        turnId: "turn-1",
        runId: "run-1",
        externalContext: false,
        excludeExternalContext: true,
        now: new Date("2026-08-10T00:00:00.000Z")
      }
    );
    assert.equal(result.created.length, 2);
    const entries = (await memory.listMemoryEntries({ origins: ["all"] })).entries;
    assert.equal(entries.length, 2);
    assert.equal(entries.some((entry) => entry.origin.kind === "workspace"), true);
    assert.equal(entries.every((entry) => entry.origin.kind === "workspace"), true);
    assert.equal(entries.every((entry) => entry.lineage[0]?.source === "completed_task"), true);

    // 同一响应再次到达时由事实库做 exact dedup，不产生第二份记忆。
    const duplicate = await memory.summarizeAndStoreMemories(
      [
        { role: "user", content: "The same durable workflow and preference still apply." },
        { role: "assistant", content: "The existing durable entries still apply." }
      ],
      {
        sessionId: "session-1",
        turnId: "turn-2",
        runId: "run-2",
        externalContext: false,
        excludeExternalContext: true,
        now: new Date("2026-08-10T00:00:00.000Z")
      }
    );
    assert.deepEqual(duplicate.created, []);
    assert.equal((await memory.getOverview()).entryCount, 2);

    // 配置为排除外部上下文时，完成回合不会调用模型，也不会写入事实库。
    const excluded = await memory.summarizeAndStoreMemories(
      [{ role: "user", content: "This came from an external attachment." }],
      {
        sessionId: "session-2",
        turnId: "turn-3",
        runId: "run-3",
        externalContext: true,
        excludeExternalContext: true
      }
    );
    assert.deepEqual(excluded, { created: [], deleted: [] });
  });
}

async function testSleepRunRecord(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const first = await memory.writeEntry(projectEntry(
      "A durable task summary",
      "A completed task summary with enough durable content for sleep processing."
    ), { expectedRevision: 0, now: new Date("2026-08-01T00:00:00.000Z") });
    await memory.writeEntry(projectEntry(
      "A second durable task summary",
      "A second completed task summary that keeps the failure path in the same namespace."
    ), { expectedRevision: first.revision, now: new Date("2026-08-01T00:00:01.000Z") });
    const result = await memory.runMemoryMaintenance({ now: new Date("2026-08-02T00:00:00.000Z"), useLlm: false }, {
      findSimilarPairs: async () => {
        throw new Error("index unavailable");
      }
    });
    assert.equal(result.failed, 1);
    const status = await memory.loadMaintenanceStatus();
    assert.equal(status.lastRun?.trigger, "scheduled");
    assert.equal(status.lastRun?.status, "failed");
    assert.equal(status.lastRun?.error, "index unavailable");
    assert.equal(status.lastRun?.examined, 0, "索引失败时不能把条目数计入 examined");
    assert.equal(typeof status.lastRun?.id, "string");
  });
}

async function testArchiveAndRestore(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const storage = new MemoryStorage(workspaceRoot);
    const created = await storage.writeEntry(projectEntry(
      "Archiveable memory",
      "This memory remains available after archival and can be restored without losing its SQLite fact."
    ), { expectedRevision: 0 });
    assert.ok(created.entry);
    const archived = await storage.archiveEntry(created.entry!.id, true, { expectedRevision: created.revision, now: new Date("2026-08-20T00:00:00.000Z") });
    assert.equal(archived.archived, true);
    assert.equal(archived.entry?.archivedReason, "manual");
    assert.notEqual(archived.entry?.id, created.entry!.id);
    assert.equal(archived.entry?.originalId, created.entry!.id);
    assert.equal(archived.entry?.archivedBy, "manual");
    assert.equal((await storage.listEntries({ origins: ["all"] })).entries.length, 0);
    assert.equal((await storage.listEntries({ origins: ["all"], includeArchived: true })).entries.length, 1);
    const restored = await storage.archiveEntry(archived.entry!.id, false, { expectedRevision: archived.revision, now: new Date("2026-08-21T00:00:00.000Z") });
    assert.equal(restored.archived, false);
    assert.equal(restored.entry?.archivedAt, undefined);
    assert.notEqual(restored.entry?.id, created.entry!.id);
    assert.equal(restored.entry?.originalId, undefined);
    assert.equal((await storage.listEntries({ origins: ["all"] })).entries.length, 1);
  });
}

async function testTemporaryMemoryExpiry(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const now = new Date("2026-08-31T00:00:00.000Z");
    let revision = 0;
    const write = async (title: string, createdAt: string, extras: Partial<MemoryEntryInput> = {}): Promise<MemoryEntry> => {
      const result = await memory.writeEntry({
        ...projectEntry(title, `${title} contains a temporary fact used to verify expiration semantics.`),
        durability: "temporary",
        ...extras
      }, { expectedRevision: revision, now: new Date(createdAt) });
      revision = result.revision;
      assert.ok(result.entry);
      return result.entry;
    };

    const ttlBoundary = await write("TTL boundary", "2026-08-01T00:00:00.000Z");
    const ttlExpired = await write("TTL expired", "2026-07-31T00:00:00.000Z");
    const futureExpiry = await write("Future expiry", "2026-07-31T00:00:00.000Z", { expiresAt: "2026-09-01T00:00:00.000Z" });
    const recalled = await write("Recalled temporary", "2026-07-31T00:00:00.000Z");
    const pastExpiry = await write("Past expiry", "2026-08-30T00:00:00.000Z", { expiresAt: "2026-08-30T23:59:59.000Z" });
    const equalExpiry = await write("Equal expiry", "2026-08-30T00:00:00.000Z", { expiresAt: now.toISOString() });
    await memory.recordRecallUsage([recalled.id], { now: new Date("2026-08-30T12:00:00.000Z") });

    const preview = await memory.previewMaintenance({ now, useLlm: false });
    assert.equal(preview.temporaryToArchive, 3);

    const result = await memory.runMemoryMaintenance({
      now,
      useLlm: false
    });
    assert.equal(result.failed, 0);
    const active = (await memory.listMemoryEntries({ origins: ["current_workspace"] })).entries;
    assert.deepEqual(new Set(active.map((entry) => entry.id)), new Set([ttlBoundary.id, recalled.id, equalExpiry.id]));
    const archived = (await memory.listArchivedEntries()).entries;
    assert.deepEqual(new Set(archived.map((entry) => entry.originalId)), new Set([ttlExpired.id, futureExpiry.id, pastExpiry.id]));
    const retentionBoundary = new Date("2026-09-30T00:00:00.000Z");
    assert.equal((await memory.previewMaintenance({ now: retentionBoundary, useLlm: false })).archivedToDelete, 0);
    await memory.runMemoryMaintenance({ now: retentionBoundary, useLlm: false });
    const boundaryArchive = (await memory.listArchivedEntries()).entries;
    for (const entry of archived) {
      assert.ok(boundaryArchive.some((remaining) => remaining.id === entry.id));
    }
    const later = new Date(retentionBoundary.getTime() + 1);
    assert.equal((await memory.previewMaintenance({ now: later, useLlm: false })).archivedToDelete, 3);
    const cleanup = await memory.runMemoryMaintenance({ now: later, useLlm: false });
    assert.equal(cleanup.failed, 0);
    const remainingArchive = (await memory.listArchivedEntries()).entries;
    for (const entry of archived) {
      assert.equal(remainingArchive.some((remaining) => remaining.id === entry.id), false);
    }
  });
}

async function testSleepUserNamespaceCollision(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const summary = "Keep release credentials isolated between different users.";
    const first = await memory.writeEntry(projectEntry("Anonymous preference", summary), { expectedRevision: 0 });
    const second = await memory.writeEntry({
      ...projectEntry("Named preference", summary),
      audience: "universal",
      kind: "preference",
      lineage: { source: "explicit", externalContext: false, userEvidence: summary },
      userId: "__default_user__"
    }, { expectedRevision: first.revision });
    assert.ok(first.entry && second.entry);
    const sink = {
      indexEntry: async () => undefined,
      findSimilarPairs: async () => ({
        examined: 2,
        pairs: [{ leftId: first.entry!.id, rightId: second.entry!.id, similarity: 1 }]
      })
    };
    const preview = await memory.previewMaintenance({ dedupAcrossUserIds: false, useLlm: false }, sink);
    assert.deepEqual(preview.archiveProposed, []);
    await memory.runMemoryMaintenance({ dedupAcrossUserIds: false, useLlm: false }, sink);
    assert.equal((await memory.listMemoryEntries({ origins: ["all"] })).entries.length, 2);
    const crossUserPreview = await memory.previewMaintenance({ dedupAcrossUserIds: true, useLlm: false }, sink);
    assert.deepEqual(crossUserPreview.archiveProposed?.map((entry) => entry.reason), ["exact_dup"]);
    memory.close();
  });
}

async function testSleepSimilarityUsesUserNamespaces(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const entries: MemoryEntry[] = [];
    let revision = 0;
    for (const [userId, title, summary] of [
      ["user-a", "A release rule", "User A keeps a deterministic release rule."],
      ["user-a", "A release note", "User A keeps a deterministic release note."],
      ["user-b", "B release rule", "User B keeps a deterministic release rule."],
      ["user-b", "B release note", "User B keeps a deterministic release note."]
    ]) {
      const result = await memory.writeEntry({ ...projectEntry(title, summary), userId }, { expectedRevision: revision });
      assert.ok(result.entry);
      entries.push(result.entry);
      revision = result.revision;
    }
    const calls: string[][] = [];
    const result = await memory.runMemoryMaintenance({ useLlm: false }, {
      indexEntry: async () => undefined,
      findSimilarPairs: async (namespace) => {
        calls.push(namespace.map((entry) => entry.userId ?? "<default>"));
        const first = namespace[0]!;
        const second = namespace[1]!;
        return { examined: namespace.length, pairs: [{ leftId: first.id, rightId: second.id, similarity: 0.99 }] };
      }
    });
    assert.equal(result.failed, 0);
    assert.equal(result.processed, 2);
    assert.equal(memory.maintenanceStatus().lastRun?.examined, entries.length);
    assert.deepEqual(calls.sort((left, right) => left[0]!.localeCompare(right[0]!)), [
      ["user-a", "user-a"],
      ["user-b", "user-b"]
    ]);
    assert.equal((await memory.listMemoryEntries({ origins: ["all"] })).entries.length, 2);
    memory.close();
  });
}

async function testSleepBridgesCurrentWorkspaceAndUser(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const summary = "The user prefers deterministic release checks before publishing changes.";
    const workspace = await memory.writeEntry({
      ...projectEntry("Release preference", summary),
      durability: "temporary",
      expiresAt: "2020-01-01T00:00:00.000Z",
      userId: "release-user"
    }, { expectedRevision: 0 });
    const universal = await memory.writeEntry({
      ...projectEntry("Release preference", summary),
      audience: "universal",
      userId: "release-user",
      kind: "preference",
      lineage: {
        source: "explicit",
        externalContext: false,
        userEvidence: "I prefer deterministic release checks before publishing."
      }
    }, { expectedRevision: workspace.revision });
    assert.ok(workspace.entry && universal.entry);

    const beforePreview = await memory.listMemoryEntries({ origins: ["all"] });
    const preview = await memory.previewMaintenance({ useLlm: false });
    assert.equal(preview.skipped, undefined);
    assert.deepEqual(preview.archiveProposed?.map((item) => item.reason), ["exact_dup", "expired"]);
    assert.deepEqual(await memory.listMemoryEntries({ origins: ["all"] }), beforePreview);

    const result = await memory.runMemoryMaintenance({ useLlm: false });
    assert.equal(result.failed, 0);
    assert.equal((await memory.listMemoryEntries({ origins: ["all"] })).entries.length, 1);
    const archived = (await memory.listArchivedEntries()).entries;
    assert.equal(archived.length, 1);
    assert.equal(archived[0]?.origin.kind, "workspace");
    assert.equal(archived[0]?.archivedReason, "exact_dup");
    assert.equal(archived[0]?.mergedInto, universal.entry.id);
  });
}

async function testSleepDoesNotCrossWorkspaceDedup(): Promise<void> {
  await withSharedAgent(async (_agentRoot) => {
    const workspaceA = await mkdtemp(path.join(os.tmpdir(), "biny-memory-sleep-a-"));
    const workspaceB = await mkdtemp(path.join(os.tmpdir(), "biny-memory-sleep-b-"));
    const memoryA = new LocalMemory(workspaceA, unusedModel);
    const memoryB = new LocalMemory(workspaceB, unusedModel);
    try {
      const summary = "Keep workspace-specific release checks isolated from other workspaces.";
      const first = await memoryA.writeEntry(projectEntry("Workspace A rule", summary), { expectedRevision: 0 });
      const second = await memoryB.writeEntry(projectEntry("Workspace B rule", summary), { expectedRevision: first.revision });
      assert.ok(first.entry && second.entry);
      const result = await memoryA.runMemoryMaintenance({ useLlm: false });
      assert.equal(result.failed, 0);
      assert.equal(result.processed, 0);
      assert.equal((await memoryA.listMemoryEntries({ origins: ["all"] })).entries.filter((entry) => entry.archivedAt === undefined).length, 2);
      assert.equal((await memoryA.listArchivedEntries()).entries.length, 0);
    } finally {
      memoryA.close();
      memoryB.close();
      await rm(workspaceA, { recursive: true, force: true });
      await rm(workspaceB, { recursive: true, force: true });
    }
  });
}

async function testSleepSimilarityBoundaries(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const prompts: string[] = [];
    const model = jsonMemoryModel((prompt) => {
      const ids = memoryClusterIds(prompt);
      return ids.length === 3
        ? JSON.stringify({ delete: [], synthesize: [] })
        : JSON.stringify({ delete: [ids[0]], synthesize: [] });
    }, prompts);
    const memory = new LocalMemory(workspaceRoot, () => model);
    let revision = 0;
    const write = async (title: string, summary: string, extras: Partial<MemoryEntryInput> = {}): Promise<MemoryEntry> => {
      const result = await memory.writeEntry({ ...projectEntry(title, summary), ...extras }, { expectedRevision: revision });
      revision = result.revision;
      assert.ok(result.entry);
      return result.entry;
    };

    const permanent = await write("Permanent rule", "The permanent rule is the durable source for this similar fact.", { importance: 1 });
    const temporary = await write("Temporary rule", "The temporary rule repeats the durable source with extra detail.", { durability: "temporary", importance: 5 });
    const chainA = await write("Chain A", "The first chain memory describes the same release operation.");
    const chainB = await write("Chain B", "The middle chain memory describes the same release operation.");
    const chainC = await write("Chain C", "The last chain memory describes the same release operation.");
    const pairA = await write("Pair A", "The first pair memory describes a repeated deployment operation.");
    const pairB = await write("Pair B", "The second pair memory describes a repeated deployment operation.");

    const result = await memory.runMemoryMaintenance({ now: new Date("2026-08-31T00:00:00.000Z") }, {
      indexEntry: async () => undefined,
      requestRebuild: () => undefined,
      findSimilarPairs: async () => ({ examined: 7, pairs: [
        { leftId: permanent.id, rightId: temporary.id, similarity: 0.95 },
        { leftId: chainA.id, rightId: chainB.id, similarity: 0.8 },
        { leftId: chainB.id, rightId: chainC.id, similarity: 0.8 },
        { leftId: pairA.id, rightId: pairB.id, similarity: 0.8 }
      ] })
    });
    assert.equal(result.failed, 0);
    assert.equal(prompts.length, 2, "0.95 must be deterministic; the chain must reach one LLM cluster");
    const active = (await memory.listMemoryEntries({ origins: ["current_workspace"] })).entries;
    assert.equal(active.some((entry) => entry.id === permanent.id), true, "permanent memory wins survivor selection");
    assert.equal(active.some((entry) => entry.id === temporary.id), false);
    assert.equal(active.filter((entry) => [chainA.id, chainB.id, chainC.id].includes(entry.id)).length, 3);
    const activePair = active.find((entry) => [pairA.id, pairB.id].includes(entry.id));
    assert.ok(activePair);
    const archived = (await memory.listArchivedEntries()).entries;
    const similarityArchived = archived.find((entry) => entry.originalId === temporary.id);
    assert.equal(similarityArchived?.archivedReason, "similarity_merge");
    assert.ok(similarityArchived?.archivedBy?.startsWith(result.startedAt + "-"));
    assert.equal(similarityArchived?.mergedInto, permanent.id);
    const llmArchived = archived.find((entry) => [pairA.id, pairB.id].includes(entry.originalId ?? ""));
    assert.equal(llmArchived?.archivedReason, "llm_merge");
    assert.equal(llmArchived?.mergedInto, activePair.id);
  });
}

async function testSleepWeightedSurvivor(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const storage = new MemoryStorage(workspaceRoot);
    try {
      const timestamp = "2026-08-01T00:00:00.000Z";
      const first = await storage.writeEntry({
        ...projectEntry("Frequently used", "A frequently accessed source describes the release workflow."),
        importance: 0.1,
        accessCount: 500
      }, { expectedRevision: 0, now: new Date(timestamp) });
      const second = await storage.writeEntry({
        ...projectEntry("More important", "A more important source describes related release workflow details."),
        importance: 0.7,
        accessCount: 0
      }, { expectedRevision: first.revision, now: new Date(timestamp) });
      assert.ok(first.entry && second.entry);
      const index = {
        indexEntry: async () => undefined,
        requestRebuild: () => undefined,
        findSimilarPairs: async () => ({ examined: 2, pairs: [{ leftId: first.entry!.id, rightId: second.entry!.id, similarity: 0.99 }] })
      };
      const preview = await memory.previewMaintenance({ useLlm: false }, index);
      assert.deepEqual(preview.archiveProposed, [{ id: first.entry.id, content: "A frequently accessed source describes the release workflow.", reason: "similarity_merge", mergedInto: second.entry.id }]);
      const result = await memory.runMemoryMaintenance({ useLlm: false }, index);
      assert.equal(result.failed, 0);
      assert.deepEqual((await memory.listMemoryEntries({ origins: ["all"] })).entries.map((entry) => entry.id), [second.entry.id]);
    } finally {
      memory.close();
      storage.close();
    }
  });
}

async function testSleepBatchOrdering(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const seen: string[][] = [];
    let cancelRequest: AbortController | undefined;
    let response: "retain" | "synthesize" | "delete" | "first-fails" = "retain";
    const memory = new LocalMemory(workspaceRoot, () => jsonMemoryModel((prompt) => {
      const batch = memoryClusterIds(prompt);
      seen.push(batch);
      if (cancelRequest) {
        cancelRequest.abort();
        throw new Error("request interrupted");
      }
      if (response === "first-fails") {
        if (seen.length === 1) throw new Error("first batch model request failed");
        return JSON.stringify({ delete: [batch[0]], synthesize: [] });
      }
      if (response === "delete") return JSON.stringify({ delete: [batch[0]], synthesize: [] });
      if (response === "synthesize") return JSON.stringify({
        delete: seen.length === 1 ? [] : [batch[0]],
        synthesize: Array.from({ length: seen.length === 1 ? 2 : 1 }, (_, index) => ({
          content: `Synthesized fact ${seen.length}-${index} preserves related source information.`,
          durability: "permanent"
        }))
      });
      return '{"delete":[],"synthesize":[]}';
    }));
    try {
      const entries: MemoryEntry[] = [];
      let revision = 0;
      for (let index = 0; index < 4; index += 1) {
        const result = await memory.writeEntry(projectEntry(`Ordered ${index}`, `Distinct chronological fact number ${index} describing the deployment process.`), {
          expectedRevision: revision,
          now: new Date(`2026-08-0${index + 1}T00:00:00.000Z`)
        });
        assert.ok(result.entry);
        entries.push(result.entry);
        revision = result.revision;
      }
      const ids = entries.map((entry) => entry.id);
      const index = {
        indexEntry: async () => undefined,
        requestRebuild: () => undefined,
        findSimilarPairs: async () => ({ examined: 4, pairs: [
          { leftId: ids[1]!, rightId: ids[0]!, similarity: 0.8 },
          { leftId: ids[0]!, rightId: ids[2]!, similarity: 0.8 },
          { leftId: ids[2]!, rightId: ids[3]!, similarity: 0.8 }
        ] })
      };
      for (const batchSize of [4, 2]) {
        const expected = batchSize === 4 ? [[ids[1], ids[0], ids[2], ids[3]]] : [[ids[3], ids[2]], [ids[1], ids[0]]];
        seen.length = 0;
        await memory.previewMaintenance({ llmBatchSize: batchSize }, index);
        assert.deepEqual(seen, expected);
        seen.length = 0;
        const result = await memory.runMemoryMaintenance({ llmBatchSize: batchSize }, index);
        assert.equal(result.failed, 0);
        assert.deepEqual(seen, expected);
      }
      const before = await memory.listMemoryEntries({ origins: ["all"] });
      response = "synthesize";
      seen.length = 0;
      const combined = await memory.previewMaintenance({ llmBatchSize: 2 }, index);
      assert.deepEqual(combined.synthesisProposed?.map((item) => item.sourceIds), [
        [ids[3], ids[2]], [ids[3], ids[2]], [ids[1]]
      ]);
      assert.deepEqual(combined.archiveProposed, [{
        id: ids[1], content: entries[1]!.summary, reason: "llm_merge", mergedInto: "preview-3"
      }]);
      seen.length = 0;
      assert.deepEqual(await memory.previewMaintenance({ llmBatchSize: 2 }, index), combined);
      response = "delete";
      seen.length = 0;
      const deletion = await memory.previewMaintenance({ llmBatchSize: 2 }, index);
      assert.deepEqual(deletion.synthesisProposed, []);
      assert.deepEqual(deletion.archiveProposed, [
        { id: ids[3], content: entries[3]!.summary, reason: "llm_merge", mergedInto: ids[2] },
        { id: ids[1], content: entries[1]!.summary, reason: "llm_merge", mergedInto: ids[0] }
      ]);
      assert.deepEqual(await memory.listMemoryEntries({ origins: ["all"] }), before);
      response = "first-fails";
      cancelRequest = new AbortController();
      seen.length = 0;
      const cancelled = await memory.previewMaintenance({ llmBatchSize: 2, signal: cancelRequest.signal }, index);
      assert.equal(seen.length, 1);
      assert.equal(cancelled.skipped, "Cancelled by user");
      assert.deepEqual(cancelled.archiveProposed, []);
      assert.deepEqual(await memory.listMemoryEntries({ origins: ["all"] }), before);
      cancelRequest = undefined;
      seen.length = 0;
      const partial = await memory.previewMaintenance({ llmBatchSize: 2 }, index);
      assert.equal(seen.length, 2);
      assert.equal(partial.skipped, undefined);
      assert.deepEqual(partial.archiveProposed, [
        { id: ids[1], content: entries[1]!.summary, reason: "llm_merge", mergedInto: ids[0] }
      ]);
      assert.deepEqual(await memory.listMemoryEntries({ origins: ["all"] }), before);
      seen.length = 0;
      const continued = await memory.runMemoryMaintenance({ llmBatchSize: 2 }, index);
      assert.equal(seen.length, 2);
      assert.equal(continued.failed, 0);
      assert.deepEqual(new Set((await memory.listMemoryEntries({ origins: ["all"] })).entries.map((entry) => entry.id)), new Set([ids[3], ids[2], ids[0]]));
    } finally {
      memory.close();
    }
  });
}

async function testSleepPreviewDoesNotMutate(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    let deletedId = "";
    const prompts: string[] = [];
    const model = jsonMemoryModel(() => `Consolidation result:\n${JSON.stringify({ delete: [deletedId, "outside-cluster"], synthesize: [{ content: "A combined durable explanation of both related project facts.", durability: "permanent" }] })}\nEnd of result.`, prompts);
    const memory = new LocalMemory(workspaceRoot, () => model);
    const storage = new MemoryStorage(workspaceRoot);
    try {
      const first = await memory.writeEntry(projectEntry("Preview first", "The first durable source fact for the preview-only cluster."), { expectedRevision: 0 });
      const second = await memory.writeEntry(projectEntry("Preview second", "The second durable source fact for the preview-only cluster."), { expectedRevision: first.revision });
      assert.ok(first.entry && second.entry);
      deletedId = first.entry.id;
      const before = await storage.listEntries({ origins: ["all"], includeArchived: true });
      const status = await storage.readMaintenanceStatus();
      const disabled = await memory.previewMaintenance({ sleepEnabled: false }, {
        findSimilarPairs: async () => { throw new Error("disabled preview must not query embeddings"); }
      });
      assert.equal(disabled.skipped, "Sleep is disabled in settings.");
      assert.deepEqual(disabled.archiveProposed, []);
      assert.deepEqual(disabled.synthesisProposed, []);
      assert.equal(prompts.length, 0);
      assert.deepEqual(await storage.listEntries({ origins: ["all"], includeArchived: true }), before);
      assert.deepEqual(await storage.readMaintenanceStatus(), status);
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const running = memory.runMemoryMaintenance({ useLlm: false }, {
        findSimilarPairs: async () => { await pending; return ({ examined: 0, pairs: [] }); }
      });
      try {
        for (const sleepEnabled of [true, false]) {
          const deferred = await memory.previewMaintenance({ sleepEnabled }, {
            findSimilarPairs: async () => { throw new Error("must not start concurrent preview"); }
          });
          assert.equal(deferred.skipped, "A real sleep cycle is currently running; preview deferred.");
          assert.deepEqual(deferred.archiveProposed, []);
          assert.deepEqual(deferred.synthesisProposed, []);
        }
      } finally {
        release();
        await running;
      }
      const completedStatus = await storage.readMaintenanceStatus();
      let releasePreview!: () => void;
      const previewReady = new Promise<void>((resolve) => { releasePreview = resolve; });
      const pendingPreview = memory.previewMaintenance({ useLlm: false }, {
        findSimilarPairs: async () => { await previewReady; return ({ examined: 0, pairs: [] }); }
      });
      try {
        assert.equal((await memory.previewMaintenance()).skipped, "A real sleep cycle is currently running; preview deferred.");
        await assert.rejects(memory.runMemoryMaintenance(), /Sleep already in progress/);
        assert.equal(memory.cancelMaintenance(), true);
      } finally {
        releasePreview();
      }
      assert.equal((await pendingPreview).skipped, "Cancelled by user");
      assert.equal(memory.cancelMaintenance(), false);
      assert.deepEqual(await storage.readMaintenanceStatus(), completedStatus);
      const preview = await memory.previewMaintenance({}, {
        findSimilarPairs: async () => ({ examined: 2, pairs: [{ leftId: first.entry!.id, rightId: second.entry!.id, similarity: 0.8 }] })
      });
      assert.deepEqual(preview.archiveProposed, [{ id: first.entry.id, content: first.entry.summary, reason: "llm_merge", mergedInto: "preview-1" }]);
      assert.equal(preview.synthesisProposed?.length, 1);
      assert.deepEqual(preview.synthesisProposed?.[0]?.sourceIds, [first.entry.id]);
      const promptPrefix = "Cluster of related memories:\n";
      assert.ok(prompts[0]?.startsWith(promptPrefix));
      assert.deepEqual(prompts[0]!.slice(promptPrefix.length).split("\n").sort(), [first.entry, second.entry].map((entry) => `- id: "${entry.id}", content: "${entry.summary}"`).sort());
      const deterministic = await memory.previewMaintenance({ useLlm: false }, {
        findSimilarPairs: async () => ({ examined: 2, pairs: [{ leftId: first.entry!.id, rightId: second.entry!.id, similarity: 0.98 }] })
      });
      assert.equal(deterministic.archiveProposed?.length, 1);
      assert.equal(deterministic.archiveProposed?.[0]?.reason, "similarity_merge");
      assert.deepEqual(await storage.listEntries({ origins: ["all"], includeArchived: true }), before);
      assert.deepEqual(await storage.readMaintenanceStatus(), completedStatus);
    } finally {
      storage.close();
      memory.close();
    }
  });
}

async function testSleepSynthesisArchivesCluster(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const model = jsonMemoryModel(() => JSON.stringify({
      delete: [],
      synthesize: [{
        content: "The synthesized memory preserves both source facts and is now the single active representation.",
        durability: "permanent"
      }]
    }));
    const memory = new LocalMemory(workspaceRoot, () => model);
    let revision = 0;
    const first = await memory.writeEntry({ ...projectEntry("Synthesis A", "The first source fact is part of the synthesized memory cluster."), durability: "temporary", accessCount: 7, importance: 5, tags: ["first", "shared"], threadId: "T_A", messageId: "M_A" }, { expectedRevision: revision });
    revision = first.revision;
    const second = await memory.writeEntry({ ...projectEntry("Synthesis B", "The second source fact is part of the synthesized memory cluster."), accessCount: 3, importance: 1, tags: ["shared", "second"], metadata: { activityDerived: true }, threadId: "T_B", messageId: "M_B" }, { expectedRevision: revision });
    revision = second.revision;
    assert.ok(first.entry && second.entry);
    const preparation = { calls: 0, commits: 0 };
    for (const unavailable of [true, false]) {
      const result = await memory.runMemoryMaintenance({}, {
        prepareSynthesis: async () => {
          if (unavailable) return undefined;
          throw new Error("Embedding generation failed");
        },
        indexEntry: async () => undefined,
        findSimilarPairs: async () => ({ examined: 2, pairs: [{ leftId: first.entry!.id, rightId: second.entry!.id, similarity: 0.8 }] })
      });
      assert.equal(result.written, 0);
      assert.equal((await memory.listArchivedEntries()).entries.length, 0);
      assert.equal(result.failed, 0);
      assert.equal((await memory.listMemoryEntries({ origins: ["all"] })).entries.length, 2);
    }
    await memory.runMemoryMaintenance({}, {
      prepareSynthesis: async (content) => {
        preparation.calls += 1;
        assert.equal((await memory.listMemoryEntries({ origins: ["all"] })).entries.length, 2);
        return (entry) => {
          preparation.commits += 1;
          assert.equal(entry.summary, content);
        };
      },
      indexEntry: async () => undefined,
      requestRebuild: () => undefined,
      findSimilarPairs: async () => ({ examined: 2, pairs: [{ leftId: first.entry!.id, rightId: second.entry!.id, similarity: 0.8 }] })
    });

    const active = (await memory.listMemoryEntries({ origins: ["current_workspace"] })).entries;
    assert.equal(active.length, 3);
    assert.deepEqual(preparation, { calls: 1, commits: 1 });
    const synthesis = active.find((entry) => entry.lineage.at(-1)?.source === "sleep");
    assert.ok(synthesis);
    assert.equal(synthesis.source, "auto");
    assert.equal(synthesis.accessCount, 7);
    assert.equal(synthesis.importance, 1);
    assert.equal(synthesis.threadId, "T_B");
    assert.equal(synthesis.messageId, "M_B");
    assert.deepEqual(synthesis.tags, ["sleep-merged", "first", "shared", "second"]);
    assert.equal(synthesis.metadata?.activityDerived, true, "混合来源的合并必须保留 Activity 标记");
    assert.deepEqual(new Set(synthesis.lineage.at(-1)?.sourceEntryIds), new Set([first.entry!.id, second.entry!.id]));
    const archived = (await memory.listArchivedEntries()).entries;
    assert.equal(archived.length, 0, "synthesis without delete keeps the old cluster active");
    const database = new DatabaseSync(path.join(agentRoot, "memory", memoryDatabaseFileName), { readOnly: true });
    try {
      const row = database.prepare("SELECT metadata FROM memories WHERE id = ?").get(synthesis.id) as { metadata?: string } | undefined;
      assert.match(row?.metadata ?? "", /"source":"auto"/u);
      assert.equal(JSON.parse(row!.metadata!).accessCount, 7);
    } finally {
      database.close();
    }
  });
}

async function testSleepSynthesisFailureArchivesDeletedIds(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    let ids: string[] = [];
    const model = jsonMemoryModel(() => JSON.stringify({
      delete: ids,
      synthesize: [{
        content: "This synthesis cannot be inserted when its embedding generation fails.",
        durability: "permanent"
      }]
    }));
    const memory = new LocalMemory(workspaceRoot, () => model);
    try {
      const first = await memory.writeEntry(projectEntry(
        "Failed synthesis A",
        "The first source fact belongs to a cluster whose synthesis will fail."
      ), { expectedRevision: 0 });
      const second = await memory.writeEntry(projectEntry(
        "Failed synthesis B",
        "The second source fact belongs to a cluster whose synthesis will fail."
      ), { expectedRevision: first.revision });
      assert.ok(first.entry && second.entry);
      ids = [first.entry.id, second.entry.id];

      const result = await memory.runMemoryMaintenance({}, {
        prepareSynthesis: async () => { throw new Error("embedding generation failed"); },
        indexEntry: async () => undefined,
        findSimilarPairs: async () => ({ examined: 2, pairs: [{ leftId: first.entry!.id, rightId: second.entry!.id, similarity: 0.8 }] })
      });
      assert.equal(result.failed, 0);
      assert.equal(result.written, 0);
      assert.equal(result.processed, 2);
      assert.equal((await memory.listMemoryEntries({ origins: ["all"] })).entries.length, 0);
      const archived = await memory.listArchivedEntries();
      assert.equal(archived.entries.length, 2);
      assert.ok(archived.entries.every((entry) => entry.archivedReason === "llm_merge" && entry.mergedInto === undefined));
    } finally {
      memory.close();
    }
  });
}

async function testSleepInvalidDeleteIsSafe(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const model = jsonMemoryModel((prompt) => {
      const ids = memoryClusterIds(prompt);
      return JSON.stringify({ delete: ["not-a-cluster-entry", ids[0]], synthesize: [] });
    });
    const memory = new LocalMemory(workspaceRoot, () => model);
    const first = await memory.writeEntry(projectEntry("Invalid delete A", "The first source fact must remain after an invalid model response."), { expectedRevision: 0 });
    const second = await memory.writeEntry(projectEntry("Invalid delete B", "The second source fact must remain after an invalid model response."), { expectedRevision: first.revision });
    assert.ok(first.entry && second.entry);
    const result = await memory.runMemoryMaintenance({}, {
      indexEntry: async () => undefined,
      requestRebuild: () => undefined,
      findSimilarPairs: async () => ({ examined: 2, pairs: [{ leftId: first.entry!.id, rightId: second.entry!.id, similarity: 0.8 }] })
    });
    assert.equal(result.failed, 0);
    assert.equal((await memory.listMemoryEntries({ origins: ["current_workspace"] })).entries.length, 1);
    assert.equal((await memory.listArchivedEntries()).entries.length, 1);
  });
}

async function testSingleRootSafetyBoundary(): Promise<void> {
  const agentRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-v3-agent-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-v3-workspace-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "biny-memory-v3-outside-"));
  const previous = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = agentRoot;
  try {
    await fs.symlink(outside, path.join(agentRoot, "memory"), "dir");
    await assert.rejects(new LocalMemory(workspaceRoot, unusedModel).writeEntry(projectEntry(
      "Unsafe root",
      "This entry must never be written through a symbolic memory root."
    ), { expectedRevision: 0 }), /real directory, not a symbolic link/u);
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    restoreAgentRoot(previous);
    await rm(agentRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

async function testEmbeddingStatusDoesNotCreateIndex(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const memoryRoot = path.join(agentRoot, "memory");
    const databasePath = path.join(memoryRoot, memoryDatabaseFileName);
    const service = new MemoryEmbeddingService({
      localMemory: new LocalMemory(workspaceRoot, unusedModel),
      localManager: { list: async () => [] } as unknown as LocalEmbeddingManager,
      getVectorIndex: () => { throw new Error("status must not open a writable vector index"); },
      getReadOnlyVectorIndex: () => MemoryVectorIndex.openReadOnly(memoryRoot),
      getActiveModel: () => undefined,
      getProviderModels: () => [],
      getRuntime: async () => undefined
    });
    const status = await service.status();
    assert.equal(status.index.active, undefined);
    assert.equal(status.pendingEntries, 0);
    await assert.rejects(fs.access(databasePath), /ENOENT/u, "读取状态不能创建空向量索引");
  });
}

async function testEmbeddingStatusReadsSelfReflectionMemory(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const storage = new MemoryStorage(workspaceRoot);
    await storage.writeEntry({
      ...projectEntry(
        "Self-reflection memory",
        "A self-reflection entry must remain readable by the embedding status path."
      ),
      lineage: { source: "self_reflection", externalContext: false }
    }, { expectedRevision: 0 });
    const service = new MemoryEmbeddingService({
      localMemory: new LocalMemory(workspaceRoot, unusedModel),
      localManager: { list: async () => [] } as unknown as LocalEmbeddingManager,
      getVectorIndex: () => { throw new Error("status must not open a writable vector index"); },
      getReadOnlyVectorIndex: () => undefined,
      getActiveModel: () => undefined,
      getProviderModels: () => [],
      getRuntime: async () => undefined
    });
    const status = await service.status();
    assert.equal(status.totalEntries, 1);
    assert.equal(status.pendingEntries, 1);
  });
}

async function testSemanticSearchTreatsUnbuiltIndexAsEmptyCandidates(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const created = await memory.writeEntry(projectEntry(
      "Unbuilt semantic memory",
      "An existing fact may temporarily have no vector while the semantic index is being built."
    ), { expectedRevision: 0 });
    assert.ok(created.entry);
    const ref = { kind: "provider", provider: "test", model: "embedding" } as const;
    const descriptor: EmbeddingModelDescriptor = {
      ref,
      fingerprint: "sha256:unbuilt-index-test",
      displayName: "Unbuilt index test",
      dimensions: 3,
      recommendedThresholds: { currentWorkspace: 0.8, crossWorkspace: 0.86 },
      source: "provider"
    };
    let embeddingCalls = 0;
    const runtime: EmbeddingModelRuntime = {
      descriptor,
      fingerprint: descriptor.fingerprint,
      embed: async ({ texts }) => {
        embeddingCalls += texts.length;
        return {
          embeddings: texts.map(() => new Float32Array([1, 0, 0])),
          dimensions: 3,
          fingerprint: descriptor.fingerprint,
          model: ref
        };
      }
    };
    const service = new MemoryEmbeddingService({
      localMemory: memory,
      localManager: { list: async () => [] } as unknown as LocalEmbeddingManager,
      getVectorIndex: () => { throw new Error("an unbuilt read must not create a writable index"); },
      getReadOnlyVectorIndex: () => undefined,
      getActiveModel: () => ref,
      getProviderModels: () => [descriptor],
      getRuntime: async () => runtime
    });
    const candidates = await service.findSimilarEntries(
      "find the existing semantic memory",
      [created.entry],
      5,
      0.3
    );
    assert.deepEqual(candidates, []);
    assert.deepEqual(await service.findSimilarPairs([created.entry], 0.75), { examined: 0, pairs: [] });
    assert.equal(embeddingCalls, 1, "the query still needs a semantic embedding before treating the index as empty");
  });
}

async function testFactsAndVectorsShareDatabase(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const storage = new MemoryStorage(workspaceRoot);
    const written = await storage.writeEntry(projectEntry(
      "Shared memory database",
      "Facts and their embedding projection must live in the same memory SQLite database."
    ), { expectedRevision: 0 });
    assert.ok(written.entry);

    const memoryRoot = path.join(agentRoot, "memory");
    const databasePath = path.join(memoryRoot, memoryDatabaseFileName);
    assert.equal(
      MemoryVectorIndex.openReadOnly(memoryRoot),
      undefined,
      "事实库已存在但向量表尚未初始化时，只读索引应按未建立处理"
    );
    const index = new MemoryVectorIndex(memoryRoot);
    assert.equal(index.databasePath, databasePath);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const tables = new Set((database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
      ).all() as Array<{ name?: unknown }>).map((row) => row.name));
      assert.equal(tables.has("memories"), true);
      assert.equal(tables.has("memory_archive"), true);
      assert.equal(tables.has("memory_embeddings"), true);
      assert.equal(tables.has("memory_vectors"), false);
      assert.equal(tables.has("memory_vector_generations"), false);
      assert.equal(tables.has("memory_vector_entry_states"), false);
      assert.equal(
        (database.prepare("SELECT COUNT(*) AS count FROM memories").get() as { count?: unknown }).count,
        1
      );
    } finally {
      database.close();
      index.close();
    }
    await assert.rejects(
      fs.access(path.join(memoryRoot, ".memory-index.sqlite")),
      /ENOENT/u,
      "不应再创建独立的向量 SQLite 文件"
    );
  });
}

async function testInitialEmbeddingGeneration(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const created = await memory.writeEntry(projectEntry(
      "Initial vector memory",
      "The first memory must be searchable immediately after its embedding is written."
    ), { expectedRevision: 0 });
    assert.ok(created.entry);

    const ref = { kind: "provider", provider: "test", model: "embedding" } as const;
    const descriptor: EmbeddingModelDescriptor = {
      ref,
      fingerprint: "sha256:initial-generation-test",
      displayName: "Initial generation test",
      dimensions: 3,
      recommendedThresholds: { currentWorkspace: 0.8, crossWorkspace: 0.86 },
      source: "provider"
    };
    let vector = new Float32Array([1, 0, 0]);
    const runtime: EmbeddingModelRuntime = {
      descriptor,
      fingerprint: descriptor.fingerprint,
      embed: async ({ texts }) => ({
        embeddings: texts.map(() => vector),
        dimensions: 3,
        fingerprint: descriptor.fingerprint,
        model: ref
      })
    };
    const service = new MemoryEmbeddingService({
      localMemory: memory,
      localManager: { list: async () => [] } as unknown as LocalEmbeddingManager,
      getVectorIndex: () => new MemoryVectorIndex(path.join(agentRoot, "memory")),
      getReadOnlyVectorIndex: () => MemoryVectorIndex.openReadOnly(path.join(agentRoot, "memory")),
      getActiveModel: () => ref,
      getProviderModels: () => [descriptor],
      getRuntime: async () => runtime
    });

    await service.indexEntry(created.entry);
    const status = await service.status();
    assert.equal(status.index.active?.modelFingerprint, descriptor.fingerprint);
    assert.equal(status.indexedEntries, 1);
    assert.equal(status.pendingEntries, 0);
    const matches = await service.findSimilarEntries("Find the first stored fact", [created.entry], 5, 0.3);
    assert.equal(matches?.length, 1);
    assert.equal(matches?.[0]?.accessCount, 0, "search returns the pre-access snapshot");
    await memory.recordRecallUsage([created.entry.id]);
    const accessed = (await memory.listMemoryEntries({ origins: ["all"] })).entries[0]!;
    assert.equal(accessed.accessCount, 1);
    assert.equal(accessed.lastAccessedAt, accessed.updatedAt);
    assert.equal(accessed.revision, created.entry.revision);
    await service.findSimilarEntries("Find no candidates", [], 5, 0.3);
    assert.equal((await memory.listMemoryEntries({ origins: ["all"] })).entries[0]?.accessCount, 1);
    const save = await service.prepareSynthesis(created.entry.summary);
    assert.ok(save);
    assert.throws(() => save({ ...created.entry!, summary: "Changed content" }), /changed after embedding/u);
    save(created.entry);
    const controller = new AbortController();
    const cancelled = await service.prepareSynthesis(created.entry.summary, controller.signal);
    assert.ok(cancelled);
    controller.abort(new Error("Cancelled after generation"));
    assert.throws(() => cancelled(created.entry!), /Cancelled after generation/u);
    await service.rebuild();
    assert.equal((await service.status()).indexedEntries, 1);
    assert.deepEqual(await service.findSimilarPairs([created.entry], 0.75), { examined: 1, pairs: [] });
    assert.deepEqual(await service.findSimilarPairs([{ ...created.entry, summary: "Outdated vector content" }], 0.75), { examined: 1, pairs: [] });
    const second = await memory.writeEntry(projectEntry("Separate vector", "A distinct topic with an orthogonal embedding."), {
      expectedRevision: created.revision
    });
    assert.ok(second.entry);
    const entries = [created.entry, second.entry];
    assert.deepEqual(await service.findSimilarPairs(entries, 0.75), { examined: 1, pairs: [] });
    vector = new Float32Array([0, 1, 0]);
    await service.indexEntry(second.entry);
    assert.deepEqual(await service.findSimilarPairs(entries, 0.75), { examined: 2, pairs: [] });
    const sink = {
      indexEntry: async () => undefined,
      findSimilarPairs: service.findSimilarPairs.bind(service)
    };
    assert.equal((await memory.previewMaintenance({ useLlm: false }, sink)).examined, 2);
    await memory.runMemoryMaintenance({ useLlm: false }, sink);
    assert.equal((await memory.loadMaintenanceStatus()).lastRun?.examined, 2);
    await memory.runMemoryMaintenance({ useLlm: false });
    assert.equal((await memory.loadMaintenanceStatus()).lastRun?.examined, 0);
    let revision = second.revision;
    for (let index = entries.length; index < 64; index += 1) {
      const result = await memory.writeEntry(projectEntry(`Scan entry ${index}`, `Independent scan fixture number ${index}.`), { expectedRevision: revision });
      assert.ok(result.entry);
      revision = result.revision;
      entries.push(result.entry);
      await service.indexEntry(result.entry);
    }
    const beforeScan = await memory.listMemoryEntries({ origins: ["all"] });
    const scanAbort = new AbortController();
    const abortHandle = setImmediate(() => scanAbort.abort(new Error("Cancel during vector scan")));
    try {
      await assert.rejects(service.findSimilarPairs(entries, 0.75, scanAbort.signal), /Cancel during vector scan/u);
    } finally {
      clearImmediate(abortHandle);
    }
    assert.deepEqual(await memory.listMemoryEntries({ origins: ["all"] }), beforeScan);
    assert.equal((await service.findSimilarPairs(entries, 0.75)).examined, 64);
    service.close();
    memory.close();
  });
}

async function testMemoryVectorProjectionLifecycle(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const ref = { kind: "provider", provider: "test", model: "projection-lifecycle" } as const;
    const descriptor: EmbeddingModelDescriptor = {
      ref,
      fingerprint: "sha256:projection-lifecycle",
      displayName: "Projection lifecycle test",
      dimensions: 3,
      recommendedThresholds: { currentWorkspace: 0.8, crossWorkspace: 0.86 },
      source: "provider"
    };
    const runtime: EmbeddingModelRuntime = {
      descriptor,
      fingerprint: descriptor.fingerprint,
      embed: async ({ texts }) => ({
        embeddings: texts.map(() => new Float32Array([1, 0, 0])),
        dimensions: 3,
        fingerprint: descriptor.fingerprint,
        model: ref
      })
    };
    const memoryRoot = path.join(agentRoot, "memory");
    const memory = new LocalMemory(
      workspaceRoot,
      unusedModel,
      undefined,
      3,
      undefined,
      undefined,
      {
        indexEntry: async (entry) => await service?.indexEntry(entry),
        removeEntries: (entryIds) => service?.removeEntries(entryIds)
      }
    );
    const service: MemoryEmbeddingService = new MemoryEmbeddingService({
      localMemory: memory,
      localManager: { list: async () => [] } as unknown as LocalEmbeddingManager,
      getVectorIndex: () => new MemoryVectorIndex(memoryRoot),
      getReadOnlyVectorIndex: () => MemoryVectorIndex.openReadOnly(memoryRoot),
      getActiveModel: () => ref,
      getProviderModels: () => [descriptor],
      getRuntime: async () => runtime
    });
    const database = (): DatabaseSync => {
      const opened = new DatabaseSync(path.join(memoryRoot, memoryDatabaseFileName), { allowExtension: true });
      loadSqliteVec(opened);
      return opened;
    };
    const projectionCount = (): number => {
      const opened = database();
      try {
        return Number((opened.prepare("SELECT COUNT(*) AS count FROM memory_embeddings").get() as { count?: unknown }).count ?? 0);
      } finally {
        opened.close();
      }
    };

    try {
      const created = await memory.writeEntry(projectEntry(
        "Projection lifecycle",
        "The compatibility vector projection follows the active memory entry lifecycle."
      ), { expectedRevision: 0 });
      assert.ok(created.entry);
      assert.equal(projectionCount(), 1, "首次事实写入应建立 vec0 投影");

      const archived = await memory.archiveEntry(created.entry.id, true, { expectedRevision: created.revision });
      assert.equal(archived.archived, true);
      assert.equal(projectionCount(), 0, "归档必须删除对应 vec0 向量");

      const restored = await memory.archiveEntry(archived.entry!.id, false, { expectedRevision: archived.revision });
      assert.equal(restored.archived, false);
      assert.equal(projectionCount(), 1, "恢复必须重新建立 vec0 向量");

      const deleted = await memory.deleteEntryById(restored.entry!.id, { expectedRevision: restored.revision });
      assert.equal(deleted.deleted, true);
      assert.equal(projectionCount(), 0, "删除必须删除对应 vec0 向量");

      const second = await memory.writeEntry(projectEntry(
        "Projection clear",
        "Clearing facts also clears their compatibility vector rows."
      ), { expectedRevision: deleted.revision });
      assert.ok(second.entry);
      assert.equal(projectionCount(), 1);
      const cleared = await memory.clearEntries("all", { expectedRevision: second.revision });
      assert.equal(cleared.deletedEntries, 1);
      assert.equal(projectionCount(), 0, "清空事实库不能留下孤立 vec0 向量");
    } finally {
      service.close();
      memory.close();
    }
  });
}

async function testLocalMemoryMutationKeepsIndexInSync(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const indexed: string[] = [];
    const removed: string[] = [];
    const memory = new LocalMemory(
      workspaceRoot,
      unusedModel,
      undefined,
      3,
      undefined,
      undefined,
      {
        indexEntry: async (entry) => { indexed.push(entry.id); },
        removeEntries: (entryIds) => { removed.push(...entryIds); }
      }
    );
    const created = await memory.writeEntry(projectEntry(
      "Mutation index sync",
      "Every public memory mutation must keep its derived vector index synchronized."
    ), { expectedRevision: 0 });
    assert.ok(created.entry);
    assert.deepEqual(indexed, [created.entry.id]);

    const updated = await memory.updateEntry(created.entry.id, { title: "Updated mutation index sync" }, {
      expectedRevision: created.revision
    });
    assert.equal(updated.written, true);
    assert.deepEqual(indexed, [created.entry.id, created.entry.id]);

    const archived = await memory.archiveEntry(created.entry.id, true, { expectedRevision: updated.revision });
    assert.equal(archived.archived, true);
    assert.deepEqual(removed, [created.entry.id, created.entry.id]);

    const archivedUpdate = await memory.updateEntry(archived.entry!.id, { title: "Edited archived mutation index sync" }, {
      expectedRevision: archived.revision
    });
    assert.equal(archivedUpdate.written, true);
    assert.deepEqual(indexed, [created.entry.id, created.entry.id]);
    assert.deepEqual(removed, [created.entry.id, created.entry.id], "编辑归档条目不能重新建立活动向量");

    const restored = await memory.archiveEntry(archivedUpdate.entry!.id, false, { expectedRevision: archivedUpdate.revision });
    assert.equal(restored.archived, false);
    assert.ok(restored.entry);
    assert.deepEqual(indexed, [created.entry.id, created.entry.id, restored.entry.id]);

    const deleted = await memory.deleteEntryById(restored.entry.id, { expectedRevision: restored.revision });
    assert.equal(deleted.deleted, true);
    assert.deepEqual(removed, [created.entry.id, created.entry.id, restored.entry.id]);

    const second = await memory.writeEntry(projectEntry(
      "Clear mutation index sync",
      "Clearing the memory library must remove every selected entry from the derived vector index too."
    ), { expectedRevision: deleted.revision });
    assert.ok(second.entry);
    assert.deepEqual(indexed, [created.entry.id, created.entry.id, restored.entry.id, second.entry.id]);
    const archivedSecond = await memory.archiveEntry(second.entry.id, true, { expectedRevision: second.revision });
    assert.equal(archivedSecond.archived, true);
    assert.deepEqual(removed, [created.entry.id, created.entry.id, restored.entry.id, second.entry.id]);
    const cleared = await memory.clearEntries("all", { expectedRevision: archivedSecond.revision });
    assert.equal(cleared.deletedEntries, 1);
    assert.deepEqual(removed, [created.entry.id, created.entry.id, restored.entry.id, second.entry.id, second.entry.id]);
  });
}

function projectEntry(title: string, summary: string): MemoryEntryInput {
  return {
    audience: "workspace",
    kind: "fact",
    topic: "project",
    title,
    summary,
    decisions: [],
    paths: [],
    keywords: [],
    importance: 3,
    lineage: { source: "explicit", externalContext: false }
  };
}

function jsonMemoryModel(response: (prompt: string) => string, prompts: string[] = []): AgentModel {
  return {
    provider: "test",
    modelId: "memory-sleep-test",
    async stream(context, options) {
      const prompt = context.messages.flatMap((message) => (
        typeof message.content === "string"
          ? [message.content]
          : message.content.flatMap((content) => content.type === "text" ? [content.text] : [])
      )).join("\n");
      if (prompt.includes("Cluster of related memories:")) {
        assert.equal(context.systemPrompt, sleepMergePrompt);
        assert.equal(context.messages.length, 1);
        assert.equal(context.messages[0]?.role, "user");
        assert.equal(options?.maxOutputTokens, undefined);
      }
      if (prompt.startsWith("Extract memories from this conversation:")) {
        assert.equal(context.systemPrompt, memoryExtractionPrompt);
        assert.equal(context.messages.length, 1);
        assert.equal(context.messages[0]?.role, "user");
        assert.equal(options?.maxOutputTokens, undefined);
        assert.equal(prompt.includes("Existing memories:"), false);
      }
      if (prompt.startsWith("Current date and time:")) {
        assert.equal(context.systemPrompt, temporaryMemoryCleanupPrompt);
        assert.equal(context.messages.length, 1);
        assert.equal(context.messages[0]?.role, "user");
        assert.equal(options?.maxOutputTokens, undefined);
      }
      if (prompt.startsWith("The user wants to delete memories about:")) {
        assert.equal(context.systemPrompt, undefined);
        assert.equal(context.messages.length, 1);
        assert.equal(context.messages[0]?.role, "user");
        assert.equal(options?.maxOutputTokens, undefined);
      }
      if (prompt.startsWith('New memory to add: "')) {
        assert.equal(context.systemPrompt, undefined);
        assert.equal(context.messages.length, 1);
        assert.equal(options?.maxOutputTokens, undefined);
        assert.ok(prompt.includes("Prefer keeping the store clean:"));
        assert.ok(prompt.includes("1. [permanent]"));
      }
      prompts.push(prompt);
      const text = response(prompt);
      return (async function* () {
        options?.signal?.throwIfAborted();
        yield { type: "text-delta" as const, text };
        yield { type: "finish" as const, reason: "stop" as const };
      })();
    }
  };
}

function memoryClusterIds(prompt: string): string[] {
  const cluster = prompt.slice(prompt.lastIndexOf("Cluster of related memories:"));
  return [...cluster.matchAll(/^- id: "([^"]+)", content: /gmu)].map((match) => match[1]!).filter(Boolean);
}


function unusedModel(): AgentModel {
  return {
    provider: "test",
    modelId: "unused",
    async stream() {
      return (async function* () { /* storage-only tests do not call the model */ })();
    }
  };
}

async function withIsolatedMemory(run: (workspaceRoot: string, agentRoot: string) => Promise<void>): Promise<void> {
  await withSharedAgent(async (agentRoot) => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-v3-workspace-"));
    try {
      await run(workspaceRoot, agentRoot);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
}

async function withSharedAgent(run: (agentRoot: string) => Promise<void>): Promise<void> {
  const agentRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-v3-agent-"));
  const previous = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = agentRoot;
  try {
    await run(agentRoot);
  } finally {
    restoreAgentRoot(previous);
    await rm(agentRoot, { recursive: true, force: true });
  }
}

function restoreAgentRoot(previous: string | undefined): void {
  if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
  else process.env[BINY_AGENT_DIR_ENV] = previous;
}

await main();
