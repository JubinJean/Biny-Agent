/** Biny 随版本发布的只读 Skill 资源位置。 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function builtinSkillRoot(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDirectory, "bundled-skills"),
    path.join(moduleDirectory, "..", "bundled-skills"),
    path.resolve(process.cwd(), "dist", "bundled-skills"),
    path.resolve(process.cwd(), "src", "bundled-skills")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}
