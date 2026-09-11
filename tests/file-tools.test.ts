import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEditFileTool } from "../src/tools/file/editFile.js";
import { createListFilesTool } from "../src/tools/file/listFiles.js";
import { createMoveFileTool } from "../src/tools/file/moveFile.js";
import type { RunnableToolExecution, ToolExecution } from "../src/tools/types.js";
import { createToolPermissionRequest } from "../src/tools/display/ToolDisplay.js";

const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-file-tools-"));
try {
  await testGlobTool();
  await testEditToolsKeepDollarSequences();
  await testMoveFileTool();
} finally {
  await rm(workspaceRoot, { recursive: true, force: true });
}

async function testGlobTool(): Promise<void> {
  await mkdir(path.join(workspaceRoot, "zzzz"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "zzzz", "match.ts"), "export {}\n", "utf8");
  await writeFile(path.join(workspaceRoot, "zzzz", "notes.md"), "notes\n", "utf8");

  const tool = createListFilesTool({ workspaceRoot, ignore: [] });
  const execution = runnable(await tool.resolveExecution({ pattern: "zzzz/**/*.ts", limit: 1 }));
  assert.deepEqual((await execution.execute({ toolCallId: "glob-1" })).files, [path.join("zzzz", "match.ts")]);
}

async function testEditToolsKeepDollarSequences(): Promise<void> {
  // String.replace 的字符串替换值会解释 $$、$&、$'、$` 等序列，替换值必须走函数形式。
  await writeFile(path.join(workspaceRoot, "dollar.txt"), "price: 10\n", "utf8");
  const edit = runnable(createEditFileTool({ workspaceRoot, ignore: [] }).resolveExecution({
    path: "dollar.txt",
    oldText: "10",
    newText: "$$ & $& $' $` $1"
  }));
  assert.deepEqual(await edit.execute({ toolCallId: "edit-dollar" }), { path: "dollar.txt", replacements: 1 });
  assert.equal(await readFile(path.join(workspaceRoot, "dollar.txt"), "utf8"), "price: $$ & $& $' $` $1\n");

  // 权限预览与落盘共用同一语义，diff 里也必须原样保留 $ 序列。
  const request = await createToolPermissionRequest({ id: "edit-dollar-preview", name: "edit_file", args: {
    path: "dollar.txt", oldText: "$1", newText: "$2 $$"
  } }, { workspaceRoot, ignore: [], sessionId: "file-tools" });
  assert.equal(request.diff?.includes("$2 $$"), true);

}

async function testMoveFileTool(): Promise<void> {
  await writeFile(path.join(workspaceRoot, "from.txt"), "move me\n", "utf8");
  const tool = createMoveFileTool({ workspaceRoot, ignore: [] });
  const execution = runnable(await tool.resolveExecution({ from: "from.txt", to: "nested/to.txt" }));
  await assert.rejects(execution.execute({ toolCallId: "move-missing-parent" }), /parent directory|ENOENT/i);
  await mkdir(path.join(workspaceRoot, "nested"));
  const retry = runnable(await tool.resolveExecution({ from: "from.txt", to: "nested/to.txt" }));
  assert.deepEqual(await retry.execute({ toolCallId: "move-1" }), { from: "from.txt", to: "nested/to.txt", moved: true });
  await assert.rejects(access(path.join(workspaceRoot, "from.txt")));
  assert.equal(await readFile(path.join(workspaceRoot, "nested/to.txt"), "utf8"), "move me\n");
  await writeFile(path.join(workspaceRoot, "again.txt"), "again\n", "utf8");
  const destinationExists = runnable(await tool.resolveExecution({ from: "again.txt", to: "nested/to.txt" }));
  await assert.rejects(destinationExists.execute({ toolCallId: "move-existing" }), /destination already exists/i);
}

function runnable<TResult>(execution: ToolExecution<TResult>): RunnableToolExecution<TResult> {
  if ("isError" in execution) throw new Error(execution.errorMessage);
  return execution;
}
