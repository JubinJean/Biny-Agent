---
name: daily-report
description: "Generate a rich, evidence-based work journal for a specific day or date range, grouped by project, theme, and outcome rather than presented as a minute-by-minute timeline. Use this whenever the user asks about today, yesterday, a named date, last week, what they got done, a work recap, or a daily report; triggers include: what did I do today, recap my day, summarize yesterday, work journal, daily review, 今天做了什么, 昨天的工作, 打工日记, and 工作总结. Prefer `biny activity report` for day-level or multi-day questions and use `biny activity digest` only for a shallow recent overview; do not use this for the immediately preceding turn unless an activity record is requested, and never invent missing events, times, projects, or outcomes."
---

# Daily Report Skill

Generate a thematic work journal from Biny's local activity records. The report is grouped by project, theme, and outcome; it is not intended to be a minute-by-minute timeline.

This skill exists because `biny activity digest` is useful for a shallow, recent timeline, while `biny activity report` builds a richer day-level journal from analyzed activity sessions. Use the report when the user asks what they got done, not merely what was open recently.

## When to use

Use this skill for a **day-level or multi-day** question about the user's own activity:

- 今天做了什么 / 我今天都干了什么 / 今天的工作总结
- 昨天做了什么 / 上周完成了什么 / 某个日期的工作
- what did I do today / yesterday / last Friday
- summarize my week / give me a recap / work journal / daily report
- any request where the answer should be organized by outcomes or themes rather than timestamps

**Do NOT use for**:

- "What was I just doing?" → use `biny activity digest` with an appropriate lookback window.
- "Find the activity about this code/project" → use `biny activity search <query>`.
- "Show recent or specific sessions" → use `biny activity sessions`, optionally with `--since` or `--limit`.
- A request about the daily note itself → use `biny diary show [date]`.

## How to use

Run the CLI from the current workspace. Plain output is already formatted as a readable Markdown journal; preserve its headings and structure when replying.

```bash
# Today's report
biny activity report today

# Yesterday
biny activity report yesterday

# A specific date
biny activity report 2026-09-10

# Machine-readable result for careful synthesis
biny activity report today --json

# Recent timeline instead of a day-level journal
biny activity digest --lookback-min 120
```

When the user asks a follow-up about one project or event, drill down with `biny activity search` or `biny activity sessions` instead of regenerating the whole report.

## Output rules

1. If plain `biny activity report` returns a polished Markdown report, relay it without inventing a second structure or an unsupported top-level summary.
2. If `--json` is used, treat the JSON as evidence and synthesize only from fields that are present; do not expose raw JSON unless the user asks for it.
3. Do not turn the report into a minute-by-minute narration. The report intentionally emphasizes projects, themes, and outcomes.
4. Match the user's language. English instructions do not require an English answer.
5. Keep recorded facts separate from interpretation. A pending analysis count or blocked message must remain visible.
6. Every named project, person, version, decision, or outcome must be supported by the command result.

## Failure modes

- If `biny activity report` fails, report the failure and fall back to `biny activity digest` only when a recent overview is still useful. Say explicitly that the day-level journal could not be built.
- If the report has no analyzed sessions, relay that there is no verifiable activity for the requested date and suggest checking `biny activity status`.
- If only part of the activity has been analyzed, state that the report is partial; do not fill the gap from conversation context.
- Never send local activity data to an external service, and never claim an action was completed because a session or screenshot exists.
