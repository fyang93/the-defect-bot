# The Defect Bot

[中文说明](README.zh-CN.md)

A local-first Telegram bot for personal memory, files, events, reminders, automations, and lightweight message relay.

It uses Pi SDK for assistant behavior, stores long-term state in local repository files, and treats Telegram as the chat interface rather than the source of truth.

## Features

- remember and retrieve personal facts
- organize Telegram-uploaded files for local processing
- create reminders, events, recurring routines, and automations
- send immediate or scheduled messages to authorized users and known groups
- manage user access levels through the bot

## Quick start

```bash
cp config.toml.example config.toml
just install
# configure Telegram and Pi model credentials, then:
just serve
```

Pi model credentials can be configured in `agent/.pi/auth.json`, `agent/.pi/models.json`, or supported environment variables.

For local assistant debugging:

```bash
just agent
```

## Configuration

Fill in at least:

- `telegram.bot_token`
- `telegram.admin_user_id`
- `bot.default_timezone`

Common options:

- `telegram.waiting_message`: initial waiting text; empty disables it
- `telegram.input_merge_window_seconds`: short merge window for follow-up text/files
- `telegram.menu_page_size`: Telegram inline menu page size
- `bot.language`: fixed UI locale, `zh-CN` or `en`
- `bot.persona_style`: assistant persona hint
- `maintenance.enabled`: enable idle maintenance

## Telegram setup

- Users who should receive direct bot messages must start a private chat with the bot once.
- For group usage, disable the bot's **Group Privacy** in BotFather.

## Access levels

- `allowed`: basic chat and low-risk actions in the current linked context
- `trusted`: memory, files, events, automations, and persistent workflows
- `admin`: trusted plus role management and temporary authorization grants

## Examples

- “Remember my passport number.”
- “What is my home address?”
- “Remind me tomorrow at 9am to submit the application.”
- “Send this to @someone: dinner is ready.”
- “Send this to the family group.”
- “Set @someone to trusted.”

## Commands

- `/help`
- `/new`
- `/model` — admin only

## Development

```bash
npm run check
npm test
npm run test:live
```

Engineering guidance lives in `AGENTS.md`; bot assistant workspace details live in `docs/agent-architecture.md`.
