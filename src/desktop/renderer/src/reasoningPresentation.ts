/**
 * 思考步骤的展示文本。
 *
 * 部分模型只上报开始事件而不回传内容；此时返回空串，结束后不留下空的思考行。
 */
import type { TimelineReasoningStep } from "./sessionTimeline.js";

export function reasoningDetailText(step: Pick<TimelineReasoningStep, "content">): string {
  return step.content.trim();
}
