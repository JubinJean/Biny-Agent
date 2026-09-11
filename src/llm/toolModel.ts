/** 后台文本任务共用的工具模型：显式选择优先，否则从已配置且可用的模型中自动选择。 */
import type { AgentModel } from "../agent/core/types.js";
import type { AgentConfig } from "../config/schema.js";
import { ModelRegistry } from "./ModelRegistry.js";
import { ProviderRegistry } from "./ProviderRuntime.js";

export type MemoryModelField = "memoryModel" | "rewriteModel" | "extractModel";

/** 记忆可覆盖全局辅助模型；清空覆盖后回到全局选择，不随聊天模型切换。 */
export function resolveMemoryModelAlias(config: AgentConfig, field: MemoryModelField = "memoryModel"): string | undefined {
  return resolveToolModelAlias({
    ...config,
    toolModel: config.context.memory[field] ?? config.context.memory.memoryModel ?? config.toolModel
  });
}

export function resolveToolModelAlias(config: AgentConfig): string | undefined {
  const registry = new ModelRegistry(config);
  if (config.toolModel) {
    const selected = registry.resolve(config.toolModel);
    return selected?.source === "configured" && registry.isAvailable(selected) ? selected.alias : undefined;
  }
  // 只用已有目录中的价格，不从型号名称猜测性能或费用；同价时保持配置顺序，避免随聊天切换。
  const candidates = Object.keys(config.models).flatMap((alias) => {
    const model = registry.resolve(alias);
    return model && registry.isAvailable(model) ? [model] : [];
  }).sort((left, right) => {
    const leftPrice = left.model.pricing?.inputPerMillionTokens !== undefined && left.model.pricing.outputPerMillionTokens !== undefined
      ? left.model.pricing.inputPerMillionTokens + left.model.pricing.outputPerMillionTokens : Number.POSITIVE_INFINITY;
    const rightPrice = right.model.pricing?.inputPerMillionTokens !== undefined && right.model.pricing.outputPerMillionTokens !== undefined
      ? right.model.pricing.inputPerMillionTokens + right.model.pricing.outputPerMillionTokens : Number.POSITIVE_INFINITY;
    return leftPrice === rightPrice ? 0 : leftPrice < rightPrice ? -1 : 1;
  });
  return candidates[0]?.alias;
}

export function resolveToolModel(config: AgentConfig): AgentModel | undefined {
  const alias = resolveToolModelAlias(config);
  if (!alias) return undefined;
  try {
    return new ProviderRegistry(config).createModelSettings(alias).model;
  } catch {
    // 显式模型失效时不偷偷切换；配置修正后，下一轮后台任务重新解析。
    return undefined;
  }
}
