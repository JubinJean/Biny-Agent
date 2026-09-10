/** 模型选择器共用的思考档位计算；这里保持纯函数，避免 UI 引入后端运行时依赖。 */
import { projectThinkingSelectionToModel } from "../ai/capabilities.js";
import type { ReasoningEffort, ThinkingLevelMap } from "../config/schema.js";

export type ThinkingSelection = "off" | ReasoningEffort;

export interface ModelThinkingSelectionSource {
  efforts: readonly ReasoningEffort[];
  thinkingLevelMap: ThinkingLevelMap;
}

export function thinkingLabel(value: ThinkingSelection): string {
  // 直接展示模型声明的 canonical 英文 token，不做本地化转换。
  return value;
}

/**
 * `off` 是否可用由模型的 canonical map 决定，Desktop Composer 和 TUI 共用同一顺序。
 */
export function modelThinkingSelections(model: ModelThinkingSelectionSource): ThinkingSelection[] {
  return [
    ...(model.thinkingLevelMap.off !== undefined && model.thinkingLevelMap.off !== null ? ["off" as const] : []),
    ...model.efforts
  ];
}

/** 新模型不支持当前档位时优先投影到等价/最近的代表档位，再回退到模型默认值；不支持 thinking 时返回 undefined。 */
export function thinkingSelectionForModel(
  current: ThinkingSelection,
  model: Pick<ModelThinkingSelectionSource, "efforts"> & { defaultThinking: ThinkingSelection; thinkingLevelMap?: ThinkingLevelMap }
): ThinkingSelection | undefined {
  if (!model.efforts.length) return undefined;
  if (current === "off" && model.thinkingLevelMap?.off !== undefined && model.thinkingLevelMap.off !== null) return "off";
  if (model.efforts.includes(current as ReasoningEffort)) return current;
  // 档位列表已按原生值去重；换模型后旧档位可能未声明，按原生值/位置投影而不是跳到默认档。
  if (current !== "off" && model.thinkingLevelMap) {
    const equivalent = projectThinkingSelectionToModel(model.thinkingLevelMap, model.efforts, current);
    if (equivalent) return equivalent;
  }
  return model.defaultThinking;
}
