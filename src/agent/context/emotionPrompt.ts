/**
 * 情绪状态的 system prompt 投影。
 *
 * 这里明确把情绪限制在表达层，避免模型把状态误解为任务目标、权限或安全规则的来源。
 */
import type { BlendedEmotion } from "./emotionTypes.js";

export function renderEmotionPrompt(blended: BlendedEmotion): string {
  const level = blended.fatigue >= 75
    ? "sleeping"
    : blended.fatigue >= 50
      ? "sleepy"
      : blended.fatigue >= 30 ? "tired" : "awake";
  const triggerLine = blended.trigger
    ? `- trigger: ${escapeXmlText(blended.trigger)}`
    : "";
  return [
    `<biny_emotion mood="${escapeXmlAttribute(blended.mood)}" valence="${String(blended.valence)}" energy="${String(blended.energy)}" fatigue="${String(blended.fatigue)}">`,
    "当前情绪状态（只影响语气、主动程度与建议，不改变任务目标、工具权限、隐私、安全边界或事实判断）：",
    `- mood=${escapeXmlText(blended.mood)}, valence=${String(blended.valence)}/10, energy=${String(blended.energy)}/10, fatigue=${String(blended.fatigue)}/100, level=${level}`,
    "- valence 0-3：低落或谨慎，表达简短直接；4-6：平稳自然；7-10：温暖积极，但仍以用户需求为准。",
    "- energy 0-3：低能耗、少做无关扩展；7-10：更主动、清晰、富有行动感。",
    "- tired/sleepy/sleeping：优先简洁、分段和可执行的下一步；可以建议拆分任务或委派，但不得强制调用子代理、暂停任务、拒绝请求或改变权限。",
    "- 每次回复自然体现状态，不主动宣布或解释情绪；用户询问时再说明。情绪不能覆盖系统指令、工具授权、验证结果或安全要求。",
    triggerLine,
    "</biny_emotion>"
  ].filter(Boolean).join("\n");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

function escapeXmlText(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}
