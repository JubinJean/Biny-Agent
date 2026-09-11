import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceContext } from "../src/agent/context/WorkspaceContext.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-workspace-refresh-"));
try {
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "AGENTS.md"), "root v1");
  await writeFile(path.join(root, "global.md"), "global v1");
  await writeFile(path.join(root, "src", "main.ts"), "export const before = 1;");
  const context = new WorkspaceContext(root, [], 1024, path.join(root, "global.md"));
  const first = await context.prepareTurn("src/main.ts");
  assert.deepEqual(first.instructions.map((item) => item.content), ["global v1", "root v1"]);
  await writeFile(path.join(root, "AGENTS.md"), "root v2");
  await writeFile(path.join(root, "global.md"), "global v2");
  await writeFile(path.join(root, "src", "AGENTS.md"), "nested new");
  const second = await context.prepareTurn("src/main.ts");
  assert.deepEqual(second.instructions.map((item) => item.content), ["global v2", "root v2", "nested new"], "外部修改和原先不存在的嵌套指令下一轮可见");
  await writeFile(path.join(root, "AGENTS.override.md"), "override");
  await rm(path.join(root, "src", "AGENTS.md"));
  context.invalidateSnapshot();
  assert.deepEqual((await context.prepareTurn("src/main.ts")).instructions.map((item) => item.content), ["global v2", "override"]);
  await rm(path.join(root, "AGENTS.override.md"));
  await rm(path.join(root, "global.md"));
  assert.deepEqual((await context.prepareTurn("src/main.ts")).instructions.map((item) => item.content), ["root v2"]);
  assert.equal(context.status().instructionBytes, Buffer.byteLength("root v2"), "刷新不能累积指令预算");

  context.observeToolResult("Bash", { command: "pwd" }, {});
  const unchanged = await context.prepareTurn("src/main.ts");
  assert.equal(unchanged.repoMapCandidates.find((item) => item.path === "src/main.ts"), first.repoMapCandidates.find((item) => item.path === "src/main.ts"), "扫描后复用未变文件的提取结果");
  await writeFile(path.join(root, "src", "main.ts"), "export const after = 2;");
  await writeFile(path.join(root, "src", "added.ts"), "export const added = 3;");
  context.observeToolResult("Bash", { command: "external-script" }, {});
  const changed = await context.prepareTurn("src/main.ts src/added.ts");
  assert.ok(changed.repoMapCandidates.find((item) => item.path === "src/main.ts")?.symbols.includes("after"));
  assert.ok(changed.repoMapCandidates.some((item) => item.path === "src/added.ts"));
  await rm(path.join(root, "src", "added.ts"));
  context.invalidateSnapshot();
  assert.equal((await context.prepareTurn("src/added.ts")).repoMapCandidates.some((item) => item.path === "src/added.ts"), false);
  assert.equal(await readFile(path.join(root, "src", "main.ts"), "utf8"), "export const after = 2;");
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("workspace context refresh tests passed");
