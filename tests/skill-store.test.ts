import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SkillStore } from "../src/extensions/skillStore.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-skill-store-"));
try {
  const store = new SkillStore(root);
  await store.initialize();
  assert.deepEqual(store.list(), []);

  const created = await store.upsert({
    name: "demo-skill",
    source: "demo-owner/demo-repo@demo-skill",
    kind: "skills",
    installPath: path.join(root, "skills", "demo-skill")
  });
  assert.equal(created.name, "demo-skill");
  const reloaded = new SkillStore(root);
  await reloaded.initialize();
  assert.deepEqual(reloaded.list(), [created]);

  const updated = await reloaded.upsert({
    name: "demo-skill",
    source: "https://github.com/demo-owner/demo-repo.git",
    kind: "git",
    installPath: path.join(root, "skills", "demo-repo")
  });
  assert.equal(updated.source, "https://github.com/demo-owner/demo-repo.git");
  assert.equal(reloaded.list().length, 1);
  await reloaded.markUpdated();
  assert.equal(reloaded.list()[0]?.updatedAt >= updated.updatedAt, true);
  assert.equal(await reloaded.remove("demo-skill"), true);
  assert.deepEqual(reloaded.list(), []);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("skill store tests passed");
