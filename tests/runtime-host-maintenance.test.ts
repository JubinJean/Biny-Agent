import assert from "node:assert/strict";
import { mock } from "node:test";
import { createRuntimeHostMemoryMaintenance } from "../src/runtime/host/maintenance.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import type { MemorySleepRun } from "../src/agent/context/memoryTypes.js";

const calls: string[] = [];
const runtime = {
  getSnapshot: () => ({ state: { kind: "idle" } }),
  runExclusiveOperation: async (
    _operation: string,
    execute: (signal: AbortSignal) => Promise<unknown>
  ) => await execute(new AbortController().signal)
} as unknown as InteractiveRuntimeHandle;
const localMemory = {
  loadMaintenanceStatus: async ({ signal }: { signal?: AbortSignal }) => {
    calls.push("load");
    signal?.throwIfAborted();
    return undefined;
  },
  runMemoryMaintenance: async (
    _options: unknown,
    derivedIndex: { requestRebuild?: () => void }
  ) => {
    calls.push("process");
    derivedIndex.requestRebuild?.();
    return undefined;
  },
  previewMaintenance: async () => ({
    available: true,
    entries: 1,
    temporaryToArchive: 0,
    archivedToDelete: 0,
    recentRuns: 0
  })
};
const commands = {
  agent: {
    getPersonalizationState: async () => ({ memory: { sleepTime: "00:00" } }),
    getLocalMemory: () => localMemory,
    indexMemoryEntry: async () => undefined,
    rebuildMemoryEmbeddingIndex: async () => { calls.push("rebuild"); }
  }
} as unknown as CommandRuntime;
const maintenance = createRuntimeHostMemoryMaintenance({
  getRuntime: () => runtime,
  getCommands: () => commands
});

maintenance.start();
await new Promise<void>((resolve) => setTimeout(resolve, 25));
assert.deepEqual(calls, ["load"]);
await new Promise<void>((resolve) => setTimeout(resolve, 5_050));
assert.deepEqual(calls, ["load", "process", "rebuild"]);

maintenance.stop();
const preview = await maintenance.preview();
assert.deepEqual(preview, { available: true, entries: 1, temporaryToArchive: 0, archivedToDelete: 0, recentRuns: 0 });
assert.equal(maintenance.cancel(), false);
maintenance.scheduleEmbeddingRebuild();
await new Promise<void>((resolve) => setTimeout(resolve, 10));
assert.deepEqual(calls, ["load", "process", "rebuild"]);

mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date(2026, 8, 6, 2, 59) });
calls.length = 0;
const notDue = createRuntimeHostMemoryMaintenance({
  getRuntime: () => runtime,
  getCommands: () => ({
    agent: {
      getPersonalizationState: async () => ({ memory: { sleepTime: "03:00" } }),
      getLocalMemory: () => localMemory,
      indexMemoryEntry: async () => undefined,
      rebuildMemoryEmbeddingIndex: async () => undefined
    }
  } as unknown as CommandRuntime)
});
try {
  notDue.start();
  mock.timers.tick(5_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["load"], "启动时应先恢复遗留的 Sleep 状态，即使当前还未到计划时间");
} finally {
  notDue.stop();
  mock.timers.reset();
}

const today = new Date();
for (const stopWhileLoading of [false, true]) {
  let release!: () => void;
  const configReady = new Promise<void>((resolve) => { release = resolve; });
  let executions = 0;
  const delayedCommands = {
    agent: {
      getPersonalizationState: async () => { await configReady; return {}; },
      getLocalMemory: () => ({
        loadMaintenanceStatus: async () => undefined,
        runMemoryMaintenance: async () => { executions += 1; }
      })
    }
  } as unknown as CommandRuntime;
  const delayed = createRuntimeHostMemoryMaintenance({ getRuntime: () => runtime, getCommands: () => delayedCommands });
  const firstRun = delayed.runNow();
  const secondRun = delayed.runNow();
  if (stopWhileLoading) delayed.stop();
  release();
  await Promise.all([firstRun, secondRun]);
  assert.equal(executions, stopWhileLoading ? 0 : 1);
  delayed.stop();
}
today.setHours(0, 0, 0, 0);
const yesterday = new Date(today);
yesterday.setDate(yesterday.getDate() - 1);
function runRecord(id: string, status: MemorySleepRun["status"], startedAt: Date, finishedAt: Date): MemorySleepRun {
  return {
    id, status, trigger: "scheduled", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
    examined: 0, written: 0, failed: 0, archived: 0, exact: 0, expired: 0, similarity: 0, llm: 0,
    archivedExact: 0, archivedExpired: 0, archivedOrphan: 0, archivedSimilarity: 0, archivedLlm: 0,
    inputTokens: 0, outputTokens: 0
  };
}
await Promise.all([
  { name: "yesterday start completed today", runs: [runRecord("old", "completed", yesterday, today)], expected: 1 },
  { name: "success before later failure", runs: [runRecord("success", "completed", today, today), runRecord("failure", "failed", new Date(today.getTime() + 1), today)], expected: 0 },
  { name: "three consecutive failures", runs: [0, 1, 2].map((index) => runRecord(`failed-${index}`, "failed", new Date(today.getTime() + index), today)), expected: 0 },
  { name: "completion outside latest ten does not suppress schedule", runs: [runRecord("old-success", "completed", today, today), ...Array.from({ length: 10 }, (_, index) => runRecord(`cancelled-${index}`, "cancelled", new Date(today.getTime() + index + 1), today))], expected: 1 },
  { name: "completion inside latest ten suppresses schedule", runs: [runRecord("recent-success", "completed", today, today), ...Array.from({ length: 9 }, (_, index) => runRecord(`cancelled-${index}`, "cancelled", new Date(today.getTime() + index + 1), today))], expected: 0 },
  { name: "cancel interrupts failure streak", runs: [runRecord("f1", "failed", today, today), runRecord("cancel", "cancelled", new Date(today.getTime() + 1), today), runRecord("f2", "failed", new Date(today.getTime() + 2), today)], expected: 1 }
].map(async ({ name, runs, expected }) => {
  let processed = 0;
  const scheduledCommands = {
    agent: {
      getPersonalizationState: async () => ({ memory: { sleepTime: "00:00" } }),
      getLocalMemory: () => ({
        loadMaintenanceStatus: async () => ({ state: "idle", sleepRuns: runs }),
        runMemoryMaintenance: async () => { processed += 1; }
      })
    }
  } as unknown as CommandRuntime;
  const scheduler = createRuntimeHostMemoryMaintenance({ getRuntime: () => runtime, getCommands: () => scheduledCommands });
  try {
    scheduler.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 5_100));
    assert.equal(processed, expected, name);
  } finally {
    scheduler.stop();
  }
}));

for (const sleepTime of [undefined, "invalid", "24:00", "03:60", "3:0", " 3:00 ", "03:00"]) {
  for (const hour of [2, 3]) {
    mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date(2026, 8, 6, hour, hour === 2 ? 59 : 0) });
    let processed = 0;
    const scheduledCommands = {
      agent: {
        getPersonalizationState: async () => ({ memory: { sleepTime } }),
        getLocalMemory: () => ({
          loadMaintenanceStatus: async () => undefined,
          runMemoryMaintenance: async () => { processed += 1; }
        })
      }
    } as unknown as CommandRuntime;
    const scheduler = createRuntimeHostMemoryMaintenance({ getRuntime: () => runtime, getCommands: () => scheduledCommands });
    try {
      scheduler.start();
      mock.timers.tick(5_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(processed, hour === 3 ? 1 : 0, `${sleepTime} at ${hour}`);
      if (hour === 2) {
        mock.timers.tick(54_999);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(processed, 0);
        mock.timers.tick(1);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(processed, 1, `${sleepTime} becomes due on the next minute tick`);
      }
    } finally {
      scheduler.stop();
      mock.timers.reset();
    }
  }
}

let releasePreview!: () => void;
let previewActive = false;
const previewPending = new Promise<void>((resolve) => { releasePreview = resolve; });
const previewCommands = {
  agent: {
    getLocalMemory: () => ({
      previewMaintenance: async () => { previewActive = true; await previewPending; return { skipped: "Cancelled by user" }; }
    }),
    cancelMemoryMaintenance: () => {
      if (!previewActive) return false;
      previewActive = false;
      releasePreview();
      return true;
    }
  }
} as unknown as CommandRuntime;
const previewOwner = createRuntimeHostMemoryMaintenance({ getRuntime: () => runtime, getCommands: () => previewCommands });
try {
  assert.equal(previewOwner.cancel(), false);
  const report = previewOwner.preview();
  assert.equal(previewActive, true);
  assert.equal(previewOwner.cancel(), true);
  assert.deepEqual(await report, { skipped: "Cancelled by user" });
  assert.equal(previewOwner.cancel(), false);
} finally {
  releasePreview();
  previewOwner.stop();
}

console.log("runtime-host maintenance tests passed");
