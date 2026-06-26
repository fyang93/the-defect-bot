---
name: memory
description: Load when answering from repository-local notes, storing durable facts or preferences under memory/, locating user-owned files through local entry points, or explaining repository-grounded bot capabilities, rather than changing event state, access state, Telegram delivery, or durable assistant rules.
---

# Memory

## Scope

Use this skill for repository-local durable knowledge and files:

- answering from local notes
- storing long-term facts or preferences
- locating user-owned files
- organizing owner-scoped memory
- explaining repository-grounded capabilities from local material

Use neighboring skills instead when the task is mainly about:

- event or reminder state → event tools
- durable assistant behavior rules → user tools
- access or identity-link state → user tools
- actual Telegram delivery → Telegram tools

## First action

- Prefer local sources first.
- If a user is linked in `system/users.json` with a `personPath`, use that as the primary entry point for user-specific memory.
- Start with keyword search over relevant markdown notes, then read the best hits before answering or editing.

## Gotchas

- Identify the relevant owner first.
- For stored files, use markdown entry points and linked paths before guessing file locations.
- Do not say nothing is recorded until you have done a reasonable local search.
- Use web search only when local sources are insufficient.
- Store user-specific memory under the correct owner path rather than top-level `memory/`.
- If no `personPath` is linked yet, a small provisional person note is acceptable.
- Merge into an existing note when it clearly fits; otherwise create a focused new note.
- Keep notes short, single-purpose, and easy to scan.
- Prefer bullet facts over long prose.
- Frontmatter is optional; do not invent rigid schemas.
- If new information conflicts with an existing note and replacement is unclear, ask.
- Do not turn every appointment or date into memory.
- Do not claim something was saved, moved, merged, linked, or persisted unless the repository was actually updated.
- When ownership becomes clearer later, prefer cleanup that consolidates provisional notes into the canonical owner path.

## Runtime notes

Organization defaults:

- `memory/people/` for one-person material
- `memory/shared/` for shared owner material
- `memory/common/` for repository-wide reference material
- canonical person entry at `memory/people/<slug>/README.md`

File handling:

- If a `tmp/` file should be kept, persist it under the relevant owner-scoped `memory/` directory.
- Link kept files from the relevant markdown entry point when useful.
- After persistence, remove the old `tmp/` file unless the user asked to keep it.

Sensitive data:

- Persisted data may enter AI context.
- Never store API keys, private keys, recovery codes, seed phrases, session tokens, 2FA backup codes, or CVV.
- Store passwords only if the user explicitly asks.
- For other sensitive values, warn briefly and confirm unless the user already clearly asked to store them.
