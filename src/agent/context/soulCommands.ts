/**
 * Soul 的共享命令语义。
 *
 * CLI 和交互端共用这里的读写动作，避免 Desktop/TUI 与 biny soul 的持久化边界逐渐分叉。
 * 外部编辑器只属于 CLI；交互端的 edit 动作返回同一个 canonical 文件路径。
 */
import type { SoulStorage } from "./soulStorage.js";

export const soulCommandUsage = [
  "Usage:",
  "  soul [show]",
  "  soul edit",
  "  soul set <content>",
  "  soul append-trait <description>",
  "  soul reset|delete"
].join("\n");

export async function runSoulCommand(storage: SoulStorage, args: string[]): Promise<string> {
  const action = args[0]?.toLowerCase() ?? "show";

  if (action === "show") {
    const snapshot = await storage.read();
    return [
      "Soul source: " + (snapshot.source === "user" ? "user override" : "built-in default"),
      "Soul file: " + snapshot.path,
      "",
      snapshot.content,
      "",
      soulCommandUsage
    ].join("\n");
  }

  if (action === "edit") {
    return [
      "Soul file: " + storage.path,
      "Use the CLI command biny soul edit to open it in an editor."
    ].join("\n");
  }

  if (action === "set") {
    const content = args.slice(1).join(" ").trim();
    if (!content) return soulCommandUsage;
    const snapshot = await storage.set(content);
    return "Soul updated: " + snapshot.path;
  }

  if (action === "append-trait") {
    const description = args.slice(1).join(" ").trim();
    if (!description) return soulCommandUsage;
    const snapshot = await storage.appendTrait(description);
    return "Soul trait appended: " + snapshot.path;
  }

  if (action === "reset" || action === "delete") {
    const snapshot = await storage.reset();
    return [
      "Soul override removed.",
      "Using " + (snapshot.source === "builtin" ? "the built-in default." : "the user Soul.")
    ].join("\n");
  }

  return soulCommandUsage;
}
