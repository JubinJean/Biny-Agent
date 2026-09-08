import { useCallback, useEffect, useState } from "react";
import type { ModelChoice } from "../../../../../llm/ModelManager.js";
import { defaultEmbeddingModelRef, embeddingModelRefKey, type LocalEmbeddingModelId } from "../../../../../llm/embedding/types.js";
import type {
  DesktopEmbeddingModelDescriptor,
  DesktopMemoryEntriesPage,
  DesktopMemoryEntry,
  DesktopMemoryEntryInput,
  DesktopMemoryEntryPatch,
  DesktopMemoryEmbeddingCancellationResult,
  DesktopMemoryEmbeddingStatus,
  DesktopMemoryOriginFilter,
  DesktopMemorySearchMatch,
  DesktopMemoryStats,
  DesktopMemorySleepPreview,
  DesktopDailyMemoryNote
} from "../../../../protocol.js";
import type { MemorySleepRun } from "../../../../../agent/context/memoryTypes.js";
import { catalogForConnection } from "../../providerCatalog.js";
import { Icon } from "../Icon.js";
import { SettingsSwitch } from "./SettingsSwitch.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";
import { SettingsModelPicker } from "./SettingsModelPicker.js";
import { modelPickerGroups, type SettingsModelPickerGroup } from "./settingsModelPickerData.js";

interface SettingsMemoryProps {
  models: ModelChoice[];
  embeddingModels: DesktopEmbeddingModelDescriptor[];
  hidden?: boolean;
  workspaceAvailable: boolean;
  sessionRunning: boolean;
  onLoadStats(filter?: DesktopMemoryOriginFilter): Promise<DesktopMemoryStats>;
  onLoadEntries(filter: DesktopMemoryOriginFilter, offset: number, limit: number, includeArchived?: boolean): Promise<DesktopMemoryEntriesPage>;
  onSearch(filter: DesktopMemoryOriginFilter, query: string, includeArchived?: boolean): Promise<DesktopMemorySearchMatch[]>;
  onAdd(input: DesktopMemoryEntryInput, expectedRevision: number): Promise<DesktopMemoryStats>;
  onUpdate(entryId: string, patch: DesktopMemoryEntryPatch, expectedRevision: number): Promise<DesktopMemoryStats>;
  onDeleteEntry(entryId: string, expectedRevision: number): Promise<DesktopMemoryStats>;
  onArchiveEntry(entryId: string, archived: boolean, expectedRevision: number): Promise<DesktopMemoryStats>;
  onLoadArchived(): Promise<DesktopMemoryEntry[]>;
  onRunSleep(): Promise<DesktopMemoryStats>;
  onSleepStatus(): Promise<DesktopMemoryStats["maintenance"]>;
  onSleepRuns(): Promise<MemorySleepRun[]>;
  onPreviewSleep(): Promise<DesktopMemorySleepPreview>;
  onCancelSleep(): Promise<{ cancelled: boolean }>;
  onLoadDailyNote(date?: string): Promise<DesktopDailyMemoryNote>;
  onLoadEmbeddingStatus(): Promise<DesktopMemoryEmbeddingStatus>;
  onDownloadEmbeddingModel(model: LocalEmbeddingModelId): Promise<DesktopMemoryEmbeddingStatus>;
  onCancelEmbeddingDownload(model: LocalEmbeddingModelId): Promise<DesktopMemoryEmbeddingCancellationResult>;
  onRebuildEmbeddingIndex(): Promise<DesktopMemoryEmbeddingStatus>;
  onCancelEmbeddingRebuild(): Promise<DesktopMemoryEmbeddingCancellationResult>;
  onNotify(message: string): void;
}

const PAGE_SIZE = 100;
type MemoryFilter = "all";

function rangeProgress(value: number, min: number, max: number): React.CSSProperties {
  const percent = max === min ? 0 : ((value - min) / (max - min)) * 100;
  return { "--range-progress": `${Math.min(100, Math.max(0, percent))}%` } as React.CSSProperties;
}

function embeddingPickerGroups(models: readonly DesktopEmbeddingModelDescriptor[]): SettingsModelPickerGroup[] {
  const groups = new Map<string, SettingsModelPickerGroup>();
  for (const model of models) {
    const local = model.source === "local";
    const providerAlias = model.ref.kind === "provider" ? model.ref.provider : "local";
    const providerType = local ? "local" : model.providerType ?? providerAlias;
    const catalog = !local && model.ref.kind === "provider"
      ? catalogForConnection({ provider: model.ref.provider, providerType }, model.endpoint)
      : undefined;
    const groupKey = `${providerType}:${providerAlias}:${model.endpoint ?? ""}`;
    const group = groups.get(groupKey) ?? {
      key: groupKey,
      label: local ? "本地模型" : catalog?.label ?? providerAlias,
      iconTone: local ? "local" : catalog?.iconTone ?? providerType,
      options: []
    };
    group.options.push({
      value: embeddingModelRefKey(model.ref),
      label: model.displayName,
      secondary: `${model.ref.model}${model.available === false ? " · 未配置" : ""}`,
      disabled: model.available === false
    });
    groups.set(groupKey, group);
  }
  return [...groups.values()];
}

export function SettingsMemory({
  models,
  embeddingModels,
  hidden,
  workspaceAvailable,
  sessionRunning,
  onLoadStats,
  onLoadEntries,
  onSearch,
  onAdd,
  onUpdate,
  onDeleteEntry,
  onArchiveEntry,
  onLoadArchived,
  onRunSleep,
  onSleepStatus,
  onSleepRuns,
  onPreviewSleep,
  onCancelSleep,
  onLoadDailyNote,
  onLoadEmbeddingStatus,
  onDownloadEmbeddingModel,
  onCancelEmbeddingDownload,
  onRebuildEmbeddingIndex,
  onCancelEmbeddingRebuild,
  onNotify
}: SettingsMemoryProps): React.JSX.Element {
  const { draft, setMemory, snapshot, dirtyCount } = useSettingsDraft();
  const filter: MemoryFilter = "all";
  const [includeArchived, setIncludeArchived] = useState(false);
  const [stats, setStats] = useState<DesktopMemoryStats>();
  const [entries, setEntries] = useState<DesktopMemoryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editor, setEditor] = useState<{ id?: string; value: string }>();
  const [error, setError] = useState<string>();
  const [sleepRuns, setSleepRuns] = useState<MemorySleepRun[]>([]);
  const [sleepPreview, setSleepPreview] = useState<DesktopMemorySleepPreview>();
  const [sleepStatus, setSleepStatus] = useState<DesktopMemoryStats["maintenance"]>();
  const [archivedEntries, setArchivedEntries] = useState<DesktopMemoryEntry[]>([]);
  const [dailyNoteDate, setDailyNoteDate] = useState("today");
  const [dailyNote, setDailyNote] = useState<DesktopDailyMemoryNote>();
  const [dailyNoteLoading, setDailyNoteLoading] = useState(false);
  const [embeddingStatus, setEmbeddingStatus] = useState<DesktopMemoryEmbeddingStatus>();
  const [embeddingWorking, setEmbeddingWorking] = useState<"download" | "rebuild">();
  const [embeddingError, setEmbeddingError] = useState<string>();

  const refreshEmbeddingStatus = useCallback(async (): Promise<void> => {
    if (!workspaceAvailable) return;
    try {
      setEmbeddingStatus(await onLoadEmbeddingStatus());
      setEmbeddingError(undefined);
    } catch (cause) {
      setEmbeddingError(errorMessage(cause));
    }
  }, [onLoadEmbeddingStatus, workspaceAvailable]);

  const reload = useCallback(async (nextFilter: MemoryFilter = filter, nextIncludeArchived = includeArchived): Promise<void> => {
    if (!workspaceAvailable) return;
    setLoading(true);
    try {
      const [nextStats, nextPage, status, runs, archived] = await Promise.all([
        onLoadStats(nextFilter),
        onLoadEntries(nextFilter, 0, PAGE_SIZE, nextIncludeArchived),
        onSleepStatus(),
        onSleepRuns(),
        onLoadArchived()
      ]);
      setStats(nextStats);
      setEntries(nextPage.entries);
      setSleepStatus(status);
      setSleepRuns(runs);
      setArchivedEntries(archived);
      setError(undefined);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [filter, includeArchived, onLoadArchived, onLoadEntries, onLoadStats, onSleepRuns, onSleepStatus, workspaceAvailable]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { void refreshEmbeddingStatus(); }, [refreshEmbeddingStatus]);
  useEffect(() => {
    if (!embeddingWorking || !workspaceAvailable) return;
    const timer = window.setInterval(() => {
      void onLoadEmbeddingStatus().then(setEmbeddingStatus).catch(() => undefined);
    }, 750);
    return () => window.clearInterval(timer);
  }, [embeddingWorking, onLoadEmbeddingStatus, workspaceAvailable]);

  const downloadEmbedding = async (model: LocalEmbeddingModelId): Promise<void> => {
    if (embeddingWorking) return;
    setEmbeddingWorking("download");
    try {
      setEmbeddingStatus(await onDownloadEmbeddingModel(model));
      setEmbeddingError(undefined);
      onNotify("Embedding 模型已下载");
    } catch (cause) {
      setEmbeddingError(errorMessage(cause));
    } finally {
      setEmbeddingWorking(undefined);
    }
  };

  const cancelEmbeddingDownload = async (model: LocalEmbeddingModelId): Promise<void> => {
    try {
      const result = await onCancelEmbeddingDownload(model);
      setEmbeddingStatus(result.status);
      onNotify(result.cancelled ? "已取消 Embedding 模型下载" : "当前没有正在进行的下载");
    } catch (cause) {
      setEmbeddingError(errorMessage(cause));
    } finally {
      setEmbeddingWorking(undefined);
    }
  };

  const rebuildEmbedding = async (): Promise<void> => {
    if (embeddingWorking || dirtyCount > 0) return;
    setEmbeddingWorking("rebuild");
    try {
      setEmbeddingStatus(await onRebuildEmbeddingIndex());
      setEmbeddingError(undefined);
      onNotify("记忆 Embedding 索引已重建");
    } catch (cause) {
      setEmbeddingError(errorMessage(cause));
    } finally {
      setEmbeddingWorking(undefined);
    }
  };

  const cancelEmbeddingRebuild = async (): Promise<void> => {
    try {
      const result = await onCancelEmbeddingRebuild();
      setEmbeddingStatus(result.status);
      onNotify(result.cancelled ? "已取消 Embedding 索引重建" : "当前没有正在进行的重建");
    } catch (cause) {
      setEmbeddingError(errorMessage(cause));
    } finally {
      setEmbeddingWorking(undefined);
    }
  };

  const search = async (): Promise<void> => {
    const value = query.trim();
    if (!value) return reload();
    setLoading(true);
    try {
      const matches = await onSearch(filter, value, includeArchived);
      setEntries(matches.map((match) => ({
        id: match.id,
        originalId: match.originalId,
        origin: match.origin,
        revision: stats?.revision ?? 0,
        topic: match.topic,
        kind: match.kind,
        importance: match.importance,
        title: match.excerpt.split("\n", 1)[0]?.slice(0, 120) || "记忆",
        summary: match.excerpt,
        decisions: [],
        paths: [],
        keywords: [],
        createdAt: match.createdAt,
        updatedAt: match.updatedAt,
        lineage: match.lineage,
        durability: match.durability,
        expiresAt: match.expiresAt,
        accessCount: match.accessCount,
        lastAccessedAt: match.lastAccessedAt,
        archivedAt: match.archivedAt,
        archivedReason: match.archivedReason,
        mergedInto: match.mergedInto,
        archivedBy: match.archivedBy
      })));
      setError(undefined);
    } catch (cause) {
      onNotify(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  const saveText = async (): Promise<void> => {
    const value = editor?.value.trim() ?? "";
    if (value.length < 20 || !stats || saving) return;
    setSaving(true);
    try {
      const editId = editor?.id;
      const next = editId
        ? await onUpdate(editId, { title: value.slice(0, 120), summary: value }, stats.revision)
        : await onAdd({
            audience: "universal",
            kind: "preference",
            topic: "memory",
            title: value.slice(0, 120),
            summary: value,
            decisions: [],
            paths: [],
            keywords: [],
            importance: 3,
            userEvidence: value
          }, stats.revision);
      setStats(next);
      setEditor(undefined);
      await reload();
      onNotify(editId ? "记忆已更新" : "记忆已添加");
    } catch (cause) {
      onNotify(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const archive = async (entry: DesktopMemoryEntry): Promise<void> => {
    if (!stats || saving) return;
    const archived = entry.archivedAt === undefined;
    setSaving(true);
    try {
      const next = await onArchiveEntry(entry.id, archived, stats.revision);
      setStats(next);
      await reload();
      onNotify(archived ? "记忆已归档" : "记忆已恢复");
    } catch (cause) {
      onNotify(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const previewSleep = async (): Promise<void> => {
    try {
      const result = await onPreviewSleep();
      if (result.available) {
        setSleepPreview(result);
        onNotify(`本次整理将检查 ${result.entries} 条记忆，${result.temporaryToArchive} 条临时记忆待归档，${result.archivedToDelete} 条归档待删除`);
      } else {
        onNotify("当前无法预览整理");
      }
    } catch (cause) {
      onNotify(errorMessage(cause));
    }
  };

  const cancelSleep = async (): Promise<void> => {
    try {
      const result = await onCancelSleep();
      onNotify(result.cancelled ? "已取消记忆整理" : "当前没有正在进行的整理");
    } catch (cause) {
      onNotify(errorMessage(cause));
    }
  };

  const runSleep = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    try {
      const next = await onRunSleep();
      setStats(next);
      await reload();
      onNotify("记忆整理已完成");
    } catch (cause) {
      onNotify(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const loadDailyNote = async (): Promise<void> => {
    if (dailyNoteLoading) return;
    setDailyNoteLoading(true);
    try {
      setDailyNote(await onLoadDailyNote(dailyNoteDate.trim() || "today"));
    } catch (cause) {
      onNotify(errorMessage(cause));
    } finally {
      setDailyNoteLoading(false);
    }
  };

  const remove = async (entry: DesktopMemoryEntry): Promise<void> => {
    if (!stats || saving) return;
    if (!window.confirm(`删除这条记忆？\n\n${entry.summary}`)) return;
    setSaving(true);
    try {
      const next = await onDeleteEntry(entry.id, stats.revision);
      setStats(next);
      await reload();
      onNotify("记忆已删除");
    } catch (cause) {
      onNotify(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  if (!workspaceAvailable) return <MemoryState title="请先选择项目" detail="打开项目后即可查看和管理记忆。" />;
  if (!draft) return <MemoryState title="正在加载记忆…" />;
  const policy = draft.memory;
  // 总开关关闭时配置区不隐藏，仅整体变暗并禁用内部控件，让用户看到可恢复的完整配置。
  const memoryDisabled = !policy.enabled;
  const selectedEmbeddingModel = policy.embeddingModel ?? defaultEmbeddingModelRef;
  const selectedEmbeddingKey = embeddingModelRefKey(selectedEmbeddingModel);
  // 主进程热重载前可能仍返回历史本地模型；renderer 也按当前协议过滤一次，避免旧进程把
  // 已移除的模型重新暴露给用户。云端 provider 模型不在这里裁剪。
  const availableEmbeddingModels = (embeddingStatus?.models.length ? embeddingStatus.models : embeddingModels)
    .filter((model) => model.source !== "local" || (model.ref.kind === "local" && model.ref.model === defaultEmbeddingModelRef.model));
  const selectedEmbeddingDescriptor = availableEmbeddingModels.find((model) => embeddingModelRefKey(model.ref) === selectedEmbeddingKey);
  const selectedLocalStatus = selectedEmbeddingModel.kind === "local"
    ? embeddingStatus?.localModels.find((model) => model.descriptor.ref.kind === "local" && model.descriptor.ref.model === selectedEmbeddingModel.model)
    : undefined;
  const selectedInstalled = selectedEmbeddingModel.kind === "provider"
    ? selectedEmbeddingDescriptor?.available === true
    : selectedLocalStatus?.installed ?? selectedEmbeddingDescriptor?.installed === true;
  const embeddingOperation = embeddingStatus?.operation;
  const downloadingSelected = embeddingWorking === "download"
    || (embeddingOperation?.kind === "download" && embeddingOperation.state === "running" && embeddingOperation.model === selectedEmbeddingModel.model);
  const rebuilding = embeddingWorking === "rebuild"
    || (embeddingOperation?.kind === "rebuild" && embeddingOperation.state === "running");
  const modelDraftChanged = snapshot?.memory.embeddingModel !== undefined
    && embeddingModelRefKey(snapshot.memory.embeddingModel) !== selectedEmbeddingKey;
  const canRebuild = !modelDraftChanged && dirtyCount === 0 && (embeddingStatus?.needsRebuild === true || (embeddingStatus?.pendingEntries ?? 0) > 0);
  const embeddingGroups = embeddingPickerGroups(availableEmbeddingModels);
  if (!availableEmbeddingModels.some((model) => embeddingModelRefKey(model.ref) === selectedEmbeddingKey)) {
    embeddingGroups.unshift({
      key: "current-embedding-model",
      label: "当前配置",
      iconTone: selectedEmbeddingModel.kind === "local" ? "local" : selectedEmbeddingModel.provider,
      options: [{
        value: selectedEmbeddingKey,
        label: selectedEmbeddingModel.kind === "local" ? "Multilingual E5 Small" : selectedEmbeddingModel.model,
        secondary: selectedEmbeddingModel.kind === "local" ? selectedEmbeddingModel.model : `${selectedEmbeddingModel.provider} · 当前配置`
      }]
    });
  }
  const selectEmbeddingModel = (model: DesktopEmbeddingModelDescriptor): void => {
    if (model.available === false) {
      onNotify("这个云端 Embedding 模型当前不可用，请先配置对应服务商凭据。");
      return;
    }
    if (model.ref.kind === "provider") {
      const endpointHash = model.privacyEndpointHash;
      if (!endpointHash) {
        onNotify("这个云端 Embedding 端点缺少隐私身份，无法启用。");
        return;
      }
      const hasConsent = Object.values(policy.cloudEmbeddingConsents).some((consent) => consent.endpointHash === endpointHash);
      if (!hasConsent && !window.confirm(`记忆内容将发送到 ${model.endpoint ?? model.ref.provider} 进行语义检索。是否继续？`)) return;
      setMemory({
        ...policy,
        embeddingModel: model.ref,
        cloudEmbeddingConsents: hasConsent
          ? policy.cloudEmbeddingConsents
          : {
              ...policy.cloudEmbeddingConsents,
              [`${model.ref.provider}@${endpointHash}`]: { endpointHash, confirmedAt: new Date().toISOString() }
            }
      });
      return;
    }
    setMemory({ ...policy, embeddingModel: model.ref });
  };

  return (
    <div className="settings-sections activity-memory-settings" hidden={hidden}>
      <section className="activity-memory-header" id="memory-overview" tabIndex={-1}>
        <div>
          <h3>记忆</h3>
          <p>AI 记忆条目和上下文</p>
        </div>
        <SettingsSwitch
          checked={policy.enabled}
          detail="关闭后暂停记忆读取和自动保存，已有记忆不会删除"
          label="启用记忆"
          onChange={(enabled) => setMemory({ ...policy, enabled })}
        />
      </section>

      <section aria-disabled={memoryDisabled} className={`activity-memory-config${memoryDisabled ? " is-disabled" : ""}`} id="memory-config" tabIndex={-1}>
          <SettingsSwitch
            checked={policy.useMemories}
            detail="在对话上下文中自动检索相关记忆"
            disabled={memoryDisabled}
            label="使用记忆"
            onChange={(useMemories) => setMemory({ ...policy, useMemories })}
          />
          <SettingsSwitch
            checked={policy.generateMemories}
            detail="从对话中自动提取重要信息并保存为新的记忆"
            disabled={memoryDisabled}
            label="自动创建记忆"
            onChange={(generateMemories) => setMemory({ ...policy, generateMemories })}
          />
          <SettingsSwitch
            checked={policy.queryRewrite}
            detail="搜索前先用工具模型改写查询。"
            disabled={memoryDisabled}
            label="查询改写"
            onChange={(queryRewrite) => setMemory({ ...policy, queryRewrite })}
          />
          <section className="activity-memory-embedding" aria-labelledby="memory-embedding-heading">
            <div className="activity-memory-embedding-heading">
              <div>
                <h4 id="memory-embedding-heading">语义记忆模型</h4>
                <p>切换模型后需保存设置并重建索引。</p>
              </div>
              <span className={selectedInstalled ? "activity-memory-status is-ready" : "activity-memory-status"}>
                {selectedInstalled ? "可用" : "未下载"}
              </span>
            </div>
            <div className="activity-memory-model">
              <span><strong>Embedding 模型</strong><small>本地模型不上传记忆内容。</small></span>
              <SettingsModelPicker
                ariaLabel="Embedding 模型"
                disabled={memoryDisabled}
                groups={embeddingGroups}
                onChange={(value) => {
                  if (!value) return;
                  const selected = availableEmbeddingModels.find((model) => embeddingModelRefKey(model.ref) === value);
                  if (selected) selectEmbeddingModel(selected);
                }}
                placeholder="选择 Embedding 模型"
                value={selectedEmbeddingKey}
              />
            </div>
            <div className="activity-memory-embedding-meta">
              <span>{selectedEmbeddingDescriptor?.dimensions ?? "?"} 维</span>
              <span>{selectedEmbeddingModel.kind === "provider" ? "云端" : "本地"}</span>
              {embeddingStatus ? <span>索引 {embeddingStatus.indexedEntries}/{embeddingStatus.totalEntries}</span> : <span>状态读取中…</span>}
            </div>
            {embeddingOperation?.kind === "download" && embeddingOperation.progress?.progress !== undefined ? (
              <div className="activity-memory-embedding-progress" role="status">
                下载进度 {Math.round(embeddingOperation.progress.progress * 100)}%
              </div>
            ) : null}
            {embeddingStatus?.degradedReason ? <small className="activity-memory-embedding-hint">{embeddingStatus.degradedReason}</small> : null}
            {embeddingError ? <small className="settings-effective-hint is-blocked">{embeddingError}</small> : null}
            <div className="activity-memory-embedding-actions">
              {selectedEmbeddingModel.kind === "local" && !selectedInstalled ? (
                downloadingSelected ? (
                  <button className="ghost-button is-danger" onClick={() => { void cancelEmbeddingDownload(selectedEmbeddingModel.model); }} type="button">取消下载</button>
                ) : (
                  <button className="ghost-button" disabled={memoryDisabled || embeddingWorking !== undefined || sessionRunning} onClick={() => { void downloadEmbedding(selectedEmbeddingModel.model); }} type="button">下载模型</button>
                )
              ) : null}
              {rebuilding ? (
                <button className="ghost-button is-danger" onClick={() => { void cancelEmbeddingRebuild(); }} type="button">取消重建</button>
              ) : (
                <button className="ghost-button" disabled={memoryDisabled || !canRebuild || embeddingWorking !== undefined || sessionRunning} onClick={() => { void rebuildEmbedding(); }} type="button">重建索引</button>
              )}
              <button aria-label="刷新 Embedding 状态" className="icon-button" disabled={memoryDisabled || embeddingWorking !== undefined} onClick={() => { void refreshEmbeddingStatus(); }} type="button"><Icon name="refresh" size={13} /></button>
            </div>
            {dirtyCount > 0 && modelDraftChanged ? <small className="activity-memory-embedding-hint">模型选择还在草稿中，请先点击设置页底部的保存。</small> : null}
          </section>
          <label className="activity-memory-limit">
            <span className="activity-memory-limit-heading"><strong>最大检索记忆数</strong><output>{policy.maxRecalled} 条</output></span>
            <small>注入当前对话上下文的相关记忆数量（1–20）</small>
            <input aria-label="最大检索记忆数" disabled={memoryDisabled} style={rangeProgress(policy.maxRecalled, 1, 20)} type="range" min={1} max={20} value={policy.maxRecalled} onChange={(event) => setMemory({ ...policy, maxRecalled: Number(event.target.value) })} />
          </label>
          <label className="activity-memory-limit">
            <span className="activity-memory-limit-heading"><strong>相似度阈值</strong><output>{Math.round(policy.similarityThreshold * 100)}%</output></span>
            <small>越高越严格。</small>
            <input aria-label="相似度阈值" disabled={memoryDisabled} style={rangeProgress(policy.similarityThreshold * 100, 0, 100)} type="range" min={0} max={100} value={Math.round(policy.similarityThreshold * 100)} onChange={(event) => setMemory({ ...policy, similarityThreshold: Number(event.target.value) / 100 })} />
          </label>
          <div className="activity-memory-model">
            <span><strong>记忆工具模型</strong><small>为空时使用通用工具模型。</small></span>
            <SettingsModelPicker
              ariaLabel="记忆工具模型"
              disabled={memoryDisabled}
              groups={modelPickerGroups(models)}
              inheritLabel="跟随通用工具模型"
              onChange={(memoryModel) => setMemory({ ...policy, memoryModel })}
              placeholder="跟随通用工具模型"
              value={policy.memoryModel}
            />
          </div>
          <label className="activity-memory-model"><span><strong>记忆睡眠</strong><small>每天在设定时间整理重复和相似的记忆。</small></span><input disabled={memoryDisabled} type="time" value={policy.sleepTime} onChange={(event) => setMemory({ ...policy, sleepTime: event.target.value })} /></label>
          <label className="activity-memory-limit"><span className="activity-memory-limit-heading"><strong>归档保留天数</strong><output>{policy.archiveRetentionDays} 天</output></span><small>归档记忆保留时间。</small><input aria-label="归档保留天数" disabled={memoryDisabled} style={rangeProgress(policy.archiveRetentionDays, 1, 3650)} type="range" min={1} max={3650} value={policy.archiveRetentionDays} onChange={(event) => setMemory({ ...policy, archiveRetentionDays: Number(event.target.value) })} /></label>
          <label className="activity-memory-limit"><span className="activity-memory-limit-heading"><strong>临时记忆 TTL</strong><output>{policy.temporaryTtl} 天</output></span><small>超过这段时间没有访问的临时记忆会进入归档。</small><input aria-label="临时记忆 TTL" disabled={memoryDisabled} style={rangeProgress(policy.temporaryTtl, 1, 3650)} type="range" min={1} max={3650} value={policy.temporaryTtl} onChange={(event) => setMemory({ ...policy, temporaryTtl: Number(event.target.value) })} /></label>
          <SettingsSwitch checked={policy.useLlm} detail="让记忆工具模型判断模糊的相似记忆是否合并。" disabled={memoryDisabled} label="使用 LLM 合并相似记忆" onChange={(useLlm) => setMemory({ ...policy, useLlm })} />
          <label className="activity-memory-limit"><span className="activity-memory-limit-heading"><strong>LLM 批量大小</strong><output>{policy.llmBatchSize} 条</output></span><small>每次整理最多发送给模型的记忆数量。</small><input aria-label="LLM 批量大小" disabled={memoryDisabled} style={rangeProgress(policy.llmBatchSize, 1, 100)} type="range" min={1} max={100} value={policy.llmBatchSize} onChange={(event) => setMemory({ ...policy, llmBatchSize: Number(event.target.value) })} /></label>
          <SettingsSwitch checked={policy.sleepEnabled} detail="机器离线时，下一次启动后会安静地补做整理。" disabled={memoryDisabled} label="启用每日记忆整理" onChange={(sleepEnabled) => setMemory({ ...policy, sleepEnabled })} />
      </section>

      <section className="activity-memory-diary" id="memory-daily-diary" tabIndex={-1}>
        <div className="activity-memory-diary-heading">
          <div>
            <h3>每日工作日志</h3>
            <p>按天查看聊天与活动摘要。</p>
          </div>
          <div className="activity-memory-diary-actions">
            <input aria-label="每日工作日志日期" onChange={(event) => setDailyNoteDate(event.target.value)} placeholder="today、yesterday 或 2026-09-04" value={dailyNoteDate} />
            <button className="ghost-button" disabled={dailyNoteLoading} onClick={() => { void loadDailyNote(); }} type="button">{dailyNoteLoading ? "读取中…" : "读取日志"}</button>
          </div>
        </div>
        {dailyNote ? (
          <div aria-live="polite" className="activity-memory-diary-output" role="region">
            <small>{dailyNote.dateKey}</small>
            <pre>{dailyNote.content ?? "这一天还没有工作日志。"}</pre>
          </div>
        ) : null}
      </section>

      <section className="activity-memory-add" id="memory-add" tabIndex={-1}>
        <h3>添加记忆</h3>
        <div className="activity-memory-add-box">
          <textarea
            aria-label="输入您希望 AI 记住的内容"
            disabled={!policy.enabled || sessionRunning || saving}
            onChange={(event) => setEditor({ value: event.target.value })}
            placeholder="输入您希望 AI 记住的内容..."
            rows={3}
            value={editor?.value ?? ""}
          />
          <div className="activity-memory-add-footer">
            <span>{editor?.id ? "正在编辑一条记忆" : "记忆会在后台整理"}</span>
            <button className="primary-button" disabled={!policy.enabled || saving || (editor?.value.trim().length ?? 0) < 20} onClick={() => { void saveText(); }} type="button">
              {saving ? "保存中…" : editor?.id ? "保存编辑" : "添加记忆"}
            </button>
          </div>
        </div>
      </section>

      <section className="activity-memory-list" id="memory-library" tabIndex={-1}>
        <div className="section-heading-row">
          <div><h3>记忆列表</h3><p>{stats ? `${stats.totalEntries} 条记忆` : ""}</p></div>
          <label className="activity-memory-archived-toggle"><input checked={includeArchived} onChange={(event) => { setIncludeArchived(event.target.checked); void reload(filter, event.target.checked); }} type="checkbox" /> 显示已归档</label>
          <button aria-label="刷新记忆" className="icon-button" disabled={loading || saving} onClick={() => { void reload(); }} type="button"><Icon name="refresh" size={14} /></button>
        </div>
        <div className="activity-memory-search">
          <Icon name="search" size={14} />
          <input aria-label="搜索记忆" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} placeholder="搜索记忆" type="search" value={query} />
          {query ? <button aria-label="清除搜索" className="icon-button" onClick={() => { setQuery(""); void reload(); }} type="button"><Icon name="close" size={13} /></button> : null}
        </div>
        {error ? <p className="settings-effective-hint is-blocked">{error}</p> : null}
        {loading ? <p className="activity-memory-empty-hint">正在读取记忆…</p> : null}
        {!loading && !entries.length ? <p className="activity-memory-empty">暂无记忆。记忆会从您的对话中自动创建，或者您可以手动添加。</p> : null}
        <div className="activity-memory-entries">
          {entries.map((entry) => (
            <article className="activity-memory-entry" key={entry.id}>
              <div className="activity-memory-entry-content">
                <div className="activity-memory-entry-meta">
                  <span className={entry.lineage.some((lineage) => lineage.source === "explicit") ? "is-manual" : "is-auto"}>
                    {entry.lineage.some((lineage) => lineage.source === "explicit") ? "手动" : "自动"}
                  </span>
                  <span>{entry.durability === "temporary" ? "临时" : "永久"}</span>
                  {entry.lineage.some((lineage) => lineage.sessionId) ? <span>来自聊天</span> : null}
                  {entry.archivedAt ? <span>已归档</span> : null}
                </div>
                <p>{entry.summary}</p>
                <small>{entry.accessCount} 次访问 · {formatDate(entry.updatedAt)}</small>
              </div>
              <div className="activity-memory-entry-actions">
                <button aria-label="编辑记忆" className="icon-button" disabled={saving || entry.archivedAt !== undefined} onClick={() => setEditor({ id: entry.id, value: entry.summary })} type="button"><Icon name="edit" size={13} /></button>
                <button aria-label={entry.archivedAt ? "恢复记忆" : "归档记忆"} className="icon-button" disabled={saving} onClick={() => { void archive(entry); }} type="button"><Icon name={entry.archivedAt ? "refresh" : "archive"} size={13} /></button>
                <button aria-label="删除记忆" className="icon-button" disabled={saving} onClick={() => { void remove(entry); }} type="button"><Icon name="trash" size={13} /></button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="activity-memory-archive" id="memory-archive" tabIndex={-1}>
        <h3>已归档的记忆（{archivedEntries.length}）</h3>
        {archivedEntries.length === 0 ? <p>没有已归档的记忆。</p> : archivedEntries.slice(0, 20).map((entry) => (
          <article className="activity-memory-entry" key={entry.id}>
            <div className="activity-memory-entry-content"><p>{entry.summary}</p><small>{entry.archivedReason ?? "手动归档"} · {entry.archivedAt ? formatDate(entry.archivedAt) : ""}</small></div>
            <button aria-label="恢复记忆" className="ghost-button" disabled={saving} onClick={() => { void archive(entry); }} type="button">恢复</button>
          </article>
        ))}
      </section>

      <section className="activity-memory-sleep" id="memory-sleep" tabIndex={-1}>
        <div>
          <h3>记忆睡眠</h3>
          <p>每天整理重复、过期和相似的记忆；删除的条目可以从归档中恢复。</p>
          {stats?.maintenance.lastRun ? (
            <small className="activity-memory-sleep-detail">
              上次整理：{stats.maintenance.lastRun.examined} 条检查 · {stats.maintenance.lastRun.exact} 条完全重复 · {stats.maintenance.lastRun.expired} 条期限 · {stats.maintenance.lastRun.similarity} 条近似 · {stats.maintenance.lastRun.llm} 条 LLM 合并 · {stats.maintenance.lastRun.failed} 条失败
            </small>
          ) : null}
          {sleepPreview ? <small className="activity-memory-sleep-preview">预览：{sleepPreview.entries} 条记忆，{sleepPreview.temporaryToArchive} 条临时记忆待归档，{sleepPreview.archivedToDelete} 条归档待删除。</small> : null}
          {sleepRuns.length > 0 ? (
            <small className="activity-memory-sleep-history">最近周期：{sleepRuns.slice(-3).reverse().map((run) => `${run.examined} 检查 · ${run.exact} 完全重复 · ${run.expired} 期限 · ${run.similarity} 近似 · ${run.llm} LLM`).join("；")}</small>
          ) : null}
          {sleepStatus?.state === "running" ? <small className="activity-memory-sleep-history">整理正在运行…</small> : null}
        </div>
        <div className="activity-memory-sleep-actions">
          <small>{stats?.maintenance.lastRun?.finishedAt ? `上次整理：${formatDate(stats.maintenance.lastRun.finishedAt)}` : "后台自动运行"}</small>
          <div className="activity-memory-sleep-buttons">
            <button className="ghost-button" disabled={saving || sessionRunning} onClick={() => { void previewSleep(); }} type="button">预览</button>
            <button className="ghost-button" disabled={saving || sessionRunning} onClick={() => { void runSleep(); }} type="button">{saving ? "整理中…" : "立即运行"}</button>
            {saving ? <button className="ghost-button is-danger" onClick={() => { void cancelSleep(); }} type="button">取消</button> : null}
          </div>
        </div>
      </section>
    </div>
  );
}

function MemoryState({ title, detail }: { title: string; detail?: string }): React.JSX.Element {
  return <div className="settings-sections"><section><h3>{title}</h3>{detail ? <p>{detail}</p> : null}</section></div>;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
