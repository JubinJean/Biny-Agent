/** 能力菜单外部展示用的选择数量计算。 */
import type { AgentCapabilitySelection, CapabilitySelectionValue } from "../../../../../agent/capabilitySelection.js";

function explicitNames(value: CapabilitySelectionValue): string[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function explicitCapabilityCount(selection: AgentCapabilitySelection): number {
  return (explicitNames(selection.tools)?.length ?? 0) + (explicitNames(selection.skills)?.length ?? 0);
}
