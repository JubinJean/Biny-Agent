/** 合成历史的容量/并发验收，不读取屏幕或真实活动；时间推进不能替代多日真人使用。 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { ActivityStore } from "../src/activity/store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-load-"));
const store = new ActivityStore();
const writer = new ActivityStore();
const started = performance.now();
try {
  await store.open(root);
  await writer.open(root);
  const occurredAt = "2026-01-01T10:00:00.000Z";
  for (let session = 0; session < 200; session++) {
    const id = store.startSession(occurredAt);
    for (let event = 0; event < 50; event++) store.recordEvent({ sessionId: id, occurredAt, eventType: "click", application: "Load QA", rawText: `中文活动回归 ${session}-${event}` });
    store.endSession(id, "2026-01-01T10:30:00.000Z");
  }
  const snapshotSession = store.startSession(occurredAt);
  const jpeg = await sharp({ create: { width: 256, height: 144, channels: 3, background: "#337755" } }).jpeg({ quality: 90 }).toBuffer();
  for (let index = 0; index < 512; index++) {
    await store.recordFallbackCapture({ sessionId: snapshotSession, occurredAt, eventType: "fallback_capture", jpeg, captureId: `load-${index}`, rawOcrText: "容量回归 OCR 文本" });
  }
  store.endSession(snapshotSession, "2026-01-01T10:30:00.000Z");
  console.log(JSON.stringify({ stage: "seeded", events: 10_000, snapshots: 512, elapsedMs: Math.round(performance.now() - started) }));
  const revision = store.activityRevision();
  const readStarted = performance.now();
  for (let index = 0; index < 10_000; index++) assert.equal(store.activityRevision(), revision);
  console.log(JSON.stringify({ stage: "cache-revision-read", reads: 10_000, elapsedMs: Math.round(performance.now() - readStarted) }));
  const freshSession = writer.startSession("2026-03-01T10:00:00.000Z");
  const rotating = store.rotateSnapshots(100, new Date("2026-03-01T11:00:00.000Z"));
  const fresh = writer.recordFallbackCapture({ sessionId: freshSession, occurredAt: "2026-03-01T10:00:00.000Z", eventType: "fallback_capture", jpeg, captureId: "fresh" });
  const [, captured] = await Promise.all([rotating, fresh]);
  // 每轮最多处理 500 张，第二轮必须处理剩下的旧图，同时保留刚写入的新图。
  await store.rotateSnapshots(100, new Date("2026-03-01T11:00:00.000Z"));
  assert.equal(store.snapshot().fallbackCaptures, 1);
  assert.deepEqual(await readFile(path.join(root, captured.snapshotPath!)), jpeg);
  const database = new DatabaseSync(path.join(root, "activity.sqlite"));
  try {
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM activity_events WHERE session_id = ?").get(snapshotSession) as { count: number }).count, 512, "删图不删除活动事件");
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM activity_ocr_frames WHERE session_id = ?").get(snapshotSession) as { count: number }).count, 0, "过期图片的 OCR 派生帧同步清理");
    const beforeRollback = store.activityRevision();
    database.exec("BEGIN; UPDATE activity_events SET summary = 'rolled back' WHERE rowid = (SELECT MIN(rowid) FROM activity_events); ROLLBACK;");
    assert.equal(store.activityRevision(), beforeRollback, "回滚不能提交缓存版本");
  } finally {
    database.close();
  }
  await store.reconcileSnapshotFiles();
  assert.deepEqual(await readFile(path.join(root, captured.snapshotPath!)), jpeg);
  await store.clear();
  assert.equal(writer.snapshot().sessions, 0);
  assert.equal(writer.snapshot().fallbackCaptures, 0);
  console.log(JSON.stringify({ stage: "passed", elapsedMs: Math.round(performance.now() - started) }));
} finally {
  await store.close();
  await writer.close();
  await rm(root, { recursive: true, force: true });
}
