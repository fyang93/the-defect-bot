---
name: cli-events
description: Load when the task is primarily to create, list, inspect, update, pause, resume, delete, or interpret reminder, event, or automation state through the repository CLI, rather than storing a fact in memory or setting a standing future-facing rule.
---

# CLI events

## Scope

Use this skill when event state itself is the main object being read or changed:

- reminders
- dated events
- recurring schedules
- automations
- pause/resume/delete operations

Use neighboring skills instead when the request is mainly about:

- durable future defaults or standing instructions → `cli-rules`
- ordinary stored facts, notes, or preferences → `memory`

## First action

- For new events, clarify only when a required field is truly missing.
- For existing events, read first when the target event is ambiguous.
- Prefer explicit identifiers such as `match.id` before mutating.

## Gotchas

- If the request is actionable but the time is vague, choose a reasonable requester-local time and mention it briefly.
- For explicit dated events, prefer one-time schedules unless recurrence is requested.
- For recurring generated content, use `category: "automation"`.
- Keep create payloads narrow: `title`, `schedule`, `timezone`, one target field, and optional semantic fields.
- Use requester-local time and timezone.
- Do not pre-convert to UTC unless the user gave an absolute UTC or offset timestamp.
- For birthdays, anniversaries, memorials, or festivals tied to a person, check local memory first if the date may already be recorded.
- Do not turn a standing preference into a one-off event when `cli-rules` is the better fit.
- Do not claim success unless the CLI call succeeded.

## Runtime notes

Semantic mappings:

- birthday → `category: "special"`, `specialKind: "birthday"`
- festival → `category: "special"`, `specialKind: "festival"`
- anniversary → `category: "special"`, `specialKind: "anniversary"`
- memorial → `category: "special"`, `specialKind: "memorial"`

Available commands:

- `events:list`
- `events:get`
- `events:create`
- `events:update`
- `events:delete`
- `events:pause`
- `events:resume`

Examples:

```bash
bun run repo:cli -- events:get '{"requesterUserId":872940661,"match":{"id":"rmd_xxx"}}'
bun run repo:cli -- events:pause '{"requesterUserId":872940661,"match":{"id":"rmd_xxx"}}'
bun run repo:cli -- events:update '{"requesterUserId":872940661,"match":{"id":"rmd_xxx"},"changes":{"title":"新的标题"}}'
```
