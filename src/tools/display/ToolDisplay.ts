/**
 * 工具展示规则模块。
 *
 * 这里只负责把工具调用参数转换成权限确认所需的标题、摘要和 diff。它不执行工具、不记录 session，
 * 也不决定是否允许调用，保证 UI 展示格式不会影响工具协议。
 */
import { analyzePermissionRequest, commandSafetyWarnings } from "../../permission/policy.js";
import type { PermissionPrompt, PermissionRequestContext } from "../../permission/PermissionManager.js";
import { createUnifiedDiff } from "../../utils/diff.js";
import { redactSecrets, redactSensitiveValue } from "../../utils/secrets.js";
import { resolveWorkspacePath } from "../../workspace/resolvePath.js";
import { maxEditFileBytes, readBoundedUtf8File } from "../file/safeFileIo.js";
export interface ToolCallInput {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolDisplayContext {
  workspaceRoot: string;
  ignore: string[];
  sessionId?: string;
}

export interface ToolDisplayRule {
  title: string;
  summarize(args: unknown, context: ToolDisplayContext): Promise<ToolDisplaySummary>;
}

export interface ToolDisplaySummary {
  details: string;
  diff?: string;
  preview?: string;
  requireFullYes?: boolean;
  changeSummary?: string;
}

export async function createToolPermissionRequest(
  call: ToolCallInput,
  context: ToolDisplayContext,
  permissionContext?: PermissionRequestContext
): Promise<PermissionPrompt> {
  const requestContext = permissionContext ?? analyzePermissionRequest({
    toolName: call.name,
    args: call.args,
    sessionId: context.sessionId ?? "",
    projectRoot: context.workspaceRoot
  });
  const rule = toolDisplayRules[call.name] ?? defaultDisplayRule;
  const summary = await rule.summarize(call.args, context);
  const diff = summary.diff === undefined ? undefined : redactSecrets(summary.diff);
  const preview = summary.preview === undefined ? undefined : redactSecrets(summary.preview);
  return {
    ...requestContext,
    command: requestContext.command === undefined ? undefined : redactSecrets(requestContext.command),
    reason: requestContext.reason === undefined ? undefined : redactSecrets(requestContext.reason),
    toolCallId: call.id,
    tool: call.name,
    title: rule.title,
    details: redactSecrets(summary.details),
    requireFullYes: summary.requireFullYes ?? requestContext.riskLevel === "critical",
    diff,
    preview,
    diffPreview: diff,
    changeSummary: summary.changeSummary === undefined ? undefined : redactSecrets(summary.changeSummary)
  };
}

export const toolDisplayRules: Record<string, ToolDisplayRule> = {
  Bash: {
    title: "Command execution request",
    async summarize(args) {
      const command = getStringField(args, "command");
      const warnings = commandSafetyWarnings(command);
      return {
        details: [command, warnings.length ? `\nSensitive command warning: ${warnings.join(", ")}` : ""].join(""),
        changeSummary: `Run command: ${command}`,
        requireFullYes: warnings.length > 0
      };
    }
  },
  start_process: {
    title: "Managed process start request",
    async summarize(args) {
      const command = getStringField(args, "command");
      const warnings = commandSafetyWarnings(command);
      return {
        details: [command, warnings.length ? `\nSensitive command warning: ${warnings.join(", ")}` : ""].join(""),
        changeSummary: `Start managed process: ${command}`,
        requireFullYes: warnings.length > 0
      };
    }
  },
  Write: {
    title: "File write request",
    async summarize(args, context) {
      const filePath = getStringField(args, "path");
      const content = getStringField(args, "content");
      const oldContent = await readExistingFileForDiff(filePath, context);
      const diff = oldContent ? createUnifiedDiff(filePath, oldContent, content) : undefined;
      const preview = oldContent
        ? formatUnifiedDiffPreview(filePath, diff ?? "", 16)
        : formatFileContentPreview(filePath, content, 16);
      return {
        details: `File: ${filePath}\nBytes: ${Buffer.byteLength(content, "utf8")}`,
        diff,
        preview,
        changeSummary: oldContent ? `Overwrite ${filePath}` : `Create ${filePath}`
      };
    }
  },
  edit_file: {
    title: "File edit request",
    async summarize(args, context) {
      const filePath = getStringField(args, "path");
      const oldText = getStringField(args, "oldText");
      const newText = getStringField(args, "newText");
      const oldContent = await readExistingFileForDiff(filePath, context);
      // 函数形式的替换值才会被原样插入；字符串形式会把 newText 里的 $$、$& 等序列当成模式解释，
      // 导致预览 diff 与实际落盘内容不一致。
      const nextContent = oldContent.includes(oldText) ? oldContent.replace(oldText, () => newText) : oldContent;
      const diff = createUnifiedDiff(filePath, oldContent, nextContent);
      const preview = formatUnifiedDiffPreview(filePath, diff, 16);
      return {
        details: `File: ${filePath}\nReplace bytes: ${Buffer.byteLength(oldText, "utf8")} -> ${Buffer.byteLength(newText, "utf8")}`,
        diff,
        preview,
        changeSummary: `Edit ${filePath}`
      };
    }
  },
  move_file: {
    title: "File move request",
    async summarize(args, context) {
      const from = getStringField(args, "from");
      const to = getStringField(args, "to");
      const oldContent = await readExistingFileForDiff(from, context);
      const preview = formatFileContentPreview(from, oldContent, 12);
      return {
        details: `Move ${from} -> ${to}\nBytes: ${Buffer.byteLength(oldContent, "utf8")}`,
        preview,
        changeSummary: `Move ${from} to ${to}`,
        requireFullYes: true
      };
    }
  },
  delete_file: {
    title: "File deletion request",
    async summarize(args, context) {
      const filePath = getStringField(args, "path");
      const oldContent = await readExistingFileForDiff(filePath, context);
      const diff = createUnifiedDiff(filePath, oldContent, "");
      const preview = formatUnifiedDiffPreview(filePath, diff, 16);
      return {
        details: `File: ${filePath}\nBytes: ${Buffer.byteLength(oldContent, "utf8")}`,
        diff,
        preview,
        changeSummary: `Delete ${filePath}`,
        requireFullYes: true
      };
    }
  },
  skill_install: {
    title: "Skill installation request",
    async summarize(args) {
      const name = getStringField(args, "name");
      const owner = getStringField(args, "repoOwner");
      const repository = getStringField(args, "repoName");
      const directory = getStringField(args, "directory");
      return {
        details: `Skill: ${name}\nSource: ${owner}/${repository}:${directory}\nTarget: ~/.config/biny/skills/`,
        changeSummary: `Install Skill ${name}`
      };
    }
  },
  BrowserType: {
    title: "Browser form fill request",
    async summarize(args) {
      const selector = getStringField(args, "selector");
      return {
        details: `Selector: ${selector}\nValue: [redacted before display]`,
        changeSummary: `Fill browser field ${selector}`
      };
    }
  }
};

const defaultDisplayRule: ToolDisplayRule = {
  title: "Tool permission request",
  async summarize(args) {
    return { details: JSON.stringify(redactSensitiveValue(args), null, 2) };
  }
};

async function readExistingFileForDiff(filePath: string, context: ToolDisplayContext): Promise<string> {
  const absolutePath = resolveWorkspacePath(context.workspaceRoot, filePath, context.ignore);
  try {
    return (await readBoundedUtf8File(absolutePath, maxEditFileBytes, "reject")).content;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

function getStringField(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null) return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

// Permission previews are plain text shared by CLI and TUI. They deliberately
// stay in the tool domain so a core tool never imports a TUI rendering module.
function formatFileContentPreview(filePath: string, content: string, maxLines: number): string {
  const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines = normalized ? normalized.split("\n") : [];
  const shown = lines.slice(0, maxLines);
  return [
    `内容：${filePath}`,
    ...shown.map((line, index) => `${String(index + 1).padStart(4, " ")}   ${line}`),
    ...(lines.length > shown.length ? [`     … ${String(lines.length - shown.length)} 行未展示`] : [])
  ].join("\n");
}

function formatUnifiedDiffPreview(filePath: string, diff: string, maxLines: number): string {
  const body: string[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const line of diff.split("\n")) {
    const range = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (range) {
      oldLine = Number.parseInt(range[1] ?? "1", 10);
      newLine = Number.parseInt(range[2] ?? "1", 10);
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("-")) {
      body.push(`${String(oldLine).padStart(4, " ")} - ${line.slice(1)}`);
      oldLine += 1;
      continue;
    }
    if (line.startsWith("+")) {
      body.push(`${String(newLine).padStart(4, " ")} + ${line.slice(1)}`);
      newLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      body.push(`${String(newLine).padStart(4, " ")}   ${line.slice(1)}`);
      oldLine += 1;
      newLine += 1;
    }
  }

  return [
    `变更：${filePath}`,
    ...body.slice(0, maxLines),
    ...(body.length > maxLines ? [`     … ${String(body.length - maxLines)} 行未展示`] : [])
  ].join("\n");
}
