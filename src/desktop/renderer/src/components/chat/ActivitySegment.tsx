/**
 * 活动段：连续「思考 + 工具」步骤的聚合展示（对齐 alma 的 ActivitySegment）。
 *
 * 头部是相位头像串（思考/探索/修改/运行/通用五类，24px 圆形图标，重叠堆叠）+ 摘要文案 +
 * 展开控件；落定后默认收起，摘要报「用了 N 个工具」或纯思考的「已思考 N 秒」；
 * 运行中最后一个未落定相位呼吸 + 微光展示实时动宾（「探索中 3 个文件」）。
 *
 * 展开体是左导轨分相列表：默认「时间线模式」平铺所有相位；点单个头像只看该相位。
 * 工具行是动宾紧凑行（读取 xx / 编辑 xx +3 -2），点击行内展开完整工具详情；
 * 思考相位直接平铺思考文本。待授权的工具强制展开行详情。
 *
 * 展开策略：待授权自动进入该相位；手动开合覆盖到运行态翻转为止；全部落定后收起。
 */
import React, { memo, useEffect, useMemo, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import type { PermissionResult } from "../../../../../permission/PermissionManager.js";
import {
  activityToolRow,
  buildActivityPhases,
  countActivityUnits,
  phaseLabel,
  phaseSettled,
  phaseThinkingSeconds,
  type ActivityPhase,
  type ActivityPhaseItem,
  type ActivityPhaseKind,
} from "../../chatModel.js";
import type { IconName } from "../Icon.js";
import { reasoningDetailText } from "../../reasoningPresentation.js";
import type { TimelineReasoningStep, TimelineTool, TimelineToolStep } from "../../sessionTimeline.js";
import { Icon } from "../Icon.js";
import { ToolActivityDetail } from "../ToolActivity.js";
import { Collapse } from "../Collapse.js";

/** 可进活动段的步骤：工具调用或思考相位。 */
export type ActivitySegmentStep = TimelineToolStep | TimelineReasoningStep;

const PHASE_ICONS: Record<ActivityPhaseKind, IconName> = {
  thinking: "brain",
  exploring: "search",
  making: "edit",
  running: "terminal",
  generic: "wrench",
};

/** 头像串最多直显的相位数，超出的折叠成「+N」。 */
const MAX_VISIBLE_PHASES = 8;

interface ActivitySegmentProps {
  /** 连续的思考 + 工具步骤（单个也走活动段，呈现为一枚头像 + 一行摘要）。 */
  steps: ActivitySegmentStep[];
  /** 轮次是否在运行（驱动活体态：呼吸头像 + shimmer 标签 + 收尾 orb）。 */
  running: boolean;
  /** 轮次级思考耗时（秒）；段内思考相位缺失时长时的兜底。 */
  thinkingSeconds?: number;
  projectId: string;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
}

export const ActivitySegment = memo(function ActivitySegment({
  steps,
  running,
  thinkingSeconds,
  projectId,
  onPreviewFile,
  onOpenExternal,
  onResolvePermission,
}: ActivitySegmentProps): React.JSX.Element | null {
  const items: ActivityPhaseItem[] = useMemo(
    () => steps.map((step, index) => ({ step, index })),
    [steps]
  );
  const phases = useMemo(() => buildActivityPhases(items), [items]);
  const segmentKey = steps[0]?.id ?? "activity";
  const toolSteps = useMemo(
    () => steps.filter((step): step is Extract<ActivitySegmentStep, { kind: "tool" }> => step.kind === "tool"),
    [steps]
  );
  const allThinking = phases.length > 0 && phases.every((phase) => phase.kind === "thinking");
  const thinkingPhaseCount = phases.filter((phase) => phase.kind === "thinking").length;
  const secondsForThinkingPhase = (phase: ActivityPhase): number | undefined =>
    phaseThinkingSeconds(phase) ?? (thinkingPhaseCount === 1 ? thinkingSeconds : undefined);

  // 待授权的工具强制展开其行详情，并自动进入所在相位。
  const forcedToolIds = useMemo(() => {
    const ids = new Set<string>();
    for (const tool of toolSteps.map((step) => step.tool)) {
      if (tool.permission && !tool.permission.resolved) ids.add(tool.id);
    }
    return ids;
  }, [toolSteps]);
  const pendingPhaseIndex = forcedToolIds.size > 0
    ? phases.findIndex((phase) => phase.items.some(({ step }) => step.kind === "tool" && step.tool.permission && !step.tool.permission.resolved))
    : -1;

  // selection：null = 收起；数字 = 只看该相位。timeline = 时间线模式（平铺全部相位）。
  // 手动开合以「运行态 + 待授权」为 key，状态翻转后自动策略重新接管。
  const autoKey = `${String(running)}:${String(forcedToolIds.size > 0)}`;
  const [manual, setManual] = useState<{ key: string; open: boolean; timeline: boolean; phase: number | null }>();
  const autoOpen = forcedToolIds.size > 0 && pendingPhaseIndex >= 0;
  const manualActive = manual?.key === autoKey;
  const railOpen = manualActive ? manual.open : autoOpen;
  const timelineMode = manualActive ? manual.timeline : true;
  const selectedPhase = manualActive ? manual.phase : autoOpen ? pendingPhaseIndex : null;

  const close = (): void => setManual({ key: autoKey, open: false, timeline: false, phase: null });
  const openTimeline = (): void => setManual({ key: autoKey, open: true, timeline: true, phase: null });
  const openPhase = (index: number): void => setManual({ key: autoKey, open: true, timeline: false, phase: index });

  if (phases.length === 0) return null;

  const lastIndex = phases.length - 1;
  const livePhaseActive = running && !phaseSettled(phases[lastIndex]!);
  const openPhaseOrNull = selectedPhase !== null && selectedPhase >= 0 ? phases[selectedPhase] : null;
  const units = countActivityUnits(phases);
  const hiddenCount = Math.max(0, phases.length - MAX_VISIBLE_PHASES);

  // 摘要文案：活体展示最后相位的实时动宾（探索中 3 个文件）；纯思考段报「已思考 N 秒」；
  // 落定后默认报活动单元数；点了单个相位时头部跟随该相位的摘要。
  const livePhase = phases[lastIndex]!;
  const liveLabel = phaseLabel(livePhase, true, secondsForThinkingPhase(livePhase));
  const pureThinkingSeconds = allThinking ? secondsForThinkingPhase(phases[0]!) : undefined;
  const headerLabel = !running && openPhaseOrNull && !allThinking && !timelineMode
    ? phaseLabel(openPhaseOrNull, false, secondsForThinkingPhase(openPhaseOrNull))
    : null;

  return (
    <section className={`chat-activity${railOpen ? " is-open" : ""}`} data-running={running || undefined}>
      <div className="chat-activity-header">
        <div className="chat-activity-avatars">
          {hiddenCount > 0 ? (
            <button
              aria-label={`${String(hiddenCount)} 个更早阶段`}
              className="chat-phase-avatar is-overflow"
              onClick={openTimeline}
              title={`${String(hiddenCount)} 个更早阶段`}
              type="button"
            >+{String(hiddenCount)}</button>
          ) : null}
          {phases.slice(hiddenCount).map((phase, visibleIndex) => {
            const index = hiddenCount + visibleIndex;
            const isOpen = selectedPhase === index;
            const isAlive = running && index === lastIndex && livePhaseActive;
            return (
              <button
                aria-label={phaseLabel(phase, false).verb}
                className={`chat-phase-avatar${isOpen ? " is-active" : ""}${isAlive ? " is-alive" : ""}`}
                disabled={running}
                key={`${segmentKey}-avatar-${String(index)}`}
                onClick={() => openPhase(index)}
                style={phases.length > 1 ? { marginLeft: visibleIndex === 0 && hiddenCount === 0 ? 0 : -7, zIndex: isOpen ? 50 : visibleIndex + 1 } : undefined}
                type="button"
              >
                <Icon name={PHASE_ICONS[phase.kind]} size={12} />
              </button>
            );
          })}
        </div>
        {running ? (
          <span className="chat-activity-label">
            <span className={`chat-activity-verb${livePhaseActive ? " chat-shimmer-text" : ""}`}>{liveLabel.verb}</span>
            {liveLabel.rest ? <span className="chat-activity-rest"> {liveLabel.rest}</span> : null}
          </span>
        ) : allThinking ? (
          <button className="chat-activity-summary" onClick={() => railOpen ? close() : openTimeline()} type="button">
            <span className="chat-activity-verb">已思考</span>
            {pureThinkingSeconds !== undefined ? <span className="chat-activity-rest"> {String(pureThinkingSeconds)} 秒</span> : null}
          </button>
        ) : (
          <>
            <button
              className="chat-activity-summary"
              onClick={() => railOpen ? close() : openTimeline()}
              title={railOpen ? "收起活动" : "展开活动"}
              type="button"
            >
              {headerLabel ? (
                <>
                  <span className="chat-activity-verb">{headerLabel.verb}</span>
                  {headerLabel.rest ? <span className="chat-activity-rest"> {headerLabel.rest}</span> : null}
                </>
              ) : (
                <span className="chat-activity-verb">用了 {String(units)} 个工具</span>
              )}
            </button>
            {phases.length > 1 ? (
              <button
                aria-label="时间线视图"
                className={`chat-activity-mode${timelineMode && railOpen ? " is-active" : ""}`}
                onClick={() => (railOpen && timelineMode ? close() : setManual({ key: autoKey, open: true, timeline: true, phase: null }))}
                title="时间线视图"
                type="button"
              >
                <Icon name="list-tree" size={14} />
              </button>
            ) : null}
            <button
              aria-expanded={railOpen}
              aria-label={railOpen ? "收起活动" : "展开活动"}
              className="chat-activity-chevron"
              onClick={() => railOpen ? close() : openTimeline()}
              type="button"
            >
              <Icon name="chevron" size={14} />
            </button>
          </>
        )}
      </div>
      <Collapse className="chat-activity-collapse" open={railOpen}>
        <div className="chat-activity-rail">
          {timelineMode || !openPhaseOrNull
            ? phases.map((phase, index) => {
              const thinkingSecondsForPhase = secondsForThinkingPhase(phase);
              const label = phaseLabel(phase, false, thinkingSecondsForPhase);
              return (
                <div className="chat-activity-phase" key={`${segmentKey}-phase-${String(index)}`}>
                  {phase.kind === "thinking" ? (
                    <div className="chat-activity-phase-label">
                      <span className="chat-activity-verb">{label.verb}</span>
                      {label.rest ? <span className="chat-activity-rest"> {label.rest}</span> : null}
                    </div>
                  ) : null}
                  <PhaseBody
                    forcedToolIds={forcedToolIds}
                    onOpenExternal={onOpenExternal}
                    onPreviewFile={onPreviewFile}
                    onResolvePermission={onResolvePermission}
                    phase={phase}
                    projectId={projectId}
                    segmentKey={segmentKey}
                  />
                </div>
              );
            })
            : (
              <PhaseBody
                forcedToolIds={forcedToolIds}
                onOpenExternal={onOpenExternal}
                onPreviewFile={onPreviewFile}
                onResolvePermission={onResolvePermission}
                phase={openPhaseOrNull}
                projectId={projectId}
                segmentKey={segmentKey}
              />
            )}
        </div>
      </Collapse>
      {running && !livePhaseActive ? (
        <div className="chat-activity-orb">
          <ThinkingOrb aria-label="跟进中" className="chat-activity-orb-icon" size={20} state="working" theme="auto" />
          <span className="chat-shimmer-text chat-activity-orb-label">Following the thread</span>
        </div>
      ) : null}
    </section>
  );
});

/** 一个相位的展开体：思考相位平铺文本；工具相位渲染动宾行 + 行内详情。 */
const PhaseBody = memo(function PhaseBody({
  phase,
  segmentKey,
  forcedToolIds,
  projectId,
  onPreviewFile,
  onOpenExternal,
  onResolvePermission,
}: {
  phase: ActivityPhase;
  segmentKey: string;
  forcedToolIds: Set<string>;
  projectId: string;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
}): React.JSX.Element | null {
  if (phase.kind === "thinking") {
    const text = phase.items
      .map(({ step }) => step.kind === "reasoning" ? reasoningDetailText(step) : "")
      .filter(Boolean)
      .join("\n\n");
    if (!text) return null;
    return <div className="chat-activity-thinking">{text}</div>;
  }
  return (
    <>
      {phase.items.map(({ step }) => {
        if (step.kind !== "tool") return null;
        return (
          <ActivityToolRow
            forced={forcedToolIds.has(step.tool.id)}
            key={`${segmentKey}-row-${step.id}`}
            onOpenExternal={onOpenExternal}
            onPreviewFile={onPreviewFile}
            onResolvePermission={onResolvePermission}
            projectId={projectId}
            tool={step.tool}
          />
        );
      })}
    </>
  );
});

/** 轨道里的工具动宾行：动词加重、宾语弱化截断、± 行数、行内展开完整详情。 */
const ActivityToolRow = memo(function ActivityToolRow({
  tool,
  forced,
  projectId,
  onPreviewFile,
  onOpenExternal,
  onResolvePermission,
}: {
  tool: TimelineTool;
  forced: boolean;
  projectId: string;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
}): React.JSX.Element {
  const row = activityToolRow(tool);
  const detailOpenable = !forced;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (forced) setOpen(true);
  }, [forced]);
  const running = row.running;
  return (
    <div className="chat-tool-row-wrap">
      <button
        aria-expanded={open}
        className={`chat-tool-row${open ? " is-open" : ""}`}
        onClick={() => detailOpenable && setOpen((current) => !current)}
        type="button"
      >
        {running ? <span aria-hidden="true" className="chat-tool-run-dot" /> : null}
        {row.error ? <span aria-hidden="true" className="chat-tool-row-error"><Icon name="circle-close" size={12} /></span> : null}
        <span className={`chat-tool-row-verb${row.error ? " is-error" : ""}`}>{row.verb}</span>
        <span className="chat-tool-row-object" title={row.object}>{row.object}</span>
        {row.plus !== undefined && row.plus > 0 ? <span className="chat-tool-row-diff is-add">+{String(row.plus)}</span> : null}
        {row.minus !== undefined && row.minus > 0 ? <span className="chat-tool-row-diff is-del">-{String(row.minus)}</span> : null}
        <span className="chat-tool-row-chevron"><Icon name="chevron" size={14} /></span>
      </button>
      <Collapse className="chat-tool-row-collapse" open={open}>
        <div className="chat-tool-row-detail">
          <ToolActivityDetail
            onOpenExternal={onOpenExternal}
            onPreviewFile={onPreviewFile}
            onResolvePermission={onResolvePermission}
            projectId={projectId}
            tool={tool}
          />
        </div>
      </Collapse>
    </div>
  );
});
