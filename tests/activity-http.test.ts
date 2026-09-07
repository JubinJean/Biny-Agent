import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultActivitySettings, type ActivitySettings } from "../src/activity/settings.js";
import { handleActivityHttpRequest, startActivityHttpServer } from "../src/activity/httpServer.js";
import { ActivityStore } from "../src/activity/store.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";

await testActivityHttpServerExposesLoopbackQueries();
await testActivityHttpReportProjectsMemoryCallbacks();

async function testActivityHttpServerExposesLoopbackQueries(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-http-"));
  const settings: ActivitySettings = { ...defaultActivitySettings, outputDirectory: root };
  const store = new ActivityStore();
  try {
    await store.open(root);
    const sessionId = store.startSession("2026-08-31T09:00:00.000Z");
    store.recordEvent({
      sessionId,
      occurredAt: "2026-08-31T09:00:01.000Z",
      eventType: "window_title",
      application: "Editor",
      windowTitle: "中文检索 API"
    });
    const direct = await handleActivityHttpRequest(
      { method: "GET", pathname: "/api/activity-recorder/search", searchParams: new URLSearchParams("query=中文") },
      { loadSettings: async () => settings }
    );
    assert.equal(direct.status, 200);
    assert.equal((direct.body as Array<unknown>).length, 1);
  } finally {
    await store.close();
  }

  const api = await startActivityHttpServer({ loadSettings: async () => settings });
  try {
    const response = await fetch("http://" + api.host + ":" + String(api.port) + "/api/activity-recorder/status");
    assert.equal(response.status, 200);
    const status = await response.json() as { state: string; sessions: number };
    assert.equal(status.state, "unavailable");
    assert.equal(status.sessions, 1);
  } finally {
    await api.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testActivityHttpReportProjectsMemoryCallbacks(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-http-report-"));
  const settings: ActivitySettings = { ...defaultActivitySettings, outputDirectory: root };
  const store = new ActivityStore();
  try {
    await store.open(root);
    const sessionId = store.startSession("2026-08-31T09:00:00.000Z");
    for (let index = 0; index < 3; index += 1) {
      store.recordEvent({
        sessionId,
        occurredAt: `2026-08-31T09:0${index}:00.000Z`,
        eventType: "focus_changed",
        application: "Editor",
        windowTitle: "Activity memory pipeline",
        rawText: `event ${String(index)}`
      });
    }
    store.endSession(sessionId, "2026-08-31T10:00:00.000Z");
  } finally {
    await store.close();
  }

  let memoryWrites = 0;
  let analyzedCallbacks = 0;
  const model: AgentModel = {
    provider: "test",
    modelId: "activity-http-test",
    runtime: "builtin-llama.cpp",
    dataResidency: "local",
    stream: async () => (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield {
        type: "text-delta",
        text: JSON.stringify({
          worth: true,
          project: "biny",
          title: "Activity pipeline",
          description: "Activity pipeline test.",
          summary: "Activity pipeline test.",
          topics: ["memory"],
          memoryCandidates: [{ type: "project", content: "Activity reports feed long-term memory.", why: "Pipeline integration test" }],
          worthMemory: true,
          confidence: 0.9
        })
      };
      yield { type: "finish", reason: "stop" };
    })()
  };

  try {
    const response = await handleActivityHttpRequest(
      {
        method: "GET",
        pathname: "/api/activity-recorder/report/2026-08-31"
      },
      {
        loadSettings: async () => settings,
        getModel: () => model,
        writeMemories: async () => {
          memoryWrites += 1;
        },
        onAnalyzed: async () => {
          analyzedCallbacks += 1;
        }
      }
    );
    assert.equal(response.status, 200);
    assert.equal((response.body as { analyzedNow: number }).analyzedNow, 1);
    assert.equal(memoryWrites, 1);
    assert.equal(analyzedCallbacks, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
