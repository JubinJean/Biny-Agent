import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { diagnoseSkill } from "../src/extensions/skillDiagnostics.js";
import { parseSkillDocument, readSkillMetadataFields } from "../src/extensions/skillDocument.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-skill-check-"));
try {
  await mkdir(path.join(root, "bin"));
  const binary = path.join(root, "bin", "sample-tool");
  await writeFile(binary, "#!/bin/sh\necho should-not-run\nexit 99\n");
  await chmod(binary, 0o700);
  const frontmatter = { name: "sample", description: "Sample", metadata: { biny: JSON.stringify({ os: ["darwin"], requires: { bins: ["sample-tool"], anyBins: ["missing", "sample-tool"], env: ["SAMPLE_KEY"], config: ["browser.enabled"] } }) } };
  const options = { env: { PATH: path.join(root, "bin"), SAMPLE_KEY: "private-token-value" }, platform: "darwin" as const, config: { browser: { enabled: true } } };
  const passed = await diagnoseSkill({ name: "sample", frontmatter }, options);
  assert.equal(passed.status, "passed");
  assert.equal(JSON.stringify(passed).includes("private-token-value"), false);
  assert.equal(passed.checks.filter((check) => check.kind === "binary").length, 2);
  const missing = await diagnoseSkill({ name: "sample", frontmatter }, { ...options, env: { PATH: "" } });
  assert.equal(missing.status, "blocked");
  assert.equal(missing.checks.find((check) => check.kind === "environment")?.status, "missing");
  assert.equal((await diagnoseSkill({ name: "sample", frontmatter }, { ...options, platform: "linux" })).checks.find((check) => check.kind === "platform")?.status, "missing");
  const unknown = await diagnoseSkill({ name: "sample", frontmatter: { name: "sample", description: "Sample", compatibility: "Requires special server access" } });
  assert.equal(unknown.status, "unverified", "自然语言和未声明依赖不能伪装成检查通过");
  const external = await diagnoseSkill({ name: "sample", frontmatter: { ...frontmatter, metadata: { openclaw: { requires: { config: ["browser.enabled"] } } } } }, options);
  assert.equal(external.status, "unverified", "其他宿主的配置声明不能套用 Biny 配置");
  const malformed = await diagnoseSkill({ name: "sample", frontmatter: { ...frontmatter, metadata: { biny: { requires: { bins: "wrong" } } } } });
  assert.equal(malformed.status, "blocked");
  assert.equal((await diagnoseSkill({ name: "sample", frontmatter, parseError: "broken YAML" })).status, "blocked");
  const document = parseSkillDocument("---\nname: sample\ndescription: Sample\nlicense: MIT\ncompatibility: Needs a browser\nallowed-tools: Read Bash(git:*)\nmetadata:\n  version: '1.2'\n---\nBody");
  const fields = readSkillMetadataFields(document.frontmatter);
  assert.equal(fields.license, "MIT");
  assert.deepEqual(fields.allowedTools, ["Read", "Bash(git:*)"]);
  assert.equal(document.body, "Body");
  assert.throws(() => readSkillMetadataFields({ compatibility: "x".repeat(501) }), /500/);
  assert.throws(() => parseSkillDocument("---\nname: sample"), /结束/);
} finally { await rm(root, { recursive: true, force: true }); }
console.log("skill diagnostics tests passed");
