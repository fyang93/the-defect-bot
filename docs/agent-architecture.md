# Agent architecture

This project uses Pi SDK sessions directly.

## Workspace layout

```text
agent/
  AGENTS.md                 # bot assistant context
  .pi/                      # Pi config dir: settings, credentials, extensions, prompts, global skills
  .agents/skills/           # project skills auto-discovered when cwd=agent
```

Use `just agent` to open an isolated interactive Pi session. It disables default context discovery and appends `agent/AGENTS.md` so the root development `AGENTS.md` is not loaded.

## Runtime lanes

| Lane | Code path | Tools | Context files | Purpose |
|---|---|---:|---:|---|
| assistant | `AiService.runAssistantTurn` / scoped sessions | yes | `agent/AGENTS.md` only | User requests, state changes, memory/file/event/Telegram operations |
| composer / writer | `ReplyComposer` via light writer sessions | no | no | Startup greeting, reminder wording, maintenance reports |
| scheduled content | `generateScheduledTaskContent` | web allowlist only | no | Current-information automation content |
| maintainer | `runMaintenancePass` | no | no | Short maintenance summaries and housekeeping text |

The intended direction is to keep **assistant** as the only broad, state-changing agent lane. Composer and maintainer should stay small and avoid loading `agent/AGENTS.md` unless they explicitly need a broader capability.

## Pi tool boundary

The assistant should use these tools instead of raw shell commands for canonical bot state:

- `event:*`: reminders, events, recurring schedules, automations, pause/resume/delete
- `user:*`: aliases, person memory links, identity links, timezones, durable assistant rules, pending auth
- `telegram:*`: recipient listing/search, sends, file sends

These tools call direct deterministic operations under `src/bot/operations/**`; no shell shim is used.

## Resource loading and startup latency

- The gateway caches Pi resource loaders by role/capability so `/new` sessions do not reload extensions and skills repeatedly.
- Model registry refresh is cached briefly to avoid slow startup and repeated `/model` latency.
- Writer/maintainer sessions use no-tools/no-context modes to avoid loading the full assistant workspace.
- If a future composer mode needs web access, prefer enabling only web tools rather than enabling the full repository mutation toolset.

## Credentials and model config

Local-only files must not be committed:

- `agent/.pi/auth.json`
- `agent/.pi/models.json`
- `agent/.pi/sessions/`
- `agent/.pi/npm/`

The bot and `just agent` both use `agent/.pi` as the Pi agent directory; `agent/AGENTS.md` is the single bot-assistant context file.
