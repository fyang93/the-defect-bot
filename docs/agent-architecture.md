# Agent architecture

This project uses Pi SDK sessions directly and exposes them through a Feishu bot.

## Workspace

```text
agent/
  AGENTS.md
  .pi/
  .agents/skills/
```

## Runtime lanes

| Lane | Code path | Tools | Purpose |
|---|---|---:|---|
| assistant | `AiService.runAssistantTurn` / scoped sessions | yes | User requests, memory, events, files, and Feishu delivery |
| composer / writer | `ReplyComposer` | no | Reminder wording and small generated text |
| scheduled content | `generateScheduledTaskContent` | web only | Current-information automation content |
| maintainer | `runMaintenancePass` | no | Local memory housekeeping |

Every Feishu user has the same capability set. There is no role or authorization tier.

## Deterministic tool boundary

- `event_*`: reminders, events, recurring schedules, and automations
- `user_*`: aliases, person-memory links, timezones, and durable rules
- `feishu_*`: recipient lookup, message delivery, and file delivery

These tools call operations under `src/bot/operations/**`; canonical `system/` state is not mutated through shell commands.

## Feishu boundary

`src/bot/feishu/**` owns message normalization helpers, entity registries, uploads, and Feishu output. `src/bot/main.ts` owns the long-connection channel, `application.bot.menu_v6` custom-menu events, text commands, and model-card dispatch. Scheduled delivery reuses the connected channel.

Feishu `open_id` and `chat_id` values are strings throughout runtime and persisted JSON. Event target IDs are also strings.

## Credentials

Do not commit local credentials or runtime Pi files:

- `.env`
- `agent/.pi/auth.json`
- `agent/.pi/models.json`
- `agent/.pi/sessions/`
- `agent/.pi/npm/`
