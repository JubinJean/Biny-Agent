import type { ModelChoice } from "../../../../../llm/ModelManager.js";
import { catalogForConnection } from "../../providerCatalog.js";

export interface SettingsModelPickerOption {
  value: string;
  label: string;
  secondary?: string;
  disabled?: boolean;
}

export interface SettingsModelPickerGroup {
  key: string;
  label: string;
  iconTone: string;
  options: SettingsModelPickerOption[];
}

export function modelPickerGroups(models: readonly ModelChoice[]): SettingsModelPickerGroup[] {
  const groups = new Map<string, SettingsModelPickerGroup>();
  for (const model of models) {
    if (model.showInPicker === false) continue;
    const presentation = modelProviderPresentation(model);
    const key = `${model.providerType}:${model.provider}:${model.baseUrl ?? ""}`;
    const group = groups.get(key) ?? {
      key,
      label: presentation.label,
      iconTone: presentation.iconTone,
      options: []
    };
    group.options.push({
      value: model.alias,
      label: model.displayName,
      secondary: model.model !== model.displayName ? model.model : model.alias
    });
    groups.set(key, group);
  }
  return [...groups.values()];
}

function modelProviderPresentation(model: Pick<ModelChoice, "provider" | "providerType" | "baseUrl">): { label: string; iconTone: string } {
  const catalog = catalogForConnection({ provider: model.provider, providerType: model.providerType }, model.baseUrl);
  return {
    label: catalog?.label ?? model.provider,
    iconTone: catalog?.iconTone ?? model.providerType
  };
}
