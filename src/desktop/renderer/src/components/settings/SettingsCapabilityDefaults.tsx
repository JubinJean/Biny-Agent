/** 聊天默认能力设置：保存 Agent 每回合默认暴露的工具与 Skill 范围。 */
import type { CapabilitySelectionMode } from "../../../../../agent/capabilitySelection.js";
import type { DesktopChatParamsSettings } from "../../../../protocol.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";

// 三个选项含义自明（自动 / 全部 / 不调用），不再逐项解释。
const selectionOptions: Array<{ value: CapabilitySelectionMode; label: string }> = [
  { value: "auto", label: "自动" },
  { value: "all", label: "全部" },
  { value: "none", label: "不调用" }
];

export function SettingsCapabilityDefaults(): React.JSX.Element {
  const { draft, setChatParams } = useSettingsDraft();
  if (!draft) return <div className="settings-sections"><section><p>正在加载能力设置…</p></section></div>;

  const update = (patch: Partial<DesktopChatParamsSettings>): void => setChatParams({ ...draft.chatParams, ...patch });

  return (
    <div className="settings-sections capability-default-settings">
      <section id="chat-capability-defaults" tabIndex={-1}>
        <div className="section-heading-row">
          <div><h3>工具与 Skill</h3><p>新消息默认暴露的能力范围，发送前可在输入框临时调整。</p></div>
          <span className="settings-scope-badge">全局</span>
        </div>
        <CapabilitySelectionField
          label="默认工具调用"
          value={draft.chatParams.defaultToolSelection}
          onChange={(defaultToolSelection) => update({ defaultToolSelection })}
        />
        <CapabilitySelectionField
          label="默认 Skill"
          value={draft.chatParams.defaultSkillSelection}
          onChange={(defaultSkillSelection) => update({ defaultSkillSelection })}
        />
      </section>
    </div>
  );
}

function CapabilitySelectionField({ label, onChange, value }: {
  label: string;
  onChange(value: CapabilitySelectionMode): void;
  value: CapabilitySelectionMode;
}): React.JSX.Element {
  return (
    <div className="capability-default-field">
      <strong>{label}</strong>
      <div aria-label={label} className="capability-default-grid" role="radiogroup">
        {selectionOptions.map((option) => (
          <button
            aria-checked={option.value === value}
            className={`capability-default-option${option.value === value ? " is-selected" : ""}`}
            key={option.value}
            onClick={() => onChange(option.value)}
            role="radio"
            type="button"
          >
            <span className={`radio${option.value === value ? " is-selected" : ""}`} />
            <span className="capability-default-option-title">{option.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
