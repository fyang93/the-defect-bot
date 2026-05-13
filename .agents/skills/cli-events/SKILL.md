---
name: cli-events
description: Manages events, reminders, and automations through the repository CLI. Use when the task is primarily about creating, listing, updating, pausing, resuming, deleting, or interpreting event state.
---

# CLI events

## Quick start

```bash
bun run repo:cli -- events:list '{"requesterUserId":872940661}'
bun run repo:cli -- events:get '{"requesterUserId":872940661,"match":{"id":"rmd_xxx"}}'
bun run repo:cli -- events:create '{"requesterUserId":872940661,"title":"组会","schedule":{"kind":"once","scheduledAt":"2026-04-28T10:00:00"},"timezone":"Asia/Tokyo","targetUserId":872940661}'
```

## Workflows

### Create events

- Clarify only when a required field is truly missing.
- If the request is actionable but the time is vague, choose a reasonable local time and mention it briefly.
- For explicit dated events, prefer one-time schedules unless recurrence is requested.
- For recurring generated content, use `category: "automation"`.
- Keep create payloads narrow: `title`, `schedule`, `timezone`, one target field, and optional semantic fields.

### Update existing events

- Read first before mutating when the target event is ambiguous.
- Prefer `match.id` or another explicit target for update, pause, resume, and delete.
- Prefer requester-local projection fields when reading CLI results.

### Time and semantics

- Use requester-local time and timezone.
- Do not pre-convert to UTC unless the user gave an absolute UTC or offset timestamp.
- For birthdays, anniversaries, memorials, or festivals tied to a person, check local memory first if the date may already be recorded.
- Semantic fields:
  - birthday → `category: "special"`, `specialKind: "birthday"`
  - festival → `category: "special"`, `specialKind: "festival"`
  - anniversary → `category: "special"`, `specialKind: "anniversary"`
  - memorial → `category: "special"`, `specialKind: "memorial"`

### Boundaries

- Use `cli-rules` if the user is setting a standing future default rather than changing one event.
- Do not claim success unless the CLI call succeeded.

## Commands

- `events:list`
- `events:get`
- `events:create`
- `events:update`
- `events:delete`
- `events:pause`
- `events:resume`

## Examples

```bash
bun run repo:cli -- events:create '{"requesterUserId":872940661,"title":"小雨生日","schedule":{"kind":"yearly","every":1,"month":1,"day":22,"time":{"hour":8,"minute":0}},"timezone":"Asia/Tokyo","targetUserId":872940661,"category":"special","specialKind":"birthday"}'
bun run repo:cli -- events:create '{"requesterUserId":872940661,"title":"小雨农历生日","schedule":{"kind":"lunarYearly","month":5,"day":3,"time":{"hour":8,"minute":0}},"timezone":"Asia/Tokyo","targetUserId":872940661,"category":"special","specialKind":"birthday"}'
bun run repo:cli -- events:pause '{"requesterUserId":872940661,"match":{"id":"rmd_xxx"}}'
bun run repo:cli -- events:update '{"requesterUserId":872940661,"match":{"id":"rmd_xxx"},"changes":{"title":"新的标题"}}'
```
