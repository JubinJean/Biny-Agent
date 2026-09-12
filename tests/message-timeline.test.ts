/** 从真实事件投影到消息组件，验证空失败、部分输出和历史回放的展示边界。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import { GenerationErrorBanner } from "../src/desktop/renderer/src/components/chat/GenerationErrorBanner.js";
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

test("模型尚未输出就失败：只保留用户消息，不生成助手错误回复", () => {
  const turns = buildSessionTimeline([], [...start, failure]);
  assert.equal(turns[0]?.reasoningDurationMs, 12_000, "展示筛选不改写真实计时记录");
  const markup = renderTurns(turns);
  assert.match(markup, /检查项目/u);
  assert.doesNotMatch(markup, /Connection timed out|chat-run-notice/u);
  assert.match(markup, /aria-label="重新生成"/u);
  assert.doesNotMatch(markup, /data-sender="assistant"|技术详情/u);
  assert.doesNotMatch(markup, /已思考|chat-activity|Worked for|assistant-actions|复制回复|更多回复操作/u);
});

test("历史失败只有请求耗时：不能用总耗时生成思考步骤", () => {
  const markup = renderTurns(buildSessionTimeline([
    { type: "user_message", content: "检查项目", messageId: "user-message", time: base.timestamp },
    { type: "error", message: "Connection timed out", time: failure.timestamp }
  ], []));
  assert.doesNotMatch(markup, /Connection timed out|chat-run-notice/u);
  assert.doesNotMatch(markup, /data-sender="assistant"/u);
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
  assert.doesNotMatch(markup, /Connection timed out|chat-run-notice/u);
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
  assert.doesNotMatch(markup, /Connection timed out|chat-run-notice/u);
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

test("停止后不补错误回复，保留真实压缩通知", () => {
  const markup = renderTurns(buildSessionTimeline([], [
    ...start,
    { ...base, type: "context.retrying", attempt: 1, compactedMessages: 10 },
    { ...base, type: "run.cancelled", reason: "Cancelled by user.", durationMs: 1_000 }
  ]));
  assert.doesNotMatch(markup, /Cancelled by user|chat-run-notice/u);
  assert.match(markup, /compaction/u);
  assert.doesNotMatch(markup, /已思考|回复生成失败|Worked for/u);
});

test("运行中保留活动反馈，并禁止重试旧失败消息", () => {
  const running = renderTurns(buildSessionTimeline([], start), true);
  assert.match(running, /chat-activity/u);
  assert.doesNotMatch(running, /回复生成失败|assistant-actions/u);
  const busy = renderTurns(buildSessionTimeline([], [...start, failure]), true);
  assert.doesNotMatch(busy, /aria-label="重新生成"/u);
});

test("空失败版本仍能切回已有的回复版本", () => {
  const turns = buildSessionTimeline([], [...start, failure]);
  const markup = renderTurns(turns.map((turn) => ({ ...turn, assistantMessageId: "failed-version", versionIndex: 2, versionCount: 2 })));
  assert.match(markup, /message-version-switcher/u);
  assert.doesNotMatch(markup, /assistant-actions/u);
});

test("生成错误只在独立横幅显示原文、模型和关闭按钮", () => {
  const error = "Cannot connect to API: Client network socket disconnected before secure TLS connection was established";
  const markup = renderTurns(buildSessionTimeline([], [...start, { ...failure, error }]));
  assert.doesNotMatch(markup, /data-sender="assistant"|Cannot connect|技术详情/u);
  const banner = renderToStaticMarkup(createElement(GenerationErrorBanner, { error, model: "test-model", onDismiss: noop }));
  assert.match(banner, /role="alert"/u);
  assert.match(banner, /生成错误/u);
  assert.match(banner, /Cannot connect to API/u);
  assert.match(banner, /Model test-model/u);
  assert.match(banner, /关闭错误提示/u);
  assert.doesNotMatch(banner, /重试<|技术详情|复制错误|请检查/u);
});

test("错误横幅保留原文解释，去掉重复行和堆栈", () => {
  const banner = renderToStaticMarkup(createElement(GenerationErrorBanner, {
    error: "自定义服务错误\n自定义服务错误\n    at internalFunction (file:///app.js:1)", onDismiss: noop
  }));
  assert.equal(banner.match(/自定义服务错误/gu)?.length, 1);
  assert.doesNotMatch(banner, /internalFunction/u);
});

test("失败后正常再发一条消息：保留两条用户消息，不插入失败助手消息", () => {
  const markup = renderTurns(buildSessionTimeline([], [
    ...start, failure,
    { ...base, runId: "next-run", type: "message.user", messageId: "next-user", content: "再试一次" },
    { ...base, runId: "next-run", type: "reasoning.started", phase: "initial" }
  ]), true);
  assert.match(markup, /检查项目/u);
  assert.match(markup, /再试一次/u);
  assert.doesNotMatch(markup, /Connection timed out|生成错误/u);
  assert.equal(markup.match(/data-sender="assistant"/gu)?.length, 1, "仅新一轮活动占用助手区域");
});

for (const [stage, label] of [["capabilities", "正在分析相关工具和技能"], ["workspace", "正在读取工作区上下文"], ["memory", "正在检索相关记忆"], ["compacting", "正在压缩对话上下文"]] as const) {
  test(`准备阶段实时显示并在完成或失败时清除：${stage}`, () => {
    const events: AgentHostEvent[] = [start[0]!, { ...base, type: "preparation.updated", stage }];
    assert.match(renderTurns(buildSessionTimeline([], events), true), new RegExp(label));
    const ready = buildSessionTimeline([], [...events, { ...base, type: "preparation.updated", stage: "ready" }]);
    assert.equal(ready[0]?.preparationStage, undefined);
    assert.doesNotMatch(renderTurns(ready, true), new RegExp(label));
    const failed = buildSessionTimeline([], [...events, failure]);
    assert.equal(failed[0]?.preparationStage, undefined);
    assert.doesNotMatch(renderTurns(failed), new RegExp(label));
  });
}
