/** 后台文本任务的统一模型入口，复用模型设置事务与已有模型选择器。 */
import { useState } from "react";
import { useSettingsDraft } from "./SettingsDraftContext.js";
import { SettingsModelPicker } from "./SettingsModelPicker.js";
import { modelPickerGroups } from "./settingsModelPickerData.js";
import type { DesktopModelConfigurationInput, DesktopModelConnectionTestResult } from "../../../../protocol.js";

export function SettingsToolModel({ onTest }: { onTest(configuration: DesktopModelConfigurationInput): Promise<DesktopModelConnectionTestResult> }): React.JSX.Element | null {
  const { draft, snapshot, saveModels, saveState } = useSettingsDraft();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<DesktopModelConnectionTestResult>();
  if (!draft || !snapshot) return null;
  const active = snapshot.models.configured.find((model) => model.alias === snapshot.models.resolvedToolModel);
  const selectModel = (alias: string | undefined): void => {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    setTestResult(undefined);
    void saveModels({ ...draft.models, toolModel: { alias } }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "工具模型保存失败，请重试。");
    }).finally(() => setSaving(false));
  };
  return (
    <div className="settings-sections">
      <section id="tool-model" tabIndex={-1}>
        <div className="setting-row">
          <span><strong>工具模型</strong><small>用于工具与技能筛选、会话标题、记忆、结晶和活动分析等辅助任务。</small></span>
          <SettingsModelPicker
            ariaLabel="工具模型"
            disabled={saving || testing || snapshot.hasRunningTasks || saveState === "saving"}
            groups={modelPickerGroups(snapshot.models.configured)}
            inheritLabel="自动选择"
            onChange={selectModel}
            placeholder="自动选择"
            value={snapshot.models.toolModel}
          />
        </div>
        <p>{active ? `当前使用：${active.displayName}` : "暂无可用工具模型，请先配置模型供应商。"} 自动模式优先选择价格较低的已配置模型。</p>
        <button className="text-button" disabled={!active || testing || saving} type="button" onClick={() => {
          if (!active || testing) return;
          setTesting(true);
          setTestResult(undefined);
          void onTest({ alias: active.alias, displayName: active.displayName, providerAlias: active.provider,
            providerType: active.providerType as DesktopModelConfigurationInput["providerType"], model: active.model,
            baseUrl: active.baseUrl, supportsTools: active.supportsTools === true, supportsThinking: active.efforts.length > 0
          }).then(setTestResult).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "测试失败"))
            .finally(() => setTesting(false));
        }}>{testing ? "测试中…" : "测试模型"}</button>
        {testResult ? <p role="status">{testResult.ok ? "测试通过" : testResult.message}{testResult.latencyMs === undefined ? "" : ` · ${(testResult.latencyMs / 1000).toFixed(1)} 秒`}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
      </section>
    </div>
  );
}
