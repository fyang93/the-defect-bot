# Agent architecture

This project uses Pi SDK sessions directly.

## Workspace layout

```text
agent/
  AGENTS.md                 # human-facing copy of the assistant workspace rules
  .pi/
    AGENTS.md               # loaded by main assistant sessions
    settings.json           # Pi settings and installed packages
    auth.json               # local credentials; ignored by git
    models.json             # local/custom model config; ignored by git
    extensions/
      tools/                # repository Pi tools backed by deterministic handlers
    skills/
      memory/               # durable local memory workflow
      custom-toolbox/       # narrow project helper workflows
```

Use `just agent` to open an interactive Pi session with `PI_CODING_AGENT_DIR=agent/.pi` and sessions stored in `agent/.pi/sessions/`.

## Runtime lanes

| Lane | Code path | Tools | Context files | Purpose |
|---|---|---:|---:|---|
| assistant | `AiService.runAssistantTurn` / scoped sessions | yes | yes | User requests, state changes, memory/file/event/Telegram operations |
| composer / writer | `ReplyComposer` via light writer sessions | no | no | Startup greeting, reminder wording, maintenance reports |
| scheduled content | `generateScheduledTaskContent` | web allowlist only | no | Current-information automation content; may use web tools |
| maintainer | `runMaintenancePass` | no | no | Short maintenance summaries and repository housekeeping text |

The intended direction is to keep **assistant** as the only broad, state-changing agent lane. Composer and maintainer should stay small and avoid loading full `AGENTS.md` unless they explicitly need a broader capability.

## Pi tool boundary

The assistant should use these tools instead of raw shell commands for canonical bot state:

- `events`: reminders, events, recurring schedules, automations, pause/resume/delete
- `users`: user records, access levels, pending auth, timezones, durable assistant rules
- `telegram`: recipient resolution, sends, file sends, scheduled Telegram delivery

These tools call deterministic in-process repository handlers, preserving permission checks without exposing command-line wrappers to the assistant.

## Resource loading and startup latency

- The gateway caches Pi resource loaders by role/capability so `/new` sessions do not reload extensions and skills repeatedly.
- Model registry refresh is cached briefly to avoid slow startup and repeated `/model` latency.
- Writer/maintainer sessions use no-tools/no-context modes to avoid loading the full assistant workspace.
- If a future composer mode needs web access, prefer enabling only web tools rather than enabling the full repository mutation toolset.

## Credentials and model config

Local-only files:

- `agent/.pi/auth.json`
- `agent/.pi/models.json`

They must not be committed. The bot and `just agent` both use `agent/.pi` as the Pi agent directory.
