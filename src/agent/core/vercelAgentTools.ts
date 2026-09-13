/** 把 Biny 工具协议接到 Vercel AI SDK，并保留工具审计与进度事件。 */
import { jsonSchema, tool, type ToolSet } from "ai";
import { openai } from "@ai-sdk/openai";
import type { JSONSchema7 } from "@ai-sdk/provider";
import type { VercelLoopState } from "./vercelAgentLoop.js";
import type { AgentToolResult } from "./types.js";
import { errorMessage, isRecord } from "./vercelAgentUtils.js";

export function createVercelTools(state: VercelLoopState): ToolSet {
  const entries = state.tools.map((agentTool) => [
    agentTool.name,
    tool({
      description: agentTool.description,
      inputSchema: jsonSchema(agentTool.parameters as unknown as JSONSchema7),
      execute: async (input: unknown, options: { toolCallId: string; abortSignal?: AbortSignal }) => {
        const execute = async (): Promise<AgentToolResult> => {
          const args = isRecord(input) ? input : {};
          state.pendingEvents.push({
            type: "tool_execution_start",
            toolCallId: options.toolCallId,
            toolName: agentTool.name,
            args
          });
          state.wakePendingEvents?.();

          let result: AgentToolResult;
          try {
            result = await agentTool.execute(
              options.toolCallId,
              args,
              options.abortSignal,
              (update) => {
                state.pendingEvents.push({
                  type: "tool_execution_update",
                  toolCallId: options.toolCallId,
                  toolName: agentTool.name,
                  update
                });
                state.wakePendingEvents?.();
              }
            );
          } catch (error) {
            result = {
              content: [{ type: "text", text: errorMessage(error) }],
              isError: true
            };
          }
          state.toolResults.set(options.toolCallId, result);
          state.pendingEvents.push({
            type: "tool_execution_end",
            toolCallId: options.toolCallId,
            toolName: agentTool.name,
            result
          });
          state.wakePendingEvents?.();
          if (result.terminate) state.terminateRequested = true;
          return result;
        };

        const sequential = state.config.toolExecution === "sequential"
          || agentTool.executionMode === "sequential";
        if (!sequential) return await execute();

        const previous = state.sequentialToolTail;
        let release: (() => void) | undefined;
        state.sequentialToolTail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try {
          return await execute();
        } finally {
          release?.();
        }
      }
    })
  ] as const);
  const tools = Object.fromEntries(entries) as ToolSet;
  for (const agentTool of state.tools) {
    if (agentTool.providerTool !== "openai-apply-patch") continue;
    const execute = tools[agentTool.name]!.execute!;
    tools[agentTool.name] = {
      ...openai.tools.applyPatch({}),
      execute: async (input, options) => {
        const result = await execute(input, options) as AgentToolResult;
        return { status: result.isError ? "failed" : "completed", output: result.content.map((part) => part.type === "text" ? part.text : "").join("\n") };
      }
    };
  }
  return tools;
}
