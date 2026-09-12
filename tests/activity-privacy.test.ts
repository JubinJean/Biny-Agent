/** 删除 Activity 专用授权后，配置仍走 CAS，文本进入本地存储前统一脱敏。 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { updateActivitySettings } from "../src/activity/index.js";
import { redactActivityOcrText } from "../src/activity/redaction.js";
import { createFileConfigStore } from "../src/config/store.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";

const obsoleteKeys = ["externalPolicy", "externalConfirmed", "analysisPolicy", "analysisExternalConfirmed"];
for (const policy of ["local_only", "confirm_external", "external_allowed"]) {
  const parsed = configSchema.parse({
    ...defaultConfig,
    activity: { externalPolicy: policy, externalConfirmed: false, analysisPolicy: policy, analysisExternalConfirmed: false }
  });
  for (const key of obsoleteKeys) assert.equal(key in parsed.activity, false);
}
for (const key of obsoleteKeys) assert.equal(key in defaultConfig.activity, false);
assert.throws(() => configSchema.parse({ ...defaultConfig, activity: { enabled: "yes" } }));

const ocr = redactActivityOcrText("/Users/demo/project/src/app.ts user@example.com https://demo:pass@example.com/docs/page?q=private#private token=unsafe-secret\n" + "正文".repeat(2_000) + "\nTAIL_MARKER");
assert.match(ocr!, /\/Users\/demo\/project\/src\/app.ts user@example.com https:\/\/example.com\/docs\/page/u);
assert.match(ocr!, /TAIL_MARKER$/u, "存储前不应截掉长页面的尾部");
assert.doesNotMatch(ocr!, /demo:pass|q=private|#private|unsafe-secret/u);
assert.doesNotMatch(redactActivityOcrText("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature 123-45-6789")!, /eyJ|123-45-6789/u);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-activity-settings-"));
const workspace = path.join(root, "workspace");
const globalRoot = path.join(root, "global");
await fs.mkdir(workspace);
const store = createFileConfigStore(workspace, {
  globalDir: globalRoot,
  credentialStore: {
    persistent: false,
    get: async () => undefined,
    set: async () => undefined,
    delete: async () => undefined
  }
});
try {
  for (const enabled of [true, false]) {
    const current = await store.loadVersioned!();
    const saved = await store.saveVersioned!({
      ...current.config,
      activity: { ...current.config.activity, enabled }
    }, current.revision);
    assert.equal(saved.config.activity.enabled, enabled);
    assert.equal((await store.load()).activity.enabled, enabled);
    const persisted = JSON.parse(await fs.readFile(path.join(globalRoot, "config.json"), "utf8"));
    assert.equal(persisted.activity.enabled, enabled);
    for (const key of obsoleteKeys) assert.equal(key in persisted.activity, false);
  }
  const before = await store.load();
  const updated = await updateActivitySettings(store, workspace, (current) => ({ ...current, enabled: true }));
  const after = await store.load();
  assert.equal(updated.enabled, true);
  assert.equal(after.activity.enabled, true);
  assert.equal(after.permission.mode, before.permission.mode);
  assert.equal(after.defaultModel, before.defaultModel);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
