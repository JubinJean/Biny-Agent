/** 回复顶部的能力清单：优先展示本轮预选结果，旧会话保留真实调用记录。 */
import React, { memo, useEffect, useId, useRef, useState } from "react";
import type { AgentCapabilitySelection } from "../../../../../agent/capabilitySelection.js";
import { executionToolLabel, type TimelineTool } from "../../sessionTimeline.js";
import { Icon, type IconName } from "../Icon.js";
import { ComposerPopover } from "../composer/ComposerPopover.js";

export const SkillsIndicator = memo(function SkillsIndicator({ skills, tools, memoryInjectedCount, selection, skillNames }: {
  skills: string[];
  tools: TimelineTool[];
  memoryInjectedCount?: number;
  selection?: AgentCapabilitySelection;
  skillNames?: ReadonlyMap<string, string>;
}): React.JSX.Element | null {
  const selectedTools = Array.isArray(selection?.tools) ? selection.tools : selection?.tools === "none" ? [] : undefined;
  const selectedSkills = Array.isArray(selection?.skills) ? selection.skills : selection?.skills === "none" ? [] : undefined;
  const groups = [
    { kind: "tools", icon: "wrench" as const, label: "工具", selected: selectedTools !== undefined, names: [...new Set(selectedTools ?? tools.map((tool) => tool.tool))].map(executionToolLabel) },
    { kind: "skills", icon: "wand" as const, label: "技能", selected: selectedSkills !== undefined, names: [...new Set(selectedSkills ?? skills)].map((name) => skillNames?.get(name) ?? name) }
  ].filter((group) => group.names.length > 0);
  if (!memoryInjectedCount && groups.length === 0) return null;
  return (
    <div className="chat-meta-indicator">
      {memoryInjectedCount ? <span><Icon name="brain" size={12} /> 已注入 {String(memoryInjectedCount)} 条记忆</span> : null}
      {groups.map((group) => (
        <CapabilityIndicator icon={group.icon} key={group.kind} label={group.label} names={group.names} selected={group.selected} />
      ))}
    </div>
  );
});

/** 复用现有锚点浮层，越过消息裁剪边界；悬停、点击和键盘聚焦都能查看清单。 */
function CapabilityIndicator({ icon, label, names, selected }: { icon: IconName; label: string; names: string[]; selected: boolean }): React.JSX.Element {
  const id = useId();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const keepOpen = (): void => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const closeSoon = (): void => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 160);
  };
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  return (
    <>
      <button aria-describedby={open ? id : undefined} aria-expanded={open} className="chat-meta-trigger" onBlur={closeSoon} onClick={keepOpen} onFocus={keepOpen} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }} onPointerEnter={keepOpen} onPointerLeave={closeSoon} ref={anchorRef} type="button">
        <Icon name={icon} size={14} /><span>{String(names.length)} 个{label}</span>
      </button>
      {open ? (
        <ComposerPopover anchorRef={anchorRef} className="chat-meta-tooltip" onPointerEnter={keepOpen} onPointerLeave={closeSoon} phase="open">
          <div id={id} role="tooltip">
            <div className="chat-meta-tooltip-title">{selected ? "本轮选择的" : "已调用的"}{label}：</div>
            {names.length ? <ul className="chat-meta-tooltip-list">{names.map((name, index) => <li key={`${String(index)}-${name}`}>{name}</li>)}</ul> : <div>本轮未选择{label}</div>}
          </div>
        </ComposerPopover>
      ) : null}
    </>
  );
}
