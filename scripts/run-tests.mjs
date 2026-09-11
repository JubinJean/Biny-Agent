/** 自动收集回归用例；每个文件独立进程和数据目录，避免手工清单漏项或重复执行。 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const prefix = process.argv[2] ?? "";
const suites = (await readdir(path.join(root, "tests")))
  .filter((name) => name.endsWith(".test.ts") && name.startsWith(prefix))
  .sort();
if (!suites.length) throw new Error(`No test files match ${prefix}`);
for (const [index, suite] of suites.entries()) {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "biny-test-suite-"));
  console.log(`[${index + 1}/${suites.length}] ${suite}`);
  try {
    const code = await new Promise((resolve, reject) => {
      // 用绝对 loader URL，测试派生的 CLI 即使切到临时工作区也能继承 execArgv。
      const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.join("tests", suite)], {
        cwd: root,
        env: { ...process.env, BINY_AGENT_DIR: agentDir },
        stdio: "inherit"
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
    if (code !== 0) {
      process.exitCode = code;
      break;
    }
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}
