import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { createActivityMemoryPipeline } from "../src/activity/memoryPipeline.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { CrystalStorage } from "../src/agent/context/crystalStorage.js";
import type { AgentModel } from "../src/agent/core/types.js";
import type { ActivitySessionAnalysis } from "../src/activity/store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-memory-pipeline-"));
const previousAgentDir = process.env[BINY_AGENT_DIR_ENV];
process.env[BINY_AGENT_DIR_ENV] = path.join(root, "agent");

const model: AgentModel = {
  provider: "test",
  modelId: "activity-test",
  stream: async () => (async function* () {
    yield { type: "finish" as const, reason: "stop" as const };
  })()
};

try {
  const pipeline = await createActivityMemoryPipeline({
    workspaceRoot: root,
    getCrystalConfig: () => ({
      passiveEnabled: false,
      semanticScanEnabled: false,
      contour: { count: 1, turns: 1, spread: 1 },
      nucleus: { count: 2, turns: 2, spread: 1 },
      dormantDays: 14
    })
  });
  try {
    await pipeline.writeMemories([{
      type: "project",
      content: "Project Delta uses a staged release checklist before every deployment.",
      why: "Repeated release decision"
    }], {
      sessionId: "activity-session-1",
      analyzedAt: "2026-09-07T10:00:00.000Z",
      project: "Project Delta",
      model
    });

    const memory = new MemoryStorage(root);
    try {
      const entries = await memory.listEntries({ origins: ["current_workspace"] });
      assert.equal(entries.entries.length, 1);
      assert.equal(entries.entries[0]?.activitySessionId, "activity-session-1");
    } finally {
      memory.close();
    }

    const analysis: ActivitySessionAnalysis = {
      sessionId: "activity-session-1",
      analyzedAt: "2026-09-07T10:00:00.000Z",
      analyzerModel: model.modelId,
      analysisStatus: "analyzed",
      project: "Project Delta",
      title: "Release work",
      description: "Release work",
      summary: "Project Delta uses a staged release checklist before every deployment.",
      topics: ["Project Delta"],
      prs: [],
      issues: [],
      people: [],
      versions: [],
      decisions: [],
      entities: ["Project Delta"],
      highlights: ["Project Delta"],
      worthMemory: true,
      worthKnowledge: true,
      isMeeting: false,
      storageTier: "standard",
      confidence: 0.9,
      sourceEventCount: 2,
      inputHash: "hash-1"
    };
    const session = {
      id: "activity-session-1",
      startedAt: "2026-09-07T10:00:00.000Z",
      endedAt: "2026-09-07T10:10:00.000Z",
      eventCount: 2,
      durationMs: 600_000,
      snapshotCount: 1
    };
    assert.equal(await pipeline.onAnalyzed(analysis, session), undefined);
    await pipeline.onAnalyzed(analysis, session);
    assert.equal(await pipeline.onAnalyzed({ ...analysis, sessionId: "activity-session-2", inputHash: "hash-2" }, {
      ...session,
      id: "activity-session-2",
      startedAt: "2026-09-08T10:00:00.000Z",
      endedAt: "2026-09-08T10:10:00.000Z"
    }), undefined);
  } finally {
    pipeline.close();
  }

  const crystals = new CrystalStorage();
  await crystals.initialize();
  try {
    const term = crystals.listTerms().find((candidate) => candidate.term === "project delta");
    assert.equal(term?.count, 2);
    assert.equal(term?.status, "nucleus");
    assert.ok(term?.crystalId);
    assert.equal(crystals.listMaterials(term!.crystalId!).length, 2);
    assert.equal(crystals.listCrystals().length, 1);
  } finally {
    crystals.close();
  }
} finally {
  if (previousAgentDir === undefined) delete process.env[BINY_AGENT_DIR_ENV];
  else process.env[BINY_AGENT_DIR_ENV] = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}

console.log("activity memory pipeline tests passed");
