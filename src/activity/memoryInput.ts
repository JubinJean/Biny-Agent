/** 活动分析候选转换为记忆条目；工作区授权和写入由调用方负责。 */
import type { MemoryEntryInput } from "../agent/context/memoryTypes.js";
import type { ActivityMemoryCandidate, ActivityMemoryWriteContext } from "./analyzer.js";

export function activityMemoryInput(candidate: ActivityMemoryCandidate, context: ActivityMemoryWriteContext): MemoryEntryInput {
  const isUniversal = candidate.type === "user";
  const project = context.project?.trim();
  const tags = project ? [candidate.type, `project:${project}`] : [candidate.type];
  return {
    audience: isUniversal ? "universal" : "workspace",
    kind: isUniversal ? "working_style" : candidate.type === "feedback" ? "gotcha" : "fact",
    topic: isUniversal ? "user" : candidate.type,
    title: candidate.content.slice(0, 120),
    summary: candidate.content,
    keywords: tags,
    source: "auto",
    activitySource: "activity_session",
    activitySessionId: context.sessionId,
    tags,
    rationale: candidate.why.trim() || undefined,
    importance: candidate.type === "feedback" || isUniversal ? 0.8 : 0.7,
    durability: "permanent",
    lineage: {
      source: "completed_task",
      externalContext: false,
      sessionId: context.sessionId,
      userEvidence: candidate.why
    }
  };
}
