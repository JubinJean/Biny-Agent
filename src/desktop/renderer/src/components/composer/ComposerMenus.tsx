/** Composer 的加号菜单。 */
import type { RefObject } from "react";
import { useClosingPresence } from "../../useClosingPresence.js";
import { ComposerPopover } from "./ComposerPopover.js";
import { Icon } from "../Icon.js";

/** 加号菜单：添加附件。 */
export function AddMenu({ anchorRef, open, onPickFiles }: {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onPickFiles(): void;
}): React.JSX.Element | null {
  const presence = useClosingPresence(open);
  if (!presence.present) return null;
  return (
    <ComposerPopover anchorRef={anchorRef} className={`t-dropdown composer-popover biny-composer-popover add-menu ${presenceClass(presence.phase)}`} phase={presence.phase}>
      <div role="menu">
        <div className="popover-heading">添加</div>
        <button className="menu-option" onClick={onPickFiles} role="menuitem" type="button">
          <span className="menu-check"><Icon name="paperclip" size={14} /></span>
          <span className="menu-option-copy"><strong>添加文件或目录</strong><small>附加到这条消息</small></span>
        </button>
      </div>
    </ComposerPopover>
  );
}

function presenceClass(phase: "closed" | "opening" | "open" | "closing"): string {
  if (phase === "open") return "is-open";
  if (phase === "closing") return "is-closing";
  return "";
}
