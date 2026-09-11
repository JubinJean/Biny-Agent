/** 睡眠与疲劳命令共享运行时状态文件，不依赖某个聊天进程的内存快照。 */
import type { Command } from "commander";
import { FatigueService } from "../../agent/context/fatigue.js";

export function registerFatigueCommands(program: Command): void {
  for (const action of ["sleep", "wake", "rest", "fatigue"] as const) {
    program.command(action).description(`Manage ${action} state`).option("--json", "print JSON")
      .action(async (options: { json?: boolean }) => {
        const service = new FatigueService();
        const status = action === "fatigue" ? await service.currentStatus() : await service.change(action);
        console.log(options.json ? JSON.stringify(status) : `${status.level}: ${String(status.fatigue)}/100`);
      });
  }
}
