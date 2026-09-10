/**
 * 思考步骤的展示文本。
 *
 * 部分模型只上报「在思考」而不回传内容；此时返回空串，由调用方把思考行折叠成
 * 纯状态标题（Alma 式：只报「思考了 N 秒」），不渲染编造的占位句。
 */
import type { TimelineReasoningStep } from "./sessionTimeline.js";

export function reasoningDetailText(step: Pick<TimelineReasoningStep, "content">): string {
  return step.content.trim();
}
