/**
 * Skill 管理 CLI。
 *
 * CLI 对齐常见的 SkillHub 使用方式：搜索和安装优先交给 `skills` 命令，失败时
 * 回退到浅克隆 Git 仓库；运行时仍通过统一的 Skill loader 负责发现、激活和 Skill。
 */
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { InvalidArgumentError } from "commander";
import type { Command } from "commander";
import { defaultManagedSkillRoot } from "../../extensions/managedSkillSources.js";
import { parseSkillDocument } from "../../extensions/skillCatalog.js";
import { searchSkillsSh } from "../../extensions/skillDiscovery.js";
import { defaultGlobalSkillRoots } from "../../extensions/skillRoots.js";
import { loadSkills } from "../../extensions/skills.js";
import { SkillStore } from "../../extensions/skillStore.js";

interface SkillOutputOptions {
  json?: boolean;
}

interface PackageRunnerResult {
  runner: string | undefined;
  status: number | null;
  error?: Error;
}

export function registerSkillCommands(program: Command, workspaceRoot: string): void {
  const command = program.command("skill").description("Search, install, and manage Skills");
  const execute = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  };

  command.action(() => execute(async () => await skillListCommand(workspaceRoot)));
  command.command("list")
    .description("List loaded Skills")
    .option("--json", "print JSON")
    .action((options: SkillOutputOptions) => execute(async () => await skillListCommand(workspaceRoot, options)));
  command.command("search")
    .alias("find")
    .description("Search the Skill catalog")
    .argument("<query...>", "capability or task to search for")
    .option("--limit <count>", "maximum results", parsePositiveInteger)
    .option("--offset <count>", "pagination offset", parseNonNegativeInteger)
    .option("--json", "print JSON")
    .action((query: string[], options: SkillSearchOptions) => execute(async () => await skillSearchCommand(workspaceRoot, query.join(" "), options)));
  command.command("install")
    .description("Install a Skill from skills.sh or GitHub")
    .argument("<source>", "skills.sh source, GitHub repository, or Git URL")
    .action((source: string) => execute(async () => await skillInstallCommand(source)));
  command.command("update")
    .description("Check for and update installed Skills")
    .action(() => execute(skillUpdateCommand));
  command.command("uninstall")
    .description("Remove an installed Skill")
    .argument("<name>", "Skill directory name")
    .action((name: string) => execute(async () => await skillUninstallCommand(name)));
  command.command("create")
    .description("Install a local SKILL.md")
    .argument("<name>", "Skill name")
    .requiredOption("--file <path>", "SKILL.md path, or - for stdin")
    .action((name: string, options: { file: string }) => execute(async () => await skillCreateCommand(name, options.file)));
}

interface SkillSearchOptions extends SkillOutputOptions {
  limit?: number;
  offset?: number;
}

async function skillListCommand(workspaceRoot: string, options: SkillOutputOptions = {}): Promise<void> {
  const bundle = await loadSkills({ workspaceRoot, projectPaths: [] });
  const store = new SkillStore();
  await store.initialize();
  const installations = store.list();
  const result = {
    skills: bundle.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      scope: skill.scope,
      source: skill.source,
      path: skill.path,
      active: true
    })),
    installations,
    warnings: bundle.warnings,
    conflicts: bundle.conflicts.map((conflict) => ({
      name: conflict.name,
      winner: conflict.winner.path,
      shadowed: conflict.shadowed.map((skill) => skill.path)
    }))
  };
  if (options.json) {
    console.log(JSON.stringify(result));
    return;
  }
  if (!result.skills.length) {
    console.log("No Skills installed.");
  } else {
    for (const skill of result.skills) {
      console.log(`${skill.name}  [${skill.scope}]  ${skill.path}  ${skill.description}`);
    }
  }
  for (const warning of result.warnings) console.error(`Warning: ${warning}`);
}

async function skillSearchCommand(workspaceRoot: string, query: string, options: SkillSearchOptions = {}): Promise<void> {
  if (!options.json && runPackageCommand(["find", query]).status === 0) return;
  const bundle = await loadSkills({ workspaceRoot, projectPaths: [] });
  const result = await searchSkillsSh({
    query,
    limit: options.limit,
    offset: options.offset,
    installedNames: new Set(bundle.skills.map((skill) => skill.name))
  });
  if (options.json) {
    console.log(JSON.stringify(result));
    return;
  }
  if (!result.skills.length) {
    console.log(`No Skills found for ${query}.`);
    return;
  }
  for (const skill of result.skills) {
    const installed = skill.installed ? " [installed]" : "";
    console.log(`${skill.name}${installed}  ${skill.repoOwner}/${skill.repoName}:${skill.directory}  installs=${String(skill.installs)}`);
  }
}

async function skillInstallCommand(source: string): Promise<void> {
  const root = defaultManagedSkillRoot();
  await fs.mkdir(root, { recursive: true });
  const packageResult = runPackageCommand(["add", source, "-g", "-y"], root);
  if (packageResult.status === 0) {
    await new SkillStore().upsert({ name: repositoryDirectoryName(source), source, kind: "skills", installPath: path.join(root, repositoryDirectoryName(source)) });
    console.log(`Installed: ${source}`);
    return;
  }

  const gitSource = source.includes("@") ? source.slice(0, source.indexOf("@")) : source;
  const gitUrl = gitSource.startsWith("http://") || gitSource.startsWith("https://")
    ? gitSource
    : `https://github.com/${gitSource}`;
  const repositoryName = repositoryDirectoryName(gitSource);
  const target = path.join(root, repositoryName);
  if (await pathExists(target)) throw new Error(`Skill already exists: ${target}`);
  const result = spawnSync("git", ["clone", "--depth", "1", gitUrl, target], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Install failed: git clone exited with status ${String(result.status)}.`);
  await new SkillStore().upsert({ name: repositoryName, source, kind: "git", installPath: target });
  console.log(`Installed via git: ${repositoryName}`);
}

async function skillUpdateCommand(): Promise<void> {
  const check = runPackageCommand(["check"]);
  if (check.runner === undefined) throw new Error("No package runner found. Install Node.js (npx) or Bun (bunx).");
  if (check.status !== 0) throw check.error ?? new Error("Skill update check failed.");
  const update = runPackageCommand(["update"]);
  if (update.status !== 0) throw update.error ?? new Error("Skill update failed.");
  await new SkillStore().markUpdated();
  console.log("Skills updated.");
}

async function skillUninstallCommand(name: string): Promise<void> {
  assertSkillDirectoryName(name);
  const targets = defaultGlobalSkillRoots().map((root) => path.join(root, name));
  const installedTargets: string[] = [];
  for (const target of targets) {
    if (await pathExists(target)) installedTargets.push(target);
  }
  if (!installedTargets.length) throw new Error(`Skill not found: ${name}`);
  for (const target of installedTargets) await fs.rm(target, { recursive: true, force: true });
  await new SkillStore().remove(name);
  console.log(`Uninstalled: ${name}`);
}

async function skillCreateCommand(name: string, source: string): Promise<void> {
  assertSkillDirectoryName(name);
  const content = source === "-" ? await readStdin() : await fs.readFile(source, "utf8");
  const parsed = parseSkillDocument(content);
  if (parsed.frontmatter.name !== name || typeof parsed.frontmatter.description !== "string" || !parsed.frontmatter.description.trim()) {
    throw new Error("SKILL.md frontmatter must contain matching name and a non-empty description.");
  }
  const target = path.join(defaultManagedSkillRoot(), name);
  await fs.mkdir(defaultManagedSkillRoot(), { recursive: true });
  await fs.mkdir(target);
  try {
    await fs.writeFile(path.join(target, "SKILL.md"), content, { encoding: "utf8", flag: "wx", mode: 0o644 });
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    throw error;
  }
  await new SkillStore().upsert({ name, source, kind: "local", installPath: target });
  console.log(`Installed personal Skill "${name}" at ${target}`);
}

function runPackageCommand(args: string[], cwd?: string): PackageRunnerResult {
  const runner = getPackageRunner();
  if (runner === undefined) return { runner: undefined, status: null };
  const result = spawnSync(runner, ["skills", ...args], { stdio: "inherit", cwd });
  return { runner, status: result.status, error: result.error };
}

function getPackageRunner(): string | undefined {
  for (const candidate of ["npx", "bunx"]) {
    const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!result.error && result.status === 0) return candidate;
  }
  return undefined;
}

function repositoryDirectoryName(source: string): string {
  const withoutQuery = source.split(/[?#]/u, 1)[0] ?? source;
  const name = withoutQuery.split("/").filter(Boolean).at(-1)?.replace(/\.git$/u, "") ?? "skill";
  assertSkillDirectoryName(name);
  return name;
}

function assertSkillDirectoryName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name) || name === "." || name === "..") {
    throw new Error(`Invalid Skill directory name: ${name}`);
  }
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError(`Expected a positive integer, got: ${value}`);
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new InvalidArgumentError(`Expected a non-negative integer, got: ${value}`);
  return parsed;
}

async function readStdin(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let content = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => { content += chunk; });
    process.stdin.once("end", () => resolve(content));
    process.stdin.once("error", reject);
  });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
