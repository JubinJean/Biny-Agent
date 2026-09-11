/** 保留原生表单语义，并确保长选项有独立的收起态裁切容器。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NativeSelect } from "../src/desktop/renderer/src/components/NativeSelect.js";

const markup = renderToStaticMarkup(createElement(NativeSelect, {
  "aria-label": "筛选仓库",
  className: "repository-filter",
  disabled: true,
  id: "repository-filter",
  name: "repository",
  onChange: () => {},
  value: "workspace/long-repository-name"
}, [
  createElement("option", { disabled: true, key: "unavailable", value: "unavailable" }, "不可选择"),
  createElement("option", { key: "repository", value: "workspace/long-repository-name" }, "长仓库名称")
]));

assert.match(markup, /<select[^>]*aria-label="筛选仓库"/);
assert.match(markup, /class="repository-filter"/);
assert.match(markup, /id="repository-filter" name="repository"/);
assert.match(markup, /<select[^>]*disabled=""/);
assert.match(markup, /<button[^>]*type="button"><selectedcontent><\/selectedcontent><\/button>/);
assert.match(markup, /<option disabled="" value="unavailable">不可选择<\/option>/);
assert.match(markup, /<option value="workspace\/long-repository-name" selected="">长仓库名称<\/option>/);
// 固定高度且没有上下 padding 的 API 格式框，也必须由共用规则居中。
const desktopStyles = readFileSync(new URL("../src/desktop/renderer/src/styles/desktop-v2.css", import.meta.url), "utf8");
assert.match(desktopStyles, /\nselect\s*\{[^}]*\balign-items:\s*center\s*;/);
console.log("native select tests passed");
