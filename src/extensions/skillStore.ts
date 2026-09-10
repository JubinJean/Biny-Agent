/**
 * Skill 安装记录 Store。
 *
 * Store 只保存 CLI 安装来源和本地目录，不保存 SKILL.md 正文，也不决定 Skill 是否激活。
 * 运行时的目录扫描和优先级仍由 skills.ts 负责。
 */
import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { globalConfigDir } from "../config/paths.js";

const storeDocumentSchema = z.object({
  version: z.literal(1),
  installations: z.array(z.object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
    source: z.string().min(1).max(2_000),
    kind: z.enum(["skills", "git", "local"]),
    installPath: z.string().min(1).max(4_000),
    installedAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  }).strict()).max(512)
}).strict();

export type SkillInstallationKind = "skills" | "git" | "local";
export type SkillInstallation = z.infer<typeof storeDocumentSchema>["installations"][number];

export class SkillStore {
  private loaded = false;
  private installations: SkillInstallation[] = [];

  constructor(private readonly homeDir?: string) {}

  async initialize(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const stat = await fs.lstat(this.filePath());
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error(`Skill Store 文件不安全：${this.filePath()}`);
      const document = storeDocumentSchema.parse(JSON.parse(await fs.readFile(this.filePath(), "utf8")));
      this.installations = document.installations;
    } catch (error) {
      if (isNotFound(error)) return;
      throw new Error(`无法读取 Skill Store：${errorMessage(error)}`);
    }
  }

  list(): SkillInstallation[] {
    return this.installations.map((installation) => ({ ...installation }));
  }

  async upsert(input: {
    name: string;
    source: string;
    kind: SkillInstallationKind;
    installPath: string;
  }): Promise<SkillInstallation> {
    await this.initialize();
    const now = new Date().toISOString();
    const current = this.installations.find((installation) => installation.name === input.name);
    const next = {
      name: input.name,
      source: input.source,
      kind: input.kind,
      installPath: input.installPath,
      installedAt: current?.installedAt ?? now,
      updatedAt: now
    } satisfies SkillInstallation;
    const document = {
      version: 1 as const,
      installations: [...this.installations.filter((installation) => installation.name !== input.name), next]
    };
    await this.persist(document);
    this.installations = document.installations;
    return { ...next };
  }

  async remove(name: string): Promise<boolean> {
    await this.initialize();
    const next = this.installations.filter((installation) => installation.name !== name);
    if (next.length === this.installations.length) return false;
    await this.persist({ version: 1, installations: next });
    this.installations = next;
    return true;
  }

  async markUpdated(): Promise<void> {
    await this.initialize();
    if (!this.installations.length) return;
    const updatedAt = new Date().toISOString();
    const installations = this.installations.map((installation) => ({ ...installation, updatedAt }));
    await this.persist({ version: 1, installations });
    this.installations = installations;
  }

  private filePath(): string {
    return path.join(this.homeDir === undefined ? globalConfigDir() : globalConfigDir({ env: {}, homeDir: this.homeDir }), "skill-store.json");
  }

  private async persist(document: { version: 1; installations: SkillInstallation[] }): Promise<void> {
    const target = this.filePath();
    const parent = path.dirname(target);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(storeDocumentSchema.parse(document), null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
