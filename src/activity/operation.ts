/** 显式 Activity 操作的检查点：跨进程清空或收紧配置后，不再消费、外发或提交旧结果。 */
import type { ActivitySettings } from "./settings.js";
import type { ActivityStore } from "./store.js";

export interface ActivityOperation {
  signal: AbortSignal;
  checkpoint(): Promise<void>;
}

export function createActivityOperation(
  store: ActivityStore,
  settings: ActivitySettings,
  loadSettings: () => Promise<ActivitySettings>,
  parentSignal?: AbortSignal
): ActivityOperation {
  const cancelled = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, cancelled.signal]) : cancelled.signal;
  const revision = store.clearRevision();
  const scope = privacyScope(settings);
  return {
    signal,
    async checkpoint() {
      signal.throwIfAborted();
      try {
        if (store.clearRevision() !== revision) throw new Error("cleared");
        const current = await loadSettings();
        if (store.clearRevision() !== revision || privacyScope(current) !== scope) throw new Error("changed");
      } catch {
        // 不能读取最新采集设置同样失败关闭；一旦失效，即使配置随后改回也不能恢复这个旧操作。
        cancelled.abort(new DOMException("Activity 数据或采集设置已改变，请重新发起操作。", "AbortError"));
      }
      signal.throwIfAborted();
    }
  };
}

function privacyScope(settings: ActivitySettings): string {
  return JSON.stringify([
    settings.outputDirectory, settings.enabled,
    [...settings.sensitiveApplications].sort()
  ]);
}
