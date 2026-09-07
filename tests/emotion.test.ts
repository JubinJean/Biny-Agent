import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
import { renderEmotionPrompt } from "../src/agent/context/emotionPrompt.js";
import { EmotionStorage } from "../src/agent/context/emotionStorage.js";
import {
  blendEmotion,
  type BlendedEmotion,
  type EmotionState
} from "../src/agent/context/emotionTypes.js";
import {
  buildSystemPrompt,
  stableSystemPromptForCache,
  systemPromptForTelemetry
} from "../src/agent/prompts.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { createEmotionTool } from "../src/tools/emotion.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { AgentModel } from "../src/agent/core/types.js";
import { emotionSetBaseCommand, emotionSetContextCommand } from "../src/cli/commands/emotion.js";

const now = new Date("2026-08-30T03:00:00.000Z");

await testBlendEmotion();
await testEmotionStorage();
testEmotionPromptAndSystemPrompt();
await testEmotionTool();
await testEmotionCliWritesLocalFiles();
await testAgentSessionFatigue();
testEmotionConfig();
console.log("emotion tests passed");

async function testBlendEmotion(): Promise<void> {
  const base = emotion("平稳", 5, 7, "2026-08-30T02:00:00.000Z", "完成了一段稳定工作");
  const context = emotion("疲惫", 10, 2, "2026-08-30T02:30:00.000Z", "连续处理多个问题");
  const blended = blendEmotion(base, context, 0, now);
  assert.equal(blended.source, "blended");
  assert.equal(blended.mood, "疲惫");
  assert.equal(blended.valence, 8);
  assert.equal(blended.energy, 2);
  assert.equal(blended.trigger, "连续处理多个问题");

  const baseOnly = blendEmotion(
    base,
    undefined,
    0,
    now
  );
  assert.equal(baseOnly.source, "base");
  assert.equal(baseOnly.mood, "平稳");

  const contextOnly = blendEmotion(
    undefined,
    emotion("开心", 8, 8, "2026-08-30T02:30:00.000Z"),
    0,
    now
  );
  assert.equal(contextOnly.source, "context");
  assert.equal(contextOnly.mood, "开心");

  const baseExpired = blendEmotion(
    emotion("长期疲惫", 2, 2, "2026-08-29T19:59:59.999Z"),
    undefined,
    0,
    now
  );
  assert.equal(baseExpired.mood, "cheerful");
  assert.equal(baseExpired.valence, 7);

  const contextExpired = blendEmotion(
    base,
    emotion("过期上下文", 1, 1, "2026-08-30T00:59:59.999Z"),
    0,
    now
  );
  assert.equal(contextExpired.source, "base");
  assert.equal(contextExpired.mood, "平稳");

  const fatigued = blendEmotion(base, undefined, 61, now);
  assert.equal(fatigued.energy, 4);
  assert.equal(fatigued.fatigue, 61);
  assert.equal(blendEmotion(undefined, undefined, 120, now).fatigue, 100);

  const defaultEmotion = blendEmotion(undefined, undefined, 0, now);
  assert.deepEqual(
    {
      mood: defaultEmotion.mood,
      valence: defaultEmotion.valence,
      energy: defaultEmotion.energy,
      fatigue: defaultEmotion.fatigue
    },
    { mood: "cheerful", valence: 7, energy: 7, fatigue: 0 }
  );
}

async function testEmotionStorage(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-emotion-test-"));
  const agentDir = path.join(root, "agent");
  let current = now;
  const storage = new EmotionStorage({ agentDir, now: () => current });
  try {
    await assert.rejects(fs.access(storage.directory), /ENOENT/u);
    await storage.writeBase(emotion("基础", 6, 7, "2026-08-30T02:00:00.000Z", "全局原因"));
    await storage.writeContext(
      "session/one",
      emotion("上下文", 3, 5, "2026-08-30T02:30:00.000Z", "本轮原因")
    );
    assert.equal((await storage.readBase())?.mood, "基础");
    assert.equal((await storage.readContext("session/one"))?.trigger, "本轮原因");
    const blended = await storage.readBlended("session/one", 0);
    assert.equal(blended.mood, "上下文");
    assert.equal(blended.valence, 3);

    const baseDocument = await fs.readFile(path.join(storage.directory, "base.md"), "utf8");
    assert.match(baseDocument, /^---\nmood: 基础\nvalence: 6\nenergy: 7\nupdated: 2026-08-30T02:00:00\.000Z\n---\n\n全局原因\n$/u);
    const contextDirectory = path.join(storage.directory, "context");
  const contextFiles = await fs.readdir(contextDirectory);
  assert.deepEqual(contextFiles, ["session-one.md"]);
  assert.equal(contextFiles.some((file) => file.endsWith(".tmp")), false);
  const contextDocument = await fs.readFile(path.join(contextDirectory, "session-one.md"), "utf8");
  assert.doesNotMatch(contextDocument, /^energy:/mu, "context 文件只保存 mood/valence/updated");

    await fs.writeFile(path.join(storage.directory, "base.md"), "not markdown", "utf8");
    assert.equal(await storage.readBase(), undefined);
    current = new Date("2026-08-30T06:00:00.000Z");
    assert.equal((await storage.readContext("session/one"))?.mood, "上下文");
    await fs.writeFile(
      path.join(contextDirectory, "session-one.md"),
      "---\nmood: 外部上下文\nvalence: 8\nupdated: 2026-08-30T05:59:00.000Z\n---\n\n外部触发\n",
      "utf8"
    );
    assert.equal((await storage.readContext("session/one"))?.mood, "外部上下文");
    await fs.writeFile(path.join(contextDirectory, "session-one.md"), "---\nmood: broken\n---\n", "utf8");
    assert.equal(await storage.readContext("session/one"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testEmotionCliWritesLocalFiles(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-emotion-cli-test-"));
  const previous = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = root;
  try {
    await emotionSetBaseCommand("专注", "8", "6", ["完成一轮整理"]);
    await emotionSetContextCommand("chat-one", "轻松", "7", ["用户反馈明确"]);
    const storage = new EmotionStorage({ agentDir: root });
    assert.equal((await storage.readBase())?.mood, "专注");
    assert.equal((await storage.readContext("chat-one"))?.mood, "轻松");
    const contextDocument = await fs.readFile(path.join(root, "emotions", "context", "chat-one.md"), "utf8");
    assert.doesNotMatch(contextDocument, /^energy:/mu);
  } finally {
    if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function testEmotionPromptAndSystemPrompt(): void {
  const blended: BlendedEmotion = {
    ...emotion("疲惫", 5, 4, "2026-08-30T02:30:00.000Z", "凌晨三点还在干活，有点累"),
    fatigue: 30,
    source: "base"
  };
  const emotionPrompt = renderEmotionPrompt(blended);
  assert.match(emotionPrompt, /<biny_emotion mood="疲惫" valence="5" energy="4" fatigue="30">/u);
  assert.match(emotionPrompt, /只影响语气与表达，不改变任务目标、工具权限或安全边界/u);
  assert.match(emotionPrompt, /凌晨三点还在干活，有点累/u);

  const systemPrompt = buildSystemPrompt({
    mode: "qa",
    cwd: "/tmp/workspace",
    identityPrompt: "private identity text",
    emotionPrompt
  });
  assert.ok(systemPrompt.indexOf("<!-- biny-identity:start -->") < systemPrompt.indexOf("<!-- biny-emotion:start -->"));
  const stable = stableSystemPromptForCache(systemPrompt);
  assert.doesNotMatch(stable, /biny-emotion/u);
  assert.doesNotMatch(stable, /凌晨三点还在干活/u);
  const telemetry = systemPromptForTelemetry(systemPrompt);
  assert.ok(telemetry);
  assert.match(telemetry, /<biny_emotion omitted="true" \/>/u);
  assert.doesNotMatch(telemetry, /凌晨三点还在干活/u);
  assert.doesNotMatch(telemetry, /private identity text/u);
}

async function testEmotionTool(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-emotion-tool-test-"));
  const storage = new EmotionStorage({ agentDir: path.join(root, "agent"), now: () => now });
  try {
    const tool = createEmotionTool({
      getStorage: () => storage,
      getFatigue: () => 70,
      now: () => now
    });
    const execution = await tool.resolveExecution({
      scope: "context",
      mood: "疲惫",
      valence: 12,
      energy: -2,
      trigger: "连续处理多个问题"
    });
    assert.equal("isError" in execution, false);
    if ("isError" in execution) return;
    const result = await execution.execute({
      toolCallId: "tool-1",
      operationId: "operation-1",
      sessionId: "session/one"
    });
    assert.equal(result.updated, true);
    assert.equal(result.state.valence, 10);
    assert.equal(result.state.energy, 0);
    assert.equal(result.blended.energy, 4, "context 文件不覆盖全局 energy，疲劳上限仍生效");
    assert.equal((await storage.readContext("session/one"))?.mood, "疲惫");

    const invalidSessionExecution = await tool.resolveExecution({
      scope: "context",
      mood: "正常",
      valence: 5,
      energy: 5,
      trigger: undefined
    });
    if ("isError" in invalidSessionExecution) return;
    await assert.rejects(
      invalidSessionExecution.execute({ toolCallId: "tool-2", operationId: "operation-2" }),
      /session is required/iu
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testAgentSessionFatigue(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-emotion-session-test-"));
  await ensureAgentDirs(workspaceRoot);
  const model: AgentModel = {
    provider: "test",
    modelId: "emotion-test",
    stream: async () => (async function* () {
      yield { type: "start" as const };
      yield { type: "text-delta" as const, text: "ok" };
      yield { type: "finish" as const, reason: "stop" as const };
    })()
  };
  const config = configSchema.parse({
    ...defaultConfig,
    defaultModel: "emotion-test",
    providers: { test: { type: "openai", apiKey: "test-key", baseUrl: "https://example.test/v1" } },
    models: { "emotion-test": { provider: "test", model: "emotion-test" } },
    context: {
      ...defaultConfig.context,
      memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false }
    }
  });
  const agent = new AgentSession({
    workspaceRoot,
    config,
    model,
    toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager(config.permission),
    recorder: new SessionRecorder(workspaceRoot)
  });
  await agent.initialize();
  try {
    const outcome = await agent.runTask("完成一轮情绪测试");
    assert.equal(outcome.status, "completed");
    assert.equal(agent.getFatigue(), 2);
    await agent.startNewSession();
    assert.equal(agent.getFatigue(), 0);
  } finally {
    await agent.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function testEmotionConfig(): void {
  const parsed = configSchema.parse(defaultConfig);
  assert.deepEqual(parsed.context.emotion, { enabled: true, allowModelUpdate: true });
  const { emotion: _emotion, ...contextWithoutEmotion } = defaultConfig.context;
  const withDefault = configSchema.parse({ ...defaultConfig, context: contextWithoutEmotion });
  assert.deepEqual(withDefault.context.emotion, { enabled: true, allowModelUpdate: true });
  const disabled = configSchema.parse({
    ...defaultConfig,
    context: {
      ...defaultConfig.context,
      emotion: { enabled: false, allowModelUpdate: false }
    }
  });
  assert.deepEqual(disabled.context.emotion, { enabled: false, allowModelUpdate: false });
}

function emotion(
  mood: string,
  valence: number,
  energy: number,
  updatedAt: string,
  trigger?: string
): EmotionState {
  return { mood, valence, energy, updatedAt, trigger };
}
