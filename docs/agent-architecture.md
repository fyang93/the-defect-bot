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
| assistant | `AiService.runAssistantTurn` / scoped sessions | Pi defaults | User requests, memory, events, files, and Feishu delivery |
| composer / writer | `ReplyComposer` | Pi defaults | Reminder wording and small generated text |
| scheduled content | `generateScheduledTaskContent` | Pi defaults | Current-information automation content |
| maintainer | `runMaintenancePass` / `memory-maintenance` skill | Pi defaults | Local memory housekeeping |

All Pi sessions use the default tool, skill, extension, and context discovery for the `agent/` workspace; prompts define each lane's job instead of changing its loaded capabilities.

Every Feishu user has the same capability set. There is no role or authorization tier. Model selection is global, but switching models updates existing scoped Pi sessions in place so conversation history is retained; only an explicit new-session action resets history.

## Deterministic tool boundary

- `event_*`: reminders, events, recurring schedules, and automations
- `user_*`: aliases, person-memory links, timezones, and durable rules
- `feishu_*`: recipient lookup, message delivery, and file delivery

These tools call operations under `src/bot/operations/**`; canonical `system/` state is not mutated through shell commands.

## Feishu boundary

`src/bot/feishu/**` owns message normalization helpers, entity registries, uploads, and Feishu output. `src/bot/main.ts` owns the long-connection channel, `application.bot.menu_v6` custom-menu events, text commands, and model-card dispatch. Scheduled delivery reuses the connected channel.

SDK-level message batching is disabled: every inbound resource must be downloaded with its originating `message_id` before `ConversationController` coalesces inputs that are still in the short collection window. Once a turn is running, a newer message in the same conversation aborts and replaces it before the newer message's resources are downloaded; the scoped Pi session is retained so already-submitted text and images remain conversation context, while the interrupted request is not merged into the replacement prompt. In group chats, unmentioned messages are buffered for ten minutes; an exact reply selects that message, otherwise a later mention receives up to three recent messages from the same sender. Active replies use a streaming waiting card and are recalled when superseded or cancelled.

Feishu `open_id` and `chat_id` values are strings throughout runtime and persisted JSON. Event target IDs are also strings.

## Credentials

Do not commit local credentials or runtime Pi files:

- `.env`
- `agent/.pi/auth.json`
- `agent/.pi/models.json`
- `agent/.pi/sessions/`
- `agent/.pi/npm/`
