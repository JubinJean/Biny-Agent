---
name: tasks
description: "Create, execute, and monitor durable TaskRuns for long-running work that needs explicit progress, attempts, events, cancellation, approval, retry, or recovery across turns, sessions, and process restarts. Use when the user asks to run something in the background, continue it later, track an ongoing task, or perform work that cannot be completed reliably in one turn; triggers include: run this in the background, keep working on this, track this task, continue after restart, long-running task, 后台执行, 跨会话任务, and 可恢复任务. Use `biny task` and verify runtime events before claiming progress or completion; use `todo` for a lightweight current-session list and `plan-weave` for dependency graphs, and never fabricate a worker or successful result when execution is rejected or unavailable."
---

# Tasks Skill

Track and execute long-running work through durable TaskRuns. Unlike the current-session todo list, a TaskRun has an execution identity, lifecycle state, attempts, events, cancellation and approval transitions, and can be inspected after the original turn or process is gone.

## When to use

- Starting work that will take multiple turns or needs to continue after a restart.
- The user asks to run something in the background, track progress, resume later, or cancel an ongoing operation.
- A bounded subagent or another runtime executor needs an independently recorded run.
- You need durable evidence of dispatch, tool calls, failures, or completion.

For a small checklist that the current model is actively working through, use `todo`. For several tasks with dependencies or review gates, use `plan-weave` and associate execution records only where the runtime supports it.

## Commands

### Create a task

```bash
biny task create "Build the requested feature and verify it" --json
biny task create "Investigate the failing report" --session <sessionId> --json
```

Create one clear task with a concrete outcome. Add `--session` or `--parent-run` only when the relationship is known from the current context.

### Start and inspect

```bash
biny task start <taskRunId> --json
biny task run <taskRunId> --json
biny task get <taskRunId> --json
biny task list --json
biny task events <taskRunId> --json
```

`start` requests asynchronous dispatch; `run` requests execution and returns the runtime's result path. Always inspect the returned state and events before reporting that work started, progressed, or finished. A created task is only a durable record, not a running worker.

### Control a task

```bash
biny task approve <taskRunId> --json
biny task resume <taskRunId> --json
biny task cancel <taskRunId> --reason "<reason>" --json
biny task retry <taskRunId> --retry-safety safe --json
```

Use approval, resume, cancellation, and retry only for the matching task and only when its current state permits the transition. Preserve the returned reason when an operation is rejected.

## Retry and recovery

- Retry only when the runtime marks the failure as retryable and the requested safety classification is accurate.
- Preserve the original failure reason. Distinguish not-dispatched, rate-limited, tool failure, timeout, cancellation, budget exhaustion, and unknown-safety cases.
- Do not retry an unsafe or unknown operation merely because the user wants a fast result.
- Re-running a task after a process restart must consult the persisted TaskRun state and events; do not reconstruct progress from model memory.
- Repeated start must not be described as a second dispatch when the runtime returns an existing run or rejects duplication.

## Rules

- Keep task state in the runtime's durable store and use the Runtime Host path exposed by the CLI.
- Stable session events remain the evidence for user messages, assistant messages, tool calls, tool results, and errors.
- If the runtime rejects the operation or no execution adapter is available, report that the task was recorded but not executed.
- Never fabricate a worker, background progress, completion event, or result.
- Skill instructions describe routing and evidence requirements; they cannot expand permissions, concurrency, budget, or approval authority.
