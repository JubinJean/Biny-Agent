/**
 * 工具名称兼容层。
 *
 * 运行时只接受当前注册的工具名称；旧名称只在 provider 调用修复、存量数据读取、配置和
 * 工具选择这些边界归一化，不把兼容名称重新注册到模型工具列表。
 */

const legacyExecutionAliases: Readonly<Record<string, string>> = {
  list_files: "Glob",
  read_file: "Read",
  write_file: "Write",
  search_files: "Grep",
  run_command: "Bash",
  update_todos: "TodoWrite",
  web_fetch: "WebFetch",
  web_search: "WebSearch"
};

const legacyCompatibilityAliases: Readonly<Record<string, string>> = {
  ...legacyExecutionAliases,
  // 这两个工具已删除；存量消息和能力选择只保留现有的单文件编辑语义。
  multi_edit: "edit_file",
  apply_patch: "edit_file"
};

/** 只归一化仍可直接执行的旧名称；用于 provider 返回工具调用。 */
export function canonicalToolName(name: string): string {
  return legacyExecutionAliases[name] ?? name;
}

/** 归一化历史消息、配置和当前能力选择中的旧名称；不用于执行模型返回的工具调用。 */
export function canonicalCompatibleToolName(name: string): string {
  return legacyCompatibilityAliases[name] ?? name;
}

/** 迁移配置中的工具名称，同时消除旧名称归一化后产生的重复项。 */
export function migrateToolNameList(names: readonly string[]): string[] {
  const migrated: string[] = [];
  for (const name of names) {
    const canonical = canonicalCompatibleToolName(name);
    if (!migrated.includes(canonical)) migrated.push(canonical);
  }
  return migrated;
}
