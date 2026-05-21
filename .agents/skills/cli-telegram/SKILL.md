---
name: cli-telegram
description: Load when the task requires an actual Telegram delivery, recipient resolution, file send, or scheduled Telegram send through the repository CLI beyond the runtime's normal final reply, especially when deterministic delivery state matters.
---

# CLI Telegram

## Scope

Use this skill when the job is not just to answer, but to make a real Telegram delivery happen:

- resolve a recipient
- send a message
- send a file
- schedule future delivery

Use neighboring skills first when the main task is actually about:

- finding or persisting user data → `memory`
- event state → `cli-events`

## First action

- Resolve the recipient first when the target is ambiguous.
- Use `telegram:send-message` for immediate delivery when the target is known.
- Use `telegram:send-file` only when a real repository file path exists.
- Use `telegram:schedule-message` for future delivery.

## Gotchas

- Do not fabricate recipient resolution.
- Default publication to the current conversation unless the user explicitly asked for a different recipient.
- Do not use `telegram:send-message` merely to duplicate the same final reply text to the same current chat or user.
- Same-chat current-turn file return may still need this skill when the user expects an actual Telegram file send.
- In groups or supergroups, do not silently switch same-turn file return or extra delivery to the requester's private chat unless the user explicitly asked for private delivery.
- If the user asks for a file that may already be stored locally, inspect the relevant memory entry point and linked paths before saying it is unavailable.
- Do not stop at mentioning a local file path in text when the user clearly expects the file to be sent in Telegram.
- Keep later user-visible text temporally consistent with what already happened.
- If the work is slow or complex, brief truthful progress is acceptable, but avoid duplicate chatter.
- Do not claim success unless the CLI call succeeded.

## Runtime notes

Available commands:

- `telegram:resolve-recipient`
- `telegram:send-message`
- `telegram:send-file`
- `telegram:schedule-message`

Examples:

```bash
bun run repo:cli -- telegram:resolve-recipient '{"displayName":"锅巴之家"}'
bun run repo:cli -- telegram:send-file '{"requesterUserId":1,"recipientKind":"user","recipientId":200,"recipientLabel":"Alice","filePath":"memory/people/alice/reports/daily.pdf","caption":"今日报告"}'
```
