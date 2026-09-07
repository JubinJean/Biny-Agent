import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { MemoryStorage, memoryDatabaseFileName } from "../src/agent/context/memoryStorage.js";
import { createStoredMemoryEntry } from "../src/agent/context/memoryFormat.js";
import type { AgentModel } from "../src/agent/core/types.js";
import type { MemoryEntryInput, MemoryMaintenanceStatus, MemorySleepRun } from "../src/agent/context/memoryTypes.js";

const unusedModel: AgentModel = {
  provider: "test",
  modelId: "unused",
  stream: async () => (async function* () {
    yield { type: "finish" as const, reason: "stop" as const };
  })()
};

const agentRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-lifecycle-agent-"));
const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-lifecycle-workspace-"));
const previous = process.env[BINY_AGENT_DIR_ENV];
process.env[BINY_AGENT_DIR_ENV] = agentRoot;

try {
  await testEntryFieldsAndAccessCount();
  await testOldMemoryDatabaseIsRejected();
  await testSleepRunPersistenceAndRecovery();
} finally {
  if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
  else process.env[BINY_AGENT_DIR_ENV] = previous;
  await rm(agentRoot, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
}

console.log("memory lifecycle tests passed");

async function testEntryFieldsAndAccessCount(): Promise<void> {
  const storage = new MemoryStorage(workspaceRoot);
  const input: MemoryEntryInput = {
    audience: "workspace",
    kind: "fact",
    topic: "release",
    title: "Release convention",
    summary: "The release process requires a deterministic verification step before publishing.",
    source: "auto",
    tags: ["release", "verification", "release", "", "  保留空白  ", ...Array.from({ length: 40 }, (_, index) => `${index}:${"标签".repeat(100)}`)],
    rationale: "  原始理由\n".repeat(300),
    activitySource: "activity_session",
    activitySessionId: "activity/source:001",
    metadata: { provenance: { frames: ["frame:1", "frame:2"], reviewed: false, extra: null }, source: "ignored", revision: 999, origin: { kind: "user" } },
    threadId: "thread-0001",
    messageId: "message-0001",
    userId: "user-0001",
    importance: 0.125,
    lineage: { source: "completed_task", externalContext: false, sessionId: "session-1" }
  };
  const first = await storage.writeEntry(input, { expectedRevision: 0 });
  assert.equal(first.written, true);
  assert.ok(first.entry);
  const fields = { id: "validation-entry", revision: 0, createdAt: "2026-09-05T12:00:00.000Z", updatedAt: "2026-09-05T12:00:00.000Z" };
  const directInput = { ...input, origin: first.entry.origin };
  for (const accessCount of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createStoredMemoryEntry({ ...directInput, accessCount }, fields), /non-negative safe integer/);
  }
  const sanitized = createStoredMemoryEntry({ ...directInput, accessCount: 7, summary: "  retained fact  ", tags: ["release", "release"] }, fields);
  assert.equal(sanitized.summary, "retained fact");
  assert.deepEqual(sanitized.tags, ["release", "release"]);
  const verbatimSource = "  source/".repeat(20);
  assert.equal(createStoredMemoryEntry({ ...directInput, source: verbatimSource }, fields).source, verbatimSource);
  assert.equal(createStoredMemoryEntry({ ...directInput, source: "", rationale: "" }, fields).source, "");
  assert.equal(createStoredMemoryEntry({ ...directInput, rationale: "" }, fields).rationale, "");
  assert.equal(sanitized.accessCount, 7);
  for (const importance of [0, 0.125, 0.7, 1, 4]) {
    assert.equal(createStoredMemoryEntry({ ...directInput, importance }, fields).importance, importance);
  }
  assert.equal(createStoredMemoryEntry({ ...directInput, importance: undefined }, fields).importance, 0.5);
  for (const metadata of [null, [], "invalid"]) {
    assert.throws(() => createStoredMemoryEntry({ ...directInput, metadata: metadata as unknown as Record<string, unknown> }, fields), /JSON object/);
  }
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(() => createStoredMemoryEntry({ ...directInput, metadata: circular }, fields), /circular/i);
  const duplicate = await storage.writeEntry(input, { expectedRevision: first.revision });
  assert.equal(duplicate.written, false);
  await storage.recordRecallUsage([first.entry!.id], { now: new Date("2026-09-05T12:00:00.000Z") });
  const entry = (await storage.listEntries({ origins: ["current_workspace"] })).entries[0];
  assert.equal(entry?.source, "auto");
  assert.equal(entry?.activitySource, "activity_session");
  assert.equal(entry?.activitySessionId, "activity/source:001");
  assert.deepEqual(entry?.metadata?.provenance, input.metadata?.provenance);
  assert.equal(entry?.origin.kind, "workspace");
  assert.notEqual(entry?.revision, 999);
  assert.equal(entry?.importance, 0.125);
  assert.deepEqual(entry?.tags, input.tags);
  assert.equal(entry?.rationale, input.rationale);
  assert.equal(entry?.threadId, "thread-0001");
  assert.equal(entry?.accessCount, 1);
  assert.equal(entry?.lastAccessedAt, "2026-09-05T12:00:00.000Z");
  const edited = await storage.updateEntry(entry!.id, { title: "Updated release convention", metadata: { reviewedBy: "local-user" } }, { expectedRevision: first.revision });
  assert.equal(edited.entry?.activitySessionId, "activity/source:001");
  const archived = await storage.archiveEntry(entry!.id, true, { expectedRevision: edited.revision });
  assert.equal(archived.entry?.activitySource, "activity_session");
  assert.equal(archived.entry?.activitySessionId, "activity/source:001");
  const restored = await storage.archiveEntry(archived.entry!.id, false, { expectedRevision: archived.revision });
  assert.equal(restored.entry?.activitySessionId, "activity/source:001");
  assert.deepEqual(restored.entry?.metadata?.provenance, input.metadata?.provenance);
  assert.equal(restored.entry?.metadata?.reviewedBy, "local-user");
  assert.deepEqual(restored.entry?.tags, input.tags);
  assert.equal(restored.entry?.rationale, input.rationale);
  storage.close();

  const database = new DatabaseSync(path.join(agentRoot, "memory", memoryDatabaseFileName), { readOnly: true });
  try {
    const row = database.prepare("SELECT metadata FROM memories WHERE id = ?").get(restored.entry!.id) as { metadata: string };
    const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    assert.equal(metadata.activitySource, "activity_session");
    assert.equal(metadata.activitySessionId, "activity/source:001");
    assert.deepEqual(metadata.provenance, input.metadata?.provenance);
    assert.equal(metadata.source, "auto");
    assert.deepEqual(metadata.tags, input.tags);
    assert.equal(metadata.rationale, input.rationale);
    const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name?: string }>).map((row) => row.name));
    assert.equal(tables.has("memories"), true);
    assert.equal(tables.has("memory_archive"), true);
    assert.equal(tables.has("memory_sleep_runs"), true);
    assert.equal(tables.has("crystal_terms"), true);
    assert.equal(tables.has("crystals"), true);
    assert.equal(tables.has("crystal_materials"), true);
    assert.equal(tables.has("crystal_bundles"), true);
    assert.equal(tables.has("crystal_processed_anchors"), true);
  } finally {
    database.close();
  }
}

async function testOldMemoryDatabaseIsRejected(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-current-schema-"));
  const agentDir = path.join(root, "agent");
  const memoryDir = path.join(agentDir, "memory");
  await mkdir(memoryDir, { recursive: true });
  const database = new DatabaseSync(path.join(memoryDir, memoryDatabaseFileName));
  database.exec("CREATE TABLE memories (id TEXT PRIMARY KEY); PRAGMA user_version = 2;");
  database.close();
  try {
    const oldStorage = new MemoryStorage(workspaceRoot, { agentDir });
    await assert.rejects(oldStorage.listEntries({ origins: ["all"] }), /schema is not current/u);
    oldStorage.close();
    await rm(memoryDir, { recursive: true, force: true });
    const currentStorage = new MemoryStorage(workspaceRoot, { agentDir });
    try {
      const written = await currentStorage.writeEntry({
        audience: "workspace",
        kind: "fact",
        topic: "reset",
        title: "Current schema",
        summary: "A fresh current memory database can be created after removing the old one.",
        lineage: { source: "explicit", externalContext: false }
      }, { expectedRevision: 0 });
      assert.equal(written.written, true);
    } finally {
      currentStorage.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testSleepRunPersistenceAndRecovery(): Promise<void> {
  const storage = new MemoryStorage(workspaceRoot);
  const run: MemorySleepRun = {
    id: "sleep-running",
    status: "running",
    trigger: "scheduled",
    examined: 2,
    written: 0,
    failed: 0,
    archived: 0,
    exact: 0,
    expired: 0,
    similarity: 0,
    llm: 0,
    archivedExact: 0,
    archivedExpired: 0,
    archivedOrphan: 0,
    archivedSimilarity: 0,
    archivedLlm: 0,
    inputTokens: 0,
    outputTokens: 0,
    startedAt: "2026-09-05T11:00:00.000Z"
  };
  const status: MemoryMaintenanceStatus = {
    state: "running",
    startedAt: run.startedAt,
    lastScanAt: run.startedAt,
    eligible: 2,
    processed: 0,
    written: 0,
    failed: 0,
    lastRun: run,
    sleepRuns: [run]
  };
  const historicalRuns = Array.from({ length: 25 }, (_, index): MemorySleepRun => ({
    ...run,
    id: `sleep-history-${index}`,
    status: index === 1 ? "running" : "completed",
    startedAt: new Date(Date.UTC(2026, 7, index + 1)).toISOString(),
    finishedAt: new Date(Date.UTC(2026, 7, index + 1, 1)).toISOString()
  }));
  await storage.writeMaintenanceStatus({ ...status, sleepRuns: historicalRuns });
  assert.equal((await storage.readMaintenanceStatus()).sleepRuns?.length, 25);
  const beforeImport = await storage.readMaintenanceStatus();
  assert.equal(await storage.importSleepRun(run), true);
  const afterImport = await storage.readMaintenanceStatus();
  assert.deepEqual({ ...afterImport, sleepRuns: beforeImport.sleepRuns }, beforeImport);
  assert.equal(await storage.importSleepRun(run), false);
  assert.deepEqual(await storage.readMaintenanceStatus(), afterImport);
  await storage.writeMaintenanceStatus(status);
  await storage.writeMaintenanceStatus({ ...status, sleepRuns: [] });
  await storage.writeMaintenanceStatus({ ...status, sleepRuns: undefined });
  assert.equal((await storage.readMaintenanceStatus()).sleepRuns?.length, 26);
  await storage.writeMaintenanceStatus({ ...status, sleepRuns: [{ ...historicalRuns[0]!, inputTokens: 123 }] });
  const updatedHistory = (await storage.readMaintenanceStatus()).sleepRuns!;
  assert.equal(updatedHistory.length, 26);
  assert.equal(updatedHistory.find((item) => item.id === historicalRuns[0]!.id)?.inputTokens, 123);
  storage.close();

  const reopened = new LocalMemory(workspaceRoot, unusedModel);
  const recovered = await reopened.loadMaintenanceStatus();
  assert.equal(recovered.state, "idle");
  assert.equal(recovered.lastRun?.status, "failed");
  assert.equal(recovered.lastRun?.error, "interrupted");
  reopened.close();
  const persisted = new MemoryStorage(workspaceRoot);
  try {
    const history = (await persisted.readMaintenanceStatus()).sleepRuns!;
    assert.equal(history.length, 26);
    assert.equal(history.find((item) => item.id === run.id)?.status, "failed");
    assert.equal(history.find((item) => item.id === historicalRuns[1]!.id)?.status, "failed");
    assert.equal(history.find((item) => item.id === historicalRuns[0]!.id)?.inputTokens, 123);
    const completedRun: MemorySleepRun = { ...run, status: "completed", finishedAt: "2026-09-05T12:00:00.000Z" };
    await persisted.writeMaintenanceStatus({
      ...status,
      state: "idle",
      lastRun: completedRun,
      sleepRuns: [completedRun, { ...historicalRuns[1]!, status: "running" }]
    });
  } finally {
    persisted.close();
  }
  const recovery = new LocalMemory(workspaceRoot, unusedModel);
  try {
    const healed = await recovery.loadMaintenanceStatus();
    assert.equal(healed.sleepRuns?.find((item) => item.id === historicalRuns[1]!.id)?.status, "failed");
    assert.equal(healed.lastRun?.status, "completed");
    assert.equal(healed.lastRun?.finishedAt, "2026-09-05T12:00:00.000Z");
    assert.equal(healed.lastRun?.error, undefined);
    const again = await recovery.loadMaintenanceStatus();
    assert.deepEqual(again, healed);
  } finally {
    recovery.close();
  }
}
