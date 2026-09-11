import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { saveConfig } from "../src/config/loader.js";
import { EmotionStorage } from "../src/agent/context/emotionStorage.js";
import { spawnRuntimeHost, type SpawnedRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionFilePath } from "../src/session/store.js";
import { readSessionCatalogRecord } from "../src/session/catalog.js";
import { sessionMessageMetadata } from "../src/session/messageTree.js";

await testRuntimeHostUpdatesEmotion();
console.log("emotion runtime tests passed");

async function testRuntimeHostUpdatesEmotion(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-emotion-runtime-"));
  const agentDir = path.join(root, "agent");
  const configDir = path.join(root, "config");
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  let provider: ProviderServer | undefined;
  let spawned: SpawnedRuntimeHost | undefined;
  process.env.BINY_AGENT_DIR = agentDir;

  try {
    provider = await startProviderServer();
    await saveConfig(root, testConfig(provider.endpoint), { globalDir: configDir });
    spawned = await spawnRuntimeHost(root, {
      workspaceRoot: root,
      configDir,
      resumeInterrupted: false,
      clientId: "emotion-runtime-test",
      surface: "cli"
    });

    const sessionId = spawned.client.getSnapshot().info.sessionId;
    const titleGenerated = new Promise<string>((resolve) => {
      const unsubscribe = spawned!.client.subscribe(({ event }) => {
        if (event?.type !== "session.title") return;
        assert.equal(event.sessionId, sessionId);
        unsubscribe();
        resolve(event.title);
      });
    });
    const outcome = await withTimeout(
      spawned.client.submitPrompt("记录一次情绪变化，然后正常回复。", "chat").completion,
      15_000,
      "Runtime Host emotion completion"
    );
    assert.equal(outcome.status, "completed", JSON.stringify(outcome));
    assert.equal(outcome.output, "情绪状态已更新。");
    assert.equal(provider.requestCount, 2, "the provider should receive the tool step and the final step");
    assert.equal(await withTimeout(titleGenerated, 5_000, "Session title event"), "情绪状态记录");
    assert.equal((await readSessionCatalogRecord(root, sessionId))?.title, "情绪状态记录");

    const storage = new EmotionStorage({ configDir: agentDir });
    const context = await storage.readContext(sessionId);
    assert.deepEqual(context && {
      mood: context.mood,
      valence: context.valence,
      energy: context.energy,
      trigger: context.trigger
    }, {
      mood: "专注",
      valence: 8,
      energy: 7,
      trigger: "完成一次 Host smoke"
    });

    const events = await readSessionEvents(sessionFilePath(root, sessionId));
    assert.ok(events.some((event) => event.type === "tool_call" && event.tool === "update_emotion"));
    assert.ok(events.some((event) => event.type === "tool_result" && event.tool === "update_emotion"));
    const user = events.find((event) => event.type === "user_message");
    assert.ok(user?.type === "user_message" && user.messageId);
    assert.deepEqual(sessionMessageMetadata(events, user.messageId).capabilitySelection, { tools: ["update_emotion", "read_tool_result"], skills: [] });
    const target = events.filter((event) => event.type === "agent_message" && event.message.role === "assistant").at(-1);
    assert.ok(target?.type === "agent_message" && target.messageId);
    const selectionsBeforeRetry = provider.selectionCount;
    const retry = await withTimeout(spawned.client.submitPrompt("重新生成", "chat", [], { retryOfMessageId: target.messageId }).completion, 15_000, "Retry with selected capabilities");
    assert.equal(retry.status, "completed");
    assert.equal(provider.selectionCount, selectionsBeforeRetry, "重试沿用持久化能力名单，不重新筛选或启用全部");
    const next = await withTimeout(spawned.client.submitPrompt("继续记录。", "chat").completion, 15_000, "Accumulated tool selection");
    assert.equal(next.output, "情绪状态已更新。");
    assert.equal(provider.selectionCount, selectionsBeforeRetry + 1);
    assert.equal(provider.requestCount, 4, "新轮筛选为空时仍从消息元数据恢复之前的工具");
    await spawned.client.close();
  } finally {
    await spawned?.client.close().catch(() => undefined);
    await stopHost(spawned?.process.pid);
    await provider?.close();
    restoreAgentDir(previousAgentDir);
    await rm(root, { recursive: true, force: true });
  }
}

interface ProviderServer {
  endpoint: string;
  requestCount: number;
  selectionCount: number;
  close(): Promise<void>;
}

async function startProviderServer(): Promise<ProviderServer> {
  let requestCount = 0;
  let selectionCount = 0;
  const server = createServer(async (request, response) => {
    const body = await readRequest(request);
    if (JSON.stringify(body.messages).includes("skillIds")) {
      selectionCount += 1;
      sendProviderText(response, JSON.stringify({ tools: selectionCount === 1 ? ["update_emotion"] : [], skillIds: [] }));
      return;
    }
    // 自动标题等辅助请求不执行工具，也不计入正文的两步工具回合。
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      sendProviderText(response, "情绪状态记录");
      return;
    }
    requestCount += 1;
    if (requestCount === 1) sendEmotionToolCall(response);
    else sendProviderText(response, "情绪状态已更新。");
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Emotion provider did not bind a TCP port.");
  return {
    endpoint: `http://127.0.0.1:${String(address.port)}/v1`,
    get requestCount(): number { return requestCount; },
    get selectionCount(): number { return selectionCount; },
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

function testConfig(endpoint: string): AgentConfig {
  return configSchema.parse({
    ...defaultConfig,
    defaultModel: "local-test",
    providers: {
      local: {
        type: "openai-compatible",
        baseUrl: endpoint,
        requiresApiKey: false,
        retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 }
      }
    },
    models: {
      "local-test": {
        ...defaultConfig.models["deepseek-v4-flash"],
        provider: "local",
        model: "local-test",
        displayName: "Local Emotion Provider",
        contextWindow: 128_000,
        capabilities: { tools: true, reasoning: false, streaming: true }
      }
    },
    permission: { ...defaultConfig.permission, mode: "full-access", criticalAlwaysAsk: false },
    context: {
      ...defaultConfig.context,
      memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false }
    }
  });
}

function sendEmotionToolCall(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "emotion-runtime-call", type: "function", function: { name: "update_emotion", arguments: JSON.stringify({ scope: "context", mood: "专注", valence: 8, energy: 6, trigger: "完成一次 Host smoke" }) } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
    "data: [DONE]\n\n"
  ].join(""));
}

function sendProviderText(response: ServerResponse, text: string): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n"
  ].join(""));
}

async function readRequest(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function stopHost(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Host 可能已经在优雅退出期间完成清理。
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${String(timeoutMs)}ms.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function restoreAgentDir(previous: string | undefined): void {
  if (previous === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previous;
}
