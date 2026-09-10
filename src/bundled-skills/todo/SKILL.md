---
name: todo
description: "Manage a structured, lightweight todo list for the current session when the user needs to keep track of a small set of immediate, mostly linear steps. Use for requests such as make a checklist, show what remains, add this to my todo, mark this done, reorder the list, or clear the current list; triggers include: make a checklist, what remains, add this to my todo, todo list, 待办, 列个清单, and 还有什么没做. Keep at most one item in progress and use the full-list TodoStore update; use `tasks` for cross-session or independently executed work and `plan-weave` for dependencies or review gates, and do not mistake a checked item for execution evidence."
---

# Todo Skill

Manage the structured todo list for the current session. Biny stores the list in its session-scoped TodoStore and injects it back into the model on later turns, so it survives context compaction without becoming an executor or a second source of task truth.

## When to use

- The user provides several related steps and wants a visible checklist.
- Work is small and mostly linear, but the next action or unfinished items could be forgotten between turns.
- The user explicitly asks to add, show, reorder, complete, or clear current-session todos.

**Do NOT use for**:

- A single simple action that can be completed immediately.
- Work that must run independently in the background or survive as an execution process → use `tasks`.
- Work with prerequisites, branches, review gates, or recoverable graph state → use `plan-weave`.
- A scheduled action → use `scheduler`.

## File and tool model

Prefer the `TodoWrite` capability when working inside an agent turn. It replaces the complete list, validates item content and status, and returns the remaining count. The list is session-scoped; a subagent must not silently mutate the parent session's list.

For explicit CLI management:

```bash
# Show the current session's list
biny todo show --json

# Show another known session's list
biny todo show --session <sessionId> --json

# Replace the complete list
biny todo replace \
  --todos '[{"content":"Inspect the current implementation","status":"in_progress"},{"content":"Run focused tests","status":"pending"}]' \
  --json

# Clear the list after explicit confirmation
biny todo clear --yes --json
```

## Status and update rules

- `pending` means not started.
- `in_progress` means the model is actively working on it.
- `completed` means the actual work and its relevant verification are complete.
- Keep at most **one** item `in_progress` at a time.
- Submit the full list on every update; this is a replace operation, not an append or index-based edit.
- Mark an item `in_progress` when starting it and `completed` immediately after the evidence supports completion. Add newly discovered work to the complete list rather than losing existing items.
- Keep item content concise and actionable. Do not use todo text to store secrets, long logs, or a second project plan.

## Rules

- Todo state is a coordination reminder, not proof that a command ran or a task finished. Use tool results, session events, and TaskRun state for execution evidence.
- Do not silently replace unrelated items or drop pending work while editing one item.
- Do not create a todo list for formality when the request is one step.
- If a write fails, preserve the last known persisted list and report the error; do not claim the replacement succeeded.
- Keep the user's language in item text when that is clearer; the skill instructions being in English do not require an English response.
