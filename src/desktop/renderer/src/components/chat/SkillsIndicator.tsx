/**
 * 助手消息顶部的技能指示器（对齐 alma 的 autoSelectedSkills 指示）。
 *
 * 一行弱化小字：「✦ N 个技能」，悬停浮出深色气泡列出技能名（「自动选择的技能：」）。
 * 纯 CSS 悬停展开，无 portal：指示器永远在消息顶部，向上浮出不会被裁切。
 */
import React, { memo } from "react";
import { Icon } from "../Icon.js";

export const SkillsIndicator = memo(function SkillsIndicator({ skills }: {
  /** 技能名列表（来自真实 Skill 调用）。 */
  skills: string[];
}): React.JSX.Element | null {
  if (skills.length === 0) return null;
  return (
    <div className="chat-meta-indicator">
      <span className="chat-meta-trigger" tabIndex={0}>
        <Icon name="wand" size={12} />
        <span>{String(skills.length)} 个技能</span>
        <span aria-hidden="true" className="chat-meta-tooltip" role="tooltip">
          <span className="chat-meta-tooltip-title">自动选择的技能：</span>
          <ul className="chat-meta-tooltip-list">
            {skills.map((skill) => <li key={skill}>{skill}</li>)}
          </ul>
        </span>
      </span>
    </div>
  );
});
