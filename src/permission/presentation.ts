/** 各端共用授权内容投影；只整理展示，不参与权限判定或修改原始参数。 */
export interface PermissionPresentationInput {
  tool: string;
  actionType: string;
  details: string;
  command?: string;
  targetPath?: string;
  reason?: string;
  changeSummary?: string;
}

const toolTitles: Record<string, string> = {
  Bash: "允许运行此命令？", start_process: "允许启动后台进程？", stop_process: "允许停止此进程？",
  Read: "允许读取此文件？", Write: "允许写入此文件？", edit_file: "允许编辑此文件？",
  delete_file: "允许删除此文件？", move_file: "允许移动此文件？",
  skill_install: "允许安装此技能？", Skill: "允许加载此技能？", read_skill_resource: "允许读取技能资源？",
  BrowserType: "允许填写此网页表单？", git_commit: "允许创建 Git 提交？",
  WebFetch: "允许读取此网页？", WebSearch: "允许搜索网页？", Task: "允许委派此任务？",
  save_memory: "允许保存此记忆？", recall_memory: "允许检索记忆？", update_emotion: "允许更新表达状态？",
  mcp_list_resources: "允许列出 MCP 资源？", mcp_read_resource: "允许读取 MCP 资源？"
};
const actionTitles: Record<string, string> = {
  read: "允许读取此内容？", write: "允许执行此写入操作？", delete: "允许执行此删除操作？",
  shell: "允许执行此操作？", network: "允许访问此网络资源？", git: "允许执行此 Git 操作？",
  install: "允许执行此安装操作？", unknown: "允许此次工具操作？"
};
const reasonLabels: Record<string, string> = {
  "recursively force deletes files": "递归强制删除文件", "executes sudo": "以管理员权限执行",
  "pipes a network script into a shell": "下载并执行网络脚本", "force pushes git history": "强制推送 Git 历史",
  "deletes files": "删除文件", "moves or overwrites files": "移动或覆盖文件", "changes file permissions": "更改文件权限",
  "changes file ownership": "更改文件所有者", "changes dependencies": "更改项目依赖", "changes git state": "更改 Git 状态",
  "accesses the network": "访问网络", "runs project checks": "运行项目检查", "executes a shell command": "执行 Shell 命令",
  "command requires permission": "命令需要授权", "reads a sensitive file": "读取敏感文件", "reads a workspace file": "读取工作区文件",
  "modifies a shell profile": "修改 Shell 启动配置", "modifies a sensitive file": "修改敏感文件",
  "modifies a lockfile": "修改依赖锁文件", "modifies a workspace file": "修改工作区文件",
  "deletes a sensitive file": "删除敏感文件", "deletes a workspace file": "删除工作区文件",
  "searches or lists workspace files": "搜索或列出工作区文件", "creates a git commit in this repository": "在当前仓库创建 Git 提交",
  "inspects git diff": "查看 Git 差异", "inspects git status": "查看 Git 状态",
  "inspects runtime-owned managed processes": "查看 Biny 管理的进程", "stops a runtime-owned managed process group": "停止 Biny 管理的进程组",
  "delegates a bounded workspace task with write and finite validation capabilities": "委派任务，可写入工作区并执行有限验证",
  "delegates a bounded read-only repository investigation": "委派只读仓库调查任务",
  "records the assistant's own plan for this session": "记录当前会话的任务清单",
  "fetches a public web page without changing local state": "读取公开网页",
  "searches the public web without changing local state": "搜索公开网页",
  "searches the public Skill catalog without changing local state": "搜索公开技能目录",
  "downloads and installs a validated Skill into Biny's managed global Skill directory": "下载并安装已校验的技能到 Biny 技能目录",
  "loads validated local skill instructions": "加载已校验的本地技能说明",
  "searches the source-aware durable memory library": "检索持久记忆库",
  "saves a redacted note to the source-aware durable memory library": "将脱敏笔记保存到持久记忆库",
  "updates the agent's local expression state": "更新本地表达状态",
  "reads a tool result this session archived out of context": "读取当前会话已归档的工具结果",
  "reads read-only resources exposed by connected MCP servers": "读取已连接 MCP 服务提供的只读资源",
  "extension declares a read-only action": "扩展声明此操作为只读",
  "extension declares a workspace-changing action": "扩展声明此操作会修改工作区",
  "extension declares an executable action": "扩展声明此操作会执行程序", "unknown tool action": "此工具的操作类型未知"
};

export function permissionPresentation(request: PermissionPresentationInput): { title: string; details: string; reason?: string } {
  // 只删除明确重复的完整行，不在命令、路径或第三方说明中做任意子串替换。
  const lines = request.details.split(/\r?\n/u);
  if (request.command && (request.details === request.command || request.details.startsWith(`${request.command}\n`) || request.details.startsWith(`${request.command}\r\n`))) {
    lines.splice(0, request.command.split(/\r?\n/u).length);
  }
  const details = lines.filter((line) => line !== `File: ${request.targetPath}`).map((line) => {
    if (line.startsWith("Sensitive command warning: ")) {
      return `注意：${line.slice(27).split(", ").map((warning) => reasonLabels[warning] ?? warning).join("；")}`;
    }
    // 通用扩展的 JSON 原样保留，避免修改键或参数值。
    if (request.tool === "skill_install") return line.replace(/^Skill: /u, "技能：").replace(/^Source: /u, "来源：").replace(/^Target: /u, "安装位置：");
    if (request.tool === "BrowserType") return line.replace(/^Selector: /u, "目标元素：").replace(/^Value: \[redacted before display\]$/u, "填写内容：已隐藏");
    if (["Write", "edit_file", "move_file", "delete_file"].includes(request.tool)) return line.replace(/^File: /u, "文件：").replace(/^Bytes: /u, "大小（字节）：").replace(/^Replace bytes: /u, "替换字节数：").replace(/^Move /u, "移动：");
    return line;
  }).join("\n").trim();
  const rawReason = request.reason?.trim();
  const reason = rawReason ? reasonLabels[rawReason] ?? rawReason : undefined;
  const repeated = rawReason === request.changeSummary || rawReason === request.command || rawReason === `Run ${request.command}` || rawReason === `Run command: ${request.command}`
    || rawReason === `Start managed process: ${request.command}`
    || ["Read", "Write", "Edit", "Delete", "Create", "Overwrite"].some((verb) => rawReason === `${verb} ${request.targetPath}`);
  return {
    title: toolTitles[request.tool] ?? (request.command ? "允许运行此命令？" : actionTitles[request.actionType] ?? "允许此次工具操作？"),
    details,
    reason: reason && !repeated && !details.includes(reason) ? reason : undefined
  };
}
