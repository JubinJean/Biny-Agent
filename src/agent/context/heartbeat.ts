/**
 * 周期心跳与 HEARTBEAT.md 文件协议。
 *
 * 心跳按内置节奏在活动时段触发；每次触发重新读取清单，避免运行中的 Agent 使用
 * 过期任务。执行回调由宿主提供，服务本身不持有模型或工具权限。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { globalConfigDir } from "../../config/paths.js";

export interface HeartbeatSchedule {
  intervalMinutes: number;
  activeHoursStart: number;
  activeHoursEnd: number;
  baseEmotionRefreshHours: number;
}

/** 与 Alma 默认行为对齐；这是内置机制，不进入用户配置文件。 */
export const defaultHeartbeatSchedule: HeartbeatSchedule = Object.freeze({
  intervalMinutes: 30,
  activeHoursStart: 8,
  activeHoursEnd: 23,
  baseEmotionRefreshHours: 3
});

export interface HeartbeatStatus {
  running: boolean;
  lastHeartbeatAt?: string;
  lastError?: string;
  activeHours: { start: number; end: number };
}

export interface HeartbeatSchedulerOptions {
  run: (prompt: string, signal: AbortSignal) => void | Promise<void>;
  configDir?: string;
  now?: () => Date;
  timers?: {
    setInterval: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
    clearInterval: (handle: ReturnType<typeof setInterval>) => void;
  };
}

const defaultTimers: NonNullable<HeartbeatSchedulerOptions["timers"]> = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle)
};

export class HeartbeatFileStore {
  readonly path: string;

  constructor(configDir = globalConfigDir()) {
    this.path = path.join(path.resolve(configDir), "HEARTBEAT.md");
  }

  async ensure(): Promise<void> {
    try {
      await readFile(this.path, "utf8");
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await mkdir(path.dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(this.path, defaultHeartbeatDocument(), { encoding: "utf8", mode: 0o600 });
    }
  }

  async read(): Promise<string | undefined> {
    try {
      const content = (await readFile(this.path, "utf8")).trim();
      return content || undefined;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }
}

export class HeartbeatScheduler {
  private readonly schedule: HeartbeatSchedule;
  private readonly run: HeartbeatSchedulerOptions["run"];
  private readonly fileStore: HeartbeatFileStore;
  private readonly now: () => Date;
  private readonly timers: NonNullable<HeartbeatSchedulerOptions["timers"]>;
  private timer?: ReturnType<typeof setInterval>;
  private abort = new AbortController();
  private inFlight = false;
  private lastHeartbeatAt?: string;
  private lastError?: string;
  private lastBaseEmotionRefresh = 0;

  constructor(options: HeartbeatSchedulerOptions) {
    this.schedule = defaultHeartbeatSchedule;
    this.run = options.run;
    this.fileStore = new HeartbeatFileStore(options.configDir);
    this.now = options.now ?? (() => new Date());
    this.timers = options.timers ?? defaultTimers;
  }

  start(): void {
    if (this.timer) return;
    this.abort = new AbortController();
    void this.fileStore.ensure().catch((error) => { this.lastError = errorMessage(error); });
    this.timer = this.timers.setInterval(() => { void this.tick(); }, this.schedule.intervalMinutes * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) this.timers.clearInterval(this.timer);
    this.timer = undefined;
    this.abort.abort();
    this.inFlight = false;
  }

  async triggerNow(): Promise<boolean> {
    return await this.tick(true);
  }

  status(): HeartbeatStatus {
    return {
      running: this.inFlight,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastError: this.lastError,
      activeHours: { start: this.schedule.activeHoursStart, end: this.schedule.activeHoursEnd }
    };
  }

  private async tick(force = false): Promise<boolean> {
    if (this.inFlight) return false;
    if (!force && !isActiveHour(this.schedule, this.now())) return false;
    this.inFlight = true;
    this.lastError = undefined;
    try {
      const content = await this.fileStore.read();
      const now = this.now();
      const promptParts = [
        content ? `HEARTBEAT.md (the user's checklist):\n${content}` : undefined,
        "This is a quiet background check. If nothing needs the user's personal attention, reply HEARTBEAT_OK."
      ].filter((value): value is string => Boolean(value));
      const emotionPrompt = this.baseEmotionPrompt(this.schedule, now);
      if (emotionPrompt) promptParts.splice(Math.max(0, promptParts.length - 1), 0, emotionPrompt);
      const prompt = promptParts.join("\n\n");
      await this.run(prompt, this.abort.signal);
      this.lastHeartbeatAt = this.now().toISOString();
      return true;
    } catch (error) {
      if (!this.abort.signal.aborted) this.lastError = errorMessage(error);
      return false;
    } finally {
      this.inFlight = false;
    }
  }

  private baseEmotionPrompt(schedule: HeartbeatSchedule, now: Date): string | undefined {
    const intervalMs = schedule.baseEmotionRefreshHours * 60 * 60 * 1_000;
    if (now.getTime() - this.lastBaseEmotionRefresh < intervalMs) return undefined;
    this.lastBaseEmotionRefresh = now.getTime();
    return [
      "---",
      "BASE EMOTION REFRESH: Check whether recent activity justifies a persistent change. If it does, reflect briefly and use update_emotion with scope=base, mood, valence, energy, and a concise trigger. Never claim an update without the tool result."
    ].join("\n");
  }


}

export function isActiveHour(schedule: HeartbeatSchedule, date: Date): boolean {
  const hour = localHour(date);
  return schedule.activeHoursStart <= schedule.activeHoursEnd
    ? hour >= schedule.activeHoursStart && hour < schedule.activeHoursEnd
    : hour >= schedule.activeHoursStart || hour < schedule.activeHoursEnd;
}

function localHour(date: Date): number {
  return date.getHours();
}


function defaultHeartbeatDocument(): string {
  return [
    "# Heartbeat Checklist",
    "",
    "- If the user has not interacted in over 4 hours during active hours, send a brief check-in.",
    "- If nothing needs attention, reply HEARTBEAT_OK.",
    "",
    "<!-- Periodic tasks can be added here. -->",
    ""
  ].join("\n");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
