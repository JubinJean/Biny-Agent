import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { approveSkillDraft, createSkillDraft, editSkillDraft, rejectSkillDraft, retrySkillDraft } from "../src/extensions/skillDrafts.js";

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-skill-drafts-"));
  try {
    const initial = "---\nname: repeatable-workflow\ndescription: A reusable local workflow.\n---\n\nDo the first step.\n";
    const draft = await createSkillDraft({
      workspaceRoot,
      name: "repeatable-workflow",
      description: "A reusable local workflow.",
      content: initial,
      toolCalls: 5
    });
    assert.equal(draft.status, "pending");
    await assert.rejects(
      readFile(path.join(workspaceRoot, ".biny", "skills", "repeatable-workflow", "SKILL.md"), "utf8"),
      /ENOENT/u
    );
    const edited = await editSkillDraft(workspaceRoot, draft.id, "---\nname: repeatable-workflow\ndescription: A reusable local workflow.\n---\n\nDo the edited step.\n");
    assert.equal(edited.status, "pending");
    assert.match(edited.content, /edited step/u);

    const approved = await approveSkillDraft(workspaceRoot, draft.id);
    assert.equal(approved.status, "approved");
    assert.equal(approved.installedPath, ".biny/skills/repeatable-workflow/SKILL.md");
    assert.match(await readFile(path.join(workspaceRoot, ".biny", "skills", "repeatable-workflow", "SKILL.md"), "utf8"), /edited step/u);

    const secretDraft = await createSkillDraft({
      workspaceRoot,
      name: "redacted-workflow",
      description: "A redacted workflow.",
      content: "---\nname: redacted-workflow\ndescription: A redacted workflow.\n---\n\napiKey=top-secret-value\n",
      toolCalls: 2
    });
    assert.doesNotMatch(secretDraft.content, /top-secret-value/u);
    assert.match(secretDraft.content, /apiKey=\[redacted\]/u);
    const redactedApproved = await approveSkillDraft(workspaceRoot, secretDraft.id);
    assert.equal(redactedApproved.status, "approved");
    assert.doesNotMatch(
      await readFile(path.join(workspaceRoot, ".biny", "skills", "redacted-workflow", "SKILL.md"), "utf8"),
      /top-secret-value/u
    );

    const duplicate = await createSkillDraft({
      workspaceRoot,
      name: "repeatable-workflow",
      description: "A reusable local workflow.",
      content: initial,
      toolCalls: 6,
      status: "failed",
      error: "temporary failure"
    });
    const retried = await retrySkillDraft(workspaceRoot, duplicate.id);
    assert.equal(retried.status, "pending");
    await assert.rejects(() => approveSkillDraft(workspaceRoot, duplicate.id), /同名 Skill/u);
    const rejected = await rejectSkillDraft(workspaceRoot, duplicate.id);
    assert.equal(rejected.status, "rejected");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

void main();
