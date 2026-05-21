---
name: cli-rules
description: Load when the task is to add, replace, or interpret durable future-facing per-user assistant rules such as “以后都要…” or “今后请遵守…”, rather than storing an ordinary fact in memory or changing one event.
---

# CLI rules

## Scope

Use this skill for standing per-user assistant behavior that should apply in future interactions.

Use neighboring skills instead when the request is mainly about:

- ordinary facts, notes, or preferences → `memory`
- one event or reminder instance → `cli-events`

## First action

- Read first when the target user is unclear.
- Prefer short, reusable, future-facing rule text.
- Use `users:add-rule` for one new rule.
- Use `users:set-rules` only for a clear full replacement.

## Gotchas

- Do not turn a one-off request into a durable rule unless the user clearly implies future default behavior.
- Do not store ordinary biographical facts or preferences here when `memory` is the better fit.
- Replacement is high impact; avoid `users:set-rules` unless full replacement is explicit.
- Do not claim success unless the CLI call succeeded.

## Runtime notes

Available commands:

- `users:get`
- `users:add-rule`
- `users:set-rules`

Examples:

```bash
bun run repo:cli -- users:get '{"requesterUserId":1,"userId":200}'
bun run repo:cli -- users:add-rule '{"requesterUserId":1,"userId":200,"rule":"添加组会提醒时默认设置为提前1天、提前2小时、提前1小时"}'
```
