/** Soul CLI 只负责编辑器和参数路由，正文读写复用 Agent 的共享 Soul 存储。 */
import { spawnSync } from "node:child_process";
import type { Command } from "commander";
import { runSoulCommand } from "../../agent/context/soulCommands.js";
import { SoulStorage } from "../../agent/context/soulStorage.js";

export function registerSoulCommands(program: Command): void {
  const command = program.command("soul").description("Show and evolve the persistent Soul");
  const execute = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  };
  const show = async (args: string[] = []): Promise<void> => {
    console.log(await runSoulCommand(new SoulStorage(), args));
  };

  command.action(() => execute(async () => await show()));
  command.command("show").description("Show the effective Soul").action(() => execute(async () => await show(["show"])));
  command.command("set").description("Replace the user Soul content")
    .argument("<content...>", "new Soul Markdown content")
    .action((content: string[]) => execute(async () => await show(["set", ...content])));
  command.command("append-trait").description("Append one evolved trait")
    .argument("<description...>", "trait description")
    .action((description: string[]) => execute(async () => await show(["append-trait", ...description])));
  command.command("reset").alias("delete").description("Remove the user override and use the fixed default persona")
    .action(() => execute(async () => await show(["reset"])));
  command.command("edit").description("Open SOUL.md in the configured editor")
    .action(() => execute(editSoulCommand));
}

async function editSoulCommand(): Promise<void> {
  const storage = new SoulStorage();
  const snapshot = await storage.ensureEditable();
  const configuredEditor = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
  if (!configuredEditor && process.platform !== "darwin") {
    console.log("Soul file: " + snapshot.path);
    console.log("Set EDITOR or VISUAL to open it automatically.");
    return;
  }

  const command = configuredEditor === undefined
    ? "open"
    : configuredEditor.split(/\s+/u)[0] ?? configuredEditor;
  const args = configuredEditor === undefined
    ? ["-e", snapshot.path]
    : [...configuredEditor.split(/\s+/u).slice(1), snapshot.path];
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== null && result.status !== 0) {
    throw new Error("Soul editor exited with status " + String(result.status) + ".");
  }
  console.log("Soul file: " + snapshot.path);
}
