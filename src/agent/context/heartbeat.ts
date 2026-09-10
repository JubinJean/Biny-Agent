/**
 * 周期心跳与 HEARTBEAT.md 文件协议。
 *
 * 心跳按内置节奏在活动时段触发；每次触发重新读取清单，避免运行中的 Agent 使用
 * 过期任务。执行回调由宿主提供，服务本身不持有模型或工具权限。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readDailyMemoryNote, readDailyMemorySection } from "../../activity/dailyNotes.js";
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
  private reflectionHintSentThisSession = false;

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
    this.reflectionHintSentThisSession = false;
    void this.fileStore.ensure().catch((error) => { this.lastError = errorMessage(error); });
    this.timer = this.timers.setInterval(() => { void this.tick(); }, this.schedule.intervalMinutes * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) this.timers.clearInterval(this.timer);
    this.timer = undefined;
    this.abort.abort();
    this.inFlight = false;
    this.reflectionHintSentThisSession = false;
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
        content ? `HEARTBEAT.md content:\n${content}` : undefined,
        "If nothing needs the user's personal attention, reply HEARTBEAT_OK."
      ].filter((value): value is string => Boolean(value));
      const emotionPrompt = this.baseEmotionPrompt(this.schedule, now);
      if (emotionPrompt) promptParts.splice(Math.max(0, promptParts.length - 1), 0, emotionPrompt);
      const diaryPrompt = await this.diaryPrompt(this.schedule, now);
      if (diaryPrompt) promptParts.splice(Math.max(0, promptParts.length - 1), 0, diaryPrompt);
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
      "BASE EMOTION REFRESH: Check the current base emotion. If a persistent change is warranted, reflect on the recent activity and use update_emotion with scope=base, a mood, valence, energy, and a concise trigger."
    ].join("\n");
  }

  private async diaryPrompt(schedule: HeartbeatSchedule, now: Date): Promise<string | undefined> {
    if (this.reflectionHintSentThisSession) return undefined;
    const hour = localHour(now);
    if (hour >= 10) {
      const missed = await this.missedDiaryDates(now, 3);
      if (missed.length) {
        this.reflectionHintSentThisSession = true;
        return [
          "---",
          `MISSED DIARY CATCH-UP: Write a brief self-reflection for each missed date: ${missed.join(", ")}. Prioritize the most recent date and keep older entries shorter.`
        ].join("\n");
      }
    }
    if (hour !== 23 || await this.didReflect(formatLocalDate(now))) return undefined;
    this.reflectionHintSentThisSession = true;
    return [
      "---",
      `DAILY DIARY TIME: Write today's (${formatLocalDate(now)}) diary from the available chat and activity notes, including a brief self-reflection.`
    ].join("\n");
  }

  private async missedDiaryDates(now: Date, days: number): Promise<string[]> {
    const missed: string[] = [];
    for (let offset = 1; offset <= days; offset += 1) {
      const date = new Date(now.getTime());
      date.setDate(date.getDate() - offset);
      const dateKey = formatLocalDate(date);
      if (!await this.didReflect(dateKey)) missed.push(dateKey);
    }
    return missed;
  }

  private async didReflect(dateKey: string): Promise<boolean> {
    try {
      const note = await readDailyMemoryNote(dateKey, { configDir: path.dirname(this.fileStore.path) });
      return readDailyMemorySection(note ?? "", "自我反思") !== undefined;
    } catch {
      return false;
    }
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

function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
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
