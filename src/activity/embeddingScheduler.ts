/**
 * Activity 语义向量的后台调度器。
 *
 * 向量是 OCR/分析结果的本地派生缓存，不应把首次搜索变成一次不可预测的大任务。
 * 每轮完成后再安排下一轮；用户活跃时短暂延后，避免与前台推理竞争资源。
 */

export const ACTIVITY_EMBEDDING_INITIAL_DELAY_MS = 5 * 60_000;
export const ACTIVITY_EMBEDDING_SWEEP_INTERVAL_MS = 5 * 60_000;

export type ActivityEmbeddingTimerHandle = ReturnType<typeof setTimeout>;

export interface ActivityEmbeddingSchedulerTimers {
  setTimeout: (callback: () => void, ms: number) => ActivityEmbeddingTimerHandle;
  clearTimeout: (handle: ActivityEmbeddingTimerHandle) => void;
}

export interface ActivityEmbeddingSchedulerOptions {
  run: () => void | Promise<void>;
  isUserActive?: () => boolean;
  initialDelayMs?: number;
  sweepIntervalMs?: number;
  timers?: ActivityEmbeddingSchedulerTimers;
}

const defaultTimers: ActivityEmbeddingSchedulerTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle)
};

export class ActivityEmbeddingScheduler {
  private readonly run: () => void | Promise<void>;
  private readonly isUserActive: (() => boolean) | undefined;
  private readonly initialDelayMs: number;
  private readonly sweepIntervalMs: number;
  private readonly timers: ActivityEmbeddingSchedulerTimers;
  private timer?: ActivityEmbeddingTimerHandle;
  private running = false;
  private stopped = true;

  constructor(options: ActivityEmbeddingSchedulerOptions) {
    this.run = options.run;
    this.isUserActive = options.isUserActive;
    this.initialDelayMs = options.initialDelayMs ?? ACTIVITY_EMBEDDING_INITIAL_DELAY_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? ACTIVITY_EMBEDDING_SWEEP_INTERVAL_MS;
    this.timers = options.timers ?? defaultTimers;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(Math.max(0, this.initialDelayMs));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.timer !== undefined || !Number.isFinite(delayMs) || delayMs < 0) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.trigger();
    }, delayMs);
  }

  private trigger(): void {
    if (this.stopped || this.running) return;
    if (this.isUserActive?.()) {
      this.schedule(30_000);
      return;
    }
    this.running = true;
    let result: void | Promise<void>;
    try {
      result = this.run();
    } catch {
      result = undefined;
    }
    void Promise.resolve(result).catch(() => undefined).finally(() => {
      this.running = false;
      if (this.sweepIntervalMs > 0) this.schedule(this.sweepIntervalMs);
    });
  }
}
