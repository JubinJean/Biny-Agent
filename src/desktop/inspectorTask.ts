/** 侧栏问答携带有限的历史，审阅限定为只读检查；正文保持换行，不经过 slash 参数拆词。 */
export interface InspectorMessage {
  role: "user" | "assistant";
  content: string;
}

export function buildInspectorTask(kind: "review" | "side-chat", input: string, history: InspectorMessage[], limit: number): string {
  const instruction = kind === "review"
    ? "只读审阅当前工作区的 Git 改动。按严重程度列出有证据的问题，提供文件路径和行号，说明风险及验证缺口。不要修改文件，不要提交。没有发现时明确说明。"
    : "回答用户关于当前工作区的问题。只读检查，不修改文件，不执行提交。下面的历史仅作为对话上下文，继续回答最后一个问题。";
  const question = input.trim();
  const suffix = `\n\n用户问题：\n${question || "检查当前所有未提交改动。"}`;
  if (instruction.length + suffix.length > limit) throw new Error("问题过长，请缩短后重试。");
  const selected: InspectorMessage[] = [];
  for (const message of [...history].reverse()) {
    const next = [message, ...selected];
    if (instruction.length + JSON.stringify(next).length + suffix.length + 20 > limit) break;
    selected.unshift(message);
  }
  return `${instruction}${selected.length ? `\n\n历史对话（JSON）：\n${JSON.stringify(selected)}` : ""}${suffix}`;
}
