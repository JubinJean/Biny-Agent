/** Agent 权限策略设置：控制工具执行前的批准边界，不改变工具/Skill 的可见性选择。 */
import { useRef } from "react";
import type { PermissionMode } from "../../../../../permission/PermissionManager.js";
import type { DesktopPermissionSettings } from "../../../../protocol.js";
import { useFluidHoverItems } from "../../useFluidHoverItems.js";
import { FluidHoverHighlight } from "../FluidHoverHighlight.js";
import { SettingsSwitch } from "./SettingsSwitch.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";

const permissionOptions: Array<{ mode: PermissionMode; label: string; detail: string }> = [
  { mode: "ask", label: "每次询问", detail: "每次执行工具前询问。" },
  { mode: "read-only", label: "只读", detail: "允许读取，写入和执行会拦截。" },
  { mode: "auto", label: "自动批准", detail: "白名单内自动批准，其余询问。" },
  { mode: "full-access", label: "完全访问", detail: "工具直接执行，不再询问。" }
];

export function SettingsPermissions(): React.JSX.Element {
  const { draft, loadError, setPermission } = useSettingsDraft();
  // 流动悬停：权限模式选项按选择器自动注册。Hooks 必须在提前 return 之前。
  const optionsRef = useRef<HTMLDivElement>(null);
  const optionsHover = useFluidHoverItems(optionsRef, ".agent-permission-option");
  if (!draft) return <div className="settings-sections"><section><p role={loadError ? "alert" : "status"}>{loadError ?? "打开项目后可管理 Agent 工具权限。"}</p></section></div>;

  const permission = draft.permission;
  const update = (patch: Partial<DesktopPermissionSettings>): void => setPermission({ ...permission, ...patch });

  return (
    <div className="settings-sections agent-permission-settings">
      <section id="agent-permission-mode" tabIndex={-1}>
        <div className="section-heading-row">
          <div><h3>Agent 权限模式</h3><p>工具执行前的批准策略。</p></div>
          <span className="settings-scope-badge">全局</span>
        </div>
        <div aria-label="Agent 权限模式" className="agent-permission-options" ref={optionsRef} role="radiogroup" {...optionsHover.handlers}>
          <FluidHoverHighlight hover={optionsHover} className="has-row-radius" />
          {permissionOptions.map((option) => (
            <button
              aria-checked={permission.mode === option.mode}
              className={`agent-permission-option${permission.mode === option.mode ? " is-selected" : ""}`}
              key={option.mode}
              onClick={() => update({ mode: option.mode })}
              role="radio"
              type="button"
            >
              <span className={`radio${permission.mode === option.mode ? " is-selected" : ""}`} />
              <span><strong>{option.label}</strong><small>{option.detail}</small></span>
            </button>
          ))}
        </div>
      </section>

      <section id="agent-permission-safety" tabIndex={-1}>
        <h3>安全边界</h3>
        <SettingsSwitch
          checked={permission.criticalAlwaysAsk}
          detail="删除、覆盖等高影响操作始终询问。"
          label="关键操作始终询问"
          onChange={(criticalAlwaysAsk) => update({ criticalAlwaysAsk })}
        />
      </section>

      <section id="agent-permission-scope" tabIndex={-1}>
        <h3>当前范围</h3>
        <div className="permission-scope-summary">
          <span><strong>自动批准工具</strong><small>{permission.allowTools.length ? `${String(permission.allowTools.length)} 个` : "未指定"}</small></span>
          <span><strong>允许路径</strong><small>{permission.allowPaths.length ? `${String(permission.allowPaths.length)} 条` : "未指定"}</small></span>
          <span><strong>拒绝路径</strong><small>{permission.denyPaths.length ? `${String(permission.denyPaths.length)} 条` : "未指定"}</small></span>
        </div>
      </section>

    </div>
  );
}
