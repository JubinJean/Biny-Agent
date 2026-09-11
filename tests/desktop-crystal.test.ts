/** 桌面结晶从会话材料到人工确认的完整调用路径；共享核心存储，不启动聊天 Runtime。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DesktopCrystalService } from "../src/desktop/electron/main/DesktopCrystalService.js";
import { CrystalNotReadyError, CrystalService } from "../src/agent/context/crystalService.js";
import { CrystalStorage } from "../src/agent/context/crystalStorage.js";
import { defaultConfig } from "../src/config/schema.js";
import { desktopCrystalRequestSchema } from "../src/desktop/crystalProtocol.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { SessionRecorder } from "../src/session/recorder.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-crystal-"));
const service = new DesktopCrystalService({ load: async () => defaultConfig, save: async () => undefined }, async () => [root], () => new CrystalStorage({ agentDir: root }));
try {
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root);
  recorder.record({ type: "user_message", content: "ProjectX 的目标是改进协作" });
  await recorder.close();
  const created = await service.request({ action: "seed", name: "ProjectX", sessionId: recorder.sessionId });
  const id = created.detail!.crystal.id;
  assert.equal(created.overview.slots.length, 1);
  assert.equal(created.detail!.materials.length, 1);
  assert.deepEqual(Object.values(created.detail!.materialPreviews), ["ProjectX 的目标是改进协作"]);
  const typed = await service.request({ action: "type", id, type: "project" });
  await assert.rejects(service.request({ action: "confirm", id }), CrystalNotReadyError);
  const fields = Object.fromEntries(typed.detail!.checklistSpec!.map((field) => [field, { value: `已核对 ${field}`, conflict: false }]));
  const saved = await service.request({ action: "checklist", id, fields });
  assert.equal(saved.detail!.validation.ready, true);
  assert.deepEqual(saved.detail!.crystal.checklist.goal!.sources, ["user:manual"]);
  const confirmed = await service.request({ action: "confirm", id, name: "协作项目" });
  assert.equal(confirmed.overview.slots.length, 0);
  assert.equal(confirmed.overview.formal[0]?.name, "协作项目");
  const core = new CrystalService({ storage: new CrystalStorage({ agentDir: root }) });
  await core.initialize();
  assert.match(await core.promptText(`@[协作项目](biny://crystal/${id})`) ?? "", /已核对 goal/u);
  const bundle = core.storage.insertBundle({ threadId: recorder.sessionId, anchorIds: created.detail!.materials.map((material) => (material.ref as { anchorId: string }).anchorId) });
  core.addMaterial(id, "bundle", { bundleId: bundle.id });
  core.close();
  const withBundle = await service.request({ action: "detail", id });
  assert.deepEqual(Object.values(withBundle.detail!.materialPreviews), ["ProjectX 的目标是改进协作", "ProjectX 的目标是改进协作"]);
  const guarded = new CrystalService({
    storage: new CrystalStorage({ agentDir: root }),
    allowActivity: () => false,
    readAnchorText: async () => { throw new Error("权限阻止后不应读取活动内容"); },
    getModel: () => { throw new Error("权限阻止后不应请求模型"); }
  });
  await guarded.initialize();
  const activityBundle = guarded.storage.insertBundle({ threadId: "activity:ProjectX", anchorIds: ["activity:test-session"] });
  guarded.addMaterial(id, "bundle", { bundleId: activityBundle.id });
  await assert.rejects(guarded.prefill(id), /当前活动权限/u);
  assert.equal(await guarded.promptText(`@[协作项目](biny://crystal/${id})`), undefined);
  guarded.close();
  const seed = await service.request({ action: "seed", name: "另一个主题" });
  const seedId = seed.detail!.crystal.id;
  assert.equal((await service.request({ action: "slot", id: seedId, slot: null })).overview.backpack.some((entry) => entry.id === seedId), true);
  assert.equal((await service.request({ action: "slot", id: seedId, slot: 1 })).overview.slots.length, 1);
  assert.equal(desktopCrystalRequestSchema.safeParse({ action: "seed", name: "X", sessionId: "../../private" }).success, false);
  await assert.rejects(service.request({ action: "checklist", id: seedId, fields: { invalid: { value: "bad", conflict: false } } }));
  console.log("desktop crystal tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
