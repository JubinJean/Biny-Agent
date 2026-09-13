/** 使用真实文件、持久 session 和 stdio MCP 验证提交证据及崩溃边界。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import type { AgentToolEvent } from "../src/agent/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { McpToolHost } from "../src/extensions/mcp.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { readSessionEvents } from "../src/session/events.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { createToolRegistry, ToolRegistry } from "../src/tools/registry.js";
import { buildSessionTimeline } from "../src/desktop/renderer/src/sessionTimeline.js";
import { collectSessionChanges } from "../src/desktop/renderer/src/sessionChanges.js";

const script = fileURLToPath(import.meta.url);
const config = configSchema.parse({ ...defaultConfig, permission: { ...defaultConfig.permission, mode: "full-access" } });

async function setup(root: string, registry = createToolRegistry({ workspaceRoot: root, ignore: [] })) {
  process.env.BINY_AGENT_DIR = path.join(root, "agent-state");
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root, `file-change-${Date.now()}`);
  await recorder.recordAndFlush({ type: "user_message", content: "change file" });
  const updates: AgentToolEvent[] = [];
  const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry },
    new PermissionManager(config.permission), (event) => { if (event.type !== "error") updates.push(event); });
  const call = (name: string, args: Record<string, unknown>, id = `call-${updates.length}`) => coordinator.createAgentTools().find((tool) => tool.name === name)!.execute(id, args);
  return { recorder, coordinator, updates, call };
}

async function crashWorker(root: string, point: string): Promise<void> {
  const run = await setup(root);
  const original = run.recorder.recordAndFlush.bind(run.recorder);
  const pause = async (): Promise<never> => {
    process.stdout.write(`READY ${run.recorder.filePath}\n`);
    setInterval(() => undefined, 1_000);
    return await new Promise<never>(() => undefined);
  };
  run.recorder.recordAndFlush = async (event) => {
    if (point === "effect" && event.type === "tool_execution" && event.change) return await pause();
    const saved = await original(event);
    if (event.type === "tool_execution" && ((point === "before" && event.state === "not_started") || (point === "commit" && event.change))) return await pause();
    return saved;
  };
  await run.call("Write", { path: "target.txt", content: "after\n" });
}

async function testCrashBoundaries(): Promise<void> {
  for (const point of ["before", "effect", "commit"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-file-crash-"));
    const child = spawn(process.execPath, [...process.execArgv, script, "--crash", root, point], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      let stdout = "";
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      const ready = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Crash worker timed out: ${stderr}`)), 15_000);
        child.once("exit", () => { clearTimeout(timer); reject(new Error(`Worker exited: ${stderr}`)); });
        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
          const match = /READY (.+)\n/u.exec(stdout);
          if (match) { clearTimeout(timer); resolve(match[1]!); }
        });
      });
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      const events = await readSessionEvents(ready);
      const replay = replaySessionEvents(events);
      assert.equal(replay.recoveredToolResults[0]?.executionStatus, point === "before" ? "cancelled" : point === "effect" ? "unknown" : "succeeded");
      if (point !== "before") assert.equal(await readFile(path.join(root, "target.txt"), "utf8"), "after\n");
      if (point === "commit") {
        assert.equal((replay.recoveredToolResults[0]!.result as { change: { path: string } }).change.path, "target.txt");
        const changes = collectSessionChanges(buildSessionTimeline(replay.events, []));
        assert.equal(changes.length, 1);
        assert.equal(changes[0]?.changeCount, 1);
      }
      assert.equal(replaySessionEvents(replay.events).recoveredToolResults.length, 0);
    } finally {
      child.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function testPersistenceFailure(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-file-failure-"));
  const run = await setup(root);
  try {
    const original = run.recorder.recordAndFlush.bind(run.recorder);
    run.recorder.recordAndFlush = async (event) => {
      if (event.type === "tool_execution" && event.change) throw new Error("injected commit persistence failure");
      return await original(event);
    };
    const result = await run.call("Write", { path: "target.txt", content: "after\n" });
    assert.equal((result.details as { executionStatus: string }).executionStatus, "unknown");
    assert.equal(await readFile(path.join(root, "target.txt"), "utf8"), "after\n");
    assert.throws(() => run.coordinator.assertCanContinue(), /unknown side effect/);
    assert.equal(run.updates.some((event) => event.type === "tool.change_committed"), false);
    const replay = replaySessionEvents(await readSessionEvents(run.recorder.filePath));
    assert.equal(collectSessionChanges(buildSessionTimeline(replay.events, [])).length, 0);
  } finally { await run.recorder.close(); await rm(root, { recursive: true, force: true }); }
}

async function testLocalOperations(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-file-operations-"));
  const run = await setup(root);
  try {
    await run.call("Write", { path: "a.txt", content: "one\n" });
    await run.call("Write", { path: "a.txt", content: "two\n" });
    await run.call("Edit", { operation: "move", path: "a.txt", to: "b.txt" });
    await run.call("Edit", { operation: "delete", path: "b.txt" });
    const events = (await readSessionEvents(run.recorder.filePath)).map((event) => ({ ...event, runtime: undefined }));
    assert.deepEqual(events.flatMap((event) => event.type === "tool_execution" && event.change ? [event.change.operation] : []), ["create", "update", "move", "delete"]);
    assert.equal(run.updates.filter((event) => event.type === "tool.change_committed").length, 4);
    for (const event of events) {
      if (event.type !== "tool_result") continue;
      const result = event.result as Record<string, unknown>;
      assert.equal("diffPreview" in result, false);
      assert.equal("contentPreview" in result, false);
      assert.equal("changeSummary" in result, false);
    }
    const commitIndex = events.findIndex((event) => event.type === "tool_execution" && event.change);
    const commit = events[commitIndex]!;
    assert.equal(commit.type, "tool_execution");
    if (commit.type !== "tool_execution") throw new Error("missing commit");
    const cancelled = replaySessionEvents([...events.slice(0, commitIndex + 1), { ...commit, state: "cancel_requested", change: undefined }]);
    assert.equal(cancelled.recoveredToolResults[0]?.executionStatus, "succeeded");
    const partial = replaySessionEvents([...events.slice(0, commitIndex), { ...commit, fileChangeIsResult: false }]);
    assert.equal(partial.recoveredToolResults[0]?.executionStatus, "unknown");
    assert.throws(() => replaySessionEvents([...events.slice(0, commitIndex + 1), { ...commit, operationId: "forged" }]), /identity/);
  } finally { await run.recorder.close(); await rm(root, { recursive: true, force: true }); }
}

async function testMcpContract(): Promise<void> {
  for (const mode of ["ok", "version", "identity", "source", "path", "error", "text", "disconnect"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-file-mcp-"));
    const host = new McpToolHost();
    const registry = new ToolRegistry();
    const mcpConfig = configSchema.parse({ ...config, extensions: { ...config.extensions, mcp: { remote: {
      command: process.execPath, args: [fileURLToPath(new URL("./fixtures/file-change-mcp.mjs", import.meta.url))], cwd: ".",
      toolContracts: { change: "file-change-v1" }
    } } } });
    let run: Awaited<ReturnType<typeof setup>> | undefined;
    try {
      await host.connectConfiguredServers(root, mcpConfig, registry);
      assert.equal(host.listServers()[0]?.connected, true, host.listServers()[0]?.lastError);
      assert.equal(host.createTools()[0]?.parameters.required?.includes("operationId"), false);
      run = await setup(root, registry);
      const result = await run.call("mcp_remote_change", { operation: "create", path: "remote.txt", mode });
      assert.equal((await readFile(path.join(root, "calls.txt"), "utf8")).trim().split("\n").length, 1);
      const events = await readSessionEvents(run.recorder.filePath);
      const commits = events.filter((event) => event.type === "tool_execution" && event.change);
      assert.equal(commits.length, mode === "ok" ? 1 : 0);
      assert.equal(collectSessionChanges(buildSessionTimeline(events, [])).length, 0);
      if (mode === "ok") {
        const commit = commits[0]!;
        assert.ok(commit.type === "tool_execution" && commit.change?.server === "remote");
      } else assert.equal((result.details as { executionStatus: string }).executionStatus, "unknown");
    } finally { await run?.recorder.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
  }
}

if (process.argv[2] === "--crash") await crashWorker(process.argv[3]!, process.argv[4]!);
else {
  await testCrashBoundaries();
  await testPersistenceFailure();
  await testLocalOperations();
  await testMcpContract();
  console.log("file change protocol tests passed");
}
