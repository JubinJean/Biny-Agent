/** 从真实事件投影到消息组件，验证空失败、部分输出和历史回放的展示边界。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import { MessageTimeline } from "../src/desktop/renderer/src/components/MessageTimeline.js";
import { buildSessionTimeline, type TimelineTurn } from "../src/desktop/renderer/src/sessionTimeline.js";

const base = { sessionId: "session", runId: "run", timestamp: "2026-09-11T00:00:00.000Z" };
const start: AgentHostEvent[] = [
  { ...base, type: "message.user", messageId: "user-message", content: "检查项目" },
  { ...base, type: "reasoning.started", phase: "initial" }
];
const failure: AgentHostEvent = { ...base, timestamp: "2026-09-11T00:00:12.000Z", type: "run.failed", error: "Connection timed out", durationMs: 12_000 };
const noop = (): void => undefined;
const noopAsync = (): Promise<void> => Promise.resolve();

function renderTurns(turns: TimelineTurn[], thinking = false): string {
  return renderToStaticMarkup(createElement(MessageTimeline, {
    projectId: "project",
    turns,
    thinking,
    onPreviewFile: noop,
    onOpenExternal: noop,
    onResolvePermission: noopAsync,
    onRetry: noopAsync,
    onSwitchVersion: noopAsync,
    onEditRequest: noop,
    onCreateBranch: noop,
    onRollbackFiles: noop,
    onDeleteUserMessage: noop
  }));
}

test("模型尚未输出就失败：保留用户消息、错误详情和重试，移除空思考与耗时", () => {
  const turns = buildSessionTimeline([], [...start, failure]);
  assert.equal(turns[0]?.reasoningDurationMs, 12_000, "展示筛选不改写真实计时记录");
  const markup = renderTurns(turns);
  assert.match(markup, /检查项目/u);
  assert.match(markup, /回复生成失败/u);
  assert.match(markup, /class="chat-run-retry"/u);
  assert.match(markup, /<details class="chat-run-details"><summary>查看详情/u);
  assert.match(markup, /Connection timed out/u);
  assert.doesNotMatch(markup, /已思考|chat-activity|Worked for|assistant-actions|复制回复|更多回复操作/u);
});

test("历史失败只有请求耗时：不能用总耗时生成思考步骤", () => {
  const markup = renderTurns(buildSessionTimeline([
    { type: "user_message", content: "检查项目", messageId: "user-message", time: base.timestamp },
    { type: "error", message: "Connection timed out", time: failure.timestamp }
  ], []));
  assert.match(markup, /回复生成失败/u);
  assert.match(markup, /chat-run-retry/u);
  assert.doesNotMatch(markup, /已思考|Worked for|chat-activity/u);
});

test("部分回复后失败：保留已收到的正文、真实思考和工具结果", () => {
  const turns = buildSessionTimeline([], [
    ...start,
    { ...base, type: "reasoning.delta", content: "先检查项目入口。" },
    { ...base, type: "tool.started", toolCallId: "read", tool: "Read", args: { path: "package.json" } },
    { ...base, type: "tool.completed", toolCallId: "read", tool: "Read", result: { content: "{}" }, durationMs: 20 },
    { ...base, type: "assistant.delta", content: "已读取项目配置。" },
    failure
  ]);
  const markup = renderTurns(turns);
  assert.match(markup, /已读取项目配置。/u);
  assert.match(markup, /chat-activity/u);
  assert.equal(turns[0]?.tools[0]?.status, "success");
  assert.equal(turns[0]?.reasoning, "先检查项目入口。");
  assert.match(markup, /回复生成失败/u);
  assert.match(markup, /复制回复/u);
});

test("仅有工具结果的失败不会补出思考或空助手操作栏", () => {
  const markup = renderTurns(buildSessionTimeline([], [
    ...start,
    { ...base, type: "tool.started", toolCallId: "read", tool: "Read", args: { path: "package.json" } },
    { ...base, type: "tool.completed", toolCallId: "read", tool: "Read", result: { content: "{}" } },
    failure
  ]));
  assert.match(markup, /chat-activity/u);
  assert.match(markup, /回复生成失败/u);
  assert.doesNotMatch(markup, /已思考|Worked for|assistant-actions/u);
});

test("成功回复没有思考内容：展示正文但不凭总耗时补出思考", () => {
  const markup = renderTurns(buildSessionTimeline([
    { type: "user_message", content: "检查项目", time: base.timestamp },
    { type: "assistant_message", content: "检查完成。", time: failure.timestamp }
  ], []));
  assert.match(markup, /检查完成。/u);
  assert.match(markup, /复制回复/u);
  assert.doesNotMatch(markup, /已思考|chat-run-notice/u);
});

test("历史真实思考走事件步骤，缺失思考耗时时不借用整轮耗时", () => {
  const markup = renderTurns(buildSessionTimeline([
    { type: "user_message", content: "检查项目", time: base.timestamp },
    { type: "assistant_message", content: "检查完成。", reasoningContent: "先检查入口。", time: failure.timestamp }
  ], []));
  assert.match(markup, /已思考/u);
  assert.match(markup, /检查完成。/u);
  assert.doesNotMatch(markup, /已思考 12 秒/u);
});

test("停止生成使用中性状态，压缩通知不会被当作空思考删除", () => {
  const markup = renderTurns(buildSessionTimeline([], [
    ...start,
    { ...base, type: "context.retrying", attempt: 1, compactedMessages: 10 },
    { ...base, type: "run.cancelled", reason: "Cancelled by user.", durationMs: 1_000 }
  ]));
  assert.match(markup, /已停止生成/u);
  assert.match(markup, /compaction/u);
  assert.doesNotMatch(markup, /已思考|回复生成失败|Worked for/u);
});

test("运行中保留活动反馈，并禁止重试旧失败消息", () => {
  const running = renderTurns(buildSessionTimeline([], start), true);
  assert.match(running, /chat-activity/u);
  assert.doesNotMatch(running, /回复生成失败|assistant-actions/u);
  const busy = renderTurns(buildSessionTimeline([], [...start, failure]), true);
  assert.match(busy, /class="chat-run-retry" disabled=""/u);
});

test("空失败版本仍能切回已有的回复版本", () => {
  const turns = buildSessionTimeline([], [...start, failure]);
  const markup = renderTurns(turns.map((turn) => ({ ...turn, assistantMessageId: "failed-version", versionIndex: 2, versionCount: 2 })));
  assert.match(markup, /message-version-switcher/u);
  assert.doesNotMatch(markup, /assistant-actions/u);
});
