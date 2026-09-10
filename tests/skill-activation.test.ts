import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expandSkillCommand, loadSkills } from "../src/extensions/skills.js";
import { resolveSkillActivation, setSkillActivation } from "../src/extensions/skillActivation.js";
import { createSkillRef } from "../src/extensions/skillRef.js";

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-skill-activation-"));
  try {
    const skillDirectory = path.join(workspaceRoot, ".biny", "skills", "demo-skill");
    const globalRoot = path.join(workspaceRoot, "global-skills");
    await mkdir(skillDirectory, { recursive: true });
    await mkdir(globalRoot, { recursive: true });
    await writeFile(path.join(skillDirectory, "SKILL.md"), "---\nname: demo-skill\ndescription: A test skill.\n---\n\nUse the test skill.\n", "utf8");

    const ref = createSkillRef({ scope: "project", name: "demo-skill", projectRoot: await realpath(workspaceRoot), source: "biny" });
    assert.deepEqual(resolveSkillActivation({ ref }), {
      enabled: true,
      globalEnabled: true,
      projectOverride: undefined,
      source: "default"
    });
    assert.equal(resolveSkillActivation({ ref, globalDefaults: { [ref]: false } }).enabled, false);
    assert.equal(resolveSkillActivation({ ref, globalDefaults: { [ref]: false }, projectOverrides: { [ref]: true } }).enabled, true);
    assert.equal(resolveSkillActivation({ ref, globalDefaults: { [ref]: false }, projectOverrides: { [ref]: true } }).source, "project");
    assert.deepEqual(setSkillActivation({ [ref]: false }, ref, undefined), {});

    const disabled = await loadSkills({
      workspaceRoot,
      projectPaths: [".biny/skills"],
      globalRoot,
      globalDefaults: { [ref]: false }
    });
    assert.deepEqual(disabled.skills.filter((skill) => skill.name === "demo-skill").map((skill) => skill.ref), [], JSON.stringify({ expectedRef: ref, actual: disabled.skills.map((skill) => skill.ref) }));
    assert.equal(disabled.prompt.includes("demo-skill"), false);

    const projectEnabled = await loadSkills({
      workspaceRoot,
      projectPaths: [".biny/skills"],
      globalRoot,
      globalDefaults: { [ref]: false },
      projectOverrides: { [ref]: true }
    });
    assert.deepEqual(projectEnabled.skills.filter((skill) => skill.name === "demo-skill").map((skill) => skill.ref), [ref]);

    const builtins = await loadSkills({ workspaceRoot, projectPaths: [], globalRoot });
    const builtinNames = builtins.skills.filter((skill) => skill.scope === "builtin").map((skill) => skill.name);
    assert.deepEqual(builtinNames, ["daily-report", "memory-management", "plan-weave", "scheduler", "self-reflection", "tasks", "todo", "workspace-search"]);
    assert.equal(builtins.skills.filter((skill) => skill.scope === "builtin").every((skill) => skill.source === "builtin"), true);
    for (const skill of builtins.skills.filter((candidate) => candidate.scope === "builtin")) {
      const document = await readFile(skill.filePath, "utf8");
      assert.match(document, new RegExp(`name:\\s*${skill.name}\\b`));
      assert.match(document, /description:\s*\S/u);
      assert.match(document, /\n[^-\s].+/u, `${skill.name} must have a non-empty instruction body`);
      assert.doesNotMatch(document, /\b(?:claude|codex|pi|alma|maka|anthropic|openai)\b/iu, `${skill.name} must keep Biny's product identity boundary`);
    }

    const overrideDirectory = path.join(workspaceRoot, ".biny", "skills", "memory-management");
    await mkdir(overrideDirectory, { recursive: true });
    await writeFile(path.join(overrideDirectory, "SKILL.md"), "---\nname: memory-management\ndescription: Project override\n---\nProject instructions.\n", "utf8");
    const overridden = await loadSkills({ workspaceRoot, projectPaths: [], globalRoot });
    const projectOverride = overridden.skills.find((skill) => skill.name === "memory-management");
    assert.equal(projectOverride?.scope, "project");
    assert.equal(projectOverride?.source, "biny");
    assert.match(await expandSkillCommand(overridden, "/skill:memory-management"), /Project instructions/);

    const disabledOverride = await loadSkills({
      workspaceRoot,
      projectPaths: [],
      globalRoot,
      projectOverrides: { [projectOverride!.ref]: false }
    });
    assert.equal(disabledOverride.skills.some((skill) => skill.name === "memory-management"), false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

void main();
