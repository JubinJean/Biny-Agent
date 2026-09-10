/**
 * 记忆、日报、Heartbeat 和当前 session Todo 的 CLI 入口。
 *
 * 这里不复制领域存储：SQLite 记忆与 Heartbeat/反思通过 Runtime Host，日报直接复用
 * daily-notes，Todo 直接复用当前 session 的 TodoStore。
 */
import { connectOrSpawnRuntimeHost, connectRuntimeHost, type RuntimeHostClient } from "../../runtime/RuntimeHost.js";
import { globalConfigDir } from "../../config/paths.js";
import { readDailyMemoryNote, readDailyMemorySection } from "../../activity/dailyNotes.js";
import { HeartbeatFileStore } from "../../agent/context/heartbeat.js";
import { TodoStore, type TodoItem } from "../../session/todoStore.js";
import { resolveSessionFile, sessionIdFromFile } from "../../session/store.js";
import type { MemoryKind, MemoryOriginSelector } from "../../agent/context/memoryTypes.js";

export interface LocalCapabilityOutputOptions {
  json?: boolean;
  noSpawn?: boolean;
}

export async function memoryListCommand(workspaceRoot: string, selectorInput: string, options: LocalCapabilityOutputOptions = {}): Promise<void> {
  await withHost(workspaceRoot, options, async (client) => {
    const result = await client.memory<{ entries: unknown[]; storeRevision: number }>("list-v3", {
      selector: memorySelector(selectorInput),
      limit: 200,
      includeArchived: false
    });
    printResult(result, options.json, (value) => {
      const record = asRecord(value);
      const entries = Array.isArray(record.entries) ? record.entries : [];
      return `记忆 ${String(entries.length)} 条，revision=${String(record.storeRevision ?? "?")}`;
    });
  });
}

export async function memorySearchCommand(workspaceRoot: string, query: string, selectorInput: string, options: LocalCapabilityOutputOptions = {}): Promise<void> {
  await withHost(workspaceRoot, options, async (client) => {
    const result = await client.memory("search-v3", { query, selector: memorySelector(selectorInput), limit: 20 });
    printResult(result, options.json, (value) => JSON.stringify(value, null, 2));
  });
}

export async function memoryAddCommand(workspaceRoot: string, entryJson: string, options: LocalCapabilityOutputOptions = {}): Promise<void> {
  const entry = JSON.parse(entryJson) as Record<string, unknown>;
  const audience = entry.audience === "universal" ? "universal" : "workspace";
  const summary = typeof entry.summary === "string" ? entry.summary : "";
  const kind = isMemoryKind(entry.kind) ? entry.kind : audience === "universal" ? "preference" : "fact";
  const topic = typeof entry.topic === "string" ? entry.topic : "cli";
  const title = typeof entry.title === "string" ? entry.title : summary.slice(0, 60);
  await withHost(workspaceRoot, options, async (client) => {
    const overview = await client.memory<{ overview: { storeRevision: number } }>("overview-v3", { selector: "all" });
    const result = await client.memory("write-v3", {
      expectedRevision: overview.overview.storeRevision,
      entry: {
        audience,
        kind,
        topic,
        title,
        summary,
        decisions: Array.isArray(entry.decisions) ? entry.decisions : undefined,
        paths: Array.isArray(entry.paths) ? entry.paths : undefined,
        keywords: Array.isArray(entry.keywords) ? entry.keywords : undefined,
        importance: typeof entry.importance === "number" ? entry.importance : undefined,
        durability: entry.durability === "temporary" ? "temporary" : "permanent",
        lineage: {
          source: "explicit",
          externalContext: false,
          userEvidence: audience === "universal" ? summary : undefined
        }
      }
    });
    printResult(result, options.json, (value) => JSON.stringify(value, null, 2));
  });
}

export async function memoryArchiveCommand(workspaceRoot: string, id: string, options: LocalCapabilityOutputOptions & { yes?: boolean } = {}): Promise<void> {
  requireConfirmation(options.yes, "归档记忆会改变召回结果");
  await withHost(workspaceRoot, options, async (client) => {
    const overview = await client.memory<{ overview: { storeRevision: number } }>("overview-v3", { selector: "all" });
    const result = await client.memory("archive-v3", { id, archived: true, expectedRevision: overview.overview.storeRevision });
    printResult(result, options.json, (value) => JSON.stringify(value, null, 2));
  });
}

export async function memoryClearCommand(workspaceRoot: string, selectorInput: string, options: LocalCapabilityOutputOptions & { yes?: boolean } = {}): Promise<void> {
  requireConfirmation(options.yes, "清理记忆会删除当前和归档条目");
  await withHost(workspaceRoot, options, async (client) => {
    const overview = await client.memory<{ overview: { storeRevision: number } }>("overview-v3", { selector: "all" });
    const result = await client.memory("clear-v3", { selector: memorySelector(selectorInput), expectedRevision: overview.overview.storeRevision });
    printResult(result, options.json, (value) => JSON.stringify(value, null, 2));
  });
}

export async function memorySleepCommand(workspaceRoot: string, options: LocalCapabilityOutputOptions & { run?: boolean; yes?: boolean } = {}): Promise<void> {
  if (options.run) {
    requireConfirmation(options.yes, "Sleep 可能归档重复或过期记忆");
    await withHost(workspaceRoot, options, async (client) => {
      const result = await client.runMemorySleep();
      printResult(result, options.json, (value) => JSON.stringify(value, null, 2));
    });
    return;
  }
  await withHost(workspaceRoot, options, async (client) => {
    const result = await client.memorySleepStatus();
    printResult(result, options.json, (value) => JSON.stringify(value, null, 2));
  });
}

export async function diaryShowCommand(_workspaceRoot: string, dateInput: string, options: LocalCapabilityOutputOptions = {}): Promise<void> {
  const dateKey = resolveDateKey(dateInput);
  const content = await readDailyMemoryNote(dateKey, { configDir: globalConfigDir() });
  const result = { dateKey, content };
  printResult(result, options.json, (value) => {
    const record = asRecord(value);
    return typeof record.content === "string" ? record.content : `没有 ${String(record.dateKey)} 的日报记录。`;
  });
}

export async function diaryRefreshCommand(workspaceRoot: string, dateInput: string, options: LocalCapabilityOutputOptions & { force?: boolean } = {}): Promise<void> {
  const dateKey = resolveDateKey(dateInput);
  await withHost(workspaceRoot, options, async (client) => {
    const result = await client.refreshDailyDiary(dateKey, options.force === true);
    printResult(result, options.json, (value) => JSON.stringify(value, null, 2));
  });
}

export async function reflectionStatusCommand(_workspaceRoot: string, dateInput: string, options: LocalCapabilityOutputOptions = {}): Promise<void> {
  const dateKey = resolveDateKey(dateInput);
  const note = await readDailyMemoryNote(dateKey, { configDir: globalConfigDir() });
  const reflection = note === undefined ? undefined : readDailyMemorySection(note, "自我反思");
  printResult({ dateKey, exists: reflection !== undefined, reflection }, options.json, (value) => {
    const record = asRecord(value);
    return record.exists === true
      ? typeof record.reflection === "string" ? record.reflection : "已有反思记录。"
      : "还没有反思记录。";
  });
}

export async function reflectionRunCommand(workspaceRoot: string, dateInput: string, options: LocalCapabilityOutputOptions & { force?: boolean } = {}): Promise<void> {
  const dateKey = resolveDateKey(dateInput);
  await withHost(workspaceRoot, options, async (client) => {
    const result = await client.reflectionRun(dateKey, options.force === true);
    printResult(result, options.json, (value) => JSON.stringify(value, null, 2));
  });
}

export async function heartbeatStatusCommand(workspaceRoot: string, options: LocalCapabilityOutputOptions = {}): Promise<void> {
  await withHost(workspaceRoot, options, async (client) => {
    const result = await client.heartbeatStatus();
    printResult(result, options.json, (value) => JSON.stringify(value, null, 2));
  });
}

export async function heartbeatRunCommand(workspaceRoot: string, options: LocalCapabilityOutputOptions = {}): Promise<void> {
  await withHost(workspaceRoot, options, async (client) => {
    const result = await client.heartbeatRun();
    printResult(result, options.json, (value) => JSON.stringify(value, null, 2));
  });
}

export async function heartbeatShowCommand(_workspaceRoot: string, options: LocalCapabilityOutputOptions = {}): Promise<void> {
  const content = await new HeartbeatFileStore(globalConfigDir()).read();
  printResult({ content }, options.json, (value) => {
    const record = asRecord(value);
    return typeof record.content === "string" ? record.content : "还没有 HEARTBEAT.md。运行 `biny heartbeat run` 会使用内置清单。";
  });
}

export async function todoShowCommand(workspaceRoot: string, sessionInput: string | undefined, options: LocalCapabilityOutputOptions = {}): Promise<void> {
  const store = await openTodoStore(workspaceRoot, sessionInput);
  const result = { sessionId: sessionInput ?? "latest", todos: store.list() };
  printResult(result, options.json, (value) => {
    const todos = asRecord(value).todos;
    return Array.isArray(todos) && todos.length ? JSON.stringify(todos, null, 2) : "当前 session 没有 Todo。";
  });
}

export async function todoReplaceCommand(workspaceRoot: string, sessionInput: string | undefined, todosJson: string, options: LocalCapabilityOutputOptions = {}): Promise<void> {
  const store = await openTodoStore(workspaceRoot, sessionInput);
  const parsed = JSON.parse(todosJson) as unknown;
  const todos = Array.isArray(parsed) ? parsed : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { todos?: unknown }).todos) ? (parsed as { todos: unknown[] }).todos : [];
  const result = await store.replace(todos as TodoItem[]);
  printResult({ todos: result }, options.json, (value) => JSON.stringify(asRecord(value).todos, null, 2));
}

export async function todoClearCommand(workspaceRoot: string, sessionInput: string | undefined, options: LocalCapabilityOutputOptions & { yes?: boolean } = {}): Promise<void> {
  requireConfirmation(options.yes, "清空当前 session Todo");
  const store = await openTodoStore(workspaceRoot, sessionInput);
  const result = await store.replace([]);
  printResult({ todos: result }, options.json, () => "当前 session Todo 已清空。");
}

async function openTodoStore(workspaceRoot: string, sessionInput: string | undefined): Promise<TodoStore> {
  const file = await resolveSessionFile(workspaceRoot, sessionInput ?? "latest");
  const store = new TodoStore(workspaceRoot, sessionIdFromFile(file));
  await store.initialize();
  return store;
}

async function withHost<T>(workspaceRoot: string, options: LocalCapabilityOutputOptions, action: (client: RuntimeHostClient) => Promise<T>): Promise<void> {
  const client = options.noSpawn
    ? await connectRuntimeHost(workspaceRoot, { surface: "cli", clientId: `cli-${process.pid}` })
    : await connectOrSpawnRuntimeHost(workspaceRoot, {
      workspaceRoot,
      surface: "cli",
      clientId: `cli-${process.pid}`,
      resumeInterrupted: false
    });
  if (!client) throw new Error("Runtime Host is not running. Start it with `biny daemon run` or omit --no-spawn.");
  try {
    const value = await action(client);
    if (isRejected(value)) throw new Error(value.reason ?? "Runtime operation was rejected.");
  } finally {
    await client.close();
  }
}

function printResult(value: unknown, json: boolean | undefined, plain: (value: unknown) => string): void {
  if (isRejected(value)) throw new Error(value.reason ?? "Runtime operation was rejected.");
  console.log(json ? JSON.stringify(value) : plain(value));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function isRejected(value: unknown): value is { accepted: false; reason?: string } {
  return typeof value === "object" && value !== null && (value as { accepted?: unknown }).accepted === false;
}

function requireConfirmation(yes: boolean | undefined, action: string): void {
  if (!yes) throw new Error(`${action}；请加 --yes 确认。`);
}

function memorySelector(value: string): MemoryOriginSelector {
  if (value === "current") return "current_workspace";
  if (value === "other") return "other_workspaces";
  if (value === "all" || value === "user" || value === "current_workspace" || value === "other_workspaces") return value;
  throw new Error(`未知记忆范围：${value}`);
}

function isMemoryKind(value: unknown): value is MemoryKind {
  return value === "preference" || value === "working_style" || value === "fact" || value === "decision" || value === "workflow" || value === "gotcha";
}

function resolveDateKey(value: string): string {
  const now = new Date();
  if (value === "today") return formatDate(now);
  if (value === "yesterday") return formatDate(new Date(now.getTime() - 86_400_000));
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error(`日期必须是 today、yesterday 或 YYYY-MM-DD：${value}`);
  return value;
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
