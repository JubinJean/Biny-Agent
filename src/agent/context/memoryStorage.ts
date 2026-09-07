/**
 * 本地记忆的 SQLite 事实库。
 *
 * memories 保存当前可召回的事实，memory_archive 保存可恢复的历史，Sleep 审计和 Embedding
 * 派生表也都在同一个 memory.sqlite 里。向量仍是可重建投影，不参与事实提交。
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { globalAgentDir } from "../../config/paths.js";
import { redactSecrets } from "../../utils/secrets.js";
import {
  assertAllowedMemoryEntry,
  createStoredMemoryEntry,
  memoryEntryEquals,
  memoryMatchFromRanked,
  normalizeMemoryTopic,
  rankMemoryEntries,
  sanitizeMemoryEntryInput
} from "./memoryFormat.js";
import {
  MemoryRevisionConflictError,
  type MemoryArchiveReason,
  type MemoryBulkArchiveResult,
  type MemoryClearResult,
  type MemoryDeleteResult,
  type MemoryEntriesResult,
  type MemoryEntry,
  type MemoryEntryInput,
  type MemoryEntryPatch,
  type MemoryListOptions,
  type MemoryMaintenanceStatus,
  type MemoryMutationOptions,
  type MemoryOrigin,
  type MemoryOriginCounts,
  type MemoryOriginSelector,
  type MemoryOverview,
  type MemoryReadOptions,
  type MemorySearchOptions,
  type MemorySearchResult,
  type MemorySleepRun,
  type MemoryWriteResult
} from "./memoryTypes.js";

export const memoryDatabaseFileName = "memory.sqlite";

const memorySchemaVersion = 4;
const sqliteBusyTimeoutMs = 5_000;
const memoryRootName = "memory";
const maxMaintenanceErrorChars = 2_000;

const memoryMetadataSchema = z.object({
  kind: z.enum(["preference", "working_style", "fact", "decision", "workflow", "gotcha"]),
  topic: z.string(),
  title: z.string(),
  decisions: z.array(z.string()),
  paths: z.array(z.string()),
  keywords: z.array(z.string()),
  source: z.string().default("manual"),
  tags: z.array(z.string()).default([]),
  rationale: z.string().optional(),
  activitySource: z.string().optional(),
  activitySessionId: z.string().optional(),
  importance: z.number(),
  durability: z.enum(["temporary", "permanent"]),
  expiresAt: z.string().optional(),
  lineage: z.array(z.object({
    source: z.enum(["explicit", "explicit_edit", "completed_task", "sleep"]),
    externalContext: z.boolean(),
    sessionId: z.string().optional(),
    turnId: z.string().optional(),
    runId: z.string().optional(),
    sourceEntryIds: z.array(z.string()).optional(),
    userEvidence: z.string().optional()
  })).min(1)
}).passthrough();

const memorySleepRunSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  trigger: z.enum(["scheduled", "manual", "idle", "count"]),
  examined: z.number().int().nonnegative(),
  written: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  archived: z.number().int().nonnegative(),
  exact: z.number().int().nonnegative(),
  expired: z.number().int().nonnegative(),
  similarity: z.number().int().nonnegative(),
  llm: z.number().int().nonnegative(),
  archivedExact: z.number().int().nonnegative().default(0),
  archivedExpired: z.number().int().nonnegative().default(0),
  archivedOrphan: z.number().int().nonnegative().default(0),
  archivedSimilarity: z.number().int().nonnegative().default(0),
  archivedLlm: z.number().int().nonnegative().default(0),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  error: z.string().optional()
});

const memoryStateSchema = z.object({
  state: z.enum(["idle", "running"]),
  startedAt: z.string().optional(),
  lastScanAt: z.string().optional(),
  lastFinishedAt: z.string().optional(),
  eligible: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(),
  written: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  error: z.string().optional()
});

type SqlValue = string | number | bigint | null | Uint8Array;

interface MemoryDbRow {
  id: unknown;
  original_id?: unknown;
  content: unknown;
  metadata: unknown;
  origin_kind: unknown;
  workspace_id: unknown;
  workspace_name: unknown;
  thread_id?: unknown;
  message_id?: unknown;
  user_id?: unknown;
  created_at: unknown;
  updated_at: unknown;
  revision: unknown;
  access_count: unknown;
  last_accessed_at?: unknown;
  archived_at?: unknown;
  archived_reason?: unknown;
  archived_by?: unknown;
  merged_into?: unknown;
}

interface MaintenanceDbRow {
  state: unknown;
  started_at: unknown;
  last_scan_at: unknown;
  last_finished_at: unknown;
  eligible: unknown;
  processed: unknown;
  written: unknown;
  failed: unknown;
  error: unknown;
  last_run_json: unknown;
}

interface SleepRunDbRow {
  id: unknown;
  status: unknown;
  trigger: unknown;
  examined: unknown;
  written: unknown;
  failed: unknown;
  archived: unknown;
  exact: unknown;
  expired: unknown;
  similarity: unknown;
  llm: unknown;
  archived_exact?: unknown;
  archived_expired?: unknown;
  archived_orphan?: unknown;
  archived_similarity?: unknown;
  archived_llm?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  started_at: unknown;
  finished_at: unknown;
  ended_at?: unknown;
  error: unknown;
}

export class MemoryStorage {
  private database: DatabaseSync | undefined;
  private databaseOpening: Promise<DatabaseSync | undefined> | undefined;

  private readonly agentDir: string | undefined;

  constructor(readonly workspaceRoot: string, options: { agentDir?: string } = {}) {
    this.agentDir = options.agentDir;
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
    this.databaseOpening = undefined;
  }

  async getCurrentWorkspaceId(): Promise<string> {
    return (await currentWorkspaceOrigin(this.workspaceRoot)).workspaceId;
  }

  async getOverview(options: MemoryReadOptions = {}): Promise<MemoryOverview> {
    options.signal?.throwIfAborted();
    const workspace = await currentWorkspaceOrigin(this.workspaceRoot);
    const database = await this.openDatabase(false);
    const entries = database === undefined ? [] : readMemoryEntries(database);
    return {
      storeRevision: database === undefined ? 0 : readRevision(database),
      entryCount: entries.filter((entry) => entry.archivedAt === undefined).length,
      origins: countOrigins(
        entries.filter((entry) => entry.archivedAt === undefined),
        workspace.workspaceId
      )
    };
  }

  async listEntries(options: MemoryListOptions = {}): Promise<MemoryEntriesResult> {
    options.signal?.throwIfAborted();
    const workspace = await currentWorkspaceOrigin(this.workspaceRoot);
    const database = await this.openDatabase(false);
    const allEntries = database === undefined ? [] : readMemoryEntries(database);
    const selectors = normalizeOriginSelectors(options.origins);
    const topic = options.topic === undefined ? undefined : normalizeMemoryTopic(options.topic);
    const matched = allEntries
      .filter((entry) => options.includeArchived === true || entry.archivedAt === undefined)
      .filter((entry) => matchesOriginSelectors(entry.origin, selectors, workspace.workspaceId))
      .filter((entry) => topic === undefined || entry.topic === topic)
      .sort(compareEntriesForDisplay);
    const offset = normalizeLimit(options.offset, 0);
    const records = matched.slice(offset, offset + normalizeLimit(options.limit, Number.MAX_SAFE_INTEGER));
    return {
      entries: records,
      paths: database === undefined
        ? undefined
        : Object.fromEntries(records.map((entry) => [entry.id, memoryReference(entry.id)])),
      storeRevision: database === undefined ? 0 : readRevision(database),
      total: matched.length
    };
  }

  async search(query: string, queryPaths: string[], options: MemorySearchOptions = {}): Promise<MemorySearchResult> {
    options.signal?.throwIfAborted();
    const workspace = await currentWorkspaceOrigin(this.workspaceRoot);
    const database = await this.openDatabase(false);
    const allEntries = database === undefined ? [] : readMemoryEntries(database);
    const selectors = normalizeOriginSelectors(options.origins);
    const now = options.now ?? new Date();
    const ranked = rankMemoryEntries(
      allEntries
        .filter((entry) => options.includeArchived === true || entry.archivedAt === undefined)
        .filter((entry) => matchesOriginSelectors(entry.origin, selectors, workspace.workspaceId)),
      query,
      queryPaths,
      now
    );
    const limit = normalizeLimit(options.limit, 3);
    const originIncluded = emptyOriginCounts();
    const originTrimmed = emptyOriginCounts();
    const omitted: MemorySearchResult["report"]["omitted"] = [];
    const matches: MemorySearchResult["matches"] = [];
    let usedChars = 0;
    let budgetOmitted = 0;

    for (const rankedEntry of ranked) {
      const bucket = originBucket(rankedEntry.entry.origin, workspace.workspaceId);
      if (matches.length >= limit) {
        originTrimmed[bucket] += 1;
        omitted.push({ origin: rankedEntry.entry.origin, id: rankedEntry.entry.id, reason: "entry_limit" });
        continue;
      }
      const estimatedChars = rankedEntry.entry.title.length + rankedEntry.excerpt.length + 80;
      if (options.maxChars !== undefined && usedChars + estimatedChars > Math.max(0, options.maxChars)) {
        budgetOmitted += 1;
        omitted.push({ origin: rankedEntry.entry.origin, id: rankedEntry.entry.id, reason: "budget" });
        continue;
      }
      usedChars += estimatedChars;
      originIncluded[bucket] += 1;
      matches.push({
        ...memoryMatchFromRanked(rankedEntry, memoryReference(rankedEntry.entry.id)),
        originBucket: bucket
      });
    }

    return {
      matches,
      storeRevision: database === undefined ? 0 : readRevision(database),
      report: {
        origins: { included: originIncluded, trimmed: originTrimmed },
        omitted,
        budgetOmission: options.maxChars === undefined || budgetOmitted === 0
          ? undefined
          : {
              maxChars: Math.max(0, options.maxChars),
              usedChars,
              omitted: budgetOmitted
            }
      }
    };
  }

  async writeEntry(input: MemoryEntryInput, options: MemoryMutationOptions): Promise<MemoryWriteResult> {
    options.signal?.throwIfAborted();
    const current = await currentWorkspaceOrigin(this.workspaceRoot);
    const safe = resolveEntryOrigin(sanitizeMemoryEntryInput(input), current);
    assertAllowedMemoryEntry(safe, this.workspaceRoot);
    return await this.withWrite(options.signal, (database) => {
      const revision = readRevision(database);
      assertExpectedRevision(options.expectedRevision, revision);
      if (safe.summary.length < 20) return { written: false, revision };
      const duplicate = readMemoryEntries(database).find((entry) => (
        entry.archivedAt === undefined && memoryEntryEquals(entry, safe)
      ));
      if (duplicate) {
        return {
          written: false,
          entry: duplicate,
          path: memoryReference(duplicate.id),
          revision
        };
      }
      const nextRevision = revision + 1;
      const now = (options.now ?? new Date()).toISOString();
      const entry = createStoredMemoryEntry(safe, {
        id: randomUUID(),
        revision: nextRevision,
        createdAt: now,
        updatedAt: now
      });
      insertActiveMemory(database, entry);
      setRevision(database, nextRevision);
      return {
        written: true,
        entry,
        path: memoryReference(entry.id),
        revision: nextRevision
      };
    });
  }

  async updateEntry(id: string, patch: MemoryEntryPatch, options: MemoryMutationOptions): Promise<MemoryWriteResult> {
    options.signal?.throwIfAborted();
    return await this.withWrite(options.signal, (database) => {
      const revision = readRevision(database);
      assertExpectedRevision(options.expectedRevision, revision);
      const existing = findMemoryEntry(database, id);
      if (!existing) return { written: false, revision };
      const input = sanitizeMemoryEntryInput({
        origin: existing.origin,
        kind: patch.kind ?? existing.kind,
        topic: patch.topic ?? existing.topic,
        title: patch.title ?? existing.title,
        summary: patch.summary ?? existing.summary,
        decisions: patch.decisions ?? existing.decisions,
        paths: patch.paths ?? existing.paths,
        keywords: patch.keywords ?? existing.keywords,
        source: patch.source ?? existing.source,
        tags: patch.tags ?? existing.tags,
        rationale: patch.rationale ?? existing.rationale,
        metadata: { ...existing.metadata, ...patch.metadata },
        activitySource: patch.activitySource ?? existing.activitySource,
        activitySessionId: patch.activitySessionId ?? existing.activitySessionId,
        threadId: patch.threadId ?? existing.threadId,
        messageId: patch.messageId ?? existing.messageId,
        userId: patch.userId ?? existing.userId,
        importance: patch.importance ?? existing.importance,
        durability: patch.durability ?? existing.durability,
        expiresAt: patch.expiresAt ?? existing.expiresAt,
        archivedAt: existing.archivedAt,
        archivedReason: existing.archivedReason,
        mergedInto: patch.mergedInto ?? existing.mergedInto,
        lineage: [
          ...existing.lineage,
          {
            source: "explicit_edit",
            externalContext: false,
            sourceEntryIds: [existing.id],
            userEvidence: patch.userEvidence
          }
        ]
      });
      assertAllowedMemoryEntry(input, this.workspaceRoot);
      if (input.summary.length < 20) {
        return { written: false, entry: existing, path: memoryReference(existing.id), revision };
      }
      const nextRevision = revision + 1;
      const entry = createStoredMemoryEntry(input, {
        id: existing.id,
        revision: nextRevision,
        createdAt: existing.createdAt,
        updatedAt: (options.now ?? new Date()).toISOString(),
        originalId: existing.originalId,
        archivedBy: existing.archivedBy
      });
      entry.accessCount = existing.accessCount;
      entry.lastAccessedAt = existing.lastAccessedAt;
      if (existing.archivedAt === undefined) updateActiveMemory(database, entry);
      else updateArchivedMemory(database, entry);
      setRevision(database, nextRevision);
      return {
        written: true,
        entry,
        path: memoryReference(entry.id),
        revision: nextRevision
      };
    });
  }

  async archiveEntry(id: string, archived: boolean, options: MemoryMutationOptions): Promise<{ archived: boolean; entry?: MemoryEntry; revision: number }> {
    options.signal?.throwIfAborted();
    return await this.withWrite(options.signal, (database) => {
      const revision = readRevision(database);
      assertExpectedRevision(options.expectedRevision, revision);
      const existing = findMemoryEntry(database, id);
      if (!existing) return { archived: false, revision };
      if ((existing.archivedAt !== undefined) === archived) return { archived, entry: existing, revision };
      const now = (options.now ?? new Date()).toISOString();
      const nextRevision = revision + 1;
      if (archived) {
        const entry = createStoredMemoryEntry({
          origin: existing.origin,
          kind: existing.kind,
          topic: existing.topic,
          title: existing.title,
          summary: existing.summary,
          decisions: existing.decisions,
          paths: existing.paths,
          keywords: existing.keywords,
          source: existing.source,
          tags: existing.tags,
          rationale: existing.rationale,
          metadata: existing.metadata,
          activitySource: existing.activitySource,
          activitySessionId: existing.activitySessionId,
          threadId: existing.threadId,
          messageId: existing.messageId,
          userId: existing.userId,
          importance: existing.importance,
          durability: existing.durability,
          expiresAt: existing.expiresAt,
          archivedAt: now,
          archivedReason: "manual",
          lineage: existing.lineage
        }, {
          // Assign a fresh archive row id and keep the active fact id in
          // original_id. The latter also lets the derived vector index remove
          // the active vector after the move.
          id: randomUUID(),
          originalId: existing.id,
          archivedBy: options.archivedBy ?? "manual",
          revision: nextRevision,
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt
        });
        entry.accessCount = existing.accessCount;
        entry.lastAccessedAt = existing.lastAccessedAt;
        insertArchivedMemory(database, entry);
        deleteActiveMemory(database, existing.id);
        setRevision(database, nextRevision);
        return { archived, entry, revision: nextRevision };
      } else {
        // Restoring an archive is an add operation: the restored active memory
        // receives a new fact id, while the archive row id is consumed.
        const entry = createStoredMemoryEntry({
          origin: existing.origin,
          kind: existing.kind,
          topic: existing.topic,
          title: existing.title,
          summary: existing.summary,
          decisions: existing.decisions,
          paths: existing.paths,
          keywords: existing.keywords,
          source: existing.source,
          tags: existing.tags,
          rationale: existing.rationale,
          metadata: existing.metadata,
          activitySource: existing.activitySource,
          activitySessionId: existing.activitySessionId,
          threadId: existing.threadId,
          messageId: existing.messageId,
          userId: existing.userId,
          importance: existing.importance,
          durability: existing.durability,
          lineage: existing.lineage
        }, {
          id: randomUUID(),
          revision: nextRevision,
          createdAt: now,
          updatedAt: now
        });
        entry.accessCount = existing.accessCount;
        entry.lastAccessedAt = existing.lastAccessedAt;
        insertActiveMemory(database, entry);
        deleteArchivedMemory(database, existing.id);
        setRevision(database, nextRevision);
        return { archived, entry, revision: nextRevision };
      }
    });
  }

  async archiveEntries(
    ids: readonly string[],
    reason: MemoryArchiveReason,
    options: MemoryMutationOptions & { mergedInto?: string }
  ): Promise<MemoryBulkArchiveResult> {
    options.signal?.throwIfAborted();
    const uniqueIds = [...new Set(ids)];
    return await this.withWrite(options.signal, (database) => {
      const revision = readRevision(database);
      assertExpectedRevision(options.expectedRevision, revision);
      if (!uniqueIds.length) return { entries: [], archived: 0, revision };
      const active = readMemoryEntries(database).filter((entry) => (
        entry.archivedAt === undefined && uniqueIds.includes(entry.id)
      ));
      if (!active.length) return { entries: [], archived: 0, revision };
      const now = (options.now ?? new Date()).toISOString();
      const nextRevision = revision + 1;
      const entries = active.map((existing) => {
        const entry = createStoredMemoryEntry({
          origin: existing.origin,
          kind: existing.kind,
          topic: existing.topic,
          title: existing.title,
          summary: existing.summary,
          decisions: existing.decisions,
          paths: existing.paths,
          keywords: existing.keywords,
          source: existing.source,
          tags: existing.tags,
          rationale: existing.rationale,
          metadata: existing.metadata,
          activitySource: existing.activitySource,
          activitySessionId: existing.activitySessionId,
          threadId: existing.threadId,
          messageId: existing.messageId,
          userId: existing.userId,
          importance: existing.importance,
          durability: existing.durability,
          expiresAt: existing.expiresAt,
          archivedAt: now,
          archivedReason: reason,
          mergedInto: options.mergedInto,
          lineage: existing.lineage
        }, {
          id: randomUUID(),
          originalId: existing.id,
          archivedBy: options.archivedBy ?? "manual",
          revision: nextRevision,
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt
        });
        entry.accessCount = existing.accessCount;
        entry.lastAccessedAt = existing.lastAccessedAt;
        assertAllowedMemoryEntry(entry, this.workspaceRoot);
        return entry;
      });
      for (const entry of entries) {
        insertArchivedMemory(database, entry);
        deleteActiveMemory(database, entry.originalId ?? entry.id);
      }
      setRevision(database, nextRevision);
      return { entries, archived: entries.length, revision: nextRevision };
    });
  }

  async purgeArchivedEntries(retentionDays: number, options: MemoryMutationOptions): Promise<{ deleted: number; revision: number }> {
    options.signal?.throwIfAborted();
    return await this.withWrite(options.signal, (database) => {
      const revision = readRevision(database);
      assertExpectedRevision(options.expectedRevision, revision);
      const cutoff = (options.now ?? new Date()).getTime()
        - Math.max(1, Math.trunc(retentionDays)) * 86_400_000;
      const targets = readMemoryEntries(database).filter((entry) => (
        entry.archivedAt !== undefined && Date.parse(entry.archivedAt) < cutoff
      ));
      if (!targets.length) return { deleted: 0, revision };
      const deleteStatement = database.prepare("DELETE FROM memory_archive WHERE id = ?");
      for (const entry of targets) deleteStatement.run(entry.id);
      setRevision(database, revision + 1);
      return { deleted: targets.length, revision: revision + 1 };
    });
  }

  async deleteEntry(id: string, options: MemoryMutationOptions): Promise<MemoryDeleteResult> {
    options.signal?.throwIfAborted();
    return await this.withWrite(options.signal, (database) => {
      const revision = readRevision(database);
      assertExpectedRevision(options.expectedRevision, revision);
      const existing = findMemoryEntry(database, id);
      if (!existing) return { deleted: false, revision };
      if (existing.archivedAt === undefined) deleteActiveMemory(database, existing.id);
      else deleteArchivedMemory(database, existing.id);
      setRevision(database, revision + 1);
      return { deleted: true, entry: existing, revision: revision + 1 };
    });
  }

  async clearEntries(selector: MemoryOriginSelector, options: MemoryMutationOptions): Promise<MemoryClearResult> {
    options.signal?.throwIfAborted();
    const workspace = await currentWorkspaceOrigin(this.workspaceRoot);
    return await this.withWrite(options.signal, (database) => {
      const revision = readRevision(database);
      assertExpectedRevision(options.expectedRevision, revision);
      const entries = readMemoryEntries(database).filter((entry) => (
        matchesOriginSelectors(entry.origin, [selector], workspace.workspaceId)
      ));
      if (!entries.length) {
        return { selector, deletedEntries: 0, revision };
      }
      for (const entry of entries) {
        if (entry.archivedAt === undefined) deleteActiveMemory(database, entry.id);
        else deleteArchivedMemory(database, entry.id);
      }
      setRevision(database, revision + 1);
      return {
        selector,
        deletedEntries: entries.length,
        revision: revision + 1
      };
    });
  }

  async recordRecallUsage(ids: string[], options: MemoryReadOptions & { now?: Date } = {}): Promise<void> {
    options.signal?.throwIfAborted();
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length) return;
    await this.withWrite(options.signal, (database) => {
      const now = (options.now ?? new Date()).toISOString();
      const active = database.prepare(
        "UPDATE memories SET access_count = access_count + 1, last_accessed_at = ?, updated_at = ? WHERE id = ?"
      );
      const archived = database.prepare(
        "UPDATE memory_archive SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?"
      );
      for (const id of uniqueIds) {
        const result = active.run(now, now, id);
        if (result.changes > 0) updateAccessMetadata(database, "memories", id, now);
        else if (archived.run(now, id).changes > 0) updateAccessMetadata(database, "memory_archive", id, now);
      }
    });
  }

  async readMaintenanceStatus(options: MemoryReadOptions = {}): Promise<MemoryMaintenanceStatus> {
    options.signal?.throwIfAborted();
    const database = await this.openDatabase(false);
    if (database === undefined) return emptyMaintenanceStatus();
    const row = database.prepare("SELECT * FROM memory_maintenance WHERE id = 1").get() as MaintenanceDbRow | undefined;
    if (!row) {
      const sleepRuns = readSleepRuns(database);
      return { ...emptyMaintenanceStatus(), sleepRuns: sleepRuns.length ? sleepRuns : undefined };
    }
    const state = memoryStateSchema.safeParse({
      state: row.state,
      startedAt: optionalTimeValue(row.started_at),
      lastScanAt: optionalTimeValue(row.last_scan_at),
      lastFinishedAt: optionalTimeValue(row.last_finished_at),
      eligible: safeCounter(row.eligible),
      processed: safeCounter(row.processed),
      written: safeCounter(row.written),
      failed: safeCounter(row.failed),
      error: optionalString(row.error)
    });
    if (!state.success) throw new Error("Invalid memory maintenance status.");
    const lastRun = parseSleepRun(row.last_run_json);
    const sleepRuns = readSleepRuns(database);
    return {
      ...state.data,
      lastRun,
      sleepRuns: sleepRuns.length ? sleepRuns : undefined
    };
  }

  async importSleepRun(run: MemorySleepRun, signal?: AbortSignal): Promise<boolean> {
    const safe = memorySleepRunSchema.parse(run);
    return await this.withWrite(signal, (database) => {
      const existing = readSleepRuns(database, safe.id)[0];
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(safe)) throw new Error(`Imported sleep run id conflicts: ${safe.id}`);
        return false;
      }
      database.prepare(
        "INSERT INTO memory_sleep_runs (id, status, trigger, examined, written, failed, archived, exact, expired, similarity, llm, " +
        "archived_exact, archived_expired, archived_orphan, archived_similarity, archived_llm, input_tokens, output_tokens, started_at, finished_at, ended_at, error) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(safe.id, safe.status, safe.trigger, safe.examined, safe.written, safe.failed, safe.archived, safe.exact, safe.expired, safe.similarity, safe.llm,
        safe.archivedExact, safe.archivedExpired, safe.archivedOrphan, safe.archivedSimilarity, safe.archivedLlm, safe.inputTokens, safe.outputTokens,
        safe.startedAt, safe.finishedAt ?? null, safe.finishedAt ?? null, safe.error ?? null);
      return true;
    });
  }

  async writeMaintenanceStatus(status: MemoryMaintenanceStatus, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const safe = sanitizeMaintenanceStatus(status);
    await this.withWrite(signal, (database) => {
      const runs = safe.sleepRuns ?? [];
      database.prepare(
        "INSERT INTO memory_maintenance (id, state, started_at, last_scan_at, last_finished_at, eligible, processed, written, failed, error, last_run_json) " +
        "VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET state = excluded.state, started_at = excluded.started_at, " +
        "last_scan_at = excluded.last_scan_at, last_finished_at = excluded.last_finished_at, " +
        "eligible = excluded.eligible, processed = excluded.processed, written = excluded.written, " +
        "failed = excluded.failed, error = excluded.error, last_run_json = excluded.last_run_json"
      ).run(
        safe.state,
        safe.startedAt ?? null,
        safe.lastScanAt ?? null,
        safe.lastFinishedAt ?? null,
        safe.eligible,
        safe.processed,
        safe.written,
        safe.failed,
        safe.error ?? null,
        safe.lastRun === undefined ? null : JSON.stringify(safe.lastRun)
      );
      // 状态快照可能只包含最近的运行，未包含的历史不应因此被删除。
      const insert = database.prepare(
        "INSERT INTO memory_sleep_runs " +
        "(id, status, trigger, examined, written, failed, archived, exact, expired, similarity, llm, " +
        "archived_exact, archived_expired, archived_orphan, archived_similarity, archived_llm, input_tokens, output_tokens, " +
        "started_at, finished_at, ended_at, error) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET status = excluded.status, trigger = excluded.trigger, " +
        "examined = excluded.examined, written = excluded.written, failed = excluded.failed, " +
        "archived = excluded.archived, exact = excluded.exact, expired = excluded.expired, " +
        "similarity = excluded.similarity, llm = excluded.llm, archived_exact = excluded.archived_exact, " +
        "archived_expired = excluded.archived_expired, archived_orphan = excluded.archived_orphan, " +
        "archived_similarity = excluded.archived_similarity, archived_llm = excluded.archived_llm, " +
        "input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, " +
        "started_at = excluded.started_at, finished_at = excluded.finished_at, ended_at = excluded.ended_at, error = excluded.error"
      );
      for (const run of runs) {
        insert.run(
          run.id,
          run.status,
          run.trigger,
          run.examined,
          run.written,
          run.failed,
          run.archived,
          run.exact,
          run.expired,
          run.similarity,
          run.llm,
          run.archivedExact,
          run.archivedExpired,
          run.archivedOrphan,
          run.archivedSimilarity,
          run.archivedLlm,
          run.inputTokens,
          run.outputTokens,
          run.startedAt,
          run.finishedAt ?? null,
          run.finishedAt ?? null,
          run.error ?? null
        );
      }
    });
  }

  private async openDatabase(create: boolean): Promise<DatabaseSync | undefined> {
    if (this.database) return this.database;
    const opening = this.databaseOpening;
    if (opening) {
      const database = await opening;
      if (database || !create) return database;
      return await this.openDatabase(true);
    }
    const next = this.openDatabaseInternal(create);
    this.databaseOpening = next;
    try {
      const database = await next;
      if (database) this.database = database;
      return database;
    } finally {
      if (this.databaseOpening === next) this.databaseOpening = undefined;
    }
  }

  private async openDatabaseInternal(create: boolean): Promise<DatabaseSync | undefined> {
    const databasePath = await resolveMemoryDatabasePath(create, this.agentDir);
    if (databasePath === undefined) return undefined;
    const database = new DatabaseSync(databasePath, {
      timeout: sqliteBusyTimeoutMs,
      enableForeignKeyConstraints: true
    });
    try {
      await assertSafeDatabaseFile(databasePath);
      initializeDatabase(database);
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private async withWrite<T>(
    signal: AbortSignal | undefined,
    operation: (database: DatabaseSync) => T
  ): Promise<T> {
    signal?.throwIfAborted();
    const database = await this.openDatabase(true);
    if (database === undefined) throw new Error("Failed to create memory database.");
    return runTransaction(database, signal, operation);
  }
}

function initializeDatabase(database: DatabaseSync): void {
  const row = database.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
  const version = safeCounter(row?.user_version);
  if (version !== 0 && version !== memorySchemaVersion) {
    throw new Error("Memory database schema is not current; remove it before starting.");
  }
  const existingTables = (database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  ).all() as Array<{ name?: unknown }>)
    .map((table) => typeof table.name === "string" ? table.name : "")
    .filter(Boolean);
  // 向量索引可能先创建自己的派生表；只要事实表尚未出现，仍属于当前库的首次初始化。
  if (version === 0 && existingTables.includes("memories")) {
    throw new Error("Memory database schema is not current; remove it before starting.");
  }
  database.exec(
    "PRAGMA journal_mode = WAL; " +
    "PRAGMA synchronous = NORMAL; " +
    "PRAGMA foreign_keys = ON; " +
    "CREATE TABLE IF NOT EXISTS memory_meta (" +
    "key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL" +
    "); " +
    "INSERT INTO memory_meta (key, value) VALUES ('revision', '0') " +
    "ON CONFLICT(key) DO NOTHING; " +
    "CREATE TABLE IF NOT EXISTS memories (" +
    "id TEXT PRIMARY KEY NOT NULL, content TEXT NOT NULL, metadata TEXT NOT NULL, " +
    "origin_kind TEXT NOT NULL, workspace_id TEXT, workspace_name TEXT, " +
    "thread_id TEXT, message_id TEXT, user_id TEXT, " +
    "created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL, " +
    "access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at TEXT" +
    "); " +
    "CREATE INDEX IF NOT EXISTS memories_origin_idx ON memories(origin_kind, workspace_id); " +
    "CREATE INDEX IF NOT EXISTS memories_thread_idx ON memories(thread_id); " +
    "CREATE INDEX IF NOT EXISTS memories_user_idx ON memories(user_id); " +
    "CREATE TABLE IF NOT EXISTS memory_archive (" +
    "id TEXT PRIMARY KEY NOT NULL, original_id TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT NOT NULL, " +
    "origin_kind TEXT NOT NULL, workspace_id TEXT, workspace_name TEXT, " +
    "thread_id TEXT, message_id TEXT, user_id TEXT, " +
    "original_created_at TEXT NOT NULL, original_updated_at TEXT NOT NULL, revision INTEGER NOT NULL, " +
    "access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at TEXT, " +
    "archived_at TEXT NOT NULL, archived_reason TEXT NOT NULL, archived_by TEXT NOT NULL, merged_into TEXT" +
    "); " +
    "CREATE INDEX IF NOT EXISTS memory_archive_original_idx ON memory_archive(original_id); " +
    "CREATE INDEX IF NOT EXISTS memory_archive_origin_idx ON memory_archive(origin_kind, workspace_id); " +
    "CREATE INDEX IF NOT EXISTS memory_archive_thread_idx ON memory_archive(thread_id); " +
    "CREATE INDEX IF NOT EXISTS memory_archive_user_idx ON memory_archive(user_id); " +
    "CREATE TABLE IF NOT EXISTS memory_metadata (" +
    "key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL" +
    "); " +
    "CREATE TABLE IF NOT EXISTS memory_maintenance (" +
    "id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL, " +
    "started_at TEXT, last_scan_at TEXT, last_finished_at TEXT, " +
    "eligible INTEGER NOT NULL, processed INTEGER NOT NULL, written INTEGER NOT NULL, failed INTEGER NOT NULL, " +
    "error TEXT, last_run_json TEXT" +
    "); " +
    "CREATE TABLE IF NOT EXISTS memory_sleep_runs (" +
    "id TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL, trigger TEXT NOT NULL, " +
    "examined INTEGER NOT NULL, written INTEGER NOT NULL, failed INTEGER NOT NULL, archived INTEGER NOT NULL, " +
    "exact INTEGER NOT NULL, expired INTEGER NOT NULL, similarity INTEGER NOT NULL, llm INTEGER NOT NULL, " +
    "archived_exact INTEGER NOT NULL DEFAULT 0, archived_expired INTEGER NOT NULL DEFAULT 0, " +
    "archived_orphan INTEGER NOT NULL DEFAULT 0, archived_similarity INTEGER NOT NULL DEFAULT 0, " +
    "archived_llm INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, " +
    "output_tokens INTEGER NOT NULL DEFAULT 0, " +
    "started_at TEXT NOT NULL, finished_at TEXT, ended_at TEXT, error TEXT" +
    "); " +
    "PRAGMA user_version = 4;"
  );
  createCrystalTables(database);
  database.exec(`PRAGMA user_version = ${String(memorySchemaVersion)};`);
}

function createCrystalTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS crystal_terms (
      id TEXT PRIMARY KEY NOT NULL,
      term TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'latent',
      count INTEGER NOT NULL DEFAULT 0,
      turn_ids TEXT NOT NULL DEFAULT '[]',
      thread_ids TEXT NOT NULL DEFAULT '[]',
      days TEXT NOT NULL DEFAULT '[]',
      occurrences TEXT NOT NULL DEFAULT '[]',
      crystal_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crystal_terms_status ON crystal_terms(status, updated_at);
    CREATE TABLE IF NOT EXISTS crystals (
      id TEXT PRIMARY KEY NOT NULL,
      origin TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'candidate',
      name TEXT NOT NULL,
      type TEXT,
      dormant INTEGER NOT NULL DEFAULT 0,
      slot INTEGER,
      term_id TEXT,
      checklist TEXT NOT NULL DEFAULT '{}',
      notified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      formal_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_crystals_stage ON crystals(stage, dormant, updated_at);
    CREATE TABLE IF NOT EXISTS crystal_bundles (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT,
      thread_id TEXT NOT NULL,
      anchor_ids TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crystal_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crystal_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crystal_materials_crystal ON crystal_materials(crystal_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crystal_materials_unique ON crystal_materials(crystal_id, kind, ref);
    CREATE TABLE IF NOT EXISTS crystal_processed_anchors (
      anchor_id TEXT PRIMARY KEY NOT NULL,
      processed_at TEXT NOT NULL
    );
  `);
}

function runTransaction<T>(
  database: DatabaseSync,
  signal: AbortSignal | undefined,
  operation: (database: DatabaseSync) => T
): T {
  signal?.throwIfAborted();
  database.exec("BEGIN IMMEDIATE");
  try {
    signal?.throwIfAborted();
    const result = operation(database);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // 保留原始错误。
    }
    throw error;
  }
}

function readRevision(database: DatabaseSync): number {
  const row = database.prepare("SELECT value FROM memory_meta WHERE key = 'revision'").get() as { value?: unknown } | undefined;
  return safeRevision(row?.value);
}

function setRevision(database: DatabaseSync, revision: number): void {
  database.prepare(
    "INSERT INTO memory_meta (key, value) VALUES ('revision', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(revision));
}

function readMemoryEntries(database: DatabaseSync): MemoryEntry[] {
  const active = database.prepare("SELECT * FROM memories").all() as unknown as MemoryDbRow[];
  const archived = database.prepare(
    "SELECT id, original_id, content, metadata, origin_kind, workspace_id, workspace_name, thread_id, message_id, user_id, " +
    "original_created_at AS created_at, original_updated_at AS updated_at, revision, access_count, last_accessed_at, " +
    "archived_at, archived_reason, archived_by, merged_into " +
    "FROM memory_archive"
  ).all() as unknown as MemoryDbRow[];
  const entries = [
    ...active.map((row) => memoryFromRow(row)),
    ...archived.map((row) => memoryFromRow(row))
  ];
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error("Duplicate memory entry id: " + entry.id);
    ids.add(entry.id);
  }
  return entries;
}

function findMemoryEntry(database: DatabaseSync, id: string): MemoryEntry | undefined {
  const active = database.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryDbRow | undefined;
  if (active) return memoryFromRow(active);
  const archived = database.prepare(
    "SELECT id, original_id, content, metadata, origin_kind, workspace_id, workspace_name, thread_id, message_id, user_id, " +
    "original_created_at AS created_at, original_updated_at AS updated_at, revision, access_count, last_accessed_at, " +
    "archived_at, archived_reason, archived_by, merged_into " +
    "FROM memory_archive WHERE id = ?"
  ).get(id) as MemoryDbRow | undefined;
  return archived ? memoryFromRow(archived) : undefined;
}

function memoryFromRow(row: MemoryDbRow): MemoryEntry {
  const metadata = parseMemoryMetadata(row.metadata);
  const origin = originFromColumns(row.origin_kind, row.workspace_id, row.workspace_name);
  const archivedAt = optionalTimeValue(row.archived_at);
  const archivedReason = archiveReasonValue(row.archived_reason);
  const originalId = archivedAt === undefined ? undefined : optionalString(row.original_id);
  const archivedBy = archivedAt === undefined ? undefined : optionalString(row.archived_by);
  const mergedInto = optionalString(row.merged_into);
  const entry = createStoredMemoryEntry({
    origin,
    kind: metadata.kind,
    topic: metadata.topic,
    title: metadata.title,
    summary: stringValue(row.content, "memory content"),
    decisions: metadata.decisions,
    paths: metadata.paths,
    keywords: metadata.keywords,
    source: metadata.source,
    tags: metadata.tags,
    rationale: metadata.rationale,
    metadata,
    activitySource: metadata.activitySource,
    activitySessionId: metadata.activitySessionId,
    threadId: optionalString(row.thread_id),
    messageId: optionalString(row.message_id),
    userId: optionalString(row.user_id),
    importance: metadata.importance,
    durability: metadata.durability,
    expiresAt: metadata.expiresAt,
    archivedAt,
    archivedReason,
    mergedInto,
    lineage: metadata.lineage
  }, {
    id: stringValue(row.id, "memory id"),
    originalId,
    archivedBy,
    revision: safeRevision(row.revision),
    createdAt: stringValue(row.created_at, "memory created_at"),
    updatedAt: stringValue(row.updated_at, "memory updated_at"),
    durability: metadata.durability
  });
  entry.accessCount = safeCounter(row.access_count);
  entry.lastAccessedAt = optionalTimeValue(row.last_accessed_at);
  return entry;
}

function parseMemoryMetadata(value: unknown): z.infer<typeof memoryMetadataSchema> {
  let raw: unknown;
  try {
    raw = JSON.parse(stringValue(value, "memory metadata"));
  } catch {
    throw new Error("Invalid memory metadata JSON.");
  }
  const parsed = memoryMetadataSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid memory metadata.");
  return parsed.data;
}

function insertActiveMemory(database: DatabaseSync, entry: MemoryEntry): void {
  database.prepare(
    "INSERT INTO memories " +
    "(id, content, metadata, origin_kind, workspace_id, workspace_name, thread_id, message_id, user_id, created_at, updated_at, revision, access_count, last_accessed_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(...activeMemoryValues(entry));
}

function updateActiveMemory(database: DatabaseSync, entry: MemoryEntry): void {
  database.prepare(
    "UPDATE memories SET content = ?, metadata = ?, origin_kind = ?, workspace_id = ?, workspace_name = ?, " +
    "thread_id = ?, message_id = ?, user_id = ?, updated_at = ?, revision = ? WHERE id = ?"
  ).run(
    entry.summary,
    memoryMetadata(entry),
    entry.origin.kind,
    entry.origin.kind === "workspace" ? entry.origin.workspaceId : null,
    entry.origin.kind === "workspace" ? entry.origin.workspaceName : null,
    entry.threadId ?? null,
    entry.messageId ?? null,
    entry.userId ?? null,
    entry.updatedAt,
    entry.revision,
    entry.id
  );
}

function insertArchivedMemory(database: DatabaseSync, entry: MemoryEntry): void {
  if (!entry.archivedAt || !entry.originalId) throw new Error("Archived memory requires archived_at and original_id.");
  database.prepare(
    "INSERT INTO memory_archive " +
    "(id, original_id, content, metadata, origin_kind, workspace_id, workspace_name, thread_id, message_id, user_id, original_created_at, " +
    "original_updated_at, revision, access_count, last_accessed_at, archived_at, archived_reason, archived_by, merged_into) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(...archivedMemoryValues(entry));
}

function updateArchivedMemory(database: DatabaseSync, entry: MemoryEntry): void {
  if (!entry.archivedAt) throw new Error("Archived memory requires archived_at.");
  database.prepare(
    "UPDATE memory_archive SET content = ?, metadata = ?, origin_kind = ?, workspace_id = ?, workspace_name = ?, " +
    "thread_id = ?, message_id = ?, user_id = ?, last_accessed_at = ?, original_updated_at = ?, revision = ?, archived_at = ?, archived_reason = ?, archived_by = ?, merged_into = ? WHERE id = ?"
  ).run(
    entry.summary,
    memoryMetadata(entry),
    entry.origin.kind,
    entry.origin.kind === "workspace" ? entry.origin.workspaceId : null,
    entry.origin.kind === "workspace" ? entry.origin.workspaceName : null,
    entry.threadId ?? null,
    entry.messageId ?? null,
    entry.userId ?? null,
    entry.lastAccessedAt ?? null,
    entry.updatedAt,
    entry.revision,
    entry.archivedAt,
    entry.archivedReason ?? "manual",
    entry.archivedBy ?? "manual",
    entry.mergedInto ?? null,
    entry.id
  );
}

function activeMemoryValues(entry: MemoryEntry): SqlValue[] {
  return [
    entry.id,
    entry.summary,
    memoryMetadata(entry),
    entry.origin.kind,
    entry.origin.kind === "workspace" ? entry.origin.workspaceId : null,
    entry.origin.kind === "workspace" ? entry.origin.workspaceName : null,
    entry.threadId ?? null,
    entry.messageId ?? null,
    entry.userId ?? null,
    entry.createdAt,
    entry.updatedAt,
    entry.revision,
    entry.accessCount,
    entry.lastAccessedAt ?? null
  ];
}

function archivedMemoryValues(entry: MemoryEntry): SqlValue[] {
  if (!entry.archivedAt || !entry.originalId) throw new Error("Archived memory requires archived_at and original_id.");
  return [
    entry.id,
    entry.originalId,
    entry.summary,
    memoryMetadata(entry),
    entry.origin.kind,
    entry.origin.kind === "workspace" ? entry.origin.workspaceId : null,
    entry.origin.kind === "workspace" ? entry.origin.workspaceName : null,
    entry.threadId ?? null,
    entry.messageId ?? null,
    entry.userId ?? null,
    entry.createdAt,
    entry.updatedAt,
    entry.revision,
    entry.accessCount,
    entry.lastAccessedAt ?? null,
    entry.archivedAt,
    entry.archivedReason ?? "manual",
    entry.archivedBy ?? "manual",
    entry.mergedInto ?? null
  ];
}

function memoryMetadata(entry: MemoryEntry): string {
  return JSON.stringify({
    ...entry.metadata,
    kind: entry.kind,
    topic: entry.topic,
    title: entry.title,
    decisions: entry.decisions,
    paths: entry.paths,
    keywords: entry.keywords,
    source: entry.source,
    tags: entry.tags,
    rationale: entry.rationale,
    activitySource: entry.activitySource,
    activitySessionId: entry.activitySessionId,
    accessCount: entry.accessCount,
    lastAccessedAt: entry.lastAccessedAt,
    importance: entry.importance,
    durability: entry.durability,
    expiresAt: entry.expiresAt,
    lineage: entry.lineage
  });
}

function updateAccessMetadata(database: DatabaseSync, table: "memories" | "memory_archive", id: string, timestamp: string): void {
  const row = database.prepare(`SELECT metadata, access_count FROM ${table} WHERE id = ?`).get(id) as { metadata?: unknown; access_count?: unknown } | undefined;
  if (!row || typeof row.metadata !== "string") return;
  try {
    const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    metadata.accessCount = safeCounter(row.access_count);
    metadata.lastAccessedAt = timestamp;
    database.prepare(`UPDATE ${table} SET metadata = ? WHERE id = ?`).run(JSON.stringify(metadata), id);
  } catch {
    // 访问计数的派生投影不应遮蔽已经成功的计数更新。
  }
}

function deleteActiveMemory(database: DatabaseSync, id: string): void {
  database.prepare("DELETE FROM memories WHERE id = ?").run(id);
}

function deleteArchivedMemory(database: DatabaseSync, id: string): void {
  database.prepare("DELETE FROM memory_archive WHERE id = ?").run(id);
}

function emptyMaintenanceStatus(): MemoryMaintenanceStatus {
  return { state: "idle", eligible: 0, processed: 0, written: 0, failed: 0 };
}

function sanitizeMaintenanceStatus(status: MemoryMaintenanceStatus): MemoryMaintenanceStatus {
  const safeRun = status.lastRun === undefined ? undefined : sanitizeSleepRun(status.lastRun);
  const runs = status.sleepRuns?.map(sanitizeSleepRun);
  return {
    state: status.state,
    startedAt: safeOptionalTime(status.startedAt),
    lastScanAt: safeOptionalTime(status.lastScanAt),
    lastFinishedAt: safeOptionalTime(status.lastFinishedAt),
    eligible: safeCounter(status.eligible),
    processed: safeCounter(status.processed),
    written: safeCounter(status.written),
    failed: safeCounter(status.failed),
    error: sanitizeError(status.error),
    lastRun: safeRun,
    sleepRuns: runs
  };
}

function sanitizeSleepRun(run: MemorySleepRun): MemorySleepRun {
  return {
    id: run.id.trim().slice(0, 200),
    status: run.status ?? "completed",
    trigger: run.trigger,
    examined: safeCounter(run.examined),
    written: safeCounter(run.written),
    failed: safeCounter(run.failed),
    archived: safeCounter(run.archived),
    exact: safeCounter(run.exact),
    expired: safeCounter(run.expired),
    similarity: safeCounter(run.similarity),
    llm: safeCounter(run.llm),
    archivedExact: Math.max(safeCounter(run.archivedExact), safeCounter(run.exact)),
    archivedExpired: Math.max(safeCounter(run.archivedExpired), safeCounter(run.expired)),
    archivedOrphan: safeCounter(run.archivedOrphan),
    archivedSimilarity: Math.max(safeCounter(run.archivedSimilarity), safeCounter(run.similarity)),
    archivedLlm: Math.max(safeCounter(run.archivedLlm), safeCounter(run.llm)),
    inputTokens: safeCounter(run.inputTokens),
    outputTokens: safeCounter(run.outputTokens),
    startedAt: safeOptionalTime(run.startedAt) ?? new Date(0).toISOString(),
    finishedAt: safeOptionalTime(run.finishedAt),
    error: sanitizeError(run.error)
  };
}

function readSleepRuns(database: DatabaseSync, id?: string): MemorySleepRun[] {
  const rows = database.prepare(
    "SELECT id, status, trigger, examined, written, failed, archived, exact, expired, similarity, llm, " +
    "archived_exact, archived_expired, archived_orphan, archived_similarity, archived_llm, input_tokens, output_tokens, " +
    "started_at, finished_at, ended_at, error " +
    "FROM memory_sleep_runs " + (id === undefined ? "ORDER BY started_at ASC, id ASC" : "WHERE id = ?")
  ).all(...(id === undefined ? [] : [id])) as unknown as SleepRunDbRow[];
  return rows.map((row) => {
    const parsed = memorySleepRunSchema.safeParse({
      id: stringValue(row.id, "sleep run id"),
      status: stringValue(row.status, "sleep run status"),
      trigger: stringValue(row.trigger, "sleep run trigger"),
      examined: safeCounter(row.examined),
      written: safeCounter(row.written),
      failed: safeCounter(row.failed),
      archived: safeCounter(row.archived),
      exact: safeCounter(row.exact),
      expired: safeCounter(row.expired),
      similarity: safeCounter(row.similarity),
      llm: safeCounter(row.llm),
      archivedExact: Math.max(safeCounter(row.archived_exact), safeCounter(row.exact)),
      archivedExpired: Math.max(safeCounter(row.archived_expired), safeCounter(row.expired)),
      archivedOrphan: safeCounter(row.archived_orphan),
      archivedSimilarity: Math.max(safeCounter(row.archived_similarity), safeCounter(row.similarity)),
      archivedLlm: Math.max(safeCounter(row.archived_llm), safeCounter(row.llm)),
      inputTokens: safeCounter(row.input_tokens),
      outputTokens: safeCounter(row.output_tokens),
      startedAt: stringValue(row.started_at, "sleep run started_at"),
      finishedAt: optionalTimeValue(row.finished_at ?? row.ended_at),
      error: optionalString(row.error)
    });
    if (!parsed.success) throw new Error("Invalid memory sleep run.");
    return parsed.data;
  });
}

function parseSleepRun(value: unknown): MemorySleepRun | undefined {
  if (value === null || value === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(stringValue(value, "last sleep run"));
  } catch {
    throw new Error("Invalid last sleep run JSON.");
  }
  const parsed = memorySleepRunSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid last sleep run.");
  return sanitizeSleepRun(parsed.data);
}

async function resolveMemoryDatabasePath(create: boolean, agentDir?: string): Promise<string | undefined> {
  const configuredAgentPath = path.resolve(agentDir ?? globalAgentDir());
  const agent = await ensureRealDirectory(configuredAgentPath, create, "global agent directory");
  if (!agent) return undefined;
  const canonicalAgent = await fs.realpath(configuredAgentPath);
  const memoryPath = path.join(canonicalAgent, memoryRootName);
  const memory = await ensureRealDirectory(memoryPath, create, "global memory root");
  if (!memory) return undefined;
  const canonicalMemory = await fs.realpath(memoryPath);
  if (canonicalMemory !== memoryPath) {
    throw new Error("Global memory root must be a real canonical directory.");
  }
  const databasePath = path.join(canonicalMemory, memoryDatabaseFileName);
  try {
    await assertSafeDatabaseFile(databasePath);
  } catch (error) {
    if (isNotFound(error) && create) return databasePath;
    if (isNotFound(error)) return undefined;
    throw error;
  }
  return databasePath;
}

async function assertSafeDatabaseFile(databasePath: string): Promise<void> {
  const stat = await fs.lstat(databasePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || await fs.realpath(databasePath) !== databasePath) {
    throw new Error("Memory database must be a regular, canonical file.");
  }
}

async function ensureRealDirectory(
  directory: string,
  create: boolean,
  label: string
): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if (!isNotFound(error) || !create) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (mkdirError) {
      if (!isAlreadyExists(mkdirError)) throw mkdirError;
    }
    stat = await fs.lstat(directory);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Local memory storage " + label + " must be a real directory, not a symbolic link.");
  }
  if (create) await fs.chmod(directory, 0o700);
  return stat;
}

async function currentWorkspaceOrigin(workspaceRoot: string): Promise<Extract<MemoryOrigin, { kind: "workspace" }>> {
  const canonicalWorkspace = await fs.realpath(path.resolve(workspaceRoot));
  return workspaceOrigin(canonicalWorkspace);
}

function workspaceOrigin(canonicalWorkspace: string): Extract<MemoryOrigin, { kind: "workspace" }> {
  return {
    kind: "workspace",
    workspaceId: createHash("sha256").update(path.resolve(canonicalWorkspace)).digest("hex").slice(0, 24),
    workspaceName: path.basename(canonicalWorkspace).slice(0, 120) || "workspace"
  };
}

function resolveEntryOrigin(input: MemoryEntryInput, current: MemoryOrigin): MemoryEntryInput & { origin: MemoryOrigin } {
  const intended = input.audience === "universal"
    ? "user"
    : input.audience === "workspace"
      ? "workspace"
      : undefined;
  const origin = input.origin ?? (intended === "user" ? { kind: "user" as const } : current);
  if (intended !== undefined && origin.kind !== intended) {
    throw new Error("Memory audience conflicts with origin.");
  }
  if (origin.kind === "workspace" && current.kind === "workspace" && origin.workspaceId !== current.workspaceId) {
    throw new Error("New workspace memory must use the current workspace origin.");
  }
  return { ...input, origin };
}

function originFromColumns(kindValue: unknown, workspaceIdValue: unknown, workspaceNameValue: unknown): MemoryOrigin {
  const kind = stringValue(kindValue, "memory origin kind");
  if (kind === "user") return { kind: "user" };
  if (kind !== "workspace") throw new Error("Invalid memory origin kind: " + kind);
  const workspaceId = stringValue(workspaceIdValue, "memory workspace id");
  const workspaceName = stringValue(workspaceNameValue, "memory workspace name");
  if (!/^[a-f0-9]{24}$/u.test(workspaceId) || !workspaceName.trim()) {
    throw new Error("Invalid workspace memory origin.");
  }
  return { kind: "workspace", workspaceId, workspaceName };
}

function normalizeOriginSelectors(origins: MemoryOriginSelector[] | undefined): MemoryOriginSelector[] {
  if (origins?.length) return [...new Set(origins)];
  return ["all"];
}

function matchesOriginSelectors(origin: MemoryOrigin, selectors: MemoryOriginSelector[], workspaceId: string): boolean {
  if (selectors.includes("all")) return true;
  if (origin.kind === "user") return selectors.includes("user");
  return origin.workspaceId === workspaceId
    ? selectors.includes("current_workspace")
    : selectors.includes("other_workspaces");
}

function emptyOriginCounts(): MemoryOriginCounts {
  return { user: 0, currentWorkspace: 0, otherWorkspaces: 0 };
}

function originBucket(origin: MemoryOrigin, workspaceId: string): keyof MemoryOriginCounts {
  if (origin.kind === "user") return "user";
  return origin.workspaceId === workspaceId ? "currentWorkspace" : "otherWorkspaces";
}

function countOrigins(entries: MemoryEntry[], workspaceId: string): MemoryOriginCounts {
  const counts = emptyOriginCounts();
  for (const entry of entries) counts[originBucket(entry.origin, workspaceId)] += 1;
  return counts;
}

function compareEntriesForDisplay(left: MemoryEntry, right: MemoryEntry): number {
  return right.importance - left.importance
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.id.localeCompare(right.id);
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function archiveReasonValue(value: unknown): MemoryArchiveReason | undefined {
  if (value === null || value === undefined) return undefined;
  if (value === "exact_dup" || value === "exact" || value === "expired" || value === "orphan"
    || value === "similarity_merge" || value === "llm_merge"
    || value === "similarity" || value === "llm" || value === "manual") return value;
  throw new Error("Invalid memory archive reason.");
}

function memoryReference(id: string): string {
  return "memory://" + id;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  throw new Error("Invalid " + label + ".");
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return stringValue(value, "memory string");
}

function optionalTimeValue(value: unknown): string | undefined {
  const string = optionalString(value);
  return safeOptionalTime(string);
}

function safeCounter(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function safeRevision(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Invalid memory revision.");
  return number;
}

function safeOptionalTime(value: string | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function sanitizeError(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return redactSecrets(value).trim().slice(0, maxMaintenanceErrorChars) || undefined;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function assertExpectedRevision(expected: number, actual: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0) {
    throw new Error("expectedRevision must be a non-negative integer.");
  }
  if (expected !== actual) throw new MemoryRevisionConflictError(expected, actual);
}
