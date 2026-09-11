/**
 * Agent 可调用的 Skill 发现与安装工具。
 *
 * 远程内容的解析、来源校验和原子安装由 extensions/skillDiscovery 负责；本模块只把
 * 这些能力接入统一 Tool 契约，并在安装完成后请求当前 Runtime 重新扫描 Skill。
 */
import { z } from "zod";
import {
  installDiscoveredSkill,
  searchSkillsSh,
  type SkillInstallResult,
  type SkillsShSearchResult
} from "../extensions/skillDiscovery.js";
import { defaultManagedSkillRoot } from "../extensions/managedSkillSources.js";
import { ToolAccesses } from "./access.js";
import type { Tool } from "./types.js";

const skillSearchArgsSchema = z.object({
  query: z.string().trim().min(2).max(200),
  limit: z.number().int().min(1).max(50).optional(),
  offset: z.number().int().min(0).max(10_000).optional()
});

const skillInstallArgsSchema = z.object({
  name: z.string().trim().min(1).max(200),
  directory: z.string().trim().min(1).max(1_000),
  repoOwner: z.string().trim().min(1).max(39),
  repoName: z.string().trim().min(1).max(100),
  repoBranch: z.string().trim().min(1).max(255)
});

export type SkillSearchArgs = z.infer<typeof skillSearchArgsSchema>;
export type SkillInstallArgs = z.infer<typeof skillInstallArgsSchema>;

export interface SkillInstallToolResult extends SkillInstallResult {
  refreshed: boolean;
  warning: string | undefined;
}

export interface SkillSearchToolOptions {
  /** 当前已激活 Skill 的名字和目录，用于给搜索结果加 installed 标记。 */
  getInstalledNames: () => ReadonlySet<string>;
  fetcher?: typeof globalThis.fetch;
}

export interface SkillInstallToolOptions {
  /** 安装成功后刷新当前 Runtime 的 Skill 元数据。 */
  refreshSkills: () => Promise<void>;
  /** 测试或嵌入宿主可注入隔离 home；正常运行时使用当前用户 home。 */
  homeDir?: string;
  fetcher?: typeof globalThis.fetch;
}

export function createSkillSearchTool(options: SkillSearchToolOptions): Tool<SkillSearchArgs, SkillsShSearchResult> {
  return {
    name: "skill_search",
    description: "Search skills.sh for installable Skills and return the exact source fields needed by skill_install.",
    promptSnippet: "Search installable Skills from the built-in skills.sh catalog",
    promptGuidelines: [
      "Use skill_search when the activated Skill list does not cover the user's task; do not claim a Skill exists without searching or a listed Skill result.",
      "Pass the exact name, directory, repository owner/name/branch from a skill_search result to skill_install."
    ],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 2, maxLength: 200, description: "Skill capability or task to search for." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum number of results to return." },
        offset: { type: "integer", minimum: 0, maximum: 10_000, description: "Pagination offset." }
      },
      required: ["query"],
      additionalProperties: false
    },
    schema: skillSearchArgsSchema,
    capability: "skills.search",
    risk: "read",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic", summary: `Search skills: ${args.query}` },
        description: `Search installable Skills for ${args.query}`,
        retrySafety: "safe",
        approvalRule: `skill_search(${args.query})`,
        async execute({ signal }): Promise<SkillsShSearchResult> {
          signal?.throwIfAborted();
          const result = await searchSkillsSh({
            query: args.query,
            limit: args.limit,
            offset: args.offset,
            fetcher: options.fetcher,
            installedNames: options.getInstalledNames()
          });
          signal?.throwIfAborted();
          return result;
        }
      };
    }
  };
}

export function createSkillInstallTool(options: SkillInstallToolOptions): Tool<SkillInstallArgs, SkillInstallToolResult> {
  const managedRoot = defaultManagedSkillRoot(options.homeDir);
  return {
    name: "skill_install",
    description: "Install one exact Skill returned by skill_search into Biny's managed global Skill directory, then refresh the current Skill list.",
    promptSnippet: "Install a searched Skill after permission is granted and refresh it for this session",
    promptGuidelines: [
      "When the current task requires an unavailable capability, install only an exact matching Skill from the current skill_search result, subject to the normal permission gate; do not install unrelated Skills.",
      "After skill_install succeeds, call Skill before using the newly installed Skill's workflow."
    ],
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 200, description: "Skill name from the search result." },
        directory: { type: "string", minLength: 1, maxLength: 1_000, description: "Repository Skill directory from the search result." },
        repoOwner: { type: "string", minLength: 1, maxLength: 39, description: "GitHub repository owner from the search result." },
        repoName: { type: "string", minLength: 1, maxLength: 100, description: "GitHub repository name from the search result." },
        repoBranch: { type: "string", minLength: 1, maxLength: 255, description: "Git branch from the search result." }
      },
      required: ["name", "directory", "repoOwner", "repoName", "repoBranch"],
      additionalProperties: false
    },
    schema: skillInstallArgsSchema,
    capability: "skills.install",
    risk: "write",
    resolveExecution(args) {
      const source = `${args.repoOwner}/${args.repoName}:${args.directory}`;
      return {
        accesses: ToolAccesses.writeTree(managedRoot),
        display: { kind: "generic", summary: `Install Skill ${args.name}`, detail: source },
        description: `Install Skill ${args.name} from ${source}`,
        retrySafety: "unsafe",
        approvalRule: `skill_install(${source})`,
        async execute({ signal, onExecutionState }): Promise<SkillInstallToolResult> {
          signal?.throwIfAborted();
          const installed = await installDiscoveredSkill({
            skill: args,
            homeDir: options.homeDir,
            fetcher: options.fetcher,
            signal
          });
          onExecutionState?.("side_effect_committed", `Installed Skill ${installed.name} to ${installed.installedPath}`);

          let refreshed = true;
          let warning: string | undefined;
          try {
            await options.refreshSkills();
          } catch (error) {
            refreshed = false;
            warning = error instanceof Error ? error.message : String(error);
          }
          return { ...installed, refreshed, warning };
        }
      };
    }
  };
}
