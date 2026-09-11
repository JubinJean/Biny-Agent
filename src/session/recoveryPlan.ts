/**
 * 中断回合恢复决策。
 *
 * Session JSONL 和 TurnStore 只提供事实；本模块把这些事实归一化成唯一的继续计划。
 * AgentSession 只能执行计划，不能再自行推断工具副作用、用户输入边界或剩余步数。
 */
import type { BlockedReason } from "../agent/types.js";
import type { ToolExecutionResultStatus } from "../tools/types.js";
import type { SessionEvent } from "./recorder.js";
import type { SessionReplay } from "./replay.js";
import type { RuntimeHighWater } from "./runtimeEvent.js";
import type { InterruptedTurn } from "./turnStore.js";

export type OperationRecoveryAction = "preserve-result" | "discard-not-started" | "park";

export interface OperationRecoveryDecision {
  tool: string;
  toolCallId?: string;
  /** 旧 session 的工具结果可能没有 operationId，归属判断仍必须 fail-closed。 */
  operationId?: string;
  executionStatus?: ToolExecutionResultStatus;
  action: OperationRecoveryAction;
  evidence?: string;
}

interface ContinuationPlanBase {
  turnId?: string;
  sessionHighWater?: RuntimeHighWater;
  operations: OperationRecoveryDecision[];
}

export type ContinuationPlan =
  | ContinuationPlanBase & { action: "continue"; remainingSteps: number }
  | ContinuationPlanBase & {
    action: "block";
    message: string;
    blockedReason: BlockedReason;
    requiredAction: string;
  }
  | ContinuationPlanBase & { action: "require-user-input"; message: string }
  | ContinuationPlanBase & { action: "exhausted"; message: string };

type RecoveryEvidence = Pick<
  SessionReplay,
  "events" | "recoveredToolResults" | "discardedToolCalls" | "runtimeHighWater"
>;

export function resolveContinuationPlan(
  turn: InterruptedTurn,
  replay: RecoveryEvidence,
  turnLimit: number
): ContinuationPlan {
  const turnId = turn.turnId ?? turn.runtimeHighWater?.turnId;
  const operationTurnIds = toolOperationTurnIds(replay.events);
  const operations = operationRecoveryDecisions(replay);
  const unsafeTools = new Set<string>();

  for (const operation of operations) {
    if (operation.action !== "park") continue;
    const operationTurnId = operation.toolCallId
      ? operationTurnIds.get(operation.toolCallId)
      : undefined;
    // 旧事件没有 turnId 时无法证明副作用属于别的任务，必须保守阻塞。
    if (!turnId || !operationTurnId || operationTurnId === turnId) unsafeTools.add(operation.tool);
  }

  const base: ContinuationPlanBase = {
    turnId,
    sessionHighWater: replay.runtimeHighWater,
    operations
  };
  if (unsafeTools.size > 0) {
    return {
      ...base,
      action: "block",
      message: `${[...unsafeTools].join("、")} 可能产生了未确认的副作用，恢复已阻塞。`,
      blockedReason: "unsafe_action_required",
      requiredAction: "Inspect the session facts and workspace, then start a new turn after resolving the unknown tool operation."
    };
  }
  if (
    turn.terminal?.status === "blocked"
    && (turn.terminal.blockedReason === "missing_user_input"
      || turn.terminal.blockedReason === "unsafe_action_required")
  ) {
    return {
      ...base,
      action: "require-user-input",
      message: turn.terminal.requiredAction
        ? `This blocked turn requires a new user message: ${turn.terminal.requiredAction}`
        : "This blocked turn requires a new user message before it can continue."
    };
  }
  const remainingSteps = turnLimit - turn.completedSteps;
  if (remainingSteps < 1) {
    return {
      ...base,
      action: "exhausted",
      message: `The interrupted turn already reached its ${String(turnLimit)}-step limit. Send a new user message to start another turn.`
    };
  }
  return { ...base, action: "continue", remainingSteps };
}

function toolOperationTurnIds(events: readonly SessionEvent[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const event of events) {
    const turnId = event.runtime?.turnId;
    if (!turnId) continue;
    if ((event.type === "tool_call" || event.type === "tool_execution") && event.toolCallId) {
      result.set(event.toolCallId, turnId);
      continue;
    }
    if (event.type !== "agent_message" || event.message.role !== "assistant") continue;
    for (const part of event.message.content) {
      if (part.type === "toolCall") result.set(part.id, turnId);
    }
  }
  return result;
}

function operationRecoveryDecisions(replay: RecoveryEvidence): OperationRecoveryDecision[] {
  const decisions = new Map<string, OperationRecoveryDecision>();
  for (const call of replay.discardedToolCalls) {
    decisions.set(call.operationId, {
      tool: call.tool,
      toolCallId: call.toolCallId,
      operationId: call.operationId,
      executionStatus: "cancelled",
      action: "discard-not-started"
    });
  }
  for (const [index, event] of [...replay.events, ...replay.recoveredToolResults].entries()) {
    if (event.type !== "tool_result" || event.executionStatus === undefined) continue;
    if (event.recovered !== true && event.executionStatus !== "unknown") continue;
    const decisionKey = event.operationId ?? event.toolCallId ?? `legacy-tool-result-${String(index)}`;
    decisions.set(decisionKey, {
      tool: event.tool,
      toolCallId: event.toolCallId,
      operationId: event.operationId,
      executionStatus: event.executionStatus,
      action: event.executionStatus === "unknown" ? "park" : "preserve-result",
      evidence: event.evidence
    });
  }
  return [...decisions.values()];
}
