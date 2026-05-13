---
name: cli-access
description: Manages repository-stored user access, identity links, and pending authorization state through the repository CLI. Use when the task involves access levels, person-path links, user identity records, or temporary authorization grants.
---

# CLI access

## Quick start

```bash
bun run repo:cli -- users:list '{"requesterUserId":1}'
bun run repo:cli -- users:get '{"requesterUserId":1,"userId":200}'
bun run repo:cli -- users:set-access '{"requesterUserId":1,"userId":200,"accessLevel":"trusted"}'
```

## Workflows

### Inspect access or identity state

- Use `users:list` for overview questions.
- Use `users:get` for one explicit user.
- Read first when the target user is unclear.

### Mutate access or identity links

- Use `users:set-access` to grant, reduce, or clear access.
- Mutate only one explicit target at a time.
- Use `users:set-person-path` only when both the Telegram user and canonical person entry are explicit.
- Use `auth:add-pending` for temporary authorization state.

### Boundaries

- Use `cli-rules` for durable assistant rules.
- Use `memory` for durable facts or preferences.
- Do not claim success unless the CLI call succeeded.

## Commands

- `users:list`
- `users:get`
- `users:set-access`
- `users:set-person-path`
- `auth:add-pending`

## Examples

```bash
bun run repo:cli -- users:set-access '{"requesterUserId":1,"userId":200,"accessLevel":"clear"}'
bun run repo:cli -- users:set-person-path '{"requesterUserId":1,"userId":200,"personPath":"memory/people/alice/README.md"}'
bun run repo:cli -- auth:add-pending '{"requesterUserId":1,"username":"new_user","createdBy":1}'
```
