---
name: cli-access
description: Load when the task is to inspect or change repository-stored user access, person-path identity links, user identity records, or pending authorization state through the repository CLI, rather than storing facts in memory or setting durable assistant rules.
---

# CLI access

## Scope

Use this skill for repository authority and identity-link state:

- access levels
- person-path links
- user identity records
- pending authorization entries

Use neighboring skills instead when the task is mainly about:

- durable assistant defaults or future-facing rules → `cli-rules`
- ordinary facts, preferences, or notes → `memory`

## First action

- Use `users:list` for overview questions.
- Use `users:get` for one explicit user.
- Read first when the target user is unclear before mutating anything.

## Gotchas

- Mutate only one explicit target at a time.
- Use `users:set-person-path` only when both the Telegram user and canonical person entry are explicit.
- Use `auth:add-pending` for temporary authorization state, not for durable access decisions.
- Do not treat memory notes as canonical access state.
- Do not claim success unless the CLI call succeeded.

## Runtime notes

Available commands:

- `users:list`
- `users:get`
- `users:set-access`
- `users:set-person-path`
- `auth:add-pending`

Examples:

```bash
bun run repo:cli -- users:get '{"requesterUserId":1,"userId":200}'
bun run repo:cli -- users:set-access '{"requesterUserId":1,"userId":200,"accessLevel":"clear"}'
bun run repo:cli -- users:set-person-path '{"requesterUserId":1,"userId":200,"personPath":"memory/people/alice/README.md"}'
```
