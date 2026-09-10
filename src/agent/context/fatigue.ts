/**
 * Agent 疲劳的本地持久化与时间计算。
 *
 * 疲劳跨 session、AgentSession 和进程保留，并通过 prompt 影响表达与工作节奏；高疲劳时模型
 * 可以拒绝亲自执行非琐碎任务或使用已有的委派工具，但运行时仍掌握真实权限。时段加成独立
 * 计算，记录到文件的基础值不包含该加成。
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { globalAgentDir } from "../../config/paths.js";

const fatigueFileName = "fatigue.json";
const fatiguePerMessage = 1.5;
const fatigueDecayPerMinute = 0.8;
const fatigueDecayMinuteMs = 60_000;
const maxFatigue = 100;

export type FatigueLevel = "awake" | "tired" | "sleepy" | "sleeping";

export interface FatigueState {
  fatigue: number;
  messageCount: number;
  lastMessageTime: string;
}

export interface FatigueStatus {
  fatigue: number;
  level: FatigueLevel;
  messageCount: number;
  isNight: boolean;
}

export interface FatigueServiceOptions {
  agentDir?: string;
  now?: () => Date;
}

export class FatigueService {
  private readonly filePath: string;
  private readonly now: () => Date;
  private state: FatigueState;

  constructor(options: FatigueServiceOptions = {}) {
    const agentDir = path.resolve(options.agentDir ?? globalAgentDir());
    this.filePath = path.join(agentDir, fatigueFileName);
    this.now = options.now ?? (() => new Date());
    this.state = defaultFatigueState(this.now());
  }

  get path(): string {
    return this.filePath;
  }

  async initialize(): Promise<void> {
    this.state = await this.readState();
  }

  async read(): Promise<FatigueState> {
    this.state = await this.readState();
    return { ...this.state };
  }

  async recordMessage(): Promise<FatigueStatus> {
    const state = await this.readState();
    const now = this.now();
    const next: FatigueState = {
      fatigue: Math.min(maxFatigue, decayFatigue(state, now) + fatiguePerMessage),
      messageCount: state.messageCount + 1,
      lastMessageTime: now.toISOString()
    };
    await this.writeState(next);
    this.state = next;
    return statusFor(next, now);
  }

  status(): FatigueStatus {
    return statusFor(this.state, this.now());
  }

  getFatigue(): number {
    return this.status().fatigue;
  }

  async currentStatus(): Promise<FatigueStatus> {
    await this.read();
    return this.status();
  }

  private async readState(): Promise<FatigueState> {
    try {
      const content = await fs.readFile(this.filePath, "utf8");
      return parseFatigueState(JSON.parse(content), this.now());
    } catch {
      return defaultFatigueState(this.now());
    }
  }

  private async writeState(state: FatigueState): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporary, "w", 0o600);
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
    }
  }
}

export function fatigueLevel(value: number): FatigueLevel {
  if (value >= 75) return "sleeping";
  if (value >= 50) return "sleepy";
  if (value >= 30) return "tired";
  return "awake";
}

export function fatigueTimeBonus(date: Date): number {
  const hour = date.getHours();
  if (hour >= 1 && hour < 6) return 30;
  if (hour >= 23 || hour < 8) return 15;
  if (hour >= 13 && hour <= 14) return 8;
  return 0;
}

function statusFor(state: FatigueState, now: Date): FatigueStatus {
  const fatigue = Math.round(Math.min(maxFatigue, decayFatigue(state, now) + fatigueTimeBonus(now)));
  return {
    fatigue,
    level: fatigueLevel(fatigue),
    messageCount: state.messageCount,
    isNight: now.getHours() >= 23 || now.getHours() < 8
  };
}

function decayFatigue(state: FatigueState, now: Date): number {
  const lastMessage = Date.parse(state.lastMessageTime);
  const elapsedMs = Number.isFinite(lastMessage) ? Math.max(0, now.getTime() - lastMessage) : 0;
  const decay = elapsedMs / fatigueDecayMinuteMs * fatigueDecayPerMinute;
  return Math.max(0, Math.min(maxFatigue, state.fatigue - decay));
}

function defaultFatigueState(now: Date): FatigueState {
  return { fatigue: 0, messageCount: 0, lastMessageTime: now.toISOString() };
}

function parseFatigueState(value: unknown, now: Date): FatigueState {
  if (!isRecord(value)) return defaultFatigueState(now);
  const fatigue = value.fatigue;
  const messageCount = value.messageCount;
  const lastMessageTime = value.lastMessageTime;
  if (
    typeof fatigue !== "number"
    || !Number.isFinite(fatigue)
    || fatigue < 0
    || fatigue > maxFatigue
    || typeof messageCount !== "number"
    || !Number.isSafeInteger(messageCount)
    || messageCount < 0
    || (typeof lastMessageTime !== "string" && typeof lastMessageTime !== "number")
  ) return defaultFatigueState(now);
  const parsedTime = typeof lastMessageTime === "number"
    ? Number.isFinite(lastMessageTime) && lastMessageTime >= 0
      ? new Date(lastMessageTime).toISOString()
      : ""
    : lastMessageTime;
  if (!Number.isFinite(Date.parse(parsedTime))) return defaultFatigueState(now);
  return {
    fatigue,
    messageCount,
    lastMessageTime: parsedTime
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
