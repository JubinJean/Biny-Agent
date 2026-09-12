/** 真实授权摘要经共用投影到桌面和终端；验证操作语义、脱敏与权限选项边界。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createToolPermissionRequest, toolDisplayRules } from "../src/tools/display/ToolDisplay.js";
import { permissionPresentation } from "../src/permission/presentation.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { ToolPermission } from "../src/desktop/renderer/src/components/ToolActivity.js";
import { PermissionDialog } from "../src/tui/components/dialogs.js";
import { setTheme } from "../src/tui/theme/index.js";

const cases: Array<{ name: string; args: Record<string, unknown>; title: string }> = [
  { name: "Bash", args: { command: "rm -rf old" }, title: "允许运行此命令？" },
  { name: "start_process", args: { command: "node server.js" }, title: "允许启动后台进程？" },
  { name: "Write", args: { path: "new.txt", content: "new content" }, title: "允许写入此文件？" },
  { name: "edit_file", args: { path: "old.txt", oldText: "old", newText: "new" }, title: "允许编辑此文件？" },
  { name: "move_file", args: { from: "old.txt", to: "moved.txt" }, title: "允许移动此文件？" },
  { name: "delete_file", args: { path: "old.txt" }, title: "允许删除此文件？" },
  { name: "skill_install", args: { name: "demo", repoOwner: "owner", repoName: "repo", directory: "skills/demo" }, title: "允许安装此技能？" },
  { name: "BrowserType", args: { selector: "#password", text: "secret-form-value" }, title: "允许填写此网页表单？" },
  { name: "Read", args: { path: ".env" }, title: "允许读取此文件？" },
  { name: "git_commit", args: { message: "test" }, title: "允许创建 Git 提交？" },
  { name: "stop_process", args: { processId: "process-1" }, title: "允许停止此进程？" },
  { name: "mcp_demo_custom", args: { apiKey: "secret-extension-value", target: "demo" }, title: "允许此次工具操作？" }
];

test("所有定制摘要和通用工具通过真实投影保持操作内容和脱敏", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-permission-view-"));
  try {
    await writeFile(path.join(workspaceRoot, "old.txt"), "old\n");
    assert.ok(Object.keys(toolDisplayRules).every((name) => cases.some((item) => item.name === name)), "新摘要规则必须加入覆盖矩阵");
    for (const item of cases) {
      const request = await createToolPermissionRequest({ id: item.name, name: item.name, args: item.args }, { workspaceRoot, ignore: [] });
      const view = permissionPresentation(request);
      assert.equal(view.title, item.title, item.name);
      const html = renderToStaticMarkup(createElement(ToolPermission, {
        tool: { id: item.name, tool: item.name, args: item.args, status: "waiting", updates: [], permission: { requestId: item.name, request, resolved: false } },
        onResolvePermission: async () => undefined
      }));
      assert.ok(html.includes(item.title), item.name);
      assert.doesNotMatch(html, /secret-form-value|secret-extension-value|Sensitive command warning|等待输出/u);
      if (item.name === "move_file") {
        assert.match(view.details, /old\.txt -> moved\.txt/u);
        assert.doesNotMatch(request.preview!, /^Write/u);
      }
      if (item.name === "delete_file") assert.match(html, /-old/u);
      if (item.name === "skill_install") assert.match(view.details, /来源：owner\/repo:skills\/demo/u);
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("扩展说明和多行命令内容不被翻译替换破坏", () => {
  const command = "echo 'File: test'\necho done";
  const view = permissionPresentation({ tool: "Bash", actionType: "shell", command, details: `${command}\nSensitive command warning: executes sudo`, reason: "executes sudo" });
  assert.equal(view.details, "注意：以管理员权限执行");
  assert.equal(view.reason, undefined);
  assert.equal(permissionPresentation({ tool: "Bash", actionType: "shell", command: "echo", details: "echoes are documented here" }).details, "echoes are documented here");
  const details = '{"path":"File: test", "command":"executes sudo"}';
  assert.equal(permissionPresentation({ tool: "mcp_custom", actionType: "network", details }).details, details);
});

test("关键操作开关决定是否可以记住授权，TUI 不允许选择隐藏的会话授权", () => {
  const request = { tool: "Bash", toolName: "Bash", title: "", details: "sudo test", requireFullYes: true, actionType: "shell" as const, riskLevel: "critical" as const, sessionId: "s", projectRoot: "/tmp", command: "sudo test" };
  assert.equal(new PermissionManager({ mode: "ask", criticalAlwaysAsk: true }).evaluate(request).canRemember, false);
  assert.notEqual(new PermissionManager({ mode: "ask", criticalAlwaysAsk: false }).evaluate(request).canRemember, false);
  assert.notEqual(new PermissionManager({ mode: "ask" }).evaluate({ ...request, riskLevel: "medium" }).canRemember, false);
  setTheme("dark");
  const answers: string[] = [];
  const dialog = new PermissionDialog({ ...request, canRemember: false }, (choice) => answers.push(choice), () => undefined);
  assert.ok(!dialog.render(100).join("\n").includes("本会话允许"));
  dialog.handleInput("\u001B[B");
  dialog.handleInput("\r");
  assert.deepEqual(answers, ["deny"], "从允许一次向下应直接回到拒绝");
});
