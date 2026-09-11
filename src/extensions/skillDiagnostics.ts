/** Skill 前置条件检查：只读取明确声明与本机状态，不执行 Skill 脚本，不猜测自然语言依赖。 */
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { readSkillMetadataFields } from "./skillDocument.js";

export interface SkillCheck {
  kind: "format" | "platform" | "binary" | "environment" | "config" | "compatibility" | "requirements" | "selection";
  subject: string;
  status: "passed" | "missing" | "unverified";
  message: string;
}

export interface SkillDiagnosticReport {
  name: string;
  checkedAt: string;
  status: "passed" | "blocked" | "unverified";
  checks: SkillCheck[];
}

const names = z.array(z.string().min(1).max(200)).max(64);
const requirementSchema = z.object({
  os: z.array(z.enum(["darwin", "linux", "win32"])).min(1).optional(),
  requires: z.object({
    bins: names.optional(), anyBins: names.optional(), env: names.optional(), config: names.optional()
  }).optional()
});

export async function diagnoseSkill(
  skill: { name: string; frontmatter: Record<string, unknown>; parseError?: string; shadowedBy?: string },
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; config?: unknown } = {}
): Promise<SkillDiagnosticReport> {
  const checks: SkillCheck[] = [];
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  try {
    if (skill.parseError) throw new Error(skill.parseError);
    const fields = readSkillMetadataFields(skill.frontmatter);
    if (!fields.name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(fields.name) || fields.name.length > 64) throw new Error("name 不符合 Skill 命名要求。");
    if (!fields.description || fields.description.length > 1024) throw new Error("description 不能为空或超过 1024 个字符。");
    checks.push({ kind: "format", subject: "SKILL.md", status: "passed", message: "文档元数据格式通过检查。" });
    if (skill.shadowedBy) checks.push({ kind: "selection", subject: skill.name, status: "missing", message: `当前由 ${skill.shadowedBy} 覆盖。` });
    if (fields.compatibility) checks.push({ kind: "compatibility", subject: "compatibility", status: "unverified", message: fields.compatibility });
    // metadata 中的宿主命名空间是导入格式标识；外部宿主的 config 不能冒充 Biny 配置。
    const source = fields.metadata?.biny !== undefined ? "biny" : "openclaw";
    let declaration = fields.metadata?.[source];
    if (typeof declaration === "string") declaration = JSON.parse(declaration);
    if (declaration === undefined) {
      checks.push({ kind: "requirements", subject: "环境要求", status: "unverified", message: "未声明可自动检查的环境要求；实际任务尚未验证。" });
    } else {
      const parsed = requirementSchema.safeParse(declaration);
      if (!parsed.success) throw new Error("环境要求声明无效，请检查 os 和 requires 字段。");
      const requirements = parsed.data;
      if (requirements.os) checks.push({ kind: "platform", subject: platform, status: requirements.os.includes(platform as "darwin" | "linux" | "win32") ? "passed" : "missing", message: `支持系统：${requirements.os.join("、")}。` });
      for (const binary of requirements.requires?.bins ?? []) {
        const available = await binaryExists(binary, env, platform);
        checks.push({ kind: "binary", subject: binary, status: available ? "passed" : "missing", message: available ? "可在 PATH 中找到可执行文件。" : "未在 PATH 中找到可执行文件。" });
      }
      const anyBins = requirements.requires?.anyBins;
      if (anyBins?.length) {
        const available = (await Promise.all(anyBins.map((binary) => binaryExists(binary, env, platform)))).some(Boolean);
        checks.push({ kind: "binary", subject: anyBins.join(" / "), status: available ? "passed" : "missing", message: "至少需要其中一个可执行文件。" });
      }
      for (const name of requirements.requires?.env ?? []) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new Error("环境变量声明只能包含变量名。");
        checks.push({ kind: "environment", subject: name, status: env[name] ? "passed" : "missing", message: env[name] ? "当前进程已提供此变量；不展示值。" : "当前进程尚未提供此变量。" });
      }
      for (const key of requirements.requires?.config ?? []) {
        let value: unknown = options.config;
        for (const part of key.split(".")) value = value && typeof value === "object" && Object.hasOwn(value, part) ? (value as Record<string, unknown>)[part] : undefined;
        const status = source !== "biny" || options.config === undefined ? "unverified" : value ? "passed" : "missing";
        checks.push({ kind: "config", subject: key, status, message: status === "unverified" ? "无法在当前宿主验证此配置项。" : status === "passed" ? "当前配置已启用。" : "当前配置尚未启用。" });
      }
      if (!requirements.os && !Object.values(requirements.requires ?? {}).some((values) => values?.length)) {
        checks.push({ kind: "requirements", subject: "环境要求", status: "unverified", message: "未声明可自动检查的环境要求；实际任务尚未验证。" });
      }
    }
  } catch (error) {
    checks.push({ kind: "format", subject: "SKILL.md", status: "missing", message: error instanceof SyntaxError ? "环境要求中的 JSON 无法解析。" : error instanceof Error ? error.message : "元数据无法解析。" });
  }
  return {
    name: skill.name, checkedAt: new Date().toISOString(),
    status: checks.some((check) => check.status === "missing") ? "blocked" : checks.some((check) => check.status === "unverified") ? "unverified" : "passed",
    checks
  };
}

async function binaryExists(binary: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<boolean> {
  if (!/^[A-Za-z0-9_+.-]+$/u.test(binary) || binary === "." || binary === "..") return false;
  const extensions = platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const directory of (env.PATH ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean)) {
    for (const extension of extensions) {
      try {
        const file = path.join(directory, binary + extension);
        await fs.access(file, platform === "win32" ? constants.F_OK : constants.X_OK);
        if ((await fs.stat(file)).isFile()) return true;
      } catch { /* 不执行 PATH 中的程序，只检查可访问性。 */ }
    }
  }
  return false;
}
