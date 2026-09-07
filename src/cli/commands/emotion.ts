/** 情绪文件的本地命令入口；不依赖 Runtime Host，保证后台任务也能直接读写快照。 */
import { EmotionStorage } from "../../agent/context/emotionStorage.js";
import { DEFAULT_EMOTION_STATE } from "../../agent/context/emotionTypes.js";

export async function emotionStatusCommand(): Promise<void> {
  const storage = new EmotionStorage();
  const base = await storage.readBase();
  console.log("=== Base Emotion (global) ===");
  const currentBase = base ?? DEFAULT_EMOTION_STATE;
  console.log(`  Mood: ${currentBase.mood} | Energy: ${String(currentBase.energy)}/10 | Valence: ${String(currentBase.valence)}/10`);
  if (currentBase.trigger) console.log(`  ${currentBase.trigger}`);
  console.log(`  Updated: ${base?.updatedAt ?? "never"}`);
  const contexts = await storage.listContexts();
  if (contexts.length) {
    console.log("=== Context Emotions ===");
    for (const context of contexts) {
      console.log(`  [${context.sessionId}] ${context.state.mood} (valence: ${String(context.state.valence)}/10) — ${context.state.trigger ?? "no trigger"} (${context.state.updatedAt})`);
    }
  }
}

export async function emotionSetBaseCommand(
  mood: string | undefined,
  energy: string | undefined,
  valence: string | undefined,
  description: string[]
): Promise<void> {
  const state = {
    mood: normalizeMood(mood),
    energy: parseEmotionNumber(energy),
    valence: parseEmotionNumber(valence),
    updatedAt: new Date().toISOString(),
    trigger: description.join(" ").trim() || undefined
  };
  await new EmotionStorage().writeBase(state);
  console.log(`✅ Base emotion set: ${state.mood} (energy: ${String(state.energy)}, valence: ${String(state.valence)})`);
}

export async function emotionSetContextCommand(
  sessionId: string | undefined,
  mood: string | undefined,
  valence: string | undefined,
  trigger: string[]
): Promise<void> {
  if (!sessionId) throw new Error("Usage: biny emotion set-context <sessionId> <mood> <valence> <trigger>");
  const base = await new EmotionStorage().readBase();
  const state = {
    mood: normalizeMood(mood),
    energy: base?.energy ?? DEFAULT_EMOTION_STATE.energy,
    valence: parseEmotionNumber(valence),
    updatedAt: new Date().toISOString(),
    trigger: trigger.join(" ").trim() || undefined
  };
  await new EmotionStorage().writeContext(sessionId, state);
  console.log(`✅ Context emotion for ${sessionId}: ${state.mood} (valence: ${String(state.valence)}/10) — ${state.trigger ?? ""}`);
}

export async function emotionGetCommand(sessionId?: string): Promise<void> {
  const storage = new EmotionStorage();
  const base = await storage.readBase();
  const context = sessionId ? await storage.readContext(sessionId) : undefined;
  const blended = await storage.readBlended(sessionId, 0);
  console.log(JSON.stringify({ base, context, blended }, null, 2));
}

function normalizeMood(value: string | undefined): string {
  return value?.replace(/\s+/gu, " ").trim() || "neutral";
}

function parseEmotionNumber(value: string | undefined): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(10, Math.max(0, parsed)) : 5;
}
