/**
 * 模型服务商设置：主从式两栏布局。
 *
 * 左栏是服务商清单（搜索 + 状态圆点，可用连接排最前），右栏是所选服务商的配置面板。
 * 面板是两态设计：未连接只给「启用」出口，连接后原地展开完整表单——把「连接服务商」
 * 从一次性对话框改成常驻面板，用户随时回来改密钥、增删模型、测试连通。
 *
 * 人体工学上对齐零保存按钮的产品惯例：所有变更即时提交（saveModels 只提交 models 段，
 * 与其它分页的草稿互不影响）；运行中的会话会让主进程拒绝事务，此时变更留在草稿里，
 * 等会话结束由页脚保存兜底。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelProfile } from "../../../../../config/schema.js";
import type { ModelChoice, ThinkingSelection } from "../../../../../llm/ModelManager.js";
import type {
  DesktopModelCatalogResult,
  DesktopModelConfigurationInput,
  DesktopModelConnection,
  DesktopModelConnectionTestResult,
  DesktopModelLoginProvider,
  DesktopModelLoginStartResult,
  DesktopSettingsModelsInput,
  DesktopStagedModelLoginResult
} from "../../../../protocol.js";
import {
  apiFormatForConnection,
  apiFormatOption,
  apiFormatOptions,
  catalogForConnection,
  customCatalogEntry,
  modelAliasFor,
  providerAliasFor,
  providerCatalog,
  type ApiFormatId,
  type CatalogModel,
  type ProviderCatalogItem
} from "../../providerCatalog.js";
import { Icon } from "../Icon.js";
import { ProviderBrandGlyph } from "../ProviderBrandGlyph.js";
import { connectionLabel } from "./providerModelProjection.js";
import { useSettingsDraft, type SettingsModelDraft } from "./SettingsDraftContext.js";

interface ConnectionGroup {
  provider: string;
  providerType: string;
  models: ModelChoice[];
  defaultModel?: ModelChoice;
}

/** 左栏一行：目录条目或一个未匹配目录的自定义端点。 */
interface ProviderListEntry {
  key: string;
  catalog?: ProviderCatalogItem;
  label: string;
  description: string;
  badge?: string;
  iconTone: string;
  group?: ConnectionGroup;
  connection?: DesktopModelConnection;
}

interface LiveCatalogState {
  models: CatalogModel[];
  source: DesktopModelCatalogResult["source"];
}

export interface ProviderSettingsProps {
  active: boolean;
  /** 设置快照尚未返回时为 true：列表显示骨架行而不是闪一下空状态。 */
  loading: boolean;
  models: ModelChoice[];
  connections: DesktopModelConnection[];
  defaultModelAlias?: string;
  projectId?: string;
  onDefaultModel(alias: string, thinking: ThinkingSelection): void;
  onTest(configuration: DesktopModelConfigurationInput): Promise<DesktopModelConnectionTestResult>;
  onFetchCatalog(providerAlias: string, force?: boolean): Promise<DesktopModelCatalogResult>;
  onFetchCatalogCandidate(configuration: DesktopModelConfigurationInput): Promise<DesktopModelCatalogResult>;
  onStartLogin(provider: DesktopModelLoginProvider): Promise<DesktopModelLoginStartResult>;
  onCompleteLogin(provider: DesktopModelLoginProvider, authRequestId: string, pastedAuthorization?: string): Promise<DesktopStagedModelLoginResult>;
  onCancelLogin(provider: DesktopModelLoginProvider, authRequestId: string): Promise<void>;
  onNotify(message: string): void;
  onOpenExternal(url: string): Promise<void>;
}

export function ProviderSettings({
  active,
  loading,
  models,
  connections: connectionInfos,
  defaultModelAlias,
  projectId,
  onDefaultModel,
  onTest,
  onFetchCatalog,
  onFetchCatalogCandidate,
  onStartLogin,
  onCompleteLogin,
  onCancelLogin,
  onNotify,
  onOpenExternal
}: ProviderSettingsProps): React.JSX.Element {
  const settingsDraft = useSettingsDraft();
  const infoFor = useCallback((providerAlias: string): DesktopModelConnection | undefined =>
    connectionInfos.find((item) => item.providerAlias === providerAlias), [connectionInfos]);

  // ── 列表行：目录条目 + 未匹配的自定义端点，可用连接置顶 ──
  const groups = useMemo(() => connectionLabel(models), [models]);
  const entries = useMemo<ProviderListEntry[]>(() => {
    const groupByCatalogId = new Map<string, ConnectionGroup>();
    const leftover: ConnectionGroup[] = [];
    for (const group of groups) {
      const catalog = catalogForConnection(group, infoFor(group.provider)?.baseUrl);
      if (catalog) groupByCatalogId.set(catalog.id, group);
      else leftover.push(group);
    }
    const rows: ProviderListEntry[] = providerCatalog.map((catalog) => {
      const group = groupByCatalogId.get(catalog.id);
      return {
        key: catalog.id,
        catalog,
        label: catalog.label,
        description: catalog.description,
        badge: catalog.badge,
        iconTone: catalog.iconTone,
        group,
        connection: group ? infoFor(group.provider) : undefined
      };
    });
    for (const group of leftover) {
      const info = infoFor(group.provider);
      const neutral = customCatalogEntry(group, info?.baseUrl);
      rows.push({
        key: `custom:${group.provider}`,
        catalog: neutral,
        label: neutral.label,
        description: neutral.description,
        badge: neutral.badge,
        iconTone: neutral.iconTone,
        group,
        connection: info
      });
    }
    // 健康连接 < 有问题的连接 < 未连接；同档内保持目录顺序，自定义行按名称排在最后。
    const health = (row: ProviderListEntry): number => row.group ? (connectionStatus(row.connection) ? 1 : 0) : 2;
    return rows
      .map((row, index) => ({ row, index, custom: row.key.startsWith("custom:") }))
      .sort((left, right) =>
        health(left.row) - health(right.row)
        || Number(left.custom) - Number(right.custom)
        || left.index - right.index
        || left.row.label.localeCompare(right.row.label))
      .map((item) => item.row);
  }, [groups, infoFor]);

  const [activeKey, setActiveKey] = useState<string>();
  const activeEntry = entries.find((row) => row.key === activeKey) ?? entries[0];
  // 已有选中从列表里消失（例如删除自定义端点后）时回退到第一行。
  useEffect(() => {
    if (activeKey !== undefined && !entries.some((row) => row.key === activeKey)) setActiveKey(undefined);
  }, [activeKey, entries]);

  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredEntries = normalizedQuery
    ? entries.filter((row) => `${row.label} ${row.description}`.toLocaleLowerCase().includes(normalizedQuery))
    : entries;

  // ── 即时提交：models 段整体计算（草稿待提交项 + 本次变更），交给 provider 串行落盘 ──
  const [saving, setSaving] = useState(false);
  const commitModels = useCallback(async (next: SettingsModelDraft): Promise<boolean> => {
    const input: DesktopSettingsModelsInput = {
      upserts: next.upserts,
      removeAliases: next.removeAliases,
      defaultModel: next.defaultModel,
      oauthCredentialHandles: next.oauthCredentialHandles,
      modelProfiles: next.modelProfiles
    };
    try {
      const result = await settingsDraft.saveModels(input);
      return result?.status === "committed";
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [onNotify, settingsDraft]);

  /** 单个模型的 upsert：先暂存明文密钥（拿句柄）、乐观写入草稿，再即时提交 models 段。 */
  const applyUpsert = useCallback(async (input: DesktopModelConfigurationInput): Promise<boolean> => {
    const draft = settingsDraft.draft;
    if (!draft) return false;
    if (input.apiKey && !projectId) {
      onNotify("暂存模型密钥前必须先选择项目。");
      return false;
    }
    setSaving(true);
    try {
      const previous = draft.models.upserts.find((item) => item.alias === input.alias)?.apiKeyHandle;
      if (previous) await settingsDraft.releaseCredential(previous);
      let stagedHandle: string | undefined;
      if (input.apiKey) {
        const staged = await settingsDraft.stageCredential(input.apiKey, {
          projectId: projectId!,
          purpose: "model",
          providerAlias: input.providerAlias
        });
        stagedHandle = staged.handle;
      }
      const finalInput: DesktopModelConfigurationInput = { ...input, apiKey: undefined, apiKeyHandle: stagedHandle ?? input.apiKeyHandle };
      // 乐观写入草稿：提交成功后 models 草稿会被清零；失败（如会话运行中）时变更留在
      // 草稿里，由页脚保存兜底，UI 不会出现「开关弹回」的假失败。
      settingsDraft.upsertModel(finalInput);
      const upserts = [...draft.models.upserts.filter((item) => item.alias !== finalInput.alias), finalInput];
      return await commitModels({
        ...draft.models,
        upserts,
        removeAliases: draft.models.removeAliases.filter((alias) => alias !== finalInput.alias),
        defaultModel: finalInput.makeDefault
          ? { alias: finalInput.alias, thinking: "off" as const }
          : draft.models.defaultModel
      });
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSaving(false);
    }
  }, [commitModels, onNotify, projectId, settingsDraft]);

  /** 停用一个模型（删除 alias；组内模型逐个删除时最后形成删除连接）。 */
  const applyRemove = useCallback(async (alias: string): Promise<boolean> => {
    const draft = settingsDraft.draft;
    if (!draft) return false;
    setSaving(true);
    try {
      const previous = draft.models.upserts.find((item) => item.alias === alias)?.apiKeyHandle;
      if (previous) await settingsDraft.releaseCredential(previous);
      settingsDraft.removeModel(alias);
      return await commitModels({
        ...draft.models,
        upserts: draft.models.upserts.filter((item) => item.alias !== alias),
        removeAliases: draft.models.removeAliases.includes(alias)
          ? draft.models.removeAliases
          : [...draft.models.removeAliases, alias],
        defaultModel: draft.models.defaultModel?.alias === alias ? undefined : draft.models.defaultModel
      });
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSaving(false);
    }
  }, [commitModels, onNotify, settingsDraft]);

  // ── 实时目录缓存（按 providerAlias），获取按钮与连接后的静默刷新共用 ──
  const [liveCatalog, setLiveCatalog] = useState<Record<string, LiveCatalogState>>({});
  const [fetchingAlias, setFetchingAlias] = useState<string>();
  const catalogGenerationRef = useRef(new Map<string, number>());
  const refreshCatalog = useCallback(async (providerAlias: string, options: { force?: boolean; announce?: boolean } = {}): Promise<void> => {
    const generation = (catalogGenerationRef.current.get(providerAlias) ?? 0) + 1;
    catalogGenerationRef.current.set(providerAlias, generation);
    setFetchingAlias(providerAlias);
    try {
      const result = await onFetchCatalog(providerAlias, options.force ?? false);
      if (catalogGenerationRef.current.get(providerAlias) !== generation) return;
      setLiveCatalog((current) => ({
        ...current,
        [providerAlias]: { models: result.models.map(catalogModelFromEntry), source: result.source }
      }));
      if (options.announce) onNotify(`模型目录已更新 · ${String(result.models.length)} 个模型`);
    } catch (error) {
      if (options.announce && catalogGenerationRef.current.get(providerAlias) === generation) {
        onNotify(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (catalogGenerationRef.current.get(providerAlias) === generation) setFetchingAlias(undefined);
    }
  }, [onFetchCatalog, onNotify]);

  // ── 当前面板的派生数据 ──
  const group = activeEntry?.group;
  const providerAlias = group?.provider ?? (activeEntry?.catalog ? providerAliasFor(activeEntry.catalog, activeEntry.catalog.baseUrl) : undefined);
  const connection = activeEntry?.connection ?? (providerAlias ? infoFor(providerAlias) : undefined);
  const catalog = activeEntry?.catalog;
  const availableModels = useMemo(() => {
    if (!group || !catalog) return [];
    return mergeAvailableModels(catalog.models, group.models, liveCatalog[group.provider]?.models ?? []);
  }, [catalog, group, liveCatalog]);
  const lastRefreshedRef = useRef<string | undefined>(undefined);
  const cancelLoginRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    // 打开面板时静默拉一次最新目录；失败保留现有模型，错误在手动刷新时展示。
    if (!group || !catalog || catalog.connectionMode === "login") return;
    if (lastRefreshedRef.current === group.provider) return;
    lastRefreshedRef.current = group.provider;
    void refreshCatalog(group.provider, { force: true });
  }, [catalog, group, refreshCatalog]);
  useEffect(() => {
    // 设置面板整体关闭时放弃未完成的登录请求。
    if (active) return;
    cancelLoginRef.current();
  }, [active]);

  // ── 测试连接 ──
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<DesktopModelConnectionTestResult>();
  const [testMenuOpen, setTestMenuOpen] = useState(false);
  const testTargetAlias = useRef<string | undefined>(undefined);
  const testConfiguration = useCallback((model: ModelChoice): DesktopModelConfigurationInput | undefined => {
    if (!group || !catalog) return undefined;
    return {
      alias: model.alias,
      displayName: model.displayName,
      providerAlias: group.provider,
      providerType: catalog.value,
      protocol: connection?.protocol ?? catalog.protocol,
      model: model.model,
      baseUrl: (connection?.baseUrl ?? catalog.baseUrl) || undefined,
      apiKeyEnv: undefined,
      supportsTools: model.supportsTools !== false,
      supportsThinking: model.efforts.length > 0,
      parallelToolCalls: model.capabilities?.parallelToolCalls,
      reasoningStream: model.capabilities?.reasoningStream,
      reasoningSummary: model.capabilities?.reasoningSummary,
      supportsVision: model.capabilities?.vision,
      supportsAudio: model.capabilities?.audio,
      contextWindow: model.contextWindow,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      limits: model.limits,
      thinkingLevelMap: model.thinkingLevelMap,
      apiBackend: model.apiBackend
    };
  }, [catalog, connection, group]);
  const runTest = useCallback(async (model: ModelChoice): Promise<void> => {
    const configuration = testConfiguration(model);
    setTestMenuOpen(false);
    if (!configuration) return;
    testTargetAlias.current = group?.provider;
    setTesting(true);
    setTestResult(undefined);
    try {
      const result = await onTest(configuration);
      if (testTargetAlias.current === group?.provider) setTestResult(result);
    } finally {
      if (testTargetAlias.current === group?.provider) setTesting(false);
    }
  }, [group?.provider, onTest, testConfiguration]);

  // ── 密钥 / 服务地址：即输即存（防抖 + 失焦立即提交），换服务商时作废未提交的编辑 ──
  const [keyDraft, setKeyDraft] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [baseUrlDraft, setBaseUrlDraft] = useState("");
  const [deleteArmed, setDeleteArmed] = useState(false);
  const keyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activeProviderRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    activeProviderRef.current = providerAlias;
  }, [providerAlias]);
  useEffect(() => {
    // 切换面板时清掉未提交的密钥输入与挂起的防抖，密钥编辑绝不跨服务商残留。
    setKeyDraft("");
    setShowKey(false);
    setTestResult(undefined);
    setTestMenuOpen(false);
    setDeleteArmed(false);
    if (keyTimerRef.current) clearTimeout(keyTimerRef.current);
    return () => {
      if (keyTimerRef.current) clearTimeout(keyTimerRef.current);
    };
  }, [providerAlias]);

  const activeModel = group
    ? group.models.find((model) => model.alias === defaultModelAlias) ?? group.defaultModel ?? group.models[0]
    : undefined;

  const commitKey = useCallback(async (value: string): Promise<void> => {
    if (!group || !catalog || !value.trim() || !activeModel) return;
    const result = await applyUpsert({
      alias: activeModel.alias,
      displayName: activeModel.displayName,
      providerAlias: group.provider,
      providerType: catalog.value,
      protocol: connection?.protocol ?? catalog.protocol,
      model: activeModel.model,
      baseUrl: (connection?.baseUrl ?? catalog.baseUrl) || undefined,
      apiKey: value.trim(),
      apiKeyEnv: undefined,
      requiresApiKey: catalog.requiresApiKey,
      modelsRequiresApiKey: catalog.modelsRequiresApiKey,
      supportsTools: activeModel.supportsTools !== false,
      supportsThinking: activeModel.efforts.length > 0,
      parallelToolCalls: activeModel.capabilities?.parallelToolCalls,
      reasoningStream: activeModel.capabilities?.reasoningStream,
      reasoningSummary: activeModel.capabilities?.reasoningSummary,
      supportsVision: activeModel.capabilities?.vision,
      supportsAudio: activeModel.capabilities?.audio,
      contextWindow: activeModel.contextWindow,
      maxInputTokens: activeModel.maxInputTokens,
      maxOutputTokens: activeModel.maxOutputTokens,
      limits: activeModel.limits,
      thinkingLevelMap: activeModel.thinkingLevelMap,
      apiBackend: activeModel.apiBackend
    });
    if (activeProviderRef.current !== group.provider) return;
    if (result) {
      setKeyDraft("");
      // 新密钥通常立刻解锁真实模型列表。
      void refreshCatalog(group.provider, { force: true });
    } else {
      onNotify("密钥未能保存，请稍后重试");
    }
  }, [activeModel, applyUpsert, catalog, connection, group, onNotify, refreshCatalog]);

  const onKeyDraftChange = (value: string): void => {
    setKeyDraft(value);
    setTestResult(undefined);
    if (keyTimerRef.current) clearTimeout(keyTimerRef.current);
    if (!value.trim()) return;
    keyTimerRef.current = setTimeout(() => { void commitKey(value); }, 900);
  };
  const flushKeyDraft = (): void => {
    if (keyTimerRef.current) clearTimeout(keyTimerRef.current);
    if (keyDraft.trim()) void commitKey(keyDraft);
  };

  const savedBaseUrl = connection?.baseUrl ?? catalog?.baseUrl ?? "";
  useEffect(() => {
    // 回填这条连接实际保存的地址，而不是目录默认值——那等于悄悄覆盖用户的自定义地址。
    setBaseUrlDraft(savedBaseUrl);
  }, [savedBaseUrl]);

  const baseUrlNeedsSave = baseUrlDraft.trim() !== savedBaseUrl && baseUrlDraft.trim().length > 0;
  const commitBaseUrl = useCallback(async (): Promise<void> => {
    if (!group || !catalog || !activeModel || !baseUrlNeedsSave) return;
    const result = await applyUpsert({
      alias: activeModel.alias,
      displayName: activeModel.displayName,
      providerAlias: group.provider,
      providerType: catalog.value,
      protocol: connection?.protocol ?? catalog.protocol,
      model: activeModel.model,
      baseUrl: baseUrlDraft.trim(),
      apiKeyEnv: undefined,
      supportsTools: activeModel.supportsTools !== false,
      supportsThinking: activeModel.efforts.length > 0,
      parallelToolCalls: activeModel.capabilities?.parallelToolCalls,
      reasoningStream: activeModel.capabilities?.reasoningStream,
      reasoningSummary: activeModel.capabilities?.reasoningSummary,
      supportsVision: activeModel.capabilities?.vision,
      supportsAudio: activeModel.capabilities?.audio,
      contextWindow: activeModel.contextWindow,
      maxInputTokens: activeModel.maxInputTokens,
      maxOutputTokens: activeModel.maxOutputTokens,
      limits: activeModel.limits,
      thinkingLevelMap: activeModel.thinkingLevelMap,
      apiBackend: activeModel.apiBackend
    });
    if (result) onNotify("服务地址已保存");
  }, [activeModel, applyUpsert, baseUrlDraft, baseUrlNeedsSave, catalog, connection, group, onNotify]);

  // ── 模型开关 ──
  const toggleModel = useCallback(async (catalogModel: CatalogModel, enabled: boolean): Promise<void> => {
    if (!group || !catalog) return;
    if (enabled) {
      await applyUpsert({
        alias: modelAliasFor(group.provider, catalogModel.id),
        displayName: catalogModel.displayName,
        providerAlias: group.provider,
        providerType: catalog.value,
        protocol: connection?.protocol ?? catalog.protocol,
        model: catalogModel.id,
        baseUrl: (connection?.baseUrl ?? catalog.baseUrl) || undefined,
        apiKeyEnv: undefined,
        requiresApiKey: catalog.requiresApiKey,
        modelsRequiresApiKey: catalog.modelsRequiresApiKey,
        supportsTools: true,
        supportsThinking: catalogModel.supportsThinking,
        parallelToolCalls: catalogModel.parallelToolCalls,
        reasoningStream: catalogModel.reasoningStream,
        reasoningSummary: catalogModel.reasoningSummary,
        supportsVision: catalogModel.supportsVision,
        supportsAudio: catalogModel.supportsAudio,
        contextWindow: catalogModel.contextWindow,
        maxInputTokens: catalogModel.maxInputTokens,
        maxOutputTokens: catalogModel.maxOutputTokens,
        limits: catalogModel.limits,
        thinkingLevelMap: catalogModel.thinkingLevelMap,
        apiBackend: catalogModel.apiBackend
      });
    } else {
      const alias = group.models.find((model) => model.model === catalogModel.id)?.alias
        ?? modelAliasFor(group.provider, catalogModel.id);
      await applyRemove(alias);
    }
  }, [applyRemove, applyUpsert, catalog, connection, group]);

  // ── 手动添加模型（目录滞后时的逃生通道） ──
  const [manualModelId, setManualModelId] = useState("");
  const submitManualModel = useCallback(async (): Promise<void> => {
    const id = manualModelId.trim();
    if (!id || !group || !catalog) return;
    if (group.models.some((model) => model.model === id)) {
      onNotify("该模型已在启用列表中");
      return;
    }
    setManualModelId("");
    await applyUpsert({
      alias: modelAliasFor(group.provider, id),
      displayName: id,
      providerAlias: group.provider,
      providerType: catalog.value,
      protocol: connection?.protocol ?? catalog.protocol,
      model: id,
      baseUrl: (connection?.baseUrl ?? catalog.baseUrl) || undefined,
      apiKeyEnv: undefined,
      requiresApiKey: catalog.requiresApiKey,
      modelsRequiresApiKey: catalog.modelsRequiresApiKey,
      supportsTools: true
    });
    onNotify(`已添加 ${id}`);
  }, [applyUpsert, catalog, connection, group, manualModelId, onNotify]);

  // ── 模型元数据覆盖（齿轮对话框） ──
  const [profileTarget, setProfileTarget] = useState<{ providerAlias: string; model: ModelChoice }>();
  const applyProfile = useCallback(async (providerAlias: string, modelId: string, profile: ModelProfile | undefined): Promise<void> => {
    const draft = settingsDraft.draft;
    if (!draft) return;
    const providerProfiles = { ...(draft.models.modelProfiles[providerAlias] ?? {}) };
    if (profile === undefined) delete providerProfiles[modelId];
    else providerProfiles[modelId] = profile;
    // 空对象是「清空该连接全部 profile」的显式值；删掉 provider 键会让后端按未列出处理。
    const modelProfiles = { ...draft.models.modelProfiles, [providerAlias]: providerProfiles };
    // 乐观写入草稿，失败时由页脚保存兜底。
    settingsDraft.setModelProfile(providerAlias, modelId, profile);
    setSaving(true);
    try {
      await commitModels({ ...draft.models, modelProfiles });
    } finally {
      setSaving(false);
    }
  }, [commitModels, settingsDraft]);

  // ── 删除连接（两步确认，避免引入一整层确认对话框） ──
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current); }, []);
  const deleteConnection = useCallback(async (): Promise<void> => {
    if (!group) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      deleteTimerRef.current = setTimeout(() => setDeleteArmed(false), 4_000);
      return;
    }
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    if (models.length <= group.models.length) {
      onNotify("至少需要保留一个模型连接");
      return;
    }
    setDeleteArmed(false);
    for (const model of group.models) await applyRemove(model.alias);
  }, [applyRemove, deleteArmed, group, models.length, onNotify]);

  // ── 启用服务商（未连接的 API 条目）：用种子模型建连接，密钥随后在表单里补 ──
  const enableProvider = useCallback(async (entryCatalog: ProviderCatalogItem): Promise<void> => {
    const seed = entryCatalog.models[0];
    if (!seed) return;
    const alias = providerAliasFor(entryCatalog, entryCatalog.baseUrl);
    const result = await applyUpsert({
      alias: modelAliasFor(alias, seed.id),
      displayName: seed.displayName,
      providerAlias: alias,
      providerType: entryCatalog.value,
      protocol: entryCatalog.protocol,
      model: seed.id,
      baseUrl: entryCatalog.baseUrl || undefined,
      apiKeyEnv: undefined,
      requiresApiKey: entryCatalog.requiresApiKey,
      modelsRequiresApiKey: entryCatalog.modelsRequiresApiKey,
      supportsTools: true,
      supportsThinking: seed.supportsThinking,
      parallelToolCalls: seed.parallelToolCalls,
      reasoningStream: seed.reasoningStream,
      reasoningSummary: seed.reasoningSummary,
      supportsVision: seed.supportsVision,
      supportsAudio: seed.supportsAudio,
      contextWindow: seed.contextWindow,
      maxInputTokens: seed.maxInputTokens,
      maxOutputTokens: seed.maxOutputTokens,
      limits: seed.limits,
      thinkingLevelMap: seed.thinkingLevelMap,
      apiBackend: seed.apiBackend,
      // 只有当前没有默认模型时才接管默认；已有默认时静默不动，避免打断进行中的会话。
      makeDefault: !defaultModelAlias
    });
    if (result) void refreshCatalog(alias, { force: true });
  }, [applyUpsert, defaultModelAlias, refreshCatalog]);

  // ── 自定义端点（未连接的 openai-compatible 条目）：地址 + 格式 + 密钥 → 拉模型 → 勾选 ──
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customApiKey, setCustomApiKey] = useState("");
  const [customShowKey, setCustomShowKey] = useState(false);
  const [customFormat, setCustomFormat] = useState<ApiFormatId>("chat_completions");
  const [customModels, setCustomModels] = useState<CatalogModel[]>([]);
  const [customSelected, setCustomSelected] = useState<string[]>([]);
  const [customFetching, setCustomFetching] = useState(false);
  const customGenerationRef = useRef(0);
  useEffect(() => {
    setCustomBaseUrl("");
    setCustomApiKey("");
    setCustomShowKey(false);
    setCustomFormat("chat_completions");
    setCustomModels([]);
    setCustomSelected([]);
  }, [activeKey]);

  const loadCustomModels = useCallback(async (announce: boolean): Promise<void> => {
    if (!catalog) return;
    const baseUrl = customBaseUrl.trim();
    if (!baseUrl) {
      if (announce) onNotify("请先填写服务地址再加载模型");
      return;
    }
    const generation = ++customGenerationRef.current;
    setCustomFetching(true);
    try {
      const providerAlias = providerAliasFor(catalog, baseUrl);
      const seed = catalog.models[0];
      const format = apiFormatOption(customFormat);
      const result = await onFetchCatalogCandidate({
        alias: modelAliasFor(providerAlias, seed?.id ?? "probe"),
        displayName: seed?.displayName ?? seed?.id ?? "probe",
        providerAlias,
        providerType: catalog.value,
        protocol: format.protocol,
        model: seed?.id ?? "probe",
        baseUrl,
        apiKey: customApiKey.trim() || undefined,
        requiresApiKey: catalog.requiresApiKey,
        modelsRequiresApiKey: catalog.modelsRequiresApiKey,
        supportsTools: true,
        supportsThinking: seed?.supportsThinking,
        apiBackend: format.apiBackend
      });
      if (generation !== customGenerationRef.current) return;
      const loaded = result.models.map(catalogModelFromEntry);
      setCustomModels(loaded);
      // 实时目录失败后不代替用户勾选，避免把账号未开放的模型自动存为默认。
      setCustomSelected(loaded[0] ? [loaded[0].id] : []);
      if (announce) onNotify(`已获取 ${String(loaded.length)} 个模型`);
    } catch (error) {
      if (generation !== customGenerationRef.current) return;
      setCustomModels(catalog.models);
      setCustomSelected([]);
      if (announce) onNotify(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === customGenerationRef.current) setCustomFetching(false);
    }
  }, [catalog, customApiKey, customBaseUrl, customFormat, onFetchCatalogCandidate, onNotify]);

  /** 换格式后旧目录不可信（不同协议的 /models 形状不同），清空候选。 */
  const changeCustomFormat = (id: ApiFormatId): void => {
    setCustomFormat(id);
    setCustomModels([]);
    setCustomSelected([]);
  };

  const connectCustom = useCallback(async (): Promise<void> => {
    if (!catalog) return;
    const baseUrl = customBaseUrl.trim();
    const candidates = customModels.filter((model) => customSelected.includes(model.id));
    if (!baseUrl || !candidates.length) return;
    const providerAlias = providerAliasFor(catalog, baseUrl);
    const format = apiFormatOption(customFormat);
    let makeDefault = !defaultModelAlias;
    let succeeded = false;
    for (const model of candidates) {
      const done = await applyUpsert({
        alias: modelAliasFor(providerAlias, model.id),
        displayName: model.displayName,
        providerAlias,
        providerType: catalog.value,
        protocol: format.protocol,
        model: model.id,
        baseUrl,
        apiKey: customApiKey.trim() || undefined,
        apiKeyEnv: undefined,
        requiresApiKey: catalog.requiresApiKey,
        modelsRequiresApiKey: catalog.modelsRequiresApiKey,
        supportsTools: true,
        supportsThinking: model.supportsThinking,
        parallelToolCalls: model.parallelToolCalls,
        reasoningStream: model.reasoningStream,
        reasoningSummary: model.reasoningSummary,
        supportsVision: model.supportsVision,
        supportsAudio: model.supportsAudio,
        contextWindow: model.contextWindow,
        maxInputTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
        limits: model.limits,
        thinkingLevelMap: model.thinkingLevelMap,
        apiBackend: model.apiBackend ?? format.apiBackend,
        makeDefault
      });
      if (done) succeeded = true;
      makeDefault = false;
    }
    if (succeeded) {
      setCustomApiKey("");
      onNotify("自定义服务已连接");
      void refreshCatalog(providerAlias, { force: true });
    }
  }, [applyUpsert, catalog, customApiKey, customBaseUrl, customFormat, customModels, customSelected, defaultModelAlias, onNotify, refreshCatalog]);

  // ── 订阅登录（Claude Code / Codex） ──
  const [loginStage, setLoginStage] = useState<"idle" | "opening" | "waiting" | "submitted">("idle");
  const [loginRequest, setLoginRequest] = useState<DesktopModelLoginStartResult>();
  const [loginError, setLoginError] = useState<string>();
  const [authorizationCode, setAuthorizationCode] = useState("");
  const loginRequestRef = useRef<DesktopModelLoginStartResult | undefined>(undefined);
  const loginProviderRef = useRef<DesktopModelLoginProvider | undefined>(undefined);
  const loginActionRef = useRef(false);
  const loginGenerationRef = useRef(0);
  const onCancelLoginRef = useRef(onCancelLogin);
  useEffect(() => { onCancelLoginRef.current = onCancelLogin; }, [onCancelLogin]);

  /** 放弃进行中的登录：换面板、关设置、卸载组件共用这一个清理路径。 */
  const resetLogin = useCallback((notifyCancel: boolean): void => {
    loginGenerationRef.current += 1;
    const request = loginRequestRef.current;
    const provider = loginProviderRef.current;
    if (notifyCancel && request && provider) void onCancelLoginRef.current(provider, request.authRequestId);
    loginRequestRef.current = undefined;
    loginProviderRef.current = undefined;
    loginActionRef.current = false;
    setLoginRequest(undefined);
    setLoginStage("idle");
    setLoginError(undefined);
    setAuthorizationCode("");
  }, []);
  useEffect(() => {
    cancelLoginRef.current = () => resetLogin(true);
  }, [resetLogin]);

  const completeLoginRequest = useCallback(async (
    entryCatalog: ProviderCatalogItem,
    request: DesktopModelLoginStartResult,
    pastedAuthorization?: string
  ): Promise<void> => {
    if (!entryCatalog.loginProvider) return;
    const generation = loginGenerationRef.current;
    setLoginStage("submitted");
    setLoginError(undefined);
    try {
      const result = await onCompleteLogin(entryCatalog.loginProvider, request.authRequestId,
        request.method === "paste-code" ? pastedAuthorization : undefined);
      if (generation !== loginGenerationRef.current) return;
      // 登录返回的模型与凭据句柄立即成组落盘；句柄正文不进渲染层。
      const draft = settingsDraft.draft;
      const alias = providerAliasFor(entryCatalog, entryCatalog.baseUrl);
      if (draft) {
        // addOauthCredentialHandle 是异步 setState，紧随其后的提交必须显式带上句柄。
        settingsDraft.addOauthCredentialHandle(result.handle);
        const oauthCredentialHandles = draft.models.oauthCredentialHandles.includes(result.handle)
          ? draft.models.oauthCredentialHandles
          : [...draft.models.oauthCredentialHandles, result.handle];
        await commitModels({
          ...draft.models,
          oauthCredentialHandles,
          upserts: [
            ...draft.models.upserts.filter((item) => !result.models.some((model) => item.alias === modelAliasFor(alias, model.id))),
            ...result.models.map((model, index) => ({
              alias: modelAliasFor(alias, model.id),
              displayName: model.displayName,
              providerAlias: alias,
              providerType: entryCatalog.value,
              protocol: entryCatalog.protocol,
              model: model.id,
              baseUrl: entryCatalog.baseUrl || undefined,
              apiKeyEnv: undefined,
              requiresApiKey: entryCatalog.requiresApiKey,
              supportsTools: true,
              supportsThinking: model.supportsThinking,
              makeDefault: index === 0 && !defaultModelAlias
            }))
          ],
          removeAliases: draft.models.removeAliases.filter((candidate) => !result.models.some((model) => candidate === modelAliasFor(alias, model.id)))
        });
      }
      resetLogin(false);
      onNotify(`连接成功 · ${entryCatalog.label}`);
    } catch (error) {
      if (generation !== loginGenerationRef.current) return;
      // 一次性授权请求失败后主进程会清理 authRequestId；保留旧请求只会稳定报“授权会话不存在”。
      const message = error instanceof Error ? error.message : String(error);
      const canRetryPaste = request.method === "paste-code"
        && (message.includes("授权码格式不正确") || message.includes("state 校验失败"));
      setLoginStage(canRetryPaste ? "waiting" : "idle");
      if (!canRetryPaste) resetLogin(false);
      setLoginError(message);
    }
  }, [commitModels, defaultModelAlias, onCompleteLogin, onNotify, resetLogin, settingsDraft]);

  const startLogin = useCallback(async (entryCatalog: ProviderCatalogItem): Promise<void> => {
    if (!entryCatalog.loginProvider || loginActionRef.current) return;
    const generation = loginGenerationRef.current;
    loginActionRef.current = true;
    setLoginStage("opening");
    setLoginError(undefined);
    try {
      const request = await onStartLogin(entryCatalog.loginProvider);
      if (generation !== loginGenerationRef.current) {
        void onCancelLoginRef.current(entryCatalog.loginProvider, request.authRequestId);
        return;
      }
      loginProviderRef.current = entryCatalog.loginProvider;
      loginRequestRef.current = request;
      setLoginRequest(request);
      if (request.method === "browser-callback") {
        // 本地回调由主进程等待；回调到达后自动换 token 和验证模型。
        void completeLoginRequest(entryCatalog, request);
      } else {
        setLoginStage("waiting");
      }
    } catch (error) {
      loginActionRef.current = false;
      setLoginStage("idle");
      setLoginError(error instanceof Error ? error.message : String(error));
    }
  }, [completeLoginRequest, onStartLogin]);

  const submitLogin = useCallback(async (entryCatalog: ProviderCatalogItem): Promise<void> => {
    if (!entryCatalog.loginProvider || !loginRequest) return;
    await completeLoginRequest(entryCatalog, loginRequest, authorizationCode);
  }, [authorizationCode, completeLoginRequest, loginRequest]);

  const relogin = useCallback((entryCatalog: ProviderCatalogItem): void => {
    // 已保存配置记录了 OAuth 来源；重新登录复用同一张卡片。
    if (!entryCatalog.loginProvider) {
      onNotify("该连接没有可用的登录方式。");
      return;
    }
    resetLogin(true);
    void startLogin(entryCatalog);
  }, [onNotify, resetLogin, startLogin]);

  const usesOAuth = connection?.authMode === "oauth-bearer";
  const status = connectionStatus(connection);
  const apiKeyUrl = catalog?.apiKeyUrl;

  return (
    <div className="provider-settings">
      <aside aria-label="服务商列表" className="provider-list-pane">
        <label className="provider-list-search">
          <Icon name="search" size={14} />
          <input onChange={(event) => setQuery(event.target.value)} placeholder="搜索服务商" value={query} />
        </label>
        <div className="provider-list-rows" role="tablist">
          {loading && !entries.length ? (
            [0, 1, 2, 3].map((index) => (
              <div aria-hidden="true" className="provider-row provider-row-skeleton" key={index}>
                <span className="provider-mark skeleton-pulse" />
                <span className="provider-row-copy">
                  <span className="skeleton-line skeleton-pulse is-wide" />
                  <span className="skeleton-line skeleton-pulse" />
                </span>
              </div>
            ))
          ) : filteredEntries.map((row) => {
            const rowStatus = connectionStatus(row.connection);
            const healthy = row.group !== undefined && rowStatus === null;
            return (
              <button
                aria-selected={activeEntry?.key === row.key}
                className={`provider-row${activeEntry?.key === row.key ? " is-active" : ""}`}
                key={row.key}
                onClick={() => setActiveKey(row.key)}
                role="tab"
                type="button"
              >
                <span className={`provider-mark is-${row.iconTone}`}><ProviderBrandGlyph type={row.iconTone} /></span>
                <span className="provider-row-copy">
                  <strong>{row.label}</strong>
                  {row.badge ? <small>{row.badge}</small> : null}
                </span>
                <span
                  aria-hidden="true"
                  className={`provider-status-dot${healthy ? " is-ok" : row.group && rowStatus ? ` is-${rowStatus.tone}` : ""}`}
                  title={healthy ? "已连接" : row.group && rowStatus ? rowStatus.label : "未配置"}
                />
              </button>
            );
          })}
          {!loading && !filteredEntries.length ? <div className="provider-list-empty">没有匹配的服务商</div> : null}
        </div>
        <footer className="provider-list-footer">
          <Icon name="info" size={13} />
          <span>找不到服务商？用「自定义 OpenAI 兼容接口」接入任意中转站或网关。</span>
        </footer>
      </aside>

      <section aria-label="服务商配置" className="provider-detail-pane">
        {!activeEntry || (loading && !entries.length) ? (
          <div className="provider-detail-skeleton">
            <span className="skeleton-line skeleton-pulse is-wide" />
            <span className="skeleton-line skeleton-pulse" />
            <span className="skeleton-line skeleton-pulse" />
          </div>
        ) : activeEntry.catalog?.connectionMode === "login" || (usesOAuth && activeEntry.catalog) ? (
          <LoginProviderPanel
            catalog={activeEntry.catalog}
            connection={connection}
            group={group}
            stage={loginStage}
            loginRequest={loginRequest}
            error={loginError}
            authorizationCode={authorizationCode}
            availableModels={availableModels}
            defaultModelAlias={defaultModelAlias}
            fetchingCatalog={fetchingAlias === group?.provider}
            onAuthorizationCode={setAuthorizationCode}
            onStart={() => activeEntry.catalog && void startLogin(activeEntry.catalog)}
            onSubmit={() => activeEntry.catalog && void submitLogin(activeEntry.catalog)}
            onRelogin={() => activeEntry.catalog && relogin(activeEntry.catalog)}
            onRefreshCatalog={() => group && void refreshCatalog(group.provider, { force: true, announce: true })}
            onToggleModel={toggleModel}
            onOpenModelOptions={(model) => group && setProfileTarget({ providerAlias: group.provider, model })}
            onDefaultModel={onDefaultModel}
            onTest={runTest}
            testing={testing}
            testResult={testResult}
            testConfiguration={testConfiguration}
            testMenuOpen={testMenuOpen}
            setTestMenuOpen={setTestMenuOpen}
          />
        ) : group && catalog ? (
          <ConnectedProviderPanel
            catalog={catalog}
            connection={connection}
            group={group}
            status={status}
            availableModels={availableModels}
            defaultModelAlias={defaultModelAlias}
            keyDraft={keyDraft}
            showKey={showKey}
            baseUrlDraft={baseUrlDraft}
            fetchingCatalog={fetchingAlias === group.provider}
            saving={saving}
            testing={testing}
            testResult={testResult}
            testMenuOpen={testMenuOpen}
            deleteArmed={deleteArmed}
            manualModelId={manualModelId}
            usesOAuth={usesOAuth}
            onApiKeyChange={onKeyDraftChange}
            onApiKeyBlur={flushKeyDraft}
            onToggleShowKey={() => setShowKey((value) => !value)}
            onBaseUrlChange={(value) => { setBaseUrlDraft(value); if (baseUrlNeedsSave) void commitBaseUrl(); }}
            onBaseUrlBlur={() => { if (baseUrlNeedsSave) void commitBaseUrl(); }}
            onOpenExternal={onOpenExternal}
            onRefreshCatalog={() => void refreshCatalog(group.provider, { force: true, announce: true })}
            onToggleModel={toggleModel}
            onManualModelId={setManualModelId}
            onSubmitManualModel={() => void submitManualModel()}
            onOpenModelOptions={(model) => setProfileTarget({ providerAlias: group.provider, model })}
            onDefaultModel={onDefaultModel}
            onTest={runTest}
            onTestMenuOpen={setTestMenuOpen}
            testConfiguration={testConfiguration}
            onDeleteConnection={() => void deleteConnection()}
            onRelogin={() => relogin(catalog)}
          />
        ) : catalog && catalog.baseUrl ? (
          <section className="provider-panel">
            <header className="provider-panel-head">
              <span className={`provider-mark is-${catalog.iconTone} is-large`}><ProviderBrandGlyph type={catalog.iconTone} /></span>
              <div className="provider-panel-title">
                <h3>{catalog.label}</h3>
                <p>{catalog.description}</p>
              </div>
            </header>
            <div className="provider-enable-card">
              <strong>启用 {catalog.label}</strong>
              <p>先用默认模型建立连接，密钥可以之后再填。{catalog.requiresApiKey ? "正式使用前需要在下方粘贴 API Key。" : "该服务无需密钥。"}</p>
              <button className="settings-primary-button" disabled={saving} onClick={() => void enableProvider(catalog)} type="button">
                {saving ? "启用中…" : "启用服务商"}
              </button>
              {apiKeyUrl ? <a className="settings-link" href={apiKeyUrl} onClick={(event) => { event.preventDefault(); void onOpenExternal(apiKeyUrl); }} rel="noreferrer">获取 API Key<Icon name="external" size={11} /></a> : null}
            </div>
          </section>
        ) : catalog ? (
          <CustomProviderPanel
            catalog={catalog}
            baseUrl={customBaseUrl}
            apiKey={customApiKey}
            showKey={customShowKey}
            format={customFormat}
            models={customModels}
            selected={customSelected}
            fetching={customFetching}
            saving={saving}
            onBaseUrl={setCustomBaseUrl}
            onApiKey={setCustomApiKey}
            onToggleShowKey={() => setCustomShowKey((value) => !value)}
            onFormat={changeCustomFormat}
            onLoadModels={() => void loadCustomModels(true)}
            onToggleModel={(modelId) => setCustomSelected((current) => current.includes(modelId) ? current.filter((id) => id !== modelId) : [...current, modelId])}
            onConnect={() => void connectCustom()}
          />
        ) : null}
      </section>

      {profileTarget ? (
        <ModelOptionsDialog
          target={profileTarget}
          busy={saving}
          onClose={() => setProfileTarget(undefined)}
          onChange={(profile) => void applyProfile(profileTarget.providerAlias, profileTarget.model.model, profile)}
        />
      ) : null}
    </div>
  );
}

/** 订阅账号面板：未登录时是登录卡，登录后是账号状态 + 模型列表。 */
function LoginProviderPanel({
  catalog,
  connection,
  group,
  stage,
  loginRequest,
  error,
  authorizationCode,
  availableModels,
  defaultModelAlias,
  fetchingCatalog,
  onAuthorizationCode,
  onStart,
  onSubmit,
  onRelogin,
  onRefreshCatalog,
  onToggleModel,
  onOpenModelOptions,
  onDefaultModel,
  onTest,
  testing,
  testResult,
  testConfiguration,
  testMenuOpen,
  setTestMenuOpen
}: {
  catalog: ProviderCatalogItem;
  connection?: DesktopModelConnection;
  group?: ConnectionGroup;
  stage: "idle" | "opening" | "waiting" | "submitted";
  loginRequest?: DesktopModelLoginStartResult;
  error?: string;
  authorizationCode: string;
  availableModels: CatalogModel[];
  defaultModelAlias?: string;
  fetchingCatalog: boolean;
  onAuthorizationCode(value: string): void;
  onStart(): void;
  onSubmit(): void;
  onRelogin(): void;
  onRefreshCatalog(): void;
  onToggleModel(model: CatalogModel, enabled: boolean): Promise<void>;
  onOpenModelOptions(model: ModelChoice): void;
  onDefaultModel(alias: string, thinking: ThinkingSelection): void;
  onTest(model: ModelChoice): Promise<void>;
  testing: boolean;
  testResult?: DesktopModelConnectionTestResult;
  testConfiguration(model: ModelChoice): DesktopModelConfigurationInput | undefined;
  testMenuOpen: boolean;
  setTestMenuOpen(open: boolean): void;
}): React.JSX.Element {
  const [modelQuery, setModelQuery] = useState("");
  const waiting = stage !== "idle";
  const usesPasteCode = loginRequest?.method === "paste-code";
  const authenticated = Boolean(group && connection?.hasCredential && !connectionStatus(connection));
  const subscriptionTitle = catalog.id === "claude-code" ? "Claude 订阅 (Pro / Max)" : `${catalog.label} 订阅`;
  const authorizationHost = catalog.id === "claude-code" ? "Claude.ai" : "ChatGPT";
  const normalizedQuery = modelQuery.trim().toLocaleLowerCase();
  const filteredModels = normalizedQuery
    ? availableModels.filter((model) => `${model.displayName} ${model.id}`.toLocaleLowerCase().includes(normalizedQuery))
    : sortModelsForList(availableModels, group?.models ?? []);
  return (
    <section className="provider-panel">
      <header className="provider-panel-head">
        <span className={`provider-mark is-${catalog.iconTone} is-large`}><ProviderBrandGlyph type={catalog.iconTone} /></span>
        <div className="provider-panel-title">
          <h3>{catalog.label}{catalog.badge ? <span className="provider-panel-badge">{catalog.badge}</span> : null}</h3>
          <p>{catalog.description}</p>
        </div>
        {group ? (
          <TestConnectionButton
            models={group.models}
            testing={testing}
            testResult={testResult}
            open={testMenuOpen}
            onOpen={setTestMenuOpen}
            onTest={onTest}
            testConfiguration={testConfiguration}
          />
        ) : null}
      </header>

      <div className={`login-subscription-card${authenticated ? " is-ok" : ""}`}>
        <div className="login-subscription-heading">
          <div>
            <strong>{subscriptionTitle}</strong>
            <small>通过官方 OAuth 登录使用订阅配额。</small>
          </div>
          {authenticated
            ? <span className="status-pill is-ok">已登录</span>
            : waiting
              ? <span className="login-status is-waiting">{stage === "submitted" ? "正在验证..." : stage === "opening" ? "正在打开..." : "等待登录..."}</span>
              : <span className="login-status">未登录</span>}
        </div>
        {authenticated ? (
          <>
            <p>{oauthExpiryHint(connection?.oauthExpiresAt)}</p>
            <button className="ghost-button" onClick={onRelogin} type="button">重新登录</button>
          </>
        ) : !waiting ? (
          <>
            <p>使用订阅配额前需要先通过官方 OAuth 登录。</p>
            <button className="settings-primary-button" onClick={onStart} type="button">登录 {catalog.label}</button>
          </>
        ) : (
          <p>{usesPasteCode ? "请在浏览器完成登录后粘贴授权码。" : stage === "submitted" ? "已收到浏览器回调，正在自动验证账号。" : "请在弹出的浏览器窗口完成登录，浏览器会自动返回此应用。"}</p>
        )}
        {waiting && usesPasteCode ? (
          <div className="login-code-panel">
            <p>在 {authorizationHost} 完成登录后，会跳转到控制台显示一段授权码（含 <code>#</code> 分隔符），把它粘贴到下面：</p>
            <small>提示：你的 state 以 <code>{loginRequest?.stateHint}</code> 开头。</small>
            <textarea
              autoFocus
              onChange={(event) => onAuthorizationCode(event.target.value)}
              placeholder="粘贴授权码（格式：xxx#yyy）"
              value={authorizationCode}
            />
            <div className="login-code-actions">
              <button className="settings-primary-button" disabled={!authorizationCode.trim() || stage === "submitted"} onClick={onSubmit} type="button">提交授权码</button>
              <button onClick={onStart} type="button">重新开始登录</button>
            </div>
          </div>
        ) : null}
        {error ? <p className="login-error" role="alert">{error}</p> : null}
      </div>

      {group ? (
        <ModelsSection
          models={filteredModels}
          enabledModels={group.models}
          defaultModelAlias={defaultModelAlias}
          query={modelQuery}
          onQuery={setModelQuery}
          fetchingCatalog={fetchingCatalog}
          onRefreshCatalog={onRefreshCatalog}
          onToggleModel={onToggleModel}
          onOpenModelOptions={onOpenModelOptions}
          onDefaultModel={onDefaultModel}
          manualModelId=""
          onManualModelId={() => undefined}
          onSubmitManualModel={() => undefined}
        />
      ) : null}
    </section>
  );
}

/** 已连接的服务商面板：凭据行 + 模型管理 + 危险区。 */
function ConnectedProviderPanel({
  catalog,
  connection,
  group,
  status,
  availableModels,
  defaultModelAlias,
  keyDraft,
  showKey,
  baseUrlDraft,
  fetchingCatalog,
  saving,
  testing,
  testResult,
  testMenuOpen,
  deleteArmed,
  manualModelId,
  usesOAuth,
  onApiKeyChange,
  onApiKeyBlur,
  onToggleShowKey,
  onBaseUrlChange,
  onBaseUrlBlur,
  onOpenExternal,
  onRefreshCatalog,
  onToggleModel,
  onManualModelId,
  onSubmitManualModel,
  onOpenModelOptions,
  onDefaultModel,
  onTest,
  onTestMenuOpen,
  testConfiguration,
  onDeleteConnection,
  onRelogin
}: {
  catalog: ProviderCatalogItem;
  connection?: DesktopModelConnection;
  group: ConnectionGroup;
  status: { label: string; tone: "warn" | "error" } | null;
  availableModels: CatalogModel[];
  defaultModelAlias?: string;
  keyDraft: string;
  showKey: boolean;
  baseUrlDraft: string;
  fetchingCatalog: boolean;
  saving: boolean;
  testing: boolean;
  testResult?: DesktopModelConnectionTestResult;
  testMenuOpen: boolean;
  deleteArmed: boolean;
  manualModelId: string;
  usesOAuth: boolean;
  onApiKeyChange(value: string): void;
  onApiKeyBlur(): void;
  onToggleShowKey(): void;
  onBaseUrlChange(value: string): void;
  onBaseUrlBlur(): void;
  onOpenExternal(url: string): Promise<void>;
  onRefreshCatalog(): void;
  onToggleModel(model: CatalogModel, enabled: boolean): Promise<void>;
  onManualModelId(value: string): void;
  onSubmitManualModel(): void;
  onOpenModelOptions(model: ModelChoice): void;
  onDefaultModel(alias: string, thinking: ThinkingSelection): void;
  onTest(model: ModelChoice): Promise<void>;
  onTestMenuOpen(open: boolean): void;
  testConfiguration(model: ModelChoice): DesktopModelConfigurationInput | undefined;
  onDeleteConnection(): void;
  onRelogin(): void;
}): React.JSX.Element {
  const [modelQuery, setModelQuery] = useState("");
  const normalizedQuery = modelQuery.trim().toLocaleLowerCase();
  const filteredModels = normalizedQuery
    ? availableModels.filter((model) => `${model.displayName} ${model.id}`.toLocaleLowerCase().includes(normalizedQuery))
    : sortModelsForList(availableModels, group.models);
  const apiKeyUrl = catalog.apiKeyUrl;
  const isCustomEndpoint = !catalog.baseUrl;
  const apiFormat = apiFormatForConnection(connection?.protocol ?? catalog.protocol, connection?.apiBackend);
  return (
    <section className="provider-panel">
      <header className="provider-panel-head">
        <span className={`provider-mark is-${catalog.iconTone} is-large`}><ProviderBrandGlyph type={catalog.iconTone} /></span>
        <div className="provider-panel-title">
          <h3>
            {catalog.label}
            {status
              ? <span className={`status-pill is-${status.tone}`}>{status.label}</span>
              : <span className="status-pill is-ok">已连接</span>}
          </h3>
          <p>{catalog.description}</p>
        </div>
        <TestConnectionButton
          models={group.models}
          testing={testing}
          testResult={testResult}
          open={testMenuOpen}
          onOpen={onTestMenuOpen}
          onTest={onTest}
          testConfiguration={testConfiguration}
        />
      </header>

      {usesOAuth ? (
        <div className={`provider-oauth-card${status ? " is-attention" : ""}`}>
          <div className="login-subscription-heading">
            <div>
              <strong>订阅登录</strong>
              <small>{status ? "该连接的授权已失效，重新登录后即可继续使用。" : oauthExpiryHint(connection?.oauthExpiresAt)}</small>
            </div>
            {status ? <span className={`status-pill is-${status.tone}`}>{status.label}</span> : null}
          </div>
          <button className="ghost-button" onClick={onRelogin} type="button">重新登录</button>
        </div>
      ) : (
        <div className="provider-rows">
          <div className="provider-row-item">
            <span className="provider-row-label">API Key</span>
            <div className="secret-input-row">
              <input
                autoComplete="off"
                onBlur={onApiKeyBlur}
                onChange={(event) => onApiKeyChange(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onApiKeyBlur(); } }}
                placeholder={connection?.hasCredential ? "粘贴新密钥可替换，输入后自动保存" : connection?.requiresApiKey === false ? "本地服务通常无需填写" : "输入或粘贴 API Key，输入后自动保存"}
                type={showKey ? "text" : "password"}
                value={keyDraft}
              />
              {/* 已保存密钥不过桥；框里只可能是刚输入的新值，为空时无需展示。 */}
              <button aria-label={showKey ? "隐藏密钥" : "显示密钥"} className="icon-button" disabled={!keyDraft} onClick={onToggleShowKey} type="button">
                <Icon name={showKey ? "eye-off" : "eye"} size={14} />
              </button>
            </div>
            <div className="provider-row-hint">
              {credentialHint(connection)}
              {apiKeyUrl ? <>
                {" "}· <a className="settings-link" href={apiKeyUrl} onClick={(event) => { event.preventDefault(); void onOpenExternal(apiKeyUrl); }} rel="noreferrer">获取 API Key<Icon name="external" size={11} /></a>
              </> : null}
            </div>
          </div>

          <div className="provider-row-item">
            <span className="provider-row-label">服务地址</span>
            <input
              onBlur={onBaseUrlBlur}
              onChange={(event) => onBaseUrlChange(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onBaseUrlBlur(); } }}
              placeholder="留空使用服务商默认地址"
              value={baseUrlDraft}
            />
            {baseUrlNeedsVersionHint(baseUrlDraft)
              ? <div className="provider-row-warning"><Icon name="info" size={12} />部分服务商要求地址以版本路径结尾（如 /v1），请求失败时可尝试追加。</div>
              : <div className="provider-row-hint">{isCustomEndpoint ? "中转站或自建网关的完整地址。" : "该连接的所有请求都发往这个地址。"}</div>}
          </div>

          {isCustomEndpoint ? (
            <div className="provider-row-item">
              <span className="provider-row-label">API 格式</span>
              <span className="provider-row-value">{apiFormatOption(apiFormat).label}</span>
              <div className="provider-row-hint">{apiFormatOption(apiFormat).description}。需要调整时删除连接后重新添加。</div>
            </div>
          ) : null}
        </div>
      )}

      <ModelsSection
        models={filteredModels}
        enabledModels={group.models}
        defaultModelAlias={defaultModelAlias}
        query={modelQuery}
        onQuery={setModelQuery}
        fetchingCatalog={fetchingCatalog}
        onRefreshCatalog={onRefreshCatalog}
        onToggleModel={onToggleModel}
        onOpenModelOptions={onOpenModelOptions}
        onDefaultModel={onDefaultModel}
        manualModelId={manualModelId}
        onManualModelId={onManualModelId}
        onSubmitManualModel={onSubmitManualModel}
      />

      <section className="provider-danger-zone">
        <div className="provider-danger-copy">
          <strong>删除连接</strong>
          <span>移除该服务商的全部模型与本地凭据引用，此操作不可撤销。</span>
        </div>
        <button className="danger-button" disabled={saving} onClick={onDeleteConnection} type="button">
          {deleteArmed ? "确认删除？" : "删除"}
        </button>
      </section>
    </section>
  );
}

/** 自定义端点（未连接）：地址 + 格式 + 密钥 → 拉模型 → 勾选启用。 */
function CustomProviderPanel({
  catalog,
  baseUrl,
  apiKey,
  showKey,
  format,
  models,
  selected,
  fetching,
  saving,
  onBaseUrl,
  onApiKey,
  onToggleShowKey,
  onFormat,
  onLoadModels,
  onToggleModel,
  onConnect
}: {
  catalog: ProviderCatalogItem;
  baseUrl: string;
  apiKey: string;
  showKey: boolean;
  format: ApiFormatId;
  models: CatalogModel[];
  selected: string[];
  fetching: boolean;
  saving: boolean;
  onBaseUrl(value: string): void;
  onApiKey(value: string): void;
  onToggleShowKey(): void;
  onFormat(id: ApiFormatId): void;
  onLoadModels(): void;
  onToggleModel(modelId: string): void;
  onConnect(): void;
}): React.JSX.Element {
  const keyMissing = catalog.requiresApiKey && !apiKey.trim();
  const canConnect = !saving && !fetching && !keyMissing && Boolean(baseUrl.trim()) && selected.length > 0;
  return (
    <section className="provider-panel">
      <header className="provider-panel-head">
        <span className={`provider-mark is-${catalog.iconTone} is-large`}><ProviderBrandGlyph type={catalog.iconTone} /></span>
        <div className="provider-panel-title">
          <h3>{catalog.label}<span className="provider-panel-badge">{catalog.badge}</span></h3>
          <p>{catalog.description}</p>
        </div>
      </header>

      <div className="provider-rows">
        <div className="provider-row-item">
          <span className="provider-row-label">服务地址</span>
          <input
            autoFocus
            onChange={(event) => onBaseUrl(event.target.value)}
            placeholder={apiFormatOption(format).baseUrlPlaceholder}
            value={baseUrl}
          />
          {baseUrlNeedsVersionHint(baseUrl)
            ? <div className="provider-row-warning"><Icon name="info" size={12} />部分服务商要求地址以版本路径结尾（如 /v1），请求失败时可尝试追加。</div>
            : null}
        </div>
        <div className="provider-row-item">
          <span className="provider-row-label">API 格式</span>
          <select className="connection-select" onChange={(event) => onFormat(event.target.value as ApiFormatId)} value={format}>
            {apiFormatOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          <div className="provider-row-hint">{apiFormatOption(format).description}</div>
        </div>
        <div className="provider-row-item">
          <span className="provider-row-label">API Key{catalog.requiresApiKey ? "" : "（可选）"}</span>
          <div className="secret-input-row">
            <input
              autoComplete="off"
              onChange={(event) => onApiKey(event.target.value)}
              placeholder="输入或粘贴 API Key"
              type={showKey ? "text" : "password"}
              value={apiKey}
            />
            <button aria-label={showKey ? "隐藏密钥" : "显示密钥"} className="icon-button" disabled={!apiKey} onClick={onToggleShowKey} type="button">
              <Icon name={showKey ? "eye-off" : "eye"} size={14} />
            </button>
          </div>
        </div>
      </div>

      <section className="provider-models">
        <div className="provider-models-head">
          <h4>启用模型</h4>
          <button className="ghost-button" disabled={fetching || !baseUrl.trim()} onClick={onLoadModels} type="button">
            <Icon name="refresh" size={13} />
            {fetching ? "加载中…" : "加载模型"}
          </button>
        </div>
        <p className="provider-models-hint">
          {fetching
            ? "正在从服务商加载模型…"
            : models.length > 0
              ? `已选 ${String(selected.length)} / ${String(models.length)}`
              : keyMissing
                ? "填写服务地址和密钥后，点击“加载模型”获取支持列表"
                : "填写服务地址后，点击“加载模型”获取支持列表"}
        </p>
        <div aria-label="选择要启用的模型" className="provider-model-list" role="group">
          {models.map((model) => {
            const checked = selected.includes(model.id);
            return (
              <button
                aria-checked={checked}
                className={`provider-model-row${checked ? " is-enabled" : ""}`}
                key={model.id}
                onClick={() => onToggleModel(model.id)}
                role="checkbox"
                type="button"
              >
                <span className={`check-dot${checked ? " is-on" : ""}`}><Icon name="check" size={11} /></span>
                <span className="provider-model-name">{model.displayName}</span>
                {model.id !== model.displayName ? <span className="provider-model-id">{model.id}</span> : null}
              </button>
            );
          })}
          {!models.length ? <div className="provider-models-empty">{fetching ? "正在加载模型…" : "尚未加载模型列表"}</div> : null}
        </div>
      </section>

      <div className="provider-panel-actions">
        <button className="settings-primary-button" disabled={!canConnect} onClick={onConnect} type="button">
          {saving ? "连接中…" : "连接服务商"}
        </button>
      </div>
    </section>
  );
}

/** 测试连接按钮：多模型时变成可挑模型的分体按钮，结果留在按钮旁。 */
function TestConnectionButton({
  models,
  testing,
  testResult,
  open,
  onOpen,
  onTest,
  testConfiguration
}: {
  models: ModelChoice[];
  testing: boolean;
  testResult?: DesktopModelConnectionTestResult;
  open: boolean;
  onOpen(open: boolean): void;
  onTest(model: ModelChoice): Promise<void>;
  testConfiguration(model: ModelChoice): DesktopModelConfigurationInput | undefined;
}): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) onOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [onOpen, open]);
  const target = models[0];
  return (
    <div className="provider-test-area">
      {testResult ? <ConnectionTestResult result={testResult} /> : null}
      <div className="provider-test-split" ref={menuRef}>
        <button
          className="ghost-button provider-test-button"
          disabled={testing || !target || !testConfiguration(target)}
          onClick={() => target && void onTest(target)}
          title="测试连接"
          type="button"
        >
          {testing ? <Icon name="refresh" size={13} /> : testResult ? <Icon name={testResult.ok ? "check" : "close"} size={13} /> : <Icon name="spark" size={13} />}
          测试
        </button>
        {models.length > 1 ? (
          <button aria-label="选择要测试的模型" className="ghost-button provider-test-caret" disabled={testing} onClick={() => onOpen(!open)} type="button">
            <Icon name="chevron" size={12} />
          </button>
        ) : null}
        {open && models.length > 1 ? (
          <div className="provider-test-menu" role="listbox">
            {models.map((model) => (
              <button className="provider-test-option" key={model.alias} onClick={() => void onTest(model)} role="option" type="button">
                <span>{model.displayName}</span>
                <small>{model.model}</small>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ConnectionTestResult({ result }: { result: DesktopModelConnectionTestResult }): React.JSX.Element {
  const text = result.ok
    ? (result.latencyMs !== undefined ? `连接成功 · ${String(result.latencyMs)}ms` : result.message || "连接成功")
    : result.message || "连接失败";
  return <span className={`connection-test-result${result.ok ? " is-ok" : " is-error"}`} role="status">{text}</span>;
}

/** 模型区：搜索 + 计数 + 启用优先的模型列表 + 手动添加。 */
function ModelsSection({
  models,
  enabledModels,
  defaultModelAlias,
  query,
  onQuery,
  fetchingCatalog,
  onRefreshCatalog,
  onToggleModel,
  onOpenModelOptions,
  onDefaultModel,
  manualModelId,
  onManualModelId,
  onSubmitManualModel
}: {
  models: CatalogModel[];
  enabledModels: ModelChoice[];
  defaultModelAlias?: string;
  query: string;
  onQuery(value: string): void;
  fetchingCatalog: boolean;
  onRefreshCatalog(): void;
  onToggleModel(model: CatalogModel, enabled: boolean): Promise<void>;
  onOpenModelOptions(model: ModelChoice): void;
  onDefaultModel(alias: string, thinking: ThinkingSelection): void;
  manualModelId: string;
  onManualModelId(value: string): void;
  onSubmitManualModel(): void;
}): React.JSX.Element {
  const enabledIds = new Set(enabledModels.map((model) => model.model));
  const enabledChoiceByModel = new Map(enabledModels.map((model) => [model.model, model] as const));
  return (
    <section className="provider-models">
      <div className="provider-models-head">
        <h4>模型</h4>
        <div className="provider-models-actions">
          <button className="ghost-button" disabled={fetchingCatalog} onClick={onRefreshCatalog} type="button">
            <Icon name={fetchingCatalog ? "refresh" : "download"} size={13} />
            {fetchingCatalog ? "获取中…" : "获取"}
          </button>
        </div>
      </div>
      {models.length > 0 ? (
        <label className="provider-model-search">
          <Icon name="search" size={13} />
          <input onChange={(event) => onQuery(event.target.value)} placeholder="搜索模型..." value={query} />
        </label>
      ) : null}
      <p className="provider-models-hint">显示 {String(models.length)} 个模型（已启用优先）</p>
      <div className="provider-model-list">
        {models.map((model) => {
          const enabled = enabledIds.has(model.id);
          const choice = enabledChoiceByModel.get(model.id);
          const isDefault = choice?.alias === defaultModelAlias;
          return (
            <div className="provider-model-row" key={model.id}>
              <div className="provider-model-copy">
                <span className="provider-model-name">{model.displayName}</span>
                <span className="provider-model-meta">
                  <CapabilityBadges model={model} />
                  {model.contextWindow && !model.contextWindowIsFallback ? <span title={String(model.contextWindow)}>{formatContextWindow(model.contextWindow)}</span> : null}
                  <span className="provider-model-id">{model.id}</span>
                </span>
              </div>
              <div className="provider-model-actions">
                {choice && !isDefault ? (
                  <button className="text-button" disabled={!enabled} onClick={() => onDefaultModel(choice.alias, choice.defaultThinking)} type="button">设为默认</button>
                ) : null}
                {isDefault ? <span className="default-pill">默认</span> : null}
                {choice ? (
                  <button aria-label="模型选项" className="icon-button" onClick={() => onOpenModelOptions(choice)} type="button">
                    <Icon name="settings" size={13} />
                  </button>
                ) : null}
                <button
                  aria-checked={enabled}
                  aria-label={`${enabled ? "停用" : "启用"} ${model.displayName}`}
                  className={`model-toggle${enabled ? " is-on" : ""}`}
                  onClick={() => void onToggleModel(model, !enabled)}
                  role="switch"
                  type="button"
                >
                  <span className="model-toggle-thumb" />
                </button>
              </div>
            </div>
          );
        })}
        {!models.length ? (
          <div className="provider-models-empty">
            <strong>暂无可用模型</strong>
            <span>请检查密钥后点击“获取”刷新模型列表。</span>
          </div>
        ) : null}
      </div>
      {/* 目录滞后时的逃生通道：按原始 ID 直接启用，能力由运行时保守补齐。 */}
      <div className="provider-manual-row">
        <input
          onChange={(event) => onManualModelId(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && manualModelId.trim()) { event.preventDefault(); onSubmitManualModel(); } }}
          placeholder="手动添加模型 ID（例如 gpt-4o）"
          value={manualModelId}
        />
        <button className="ghost-button" disabled={!manualModelId.trim()} onClick={onSubmitManualModel} type="button">添加</button>
      </div>
    </section>
  );
}

function CapabilityBadges({ model }: { model: CatalogModel }): React.JSX.Element {
  const badges: Array<{ icon: "brain-spark" | "eye"; label: string }> = [];
  if (model.supportsThinking) badges.push({ icon: "brain-spark", label: "推理" });
  if (model.supportsVision) badges.push({ icon: "eye", label: "视觉" });
  return (
    <>
      {badges.map((badge) => (
        <span className="provider-model-cap" key={badge.icon} title={badge.label}>
          <Icon name={badge.icon} size={11} />
        </span>
      ))}
    </>
  );
}

/** 模型元数据覆盖对话框：上下文窗口、输入上限与思考档位映射。 */
function ModelOptionsDialog({
  target,
  busy,
  onClose,
  onChange
}: {
  target: { providerAlias: string; model: ModelChoice };
  busy: boolean;
  onClose(): void;
  onChange(profile: ModelProfile | undefined): void;
}): React.JSX.Element {
  const profiles = useSettingsDraft().draft?.models.modelProfiles[target.providerAlias] ?? {};
  const profile = profiles[target.model.model];
  return (
    <div className="provider-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} role="presentation">
      <section aria-label="模型选项" className="provider-dialog" role="dialog">
        <header>
          <div>
            <strong>模型选项</strong>
            <small><code>{target.model.model}</code> · {target.model.displayName}</small>
          </div>
          {profile ? <button className="text-button" onClick={() => onChange(undefined)} type="button">重置为默认</button> : null}
        </header>
        <p className="provider-dialog-hint">留空使用目录元数据；这里的覆盖按模型 ID 保存，目录刷新不会覆盖用户声明。</p>
        <ModelProfileEditorFields busy={busy} model={target.model} onChange={onChange} profile={profile} />
        <footer>
          <button className="settings-primary-button" onClick={onClose} type="button">完成</button>
        </footer>
      </section>
    </div>
  );
}

const modelProfileThinkingLevels: Array<{ level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; label: string }> = [
  { level: "off", label: "关闭 / off" },
  { level: "minimal", label: "最小 / minimal" },
  { level: "low", label: "低 / low" },
  { level: "medium", label: "中 / medium" },
  { level: "high", label: "高 / high" },
  { level: "xhigh", label: "超高 / xhigh" },
  { level: "max", label: "最大 / max" }
];

type ModelProfileThinkingLevel = (typeof modelProfileThinkingLevels)[number]["level"];

function ModelProfileEditorFields({ busy, model, profile, onChange }: {
  busy: boolean;
  model?: ModelChoice;
  profile?: ModelProfile;
  onChange(profile: ModelProfile | undefined): void;
}): React.JSX.Element {
  const updateField = (field: "contextWindow" | "maxInputTokens" | "maxOutputTokens", value: string): void => {
    onChange(updateModelProfile(profile, field, value));
  };
  const updateThinkingLevel = (level: ModelProfileThinkingLevel, value: string): void => {
    onChange(updateModelProfile(profile, "thinkingLevelMap", value, level));
  };
  return (
    <div className="model-profile-editor-fields">
      <label>
        <span>上下文窗口</span>
        <input
          disabled={busy}
          min={4096}
          onChange={(event) => updateField("contextWindow", event.target.value)}
          placeholder={model?.contextWindowIsFallback ? "自动：保守预算" : model?.contextWindow ? `自动：${formatContextWindow(model.contextWindow)}` : "例如 1000000"}
          step={1}
          type="number"
          value={profile?.contextWindow ?? ""}
        />
      </label>
      <label>
        <span>最大输入 token</span>
        <input
          disabled={busy}
          min={2048}
          onChange={(event) => updateField("maxInputTokens", event.target.value)}
          placeholder="例如 950000"
          step={1}
          type="number"
          value={profile?.maxInputTokens ?? ""}
        />
      </label>
      <label>
        <span>最大输出 token</span>
        <input
          disabled={busy}
          min={1}
          onChange={(event) => updateField("maxOutputTokens", event.target.value)}
          placeholder={model?.maxOutputTokens ? `自动：${model.maxOutputTokens}` : "例如 128000"}
          step={1}
          type="number"
          value={profile?.maxOutputTokens ?? ""}
        />
      </label>
      <div className="model-profile-thinking-fields">
        <span className="model-profile-field-label">思考档位对应的网关参数</span>
        {model ? <span className="model-profile-auto-map">自动映射：{formatThinkingMapping(model)}</span> : null}
        {modelProfileThinkingLevels.map(({ level, label }) => (
          <label key={level}>
            <span>{label}</span>
            <input
              disabled={busy}
              onChange={(event) => updateThinkingLevel(level, event.target.value)}
              placeholder={automaticThinkingPlaceholder(model, level)}
              type="text"
              value={profile?.thinkingLevelMap?.[level] ?? ""}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function automaticThinkingPlaceholder(model: ModelChoice | undefined, level: ModelProfileThinkingLevel): string {
  if (!model) return level === "off" ? "none 可明确关闭" : "留空使用自动推导";
  const native = model.thinkingLevelMap[level];
  if (native === null) return "自动：不支持";
  if (native !== undefined) return `自动：${native}`;
  return level === "off" ? "自动：不可关闭" : "留空使用自动推导";
}

function formatThinkingMapping(model: ModelChoice): string {
  const enabled = modelProfileThinkingLevels
    .filter(({ level }) => level !== "off")
    .map(({ level }) => `${level}→${model.thinkingLevelMap[level] ?? "不支持"}`);
  const off = model.thinkingLevelMap.off;
  return [`off→${off ?? "不可关闭"}`, ...enabled].join(" · ");
}

function updateModelProfile(
  profile: ModelProfile | undefined,
  field: "contextWindow" | "maxInputTokens" | "maxOutputTokens" | "thinkingLevelMap",
  value: string,
  level?: ModelProfileThinkingLevel
): ModelProfile | undefined {
  const next: ModelProfile = {
    contextWindow: profile?.contextWindow,
    maxInputTokens: profile?.maxInputTokens,
    maxOutputTokens: profile?.maxOutputTokens,
    thinkingLevelMap: profile?.thinkingLevelMap === undefined ? undefined : { ...profile.thinkingLevelMap }
  };
  if (field === "contextWindow") next.contextWindow = parseProfileInteger(value);
  else if (field === "maxInputTokens") next.maxInputTokens = parseProfileInteger(value);
  else if (field === "maxOutputTokens") next.maxOutputTokens = parseProfileInteger(value);
  else if (level !== undefined) {
    const thinkingLevelMap = next.thinkingLevelMap ?? {};
    const nativeValue = value.trim();
    if (nativeValue) thinkingLevelMap[level] = nativeValue;
    else delete thinkingLevelMap[level];
    next.thinkingLevelMap = Object.keys(thinkingLevelMap).length ? thinkingLevelMap : undefined;
  }
  return next.contextWindow !== undefined || next.maxInputTokens !== undefined || next.thinkingLevelMap !== undefined ? next : undefined;
}

function parseProfileInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

// ── 共享的投影与展示辅助 ──

/**
 * Candidate list for the model list: enabled models first (so the user can
 * always toggle one off), then the provider's live catalog, or the built-in
 * static fallback when the live catalog is empty.
 */
function mergeAvailableModels(
  catalogModels: CatalogModel[],
  configuredModels: ModelChoice[],
  liveModels: CatalogModel[] = []
): CatalogModel[] {
  const merged: CatalogModel[] = [];
  const seen = new Set<string>();
  const liveById = new Map(liveModels.map((model) => [model.id, model] as const));
  for (const model of configuredModels) {
    if (seen.has(model.model)) continue;
    seen.add(model.model);
    const live = liveById.get(model.model);
    const liveContextIsBetter = model.contextWindowIsFallback === true && live?.contextWindow !== undefined;
    merged.push({
      id: model.model,
      displayName: live?.displayName ?? model.displayName,
      supportsThinking: model.efforts.length > 0 || Boolean(live?.supportsThinking),
      parallelToolCalls: model.capabilities?.parallelToolCalls ?? live?.parallelToolCalls,
      reasoningStream: model.capabilities?.reasoningStream ?? live?.reasoningStream,
      reasoningSummary: model.capabilities?.reasoningSummary ?? live?.reasoningSummary,
      supportsVision: model.capabilities?.vision ?? live?.supportsVision,
      supportsAudio: model.capabilities?.audio ?? live?.supportsAudio,
      contextWindow: liveContextIsBetter ? live.contextWindow : model.contextWindow ?? live?.contextWindow,
      contextWindowIsFallback: liveContextIsBetter ? live.contextWindowIsFallback : model.contextWindowIsFallback ?? live?.contextWindowIsFallback,
      maxInputTokens: liveContextIsBetter ? live.maxInputTokens ?? model.maxInputTokens : model.maxInputTokens ?? live?.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens ?? live?.maxOutputTokens,
      limits: model.limits ?? live?.limits,
      thinkingLevelMap: model.thinkingLevelMap ?? live?.thinkingLevelMap,
      apiBackend: model.apiBackend ?? live?.apiBackend
    });
  }
  const remainingModels = liveModels.length ? liveModels : catalogModels;
  for (const model of remainingModels) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    merged.push(model);
  }
  return merged;
}

/** Maps one live `ModelCatalogEntry` from the provider onto the picker's shape. */
function catalogModelFromEntry(entry: DesktopModelCatalogResult["models"][number]): CatalogModel {
  return {
    id: entry.id,
    displayName: entry.displayName,
    supportsThinking: entry.reasoningEfforts.length > 0 || entry.capabilities.reasoning === true,
    parallelToolCalls: entry.capabilities.parallelToolCalls,
    reasoningStream: entry.capabilities.reasoningStream,
    reasoningSummary: entry.capabilities.reasoningSummary,
    supportsVision: entry.capabilities.vision,
    supportsAudio: entry.capabilities.audio,
    contextWindow: entry.contextWindow,
    contextWindowIsFallback: entry.contextWindow === undefined,
    maxInputTokens: entry.maxInputTokens,
    maxOutputTokens: entry.maxOutputTokens,
    limits: entry.limits,
    thinkingLevelMap: entry.thinkingLevelMap,
    apiBackend: entry.apiBackend
  };
}

/** Short status line for one connection, or null when nothing needs attention. */
function connectionStatus(connection: DesktopModelConnection | undefined): { label: string; tone: "warn" | "error" } | null {
  if (!connection) return null;
  if (connection.authMode === "oauth-bearer") {
    if (!connection.hasCredential) return { label: "需要登录", tone: "error" };
    if (connection.oauthExpiresAt !== undefined && connection.oauthExpiresAt <= Date.now()) {
      return { label: "登录已过期", tone: "warn" };
    }
    return null;
  }
  if (connection.requiresApiKey && !connection.hasCredential) return { label: "缺少密钥", tone: "error" };
  return null;
}

/** One-line credential hint under the API key field. Always rendered, so the row height never jumps. */
function credentialHint(connection: DesktopModelConnection | undefined): string {
  if (!connection) return "尚未保存该连接的凭据";
  if (connection.credentialSource === "env") return `使用环境变量 ${connection.apiKeyEnv ?? ""} 中的密钥`;
  if (connection.credentialSource === "keychain") return "已保存在 macOS 钥匙串，粘贴新值可替换";
  if (connection.hasCredential) return "已设置，粘贴新值可替换";
  return connection.requiresApiKey ? "尚未设置密钥，粘贴后自动保存" : "该服务通常无需密钥";
}

function oauthExpiryHint(expiresAt: number | undefined): string {
  if (expiresAt === undefined) return "已通过官方 OAuth 登录，使用订阅配额。";
  const remainingMinutes = Math.round((expiresAt - Date.now()) / 60_000);
  if (remainingMinutes <= 0) return "访问令牌已过期，将在下次发送时自动刷新。";
  if (remainingMinutes < 60) return `已登录，访问令牌 ${String(remainingMinutes)} 分钟后自动刷新。`;
  return `已登录，访问令牌 ${String(Math.round(remainingMinutes / 60))} 小时后自动刷新。`;
}

/** 启用优先排序；同档内按显示名稳定排序，孤儿启用模型不会沉底。 */
function sortModelsForList(models: CatalogModel[], enabledModels: ModelChoice[]): CatalogModel[] {
  const enabledIds = new Set(enabledModels.map((model) => model.model));
  return models
    .map((model, index) => ({ model, index, enabled: enabledIds.has(model.id) }))
    .sort((left, right) =>
      Number(right.enabled) - Number(left.enabled)
      || left.index - right.index)
    .map((item) => item.model);
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1).replace(/\.0$/, "")}M`;
  }
  return `${Math.round(tokens / 1_000)}K`;
}

/** URL 缺版本段（/v1 等）且路径很浅时提示：这是中转站 404 的最常见原因。 */
function baseUrlNeedsVersionHint(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed || !/^https?:\/\//u.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    const segments = parsed.pathname.split("/").filter(Boolean);
    return !/\/v\d+[a-z]*$/iu.test(parsed.pathname) && segments.length < 2;
  } catch {
    return false;
  }
}
