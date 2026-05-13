---
name: memory
description: Manages repository-local memory, durable notes, and persistent user information stored under memory/. Use when answering from local notes, storing long-term facts or preferences, locating user-owned files, or explaining repository-grounded bot capabilities.
---

# Memory

## Quick start

- Prefer local sources first.
- If a user is linked in `system/users.json` with a `personPath`, use that as the primary entry point for user-specific memory.
- Start with keyword search over relevant markdown notes, then read the best hits before answering.

## Workflows

### Retrieve memory

- Identify the relevant owner first.
- For stored files, use markdown entry points and linked paths before guessing file locations.
- Do not say nothing is recorded until you have done a reasonable local search.
- Use web search only when local sources are insufficient.

### Write memory

- Store long-term markdown notes under `memory/`.
- Store user-specific memory under the correct owner path rather than top-level `memory/`.
- If the requester or target user has a linked `personPath`, treat that as the default owner unless the request clearly refers to someone else.
- If no `personPath` is linked yet, a small provisional person note is acceptable.
- Merge into an existing note when it clearly fits; otherwise create a focused new note.
- Keep notes short, single-purpose, and easy to scan.
- Prefer bullet facts over long prose.
- Frontmatter is optional; do not invent rigid schemas.
- If new information conflicts with an existing note and replacement is unclear, ask.

### Organize memory

- Prefer one stable taxonomy over ad-hoc top-level files.
- Organize memory by scope first, then by topic.
- Use `memory/people/` for one-person material, `memory/shared/` for shared owner material, and `memory/common/` for repository-wide reference material.
- Prefer directory-style person storage with a canonical entry at `memory/people/<slug>/README.md` and supporting notes nearby.
- Keep top-level `memory/` for rare navigation indexes only.
- When reorganizing existing notes, update links and remove obsolete duplicates.

### Handle files

- Prefer the simplest owner-local file layout that keeps related material together.
- If a `tmp/` file should be kept, persist it directly under the relevant owner-scoped `memory/` directory.
- Link kept files from the relevant markdown entry point when useful.
- After persistence, remove the old `tmp/` file unless the user asked to keep it.

### Boundaries and validation

- Use `cli-rules` for deterministic standing assistant rules.
- Use `cli-events` when the main task is event state.
- Do not turn every appointment or date into memory.
- Do not claim something was saved, moved, merged, linked, or persisted unless the repository was actually updated.
- When ownership becomes clearer later, prefer cleanup that consolidates provisional notes into the canonical owner path.

## Sensitive data

- Persisted data may enter AI context.
- Never store API keys, private keys, recovery codes, seed phrases, session tokens, 2FA backup codes, or CVV.
- Store passwords only if the user explicitly asks.
- For other sensitive values, warn briefly and confirm unless the user already clearly asked to store them.
