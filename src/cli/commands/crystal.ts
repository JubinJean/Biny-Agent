/** 结晶管理命令只负责参数路由；生命周期校验和写入由存储服务完成。 */
import type { Command } from "commander";
import { CrystalService } from "../../agent/context/crystalService.js";
import type { CrystalType, CrystalMaterialKind } from "../../agent/context/crystalTypes.js";
import { createCommandRuntime, type CommandRuntime } from "../../runtime/CommandRuntime.js";
import { withCliAbortSignal } from "../sigint.js";

export function registerCrystalCommands(program: Command): void {
  const command = program.command("crystal").description("Manage persistent crystal objects");
  const execute = async (action: (service: CrystalService) => unknown): Promise<void> => {
    const service = new CrystalService();
    try {
      await service.initialize();
      console.log(JSON.stringify(await action(service), null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      service.close();
    }
  };
  command.command("list").action(() => execute((service) => service.overview()));
  command.command("search [query]").action((query?: string) => execute((service) => service.search(query)));
  command.command("show <id>").action((id: string) => execute((service) => {
    const detail = service.detail(id);
    if (!detail) throw new Error("Crystal not found.");
    return { ...detail, reference: `@[${detail.crystal.name}](biny://crystal/${id})` };
  }));
  command.command("seed <name>").action((name: string) => execute((service) => service.createSeed(name)));
  command.command("slot <id> <slot>").description("Assign slot 1-3, or 0 to remove from active slots")
    .action((id: string, slot: string) => execute((service) => service.setSlot(id, slot === "0" ? null : Number(slot))));
  command.command("cancel <id>").option("--stop-observing", "also stop observing a seed")
    .action((id: string, options: { stopObserving?: boolean }) => execute((service) => service.cancel(id, !options.stopObserving)));
  command.command("dormant <id>").action((id: string) => execute((service) => service.setDormant(id, true)));
  command.command("wake <id>").action((id: string) => execute((service) => service.setDormant(id, false)));
  const bundle = command.command("bundle").description("Manage named bundles of conversation anchors");
  bundle.command("list [thread]").action((thread?: string) => execute((service) => service.storage.listBundles(thread)));
  bundle.command("create <thread> <anchors...>").option("--name <name>", "bundle name")
    .action((threadId: string, anchorIds: string[], options: { name?: string }) => execute((service) => service.storage.insertBundle({ threadId, anchorIds, name: options.name })));
  command.command("type <id> <type>").action((id: string, type: string) => execute((service) => service.setType(id, type as CrystalType)));
  command.command("field <id> <field> <value>")
    .requiredOption("--source <tags...>", "supporting material tags")
    .action((id: string, field: string, value: string, options: { source: string[] }) => execute((service) => service.updateChecklist(id, field, { value, sources: options.source })));
  command.command("material <id> <kind> <ref>")
    .description("Attach a turn, bundle, or note using a JSON reference")
    .action((id: string, kind: string, ref: string) => execute((service) => {
      if (!["turn", "bundle", "note"].includes(kind)) throw new Error("Invalid material kind.");
      const parsed: unknown = JSON.parse(ref);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Material reference must be an object.");
      return { added: service.addMaterial(id, kind as CrystalMaterialKind, parsed) };
    }));
  command.command("confirm <id>").description("Approve a fully sourced crystal checklist")
    .action((id: string) => execute((service) => service.confirm(id)));
  command.command("prefill <id>").description("Fill missing checklist fields from cited materials using the configured model")
    .action(async (id: string) => {
      let runtime: CommandRuntime | undefined;
      try {
        await withCliAbortSignal(async (signal) => {
          runtime = await createCommandRuntime(process.cwd());
          runtime.heartbeat.stop();
          signal.throwIfAborted();
          const result = await runtime.agent.getCrystalService().prefill(id, signal);
          console.log(JSON.stringify(result, null, 2));
        });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      } finally {
        await runtime?.close();
      }
    });
}
