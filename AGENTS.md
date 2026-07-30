# The Defect Bot engineering agent guide

This repository is a local-first Feishu bot backed by the Pi SDK. Keep deterministic state changes in code/tools, keep prompts small, and never commit credentials or runtime state.

## Quick start

- Install: `just install`
- Typecheck: `npm run check`
- Tests: `npm test`
- Live tests: `npm run test:live`
- Run: `just serve`
- Pi workspace: `just agent`

## Architecture

- Runtime: `src/bot/**`
- Feishu adapters: `src/bot/feishu/**`
- Deterministic operations/tools: `src/bot/operations/**`
- Pi gateway: `src/bot/ai/gateway.ts`
- Agent workspace: `agent/**`
- Architecture notes: `docs/agent-architecture.md`

## Rules

- All Feishu users have equal capabilities.
- Keep Feishu transport concerns separate from repository state changes.
- Mutate canonical `system/` and `memory/` state through operations or Pi tools.
- Keep current-turn reply publication in runtime code; tools must not duplicate it.
- Feishu user `open_id` and `chat_id` values are strings.
- Do not commit `.env`, `agent/.pi/auth.json`, `agent/.pi/models.json`, sessions, or package caches.

## Testing

Run `npm run check` and focused tests for code changes. Run the full `npm test` for broad architecture changes.
