/** 受管 Skill 版本：不可变目录保存来源与摘要，唯一的当前入口通过原子软链切换。 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { withGlobalConfigWriteLock } from "../config/versioned.js";

const nameSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(64);
const versionSchema = z.object({
  format: z.literal(1), id: z.string().uuid(), name: nameSchema,
  revision: z.string().regex(/^[a-f0-9]{40}$/u), digest: z.string().regex(/^[a-f0-9]{64}$/u),
  installedAt: z.string().datetime(), previous: z.string().uuid().optional(),
  source: z.object({ owner: z.string().min(1).max(39), repository: z.string().min(1).max(100), branch: z.string().min(1).max(256), directory: z.string().min(1).max(1000) }).strict()
}).strict();
export type ManagedSkillVersion = z.infer<typeof versionSchema>;

export function isManagedSkillVersionPath(root: string, name: string, target: string): boolean {
  if (!nameSchema.safeParse(name).success) return false;
  const parts = path.relative(path.resolve(root), target).split(path.sep);
  return parts.length === 4 && parts[0] === ".biny-versions" && parts[1] === name && z.string().uuid().safeParse(parts[2]).success && parts[3] === name;
}

export async function readManagedSkillVersion(root: string, name: string): Promise<ManagedSkillVersion | undefined> {
  nameSchema.parse(name);
  const alias = path.join(root, name);
  let stat;
  try { stat = await fs.lstat(alias); } catch (error) { if (isMissing(error)) return undefined; throw error; }
  if (!stat.isSymbolicLink()) return undefined;
  const canonicalRoot = await fs.realpath(root);
  const target = await fs.realpath(alias);
  if (!isManagedSkillVersionPath(canonicalRoot, name, target)) throw new Error("此 Skill 不是 Biny 管理的版本入口。");
  return await readVersion(canonicalRoot, name, path.basename(path.dirname(target)));
}

export async function publishSkillVersion(options: {
  root: string; name: string; preparedDirectory: string; revision: string;
  source: ManagedSkillVersion["source"]; expectedVersion?: string; signal?: AbortSignal;
}): Promise<ManagedSkillVersion> {
  nameSchema.parse(options.name);
  return await withGlobalConfigWriteLock(options.root, async () => {
    options.signal?.throwIfAborted();
    const root = await fs.realpath(options.root);
    const current = await readManagedSkillVersion(root, options.name);
    if (options.expectedVersion === undefined) {
      try { await fs.lstat(path.join(root, options.name)); throw new Error(`Skill 已安装：${options.name}`); }
      catch (error) { if (!isMissing(error)) throw error; }
    } else {
      if (current?.id !== options.expectedVersion) throw new Error("Skill 版本已变化，请刷新后重试。");
      await assertUnmodified(root, current);
    }
    const id = randomUUID();
    const version = versionSchema.parse({ format: 1, id, name: options.name, revision: options.revision, source: options.source, digest: await directoryDigest(options.preparedDirectory), installedAt: new Date().toISOString(), previous: current?.id });
    if (current?.revision === version.revision && current.digest === version.digest && JSON.stringify(current.source) === JSON.stringify(version.source)) return current;
    const versionRoot = path.join(root, ".biny-versions", options.name, id);
    for (const directory of [path.join(root, ".biny-versions"), path.dirname(versionRoot), versionRoot]) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      if (!(await fs.lstat(directory)).isDirectory()) throw new Error("Skill 版本目录必须是真实目录。");
    }
    let published = false;
    try {
      await fs.rename(options.preparedDirectory, path.join(versionRoot, options.name));
      await fs.writeFile(path.join(versionRoot, "version.json"), JSON.stringify(version), { flag: "wx", mode: 0o600 });
      options.signal?.throwIfAborted();
      await switchVersion(root, version);
      published = true;
      return version;
    } finally { if (!published) await fs.rm(versionRoot, { recursive: true, force: true }); }
  });
}

export async function rollbackSkillVersion(root: string, name: string, expectedVersion: string): Promise<ManagedSkillVersion> {
  return await withGlobalConfigWriteLock(root, async () => {
    root = await fs.realpath(root);
    const current = await readManagedSkillVersion(root, name);
    if (current?.id !== expectedVersion) throw new Error("Skill 版本已变化，请刷新后重试。");
    if (!current.previous) throw new Error("此 Skill 尚无可回滚版本。");
    const previous = await readVersion(root, name, current.previous);
    await assertUnmodified(root, current);
    await assertUnmodified(root, previous);
    await switchVersion(root, previous);
    return previous;
  });
}

async function readVersion(root: string, name: string, id: string): Promise<ManagedSkillVersion> {
  nameSchema.parse(name); z.string().uuid().parse(id);
  const directory = path.join(root, ".biny-versions", name, id);
  // 每一层都禁止软链，避免版本入口经中间目录跳出受管根。
  for (const target of [path.join(root, ".biny-versions"), path.dirname(directory), directory, path.join(directory, name)]) {
    if (!(await fs.lstat(target)).isDirectory()) throw new Error("Skill 版本目录不安全。");
  }
  const file = path.join(directory, "version.json");
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_384) throw new Error("Skill 版本记录不安全。");
  const version = versionSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
  if (version.name !== name || version.id !== id) throw new Error("Skill 版本记录与目录不匹配。");
  return version;
}

async function assertUnmodified(root: string, version: ManagedSkillVersion): Promise<void> {
  if (await directoryDigest(path.join(root, ".biny-versions", version.name, version.id, version.name)) !== version.digest) throw new Error("Skill 文件存在本地修改，请先保存副本；更新和回滚不会覆盖这些修改。");
}

async function switchVersion(root: string, version: ManagedSkillVersion): Promise<void> {
  const temporary = path.join(root, `.skill-link-${randomUUID()}`);
  try {
    await fs.symlink(path.join(".biny-versions", version.name, version.id, version.name), temporary, "dir");
    await fs.rename(temporary, path.join(root, version.name));
  } finally { await fs.rm(temporary, { force: true }); }
}

async function directoryDigest(directory: string): Promise<string> {
  const hash = createHash("sha256");
  let files = 0, bytes = 0, entries = 0;
  const visit = async (relative: string): Promise<void> => {
    if (++entries > 2048) throw new Error("Skill 目录条目过多。");
    const file = path.join(directory, relative);
    const stat = await fs.lstat(file);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(file)).sort()) await visit(path.join(relative, name));
    } else {
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("Skill 版本中不允许软链、硬链接或特殊文件。");
      bytes += stat.size;
      if (++files > 512 || bytes > 32 * 1024 * 1024) throw new Error("Skill 版本超过文件数或大小上限。");
      hash.update(JSON.stringify([relative.split(path.sep).join("/"), stat.mode & 0o777, stat.size]));
      hash.update(await fs.readFile(file));
    }
  };
  await visit("");
  return hash.digest("hex");
}

function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
