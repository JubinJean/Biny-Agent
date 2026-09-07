/**
 * 回合收尾的「修改文件」卡片。
 *
 * 一轮对话结束后，把本轮 write/edit 过的文件收成一张汇总卡：标题行显示文件数，
 * 每行一个文件（操作图标 + 文件名 + 目录 + write/edit 徽标 + 累计 +x -y），点击
 * 在右侧预览整文件。
 */
import { memo } from "react";
import type { TimelineChangedFile } from "../../sessionTimeline.js";
import { Icon } from "../Icon.js";

export const ChangesSummary = memo(function ChangesSummary({
  files,
  onPreviewFile
}: {
  files: TimelineChangedFile[];
  onPreviewFile(path: string): void;
}): React.JSX.Element {
  return (
    <section aria-label="本轮修改的文件" className="chat-changes">
      <header className="chat-changes-head">
        <Icon name="file" size={13} />
        <span>修改了 {String(files.length)} 个文件</span>
      </header>
      <ul className="chat-changes-list">
        {files.map((file) => {
          const separator = file.path.lastIndexOf("/");
          const name = separator < 0 ? file.path : file.path.slice(separator + 1);
          const dir = separator < 0 ? "" : file.path.slice(0, separator);
          return (
            <li key={file.path}>
              <button className="chat-changes-file" onClick={() => onPreviewFile(file.path)} title={`在右侧预览 ${file.path}`} type="button">
                <Icon name={file.operation === "write" ? "file" : "edit"} size={13} />
                <span className="chat-changes-name" title={file.path}>{name}</span>
                {dir ? <span className="chat-changes-dir" title={file.path}>{dir}</span> : null}
                <span className="chat-changes-badge">{file.operation === "write" ? "新建" : "编辑"}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
});
