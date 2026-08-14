# The Defect Bot

A local-first Feishu bot backed by the Pi SDK for memory, files, events, reminders, automations, and message relay.

## Features

- Direct messages are handled automatically; group messages require an @ mention
- Text, image, document, audio, and video input
- Canonical user, chat, event, and runtime state in local `system/` JSON files
- Durable personal memory under `memory/`
- Equal capabilities for every Feishu user, including memory, schedules, model selection, and outbound delivery
- `/help`, `/new`, `/stop`, `/quota`, `/reminders`, and `/model` commands
- Feishu custom menus for new session, remaining quota, current reminders, and model selection

## Start

```bash
just install
cp config.toml.example config.toml
# Set FEISHU_APP_ID and FEISHU_APP_SECRET in .env
just agent  # run /login once if ~/.pi/agent/auth.json has no usable model credential
just serve
```

Enable the bot and long-connection event subscription in the Feishu app console. Subscribe to message events and `application.bot.menu_v6`, and grant the message, resource-download, delivery, and reaction permissions needed by the bot. Event-type custom menus may use `new_session`, `remaining_quota`, `current_reminders`, and `switch_model` as event keys; menu items that send the Chinese labels are also supported.

## Configuration

```toml
[feishu]
app_id = "${FEISHU_APP_ID}"
app_secret = "${FEISHU_APP_SECRET}"
input_merge_window_seconds = 3
menu_page_size = 8
```

`${VAR}` values are expanded from the project `.env` and process environment.

## Development

```bash
npm run check
npm test
npm run test:live
```

- Runtime: `src/bot/main.ts`
- Feishu adapters: `src/bot/feishu/**`
- Deterministic operations: `src/bot/operations/**`
- Pi workspace: `agent/`
