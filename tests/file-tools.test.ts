import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEditFileTool } from "../src/tools/file/editFile.js";
import { formatHashlineContent } from "../src/tools/file/hashline.js";
import { createListFilesTool } from "../src/tools/file/listFiles.js";
import { createReadFileTool } from "../src/tools/file/readFile.js";
import { createSearchFilesTool } from "../src/tools/search/searchFiles.js";
import type { RunnableToolExecution, ToolExecution } from "../src/tools/types.js";
import { createToolPermissionRequest } from "../src/tools/display/ToolDisplay.js";

const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-file-tools-"));
try {
  await testGlobTool();
  await testReadReturnsHashlineAnchors();
  await testReadPaginationKeepsGlobalAnchors();
  await testGrepFiltersContextAndPagination();
  await testHashlineEdit();
  await testHashlineEditPreservesCrLf();
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

  await mkdir(path.join(workspaceRoot, "glob-page", "nested"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "glob-page", "a.ts"), "a\n", "utf8");
  await writeFile(path.join(workspaceRoot, "glob-page", "nested", "b.ts"), "b\n", "utf8");
  const first = await runnable(tool.resolveExecution({ path: "glob-page", pattern: "glob-page/**/*.ts", limit: 1 }))
    .execute({ toolCallId: "glob-page-1" });
  assert.deepEqual(first, { files: ["glob-page/a.ts"], hasMore: true, nextCursor: "glob-page/a.ts" });
  const second = await runnable(tool.resolveExecution({ path: "glob-page", pattern: "glob-page/**/*.ts", cursor: first.nextCursor, limit: 1 }))
    .execute({ toolCallId: "glob-page-2" });
  assert.deepEqual(second, { files: ["glob-page/nested/b.ts"], hasMore: false, nextCursor: undefined });
}

async function testReadReturnsHashlineAnchors(): Promise<void> {
  await writeFile(path.join(workspaceRoot, "read.txt"), "alpha\nbeta\n", "utf8");
  const read = runnable(createReadFileTool({ workspaceRoot, ignore: [] }, true).resolveExecution({ path: "read.txt" }));
  const result = await read.execute({ toolCallId: "read-hashline" });
  assert.equal(result.content, formatHashlineContent("alpha\nbeta\n"));
  assert.match(result.content, /^1#[0-9A-F]{8}:alpha\n2#[0-9A-F]{8}:beta$/u);
}

async function testReadPaginationKeepsGlobalAnchors(): Promise<void> {
  await writeFile(path.join(workspaceRoot, "paged.txt"), "one\ntwo\nthree\nfour\nfive\n", "utf8");
  const tool = createReadFileTool({ workspaceRoot, ignore: [] }, true);
  const first = await runnable(tool.resolveExecution({ path: "paged.txt", startLine: 3, lineCount: 2 }))
    .execute({ toolCallId: "read-page-1" });
  assert.deepEqual({ ...first, content: undefined }, {
    path: "paged.txt",
    content: undefined,
    startLine: 3,
    endLine: 4,
    hasMore: true,
    nextStartLine: 5
  });
  assert.match(first.content, /^3#[0-9A-F]{8}:three\n4#[0-9A-F]{8}:four$/u);

  const second = await runnable(tool.resolveExecution({ path: "paged.txt", startLine: first.nextStartLine, lineCount: 2 }))
    .execute({ toolCallId: "read-page-2" });
  assert.equal(second.content, `5#${anchor("five", 5).split("#")[1]}:five`);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextStartLine, undefined);
}

async function testGrepFiltersContextAndPagination(): Promise<void> {
  await mkdir(path.join(workspaceRoot, "grep", "nested"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "grep", "a.txt"), "before\nAlpha one\nafter\nalpha two\n", "utf8");
  await writeFile(path.join(workspaceRoot, "grep", "nested", "b.md"), "alpha three\n", "utf8");
  const tool = createSearchFilesTool({ workspaceRoot, ignore: [] });
  const first = await runnable(tool.resolveExecution({
    query: "alpha\\s+\\w+",
    mode: "regex",
    path: "grep",
    glob: "grep/**/*.txt",
    caseSensitive: false,
    contextLines: 1,
    limit: 1
  })).execute({ toolCallId: "grep-page-1" });
  assert.equal(first.matches.length, 1);
  assert.deepEqual(first.matches[0]?.before, [{ line: 1, text: "before" }]);
  assert.deepEqual(first.matches[0]?.after, [{ line: 3, text: "after" }]);
  assert.match(first.matches[0]?.anchor ?? "", /^2#[0-9A-F]{8}$/u);
  assert.equal(first.matches[0]?.column, 1);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 1);

  const second = await runnable(tool.resolveExecution({
    query: "alpha",
    path: "grep",
    glob: "grep/**/*.txt",
    caseSensitive: false,
    offset: first.nextOffset,
    limit: 1
  })).execute({ toolCallId: "grep-page-2" });
  assert.deepEqual(second.matches.map((match) => [match.path, match.line, match.text]), [["grep/a.txt", 4, "alpha two"]]);
  assert.equal(second.hasMore, false);
}

async function testHashlineEdit(): Promise<void> {
  await writeFile(path.join(workspaceRoot, "dollar.txt"), "price: 10\nkeep\ntail\n", "utf8");
  const edit = runnable(await createEditFileTool({ workspaceRoot, ignore: [] }).resolveExecution({
    operation: "update",
    path: "dollar.txt",
    edits: [
      { op: "replace", pos: anchor("price: 10", 1), lines: ["price: $$ & $& $' $` $1"] },
      { op: "append", pos: anchor("tail", 3), lines: ["done"] }
    ]
  }));
  const result = await edit.execute({ toolCallId: "edit-dollar" });
  assert.equal(result.change.path, "dollar.txt");
  assert.equal(result.change.edits, 2);
  assert.equal(result.change.firstChangedLine, 1);
  assert.match(result.change.diff, /price: \$\$ & \$& \$' \$` \$1/u);
  assert.equal(await readFile(path.join(workspaceRoot, "dollar.txt"), "utf8"), "price: $$ & $& $' $` $1\nkeep\ntail\ndone\n");

  // 权限预览与执行共用同一套 Hashline 应用逻辑。
  const request = await createToolPermissionRequest({ id: "edit-dollar-preview", name: "Edit", args: {
    operation: "update",
    path: "dollar.txt",
    edits: [{ op: "replace", pos: anchor("price: $$ & $& $' $` $1", 1), lines: ["price: $2 $$"] }]
  } }, { workspaceRoot, ignore: [], sessionId: "file-tools" });
  assert.equal(request.diff?.includes("$2 $$"), true);

  const stale = runnable(await createEditFileTool({ workspaceRoot, ignore: [] }).resolveExecution({
    operation: "update",
    path: "dollar.txt",
    edits: [
      { op: "replace", pos: anchor("keep", 2), lines: ["must-not-land"] },
      { op: "replace", pos: anchor("price: 10", 1), lines: ["wrong"] }
    ]
  }));
  await assert.rejects(stale.execute({ toolCallId: "edit-stale" }), /Stale Hashline anchor/u);
  assert.equal(await readFile(path.join(workspaceRoot, "dollar.txt"), "utf8"), "price: $$ & $& $' $` $1\nkeep\ntail\ndone\n");
}

async function testHashlineEditPreservesCrLf(): Promise<void> {
  await writeFile(path.join(workspaceRoot, "windows.txt"), "one\r\ntwo\r\n", "utf8");
  const edit = runnable(await createEditFileTool({ workspaceRoot, ignore: [] }).resolveExecution({
    operation: "update",
    path: "windows.txt",
    edits: [{ op: "replace", pos: anchor("two", 2), lines: ["second"] }]
  }));
  await edit.execute({ toolCallId: "edit-crlf" });
  assert.equal(await readFile(path.join(workspaceRoot, "windows.txt"), "utf8"), "one\r\nsecond\r\n");
}

function anchor(line: string, lineNumber: number): string {
  return formatHashlineContent(`${"\n".repeat(lineNumber - 1)}${line}`).split("\n")[lineNumber - 1]!.split(":", 1)[0]!;
}

async function testMoveFileTool(): Promise<void> {
  await writeFile(path.join(workspaceRoot, "from.txt"), "move me\n", "utf8");
  const tool = createEditFileTool({ workspaceRoot, ignore: [] });
  const execution = runnable(await tool.resolveExecution({ operation: "move", path: "from.txt", to: "nested/to.txt" }));
  await assert.rejects(execution.execute({ toolCallId: "move-missing-parent" }), /parent directory|ENOENT/i);
  await mkdir(path.join(workspaceRoot, "nested"));
  const retry = runnable(await tool.resolveExecution({ operation: "move", path: "from.txt", to: "nested/to.txt" }));
  assert.deepEqual((await retry.execute({ toolCallId: "move-1" })).change, {
    operation: "move", path: "from.txt", destinationPath: "nested/to.txt", committed: true,
    diff: "diff --git a/from.txt b/nested/to.txt\nsimilarity index 100%\nrename from from.txt\nrename to nested/to.txt"
  });
  await assert.rejects(access(path.join(workspaceRoot, "from.txt")));
  assert.equal(await readFile(path.join(workspaceRoot, "nested/to.txt"), "utf8"), "move me\n");
  await writeFile(path.join(workspaceRoot, "again.txt"), "again\n", "utf8");
  const destinationExists = runnable(await tool.resolveExecution({ operation: "move", path: "again.txt", to: "nested/to.txt" }));
  await assert.rejects(destinationExists.execute({ toolCallId: "move-existing" }), /destination already exists/i);
}

function runnable<TResult>(execution: ToolExecution<TResult>): RunnableToolExecution<TResult> {
  if ("isError" in execution) throw new Error(execution.errorMessage);
  return execution;
}
