/**
 * 桌面端聊天输入区。
 *
 * Astryx ChatComposer 只负责输入框、附件抽屉和发送按钮的视觉与基础交互；模型切换、
 * 权限变更、附件保存和 Agent 执行仍沿用 Biny 原有的数据流。Slash command 使用
 * Astryx 输入控件内置的 trigger 菜单，避免在组件里复制一套会和 contentEditable 键盘状态冲突的补全逻辑。
 */
import { ChatComposer, ChatComposerDrawer, ChatComposerInput } from "@astryxdesign/core/Chat";
import type { ChatComposerInputHandle } from "@astryxdesign/core/Chat";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { AgentSessionInfo, InteractiveAgentRunMode } from "../../../../agent/AgentSession.js";
import type { AgentCapabilitySelection } from "../../../../agent/capabilitySelection.js";
import type { ModelChoice } from "../../../../llm/ModelManager.js";
import { modelThinkingSelections, thinkingSelectionForModel, type ThinkingSelection } from "../../../../llm/modelThinking.js";
import type { DesktopAttachment, DesktopCapabilityDefaults, DesktopProject, DesktopSkillCatalogEntry, DesktopToolCatalogEntry } from "../../../protocol.js";
import { DESKTOP_SLASH_COMMANDS } from "../../../protocol.js";
import { catalogForConnection } from "../providerCatalog.js";
import { formatContextUsage, type ContextUsage } from "../usagePresentation.js";
import { AttachmentList } from "./composer/AttachmentList.js";
import type { PendingAttachment } from "./composer/AttachmentList.js";
import { ComposerActionButton } from "./composer/ComposerActionButton.js";
import { CapabilitiesMenu } from "./composer/CapabilitiesMenu.js";
import { explicitCapabilityCount } from "./composer/capabilitySelectionView.js";
import { AddMenu } from "./composer/ComposerMenus.js";
import { ModelPickerMenu } from "./composer/ModelPickerMenu.js";
import { thinkingLabel } from "./composer/composerLabels.js";
import { Icon } from "./Icon.js";
import { ProviderBrandGlyph } from "./ProviderBrandGlyph.js";
import { SendOrStopButton } from "./composer/SendOrStopButton.js";
import { useBreathingCaret } from "./composer/useBreathingCaret.js";
import { useTypedPlaceholder } from "./composer/useTypedPlaceholder.js";
import { isSkillSlashCommand, normalizeSkillSlashCommand } from "./composer/desktopSlashCommands.js";
import { createDesktopSlashTrigger } from "./composer/desktopSlashTrigger.js";

export type ComposerMemoryState = "unknown" | "enabled" | "disabled";

interface ComposerProps {
  project?: DesktopProject;
  runtimeInfo?: AgentSessionInfo;
  models: ModelChoice[];
  /** 已解析好的上下文用量；取不到真实数字时为空，此时不展示用量。 */
  contextUsage?: ContextUsage;
  memoryState: ComposerMemoryState;
  memoryToggleBusy: boolean;
  memoryToggleDisabled: boolean;
  memoryToggleDisabledReason?: string;
  running: boolean;
  runtimeBusy: boolean;
  resourceState?: "loading" | "ready" | "degraded";
  sessionWriterConflict: boolean;
  modelSetupRequired: boolean;
  focusToken: number;
  prefillInput?: string;
  /** 建议 pill 直达提交：nonce 变化时以该文本走统一提交路径（首页 pill 点击即发送）。 */
  submitDraft?: { text: string; nonce: number };
  /** submitDraft 被领取后回调清掉源头——draft 是单次信号，不清的话 Composer 每次重挂载（过场落地、新建任务回首页）都会把旧草稿再发一遍。 */
  onSubmitDraftConsumed?(): void;
  capabilityDefaults: DesktopCapabilityDefaults;
  skills: DesktopSkillCatalogEntry[];
  toolCatalog: DesktopToolCatalogEntry[];
  onSend(input: string, mode: InteractiveAgentRunMode, attachments: DesktopAttachment[], delivery?: "steer" | "followUp", idempotencyKey?: string, capabilitySelection?: AgentCapabilitySelection): Promise<void>;
  /** 正在编辑的历史消息；nonce 变化时把 value 回填进输入框并聚焦（Alma 式编辑）。 */
  editingMessage?: { nonce: number; value: string };
  /** 提交编辑：原位替换该消息并重新生成回复。 */
  onSubmitEdit(input: string): Promise<void>;
  /** 取消编辑（横幅 X / 退出编辑态）。 */
  onCancelEdit(): void;
  onSlashCommand(command: string): Promise<void>;
  onExpandSkillCommand(input: string): Promise<string>;
  onStop(): Promise<void>;
  onToggleMemory(): Promise<void>;
  onSwitchModel(alias: string, thinking: ThinkingSelection): Promise<void>;
  onSaveAttachment(file: File): Promise<DesktopAttachment>;
  /** 打开 MCP 设置页（能力菜单的 MCP 区跳转入口）。 */
  onOpenMcpSettings?(): void;
  /** 重新拉取工具目录与技能目录（能力菜单的刷新入口）。 */
  onRefreshCatalog?(): void;
  onWarning(message: string): void;
}

type ComposerMenu = "model" | "add" | "capabilities" | null;
type PendingModelSelection = { alias: string; thinking: ThinkingSelection };

const MAX_COMPOSER_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

function selectionFromDefaults(defaults: DesktopCapabilityDefaults): AgentCapabilitySelection {
  return {
    tools: defaults.tools === "none" ? [] : defaults.tools,
    skills: defaults.skills === "none" ? [] : defaults.skills
  };
}

export const Composer = memo(function Composer({
  project,
  runtimeInfo,
  models,
  contextUsage,
  memoryState,
  memoryToggleBusy,
  memoryToggleDisabled,
  memoryToggleDisabledReason,
  running,
  runtimeBusy,
  resourceState,
  sessionWriterConflict,
  modelSetupRequired,
  focusToken,
  prefillInput,
  submitDraft,
  onSubmitDraftConsumed,
  capabilityDefaults,
  skills,
  toolCatalog,
  onSend,
  editingMessage,
  onSubmitEdit,
  onCancelEdit,
  onSlashCommand,
  onExpandSkillCommand,
  onStop,
  onToggleMemory,
  onSwitchModel,
  onSaveAttachment,
  onOpenMcpSettings,
  onRefreshCatalog,
  onWarning
}: ComposerProps): React.JSX.Element {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<InteractiveAgentRunMode>("chat");
  const [attachments, setAttachments] = useState<DesktopAttachment[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [capabilitySelection, setCapabilitySelection] = useState<AgentCapabilitySelection>(() => selectionFromDefaults(capabilityDefaults));
  const [menu, setMenu] = useState<ComposerMenu>(null);
  const [busy, setBusy] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [optimisticModel, setOptimisticModel] = useState<PendingModelSelection>();
  const inputRef = useRef<ChatComposerInputHandle>(null);
  const editorWrapRef = useRef<HTMLDivElement>(null);
  const breathingCaretRef = useRef<HTMLDivElement>(null);
  useBreathingCaret(editorWrapRef, breathingCaretRef);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addAnchorRef = useRef<HTMLDivElement>(null);
  const capabilityAnchorRef = useRef<HTMLDivElement>(null);
  const modelAnchorRef = useRef<HTMLDivElement>(null);
  const modelSwitchQueueRef = useRef<Promise<void>>(Promise.resolve());
  const modelSwitchPromiseRef = useRef<Promise<void> | undefined>(undefined);
  const modelSwitchRequestRef = useRef(0);
  const submitFlightRef = useRef(false);
  const defaultToolSelection = capabilityDefaults.tools;
  const defaultSkillSelection = capabilityDefaults.skills;

  useEffect(() => {
    modelSwitchRequestRef.current += 1;
    setOptimisticModel(undefined);
    modelSwitchPromiseRef.current = undefined;
    modelSwitchQueueRef.current = Promise.resolve();
    setInput("");
    setAttachments([]);
    setPendingAttachments([]);
    setMode("chat");
    setCapabilitySelection(selectionFromDefaults({ tools: defaultToolSelection, skills: defaultSkillSelection }));
    setMenu(null);
  }, [defaultSkillSelection, defaultToolSelection, project?.id]);

  useEffect(() => {
    if (focusToken) inputRef.current?.focus();
  }, [focusToken]);

  useEffect(() => {
    if (prefillInput === undefined) return;
    setInput(prefillInput);
    inputRef.current?.focus();
  }, [prefillInput]);

  // 编辑模式：横幅常驻 + 新的编辑请求（nonce）到达时回填一次文本并聚焦。
  const editing = editingMessage !== undefined;
  const editNonce = editingMessage?.nonce;
  useEffect(() => {
    if (editNonce === undefined) return;
    setInput(editingMessage?.value ?? "");
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只对新的编辑请求响应，回填取当帧闭包
  }, [editNonce]);

  useEffect(() => {
    if (!running) setStopPending(false);
  }, [running]);

  useEffect(() => {
    if (!menu) return;
    const isInsideOpenMenu = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false;
      if (target.closest(".composer-popover")) return true;
      return Boolean(target.closest(`[data-composer-menu="${menu}"]`));
    };
    const close = (event: PointerEvent): void => {
      if (!isInsideOpenMenu(event.target)) setMenu(null);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [menu]);

  const desktopSlashTriggers = useMemo(() => [createDesktopSlashTrigger(skills)], [skills]);

  const runSlash = async (command: string): Promise<void> => {
    if (!project || busy) return;
    setInput("");
    setBusy(true);
    try {
      await onSlashCommand(command);
    } catch (slashError) {
      setInput(command);
      onWarning(errorMessage(slashError));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (delivery?: "steer" | "followUp", submittedInput = input): Promise<void> => {
    const value = submittedInput.trim() || (attachments.length ? "请分析这些附件。" : "");
    if (!project || !value || busy || submitFlightRef.current || sessionWriterConflict) return;
    // 编辑模式：提交直接走「替换原消息并重新生成」，不携带附件，也不走模型切换/斜杠命令链路。
    if (editing) {
      submitFlightRef.current = true;
      setBusy(true);
      try {
        setInput("");
        await onSubmitEdit(value);
      } catch (submitError) {
        setInput(value);
        onWarning(errorMessage(submitError));
      } finally {
        setBusy(false);
        submitFlightRef.current = false;
      }
      return;
    }
    if (pendingAttachments.length || memoryToggleBusy) return;
    submitFlightRef.current = true;
    try {
      const pendingModelSwitch = modelSwitchPromiseRef.current;
      if (pendingModelSwitch) {
        // 斜杠命令也应看到已确认的 Runtime 状态；否则紧接着执行 `/status` 或再次切模
        // 时，命令可能与上一轮切换并发竞争。
        try {
          await pendingModelSwitch;
        } catch {
          // startModelSwitch 已提示具体错误；保留输入，避免继续操作旧模型。
          return;
        }
      }
      const [slashName] = value.split(/\s+/, 1);
      const slashCommand = DESKTOP_SLASH_COMMANDS.find((command) => command.name === slashName);
      if (slashCommand && (value === slashCommand.name || slashCommand.acceptsArgs)) {
        await runSlash(value);
        return;
      }
      if (sessionWriterConflict) return;
      const sentAttachments = attachments;
      setBusy(true);
      try {
        const sendValue = isSkillSlashCommand(value)
          ? await onExpandSkillCommand(normalizeSkillSlashCommand(value))
          : value;
        // 模型标签已经即时更新，但真正的 Runtime 切换仍需完成后才能发送，
        // 否则用户紧接着按 Enter 时可能把消息发给旧模型。
        setInput("");
        setAttachments([]);
        await onSend(sendValue, mode, sentAttachments, delivery, globalThis.crypto.randomUUID(), capabilitySelection);
      } catch (submitError) {
        setInput(value);
        setAttachments(sentAttachments);
        onWarning(errorMessage(submitError));
      } finally {
        setBusy(false);
      }
    } finally {
      submitFlightRef.current = false;
    }
  };

  // 建议 pill 直达提交：nonce 每次自增，文本走与手动输入完全相同的提交路径。
  // 先领走再提交：draft 是单次信号，App 侧不清掉的话每次重挂载都会重复发送。
  useEffect(() => {
    if (!submitDraft) return;
    onSubmitDraftConsumed?.();
    void submit(undefined, submitDraft.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只对 nonce 变化响应，submit 取当帧闭包
  }, [submitDraft]);

  const addFiles = async (files: File[]): Promise<void> => {
    if (!project || !files.length || busy || submitFlightRef.current || running || sessionWriterConflict) return;
    setBusy(true);
    try {
      const existing = new Set([
        ...attachments.map((attachment) => `${attachment.name}:${String(attachment.size)}:${attachment.mimeType}`),
        ...pendingAttachments.map((attachment) => `${attachment.name}:${String(attachment.size)}:${attachment.mimeType}`)
      ]);
      const incoming: File[] = [];
      for (const file of files) {
        if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} 超过 50 MB。`);
        const key = `${file.name}:${String(file.size)}:${file.type}`;
        if (existing.has(key) || incoming.some((item) => `${item.name}:${String(item.size)}:${item.type}` === key)) {
          throw new Error(`${file.name} 已经添加。`);
        }
        incoming.push(file);
      }
      if (attachments.length + pendingAttachments.length + incoming.length > MAX_COMPOSER_ATTACHMENTS) {
        throw new Error(`最多添加 ${String(MAX_COMPOSER_ATTACHMENTS)} 个附件。`);
      }
      const uploadItems = incoming.map((file, index) => ({
        file,
        pending: {
          id: `${String(Date.now())}-${String(index)}-${file.name}`,
          mimeType: file.type,
          name: file.name,
          size: file.size,
          status: "uploading" as const
        }
      }));
      setPendingAttachments((current) => [...current, ...uploadItems.map((item) => item.pending)]);
      const results = await Promise.all(uploadItems.map(async ({ file, pending }) => {
        try {
          const saved = await onSaveAttachment(file);
          setPendingAttachments((current) => current.filter((item) => item.id !== pending.id));
          return { pending, saved };
        } catch (uploadError) {
          const message = errorMessage(uploadError);
          setPendingAttachments((current) => current.map((item) => item.id === pending.id ? { ...item, error: message, status: "error" } : item));
          return { error: message, pending };
        }
      }));
      const saved = results.flatMap((result): DesktopAttachment[] => {
        const uploaded = "saved" in result ? result.saved : undefined;
        return uploaded ? [uploaded] : [];
      });
      if (saved.length) setAttachments((current) => [...current, ...saved].slice(0, MAX_COMPOSER_ATTACHMENTS));
      const failed = results.flatMap((result) => "error" in result ? [result.error] : []);
      if (failed.length) onWarning(failed.join("；"));
    } catch (attachmentError) {
      onWarning(errorMessage(attachmentError));
    } finally {
      setBusy(false);
    }
  };

  const requestStop = async (): Promise<void> => {
    setStopPending(true);
    try {
      await onStop();
    } catch (stopError) {
      setStopPending(false);
      onWarning(errorMessage(stopError));
    }
  };

  const activeModel = models.find((model) => model.alias === (optimisticModel?.alias ?? runtimeInfo?.modelAlias));
  const selectedModel = activeModel ?? models[0];
  const currentAlias = activeModel?.alias ?? selectedModel?.alias;
  const runtimeThinking = optimisticModel?.thinking ?? runtimeInfo?.thinking ?? selectedModel?.defaultThinking ?? "off";
  const thinkingLevels: ThinkingSelection[] = selectedModel ? modelThinkingSelections(selectedModel) : [];
  const currentThinking = selectedModel
    ? thinkingSelectionForModel(runtimeThinking, selectedModel)
    : undefined;
  const thinkingAvailable = Boolean(currentThinking && thinkingLevels.length);
  const selectedModelCatalog = selectedModel
    ? catalogForConnection(
      { provider: selectedModel.provider, providerType: selectedModel.providerType },
      selectedModel.baseUrl
    )
    : undefined;
  const toolsSupported = selectedModel?.supportsTools !== false;
  const modelName = selectedModel?.displayName ?? runtimeInfo?.modelLabel ?? "未配置模型";
  const startModelSwitch = (alias: string, thinking: ThinkingSelection): void => {
    const requestId = modelSwitchRequestRef.current + 1;
    modelSwitchRequestRef.current = requestId;
    setOptimisticModel({ alias, thinking });
    const request = modelSwitchQueueRef.current
      .catch(() => undefined)
      .then(async () => await onSwitchModel(alias, thinking));
    modelSwitchQueueRef.current = request.catch(() => undefined);
    modelSwitchPromiseRef.current = request;
    void request.then(
      () => {
        if (modelSwitchRequestRef.current !== requestId) return;
        modelSwitchPromiseRef.current = undefined;
        setOptimisticModel(undefined);
      },
      (modelError) => {
        if (modelSwitchRequestRef.current !== requestId) return;
        modelSwitchPromiseRef.current = undefined;
        setOptimisticModel(undefined);
        onWarning(errorMessage(modelError));
      }
    );
  };
  const chooseModel = (alias: string): void => {
    const nextModel = models.find((model) => model.alias === alias);
    if (!nextModel) return;
    const nextThinking = nextModel.efforts.length ? nextModel.defaultThinking : "off";
    // 选中模型后保留模型设置面板，用户可以继续悬停“推理强度”选择档位。
    startModelSwitch(alias, nextThinking);
  };
  const usage = formatContextUsage(contextUsage);
  const inputDisabled = sessionWriterConflict || busy;
  const attachmentCount = attachments.length + pendingAttachments.length;
  const sendDisabled = memoryToggleBusy || (running
    ? false
    : resourceState === "loading"
      || (!input.trim() && !attachments.length) || !project || sessionWriterConflict || modelSetupRequired || busy || pendingAttachments.length > 0);
  const sendDisabledReason = !project
    ? "请先打开一个项目。"
      : modelSetupRequired
        ? "还没有可用的模型连接，请先配置模型。"
        : resourceState === "loading"
          ? "正在准备 MCP / Skill 能力，请稍候再发送。"
        : memoryToggleBusy
          ? "正在确认当前聊天的记忆状态，请稍候。"
        : sessionWriterConflict
          ? "会话已在另一个应用中打开，请先在那里关闭后重试。"
        : busy
          ? "当前附件或命令正在处理，请稍候。"
          : pendingAttachments.length
            ? "请等待附件处理完成，或移除失败附件。"
          : !input.trim() && !attachments.length
            ? "输入消息或添加附件后发送。"
            : undefined;
  const placeholder = running ? "可以继续补充要求…" : "随便说点什么…";
  // 空输入时 placeholder 逐字打出，让输入框保持「活」的感觉
  const typedPlaceholder = useTypedPlaceholder(placeholder, input.trim().length === 0);
  const modelSwitchPending = Boolean(optimisticModel);
  const modelSwitchDisabled = sessionWriterConflict || running || runtimeBusy || busy;
  const modelSwitchDisabledReason = !project
    ? "请先打开一个项目。"
    : sessionWriterConflict
      ? "会话已在另一个应用中打开。"
      : running
        ? "当前对话正在运行，等结束后再切换模型。"
        : runtimeBusy
          ? "Runtime 正在处理其他操作，请稍候再切换模型。"
        : busy
          ? "当前附件或命令正在处理，请稍候。"
          : undefined;
  const capabilitySwitchDisabled = !project || running || runtimeBusy || busy || sessionWriterConflict;
  const capabilitySwitchDisabledReason = !project
    ? "请先打开一个项目。"
    : sessionWriterConflict
      ? "会话已在另一个应用中打开。"
      : running
        ? "当前对话正在运行，请等待结束后再选择能力。"
        : runtimeBusy
          ? "Runtime 正在处理其他操作，请稍候再选择能力。"
          : busy
            ? "当前附件或命令正在处理，请稍候。"
            : undefined;
  useEffect(() => {
    if (capabilitySwitchDisabled && menu === "capabilities") setMenu(null);
  }, [capabilitySwitchDisabled, menu]);

  const handleInputChange = (value: string): void => {
    setInput(value);
  };

  return (
    <div
      className={`composer-container biny-composer-frame${running ? " is-running" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        void addFiles([...event.dataTransfer.files]);
      }}
    >
      {editing ? (
        <div className="composer-edit-banner" role="status">
          <Icon name="edit" size={13} />
          <span>正在编辑历史消息，发送后替换原消息并重新生成回复</span>
          <button
            aria-label="取消编辑"
            onClick={() => {
              setInput("");
              onCancelEdit();
            }}
            title="取消编辑"
            type="button"
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      ) : null}
      <ChatComposer
        className={`biny-composer${running ? " is-running" : ""}`}
        density="compact"
        drawer={attachmentCount ? (
          <ChatComposerDrawer count={attachmentCount} label="附件">
            <AttachmentList
              attachments={attachments}
              onRemove={(index) => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
              onRemovePending={(id) => setPendingAttachments((current) => current.filter((attachment) => attachment.id !== id))}
              pending={pendingAttachments}
            />
          </ChatComposerDrawer>
        ) : undefined}
        footerActions={(
          <div className="biny-composer-footer-start">
            <input
              hidden
              multiple
              onChange={(event) => {
                void addFiles([...(event.target.files ?? [])]);
                event.target.value = "";
              }}
              ref={fileInputRef}
              type="file"
            />
            <div className="composer-menu-anchor" ref={addAnchorRef}>
              <ComposerActionButton
                aria-expanded={menu === "add"}
                aria-haspopup="menu"
                className="biny-composer-add"
                data-composer-menu="add"
                disabled={!project || busy || running}
                disabledReason={!project ? "请先打开一个项目。" : running ? "当前对话正在运行，请等待结束后再添加附件。" : busy ? "当前附件或命令正在处理，请稍候。" : undefined}
                label="添加附件"
                onClick={() => setMenu(menu === "add" ? null : "add")}
                tooltip="添加文件或目录"
              >
                <Icon name="add" size={15} />
              </ComposerActionButton>
              <AddMenu
                anchorRef={addAnchorRef}
                onPickFiles={() => {
                  setMenu(null);
                  fileInputRef.current?.click();
                }}
                open={menu === "add"}
              />
            </div>
            {/* 规划模式激活后显示为可退出的模式 pill。 */}
            {mode === "plan" ? (
              <ComposerActionButton
                active
                className="biny-plan-pill"
                label="退出规划模式"
                onClick={() => setMode("chat")}
                tooltip="规划模式已启用，点击关闭"
              >
                <Icon name="chart" size={13} />
                <span>规划</span>
              </ComposerActionButton>
            ) : null}
            <div className="composer-menu-anchor" ref={capabilityAnchorRef}>
              <ComposerActionButton
                active={menu === "capabilities"}
                aria-expanded={menu === "capabilities"}
                aria-haspopup="dialog"
                className="biny-capabilities-pill"
                data-composer-menu="capabilities"
                disabled={capabilitySwitchDisabled}
                disabledReason={capabilitySwitchDisabledReason}
                label="能力"
                onClick={() => setMenu(menu === "capabilities" ? null : "capabilities")}
                tooltip={menu === "capabilities" ? undefined : "能力：选择本条消息可用的工具、Skill 与规划模式"}
              >
                <Icon name="sliders" size={15} />
                {/* 有显式选择时展示数量，auto / all 不计数，保持图标简洁。 */}
                {explicitCapabilityCount(capabilitySelection) > 0 ? <span className="biny-capabilities-count">{explicitCapabilityCount(capabilitySelection)}</span> : null}
              </ComposerActionButton>
              <CapabilitiesMenu
                anchorRef={capabilityAnchorRef}
                onChange={setCapabilitySelection}
                onOpenMcpSettings={onOpenMcpSettings}
                onRefreshCatalog={onRefreshCatalog}
                onWarning={onWarning}
                open={menu === "capabilities"}
                onPlanModeChange={(active) => setMode(active ? "plan" : "chat")}
                planActive={mode === "plan"}
                projectId={project?.id}
                selection={capabilitySelection}
                skills={skills}
                tools={toolCatalog}
                toolsSupported={toolsSupported}
              />
            </div>
            <div className="composer-menu-anchor" ref={modelAnchorRef}>
              <ComposerActionButton
                className="biny-model-pill"
                data-composer-menu="model"
                disabled={modelSwitchDisabled}
                disabledReason={modelSwitchDisabledReason}
                loading={modelSwitchPending}
                active={menu === "model"}
                aria-expanded={menu === "model"}
                aria-haspopup="menu"
                label={thinkingAvailable && currentThinking ? `${modelName} · ${thinkingLabel(currentThinking)}` : modelName}
                onClick={() => setMenu(menu === "model" ? null : "model")}
                tooltip={menu === "model" ? undefined : "模型与推理强度"}
              >
                {selectedModel ? <span className="model-trigger-brand"><ProviderBrandGlyph type={selectedModelCatalog?.iconTone ?? selectedModel.providerType} /></span> : null}
                <span>{modelName}</span>
                {thinkingAvailable && currentThinking ? <span className="model-trigger-thinking">{thinkingLabel(currentThinking)}</span> : null}
                <Icon name="chevron" size={11} />
              </ComposerActionButton>
              <ModelPickerMenu
                anchorRef={modelAnchorRef}
                currentAlias={currentAlias}
                currentModelName={modelName}
                currentThinking={currentThinking}
                models={models}
                onClose={() => setMenu(null)}
                onSelectModel={chooseModel}
                onSelectThinking={(thinking) => {
                  setMenu(null);
                  if (currentAlias) startModelSwitch(currentAlias, thinking);
                }}
                open={menu === "model"}
                thinkingLevels={thinkingLevels}
              />
            </div>
          </div>
        )}
        input={(
          <div className="biny-composer-editor" ref={editorWrapRef}>
            <ChatComposerInput
              className="biny-composer-input"
              debounceMs={0}
              handleRef={inputRef}
              label="任务输入"
              maxRows={6}
              onFiles={(files) => void addFiles(files)}
              onKeyDown={(event) => {
                // trigger 菜单会先消费 ↑↓/Enter/Tab/Escape；这里只接管运行中的
                // Cmd/Ctrl+Enter，其余 Enter 交给 ChatComposerInput 的提交逻辑。
                if (event.key !== "Enter" || event.shiftKey || event.altKey || event.nativeEvent.isComposing) return;
                if (running && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit("steer");
                }
              }}
              triggers={desktopSlashTriggers}
            />
            <div ref={breathingCaretRef} className="biny-breathing-caret" aria-hidden="true" />
          </div>
        )}
        isDisabled={inputDisabled}
        onChange={handleInputChange}
        onSubmit={(value) => void submit(undefined, value)}
        placeholder={typedPlaceholder}
        status={running && input.trim()
          ? { message: "按 Enter 将补充要求排入当前会话；⌘ Enter 立即转向", type: "warning" }
          : resourceState === "loading"
            ? { message: "正在准备 MCP / Skill 能力，输入会保留在编辑框中。", type: "warning" }
            : resourceState === "degraded"
              ? { message: "部分 MCP / Skill 能力不可用，普通对话仍可发送。", type: "warning" }
              : undefined}
        statusPosition="bottom"
        sendActions={(
          <div className="biny-composer-footer-end">
            <div className="composer-menu-anchor">
              <ComposerActionButton
                aria-pressed={memoryState === "unknown" ? undefined : memoryState === "enabled"}
                className="biny-memory-toggle"
                data-memory-enabled={memoryState === "unknown" ? undefined : memoryState === "enabled" ? "true" : "false"}
                disabled={memoryToggleDisabled}
                disabledReason={memoryToggleDisabledReason}
                label={memoryState === "unknown"
                  ? "当前聊天记忆状态确认中"
                  : memoryState === "enabled" ? "关闭当前聊天记忆" : "开启当前聊天记忆"}
                loading={memoryToggleBusy}
                onClick={() => { void onToggleMemory(); }}
                tooltip={memoryState === "unknown"
                  ? undefined
                  : memoryState === "enabled" ? "当前聊天会使用记忆 - 点击关闭" : "当前聊天未使用记忆 - 点击开启"}
              >
                <Icon name={memoryState === "unknown" ? "brain" : memoryState === "enabled" ? "brain-spark" : "brain-off"} size={20} />
              </ComposerActionButton>
            </div>
            {usage ? (
              <span className="context-usage" role="status">
                <Icon name="timer" size={12} /><span>{usage.percent}%</span>
                <span className="context-usage-tip">
                  <span>上下文使用量</span>
                  <strong>{usage.percent}% 已占用</strong>
                  <strong>{usage.used} / {usage.max} tokens</strong>
                  {usage.reserved ? (
                    <span>模型窗口 {usage.window}，其中 {usage.reserved} 为输出等预留</span>
                  ) : null}
                </span>
              </span>
            ) : null}
          </div>
        )}
        sendButton={(
          <SendOrStopButton
            disabled={sendDisabled}
            disabledReason={sendDisabledReason}
            onSend={() => void submit()}
            onStop={() => void requestStop()}
            running={running}
            stopPending={stopPending}
          />
        )}
        value={input}
      />
    </div>
  );
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
