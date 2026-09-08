/** Agent 权限策略设置：控制工具执行前的批准边界，不改变工具/Skill 的可见性选择。 */
import { useState } from "react";
import type { PermissionMode } from "../../../../../permission/PermissionManager.js";
import type { DesktopPermissionSettings } from "../../../../protocol.js";
import { Icon, type IconName } from "../Icon.js";
import { SettingsSwitch } from "./SettingsSwitch.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";
import { useActivityRuntime } from "./ActivityRuntimeContext.js";

const permissionOptions: Array<{ mode: PermissionMode; label: string; detail: string }> = [
  { mode: "ask", label: "每次询问", detail: "每次执行工具前询问。" },
  { mode: "read-only", label: "只读", detail: "允许读取，写入和执行会拦截。" },
  { mode: "auto", label: "自动批准", detail: "白名单内自动批准，其余询问。" },
  { mode: "full-access", label: "完全访问", detail: "工具直接执行，不再询问。" }
];

export function SettingsPermissions(): React.JSX.Element {
  const { draft, setPermission } = useSettingsDraft();
  if (!draft) return <div className="settings-sections"><section><p>正在加载权限设置…</p></section></div>;

  const permission = draft.permission;
  const update = (patch: Partial<DesktopPermissionSettings>): void => setPermission({ ...permission, ...patch });

  return (
    <div className="settings-sections agent-permission-settings">
      <section id="agent-permission-mode" tabIndex={-1}>
        <div className="section-heading-row">
          <div><h3>Agent 权限模式</h3><p>工具执行前的批准策略。</p></div>
          <span className="settings-scope-badge">全局</span>
        </div>
        <div aria-label="Agent 权限模式" className="agent-permission-options" role="radiogroup">
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

      <SystemPermissions />
    </div>
  );
}

function SystemPermissions(): React.JSX.Element {
  const { runtime, refresh: refreshRuntime } = useActivityRuntime();
  const [requestingPane, setRequestingPane] = useState<"screen-recording" | "accessibility">();
  const [requestError, setRequestError] = useState<string>();

  const refresh = (): void => {
    void refreshRuntime().catch(() => undefined);
  };
  const open = async (pane: "screen-recording" | "accessibility"): Promise<void> => {
    if (requestingPane !== undefined) return;
    setRequestingPane(pane);
    setRequestError(undefined);
    let failureMessage: string | undefined;
    try {
      await window.biny.requestActivityPermission(pane);
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : "无法发起系统权限申请，请稍后重试。";
    }
    try {
      await window.biny.openSystemSettings(pane);
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : "无法打开 macOS 系统设置，请手动打开“隐私与安全性”。";
    }
    if (failureMessage) setRequestError(failureMessage);
    setRequestingPane(undefined);
  };
  const permissions = [
    { detail: "隐私与安全性 → 屏幕录制", granted: runtime?.screenRecordingGranted, label: "屏幕录制", pane: "screen-recording" as const },
    { detail: "隐私与安全性 → 辅助功能", granted: runtime?.accessibilityGranted, label: "辅助功能", pane: "accessibility" as const },
  ];

  return (
    <section className="activity-card" id="system-permissions" tabIndex={-1}>
      <div className="activity-section-heading">
        <div className="activity-section-title"><Icon name="shield" size={15} /><h3>macOS 系统权限</h3></div>
        <button aria-label="刷新 macOS 系统权限状态" className="activity-icon-button" onClick={refresh} title="刷新权限状态" type="button"><Icon name="refresh" size={14} /></button>
      </div>
      <p className="activity-section-description">活动记录等功能依赖这些系统授权。</p>
      {requestError ? <p className="activity-feedback" role="alert">{requestError}</p> : null}
      <div className="activity-permission-list">
        {permissions.map((permission) => <SystemPermissionRow key={permission.pane} {...permission} onOpen={() => void open(permission.pane)} requesting={requestingPane === permission.pane} />)}
      </div>
    </section>
  );
}

function SystemPermissionRow({ detail, granted, label, onOpen, requesting }: { detail: string; granted?: boolean; label: string; onOpen(): void; requesting?: boolean }): React.JSX.Element {
  const status = granted === undefined ? "检查中" : granted ? "已授权" : "需授权";
  const stateClass = status === "已授权" ? "is-granted" : status === "需授权" ? "is-needed" : "";
  const stateIcon: IconName = status === "已授权" ? "check" : status === "需授权" ? "warning" : "shield";
  return (
    <div className="activity-permission-row">
      <div className={`activity-permission-copy ${stateClass}`}>
        <span className="activity-permission-state"><Icon name={stateIcon} size={11} /></span>
        <span className="activity-permission-text"><strong>{label}<em>{status}</em></strong><small>{detail}</small></span>
      </div>
      {granted === false ? <button aria-busy={requesting} aria-label={`申请并在 macOS 系统设置中管理${label}权限`} className="activity-secondary-button" disabled={requesting} onClick={onOpen} type="button"><Icon name="external" size={13} />{requesting ? "申请中…" : "申请并打开设置"}</button> : null}
    </div>
  );
}
