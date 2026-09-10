import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSkillInstallTool, createSkillSearchTool } from "../src/tools/skillDiscovery.js";

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-skill-tools-"));
  const homeDir = path.join(root, "home");
  let refreshCount = 0;
  let committedEvidence: string | undefined;
  const fetcher: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("skills.sh/api/search")) {
      return response(JSON.stringify({
        query: "demo",
        count: 1,
        skills: [{
          id: "demo-owner/demo-skills:skills/demo",
          skillId: "skills/demo",
          name: "demo-skill",
          installs: 7,
          source: "demo-owner/demo-skills"
        }]
      }));
    }
    if (url.includes("/git/trees/main")) {
      return response(JSON.stringify({ tree: [
        { path: "skills/demo/SKILL.md", type: "blob", size: 64 },
        { path: "skills/demo/references/guide.md", type: "blob", size: 10 }
      ] }));
    }
    if (url.endsWith("/skills/demo/SKILL.md")) return response("---\nname: demo-skill\ndescription: Demo\n---\n\n# Demo\n");
    if (url.endsWith("/skills/demo/references/guide.md")) return response("# Guide\n");
    return response("not found", 404);
  };

  try {
    const search = createSkillSearchTool({
      fetcher,
      getInstalledNames: () => new Set(["already-installed"])
    });
    assert.equal(search.name, "skill_search");
    assert.equal(search.schema.safeParse({ query: "d" }).success, false);
    const searchExecution = await search.resolveExecution({ query: "demo" });
    assert.equal("isError" in searchExecution, false);
    if ("isError" in searchExecution) throw new Error(searchExecution.errorMessage);
    const searched = await searchExecution.execute({ toolCallId: "search-1", operationId: "op-search-1" });
    assert.equal(searched.skills[0]?.directory, "skills/demo");
    assert.equal(searched.skills[0]?.installed, false);

    const install = createSkillInstallTool({
      homeDir,
      fetcher,
      refreshSkills: async () => {
        refreshCount += 1;
      }
    });
    assert.equal(install.name, "skill_install");
    const installExecution = await install.resolveExecution({
      name: "demo-skill",
      directory: "skills/demo",
      repoOwner: "demo-owner",
      repoName: "demo-skills",
      repoBranch: "main"
    });
    assert.equal("isError" in installExecution, false);
    if ("isError" in installExecution) throw new Error(installExecution.errorMessage);
    const installed = await installExecution.execute({
      toolCallId: "install-1",
      operationId: "op-install-1",
      onExecutionState: (state, evidence) => {
        assert.equal(state, "side_effect_committed");
        committedEvidence = evidence;
      }
    });
    assert.equal(installed.name, "demo-skill");
    assert.equal(installed.refreshed, true);
    assert.equal(installed.warning, undefined);
    assert.equal(refreshCount, 1);
    assert.match(committedEvidence ?? "", /demo-skill/u);
    assert.equal(await readFile(path.join(homeDir, ".config", "biny", "skills", "demo", "SKILL.md"), "utf8"), "---\nname: demo-skill\ndescription: Demo\n---\n\n# Demo\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function response(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

await main();
