/**
 * 设置内统一的布尔开关行：左侧标题与说明、右侧滑动开关。
 *
 * 开关几何与状态色按设计规范固定：轨道 1.5rem×2.75rem、圆头 1.25rem、
 * 选中位移 1.25rem，颜色走 --accent / --surface-hover 两个主题 token。
 */
interface SettingsSwitchProps {
  checked: boolean;
  detail: string;
  disabled?: boolean;
  label: string;
  onChange(value: boolean): void;
}

export function SettingsSwitch({ checked, detail, disabled = false, label, onChange }: SettingsSwitchProps): React.JSX.Element {
  return (
    <button
      aria-checked={checked}
      className={`settings-switch-row${checked ? " is-checked" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span className="settings-switch-copy"><strong>{label}</strong><small>{detail}</small></span>
      <span aria-hidden="true" className="settings-switch"><span className="settings-switch-thumb" /></span>
    </button>
  );
}
