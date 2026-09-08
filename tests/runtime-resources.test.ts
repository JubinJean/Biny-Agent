import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config/schema.js";
import { loadSkills } from "../src/extensions/skills.js";
import { RuntimeHostResourceRegistry } from "../src/runtime/host/resources.js";

const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-runtime-resources-"));

try {
  const duplicateSkill = "---\nname: duplicate-skill\ndescription: Duplicate test skill\n---\n";
  await mkdir(path.join(workspaceRoot, ".biny", "skills", "duplicate-skill"), { recursive: true });
  await mkdir(path.join(workspaceRoot, ".agents", "skills", "duplicate-skill"), { recursive: true });
  await writeFile(path.join(workspaceRoot, ".biny", "skills", "duplicate-skill", "SKILL.md"), duplicateSkill);
  await writeFile(path.join(workspaceRoot, ".agents", "skills", "duplicate-skill", "SKILL.md"), duplicateSkill);
  const duplicateBundle = await loadSkills({
    workspaceRoot,
    projectPaths: [],
    globalRoot: path.join(workspaceRoot, "no-global-skills")
  });
  assert.equal(duplicateBundle.warnings.some((warning) => warning.includes("Skipped duplicate skill")), true);
  assert.deepEqual(duplicateBundle.errors, [], "重复 Skill 只是诊断，不应让资源进入 degraded");

  const registry = new RuntimeHostResourceRegistry();
  const first = registry.acquire(workspaceRoot, defaultConfig);
  const second = registry.acquire(workspaceRoot, defaultConfig);
  assert.equal(first, second, "同一 workspace 和扩展配置应复用资源 scope");
  assert.equal(first.snapshot().state, "loading");
  assert.equal(first.snapshot().mcp.pending, false);

  await first.start();
  assert.equal(first.snapshot().state, "ready");
  assert.equal(first.isReadyForSubmission(), true);

  const changedConfig = {
    ...defaultConfig,
    extensions: {
      ...defaultConfig.extensions,
      skills: [...defaultConfig.extensions.skills, ".biny/test-skills"]
    }
  };
  const isolated = registry.acquire(workspaceRoot, changedConfig);
  assert.notEqual(isolated, first, "扩展配置变化不能复用旧资源 scope");

  await registry.release(first);
  assert.equal(second.snapshot().state, first.snapshot().state, "仍有 session 引用时资源不能提前关闭");
  await registry.release(second);
  await registry.release(isolated);
} finally {
  await rm(workspaceRoot, { recursive: true, force: true });
}

console.log("runtime resource tests passed");
