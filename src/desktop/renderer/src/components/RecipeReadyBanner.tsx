/**
 * 会话 Recipe 提示卡。
 *
 * 卡片只呈现检测结果并把提取指令交给 Composer；它不直接创建 Skill、任务或文件。
 */
import type { RecipeNotice } from "../app/useDesktopEventBridge.js";
import React from "react";
import { Icon } from "./Icon.js";

export function RecipeReadyBanner({
  notice,
  onDismiss,
  onExtract
}: {
  notice: RecipeNotice;
  onDismiss(notice: RecipeNotice): void;
  onExtract(notice: RecipeNotice): void;
}): React.JSX.Element {
  return (
    <section aria-label="可提取的可重复任务" className="biny-recipe-ready-banner" role="region">
      <div className="biny-recipe-ready-copy">
        <div className="biny-recipe-ready-title-row">
          <h3>「{notice.title}」— 这些材料现在可以提取成一个可重复任务</h3>
          <button aria-label="忽略此提示" className="biny-recipe-ready-dismiss" onClick={() => onDismiss(notice)} type="button"><Icon name="close" size={16} /></button>
        </div>
        <p>{notice.description}</p>
        <ul className="biny-recipe-ready-slots">
          {notice.slots.map((slot) => (
            <li className={slot.filled ? "is-filled" : ""} key={slot.key}>
              <span aria-hidden="true">{slot.filled ? "✓" : "○"}</span>
              {slot.label}
            </li>
          ))}
        </ul>
      </div>
      <button className="biny-recipe-ready-extract" onClick={() => onExtract(notice)} type="button">提取</button>
    </section>
  );
}
