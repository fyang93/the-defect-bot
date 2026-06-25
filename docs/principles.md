# Engineering principles

This project defaults to **Pi SDK + Pi tools + deterministic repository state**.

## State and execution

- Keep canonical state in repository files under `system/`, `memory/`, and related domain stores.
- Mutate canonical state through deterministic code paths: operations, schemas, and Pi tools.
- Do not encode durable persistence protocols only in prompts.
- Do not write under `system/` except through approved deterministic interfaces.

## Agent lanes

- Main assistant sessions may load `agent/.pi/AGENTS.md`, tools, and skills.
- Composer/writer tasks should be small, no-tools, and no-context by default.
- Maintainer tasks should remain narrow and should not accidentally gain user-facing delivery or repository mutation capability.
- If a task only writes user-visible text, do not load full assistant context.

## Telegram runtime

- Runtime code owns current-turn reply publication, waiting UI, reactions, and duplicate-publication safeguards.
- Telegram is a platform adapter, not the source of canonical state.
- Transient Telegram network failures should not block assistant execution when the failed action is cosmetic.

## Access boundaries

- `allowed`, `trusted`, and `admin` are security-relevant boundaries.
- Allowed users may only act within their own or linked conversation context.
- Admin-only actions include durable role changes and temporary authorization grants.

## Prompt and tool design

- Keep long-lived assistant behavior in `agent/.pi/AGENTS.md`.
- Keep short task prompts in composer/maintainer-specific templates or code paths.
- Prefer Pi tools with schemas over large skill instructions for routine deterministic actions.
- Skills should be reserved for memory and narrow helper workflows that benefit from progressive disclosure.
