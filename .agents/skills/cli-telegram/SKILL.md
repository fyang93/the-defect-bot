---
name: cli-telegram
description: Resolves Telegram recipients and performs deterministic Telegram message, file, or delayed delivery through the repository CLI. Use when the task requires an actual Telegram send, recipient resolution, or scheduled Telegram delivery beyond the runtime's normal final reply.
---

# CLI Telegram

## Quick start

```bash
bun run repo:cli -- telegram:resolve-recipient '{"displayName":"锅巴之家"}'
bun run repo:cli -- telegram:send-message '{"requesterUserId":1,"recipientId":200,"recipientLabel":"Alice","content":"请查看今天的安排"}'
```

## Workflows

### Resolve and deliver

- Resolve the recipient first when the target is ambiguous.
- Use `telegram:send-message` for immediate delivery when the target is known.
- Use `telegram:send-file` only when a real repository file path exists.
- Use `telegram:schedule-message` for future delivery.
- Do not fabricate recipient resolution.

### Same-turn behavior

- Default publication to the current conversation unless the user explicitly asked for a different recipient.
- Do not use `telegram:send-message` merely to duplicate the same final reply text to the same current chat or user.
- Same-chat current-turn file return may still need this skill when the user expects an actual Telegram file send.
- In groups or supergroups, do not silently switch same-turn file return or extra delivery to the requester's private chat unless the user explicitly asked for private delivery.
- Keep later user-visible text temporally consistent with what already happened.

### Slow workflows

- If the work is slow or complex, a brief early acknowledgment or occasional short progress update in the current conversation is acceptable when it is truthful and genuinely useful.
- For slow same-turn file delivery, prefer: brief acknowledgment first if needed, then the actual send, then a concise post-delivery confirmation.
- Avoid duplicate chatter and do not fight the runtime's waiting or progress behavior.

### Boundaries

- If the user asks for a file that may already be stored locally, inspect the relevant memory entry point and linked paths before saying it is unavailable.
- Do not stop at mentioning a local file path in text when the user clearly expects the file to be sent in Telegram.
- Do not claim success unless the CLI call succeeded.

## Commands

- `telegram:resolve-recipient`
- `telegram:send-message`
- `telegram:send-file`
- `telegram:schedule-message`

## Examples

```bash
bun run repo:cli -- telegram:send-file '{"requesterUserId":1,"recipientKind":"chat","recipientId":-1003674455331,"recipientLabel":"锅巴之家","filePath":"tmp/telegram/2026-04-20/YANG_FAN_研究業務日誌（2026.4）.xlsx","caption":"已填好的研究业务日志"}'
bun run repo:cli -- telegram:send-file '{"requesterUserId":1,"recipientKind":"user","recipientId":200,"recipientLabel":"Alice","filePath":"memory/people/alice/reports/daily.pdf","caption":"今日报告"}'
bun run repo:cli -- telegram:schedule-message '{"requesterUserId":1,"recipientKind":"chat","recipientId":-1001234567890,"recipientLabel":"项目群","content":"明早记得开会","sendAt":"2026-04-11T00:00:00.000Z"}'
```
