/** 原生下拉只补选中文本的裁切容器，弹出、定位和选中行为仍由浏览器负责。 */
import React, { type ComponentProps } from "react";

export function NativeSelect({ children, ...props }: ComponentProps<"select">): React.JSX.Element {
  return (
    <select {...props}>
      {/* 原生 select 内的按钮不可交互；清除应用普通按钮样式，避免影响文字裁切。 */}
      <button style={{ all: "unset", display: "contents" }} type="button">
        {React.createElement("selectedcontent")}
      </button>
      {children}
    </select>
  );
}
